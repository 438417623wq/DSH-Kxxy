/** 核对 APK 外置小补丁与 runtime 的逐字节合同，不执行 Android Python。 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openIndexedZip } from './lib/zipedit.mjs'
import { PYTHON_REVISION, verifyPythonRuntime, isManagedPythonPath, isRepairHostPath, sha256 } from './lib/python-runtime.mjs'

export function verifyPythonRepair({ runtime, manifestBytes, payloadBytes, meta, expectedSource }) {
  if (sha256(manifestBytes) !== meta.pythonRepairManifestSha256) throw new Error('Python repair manifest 与 APK meta 摘要不符')
  const manifest = JSON.parse(manifestBytes)
  if (manifest.schema !== 1 || manifest.revision !== PYTHON_REVISION || meta.pythonRuntimeRevision !== manifest.revision ||
      manifest.hostFingerprint !== meta.kxxyHostFingerprint || sha256(payloadBytes) !== manifest.payloadSha256 || payloadBytes.length !== manifest.payloadSize) {
    throw new Error('Python repair revision、宿主指纹或 payload 不符')
  }
  const z = openIndexedZip(runtime)
  try {
    const root = JSON.parse(z.read('kxxy-runtime.json'))
    if (root.pythonRuntimeRevision !== manifest.revision || root.plugins.hostFingerprint !== manifest.hostFingerprint || root.entries !== z.entries.length) throw new Error('runtime 根清单与修复合同不一致')
    const result = verifyPythonRuntime([...z.byName.keys()], z.readResolved)
    const seen = new Set()
    for (const file of manifest.files) {
      if (seen.has(file.path) || !(file.role === 'python' ? isManagedPythonPath(file.path) : file.role === 'host' && isRepairHostPath(file.path))) throw new Error(`修复路径重复/越界：${file.path}`)
      seen.add(file.path)
      const data = z.read(file.path)
      if (!data || data.length !== file.size || sha256(data) !== file.sha256) throw new Error(`修复文件与 runtime 字节不同：${file.path}`)
      if (expectedSource && file.previousSha256 && sha256(expectedSource.read(file.path)) !== file.previousSha256) throw new Error(`迁移基线摘要不符：${file.path}`)
    }
    return { ...result, repairFiles: seen.size, payloadSize: payloadBytes.length, deviceVerified: false }
  } finally { z.close() }
}

/**
 * 设备端只用「结构白名单」判定上一版根清单能否被覆盖（见 PythonRuntimeRepair.supersededManifest）。
 * 出包时就把两边对齐：schemaVersion 与顶层/plugins 字段集合必须完全覆盖运行时根清单，
 * 否则用户升级时会被 fail-closed 挡在启动前。
 */
export function verifyManifestSchemaContract(kotlinSource, root) {
  const schema = Number(/MANIFEST_SCHEMA = (\d+)L/.exec(kotlinSource)?.[1])
  if (!Number.isInteger(schema)) throw new Error('无法从 PythonRuntimeRepair.kt 读取 MANIFEST_SCHEMA')
  if (schema !== root.schemaVersion) throw new Error(`MANIFEST_SCHEMA(${schema}) 与运行时根清单 schemaVersion(${root.schemaVersion}) 不一致`)
  const allow = (name) => {
    const body = new RegExp(`${name} = setOf\\(([\\s\\S]*?)\\)`).exec(kotlinSource)
    if (!body) throw new Error(`无法从 PythonRuntimeRepair.kt 读取 ${name}`)
    return new Set([...body[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]))
  }
  const keys = allow('MANIFEST_KEYS'), pluginKeys = allow('MANIFEST_PLUGIN_KEYS')
  for (const key of Object.keys(root)) if (!keys.has(key)) throw new Error(`根清单字段 ${key} 未进入 MANIFEST_KEYS，升级会被判成用户冲突`)
  for (const key of Object.keys(root.plugins ?? {})) if (!pluginKeys.has(key)) throw new Error(`根清单 plugins.${key} 未进入 MANIFEST_PLUGIN_KEYS，升级会被判成用户冲突`)
  return { schema, allowed: keys.size, allowedPlugins: pluginKeys.size }
}

// payload.zip 本身的中央目录/CRC/逐条内容也必须校验；外层 SHA 正确不是对生成器的信任。
export function verifyPayload(path, manifestBytes) {
  const manifest = JSON.parse(manifestBytes)
  const payload = openIndexedZip(path)
  try {
    if (payload.entries.length !== manifest.files.length) throw new Error('Python payload 条目数量不符')
    for (const file of manifest.files) {
      const entry = payload.byName.get(file.path)
      if (!entry || entry.comment || (entry.mode & 0o170000) !== 0o100000 || (entry.mode & 0o777) !== file.mode ||
          entry.size !== file.size || sha256(payload.read(file.path)) !== file.sha256) throw new Error(`Python payload 条目不符：${file.path}`)
    }
  } finally { payload.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtime, assets, metaPath] = process.argv.slice(2)
  if (!runtime || !assets || !metaPath) throw new Error('用法：node tools/verify-python-repair.mjs <runtime.zip> <python-repair目录> <build.json>')
  const manifestBytes = readFileSync(`${assets}/manifest.json`), payloadPath = `${assets}/payload.zip`
  verifyPayload(payloadPath, manifestBytes)
  const rootZip = openIndexedZip(runtime)
  const rootManifest = JSON.parse(rootZip.read('kxxy-runtime.json'))
  rootZip.close()
  const kotlin = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../android/app/src/main/java/app/kxxy/engine/PythonRuntimeRepair.kt'), 'utf8')
  const contract = verifyManifestSchemaContract(kotlin, rootManifest)
  console.log(JSON.stringify({ ...verifyPythonRepair({ runtime, manifestBytes, payloadBytes: readFileSync(payloadPath), meta: JSON.parse(readFileSync(metaPath, 'utf8')) }), manifestSchemaContract: contract }, null, 2))
}
