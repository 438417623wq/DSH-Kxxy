/**
 * `tools/lib/patches.mjs` 的 `patchNativeCommandAndroid` 离线单测（缺陷 DF）。
 *
 * 做法：把**真实的上游文件**（`@deepseek-ai/dsh-native-command/lib/index.js`）
 * 灌进 `createPatchContext`，跑补丁，然后断言：
 *   ① 五处锚点全部命中（锚点对不上时 `replaceOnce` 会硬失败，本测试因此也
 *      是「上游改版预警器」）；
 *   ② 补丁后的语义正确 —— 用 `vm` 把打补丁的模块求值一遍，喂
 *      `platform: "android"` 的 internals，断言 `canOpenNativePath()` 为真、
 *      `nativeFileManager()` 为 `"directory"`、打开动作真的调用了
 *      `<root>/libexec/termux-api Open <path>`、关联查询返回单个「系统默认」
 *      条目；
 *   ③ 幂等性之外最重要的一条：**非 android 平台行为逐字不变**。
 *
 * 为什么必须有这个测试：这条补丁改的是上游文件里四个互不相邻的函数，任何
 * 一处锚点漂移都会让「点 APK 没反应」在设备上静默复现，而构建日志里只有
 * 一行「跳过（依赖树无 dsh-native-command）」。只验「文件里出现了 android
 * 字样」是不够的 —— 那对语义一无所知。
 *
 * 用法：
 *   node tools/test-native-command.mjs [上游 index.js 路径]
 * 默认从 DSH Desktop 的 asar 解出的 node_modules 里找（见 UPSTREAM_CANDIDATES）。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { createPatchContext, patchNativeCommandAndroid } from "./lib/patches.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认候选：桌面版 DSH 的 node_modules（构建期就是从 app.asar 抽的同一份）。 */
const UPSTREAM_CANDIDATES = [
  process.env.DSH_NATIVE_COMMAND,
  "C:/KF/deepseek harness/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-native-command/lib/index.js",
].filter(Boolean);

function locate() {
  for (const candidate of UPSTREAM_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let pass = 0;
let fail = 0;
const ok = (label) => {
  pass += 1;
  console.log(`  ✓ ${label}`);
};
const bad = (label, detail) => {
  fail += 1;
  console.log(`  ✗ ${label}${detail === undefined ? "" : `\n      ${detail}`}`);
};
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(label);
  else bad(label, `实际 ${a}\n      期望 ${e}`);
};

const upstream = locate();
if (upstream === null) {
  console.log("✗ 找不到上游 dsh-native-command/lib/index.js");
  console.log("  设 DSH_NATIVE_COMMAND=<path>，或确认 DSH Desktop 的 node_modules 在位");
  process.exit(1);
}
console.log(`上游来源：${upstream}\n`);

// ── 1. 跑补丁 ────────────────────────────────────────────────────────────

const KEY = "lib/node_modules/@deepseek-ai/dsh-native-command/lib/index.js";
const files = new Map([[KEY, { data: readFileSync(upstream), mode: 0o644 }]]);
const ctx = createPatchContext(files);

let summary = null;
try {
  summary = patchNativeCommandAndroid(ctx);
  ok(`补丁执行成功：${summary}`);
} catch (error) {
  bad("补丁执行失败（锚点漂移？）", error.message);
  process.exit(1);
}

const patched = ctx.read("@deepseek-ai/dsh-native-command/lib/index.js");
check("补丁确有改动", patched !== readFileSync(upstream, "utf8"), true);

// ── 2. 锚点覆盖：五个函数各自带上 android 分支 ───────────────────────────

console.log("\n[2] 锚点覆盖");
const expectations = [
  ["canOpenNativePath", 'if (platform === "android") return true;'],
  ["nativeFileManager", 'if (platform === "android") return "directory";'],
  ["androidOpener", "function androidOpener()"],
  ["openNativePathWithIntent", 'await run(androidOpener(), ["Open", path], signal, "hidden");'],
  ["revealNativePath", 'await run(androidOpener(), ["Open", dirname(path)], signal, "hidden");'],
  ["nativeFileApplications", 'if (target.platform === "android") return [{'],
  ["openNativeFileApplication", 'if (target.platform === "android") {'],
];
for (const [label, needle] of expectations) {
  if (patched.includes(needle)) ok(`${label} 分支在场`);
  else bad(`${label} 分支缺失`, `找不到：${needle}`);
}

// ── 3. 语义：把补丁后的模块求值一遍 ──────────────────────────────────────

console.log("\n[3] 语义（vm 求值真实模块）");

/**
 * 在受控沙箱里求值补丁后的 ESM。
 *
 * 上游模块只 import 了 node 内置模块，但 `node:fs/promises` 之类在 vm 里
 * 没法直接解析。做法是把 import 段替换成等价的 `require` 桩（本测试只关心
 * 五个纯函数，不需要真实的 fs）。
 */
function evaluate(source) {
  const withoutImports = source.replace(/^import[^;]*;\s*$/gm, "");
  const wrapper = `
"use strict";
const { dirname, extname, isAbsolute, join, relative, sep } = require("node:path");
const { pathToFileURL } = require("node:url");
const { release: osRelease } = require("node:os");
const { execFile } = require("node:child_process");
const { mkdtemp, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const { homedir, release, tmpdir } = require("node:os");
${withoutImports.replace(/^export \{[^}]*\};?\s*$/gm, "")}
module.exports = { canOpenNativePath, nativeFileManager, nativeOpenPathProbe: openNativePath, nativeFileApplications, openNativeFileApplication, revealNativePath };
`;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (id) => {
      if (id === "node:path") return require$path();
      if (id === "node:url") return require$url();
      if (id === "node:os") return require$os();
      if (id === "node:child_process") return { execFile: () => { throw new Error("not used"); } };
      if (id === "node:fs/promises") return {};
      throw new Error(`unexpected require ${id}`);
    },
    process,
    console,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(wrapper, sandbox, { filename: "native-command-patched.js" });
  return sandbox.module.exports;
}

// 沙箱里的 require 不能直接用宿主的，否则会拿到宿主的全局状态；
// 这里用 createRequire 明确从 tools/ 解析。
import { createRequire } from "node:module";
const nodeRequire = createRequire(import.meta.url);
const require$path = () => nodeRequire("node:path");
const require$url = () => nodeRequire("node:url");
const require$os = () => nodeRequire("node:os");

let mod = null;
try {
  mod = evaluate(patched);
  ok("补丁后的模块可求值");
} catch (error) {
  bad("补丁后的模块求值失败", error.message);
}

if (mod !== null) {
  check("canOpenNativePath({platform:'android'})", mod.canOpenNativePath({ platform: "android" }), true);
  check("nativeFileManager({platform:'android'})", mod.nativeFileManager({ platform: "android" }), "directory");

  // 非 android 行为必须逐字不变 —— 这是补丁最容易误伤的地方。
  check("canOpenNativePath({platform:'freebsd'})", mod.canOpenNativePath({ platform: "freebsd" }), false);
  check("nativeFileManager({platform:'freebsd'})", mod.nativeFileManager({ platform: "freebsd" }), null);
  check("canOpenNativePath({platform:'linux', env:{}})", mod.canOpenNativePath({ platform: "linux", env: {}, osRelease: "6.1" }), false);
  check("canOpenNativePath({platform:'darwin'})", mod.canOpenNativePath({ platform: "darwin" }), true);

  // 打开动作：记录 run 的调用，断言走的是 androidOpener()。
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    return { stdout: "", stderr: "" };
  };
  const internals = { platform: "android", run, env: {} };
  // 打开器路径来自 KXXY_ENGINE_ROOT（EngineConfig.buildEnv 注入）。这里显式
  // 设一个假根，既验证拼接分支，也避免依赖构建机的真实路径。
  const previousRoot = process.env.KXXY_ENGINE_ROOT;
  process.env.KXXY_ENGINE_ROOT = "/data/user/0/app.kxxy/files/engine";
  // 上游每个入口都先 `signal.throwIfAborted()`；测试必须给一个真实的 signal，
  // 否则量到的是「测试没传参」而不是补丁行为。
  const signal = new AbortController().signal;

  calls.length = 0;
  try {
    await mod.nativeOpenPathProbe("/storage/emulated/0/Download/kxxy/app.apk", signal, internals);
  } catch (error) {
    bad("android 打开动作抛错", error.message);
  }
  check("打开动作调用了 termux-api shim", calls.length === 1 && /libexec[\\/]termux-api$/.test(calls[0][0]), true);
  check("打开动作参数是 [Open, 原路径]", calls[0]?.[1], ["Open", "/storage/emulated/0/Download/kxxy/app.apk"]);

  calls.length = 0;
  try {
    await mod.revealNativePath("/storage/emulated/0/Download/kxxy/app.apk", signal, internals);
  } catch (error) {
    bad("android 显示位置抛错", error.message);
  }
  check("显示位置调用了 termux-api shim", calls.length === 1 && /libexec[\\/]termux-api$/.test(calls[0][0]), true);
  check("显示位置参数是父目录", calls[0]?.[1], ["Open", "/storage/emulated/0/Download/kxxy"]);

  // 关联查询：必须给出恰好一个可渲染的条目（否则分体按钮挂不出来）。
  let apps = null;
  try {
    apps = await mod.nativeFileApplications("/storage/emulated/0/Download/kxxy/app.apk", signal, internals);
  } catch (error) {
    bad("android 关联查询抛错", error.message);
  }
  check("关联查询返回 1 条", Array.isArray(apps) ? apps.length : null, 1);
  check("条目是默认打开方式", apps?.[0]?.default, true);
  check("条目 id 非空", typeof apps?.[0]?.id === "string" && apps[0].id.length > 0, true);
  check("条目 icon 为 null（不伪造图标）", apps?.[0]?.icon, null);

  // 指定 application 打开：Android 上没有关联表，应退化为默认打开。
  calls.length = 0;
  try {
    await mod.openNativeFileApplication(
      "/storage/emulated/0/Download/kxxy/app.apk",
      "android-default",
      signal,
      internals,
    );
  } catch (error) {
    bad("android 指定 application 打开抛错", error.message);
  }
  check("指定 application 仍走 termux-api shim", calls.length === 1 && /libexec[\\/]termux-api$/.test(calls[0][0]), true);
  check(
    "打开器路径按 KXXY_ENGINE_ROOT 拼接",
    calls[0]?.[0],
    "/data/user/0/app.kxxy/files/engine/libexec/termux-api",
  );
  if (previousRoot === undefined) delete process.env.KXXY_ENGINE_ROOT;
  else process.env.KXXY_ENGINE_ROOT = previousRoot;
}

// ── 4. 幂等性：再跑一次必须硬失败（锚点已被替换） ────────────────────────

console.log("\n[4] 重复打补丁");
const twice = new Map([[KEY, { data: Buffer.from(patched, "utf8"), mode: 0o644 }]]);
let threw = false;
try {
  patchNativeCommandAndroid(createPatchContext(twice));
} catch {
  threw = true;
}
check("重复打补丁会硬失败（锚点已消失）", threw, true);

console.log(`\n${fail === 0 ? "结论：全部通过" : `结论：${fail} 项失败`}（${pass} 通过 / ${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);
