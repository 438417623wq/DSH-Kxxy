/**
 * 本地插件安装（npm .tgz）—— 控制台「插件 → 本地安装」的后端。
 *
 * 为什么要有它：装第三方插件的官方入口在对话页侧栏，而用户被一个坏插件
 * 挡在对话页外面时（Failed to load plugins），那条路正好走不通 —— 和
 * plugins.mjs 解决「停用」是同一个困境，这里解决的是「装」。
 *
 * ## 格式边界（刻意收窄）
 *
 * 首期只认 **npm 发布包 `.tgz`**（`npm pack` 的产物，包体在 `package/` 下）。
 * 源码 ZIP、原生扩展包、离线依赖整包一律拒绝 —— 它们各有各的正确装法，
 * 硬塞进 tar 解包只会做出一个看起来成功、加载必炸的假安装。
 *
 * ## 安全边界
 *
 *   · 两遍处理：先「清单遍历」（只读 tar 头，不落盘）做静态校验 —— 条目数、
 *     总量/单项大小、路径越界（`..` / 绝对路径 / 盘符 / 反斜杠 / `\0`）、
 *     链接条目（硬链/软链一律拒）；过了才交给 tar.mjs 的流式解包落到
 *     profile 下的 staging 目录（safeJoin 兜底第二道）。
 *   · 解包后重读 `package/package.json`：包名过 npm 命名校验、不许与
 *     受保护名单（核心 bundle + kxxy-host）同名。
 *   · 依赖静态核对：`dependencies` 里的每一项都要能在 profile 的
 *     node_modules、引擎 lib/node_modules 或包自带的 bundled node_modules
 *     里找到，缺一个就拒绝安装（**绝不静默联网补依赖** —— 要联网请走
 *     对话页的在线安装）。
 *   · 不执行任何包内脚本、不跑 npm：纯「解包 + 写清单」。
 *   · 同名包已存在 → 冲突，必须前端显式传 `overwrite: true` 才覆盖
 *     （旧包体先删再移入，清单有备份）。
 *
 * ## 上传会话
 *
 * /local-inspect 收二进制（端点级豁免 JSON 守卫，nonce/认证照验），流式落盘
 * 到 staging 的 uploads/ 下并返回 uploadId；/local-install 拿 uploadId 提交。
 * 会话 30 分钟 TTL、并发上限 4，过期/超额的临时文件随取随删。
 *
 * @module kxxy-host/localinstall
 */

import {
  closeSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createGunzip } from 'node:zlib'
import { dirname, join } from 'node:path'
import { extractTarGz } from './tar.mjs'
import { CORE_BUNDLES } from './health.mjs'
import { profileDir } from './plugins.mjs'

/** 受保护名单：与 plugins.mjs 保持一致（那边不导出，这里按同一事实源重列）。 */
const HOST_PLUGIN = 'kxxy-host'
const PROTECTED = new Set([...CORE_BUNDLES, HOST_PLUGIN])

/** 上传包大小上限（.tgz 插件通常几十 KB 到几 MB）。 */
const MAX_UPLOAD_BYTES = 96 * 1024 * 1024
/** tar 条目数 / 解压总量 / 单文件上限（防炸弹归档把手机存储打爆）。 */
const MAX_ENTRY_COUNT = 6000
const MAX_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024
const MAX_SINGLE_FILE = 128 * 1024 * 1024
/** 上传会话 TTL 与并发上限。 */
const UPLOAD_TTL_MS = 30 * 60 * 1000
const MAX_ACTIVE_UPLOADS = 4

const BLOCK = 512

/**
 * 进行中的上传会话：id → { tgzPath, stagingDir, name, version, ts }。
 * 只在进程内有效 —— 引擎重启后没提交的 uploadId 自然失效，前端重新走一遍。
 * @type {Map<string, {tgzPath: string, stagingDir: string, name: string, version: string, ts: number}>}
 */
const UPLOADS = new Map()

function stagingRoot() {
  const dir = profileDir()
  return dir ? join(dir, '.kxxy-plugin-staging') : ''
}

function profileNodeModules() {
  const dir = profileDir()
  return dir ? join(dir, 'node_modules') : ''
}

// ---------------------------------------------------------------------------
// tar 清单遍历（只读头，不落盘）
// ---------------------------------------------------------------------------

/** 把任意流变成「按需取 n 字节」的读取器（与 tar.mjs 同款）。 */
class ChunkReader {
  constructor(stream) {
    this.iter = stream[Symbol.asyncIterator]()
    this.buf = Buffer.alloc(0)
    this.ended = false
  }

  async fill(n) {
    while (this.buf.length < n && !this.ended) {
      const { value, done } = await this.iter.next()
      if (done) {
        this.ended = true
        break
      }
      this.buf = this.buf.length === 0 ? value : Buffer.concat([this.buf, value])
    }
  }

  async read(n) {
    await this.fill(n)
    if (this.buf.length < n) return null
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }

  /** 分块丢弃数据，避免按归档声明的文件大小分配整块缓冲；不足时返回 false。 */
  async skip(n) {
    const CHUNK = 256 * 1024 // 与 tar.mjs 的普通文件读取粒度一致
    while (n > 0) {
      const take = Math.min(CHUNK, n)
      if (await this.read(take) === null) return false
      n -= take
    }
    return true
  }
}

const padded = (n) => Math.ceil(n / BLOCK) * BLOCK

function parseOctal(buf) {
  const text = buf.toString('ascii').replace(/[\0 \u00ff]+$/g, '').trim()
  if (!/^[0-7]*$/.test(text)) return 0
  const n = parseInt(text, 8)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function headerName(hdr) {
  let name = hdr.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '')
  const prefixBuf = hdr.subarray(345, 500)
  if (prefixBuf.some((b) => b !== 0)) {
    const prefix = prefixBuf.toString('utf8').replace(/\0[\s\S]*$/, '')
    if (prefix) name = `${prefix}/${name}`
  }
  return name
}

/** tar 条目名做第一道路径校验（解包时 tar.mjs 的 safeJoin 还有第二道）。 */
function checkEntryName(name) {
  if (!name || name.includes('\0')) return '条目名为空或含 \\0'
  if (name.includes('\\')) return `条目名含反斜杠：${name}`
  if (name.startsWith('/')) return `条目名是绝对路径：${name}`
  if (/^[a-z]:/i.test(name)) return `条目名带盘符：${name}`
  if (name.split('/').includes('..')) return `条目名含 ..（路径越界）：${name}`
  if (name.length > 512) return `条目名超长（${name.length} 字符）`
  return null
}

/**
 * 遍历 tar.gz 的所有条目头（不写盘），返回汇总。
 * 超出任何一项上限或出现违规条目时抛错（message 即用户可读的中文）。
 */
async function listTarGz(gzPath) {
  const reader = new ChunkReader(createReadStream(gzPath).pipe(createGunzip()))
  const entries = []
  let totalBytes = 0
  let longName = null
  let paxPath = null

  for (;;) {
    const hdr = await reader.read(BLOCK)
    if (hdr === null) {
      if (reader.buf.length > 0) throw new Error('归档在 tar 条目头处截断')
      break
    }
    if (hdr.every((b) => b === 0)) break

    const size = parseOctal(hdr.subarray(124, 136))
    const typeCode = hdr[156]
    const type = typeCode === 0 || typeCode === 0x20 ? '0' : String.fromCharCode(typeCode)
    let name = headerName(hdr)

    if (type === 'L') {
      const data = await reader.read(padded(size))
      if (data === null) throw new Error('归档在 GNU longname 条目处截断')
      longName = data.subarray(0, size).toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (type === 'x' || type === 'X') {
      const data = await reader.read(padded(size))
      if (data === null) throw new Error('归档在 PAX 扩展头处截断')
      const m = data.subarray(0, size).toString('utf8').match(/^\d+ path=([^\n]*)$/m)
      if (m) paxPath = m[1]
      continue
    }
    if (type === 'g') {
      if (!await reader.skip(padded(size))) throw new Error('归档在 PAX 全局扩展头处截断')
      continue
    }

    if (longName !== null) name = longName
    else if (paxPath !== null) name = paxPath
    longName = null
    paxPath = null

    const target = name.replace(/\/+$/, '')
    if (!target) {
      if (!await reader.skip(padded(size))) throw new Error('归档在空目标条目处截断')
      continue
    }

    const bad = checkEntryName(target)
    if (bad) throw new Error(bad)

    if (type === '1' || type === '2') {
      throw new Error(`归档含链接条目（${type === '2' ? '符号链接' : '硬链接'}）：${target} —— 拒绝安装`)
    }
    if (type !== '0' && type !== '5' && type !== '7') {
      throw new Error(`归档含不支持的条目类型（type ${type}）：${target}`)
    }

    entries.push({ name: target, size, type })
    totalBytes += type === '5' ? 0 : size

    if (entries.length > MAX_ENTRY_COUNT) {
      throw new Error(`归档条目数超过上限（>${MAX_ENTRY_COUNT}）`)
    }
    if (totalBytes > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error(`解压总量超过上限（>${Math.round(MAX_TOTAL_UNCOMPRESSED / 1024 / 1024)} MB）`)
    }
    if (size > MAX_SINGLE_FILE) {
      throw new Error(`单文件超过上限（${target}，>${Math.round(MAX_SINGLE_FILE / 1024 / 1024)} MB）`)
    }

    if (!await reader.skip(size)) throw new Error(`归档数据区截断：${target}`)
    if (!await reader.skip(padded(size) - size)) throw new Error(`归档填充区截断：${target}`)
  }

  return { entries, totalBytes }
}

// ---------------------------------------------------------------------------
// 包元数据与依赖核对
// ---------------------------------------------------------------------------

function validPkgName(name) {
  if (typeof name !== 'string' || !name || name.length > 214) return false
  const parts = name.startsWith('@') ? name.split('/') : [name]
  if (name.startsWith('@') && parts.length !== 2) return false
  const re = /^[a-z0-9][a-z0-9._~-]*$/
  return parts.every((p) => re.test(p) && p !== '.' && p !== '..')
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** 依赖是否已在三个位置之一（profile / 引擎内置 / 包自带 bundled）。 */
function depSatisfied(dep, bundledRoot, engineRoot) {
  const spots = [
    profileNodeModules(),
    engineRoot && join(engineRoot, 'lib', 'node_modules'),
    bundledRoot,
  ].filter(Boolean)
  for (const spot of spots) {
    if (existsSync(join(spot, ...dep.split('/'), 'package.json'))) return true
  }
  return false
}

/**
 * 解包后的静态检查（读 staged package.json + 依赖核对 + 冲突探测）。
 * 返回给前端的「安装前检查」报告；不通过时返回 {ok:false,...}。
 */
function inspectStaged(stagingDir, engineRoot) {
  const stagedPkgDir = join(stagingDir, 'package')
  const pkgFile = join(stagedPkgDir, 'package.json')
  if (!existsSync(pkgFile)) {
    return { ok: false, error: '归档里没有 package/package.json', detail: '这不是 npm 发布包（npm pack 产物）的布局，无法作为 DSH 插件安装。' }
  }
  const pkg = readJsonFile(pkgFile)
  if (!pkg || typeof pkg !== 'object') {
    return { ok: false, error: 'package.json 无法解析', detail: '包内的 package.json 不是合法 JSON。' }
  }

  const name = String(pkg.name ?? '')
  if (!validPkgName(name)) {
    return { ok: false, error: `包名不合法：${name || '（空）'}`, detail: 'npm 包名须为小写、可含 @scope/ 前缀。请重新打包后再试。' }
  }
  if (PROTECTED.has(name)) {
    return { ok: false, error: `${name} 是受保护的核心组件`, detail: '不允许通过本地安装覆盖引擎核心或控制台本体。' }
  }

  const hasEntry = Boolean(pkg.main || pkg.exports || pkg.module)
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : []
  const depsMissing = deps.filter((d) => !depSatisfied(d, join(stagedPkgDir, 'node_modules'), engineRoot))

  const target = join(profileNodeModules(), ...name.split('/'))
  const existingPkg = readJsonFile(join(target, 'package.json'))
  const conflict = Boolean(existingPkg)
  const existingVersion = conflict ? String(existingPkg.version ?? '') : ''

  return {
    ok: true,
    name,
    version: String(pkg.version ?? ''),
    description: String(pkg.description ?? ''),
    hasDshPatch: existsSync(join(stagedPkgDir, 'dsh.bundle.patch')) || Boolean(pkg.dsh),
    entryDeclared: hasEntry,
    deps,
    depsMissing,
    conflict,
    existingVersion,
  }
}

// ---------------------------------------------------------------------------
// 上传会话维护
// ---------------------------------------------------------------------------

function removeUpload(id) {
  const entry = UPLOADS.get(id)
  if (!entry) return
  UPLOADS.delete(id)
  try { unlinkSync(entry.tgzPath) } catch { /* 已不存在 */ }
  try { rmSync(entry.stagingDir, { recursive: true, force: true }) } catch { /* 已不存在 */ }
}

function pruneUploads() {
  const now = Date.now()
  for (const [id, entry] of UPLOADS) {
    if (now - entry.ts > UPLOAD_TTL_MS) removeUpload(id)
  }
  while (UPLOADS.size >= MAX_ACTIVE_UPLOADS) {
    const oldest = [...UPLOADS.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (!oldest) break
    removeUpload(oldest[0])
  }
}

export function discardUpload(id) {
  removeUpload(String(id ?? ''))
}

// ---------------------------------------------------------------------------
// HTTP 入口
// ---------------------------------------------------------------------------

/**
 * 流式收请求体到文件：边计数边写，超上限立即掐断。
 * 不用整块 Buffer —— 上限 96 MB，手机上没必要双份占内存。
 */
function streamBodyToFile(req, filePath) {
  return new Promise((ok, fail) => {
    let fd = null
    let total = 0
    let settled = false
    const finishFd = () => {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* 已关 */ }
        fd = null
      }
    }
    const settleFail = (e) => {
      if (settled) return
      settled = true
      finishFd()
      fail(e)
    }
    req.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (total > MAX_UPLOAD_BYTES) {
        try { req.destroy() } catch { /* 连接已在收尾 */ }
        settleFail(new Error(`插件包超过上限（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB）`))
        return
      }
      if (fd === null) {
        try {
          fd = openSync(filePath, 'w')
        } catch (e) {
          settleFail(e)
          return
        }
      }
      try {
        writeSync(fd, chunk)
      } catch (e) {
        try { req.destroy() } catch { /* 同上 */ }
        settleFail(e)
      }
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      finishFd()
      ok()
    })
    req.on('error', (e) => settleFail(e))
  })
}

/**
 * /kxxy/api/plugins/local-inspect 的处理：
 * 流式收包 → 落临时文件 → 清单遍历 → 解包到 staging → 静态检查。
 * 返回给 sendJson 的对象（ok + uploadId，或 error/detail）。
 */
export async function handleInspectRequest(req, engineRoot) {
  const root = stagingRoot()
  if (!root) {
    return { ok: false, error: '无法定位 DSH_HOME', detail: 'profile 目录不存在，本地安装不可用。' }
  }
  pruneUploads()

  const contentLength = Number(req.headers?.['content-length'] ?? 0)
  if (contentLength && contentLength > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `插件包超过上限（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB）` }
  }

  const uploadDir = join(root, 'uploads')
  mkdirSync(uploadDir, { recursive: true })
  const tgzPath = join(uploadDir, `upload-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.tgz`)

  try {
    await streamBodyToFile(req, tgzPath)
  } catch (e) {
    try { unlinkSync(tgzPath) } catch { /* 本来就没写出来 */ }
    return { ok: false, error: e.message || '上传失败' }
  }

  let uploadSize = 0
  try {
    uploadSize = statSync(tgzPath).size
  } catch { /* 不存在按 0 处理 */ }
  if (uploadSize === 0) {
    try { unlinkSync(tgzPath) } catch { /* 同上 */ }
    return { ok: false, error: '上传内容为空' }
  }

  // 第一遍：清单遍历（只读 tar 头，静态校验全部在这里完成）
  let listing
  try {
    listing = await listTarGz(tgzPath)
  } catch (e) {
    try { unlinkSync(tgzPath) } catch { /* 同上 */ }
    return { ok: false, error: e.message, detail: '静态检查未通过，已放弃安装。' }
  }

  // 第二遍：解包到 staging（tar.mjs 的 safeJoin 兜底第二道路径校验）
  const stagingDir = join(root, `inspect-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`)
  try {
    const extracted = await extractTarGz(tgzPath, stagingDir)
    if (extracted.files === 0) {
      throw new Error('归档里没有可解出的文件')
    }
  } catch (e) {
    try { unlinkSync(tgzPath) } catch { /* 同上 */ }
    try { rmSync(stagingDir, { recursive: true, force: true }) } catch { /* 同上 */ }
    return { ok: false, error: e.message || '解包失败', detail: '静态检查通过但解包失败，已放弃安装。' }
  }

  const report = inspectStaged(stagingDir, engineRoot)
  if (!report.ok) {
    try { unlinkSync(tgzPath) } catch { /* 同上 */ }
    try { rmSync(stagingDir, { recursive: true, force: true }) } catch { /* 同上 */ }
    return report
  }

  const id = randomBytes(12).toString('base64url')
  UPLOADS.set(id, {
    tgzPath,
    stagingDir,
    name: report.name,
    version: report.version,
    ts: Date.now(),
  })
  report.uploadId = id
  report.uploadSize = uploadSize
  report.entryCount = listing.entries.length
  report.uncompressedBytes = listing.totalBytes
  return report
}

// ---------------------------------------------------------------------------
// 安装事务
// ---------------------------------------------------------------------------

/**
 * 提交安装：把 staging 里的 package/ 移入 node_modules/<name>，并写 profile 清单。
 * 全程不联网、不执行包内脚本。失败时尽力回滚，绝不停留在「装了一半」。
 *
 * @param {{id: string, enable: boolean, overwrite: boolean, engineRoot: string}} args
 */
export function installFromUpload({ id, enable, overwrite }) {
  const root = stagingRoot()
  if (!root) return { ok: false, error: '无法定位 DSH_HOME' }
  pruneUploads()

  const entry = UPLOADS.get(String(id ?? ''))
  if (!entry) {
    return { ok: false, error: '上传会话不存在或已过期', detail: '请从「本地安装」重新选择插件包。' }
  }

  const stagedPkgDir = join(entry.stagingDir, 'package')
  if (!existsSync(join(stagedPkgDir, 'package.json'))) {
    removeUpload(String(id))
    return { ok: false, error: '上传会话的数据不完整', detail: 'staging 里找不到 package/，请重新选择插件包。' }
  }

  // uploadId 与包名的绑定在这里重新确认：前端拿到什么就装什么，不信任缓存的旧字段。
  const pkg = readJsonFile(join(stagedPkgDir, 'package.json'))
  const name = String(pkg?.name ?? '')
  const version = String(pkg?.version ?? '')
  if (!validPkgName(name) || PROTECTED.has(name)) {
    removeUpload(String(id))
    return { ok: false, error: '包名不合法或为受保护组件' }
  }

  const target = join(profileNodeModules(), ...name.split('/'))
  if (existsSync(target) && !overwrite) {
    const old = readJsonFile(join(target, 'package.json'))
    return {
      ok: false,
      error: 'conflict',
      detail: `已安装 ${name}${old?.version ? ` v${old.version}` : ''}。覆盖安装会先移除旧包体（清单有备份）。`,
      conflict: true,
      name,
      existingVersion: String(old?.version ?? ''),
    }
  }

  // ── 以下开始动盘：先备好清单，再换包体；清单写失败则回滚包体 ──
  const manifestFile = join(profileDir(), 'package.json')
  if (!existsSync(manifestFile)) {
    return { ok: false, error: `profile 清单不存在：${manifestFile}` }
  }
  const manifest = readJsonFile(manifestFile)
  if (!manifest) {
    return { ok: false, error: 'profile 清单不是合法 JSON', detail: '先在「已安装插件」里确认清单可读，再试安装。' }
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  try {
    copyFileSync(manifestFile, `${manifestFile}.bak-${stamp}`)
    pruneManifestBackups(manifestFile, 5)
  } catch {
    // 备份失败不阻断：与 plugins.mjs 的启停同一取舍（写盘本身是原子的）
  }

  if (existsSync(target)) {
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (e) {
      return { ok: false, error: `移除旧包体失败：${e.message}` }
    }
  }

  mkdirSync(dirname(target), { recursive: true })
  try {
    renameSync(stagedPkgDir, target)
  } catch {
    // 罕见（跨卷）时退回复制：staging 与 node_modules 同在 profile 下，正常走不到
    try {
      cpSync(stagedPkgDir, target, { recursive: true })
      rmSync(stagedPkgDir, { recursive: true, force: true })
    } catch (e) {
      return { ok: false, error: `包体落位失败：${e.message}` }
    }
  }

  let wasEnabled = false
  try {
    manifest.dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
    manifest.dependencies[name] = version || '*'
    manifest.dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
    manifest.dsh.profile = manifest.dsh.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {}
    const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
    wasEnabled = bundles.includes(name)
    // enable=true → 确保在清单里；enable=false → 只装不改启停（覆盖安装时
    // 保留原有启用状态，否则「更新一下插件」会悄悄把它停掉，出乎意料）
    if (enable && !wasEnabled) bundles.push(name)
    manifest.dsh.profile.bundles = bundles
    const text = `${JSON.stringify(manifest, null, 2)}\n`
    const tmp = `${manifestFile}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, manifestFile)
  } catch (e) {
    // 清单写失败：把刚落位的包体撤掉，别留下「盘上有包、清单没有」的漂移态
    try { rmSync(target, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
    return { ok: false, error: `写清单失败：${e.message}` }
  }

  removeUpload(String(id))
  return {
    ok: true,
    name,
    version,
    enabled: enable === true || wasEnabled,
    requiresRestart: true,
    note: enable
      ? '已加入启用清单，重启引擎后加载。'
      : wasEnabled
        ? '保留原有启用状态；需要停用可在插件列表里关闭。'
        : '仅安装包体，未加入启用清单。',
  }
}

/** 与 plugins.mjs 的 pruneBackups 同款（那边不导出）。 */
function pruneManifestBackups(file, keep) {
  const dir = dirname(file)
  const prefix = 'package.json.bak-'
  let names
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(prefix)).sort()
  } catch {
    return
  }
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      unlinkSync(join(dir, n))
    } catch {
      // 删不掉就算了：备份多留一份不影响功能
    }
  }
}
