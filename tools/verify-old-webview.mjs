/**
 * 老 WebView 兼容层的**真浏览器**验证：真 Chromium 里先把「WebView 96 缺的那批
 * 内建」删掉，再按宿主的真实注入顺序（compat.js → modern.js → 页面脚本）加载，
 * 断言 DSH 客户端实际使用的调用形态能跑通；并用「不注入」的对照组证明这套断言
 * 真的会红。
 *
 * 为什么不能只信 tools/test-modern.mjs：那套跑在 Node 的 `vm` realm 里 ——
 * `AbortController` 是我们自己写的替身（Node 的 vm 没有 Web 全局），
 * `URL.createObjectURL` 也是桩。它能证明「补齐逻辑对」，证明不了「真引擎里
 * 补齐之后原生 API 的交互也顺」（比如在原生 AbortSignal 上 defineProperty、
 * 包装原生 abort 之后 EventTarget 的派发是否照旧）。
 *
 * 现场：2026-11-05 黑鲨5 Pro（JOYUI 13，ROM 自带 WebView ≤ 99）——
 * `AbortSignal.prototype.throwIfAborted`（Chrome 100）缺失，导致
 * `client api: agentPresets/list failed: signal?.throwIfAborted is not a function`
 * 这类报错铺满设置页，右下角一直「重新连接中」。
 *
 * 用法：node tools/verify-old-webview.mjs
 * 找不到 Chrome 时**跳过**（退出码 0）—— 不能让可选验证卡住没有浏览器的环境。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', 'plugins', 'kxxy-host', 'web')

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

/**
 * 把「Chrome 96 没有的内建」删掉。
 *
 * 刻意不用 CDP 的 addScriptToEvaluateOnNewDocument：那要自己实现一遍 websocket
 * 客户端，而这里只需要「脚本先于其它脚本执行」—— 同一个文档里的 classic script
 * 本来就按出现顺序同步执行，把它排在 compat.js 前面即可，等价且没有额外依赖。
 */
const DEGRADE = `
  try { delete AbortSignal.prototype.throwIfAborted } catch (e) {}
  try { delete AbortSignal.prototype.reason } catch (e) {}
  try { delete AbortSignal.any } catch (e) {}
  try { delete AbortSignal.timeout } catch (e) {}
  try { delete Promise.withResolvers } catch (e) {}
  try { delete Promise.try } catch (e) {}
  try { delete globalThis.structuredClone } catch (e) {}
  try { delete Array.prototype.findLast } catch (e) {}
  try { delete Array.prototype.findLastIndex } catch (e) {}
  try { delete Object.hasOwn } catch (e) {}
  try { delete Array.prototype.at } catch (e) {}
  try { delete String.prototype.at } catch (e) {}
  try { delete String.prototype.replaceAll } catch (e) {}
  try { delete globalThis.AggregateError } catch (e) {}
  try { delete Intl.Segmenter } catch (e) {}
  try { delete Iterator } catch (e) {}
`;

/** 页面里跑的断言：全部是 DSH 客户端**真实调用形态**的剪裁。 */
const PROBE = `
(async function () {
  const rows = [];
  const check = (name, fn) => {
    try { const v = fn(); rows.push([name, v === true ? 'ok' : 'FAIL(' + v + ')']); }
    catch (e) { rows.push([name, 'THROW ' + (e && e.name) + ': ' + (e && e.message)]); }
  };
  check('抛出点本身存在', () => typeof AbortSignal.prototype.throwIfAborted === 'function');
  // dsh-client-connection/lib/client.browser.js 的原句
  check('signal?.throwIfAborted()', () => {
    const c = new AbortController();
    const signal = c.signal;
    signal?.throwIfAborted();
    return true;
  });
  check('已取消时抛 reason', () => {
    const c = new AbortController();
    c.abort('cancelled-by-test');
    try { c.signal.throwIfAborted(); return 'no-throw'; } catch (e) { return e === 'cancelled-by-test' ? true : 'wrong:' + e; }
  });
  check('无 reason 时抛 AbortError', () => {
    const c = new AbortController();
    c.abort();
    try { c.signal.throwIfAborted(); return 'no-throw'; } catch (e) { return e && e.name === 'AbortError' ? true : 'wrong:' + (e && e.name); }
  });
  check('AbortSignal.any + throwIfAborted', () => {
    const a = new AbortController();
    const b = new AbortController();
    const any = AbortSignal.any([a.signal, b.signal]);
    b.abort('from-b');
    try { any.throwIfAborted(); return 'no-throw'; } catch (e) { return e === 'from-b' ? true : 'wrong:' + e; }
  });
  check('structuredClone 深拷贝', () => {
    const src = { a: 1, b: [1, { c: 2 }] };
    const out = structuredClone(src);
    return out.b[1].c === 2 && out.b !== src.b;
  });
  check('findLast', () => [1, 2, 3, 4].findLast((x) => x % 2 === 1) === 3);
  check('Array.prototype.at', () => [1, 2, 3].at(-1) === 3);
  check('Object.hasOwn', () => Object.hasOwn({ a: 1 }, 'a') === true && Object.hasOwn(Object.create({ a: 1 }), 'a') === false);
  check('replaceAll', () => 'a-b-c'.replaceAll('-', '+') === 'a+b+c');
  check('AggregateError', () => {
    const e = new AggregateError([1, 2], 'boom');
    return e.errors.length === 2 && e instanceof Error;
  });
  check('Intl.Segmenter（客户端主 chunk 顶层构造）', () => {
    const s = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return [...s.segment('hello')].length === 5;
  });
  check('Iterator（pdf.js worker 首行依赖）', () => typeof Iterator === 'function' && typeof Iterator.prototype.join === 'function');

  // blob worker：pdf.js / HTML 预览跑在独立全局里，modern.js 靠包装
  // createObjectURL 把同一份补齐代码前置进去。这里真起一个 worker 验一次。
  const workerOk = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    setTimeout(() => done('timeout'), 3000);
    try {
      const code = [
        'try {',
        '  var ok = typeof AbortSignal.prototype.throwIfAborted === "function" && typeof structuredClone === "function";',
        '  self.postMessage(ok ? "ok" : "missing");',
        '} catch (e) { self.postMessage("throw:" + e.message); }',
      ].join('\\n');
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = (ev) => done(ev.data);
      w.onerror = (ev) => done('error:' + (ev && ev.message));
    } catch (e) {
      done('throw:' + e.message);
    }
  });
  rows.push(['blob worker 内补齐', workerOk === 'ok' ? 'ok' : 'FAIL(' + workerOk + ')']);

  const failed = rows.filter((r) => r[1] !== 'ok');
  document.title = failed.length === 0
    ? 'OK ' + rows.length + '/' + rows.length
    : 'ERR ' + failed.map((r) => r[0] + '=' + r[1]).join(' | ');
  document.body.textContent = rows.map((r) => r[0] + ' => ' + r[1]).join('\\n');
})();
`;

const COMPAT = readFileSync(join(WEB, 'compat.js'), 'utf8')
const MODERN = readFileSync(join(WEB, 'modern.js'), 'utf8')

const inline = (s) => s.replace(/<\/script/gi, '<\\/script')

function page(inject) {
  const head = inject
    ? `<script data-kxxy-compat>${inline(COMPAT)}</script><script data-kxxy-modern>${inline(MODERN)}</script>`
    : ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>booting</title>
<script>${inline(DEGRADE)}</script>
${head}
</head><body><pre>pending</pre>
<script>${inline(PROBE)}</script>
</body></html>`
}

function serve(inject) {
  return new Promise((ok) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(page(inject))
    })
    server.listen(0, '127.0.0.1', () => ok(server))
  })
}

function dump(port) {
  return new Promise((ok) => {
    const child = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'kxxy-chrome-')),
        '--virtual-time-budget=6000',
        '--dump-dom',
        `http://127.0.0.1:${port}/`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (c) => (out += c.toString()))
    child.on('exit', () => ok(out))
  })
}

async function run(label, inject) {
  const server = await serve(inject)
  const port = server.address().port
  let dom = ''
  try {
    dom = await dump(port)
  } finally {
    server.close()
  }
  const title = (/<title>([^<]*)<\/title>/.exec(dom) || [])[1] || '(无 title)'
  const detail = (/<pre>([\s\S]*?)<\/pre>/.exec(dom) || [])[1] || ''
  console.log(`\n${label}\n  ${title}`)
  if (process.env.KXXY_VERBOSE === '1' && detail) {
    for (const line of detail.split('\n')) console.log('    ' + line)
  }
  return title
}

console.log(`浏览器：${CHROME}`)
const withLayer = await run('装兼容层', true)
const without = await run('不装（对照组）', false)

console.log('')
if (withLayer.startsWith('OK') && without.startsWith('ERR')) {
  console.log('✓ 兼容层让「WebView 96 缺口」全部补齐，且对照组（不装）确实失败')
  process.exit(0)
}
console.error('✗ 结论不符合预期：装兼容层应全绿、不装应报错')
if (withLayer.startsWith('ERR')) console.error('  装兼容层仍有失败项，见上面的 ERR 列表')
if (!without.startsWith('ERR')) console.error('  对照组居然也通过了 —— 说明这套断言无法证伪，先修夹具')
process.exit(1)
