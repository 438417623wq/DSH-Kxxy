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
import { deflateRawSync } from "node:zlib";

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
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 已是压缩格式的扩展名：再 deflate 几乎无收益，纯浪费时间。 */
const ALREADY_COMPRESSED = new Set([
  ".gz", ".xz", ".bz2", ".zip", ".jar", ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".woff", ".woff2", ".pdf", ".7z", ".zst",
]);

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
   */
  add(name, data, opts = {}) {
    const { mode = 0o644, level = 6, comment = "", date = new Date("2026-01-01T00:00:00Z") } = opts;
    const nameBuf = Buffer.from(name, "utf8");
    const commentBuf = Buffer.from(comment, "utf8");
    const crc = crc32(data);

    let method = 0;
    let payload = data;
    if (level >= 0 && data.length > 0) {
      const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
      if (!ALREADY_COMPRESSED.has(ext)) {
        const deflated = deflateRawSync(data, { level });
        // 只有真的变小才用 deflate（小文件常见 deflate 反而更大）
        if (deflated.length < data.length) {
          method = 8;
          payload = deflated;
        }
      }
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
    local.writeUInt32LE(data.length, 22);
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
      uncompressedSize: data.length,
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
