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
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', 'plugins', 'kxxy-host', 'lib', 'index.js')

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
  tapIndex() {
    throw new Error('kxxy-host 不应 tap index')
  },
}

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
  else ok(`200 ${r.type}，${r.text.length} 字节`)
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

console.log('\n[8] POST /kxxy/api/action（动作登记）')
{
  const res = await fetch(base + '/kxxy/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restart-engine' }),
  })
  const j = await res.json()
  if (res.status !== 202) fail(`状态码应为 202，实为 ${res.status}`)
  else if (j.accepted !== true) fail('accepted 非 true')
  else ok(`202 accepted，action=${j.action}`)
  if (!logs.some((l) => l.includes('restart-engine'))) fail('未记录动作日志')
  else ok('动作已记入插件日志')
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
}

console.log(`\n插件日志：${logs.length} 条`)
for (const l of logs) console.log(`  · ${l}`)

server.close()
console.log(`\n结论：${failures === 0 ? '插件冒烟测试全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
