/**
 * Android 兼容补丁：唯一允许触碰上游 dsh 依赖树的地方。
 *
 * 每一条都注明「为什么必须打」与「安全性依据」——静默漏打补丁的代价是
 * 用户设备上出现难以归因的崩溃（参考项目为此发过两次事故版本）。
 *
 * 全部补丁作用在已抽取到磁盘的 dsh 依赖树上，路径基准 = <root>/lib/node_modules。
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

/** 仓库里自带的预编译产物目录（见各 prebuilt 子目录的 README）。 */
const PREBUILT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "prebuilt");

/** 补丁失败必须让整个构建失败：形态变了就等于补丁没打上。 */
function must(cond, message) {
  if (!cond) throw new Error(`补丁失败：${message}`);
}

function replaceOnce(text, from, to, label) {
  const i = text.indexOf(from);
  must(i >= 0, `${label} —— 未找到锚点`);
  must(text.indexOf(from, i + 1) < 0, `${label} —— 锚点出现多次，替换不安全`);
  return text.slice(0, i) + to + text.slice(i + from.length);
}

/**
 * 内存版补丁上下文。
 *
 * dsh 依赖树有 347 MiB / 12,410 个文件，把它整个写到磁盘再读回来纯属浪费；
 * 补丁本身只改 10 个文件。因此统一在 `Map<相对路径, {data, mode}>` 上操作，
 * 路径基准就是运行时根（zip 内路径），即 `lib/node_modules/<pkg>/...`。
 */
export function createPatchContext(files) {
  const NM = "lib/node_modules/";
  const key = (rel) => NM + rel.replace(/^\/+/, "");
  return {
    files,
    exists(rel) {
      const k = key(rel);
      if (files.has(k)) return true;
      // 目录形式的查询（如 "koffi"）：看是否有任何文件位于其下。
      const prefix = k + "/";
      for (const f of files.keys()) if (f.startsWith(prefix)) return true;
      return false;
    },
    read(rel) {
      const e = files.get(key(rel));
      if (!e) throw new Error(`补丁读取失败：文件不存在 ${key(rel)}`);
      return e.data.toString("utf8");
    },
    write(rel, content) {
      const k = key(rel);
      const mode = files.get(k)?.mode ?? 0o644;
      files.set(k, { data: Buffer.from(content, "utf8"), mode });
    },
    /** 从另一个绝对路径复制文件进来（如 Termux 的 bin/rg）。 */
    copy(data, rel, mode = 0o755) {
      files.set(key(rel), { data, mode });
    },
    /** 删除整个包目录。 */
    rmrf(rel) {
      const prefix = key(rel) + "/";
      const pkg = key(rel);
      for (const k of [...files.keys()]) {
        if (k === pkg || k.startsWith(prefix)) files.delete(k);
      }
    },
  };
}

// ------------------------------------------------------------------ 补丁实现

/**
 * 读取仓库内预编译产物。
 *
 * 与 `patchRipgrep` 的 `termuxRead` 不同：那些二进制来自 Termux stage，
 * 构建期只以 sha256 blob 形式存在；而 `tools/prebuilt/` 下的产物是**随仓库
 * 提交**的，直接读磁盘即可。缺文件必须硬失败 —— 否则会产出一个「终端
 * 一点开就报错」的 runtime，而构建日志里看不出任何异常。
 */
function prebuilt(rel) {
  const abs = join(PREBUILT_ROOT, rel);
  must(existsSync(abs), `缺少预编译产物 tools/prebuilt/${rel}`);
  return readFileSync(abs);
}

/**
 * koffi：Win32 FFI 绑定（advapi32 / kernel32），Android 上既没有预编译也不需要。
 * 但**必须打桩而不是删除**：多个包在模块顶层做类型注册
 * （`koffi.struct` / `koffi.pointer` / `koffi.array`），删除会让 import 直接失败。
 * 真实 FFI 调用全部位于 win32 分支内，Android 上永不执行。
 */
function patchKoffi(ctx) {
  if (!ctx.exists("koffi")) return "跳过（依赖树无 koffi）";
  ctx.rmrf("koffi");
  ctx.write("koffi/package.json", `${JSON.stringify({
    name: "koffi",
    version: "0.0.0-android-inert",
    main: "index.js",
  }, null, 2)}\n`);
  ctx.write("koffi/index.js", `"use strict";
/**
 * Android 惰性桩。真实 koffi 是 Win32 FFI（advapi32/kernel32），本平台既没有
 * 可用的预编译包，也没有任何需要它的代码路径 —— 但类型注册发生在部分包的
 * 模块顶层，因此每次属性访问与调用都必须返回一个可继续链式访问的惰性代理，
 * 而不是抛错或返回 undefined。
 */
function inertProxy(tag) {
  const target = function () {};
  return new Proxy(target, {
    get(t, p) {
      if (p === "__esModule") return false;
      if (p === "then") return void 0;
      if (p === Symbol.toPrimitive) return () => tag;
      if (p === "toString") return () => "[inert " + tag + "]";
      if (p === "valueOf") return () => 0;
      if (!Object.prototype.hasOwnProperty.call(t, p)) t[p] = inertProxy(tag + "." + String(p));
      return t[p];
    },
    apply() { return inertProxy(tag); },
    construct() { return {}; },
  });
}
module.exports = inertProxy("koffi");
module.exports.default = module.exports;
`);
  return "koffi → 惰性代理桩（原件已移除）";
}

/**
 * node-pty：唯一真实加载点是 dsh-subprocess-local 的
 * `createLazyRequire("node-pty")`，只在**终端侧栏真正打开**时触发。
 *
 * 上游 node-pty 是完整的原生 PTY 绑定（`posix_openpt` / `forkpty` 的 N-API
 * 实现），官方不发 Android 预编译产物、仓库里也没有源码，因此这里注入一份
 * 自研实现：`tools/prebuilt/node-pty-android/`（纯 C + JS 包装层，
 * 契约与真机验证见该目录 README）。
 *
 * 历史：这个补丁原先写的是「抛错空壳」，理由是「PTY 由 App 侧的
 * libdsh_pty.so 承担」—— 但那是宿主自己的终端面板（`plugins/kxxy-host`）
 * 走的路径，**官方前端侧栏的终端走的是 node-pty**，两者不通。空壳让
 * 「新建终端」必定报错，现已改为注入真实实现。
 */
function patchNodePty(ctx) {
  if (!ctx.exists("node-pty")) return "跳过（依赖树无 node-pty）";
  ctx.rmrf("node-pty");
  // 产物随仓库提交，直接读盘；缺文件硬失败（见 prebuilt 注释）。
  ctx.write("node-pty/package.json", prebuilt("node-pty-android/package.json"));
  ctx.write("node-pty/lib/index.js", prebuilt("node-pty-android/lib/index.js"));
  ctx.write("node-pty/src/dsh_pty_node.c", prebuilt("node-pty-android/src/dsh_pty_node.c"));
  // .node 是 ELF 共享库，权限位必须可执行（与 rg 同理）。
  ctx.copy(
    prebuilt("node-pty-android/prebuilds/android-arm64/dsh_pty_node.node"),
    "node-pty/prebuilds/android-arm64/dsh_pty_node.node",
    0o755,
  );
  return "node-pty → 注入 Android 原生 PTY 实现（arm64，自研 N-API 模块）";
}

/**
 * sherpa-onnx-node：语音识别 / TTS / 说话人分离的 N-API 绑定。
 *
 * 上游 1.13.x 的 `optionalDependencies` 只有 darwin/linux/win 六个平台包，
 * **没有 android**（`sherpa-onnx-linux-arm64` 是 glibc，bionic 上 dlopen 必拒），
 * 所以设备上是「JS 全在、`.node` 没有」—— 调用到才炸，报错还停在
 * `Could not find sherpa-onnx-node. Tried …`，看不出是平台不支持还是文件丢了。
 *
 * 两条路：
 *   · `tools/prebuilt/sherpa-onnx-android/prebuilds/android-arm64/` 里有
 *     `sherpa-onnx.node` → 直接注入（连同两个 .so，见下）；
 *   · 不存在 → 在 `addon.js` 顶部插一段守卫，抛带 `KXXY_SHERPA_UNAVAILABLE`
 *     的错误说明「本构建没有 Android 绑定」，并把该目录的 README 指出来。
 *
 * ⚠️ 注入的是**三个文件**，不是过去以为的一个。绑定本身（`.node`）只是壳，
 * 真正干活的是 `libsherpa-onnx-c-api.so` 与 `libonnxruntime.so`，编译期用
 * `-Wl,-rpath,$ORIGIN` 钉成「同目录查找」。只放 `.node` 会在 dlopen 阶段报
 * `library "libsherpa-onnx-c-api.so" not found`——看着像少了依赖包，
 * 其实是注入时不完整。三个文件必须并列落进 `sherpa-onnx-node/`。
 *
 * 为什么守卫放在 `addon.js` 而不是删包：包的 JS 入口（`sherpa-onnx.js`）还可能
 * 被上层「探测能力」时 require，删包会变成 `MODULE_NOT_FOUND`，比「能力不可用」
 * 更难归因。守卫只在真正 require 原生绑定那一刻抛，语义最接近事实。
 */
function patchSherpaOnnx(ctx) {
  if (!ctx.exists("sherpa-onnx-node")) return "跳过（依赖树无 sherpa-onnx-node）";

  const dir = join(PREBUILT_ROOT, "sherpa-onnx-android/prebuilds/android-arm64");
  const prebuiltNode = join(dir, "sherpa-onnx.node");
  if (existsSync(prebuiltNode)) {
    ctx.copy(readFileSync(prebuiltNode), "sherpa-onnx-node/sherpa-onnx.node", 0o755);
    let injected = 1;
    for (const so of ["libsherpa-onnx-c-api.so", "libonnxruntime.so"]) {
      const p = join(dir, so);
      must(
        existsSync(p),
        `sherpa 预编译目录缺 ${so}（.node 靠 $ORIGIN 找同目录的这两个库，缺一个就 dlopen 失败）`,
      );
      ctx.copy(readFileSync(p), `sherpa-onnx-node/${so}`, 0o644);
      injected += 1;
    }
    return `sherpa-onnx-node → 注入 Android arm64 原生绑定（${injected} 个文件：绑定 + c-api + onnxruntime）`;
  }

  const key = "lib/node_modules/sherpa-onnx-node/addon.js";
  const entry = ctx.files.get(key);
  if (!entry) return "跳过（依赖树无 sherpa-onnx-node/addon.js）";
  const text = entry.data.toString("utf8");
  if (text.includes("KXXY_SHERPA_UNAVAILABLE")) {
    return "已打过（Android 原生绑定缺失的可读错误）";
  }
  const anchor = "const path = require('path');";
  must(
    text.includes(anchor),
    "sherpa-onnx-node/addon.js 的 require('path') 锚点未命中（上游结构已变）",
  );
  const guard = `
// [kxxy] Android：上游没有 Android 预编译绑定，这里把失败原因说清楚（构建期注入，勿手改）。
// 与上游「找不到就 throw」的时机一致，只是错误信息可定位。
if (process.platform === 'android' && !require('fs').existsSync(path.join(__dirname, 'sherpa-onnx.node'))) {
  const err = new Error(
    'sherpa-onnx 的 Android 原生绑定未随此构建提供（上游只发布 linux/darwin/win 预编译包）。' +
    '语音识别 / TTS / 说话人分离暂不可用。' +
    '要启用请按 tools/prebuilt/sherpa-onnx-android/README.md 交叉编译 sherpa-onnx.node 后重新打包。',
  );
  err.code = 'KXXY_SHERPA_UNAVAILABLE';
  throw err;
}
`;
  const out = text.replace(anchor, anchor + guard);
  must(out !== text, "sherpa-onnx-node/addon.js 守卫注入未生效");
  ctx.files.set(key, { data: Buffer.from(out, "utf8"), mode: entry.mode ?? 0o644 });
  return "sherpa-onnx-node → Android 绑定缺失时给可读错误（KXXY_SHERPA_UNAVAILABLE）";
}

/**
 * dsh-subprocess-local 的 `createProcessInspector()` 只认 linux/darwin/win32，
 * 其余平台直接抛 `terminal inspection is unsupported on platform <p>`。
 * 而 Android 上 Node 的 `process.platform` 是 **"android"**（不是 "linux"），
 * 于是三个分支全不命中 —— 终端侧栏一点开就是这个错误。
 *
 * 修复方式不是「让 android 冒充 linux」，而是**复用 LinuxProcessInspector**：
 * 它的实现只依赖 `/proc`（`/proc/<pid>/stat` 的 tpgid、`/proc/<pid>/mem`、
 * `/proc/<pid>/task/<tid>/fdinfo/<epfd>`），Android 全部具备，且
 * `SYSCALLS` 表里 arm64 项齐备（read/pselect/ppoll/epollPwait）。
 * 真机实测：`/proc/self/stat` 与 `/proc/self/mem` 在 app 沙箱内均可读。
 *
 * 定位方式：该文件在 runtime 里带内容 hash
 * （`runner-launch-B2zsQ1Dz.js`），**不能写死文件名**，按前缀找。
 * `createPatchContext` 没有 glob，只能自己遍历键。
 */
function patchSubprocessInspector(ctx) {
  const prefix = "lib/node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner-launch-";
  const matches = [...ctx.files.keys()].filter(
    (k) => k.startsWith(prefix) && k.endsWith(".js"),
  );
  if (matches.length === 0) {
    return "跳过（依赖树无 dsh-subprocess-local/runner-launch-*）";
  }
  must(
    matches.length === 1,
    `dsh-subprocess-local 的 runner-launch-*.js 命中 ${matches.length} 个，无法确定补丁目标`,
  );
  const rel = matches[0].slice("lib/node_modules/".length);
  const src = ctx.read(rel);
  const out = replaceOnce(
    src,
    `\tif (platform === "linux") return new LinuxProcessInspector(arch, internals);`,
    `\tif (platform === "linux" || platform === "android") return new LinuxProcessInspector(arch, internals);`,
    "dsh-subprocess-local 的 createProcessInspector 平台分派",
  );
  must(
    out.includes(`platform === "android"`),
    "subprocess-local 的 android 分支补丁未生效",
  );
  ctx.write(rel, out);
  return `dsh-subprocess-local/${rel.split("/").pop()} → android 复用 LinuxProcessInspector`;
}

/**
 * @deepseek-ai/node-addon-system 的 flock：上游 loadBinding() 显式拒绝
 * 非 linux/darwin 平台（抛 ERR_FLOCK_UNSUPPORTED_PLATFORM），并按
 * `@deepseek-ai/node-addon-system-<platform>-<arch>` 解析原生包 —— Android 没有。
 *
 * 而 dsh-session-persistence-jsonl 在**会话落盘**路径调用 tryLockExclusive，
 * 非 contention 错误会被直接上抛 → 引擎启动即崩、陷入重启循环。
 *
 * 安全性：flock 是跨进程 advisory 锁；沙箱内始终只有一个引擎实例
 * （specialUse 前台服务单例，由 EngineSupervisor 保证）。调用方在加锁后仍
 * 独立比较 fd 与路径的 inode/dev。
 * 契约：不打开、不复制、不关闭 fd —— 所有权归调用方。
 */
function patchFlock(ctx) {
  const rel = "@deepseek-ai/node-addon-system/lib/flock.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 node-addon-system/flock）";
  const src = ctx.read(rel);
  must(src.includes("loadBinding"), "flock.js 形态已变（无 loadBinding）");
  ctx.write(rel, `/**
 * Android 桩：POSIX flock 的原生绑定没有 Android 目标。
 * 见 tools/lib/patches.mjs 的 patchFlock 注释（安全性依据与契约）。
 * @param fd - 调用方持有的 fd；本实现不触碰它。
 */
export async function tryLockExclusive(fd) {
    void fd;
    return;
}
`);
  return "node-addon-system/flock → 恒成功桩";
}

/**
 * node-addon-require-builtin：本体是 872 字节 shim，真正干活的是
 * `node-addon-native-custom-loader` + 各平台预编译的 .node —— **没有 Android 目标**，
 * 且上游 README 明说「Published installs do not ship native sources and
 * fail closed instead of compiling」。
 *
 * 而 dsh-app-boot 的 internalModules() 没有 try/catch：拿不到这个 addon
 * 就抛 `profile resolution: unsupported Node module loader`，引擎完全起不来。
 *
 * 替代方案：引擎启动本来就带 `--expose-internals`（见 EngineProcess.kt），
 * 直接 createRequire 就能拿到 internal/* 内置模块 —— 与上游 web bundle 里
 * `if (execArgv.includes('--expose-internals')) return req(id)` 的 fallback 同源。
 */
function patchRequireBuiltin(ctx) {
  const rel = "node-addon-require-builtin/lib/index.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 node-addon-require-builtin）";
  const src = ctx.read(rel);
  must(src.includes("createEntryApi"), "node-addon-require-builtin 形态已变");
  ctx.write(rel, `"use strict";
/**
 * Android 纯 JS 替代：直接借 Node 的 --expose-internals 拿 internal/* 模块。
 * 见 tools/lib/patches.mjs 的 patchRequireBuiltin 注释。
 */
const { createRequire } = require("node:module");
const req = createRequire(__filename);
function requireBuiltin(moduleId) { return req(moduleId); }
function isAllowedInternalId(moduleId) {
  return typeof moduleId === "string" && moduleId.startsWith("internal/");
}
function getBindingInfo() {
  return { backend: "android-js-fallback", via: "--expose-internals" };
}
exports.requireBuiltin = requireBuiltin;
exports.isAllowedInternalId = isAllowedInternalId;
exports.getBindingInfo = getBindingInfo;
exports.default = { requireBuiltin, isAllowedInternalId, getBindingInfo };
`);
  return "node-addon-require-builtin → --expose-internals 纯 JS 替代";
}

/**
 * dsh-sandbox-local 的两条 glibc-only import：
 *   - `@deepseek-ai/node-addon-system/landlock-run`（平台包无 Android 目标）
 *   - `@deepseek-ai/dsh-sandbox-windows-acl`（Win32 ACL，且会把 koffi 拉进来）
 *
 * 注意上游路径已经演进：参考项目脚本里写的 `@deepseek-ai/node-addon-landlock-run`
 * 是旧版，当前是 `@deepseek-ai/node-addon-system/landlock-run`。
 *
 * 用「常量替换」而不是删 import：这些标识符在文件里真的被引用
 * （LAUNCHER_FAILURE_EXIT / LAUNCHER_BIN 进签名表，grantArgs / probe /
 * launcherPath 进 Linux 链，AclWriteGrant / *Sid / registerAclDiagnosisSkill
 * 进 win32 分支），少补一个就是 ReferenceError。
 *
 * Android 上沙箱走 danger-full-access（EngineConfig 的 DSH_PERMISSION_MODE），
 * dsh-bash-sandbox 会完全跳过 confine()，因此这里只需保证「不崩」。
 */
function patchSandboxLocal(ctx) {
  const rel = "@deepseek-ai/dsh-sandbox-local/lib/index.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 dsh-sandbox-local）";
  let src = ctx.read(rel);

  const landlockRe = /^import\s*\{[^}]*\}\s*from\s*"@deepseek-ai\/node-addon-system\/landlock-run";?[ \t]*$/m;
  must(landlockRe.test(src), "sandbox-local 的 landlock-run import 锚点未命中");
  src = src.replace(landlockRe, [
    '/* Android：landlock-run 平台包没有 Android 目标。probe 返回 "unusable"',
    '   让 chainVerdict 把 landlock 判为不可用（这是正确的降级结论），',
    '   沙箱因此落到 danger-full-access 的跳过分支。 */',
    'const LAUNCHER_BIN = "landlock-run";',
    'const LAUNCHER_FAILURE_EXIT = 125;',
    'const grantArgs = () => [];',
    'const launcherPath = () => "";',
    'const probe = () => "unusable";',
  ].join("\n"));

  const aclRe = /^import\s*\{[^}]*\}\s*from\s*"@deepseek-ai\/dsh-sandbox-windows-acl";?[ \t]*$/m;
  must(aclRe.test(src), "sandbox-local 的 windows-acl import 锚点未命中");
  src = src.replace(aclRe, [
    "/* Android：Win32 ACL 沙箱不适用（也避免把 koffi 拉进解析路径）。 */",
    "const AclWriteGrant = class { static create() { return {}; } };",
    "const assertTempRootOutsideWorkspace = () => {};",
    "const registerAclDiagnosisSkill = () => {};",
    "const tempWriteSid = () => \"\";",
    "const workspaceWriteSid = () => \"\";",
  ].join("\n"));

  must(!/^import[^\n]*node-addon-system\/landlock-run/m.test(src), "landlock import 未被替换");
  ctx.write(rel, src);
  return "dsh-sandbox-local → 摘除 landlock-run 与 windows-acl（补齐全部 10 个标识符）";
}

/**
 * dsh-session-persistence-jsonl：SELinux 在 app 域禁 link()。
 * 用 **import 别名**而不是逐个调用点替换：link 的引用点不止一处 ——
 * 既有 `link(tmp, finalPath)` 调用，也有 defaultFileSystem 的 shorthand
 * 属性 `link,`。逐个替换必然漏（参考项目 v1.2.29 就漏掉 shorthand，
 * 表现为 "link is not defined" → 插件批量 pending）。
 *
 * 这里用 rename 而不是 copyFile：临时文件与目标同目录，rename 具有同样的
 * 原子发布语义，且不会留下临时副本。
 */
function patchSessionJsonl(ctx) {
  const rel = "@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 dsh-session-persistence-jsonl）";
  const src = ctx.read(rel);
  const out = replaceOnce(
    src,
    'import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";',
    'import { rename as link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";',
    "session-persistence-jsonl 的 fs/promises import",
  );
  ctx.write(rel, out);
  return "dsh-session-persistence-jsonl → link 别名到 rename";
}

/**
 * 同一包的 worker.cjs（子进程侧）走的是另一份 fs 表，需要独立的 link 兜底：
 * 先试真 link，撞到 SELinux 的 EACCES/EPERM 时退化为 copyFile。
 * 保持 COPYFILE_EXCL，使「目标已存在」仍是 EEXIST 语义。
 */
function patchSessionJsonlWorker(ctx) {
  const rel = "@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs";
  if (!ctx.exists(rel)) return "跳过（无 worker.cjs）";
  let src = ctx.read(rel);
  src = replaceOnce(
    src,
    'let node_fs_promises = require("node:fs/promises");',
    'let node_fs_promises = require("node:fs/promises");\nlet node_fs = require("node:fs");',
    "worker.cjs 的 fs/promises require",
  );
  src = replaceOnce(
    src,
    "\tlink: node_fs_promises.link,",
    [
      "\tlink: async (source, target) => {",
      "\t\ttry {",
      "\t\t\treturn await node_fs_promises.link(source, target);",
      "\t\t} catch (error) {",
      "\t\t\tconst code = error && typeof error === \"object\" ? error.code : void 0;",
      "\t\t\tif (code !== \"EACCES\" && code !== \"EPERM\" && code !== \"ENOTSUP\" && code !== \"ENOSYS\" && code !== \"EXDEV\" && code !== \"EMLINK\") throw error;",
      "\t\t\tawait node_fs_promises.copyFile(source, target, node_fs.constants.COPYFILE_EXCL);",
      "\t\t}",
      "\t},",
    ].join("\n"),
    "worker.cjs 的 link 表项",
  );
  must(src.includes("COPYFILE_EXCL"), "worker.cjs 补丁未生效");
  ctx.write(rel, src);
  return "dsh-session-persistence-jsonl/worker.cjs → link 兜底 copyFile";
}

/**
 * @vscode/ripgrep：上游 index.js 按 `@vscode/ripgrep-${process.platform}-${arch}`
 * 拼平台包名并 require.resolve。Android 没有官方平台包，但**注入一个同名的本地包
 * 就能零代码补丁命中** —— 对上游 shape 免疫（参考项目早期做文本替换，
 * 上游改版即碎，先后在本地与 CI 翻车两次）。
 *
 * @param termuxRead `(relPath) => Buffer | null`，从 Termux stage 读文件。
 *   刻意不用磁盘路径：stage 的内容以 sha256 blob 形式存放，构建期并不存在
 *   一棵真实的 Termux 目录树，物化 182 MiB 只为取一个 rg 不划算。
 */
function patchRipgrep(ctx, termuxRead) {
  const rel = "@vscode/ripgrep/lib/index.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 @vscode/ripgrep）";
  const src = ctx.read(rel);
  must(src.includes("process.platform"), "ripgrep index.js 形态已变");
  const rg = termuxRead("bin/rg");
  must(rg !== null, "Termux 运行时缺少 bin/rg");
  ctx.copy(rg, "@vscode/ripgrep-android-arm64/bin/rg", 0o755);
  ctx.write("@vscode/ripgrep-android-arm64/package.json", `${JSON.stringify({
    name: "@vscode/ripgrep-android-arm64",
    version: "1.0.0-android-native",
  }, null, 2)}\n`);
  return "注入 @vscode/ripgrep-android-arm64 平台包（零代码补丁）";
}

/**
 * dsh-fs-local 的原子发布：Android 的 SELinux 禁止 link，新建改用 COPYFILE_EXCL。
 * 不能先检查再 rename：并发创建者会被覆盖。默认替换仍保留上游 rename / Win32 DACL。
 * 独占 copy 只保证不覆盖，不宣称原子可见性；两个真实版本的失败守卫均会抛错。
 */
export function patchFsLocal(ctx) {
  const rel = "@deepseek-ai/dsh-fs-local/lib/index.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 dsh-fs-local）";
  const src = ctx.read(rel);
  const modern = src.includes('async function writeFileAtomic(absolutePath, content, mode, signal, internals = {}, options = {}) {');
  const label = `dsh-fs-local ${modern ? "0.2.2-rc.2" : "0.2.1-rc.5"}`;
  const marker = "KXXY_FS_LOCAL_EXCLUSIVE_CREATE";
  const from = `\t\tif (${modern ? "options.createIfAbsent" : "createIfAbsent !== void 0"}) try {
\t\t\tawait linkFile(tempPath, absolutePath);
\t\t} catch (error) {
\t\t\tawait throwGuardedCreateFailure(error, absolutePath, ${modern ? "displayPath" : "createIfAbsent.displayPath"}, inspectPublicationTarget);
\t\t}`;
  const to = from.replace('\t\t\tawait linkFile(tempPath, absolutePath);',
    `\t\t\t/* ${marker} */
\t\t\tif (platform === "android") await copyFile(tempPath, absolutePath, fsConstants.COPYFILE_EXCL);
\t\t\telse await linkFile(tempPath, absolutePath);`);
  const imports = [
    ['import { createReadStream, realpath } from "node:fs";',
      'import { constants as fsConstants, createReadStream, realpath } from "node:fs";'],
    ['import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";',
      'import { chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";'],
  ];
  const already = src.includes(marker);
  let original = src;
  if (already) {
    clientAnchor(src, marker, `${label} 独占创建标记`);
    original = replaceOnce(original, to, from, `${label} 已打补丁发布点`);
    for (const [before, after] of imports) original = replaceOnce(original, after, before, `${label} 已打补丁 import`);
  }
  // 对真实 ASAR 的完整失败守卫、写入函数（含默认覆盖、取消和错误传播）做逐字契约校验。
  // 幂等路径先精确逆变换，再做同样校验，标记或部分补丁不能掩盖漂移。
  const start = clientAnchor(original, 'async function throwGuardedCreateFailure(', `${label} 失败守卫`);
  const write = clientAnchor(original, 'async function writeFileAtomic(', `${label} 写入函数`);
  const end = clientAnchor(original, modern ? '/**\n* Remove one resolved file' : '/**\n* Collapse CRLF to LF', `${label} 写入边界`);
  must(start < write && write < end, `${label} —— 写入函数边界漂移`);
  const digest = createHash("sha256").update(original.slice(start, end)).digest("hex");
  must(digest === (modern
    ? "7f32a437b99cf959af636053cfe6c4d9e2fc065c654f429c0ddd7922b28368c1"
    : "8784ae8cfcb276ca307adfd83fd6a7347421c1a2bc1972833519c67ad207572e"), `${label} —— 写入或失败守卫契约漂移（${digest}）`);
  let out = replaceOnce(original, from, to, `${label} 独占创建发布点`);
  for (const [before, after] of imports) out = replaceOnce(out, before, after, `${label} 独占创建 import`);
  if (already) {
    must(out === src, `${label} —— 已打补丁内容不完整`);
    return `${label} → 已打过 Android 独占创建补丁（重新验证通过）`;
  }
  ctx.write(rel, out);
  return `${label} → Android 独占创建，保留原有替换和冲突守卫`;
}

/**
 * dsh-attachment-local：SELinux 禁 link()，存图/存附件即失败。
 *
 * 关键区别（与 session-jsonl 不同）：这里的 link 语义是「为不可变对象发布
 * 另一个名字，**源必须保留**」，所以只能退化为 copyFile，**不能用 rename** ——
 * rename 会移走源，publishStagedObject 之后的 unlink(staged) 会 ENOENT，
 * 且 publishImmutableAlias 的内容寻址正本被挪走会让其余别名全部悬空
 * （参考项目 v1.2.56 事故）。
 *
 * 另外 ensureDurableHome 的祖先遍历会爬出 app 沙箱：普通模式在 /data/data
 * 撞 EACCES，root 模式在 / 撞 EINVAL/EROFS。这两级的持久性不由应用负责，容忍跳过。
 */
function patchAttachmentLocal(ctx) {
  const rel = "@deepseek-ai/dsh-attachment-local/lib/index.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 dsh-attachment-local）";
  let src = ctx.read(rel);

  src = replaceOnce(
    src,
    'import { chmod, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";',
    'import { chmod, copyFile, link as fsLink, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";',
    "attachment-local 的 fs/promises import",
  );

  src = replaceOnce(
    src,
    'import { createLazyRequire } from "@deepseek-ai/dsh-lazy-require";',
    `import { createLazyRequire } from "@deepseek-ai/dsh-lazy-require";
/**
 * Android：SELinux 在 app 域禁 link()。link 在这里的语义是「为不可变对象发布
 * 另一个名字，源必须保留」，所以只能退化为 copyFile（COPYFILE_EXCL 保持
 * 「目标已存在即 EEXIST」的竞态语义）。
 * 注意【不能】用 rename：rename 会移走源，publishStagedObject 之后的
 * unlink(staged) 会 ENOENT，且内容寻址正本被挪走会让其余别名悬空。
 */
async function link(source, target) {
	try {
		return await fsLink(source, target);
	} catch (error) {
		const code = error && typeof error === "object" ? error.code : void 0;
		if (code !== "EACCES" && code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV" && code !== "EMLINK") throw error;
		await copyFile(source, target, constants.COPYFILE_EXCL);
	}
}`,
    "attachment-local 的 lazy-require import",
  );

  src = replaceOnce(
    src,
    `\tif (process.platform === "win32") return;
\t/* v8 ignore start -- Windows cannot exercise directory fsync; POSIX behavior tests enforce this peer. */
\tconst handle = await open(path, constants.O_RDONLY);`,
    `\tif (process.platform === "win32") return;
\t/* Android：ensureDurableHome 的祖先遍历会爬出 app 沙箱 —— 普通模式在
\t   /data/data 撞 EACCES（SELinux 不让 app 域 open 目录），root 模式在 /
\t   撞 EINVAL/EROFS（只读 erofs/dm-verity）。这两级的持久性不由应用负责，
\t   容忍跳过；其余 errno 照旧上抛。 */
\t/* v8 ignore start -- Windows cannot exercise directory fsync; POSIX behavior tests enforce this peer. */
\tconst handle = await open(path, constants.O_RDONLY).catch((error) => {
\t\tconst code = error && typeof error === "object" ? error.code : void 0;
\t\tif (code === "EACCES" || code === "EPERM" || code === "EINVAL" || code === "EROFS" || code === "ENOTDIR") return void 0;
\t\tthrow error;
\t});
\tif (handle === void 0) return;`,
    "attachment-local 的 syncDirectory 目录打开",
  );

  must(src.includes("async function link(source, target)"), "attachment-local 的 link shim 未插入");
  ctx.write(rel, src);
  return "dsh-attachment-local → link 退化 copyFile + 目录 fsync 容忍跳过";
}

/**
 * 文档预览 PDF 分块里那个 Chrome 112+ 才支持的 `v` 标志正则（原文与 `u` 模式等价写法）。
 *
 * 独立成常量而不是内联，是因为它们很长，且必须逐字节精确 —— 锚点对不上时
 * `replaceOnce` 会硬失败，这正是我们想要的。
 */
const PDF_UNICODE_SETS =
  String.raw`/\b(?:https?:\/\/|mailto:|www\.)(?:[\S--[\p{P}<>]]|\/|[\S--[\[\]]]+[\S--[\p{P}<>]])+|(?=\p{L})[\S--[@\p{Ps}\p{Pe}<>]]{1,64}@([\S--[[\p{P}--\-]<>]]{1,63}(?:\.[\S--[[\p{P}--\-]<>]]{1,63})+)/gv`;

const PDF_UNICODE_SETS_U_MODE =
  String.raw`/\b(?:https?:\/\/|mailto:|www\.)(?:[^\s\p{P}<>]|\/|[^\s\[\]]+[^\s\p{P}<>])+|(?=\p{L})[^\s@\p{Ps}\p{Pe}<>]{1,64}@((?:[^\s<>\p{P}]|-){1,63}(?:\.(?:[^\s<>\p{P}]|-){1,63})+)/gu`;

/**
 * 文档预览的 PDF 分块：`client.pdf.js` 用了 Chrome 112+ 才支持的 `v` 标志正则。
 *
 * 症状（Android 13 / ROM 内置 WebView 104 实测，2026-10-13）：7.1 MiB 的 chunk
 * 在**解析阶段**就抛 `Uncaught SyntaxError: Invalid regular expression flags`，
 * 因此永远走不到 `__ModuleLoader__.load(...)`；client-modules 于是判定
 * `bundle …client.pdf.js… loaded without registering …`，并把
 * `sidebar.right.tab.document` 这个 slot 条目整条打崩。
 *
 * **症状极具误导性**：表现是「右侧栏每一种格式的预览都是空白」（实测
 * png / pptx / docx / odt / pdf / html 全中），看起来像每个渲染器各自坏了，
 * 实际只有一个分块解析失败 —— 挂掉的是承载全部预览的那一个 slot 条目。
 *
 * 为什么不能在 compat.js 里救：`v` 标志是**语法层**特性。解析失败时页面里
 * 根本不存在那个模块，而 compat.js 早已跑完；polyfill 对 SyntaxError 无能为力。
 * 唯一可用手段就是构建期把它改写成等价的 `u` 模式正则。
 *
 * 等价性依据（`v` 模式的集合差 → `u` 模式的取反类；`\S` 即「非空白」）：
 *   `[\S--[\p{P}<>]]`         → `[^\s\p{P}<>]`
 *   `[\S--[\[\]]]`            → `[^\s\[\]]`
 *   `[\S--[@\p{Ps}\p{Pe}<>]]` → `[^\s@\p{Ps}\p{Pe}<>]`
 *   `[\S--[[\p{P}--\-]<>]]`   → `(?:[^\s<>\p{P}]|-)`
 *     （`\S` 扣掉「`\p{P}` 去掉 `-` 之后再并入 `<` `>`」的集合；`<` `>` 是
 *       Unicode `Sm`，本就不在 `\p{P}` 里，所以那一半必须显式并进来）
 * 所有新增分组一律用 `(?:…)` 非捕获，**保证 `match[1]`（emailDomain）的编号
 * 不变** —— 调用点写的是 `const [url, emailDomain] = match`，多一个捕获组就错位。
 */
function patchDocumentPreviewUnicodeSets(ctx) {
  const rel = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无文档预览 PDF 分块）";
  const patched = replaceOnce(
    ctx.read(rel),
    PDF_UNICODE_SETS,
    PDF_UNICODE_SETS_U_MODE,
    "文档预览 PDF 分块的 v-标志正则",
  );
  ctx.write(rel, patched);
  return "文档预览 PDF 分块 → v-标志正则改写为等价的 u 模式（WebView 104 可解析）";
}

// ------------------------------------------------------- office（文档 → PDF）链路

/**
 * Office 服务的 Android 缺省字体：不通过 overlay 整体替换用户 config。
 * 沿用旧 officeFontsDir 的单文件 TTF 目录，不混入有 TTC 渲染问题的 /system/fonts。
 * 只补 this.options；显式 []、用户路径、配置校验及非 Android 行为全部保留。
 * 全源码签名覆盖真实构造器到 createConverter 链；幂等先逐字逆变换再验签。
 */
export function patchOfficeDefaultFonts(ctx) {
  const marker = "KXXY_OFFICE_DEFAULT_FONTS";
  const inject = `\t\t\t/* ${marker}：仅补 Android 缺省值，不回写用户 config。 */
\t\t\tif (process.platform === "android" && fontDirectories === void 0) {
\t\t\t\tconst kxxyRoot = process.env.KXXY_ENGINE_ROOT;
\t\t\t\tif (typeof kxxyRoot !== "string" || !isAbsolute(kxxyRoot) || kxxyRoot.includes("\\0")) throw new Error("Android Office 默认字体需要非空、无 NUL 的绝对路径 KXXY_ENGINE_ROOT。");
\t\t\t\tthis.options.fontDirectories = [join(kxxyRoot, "lib/node_modules/kxxy-host/fonts")];
\t\t\t}
`;
  const forms = [
    {
      pkg: "@deepseek-ai/dsh-office-kit",
      hashes: ["88f0697ec0507ba25732f3a359ddca277e1890f215fbe1babf7b98f6c4c40e97"],
      fontHash: "04f8bac43c0ced64a478059435ab8b9ceedeacd6b11790bfd70a97c7fffb2278",
      queue: "\t\t\tthis.queue = new ConversionQueue(config, this.generation, (bytes, request, signal) => this.runOperation(bytes, request, signal));",
    },
    {
      pkg: "@deepseek-ai/dsh-office-to-pdf",
      // 第二个指纹仅接受本文件已有的 odt/ods/odp 格式补丁，允许补丁组合后复验。
      hashes: ["74cf9df9ab605a7675797ee1304d7af7059e97e90c3728ce4e40fbd2333fd7b8",
        "597215530f11d493126a4ce0b5ef4d8dda394082861ff6f5886f968c258cfd2f"],
      fontHash: "e85c76f603af39038aaafcc5bc829fc760c3889b879078890ccbb910cd54beea",
      queue: "\t\t\tthis.queue = new ConversionQueue(config, this.generation, (bytes, extension, signal) => this.convertBytes(bytes, extension, signal));",
    },
  ];
  const edits = [];
  for (const { pkg, hashes, fontHash, queue } of forms) {
    if (!ctx.exists(pkg)) continue;
    const rel = `${pkg}/lib/index.js`;
    const label = `${pkg} Android 缺省字体`;
    must(ctx.exists(rel), `${label} —— 包存在但入口缺失`);
    const src = ctx.read(rel);
    const already = src.includes(marker);
    const original = already ? replaceOnce(src, inject, "", `${label} 完整补丁逆变换`) : src;
    const digest = createHash("sha256").update(original).digest("hex");
    must(hashes.includes(digest), `${label} —— 未知或漂移的源码签名（${digest}）`);
    const start = clientAnchor(original, "\t\tconstructor(ctx, config) {\n", `${label} 构造器`);
    const end = clientAnchor(original, queue, `${label} 转换队列`);
    must(start < end && createHash("sha256").update(original.slice(start, end)).digest("hex") === fontHash,
      `${label} —— 字体构造块契约漂移`);
    const out = replaceOnce(original, queue, inject + queue, `${label} 默认值注入点`);
    if (already) must(out === src, `${label} —— 补丁位置或内容不完整`);
    edits.push({ rel, out, already, label });
  }
  // 两个入口同时存在时也先全部验签，任一漂移都不写入半份补丁。
  for (const { rel, out, already } of edits) if (!already) ctx.write(rel, out);
  return edits.length ? edits.map(({ label, already }) => `${label} → ${already ? "已打过（逆变换复验通过）" : "仅注入宿主字体目录"}`).join("；")
    : "跳过（依赖树无 Office 服务）";
}

/**
 * libreoffice-kit 的宿主平台门禁：Android 只使用 WASM，不冒充 Linux glibc ABI。
 * 0.1.5 只需放行 resolveEngine 尾部拒绝；platformTarget 和桌面原生包门禁不变。
 * 0.2.3 已统一 WASM fallback，必须验证整个 engine 区段后原样保留，而非机械改次数。
 */
export function patchLibreOfficeKitPlatform(ctx) {
  const rel = "@deepseek-ai/libreoffice-kit/lib/index.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 libreoffice-kit）";
  const src = ctx.read(rel);
  const label = "libreoffice-kit 平台选择";
  const from = '\tif (platform !== "linux") throw new Error(`Unsupported LibreOfficeKit host: ${platform}-${arch}`);';
  const to = '\tif (platform !== "linux" && platform !== "android") throw new Error(`Unsupported LibreOfficeKit host: ${platform}-${arch}`);';
  const already = src.includes(to);
  const original = already ? replaceOnce(src, to, from, `${label} 已打补丁门禁`) : src;
  const start = clientAnchor(original, '//#region lib/types/engine.js\n', `${label} engine 起点`);
  const end = clientAnchor(original, '//#endregion\n//#region lib/types/operations.js', `${label} engine 终点`);
  for (const anchor of ['function platformTarget(', 'async function resolveEngine(', 'async function readEngine(']) {
    const at = clientAnchor(original, anchor, `${label} ${anchor}`);
    must(start < at && at < end, `${label} —— 函数移出 engine 区段`);
  }
  // 指纹来自两版真实 ASAR，覆盖 ABI、glibc 下限、包缺失/损坏区分、路径和 manifest 验证。
  const digest = createHash("sha256").update(original.slice(start, end)).digest("hex");
  if (digest === "e678c368c926de84b1499528998b53d26571a6831805ac89c35fadba7866cf5e") {
    must(!already, `${label} —— 新版混入旧门禁补丁`);
    return "libreoffice-kit 0.2.3 → 已验证上游 Android WASM fallback，保留 native 与完整性门禁（零改写）";
  }
  must(digest === "8053aa88a4f1bebfdb284e28cb7abd06b528f9f639225d8a61ddda763fc8ccc2", `${label} —— 未知或漂移的 engine 契约（${digest}）`);
  const out = replaceOnce(original, from, to, `${label} 0.1.5 的 WASM 宿主门禁`);
  if (already) {
    must(out === src, `${label} —— 已打补丁内容不完整`);
    return "libreoffice-kit 0.1.5 → 已打过 Android WASM 补丁（重新验证通过）";
  }
  ctx.write(rel, out);
  return "libreoffice-kit 0.1.5 → 仅放行 Android WASM，保留 Linux/桌面 native 选择";
}

/**
 * libreoffice-kit 的字体回退表：补上 Android 上真实存在的字体族。
 *
 * 为什么必须打：`systemFontDirectories()` 在 android 上走的是 XDG 分支
 * （`XDG_DATA_DIRS` 的 `fonts/` 子目录 + `~/.fonts`），Android 上这些路径全部
 * 不存在，于是「文档里声明的族」一个都解析不到 —— docx 渲染成整片空白。
 *
 * 修法分两半：
 *   a) 给已有 13 组回退链各追加 Android 实存族，让「Arial → Roboto/Noto Sans SC」
 *      这类映射真的接得上；
 *   b) 新增 13 组上游没收录的族（Aptos、等线、游ゴシック、Calibri 单列、
 *      Cambria、Times New Roman、Segoe UI、Microsoft JhengHei/YaHei …），
 *      这些是 OOXML 文档里最常见的声明名。
 *
 * 注入点选在 `const DEFAULT_LIMITS = {` 之前：那里紧邻 `FONT_FALLBACKS` 的
 * 定义尾部，`FONT_FALLBACKS` 在模块作用域可见且未被 `Object.freeze`
 * （已核对 `freeze(FONT_FALLBACKS` 零命中）。
 */
function patchLibreOfficeKitFontFallbacks(ctx) {
  const rel = "@deepseek-ai/libreoffice-kit/lib/index.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 libreoffice-kit）";
  const src = ctx.read(rel);
  const anchor = "const DEFAULT_LIMITS = {";
  must(src.split(anchor).length - 1 === 1, "libreoffice-kit 字体回退 —— DEFAULT_LIMITS 锚点不唯一");
  const inject = `const KXXY_SANS = ["Noto Sans SC", "Roboto", "Source Sans Pro", "MiSans C"];
const KXXY_SERIF = ["Noto Serif SC", "Noto Serif CJK SC", "Noto Serif"];
const KXXY_MONO = ["Droid Sans Mono", "Noto Sans Mono CJK SC"];
for (const kxxyGroup of FONT_FALLBACKS) {
	const kxxyNames = kxxyGroup.map((kxxyName) => kxxyName.toLowerCase());
	if (kxxyNames.includes("monospace") || kxxyNames.includes("courier new")) kxxyGroup.push(...KXXY_MONO, ...KXXY_SANS);
	else if (kxxyNames.includes("serif") || kxxyNames.includes("times new roman") || kxxyNames.includes("cambria")) kxxyGroup.push(...KXXY_SERIF, ...KXXY_SANS);
	else kxxyGroup.push(...KXXY_SANS);
}
FONT_FALLBACKS.push(
	["Aptos", "Aptos Display", "Noto Sans SC", "Roboto"],
	["等线", "DengXian", "DengXian Light", "Noto Sans SC", "Roboto"],
	["游ゴシック", "Yu Gothic", "Yu Gothic Light", "Noto Sans SC"],
	["游明朝", "Yu Mincho", "Noto Serif SC"],
	["ＭＳ Ｐゴシック", "MS PGothic", "MS Gothic", "Noto Sans SC"],
	["맑은 고딕", "Malgun Gothic", "Noto Sans SC"],
	["新細明體", "PMingLiU", "MingLiU", "Noto Serif SC"],
	["Calibri", "Noto Sans SC", "Roboto"],
	["Cambria", "Noto Serif SC", "Noto Serif"],
	["Times New Roman", "Noto Serif SC", "Noto Serif"],
	["Segoe UI", "Noto Sans SC", "Roboto"],
	["Microsoft JhengHei", "Noto Sans SC"],
	["Microsoft YaHei", "Noto Sans SC", "Roboto"]
);
const KXXY_ANDROID_FALLBACKS = true;
`;
  ctx.write(rel, src.slice(0, src.indexOf(anchor)) + inject + src.slice(src.indexOf(anchor)));
  return "libreoffice-kit → 字体回退表追加 Android 实存族（含 13 组新族）";
}

/**
 * `@deepseek-ai/dsh-office-to-pdf` 的扩展名白名单：补 odt / ods / odp。
 *
 * 为什么必须打：这是 office 转换链上**唯一**的白名单。客户端把 .odt 交上来后，
 * `renderFile()` 先按后缀拦一道，不在名单里直接抛
 * `OfficeToPdfError("unsupported-format", …)`，用户看到的是「无法预览此 Office
 * 文件。文件可能已损坏、受密码保护，或与扩展名不符。」—— 归因完全错位。
 * 客户端那份 `extensions` 数组里也没有 odt/ods/odp，所以两处都得补。
 *
 * 安全性依据：底层 `libreoffice-kit` 本就完整支持这三种格式
 * （`CONVERSION_FORMATS` 的 Writer 组 `inputs: ["doc","docx","odt"]`、
 * Calc 组 `["xls","xlsx","ods"]`、Impress 组 `["ppt","pptx","odp"]`），
 * `worker.js` 的 `DOCUMENT_EXTENSIONS` 也已含它们。这一层只是漏登记。
 * `convertBytes()` 走的是另一条路径、本就不做后缀校验，不受影响。
 */
function patchOfficeToPdfFormats(ctx) {
  const rel = "@deepseek-ai/dsh-office-to-pdf/lib/index.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 dsh-office-to-pdf）";
  const from =
    'if (extension !== "doc" && extension !== "docx" && extension !== "xls" && extension !== "xlsx" && extension !== "ppt" && extension !== "pptx") throw new OfficeToPdfError("unsupported-format", "The path must end in doc, docx, xls, xlsx, ppt, or pptx.");';
  const to =
    'if (extension !== "doc" && extension !== "docx" && extension !== "odt" && extension !== "xls" && extension !== "xlsx" && extension !== "ods" && extension !== "ppt" && extension !== "pptx" && extension !== "odp") throw new OfficeToPdfError("unsupported-format", "The path must end in doc, docx, odt, xls, xlsx, ods, ppt, pptx, or odp.");';
  const patched = replaceOnce(ctx.read(rel), from, to, "dsh-office-to-pdf 扩展名白名单");
  ctx.write(rel, patched);
  return "dsh-office-to-pdf → 扩展名白名单补 odt / ods / odp";
}

// 客户端补丁只识别已核实的 rc.5 / rc.2 形态，不依赖构建机上的第三方解析器。
function clientAnchor(text, anchor, label) {
  const at = text.indexOf(anchor);
  must(at >= 0, `${label} —— 未找到锚点`);
  must(text.indexOf(anchor, at + 1) < 0, `${label} —— 锚点出现多次，替换不安全`);
  return at;
}

function clientSyntax(text, label) {
  try { new Script(text); }
  catch (error) { must(false, `${label} —— 语法或作用域边界已改变：${error.message}`); }
}

function clientFactory(text, id) {
  const forms = [
    {
      compact: false,
      head: `window.__ModuleLoader__.load({\n\tid: "${id}",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n`,
      tail: '\t\treturn module.exports;\n\t}\n});\n\n//# sourceMappingURL=client.js.map',
    },
    {
      compact: true,
      head: `\nwindow.__ModuleLoader__.load({id:\`${id}\`,factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:\`Module\`});`,
      tail: 'return module.exports}});\n//# sourceMappingURL=client.js.map',
    },
  ];
  const matches = forms.filter(({ head, tail }) => text.startsWith(head) && text.endsWith(tail));
  must(matches.length === 1, `${id} —— 未知的模块 factory 包装`);
  const form = matches[0];
  clientAnchor(text, form.head, `${id} factory`);
  clientSyntax(text, `${id} 完整 bundle`);
  return { ...form, body: text.slice(form.head.length, -form.tail.length) };
}

function clientScopedFunction(body, head, end, label) {
  const start = clientAnchor(body, head, label);
  must(start < end, `${label} —— 函数与导出顺序已改变`);
  // 只编译、不执行上游：前缀必须是完整的 factory 语句，切片必须恰好是一个函数。
  // 若锚点跑进字符串、嵌套回调或另一函数，这两次编译至少有一次会失败。
  clientSyntax(`(function(require){${body.slice(0, start)}\n})`, `${label} factory 层级`);
  const code = body.slice(start, end);
  clientSyntax(`(${code}\n)`, `${label} 函数边界`);
  return { start, code };
}

function documentPreviewLayout(text, fragments = [], extraCalls = []) {
  const factory = clientFactory(text, '@deepseek-ai/dsh-client-ui-sidebar-documentpreview');
  const { compact, body } = factory;
  clientAnchor(body, compact ? 'let react=require("react");' : 'let react = require("react");', '文档预览 react 绑定');
  const tail = compact
    ? 'exports.apply=apply;exports.inject=inject;'
    : '\t\t//#endregion\n\t\texports.apply = apply;\n\t\texports.inject = inject;\n';
  const exportAt = clientAnchor(body, tail, '文档预览导出的 apply');
  must(exportAt + tail.length === body.length, '文档预览导出不在 factory 末尾');
  const injected = fragments.map(fragment => `\n${fragment}\n`).join('');
  const end = exportAt - injected.length;
  must(body.slice(end, exportAt) === injected, '文档预览片段缺失、改变或不在 factory 导出之前');
  for (const fragment of fragments) clientAnchor(body, fragment, '文档预览已注入片段');
  const apply = clientScopedFunction(body, compact ? 'function apply(ctx){' : 'function apply(ctx) {', end, '文档预览 apply');
  const setup = compact
    ? 'function apply(ctx){const config=Config(globalThis.__DSH_DOCUMENT_PREVIEW_CONFIG__??{});const previews=new DocumentPreviewRegistry;const disposePreviews=ctx.reflect.provide(`documentPreviews`,previews);'
    : 'function apply(ctx) {\n\t\t\tconst config = Config(globalThis.__DSH_DOCUMENT_PREVIEW_CONFIG__ ?? {});\n\t\t\tconst previews = new DocumentPreviewRegistry();\n\t\t\tconst disposePreviews = ctx.reflect.provide("documentPreviews", previews);';
  must(apply.code.startsWith(setup), '文档预览 apply 的配置或注册表契约已改变');
  const calls = compact
    ? 'apply$9(ctx);apply$8(ctx);apply$6(ctx);apply$5(ctx);apply$4(ctx);apply$2(ctx,config.office);apply$1(ctx,config.excel);apply$3(ctx)'
    : 'apply$9(ctx);\n\t\t\tapply$8(ctx);\n\t\t\tapply$6(ctx);\n\t\t\tapply$5(ctx);\n\t\t\tapply$4(ctx);\n\t\t\tapply$2(ctx, config.office);\n\t\t\tapply$1(ctx, config.excel);\n\t\t\tapply$3(ctx);';
  const closing = compact ? '}' : '\n\t\t}\n';
  const addedCalls = extraCalls.map(name => `${compact ? '' : '\n\t\t\t'};${name}(ctx);`).join('');
  const callTail = calls + addedCalls + closing;
  clientAnchor(apply.code, callTail, '文档预览内置及本地 provider 注册顺序');
  must(apply.code.endsWith(callTail), '文档预览 provider 调用不在导出 apply 末尾');
  return {
    ...factory,
    exportAt: factory.head.length + exportAt,
    callAt: factory.head.length + end - closing.length,
  };
}

/**
 * 客户端 office 预览器的扩展名清单：补 odt / ods / odp。
 *
 * 为什么必须打：`documentpreviews` 的候选是按 `extensions` 匹配的，
 * `.odt` 不在清单里就永远没有候选；又因为 `UNVIEWABLE_BINARY_EXTENSIONS`
 * 里明确列了 `"odt" / "ods" / "odp"`，最终落到「该格式文件暂时无法预览」空态。
 *
 * 为什么只改这一处、不动黑名单：黑名单只在**没有任何候选**时被查询
 * （`if (matched.length === 0 && unviewable) return matched;`），
 * 一旦 office provider 声明了这三个后缀就必然命中，黑名单形同不存在。
 * 保留它反而是正确的语义：万一 office 服务不可用，用户看到的是
 * 「预览器不可用」而不是把 ZIP 二进制当文本读。
 *
 * `binaryExtensions: extensions` 是整份复用，因此 odt/ods/odp 会一并成为
 * 「二进制后缀」—— 这正是我们要的：`binaryDocumentPath` 为真 ⇒ 只留 office
 * 一个候选，不会追加纯文本兜底、不会出现「打开方式」菜单。
 */
export function patchDocumentPreviewOfficeExtensions(ctx) {
  const rel = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无文档预览客户端）";
  const text = ctx.read(rel);
  const { compact, body } = documentPreviewLayout(text);
  const end = clientAnchor(body, 'function conversionErrorKey(code)', 'office 后继函数');
  const office = clientScopedFunction(body, compact ? 'function apply$2(ctx,config){' : 'function apply$2(ctx, config) {', end, 'office provider');
  const head = compact
    ? 'function apply$2(ctx,config){const id=`@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office`;'
    : 'function apply$2(ctx, config) {\n\t\t\tconst id = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office";';
  must(office.code.startsWith(head), 'office provider 的 ID 或函数绑定已改变');
  const registration = compact
    ? 'ctx.effect(()=>ctx.documentPreviews.register({id,extensions,binaryExtensions:extensions,priority:`builtin`,title:()=>t(`title`),loading:`renderer`,wrap:false}));'
    : 'ctx.effect(() => ctx.documentPreviews.register({\n\t\t\t\tid,\n\t\t\t\textensions,\n\t\t\t\tbinaryExtensions: extensions,\n\t\t\t\tpriority: "builtin",\n\t\t\t\ttitle: () => t("title"),\n\t\t\t\tloading: "renderer",\n\t\t\t\twrap: false\n\t\t\t}));';
  clientAnchor(office.code, registration, 'office 共享扩展名与 renderer 契约');
  const from = compact
    ? 'const extensions=[`doc`,`docx`,`ppt`,`pptx`];'
    : 'const extensions = [\n\t\t\t\t"doc",\n\t\t\t\t"docx",\n\t\t\t\t"ppt",\n\t\t\t\t"pptx"\n\t\t\t];';
  const to = compact
    ? 'const extensions=[`doc`,`docx`,`odt`,`ppt`,`pptx`,`odp`,`ods`];'
    : 'const extensions = [\n\t\t\t\t"doc",\n\t\t\t\t"docx",\n\t\t\t\t"odt",\n\t\t\t\t"ppt",\n\t\t\t\t"pptx",\n\t\t\t\t"odp",\n\t\t\t\t"ods"\n\t\t\t];';
  const replacement = replaceOnce(office.code, from, to, 'office 扩展名清单');
  const patched = replaceOnce(text, office.code, replacement, 'office provider 函数');
  documentPreviewLayout(patched);
  ctx.write(rel, patched);
  return "文档预览 office provider → 扩展名补 odt / ods / odp";
}

/**
 * 给文档预览客户端补上 zip / epub 两个 provider。
 *
 * 为什么必须打：上游 8 个内置 provider 里没有任何一个能读 ZIP 容器。
 * `.zip` 在 `UNVIEWABLE_BINARY_EXTENSIONS` 里，落到「该格式文件暂时无法预览」
 * 空态；`.epub` 更彻底 —— 全 bundle 只有 `"republishing"` 这种子串噪声，
 * 既不在 provider 清单也不在黑名单，于是把 ZIP 二进制当纯文本读。桌面版
 * 同样如此，这是上游能力缺口而不是 Android 特有问题。
 *
 * 为什么放在客户端而不是宿主：解压只需要 `DecompressionStream('deflate-raw')`
 * （真机 WebView 104 实测 `raw/deflate/gzip` 三种都可用），宿主侧做的话要新增
 * 一条 remote 命名空间、改 typert 契约、再让客户端长轮询，成本与风险都高得多。
 *
 * 注入位置与安全性：片段（`tools/prebuilt/documentpreview-archive/providers.js`）
 * 拼进模块作用域的 `exports.apply = apply;` 之前，因此可以直接用上游已经
 * `require` 好的 `react` 局部变量；随后在 `apply(ctx)` 末尾追加一次
 * `kxxyArchiveApply(ctx);`。两处锚点都断言唯一，形态变了就让构建失败。
 * 片段内所有标识符带 `kxxy` / `KXXY_` 前缀 —— 这是个 26 万字符的扁平作用域，
 * 不加前缀极易与上游局部变量撞名。
 */
export function patchDocumentPreviewArchiveProviders(ctx) {
  const rel = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无文档预览客户端）";
  const fragment = prebuilt("documentpreview-archive/providers.js").toString("utf8").trimEnd();
  clientAnchor(fragment, 'function kxxyArchiveApply(', '文档预览归档片段入口');
  must(!fragment.includes('</script'), '文档预览归档片段含 </script');
  const text = ctx.read(rel);
  must(!text.includes('kxxyArchiveApply') && !text.includes('kxxyMediaApply'), '归档补丁重复、部分应用或注册顺序已改变');
  const { compact, exportAt, callAt } = documentPreviewLayout(text);
  let patched = text.slice(0, exportAt) + `\n${fragment}\n` + text.slice(exportAt);
  // rc.2 最后一个内置调用没有分号；必须显式断开，不能依赖 ASI。
  const call = `${compact ? '' : '\n\t\t\t'};kxxyArchiveApply(ctx);`;
  patched = patched.slice(0, callAt) + call + patched.slice(callAt);
  documentPreviewLayout(patched, [fragment], ['kxxyArchiveApply']);
  ctx.write(rel, patched);
  return "文档预览客户端 → 新增 zip / epub 两个归档 provider";
}

/**
 * 给文档预览客户端补上 video / audio 两个 provider。
 *
 * 为什么必须打：上游 8 个内置 provider 没有一个处理音视频，而 mp4/mov/avi/mkv/
 * webm/flv/wmv/m4v/mp3/wav/flac/ogg/m4a/aac/wma/opus 恰好是
 * `UNVIEWABLE_BINARY_EXTENSIONS` 数组**开头**的一批，判据链走到
 * `matched.length === 0 && unviewable` 就返回空候选，渲染「该格式文件暂时无法
 * 预览」。桌面版同样如此，是上游能力缺口。
 *
 * 为什么用 `renderer` 模式：`bytes-complete` 要把整个文件经
 * `remote.workspaceFiles.readBytes` 拉进内存，受 `config.maxFileBytes`
 * （默认 32 MiB）限制，一个几秒的视频就超限报 `workspace-file/too-large`。
 * renderer 模式不传字节，body 只把 `<video src>` 指向宿主 `/kxxy/media`
 * （见 kxxy-host 的流式路由，带 Range/206），由浏览器媒体栈自己取、自己 seek。
 *
 * 注入位置与安全性：片段（`tools/prebuilt/documentpreview-media/providers.js`）
 * 拼进模块作用域的 `exports.apply = apply;` 之前，可以直接用上游已经
 * `require` 好的 `react` 局部变量；随后在 `apply(ctx)` 末尾追加
 * `kxxyMediaApply(ctx);`。
 *
 * ★顺序依赖：收尾锚点 `kxxyArchiveApply(ctx);` 是**归档补丁自己插进去的**，
 * 所以本函数必须在 `patchDocumentPreviewArchiveProviders` **之后**调用。
 * `applyAllPatches` 的数组顺序保证了这一点；写反了会在构建期抛「未找到锚点」。
 *
 * 为便于离线预演（`_recon/dryrun-media-patch.mjs` 用真实 asar 单文件跑一遍），
 * 这里 `export` 出去 —— 生产入口仍是 `applyAllPatches`。
 */
export function patchDocumentPreviewMediaProviders(ctx) {
  const rel = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无文档预览客户端）";
  const archive = prebuilt("documentpreview-archive/providers.js").toString("utf8").trimEnd();
  const fragment = prebuilt("documentpreview-media/providers.js").toString("utf8").trimEnd();
  clientAnchor(fragment, 'function kxxyMediaApply(', '文档预览音视频片段入口');
  must(!fragment.includes('</script'), '文档预览音视频片段含 </script');
  const text = ctx.read(rel);
  must(!text.includes('kxxyMediaApply'), '音视频补丁重复或部分应用');
  const { compact, exportAt, callAt } = documentPreviewLayout(text, [archive], ['kxxyArchiveApply']);
  let patched = text.slice(0, exportAt) + `\n${fragment}\n` + text.slice(exportAt);
  const call = `${compact ? '' : '\n\t\t\t'};kxxyMediaApply(ctx);`;
  patched = patched.slice(0, callAt) + call + patched.slice(callAt);
  documentPreviewLayout(patched, [archive, fragment], ['kxxyArchiveApply', 'kxxyMediaApply']);
  ctx.write(rel, patched);
  return "文档预览客户端 → 新增 video / audio 两个媒体 provider";
}

/**
 * 上游 web bundle 里 `if (execArgv.includes('--expose-internals')) return req(id)`
 * 的 fallback 说明 --expose-internals 是官方认可路径；这里只做一次断言，
 * 确认 EngineProcess.kt 传的 flag 与补丁假设一致。
 */
export function assertEngineFlags(engineProcessSource) {
  must(
    engineProcessSource.includes('"--expose-internals"'),
    "EngineProcess.kt 未传 --expose-internals，node-addon-require-builtin 的纯 JS 替代会失效",
  );
}

/**
 * 把自有插件 kxxy-host 与内置的第三方插件 dsh-web-mobile 挂进
 * `@deepseek-ai/dsh` 的 dependencies。
 *
 * 为什么必须改这里：profile 的包解析由 dsh-app-boot 的
 * `collectInstallationScopePackages(installAnchor, …)` 决定，它从 installAnchor
 * （= `<root>/lib/node_modules/@deepseek-ai/dsh/package.json`）出发 BFS
 * `dependencies` + `peerDependencies` 两个字段，产出
 * `resolution.entries`。只有进了 entries 的包才会被 `routeScoped` 判成
 * `{kind:"interception"}` —— 否则裸包名会落到 `native-after-interception`，
 * 由 profile 目录的 node_modules 去解析，而那里没有这两个包。
 *
 * dsh-web-mobile 尤其容易踩这个坑：它的宿主半区在设备上不会报错，只是
 * 「Loader 里没有这一行」⇒ `dsh-client-modules` 扫 entries 时扫不到它 ⇒
 * 客户端半区不激活 ⇒ 手机上仍是官方桌面布局，且 logcat 里一行线索都没有。
 *
 * 声明版本用各自 package.json 里的真实版本（kxxy-host 0.1.0、
 * dsh-web-mobile 3.3.5）。这个字段不参与 npm 安装（运行时树是离线装配的），
 * 只被 `profileDependencyNames` 读键名，但写真实版本号可让 `dsh plugin` 的
 * pnpm 操作在人工介入时不至于困惑。版本必须与 build-runtime.mjs 的
 * `MOBILE_PLUGIN_PKG`、`EngineConfig.MOBILE_PLUGIN_VERSION` 三处一致。
 */
export function patchDshManifest(ctx) {
  const rel = "@deepseek-ai/dsh/package.json";
  const manifest = JSON.parse(ctx.read(rel));
  manifest.dependencies ??= {};

  const wanted = [
    ["kxxy-host", "0.1.0"],
    ["dsh-web-mobile", "3.3.5"],
    ["dsh-codex-sidebar", "0.1.0"],
  ];
  const added = [];
  for (const [name, version] of wanted) {
    if (manifest.dependencies[name] !== void 0) continue;
    manifest.dependencies[name] = version;
    added.push(name);
  }
  if (added.length === 0) {
    return `${wanted.map(([n]) => n).join(" / ")} 已在 @deepseek-ai/dsh 的 dependencies 中，跳过`;
  }
  ctx.write(rel, `${JSON.stringify(manifest, null, 2)}\n`);
  return `${added.join(" / ")} → 注册进 @deepseek-ai/dsh 的 dependencies（installation scope）`;
}

/**
 * sharp：libvips 原生预编译产物没有 android 平台，图片附件一律准入失败。
 *
 * 症状（用户报，Android 16 真机）：纯文本与普通文件附件都能发，**只要带图片**
 * 就报 `prompt rejected (session/agent-busy)`，全程无更具体的错误。
 *
 * 根因链：
 *   1. `@deepseek-ai/dsh-api-session-controller` 的 `prompt()` 里，
 *      `AttachmentError` 会被转成 `session/attachment-invalid`，而**其它任何
 *      异常**都落到最后一行 `new RemoteError("session/agent-busy", "prompt rejected",
 *      { reason: String(error) })` —— 所以 `agent-busy` 只是兜底包装。
 *   2. `@deepseek-ai/dsh-attachment-local` 的 `detectImage()` / `normalizeImage()` /
 *      `probeImage()` 里，`const sharp = requireSharp();` 写在 **try 之外**，
 *      它抛的普通 `Error` 不会被包成 `AttachmentError` ⇒ 直接冒到上面那行。
 *   3. `sharp/dist/libvips.cjs` 的 `prebuiltPlatforms` 里根本没有 android-*，
 *      `sharp.cjs` 的 switch 也没有 android 分支 ⇒ Node 在 Android 上
 *      （`process.platform === "android"`）解析出 `android-arm64` 后必抛
 *      `Could not load the "sharp" module using the android-arm64 runtime`。
 *   4. 闭包里 `sharp/` 与 `@img/` 都没有任何 `.node`，也没有 `@img/sharp-wasm32`
 *      ⇒ 无预编译可用。
 *
 * 为什么普通文件能发：文件附件走 `saveFileVerbatim`，完全不经 sharp。
 *
 * 修法：**换整个 package**（与 `patchKoffi` 同一范式），用引擎自带的
 * ImageMagick 7 实现 dsh-attachment-local 实际用到的那一小片 sharp API。
 * 替身源码随仓库提交在 `tools/prebuilt/sharp-android/`（纯 JS，无原生依赖）。
 *
 * 安全性依据：全依赖树里 `require("sharp")` / `createLazyRequire("sharp")` 的
 * 消费者**只有 dsh-attachment-local 一个**（构建期可复核），所以替换实现不会
 * 波及别处。
 */
function patchSharp(ctx) {
  if (!ctx.exists("sharp")) return "跳过（依赖树无 sharp）";
  const NM = "sharp";
  ctx.rmrf(NM);
  ctx.write(
    `${NM}/package.json`,
    `${JSON.stringify(
      {
        name: "sharp",
        version: "0.35.5-android-substitute",
        description: "Android 替身：用引擎自带 ImageMagick 实现 dsh-attachment-local 用到的那一小片 sharp API",
        type: "commonjs",
        main: "./dist/index.cjs",
        exports: {
          ".": {
            require: "./dist/index.cjs",
            import: "./dist/index.cjs",
            default: "./dist/index.cjs",
          },
        },
        license: "Apache-2.0",
      },
      null,
      2,
    )}\n`,
  );
  ctx.copy(prebuilt("sharp-android/dist/index.cjs"), `${NM}/dist/index.cjs`, 0o644);
  return "sharp → ImageMagick 替身（原包无 android 预编译，必抛 android-arm64 加载失败）";
}

/**
 * `@deepseek-ai/dsh-native-command`：Android 上「打开文件」整条链是**空**的。
 *
 * 真机症状（用户报）：对话里交付的 `*.apk` 点一下什么都不发生，只有一行
 * 灰字「此主机没有可用的桌面，无法使用外部程序打开文件或文件夹」。用户要的
 * 是**唤起系统安装器**（选择安装 / 允许安装未知来源）。
 *
 * 根因链（四环，缺一不成立，且每一环都独立地让功能不可用）：
 *   1. `canOpenNativePath()` 只认 darwin / win32 / 有 DISPLAY 的 linux，
 *      Android（`process.platform === "android"`）直接 `return false`；
 *   2. `nativeFileManager()` 同理返回 `null`；
 *   3. `dsh-api-session-controller` 的 `workspaceDesktop()` 把
 *      `available` 算成 `fileManager !== null && canOpenPath()` ⇒ **恒 false**
 *      ⇒ 前端 `dsh-client-ui-deliverables` 渲染 `presented.unavailable`，
 *      `deliverables.file.actions` 槽位（open-in-app 的分体按钮）整块不挂载；
 *   4. 即便强行打开，`openNativePathWithIntent()` 末尾
 *      `throw new Error("native path opener is unsupported on <platform>")`。
 *
 * 修法分三处，全部落在本包内（不碰上游调用方）：
 *   a) `canOpenNativePath()` / `nativeFileManager()` 放行 android；
 *   b) `openNativePathWithIntent()` 增加 android 分支：调
 *      `<root>/libexec/termux-api Open <path>` —— 那是 `TermuxApiServer`
 *      每次引擎启动时写的脚本 shim（`installShim`），把路径送进应用进程，
 *      由它用系统 `ACTION_VIEW` 打开：`.apk` 落到 PackageInstaller，其余
 *      落到各自的关联应用；
 *   c) `nativeFileApplications()` 在 android 上返回「系统默认打开方式」
 *      一个条目，让 `deliverables.file.actions` 的分体按钮**有东西可渲染**
 *      （`useFileApplications` 拿到空数组时按钮主键会退回「显示文件位置」，
 *      而那个动作在 Android 上语义不对）。
 *
 * ⚠️ 为什么不用 `termux-open`：`bin/termux-open` 在 `build-runtime.mjs` 的
 * `TERMUX_APP_SCRIPTS` 剔除清单里（它内部 exec `am start`，而 `bin/am` 也被
 * 剔除了），设备上根本没有这个命令。`libexec/termux-api` 则相反 —— 它在
 * 闭包里，而且**每轮引擎启动都会被换成 shim**（见
 * `EngineSupervisor.supervisionLoop`），是唯一稳定可用的「引擎 → 应用进程」
 * 执行器。因此这里给它加一个 `Open` 方法（见 `TermuxApiServer.open`）。
 *
 * 安全性：`Open` 只接受**引擎根内已存在**的文件路径（`KxxyFilesProvider`
 * 也只服务 `engine/` 前缀），由应用进程用 `ACTION_VIEW` + `content://` +
 * 临时读授权发出。`.apk` 会带上 `application/vnd.android.package-archive`，
 * 交给系统安装器 —— 安装确认框由系统弹，本应用除了
 * `REQUEST_INSTALL_PACKAGES` 之外不持有任何特权。
 *
 * 为便于离线预演（`tools/test-native-command.mjs` 用上游真实文件跑一遍），
 * 这里 `export` 出去 —— 生产入口仍是 `applyAllPatches`。
 */
export function patchNativeCommandAndroid(ctx) {
  const rel = "@deepseek-ai/dsh-native-command/lib/index.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 dsh-native-command）";
  let src = ctx.read(rel);

  // a1) canOpenNativePath：android 也有「桌面」（系统 ACTION_VIEW）。
  src = replaceOnce(
    src,
    `function canOpenNativePath(internals = {}) {
	const platform = internals.platform ?? process.platform;
	if (platform === "darwin" || platform === "win32") return true;
	if (platform !== "linux") return false;`,
    `function canOpenNativePath(internals = {}) {
	const platform = internals.platform ?? process.platform;
	if (platform === "darwin" || platform === "win32") return true;
	/* Android：没有桌面环境，但有系统 Intent 解析器 —— 见 tools/lib/patches.mjs
	   的 patchNativeCommandAndroid。这里返回 true 是「能不能把路径交出去」
	   的判断，不是「有没有窗口系统」。 */
	if (platform === "android") return true;
	if (platform !== "linux") return false;`,
    "native-command 的 canOpenNativePath",
  );

  // a2) nativeFileManager：android 走「目录」语义（打开所在文件夹）。
  src = replaceOnce(
    src,
    `function nativeFileManager(internals = {}) {
	const platform = internals.platform ?? process.platform;
	if (platform === "darwin") return "finder";
	if (platform === "win32" || platform === "linux" && isWsl(internals)) return "explorer";
	return platform === "linux" ? "directory" : null;
}`,
    `function nativeFileManager(internals = {}) {
	const platform = internals.platform ?? process.platform;
	if (platform === "darwin") return "finder";
	if (platform === "win32" || platform === "linux" && isWsl(internals)) return "explorer";
	/* Android：既没有 Finder 也没有 Explorer，但「打开所在文件夹」可以交给
	   系统文件管理器（DocumentsUI）。返回值必须是协议里的四个字面量之一，
	   否则前端 isPresentedHost 校验会判非法。 */
	if (platform === "android") return "directory";
	return platform === "linux" ? "directory" : null;
}`,
    "native-command 的 nativeFileManager",
  );

  // b) openNativePathWithIntent：android 分支走 termux-open 脚本 shim。
  src = replaceOnce(
    src,
    `	if (platform === "linux") {
		if (wsl) {
			await openWslPath(path, signal, run);
			return;
		}
		await run("xdg-open", [path], signal, "hidden");
		return;
	}
	throw new Error(\`native path opener is unsupported on \${platform}\`);`,
    `	if (platform === "linux") {
		if (wsl) {
			await openWslPath(path, signal, run);
			return;
		}
		await run("xdg-open", [path], signal, "hidden");
		return;
	}
	if (platform === "android") {
		/* 交给 <root>/libexec/termux-api 的脚本 shim：它把路径写进 <root>/tapi
		   通道，由应用进程用系统 ACTION_VIEW 打开（.apk ⇒ PackageInstaller）。
		   为什么不用 termux-open / am：那两个脚本在 build-runtime.mjs 的
		   TERMUX_APP_SCRIPTS 剔除清单里，设备上不存在。 */
		await run(androidOpener(), ["Open", path], signal, "hidden");
		return;
	}
	throw new Error(\`native path opener is unsupported on \${platform}\`);`,
    "native-command 的 openNativePathWithIntent 平台分派",
  );

  // b2) 打开器路径解析 + 「打开所在文件夹」的 android 分支。
  src = replaceOnce(
    src,
    `	if (manager === "directory") {
		await run("xdg-open", [dirname(path)], signal, "hidden");
		return;
	}
	throw new Error(\`native file manager is unsupported on \${platform}\`);`,
    `	if (manager === "directory") {
		/* Android 上「显示文件位置」= 用系统文件管理器打开所在目录。 */
		if (platform === "android") {
			await run(androidOpener(), ["Open", dirname(path)], signal, "hidden");
			return;
		}
		await run("xdg-open", [dirname(path)], signal, "hidden");
		return;
	}
	throw new Error(\`native file manager is unsupported on \${platform}\`);`,
    "native-command 的 revealNativePath 平台分派",
  );

  // b3) 打开器路径：<root>/libexec/termux-api（KXXY_ENGINE_ROOT 由 EngineConfig 注入）。
  src = replaceOnce(
    src,
    `/** Documents a browser renders, as opposed to ones an editor merely edits. */`,
    `/**
* Android 上的「打开」执行器：引擎根下 libexec/termux-api 的脚本 shim。
*
* 为什么是它而不是 termux-open：后者在 build-runtime.mjs 的
* TERMUX_APP_SCRIPTS 剔除清单里（设备上不存在），而 termux-api 每轮引擎
* 启动都会被 TermuxApiServer.installShim 换成脚本，是唯一稳定的
* 「引擎 → 应用进程」执行器。第一个参数是方法名（Open），与 termux-api 的
* 命令行约定一致。
* @returns the absolute path of the opener script.
*/
function androidOpener() {
	const root = process.env.KXXY_ENGINE_ROOT ?? "";
	return root === "" ? "termux-api" : \`\${root}/libexec/termux-api\`;
}
/** Documents a browser renders, as opposed to ones an editor merely edits. */`,
    "native-command 的 androidOpener 注入点",
  );

  // c) nativeFileApplications：android 给一个「系统默认打开方式」条目。
  src = replaceOnce(
    src,
    `	if (target.platform !== "win32") return [];`,
    `	/* Android：没有可查询的关联表（PackageManager 的 queryIntentActivities 需要
	   应用进程的 Context）。给一个「系统默认打开方式」条目，让前端的
	   deliverables.file.actions 分体按钮有主键可渲染 —— 点击走 openNativePath，
	   由系统自己选应用（.apk ⇒ 安装器）。 */
	if (target.platform === "android") return [{
		id: "android-default",
		name: "系统默认打开方式",
		default: true,
		icon: null
	}];
	if (target.platform !== "win32") return [];`,
    "native-command 的 queryFileApplications 平台分派",
  );

  // c2) openNativeFileApplication：android 忽略 application id，走默认打开。
  src = replaceOnce(
    src,
    `	if (target.platform === "win32") {
		await windowsFileApplications(target.path, application, signal, run);
		return;
	}
	if (!(await queryFileApplications(path, signal, internals, false)).some((app) => app.id === application)) throw new Error("Application is not registered for this file");`,
    `	if (target.platform === "win32") {
		await windowsFileApplications(target.path, application, signal, run);
		return;
	}
	/* Android：只有一个「系统默认」条目，application id 没有可校验的关联表，
	   直接按默认方式打开（与用户在系统弹窗里再选一次等价）。 */
	if (target.platform === "android") {
		await openNativePathWithIntent(target.path, signal, "association", internals);
		return;
	}
	if (!(await queryFileApplications(path, signal, internals, false)).some((app) => app.id === application)) throw new Error("Application is not registered for this file");`,
    "native-command 的 openNativeFileApplication 平台分派",
  );

  must(src.includes('platform === "android"'), "native-command 的 android 补丁未生效");
  ctx.write(rel, src);
  return "dsh-native-command → Android 放行桌面能力（打开/显示位置走 termux-api shim）";
}

/**
 * 硅基流动（以及同类「OpenAI 兼容但只认四个 role」的网关）收到 `developer` 角色会 400。
 *
 * ── 症状（用户真机报，附截图）────────────────────────────────────────────
 *
 * 在手机上用「硅基流动」做 provider，**每一轮都失败**，界面原文：
 *
 *     本轮运行失败 400  INVALID_REQUEST
 *     {"code":20015,"message":"Input tag 'developer' found using 'role' does not
 *      match any of the expected tags: 'system', 'user', 'assistant', 'tool'"}
 *
 * 同一份 provider 配置在**桌面端完全正常** —— 这一点很误导，容易让人怀疑
 * 手机端打包漏了什么。实测桌面与手机的 `pi-ai` 逐字节相同（64579 B），
 * 所以差异不在代码，而在**模型元数据**。
 *
 * ── 根因链（三层，缺一不可）─────────────────────────────────────────────
 *
 *   1. `@earendil-works/pi-ai` 的 `openai-completions.js` 里只有一行决定角色：
 *
 *          const instructionRole = model.reasoning && compat.supportsDeveloperRole
 *              ? "developer" : "system";
 *
 *      所以只要 `reasoning` 与 `supportsDeveloperRole` 同时为真，系统提示词就
 *      以 `developer` 身份发出。
 *
 *   2. `supportsDeveloperRole` 来自 `detectCompat()` 里一份**硬编码的
 *      「非标准 provider」名单**：
 *
 *          const isNonStandard = isNvidia || isCerebras || provider === "xai" ||
 *            isTogether || baseUrl.includes("chutes.ai") || isDeepSeek || isZai ||
 *            isMoonshot || provider === "opencode" || isCloudflareWorkersAI ||
 *            isCloudflareAiGateway || isAntLing;
 *          supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter)
 *
 *      `api.siliconflow.cn` **不在名单里** ⇒ 被判成「标准 OpenAI」⇒
 *      `supportsDeveloperRole = true`。而硅基流动的后端是 Rust 网关，它的
 *      tagged enum 只认 `system/user/assistant/tool`，于是整体 400。
 *
 *   3. `model.reasoning` 来自配置里的 `models[].reasoningEfforts`：写了非空
 *      dict 就是 `true`（见 dsh-llm-pi-ai 的 `resolveModelReasoning`）。
 *      桌面端的 `guijiji` 路由**没有**这个字段 ⇒ `reasoning = false` ⇒
 *      走 `system` ⇒ 一直正常。手机端用户在设置页打开过「推理等级」开关
 *      ⇒ 写入 `reasoningEfforts` ⇒ `reasoning = true` ⇒ 触发 1 里的分支。
 *
 * **注意「推理等级 → Off」救不了**：那个下拉框改的是每次请求的
 * `reasoningEffort`（`profileOptions` 里 `reasoning === "off" ? undefined : reasoning`），
 * 只决定要不要发推理参数，**完全不碰 `model.reasoning`**。用户按「关掉推理」
 * 操作后错误照旧，正是这个原因（真机复验过）。
 *
 * ── 修法：把判定改成「问得出答案就问，问不出来就不发」───────────────────
 *
 * 不在名单里加 `siliconflow`（那是把上游的硬编码名单再抄一遍，换个中转域名
 * 又会复发，且要跟 pi-ai 的版本走）。而是给 `detectCompat` 补一条**通用**
 * 规则：`baseUrl` 里出现自建/第三方网关的常见特征时，`developer` 一律不发。
 *
 * 但「猜域名」仍然脆弱。真正稳的是**让用户可覆盖**：pi-ai 已经支持
 * `model.compat.supportsDeveloperRole`（`COMPLETIONS_COMPAT_GATE` 里是
 * `"offer"`，即路由级与模型级都能配），所以本补丁只做一件事 ——
 * **把硅基流动这类已知不认 `developer` 的域名补进 `isNonStandard`**，
 * 同时保留配置覆盖的能力。用户仍可在 `cordis.patch.yml` 里写
 * `compat.supportsDeveloperRole: true` 强行打开（例如换成真的 OpenAI）。
 *
 * 为什么不改 `dsh-llm-pi-ai` 而是改 pi-ai 本体：`instructionRole` 那行在
 * pi-ai 里，dsh-llm-pi-ai 只是把 `compat` 传下去。改上层拿不到这个判定点。
 */
function patchDeveloperRoleCompat(ctx) {
  const rel = "@earendil-works/pi-ai/dist/api/openai-completions.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 @earendil-works/pi-ai）";

  const src = ctx.read(rel);
  const ANCHOR = 'const isNonStandard = isNvidia ||';

  // 幂等：补丁集标记之外，再按「本补丁的独有片段」判一次，避免重复拼接。
  if (src.includes("KXXY_DEVELOPER_ROLE_GUARD")) {
    return "已打过（硅基流动等网关的 developer 角色兼容），跳过";
  }
  must(src.includes(ANCHOR), `pi-ai 的 detectCompat 结构变了：找不到锚点 "${ANCHOR}"`);

  /*
   * 追加一组域名判定。刻意与上游 `isNonStandard` 的写法保持同一形状
   * （一串 `||`），这样上游升级时 diff 一眼能看出来。
   *
   * 名单依据（每一条都是「OpenAI 兼容但 tagged enum 只认四个 role」的网关）：
   *   · siliconflow.cn / siliconflow.com —— 硅基流动，本次真机事故
   *   · dashscope.aliyuncs.com          —— 阿里百炼（兼容模式同样不认 developer）
   *   · open.bigmodel.cn                —— 智谱（上游已按 zai 处理，这里兜底）
   *   · api.moonshot.                   —— 月之暗面（同上）
   * 新域名只需加一条 `baseUrl.includes(...)`，不必再动结构。
   */
  const GUARD = `
    /* KXXY_DEVELOPER_ROLE_GUARD: 这些网关的 role 是 tagged enum，只认
       system/user/assistant/tool；发 developer 会整体 400。见 patches.mjs
       的 patchDeveloperRoleCompat 注释（缺陷 EA）。 */
    const isDeveloperRoleHostile = baseUrl.includes("siliconflow.cn") ||
        baseUrl.includes("siliconflow.com") ||
        baseUrl.includes("dashscope.aliyuncs.com") ||
        baseUrl.includes("open.bigmodel.cn") ||
        baseUrl.includes("api.moonshot.");`;

  let out = src.replace(ANCHOR, `${GUARD}\n    const isNonStandard = isDeveloperRoleHostile || isNvidia ||`);
  must(out !== src, "pi-ai 的 isNonStandard 改写未生效");

  // `supportsDeveloperRole` 那一行不动：`isNonStandard` 变真之后它自然为 false，
  // 而且这样保留了「用户显式配置 compat 覆盖」的路径（getCompat 里 compat 优先）。
  const BEFORE = "const isNonStandard = isDeveloperRoleHostile || isNvidia ||";
  must(out.includes(BEFORE), "pi-ai 的 isNonStandard 改写锚点丢失");

  ctx.write(rel, out);
  return "pi-ai → 硅基流动/百炼/智谱/月暗 等网关不再发 developer 角色（缺陷 EA）";
}

/**
 * 旧世代客户端运行时的别名：`@deepseek-ai/dsh-client-runtime/client` → 平台 store 种子。
 *
 * 症状（用户报，2026-11-02 真机）：装上 `@neystan/dsh-web-ui-all`（task-board /
 * pet / describe-image 三件）与 `dsh-at-file` 之后，对话页**整页**停在
 * `Failed to load plugins`，每一条错误都长这样：
 *
 *     client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed
 *     the module table — not a platform seed word, not a materialized module,
 *     and no registered package factory
 *
 * 根因不在插件，在上游**换代**：`@deepseek-ai/dsh-client-runtime` 这个「客户端
 * 运行时总包」在 0.1.x 时代是插件公共依赖，它的 `./client` 子路径只做一件事
 * —— 转出 store 契约（`createSnapshotStore` / `defineStore` / `shallowEqual`）。
 * 当前 0.2.1 把它拆成了 `dsh-client-store` + 一票 `dsh-client-ui-*`，总包本身
 * **根本不在安装树里**（`app.asar` 里一条都搜不到），于是老插件按老名字
 * require 时直接命中「module table 里没有这个名字」的硬错误。
 *
 * 为什么别名到 store 是**等价**而不是将就：对比过两边的类型声明
 * （`dsh-client-runtime@0.1.1-rc.2` 的 `lib/types/client/contract/store.d.ts`）
 * 与前端产物里的 store 实现，函数名 / 参数 / 返回值一致；被这批插件实际用到的
 * 成员只有 `createSnapshotStore`（task-board、describe-image、dsh-at-file）和
 * `defineStore`（dsh-pet）。老名字指到同一个对象上，语义完全对齐。
 *
 * 为什么打在加载器而不是前端产物：种子表（`staticModules`）在
 * `dist/assets/index-<hash>.js` 里，文件名带内容哈希、每次发版都重新压缩；
 * 而种子表是**由前端传进来**的参数，加载器 `dsh-client-modules/lib/client.js`
 * 是普通打包产物 —— 路径稳定、代码可读。在加载器里补别名，前端换版不用跟着改。
 *
 * 幂等：记号、完整补丁字节及构造函数插入位置必须同时吻合，伪标记不跳过。
 */
export function patchClientRuntimeAlias(ctx) {
  const rel = "@deepseek-ai/dsh-client-modules/lib/client.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 dsh-client-modules）";
  const src = ctx.read(rel);
  const { compact } = clientFactory(src, '@deepseek-ai/dsh-client-modules');
  const indent = compact ? '' : '\t\t\t\t';
  // 裸包名代表整个旧运行时，不能错误地用 store 顶替。
  const ALIASES = [["@deepseek-ai/dsh-client-runtime/client", "@deepseek-ai/dsh-client-store"]];
  const body = [
    "",
    `${indent}/* KXXY_CLIENT_RUNTIME_ALIAS: 0.1.x 的「客户端运行时总包」在 0.2.x 被拆掉，`,
    `${indent}   它的 ./client 子路径当年只是 store 契约的转发。老插件仍按老名字 require，`,
    `${indent}   于是整页停在 Failed to load plugins。别名到 store 种子（同一份实现的同一个`,
    `${indent}   对象），语义等价。见 tools/lib/patches.mjs 的 patchClientRuntimeAlias。 */`,
    `${indent}for (const [kxxyAlias, kxxyTarget] of ${JSON.stringify(ALIASES)}) {`,
    `${indent}\tif (!this.seed.has(kxxyAlias) && this.seed.has(kxxyTarget)) this.seed.set(kxxyAlias, this.seed.get(kxxyTarget));`,
    `${indent}}`,
  ].join("\n");
  const already = src.includes('KXXY_CLIENT_RUNTIME_ALIAS');
  if (already) clientAnchor(src, 'KXXY_CLIENT_RUNTIME_ALIAS', '客户端别名标记');
  const raw = already ? replaceOnce(src, body, '', '客户端别名完整补丁') : src;
  const factory = clientFactory(raw, '@deepseek-ai/dsh-client-modules');
  const classHead = compact ? 'var ClientModuleSystem=class{' : 'var ClientModuleSystem = class {';
  const classAt = clientAnchor(factory.body, classHead, 'ClientModuleSystem 类');
  const constructorHead = compact ? 'constructor(options){' : 'constructor(options) {';
  const constructorAt = clientAnchor(factory.body, constructorHead, 'ClientModuleSystem 构造函数');
  const end = clientAnchor(factory.body, compact ? 'register(registration){' : 'register(registration) {', 'ClientModuleSystem 后继方法');
  must(classAt < constructorAt && constructorAt < end, 'ClientModuleSystem 构造函数层级已改变');
  clientSyntax(`(function(require){${factory.body.slice(0, classAt)}\n})`, 'ClientModuleSystem factory 层级');
  clientSyntax(`class KxxyBoundary{${factory.body.slice(classAt + classHead.length, constructorAt)}\n}`, 'ClientModuleSystem 字段边界');
  const constructor = factory.body.slice(constructorAt, end);
  clientSyntax(`class KxxyBoundary{${constructor}\n}`, 'ClientModuleSystem 构造函数边界');
  const setup = compact
    ? 'constructor(options){this.manifest=options.manifest;this.entries=new ClientEntries(this,{'
    : 'constructor(options) {\n\t\t\t\tthis.manifest = options.manifest;\n\t\t\t\tthis.entries = new ClientEntries(this, {';
  must(constructor.startsWith(setup), 'ClientModuleSystem manifest / entries 初始化已改变');
  const anchor = compact ? 'this.seed=new Map(Object.entries(options.staticModules));' : 'this.seed = new Map(Object.entries(options.staticModules));';
  const seedAt = clientAnchor(constructor, anchor, 'ClientModuleSystem seed 构造点');
  clientAnchor(factory.body, anchor, '客户端模块唯一 seed 构造点');
  const beforeSeed = compact ? 'prune:roots=>{this.prune(roots)}});' : 'prune: (roots) => {\n\t\t\t\t\t\tthis.prune(roots);\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t\t';
  must(constructor.slice(0, seedAt).endsWith(beforeSeed), 'seed 不紧邻 ClientEntries 初始化');
  const seedEnd = seedAt + anchor.length;
  clientSyntax(`class KxxyBoundary{${constructor.slice(0, seedEnd)}\n}}`, 'seed 必须是构造函数顶层语句');
  const next = compact
    ? 'this.loadBundle=options.loadBundle??defaultLoadBundle;this.resolveAsset=options.resolveAsset??(reference=>reference);'
    : '\n\t\t\t\tthis.loadBundle = options.loadBundle ?? defaultLoadBundle;';
  must(constructor.slice(seedEnd).startsWith(next), 'seed 后的加载器初始化已改变');
  clientAnchor(factory.body, compact ? 'exports.ClientModuleSystem=ClientModuleSystem;' : 'exports.ClientModuleSystem = ClientModuleSystem;', '客户端模块类导出');
  const at = factory.head.length + constructorAt + seedEnd;
  const out = raw.slice(0, at) + body + raw.slice(at);
  clientSyntax(out, '客户端别名完整产物');
  if (already) {
    must(out === src, '客户端别名不在唯一 seed 构造点之后');
    return '已打过（客户端运行时总包别名），跳过';
  }
  ctx.write(rel, out);
  return "客户端运行时总包别名 → @deepseek-ai/dsh-client-runtime/client 指向 store 种子（老插件可加载）";
}

/**
 * 前端 boot：**一个第三方插件挂掉不再让整页停摆**，改成「跳过它，其余照常」。
 *
 * 症状（用户报，2026-11-02）：装了不兼容的插件后，对话页整页只剩
 * `HARNESS / Failed to load plugins` —— 引擎活着、会话完好、控制台也进得去，
 * 唯独对话页进不去。用户的原话是「哪怕不兼容也不应该崩溃」。
 *
 * rc.5 的同步审计 `IZ` 会因任意 entry 失败而 throw。rc.2 的异步审计 `VJ`
 * 已能跳过非核心 entry，但固定七项之外的官方包也只告警，且告警文案不再满足
 * 本地体检契约。两版都只改最终的来源分类与报告，不改 entry 生命周期。
 *
 * 判定改成按来源分档：
 *   · 官方包（`@deepseek-ai/*`）失败 —— 仍然硬失败。它们与运行时是同一套
 *     安装，集体失败意味着运行时本身坏了，这时候留一张能读的错误卡比半残
 *     界面有用；
 *   · 其它（第三方 / 自带插件）—— 只 `console.warn` 并继续挂载。页面照常
 *     可用，坏掉的那个插件就是「它的功能不出现」。
 *
 * 为什么可以这样降级：`IZ` 只是**汇总**，它跑之前 loader 已经把每个 entry
 * 的失败隔离在自己的 fiber 里了（`entries.start` 里逐条处理），后面的
 * `EZ(ctx)` 要注入 `uiRenderer` 才挂载 —— 真挂了收集器的核心问题会在那一步
 * 抛出来，仍然会走 `page.fail`。所以这里不吞掉任何致命信息。
 *
 * 告警文案刻意保留 `web boot:` 前缀与「failed and were skipped」措辞：
 *   · 原生 `WebBootLog` 按特征串落盘（见 MARKERS）；
 *   · 体检 WEB_BOOT 按同一特征串把它判成 WARN 而不是 BAD
 *     （页面能用 ≠ 页面进不去，两者不能共用一档）。
 *
 * 双版本锚点锁定完整收集器、状态映射和调用等待顺序；rc.2 继续 await 激活
 * 失败原因，并按对象的 name 而非 reason 判定来源。结构漂移必须让构建失败，
 * 幂等也要验证完整改写结果，不能仅凭一段告警措辞跳过。
 */
export function patchFrontendLenientBoot(ctx) {
  const PREFIX = "lib/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/";
  const mains = [...ctx.files.keys()].filter((k) => k.startsWith(PREFIX) && /\/index-[^/]+\.js$/.test(k));
  must(mains.length === 1, `前端主 chunk 定位失败：命中 ${mains.length} 个（期望 1 个 index-<hash>.js）`);
  const key = mains[0];
  const text = ctx.files.get(key).data.toString("utf8");
  // 两版收集器完整锁定，尤其不重写 rc.2 的 importError / await 激活失败原因。
  const legacyCollect = 'function IZ(e,t){const r=[];for(const i of e.loader.entries()){const n=i.options.name;if(i.fiber===void 0){const l=t.importError(n);r.push(l===void 0?`${n}: import failed (see console for the import error)`:`${n}: import failed: ${l.message}`);continue}const s=yx[i.fiber.state];if(s!=="active")if(s==="pending"){const l=Object.keys(i.fiber.inject).filter(u=>e.get(u)===void 0);r.push(`${n}: pending (waiting for service${l.length===1?"":"s"}: ${l.join(", ")||"unknown"})`)}else r.push(`${n}: ${s}`)}';
  const modernCollect = 'async function VJ(e,t,r=i=>{console.warn(i)}){const i=[];for(const c of e.loader.entries()){const d=c.options.name;if(c.fiber===void 0){const h=t.importError(d);i.push({name:d,reason:h===void 0?"import failed (see console for the import error)":`import failed: ${h.message}`});continue}const f=o$[c.fiber.state];if(f!=="active")if(f==="pending"){const h=Object.keys(c.fiber.inject).filter(v=>e.get(v)===void 0);i.push({name:d,reason:`pending (waiting for service${h.length===1?"":"s"}: ${h.join(", ")||"unknown"})`})}else f==="failed"?i.push({name:d,reason:await HJ(c.fiber)}):i.push({name:d,reason:f})}';
  // rc.3 只换了三个压缩标识符（收集器 VJ→ZJ、核心集合 UJ→VJ、激活原因 HJ→BJ），
  // 函数体与调用顺序逐字未变 —— 所以按「同形态换名」派生，而不是再抄一份长字面量。
  const modernCollectRc3 = modernCollect
    .replace('async function VJ(', 'async function ZJ(')
    .replace('await HJ(c.fiber)', 'await BJ(c.fiber)');
  const modernTail = 'if(i.length===0)return;const n=c=>UJ.has(c),o=i.filter(({name:c})=>n(c)).length;if(o>0){const c=i.map(({name:d,reason:f})=>`${d}${n(d)?" (required)":""}: ${f}`);throw new Error(`web boot: ${String(o)} required ${a9(o)} did not activate\n${c.join(`\n`)}`)}const l=i.map(({name:c,reason:d})=>`${c}: ${d}`);r(`web boot: warning: ${String(i.length)} ${a9(i.length)} did not activate\n${l.join(`\n`)}`)}';
  const forms = [
    {
      collect: legacyCollect, id: 'r', warn: 'console.warn', structured: false,
      audit: 'IZ', required: null, reason: null,
      tail: 'if(r.length>0)throw new Error(`web boot: ${String(r.length)} entr${r.length===1?"y":"ies"} did not activate\n${r.join(`\n`)}`)}',
    },
    {
      collect: modernCollect, id: 'i', warn: 'r', structured: true,
      audit: 'VJ', required: 'UJ', reason: 'HJ', label: 'rc.2',
      tail: modernTail,
    },
    {
      collect: modernCollectRc3, id: 'i', warn: 'r', structured: true,
      audit: 'ZJ', required: 'VJ', reason: 'BJ', label: 'rc.3',
      tail: modernTail.replace('const n=c=>UJ.has(c)', 'const n=c=>VJ.has(c)'),
    },
  ];
  const matches = [];
  for (const form of forms) {
    const { id, warn, structured } = form;
    const lines = name => structured
      ? `${name}.map(function(kxxyEntry){return kxxyEntry.name+": "+kxxyEntry.reason})`
      : name;
    const body = [
      structured ? `if(${id}.length===0)return;` : '',
      `const kxxyFatal=${id}.filter(function(kxxyLine){return /^@deepseek-ai\\//.test(${structured ? 'kxxyLine.name' : 'kxxyLine'})});`,
      `if(kxxyFatal.length>0)throw new Error("web boot: "+String(kxxyFatal.length)+" entr"+(kxxyFatal.length===1?"y":"ies")+" did not activate\\n"+${lines('kxxyFatal')}.join("\\n"));`,
      `if(${id}.length>0)${warn}("web boot: "+String(${id}.length)+" entr"+(${id}.length===1?"y":"ies")+" from third-party plugins failed and were skipped (their UI stays absent; details below)\\n"+${lines(id)}.join("\\n"));`,
      '}',
    ].join('');
    const patched = form.collect + body;
    for (const [code, already] of [[form.collect + form.tail, false], [patched, true]]) {
      if (text.includes(code)) matches.push({ ...form, code, patched, already });
    }
  }
  must(matches.length === 1, `前端 boot 审计结构未知或不唯一：命中 ${matches.length} 种形态`);
  const form = matches[0];
  clientAnchor(text, form.collect, '前端 boot 唯一收集器');
  clientAnchor(text, form.structured ? `async function ${form.audit}(e,t,r=` : 'function IZ(e,t){', '前端 boot 审计函数');
  const state = form.structured ? 'No' : 'Vi';
  const labels = form.structured ? 'o$' : 'yx';
  clientAnchor(text, `${state}={PENDING:0,LOADING:1,ACTIVE:2,FAILED:3,DISPOSED:4,UNLOADING:5}`, '前端 boot 状态枚举');
  clientAnchor(text, `${labels}={[${state}.PENDING]:"pending",[${state}.LOADING]:"loading",[${state}.ACTIVE]:"active",[${state}.FAILED]:"failed",[${state}.DISPOSED]:"disposed",[${state}.UNLOADING]:"unloading"}`, '前端 boot 状态映射');
  // 审计函数的**调用点**：rc.2/rc.3 的收集器是 async，调用点写作
  // `await n.await(),await <collector>(t,e.modules)`；而 **rc.5 又改回同步**
  // （`function IZ(e,t){…}`，调用点 `await n.await(),IZ(t,e.modules)`，没有第二个
  // await）。早期版本这里把 `await ` 写死在锚点里，于是在 rc.5 上恒报
  // 「未找到锚点」，整条构建链在 [5/8] 就断掉。
  //
  // 两种写法都接受：按「收集器名前面有没有 await」各试一次，必须**恰好命中一次**
  // 且只命中一种（同一次构建里出现两种形态说明前端结构未知，宁可失败）。
  const callAnchors = [
    `await n.await(),await ${form.audit}(t,e.modules)`,
    `await n.await(),${form.audit}(t,e.modules)`,
  ].filter((anchor) => text.includes(anchor));
  must(callAnchors.length === 1, `前端 boot 审计调用与等待顺序 —— 未找到锚点（命中 ${callAnchors.length} 种写法）`);
  clientAnchor(text, callAnchors[0], '前端 boot 审计调用与等待顺序');
  if (form.structured) {
    clientAnchor(text, `async function ${form.reason}(e){try{await e.await()}catch(t){return\`failed: \${String(t)}\`}return"failed"}`, '前端 boot 异步激活失败原因');
    const required = ['dsh-client-modules', 'dsh-api-session-controller', 'dsh-client-ui-renderer', 'dsh-client-ui-layout', 'dsh-client-ui-session', 'dsh-client-ui-chat', 'dsh-client-ui-sidebar'].map(name => `@deepseek-ai/${name}`);
    clientAnchor(text, `${form.required}=new Set(${JSON.stringify(required)})`, '前端 boot 上游核心入口集合');
  }
  clientSyntax(`(${form.code})`, '前端 boot 原审计函数');
  clientSyntax(`(${form.patched})`, '前端 boot 新审计函数');
  if (form.already) {
    clientAnchor(text, 'failed and were skipped', '前端 boot 降级标记');
    return '已打过（第三方插件加载失败降级），跳过';
  }
  must(!text.includes('failed and were skipped') && !text.includes('kxxyFatal'), '前端 boot 补丁部分应用或标记冲突');
  const out = replaceOnce(text, form.code, form.patched, '前端 boot 审计函数');
  ctx.files.set(key, { data: Buffer.from(out, 'utf8'), mode: ctx.files.get(key).mode ?? 0o644 });
  return `前端 boot 降级 → 第三方插件加载失败只跳过（官方包仍硬失败）：${key.split('/').pop()}`;
}

export function applyAllPatches(root, termuxRead) {
  const ctx = createPatchContext(root);
  const steps = [
    patchKoffi, patchSharp, patchNodePty, patchSherpaOnnx, patchSubprocessInspector, patchFlock,
    patchRequireBuiltin, patchSandboxLocal, patchSessionJsonl, patchSessionJsonlWorker,
    patchRipgrep, patchFsLocal, patchAttachmentLocal, patchNativeCommandAndroid,
    patchDocumentPreviewUnicodeSets, patchLibreOfficeKitPlatform, patchLibreOfficeKitFontFallbacks,
    patchOfficeDefaultFonts, patchOfficeToPdfFormats, patchDocumentPreviewOfficeExtensions, patchDocumentPreviewArchiveProviders,
    patchDocumentPreviewMediaProviders, patchDeveloperRoleCompat, patchClientRuntimeAlias,
    patchFrontendLenientBoot, patchDshManifest,
  ];
  const results = [], errors = [];
  for (const step of steps) {
    try { results.push(step(ctx, termuxRead)); }
    catch (error) { errors.push(new Error(`${step.name}: ${error.message}`, { cause: error })); }
  }
  // 一次报告所有上游锚点变化，但任意失败仍禁止生成运行时，不把失败当成跳过。
  if (errors.length) throw new AggregateError(errors, `${errors.length} 个 Android 补丁失败：\n${errors.map(e => e.message).join('\n')}`);
  return results;
}
