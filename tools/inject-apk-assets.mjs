/**
 * 把大资源（runtime.zip + ext-pool/*.pool）追加进已构建的 APK。
 *
 * ── 为什么需要这个脚本（构建事故）────────────────────────────────────────────
 *
 * AGP 的 `:app:compressDebugAssets` 走 `com.android.zipflinger.BytesSource`，
 * 它把每个 asset **整份读进内存**：
 *
 *     at com.android.zipflinger.BytesSource.<init>(BytesSource.java:49)
 *     at com.android.build.gradle.internal.tasks.CompressAssetsWorkAction.execute(CompressAssetsTask.kt:187)
 *     java.lang.OutOfMemoryError: Unable to allocate 709043392 bytes
 *
 * 709 MB 正是 `assets/runtime.zip` 的大小；`ext-pool/rust.pool` 还有 250 MB。
 * 这台构建机 8 GB 物理内存 + 8 GB 页面文件、常态提交余量 1–2 GB，
 * 无论 `-Xmx` 调到 1.5 / 3 / 4 / 6 GB 都是同一句（实测四档全挂）。
 *
 * 所以流程改成两步：
 *   1) `gradle assembleDebug` 先出一个**不含大资源**的 APK（1.5 MB，秒级）；
 *   2) 本脚本把两批大资源按 STORE 追加进去，并重写中央目录。
 *
 * STORE 而非 deflate 的理由与 `app/build.gradle.kts` 的 `noCompress` 完全一致：
 * 两者本来就已经是压缩态（.zip / gzip），再 deflate 纯属浪费；而且
 * `RuntimeInstaller.ensureExtensionPool` 靠 `AssetManager.openFd()` 拿真实
 * `length` 做「大小一致即跳过」的幂等判断，STORE 才能保证那个值是对的。
 *
 * 用法：
 *   node tools/inject-apk-assets.mjs [--apk <path>] [--assets <dir>]
 */
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "..");

function parseArgs(argv) {
  const opts = {
    apk: join(PROJECT, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
    assets: join(PROJECT, ".cache", "apk-assets-hold"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apk") opts.apk = resolve(argv[++i]);
    else if (a === "--assets") opts.assets = resolve(argv[++i]);
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(2)} MiB`;
  return `${(n / 1073741824).toFixed(2)} GiB`;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** 流式 crc32：大文件不能整份读进内存（见文件头注释）。 */
function crc32File(path, size) {
  let c = 0xffffffff;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let done = 0;
    while (done < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - done), done);
      if (n <= 0) break;
      for (let i = 0; i < n; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
      done += n;
    }
  } finally {
    closeSync(fd);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    day: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** 递归收集要注入的文件，键是 APK 内的路径（`assets/...`）。 */
const skippedAssets = [];
function collectAssets(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(root, p).split(sep).join("/");
      // 白名单：只注入 `runtime.zip` 与 `ext-pool/*.pool`。
      //
      // 踩过的坑：`apk-assets-hold/` 里曾经躺着一份 `golang.pool.bak`
      // （手工重打池时的备份），而这里是「见文件就收」，于是 62 MiB 的
      // 备份被当成真资源塞进 APK —— 装到设备上还看不出来（安装器只按
      // `ext-pool/<id>.pool` 找），白白撑大包体。白名单比黑名单稳：
      // 以后往 hold 里放日志、校验和、临时件都不会再漏进去。
      const isRuntime = rel === "runtime.zip";
      const isPool = rel.startsWith("ext-pool/") && rel.endsWith(".pool");
      // 别名清单（缺陷 DD）：几十 KB，App 侧快路径读它做存量别名自愈。
      const isAliasList = rel === "alias-links.txt";
      if (!isRuntime && !isPool && !isAliasList) {
        skippedAssets.push(rel);
        continue;
      }
      out.push({ zipPath: `assets/${rel}`, diskPath: p, size: statSync(p).size });
    }
  };
  walk(root);
  return out.sort((a, b) => a.zipPath.localeCompare(b.zipPath));
}

const { apk, assets } = parseArgs(process.argv.slice(2));
if (!statSync(assets).isDirectory()) throw new Error(`资源目录不存在：${assets}`);

const files = collectAssets(assets);
if (files.length === 0) throw new Error(`${assets} 下没有文件可注入`);
if (skippedAssets.length > 0) {
  console.log(`      跳过 ${skippedAssets.length} 个非资源文件：${skippedAssets.join(", ")}`);
}

// ---------------------------------------------------------------- 读现有中央目录
const apkBuf = readFileSync(apk);
let eocdAt = -1;
for (let i = apkBuf.length - 22; i >= Math.max(0, apkBuf.length - 66000); i -= 1) {
  if (apkBuf.readUInt32LE(i) === 0x06054b50) {
    eocdAt = i;
    break;
  }
}
if (eocdAt < 0) throw new Error(`${apk} 里找不到 EOCD`);

const cdCount = apkBuf.readUInt16LE(eocdAt + 10);
const cdSize = apkBuf.readUInt32LE(eocdAt + 12);
const cdOffset = apkBuf.readUInt32LE(eocdAt + 16);
if (eocdAt + 22 !== apkBuf.length) {
  throw new Error(`EOCD 不在文件末尾（末尾还有 ${apkBuf.length - eocdAt - 22} 字节），拒绝在带签名的 APK 上追加`);
}

/**
 * 解析中央目录，取出每个条目的**原始中央目录记录**，稍后原样重放。
 *
 * 不重建字段是因为 Android 的 v1/v2 签名与 `resources.arsc` 都依赖压缩方式、
 * 时间戳等字节精确值；原样复制是唯一安全做法。文件名长度、extra、comment
 * 都从记录自身读，不假设为 0（aapt2 会给某些条目塞 extra）。
 */
const cdRecords = [];
{
  let p = cdOffset;
  for (let i = 0; i < cdCount; i += 1) {
    if (apkBuf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`中央目录第 ${i} 条签名不对（偏移 ${p}）`);
    }
    const nameLen = apkBuf.readUInt16LE(p + 28);
    const extraLen = apkBuf.readUInt16LE(p + 30);
    const commentLen = apkBuf.readUInt16LE(p + 32);
    const total = 46 + nameLen + extraLen + commentLen;
    cdRecords.push(Buffer.from(apkBuf.subarray(p, p + total)));
    p += total;
  }
  if (p !== cdOffset + cdSize) {
    throw new Error(`中央目录长度不符：解析到 ${p}，头部声明 ${cdOffset + cdSize}`);
  }
}

const existing = new Set(
  cdRecords.map((r) => {
    const nameLen = r.readUInt16LE(28);
    return r.subarray(46, 46 + nameLen).toString("utf8");
  }),
);
for (const f of files) {
  if (existing.has(f.zipPath)) throw new Error(`APK 里已有同名条目：${f.zipPath}`);
}

// ---------------------------------------------------------------- 追加数据区
// 截断到 EOCD 之前：去掉旧中央目录与 EOCD，数据区（本地文件头+数据）原样保留。
let writeAt = cdOffset;
const fd = openSync(apk, "r+");
const newCd = [];
try {
  ftruncateSync(fd, writeAt);

  const date = new Date("2026-01-01T00:00:00Z");
  const { time, day } = dosDateTime(date);

  for (const f of files) {
    const nameBuf = Buffer.from(f.zipPath, "utf8");
    const crc = crc32File(f.diskPath, f.size);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名称
    local.writeUInt16LE(0, 8); // STORE（见文件头注释）
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.size, 18);
    local.writeUInt32LE(f.size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    writeSync(fd, local, 0, local.length, writeAt);
    writeAt += local.length;
    writeSync(fd, nameBuf, 0, nameBuf.length, writeAt);
    writeAt += nameBuf.length;

    // 数据区按块拷贝，绝不整份读进内存。
    const srcFd = openSync(f.diskPath, "r");
    try {
      const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
      let copied = 0;
      while (copied < f.size) {
        const n = readSync(srcFd, buf, 0, Math.min(buf.length, f.size - copied), copied);
        if (n <= 0) break;
        writeSync(fd, buf, 0, n, writeAt);
        writeAt += n;
        copied += n;
      }
      if (copied !== f.size) throw new Error(`${f.diskPath} 只拷了 ${copied}/${f.size} 字节`);
    } finally {
      closeSync(srcFd);
    }

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4); // made by: Unix + 3.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(f.size, 20);
    cd.writeUInt32LE(f.size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    // assets 是普通文件，0644；高 16 位补 S_IFREG
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(writeAt - local.length - nameBuf.length - f.size, 42);
    newCd.push({ cd, nameBuf });
    console.log(`  + ${f.zipPath}（${human(f.size)}，STORE）`);
  }

  // ---------------------------------------------------------------- 重写中央目录
  const cdStart = writeAt;
  for (const r of cdRecords) {
    writeSync(fd, r, 0, r.length, writeAt);
    writeAt += r.length;
  }
  for (const { cd, nameBuf } of newCd) {
    writeSync(fd, cd, 0, cd.length, writeAt);
    writeAt += cd.length;
    writeSync(fd, nameBuf, 0, nameBuf.length, writeAt);
    writeAt += nameBuf.length;
  }
  const cdLen = writeAt - cdStart;

  const total = cdCount + newCd.length;
  if (total > 0xffff) throw new Error(`条目数 ${total} 超过 65535，需要 Zip64（本脚本不支持）`);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(total, 8);
  eocd.writeUInt16LE(total, 10);
  eocd.writeUInt32LE(cdLen, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  writeSync(fd, eocd, 0, eocd.length, writeAt);
  writeAt += eocd.length;
} finally {
  closeSync(fd);
}

console.log(`\n注入完成：${files.length} 个资源，APK ${human(statSync(apk).size)}（条目 ${cdCount + newCd.length}）`);
console.log(`⚠️  APK 已被修改，必须重新签名（v1/v2）后再安装。`);
