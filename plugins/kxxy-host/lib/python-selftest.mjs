/**
 * 内置 Python 的只读功能自检。
 *
 * `import` 成功不等于原生后端能用，`pip check` 失败也不一定是整个库坏了。
 * 两层分开取证：受控探针做内存里的小计算；同一个解释器另外跑 pip check。
 * 不走 PATH / shell，不安装、不改 WHEEL、不往 pip 的 supported tags 里塞假标签。
 *
 * @module kxxy-host/python-selftest
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

/** 两个子进程共用预算；pip 另有限额，不能给每个库各等八秒。 */
export const PYTHON_TIMEOUT_MS = 8000
export const PYTHON_PIP_TIMEOUT_MS = 4000
export const PYTHON_MAX_OUTPUT_BYTES = 64 * 1024
export const PYTHON_DETAIL_LIMIT = 1800
const LOG_LIMIT = 4096
const PROBE_FILE = fileURLToPath(new URL('./python-probe.py', import.meta.url))
const PROBE_KIND = 'kxxy-python-selftest'

const CHECKS = [
  ['PYTHON_CFFI', 'Python CFFI 与原生后端', 'cffi', ['cffi', '_cffi_backend', 'pycparser']],
  ['PYTHON_AESGCM', 'Python AES-GCM 加解密', 'aesgcm', ['cryptography']],
  ['PYTHON_OPENSSL', 'Python OpenSSL 后端', 'openssl', ['cryptography']],
  ['PYTHON_NUMPY', 'Python NumPy 向量与矩阵', 'numpy', ['numpy']],
  ['PYTHON_PSUTIL', 'Python psutil 本进程内存', 'psutil', ['psutil']],
]
const MODULES = ['cffi', '_cffi_backend', 'pycparser', 'cryptography', 'numpy', 'psutil', 'pip']
const WHEELS = ['cffi', 'pycparser', 'cryptography', 'numpy', 'psutil', 'pip']
const PIP_ARGS = ['-I', '-B', '-m', 'pip', 'check']

export const PYTHON_ITEM_IDS = ['PYTHON', ...CHECKS.map(([id]) => id), 'PYTHON_PIP']

function clipped(value, limit = PYTHON_DETAIL_LIMIT) {
  const text = String(value ?? '').replace(/\u0000/g, '\\0')
  return text.length > limit ? `${text.slice(0, limit - 7)}…（已截断）` : text
}

function item(id, title, status, detail, hint, evidence) {
  const result = { id, title, status, detail: clipped(detail) }
  if (hint) result.hint = clipped(hint)
  if (evidence) result.evidence = evidence
  return result
}

function unavailable(status, detail, hint) {
  return [
    item('PYTHON', 'Python 解释器与隔离环境', status, detail, hint),
    ...CHECKS.map(([id, title]) => item(id, title, 'skip', '未获得可信的引擎 Python 探针结果，不能判断此功能')),
    item('PYTHON_PIP', 'Python 依赖与 WHEEL 标签', 'skip', '未运行 pip check（不能改用宿主 Python 代测）'),
  ]
}

// ---------------------------------------------------------------------------
// 判定：只读观察值，离线测试不需要 Android / 已安装的 Python 包。
// ---------------------------------------------------------------------------

function commandProblem(r, title) {
  if (r?.error?.code === 'ETIMEDOUT' || r?.timedOut) {
    return `${title}超时（上限 ${r?.timeoutMs ?? PYTHON_TIMEOUT_MS}ms），未完成不等于库不可用`
  }
  if (r?.error?.code === 'ENOBUFS' ||
      Buffer.byteLength(String(r?.out ?? ''), 'utf8') > PYTHON_MAX_OUTPUT_BYTES ||
      Buffer.byteLength(String(r?.err ?? ''), 'utf8') > PYTHON_MAX_OUTPUT_BYTES) {
    return `${title}输出超过 ${PYTHON_MAX_OUTPUT_BYTES} 字节上限，不能凭截断的输出判为通过`
  }
  if (r?.error) {
    const code = r.error.code || '启动错误'
    const extra = code === 'ENOENT' ? '（路径检查时解释器在；还需检查动态加载器、脚本解释器或工作目录）' : ''
    return `${title}启动失败：${code}${extra} ${clipped(r.error.message, 400)}`
  }
  if (r?.signal) return `${title}被 ${r.signal} 终止，未取得完整结果`
  if (!Number.isInteger(r?.code)) return `${title}没有返回有效退出码`
  return null
}

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function strings(value) {
  return Array.isArray(value) && value.every((x) => typeof x === 'string')
}

function parseProbe(r) {
  const problem = commandProblem(r, 'Python 功能探针')
  if (problem) return { problem }
  if (r.code !== 0) {
    return { problem: `Python 功能探针退出码 ${r.code}：${clipped(r.err || r.out || '没有输出', 600)}` }
  }
  let value
  try {
    // 不从杂乱输出里捞最后一行 JSON：崩溃/打印了半份报告不能变成一页绿灯。
    value = JSON.parse(String(r.out ?? '').trim())
  } catch {
    return { problem: `Python 功能探针没有返回完整 JSON：${clipped(r.out || r.err || '空输出', 400)}` }
  }
  const runtime = value?.runtime
  const packaging = value?.packaging
  const valid = value?.kind === PROBE_KIND && value?.schema === 1 && object(runtime) &&
    ['version', 'executable', 'prefix', 'basePrefix', 'platform', 'sysconfigPlatform', 'machine', 'requestedExecutable']
      .every((key) => typeof runtime[key] === 'string' && runtime[key].length > 0) &&
    (runtime.soabi === null || typeof runtime.soabi === 'string') &&
    ['isolated', 'dontWriteBytecode', 'sameExecutable'].every((key) => typeof runtime[key] === 'boolean') &&
    object(value.modules) && MODULES.every((key) => {
      const mod = value.modules[key]
      return object(mod) && typeof mod.ok === 'boolean' &&
        (mod.path === null || typeof mod.path === 'string') &&
        (mod.version === null || typeof mod.version === 'string') &&
        (mod.ok || typeof mod.error === 'string')
    }) &&
    object(value.checks) && CHECKS.every(([, , key]) =>
      object(value.checks[key]) && typeof value.checks[key].ok === 'boolean' &&
      typeof value.checks[key].detail === 'string' && value.checks[key].detail.length > 0) &&
    object(packaging) && typeof packaging.ok === 'boolean' &&
    packaging.source === 'pip._internal.utils.compatibility_tags.get_supported' && strings(packaging.supportedTags) &&
    (!packaging.ok || packaging.supportedTags.length > 0) &&
    packaging.supportedTags.length <= 64 && Number.isInteger(packaging.supportedTagCount) &&
    packaging.supportedTagCount >= packaging.supportedTags.length &&
    packaging.supportedTagsTruncated === (packaging.supportedTagCount > packaging.supportedTags.length) &&
    object(packaging.wheels) && WHEELS.every((key) => {
      const wheel = packaging.wheels[key]
      return object(wheel) && typeof wheel.ok === 'boolean' && strings(wheel.tags) && wheel.tags.length <= 16 &&
        Number.isInteger(wheel.tagCount) && wheel.tagCount >= wheel.tags.length &&
        wheel.tagsTruncated === (wheel.tagCount > wheel.tags.length) &&
        (wheel.ok ? typeof wheel.version === 'string' && typeof wheel.location === 'string' &&
          typeof wheel.hasWheel === 'boolean' && typeof wheel.supported === 'boolean' && typeof wheel.legacyPlatformOnly === 'boolean' &&
          Array.isArray(wheel.legacyMatches) && wheel.legacyMatches.length <= 16 &&
          wheel.legacyMatches.every((match) => object(match) && typeof match.wheel === 'string' && typeof match.supported === 'string')
          : !packaging.ok && typeof wheel.error === 'string')
    }) && typeof value.diagnostics === 'string'
  if (!valid) return { problem: 'Python 功能探针 JSON 协议/字段不完整（预期 schema=1），不能判断各模块' }
  return { value }
}

function runtimeProblem(runtime, executable) {
  if (runtime.requestedExecutable !== executable || !runtime.sameExecutable) {
    return `探针实际解释器与指定引擎解释器不一致：指定 ${executable}；sys.executable=${runtime.executable}`
  }
  if (!runtime.isolated || !runtime.dontWriteBytecode) {
    return 'Python 隔离参数没有生效（要求 -I -B），不继续运行 pip check'
  }
  return null
}

function moduleText(modules, names) {
  return names.map((name) => {
    const mod = modules[name]
    return `${name} ${mod.version || '(版本未知)'} @ ${mod.path || '(未导入)'}${mod.ok ? '' : `：${mod.error}`}`
  }).join('；')
}

/**
 * 降黄必须同时有三份证据：计算通过、原 WHEEL 确实只有旧平台名、pip 的真实
 * supported tags 里存在同解释器/ABI 的 Android arm64 标签。只按包名放行会
 * 把 cp313/cp314、arm/x86 等真 ABI 错误也吞掉。这里没有生成或注册新标签。
 */
function legacyOnly(value, name, version) {
  const wheel = value.packaging.wheels[name]
  const mod = value.modules[name]
  if (!['numpy', 'psutil'].includes(name) || !value.checks[name]?.ok || !mod?.ok ||
      !wheel?.ok || !wheel.hasWheel || !value.packaging.ok || wheel.version !== version || mod.version !== version ||
      wheel.supported || !wheel.legacyPlatformOnly || wheel.tagsTruncated || !wheel.tags.length) return false
  return wheel.tags.every((tag) => {
    const old = /^([a-z0-9_]+)-([a-z0-9_]+)-android_aarch64$/.exec(tag)
    return old && wheel.legacyMatches.some((match) => {
      const supported = typeof match?.supported === 'string'
        ? /^([a-z0-9_]+)-([a-z0-9_]+)-android_\d+_arm64_v8a$/.exec(match.supported) : null
      return match?.wheel === tag && supported && old[1] === supported[1] && old[2] === supported[2] &&
        (value.packaging.supportedTagsTruncated || value.packaging.supportedTags.includes(match.supported))
    })
  })
}

function pipConclusion(value, pip) {
  if (!pip) return { status: 'fail', detail: '未取得 pip check 结果（功能探针已完成，依赖检查仍未完成）', legacy: [] }
  const problem = commandProblem(pip, 'pip check')
  if (problem) return { status: 'fail', detail: problem, legacy: [] }
  if (!value.modules.pip.ok) {
    return { status: 'fail', detail: `pip 模块导入失败：${value.modules.pip.error}`, legacy: [] }
  }
  const out = String(pip.out ?? '').trim()
  const err = String(pip.err ?? '').trim()
  const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const packaging = value.packaging
  if (!packaging.ok) {
    const errors = [packaging.error, ...WHEELS.map((name) => {
      const wheel = packaging.wheels[name]
      return wheel.ok ? '' : `${name}: ${wheel.error}`
    })].filter(Boolean).join('；')
    return { status: 'fail', detail: `pip 标签/元数据采集失败：${errors || '没有完整证据'}；pip check 退出码 ${pip.code}：${clipped(err || out, 600)}`, legacy: [] }
  }
  if (pip.code === 0 && !err && lines.length === 1 && lines[0] === 'No broken requirements found.') {
    return { status: 'pass', detail: 'pip check：No broken requirements found.', legacy: [] }
  }
  const legacy = []
  if (pip.code === 1 && !err && lines.length > 0 && lines.every((line) => {
    const match = /^(numpy|psutil)\s+(\S+)\s+is not supported on this platform\.?$/i.exec(line)
    const name = match?.[1].toLowerCase()
    if (!match || !legacyOnly(value, name, match[2])) return false
    legacy.push(name)
    return true
  })) {
    return {
      status: 'warn', legacy: [...new Set(legacy)],
      detail: `pip check 退出码 1：仅 ${[...new Set(legacy)].join('、')} 的旧式 android_aarch64 WHEEL 标签不匹配；实际功能已通过（没有修改 pip/tags）`,
    }
  }
  return { status: 'fail', detail: `pip check 退出码 ${pip.code}：${clipped([out, err].filter(Boolean).join('\n') || '空输出', 1000)}；不能证实只有旧式平台标签告警`, legacy: [] }
}

/**
 * @param {{executable: string, probe: object, pip?: object|null}} observed
 * @returns {Array<object>} 与 runSelftest 的 Item 同形；evidence 供诊断导出。
 */
export function judgePythonSelftest({ executable, probe, pip = null }) {
  const parsed = parseProbe(probe)
  if (parsed.problem) return unavailable('fail', parsed.problem, '这里只诊断；查看解释器路径、退出码和原始输出，不要改用宿主 Python 代测。')
  const value = parsed.value
  const runtime = value.runtime
  const problem = runtimeProblem(runtime, executable)
  if (problem) return unavailable('fail', problem)
  const packaging = value.packaging
  const conclusion = pipConclusion(value, pip)
  const items = [item(
    'PYTHON', 'Python 解释器与隔离环境', 'pass',
    `Python ${runtime.version}；sys.executable=${runtime.executable}；prefix=${runtime.prefix}；base_prefix=${runtime.basePrefix}；` +
      `platform=${runtime.platform}/${runtime.sysconfigPlatform}；machine=${runtime.machine}；SOABI=${runtime.soabi || '(无)'}；-I -B 已生效`,
    undefined,
    { runtime, modules: value.modules, checks: value.checks, diagnostics: clipped(value.diagnostics, LOG_LIMIT), stderr: clipped(probe.err, LOG_LIMIT) },
  )]
  for (const [id, title, key, names] of CHECKS) {
    const check = value.checks[key]
    const modulesOk = names.every((name) => value.modules[name].ok)
    const warned = conclusion.legacy.includes(key)
    const wheel = packaging.wheels[key]
    const tags = wheel?.tags.length ? `；WHEEL=${wheel.tags.join(', ')}${wheel.tagsTruncated ? '（已截断）' : ''}` : ''
    const status = !check.ok || !modulesOk ? 'fail' : warned ? 'warn' : 'pass'
    items.push(item(id, title, status,
      `${check.detail}；${moduleText(value.modules, names)}${tags}${warned ? '；功能正常，仅旧式平台标签告警' : ''}`,
      status === 'fail'
        ? '这是实际导入/功能失败，不是仅凭 WHEEL 标签推断；需修复引擎运行时依赖与原生库，不要修改 pip 或伪造标签消警。'
        : warned ? '旧式标签影响 pip 的兼容性判定，不代表整个库不可用；保留原始标签供定位，由运行时包构建修正元数据。' : undefined,
    ))
  }
  const tags = packaging.supportedTags.slice(0, 4).join(', ')
  const wheelSummary = WHEELS.map((name) => `${name}=${packaging.wheels[name].tags.join(', ') || '(无 WHEEL 标签)'}`).join('；')
  items.push(item(
    'PYTHON_PIP', 'Python 依赖与 WHEEL 标签', conclusion.status,
    `${conclusion.detail}；${moduleText(value.modules, ['pip'])}；pip supported tags（共 ${packaging.supportedTagCount}）：${tags || '(未取得)'}${packaging.supportedTagCount > 4 ? ' …' : ''}；${wheelSummary}`,
    conclusion.status === 'fail'
      ? '依赖缺失、版本冲突、未知 pip 错误和证据不足都保留为失败；只有已验证功能且 ABI 对得上的 NumPy/psutil 旧平台标签才降为留意。'
      : undefined,
    {
      command: [executable, ...PIP_ARGS], code: pip?.code ?? null, signal: pip?.signal ?? null,
      stdout: clipped(pip?.out, LOG_LIMIT), stderr: clipped(pip?.err, LOG_LIMIT),
      outputTruncated: String(pip?.out ?? '').length > LOG_LIMIT || String(pip?.err ?? '').length > LOG_LIMIT,
      packaging,
    },
  ))
  return items
}

// ---------------------------------------------------------------------------
// 采集：只有这里能启动子进程。测试注入 spawn，不触碰设备也不探测宿主 Python。
// ---------------------------------------------------------------------------

function runCommand(spawn, executable, args, root, env, timeoutMs) {
  try {
    const r = spawn(executable, args, {
      cwd: root, env, encoding: 'utf8', shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs,
      // 原生扩展若卡住或忽略 SIGTERM，默认信号会让 spawnSync 超时后仍一直等。
      killSignal: 'SIGKILL', maxBuffer: PYTHON_MAX_OUTPUT_BYTES,
    })
    return { code: r?.status, out: r?.stdout ?? '', err: r?.stderr ?? '', error: r?.error ?? null, signal: r?.signal ?? null, timeoutMs }
  } catch (error) {
    return { code: null, out: '', err: '', error, timeoutMs }
  }
}

/**
 * @param {{root?: string, platform?: string, env?: object, exists?: Function,
 *          spawn?: Function, now?: Function}} [deps]
 * @returns {Array<object>}
 */
export function runPythonSelftest(deps = {}) {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') return unavailable('skip', 'Windows 构建机上跳过；不使用宿主 Python 冒充 Android 内置解释器')
  const root = deps.root ?? env.KXXY_ENGINE_ROOT ?? env.PREFIX ?? ''
  if (!root) return unavailable('skip', '拿不到引擎根（KXXY_ENGINE_ROOT / PREFIX），无法定位内置 Python')
  if (typeof root !== 'string' || !posix.isAbsolute(root) || root.includes('\0')) {
    return unavailable('fail', '引擎根不是有效的绝对路径，不能从当前目录或 PATH 猜 Python')
  }
  const executable = posix.join(root, 'bin', 'python3')
  try {
    if (!(deps.exists ?? existsSync)(executable)) {
      return unavailable('fail', `缺少引擎 Python 解释器：${executable}`, '必须修复内置运行时；不回退到 PATH 上的 python/python3。')
    }
  } catch (error) {
    return unavailable('fail', `无法检查引擎 Python 解释器：${executable}；${error?.code || error?.message || error}`)
  }
  const spawn = deps.spawn ?? spawnSync
  const now = deps.now ?? (() => performance.now())
  const started = now()
  const probe = runCommand(spawn, executable, ['-I', '-B', PROBE_FILE, executable], root, { ...env }, PYTHON_TIMEOUT_MS)
  const parsed = parseProbe(probe)
  if (parsed.problem || runtimeProblem(parsed.value.runtime, executable)) {
    return judgePythonSelftest({ executable, probe })
  }
  const remaining = Math.max(0, Math.min(PYTHON_TIMEOUT_MS, Math.floor(PYTHON_TIMEOUT_MS - (now() - started))))
  let pip
  if (remaining <= 0) {
    pip = { code: null, out: '', err: '', timedOut: true, timeoutMs: PYTHON_TIMEOUT_MS }
  } else {
    // 继承引擎的 PATH / LD_* / HOME 等，不继承会写日志的 pip 配置。
    // `pip check` 本身不联网；仍显式禁用配置、缓存与版本联网检查，避免用户的
    // PIP_LOG / 全局 pip.conf 把一次诊断变成写盘。Python 的 -I 不会隔离 PIP_*。
    const pipEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^PIP_/i.test(key)))
    Object.assign(pipEnv, { PIP_CONFIG_FILE: '/dev/null', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_CACHE_DIR: '1', PIP_NO_INPUT: '1' })
    pip = runCommand(spawn, executable, PIP_ARGS.slice(), root, pipEnv, Math.min(PYTHON_PIP_TIMEOUT_MS, remaining))
  }
  return judgePythonSelftest({ executable, probe, pip })
}
