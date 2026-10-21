/**
 * 校验 build-runtime.mjs 的产物：runtime.zip 的中央目录、LINK 注释、
 * 占位符改写结果与关键文件存在性。
 *
 * 用法：node tools/verify-runtime.mjs [zip 路径]
 */
import { existsSync, createReadStream, readdirSync, readFileSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { createGunzip, gunzipSync, inflateRawSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 找扩展池里的某个 `.pool`。
 *
 * 两个位置都要认：`build-apk.ps1` 会把 `assets/ext-pool/` 整体 `Move-Item`
 * 到 `.cache/apk-assets-hold/ext-pool/`（大资源不能进 APK 的 assets），
 * 所以打完包之后 assets 下是空的、池在 hold 里。只查 assets 会让校验在
 * 「刚打完包」这个最常见的时刻误报「池未生成」。
 */
function resolvePool(name) {
  const dirs = [
    join(HERE, "..", "android", "app", "src", "main", "assets", "ext-pool"),
    join(HERE, "..", ".cache", "apk-assets-hold", "ext-pool"),
  ];
  for (const d of dirs) {
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 流式遍历扩展池（gzip 的 tar），**不**把解压结果整体读进内存。
 *
 * ── 为什么（构建事故）─────────────────────────────────────────────────────
 * 首版是 `gunzipSync(readFileSync(pool))`：`golang.pool` 解压后 **220.6 MiB**、
 * `emacs.pool` **118.4 MiB**，加上当时还整份读入的 707 MiB `runtime.zip`，
 * 在本机（提交上限 16.2 GB、空闲 1 GB 上下）直接死在
 *
 *     RangeError: Failed to allocate memory
 *       at createUnsafeBuffer (node:internal/buffer:1113:25)
 *       at createPool (node:buffer:181:17)
 *       at processChunkSync (node:zlib:476:23)
 *       at zlibBufferSync (node:zlib:182:12)
 *
 * 而这两段检查只需要「tar 头里的文件名」与「两个 go 二进制的正文」，完全
 * 可以边解边扫：`skip` 只丢字节不攒内存，`take` 只为点名的条目分配。
 *
 * @param {string} poolPath  `.pool` 文件路径
 * @param {(name: string) => boolean} want  返回 true 的条目才把正文读出来
 * @param {(name: string, data: Buffer|null, size: number) => void} onEntry
 */
async function scanPoolTar(poolPath, want, onEntry) {
  const stream = createReadStream(poolPath).pipe(createGunzip());
  const it = stream[Symbol.asyncIterator]();
  let pending = [];
  let pendingLen = 0;
  let done = false;

  const pull = async () => {
    if (done) return false;
    const r = await it.next();
    if (r.done) { done = true; return false; }
    if (r.value.length) { pending.push(r.value); pendingLen += r.value.length; }
    return true;
  };
  const ensure = async (n) => {
    while (pendingLen < n) {
      if (!(await pull())) return false;
    }
    return true;
  };
  const take = (n) => {
    const out = Buffer.allocUnsafeSlow(n);
    let off = 0;
    while (off < n) {
      const head = pending[0];
      const k = Math.min(head.length, n - off);
      head.copy(out, off, 0, k);
      off += k;
      if (k === head.length) pending.shift();
      else pending[0] = head.subarray(k);
      pendingLen -= k;
    }
    return out;
  };
  const skip = async (n) => {
    let left = n;
    while (left > 0) {
      if (pendingLen === 0 && !(await pull())) {
        throw new Error(`scanPoolTar: 归档提前结束（还差 ${left} 字节）`);
      }
      const head = pending[0];
      const k = Math.min(head.length, left);
      if (k === head.length) pending.shift();
      else pending[0] = head.subarray(k);
      pendingLen -= k;
      left -= k;
    }
  };

  for (;;) {
    if (!(await ensure(512))) break;
    const header = take(512);
    // 全零块 = 归档结束
    if (header.every((b) => b === 0)) break;
    let nameEnd = header.indexOf(0);
    if (nameEnd < 0 || nameEnd > 100) nameEnd = 100;
    const name = header.subarray(0, nameEnd).toString("utf8");
    const sizeStr = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    let data = null;
    if (want(name) && size > 0) {
      if (!(await ensure(size))) throw new Error(`scanPoolTar: ${name} 正文被截断`);
      data = take(size);
    } else {
      await skip(size);
    }
    onEntry(name, data, size);
    // 数据区补齐到 512 字节边界
    await skip((512 - (size % 512)) % 512);
  }
}

const zipPath = process.argv[2] ?? "F:/KF/DSKX/dsh-kxxy/android/app/src/main/assets/runtime.zip";

/*
 * 用 fd + 偏移随机读，**不**把整个 zip 读进内存。
 *
 * ── 为什么（构建事故，与 zipwrite 的池化泄漏是同一场调试的后半段）──────
 * 首版是 `const buf = readFileSync(zipPath)`，707 MiB 常驻，然后本脚本还要
 * 解两个扩展池（`golang.pool` 解压后 220.6 MiB、`emacs.pool` 118.4 MiB），
 * 于是跑到「golang 池里的 go」那段必死在
 *
 *     RangeError: Failed to allocate memory
 *       at createUnsafeBuffer (node:internal/buffer:1113:25)
 *       at createPool (node:buffer:181:17)
 *       at processChunkSync (node:zlib:476:23)
 *       at zlibBufferSync (node:zlib:182:12)
 *       at tools/verify-runtime.mjs:874
 *
 * 本机提交上限 16.2 GB、空闲常剩 1 GB 上下。`--max-old-space-size` 调多大
 * 都没用（栈顶是 zlib 建池，不是 JS 堆）。
 *
 * 而本脚本真正需要的只有「中央目录 + 逐条按需读的数据段」：中央目录
 * 58,920 条 × 约 100 B ≈ 6 MB，整份读入没问题；数据段一律按偏移读。
 */
const zipFd = openSync(zipPath, "r");
const zipSize = fstatSync(zipFd).size;

/** 从 zip 的 `[offset, offset+len)` 读一段（读不满即抛错，不静默截断）。 */
function readAt(offset, len) {
  const out = Buffer.allocUnsafeSlow(len);
  let got = 0;
  while (got < len) {
    const n = readSync(zipFd, out, got, len - got, offset + got);
    if (n <= 0) break;
    got += n;
  }
  if (got !== len) throw new Error(`readAt: 只读到 ${got}/${len} 字节（zip@${offset}）`);
  return out;
}

// ---------------------------------------------------------------- 找 EOCD
// EOCD 在最尾部，最多回看 66,000 字节（22 字节固定头 + 64 KiB 注释上限）。
const tailLen = Math.min(zipSize, 66_000);
const tailStart = zipSize - tailLen;
const tail = readAt(tailStart, tailLen);
let eocd = -1;
for (let i = tail.length - 22; i >= 0; i -= 1) {
  if (tail.readUInt32LE(i) === 0x06054b50) { eocd = tailStart + i; break; }
}
if (eocd < 0) throw new Error("找不到 EOCD");
const count = tail.readUInt16LE(eocd - tailStart + 10);
const cdSize = tail.readUInt32LE(eocd - tailStart + 12);
const cdStart = tail.readUInt32LE(eocd - tailStart + 16);
console.log(`EOCD @${eocd}  条目 ${count}  中央目录 ${cdStart}..${cdStart + cdSize}  文件 ${zipSize}`);

// ---------------------------------------------------------------- 遍历中央目录
// `buf` 只装中央目录（几 MB），不是整个 zip —— 下面的偏移都是相对它的。
const buf = readAt(cdStart, cdSize);
const entries = [];
let p = 0;
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

// ---------------------------------------------------------------- android.jar 完整度
// 锚点 14（缺陷 CQ）：上游 ecj 的 `share/java/android.jar` 是 4555 条目的精简
// stub，没有 `resources.arsc` ⇒ `aapt2 link` 处理任何 `@android:*` 引用都报
// `No package ID 01 found for resource ID 0x0101053d`（0x01 就是 framework 包 ID）。
// 构建期由 `bundleAndroidJar()` 用本机 SDK `platforms/android-36/android.jar`
// 裁出 arsc + 清单 + class 覆盖，体积 3.88 MB → 10.58 MB。
//
// 三重断言，缺一不可：
//   ① 标记文件与 RuntimeInstaller.ANDROID_JAR_MARKER 一致；
//   ② android.jar 体积过 6 MiB（旧 stub 3.88 MB）；
//   ③ **jar 内部真的有条目名叫 resources.arsc** —— 体积够了也可能是别的
//      打包错误产物，必须解析 jar 自己的中央目录看到名字。
{
  const kt = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"),
    "utf8",
  );
  const markerNeed = /ANDROID_JAR_MARKER\s*=\s*"([^"]+)"/.exec(kt);
  const markerFile = /ANDROID_JAR_MARKER_FILE\s*=\s*"([^"]+)"/.exec(kt);
  const minBytes = /MIN_ANDROID_JAR_BYTES\s*=\s*([\d_]+)L/.exec(kt);

  if (markerNeed === null || markerFile === null || minBytes === null) {
    console.log("android.jar 完整度：✗ RuntimeInstaller.kt 未定义 ANDROID_JAR_MARKER/MARKER_FILE/MIN_BYTES");
    missing += 1;
  } else {
    const markerEntry = byName.get(markerFile[1]);
    if (!markerEntry) {
      console.log(`android.jar 完整度：✗ 标记条目缺失 ${markerFile[1]}`);
      missing += 1;
    } else {
      const head = readLocal(markerEntry).toString("utf8").slice(0, 256);
      if (!head.includes(markerNeed[1])) {
        console.log(`android.jar 完整度：✗ 标记文件不含 ${markerNeed[1]}`);
        missing += 1;
      } else {
        console.log(`android.jar 完整度：✓ 标记 ${markerNeed[1]}（与 RuntimeInstaller 一致）`);
      }
    }

    const jarEntry = byName.get("share/java/android.jar");
    const floor = Number(minBytes[1].replace(/_/g, ""));
    if (!jarEntry) {
      console.log("android.jar 完整度：✗ 条目缺失 share/java/android.jar");
      missing += 1;
    } else {
      const jarBuf = readLocal(jarEntry);
      if (jarBuf.length < floor) {
        console.log(
          `android.jar 完整度：✗ 仍是精简 stub（${jarBuf.length} B < ${floor} B）`,
        );
        missing += 1;
      } else {
        const names = jarEntryNames(jarBuf);
        if (!names.includes("resources.arsc")) {
          console.log(
            `android.jar 完整度：✗ ${jarBuf.length} B 但内部没有 resources.arsc（aapt2 仍会失败）`,
          );
          missing += 1;
        } else {
          console.log(
            `android.jar 完整度：✓ ${jarBuf.length} B / ${names.length} 条目，含 resources.arsc`,
          );
        }
      }
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
  const emacsPool = resolvePool("emacs.pool");
  const problems = [];
  if (!emacsPool) {
    problems.push("emacs.pool 不存在（扩展池未生成）");
  } else {
    // 池是 gzip 的 tar。用 scanPoolTar 边解边扫 tar 头，只数文件名、不攒正文
    // —— 解压后 118.4 MiB，整份 `gunzipSync` 会撞上提交内存上限（见函数注释）。
    let charsetCount = 0;
    let saw8859 = false;
    await scanPoolTar(
      emacsPool,
      () => false,
      (name) => {
        if (name.includes("/etc/charsets/") && name.endsWith(".map")) {
          charsetCount += 1;
          if (name.endsWith("8859-2.map")) saw8859 = true;
        }
      },
    );
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

// ---------------------------------------------------------------- golang 池里的 go
//
// 为什么需要：缺陷 DB。`ext-pool/golang.pool` 里的 `bin/go` 与 `lib/go/bin/go`
// 必须是 `tools/build-go-android.ps1` 的交叉编译产物（resolv.conf 路径在**源码期**
// 就写成了引擎根），而不是 Termux 原件 —— 原件写死
// `/data/data/com.termux/files/usr/etc/resolv.conf`，设备上不存在该文件 ⇒
// `dnsReadConfig()` 落回 `defaultNS = {"127.0.0.1:53", "[::1]:53"}` ⇒ 只有恰好
// 有 dnsmasq 监听时才能解析，否则 `go get` 报 `connection refused`。
//
// 这个缺陷最恶劣的地方是**构建全程无异常**：池照常生成、APK 照常打包，
// 只有用户真去 `go get` 时才失败。所以必须在产物校验里把它钉死。
{
  const problems = [];
  const goPool = resolvePool("golang.pool");
  if (!goPool) {
    problems.push("golang.pool 不存在（扩展池未生成）");
  } else {
    const WANT = ["bin/go", "lib/go/bin/go"];
    const seen = new Map();
    // 边解边扫（解压后 220.6 MiB，整份 gunzipSync 会撞提交内存上限）。
    // 只为两个 go 二进制分配正文，其余条目直接跳过。
    await scanPoolTar(
      goPool,
      (name) => WANT.includes(name),
      (name, data, size) => {
        if (!WANT.includes(name)) return;
        // Go 二进制的 rodata 在中间，字面量可能在任何位置，所以老实全扫。
        const text = (data ?? Buffer.alloc(0)).toString("latin1");
        seen.set(name, {
          size,
          engine: (text.match(/files\/engine\/etc\/resolv\.conf/g) ?? []).length,
          termux: (text.match(/com\.termux\/files\/usr\/etc\/resolv\.conf/g) ?? []).length,
          placeholder: (text.match(/@DSH_ROOT@/g) ?? []).length,
          elf:
            data !== null &&
            data.length >= 4 &&
            data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46,
        });
      },
    );
    for (const w of WANT) {
      const info = seen.get(w);
      if (!info) {
        problems.push(`golang.pool 里缺 ${w}`);
        continue;
      }
      if (!info.elf) problems.push(`${w} 不是 ELF`);
      if (info.termux > 0) {
        problems.push(
          `${w} 里还有旧 Termux resolv.conf 路径（${info.termux} 处）—— ` +
          "这是 Termux 原件，设备上 go 无法解析 DNS。先跑 tools\\build-go-android.ps1",
        );
      }
      if (info.engine === 0) {
        problems.push(`${w} 里没有 <root>/etc/resolv.conf 字面量（交叉编译没生效？）`);
      }
      if (info.placeholder > 0) {
        problems.push(`${w} 里残留 @DSH_ROOT@ 占位符（${info.placeholder} 处）`);
      }
    }
    if (problems.length === 0) {
      const a = seen.get("bin/go");
      const b = seen.get("lib/go/bin/go");
      console.log(
        `golang 池的 go：✓ 两份均为交叉编译产物（${a.size}B / ${b.size}B，` +
        `resolv.conf 指向引擎根，旧 Termux 路径 0 处）`,
      );
    }
  }
  if (problems.length > 0) {
    console.log("golang 池的 go：✗");
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
// 不会自动加 `<sysroot>/include/c++/v1`。
//
// ⚠️ 修法在 v0.8.1 被改过（缺陷 BP）：最初塞进 `CPATH` / `C_INCLUDE_PATH`，
// 但这两个变量对 C 也生效，而 libc++ 的 `c++/v1/stdio.h` 是 `#include_next`
// 包装头、要求 C++ 头排在 C 头之前 —— 放末尾报
// `<cstdio> tried including <stdio.h> but didn't find libc++'s <stdio.h> header`，
// 放最前又污染纯 C 编译。正解是只给 C++ 用的 `CPLUS_INCLUDE_PATH`。
//
// 同时 v0.8.0 加的 `libc++.so` / `libc++abi.so` 两条 SONAME 别名已被回滚
// （缺陷 BQ）：这个 clang 的 driver 在 android triple 下推的是 `-lc++_shared`，
// 从不推 `-lc++`；而那两个同名文件躺在 `<root>/lib` 里会遮蔽系统的
// `/system/lib64/libc++.so`（`std::__1` vs `std::__ndk1` ABI 不兼容），
// 导致 toybox 的 `rm`/`mkdir`/`ls` 全部 CANNOT LINK。
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
  // `c++/v1` 必须出现在 CPLUS_INCLUDE_PATH 的列表里，且该列表的第一项就是它。
  const cxxBlock = /val cxxIncludeDirs = listOf\(([\s\S]*?)\n\s*\)/.exec(kt);
  if (cxxBlock === null) {
    problems.push("EngineConfig.kt 没有 cxxIncludeDirs（C++ 头搜索路径未定义）");
  } else {
    const first = /File\(root,\s*"([^"]+)"\)/.exec(cxxBlock[1]);
    if (first === null || first[1] !== "include/c++/v1") {
      problems.push("cxxIncludeDirs 的第一项必须是 include/c++/v1（否则 <cstdio> 找不到 libc++ 的 <stdio.h>）");
    }
  }
  if (!/"CPLUS_INCLUDE_PATH=\$cxxIncludeDirs"/.test(kt)) {
    problems.push("EngineConfig.kt 没有把 cxxIncludeDirs 注入 CPLUS_INCLUDE_PATH");
  }
  // `c++/v1` 不许再出现在 CPATH/C_INCLUDE_PATH 的 includeDirs 里（缺陷 BP）。
  const incBlock = /val includeDirs = listOf\(([\s\S]*?)\n\s*\)/.exec(kt);
  if (incBlock !== null && incBlock[1].includes("c++/v1")) {
    problems.push("includeDirs 仍含 include/c++/v1 —— CPATH 对 C 也生效，会破坏纯 C 编译（缺陷 BP）");
  }

  const ri = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"),
    "utf8",
  );
  // 缺陷 BQ 的回归闸门：这两个别名一旦回到 SONAME_ALIASES，系统库就会被遮蔽。
  const aliasBlock = /private val SONAME_ALIASES = linkedMapOf\(([\s\S]*?)\n\s*\)/.exec(ri);
  if (aliasBlock === null) {
    problems.push("RuntimeInstaller.kt 里找不到 SONAME_ALIASES");
  } else {
    for (const bad of ['"libc++.so" to', '"libc++abi.so" to']) {
      if (aliasBlock[1].includes(bad)) {
        problems.push(`SONAME_ALIASES 又加回了 ${bad} … —— 会遮蔽 /system/lib64/libc++.so，所有系统命令 CANNOT LINK（缺陷 BQ）`);
      }
    }
  }
  // 但清理清单里必须有它们，否则装过 v0.8.0 的设备盘上残留摘不掉。
  for (const need of ['"lib/libc++.so"', '"lib/libc++abi.so"']) {
    if (!ri.includes(need)) {
      problems.push(`SHADOWING_STUBS 缺 ${need} —— v0.8.0 装过的设备无法自愈`);
    }
  }
  if (!/materialiseSonameAliases\(root\)/.test(ri)) {
    problems.push("RuntimeInstaller.kt 没有在启动路径上调用 materialiseSonameAliases（别名不会自愈）");
  }
  if (problems.length === 0) {
    console.log(`C++ 标准库头：✓ include/c++/v1 有 ${cxxHeaders} 个条目，CPLUS_INCLUDE_PATH 就位、无 libc++ 遮蔽别名`);
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
  //
  // 只扫 assets/ext-pool，**不要**跟着去扫 .cache/apk-assets-hold ——
  // 那是打包时搬过去的一份副本，28 个池加起来 1 GB 以上，`gunzipSync`
  // 全解到堆上会撞 `FATAL ERROR: Committing semi space failed.`
  // （本机实测，校验跑到这里直接 OOM）。assets 为空时静默跳过，与旧行为一致。
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

// ---------------------------------------------------------------- 新工具链的环境变量
//
// 为什么需要：v0.8.0 把 5 个扩展装进池子之后，真机上仍有三个命令是坏的，
// 而且都是同一个根因的两副面孔 —— `tools/lib/poolextract.py` 把 deb 里
// `bin/` 下的符号链接**物化成实体副本**（`plugins/kxxy-host/lib/tar.mjs`
// 不解 type '2' 条目），于是启动脚本靠 `readlink -f $0` / `dirname $0/..`
// 反推自己的 home 时，反推出的都是「副本所在的目录」而不是链接指向的真身。
//
//   · mvn   —— `bin/mvn -> ../opt/maven/bin/mvn`，副本落在 `<root>/bin/mvn`，
//              `MAVEN_HOME` 被算成 `<root>`，报
//              `Could not find or load main class org.codehaus.plexus.classworlds.launcher.Launcher`
//   · yarn  —— `bin/yarn -> ../share/yarn/bin/yarn`，副本落在 `<root>/bin/yarn`，
//              `basedir` 被算成 `<root>/bin`，报
//              `Cannot find module '…/engine/extensions/yarn/bin/yarn.js'`
//   · gem   —— 不在这一类里，是 `libruby.so` 的 `$LOAD_PATH` 编译期写死成
//              Termux 前缀（ELF 不被 poolextract 改写），任何 `require` 都失败。
//
// 前两个靠把真身目录排在 PATH 的 `<root>/bin` 之前解决（缺陷 BN / BR），
// 第三个靠 `RUBYLIB`（缺陷 BS）。
{
  const problems = [];
  const kt = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/EngineConfig.kt"),
    "utf8",
  );

  // 缺陷 BR：yarn 的真身目录必须在 `<root>/bin` 之前。
  //
  // 取块的方式：从 `val path = buildList {` 到 `}.joinToString(":")`。
  // 不能用「第一个行首 `}`」—— 块里还有 `for` 循环，它的收尾 `}` 也是行首。
  const pathStart = kt.indexOf("val path = buildList {");
  const pathEnd = pathStart < 0 ? -1 : kt.indexOf('}.joinToString(":")', pathStart);
  if (pathStart < 0 || pathEnd < 0) {
    problems.push("EngineConfig.kt 里找不到 PATH 的 buildList");
  } else {
    const body = kt.slice(pathStart, pathEnd);
    const yarnAt = body.indexOf('share/yarn/bin');
    const rootBinAt = body.indexOf('File(root, "bin").absolutePath');
    if (yarnAt < 0) {
      problems.push("PATH 里没有 share/yarn/bin —— yarn 会去 extensions/yarn/bin 找不存在的 yarn.js（缺陷 BR）");
    } else if (rootBinAt >= 0 && yarnAt > rootBinAt) {
      problems.push("share/yarn/bin 排在 <root>/bin 之后 —— yarn 仍会命中错误的副本（缺陷 BR）");
    }
  }

  // 缺陷 BS：RUBYLIB 必须注入，且探测函数要在。
  if (!/fun rubyLibPath\(root: File\): String/.test(kt)) {
    problems.push("EngineConfig.kt 没有 rubyLibPath（ruby 的 $LOAD_PATH 补不上）");
  }
  if (!/"RUBYLIB=\$\{rubyLibPath\(root\)\}"/.test(kt)) {
    problems.push("EngineConfig.kt 没有把 rubyLibPath 注入 RUBYLIB（缺陷 BS）");
  }

  if (problems.length === 0) {
    console.log("新工具链环境：✓ share/yarn/bin 在 PATH 前置、RUBYLIB 就位");
  } else {
    console.log("新工具链环境：✗");
    for (const p of problems) console.log(`  ${p}`);
    missing += 1;
  }
}

// ---------------------------------------------------------------- 打包工具包装器
//
// 缺陷 CT（corepack）：Termux 的 `nodejs-lts` 把 `dist/corepack.js`（204 B 入口）
// **复制**到 `bin/corepack`，而入口第一句是 `require('./lib/corepack.cjs')` ——
// require 的相对路径按文件所在目录（`__dirname`）解析，从 `bin/` 出发就是
// `<root>/bin/lib/corepack.cjs`，那个目录根本不存在。真机报
// `Error: Cannot find module './lib/corepack.cjs'`，Require stack 指向
// `<root>/bin/corepack`；而 `npm` / `npx` / `pnpm` 一切正常 —— 它们早就是包装器，
// 只有 `corepack` 这一个漏了，所以症状是「npm 好用、corepack 坏」。
//
// 这里的断言是**双向**的，缺一不可：
//   ① 四个 corepack 系入口都必须是 `#!/system/bin/sh` 包装器、mode 0755、LF 换行；
//   ② `bin/corepack` **不许**再是 `dist/corepack.js` 的副本。
// 只断言 ① 会漏掉「包装器生成了，但 stage 里的同名符号链接没摘掉、最终写进 zip
// 的还是副本」这种半修复 —— 那正是 build-runtime 第 6 步「摘掉 stage 同名条目」
// 一旦失效的表现，而它跑在包装器写入**之后**，光看包装器代码是看不出来的。
//
// 注意 zip 里只会有 sh 形态（`corepack enable` 是装机后的用户行为，改不到产物），
// 所以这里不对软链形态做断言；软链形态的判据在 RuntimeInstaller 的
// `COREPACK_SHIM_NAMES` / `isCorepackDistShim` 与 `simulate-install.mjs` 的同名段，
// 本文件只负责核对那份白名单**恰好**是那四个名字（见 ⑤）。
//
// bundletool / zipalign 同理，且必须连被包装的实体一起断言：包装器在、实体缺失
// 时真机上是 `exit 127` 加一行中文提示，比「命令不存在」更难归因。
{
  const problems = [];
  const modeOf = (e) => (e.externalAttr >>> 16) & 0o7777;

  // ① corepack 系四个包装器
  for (const [name, target] of [
    ["bin/corepack", "../lib/node_modules/corepack/dist/corepack.js"],
    ["bin/npm", null],
    ["bin/npx", null],
    ["bin/pnpm", null],
  ]) {
    const e = byName.get(name);
    if (!e) { problems.push(`缺 ${name}`); continue; }
    if (e.comment.startsWith("LINK:")) { problems.push(`${name} 是 LINK 条目（应为实体包装器）`); continue; }
    const text = readLocal(e).toString("utf8");
    if (!text.startsWith("#!/system/bin/sh\n")) problems.push(`${name} 首行不是 #!/system/bin/sh`);
    if (text.includes("\r")) problems.push(`${name} 含 CR（必须 LF 换行）`);
    if (!text.includes('exec "$d/node"')) problems.push(`${name} 没有 exec "$d/node"`);
    if (target !== null && !text.includes(target)) problems.push(`${name} 未指向 ${target}`);
    if (modeOf(e) !== 0o755) problems.push(`${name} mode=0o${modeOf(e).toString(8)}（应 0755）`);
  }

  // ② 反例闸门：bin/corepack 不许是 dist/corepack.js 的副本
  const cpEntry = byName.get("bin/corepack");
  const cpDist = byName.get("lib/node_modules/corepack/dist/corepack.js");
  if (cpEntry && cpDist) {
    const a = readLocal(cpEntry);
    if (a.equals(readLocal(cpDist))) {
      problems.push("bin/corepack 与 dist/corepack.js 字节相同 —— 又是副本，缺陷 CT 复发");
    }
    if (a.toString("latin1").includes("lib/corepack.cjs")) {
      problems.push("bin/corepack 正文里出现 './lib/corepack.cjs' —— 它仍是从 bin/ 出发按 __dirname 解析的那个入口");
    }
  } else if (!cpDist) {
    problems.push("缺 lib/node_modules/corepack/dist/corepack.js（包装器的 exec 目标）");
  }

  // ③ Android 打包工具：bundletool（jar + java 包装器）
  const bt = byName.get("bin/bundletool");
  const btJar = byName.get("lib/node_modules/kxxy-host/packaging/bundletool-all.jar");
  if (!bt) problems.push("缺 bin/bundletool");
  else {
    const text = readLocal(bt).toString("utf8");
    if (!text.startsWith("#!/system/bin/sh\n")) problems.push("bin/bundletool 首行不是 #!/system/bin/sh");
    if (text.includes("\r")) problems.push("bin/bundletool 含 CR（必须 LF 换行）");
    if (modeOf(bt) !== 0o755) problems.push(`bin/bundletool mode=0o${modeOf(bt).toString(8)}（应 0755）`);
  }
  if (!btJar) {
    problems.push("缺 lib/node_modules/kxxy-host/packaging/bundletool-all.jar");
  } else {
    const jar = readLocal(btJar);
    if (jar.length < 4 || jar.readUInt32LE(0) !== 0x04034b50) {
      problems.push("bundletool-all.jar 不是 zip（本地头签名错）");
    } else if (btJar.usize < (1 << 20)) {
      problems.push(`bundletool-all.jar 只有 ${btJar.usize} B —— fat jar 应 ≥1 MiB，可能抓了个占位文件`);
    } else if (!jarEntryNames(jar).includes("META-INF/MANIFEST.MF")) {
      problems.push("bundletool-all.jar 中央目录里没有 META-INF/MANIFEST.MF");
    }
  }

  // ④ Android 打包工具：zipalign（纯 JS 实现 + node 包装器）
  const za = byName.get("bin/zipalign");
  const zaJs = byName.get("lib/node_modules/kxxy-host/packaging/zipalign.mjs");
  if (!za) problems.push("缺 bin/zipalign");
  else {
    const text = readLocal(za).toString("utf8");
    if (!text.startsWith("#!/system/bin/sh\n")) problems.push("bin/zipalign 首行不是 #!/system/bin/sh");
    if (text.includes("\r")) problems.push("bin/zipalign 含 CR（必须 LF 换行）");
    if (!text.includes("packaging/zipalign.mjs")) problems.push("bin/zipalign 没有指向 packaging/zipalign.mjs");
    if (modeOf(za) !== 0o755) problems.push(`bin/zipalign mode=0o${modeOf(za).toString(8)}（应 0755）`);
  }
  if (!zaJs) {
    problems.push("缺 lib/node_modules/kxxy-host/packaging/zipalign.mjs");
  } else {
    // 它是**脚本入口**不是库：没有 export，靠 `main()` 自执行。
    // 断言 `function main(` 与 zip 里最关键的 `EOCD` 解析都在，避免打包进一个空壳。
    const js = readLocal(zaJs).toString("utf8");
    if (!js.includes("function main(")) problems.push("packaging/zipalign.mjs 里没有 function main —— 不是可执行入口");
    if (!/findEocd|0x06054b50/.test(js)) problems.push("packaging/zipalign.mjs 里找不到 EOCD 解析 —— 不是真的 zipalign 实现");
  }

  if (problems.length === 0) {
    console.log("\n打包工具包装器：✓ corepack/npm/npx/pnpm + bundletool + zipalign（0755 / LF / 实体非 LINK）");
  } else {
    console.log("\n打包工具包装器：✗");
    for (const p of problems) console.log(`  ${p}`);
    missing += 1;
  }

  // ⑤ 锚点 15 的标记文件必须与 RuntimeInstaller 逐字一致。
  //
  // 这一条单独判，因为它守的是「修复能不能到达老设备」而不是「产物对不对」：
  // `bin/corepack` 换形态不改变 RUNTIME_VERSION，前十四锚点全过 ⇒ isComplete()
  // 判真 ⇒ 跳过重装。标记缺失或与 Kotlin 常量不一致，真机上就永远不重装，
  // 而产物校验全绿 —— 这种「产物对、装机不生效」最难排查。
  const kt = readFileSync(
    join(HERE, "..", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt"),
    "utf8",
  );
  const wantMarker = /PACKAGING_MARKER\s*=\s*"([^"]+)"/.exec(kt);
  const wantFile = /PACKAGING_MARKER_FILE\s*=\s*\n?\s*"([^"]+)"/.exec(kt);
  const problems2 = [];
  if (wantMarker === null || wantFile === null) {
    problems2.push("RuntimeInstaller.kt 未定义 PACKAGING_MARKER / PACKAGING_MARKER_FILE");
  } else {
    const me = byName.get(wantFile[1]);
    if (!me) problems2.push(`缺锚点 15 标记文件 ${wantFile[1]}`);
    else {
      const text = readLocal(me).toString("utf8").trim();
      if (text !== wantMarker[1]) problems2.push(`标记不一致：zip 里是 ${text}，Kotlin 要 ${wantMarker[1]}`);
    }
    // 反向：Kotlin 的包装器清单必须与实际断言的一致，避免「清单里少一个就静默放过」。
    const listBody = /PACKAGING_WRAPPERS\s*=\s*listOf\(([\s\S]*?)\)/.exec(kt);
    if (listBody === null) problems2.push("RuntimeInstaller.kt 未定义 PACKAGING_WRAPPERS");
    else {
      const names = [...listBody[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      for (const n of ["bin/corepack", "bin/npm", "bin/npx", "bin/pnpm", "bin/zipalign", "bin/bundletool"]) {
        if (!names.includes(n)) problems2.push(`PACKAGING_WRAPPERS 里少了 ${n}`);
      }
    }
    // 软链白名单：`corepack enable` 会把四个 corepack 入口换成指向
    // `lib/node_modules/corepack/dist/*.js` 的软链（官方文档行为、实测可用）。
    // Kotlin 侧靠 COREPACK_SHIM_NAMES 区分「合法软链」与「被人动过」，所以这份
    // 白名单必须**恰好**是那四个 —— 多一个（比如把 zipalign 也放进去）就等于
    // 放弃了「自造包装器不许变成软链」这条判据，而 zip 侧断言查不出来。
    const shimBody = /COREPACK_SHIM_NAMES\s*=\s*setOf\(([\s\S]*?)\)/.exec(kt);
    if (shimBody === null) {
      problems2.push("RuntimeInstaller.kt 未定义 COREPACK_SHIM_NAMES");
    } else {
      const shims = [...shimBody[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
      const want = ["bin/corepack", "bin/npm", "bin/npx", "bin/pnpm"].sort();
      if (shims.length !== want.length || shims.some((s, i) => s !== want[i])) {
        problems2.push(`COREPACK_SHIM_NAMES 应为 ${want.join(" / ")}，实际 ${shims.join(" / ")}`);
      }
    }
    // 安装前自愈：`corepack disable` 会把入口**删掉**（实测
    // `ls: cannot access '…/bin/pnpm': No such file or directory`），第一版判据
    // 因此判假、触发 741 MiB 全量重装。修法是 `ensureInstalled` 里在
    // `isComplete()` **之前**调 `healPackagingWrappers(root)` —— 顺序是判据成立的
    // 前提（放到 isComplete 之后，快路径直接返回，自愈永远跑不到），所以这里
    // 连顺序一起核。
    if (!/private\s+fun\s+healPackagingWrappers\s*\(/.test(kt)) {
      problems2.push("RuntimeInstaller.kt 缺 healPackagingWrappers（corepack disable 删入口会触发全量重装）");
    } else {
      const healAt = kt.indexOf("healPackagingWrappers(root)");
      const probeAt = kt.indexOf("if (isComplete(root))");
      if (healAt < 0) problems2.push("healPackagingWrappers 定义了却没有调用点");
      else if (probeAt < 0) problems2.push("RuntimeInstaller.kt 找不到 `if (isComplete(root))`");
      else if (healAt > probeAt) problems2.push("healPackagingWrappers 必须在 isComplete() 之前调用（否则快路径直接返回，自愈跑不到）");
    }
  }
  if (problems2.length === 0) {
    console.log(`锚点 15 打包工具标记：✓ ${wantMarker[1]}（与 RuntimeInstaller 一致）`);
  } else {
    console.log("锚点 15 打包工具标记：✗");
    for (const p of problems2) console.log(`  ${p}`);
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
  // 本地头单独读 30 字节，再只读数据段 —— 不碰整份 zip（见 readAt 的注释）。
  const localHead = readAt(lp, 30);
  if (localHead.readUInt32LE(0) !== 0x04034b50) throw new Error(`本地头签名错误 @${lp} for ${e.name}`);
  const nameLen = localHead.readUInt16LE(26);
  const extraLen = localHead.readUInt16LE(28);
  const start = lp + 30 + nameLen + extraLen;
  const raw = readAt(start, e.csize);
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
