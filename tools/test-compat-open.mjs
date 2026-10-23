/**
 * `plugins/kxxy-host/web/compat.js` 里 `window.open` 桥的离线单测（缺陷 DF）。
 *
 * 真机症状：侧栏「更多」→「登录」→ **整页变白**。根因不是 WebView 版本，而是
 * 宿主没有多窗口 WebView —— `window.open('about:blank','_blank')` 在那种配置下
 * 会把**主框架**导航到 about:blank，整个 SPA 就此消失。
 *
 * 本测试在最小 DOM 沙箱里跑**真实的 compat.js**，断言：
 *   ① `about:blank` / 空串 → 返回非 null 的弹窗桩（调用方的 `popup &&` 守卫
 *      因此成立，不会走进 `popup.location` 的空引用分支）；
 *   ② 该桩的 `location.replace(url)` 会把地址交给 `kxxy://open?url=…` 桥；
 *   ③ 真实 http(s) URL → 直接过桥、返回 null（官方 `contactUs` /
 *      文档预览外链 / 聊天气泡里的链接都走这条，全部有 null 守卫）；
 *   ④ 非 http(s)（`file:` / `javascript:` / `intent:`）→ **不过桥**，返回 null
 *      （桥的另一端只认 http/https，这里先挡一层）；
 *   ⑤ 幂等：重复求值不叠加包装，且第二次不会把第一次的包装再包一遍。
 *
 * 用法：node tools/test-compat-open.mjs [compat.js 路径]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPAT = process.argv[2] ?? process.env.KXXY_COMPAT_JS ?? join(HERE, "..", "plugins", "kxxy-host", "web", "compat.js");

const source = readFileSync(COMPAT, "utf8");

let pass = 0;
let fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}\n      实际 ${a}\n      期望 ${e}`);
  }
};
const ok = (label) => {
  pass += 1;
  console.log(`  ✓ ${label}`);
};
const bad = (label, detail) => {
  fail += 1;
  console.log(`  ✗ ${label}${detail === undefined ? "" : `\n      ${detail}`}`);
};

/**
 * 造一个沙箱：`window` 与 `globalThis` 是同一个对象（浏览器语义），
 * `window.location.href` 的写入被记录下来 —— 那就是桥的出口。
 */
function makeSandbox() {
  const navigations = [];
  const sandbox = {
    navigations,
    URL,
    AbortSignal,
    AbortController,
    Promise,
    Object,
    Array,
    Set,
    Map,
    String,
    Number,
    Math,
    JSON,
    Symbol,
    Uint8Array,
    Int8Array,
    RangeError,
    TypeError,
    Error,
    DOMException,
    setTimeout,
    clearTimeout,
    console,
    document: { querySelectorAll: () => [], documentElement: {} },
  };
  // 浏览器里 window === globalThis；compat.js 用 `window.location.href = …` 过桥。
  const location = {};
  Object.defineProperty(location, "href", {
    get: () => "http://127.0.0.1:3080/",
    set: (value) => {
      navigations.push(value);
    },
  });
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.location = location;
  // 复刻「没有多窗口的 WebView」原生行为：window.open 存在，但它把**主框架**
  // 导航到目标并返回 null。这正是真机上整页变白的原因，也是本测试要证明
  // compat.js 已经把它接管掉的基线。
  sandbox.open = (url) => {
    if (typeof url === "string" && url !== "") navigations.push(`[native]${url}`);
    return null;
  };
  // compat.js 里可能碰到 `document.createElement`；这里给最小实现即可。
  sandbox.document.createElement = () => ({ dataset: {}, style: {}, appendChild() {}, setAttribute() {} });
  sandbox.document.head = { appendChild() {} };
  sandbox.document.querySelector = () => null;
  vm.createContext(sandbox);
  return sandbox;
}

console.log(`compat.js 来源：${COMPAT}\n`);

// ── 1. 求值（模拟页面主作用域） ──────────────────────────────────────────

const box = makeSandbox();
try {
  vm.runInContext(source, box, { filename: "compat.js#1" });
  ok("compat.js 求值未抛错");
} catch (error) {
  bad("compat.js 求值抛错", error.message);
  process.exit(1);
}

check("桥已安装（window.__kxxyWindowOpenBridge）", box.window.__kxxyWindowOpenBridge, true);

// ── 2. about:blank → 弹窗桩 ──────────────────────────────────────────────

console.log("\n[2] about:blank → 惰性弹窗桩（官方 BrowserLogin.begin 的形态）");
let popup = null;
try {
  popup = box.window.open("about:blank", "_blank");
} catch (error) {
  bad("window.open('about:blank') 抛错", error.message);
}
check("返回非 null（调用方的 popup 守卫成立）", popup !== null && popup !== undefined, true);
check("主框架未被导航（navigations 仍为空）", box.navigations, []);
check("closed 初始为 false", popup?.closed, false);

// 官方 follow() 的调用形态：popup.location.replace(authorizeUrl)
box.navigations.length = 0;
const authorize = "https://api.deepseek.com/dsh/authorize?state=abc&theme=light";
try {
  popup?.location?.replace(authorize);
} catch (error) {
  bad("popup.location.replace 抛错", error.message);
}
check("replace 过桥一次", box.navigations.length, 1);
check(
  "过桥地址是 kxxy://open?url=…",
  box.navigations[0]?.startsWith("kxxy://open?url="),
  true,
);
check(
  "URL 被完整编码后可还原",
  box.navigations[0] === `kxxy://open?url=${encodeURIComponent(authorize)}`,
  true,
);
check("过桥后弹窗标记为已关闭", popup?.closed, true);

// 空串同样应给桩（有的调用点传 '' 预开空白页）。
box.navigations.length = 0;
const blank = box.window.open("", "_blank");
check("空串也返回弹窗桩", blank !== null && blank !== undefined, true);
check("空串不触发导航", box.navigations, []);

// ── 3. 真实 http(s) → 直接过桥、返回 null ────────────────────────────────

console.log("\n[3] http(s) URL → 直接过桥并返回 null");
box.navigations.length = 0;
const external = "https://example.com/feedback?uid=1";
const returned = box.window.open(external, "_blank", "noopener,noreferrer");
check("返回 null（调用方都有 null 守卫）", returned, null);
check("过桥一次", box.navigations.length, 1);
check("地址被编码", box.navigations[0], `kxxy://open?url=${encodeURIComponent(external)}`);

// ── 4. 非 http(s) → 不过桥 ───────────────────────────────────────────────

console.log("\n[4] 非 http(s) 一律不过桥（桥的另一端只认 http/https）");
for (const url of [
  "file:///sdcard/a.html",
  "javascript:alert(1)",
  "intent://scan/#Intent;scheme=zxing;end",
  "content://app.kxxy.files/engine/x",
  "data:text/html,<h1>x</h1>",
]) {
  box.navigations.length = 0;
  const out = box.window.open(url, "_blank");
  check(`${url.slice(0, 24)}… → 返回 null 且不导航`, [out, box.navigations.length], [null, 0]);
}

// ── 5. 幂等 ──────────────────────────────────────────────────────────────

console.log("\n[5] 幂等（重复注入）");
try {
  vm.runInContext(source, box, { filename: "compat.js#2" });
  ok("第二次求值未抛错");
} catch (error) {
  bad("第二次求值抛错", error.message);
}
box.navigations.length = 0;
const again = box.window.open(external, "_blank");
check("行为不变（仍过一次桥）", [again, box.navigations.length], [null, 1]);

// 关键：第二次注入不得把第一次的包装再包一层 —— 那会让一次调用过两次桥。
check("只过一次桥（没有叠加包装）", box.navigations.length, 1);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
