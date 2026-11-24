import { constants, existsSync, statSync } from 'node:fs'
import { realpath, stat, lstat, open, opendir, mkdir, rename, unlink } from 'node:fs/promises'
import { resolve, relative, isAbsolute, join, dirname, basename, delimiter } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { redact } from './transport.mjs'
import { validateAccessMode } from './access-policy.mjs'

const READ_BYTES = 128 * 1024
const WRITE_BYTES = 256 * 1024
const RESULT_BYTES = 64 * 1024
const OUTPUT_BYTES = 128 * 1024
const SEARCH_ENTRIES = 2000
const SEARCH_FILES = 500
const COMMAND_TIMEOUT_MAX = 180000
const CONTEXT_LINES = 3
const SECRET_NAME = /^(?:\.env(?:\..*)?|auth(?:\..*)?|credentials.*|secrets?(?:\..*)?|sidebar-models\.json|codex-change-journal|\.codex(?:-sidebar)?|\.npmrc|\.netrc|\.git-credentials|\.ssh|\.gnupg|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i
const SKIP_DIRECTORY = new Set(['.git', 'node_modules', '.cache', '.codex', '.codex-sidebar'])
const ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'USER', 'LOGNAME', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'PREFIX', 'SHELL', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LIBRARY_PATH', 'CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH',
  'TERMUX__PREFIX', 'KXXY_ROOT', 'KXXY_ENGINE_ROOT', 'DSH_HOME', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENSSL_CONF', 'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR', 'GIT_CONFIG_NOSYSTEM',
  'JAVA_HOME', 'JAVA_TOOL_OPTIONS', 'GRADLE_USER_HOME', 'MAVEN_OPTS',
  'GOROOT', 'GOPATH', 'GOCACHE', 'GOTOOLCHAIN', 'GOPROXY', 'GOSUMDB', 'GOFLAGS', 'GOTMPDIR',
  'GYP_DEFINES', 'ANDROID_NDK_HOME', 'ANDROID_NDK_ROOT', 'ANDROID_NDK_PATH', 'NDK_ROOT',
  'ANDROID_ROOT', 'ANDROID_DATA', 'ANDROID_STORAGE', 'ANDROID_RUNTIME_ROOT',
  'PKG_CONFIG_PATH', 'PKG_CONFIG_LIBDIR', 'PYTHONPYCACHEPREFIX', 'PYTHONPATH',
  'npm_config_registry', 'NPM_CONFIG_REGISTRY', 'COREPACK_NPM_REGISTRY',
  'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_TRUSTED_HOST', 'PIP_DISABLE_PIP_VERSION_CHECK',
  'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS',
  'GEM_HOME', 'GEM_PATH', 'RUBYOPT', 'RUBYLIB', 'PERL5LIB', 'PHPRC', 'VIMRUNTIME', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE',
  'GUILE_LOAD_PATH', 'GUILE_LOAD_COMPILED_PATH', 'GUILE_AUTO_COMPILE', 'MAGIC', 'ERL_ROOTDIR',
  'EMACSDATA', 'EMACSDOC', 'EMACSLOADPATH', 'EMACSPATH',
  'TEXMFCNF', 'TEXMFROOT', 'TEXMFVAR', 'OSFONTDIR', 'TESSDATA_PREFIX', 'MAGICK_CONFIGURE_PATH', 'GS_LIB',
]

const pathProperty = { type: 'string', description: 'Path relative to the current workspace. Never use an absolute path or .. traversal.' }
function definition(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }
}

export const WORKSPACE_TOOLS = [
  definition('get_environment', 'Report the actual workspace, host platform, architecture, shell, Node.js version and available workspace capabilities. Account credentials and environment variables are never returned.', {}),
  definition('list_directory', 'List up to 200 entries in a workspace directory. Credential files are excluded.', { path: pathProperty }),
  definition('read_file', 'Read a workspace text file of at most 128 KiB. Results are bounded; use offset/limit (characters) or startLine/endLine (1-based lines, numbered output) to page through it.', {
    path: pathProperty, offset: { type: 'integer', minimum: 0, description: 'UTF-16 character offset, default 0.' },
    limit: { type: 'integer', minimum: 1, maximum: 49152, description: 'Maximum characters to return, default 49152.' },
    startLine: { type: 'integer', minimum: 1, maximum: 200000, description: 'First line to return (1-based). When set, the text is prefixed with line numbers.' },
    endLine: { type: 'integer', minimum: 1, maximum: 200000, description: 'Last line to return (inclusive). Defaults to the remaining file within the size budget.' },
  }, ['path']),
  definition('search_files', 'Find text inside bounded workspace files. Skips credentials, binary files, .git and node_modules. Optional glob supports *, ** and ?; set regex for a JavaScript regular expression.', {
    query: { type: 'string', minLength: 1, maxLength: 1024 }, path: pathProperty,
    glob: { type: 'string', maxLength: 256 }, maxResults: { type: 'integer', minimum: 1, maximum: 100 },
    regex: { type: 'boolean', description: 'Treat query as a regular expression instead of literal text.' },
  }, ['query']),
  definition('find_files', 'List workspace file paths whose relative path matches a glob, without reading contents. Skips credentials, .git and node_modules.', {
    pattern: { type: 'string', minLength: 1, maxLength: 256 }, path: pathProperty, maxResults: { type: 'integer', minimum: 1, maximum: 200 },
  }, ['pattern']),
  definition('write_file', 'Create or replace a workspace text file, at most 256 KiB. The user must approve the actual file diff for every change. Files changed while approval is pending are rejected.', {
    path: pathProperty, content: { type: 'string', description: 'The complete new UTF-8 file content.' },
  }, ['path', 'content']),
  definition('edit_file', 'Replace exact text inside an existing workspace file. Each oldText must occur exactly once in the file at the time it is applied; read the file first. The user approves the resulting diff.', {
    path: pathProperty,
    edits: {
      type: 'array', minItems: 1, maxItems: 20, description: 'Ordered replacements; each oldText must be unique in the file when applied.',
      items: { type: 'object', properties: { oldText: { type: 'string', minLength: 1, maxLength: 32768 }, newText: { type: 'string', maxLength: 32768 } }, required: ['oldText', 'newText'], additionalProperties: false },
    },
  }, ['path', 'edits']),
  definition('run_command', 'Run a shell command in the app process environment after explicit user approval of this exact command. This uses ordinary process permissions. Default timeout 30 seconds, maximum 180 seconds.', {
    command: { type: 'string', minLength: 1, maxLength: 16384 }, cwd: pathProperty,
    timeoutMs: { type: 'integer', minimum: 100, maximum: COMMAND_TIMEOUT_MAX },
  }, ['command']),
]

export const readOnlyTools = WORKSPACE_TOOLS.filter((entry) => !['write_file', 'edit_file', 'run_command'].includes(entry.function.name))

function fault(code, message) { return Object.assign(new Error(message), { code }) }
function checkAbort(signal) { if (signal?.aborted) throw Object.assign(new Error('操作已停止'), { name: 'AbortError', code: 'aborted' }) }
function contained(root, target) {
  const name = relative(root, target)
  return !isAbsolute(name) && name !== '..' && !name.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}
function safeName(value, fallback) {
  const name = value === undefined ? fallback : value
  if (typeof name !== 'string' || !name || name.length > 2048 || name.includes('\0') || isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw fault('path-invalid', '路径必须相对于当前工作区')
  const parts = name.split(/[\\/]/)
  if (parts.includes('..')) throw fault('path-outside', '路径不能跳出当前工作区')
  if (process.platform === 'win32' && parts.some((part) => part.includes(':'))) throw fault('path-invalid', '不能操作 Windows 备用数据流')
  if (parts.some((part) => SECRET_NAME.test(part))) throw fault('sensitive-file', '不能读取或修改凭据文件')
  return parts.join('/')
}
export function secretPath(name) { return name.split(/[\\/]/).some((part) => SECRET_NAME.test(part)) }
function displayPath(root, path) { return relative(root, path).split('\\').join('/') || '.' }
function digest(data) { return createHash('sha256').update(data).digest('hex') }
function clipped(text, bytes) {
  const data = Buffer.from(String(text))
  return data.length <= bytes ? String(text) : data.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/, '')
}
function tail(text, bytes) {
  const data = Buffer.from(String(text))
  return data.length <= bytes ? String(text) : data.subarray(data.length - bytes).toString('utf8').replace(/^\uFFFD/, '')
}
function jsonBounded(text, budget, fromEnd = false) {
  if (Buffer.byteLength(JSON.stringify(text)) <= budget) return text
  let low = 0, high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const part = fromEnd ? text.slice(text.length - middle) : text.slice(0, middle)
    if (Buffer.byteLength(JSON.stringify(part)) <= budget) low = middle
    else high = middle - 1
  }
  return fromEnd ? text.slice(text.length - low) : text.slice(0, low)
}
/** Model-supplied arguments are validated against the declared schema, including arrays of objects. */
function validateArgument(key, value, spec) {
  const text = (name, item, limits) => {
    if (typeof item !== 'string' || item.includes('\0')) throw fault('arguments-invalid', `${name} 必须是有效文本`)
    if (limits.minLength && item.length < limits.minLength) throw fault('arguments-invalid', `${name} 过短`)
    if (limits.maxLength && item.length > limits.maxLength) throw fault('arguments-invalid', `${name} 过长`)
  }
  if (spec.type === 'string') { text(key, value, spec); return }
  if (spec.type === 'integer') {
    if (!Number.isSafeInteger(value) || spec.minimum !== undefined && value < spec.minimum || spec.maximum !== undefined && value > spec.maximum) throw fault('arguments-invalid', `${key} 超出允许范围`)
    return
  }
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') throw fault('arguments-invalid', `${key} 必须是布尔值`)
    return
  }
  if (spec.type === 'array') {
    if (!Array.isArray(value)) throw fault('arguments-invalid', `${key} 必须是数组`)
    if (spec.minItems && value.length < spec.minItems) throw fault('arguments-invalid', `${key} 至少需要 ${spec.minItems} 项`)
    if (spec.maxItems && value.length > spec.maxItems) throw fault('arguments-invalid', `${key} 最多 ${spec.maxItems} 项`)
    if (spec.items?.type === 'object') {
      const properties = spec.items.properties || {}
      for (const [index, entry] of value.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fault('arguments-invalid', `${key}[${index}] 必须是对象`)
        if (Object.keys(entry).some((name) => !Object.hasOwn(properties, name)) || (spec.items.required ?? []).some((name) => !Object.hasOwn(entry, name))) throw fault('arguments-invalid', `${key}[${index}] 字段缺失或包含未知字段`)
        for (const [name, item] of Object.entries(entry)) validateArgument(`${key}[${index}].${name}`, item, properties[name])
      }
      return
    }
    if (spec.items?.type) for (const [index, entry] of value.entries()) validateArgument(`${key}[${index}]`, entry, spec.items)
    return
  }
  throw fault('arguments-invalid', `${key} 的类型不受支持`)
}

function validExecutable(path) {  try { return typeof path === 'string' && isAbsolute(path) && existsSync(path) && statSync(path).isFile() } catch { return false }
}
function executableOnPath(name, env) {
  for (const directory of (env.PATH || '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue
    const path = join(directory, name)
    if (validExecutable(path)) return path
  }
  return null
}
function shellFor(env) {
  if (process.platform === 'win32') {
    const powershell = executableOnPath('pwsh.exe', env) || (env.SystemRoot && join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    if (validExecutable(powershell)) return powershell
    if (validExecutable(env.COMSPEC) && /^cmd(?:\.exe)?$/i.test(basename(env.COMSPEC))) return env.COMSPEC
    return join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  }
  const engineShell = env.KXXY_ENGINE_ROOT && join(env.KXXY_ENGINE_ROOT, 'bin', 'bash')
  if (validExecutable(engineShell)) return engineShell
  if (validExecutable(env.SHELL) && /^(?:bash|sh|dash|zsh|ksh|fish)$/.test(basename(env.SHELL))) return env.SHELL
  return process.platform === 'android' ? '/system/bin/sh' : validExecutable('/bin/bash') ? '/bin/bash' : '/bin/sh'
}
function secretValue(value) {
  return /\b(?:Bearer\s+|sk-[\w-]{12,})|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)\s*[:=]|https?:\/\/[^/\s]+@/i.test(value)
}

/** Describe the real host runtime without disclosing account environment variables. */
export function workspaceEnvironment(cwd, env = process.env) {
  const child = {}
  for (const key of ENV_KEYS) if (typeof env[key] === 'string' && !env[key].includes('\0') && !secretValue(env[key])) child[key] = env[key]
  // Reconstruct only the app's two known preload scripts. Never inherit arbitrary NODE_OPTIONS.
  if (typeof env.KXXY_GUARD_DIR === 'string' && isAbsolute(env.KXXY_GUARD_DIR)) {
    const preloads = ['kxxy-guard.cjs', 'kxxy-cors.cjs'].map((name) => join(env.KXXY_GUARD_DIR, name)).filter(validExecutable)
    if (preloads.length) {
      child.KXXY_GUARD_DIR = env.KXXY_GUARD_DIR
      child.NODE_OPTIONS = preloads.map((path) => `--require "${path.replace(/\\/g, '/').replace(/"/g, '\\"')}"`).join(' ')
    }
  }
  const shell = shellFor(child)
  child.PWD = resolve(cwd)
  child.NO_COLOR = '1'
  return { cwd: resolve(cwd), platform: process.platform, arch: process.arch, shell, node: process.version, permissionMode: 'app-process', execution: 'app-process', env: child }
}

function argumentsForShell(shell, command) {
  const name = basename(shell).toLowerCase().replace(/\.exe$/, '')
  if (name === 'cmd') return ['/d', '/s', '/c', command]
  if (name === 'pwsh' || name === 'powershell') return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${command}`]
  if (name === 'bash') return ['--noprofile', '--norc', '-c', command]
  if (name === 'zsh') return ['-f', '-c', command]
  if (name === 'fish') return ['--no-config', '-c', command]
  return ['-c', command]
}

function splitLines(text) {
  if (!text) return []
  return String(text).replace(/\r\n?/g, '\n').split('\n')
}

function trimTrailingBreak(lines) {
  if (lines.length && lines[lines.length - 1] === '') return lines.slice(0, -1)
  return lines
}

/** Myers diff over lines. Beyond the edit-distance cap it degrades to one replaced region. */
function diffOps(a, b) {
  const n = a.length, m = b.length
  let start = 0
  while (start < n && start < m && a[start] === b[start]) start += 1
  let endA = n, endB = m
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1 }
  const ops = []
  for (let index = 0; index < start; index += 1) ops.push({ type: 'eq', text: a[index] })
  const middle = myers(a.slice(start, endA), b.slice(start, endB))
  if (middle) ops.push(...middle)
  else {
    for (let index = start; index < endA; index += 1) ops.push({ type: 'del', text: a[index] })
    for (let index = start; index < endB; index += 1) ops.push({ type: 'ins', text: b[index] })
  }
  for (let index = endA; index < n; index += 1) ops.push({ type: 'eq', text: a[index] })
  return ops
}

function myers(a, b, maxDistance = 600) {
  const n = a.length, m = b.length
  if (!n && !m) return []
  if (!n) return b.map((text) => ({ type: 'ins', text }))
  if (!m) return a.map((text) => ({ type: 'del', text }))
  const limit = Math.min(n + m, maxDistance)
  const offset = limit + 1
  const width = 2 * limit + 3
  const trace = []
  let vector = new Int32Array(width)
  for (let d = 0; d <= limit; d += 1) {
    trace.push(vector.slice())
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && vector[offset + k - 1] < vector[offset + k + 1])) x = vector[offset + k + 1]
      else x = vector[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1 }
      vector[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, a, b, offset)
    }
  }
  return null
}

function backtrack(trace, a, b, offset) {
  const ops = []
  let x = a.length, y = b.length
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const vector = trace[d]
    const k = x - y
    const previous = k === -d || (k !== d && vector[offset + k - 1] < vector[offset + k + 1]) ? k + 1 : k - 1
    const previousX = vector[offset + previous]
    const previousY = previousX - previous
    while (x > previousX && y > previousY) { ops.push({ type: 'eq', text: a[x - 1] }); x -= 1; y -= 1 }
    if (x === previousX) { ops.push({ type: 'ins', text: b[y - 1] }); y -= 1 }
    else { ops.push({ type: 'del', text: a[x - 1] }); x -= 1 }
  }
  while (x > 0 && y > 0) { ops.push({ type: 'eq', text: a[x - 1] }); x -= 1; y -= 1 }
  while (x > 0) { ops.push({ type: 'del', text: a[x - 1] }); x -= 1 }
  while (y > 0) { ops.push({ type: 'ins', text: b[y - 1] }); y -= 1 }
  return ops.reverse()
}

/** Standard unified diff with @@ hunks and three lines of context. */
export function unifiedDiff(path, before, after, addition) {
  const oldLines = trimTrailingBreak(splitLines(before))
  const newLines = trimTrailingBreak(splitLines(after))
  const ops = diffOps(oldLines, newLines)
  const header = [`--- ${addition ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`]
  const changed = []
  for (let index = 0; index < ops.length; index += 1) if (ops[index].type !== 'eq') changed.push(index)
  if (!changed.length) return `${header.join('\n')}\n`
  const positions = []
  let oldNumber = 1, newNumber = 1
  for (const op of ops) {
    positions.push({ oldNumber, newNumber })
    if (op.type !== 'ins') oldNumber += 1
    if (op.type !== 'del') newNumber += 1
  }
  const groups = []
  for (const position of changed) {
    const last = groups[groups.length - 1]
    if (last && position - last.end <= CONTEXT_LINES * 2) last.end = position
    else groups.push({ start: position, end: position })
  }
  const hunks = []
  const missingOldBreak = Boolean(before) && !String(before).endsWith('\n')
  const missingNewBreak = Boolean(after) && !String(after).endsWith('\n')
  const lastOldOp = ops.findLastIndex((op) => op.type !== 'ins')
  const lastNewOp = ops.findLastIndex((op) => op.type !== 'del')
  for (const group of groups) {
    const first = Math.max(0, group.start - CONTEXT_LINES)
    const last = Math.min(ops.length - 1, group.end + CONTEXT_LINES)
    const slice = ops.slice(first, last + 1)
    const oldCount = slice.filter((op) => op.type !== 'ins').length
    const newCount = slice.filter((op) => op.type !== 'del').length
    const oldStart = oldCount ? positions[first].oldNumber : positions[first].oldNumber - 1
    const newStart = newCount ? positions[first].newNumber : positions[first].newNumber - 1
    const body = []
    for (let index = first; index <= last; index += 1) {
      const op = ops[index]
      const marker = op.type === 'eq' ? ' ' : op.type === 'del' ? '-' : '+'
      body.push(`${marker}${op.text}`)
      if (missingOldBreak && index === lastOldOp) body.push('\\ No newline at end of file')
      if (missingNewBreak && index === lastNewOp) body.push('\\ No newline at end of file')
    }
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body)
  }
  return `${[...header, ...hunks].join('\n')}\n`
}

function matchGlob(glob) {
  if (glob === undefined || glob === '') return () => true
  if (typeof glob !== 'string' || glob.length > 256 || glob.includes('\0') || glob.split(/[\\/]/).includes('..')) throw fault('arguments-invalid', '搜索 glob 无效')
  let source = ''
  const normalized = glob.replace(/\\/g, '/')
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '*' && normalized[index + 1] === '*') {
      index += 1
      if (normalized[index + 1] === '/') { source += '(?:.*/)?'; index += 1 } else source += '.*'
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  const regex = new RegExp(`^${source}$`)
  return (name) => regex.test(normalized.includes('/') ? name : basename(name))
}

/** Tool permissions are enforced at dispatch and again before every mutating operation. */
export class WorkspaceTools {
  constructor({ cwd, env = process.env, signal, approve, preApproved, onItem, secrets = [], accessMode = 'approval', journal = null } = {}) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw fault('workspace-invalid', '工作区必须是绝对目录')
    this.accessMode = validateAccessMode(accessMode)
    if (journal !== null && (!journal || ['prepareWrite', 'commitWrite', 'failWrite'].some((name) => typeof journal[name] !== 'function'))) throw fault('changes-journal', '文件变更日志适配器无效')
    this.journal = journal
    this.cwd = resolve(cwd)
    this.environment = workspaceEnvironment(this.cwd, env)
    this.signal = signal
    this.approve = approve
    this.preApproved = typeof preApproved === 'function' ? preApproved : null
    this.onItem = onItem
    const accountSecrets = Object.entries(env).filter(([name, value]) => /(?:key|token|secret|password|authorization|credential)/i.test(name) && typeof value === 'string' && value.length >= 8).map(([, value]) => value)
    this.secrets = [...new Set([...accountSecrets, ...(Array.isArray(secrets) ? secrets.filter((value) => typeof value === 'string' && value.length) : [])])]
  }

  async root() {
    checkAbort(this.signal)
    const root = await realpath(this.cwd)
    if (!(await stat(root)).isDirectory()) throw fault('workspace-invalid', '当前工作区不是目录')
    if (this.canonicalRoot && this.canonicalRoot !== root) throw fault('workspace-changed', '工作区路径已改变，请新建对话')
    this.canonicalRoot = root
    return root
  }

  clean(value) {
    let text = redact(value)
    for (const secret of this.secrets) text = text.split(secret).join('[redacted]')
    return text
  }

  redactionRanges(source) {
    const ranges = []
    for (const secret of this.secrets) {
      let offset = 0, start
      while ((start = source.indexOf(secret, offset)) !== -1) { ranges.push({ start, end: start + secret.length }); offset = start + 1 }
    }
    for (const pattern of [
      /\bsk-[\w-]{12,}/g,
      /(Bearer\s+)([^\s"']+)/gi,
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gi,
    ]) {
      for (const match of source.matchAll(pattern)) {
        const start = match.index + (match[1]?.length || 0)
        ranges.push({ start, end: match.index + match[0].length })
      }
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end)
    const merged = []
    for (const range of ranges) {
      const previous = merged.at(-1)
      if (previous && previous.end >= range.start) previous.end = Math.max(previous.end, range.end)
      else merged.push({ ...range })
    }
    return merged
  }

  cleanSlice(source, offset, length, ranges) {
    const end = Math.min(source.length, offset + length)
    let cursor = offset, text = ''
    for (const range of ranges) {
      if (range.end <= offset) continue
      if (range.start >= end) break
      text += source.slice(cursor, Math.max(cursor, range.start)) + '[redacted]'
      cursor = Math.min(end, range.end)
    }
    return text + source.slice(cursor, end)
  }

  async item(value) { if (this.onItem) await this.onItem({ ...value, changes: value.changes?.map((change) => ({ ...change })) }) }

  requireMutation() {
    validateAccessMode(this.accessMode)
    checkAbort(this.signal)
    if (this.accessMode === 'readonly') throw fault('access-readonly', '只读模式不允许修改文件或执行命令')
  }

  /** Returns { allowed, note }; a rejection may carry the user's own instruction for the model. */
  async permission(details) {
    this.requireMutation()
    if (this.accessMode === 'full') return { allowed: true, granted: true }
    if (typeof this.preApproved === 'function' && this.preApproved(details) === true) return { allowed: true, granted: true }
    if (typeof this.approve !== 'function') return { allowed: false, note: '' }
    let listener
    const aborted = new Promise((_, reject) => {
      listener = () => reject(Object.assign(new Error('操作已停止'), { name: 'AbortError', code: 'aborted' }))
      this.signal?.addEventListener('abort', listener, { once: true })
    })
    try {
      const answer = await Promise.race([Promise.resolve(this.approve(details)), aborted])
      checkAbort(this.signal)
      if (answer === true) return { allowed: true, granted: false }
      if (answer && answer.allowed === true) return { allowed: true, granted: answer.granted === true }
      const note = typeof answer?.note === 'string' ? answer.note.slice(0, 2000) : ''
      return { allowed: false, note }
    } finally { this.signal?.removeEventListener('abort', listener) }
  }

  async existing(name, { directory = false } = {}) {
    const root = await this.root()
    const requested = resolve(root, safeName(name, '.'))
    if (!contained(root, requested)) throw fault('path-outside', '路径不能跳出当前工作区')
    const path = await realpath(requested)
    if (!contained(root, path)) throw fault('path-outside', '符号链接不能指向工作区外')
    if (secretPath(displayPath(root, path))) throw fault('sensitive-file', '不能读取或修改凭据文件')
    const info = await stat(path)
    if (directory ? !info.isDirectory() : !info.isFile()) throw fault('path-type', directory ? '路径不是目录' : '路径不是普通文件')
    return { root, path, info, name: displayPath(root, requested) }
  }

  async bytes(path, maxBytes) {
    checkAbort(this.signal)
    const root = await this.root()
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const info = await handle.stat()
      const validate = async () => {
        const current = await realpath(path)
        if (current !== path || !contained(root, current) || secretPath(displayPath(root, current))) throw fault('path-changed', '读取目标路径已改变，请重试')
        const currentInfo = await stat(current)
        if (currentInfo.dev !== info.dev || currentInfo.ino !== info.ino || currentInfo.nlink > 1) throw fault('file-changed', '读取目标文件已改变，请重试')
      }
      // O_NOFOLLOW protects the last component; this also verifies every parent and the opened inode.
      await validate()
      if (!info.isFile()) throw fault('file-type', '只能操作普通文本文件')
      if (info.nlink > 1) throw fault('file-hardlink', '不能操作具有多个硬链接的文件')
      if (info.size > maxBytes) throw fault('file-too-large', `文件超过 ${maxBytes / 1024} KiB 上限`)
      const data = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < data.length) {
        checkAbort(this.signal)
        const result = await handle.read(data, length, data.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length > maxBytes) throw fault('file-too-large', `文件超过 ${maxBytes / 1024} KiB 上限`)
      const content = data.subarray(0, length)
      if (content.includes(0)) throw fault('file-binary', '只能操作文本文件')
      try { new TextDecoder('utf-8', { fatal: true }).decode(content) } catch { throw fault('file-binary', '只能操作 UTF-8 文本文件') }
      const after = await handle.stat()
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.nlink > 1) throw fault('file-changed', '读取时文件已改变，请重试')
      await validate()
      checkAbort(this.signal)
      return { data: content, info: after, hash: digest(content) }
    } finally { await handle.close() }
  }

  async execute(name, args = {}) {
    checkAbort(this.signal)
    try {
      validateAccessMode(this.accessMode)
      if (['write_file', 'edit_file', 'run_command'].includes(name)) this.requireMutation()
      const schema = WORKSPACE_TOOLS.find((entry) => entry.function.name === name)?.function.parameters
      if (!schema) throw fault('tool-unknown', '未知的工作区工具')
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fault('arguments-invalid', '工具参数必须是对象')
      if (Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key)) || schema.required.some((key) => !Object.hasOwn(args, key))) throw fault('arguments-invalid', '工具参数缺失或包含未知字段')
      for (const [key, value] of Object.entries(args)) validateArgument(key, value, schema.properties[key])
      const value = await this[name](args)
      checkAbort(this.signal)
      if (Buffer.byteLength(JSON.stringify(value)) > RESULT_BYTES) throw fault('tool-output-limit', '工具结果超过 64 KiB 上限，请缩小操作范围')
      return value
    } catch (error) {
      if (error.name === 'AbortError' || this.signal?.aborted) { checkAbort(this.signal); throw error }
      const known = typeof error.code === 'string' && /^(?:path-|file-|workspace-|sensitive-|arguments-|approval-|tool-|access-|changes-|edit-)/.test(error.code)
      return { ok: false, code: error.code || 'tool-error', error: known ? this.clean(error.message) : error.code === 'ENOENT' ? '文件或目录不存在' : error.code === 'EACCES' || error.code === 'EPERM' ? '应用进程没有操作此路径的权限' : '工作区操作失败', ...(error.writeApplied ? { writeApplied: true, journalPending: true } : {}) }
    }
  }

  async get_environment() {
    validateAccessMode(this.accessMode)
    const cwd = await this.root()
    const { platform, arch, shell, node, permissionMode } = this.environment
    return {
      ok: true, cwd: this.clean(cwd), platform, arch, shell: this.clean(shell), node, permissionMode, accessMode: this.accessMode,
      capabilities: {
        tools: (this.accessMode === 'readonly' ? readOnlyTools : WORKSPACE_TOOLS).map((entry) => entry.function.name),
        readFileMaxBytes: READ_BYTES, writeFileMaxBytes: WRITE_BYTES, toolResultMaxBytes: RESULT_BYTES,
        fileChangesRequireApproval: this.accessMode === 'approval', commandsRequireApproval: this.accessMode === 'approval',
        shellAvailable: validExecutable(shell), commandTimeoutMaxMs: COMMAND_TIMEOUT_MAX,
        editFile: true, findFiles: true, regexSearch: true, lineRangeRead: true,
      },
    }
  }

  async list_directory({ path = '.' }) {
    const entry = await this.existing(path, { directory: true })
    const directory = await opendir(entry.path)
    const entries = []
    let truncated = false, inspected = 0, resultBytes = 0
    try {
      while (true) {
        checkAbort(this.signal)
        const child = await directory.read()
        if (!child) break
        inspected += 1
        if (inspected > 1000) { truncated = true; break }
        if (SECRET_NAME.test(child.name)) continue
        if (entries.length >= 200) { truncated = true; break }
        const target = join(entry.path, child.name)
        try {
          const canonical = await realpath(target)
          if (!contained(entry.root, canonical) || secretPath(displayPath(entry.root, canonical))) continue
          const info = await stat(canonical)
          const value = { name: this.clean(child.name), path: this.clean(displayPath(entry.root, target)), type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', ...(info.isFile() ? { size: info.size } : {}), ...(child.isSymbolicLink() ? { symlink: true } : {}) }
          resultBytes += Buffer.byteLength(JSON.stringify(value))
          if (resultBytes > 48 * 1024) { truncated = true; break }
          entries.push(value)
        } catch (error) { if (error.name === 'AbortError') throw error }
      }
    } finally { await directory.close() }
    entries.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
    return { ok: true, path: this.clean(entry.name), entries, truncated }
  }

  async read_file({ path, offset = 0, limit = 49152, startLine, endLine }) {
    const entry = await this.existing(path)
    const file = await this.bytes(entry.path, READ_BYTES)
    const source = file.data.toString('utf8')
    const ranges = this.redactionRanges(source)
    const totalLines = source ? source.split('\n').length : 0
    let from = offset
    let numbered = false
    let firstLine = null, lastLine = null
    if (startLine !== undefined || endLine !== undefined) {
      const lines = source.split('\n')
      firstLine = Math.min(Math.max(1, startLine ?? 1), Math.max(1, lines.length))
      lastLine = Math.min(Math.max(firstLine, endLine ?? lines.length), lines.length)
      from = 0
      for (let index = 0; index < firstLine - 1; index += 1) from += lines[index].length + 1
      const span = lines.slice(firstLine - 1, lastLine).join('\n')
      limit = Math.min(Math.max(limit, 1), Math.max(span.length, 1))
      numbered = true
    }
    let consumed = Math.min(limit, Math.max(0, source.length - from))
    let text = this.cleanSlice(source, from, consumed, ranges)
    if (Buffer.byteLength(JSON.stringify(text)) > 48 * 1024) {
      let low = 0, high = consumed
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (Buffer.byteLength(JSON.stringify(this.cleanSlice(source, from, middle, ranges))) <= 48 * 1024) low = middle
        else high = middle - 1
      }
      consumed = low
      text = this.cleanSlice(source, from, consumed, ranges)
    }
    if (numbered && text) {
      const base = firstLine - 1
      text = text.split('\n').map((line, index) => `${base + index + 1}| ${line}`).join('\n')
    }
    return {
      ok: true, path: this.clean(entry.name), text, offset: from, nextOffset: from + consumed,
      totalCharacters: source.length, truncated: from + consumed < source.length, sha256: file.hash,
      ...(numbered ? { numbered, totalLines, startLine: firstLine, endLine: lastLine } : { totalLines }),
    }
  }

  async search_files({ query, path = '.', glob, maxResults = 50, regex = false }) {
    if (/[\r\n]/.test(query)) throw fault('arguments-invalid', '搜索文本必须位于同一行')
    let pattern = null
    if (regex) {
      if (query.length > 512) throw fault('arguments-invalid', '正则表达式过长')
      try { pattern = new RegExp(query) } catch (error) { throw fault('arguments-invalid', `正则表达式无效：${error.message.slice(0, 120)}`) }
    }
    const found = (line) => pattern ? pattern.test(line) : line.includes(query)
    const entry = await this.existing(path, { directory: true })
    const matches = matchGlob(glob)
    const files = []
    const pending = [{ path: entry.path, depth: 0 }]
    const visited = new Set()
    let inspected = 0, truncated = false
    while (pending.length && files.length < SEARCH_FILES && inspected < SEARCH_ENTRIES) {
      checkAbort(this.signal)
      const next = pending.pop()
      if (visited.has(next.path)) continue
      const canonicalDirectory = await realpath(next.path).catch(() => null)
      if (canonicalDirectory !== next.path || !contained(entry.root, canonicalDirectory) || secretPath(displayPath(entry.root, canonicalDirectory))) { truncated = true; continue }
      visited.add(next.path)
      const directory = await opendir(next.path)
      try {
        while (inspected < SEARCH_ENTRIES && files.length < SEARCH_FILES) {
          const child = await directory.read()
          if (!child) break
          inspected += 1
          checkAbort(this.signal)
          if (SECRET_NAME.test(child.name) || child.isSymbolicLink()) continue
          const target = join(next.path, child.name)
          if (child.isDirectory()) {
            if (!SKIP_DIRECTORY.has(child.name) && next.depth < 16) pending.push({ path: target, depth: next.depth + 1 })
            else if (next.depth >= 16) truncated = true
          } else if (child.isFile() && matches(displayPath(entry.path, target))) {
            try {
              const canonical = await realpath(target)
              const info = await stat(canonical)
              if (contained(entry.root, canonical) && !secretPath(displayPath(entry.root, canonical)) && info.isFile() && info.nlink === 1 && info.size <= READ_BYTES) files.push({ path: canonical, info })
            } catch {}
          }
        }
      } finally { await directory.close() }
    }
    truncated ||= pending.length > 0 || inspected >= SEARCH_ENTRIES || files.length >= SEARCH_FILES
    const results = []
    let resultBytes = 0
    const add = (file, line, text) => {
      const source = text.replace(/\r?\n$/, '')
      const result = { path: this.clean(displayPath(entry.root, file)), line, text: clipped(this.cleanSlice(source, 0, Math.min(source.length, 2048), this.redactionRanges(source)), 2048) }
      const bytes = Buffer.byteLength(JSON.stringify(result))
      if (results.length >= maxResults || resultBytes + bytes > 40 * 1024) { truncated = true; return false }
      results.push(result); resultBytes += bytes
      return true
    }
    // Native file handles are checked before and after reading. An external recursive search
    // cannot enforce these inode/path checks when another process replaces a parent directory.
    for (const file of files) {
      checkAbort(this.signal)
      let content
      try { content = (await this.bytes(file.path, READ_BYTES)).data.toString('utf8') } catch { continue }
      const lines = content.split('\n')
      const ranges = this.redactionRanges(content)
      let offset = 0
      for (let index = 0; index < lines.length; index += 1) {
        if (found(lines[index]) && !add(file.path, index + 1, this.cleanSlice(content, offset, Math.min(lines[index].length, 2048), ranges))) break
        offset += lines[index].length + 1
      }
      if (results.length >= maxResults) { truncated = true; break }
    }
    return { ok: true, path: this.clean(entry.name), query: this.clean(query), matches: results, scannedFiles: files.length, truncated }
  }

  /** Path-only search: never reads file contents, so it is safe to run before any approval. */
  async find_files({ pattern, path = '.', maxResults = 100 }) {
    const entry = await this.existing(path, { directory: true })
    const matches = matchGlob(pattern)
    const pending = [{ path: entry.path, depth: 0 }]
    const visited = new Set()
    const files = []
    let inspected = 0, truncated = false
    while (pending.length && files.length < maxResults && inspected < SEARCH_ENTRIES) {
      checkAbort(this.signal)
      const next = pending.pop()
      if (visited.has(next.path)) continue
      const canonicalDirectory = await realpath(next.path).catch(() => null)
      if (canonicalDirectory !== next.path || !contained(entry.root, canonicalDirectory) || secretPath(displayPath(entry.root, canonicalDirectory))) { truncated = true; continue }
      visited.add(next.path)
      const directory = await opendir(next.path)
      try {
        while (inspected < SEARCH_ENTRIES && files.length < maxResults) {
          const child = await directory.read()
          if (!child) break
          inspected += 1
          checkAbort(this.signal)
          if (SECRET_NAME.test(child.name) || child.isSymbolicLink()) continue
          const target = join(next.path, child.name)
          if (child.isDirectory()) {
            if (!SKIP_DIRECTORY.has(child.name) && next.depth < 16) pending.push({ path: target, depth: next.depth + 1 })
            else if (next.depth >= 16) truncated = true
            continue
          }
          if (!child.isFile()) continue
          const relative = displayPath(entry.root, target)
          if (!matches(relative)) continue
          if (secretPath(relative)) continue
          try {
            const info = await stat(target)
            files.push({ path: this.clean(relative), size: info.size })
          } catch { /* Vanished between readdir and stat. */ }
        }
      } finally { await directory.close() }
    }
    truncated ||= pending.length > 0 || inspected >= SEARCH_ENTRIES || files.length >= maxResults
    files.sort((a, b) => a.path.localeCompare(b.path))
    return { ok: true, path: this.clean(entry.name), pattern: this.clean(pattern), files, truncated, scannedEntries: inspected }
  }

  async writable(name) {
    const root = await this.root()
    const requested = resolve(root, safeName(name))
    if (!contained(root, requested) || requested === root) throw fault('path-outside', '文件必须位于当前工作区内')
    // Walk existing parents one at a time, recording the canonical nearest parent for additions.
    let parent = dirname(requested)
    const missing = []
    while (true) {
      try {
        const canonical = await realpath(parent)
        if (!contained(root, canonical) || secretPath(displayPath(root, canonical))) throw fault('path-outside', '目标目录不能指向工作区外或凭据目录')
        if (canonical !== parent) throw fault('path-symlink', '不能通过符号链接目录修改文件')
        if (!(await stat(canonical)).isDirectory()) throw fault('path-type', '目标父路径不是目录')
        const target = join(canonical, ...missing.reverse(), basename(requested))
        if (!contained(root, target)) throw fault('path-outside', '目标文件不能跳出工作区')
        let info = null
        try { info = await lstat(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (info?.isSymbolicLink()) throw fault('path-symlink', '不能通过符号链接写入文件')
        if (info && !info.isFile()) throw fault('path-type', '目标不是普通文件')
        if (info?.nlink > 1) throw fault('file-hardlink', '不能修改具有多个硬链接的文件')
        return { root, path: target, parent: canonical, name: displayPath(root, requested), exists: Boolean(info) }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        if (parent === root) throw error
        missing.push(basename(parent)); parent = dirname(parent)
      }
    }
  }

  async write_file({ path, content }) {
    this.requireMutation()
    if (typeof content !== 'string' || content.includes('\0')) throw fault('arguments-invalid', '写入内容必须是 UTF-8 文本')
    return this.writeContent({ path, content })
  }

  async edit_file({ path, edits }) {
    this.requireMutation()
    if (!Array.isArray(edits) || !edits.length || edits.length > 20) throw fault('arguments-invalid', 'edits 需为 1–20 个替换项')
    const entry = await this.existing(path)
    const original = await this.bytes(entry.path, WRITE_BYTES)
    let content = original.data.toString('utf8')
    for (const [index, edit] of edits.entries()) {
      const oldText = edit?.oldText, newText = edit?.newText
      if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') throw fault('arguments-invalid', `第 ${index + 1} 个替换项必须包含非空 oldText 与 newText`)
      const occurrences = content.split(oldText).length - 1
      if (occurrences === 0) throw fault('edit-not-found', `第 ${index + 1} 个替换项的 oldText 未出现在文件中；请重新读取文件后再改`)
      if (occurrences > 1) throw fault('edit-ambiguous', `第 ${index + 1} 个替换项的 oldText 出现 ${occurrences} 次；请补充上下文使其唯一`)
      content = content.replace(oldText, () => newText)
    }
    if (content === original.data.toString('utf8')) return { ok: true, path: entry.name, unchanged: true, sha256: original.hash }
    return this.writeContent({ path, content })
  }

  async writeContent({ path, content }) {
    this.requireMutation()
    if (typeof content !== 'string' || content.includes('\0')) throw fault('arguments-invalid', '写入内容必须是 UTF-8 文本')
    const after = Buffer.from(content)
    if (after.length > WRITE_BYTES) throw fault('file-too-large', '写入内容超过 256 KiB 上限')
    const afterHash = digest(after)
    const before = await this.writable(path)
    const original = before.exists ? await this.bytes(before.path, WRITE_BYTES) : null
    if (original?.data.toString('utf8') === content) return { ok: true, path: before.name, unchanged: true, sha256: original.hash }
    const diff = unifiedDiff(before.name, original?.data.toString('utf8') || '', content, !before.exists)
    const item = { id: `workspace-write-${randomUUID()}`, type: 'fileChange', status: 'inProgress', changes: [{ path: before.name, diff, kind: { type: before.exists ? 'update' : 'add' } }] }
    await this.item(item)
    let temporary = null, journalToken, applied = false
    try {
      const decision = await this.permission({ kind: 'fileChange', itemId: item.id, path: before.name, cwd: before.root, diff, expectedHash: original?.hash ?? null })
      if (!decision.allowed) {
        item.status = 'declined'; await this.item(item)
        return { ok: false, code: 'approval-declined', error: '用户拒绝了本次文件变更', ...(decision.note ? { feedback: decision.note } : {}) }
      }
      const validate = async () => {
        this.requireMutation()
        const current = await this.writable(path)
        if (current.path !== before.path || current.exists !== before.exists) throw fault('file-changed', '审批期间目标路径已改变，请重新申请')
        if (original) {
          const file = await this.bytes(current.path, WRITE_BYTES)
          if (file.hash !== original.hash || file.info.dev !== original.info.dev || file.info.ino !== original.info.ino || file.info.mode !== original.info.mode) throw fault('file-changed', '审批期间文件已改变，请读取新内容后重新申请')
        }
        return current
      }
      await validate()
      if (this.journal) {
        journalToken = await this.journal.prepareWrite({ itemId: item.id, path: before.name, cwd: before.root, before: original?.data ?? null, beforeHash: original?.hash ?? null, after, afterHash, mode: original ? original.info.mode & 0o777 : 0o600 })
        if (typeof journalToken !== 'string' || !journalToken) throw fault('changes-journal', '无法安全记录文件变更，已取消写入')
      }
      this.requireMutation()
      await validate()
      await mkdir(dirname(before.path), { recursive: true })
      if (await realpath(dirname(before.path)) !== dirname(before.path)) throw fault('path-changed', '目标目录已改变，请重新申请')
      await validate()
      temporary = join(dirname(before.path), `.workspace-write-${randomUUID()}.tmp`)
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), original ? original.info.mode & 0o777 : 0o600)
      try { await handle.writeFile(after); await handle.sync() } finally { await handle.close() }
      this.requireMutation()
      await validate()
      await rename(temporary, before.path)
      temporary = null
      applied = true
      if (this.journal) await this.journal.commitWrite(journalToken)
      item.status = 'completed'; await this.item(item)
      return { ok: true, path: before.name, sha256: afterHash, bytesWritten: after.length, kind: before.exists ? 'update' : 'add' }
    } catch (error) {
      if (journalToken && !applied) await this.journal.failWrite(journalToken).catch(() => {})
      if (applied && this.journal) error.writeApplied = true
      item.status = error.name === 'AbortError' ? 'cancelled' : 'failed'
      item.aggregatedOutput = applied ? '文件已写入；日志确认或结果通知失败，请先检查变更记录，不要自动重试。' : this.clean(error.message)
      await this.item(item)
      throw error
    } finally { if (temporary) await unlink(temporary).catch(() => {}) }
  }

  async capture(program, args, { cwd, timeoutMs, onOutput } = {}) {
    checkAbort(this.signal)
    const childEnv = { ...this.environment.env, PWD: cwd }
    let output = '', outputTruncated = false, timedOut = false, killed = false
    return await new Promise((resolvePromise, reject) => {
      let processHandle, timer, killTimer
      const stop = () => {
        if (killed) return
        killed = true
        if (process.platform === 'win32') {
          const taskkill = join(childEnv.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
          const killer = spawn(taskkill, ['/pid', String(processHandle.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', env: childEnv })
          killer.on('error', () => processHandle.kill())
          killer.unref()
        } else {
          try { process.kill(-processHandle.pid, 'SIGTERM') } catch { processHandle.kill('SIGTERM') }
          killTimer = setTimeout(() => { try { process.kill(-processHandle.pid, 'SIGKILL') } catch { processHandle.kill('SIGKILL') } }, 500)
          killTimer.unref?.()
        }
      }
      // Keep escalation scheduled after an aborted shell exits: a child may ignore SIGTERM.
      const cleanup = () => { clearTimeout(timer); if (!killed) clearTimeout(killTimer); this.signal?.removeEventListener('abort', stop) }
      try {
        processHandle = spawn(program, args, { cwd, env: childEnv, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) { reject(error); return }
      timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
      timer.unref?.()
      this.signal?.addEventListener('abort', stop, { once: true })
      if (this.signal?.aborted) stop()
      const collect = (chunk) => {
        output += chunk.toString('utf8')
        if (Buffer.byteLength(output) > OUTPUT_BYTES) { output = tail(output, OUTPUT_BYTES); outputTruncated = true }
        onOutput?.(this.clean(output), outputTruncated)
      }
      processHandle.stdout.setEncoding('utf8').on('data', collect)
      processHandle.stderr.setEncoding('utf8').on('data', collect)
      processHandle.once('error', (error) => { cleanup(); reject(error) })
      processHandle.once('close', (exitCode, signal) => {
        cleanup()
        try { checkAbort(this.signal) } catch (error) { reject(error); return }
        resolvePromise({ output: this.clean(output), outputTruncated, exitCode, signal, timedOut })
      })
    })
  }

  async run_command({ command, cwd = '.', timeoutMs = 30000 }) {
    this.requireMutation()
    if (typeof command !== 'string' || !command.trim() || command.includes('\0') || command.length > 16384 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > COMMAND_TIMEOUT_MAX) throw fault('arguments-invalid', '命令或超时参数无效')
    const workspace = await this.existing(cwd, { directory: true })
    const item = { id: `workspace-command-${randomUUID()}`, type: 'commandExecution', status: 'inProgress', command: this.clean(command), cwd: this.clean(workspace.path), aggregatedOutput: '', exitCode: null }
    await this.item(item)
    try {
      const decision = await this.permission({ kind: 'commandExecution', itemId: item.id, command, cwd: workspace.path })
      if (!decision.allowed) {
        item.status = 'declined'; await this.item(item)
        return { ok: false, code: 'approval-declined', error: '用户拒绝了本次命令执行', ...(decision.note ? { feedback: decision.note } : {}) }
      }
      this.requireMutation()
      if ((await this.existing(cwd, { directory: true })).path !== workspace.path) throw fault('workspace-changed', '审批期间命令目录已改变，请重新申请')
      const result = await this.capture(this.environment.shell, argumentsForShell(this.environment.shell, command), {
        cwd: workspace.path, timeoutMs,
        onOutput: (output, truncated) => { item.aggregatedOutput = output; item.outputTruncated = truncated; this.onItem?.({ ...item }) },
      })
      item.aggregatedOutput = result.output
      item.outputTruncated = result.outputTruncated
      item.exitCode = result.exitCode
      item.status = result.timedOut ? 'failed' : 'completed'
      if (result.timedOut) item.aggregatedOutput += '\n命令超时，已终止进程。'
      await this.item(item)
      const text = jsonBounded(result.output, 36 * 1024, true)
      return { ok: !result.timedOut && result.exitCode === 0, command: jsonBounded(this.clean(command), 8 * 1024), cwd: this.clean(workspace.path), output: text, outputTruncated: result.outputTruncated || text !== result.output, exitCode: result.exitCode, timedOut: result.timedOut }
    } catch (error) {
      item.status = error.name === 'AbortError' ? 'cancelled' : 'failed'
      item.aggregatedOutput = tail(`${item.aggregatedOutput}\n${this.clean(error.message)}`, OUTPUT_BYTES)
      await this.item(item)
      throw error
    }
  }
}

/** Fixed, user-invoked app diagnostics; no caller or model command is accepted. */
export async function checkWorkspaceEnvironment({ cwd, env = process.env, signal, timeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw fault('arguments-invalid', '环境检查超时设置无效')
  const tools = new WorkspaceTools({ cwd, env, signal })
  const host = await tools.get_environment()
  const root = await tools.root()
  const { env: childEnv, ...runtime } = tools.environment
  const environment = {
    ...runtime, cwd: tools.clean(root), shell: tools.clean(runtime.shell),
    source: 'app-runtime', capabilities: host.capabilities, modelToolSupport: 'not-tested',
  }
  const checks = [{ id: 'workspace', label: '当前工作区', status: 'ok', detail: '已确认当前会话绑定的实际目录', path: tools.clean(root) }]
  const target = join(root, `.kxxy-env-check-${randomUUID()}.tmp`)
  let created = false, info = null, fileError = null
  const verifyTarget = async () => {
    // Cleanup still verifies ownership after cancellation; an aborted signal must not
    // prevent removal of the fresh file that this check created.
    if (await realpath(tools.cwd) !== root || await realpath(target) !== target) throw fault('path-changed', '检测文件路径已改变，已停止操作')
    const current = await lstat(target)
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== info.dev || current.ino !== info.ino) throw fault('file-changed', '检测文件已改变，不能继续操作')
  }
  try {
    checkAbort(signal)
    const handle = await open(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
    created = true
    try {
      info = await handle.stat()
      await verifyTarget()
      const content = `KXXY environment check ${randomUUID()}\n`
      await handle.writeFile(content, 'utf8')
      await handle.sync()
      await verifyTarget()
      if ((await tools.bytes(target, 1024)).data.toString('utf8') !== content) throw fault('file-check', '临时文件读写结果不一致')
    } finally { await handle.close() }
  } catch (error) { fileError = error } finally {
    if (created) {
      try {
        await verifyTarget()
        await unlink(target)
        try { await lstat(target); throw fault('file-cleanup', '检测文件未能清理') } catch (error) { if (error.code !== 'ENOENT') throw error }
      } catch (error) {
        fileError = fault('file-cleanup', '临时检测文件未能安全清理，请检查工作区')
      }
    }
  }
  checkAbort(signal)
  checks.push({
    id: 'fileAccess', label: '文件读写', status: fileError ? 'error' : 'ok',
    detail: !fileError ? '新建、写入、读取及清理临时文件均成功' : fileError.code === 'EACCES' || fileError.code === 'EPERM' ? '应用没有当前工作区的写入权限' : fileError.code === 'EEXIST' ? '检测路径已存在，未修改已有文件' : tools.clean(fileError.message || '工作区文件读写检测失败'),
    ...(fileError?.code === 'file-cleanup' ? { path: tools.clean(target) } : {}),
  })
  const candidates = (names) => {
    for (const name of names) {
      const engine = childEnv.KXXY_ENGINE_ROOT && join(childEnv.KXXY_ENGINE_ROOT, 'bin', name)
      if (validExecutable(engine)) return engine
      const path = executableOnPath(name, childEnv)
      if (path) return path
    }
    return null
  }
  const shellName = basename(runtime.shell).toLowerCase().replace(/\.exe$/, '')
  const shellCommand = shellName === 'cmd' ? 'echo KXXY_SHELL_OK' : ['powershell', 'pwsh'].includes(shellName) ? "Write-Output 'KXXY_SHELL_OK'" : "printf 'KXXY_SHELL_OK\\n'"
  const probes = [
    { id: 'shell', label: '命令环境', program: runtime.shell, args: argumentsForShell(runtime.shell, shellCommand), expected: 'KXXY_SHELL_OK' },
    { id: 'node', label: 'Node.js', program: process.execPath, args: ['--version'] },
    { id: 'python', label: 'Python', program: candidates(process.platform === 'win32' ? ['python3.exe', 'python.exe'] : ['python3', 'python']), args: ['--version'] },
    { id: 'git', label: 'Git', program: candidates(process.platform === 'win32' ? ['git.exe'] : ['git']), args: ['--version'] },
  ]
  checks.push(...await Promise.all(probes.map(async ({ id, label, program, args, expected }) => {
    if (!validExecutable(program)) return { id, label, status: 'error', detail: '当前运行环境未找到可执行文件' }
    try {
      const result = await tools.capture(program, args, { cwd: root, timeoutMs })
      const ok = !result.timedOut && result.exitCode === 0 && (!expected || result.output.includes(expected))
      return {
        id, label, status: ok ? 'ok' : 'error', path: tools.clean(program),
        detail: result.timedOut ? '检测超时，已终止检测进程' : ok ? id === 'shell' ? '实际命令环境可正常执行' : clipped(result.output.trim(), 1024) || '可正常执行' : '实际运行检测失败',
        exitCode: result.exitCode, ...(result.timedOut ? { timedOut: true } : {}),
        ...(!ok && result.output ? { output: clipped(result.output.trim(), 1024) } : {}),
      }
    } catch (error) {
      checkAbort(signal)
      return { id, label, status: 'error', path: tools.clean(program), detail: error.code === 'EACCES' || error.code === 'EPERM' ? '应用没有执行此程序的权限' : '实际运行检测失败' }
    }
  })))
  checkAbort(signal)
  if (await tools.root() !== root) throw fault('workspace-changed', '检查期间工作区已改变，请重新检查')
  return { ok: checks.every((check) => check.status === 'ok'), environment, checks, checkedAt: Date.now() }
}

/**
 * Candidate paths for the composer's `@` picker. Paths only — no file contents are read,
 * so the list can be produced before the user approves anything.
 */
export async function findWorkspaceFiles({ cwd, query = '', env = process.env, limit = 30, maxEntries = 3000 } = {}) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw fault('workspace-invalid', '工作区必须是绝对目录')
  const root = await realpath(cwd)
  const directory = await stat(root)
  if (!directory.isDirectory()) throw fault('workspace-invalid', '当前工作区不是目录')
  const files = []
  const pending = [{ path: root, depth: 0 }]
  const visited = new Set()
  let inspected = 0, truncated = false
  while (pending.length && inspected < maxEntries && files.length < 600) {
    const next = pending.pop()
    if (visited.has(next.path)) continue
    const canonical = await realpath(next.path).catch(() => null)
    if (canonical !== next.path || !contained(root, canonical) || secretPath(displayPath(root, canonical))) { truncated = true; continue }
    visited.add(next.path)
    let handle
    try { handle = await opendir(next.path) } catch { continue }
    try {
      while (inspected < maxEntries && files.length < 600) {
        const child = await handle.read()
        if (!child) break
        inspected += 1
        if (SECRET_NAME.test(child.name) || child.isSymbolicLink()) continue
        const target = join(next.path, child.name)
        if (child.isDirectory()) {
          if (!SKIP_DIRECTORY.has(child.name) && next.depth < 12) pending.push({ path: target, depth: next.depth + 1 })
          else if (next.depth >= 12) truncated = true
          continue
        }
        if (!child.isFile()) continue
        try {
          const info = await stat(target)
          files.push({ path: displayPath(root, target), size: info.size, mtimeMs: info.mtimeMs })
        } catch { /* Vanished. */ }
      }
    } finally { await handle.close() }
  }
  truncated ||= pending.length > 0 || inspected >= maxEntries
  const needle = String(query).trim().toLowerCase()
  const subsequence = (text, part) => {
    let index = 0
    for (const character of part) {
      index = text.indexOf(character, index)
      if (index === -1) return false
      index += 1
    }
    return true
  }
  const score = (entry) => {
    if (!needle) return 1
    const name = basename(entry.path).toLowerCase()
    if (name.startsWith(needle)) return 5
    if (name.includes(needle)) return 4
    if (entry.path.toLowerCase().includes(needle)) return 3
    return subsequence(entry.path.toLowerCase(), needle) ? 1 : 0
  }
  const matches = files.map((entry) => ({ ...entry, score: score(entry) })).filter((entry) => entry.score > 0)
  matches.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
  return { files: matches.slice(0, Math.max(1, Math.min(limit, 60))).map(({ score: unused, ...entry }) => entry), truncated: truncated || matches.length > limit }
}
