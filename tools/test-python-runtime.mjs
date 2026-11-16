/** 离线回归：Python 依赖装配、元数据/ABI 拦截与增量 ZIP 保真。 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { openIndexedZip, patchZip, writeSmallZip } from './lib/zipedit.mjs'
import { HOST_PLUGIN_BASE, stampHostPluginFingerprint } from './lib/host-fingerprint.mjs'
import {
  CFFI_BACKEND, PYTHON_SITE, PYTHON_LEDGER, PYTHON_TARGET, PYTHON_REVISION,
  inspectAndroidElf, loadPythonDependencies, verifyPythonRuntime, verifyPythonInputs, verifyWheelRecord,
  createPythonRepairAssets, jsonBytes, sha256,
} from './lib/python-runtime.mjs'

const project = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dependencies = process.env.KXXY_PYTHON_DEPS
if (!dependencies) throw new Error('请设置 KXXY_PYTHON_DEPS 指向 build-python-deps.py 的 manifest.json')
const runtime = process.env.KXXY_TEST_RUNTIME ?? join(project, '.cache/runtime-0.9.41/runtime.zip')
const scratch = mkdtempSync(join(tmpdir(), 'kxxy-python-runtime-test-'))
const python = loadPythonDependencies(dependencies)
const original = openIndexedZip(runtime)
const names = [...new Set([...original.byName.keys(), ...python.files.keys()])]
const read = (path) => python.files.get(path)?.data ?? original.readResolved(path)
const expectFailure = (override, pattern) => assert.throws(() => verifyPythonRuntime(names, (path) => override.has(path) ? override.get(path) : read(path)), pattern)

await test('CFFI2.0.0/pycparser2.23 的真实构件完整且绑定目标运行时', () => {
  verifyPythonInputs(python.ledger, original.readResolved)
  const result = verifyPythonRuntime(names, read)
  assert.equal(result.managedFiles, python.files.size - 1)
  assert.equal(result.deviceVerified, false)
  assert.equal(result.native.minApi, 24)
  assert.equal(result.warnings.length, 2)
  assert.deepEqual(python.ledger.python, PYTHON_TARGET)
})
await test('旧运行时缺 CFFI 时必须失败，不再假通过', () => {
  assert.throws(() => verifyPythonRuntime([...original.byName.keys()], original.readResolved), /缺少/)
})
await test('后端丢失或损坏必须失败', () => {
  expectFailure(new Map([[PYTHON_SITE + CFFI_BACKEND, null]]), /缺少/)
  expectFailure(new Map([[PYTHON_SITE + CFFI_BACKEND, Buffer.from('invalid')]]), /损坏/)
})
await test('编译输入发生变化必须重新构建', () => {
  assert.throws(() => verifyPythonInputs(python.ledger, (path) => path === 'lib/libffi.so' ? Buffer.from('changed') : original.readResolved(path)), /必须重新构建/)
})
await test('Windows ELF、错误架构、截断结构一律拒绝', () => {
  assert.throws(() => inspectAndroidElf(Buffer.alloc(80)), /不是 Android/)
  const arm = Buffer.from(read(PYTHON_SITE + CFFI_BACKEND)); arm.writeUInt16LE(62, 18)
  assert.throws(() => inspectAndroidElf(arm), /不是 Android/)
  const bad = Buffer.from(read(PYTHON_SITE + CFFI_BACKEND)); bad.writeBigUInt64LE(BigInt(bad.length + 1), 32)
  assert.throws(() => inspectAndroidElf(bad), /不合法/)
})
await test('只放包元数据而没有包正文不能通过', () => {
  expectFailure(new Map([[PYTHON_SITE + 'cffi/__init__.py', null]]), /缺少/)
  expectFailure(new Map([[PYTHON_SITE + 'pycparser/__init__.py', null]]), /缺少/)
})
await test('新增 cryptography 依赖合同不被静默忽略', () => {
  expectFailure(new Map([[PYTHON_SITE + 'cryptography-50.0.2.dist-info/METADATA', Buffer.from('Requires-Dist: cffi>=9.0\n')]]), /合同变化/)
})
await test('RECORD 必须覆盖所有文件且包含正确摘要', () => {
  const files = new Map([['a.py', Buffer.from('x')], ['a-1.dist-info/RECORD', Buffer.from('a.py,sha256=bad,1\na-1.dist-info/RECORD,,\n')]])
  assert.throws(() => verifyWheelRecord(files, 'a-1.dist-info'), /摘要/)
  files.set('a-1.dist-info/RECORD', Buffer.from('a-1.dist-info/RECORD,,\n'))
  assert.throws(() => verifyWheelRecord(files, 'a-1.dist-info'), /未被 RECORD/)
})
await test('同名 CFFI 多版本元数据不能并存', () => {
  assert.throws(() => verifyPythonRuntime([...names, PYTHON_SITE + 'cffi-1.17.dist-info/METADATA'], read), /多个版本/)
})
await test('未登记的包文件被拒绝', () => {
  assert.throws(() => verifyPythonRuntime([...names, PYTHON_SITE + 'cffi/injected.py'], read), /未登记/)
})
await test('宿主指纹复用与既有基线一致，重复计算幂等', () => {
  const files = new Map(original.entries.filter((entry) => entry.name.startsWith(HOST_PLUGIN_BASE) && !entry.name.endsWith('/')).map((entry) => [entry.name, { data: original.readResolved(entry.name), mode: 0o644 }]))
  const first = stampHostPluginFingerprint(files)
  assert.equal(first, JSON.parse(original.read('kxxy-runtime.json')).plugins.hostFingerprint)
  assert.equal(stampHostPluginFingerprint(files), first)
})
await test('ZIP 增量只改目标，保留 LINK/权限/其他字节', async () => {
  const input = join(scratch, 'source.zip'), output = join(scratch, 'result.zip')
  await writeSmallZip(input, new Map([
    ['bin/tool', { data: Buffer.from('original binary'), mode: 0o755 }],
    ['bin/alias', { data: Buffer.alloc(0), mode: 0o755, comment: 'LINK:bin/tool' }],
    ['old.txt', { data: Buffer.from('old'), mode: 0o644 }],
  ]))
  const result = await patchZip(input, output, new Map([
    ['old.txt', { data: Buffer.from('new'), mode: 0o644 }],
    ['extra.py', { data: Buffer.from('pass\n'), mode: 0o644 }],
  ]))
  const zip = openIndexedZip(output)
  try {
    assert.equal(zip.read('old.txt').toString(), 'new')
    assert.equal(zip.readResolved('bin/alias').toString(), 'original binary')
    assert.equal(zip.byName.get('bin/tool').mode & 0o777, 0o755)
    assert.equal(zip.entries.length, 4)
    assert.equal(result.sha256, sha256(readFileSync(output)))
  } finally { zip.close() }
  await assert.rejects(patchZip(input, output, new Map()), /拒绝覆盖/)
})
await test('ZIP 穿越、重复与损坏不能悄悄通过', async () => {
  await assert.rejects(writeSmallZip(join(scratch, 'bad-path.zip'), new Map([['../outside', { data: Buffer.from('x') }]])), /非法 ZIP 路径/)
  const bytes = Buffer.from(readFileSync(join(scratch, 'result.zip')))
  const zip = openIndexedZip(join(scratch, 'result.zip')); const offset = zip.byName.get('bin/tool').dataOffset; zip.close()
  bytes[offset] ^= 1
  const bad = join(scratch, 'bad-crc.zip'); writeFileSync(bad, bytes)
  const damaged = openIndexedZip(bad)
  try { assert.throws(() => damaged.read('bin/tool'), /CRC/) } finally { damaged.close() }
})
await test('修复资产严格路径白名单，绑定 payload 与前版本摘要', async () => {
  const base = 'a'.repeat(64), target = 'b'.repeat(64)
  const files = new Map(python.files)
  const path = 'kxxy-runtime.json', old = Buffer.from('{}\n')
  files.set(path, { data: jsonBytes({ pythonRuntimeRevision: PYTHON_REVISION }), mode: 0o644 })
  const result = await createPythonRepairAssets(join(scratch, 'repair'), files, { baseHostFingerprint: base, hostFingerprint: target, previous: new Map([[path, old]]) })
  assert.equal(result.manifest.files.find((item) => item.path === path).previousSha256, sha256(old))
  assert.equal(result.manifest.payloadSha256, sha256(readFileSync(join(scratch, 'repair/payload.zip'))))
  assert.equal(result.manifestSha256, sha256(readFileSync(join(scratch, 'repair/manifest.json'))))
  const bad = new Map([['lib/python3.14/site-packages/user.py', { data: Buffer.from('x'), mode: 0o644 }]])
  await assert.rejects(createPythonRepairAssets(join(scratch, 'bad-repair'), bad, { baseHostFingerprint: base, hostFingerprint: target }), /越界/)
  assert.equal(existsSync(join(scratch, 'bad-repair/payload.zip')), false)
})
original.close()
console.log(`Python runtime regression scratch: ${scratch}`)
