/**
 * 跨源补丁的**浏览器侧**验证：真 Chromium 从 `http://127.0.0.1:3080` 跨源 fetch
 * `http://127.0.0.1:18787/__bili/?embed=1`，装补丁 / 不装补丁对照。
 *
 * 为什么不能只用 test-cors-shim.mjs：那套断言走的是 Node 的 http 客户端，
 * 它**不执行同源策略** —— 只能证明「ACAO 头发出来了」，证明不了「浏览器会
 * 放行」。用户在真机上卡住的恰恰是浏览器这一步，所以这里补一台真引擎。
 *
 * 两个服务都用本机回环、固定端口，刻意对齐真实现场：
 *   · 3080 = 宿主页（DSH 的官方前端就在这个端口）
 *   · 18787 = 插件自己起的代理（billion-context 的 lane 默认从这里起步）
 *
 * 用法：node tools/verify-cors-browser.mjs
 * 找不到 Chrome 时**跳过**（退出码 0）—— 不能让一条可选验证卡住没有浏览器的环境。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHIM = resolve('android/app/src/main/assets/guard/kxxy-cors.cjs').replace(/\\/g, '/')

const CHROME_CANDIDATES = [
  process.env.KXXY_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!CHROME) {
  console.log('跳过：没找到 Chromium（可用 KXXY_CHROME=<路径> 指定）')
  process.exit(0)
}

/** 「插件自己起的本地服务」：18787 上的 /__bili/ 返回 HTML。 */
function startApi({ shim }) {
  const dir = mkdtempSync(join(tmpdir(), 'kxxy-api-'))
  const entry = join(dir, 'api.cjs')
  writeFileSync(
    entry,
    `const http = require('http')
const s = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<html><body>bili ui ok</body></html>')
})
s.listen(18787, '127.0.0.1', () => process.stdout.write('UP\\n'))`,
    'utf8',
  )
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  if (shim) env.NODE_OPTIONS = `--require "${SHIM}"`
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('api 启动超时')), 15000)
    child.stdout.on('data', (c) => {
      if (c.toString().includes('UP')) {
        clearTimeout(timer)
        ok({ child, dir })
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`api 提前退出 code=${code}`))
    })
  })
}

/** 宿主页：一个最小页面，脚本里做跨源 fetch，把结果写进 document.title。 */
function startPage() {
  const html = `<!doctype html><meta charset="utf-8"><title>pending</title>
<script>
fetch('http://127.0.0.1:18787/__bili/?embed=1')
  .then(r => {
    const ct = r.headers.get('content-type') || ''
    return r.text().then(() => { document.title = 'OK ' + ct })
  })
  .catch(e => { document.title = 'ERR ' + e.name + ': ' + e.message })
</script>`
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  return new Promise((ok, fail) => {
    server.on('error', fail)
    server.listen(3080, '127.0.0.1', () => ok(server))
  })
}

function dumpDom() {
  return new Promise((ok) => {
    const child = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'kxxy-chrome-')),
        '--virtual-time-budget=4000',
        '--dump-dom',
        'http://127.0.0.1:3080/',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (c) => (out += c.toString()))
    child.on('exit', () => ok(out))
  })
}

async function run(label, shim) {
  const api = await startApi({ shim })
  const page = await startPage()
  let dom = ''
  try {
    dom = await dumpDom()
  } finally {
    api.child.kill()
    page.close()
    try {
      rmSync(api.dir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
  const title = (/<title>([^<]*)<\/title>/.exec(dom) || [])[1] || '(无 title)'
  console.log(`${label}: ${title}`)
  return title
}

const withShim = await run('装补丁  ', true)
const without = await run('不装补丁', false)

console.log('')
if (withShim.startsWith('OK') && without.startsWith('ERR')) {
  console.log('✓ 补丁让跨源 fetch 通了，且对照组（不装补丁）确实被浏览器拦下')
  process.exit(0)
}
console.error('✗ 结论不符合预期：默认设置下应当「装=通 / 不装=拦」')
process.exit(1)
