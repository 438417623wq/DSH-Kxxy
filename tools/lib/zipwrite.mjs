/**
 * 极简 ZIP 写入器。
 *
 * 为什么不用现成工具：Windows 构建机上没有 zip / 7z / bash，PowerShell 的
 * Compress-Archive 无法控制 Unix 权限位（external attributes）也不写注释。
 * 而我们必须精确控制：
 *   - external_attr 里的 Unix mode（0755/0644），让安装器能直接照抄权限位；
 *   - 每个条目的存储方式（大二进制用 deflate，已是压缩格式的用 store）；
 *   - 不产生 Zip64 记录（总大小 < 4 GiB，用不到，且 Android 端解析更简单）。
 *
 * 格式参考 PKWARE APPNOTE 4.3.16：
 *   本地文件头 30 字节 + 文件名 + 数据
 *   中央目录项 46 字节 + 文件名 + 注释
 *   中央目录结束 22 字节
 */
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import zlib, { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  return (crcUpdate(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

/**
 * 增量 crc32：接受「上一轮的中间状态」，返回新的中间状态。
 *
 * 与 [crc32] 的区别是**不做首尾异或**，这样分块读盘时可以逐块累积，
 * 最后一块算完再统一收尾（见 [deflateFile]）。`crc32` 就是它的特例：
 * 初值 0xffffffff、收尾 `^ 0xffffffff`。
 */
function crcUpdate(state, buf) {
  let c = state;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c;
}

/** 分块读盘的块大小（见 [deflateFile]）。4 MiB 在 I/O 次数与峰值间折中。 */
const READ_CHUNK = 4 * 1024 * 1024;

/**
 * 单条目超过这个大小就走「流式分块 deflate」（见 [deflateLarge]）。
 *
 * ── 为什么必须分块（构建事故，实测三轮）────────────────────────────────────
 *
 * 这台构建机的 **提交内存** 上限 16.2 GB、常态只剩 0.9 GB（8 GB 物理 +
 * 8 GB 页面文件，其中约 9 GB 已被内核池/驱动占掉）。stage 里最大的单个
 * 条目是 `lib/jvm/.../modules` 142 MB、`lib/libLLVM.so` 133 MB，还有
 * 60 / 55 / 45 / 35 MiB 若干个。`deflateRawSync` 对单条要同时持有
 * 「输入 + zlib 窗口 + 输出」，142 MB 的条目瞬时峰值 400 MB 以上，
 * 写入阶段直接：
 *
 *     FATAL ERROR: MarkCompactCollector: young object promotion failed
 *
 * 分块后每条只需「一块输入 + 该块的压缩输出」，峰值降到十几 MB。
 * 实测压缩比仍有 0.33（142 MB → 45.5 MB），所以**不能**为了省内存改成
 * store —— 那会让 runtime.zip 白涨 180 MB 以上。
 */
const LARGE_ENTRY = 8 * 1024 * 1024;
const DEFLATE_CHUNK = 4 * 1024 * 1024;

/**
 * 用 zlib 的**流式**接口分块压缩大条目，返回 Promise<Buffer>。
 *
 * 关键点：必须是**同一条** deflate 流。逐块各自 finish 会得到多段独立流，
 * 拼起来不是合法 deflate，解压直接报 `unexpected end of file`。所以用
 * `createDeflateRaw` 建一个流、顺序 write 各块、最后 end()。
 *
 * 实测（`tools/_probe_deflate3.mjs`）：40 MiB 输入分 10 块，输出与
 * `deflateRawSync` **字节完全相同**，`inflateRawSync` 可完整还原。
 */
function deflateLarge(data, level) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0;
    const z = zlib.createDeflateRaw({ level });
    z.on("data", (b) => {
      parts.push(b);
      total += b.length;
    });
    z.on("error", reject);
    z.on("end", () => resolve(Buffer.concat(parts, total)));
    for (let off = 0; off < data.length; off += DEFLATE_CHUNK) {
      z.write(data.subarray(off, Math.min(off + DEFLATE_CHUNK, data.length)));
    }
    z.end();
  });
}

/**
 * 从磁盘分块读，边算 crc 边压缩，返回 `{ crc, payload }`。
 *
 * 这是「大条目」的主路径：`lib/jvm/.../modules` 142 MB、`libLLVM.so` 133 MB，
 * 一次性 `readFileSync` 会直接 `RangeError: Failed to allocate memory`
 * （提交内存只剩 0.9 GB）。分块后任一时刻只持有 `READ_CHUNK` 的原始数据
 * 与累积的压缩输出（约原大小的 1/3），峰值降到 50 MB 量级。
 *
 * crc32 必须按**原始**字节算（zip 的 crc 是未压缩数据的），所以在喂给
 * deflate 之前先更新同一块。
 */
function deflateFile(filePath, size, level, start = 0) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let totalOut = 0;
    let crc = 0xffffffff;
    let read = 0;
    const z = zlib.createDeflateRaw({ level });

    z.on("data", (b) => {
      parts.push(b);
      totalOut += b.length;
    });
    z.on("error", reject);
    z.on("end", () => resolve({ crc: (crc ^ 0xffffffff) >>> 0, payload: Buffer.concat(parts, totalOut) }));

    const fd = openSync(filePath, "r");
    try {
      // 分块缓冲按**块**而非整条分配：上一条 142 MB 时若照 size 分配，
      // 就等于又读了一整份进内存（那正是要避免的）。
      const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, Math.max(size, 1)));
      while (read < size) {
        const want = Math.min(buf.length, size - read);
        const n = readSync(fd, buf, 0, want, start + read);
        if (n <= 0) break;
        /*
         * ⚠️ 必须**拷贝**一块再交给 zlib，不能直接 `buf.subarray(0, n)`。
         *
         * `z.write()` 只是把引用排进流的内部队列；循环立刻进入下一轮
         * `readSync(fd, buf, …)`，会把同一块 `buf` 覆盖掉。结果是 zlib 压缩的
         * 是「被后一块覆盖过的数据」——CRC 却是按**读完当时**正确算的，于是
         * zip 里的 crc 对得上、解压出来的内容却是错的，症状非常隐蔽：
         *
         *   NotoSansSC_400Regular.ttf  addSlice  crc 一致  roundtrip false
         *
         * 真机上的表现就是字体文件坏掉（`verify-runtime` 报「不是 sfnt」），
         * 而构建日志一切正常。`Buffer.from(chunk)` 是深拷贝，几十 KB 的开销
         * 换来正确性。
         */
        const piece = Buffer.from(buf.subarray(0, n));
        crc = crcUpdate(crc, piece);
        z.write(piece);
        read += n;
      }
    } catch (err) {
      reject(err);
      return;
    } finally {
      closeSync(fd);
    }
    z.end();
  });
}

/** 从 shared spill 文件的 `[offset, offset+size)` 读出一段（store 路径用）。 */
function readRange(filePath, offset, size) {
  const buf = Buffer.allocUnsafe(size);
  const fd = openSync(filePath, "r");
  try {
    let got = 0;
    while (got < size) {
      const n = readSync(fd, buf, got, size - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    if (got !== size) throw new Error(`readRange: 只读到 ${got}/${size} 字节（${filePath}@${offset}）`);
  } finally {
    closeSync(fd);
  }
  return buf;
}

/** 已是压缩格式的扩展名：再 deflate 几乎无收益，纯浪费时间。 */
const ALREADY_COMPRESSED = new Set([
  ".gz", ".xz", ".bz2", ".zip", ".jar", ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".woff", ".woff2", ".pdf", ".7z", ".zst",
]);

/**
 * 把字符串编码成一个**独立分配**的 Buffer（不参与 8 KB pool 池化）。
 *
 * `Buffer.from(str, "utf8")` 与 `Buffer.allocUnsafe` 在长度 < 4 KB 时都从
 * 共享 pool 切片，切片会钉住整个 8 KB pool。`ZipWriter.entries` 要长期
 * 持有 5 万多条文件名/注释，用池化 Buffer 会钉住约 600 MB（详见
 * `#addInternal` 里的构建事故记录）。`Buffer.allocUnsafeSlow` 按定义
 * 逐条独立分配。
 */
function ownBuffer(str) {
  if (!str) return Buffer.alloc(0);
  const bytes = Buffer.byteLength(str, "utf8");
  const buf = Buffer.allocUnsafeSlow(bytes);
  buf.write(str, 0, bytes, "utf8");
  return buf;
}

function dosDateTime(date) {
  const y = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * 流式写入器：条目逐个 append，最后 finish() 落中央目录。
 * 全程只保留「已完成条目的元数据」与「中央目录缓冲」，不把整个 zip 放内存。
 */
export class ZipWriter {
  constructor(sink) {
    this.sink = sink; // (Buffer) => void
    this.offset = 0;
    this.entries = [];
  }

  #emit(buf) {
    this.sink(buf);
    this.offset += buf.length;
  }

  /**
   * @param {string} name        条目路径，使用 `/` 分隔，无前导斜杠
   * @param {Buffer} data        内容
   * @param {object} [opts]
   * @param {number} [opts.mode] Unix 权限位，如 0o755
   * @param {number} [opts.level] deflate 级别；-1 表示 store
   * @param {string} [opts.comment] 条目注释（写入中央目录）
   * @param {Date}   [opts.date]
   * @returns {Promise<void>} 大条目走分块压缩时需要 await，所以统一返回 Promise
   */
  async add(name, data, opts = {}) {
    await this.#addInternal(name, data, null, opts);
  }

  /**
   * 直接从磁盘读并写出一个条目（**大文件用这个**）。
   *
   * ── 为什么不 `readFileSync` 之后再 `add()`（构建事故）────────────────────
   *
   * 最大的条目 `lib/jvm/java-21-openjdk/lib/modules` 是 142 MB。整份读进内存
   * 后还要再生成一份压缩输出，瞬时就是 142 + 45 MB；而这台构建机的提交内存
   * 常态只剩 0.9 GB，上一条的 Buffer 若还没回收，直接
   *
   *     RangeError: Failed to allocate memory
   *       at tryCreateBuffer (node:fs:402:21)
   *       at readFileSync (node:fs:500:14)
   *
   * 本方法按 `CHUNK` 分块 `read`：每块既喂给 crc32 也喂给同一个 deflate 流，
   * 压缩输出攒成小段（总量仍是压缩后大小，45 MB），全程不持有原始大 Buffer。
   * 若压缩后反而更大（少见），退回 store —— 此时才需要整份数据，用一次
   * `readFileSync` 读回（这类文件本来就小，不会触发峰值）。
   */
  async addFile(name, filePath, size, opts = {}) {
    await this.#addInternal(name, null, { path: filePath, size, offset: 0 }, opts);
  }

  /**
   * 从「共享 spill 文件的某个区间」写出一个条目（**大块资产的推荐用法**）。
   *
   * 为什么不是每条一个临时文件：TeX 宏包树 13,669 个文件、wasm 49 个、插件
   * 209 个 —— 逐个 `writeFileSync` 是上万次 open/close，Windows 上实测能拖
   * 十几分钟。全部追加进同一个文件、每条只记 `offset/size`，I/O 次数降到 1。
   */
  async addSlice(name, filePath, offset, size, opts = {}) {
    await this.#addInternal(name, null, { path: filePath, offset, size }, opts);
  }

  async #addInternal(name, data, file, opts) {
    const { mode = 0o644, level = 6, comment = "", date = new Date("2026-01-01T00:00:00Z") } = opts;
    /*
     * ⚠️ 这两个 Buffer 会**长期**留在 `this.entries` 里（中央目录最后才写），
     * 所以必须是独立分配，不能是 8 KB pool 的切片。
     *
     * ── 为什么要显式 copy（构建事故，泄漏 600 MB）──────────────────────────
     * `Buffer.from(str, "utf8")` 在长度 < `Buffer.poolSize >>> 1`（4 KB）时
     * 会从共享的 8 KB pool 里切一段出来。切片本身只占几十字节，但它**钉住
     * 整个 8 KB pool** —— 每个 pool 要等最后一片被回收才释放。
     *
     * 本函数要为 5 万多条各建两个这样的 Buffer（文件名 ~40 B、注释 0 或
     * 几十 B），而且它们全被 `entries` 引用到 `finish()` 为止 ⇒ 每条约
     * 8 KB × 2 的 pool 被长期钉住。实测 3 万条 `addSlice`：
     *
     *     i=0     rss=79MB  ext=2MB
     *     i=5000  rss=122MB ext=106MB
     *     i=15000 rss=204MB ext=315MB
     *     i=30000 rss=327MB ext=627MB
     *
     * 线性增长 ≈ 21 KB/条，且 `global.gc()` 完全收不掉（它们都是活引用）。
     * 真机构建时私有内存爬到 1,456 MB，最终死在
     *
     *     RangeError: Failed to allocate memory
     *       at createPool (node:buffer:181:17)
     *       at DeflateRaw.ZlibBase (node:zlib:274:28)
     *
     * ——连 zlib 建池都申请不到。`Buffer.from(buf)` 是**深拷贝**，得到独立
     * 的 `ArrayBuffer`，几万条总共只占实际字节数（约 4 MB）。
     *
     * 二分定位过程见 `_probe/zipmem2.mjs`：只 deflate 不写 zip 时 ext 稳定在
     * 9 MB，一旦走 `ZipWriter` 就线性涨 —— 泄漏点就是这里，与 zlib 无关。
     *
     * 注意 `Buffer.from(Buffer.from(s))` 这种写法**不管用**：外层 `Buffer.from`
     * 对 < 4 KB 的输入同样走 `allocate()` → 仍然从 pool 切。必须用
     * `Buffer.allocUnsafeSlow`，它按定义**不**参与池化。
     */
    const nameBuf = ownBuffer(name);
    const commentBuf = ownBuffer(comment);

    const totalSize = data !== null ? data.length : file.size;
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    const wantDeflate = level >= 0 && totalSize > 0 && !ALREADY_COMPRESSED.has(ext);

    let method = 0;
    let payload = null;
    let crc = 0;

    if (wantDeflate && file === null) {
      // 内存条目：直接压。
      crc = crc32(data);
      const deflated = data.length >= LARGE_ENTRY
        ? await deflateLarge(data, level)
        : deflateRawSync(data, { level });
      if (deflated.length < data.length) {
        method = 8;
        payload = deflated;
      } else {
        payload = data;
      }
    } else if (wantDeflate) {
      /*
       * 磁盘条目：分两条路走，按大小分流。
       *
       * ── 为什么小条目不能也走流式（构建事故）────────────────────────────────
       *
       * 首版是「一律 `deflateFile`」。asar 侧有 30,289 条要写，其中绝大多数是
       * 几 KB 的 JS/TeX 文件；每条都新建一个 `createDeflateRaw` 流意味着
       * 3 万次原生 zlib 上下文创建/销毁，堆外内存与句柄释放跟不上，写到中途
       * 直接崩在原生层：
       *
       *     Error: insufficient memory
       *         at Zlib.zlibOnError (node:zlib:193:17) { errno: -4, code: 'Z_MEM_ERROR' }
       *
       * ——`Z_MEM_ERROR` 是 zlib **自己**申请不到内存，不是 JS 堆满，所以调
       * `--max-old-space-size` 完全无效。
       *
       * 分流规则：小于 `LARGE_ENTRY`（8 MiB）的整份读出、用同步 API 压
       * （一次分配、一次释放，无流对象）；超过的才走分块流式（那是为了避开
       * 142 MB 单条把提交内存打穿，见 `deflateFile` 注释）。
       */
      if (totalSize < LARGE_ENTRY) {
        const raw = readRange(file.path, file.offset ?? 0, totalSize);
        crc = crc32(raw);
        const deflated = deflateRawSync(raw, { level });
        if (deflated.length < totalSize) {
          method = 8;
          payload = deflated;
        } else {
          payload = raw;
          method = 0;
        }
      } else {
        const r = await deflateFile(file.path, file.size, level, file.offset ?? 0);
        crc = r.crc;
        if (r.payload.length < totalSize) {
          method = 8;
          payload = r.payload;
        } else {
          // 压缩反而更大：这个文件本身太小或已高熵，退回 store。
          payload = readRange(file.path, file.offset ?? 0, file.size);
          method = 0;
        }
      }
    } else {
      // 不压缩：store，直接读（或不压缩的 blob）。
      payload = data !== null ? data : readRange(file.path, file.offset ?? 0, totalSize);
      crc = crc32(payload);
    }

    const { time, day } = dosDateTime(date);
    const isDir = name.endsWith("/");
    // external_attr 高 16 位是 Unix mode；目录补 S_IFDIR(0o040000)，文件补 S_IFREG(0o100000)
    const unixMode = (isDir ? 0o040000 : 0o100000) | mode;
    const externalAttr = (unixMode << 16) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flag: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(totalSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const localOffset = this.offset;
    this.#emit(local);
    this.#emit(nameBuf);
    if (payload.length) this.#emit(payload);

    this.entries.push({
      name: nameBuf,
      comment: commentBuf,
      method,
      time,
      day,
      crc,
      compressedSize: payload.length,
      uncompressedSize: totalSize,
      externalAttr,
      localOffset,
    });
  }

  /** 写中央目录与结束记录。返回总字节数与条目数。 */
  finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(0x031e, 4); // version made by: Unix(3) + 3.0
      head.writeUInt16LE(20, 6);
      head.writeUInt16LE(0x0800, 8);
      head.writeUInt16LE(e.method, 10);
      head.writeUInt16LE(e.time, 12);
      head.writeUInt16LE(e.day, 14);
      head.writeUInt32LE(e.crc, 16);
      head.writeUInt32LE(e.compressedSize, 20);
      head.writeUInt32LE(e.uncompressedSize, 24);
      head.writeUInt16LE(e.name.length, 28);
      head.writeUInt16LE(0, 30); // extra
      head.writeUInt16LE(e.comment.length, 32);
      head.writeUInt16LE(0, 34); // disk
      head.writeUInt16LE(0, 36); // internal attr
      head.writeUInt32LE(e.externalAttr, 38);
      head.writeUInt32LE(e.localOffset, 42);
      this.#emit(head);
      this.#emit(e.name);
      if (e.comment.length) this.#emit(e.comment);
    }
    const cdSize = this.offset - cdStart;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    end.writeUInt16LE(0, 20);
    this.#emit(end);

    return { bytes: this.offset, entries: this.entries.length };
  }
}
