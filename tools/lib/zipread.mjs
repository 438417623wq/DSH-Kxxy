/**
 * ZIP 读取器（STORE/DEFLATE）。完整 runtime 支持有界的 ZIP64 条目计数；
 * 文件大小、偏移仍为 32 位，逐文件 ZIP64 extra、分卷与加密继续拒绝。
 * readZipDirectory 使用随机读，供约 1 GiB 的 runtime 核验/重封共用，避免整包常驻。
 * openZip/readZipEntries 保留原来的内存接口，可读取带签名块/descriptor 的普通 APK。
 */
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { crc32, MAX_ZIP_ENTRIES, MAX_ZIP_CENTRAL_BYTES, ZIP32_SENTINEL } from './zipwrite.mjs'

/**
 * @param {(offset: number, length: number) => Buffer} readAt 精确随机读取
 * @param {number} size 文件总长度
 * @returns {{count:number, cdOffset:number, cdSize:number, eocdOffset:number, zip64Count:boolean}}
 */
export function readZipDirectory(readAt, size) {
  if (!Number.isSafeInteger(size) || size < 22 || size >= ZIP32_SENTINEL) throw new Error('ZIP 文件长度超出 32 位归档合同')
  const checkedRead = (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
      throw new Error('ZIP 结束记录越界')
    }
    const bytes = readAt(offset, length)
    if (bytes.length !== length) throw new Error('ZIP 结束记录截断')
    return bytes
  }
  const tailSize = Math.min(size, 65_557)
  const tail = checkedRead(size - tailSize, tailSize)
  let end = -1
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break }
  }
  if (end < 0) throw new Error('ZIP 缺少合法 EOCD')
  const eocdOffset = size - tailSize + end
  let count = tail.readUInt16LE(end + 10)
  const cdSize = tail.readUInt32LE(end + 12)
  const cdOffset = tail.readUInt32LE(end + 16)
  if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count) {
    throw new Error('ZIP 不支持分卷或不同的卷内计数')
  }
  if (cdSize === ZIP32_SENTINEL || cdOffset === ZIP32_SENTINEL) throw new Error('ZIP64 只支持计数，不支持 64 位大小或偏移')
  const zip64Count = count === 0xffff
  let directoryEnd = eocdOffset
  if (zip64Count) {
    const locator = checkedRead(eocdOffset - 20, 20)
    if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
      throw new Error('ZIP64 locator 缺失、损坏或分卷')
    }
    const offset64 = locator.readBigUInt64LE(8)
    if (offset64 >= BigInt(ZIP32_SENTINEL) || offset64 + 56n !== BigInt(eocdOffset - 20)) {
      throw new Error('ZIP64 EOCD 偏移或长度不符合计数扩展合同')
    }
    directoryEnd = Number(offset64)
    const z64 = checkedRead(directoryEnd, 56)
    if (z64.readUInt32LE(0) !== 0x06064b50 || z64.readBigUInt64LE(4) !== 44n || z64.readUInt16LE(14) !== 45 ||
        z64.readUInt32LE(16) !== 0 || z64.readUInt32LE(20) !== 0) throw new Error('ZIP64 EOCD 头部不符合计数扩展合同')
    const count64 = z64.readBigUInt64LE(32)
    if (count64 < 0xffffn || count64 > BigInt(MAX_ZIP_ENTRIES) || z64.readBigUInt64LE(24) !== count64) {
      throw new Error('ZIP64 条目计数越界或不一致')
    }
    if (z64.readBigUInt64LE(40) !== BigInt(cdSize) || z64.readBigUInt64LE(48) !== BigInt(cdOffset)) {
      throw new Error('ZIP64 与 ZIP32 中央目录大小/偏移不一致')
    }
    count = Number(count64)
  }
  if (count > MAX_ZIP_ENTRIES || cdSize > MAX_ZIP_CENTRAL_BYTES || cdSize < count * 46 ||
      cdOffset + cdSize !== directoryEnd || (!count && cdSize !== 0)) throw new Error('ZIP 中央目录长度、计数或位置异常')
  return { count, cdSize, cdOffset, eocdOffset, zip64Count }
}

/** 不接受逐文件 ZIP64；验证 extra 边界，避免仅因主字段未溢出而忽略歧义。 */
export function assertZip32Extra(extra) {
  let p = 0
  while (p < extra.length) {
    if (p + 4 > extra.length) throw new Error('ZIP extra 头部截断')
    const tag = extra.readUInt16LE(p), length = extra.readUInt16LE(p + 2)
    if (tag === 1) throw new Error('不支持逐文件 ZIP64 extra')
    p += 4 + length
    if (p > extra.length) throw new Error('ZIP extra 内容截断')
  }
}

function bufferEntries(buf) {
  const info = readZipDirectory((offset, length) => buf.subarray(offset, offset + length), buf.length)
  const result = [], names = new Set()
  const cdEnd = info.cdOffset + info.cdSize
  let p = info.cdOffset
  for (let i = 0; i < info.count; i += 1) {
    if (p + 46 > cdEnd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录签名错误（第 ${i} 项）`)
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24)
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42), next = p + 46 + nl + el + cl
    if (next > cdEnd || !nl || buf.readUInt16LE(p + 34)) throw new Error('ZIP 中央目录条目截断或分卷')
    if (size === ZIP32_SENTINEL || csize === ZIP32_SENTINEL || localOffset === ZIP32_SENTINEL) throw new Error('不支持逐文件 ZIP64 大小或偏移')
    if ((flags & 0x0041) || ![0, 8].includes(method)) throw new Error('ZIP 不支持加密或压缩方式')
    const name = buf.toString('utf8', p + 46, p + 46 + nl)
    if (names.has(name)) throw new Error(`重复 ZIP 条目：${name}`)
    names.add(name)
    assertZip32Extra(buf.subarray(p + 46 + nl, p + 46 + nl + el))
    if (localOffset + 30 > info.cdOffset || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`本地头越界或签名错误：${name}`)
    if (buf.readUInt16LE(localOffset + 6) !== flags || buf.readUInt16LE(localOffset + 8) !== method) throw new Error(`本地头与中央目录不一致：${name}`)
    const lnl = buf.readUInt16LE(localOffset + 26), lel = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + lnl + lel
    if (start + csize > info.cdOffset || buf.toString('utf8', localOffset + 30, localOffset + 30 + lnl) !== name) throw new Error(`ZIP 条目数据越界或名称不一致：${name}`)
    assertZip32Extra(buf.subarray(localOffset + 30 + lnl, start))
    if (!(flags & 8) && (buf.readUInt32LE(localOffset + 14) !== crc || buf.readUInt32LE(localOffset + 18) !== csize ||
        buf.readUInt32LE(localOffset + 22) !== size)) throw new Error(`ZIP 本地头长度/CRC 不一致：${name}`)
    result.push({ name, method, crc, size, raw: buf.subarray(start, start + csize) })
    p = next
  }
  if (p !== cdEnd) throw new Error('ZIP 中央目录长度不一致')
  return result
}

/** 逐条枚举原始压缩字节，不改变 APK 内已有的压缩方式。 */
export function readZipEntries(path) {
  return bufferEntries(readFileSync(path))
}

/** 打开 ZIP 建立索引；读取时验证解压长度与 CRC。 */
export function openZip(path) {
  const index = new Map(bufferEntries(readFileSync(path)).map(entry => [entry.name, entry]))
  return {
    names: () => [...index.keys()],
    read(name) {
      const e = index.get(name)
      if (!e) return null
      if (e.size > 256 * 1024 * 1024) throw new Error(`ZIP 条目超出读取上限：${name}`)
      const data = e.method === 8 ? inflateRawSync(e.raw, { maxOutputLength: Math.max(1, e.size) }) : Buffer.from(e.raw)
      if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`ZIP CRC/长度不符：${name}`)
      return data
    },
  }
}
