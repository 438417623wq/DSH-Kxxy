import { access, realpath, stat, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { resolve, relative, isAbsolute, join, dirname, delimiter } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { CodexError, redact } from './transport.mjs'
import { workspaceEnvironment, secretPath } from './workspace-tools.mjs'

const execute = promisify(execFile)
export const CODEX_VERSION = '0.167.0'
export const CODEX_TARGET = 'aarch64-unknown-linux-musl'
export const CODEX_ARCHIVE_SHA256 = '843489acb4d4b1079745c36b03c5963b887b83155af208fd53584e33ee8eb281'
export const CODEX_BINARY_SHA256 = '2fe94d848540ff2a6868c7ebcc494126a974aa409711676d14fa0379e49e6143'
export const CHAT_UNAVAILABLE = '此版本尚未验证完全禁用工具的对话模式，已关闭该模式；不会用提示词冒充权限限制。'

export function runtimePaths(env = process.env, { requireExecutable = true } = {}) {
  const root = env.KXXY_ENGINE_ROOT
  const home = env.KXXY_CODEX_HOME || (env.DSH_HOME && join(env.DSH_HOME, '.codex-sidebar'))
  const executable = env.KXXY_CODEX_BIN || (root && join(root, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'))
  if (!home || !isAbsolute(home)) throw new CodexError('home-unavailable', '未配置独立的 Codex 用户数据目录', 503)
  if (requireExecutable && (!executable || !isAbsolute(executable))) throw new CodexError('binary-unavailable', '未配置 Codex 可执行文件；需要受校验的本机运行时', 503)
  return { home: resolve(home), executable: executable && isAbsolute(executable) ? resolve(executable) : null, root }
}

/** Never inherit unrelated account secrets, NODE_OPTIONS, or an alternate Codex home. */
export function childEnvironment(paths, env = process.env) {
  const runtime = workspaceEnvironment(paths.home, env)
  const child = runtime.env
  child.PATH = [dirname(paths.executable), child.PATH].filter(Boolean).join(delimiter)
  child.HOME ||= paths.home
  child.USERPROFILE ||= paths.home
  child.SHELL = runtime.shell
  child.CODEX_HOME = paths.home
  child.NO_COLOR = '1'
  return child
}

/** App permission execution is a separate capability, never evidence of workspace isolation. */
export async function probeNativeApp(paths, { executeFile = execute, platform = process.platform, arch = process.arch, env = childEnvironment(paths), rpc, getuid = () => process.getuid?.(), readFileImpl = readFile, hashFile = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
} } = {}) {
  const result = { available: false, executionMode: 'app-process', permissionMode: 'app-process', sandboxVerified: false, approvalPolicies: ['untrusted'], version: null, manifestVerified: false, appServerVerified: false, shellVerified: false, uid: null, selinuxContext: null, shell: null, reason: null }
  try {
    if (!paths.root || !isAbsolute(paths.root) || !paths.executable) throw new Error('未安装固定官方 Codex 运行时')
    const raw = await readFileImpl(join(paths.root, 'lib', 'codex', 'runtime.json'))
    if (Buffer.byteLength(raw) > 65536) throw new Error('Codex 运行时清单超过大小上限')
    const manifest = JSON.parse(String(raw))
    if (manifest.version !== CODEX_VERSION || manifest.target !== CODEX_TARGET || manifest.archiveSha256 !== CODEX_ARCHIVE_SHA256 || manifest.files?.codex !== CODEX_BINARY_SHA256 || manifest.executionMode !== 'app-process' || manifest.appServerVerified !== true || manifest.sandboxVerified !== false) throw new Error('Codex 运行时清单不符合固定官方应用权限合同')
    if (await realpath(paths.executable) !== await realpath(join(paths.root, 'bin', 'codex'))) throw new Error('Codex 可执行文件与固定运行时不匹配')
    await access(paths.executable, constants.X_OK)
    if (await hashFile(paths.executable) !== CODEX_BINARY_SHA256) throw new Error('Codex 官方二进制摘要不匹配')
    result.manifestVerified = true
    if (!['android', 'linux'].includes(platform) || arch !== 'arm64') throw new Error('此原生运行时仅支持 Android ARM64 应用进程')
    result.uid = getuid()
    result.selinuxContext = String(await readFileImpl('/proc/self/attr/current')).replace(/\0/g, '').trim()
    if (!Number.isInteger(result.uid) || result.uid < 10000 || !/^u:r:untrusted_app(?:_\d+)?:/.test(result.selinuxContext)) throw new Error('原生 CLI 必须在 Android 普通应用 UID 和实际应用 SELinux 域中运行')
    const version = await executeFile(paths.executable, ['--version'], { env, cwd: paths.home, timeout: 10000, maxBuffer: 65536, windowsHide: true })
    if (!new RegExp(`\\b${CODEX_VERSION.replace(/\./g, '\\.')}\\b`).test(version.stdout)) throw new Error('Codex 运行时版本不匹配')
    result.version = CODEX_VERSION
    // The pinned Linux CLI discovers bash through PATH, rather than reading SHELL.
    for (const directory of (env.PATH || '').split(delimiter)) {
      if (!directory || !isAbsolute(directory)) continue
      const candidate = join(directory, 'bash')
      try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) { result.shell = candidate; break } } catch { /* Continue PATH discovery. */ }
    }
    if (!result.shell || !inside(await realpath(paths.root), await realpath(result.shell))) throw new Error('应用运行时 bash 未出现在 Codex 的真实 PATH 中')
    if (!rpc) throw new Error('Codex app-server 尚未连接')
    // No thread/turn or model request: exercise the official server's real child execution.
    const command = 'printf "kxxy-native-app:%s:%s\\n" "$BASH_VERSION" "$BASH"; test -n "$BASH_VERSION"'
    const shellCheck = await rpc.request('command/exec', { command: [result.shell, '--noprofile', '--norc', '-c', command], cwd: paths.home, timeoutMs: 10000, outputBytesCap: 16384, sandboxPolicy: { type: 'dangerFullAccess' } }, 15000)
    if (shellCheck.exitCode !== 0 || !/^kxxy-native-app:[^:\r\n]+:\//m.test(shellCheck.stdout || '')) throw new Error(`Codex app-server 应用 Shell 验证失败：${redact(shellCheck.stderr || '未返回预期结果').slice(0, 500)}`)
    result.appServerVerified = true
    result.shellVerified = true
    result.available = true
  } catch (error) {
    result.reason = `原生 CLI 应用权限验证未通过：${redact(error.message).slice(0, 1200)}`
  }
  return result
}

export async function sessionForCodex(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !/^[\w-]{1,160}$/.test(sessionId)) throw new CodexError('session-invalid', '无效的 DSH 会话')
  let header = ctx.get('sessions')?.get(sessionId)?.header
  if (!header) {
    const persistence = ctx.get('sessionPersistence')
    if (!persistence?.list) throw new CodexError('session-unavailable', '宿主会话服务不可用', 503)
    const snapshots = await persistence.list()
    header = snapshots.find((entry) => entry.header?.id === sessionId)?.header
  }
  if (!header) throw new CodexError('session-invalid', '该 DSH 会话不存在', 404)
  return header
}

export async function workspaceForSession(ctx, sessionId) {
  const header = await sessionForCodex(ctx, sessionId)
  if (!header.cwd || !isAbsolute(header.cwd)) throw new CodexError('workspace-unavailable', '请先在 DSH 中选择有工作区的会话', 404)
  let cwd
  try { cwd = await realpath(header.cwd) } catch { throw new CodexError('workspace-unavailable', '当前工作区不可访问，请重新选择目录', 404) }
  if (!(await stat(cwd)).isDirectory()) throw new CodexError('workspace-invalid', '工作区不是目录')
  return cwd
}

export function inside(root, target) {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path))
}

export async function contextFile(cwd, name) {
  if (typeof name !== 'string' || !name || name.length > 2048 || name.includes('\0') || isAbsolute(name) || /^[A-Za-z]:/.test(name) || (process.platform === 'win32' && name.includes(':'))) throw new CodexError('file-invalid', '文件路径必须相对于当前工作区')
  const path = await realpath(resolve(cwd, name))
  if (!inside(cwd, path)) throw new CodexError('file-outside', '不能引用工作区外的文件', 403)
  if (secretPath(name) || secretPath(path)) throw new CodexError('sensitive-file', '不能直接将凭据文件加入模型上下文', 403)
  const info = await stat(path)
  if (!info.isFile() || info.size > 128 * 1024) throw new CodexError('file-too-large', '只支持 128 KiB 以内的文本文件', 413)
  const data = await readFile(path)
  if (data.includes(0)) throw new CodexError('file-binary', '此处只支持文本文件')
  return { path: relative(cwd, path), text: data.toString('utf8') }
}

/** Test both allowed writes and a forbidden sibling write; success alone is not isolation. */
export async function probeRuntime(paths, { executeFile = execute, platform = process.platform, env = childEnvironment(paths) } = {}) {
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  await access(paths.executable, constants.X_OK)
  const version = await executeFile(paths.executable, ['--version'], { env, cwd: paths.home, timeout: 10000, maxBuffer: 65536, windowsHide: true })
  if (!new RegExp(`\\b${CODEX_VERSION.replace(/\./g, '\\.')}\\b`).test(version.stdout)) {
    return { version: version.stdout.trim(), agent: false, chat: false, reason: `只支持已验证协议的 Codex ${CODEX_VERSION}，当前版本不匹配`, chatReason: CHAT_UNAVAILABLE }
  }
  if (platform === 'win32') return { version: CODEX_VERSION, agent: false, chat: false, reason: '此构建尚未完成 Windows 沙箱验证', chatReason: CHAT_UNAVAILABLE }
  const directory = await mkdtemp(join(paths.home, '.sandbox-check-'))
  try {
    const cwd = join(directory, 'workspace')
    const scratch = join(directory, 'tmp')
    await mkdir(cwd)
    await mkdir(scratch)
    const outside = join(directory, 'outside.txt')
    await writeFile(outside, 'unchanged', { mode: 0o600 })
    // All paths are generated locally and passed as argv, never interpolated into shell code.
    const shell = platform === 'android' ? '/system/bin/sh' : '/bin/sh'
    const command = 'printf allowed > "$1/inside.txt" || exit 31; if printf forbidden > "$2"; then exit 32; fi; test "$(cat "$2")" = unchanged || exit 33'
    await executeFile(paths.executable, ['sandbox', '-P', ':workspace', '-C', cwd, '--', shell, '-c', command, 'codex-sandbox-check', cwd, outside], {
      cwd,
      env: { ...env, TMPDIR: scratch, TEMP: scratch, TMP: scratch },
      timeout: 12000,
      maxBuffer: 65536,
      windowsHide: true,
    })
    if (await readFile(outside, 'utf8') !== 'unchanged' || await readFile(join(cwd, 'inside.txt'), 'utf8') !== 'allowed') throw new Error('沙箱未能隔离工作区外写入')
    return { version: CODEX_VERSION, agent: true, chat: false, reason: null, chatReason: CHAT_UNAVAILABLE }
  } catch (error) {
    return { version: CODEX_VERSION, agent: false, chat: false, reason: `本机沙箱验证未通过：${redact(error.stderr || error.message).trim().slice(0, 1200)}`, chatReason: CHAT_UNAVAILABLE }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
