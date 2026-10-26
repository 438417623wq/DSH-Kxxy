/**
 * Android 兼容补丁：唯一允许触碰上游 dsh 依赖树的地方。
 *
 * 每一条都注明「为什么必须打」与「安全性依据」——静默漏打补丁的代价是
 * 用户设备上出现难以归因的崩溃（参考项目为此发过两次事故版本）。
 *
 * 全部补丁作用在已抽取到磁盘的 dsh 依赖树上，路径基准 = <root>/lib/node_modules。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * dsh-fs-local 的原子发布：`linkFile(tempPath, absolutePath)` 在 Android 上
 * 因 SELinux 禁 link 而失败，且失败后的 throwGuardedCreateFailure 在
 * 「目标不存在」时会静默返回 —— 结果是**文件根本没被写入**（不是报错）。
 * 因此必须显式改成 rename 路径。
 */
function patchFsLocal(ctx) {
  const rel = "@deepseek-ai/dsh-fs-local/lib/index.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 dsh-fs-local）";
  const src = ctx.read(rel);
  const out = replaceOnce(
    src,
    `\t\tif (createIfAbsent !== void 0) try {
\t\t\tawait linkFile(tempPath, absolutePath);
\t\t} catch (error) {
\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
\t\t}`,
    `\t\tif (createIfAbsent !== void 0) {
\t\t\tif (platform === "android") {
\t\t\t\t/* Android：SELinux 在 app 域禁 link()，而 link 失败后的
\t\t\t\t   throwGuardedCreateFailure 在「目标不存在」时会静默返回 ——
\t\t\t\t   文件不会被写入。这里直接走 rename（同目录，具备同样的
\t\t\t\t   原子发布语义），但保留原有的「不得覆盖未读过的文件」守卫。 */
\t\t\t\tlet existing;
\t\t\t\ttry {
\t\t\t\t\texisting = await inspectPublicationTarget(absolutePath);
\t\t\t\t} catch (metadataError) {
\t\t\t\t\tif (!isENOENT(metadataError) && !isENOTDIR(metadataError)) throw new FsError(\`cannot write "\${createIfAbsent.displayPath}": \${errorMessage(metadataError)}\`, "FS_IO_ERROR", { cause: metadataError });
\t\t\t\t}
\t\t\t\tif (existing !== void 0) {
\t\t\t\t\tif (!existing.isFile()) throw new FsError(\`cannot write "\${createIfAbsent.displayPath}": not a regular file\`, "FS_NOT_REGULAR_FILE");
\t\t\t\t\tthrow new FsError(\`cannot overwrite existing "\${createIfAbsent.displayPath}" without reading it first\`, "FS_NOT_OBSERVED");
\t\t\t\t}
\t\t\t\tawait rename(tempPath, absolutePath);
\t\t\t} else try {
\t\t\t\tawait linkFile(tempPath, absolutePath);
\t\t\t} catch (error) {
\t\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
\t\t\t}
\t\t}`,
    "dsh-fs-local 的 linkFile 发布点",
  );
  must(out.includes("await rename(tempPath, absolutePath);"), "fs-local 补丁未生效");
  ctx.write(rel, out);
  return "dsh-fs-local → Android 走 rename 发布";
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
 * libreoffice-kit 的宿主平台门禁：Android 上必须放行 wasm 后端。
 *
 * 上游把「非 linux」一律当不支持的宿主，代码里三处硬编码：
 *   1. `platformTarget()` 尾部 `if (platform !== "linux") return void 0;`
 *   2. `resolveEngine()` 里原生包缺失时 `if (platform !== "linux") throw …Required…missing`
 *   3. `resolveEngine()` 尾部 `if (platform !== "linux") throw …Unsupported LibreOfficeKit host`
 * 第 3 处是决定性的：Android 上 `platformTarget()` 本就返回 `void 0`（`details` 为空、
 * 取不到 `glibcVersionRuntime`），流程必然走到第 3 处抛错，永远到不了紧随其后的
 * `readEngine(resolvePackage('@deepseek-ai/libreoffice-kit-wasm'), "wasm", "wasm")`。
 *
 * 为什么必须放行 wasm 而不是补原生包：Android 上没有 linux-glibc 预编译产物，
 * 而 `@deepseek-ai/libreoffice-kit-wasm` 是纯 wasm 引擎（soffice.wasm + soffice.data），
 * 与宿主 ABI 无关，实测在 arm64 Android 上可完成 docx/pptx → PDF（约 4.5 s）。
 *
 * 安全性依据：三处判据只影响「要不要用 wasm 后端」这一条路径选择。Android 上
 * 原生包本来就解析不到，放行后行为等同于「原生缺失 → 落到 wasm」，与桌面
 * Linux 上原生缺失时的行为一致。
 */
function patchLibreOfficeKitPlatform(ctx) {
  const rel = "@deepseek-ai/libreoffice-kit/lib/index.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无 libreoffice-kit）";
  const src = ctx.read(rel);
  const from = 'if (platform !== "linux")';
  const to = 'if (platform !== "linux" && platform !== "android")';
  const hits = src.split(from).length - 1;
  must(hits === 3, `libreoffice-kit 平台门禁 —— 期望 3 处，实际 ${hits} 处`);
  ctx.write(rel, src.split(from).join(to));
  return "libreoffice-kit → 平台门禁放行 android（启用 wasm 后端）";
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
function patchDocumentPreviewOfficeExtensions(ctx) {
  const rel = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无文档预览客户端）";
  const from = 'const extensions = [\n\t\t\t\t"doc",\n\t\t\t\t"docx",\n\t\t\t\t"ppt",\n\t\t\t\t"pptx"\n\t\t\t];';
  const to =
    'const extensions = [\n\t\t\t\t"doc",\n\t\t\t\t"docx",\n\t\t\t\t"odt",\n\t\t\t\t"ppt",\n\t\t\t\t"pptx",\n\t\t\t\t"odp",\n\t\t\t\t"ods"\n\t\t\t];';
  const patched = replaceOnce(ctx.read(rel), from, to, "文档预览 office provider 的扩展名清单");
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
function patchDocumentPreviewArchiveProviders(ctx) {
  const rel = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js";
  if (!ctx.exists(rel)) return "跳过（依赖树无文档预览客户端）";
  const fragment = prebuilt("documentpreview-archive/providers.js").toString("utf8").trimEnd();
  must(
    fragment.includes("function kxxyArchiveApply("),
    "文档预览归档 provider —— 片段缺少 kxxyArchiveApply 入口",
  );
  must(
    !fragment.includes("</script"),
    "文档预览归档 provider —— 片段含 </script，内联进 bundle 会截断脚本",
  );

  const tail = "\t\t//#endregion\n\t\texports.apply = apply;";
  const call = "\t\t\tapply$3(ctx);\n";
  let patched = replaceOnce(ctx.read(rel), tail, `${fragment}\n${tail}`, "文档预览客户端模块尾部");
  patched = replaceOnce(patched, call, `${call}\t\t\tkxxyArchiveApply(ctx);\n`, "文档预览 apply() 的收尾调用");
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
  const fragment = prebuilt("documentpreview-media/providers.js").toString("utf8").trimEnd();
  must(
    fragment.includes("function kxxyMediaApply("),
    "文档预览音视频 provider —— 片段缺少 kxxyMediaApply 入口",
  );
  must(
    !fragment.includes("</script"),
    "文档预览音视频 provider —— 片段含 </script，内联进 bundle 会截断脚本",
  );

  const tail = "\t\t//#endregion\n\t\texports.apply = apply;";
  const call = "\t\t\tkxxyArchiveApply(ctx);\n";
  let patched = replaceOnce(ctx.read(rel), tail, `${fragment}\n${tail}`, "文档预览客户端模块尾部（音视频）");
  patched = replaceOnce(patched, call, `${call}\t\t\tkxxyMediaApply(ctx);\n`, "文档预览 apply() 的音视频收尾调用");
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
 * dsh-web-mobile 3.1.0）。这个字段不参与 npm 安装（运行时树是离线装配的），
 * 只被 `profileDependencyNames` 读键名，但写真实版本号可让 `dsh plugin` 的
 * pnpm 操作在人工介入时不至于困惑。
 */
export function patchDshManifest(ctx) {
  const rel = "@deepseek-ai/dsh/package.json";
  const manifest = JSON.parse(ctx.read(rel));
  manifest.dependencies ??= {};

  const wanted = [
    ["kxxy-host", "0.1.0"],
    ["dsh-web-mobile", "3.1.0"],
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

export function applyAllPatches(root, termuxRead) {
  const ctx = createPatchContext(root);
  const results = [
    patchKoffi(ctx),
    patchSharp(ctx),
    patchNodePty(ctx),
    patchSubprocessInspector(ctx),
    patchFlock(ctx),
    patchRequireBuiltin(ctx),
    patchSandboxLocal(ctx),
    patchSessionJsonl(ctx),
    patchSessionJsonlWorker(ctx),
    patchRipgrep(ctx, termuxRead),
    patchFsLocal(ctx),
    patchAttachmentLocal(ctx),
    patchNativeCommandAndroid(ctx),
    patchDocumentPreviewUnicodeSets(ctx),
    patchLibreOfficeKitPlatform(ctx),
    patchLibreOfficeKitFontFallbacks(ctx),
    patchOfficeToPdfFormats(ctx),
    patchDocumentPreviewOfficeExtensions(ctx),
    patchDocumentPreviewArchiveProviders(ctx),
    patchDocumentPreviewMediaProviders(ctx),
    patchDeveloperRoleCompat(ctx),
    patchDshManifest(ctx),
  ];
  return results;
}
