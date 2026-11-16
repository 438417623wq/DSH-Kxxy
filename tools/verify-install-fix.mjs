/** 校验修复版 APK 的运行时、构建指纹和三份修复资源，避免只更新外壳。 */
import assert from 'node:assert/strict'
import { openSync, readSync, closeSync, readFileSync, statSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openZip } from './lib/zipread.mjs'

const [apkPath, runtimePath] = process.argv.slice(2)
assert(apkPath && runtimePath, '用法：node tools/verify-install-fix.mjs <apk> <runtime.zip>')
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
  const tailStart = Math.max(0, size - 66000)
  const tail = readAt(tailStart, size - tailStart)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i
      break
    }
  }
  assert(eocd >= 0, 'APK 没有合法中央目录')
  const count = tail.readUInt16LE(eocd + 10)
  const cd = readAt(tail.readUInt32LE(eocd + 16), tail.readUInt32LE(eocd + 12))
  const entries = new Map()
  let p = 0
  for (let i = 0; i < count; i++) {
    assert.equal(cd.readUInt32LE(p), 0x02014b50)
    const n = cd.readUInt16LE(p + 28)
    const name = cd.toString('utf8', p + 46, p + 46 + n)
    assert(!entries.has(name), `重复条目：${name}`)
    entries.set(name, { method: cd.readUInt16LE(p + 10), compressed: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42) })
    p += 46 + n + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32)
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
    assert([0, 8].includes(entry.method), '不支持的资产压缩方式')
    return entry.method === 0 ? raw : inflateRawSync(raw)
  }
  const meta = JSON.parse(asset('assets/meta/build.json').toString('utf8'))
  const runtimeEntry = entries.get('assets/runtime.zip')
  assert(runtimeEntry, 'APK 缺少运行时')
  assert.equal(runtimeEntry.method, 0, 'runtime.zip 必须 STORE')
  assert.equal(runtimeEntry.size, statSync(runtimePath).size)
  const digest = createHash('sha256')
  const start = dataOffset(runtimeEntry)
  for await (const chunk of createReadStream(apkPath, { start, end: start + runtimeEntry.size - 1 })) digest.update(chunk)
  assert.equal(digest.digest('hex'), meta.runtimeSha256, 'APK 内 runtime 指纹与构建清单不一致')
  const runtime = openZip(runtimePath)
  for (const rel of ['web/host.css', 'web/index.html', 'lib/localinstall.mjs']) {
    const packed = runtime.read(`lib/node_modules/kxxy-host/${rel}`)
    assert(packed, `运行时缺少 ${rel}`)
    assert.equal(sha(packed), sha(readFileSync(join(project, 'plugins', 'kxxy-host', rel))), `运行时仍是旧资源：${rel}`)
    console.log(`资源一致：${rel} ${sha(packed)}`)
  }
  const manifest = JSON.parse(runtime.read('kxxy-runtime.json').toString('utf8'))
  assert.equal(manifest.plugins.hostFingerprint, meta.kxxyHostFingerprint)
  const fp = runtime.read('lib/node_modules/kxxy-host/lib/.fingerprint').toString('utf8')
  assert(fp.includes(`fingerprint:${meta.kxxyHostFingerprint}\n`), '插件指纹文件不一致')
  assert(runtime.read('lib/node_modules/kxxy-host/lib/index.js').toString('utf8').startsWith(`/* ${meta.kxxyHostMarker} */`), '入口标记不一致')
  console.log(`APK/运行时/宿主插件指纹一致：${meta.kxxyHostFingerprint}`)
  console.log(`修复版 APK 资源校验通过：${apkPath}`)
} finally {
  closeSync(fd)
}
