/** 校验启动救援 APK 的原生入口、运行时指纹及已修改宿主资产。 */
import assert from 'node:assert/strict'
import { openSync, readSync, closeSync, readFileSync, statSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openZip } from './lib/zipread.mjs'

const [apkPath, runtimePath] = process.argv.slice(2)
assert(apkPath && runtimePath, '用法：node tools/verify-startup-rescue-apk.mjs <apk> <runtime.zip>')
const project = join(dirname(fileURLToPath(import.meta.url)), '..')
const sha = data => createHash('sha256').update(data).digest('hex')
const fd = openSync(apkPath, 'r')
function readAt(offset, length) {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, offset + read)
    assert(n > 0, 'APK 被截断')
    read += n
  }
  return buffer
}
try {
  const size = statSync(apkPath).size
  const start = Math.max(0, size - 66000)
  const tail = readAt(start, size - start)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break }
  }
  assert(eocd >= 0, 'APK 没有合法中央目录')
  const count = tail.readUInt16LE(eocd + 10)
  const cd = readAt(tail.readUInt32LE(eocd + 16), tail.readUInt32LE(eocd + 12))
  const entries = new Map()
  let p = 0
  for (let i = 0; i < count; i++) {
    assert.equal(cd.readUInt32LE(p), 0x02014b50)
    const length = cd.readUInt16LE(p + 28)
    const name = cd.toString('utf8', p + 46, p + 46 + length)
    assert(!entries.has(name), `重复条目：${name}`)
    entries.set(name, { method: cd.readUInt16LE(p + 10), compressed: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42) })
    p += 46 + length + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32)
  }
  function dataOffset(entry) {
    const header = readAt(entry.offset, 30)
    assert.equal(header.readUInt32LE(0), 0x04034b50)
    return entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
  }
  function asset(name) {
    const entry = entries.get(name)
    assert(entry, `缺少 ${name}`)
    const raw = readAt(dataOffset(entry), entry.compressed)
    assert([0, 8].includes(entry.method))
    return entry.method === 0 ? raw : inflateRawSync(raw)
  }
  const meta = JSON.parse(asset('assets/meta/build.json').toString('utf8'))
  const runtimeEntry = entries.get('assets/runtime.zip')
  assert(runtimeEntry, 'APK 缺少运行时')
  assert.equal(runtimeEntry.method, 0, 'runtime.zip 必须 STORE')
  assert.equal(runtimeEntry.size, statSync(runtimePath).size)
  const digest = createHash('sha256')
  const runtimeStart = dataOffset(runtimeEntry)
  for await (const chunk of createReadStream(apkPath, { start: runtimeStart, end: runtimeStart + runtimeEntry.size - 1 })) digest.update(chunk)
  assert.equal(digest.digest('hex'), meta.runtimeSha256, 'APK runtime 指纹不匹配')
  const runtime = openZip(runtimePath)
  for (const rel of ['web/host.js', 'lib/index.js', 'lib/health.mjs']) {
    const packed = runtime.read(`lib/node_modules/kxxy-host/${rel}`)
    assert(packed, `运行时缺少 ${rel}`)
    const source = readFileSync(join(project, 'plugins', 'kxxy-host', rel))
    if (rel === 'lib/index.js') {
      assert.equal(packed.toString('utf8').replace(/^\/\*[^\n]*\*\//, ''), source.toString('utf8').replace(/^\/\*[^\n]*\*\//, ''), '运行时仍是旧宿主入口')
    } else assert.equal(sha(packed), sha(source), `运行时仍是旧资源：${rel}`)
    console.log(`资源一致：${rel}`)
  }
  const manifest = JSON.parse(runtime.read('kxxy-runtime.json').toString('utf8'))
  assert.equal(manifest.plugins.hostFingerprint, meta.kxxyHostFingerprint)
  const fp = runtime.read('lib/node_modules/kxxy-host/lib/.fingerprint').toString('utf8')
  assert(fp.includes(`fingerprint:${meta.kxxyHostFingerprint}\n`))
  const dexes = [...entries.keys()].filter(name => /^classes\d*\.dex$/.test(name)).map(asset)
  const symbols = ['Lapp/kxxy/BootstrapActivity;', 'Lapp/kxxy/engine/RescueDiagnostics;', 'forceReinstall', 'performRecovery', 'kxxy.rescue']
  if (process.argv.includes('--permissions')) symbols.push('Lapp/kxxy/engine/UserDataPermissions;', 'USER_DATA_PERMISSIONS', 'confirmPermissionsRepair')
  if (process.argv.includes('--boot-data')) symbols.push('Lapp/kxxy/engine/SessionDataPermissions;', 'Lapp/kxxy/engine/CredentialsLockRecovery;', 'BOOT_DATA', 'confirmBootDataRepair')
  if (process.argv.includes('--boot-data-compat')) symbols.push('[A-Za-z0-9_%+=@.~-]{1,255}', 'malformed lock quarantined after Root process survey', 'native process absent during survey')
  for (const symbol of symbols) {
    assert(dexes.some(dex => dex.includes(Buffer.from(symbol))), `APK dex 缺少救援代码：${symbol}`)
  }
  assert(entries.has('lib/arm64-v8a/libdsh_pty.so'), 'APK 缺少原生 PTY 库')
  console.log(`APK 原生入口/运行时/宿主资源校验通过：${apkPath}`)
} finally {
  closeSync(fd)
}
