/**
 * 把 `dsh-web-mobile` 的新版本**增量**重封进一份已有的 `runtime.zip`。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 *
 * 插件随 runtime 打包在 `lib/node_modules/dsh-web-mobile/`，构建期来源是
 * `build-runtime.mjs` 的 `MOBILE_PLUGIN_PKG`。换版本时如果走全量
 * `build-runtime.mjs`，代价是重新解析 6 万条 stage/asar 条目、重新打 1.9 GiB
 * 未压缩内容（数十分钟），而实际变化的只有插件目录这一小块。
 *
 * 本脚本只做三件事，其余条目**整段拷贝原始压缩字节**（不解压、不重压）：
 *   ① 换掉 `lib/node_modules/dsh-web-mobile/**`；
 *   ② 把 `@deepseek-ai/dsh/package.json` 里的 `dependencies.dsh-web-mobile` 版本号改成新版本
 *      （与 `patches.mjs` 的 `patchDshManifest` 同源，设备侧 installation scope 靠它解析）；
 *   ③ 重写 `kxxy-runtime.json` 的 `mobileMarker` 与 `assets/meta/build.json` 的
 *      `dshWebMobileMarker` / `runtimeSha256` / `runtimeSize` / `runtimeEntries`。
 *
 * 结构前提（`--check-only` 会先验，不满足就拒绝执行）：源 zip 的本地记录首尾相接、
 * 不使用 data descriptor。这与 `restamp-codex-plugin.mjs` 是同一条前提。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *
 *   node tools/restamp-mobile-plugin.mjs \
 *     --in  .cache/apk-assets-hold/runtime.zip \
 *     --out .cache/rt-0.9.54/runtime.zip \
 *     --tgz .cache/office/dsh-web-mobile-3.3.5.tgz \
 *     --meta android/app/src/main/assets/meta/build.json
 *
 * `--out` 目录里会同时复制一份 `alias-links.txt`（`build-codex-apk.ps1` 要求同级）。
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
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

import { untarGz } from './lib/targz.mjs'
import { readZipDirectory } from './lib/zipread.mjs'
import { zipEndRecords, MAX_ZIP_ENTRIES, ZIP32_SENTINEL } from './lib/zipwrite.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..')

const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const COPY_CHUNK = 8 * 1024 * 1024

/** 与 build-runtime.mjs / patches.mjs / EngineConfig.kt 必须逐字一致。 */
const PLUGIN_NAME = 'dsh-web-mobile'
const PLUGIN_VERSION = '3.3.5'
const PLUGIN_ZIP_BASE = `lib/node_modules/${PLUGIN_NAME}/`
const PLUGIN_TGZ_SHA256 = '877c9ea37c993d88289c14e80b5b4ba75f8a0e7f9b205b92926fe30e3bbc7438'
const MOBILE_PLUGIN_MARKER = 'kxxy-mobile-plugin@2'
const DSH_MANIFEST = 'lib/node_modules/@deepseek-ai/dsh/package.json'

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    tgz: join(PROJECT, '.cache', 'office', 'dsh-web-mobile-3.3.5.tgz'),
    meta: join(PROJECT, 'android', 'app', 'src', 'main', 'assets', 'meta', 'build.json'),
    alias: null,
    checkOnly: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--in') opts.input = resolve(argv[++i])
    else if (a === '--out') opts.output = resolve(argv[++i])
    else if (a === '--tgz') opts.tgz = resolve(argv[++i])
    else if (a === '--meta') opts.meta = resolve(argv[++i])
    else if (a === '--alias') opts.alias = resolve(argv[++i])
    else if (a === '--check-only') opts.checkOnly = true
    else if (a === '--help' || a === '-h') {
      console.log('用法：node tools/restamp-mobile-plugin.mjs --in <runtime.zip> --out <new.zip> [--tgz <pkg.tgz>] [--meta <build.json>] [--check-only]')
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
    const n = readSync(fd, buf, 0, len - got, offset + got)
    if (n <= 0) throw new Error(`只读到 ${got}/${len} 字节（@${offset}）`)
    got += n
  }
  return buf
}

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

function buildLocalRecord(template, name, data, time, day) {
  const deflated = deflateRawSync(data, { level: 6 })
  const method = deflated.length < data.length ? 8 : 0
  const payload = method === 8 ? deflated : data
  const crc = crc32(data)
  const nameBuf = Buffer.from(name, 'utf8')
  const head = Buffer.alloc(30)
  head.writeUInt32LE(LOCAL_SIG, 0)
  head.writeUInt16LE(template.readUInt16LE(4), 4)
  head.writeUInt16LE(template.readUInt16LE(6) & ~0x0008, 6)
  head.writeUInt16LE(method, 8)
  head.writeUInt16LE(time, 10)
  head.writeUInt16LE(day, 12)
  head.writeUInt32LE(crc, 14)
  head.writeUInt32LE(payload.length, 18)
  head.writeUInt32LE(data.length, 22)
  head.writeUInt16LE(nameBuf.length, 26)
  head.writeUInt16LE(0, 28)
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
  if (!existsSync(opts.tgz)) throw new Error(`找不到插件包：${opts.tgz}`)

  const tgzBuf = readFileSync(opts.tgz)
  const got = createHash('sha256').update(tgzBuf).digest('hex')
  if (got !== PLUGIN_TGZ_SHA256) {
    throw new Error(`${opts.tgz} 摘要不符：期望 ${PLUGIN_TGZ_SHA256}，实得 ${got}`)
  }

  // ── 从 tarball 收集插件条目（与 build-runtime.mjs 的 collect 规则一致）──
  const tarEntries = untarGz(tgzBuf)
  const files = new Map()
  for (const e of tarEntries) {
    if (e.type !== '0') continue
    if (!e.path.startsWith('package/')) continue
    const rel = e.path.slice('package/'.length)
    if (!rel) continue
    files.set(PLUGIN_ZIP_BASE + rel, { data: e.data, mode: 0o644 })
  }
  const pkgEntry = tarEntries.find((e) => e.path === 'package/package.json')
  if (!pkgEntry) throw new Error('插件包里找不到 package.json')
  const pkgJson = JSON.parse(pkgEntry.data.toString('utf8'))
  if (pkgJson.name !== PLUGIN_NAME) throw new Error(`插件包名漂移：${pkgJson.name}`)
  if (pkgJson.version !== PLUGIN_VERSION) throw new Error(`插件版本漂移：${pkgJson.version}（期望 ${PLUGIN_VERSION}）`)
  if (pkgJson.dsh?.client?.platform !== 'web') throw new Error('插件未声明 dsh.client.platform === "web"')
  const clientRel = pkgJson.exports?.['./client']
  const clientPath = typeof clientRel === 'string' ? clientRel : clientRel?.default
  if (typeof clientPath !== 'string') throw new Error('插件 exports["./client"] 不是字符串')
  if (!files.has(PLUGIN_ZIP_BASE + clientPath.replace(/^\.\//, ''))) {
    throw new Error(`插件声明了 ${clientPath}，但包里没有这个文件`)
  }
  // 版本标记（锚点 10 的判据）
  files.set(PLUGIN_ZIP_BASE + 'plugin.version', { data: Buffer.from(`${MOBILE_PLUGIN_MARKER}\n`, 'utf8'), mode: 0o644 })
  console.log(`插件 ${PLUGIN_NAME}@${PLUGIN_VERSION}：${files.size - 1} 文件 + plugin.version（${MOBILE_PLUGIN_MARKER}）`)

  const stat = statSync(opts.input)
  const fd = openSync(opts.input, 'r')
  const cd = readCentralDirectory(fd, stat.size)
  const sorted = measureLocalRecords(fd, cd.entries, cd.cdOffset)
  console.log(`源运行时 ${(stat.size / 1024 / 1024).toFixed(2)} MiB，条目 ${cd.entries.length}，首尾相接 ✓`)

  // ── 旧插件条目统计 ────────────────────────────────────────────────────
  const oldPlugin = sorted.filter((e) => e.name.startsWith(PLUGIN_ZIP_BASE) && !e.name.endsWith('/'))
  if (!oldPlugin.length) throw new Error('源 zip 里没有 dsh-web-mobile 条目，无法增量重封')
  const stale = oldPlugin.map((e) => e.name).filter((name) => !files.has(name))
  const additions = [...files.keys()].filter((name) => !cd.entries.some((e) => e.name === name))
  console.log(`旧插件条目 ${oldPlugin.length} 个，其中将剔除 ${stale.length} 个、新增 ${additions.length} 个`)

  // ── @deepseek-ai/dsh 的声明版本 ──────────────────────────────────────
  const dshEntry = cd.entries.find((e) => e.name === DSH_MANIFEST)
  if (!dshEntry) throw new Error(`运行时缺少 ${DSH_MANIFEST}`)
  const dshText = readEntryData(fd, dshEntry).toString('utf8')
  const dshJson = JSON.parse(dshText)
  const before = dshJson.dependencies?.[PLUGIN_NAME]
  if (before === undefined) throw new Error(`${DSH_MANIFEST} 的 dependencies 里没有 ${PLUGIN_NAME}（补丁未生效）`)
  dshJson.dependencies[PLUGIN_NAME] = PLUGIN_VERSION
  // 只替换这一处版本字面量，其余格式原样保留（避免整文件重新序列化带来的无关 diff）
  const swapped = dshText.replace(`"${before}"`, `"${PLUGIN_VERSION}"`)
  const swapCheck = JSON.parse(swapped)
  if (swapCheck.dependencies?.[PLUGIN_NAME] !== PLUGIN_VERSION) throw new Error('改写声明版本失败')
  files.set(DSH_MANIFEST, { data: Buffer.from(swapped, 'utf8'), mode: 0o644 })
  console.log(`声明版本：${PLUGIN_NAME} ${before} → ${PLUGIN_VERSION}`)

  // ── kxxy-runtime.json 的 mobileMarker ────────────────────────────────
  const runtimeManifestEntry = cd.entries.find((e) => e.name === 'kxxy-runtime.json')
  if (!runtimeManifestEntry) throw new Error('运行时缺少 kxxy-runtime.json')
  const runtimeManifest = JSON.parse(readEntryData(fd, runtimeManifestEntry).toString('utf8'))
  const markerBefore = runtimeManifest.mobileMarker
  runtimeManifest.mobileMarker = MOBILE_PLUGIN_MARKER
  files.set('kxxy-runtime.json', {
    data: Buffer.from(`${JSON.stringify(runtimeManifest, null, 2)}\n`, 'utf8'),
    mode: 0o644,
  })
  console.log(`kxxy-runtime.json mobileMarker：${markerBefore} → ${MOBILE_PLUGIN_MARKER}`)

  const staleNames = new Set(stale)

  if (opts.checkOnly) {
    closeSync(fd)
    console.log('--check-only：结构可增量重封，未写出任何文件')
    return
  }

  // ── 流式重写 ─────────────────────────────────────────────────────────
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
  const templateEntry =
    sorted.find((e) => e.name === `${PLUGIN_ZIP_BASE}lib/client.js`) ??
    sorted.find((e) => e.name === `${PLUGIN_ZIP_BASE}package.json`) ??
    sorted[0]
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
        newOffsets.set(name, {
          localOffset,
          method: record.method,
          crc: record.crc,
          csize: record.csize,
          usize: record.usize,
          fresh: true,
        })
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

  const cdEntries = cd.entries.filter((entry) => newOffsets.has(entry.name))
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
  if (cdEntries.length > MAX_ZIP_ENTRIES) throw new Error('重封后条目数超过 ZIP64 计数上限')
  const cdStart = offset
  for (const entry of cdEntries) {
    const next = newOffsets.get(entry.name)
    if (!next) throw new Error(`中央目录条目未写本地记录：${entry.name}`)
    const head = Buffer.from(entry.cdHeader)
    head.writeUInt16LE(next.method, 10)
    if (next.fresh) {
      head.writeUInt16LE(templateEntry.template.readUInt16LE(4), 6)
      head.writeUInt16LE(templateEntry.template.readUInt16LE(6) & ~0x0008, 8)
      head.writeUInt16LE(stampTime, 12)
      head.writeUInt16LE(stampDay, 14)
      head.writeUInt16LE(0, 30)
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

  const aliasSrc = opts.alias ?? join(dirname(opts.input), 'alias-links.txt')
  if (existsSync(aliasSrc)) {
    copyFileSync(aliasSrc, join(outDir, 'alias-links.txt'))
    console.log(`  alias-links.txt ← ${aliasSrc}`)
  } else {
    console.log(`  ! 未找到 alias-links.txt（${aliasSrc}），打包前请手工放一份`)
  }

  if (opts.meta && existsSync(opts.meta)) {
    const meta = JSON.parse(readFileSync(opts.meta, 'utf8'))
    meta.generatedAt = new Date().toISOString()
    meta.runtimeSha256 = sha
    meta.runtimeSize = offset
    meta.runtimeEntries = cdEntries.length
    meta.dshWebMobileMarker = MOBILE_PLUGIN_MARKER
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
