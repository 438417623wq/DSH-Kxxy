/** Update the official DSH closure without rebuilding Termux, Python or native Codex.
 * Produces a new full runtime and an authenticated, file-scoped Android upgrade.
 * All previous hashes come from the released source ZIP, never an intermediate restamp.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openAsar } from './lib/registry.mjs'
import { resolveClosure, readClosureInto, readPluginFiles, collectDirs } from './lib/assemble.mjs'
import { applyAllPatches } from './lib/patches.mjs'
import { stampHostPluginFingerprint, HOST_PLUGIN_BASE } from './lib/host-fingerprint.mjs'
import { stampCodexPlugin, CODEX_PLUGIN_BASE } from './lib/codex.mjs'
import { openIndexedZip, patchZip, sha256File, writeSmallZip } from './lib/zipedit.mjs'
import { MAX_ZIP_ENTRIES } from './lib/zipwrite.mjs'
import { OFFICE_LAYER_MARKER, OFFICE_LAYER_MARKER_FILE, officeMapReader, verifyOfficeAssets } from './lib/office-assets.mjs'
import { createPythonRepairAssets, jsonBytes, sha256, verifyPythonRuntime } from './lib/python-runtime.mjs'
import { verifyPythonRepair, verifyManifestSchemaContract, verifyPayload } from './verify-python-repair.mjs'

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FROM = '0.2.1-rc.5', TO = '0.2.2-rc.2'
const NM = 'lib/node_modules/'
const ROOTS = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const PATCHSET = 'kxxy-patchset@26'
const ROOT_MANIFEST = 'kxxy-runtime.json'
const HOST_FP = `${HOST_PLUGIN_BASE}lib/.fingerprint`
const SCHEMA = 'kxxy-dsh-upgrade@1'
// Authenticated against assets/meta/build.json inside the actually released APK,
// not an intermediate restamp. Keep this input mandatory so release coverage cannot
// silently shrink when a cache file is unavailable.
const PREVIOUS_RELEASE = Object.freeze({
  version: '0.9.42', relativePath: '.cache/runtime-0.9.42/runtime.zip', size: 916245292,
  sha256: 'b8bdc326ec0e86e8123e2b026a2418dc45d8f649f78cea16062304a44cd964a5',
})

function topPackage(path) {
  if (!path.startsWith(NM)) return null
  const pieces = path.slice(NM.length).split('/')
  return pieces[0].startsWith('@') ? pieces.slice(0, 2).join('/') : pieces[0]
}
function file(path, bytes, mode = 0o644) { return [path, { data: bytes, mode }] }

// 与 DshRuntimeUpgrade.kt loadManifest/validatePath 的合同同源校验；预检不能只数文件。
export function validateDshUpgradeRecords(records) {
  assert.ok(Array.isArray(records) && records.length <= 40000, 'upgrade record bound')
  const paths = new Set(), spellings = new Map()
  let unpackedBytes = 0, payloadUpperBound = 22, maxFileBytes = 0, files = 0
  const validHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  for (const row of records) {
    assert.ok(Array.isArray(row) && row.length === 6 && ['file', 'delete'].includes(row[0]), 'six-column upgrade record')
    const [kind, path, size, mode, target, previous] = row
    assert.equal(typeof path, 'string', 'upgrade path')
    const parts = path.split('/')
    assert.ok(path.length >= 1 && path.length <= 1024 && parts.every(part => part.length >= 1 && part.length <= 255 &&
      part !== '.' && part !== '..' && !part.endsWith('.') && /^[A-Za-z0-9_+@.\-]+$/.test(part) &&
      !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(part.split('.')[0])), `Kotlin path contract: ${path}`)
    if (path !== ROOT_MANIFEST) {
      assert.ok(parts.length >= 4 && parts[0] === 'lib' && parts[1] === 'node_modules', `Package path whitelist: ${path}`)
      const pkg = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/
      assert.ok(parts[2].startsWith('@') ? parts.length >= 5 && pkg.test(parts[2].slice(1)) && pkg.test(parts[3]) : pkg.test(parts[2]), `Package name: ${path}`)
    }
    const key = path.toLowerCase()
    assert.ok(!paths.has(key), `Duplicate managed path: ${path}`)
    paths.add(key)
    let prefix = ''
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part
      const lower = prefix.toLowerCase(), old = spellings.get(lower)
      assert.ok(!old || old === prefix, `Case-aliased managed path: ${path}`)
      spellings.set(lower, prefix)
    }
    assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 128 * 1024 * 1024, `Single-file bound: ${path}`)
    assert.ok([420, 493].includes(mode), `Unsupported file mode: ${path}`)
    assert.ok(kind === 'file' ? validHash(target) : target === '-', `Target SHA: ${path}`)
    assert.equal(typeof previous, 'string')
    const hashes = previous === '-' ? [] : previous.split(',')
    assert.ok(hashes.every(validHash) && new Set(hashes).size === hashes.length && (kind === 'file' || hashes.length > 0), `Previous SHA: ${path}`)
    if (path === HOST_FP) assert.ok(size <= 4096 && kind === 'file', 'Host fingerprint bound')
    if (kind === 'file') {
      files++
      unpackedBytes += size
      maxFileBytes = Math.max(maxFileBytes, size)
      // ZipWriter uses STORE if DEFLATE is larger; no extras/comments in this payload.
      payloadUpperBound += size + 76 + 2 * Buffer.byteLength(path, 'utf8')
    }
  }
  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    let parent = slash < 0 ? '' : path.slice(0, slash)
    while (parent) {
      assert.ok(!paths.has(parent), `Managed file overlaps its parent: ${path}`)
      const i = parent.lastIndexOf('/')
      parent = i < 0 ? '' : parent.slice(0, i)
    }
  }
  for (const path of [ROOT_MANIFEST, HOST_FP]) assert.ok(records.some(row => row[0] === 'file' && row[1] === path), `Required upgrade record: ${path}`)
  assert.ok(unpackedBytes <= 1024 * 1024 * 1024, 'Total unpacked bound')
  assert.ok(payloadUpperBound <= 512 * 1024 * 1024, 'Worst-case payload bound')
  assert.ok(Buffer.byteLength(records.map(row => row.join('\t')).join('\n'), 'utf8') + 1024 <= 16 * 1024 * 1024, 'Manifest byte bound')
  return { files, retired: records.length - files, unpackedBytes, payloadUpperBound, maxFileBytes }
}

/** Plan only trusted archive files; never enumerate or delete installed package directories.
 * An unchanged primary file still needs a record if another supported release differs.
 */
export function planDshPackageUpgrade(source, target, extraSources = [], placeholderPaths = []) {
  const sources = [source, ...extraSources]
  const packageRoots = new Set([...target.keys()].map(topPackage).filter(Boolean))
  const rewritten = new Set(placeholderPaths)
  const oldNames = new Set(sources.flatMap(zip => zip.entries.map(entry => entry.name)))
  const removed = new Set(), replacements = new Map(), records = []
  function previous(name) {
    return sources.map(zip => {
      const entry = zip.byName.get(name)
      if (!entry) return null
      assert.ok(!entry.name.endsWith('/') && !entry.comment.startsWith('LINK:') &&
        (entry.mode & 0o170000) === 0o100000, `Unsupported managed archive file: ${name}`)
      const data = zip.read(name)
      return { data, sha256: sha256(data), size: entry.size, mode: entry.mode & 0o777 }
    })
  }
  const hashes = values => [...new Set(values.filter(Boolean).map(value => value.sha256))].join(',') || '-'
  for (const name of oldNames) {
    if (name.endsWith('/') || !packageRoots.has(topPackage(name)) || target.has(name)) continue
    assert.ok(!rewritten.has(name), `Device-rewritten file cannot use archive hashes: ${name}`)
    const values = previous(name).filter(Boolean), first = values[0]
    // Delete records have one exact old length/mode. Do not widen this contract to
    // accept a different retired file merely because a second SHA was supplied.
    assert.ok(values.every(value => value.size === first.size && value.mode === first.mode), `Retired file differs in size/mode between releases: ${name}`)
    removed.add(name)
    records.push(['delete', name, first.size, first.mode, '-', hashes(values)])
  }
  for (const [name, entry] of target) {
    const values = previous(name)
    if (name !== HOST_FP && values.every(value => value && value.data.equals(entry.data) && value.mode === entry.mode)) continue
    assert.ok(!rewritten.has(name), `Device-rewritten file cannot use archive hashes: ${name}`)
    replacements.set(name, entry)
    records.push(['file', name, entry.data.length, entry.mode, sha256(entry.data), hashes(values)])
  }
  return { removed, replacements, records }
}

export async function upgradeDshRuntime({ input, asar: asarPath, output, meta, pythonAssets, lock, checkOnly = false }) {
  if (existsSync(output)) throw new Error(`Refusing to overwrite runtime: ${output}`)
  const source = openIndexedZip(input)
  const extraSources = []
  try {
    const originalMeta = JSON.parse(readFileSync(meta, 'utf8'))
    assert.equal(originalMeta.runtimeSize, source.size, 'baseline size')
    assert.equal(originalMeta.runtimeSha256, sha256File(input), 'baseline SHA-256')
    const originalManifest = JSON.parse(source.read(ROOT_MANIFEST))
    assert.equal(originalManifest.plugins.hostFingerprint, originalMeta.kxxyHostFingerprint)
    for (const name of ROOTS) assert.equal(JSON.parse(source.read(`${NM}${name}/package.json`)).version, FROM, `baseline ${name}`)
    const olderPath = join(PROJECT, PREVIOUS_RELEASE.relativePath)
    assert.ok(existsSync(olderPath), `Missing supported released runtime: ${olderPath}`)
    const older = openIndexedZip(olderPath)
    extraSources.push(older)
    assert.equal(older.size, PREVIOUS_RELEASE.size, 'released 0.9.42 size')
    assert.equal(sha256File(olderPath), PREVIOUS_RELEASE.sha256, 'released 0.9.42 SHA-256')
    const olderManifest = JSON.parse(older.read(ROOT_MANIFEST))
    assert.equal(olderManifest.plugins?.hostFingerprint, originalMeta.kxxyHostFingerprint, 'released 0.9.42 host')
    for (const name of ROOTS) assert.equal(JSON.parse(older.read(`${NM}${name}/package.json`)).version, FROM, `released 0.9.42 ${name}`)
    const placeholderPaths = [...new Set([...originalManifest.placeholderPaths, ...olderManifest.placeholderPaths])]
    // Two released baselines share H0 and FROM; 0.9.42 differs from 0.9.43 only in
    // the Codex client, its fingerprint file and the root manifest. Both must be
    // covered so neither installed generation is rejected as unknown content.
    const supportedReleases = [
      { version: PREVIOUS_RELEASE.version, size: PREVIOUS_RELEASE.size, sha256: PREVIOUS_RELEASE.sha256 },
      { version: '0.9.43', size: source.size, sha256: sha256File(input) },
    ]
    const lockBytes = readFileSync(lock)
    const lockJson = JSON.parse(lockBytes)
    for (const name of ROOTS) {
      const item = lockJson.packages?.[`node_modules/${name}`]
      assert.equal(item?.version, TO, `lockfile ${name}`)
      assert.ok(item.integrity?.startsWith('sha512-'), `Missing integrity: ${name}`)
    }
    const asar = openAsar(asarPath)
    const closure = resolveClosure(asar, ROOTS)
    assert.equal(closure.missing.size, 0, `Missing required dependencies: ${JSON.stringify([...closure.missing])}`)
    for (const name of ROOTS) assert.equal(closure.readPkg(name)?.version, TO, name)
    for (const instance of closure.seen) {
      const pkg = closure.readPkg(instance), locked = lockJson.packages?.[`node_modules/${instance}`]
      assert.ok(pkg && locked && locked.version === pkg.version && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(locked.integrity ?? ''), `Unpinned upstream package: ${instance}`)
    }
    const target = new Map()
    readClosureInto(asar, closure, target)
    console.log(`Official DSH ${FROM} -> ${TO}; ${closure.seen.size} packages, ${target.size} files`)
    const patches = applyAllPatches(target, name => source.readResolved(name))
    for (const patch of patches) console.log(`PATCH ${patch}`)
    // Keep the existing host/native layers. Only explicitly selected host metadata changes.
    const host = new Map(source.entries.filter(e => e.name.startsWith(HOST_PLUGIN_BASE) && !e.name.endsWith('/'))
      .map(e => file(e.name, source.readResolved(e.name), e.mode & 0o777)))
    assert.equal(stampHostPluginFingerprint(host), originalMeta.kxxyHostFingerprint, 'released host contents')
    host.set(`${HOST_PLUGIN_BASE}patchset.version`, { data: Buffer.from(`${PATCHSET}\n`), mode: 0o644 })
    host.set(OFFICE_LAYER_MARKER_FILE, { data: Buffer.from(`${OFFICE_LAYER_MARKER}\n`), mode: 0o644 })
    const hostFingerprint = stampHostPluginFingerprint(host)
    for (const [name, entry] of host) target.set(name, entry)
    const codex = new Map()
    readPluginFiles(join(PROJECT, 'plugins/dsh-codex-sidebar'), codex, CODEX_PLUGIN_BASE)
    const codexFingerprint = stampCodexPlugin(codex)
    for (const [name, entry] of codex) target.set(name, entry)

    const office = verifyOfficeAssets(officeMapReader(target), { full: true, runtime: true })
    console.log(`Office ${office.version}: ${office.files.length} authenticated resources; ${OFFICE_LAYER_MARKER}`)
    // Only packages present in the new closure are replaced. Packages no longer needed
    // by the new closure are retained rather than guessing whether the user needs them.
    // Include every supported released baseline, even when the primary already has
    // the target bytes (e.g. the Codex client fixed between 0.9.42 and 0.9.43).
    const { removed, replacements, records } = planDshPackageUpgrade(source, target, extraSources, placeholderPaths)
    const finalNames = new Set(source.byName.keys())
    for (const name of removed) finalNames.delete(name)
    for (const name of replacements.keys()) finalNames.add(name)
    for (const dir of collectDirs([...finalNames].filter(n => !n.endsWith('/')).map(path => ({ path })))) {
      if (!finalNames.has(`${dir}/`)) { finalNames.add(`${dir}/`); replacements.set(`${dir}/`, { data: Buffer.alloc(0), mode: 0o755 }) }
    }
    // Drop empty old archive directory records; no on-device directory deletion occurs.
    const realFiles = [...finalNames].filter(n => !n.endsWith('/'))
    const neededDirs = new Set(collectDirs(realFiles.map(path => ({ path }))).map(n => `${n}/`))
    for (const name of finalNames) if (name.endsWith('/') && !neededDirs.has(name)) { finalNames.delete(name); removed.add(name) }
    if (finalNames.size > MAX_ZIP_ENTRIES) throw new Error(`Bounded runtime ZIP entry limit exceeded: ${finalNames.size}`)
    const manifest = {
      ...originalManifest,
      entries: finalNames.size,
      directories: [...finalNames].filter(n => n.endsWith('/')).length,
      builtAt: new Date().toISOString(),
      plugins: { ...originalManifest.plugins, hostFingerprint, hostMarker: `kxxy-host@${hostFingerprint.slice(0, 12)}`, codexFingerprint },
    }
    const rootFile = { data: jsonBytes(manifest), mode: 0o644 }
    replacements.set(ROOT_MANIFEST, rootFile)
    const oldManifestHashes = new Set([source, ...extraSources].map(zip => sha256(zip.read(ROOT_MANIFEST))))
    records.push(['file', ROOT_MANIFEST, rootFile.data.length, 420, sha256(rootFile.data), [...oldManifestHashes].join(',')])
    records.sort((a, b) => a[1] < b[1] ? -1 : 1)
    const limits = validateDshUpgradeRecords(records)
    const readFinal = name => replacements.get(name)?.data ?? (removed.has(name) ? null : source.readResolved(name))
    verifyPythonRuntime([...finalNames], readFinal)
    verifyManifestSchemaContract(readFileSync(join(PROJECT, 'android/app/src/main/java/app/kxxy/engine/PythonRuntimeRepair.kt'), 'utf8'), manifest)
    // Native binaries, the Python environment, package managers and extension inputs are not rebuilt.
    const outsideChanges = [...replacements.keys(), ...removed].filter(n => !n.endsWith('/') && n !== ROOT_MANIFEST && !n.startsWith(NM))
    assert.deepEqual(outsideChanges, [], 'No non-DSH/runtime data replacements')
    // Validate the Python/host transition during preflight as well, not only after
    // spending time writing the DSH payload. The original repair asset stays intact.
    const oldPythonManifest = JSON.parse(readFileSync(join(pythonAssets, 'manifest.json'), 'utf8'))
    const repairFiles = new Map(), previous = new Map()
    for (const record of oldPythonManifest.files) {
      const old = source.read(record.path)
      assert.equal(sha256(old), record.sha256, `Baseline Python record: ${record.path}`)
      const bytes = readFinal(record.path)
      repairFiles.set(record.path, { data: bytes, mode: record.mode })
      previous.set(record.path, old)
    }
    console.log(`Delta: ${records.filter(r => r[0] === 'file').length} files, ${records.filter(r => r[0] === 'delete').length} retired files; full ZIP ${finalNames.size} entries`)
    if (checkOnly) return { checked: true, version: TO, packages: closure.seen.size, patches, records: records.length, entries: finalNames.size,
      officeVersion: office.version, officeResources: office.files.length, supportedReleases, ...limits }

    const outDir = dirname(output)
    mkdirSync(outDir, { recursive: true })
    const upgradeAssets = join(outDir, 'dsh-upgrade')
    const newPythonAssets = join(outDir, 'python-repair')
    mkdirSync(upgradeAssets, { recursive: true })
    mkdirSync(newPythonAssets, { recursive: true })
    const payloadFiles = new Map(records.filter(r => r[0] === 'file').map(r => [r[1], replacements.get(r[1])]))
    const payloadPath = join(upgradeAssets, 'payload.zip')
    await writeSmallZip(payloadPath, payloadFiles)
    const payload = openIndexedZip(payloadPath)
    let payloadSize
    try {
      payloadSize = payload.size
      for (const row of records.filter(r => r[0] === 'file')) assert.equal(sha256(payload.read(row[1])), row[4], row[1])
    } finally { payload.close() }
    assert.ok(payloadSize <= 512 * 1024 * 1024, 'DSH payload bound')
    const tsv = Buffer.from([SCHEMA, `from\t${FROM}`, `to\t${TO}`, `base-host\t${originalMeta.kxxyHostFingerprint}`, `host\t${hostFingerprint}`, `payload-sha256\t${sha256File(payloadPath)}`, `payload-size\t${payloadSize}`, ...records.map(r => r.join('\t')), ''].join('\n'))
    assert.ok(tsv.length <= 16 * 1024 * 1024)
    writeFileSync(join(upgradeAssets, 'manifest.tsv'), tsv, { flag: 'wx' })

    const pythonRepair = await createPythonRepairAssets(newPythonAssets, repairFiles, {
      baseHostFingerprint: originalMeta.kxxyHostFingerprint, hostFingerprint, previous,
    })
    const result = await patchZip(input, output, replacements, removed, { allowZip64Count: true })
    const metadata = {
      ...originalMeta, generatedAt: new Date().toISOString(), runtimeSha256: result.sha256, runtimeSize: result.size,
      runtimeEntries: result.entries, runtimeUncompressedBytes: result.uncompressedBytes,
      kxxyHostFingerprint: hostFingerprint, kxxyHostMarker: `kxxy-host@${hostFingerprint.slice(0, 12)}`,
      codexPluginFingerprint: codexFingerprint, pythonRepairManifestSha256: pythonRepair.manifestSha256,
      dshVersion: TO, dshPreviousVersion: FROM, dshUpgradeManifestSha256: sha256(tsv),
      dshSource: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.2-rc.2.tgz',
      dshSourceIntegrity: lockJson.packages['node_modules/@deepseek-ai/dsh'].integrity,
      dshLockSha256: sha256(lockBytes),
    }
    const final = openIndexedZip(output)
    try {
      assert.equal(final.entries.length, manifest.entries)
      for (const row of records) {
        if (row[0] === 'delete') assert.equal(final.byName.has(row[1]), false)
        else assert.equal(sha256(final.read(row[1])), row[4], row[1])
      }
      for (const name of ROOTS) assert.equal(JSON.parse(final.read(`${NM}${name}/package.json`)).version, TO)
      for (const old of source.entries) if (!replacements.has(old.name) && !removed.has(old.name)) {
        const now = final.byName.get(old.name)
        assert.ok(now && old.size === now.size && old.crc === now.crc && old.mode === now.mode && old.comment === now.comment, `Preserved entry: ${old.name}`)
      }
      const aliases = final.entries.filter(e => e.comment.startsWith('LINK:'))
      for (const e of aliases) assert.ok(final.byName.has(e.comment.slice(5)), `Dangling alias: ${e.name}`)
      writeFileSync(join(outDir, 'alias-links.txt'), aliases.map(e => `${e.name}\t${e.comment.slice(5)}`).join('\n') + '\n', { flag: 'wx' })
    } finally { final.close() }
    verifyPayload(join(newPythonAssets, 'payload.zip'), readFileSync(join(newPythonAssets, 'manifest.json')))
    verifyPythonRepair({ runtime: output, manifestBytes: readFileSync(join(newPythonAssets, 'manifest.json')), payloadBytes: readFileSync(join(newPythonAssets, 'payload.zip')), meta: metadata })
    writeFileSync(join(outDir, 'build.json'), jsonBytes(metadata), { flag: 'wx' })
    writeFileSync(join(outDir, 'upstream-package-lock.json'), lockBytes, { flag: 'wx' })
    const report = { schema: 1, input, output, from: FROM, to: TO, ...result, upstreamPackages: closure.seen.size,
      patchLog: patches, replacedFiles: records.filter(r => r[0] === 'file').length, retiredFiles: records.filter(r => r[0] === 'delete').length,
      payloadSize, hostFingerprint, codexFingerprint, dshUpgradeManifestSha256: metadata.dshUpgradeManifestSha256,
      officeVersion: office.version, officeResources: office.files.length,
      supportedPreviousReleases: supportedReleases.map(({ version, size, sha256 }) => ({ version, size, sha256 })),
      nonDshFilesPreserved: true, deviceInstalled: false, deviceVerified: false }
    writeFileSync(join(outDir, 'dsh-upgrade-verification.json'), jsonBytes(report), { flag: 'wx' })
    return report
  } finally { for (const zip of extraSources) zip.close(); source.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}
  const keys = { '--in': 'input', '--asar': 'asar', '--out': 'output', '--meta': 'meta', '--python-assets': 'pythonAssets', '--lock': 'lock' }
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--check-only') { options.checkOnly = true; continue }
    const key = keys[process.argv[i]]
    if (!key || !process.argv[i + 1]) throw new Error(`Invalid argument: ${process.argv[i]}`)
    options[key] = resolve(process.argv[++i])
  }
  for (const key of Object.values(keys)) if (!options[key]) throw new Error(`Missing ${key}`)
  console.log(JSON.stringify(await upgradeDshRuntime(options), null, 2))
}
