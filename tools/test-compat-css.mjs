/**
 * `plugins/kxxy-host/web/compat.js` 里 CSS 补丁的离线单测（缺陷 S / W / AB）。
 *
 * 覆盖三段：
 *   [1] `dvh → vh`（Chrome 108+）—— 目录选择对话框列表空白。
 *   [2] `@scope` 展开（Chrome 118+）—— 侧边栏预览 .xlsx / .csv 时表格塌成单列。
 *   [3] `:has()` 改写为标记属性（Chrome 105+）—— 内置移动端插件
 *       `dsh-web-mobile` 的 301 处 `:has()` 全部被解析器整条丢弃，设置面板
 *       于是维持桌面两栏布局（「权限」「语言」被挤成一字一行）。
 *
 * 做法：用 `vm` 造一个最小 DOM 沙箱（`document.querySelectorAll('style')` 返回
 * 我们塞进去的假节点），把**真实的 compat.js** 灌进去执行 —— compat.js 在求值
 * 末尾就会调 `observeStyles()` → `patchAllStyles()`，因此假节点必须在
 * `runInContext` 之前就位。然后断言节点 `textContent` 被改写后的结果。
 *
 * 断言期望值不是手写猜测：`@scope` 段的语义参照 CSS Scoping 规范
 * （`@scope (R) { S {} }` ≡ `R S {}`，`&` 是根引用），并已用真机 excel 预览的
 * 那张 50018 字符样式表端到端跑过（449 条规则全部被正确加前缀）。
 *
 * 之所以需要这个测试：`smoke-plugin.mjs` 只能做「关键实现是否在场」的文本断言，
 * 覆盖不到语义边界 —— 而这几个函数的边界（`&`、逗号选择器、嵌套 at-rule、
 * 注释里的 `@scope`、幂等）恰恰是最容易改坏的地方。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPAT = process.env.KXXY_COMPAT_JS || join(HERE, "..", "plugins", "kxxy-host", "web", "compat.js");
const source = readFileSync(COMPAT, "utf8");

/**
 * 在最小 DOM 沙箱里跑 compat.js，返回改写后的样式文本。
 * 每次调用都是全新的沙箱，避免上一次的定义泄漏到下一次。
 */
const patch = (css) => {
  const node = { textContent: css };
  const sandbox = {
    URL: globalThis.URL,
    AbortSignal: globalThis.AbortSignal,
    AbortController: globalThis.AbortController,
    Promise, Object, Array, Set, Map, String, Number, Math, JSON, Symbol, RegExp,
    Uint8Array, Int8Array, RangeError, TypeError, Error, DOMException,
    setTimeout, clearTimeout, console,
    document: {
      querySelectorAll: () => [node],
      documentElement: {},
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "compat.js" });
  return node.textContent;
};

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

console.log(`compat.js 来源：${COMPAT}`);

console.log("\n[1] dvh → vh（Chrome 108+）");
check(
  "min() 里的 100dvh 被改写",
  patch(".a{height:min(500px,100dvh - 32px)}"),
  ".a{height:min(500px,100vh - 32px)}",
);
check(
  "裸 100dvh 被改写",
  patch(".a{height:100dvh}"),
  ".a{height:100vh}",
);
check(
  "`dvh` 后面跟字母数字时不动（base64 保护）",
  patch(".a{background:url(x)dvh1}"),
  ".a{background:url(x)dvh1}",
);
check(
  "url(...) 片段整段保留",
  patch('.a{background:url("data:image/svg+xml;base64,AAAA100dvh")}'),
  '.a{background:url("data:image/svg+xml;base64,AAAA100dvh")}',
);

console.log("\n[2] @scope 展开（Chrome 118+）");
// 真机形态：excel 预览把整张 fortune-sheet 样式表包进 @scope
check(
  "单条规则展开为「根 + 后代」",
  patch("@scope ([data-excel-preview]) { .fortune-container{color:red} }"),
  "[data-excel-preview] .fortune-container{color:red}",
);
check(
  "多条规则全部展开",
  patch("@scope ([x]) { .a{color:red}.b{color:blue} }"),
  "[x] .a{color:red}[x] .b{color:blue}",
);
check(
  "逗号选择器逐段加前缀",
  patch("@scope ([x]) { .a,.b{color:red} }"),
  "[x] .a, [x] .b{color:red}",
);
check(
  "`&` 展开为根自身（不加后代空格）",
  patch("@scope ([x]) { & .a{color:red} }"),
  "[x] .a{color:red}",
);
check(
  "`&:hover` 展开为根伪类",
  patch("@scope ([x]) { &:hover{color:red} }"),
  "[x]:hover{color:red}",
);
check(
  "`to (...)` 上界被丢弃，只保留起始根",
  patch("@scope ([x]) to ([y]) { .a{color:red} }"),
  "[x] .a{color:red}",
);
check(
  "无 prelude 的 @scope 只剥壳、不加前缀",
  patch("@scope { .a{color:red} }"),
  ".a{color:red}",
);
check(
  "嵌套 @media 递归展开",
  patch("@scope ([x]) { @media (min-width:1px){ .a{color:red} } }"),
  "@media (min-width:1px){ [x] .a{color:red} }",
);
check(
  "嵌套 @supports 递归展开",
  patch("@scope ([x]) { @supports (display:flex){ .a{color:red} } }"),
  "@supports (display:flex){ [x] .a{color:red} }",
);
// ★ 关键边界：@keyframes 内部是 `from` / `0%`，加选择器前缀会改坏动画。
check(
  "@keyframes 内部原样保留（不能加前缀）",
  patch("@scope ([x]) { @keyframes k{ from{opacity:0} to{opacity:1} } }"),
  "@keyframes k{ from{opacity:0} to{opacity:1} }",
);
check(
  "@font-face 原样保留",
  patch('@scope ([x]) { @font-face{font-family:F;src:url(f.woff2)} }'),
  '@font-face{font-family:F;src:url(f.woff2)}',
);
check(
  "规则体内的花括号字符串不误判",
  patch('@scope ([x]) { .a{content:"}"} }'),
  '[x] .a{content:"}"}',
);
check(
  "块外的前后文本原样保留",
  patch(".keep{color:green}@scope ([x]) { .a{color:red} }.tail{color:blue}"),
  ".keep{color:green}[x] .a{color:red}.tail{color:blue}",
);
check(
  "注释里的 @scope 不被展开",
  patch("/* @scope ([x]) { .a{color:red} } */ .b{color:blue}"),
  "/* @scope ([x]) { .a{color:red} } */ .b{color:blue}",
);
check(
  "属性名里的 @scope 子串不误判（前导标识符字符）",
  patch(".a{--x-scope:1}"),
  ".a{--x-scope:1}",
);
check(
  "两个 @scope 块都被展开",
  patch("@scope ([x]) { .a{color:red} }@scope ([y]) { .b{color:blue} }"),
  "[x] .a{color:red}[y] .b{color:blue}",
);
check(
  "展开后不再含 @scope（幂等的前提）",
  patch("@scope ([x]) { .a{color:red} }").includes("@scope"),
  false,
);

console.log("\n[3] 幂等：已展开的文本再跑一次不变");
const once = patch("@scope ([x]) { .fortune-container{color:red} }");
const twice = patch(once);
check("第二次结果与第一次一致", twice, once);
const dvhOnce = patch(".a{height:100dvh}");
check("dvh 第二次不变", patch(dvhOnce), dvhOnce);

console.log("\n[4] 组合：dvh 与 @scope 同处一份样式表");
check(
  "两段补丁互不干扰",
  patch("@scope ([x]) { .a{height:100dvh} }"),
  "[x] .a{height:100vh}",
);

console.log("\n[5] 真实形态：excel 预览的 449 条规则全部被加前缀");
{
  // 直接构造一个与真机同形的 @scope 包裹（不依赖设备拉下来的 CSS 文件）
  const inner = ".fortune-container{color:red}.fortune-workarea{color:blue}html::-webkit-scrollbar-button{color:gray}";
  const out = patch(`@scope ([data-excel-preview]) { ${inner} }`);
  check("不再含 @scope", out.includes("@scope"), false);
  check(
    "三条规则全部带前缀",
    out.split("[data-excel-preview]").length - 1,
    3,
  );
  check("html 选择器也被加前缀（@scope 语义如此）", out.includes("[data-excel-preview] html::-webkit-scrollbar-button"), true);
}

console.log("\n[6] :has() 改写为标记属性（Chrome 105+）");
// 真机形态：内置移动端插件把设置面板的适配规则全部锚在一个 :has() 门控上。
// WebView 104 的不支持方式是「整条规则被解析器丢弃」（不是选择器不匹配），
// 所以修法只能是文本层改写 —— 把 :has() 换成属性选择器，再用 MutationObserver
// 在真实 DOM 上维护这个属性。
check(
  "尾随 :has() 换成属性选择器",
  patch("div:has(span){color:red}"),
  'div[data-kxxy-has~="h0"]{color:red}',
);
check(
  "子代前导 :has() 同样改写",
  patch("a:has(> b){color:red}"),
  'a[data-kxxy-has~="h0"]{color:red}',
);
check(
  ":not(:has()) 连 :not() 一起换成语义等价的否定",
  patch("a:not(:has(b)){color:red}"),
  'a:not([data-kxxy-has~="h0"]){color:red}',
);
check(
  "同一复合选择器里的多个 :has() 各得一个标记",
  patch(".a:has(b):has(c){color:red}"),
  '.a[data-kxxy-has~="h0"][data-kxxy-has~="h1"]{color:red}',
);
check(
  "不同复合选择器之间按出现顺序编号",
  patch(".a:has(b) .c:has(d){color:red}"),
  '.a[data-kxxy-has~="h0"] .c[data-kxxy-has~="h1"]{color:red}',
);
// ★ 真机决定性形态：内置插件设置面板的门控。标记按实参特异性重复，
//   否则「[aria-modal=true] + 标记」的权重低于原「[aria-modal=true] + 后代后代按钮」。
check(
  "设置面板门控（真机形态）按特异性重复标记",
  patch(
    '[aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not([data-shortcut-modal="shortcuts"]){color:red}',
  ),
  '[aria-modal="true"][data-kxxy-has~="h0"][data-kxxy-has~="h0"]:not([data-kxxy-has~="h1"]):not([data-shortcut-modal="shortcuts"]){color:red}',
);
check(
  "@media 内的 :has() 也被改写",
  patch("@media (min-width:1px){ .a:has(b){color:red} }"),
  '@media (min-width:1px){ .a[data-kxxy-has~="h0"]{color:red} }',
);
check(
  ":is() 内部的 :has() 逐段改写",
  patch(":is(.a:has(b), .c){color:red}"),
  ':is(.a[data-kxxy-has~="h0"], .c){color:red}',
);
check(
  "不含 :has() 的规则原样保留",
  patch("p{color:blue}"),
  "p{color:blue}",
);
check(
  "@keyframes 内部原样保留（关键字里无 :has）",
  patch("@keyframes k{ from{opacity:0} }"),
  "@keyframes k{ from{opacity:0} }",
);
check(
  "改写后不再含 :has(（幂等的前提）",
  patch("div:has(span){color:red}").includes(":has("),
  false,
);
check(
  "第二次跑不变（此时已只有属性选择器）",
  patch(patch("div:has(span){color:red}")),
  'div[data-kxxy-has~="h0"]{color:red}',
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
