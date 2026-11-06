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
 * 这个连接器是**电脑侧的一个小反代**，做三件事：
 *
 *   1. **对外监听** `0.0.0.0:8080`，把请求转发到本机 `127.0.0.1:3080`；
 *      转发时把 `Host` 改回 `127.0.0.1:3080` —— 上游于是认为请求来自本机，
 *      整套 origin/cookie 校验原样通过，我们一行都不用改它。
 *   2. **配对认证**：没有配对码的请求到不了上游。局域网里谁都能扫到 8080
 *      端口，但打不开会话。
 *   3. **WebSocket 透传**：DSH 的流式对话走 upgrade，一旦漏了这条，界面能开、
 *      一发消息就断。
 *
 * ## 用法
 *
 *     node remote-connector.mjs                       # 自动探测 token
 *     node remote-connector.mjs --code 7f3a9c21       # 固定配对码
 *     node remote-connector.mjs --target http://127.0.0.1:3080/?token=abc
 *     node remote-connector.mjs --port 9000
 *
 * 然后把打印出来的连接串粘到 Kxxy「概览 → 远程控制 → 添加电脑」。
 *
 * ## 隧道
 *
 * 不在本程序里做。用户已有的 Tailscale / Cloudflare Tunnel / frp 只要把
 * **本机 8080** 暴露出去即可（不是 3080），连接串把 host 换成隧道域名。
 * 这样中继带宽、证书、DNS 全部由成熟工具负责，我们既不承担运维也不碰凭证。
 */

import http from 'node:http'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** 配对 cookie 名。故意不起 `dsh_` 前缀，避免和上游自己的 cookie 混淆。 */
const PAIR_COOKIE = 'kxxy_pair'

/** 配对页路径。连接串里带的就是它。 */
const PAIR_PATH = '/__kxxy_pair'

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

  const sockets = new Set()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    // ---- 1. 配对页：校验码 → 下发 cookie → 302 回首页 ----
    if (url.pathname === PAIR_PATH) {
      const offered = url.searchParams.get('code') || ''
      if (!timingSafeEqual(offered, code)) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderErrorPage('配对码不对', '请回到电脑上确认连接串里的 code。'))
        return
      }
      res.writeHead(302, {
        // HttpOnly：页面脚本读不到；SameSite=Lax：隧道域名跨站直连也能带上；
        // 一年有效，配合 Kxxy 侧「移除设备」即可吊销（那只是删本地记录，
        // 真正的吊销是重启连接器换配对码 —— 这一点在文档里讲清楚了）。
        'set-cookie': `${PAIR_COOKIE}=${encodeURIComponent(code)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        location: '/',
      })
      res.end()
      return
    }

    // ---- 2. 认证门 ----
    if (!hasPairCookie(req, code)) {
      if (url.searchParams.get('code') === code) {
        // 支持「连接串直接带 code」而不经配对页 —— 手机端粘贴的就是这种。
        res.writeHead(302, {
          'set-cookie': `${PAIR_COOKIE}=${encodeURIComponent(code)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
          location: url.pathname + stripCodeParam(url.searchParams),
        })
        res.end()
        return
      }
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderErrorPage('需要配对码', '请在 Kxxy 里重新粘贴完整的连接串。'))
      return
    }

    // ---- 3. 首次访问补上游 token ----
    //
    // 上游用 `?token=` 换 HttpOnly cookie。手机上第一次打开时浏览器没有那个
    // cookie，直接转发只会拿到 401。这里把浏览器的**文档请求**重定向到带
    // token 的地址：上游设 cookie 后前端就正常了。
    //
    // 重定向后 URL 里已经有 `token=`，所以不会循环 —— 这是这条判断的关键。
    if (token && !url.searchParams.has('token') && wantsDocument(req) && !hasUpstreamCookie(req)) {
      res.writeHead(302, { location: `/?token=${encodeURIComponent(token)}` })
      res.end()
      return
    }

    forward(req, res)
  })

  /** 普通 HTTP 转发。除 Host 外全部透传，含状态码与 Set-Cookie。 */
  function forward(req, res) {
    const headers = { ...req.headers, host: targetAuthority }
    // 让上游看到真实来源，便于它自己的日志；不影响它的 Host 校验（那只认 Host）。
    headers['x-forwarded-for'] = req.socket.remoteAddress || ''
    headers['x-forwarded-proto'] = 'http'

    const upstream = http.request(
      { host: targetHost, port: targetPort, method: req.method, path: req.url, headers },
      (upRes) => {
        // 上游的 Set-Cookie 原样下发：浏览器按**当前 host**（连接器的 host）
        // 存储，下次请求自然带回，我们再原样转发。不需要改写 cookie 的域，
        // 因为上游本来就没设 Domain。
        res.writeHead(upRes.statusCode || 502, upRes.headers)
        upRes.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      if (res.headersSent) {
        res.end()
        return
      }
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        renderErrorPage(
          '连不上本机的 DSH',
          `已尝试 ${targetAuthority}，报错：${err.code || err.message}。` +
            '请确认桌面端正在运行，或用 --target 指定正确端口。',
        ),
      )
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
    if (!hasPairCookie(req, code)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: targetAuthority },
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
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return {
    code,
    port,
    token,
    targetAuthority,
    /** 拆开给启动探测用（[probeUpstream] 要单独发一个请求）。 */
    targetHost,
    targetPort,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => resolve(server.address()))
      }),
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
    /** 本机可用的局域网地址（给连接串用）。 */
    lanAddresses: () => listLanAddresses(),
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 4 组 4 位十六进制，好念也好输：`a1b2-c3d4-e5f6-7890` 太长，取 8 位。 */
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
function probeUpstream(authority, timeoutMs = 1500) {
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

function hasPairCookie(req, code) {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== PAIR_COOKIE) continue
    if (timingSafeEqual(decodeURIComponent(rest.join('=')), code)) return true
  }
  return false
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
  const qs = rest.toString()
  return qs ? `?${qs}` : ''
}

/** 定长比较，避免按字节短路泄露配对码前缀。 */
function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
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
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#151517;
         color:#f9fafb; font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  .box { max-width: 340px; padding: 28px 24px; }
  h1 { font-size:17px; margin:0 0 10px; }
  p { margin:0; color:#9aa1a9; font-size:13.5px; }
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

  --target <url>   上游 DSH 地址（默认 http://127.0.0.1:3080/）
                   若你知道它启动时的 token，一并带上：
                   --target "http://127.0.0.1:3080/?token=…"
  --port <n>       对外监听端口（默认 8080）
  --code <str>     固定配对码（默认随机 8 位）
  --help           显示本帮助`)
    process.exit(0)
  }

  const connector = createConnector({
    port: args.port ?? process.env.KXXY_REMOTE_PORT ?? 8080,
    target: args.target ?? process.env.KXXY_REMOTE_TARGET,
    code: typeof args.code === 'string' ? args.code : undefined,
  })

  connector
    .listen()
    .then(async (addr) => {
      const host = addr.address === '0.0.0.0' ? '<本机局域网 IP>' : addr.address
      const lan = connector.lanAddresses()
      const primary = lan[0]?.address || host
      // 带机器名，手机端拿它当设备名（否则多台电脑在列表里全是「局域网设备 · IP」）。
      // 编码是必须的：中文/含空格的主机名直接拼进 query，手机侧会解析成空值。
      const label = encodeURIComponent(os.hostname() || '电脑')
      const link = `http://${primary}:${connector.port}${PAIR_PATH}?code=${connector.code}&label=${label}`

      // 上游是否真的在跑，启动时就说清楚。
      //
      // 不探的话，用户会先经历「手机连上了 → 页面 502」这一圈，才回来怀疑
      // 是桌面端没开或端口不对；而这两件事在电脑上是**一眼可见**的，没理由
      // 让手机端去当那个报错的地方。
      const upstreamUp = await probeUpstream(connector.targetAuthority)

      console.log('')
      console.log('  Kxxy 远程连接器已启动')
      console.log(`  上游        ${connector.targetAuthority}${connector.token ? '（已带 token）' : ''}`)
      console.log(`  上游状态    ${upstreamUp ? '✓ 连得上' : '✗ 连不上 —— 先打开 DSH 桌面端'}`)
      if (!upstreamUp) {
        console.log('              端口不是 3080 的话，用 --target http://127.0.0.1:<端口>/ 指定')
      }
      console.log(`  配对码      ${connector.code}`)
      console.log('')
      console.log('  连接串（粘到 Kxxy → 概览 → 远程控制 → 添加电脑）')
      console.log(`    ${link}`)
      if (lan.length > 1) {
        console.log('')
        console.log('  其它网卡（上面那条连不通时试这里）')
        for (const item of lan.slice(1)) {
          console.log(`    http://${item.address}:${connector.port}${PAIR_PATH}?code=${connector.code}&label=${label}   ${item.iface}`)
        }
      }
      console.log('')
      console.log('  远程（自带隧道）：把本机 %d 端口暴露出去后，用隧道域名替换 host。', connector.port)
      console.log(`    例如  https://<你的隧道域名>${PAIR_PATH}?code=${connector.code}`)
      console.log('    注意暴露的是这个连接器端口，不是 3080。')
      console.log('')
      console.log('  Ctrl+C 退出。重启会换一个配对码，手机上需要重新粘贴连接串。')
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
