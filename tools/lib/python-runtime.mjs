/**
 * Termux deb 的 postinst 不会在离线解包时执行。Python 依赖须显式装配，
 * 不能把 apt Depends 或一个可导入的顶层包当作完整的运行依赖闭包。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { openIndexedZip, validateZipPath, writeSmallZip } from './zipedit.mjs'

export const PYTHON_REVISION = 'python-cffi-2.0.0-cp314-android24-arm64-v1'
export const PYTHON_SITE = 'lib/python3.14/site-packages/'
export const PYTHON_LEDGER = 'share/kxxy/python-runtime.json'
export const CFFI_BACKEND = '_cffi_backend.cpython-314-aarch64-linux-android.so'
export const PYTHON_TARGET = Object.freeze({ version: '3.14.8', majorMinor: '3.14', soabi: 'cpython-314-aarch64-linux-android', minApi: 24, arch: 'arm64-v8a' })
export const PYTHON_SOURCES = Object.freeze({
  cffi: { version: '2.0.0', sha256: '44d1b5909021139fe36001ae048dbdde8214afa20200eda0f64c068cac5d5529' },
  pycparser: { version: '2.23', sha256: 'e5c6e8d3fbad53479cab09ac03729e0a9faf2bee3db8208a550daf5af81a5934' },
})
export const PYTHON_HOST_FILES = ['lib/selftest.mjs', 'lib/python-selftest.mjs', 'lib/python-probe.py', 'lib/index.js', 'lib/.fingerprint', 'web/host.js', 'web/index.html']
export const isRepairHostPath = (path) => path === 'kxxy-runtime.json' || PYTHON_HOST_FILES.some((name) => path === `lib/node_modules/kxxy-host/${name}`)
export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

function requireValue(ok, message) { if (!ok) throw new Error(message) }
function need(read, path) {
  const data = read(path)
  requireValue(Buffer.isBuffer(data) && data.length > 0, `Python 运行时缺少 ${path}`)
  return data
}

export function isManagedPythonPath(path) {
  if (path === PYTHON_LEDGER || path === PYTHON_SITE + CFFI_BACKEND) return true
  return ['cffi/', 'cffi-2.0.0.dist-info/', 'pycparser/', 'pycparser-2.23.dist-info/'].some((prefix) => path.startsWith(PYTHON_SITE + prefix))
}

/** ELF64 little-endian 的最小结构检查；不执行目标二进制。 */
export function inspectAndroidElf(data, label = 'ELF') {
  requireValue(data.length >= 64 && data.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
    data[4] === 2 && data[5] === 1 && data.readUInt16LE(18) === 183 && data.readUInt16LE(16) === 3, `${label} 不是 Android AArch64 ELF64 共享库`)
  const number = (offset) => {
    requireValue(offset + 8 <= data.length, `${label} ELF 结构截断`)
    const n = Number(data.readBigUInt64LE(offset))
    requireValue(Number.isSafeInteger(n), `${label} ELF 偏移溢出`)
    return n
  }
  const ph = number(32), width = data.readUInt16LE(54), count = data.readUInt16LE(56)
  requireValue(width >= 56 && count > 0 && ph + width * count <= data.length, `${label} ELF program headers 不合法`)
  const loads = [], dynamic = [], notes = []
  for (let i = 0; i < count; i += 1) {
    const p = ph + width * i
    const segment = { type: data.readUInt32LE(p), offset: number(p + 8), address: number(p + 16), size: number(p + 32), align: number(p + 48) }
    requireValue(segment.offset + segment.size <= data.length, `${label} ELF segment 越界`)
    if (segment.type === 1) loads.push(segment)
    if (segment.type === 2) dynamic.push(segment)
    if (segment.type === 4) notes.push(segment)
  }
  requireValue(loads.length && dynamic.length === 1, `${label} ELF 缺少加载/动态信息`)
  const dyn = new Map()
  for (let p = dynamic[0].offset; p + 16 <= dynamic[0].offset + dynamic[0].size; p += 16) {
    const tag = number(p), value = number(p + 8)
    if (!tag) break
    if (!dyn.has(tag)) dyn.set(tag, [])
    dyn.get(tag).push(value)
  }
  const straddr = dyn.get(5)?.[0], strlen = dyn.get(10)?.[0]
  const load = loads.find((s) => straddr >= s.address && straddr < s.address + s.size)
  requireValue(load && strlen > 0, `${label} ELF 动态字符串缺失`)
  const strbase = load.offset + straddr - load.address
  requireValue(strbase + strlen <= data.length, `${label} ELF 动态字符串越界`)
  const string = (off) => {
    const end = data.indexOf(0, strbase + off)
    requireValue(off < strlen && end >= strbase + off && end < strbase + strlen, `${label} ELF 字符串损坏`)
    return data.toString('utf8', strbase + off, end)
  }
  let api = null
  for (const segment of notes) {
    let p = segment.offset
    while (p + 12 <= segment.offset + segment.size) {
      const nl = data.readUInt32LE(p), dl = data.readUInt32LE(p + 4), type = data.readUInt32LE(p + 8)
      const name = p + 12, desc = name + ((nl + 3) & ~3), end = desc + ((dl + 3) & ~3)
      requireValue(end <= segment.offset + segment.size, `${label} ELF note 越界`)
      if (data.toString('ascii', name, name + nl).replace(/\0+$/, '') === 'Android' && type === 1 && dl >= 4) api = data.readUInt32LE(desc)
      p = end
    }
  }
  return { needed: (dyn.get(1) ?? []).map(string), runpath: [...(dyn.get(15) ?? []), ...(dyn.get(29) ?? [])].map(string), minApi: api, loadAlignments: loads.map((s) => s.align), machine: 183 }
}

function csvRows(text) {
  return text.trimEnd().split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = []; let value = '', quoted = false
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i]
      if (c === '"' && quoted && line[i + 1] === '"') { value += '"'; i += 1 }
      else if (c === '"') quoted = !quoted
      else if (c === ',' && !quoted) { fields.push(value); value = '' }
      else value += c
    }
    requireValue(!quoted, 'WHEEL RECORD 引号不闭合')
    fields.push(value)
    requireValue(fields.length === 3, 'WHEEL RECORD 必须三列')
    return fields
  })
}

export function verifyWheelRecord(files, distInfo) {
  const recordName = `${distInfo}/RECORD`
  const record = files.get(recordName)
  requireValue(record, `wheel 缺少 ${recordName}`)
  const seen = new Set()
  for (const [path, digest, size] of csvRows(record.toString('utf8'))) {
    validateZipPath(path)
    requireValue(!seen.has(path) && files.has(path), `RECORD 重复或不存在的条目：${path}`)
    seen.add(path)
    if (path === recordName) { requireValue(!digest && !size, 'RECORD 自身摘要必须为空'); continue }
    const data = files.get(path)
    const expected = `sha256=${createHash('sha256').update(data).digest('base64url')}`
    requireValue(digest === expected && /^\d+$/.test(size) && Number(size) === data.length, `RECORD 摘要/大小不符：${path}`)
  }
  requireValue(seen.size === files.size, 'wheel 存在未被 RECORD 覆盖的文件')
}

function validateNative(data) {
  const elf = inspectAndroidElf(data, CFFI_BACKEND)
  requireValue(elf.minApi === 24 && elf.loadAlignments.every((n) => n >= 16_384), 'CFFI 后端 API/16KiB 对齐不匹配')
  requireValue(!elf.runpath.length && elf.needed.includes('libpython3.14.so') && elf.needed.includes('libffi.so'), 'CFFI 后端链接目标或 RUNPATH 不正确')
  const allowed = new Set(['libpython3.14.so', 'libffi.so', 'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid-support.so'])
  requireValue(elf.needed.every((name) => allowed.has(name)), `CFFI 后端出现未知动态库：${elf.needed.join(', ')}`)
  requireValue(data.includes(Buffer.from('PyInit__cffi_backend\0')), 'CFFI 后端缺少 Python 初始化符号')
  return elf
}

function validatePinnedMetadata(files, name, version) {
  const dist = `${name}-${version}.dist-info`
  const metadata = files.get(`${dist}/METADATA`)?.toString('utf8') ?? ''
  requireValue(new RegExp(`^Name: ${name}$`, 'mi').test(metadata) && metadata.split(/\r?\n/).includes(`Version: ${version}`), `${name} 元数据名称/版本不匹配`)
  const requires = metadata.split(/\r?\n/).filter((line) => line.startsWith('Requires-Dist:'))
  if (name === 'cffi') requireValue(requires.length === 1 && /^Requires-Dist: pycparser(?:\s*;\s*implementation_name\s*!=\s*["']PyPy["'])?\s*$/.test(requires[0]), 'CFFI 依赖合同变化，需要重新核对依赖闭包')
  else requireValue(!requires.length, 'pycparser 增加了未装配的依赖')
  const wheel = files.get(`${dist}/WHEEL`)?.toString('utf8') ?? ''
  const tag = name === 'cffi' ? 'cp314-cp314-android_24_arm64_v8a' : 'py3-none-any'
  requireValue(wheel.split(/\r?\n/).includes(`Tag: ${tag}`), `${name} wheel 标签不匹配 ${tag}`)
  requireValue(files.has(`${name}/__init__.py`), `${name} 只有元数据，没有包文件`)
  verifyWheelRecord(files, dist)
}

/** 读取有来源和摘要的固定依赖，不接受“随便找个同名 .so”。 */
export function loadPythonDependencies(path) {
  const manifestBytes = readFileSync(path)
  const manifest = JSON.parse(manifestBytes)
  requireValue(manifest.schema === 1 && Object.entries(PYTHON_TARGET).every(([key, value]) => manifest.python?.[key] === value), 'Python 依赖构件目标不匹配')
  requireValue(Array.isArray(manifest.runtimeInputs) && manifest.runtimeInputs.length >= 4, 'Python 依赖构件缺少编译输入绑定')
  for (const name of ['include/python3.14/Python.h', 'include/python3.14/pyconfig.h', 'lib/libpython3.14.so', 'lib/libffi.so']) {
    requireValue(manifest.runtimeInputs.some((item) => item.path === name && /^[a-f0-9]{64}$/.test(item.sha256)), `缺少编译输入摘要：${name}`)
  }
  const files = new Map()
  for (const [name, pin] of Object.entries(PYTHON_SOURCES)) {
    const source = manifest.sources?.find((item) => item.name === name)
    requireValue(source?.version === pin.version && source.sha256 === pin.sha256 && new URL(source.url).hostname === 'files.pythonhosted.org', `${name} 不是固定官方源`)
    const wheel = manifest.wheels?.find((item) => item.name === name)
    requireValue(wheel?.version === pin.version && /^[a-f0-9]{64}$/.test(wheel.sha256) && !/[\\/:]/.test(wheel.filename), `${name} 构件清单不完整`)
    const filename = join(dirname(path), wheel.filename)
    requireValue(statSync(filename).size <= 16 * 1024 * 1024 && sha256(readFileSync(filename)) === wheel.sha256, `${name} wheel 摘要错误`)
    const archive = openIndexedZip(filename)
    const packageFiles = new Map()
    try {
      let bytes = 0
      for (const entry of archive.entries) {
        if (entry.name.endsWith('/')) continue
        const type = entry.mode & 0o170000
        requireValue(!entry.comment && (type === 0 || type === 0o100000), `wheel 不是普通文件：${entry.name}`)
        const allowed = entry.name.startsWith(`${name}/`) || entry.name.startsWith(`${name}-${pin.version}.dist-info/`) || name === 'cffi' && entry.name === CFFI_BACKEND
        requireValue(allowed, `wheel 包含未授权路径：${entry.name}`)
        bytes += entry.size
        requireValue(bytes <= 16 * 1024 * 1024, 'Python wheel 解压大小超过上限')
        packageFiles.set(entry.name, archive.read(entry.name, 16 * 1024 * 1024))
      }
    } finally { archive.close() }
    validatePinnedMetadata(packageFiles, name, pin.version)
    for (const [relative, data] of packageFiles) files.set(PYTHON_SITE + relative, { data, mode: 0o644 })
  }
  const native = need((p) => files.get(p)?.data, PYTHON_SITE + CFFI_BACKEND)
  const elf = validateNative(native)
  requireValue(sha256(native) === manifest.native?.sha256, 'CFFI 原生后端与构建清单不一致')
  const ledger = {
    schema: 1, revision: PYTHON_REVISION, python: PYTHON_TARGET,
    sources: manifest.sources, wheels: manifest.wheels, native: { ...elf, path: PYTHON_SITE + CFFI_BACKEND, sha256: sha256(native) },
    buildManifestSha256: sha256(manifestBytes), runtimeInputs: manifest.runtimeInputs,
    managedFiles: [...files].map(([path, file]) => ({ path, size: file.data.length, sha256: sha256(file.data), mode: file.mode })),
    platformWarnings: ['NumPy/psutil 的旧式 android_aarch64 WHEEL 标签保留；基础功能与标签告警分别由应用内自检判定。'],
    deviceVerified: false,
  }
  files.set(PYTHON_LEDGER, { data: jsonBytes(ledger), mode: 0o644 })
  return { files, manifest, ledger }
}

export function verifyPythonInputs(ledger, read) {
  for (const input of ledger.runtimeInputs) {
    validateZipPath(input.path)
    requireValue(sha256(need(read, input.path)) === input.sha256, `Python 构件的编译输入已变化，必须重新构建：${input.path}`)
  }
}

/** 只读结构验收。Android 代码没有在构建机执行，绝不把此结果写成真机通过。 */
export function verifyPythonRuntime(names, read) {
  const ledger = JSON.parse(need(read, PYTHON_LEDGER))
  requireValue(ledger.schema === 1 && ledger.revision === PYTHON_REVISION && Object.entries(PYTHON_TARGET).every(([key, value]) => ledger.python?.[key] === value), 'Python 运行时修复清单不匹配')
  verifyPythonInputs(ledger, read)
  requireValue(Array.isArray(ledger.managedFiles) && ledger.managedFiles.length > 20, 'Python 受管文件清单不完整')
  const managed = new Set()
  for (const file of ledger.managedFiles) {
    validateZipPath(file.path)
    requireValue(isManagedPythonPath(file.path) && file.path !== PYTHON_LEDGER && !managed.has(file.path), `Python 清单路径重复/越界：${file.path}`)
    const data = need(read, file.path)
    requireValue(data.length === file.size && sha256(data) === file.sha256, `Python 文件损坏：${file.path}`)
    managed.add(file.path)
  }
  for (const [name, pin] of Object.entries(PYTHON_SOURCES)) {
    const dist = `${name}-${pin.version}.dist-info/`
    const relevant = names.filter((path) => !path.endsWith('/') && (path.startsWith(PYTHON_SITE + name + '/') || path.startsWith(PYTHON_SITE + dist) || name === 'cffi' && path === PYTHON_SITE + CFFI_BACKEND))
    requireValue(relevant.every((path) => managed.has(path)), `Python 包存在未登记文件：${name}`)
    const files = new Map(relevant.map((path) => [path.slice(PYTHON_SITE.length), need(read, path)]))
    validatePinnedMetadata(files, name, pin.version)
    requireValue(!names.some((path) => path.startsWith(PYTHON_SITE + name + '-') && /\.dist-info\/METADATA$/.test(path) && path !== PYTHON_SITE + dist + 'METADATA'), `${name} 多个版本并存`)
  }
  const native = need(read, PYTHON_SITE + CFFI_BACKEND)
  const elf = validateNative(native)
  requireValue(sha256(native) === ledger.native?.sha256, '运行时 CFFI 后端摘要不符')
  const system = new Set(['libc.so', 'libm.so', 'libdl.so', 'liblog.so'])
  const seen = new Set()
  const libraries = [...elf.needed]
  while (libraries.length) {
    const name = libraries.pop()
    if (system.has(name) || seen.has(name)) continue
    requireValue(!name.includes('/'), `非法 DT_NEEDED：${name}`)
    seen.add(name)
    const dependency = inspectAndroidElf(need(read, `lib/${name}`), name)
    requireValue(dependency.minApi !== null && dependency.minApi <= 24, `${name} Android API 不匹配`)
    libraries.push(...dependency.needed)
  }
  const crypto = need(read, PYTHON_SITE + 'cryptography-50.0.2.dist-info/METADATA').toString('utf8')
  requireValue(/^Requires-Dist: cffi>=2\.0\.0\s*;\s*platform_python_implementation != 'PyPy'\r?$/m.test(crypto), 'cryptography 依赖合同变化，需重新核验')
  need(read, PYTHON_SITE + 'cryptography/hazmat/primitives/ciphers/aead.py')
  need(read, PYTHON_SITE + 'numpy/__init__.py')
  need(read, PYTHON_SITE + 'psutil/__init__.py')
  need(read, 'bin/python3')
  const warnings = []
  for (const [name, version] of [['numpy', '2.5.4'], ['psutil', '7.2.2']]) {
    const wheel = need(read, `${PYTHON_SITE}${name}-${version}.dist-info/WHEEL`).toString('utf8')
    if (/^Tag: .+-android_aarch64\r?$/m.test(wheel)) warnings.push(`${name} ${version}：保留旧平台标签；Android 基础功能需应用内自检`)
  }
  return { revision: ledger.revision, managedFiles: managed.size, native: elf, warnings, deviceVerified: false }
}

/** 小型 APK 资产；先写 payload，最后发布 manifest，安装器绑定其原始字节摘要。 */
export async function createPythonRepairAssets(directory, files, { baseHostFingerprint, hostFingerprint, previous = new Map() }) {
  requireValue(/^[a-f0-9]{64}$/.test(baseHostFingerprint) && /^[a-f0-9]{64}$/.test(hostFingerprint), 'Python 修复缺少宿主基线指纹')
  mkdirSync(directory, { recursive: true })
  const records = []
  let total = 0
  for (const [path, file] of files) {
    validateZipPath(path)
    const role = isManagedPythonPath(path) ? 'python' : 'host'
    requireValue(role === 'python' || isRepairHostPath(path), `Python 修复越界：${path}`)
    requireValue(Buffer.isBuffer(file.data) && [0o644, 0o755].includes(file.mode), `修复文件形态不支持：${path}`)
    total += file.data.length
    const record = { path, size: file.data.length, sha256: sha256(file.data), mode: file.mode, role }
    if (previous.has(path)) record.previousSha256 = sha256(previous.get(path))
    records.push(record)
  }
  requireValue(total <= 16 * 1024 * 1024, 'Python 修复包过大')
  const temp = join(directory, `payload-${process.pid}.zip`)
  await writeSmallZip(temp, files)
  const payload = readFileSync(temp)
  const manifest = {
    schema: 1, revision: PYTHON_REVISION, python: { majorMinor: PYTHON_TARGET.majorMinor, soabi: PYTHON_TARGET.soabi, minApi: 24 },
    payloadSha256: sha256(payload), payloadSize: payload.length, baseHostFingerprint, hostFingerprint,
    files: records.sort((a, b) => a.path < b.path ? -1 : 1),
  }
  const payloadPath = join(directory, 'payload.zip'), manifestPath = join(directory, 'manifest.json')
  if (existsSync(payloadPath)) { requireValue(statSync(payloadPath).isFile(), '修复包目标不是文件'); readFileSync(payloadPath) }
  if (existsSync(manifestPath)) JSON.parse(readFileSync(manifestPath, 'utf8'))
  renameSync(temp, payloadPath)
  const bytes = jsonBytes(manifest)
  writeFileSync(manifestPath, bytes)
  return { manifest, manifestSha256: sha256(bytes), size: payload.length }
}
