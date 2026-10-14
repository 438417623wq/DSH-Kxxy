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
  // 现代内建补齐层（锚点 6 的第二份资产）：补齐 Chrome 105–139 才有的 JS
  // 内建，并把同一份源码前置进 blob worker / blob iframe。缺了它，PDF 渲染
  // worker 与 HTML 预览 iframe 都会在独立全局里抛 ReferenceError
  "lib/node_modules/kxxy-host/web/modern.js",
  // Android 原生 PTY 绑定：上游 createProcessInspector 不认 android，
  // 且 node-pty 无 Android 预编译产物，缺了它「新建终端」必定报错
  // （见 RuntimeInstaller 锚点 7，以及下面单独的版本标记断言）
  "lib/node_modules/node-pty/package.json",
  "lib/node_modules/node-pty/lib/index.js",
  "lib/node_modules/node-pty/prebuilds/android-arm64/dsh_pty_node.node",
  // 内置的第三方移动端 UI 插件（锚点 10）：整包随 runtime 发布，由
  // `dsh-client-modules` 扫 Loader entries 发现。缺了它手机上是官方桌面
  // 布局，不报错、不留日志。
  "lib/node_modules/dsh-web-mobile/package.json",
  "lib/node_modules/dsh-web-mobile/lib/client.js",
  "lib/node_modules/dsh-web-mobile/lib/index.js",
  "lib/node_modules/dsh-web-mobile/cordis.patch.yml",
  "lib/node_modules/dsh-web-mobile/plugin.version",
  // office 预览链（锚点 9）：LibreOffice wasm 引擎 + 单文件 CJK 字体。
  // 两者都是「新增资产」而 RUNTIME_VERSION 从未变过 —— 缺了它们老设备
  // 前面的锚点全过、跳过重装，Office 预览永远报「Office 预览不可用」。
  "lib/node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/soffice.wasm",
  "lib/node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/soffice.data",
  "lib/node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/soffice.cjs",
  "lib/node_modules/@deepseek-ai/libreoffice-kit-wasm/prebuilds.json",
  "lib/node_modules/kxxy-host/fonts/office-assets.version",
  "lib/node_modules/kxxy-host/fonts/NotoSansSC-Regular.ttf",
  "lib/node_modules/kxxy-host/fonts/NotoSansSC-Bold.ttf",
  // 构建期补丁集版本标记（锚点 11）。前面的锚点探的全是自有资产与内置插件，
  // 而补丁改的是上游文件（documentpreview 的 client.js / client.pdf.js、
  // libreoffice-kit、dsh-office-to-pdf …），它们没有版本标记可探 ——
  // 补丁是否落地只能靠它判定。
  "lib/node_modules/kxxy-host/patchset.version",
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

// ---------------------------------------------------------------- 现代内建补齐层版本标记
// 锚点 6 的第二段判定（与 compat.js 同一锚点、独立标记）：modern.js 补齐
// Chrome 105–139 才有的 JS 内建，并包装 URL.createObjectURL 把同一份源码注入
// blob worker / blob iframe。缺它时右侧栏 PDF 报「渲染进程无法继续」、
// HTML 预览整片空白，而页面主作用域看起来完全正常。
{
  const markerNeed = /MODERN_LAYER_MARKER\s*=\s*"([^"]+)"/.exec(
    readFileSync(join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"), "utf8"),
  );
  const entry = byName.get("lib/node_modules/kxxy-host/web/modern.js");
  if (!entry) {
    console.log("现代内建补齐层版本标记：✗ 条目缺失，跳过");
    missing += 1;
  } else if (markerNeed === null) {
    console.log("现代内建补齐层版本标记：✗ RuntimeInstaller.kt 未定义 MODERN_LAYER_MARKER");
    missing += 1;
  } else {
    const head = readLocal(entry).toString("utf8").slice(0, 256);
    if (!head.includes(markerNeed[1])) {
      console.log(`现代内建补齐层版本标记：✗ modern.js 头部不含 ${markerNeed[1]}`);
      missing += 1;
    } else {
      console.log(`现代内建补齐层版本标记：✓ ${markerNeed[1]}（与 RuntimeInstaller 一致）`);
    }
  }
}

// ---------------------------------------------------------------- office 资产版本标记
// 锚点 10：LibreOffice wasm 引擎与单文件 CJK 字体是随 runtime 发的「新增资产」，
// 而 RUNTIME_VERSION 从未变过 —— 老设备前九锚点全过、跳过重装，设备上永远没有
// 这两份文件，Office 预览一直报「Office 预览不可用」。断言标记文件内容与
// RuntimeInstaller.OFFICE_LAYER_MARKER 一致，并校验两份字体的 sfnt 魔数
// （0x00010000 或 "true"/"OTTO"），防止把空文件或占位文本写进 zip。
{
  const markerNeed = /OFFICE_LAYER_MARKER\s*=\s*"([^"]+)"/.exec(
    readFileSync(join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"), "utf8"),
  );
  const entry = byName.get("lib/node_modules/kxxy-host/fonts/office-assets.version");
  if (!entry) {
    console.log("office 资产版本标记：✗ 条目缺失");
    missing += 1;
  } else if (markerNeed === null) {
    console.log("office 资产版本标记：✗ RuntimeInstaller.kt 未定义 OFFICE_LAYER_MARKER");
    missing += 1;
  } else {
    const head = readLocal(entry).toString("utf8").slice(0, 256);
    if (!head.includes(markerNeed[1])) {
      console.log(`office 资产版本标记：✗ 标记文件不含 ${markerNeed[1]}`);
      missing += 1;
    } else {
      console.log(`office 资产版本标记：✓ ${markerNeed[1]}（与 RuntimeInstaller 一致）`);
    }
  }

  for (const name of [
    "lib/node_modules/kxxy-host/fonts/NotoSansSC-Regular.ttf",
    "lib/node_modules/kxxy-host/fonts/NotoSansSC-Bold.ttf",
  ]) {
    const font = byName.get(name);
    if (!font) continue;   // 缺失已由 NEED 循环报过
    const buf = readLocal(font);
    const tag = buf.length >= 4 ? buf.readUInt32BE(0) : 0;
    const isSfnt = tag === 0x00010000 || tag === 0x74727565 /* true */ || tag === 0x4f54544f /* OTTO */;
    if (!isSfnt) {
      console.log(`office 字体：✗ ${name.split("/").pop()} 不是 sfnt（首 4 字节 0x${tag.toString(16)}）`);
      missing += 1;
    } else {
      console.log(`office 字体：✓ ${name.split("/").pop()} sfnt，${buf.length} B`);
    }
  }
}

// ---------------------------------------------------------------- 补丁集版本标记
// 锚点 11：前十个锚点探的全是自有资产，而补丁改的是上游文件（documentpreview
// 的 client.js / client.pdf.js、libreoffice-kit、dsh-office-to-pdf …），它们
// 没有版本标记可探。真机事故：补上 zip / epub provider、重建 runtime 与 APK
// 装机后，设备上 `grep -c kxxyArchiveApply` 仍是 0 —— isComplete() 判真跳过重装。
// 这里断言 zip 里的标记文件与 RuntimeInstaller.PATCHSET_MARKER 一致。
{
  const markerNeed = /PATCHSET_MARKER\s*=\s*"([^"]+)"/.exec(
    readFileSync(join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"), "utf8"),
  );
  const entry = byName.get("lib/node_modules/kxxy-host/patchset.version");
  if (!entry) {
    console.log("补丁集版本标记：✗ 条目缺失");
    missing += 1;
  } else if (markerNeed === null) {
    console.log("补丁集版本标记：✗ RuntimeInstaller.kt 未定义 PATCHSET_MARKER");
    missing += 1;
  } else {
    const head = readLocal(entry).toString("utf8").slice(0, 256);
    if (!head.includes(markerNeed[1])) {
      console.log(`补丁集版本标记：✗ 标记文件不含 ${markerNeed[1]}`);
      missing += 1;
    } else {
      console.log(`补丁集版本标记：✓ ${markerNeed[1]}（与 RuntimeInstaller 一致）`);
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

// ---------------------------------------------------------------- 内置移动端插件版本标记
// 锚点 10：dsh-web-mobile 是随 runtime 发的**第三方整包**。它既不进
// @deepseek-ai 文件计数（锚点 4），也不属于 kxxy-host（锚点 5/8），缺了它
// 手机上是官方桌面布局 —— 不报错、不留日志，属于最难排查的一类。
// 这里断言：标记文件内容与 RuntimeInstaller.MOBILE_PLUGIN_MARKER 一致，
// 且插件确实写进了 `@deepseek-ai/dsh` 的 dependencies（否则 dsh-app-boot 的
// installation scope 解析不出它，文件都在却永远不激活）。
{
  const kotlin = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"), "utf8",
  );
  const markerNeed = /MOBILE_PLUGIN_MARKER\s*=\s*"([^"]+)"/.exec(kotlin);
  const entry = byName.get("lib/node_modules/dsh-web-mobile/plugin.version");
  if (!entry) {
    console.log("移动端插件版本标记：✗ 条目缺失");
    missing += 1;
  } else if (markerNeed === null) {
    console.log("移动端插件版本标记：✗ RuntimeInstaller.kt 未定义 MOBILE_PLUGIN_MARKER");
    missing += 1;
  } else {
    const head = readLocal(entry).toString("utf8").slice(0, 256);
    if (!head.includes(markerNeed[1])) {
      console.log(`移动端插件版本标记：✗ 标记文件不含 ${markerNeed[1]}`);
      missing += 1;
    } else {
      console.log(`移动端插件版本标记：✓ ${markerNeed[1]}（与 RuntimeInstaller 一致）`);
    }
  }

  // 客户端半区的存在性：package.json 声明了 dsh.client 就必须能解析出
  // `./client` 入口，否则 dsh-client-modules 在 resolveMeta 阶段直接抛
  // `declares dsh.client but exports no "./client" bundle`，整个 boot 失败。
  const clientEntry = byName.get("lib/node_modules/dsh-web-mobile/lib/client.js");
  if (clientEntry) {
    const head = readLocal(clientEntry).toString("utf8").slice(0, 200);
    if (!head.includes("__ModuleLoader__")) {
      console.log("移动端插件客户端半区：✗ lib/client.js 不是模块系统注册形态");
      missing += 1;
    } else {
      console.log("移动端插件客户端半区：✓ lib/client.js 注册进 __ModuleLoader__");
    }
  }

  // installation scope 注册：patchDshManifest 负责写这一行。
  const dshManifest = byName.get("lib/node_modules/@deepseek-ai/dsh/package.json");
  if (dshManifest) {
    const deps = JSON.parse(readLocal(dshManifest).toString("utf8")).dependencies ?? {};
    if (deps["dsh-web-mobile"] === void 0) {
      console.log("移动端插件注册：✗ @deepseek-ai/dsh 的 dependencies 里没有 dsh-web-mobile（补丁未生效）");
      missing += 1;
    } else {
      console.log(`移动端插件注册：✓ dsh-web-mobile@${deps["dsh-web-mobile"]}`);
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
