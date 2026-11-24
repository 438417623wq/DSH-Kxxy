/**
 * 同步 `assets/python-repair/` 与最终 runtime 的 `kxxy-runtime.json`。
 *
 * 背景：`restamp-codex-plugin.mjs` 增量重封时会改写 runtime 内的 `kxxy-runtime.json`
 * （`plugins.codexFingerprint` 与条目数 `entries`），而 python 离线修复包
 * `assets/python-repair/manifest.json` **逐字节**记录了同一份文件的 size/sha256。
 * 不同步这一处，`build-codex-apk.ps1` 里的 `verify-python-repair.mjs` 会以
 * 「修复文件与 runtime 字节不同：kxxy-runtime.json」拒绝出包。
 *
 * 这里只替换 payload 里那一个条目并重算摘要；其余修复文件（含迁移基线
 * `previousSha256`）原样保留 —— 它们与本轮改动无关，重写只会扩大风险面。
 *
 * 用法：
 *   node tools/sync-python-repair.mjs --runtime <runtime.zip>
 *        [--assets android/app/src/main/assets/python-repair] [--meta <build.json>]
 *   node tools/sync-python-repair.mjs --runtime <zip> --check-only
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openIndexedZip, patchZip } from './lib/zipedit.mjs'
import { jsonBytes, sha256 } from './lib/python-runtime.mjs'

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = 'kxxy-runtime.json'

function parseArgs(argv) {
  const opts = {
    runtime: null,
    assets: join(PROJECT, 'android', 'app', 'src', 'main', 'assets', 'python-repair'),
    meta: join(PROJECT, 'android', 'app', 'src', 'main', 'assets', 'meta', 'build.json'),
    checkOnly: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--runtime' || a === '--in') opts.runtime = resolve(argv[++i])
    else if (a === '--assets') opts.assets = resolve(argv[++i])
    else if (a === '--meta') opts.meta = resolve(argv[++i])
    else if (a === '--check-only') opts.checkOnly = true
    else if (a === '--help' || a === '-h') {
      console.log('用法：node tools/sync-python-repair.mjs --runtime <runtime.zip> [--assets <dir>] [--meta <build.json>] [--check-only]')
      process.exit(0)
    } else throw new Error(`未知参数：${a}`)
  }
  if (!opts.runtime) throw new Error('缺少 --runtime <runtime.zip>')
  return opts
}

export async function syncPythonRepair({ runtime, assets, meta, checkOnly = false }) {
  const archive = openIndexedZip(runtime)
  let rootBytes
  try {
    rootBytes = archive.read(TARGET)
  } finally {
    archive.close()
  }
  if (!rootBytes) throw new Error(`运行时缺少 ${TARGET}`)

  const manifestPath = join(assets, 'manifest.json')
  const payloadPath = join(assets, 'payload.zip')
  if (!existsSync(manifestPath) || !existsSync(payloadPath)) throw new Error(`Python 修复资产不完整：${assets}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const index = (manifest.files ?? []).findIndex((file) => file.path === TARGET)
  if (index < 0) return { changed: false, reason: `${TARGET} 不在修复清单里，无需同步` }

  const record = manifest.files[index]
  const nextSha = sha256(rootBytes)
  if (record.sha256 === nextSha && record.size === rootBytes.length) return { changed: false, reason: '修复清单与运行时一致' }
  if (checkOnly) return { changed: true, reason: `需要同步：${record.size}B/${record.sha256.slice(0, 12)} → ${rootBytes.length}B/${nextSha.slice(0, 12)}` }

  // patchZip 拒绝覆盖已有归档，也拒绝输入输出同一路径：先写临时名再换回去。
  const tmp = `${payloadPath}.sync-${process.pid}.zip`
  await patchZip(payloadPath, tmp, new Map([[TARGET, { data: rootBytes, mode: record.mode }]]))
  renameSync(tmp, payloadPath)

  manifest.files[index] = { ...record, size: rootBytes.length, sha256: nextSha }
  const payload = readFileSync(payloadPath)
  manifest.payloadSize = payload.length
  manifest.payloadSha256 = sha256(payload)
  const bytes = jsonBytes(manifest)
  writeFileSync(manifestPath, bytes)

  if (meta && existsSync(meta)) {
    const metadata = JSON.parse(readFileSync(meta, 'utf8'))
    metadata.pythonRepairManifestSha256 = sha256(bytes)
    writeFileSync(meta, jsonBytes(metadata))
  }
  return { changed: true, reason: `已同步 ${TARGET}，payload ${payload.length}B，manifest ${sha256(bytes).slice(0, 12)}` }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2))
  const result = await syncPythonRepair(opts)
  console.log(result.reason)
  if (!opts.checkOnly && result.changed) console.log('下一步：node tools/verify-python-repair.mjs <runtime.zip> <python-repair> <build.json>')
}
