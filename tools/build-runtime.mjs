/**
 * 装配 `assets/runtime.zip`：Termux stage（bionic 系统层）+ asar（dsh JS 依赖树）
 * → 一份可直接解压到 `filesDir/engine/` 的运行时。
 *
 * 用法：
 *   node tools/build-runtime.mjs [--stage <dir>] [--asar <app.asar>] [--out <zip>]
 *
 * 管线（顺序有约束，逐条注明理由）：
 *   loadStage → collectStage        符号链接解析成 link 条目
 *   → dedupeByContent               同内容只留一个本体，其余降级为 LINK
 *   → normaliseStageFiles           把 Termux 绝对前缀换成占位符（必须在去重之后：
 *                                   去重按 sha256，归一化会改内容）
 *   → resolveClosure → readClosureInto
 *   → applyAllPatches               全部补丁作用在 lib/node_modules 上
 *   → corepackWrappers              生成 bin/{pnpm,npm,npx}
 *   → mergeEntries + collectDirs
 *   → ZipWriter                     写出
 *
 * 为什么 shebang 用占位符而不是写死设备路径：构建期不知道 APK 的
 * `filesDir` 绝对路径（`/data/data/<pkg>/files`，pkg 可变、用户可改）。
 * 所以构建期只做「Termux 前缀 → @DSH_ROOT@」这步**变短**的替换，
 * App 侧解压后统一替换成真实路径（见 RuntimeInstaller.rewriteRootPlaceholder）。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import {
  collectStage,
  collectDirs,
  dedupeByContent,
  mergeEntries,
  readClosureInto,
  readPluginFiles,
  resolveClosure,
} from "./lib/assemble.mjs";
import { applyAllPatches, assertEngineFlags } from "./lib/patches.mjs";
import { downloadTo, openAsar, sha256Hex } from "./lib/registry.mjs";
import { TERMUX_PREFIX, isPruned } from "./lib/stage.mjs";
import { untarGz } from "./lib/targz.mjs";
import { ensureOfficeWasm, officeMapReader, verifyOfficeFonts, OFFICE_LAYER_MARKER, OFFICE_WASM_ROOT } from "./lib/office-assets.mjs";
import { readZipEntries } from "./lib/zipread.mjs";
import { ZipWriter } from "./lib/zipwrite.mjs";
import { stampCodexPlugin, attachCodexRuntime } from "./lib/codex.mjs";
import { stampHostPluginFingerprint } from "./lib/host-fingerprint.mjs";
import { satisfiesRange } from "./lib/semver-lite.mjs";
import { stageStaleness } from "./lib/stage-fresh.mjs";
import { themeCssFromAsarFiles } from "./lib/theme-css.mjs";
import { PYTHON_REVISION, PYTHON_HOST_FILES, loadPythonDependencies, verifyPythonInputs, verifyPythonRuntime, createPythonRepairAssets } from "./lib/python-runtime.mjs";
import { loadPyDeps, loadNativeMl, NATIVE_ML, PYDEPS } from "./lib/pydeps.mjs";
import { hardlinkWrappers, rsyncWrappers } from "./lib/hardlink-wrappers.mjs";
import { pythonDefaultWrappers } from "./lib/python-default.mjs";
import { readScriptText } from "./lib/script-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "..");

/**
 * 丢掉 spill 临时文件（见下方 [spillPath] 的注释）。
 *
 * 构建机上 `fs.rmSync` 可能被「删除一律进回收站」的钩子接管：
 * 对 600 MiB 级的临时文件它先把整份搬进回收站，再回一句
 * `参数错误 (0x80070002)` 把构建打断 —— 空间没省下来，产物还白做了。
 * 所以这里不依赖「删成功」：常规删一次（失败就吞），
 * 然后**无论删没删掉都 truncate 到 0**。下次 `openSync(p, "w")` 直接覆盖，
 * 0 字节文件不占空间，也不会影响任何后续判断。
 */
function dropSpill(p) {
  try {
    rmSync(p, { force: true });
  } catch {}
  if (existsSync(p)) {
    try {
      truncateSync(p, 0);
    } catch {}
  }
}

const ROOT_PLACEHOLDER = "@DSH_ROOT@";
const HOME_PLACEHOLDER = "@DSH_HOME@";
const TMP_PLACEHOLDER = "@DSH_TMP@";

/**
 * 路径替换表，**按 needle 长度降序应用**（长前缀必须先替换，否则
 * `/usr/` 被 `/usr` 先吃掉会留下一个多余的斜杠）。
 *
 * 为什么是四条而不是一条：Termux 的脚本里这三种写法都真实存在 ——
 *   `prefix=/data/data/com.termux/files/usr`      （*-config 系列，无尾斜杠）
 *   `DIR=/data/data/com.termux/files/usr/share/et`（有尾斜杠）
 *   `HOME=/data/data/com.termux/files/home`       （termux-backup 等）
 *   `cache_dir=/data/data/com.termux/cache/apt`   （bin/pkg）
 * 只替换带尾斜杠的那条，实测会漏掉 23 个文件（见 verify-runtime.mjs 的残留扫描）。
 *
 * 替换后字符串一律**变短**（`/data/data/com.termux/files/usr` 32 字节 →
 * `@DSH_ROOT@` 10 字节），因此不会撑破脚本里任何内嵌缓冲。
 */
const PATH_REWRITES = [
  [`${TERMUX_PREFIX}`, `${ROOT_PLACEHOLDER}/`],
  ["/data/data/com.termux/files/usr", ROOT_PLACEHOLDER],
  ["/data/data/com.termux/files/home", HOME_PLACEHOLDER],
  ["/data/data/com.termux/cache", TMP_PLACEHOLDER],
].sort((a, b) => b[0].length - a[0].length);

/**
 * 剔除清单：依赖 Termux 这个 Android 应用本体、在 DSH Kxxy 里必然失败的脚本。
 *
 * 全部是**脚本**（非 ELF），判据是它们都通过 `com.termux.termuxam.Am` /
 * `app_process` / `am broadcast` 去驱动 Termux 自己的 Activity 与 Service。
 * Kxxy 不是 Termux，这些 Intent 的接收者不存在，跑起来只会报
 * `Error: Activity not started, unable to resolve Intent`。
 *
 * 依据：`F:\KF\DSKX\_recon\termux-refs.mjs` 实测这些脚本在保留集合内
 * **没有被任何非 Termux 脚本引用**。（`bin/am` 报出的 250 处、`bin/pkg` 的
 * 93 处是子串误报 —— "am" 命中 "program"，"pkg" 命中 "pkg-config"。）
 *
 * 刻意**不删** `bin/login`、`bin/passwd`、`bin/chsh`、`bin/su`：
 * 它们是 ELF，`libtermux-auth.so` 在闭包里所以能正常加载，删 ELF 的风险
 * 远大于收益（`su` 还是 Shizuku/root 提权路径的一环）。
 */
const TERMUX_APP_SCRIPTS = new Set([
  "bin/am",
  "bin/termux-am",
  "bin/termux-am-socket",
  "bin/termux-backup",
  "bin/termux-restore",
  "bin/termux-change-repo",
  "bin/termux-info",
  "bin/termux-open",
  "bin/termux-open-url",
  "bin/termux-reload-settings",
  "bin/termux-reset",
  "bin/termux-setup-package-manager",
  "bin/termux-setup-storage",
  "bin/termux-wake-lock",
  "bin/termux-wake-unlock",
  "bin/termux-apps-info-app-version-name",
  "bin/termux-apps-info-app-version-name.bash",
  "bin/termux-apps-info-app-version-name.sh",
  "bin/termux-apps-info-env-variable",
  "bin/termux-apps-info-env-variable.bash",
  "bin/termux-apps-info-env-variable.sh",
  "bin/termux-scoped-env-variable",
  "bin/termux-scoped-env-variable.bash",
  "bin/termux-scoped-env-variable.sh",
  "bin/termux-exec-ld-preload-lib",
  "bin/termux-exec-system-linker-exec",
  "bin/termux-fix-shebang",
  // ④ 档新增的伴生脚本：功能全部依赖 Termux 本体/Termux:API 应用，
  // 在 Kxxy 里必然失败（Kxxy 的 su 路径由原生层 Privilege.kt +
  // engine/bin/su 闸门承担，termux-api 的硬件通道后续由原生层实现）。
  "bin/termux-api-start",
  "bin/termux-api-stop",
  "bin/tsu",
  "bin/dalvikvm",
  "bin/pkg",
  "etc/motd",
  "etc/motd.sh",
  "etc/motd-playstore",
  "etc/profile.d/init-termux-properties.sh",
]);

/** `dsh web` profile 的依赖根：CLI 本体 + 两个 bundle。 */
const CLOSURE_ROOTS = [
  "@deepseek-ai/dsh",
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
];

/**
 * 必须剔除的脚本：shebang 指向 `bin/perl` / `bin/python`，而这两个解释器
 * 不在 Termux 闭包里（没装 perl / python 包）。留着只会在设备上报
 * `bad interpreter: No such file or directory`。
 *
 * 六个都是 CVS / Perforce 桥接，Agent 场景不会触碰。
 */
const DEAD_INTERPRETER_SCRIPTS = new Set([
  "bin/git-cvsserver",
  "libexec/git-core/git-archimport",
  "libexec/git-core/git-cvsexportcommit",
  "libexec/git-core/git-cvsimport",
  "libexec/git-core/git-send-email",
  "libexec/git-core/git-p4",
]);

/**
 * 需要归一化 shebang / 正文路径的顶层目录。
 *
 * 只处理这几棵树，是因为它们才可能出现 `#!` 或 shell 路径引用；
 * `lib/*.so`、`bin/*`（ELF）靠 ELF 魔数二次过滤挡掉。
 */
const SCRIPT_TOP_DIRS = ["bin/", "libexec/", "lib/", "share/", "etc/", "var/"];

/**
 * 必须从产物里剔除的二进制/库（缺陷 AZ）。
 *
 * `lib/android-stub`（Termux 的 `libandroid-stub_30-1` deb，5 个文件
 * `libOpenSLES.so` / `libandroid.so` / `libbinder_ndk.so` / `libmediandk.so` /
 * `libtermux-platform-ns.so`）里，**只有 `libbinder_ndk.so` 会导致链接失败**，
 * 其余四个必须保留。真机 A/B（逐个 `mv` 走再跑 16 个工具）：
 *
 *   - 移走 `libbinder_ndk.so`  → ffmpeg/ffprobe 从 `CANNOT LINK EXECUTABLE
 *     "…/ffmpeg": cannot find "libbinder_ndk.so" from verneed[0] in DT_NEEDED
 *     list for "/system/lib64/libui.so"` 直接变成 `ffmpeg version 8.1.3`，
 *     且 curl/cmake/sqlite3/node/perl/tesseract/magick/gs/pandoc/qpdf/
 *     pdftotext/git/python3/clang/rg **输出逐字不变**。
 *   - 移走其余任意一个 → ffmpeg 依旧失败，其它工具也不变。
 *   - 但同时移走 `libmediandk.so` → 反而更糟：系统 `libunwindstack.so` 报
 *     `cannot locate symbol "Xzs_Construct"`。所以 mediandk 桩库动不得。
 *
 * 为什么必须删而不是留给设备端：`EngineConfig.buildEnv` 把 `<root>/lib`
 * 放在 `LD_LIBRARY_PATH` 首位（`curl`/`cmake` 需要 engine 里那批新库），
 * 于是 24 KB 的桩库会**遮蔽** `/system/lib64/libbinder_ndk.so`（94,488 B）。
 * 而 `/system/lib64/libui.so` 的 verneed 要求带版本定义的 `libbinder_ndk`，
 * 桩库 `soname=null` 且无 `.gnu.version_d` ⇒ linker 报「版本符号找不到」，
 * 措辞却是 「cannot find」，极易误判成文件缺失。
 *
 * **为什么删掉没有副作用**：对整棵引擎（44,324 文件 / 3,577 个 ELF64，
 * 含 `extensions/`）做 ELF 头解析，`DT_NEEDED` 里含 `libbinder_ndk.so` 的
 * **一个都没有**（脚本见 `_recon/elfneeded2.py`）。它只是 Termux 为了让
 * `libmediandk.so` / `libOpenSLES.so` 桩库能加载而塞进来的占位，而那两个
 * 桩库自己 `DT_NEEDED libtermux-platform-ns.so`，与 binder 无关。
 *
 * ---
 *
 * 缺陷 BH 追加一条 `lib/liblzma.so`。这一类不是「桩库太小」，而是
 * **soname 与裸文件名不一致**：`<root>/lib/liblzma.so` 在 zip 里是软链
 * `LINK:lib/liblzma.so.5.8.4`，内容是 **liblzma 5.8.4，soname 为
 * `liblzma.so.5`、导出 114 个 `lzma_*`、`Xzs_*` 零个**；而系统的
 * `/system/lib64/liblzma.so` 是 **164,576 B、soname 为 `liblzma.so`、
 * 导出 230 个符号、其中 5 个是 `Xzs_*`** —— 两者根本不是同一个库。
 *
 * 因为 `<root>/lib` 在 `LD_LIBRARY_PATH` 首位，系统 `/system/lib64/libui.so`
 * 经 `libnativewindow` → `libunwindstack.so` 那条链上 NEEDED 的**裸名**
 * `liblzma.so` 会命中引擎这个文件，于是 `libunwindstack` 要的
 * `Xzs_Construct` 解析不到，报
 * `CANNOT LINK EXECUTABLE "ffmpeg": cannot locate symbol "Xzs_Construct"
 * referenced by "/system/lib64/libunwindstack.so"`。
 *
 * 触发条件（真机 `_recon/probe-repro2.sh` 逐组隐藏桩库复现）：
 * `libmediandk.so` 桩库一旦失效，系统 `/system/lib64/libmediandk.so` 被加载，
 * 它 NEEDED `libnativewindow.so` → `libui.so` → `libunwindstack.so` →
 * `liblzma.so`，于是撞上这个错名文件。`libmediandk.so` 桩库本身动不得
 * （移走会直接踩到这条链），所以只能拆掉链尾那个错名的 `liblzma.so`。
 *
 * **安全性**：全引擎 3,569 个 ELF64 递归扫 `DT_NEEDED`，精确等于
 * `liblzma.so` 的有 **0 个**（消费者一律用 `liblzma.so.5`，共 50 个）。
 * 删掉裸名后 ffmpeg/ffprobe/xz/zstd/gs/gdb/pandoc/qpdf/pdftotext/
 * tesseract/exiftool/curl/git/sqlite3/rg/node/python-lzma/dpkg-deb **21 项
 * 全绿且产物字节数逐一相同**（`_recon/probe-final-ab.sh`）。
 *
 * `libheif.so` 是同一类（引擎版 soname `libheif.so.1`、系统版
 * `libheif.so`、系统版独有的 `_Z17createHeifDecoderv` 正是 `libhwui.so`
 * 要的），但它**不在 runtime.zip 里** —— 由 `gnuplot`/`imagemagick`/
 * `texlive` 三个扩展的 `.links.json` 的 `libs` 复制进 `<root>/lib/`，
 * 所以剔除点在 `plugins/kxxy-host/lib/extinstall.mjs` 的
 * `SHADOWING_BARE_LIBS`，不在这里。
 */
const DROPPED_LIBS = new Set([
  "lib/libbinder_ndk.so",
  // 缺陷 BH：soname 是 liblzma.so.5，裸名 liblzma.so 属于系统那条链。
  "lib/liblzma.so",
]);

/** 超过这个大小的一律当二进制，不做文本替换（避免误伤大 ELF）。 */
const MAX_SCRIPT_BYTES = 1 << 20;

/**
 * 目录型符号链接。
 *
 * `resolveSymlinks` 只把 `file`/`hardlink` 放进可解析集合，目标是 `dir` 的
 * 符号链接永远解析不到，会被记成「目标不是实体文件」丢弃。实测有两条这样的
 * 链接，且都真实影响运行时：
 *
 *   lib/terminfo   → share/terminfo   （40 文件，ncurses 应用查 TERMINFO 用）
 *   lib/icu/current → lib/icu/78.3    （2 个 .inc 开发文件，实际用不到）
 *
 * 还有两条经由 `lib/icu/current` 中转的二级链接（`lib/icu/Makefile.inc`、
 * `lib/icu/pkgdata.inc`），所以这里必须**迭代到不动点**：先把目录链接解析成
 * 真实目录，再让指向它的链接也能解析。
 */
function collectDirLinks(stage) {
  const dirs = new Set(stage.entries.filter((e) => e.type === "dir").map((e) => e.path));
  const pending = stage.entries.filter((e) => e.type === "symlink" && !isPruned(e.path));
  const out = [];

  // 别名 → 真实目录；先填目录型链接本身，再处理指向别名的链接。
  const aliasTo = new Map();
  for (const e of pending) {
    const target = posix.normalize(posix.join(posix.dirname(e.path), e.target));
    if (dirs.has(target)) aliasTo.set(e.path, target);
  }

  for (let round = 0; round < 8; round += 1) {
    let grew = false;
    for (const e of pending) {
      if (aliasTo.has(e.path)) continue;
      const target = posix.normalize(posix.join(posix.dirname(e.path), e.target));
      const real = aliasTo.get(target);
      if (real !== undefined) {
        aliasTo.set(e.path, real);
        grew = true;
      }
    }
    if (!grew) break;
  }

  for (const [path, target] of aliasTo) out.push({ path, target });
  return out;
}

function parseArgs(argv) {
  const opts = {
    stage: join(PROJECT, ".cache", "stage"),
    asar: "F:/dsh-desktop/resources/app.asar",
    out: join(PROJECT, "android", "app", "src", "main", "assets", "runtime.zip"),
    manifest: null,
    plugins: join(PROJECT, "plugins"),
    pythonDeps: process.env.KXXY_PYTHON_DEPS
      ? resolve(process.env.KXXY_PYTHON_DEPS)
      : join(PROJECT, "tools", "prebuilt", "python-android-cp314", "manifest.json"),
    pythonRepairAssets: join(PROJECT, "android", "app", "src", "main", "assets", "python-repair"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--stage") opts.stage = resolve(argv[++i]);
    else if (a === "--asar") opts.asar = resolve(argv[++i]);
    else if (a === "--out") opts.out = resolve(argv[++i]);
    else if (a === "--manifest") opts.manifest = resolve(argv[++i]);
    else if (a === "--plugins") opts.plugins = resolve(argv[++i]);
    else if (a === "--python-deps") opts.pythonDeps = resolve(argv[++i]);
    else if (a === "--python-repair-assets") opts.pythonRepairAssets = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log("用法：node tools/build-runtime.mjs [--stage <dir>] [--asar <app.asar>] [--out <zip>] --python-deps <manifest.json>");
      process.exit(0);
    } else throw new Error(`未知参数：${a}`);
  }
  /*
   * `--manifest` 是「运行时清单」的落点（entries/placeholderPaths 那份，给
   * 构建机与 issue 用）。而 `assets/meta/build.json` 是另一份东西 —— **原生
   * 探针的期望值来源**，由本脚本在收尾处自己写（含 `pythonRepairManifestSha256`、
   * `kxxyHostFingerprint`、`kxxyHostMarker`）。
   *
   * 两者指到同一个文件就会互相覆盖，而覆盖方向是「后写的赢」：manifest 在
   * build-meta 之后写，于是 APK 里那份 build.json 变成运行时清单的形状，
   * 缺 `pythonRepairManifestSha256`。真机症状（v0.9.70 踩到）：
   *     PythonRuntimeRepair$Refused: pythonRepairManifestSha256 必须是字符串
   * → 引擎根本不启动，界面停在「启动失败 / 配置可组装」，而 patchset 永远
   * 停在旧值（连安装都没走到）。
   */
  if (opts.manifest && resolve(opts.manifest) === join(PROJECT, "android", "app", "src", "main", "assets", "meta", "build.json")) {
    throw new Error(
      "--manifest 不能指向 android/app/src/main/assets/meta/build.json：" +
        "那份构建清单由本脚本自己写（含 pythonRepairManifestSha256 / kxxyHostFingerprint），" +
        "指向它会被运行时清单覆盖，装机后 PythonRuntimeRepair 直接拒启。换一个路径，例如 .cache/runtime-manifest.json。",
    );
  }
  return opts;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/** 前 4 字节是 ELF 魔数即视为二进制，绝不改内容。 */
function isElf(buf) {
  return buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
}

/**
 * 归一化 stage 侧文本文件：把 Termux 的绝对路径换成占位符。
 *
 * 三条规则，顺序重要：
 *   ① 剔除清单（Termux 应用专属脚本）先删 —— 它们含大量 `com.termux`
 *      Intent 字符串，替换也救不了，留着只会误导后续排查。
 *   ② ELF 一律跳过：320 个二进制的 RUNPATH 里就写着 Termux prefix，
 *      那是预期内的（Android linker 先读 `LD_LIBRARY_PATH`，
 *      `EngineConfig.buildEnv` 已把 `<root>/lib` 放首位），改它反而危险。
 *   ③ 只处理 `SCRIPT_TOP_DIRS` 下的文本文件，且按 `PATH_REWRITES` 逐条替换。
 *
 * 返回统计；被改写的条目就地升级成内存条目（带 data，丢掉 blob 引用）。
 */
function normaliseStageFiles(files, blobRoot) {
  let touched = 0;
  let dropped = 0;
  const droppedPaths = [];
  const placeholderPaths = [];

  for (let i = files.length - 1; i >= 0; i -= 1) {
    const f = files[i];

    if (DEAD_INTERPRETER_SCRIPTS.has(f.path) || TERMUX_APP_SCRIPTS.has(f.path)) {
      files.splice(i, 1);
      dropped += 1;
      droppedPaths.push(f.path);
      continue;
    }

    // 缺陷 AZ：libandroid-stub 里的 libbinder_ndk.so 会遮蔽系统真库，
    // 让 ffmpeg/ffprobe 起不来（详见 DROPPED_LIBS 注释）。
    if (DROPPED_LIBS.has(f.path)) {
      files.splice(i, 1);
      dropped += 1;
      droppedPaths.push(f.path);
      continue;
    }

    if (!SCRIPT_TOP_DIRS.some((d) => f.path.startsWith(d))) continue;
    if ((f.size ?? 0) > MAX_SCRIPT_BYTES) continue;

    const buf = readFileSync(join(blobRoot, f.blob.slice(0, 2), f.blob));
    if (isElf(buf)) continue;

    let text = buf.toString("latin1");
    if (!text.includes("com.termux")) continue;

    let changed = false;
    for (const [needle, repl] of PATH_REWRITES) {
      if (text.includes(needle)) {
        text = text.split(needle).join(repl);
        changed = true;
      }
    }

    // 只有真的发生了替换才升级为内存条目并声明进 placeholderPaths。
    // ④ 档新增的 python 包里有一批只把 com.termux 写在注释/PyPI URL 里的
    // 文件（proot_distro/constants.py、*.dist-info/METADATA）—— 它们改不动
    // 也无需改，声明出去只会让设备端「声明了却没有占位符」对不上账。
    if (!changed) continue;

    const out = Buffer.from(text, "latin1");
    files[i] = { path: f.path, type: "file", data: out, mode: f.mode, size: out.length };
    touched += 1;
    placeholderPaths.push(f.path);
  }

  return { touched, dropped, droppedPaths, placeholderPaths };
}

/**
 * 生成 Android 打包工具的包装器：`bin/zipalign` 与 `bin/bundletool`。
 *
 * ── 为什么是这两个（缺口 B）──────────────────────────────────────────────
 *
 * 用户清单的第二个缺口是「`zipalign` / `bundletool` 均 MISS」。它们都不在
 * Termux 仓库里，不是漏装：
 *
 *   · `zipalign`  —— Android SDK build-tools 的 C++ 二进制，只在 SDK 里发行；
 *   · `bundletool` —— Google 的 Java 工具，从 GitHub Releases / Google Maven
 *     发 `bundletool-all-<ver>.jar`，从不是 apt 包。
 *
 * 而设备上**已经具备运行它们的全部条件**：`bin/node`（v24）、
 * `lib/jvm/java-21-openjdk`（`java -version` → 21.0.12）、`bin/d8`、`bin/aapt2`。
 * 所以这里用自带的 node 实现 zipalign（`packaging/zipalign.mjs`，纯 JS，
 * 与 AOSP 算法一致且数据区原样搬运），bundletool 则是一个 jar + java 包装器。
 *
 * ── 为什么包装器用 `-jar` 而不解包 ───────────────────────────────────────
 *
 * `bundletool-all` 是 fat jar（32.5 MiB，含全部依赖），`java -jar` 直接可跑。
 * 解包成 class 反而会让 `bin/` 里多出几十个入口点，且升级要重算清单。
 *
 * `java` 走 `$JAVA_HOME/bin/java` 的绝对路径而不是 PATH：`EngineConfig`
 * 虽然把 `JAVA_HOME` 与 jvm 的 `bin` 都注入环境，但用户可能在自己的 shell 里
 * 用 `env -i` 跑包装器，绝对路径更稳；`JAVA_HOME` 缺失时回落 `$d/java`。
 */
function packagingWrappers() {
  const sh = (lines) =>
    Buffer.from(["#!/system/bin/sh", "# generated by dsh-kxxy build-runtime.mjs — do not edit", ...lines, ""].join("\n"), "utf8");

  return [
    {
      path: "bin/zipalign",
      data: sh([
        'd=${0%/*}',
        // 先找引擎根的合并视图；`lib/node_modules/kxxy-host/packaging/` 是
        // 插件树里的同一份（插件升级时以插件那份为准）。
        'for c in "$d/../lib/node_modules/kxxy-host/packaging/zipalign.mjs" "$d/../packaging/zipalign.mjs"; do',
        '  [ -f "$c" ] && exec "$d/node" "$c" "$@"',
        "done",
        'echo "zipalign: 找不到 packaging/zipalign.mjs" >&2',
        "exit 127",
      ]),
      mode: 0o755,
    },
    {
      path: "bin/bundletool",
      data: sh([
        'd=${0%/*}',
        'J="$d/../lib/jvm/java-21-openjdk/bin/java"',
        '[ -x "$J" ] || J="$d/java"',
        'JAR="$d/../share/java/bundletool-all.jar"',
        '[ -f "$JAR" ] || JAR="$d/../lib/node_modules/kxxy-host/packaging/bundletool-all.jar"',
        'if [ ! -f "$JAR" ]; then',
        '  echo "bundletool: 找不到 bundletool-all.jar" >&2',
        "  exit 127",
        "fi",
        'exec "$J" -jar "$JAR" "$@"',
      ]),
      mode: 0o755,
    },
  ];
}

/** 随包携带的 npm 发布包（`npm pack npm@<ver>`，含全部 bundleDependencies）。 */
const BUNDLED_NPM_TARBALL = "tools/prebuilt/npm/npm-11.21.3.tgz";
/** npm 包里必须存在的入口；少一个就说明 tarball 是别的形态（或只打了自家文件）。 */
const BUNDLED_NPM_ANCHORS = [
  "package.json",
  "bin/npm-cli.js",
  "bin/npx-cli.js",
  "lib/cli.js",
  "node_modules/semver/package.json",
];

/**
 * 解出离线 npm 本体，映射到 `lib/node_modules/npm/`。
 *
 * 为什么把 tarball 提交进仓库而不是构建期现下载：手机端 `npm install` 的
 * 第一次调用必须**零网络**（这正是要修的症状），而构建机能不能上网不该成为
 * 出包的前置条件 —— 与 `tools/prebuilt/native-ml/*.whl` 同一取舍。
 * 刷新方式见 `tools/prebuilt/npm/README.md`。
 */
function loadBundledNpm() {
  const archive = join(PROJECT, BUNDLED_NPM_TARBALL);
  if (!existsSync(archive)) throw new Error(`缺离线 npm 包：${archive}`);
  const entries = untarGz(readFileSync(archive));
  const files = new Map();
  let version = "";
  for (const entry of entries) {
    if (entry.type !== "0") {
      throw new Error(`npm 归档里出现非普通文件条目（type=${entry.type}）：${entry.path}`);
    }
    if (!entry.path.startsWith("package/")) {
      throw new Error(`npm 归档条目不以 package/ 开头：${entry.path}`);
    }
    const rel = `lib/node_modules/npm/${entry.path.slice("package/".length)}`;
    const mode = rel.startsWith("lib/node_modules/npm/bin/") ? 0o755 : 0o644;
    files.set(rel, { data: entry.data, mode });
    if (rel === "lib/node_modules/npm/package.json") {
      version = JSON.parse(entry.data.toString("utf8")).version ?? "";
    }
  }
  for (const anchor of BUNDLED_NPM_ANCHORS) {
    if (!files.has(`lib/node_modules/npm/${anchor}`)) {
      throw new Error(`离线 npm 不完整，缺 ${anchor}（tarball 未带 bundleDependencies？）`);
    }
  }
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`离线 npm 的版本号不可用：${JSON.stringify(version)}`);
  return { version, files };
}

/**
 * 生成 corepack 包装器 `bin/{pnpm,npm,npx}`。
 *
 * 为什么需要：Termux 的 nodejs-lts 只装 corepack 本体，不提供这三个 shim
 * （实测 `bin/{pnpm,npm,npx}` 全部不存在，只有 `lib/node_modules/corepack/shims/*`）。
 * 而 shims 目录里的脚本 shebang 指向 Termux 路径且依赖 `termux-exec`，
 * 与其修补不如重写三个 8 行的 wrapper。
 *
 * shebang 固定 `/system/bin/sh`：Android 必然存在，且是 app 私有路径之外的
 * 唯一稳定解释器，因此**不需要**参与 `@DSH_ROOT@` 占位符替换。
 *
 * `bundledNpm` 为真时 `bin/npm` / `bin/npx` 直接跑随包携带的 npm 本体
 * （`lib/node_modules/npm/bin/*-cli.js`），不再经过 corepack —— corepack 的
 * 首次运行必须联网下载 `packageManager` 指定的整包，手机侧既不 EOF 也不超时，
 * 用户看到的就是 `npm install` 永久卡住。`corepack npm …` 同样改道。
 */
function corepackWrappers(bundledPnpm, bundledNpm) {
  const mk = (target) =>
    Buffer.from(
      [
        "#!/system/bin/sh",
        "# generated by dsh-kxxy build-runtime.mjs — do not edit",
        'd=${0%/*}',
        `exec "$d/node" "$d/../lib/node_modules/corepack/dist/${target}" "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );

  // 随包 npm：与 pnpm 同一思路，直接跑本地 JS 入口，零网络、零版本协商。
  const local = (cli) =>
    Buffer.from(
      [
        "#!/system/bin/sh",
        "# generated by dsh-kxxy build-runtime.mjs — do not edit",
        'd=${0%/*}',
        `exec "$d/node" "$d/../lib/node_modules/npm/bin/${cli}" "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );

  /*
   * pnpm 走 Termux 闭包里那份**自带的单文件可执行**（`bin/pnpm`，54.7 MiB 的
   * node SEA，只依赖 `libdl.so`），不再让 corepack 去 registry 现取。
   *
   * 真机症状（v0.9.67，用户第 10 项）：`dsh plugin … list` 卡住不动，
   * `timeout 120` 直接 124；单独 `pnpm --version` 150 s 不返回。原因不是网络
   * 慢，而是 `bin/pnpm` 当时指向 **corepack shim**：corepack 首次运行要把
   * `packageManager` 字段指定的 `pnpm@12.21.0` 整包下载并解到
   * `~/.cache/node/corepack`，手机侧既慢又常被 CDN 挂死（既不 EOF 也不超时）。
   *
   * `dsh` 的 profile 上下文里 `packageManager` 本来是可注入的（打包版桌面端走
   * `resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`），但那只在
   * Electron 主进程里注入，CLI 侧拿不到 —— 所以只能从 PATH 层面保证 `pnpm` 与
   * `corepack pnpm` 都直接落到本地这份。
   *
   * 因此：stage 里有 `bin/pnpm` 时**不要**再生成同名包装器（会把真二进制顶掉），
   * 只把 `corepack` 的 pnpm 子命令改道过去。
   */
  const corepack = Buffer.from(
    [
      "#!/system/bin/sh",
      "# generated by dsh-kxxy build-runtime.mjs — do not edit",
      'd=${0%/*}',
      ...(bundledPnpm
        ? [
            // `corepack pnpm …` / `corepack pnpm@12.21.0 …` 一律改走本地 pnpm。
            // `pnpm@ver` 里的版本号直接丢掉：本地这份是构建期钉住的版本，
            // corepack 的版本协商（以及随之而来的下载）在这里没有任何意义。
            'case "$1" in',
            '  pnpm|pnpm@*)',
            "    shift",
            '    exec "$d/pnpm" "$@"',
            "    ;;",
            "esac",
          ]
        : []),
      ...(bundledNpm
        ? [
            // `corepack npm …` 同样走本地 npm（见 corepackWrappers 的注释）。
            'case "$1" in',
            '  npm|npm@*)',
            "    shift",
            '    exec "$d/npm" "$@"',
            "    ;;",
            "esac",
          ]
        : []),
      'exec "$d/node" "$d/../lib/node_modules/corepack/dist/corepack.js" "$@"',
      "",
    ].join("\n"),
    "utf8",
  );

  return [
    // 没有自带 pnpm 时才补一个指向 corepack 的 shim（联网可用，离线会挂）。
    ...(bundledPnpm
      ? []
      : [{ path: "bin/pnpm", data: mk("pnpm.js"), mode: 0o755 }]),
    { path: "bin/npm", data: bundledNpm ? local("npm-cli.js") : mk("npm.js"), mode: 0o755 },
    { path: "bin/npx", data: bundledNpm ? local("npx-cli.js") : mk("npx.js"), mode: 0o755 },
    // 缺陷 CT：`bin/corepack` 也必须是包装器。
    //
    // 真实场景：Termux 的 nodejs-lts 把 `dist/corepack.js`（204 B 入口）**复制**
    // 到 `bin/corepack`，而入口第一句是 `require('./lib/corepack.cjs')` —— 相对
    // `__dirname` 解析，从 `bin/` 出发就是 `<root>/bin/lib/corepack.cjs`，不存在。
    // 真机报 `Error: Cannot find module './lib/corepack.cjs'`，Require stack 里
    // 指的就是 `.../engine/bin/corepack`。
    //
    // 而 `dist/corepack.js` 自己从 `dist/` 出发，`./lib/corepack.cjs`
    // （519,646 B）正好在同级，所以只要把入口换成「用 node 跑 dist 里的那份」即可。
    { path: "bin/corepack", data: corepack, mode: 0o755 },
  ];
}

/**
 * `bin/gfortran` 前端：转发到 flang。
 *
 * Termux 主仓没有 gfortran（GCC 的 Fortran 前端没打包），而大量科学计算项目的
 * `./configure`、Makefile、CMake 工具链文件里都硬写 `gfortran`，命令名不存在就
 * 直接判「没有 Fortran 编译器」。这里给 flang 挂一个 gfortran 名字。
 *
 * 真机实测 flang 21.1.8 对 gfortran 的常用命令行完全兼容（不需要做参数改写）：
 *   `-c -o -O2 -g -fPIC -shared -I -L -l -J -cpp -std=f2018
 *    -ffree-form -ffixed-form -fopenmp` 全部接受，且 `-J dir` 真的把 `.mod`
 *    写进 `dir`（编译 + 链接 + 运行多文件模块程序得到正确结果）。
 *
 * 仍然是「前端」而不是 GNU gfortran：GNU 方言扩展（`-fdec`、部分 `-std=legacy`
 * 行为、`-fcheck=all` 的细节）到不了位，报错文案也不同。别把它宣传成 gfortran。
 */
/** tools/prebuilt/kxxy-tools/ 下的解释器脚本（构建期源文件，不进产物名）。 */
function kxxyToolScript(name) {
  const p = join(PROJECT, "tools", "prebuilt", "kxxy-tools", name);
  if (!existsSync(p)) throw new Error(`缺运行时脚本：${p}`);
  // 解释器脚本也要按 LF 落盘：CRLF 的 shebang（`#!/usr/bin/env python3\r`）
  // 直接 exec 会报「No such file or directory」，而 git 又会把这层差异藏起来。
  return Buffer.from(readScriptText(p, `prebuilt/kxxy-tools/${name}`), "utf8");
}

/**
 * `bin/perf` —— 直接调 perf_event_open 的采样器（Python 实现，零依赖）。
 *
 * 为什么不用 NDK 的 simpleperf：它在 app uid 下有两处硬限制 —— `-- cmd`
 * 直接拒（"Running child command in app uid isn't allowed"），`record` 启动
 * 时要 SetProperty debug.perf_event_max_sample_rate，应用域改不了系统属性。
 * 这里直接打开事件并读取 mmap 环形缓冲；是否允许仍取决于当前进程和设备
 * 内核策略，perf_event_paranoid=-1 不能保证调用成功。
 */
function perfWrappers() {
  const script = [
    "#!/system/bin/sh",
    "# generated by dsh-kxxy build-runtime.mjs — do not edit",
    'd=${0%/*}',
    'case "$d" in /*) ;; *) d=$PWD/$d ;; esac',
    'root=$(cd "$d/.." 2>/dev/null && pwd)',
    'py="$root/bin/python"',
    '[ -x "$py" ] || { printf "perf: 缺少原生解释器 %s\\n" "$py" >&2; exit 127; }',
    'script="$root/libexec/kxxy-tools/perf.py"',
    '[ -f "$script" ] || {',
    '  printf "perf: 缺 %s（运行时没解压完整？重装 APK）\\n" "$script" >&2',
    "  exit 127",
    "}",
    'case "${KXXY_PERF_ROOT:-0}" in',
    '  0) exec "$py" "$script" "$@" ;;',
    '  1)',
    '    if [ "${KXXY_PERF_MODE:-auto}" = fallback ]; then',
    '      printf "perf: KXXY_PERF_ROOT=1 要求真实 PMU，不能同时指定 KXXY_PERF_MODE=fallback\\n" >&2',
    '      exit 2',
    '    fi',
    '    exec "$py" "$root/libexec/kxxy-tools/kxxy-root.py" perf "$@"',
    '    ;;',
    '  *) printf "perf: KXXY_PERF_ROOT 只能是 0 或 1\\n" >&2; exit 2 ;;',
    'esac',
    "",
  ].join("\n");
  const rootScript = [
    "#!/system/bin/sh",
    "# generated by dsh-kxxy build-runtime.mjs — do not edit",
    'd=${0%/*}',
    'case "$d" in /*) ;; *) d=$PWD/$d ;; esac',
    'root=$(cd "$d/.." 2>/dev/null && pwd) || exit 127',
    'exec "$root/bin/python" "$root/libexec/kxxy-tools/kxxy-root.py" exec "$@"',
    "",
  ].join("\n");
  return [
    { path: "bin/perf", data: Buffer.from(script, "utf8"), mode: 0o755 },
    { path: "bin/kxxy-root", data: Buffer.from(rootScript, "utf8"), mode: 0o755 },
    { path: "libexec/kxxy-tools/perf.py", data: kxxyToolScript("perf.py"), mode: 0o644 },
    { path: "libexec/kxxy-tools/kxxy-rsync.py", data: kxxyToolScript("kxxy-rsync.py"), mode: 0o644 },
    { path: "libexec/kxxy-tools/kxxy-root.py", data: kxxyToolScript("kxxy-root.py"), mode: 0o644 },
  ];
}

/**
 * 原生 Python 的「这条解释器里没有，但这样能拿到」钩子。
 *
 * scikit-learn / opencv 以前是 glibc-only（官方无 Android 轮子），v0.9.79 起
 * 两个包都由真机编译的 bionic 轮子随运行时内置。仍然有一批包只发 manylinux
 * 轮子（tensorflow / xgboost / onnxruntime …），在 bionic 原生解释器里直接
 * `import` 只会回 ModuleNotFoundError，用户不知道默认的 `python3` 是 glibc
 * 容器、也不知道 `kxxy-glibc` 怎么进。
 * 用 .pth 在启动时挂个尾部 finder：能正常导入的环境照样正常导入，真的没有的
 * 那种才把错误信息换成可执行的下一步。
 */
function pythonHintEntries() {
  const py = kxxyToolScript("_kxxy_hint.py");
  return [
    { path: "lib/python3.14/site-packages/_kxxy_hint.py", data: py, mode: 0o644 },
    {
      path: "lib/python3.14/site-packages/kxxy_hint.pth",
      data: Buffer.from("import _kxxy_hint\n", "utf8"),
      mode: 0o644,
    },
  ];
}

function fortranWrappers() {
  const script = [
    "#!/system/bin/sh",
    "# generated by dsh-kxxy build-runtime.mjs — do not edit",
    'd=${0%/*}',
    'real="$d/flang"',
    '[ -x "$real" ] || {',
    '  printf "gfortran: 找不到 %s\\n" "$real" >&2',
    '  printf "          Fortran 编译器在 fortran 扩展池里，先在控制台「扩展」安装该池。\\n" >&2',
    "  exit 127",
    "}",
    'exec "$real" "$@"',
    "",
  ].join("\n");
  return [{ path: "bin/gfortran", data: Buffer.from(script, "utf8"), mode: 0o755 }];
}

/**
 * 从官方主题模块抽取全部 token 定义块，生成 `plugins/kxxy-host/web/theme.css`。
 *
 * 为什么这么做（二轮问题 ② 的 B 方案）：宿主管理页过去用一套手造色板，和官方
 * 对话界面（dsh-client-ui-theme 的 neutral-bluish + deepseek 色板）肉眼可见不一致。
 * 让 host.css 直接消费官方的 `--dsw-alias-*` / `--dsw-static-*` 变量、把定义块
 * 原样搬过来 —— 官方以后调色，重跑构建自动跟齐，管理页永远和对话页同源。
 *
 * 抽取细节与「0.9.57 浅色全黑」事故的来龙去脉见 `tools/lib/theme-css.mjs`：
 * 那里用真正的字符串字面量扫描取代了会误吞 JS 胶水的配对引号正则，并自带
 * `assertThemeCss()` 自检 —— 抽坏了宁可构建失败，也不许再发一份坏 CSS。
 */
function extractOfficialTheme(asarFiles) {
  let theme;
  try {
    theme = themeCssFromAsarFiles(asarFiles);
  } catch (error) {
    console.error(`      ✗ theme.css 生成失败：${error.message}`);
    throw error;
  }
  if (!theme) {
    console.log("      ⚠️ dsh-client-theme 不在闭包内或没有 token，跳过 theme.css 生成");
    return;
  }
  writeFileSync(join(PROJECT, "plugins", "kxxy-host", "web", "theme.css"), theme.css, "utf8");
  // 用 Buffer.byteLength 而不是 String.length：头部注释是中文，字符数比字节数少，
  // 按字符数报「字节」会与磁盘上的文件大小对不上（差 94 B，查过一次）。
  console.log(`      ✓ theme.css：抽取 ${theme.blocks} 个 token 块（${Buffer.byteLength(theme.css, "utf8")} 字节）`);
}

// -------------------------------------------------------------- office 引擎
/*
 * 为什么这两个 npm 包要在**构建期**下载、而不是随仓库提交：
 *
 *   1. wasm 引擎包 145 MiB（`soffice.wasm` 单文件就 122 MiB），提交进 git 会让
 *      仓库体积翻几十倍；它本来就是 registry 上的公开产物，且有 sha256 可校验。
 *   2. 字体包 57 MiB（只用其中两个字重，约 21 MiB）同理。
 *
 * 为什么不能用设备 `/system/fonts` 里的字体：
 *   那台安卓 13 上唯一含完整 CJK 的是 `NotoSansCJK-Regular.ttc`（19.5 MiB），
 *   而 LibreOffice wasm 后端把 **`.ttc` 集合**里的 face 导出成**无字形的 Type1
 *   空壳**（descriptor 用 `/FontFile`、没有 `/CharStrings`），pdf.js 据此建不出
 *   `toFontChar`，于是把 code 当 ASCII 画 —— 真机症状就是「Office」渲染成
 *   「O f ce」。单文件 TTF 才被正确嵌入为 `/FontFile2`。所以必须自带单文件字体。
 *
 * 缓存目录 `.cache/office/` 已被 .gitignore 覆盖，重复构建直接复用。
 */
const OFFICE_CACHE = join(PROJECT, ".cache", "office");

// 仅当所选上游闭包**整包**不带 wasm 时，才按 kit 的精确版本注入官方 tarball。
// 版本、源码常量和完整 manifest 合同由 office-assets.mjs 核验，损坏的现有包不得补旧文件。
//
// 为什么 0.2.3 也在表里：上游桌面版把 wasm 放在 optionalDependencies，桌面
// 发行物按平台裁剪后整包缺席；kit 一升到 0.2.3，沿用「只补 0.1.5」的老规则
// 就会让 Android 构建直接卡死。注入的 0.2.3 与官方 ASAR 内容逐字节一致
// （prebuilds.json 与全资源长度指纹两条都在 office-assets.mjs 里钉死）。
const LEGACY_WASM_PKG = {
  url: "https://registry.npmmirror.com/@deepseek-ai/libreoffice-kit-wasm/-/libreoffice-kit-wasm-0.1.5.tgz",
  // 缺陷 DH：构建机到 registry.npmmirror.com 的 TLS 直接断连，npmjs 可达且字节相同
  // （sha256 断言保证）。保留主地址，只是加一条备用。
  fallbacks: [
    "https://registry.npmjs.org/@deepseek-ai/libreoffice-kit-wasm/-/libreoffice-kit-wasm-0.1.5.tgz",
  ],
  file: "libreoffice-kit-wasm-0.1.5.tgz",
  sha256: "4d5dda19a257d75fd09776d37a4f37708d7c2e163defede64b3377cb411ed406",
  version: "0.1.5",
};

const WASM_0_2_3_PKG = {
  url: "https://registry.npmmirror.com/@deepseek-ai/libreoffice-kit-wasm/-/libreoffice-kit-wasm-0.2.3.tgz",
  fallbacks: [
    "https://registry.npmjs.org/@deepseek-ai/libreoffice-kit-wasm/-/libreoffice-kit-wasm-0.2.3.tgz",
  ],
  file: "libreoffice-kit-wasm-0.2.3.tgz",
  sha256: "fc5ff6fe5ac9d19af91a8b5d090a766ed679717cb936cc1bd7f29ec4ab44e262",
  version: "0.2.3",
};

/** kit 版本 → 官方 wasm tarball 来源。表里没有的版本一律硬失败。 */
const PINNED_WASM_PKGS = new Map([
  [LEGACY_WASM_PKG.version, LEGACY_WASM_PKG],
  [WASM_0_2_3_PKG.version, WASM_0_2_3_PKG],
]);

const FONT_PKG = {
  url: "https://registry.npmmirror.com/@expo-google-fonts/noto-sans-sc/-/noto-sans-sc-0.4.4.tgz",
  // 缺陷 DH：同上。
  fallbacks: [
    "https://registry.npmjs.org/@expo-google-fonts/noto-sans-sc/-/noto-sans-sc-0.4.4.tgz",
  ],
  file: "noto-sans-sc-0.4.4.tgz",
  sha256: "e18cd1a1fbb95d7c25fc133406dfd1b2b25d718835b51ec23d556dc4b11578a8",
  zipBase: "lib/node_modules/kxxy-host/fonts/",
  pick: [
    ["package/400Regular/NotoSansSC_400Regular.ttf", "NotoSansSC-Regular.ttf"],
    ["package/700Bold/NotoSansSC_700Bold.ttf", "NotoSansSC-Bold.ttf"],
  ],
};

/**
 * office 资产的版本标记（锚点 10 的判据），与
 * `RuntimeInstaller.OFFICE_LAYER_MARKER` 逐字一致。
 *
 * 为什么必须有：字体与 wasm 引擎是「新增资产」，老设备升级 APK 时
 * runtime 版本戳不变、九锚点全通过，`isComplete()` 会判真而跳过重装，
 * 新资产永远不落地。改字体字重、换字体包版本、或 wasm 引擎包版本时，
 * **这个编号必须一起递增**，否则设备上跑的仍是旧字体/旧引擎。
 */
const OFFICE_FONTS_MARKER = OFFICE_LAYER_MARKER;
const OFFICE_FONTS_MARKER_FILE = "office-assets.version";

/**
 * 构建期补丁集版本标记（锚点 11 的判据），与
 * `RuntimeInstaller.PATCHSET_MARKER` 逐字一致。
 *
 * 为什么需要它：前面十个锚点探的全是**自有资产**（compat.js / modern.js /
 * node-pty / kxxy-host / mobile.* / office 字体），而绝大多数补丁改的是
 * **上游文件** —— documentpreview 的 `client.js` 与 `client.pdf.js`、
 * `libreoffice-kit/lib/index.js`、`dsh-office-to-pdf/lib/index.js` 等等。
 * 这些文件没有任何版本标记可探，老设备升级 APK 后前十个锚点全部通过，
 * `isComplete()` 判真并跳过重装，新补丁永远到不了设备 —— 真机踩过：
 * 补了 zip / epub provider 重建 APK 装机后，`grep -c kxxyArchiveApply`
 * 仍是 0，logcat 里只有一句 `runtime already installed and complete`。
 *
 * 与其它标记的约定相同：**改动 patches.mjs 里任何补丁、或增删补丁时，
 * 这个编号必须一起递增**。它不追求精确到「哪个补丁变了」，只保证
 * 「补丁集变了 ⇒ 设备必然重装一次」。代价是一次几百 MB 的重装，
 * 而漏判的代价是设备上静默复现已经修过的缺陷。
 *
 * 6 → 7：缺陷 DX（图片发送必失败）。`sharp` 替身本身没改 API 面，但它依赖的
 * 后端从「扩展池可选」变成「runtime 预装」，而**老设备上 runtime 里根本没有
 * `bin/magick`**。不递增编号的话前十五锚点全过、`isComplete()` 判真、
 * 跳过重装 ⇒ 设备继续缺 magick ⇒ 用户继续看到「仅支持 PNG、JPG、WebP、GIF」。
 * 注意：这条标记只能保证「重装一次」，真正把 magick 装上的是 runtime.zip 里
 * 新增的 `bin/magick` 本体，所以锚点 11 还额外探了那个实体（见 RuntimeInstaller）。
 *
 * 8 → 9：上游桌面版 0.2.1-rc.3 → rc.5 同步（2026-11-02）。
 * 补丁集一行没改，但 **dsh 的 JS 树整棵换了**。标记只认「补丁集编号」，
 * 不认上游版本，所以不动编号的话设备会判定 runtime 完整、跳过重解压，
 * 用户看到的现象就是「APK 升级了，界面和功能却一点没变」—— 与缺陷 EA 里
 * 「手工改 zip 忘了对齐标记」是同一个坑，只不过这次触发它的是上游同步。
 * 判据：**凡是换了 app.asar（上游发版）或改了 patches.mjs，都要 +1**。
 *
 * 9 → 10：客户端插件兼容（2026-11-02）。新增两条补丁 —— 老世代运行时总包的
 * 别名（`@deepseek-ai/dsh-client-runtime/client` → store 种子）、以及前端 boot
 * 对第三方插件失败的降级。**这两条改的是运行时里已有的文件内容**，而设备上
 * 的 `isComplete()` 只看锚点与标记文件：不递增编号的话，装完新 APK 仍然跑
 * `@9` 的那份 client-modules 与前端 chunk，用户会看到「更新了但插件还是白屏」。
 *
 * 10 → 11：息屏保活（2026-11-04）。**改的不是补丁，是自有插件的前端资源** ——
 * `kxxy-host/web` 新增了设置页的「息屏继续运行」开关与状态行。同一个坑：
 * 用户装完新 APK，设置页却找不到那一行，因为设备上还跑着 `@10` 解出来的旧
 * host 资源。判据放宽成一句话：**zip 里任何会影响运行时行为的文件变了，都要 +1**。
 *
 * 11 → 12：手机控电脑（2026-11-06）。`kxxy-host/web` 新增「远程控制」视图与
 * 概览入口卡 ---- 同样是自有插件前端资源的实质改动，同一个坑。
 *
 * 12 → 13：顶部空白修复 + 连接引导（2026-11-06）。`kxxy-host/web` 的远程页新增
 * 「第一次连接」三步引导与复制按钮。**注意这次的 bug 不在 web 层** —— 顶部那条
 * 50dp 空白是 `RemoteBar` 的 topMargin 造成的（原生侧，随 APK 生效，与补丁集无关）；
 * 编号只是为了把新的 host 资源发下去。
 *
 * 13 → 14：扫码与自动连接（2026-11-06）。`kxxy-host/web` 的远程页新增扫码入口、
 * 「正在连接…」条、信任提示与设备条上的「自动连」开关。原生侧（QrScanActivity /
 * RemoteStore 的信任字段）随 APK 生效；网页那部分是 host 资源，不递增编号设备上
 * 就还跑 `@13` 解出来的旧页面 —— 用户会看到「新 APK 装好了，远程页却没有扫码按钮」，
 * 而且因为旧页面里没有 `scan` 动作，连点的地方都找不到。
 *
 * 14 → 15：上手引导改版（2026-11-06）。引导卡的主路径从「跑一条命令」改成
 * 「在桌面端装远程接入插件」，并给出插件仓库链接与安装命令；命令行连接器降为
 * 折叠兜底。改动全在 `kxxy-host/web`（index.html / host.js / host.css），
 * 不升编号的话设备上仍是 @14 的旧页面 —— 而这次的问题恰好是「页面在教用户用
 * 一条连不上的路径」，比缺个按钮更糟：用户会照着做完，然后卡在那句英文 401 上。
 *
 * 15 → 16：已配对列表修复 + 概览折叠（2026-11-07）。两处都在 `plugins/kxxy-host`：
 * `lib/index.js` 把设备簿提到 `/kxxy/api/state` 顶层（原先只埋在 `engine.remote`
 * 里，前端读不到 ⇒「手机连上了，已配对的电脑一直空」）；`web/` 把两张长检查卡
 * 改成折叠。插件树指纹（锚点 8）本来也能判出这次变化，这里照约定一起递增：
 * 两个判据指向同一次重装，谁先命中都不影响结果。
 *
 * 17 → 18：写操作 nonce（2026-11-07）。`web/host.js` 包装了 `window.fetch` 统一
 * 给写请求加 `x-kxxy-nonce`，`lib/index.js` 校验它。**前端与后端必须同版本**：
 * 新页面配旧插件 = 多带一个被忽略的头（无害），旧页面配新插件 = 所有写操作 403。
 * 正因为这种组合会"静默变砖"，补丁集必须涨 —— 它是唯一能保证两边一起换的锚点。
 *
 * 25 → 26：控制台五页全站改版（2026-11-16）。改动**只**落在 `kxxy-host/web/`
 * （`host.css` 追加 1065 行 `.dsl-*` 组件层、`index.html` 重排五页、`host.js` 四处配合）。
 * 这是本轮最贵的一课：`host.css` 不在 Python 增量修复的受管名单里
 * （`PythonRuntimeRepair.HOST_WEB_FILES` 只有 `index.html` 与 `host.js`），
 * 不升编号时设备会把这两个文件换成新的、**样式却留在上一版** —— 真机表现是
 * 「结构全对、视觉全丢」，底栏中央那个 `.dsl-fab` 因为没有 54px 的圆框约束，
 * 被 WebView 按 SVG 默认的 300×150 撑成一只盖住半屏的紫色大气泡（0.9.59 #959002 实测）。
 * 判据同 10 → 11：**自有插件的任意前端资源有实质改动，都要 +1**。
 *
 * 26 → 27：Termux 闭包本身换了一版（v0.9.68）。这一轮**不是**前端改动，
 * 而是 `tools/lib/seeds.mjs` 加了 `python-scipy` / `typst` / `ltrace`，并让
 * 一度陈旧的 stage 重新解包 —— 于是 `runtime.zip` 里多了 pandas / lxml /
 * Pillow / matplotlib / scipy 这些**新增的顶层文件**。
 *
 * 为什么必须借这个编号：`isComplete()` 的十六个锚点全部只判「既有文件还在不在」，
 * 新增文件一律看不出来。0.9.67 的设备升级到 0.9.68 时锚点全过、`isComplete()`
 * 判真 ⇒ 直接跳过解压 ⇒ site-packages 里依旧没有 pandas（用户报的
 * 「pandas 17:40 还正常，升级后又没了」正是这么发生的）。
 *
 * 也就是说：**任何「只加文件、不改既有文件」的运行时变更，都只能靠这个编号
 * 让老设备重解一次**。判据因此放宽为「runtime.zip 的内容集合有实质变化就 +1」。
 *
 * 27 → 28（v0.9.69）：两件事叠在一起。
 *  1. 新增 `site-packages/` 里的纯 Python 依赖（dateutil / packaging / cycler /
 *     pyparsing / fontTools / pytz / tzdata / sympy / mpmath / six）——
 *     pandas 与 matplotlib 就是缺这几个才 import 失败。纯新增文件，锚点看不见。
 *  2. `bin/ln` 的**内容**改了（`coreutils ln` → `coreutils --coreutils-prog=ln`，
 *     外加复制降级）。锚点只判「文件在不在」，内容换了同样看不见。
 *
 * 38 → 39：本地插件安装的可用性修复（v0.9.87）。四处都在 `plugins/kxxy-host`：
 * `host.css` 把安装弹层遮罩从 z-index 200 降到 190（原先与 `.toast-container`
 * 同层且 DOM 在后 ⇒ 失败提示被遮罩压住，用户看到的是「选了包没反应」）、
 * `index.html` 放宽 `accept` 并加行内错误区、`host.js` 改用文件头魔数判定格式
 * 并延后清空 `input.value`、`lib/localinstall.mjs` 放宽包根布局与入口判定。
 * **`host.css` 与 `lib/localinstall.mjs` 都不在 Python 增量修复的受管名单里**
 * （`PythonRuntimeRepair.HOST_WEB_FILES` 只有 index.html 与 host.js），
 * 不涨编号就是「新页面 + 旧样式 + 旧后端」—— 弹层依旧看不见任何报错。
 */
const PATCHSET_MARKER = "kxxy-patchset@42";
const PATCHSET_MARKER_FILE = "lib/node_modules/kxxy-host/patchset.version";

/**
 * 移动端 UI 插件（第三方 dsh-web-mobile）的构建期来源。
 *
 * 为什么内置而不让用户自己装：插件市场那条路要求 profile 目录能跑 pnpm 联网
 * 安装，而设备上的引擎是离线装配的（`lib/node_modules` 全部来自 runtime.zip），
 * profile 的 `package.json` 里 `dependencies` 是空对象。内置 = 构建期把它塞进
 * `lib/node_modules/`，与 kxxy-host 同一条路。
 *
 * 版本锁 3.3.5（2026-11-15 升级，原 3.1.0）：
 *
 * 3.1.0 的抽屉锚点是 `[data-mobile-nav="frame"] > :first-child`。宿主 0.2.2-rc.2
 * 在抽屉模式下把**空的 drawerMask 排在 sidebarCol 前面**，于是 3.1.0 的抽屉皮肤
 * （position/width 280/z-index 1300/近白底色）全落在遮罩上，真侧栏被整块盖住 ⇒
 * 真机竖屏「侧栏打开是纯白一片」。3.3.5 的代码注释里已写明这次宿主变更，改用
 * `[class*="_sidebarCol"]` 定位、并 `[class*="_drawerMask"]{display:none}`。
 *
 * 升级插件仍必须重跑真机验收：它的 `dsh.client.inject` 名单里有 8 个官方客户端包，
 * 任何一个改名都会让整条 entry 激活失败 ⇒ 整页白屏。3.3.5 的 inject 名单与 3.1.0 逐项相同。
 */
const MOBILE_PLUGIN_PKG = {
  url: "https://registry.npmmirror.com/dsh-web-mobile/-/dsh-web-mobile-3.3.5.tgz",
  // 缺陷 DH：同上。
  fallbacks: ["https://registry.npmjs.org/dsh-web-mobile/-/dsh-web-mobile-3.3.5.tgz"],
  file: "dsh-web-mobile-3.3.5.tgz",
  sha256: "877c9ea37c993d88289c14e80b5b4ba75f8a0e7f9b205b92926fe30e3bbc7438",
  zipBase: "lib/node_modules/dsh-web-mobile/",
};

/**
 * 移动端插件的版本标记（锚点 10 的判据），与
 * `RuntimeInstaller.MOBILE_PLUGIN_MARKER` 逐字一致。
 *
 * 为什么不直接探 package.json 里的 `"version": "3.3.5"`：那样标记就与包版本
 * 绑死了，而我们需要的是「构建脚本认为的插件资产变了」这个信号 —— 换包版本、
 * 改裁剪清单、甚至只换 tarball 来源都该让设备重装一次。
 *
 * @2（2026-11-15）：插件 3.1.0 → 3.3.5。设备上的 @1 必须重装一次才能拿到修好的
 * 抽屉锚点，否则白屏照旧。
 */
const MOBILE_PLUGIN_MARKER = "kxxy-mobile-plugin@2";
const MOBILE_PLUGIN_MARKER_FILE = "plugin.version";

/**
 * Tesseract 简体中文语言包（锚点 12 的判据），与
 * `RuntimeInstaller.TESSDATA_MARKER` 逐字一致。
 *
 * 为什么必须外部获取：对 Termux 的 3011 个包名全量 grep `tessdata` /
 * `traineddata` **零命中**，也没有任何 `tesseract-lang*` 包 —— `tesseract`
 * 包只带 `eng.traineddata`。中文识别能力在 Termux 生态里根本不存在。
 *
 * 为什么取 `tessdata_fast` 而不是标准版或 best 版：
 *   - 标准版 `chi_sim.traineddata` 40 MiB+，best 版更大；
 *   - fast 版 2,469,156 B（2.35 MiB），识别质量对「截图取字 / 扫描件 OCR」
 *     这类场景完全够用，而体积差 17 倍。
 *
 * 为什么从 `raw.githubusercontent` 取：`github.com/.../blob/...` 返回的是
 * HTML 页面（带 `<html>` 头），下载后文件"存在"但 tesseract 会报格式错 ——
 * raw 域名才给原始字节。sha256 是第二道防线：审稿期换 CDN、仓库改 tag
 * 都能立刻发现。
 */
const TESSDATA_URL =
  "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/chi_sim.traineddata";
const TESSDATA_FILE = "chi_sim.traineddata";
const TESSDATA_SHA256 = "a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730";
const TESSDATA_ZIP_BASE = "share/tessdata/";
const TESSDATA_MARKER = "kxxy-tessdata@1";
const TESSDATA_MARKER_FILE = "lib/node_modules/kxxy-host/tessdata.version";

/**
 * TeX Live 宏包树的构建期来源与标记（锚点 13 的判据），与
 * `RuntimeInstaller.TEXLIVE_MARKER` 逐字一致。
 *
 * 为什么宏包树要构建期搬、而不是指望设备上的 texlive-bin：
 * Termux 的 `texlive-bin` deb **只发引擎**（pdftex / xetex / luatex +
 * kpathsea 库），`tex/latex`、`tex/plain`、`tlpkg` 全为 0 条 —— 真机上
 * `pdftex t.tex` 直接报 `I can't find the format file 'pdftex.fmt'!`，
 * 连 plain TeX 都跑不了。宏包树由 `tools/fetch-texlive.py` 从 CTAN 取
 * `scheme-basic` 闭包（118 包 / 5,894 文件 / 83.84 MiB）落到
 * `.cache/texlive-macros/share/texlive/<年份>/`，本阶段只负责搬进 zip。
 *
 * 为什么标记要独立：与 office 资产、tessdata 完全同型 —— **新增资产**，
 * 而 [RUNTIME_VERSION] 从未变过。老设备升级 APK 时前十二个锚点全通过，
 * `isComplete()` 判真并跳过重装，宏包树永远不落地。
 */
const TEXLIVE_MACROS_SRC = join(PROJECT, ".cache", "texlive-macros", "share", "texlive");
const TEXLIVE_YEAR = "2026.0";
const TEXLIVE_MARKER = "kxxy-texlive@3";
const TEXLIVE_MARKER_FILE = "lib/node_modules/kxxy-host/texlive.version";

/**
 * 带 `resources.arsc` 的 android.jar（缺陷 CQ）。
 *
 * Termux 的 `ecj` 自带一份 `share/java/android.jar` —— 它是 4555 条目的
 * **精简 stub**，只有 `AndroidManifest.xml`，没有 `resources.arsc`。
 * 真机症状：`aapt2 link` 处理任何引用系统资源（`@string/app_name`、
 * `@android:style/Theme`、`@android:drawable/…`）的清单都会报
 *
 *   error: attribute android:label not found.
 *   error: No package ID 01 found for resource ID 0x0101053d
 *   error: failed processing manifest.
 *
 * `0x01` 是 framework 的包 ID，来自 `resources.arsc` 里的 package chunk；
 * 没有它，aapt2 无从解析任何 `@android:*`。
 *
 * 为什么构建期从本机 SDK 抄、而不是设备端从 `/system/framework/framework-res.apk`
 * 提取：后者虽可用 `run-as` 读（已实测），但会把「必须有一份 SDK platform」
 * 变成「必须有一台特权可读系统包的设备」，且不同 ROM 的 arsc 版本与 aapt2
 * 期望值可能错位。构建机上有 `platforms/android-36/android.jar` 就够。
 *
 * 为什么**必须裁掉 res/**：完整 android.jar 27.8 MB（store 写入后），
 * 而 aapt2 只在「解析清单里的 `@android:*` 引用」与「编译 java 源」时读它，
 * 从不读 `res/` 下的位图/布局文件（8425 项 / 14.9 MB）。裁掉后 10.5 MB。
 */
const ANDROID_JAR_VERSION = "android-36";
const ANDROID_JAR_MARKER = "kxxy-androidjar@1";
const ANDROID_JAR_MARKER_FILE = "lib/node_modules/kxxy-host/androidjar.version";
/** 保留的顶层前缀：arsc 必须留，清单与 class 供 d8 / ecj 用。 */
const ANDROID_JAR_KEEP_PREFIXES = ["AndroidManifest.xml", "resources.arsc"];

/**
 * 打包工具包装器的版本标记（锚点 15），与
 * `RuntimeInstaller.PACKAGING_MARKER` 逐字一致。
 *
 * 为什么需要：`bin/corepack` 的修复是**原地换掉一个文件**，不是新增资产 ——
 * 它既不改变 `RUNTIME_VERSION`（始终 `v0.1.0-arm64`），也不改变任何已有标记，
 * 前十四锚点全通过 ⇒ `isComplete()` 判真 ⇒ 老设备永远不会重装，corepack
 * 继续报 `Cannot find module './lib/corepack.cjs'`。这与锚点 11–14 是同一类
 * 陷阱，只是这次换的是**已有文件的形态**（副本 → 包装器）而不是新加文件。
 *
 * 递增时机：改动 `corepackWrappers()` / `packagingWrappers()` 里任何一条、
 * 换 bundletool 版本、或改 `packaging/zipalign.mjs` 时。
 */
const PACKAGING_MARKER = "kxxy-packaging@1";
const PACKAGING_MARKER_FILE = "lib/node_modules/kxxy-host/packaging.version";


/**
 * 定位本机 Android SDK 的 `platforms/android-XX/android.jar`。
 *
 * 三级探测（与 `tools/fetch-texlive.py` 取镜像同一思路：先看显式配置，
 * 再看项目约定，最后看环境变量）：
 *   1. `ANDROID_JAR` 环境变量（构建机可显式覆盖）；
 *   2. `android/local.properties` 的 `sdk.dir`（AGP 也用这一份，必然存在）；
 *   3. `ANDROID_HOME` / `ANDROID_SDK_ROOT`。
 *
 * 找不到就返回 null，由调用方决定「跳过还是硬失败」。
 */
function locateAndroidJar() {
  const explicit = process.env.ANDROID_JAR;
  if (explicit && existsSync(explicit)) return explicit;

  const candidates = [];
  const localProps = join(PROJECT, "android", "local.properties");
  if (existsSync(localProps)) {
    // AGP 会把 `:` 与 `\\` 都转义，`sdk.dir=C\:\\Users\\...` 是常见形态。
    for (const line of readFileSync(localProps, "utf8").split(/\r?\n/)) {
      const m = /^\s*sdk\.dir\s*=\s*(.+?)\s*$/.exec(line);
      if (m === null) continue;
      candidates.push(m[1].replace(/\\\\/g, "\\").replace(/\\:/g, ":"));
    }
  }
  for (const key of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const v = process.env[key];
    if (v) candidates.push(v);
  }

  for (const sdk of candidates) {
    const jar = join(sdk, "platforms", ANDROID_JAR_VERSION, "android.jar");
    if (existsSync(jar)) return jar;
  }
  return null;
}

/**
 * 把 SDK 的 android.jar 裁成「arsc + 清单 + class」，塞进 `share/java/android.jar`。
 *
 * **关键是保留原始压缩方式**。首版实现把所有条目以 store 写入，`aapt2 link`
 * 立刻报：
 *
 *   LoadedArsc.cpp:914 chunk size is bigger than given data
 *   ApkAssets.cpp:148 Failed to load resources table in APK
 *   error: failed to load include path
 *
 * 原因：`resources.arsc` 是一棵 chunk 树，每个 chunk 头里记着**自身长度**；
 * aapt2 读它时会用 zip 条目的 `compressed_size` 做「外层是否被截断」的
 * 健全性检查。把原本 deflate 的 arsc 改存 store，`compressed_size` 从
 * 16.3 MB 变成 18.2 MB 之类的数值，与 arsc 内部记的长度对不上，于是判定损坏。
 *
 * 所以这里逐条按原 `method` 解出、再按「deflate 后是否真的更小」重新压。
 */
/**
 * 生成裁剪版 android.jar 并缓存到磁盘，返回 `{ path, kept, dropped, sourceBytes, size }`。
 *
 * 必须在 `main()` 最开头调用（见那里关于提交内存的注释）。结果按「源 jar 的
 * 绝对路径 + 大小 + mtime」做键缓存，同一份 SDK 反复构建只算一次。
 */
async function prepareAndroidJar() {
  console.log("[0/8] 生成带 resources.arsc 的 android.jar（缺陷 CQ）");

  const src = locateAndroidJar();
  if (src === null) {
    throw new Error(
      `找不到 ${ANDROID_JAR_VERSION}/android.jar。\n` +
        `设 ANDROID_JAR=<path>，或确认 android/local.properties 的 sdk.dir 指向有效 SDK。\n` +
        `没有它，设备上的 aapt2 link 无法解析任何 @android:* 资源（缺陷 CQ）。`,
    );
  }
  const srcStat = statSync(src);
  const cacheDir = join(OFFICE_CACHE, "androidjar");
  mkdirSync(cacheDir, { recursive: true });
  const key = `${srcStat.size}-${Math.round(srcStat.mtimeMs)}`;
  const cachePath = join(cacheDir, `android-36-${key}.jar`);
  const metaPath = `${cachePath}.json`;

  if (existsSync(cachePath) && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    console.log(
      `      ✓ 复用缓存 ${cachePath}（${human(statSync(cachePath).size)}，${meta.kept} 条目）`,
    );
    return { ...meta, path: cachePath, size: statSync(cachePath).size };
  }

  console.log(`      源：${src}（${human(srcStat.size)}）`);

  const entries = readZipEntries(src);
  const haveArsc = entries.some((e) => e.name === "resources.arsc");
  if (!haveArsc) {
    throw new Error(`${src} 里没有 resources.arsc，它同样是精简 stub，不能用来替换`);
  }

  /*
   * 裁剪 + 重打包。为什么要重打包而不是直接拷完整 jar：完整版 27.8 MB 里有
   * 14.9 MB 是 `res/` 下的位图与布局，aapt2 解析 `@android:*` 时只读
   * `resources.arsc`，从不读 `res/`。
   *
   * ── 为什么边写边落盘，而不是攒在内存里（构建事故）────────────────────────
   *
   * 首版是 `const chunks = []; new ZipWriter(b => chunks.push(b))` 然后
   * `Buffer.concat(chunks)`，在 [6.9] 阶段执行。这台构建机的 **提交内存**
   * 上限 16.2 GB、常态只剩 0.9 GB，而那时 `part` / `deduped` / `asarFiles`
   * / TeX 宏包树已经全部钉在堆上；再临时解 26 MiB 源 jar + 6229 个 class
   * 重压，V8 直接：
   *
   *     FATAL ERROR: Committing semi space failed.
   *     Allocation failed - JavaScript heap out of memory
   *
   * 注意报的是 **semi space**（新生代）分配失败，与 `--max-old-space-size`
   * 无关 —— 512 / 1536 / 2048 / 8192 MiB 四档实测全是同一句。真正的解法是
   * 降低「同时活着的字节数」，而不是调 GC 参数。
   *
   * 两处改动配合：① 本函数提前到 `main()` 开头（那时堆上只有 stage 索引）；
   * ② 逐条写进临时文件、写完只读回一次。峰值 = 一条 class + 最终 10 MiB。
   */
  // 临时文件必须与最终缓存**同盘**：`rename` 跨卷会抛 EXDEV（构建机 tmp 在
  // C:、仓库在 F:，实测 `EXDEV: cross-device link not permitted`），所以直接
  // 落在缓存目录里，失败时由 finally 清掉。
  const tmpJar = join(cacheDir, `.androidjar-${process.pid}.tmp`);
  let kept = 0;
  let dropped = 0;
  let sourceBytes = 0;

  try {
    const fd = openSync(tmpJar, "w");
    try {
      const inner = new ZipWriter((buf) => writeSync(fd, buf));
      for (const e of entries) {
        if (e.name.endsWith("/")) {
          dropped += 1;
          continue;
        }
        const keep =
          ANDROID_JAR_KEEP_PREFIXES.includes(e.name) || e.name.endsWith(".class");
        if (!keep) {
          dropped += 1;
          continue;
        }

        // 按原 method 解出真实内容。
        const data = e.method === 8 ? inflateRawSync(e.raw) : Buffer.from(e.raw);
        if (data.length !== e.size) {
          throw new Error(`${src} 的 ${e.name} 解压长度不符：header ${e.size}，实得 ${data.length}`);
        }

        // 逐条按「deflate 是否真的更小」重新压。注意不能一律 store：
        // `resources.arsc` 被 store 后 aapt2 会报
        //   LoadedArsc.cpp:914 chunk size is bigger than given data
        // 因为它拿 zip 条目的 compressed_size 做截断检查，而 arsc 内部自记长度。
        await inner.add(e.name, data, { mode: 0o644, level: 9 });
        kept += 1;
        sourceBytes += data.length;
      }

      if (kept === 0) throw new Error(`${src} 裁完之后是空的`);
      inner.finish();
    } finally {
      closeSync(fd);
    }
    renameSync(tmpJar, cachePath);
  } finally {
    rmSync(tmpJar, { force: true });
  }

  const size = statSync(cachePath).size;
  const meta = { kept, dropped, sourceBytes, key };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  console.log(
    `      ✓ 裁出 ${cachePath}（${kept} 条目，未压缩 ${human(sourceBytes)} → jar ${human(size)}；` +
      `裁掉 ${dropped} 条）`,
  );
  return { ...meta, path: cachePath, size };
}

/**
 * 把 [prepareAndroidJar] 的成品挂进 `merged` 的 `share/java/android.jar`。
 *
 * ⚠️ 覆盖点不是 asarPart 而是 `merged`：这个条目来自 stage 侧（ecj 的 deb），
 * 在 mergeEntries 时已经进了 merged。asarPart 里再放一条同名条目会被
 * mergeEntries 的冲突检查拦下（而且在它之后才 set，反而会造成 zip 里两条
 * 同名条目，App 侧解压顺序决定谁赢）。
 */
function attachAndroidJar(merged, asarPart, jarInfo) {
  console.log("[6.9/8] 挂载带 resources.arsc 的 android.jar");

  const zipPath = "share/java/android.jar";
  const target = merged.find((e) => e.path === zipPath);
  if (target === undefined) {
    throw new Error(
      `stage 里没有 ${zipPath} —— ecj 的 deb 未进闭包？没有它就换不成带 arsc 的版本。`,
    );
  }
  // 直接挂 `data`：写出阶段走 `e.data ?? readFileSync(blob)`，有 data 就用它。
  target.data = readFileSync(jarInfo.path);
  target.size = target.data.length;
  delete target.blob;
  console.log(`      ~ ${zipPath}（${jarInfo.kept} 条目 / ${human(target.size)}）`);

  const markerPath = ANDROID_JAR_MARKER_FILE;
  if (asarPart.has(markerPath)) throw new Error(`android.jar 标记与既有条目冲突：${markerPath}`);
  asarPart.set(markerPath, {
    data: Buffer.from(`${ANDROID_JAR_MARKER}\n`, "utf8"),
    mode: 0o644,
  });
  console.log(`      + ${markerPath}（${ANDROID_JAR_MARKER}）`);
}

/**
 * 下载（带缓存与 sha256 校验）并解开一个 npm tarball。
 *
 * `fallbacks` 是同内容的备用地址（缺陷 DH）。
 *
 * 为什么需要：这些包写在 `registry.npmmirror.com` 上，而构建机到该域名
 * 的 TLS 会**直接断连**（`基础连接已经关闭: 发送时发生错误`，不是 404、
 * 不是超时）。`registry.npmjs.org` 反而稳定可达，且 tarball 字节完全相同
 * （下面的 sha256 断言就是证据 —— 换地址换了内容会立刻失败）。
 *
 * 顺序：先主地址，失败再逐个备用。只要 sha256 对得上，来源无关紧要；
 * 缓存命中（`downloadTo` 的第一行）时一个地址都不会被访问。
 */
async function fetchTgz(pkg) {
  const dest = join(OFFICE_CACHE, pkg.file);
  const urls = [pkg.url, ...(pkg.fallbacks ?? [])];
  let state = null;
  let lastError = null;
  for (const url of urls) {
    try {
      state = await downloadTo(url, dest);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      console.warn(`      ! 下载失败（换备用地址）：${url}`);
      console.warn(`        ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (state === null) {
    throw new Error(
      `${pkg.file} 全部地址均失败：\n` +
        urls.map((u) => `  - ${u}`).join("\n") +
        `\n最后一条错误：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
  const buf = readFileSync(dest);
  const got = sha256Hex(buf);
  if (got !== pkg.sha256) {
    throw new Error(
      `${pkg.file} 校验失败：期望 sha256 ${pkg.sha256}，实得 ${got}（${human(buf.length)}）。` +
        `删除 ${dest} 后重试。`,
    );
  }
  console.log(`      ✓ ${pkg.file}（${state === "cached" ? "缓存" : "下载"}，${human(buf.length)}）`);
  return untarGz(buf);
}

/** 按 kit 的真实精确版本保留/注入 wasm，完整核验后再附带单文件 CJK 字体。 */
async function bundleOfficeAssets(asarPart) {
  console.log("[6.5/8] 打包 LibreOffice wasm 引擎与 CJK 字体");

  const office = await ensureOfficeWasm(asarPart, async (version) => {
    const pkg = PINNED_WASM_PKGS.get(version);
    if (!pkg) throw new Error(`kit ${version} 没有已钉住的 wasm 包来源，拒绝构建`);
    return fetchTgz(pkg);
  });
  const wasmCount = office.added;
  console.log(`      ${wasmCount ? "注入" : "保留"} ${OFFICE_WASM_ROOT}@${office.version}（${office.files.length} 项资源及源码/许可证全校验）`);

  const fonts = await fetchTgz(FONT_PKG);
  let fontCount = 0;
  for (const [src, dst] of FONT_PKG.pick) {
    const e = fonts.find((x) => x.path === src);
    if (!e) throw new Error(`字体包里找不到 ${src}`);
    const zipPath = FONT_PKG.zipBase + dst;
    if (asarPart.has(zipPath)) throw new Error(`字体条目与既有条目冲突：${zipPath}`);
    asarPart.set(zipPath, { data: e.data, mode: 0o644 });
    fontCount += 1;
    console.log(`      + ${zipPath}（${human(e.data.length)}）`);
  }

  verifyOfficeFonts(officeMapReader(asarPart));

  /*
   * 版本标记文件（锚点 9 的判据）。
   *
   * 字体与 wasm 包都是「新增资产」：老设备升级 APK 时 runtime 版本戳不变，
   * 九锚点全通过 ⇒ isComplete() 为真 ⇒ 新资产永远不落地。所以必须像
   * compat.js / modern.js 那样留一个可探的版本标记。标记写成独立小文件
   * 而不是塞进字体首行 —— TTF 的 sfnt 头部不能动。
   */
  const markerPath = `${FONT_PKG.zipBase}${OFFICE_FONTS_MARKER_FILE}`;
  if (asarPart.has(markerPath)) throw new Error(`字体标记条目与既有条目冲突：${markerPath}`);
  asarPart.set(markerPath, {
    data: Buffer.from(`${OFFICE_FONTS_MARKER}\n`, "utf8"),
    mode: 0o644,
  });
  console.log(`      + ${markerPath}（${OFFICE_FONTS_MARKER}）`);

  return { wasmCount, fontCount };
}

/**
 * 把第三方移动端 UI 插件（dsh-web-mobile）整包塞进 asarPart。
 *
 * 与 `bundleOfficeAssets` 同一手法、不同的理由：wasm 包是因为 `"os": ["linux"]`
 * 被 `isPlatformSpecific` 挡掉；这个包则是因为它**根本不在依赖闭包里** ——
 * 闭包只由 Termux deb 的 stage 与 `app.asar` 两处拼出来，第三方 npm 包两头
 * 都没有。所以只能构建期下载。
 *
 * 整包照搬（不做裁剪）：解包后一共 4.16 MiB / 209 条目，相对 555 MiB 的
 * runtime 可以忽略；而裁剪 `lib/types/` 或 `src/` 会在插件升级、或有人用
 * `exports` 的 `types` 条件做校验时变成难查的缺文件。**npm 装什么，这里就装
 * 什么**，语义最清楚。
 *
 * peer 核对：`asarPart` 是「stage + 上游 app.asar 闭包」的合并结果，正好
 * 就是最终装到设备上的那份引擎。插件的 `peerDependencies` 必须由它满足 ——
 * 引擎版本比插件下限还旧时，dsh 在设备上只会往 engine.log 写一行
 * `skipping profile bundle` 然后把插件静默跳过，界面上表现为「UI 出来了、
 * 工作区永远空」。这种事必须在构建期炸掉，见 semver-lite。
 */
async function bundleMobilePlugin(asarPart) {
  console.log("[6.6/8] 打包移动端 UI 插件 dsh-web-mobile");

  const files = await fetchTgz(MOBILE_PLUGIN_PKG);
  let count = 0;
  for (const e of files) {
    if (e.type !== "0") continue;
    if (!e.path.startsWith("package/")) continue;
    const rel = e.path.slice("package/".length);
    const zipPath = MOBILE_PLUGIN_PKG.zipBase + rel;
    if (asarPart.has(zipPath)) throw new Error(`移动端插件条目与既有条目冲突：${zipPath}`);
    asarPart.set(zipPath, { data: e.data, mode: 0o644 });
    count += 1;
  }

  /*
   * 必须逐字校验客户端半区与宿主半区都在。
   *
   * `dsh-client-modules` 发现插件的路径是：Loader entry 的 name → 包根
   * `package.json` 的 `dsh.client` → `exports["./client"]`。三段里任何一段缺了，
   * 表现都是**这一条 entry 静默不激活**（不是报错）：手机上看不到抽屉、看不到
   * 输入框左侧的文件按钮，而官方桌面布局一切正常，logcat 里也没有一行线索。
   * 所以在构建期硬失败，比在设备上猜要便宜得多。
   */
  const pkgEntry = files.find((e) => e.path === "package/package.json");
  if (!pkgEntry) throw new Error("移动端插件包里找不到 package.json");
  const pkgJson = JSON.parse(pkgEntry.data.toString("utf8"));
  if (pkgJson.name !== "dsh-web-mobile") {
    throw new Error(`移动端插件包名漂移：${pkgJson.name}`);
  }
  if (pkgJson.dsh?.client?.platform !== "web") {
    throw new Error(`移动端插件未声明 dsh.client.platform === "web"：${JSON.stringify(pkgJson.dsh)}`);
  }

  /*
   * peer 区间核对（真机事故 v0.9.62）。
   *
   * `dsh-web-mobile@3.3.5` 要 `@deepseek-ai/dsh-client-* >=0.2.2-rc.1 <0.3.0-0`。
   * 那次 `.cache/app.asar` 里躺的是引擎 `0.2.1-rc.5`（比 rc.3 还旧），构建
   * 全部通过、装机后引擎只在 engine.log 留一行 `skipping profile bundle`，
   * 然后把**整个移动端 UI 插件**跳掉 —— 手机上是空的。补这道断言，让它在
   * 构建期以退出码非 0 的形式暴露。
   *
   * 版本一律从闭包里读，不读插件自己的 `dependencies`：闭包才是最终装到
   * 设备上的那份。
   *
   * ⚠️ 「闭包里没有」**不等于**不兼容（v0.9.63 修正）：
   *   首版把所有 `@deepseek-ai/dsh-client*` 缺失都当失败，结果 0.2.2-rc.3 这份
   *   引擎直接被拦下 —— 它**压根不发布** `dsh-client-ui-primitives` /
   *   `dsh-client-ui-slots` 这两个包（整份 asar 里搜不到，不是被裁剪掉的），
   *   而同一份引擎 + 同一个插件在真机 0.9.62 上跑得好好的（engine.log 的
   *   `skipping` 计数为 0，移动端 UI 正常）。也就是说这两个名字属于「这一代引擎
   *   把导出并进 dsh-client-ui-layout」的历史遗留，插件在客户端 bundle 里能自己
   *   解析掉。把它们当失败判据只会得到「永远打不出包」。
   *
   *   所以判据收成两条：
   *     ① 闭包里**有**的 peer → 版本必须在区间内（这才是 rc.5 那次的真信号：
   *        `dsh-client-locale` 存在且是 0.2.1-rc.5）；
   *     ② 锚点包 `dsh-client-locale` **必须存在** —— 它是引擎 client 层的下限，
   *        缺了说明拿错了引擎（或换了命名规则），此时仍然硬失败。
   *   其余缺失项只打一行提示，留在构建日志里供事后对照。
   */
  const peers = pkgJson.peerDependencies ?? {};
  const peerProblems = [];
  const absentPeers = [];
  const found = new Map();
  for (const [path, entry] of asarPart) {
    const m = /^lib\/node_modules\/(@deepseek-ai\/dsh-[^/]+)\/package\.json$/.exec(path);
    if (m !== null && entry.data !== undefined) found.set(m[1], entry.data);
  }
  const PEER_ANCHOR = "@deepseek-ai/dsh-client-locale";
  for (const [name, range] of Object.entries(peers)) {
    const raw = found.get(name);
    if (raw === undefined) {
      if (name === PEER_ANCHOR) {
        peerProblems.push(`${name}：闭包里没有（要求 ${range}；它是引擎 client 层的锚点包）`);
      } else {
        absentPeers.push(name);
      }
      continue;
    }
    const actual = JSON.parse(raw.toString("utf8")).version;
    if (!satisfiesRange(actual, range)) {
      peerProblems.push(`${name}：闭包是 ${actual}，插件要 ${range}`);
    }
  }
  if (absentPeers.length > 0) {
    console.log(`      · 插件声明但该代引擎不单独发包：${absentPeers.join(", ")}（不拦，见注释）`);
  }
  if (peerProblems.length > 0) {
    throw new Error(
      `移动端插件 ${pkgJson.name}@${pkgJson.version} 与闭包里的引擎版本不兼容` +
        `（设备上会被静默跳过，UI 空白）：\n  ` +
        peerProblems.join("\n  ") +
        `\n换一份版本对得上的 app.asar（--asar）重建，或给 dsh-web-mobile 降版本。`,
    );
  }
  const probe = found.get(PEER_ANCHOR);
  const engineVersion =
    probe === undefined ? "?" : JSON.parse(probe.toString("utf8")).version;
  console.log(
    `      peer 核对通过（${Object.keys(peers).length} 项，闭包引擎 ${engineVersion}）`,
  );

  const clientRel = pkgJson.exports?.["./client"];
  const clientPath = typeof clientRel === "string" ? clientRel : clientRel?.default;
  if (typeof clientPath !== "string") {
    throw new Error(`移动端插件的 exports["./client"] 不是字符串：${JSON.stringify(clientRel)}`);
  }
  const clientZipPath = `${MOBILE_PLUGIN_PKG.zipBase}${clientPath.replace(/^\.\//, "")}`;
  if (!asarPart.has(clientZipPath)) {
    throw new Error(`移动端插件声明了 ${clientPath}，但包里没有这个文件`);
  }
  console.log(
    `      + ${MOBILE_PLUGIN_PKG.zipBase}（${count} 文件，${pkgJson.name}@${pkgJson.version}）`,
  );

  const markerPath = `${MOBILE_PLUGIN_PKG.zipBase}${MOBILE_PLUGIN_MARKER_FILE}`;
  if (asarPart.has(markerPath)) throw new Error(`移动端插件标记与既有条目冲突：${markerPath}`);
  asarPart.set(markerPath, {
    data: Buffer.from(`${MOBILE_PLUGIN_MARKER}\n`, "utf8"),
    mode: 0o644,
  });
  console.log(`      + ${markerPath}（${MOBILE_PLUGIN_MARKER}）`);

  return count;
}

/**
 * 把 Tesseract 简体中文语言包塞进 asarPart（阶段 6.7，锚点 12）。
 *
 * 落点在 `share/tessdata/` 而不是 `lib/node_modules/`：`EngineConfig` 注入的
 * `TESSDATA_PREFIX=<root>/share/tessdata`，tesseract 只认这个变量指向的目录，
 * 它不会去 node_modules 里找语言包。
 *
 * 与 `bundleOfficeAssets` 的另一处不同：这里**只有一份文件**，所以不复用
 * `fetchTgz`（那是解 npm tarball 的），直接用 `downloadTo` + sha256 校验。
 */
async function bundleTessdata(asarPart) {
  console.log("[6.7/8] 打包 Tesseract 简体中文语言包");

  const dest = join(OFFICE_CACHE, TESSDATA_FILE);
  const state = await downloadTo(TESSDATA_URL, dest);
  const buf = readFileSync(dest);
  const got = sha256Hex(buf);
  if (got !== TESSDATA_SHA256) {
    throw new Error(
      `${TESSDATA_FILE} 校验失败：期望 sha256 ${TESSDATA_SHA256}，实得 ${got}（${human(buf.length)}）。` +
        `删除 ${dest} 后重试。`,
    );
  }

  /*
   * 魔数必须是 `18 00 00 00`。
   *
   * 这是 tessdata 的格式标识（第一个 int32 是文件格式版本 0x18 = 24 号格式，
   * 由 `TessdataManager::Serialize` 写出）。加这道断言的理由很实际：这一步
   * 走网络，而 `raw.githubusercontent.com` 在受限网络下可能返回一个 HTML
   * 错误页 —— 那种响应**长度不为 0**，只判体积会放过它，直到用户去识别
   * 中文时才在 tesseract 内部报一个与下载毫无关系的错。
   */
  const magic = `${buf[0].toString(16).padStart(2, "0")} ${buf[1].toString(16).padStart(2, "0")} ` +
    `${buf[2].toString(16).padStart(2, "0")} ${buf[3].toString(16).padStart(2, "0")}`;
  if (magic !== "18 00 00 00") {
    throw new Error(
      `${TESSDATA_FILE} 不是 tessdata 格式：首 4 字节 ${magic}（期望 18 00 00 00）。` +
        `多半是下到了 HTML 错误页或 404 占位，删除 ${dest} 后重试。`,
    );
  }

  const zipPath = `${TESSDATA_ZIP_BASE}${TESSDATA_FILE}`;
  if (asarPart.has(zipPath)) throw new Error(`语言包条目与既有条目冲突：${zipPath}`);
  asarPart.set(zipPath, { data: buf, mode: 0o644 });
  console.log(`      + ${zipPath}（${human(buf.length)}，${state === "cached" ? "缓存" : "下载"}）`);

  const markerPath = TESSDATA_MARKER_FILE;
  if (asarPart.has(markerPath)) throw new Error(`语言包标记与既有条目冲突：${markerPath}`);
  asarPart.set(markerPath, {
    data: Buffer.from(`${TESSDATA_MARKER}\n`, "utf8"),
    mode: 0o644,
  });
  console.log(`      + ${markerPath}（${TESSDATA_MARKER}）`);
}

/**
 * 把 TeX Live 宏包树整棵搬进 asarPart（阶段 6.8，锚点 13）。
 *
 * 数据源是 `tools/fetch-texlive.py` 的产物（`.cache/texlive-macros/share/texlive/<年份>/`），
 * 不是网络：那份闭包要跑几十次 CTAN 请求、几分钟才凑齐，构建脚本每次重下
 * 不合理。本阶段只做「读盘 → 塞进 asarPart」，缺缓存就报错并给出生成命令。
 *
 * 为什么必须整棵搬（含 `tlpkg/`、`release-texlive.txt` 这些看起来没用的）：
 * `fmtutil` / `texlinks` / `tlmgr` 全都是 Perl 脚本，它们 `use TeXLive::TLConfig`
 * —— 那个模块在 `tlpkg/` 下。少了 `tlpkg/` 的表现是 `texlinks` 报
 * `Can't locate mktexlsr.pl in @INC`，与「宏包树缺失」看起来是两回事。
 *
 * 关于 `ls-R` 与收窄的 `language.dat`：这两个**不是**本阶段生成的，而是
 * `fetch-texlive.py` 的 `write_ls_r()` / `make_hyphenation_minimal()` 在解包后
 * 就写进缓存树的。本阶段照搬即可 —— 但要在下面各断言一次，因为它们决定了
 * `pdflatex` 能不能真正跑起来（见缺陷 AR / AY）：
 *   - 没有 `ls-R`：`texmf.cnf` 把树标成 `!!`（只查数据库不扫目录），
 *     `kpsewhich article.cls` 什么都搜不到；
 *   - `language.dat` 没收窄：`pdftex -ini` 读到第一个缺失的断词文件就
 *     `! Emergency stop.`，`pdflatex.fmt` 永远生成不出来。
 */
async function bundleTexliveMacros(asarPart) {
  console.log("[6.8/8] 打包 TeX Live 宏包树");

  const root = join(TEXLIVE_MACROS_SRC, TEXLIVE_YEAR);
  if (!existsSync(root)) {
    throw new Error(
      `TeX Live 宏包树缓存不存在：${root}\n` +
        `先生成：python tools/fetch-texlive.py（约 5 分钟，取 scheme-basic 闭包）`,
    );
  }

  // 先断言两个决定性文件，再开始搬 5894 个文件 —— 搬完才发现缺，白等几分钟。
  const lsR = join(root, "texmf-dist", "ls-R");
  if (!existsSync(lsR)) {
    throw new Error(
      `宏包树缺 ls-R：${lsR}\n` +
        `它是 kpsewhich 的文件名索引，缺了 pdflatex 连 article.cls 都找不到。` +
        `重跑 python tools/fetch-texlive.py（write_ls_r 会补上）。`,
    );
  }
  const langDat = join(root, "texmf-dist", "tex", "generic", "config", "language.dat");
  if (existsSync(langDat)) {
    const text = readFileSync(langDat, "utf8");
    // 收窄版的标志：只剩闭包里真实存在的几条。完整版引 226 个语言，
    // 而闭包只带 hyphen.tex / hyph-en-*.tex —— 行数是最省事的判据。
    const entries = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("%")).length;
    if (entries > 10) {
      throw new Error(
        `language.dat 未收窄（${entries} 条，期望 <= 10）：${langDat}\n` +
          `完整版引用 226 个断词文件，而 scheme-basic 闭包只带英文的 —— ` +
          `pdftex -ini 会在第一个缺失文件上 Emergency stop，pdflatex.fmt 生成不出来。\n` +
          `重跑 python tools/fetch-texlive.py（make_hyphenation_minimal 会收窄）。`,
      );
    }
    console.log(`      language.dat 已收窄（${entries} 条）`);
  }
  /*
   * `language.def` 与 `language.dat` 形态完全不同，判据也不同（v0.9.62 回归）。
   *
   * 它是 **e-TeX 源码**，不是纯条目表：首行 `% e-TeX V2.6` 是建格式时的版本探针，
   * 后面还有 `\ifx`/`\else`/`\fi` 控制流，`\addlanguage{<lang>}{<pattern>}` 才是
   * 条目。早期 `make_hyphenation_minimal` 会「重新生成文件、只写认出来的条目」，
   * 于是它被压成 82 字节的单行中文注释；`pdftex -ini` 读到头部不符就进
   * `\@sk {Use fallback?}` 交互分支 → stdin 是 /dev/null → Emergency stop →
   * 一个 .fmt 都落不了盘。**行数少不代表对**，必须逐项验头部与条目。
   */
  const langDef = join(root, "texmf-dist", "tex", "generic", "config", "language.def");
  if (!existsSync(langDef)) {
    throw new Error(`宏包树缺 language.def：${langDef}`);
  }
  const defText = readFileSync(langDef, "utf8");
  const defHead = (defText.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  // 上游首行是 `%% e-TeX V2.0;2`（两个百分号，TeX Live 原样），所以用 `%+`。
  if (!/^%+\s*e-TeX\s*V/i.test(defHead)) {
    throw new Error(
      `language.def 头部被破坏（首行应为 "% e-TeX V…"，实际：${JSON.stringify(defHead.slice(0, 60))}）\n` +
        `它是 e-TeX 建格式的版本探针；不符时 pdftex -ini 会进交互式 fallback，` +
        `在 /dev/null 下 Emergency stop，pdflatex.fmt 生成不出来。\n` +
        `重跑 python tools/fetch-texlive.py（make_hyphenation_minimal 现在逐行过滤，保住头部）。`,
    );
  }
  const defEntries = defText.split(/\r?\n/).filter((l) => /^\\addlanguage\s*\{/.test(l.trim())).length;
  if (defEntries < 1) {
    throw new Error(
      `language.def 里一条 \\addlanguage 都没有（${langDef}）\n` +
        `hyphen.cfg 靠它建语言表，空的等于所有语言都缺断词模式。\n` +
        `重跑 python tools/fetch-texlive.py。`,
    );
  }
  console.log(`      language.def 头部完好，断词条目 ${defEntries} 条`);
  console.log(`      ls-R ${human(statSync(lsR).size)}`);

  /*
   * 再断言两处「pdflatex 出 PDF 的决定性产物」，理由同上面两条：
   *   - 没有 `fonts/map/pdftex/updmap/pdftex.map`：pdflatex 编到第一个字就
   *     `!pdfTeX error: pdflatex (file cmbx12): Font cmbx12 at 720 not found`，
   *     连一页 PDF 都产不出（真机实测）。updmap-sys 在设备上跑不通，只能
   *     构建期拼好。
   *   - `dvipdfmx.cfg` 里若还是 `p  a4`：`xelatex` 报
   *     `xdvipdfmx:fatal: Unrecognized paper format: a4` 直接失败，且
   *     命令行 `-p` 完全无效，只能改 cfg。
   */
  const pdftexMap = join(root, "texmf-dist", "fonts", "map", "pdftex", "updmap", "pdftex.map");
  if (!existsSync(pdftexMap)) {
    throw new Error(
      `宏包树缺 pdftex.map：${pdftexMap}\n` +
        `它是 Type1 字体映射表，缺了 pdflatex 会去现搓 PK 位图然后\n` +
        `  !pdfTeX error: pdflatex (file cmbx12): Font cmbx12 at 720 not found\n` +
        `重跑 python tools/fetch-texlive.py（build_pdftex_map 会拼上）。`,
    );
  }
  console.log(`      pdftex.map ${human(statSync(pdftexMap).size)}`);

  const dvipdfmxCfg = join(root, "texmf-dist", "dvipdfmx", "dvipdfmx.cfg");
  if (existsSync(dvipdfmxCfg)) {
    const cfg = readFileSync(dvipdfmxCfg, "latin1");
    if (/^\s*p\s+a4\s*$/m.test(cfg)) {
      throw new Error(
        `dvipdfmx.cfg 仍写着 \`p  a4\`：${dvipdfmxCfg}\n` +
          `真机上 xdvipdfmx 对纸名 a4 直接致命退出（命令行 -p 也无效）：\n` +
          `  xdvipdfmx:fatal: Unrecognized paper format: a4\n` +
          `重跑 python tools/fetch-texlive.py（fix_dvipdfmx_paper 会换成\n` +
          `  p  595.28pt,841.89pt —— 同样的 A4，但走纯数值解析）。`,
      );
    }
  }

  /*
   * 还有一处**不在缓存树里、但设备上必需**的产物：`web2c/` 下的 `mktex*`
   * 脚本（mktexnam / mktexdir / mktexpk …）的可执行位。zip 里它们是 0600，
   * 解包后 pdflatex 想生成 PK 字体就会报 `Permission denied`。
   * 这里把可执行位写进条目 mode，由 RuntimeInstaller.restoreExecBits 之外的
   * 路径也能生效（mode 直接落盘）。
   */
  const web2cDir = join(root, "texmf-dist", "web2c");
  let mktexCount = 0;

  const base = `share/texlive/${TEXLIVE_YEAR}/`;
  let count = 0;
  let bytes = 0;

  /*
   * 递归遍历。用显式栈而不是递归函数：宏包树有 180 多个目录，深度不大，
   * 但显式栈让「跳过目录」这类逻辑（`.git`、临时文件）写在一处更清楚。
   *
   * 符号链接在缓存树里不该出现（fetch-texlive.py 是解 tar.xz，tar 里的
   * 软链会被解开成普通文件或真实链接）。这里仍按 `isFile()` 过滤：
   * 指向目录的链接若不跟随，会被当成文件读而失败 —— 宁可跳过也不中断，
   * 但要在最后计数里体现出来，不然「少了几百个文件」会静默发生。
   */
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      // 相对路径统一用 `/`：zip 内路径必须是 posix 分隔符，Windows 上
      // path.relative 会给反斜杠，直接拼进 zipPath 会变成扁平文件名。
      const rel = abs.slice(root.length + 1).split("\\").join("/");
      const zipPath = base + rel;
      if (asarPart.has(zipPath)) throw new Error(`宏包树条目与既有条目冲突：${zipPath}`);
      const data = readFileSync(abs);
      // `web2c/mktex*` 是 pdflatex 生成 PK 字体时要 exec 的 shell 脚本，
      // 必须是 0755；tar.xz 里本来带可执行位，但 Windows 缓存树丢掉了。
      const isExec = /^texmf-dist\/web2c\/mktex[\w.-]*$/.test(rel);
      if (isExec) mktexCount += 1;
      asarPart.set(zipPath, { data, mode: isExec ? 0o755 : 0o644 });
      count += 1;
      bytes += data.length;
    }
  }

  if (count === 0) throw new Error(`宏包树是空的：${root}`);
  if (mktexCount > 0) console.log(`      web2c/mktex* 置 0755（${mktexCount} 个）`);
  console.log(`      + ${base}（${count} 文件，${human(bytes)}）`);

  const markerPath = TEXLIVE_MARKER_FILE;
  if (asarPart.has(markerPath)) throw new Error(`宏包树标记与既有条目冲突：${markerPath}`);
  asarPart.set(markerPath, {
    data: Buffer.from(`${TEXLIVE_MARKER}\n`, "utf8"),
    mode: 0o644,
  });
  console.log(`      + ${markerPath}（${TEXLIVE_MARKER}）`);
}

// ──────────────────────────────────────── 宿主插件内容指纹（替代手工递增编号）
//
// 缺陷 DP 与「插件更新不会到达老设备」是同一个病：锚点 8 判的是
// `kxxy-host/lib/index.js` 首行那个人手写死的 `kxxy-host@N`，而它**实际管辖
// 整个 `plugins/kxxy-host/` 目录** —— `web/*.js`、`web/*.css`、`lib/*.mjs` 改一遍，
// 只要忘了递增 N，设备上就会带着旧 web 层继续跑，且前十六个锚点全通过、
// `isComplete()` 判真、跳过重装，**整条链路一声不响**。
//
// 「忘了递增」不是自制力问题：全仓只有 index.js:1 与 RuntimeInstaller.kt 两处
// 写着这个数字，任何一次改动都要人工同步，只要没有测试守护就迟早漏。
//
// 现在改成构建期算内容指纹：对整棵插件树（路径 + 内容）求 sha256，写进
// 插件自己的 `lib/.fingerprint`，同时把入口首行的标记改写成 `kxxy-host@<指纹前12位>`
// 供人 eyes-read。设备侧锚点 8 改为「读 APK assets 里的期望指纹，与设备上的
// `.fingerprint` 比对」——APK 换了而插件没换，指纹必然不等，强制重装。
//
// **自指问题的处理**：指纹不能包含它自己产出的两样东西 ——
//   ① `lib/.fingerprint` 文件本身（写之前算，算完写）；
//   ② `lib/index.js` 首行那行标记注释（算之前先剥掉，写的时候再放回去）。
// 否则「算出的指纹改变标记、标记又改变指纹」，每次构建的指纹都不一样，
// 设备上永远重装（700 MiB 全量解压，比 bug 本身更糟）。
// 宿主指纹算法由全量装配与 Python 增量修复共用（lib/host-fingerprint.mjs）。

/**
 * 从 git remote 取仓库地址，规范化成**能点开**的 https 形式。
 *
 * 这个值唯一的用途是填关于弹窗里那条「GitHub」链接，所以不追求完整语义：
 *   · `git@github.com:owner/repo.git` → `https://github.com/owner/repo`
 *   · 结尾的 `.git` 去掉（浏览器里点进去更干净）
 *   · 非 http(s)（本地路径、file:// 克隆）一律丢弃
 *
 * 拿不到就返回空串，前端会把整条链接隐藏 —— 一个点不通的死链比没有更糟。
 * 之所以在**构建期**取而不是运行期：设备上没有 git，也没有仓库元数据。
 */
function readRepoUrl() {
  const candidates = [
    "git",
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "/usr/bin/git",
  ];
  for (const bin of candidates) {
    let raw = "";
    try {
      raw = execFileSync(bin, ["remote", "get-url", "origin"], {
        cwd: PROJECT,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      continue;
    }
    if (!raw) continue;
    const ssh = /^git@([^:]+):(.+)$/.exec(raw);
    let url = ssh ? `https://${ssh[1]}/${ssh[2]}` : raw;
    url = url.replace(/\.git$/, "").replace(/\/+$/, "");
    if (/^https?:\/\//i.test(url)) return url;
    return "";
  }
  return "";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.pythonDeps || !existsSync(opts.pythonDeps)) {
    throw new Error("缺少已验证的 Python 依赖构件：先运行 tools/build-python-deps.py 并传 --python-deps <manifest.json>，不能再产出缺 CFFI 的离线 Python");
  }
  const pythonDependencies = loadPythonDependencies(opts.pythonDeps);

  if (!existsSync(join(opts.stage, "entries.json"))) {
    throw new Error(`stage 不存在或不完整：${opts.stage}（缺 entries.json）`);
  }
  /*
   * 陈旧 stage 是这套流水线里**最隐蔽**的错误源（v0.9.68 真事故）：
   * 用几周前的闭包装配出来的 runtime.zip 完全合法（条目齐、摘要对、能解压），
   * 只是少了种子表里新加的包。设备侧表现是「种子里写了 pandas，site-packages
   * 里没有 pandas」，排查方向会被引到 Python/PIP 上，实际与 Python 无关。
   *
   * 只在用默认 stage 时断言：显式 `--stage <dir>` 的场景（实验、回放旧闭包）
   * 有自己的清单，不该拿 `.cache/debs/manifest.json` 去要求它。
   */
  if (resolve(opts.stage) === resolve(join(PROJECT, ".cache", "stage"))) {
    const fresh = stageStaleness(PROJECT);
    if (!fresh.ok) {
      throw new Error(
        `stage 与 deb 清单不一致：${fresh.reasons.join("；")}\n` +
          `  先跑 node tools/prepare-stage.mjs（重新 debextract 到 ${opts.stage}）`,
      );
    }
  }
  if (!existsSync(opts.asar)) {
    throw new Error(`asar 不存在：${opts.asar}`);
  }

  /*
   * android.jar 必须**第一个**做（缺陷 CQ）。
   *
   * 它本身只要 10 MiB 内存，但必须在 stage/asar 全部读进来**之前**完成：
   * 这台构建机的提交内存上限只有 16.2 GB 且常态只剩 0.9 GB，而 [1]–[6.8]
   * 阶段已经把 `part`（22,217 实体）、`deduped`、`asarFiles`（16,491 文件
   * / 171.78 MiB）与 TeX 宏包树（13,669 文件 / 171.31 MiB）全部钉在堆上。
   * 等到 [6.9] 再临时解 26 MiB 源 jar + 6229 个 class 重压，就会撞上
   *   FATAL ERROR: Committing semi space failed.
   * ——这个报错是**新生代**分配失败，与 `--max-old-space-size` 无关，
   * 调大调小都救不了（512 / 1536 / 2048 / 8192 MiB 四档实测同一句）。
   *
   * 提前做之后，峰值被压到「一条 class + 最终 10 MiB」，实测 768 MiB 堆即可
   * 完成（`tools/_probe_jar.mjs` 隔离验证：6229 条目 / 10.07 MiB / arsc 在位）。
   * 成品落到 stage 缓存目录，[6.9] 只负责挂进 `merged`，不再重算。
   */
  const jarCache = await prepareAndroidJar();

  // ---------------------------------------------------------------- stage 侧
  console.log(`[1/8] 读 stage ${opts.stage}`);
  const part = collectStage(opts.stage);
  const pythonStageEntries = new Map(part.files.map((entry) => [entry.path, entry]));
  const pythonStageLinks = new Map(part.links.map((entry) => [entry.path, entry.target]));
  /*
   * 种子表里「必须有」的 Python 包，逐个在 stage 里点一次名。
   *
   * 这一条是 v0.9.68 事故的防线之二（其一是 `lib/stage-fresh.mjs` 的清单比对）。
   * 事故形态：stage 停在几周前，`runtime.zip` 依旧「合法」，只是
   * `site-packages/` 里没有 pandas / scipy / matplotlib —— 设备侧表现为
   * `ModuleNotFoundError`，而种子表写得明明白白，排查会被引向 Python 本身。
   *
   * 为什么不靠「文件数下限」这类间接指标：这条断言要的是**点到名的包在**，
   * 少一个就构建失败，报错里直接给包名。
   */
  const REQUIRED_PY_PACKAGES = ["numpy", "pandas", "scipy", "matplotlib", "lxml", "PIL"];
  const missingPy = REQUIRED_PY_PACKAGES.filter(
    (name) => !pythonStageEntries.has(`lib/python3.14/site-packages/${name}/__init__.py`),
  );
  if (missingPy.length) {
    throw new Error(
      `stage 缺少种子表声明的 Python 包：${missingPy.join(", ")}` +
        `（site-packages 里没有对应目录）—— 先跑 node tools/prepare-stage.mjs 重解闭包`,
    );
  }
  const readPythonStage = (path, seen = new Set()) => {
    if (seen.has(path)) throw new Error(`Python stage LINK 循环：${path}`);
    seen.add(path);
    if (pythonStageLinks.has(path)) return readPythonStage(pythonStageLinks.get(path), seen);
    const entry = pythonStageEntries.get(path);
    if (!entry) return null;
    const data = entry.data ?? readFileSync(join(part.stage.blobRoot, entry.blob.slice(0, 2), entry.blob));
    // 构件来自已归一化的 runtime，sysconfig 也须用相同占位符比对。
    if (!isElf(data) && SCRIPT_TOP_DIRS.some((dir) => path.startsWith(dir)) && data.length <= MAX_SCRIPT_BYTES) {
      let text = data.toString("latin1");
      for (const [needle, replacement] of PATH_REWRITES) text = text.split(needle).join(replacement);
      return Buffer.from(text, "latin1");
    }
    return data;
  };
  verifyPythonInputs(pythonDependencies.ledger, readPythonStage);
  for (const path of pythonDependencies.files.keys()) {
    if (pythonStageEntries.has(path) || pythonStageLinks.has(path)) throw new Error(`Python 受管依赖与 stage 冲突，需核对版本：${path}`);
  }
  console.log(
    `      stage：实体 ${part.files.length}，符号链接 ${part.links.length}，` +
      `丢弃 ${part.dropped.length}`,
  );

  const deduped = dedupeByContent(part.files, part.links);
  console.log(
    `[2/8] 内容去重：${part.files.length} → ${deduped.files.length} 本体，` +
      `新增 ${deduped.links.length - part.links.length} 个 LINK，省 ${human(deduped.savedBytes)}`,
  );

  const norm = normaliseStageFiles(deduped.files, part.stage.blobRoot);
  console.log(
    `[3/8] 路径归一化：改写 ${norm.touched} 个脚本 → ${ROOT_PLACEHOLDER}，` +
      `剔除 ${norm.dropped} 个死解释器脚本`,
  );
  for (const p of norm.droppedPaths) console.log(`      - ${p}`);

  /**
   * 目录型符号链接展开：`lib/terminfo → share/terminfo` 这类链接无法用单条
   * LINK 表达（LINK 的目标必须是实体文件），所以把它**逐个成员**展开成
   * `lib/terminfo/<rel>` → LINK → `share/terminfo/<rel>`。
   *
   * 展开必须在去重与归一化之后：此时 `deduped.files` 已是最终本体集合，
   * 且归一化可能把某个成员升级成内存条目（本任务里 terminfo 是二进制，
   * 不会被改，但规则上仍以后者为准）。
   */
  const dirLinks = collectDirLinks(part.stage);
  const dirLinkEntries = [];
  const memberPaths = new Set(deduped.files.map((f) => f.path));
  for (const dl of dirLinks) {
    const prefix = `${dl.target}/`;
    const members = [...memberPaths].filter((p) => p.startsWith(prefix));
    for (const m of members) {
      dirLinkEntries.push({ path: dl.path + m.slice(dl.target.length), type: "link", target: m, mode: 0o644 });
    }
    console.log(`      目录链接 ${dl.path} → ${dl.target}：展开 ${members.length} 条 LINK`);
  }
  deduped.links.push(...dirLinkEntries);

  // ---------------------------------------------------------------- asar 侧
  console.log(`[4/8] 打开 asar ${opts.asar}`);
  const asar = openAsar(opts.asar);
  const closure = resolveClosure(asar, CLOSURE_ROOTS);
  console.log(`      闭包 ${closure.seen.size} 个包；平台跳过 ${closure.platformSkipped.size}，缺失 ${closure.missing.size}`);
  if (closure.missing.size) {
    const list = [...closure.missing].slice(0, 10).map(([d, by]) => `${d} (by ${by})`);
    throw new Error(`非 optional 依赖缺失，asar 不完整：${list.join(", ")}`);
  }
  // 接缝包体检：peerDependencies 是 DSH 的抽象层接缝机制（实现包 peer 抽象层，
  // 抽象层自身无人以 dependencies 声明）。这些包一旦漏出闭包，设备上引擎会在
  // 启动阶段抛 `Cannot find package '@deepseek-ai/dsh-fs'` 之类，且错误离构建期很远。
  // 这里只做**存在性**断言（闭包里的包数），不做完整性断言 —— 官方安装是扁平提升的，
  // 我们复刻的是「按闭包裁剪」，两者集合不一定相等。
  const SEAM_PROBES = [
    "@deepseek-ai/cordis-plugin-group",
    "@deepseek-ai/dsh-fs",
    "@deepseek-ai/dsh-sandbox",
    "@deepseek-ai/dsh-shell",
    "@deepseek-ai/dsh-compaction",
    "@deepseek-ai/dsh-workflow",
    "@deepseek-ai/dsh-session-persistence",
    "@deepseek-ai/dsh-attachment",
    "@deepseek-ai/dsh-spill",
    "@deepseek-ai/dsh-ptc-runtime",
    "@deepseek-ai/dsh-session-query",
    "@deepseek-ai/dsh-output-retention",
  ];
  const absentSeams = SEAM_PROBES.filter((n) => !closure.seen.has(n));
  if (absentSeams.length) {
    throw new Error(`接缝包漏出闭包（peerDependencies 未跟随？）：${absentSeams.join(", ")}`);
  }
  console.log(`      ✓ 接缝包 ${SEAM_PROBES.length} 个全在闭包内`);

  const asarFiles = new Map();
  readClosureInto(asar, closure, asarFiles);
  let asarBytes = 0;
  for (const v of asarFiles.values()) asarBytes += v.data.length;
  console.log(`      asar 侧 ${asarFiles.size} 文件 / ${human(asarBytes)}`);

  // ---------------------------------------------------------------- 补丁
  /**
   * `termuxRead`：补丁需要从 Termux stage 取文件（`patchRipgrep` 要 `bin/rg`）。
   * 走归一化**之前**的原始 blob —— rg 是 ELF，归一化不会碰它，
   * 但用原始 blob 更稳（不依赖归一化的过滤规则）。
   */
  const originalByPath = new Map(part.files.map((f) => [f.path, f]));
  const termuxRead = (rel) => {
    const e = originalByPath.get(rel);
    if (!e || !e.blob) return null;
    return readFileSync(join(part.stage.blobRoot, e.blob.slice(0, 2), e.blob));
  };

  console.log("[5/8] 应用补丁");
  /*
   * 先断言原生层与补丁的契约：patchRequireBuiltin 把
   * node-addon-require-builtin 换成纯 JS shim，shim 靠 `--expose-internals`
   * 才能 require `internal/*`。EngineProcess.kt 一旦去掉这个 flag，
   * 引擎会在启动阶段抛 "profile resolution: unsupported Node module loader"，
   * 而那个错误离构建期很远 —— 在这里提前失败。
   */
  const engineProcessKt = join(PROJECT, "android", "app", "src", "main", "java", "app", "kxxy", "engine", "EngineProcess.kt");
  assertEngineFlags(readFileSync(engineProcessKt, "utf8"));
  console.log("      ✓ EngineProcess.kt 传了 --expose-internals");

  const patchLog = applyAllPatches(asarFiles, termuxRead);
  for (const line of patchLog) console.log(`      ${line}`);

  // ---------------------------------------------------------------- 组装
  console.log("[6/8] 生成 corepack 包装器");
  // 官方主题 token 抽取（必须在 readPluginFiles 之前：产物随插件打包）
  extractOfficialTheme(asarFiles);
  // 包装器落在 bin/ 而非 lib/node_modules/ 下，因此不能塞进 asarFiles
  // （那个 Map 的键全部以 lib/node_modules/ 开头）；单独一份 Map。
  //
  // ⚠️ 拷完立刻清空 `asarFiles`（缺陷 CQ 连带修复）。`new Map(asarFiles)` 是
  // **浅拷贝**：两个 Map 指向同一批 `{data}` 对象。如果不清空旧 Map，那些
  // 171.78 MiB 的 Buffer 会被两个键集同时钉在堆上，后面写出阶段的「大条目
  // 落盘」就等于白做 —— 实测症状正是在写到第 N 条时
  //   RangeError: Failed to allocate memory
  //     at Buffer.allocUnsafe (node:internal/buffer:456:10)
  // 连 4 MiB 的分块缓冲都分配不出来。`asarFiles` 在此之后再无读者。
  const asarPart = new Map(asarFiles);
  asarFiles.clear();
  for (const [path, file] of pythonDependencies.files) asarPart.set(path, file);
  console.log(`      + Python 离线依赖 ${pythonDependencies.files.size} 文件（CFFI + pycparser）`);
  /*
   * 纯 Python 兄弟包（pandas / matplotlib / sympy 的依赖）。
   *
   * 这些包 Termux 主仓里**没有**，pandas 与 matplotlib 的 deb 也不带它们 ——
   * 设备上表现为「文件都在，一 import 就缺 dateutil / packaging / cycler」。
   * 全部是 `*-none-any.whl`（纯 Python），这里直接解进 site-packages，
   * 不经过 pip，也不需要联网。详见 tools/lib/pydeps.mjs 的头部说明。
   */
  const pyDeps = await loadPyDeps({ log: (m) => console.log(`        ${m}`) });
  for (const [path, file] of pyDeps.files) asarPart.set(path, file);
  console.log(
    `      + 纯 Python 依赖 ${pyDeps.files.size} 文件（${PYDEPS.map((d) => d.pypi).join(", ")}）`,
  );
  const nativeMl = loadNativeMl({ log: (m) => console.log(`        ${m}`) });
  for (const [path, file] of nativeMl) asarPart.set(path, file);
  console.log(
    `      + 原生 bionic 包 ${nativeMl.size} 文件（${NATIVE_ML.map((d) => d.name).join(", ")}）`,
  );
  // 点名断言：注入完必须能在最终条目里找到这些 import 入口。
  // 少一个就构建失败——否则真机上又要靠 ModuleNotFoundError 才发现。
  const REQUIRED_PURE_PY = [
    "dateutil/__init__.py",
    "packaging/__init__.py",
    "cycler/__init__.py",
    "pyparsing/__init__.py",
    "fontTools/__init__.py",
    "pytz/__init__.py",
    "tzdata/__init__.py",
    "sympy/__init__.py",
    "mpmath/__init__.py",
    "six.py",
    "joblib/__init__.py",
    "threadpoolctl.py",
    "narwhals/__init__.py",
    "cloudpickle/__init__.py",
  ];
  const missingPurePy = REQUIRED_PURE_PY.filter((rel) => !asarPart.has(`lib/python3.14/site-packages/${rel}`));
  if (missingPurePy.length) {
    throw new Error(`纯 Python 依赖注入不完整，缺：${missingPurePy.join(", ")}`);
  }
  const REQUIRED_NATIVE_ML = [
    "sklearn/__init__.py",
    "sklearn/linear_model/_cd_fast.cpython-314-aarch64-linux-android.so",
    "scikit_learn-1.9.1.dist-info/METADATA",
    "cv2/__init__.py",
    "cv2/cv2.cpython-314-aarch64-linux-android.so",
    "opencv_python_headless-5.1.0.95.dist-info/METADATA",
  ];
  const missingNative = REQUIRED_NATIVE_ML.filter(
    (rel) => !asarPart.has(`lib/python3.14/site-packages/${rel}`),
  );
  if (missingNative.length) {
    throw new Error(`原生 bionic 包注入不完整，缺：${missingNative.join(", ")}`);
  }
  /*
   * 离线 npm 本体（v0.9.89）。
   *
   * pnpm 在 v0.9.69 换成了随包 SEA，npm 这一半一直没做：`bin/npm` 仍是 corepack
   * shim，corepack 首次运行要把 `packageManager` 指定的 npm 整包下载到
   * `~/.cache/node/corepack`。手机侧这条路径既慢又常被挂死（既不 EOF 也不超时），
   * 于是用户感知就是「`npm install` 第一次调用永远卡住」。
   *
   * 这里把 npm 的纯 JS 发布包（自带全部 bundleDependencies，无平台二进制）
   * 解到 `lib/node_modules/npm/`，配合 corepackWrappers() 让 `bin/npm` /
   * `bin/npx` / `corepack npm` 全部走本地这份。体积约 2.9 MiB（压缩后）。
   */
  const bundledNpmInfo = loadBundledNpm();
  for (const [rel, file] of bundledNpmInfo.files) asarPart.set(rel, file);
  console.log(
    `      + 离线 npm ${bundledNpmInfo.version}（${bundledNpmInfo.files.size} 文件，bin/npm → 本地 npm-cli.js）`,
  );

  /*
   * pnpm 来自 Termux 闭包（`SEED_PACKAGES` 里的 `pnpm`），已经在 stage 里，
   * 这里只判断「它在不在」来决定 `bin/pnpm` 走本地还是回退 corepack。
   *
   * 为什么不用 npm 上的 `pnpm` 包：12.x 起 pnpm 官方发行版是**原生可执行文件**
   * （`@pnpm/exe.linux-arm64` 之类，只有 glibc/musl 两种 linux 目标，没有 bionic），
   * npm 包里只剩一个「找不到就现下载」的 shim —— 装到手机上第一次运行仍要联网。
   * Termux 那份是源码编译的纯 JS 版本，`dist/pnpm.cjs` 直接跑在引擎的 node 上。
   */
  // Termux 的 `pnpm` 包只发一个自包含可执行（`bin/pnpm`，node SEA，54.7 MiB）
  // 加一条 `bin/pnpx -> pnpm` 软链，没有 `lib/node_modules/pnpm` 这层。
  const bundledPnpm = deduped.files.some((e) => e.path === "bin/pnpm")
    || deduped.links.some((e) => e.path === "bin/pnpm");
  if (bundledPnpm) {
    console.log("      + bin/pnpm（来自 Termux 闭包，离线 pnpm，54.7 MiB）");
  } else {
    console.warn("      ⚠️ stage 里没有 bin/pnpm —— 会退回 corepack shim（首次运行要联网下载）");
  }
  for (const w of [
    ...corepackWrappers(bundledPnpm, true),
    ...hardlinkWrappers(),
    ...rsyncWrappers(),
    ...fortranWrappers(),
    ...perfWrappers(),
    ...pythonDefaultWrappers(),
    ...pythonHintEntries(),
  ]) {
    // 同名 stage 条目必须让位：`bin/corepack` 在 stage 里是一条符号链接
    // （`→ ../lib/node_modules/corepack/dist/corepack.js`），它会以 LINK 条目
    // 进入 deduped.links，随后与这里的包装器在 mergeEntries 里撞名而抛错。
    // 包装器本身就是对这个坏链的修复，所以由它胜出 —— 直接把 stage 侧同名
    // 条目摘掉（没有任何东西指向 `bin/corepack`，摘掉不会造成悬空）。
    for (const list of [deduped.files, deduped.links]) {
      const i = list.findIndex((e) => e.path === w.path);
      if (i >= 0) {
        list.splice(i, 1);
        console.log(`      ~ 摘掉 stage 同名条目 ${w.path}（由包装器接管）`);
      }
    }
    if (asarPart.has(w.path)) throw new Error(`corepack 包装器与既有条目冲突：${w.path}`);
    asarPart.set(w.path, { data: w.data, mode: w.mode });
    if (/@DSH_(?:ROOT|HOME|TMP|FILES|DATA)@/.test(w.data.toString("utf8"))
        && !norm.placeholderPaths.includes(w.path)) norm.placeholderPaths.push(w.path);
    console.log(`      + ${w.path}`);
  }

  /*
   * 自有插件（plugins/<name>/）。
   *
   * 它们落进 asarPart 的 lib/node_modules/ 前缀区，因此自动被下面的
   * collectDirs 推导与 [8/8] 的写出循环覆盖，不需要动其它任何地方。
   *
   * 与上游包的区别只在于「谁声明了它」：上游包由 @deepseek-ai/dsh 的
   * dependencies 拉进 installation scope；kxxy-host 是 dsh-app-boot 补丁
   * （patches.mjs 的 patchDshManifest）临时写进那份 manifest 的，效果相同。
   */
  if (existsSync(opts.plugins)) {
    const pluginDirs = readdirSync(opts.plugins).filter((name) =>
      statSync(join(opts.plugins, name)).isDirectory(),
    );
    for (const name of pluginDirs) {
      const count = readPluginFiles(join(opts.plugins, name), asarPart, `lib/node_modules/${name}/`);
      console.log(`      + lib/node_modules/${name}/ （${count} 文件）`);
    }
  }

  const codexPluginFingerprint = stampCodexPlugin(asarPart);
  const codexRuntime = attachCodexRuntime(asarPart, process.env.KXXY_CODEX_RUNTIME_DIR);
  if (!codexRuntime.included) console.warn(`      ! Codex: ${codexRuntime.reason}`);

  const merged = mergeEntries(
    { files: deduped.files, links: deduped.links },
    asarPart,
  );

  /*
   * 缺陷 BH：`DROPPED_LIBS` 的 LINK 形态。
   *
   * `normaliseStageFiles` 只遍历**实体文件**（`deduped.files`），而
   * `lib/liblzma.so` 在 stage 里是符号链接 —— 它被去重降级成
   * `type: "link"`、`target: "lib/liblzma.so.5.8.4"`，于是上面的
   * `DROPPED_LIBS` 分支根本看不见它。真机后果：zip 里仍有
   * `lib/liblzma.so`（0 字节 + `LINK:` 注释），`materialiseLinks` 照样把它
   * 建成软链，`LD_LIBRARY_PATH` 首位命中，`Xzs_Construct` 继续报。
   *
   * 所以必须在这里按**路径**再筛一遍：实体和链接都算。放在 mergeEntries
   * 之后、悬空清扫之前 —— 摘掉这个别名不会让任何别的条目悬空
   * （没有任何东西指向 `lib/liblzma.so`），而悬空清扫会顺带处理万一的级联。
   */
  const droppedLinks = [];
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const e = merged[i];
    if (!DROPPED_LIBS.has(e.path)) continue;
    droppedLinks.push(`${e.path}${e.type === "link" ? ` → ${e.target}` : ""}`);
    merged.splice(i, 1);
  }
  if (droppedLinks.length) {
    console.log(`      遮蔽库清扫：剔除 ${droppedLinks.length} 条（含 LINK 形态）`);
    for (const d of droppedLinks) console.log(`      - ${d}`);
    norm.droppedPaths.push(...droppedLinks.map((d) => d.split(" → ")[0]));
  }

  // office 预览链：wasm 引擎 + 单文件 CJK 字体（见 bundleOfficeAssets 注释）。
  // 必须放在 mergeEntries 之后：它们只进 asarPart，不参与 stage 冲突检查。
  await bundleOfficeAssets(asarPart);

  // Android 打包工具（缺口 B）：`bin/{zipalign,bundletool}` 两个包装器，
  // 外加 zipalign 的 JS 实现与 bundletool 的 fat jar。
  //
  // **位置**：必须在 mergeEntries 之后。两个包装器落在 `bin/`，而 stage 侧
  // 也有 `bin/` 条目 —— 早于 mergeEntries 写入 asarPart 会直接被它的冲突
  // 检查拦下（`stage 与 asar 条目冲突`）。放这里就只进 asarPart，
  // 再被 [8/8] 的写出循环一起收；（若 stage 真有同名条目，上面
  // `deduped` 的摘除循环已经先让它让位）。
  //
  // **落在插件树**：`lib/node_modules/kxxy-host/packaging/` 而不是 `share/`。
  // 包装器第一顺位探测路径就是那里，且插件目录在设备上可写、升级时整体
  // 替换，不会出现「包装器换了、脚本还是旧的」那种半新半旧。
  //
  // 体积代价：zipalign.mjs 约 16 KiB；bundletool-all.jar 32.5 MiB
  // （jar 内部条目本就是 deflate，ZipWriter 按「已压缩」直接 store，不再膨胀）。
  const PACKAGING_DIR = "lib/node_modules/kxxy-host/packaging";
  for (const w of packagingWrappers()) {
    if (asarPart.has(w.path)) throw new Error(`打包工具包装器冲突：${w.path}`);
    asarPart.set(w.path, { data: w.data, mode: w.mode });
    console.log(`      + ${w.path}`);
  }
  {
    const zaSrc = join(PROJECT, "packaging", "zipalign.mjs");
    if (!existsSync(zaSrc)) throw new Error(`缺少 ${zaSrc}（zipalign 的 JS 实现）`);
    asarPart.set(`${PACKAGING_DIR}/zipalign.mjs`, { data: readFileSync(zaSrc), mode: 0o644 });
    console.log(`      + ${PACKAGING_DIR}/zipalign.mjs`);

    const btSrc = join(PROJECT, ".cache", "bundletool-all.jar");
    if (!existsSync(btSrc)) {
      // 缺 jar 不该让整个构建失败（允许离线/无网环境构建其余部分），
      // 但必须显式喊出来 —— 否则设备上 `bundletool` 会在运行时 127 退出。
      console.warn(
        `      ! 跳过 bundletool：${btSrc} 不存在。抓取命令：curl -L -o .cache/bundletool-all.jar ` +
          `https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar`,
      );
    } else {
      asarPart.set(`${PACKAGING_DIR}/bundletool-all.jar`, {
        data: readFileSync(btSrc),
        mode: 0o644,
      });
      console.log(
        `      + ${PACKAGING_DIR}/bundletool-all.jar（${(statSync(btSrc).size / 1048576).toFixed(1)} MiB）`,
      );
    }
  }

  // 打包工具包装器的版本标记（锚点 15，见 PACKAGING_MARKER 注释）。
  //
  // 写在 PACKAGING_DIR 下而不是 kxxy-host 根：那一整棵目录在设备上由
  // 包装器自己的第一顺位探测路径命中，标记跟着走能保证「包装器换了、
  // 标记也换了」——分开放会出现「标记递增了、包装器还是旧的」的半新半旧。
  if (asarPart.has(PACKAGING_MARKER_FILE)) {
    throw new Error(`打包工具标记与既有条目冲突：${PACKAGING_MARKER_FILE}`);
  }
  asarPart.set(PACKAGING_MARKER_FILE, {
    data: Buffer.from(`${PACKAGING_MARKER}\n`, "utf8"),
    mode: 0o644,
  });
  console.log(`      + ${PACKAGING_MARKER_FILE}（${PACKAGING_MARKER}）`);

  // 移动端 UI 插件（第三方 dsh-web-mobile，见 bundleMobilePlugin 注释）。
  await bundleMobilePlugin(asarPart);

  // Tesseract 简体中文语言包（见 bundleTessdata 注释）。
  await bundleTessdata(asarPart);

  // TeX Live 宏包树（见 bundleTexliveMacros 注释）。
  await bundleTexliveMacros(asarPart);

  // 带 resources.arsc 的 android.jar（见 prepareAndroidJar 注释）。
  // jar 本体在 [0/8] 就算好了（那时堆最干净），这里只挂进 merged。
  attachAndroidJar(merged, asarPart, jarCache);

  /*
   * 补丁集版本标记（锚点 11）。
   *
   * 上面那十条锚点探的全是自有资产，而补丁改的是上游文件（documentpreview 的
   * client.js / client.pdf.js、libreoffice-kit、dsh-office-to-pdf …）—— 它们
   * 没有任何可探的版本标记。真机事故：补了 zip / epub provider、重建 APK 装机后
   * `grep -c kxxyArchiveApply` 仍是 0，logcat 只有 `runtime already installed and
   * complete`：前十个锚点全通过，isComplete() 判真，补丁根本没解出来。
   *
   * 标记写进 kxxy-host 目录（那是自有插件的地盘，不与上游文件抢路径）。
   */
  const patchsetPath = PATCHSET_MARKER_FILE;
  if (asarPart.has(patchsetPath)) throw new Error(`补丁集标记与既有条目冲突：${patchsetPath}`);
  asarPart.set(patchsetPath, {
    data: Buffer.from(`${PATCHSET_MARKER}\n`, "utf8"),
    mode: 0o644,
  });
  console.log(`      + ${patchsetPath}（${PATCHSET_MARKER}）`);

  /*
   * 宿主插件指纹。
   *
   * **位置很关键**：必须放在插件树所有 `asarPart.set()` 都做完之后 —— 它在
   * L1593 那一轮 readPluginFiles 里铺进去，之后又被 packaging 包装器（含
   * 32.5 MiB 的 bundletool jar）、office 资产、tessdata、TeX 宏包树、patchset
   * 标记各补了几条。早一步算，指纹就漏掉那些条目，「换了打包工具/宏包树却不
   * 重装」的坑原样回来；而它又必须早于下面的 `collectDirs` 与写出循环，否则
   * `lib/.fingerprint` 这个新条目不会进 zip。
   */
  const hostPluginFingerprint = stampHostPluginFingerprint(asarPart);
  const pythonRepairFiles = new Map(pythonDependencies.files);
  for (const name of PYTHON_HOST_FILES) {
    const path = `lib/node_modules/kxxy-host/${name}`;
    const file = asarPart.get(path);
    if (!file) throw new Error(`Python 自检文件缺失：${path}`);
    pythonRepairFiles.set(path, file);
  }
  verifyPythonRuntime(
    [...new Set([...pythonStageEntries.keys(), ...pythonStageLinks.keys(), ...pythonDependencies.files.keys()])],
    (path) => pythonDependencies.files.get(path)?.data ?? readPythonStage(path),
  );

  /*
   * 悬空 LINK 清扫。
   *
   * 剔除了 Termux 应用脚本与死解释器脚本之后，指向它们的符号链接会变成
   * 悬空别名 —— 例如 `bin/xdg-open → bin/termux-open`（termux-open 在
   * TERMUX_APP_SCRIPTS 里）、`bin/termux-apps-info-*.bash → bin/termux-apps-info-*`
   * （`.bash` 变体没进剔除清单，本体进了）。这些别名若写进 zip，
   * RuntimeInstaller.materialiseLinks 会在设备上**静默跳过**它们
   * （目标不存在），结果是安装目录里少几个文件却没有任何日志 ——
   * 与其如此，不如在构建期就一致地剔除，并把它计入 removedPaths。
   *
   * 迭代到不动点：别名也可能指向另一个别名（stage 里 `bin/sh → bin/dash`
   * 这种两级链），目标被剔除后需要级联清理。
   */
  const present = new Set(merged.filter((e) => e.type === "file").map((e) => e.path));
  for (const key of asarPart.keys()) present.add(key);
  const dangling = [];
  for (let round = 0; round < 8; round += 1) {
    const bad = merged.filter((e) => e.type === "link" && !present.has(e.target));
    if (bad.length === 0) break;
    for (const e of bad) {
      dangling.push(`${e.path} → ${e.target}`);
      const i = merged.indexOf(e);
      if (i >= 0) merged.splice(i, 1);
    }
  }
  if (dangling.length) {
    console.log(`      悬空 LINK 清扫：剔除 ${dangling.length} 条（目标已被剔除）`);
    for (const d of dangling) console.log(`      - ${d}`);
    norm.droppedPaths.push(...dangling.map((d) => d.split(" → ")[0]));
  }

  // mergeEntries 只回 stage 侧条目（asar 侧由本脚本单独写出），所以目录集合
  // 必须两侧合并推导，否则 asar 的 bin/ 目录不会被显式建出来。
  const dirs = collectDirs([...merged, ...[...asarPart.keys()].map((path) => ({ path }))]);

  let totalBytes = 0;
  for (const e of deduped.files) totalBytes += e.size ?? (e.data ? e.data.length : 0);
  for (const v of asarPart.values()) totalBytes += v.data.length;

  console.log(
    `[7/8] 合并：目录 ${dirs.length}，文件 ${deduped.files.length + asarPart.size}，` +
      `LINK ${merged.filter((e) => e.type === "link").length}，未压缩合计 ${human(totalBytes)}`,
  );

  // ---------------------------------------------------------------- 写出
  mkdirSync(dirname(opts.out), { recursive: true });

  /*
   * 把 `asarPart` 里的大块内存条目先落到临时文件（缺陷 CQ 连带修复）。
   *
   * ── 为什么必须这么做（构建事故）────────────────────────────────────────────
   *
   * `asarPart` 在 [6.5]–[6.8] 阶段累积了 342 MB **常驻内存**的数据：
   * TeX 宏包树 171 MB、wasm 引擎 45 MB、两份 CJK 字体各 10 MB，还有若干。
   * 写出阶段每条还要再生成一份压缩输出，瞬时就是「342 MB 常驻 + 单条压缩
   * 输出」，而整机提交内存只剩约 1.2 GB（8 GB 物理 + 8 GB 页面文件，其中
   * 约 9 GB 被内核池/驱动占掉）。实测直接死在
   *
   *     RangeError: Failed to allocate memory
   *       at createUnsafeBuffer (node:internal/buffer:1113:25)
   *       at Buffer.concat (node:internal/buffer:672:18)
   *       at DeflateRaw.<anonymous> (tools/lib/zipwrite.mjs:122:20)
   *
   * 落盘后，写出循环对它们改走 `addFile()`（4 MiB 分块读），常驻内存里就
   * 只剩「目录条目 + 小文本」，峰值降到几十 MB。
   *
   * **为什么是「一个 spill 文件 + 偏移」而不是每条一个临时文件**：TeX 宏包树
   * 有 13,669 个文件、wasm 49 个、插件 209 个 …… 逐个 `writeFileSync` 会产生
   * 上万次 open/close（在 Windows 上尤其慢，实测能拖到十几分钟）。放进同一个
   * 文件只需一次 `open`，用 `writeSync` 顺序追加，每个条目记下 `offset/size`，
   * 读的时候 `readSync(..., offset)` 定位即可。代价只是多存两个数字。
   *
   * 临时文件放在 `.cache/` 下（与产物同盘，避免 EXDEV），结束时删除。
   */
  const spillPath = join(PROJECT, ".cache", "runtime-spill.bin");
  dropSpill(spillPath);
  let spilled = 0;
  let spillBytes = 0;
  {
    const sfd = openSync(spillPath, "w");
    try {
      let offset = 0;
      for (const [path, v] of asarPart) {
        if (!v.data || v.data.length === 0) continue;
        writeSync(sfd, v.data, 0, v.data.length, offset);
        asarPart.set(path, { spill: spillPath, offset, size: v.data.length, mode: v.mode });
        offset += v.data.length;
        spilled += 1;
        spillBytes += v.data.length;
      }
    } finally {
      closeSync(sfd);
    }
  }
  if (spilled > 0) {
    console.log(
      `      asar 侧 ${spilled} 条落盘 ${human(spillBytes)}（写出阶段分块读，峰值降下来）`,
    );
    /*
     * 落盘后立刻把那份内存副本从 `asarPart` 里摘掉（缺陷 CT 连带修复）。
     *
     * 上面只是把数据**写进** spill 文件、再把条目换成 `{spill, offset, size}`，
     * 但 `spilled` 那份旧 `v.data` 仍然被局部变量/闭包之外的东西短暂引用着，
     * 且 V8 在大 Buffer 上倾向于「先留后收」—— 542 MiB 的垃圾要等一次显式
     * 全量 GC 才真正归还。这台构建机的提交上限只有 16.2 GB（8 GB 物理 +
     * 8 GB 页面文件，其中约 9 GB 被内核池占掉），空闲常在 1 GB 上下，于是
     * 写出阶段第一条大条目就死在
     *
     *     RangeError: Failed to allocate memory
     *       at createUnsafeBuffer (node:internal/buffer:1113:25)
     *       at readRange (tools/lib/zipwrite.mjs:164:22)
     *
     * 有 `--expose-gc` 时主动收一次；没有也不能因此失败（收不掉只是慢，
     * 不是错）。
     */
    if (typeof global.gc === "function") global.gc();
  }

  // 用同步 fd 而非 createWriteStream：ZipWriter 的 sink 是同步回调，
  // 且 259 MiB 的产物若先攒在用户态再 end()，statSync 会抢在 flush 之前跑。
  const fd = openSync(opts.out, "w");
  /*
   * 边写边算 sha256（缺陷 DP 的配套：APK 侧要知道「这一份 runtime 是什么」）。
   *
   * 为什么不在写完之后整份读一遍：runtime.zip 有 713 MiB，重读一次要多吃
   * 一次磁盘 IO 与一个 713 MiB 的读句柄，在这台提交内存常年只剩 1 GB 上下的
   * 构建机上是实打实的风险。ZipWriter 的 sink 本来就是同步回调，顺手 update
   * 一次，额外代价只有一次哈希（约 1 秒，不占额外内存）。
   */
  const zipDigest = createHash("sha256");
  const zip = new ZipWriter((buf) => {
    zipDigest.update(buf);
    writeSync(fd, buf);
  }, { allowZip64Count: true });

  /*
   * 写出循环里的周期性 GC（缺陷 CT 连带修复）。
   *
   * ── 先说结论：它不是真正的修法 ────────────────────────────────────────
   * 私有内存爬到 1,456 MB 的根因是 `zipwrite.mjs` 用**池化 Buffer** 存了
   * 5 万多条文件名/注释（每条约 8 KB 的 pool 被长期钉住），那已在
   * `ZipWriter.#addInternal` 里用 `Buffer.allocUnsafeSlow` 修掉（实测
   * 3 万条 ext 从 627 MB 降到 11 MB）。这段 GC 保留下来是因为它**廉价且
   * 无害**：`addFile` 对 142 MB 的 `lib/jvm/.../modules` 走分块流式压缩，
   * 每条仍会留下压缩输出与 zlib 内部缓冲，在这台提交内存只剩 1 GB 上下的
   * 机器上，主动收一次能让峰值更平坦。没有 `--expose-gc` 时静默跳过。
   *
   * ── 当时的症状（留作记录）──────────────────────────────────────────────
   *     RangeError: Failed to allocate memory
   *       at createUnsafeBuffer (node:internal/buffer:1113:25)
   *       at createPool (node:buffer:181:17)
   *       at DeflateRaw.ZlibBase (node:zlib:274:28)
   *       at #addInternal (tools/lib/zipwrite.mjs:305:26)
   *
   * 栈顶是 **zlib 建池**而不是 JS 堆满，所以 `--max-old-space-size`
   * 调多大都没用（与 `zipwrite.mjs` 里 `Z_MEM_ERROR` 那条注释同一个道理）。
   */
  const gcEvery = typeof global.gc === "function" ? 400 : 0;
  let gcCountdown = gcEvery;
  const maybeGc = () => {
    if (gcEvery === 0) return;
    if (--gcCountdown > 0) return;
    gcCountdown = gcEvery;
    global.gc();
  };

  for (const d of dirs) await zip.add(`${d}/`, Buffer.alloc(0), { mode: 0o755 });

  // 目录条目也要计入：中央目录里它们是真实条目（`method=store`、size 0），
  // 漏掉会让日志与 verify-runtime.mjs 的 EOCD 计数对不上（12413 vs 14800）。
  let written = dirs.length;

  for (const e of deduped.files) {
    /*
     * 磁盘 blob 一律走 `addFile`（分块读 + 分块压），**绝不整份 readFileSync**。
     *
     * 这里踩过两次真坑，症状不同但根因同一个（提交内存只剩 0.9 GB）：
     *   ① 直接把 `readFileSync` 的结果传给 `add()`：
     *        RangeError: Failed to allocate memory
     *          at tryCreateBuffer (node:fs:402:21)
     *          at readFileSync (node:fs:500:14)
     *      最大的 `lib/jvm/.../modules` 是 142 MB，读进来后还要再生成一份压缩
     *      输出，瞬时就是 142 + 45 MB。
     *   ② 只把它改成「逐条读、读完置 null」还不够 —— V8 不会立刻回收，
     *      下一条 133 MB 的 `libLLVM.so` 进来时上一条可能仍在。
     *
     * `addFile` 按 4 MiB 分块 `read`，同一块既更新 crc 又喂给同一个 deflate
     * 流，全程不持有原始大 Buffer；峰值 = 一块 + 压缩输出。
     * 已归一化脚本走内存条目（`e.data`），它们都 ≤ 64 KiB，直接 `add` 即可。
     */
    if (e.data) {
      await zip.add(e.path, e.data, { mode: e.mode ?? 0o644, level: 6 });
    } else {
      await zip.addFile(
        e.path,
        join(part.stage.blobRoot, e.blob.slice(0, 2), e.blob),
        e.size ?? statSync(join(part.stage.blobRoot, e.blob.slice(0, 2), e.blob)).size,
        { mode: e.mode ?? 0o644, level: 6 },
      );
    }
    written += 1;
    maybeGc();
  }
  for (const e of merged) {
    if (e.type !== "link") continue;
    // 别名条目：数据区留空，中央目录注释记下本体路径。
    await zip.add(e.path, Buffer.alloc(0), { mode: e.mode ?? 0o755, comment: `LINK:${e.target}` });
    written += 1;
  }
  for (const [path, v] of asarPart) {
    // 上面已把全部内容追加进同一个 spill 文件，这里按区间分块读；
    // 只有空条目（大小为 0）仍走内存（Buffer.alloc(0)）。
    if (v.spill) {
      await zip.addSlice(path, v.spill, v.offset, v.size, { mode: v.mode ?? 0o644, level: 6 });
    } else {
      await zip.add(path, v.data ?? Buffer.alloc(0), { mode: v.mode ?? 0o644, level: 6 });
    }
    written += 1;
    maybeGc();
  }

  // 运行时自述，App 侧据此做版本与占位符校验。
  //
  // `placeholderPaths` 是**必须**做替换的文件清单：App 侧若用 ZipInputStream
  // 流式解压，无法在解压时就知道该文件要不要改；给出清单后可以只对这些
  // 路径做一次定点重写（161 个文件，远少于全量 12,412 条）。
  // `entries` 是 zip 中央目录的**总条目数**（目录 + 文件 + LINK + 本 manifest），
  // 与 verify-runtime.mjs 读 EOCD 得到的数字应当一致 —— 这是校验脚本
  // 判断「产物是否被截断」的依据。`written` 此刻还没算上 manifest 自己，
  // 所以 +1。
  const manifest = {
    schemaVersion: 2,
    runtimeVersion: "v0.1.0-arm64",
    rootPlaceholder: ROOT_PLACEHOLDER,
    termuxPrefix: TERMUX_PREFIX,
    arch: "aarch64",
    pythonRuntimeRevision: PYTHON_REVISION,
    node: "24.18.0",
    entries: written + 1,
    directories: dirs.length,
    linkEntries: merged.filter((e) => e.type === "link").length,
    placeholderPaths: norm.placeholderPaths,
    removedPaths: norm.droppedPaths,
    builtAt: new Date().toISOString(),
    /*
     * 插件指纹（schemaVersion 2 新增）。
     *
     * 引擎侧（kxxy-host 的 `/kxxy/api/state`）与 diag.json 都要报这个值，
     * 用来回答「设备上这份插件到底是什么」。选它而不是让引擎去读自己的
     * `.fingerprint` 文件，是为了让「运行期读到的值」只有一个来源。
     */
    plugins: {
      hostFingerprint: hostPluginFingerprint,
      hostMarker: `kxxy-host@${hostPluginFingerprint.slice(0, 12)}`,
      mobileMarker: MOBILE_PLUGIN_MARKER,
      codexFingerprint: codexPluginFingerprint,
      codexRuntime,
    },
  };
  const runtimeManifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await zip.add("kxxy-runtime.json", runtimeManifestBytes, { mode: 0o644 });
  pythonRepairFiles.set("kxxy-runtime.json", { data: runtimeManifestBytes, mode: 0o644 });
  written += 1;

  // 别名清单（缺陷 DD）：`<别名>\t<本体>` 每行一条，单独一份小资产。
  //
  // **为什么不能只放 manifest 里**：App 侧快路径（`isComplete()` 判真）需要
  // 知道「哪些路径是别名」才能把老设备上已经复制成实体的别名改回软链，而
  // 拿这份信息的唯一途径是 zip 中央目录的 entry comment —— `ZipFile` 只吃
  // 文件路径，`ZipInputStream` 读不到 comment，于是得先把 700 MiB 的
  // runtime.zip 拷到 cacheDir 才能读。每次启动拷 700 MiB 不可接受。
  //
  // 独立资产只有几十 KB，`assets.open()` 一次读完。构建期与 zip 同时产出，
  // 两者由同一次 `merged` 计算得来，不会漂移。
  const aliasLines = merged
    .filter((e) => e.type === "link")
    .map((e) => `${e.path}\t${e.target}`)
    .join("\n");
  const aliasOut = join(dirname(opts.out), "alias-links.txt");
  writeFileSync(aliasOut, aliasLines.length > 0 ? `${aliasLines}\n` : "", "utf8");
  console.log(`      别名清单 → ${aliasOut}（${merged.filter((e) => e.type === "link").length} 条）`);

  zip.finish();
  closeSync(fd);

  // 落盘的临时副本用完即清（同盘，见上面的 spill 注释）。
  dropSpill(spillPath);

  const stats = statSync(opts.out);
  const runtimeSha256 = zipDigest.digest("hex");
  console.log(`[8/8] 写出 ${opts.out}`);
  console.log(`      条目 ${written}，zip ${human(stats.size)}（未压缩 ${human(totalBytes)}）`);
  console.log(`      sha256 ${runtimeSha256}`);

  /*
   * 构建清单（缺陷 DP 的收口）。
   *
   * 落两处，缺一不可：
   *   · `android/app/src/main/assets/meta/build.json` —— **原生探针的期望值来源**。
   *     探针要回答「APK 换了、设备上插件没换」，而设备上那份旧的 build.json
   *     就在旧 runtime 里、跟着旧插件一起躺着，读它等于让嫌疑人自证清白。
   *     期望值只能来自 APK 本体，所以必须进 assets（几 KB，aapt2 正常打包）。
   *   · `.cache/build-meta.json` —— 构建机与人看的副本，被 build-apk.ps1 打日志用。
   *
   * 键名保持**扁平**：gradle 侧用一条 `"key": "value"` 正则取值，不引 JSON 解析
   * （build.gradle.kts 里没有 JSON 库，且配置阶段不该为了 6 个字段去加依赖）。
   */
  const pythonRepair = await createPythonRepairAssets(opts.pythonRepairAssets, pythonRepairFiles, {
    baseHostFingerprint: hostPluginFingerprint, hostFingerprint: hostPluginFingerprint,
  });
  const buildMeta = {
    schema: 1,
    pythonRuntimeRevision: PYTHON_REVISION,
    pythonRepairManifestSha256: pythonRepair.manifestSha256,
    generatedAt: new Date().toISOString(),
    runtimeSha256,
    runtimeSize: stats.size,
    runtimeEntries: written,
    runtimeUncompressedBytes: totalBytes,
    kxxyHostFingerprint: hostPluginFingerprint,
    kxxyHostMarker: `kxxy-host@${hostPluginFingerprint.slice(0, 12)}`,
    dshWebMobileMarker: MOBILE_PLUGIN_MARKER,
    codexPluginFingerprint,
    codexRuntimeIncluded: codexRuntime.included,
    codexRuntimeVersion: codexRuntime.version,
    codexRuntimeExecutionMode: codexRuntime.executionMode ?? null,
    codexRuntimeAppServerVerified: codexRuntime.appServerVerified === true,
    nodeVersion: manifest.node,
    repoUrl: readRepoUrl(),
  };
  const buildMetaJson = `${JSON.stringify(buildMeta, null, 2)}\n`;
  writeFileSync(join(PROJECT, ".cache", "build-meta.json"), buildMetaJson, "utf8");
  const assetsMetaDir = join(PROJECT, "android", "app", "src", "main", "assets", "meta");
  mkdirSync(assetsMetaDir, { recursive: true });
  writeFileSync(join(assetsMetaDir, "build.json"), buildMetaJson, "utf8");
  console.log(`      构建清单 → assets/meta/build.json + .cache/build-meta.json`);

  if (opts.manifest) {
    writeFileSync(opts.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`      manifest → ${opts.manifest}`);
  }
}

main();
