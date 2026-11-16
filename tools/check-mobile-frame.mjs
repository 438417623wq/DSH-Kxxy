/**
 * 移动端「主列被挤成 0 宽 → 进 DSH 界面纯白」的层叠回归（0.9.50）。
 *
 * 真机现场（CDP 直连设备 WebView 量的）：
 *
 *   frame       400×805  grid-template-columns: 400px 0px 0px
 *   ._sidebarCol  x=-280  280×805  absolute      ← 抽屉模式，已脱离网格流
 *   ._centerCol   x=400    0×805                 ← 对话界面，宽 0
 *
 * DOM、React 树、正文全都正常，只有主列宽 0 —— 所以是纯白，而且判据层
 * （`#root` 有子节点、页面有文字）永远不会判「白」，用户拿不到任何救援。
 *
 * 成因是两代样式对不上：
 *   · DSH 0.2.2 的 `dsh-client-ui-layout` 给三列钉了显式 grid-area
 *     （侧栏 1/1、主列 1/2、右栏 1/3）；0.2.1 及以前没有，靠 DOM 顺序自动排布。
 *   · 内置的 `dsh-web-mobile@3.1.0` 仍按 0.2.1 的假设强制
 *     `html [data-mobile-nav="frame"]{grid-template-columns:minmax(0,1fr) 0 0 !important}`
 *     —— 那句在 0.2.1 上是对的（主列自动落进第 1 轨），在 0.2.2 上把主列按进
 *     0 宽的第 2 轨。
 *
 * 本脚本用**真 Chromium**（手机视口 + 触摸，让 `pointer: coarse` 命中）复现：
 *   ① 不带兜底样式 → 主列必须宽 0（复现白屏）
 *   ② 带上 WebReadiness.MOBILE_FRAME_CSS → 主列必须满宽（修好）
 *   ③ 桌面宽度（1200px）下兜底样式必须**不生效**（不能误伤）
 *
 * 样式文本直接从 `WebReadiness.kt` 里求值取出 —— Kotlin 的字符串字面量拼接
 * 与 JS 同构，所以这里拿到的一定是随 APK 发出去的那一份，不是手抄版。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KOTLIN = path.join(ROOT, 'android/app/src/main/java/app/kxxy/engine/WebReadiness.kt');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const chromePath = process.env.KXXY_CHROME || CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.log('SKIP：找不到 Chromium，跳过层叠回归（本机没有安装 Chrome/Edge）');
  process.exit(0);
}

/** 从 Kotlin 源码里取出 `const val MOBILE_FRAME_CSS` 的字符串字面量并拼接。 */
function readMobileFrameCss() {
  const source = fs.readFileSync(KOTLIN, 'utf8');
  const marker = 'const val MOBILE_FRAME_CSS: String =';
  const at = source.indexOf(marker);
  assert.ok(at >= 0, 'WebReadiness.kt 里找不到 MOBILE_FRAME_CSS');
  let i = at + marker.length;
  const chunks = [];
  const unescape = (c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', "'": "'", $: '$' }[c] ?? c);
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== '"') break;
    i++;
    let buf = '';
    while (i < source.length && source[i] !== '"') {
      if (source[i] === '\\') { buf += unescape(source[i + 1]); i += 2; continue; }
      buf += source[i];
      i++;
    }
    i++; // 收尾引号
    chunks.push(buf);
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== '+') break;
    i++;
  }
  const css = chunks.join('');
  assert.ok(css.length > 40 && css.includes('_centerCol'), `MOBILE_FRAME_CSS 解析异常：${css}`);
  return css;
}

const ourCss = readMobileFrameCss();

// ── 夹具：0.2.2 的真实布局规则 + 插件 3.1.0 的真实强制列宽 ──────────────────
const hostCss = `
body { margin: 0 }
.pI_x6G_frame { box-sizing: border-box; height: 100%; display: grid; position: relative; overflow: hidden;
  grid-template-rows: minmax(0px, 1fr) auto; background: #fff }
.pI_x6G_sidebarCol { background: #f5f5f5; border-right: .5px solid #ddd; grid-area: 1 / 1; min-width: 0; overflow: hidden }
.pI_x6G_centerCol { flex-direction: column; grid-area: 1 / 2; min-width: 0; display: flex; overflow: hidden }
.pI_x6G_rightbarCol { grid-area: 1 / 3; min-width: 0; position: relative; overflow: visible; background: #fff }
.pI_x6G_frame[data-sidebar-drawer] .pI_x6G_sidebarCol { position: absolute; z-index: 71; width: 280px;
  transform: translateX(-280px); visibility: hidden }
.pI_x6G_frame[data-sidebar-drawer] .pI_x6G_drawerMask { position: absolute; width: 280px; transform: translateX(-308px) }
.pI_x6G_mainPanel { flex-direction: column; flex: 1 1 0%; min-width: 0; min-height: 0; display: flex }
`

// 插件 dsh-web-mobile@3.1.0 的原文（LAYOUT_CSS 开头那几条），逐字保留。
const pluginCss = `
@media (max-width: 1023px) and (pointer: coarse) {
  html, body { height: 100% !important; overflow: hidden !important; background: #fff !important }
  html [data-mobile-nav="frame"] {
    box-sizing: border-box !important;
    position: relative !important;
    grid-template-columns: minmax(0, 1fr) 0 0 !important;
  }
}
`

const body = `
<div id="root">
  <div class="pI_x6G_frame" data-mobile-nav="frame" data-sidebar-drawer="true" data-sidebar-collapsed="true" data-sidebar-instant="true">
    <div class="pI_x6G_drawerMask"></div>
    <div class="pI_x6G_sidebarCol"><div id="side">侧栏</div></div>
    <div class="pI_x6G_centerCol">
      <div class="pI_x6G_mainPanel"><div id="chat">对话内容</div></div>
    </div>
    <div class="pI_x6G_rightbarCol"></div>
  </div>
</div>`

const makeHtml = (extraCss) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${hostCss}</style>
<style>${pluginCss}</style>
<style data-kxxy-mobile-frame>${extraCss}</style>
</head><body>${body}</body></html>`

const read = `(function(){
  var f = document.querySelector('[data-mobile-nav="frame"]');
  var c = document.querySelector('[class*="_centerCol"]');
  var chat = document.getElementById('chat');
  var fr = f.getBoundingClientRect(), cr = c.getBoundingClientRect(), hr = chat.getBoundingClientRect();
  return JSON.stringify({
    coarse: matchMedia('(pointer: coarse)').matches,
    vw: innerWidth,
    cols: getComputedStyle(f).gridTemplateColumns,
    centerX: Math.round(cr.x), centerW: Math.round(cr.width),
    chatW: Math.round(hr.width),
    chatVisible: hr.width > 0 && hr.x >= 0 && hr.x < innerWidth,
  });
})()`

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kxxy-frame-'));
  const port = 9351;
  const child = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    } catch { /* 还没起来 */ }
  }
  if (!target) throw new Error('Chromium 没有起来');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = (method, params = {}) => {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params }));
    return new Promise((res) => pending.set(mid, res));
  };
  return { child, send, close: () => { try { child.kill(); } catch { /* ignore */ } } };
}

const { child, send, close } = await launch();
const results = [];
try {
  await send('Page.enable');
  await send('Runtime.enable');
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result?.result?.value;
  };
  const load = async (html) => {
    fs.writeFileSync(path.join(ROOT, '.cache/mobile-frame-fixture.html'), html, 'utf8');
    await send('Page.navigate', { url: 'file:///' + path.join(ROOT, '.cache/mobile-frame-fixture.html').replace(/\\/g, '/') });
    await sleep(700);
  };
  const phone = async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 805, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  };
  const desktop = async () => {
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  };

  // ① 手机视口 + 不注入兜底样式：必须复现「主列 0 宽」
  await phone();
  await load(makeHtml(''));
  const before = JSON.parse(await evalJs(read));
  console.log('BEFORE', JSON.stringify(before));
  assert.equal(before.coarse, true, '手机视口没有命中 pointer: coarse，夹具无效');
  assert.equal(before.vw, 400, `视口宽度不是 400：${before.vw}`);
  assert.equal(before.cols, '400px 0px 0px', `列宽不是插件强制的那三轨：${before.cols}`);
  assert.equal(before.centerW, 0, `没有复现白屏：主列宽 ${before.centerW}`);
  assert.equal(before.chatVisible, false, '没有复现白屏：对话内容居然可见');
  results.push('复现：手机视口下主列宽 0（对话内容不可见）');

  // ② 手机视口 + 兜底样式：主列必须满宽
  await load(makeHtml(ourCss));
  const after = JSON.parse(await evalJs(read));
  console.log('AFTER ', JSON.stringify(after));
  assert.equal(after.centerW, 400, `兜底样式没救回主列：${after.centerW}`);
  assert.equal(after.chatW, 400, `对话内容宽度不对：${after.chatW}`);
  assert.equal(after.chatVisible, true, '兜底样式生效后对话内容仍不可见');
  results.push('修复：注入 MOBILE_FRAME_CSS 后主列 400px、对话内容可见');

  // ③ 桌面宽度下兜底样式必须是空操作
  await desktop();
  await load(makeHtml(ourCss));
  const wide = JSON.parse(await evalJs(read));
  console.log('WIDE  ', JSON.stringify(wide));
  assert.equal(wide.coarse, false, '桌面视口不该命中 pointer: coarse');
  assert.ok(wide.centerW > 0, `桌面宽度下主列被兜底样式压成 0：${wide.centerW}`);
  assert.equal(wide.chatVisible, true, '桌面宽度下对话内容不可见');
  results.push('无副作用：桌面宽度下兜底样式不命中，主列正常');
} finally {
  close();
}

console.log(results.map((r) => `PASS ${r}`).join('\n'));
console.log(`RESULT {"passed":${results.length},"failed":0}`);
