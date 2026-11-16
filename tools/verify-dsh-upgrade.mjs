/** 只读核验 DSH 增量资产；不导入生成器，避免生成器反向调用本验证器时形成循环。 */
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInflateRaw, crc32 } from 'node:zlib'
import { openIndexedZip } from './lib/zipedit.mjs'
import { readZipDirectory } from './lib/zipread.mjs'
import { HOST_PLUGIN_BASE, HOST_MARK_LINE_RE } from './lib/host-fingerprint.mjs'

export const DSH = Object.freeze({
  from: '0.2.1-rc.5', to: '0.2.2-rc.2', schema: 'kxxy-dsh-upgrade@1',
  root: 'kxxy-runtime.json', fingerprint: `${HOST_PLUGIN_BASE}lib/.fingerprint`,
  metaBytes: 128 * 1024, manifestBytes: 16 * 1024 * 1024,
  payloadBytes: 512 * 1024 * 1024, fileBytes: 128 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024, records: 40000, fingerprintBytes: 4096,
  archiveBytes: 0xffffffff - 1, runtimeEntries: 200000,
})
const CORE = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const NM = 'lib/node_modules/'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const require = (ok, message) => { if (!ok) throw new Error(message) }
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
function hash(value, label) {
  require(typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value), `${label}：SHA-256 格式无效`)
  return value.toLowerCase()
}
function integer(value, low, high, label) {
  require(Number.isSafeInteger(value) && value >= low && value <= high, `${label}：整数或大小超出上限`)
  return value
}
function decimal(text, high, label) {
  require(/^(0|[1-9][0-9]*)$/.test(text), `${label}：必须使用规范非负十进制整数`)
  return integer(Number(text), 0, high, label)
}

// JSON.parse 本身不会拒绝重复字段。逐层解析也覆盖转义后的同名字段、深度和节点上限。
export function parseDshJson(bytes, label = 'metadata') {
  const text = utf8(bytes)
  let at = 0, nodes = 0
  const space = () => { while (at < text.length && /[ \r\n\t]/.test(text[at])) at++ }
  const take = c => text[at] === c && (++at > 0)
  const expect = c => require(take(c), `${label}：JSON 语法错误 @${at}`)
  function string() {
    const start = at
    expect('"')
    while (at < text.length) {
      const c = text[at++]
      if (c === '"') return JSON.parse(text.slice(start, at))
      if (c === '\\') at++
    }
    throw new Error(`${label}：JSON 字符串截断`)
  }
  function value(depth) {
    require(depth <= 16 && ++nodes <= 20000, `${label}：JSON 结构超出上限`)
    space()
    if (take('{')) {
      const result = Object.create(null)
      space()
      if (take('}')) return result
      while (true) {
        space()
        const key = string()
        require(!Object.hasOwn(result, key), `${label}：JSON 重复字段 ${key}`)
        space(); expect(':'); result[key] = value(depth + 1); space()
        if (take('}')) return result
        expect(',')
      }
    }
    if (take('[')) {
      const result = []
      space()
      if (take(']')) return result
      while (true) {
        result.push(value(depth + 1)); space()
        if (take(']')) return result
        expect(',')
      }
    }
    if (text[at] === '"') return string()
    for (const [word, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, at)) { at += word.length; return result }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at))
    require(number && Number.isFinite(Number(number[0])), `${label}：JSON 数字或字面量无效`)
    at += number[0].length
    return Number(number[0])
  }
  const result = value(0)
  space()
  require(at === text.length && result !== null && typeof result === 'object' && !Array.isArray(result), `${label}：必须为单个 JSON 对象，不允许尾部内容`)
  return result
}

function metadata(meta) {
  require(meta.schema === 1 && meta.dshVersion === DSH.to && meta.dshPreviousVersion === DSH.from, 'metadata：DSH schema/目标版本/起始版本不符')
  integer(meta.runtimeSize, 22, DSH.archiveBytes, 'metadata runtimeSize')
  integer(meta.runtimeEntries, 1, DSH.runtimeEntries, 'metadata runtimeEntries')
  integer(meta.runtimeUncompressedBytes, 0, Number.MAX_SAFE_INTEGER, 'metadata runtimeUncompressedBytes')
  return { ...meta, runtimeSha256: hash(meta.runtimeSha256, 'metadata runtime'),
    dshUpgradeManifestSha256: hash(meta.dshUpgradeManifestSha256, 'metadata manifest'),
    kxxyHostFingerprint: hash(meta.kxxyHostFingerprint, 'metadata host') }
}

function pathParts(path) {
  const parts = path.split('/')
  require(path.length >= 1 && path.length <= 1024 && parts.every(part => part.length >= 1 && part.length <= 255 &&
    part !== '.' && part !== '..' && !part.endsWith('.') && /^[A-Za-z0-9_+@.\-]+$/.test(part) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(part.split('.')[0])), `manifest：非法路径 ${path}`)
  if (path !== DSH.root) {
    const pkg = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/
    require(parts.length >= 4 && parts[0] === 'lib' && parts[1] === 'node_modules' &&
      (parts[2].startsWith('@') ? parts.length >= 5 && pkg.test(parts[2].slice(1)) && pkg.test(parts[3]) : pkg.test(parts[2])), `manifest：路径越出包文件白名单 ${path}`)
  }
  return parts
}

/** 对齐 DshRuntimeUpgrade.loadManifest；先验证文本，再转换数值，不能用 split 后的宽松 Number 代替语法检查。 */
export function parseDshManifest(bytes, inputMeta) {
  const meta = metadata(inputMeta)
  require(bytes.length <= DSH.manifestBytes, 'manifest：字节数超出上限')
  require(sha(bytes) === meta.dshUpgradeManifestSha256, 'manifest：与可信 metadata 的 SHA 不符')
  const text = utf8(bytes)
  require(text.endsWith('\n') && !text.includes('\r'), 'manifest：必须为 UTF-8/LF 且以单个换行结尾')
  const lines = text.slice(0, -1).split('\n')
  require(lines.shift() === DSH.schema, 'manifest：schema 不符')
  function header(key) {
    const fields = (lines.shift() ?? '').split('\t')
    require(fields.length === 2 && fields[0] === key, `manifest：头缺失、重复或顺序错误 ${key}`)
    return fields[1]
  }
  const from = header('from'), to = header('to')
  require(from === DSH.from && to === DSH.to, 'manifest：升级版本不符')
  const baseHost = hash(header('base-host'), 'manifest base-host'), host = hash(header('host'), 'manifest host')
  require(host === meta.kxxyHostFingerprint, 'manifest：目标宿主与 metadata 不符')
  const payloadSha256 = hash(header('payload-sha256'), 'manifest payload')
  const payloadSize = decimal(header('payload-size'), DSH.payloadBytes, 'manifest payload-size')
  require(payloadSize >= 22, 'manifest：payload 太短')
  require(lines.length <= DSH.records, 'manifest：记录数超出上限')
  const records = [], names = new Set(), spellings = new Map()
  let unpackedBytes = 0
  for (const line of lines) {
    const fields = line.split('\t')
    require(fields.length === 6 && ['file', 'delete'].includes(fields[0]), 'manifest：记录必须恰好六列，不允许空行或尾部垃圾')
    const [kind, path, sizeText, modeText, target, previousText] = fields
    const parts = pathParts(path), lower = path.toLowerCase()
    require(!names.has(lower), `manifest：路径重复 ${path}`)
    names.add(lower)
    let prefix = ''
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part
      const key = prefix.toLowerCase()
      require(!spellings.has(key) || spellings.get(key) === prefix, `manifest：大小写别名 ${path}`)
      spellings.set(key, prefix)
    }
    const size = decimal(sizeText, DSH.fileBytes, `manifest size ${path}`)
    require(['420', '493'].includes(modeText), `manifest：非法 mode ${path}`)
    const sha256 = kind === 'file' ? hash(target, `manifest target ${path}`) : null
    require(kind !== 'delete' || target === '-', `manifest：delete 不允许目标 SHA ${path}`)
    const previous = previousText === '-' ? [] : previousText.split(',').map(value => hash(value, `manifest previous ${path}`))
    require(new Set(previous).size === previous.length && (kind === 'file' || previous.length > 0), `manifest：previous 重复或 delete 缺少旧 SHA ${path}`)
    if (kind === 'file') unpackedBytes += size
    require(unpackedBytes <= DSH.totalBytes, 'manifest：总解压大小超出上限')
    require(path !== DSH.fingerprint || size <= DSH.fingerprintBytes, 'manifest：宿主指纹文件超出上限')
    records.push({ kind, path, size, mode: Number(modeText), sha256, previous })
  }
  for (const record of records) {
    const parts = record.path.split('/')
    while (parts.pop() && parts.length) require(!names.has(parts.join('/').toLowerCase()), `manifest：文件与父目录重叠 ${record.path}`)
  }
  for (const path of [DSH.root, DSH.fingerprint]) require(records.some(r => r.path === path && r.kind === 'file'), `manifest：缺少必需文件 ${path}`)
  require(baseHost === host || records.find(r => r.path === DSH.fingerprint).previous.length > 0, 'manifest：跨宿主升级必须声明指纹文件 previous')
  const files = records.filter(r => r.kind === 'file')
  require(files.length <= DSH.records, 'payload：增量 ZIP 不得超过 40000 条文件记录')
  return { from, to, baseHost, host, payloadSha256, payloadSize, records, files, spellings, unpackedBytes }
}

function fileSize(path, max, min = 0) {
  const stat = lstatSync(path)
  require(stat.isFile() && !stat.isSymbolicLink(), `输入必须为普通文件：${path}`)
  return integer(stat.size, min, max, `输入 ${path}`)
}
function readBounded(path, max) {
  const size = fileSize(path, max), data = readFileSync(path)
  require(data.length === size, `读取期间文件长度变化：${path}`)
  return data
}
function hashFile(path, max, min = 22) {
  const size = fileSize(path, max, min), fd = openSync(path, 'r')
  try {
    const before = fstatSync(fd), digest = createHash('sha256'), buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
    let total = 0, n
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      total += n
      require(total <= size, `读取期间文件增大：${path}`)
      digest.update(buffer.subarray(0, n))
    }
    const after = fstatSync(fd)
    require(total === size && before.size === after.size && before.mtimeMs === after.mtimeMs, `读取期间文件变化：${path}`)
    return { size: total, sha256: digest.digest('hex') }
  } finally { closeSync(fd) }
}
function at(fd, length, offset, count) {
  require(Number.isSafeInteger(offset) && Number.isSafeInteger(count) && offset >= 0 && count >= 0 && offset + count <= length, 'ZIP：记录越界')
  const data = Buffer.alloc(count)
  let n = 0
  while (n < count) {
    const got = readSync(fd, data, n, count - n, offset + n)
    require(got > 0, 'ZIP：记录截断')
    n += got
  }
  return data
}
function payloadExtra(bytes) {
  const tags = new Set()
  let pos = 0
  while (pos < bytes.length) {
    require(pos + 4 <= bytes.length, 'payload：extra 截断')
    const tag = bytes.readUInt16LE(pos), size = bytes.readUInt16LE(pos + 2)
    require(!tags.has(tag) && ![1, 0x000d, 0x756e, 0x7075].includes(tag) && pos + 4 + size <= bytes.length, 'payload：禁止重复、链接、替代路径或 ZIP64 extra')
    tags.add(tag); pos += 4 + size
  }
}

// openIndexedZip 专用于本项目无 descriptor 的 runtime；payload 按 Android 合同另读，支持合法 descriptor。
function openPayload(path, manifest) {
  const size = fileSize(path, DSH.payloadBytes, 22), fd = openSync(path, 'r')
  try {
    const read = (offset, count) => at(fd, size, offset, count)
    const directory = readZipDirectory(read, size)
    require(!directory.zip64Count && directory.count === manifest.files.length && directory.count <= DSH.records, 'payload：必须为文件数匹配的 ZIP32')
    const records = new Map(manifest.files.map(r => [r.path, r])), entries = [], byName = new Map()
    let pos = directory.cdOffset
    const centralEnd = pos + directory.cdSize
    for (let i = 0; i < directory.count; i++) {
      require(pos + 46 <= centralEnd, 'payload：中央目录截断')
      const head = read(pos, 46)
      require(head.readUInt32LE(0) === 0x02014b50, 'payload：中央目录签名错误')
      const nl = head.readUInt16LE(28), el = head.readUInt16LE(30), cl = head.readUInt16LE(32)
      require(nl >= 1 && nl <= 1024 && pos + 46 + nl + el + cl <= centralEnd, 'payload：中央条目越界')
      const name = utf8(read(pos + 46, nl)), record = records.get(name)
      require(record && !byName.has(name), `payload：重复或清单外条目 ${name}`)
      const external = head.readUInt32LE(38), mode = external >>> 16, version = head.readUInt16LE(6)
      const flags = head.readUInt16LE(8), method = head.readUInt16LE(10), crc = head.readUInt32LE(16)
      const csize = head.readUInt32LE(20), entrySize = head.readUInt32LE(24), offset = head.readUInt32LE(42)
      require([3, 19].includes(head.readUInt16LE(4) >>> 8) && (mode & 0o170000) === 0o100000 && (mode & 0o7777) === record.mode && !(external & 16), `payload：不是约定的普通文件/mode ${name}`)
      require(version >= 10 && version <= 20 && !(flags & 0xf7f7) && [0, 8].includes(method) && entrySize === record.size && csize <= size && !head.readUInt16LE(34), `payload：方法、标记、版本或大小无效 ${name}`)
      payloadExtra(read(pos + 46 + nl, el))
      require(!utf8(read(pos + 46 + nl + el, cl)).startsWith('LINK:'), `payload：禁止 LINK ${name}`)
      require(offset + 30 <= directory.cdOffset, `payload：本地头越界 ${name}`)
      const local = read(offset, 30), lnl = local.readUInt16LE(26), lel = local.readUInt16LE(28)
      require(local.readUInt32LE(0) === 0x04034b50 && local.readUInt16LE(4) === version && local.readUInt16LE(6) === flags && local.readUInt16LE(8) === method && lnl === nl && utf8(read(offset + 30, lnl)) === name, `payload：本地/中央头不一致 ${name}`)
      payloadExtra(read(offset + 30 + lnl, lel))
      const dataOffset = offset + 30 + lnl + lel
      let end = dataOffset + csize
      if (flags & 8) {
        require(method === 8 && !local.readUInt32LE(14) && !local.readUInt32LE(18) && !local.readUInt32LE(22), `payload：descriptor 本地字段错误 ${name}`)
        if (read(end, 4).readUInt32LE(0) === 0x08074b50) end += 4
        const descriptor = read(end, 12)
        require(descriptor.readUInt32LE(0) === crc && descriptor.readUInt32LE(4) === csize && descriptor.readUInt32LE(8) === entrySize, `payload：descriptor 不一致 ${name}`)
        end += 12
      } else require(local.readUInt32LE(14) === crc && local.readUInt32LE(18) === csize && local.readUInt32LE(22) === entrySize, `payload：本地大小/CRC 不一致 ${name}`)
      require(end <= directory.cdOffset && (method !== 0 || csize === entrySize), `payload：数据范围无效 ${name}`)
      const entry = { name, offset, dataOffset, end, csize, size: entrySize, crc, method, mode }
      entries.push(entry); byName.set(name, entry)
      pos += 46 + nl + el + cl
    }
    require(pos === centralEnd, 'payload：中央目录含额外记录')
    let cursor = 0
    for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
      require(entry.offset === cursor, `payload：本地记录存在间隙、重叠或隐藏数据 ${entry.name}`)
      cursor = entry.end
    }
    require(cursor === directory.cdOffset, 'payload：含未声明本地数据')
    return { fd, entries, byName, close: () => closeSync(fd) }
  } catch (error) { closeSync(fd); throw error }
}

/** 同时核验实际解压大小、CRC 和 SHA；不持有整个 payload/runtime，只有显式的小文件才收集内容。 */
async function content(zip, entry, limit = DSH.fileBytes, capture = false) {
  require(entry && entry.size <= limit, `ZIP：文件缺失或超出读取上限 ${entry?.name ?? ''}`)
  const digest = createHash('sha256'), chunks = []
  let size = 0, crc = 0, raw, inflater
  try {
    if (entry.csize) {
      // ReadStream.destroy() can close an explicitly supplied descriptor even with
      // autoClose:false. ZIP entries share this fd; an owned chunk iterator must
      // never close it when one entry finishes or a negative fixture is rejected.
      raw = Readable.from((function* () {
        let offset = entry.dataOffset, remaining = entry.csize
        while (remaining > 0) {
          const bytes = Buffer.allocUnsafe(Math.min(remaining, 64 * 1024))
          const n = readSync(zip.fd, bytes, 0, bytes.length, offset)
          require(n > 0, `ZIP：压缩数据截断 ${entry.name}`)
          offset += n; remaining -= n
          yield bytes.subarray(0, n)
        }
      })(), { objectMode: false, highWaterMark: 64 * 1024 })
      let stream = raw
      if (entry.method === 8) {
        inflater = createInflateRaw({ chunkSize: 64 * 1024 })
        raw.on('error', error => inflater.destroy(error))
        stream = raw.pipe(inflater)
      }
      for await (const bytes of stream) {
        size += bytes.length
        require(size <= entry.size && size <= limit, `ZIP：实际解压大小超限 ${entry.name}`)
        digest.update(bytes); crc = crc32(bytes, crc)
        if (capture) chunks.push(bytes)
      }
      require(!inflater || inflater.bytesWritten === entry.csize, `ZIP：DEFLATE 后存在未消费数据 ${entry.name}`)
    } else require(entry.method === 0, `ZIP：DEFLATE 流缺失 ${entry.name}`)
    require(size === entry.size && crc === entry.crc, `ZIP：实际大小/CRC 不符 ${entry.name}`)
    return { size, sha256: digest.digest('hex'), ...(capture ? { data: Buffer.concat(chunks, size) } : {}) }
  } finally { raw?.destroy(); inflater?.destroy() }
}
function regular(entry, label, mode) {
  require(entry && !entry.name.endsWith('/') && !entry.comment?.startsWith('LINK:') && (entry.mode & 0o170000) === 0o100000 &&
    (mode === undefined || (entry.mode & 0o7777) === mode), `${label}：缺少普通文件、存在 LINK 或 mode 不符`)
  return entry
}
async function small(zip, name, limit = DSH.manifestBytes) {
  return (await content(zip, regular(zip.byName.get(name), name), limit, true)).data
}
function managedNamespace(zip, manifest, baseline = false) {
  const label = baseline ? 'baseline' : 'runtime'
  const records = new Map(manifest.records.map(r => [r.path.toLowerCase(), r]))
  for (const entry of zip.entries) {
    const isDir = entry.name.endsWith('/'), parts = entry.name.replace(/\/$/, '').split('/')
    let prefix = ''
    for (let i = 0; i < parts.length; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]
      const key = prefix.toLowerCase(), expected = manifest.spellings.get(key)
      require(!expected || expected === prefix, `runtime：受管路径大小写别名 ${entry.name}`)
      const record = records.get(key)
      if (record) require(record.kind === 'file' && !isDir && i === parts.length - 1, `runtime：delete 未缺失或受管文件成为父目录 ${entry.name}`)
      if (!isDir && i === parts.length - 1 && expected && !record) throw new Error(`runtime：受管父路径不是目录 ${entry.name}`)
    }
  }
}
async function versions(zip, expected) {
  const result = {}
  for (const pkg of CORE) {
    const data = parseDshJson(await small(zip, `${NM}${pkg}/package.json`, 1024 * 1024), pkg)
    require(data.name === pkg && data.version === expected, `runtime：官方核心版本不符 ${pkg}`)
    result[pkg] = data.version
  }
  return result
}
async function hostFingerprint(zip, expected) {
  const rows = []
  let index
  for (const entry of zip.entries) {
    if (!entry.name.startsWith(HOST_PLUGIN_BASE) || entry.name.endsWith('/') || entry.name === DSH.fingerprint) continue
    regular(entry, `host ${entry.name}`)
    const isIndex = entry.name === `${HOST_PLUGIN_BASE}lib/index.js`
    const actual = await content(zip, entry, DSH.fileBytes, isIndex)
    if (isIndex) index = utf8(actual.data)
    rows.push(`${entry.name.slice(HOST_PLUGIN_BASE.length)}\0${isIndex ? sha(Buffer.from(index.replace(HOST_MARK_LINE_RE, ''))) : actual.sha256}`)
  }
  require(rows.length > 0 && index !== undefined, 'runtime：宿主树或入口缺失')
  const actual = sha(Buffer.from(rows.sort().join('\n'))), marker = `kxxy-host@${actual.slice(0, 12)}`
  const text = utf8(await small(zip, DSH.fingerprint, DSH.fingerprintBytes))
  const field = key => {
    const matches = text.split(/\r?\n/).filter(line => line.startsWith(`${key}:`))
    require(matches.length === 1, `runtime：宿主指纹字段缺失或重复 ${key}`)
    return matches[0].slice(key.length + 1).trim()
  }
  require(actual === expected && hash(field('fingerprint'), 'runtime fingerprint') === actual && field('algorithm') === 'sha256' &&
    decimal(field('files'), DSH.runtimeEntries, 'host files') === rows.length && field('marker') === marker && index.startsWith(`/* ${marker} */\n`), 'runtime：H1/H0 宿主实际内容、指纹文件或入口标记不符')
  return { fingerprint: actual, marker, files: rows.length }
}
async function rootManifest(zip, host, meta) {
  const root = parseDshJson(await small(zip, DSH.root), 'runtime root manifest')
  const directories = zip.entries.filter(e => e.name.endsWith('/')).length
  const links = zip.entries.filter(e => e.comment.startsWith('LINK:')).length
  require(Number.isSafeInteger(root.schemaVersion) && root.schemaVersion > 0 && root.entries === zip.entries.length && root.directories === directories && root.linkEntries === links, 'runtime：root manifest schema/条目/目录/LINK 计数不符')
  require(hash(root.plugins?.hostFingerprint, 'root host') === host.fingerprint && root.plugins.hostMarker === host.marker, 'runtime：root manifest 与 H1/H0 不符')
  if (meta) {
    require(meta.kxxyHostMarker === host.marker, 'metadata：宿主 marker 不符')
    if (meta.codexPluginFingerprint !== undefined) require(hash(root.plugins.codexFingerprint, 'root codex') === hash(meta.codexPluginFingerprint, 'metadata codex'), 'runtime：root Codex 指纹与 metadata 不符')
    if (meta.pythonRuntimeRevision !== undefined) require(root.pythonRuntimeRevision === meta.pythonRuntimeRevision, 'runtime：root Python revision 与 metadata 不符')
  }
  return root
}

async function verifyBaseline(path, runtime, manifest) {
  fileSize(path, DSH.archiveBytes, 22)
  const old = openIndexedZip(path)
  try {
    await versions(old, DSH.from)
    const host = await hostFingerprint(old, manifest.baseHost), root = await rootManifest(old, host)
    const managed = new Set(manifest.records.map(r => r.path))
    let previousFiles = 0, addedFiles = 0, additionalPreviousHashesUnchecked = 0, preservedFiles = 0, nonDshFiles = 0
    for (const record of manifest.records) {
      require(!(root.placeholderPaths ?? []).includes(record.path), `baseline：受管文件是设备重写路径 ${record.path}`)
      const entry = old.byName.get(record.path)
      if (!entry) {
        require(record.kind === 'file' && record.previous.length === 0, `baseline：previous 指向不存在的旧文件 ${record.path}`)
        addedFiles++
      } else {
        regular(entry, `baseline ${record.path}`)
        const actual = await content(old, entry)
        require(record.previous.includes(actual.sha256), `baseline：previous 与真实旧文件 SHA 不符 ${record.path}`)
        require(record.kind !== 'delete' || (actual.size === record.size && (entry.mode & 0o7777) === record.mode), `baseline：delete 旧 size/mode 不符 ${record.path}`)
        previousFiles++
        additionalPreviousHashesUnchecked += record.previous.length - 1
      }
    }
    // 不只比较 CRC：所有未列入增量的文件都逐字节摘要比对，包括 Python/native/Codex 等非 DSH 范围。
    for (const entry of old.entries) {
      if (entry.name.endsWith('/') || managed.has(entry.name)) continue
      const target = runtime.byName.get(entry.name)
      require(target && entry.size === target.size && entry.mode === target.mode && entry.comment === target.comment, `baseline：未受管文件丢失或元数据变化 ${entry.name}`)
      const before = await content(old, entry, DSH.archiveBytes), after = await content(runtime, target, DSH.archiveBytes)
      require(before.sha256 === after.sha256, `baseline：未受管文件实际内容变化 ${entry.name}`)
      preservedFiles++
      if (!entry.name.startsWith(NM) && entry.name !== DSH.root) nonDshFiles++
    }
    for (const entry of runtime.entries) if (!entry.name.endsWith('/') && !managed.has(entry.name)) {
      require(old.byName.has(entry.name), `baseline：出现未声明的新文件 ${entry.name}`)
    }
    return { path, ...hashFile(path, DSH.archiveBytes), previousFiles, addedFiles, preservedFiles, nonDshFiles,
      additionalPreviousHashesUnchecked, nonDshFilesPreserved: true, archiveDirectoryRecordsCompared: false }
  } finally { old.close() }
}

/**
 * 按 Node 的 `NODE_MODULES_PATHS` 语义重放一遍依赖解析，只判一件事：
 * 命中的 `node_modules/<dep>/` 目录里有没有 package.json。
 *
 * 为什么需要：0.2.2 把嵌套依赖整体提升到顶层，退役旧 `pkg/node_modules/<dep>` 时
 * 若只搬走文件、留下空目录，Node 会把空目录当成「包」，`legacyMainResolve` 找不到
 * `index.js` 直接 `Cannot find package '…/negotiator/index.js'`，插件全部 import 失败
 * （真机 kxxy-rescue-1794587746278）。这类目录在归档里看起来「正常」，静态 checksum
 * 全部通过，只有按解析顺序走一遍才暴露，所以在打包阶段就拦住。
 */
async function dependencyResolution(zip) {
  const dirs = new Set(), manifests = []
  for (const entry of zip.entries) {
    if (entry.name.endsWith('/')) dirs.add(entry.name)
    else if (entry.name.endsWith('/package.json') && entry.name.startsWith(NM)) manifests.push(entry)
  }
  const known = new Set(manifests.map(entry => entry.name))
  const shadowed = [], unresolved = []
  let edges = 0
  for (const entry of manifests) {
    const dir = entry.name.slice(0, -'package.json'.length), parts = dir.split('/').filter(Boolean)
    let json
    try { json = JSON.parse(utf8((await content(zip, entry, DSH.fileBytes, true)).data)) } catch (_) {
      throw new Error(`runtime：package.json 不是合法 JSON ${entry.name}`)
    }
    for (const dep of Object.keys(json.dependencies ?? {})) {
      edges++
      let hit
      for (let i = parts.length - 1; i >= 0 && hit === undefined; i--) {
        if (parts[i] === 'node_modules') continue
        const candidate = `${parts.slice(0, i + 1).join('/')}/node_modules/${dep}/`
        if (dirs.has(candidate)) hit = candidate
      }
      if (hit === undefined) unresolved.push(`${dir} → ${dep}`)
      else if (!known.has(`${hit}package.json`)) shadowed.push(`${hit}（被 ${dir} 依赖的 ${dep}）`)
    }
  }
  return { packages: manifests.length, edges, shadowed, unresolved }
}

export async function verifyDshUpgrade({ runtime, assetDir, metaPath, baseline }) {
  const metaBytes = readBounded(metaPath, DSH.metaBytes), meta = metadata(parseDshJson(metaBytes))
  const manifestBytes = readBounded(join(assetDir, 'manifest.tsv'), DSH.manifestBytes)
  const manifest = parseDshManifest(manifestBytes, meta), payloadPath = join(assetDir, 'payload.zip')
  const payloadHash = hashFile(payloadPath, DSH.payloadBytes)
  require(payloadHash.size === manifest.payloadSize && payloadHash.sha256 === manifest.payloadSha256, 'payload：实际 size/SHA 与 manifest 不符')
  const runtimeHash = hashFile(runtime, DSH.archiveBytes)
  require(runtimeHash.size === meta.runtimeSize && runtimeHash.sha256 === meta.runtimeSha256, 'runtime：实际 size/SHA 与可信 metadata 不符')
  const zip = openIndexedZip(runtime)
  let payload
  try {
    payload = openPayload(payloadPath, manifest)
    const uncompressedBytes = zip.entries.reduce((sum, e) => sum + e.size, 0)
    require(zip.entries.length === meta.runtimeEntries && uncompressedBytes === meta.runtimeUncompressedBytes, 'runtime：实际目录计数/未压缩大小与 metadata 不符')
    managedNamespace(zip, manifest)
    for (const record of manifest.records) {
      if (record.kind === 'delete') { require(!zip.byName.has(record.path), `runtime：delete 未缺失 ${record.path}`); continue }
      const target = regular(zip.byName.get(record.path), `runtime ${record.path}`, record.mode)
      const actual = await content(payload, payload.byName.get(record.path)), full = await content(zip, target)
      require(actual.size === record.size && actual.sha256 === record.sha256, `payload：实际文件 SHA/size 不符 ${record.path}`)
      require(full.size === record.size && full.sha256 === record.sha256, `runtime：文件与 payload/manifest 不同 ${record.path}`)
    }
    const coreVersions = await versions(zip, DSH.to), host = await hostFingerprint(zip, manifest.host)
    await rootManifest(zip, host, meta)
    const resolution = await dependencyResolution(zip)
    require(resolution.shadowed.length === 0,
      `runtime：node_modules 里存在没有 package.json 的包目录，Node 会把它们当成包并解析失败：${resolution.shadowed.slice(0, 3).join('；')}`)
    const baselineResult = baseline ? await verifyBaseline(baseline, zip, manifest) : null
    return {
      schema: 1, runtime, assetDir, metaPath, from: manifest.from, to: manifest.to,
      coreVersions, baseHostFingerprint: manifest.baseHost, hostFingerprint: host.fingerprint, hostFiles: host.files,
      metadataSha256: sha(metaBytes), manifestSha256: sha(manifestBytes), manifestSize: manifestBytes.length,
      payloadSha256: payloadHash.sha256, payloadSize: payloadHash.size,
      runtimeSha256: runtimeHash.sha256, runtimeSize: runtimeHash.size, runtimeEntries: zip.entries.length,
      runtimeUncompressedBytes: uncompressedBytes, runtimeZip64Count: zip.directory.zip64Count,
      files: manifest.files.length, retiredFiles: manifest.records.length - manifest.files.length, unpackedBytes: manifest.unpackedBytes,
      dependencyResolution: { packages: resolution.packages, edges: resolution.edges,
        shadowed: resolution.shadowed.length, unresolved: resolution.unresolved.length },
      baseline: baselineResult, baselineVerified: baselineResult !== null, nonDshFilesPreserved: baselineResult?.nonDshFilesPreserved ?? null,
      checksPassed: true, deviceInstalled: false, deviceVerified: false,
      remainingChecks: [
        ...(!baseline ? ['未提供 baseline，未验证 previous 的真实旧文件及非 DSH 范围保留。'] : []),
        ...(baselineResult?.additionalPreviousHashesUnchecked ? ['单个 baseline 仅验证每条记录包含该基线的真实 SHA，其余候选 previous 未获独立发布基线证明。'] : []),
        ...(resolution.unresolved.length ? [`依赖解析重放有 ${resolution.unresolved.length} 条未命中（可能是 optional/peer 或本脚本的近似）：${resolution.unresolved.slice(0, 3).join('；')}`] : []),
        '静态资产验证不等于 Android 安装、升级或功能自检通过。',
      ],
    }
  } finally { payload?.close(); zip.close() }
}

const usage = '用法：node tools/verify-dsh-upgrade.mjs <runtime.zip> <dsh-upgrade目录> <build.json> [--baseline <旧runtime.zip>]\n只读验证；三个位置参数必填，baseline 可选。不生成资产，成功仅向 stdout 输出 JSON；失败退出码为 1。'
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) console.log(usage)
    else {
      require((args.length === 3 || (args.length === 5 && args[3] === '--baseline')) && args.slice(0, 3).every(a => !a.startsWith('--')) && (args.length === 3 || !args[4].startsWith('--')), usage)
      console.log(JSON.stringify(await verifyDshUpgrade({ runtime: resolve(args[0]), assetDir: resolve(args[1]), metaPath: resolve(args[2]), baseline: args[4] ? resolve(args[4]) : undefined }), null, 2))
    }
  } catch (error) { console.error(`DSH 资产验证失败：${error.message}`); process.exitCode = 1 }
}
