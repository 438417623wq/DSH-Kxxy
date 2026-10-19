/**
 * 在主机上模拟 `RuntimeInstaller.kt` 的安装管线，对真实的 runtime.zip 做端到端断言。
 *
 * 为什么需要这个脚本：verify-runtime.mjs 只看 zip 的**结构**（条目数、LINK 注释、
 * 占位符是否写对），它不回答「照 RuntimeInstaller 的步骤走一遍之后，设备上会不会
 * 真的长出一棵能启动的树」。而 RuntimeInstaller 的每一步都有事故背书
 * （SONAME 别名两阶段、占位符定点重写、exec 位恢复、kxxy-host 完整性锚点），
 * 任何一步在真机上失效都只在 logcat 里留一行日志。
 *
 * 本脚本按 RuntimeInstaller 的**精确顺序**复刻（见该文件 :65-95）：
 *   readZipIndex → extract（跳过 LINK）→ materialiseLinks → rewriteRootPlaceholder
 *   → materialiseSonameAliases → restoreExecBits → isComplete（十一锚点，含兼容层、PTY 绑定、宿主插件、移动端适配层、office 资产与构建期补丁集的版本标记）
 *
 * 用法：node tools/simulate-install.mjs [zip 路径] [目标目录]
 * 默认目标目录：<系统临时目录>/kxxy-sim-install（每次运行前清空）
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

/** 本脚本所在目录（`tools/`）。静态检查 Kotlin 源码时要用绝对路径。 */
const HERE = dirname(fileURLToPath(import.meta.url));

const zipPath = process.argv[2] ?? "F:/KF/DSKX/dsh-kxxy/android/app/src/main/assets/runtime.zip";
const target = resolve(process.argv[3] ?? join(tmpdir(), "kxxy-sim-install"));

/** 与 RuntimeInstaller 的 companion object 保持一致。 */
const MANIFEST_NAME = "kxxy-runtime.json";
const LINK_PREFIX = "LINK:";
const ROOT_PLACEHOLDER = "@DSH_ROOT@";
const RUNTIME_VERSION = "v0.1.0-arm64";
const MIN_DSH_AI_FILES = 100;

/**
 * 与 RuntimeInstaller.COMPAT_LAYER_MARKER 保持一致。
 *
 * 老设备升级 APK 时 RUNTIME_VERSION 不变，所以「文件存在」不足以判出兼容层
 * 过期；锚点 6 实际比对的是 compat.js 首行的版本标记。
 */
const COMPAT_LAYER_MARKER = "kxxy-webview-compat@6";

/**
 * 与 RuntimeInstaller.MODERN_LAYER_MARKER 保持一致（锚点 6 的第二份资产）。
 *
 * modern.js 补齐 Chrome 105–139 才有的 JS 内建，并包装
 * `URL.createObjectURL` 把同一份代码注入 blob worker / blob iframe。
 * 缺它时 PDF 渲染 worker 与 HTML 预览 iframe 都会在独立全局里抛
 * `ReferenceError: Iterator is not defined`。
 */
const MODERN_LAYER_MARKER = "kxxy-modern@2";

/**
 * 与 RuntimeInstaller.PTY_NODE_MARKER 保持一致（锚点 7）。
 *
 * 老设备上 node-pty 可能是早期构建注入的抛错空壳，文件在、但一点开终端
 * 就报 `terminal inspection is unsupported on platform android`；
 * 同样按首行版本标记判定过期。
 */
const PTY_NODE_MARKER = "kxxy-pty-node@1";

/**
 * 与 RuntimeInstaller.HOST_PLUGIN_MARKER 保持一致（锚点 8）。
 *
 * 锚点 5 只判 kxxy-host/package.json 存在，而那个文件从 v0.1.0 起内容未变；
 * 于是「改了 host.js / lib/index.js 却只重装 APK」的设备一直跑旧插件，
 * 且七锚点全通过、永不重装。标记写在插件入口 lib/index.js 首行。
 *
 * 这里**从 Kotlin 源码读**而不是抄一份字面量：抄的那一份是纯冗余，
 * 每次递增标记都要记得改两处，忘一次就是「模拟安装报失败、真机却正常」的
 * 假红灯（本次缺陷 BM 递增 @13→@14 时就踩了）。verify-runtime.mjs 对
 * COMPAT_LAYER_MARKER 等标记早就是这么读的，这里统一成同一范式。
 */
const HOST_PLUGIN_MARKER = (() => {
  const kt = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"),
    "utf8",
  );
  const m = /HOST_PLUGIN_MARKER\s*=\s*"([^"]+)"/.exec(kt);
  if (m === null) throw new Error("RuntimeInstaller.kt 未定义 HOST_PLUGIN_MARKER");
  return m[1];
})();

/**
 * 与 RuntimeInstaller.MOBILE_PLUGIN_MARKER 保持一致（锚点 10）。
 *
 * 内置的第三方移动端插件 dsh-web-mobile 是随 runtime 打包的整包，既不进
 * `@deepseek-ai` 计数（锚点 4），也不属于 kxxy-host（锚点 5/8）。缺了它的
 * 表现是「手机上仍是官方桌面布局」——不报错、不留日志。标记由
 * build-runtime.mjs 写成包根目录下的 `plugin.version`。
 */
const MOBILE_PLUGIN_MARKER = "kxxy-mobile-plugin@1";
const MOBILE_PLUGIN_ENTRY = "lib/node_modules/dsh-web-mobile/package.json";
const MOBILE_PLUGIN_CLIENT = "lib/node_modules/dsh-web-mobile/lib/client.js";
const MOBILE_PLUGIN_MARKER_FILE = "lib/node_modules/dsh-web-mobile/plugin.version";

/**
 * 与 RuntimeInstaller.OFFICE_LAYER_MARKER 保持一致（锚点 9）。
 *
 * LibreOffice wasm 引擎与单文件 CJK 字体是随 runtime 发的「新增资产」，
 * 而 RUNTIME_VERSION 从未变过 —— 老设备升级 APK 时前面的锚点全部通过，
 * isComplete() 判真并跳过重装，设备上永远没有这两份文件，Office 预览
 * 一直报「Office 预览不可用」。标记写在独立小文件里（TTF 头部不能动）。
 */
const OFFICE_LAYER_MARKER = "kxxy-office@1";
const OFFICE_LAYER_MARKER_FILE = "lib/node_modules/kxxy-host/fonts/office-assets.version";
const OFFICE_WASM_ENGINE =
  "lib/node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/soffice.wasm";
const OFFICE_FONT_FILES = [
  "lib/node_modules/kxxy-host/fonts/NotoSansSC-Regular.ttf",
  "lib/node_modules/kxxy-host/fonts/NotoSansSC-Bold.ttf",
];

/**
 * 与 RuntimeInstaller.PATCHSET_MARKER 保持一致（锚点 11）。
 *
 * 前面的锚点探的全是自有资产与内置插件，而绝大多数补丁改的是**上游文件**
 * （documentpreview 的 client.js / client.pdf.js、libreoffice-kit、
 * dsh-office-to-pdf …），它们没有任何可探的版本标记。真机事故：补上
 * zip / epub provider、重建 runtime 与 APK 装机后，设备上
 * `grep -c kxxyArchiveApply` 仍是 0 —— 前面的锚点全通过，isComplete()
 * 判真，补丁根本没解出来。标记由 build-runtime.mjs 写在 kxxy-host 目录下。
 */
const PATCHSET_MARKER = "kxxy-patchset@5";
const PATCHSET_MARKER_FILE = "lib/node_modules/kxxy-host/patchset.version";

/**
 * 与 RuntimeInstaller.TESSDATA_MARKER 保持一致（锚点 12）。
 *
 * Termux 的 `tesseract` 包只带 eng.traineddata，索引里也没有任何
 * tesseract-lang* 包 —— 中文识别能力在 Termux 生态里不存在，只能构建期
 * 从 tessdata_fast 取。与 office 资产同型：新增资产 + RUNTIME_VERSION 不变。
 */
const TESSDATA_MARKER = "kxxy-tessdata@1";
const TESSDATA_MARKER_FILE = "lib/node_modules/kxxy-host/tessdata.version";
const TESSDATA_LANGUAGE_FILE = "share/tessdata/chi_sim.traineddata";

/**
 * 与 RuntimeInstaller.TEXLIVE_MARKER 保持一致（锚点 13）。
 *
 * Termux 的 `texlive-bin` deb 只发引擎（pdftex/xetex/luatex + kpathsea），
 * `tex/latex`/`tex/plain`/`tlpkg` 全为 0 条 —— 宏包树由构建期从 CTAN 取
 * scheme-basic 打进 runtime。缺了它 `pdftex t.tex` 连 plain TeX 都跑不了。
 */
const TEXLIVE_MARKER = "kxxy-texlive@2";
const TEXLIVE_MARKER_FILE = "lib/node_modules/kxxy-host/texlive.version";
const TEXLIVE_CORE_FILES = [
  "share/texlive/2026.0/texmf-dist/tex/latex/base/article.cls",
  "share/texlive/2026.0/texmf-dist/tex/plain/base/plain.tex",
  "share/texlive/2026.0/tlpkg/TeXLive/TLConfig.pm",
];
const EXECUTABLE_NAMES = new Set(["rg", "esbuild", "node", "sharp", "swc", "dprint", "biome"]);
const SONAME_ALIASES = [
  ["lib/libreadline.so.8", "lib/libreadline.so.8.3"],
  ["lib/libhistory.so.8", "lib/libhistory.so.8.3"],
  ["lib/libncursesw.so.6", "lib/libncursesw.so.6.5"],
  ["lib/libncurses.so.6", "lib/libncurses.so.6.5"],
  ["lib/libncurses.so", "lib/libncurses.so.6.5"],
];

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  ✗ ${msg}`);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

// ---------------------------------------------------------------- readZipIndex
const buf = readFileSync(zipPath);
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd < 0) throw new Error("找不到 EOCD");
const count = buf.readUInt16LE(eocd + 10);
const cdStart = buf.readUInt32LE(eocd + 16);

/** name → { method, csize, usize, localOffset, comment } */
const index = new Map();
const topDirs = new Set();
{
  let p = cdStart;
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const comment = commentLen
      ? buf.toString("utf8", p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen)
      : "";
    index.set(name, { method, csize, usize, localOffset, comment });
    const slash = name.indexOf("/");
    if (slash > 0) topDirs.add(name.slice(0, slash));
    p += 46 + nameLen + extraLen + commentLen;
  }
}

const linkTargets = new Map();
for (const [name, e] of index) {
  if (e.comment.startsWith(LINK_PREFIX)) linkTargets.set(name, e.comment.slice(LINK_PREFIX.length));
}
let manifest = null;
{
  const e = index.get(MANIFEST_NAME);
  if (e !== void 0) manifest = JSON.parse(readEntryData(MANIFEST_NAME, e).toString("utf8"));
}

console.log(`runtime.zip：${count} 条目，LINK ${linkTargets.size}，顶层目录 ${topDirs.size}`);
console.log(`manifest：runtimeVersion=${manifest?.runtimeVersion} entries=${manifest?.entries} placeholderPaths=${manifest?.placeholderPaths?.length}`);
console.log(`模拟安装到：${target}\n`);

/** 读一个条目的原始内容（method=0 直接切片，否则 inflateRaw）。 */
function readEntryData(name, e) {
  const lp = e.localOffset;
  if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error(`local header 签名错误：${name}`);
  const nameLen = buf.readUInt16LE(lp + 26);
  const extraLen = buf.readUInt16LE(lp + 28);
  const start = lp + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.csize);
  return e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
}

// ---------------------------------------------------------------- extract
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

let extracted = 0;
let skippedLinks = 0;
const canonicalRoot = resolve(target);
for (const [name, e] of index) {
  if (name.endsWith("/")) {
    mkdirSync(join(target, name), { recursive: true });
    continue;
  }
  if (linkTargets.has(name)) {
    skippedLinks += 1;
    continue;
  }
  const dest = join(target, name);
  // zip-slip 防护，与 RuntimeInstaller 的 canonicalPath 比对同义
  if (!resolve(dest).startsWith(canonicalRoot + sep) && resolve(dest) !== canonicalRoot) {
    throw new Error(`zip-slip：${name}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readEntryData(name, e));
  extracted += 1;
}
const dirCount = [...index.keys()].filter((n) => n.endsWith("/")).length;
console.log(`[1] extract：写出 ${extracted} 个文件，跳过 ${skippedLinks} 个 LINK`);
{
  // manifest.entries 含自身与全部目录条目：实体文件 = entries - 1(manifest) - links - dirs
  // manifest.entries 已含全部目录条目与 manifest 自身：
  //   entries = 目录 + LINK + 实体文件（实体文件数里已包含 kxxy-runtime.json）
  const expect = manifest.entries - linkTargets.size - dirCount;
  if (extracted !== expect) fail(`实体文件数不符：期望 ${expect} 实得 ${extracted}`);
  else ok(`实体文件数与 manifest 一致（${extracted} = ${manifest.entries} - ${linkTargets.size} LINK - ${dirCount} 目录）`);
}

// ---------------------------------------------------------------- materialiseLinks
let madeLinks = 0;
const missingLinkTargets = [];
for (const [alias, targetRel] of linkTargets) {
  const src = join(target, targetRel);
  const dst = join(target, alias);
  if (!existsSync(src)) {
    missingLinkTargets.push(`${alias} → ${targetRel}`);
    continue;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  madeLinks += 1;
}
console.log(`[2] materialiseLinks：物化 ${madeLinks}/${linkTargets.size} 个别名`);
if (missingLinkTargets.length) fail(`LINK 目标缺失 ${missingLinkTargets.length} 条：${missingLinkTargets.slice(0, 5).join(", ")}`);
else ok("全部 LINK 目标都在包内（可物化）");

// ---------------------------------------------------------------- rewriteRootPlaceholder
const placeholders = manifest.placeholderPaths ?? [];
let rewritten = 0;
const stillHasTermux = [];
for (const rel of placeholders) {
  const f = join(target, rel);
  if (!existsSync(f)) {
    fail(`placeholderPaths 指向不存在的文件：${rel}`);
    continue;
  }
  const text = readFileSync(f).toString("latin1");
  if (!text.includes(ROOT_PLACEHOLDER)) {
    fail(`placeholderPaths 声明的文件里没有占位符：${rel}`);
    continue;
  }
  writeFileSync(f, Buffer.from(text.split(ROOT_PLACEHOLDER).join(canonicalRoot), "latin1"));
  rewritten += 1;
  // *.dist-info/METADATA 是 PyPI 长描述（README 原文），proot-distro 的示例
  // 命令里带着 /data/data/com.termux 字样 —— 纯文档，python 从不执行它，
  // 不算残留；真正的脚本残留仍然要吵出来。
  if (rel.endsWith("/METADATA")) continue;
  if (readFileSync(f).toString("latin1").includes("com.termux")) stillHasTermux.push(rel);
}
console.log(`[3] rewriteRootPlaceholder：改写 ${rewritten}/${placeholders.length} 个脚本`);
if (stillHasTermux.length) fail(`改写后仍含 com.termux：${stillHasTermux.slice(0, 5).join(", ")}`);
else ok("改写后无残留 com.termux");

// ---------------------------------------------------------------- materialiseSonameAliases
let sonames = 0;
for (const [alias, real] of SONAME_ALIASES) {
  const src = join(target, real);
  const dst = join(target, alias);
  if (!existsSync(src)) {
    fail(`SONAME 别名本体缺失：${real}`);
    continue;
  }
  if (existsSync(dst)) {
    sonames += 1;
    continue;
  }
  copyFileSync(src, dst);
  sonames += 1;
}
console.log(`[4] materialiseSonameAliases：${sonames}/${SONAME_ALIASES.length}`);
if (sonames === SONAME_ALIASES.length) ok("五个 SONAME 别名齐备");

// ---------------------------------------------------------------- restoreExecBits
const chmodded = [];
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};
for (const full of walk(target)) {
  const base = full.slice(full.lastIndexOf(sep) + 1);
  const rel = relative(target, full).split(sep).join("/");
  const head = readFileSync(full, { encoding: null }).subarray(0, 4);
  const isElf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  const isScript = head[0] === 0x23 && head[1] === 0x21;
  // 与 RuntimeInstaller.restoreExecBits 的三段策略保持一致：
  // bin/ + usr/bin/ + libexec/ 全量；lib/jvm 下两级（openjdk-21 布局）；
  // node_modules 内按路径与名单。
  //
  // `lib/jvm` 的判据与 Kotlin 侧逐字相同：`/bin/` 路径段 **或者** 无扩展名的
  // 文件。后者专为 `lib/jspawnhelper` 而设 —— 它在 `lib/` 下而不是 `bin/` 下，
  // 没有它 Gradle 起不了 daemon（缺陷 AW），而 `java -version` 一切正常，
  // 所以这条漏了几乎是无声的。
  if (
    (isElf || isScript) &&
    (rel.startsWith("bin/") ||
      rel.startsWith("usr/bin/") ||
      rel.startsWith("libexec/") ||
      (rel.startsWith("lib/jvm/") && (rel.includes("/bin/") || !base.includes("."))) ||
      EXECUTABLE_NAMES.has(base))
  ) {
    chmodSync(full, 0o755);
    chmodded.push(rel);
  }
}
console.log(`[5] restoreExecBits：${chmodded.length} 个可执行文件置 0755`);

/*
 * lib/jspawnhelper 必须真的被置位（缺陷 AW 的回归断言）。
 *
 * 为什么要单独断言而不只看总数：`restoreExecBits` 的命中是个大集合，
 * 上面 chmodded.length 从 1620 变成 1621 完全看不出来。而 jspawnhelper
 * 漏掉的后果极隐蔽 —— 真机上 `java -version`、`kotlinc` 全部正常，只有
 * Gradle 报 `Could not start '…/bin/java'`（看起来像 java 不可执行）。
 */
{
  const helpers = chmodded.filter((r) => r.startsWith("lib/jvm/") && r.endsWith("/lib/jspawnhelper"));
  if (helpers.length === 0) {
    fail("lib/jvm/**/lib/jspawnhelper 未被置为可执行（Gradle 会起不了 daemon，见缺陷 AW）");
  } else {
    ok(`spawn helper 已置位（${helpers.length} 个：${helpers[0]}）`);
  }
}

/*
 * libbinder_ndk.so 桩库必须已被剔除（缺陷 AZ 的回归断言）。
 *
 * 为什么：`libandroid-stub_30-1` 的 24,000 B 桩库 soname=null 且无版本定义，
 * 会遮蔽 `/system/lib64/libbinder_ndk.so`（94,488 B）。`EngineConfig.buildEnv`
 * 把 `<root>/lib` 放在 `LD_LIBRARY_PATH` 首位后，`/system/lib64/libui.so`
 * 的 verneed 解析失败，`ffmpeg`/`ffprobe` 报
 * `cannot find "libbinder_ndk.so" from verneed[0] in DT_NEEDED list`。
 * 真机 A/B 证明删掉它不影响任何其它工具，而删掉 `libmediandk.so` 反而会
 * 让系统 `libunwindstack.so` 报 `cannot locate symbol "Xzs_Construct"`。
 */
{
  const stub = join(target, "lib/libbinder_ndk.so");
  if (existsSync(stub)) {
    fail("lib/libbinder_ndk.so 桩库仍在产物里（ffmpeg/ffprobe 会起不来，见缺陷 AZ）");
  } else {
    ok("libbinder_ndk.so 桩库已剔除");
  }
  for (const keep of [
    "lib/libandroid.so",
    "lib/libmediandk.so",
    "lib/libOpenSLES.so",
    "lib/libtermux-platform-ns.so",
  ]) {
    if (!existsSync(join(target, keep))) fail(`误删了必须保留的桩库：${keep}`);
  }
  ok("其余 4 个 libandroid-stub 桩库保留");
}

/*
 * RuntimeInstaller 必须带「每次启动补删桩库」的幂等路径（缺陷 AZ 的自愈）。
 *
 * 为什么需要：构建期剔除只覆盖新装。老设备 `isComplete()` 判真 ⇒ 永不重装
 * ⇒ 桩库永远留在盘上，ffmpeg 永远起不来。真机实测确认过这一点：装了带修复
 * 的 APK 后 logcat 只打 `runtime already installed and complete`，而
 * `<root>/lib/libbinder_ndk.so` 仍在，直到手工 `rm` 才恢复。
 * 这与 `ensureJvmExecBits` 完全同型 —— 资产都在，问题在 mode / 多余内容。
 */
{
  const kt = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"),
    "utf8",
  );
  if (!/private\s+fun\s+ensureNoShadowingStubs\s*\(/.test(kt)) {
    fail("缺少 ensureNoShadowingStubs 定义（老设备不会重装，桩库永远删不掉）");
  }
  // 缺陷 BH：清单从「恰好 binder_ndk」扩到三条，缺陷 BQ 又加了两条。逐条断言
  // 而不是整体正则，这样多删 / 少删都能指名道姓。
  //   - libbinder_ndk.so：缺陷 AZ，桩库 soname=null，遮蔽系统真库的版本定义。
  //   - liblzma.so（裸名）：缺陷 BH，soname 是 liblzma.so.5，系统侧要裸名。
  //   - libheif.so（裸名）：缺陷 BH 同族，来自扩展 .links.json 而非 zip。
  //   - libc++.so / libc++abi.so：缺陷 BQ，v0.8.0 误加的别名，遮蔽
  //     /system/lib64/libc++.so（std::__1 vs std::__ndk1 ABI）。
  //
  // ⚠️ 必须先**剥掉注释**再抽字符串：`listOf(` 那段里夹着大段说明，而说明
  // 正文引用了现场报错原文（`CANNOT LINK EXECUTABLE "rm" … "/system/lib64/liblog.so"`），
  // 里面的 ASCII 双引号会被 `"([^"]+)"` 一并当成条目 —— 首版就是这么写的，
  // 实得 6 条而不是 5 条，还混进了 `rm` 和那句报错里的符号名。
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const stubsMatch = /SHADOWING_STUBS\s*=\s*listOf\(([\s\S]*?)\n\s*\)/.exec(stripComments(kt));
  const stubs = stubsMatch === null ? [] : [...stubsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const need of [
    "lib/libbinder_ndk.so",
    "lib/liblzma.so",
    "lib/libheif.so",
    "lib/libc++.so",
    "lib/libc++abi.so",
  ]) {
    if (!stubs.includes(need)) fail(`SHADOWING_STUBS 缺少 ${need}（会被 LD_LIBRARY_PATH 首位遮蔽系统真库）`);
  }
  for (const forbidden of [
    "lib/libandroid.so",
    "lib/libmediandk.so",
    "lib/libOpenSLES.so",
    "lib/liblzma.so.5",
    "lib/libheif.so.1",
  ]) {
    if (stubs.includes(forbidden)) {
      fail(`SHADOWING_STUBS 误含 ${forbidden}（带 soname 的版本名必须保留，删了会崩 libunwindstack / libheif 消费者）`);
    }
  }
  if (stubs.length !== 5) fail(`SHADOWING_STUBS 应为 5 条，实得 ${stubs.length}：${stubs.join(", ")}`);
  // 两条路径（已完整 / 重装）都得调；只看是否至少出现两次
  const calls = (kt.match(/ensureNoShadowingStubs\(root\)/g) || []).length;
  if (calls < 2) {
    fail(`ensureNoShadowingStubs 只在 ${calls} 处被调用（应同时挂「已完整」与「重装」两条路径）`);
  }
  ok(`ensureNoShadowingStubs 已就位并挂了 ${calls} 条路径`);
}

/*
 * Emacs 的 site-load.el 也必须是「每次启动幂等生成」（缺陷 BA 收尾）。
 *
 * 它抹的是 `loadup.el:463` 在无 dump 时对 `source-directory`（编译期写死的
 * Termux 前缀）发起的 git 探测 —— 每次 `emacs --batch` 都刷两行
 * `Error running git rev-parse: (file-missing "Setting current directory" …)`。
 * 和桩库同理：老设备 `isComplete()` 判真 ⇒ 不重装 ⇒ 文件永远不生成。
 */
{
  const kt = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"),
    "utf8",
  );
  if (!/private\s+fun\s+ensureEmacsSiteLoad\s*\(/.test(kt)) {
    fail("缺少 ensureEmacsSiteLoad 定义（老设备不重装，emacs 每次启动都会刷 git 报错）");
  }
  const calls = (kt.match(/ensureEmacsSiteLoad\(root\)/g) || []).length;
  if (calls < 2) {
    fail(`ensureEmacsSiteLoad 只在 ${calls} 处被调用（应同时挂「已完整」与「重装」两条路径）`);
  }
  // 真正消音的是这两个 defalias；只改 source-directory 不够（真机 A/B：git 报错数不变）
  if (!/emacs-repository-get-version/.test(kt) || !/emacs-repository-get-branch/.test(kt)) {
    fail("site-load.el 必须同时 defalias 掉 emacs-repository-get-version 与 -get-branch");
  }
  const cfg = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/EngineConfig.kt"),
    "utf8",
  );
  if (/"EMACSLIBEXEC=/.test(cfg)) {
    fail("EngineConfig 仍在导出 EMACSLIBEXEC（emacs 不认这个名字，真机 A/B 已证）");
  }
  if (!/"EMACSPATH=\$\{emacsLibExecDir\(root\)\}"/.test(cfg)) {
    fail("EngineConfig 必须导出 EMACSPATH（emacs 31.1 真正 getenv 的变量名）");
  }
  ok(`ensureEmacsSiteLoad 已就位并挂了 ${calls} 条路径，EMACSPATH 正确`);
}

// ---------------------------------------------------------------- isComplete（十一锚点）
console.log("[6] isComplete 十一锚点（含兼容层、PTY 绑定、宿主插件、office 资产、内置移动端插件与构建期补丁集）：");
const anchors = [
  ["锚点 1 dsh 引擎入口", join(target, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js")],
  ["锚点 2 SONAME 别名 libreadline.so.8", join(target, "lib/libreadline.so.8")],
  ["锚点 3 node 可执行", join(target, "bin/node")],
  ["锚点 5 kxxy-host 插件", join(target, "lib/node_modules/kxxy-host/package.json")],
  // 锚点 6：WebView 兼容层。旧 ROM 的 WebView 可能早于 Chrome 116 / 108，
  // 缺 AbortSignal.any 会让设置面板「权限」显示英文 key、模型页 provider 空白；
  // 不支持 dvh 单位会让目录选择对话框塌成 0 高、列表整片空白。
  ["锚点 6 WebView 兼容层", join(target, "lib/node_modules/kxxy-host/web/compat.js")],
  // 锚点 6 的第二份资产：现代内建补齐层。它负责页面主作用域之外的 blob
  // worker / blob iframe —— PDF 渲染 worker 与 HTML 预览 iframe 都在那里，
  // 缺它时右侧栏 PDF 报「渲染进程无法继续」、HTML 整片空白。
  ["锚点 6 现代内建补齐层", join(target, "lib/node_modules/kxxy-host/web/modern.js")],
  // 锚点 7：Android 原生 PTY 绑定。上游 createProcessInspector 不认 android，
  // 且 node-pty 无 Android 预编译产物 —— 两者都由构建期补丁修掉，
  // 但老设备的 runtime 不会因此重装，必须参与完整性判定。
  ["锚点 7 PTY 原生模块", join(target, "lib/node_modules/node-pty/prebuilds/android-arm64/dsh_pty_node.node")],
  // 锚点 8：宿主插件本体。锚点 5 的 package.json 从 v0.1.0 起内容未变，
  // 光判它存在会让「改了 host.js 却只重装 APK」的设备一直跑旧插件。
  ["锚点 8 宿主插件入口", join(target, "lib/node_modules/kxxy-host/lib/index.js")],
  // 锚点 9：office 预览链。wasm 引擎与 CJK 字体是随 runtime 发的「新增
  // 资产」，RUNTIME_VERSION 从未变过 ⇒ 老设备前面的锚点全过、跳过重装，
  // 设备上永远没有这两份文件，Office 预览一直报「Office 预览不可用」。
  ["锚点 9 office 资产标记", join(target, OFFICE_LAYER_MARKER_FILE)],
  ["锚点 9 LibreOffice wasm 引擎", join(target, OFFICE_WASM_ENGINE)],
  ...OFFICE_FONT_FILES.map((f, i) => [`锚点 9 CJK 字体 ${i + 1}`, join(target, f)]),
  // 锚点 10：内置的第三方移动端插件 dsh-web-mobile。它既不进 @deepseek-ai
  // 计数（锚点 4），也不属于 kxxy-host（锚点 5/8）；缺了它的表现是「手机上
  // 仍是官方桌面布局」——不报错、不留日志，属于最难排查的一类。
  ["锚点 10 移动端插件 package.json", join(target, MOBILE_PLUGIN_ENTRY)],
  ["锚点 10 移动端插件客户端半区", join(target, MOBILE_PLUGIN_CLIENT)],
  ["锚点 10 移动端插件标记", join(target, MOBILE_PLUGIN_MARKER_FILE)],
  // 锚点 11：构建期补丁集版本。前面的锚点探的全是自有资产与内置插件，而补丁
  // 改的是上游文件（documentpreview 的 client.js / client.pdf.js、
  // libreoffice-kit、dsh-office-to-pdf …），它们没有版本标记可探 —— 补丁落地
  // 与否只能靠这个构建期写入的小文件判定。
  ["锚点 11 补丁集标记", join(target, PATCHSET_MARKER_FILE)],
  // 锚点 12：Tesseract 简体中文语言包。与锚点 9 同型（新增资产 + 版本戳不变
  // ⇒ 不加锚点老设备永不重装）。Termux 生态里根本没有中文包，只能随 runtime 发。
  ["锚点 12 中文语言包标记", join(target, TESSDATA_MARKER_FILE)],
  ["锚点 12 中文语言包主体", join(target, TESSDATA_LANGUAGE_FILE)],
  // 锚点 13：TeX Live 宏包树。Termux 的 texlive-bin deb 只发引擎，
  // tex/latex、tex/plain、tlpkg 全为 0 条 —— 宏包树由构建期从 CTAN 打进 runtime。
  ["锚点 13 宏包树标记", join(target, TEXLIVE_MARKER_FILE)],
  ...TEXLIVE_CORE_FILES.map((f, i) => [`锚点 13 宏包树主体 ${i + 1}`, join(target, f)]),
];
for (const [label, f] of anchors) {
  if (!existsSync(f)) fail(`${label} 缺失：${f.slice(target.length + 1)}`);
  else ok(`${label} 存在`);
}
{
  // 锚点 6 的第二段判定：版本标记。RuntimeInstaller.compatLayerIsCurrent 读
  // compat.js 头部做 contains 匹配，标记过期即强制重装（否则老设备带着旧兼容层
  // 跳过重装，已修的缺陷会静默复现）。
  const compat = join(target, "lib/node_modules/kxxy-host/web/compat.js");
  if (existsSync(compat)) {
    const head = readFileSync(compat, "utf8").slice(0, 256);
    if (!head.includes(COMPAT_LAYER_MARKER)) fail(`锚点 6 版本标记过期：compat.js 头部不含 ${COMPAT_LAYER_MARKER}`);
    else ok(`锚点 6 版本标记匹配（${COMPAT_LAYER_MARKER}）`);
  }

  const modern = join(target, "lib/node_modules/kxxy-host/web/modern.js");
  if (existsSync(modern)) {
    const head = readFileSync(modern, "utf8").slice(0, 256);
    if (!head.includes(MODERN_LAYER_MARKER)) fail(`锚点 6 版本标记过期：modern.js 头部不含 ${MODERN_LAYER_MARKER}`);
    else ok(`锚点 6 现代内建补齐层标记匹配（${MODERN_LAYER_MARKER}）`);
  }
}
{
  // 锚点 7 的第二段判定：版本标记（同上，标记写在 JS 包装层首行）。
  const wrapper = join(target, "lib/node_modules/node-pty/lib/index.js");
  if (existsSync(wrapper)) {
    const head = readFileSync(wrapper, "utf8").slice(0, 256);
    if (!head.includes(PTY_NODE_MARKER)) fail(`锚点 7 版本标记过期：node-pty/lib/index.js 头部不含 ${PTY_NODE_MARKER}`);
    else ok(`锚点 7 版本标记匹配（${PTY_NODE_MARKER}）`);
  }
}
{
  // 锚点 7 的第三段判定：原生模块必须是可加载的 ELF 共享库，而不是空文件。
  // 早期构建注入的是抛错空壳（只有 lib/index.js），二进制缺失时终端必报错。
  const node = join(target, "lib/node_modules/node-pty/prebuilds/android-arm64/dsh_pty_node.node");
  if (existsSync(node)) {
    const buf = readFileSync(node);
    const isElf = buf.length > 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
    if (!isElf) fail("锚点 7 原生模块不是 ELF（可能是空文件或被文本替换）");
    else ok(`锚点 7 原生模块为 ELF（${buf.length} B）`);
  }
}
{
  // 锚点 8 的第二段判定：宿主插件版本标记（写在 lib/index.js 首行）。
  const entry = join(target, "lib/node_modules/kxxy-host/lib/index.js");
  if (existsSync(entry)) {
    const head = readFileSync(entry, "utf8").slice(0, 256);
    if (!head.includes(HOST_PLUGIN_MARKER)) fail(`锚点 8 版本标记过期：lib/index.js 头部不含 ${HOST_PLUGIN_MARKER}`);
    else ok(`锚点 8 版本标记匹配（${HOST_PLUGIN_MARKER}）`);
  }
}
{
  // 锚点 9 的第二段判定：office 资产标记文件内容（RuntimeInstaller 只做
  // contains 匹配，这里同样）。wasm 主体与字体的存在性已由 anchors 循环判过。
  const marker = join(target, OFFICE_LAYER_MARKER_FILE);
  if (existsSync(marker)) {
    const head = readFileSync(marker, "utf8").slice(0, 256);
    if (!head.includes(OFFICE_LAYER_MARKER)) fail(`锚点 9 版本标记过期：office-assets.version 不含 ${OFFICE_LAYER_MARKER}`);
    else ok(`锚点 9 office 资产标记匹配（${OFFICE_LAYER_MARKER}）`);
  }
}
{
  // 锚点 10 的第二段判定：内置移动端插件的标记文件内容。
  const marker = join(target, MOBILE_PLUGIN_MARKER_FILE);
  if (existsSync(marker)) {
    const head = readFileSync(marker, "utf8").slice(0, 256);
    if (!head.includes(MOBILE_PLUGIN_MARKER)) fail(`锚点 10 版本标记过期：plugin.version 不含 ${MOBILE_PLUGIN_MARKER}`);
    else ok(`锚点 10 移动端插件标记匹配（${MOBILE_PLUGIN_MARKER}）`);
  }
  // 锚点 10 的第三段判定：插件必须在 `@deepseek-ai/dsh` 的 dependencies 里。
  //
  // 这是 `dsh-client-modules` 能发现它的**前提**：它遍历的是 Loader entries，
  // 而 entry 由 `dsh-app-boot` 的 installation scope 解析出来。补丁
  // patchDshManifest 负责写这一行；漏写时插件一切文件都在，只是永远不激活，
  // 表现与「没打包」完全一样。
  const dshManifest = join(target, "lib/node_modules/@deepseek-ai/dsh/package.json");
  if (existsSync(dshManifest)) {
    const deps = JSON.parse(readFileSync(dshManifest, "utf8")).dependencies ?? {};
    if (deps["dsh-web-mobile"] === void 0) fail("锚点 10 @deepseek-ai/dsh 的 dependencies 里没有 dsh-web-mobile（补丁未生效）");
    else ok(`锚点 10 插件已注册进 installation scope（dsh-web-mobile@${deps["dsh-web-mobile"]}）`);
  }
}
{
  const aiDir = join(target, "lib/node_modules/@deepseek-ai");
  const n = existsSync(aiDir) ? walk(aiDir).length : 0;
  if (n < MIN_DSH_AI_FILES) fail(`锚点 4 @deepseek-ai 文件数 ${n} < ${MIN_DSH_AI_FILES}`);
  else ok(`锚点 4 @deepseek-ai 文件数 ${n} ≥ ${MIN_DSH_AI_FILES}`);
}

// ---------------------------------------------------------------- ④ 档锚点
console.log("\n[6b] ④ 全能精选档锚点（五项改进方案 §4）：");
for (const [label, f] of [
  ["bin/python3（G1 脚本链）", join(target, "bin/python3")],
  ["bin/clang（G3 编译链）", join(target, "bin/clang")],
  ["bin/proot（G6 容器）", join(target, "bin/proot")],
  ["bin/d8（G4 安卓打包链）", join(target, "bin/d8")],
]) {
  if (!existsSync(f)) fail(`${label} 缺失`);
  else ok(`${label} 存在`);
}
{
  // openjdk-21 装在 lib/jvm/java-21-openjdk/bin/java（Termux 布局）
  const jvmBin = join(target, "lib/jvm");
  const java = existsSync(jvmBin)
    ? walk(jvmBin).find((f) => f.replace(/\\/g, "/").endsWith("/bin/java"))
    : null;
  if (!java) fail("lib/jvm/**/bin/java 缺失（openjdk-21 未进闭包？）");
  else ok(`lib/jvm/**/bin/java 存在（…/${relative(target, java).split(sep).join("/").slice("lib/jvm/".length)}）`);
  if (java && !(statSync(java).mode & 0o111)) {
    // Windows 上 chmod 不生效，这一条只在 POSIX 宿主才有意义
    if (process.platform !== "win32") fail("java 可执行位未置（lib/jvm 扫描缺失？）");
    else ok("（Windows 宿主无法验证可执行位，Android 上由 RuntimeInstaller 置位）");
  } else if (java) ok("java 可执行位已置");
}

// ---------------------------------------------------------------- 引擎启动路径
console.log("\n[7] 引擎启动路径检查（EngineProcess.spawn 的 argv 依赖）：");
const entry = join(target, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js");
const nodeBin = join(target, "bin/node");
for (const [label, f] of [["bin/node", nodeBin], ["dsh/lib/bin.js", entry]]) {
  if (!existsSync(f)) {
    fail(`${label} 缺失`);
    continue;
  }
  const head = readFileSync(f).subarray(0, 4);
  if (f === nodeBin) {
    const isElf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
    if (!isElf) fail(`${label} 不是 ELF（Android 无法 execve）`);
    else ok(`${label} 是 ELF 且可执行位已置`);
  } else ok(`${label} 存在`);
}
{
  // profile 解析链：kxxy-host 必须出现在 dsh 的 dependencies 里
  const pj = JSON.parse(readFileSync(join(target, "lib/node_modules/@deepseek-ai/dsh/package.json"), "utf8"));
  if (pj.dependencies?.["kxxy-host"] === void 0) fail("kxxy-host 未注册进 @deepseek-ai/dsh 的 dependencies（profile 解析会落空）");
  else ok(`kxxy-host 已注册（dependencies 共 ${Object.keys(pj.dependencies).length} 项，声明版本 ${pj.dependencies["kxxy-host"]}）`);
  // installAnchor 的 resolve.paths() 首项必须是 <root>/lib/node_modules
  if (!existsSync(join(target, "lib/node_modules/kxxy-host/lib/index.js"))) fail("kxxy-host/lib/index.js 缺失");
  else ok("kxxy-host 落在 installAnchor 的 node_modules 查找路径上");
}

// ---------------------------------------------------------------- 产出摘要
let totalBytes = 0;
let totalFiles = 0;
for (const full of walk(target)) {
  totalBytes += statSync(full).size;
  totalFiles += 1;
}
console.log(`\n安装后：${totalFiles} 个文件 / ${(totalBytes / 1048576).toFixed(1)} MiB（含 ${madeLinks} 个物化别名）`);
console.log(failures === 0 ? "\n结论：模拟安装全部通过" : `\n结论：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
