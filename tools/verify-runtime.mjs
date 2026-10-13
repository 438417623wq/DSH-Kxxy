/**
 * 校验 build-runtime.mjs 的产物：runtime.zip 的中央目录、LINK 注释、
 * 占位符改写结果与关键文件存在性。
 *
 * 用法：node tools/verify-runtime.mjs [zip 路径]
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const zipPath = process.argv[2] ?? "F:/KF/DSKX/dsh-kxxy/android/app/src/main/assets/runtime.zip";
const buf = readFileSync(zipPath);

// ---------------------------------------------------------------- 找 EOCD
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error("找不到 EOCD");
const count = buf.readUInt16LE(eocd + 10);
const cdSize = buf.readUInt32LE(eocd + 12);
const cdStart = buf.readUInt32LE(eocd + 16);
console.log(`EOCD @${eocd}  条目 ${count}  中央目录 ${cdStart}..${cdStart + cdSize}  文件 ${buf.length}`);

// ---------------------------------------------------------------- 遍历中央目录
const entries = [];
let p = cdStart;
for (let i = 0; i < count; i += 1) {
  if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录项 ${i} 签名错误 @${p}`);
  const method = buf.readUInt16LE(p + 10);
  const crc = buf.readUInt32LE(p + 16);
  const csize = buf.readUInt32LE(p + 20);
  const usize = buf.readUInt32LE(p + 24);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const externalAttr = buf.readUInt32LE(p + 38);
  const localOffset = buf.readUInt32LE(p + 42);
  const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
  const comment = commentLen ? buf.toString("utf8", p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen) : "";
  entries.push({ name, comment, method, crc, csize, usize, externalAttr, localOffset });
  p += 46 + nameLen + extraLen + commentLen;
}

const links = entries.filter((e) => e.comment.startsWith("LINK:"));
const dirs = entries.filter((e) => e.name.endsWith("/"));
const files = entries.filter((e) => !e.name.endsWith("/") && !e.comment.startsWith("LINK:"));
const stored = entries.filter((e) => e.method === 0);
console.log(`条目分类：目录 ${dirs.length}，实体文件 ${files.length}，LINK ${links.length}；method=store ${stored.length}`);

// ---------------------------------------------------------------- LINK 抽查
const gitAliases = links.filter((e) => e.name.startsWith("bin/") || e.name.startsWith("libexec/git-core/"));
console.log(`\nbin/ 与 libexec/ 下 LINK 共 ${gitAliases.length} 条，样例：`);
for (const e of gitAliases.slice(0, 5)) console.log(`  ${e.name} → ${e.comment.slice(5)}`);

const terminfoLinks = links.filter((e) => e.name.startsWith("lib/terminfo/"));
console.log(`\nlib/terminfo LINK ${terminfoLinks.length} 条（目录链接展开），样例：`);
for (const e of terminfoLinks.slice(0, 3)) console.log(`  ${e.name} → ${e.comment.slice(5)}`);

// ---------------------------------------------------------------- 关键文件
const NEED = [
  "bin/node", "bin/bash", "bin/rg", "bin/git", "bin/pnpm", "bin/npm", "bin/npx",
  "bin/sh", "bin/coreutils", "lib/libreadline.so.8", "lib/libreadline.so.8.3",
  "lib/libz.so.1", "lib/libz.so.1.3.2", "lib/libc++_shared.so",
  "lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
  "lib/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml",
  "lib/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml",
  "lib/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html",
  "lib/node_modules/koffi/package.json",
  "lib/node_modules/node-addon-require-builtin/lib/index.js",
  "lib/node_modules/@vscode/ripgrep-android-arm64/bin/rg",
  "lib/node_modules/@vscode/ripgrep-android-arm64/package.json",
  "lib/node_modules/corepack/dist/pnpm.js",
  // 自有插件 kxxy-host：宿主管理页（/kxxy、/kxxy/api/*、/kxxy/assets/*）
  "lib/node_modules/kxxy-host/package.json",
  "lib/node_modules/kxxy-host/cordis.patch.yml",
  "lib/node_modules/kxxy-host/lib/index.js",
  "lib/node_modules/kxxy-host/web/index.html",
  "lib/node_modules/kxxy-host/web/host.js",
  "lib/node_modules/kxxy-host/web/host.css",
  // WebView 兼容层：旧 ROM WebView（< Chrome 116 / 108）缺 AbortSignal.any、
  // 不支持 dvh 单位，缺了它设置面板与目录选择对话框会静默显示异常
  // （见 RuntimeInstaller 锚点 6，以及下面单独的版本标记断言）
  "lib/node_modules/kxxy-host/web/compat.js",
  // Android 原生 PTY 绑定：上游 createProcessInspector 不认 android，
  // 且 node-pty 无 Android 预编译产物，缺了它「新建终端」必定报错
  // （见 RuntimeInstaller 锚点 7，以及下面单独的版本标记断言）
  "lib/node_modules/node-pty/package.json",
  "lib/node_modules/node-pty/lib/index.js",
  "lib/node_modules/node-pty/prebuilds/android-arm64/dsh_pty_node.node",
  "kxxy-runtime.json",
];
const byName = new Map(entries.map((e) => [e.name, e]));
console.log("\n关键条目：");
let missing = 0;
for (const n of NEED) {
  const e = byName.get(n);
  if (!e) { console.log(`  ✗ ${n}`); missing += 1; continue; }
  const kind = e.comment.startsWith("LINK:") ? `LINK→${e.comment.slice(5)}` : `${e.usize}B`;
  console.log(`  ✓ ${n}  ${kind}`);
}

// ---------------------------------------------------------------- 兼容层版本标记
// RuntimeInstaller 锚点 6 不只判 compat.js 是否存在，还比对首行的版本标记
// （老设备升级 APK 时 runtimeVersion 不变，只判存在会让旧兼容层逃过重装）。
// 这里对 zip 里的实际内容做同一断言，避免「改了 compat.js 却忘了递增标记」。
{
  const markerNeed = /COMPAT_LAYER_MARKER\s*=\s*"([^"]+)"/.exec(
    readFileSync(join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"), "utf8"),
  );
  const entry = byName.get("lib/node_modules/kxxy-host/web/compat.js");
  if (!entry) {
    console.log("\n兼容层版本标记：✗ 条目缺失，跳过");
  } else if (markerNeed === null) {
    console.log("\n兼容层版本标记：✗ RuntimeInstaller.kt 未定义 COMPAT_LAYER_MARKER");
    missing += 1;
  } else {
    const head = readLocal(entry).toString("utf8").slice(0, 256);
    if (!head.includes(markerNeed[1])) {
      console.log(`\n兼容层版本标记：✗ compat.js 头部不含 ${markerNeed[1]}`);
      missing += 1;
    } else {
      console.log(`\n兼容层版本标记：✓ ${markerNeed[1]}（与 RuntimeInstaller 一致）`);
    }
  }
}

// ---------------------------------------------------------------- PTY 绑定版本标记
// 同锚点 6 的道理：老设备上可能留着早期构建注入的抛错空壳，文件在但终端必报错。
// 断言 zip 里包装层首行的标记与 RuntimeInstaller.PTY_NODE_MARKER 一致。
{
  const markerNeed = /PTY_NODE_MARKER\s*=\s*"([^"]+)"/.exec(
    readFileSync(join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"), "utf8"),
  );
  const entry = byName.get("lib/node_modules/node-pty/lib/index.js");
  if (!entry) {
    console.log("PTY 绑定版本标记：✗ 条目缺失，跳过");
  } else if (markerNeed === null) {
    console.log("PTY 绑定版本标记：✗ RuntimeInstaller.kt 未定义 PTY_NODE_MARKER");
    missing += 1;
  } else {
    const head = readLocal(entry).toString("utf8").slice(0, 256);
    if (!head.includes(markerNeed[1])) {
      console.log(`PTY 绑定版本标记：✗ node-pty/lib/index.js 头部不含 ${markerNeed[1]}`);
      missing += 1;
    } else {
      console.log(`PTY 绑定版本标记：✓ ${markerNeed[1]}（与 RuntimeInstaller 一致）`);
    }
  }
  // 原生模块必须是 ELF 共享库：空文件或被文本占位会一路通过存在性检查，
  // 直到用户点开终端才炸。
  const bin = byName.get("lib/node_modules/node-pty/prebuilds/android-arm64/dsh_pty_node.node");
  if (bin) {
    const buf = readLocal(bin);
    const isElf = buf.length > 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
    if (!isElf) {
      console.log("PTY 原生模块：✗ 不是 ELF 共享库");
      missing += 1;
    } else {
      console.log(`PTY 原生模块：✓ ELF，${buf.length} B`);
    }
  }
}

// ---------------------------------------------------------------- 宿主插件版本标记
// 同锚点 6/7 的道理：锚点 5 只判 kxxy-host/package.json 存在，而它从 v0.1.0 起
// 内容未变；「改了 host.js 却只重装 APK」的设备会一直跑旧插件。
// 断言 zip 里插件入口首行的标记与 RuntimeInstaller.HOST_PLUGIN_MARKER 一致。
{
  const markerNeed = /HOST_PLUGIN_MARKER\s*=\s*"([^"]+)"/.exec(
    readFileSync(join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"), "utf8"),
  );
  const entry = byName.get("lib/node_modules/kxxy-host/lib/index.js");
  if (!entry) {
    console.log("宿主插件版本标记：✗ 条目缺失，跳过");
  } else if (markerNeed === null) {
    console.log("宿主插件版本标记：✗ RuntimeInstaller.kt 未定义 HOST_PLUGIN_MARKER");
    missing += 1;
  } else {
    const head = readLocal(entry).toString("utf8").slice(0, 256);
    if (!head.includes(markerNeed[1])) {
      console.log(`宿主插件版本标记：✗ lib/index.js 头部不含 ${markerNeed[1]}`);
      missing += 1;
    } else {
      console.log(`宿主插件版本标记：✓ ${markerNeed[1]}（与 RuntimeInstaller 一致）`);
    }
  }
}

// ---------------------------------------------------------------- manifest
const mf = byName.get("kxxy-runtime.json");
if (!mf) throw new Error("缺 kxxy-runtime.json");
const mfData = readLocal(mf);
const manifest = JSON.parse(mfData.toString("utf8"));
console.log(`\nmanifest: runtimeVersion=${manifest.runtimeVersion} entries=${manifest.entries} ` +
  `links=${manifest.linkEntries} placeholderPaths=${manifest.placeholderPaths?.length} removed=${manifest.removedPaths?.length}`);

// ---------------------------------------------------------------- 占位符核对
console.log("\n占位符抽查（应出现 @DSH_ROOT@ 且不含 com.termux）：");
for (const n of ["bin/am", "bin/pkg", "bin/termux-open", "libexec/git-core/git-subtree"]) {
  const e = byName.get(n);
  if (!e) { console.log(`  ? ${n} 不存在`); continue; }
  const text = readLocal(e).toString("latin1");
  const hasPh = text.includes("@DSH_ROOT@");
  const hasTermux = text.includes("com.termux");
  console.log(`  ${hasPh ? "✓" : "✗"} ${n}  @DSH_ROOT@=${hasPh}  com.termux=${hasTermux}`);
}

// ---------------------------------------------------------------- 残留 com.termux 扫描（全量脚本）
//
// 必须过滤 ELF：320 个二进制的 RUNPATH 里就写着 Termux prefix，那是预期内的
// （Android linker 读 RUNPATH 之前先读 LD_LIBRARY_PATH，EngineConfig 已把
// `<root>/lib` 放首位），只有**文本脚本**里的残留才是真问题。
let scanned = 0;
let elfSkipped = 0;
const leftover = [];
for (const e of files) {
  if (!/\.(sh|bash)$|^bin\/|^libexec\/|^etc\/|^var\//.test(e.name)) continue;
  if (e.usize === 0 || e.usize > (1 << 20)) continue;
  scanned += 1;
  const raw = readLocal(e);
  if (raw.length >= 4 && raw[0] === 0x7f && raw[1] === 0x45 && raw[2] === 0x4c && raw[3] === 0x46) {
    elfSkipped += 1;
    continue;
  }
  const text = raw.toString("latin1");
  const at = text.indexOf("com.termux");
  if (at < 0) continue;
  // 取命中处的完整路径 token，便于判断是「文件已处理但正文另有引用」还是「漏改」
  const lineStart = text.lastIndexOf("\n", at) + 1;
  const lineEnd = text.indexOf("\n", at);
  leftover.push({ path: e.name, line: text.slice(lineStart, lineEnd < 0 ? at + 80 : lineEnd).trim().slice(0, 120) });
}
console.log(`\n残留扫描：检查 ${scanned} 个候选（跳过 ELF ${elfSkipped}），文本里仍含 com.termux 的 ${leftover.length} 个`);
for (const r of leftover) console.log(`  ! ${r.path}\n      ${r.line}`);

console.log(`\n结论：${missing === 0 ? "全部关键条目齐备" : `${missing} 个关键条目缺失`}`);

function readLocal(e) {
  const lp = e.localOffset;
  if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error(`本地头签名错误 @${lp} for ${e.name}`);
  const nameLen = buf.readUInt16LE(lp + 26);
  const extraLen = buf.readUInt16LE(lp + 28);
  const start = lp + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.csize);
  if (e.method === 0) return raw;
  return inflateRawSync(raw);
}
