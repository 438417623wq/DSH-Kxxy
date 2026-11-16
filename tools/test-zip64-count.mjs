/** Count-only ZIP64 regression. All artifacts remain in a new project .cache directory. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { ZipWriter, zipEndRecords, MAX_ZIP_ENTRIES } from './lib/zipwrite.mjs'
import { openZip, readZipEntries, readZipDirectory } from './lib/zipread.mjs'
import { openIndexedZip, patchZip, sha256File } from './lib/zipedit.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const cache = join(project, '.cache')
assert.ok(statSync(cache).isDirectory())
const scratch = mkdtempSync(join(cache, 'test-zip64-count-'))
const java = process.env.KXXY_JAVA || 'E:/deepseek-harness/XJZB/_toolchain/jdk-17.0.20.1+1/bin/java.exe'
let passed = 0
function pass(label) { passed++; console.log(`PASS ${label}`) }
const metadata = bytes => readZipDirectory((offset, length) => bytes.subarray(offset, offset + length), bytes.length)
const hello = Buffer.from('hello zipped world\n'.repeat(64))

async function fixture(name, count, allowZip64Count) {
  const pieces = [], writer = new ZipWriter(bytes => pieces.push(bytes), { allowZip64Count })
  for (let i = 0; i < count - 4; i++) await writer.add(`f/${i}.txt`, Buffer.alloc(0))
  await writer.add('text/hello.txt', hello)
  await writer.add('unicode/测试.txt', Buffer.from('中文'))
  await writer.add('alias', Buffer.alloc(0), { comment: 'LINK:text/hello.txt' })
  await writer.add('bin/run', Buffer.from('#!/bin/sh\nexit 0\n'), { mode: 0o755 })
  const info = writer.finish(), bytes = Buffer.concat(pieces)
  assert.equal(info.entries, count)
  assert.equal(bytes.length, info.bytes)
  const path = join(scratch, name)
  writeFileSync(path, bytes, { flag: 'wx' })
  return path
}

function checkReaders(path, count) {
  const indexed = openIndexedZip(path)
  try {
    assert.equal(indexed.entries.length, count)
    assert.equal(indexed.directory.zip64Count, count >= 0xffff)
    assert.deepEqual(indexed.read('text/hello.txt'), hello)
    assert.deepEqual(indexed.readResolved('alias'), hello)
    assert.equal(indexed.byName.get('bin/run').mode & 0o777, 0o755)
  } finally { indexed.close() }
  const zip = openZip(path)
  assert.equal(zip.names().length, count)
  assert.deepEqual(zip.read('text/hello.txt'), hello)
  assert.equal(zip.read('unicode/测试.txt').toString(), '中文')
  assert.equal(readZipEntries(path).length, count)
  pass(`all three readers: ${count} entries, content/mode/LINK`)
}
function javaCheck(path, count) {
  const out = spawnSync(java, ['-Dfile.encoding=UTF-8', join(project, 'tools/fixtures/ZipCountCompatibility.java'), path, String(count)], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  })
  process.stdout.write(out.stdout || '')
  process.stderr.write(out.stderr || '')
  if (out.error) throw out.error
  assert.equal(out.status, 0, `Java reader exit ${out.status}`)
  pass(`Java interoperability ${count}`)
}

console.log(`ZIP regression artifacts: ${scratch}`)
const zip32 = await fixture('zip32-65534.zip', 65534, false)
checkReaders(zip32, 65534)
const before = sha256File(zip32)
const boundary = join(scratch, 'zip64-65535.zip')
await patchZip(zip32, boundary, new Map([['new/one', { data: Buffer.from('one'), mode: 0o644 }]]), new Set(), { allowZip64Count: true })
checkReaders(boundary, 65535)
assert.equal(sha256File(zip32), before)
pass('repacking never overwrites the released input')
const above = join(scratch, 'zip64-65536.zip')
await patchZip(boundary, above, new Map([['new/two', { data: Buffer.from('two'), mode: 0o644 }]]), new Set(), { allowZip64Count: true })
checkReaders(above, 65536)
const large = await fixture('zip64-runtime-84620.zip', 84620, true)
checkReaders(large, 84620)
for (const [path, count] of [[zip32, 65534], [boundary, 65535], [above, 65536], [large, 84620]]) javaCheck(path, count)

const largeBytes = readFileSync(large), parsed = metadata(largeBytes)
const eocd = parsed.eocdOffset, z64 = eocd - 76, locator = eocd - 20
function corrupt(label, mutate) {
  const bytes = Buffer.from(largeBytes)
  const result = mutate(bytes) || bytes
  assert.throws(() => metadata(result), /ZIP|EOCD|目录|分卷/)
  pass(`reject ${label}`)
}
corrupt('missing locator', b => { b.writeUInt32LE(0, locator) })
corrupt('locator split disks', b => { b.writeUInt32LE(2, locator + 16) })
corrupt('locator disk number', b => { b.writeUInt32LE(1, locator + 4) })
corrupt('unsafe 64-bit offset', b => { b.writeBigUInt64LE(2n ** 63n, locator + 8) })
corrupt('misaligned ZIP64 EOCD', b => { b.writeBigUInt64LE(BigInt(z64 - 1), locator + 8) })
corrupt('bad ZIP64 signature', b => { b.writeUInt32LE(0, z64) })
corrupt('ZIP64 extensible record', b => { b.writeBigUInt64LE(45n, z64 + 4) })
corrupt('unsupported ZIP version', b => { b.writeUInt16LE(63, z64 + 14) })
corrupt('ZIP64 split disk', b => { b.writeUInt32LE(1, z64 + 16) })
corrupt('mismatched ZIP64 counts', b => { b.writeBigUInt64LE(84619n, z64 + 24) })
corrupt('oversized count', b => { b.writeBigUInt64LE(BigInt(MAX_ZIP_ENTRIES + 1), z64 + 24); b.writeBigUInt64LE(BigInt(MAX_ZIP_ENTRIES + 1), z64 + 32) })
corrupt('noncanonical small ZIP64 count', b => { b.writeBigUInt64LE(1n, z64 + 24); b.writeBigUInt64LE(1n, z64 + 32) })
corrupt('mismatched central size', b => { b.writeBigUInt64LE(BigInt(parsed.cdSize + 1), z64 + 40) })
corrupt('mismatched central offset', b => { b.writeBigUInt64LE(BigInt(parsed.cdOffset + 1), z64 + 48) })
corrupt('legacy size sentinel', b => { b.writeUInt32LE(0xffffffff, eocd + 12) })
corrupt('legacy offset sentinel', b => { b.writeUInt32LE(0xffffffff, eocd + 16) })
corrupt('legacy disk mismatch', b => { b.writeUInt16LE(1, eocd + 4) })
corrupt('legacy count mismatch', b => { b.writeUInt16LE(1, eocd + 8) })
corrupt('truncated EOCD', b => b.subarray(0, b.length - 1))
corrupt('trailing junk', b => Buffer.concat([b, Buffer.from('junk')]))

const comment = Buffer.from('archive comment: PK\x05\x06 not a real EOCD')
const commented = Buffer.concat([largeBytes, comment])
commented.writeUInt16LE(comment.length, eocd + 20)
assert.equal(metadata(commented).count, 84620)
pass('EOCD comment signature does not hide the real directory')
assert.throws(() => zipEndRecords(65535, 65535 * 46, 1), /ZIP32/)
assert.throws(() => zipEndRecords(MAX_ZIP_ENTRIES + 1, (MAX_ZIP_ENTRIES + 1) * 46, 1, { allowZip64Count: true }), /上限/)
assert.throws(() => zipEndRecords(0, 0, 0xffffffff), /上限/)
assert.throws(() => zipEndRecords(0, 0, 0xffffffff - 21), /上限/)
assert.throws(() => zipEndRecords(1.5, 100, 1), /非法/)
pass('writer refuses implicit ZIP64, count overflow and 4 GiB offsets')
await assert.rejects(patchZip(large, join(scratch, 'must-not-publish.zip'), new Map()), /上限/)
pass('repacking ZIP64 also requires explicit permission')
await assert.rejects(patchZip(zip32, boundary, new Map()), /拒绝覆盖/)
pass('existing output is never overwritten')

const tiny = await fixture('tiny.zip', 4, false)
const tinyBytes = readFileSync(tiny), tinyMeta = metadata(tinyBytes)
const malformed = Buffer.from(tinyBytes)
malformed.writeUInt32LE(0xffffffff, tinyMeta.cdOffset + 20)
const badPath = join(scratch, 'bad-file-size.zip')
writeFileSync(badPath, malformed, { flag: 'wx' })
assert.throws(() => openIndexedZip(badPath), /ZIP64/)
assert.throws(() => openZip(badPath), /ZIP64/)
pass('both readers reject per-file ZIP64 sizes')
const dataBad = Buffer.from(tinyBytes)
// Mutate the first deflate stream while keeping the trusted CRC in both headers.
dataBad[30 + dataBad.readUInt16LE(26)] ^= 0xff
const crcPath = join(scratch, 'bad-crc.zip')
writeFileSync(crcPath, dataBad, { flag: 'wx' })
const bad = openIndexedZip(crcPath)
try { assert.throws(() => bad.read('text/hello.txt')) } finally { bad.close() }
assert.throws(() => openZip(crcPath).read('text/hello.txt'))
pass('CRC/inflate validation remains active')
console.log(`ZIP count regression: ${passed} passed, 0 failed. Desktop JVM only; Android device not tested.`)
