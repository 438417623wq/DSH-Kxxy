/**
 * 校验 build-runtime.mjs 的产物：runtime.zip 的中央目录、LINK 注释、
 * 占位符改写结果与关键文件存在性。
 *
 * 用法：node tools/verify-runtime.mjs [zip 路径]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync, inflateRawSync } from "node:zlib";
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
  // Tesseract 简体中文语言包（锚点 12）。Termux 的 tesseract 包只带
  // eng.traineddata，索引里也没有任何 tesseract-lang* 包 —— 中文识别能力
  // 只能靠随 runtime 内置。缺了它的表现是 `tesseract -l chi_sim` 直接报错。
  "lib/node_modules/kxxy-host/tessdata.version",
  "share/tessdata/chi_sim.traineddata",
  "lib/node_modules/kxxy-host/texlive.version",
  "share/texlive/2026.0/texmf-dist/tex/latex/base/article.cls",
  "share/texlive/2026.0/texmf-dist/tex/plain/base/plain.tex",
  "share/texlive/2026.0/tlpkg/TeXLive/TLConfig.pm",
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

// ---------------------------------------------------------------- 中文语言包版本标记
// 锚点 12：与 office 资产同型 —— 新增资产 + runtime 版本戳从未变过 ⇒ 不加锚点
// 老设备会跳过重装。这里断言标记文件与 RuntimeInstaller.TESSDATA_MARKER 一致，
// 并复核语言包主体确实是 tessdata 格式（截断或下到 HTML 错误页都能「存在」）。
{
  const kt = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"),
    "utf8",
  );
  const markerNeed = /TESSDATA_MARKER\s*=\s*"([^"]+)"/.exec(kt);
  const markerFile = /TESSDATA_MARKER_FILE\s*=\s*"([^"]+)"/.exec(kt);
  const langFile = /TESSDATA_LANGUAGE_FILE\s*=\s*"([^"]+)"/.exec(kt);
  const entry = markerFile === null ? void 0 : byName.get(markerFile[1]);
  if (markerNeed === null || markerFile === null || langFile === null) {
    console.log("中文语言包标记：✗ RuntimeInstaller.kt 未定义 TESSDATA_MARKER/MARKER_FILE/LANGUAGE_FILE");
    missing += 1;
  } else if (!entry) {
    console.log(`中文语言包标记：✗ 条目缺失 ${markerFile[1]}`);
    missing += 1;
  } else {
    const head = readLocal(entry).toString("utf8").slice(0, 256);
    if (!head.includes(markerNeed[1])) {
      console.log(`中文语言包标记：✗ 标记文件不含 ${markerNeed[1]}`);
      missing += 1;
    } else {
      console.log(`中文语言包标记：✓ ${markerNeed[1]}（与 RuntimeInstaller 一致）`);
    }
  }
  const langEntry = langFile === null ? void 0 : byName.get(langFile[1]);
  if (langEntry) {
    const buf = readLocal(langEntry);
    const magic = `${buf[0].toString(16).padStart(2, "0")} ${buf[1].toString(16).padStart(2, "0")} ${buf[2].toString(16).padStart(2, "0")} ${buf[3].toString(16).padStart(2, "0")}`;
    if (magic !== "18 00 00 00") {
      console.log(`中文语言包主体：✗ 魔数 ${magic}（期望 18 00 00 00，tessdata_fast 格式）`);
      missing += 1;
    } else if (buf.length < 1_000_000) {
      console.log(`中文语言包主体：✗ 体积异常 ${buf.length} B（期望约 2.4 MiB）`);
      missing += 1;
    } else {
      console.log(`中文语言包主体：✓ tessdata 格式 ${buf.length} B`);
    }
  }
}

// ---------------------------------------------------------------- TeX Live 宏包树标记
// 锚点 13：Termux 的 texlive-bin deb 只发引擎，`tex/latex`/`tex/plain`/`tlpkg` 全为
// 0 条 —— 宏包树由构建期从 CTAN 取 scheme-basic 打进 runtime。这里断言标记文件与
// RuntimeInstaller.TEXLIVE_MARKER 一致，并复核三个标志性文件确实在位（宏包树是
// 5900 个文件，写入中途失败会留下半棵树，而半棵树照样能过 `pdftex --version`）。
{
  const kt = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"),
    "utf8",
  );
  const markerNeed = /TEXLIVE_MARKER\s*=\s*"([^"]+)"/.exec(kt);
  const markerFile = /TEXLIVE_MARKER_FILE\s*=\s*"([^"]+)"/.exec(kt);
  const coreBlock = /TEXLIVE_CORE_FILES\s*=\s*listOf\(([\s\S]*?)\)/.exec(kt);
  const core = coreBlock === null
    ? []
    : [...coreBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const entry = markerFile === null ? void 0 : byName.get(markerFile[1]);
  if (markerNeed === null || markerFile === null || core.length === 0) {
    console.log("TeX Live 宏包树标记：✗ RuntimeInstaller.kt 未定义 TEXLIVE_MARKER/MARKER_FILE/CORE_FILES");
    missing += 1;
  } else if (!entry) {
    console.log(`TeX Live 宏包树标记：✗ 条目缺失 ${markerFile[1]}`);
    missing += 1;
  } else {
    const head = readLocal(entry).toString("utf8").slice(0, 256);
    if (!head.includes(markerNeed[1])) {
      console.log(`TeX Live 宏包树标记：✗ 标记文件不含 ${markerNeed[1]}`);
      missing += 1;
    } else {
      console.log(`TeX Live 宏包树标记：✓ ${markerNeed[1]}（与 RuntimeInstaller 一致）`);
    }
  }
  for (const rel of core) {
    const e = byName.get(rel);
    if (!e) {
      console.log(`TeX Live 宏包树主体：✗ 条目缺失 ${rel}`);
      missing += 1;
      continue;
    }
    const size = readLocal(e).length;
    if (size === 0) {
      console.log(`TeX Live 宏包树主体：✗ ${rel} 是空文件`);
      missing += 1;
    } else {
      console.log(`TeX Live 宏包树主体：✓ ${rel.split("/").pop()}（${size} B）`);
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

// ---------------------------------------------------------------- 构建期补丁真的落到 bundle 里
// 锚点 11 只证明 `patchset.version` 这个**标记文件**在、且与 Kotlin 一致，
// 它不证明补丁内容真的写进了上游 bundle。真机事故正是这样发生的：标记文件
// 在、所有锚点都过、isComplete() 判真跳过重装，而设备上的 documentpreview
// 仍是未打补丁的旧文件。
//
// 这里直接开 zip 里的上游 bundle 数特征函数：文件在、但特征串不在，说明
// 构建期 `applyAllPatches` 没跑到（或锚点漂了被静默跳过），必须报出来。
{
  const BUNDLE_CHECKS = [
    {
      entry: "lib/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js",
      // 归档预览（zip / epub）与音视频预览各自的入口 + 收尾调用。
      needles: [
        ["function kxxyArchiveApply(", "归档 provider 片段"],
        ["function kxxyMediaApply(", "音视频 provider 片段"],
        ["kxxyArchiveApply(ctx);", "归档 provider 收尾调用"],
        ["kxxyMediaApply(ctx);", "音视频 provider 收尾调用"],
        ["/kxxy/media?path=", "音视频指向宿主媒体路由"],
      ],
    },
  ];
  for (const { entry, needles } of BUNDLE_CHECKS) {
    const file = byName.get(entry);
    if (!file) {
      console.log(`\n上游补丁痕迹：✗ ${entry} 缺失，跳过`);
      continue;
    }
    const text = readLocal(file).toString("utf8");
    const absent = needles.filter(([needle]) => !text.includes(needle));
    if (absent.length > 0) {
      for (const [, label] of absent) {
        console.log(`上游补丁痕迹：✗ ${label} 不在 ${entry.split("/").pop()} 里（补丁未生效）`);
      }
      missing += absent.length;
    } else {
      console.log(`\n上游补丁痕迹：✓ 归档与音视频 provider 均已写进 ${entry.split("/").pop()}（${needles.length} 项特征齐备）`);
    }
  }
}

// ---------------------------------------------------------------- 音视频 provider 后缀覆盖
// 「视频打不开」这类缺陷在 HTTP 层完全看不出异常 —— 页面 200、bundle 200，
// 只有用户点开文件才看到「该格式文件暂时无法预览」。这里断言 provider 认领
// 的后缀集合与上游 UNVIEWABLE_BINARY_EXTENSIONS 开头那批音视频后缀一致，
// 避免以后有人改常量时漏掉几个格式。
{
  const entry = byName.get(
    "lib/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js",
  );
  if (entry) {
    const text = readLocal(entry).toString("utf8");
    // 上游把音视频列在黑名单**开头**，这批后缀必须全部被 provider 认领。
    const EXPECTED = [
      "mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v",
      "mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus",
    ];
    const videoExt = /KXXY_MEDIA_VIDEO_EXT = \[([^\]]*)\]/.exec(text);
    const audioExt = /KXXY_MEDIA_AUDIO_EXT = \[([^\]]*)\]/.exec(text);
    if (videoExt === null || audioExt === null) {
      console.log("音视频后缀覆盖：✗ 找不到 KXXY_MEDIA_VIDEO_EXT / KXXY_MEDIA_AUDIO_EXT");
      missing += 1;
    } else {
      const claimed = new Set(
        `${videoExt[1]},${audioExt[1]}`
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase())
          .filter((s) => s !== ""),
      );
      const uncovered = EXPECTED.filter((ext) => !claimed.has(ext));
      if (uncovered.length > 0) {
        console.log(`音视频后缀覆盖：✗ 上游黑名单里有 ${uncovered.join(" / ")} 未被任何 provider 认领`);
        missing += 1;
      } else {
        const n = videoExt[1].split(",").filter((s) => s.trim() !== "").length;
        const m = audioExt[1].split(",").filter((s) => s.trim() !== "").length;
        console.log(`音视频后缀覆盖：✓ 上游黑名单音视频${EXPECTED.length}项全覆盖（视频 ${n} + 音频 ${m}）`);
      }
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

// ---------------------------------------------------------------- 占位符常量自洽
//
// 为什么需要：占位符规则表在 Kotlin 侧是**引用名**，在 build-runtime.mjs 侧是
// **定义值**。两边靠「逐字相同」维系，但没有编译期关联 —— 真机上出现过
// `rewriteRootPlaceholder` 的规则表引用了 HOME_PLACEHOLDER / TMP_PLACEHOLDER /
// FILES_PLACEHOLDER / DATA_PLACEHOLDER 四个**从未定义**的常量，Kotlin 编译期
// 直接报 Unresolved reference（和缺陷 O 的 matchParen、缺陷 AI 的 linkExact 同型：
// 引用了不存在的标识符）。这里做静态自洽检查 —— 凡是形如 `X_PLACEHOLDER` 的
// 标识符，只要在 RuntimeInstaller.kt 里出现过，就必须有 `const val` 定义；
// 两边同名的必须有相同的字面值。
{
  const kt = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"),
    "utf8",
  );
  const build = readFileSync(join(HERE, "..", "tools/build-runtime.mjs"), "utf8");

  const defined = new Map();
  for (const m of kt.matchAll(/const\s+val\s+([A-Z][A-Z0-9_]*_PLACEHOLDER)\s*=\s*"([^"]*)"/g)) {
    defined.set(m[1], m[2]);
  }
  // 剔除定义行本身，只看「被引用」的标识符。
  const referenced = new Set();
  for (const m of kt.matchAll(/\b([A-Z][A-Z0-9_]*_PLACEHOLDER)\b/g)) referenced.add(m[1]);

  const undefinedRefs = [...referenced].filter((n) => !defined.has(n));

  const buildDefs = new Map();
  for (const m of build.matchAll(/const\s+([A-Z][A-Z0-9_]*_PLACEHOLDER)\s*=\s*"([^"]*)"/g)) {
    buildDefs.set(m[1], m[2]);
  }
  const mismatched = [];
  for (const [name, value] of defined) {
    if (buildDefs.has(name) && buildDefs.get(name) !== value) {
      mismatched.push(`${name}: Kotlin=${value} build=${buildDefs.get(name)}`);
    }
  }
  const buildOnly = [...buildDefs.keys()].filter((n) => !defined.has(n));

  if (undefinedRefs.length > 0 || mismatched.length > 0 || buildOnly.length > 0) {
    console.log("占位符常量自洽：✗");
    for (const n of undefinedRefs) console.log(`  引用了未定义的常量：${n}`);
    for (const s of mismatched) console.log(`  两侧字面值不一致：${s}`);
    for (const n of buildOnly) console.log(`  仅 build-runtime.mjs 有定义：${n}`);
    missing += 1;
  } else {
    console.log(`占位符常量自洽：✓ ${defined.size} 条（Kotlin 与 build-runtime.mjs 逐字一致，无未定义引用）`);
  }
}

// ---------------------------------------------------------------- 递归删除不跟随软链
//
// 为什么需要：runtime 重装时的「精确顶层替换」会删掉 zip 里出现过的顶层目录。
// Kotlin 的 `File.deleteRecursively()` 是 walkBottomUp + listFiles()，对「指向
// 目录的软链」会**跟随进去** —— 删掉的是链接目标（`extensions/<id>/…`）里的
// 真实内容，而不是软链本身。而扩展装配恰恰会在 `bin/ lib/ etc/ share/` 下留下
// 这类目录软链（`engine/bin/texlive -> extensions/texlive/bin/texlive`）。
//
// 实测事故（layout 2 时代的设备）：texlive 的 411 个 TeX 引擎、rust 的
// `lib/rustlib`、gdb 的 `share/guile` 全部被整片删除，且自愈路径 relinkAll 也
// 救不回来（清单里的 src 已不存在）。这里做静态检查：RuntimeInstaller.kt 里
// 不得对顶层目录直接调用 deleteRecursively，必须有 deleteTreeSafely 且被使用。
{
  const kt = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"),
    "utf8",
  );
  const problems = [];
  if (!/private\s+fun\s+deleteTreeSafely\s*\(/.test(kt)) {
    problems.push("缺少 deleteTreeSafely 定义");
  }
  if (!/Files\.isSymbolicLink\(/.test(kt)) {
    problems.push("deleteTreeSafely 未用 Files.isSymbolicLink 判链接（可能仍会跟随软链）");
  }
  // 顶层替换那一段必须是 deleteTreeSafely(target)
  const topLoop = kt.match(/for\s*\(top in index\.topLevelDirs\)[\s\S]{0,400}?\n\s*}/);
  if (!topLoop) {
    problems.push("找不到 topLevelDirs 的删除循环");
  } else if (!/deleteTreeSafely\(/.test(topLoop[0])) {
    problems.push("顶层替换仍在直接删除（应改为 deleteTreeSafely）");
  } else if (/deleteRecursively\(/.test(topLoop[0])) {
    problems.push("顶层替换仍含 deleteRecursively");
  }
  if (problems.length > 0) {
    console.log("递归删除安全：✗");
    for (const p of problems) console.log(`  ${p}`);
    missing += 1;
  } else {
    console.log("递归删除安全：✓ 顶层替换用 deleteTreeSafely（不跟随符号链接）");
  }
}

// ---------------------------------------------------------------- 桩库剔除
//
// 为什么需要：`libandroid-stub_30-1` 的 5 个桩库里，`lib/libbinder_ndk.so`
// （24,000 B，soname=null）会遮蔽 `/system/lib64/libbinder_ndk.so`（94,488 B，
// 带 `LIBAIBINDER` 版本定义）。`EngineConfig.buildEnv` 把 `<root>/lib` 放在
// `LD_LIBRARY_PATH` 首位，于是 `/system/lib64/libui.so` 的 verneed 找不到带
// 版本定义的 binder ⇒ `ffmpeg`/`ffprobe` 报
// `cannot find "libbinder_ndk.so" from verneed[0] in DT_NEEDED list`（措辞像
// 「文件缺失」，实际是「版本符号缺失」）。真机 A/B 逐个挪走的结论：只有删掉
// 这一个能让 ffmpeg 恢复，其余四个（尤其 `libmediandk.so`）必须保留 ——
// 删了 mediandk 会让系统 `libunwindstack.so` 报 `cannot locate symbol
// "Xzs_Construct"`。全树 3,577 个 ELF64 里 `DT_NEEDED` 引用它的有 0 个。
//
// 缺陷 BH 追加 `lib/liblzma.so`：它不是「桩库太小」，而是 soname 与裸名不一致。
// zip 里它是 `LINK:lib/liblzma.so.5.8.4` 的软链，内容是 liblzma 5.8.4
// （soname `liblzma.so.5`、114 个 `lzma_*`、`Xzs_*` 零个），而系统的
// `/system/lib64/liblzma.so` 是 164,576 B、soname `liblzma.so`、230 个符号、
// 含 5 个 `Xzs_*` —— 两者根本不是同一个库。系统 `libui.so` → `libunwindstack.so`
// 那条链 NEEDED 的是**裸名**，于是命中引擎这个文件，报
// `cannot locate symbol "Xzs_Construct" referenced by "/system/lib64/libunwindstack.so"`。
// 全引擎 3,569 个 ELF64 里 NEEDED 裸名 `liblzma.so` 的有 0 个（消费者一律用
// `liblzma.so.5`，共 50 个），所以删掉裸名零副作用。
{
  const problems = [];
  if (byName.get("lib/libbinder_ndk.so")) {
    problems.push("lib/libbinder_ndk.so 仍在（会遮蔽系统真库，ffmpeg/ffprobe 起不来）");
  }
  if (byName.get("lib/liblzma.so")) {
    problems.push(
      "lib/liblzma.so 仍在（soname 是 liblzma.so.5，会让系统 libunwindstack.so 找不到 Xzs_Construct）",
    );
  }
  for (const keep of [
    "lib/libandroid.so",
    "lib/libmediandk.so",
    "lib/libOpenSLES.so",
    "lib/libtermux-platform-ns.so",
    "lib/liblzma.so.5",
    "lib/liblzma.so.5.8.4",
  ]) {
    if (!byName.get(keep)) problems.push(`误删了必须保留的库：${keep}`);
  }
  if (problems.length > 0) {
    console.log("桩库剔除：✗");
    for (const p of problems) console.log(`  ${p}`);
    missing += 1;
  } else {
    console.log("桩库剔除：✓ libbinder_ndk.so + liblzma.so（裸名）已剔除，其余桩库与 liblzma.so.5 保留");
  }
}

// ---------------------------------------------------------------- 字符集映射
//
// 为什么需要：`PRUNE_EXT` 里曾有一条 `.map`（本意是裁 JS sourcemap），但扩展池里
// 带 `.map` 的只有两个包，而且全是要用的数据文件 —— emacs 的
// `share/emacs/<版本>/etc/charsets/*.map`（131 个 / 2.8 MiB，字符集映射表）和
// texlive-bin 的 3 个字体映射。缺了前者，`emacs --batch` 直接报
// `Error: file-missing ("Loading charset map" "No such file or directory" "8859-2")`
// + `Emacs will not function correctly without the character map files.`，
// 连版本号都打不全（缺陷 BA）。
//
// 检查对象是 ext-pool 里的 emacs.pool（不是 runtime.zip）—— 扩展池是独立产物，
// 由 tools/fetch-extensions.mjs 生成。
{
  const poolDir = join(HERE, "..", "android", "app", "src", "main", "assets", "ext-pool");
  const emacsPool = join(poolDir, "emacs.pool");
  const problems = [];
  if (!existsSync(emacsPool)) {
    problems.push("emacs.pool 不存在（扩展池未生成）");
  } else {
    // 池是 gzip 的 tar，只能扫 tar 头里能直接看到的路径名 —— 不解压，
    // 用 inflateRawSync 解 gzip 再逐块找文件名太慢（53 MB）。
    // 改用 tar 头遍历：读 512 字节块，看 name 字段。
    const buf = readFileSync(emacsPool);
    const tarBuf = gunzipSync(buf);
    let off = 0;
    let charsetCount = 0;
    let saw8859 = false;
    while (off + 512 <= tarBuf.length) {
      const header = tarBuf.subarray(off, off + 512);
      // 全零块 = 归档结束
      if (header.every((b) => b === 0)) break;
      let nameEnd = header.indexOf(0);
      if (nameEnd < 0) nameEnd = 100;
      const name = header.subarray(0, nameEnd).toString("utf8");
      const sizeStr = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
      const size = parseInt(sizeStr, 8) || 0;
      if (name.includes("/etc/charsets/") && name.endsWith(".map")) {
        charsetCount += 1;
        if (name.endsWith("8859-2.map")) saw8859 = true;
      }
      off += 512 + Math.ceil(size / 512) * 512;
    }
    if (charsetCount < 100) {
      problems.push(`emacs.pool 里字符集映射只有 ${charsetCount} 个（应 ≥100；PRUNE_EXT 里的 .map 又回来了？）`);
    }
    if (!saw8859) {
      problems.push("emacs.pool 里缺 8859-2.map（emacs --batch 会报 Loading charset map 失败）");
    }
    if (problems.length === 0) {
      console.log(`字符集映射：✓ emacs.pool 含 ${charsetCount} 个 charsets/*.map（含 8859-2.map）`);
    }
  }
  if (problems.length > 0) {
    console.log("字符集映射：✗");
    for (const p of problems) console.log(`  ${p}`);
    missing += 1;
  }
}

// ---------------------------------------------------------------- C++ 标准库头
//
// 为什么需要：缺陷 BJ。真机上 `g++` / `clang++` 编译任何 C++ 文件都报
// `fatal error: 'iostream' file not found`。头文件本身是在的（runtime 的
// `include/c++/v1/` 有 1,757 个条目），缺的是「谁告诉 clang 去那儿找」——
// 这个 clang 的驱动只认自己 resource-dir 下的 `lib/clang/21/include`，
// 不会自动加 `<sysroot>/include/c++/v1`。修法是在 EngineConfig 里把它塞进
// `CPATH` / `C_INCLUDE_PATH`。这里做两条静态断言：
//   ① 头文件必须在包里（否则改环境变量也没用）；
//   ② EngineConfig 的 includeDirs 必须真的含 `include/c++/v1`（否则改了环境
//      变量却漏掉这一项，症状与「头文件不在包里」完全一样，极难区分）。
{
  const problems = [];
  const iostream = byName.get("include/c++/v1/iostream");
  if (!iostream) problems.push("runtime.zip 缺 include/c++/v1/iostream");
  const cxxHeaders = entries.filter((e) => e.name.startsWith("include/c++/v1/")).length;
  if (cxxHeaders < 1000) {
    problems.push(`include/c++/v1 只有 ${cxxHeaders} 个条目（应 ≥1000）`);
  }
  const kt = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/EngineConfig.kt"),
    "utf8",
  );
  if (!/File\(root,\s*"include\/c\+\+\/v1"\)/.test(kt)) {
    problems.push("EngineConfig.kt 的 includeDirs 里没有 include/c++/v1（CPATH 补不上）");
  }
  // 链接期的第二层：clang 按 `-lc++` 找 `libc++.so`，而 runtime 只有
  // `libc++_shared.so`。别名由 RuntimeInstaller 的 SONAME_ALIASES 在设备上建。
  const ri = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"),
    "utf8",
  );
  if (!/"libc\+\+\.so"\s+to\s+"libc\+\+_shared\.so"/.test(ri)) {
    problems.push("RuntimeInstaller.kt 的 SONAME_ALIASES 里没有 libc++.so → libc++_shared.so");
  }
  if (!/materialiseSonameAliases\(root\)/.test(ri)) {
    problems.push("RuntimeInstaller.kt 没有在启动路径上调用 materialiseSonameAliases（别名不会自愈）");
  }
  if (problems.length === 0) {
    console.log(`C++ 标准库头：✓ include/c++/v1 有 ${cxxHeaders} 个条目，CPATH 与链接别名均就位`);
  } else {
    console.log("C++ 标准库头：✗");
    for (const p of problems) console.log(`  ${p}`);
    missing += 1;
  }
}

// ---------------------------------------------------------------- 扩展目录与 jansi
//
// 为什么需要：缺陷 BI～BO 一次性补了 5 个扩展（maven / php / ruby / erlang /
// yarn），它们的可见性完全依赖 `lib/node_modules/kxxy-host/extensions.json`
// 这一个文件 —— 那个文件被 `.gitignore` 忽略，只靠 build-runtime 从工作区读进来
// 打进 zip。漏打的表现是「池文件都在设备上、扩展页却一张卡都没有」，与
// 「池没生成」完全同型。
//
// jansi 那半边：缺陷 BM。jansi 2.4.0 的 `Linux/arm64/libjansi.so` 的
// DT_NEEDED 只有 `libc.so.6`，Android 的 bionic 只有 `libc.so` ⇒ 必然 dlopen
// 失败。失败本身被 graceful 吞掉，但 `loadNativeLibrary` 会把异常 println 到
// stderr，每次 JVM 启动都刷两行吓人的 `UnsatisfiedLinkError`。构建期由
// `tools/lib/poolextract.py` 的 `strip_jansi_native()` 把 jar 内 native 资源
// 连目录一起删掉（`JansiLoader.hasResource()` 判的是目录，只删文件不够）。
{
  const problems = [];
  const catalogEntry = byName.get("lib/node_modules/kxxy-host/extensions.json");
  if (!catalogEntry) {
    problems.push("runtime.zip 里没有 lib/node_modules/kxxy-host/extensions.json");
  } else {
    const catalog = JSON.parse(readLocal(catalogEntry).toString("utf8"));
    const ids = (catalog.items ?? []).map((i) => i.id);
    if (ids.length < 25) problems.push(`扩展目录只有 ${ids.length} 项（应 ≥25）`);
    for (const need of ["maven", "php", "ruby", "erlang", "yarn"]) {
      if (!ids.includes(need)) problems.push(`扩展目录缺 ${need}`);
    }
    console.log(`扩展目录：${ids.length} 项 — ${ids.join(" ")}`);
  }

  // jansi：扫所有 pool 里的 jar，断言 native 条目为 0。
  const poolDir = join(HERE, "..", "android", "app", "src", "main", "assets", "ext-pool");
  const JANSI = "org/fusesource/jansi/internal/native/";
  let jarsScanned = 0;
  let jansiHits = 0;
  const hitDetail = [];
  if (existsSync(poolDir)) {
    for (const f of readdirSync(poolDir)) {
      if (!f.endsWith(".pool")) continue;
      let tarBuf;
      try {
        tarBuf = gunzipSync(readFileSync(join(poolDir, f)));
      } catch {
        continue;
      }
      let off = 0;
      while (off + 512 <= tarBuf.length) {
        const header = tarBuf.subarray(off, off + 512);
        if (header.every((b) => b === 0)) break;
        let nameEnd = header.indexOf(0);
        if (nameEnd < 0) nameEnd = 100;
        const name = header.subarray(0, nameEnd).toString("utf8");
        const sizeStr = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
        const size = parseInt(sizeStr, 8) || 0;
        const dataStart = off + 512;
        if (name.endsWith(".jar")) {
          jarsScanned += 1;
          // 必须**真正解析 zip 中央目录**，不能拿原始字节搜字符串 ——
          // 首版就是那么写的，结果被 `kotlin-compiler-embeddable-2.4.10.jar`
          // 报了一次假阳性：那个 jar 里 jansi 已被 shade 成
          // `org/jetbrains/kotlin/org/fusesource/jansi/…`（native 条目 0 个），
          // 但某个 class 的常量池里留着原包名字符串，字节扫描照样命中。
          const slice = tarBuf.subarray(dataStart, dataStart + size);
          const names = jarEntryNames(slice);
          if (names.some((n) => n.startsWith(JANSI))) {
            jansiHits += 1;
            hitDetail.push(`${f}:${name}`);
          }
        }
        off += 512 + Math.ceil(size / 512) * 512;
      }
    }
  }
  if (jansiHits > 0) {
    problems.push(`仍有 ${jansiHits} 个 jar 带 jansi native 资源（strip_jansi_native 没生效？）`);
    for (const d of hitDetail.slice(0, 8)) console.log(`  ! ${d}`);
  }

  if (problems.length === 0) {
    console.log(`jansi native 剥离：✓ 扫描 ${jarsScanned} 个 jar，命中 0`);
  } else {
    console.log("扩展目录 / jansi：✗");
    for (const p of problems) console.log(`  ${p}`);
    missing += 1;
  }
}

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

/**
 * 从一个 jar 的原始字节里解析出**全部条目名**（只读中央目录，不解压内容）。
 *
 * 为什么不用第三方库：这个仓库的校验脚本一律零依赖（只用 node: 内置模块），
 * 且中央目录结构极简 —— 末尾找 EOCD（`PK\x05\x06`），读条目数与偏移，
 * 再逐条读 `PK\x01\x02` 头里的文件名长度与文件名。
 */
function jarEntryNames(zipBuf) {
  const names = [];
  // EOCD 在最末尾 22 + 最多 65535 字节注释内，从后往前找签名。
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 22 - 65535); i -= 1) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return names;
  const count = zipBuf.readUInt16LE(eocd + 10);
  let off = zipBuf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (off + 46 > zipBuf.length || zipBuf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = zipBuf.readUInt16LE(off + 28);
    const extraLen = zipBuf.readUInt16LE(off + 30);
    const commentLen = zipBuf.readUInt16LE(off + 32);
    names.push(zipBuf.subarray(off + 46, off + 46 + nameLen).toString("utf8"));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
