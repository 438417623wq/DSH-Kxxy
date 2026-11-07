/**
 * 网络诊断：分辨「DNS 层被黑洞」与「真的没网」（缺陷 EH）。
 *
 * ── 为什么要专门做这一件事 ────────────────────────────────────────────────
 *
 * 审计发现 `raw.githubusercontent.com` 在本机解析成 `0.0.0.0`，而同一时间
 * `github.com` / `codeload.github.com` / `api.github.com` 都正常解析到
 * `20.205.243.x`。这不是 hosts 屏蔽（`/system/etc/hosts`、`<root>/etc/hosts`
 * 里都只有 localhost 两条），是 **DNS 解析层对单个域名返回了空地址**。
 *
 * 这种失败对用户极不友好：`curl` 拿到 `http=000`、`git clone` 报
 * `Could not resolve host`、脚本报 `ECONNREFUSED`，三种说法都指向"网络断了"，
 * 于是人会去重连 Wi-Fi、关开飞行模式 —— 全都无效，因为别的域名明明是通的。
 *
 * 判据很干净：**解析到一个"空地址"（0.0.0.0 / ::）就是被黑洞**。
 * 真的没网时解析会抛 `ENOTFOUND` / `EAI_AGAIN`，那是另一回事，不能混为一谈。
 * 把这两种情况分开报，是这个小模块的全部价值。
 *
 * ── 后来补的一条：不只是 DNS ──────────────────────────────────────────────
 *
 * 真机复核发现，用 DoH 拿到真实 IP（`185.199.109.133`）后 `curl --resolve`
 * 直连，连续四次全是 `Connection reset`。也就是说「换 DNS」这条路本来就走不通
 * （何况工具走 netd，根本不读 resolv.conf），而且**代理型镜像也常被同一层拦**。
 *
 * 真正稳的绕法是换接口：`api.github.com` 通着，用 Contents API + `Accept:
 * application/vnd.github.raw` 取同一份文件（实现见 lib/ghraw.mjs）。所以这里
 * 在确认黑洞之后，除了实测镜像，还会实测一次 API 路线，把**当前网络下最靠谱
 * 的那一条**写进结论，而不是笼统让人去"换个镜像试试"。
 *
 * ── 为什么不"顺手修掉" ────────────────────────────────────────────────────
 *
 * 唯一能改的是 `<root>/etc/resolv.conf`（由 RuntimeInstaller.ensureResolvConf
 * 每次启动按系统 DNS 重写）。把它换成公共 DNS 看似能绕过，实际有两个问题：
 *   ① 绝大多数工具（curl / git / 任何走 bionic `getaddrinfo` 的程序）根本不读
 *      这个文件，它们走 Android 的 netd —— 换了也没用，只会造成"我改了啊怎么
 *      还不行"的错觉；
 *   ② 少数确实读它的（Go 的纯 Go resolver、c-ares 系）会因此绕过用户所在网络的
 *      DNS 策略，在公共 DNS 本身也被拦的网络里反而更糟。
 * 所以这里只**报**，不改。要绕过就换镜像（见 lib/mirror.mjs 的说明），
 * 那是真正可控的一层。
 *
 * @module kxxy-host/netdiag
 */

import { promises as dns } from 'node:dns'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { probeApiRoute } from './ghraw.mjs'

/**
 * 被探测的主机。
 *
 * `control: true` 的是对照组：单域名被拦时它应该是通的。有对照才敢下
 * 「选择性拦截」这个结论 —— 只有目标不通时，无法区分是全局 DNS 挂了还是
 * 只拦了这一个。
 */
export const TARGETS = [
  { id: 'raw', host: 'raw.githubusercontent.com', label: 'GitHub 直链' },
  { id: 'github', host: 'github.com', label: 'GitHub 主站', control: true },
]

/** 缓存有效期：DNS 记录变化不快，但换网络（切 Wi-Fi/流量）会变，5 分钟够。 */
const TTL_MS = 5 * 60 * 1000

/** 镜像可用性的缓存：比 DNS 结论长得多，见 startProbe 里的说明。 */
const MIRROR_TTL_MS = 30 * 60 * 1000

/** 单次解析的超时。DNS 挂了的时候 getaddrinfo 能拖到十几秒。 */
const LOOKUP_TIMEOUT_MS = 4_000

/** 「空地址」的形状：这些地址拿到手就等于拿到了"查无此机"。 */
function isNullAddress(addr) {
  const a = String(addr || '').trim().toLowerCase()
  if (!a) return true
  if (a === '0.0.0.0' || a === '::' || a === '::1' || a === '127.0.0.1') return true
  if (a.startsWith('0.')) return true
  if (a.startsWith('127.')) return true
  return false
}

/** 带超时的 DNS 查询（dns.lookup 本身没有 timeout 选项）。 */
function lookup(host) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done({ ok: false, code: 'ETIMEDOUT' }), LOOKUP_TIMEOUT_MS)
    dns.lookup(host, { all: true }).then(
      (list) => done({ ok: true, addresses: (list || []).map((x) => x.address) }),
      (e) => done({ ok: false, code: e?.code || 'EUNKNOWN' }),
    )
  })
}

/**
 * 探测单个主机。
 *
 * @returns {Promise<{id: string, host: string, label: string, status: string, addresses: string[]}>}
 *   status: `ok` | `blocked`（解析到空地址）| `nxdomain`（域名不存在）| `unreachable`（超时/网络错）
 */
async function probeTarget(target) {
  const r = await lookup(target.host)
  if (r.ok) {
    const addresses = r.addresses
    // 只要有一个是真地址，就说明这个域名是能被解析的（多 A 记录里混一个
    // 0.0.0.0 的情况极少，真出现也够用了 —— 真地址能连上就不叫被拦）
    const real = addresses.filter((a) => !isNullAddress(a))
    return {
      id: target.id,
      host: target.host,
      label: target.label,
      status: real.length ? 'ok' : 'blocked',
      addresses,
    }
  }
  const status = r.code === 'ENOTFOUND' || r.code === 'EAI_NODATA' ? 'nxdomain' : 'unreachable'
  return { id: target.id, host: target.host, label: target.label, status, addresses: [] }
}

/** 读 `<root>/etc/resolv.conf` 里的 nameserver，纯展示用（解释"谁在拦"）。 */
function resolvServers(root) {
  if (!root) return []
  const file = join(root, 'etc/resolv.conf')
  try {
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^nameserver\s+/i.test(l))
      .map((l) => l.replace(/^nameserver\s+/i, '').trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 汇总结论。
 *
 * `selective` 才是审计里那种情况：目标被黑洞、对照组正常 —— 这是"有针对性的
 * DNS 拦截"，用户完全无能为力，只能绕。其余情况按"整体网络问题"处理，让用户
 * 去查网络，而不是去查我们这个 App。
 */
function summarize(results, servers) {
  const raw = results.find((r) => r.id === 'raw')
  // 对照组：同域另一台主机。它通了而目标不通，才是"被针对性拦截"。
  const control = results.find((r) => r.id === 'github')
  const controlOk = Boolean(control && control.status === 'ok')

  if (!raw) return { level: 'unknown', headline: '没有探测结果' }
  if (raw.status === 'ok') {
    return { level: 'ok', headline: 'GitHub 直链可解析' }
  }
  if (raw.status === 'blocked') {
    return {
      level: controlOk ? 'selective' : 'blackhole',
      headline: controlOk
        ? 'raw.githubusercontent.com 被 DNS 黑洞（同域其他主机正常）'
        : '解析到空地址，且同域主机也不通',
      servers,
    }
  }
  if (raw.status === 'nxdomain') {
    return { level: 'offline', headline: 'raw.githubusercontent.com 解析不到（当前可能没网）' }
  }
  return { level: 'offline', headline: 'DNS 超时或不可达（当前网络可能有问题）' }
}

/**
 * 缓存放在 globalThis：插件热重载会重新求值本模块，缓存在模块变量里会丢，
 * 于是每次热重载都重探一轮 DNS（对端是系统解析器，没必要）。
 */
const BOX = Symbol.for('kxxy.host.netdiag')

function box() {
  let b = globalThis[BOX]
  if (!b || typeof b !== 'object') {
    b = { at: 0, result: null, inflight: null }
    globalThis[BOX] = b
  }
  return b
}

/**
 * 触发一次探测（有缓存就不重复）。
 *
 * 刻意**不**返回 Promise 给调用方 await：健康检查是同步的，页面每 3 秒轮询一次，
 * 不能因为 DNS 慢就把整个 /state 拖住。这里后台跑，跑完写缓存，下一次轮询自然
 * 拿到结果。代价是"首次打开的一瞬间显示未知"，可接受。
 *
 * @param {string} root 引擎根（读 resolv.conf 用，可为空）
 * @returns {Promise<object>|null} 已经在跑或缓存有效时返回 null
 */
export function startProbe(root) {
  const b = box()
  if (b.inflight) return null
  if (b.result && Date.now() - b.at < TTL_MS) return null

  b.inflight = (async () => {
    try {
      const results = await Promise.all(TARGETS.map(probeTarget))
      const summary = summarize(results, resolvServers(root))
      const next = { ...summary, at: Date.now(), targets: results }
      /*
       * 只有在**确认被黑洞**时才去实测绕行路线。
       *
       * 理由：正常网络里没必要把用户请求引向第三方代理；而一旦确认 raw 被拦，
       * "哪条路还能走"就变成唯一有信息量的问题 —— 用户按提示手填一个恰好也
       * 不通的镜像，等于白折腾一轮。
       *
       * 两条并测：
       *   · `api`：`api.github.com` 的 Contents API（换接口，不换域名）——
       *     实测最稳，因为同域其他主机没被拦；
       *   · `mirrors`：第三方代理（换域名）—— 经常被同一层连带拦掉，所以
       *     只作为第二选择报出来。
       *
       * 结果单独一份缓存（30 分钟）：DNS 结论 5 分钟就过期，但"哪条路能用"
       * 变化慢得多，每 5 分钟重打四个外部站点纯属浪费。
       */
      if (summary.level === 'selective' || summary.level === 'blackhole') {
        const prev = b.result?.mirrors
        const prevAt = Number(b.result?.mirrorsAt ?? 0)
        if (Array.isArray(prev) && Date.now() - prevAt < MIRROR_TTL_MS) {
          next.mirrors = prev
          next.mirrorsAt = prevAt
          next.api = b.result?.api ?? null
        } else {
          try {
            // 一次探测三个请求，并行发：API 那条最重要，别让它排在镜像后面。
            const [api, mirrors] = await Promise.all([
              probeApiRoute().catch(() => null),
              probeMirrors().catch(() => []),
            ])
            next.api = api
            next.mirrors = mirrors
            next.mirrorsAt = Date.now()
          } catch {
            // 探测失败不影响 DNS 结论
          }
        }
      }
      b.result = next
      b.at = Date.now()
    } catch (e) {
      b.result = { level: 'unknown', headline: `探测失败：${e?.message ?? e}`, at: Date.now(), targets: [] }
      b.at = Date.now()
    } finally {
      b.inflight = null
    }
  })()
  return b.inflight
}

/**
 * 同步拿当前结论。
 *
 * 从不抛错：健康检查里任何一条都不该把整份体检带崩。
 *
 * @returns {{level: string, headline: string, at?: number, targets?: object[]}}
 */
export function netSnapshot() {
  const b = box()
  if (!b.result) return { level: 'probing', headline: '正在探测网络…' }
  return b.result
}

/** 强制重探（「重新检测」按钮用）。 */
export function refresh(root) {
  const b = box()
  b.at = 0
  return startProbe(root)
}

/**
 * GitHub 直链的镜像候选（**只用于实测，不预置成默认值**）。
 *
 * 为什么不在代码里挑一个写死：这类代理服务存亡无常，写死一个等于埋一颗
 * "几个月后突然不工作"的雷（`RuntimeInstaller.ensureNetConfig` 的注释里
 * 也是同一个理由）。所以这里只在**已经确认 raw 被黑洞**时才去实测这几个
 * 候选，挑当前网络真的能用的那个，然后由用户自己决定要不要写进配置。
 *
 * `base` 是「把完整 raw URL 接在后面」的形式；`prefix` 是「接在原 URL 前面」
 * 的形式，两者只是拼接位置不同，落进 `etc/net.json` 的都是 `base`。
 */
export const MIRRORS = [
  { id: 'ghproxy', base: 'https://ghproxy.net/https://raw.githubusercontent.com/' },
  { id: 'gh-proxy', base: 'https://gh-proxy.com/https://raw.githubusercontent.com/' },
  { id: 'ghfast', base: 'https://ghfast.top/https://raw.githubusercontent.com/' },
  { id: 'gitmirror', base: 'https://raw.gitmirror.com/' },
]

/**
 * 实测用的小文件：git 仓库里的一行文本，内容固定、体积小、不需要鉴权。
 * 用 `git/git` 而不是我们自己的仓库 —— 前者在哪儿都通，不牵扯本项目。
 */
const MIRROR_PROBE_PATH = 'git/git/master/README.md'

/**
 * 逐个实测镜像候选，返回每个的可用性。
 *
 * 任何一条失败都不抛：这个函数的存在意义就是"在坏网络里挑出还能用的那个"，
 * 它自己不能被坏网络带崩。
 *
 * @param {number} [timeoutMs] 单条超时
 * @returns {Promise<Array<{id: string, base: string, ok: boolean, ms: number, status?: number, error?: string}>>}
 */
export async function probeMirrors(timeoutMs = 3000) {
  const url = `https://raw.githubusercontent.com/${MIRROR_PROBE_PATH}`
  const out = []
  for (const m of MIRRORS) {
    const started = Date.now()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(m.base + url, {
        method: 'GET',
        signal: ctl.signal,
        // 只要头部：能拿到 2xx 就说明这条链路是通的，正文没必要下
        headers: { range: 'bytes=0-64', 'user-agent': 'kxxy-netdiag' },
      })
      out.push({
        id: m.id,
        base: m.base,
        ok: res.ok || res.status === 206,
        status: res.status,
        ms: Date.now() - started,
      })
    } catch (e) {
      out.push({
        id: m.id,
        base: m.base,
        ok: false,
        ms: Date.now() - started,
        error: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e),
      })
    } finally {
      clearTimeout(timer)
    }
  }
  return out
}

/**
 * 实测并挑出第一个可用的镜像。
 *
 * @returns {Promise<{ok: boolean, chosen: object | null, tried: Array<object>}>}
 */
export async function pickMirror(timeoutMs = 3000) {
  const tried = await probeMirrors(timeoutMs)
  return { ok: tried.some((t) => t.ok), chosen: tried.find((t) => t.ok) ?? null, tried }
}
