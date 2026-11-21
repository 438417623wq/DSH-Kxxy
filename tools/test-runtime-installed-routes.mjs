/** Focused installer verification; no Android execution, provisioning, or full extraction.
 * node tools/test-runtime-installed-routes.mjs <runtime.zip> <NEW target directory>
 * Shared rewrite/check helpers are also used by simulate-install.mjs.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openIndexedZip, sha256File, validateZipPath } from './lib/zipedit.mjs'
import { PYTHON_DEFAULT_PATHS, pythonDefaultWrappers } from './lib/python-default.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = /@DSH_(?:ROOT|HOME|TMP|FILES|DATA)@/
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** ctx.filesDir is root's parent; EngineConfig uses files/kxxy-home and files/tmp.
 * Host-native paths deliberately remain host-native. On Windows this is a byte/
 * permission-call simulation, not execution of Android shell scripts.
 */
export function installedPlaceholderRules(root, manifest = {}) {
  const real = resolve(root)
  const files = dirname(real)
  return [
    [manifest.rootPlaceholder || '@DSH_ROOT@', real],
    ['@DSH_HOME@', join(files, 'kxxy-home')],
    ['@DSH_TMP@', join(files, 'tmp')],
    ['@DSH_FILES@', files],
    ['@DSH_DATA@', dirname(files)],
  ]
}

/** Kotlin replaceAll's ISO-8859-1 byte semantics; never decode payloads as UTF-8. */
export function rewriteInstalledBytes(data, rules) {
  let text = data.toString('latin1')
  for (const [needle, value] of rules) {
    text = text.split(needle).join(Buffer.from(value, 'latin1').toString('latin1'))
  }
  return Buffer.from(text, 'latin1')
}

export function verifyInstalledPythonRoutes(root, manifest, { chmodded = [], nativeBytes } = {}) {
  const generated = pythonDefaultWrappers()
  assert.deepEqual(generated.map(({ path }) => path), [...PYTHON_DEFAULT_PATHS])
  const rules = installedPlaceholderRules(root, manifest)
  const placeholders = new Set(manifest.placeholderPaths)
  for (const expected of generated) {
    const file = join(root, expected.path)
    const st = lstatSync(file)
    assert(st.isFile() && !st.isSymbolicLink() && st.size > 0, `invalid installed route: ${expected.path}`)
    const sourceText = expected.data.toString('latin1')
    if (TOKEN.test(sourceText)) assert(placeholders.has(expected.path), `undeclared route rewrite: ${expected.path}`)
    const data = readFileSync(file)
    assert(data.equals(rewriteInstalledBytes(expected.data, rules)), `installed source mismatch: ${expected.path}`)
    assert(!data.toString('latin1').includes('@DSH_'), `unresolved installed route: ${expected.path}`)
    // restoreExecBits chmods ALL libexec files, including the non-shebang dispatcher.
    assert(chmodded.includes(expected.path), `installer did not request exec bits: ${expected.path}`)
    if (process.platform !== 'win32') assert(st.mode & 0o111, `route not executable: ${expected.path}`)
    if (expected.path !== PYTHON_DEFAULT_PATHS[0]) assert(data.toString('latin1').startsWith('#!/system/bin/sh\n'), `route is not a shell shim: ${expected.path}`)
  }
  if (nativeBytes) {
    for (const name of ['bin/python', 'bin/python3']) {
      assert(!placeholders.has(name), `native interpreter declared for rewriting: ${name}`)
      assert(readFileSync(join(root, name)).equals(nativeBytes), `native interpreter changed: ${name}`)
    }
  }
  return { routes: generated.length, executableCalls: generated.length, modeVerified: process.platform !== 'win32' }
}

function verifyKotlinContract() {
  const source = readFileSync(join(HERE, '../android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt'), 'utf8')
  const config = readFileSync(join(HERE, '../android/app/src/main/java/app/kxxy/engine/EngineConfig.kt'), 'utf8')
  const map = /val rules = listOf\(([\s\S]*?)\)\.map/.exec(source.slice(source.indexOf('private fun rewriteRootPlaceholder')))?.[1]
  assert(map, 'Kotlin five-placeholder rewrite rules missing')
  for (const rule of [
    'placeholder to real', 'HOME_PLACEHOLDER to EngineConfig.dshHome(ctx).absolutePath',
    'TMP_PLACEHOLDER to EngineConfig.tmpDir(ctx).absolutePath', 'FILES_PLACEHOLDER to filesDir',
    'DATA_PLACEHOLDER to (ctx.filesDir.parentFile?.absolutePath ?: filesDir)',
  ]) assert(map.includes(rule), `Kotlin rewrite contract drift: ${rule}`)
  for (const token of ['ROOT', 'HOME', 'TMP', 'FILES', 'DATA']) {
    assert(source.includes(`const val ${token}_PLACEHOLDER = "@DSH_${token}@"`), `Kotlin token drift: ${token}`)
  }
  assert(config.includes('fun engineRoot(ctx: Context): File = File(ctx.filesDir, "engine")'))
  assert(config.includes('fun dshHome(ctx: Context): File = File(ctx.filesDir, "kxxy-home")'))
  assert(config.includes('fun tmpDir(ctx: Context): File = File(ctx.filesDir, "tmp")'))
  const routes = /private val PYTHON_DEFAULT_FILES = listOf\(([\s\S]*?)\n\s*\)/.exec(source)?.[1]
  assert(routes, 'Kotlin route completeness list missing')
  assert.deepEqual([...routes.matchAll(/"([^"]+)"/g)].map((m) => m[1]), [...PYTHON_DEFAULT_PATHS])
  const exec = source.slice(source.indexOf('private fun restoreExecBits'), source.indexOf('private fun ensureJvmExecBits'))
  assert(exec.includes('File(root, "libexec")') && exec.includes('.forEach { if (it.setExecutable(true, false)) changed++ }'), 'Kotlin libexec executable restoration drift')
  return true
}

function assertNativeInterpreter(data) {
  assert(data.length >= 64 && data.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), 'native Python is not ELF')
  assert.equal(data[4], 2, 'native Python is not ELF64')
  assert.equal(data[5], 1, 'native Python is not little-endian')
  assert.equal(data.readUInt16LE(18), 183, 'native Python is not ARM64')
  const offset = Number(data.readBigUInt64LE(32)), stride = data.readUInt16LE(54), count = data.readUInt16LE(56)
  assert(stride >= 56 && offset + stride * count <= data.length, 'native ELF program headers out of bounds')
  let interpreter = null
  for (let i = 0; i < count; i += 1) {
    const at = offset + i * stride
    if (data.readUInt32LE(at) !== 3) continue
    const begin = Number(data.readBigUInt64LE(at + 8)), size = Number(data.readBigUInt64LE(at + 32))
    assert(begin + size <= data.length && size > 0, 'native ELF interpreter out of bounds')
    interpreter = data.toString('ascii', begin, begin + size).replace(/\0$/, '')
  }
  assert.equal(interpreter, '/system/bin/linker64', 'native Python unexpectedly uses a glibc loader')
  assert(!data.includes(Buffer.from('GLIBC_')) && !data.includes(Buffer.from('libc.so.6')), 'glibc linkage mixed into native Python')
  return interpreter
}

function main() {
  assert(process.argv[2] && process.argv[3], 'usage: node test-runtime-installed-routes.mjs <runtime.zip> <NEW target>')
  const runtime = resolve(process.argv[2]), target = resolve(process.argv[3])
  assert(!existsSync(target), `refusing existing target: ${target}`)
  assert(statSync(dirname(target)).isDirectory(), 'target parent must exist')
  verifyKotlinContract()
  const originalHash = sha256File(runtime)
  const zip = openIndexedZip(runtime)
  try {
    const manifestData = zip.read('kxxy-runtime.json')
    const manifest = JSON.parse(manifestData)
    assert.equal(manifest.entries, zip.entries.length, 'manifest entry count mismatch')
    assert.equal(manifest.arch, 'aarch64')
    assert.equal(manifest.runtimeVersion, 'v0.1.0-arm64')
    assert.equal(manifest.schemaVersion, 2)
    assert(Array.isArray(manifest.placeholderPaths) && new Set(manifest.placeholderPaths).size === manifest.placeholderPaths.length, 'invalid placeholder metadata')
    assert.equal(manifest.linkEntries, zip.entries.filter((e) => e.comment.startsWith('LINK:')).length)
    assert.equal(manifest.directories, zip.entries.filter((e) => e.name.endsWith('/')).length)
    const generated = pythonDefaultWrappers()
    assert.deepEqual(generated.map(({ path }) => path), [...PYTHON_DEFAULT_PATHS])
    const rules = installedPlaceholderRules(target, manifest)
    // Actual route templates currently contain ROOT/FILES; independently exercise
    // all five real rules with binary edge bytes, plus Kotlin's manifest override.
    const fixture = Buffer.concat([Buffer.from([0, 128, 255]), Buffer.from(rules.map(([ph]) => ph).join('|')), Buffer.from([255, 0])])
    assert(rewriteInstalledBytes(fixture, rules).equals(Buffer.concat([Buffer.from([0, 128, 255]), Buffer.from(rules.map(([, value]) => value).join('|'), 'latin1'), Buffer.from([255, 0])])))
    assert.equal(rewriteInstalledBytes(Buffer.from('@CUSTOM_ROOT@'), installedPlaceholderRules(target, { rootPlaceholder: '@CUSTOM_ROOT@' })).toString('latin1'), target)
    const nativeTargets = new Set()
    for (const name of ['bin/python', 'bin/python3']) {
      const entry = zip.byName.get(name)
      assert(entry && entry.comment.startsWith('LINK:'), `native alias is not preserved: ${name}`)
      const real = entry.comment.slice(5)
      validateZipPath(real)
      assert(real.startsWith('bin/python') && !zip.byName.get(real)?.comment.startsWith('LINK:'), `unexpected native interpreter target: ${real}`)
      assert(!manifest.placeholderPaths.includes(name) && !manifest.placeholderPaths.includes(real), `native interpreter would be rewritten: ${name}`)
      nativeTargets.add(real)
    }
    assert.equal(nativeTargets.size, 1, 'native Python aliases differ')
    const nativePath = [...nativeTargets][0], nativeBytes = zip.read(nativePath)
    const interpreter = assertNativeInterpreter(nativeBytes)
    assert(zip.readResolved('bin/python').equals(nativeBytes) && zip.readResolved('bin/python3').equals(nativeBytes))
    const budget = nativeBytes.length * 3 + generated.reduce((n, e) => n + e.data.length, 0) + manifestData.length
    const space = statfsSync(dirname(target), { bigint: true })
    assert(space.bavail * space.bsize > BigInt(budget + 16 * 1024 * 1024), 'insufficient free space for focused extraction')
    mkdirSync(target) // no recursive/overwrite; concurrent creation fails closed
    const write = (name, data) => {
      validateZipPath(name)
      const dest = resolve(target, name)
      assert(dest.startsWith(target + sep), `path escapes test target: ${name}`)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, data, { flag: 'wx' })
    }
    write('kxxy-runtime.json', manifestData)
    const chmodded = []
    for (const expected of generated) {
      const entry = zip.byName.get(expected.path)
      assert(entry && !entry.comment.startsWith('LINK:'), `missing/non-regular route: ${expected.path}`)
      assert.equal(entry.mode & 0o777, expected.mode, `ZIP mode mismatch: ${expected.path}`)
      const data = zip.read(expected.path)
      assert(data.equals(expected.data), `ZIP/source mismatch: ${expected.path}`)
      write(expected.path, rewriteInstalledBytes(data, rules))
      chmodSync(join(target, expected.path), 0o755)
      chmodded.push(expected.path)
    }
    // Focused mode copies both alias views: verify bytes and ZIP LINK metadata,
    // not symlink creation. Full simulator retains its existing symlink path.
    for (const name of [nativePath, 'bin/python', 'bin/python3']) {
      write(name, nativeBytes)
      chmodSync(join(target, name), 0o755)
    }
    const checked = verifyInstalledPythonRoutes(target, manifest, { chmodded, nativeBytes })
    assert.equal(sha256(readFileSync(join(target, nativePath))), sha256(nativeBytes))
    assert.equal(sha256File(runtime), originalHash, 'source archive changed during verification')
    console.log(JSON.stringify({
      result: 'PASS', mode: 'focused-installed-routes', target, runtime, sourceSha256: originalHash,
      entries: zip.entries.length, zipBytes: zip.size, fullExpandedBytes: zip.entries.reduce((n, e) => n + e.size, 0),
      ...checked, placeholdersExercised: rules.map(([token]) => token), nativePath, nativeSha256: sha256(nativeBytes), interpreter,
      archiveMetadataVerified: true, fullSimulationRun: false, androidExecutionRun: false,
      limitations: ['Native aliases copied; ZIP LINK targets/bytes checked, host symlink semantics not tested.', ...(process.platform === 'win32' ? ['Windows chmod calls are mock-mode; POSIX exec bits and Android shell execution not verified.'] : [])],
    }, null, 2))
  } finally { zip.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
