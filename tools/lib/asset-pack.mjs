/**
 * 扩展池的第三种来源：**随包发的整块资产**（asset）。
 *
 * 前两种是 deb（Termux 索引求闭包，`tools/lib/poolextract.py`）与 npm
 * （`tools/lib/npm-pack.mjs`）。这两种都建立在「上游按包分发、我们解包重排」
 * 之上，而 `glibc` 扩展要带的东西根本不在那个世界里：
 *
 *   · proot 本体 —— 已在预装闭包里（`<root>/bin/proot` + `libexec/proot/loader`），
 *     不需要再发；
 *   · **glibc 用户态** —— 一份 Ubuntu base 的 rootfs，只有一个 30 MB 的
 *     `.tar.gz`，没有 deb 索引、没有依赖图，也不该被解开重排（见下）。
 *
 * ── 为什么不把 rootfs 解成文件树放进池 ─────────────────────────────────
 *
 * 设备端的池解包器是 `plugins/kxxy-host/lib/tar.mjs`，它对符号链接的策略是
 * **跳过并记账**（扩展池里的软链一律由构建期物化成实体副本）。rootfs 里那
 * 194 条软链（`/bin -> usr/bin`、`/lib -> usr/lib`、`/usr/bin/awk -> mawk`）
 * 一旦被物化成副本，`/lib/aarch64-linux-gnu/libc.so.6` 与
 * `/usr/lib/aarch64-linux-gnu/libc.so.6` 就成了两份互不相干的文件 ——
 * apt 换 glibc 时会撕裂，ld.so 缓存也会指错。
 *
 * 所以这里把 rootfs 当**不透明 blob**放进池（`rootfs/ubuntu-base.tgz` 一条
 * 普通文件），由 `bin/kxxy-glibc` 在首次运行时用设备上的 GNU tar 解开 ——
 * 软链、权限位、目录顺序全部交给 tar，构建期不碰。
 *
 * ── 唯一的构建期改写：去掉硬链 ──────────────────────────────────────────
 *
 * 应用域建不出硬链接（`link(2)` → EACCES，v0.9.72 已定性），归档里带硬链
 * 条目就等于「解到那儿必失败」。Ubuntu base 里有两条（`perl5.38.2`、
 * `uncompress`），由 `tools/lib/tarderef.py` 改写成独立副本 —— 产物零硬链，
 * 设备端 `tar -xzf` 不需要任何扩展选项。
 *
 * ── 产物形态 ────────────────────────────────────────────────────────────
 *
 * 与另两种来源逐字节同构，extinstall 不需要新分支：
 *
 *   <id>.pool                  tar.gz，路径相对扩展目录
 *   bin/<cmd>                  包装器（含 @DSH_ROOT@ 等占位符，装完回填）
 *   bin/<tool>                 工具垫片：同一个 `glibc-tool.sh` 模板按 `tools[]` 渲染
 *   rootfs/<name>.tgz          整块资产
 *   .pool-manifest.json        列出待回填的文本文件（包装器与垫片）
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { downloadTo } from './registry.mjs'
import { tarGzSync } from '../../plugins/kxxy-host/lib/tar.mjs'

/** 池条目的 `source` 值；deb 池没有这个字段。 */
export const ASSET_SOURCE = 'asset'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 包装器模板目录（构建期源文件，不进产物）。 */
const WRAPPER_DIR = join(HERE, '..', 'prebuilt', 'wrappers')

function log(msg) {
  console.log(`      ${msg}`)
}

function human(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * 找一个可用的 Python 解释器。
 *
 * `tarderef.py` 与 `poolextract.py` 共用这套候选：本机常有「装了 Python 但不在
 * PATH」的情况（Windows 商店版/自定义安装），逐个探测比让用户配环境变量省事。
 * `KXXY_PYTHON` 始终最高优先。
 */
export function findPython() {
  const candidates = [
    process.env.KXXY_PYTHON,
    'python',
    'python3',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python312', 'python.exe'),
    'C:\\Python312\\python.exe',
  ].filter(Boolean)
  for (const cand of candidates) {
    const probe = spawnSync(cand, ['--version'], { stdio: 'ignore' })
    if (probe.status === 0 || !probe.error) return cand
  }
  return null
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 资产在本地缓存里的落点（`from` 相对项目根）。 */
export function assetLocalPath(project, asset) {
  return resolve(project, asset.from)
}

/**
 * 确保资产文件在位并通过摘要校验。缺了就按 `url` 下，下错就删掉重来。
 */
async function ensureAsset(project, asset) {
  const dest = assetLocalPath(project, asset)
  if (existsSync(dest) && statSync(dest).size > 0) {
    if (asset.sha256) {
      const got = sha256File(dest)
      if (got !== asset.sha256) {
        log(`${basename(dest)} 摘要不符（${got.slice(0, 12)}…），重新下载`)
        writeFileSync(dest, Buffer.alloc(0))
      }
    }
  }
  if (!existsSync(dest) || statSync(dest).size === 0) {
    if (!asset.url) throw new Error(`${asset.from} 不存在且条目没有 url，无法获取`)
    log(`下载 ${basename(dest)} ← ${asset.url}`)
    mkdirSync(dirname(dest), { recursive: true })
    await downloadTo(asset.url, dest)
  }
  if (asset.sha256) {
    const got = sha256File(dest)
    if (got !== asset.sha256) {
      throw new Error(
        `${basename(dest)} 摘要不符：期望 ${asset.sha256}，实际 ${got}。` +
        '（上游换了文件？更新 seeds.mjs 里的 sha256 后再构建。）',
      )
    }
  }
  return dest
}

/**
 * 去硬链改写（带缓存）。
 *
 * 缓存按「源文件 sha256 前 12 位」命名：源没换就复用上一轮的产物，
 * 换过就自然落到新文件名，不需要「先删再写」。
 */
function derefArchive(py, src) {
  const stamp = sha256File(src).slice(0, 12)
  const out = join(dirname(src), `${basename(src, '.tar.gz')}.deref-${stamp}.tgz`)
  if (existsSync(out) && statSync(out).size > 0) {
    return out
  }
  const run = spawnSync(py, [join(HERE, 'tarderef.py'), src, out], {
    encoding: 'utf8',
  })
  if (run.error) throw new Error(`无法启动 Python（${py}）：${run.error.message}`)
  if (run.status !== 0) {
    throw new Error(`tarderef.py 退出码 ${run.status}：${(run.stderr || '').trim()}`)
  }
  let stats = {}
  try {
    stats = JSON.parse((run.stdout || '').trim().split('\n').pop())
  } catch {
    // 统计只用于日志，解析不出来不影响产物
  }
  log(
    `去硬链：${basename(src)} → ${basename(out)}（硬链改写 ${stats.hardlinks ?? '?'} 条，` +
    `符号链接保留 ${stats.symlinks ?? '?'} 条）`,
  )
  return out
}

/** 生成包装器内容：替换扩展 id（安装路径 `extensions/<id>` 只有构建期知道）。 */
function wrapperBody(name, extId) {
  const tpl = join(WRAPPER_DIR, `${name}.sh`)
  if (!existsSync(tpl)) throw new Error(`缺包装器模板：${tpl}`)
  return readFileSync(tpl, 'utf8').split('__EXT_ID__').join(extId)
}

/**
 * 生成「工具垫片」：`glibc-tool.sh` 这一个模板 + 条目里的 `tools[]` 描述，
 * 产出 `bin/<name>`。不用每个工具抄一份脚本 —— 以后加工具只改 seeds 表。
 *
 * 取代的 token 必须**全部**出现，否则模板写错会静默产出半成品垫片
 * （比如 `EXE=` 空着，运行时报一个莫名其妙的 127）。
 */
function toolBody(tool, extId, templateName = 'glibc-tool') {
  const tpl = join(WRAPPER_DIR, `${templateName}.sh`)
  if (!existsSync(tpl)) throw new Error(`缺垫片模板：${tpl}`)
  const fields = {
    __EXT_ID__: extId,
    __NAME__: tool.name,
    __LABEL__: tool.label ?? tool.name,
    __EXE__: tool.exe,
    __GROUP__: tool.group ?? tool.name,
    __HINT__: tool.hint ?? '首次要下载',
  }
  let body = readFileSync(tpl, 'utf8')
  for (const [token, value] of Object.entries(fields)) {
    if (!value) throw new Error(`${extId}.${tool.name}: 垫片字段 ${token} 为空`)
    body = body.split(token).join(value)
  }
  const left = body.match(/__[A-Z_]+__/g)
  if (left) {
    throw new Error(`${extId}.${tool.name}: 垫片模板还有未替换的 token ${[...new Set(left)].join(', ')}`)
  }
  return body
}

/**
 * 构建一个 asset 源池条目。
 *
 * @param {object} item `POOL_ITEMS` 里的条目（`source: 'asset'`）
 * @param {{outDir: string, project: string}} opts
 * @returns {Promise<{id: string, version: string, files: number, totalBytes: number, assets: string[]}>}
 */
export async function buildAssetPack(item, opts) {
  const { outDir, project } = opts
  const assets = item.assets ?? []
  if (!assets.length) throw new Error(`${item.id}: assets 为空`)

  const py = assets.some((a) => a.dereference) ? findPython() : null
  if (assets.some((a) => a.dereference) && py === null) {
    throw new Error(`${item.id}: 需要 Python 去掉硬链（tarderef.py），但找不到解释器`)
  }

  const entries = []
  const packed = []
  for (const asset of assets) {
    const local = await ensureAsset(project, asset)
    const blob = asset.dereference ? derefArchive(py, local) : local
    const data = readFileSync(blob)
    entries.push({ name: asset.to, data, mode: 0o644, mtimeSec: 0 })
    packed.push(asset.to)
    log(`${item.id}: ${asset.to} ← ${human(data.length)}`)
  }

  // ── 包装器 ──────────────────────────────────────────────────────────
  const wrapperNames = item.wrappers ?? []
  if (!wrapperNames.length) throw new Error(`${item.id}: wrappers 为空`)
  for (const name of wrapperNames) {
    const body = wrapperBody(name, item.id)
    entries.push({ name: `bin/${name}`, data: Buffer.from(body, 'utf8'), mode: 0o755, mtimeSec: 0 })
    log(`${item.id}: bin/${name}（${human(Buffer.byteLength(body))}）`)
  }

  // ── 工具垫片：同一个模板按 tools[] 逐个渲染 ─────────────────────────
  const tools = item.tools ?? []
  for (const tool of tools) {
    const body = toolBody(tool, item.id, item.toolTemplate)
    entries.push({ name: `bin/${tool.name}`, data: Buffer.from(body, 'utf8'), mode: 0o755, mtimeSec: 0 })
    log(`${item.id}: bin/${tool.name} → ${tool.exe}（${tool.group ?? tool.name}）`)
  }

  // 声明的命令必须都产出了（与 npm 源同一道校验，避免「卡片说有、装完没有」）
  const produced = new Set([...wrapperNames, ...tools.map((t) => t.name)])
  const missing = (item.bins ?? []).filter((b) => !produced.has(b))
  if (missing.length) {
    throw new Error(`${item.id}: 缺命令 ${missing.join(', ')}（实际产出 ${[...produced].join(', ')}）`)
  }

  const manifest = {
    extId: item.id,
    placeholders: {
      '@DSH_ROOT@': 'root',
      '@DSH_HOME@': 'home',
      '@DSH_TMP@': 'tmp',
      '@DSH_FILES@': 'files',
      '@DSH_DATA@': 'data',
    },
    files: [...wrapperNames, ...tools.map((t) => t.name)].map((n) => `bin/${n}`),
  }
  entries.push({
    name: '.pool-manifest.json',
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    mode: 0o644,
    mtimeSec: 0,
  })

  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${item.id}.pool`)
  writeFileSync(outPath, tarGzSync(entries))

  const totalBytes = entries.reduce((n, f) => n + f.data.length, 0)
  log(
    `${item.id}: ${wrapperNames.length} 个命令 · ${entries.length} 条目 · ${human(totalBytes)} ` +
    `→ ${basename(outPath)}`,
  )

  return {
    id: item.id,
    version: item.version ?? 'asset',
    files: entries.length,
    totalBytes,
    assets: packed,
  }
}
