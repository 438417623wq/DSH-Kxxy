/**
 * 最小 tar.gz 读取器。
 *
 * 为什么自己写而不是引依赖：构建期只用来解开两个 npm tarball（LibreOffice
 * wasm 引擎包、字体包），格式固定为 ustar（npm 的 `tar` 产物），用不到
 * GNU 长名扩展、稀疏文件、PAX 头。引一个 tar 依赖进 `tools/` 会让
 * 「构建脚本可以在裸 node 上跑」这条约束失效（本项目没有任何 node_modules）。
 *
 * 支持：普通文件（type '0' / '\0'）、目录（'5'）、前缀字段（ustar prefix）。
 * 不支持：硬链接、符号链接、PAX 扩展头 —— 遇到即抛，宁可硬失败也不要
 * 静默漏文件（漏一个 `soffice.data` 的代价是设备上 office 预览整块不可用）。
 */
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

/** tar 头里的字符串字段：NUL 截断，右侧空格填充。 */
function readStr(buf, offset, length) {
  let s = "";
  for (let i = 0; i < length; i += 1) {
    const c = buf[offset + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * 解出 gzip 压缩的 tar。
 *
 * @param {Buffer} gz 整个 .tgz 文件内容
 * @returns {Array<{path: string, type: string, data: Buffer}>} 按归档顺序
 */
export function untarGz(gz) {
  const tar = gunzipSync(gz);
  const entries = [];
  let off = 0;

  while (off + BLOCK <= tar.length) {
    const header = tar.subarray(off, off + BLOCK);
    // 连续两个全零块代表归档结束；这里遇到第一个就收工。
    if (header.every((b) => b === 0)) break;

    const name = readStr(header, 0, 100);
    const sizeField = readStr(header, 124, 12).trim();
    const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`tar 头解析失败：条目 ${name} 的 size 字段非法（"${sizeField}"）`);
    }
    const rawType = header[156];
    const type = rawType === 0 ? "0" : String.fromCharCode(rawType);
    const prefix = readStr(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;

    if (type === "1" || type === "2") {
      throw new Error(`tar 里出现链接条目（type=${type}）：${path} —— 本读取器不支持，需改用完整 tar 实现`);
    }
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      throw new Error(`tar 里出现扩展头（type=${type}）：${path} —— 本读取器不支持`);
    }

    const data = tar.subarray(off + BLOCK, off + BLOCK + size);
    if (type === "0" || type === "5") entries.push({ path, type, data });

    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }

  return entries;
}
