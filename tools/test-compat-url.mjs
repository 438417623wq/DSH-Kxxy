/**
 * `plugins/kxxy-host/web/compat.js` 里 URL 补丁的离线单测（缺陷 R）。
 *
 * 做法：用 `vm` 造一个「行为等同 Android WebView 104」的沙箱 —— 把 `URL` 换成
 * `Broken104URL`（非特殊协议 + `//authority` 时把 authority 整段折进 pathname，
 * 与真机 probe18 的逐字输出一致），再把**真实的 compat.js** 灌进去执行，最后
 * 断言修补后的取值与规范值一致。
 *
 * 断言期望值全部取自本机 Node 原生 `URL`（即 URL 规范）的实测，不是手写猜测；
 * 改动 compat.js 的 URL 段后必须重跑本测试。
 *
 * 之所以需要这个测试：`smoke-plugin.mjs` 只能做「关键实现是否在场」的文本断言，
 * 覆盖不到语义边界 —— 而这段补丁的边界恰恰是最容易改坏的地方（特殊协议
 * `file:////x`、空 authority、userinfo/port、query 与 fragment）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPAT = process.env.KXXY_COMPAT_JS || join(HERE, "..", "plugins", "kxxy-host", "web", "compat.js");
const NativeURL = globalThis.URL;

const SPECIAL = new Set(["http:", "https:", "ws:", "wss:", "ftp:", "file:"]);
const AUTHORITY_FORM = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/;

/**
 * 复刻 WebView 104 的 URL 行为：凡「非特殊协议 + `//`」→ hostname/host 为空、
 * pathname = `"//"` + `//` 之后的全部内容（query / fragment 除外）。
 */
class Broken104URL {
  constructor(input, base) {
    this._u = new NativeURL(input, base);
    this._folded = false;
    if (typeof input === "string") {
      const m = AUTHORITY_FORM.exec(input);
      if (m && !SPECIAL.has(m[1].toLowerCase() + ":")) {
        this._folded = true;
        this._foldedPath = "//" + m[2].replace(/[?#].*$/, "");
      }
    }
  }
  get protocol() { return this._u.protocol; }
  get href() { return this._u.href; }
  get search() { return this._u.search; }
  get hash() { return this._u.hash; }
  get origin() { return this._u.origin; }
  get port() { return this._u.port; }
  get username() { return this._u.username; }
  get password() { return this._u.password; }
  get searchParams() { return this._u.searchParams; }
  get hostname() { return this._folded ? "" : this._u.hostname; }
  get host() { return this._folded ? "" : this._u.host; }
  get pathname() { return this._folded ? this._foldedPath : this._u.pathname; }
  // 真机 104 的写语义：非特殊协议上这些 setter 是无操作（probe18 B1 实测：
  // 给 dsh-resource 实例写 pathname 后 href 不变），特殊协议上正常生效。
  // 这里照实复刻，测试才能验出「补丁是否原样保留了 setter」。
  set hostname(v) { if (!this._folded) this._u.hostname = v; }
  set host(v) { if (!this._folded) this._u.host = v; }
  set pathname(v) { if (!this._folded) this._u.pathname = v; }
  toString() { return this._u.href; }
  toJSON() { return this._u.href; }
}
Broken104URL.canParse = (url, base) => {
  try { new Broken104URL(url, base); return true } catch { return false }
};

const source = readFileSync(COMPAT, "utf8");

const sandbox = {
  URL: Broken104URL,
  AbortSignal: globalThis.AbortSignal,
  AbortController: globalThis.AbortController,
  Promise, Object, Array, Set, Map, String, Number, Math, JSON, Symbol,
  Uint8Array, Int8Array, RangeError, TypeError, Error, DOMException,
  setTimeout, clearTimeout, console,
  document: { querySelectorAll: () => [] },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// 执行两次：既验证幂等（第二次运行时探测式应已为假），也确保重复注入无害。
vm.runInContext(source, sandbox, { filename: "compat.js#1" });
vm.runInContext(source, sandbox, { filename: "compat.js#2" });

const U = sandbox.URL;

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

const probe = (input) => {
  const u = new U(input);
  return { host: u.host, hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash };
};

// 期望值全部取自 Node 原生 URL（= URL 规范）的实测输出
const CASES = [
  // —— 必须被修正：非特殊协议的 authority 被折进了 pathname ——
  ["dsh-resource://file/session/abc/whale.html", { host: "file", hostname: "file", pathname: "/session/abc/whale.html", search: "", hash: "" }],
  ["dsh-resource://file/session/abc/images/image1.png", { host: "file", hostname: "file", pathname: "/session/abc/images/image1.png", search: "", hash: "" }],
  ["dsh-resource://file/session/abc/test-files/%E8%A1%A8%E6%A0%BC.xlsx", { host: "file", hostname: "file", pathname: "/session/abc/test-files/%E8%A1%A8%E6%A0%BC.xlsx", search: "", hash: "" }],
  ["dsh-resource://file/", { host: "file", hostname: "file", pathname: "/", search: "", hash: "" }],
  ["dsh-resource://file", { host: "file", hostname: "file", pathname: "", search: "", hash: "" }],
  ["dsh-resource://FILE/x", { host: "FILE", hostname: "FILE", pathname: "/x", search: "", hash: "" }],
  ["dsh-resource://subagentchat/session/s1?parent=p#frag", { host: "subagentchat", hostname: "subagentchat", pathname: "/session/s1", search: "?parent=p", hash: "#frag" }],
  ["dsh-resource://plan/y", { host: "plan", hostname: "plan", pathname: "/y", search: "", hash: "" }],
  ["dsh-resource://changes-review/session/s1/a.md", { host: "changes-review", hostname: "changes-review", pathname: "/session/s1/a.md", search: "", hash: "" }],
  ["dsh-attachment://x/y", { host: "x", hostname: "x", pathname: "/y", search: "", hash: "" }],
  // 空 authority：104 把分隔用的两个斜杠也留进了 pathname，规范丢弃它们
  ["dsh-resource://", { host: "", hostname: "", pathname: "", search: "", hash: "" }],
  ["dsh-resource:///file/x", { host: "", hostname: "", pathname: "/file/x", search: "", hash: "" }],
  ["dsh-resource:////x", { host: "", hostname: "", pathname: "//x", search: "", hash: "" }],
  // 无 `//`：不受影响
  ["dsh-resource:file/x", { host: "", hostname: "", pathname: "file/x", search: "", hash: "" }],
  // userinfo 与端口：host 含端口、hostname 不含
  ["foo://user:pw@h:8080/p?q=1#h", { host: "h:8080", hostname: "h", pathname: "/p", search: "?q=1", hash: "#h" }],
  ["foo://user@h/p", { host: "h", hostname: "h", pathname: "/p", search: "", hash: "" }],
  // —— 必须不受影响：特殊协议或本来就无 authority ——
  ["https://file/session/abc", { host: "file", hostname: "file", pathname: "/session/abc", search: "", hash: "" }],
  ["http://127.0.0.1:3080/api/file?path=x", { host: "127.0.0.1:3080", hostname: "127.0.0.1", pathname: "/api/file", search: "?path=x", hash: "" }],
  ["file:///session/abc", { host: "", hostname: "", pathname: "/session/abc", search: "", hash: "" }],
  // ★ 特殊协议守卫：`file:////x` 的 host 本来就该是空、path 本来就该以 `//` 开头，
  //   补丁绝不能把 authority 还原成 "x"。
  ["file:////x", { host: "", hostname: "", pathname: "//x", search: "", hash: "" }],
  ["file://x/y", { host: "x", hostname: "x", pathname: "/y", search: "", hash: "" }],
  ["about:blank", { host: "", hostname: "", pathname: "blank", search: "", hash: "" }],
  ["data:text/plain,hi", { host: "", hostname: "", pathname: "text/plain,hi", search: "", hash: "" }],
  ["blob:http://127.0.0.1:3080/abc", { host: "", hostname: "", pathname: "http://127.0.0.1:3080/abc", search: "", hash: "" }],
  ["javascript:void 0", { host: "", hostname: "", pathname: "void 0", search: "", hash: "" }],
];

console.log(`compat.js 来源：${COMPAT}`);
console.log("\n[1] URL 补丁：取值正确性");
for (const [input, expected] of CASES) check(input, probe(input), expected);

console.log("\n[2] 回归：instanceof / searchParams / 静态方法 / 只包 getter");
check("instanceof URL 成立", new U("dsh-resource://file/x") instanceof U, true);
check("searchParams 可用", new U("dsh-resource://file/a?token=t1").searchParams.get("token"), "t1");
check("URL.canParse 仍是函数", typeof U.canParse, "function");
check("protocol 未受影响", new U("dsh-resource://file/x").protocol, "dsh-resource:");
check("href 未受影响（104 上本就正确）", new U("dsh-resource://file/x").href, "dsh-resource://file/x");
check("toString 未受影响", String(new U("dsh-resource://file/x")), "dsh-resource://file/x");
// setter 必须原样保留：非特殊协议上 104 本就是无操作，特殊协议上必须仍生效。
const writable = new U("dsh-resource://file/x");
writable.pathname = "/y";
check("非特殊协议的 pathname setter 仍是无操作（与 104 一致）", writable.href, "dsh-resource://file/x");
const writableHref = new U("https://h/a");
writableHref.pathname = "/b";
check("特殊协议的 pathname setter 未被破坏（setter 已原样转发）", writableHref.href, "https://h/b");

console.log("\n[3] 修正后地址可被官方 protocolOf 正确识别（缺陷 R 的直接判据）");
const protocolOf = (address) => {
  const parsed = new U(address);
  if (parsed.protocol !== "dsh-resource:") return undefined;
  return parsed.hostname === "" ? undefined : parsed.hostname.toLowerCase();
};
check("file 协议", protocolOf("dsh-resource://file/session/abc/whale.html"), "file");
check("subagentchat 协议", protocolOf("dsh-resource://subagentchat/session/s1"), "subagentchat");
check("plan 协议", protocolOf("dsh-resource://plan/y"), "plan");
check("非 dsh-resource 返回 undefined", protocolOf("https://x/y"), undefined);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
