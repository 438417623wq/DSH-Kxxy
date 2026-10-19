/**
 * kxxy-host 插件冒烟测试。
 *
 * 目的：`simulate-install.mjs` 只证明**文件被正确铺到设备上**，不证明
 * 「插件被 DSH 加载后真的能把 /kxxy 挂起来」。本脚本用官方 `WebServer`
 * 的路由契约（exact map + prefix map，最长前缀优先）起一个真实 HTTP
 * 服务器，把插件的 `apply(ctx)` 跑一遍，然后打真实请求验证四个端点。
 *
 * 刻意**不**引入 cordis —— 插件只用到 ctx 的三样东西：
 *   ctx.get('authorization')  → 信任判定（缺失时应退化为回环判定）
 *   ctx.webServer.register()  → 路由注册
 *   ctx.logger.info()         → 日志
 * 这三样都在这里以最小实现替代，从而可以在没有 DSH 进程的情况下验证插件。
 *
 * 用法：node tools/smoke-plugin.mjs [--no-auth]
 */

import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openZip } from './lib/zipread.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', 'plugins', 'kxxy-host', 'lib', 'index.js')

// 插件的所有动作通道都挂在 KXXY_ENGINE_ROOT 下（restart.request /
// stdin.request / export/ / extensions/）。冒测试给它一个临时目录，
// 动作之后逐个验证文件真的落盘 —— 「动作真做」是这个断言的核心。
const FAKE_ENGINE_ROOT = mkdtempSync(join(tmpdir(), 'kxxy-smoke-'))
process.env.KXXY_ENGINE_ROOT = FAKE_ENGINE_ROOT
delete process.env.KXXY_STATE_FILE

const useAuth = !process.argv.includes('--no-auth')

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const fail = (m) => {
  failures += 1
  console.log(`  ✗ ${m}`)
}

// ── 复刻官方 WebServer 的路由表语义 ────────────────────────────────
const exact = new Map()
const prefixes = new Map()

const webServer = {
  register(route) {
    const key = route.kind === 'exact' ? route.path : route.path
    const table = route.kind === 'exact' ? exact : prefixes
    if (table.has(key)) throw new Error(`duplicate ${route.kind} route: ${key}`)
    table.set(key, route.handler)
    return () => table.delete(key)
  },
  registerUpgrade() {
    throw new Error('kxxy-host 不应注册 upgrade 路由')
  },
  registerFallback() {
    throw new Error('kxxy-host 不应注册 fallback')
  },
  /**
   * index 注入走 tapIndex（官方 WebServer 公开扩展点，见
   * dsh-host-webserver `:220 tapIndex` / `:339 applyIndexTaps`）。
   * 这里按官方语义登记 transform，并返回注销函数。
   *
   * 当前只有一个 tap：兼容层（injectCompat，内含 compat.js 与 modern.js）。
   * 自研移动端适配层的注入 tap 已随 AdaptLayer 一起移除。
   */
  tapIndex(transform) {
    if (typeof transform !== 'function') throw new Error('tapIndex 需要函数')
    indexTaps.push(transform)
    return () => {
      const at = indexTaps.indexOf(transform)
      if (at >= 0) indexTaps.splice(at, 1)
    }
  },
}

const indexTaps = []

// 信任判定：模拟官方 authorization 服务（存在时用它，缺失时插件应退化）
const authorization = useAuth
  ? {
      isTrustedRequest(req) {
        const host = String(req.headers?.host ?? '')
        const okHost = host.startsWith('127.0.0.1:') || host.startsWith('localhost:')
        const site = String(req.headers?.['sec-fetch-site'] ?? '')
        return okHost && site !== 'cross-site'
      },
    }
  : undefined

const logs = []
const ctx = {
  get: (name) => (name === 'authorization' ? authorization : undefined),
  webServer,
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
  /**
   * cordis 的 ctx.effect：执行回调并把返回的 disposer 登记进当前作用域。
   * 插件用它包住 apply 的主体，因此 harness 必须提供 —— 缺了就是
   * `TypeError: ctx.effect is not a function`。
   */
  effect(fn) {
    const d = fn()
    effects.push(d)
    return d
  },
}
const effects = []

// ── 加载并应用插件 ────────────────────────────────────────────────
console.log(`kxxy-host 插件：${PLUGIN}`);
const mod = await import(pathToFileURL(PLUGIN).href)
if (mod.name !== 'kxxy-host') fail(`插件 name 应为 kxxy-host，实为 ${mod.name}`)
else ok(`name = ${mod.name}`)
if (!Array.isArray(mod.inject) || !mod.inject.includes('webServer')) fail('inject 未声明 webServer')
else ok(`inject = [${mod.inject.join(', ')}]`)
if (typeof mod.apply !== 'function') {
  fail('未导出 apply(ctx)')
  process.exit(1)
}

const returned = mod.apply(ctx)
ok('apply(ctx) 已执行')
// 插件的 apply 不直接返回 disposer，而是用 ctx.effect(fn) 登记到当前作用域
// （cordis 的约定）。所以这里断言的是 effect 里产出的 disposer。
if (typeof returned === 'function') ok('apply 直接返回 disposer')
else if (effects.length === 1 && typeof effects[0] === 'function') ok('disposer 经 ctx.effect 登记')
else fail(`未取得 disposer（apply 返回 ${typeof returned}，effects ${effects.length}）`)
const dispose = typeof returned === 'function' ? returned : effects[0]

console.log(`  注册路由：exact [${[...exact.keys()].join(', ')}]，prefix [${[...prefixes.keys()].join(', ')}]`)
if (!exact.has('/kxxy')) fail('未注册 /kxxy 精确路由')
if (!exact.has('/kxxy/')) fail('未注册 /kxxy/ 精确路由（地址栏手输尾斜杠会 404）')
if (!prefixes.has('/kxxy/api')) fail('未注册 /kxxy/api 前缀路由')
if (!prefixes.has('/kxxy/assets')) fail('未注册 /kxxy/assets 前缀路由')
// 前缀**不能**带尾斜杠：官方 match() 用 `pathname === prefix || pathname.startsWith(`${prefix}/`)`，
// 带尾斜杠会拼出双斜杠而永不匹配（真实踩过：/kxxy 200 但 /kxxy/api/* 全 404）。
for (const p of prefixes.keys()) {
  if (p.endsWith('/')) fail(`前缀路由 "${p}" 带尾斜杠，官方 match() 永不命中`)
}

// ── 兼容层注入（WebView 104 缺 AbortSignal.any / dvh 的兜底）──────────
// 这是真机事故的修复点，已证实两处致命：
//   1) 官方前端插件 bundle 用了 Chrome 116+ 的 AbortSignal.any，旧 WebView
//      上抛 TypeError 被连接层静默吞掉，表现为「权限页显示英文 key /
//      模型页 provider 列表空白」。
//   2) 插件 CSS 用了 Chrome 108+ 的 dvh 单位，旧 WebView 的 CSS 解析器把整条
//      height 声明丢弃，目录选择对话框塌成 0 高，列表整片空白。
console.log(`  index taps：${indexTaps.length}`)
// 只剩一个 tap：兼容层与它同 tap 注入的现代内建补齐层（同一函数产出两段
// <script>，见 lib/index.js 的 injectCompat）。自研移动端适配层已移除。
if (indexTaps.length !== 1) fail(`应恰好注册 1 个 index tap（兼容层 + 现代内建补齐层），实为 ${indexTaps.length}`)
else ok('已注册 index 兼容层 tap（含现代内建补齐层）')

if (indexTaps.length === 1) {
  const html = '<!doctype html><html><head><title>t</title>'
    + '<script type="module" src="./assets/index-abc.js"></script></head>'
    + '<body><div id="root"></div></body></html>'
  // 官方 applyIndexTaps 按注册顺序依次跑 transform，逐个累加。
  const out = indexTaps.reduce((acc, fn) => fn(acc), html)
  const atCompat = out.indexOf('data-kxxy-compat')
  const atEntry = out.indexOf('src="./assets/index-abc.js"')
  if (atCompat < 0) fail('index tap 未注入兼容层 script')
  else ok('index tap 注入了兼容层 script')
  if (atCompat > atEntry) fail('兼容层晚于入口 module（必须更早，否则 API 已缺失）')
  else ok(`兼容层早于入口 module（compat@${atCompat} entry@${atEntry}）`)
  if (!/<\/head>/i.test(out) || !out.includes('<div id="root"></div>')) fail('注入破坏了原 HTML')
  else ok('注入未破坏原 HTML')
  for (const need of ['AbortSignal.any', "defineArray('toSorted'", 'Promise.withResolvers']) {
    if (!out.includes(need)) fail(`兼容层缺少补丁：${need}`)
  }
  if (out.includes('AbortSignal.any') && out.includes("defineArray('toSorted'") && out.includes('Promise.withResolvers')) {
    ok('兼容层含 AbortSignal.any / toSorted / withResolvers 三项关键补丁')
  }
  // dvh 回退：必须是「文本层面替换 + MutationObserver 观察后续插入」，
  // 因为插件 CSS 是各插件模块求值时才 append 的，晚于本脚本执行。
  // 替换规则有两处收紧（只认「数字紧跟 dvh 且后接非字母数字」、url() 整段
  // 保留），避免误伤 base64 数据，断言必须跟着实现走。
  for (const need of ['var patchCssText', 'url\\([^)]*\\)|(\\d)dvh(?!', 'MutationObserver', 'observeStyles()']) {
    if (!out.includes(need)) fail(`兼容层缺少 dvh 回退实现：${need}`)
  }
  ok('兼容层含 dvh→vh 回退（文本替换 + MutationObserver 观察后续插入）')
  // URL 非特殊协议修正：必须「探测式触发 + 只包 getter + 排除特殊协议」。
  // 三者缺一都会出事：没有探测会让已支持的环境也被改写；动了 setter 会
  // 改变写语义；不排除 file: 之类会把 `file:////x` 这种本来正确的地址改坏。
  for (const need of [
    "new URL('x-dsh-probe://host/p').hostname !== 'host'",
    'var splitFoldedAuthority',
    'var foldedAuthorityOf',
    'var wrapUrlGetter',
    'SPECIAL_SCHEMES',
    "wrapUrlGetter(nativeHostname, 'hostname'",
    "wrapUrlGetter(nativeHost, 'host'",
    "wrapUrlGetter(nativePathname, 'pathname'",
  ]) {
    if (!out.includes(need)) fail(`兼容层缺少 URL 修正实现：${need}`)
  }
  ok('兼容层含 URL 非特殊协议 authority 修正（探测式 + 只包 getter + 特殊协议守卫）')
  // getter 必须原样保留 setter，否则 URL 实例的写语义被改变。
  const urlWrapper = /var wrapUrlGetter[\s\S]*?\n    \}/.exec(out)
  if (urlWrapper === null) fail('兼容层未定义 wrapUrlGetter')
  else if (!/set:\s*descriptor\.set/.test(urlWrapper[0])) fail('wrapUrlGetter 未保留原 setter')
  else ok('wrapUrlGetter 原样保留 setter（不改变写语义）')
  // 版本标记必须存在且与 RuntimeInstaller.COMPAT_LAYER_MARKER 一致，
  // 否则老设备升级后锚点 6 判不出过期，会带着旧兼容层跳过重装。
  const marker = /kxxy-webview-compat@(\d+)/.exec(out)
  if (marker === null) fail('兼容层缺少版本标记 kxxy-webview-compat@N')
  else {
    const kotlin = readFileSync(join(HERE, '..', 'android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt'), 'utf8')
    const kotlinMarker = /COMPAT_LAYER_MARKER\s*=\s*"([^"]+)"/.exec(kotlin)
    if (kotlinMarker === null) fail('RuntimeInstaller.kt 未定义 COMPAT_LAYER_MARKER')
    else if (kotlinMarker[1] !== marker[0]) fail(`版本标记不一致：compat.js=${marker[0]} RuntimeInstaller=${kotlinMarker[1]}`)
    else ok(`版本标记一致（${marker[0]}，compat.js 与 RuntimeInstaller 同步）`)
  }
  // 官方 renderIndex 每次请求都重新读 dist/index.html 再跑 taps，
  // 所以每次输入都是干净的 HTML，无需幂等；这里只确认单次调用只注入一份。
  if (out.split('data-kxxy-compat').length - 1 !== 1) fail('单次 tap 注入了多份兼容层')
  else ok('单次 tap 只注入一份')

  // ── 现代内建补齐层（锚点 6 的第二份资产）──────────────────────────
  // 与 compat.js 分开成独立资产的原因见 RuntimeInstaller.MODERN_LAYER_MARKER：
  // 它多了一层「blob 作用域注入」——包装 URL.createObjectURL，把同一份
  // polyfill 前置到 text/javascript 的 blob 与 text/html 的 blob 文档里。
  // 真机事故：PDF 渲染 worker 与 HTML 预览 iframe 都跑在 blob: 的独立全局，
  // `<head>` 注入够不到，表现为「PDF 渲染进程无法继续」与 HTML 整片空白。
  const atModern = out.indexOf('data-kxxy-modern')
  if (atModern < 0) fail('index tap 未注入现代内建补齐层 script')
  else ok('index tap 注入了现代内建补齐层 script')
  if (atModern < atCompat) fail('现代内建补齐层早于兼容层（应在兼容层之后）')
  else ok(`注入顺序正确（compat@${atCompat} modern@${atModern}）`)
  if (atModern > atEntry) fail('现代内建补齐层晚于入口 module（必须更早）')
  else ok('现代内建补齐层早于入口 module')
  // 三个关键内建：Iterator（PDF worker 里 Iterator.prototype.join 的报错源）、
  // Map.prototype.getOrInsertComputed（pdf.js 6.3 高频使用，104 完全没有）、
  // 以及 blob 注入本身。
  for (const need of [
    "'Iterator'",
    'getOrInsertComputed',
    'patchedBlob',
    'nativeCreateObjectURL',
    "base === 'text/html'",
    'INSTALL_SOURCE',
    "<!doctype html><meta charset=\"utf-8\"><script>",
  ]) {
    if (!out.includes(need)) fail(`现代内建补齐层缺少实现：${need}`)
  }
  ok('现代内建补齐层含 Iterator / getOrInsertComputed / blob 作用域注入')
  // 前置到 blob 的必须是「可独立执行的源码字符串」，且不得含 `</script`
  // （HTML blob 会被包进 <script>，裸 `</script` 会提前闭合标签）。
  const installSource = /var INSTALL_SOURCE = ([\s\S]*?)\n/.exec(out)
  if (installSource === null) fail('现代内建补齐层未定义 INSTALL_SOURCE')
  else if (/<\/script/i.test(installSource[1])) fail('INSTALL_SOURCE 含裸 </script，会提前闭合 HTML blob 的 script 标签')
  else ok('INSTALL_SOURCE 已转义 </script')
  // HTML blob 必须自带 doctype：原文档的 `<!doctype html>` 被顶到第二位会被
  // 解析器忽略，文档掉进 quirks 模式，预览排版与桌面端不一致。
  if (!out.includes("'<!doctype html><meta charset=\"utf-8\"><script>'")) {
    fail('HTML blob 注入未自带 doctype（会掉进 quirks 模式）')
  } else ok('HTML blob 注入自带 doctype（避免 quirks 模式）')
  // 版本标记：与 RuntimeInstaller.MODERN_LAYER_MARKER 双向一致。
  const modernMarker = /kxxy-modern@(\d+)/.exec(out)
  if (modernMarker === null) fail('现代内建补齐层缺少版本标记 kxxy-modern@N')
  else {
    const kotlin = readFileSync(join(HERE, '..', 'android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt'), 'utf8')
    const kotlinModern = /MODERN_LAYER_MARKER\s*=\s*"([^"]+)"/.exec(kotlin)
    if (kotlinModern === null) fail('RuntimeInstaller.kt 未定义 MODERN_LAYER_MARKER')
    else if (kotlinModern[1] !== modernMarker[0]) fail(`版本标记不一致：modern.js=${modernMarker[0]} RuntimeInstaller=${kotlinModern[1]}`)
    else ok(`版本标记一致（${modernMarker[0]}，modern.js 与 RuntimeInstaller 同步）`)
  }
  if (out.split('data-kxxy-modern').length - 1 !== 1) fail('单次 tap 注入了多份现代内建补齐层')
  else ok('现代内建补齐层单次 tap 只注入一份')

  // ── 移动端适配：已交给内置的第三方插件 dsh-web-mobile ──────────────
  // 自研的 mobile.css / mobile.js 注入（以及安卓侧的 AdaptLayer）已全部移除，
  // 恢复官方原本 UI。窄屏适配由随 runtime 打包的 dsh-web-mobile 客户端半区
  // 承担，它走标准客户端插件通道（package.json 的 dsh.client 声明 + Loader
  // entry），不经过本插件的 index tap —— 这里没有可断言的注入产物。
  // 该插件是否真的进了 zip、是否注册进了 installation scope，由
  // verify-runtime.mjs 的「内置移动端插件」检查段负责。
}

// ── 真实 HTTP 分发 ────────────────────────────────────────────────
const server = createServer((req, res) => {
  const path = String(req.url ?? '/').split('?')[0]
  const h = exact.get(path)
  if (h) return void run(h, req, res)
  // 最长前缀优先（官方实现即如此，避免 /a 抢走 /a/b 的请求）
  let best = null
  for (const [p, handler] of prefixes) {
    // 与官方 WebServer.match() 逐字一致：等值或「前缀 + 斜杠」开头
    if (path !== p && !path.startsWith(`${p}/`)) continue
    if (best === null || p.length > best[0].length) best = [p, handler]
  }
  if (best) return void run(best[1], req, res)
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

/**
 * 调 handler 并把异常暴露成断言失败。
 *
 * 不这样做的话，handler 里的异常会变成未处理的 Promise 拒绝 —— 连接被
 * 直接断开，客户端只看到 `fetch failed / ECONNRESET`，完全看不出是哪条
 * 路由、什么原因。冒烟测试的价值就在「失败时能立刻定位」，所以这里必须
 * 兜住并打印。
 */
function run(handler, req, res) {
  if (process.env.SMOKE_TRACE) console.log(`  · REQ ${req.method} ${req.url}`)
  const onError = (e) => {
    fail(`handler 抛异常：${String(req.url)} → ${e?.stack ?? e?.message ?? e}`)
    if (!res.headersSent) {
      res.writeHead(500)
      res.end('handler error')
    } else {
      res.destroy()
    }
  }
  // 客户端侧的 ECONNRESET 完全看不出是哪条路由断的 —— 连接被销毁时
  // 请求已经发出去了，错误只落在 fetch 那一侧。所以在服务端留一条
  // 兜底：socket 在响应结束前就关掉，直接报出来。
  res.on('close', () => {
    if (!res.writableEnded) fail(`响应未完成就关闭：${String(req.url)}（handler 提前销毁了连接）`)
  })
  try {
    const r = handler(req, res)
    if (r && typeof r.catch === 'function') r.catch(onError)
  } catch (e) {
    onError(e)
  }
}

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
console.log(`  测试服务器：${base}\n`)

async function get(path, headers = {}) {
  // 网络层失败**不能**让整个冒烟脚本崩掉：那会把「一条断言失败」变成
  // 「后面所有断言一条都没跑」，而且输出缓冲在崩溃时可能丢失，连是哪条
  // 路由断的都看不出来。返回 status 0 + 错误文本，让它变成一条正常的 ✗。
  //
  // `connection: close`：媒体用例里有几处 `res.destroy()`（流错误、客户端
  // 提前断开），undici 的连接池仍可能把那条半死的 socket 留在池里复用，
  // 下一条请求就报 ECONNRESET —— 实测正是 /api/health 的第一条断言。
  // 冒烟测试要的是确定性，不是压测连接复用，所以每条请求都新开连接。
  try {
    const res = await fetch(base + path, {
      headers: { connection: 'close', ...headers },
    })
    const text = await res.text()
    return { status: res.status, type: res.headers.get('content-type'), text }
  } catch (e) {
    return { status: 0, type: null, text: `fetch failed: ${e?.cause?.code ?? e?.message ?? e}` }
  }
}

/**
 * 裸 HTTP 请求。
 *
 * 必须用它来伪造 `Host` —— Node 的 fetch（undici）把 `Host` 视为
 * forbidden header name 并**静默剥掉**，于是「非回环 Host 应被拒」这条
 * 断言会永远拿到 200（请求实际带着真实回环 Host 发出），
 * 变成一条假绿/假红。node:http 不做这层过滤。
 */
function raw(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: server.address().port, path, method, headers },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

console.log('[1] GET /kxxy（宿主管理页）')
{
  const r = await get('/kxxy')
  if (r.status !== 200) fail(`状态码 ${r.status}`)
  else if (!r.type?.includes('text/html')) fail(`content-type = ${r.type}`)
  else if (!r.text.includes('<html')) fail('正文不是 HTML')
  else ok(`200 text/html，${r.text.length} 字节`)
  if (r.text.includes('org.dsh.kxxy')) fail('页面仍含旧包名 org.dsh.kxxy')
  else ok('页面无旧包名残留')

  // 管理页的每个 src/href 都必须能真的取到 —— 页面 URL 是 /kxxy（无尾斜杠），
  // 相对路径会被浏览器解析到站点根（/host.css）而落到官方前端的 fallback 上。
  // 这个缺陷真实发生过：/kxxy 返回 200 但页面无样式无交互，且 HTTP 层看不出异常。
  //
  // 分两类处理，**不能一律 GET**：
  //   · 资源引用（src=、<link href=>）—— 必须由本插件提供，逐个真实 GET 要求 200
  //   · 导航链接（<a href=>）—— 指向官方前端（如 "/"），那是 dsh-host-frontend-static
  //     的 fallback，本插件的 harness 里没有，GET 必然 404。只校验它是绝对路径即可
  //     （相对路径同样会被解析到站点根而失效）。
  const assetRefs = [
    ...[...r.text.matchAll(/src="([^"]+)"/g)].map((m) => m[1]),
    ...[...r.text.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]),
  ].filter((u) => !/^(?:https?:)?\/\//.test(u) && !u.startsWith('data:'))
  const navRefs = [...r.text.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(?:https?:)?\/\//.test(u) && !u.startsWith('data:') && !u.startsWith('#'))

  if (assetRefs.length === 0) fail('管理页没有任何本地资源引用（预期至少有 host.css / host.js）')
  for (const ref of assetRefs) {
    if (!ref.startsWith('/')) {
      fail(`资源引用 "${ref}" 是相对路径；/kxxy 无尾斜杠，浏览器会解析到站点根`)
      continue
    }
    const a = await get(ref)
    if (a.status !== 200) fail(`资源 ${ref} 取不到（${a.status}）`)
    else ok(`资源可解析：${ref}（${a.status}，${a.text.length} 字节）`)
  }
  for (const ref of navRefs) {
    if (!ref.startsWith('/')) {
      fail(`导航链接 "${ref}" 是相对路径；/kxxy 无尾斜杠，浏览器会解析到站点根`)
    } else {
      ok(`导航链接是绝对路径：${ref}（由官方前端提供，不在本插件路由内）`)
    }
  }

  // ── 底部页签数必须与视图数一致 ──────────────────────────────────────
  // 删掉「终端」视图时漏改了一处：`.tabbar-inner` 写死 `repeat(4, 1fr)`，
  // 只剩三个页签后第四列空着，底栏右侧多出一块很显眼的空白。这不是报错，
  // 只能靠肉眼发现，所以在这里钉死「页签 ↔ 视图」一一对应。
  const tabTargets = [...r.text.matchAll(/class="tab-item[^"]*"\s+data-target="([^"]+)"/g)].map((m) => m[1])
  const viewNames = [...r.text.matchAll(/class="view-pane[^"]*"\s+data-view="([^"]+)"/g)].map((m) => m[1])
  if (tabTargets.length === 0 || viewNames.length === 0) {
    fail('解析不出页签或视图（index.html 的 class/data-* 写法变了？）')
  } else if (tabTargets.length !== viewNames.length) {
    fail(`底部页签 ${tabTargets.length} 个，视图 ${viewNames.length} 个，数量不一致`)
  } else {
    const missing = tabTargets.filter((t) => !viewNames.includes(t))
    if (missing.length > 0) fail(`页签指向不存在的视图：${missing.join(', ')}`)
    else ok(`底部页签与视图一一对应（${tabTargets.length} 个：${tabTargets.join(' / ')}）`)
  }

  // ── 「关于」入口卡与弹窗必须成对存在 ────────────────────────────────
  // 设置页的「关于」卡是纯前端：点击 → 弹窗 data-open="true"。
  // 三处（入口卡 / 弹窗根 / 关闭按钮）任缺一个，表现都是「点了没反应」，
  // 不报错、HTTP 层也看不出异常。
  for (const id of ['about-entry', 'about-dialog', 'btn-about-close', 'btn-about-dismiss']) {
    if (!r.text.includes(`id="${id}"`)) fail(`index.html 缺少 #${id}（关于卡/弹窗不完整）`)
  }
  // 弹窗里必须还有 Node 版本节点：它由 fetchState 实时写入，
  // 移进弹窗后若 id 丢了，「宿主环境参数」就变成永远不会更新的静态文案。
  if (!r.text.includes('id="info-node-ver"')) {
    fail('index.html 缺少 #info-node-ver（移入弹窗后 Node 版本不再刷新）')
  }
  // 镜像源 UI 已按需求整体移除
  if (/id="(?:current-mirror-name|mirror-sub|mirror-results|btn-switch-mirror)"/.test(r.text)) {
    fail('index.html 仍有镜像源卡片 DOM（该板块已要求移除）')
  }
  if (!/关于[\s\S]{0,200}开心小元/.test(r.text)) {
    fail('关于卡里找不到作者署名「开心小元」')
  }
  ok('关于入口卡 + 弹窗 + 作者署名齐备，镜像源 UI 已移除')
}

console.log('\n[2] GET /kxxy/assets/host.css')
{
  const r = await get('/kxxy/assets/host.css')
  if (r.status !== 200) fail(`状态码 ${r.status}`)
  else if (!r.type?.includes('text/css')) fail(`content-type = ${r.type}`)
  else {
    ok(`200 ${r.type}，${r.text.length} 字节`)

    // ── 已删除的「终端」视图不得复活 ──────────────────────────────────
    // 控制台原来有个 data-view="terminal" 的页签，实际只是 engine.log 的
    // 尾巴查看器（外加六个写 PTY 的 term-key 按钮），用户判定无用、要求
    // 整块去除。这里守住三处：视图段、页签按钮、以及那一整段终端专属样式。
    // 留着它们的表现不是报错，而是「页签点进去一片空白」。
    const css = r.text
    if (css.includes('.terminal-container') || css.includes('.terminal-viewport')) {
      fail('host.css 仍有终端视图样式（视图已删除）')
    } else ok('终端视图样式已随视图一并删除')

    // ── 已移除的「插件下载源」卡片不得复活 ────────────────────────────
    // 该卡片最初放在「扩展」页（与「全部内置」矛盾），v0.2.0 移到设置页，
    // 用户随后要求整体移除。宿主后端 /kxxy/api/mirror* 仍在（镜像源本身是
    // 对话页「+ 添加插件」在用的），这里只要求控制台不再暴露 UI。
    if (/\.mirror-(?:card|row|results|icon|title|sub|ms|left|info)\b/.test(css)) {
      fail('host.css 仍有镜像源卡片样式（UI 已移除）')
    } else ok('镜像源卡片样式已随 UI 一并移除')

    // ── 底栏列数不得写死 ──────────────────────────────────────────────
    // 同一次删除留下的另一半问题：`.tabbar-inner` 原写 `repeat(4, 1fr)`，
    // 页签从四个变三个后第四列空着。改成 grid-auto-flow 由子元素个数决定。
    const tabbarBlock = css.match(/\.tabbar-inner\s*\{[^}]*\}/)
    if (!tabbarBlock) {
      fail('host.css 找不到 .tabbar-inner 规则')
    } else if (/grid-template-columns\s*:\s*repeat\(\s*\d+/.test(tabbarBlock[0])) {
      fail('.tabbar-inner 又写死了列数；增删页签会留下空列')
    } else if (!/grid-auto-flow\s*:\s*column/.test(tabbarBlock[0])) {
      fail('.tabbar-inner 未使用 grid-auto-flow，列数不随页签个数自适应')
    } else ok('底栏列数由页签个数决定（未写死）')

    // ── 扩展分组展开态必须跨轮询存活 ─────────────────────────────────
    // fetchExtensions() 每 5 秒被 startPolling 调用一次，而 renderExtensions
    // 每次都把 innerHTML 清空重建。展开态若只存在 DOM 的 class 上，用户点开
    // 「已激活」后最多 5 秒就被折叠回去——正是用户报的「我展开它又自动折叠」。
    // 修法是把状态提到模块级 Set（expandedGroups），这里断言两边都在。
    const hostJs = (await get('/kxxy/assets/host.js')).text
    if (!/const expandedGroups = new Set\(\)/.test(hostJs)) {
      fail('host.js 缺少 expandedGroups —— 扩展分组的展开态会被 5 秒轮询重置')
    } else if (!/expandedGroups\.add\(group\.key\)/.test(hostJs)
      || !/expandedGroups\.delete\(group\.key\)/.test(hostJs)) {
      fail('expandedGroups 未在点击处理里写入/清除，展开态仍不持久')
    } else if (!/if \(!expandedGroups\.has\(group\.key\)\) body\.classList\.add\('collapsed'\)/.test(hostJs)) {
      fail('renderExtensions 未按 expandedGroups 恢复折叠态，重建后仍会折回去')
    } else ok('扩展分组展开态由模块级 expandedGroups 记忆，跨轮询存活')
  }
}

console.log('\n[3] GET /kxxy/assets/host.js')
{
  const r = await get('/kxxy/assets/host.js')
  if (r.status !== 200) fail(`状态码 ${r.status}`)
  else {
    ok(`200 ${r.type}，${r.text.length} 字节`)

    // 关于弹窗的交互逻辑必须真绑上（不然入口卡只是个不能点的装饰）
    if (!/function initAboutDialog\(\)/.test(r.text)) {
      fail('host.js 缺少 initAboutDialog')
    } else if (!/dom\.aboutEntry\.addEventListener\('click', openAboutDialog\)/.test(r.text)) {
      fail('入口卡没绑 click，点了不会弹窗')
    } else if (!/dom\.aboutDialog\.setAttribute\('data-open', 'true'\)/.test(r.text)) {
      fail('openAboutDialog 没写 data-open')
    } else if (!/initAboutDialog\(\)/.test(r.text.replace(/function initAboutDialog\(\)/, ''))) {
      fail('init() 里没有调用 initAboutDialog，弹窗永远不会绑定')
    } else ok('关于弹窗交互已绑定（入口点击 / 关闭按钮 / 遮罩 / Esc）')

    // 页面报错过的老坑：删了 DOM 却留着 JS 引用，getElementById 返回 null
    // 后一旦被解引用就整段崩。这里断言镜像源的 JS 逻辑已随 UI 一起清掉。
    if (/function initMirrorActions|function fetchMirror|function renderMirrorResults|function applyMirror/.test(r.text)) {
      fail('host.js 仍残留镜像源逻辑（DOM 已删除，引用会是 null）')
    } else ok('镜像源 JS 逻辑已随 UI 一并移除')
  }
}

console.log('\n[4] GET /kxxy/assets/../lib/index.js（目录穿越应被白名单挡住）')
{
  const r = await get('/kxxy/assets/..%2F..%2Flib%2Findex.js')
  if (r.status === 200 && r.text.includes('kxxy-host')) fail('目录穿越读到了 lib/index.js')
  else ok(`已挡住（${r.status}）`)
}

console.log('\n[5] GET /kxxy/api/state（引擎 + 运行时状态）')
{
  const r = await get('/kxxy/api/state')
  if (r.status !== 200) fail(`状态码 ${r.status}`)
  else {
    let j
    try {
      j = JSON.parse(r.text)
    } catch (e) {
      fail(`不是合法 JSON：${e.message}`)
    }
    if (j) {
      if (!j.engine || !j.runtime) fail('缺 engine 或 runtime 字段')
      else ok('engine + runtime 齐备')
      const r2 = j.runtime ?? {}
      if (Array.isArray(r2.checks) && r2.checks.length) {
        ok(`runtime.checks ${r2.checks.length} 项：${r2.checks.map((c) => `${c.label}=${c.ok}`).join(', ')}`)
        if (process.platform === 'win32' && r2.checks.some((c) => c.path.startsWith('bin/') && !c.ok)) {
          // Windows 没有 POSIX 可执行位，statSync().mode 永远不含 0o111。
          // 所以「bin/* 不可执行」在 Windows 上是**宿主限制**而非产物缺陷；
          // 真机判定只能在 Android 上做（simulate-install 用 chmodSync 显式置位）。
          console.log('    · 注意：Windows 宿主无 POSIX 可执行位，bin/* 恒为 false，非产物缺陷')
        }
      } else fail('runtime.checks 为空')
      if (j.engine && 'pid' in j.engine) ok(`engine.pid = ${j.engine.pid}（无 KXXY_STATE_FILE 时为 null，属预期）`)
    }
  }
}

console.log('\n[6] GET /kxxy/api/extensions（扩展中心）')
{
  const r = await get('/kxxy/api/extensions')
  if (r.status !== 200) fail(`状态码 ${r.status}`)
  else {
    const j = JSON.parse(r.text)
    const n = Array.isArray(j) ? j.length : (j.plugins?.length ?? j.items?.length ?? -1)
    if (n < 0) fail(`结构不符：${Object.keys(j).join(',')}`)
    else ok(`返回 ${n} 项扩展`)
  }
}

console.log('\n[7] GET /kxxy/api/log（引擎日志尾部）')
{
  const r = await get('/kxxy/api/log')
  if (r.status !== 200) fail(`状态码 ${r.status}`)
  else ok(`200，tail ${JSON.parse(r.text).tail.length} 字符`)
}

console.log('\n[8] POST /kxxy/api/action（真分派表）')
{
  const res = await fetch(base + '/kxxy/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restart-engine' }),
  })
  const j = await res.json()
  if (res.status !== 200) fail(`restart-engine 应为 200，实为 ${res.status}（${JSON.stringify(j)}）`)
  else if (j.ok !== true || j.requested !== true) fail(`restart-engine 返回异常：${JSON.stringify(j)}`)
  else ok('200 ok + requested（§7-2 方案 A：写请求文件，原生层轮询消费）')

  const reqFile = join(FAKE_ENGINE_ROOT, 'restart.request')
  if (!existsSync(reqFile)) fail('restart.request 未落盘')
  else ok('restart.request 已写入引擎根目录')

  if (!logs.some((l) => l.includes('restart-engine'))) fail('未记录动作日志')
  else ok('动作已记入插件日志')
}

console.log('\n[8b] term-key：按键应写进 stdin.request')
{
  const res = await fetch(base + '/kxxy/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'term-key', key: 'ctrl-c' }),
  })
  const j = await res.json()
  if (res.status !== 200 || j.ok !== true) fail(`term-key 返回异常：${res.status} ${JSON.stringify(j)}`)
  else ok('200 ok')
  const f = join(FAKE_ENGINE_ROOT, 'stdin.request')
  if (!existsSync(f)) fail('stdin.request 未落盘')
  else if (readFileSync(f).toString('utf8') !== '\x03') fail('stdin.request 内容不是 0x03')
  else ok('stdin.request 内容为 Ctrl+C 字节')
}

console.log('\n[8c] export-logs：真打包 tar.gz（公共目录失败退回私有目录）')
{
  const res = await fetch(base + '/kxxy/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'export-logs' }),
  })
  const j = await res.json()
  // Windows 测试机上 /sdcard 不存在，应静默退回 engineRoot/export/
  if (res.status !== 200 || j.ok !== true) fail(`export-logs 失败：${res.status} ${JSON.stringify(j)}`)
  else if (!j.path || !existsSync(j.path)) fail(`导出文件不存在：${j.path}`)
  else if (j.location !== 'private') ok(`落盘位置 ${j.location}（Windows 无公共下载目录，符合预期）`)
  else ok(`tar.gz 已落盘：${j.path}（${readFileSync(j.path).length} 字节）`)
}

console.log('\n[8d] 已迁移与未知动作：明确报错而非假成功')
{
  const post = (body) => fetch(base + '/kxxy/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const r1 = await post({ action: 'install-ext', id: 'ffmpeg' })
  if (r1.status !== 400) fail(`install-ext 应 400（迁往专用端点），实为 ${r1.status}`)
  else ok('install-ext → 400 + 迁移指引')
  const r2 = await post({ action: 'switch-mirror' })
  if (r2.status !== 400) fail(`switch-mirror 应 400，实为 ${r2.status}`)
  else ok('switch-mirror → 400 + 迁移指引')
  const r3 = await post({ action: 'make-coffee' })
  if (r3.status !== 501) fail(`未知动作应 501，实为 ${r3.status}`)
  else ok('未知动作 → 501 not implemented')
}

console.log('\n[9] POST /kxxy/api/action 非法 JSON')
{
  const res = await fetch(base + '/kxxy/api/action', { method: 'POST', body: '{oops' })
  if (res.status !== 400) fail(`状态码应为 400，实为 ${res.status}`)
  else ok('400 invalid json')
}

console.log('\n[10] 未知端点 /kxxy/api/nope')
{
  const r = await get('/kxxy/api/nope')
  if (r.status !== 404) fail(`状态码应为 404，实为 ${r.status}`)
  else ok('404 unknown endpoint')
}

console.log('\n[11] 不可信来源（Host 非回环）应被拒')
{
  const r = await raw('/kxxy/api/state', { headers: { host: 'evil.example.com:3080' } })
  if (r.status !== 403) fail(`状态码应为 403，实为 ${r.status}`)
  else ok('403 forbidden')
  const r2 = await raw('/kxxy/api/state', { headers: { host: '192.168.1.9:3080' } })
  if (r2.status !== 403) fail(`局域网 Host 也应被拒，实为 ${r2.status}`)
  else ok('局域网 Host 亦被拒（403）')
}

console.log('\n[12] 跨站来源（sec-fetch-site: cross-site）应被拒')
{
  const r = await raw('/kxxy/api/state', {
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
  })
  if (r.status !== 403) fail(`状态码应为 403，实为 ${r.status}`)
  else ok('403 forbidden')
}

console.log('\n[12b] 可信回环来源应放行（对照组，证明上面拒的是来源而非路径）')
{
  const r = await raw('/kxxy/api/state', { headers: { host: '127.0.0.1:3080' } })
  if (r.status !== 200) fail(`状态码应为 200，实为 ${r.status}`)
  else ok('200（回环 Host 放行）')
}

console.log('\n[14] /kxxy/media（音视频流式路由）')
{
  // 为什么单独测这条路由：它是**唯一**能让 `<video>` 播起来的通道。上游
  // `/api/file` 有三处硬伤（20 MiB 图片附件上限、无 Range/206、全量进内存），
  // 而这三处都能在 HTTP 层用断言钉住 —— 一旦有人把路由改回「整文件回」，
  // 这里立刻红，不必等到真机上视频转圈才发现。
  const MEDIA_DIR = mkdtempSync(join(tmpdir(), 'kxxy-media-'))
  const mediaPath = join(MEDIA_DIR, 'clip.mp4')
  // 512 KiB 可辨识内容：足以验证分段偏移与长度，又不拖慢测试。
  const payload = Buffer.alloc(512 * 1024)
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251
  writeFileSync(mediaPath, payload)
  const q = `/kxxy/media?path=${encodeURIComponent(mediaPath)}`

  // ① 全量取：必须是 200 + 正确 MIME + Accept-Ranges + 字节完全一致。
  const full = await raw(q)
  if (full.status !== 200) fail(`全量请求应为 200，实为 ${full.status}`)
  else ok('200 全量')

  // 用 raw 拿 header（fetch 的 get() 只回 text）
  const headRes = await new Promise((resolve, reject) => {
    const r = httpRequest(
      { host: '127.0.0.1', port: server.address().port, path: q, method: 'GET' },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    r.on('error', reject)
    r.end()
  })
  if (headRes.headers['content-type'] !== 'video/mp4') {
    fail(`content-type 应为 video/mp4，实为 ${headRes.headers['content-type']}`)
  } else ok('content-type = video/mp4（不是 octet-stream，否则浏览器拒播）')
  if (headRes.headers['accept-ranges'] !== 'bytes') {
    fail(`缺 accept-ranges: bytes（实为 ${headRes.headers['accept-ranges']}）—— <video> 将无法 seek`)
  } else ok('accept-ranges: bytes（seek 的前提）')
  if (headRes.body.length !== payload.length) {
    fail(`全量长度应为 ${payload.length}，实为 ${headRes.body.length}`)
  } else if (!headRes.body.equals(payload)) fail('全量内容与源文件不一致')
  else ok(`全量 ${payload.length} 字节逐字节一致`)

  // ② Range 请求：必须 206 + content-range，且切片内容与源一致。
  const RANGE_FROM = 100000
  const RANGE_TO = 100255
  const part = await new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: q,
        method: 'GET',
        headers: { range: `bytes=${RANGE_FROM}-${RANGE_TO}` },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    r.on('error', reject)
    r.end()
  })
  if (part.status !== 206) fail(`Range 请求应为 206，实为 ${part.status}（无 206 则 <video> 不能 seek）`)
  else ok('206 Partial Content')
  const expectedRange = `bytes ${RANGE_FROM}-${RANGE_TO}/${payload.length}`
  if (part.headers['content-range'] !== expectedRange) {
    fail(`content-range 应为 "${expectedRange}"，实为 "${part.headers['content-range']}"`)
  } else ok(`content-range = ${expectedRange}`)
  if (part.body.length !== RANGE_TO - RANGE_FROM + 1) {
    fail(`Range 体长应为 ${RANGE_TO - RANGE_FROM + 1}，实为 ${part.body.length}`)
  } else if (!part.body.equals(payload.subarray(RANGE_FROM, RANGE_TO + 1))) {
    fail('Range 内容与源文件对应区间不一致（偏移算错了）')
  } else ok('Range 内容与源文件对应区间逐字节一致')

  // ③ 后缀形态 `bytes=-N`：浏览器探测容器尾部常用。
  const tailRes = await new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: q,
        method: 'GET',
        headers: { range: 'bytes=-16' },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    r.on('error', reject)
    r.end()
  })
  if (tailRes.status !== 206 || tailRes.body.length !== 16) {
    fail(`bytes=-16 应为 206 且 16 字节，实为 ${tailRes.status} / ${tailRes.body.length}`)
  } else if (!tailRes.body.equals(payload.subarray(payload.length - 16))) {
    fail('bytes=-16 取到的不是文件末尾 16 字节')
  } else ok('bytes=-16 取到文件末尾 16 字节')

  // ④ 越界 Range：必须 416 + `bytes */size`，而不是 200 全量或 500。
  const overRes = await new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: q,
        method: 'GET',
        headers: { range: `bytes=${payload.length + 10}-` },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
      },
    )
    r.on('error', reject)
    r.end()
  })
  if (overRes.status !== 416) fail(`越界 Range 应为 416，实为 ${overRes.status}`)
  else if (overRes.headers['content-range'] !== `bytes */${payload.length}`) {
    fail(`416 应带 content-range: bytes */${payload.length}`)
  } else ok('416 + content-range: bytes */<size>')

  // ⑤ HEAD：拿元数据但不回体（媒体栈探测第一步）。
  const headOnly = await new Promise((resolve, reject) => {
    const r = httpRequest(
      { host: '127.0.0.1', port: server.address().port, path: q, method: 'HEAD' },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, len: Buffer.concat(chunks).length }))
      },
    )
    r.on('error', reject)
    r.end()
  })
  if (headOnly.status !== 200) fail(`HEAD 应为 200，实为 ${headOnly.status}`)
  else if (headOnly.len !== 0) fail(`HEAD 不应回体，实回 ${headOnly.len} 字节`)
  else if (headOnly.headers['content-length'] !== String(payload.length)) {
    fail(`HEAD 的 content-length 应为 ${payload.length}，实为 ${headOnly.headers['content-length']}`)
  } else ok('HEAD 200 + content-length，零字节体')

  // ⑥ 安全边界：非绝对路径、目录、缺失文件、非 GET。
  const rel = await get('/kxxy/media?path=relative.mp4')
  if (rel.status !== 400) fail(`相对路径应 400，实为 ${rel.status}`)
  else ok('相对路径 → 400 absolute path required')

  const missing = await get(`/kxxy/media?path=${encodeURIComponent(join(MEDIA_DIR, 'nope.mp4'))}`)
  if (missing.status !== 404) fail(`缺失文件应 404，实为 ${missing.status}`)
  else ok('缺失文件 → 404')

  const dir = await get(`/kxxy/media?path=${encodeURIComponent(MEDIA_DIR)}`)
  if (dir.status !== 404) fail(`目录应 404，实为 ${dir.status}`)
  else ok('目录 → 404（不能列出目录）')

  const badMethod = await raw(q, { method: 'POST' })
  if (badMethod.status !== 405) fail(`POST 应 405，实为 ${badMethod.status}`)
  else ok('POST → 405 + allow 头')

  // ⑦ 也要走可信来源判定（媒体同样是「本机文件读取」，不能比 /kxxy/api 松）。
  const evilHost = await new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: q,
        method: 'GET',
        headers: { host: 'evil.example.com:3080' },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode }))
      },
    )
    r.on('error', reject)
    r.end()
  })
  if (evilHost.status !== 403) fail(`非回环 Host 应 403，实为 ${evilHost.status}`)
  else ok('非回环 Host → 403（与 /kxxy/api 同等严格）')
}

console.log('\n[14b] /kxxy/api/health（启动配置体检）')
{
  // 体检是**只读**的，但它依赖 DSH_HOME 指向真实的 profile 目录 ——
  // 这里造一个临时 home，逐项喂「好/坏」两种内容，断言判定与建议力度。
  //
  // 为什么值得单独测：这套判定是「一键修复」的唯一依据。判错了要么
  // 白改用户配置（假阳性），要么把真问题放过（假阴性）—— 两种都比
  // 不做体检更糟。而它全是纯函数式的文件解析，正好可以在 CI 里钉住。

  // ---- 夹具：把 FAKE_ENGINE_ROOT 补成一个「健康的引擎根」 ----------------
  //
  // 不补的话 RUNTIME / OVERLAY 两项永远 BAD，基线就永远不是全绿，后面
  // 每个断言都要为这两项写例外 —— 测试会变得没人敢改。
  //
  // 解析器必须真给：仓库里没有 node_modules，`require('js-yaml')` 在开发机
  // 上必然失败，所有 YAML 项会退化成 UNKNOWN，等于判定逻辑一行都没测到。
  // 所以从 runtime.zip 里把 js-yaml 解出来（体检模块会按 KXXY_ENGINE_ROOT
  // 找 lib/node_modules，正好命中）。
  {
    const engineRoot = FAKE_ENGINE_ROOT
    const nm = join(engineRoot, 'lib', 'node_modules')
    mkdirSync(join(engineRoot, 'bin'), { recursive: true })
    mkdirSync(join(nm, '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    mkdirSync(join(nm, 'kxxy-host'), { recursive: true })

    writeFileSync(join(engineRoot, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// fixture\n')
    writeFileSync(join(nm, 'kxxy-host', 'package.json'), '{"name":"kxxy-host"}\n')
    writeFileSync(join(engineRoot, 'android-overlay.yml'), '- id: sandbox-policy\n  config: {}\n')

    const zipPath = join(HERE, '..', 'android', 'app', 'src', 'main', 'assets', 'runtime.zip')
    if (!existsSync(zipPath)) {
      fail(`夹具缺失：${zipPath} 不存在，无法解出 js-yaml`)
    } else {
      const zip = openZip(zipPath)
      const prefix = 'lib/node_modules/js-yaml/'
      const files = zip.names().filter((n) => n.startsWith(prefix) && !n.endsWith('/'))
      let written = 0
      for (const name of files) {
        const rel = name.slice(prefix.length)
        const dest = join(nm, 'js-yaml', rel)
        mkdirSync(dirname(dest), { recursive: true })
        const data = zip.read(name)
        if (data) {
          writeFileSync(dest, data)
          written += 1
        }
      }
      if (written < 10) fail(`只解出 ${written} 个 js-yaml 文件，夹具不完整`)
      else ok(`夹具：从 runtime.zip 解出 js-yaml（${written} 个文件）`)
    }
  }

  const HOME_DIR = mkdtempSync(join(tmpdir(), 'kxxy-health-'))
  const profileDir = join(HOME_DIR, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = HOME_DIR

  try {
    // ① 全绿基线：合法的三层配置 + 核心三项 bundle。
    writeFileSync(join(profileDir, 'cordis.patch.yml'),
      '- id: ui-theme\n  config:\n    preference: light\n')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'dsh-web-mobile': '3.1.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-web-mobile'] } },
    }, null, 2))

    const good = await get('/kxxy/api/health')
    if (good.status !== 200) fail(`状态码 ${good.status}`)
    else {
      const j = JSON.parse(good.text)
      if (!Array.isArray(j.checks) || !j.checks.length) fail('checks 为空')
      else ok(`返回 ${j.checks.length} 项检查`)
      if (j.ok !== true) fail(`合法配置应判 ok=true，实为 ${j.ok}（${j.headline}）`)
      else ok('合法配置 → ok=true，无需修复')
      if (j.level !== 'NONE') fail(`无需修复时 level 应为 NONE，实为 ${j.level}`)
      else ok('level=NONE（不给修复按钮）')
      const bad = j.checks.filter((c) => c.verdict === 'BAD')
      if (bad.length) fail(`不应有 BAD 项：${bad.map((c) => `${c.code}:${c.detail}`).join(' | ')}`)
      else ok('无 BAD 项')
    }

    // ② 空补丁文件：官方 yaml.load('') → undefined → 非数组 → 启动终止。
    //    这是最容易被想反的一格（「空文件 = 没配置 = 没问题」），必须钉住。
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '   \n\n')
    {
      const j = JSON.parse((await get('/kxxy/api/health')).text)
      const c = j.checks.find((x) => x.code === 'PROFILE_PATCH')
      if (!c) fail('缺 PROFILE_PATCH 项')
      else if (c.verdict !== 'BAD') fail(`空补丁应判 BAD，实为 ${c.verdict}`)
      else ok('空补丁文件 → BAD（官方会判非数组）')
      if (j.level !== 'L1') fail(`配置坏应建议 L1，实为 ${j.level}`)
      else ok('建议力度 L1')
    }

    // ③ YAML 语法坏：引号未闭合（真机上抓到的原始故障形态）。
    writeFileSync(join(profileDir, 'cordis.patch.yml'), 'preference: "light\n')
    {
      const j = JSON.parse((await get('/kxxy/api/health')).text)
      const c = j.checks.find((x) => x.code === 'PROFILE_PATCH')
      if (c?.verdict !== 'BAD') fail(`坏 YAML 应判 BAD，实为 ${c?.verdict}`)
      else ok(`坏 YAML → BAD（${c.detail.slice(0, 60)}…）`)
    }

    // ④ 顶层不是数组：合法的 YAML，但官方要求数组。
    writeFileSync(join(profileDir, 'cordis.patch.yml'), 'id: ui-theme\nconfig: {}\n')
    {
      const j = JSON.parse((await get('/kxxy/api/health')).text)
      const c = j.checks.find((x) => x.code === 'PROFILE_PATCH')
      if (c?.verdict !== 'BAD') fail(`非数组应判 BAD，实为 ${c?.verdict}`)
      else ok('顶层非数组 → BAD')
    }

    // ⑤ 数组元素不是 mapping。
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- just-a-string\n')
    {
      const j = JSON.parse((await get('/kxxy/api/health')).text)
      const c = j.checks.find((x) => x.code === 'PROFILE_PATCH')
      if (c?.verdict !== 'BAD') fail(`非 mapping 条目应判 BAD，实为 ${c?.verdict}`)
      else ok('条目非 mapping → BAD')
    }

    // ⑥ 恢复成合法补丁，改坏 manifest：核心 bundle 被删掉。
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: ui-theme\n')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))
    {
      const j = JSON.parse((await get('/kxxy/api/health')).text)
      const c = j.checks.find((x) => x.code === 'MANIFEST')
      if (c?.verdict !== 'BAD') fail(`核心 bundle 缺失应判 BAD，实为 ${c?.verdict}`)
      else ok(`核心 bundle 缺失 → BAD（${c.detail}）`)
    }

    // ⑦ manifest 是坏 JSON：官方 readProfileManifest 直接抛错。
    writeFileSync(join(profileDir, 'package.json'), '{ "name": "x", ')
    {
      const j = JSON.parse((await get('/kxxy/api/health')).text)
      const c = j.checks.find((x) => x.code === 'MANIFEST')
      if (c?.verdict !== 'BAD') fail(`坏 JSON 应判 BAD，实为 ${c?.verdict}`)
      else ok('坏 JSON → BAD')
    }

    // ⑧ BOM：官方 JSON.parse 不剥 BOM，而原生侧剥了 —— 这个不一致正是
    //    缺陷 C 的土壤，必须判 BAD 才能让用户看到真实原因。
    writeFileSync(join(profileDir, 'package.json'),
      '\uFEFF' + JSON.stringify({ name: 'x', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-web-mobile'] } } }))
    {
      const j = JSON.parse((await get('/kxxy/api/health')).text)
      const c = j.checks.find((x) => x.code === 'MANIFEST')
      if (c?.verdict !== 'BAD') fail(`BOM 应判 BAD，实为 ${c?.verdict}`)
      else ok('带 BOM → BAD（官方 JSON.parse 会失败）')
    }

    // ⑨ home 级补丁：不存在是正常态，必须是 OK 而不是 BAD。
    {
      const j = JSON.parse((await get('/kxxy/api/health')).text)
      const c = j.checks.find((x) => x.code === 'HOME_PATCH')
      if (c?.verdict !== 'OK') fail(`缺失的 home 补丁应为 OK（跳过属正常），实为 ${c?.verdict}`)
      else ok('home 补丁不存在 → OK（正常跳过）')
    }

    // ⑩ 覆盖层缺失 → BAD（引擎能起来但沙箱/权限全失效，属隐性故障）。
    //    夹具里是**有** android-overlay.yml 的（否则基线不可能全绿），
    //    所以这一格必须真的把它删掉再断言 —— 不删就永远测不到这条。
    {
      rmSync(join(FAKE_ENGINE_ROOT, 'android-overlay.yml'), { force: true })
      const j = JSON.parse((await get('/kxxy/api/health')).text)
      const c = j.checks.find((x) => x.code === 'OVERLAY')
      if (c?.verdict !== 'BAD') fail(`缺失覆盖层应判 BAD，实为 ${c?.verdict}`)
      else ok('覆盖层缺失 → BAD')
    }

    // ⑩b 扩展目录：`engine/extensions/<id>/` 是 deb 解出来的纯目录树，
    //     **没有 package.json**。首版按 npm 包直觉去查它，25 个扩展全被判红
    //     （真机实测），而且用户无从修 —— 典型的「假红项比不报更糟」。
    //     判据是 `.links.json`（扩展中心真正依赖的接入点清单）。
    {
      const extRoot = join(FAKE_ENGINE_ROOT, 'extensions')
      // 正常扩展：只有 bin/lib/share，没有 package.json，但有合法 .links.json
      mkdirSync(join(extRoot, 'ffmpeg', 'bin'), { recursive: true })
      writeFileSync(join(extRoot, 'ffmpeg', '.links.json'), JSON.stringify({ views: [] }))
      writeFileSync(join(extRoot, 'ffmpeg', '.ext-version'), '7.0.0\n')
      {
        const j = JSON.parse((await get('/kxxy/api/health')).text)
        const c = j.checks.find((x) => x.code === 'EXTENSIONS')
        if (c?.verdict !== 'OK') fail(`无 package.json 的扩展目录应判 OK，实为 ${c?.verdict}（${c?.detail}）`)
        else ok('扩展目录无 package.json → OK（判据是 .links.json）')
      }
      // 坏 .links.json → BAD
      writeFileSync(join(extRoot, 'ffmpeg', '.links.json'), '{ "views": [ ')
      {
        const j = JSON.parse((await get('/kxxy/api/health')).text)
        const c = j.checks.find((x) => x.code === 'EXTENSIONS')
        if (c?.verdict !== 'BAD') fail(`坏 .links.json 应判 BAD，实为 ${c?.verdict}`)
        else ok('坏 .links.json → BAD')
      }
      // 安装没跑完（只有目录、没有 .links.json）→ OK，不能报红。
      // 注意：上一格把 ffmpeg 的 .links.json 改坏了，这里必须先修回来，
      // 否则 EXTENSIONS 的整体结论仍是 BAD，测不到「跳过」这条分支。
      writeFileSync(join(extRoot, 'ffmpeg', '.links.json'), JSON.stringify({ views: [] }))
      mkdirSync(join(extRoot, 'halfway', 'bin'), { recursive: true })
      writeFileSync(join(extRoot, 'halfway', '.ext-progress.json'), '{"percent":40}')
      {
        const j = JSON.parse((await get('/kxxy/api/health')).text)
        const c = j.checks.find((x) => x.code === 'EXTENSIONS')
        if (c?.verdict !== 'OK') fail(`安装未完成的扩展目录应判 OK（跳过），实为 ${c?.verdict}`)
        else ok('安装未完成（无 .links.json）→ OK（跳过，不误报）')
      }
    }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }

  // ⑪ 修复请求通道：POST 后必须真的落 recovery.request 文件（动作真做）。
  {
    const res = await fetch(base + '/kxxy/api/recovery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'L1', headline: '测试' }),
    })
    if (res.status !== 202) fail(`修复请求应 202，实为 ${res.status}`)
    else ok('202 accepted')
    const reqFile = join(FAKE_ENGINE_ROOT, 'recovery.request')
    if (!existsSync(reqFile)) fail('未落 recovery.request 文件（动作没真做）')
    else {
      const payload = JSON.parse(readFileSync(reqFile, 'utf8'))
      if (payload.level !== 'L1') fail(`level 应为 L1，实为 ${payload.level}`)
      else ok('recovery.request 已落盘且 level 正确')
    }
  }

  // ⑫ 非法 level 必须 400（否则原生层会拿到无法解析的载荷）。
  {
    const res = await fetch(base + '/kxxy/api/recovery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'L9' }),
    })
    if (res.status !== 400) fail(`非法 level 应 400，实为 ${res.status}`)
    else ok('非法 level → 400')
  }

  // ⑬ UNDO 是合法 level（撤销走同一条通道）。
  {
    const res = await fetch(base + '/kxxy/api/recovery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'UNDO' }),
    })
    if (res.status !== 202) fail(`UNDO 应 202，实为 ${res.status}`)
    else ok('UNDO → 202')
  }

  // ⑭ 修复结果端点：没有结果文件时返回 result:null 而不是 500。
  {
    const r = await get('/kxxy/api/recovery/result')
    if (r.status !== 200) fail(`状态码 ${r.status}`)
    else {
      const j = JSON.parse(r.text)
      if (j.result !== null) fail(`无结果时应为 null，实为 ${JSON.stringify(j.result)}`)
      else ok('无结果 → 200 {result:null}')
    }
  }
}

console.log('\n[15] disposer 卸载后路由消失')
{
  dispose()
  const r = await get('/kxxy')
  if (r.status !== 404) fail(`卸载后应为 404，实为 ${r.status}`)
  else ok('卸载后 /kxxy → 404')
  const m = await get('/kxxy/media?path=/etc/hosts')
  if (m.status !== 404) fail(`卸载后媒体路由应为 404，实为 ${m.status}`)
  else ok('卸载后 /kxxy/media → 404（媒体路由也随 disposer 注销）')
  if (indexTaps.length !== 0) fail(`卸载后 index tap 未注销（剩 ${indexTaps.length} 个）`)
  else ok('卸载后 index tap 已注销（兼容层 + 移动端样式）')
}

console.log(`\n插件日志：${logs.length} 条`)
for (const l of logs) console.log(`  · ${l}`)

server.close()
console.log(`\n结论：${failures === 0 ? '插件冒烟测试全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
