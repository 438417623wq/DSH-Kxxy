/**
 * patchSubprocessInspector / patchNodePty 的离线单测。
 *
 * 用真实的 runner-launch-*.js 与真实 prebuilt 产物喂给 createPatchContext，
 * 断言补丁确实改到了该改的地方，且不误伤。
 *
 * runner-launch 的真身只在 runtime 里（构建期从 app.asar 抽取），仓库里没有，
 * 所以默认用下面这份**逐字节照抄上游**的最小 fixture。手上如果有真文件，
 * 用环境变量指过去即可用真文件跑：
 *
 *   $env:DSH_RUNNER_LAUNCH = "F:\path\to\runner-launch-B2zsQ1Dz.js"
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 上游 createProcessInspector 的最小复刻。
 *
 * 锚点行必须与上游逐字节一致（含制表符缩进）—— 这正是 replaceOnce
 * 「锚点必须唯一」所依赖的形态，写成一样才有测试价值。
 */
const FIXTURE = [
  "function createProcessInspector(platform = process.platform, arch = process.arch, internals = DEFAULT_INTERNALS) {",
  '\tif (platform === "linux") return new LinuxProcessInspector(arch, internals);',
  '\tif (platform === "darwin") return new MacProcessInspector(internals);',
  '\tif (platform === "win32") return createWindowsProcessInspector();',
  "\tthrow new Error(`subprocess-local: terminal inspection is unsupported on platform ${platform}`);",
  "}",
  "",
].join("\n");

const realRunner = process.env.DSH_RUNNER_LAUNCH;
const usingReal = Boolean(realRunner) && existsSync(realRunner);
const rlSrc = usingReal ? readFileSync(realRunner, "utf8") : FIXTURE;
// 动态 import 真实的 patches.mjs
const mod = await import("file:///" + join(HERE, "lib", "patches.mjs").replace(/\\/g, "/"));
const { createPatchContext, applyAllPatches } = mod;

const NM = "lib/node_modules/";
const files = new Map();

// 1) runner-launch（设备上文件名带内容 hash，所以补丁按前缀定位）
files.set(
  NM + "@deepseek-ai/dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js",
  { data: rlSrc, mode: 0o644 },
);
// 2) 让 patchNodePty 的 ctx.exists("node-pty") 为真
files.set(NM + "node-pty/package.json", { data: Buffer.from("{}"), mode: 0o644 });
files.set(NM + "node-pty/lib/index.js", { data: Buffer.from("// old shim"), mode: 0o644 });
// 3) 让其它补丁全部走「跳过」分支，聚焦本次两条
files.set(NM + "@deepseek-ai/dsh/package.json", {
  data: Buffer.from(JSON.stringify({ name: "@deepseek-ai/dsh", dependencies: {} })),
  mode: 0o644,
});

const ctx = createPatchContext(files);
const results = applyAllPatches(files, () => null);

let pass = 0;
let fail = 0;
function check(ok, label) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}`);
  }
}

console.log(`runner-launch 来源：${usingReal ? `真实文件 ${realRunner}` : "内置 fixture"}`);
console.log("补丁返回：");
for (const r of results) console.log(`  - ${r}`);

console.log("\n[1] patchSubprocessInspector");
const patchedKey = NM + "@deepseek-ai/dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js";
const patched = files.get(patchedKey).data.toString("utf8");
check(patched.includes(`if (platform === "linux" || platform === "android") return new LinuxProcessInspector(arch, internals);`), "android 分支已注入");
check(patched.includes(`throw new Error(\`subprocess-local: terminal inspection is unsupported on platform \${platform}\`);`), "原有抛错分支保留（其它平台仍拒绝）");
check(patched.length - rlSrc.length === ` || platform === "android"`.length, `仅增量 ${` || platform === "android"`.length} 字节（实际 ${patched.length - rlSrc.length}）`);
check(patched.split(`platform === "android"`).length - 1 === 1, "android 只出现一次");

console.log("\n[2] patchNodePty");
const npIndex = files.get(NM + "node-pty/lib/index.js").data.toString("utf8");
const npPkg = JSON.parse(files.get(NM + "node-pty/package.json").data.toString("utf8"));
const npNode = files.get(NM + "node-pty/prebuilds/android-arm64/dsh_pty_node.node");
check(!npIndex.includes("unavailable in this Android build"), "旧的抛错空壳已被替换");
check(npIndex.includes("class AndroidTerminal"), "JS 包装层已注入");
check(npIndex.includes("native.resize(this._handle, safeRows, safeCols)"), "resize 参数顺序已翻转");
check(npPkg.version === "1.0.0-android-kxxy", "package.json 来自 prebuilt");
check(npNode !== undefined && npNode.data.length === 25192, `原生模块已注入（${npNode?.data.length} B）`);
check(npNode.mode === 0o755, "原生模块 mode = 0755");
check(files.has(NM + "node-pty/src/dsh_pty_node.c"), "C 源码已随包带上");
check(!files.has(NM + "node-pty/lib/index.js.orig"), "未留下多余文件");

console.log("\n[3] 产物与仓库一致");
const repoNode = readFileSync(join(HERE, "prebuilt", "node-pty-android", "prebuilds", "android-arm64", "dsh_pty_node.node"));
check(npNode.data.equals(repoNode), "注入的 .node 与仓库产物逐字节一致");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
