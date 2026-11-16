/**
 * 小补丁重封：复用 ZipWriter 生成新增记录，其余本地记录逐块原样搬运。
 * 与 restamp-codex-plugin 相同，只接受本项目无 data descriptor 的 ZIP；
 * 不把近 1 GiB 的 runtime.zip 整份读入内存，也不覆盖源文件。
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { ZipWriter, crc32, zipEndRecords, MAX_ZIP_ENTRIES, ZIP32_SENTINEL } from './zipwrite.mjs'
import { readZipDirectory, assertZip32Extra } from './zipread.mjs'

function readAt(fd, offset, length) {
  const data = Buffer.allocUnsafeSlow(length)
  let done = 0
  while (done < length) {
    const n = readSync(fd, data, done, length - done, offset + done)
    if (!n) throw new Error(`ZIP 提前结束 @${offset + done}`)
    done += n
  }
  return data
}

export function validateZipPath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || name.startsWith('/') ||
      name.replace(/\/$/, '').split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error(`非法 ZIP 路径：${name}`)
  }
}

/** 随机读取器；read() 校验 CRC，readResolved() 只解析本项目的 LINK 注释。 */
export function openIndexedZip(path) {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const directory = readZipDirectory((offset, length) => readAt(fd, offset, length), size)
    const { count, cdSize, cdOffset } = directory
    const cd = readAt(fd, cdOffset, cdSize)
    const entries = []
    const byName = new Map()
    let p = 0
    for (let i = 0; i < count; i += 1) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏')
      const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32)
      const next = p + 46 + nl + el + cl
      if (next > cd.length) throw new Error('中央目录条目截断')
      const name = cd.toString('utf8', p + 46, p + 46 + nl)
      validateZipPath(name)
      if (byName.has(name)) throw new Error(`重复 ZIP 条目：${name}`)
      const entry = {
        name, central: Buffer.from(cd.subarray(p, next)), offset: cd.readUInt32LE(p + 42),
        flags: cd.readUInt16LE(p + 8), method: cd.readUInt16LE(p + 10), crc: cd.readUInt32LE(p + 16),
        csize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24),
        mode: cd.readUInt32LE(p + 38) >>> 16, comment: cd.toString('utf8', p + 46 + nl + el, next),
      }
      if (entry.flags & 0x0049 || ![0, 8].includes(entry.method)) throw new Error(`不支持加密、descriptor 或压缩方式：${name}`)
      if (cd.readUInt16LE(p + 34) || entry.offset === ZIP32_SENTINEL || entry.csize === ZIP32_SENTINEL || entry.size === ZIP32_SENTINEL ||
          entry.offset + 30 > cdOffset) throw new Error(`不支持分卷、逐文件 ZIP64 或越界条目：${name}`)
      assertZip32Extra(cd.subarray(p + 46 + nl, p + 46 + nl + el))
      const local = readAt(fd, entry.offset, 30)
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags ||
          local.readUInt16LE(8) !== entry.method || local.readUInt32LE(14) !== entry.crc ||
          local.readUInt32LE(18) !== entry.csize || local.readUInt32LE(22) !== entry.size) throw new Error(`ZIP 本地头与中央目录不一致：${name}`)
      const localName = readAt(fd, entry.offset + 30, local.readUInt16LE(26)).toString('utf8')
      if (localName !== name) throw new Error(`ZIP 本地路径不一致：${name}`)
      entry.dataOffset = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
      entry.extent = entry.dataOffset + entry.csize - entry.offset
      if (entry.dataOffset + entry.csize > cdOffset) throw new Error(`ZIP 条目越界：${name}`)
      assertZip32Extra(readAt(fd, entry.offset + 30 + local.readUInt16LE(26), local.readUInt16LE(28)))
      entries.push(entry)
      byName.set(name, entry)
      p = next
    }
    if (p !== cd.length) throw new Error('中央目录长度不一致')
    const sorted = [...entries].sort((a, b) => a.offset - b.offset)
    let cursor = 0
    for (const entry of sorted) {
      if (entry.offset !== cursor) throw new Error(`ZIP 记录不连续或重叠：${entry.name}`)
      cursor += entry.extent
    }
    if (cursor !== cdOffset) throw new Error('ZIP 数据尾部有未识别记录')
    const read = (name, maxBytes = 256 * 1024 * 1024) => {
      const entry = byName.get(name)
      if (!entry) return null
      if (entry.size > maxBytes || entry.csize > maxBytes) throw new Error(`ZIP 条目超出读取上限：${name}`)
      const raw = readAt(fd, entry.dataOffset, entry.csize)
      const data = entry.method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }) : raw
      if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error(`ZIP CRC/长度不符：${name}`)
      return data
    }
    const readResolved = (name, visited = new Set()) => {
      if (visited.has(name) || visited.size > 16) throw new Error(`LINK 循环：${name}`)
      visited.add(name)
      const entry = byName.get(name)
      if (!entry) return null
      return entry.comment.startsWith('LINK:') ? readResolved(entry.comment.slice(5), visited) : read(name)
    }
    return { path, fd, size, entries, byName, sorted, read, readResolved, directory, close: () => closeSync(fd) }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function writeAll(fd, buffer) {
  let written = 0
  while (written < buffer.length) {
    const n = writeSync(fd, buffer, written, buffer.length - written)
    if (!n) throw new Error('ZIP 写入失败')
    written += n
  }
}

/** files: Map<path, {data: Buffer, mode: number, comment?: string}> */
export async function writeSmallZip(path, files, options = {}) {
  const fd = openSync(path, 'wx')
  try {
    const zip = new ZipWriter((buffer) => writeAll(fd, buffer), options)
    for (const [name, file] of [...files].sort(([a], [b]) => a < b ? -1 : 1)) {
      validateZipPath(name)
      await zip.add(name, file.data, { mode: file.mode ?? 0o644, comment: file.comment ?? '' })
    }
    return zip.finish()
  } finally { closeSync(fd) }
}

export function sha256File(path) {
  const fd = openSync(path, 'r')
  try {
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafeSlow(4 * 1024 * 1024)
    let n
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, n))
    return digest.digest('hex')
  } finally { closeSync(fd) }
}

export async function patchZip(input, output, files, removed = new Set(), { allowZip64Count = false } = {}) {
  if (resolve(input) === resolve(output) || existsSync(output)) throw new Error(`拒绝覆盖已有归档：${output}`)
  for (const name of files.keys()) if (removed.has(name)) throw new Error(`条目不能同时删除和替换：${name}`)
  mkdirSync(dirname(output), { recursive: true })
  const patchPath = `${output}.patch-${process.pid}.zip`
  const tmp = `${output}.part-${process.pid}`
  const source = openIndexedZip(input)
  let patch, out, published = false
  try {
    await writeSmallZip(patchPath, files, { allowZip64Count })
    patch = openIndexedZip(patchPath)
    const selected = source.sorted.filter((entry) => !files.has(entry.name) && !removed.has(entry.name)).map((entry) => [source, entry])
    selected.push(...patch.sorted.map((entry) => [patch, entry]))
    if (selected.length > MAX_ZIP_ENTRIES || (!allowZip64Count && selected.length >= 0xffff)) throw new Error('重封条目数超过允许的 ZIP 格式上限')
    out = openSync(tmp, 'wx')
    const digest = createHash('sha256')
    let offset = 0, uncompressedBytes = 0
    const emit = (buffer) => { writeAll(out, buffer); digest.update(buffer); offset += buffer.length }
    const buffer = Buffer.allocUnsafeSlow(4 * 1024 * 1024)
    const central = []
    for (const [archive, entry] of selected) {
      const head = Buffer.from(entry.central)
      if (offset >= 0xffffffff) throw new Error('重封超过 ZIP32 大小上限')
      head.writeUInt32LE(offset, 42)
      central.push(head)
      uncompressedBytes += entry.size
      let copied = 0
      while (copied < entry.extent) {
        const n = readSync(archive.fd, buffer, 0, Math.min(buffer.length, entry.extent - copied), entry.offset + copied)
        if (!n) throw new Error(`复制 ZIP 记录失败：${entry.name}`)
        emit(buffer.subarray(0, n))
        copied += n
      }
    }
    const cdOffset = offset
    for (const head of central) emit(head)
    if (offset >= 0xffffffff) throw new Error('重封超过 ZIP32 大小上限')
    emit(zipEndRecords(selected.length, offset - cdOffset, cdOffset, { allowZip64Count }))
    closeSync(out); out = undefined
    if (existsSync(output)) throw new Error(`拒绝覆盖已有归档：${output}`)
    renameSync(tmp, output)
    published = true
    return { sha256: digest.digest('hex'), size: offset, entries: selected.length, uncompressedBytes, zip64Count: selected.length >= 0xffff }
  } finally {
    if (out !== undefined) closeSync(out)
    patch?.close()
    source.close()
    if (existsSync(patchPath)) rmSync(patchPath)
    if (!published && existsSync(tmp)) rmSync(tmp)
  }
}
