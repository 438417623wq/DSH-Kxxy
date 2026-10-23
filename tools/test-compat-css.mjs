/**
 * `plugins/kxxy-host/web/compat.js` 里 CSS 补丁的离线单测（缺陷 S / W / AB / AC）。
 *
 * 覆盖四段：
 *   [1] `dvh → vh`（Chrome 108+）—— 目录选择对话框列表空白。
 *   [2] `@scope` 展开（Chrome 118+）—— 侧边栏预览 .xlsx / .csv 时表格塌成单列。
 *   [3] `:has()` 改写为标记属性（Chrome 105+）—— 内置移动端插件
 *       `dsh-web-mobile` 的 301 处 `:has()` 全部被解析器整条丢弃，设置面板
 *       于是维持桌面两栏布局（「权限」「语言」被挤成一字一行）。
 *   [4] 插件 hash 锚点代际归一化 —— 插件按宿主某一代构建，选择器写死那一代的
 *       CSS-module hash 前缀，宿主换代后 330/451 条规则零命中，对话界面右上角
 *       于是多出一个与插件文件按钮重叠的侧栏图标。
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
 *
 * `styles` 可传一组假 style 节点（`{textContent, getAttribute}`），用于缺陷 AC
 * 那类「要区分宿主样式表与插件样式表」的改写；返回的 `nodes` 就是同一批节点，
 * 断言时直接读它们的 `textContent`。
 */
const runInDom = (styles, documentElement = {}) => {
  const nodes = styles.map((s) => ({
    textContent: s.textContent,
    getAttribute: (name) => (name === "data-plugin" ? s.plugin ?? null : null),
  }));
  // compat.js 的 `hashObserve` 在没有 MutationObserver 时直接 return，连带
  // `hashRefresh()` 都不跑 —— 真实浏览器里一定存在，所以这里必须给个空壳。
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  // 布局微调那一层会往 `<head>` 里追加一张 `<style data-kxxy-mobile-layout>`。
  // 真实 WebView 的 `document` 有 `head` / `createElement` / `querySelector` /
  // `appendChild`，这里必须补齐 —— 缺 `querySelector` 时旧实现在第 443 行抛
  // `TypeError`，而在真实浏览器里那段代码永远走不到，等于这套断言从来没验过
  // 注入路径（缺陷 DS）。
  const headChildren = [];
  const head = {
    appendChild(node) {
      headChildren.push(node);
      return node;
    },
  };
  const hasMobileLayout = () => headChildren.some((n) => n.attributes["data-kxxy-mobile-layout"] !== undefined);
  const sandbox = {
    URL: globalThis.URL,
    AbortSignal: globalThis.AbortSignal,
    AbortController: globalThis.AbortController,
    MutationObserver,
    Promise, Object, Array, Set, Map, String, Number, Math, JSON, Symbol, RegExp,
    Uint8Array, Int8Array, RangeError, TypeError, Error, DOMException,
    setTimeout, clearTimeout, console,
    document: {
      querySelectorAll: (selector) => {
        if (selector === "style") return nodes;
        if (selector === "style[data-plugin]") {
          return nodes.filter((n) => n.getAttribute("data-plugin") !== null);
        }
        return [];
      },
      querySelector: (selector) => {
        if (selector === "style[data-kxxy-mobile-layout]") return hasMobileLayout() ? headChildren[0] : null;
        return null;
      },
      createElement: () => ({ attributes: {}, textContent: "" , setAttribute(name, value) { this.attributes[name] = value; } }),
      head,
      addEventListener() {},
      documentElement,
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "compat.js" });
  nodes.injected = headChildren;
  return nodes;
};

const patch = (css) => runInDom([{ textContent: css }])[0].textContent;

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

console.log("\n[2b] @container → @media（Chrome 105+，2026-10-23 右上角压字的根因）");
check(
  "无容器名的 width 范围查询被搬成 @media，并落到 max-width",
  patch("@container (width<=540px){.a{display:none}}"),
  "@media (max-width: 540px) {.a{display:none}}",
);
check(
  "严格小于也落到 max-width（差一像素无实际意义）",
  patch("@container (width<360px){.a{color:red}}"),
  "@media (max-width: 360px) {.a{color:red}}",
);
check(
  "min-width 形式同样能搬",
  patch("@container (min-width: 400px){.a{color:red}}"),
  "@media (min-width: 400px) {.a{color:red}}",
);
check(
  "inline-size 改写成 width（@media 不认盒维度名）",
  patch("@container (inline-size < 400px){.a{color:red}}"),
  "@media (max-width: 400px) {.a{color:red}}",
);
// 四条「宁可放过」。它们必须**逐字保留原文**而不是重建字符串：
// 重建会让 patchCssText 认为「文本变了」，于是 MutationObserver 反复自激。
const namedContainer = "@container card (width>400px){.a{color:red}}";
check("带容器名的不翻（逐字保留）", patch(namedContainer), namedContainer);
const styleContainer = "@container style(--theme:dark){.a{color:red}}";
check("style() 查询不翻（逐字保留）", patch(styleContainer), styleContainer);
const notContainer = "@container not (width>400px){.a{color:red}}";
check("not (...) 不翻（逐字保留）", patch(notContainer), notContainer);
const opaqueContainer = "@container (aspect-ratio > 1/1){.a{color:red}}";
check("读不懂的维度不翻（逐字保留）", patch(opaqueContainer), opaqueContainer);
// 幂等：搬完的文本里不再有 @container，第二遍不再变化。
const containerOnce = patch("@container (width<=540px){.a{display:none}}");
check("搬完后文本里不再出现 @container", containerOnce.includes("@container"), false);
check("第二次跑不再变化", patch(containerOnce), containerOnce);
// dsh-web-mobile 的规则全都写在 @media 里，所以嵌套形态是主场景。
check(
  "嵌套在 @media 里的 @container 也搬",
  patch("@media (max-width:767px){@container (width<=540px){.a{display:none}}}"),
  "@media (max-width:767px){@media (max-width: 540px) {.a{display:none}}}",
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

// ---- [7] 缺陷 AC：插件选择器里宿主 class hash 的代际归一化 -------------------
// 内置插件 dsh-web-mobile 是按宿主某一代构建的，选择器写死那一代的 CSS-module
// hash 前缀。宿主换代后真机实测：插件 451 条规则里 330 条 selectorText 在 DOM
// 上零命中，其中含「隐藏标题行 headerCorner」那条 —— 症状就是对话界面右上角
// 多出一个侧栏图标（与插件自己的文件按钮重叠）。
//
// 判据刻意保守：后缀集合必须被候选**完整包含**，且候选**唯一**才建立映射；
// 模糊宁可不映射（真机上 `QsffPG_root` 这类单后缀锚点有 23 个候选，一律放弃）。
const runHash = (hostCss, pluginCss) =>
  runInDom([
    { plugin: "@deepseek-ai/dsh-client-ui-conversation", textContent: hostCss },
    { plugin: "dsh-web-mobile", textContent: pluginCss },
  ])[1].textContent;

console.log("\n[7] 插件 hash 锚点代际归一化（真机形态：wSkVaW → Dc7zOa）");
check(
  "后缀集合唯一包含时改写为宿主当前代",
  runHash(
    ".Dc7zOa_titleRow{color:red}.Dc7zOa_headerCorner{color:red}",
    '[class*="wSkVaW_titleRow"] > [class*="_headerCorner"]{display:none !important}',
  ),
  '[class*="Dc7zOa_titleRow"] > [class*="_headerCorner"]{display:none !important}',
);
check(
  "类选择器形态 .HASH_tail 同样改写",
  runHash(
    ".Dc7zOa_titleRow{color:red}.Dc7zOa_headerCorner{color:red}",
    ".wSkVaW_titleRow{color:blue}",
  ),
  ".Dc7zOa_titleRow{color:blue}",
);
check(
  "两个候选都完整包含后缀时不猜（保持原文）",
  runHash(
    ".Dc7zOa_titleRow{}.Dc7zOa_headerCorner{}.oXE0lW_titleRow{}.oXE0lW_headerCorner{}",
    '[class*="wSkVaW_titleRow"]{display:none}',
  ),
  '[class*="wSkVaW_titleRow"]{display:none}',
);
check(
  "候选缺一个后缀时不映射（宿主换了结构，不能凑）",
  runHash(
    ".Dc7zOa_titleRow{color:red}",
    '.wSkVaW_titleRow{color:blue}[class*="wSkVaW_headerUtilities"]{color:blue}',
  ),
  '.wSkVaW_titleRow{color:blue}[class*="wSkVaW_headerUtilities"]{color:blue}',
);
check(
  "候选前缀已被插件自己占用时不采用（避免把锚点并到同代）",
  runHash(
    ".Dc7zOa_titleRow{color:red}.Dc7zOa_headerCorner{color:red}",
    '.Dc7zOa_x{color:green}[class*="wSkVaW_titleRow"]{color:blue}',
  ),
  '.Dc7zOa_x{color:green}[class*="wSkVaW_titleRow"]{color:blue}',
);
check(
  "第二次跑结果不变（映射稳定后不再改写）",
  runHash(
    ".Dc7zOa_titleRow{color:red}.Dc7zOa_headerCorner{color:red}",
    runHash(
      ".Dc7zOa_titleRow{color:red}.Dc7zOa_headerCorner{color:red}",
      '[class*="wSkVaW_titleRow"] > [class*="_headerCorner"]{display:none}',
    ),
  ),
  '[class*="Dc7zOa_titleRow"] > [class*="_headerCorner"]{display:none}',
);

// [8] 布局微调层的注入路径（缺陷 DQ 的守卫）
// 这一段验的是「compat.js 真的把那几条规则追加进 <head> 了吗」——之前的
// 夹具没有 `querySelector`，注入路径一次都没走到过；等真机上「顶栏多两个
// 图标」的规则不生效时，这套测试本来该报错却是绿的（缺陷 DS）。
{
  const injected = runInDom([{ textContent: "" }]).injected;
  check("布局微调层注入一张 style", injected.length, 1);
  const css = injected[0]?.textContent ?? "";
  check("注入的 style 带 data-kxxy-mobile-layout", injected[0]?.attributes["data-kxxy-mobile-layout"], "");
  check("隐藏宿主重复的侧栏入口", css.includes("[data-conversation-header-corner]"), true);
  check(
    "最窄一档整块隐藏「标准模式」chip（阈值与上游 @container 的 540px 一致）",
    css.includes("@media (max-width: 540px)")
      && css.includes('header [class*="_label"]:not(#kxxy) { display: none !important }'),
    true,
  );
  // 防回退：这条规则曾经被写成 `header [class*="_headerActions"] > [class*="_label"]`，
  // 在真机上一条都没命中 —— 官方会话头的芯片容器是 `_727C8a_headerActions`，
  // 芯片本身却挂在更外层，加祖先限定等于自断锚点。宁可放宽，不可收紧到类名结构。
  check(
    '「标准模式」隐藏规则不得再要求 _headerActions 祖先（2026-10-23 真机未命中的教训）',
    css.includes('[class*="_headerActions"] > [class*="_label"]'),
    false,
  );
  check(
    "headerActions 直接子级加溢出保护（压字的直接机制）",
    css.includes('header [class*="_headerActions"] > *:not(#kxxy) { min-width: 0; overflow: hidden }'),
    true,
  );
  check("状态行字号收到 11px", css.includes("[data-composer-stat]:not(#kxxy) { font-size: 11px"), true);
  check("分隔符用兄弟选择器", css.includes("~ [class*=\"_sep\"]"), true);
  check("只在窄屏生效", css.includes("@media (max-width: 767px)"), true);
  check("不依赖 :has()", css.includes(":has("), false);

  // 两个状态芯片改上下两行（2026-10-23 用户拍板「按 E 落地」）
  check(
    "窄屏下 headerActions 主轴改纵向（数量自适应，单芯片退化为一行）",
    css.includes('header [class*="_headerActions"]:not(#kxxy) { flex-direction: column !important'),
    true,
  );
  // 特异性守卫：上游手机档那条规则带 4 个属性选择器 + !important，本层只有
  // 升到 id 级（`#kxxy`）才压得住；漏掉 `:not(#kxxy)` 就等于整条规则白写。
  check(
    "竖排规则必须带 :not(#kxxy) 提权（否则被上游 !important 压掉）",
    /\[class\*="_headerActions"\]:not\(#kxxy\) \{ flex-direction: column !important/.test(css),
    true,
  );
  // `overflow: visible` 是为了推翻上游手机档的 `overflow-x: auto` 横向滚动盒：
  // 主轴换成 column 之后，那个 auto 会把纵向也变成滚动容器，两行被裁。
  check(
    "竖排同时解除 overflow-x:auto（否则两行被裁 + 多一条滚动缝）",
    css.includes("gap: 0 !important; overflow: visible !important; max-width: none !important"),
    true,
  );
  check(
    "两行芯片压到 11px / 17px（E 档紧凑尺寸）",
    css.includes("min-height: 17px !important; padding-block: 0 !important; font-size: 11px !important; line-height: 15px !important"),
    true,
  );
  // 芯片内部文字自带 font-size，只改根元素管不到；但继承规则必须排除 svg，
  // 否则圆环类图标会被 line-height 拉变形。
  check(
    "芯片内部文字继承紧凑字号，且排除 svg",
    css.includes('header [class*="_headerActions"] > *:not(#kxxy) > *:not(svg) { font-size: inherit !important'),
    true,
  );
  check(
    "corner 负边距收窄，避免压到芯片列",
    css.includes('header [class*="_headerCorner"]:not(#kxxy) { margin-left: 2px !important; margin-right: -6px !important; align-self: flex-start !important }'),
    true,
  );
  // 「标准模式」那条隐藏规则按 `_label` 后缀锚，会连 headerActions 里两个状态芯片的
  // 文字一起藏掉（2026-10-23 落地竖排时在预览里撞见：子智能体只剩一个圆环）。
  // 所以必须紧跟一条把 headerActions 内 label 恢复回来的规则。
  check(
    "headerActions 内的 label 必须恢复（否则子智能体文字被一起藏掉）",
    css.includes('header [class*="_headerActions"] [class*="_label"]:not([class*="f8BMvq"]):not(#kxxy) { display: revert !important }'),
    true,
  );
  // 恢复规则与隐藏规则同为 !important，只靠书写顺序不够 —— 特异性必须不低。
  check(
    "恢复规则必须带 :not(#kxxy) 提权（否则压不过隐藏规则）",
    /\[class\*="_headerActions"\] \[class\*="_label"\]:not\(\[class\*="f8BMvq"\]\):not\(#kxxy\) \{ display: revert !important/.test(css),
    true,
  );
  // 恢复规则必须**排除标准模式**（缺陷 DW）：@11 的恢复规则无差别恢复 headerActions
  // 内所有 `_label`，把「标准模式」也带了回来 —— 真机右上角变成「后台任务 / corner /
  // 标准模式 / 子智能体」四行散排。AgentPresetLabel 是 span.f8BMvq_label（图标+文字
  // 一体，无外层容器），排除它才能整块消失。
  check(
    "恢复规则必须排除标准模式（f8BMvq），否则它参与竖排变成四行散排（缺陷 DW）",
    css.includes(':not([class*="f8BMvq"]):not(#kxxy) { display: revert !important }'),
    true,
  );
  // 标准模式整块隐藏的冗余兜底：全藏规则将来若被收窄锚点，这条保证它仍然消失。
  check(
    "标准模式芯片整块隐藏（含图标）——上游标注 read-only，藏掉零功能损失",
    css.includes('header [class*="f8BMvq_label"]:not(#kxxy) { display: none !important }'),
    true,
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);