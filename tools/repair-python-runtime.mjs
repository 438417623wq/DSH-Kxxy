/**
 * 给现有 runtime 补 Python 依赖和自检，保留其他压缩记录及用户已完成的功能。
 * 用法：node tools/repair-python-runtime.mjs --in <runtime.zip> --out <new.zip>
 *       --python-deps <manifest.json> [--meta <build.json>] [--assets <python-repair>]
 * 只写本机构建产物，不连接设备、不执行下载归档中的安装脚本。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDirs } from './lib/assemble.mjs'
import { HOST_PLUGIN_BASE, HOST_MARK_LINE_RE, stampHostPluginFingerprint } from './lib/host-fingerprint.mjs'
import { openIndexedZip, patchZip, sha256File } from './lib/zipedit.mjs'
import {
  PYTHON_REVISION, PYTHON_HOST_FILES, loadPythonDependencies, verifyPythonInputs, verifyPythonRuntime,
  createPythonRepairAssets, jsonBytes, sha256,
} from './lib/python-runtime.mjs'

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function repairPythonRuntime({ input, output, dependencies, meta, assets, alias }) {
  if (existsSync(output)) throw new Error(`拒绝覆盖运行时：${output}`)
  const source = openIndexedZip(input)
  try {
    const originalManifest = source.read('kxxy-runtime.json')
    if (!originalManifest) throw new Error('源运行时没有 manifest')
    const manifest = JSON.parse(originalManifest)
    if (manifest.pythonRuntimeRevision) throw new Error('源运行时已带 Python 修复，请使用未修改的基线以保留迁移摘要')
    const originalMeta = JSON.parse(readFileSync(meta, 'utf8'))
    if (originalMeta.runtimeSize !== source.size || originalMeta.runtimeSha256 !== sha256File(input) || originalMeta.kxxyHostFingerprint !== manifest.plugins?.hostFingerprint) {
      throw new Error('APK metadata 与基线运行时不匹配')
    }
    const python = loadPythonDependencies(dependencies)
    verifyPythonInputs(python.ledger, source.readResolved)
    const replacements = new Map(python.files)
    const previous = new Map()
    for (const path of replacements.keys()) if (source.byName.has(path)) throw new Error(`基线已有受管 Python 文件，不覆盖：${path}`)
    const host = new Map(source.entries.filter((entry) => entry.name.startsWith(HOST_PLUGIN_BASE) && !entry.name.endsWith('/'))
      .map((entry) => [entry.name, { data: source.readResolved(entry.name), mode: entry.mode & 0o777 }]))
    const oldFingerprint = stampHostPluginFingerprint(host)
    if (oldFingerprint !== manifest.plugins.hostFingerprint) throw new Error('源宿主插件内容与声明指纹不符')
    for (const name of PYTHON_HOST_FILES.filter((name) => name !== 'lib/.fingerprint')) {
      const path = `${HOST_PLUGIN_BASE}${name}`
      const data = readFileSync(join(PROJECT, 'plugins', 'kxxy-host', name))
      if (name === 'lib/index.js') {
        const original = source.read(path).toString('utf8').replace(HOST_MARK_LINE_RE, '')
        if (original !== data.toString('utf8').replace(HOST_MARK_LINE_RE, '')) throw new Error('本次 Python 修复不能携带其他宿主入口改动')
      }
      host.set(path, { data, mode: 0o644 })
    }
    const hostFingerprint = stampHostPluginFingerprint(host)
    for (const name of PYTHON_HOST_FILES) {
      const path = `${HOST_PLUGIN_BASE}${name}`, file = host.get(path), old = source.read(path)
      if (old?.equals(file.data)) continue
      if (manifest.placeholderPaths?.includes(path)) throw new Error(`迁移文件包含设备占位符改写，不能直接用归档摘要：${path}`)
      replacements.set(path, file)
      if (old) previous.set(path, old)
    }
    const repairFiles = new Map(replacements)
    for (const path of collectDirs([...replacements.keys()].map((path) => ({ path })))) {
      if (!source.byName.has(`${path}/`)) replacements.set(`${path}/`, { data: Buffer.alloc(0), mode: 0o755 })
    }
    manifest.plugins = { ...manifest.plugins, hostFingerprint, hostMarker: `kxxy-host@${hostFingerprint.slice(0, 12)}` }
    manifest.pythonRuntimeRevision = PYTHON_REVISION
    manifest.builtAt = new Date().toISOString()
    const names = [...new Set([...source.byName.keys(), ...replacements.keys()])]
    manifest.entries = names.length
    manifest.directories = names.filter((name) => name.endsWith('/')).length
    const manifestFile = { data: jsonBytes(manifest), mode: 0o644 }
    replacements.set('kxxy-runtime.json', manifestFile)
    repairFiles.set('kxxy-runtime.json', manifestFile)
    previous.set('kxxy-runtime.json', originalManifest)
    const previewRead = (path) => replacements.get(path)?.data ?? source.readResolved(path)
    const check = verifyPythonRuntime(names, previewRead)
    // 同一 Python 内容用于 runtime 与小修复包；不允许两个来源各打一份。
    mkdirSync(dirname(output), { recursive: true })
    const repair = await createPythonRepairAssets(assets, repairFiles, { baseHostFingerprint: oldFingerprint, hostFingerprint, previous })
    const result = await patchZip(input, output, replacements)
    const final = openIndexedZip(output)
    try {
      verifyPythonRuntime(final.entries.map((entry) => entry.name), final.readResolved)
      for (const record of repair.manifest.files) {
        if (sha256(final.read(record.path)) !== record.sha256) throw new Error(`修复资产与最终 runtime 不一致：${record.path}`)
      }
      if (JSON.parse(final.read('kxxy-runtime.json')).entries !== final.entries.length) throw new Error('最终运行时条目计数不一致')
    } finally { final.close() }
    const aliasSource = alias ?? join(dirname(input), 'alias-links.txt')
    if (!existsSync(aliasSource)) throw new Error(`缺少别名清单：${aliasSource}`)
    copyFileSync(aliasSource, join(dirname(output), 'alias-links.txt'))
    const metadata = {
      ...originalMeta, generatedAt: new Date().toISOString(), runtimeSha256: result.sha256, runtimeSize: result.size,
      runtimeEntries: result.entries, runtimeUncompressedBytes: result.uncompressedBytes,
      kxxyHostFingerprint: hostFingerprint, kxxyHostMarker: `kxxy-host@${hostFingerprint.slice(0, 12)}`,
      pythonRuntimeRevision: PYTHON_REVISION, pythonRepairManifestSha256: repair.manifestSha256,
    }
    writeFileSync(meta, jsonBytes(metadata))
    if (resolve(meta) === join(PROJECT, 'android/app/src/main/assets/meta/build.json')) {
      const cacheMeta = join(PROJECT, '.cache/build-meta.json')
      if (existsSync(cacheMeta)) JSON.parse(readFileSync(cacheMeta, 'utf8'))
      writeFileSync(cacheMeta, jsonBytes(metadata))
    }
    const report = {
      schema: 1, input, output, dependencies, ...result, hostFingerprint, pythonRepairManifestSha256: repair.manifestSha256,
      repairPayloadBytes: repair.size, repairFiles: repair.manifest.files.length,
      python: check, deviceInstalled: false, deviceVerified: false,
    }
    writeFileSync(join(dirname(output), 'python-runtime-verification.json'), jsonBytes(report))
    return report
  } finally { source.close() }
}

function parseArgs(args) {
  const options = { meta: join(PROJECT, 'android/app/src/main/assets/meta/build.json') }
  const keys = { '--in': 'input', '--out': 'output', '--python-deps': 'dependencies', '--meta': 'meta', '--assets': 'assets', '--alias': 'alias' }
  for (let i = 0; i < args.length; i += 1) {
    const key = keys[args[i]]
    if (!key || !args[i + 1]) throw new Error(`参数不合法：${args[i]}`)
    options[key] = resolve(args[++i])
  }
  if (!options.input || !options.output || !options.dependencies) throw new Error('需要 --in、--out、--python-deps')
  options.assets ??= join(dirname(options.output), 'python-repair')
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await repairPythonRuntime(parseArgs(process.argv.slice(2))), null, 2))
}
