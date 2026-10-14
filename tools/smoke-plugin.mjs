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
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
   * 当前有 **两个** tap：兼容层（injectCompat）与移动端适配样式
   * （injectMobileCss），注册顺序即执行顺序。
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
if (indexTaps.length !== 2) fail(`应恰好注册 2 个 index tap（兼容层 + 移动端适配层），实为 ${indexTaps.length}`)
else ok('已注册 index 兼容层 tap 与移动端适配 tap')

if (indexTaps.length === 2) {
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

  // ── 移动端 UI 适配层 ─────────────────────────────────────────────
  // 与兼容层的时序要求相反：兼容层必须**早于**入口 module（API 要在求值前
  // 就位），而适配样式必须**晚于**官方样式表（同权重规则才不会被覆盖回去），
  // 所以它插在 </head> 之前。
  const atMobile = out.indexOf('data-kxxy-mobile>')
  if (atMobile < 0) fail('index tap 未注入移动端适配样式')
  else ok('index tap 注入了移动端适配样式')
  if (atMobile < atEntry) fail('移动端样式早于入口 module（应在 </head> 前，晚于官方样式表）')
  else ok(`移动端样式位于文档后段（mobile@${atMobile} entry@${atEntry}）`)
  if (atMobile < atCompat) fail('移动端样式早于兼容层（注册顺序应保持 兼容层 → 移动端适配层）')
  else ok('注册顺序正确（兼容层先，移动端适配层后）')
  // 样式内容必须真的带上了：窄屏媒体查询、面板锚点、以及 flex-basis 那个坑
  // 的修复（flex:0 0 auto 与 height 必须同时出现，只写 height 会被顶掉）。
  for (const need of [
    '@media (max-width: 767px)',
    '[data-shortcut-modal="settings"]',
    '[class*="navList"]',
    '[class*="_themeCube"]',
  ]) {
    if (!out.includes(need)) fail(`移动端样式缺少关键规则：${need}`)
  }
  ok('移动端样式含媒体查询 / 面板锚点 / tab 条 / 外观卡片规则')
  const cubeRule = /\[class\*="_themeCube"\][^}]*\}/.exec(out)
  if (cubeRule === null) fail('移动端样式未定义 themeCube 规则')
  else if (!/flex:\s*0 0 auto/.test(cubeRule[0]) || !/height:\s*52px/.test(cubeRule[0])) {
    fail('themeCube 规则必须同时写 flex:0 0 auto 与 height（flex-basis 优先于 height）')
  } else ok('themeCube 规则含 flex:0 0 auto + height（flex-basis 坑已规避）')
  if (out.split('data-kxxy-mobile>').length - 1 !== 1) fail('单次 tap 注入了多份移动端样式')
  else ok('移动端样式单次只注入一份')

  // ── 左侧栏抽屉（mobile.css ⑪/⑫ + mobile.js）──────────────────────
  // 三条硬约束，缺一条真机上就会复现事故：
  //   1) grid 列宽必须 !important —— 官方把列宽写在 React inline style 上
  //   2) 侧栏必须 absolute 而非 fixed —— 祖先链上有 z-index:40 的 static 容器，
  //      fixed 层会输掉层叠竞争，表现为「测量正确但整块不可见」
  //   3) centerCol 必须显式 grid-column:2 —— 侧栏脱流后 grid 自动重排会把
  //      主内容放到第 1 列（0px 宽），不指定就压成 0 宽
  const railOpenRule = /\[class\*="BynINW_frame"\]\.kxxy-rail-open\s*\{[^}]*\}/.exec(out)
  if (railOpenRule === null) fail('移动端样式未定义 .kxxy-rail-open 的 grid 规则')
  else if (!/grid-template-columns:[^;]*!important/.test(railOpenRule[0])) {
    fail('.kxxy-rail-open 的 grid-template-columns 必须带 !important（官方 inline style 无它则胜出）')
  } else ok('.kxxy-rail-open 用 !important 覆盖 React inline grid')
  const railColRule = /\[class\*="BynINW_frame"\]\.kxxy-rail-open\s*>\s*\[class\*="sidebarCol"\]\s*\{[^}]*\}/.exec(out)
  if (railColRule === null) fail('移动端样式未定义抽屉态 sidebarCol 规则')
  else if (!/position:\s*absolute/.test(railColRule[0])) {
    fail('抽屉必须用 position:absolute（fixed 会输给祖先链上的 z-index:40 容器）')
  } else if (/position:\s*fixed/.test(railColRule[0])) {
    fail('抽屉不得使用 position:fixed')
  } else ok('抽屉用 absolute 覆盖（避开 fixed 的层叠竞争）')
  if (!/\.kxxy-rail-open\s*>\s*\[class\*="centerCol"\]\s*\{[^}]*grid-column:\s*2/.test(out)) {
    fail('抽屉态必须给 centerCol 显式 grid-column:2（侧栏脱流后会重排到 0px 的第 1 列）')
  } else ok('抽屉态显式把 centerCol 放回第 2 列')
  if (!out.includes('kxxy-rail-open::after')) fail('移动端样式缺少抽屉遮罩 ::after')
  else ok('抽屉含遮罩层（点击收起）')

  // ── 左侧栏完全隐藏（mobile.css ⑫ + mobile.js）────────────────────
  // 用户要求：用官方原本那个按钮，点它就把整栏完全收进去。
  // 这里最容易踩的三个坑，逐条钉死：
  const railHiddenGrid = /\[class\*="BynINW_frame"\]\.kxxy-rail-hidden\s*\{[^}]*\}/.exec(out)
  if (railHiddenGrid === null) fail('移动端样式未定义 .kxxy-rail-hidden 的 grid 规则')
  else if (!/grid-template-columns:[^;]*!important/.test(railHiddenGrid[0])) {
    fail('.kxxy-rail-hidden 的 grid-template-columns 必须带 !important')
  } else ok('.kxxy-rail-hidden 用 !important 覆盖 React inline grid')

  const railHiddenCol = /\[class\*="BynINW_frame"\]\.kxxy-rail-hidden\s*>\s*\[class\*="sidebarCol"\]\s*\{[^}]*\}/.exec(out)
  if (railHiddenCol === null) fail('移动端样式未定义隐藏态 sidebarCol 规则')
  else {
    // ① 绝不能用 display:none 实现隐藏 —— 官方开合按钮在列内，整棵子树退出
    //    渲染后按钮一起消失，用户永久失去唯一入口。必须 visibility。
    if (/display:\s*none/.test(railHiddenCol[0])) {
      fail('隐藏态不得用 display:none（会连官方开合按钮一起吞掉，用户再也打不开侧栏）')
    }
    // ② 反过来还必须**显式写 display:block**：设备上跑旧 runtime 时引擎会把旧版
    //    mobile.css（@2 用 display:none）一起内联进来，两条规则并存时旧的那条
    //    仍然胜出，症状是按钮定位全对却渲染成 0x0。
    else if (!/display:\s*block/.test(railHiddenCol[0])) {
      fail('隐藏态 sidebarCol 必须显式 display:block（否则并存的旧版样式表会用 display:none 拆台）')
    } else ok('隐藏态 sidebarCol 用 visibility 隐藏且显式 display:block')
  }

  if (!/\[class\*="BynINW_frame"\]\.kxxy-rail-hidden\s*>\s*\[class\*="sidebarCol"\]\s*\*\s*\{[^}]*visibility:\s*hidden/.test(out)) {
    fail('隐藏态缺少「sidebarCol 全后代 visibility:hidden」规则（图标栏会残留）')
  } else ok('隐藏态整列后代 visibility:hidden（图标栏视觉消失）')

  // ③ 按钮与其**后代**都必须设回 visible。visibility 是可继承属性，只把按钮
  //    自己设回 visible 救不回被显式声明为 hidden 的 svg/span —— 症状是
  //    getBoundingClientRect() 正确（36x36@10,18）却什么也画不出来。
  const toggleVis = /\[class\*="BynINW_frame"\]\.kxxy-rail-hidden\s*>\s*\[class\*="sidebarCol"\]\s*\[class\*="toggle"\][^{]*\{[^}]*visibility:\s*visible/.exec(out)
  if (toggleVis === null) fail('隐藏态未把官方开合按钮设回 visible（用户将失去唯一入口）')
  else ok('隐藏态保留官方开合按钮为可见入口')
  const toggleStar = /\[class\*="BynINW_frame"\]\.kxxy-rail-hidden\s*>\s*\[class\*="sidebarCol"\]\s*\[class\*="toggle"\]\s*,\s*\[class\*="BynINW_frame"\]\.kxxy-rail-hidden\s*>\s*\[class\*="sidebarCol"\]\s*\[class\*="toggle"\]\s*\*/.exec(out)
  if (toggleStar === null) {
    fail('隐藏态必须把按钮的后代（svg/span）也设回 visible，否则按钮 rect 正确但画不出来')
  } else ok('隐藏态按钮后代一并设回 visible（否则图标被祖先规则吞掉）')

  const toggleFixed = /\[class\*="BynINW_frame"\]\.kxxy-rail-hidden\s*>\s*\[class\*="sidebarCol"\]\s*\[class\*="toggle"\]\s*\{[^}]*position:\s*fixed/.exec(out)
  if (toggleFixed === null) {
    fail('隐藏态按钮必须 position:fixed 浮回左上角（列宽已压 0，留在流内会被压成 0 宽）')
  } else ok('隐藏态按钮用 fixed 浮回左上角原位')

  // ④ tabStrip 的归属必须按它自己的类名匹配，**不能**写成
  //    `> [class*="centerCol"] [class*="tabStrip"]` —— 实测 tabStrip 挂在第三列
  //    （rightbarCol）的子树下，centerCol 只有一个 display:contents 的直接子元素，
  //    写成 centerCol 后代选择器会 0 命中，48px 让位永远不生效。
  if (/\[class\*="BynINW_frame"\]\.kxxy-rail-hidden\s*>\s*\[class\*="centerCol"\]\s*\[class\*="tabStrip"\]/.test(out)) {
    fail('tabStrip 让位规则不得挂在 centerCol 后代下（实测 tabStrip 不在 centerCol 内，会 0 命中）')
  } else if (!/\[class\*="BynINW_frame"\]\.kxxy-rail-hidden\s+\[class\*="tabStrip"\]\s*\{[^}]*padding-left/.test(out)) {
    fail('隐藏态缺少 tabStrip 左内边距让位规则（官方 tab 条会压在悬浮按钮底下）')
  } else ok('隐藏态给 tabStrip 让出左侧空间（按 tabStrip 自身类名匹配）')

  const atMobileJs = out.indexOf('data-kxxy-mobile-js')
  if (atMobileJs < 0) fail('index tap 未注入移动端适配脚本')
  else ok('index tap 注入了移动端适配脚本')
  if (atMobileJs < atMobile) fail('移动端脚本早于样式（样式必须先就位，否则改 class 时会闪一帧未重排布局）')
  else ok(`移动端脚本晚于样式（js@${atMobileJs} css@${atMobile}）`)
  for (const need of [
    "var OPEN_CLASS = 'kxxy-rail-open'",
    'gridTemplateColumns',
    'matchMedia',
    'addListener',
  ]) {
    if (!out.includes(need)) fail(`移动端脚本缺少实现：${need}`)
  }
  ok('移动端脚本含切类 / inline grid 判档 / 窄屏媒体查询监听')
  // 判档必须读 inline style：我们自己会用 !important 把 computed 压成 0px，
  // 读 computed 会永远得到「已折叠」，抽屉永不打开。
  if (/getComputedStyle\([^)]*\)\.gridTemplateColumns/.test(out)) {
    fail('移动端脚本不得用 computed 的 gridTemplateColumns 判档（会被自己的 !important 骗到）')
  } else ok('移动端脚本用 inline gridTemplateColumns 判档（不受自身 !important 影响）')
  // WebView 104 没有 MediaQueryList.addEventListener，必须留 addListener 兜底分支。
  if (!/addListener/.test(out)) fail('移动端脚本缺少 WebView 104 的 addListener 兜底')
  else ok('移动端脚本兼容 WebView 104 的 MediaQueryList 旧 API')
  if (out.split('data-kxxy-mobile-js').length - 1 !== 1) fail('单次 tap 注入了多份移动端脚本')
  else ok('移动端脚本单次只注入一份')

  // 版本标记必须与 RuntimeInstaller.MOBILE_UI_MARKER 一致，否则老设备
  // 升级后锚点 8 判不出过期，会带着旧适配层跳过重装。
  const mobileMarker = /kxxy-mobile-ui@(\d+)/.exec(out)
  if (mobileMarker === null) fail('移动端适配层缺少版本标记 kxxy-mobile-ui@N')
  else {
    const kotlin2 = readFileSync(join(HERE, '..', 'android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt'), 'utf8')
    const mobileKotlinMarker = /MOBILE_UI_MARKER\s*=\s*"([^"]+)"/.exec(kotlin2)
    if (mobileKotlinMarker === null) fail('RuntimeInstaller.kt 未定义 MOBILE_UI_MARKER')
    else if (mobileKotlinMarker[1] !== mobileMarker[0]) {
      fail(`移动端适配层版本标记不一致：mobile.css=${mobileMarker[0]} RuntimeInstaller=${mobileKotlinMarker[1]}`)
    } else ok(`移动端适配层版本标记一致（${mobileMarker[0]}）`)
  }
}

// ── 真实 HTTP 分发 ────────────────────────────────────────────────
const server = createServer((req, res) => {
  const path = String(req.url ?? '/').split('?')[0]
  const h = exact.get(path)
  if (h) return void h(req, res)
  // 最长前缀优先（官方实现即如此，避免 /a 抢走 /a/b 的请求）
  let best = null
  for (const [p, handler] of prefixes) {
    // 与官方 WebServer.match() 逐字一致：等值或「前缀 + 斜杠」开头
    if (path !== p && !path.startsWith(`${p}/`)) continue
    if (best === null || p.length > best[0].length) best = [p, handler]
  }
  if (best) return void best[1](req, res)
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
console.log(`  测试服务器：${base}\n`)

async function get(path, headers = {}) {
  const res = await fetch(base + path, { headers })
  const text = await res.text()
  return { status: res.status, type: res.headers.get('content-type'), text }
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
}

console.log('\n[2] GET /kxxy/assets/host.css')
{
  const r = await get('/kxxy/assets/host.css')
  if (r.status !== 200) fail(`状态码 ${r.status}`)
  else if (!r.type?.includes('text/css')) fail(`content-type = ${r.type}`)
  else {
    ok(`200 ${r.type}，${r.text.length} 字节`)

    // ── 终端配色必须跟随主题（浅色错配是真实缺陷）────────────────────
    // 早期版本把终端容器/标题栏/视口/快捷键栏的背景写死成深色
    // （#151517 / #1b1b1c / #101012），而内部文字与按钮用的是语义变量
    // （--text-secondary / --bg-card 等）。浅色主题下这些变量翻成
    // 「深灰字、白底」，画在深底上就出现两个刺眼症状：
    //   ① 终端里嵌一张纯白「终端 Shell 诊断」卡；
    //   ② 快捷键按钮白底浅灰字，几乎不可读。
    // 修法是引入 --term-* 一组变量，两套主题各给一份取值。
    const css = r.text
    // 只禁「直接当背景/前景用」的写法；这些色值仍合法地出现在
    // var() 的兜底位与注释里（例如 --term-surface: var(--dsw-…, #151517)）。
    const direct = /(background-color|background|color)\s*:\s*#(151517|1b1b1c|101012|D1D5DB)\b/i.exec(css)
    if (direct !== null) {
      fail(`host.css 仍把 ${direct[2]} 直接用作 ${direct[1]}（应改用 --term-* 变量，否则浅色主题下错配）`)
    } else ok('终端区不再直接硬编码深色底色/前景')
    for (const v of ['--term-surface', '--term-chrome', '--term-viewport', '--term-fg', '--term-key-bg', '--term-key-fg']) {
      if (!css.includes(v)) fail(`host.css 缺少终端主题变量 ${v}`)
    }
    // 两套主题都必须给出取值：浅色在 body 段、深色在 body[data-ds-dark-theme] 段。
    const darkBlock = /body\[data-ds-dark-theme\]\s*\{([\s\S]*?)\n\}/.exec(css)
    if (darkBlock === null) fail('host.css 找不到 body[data-ds-dark-theme] 段')
    else if (!darkBlock[1].includes('--term-surface')) {
      fail('深色段未定义 --term-surface（深色终端会落到浅色值）')
    } else ok('终端配色改用 --term-* 变量，两套主题各一份取值')
    if (!/\.term-key\s*\{[^}]*background-color:\s*var\(--term-key-bg\)/.test(css)) {
      fail('.term-key 未使用 --term-key-bg（浅色下会白底浅灰字不可读）')
    } else ok('.term-key 底色跟随主题')
  }
}

console.log('\n[3] GET /kxxy/assets/host.js')
{
  const r = await get('/kxxy/assets/host.js')
  if (r.status !== 200) fail(`状态码 ${r.status}`)
  else ok(`200 ${r.type}，${r.text.length} 字节`)
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

console.log('\n[13] disposer 卸载后路由消失')
{
  dispose()
  const r = await get('/kxxy')
  if (r.status !== 404) fail(`卸载后应为 404，实为 ${r.status}`)
  else ok('卸载后 /kxxy → 404')
  if (indexTaps.length !== 0) fail(`卸载后 index tap 未注销（剩 ${indexTaps.length} 个）`)
  else ok('卸载后 index tap 已注销（兼容层 + 移动端样式）')
}

console.log(`\n插件日志：${logs.length} 条`)
for (const l of logs) console.log(`  · ${l}`)

server.close()
console.log(`\n结论：${failures === 0 ? '插件冒烟测试全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
