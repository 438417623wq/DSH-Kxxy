#!/usr/bin/env node
/**
 * modern.js 单测：在「模拟 WebView 104」的沙箱里求值补齐层，断言
 *   1) 缺失的内建被补齐、已有的不被覆盖；
 *   2) `URL.createObjectURL` 被包装，且只对 script / html 两类 blob 前置代码；
 *   3) 前置出去的那段源码**独立可执行** —— 这是最关键的一条：它会被塞进
 *      blob worker / blob iframe 的独立全局，若它引用了本文件作用域里的任何
 *      变量，在真机上只会表现为「PDF 渲染进程无法继续」而没有任何本地报错。
 *
 * 用法：node tools/test-modern.mjs [modern.js 路径]
 *
 * 实现要点：每个「104 沙箱」都是一个**独立的 vm realm**。降级操作（delete
 * 内建）必须在该 realm 内执行 —— 在宿主里 `sandbox.Promise = Promise` 再删
 * `withResolvers` 会改到宿主自己的 Promise，测出来的失败是假的。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODERN = resolve(process.argv[2] ?? join(HERE, "..", "plugins", "kxxy-host", "web", "modern.js"));

const source = readFileSync(MODERN, "utf8");
let failures = 0;
const fail = (m) => {
  failures += 1;
  console.log(`  ✗ ${m}`);
};
const ok = (m) => console.log(`  ✓ ${m}`);
const assert = (cond, m) => (cond ? ok(m) : fail(m));

// ── 版本标记 ────────────────────────────────────────────────────────────
console.log("[1] 版本标记");
{
  const m = /^\/\* (kxxy-modern@\d+) \*\//.exec(source);
  assert(m !== null, `首行版本标记存在（${m?.[1] ?? "无"}）`);
  const kotlin = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"),
    "utf8",
  );
  const km = /MODERN_LAYER_MARKER\s*=\s*"([^"]+)"/.exec(kotlin);
  assert(km !== null, "RuntimeInstaller.kt 定义了 MODERN_LAYER_MARKER");
  assert(km?.[1] === m?.[1], `标记与 Kotlin 一致（${m?.[1]} vs ${km?.[1]}）`);
  const sim = readFileSync(join(HERE, "simulate-install.mjs"), "utf8");
  const sm = /MODERN_LAYER_MARKER\s*=\s*"([^"]+)"/.exec(sim);
  assert(sm?.[1] === m?.[1], `标记与 simulate-install.mjs 一致（${m?.[1]} vs ${sm?.[1]}）`);
}

/** 在 realm 内建一个「像 WebView 104 一样缺东西」的全局。 */
const DEGRADE = `
  globalThis.__created = [];
  // 104 没有 Iterator / AsyncIterator 这两个全局
  try { delete globalThis.Iterator } catch (e) {}
  try { delete globalThis.AsyncIterator } catch (e) {}
  // 104 没有这些原型方法
  try { delete Promise.withResolvers } catch (e) {}
  try { delete Promise.try } catch (e) {}
  try { delete Array.fromAsync } catch (e) {}
  try { delete Object.groupBy } catch (e) {}
  try { delete Map.groupBy } catch (e) {}
  try { delete Map.prototype.getOrInsert } catch (e) {}
  try { delete Map.prototype.getOrInsertComputed } catch (e) {}
  try { delete WeakMap.prototype.getOrInsert } catch (e) {}
  try { delete WeakMap.prototype.getOrInsertComputed } catch (e) {}
  try { delete Set.prototype.union } catch (e) {}
  try { delete Set.prototype.intersection } catch (e) {}
  try { delete Set.prototype.difference } catch (e) {}
  try { delete Array.prototype.toSorted } catch (e) {}
  try { delete String.prototype.isWellFormed } catch (e) {}
  try { delete RegExp.escape } catch (e) {}
  try { delete Uint8Array.fromBase64 } catch (e) {}
  try { delete Uint8Array.prototype.toHex } catch (e) {}
  // transfer 族：ArrayBuffer.prototype.transfer 是 114、TypedArray 的 transfer /
  // transferToFixedLength 是 137。104 全都没有 —— 而 pdf.js 的 compileFontInfo
  // 结尾正是 arrayBuffer.transferToFixedLength(len)，缺它就抛
  // UnknownErrorException，PDF 画布永久空白（真机实测钉死）。
  try { delete ArrayBuffer.prototype.transfer } catch (e) {}
  try { delete ArrayBuffer.prototype.transferToFixedLength } catch (e) {}
  try { delete Object.getPrototypeOf(Uint8Array.prototype).transfer } catch (e) {}
  try { delete Object.getPrototypeOf(Uint8Array.prototype).transferToFixedLength } catch (e) {}
  // Math.sumPrecise 是 Chrome 138 提案（Node 24 也没有）。pdf.js worker 的
  // Glyph.getSize()/CompositeGlyph.getSize()/nameTable 共 5 处调用它来算重建后的
  // 字体表长度；缺它 ⇒ checkAndRepair 抛 TypeError ⇒ FontFaceObject.missingFile
  // 变 true、toFontChar 为空 ⇒ 字形退化成 String.fromCodePoint(charcode)，
  // 于是 Office 画成 O f ce（真机 + Node 双侧复现钉死）。
  try { delete Math.sumPrecise } catch (e) {}
  // createObjectURL 只记录内容，不真的建 URL
  globalThis.Blob = class Blob {
    constructor(parts, opts) {
      this.parts = parts;
      this.type = (opts && opts.type) || "";
    }
    text() {
      return Promise.resolve(
        this.parts.map(function (p) { return typeof p === "string" ? p : (p.__text || "") }).join(""),
      );
    }
  };
  globalThis.URL = function URL() {};
  globalThis.URL.createObjectURL = function createObjectURL(blob) {
    globalThis.__created.push(blob);
    return "blob:http://127.0.0.1:3080/fake";
  };
`;

/** 建一个降级后的 104 沙箱；返回 { ctx, run, created }。 */
function makeSandbox104() {
  // 注意：Node 的 vm 新上下文里没有 structuredClone（浏览器 98+ 有），
  // 而 transfer / transferToFixedLength 要靠它分离原缓冲，所以把宿主的注入进去 ——
  // 这正好等价于 104 上原生存在 structuredClone 的真实情况。
  const ctx = vm.createContext({ structuredClone });
  vm.runInContext(DEGRADE, ctx, { filename: "degrade-104.js" });
  return {
    ctx,
    run: (code, name) => vm.runInContext(code, ctx, { filename: name ?? "eval.js" }),
    created: () => vm.runInContext("globalThis.__created", ctx),
  };
}

console.log("[2] 页面主作用域补齐");
{
  const box = makeSandbox104();
  try {
    box.run(source, "modern.js");
    ok("求值未抛错");
  } catch (e) {
    fail(`求值抛错：${e.message}`);
  }
  assert(box.run("typeof Iterator") === "function", "全局 Iterator 已补齐");
  assert(box.run("typeof AsyncIterator") === "function", "全局 AsyncIterator 已补齐");
  assert(box.run("typeof Map.prototype.getOrInsertComputed") === "function", "Map.prototype.getOrInsertComputed 已补齐");
  assert(box.run("typeof Map.prototype.getOrInsert") === "function", "Map.prototype.getOrInsert 已补齐");
  assert(box.run("typeof WeakMap.prototype.getOrInsertComputed") === "function", "WeakMap.prototype.getOrInsertComputed 已补齐");
  assert(box.run("typeof Promise.withResolvers") === "function", "Promise.withResolvers 已补齐");
  assert(box.run("typeof Promise.try") === "function", "Promise.try 已补齐");
  assert(box.run("typeof Array.fromAsync") === "function", "Array.fromAsync 已补齐");
  assert(box.run("typeof Object.groupBy") === "function", "Object.groupBy 已补齐");
  assert(box.run("typeof Set.prototype.union") === "function", "Set.prototype.union 已补齐");
  assert(box.run("typeof Array.prototype.toSorted") === "function", "Array.prototype.toSorted 已补齐");
  assert(box.run("typeof String.prototype.isWellFormed") === "function", "String.prototype.isWellFormed 已补齐");
  assert(box.run("typeof RegExp.escape") === "function", "RegExp.escape 已补齐");
  assert(box.run("typeof Uint8Array.fromBase64") === "function", "Uint8Array.fromBase64 已补齐");
  assert(box.run("typeof Uint8Array.prototype.toHex") === "function", "Uint8Array.prototype.toHex 已补齐");
  assert(box.run("typeof ArrayBuffer.prototype.transfer") === "function", "ArrayBuffer.prototype.transfer 已补齐");
  assert(box.run("typeof ArrayBuffer.prototype.transferToFixedLength") === "function", "ArrayBuffer.prototype.transferToFixedLength 已补齐");
  assert(box.run("typeof Uint8Array.prototype.transferToFixedLength") === "function", "Uint8Array.prototype.transferToFixedLength 已补齐");
  assert(box.run("typeof Uint8Array.prototype.transfer") === "function", "Uint8Array.prototype.transfer 已补齐");
  assert(box.run("typeof Math.sumPrecise") === "function", "Math.sumPrecise 已补齐");
  // Math.sumPrecise 的行为：精确求和（朴素求和在 1e16 量级会丢 1）
  assert(
    box.run("Math.sumPrecise([0.1, 0.2, 0.3])") === 0.6,
    "Math.sumPrecise 求和正确（0.1+0.2+0.3 === 0.6）",
  );
  assert(
    box.run("Math.sumPrecise([1e16, 1, -1e16])") === 1,
    "Math.sumPrecise 补偿误差（1e16+1-1e16 === 1）",
  );
  assert(
    box.run("Math.sumPrecise([])") === 0,
    "Math.sumPrecise 空集返回 0",
  );
  assert(
    box.run("Math.sumPrecise(new Uint8Array([1,2,3]))") === 6,
    "Math.sumPrecise 接受任意可迭代对象",
  );
  assert(
    box.run("(function(){try{Math.sumPrecise(null);return 'no'}catch(e){return e.constructor.name}})()") === "TypeError",
    "Math.sumPrecise 对 null 抛 TypeError",
  );
  assert(
    box.run("(function(){try{Math.sumPrecise(['a']);return 'no'}catch(e){return e.constructor.name}})()") === "TypeError",
    "Math.sumPrecise 对非数字抛 TypeError",
  );
  // 真机报错的字面量：pdf.js worker 的第一行就是这句
  assert(
    box.run("typeof Iterator.prototype.join") === "function",
    "Iterator.prototype.join 已补齐（pdf.js worker 首行的判据）",
  );
  assert(box.run("globalThis.__kxxyModernInstalled") === true, "幂等标记已置位");
  // 行为抽查（不是只测 typeof）
  assert(box.run("[...Iterator.from([1,2,3]).map(function (x) { return x * 2 })]").join(",") === "2,4,6", "Iterator.from + map 可用");
  assert(box.run("Iterator.from(['a','b']).join('-')") === "a-b", "Iterator.prototype.join 行为正确");
  assert(box.run("Iterator.from([1,2,3,4]).filter(function (x) { return x % 2 === 0 }).toArray()").join(",") === "2,4", "Iterator filter + toArray 可用");
  assert(box.run("new Map().getOrInsertComputed('k', function () { return 7 })") === 7, "getOrInsertComputed 行为正确");
  assert(box.run("Array.prototype.toSorted.call([3,1,2]).join(',')") === "1,2,3", "toSorted 不改原数组");
  // transfer 族的行为：定长截断 + 原缓冲分离（pdf.js 拿返回值当结果、靠分离避免复制）
  assert(
    box.run("(function(){var b=new ArrayBuffer(10);new Uint8Array(b).set([1,2,3,4,5,6,7,8,9,10]);var u=b.transferToFixedLength(4);return [u.byteLength, Array.from(new Uint8Array(u)).join(',')].join(':')})()") === "4:1,2,3,4",
    "ArrayBuffer.transferToFixedLength 截断且保留前段字节",
  );
  assert(
    box.run("(function(){var b=new ArrayBuffer(10);var u=b.transfer(4);return [b.detached, u.byteLength].join(':')})()") === "true:4",
    "ArrayBuffer.transfer 分离原缓冲",
  );
  assert(
    box.run("(function(){var u=new Uint8Array([1,2,3,4,5]);var v=u.transferToFixedLength(3);return [v.constructor.name, v.length, Array.from(v).join(',')].join(':')})()") === "Uint8Array:3:1,2,3",
    "TypedArray.transferToFixedLength 返回同类型视图",
  );
  assert(
    box.run("(function(){var u=new Uint8Array(4);u.transfer(2);return u.buffer.detached})()") === true,
    "TypedArray.transfer 分离底层缓冲",
  );
}

console.log("[3] 幂等与不覆盖");
{
  const box = makeSandbox104();
  box.run(source, "modern.js");
  const before = box.run("Map.prototype.getOrInsertComputed");
  const beforeJoin = box.run("Iterator.prototype.join");
  try {
    box.run(source, "modern.js");
    ok("二次求值未抛错");
  } catch (e) {
    fail(`二次求值抛错：${e.message}`);
  }
  assert(box.run("Map.prototype.getOrInsertComputed") === before, "二次求值未重复定义（幂等）");
  assert(box.run("Iterator.prototype.join") === beforeJoin, "二次求值未重复定义 join（幂等）");
}
{
  // 已有实现必须原样保留：真实设备上 104 可能已有一部分 API，
  // 覆盖它们会让「本来能跑」的代码反而跑不了。
  const ctx = vm.createContext({});
  vm.runInContext(
    `globalThis.__sentinel = function sentinel() {};
     Promise.withResolvers = globalThis.__sentinel;
     globalThis.Iterator = function Iterator() {};
     globalThis.Iterator.prototype = { join: globalThis.__sentinel };
     globalThis.Blob = class Blob { constructor(p, o) { this.parts = p; this.type = (o && o.type) || "" } };
     globalThis.URL = function URL() {};
     globalThis.URL.createObjectURL = function () { return "blob:fake" };`,
    ctx,
  );
  vm.runInContext(source, ctx, { filename: "modern.js" });
  assert(vm.runInContext("Promise.withResolvers === globalThis.__sentinel", ctx), "已有的 Promise.withResolvers 未被覆盖");
  assert(vm.runInContext("Iterator.prototype.join === globalThis.__sentinel", ctx), "已有的 Iterator.prototype.join 未被覆盖");
}

console.log("[4] blob 作用域注入");
{
  const box = makeSandbox104();
  box.run(source, "modern.js");
  const created = box.created();

  box.run("URL.createObjectURL(new Blob([\"self.postMessage('hi')\"], { type: 'text/javascript' }))");
  const jsOut = box.created().at(-1);
  assert(jsOut.parts.length === 2, "script blob 被前置一段代码");
  const injected = typeof jsOut.parts[0] === "string" ? jsOut.parts[0] : "";
  assert(injected.includes("kxxyModernInstall"), "前置内容是补齐层的源码");
  assert(!/<\/script/i.test(injected), "前置内容不含裸 </script");

  box.run("URL.createObjectURL(new Blob([\"<html><body>x</body></html>\"], { type: 'text/html' }))");
  const htmlHead = box.created().at(-1).parts[0];
  assert(box.created().at(-1).parts.length === 2, "html blob 被前置一段代码");
  assert(htmlHead.startsWith("<!doctype html>"), "html 前置片段自带 doctype（避免 quirks 模式）");
  assert(htmlHead.includes('<meta charset="utf-8">'), "html 前置片段声明 charset");
  assert(htmlHead.includes("</script>"), "html 前置片段闭合 script 标签");

  box.run("globalThis.__png = new Blob(['x'], { type: 'image/png' }); URL.createObjectURL(globalThis.__png)");
  assert(box.created().at(-1) === box.run("globalThis.__png"), "非 script/html 的 blob 原样放行");

  box.run("URL.createObjectURL(new Blob(['export{}'], { type: 'module' }))");
  assert(box.created().at(-1).parts.length === 2, "type: module 的 blob 也被注入");

  box.run("URL.createObjectURL(new Blob(['x'], { type: 'text/javascript; charset=utf-8' }))");
  assert(box.created().at(-1).parts.length === 2, "带 charset 参数的 MIME 也能识别");

  assert(box.run("URL.createObjectURL.__kxxyPatched") === true, "包装函数带标记（可判幂等）");
  assert(created.length >= 0, "记录容器可用");
}

console.log("[5] 前置源码可独立执行（模拟 blob worker 的独立全局）");
{
  const box = makeSandbox104();
  box.run(source, "modern.js");
  box.run("URL.createObjectURL(new Blob(['/*worker*/'], { type: 'text/javascript' }))");
  const injected = box.created().at(-1).parts[0];

  // 全新降级沙箱：没有页面作用域里的任何东西，也没有补过 API ——
  // 等价于 worker 的独立全局。
  const bare = makeSandbox104();
  try {
    bare.run(injected, "blob-injected.js");
    ok("前置源码在裸沙箱里求值未抛错");
  } catch (e) {
    fail(`前置源码在裸沙箱里抛错：${e.message}（说明它引用了本文件作用域）`);
  }
  assert(bare.run("typeof Iterator") === "function", "裸沙箱里 Iterator 被补齐");
  assert(bare.run("typeof Iterator.prototype.join") === "function", "裸沙箱里 Iterator.prototype.join 被补齐");
  assert(bare.run("typeof Map.prototype.getOrInsertComputed") === "function", "裸沙箱里 getOrInsertComputed 被补齐");
  assert(bare.run("typeof Promise.withResolvers") === "function", "裸沙箱里 Promise.withResolvers 被补齐");
  // pdf.js worker 的真实首行
  try {
    bare.run(
      '"function"!=typeof Iterator.prototype.join&&(Iterator.prototype.join=function(e){return[...this].join(e)});',
      "pdf-worker-line.js",
    );
    ok("pdf.js worker 首行（Iterator.prototype.join）在补齐后可执行");
  } catch (e) {
    fail(`pdf.js worker 首行在补齐后的沙箱里仍抛错：${e.message}`);
  }
  // HTML 前置片段里的 <script> 内容同样要能独立跑
  const htmlInjected = (() => {
    const b = makeSandbox104();
    b.run(source, "modern.js");
    b.run("URL.createObjectURL(new Blob(['<p>x</p>'], { type: 'text/html' }))");
    const head = b.created().at(-1).parts[0];
    return head.slice(head.indexOf("<script>") + "<script>".length, head.lastIndexOf("</script>"));
  })();
  const bare2 = makeSandbox104();
  try {
    bare2.run(htmlInjected, "blob-html-injected.js");
    ok("HTML 前置片段内联脚本在裸沙箱里求值未抛错");
  } catch (e) {
    fail(`HTML 前置片段内联脚本抛错：${e.message}`);
  }
  assert(bare2.run("typeof Iterator") === "function", "HTML 片段注入后裸沙箱里 Iterator 被补齐");
}

console.log(failures === 0 ? "\n结论：modern.js 单测全部通过" : `\n结论：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
