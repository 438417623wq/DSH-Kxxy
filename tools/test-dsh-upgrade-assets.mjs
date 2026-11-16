/** 本地合成 fixture 正反例；不生成发布 runtime，不下载、不清理，产物和独有日志留在 .cache。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { deflateRawSync } from 'node:zlib'
import { stampHostPluginFingerprint } from './lib/host-fingerprint.mjs'
import { crc32, zipEndRecords } from './lib/zipwrite.mjs'
import { writeSmallZip } from './lib/zipedit.mjs'
import { readZipDirectory } from './lib/zipread.mjs'
import { DSH, parseDshJson, parseDshManifest } from './verify-dsh-upgrade.mjs'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--python'), '用法：node tools/test-dsh-upgrade-assets.mjs [--python <现有python解释器>]')
const python = args[1] ?? process.env.KXXY_PYTHON ?? 'C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe'
const nodeVerifier = join(project, 'tools/verify-dsh-upgrade.mjs'), pythonVerifier = join(project, 'tools/verify-dsh-apk.py')
const cache = join(project, '.cache')
assert.ok(fs.lstatSync(cache).isDirectory() && !fs.lstatSync(cache).isSymbolicLink(), '.cache 必须已存在且为普通目录')
const scratch = fs.mkdtempSync(join(cache, 'test-dsh-upgrade-assets-'))
const logPath = join(scratch, 'verification.log'), logFd = fs.openSync(logPath, 'wx')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const NM = 'lib/node_modules/', HOST = `${NM}kxxy-host/`
const CHANGE = `${NM}@deepseek-ai/dsh/lib/change.bin`, ADDED = `${NM}@deepseek-ai/dsh/lib/added.bin`, RETIRED = `${NM}@deepseek-ai/dsh/lib/retired.bin`
const CORES = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const CODEX_FP = sha(Buffer.from('仅供 fixture 的 Codex 指纹'))
const descriptor = 'Lapp/kxxy/engine/DshRuntimeUpgrade;\0Lapp/kxxy/engine/RuntimeInstaller;\0'
const outcomes = []
let fixtureId = 0
const protectedPaths = ['tools/upgrade-dsh-runtime.mjs', 'tools/lib/zipedit.mjs', 'tools/lib/zipread.mjs', 'tools/lib/zipwrite.mjs',
  'tools/lib/host-fingerprint.mjs', 'tools/verify-python-repair.mjs', 'tools/verify-python-apk.py',
  'android/app/src/main/java/app/kxxy/engine/DshRuntimeUpgrade.kt', 'android/app/src/main/assets/meta/build.json']
const protectedHashes = new Map(protectedPaths.map(p => [p, sha(fs.readFileSync(join(project, p)))]))
function log(text) { fs.writeSync(logFd, text + '\n'); console.log(text) }
function write(path, bytes) {
  assert.ok(fs.lstatSync(dirname(path)).isDirectory(), `写入父目录必须已存在：${path}`)
  fs.writeFileSync(path, bytes, { flag: 'wx' })
}
function mkdir(path) {
  assert.ok(fs.lstatSync(dirname(path)).isDirectory())
  fs.mkdirSync(path)
  return path
}
function child(executable, argv) {
  return new Promise((done, reject) => {
    const process = spawn(executable, argv, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    process.stdout.setEncoding('utf8'); process.stderr.setEncoding('utf8')
    process.stdout.on('data', chunk => { stdout += chunk })
    process.stderr.on('data', chunk => { stderr += chunk })
    process.once('error', reject)
    process.once('close', (status, signal) => {
      fs.writeSync(logFd, JSON.stringify({ executable, argv, status, signal, stdout, stderr }) + '\n')
      done({ status, signal, stdout, stderr })
    })
  })
}
async function parallel(checks) {
  // A rejected check must still await its sibling process before the next case
  // or final log close; Promise.all would leave late child output using logFd.
  const results = await Promise.allSettled(checks)
  const rejected = results.find(result => result.status === 'rejected')
  if (rejected) throw rejected.reason
  return results.map(result => result.value)
}
async function test(name, fn) {
  try { await fn(); outcomes.push({ name, passed: true }); log(`通过 ${outcomes.length} ${name}`) }
  catch (error) { outcomes.push({ name, passed: false, error: error.stack ?? String(error) }); log(`失败 ${outcomes.length} ${name}\n${error.stack ?? error}`) }
}
const entry = (data, mode = 0o644, comment = '') => ({ data: Buffer.isBuffer(data) ? data : Buffer.from(data), mode, comment })
const clone = files => new Map([...files].map(([name, value]) => [name, { ...value }]))

function tree(version, modern) {
  const files = new Map()
  for (const name of CORES) files.set(`${NM}${name}/package.json`, entry(json({ name, version })))
  files.set(CHANGE, entry(modern ? '新版普通文件\n' : '旧版普通文件\n', 0o755))
  files.set(modern ? ADDED : RETIRED, entry(modern ? '新增文件\n' : '废弃文件\n'))
  files.set(`${NM}unrelated/user.txt`, entry('未受管包文件\n'))
  files.set('bin/node', entry('仅供 fixture 的 native node\n', 0o755))
  files.set('bin/node-alias', entry('', 0o755, 'LINK:bin/node'))
  files.set('lib/python3.14/site-packages/keep.py', entry('# 仅供 fixture 的 Python 保留文件\n'))
  files.set('lib/codex/keep', entry('仅供 fixture 的 native Codex 保留文件\n'))
  files.set('share/fixture.txt', entry('非 DSH 保留文件\n'))
  files.set(`${HOST}package.json`, entry(json({ name: 'kxxy-host', version: 'fixture' })))
  files.set(`${HOST}lib/index.js`, entry('export const fixture = true\n'))
  files.set(`${HOST}patchset.version`, entry(modern ? 'fixture-patchset-new\n' : 'fixture-patchset-old\n'))
  const host = stampHostPluginFingerprint(files)
  return { files, host }
}
function completeTree(files, host, modify) {
  files.set(DSH.root, entry(''))
  const directories = new Set()
  for (const name of files.keys()) {
    const parts = name.split('/'); parts.pop()
    while (parts.length) { directories.add(parts.join('/') + '/'); parts.pop() }
  }
  for (const name of directories) files.set(name, entry('', 0o755))
  const root = { schemaVersion: 1, runtimeVersion: 'fixture-only', entries: files.size, directories: directories.size,
    linkEntries: [...files.values()].filter(e => e.comment?.startsWith('LINK:')).length,
    placeholderPaths: [], pythonRuntimeRevision: 'fixture-python',
    plugins: { hostFingerprint: host, hostMarker: `kxxy-host@${host.slice(0, 12)}`, codexFingerprint: CODEX_FP } }
  modify?.(root)
  files.set(DSH.root, entry(json(root)))
  return files
}
const oldSeed = tree(DSH.from, false), targetSeed = tree(DSH.to, true)
const oldFiles = completeTree(clone(oldSeed.files), oldSeed.host)

// 故意允许构造非法元数据，仅用于负例；生产 ZIP 库不做任何修改。
function fixtureZip(items, { prefix = Buffer.alloc(0) } = {}) {
  const locals = [prefix], central = []
  let offset = prefix.length
  for (const item of items) {
    const name = Buffer.from(item.name), localName = item.localNameBytes ?? Buffer.from(item.localName ?? item.name)
    const data = item.data, deflated = deflateRawSync(data)
    const method = item.method ?? (deflated.length < data.length && !item.name.endsWith('.zip') ? 8 : 0)
    const packed = item.packed ?? (method === 8 ? deflated : data)
    const crc = item.crc ?? crc32(data), size = item.declaredSize ?? data.length, csize = item.declaredCsize ?? packed.length
    const hasDescriptor = !!item.descriptor, flags = item.flags ?? (0x0800 | (hasDescriptor ? 8 : 0))
    const version = item.version ?? 20, extra = item.extra ?? Buffer.alloc(0), localExtra = item.localExtra ?? Buffer.alloc(0)
    const comment = Buffer.isBuffer(item.comment) ? item.comment : Buffer.from(item.comment ?? '')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(item.localVersion ?? version, 4)
    local.writeUInt16LE(item.localFlags ?? flags, 6); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(item.localCrc ?? (hasDescriptor ? 0 : crc), 14)
    local.writeUInt32LE(item.localCsize ?? (hasDescriptor ? 0 : csize), 18)
    local.writeUInt32LE(item.localSize ?? (hasDescriptor ? 0 : size), 22)
    local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(localExtra.length, 28)
    const dd = Buffer.alloc(hasDescriptor ? (item.descriptor === 'unsigned' ? 12 : 16) : 0)
    if (hasDescriptor) {
      const start = dd.length === 16 ? 4 : 0
      if (start) dd.writeUInt32LE(0x08074b50, 0)
      dd.writeUInt32LE(item.descriptorCrc ?? crc, start); dd.writeUInt32LE(csize, start + 4); dd.writeUInt32LE(size, start + 8)
    }
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(item.madeBy ?? 0x031e, 4); head.writeUInt16LE(version, 6)
    head.writeUInt16LE(flags, 8); head.writeUInt16LE(method, 10); head.writeUInt32LE(crc, 16)
    head.writeUInt32LE(csize, 20); head.writeUInt32LE(size, 24)
    head.writeUInt16LE(name.length, 28); head.writeUInt16LE(extra.length, 30); head.writeUInt16LE(comment.length, 32)
    head.writeUInt16LE(item.disk ?? 0, 34)
    head.writeUInt32LE(item.external ?? (((item.name.endsWith('/') ? 0o040000 : 0o100000) | (item.mode ?? 0o644)) << 16) >>> 0, 38)
    head.writeUInt32LE(item.offset ?? offset, 42)
    locals.push(local, localName, localExtra, packed, dd)
    central.push(head, name, extra, comment)
    offset += local.length + localName.length + localExtra.length + packed.length + dd.length
  }
  const centralBytes = Buffer.concat(central)
  return Buffer.concat([...locals, centralBytes, zipEndRecords(items.length, centralBytes.length, offset)])
}
const list = files => [...files].map(([name, file]) => ({ name, ...file }))
const extra = (tag, bytes = Buffer.alloc(0)) => { const head = Buffer.alloc(4); head.writeUInt16LE(tag); head.writeUInt16LE(bytes.length, 2); return Buffer.concat([head, bytes]) }
const modifyEntry = (change, name = CHANGE) => items => { const file = items.find(e => e.name === name); assert.ok(file); Object.assign(file, change) }
const modifyRow = (change, name = CHANGE) => rows => { const row = rows.find(r => r[1] === name); assert.ok(row); change(row) }

async function fixture(options = {}) {
  const directory = mkdir(join(scratch, `case-${String(++fixtureId).padStart(3, '0')}`))
  const files = clone(targetSeed.files)
  options.target?.(files)
  if (options.zip64) for (let i = 0; i < 65535; i++) files.set(`share/zip64-fixture/${i}`, entry(''))
  completeTree(files, targetSeed.host, options.root)
  let rows = []
  for (const [name, file] of files) {
    if (name.endsWith('/') || (name !== DSH.root && !name.startsWith(NM))) continue
    const old = oldFiles.get(name)
    if (name !== DSH.fingerprint && old && old.data.equals(file.data) && old.mode === file.mode) continue
    rows.push(['file', name, file.data.length, file.mode, sha(file.data), old ? sha(old.data) : '-'])
  }
  for (const [name, file] of oldFiles) if (!name.endsWith('/') && (name === DSH.root || name.startsWith(NM)) && !files.has(name)) {
    rows.push(['delete', name, file.data.length, file.mode, '-', sha(file.data)])
  }
  rows = rows.filter(r => !(options.ignorePaths ?? []).includes(r[1])).sort((a, b) => a[1].localeCompare(b[1], 'en'))
  const payloadItems = rows.filter(r => r[0] === 'file').map(r => ({ name: r[1], ...files.get(r[1]) }))
  options.payloadEntries?.(payloadItems)
  let payload = fixtureZip(payloadItems, options.payloadZip)
  if (options.payloadBytes) payload = options.payloadBytes(payload)
  options.rows?.(rows)
  const runtime = join(directory, 'fixture-runtime.zip'), baseline = join(directory, 'fixture-baseline.zip')
  const runtimeItems = list(files)
  options.runtimeEntries?.(runtimeItems)
  if (options.zip64) await writeSmallZip(runtime, files, { allowZip64Count: true })
  else write(runtime, fixtureZip(runtimeItems))
  const baselineItems = list(oldFiles)
  options.baselineEntries?.(baselineItems)
  write(baseline, fixtureZip(baselineItems))
  let manifest = Buffer.from([DSH.schema, `from\t${DSH.from}`, `to\t${DSH.to}`, `base-host\t${oldSeed.host}`, `host\t${targetSeed.host}`,
    `payload-sha256\t${sha(payload)}`, `payload-size\t${payload.length}`, ...rows.map(r => r.join('\t')), ''].join('\n'))
  if (options.manifest) manifest = Buffer.from(options.manifest(manifest.toString('utf8')))
  if (options.manifestBytes) manifest = options.manifestBytes(manifest)
  const runtimeRaw = fs.readFileSync(runtime)
  const meta = { schema: 1, runtimeSha256: sha(runtimeRaw), runtimeSize: runtimeRaw.length, runtimeEntries: runtimeItems.length,
    runtimeUncompressedBytes: runtimeItems.reduce((n, e) => n + (e.declaredSize ?? e.data.length), 0),
    kxxyHostFingerprint: targetSeed.host, kxxyHostMarker: `kxxy-host@${targetSeed.host.slice(0, 12)}`,
    codexPluginFingerprint: CODEX_FP, pythonRuntimeRevision: 'fixture-python', dshVersion: DSH.to,
    dshPreviousVersion: DSH.from, dshUpgradeManifestSha256: sha(manifest) }
  options.meta?.(meta)
  const metaRaw = options.metaBytes ? options.metaBytes(json(meta)) : json(meta)
  let assets = mkdir(join(directory, 'project'))
  const fixtureProject = assets
  for (const part of ['android', 'app', 'src', 'main', 'assets']) assets = mkdir(join(assets, part))
  const metaDir = mkdir(join(assets, 'meta')), assetDir = mkdir(join(assets, 'dsh-upgrade')), metaPath = join(metaDir, 'build.json')
  if (options.omit !== 'meta') write(metaPath, metaRaw)
  if (options.omit !== 'manifest') write(join(assetDir, 'manifest.tsv'), manifest)
  if (options.omit !== 'payload') write(join(assetDir, 'payload.zip'), payload)
  const apkItems = [
    { name: 'assets/meta/build.json', ...entry(metaRaw) }, { name: 'assets/dsh-upgrade/manifest.tsv', ...entry(manifest) },
    { name: 'assets/dsh-upgrade/payload.zip', ...entry(payload) }, { name: 'assets/runtime.zip', ...entry(runtimeRaw) },
    { name: 'classes.dex', ...entry(Buffer.from('仅供 fixture 的 DEX 字符串；并非可安装 APK\0' + descriptor + targetSeed.host)) },
  ]
  options.apkEntries?.(apkItems)
  const apk = join(directory, 'fixture.apk')
  write(apk, fixtureZip(apkItems))
  return { directory, runtime, baseline, project: fixtureProject, assetDir, metaPath, apk, meta, manifest, payload, rows }
}
function nodeArgs(f, baseline = false) { return [nodeVerifier, f.runtime, f.assetDir, f.metaPath, ...(baseline ? ['--baseline', f.baseline] : [])] }
function pythonArgs(f, report) { return ['-I', '-B', '-X', 'utf8', pythonVerifier, f.apk, f.runtime, '--project', f.project, ...(report ? ['--report', report] : [])] }
async function success(executable, argv) {
  const result = await child(executable, argv)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.signal, null)
  return JSON.parse(result.stdout)
}
async function failure(executable, argv, pattern) {
  const result = await child(executable, argv)
  assert.equal(result.status, 1, `负例未按验证失败退出：${result.stdout}\n${result.stderr}`)
  assert.equal(result.signal, null)
  assert.equal(result.stdout.trim(), '', '失败不能输出成功报告')
  assert.match(result.stderr, pattern)
}
async function rejected(options, pattern, { baseline = false, nodeOnly = false, pythonOnly = false } = {}) {
  const f = await fixture(options), report = join(f.directory, 'must-not-exist.json')
  await parallel([
    ...(!pythonOnly ? [failure(process.execPath, nodeArgs(f, baseline), pattern)] : []),
    ...(!nodeOnly ? [failure(python, pythonArgs(f, report), pattern)] : []),
  ])
  assert.equal(fs.existsSync(report), false, '负例不得留下成功报告')
}

try {
  log(`Node ${process.version}\nPython ${python}\nfixture 与独有日志目录 ${scratch}\n所有 APK/runtime 均为合成 fixture，不代表 Android 通过。`)
  const good = await fixture()
  await test('构建前正例：逐文件/三核心/H1/root/baseline/非 DSH 保留', async () => {
    const result = await success(process.execPath, nodeArgs(good, true))
    assert.equal(result.checksPassed, true); assert.equal(result.deviceVerified, false)
    assert.equal(result.baselineVerified, true); assert.equal(result.nonDshFilesPreserved, true)
    assert.ok(result.baseline.previousFiles > 3 && result.baseline.addedFiles > 0 && result.baseline.nonDshFiles >= 4)
    assert.equal(result.hostFingerprint, targetSeed.host); assert.equal(result.to, DSH.to)
    assert.equal(result.runtimeSha256, sha(fs.readFileSync(good.runtime)))
    assert.equal(result.manifestSha256, sha(good.manifest)); assert.equal(result.payloadSha256, sha(good.payload))
    assert.equal(result.retiredFiles, 1)
  })
  await test('APK 正例：报告来自实际读取值且不声明设备通过', async () => {
    const report = join(good.directory, 'apk-report.json')
    const result = await success(python, pythonArgs(good, report))
    assert.deepEqual(result, JSON.parse(fs.readFileSync(report)))
    for (const key of ['runtimeSha256', 'runtimeSize', 'runtimeEntries', 'runtimeUncompressedBytes']) assert.equal(result[key], good.meta[key])
    assert.equal(result.apkSha256, sha(fs.readFileSync(good.apk)))
    assert.equal(result.hostFingerprint, targetSeed.host); assert.equal(result.to, DSH.to)
    assert.equal(result.manifestSize, good.manifest.length); assert.equal(result.payloadSize, good.payload.length)
    assert.equal(result.deviceVerified, false); assert.equal(result.deviceInstalled, false)
    assert.equal(result.baselineVerified, false); assert.equal(result.nonDshFilesPreserved, null)
    assert.deepEqual(Object.values(result.coreVersions), [DSH.to, DSH.to, DSH.to])
  })
  await test('baseline 可选但不能冒称验证旧文件', async () => {
    const result = await success(process.execPath, nodeArgs(good))
    assert.equal(result.baselineVerified, false); assert.equal(result.nonDshFilesPreserved, null)
    assert.ok(result.remainingChecks.some(s => s.includes('未提供 baseline')))
  })
  await test('候选 previous 只声明验证了给定基线，不冒认其他已发布哈希', async () => {
    const f = await fixture({ rows: modifyRow(r => { r[5] += ',' + sha(Buffer.from('另一合法候选但未提供其发布基线')) }, DSH.root) })
    const result = await success(process.execPath, nodeArgs(f, true))
    assert.equal(result.baseline.additionalPreviousHashesUnchecked, 1)
  })
  await test('Kotlin 允许的大写 SHA 会归一化而非误拒绝', async () => {
    const f = await fixture({ rows: rows => rows.forEach(r => { if (r[4] !== '-') r[4] = r[4].toUpperCase(); r[5] = r[5].toUpperCase() }) })
    await parallel([success(process.execPath, nodeArgs(f, true)), success(python, pythonArgs(f))])
  })
  for (const descriptor of ['signed', 'unsigned']) await test(`payload 合法 ${descriptor} DEFLATE descriptor`, async () => {
    const f = await fixture({ payloadEntries: modifyEntry({ method: 8, descriptor }) })
    await parallel([success(process.execPath, nodeArgs(f)), success(python, pythonArgs(f))])
  })

  const manifestCases = [
    ['schema', { manifest: t => t.replace(DSH.schema, 'kxxy-dsh-upgrade@2') }, /schema/],
    ['from 版本', { manifest: t => t.replace(`from\t${DSH.from}`, 'from\t0.0.0') }, /版本/],
    ['to 版本', { manifest: t => t.replace(`to\t${DSH.to}`, 'to\t0.0.0') }, /版本/],
    ['目标 host', { manifest: t => t.replace(`host\t${targetSeed.host}`, `host\t${'f'.repeat(64)}`) }, /宿主/],
    ['base-host 格式', { manifest: t => t.replace(oldSeed.host, 'bad') }, /SHA/],
    ['头顺序', { manifest: t => t.replace(`from\t${DSH.from}\nto\t${DSH.to}`, `to\t${DSH.to}\nfrom\t${DSH.from}`) }, /头/],
    ['重复头', { manifest: t => t.replace(`to\t${DSH.to}`, `from\t${DSH.from}\nto\t${DSH.to}`) }, /头/],
    ['头多列', { manifest: t => t.replace(`from\t${DSH.from}`, `from\t${DSH.from}\textra`) }, /头/],
    ['缺少头', { manifest: t => t.replace(`from\t${DSH.from}\n`, '') }, /头/],
    ['CRLF', { manifest: t => t.replaceAll('\n', '\r\n') }, /UTF-8\/LF/],
    ['末尾 LF 缺失', { manifest: t => t.slice(0, -1) }, /UTF-8\/LF/],
    ['额外空行', { manifest: t => t + '\n' }, /六列/],
    ['尾部垃圾', { manifest: t => t + 'trailing\n' }, /六列/],
    ['UTF-8 BOM', { manifestBytes: t => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), t]) }, /schema/],
    ['UTF-8 非法字节', { manifestBytes: t => Buffer.concat([Buffer.from([0xff]), t]) }, /UTF-8|utf-8|encoded/],
    ['不足六列', { rows: modifyRow(r => r.pop()) }, /六列/],
    ['超过六列', { rows: modifyRow(r => r.push('extra')) }, /六列/],
    ['非法 kind', { rows: modifyRow(r => { r[0] = 'link' }) }, /六列/],
    ['非法 mode', { rows: modifyRow(r => { r[3] = 511 }) }, /mode/],
    ['mode 前导零', { rows: modifyRow(r => { r[3] = '0420' }) }, /mode/],
    ['文件 SHA 格式', { rows: modifyRow(r => { r[4] = '-' }) }, /SHA/],
    ['delete 目标 SHA', { rows: modifyRow(r => { r[4] = 'a'.repeat(64) }, RETIRED) }, /delete/],
    ['delete 无 previous', { rows: modifyRow(r => { r[5] = '-' }, RETIRED) }, /previous|delete/],
    ['previous 重复', { rows: modifyRow(r => { r[5] += ',' + r[5] }) }, /previous/],
    ['previous 大小写重复', { rows: modifyRow(r => { r[5] += ',' + r[5].toUpperCase() }) }, /previous/],
    ['previous 空候选', { rows: modifyRow(r => { r[5] += ',' }) }, /SHA/],
    ['跨宿主指纹缺少 previous', { rows: modifyRow(r => { r[5] = '-' }, DSH.fingerprint) }, /跨宿主/],
    ['缺少 root', { rows: rows => rows.splice(rows.findIndex(r => r[1] === DSH.root), 1) }, /缺少/],
    ['缺少指纹记录', { rows: rows => rows.splice(rows.findIndex(r => r[1] === DSH.fingerprint), 1) }, /缺少/],
    ['重复路径', { rows: rows => rows.push([...rows[0]]) }, /路径重复/],
    ['大小写重复路径', { rows: rows => rows.push(['file', CHANGE.toUpperCase().replace('LIB/NODE_MODULES/', NM), 0, 420, sha(Buffer.alloc(0)), '-']) }, /重复|大小写/],
    ['父路径大小写别名', { rows: rows => rows.push(['file', `${NM}Kxxy-host/lib/other`, 0, 420, sha(Buffer.alloc(0)), '-']) }, /大小写/],
    ['文件父子重叠', { rows: rows => rows.push(['file', CHANGE + '/child', 0, 420, sha(Buffer.alloc(0)), '-']) }, /父目录/],
    ['单文件上限', { rows: modifyRow(r => { r[2] = DSH.fileBytes + 1 }) }, /上限/],
    ['指纹上限', { rows: modifyRow(r => { r[2] = 4097 }, DSH.fingerprint) }, /上限/],
    ['总解压上限', { rows: rows => { for (let i = 0; i < 9; i++) rows.push(['file', `${NM}limits/f${i}`, DSH.fileBytes, 420, 'a'.repeat(64), '-']) } }, /总解压/],
    ['记录数上限', { rows: rows => { while (rows.length <= 40000) rows.push([...rows[0]]) } }, /记录数/],
    ['manifest 字节上限', { manifest: () => ' '.repeat(DSH.manifestBytes + 1) }, /上限|超限/],
    ['payload 大小上限', { manifest: t => t.replace(/payload-size\t\d+/, `payload-size\t${DSH.payloadBytes + 1}`) }, /上限/],
    ['payload 最小长度', { manifest: t => t.replace(/payload-size\t\d+/, 'payload-size\t21') }, /太短/],
  ]
  for (const value of ['01', '-1', '1.0', '1e1', ' 1', '+1', '9223372036854775808']) {
    manifestCases.push([`非规范 size ${value}`, { rows: modifyRow(r => { r[2] = value }) }, /十进制|整数|上限|溢出/])
  }
  for (const path of ['../outside', '/absolute', `${NM}pkg/../x`, `${NM}pkg//x`, `${NM}pkg/back\\slash`, `${NM}pkg/a:b`, `${NM}pkg/a\0b`,
    `${NM}pkg/CON.txt`, `${NM}pkg/aux`, `${NM}pkg/x.`, `${NM}pkg/中文`, `${NM}@bad!scope/pkg/x`, `${NM}@scope/pkg`, `${NM}.bad/file`, 'bin/node',
    `${NM}pkg/${'a'.repeat(256)}`, `${NM}pkg/${Array(6).fill('a'.repeat(200)).join('/')}`]) {
    manifestCases.push([`非法路径 ${path.slice(0, 80)}`, { rows: modifyRow(r => { r[1] = path }) }, /路径|包名/])
  }
  for (const [name, options, pattern] of manifestCases) await test(`双验证器拒绝 manifest ${name}`, () => rejected(options, pattern))

  for (const [name, options, pattern] of [
    ['目标版本', { meta: m => { m.dshVersion = DSH.from } }, /版本/],
    ['previous 版本缺失', { meta: m => { delete m.dshPreviousVersion } }, /版本/],
    ['manifest SHA', { meta: m => { m.dshUpgradeManifestSha256 = 'f'.repeat(64) } }, /manifest|metadata/],
    ['runtime SHA', { meta: m => { m.runtimeSha256 = 'f'.repeat(64) } }, /runtime/],
    ['runtime size', { meta: m => { m.runtimeSize++ } }, /runtime/],
    ['runtime size 类型', { meta: m => { m.runtimeSize = String(m.runtimeSize) } }, /runtimeSize/],
    ['runtime 大于 4GiB', { meta: m => { m.runtimeSize = 0xffffffff } }, /runtimeSize/],
    ['runtime 计数上限', { meta: m => { m.runtimeEntries = 200001 } }, /runtimeEntries/],
    ['runtime 计数', { meta: m => { m.runtimeEntries++ } }, /计数/],
    ['runtime 未压缩大小', { meta: m => { m.runtimeUncompressedBytes++ } }, /未压缩/],
    ['host marker', { meta: m => { m.kxxyHostMarker = 'kxxy-host@wrong' } }, /marker|H1/],
    ['重复 JSON 字段', { metaBytes: b => Buffer.from(b.toString().trimEnd().slice(0, -1) + `,"dshVersion":"${DSH.to}"}`) }, /重复/],
    ['转义重复 JSON 字段', { metaBytes: b => Buffer.from(b.toString().trimEnd().slice(0, -1) + `,"dsh\\u0056ersion":"${DSH.to}"}`) }, /重复/],
    ['JSON 尾部内容', { metaBytes: b => Buffer.concat([b, Buffer.from('{}')]) }, /JSON|Extra data/],
    ['JSON 深度', { metaBytes: b => Buffer.from(b.toString().trimEnd().slice(0, -1) + ',"nested":' + '['.repeat(18) + '0' + ']'.repeat(18) + '}') }, /结构/],
    ['JSON 字节上限', { metaBytes: b => Buffer.concat([b, Buffer.alloc(DSH.metaBytes, 32)]) }, /上限|超限/],
    ['缺少 meta 输入', { omit: 'meta' }, /ENOENT|普通文件/],
    ['缺少 manifest 输入', { omit: 'manifest' }, /ENOENT|普通文件/],
    ['缺少 payload 输入', { omit: 'payload' }, /ENOENT|普通文件/],
    ['payload 整体 SHA', { manifest: t => t.replace(/payload-sha256\t[0-9a-f]+/, 'payload-sha256\t' + 'f'.repeat(64)) }, /payload/],
    ['payload 整体 size', { manifest: t => t.replace(/payload-size\t(\d+)/, (_, n) => `payload-size\t${Number(n) + 1}`) }, /payload/],
  ]) await test(`双验证器拒绝 metadata/输入 ${name}`, () => rejected(options, pattern))

  const payloadCases = [
    ['重复条目', items => items.push({ ...items[0] }), /数量|文件数/],
    ['缺少条目', items => items.pop(), /数量|文件数/],
    ['清单外条目', modifyEntry({ name: `${NM}unknown/unlisted` }), /清单外/],
    ['符号链接 mode', modifyEntry({ external: (0o120644 << 16) >>> 0 }), /普通文件|mode/],
    ['额外权限位', modifyEntry({ external: (0o104755 << 16) >>> 0 }), /mode/],
    ['DOS 目录位', modifyEntry({ external: ((0o100755 << 16) | 16) >>> 0 }), /普通文件|mode/],
    ['非 Unix 创建宿主', modifyEntry({ madeBy: 20 }), /普通文件|mode/],
    ['版本字段', modifyEntry({ version: 45 }), /版本|flags|方法/],
    ['加密标志', modifyEntry({ flags: 0x0801 }), /标记|flags|加密/],
    ['未知标志', modifyEntry({ flags: 0x0810 }), /标记|flags/],
    ['分卷', modifyEntry({ disk: 1 }), /方法|分卷|标记/],
    ['LINK 注释', modifyEntry({ comment: 'LINK:bin/node' }), /LINK/],
    ['无效 UTF-8 注释', modifyEntry({ comment: Buffer.from([0xff]) }), /UTF-8|utf-8|encoded/],
    ['逐文件 ZIP64 extra', modifyEntry({ extra: extra(1) }), /ZIP64/],
    ['重复 extra', modifyEntry({ extra: Buffer.concat([extra(0xcafe), extra(0xcafe)]) }), /重复/],
    ['链接 extra', modifyEntry({ extra: extra(0x000d) }), /链接/],
    ['ASi 链接 extra', modifyEntry({ extra: extra(0x756e) }), /链接/],
    ['替代路径 extra', modifyEntry({ extra: extra(0x7075) }), /路径|unicode path/i],
    ['截断 extra', modifyEntry({ extra: Buffer.from([1, 2, 3]) }), /extra/],
    ['本地 extra', modifyEntry({ localExtra: extra(1) }), /ZIP64/],
    ['本地名称', modifyEntry({ localName: CHANGE.replace('change', 'Change') }), /本地/],
    ['本地版本', modifyEntry({ localVersion: 10 }), /本地/],
    ['本地 flags', modifyEntry({ localFlags: 0 }), /本地/],
    ['本地 CRC', modifyEntry({ localCrc: 12345 }), /CRC/],
    ['实际 CRC', modifyEntry({ crc: 12345 }), /CRC/],
    ['中央 size', modifyEntry({ declaredSize: 1 }), /size|大小/],
    ['实际 SHA', items => { const e = items.find(e => e.name === CHANGE); e.data = Buffer.alloc(e.data.length, 120) }, /SHA/],
    ['descriptor CRC', modifyEntry({ method: 8, descriptor: 'signed', descriptorCrc: 12345 }), /descriptor/],
    ['descriptor 本地字段', modifyEntry({ method: 8, descriptor: 'signed', localSize: 1 }), /descriptor/],
    ['STORE descriptor', modifyEntry({ method: 0, descriptor: 'signed' }), /descriptor/],
    ['DEFLATE 尾部垃圾', items => { const e = items.find(e => e.name === CHANGE); e.method = 8; e.packed = Buffer.concat([deflateRawSync(e.data), Buffer.from('junk')]) }, /DEFLATE/],
    ['隐藏额外解压内容', items => { const e = items.find(e => e.name === CHANGE); e.method = 8; e.packed = deflateRawSync(Buffer.concat([e.data, Buffer.from('extra')])); e.declaredSize = e.data.length }, /实际解压/],
  ]
  for (const [name, payloadEntries, pattern] of payloadCases) await test(`双验证器拒绝 payload ${name}`, () => rejected({ payloadEntries }, pattern))
  await test('双验证器拒绝 payload 隐藏前缀/间隙', () => rejected({ payloadZip: { prefix: Buffer.from('hidden') } }, /间隙|重叠|隐藏/))
  await test('双验证器拒绝 payload ZIP64 计数声明', () => rejected({ payloadBytes: b => { b.writeUInt16LE(0xffff, b.length - 14); b.writeUInt16LE(0xffff, b.length - 12); return b } }, /ZIP64/))
  await test('双验证器拒绝 runtime 逐文件 ZIP64 extra', () => rejected({ runtimeEntries: modifyEntry({ extra: extra(1) }) }, /ZIP64/))
  await test('双验证器拒绝 runtime 与 payload 同名文件内容不同', () => rejected({ runtimeEntries: items => { const e = items.find(e => e.name === CHANGE); e.data = Buffer.alloc(e.data.length, 121) } }, /runtime.*不同/))
  await test('双验证器拒绝 runtime 文件 mode 不同', () => rejected({ runtimeEntries: modifyEntry({ mode: 0o644 }) }, /mode/))
  await test('双验证器拒绝 runtime 受管 LINK', () => rejected({ runtimeEntries: modifyEntry({ comment: 'LINK:bin/node' }) }, /LINK/))
  await test('双验证器拒绝 runtime 中 delete 仍存在', () => rejected({ runtimeEntries: items => items.push({ name: RETIRED, ...oldFiles.get(RETIRED) }) }, /delete/))
  await test('双验证器拒绝 runtime 受管路径大小写别名', () => rejected({ runtimeEntries: items => items.push({ name: CHANGE.replace('change', 'Change'), ...entry('alias') }) }, /大小写/))
  await test('双验证器拒绝 runtime 受管文件成为父目录', () => rejected({ runtimeEntries: items => items.push({ name: CHANGE + '/child', ...entry('child') }) }, /父目录/))
  for (const pkg of CORES) await test(`双验证器拒绝官方核心旧版本 ${pkg}`, () => rejected({ target: files => files.set(`${NM}${pkg}/package.json`, entry(json({ name: pkg, version: DSH.from }))) }, /核心版本/))
  await test('双验证器重新计算 H1 而不是只相信指纹文件', () => rejected({ target: files => files.set(`${HOST}patchset.version`, entry('宿主内容已被改变\n')) }, /H1/))
  await test('双验证器核对 H1 入口标记', () => rejected({ target: files => files.set(`${HOST}lib/index.js`, entry(files.get(`${HOST}lib/index.js`).data.toString().replace(targetSeed.host.slice(0, 12), '000000000000'))) }, /H1/))
  for (const [name, change] of [
    ['entries', root => root.entries++], ['directories', root => root.directories++], ['linkEntries', root => root.linkEntries++],
    ['hostFingerprint', root => { root.plugins.hostFingerprint = 'f'.repeat(64) }], ['hostMarker', root => { root.plugins.hostMarker = 'wrong' }],
    ['codexFingerprint', root => { root.plugins.codexFingerprint = 'f'.repeat(64) }], ['Python revision', root => { root.pythonRuntimeRevision = 'wrong' }],
  ]) await test(`双验证器核对 root manifest ${name}`, () => rejected({ root: change }, /root/))

  for (const [name, options, pattern] of [
    ['每条 previous 的真实 SHA', { rows: modifyRow(r => { r[5] = 'f'.repeat(64) }) }, /previous/],
    ['已有文件不能谎称新文件', { rows: modifyRow(r => { r[5] = '-' }) }, /previous/],
    ['不存在旧文件不能列 previous', { rows: modifyRow(r => { r[5] = 'f'.repeat(64) }, ADDED) }, /previous/],
    ['delete 真实旧 size', { rows: modifyRow(r => { r[2]++ }, RETIRED) }, /delete.*size/],
    ['delete 真实旧 mode', { rows: modifyRow(r => { r[3] = 493 }, RETIRED) }, /delete.*mode/],
    ['旧文件不能是 LINK', { baselineEntries: modifyEntry({ comment: 'LINK:bin/node' }) }, /LINK/],
    ['非 DSH 内容保留', { target: files => files.set('bin/node', entry('改变的 native\n', 0o755)) }, /未受管文件/],
    ['非 DSH mode 保留', { target: files => files.set('bin/node', { ...files.get('bin/node'), mode: 0o644 }) }, /未受管文件/],
    ['非 DSH LINK 注释保留', { target: files => files.set('bin/node-alias', entry('', 0o755, 'LINK:share/fixture.txt')) }, /未受管文件/],
    ['非 DSH 文件不能丢失', { target: files => files.delete('share/fixture.txt') }, /未受管文件/],
    ['非 DSH 文件不能暗增', { target: files => files.set('share/new.txt', entry('new')) }, /未声明的新文件/],
    ['未声明包文件不能改变', { target: files => files.set(`${NM}unrelated/user.txt`, entry('改变的包文件')), ignorePaths: [`${NM}unrelated/user.txt`] }, /未受管文件/],
  ]) await test(`baseline 拒绝 ${name}`, () => rejected(options, pattern, { baseline: true, nodeOnly: true }))

  const apkCases = [
    ['任意重复 ZIP 名', items => items.push({ name: 'unrelated', ...entry('a') }, { name: 'unrelated', ...entry('b') }), /重复/],
    ['metadata 非逐字匹配', modifyEntry({ data: Buffer.concat([json(good.meta), Buffer.from(' ')]) }, 'assets/meta/build.json'), /metadata/],
    ['manifest 非逐字匹配', items => { items.find(e => e.name.endsWith('manifest.tsv')).data = Buffer.concat([good.manifest, Buffer.from('\n')]) }, /manifest/],
    ['payload 非同源字节', items => { const e = items.find(e => e.name.endsWith('payload.zip')); e.data = Buffer.concat([e.data, Buffer.from('changed')]) }, /payload/],
    ['runtime 非同源字节', items => { const e = items.find(e => e.name === 'assets/runtime.zip'); e.data = Buffer.concat([e.data, Buffer.from('changed')]) }, /runtime/],
    ['双资产之外的陈旧文件', items => items.push({ name: 'assets/dsh-upgrade/stale.json', ...entry('{}') }), /双资产/],
    ['缺少 manifest', items => items.splice(items.findIndex(e => e.name.endsWith('manifest.tsv')), 1), /缺失/],
    ['缺少 payload', items => items.splice(items.findIndex(e => e.name.endsWith('payload.zip')), 1), /双资产|缺失/],
    ['缺少 runtime', items => items.splice(items.findIndex(e => e.name === 'assets/runtime.zip'), 1), /缺失/],
    ['缺少 helper 描述符', modifyEntry({ data: Buffer.from(targetSeed.host) }, 'classes.dex'), /描述符/],
    ['缺少 DEX H1 字符串', modifyEntry({ data: Buffer.from(descriptor) }, 'classes.dex'), /指纹字符串/],
  ]
  for (const [name, apkEntries, pattern] of apkCases) await test(`APK 拒绝 ${name}`, () => rejected({ apkEntries }, pattern, { pythonOnly: true }))
  await test('APK DEX 字符串跨读取块边界仍可发现', async () => {
    const f = await fixture({ apkEntries: modifyEntry({ data: Buffer.concat([Buffer.alloc(65530, 65), Buffer.from(descriptor + targetSeed.host)]) }, 'classes.dex') })
    await success(python, pythonArgs(f))
  })
  // zipalign 把本地头 extra 补成纯零字节（tag=0/size=0 后接 0x00），Android 接受，
  // 真实 0.9.46 包里有 135 个条目是这种形态；校验器不得把它误判成畸形字段。
  await test('APK 接受 zipalign 的零填充 extra', async () => {
    const f = await fixture({ apkEntries: modifyEntry({ localExtra: Buffer.from([0, 0, 0, 0, 0, 0, 0]) }, 'classes.dex') })
    const result = await success(python, pythonArgs(f))
    assert.equal(result.checksPassed, true)
  })
  // 但非零尾部垃圾仍要拒绝，避免用「允许填充」当挡箭牌放过越界 extra。
  await test('APK 仍拒绝非零尾部 extra', () => rejected({ apkEntries: modifyEntry({ localExtra: Buffer.from([0x35, 0xd9, 0x02, 0x00, 9]) }, 'classes.dex') }, /extra/, { pythonOnly: true }))
  await test('APK 报告独占创建，拒绝覆盖已有结果', async () => {
    const path = join(good.directory, 'existing-report.json'), before = Buffer.from('用户已有报告，不能覆盖\n')
    write(path, before)
    await failure(python, pythonArgs(good, path), /File exists|已存在|存在/)
    assert.deepEqual(fs.readFileSync(path), before)
  })
  await test('多块资产与流式守卫：禁止 ZipFile.read/Path.read_bytes 和无界 ZipExtFile.read', async () => {
    const f = await fixture({ target: files => files.set(`${NM}fixture-large/chunks.bin`, entry(Buffer.alloc(5 * 1024 * 1024, 42))) })
    const code = `import json, pathlib, runpy, sys, zipfile
m = runpy.run_path(sys.argv[1])
def forbidden(*a, **k):
    raise AssertionError('禁止整条目/整文件加载')
zipfile.ZipFile.read = forbidden
pathlib.Path.read_bytes = forbidden
original = zipfile.ZipExtFile.read
def bounded(self, n=-1):
    assert 0 <= n <= 65536, '必须使用有界 zipfile 流读取'
    return original(self, n)
zipfile.ZipExtFile.read = bounded
result = m['verify'](pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4]))
print(json.dumps(result))`
    await success(python, ['-I', '-B', '-X', 'utf8', '-c', code, pythonVerifier, f.apk, f.runtime, f.project])
    await success(process.execPath, nodeArgs(f))
  })
  await test('完整 runtime 接受大于 65535 条目的有界 ZIP64 计数，payload 仍 ZIP32', async () => {
    const f = await fixture({ zip64: true })
    const results = await parallel([success(process.execPath, nodeArgs(f)), success(python, pythonArgs(f))])
    for (const result of results) { assert.equal(result.runtimeZip64Count, true); assert.ok(result.runtimeEntries >= 65535 && result.files < 40000) }
  })
  await test('无巨型文件分配地检查 4GiB 和 ZIP64 200000 计数边界', async () => {
    assert.throws(() => readZipDirectory(() => assert.fail('越界长度不能触发读取'), 0xffffffff), /32 位/)
    const bytes = zipEndRecords(65535, 65535 * 46, 0, { allowZip64Count: true })
    bytes.writeBigUInt64LE(200001n, 24); bytes.writeBigUInt64LE(200001n, 32)
    const cdSize = 65535 * 46, fake = (at, count) => {
      const data = Buffer.alloc(count)
      const from = Math.max(at, cdSize), to = Math.min(at + count, cdSize + bytes.length)
      if (to > from) bytes.copy(data, from - at, from - cdSize, to - cdSize)
      return data
    }
    assert.throws(() => readZipDirectory(fake, cdSize + bytes.length), /计数/)
    const code = `import io, runpy, sys
m = runpy.run_path(sys.argv[1])
try:
    m['zip_directory'](io.BytesIO(), 0xffffffff, 'runtime')
    raise AssertionError('越界长度被接受')
except ValueError:
    pass
print('{}')`
    await success(python, ['-I', '-B', '-X', 'utf8', '-c', code, pythonVerifier])
  })
  await test('严格 JSON/TSV 解析接口与规范整数边界', () => {
    assert.throws(() => parseDshJson(Buffer.from('{"x":1,"x":2}')), /重复/)
    assert.throws(() => parseDshJson(Buffer.from('{"x":01}')), /JSON/)
    const text = good.manifest.toString().split('\n').map(line => line.startsWith(`file\t${CHANGE}\t`) ? line.replace(/\t\d+\t493\t/, `\t${DSH.fileBytes}\t493\t`) : line).join('\n')
    const data = Buffer.from(text)
    const parsed = parseDshManifest(data, { ...good.meta, dshUpgradeManifestSha256: sha(data) })
    assert.equal(parsed.records.find(r => r.path === CHANGE).size, DSH.fileBytes)
  })
  await test('命令行帮助、参数数量和 baseline 参数均明确', async () => {
    const help = await child(process.execPath, [nodeVerifier, '--help'])
    assert.equal(help.status, 0); assert.match(help.stdout, /--baseline/)
    for (const argv of [[], [good.runtime, good.assetDir], [...nodeArgs(good).slice(1), 'extra'], [...nodeArgs(good).slice(1), '--baseline']]) {
      await failure(process.execPath, [nodeVerifier, ...argv], /用法/)
    }
    const pyHelp = await child(python, ['-I', '-B', '-X', 'utf8', pythonVerifier, '--help'])
    assert.equal(pyHelp.status, 0); assert.match(pyHelp.stdout, /--project/); assert.match(pyHelp.stdout, /--report/)
  })
  await test('构建接线仅在 Python 验证附近增加 DSH 两步且按字段存在性失败关闭', () => {
    const source = fs.readFileSync(join(project, 'tools/build-codex-apk.ps1'), 'utf8')
    const pre = source.indexOf('tools\\verify-dsh-upgrade.mjs'), post = source.indexOf('tools\\verify-dsh-apk.py')
    assert.ok(pre > source.indexOf('tools\\verify-python-repair.mjs') && pre < source.indexOf('Copy-Item -LiteralPath $Runtime'))
    assert.ok(post > source.indexOf('tools\\verify-python-apk.py') && post < source.indexOf('$sha = (Get-FileHash'))
    assert.equal(source.split("$meta.PSObject.Properties.Name -contains 'dshUpgradeManifestSha256'").length - 1, 2)
    assert.equal(source.split("$meta.PSObject.Properties.Name -contains 'dshVersion'").length - 1, 2)
    assert.match(source.slice(pre, pre + 350), /\$LASTEXITCODE -ne 0/)
    assert.match(source.slice(post, post + 350), /\$LASTEXITCODE -ne 0/)
  })
  await test('生产 helper、生成器、ZIP、Python 验证器及真实 meta 未被测试改变', () => {
    for (const [path, before] of protectedHashes) assert.equal(sha(fs.readFileSync(join(project, path))), before, path)
  })
} catch (error) {
  outcomes.push({ name: '测试基础设施', passed: false, error: error.stack ?? String(error) })
  log(`测试基础设施失败\n${error.stack ?? error}`)
} finally {
  const result = { schema: 1, fixtureOnly: true, directory: scratch, log: logPath, node: process.version, python,
    passed: outcomes.filter(o => o.passed).length, failed: outcomes.filter(o => !o.passed).length, skipped: 0,
    deviceInstalled: false, deviceVerified: false, outcomes }
  write(join(scratch, 'result.json'), json(result))
  log(`结果 通过 ${result.passed}；失败 ${result.failed}；跳过 0\n日志 ${logPath}\n所有 fixture 保留，不清理。`)
  fs.closeSync(logFd)
  process.exitCode = result.failed ? 1 : 0
}
