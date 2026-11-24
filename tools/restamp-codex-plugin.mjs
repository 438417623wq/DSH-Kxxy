/**
 * 把改过的 Codex 侧栏源码**增量**重封进一份已有的 `runtime.zip`。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 *
 * 插件文件（`plugins/dsh-codex-sidebar/**`）是 `build-runtime.mjs` 在装配阶段
 * 塞进 asar 侧的，随后 `stampCodexPlugin()` 按「相对路径 + 内容 sha256」算出
 * `plugin.fingerprint`，再写进 `kxxy-runtime.json` 的 `plugins.codexFingerprint`
 * 与 `assets/meta/build.json` 的 `codexPluginFingerprint`。三处必须逐字一致：
 *
 *   · `verify-codex-apk.py` 会逐个文件比对 APK 里的运行时与仓库源码，
 *     并断言三处指纹相等；
 *   · 设备侧 `RuntimeInstaller` 用 meta 里的期望值比对运行时里的
 *     `plugin.fingerprint`，不等就判定「插件过期」并重装/降级。
 *
 * 于是「只改了 `lib/client.js` 和 `web/codex.css`」这种纯前端改动，走
 * `build-runtime.mjs` 全量重编的代价是：重新解析 61063 个 stage/asar 条目、
 * 重新打 1.89 GiB 未压缩内容（实测数十分钟、峰值提交内存数百 MB）。而实际
 * 变化的只有约 90 KB。本脚本只做「换掉插件目录下的条目 + 重算指纹」，其余
 * 条目**整段拷贝原始压缩字节**（不解压、不重压），耗时以磁盘拷贝为准。
 *
 * ── 为什么敢整段拷贝 ────────────────────────────────────────────────────────
 *
 * 先验条件（`--check-only` 会显式检查，不满足就拒绝执行）：
 *   ① 源 zip 的条目在文件里**首尾相接**：没有对齐填充、没有 data descriptor；
 *   ② 条目按 localOffset 排好序后可以逐段 [offset, offset+extent) 复制，
 *      extent = 30 + 文件名长 + extra 长 + 压缩后长（flag bit3 未使用）。
 * 只要这两条成立，未改动条目的本地记录可以原样搬走，唯一需要重算的是中央
 * 目录里的 `localOffset`（前面的长度变了，后面的整体平移）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *
 *   node tools/restamp-codex-plugin.mjs \
 *     --in  .cache/apk-assets-hold/runtime.zip \
 *     --out .cache/runtime-0.9.38/runtime.zip \
 *     --meta android/app/src/main/assets/meta/build.json
 *
 * `--meta` 会就地更新 `runtimeSha256` / `runtimeSize` / `runtimeEntries` /
 * `codexPluginFingerprint` / `generatedAt`，其余字段原样保留。
 * 输出目录里会同时复制一份 `alias-links.txt`——`build-codex-apk.ps1` 要求它
 * 与 runtime.zip 同级。
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

import { readPluginFiles } from './lib/assemble.mjs'
import { CODEX_PLUGIN_BASE, stampCodexPlugin } from './lib/codex.mjs'
import { readZipDirectory } from './lib/zipread.mjs'
import { zipEndRecords, MAX_ZIP_ENTRIES, ZIP32_SENTINEL } from './lib/zipwrite.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..')

const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const COPY_CHUNK = 8 * 1024 * 1024

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    meta: join(PROJECT, 'android', 'app', 'src', 'main', 'assets', 'meta', 'build.json'),
    plugin: join(PROJECT, 'plugins', 'dsh-codex-sidebar'),
    alias: null,
    checkOnly: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--in') opts.input = resolve(argv[++i])
    else if (a === '--out') opts.output = resolve(argv[++i])
    else if (a === '--meta') opts.meta = resolve(argv[++i])
    else if (a === '--plugin') opts.plugin = resolve(argv[++i])
    else if (a === '--alias') opts.alias = resolve(argv[++i])
    else if (a === '--check-only') opts.checkOnly = true
    else if (a === '--help' || a === '-h') {
      console.log('用法：node tools/restamp-codex-plugin.mjs --in <runtime.zip> --out <new.zip> [--meta <build.json>] [--check-only]')
      process.exit(0)
    } else throw new Error(`未知参数：${a}`)
  }
  if (!opts.input) throw new Error('缺少 --in <runtime.zip>')
  if (!opts.checkOnly && !opts.output) throw new Error('缺少 --out <new.zip>')
  return opts
}

function readAt(fd, offset, len) {
  const buf = Buffer.allocUnsafe(len)
  let got = 0
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, offset + got)
    if (n <= 0) throw new Error(`只读到 ${got}/${len} 字节（@${offset}）`)
    got += n
  }
  return buf
}

/** 只读中央目录（几 MB），不加载整份 zip。字段按 `cdHeader` 原样保留。 */
function readCentralDirectory(fd, size) {
  const { count, cdSize, cdOffset } = readZipDirectory((offset, length) => readAt(fd, offset, length), size)
  const cd = readAt(fd, cdOffset, cdSize)
  const entries = []
  let p = 0
  for (let i = 0; i < count; i += 1) {
    if (cd.readUInt32LE(p) !== CD_SIG) throw new Error(`中央目录项 ${i} 签名错误 @${p}`)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    entries.push({
      cdHeader: Buffer.from(cd.subarray(p, p + 46)),
      nameBuf: Buffer.from(cd.subarray(p + 46, p + 46 + nameLen)),
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      extra: Buffer.from(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)),
      comment: Buffer.from(cd.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen)),
      localOffset: cd.readUInt32LE(p + 42),
      method: cd.readUInt16LE(p + 10),
      flags: cd.readUInt16LE(p + 8),
      crc: cd.readUInt32LE(p + 16),
      csize: cd.readUInt32LE(p + 20),
      usize: cd.readUInt32LE(p + 24),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  if (p !== cdSize) throw new Error(`中央目录长度不符（解析 ${p} / 声明 ${cdSize}）`)
  return { entries, cdSize, cdOffset, count }
}

/**
 * 校验「条目首尾相接」这条前提，并给每条算出本地记录的总长度。
 * 不满足就抛错 —— 宁可让人回去跑全量 build-runtime，也不要写出一份偏移错乱的 zip。
 */
function measureLocalRecords(fd, entries, cdOffset) {
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset)
  let cursor = 0
  for (const entry of sorted) {
    if (entry.localOffset !== cursor) {
      throw new Error(
        `条目未首尾相接：${entry.name} @${entry.localOffset}，期望 @${cursor}。` +
          '（存在对齐填充或其它 zip 写入器产物，请改用 build-runtime.mjs 全量重编）',
      )
    }
    const lh = readAt(fd, entry.localOffset, 30)
    if (lh.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`本地头签名错误：${entry.name}`)
    if (lh.readUInt16LE(6) & 0x0008) throw new Error(`条目使用 data descriptor，无法整段拷贝：${entry.name}`)
    const nameLen = lh.readUInt16LE(26)
    const extraLen = lh.readUInt16LE(28)
    entry.extent = 30 + nameLen + extraLen + entry.csize
    entry.template = Buffer.from(lh)
    cursor = entry.localOffset + entry.extent
  }
  if (cursor !== cdOffset) throw new Error(`条目总长 ${cursor} 与中央目录起点 ${cdOffset} 不符（尾部有额外数据）`)
  return sorted
}

function readEntryData(fd, entry) {
  const nameLen = entry.template.readUInt16LE(26)
  const extraLen = entry.template.readUInt16LE(28)
  const start = entry.localOffset + 30 + nameLen + extraLen
  const raw = readAt(fd, start, entry.csize)
  return entry.method === 8 ? inflateRawSync(raw) : raw
}

/** 复刻源条目的本地头风格：版本、flag、时间戳都照抄模板，只重算方法与长度。 */
function buildLocalRecord(template, name, data, time, day) {
  const deflated = deflateRawSync(data, { level: 6 })
  const method = deflated.length < data.length ? 8 : 0
  const payload = method === 8 ? deflated : data
  const crc = crc32(data)
  const nameBuf = Buffer.from(name, 'utf8')
  const head = Buffer.alloc(30)
  head.writeUInt32LE(LOCAL_SIG, 0)
  head.writeUInt16LE(template.readUInt16LE(4), 4) // version needed
  head.writeUInt16LE(template.readUInt16LE(6) & ~0x0008, 6) // 沿用 flag，但绝不写 data descriptor 位
  head.writeUInt16LE(method, 8)
  head.writeUInt16LE(time, 10)
  head.writeUInt16LE(day, 12)
  head.writeUInt32LE(crc, 14)
  head.writeUInt32LE(payload.length, 18)
  head.writeUInt32LE(data.length, 22)
  head.writeUInt16LE(nameBuf.length, 26)
  head.writeUInt16LE(0, 28) // extra 长度：新记录不写 extra
  return { head, nameBuf, payload, method, crc, csize: payload.length, usize: data.length }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosOf(template) {
  return { time: template.readUInt16LE(10), day: template.readUInt16LE(12) }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.checkOnly && existsSync(opts.output)) throw new Error(`拒绝覆盖已存在的运行时：${opts.output}`)
  if (!existsSync(opts.input)) throw new Error(`找不到运行时：${opts.input}`)
  const stat = statSync(opts.input)
  const fd = openSync(opts.input, 'r')
  const { entries, cdOffset } = (() => {
    const cd = readCentralDirectory(fd, stat.size)
    return { entries: cd.entries, cdOffset: cd.cdOffset }
  })()
  const sorted = measureLocalRecords(fd, entries, cdOffset)
  console.log(`源运行时 ${(stat.size / 1024 / 1024).toFixed(2)} MiB，条目 ${entries.length}，首尾相接 ✓`)

  // ── 待替换的插件文件（与 build-runtime.mjs 完全同一套收集规则）───────────
  const files = new Map()
  const count = readPluginFiles(opts.plugin, files, CODEX_PLUGIN_BASE)
  const fingerprint = stampCodexPlugin(files) // 顺带把必填项与 manifest 合同校验一遍
  console.log(`插件文件 ${count} 个，指纹 ${fingerprint}`)

  // kxxy-runtime.json 里的 codexFingerprint 必须同源更新
  const manifestEntry = entries.find((e) => e.name === 'kxxy-runtime.json')
  if (!manifestEntry) throw new Error('运行时缺少 kxxy-runtime.json')
  const manifest = JSON.parse(readEntryData(fd, manifestEntry).toString('utf8'))
  const previous = manifest.plugins?.codexFingerprint
  manifest.plugins = { ...(manifest.plugins ?? {}), codexFingerprint: fingerprint }
  files.set('kxxy-runtime.json', {
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    mode: 0o644,
  })
  console.log(`manifest codexFingerprint：${previous} → ${fingerprint}`)

  // 源 zip 里存在但仓库里已删除的插件条目，必须剔除，否则 APK 里会留下旧源码
  const stale = sorted
    .map((e) => e.name)
    .filter((name) => name.startsWith(CODEX_PLUGIN_BASE) && !name.endsWith('/') && !files.has(name))
  if (stale.length) console.log(`剔除 ${stale.length} 个已删除条目：${stale.join(', ')}`)

  const staleNames = new Set(stale)
  const additions = [...files.keys()].filter((name) => !entries.some((entry) => entry.name === name))
  const entryCount = entries.length - stale.length + additions.length
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error('新增插件条目会超过有界 ZIP64 计数上限')
  if (additions.length) console.log(`新增 ${additions.length} 个插件条目`)

  // 根清单里的 `entries` 是**重封后**的条目总数。`verify-python-repair.mjs` 用它
  // 断言 `kxxy-runtime.json` 与 zip 实际条目数一致 —— 新增插件文件后不跟着改就会
  // 在出包时被判「runtime 根清单与修复合同不一致」。
  if (manifest.entries !== entryCount) {
    const previousEntries = manifest.entries
    manifest.entries = entryCount
    files.set('kxxy-runtime.json', {
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      mode: 0o644,
    })
    console.log(`manifest entries：${previousEntries} → ${entryCount}`)
  }
  if (opts.checkOnly) {
    closeSync(fd)
    console.log('--check-only：结构可增量重封，未写出任何文件')
    return
  }

  // ── 流式重写 ────────────────────────────────────────────────────────────
  const outDir = dirname(opts.output)
  mkdirSync(outDir, { recursive: true })
  const tmp = `${opts.output}.tmp-${process.pid}`
  const outFd = openSync(tmp, 'w')
  const digest = createHash('sha256')
  let offset = 0
  const emit = (buf) => {
    if (offset + buf.length >= ZIP32_SENTINEL) throw new Error('运行时超过 32 位大小/偏移上限')
    let written = 0
    while (written < buf.length) {
      const n = writeSync(outFd, buf, written, buf.length - written)
      if (n <= 0) throw new Error('写入失败')
      written += n
    }
    digest.update(buf)
    offset += buf.length
  }

  const replacements = [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const replaceNames = new Set(replacements.map(([name]) => name))
  // 本地头模板：优先用插件里已有的文件条目，保证版本/flag/时间戳与源包同风格
  const templateEntry = sorted.find((e) => e.name === `${CODEX_PLUGIN_BASE}lib/client.js`) ?? sorted[0]
  const { time: stampTime, day: stampDay } = dosOf(templateEntry.template)

  const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(stat.size, 1)))
  let replaced = false
  const newOffsets = new Map()
  for (const entry of sorted) {
    if (staleNames.has(entry.name)) continue
    if (replaceNames.has(entry.name)) {
      if (replaced) continue
      replaced = true
      for (const [name, file] of replacements) {
        const record = buildLocalRecord(templateEntry.template, name, file.data, stampTime, stampDay)
        const localOffset = offset
        emit(record.head)
        emit(record.nameBuf)
        if (record.payload.length) emit(record.payload)
        newOffsets.set(name, { localOffset, method: record.method, crc: record.crc, csize: record.csize, usize: record.usize, fresh: true })
      }
      continue
    }
    const localOffset = offset
    let read = 0
    while (read < entry.extent) {
      const want = Math.min(buffer.length, entry.extent - read)
      const n = readSync(fd, buffer, 0, want, entry.localOffset + read)
      if (n <= 0) throw new Error(`拷贝中断：${entry.name}`)
      emit(Buffer.from(buffer.subarray(0, n)))
      read += n
    }
    newOffsets.set(entry.name, {
      localOffset,
      method: entry.method,
      crc: entry.crc,
      csize: entry.csize,
      usize: entry.usize,
      fresh: false,
    })
  }
  if (!replaced) throw new Error('源 zip 里没有插件条目，无法增量重封')

  // ── 中央目录（保持源顺序，只改偏移与改动条目的长度/crc）─────────────────
  // 被剔除的旧条目不进新中央目录；条目数随之变化，EOCD 用实际写出数。
  const cdEntries = entries.filter((entry) => newOffsets.has(entry.name))
  for (const name of additions) {
    const file = files.get(name)
    const nameBuf = Buffer.from(name, 'utf8')
    const cdHeader = Buffer.from(templateEntry.cdHeader)
    cdHeader.writeUInt16LE(nameBuf.length, 28)
    cdHeader.writeUInt16LE(0, 30)
    cdHeader.writeUInt16LE(0, 32)
    cdHeader.writeUInt32LE(((0o100000 | file.mode) << 16) >>> 0, 38)
    cdEntries.push({ name, nameBuf, cdHeader, extra: Buffer.alloc(0), comment: Buffer.alloc(0) })
  }
  if (cdEntries.length !== entryCount) throw new Error('重封后的中央目录条目数不符')
  const cdStart = offset
  for (const entry of cdEntries) {
    const next = newOffsets.get(entry.name)
    if (!next) throw new Error(`中央目录条目未写本地记录：${entry.name}`)
    const head = Buffer.from(entry.cdHeader)
    head.writeUInt16LE(next.method, 10)
    if (next.fresh) {
      // 新写的本地记录用的是模板时间戳，中央目录必须与之一致
      head.writeUInt16LE(templateEntry.template.readUInt16LE(4), 6)
      head.writeUInt16LE(templateEntry.template.readUInt16LE(6) & ~0x0008, 8)
      head.writeUInt16LE(stampTime, 12)
      head.writeUInt16LE(stampDay, 14)
      head.writeUInt16LE(0, 30) // extra 长度
    }
    head.writeUInt32LE(next.crc, 16)
    head.writeUInt32LE(next.csize, 20)
    head.writeUInt32LE(next.usize, 24)
    head.writeUInt32LE(next.localOffset, 42)
    emit(head)
    emit(entry.nameBuf)
    if (!next.fresh && entry.extra.length) emit(entry.extra)
    if (entry.comment.length) emit(entry.comment)
  }
  const cdSize = offset - cdStart
  emit(zipEndRecords(cdEntries.length, cdSize, cdStart, { allowZip64Count: true }))
  closeSync(outFd)
  closeSync(fd)

  if (existsSync(opts.output)) throw new Error(`拒绝覆盖已存在的运行时：${opts.output}`)
  renameSync(tmp, opts.output)
  const sha = digest.digest('hex')
  console.log(`写出 ${opts.output}`)
  console.log(`  ${(offset / 1024 / 1024).toFixed(2)} MiB（${offset} B），条目 ${cdEntries.length}`)
  console.log(`  sha256 ${sha}`)

  // ── 别名清单（build-codex-apk.ps1 要求与 runtime.zip 同级）───────────────
  const aliasSrc = opts.alias ?? join(dirname(opts.input), 'alias-links.txt')
  if (existsSync(aliasSrc)) {
    copyFileSync(aliasSrc, join(outDir, 'alias-links.txt'))
    console.log(`  alias-links.txt ← ${aliasSrc}`)
  } else {
    console.log(`  ! 未找到 alias-links.txt（${aliasSrc}），打包前请手工放一份`)
  }

  // ── 更新 meta/build.json ────────────────────────────────────────────────
  if (opts.meta && existsSync(opts.meta)) {
    const meta = JSON.parse(readFileSync(opts.meta, 'utf8'))
    meta.generatedAt = new Date().toISOString()
    meta.runtimeSha256 = sha
    meta.runtimeSize = offset
    meta.runtimeEntries = cdEntries.length
    meta.codexPluginFingerprint = fingerprint
    writeFileSyncSafe(opts.meta, `${JSON.stringify(meta, null, 2)}\n`)
    console.log(`  meta 已更新：${opts.meta}`)
  }
}

function writeFileSyncSafe(path, text) {
  const tmp = `${path}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w')
  try {
    const buf = Buffer.from(text, 'utf8')
    let written = 0
    while (written < buf.length) {
      const n = writeSync(fd, buf, written, buf.length - written)
      if (n <= 0) throw new Error('写入失败')
      written += n
    }
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

await main()
