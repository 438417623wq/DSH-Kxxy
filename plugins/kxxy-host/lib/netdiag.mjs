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
      b.result = { ...summary, at: Date.now(), targets: results }
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
