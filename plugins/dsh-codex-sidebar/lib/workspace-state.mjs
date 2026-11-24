import { mkdir, readFile, writeFile, rename, unlink, realpath, stat, access, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, resolve, join, basename, dirname, parse, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexError } from './transport.mjs'

/**
 * 侧栏的独立工作区目录：
 *   · 每个 DSH 会话可覆盖主会话 header.cwd（保存在插件私有目录，0600，原子写入）；
 *   · 记录最近使用与收藏，便于在移动端快速切换；
 *   · 解析结果永远是 realpath，并拦住插件私有目录、运行时目录、文件系统根与凭据目录。
 *
 * 这里的路径只是工具的**起始目录**，不是内核级边界；真正的写入边界由 WorkspaceTools
 * 的 realpath / 硬链接 / 凭据文件检查逐次保证。
 */
export const WORKSPACE_FILE = 'sidebar-workspaces.json'
const VERSION = 1
const MAX_RECENT = 8
const MAX_PINNED = 16
const MAX_SESSIONS = 200
const MAX_PATH = 4096
const SECRET_DIRECTORY = /^(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.netrc|\.npmrc|\.git-credentials|credentials.*|secrets?(?:\..*)?|private|\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'pom.xml', 'composer.json', 'Gemfile', 'pubspec.yaml']

function within(root, target) {
  const name = relative(root, target)
  if (name === '') return true
  if (isAbsolute(name) || name === '..') return false
  return !name.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}

function canonicalKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function checkWorkspacePath(value, label = '工作区') {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH || value.includes('\0')) throw new CodexError('workspace-invalid', `${label}必须是绝对路径`, 400)
  if (!isAbsolute(value)) throw new CodexError('workspace-invalid', `${label}必须是绝对路径`, 400)
  return resolve(value)
}

export function filesystemRoot(path) {
  return parse(path).root
}

function guardedRoots(env) {
  const home = (env.KXXY_CODEX_HOME && isAbsolute(env.KXXY_CODEX_HOME) ? env.KXXY_CODEX_HOME : env.DSH_HOME && isAbsolute(env.DSH_HOME) ? join(env.DSH_HOME, '.codex-sidebar') : null)
  const engine = env.KXXY_ENGINE_ROOT && isAbsolute(env.KXXY_ENGINE_ROOT) ? env.KXXY_ENGINE_ROOT : null
  return [
    home && { path: resolve(home), code: 'codex-home', message: '插件私有数据目录包含模型凭据，不能作为工作区' },
    engine && { path: resolve(engine), code: 'engine-root', message: '应用运行时目录不能作为工作区' },
  ].filter(Boolean)
}

/** Refuse roots that would expose credentials or the whole filesystem before any tool runs. */
export function deniedWorkspace(path, env = process.env) {
  const key = canonicalKey(path)
  if (key === canonicalKey(filesystemRoot(path))) return { code: 'filesystem-root', message: '不能把文件系统根目录设为工作区，请选择具体项目目录' }
  for (const guarded of guardedRoots(env)) if (within(canonicalKey(guarded.path), key)) return { code: guarded.code, message: guarded.message }
  const parts = key.slice(canonicalKey(filesystemRoot(path)).length).split(/[\\/]+/).filter(Boolean)
  if (parts.some((part) => SECRET_DIRECTORY.test(part))) return { code: 'workspace-secret', message: '该目录包含凭据或私钥，不能作为工作区' }
  return null
}

/** Resolve to a real directory that passes the deny list; never returns a caller-supplied string as-is. */
export async function canonicalWorkspace(value, { env = process.env, label = '工作区' } = {}) {
  const requested = checkWorkspacePath(value, label)
  let canonical
  try { canonical = await realpath(requested) } catch { throw new CodexError('workspace-unavailable', '目录不存在或应用无权访问', 404) }
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new CodexError('workspace-invalid', `${label}必须是目录`, 400)
  const denied = deniedWorkspace(canonical, env)
  if (denied) throw new CodexError('workspace-denied', denied.message, 403)
  return canonical
}

export async function directoryExists(path) {
  try { return (await realpath(path)) === path } catch { return false }
}

/** Project markers are detected from the directory itself, never from file contents. */
export async function projectMarkers(path) {
  const found = await Promise.all(PROJECT_MARKERS.map(async (marker) => {
    try { await access(join(path, marker), constants.F_OK); return marker } catch { return null }
  }))
  return found.filter(Boolean)
}

export function workspaceRoots(env = process.env) {
  const roots = []
  const push = (id, label, path) => {
    if (!path || !isAbsolute(path)) return
    const value = resolve(path)
    if (roots.some((entry) => canonicalKey(entry.path) === canonicalKey(value))) return
    roots.push({ id, label, path: value })
  }
  push('workspaces', '工作区根目录', env.DSH_HOME && isAbsolute(env.DSH_HOME) ? join(env.DSH_HOME, 'workspaces') : null)
  push('home', '应用主目录', env.HOME && isAbsolute(env.HOME) ? env.HOME : env.USERPROFILE && isAbsolute(env.USERPROFILE) ? env.USERPROFILE : null)
  push('data', 'DSH 数据目录', env.DSH_HOME && isAbsolute(env.DSH_HOME) ? env.DSH_HOME : null)
  return roots
}

function validStoredPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH && !value.includes('\0') && isAbsolute(value)
}

function unique(paths) {
  const seen = new Set(), out = []
  for (const path of paths) {
    const key = canonicalKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

/** Private, versioned, atomically written preference file. Corrupt state is ignored, never fatal. */
export class WorkspaceStore {
  constructor(home, { env = process.env } = {}) {
    if (typeof home !== 'string' || !isAbsolute(home) || home.includes('\0')) throw new CodexError('workspace-state', '工作区偏好目录无效', 500)
    this.home = resolve(home)
    this.env = env
    this.path = join(this.home, WORKSPACE_FILE)
    this.data = { version: VERSION, recent: [], pinned: [], sessions: {} }
    this.loading = null
    this.queue = Promise.resolve()
    this.warning = null
  }

  async load() {
    if (!this.loading) this.loading = this.read().catch((error) => { this.warning = this.warning || error.message })
    await this.loading
    return this
  }

  async read() {
    let raw
    try { raw = await readFile(this.path) } catch (error) {
      if (error.code === 'ENOENT') return this
      throw new Error('工作区偏好文件无法读取，本次仅使用会话默认目录')
    }
    if (raw.byteLength > 256 * 1024) throw new Error('工作区偏好文件超过大小上限，已忽略')
    let data
    try { data = JSON.parse(raw.toString('utf8')) } catch { throw new Error('工作区偏好文件已损坏，已忽略并保留原文件') }
    if (!data || data.version !== VERSION || !Array.isArray(data.recent) || !Array.isArray(data.pinned) || !data.sessions || typeof data.sessions !== 'object') throw new Error('工作区偏好格式不受支持，已忽略')
    const sessions = {}
    for (const [id, path] of Object.entries(data.sessions)) {
      if (typeof id !== 'string' || !/^[\w-]{1,160}$/.test(id) || !validStoredPath(path)) continue
      sessions[id] = resolve(path)
    }
    this.data = {
      version: VERSION,
      recent: unique(data.recent.filter(validStoredPath).map(resolve)).slice(0, MAX_RECENT),
      pinned: unique(data.pinned.filter(validStoredPath).map(resolve)).slice(0, MAX_PINNED),
      sessions: Object.fromEntries(Object.entries(sessions).slice(-MAX_SESSIONS)),
    }
    return this
  }

  async save() {
    const snapshot = JSON.stringify(this.data, null, 2) + '\n'
    const task = this.queue.then(async () => {
      await mkdir(this.home, { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.path)
      } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
      }
    })
    this.queue = task.catch(() => {})
    await task
  }

  recent() { return [...this.data.recent] }
  pinned() { return [...this.data.pinned] }
  override(sessionId) {
    if (typeof sessionId !== 'string') return null
    const path = this.data.sessions[sessionId]
    return validStoredPath(path) ? path : null
  }

  remember(path) {
    if (!validStoredPath(path)) return
    const value = resolve(path)
    const key = canonicalKey(value)
    this.data.recent = unique([value, ...this.data.recent.filter((entry) => canonicalKey(entry) !== key)]).slice(0, MAX_RECENT)
  }

  async setOverride(sessionId, path) {
    if (typeof sessionId !== 'string' || !/^[\w-]{1,160}$/.test(sessionId)) throw new CodexError('session-invalid', '无效的 DSH 会话', 400)
    const value = resolve(path)
    this.data.sessions[sessionId] = value
    const ids = Object.keys(this.data.sessions)
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete this.data.sessions[id]
    this.remember(value)
    await this.save()
  }

  async clearOverride(sessionId) {
    if (typeof sessionId !== 'string') return
    if (!Object.hasOwn(this.data.sessions, sessionId)) return
    delete this.data.sessions[sessionId]
    await this.save()
  }

  async pin(path) {
    const value = resolve(path)
    const key = canonicalKey(value)
    this.data.pinned = unique([value, ...this.data.pinned.filter((entry) => canonicalKey(entry) !== key)]).slice(0, MAX_PINNED)
    this.remember(value)
    await this.save()
  }

  async unpin(path) {
    const key = canonicalKey(resolve(path))
    const next = this.data.pinned.filter((entry) => canonicalKey(entry) !== key)
    if (next.length === this.data.pinned.length) return
    this.data.pinned = next
    await this.save()
  }

  isPinned(path) {
    const key = canonicalKey(resolve(path))
    return this.data.pinned.some((entry) => canonicalKey(entry) === key)
  }
}

function visibleName(name) {
  // Hidden directories stay out of the picker (a project is chosen by its real directory);
  // credential-looking names are never offered at all.
  if (typeof name === 'string' && name.startsWith('.')) return false
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !name.includes('\0') && !SECRET_DIRECTORY.test(name)
}

/** Bounded, read-only listing for the workspace drawer; never returns file contents. */
export async function listWorkspace({ path, env = process.env, maxEntries = 120 }) {
  const canonical = await canonicalWorkspace(path, { env })
  const denied = guardedRoots(env).find((guarded) => within(canonicalKey(guarded.path), canonicalKey(canonical)))
  if (denied) throw new CodexError('workspace-denied', denied.message, 403)
  let directory
  try { directory = await readdir(canonical, { withFileTypes: true }) } catch (error) {
    throw new CodexError(error.code === 'EACCES' || error.code === 'EPERM' ? 'workspace-forbidden' : 'workspace-unavailable', '应用无权读取该目录', error.code === 'EACCES' || error.code === 'EPERM' ? 403 : 404)
  }
  let truncated = false
  const candidates = []
  for (const entry of directory) {
    if (candidates.length >= maxEntries) { truncated = true; break }
    if (!visibleName(entry.name)) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    candidates.push(entry.name)
  }
  const entries = []
  await Promise.all(candidates.map(async (name) => {
    const target = join(canonical, name)
    try {
      const resolved = await realpath(target)
      if (deniedWorkspace(resolved, env)) return
      const info = await stat(resolved)
      if (!info.isDirectory()) return
      const markers = await projectMarkers(resolved)
      entries.push({ name, path: resolved, isProject: markers.length > 0, projectMarkers: markers })
    } catch { /* Unreadable or looping links are simply not offered. */ }
  }))
  entries.sort((a, b) => Number(b.isProject) - Number(a.isProject) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
  const parentCandidate = dirname(canonical)
  const parentDenied = parentCandidate === canonical || deniedWorkspace(parentCandidate, env)
  return { path: canonical, name: basename(canonical) || canonical, parent: parentDenied ? null : parentCandidate, entries, truncated }
}

/** Breadcrumbs stop at the closest known root so the drawer never walks to the filesystem root. */
export function breadcrumbs(path, env = process.env) {
  const anchors = [...workspaceRoots(env).map((entry) => entry.path), filesystemRoot(path)]
  let anchor = null
  for (const candidate of anchors) {
    if (!isAbsolute(candidate)) continue
    if (within(canonicalKey(resolve(candidate)), canonicalKey(path))) {
      if (!anchor || canonicalKey(resolve(candidate)).length > canonicalKey(anchor).length) anchor = resolve(candidate)
    }
  }
  const trail = []
  let current = path
  for (let index = 0; index < 24; index += 1) {
    trail.unshift({ name: basename(current) || current, path: current })
    if (anchor && canonicalKey(current) === canonicalKey(anchor)) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return trail
}

const NAME = /^[^\u0000-\u001f\u007f/\\]{1,64}$/

/** One new directory level only; no separators, traversal, control characters or credential names. */
export function checkDirectoryName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || !NAME.test(name) || name === '.' || name === '..' || /[. ]$/.test(name) || SECRET_DIRECTORY.test(name)) throw new CodexError('workspace-name', '目录名不能为空，且不能包含路径分隔符、控制字符或以凭据命名', 400)
  return name
}
