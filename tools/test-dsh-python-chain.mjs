// Real APK assets and released baseline bytes; the two production Kotlin helpers run in installer order.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { openIndexedZip } from './lib/zipedit.mjs'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.resolve(process.argv[2] || path.join(project, '.cache/runtime-0.9.46'))
const baseline = path.resolve(process.argv[3] || path.join(project, '.cache/runtime-0.9.43/runtime.zip'))
const mode = process.argv[4] || 'interrupt'
assert.ok(['interrupt', 'normal'].includes(mode))
const scratch = fs.mkdtempSync(path.join(project, '.cache/dsh-python-chain-'))
const assets = path.join(scratch, 'assets'), engine = path.join(scratch, 'private/engine')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const write = (name, bytes) => { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, bytes, { flag: 'wx' }) }
for (const name of ['build.json', 'dsh-upgrade/manifest.tsv', 'dsh-upgrade/payload.zip', 'python-repair/manifest.json', 'python-repair/payload.zip']) {
  const out = path.join(assets, name === 'build.json' ? 'meta/build.json' : name)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.copyFileSync(path.join(target, name), out, fs.constants.COPYFILE_EXCL)
}
const meta = JSON.parse(fs.readFileSync(path.join(assets, 'meta/build.json')))
const python = JSON.parse(fs.readFileSync(path.join(assets, 'python-repair/manifest.json')))
const rows = fs.readFileSync(path.join(assets, 'dsh-upgrade/manifest.tsv'), 'utf8').trimEnd().split('\n').slice(7).map(line => line.split('\t'))
assert.equal(meta.dshVersion, '0.2.2-rc.2')
assert.ok(rows.length > 30000 && rows.every(row => row.length === 6))
const names = new Set([...rows.map(row => row[1]), ...python.files.map(file => file.path)])
const byName = new Map(rows.map(row => [row[1], row]))
const old = openIndexedZip(baseline)
let seeded = 0
try {
  const root = JSON.parse(old.read('kxxy-runtime.json'))
  assert.equal(root.plugins.hostFingerprint, python.baseHostFingerprint)
  for (const name of ['dsh', 'dsh-base', 'dsh-web-app']) assert.equal(JSON.parse(old.read(`lib/node_modules/@deepseek-ai/${name}/package.json`)).version, '0.2.1-rc.5')
  for (const name of names) {
    const entry = old.byName.get(name)
    if (!entry) continue
    assert.ok(!entry.comment.startsWith('LINK:') && !name.endsWith('/'))
    const bytes = old.read(name)
    const row = byName.get(name)
    if (row) assert.ok(row[5].split(',').includes(sha(bytes)), `Released previous SHA: ${name}`)
    write(path.join(engine, name), bytes)
    if (process.platform !== 'win32') fs.chmodSync(path.join(engine, name), entry.mode & 0o777)
    seeded++
  }
  // Preserve genuine non-managed native/Python anchors in addition to independent user-owned sentinels.
  for (const name of ['bin/node', 'bin/python3.14', 'share/kxxy/python-runtime.json']) {
    if (names.has(name) || !old.byName.has(name)) continue
    write(path.join(engine, name), old.readResolved(name))
  }
} finally { old.close() }
const keep = ['extensions/user/data.bin', 'venv/lib/python3.14/site-packages/user.py', 'lib/python3.14/site-packages/user_pkg/data.py',
  'lib/python3.14/site-packages/cffi/local-user-notes.txt', 'lib/node_modules/user-global-npm/index.js',
  'lib/node_modules/@deepseek-ai/dsh/user-notes.txt', 'home/sessions/keep.jsonl', 'kxxy-home/.credentials.yaml', 'work/project/source.py']
for (const name of keep) { assert.ok(!names.has(name)); write(path.join(engine, name), `KEEP:${name}\n`) }
write(path.join(scratch, 'python-records.tsv'), python.files.map(file => [file.path, file.size, file.sha256].join('\t')).join('\n') + '\n')
write(path.join(scratch, 'user-paths.txt'), keep.join('\n') + '\n')
console.log(JSON.stringify({ scratch, baseline, target, mode, seeded, managed: rows.length, pythonFiles: python.files.length, host: meta.kxxyHostFingerprint }))

const engineSources = path.join(project, 'android/app/src/main/java/app/kxxy/engine')
const inputs = [path.join(engineSources, 'PythonRuntimeRepair.kt'), path.join(engineSources, 'DshRuntimeUpgrade.kt'), path.join(project, 'tools/fixtures/DshPythonChainTest.kt')]
const hashes = inputs.map(name => sha(fs.readFileSync(name)))
const cache = process.env.KOTLIN_CACHE || path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1')
const jar = (folder, version) => {
  const base = path.join(cache, folder, version)
  const found = fs.readdirSync(base).flatMap(hash => fs.readdirSync(path.join(base, hash)).filter(name => name.endsWith('.jar')).map(name => path.join(base, hash, name)))[0]
  assert.ok(found, `Missing cached Kotlin dependency: ${base}`)
  return found
}
const std = jar('org.jetbrains.kotlin/kotlin-stdlib', '1.9.24'), annotations = jar('org.jetbrains/annotations', '13.0')
const cp = [std, annotations].join(path.delimiter)
const compiler = [jar('org.jetbrains.kotlin/kotlin-compiler-embeddable', '1.9.24'), std, jar('org.jetbrains.kotlin/kotlin-reflect', '1.9.24'),
  jar('org.jetbrains.kotlin/kotlin-script-runtime', '1.9.24'), jar('org.jetbrains.intellij.deps/trove4j', '1.0.20200330'), annotations].join(path.delimiter)
const java = process.env.KXXY_JAVA || 'E:/deepseek-harness/XJZB/_toolchain/jdk-17.0.20.1+1/bin/java.exe'
function run(label, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(java, ['-Dfile.encoding=UTF-8', ...args], { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', error
    console.log(`START ${label} PID ${child.pid}`)
    const timer = setTimeout(() => { error = new Error(`${label} timed out after ${timeout} ms`); child.kill() }, timeout)
    child.stdout.on('data', data => { process.stdout.write(data); output += data; if (output.length > 8 * 1024 * 1024) { error = new Error('Output bound'); child.kill() } })
    child.stderr.on('data', data => process.stderr.write(data))
    child.on('error', cause => { error = cause })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      console.log(`END ${label} EXIT ${status} SIGNAL ${signal}`)
      if (error || status !== 0) reject(error || new Error(`${label} exited ${status}`))
      else resolve(output)
    })
  })
}
try {
  const out = path.join(scratch, 'classes')
  await run('compile real helpers', ['-Xmx384m', '-cp', compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '1.8', '-classpath', cp, '-d', out, ...inputs], 180000)
  const output = await run('real asset combined upgrade', ['-Xmx384m', '-cp', [out, cp].join(path.delimiter), 'app.kxxy.engine.DshPythonChainTestKt', scratch, meta.kxxyHostFingerprint, mode], 1800000)
  const result = /^RESULT (\{[^\r\n]+\})$/m.exec(output)
  assert.ok(result, 'Missing final combined test summary')
  const summary = JSON.parse(result[1])
  assert.equal(summary.failed, 0)
  assert.equal(summary.skipped, 0)
  assert.ok(summary.passed >= (mode === 'interrupt' ? 12 : 9))
  assert.deepEqual(inputs.map(name => sha(fs.readFileSync(name))), hashes, 'Sources changed during validation')
  write(path.join(scratch, 'result.json'), JSON.stringify({ ...summary, baseline, target, mode, seeded, sourceHashes: hashes, deviceVerified: false }, null, 2) + '\n')
} finally { console.log(`ARTIFACTS ${scratch}`) }
