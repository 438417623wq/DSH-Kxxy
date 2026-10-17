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
 *   → applyAllPatches               10 个补丁作用在 lib/node_modules 上
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
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
import { ZipWriter } from "./lib/zipwrite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "..");

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
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--stage") opts.stage = resolve(argv[++i]);
    else if (a === "--asar") opts.asar = resolve(argv[++i]);
    else if (a === "--out") opts.out = resolve(argv[++i]);
    else if (a === "--manifest") opts.manifest = resolve(argv[++i]);
    else if (a === "--plugins") opts.plugins = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log("用法：node tools/build-runtime.mjs [--stage <dir>] [--asar <app.asar>] [--out <zip>]");
      process.exit(0);
    } else throw new Error(`未知参数：${a}`);
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
 * 生成 corepack 包装器 `bin/{pnpm,npm,npx}`。
 *
 * 为什么需要：Termux 的 nodejs-lts 只装 corepack 本体，不提供这三个 shim
 * （实测 `bin/{pnpm,npm,npx}` 全部不存在，只有 `lib/node_modules/corepack/shims/*`）。
 * 而 shims 目录里的脚本 shebang 指向 Termux 路径且依赖 `termux-exec`，
 * 与其修补不如重写三个 8 行的 wrapper。
 *
 * shebang 固定 `/system/bin/sh`：Android 必然存在，且是 app 私有路径之外的
 * 唯一稳定解释器，因此**不需要**参与 `@DSH_ROOT@` 占位符替换。
 */
function corepackWrappers() {
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

  return [
    { path: "bin/pnpm", data: mk("pnpm.js"), mode: 0o755 },
    { path: "bin/npm", data: mk("npm.js"), mode: 0o755 },
    { path: "bin/npx", data: mk("npx.js"), mode: 0o755 },
  ];
}

/**
 * 从官方主题模块抽取全部 token 定义块，生成 `plugins/kxxy-host/web/theme.css`。
 *
 * 为什么这么做（二轮问题 ② 的 B 方案）：宿主管理页过去用一套手造色板，和官方
 * 对话界面（dsh-client-ui-theme 的 neutral-bluish + deepseek 色板）肉眼可见不一致。
 * 让 host.css 直接消费官方的 `--dsw-alias-*` / `--dsw-static-*` 变量、把定义块
 * 原样搬过来 —— 官方以后调色，重跑构建自动跟齐，管理页永远和对话页同源。
 *
 * 抽取分两步（该模块把 CSS 存成 JS 双引号字符串常量，直接按花括号扫会把 JS
 * 代码块也抓进来）：
 *   1. 收集所有含 `--dsw-` 的双引号字符串字面量 → 得到纯 CSS 片段；
 *   2. 解析 selector{block}，只保留**定义了** token 的块（`--dsw-x:` 形态）。
 *      组件样式块（如 `.v01cdW_group{color:var(--dsw-alias-…)}`）只引用不定义，
 *      会被 var() 后无冒号这条判据自然剔除。重复块去重。
 */
function extractOfficialTheme(asarFiles) {
  const entry = asarFiles.get(
    "lib/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js",
  );
  if (!entry) {
    console.log("      ⚠️ dsh-client-theme 不在闭包内，跳过 theme.css 生成");
    return;
  }
  const js = entry.data.toString("utf8");

  const fragments = [];
  for (const m of js.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const s = m[1];
    if (s.includes("--dsw-alias-") || s.includes("--dsw-static-")) fragments.push(s);
  }
  if (fragments.length === 0) {
    console.log("      ⚠️ 主题模块里没有 --dsw token 字符串，跳过 theme.css 生成");
    return;
  }

  const cssAll = fragments.join("\n");
  const blocks = [];
  const seen = new Set();
  for (const m of cssAll.matchAll(/([^{}]{1,300})\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    const body = m[2];
    if (!/--dsw-(?:alias|static)-[\w-]+\s*:/.test(body)) continue;
    const block = `${selector}{${body}}`;
    if (seen.has(block)) continue;
    seen.add(block);
    blocks.push(block);
  }
  if (blocks.length === 0) {
    console.log("      ⚠️ 未解析出 token 定义块，跳过 theme.css 生成");
    return;
  }
  const header =
    "/*\n" +
    " * 官方主题 token（构建期从 @deepseek-ai/dsh-client-ui-theme/lib/client.js 自动抽取）。\n" +
    " * 请勿手改 —— 改了也会被下次构建覆盖；要调样式请改 host.css 里对变量的引用。\n" +
    " */\n";
  const css = header + blocks.join("\n") + "\n";
  writeFileSync(join(PROJECT, "plugins", "kxxy-host", "web", "theme.css"), css, "utf8");
  console.log(`      ✓ theme.css：抽取 ${blocks.length} 个 token 块（${css.length} 字节）`);
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

const WASM_PKG = {
  url: "https://registry.npmmirror.com/@deepseek-ai/libreoffice-kit-wasm/-/libreoffice-kit-wasm-0.1.1.tgz",
  file: "libreoffice-kit-wasm-0.1.1.tgz",
  sha256: "95f1d8ef29a2bc13bd1939fb4ae121fc2ae95324ba63964b2544d91039ceea8a",
  zipBase: "lib/node_modules/@deepseek-ai/libreoffice-kit-wasm/",
};

const FONT_PKG = {
  url: "https://registry.npmmirror.com/@expo-google-fonts/noto-sans-sc/-/noto-sans-sc-0.4.4.tgz",
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
const OFFICE_FONTS_MARKER = "kxxy-office@1";
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
 */
const PATCHSET_MARKER = "kxxy-patchset@2";
const PATCHSET_MARKER_FILE = "lib/node_modules/kxxy-host/patchset.version";

/**
 * 移动端 UI 插件（第三方 dsh-web-mobile）的构建期来源。
 *
 * 为什么内置而不让用户自己装：插件市场那条路要求 profile 目录能跑 pnpm 联网
 * 安装，而设备上的引擎是离线装配的（`lib/node_modules` 全部来自 runtime.zip），
 * profile 的 `package.json` 里 `dependencies` 是空对象。内置 = 构建期把它塞进
 * `lib/node_modules/`，与 kxxy-host 同一条路。
 *
 * 版本锁 3.1.0：客户端半区是按 dsh 0.2.0-rc.2 的插槽契约写的，升级宿主或升级
 * 插件都必须重跑真机验收（它的 `dsh.client.inject` 名单里有 8 个官方客户端包，
 * 任何一个改名都会让整条 entry 激活失败 ⇒ 白屏）。
 */
const MOBILE_PLUGIN_PKG = {
  url: "https://registry.npmmirror.com/dsh-web-mobile/-/dsh-web-mobile-3.1.0.tgz",
  file: "dsh-web-mobile-3.1.0.tgz",
  sha256: "6881c6d0d806606765c4700b8c1797211f1522be17372ea07182799363a640fb",
  zipBase: "lib/node_modules/dsh-web-mobile/",
};

/**
 * 移动端插件的版本标记（锚点 10 的判据），与
 * `RuntimeInstaller.MOBILE_PLUGIN_MARKER` 逐字一致。
 *
 * 为什么不直接探 package.json 里的 `"version": "3.1.0"`：那样标记就与包版本
 * 绑死了，而我们需要的是「构建脚本认为的插件资产变了」这个信号 —— 换包版本、
 * 改裁剪清单、甚至只换 tarball 来源都该让设备重装一次。
 */
const MOBILE_PLUGIN_MARKER = "kxxy-mobile-plugin@1";
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
const TEXLIVE_MARKER = "kxxy-texlive@2";
const TEXLIVE_MARKER_FILE = "lib/node_modules/kxxy-host/texlive.version";

/** 下载（带缓存与 sha256 校验）并解开一个 npm tarball。 */
async function fetchTgz(pkg) {
  const dest = join(OFFICE_CACHE, pkg.file);
  const state = await downloadTo(pkg.url, dest);
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

/**
 * 把 LibreOffice wasm 引擎与单文件 CJK 字体塞进 asarPart。
 *
 * 为什么不能走 `readPluginFiles` / 依赖树：wasm 包的 `package.json` 声明了
 * `"os": ["linux"]`，会被 assemble.mjs 的 isPlatformSpecific 直接排除；
 * 而它恰恰是安卓上唯一可用的 office 后端（原生 LOK 没有 android 目标）。
 */
async function bundleOfficeAssets(asarPart) {
  console.log("[6.5/8] 打包 LibreOffice wasm 引擎与 CJK 字体");

  const wasm = await fetchTgz(WASM_PKG);
  let wasmCount = 0;
  for (const e of wasm) {
    if (e.type !== "0") continue;
    if (!e.path.startsWith("package/")) continue;
    const rel = e.path.slice("package/".length);
    if (rel === "package.json") continue; // 由下面的改写版覆盖
    const zipPath = WASM_PKG.zipBase + rel;
    if (asarPart.has(zipPath)) throw new Error(`wasm 引擎条目与既有条目冲突：${zipPath}`);
    asarPart.set(zipPath, { data: e.data, mode: 0o644 });
    wasmCount += 1;
  }

  /*
   * `package.json` 必须**改写**：上游声明 `"os": ["linux"]`，而 libreoffice-kit
   * 在 resolveEngine 里读它做 `pkg.name` / `pkg.version` 校验。os 字段对
   * Node 的 require.resolve 有实际影响（不是纯元数据），安卓上会抛
   * EBADPLATFORM，所以只保留校验真正需要的字段。
   */
  const pkgEntry = wasm.find((e) => e.path === "package/package.json");
  if (!pkgEntry) throw new Error("wasm 引擎包里找不到 package.json");
  const pkgJson = JSON.parse(pkgEntry.data.toString("utf8"));
  if (pkgJson.name !== "@deepseek-ai/libreoffice-kit-wasm" || pkgJson.version !== "0.1.1") {
    throw new Error(`wasm 引擎包版本漂移：${pkgJson.name}@${pkgJson.version}，补丁与常量按 0.1.1 写死`);
  }
  delete pkgJson.os;
  delete pkgJson.cpu;
  delete pkgJson.libc;
  asarPart.set(
    `${WASM_PKG.zipBase}package.json`,
    { data: Buffer.from(`${JSON.stringify(pkgJson, null, "\t")}\n`, "utf8"), mode: 0o644 },
  );
  wasmCount += 1;
  console.log(`      + ${WASM_PKG.zipBase}（${wasmCount} 文件，os 字段已剥离）`);

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

  /*
   * 版本标记文件（锚点 10 的判据）。
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(join(opts.stage, "entries.json"))) {
    throw new Error(`stage 不存在或不完整：${opts.stage}（缺 entries.json）`);
  }
  if (!existsSync(opts.asar)) {
    throw new Error(`asar 不存在：${opts.asar}`);
  }

  // ---------------------------------------------------------------- stage 侧
  console.log(`[1/8] 读 stage ${opts.stage}`);
  const part = collectStage(opts.stage);
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
  const asarPart = new Map(asarFiles);
  for (const w of corepackWrappers()) {
    if (asarPart.has(w.path)) throw new Error(`corepack 包装器与既有条目冲突：${w.path}`);
    asarPart.set(w.path, { data: w.data, mode: w.mode });
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

  const merged = mergeEntries(
    { files: deduped.files, links: deduped.links },
    asarPart,
  );

  // office 预览链：wasm 引擎 + 单文件 CJK 字体（见 bundleOfficeAssets 注释）。
  // 必须放在 mergeEntries 之后：它们只进 asarPart，不参与 stage 冲突检查。
  await bundleOfficeAssets(asarPart);

  // 移动端 UI 插件（第三方 dsh-web-mobile，见 bundleMobilePlugin 注释）。
  await bundleMobilePlugin(asarPart);

  // Tesseract 简体中文语言包（见 bundleTessdata 注释）。
  await bundleTessdata(asarPart);

  // TeX Live 宏包树（见 bundleTexliveMacros 注释）。
  await bundleTexliveMacros(asarPart);

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
  // 用同步 fd 而非 createWriteStream：ZipWriter 的 sink 是同步回调，
  // 且 259 MiB 的产物若先攒在用户态再 end()，statSync 会抢在 flush 之前跑。
  const fd = openSync(opts.out, "w");
  const zip = new ZipWriter((buf) => writeSync(fd, buf));

  for (const d of dirs) zip.add(`${d}/`, Buffer.alloc(0), { mode: 0o755 });

  // 目录条目也要计入：中央目录里它们是真实条目（`method=store`、size 0），
  // 漏掉会让日志与 verify-runtime.mjs 的 EOCD 计数对不上（12413 vs 14800）。
  let written = dirs.length;
  const emitFile = (path, data, mode) => {
    zip.add(path, data, { mode, level: 6 });
    written += 1;
  };

  for (const e of deduped.files) {
    const data = e.data ?? readFileSync(join(part.stage.blobRoot, e.blob.slice(0, 2), e.blob));
    emitFile(e.path, data, e.mode ?? 0o644);
  }
  for (const e of merged) {
    if (e.type !== "link") continue;
    // 别名条目：数据区留空，中央目录注释记下本体路径。
    zip.add(e.path, Buffer.alloc(0), { mode: e.mode ?? 0o755, comment: `LINK:${e.target}` });
    written += 1;
  }
  for (const [path, v] of asarPart) emitFile(path, v.data, v.mode ?? 0o644);

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
    schemaVersion: 1,
    runtimeVersion: "v0.1.0-arm64",
    rootPlaceholder: ROOT_PLACEHOLDER,
    termuxPrefix: TERMUX_PREFIX,
    arch: "aarch64",
    node: "24.18.0",
    entries: written + 1,
    directories: dirs.length,
    linkEntries: merged.filter((e) => e.type === "link").length,
    placeholderPaths: norm.placeholderPaths,
    removedPaths: norm.droppedPaths,
    builtAt: new Date().toISOString(),
  };
  zip.add("kxxy-runtime.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"), { mode: 0o644 });
  written += 1;

  zip.finish();
  closeSync(fd);

  const stats = statSync(opts.out);
  console.log(`[8/8] 写出 ${opts.out}`);
  console.log(`      条目 ${written}，zip ${human(stats.size)}（未压缩 ${human(totalBytes)}）`);

  if (opts.manifest) {
    writeFileSync(opts.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`      manifest → ${opts.manifest}`);
  }
}

main();
