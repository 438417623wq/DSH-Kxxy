/**
 * 请求信任判定与写操作防护（缺陷 DZ / EA）。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────────
 *
 * v0.9.17 及之前，这里写的是：
 *
 *     const auth = ctx.get('authorization')
 *     if (auth && typeof auth.isTrustedRequest === 'function') …
 *     return host.startsWith('127.0.0.1:') || host.startsWith('localhost:')
 *
 * 两个错误叠在一起：
 *
 *   ① `authorization` 服务根本不是干这个的。它是「凭证获取流程」的注册表
 *      （OAuth 那套「打开页面 / 贴码 / 选账号」），`dsh-authorization` 只导出
 *      `AuthorizationService` 和两个错误类，没有 `isTrustedRequest` 这个名字。
 *      于是那个 if 永远不成立。
 *   ② 兜底判据是「Host 是不是回环」。而服务只绑 127.0.0.1，正常请求的 Host
 *      天然就是 `127.0.0.1:3080` —— 这条判据恒为真，等于门从来没关上。
 *
 * 实测复核过：`Host: evil.example` 会被拒（403），改回 `127.0.0.1:3080` 就放行，
 * 证明走的正是这条 Host 兜底。
 *
 * ── 正解 ──────────────────────────────────────────────────────────────────
 *
 * `ctx.get('connection')`（`@deepseek-ai/dsh-client-connection`）才是请求级判定：
 *
 *     isAuthenticated(request, secure)  // 校验 authority 绑定的签名 cookie
 *     authenticateApi(request, secure)  // 只认 API 凭证
 *
 * cookie 里的 `authority` 就是 Host，所以「127.0.0.1:3080 的 cookie 拿到
 * 192.168.1.23:8765 用」天然无效 —— 这正是我们一直想要的那层绑定。
 *
 * 远程链路不受影响：`dsh-remote-link` 的连接器把请求转发到上游时会把 Host 改写回
 * `127.0.0.1:3080`，并注入它用 launch token 换来的上游会话 cookie。也就是说，
 * 到本插件眼里远程请求与本机浏览器请求同形同权。
 *
 * ── 失败方向 ──────────────────────────────────────────────────────────────
 *
 * 三态而不是布尔：`allow` / `deny` / `unavailable`。
 *
 * 判不了（服务改名、内部抛错）时**不能默认放行** —— 那正是这次事故的形状。
 * 但也不能把页面整死：静态页给「能看懂的一句话」，接口一律关。
 *
 * @module kxxy-host/auth
 */

import { timingSafeEqual } from 'node:crypto'

/** 判定结果：可信。 */
export const AUTH_ALLOW = 'allow'
/** 判定结果：请求没有有效会话 cookie。 */
export const AUTH_DENY = 'deny'
/** 判定结果：拿不到 connection 服务或它抛错 —— 判不了就不放行。 */
export const AUTH_UNAVAILABLE = 'unavailable'

/**
 * 判定请求是否来自已认证的浏览器。
 *
 * @param {{get: (name: string) => unknown}} ctx 插件上下文
 * @param {import('node:http').IncomingMessage} req
 * @returns {'allow' | 'deny' | 'unavailable'}
 */
export function authVerdict(ctx, req) {
  let conn = null
  try {
    conn = typeof ctx?.get === 'function' ? ctx.get('connection') : null
  } catch {
    // 服务未注册/注册失败：落到 unavailable，由调用方关掉接口
    conn = null
  }
  if (!conn || typeof conn.isAuthenticated !== 'function') return AUTH_UNAVAILABLE

  // `secure` 决定默认端口与 cookie 的 authority 口径。回环 listener 是明文，
  // 真正上 TLS 时 socket 上会有 encrypted 标记 —— 以实际连接为准，不猜配置。
  let secure = false
  try {
    secure = Boolean(req?.socket?.encrypted)
  } catch {
    secure = false
  }

  try {
    return conn.isAuthenticated(req, secure) ? AUTH_ALLOW : AUTH_DENY
  } catch {
    // 判定器自己抛错时也按「判不了」处理，绝不当成通过
    return AUTH_UNAVAILABLE
  }
}

/**
 * 页面 nonce：写在管理页 HTML 里、由前端随每个写请求带回来的一次性口令。
 *
 * ── 为什么在三道 CSRF 语义之外还要它 ──────────────────────────────────────
 *
 * `sec-fetch-site` 与 `origin` 都是**浏览器自愿提供**的头：
 *   · 老 WebView 不发 `sec-fetch-site`（我们刻意不把「缺失」当跨站，否则老设备
 *     全废），于是那一条在它们身上等于不存在；
 *   · `origin` 在少数导航型提交里也为空。
 * 两者叠加就会出现「既没 sec-fetch-site、也没 origin」的空白地带。
 *
 * nonce 补的是这个洞：它能被同源页面读到（ attackers 读不到跨源响应），
 * 而写请求必须带上它。跨站页面拿不到、猜不中（32 字节随机、进程内有效）。
 *
 * ── 为什么要留一串而不是一个 ──────────────────────────────────────────────
 *
 * 插件热重载会重新求值本模块。如果只认「当前这一个」，重载瞬间已经打开的页面
 * （HTML 里是旧 nonce）所有写操作立刻 403 —— 用户看到的是「点按钮没反应」。
 * 所以保留最近若干个：新页面用新的，老页面在下次刷新前还能用。
 */
const NONCE_SEEN_MAX = 6

/**
 * nonce 存放处。
 *
 * 挂在 `globalThis` 而不是模块变量上，理由同上：模块会被重新求值，
 * globalThis 不会。键用 Symbol.for，避免与宿主其它插件撞名。
 */
const NONCE_BOX = Symbol.for('kxxy.host.pageNonce')

function nonceBox() {
  let box = globalThis[NONCE_BOX]
  if (!box || typeof box !== 'object') {
    box = { current: '', seen: [] }
    globalThis[NONCE_BOX] = box
  }
  return box
}

/**
 * 取当前 nonce（没有就生成一个）。
 *
 * @param {() => string} mint 生成函数（由调用方注入 `crypto.randomBytes` 的封装，
 *   这样本模块不必依赖 node:crypto，也便于测试注入固定值）
 * @returns {string}
 */
export function currentNonce(mint) {
  const box = nonceBox()
  if (!box.current) {
    box.current = mint()
  }
  return box.current
}

/** 记一个新 nonce 为当前值，旧值降级为「仍可接受」。 */
export function rotateNonce(mint) {
  const box = nonceBox()
  if (box.current) {
    box.seen.push(box.current)
    if (box.seen.length > NONCE_SEEN_MAX) box.seen.splice(0, box.seen.length - NONCE_SEEN_MAX)
  }
  box.current = mint()
  return box.current
}

/** 当前 nonce 与最近若干个旧值（服务端下发页面时用 current，校验时用全部）。 */
export function acceptedNonces() {
  const box = nonceBox()
  return box.current ? [box.current, ...box.seen] : [...box.seen]
}

/**
 * 校验写请求带来的 nonce。
 *
 * 用定长比较：`===` 会在第一个不同字节处返回，理论上可被计时侧信道逐字节猜。
 * 这里只是纵深防御（攻击者还得先能发请求），但代价是零。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string[]} accepted 可接受的 nonce 列表
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function checkNonce(req, accepted) {
  const list = Array.isArray(accepted) ? accepted.filter((x) => typeof x === 'string' && x) : []
  if (list.length === 0) {
    // 服务端自己没准备好（理论不可达：页面能出来就说明生成过）。按「判不了」处理。
    return { ok: false, status: 503, error: 'nonce unavailable' }
  }
  const got = String(req?.headers?.['x-kxxy-nonce'] ?? '')
  if (!got) {
    return {
      ok: false,
      status: 403,
      error: 'missing x-kxxy-nonce (刷新页面后再试)',
    }
  }
  const a = Buffer.from(got, 'utf8')
  for (const candidate of list) {
    const b = Buffer.from(candidate, 'utf8')
    // 长度不同直接跳过：timingSafeEqual 对不等长会抛
    if (a.length !== b.length) continue
    if (timingSafeEqual(a, b)) return { ok: true }
  }
  return { ok: false, status: 403, error: 'invalid x-kxxy-nonce (页面已过期，刷新后再试)' }
}

/**
 * 写操作（POST）的 CSRF 语义检查。
 *
 * 三道都是「加了不会误伤、不加就等于裸奔」的：
 *
 *  ① `content-type: application/json` —— 跨站表单提交带不了这个头（带了会触发
 *     预检，而预检过不了），是最省事的一道。
 *  ② `sec-fetch-site` 若存在必须是 same-origin / none。现代 WebView 与浏览器都发，
 *     老客户端不发时不阻断（缺失不等于跨站）。
 *  ③ `origin` 若存在必须与 Host 同源。远程链路经连接器转发时 Origin 与 Host 都是
 *     上游口径，一致；不一致的就是别的站点在替用户发请求。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function checkWriteRequest(req) {
  const contentType = String(req?.headers?.['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    return {
      ok: false,
      status: 415,
      error: 'content-type must be application/json',
    }
  }

  const site = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, error: `cross-site write rejected (sec-fetch-site: ${site})` }
  }

  const origin = req?.headers?.origin
  if (origin) {
    let originHost = ''
    try {
      originHost = new URL(String(origin)).host
    } catch {
      return { ok: false, status: 403, error: 'unparsable origin' }
    }
    const host = String(req?.headers?.host ?? '')
    if (originHost && host && originHost !== host) {
      return { ok: false, status: 403, error: `cross-origin write rejected (${originHost} ≠ ${host})` }
    }
  }

  return { ok: true }
}

/**
 * 未通过判定时给用户的静态页（不依赖任何前端资源，也不读任何状态）。
 *
 * 为什么还让页面出得来：光秃秃的 401 白屏只会让人以为「又坏了」。这里要一眼看出
 * 「是没带凭证」还是「判定器不见了」，两者的处理动作完全不同。
 *
 * @param {'deny' | 'unavailable'} verdict
 * @returns {string} HTML
 */
export function deniedPageHtml(verdict) {
  const unavailable = verdict === AUTH_UNAVAILABLE
  const title = unavailable ? '鉴权服务不可用' : '未授权访问'
  const badge = unavailable ? 'AUTH UNAVAILABLE' : 'UNAUTHORIZED'
  const body = unavailable
    ? [
        '找不到 <code>connection</code> 服务，或它在判定时抛错，所以管理接口已整体关闭。',
        '这通常意味着 DSH 大版本变更了鉴权接口。请把这条信息反馈给 Kxxy，',
        '在此之前控制台的管理功能不可用（这是有意的：判不了就不放行）。',
      ].join('')
    : [
        '这个页面需要 DSH 的会话 cookie。请从 DSH 窗口打印的链接打开一次，',
        '或在手机 App 里进入控制台 —— 直接输地址、或用 <code>curl</code> 裸访都会被拒。',
      ].join('')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · DSH Kxxy</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
         font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;
         background:#f6f7f9; color:#1f2430; }
  .card { max-width:520px; width:100%; background:#fff; border:1px solid #e3e6ec;
          border-radius:14px; padding:24px 22px 20px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
  .badge { display:inline-block; font:600 11px/1 ui-monospace,monospace; letter-spacing:.08em;
           padding:6px 8px; border-radius:6px; background:#fde8e8; color:#b42318; }
  h1 { font-size:18px; margin:14px 0 8px; }
  p { margin:0 0 10px; color:#475467; }
  code { font:13px/1.5 ui-monospace,monospace; background:#f2f4f7; padding:1px 5px; border-radius:4px; }
  .foot { margin-top:16px; padding-top:14px; border-top:1px solid #eef0f4;
          color:#98a2b3; font-size:12px; }
  @media (prefers-color-scheme: dark) {
    body { background:#0f1115; color:#e6e8ee; }
    .card { background:#161a21; border-color:#252b35; }
    p { color:#98a2b3; }
    code { background:#222833; }
    .badge { background:rgba(180,35,24,.18); color:#f97066; }
    .foot { border-color:#222833; }
  }
</style></head>
<body data-verdict="${verdict}">
  <div class="card">
    <span class="badge">${badge}</span>
    <h1>${title}</h1>
    <p>${body}</p>
    <div class="foot">kxxy-host · 会话校验走 DSH 的 connection 服务</div>
  </div>
</body></html>`
}
