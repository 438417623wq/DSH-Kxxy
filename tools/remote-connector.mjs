#!/usr/bin/env node
/**
 * Kxxy 远程连接器 —— 让「手机控电脑」真的连得上。
 *
 * ## 它解决的问题
 *
 * DSH 桌面端（或 `dsh web`）只监听 `127.0.0.1`，而且它的 Host 校验默认只认
 * 回环地址与显式 `trustedHosts` 条目 —— 所以我们既不能把手机直接指过去，
 * 也不该去改它（官方 Electron 包的 asar 我们改不了，改了也会被下次更新覆盖）。
 *
 * 这个连接器是**电脑侧的一个小反代**，做四件事：
 *
 *   1. **转发**：把请求打到本机 `127.0.0.1:3080`；转发时把 `Host` 改回
 *      `127.0.0.1:3080` —— 上游于是认为请求来自本机，整套 origin/cookie
 *      校验原样通过，我们一行都不用改它。
 *   2. **配对**：没有会话的请求到不了上游。
 *   3. **WebSocket 透传**：DSH 的流式对话走 upgrade，一旦漏了这条，界面能开、
 *      一发消息就断。
 *   4. **来源校验**：配了 `--public-origin` 之后，只接受那条公网地址进来的
 *      请求，别的主机名一律 421 —— 隧道服务被扫到、或 DNS 被指向别处时，
 *      这里不会替它把请求洗白。
 *
 * ## 凭证模型（v0.9.54 起）
 *
 * 以前配对码本身就是长期 Cookie，等于把一把 32 位的钥匙挂在门上一整年。
 * 现在分成两层：
 *
 *   · **配对码**（8 位十六进制，印在二维码里）只用来**换一张会话票据**。
 *     它有过期时间（`--code-ttl`）、有失败限流，永远不作为后续请求的凭证。
 *   · **会话票据**（32 字节随机会话，`HttpOnly` Cookie）才是长期凭证，
 *     服务端逐条记录、可单条撤销（`DELETE /__kxxy_sessions?id=`）。
 *
 * 会话存在内存里 —— 连接器重启即全部失效，手机重连时会用连接串里的配对码
 * 重新换一张。这样「重启换码」天然等于「吊销所有设备」。
 *
 * ## 用法
 *
 *     node remote-connector.mjs
 *     node remote-connector.mjs --port 9000
 *     node remote-connector.mjs --target "http://127.0.0.1:3080/?token=abc"
 *
 *     # 公网：隧道回源到本机 8080，连接器只监听回环
 *     node remote-connector.mjs --public-origin https://kxxy.example.com
 *
 * ## 隧道
 *
 * 不在本程序里做。用户已有的 Tailscale / Cloudflare Tunnel / frp 只要把
 * **本机 8080** 暴露出去即可（不是 3080）。
 *
 * 判定「公网可用」的脚本是 `tools/check-public-remote.mjs`，它会分层告诉你
 * 卡在入口、证书、配对还是实时通道。
 */

import http from 'node:http'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** 会话 cookie 名。故意不起 `dsh_` 前缀，避免和上游自己的 cookie 混淆。 */
const PAIR_COOKIE = 'kxxy_pair'

/** 配对页路径。连接串里带的就是它。 */
const PAIR_PATH = '/__kxxy_pair'

/** 只读状态：给手机端 / 验收脚本判断「这一层到底通没通」，不含任何凭证。 */
const STATUS_PATH = '/__kxxy_status'

/** 会话管理：本机 + 管理密钥才能调用，隧道进来的一律 404。 */
const SESSIONS_PATH = '/__kxxy_sessions'

/** 会话默认有效期。30 天够用，且比「一年」少一个数量级的暴露窗口。 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 上游单次请求超时。DSH 在忙（例如正在起 WebView）时确实会慢，给足 30 秒。 */
const UPSTREAM_TIMEOUT_MS = 30_000

/**
 * 启动连接器。
 *
 * 返回的 `server` 已经 listen，`close()` 会连同升级中的 socket 一起断开 ——
 * 测试需要在同一进程里起停多次，否则端口残留会让下一个用例 EADDRINUSE。
 */
export function createConnector(options = {}) {
  const port = Number(options.port ?? 8080)
  const targetRaw = String(options.target ?? 'http://127.0.0.1:3080/')
  const code = String(options.code ?? generateCode())

  const target = new URL(targetRaw)
  if (target.protocol !== 'http:') {
    throw new Error(`--target 只支持 http://（TLS 由隧道负责），收到 ${target.protocol}`)
  }
  const targetHost = target.hostname
  const targetPort = Number(target.port || 80)
  const targetAuthority = `${targetHost}:${targetPort}`
  /** 上游若带 `?token=`，这里记下来，给「浏览器还没有 dsh cookie」时用。 */
  const token = target.searchParams.get('token') || ''

  /**
   * 公网入口（含协议与端口，不带路径）。
   *
   * 给了它就意味着「这个连接器是从公网可达的」，于是三件事同时收口：
   * 只监听回环、只认这一个 Host、Cookie 加 `Secure`。不给则是局域网模式，
   * 行为与旧版一致（监听所有网卡、接受本机地址）。
   */
  const publicOrigin = options.publicOrigin ? normalizePublicOrigin(options.publicOrigin) : null

  const host = String(options.host ?? (publicOrigin ? '127.0.0.1' : '0.0.0.0'))

  /** 配对码的过期时刻。`0` 表示不过期（仅建议局域网这么用）。 */
  const codeTtlMs = Math.max(0, Number(options.codeTtlMs ?? 0)) || 0
  const codeExpiresAt = codeTtlMs ? Date.now() + codeTtlMs : 0

  const sessionTtlMs = Math.max(60_000, Number(options.sessionTtlMs ?? SESSION_TTL_MS))

  /** 本机管理密钥：撤销会话、读详细状态时用。不是远程用户的凭证。 */
  const adminKey = String(options.adminKey ?? randomBytes(16).toString('hex'))

  const limiter = createRateLimiter(options.rateLimit || {})
  const sessions = new Map()
  const sockets = new Set()
  const startedAt = Date.now()
  let upstreamOk = null
  let upstreamCheckedAt = 0

  const server = http.createServer((req, res) => {
    // 任何解析异常都不能让进程退出：这个端口一旦公网可达，畸形请求是常态。
    try {
      handle(req, res)
    } catch (err) {
      sendText(res, 500, '连接器内部错误', err?.message || 'unknown')
    }
  })

  function handle(req, res) {
    let url
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    } catch {
      sendText(res, 400, '请求地址无法解析', '连接器收到的请求行不合法。')
      return
    }

    // ---- 0. 本机管理面 ----
    // 先于来源校验：它只认本机 Host + 管理密钥，隧道（Host 已被改写成公网域名）
    // 永远进不来，所以不需要也没必要为它放行公网来源。
    if (url.pathname === STATUS_PATH || url.pathname === SESSIONS_PATH) {
      handleAdmin(req, res, url)
      return
    }

    // ---- 1. 公网来源校验 ----
    // 必须在任何认证判断之前：一条来自错误主机名的请求，连「配对码对不对」
    // 都不该被回答 —— 否则它就成了一个可被用来试探配对码的预言机。
    if (publicOrigin && !isExpectedHost(req, publicOrigin)) {
      sendText(res, 421, '这个地址不接受来自该主机的请求', `请使用 ${publicOrigin.origin} 访问。`)
      return
    }

    // ---- 2. 配对页：校验码 → 换会话票据 → 302 回首页 ----
    if (url.pathname === PAIR_PATH) {
      const offered = url.searchParams.get('code') || ''
      const verdict = checkCode(req, offered)
      if (verdict !== 'ok') {
        rejectPair(req, res, verdict)
        return
      }
      const label = sanitizeLabel(url.searchParams.get('label') || '')
      const session = issueSession(req, label)
      res.writeHead(302, {
        ...securityHeaders(),
        'set-cookie': sessionCookie(session.token, req),
        location: '/',
      })
      res.end()
      return
    }

    // ---- 3. 认证门 ----
    if (!touchSession(req)) {
      // 支持「连接串直接带 code」而不经配对页 —— 手机端粘贴的就是这种。
      const offered = url.searchParams.get('code') || ''
      if (offered) {
        const verdict = checkCode(req, offered)
        if (verdict !== 'ok') {
          rejectPair(req, res, verdict)
          return
        }
        const label = sanitizeLabel(url.searchParams.get('label') || '')
        const session = issueSession(req, label)
        res.writeHead(302, {
          ...securityHeaders(),
          'set-cookie': sessionCookie(session.token, req),
          // 把 code 从地址里抹掉：它会进浏览器历史、也会进下次请求的 Referer。
          location: url.pathname + stripCodeParam(url.searchParams),
        })
        res.end()
        return
      }
      sendText(res, 401, '需要配对码', '请在 Kxxy 里重新粘贴完整的连接串。')
      return
    }

    // ---- 4. 跨站写请求：只接受与本站同源的 Origin ----
    // 会话 cookie 是 SameSite=Lax，跨站 POST 本来就带不上；这层是给
    // 「隧道域名与页面域名不同」「浏览器策略差异」留的兜底，同时挡住
    // 未来若改用 SameSite=None 时的退化。
    if (!['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET'))) {
      const origin = req.headers.origin
      if (origin && !isExpectedOrigin(origin, req, publicOrigin)) {
        sendText(res, 403, '跨站请求被拒绝', '写操作只接受来自同一个接入地址的请求。')
        return
      }
    }

    // ---- 5. 首次访问补上游 token ----
    //
    // 上游用 `?token=` 换 HttpOnly cookie。手机上第一次打开时浏览器没有那个
    // cookie，直接转发只会拿到 401。这里把浏览器的**文档请求**重定向到带
    // token 的地址：上游设 cookie 后前端就正常了。
    //
    // 重定向后 URL 里已经有 `token=`，所以不会循环 —— 这是这条判断的关键。
    if (token && !url.searchParams.has('token') && wantsDocument(req) && !hasUpstreamCookie(req)) {
      res.writeHead(302, { ...securityHeaders(), location: `/?token=${encodeURIComponent(token)}` })
      res.end()
      return
    }

    forward(req, res)
  }

  // -------------------------------------------------------------------------
  // 鉴权
  // -------------------------------------------------------------------------

  /**
   * 配对码判定：过期 / 限流 / 比对，三条都可能拒绝。
   *
   * 返回 `'ok' | 'expired' | 'rate' | 'mismatch'`，由调用方决定状态码 ——
   * 「码不对」和「你试太多次了」对用户是两种完全不同的下一步。
   */
  function checkCode(req, offered) {
    const addr = clientAddress(req)
    const wait = limiter.blockedFor(addr)
    if (wait > 0) return 'rate'
    if (codeExpiresAt && Date.now() > codeExpiresAt) return 'expired'
    if (!offered || !timingSafeEqual(offered, code)) {
      limiter.fail(addr)
      return 'mismatch'
    }
    limiter.succeed(addr)
    return 'ok'
  }

  function rejectPair(req, res, verdict) {
    if (verdict === 'rate') {
      const wait = limiter.blockedFor(clientAddress(req))
      const mins = Math.max(1, Math.ceil(wait / 60000))
      sendText(res, 429, '尝试次数过多', `请 ${mins} 分钟后再试，或回到电脑上重启连接器换一个配对码。`)
      return
    }
    if (verdict === 'expired') {
      sendText(res, 401, '配对码已过期', '配对码只在启动后的一段时间内有效。请回电脑上重启连接器，用新打印的连接串。')
      return
    }
    sendText(res, 401, '配对码不对', '请回到电脑上确认连接串里的 code。')
  }

  function issueSession(req, label) {
    pruneSessions()
    const token = randomBytes(32).toString('base64url')
    const session = {
      id: randomBytes(6).toString('hex'),
      label: label || '未命名设备',
      address: clientAddress(req),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    }
    sessions.set(token, session)
    return { token, session }
  }

  /** 校验会话并把 `lastSeenAt` 推进一步（用于状态面板显示「多久没动了」）。 */
  function touchSession(req) {
    const token = readCookie(req, PAIR_COOKIE)
    if (!token) return false
    const session = sessions.get(token)
    if (!session) return false
    if (Date.now() - session.createdAt > sessionTtlMs) {
      sessions.delete(token)
      return false
    }
    session.lastSeenAt = Date.now()
    return true
  }

  function pruneSessions() {
    const now = Date.now()
    for (const [token, session] of sessions) {
      if (now - session.createdAt > sessionTtlMs) sessions.delete(token)
    }
  }

  function sessionCookie(token, req) {
    const parts = [
      `${PAIR_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      // Lax 而不是 Strict：手机从别的 App 跳进来时，Strict 会让首次请求
      // 不带 cookie，表现为「刚配对完又要求配对」。
      'SameSite=Lax',
      `Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
    ]
    // 公网入口一定是 https（normalizePublicOrigin 已强制），所以直接标 Secure；
    // 局域网模式则看这条请求本身是不是走的 TLS / 隧道声明的 proto。
    if (publicOrigin || isSecureRequest(req)) parts.push('Secure')
    return parts.join('; ')
  }

  // -------------------------------------------------------------------------
  // 管理面（本机 + 管理密钥）
  // -------------------------------------------------------------------------

  function handleAdmin(req, res, url) {
    // 隧道进来时 Host 已被改写成公网域名 —— 这一步把它们全部挡在外面。
    // 只认本机 Host，不认「源地址是不是 127.0.0.1」：隧道回源也是 127.0.0.1，
    // 靠源地址判断等于没判。
    if (!isLoopbackHost(req.headers.host)) {
      sendText(res, 404, '没有这个地址', '这个接口只在电脑本机可用。')
      return
    }
    if (!timingSafeEqual(String(req.headers['x-kxxy-admin'] || ''), adminKey)) {
      sendText(res, 401, '管理密钥不对', '密钥在连接器启动时打印的那一行。')
      return
    }

    if (url.pathname === SESSIONS_PATH) {
      if (req.method === 'GET') {
        pruneSessions()
        sendJson(res, 200, {
          sessions: [...sessions].map(([token, s]) => ({
            // 只回前 8 位，够用户认出是哪一条，又不足以复用。
            token: `${token.slice(0, 8)}…`,
            id: s.id,
            label: s.label,
            address: s.address,
            createdAt: s.createdAt,
            lastSeenAt: s.lastSeenAt,
          })),
        })
        return
      }
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id') || ''
        if (!id) {
          const count = sessions.size
          sessions.clear()
          sendJson(res, 200, { revoked: count })
          return
        }
        let revoked = 0
        for (const [token, s] of sessions) {
          if (s.id === id) {
            sessions.delete(token)
            revoked += 1
          }
        }
        sendJson(res, 200, { revoked })
        return
      }
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }
    pruneSessions()
    sendJson(res, 200, {
      connector: 'ok',
      target: targetAuthority,
      publicOrigin: publicOrigin ? publicOrigin.origin : null,
      listen: `${host}:${port}`,
      uptimeMs: Date.now() - startedAt,
      sessions: sessions.size,
      codeExpiresAt: codeExpiresAt || null,
      upstream: upstreamOk,
      upstreamCheckedAt: upstreamCheckedAt || null,
      rateLimited: limiter.size(),
    })
  }

  // -------------------------------------------------------------------------
  // 转发
  // -------------------------------------------------------------------------

  /** 普通 HTTP 转发。除 Host 外全部透传，含状态码与 Set-Cookie。 */
  function forward(req, res) {
    const headers = upstreamHeaders(req)

    const upstream = http.request(
      { host: targetHost, port: targetPort, method: req.method, path: req.url, headers },
      (upRes) => {
        // 上游的 Set-Cookie 原样下发：浏览器按**当前 host**（连接器的 host）
        // 存储，下次请求自然带回，我们再原样转发。不需要改写 cookie 的域，
        // 因为上游本来就没设 Domain。
        res.writeHead(upRes.statusCode || 502, { ...upRes.headers, ...securityHeaders() })
        upRes.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      if (res.headersSent) {
        res.end()
        return
      }
      sendText(
        res,
        502,
        '连不上本机的 DSH',
        `已尝试 ${targetAuthority}，报错：${err.code || err.message}。请确认桌面端正在运行，或用 --target 指定正确端口。`,
      )
    })
    // 上游卡住时不能把手机端一起挂死：超时回 504，让「电脑太忙」和
    // 「电脑没开」在手机上是两种能区分的现象。
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }))
    })
    req.pipe(upstream)
  }

  /**
   * WebSocket / SSE 之外的 upgrade 透传。
   *
   * 做法是「手工完成一次 upgrade 握手」：向上游发同样的请求（Host 已改），
   * 拿到 101 后把响应头原样写回给手机，再把两条 socket 对接。
   * 用 `http.request` 而不是 `net.connect`：上游按 Host/路径做路由，走
   * HTTP 层才能保持行为一致。
   */
  server.on('upgrade', (req, socket, head) => {
    try {
      if (publicOrigin && !isExpectedHost(req, publicOrigin)) {
        writeRaw(socket, 421, 'Misdirected Request')
        return
      }
      if (!touchSession(req)) {
        writeRaw(socket, 401, 'Unauthorized')
        return
      }

      const upstream = http.request({
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req),
      })

      upstream.on('upgrade', (upRes, upSocket, upHead) => {
        const lines = [`HTTP/1.1 101 ${upRes.statusMessage || 'Switching Protocols'}`]
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
          lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`)
        }
        socket.write(lines.join('\r\n') + '\r\n\r\n')
        if (upHead?.length) socket.write(upHead)
        if (head?.length) upSocket.write(head)

        upSocket.on('error', () => socket.destroy())
        socket.on('error', () => upSocket.destroy())
        upSocket.pipe(socket)
        socket.pipe(upSocket)
        // 两条 socket 都要登记，否则 close() 时 upgrade 连接会把进程吊住。
        sockets.add(upSocket)
        upSocket.on('close', () => sockets.delete(upSocket))
      })

      upstream.on('response', (upRes) => {
        // 上游拒绝升级（例如 401）：把它的响应原样交回去，别让手机端一直等。
        const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`]
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
          lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`)
        }
        socket.write(lines.join('\r\n') + '\r\n\r\n')
        socket.destroy()
      })

      upstream.on('error', () => socket.destroy())
      upstream.end()
    } catch {
      socket.destroy()
    }
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  // 畸形请求（裸 socket、错版本、超长头）走这里。默认行为会直接断开，
  // 但不会给出可诊断的响应；而且在某些 Node 版本上未处理的 clientError
  // 会打出未捕获异常。这里统一回 400 并关连接。
  server.on('clientError', (err, socket) => {
    if (!socket.writable) {
      socket.destroy()
      return
    }
    const status = err?.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request'
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  })

  /** 上游请求头：Host 改写 + 同源 Origin 归一 + 代理链信息。 */
  function upstreamHeaders(req) {
    const headers = { ...req.headers, host: targetAuthority }

    // Origin 必须跟着 Host 一起改写。只改 Host 不改 Origin 的后果很具体：
    // 上游若做「Origin 与 Host 同源」校验，GET 能开、POST 与 WebSocket 全挂，
    // 而现象是「页面正常但一发消息就断」，极难定位。
    //
    // 安全性由调用方保证：能走到这里的请求，其来源已经在 handle() 里按
    // publicOrigin 校验过；这里只做「本站口径 → 上游口径」的等价映射，
    // 不会把陌生站点的 Origin 洗白成本站。
    const origin = req.headers.origin
    if (origin && isExpectedOrigin(origin, req, publicOrigin)) {
      headers.origin = `http://${targetAuthority}`
    }
    // Referer 同理：上游若按 Referer 做同源判断，留着公网域名同样会被拒。
    const referer = req.headers.referer
    if (referer) {
      try {
        const parsed = new URL(referer)
        if (isExpectedOrigin(parsed.origin, req, publicOrigin)) {
          headers.referer = `http://${targetAuthority}${parsed.pathname}${parsed.search}`
        }
      } catch {
        delete headers.referer
      }
    }

    // 让上游看到真实来源，便于它自己的日志；不影响它的 Host 校验（那只认 Host）。
    headers['x-forwarded-for'] = clientAddress(req)
    headers['x-forwarded-proto'] = 'http'
    headers['x-forwarded-host'] = String(req.headers.host || '')
    return headers
  }

  return {
    code,
    port,
    host,
    token,
    adminKey,
    publicOrigin: publicOrigin ? publicOrigin.origin : null,
    targetAuthority,
    /** 拆开给启动探测用（[probeUpstream] 要单独发一个请求）。 */
    targetHost,
    targetPort,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => resolve(server.address()))
      }),
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
    /** 本机可用的局域网地址（给连接串用）。 */
    lanAddresses: () => listLanAddresses(),
    /** 当前有效会话数（测试与状态面板用）。 */
    sessionCount: () => sessions.size,
    /** 撤销全部会话，返回撤销条数。 */
    revokeAll: () => {
      const count = sessions.size
      sessions.clear()
      return count
    },
    /** 探测一次上游并缓存结果，返回布尔。 */
    probe: async () => {
      upstreamOk = await probeUpstream(targetAuthority)
      upstreamCheckedAt = Date.now()
      return upstreamOk
    },
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 8 位十六进制，好念也好输。它只是引导凭证，真正的长期凭证是会话票据。 */
export function generateCode() {
  const hex = randomBytes(6).toString('hex') // 12 位，取 8
  return `${hex.slice(0, 4)}${hex.slice(4, 8)}`
}

/**
 * 一次性探测上游是否可达。
 *
 * 只看「有没有 HTTP 响应」，不看状态码：401 也说明上游活着（只是没带 token），
 * 那本身就是有用的信息 —— 用户接下来要解决的是认证，不是「桌面端没开」。
 */
export function probeUpstream(authority, timeoutMs = 1500) {
  const [host, portText] = String(authority).split(':')
  const port = Number(portText || 80)
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/', method: 'GET', headers: { host: authority } }, (res) => {
      res.resume()
      resolve(true)
    })
    // 桌面端在忙（例如正在启动 WebView）时可能迟迟不回 —— 超时按不可达处理，
    // 这只是个提示，不该把启动卡住。
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

/**
 * 安全读一个 cookie。
 *
 * 之前这里直接 `decodeURIComponent()`，一个 `%` 就能抛异常 —— 而那条路径
 * 在**认证完成之前**执行，等于给公网入口留了一个「发一个坏 Cookie 就打崩
 * 连接器」的按钮。现在解码失败一律视为「没有这个 cookie」。
 */
function readCookie(req, name) {
  const raw = req.headers.cookie
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return ''
    }
  }
  return ''
}

/** 浏览器是否已持有上游的 DSH 会话 cookie（有就不再补 token 重定向）。 */
function hasUpstreamCookie(req) {
  const raw = req.headers.cookie || ''
  // 上游的 cookie 名随版本可能变，这里按「除配对 cookie 之外还有别的」判断，
  // 宁可多判一次已认证，也不要为了名字匹配而制造重定向循环。
  return raw
    .split(';')
    .map((s) => s.trim())
    .some((s) => s && !s.startsWith(`${PAIR_COOKIE}=`))
}

/**
 * 是否需要 HTML 文档。
 *
 * 只对文档重定向：XHR/fetch 被 302 到 `/?token=` 会拿到一坨 HTML 而不是
 * JSON，反而把「缺 cookie」变成「返回格式错误」，更难查。
 */
function wantsDocument(req) {
  if (req.method !== 'GET') return false
  const dest = req.headers['sec-fetch-dest']
  if (dest) return dest === 'document' || dest === 'iframe'
  return String(req.headers.accept || '').includes('text/html')
}

function stripCodeParam(params) {
  const rest = new URLSearchParams(params)
  rest.delete('code')
  rest.delete('label')
  const qs = rest.toString()
  return qs ? `?${qs}` : ''
}

/** 定长比较，避免按字节短路泄露前缀。长度不同也走一次假比较，不早退。 */
function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  const len = Math.max(x.length, y.length, 1)
  let diff = x.length ^ y.length
  for (let i = 0; i < len; i++) diff |= (x[i] || 0) ^ (y[i] || 0)
  return diff === 0
}

/**
 * 公网入口规范化。
 *
 * 只接受 https，且必须是**站点根**（不能带路径）—— 隧道会原样转发路径，
 * 带路径的 `publicOrigin` 会让「期望 Host」与「实际 Host」永远对不上，
 * 表现为所有请求 421，排查起来非常费劲。
 */
function normalizePublicOrigin(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new Error(`--public-origin 不是合法地址：${raw}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error('--public-origin 必须是 https://（公网入口没有明文这一档）')
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--public-origin 只能是站点根，例如 https://kxxy.example.com，不要带路径')
  }
  return url
}

/** 请求的 Host 是否就是我们声明的那个公网入口。 */
function isExpectedHost(req, publicOrigin) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase()
  if (!raw) return false
  const expected = publicOrigin.host.toLowerCase()
  if (raw === expected) return true
  // 隧道有时只转 Host 不带端口，默认 443 时也应算同源。
  return publicOrigin.port === '' && raw === `${publicOrigin.hostname.toLowerCase()}`
}

/** Origin 是否属于本站（公网模式认 publicOrigin，局域网模式认当前 Host）。 */
function isExpectedOrigin(origin, req, publicOrigin) {
  let parsed
  try {
    parsed = new URL(String(origin))
  } catch {
    return false
  }
  if (publicOrigin) return parsed.host.toLowerCase() === publicOrigin.host.toLowerCase()
  const selfHost = String(req.headers.host || '').toLowerCase()
  return parsed.host.toLowerCase() === selfHost
}

/** 是否本机地址（管理面用）。隧道回源也是 127.0.0.1，所以只作为第一道筛。 */
function isLoopbackHost(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase()
  if (!raw) return false
  const hostname = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/** 请求是否走的 HTTPS（直连 TLS 或隧道声明了 https）。 */
function isSecureRequest(req) {
  if (req.socket && req.socket.encrypted) return true
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https'
}

function clientAddress(req) {
  return String(req.socket?.remoteAddress || 'unknown')
}

/** 配对时带过来的设备名：只保留可见字符并截断，避免被当成注入载荷。 */
function sanitizeLabel(raw) {
  return String(raw)
    .replace(/[^\p{L}\p{N}\p{M} ._\-()（）]/gu, '')
    .trim()
    .slice(0, 32)
}

/**
 * 配对失败限流。
 *
 * 8 位十六进制只有 32 位熵 —— 单看是够不着公网门的。但加上「同一来源
 * 5 次失败即锁 30 分钟」之后，一轮爆破的成功概率降到百万分之一量级，
 * 而正常用户几乎不可能连错 5 次（连接串是扫码来的）。
 */
function createRateLimiter({ maxFails = 5, windowMs = 10 * 60 * 1000, blockMs = 30 * 60 * 1000 } = {}) {
  const hits = new Map()

  function record(addr) {
    let entry = hits.get(addr)
    const now = Date.now()
    if (!entry || now - entry.firstAt > windowMs) {
      entry = { fails: 0, firstAt: now, blockedUntil: 0 }
      hits.set(addr, entry)
    }
    return entry
  }

  return {
    blockedFor(addr) {
      const entry = hits.get(addr)
      if (!entry) return 0
      const now = Date.now()
      return entry.blockedUntil > now ? entry.blockedUntil - now : 0
    },
    fail(addr) {
      const entry = record(addr)
      entry.fails += 1
      if (entry.fails >= maxFails) {
        entry.blockedUntil = Date.now() + blockMs
        entry.fails = 0
        entry.firstAt = Date.now()
      }
      return entry.fails
    },
    succeed(addr) {
      const entry = hits.get(addr)
      if (entry) entry.fails = 0
    },
    size: () => hits.size,
  }
}

function securityHeaders() {
  return {
    // token 会短暂出现在地址里。没有这条，页面加载任何外部资源都会把
    // `?token=…` 通过 Referer 送给第三方。
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(res, status, title, detail) {
  const body = renderErrorPage(title, detail)
  res.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function writeRaw(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } finally {
    socket.destroy()
  }
}

export function listLanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue
      // Android 热点给的是 192.168.43.x / 192.0.2.x，一并列出 —— 用户可能就是
      // 用手机热点让电脑上网的，那条路径同样要走局域网。
      out.push({ iface: name, address: info.address })
    }
  }
  // 私有网段排前面，公网/虚拟网卡（Tailscale 100.x 除外）排后
  const score = (ip) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3
  return out.sort((a, b) => score(a.address) - score(b.address))
}

function renderErrorPage(title, detail) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f9fafb;
         color:#1f2328; font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  @media (prefers-color-scheme: dark) {
    body { background:#151517; color:#f9fafb; }
    p { color:#9aa1a9 !important; }
  }
  .box { max-width: 340px; padding: 28px 24px; }
  h1 { font-size:17px; margin:0 0 10px; font-weight:600; }
  p { margin:0; color:#5b636b; font-size:13.5px; }
</style>
<div class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></div>
</html>`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * 极简参数解析（不引依赖 —— 这个文件要能被用户直接 `node` 跑，不该要求
 * 先 npm install）。
 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

function isMain() {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) {
    console.log(`用法：node remote-connector.mjs [选项]

  --target <url>        上游 DSH 地址（默认 http://127.0.0.1:3080/）
                        若你知道它启动时的 token，一并带上：
                        --target "http://127.0.0.1:3080/?token=…"
  --port <n>            对外监听端口（默认 8080）
  --host <addr>         监听地址（默认 0.0.0.0；给了 --public-origin 时默认 127.0.0.1）
  --code <str>          固定配对码（默认随机 8 位）
  --code-ttl <分钟>     配对码过期时间（0 = 不过期；公网建议 30）
  --public-origin <url> 公网入口，如 https://kxxy.example.com
                        给了它就只认这一个 Host，并把 Cookie 标成 Secure
  --help                显示本帮助

本机管理（撤销设备授权，只在本机可用）：
  curl -H "x-kxxy-admin: <启动时打印的密钥>" http://127.0.0.1:8080/__kxxy_status
  curl -X DELETE -H "x-kxxy-admin: <密钥>" http://127.0.0.1:8080/__kxxy_sessions`)
    process.exit(0)
  }

  let connector
  try {
    connector = createConnector({
      port: args.port ?? process.env.KXXY_REMOTE_PORT ?? 8080,
      target: args.target ?? process.env.KXXY_REMOTE_TARGET,
      code: typeof args.code === 'string' ? args.code : undefined,
      host: typeof args.host === 'string' ? args.host : undefined,
      publicOrigin: typeof args['public-origin'] === 'string' ? args['public-origin'] : undefined,
      codeTtlMs: args['code-ttl'] ? Number(args['code-ttl']) * 60_000 : 0,
    })
  } catch (err) {
    console.error('启动失败：', err.message)
    process.exit(1)
  }

  connector
    .listen()
    .then(async (addr) => {
      const lan = connector.lanAddresses()
      const bindAll = addr.address === '0.0.0.0' || addr.address === '::'
      const primary = bindAll ? lan[0]?.address || '<本机局域网 IP>' : addr.address
      // 带机器名，手机端拿它当设备名（否则多台电脑在列表里全是「局域网设备 · IP」）。
      // 编码是必须的：中文/含空格的主机名直接拼进 query，手机侧会解析成空值。
      const label = encodeURIComponent(os.hostname() || '电脑')
      const scheme = connector.publicOrigin ? 'https' : 'http'
      const origin = connector.publicOrigin || `${scheme}://${primary}:${connector.port}`
      const link = `${origin}${PAIR_PATH}?code=${connector.code}&label=${label}`

      // 上游是否真的在跑，启动时就说清楚。
      //
      // 不探的话，用户会先经历「手机连上了 → 页面 502」这一圈，才回来怀疑
      // 是桌面端没开或端口不对；而这两件事在电脑上是**一眼可见**的，没理由
      // 让手机端去当那个报错的地方。
      const upstreamUp = await connector.probe()

      console.log('')
      console.log('  Kxxy 远程连接器已启动')
      console.log(`  监听        ${addr.address}:${connector.port}${connector.publicOrigin ? '（仅回环，隧道回源到这里）' : ''}`)
      console.log(`  上游        ${connector.targetAuthority}${connector.token ? '（已带 token）' : ''}`)
      console.log(`  上游状态    ${upstreamUp ? '✓ 连得上' : '✗ 连不上 —— 先打开 DSH 桌面端'}`)
      if (!upstreamUp) {
        console.log('              端口不是 3080 的话，用 --target http://127.0.0.1:<端口>/ 指定')
      }
      if (connector.publicOrigin) {
        console.log(`  公网入口    ${connector.publicOrigin}（只接受这个 Host）`)
      }
      console.log(`  配对码      ${connector.code}`)
      console.log('')
      console.log('  连接串（粘到 Kxxy → 概览 → 远程控制 → 添加电脑）')
      console.log(`    ${link}`)
      if (!connector.publicOrigin && lan.length > 1) {
        console.log('')
        console.log('  其它网卡（上面那条连不通时试这里）')
        for (const item of lan.slice(1)) {
          console.log(`    http://${item.address}:${connector.port}${PAIR_PATH}?code=${connector.code}&label=${label}   ${item.iface}`)
        }
      }
      console.log('')
      if (!connector.publicOrigin) {
        console.log('  想在外面（4G / 别的网络）连？把本机 %d 端口映射成一条公网地址，', connector.port)
        console.log('  再带上 --public-origin 重启（只监听回环，只认那条域名）：')
        console.log(`    node tools/remote-connector.mjs --public-origin https://<你的域名>`)
        console.log('  注意暴露的是这个连接器端口，不是 3080。')
      }
      console.log('')
      console.log('  本机管理（撤销设备授权，隧道进来的一律不可用）')
      console.log(`    管理密钥  ${connector.adminKey}`)
      console.log(`    curl -H "x-kxxy-admin: ${connector.adminKey}" http://127.0.0.1:${connector.port}/__kxxy_status`)
      console.log('')
      console.log('  Ctrl+C 退出。重启会让所有已配对设备失效，需要重新扫一次。')
      console.log('')
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`端口 ${connector.port} 被占用，换一个：--port 8081`)
      } else {
        console.error('启动失败：', err.message)
      }
      process.exit(1)
    })

  const shutdown = () => {
    connector.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
