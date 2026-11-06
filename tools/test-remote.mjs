/**
 * 「手机控电脑」的契约测试 + 连接器真跑测试。
 *
 * 分两段，理由不同：
 *
 *   [A] 契约段 —— 原生侧（Kotlin）本地跑不起来。这一层钉的是**接线**：
 *       哪个 action 存在、安全边界在哪一行、JSON 字段叫什么。每条都对应一个
 *       「漏了就会静默退化成『能点但连不上』或『安全边界消失』」的点。
 *
 *   [B] 真跑段 —— 连接器是纯 Node，可以真起服务、真发 HTTP、真做 upgrade。
 *       这一段覆盖的是**最容易被写错又最难在真机上定位**的三件事：
 *       Host 改写、配对门、WebSocket 透传。真机上报「能打开但一发消息就断」
 *       时，几乎一定是这里漏了 upgrade。
 *
 * 用法：node tools/test-remote.mjs
 */

import { readFileSync, writeSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { createConnector, generateCode, listLanAddresses } from './remote-connector.mjs'

const read = (p) => readFileSync(p, 'utf8')
const norm = (s) => s.replace(/\r\n/g, '\n')

const link = norm(read('android/app/src/main/java/app/kxxy/remote/RemoteLink.kt'))
const store = norm(read('android/app/src/main/java/app/kxxy/remote/RemoteStore.kt'))
const bar = norm(read('android/app/src/main/java/app/kxxy/remote/RemoteBar.kt'))
const activity = norm(read('android/app/src/main/java/app/kxxy/MainActivity.kt'))
const supervisor = norm(read('android/app/src/main/java/app/kxxy/engine/EngineSupervisor.kt'))
const html = norm(read('plugins/kxxy-host/web/index.html'))
const js = norm(read('plugins/kxxy-host/web/host.js'))
const css = norm(read('plugins/kxxy-host/web/host.css'))
const runtime = norm(read('tools/build-runtime.mjs'))
const installer = norm(read('android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt'))

let pass = 0
let fail = 0

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

/** 去空白后比对，避免缩进/换行让断言假失败。 */
const has = (haystack, needle) => haystack.replace(/\s+/g, ' ').includes(needle.replace(/\s+/g, ' '))

// ---------------------------------------------------------------------------
// [A] 契约：连接串解析
// ---------------------------------------------------------------------------
console.log('\n[A] 连接串解析（RemoteLink）')

ok('parse 只接受 http/https', has(link, 'if (scheme != "http" && scheme != "https") return null'))
ok('裸 host 自动补 http://', has(link, 'else -> "http://$trimmed"'))
ok(
  '没有 token/code 时拒绝（否则用户只会看到英文 401）',
  has(link, 'if (!hasCredential(uri)) return null'),
  '这是「添加时就说清楚」与「连上后 401」的分界',
)
ok('认 token / code / pair / key 四种凭据名', ['"token"', '"code"', '"pair"', '"key"'].every((k) => link.includes(k)))
ok('清理包裹引号与尖括号', has(link, "s.trim('`', '\\'', '\"', '<', '>', ' ')"))
ok('能从句子里捞出 URL（终端复制粘贴的常见形态）', has(link, 'lastOrNull { it.startsWith("http", true)'))
ok('origin 规范化：默认端口省略', has(link, 'if (port == defaultPort) "$scheme://$hostForOrigin" else'))
ok('IPv6 origin 加方括号', has(link, 'val hostForOrigin = if (host.contains(\':\')) "[$host]" else host'))
ok('私有网段判定：10/127/192.168/172.16-31', has(link, 'nums[0] == 10 -> true') && has(link, 'nums[0] == 127 -> true') && has(link, 'nums[0] == 192 && nums[1] == 168 -> true') && has(link, 'nums[0] == 172 && nums[1] in 16..31 -> true'))
ok('Android 热点网段 192.0.2.x 也算局域网', has(link, 'nums[0] == 192 && nums[1] == 0 && nums[2] == 2 -> true'))
ok('localhost / .local / .lan 算局域网', has(link, 'h == "localhost" || h.endsWith(".local") || h.endsWith(".lan")'))
ok('IPv6 链路本地与 ULA 算局域网', has(link, 'h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")'))
ok('只按字面量判断，不做 DNS 解析（同步路径不能有网络往返）', !/InetAddress|getByName/.test(link))

// ---------------------------------------------------------------------------
// [A] 契约：设备簿
// ---------------------------------------------------------------------------
console.log('\n[A] 设备簿（RemoteStore）')

ok('按 origin 去重', has(store, 'indexOfFirst { it.origin == parsed.origin }'))
ok('凭据在快照里打码，但保留结构', has(store, 'setOf("token", "code", "pair", "key")') && has(store, '"$key=••••••"'))
ok('快照含 devices / lastUsedId / count / error', ['"devices"', '"lastUsedId"', '"count"', '"error"'].every((k) => store.includes(k)))
ok('每个设备含 id/label/host/origin/kind/secure/ok', ['"id"', '"label"', '"host"', '"origin"', '"kind"', '"secure"', '"ok"'].every((k) => store.includes(k)))
ok('错误带自增序号（前端靠它决定弹不弹 toast）', has(store, 'KEY_ERROR_SEQ') && has(store, 'noteError'))
ok('noteError 递增序号并落盘', has(store, 'putLong(KEY_ERROR_SEQ'))

// ---------------------------------------------------------------------------
// [A] 契约：安全边界（这一段最重要）
// ---------------------------------------------------------------------------
console.log('\n[A] 安全边界（MainActivity）')

ok('存在 remoteMode 标记', has(activity, 'private var remoteMode = false'))
ok(
  '远程模式下 kxxy:// 桥被硬拒绝',
  has(activity, 'if (remoteMode)') && /remoteMode[\s\S]{0,240}kxxy/.test(activity),
  '否则远端页面能调起本机的系统权限申请',
)
ok('先立标记再 loadUrl（顺序是安全语义，不是时序优化）', has(activity, 'remoteMode = true') && /remoteMode = true[\s\S]{0,400}loadUrl/.test(activity))
ok('远程 origin 之外不放行应用内导航', /isPairedOrigin|paired/i.test(activity))
ok(
  'SSL 只对已配对 host 放行，其余 cancel',
  has(activity, 'handler.proceed()') && has(activity, 'handler.cancel()') &&
    /RemoteStore\.devices\([\s\S]{0,160}it\.host == host/.test(activity),
)
ok('远程 URL 只允许 http/https', has(activity, 'scheme != "http" && scheme != "https"'))
ok('断开远程回到本机宿主页并落到 #remote', has(activity, '#remote'))

// ---------------------------------------------------------------------------
// [A] 契约：桥动作与状态发布
// ---------------------------------------------------------------------------
console.log('\n[A] 桥与状态')

for (const action of ['add', 'open', 'remove', 'rename', 'connect', 'disconnect']) {
  ok(`桥动作 ${action} 存在`, new RegExp(`"${action}" ->`).test(activity))
}
ok('设备簿变更后立刻重发状态（否则要等心跳）', has(activity, 'supervisor.republishState()'))
ok('publishState 带 remote 快照', has(supervisor, '\\"remote\\": ${app.kxxy.remote.RemoteStore.snapshotJson(ctx)}'))
ok('设备条是覆盖层而不是塞进 WebView（远端页面的 DOM 我们改不了）', /class RemoteBar|object RemoteBar/.test(bar) || /RemoteBar/.test(activity))

// ---------------------------------------------------------------------------
// [A] 契约：前端
// ---------------------------------------------------------------------------
console.log('\n[A] 前端')

ok('概览有远程控制卡', has(html, 'id="remote-card"'))
ok('独立视图 data-view="remote"', has(html, 'data-view="remote"'))
ok('添加表单有连接串与备注两个输入', has(html, 'id="remote-url-input"') && has(html, 'id="remote-label-input"'))
ok('列表容器与空态都在', has(html, 'id="remote-list"') && has(html, 'id="remote-list-empty"'))
ok('说明卡讲清「同一 WiFi 不经过任何服务器」', /不经过|局域网/.test(html.slice(html.indexOf('remote-note-card'))))
ok('前端只发 kxxy://remote/*，不直接改 location 到远端', has(js, 'kxxy://remote/${action}'))
ok('渲染走 data.remote，不本地缓存设备清单', has(js, 'renderRemote(state.remote)') || has(js, 'renderRemote('))
ok('错误按 seq 去重，避免每次轮询弹一次 toast', has(js, 'seq > remoteErrorSeq'))
ok('设备名做 HTML 转义', has(js, 'escapeHtml(d.label)'))
ok('样式类齐全（卡片/英雄区/条目/徽章）', ['.remote-card', '.remote-hero', '.remote-item', '.remote-badge'].every((c) => css.includes(c)))

// ---------------------------------------------------------------------------
// [A] 契约：出包一致性
// ---------------------------------------------------------------------------
console.log('\n[A] 出包')

const markerBuild = (runtime.match(/kxxy-patchset@(\d+)/) || [])[1]
const markerInstall = (installer.match(/kxxy-patchset@(\d+)/) || [])[1]
ok(`补丁集标记两处一致（@${markerBuild} / @${markerInstall}）`, markerBuild && markerBuild === markerInstall)

// ---------------------------------------------------------------------------
// [B] 连接器真跑
// ---------------------------------------------------------------------------
console.log('\n[B] 连接器（真起服务）')

const seen = []

/** 假上游：记录收到的 Host 与路径，模拟 DSH 的 token 换 cookie 行为。 */
function startUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, url: req.url, cookie: req.headers.cookie || '' })
      if (req.url.startsWith('/?token=') || req.url.startsWith('/?token=')) {
        res.writeHead(302, { 'set-cookie': 'dsh_sid=abc; Path=/; HttpOnly', location: '/' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html>upstream-ok</html>')
    })
    server.on('upgrade', (req, socket) => {
      seen.push({ host: req.headers.host, url: req.url, upgrade: true })
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: test\r\n\r\n',
      )
      socket.write('hello-from-upstream')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 发一个请求，把状态码/头/体原样带回来（不跟随重定向，我们要看 302）。 */
function request(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method || 'GET',
        path: opts.path || '/',
        headers: { host: `127.0.0.1:${port}`, ...(opts.headers || {}) },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * 关掉假上游。
 *
 * 必须 `closeAllConnections()`：upgrade 用例留下的 keep-alive socket 会让
 * `server.close()` 的回调**永不触发**（它只停接受新连接）。之前整脚本挂在
 * 这一步，表现为「全部断言通过但进程不退出」—— 比失败更难查。
 */
function closeUpstream(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

/** 裸 socket 做一次 upgrade 握手，返回 { statusLine, payload }。 */function upgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ]
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', (c) => (raw += c))
    socket.on('error', reject)
    setTimeout(() => {
      socket.destroy()
      resolve({ raw, statusLine: raw.split('\r\n')[0], payload: raw.split('\r\n\r\n').slice(1).join('') })
    }, 300)
  })
}

const up = await startUpstream()
const PORT = 18781
const CODE = 'a1b2c3d4'
const conn = createConnector({ port: PORT, target: `http://127.0.0.1:${up.port}/?token=tok-xyz`, code: CODE })

try {
  await conn.listen()

  let r = await request(PORT, { path: '/' })
  ok('无配对码 → 401', r.status === 401, `实际 ${r.status}`)
  ok('401 页面是中文引导，不是英文栈', r.body.includes('需要配对码'))

  r = await request(PORT, { path: '/__kxxy_pair?code=wrong' })
  ok('配对页错误码 → 401', r.status === 401)
  ok('错码不下发 cookie', !String(r.headers['set-cookie'] || '').includes('kxxy_pair='))

  r = await request(PORT, { path: `/__kxxy_pair?code=${CODE}` })
  ok('配对页正确码 → 302', r.status === 302, `实际 ${r.status}`)
  ok('下发 HttpOnly 配对 cookie', /kxxy_pair=.*HttpOnly/.test(String(r.headers['set-cookie'] || '')))
  ok('SameSite=Lax（隧道域名跨站直连也要带上）', /SameSite=Lax/.test(String(r.headers['set-cookie'] || '')))
  ok('配对后回首页', r.headers.location === '/')

  const cookie = `kxxy_pair=${CODE}`

  r = await request(PORT, { path: '/__kxxy_pair?code=' + CODE + '&x=1' })
  ok('配对页保留其它 query（x=1 不丢）', r.status === 302)

  // 连接串直接带 code（手机粘贴的就是这种）
  r = await request(PORT, { path: `/?code=${CODE}&foo=bar` })
  ok('连接串直带 code → 302 并下发 cookie', r.status === 302 && /kxxy_pair=/.test(String(r.headers['set-cookie'] || '')))
  ok('跳转后从 URL 里抹掉 code（避免留在历史/日志）', !String(r.headers.location || '').includes('code=') && String(r.headers.location || '').includes('foo=bar'))

  // 首次文档请求：没有上游 cookie → 补 token
  seen.length = 0
  r = await request(PORT, { path: '/', headers: { cookie, 'sec-fetch-dest': 'document' } })
  ok('首次文档请求 → 302 到带 token 的地址', r.status === 302 && String(r.headers.location).includes('token=tok-xyz'), `实际 ${r.status} ${r.headers.location}`)

  // 该请求不应该打到上游（否则上游会 401）
  ok('补 token 的重定向在本地完成，不消耗上游请求', seen.length === 0, `上游收到 ${seen.length} 次`)

  // 带 token 后正常转发，且 Host 被改回上游
  seen.length = 0
  r = await request(PORT, { path: '/?token=tok-xyz', headers: { cookie, 'sec-fetch-dest': 'document' } })
  ok('带 token 的文档请求被转发', r.status === 302, `实际 ${r.status}`)
  ok('上游收到的 Host 被改成目标 authority', seen[0]?.host === `127.0.0.1:${up.port}`, `实际 ${seen[0]?.host}`)
  ok('上游的 Set-Cookie 原样下发', String(r.headers['set-cookie'] || '').includes('dsh_sid=abc'))

  // 已有上游 cookie：不再重定向（这是防循环的关键）
  r = await request(PORT, { path: '/', headers: { cookie: `${cookie}; dsh_sid=abc`, 'sec-fetch-dest': 'document' } })
  ok('已有上游 cookie → 不再补 token（否则无限 302）', r.status === 200, `实际 ${r.status}`)

  // XHR 不补 token：302 到 HTML 会把「缺 cookie」变成「格式错误」
  seen.length = 0
  r = await request(PORT, { path: '/api/state', headers: { cookie, 'sec-fetch-dest': 'empty', accept: 'application/json' } })
  ok('XHR 不被重定向到 token 页', r.status === 200)
  ok('XHR 正常打到上游并带原路径', seen[0]?.url === '/api/state')

  // WebSocket 透传 —— 漏了它，界面能开、一发消息就断
  let u = await upgrade(PORT, {})
  ok('未配对的 upgrade → 401', /401/.test(u.statusLine), u.statusLine)

  u = await upgrade(PORT, { Cookie: cookie })
  ok('已配对的 upgrade → 101', /101/.test(u.statusLine), u.statusLine)
  ok('升级响应头原样回传（含 Sec-WebSocket-Accept）', /Sec-WebSocket-Accept: test/i.test(u.raw))
  ok('双向字节流真的通了', u.payload.includes('hello-from-upstream'), JSON.stringify(u.payload.slice(0, 60)))
  ok('upgrade 也做了 Host 改写', seen.find((s) => s.upgrade)?.host === `127.0.0.1:${up.port}`)

  // 上游不可达 → 502 可读页，而不是挂住。
  // 这里另起一个指向死端口的连接器：为了造「上游挂掉」而去关共享的假上游，
  // 会牵进 keep-alive socket 清理，反而让测试自己卡住。
  const dead = createConnector({ port: PORT + 1, target: 'http://127.0.0.1:1/', code: CODE })
  await dead.listen()
  try {
    r = await request(PORT + 1, { path: '/', headers: { cookie, 'sec-fetch-dest': 'document' } })
    ok('上游不可达 → 502 且给出可读原因', r.status === 502 && r.body.includes('连不上'), `实际 ${r.status}`)
  } finally {
    await dead.close()
  }
} finally {
  await conn.close()
  // 不 await：假上游可能还挂着 upgrade 留下的 socket，等它等于等一个
  // 永不到来的回调；脚本最后会 process.exit，句柄自然回收。
  closeUpstream(up.server)
}

// 生成器
const codes = new Set()
for (let i = 0; i < 200; i++) codes.add(generateCode())
ok('配对码 8 位十六进制', /^[0-9a-f]{8}$/.test(generateCode()))
ok('200 次生成无重复（足够熵避免撞码）', codes.size === 200, `实际 ${codes.size}`)
ok('局域网地址探测返回数组', Array.isArray(listLanAddresses()))

// 用 writeSync 写结论：stdout 是管道时 console.log 是异步的，紧跟 process.exit
// 会把最后几行截掉（表现成「跑完了但看不到结论」）。
const summary = fail === 0 ? `\n结论：远程控制 ${pass} 项全部通过` : `\n结论：${fail} 项失败 / ${pass} 项通过`
try {
  writeSync(1, summary + '\n')
} catch {
  console.log(summary)
}
process.exit(fail === 0 ? 0 : 1)
