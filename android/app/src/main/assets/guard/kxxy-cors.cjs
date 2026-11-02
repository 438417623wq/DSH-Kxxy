'use strict'
/**
 * kxxy-cors.cjs —— 让本机页面能跨端口访问插件自己起的 HTTP 服务。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 桌面端 DSH 跑在 Electron 里，渲染进程对跨源请求基本不设防：宿主页面
 * `http://127.0.0.1:3080` 直接 `fetch('http://127.0.0.1:18787/...')` 是通的。
 * Android WebView 强制执行同源策略，而且**没有任何开关能关掉**（不像
 * Electron 有 `webSecurity: false`）。于是同一段插件代码移植过来必然抛
 * `TypeError: Failed to fetch` —— 浏览器把「没有 ACAO 头」的响应丢掉了，
 * 报错文本还完全看不出是跨源。
 *
 * 典型现场（billion-context 0.1.211）：插件服务端在 18787 起了上下文压缩
 * 代理，前端 `probeEmbedRoute()` 用 `fetch('/__bili/?embed=1')` 探测面板能不能
 * 内嵌。这个探测在手机上 100% 失败 → 面板显示「连接 bili 代理失败」，
 * 而代理本身活得好好的（同一台机器同一个端口，用系统浏览器直接打开就正常）。
 *
 * ── 为什么补在引擎侧而不是 WebView ──────────────────────────────
 * 两条路都比这条路差：
 *   · WebView 没有「关闭同源策略」的 API。`shouldInterceptRequest` 转发确实
 *     能绕过，但它要进 Java 层做一次完整 HTTP 往返、还要自己实现流式透传
 *     —— 插件面板大量用 SSE 与长连接，这条路上全是坑；
 *   · 给插件打补丁（改它的前端 bundle）只能救这一个插件，下一个照旧。
 * 反过来：插件的 HTTP 服务**全都跑在这个 Node 进程树里**，在响应上加一个
 * 头就解决了，而且对「以后任何插件起的本地服务」一并生效。
 *
 * ── 覆盖面与边界 ────────────────────────────────────────────────
 *   · 通过 `NODE_OPTIONS=--require` 注入，**主进程与所有子进程都会装**。
 *     必须这样：插件的代理 lane 是 spawn 出来的独立进程，只在主进程装没用。
 *   · 只对「带 Origin 且 Origin 是本机回环」的请求生效。同源请求根本不带
 *     Origin，一动不动；外部网页的 Origin 不回显，本机那些端口（存着 API
 *     Key 与完整对话）不会被任意网站读走。
 *   · 预检（OPTIONS + Access-Control-Request-Method）直接 204 应答且**不再
 *     往下传**：业务 handler 这时还什么都没做，让它继续跑只会对着已发送的
 *     响应再写一次，日志里多一条 ERR_HTTP_HEADERS_SENT。
 *   · 响应头是先 `setHeader` 再走原流程的，所以流式响应（SSE、下载）不受
 *     影响 —— 我们一个字节都不碰 body。
 *
 * ── 防御性约定 ──────────────────────────────────────────────────
 * 这段代码会被装进**每一个** node 子进程（包括插件的 npm install、构建脚本）。
 * 它一旦抛异常，整个引擎连起都起不来 —— 比不做这个补丁严重得多。因此：
 * 全部逻辑包在 try/catch 里，任何一步失败都静默放过；重复安装是无害的空操作。
 */

;(function installKxxyCors() {
  try {
    // 显式开关：排查「是不是它干的」时不用改代码，设 KXXY_CORS=0 即可
    const flag = String(process.env.KXXY_CORS || '').trim().toLowerCase()
    if (flag === '0' || flag === 'false' || flag === 'off') return

    const http = require('http')
    const Server = http && http.Server
    if (typeof Server !== 'function' || typeof Server.prototype.emit !== 'function') return

    // 已经装过（同一进程内二次 require / 多份 NODE_OPTIONS）就别再包一层
    if (Server.prototype.__kxxyCorsInstalled === true) return
    Object.defineProperty(Server.prototype, '__kxxyCorsInstalled', { value: true, enumerable: false })

    /**
     * 只认「本机页面」的 Origin。
     *
     * 回显 Origin（而不是发 `*`）是必须的：插件面板会带 credentials，
     * `*` 配 `Access-Control-Allow-Credentials: true` 会被浏览器直接拒绝。
     * 而只回显回环 Origin，又顺手挡住了「外部网页读本机服务」这条路。
     */
    const LOOPBACK_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i
    const ALLOW_METHODS = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS'
    const FALLBACK_HEADERS = 'content-type,authorization,x-requested-with,x-api-key'

    function localOriginOf(req) {
      const headers = req && req.headers
      if (!headers) return null
      const raw = headers.origin
      if (typeof raw !== 'string') return null
      const value = raw.trim()
      if (value.length === 0) return null
      return LOOPBACK_ORIGIN.test(value) ? value : null
    }

    function appendVary(res) {
      try {
        const prev = res.getHeader('vary')
        if (prev === undefined) {
          res.setHeader('Vary', 'Origin')
          return
        }
        if (!String(prev).toLowerCase().split(',').some((part) => part.trim() === 'origin')) {
          res.setHeader('Vary', `${prev}, Origin`)
        }
      } catch {
        /* Vary 只是缓存语义，失败不影响请求 */
      }
    }

    function applyCors(res, origin) {
      try {
        if (res.headersSent === true) return
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Credentials', 'true')
        appendVary(res)
      } catch {
        /* 头已经发出去或对象被冻结：放弃，别影响业务响应 */
      }
    }

    function answerPreflight(res, origin, req) {
      const asked = req.headers ? req.headers['access-control-request-headers'] : undefined
      const headers = {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': ALLOW_METHODS,
        'access-control-allow-headers':
          typeof asked === 'string' && asked.trim().length > 0 ? asked : FALLBACK_HEADERS,
        'access-control-max-age': '600',
        vary: 'Origin',
      }
      try {
        res.writeHead(204, headers)
      } catch {
        /* statusCode 已被写过：退化成普通结束 */
      }
      try {
        res.end()
      } catch {
        /* 忽略 */
      }
    }

    const originalEmit = Server.prototype.emit

    Server.prototype.emit = function kxxyCorsEmit(event, req, res) {
      // 只关心请求事件；其余（connection / close / upgrade…）原样透传
      if (event !== 'request' || req === null || typeof req !== 'object' || res === null || typeof res !== 'object') {
        return originalEmit.apply(this, arguments)
      }
      try {
        const origin = localOriginOf(req)
        if (origin !== null) {
          const preflight =
            req.method === 'OPTIONS' &&
            typeof req.headers['access-control-request-method'] === 'string'
          if (preflight) {
            answerPreflight(res, origin, req)
            // 返回 true 且不调原始 emit：预检到此为止，业务 handler 不该跑
            return true
          }
          applyCors(res, origin)
        }
      } catch {
        /* 装饰失败就当没装，请求照常走 */
      }
      return originalEmit.apply(this, arguments)
    }

    if (process.env.KXXY_CORS_DEBUG === '1') {
      try {
        process.stderr.write(`[kxxy-cors] installed (pid ${process.pid})\n`)
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 这里绝不能抛：注入失败只是少一层兼容，不能让引擎起不来 */
  }
})()
