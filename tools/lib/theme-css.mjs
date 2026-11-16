/**
 * 从官方主题模块里抽出 `--dsw-*` token 定义，生成 `plugins/kxxy-host/web/theme.css`。
 *
 * ── 为什么单独成模块 ────────────────────────────────────────────────────────
 *
 * 这段逻辑原来内联在 `build-runtime.mjs` 里，用「配对双引号」的正则
 * （`/"((?:[^"\\]|\\.)*)"/g`）去捞 CSS 片段。那份实现**在 0.9.57 上是坏的**：
 * 该模块把 CSS 放在模板字面量（反引号）里，而 JS 代码里另有双引号，于是正则
 * 把「引号 A … 引号 B」之间整段代码当成一个字符串抓走，产出的 theme.css 里
 * 混进了 `` `;var design_platform_css_default=` `` 这类 JS 胶水。
 *
 * 浏览器解析到反引号会把**整条规则**丢掉 —— 恰好丢掉的是浅色那套
 * `body{--dsw-static-*}` 与 `body{--dsw-alias-onboarding-*}`。alias 那层虽然
 * 还在，但它的值是 `var(--dsw-static-neutral-bluish-00)`，被引用的 static 没了
 * 就整条失效，host.css 的 `var(--dsw-…, #深色兜底)` 于是全部落到深色兜底值：
 *
 *   深色主题 → 另有 body[data-ds-dark-theme] 一套字面量，**看着正常**；
 *   浅色主题 → 底是 #151517、字是 #f9fafb，只有顶栏用了浅色半透明底，
 *              变成「白底白字 + 整页发黑」。
 *
 * 所以这里改成正经扫字符串字面量（双引号/单引号/反引号，跳过注释与模板插值），
 * 并把选择器收窄到 `html` / `body` 及其属性限定形态 —— 非 CSS 文本再也进不来。
 * 生成完还有一道 `assertThemeCss()` 自检，宁可让构建失败，也不许再发一份坏 CSS。
 *
 * 用法（重建 theme.css，不打全量运行时）：
 *   node tools/gen-theme-css.mjs --asar .cache/dsh-rb3/app/resources/app.asar
 */

const THEME_CLIENT_PATH = "lib/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js";

/** 只接受这两种选择器形态：官方 token 块只会挂在 body / body[属性] 上。 */
const SELECTOR_OK = /^(?:html|body)(?:\[[^[\]{}"'`]{1,160}\])*$/;

const HEADER =
  "/*\n" +
  " * 官方主题 token（构建期从 @deepseek-ai/dsh-client-ui-theme/lib/client.js 自动抽取）。\n" +
  " * 请勿手改 —— 改了也会被下次构建覆盖；要调样式请改 host.css 里对变量的引用。\n" +
  " */\n";

/**
 * 扫出 JS 里所有**字符串字面量**的文本内容（不含引号本身）。
 *
 * - 跳过 `//` 行注释与块注释，避免注释里的引号把扫描带偏；
 * - 反引号里的 `${...}` 插值整段跳过（含嵌套模板字面量、对象字面量、正则），
 *   插入占位符 —— 插值结果不可能是 CSS token 定义；
 * - `\x` 转义按原字符收下（CSS 里没有需要保留反斜杠的场景）。
 *
 * 递归而不是「扫到配对的 }」：该模块的插值里嵌了整张翻译表（含嵌套模板与
 * 花括号），只数花括号会在字符串里的 `}` 上提前收工，后半段全错位。
 */
export function stringLiterals(js) {
  const out = [];
  scanCode(js, 0, js.length, out);
  return out;
}

/** 扫一段「代码」：收集字符串字面量，跳过注释与正则。 */
function scanCode(src, start, end, out) {
  let i = start;
  while (i < end) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl < 0 || nl > end ? end : nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const stop = src.indexOf("*/", i + 2);
      i = stop < 0 ? end : Math.min(end, stop + 2);
      continue;
    }
    if (ch === "/" && isRegexStart(src, i)) {
      i = skipRegex(src, i + 1, end);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const { text, end: next } = scanString(src, i, end);
      if (text.includes("--dsw-alias-") || text.includes("--dsw-static-")) out.push(text);
      i = next;
      continue;
    }
    i += 1;
  }
}

/** 读一个字符串字面量，返回内容与其后第一个字符的下标。 */
function scanString(src, start, end) {
  const quote = src[start];
  let i = start + 1;
  let text = "";
  while (i < end) {
    const c = src[i];
    if (c === "\\") {
      text += src[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (c === quote) return { text, end: i + 1 };
    if (quote === "`" && c === "$" && src[i + 1] === "{") {
      i = skipInterpolation(src, i + 2, end);
      text += "\u0000interp\u0000";
      continue;
    }
    text += c;
    i += 1;
  }
  return { text, end };
}

/** 从 `${` 之后开始，跳到与之配对的 `}` 之后（其中的字符串/正则各自跳过）。 */
function skipInterpolation(src, start, end) {
  let depth = 1;
  let i = start;
  while (i < end) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl < 0 || nl > end ? end : nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const stop = src.indexOf("*/", i + 2);
      i = stop < 0 ? end : Math.min(end, stop + 2);
      continue;
    }
    if (ch === "/" && isRegexStart(src, i)) {
      i = skipRegex(src, i + 1, end);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = scanString(src, i, end).end;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return end;
}

/** 粗略判断 `/` 是不是正则字面量的开头（看前一个有效字符）。 */
function isRegexStart(src, i) {
  for (let k = i - 1; k >= 0; k -= 1) {
    const c = src[k];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    return "=([{,;:!&|?+-*%^~<>".includes(c);
  }
  return true;
}

/** 跳到正则字面量结束（含 flags），返回其后下标。 */
function skipRegex(src, start, end) {
  let i = start;
  let inClass = false;
  while (i < end) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i += 1;
      while (i < end && /[a-z]/i.test(src[i])) i += 1;
      return i;
    } else if (c === "\n") return i;
    i += 1;
  }
  return end;
}

/**
 * 从一段 CSS 文本里挑出「定义了 token」的块，保留声明顺序并去重。
 * 只引用不定义的组件样式块（`.x{color:var(--dsw-alias-…)}`）会被判据自然剔除。
 */
export function tokenBlocks(cssText) {
  const blocks = [];
  for (const m of cssText.matchAll(/([^{}]{1,300})\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    const body = m[2];
    if (!SELECTOR_OK.test(selector)) continue;
    if (!/--dsw-(?:alias|static)-[\w-]+\s*:/.test(body)) continue;
    blocks.push(`${selector}{${body.trim()}}`);
  }
  return blocks;
}

/**
 * 生成 theme.css 全文。片段逐段解析（不同模板字面量之间不做拼接，避免块跨界）。
 */
export function buildThemeCss(fragments) {
  const seen = new Set();
  const blocks = [];
  for (const fragment of fragments) {
    for (const block of tokenBlocks(fragment)) {
      if (seen.has(block)) continue;
      seen.add(block);
      blocks.push(block);
    }
  }
  return { css: HEADER + blocks.join("\n") + "\n", blocks };
}

/**
 * 自检：坏 CSS 必须在构建期炸掉，而不是发到手机上让用户看到「一片黑」。
 * 判据挑的都是「少一条就必然坏」的项，不做覆盖率表演。
 */
export function assertThemeCss(css) {
  const problems = [];
  if (css.includes("`")) problems.push("含反引号（JS 模板字面量胶水漏进来了）");
  if (/\bvar\s+[A-Za-z_$][\w$]*\s*=/.test(css)) problems.push("含 `var x=` 形态的 JS 赋值");
  if (/\u0000/.test(css)) problems.push("含模板插值占位符");

  const must = [
    "--dsw-static-neutral-bluish-00:",
    "--dsw-static-neutral-bluish-950:",
    "--dsw-alias-bg-base:",
    "--dsw-alias-bg-layer-1:",
    "--dsw-alias-label-primary:",
    "--dsw-alias-border-l1:",
  ];
  for (const token of must) {
    if (!css.includes(token)) problems.push(`缺少关键 token：${token}`);
  }
  if (!/body\s*\[data-ds-dark-theme\]\s*\{/.test(css)) {
    problems.push("缺少深色块 body[data-ds-dark-theme]");
  }

  // 引用闭合：theme.css 里出现的每个 var(--dsw-*) 都必须在本文件里有定义。
  // 这条正是 0.9.57 事故的直接判据 —— 浅色 block 丢了一整层 static。
  const defined = new Set([...css.matchAll(/(--dsw-[\w-]+)\s*:/g)].map((m) => m[1]));
  const missing = new Set();
  for (const m of css.matchAll(/var\(\s*(--dsw-[\w-]+)/g)) {
    if (!defined.has(m[1])) missing.add(m[1]);
  }
  if (missing.size) problems.push(`引用了未定义的 token：${[...missing].sort().join("、")}`);

  if (problems.length) {
    throw new Error(`theme.css 自检未通过：\n  - ${problems.join("\n  - ")}`);
  }
  return css;
}

/** 从「asar 路径 → { data }」映射里抽主题 CSS；模块不在闭包内时返回 null。 */
export function themeCssFromAsarFiles(asarFiles) {
  // 键的形态取决于调用方：装配闭包用 `lib/node_modules/…`（运行时布局），
  // 直接读上游 asar 时是 `dsh/node_modules/…`。按后缀认，两边都能命中。
  const suffix = "dsh-client-ui-theme/lib/client.js";
  let entry = asarFiles.get(THEME_CLIENT_PATH);
  if (!entry) {
    for (const [key, value] of asarFiles) {
      if (key.endsWith(suffix)) { entry = value; break; }
    }
  }
  if (!entry) return null;
  const fragments = stringLiterals(entry.data.toString("utf8"));
  if (!fragments.length) return null;
  const { css, blocks } = buildThemeCss(fragments);
  assertThemeCss(css);
  return { css, blocks: blocks.length };
}
