/**
 * 内置 Python 自检的离线回归：只注入观察值，不要求 Android 或安装第三方包。
 *
 * node tools/test-python-selftest.mjs
 * node tools/test-python-selftest.mjs --python <绝对路径的测试 Python>
 *
 * 第二种另外执行受控探针的协议/只读/故障注入测试。此解释器只供测试，不传给
 * 应用的 runPythonSelftest；Windows 应用路径始终 skip，不能冒充 Android 验收。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { posix, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PYTHON_DETAIL_LIMIT,
  PYTHON_ITEM_IDS,
  PYTHON_MAX_OUTPUT_BYTES,
  PYTHON_PIP_TIMEOUT_MS,
  PYTHON_TIMEOUT_MS,
  judgePythonSelftest,
  runPythonSelftest,
} from '../plugins/kxxy-host/lib/python-selftest.mjs'

const ROOT = '/data/user/0/app.kxxy/files/engine'
const MODULE_NAMES = ['cffi', '_cffi_backend', 'pycparser', 'cryptography', 'numpy', 'psutil', 'pip']
const DIST_NAMES = ['cffi', 'pycparser', 'cryptography', 'numpy', 'psutil', 'pip']
const VERSIONS = { cffi: '2.0.0', _cffi_backend: '2.0.0', pycparser: '3.0', cryptography: '50.0.2', numpy: '2.5.4', psutil: '7.2.2', pip: '26.2.1' }
const TAG = 'cp314-cp314-android_24_arm64_v8a'
const OLD_TAG = 'cp314-cp314-android_aarch64'
const PROBE_FILE = fileURLToPath(new URL('../plugins/kxxy-host/lib/python-probe.py', import.meta.url))

/** 两份自检测试共用协议夹具，免得旧七项的集成测试另抄一份并漂移。 */
export function pythonProbeFixture(root = ROOT) {
  const site = `${root}/lib/python3.14/site-packages`
  return {
    kind: 'kxxy-python-selftest', schema: 1,
    runtime: {
      version: '3.14.8', executable: `${root}/bin/python3.14`, requestedExecutable: `${root}/bin/python3`,
      prefix: root, basePrefix: root, platform: 'android', sysconfigPlatform: 'android-24-arm64_v8a',
      machine: 'aarch64', soabi: 'cpython-314-aarch64-linux-android',
      isolated: true, dontWriteBytecode: true, sameExecutable: true,
    },
    modules: Object.fromEntries(MODULE_NAMES.map((name) => [name, {
      ok: true, path: `${site}/${name}/${name === '_cffi_backend' ? '_cffi_backend.so' : '__init__.py'}`, version: VERSIONS[name],
    }])),
    checks: {
      cffi: { ok: true, detail: 'FFI cdef/new/buffer 读写通过' },
      aesgcm: { ok: true, detail: 'AES-GCM roundtrip 通过；篡改密文按预期抛 InvalidTag' },
      openssl: { ok: true, detail: 'OpenSSL 后端初始化与 SHA-256 通过：OpenSSL 3.6.0' },
      numpy: { ok: true, detail: 'NumPy 向量/dot=14、矩阵乘法与线性方程解通过' },
      psutil: { ok: true, detail: 'psutil 读取本进程通过：pid=123；rss=65536 bytes' },
    },
    packaging: {
      ok: true, source: 'pip._internal.utils.compatibility_tags.get_supported',
      supportedTags: [TAG, 'cp314-abi3-android_24_arm64_v8a', 'cp39-abi3-android_24_arm64_v8a', 'py3-none-any'],
      supportedTagCount: 4, supportedTagsTruncated: false,
      wheels: Object.fromEntries(DIST_NAMES.map((name) => [name, {
        ok: true, version: VERSIONS[name], location: `${site}/${name}-${VERSIONS[name]}.dist-info`, hasWheel: true,
        tags: ['pycparser', 'pip'].includes(name) ? ['py3-none-any'] : [TAG], tagCount: 1, tagsTruncated: false,
        supported: true, legacyPlatformOnly: false, legacyMatches: [],
      }])),
    },
    diagnostics: '',
  }
}

export function pythonSpawnFixture(file, args) {
  return {
    status: 0, stdout: args.includes('-m') ? 'No broken requirements found.\n' : JSON.stringify(pythonProbeFixture(posix.dirname(posix.dirname(file)))),
    stderr: '', error: null, signal: null,
  }
}

function command(out = 'No broken requirements found.\n', code = 0, err = '') {
  return { code, out, err, error: null, signal: null }
}

function probe(value = pythonProbeFixture()) {
  return command(JSON.stringify(value))
}

function judge(value = pythonProbeFixture(), pip = command(), observed = probe(value)) {
  return judgePythonSelftest({ executable: `${ROOT}/bin/python3`, probe: observed, pip })
}

function byId(items, id) {
  return items.find((entry) => entry.id === id)
}

function legacyFixture(names = ['numpy', 'psutil']) {
  const value = pythonProbeFixture()
  for (const name of names) {
    Object.assign(value.packaging.wheels[name], {
      tags: [OLD_TAG], supported: false, legacyPlatformOnly: true,
      legacyMatches: [{ wheel: OLD_TAG, supported: TAG }],
    })
  }
  return value
}

const LEGACY_OUTPUT = 'numpy 2.5.4 is not supported on this platform\npsutil 7.2.2 is not supported on this platform\n'

async function runTests() {
  let passed = 0
  let failed = 0
  async function check(name, operation) {
    try {
      await operation()
      passed += 1
      console.log(`  PASS ${name}`)
    } catch (error) {
      failed += 1
      console.error(`  FAIL ${name}\n${error.stack || error}`)
    }
  }

  console.log('\n[1] 功能判定与逐项证据')
  await check('全绿：固定七项、路径/版本/SOABI 与 supported tags 可诊断', () => {
    const items = judge()
    assert.deepEqual(items.map((entry) => entry.id), PYTHON_ITEM_IDS)
    assert(items.every((entry) => entry.status === 'pass'))
    assert.match(items[0].detail, /sys\.executable=.*python3\.14/)
    assert.match(items[0].detail, /prefix=.*platform=android.*SOABI=cpython-314/)
    assert.match(byId(items, 'PYTHON_CFFI').detail, /cffi 2\.0\.0 @.*_cffi_backend 2\.0\.0/)
    assert.match(byId(items, 'PYTHON_OPENSSL').detail, /OpenSSL 3\.6\.0/)
    assert.match(byId(items, 'PYTHON_PSUTIL').detail, /pid=123；rss=65536/)
    assert.deepEqual(byId(items, 'PYTHON_PIP').evidence.packaging.supportedTags, pythonProbeFixture().packaging.supportedTags)
    assert.equal(byId(items, 'PYTHON_PIP').evidence.packaging.wheels.numpy.tags[0], TAG)
  })

  for (const name of ['cffi', '_cffi_backend', 'pycparser']) {
    await check(`缺 ${name}：CFFI 失败，独立功能的成功不被抹掉`, () => {
      const value = pythonProbeFixture()
      value.modules[name] = { ok: false, path: null, version: null, error: `ModuleNotFoundError: No module named '${name}'` }
      value.checks.cffi = { ok: false, detail: `ImportError: ${name} 未能导入` }
      const items = judge(value, command(`cryptography 50.0.2 requires ${name}, which is not installed.\n`, 1))
      assert.equal(byId(items, 'PYTHON_CFFI').status, 'fail')
      assert.match(byId(items, 'PYTHON_CFFI').detail, new RegExp(name))
      assert.equal(byId(items, 'PYTHON_NUMPY').status, 'pass')
      assert.equal(byId(items, 'PYTHON_AESGCM').status, 'pass')
      assert.equal(byId(items, 'PYTHON_PIP').status, 'fail')
    })
  }
  for (const [key, id] of [['cffi', 'PYTHON_CFFI'], ['aesgcm', 'PYTHON_AESGCM'], ['openssl', 'PYTHON_OPENSSL'], ['numpy', 'PYTHON_NUMPY'], ['psutil', 'PYTHON_PSUTIL']]) {
    await check(`import 都成功但 ${key} 功能失败：仍报 fail`, () => {
      const value = pythonProbeFixture()
      value.checks[key] = { ok: false, detail: 'AssertionError: injected functional failure' }
      const items = judge(value)
      assert.equal(byId(items, id).status, 'fail')
      assert.match(byId(items, id).detail, /injected functional failure/)
      assert.equal(items.filter((entry) => entry.status === 'fail').length, 1)
    })
  }
  await check('检查称成功但模块导入失败：不能假绿', () => {
    const value = pythonProbeFixture()
    value.modules._cffi_backend = { ok: false, path: null, version: null, error: 'ModuleNotFoundError: _cffi_backend' }
    assert.equal(byId(judge(value), 'PYTHON_CFFI').status, 'fail')
  })

  console.log('\n[2] pip：仅已证实的旧平台标签降黄')
  await check('NumPy/psutil 只有 legacy android_aarch64 标签：两库与 pip 为 warn', () => {
    const items = judge(legacyFixture(), command(LEGACY_OUTPUT, 1))
    assert.equal(byId(items, 'PYTHON_NUMPY').status, 'warn')
    assert.equal(byId(items, 'PYTHON_PSUTIL').status, 'warn')
    assert.equal(byId(items, 'PYTHON_PIP').status, 'warn')
    assert.equal(items.filter((entry) => entry.status === 'fail').length, 0)
    assert.match(byId(items, 'PYTHON_NUMPY').detail, /功能正常，仅旧式平台标签/)
    assert.equal(byId(items, 'PYTHON_PIP').evidence.stdout, LEGACY_OUTPUT)
    assert.equal(byId(items, 'PYTHON_PIP').evidence.packaging.wheels.numpy.tags[0], OLD_TAG)
  })
  await check('psutil abi3 与 pip 集合中的真实标签匹配：可降黄', () => {
    const value = legacyFixture(['psutil'])
    const old = 'cp39-abi3-android_aarch64'
    const supported = 'cp39-abi3-android_24_arm64_v8a'
    value.packaging.wheels.psutil.tags = [old]
    value.packaging.wheels.psutil.legacyMatches = [{ wheel: old, supported }]
    assert.equal(byId(judge(value, command('psutil 7.2.2 is not supported on this platform\n', 1)), 'PYTHON_PIP').status, 'warn')
  })
  await check('supported tags 截取前64项不丢低位 ABI 匹配证据', () => {
    const value = legacyFixture(['psutil'])
    const old = 'cp39-abi3-android_aarch64'
    value.packaging.wheels.psutil.tags = [old]
    value.packaging.wheels.psutil.legacyMatches = [{ wheel: old, supported: 'cp39-abi3-android_24_arm64_v8a' }]
    value.packaging.supportedTags = [TAG]
    value.packaging.supportedTagCount = 500
    value.packaging.supportedTagsTruncated = true
    assert.equal(byId(judge(value, command('psutil 7.2.2 is not supported on this platform\n', 1)), 'PYTHON_PIP').status, 'warn')
  })
  for (const [name, edit] of [
    ['功能失败', (value) => { value.checks.numpy.ok = false }],
    ['不是旧平台标签', (value) => { value.packaging.wheels.numpy.tags = ['cp314-cp314-manylinux_2_17_aarch64'] }],
    ['解释器 ABI 不同', (value) => { value.packaging.wheels.numpy.legacyMatches[0].supported = 'cp313-cp313-android_24_arm64_v8a' }],
    ['不是 Android arm64', (value) => { value.packaging.wheels.numpy.legacyMatches[0].supported = 'cp314-cp314-android_24_x86_64' }],
    ['metadata 版本不同', (value) => { value.packaging.wheels.numpy.version = '2.5.3' }],
    ['import 版本不同', (value) => { value.modules.numpy.version = '2.5.3' }],
    ['旧标签与其它标签混用', (value) => { value.packaging.wheels.numpy.tags.push('cp314-cp314-linux_aarch64'); value.packaging.wheels.numpy.tagCount = 2 }],
    ['WHEEL 标签已截断', (value) => { value.packaging.wheels.numpy.tagsTruncated = true; value.packaging.wheels.numpy.tagCount = 17 }],
    ['WHEEL 不存在', (value) => { value.packaging.wheels.numpy.hasWheel = false }],
    ['没有匹配证据', (value) => { value.packaging.wheels.numpy.legacyMatches = [] }],
    ['完整 supported 集合却没有匹配项', (value) => { value.packaging.supportedTags = ['py3-none-any']; value.packaging.supportedTagCount = 1 }],
    ['原标签其实已支持', (value) => { value.packaging.wheels.numpy.supported = true }],
  ]) {
    await check(`${name}：不能仅凭包名吞掉 pip 失败`, () => {
      const value = legacyFixture()
      edit(value)
      const items = judge(value, command(LEGACY_OUTPUT, 1))
      assert.equal(byId(items, 'PYTHON_PIP').status, 'fail')
    })
  }
  for (const [name, pip] of [
    ['缺 cffi', command(LEGACY_OUTPUT + 'cryptography 50.0.2 requires cffi, which is not installed.\n', 1)],
    ['cffi 版本不满足', command('cryptography 50.0.2 has requirement cffi>=2.0.0, but you have cffi 1.17.1.\n', 1)],
    ['其它包不支持', command(LEGACY_OUTPUT + 'otherlib 1.0 is not supported on this platform\n', 1)],
    ['未知输出', command(LEGACY_OUTPUT + 'mystery failure\n', 1)],
    ['stderr 也有错', command(LEGACY_OUTPUT, 1, 'WARNING: Error parsing dependencies of broken\n')],
    ['错误退出码', command(LEGACY_OUTPUT, 2)],
    ['空输出', command('', 1)],
    ['零退出码但无成功报告', command('', 0)],
    ['零退出码但错误文本', command('cryptography requires cffi\n', 0)],
    ['成功文本但有 stderr', command('No broken requirements found.\n', 0, 'unknown diagnostic')],
    ['包版本与输出不符', command('numpy 2.5.3 is not supported on this platform\n', 1)],
  ]) {
    await check(`${name}：pip 为 fail，不把库误判为损坏`, () => {
      const items = judge(legacyFixture(), pip)
      assert.equal(byId(items, 'PYTHON_PIP').status, 'fail')
      assert.equal(byId(items, 'PYTHON_NUMPY').status, 'pass')
    })
  }
  await check('pip 标签采集出错：保留元数据诊断，不假装 pip 通过', () => {
    const value = pythonProbeFixture()
    value.packaging.ok = false
    value.packaging.error = 'ImportError: pip compatibility_tags unavailable'
    const items = judge(value)
    assert.equal(byId(items, 'PYTHON_PIP').status, 'fail')
    assert.match(byId(items, 'PYTHON_PIP').detail, /compatibility_tags unavailable/)
  })
  await check('pip 模块丢失：依赖项失败', () => {
    const value = pythonProbeFixture()
    value.modules.pip = { ok: false, path: null, version: null, error: 'ModuleNotFoundError: pip' }
    assert.equal(byId(judge(value), 'PYTHON_PIP').status, 'fail')
  })

  console.log('\n[3] 坏输出与耗时/输出上限')
  for (const [name, output] of [
    ['空输出', ''], ['不是 JSON', 'random garbage'], ['额外打印', 'hello\n' + JSON.stringify(pythonProbeFixture())],
    ['截断 JSON', '{"schema":1'], ['空对象', '{}'], ['数组', '[]'], ['null', 'null'],
  ]) {
    await check(`${name}：探针失败，其它功能 skip 而不是假红/假绿`, () => {
      const items = judge(undefined, command(), command(output))
      assert.equal(items[0].status, 'fail')
      assert(items.slice(1).every((entry) => entry.status === 'skip'))
    })
  }
  for (const [name, edit] of [
    ['schema 未知', (value) => { value.schema = 99 }],
    ['缺运行时', (value) => { delete value.runtime }],
    ['缺模块', (value) => { delete value.modules._cffi_backend }],
    ['缺检查', (value) => { delete value.checks.aesgcm }],
    ['结果不是布尔', (value) => { value.checks.numpy.ok = 'true' }],
    ['缺 WHEEL', (value) => { delete value.packaging.wheels.numpy }],
    ['tags 计数不完整', (value) => { value.packaging.supportedTagCount = 500 }],
    ['不是 pip 的 tags', (value) => { value.packaging.source = 'invented-tags' }],
  ]) {
    await check(`${name}：协议失败`, () => {
      assert.equal(judge((() => { const value = pythonProbeFixture(); edit(value); return value })())[0].status, 'fail')
    })
  }
  for (const [name, observed, pattern] of [
    ['非零退出码', { ...probe(), code: 1, err: 'ImportError: interpreter init failed' }, /退出码 1.*ImportError/],
    ['超时', { ...probe(), code: null, error: { code: 'ETIMEDOUT' }, timeoutMs: 8000 }, /超时.*8000ms/],
    ['被信号终止', { ...probe(), code: null, signal: 'SIGSEGV' }, /SIGSEGV/],
    ['超限', { ...probe(), code: null, error: { code: 'ENOBUFS' } }, /输出超过/],
    ['大量 stdout', command('x'.repeat(PYTHON_MAX_OUTPUT_BYTES + 1)), /输出超过/],
    ['大量 stderr', { ...probe(), err: 'x'.repeat(PYTHON_MAX_OUTPUT_BYTES + 1) }, /输出超过/],
    ['返回形状坏', {}, /没有返回有效退出码/],
  ]) {
    await check(`${name}：结论准确并且不丢异常种类`, () => {
      const items = judge(undefined, command(), observed)
      assert.equal(items[0].status, 'fail')
      assert.match(items[0].detail, pattern)
      assert(items[0].detail.length <= PYTHON_DETAIL_LIMIT)
    })
  }
  await check('只有 pip 超时：已完成的功能证据照常保留', () => {
    const items = judge(undefined, { code: null, error: { code: 'ETIMEDOUT' }, timeoutMs: 4000 })
    assert.equal(byId(items, 'PYTHON_PIP').status, 'fail')
    assert.match(byId(items, 'PYTHON_PIP').detail, /超时.*4000ms/)
    assert(items.slice(0, -1).every((entry) => entry.status === 'pass'))
  })
  await check('大 pip 日志有界且明确标记截断', () => {
    const items = judge(undefined, command('unknown '.repeat(2000), 1))
    const pip = byId(items, 'PYTHON_PIP')
    assert.equal(pip.status, 'fail')
    assert(pip.detail.length <= PYTHON_DETAIL_LIMIT)
    assert(pip.evidence.stdout.length <= 4096)
    assert.equal(pip.evidence.outputTruncated, true)
  })

  console.log('\n[4] 采集：固定解释器、参数安全、Windows/无根跳过')
  function deps(over = {}) {
    return { platform: 'android', root: ROOT, env: { KXXY_ENGINE_ROOT: ROOT, PATH: '/host/python-first', LD_LIBRARY_PATH: `${ROOT}/lib` }, exists: () => true, spawn: pythonSpawnFixture, now: () => 0, ...over }
  }
  await check('Windows 硬跳过，不检查文件也不启动任何 Python', () => {
    const no = () => { throw new Error('must not run') }
    const items = runPythonSelftest(deps({ platform: 'win32', spawn: no, exists: no }))
    assert(items.every((entry) => entry.status === 'skip'))
    assert.match(items[0].detail, /Windows.*宿主 Python/)
  })
  await check('无 root 硬跳过，不从 PATH 找宿主解释器', () => {
    const items = runPythonSelftest(deps({ root: '', spawn: () => { throw new Error('must not run') } }))
    assert(items.every((entry) => entry.status === 'skip'))
    assert.match(items[0].detail, /拿不到引擎根/)
  })
  await check('无绝对 root 是错误，不相对 cwd 执行', () => {
    const items = runPythonSelftest(deps({ root: 'relative/engine' }))
    assert.equal(items[0].status, 'fail')
    assert.match(items[0].detail, /绝对路径/)
  })
  await check('解释器缺失：一项 fail，其余未验证 skip', () => {
    const calls = []
    const items = runPythonSelftest(deps({ exists: (file) => { calls.push(file); return false } }))
    assert.deepEqual(calls, [`${ROOT}/bin/python3`])
    assert.equal(items[0].status, 'fail')
    assert.match(items[0].detail, /缺少引擎 Python 解释器/)
    assert(items.slice(1).every((entry) => entry.status === 'skip'))
  })
  await check('文件在但 ENOENT：不武断说 Python 文件不存在', () => {
    const items = runPythonSelftest(deps({ spawn: () => { throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' }) } }))
    assert.equal(items[0].status, 'fail')
    assert.match(items[0].detail, /路径检查时解释器在.*动态加载器/)
  })
  await check('文件读取检查抛错：不让整个自检请求崩掉', () => {
    const items = runPythonSelftest(deps({ exists: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }))
    assert.equal(items[0].status, 'fail')
    assert.match(items[0].detail, /EACCES/)
  })
  await check('受控路径含引号、分号、美元、空格：直接 argv，无 shell 拼接', () => {
    const root = "/data/engine a';$(touch should-not-exist) & `id`"
    const calls = []
    const env = Object.freeze({ PATH: '/host/bin', LD_LIBRARY_PATH: `${root}/lib`, LD_PRELOAD: '/engine/lib/libtermux-exec.so',
      HOME: '/engine/home', DSH_HOME: '/engine/dsh-home', PYTHONPATH: '/untrusted', PIP_LOG: '/would-write/log',
      PIP_LOG_FILE: '/would-write/other', PIP_TARGET: '/host/site-packages', PIP_CONFIG_FILE: '/would-write/pip.conf' })
    const items = runPythonSelftest(deps({ root, env, spawn: (file, args, options) => {
      calls.push({ file, args, options })
      return pythonSpawnFixture(file, args)
    } }))
    assert(items.every((entry) => entry.status === 'pass'))
    assert.equal(calls.length, 2)
    assert.equal(calls[0].file, `${root}/bin/python3`)
    assert.equal(calls[1].file, calls[0].file)
    assert.deepEqual(calls[0].args, ['-I', '-B', PROBE_FILE, calls[0].file])
    assert.deepEqual(calls[1].args, ['-I', '-B', '-m', 'pip', 'check'])
    for (const call of calls) {
      assert.equal(call.options.shell, false)
      assert.equal(call.options.cwd, root)
      assert.equal(call.options.maxBuffer, PYTHON_MAX_OUTPUT_BYTES)
      assert.equal(call.options.killSignal, 'SIGKILL')
      assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'])
      for (const key of ['PATH', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'HOME', 'DSH_HOME', 'PYTHONPATH']) assert.equal(call.options.env[key], env[key])
    }
    assert.deepEqual(calls[0].options.env, env)
    assert.equal(calls[1].options.env.PIP_LOG, undefined)
    assert.equal(calls[1].options.env.PIP_LOG_FILE, undefined)
    assert.equal(calls[1].options.env.PIP_TARGET, undefined)
    assert.equal(calls[1].options.env.PIP_CONFIG_FILE, '/dev/null')
    assert.equal(calls[1].options.env.PIP_NO_CACHE_DIR, '1')
    assert.equal(calls[1].options.env.PIP_DISABLE_PIP_VERSION_CHECK, '1')
    assert.equal(env.PIP_LOG, '/would-write/log')
  })
  await check('可从注入 engine env 定位 root，绝不读宿主 PATH 解析命令', () => {
    let file
    const items = runPythonSelftest(deps({ root: undefined, spawn: (executable, args) => { file = executable; return pythonSpawnFixture(executable, args) } }))
    assert.equal(file, `${ROOT}/bin/python3`)
    assert.equal(items[0].status, 'pass')
  })
  await check('总预算扣掉探针耗时，pip 不再另等完整上限', () => {
    const ticks = [100, 6600]
    const timeouts = []
    const items = runPythonSelftest(deps({ now: () => ticks.shift(), spawn: (file, args, options) => {
      timeouts.push(options.timeout)
      return pythonSpawnFixture(file, args)
    } }))
    assert(items.every((entry) => entry.status === 'pass'))
    assert.deepEqual(timeouts, [PYTHON_TIMEOUT_MS, 1500])
  })
  await check('快探针之后 pip 也最多4秒', () => {
    const timeouts = []
    runPythonSelftest(deps({ spawn: (file, args, options) => { timeouts.push(options.timeout); return pythonSpawnFixture(file, args) } }))
    assert.deepEqual(timeouts, [PYTHON_TIMEOUT_MS, PYTHON_PIP_TIMEOUT_MS])
  })
  await check('探针耗完总预算：不再启动 pip，明确依赖检查超时', () => {
    const ticks = [0, PYTHON_TIMEOUT_MS + 100]
    let calls = 0
    const items = runPythonSelftest(deps({ now: () => ticks.shift(), spawn: (file, args) => { calls++; return pythonSpawnFixture(file, args) } }))
    assert.equal(calls, 1)
    assert.equal(byId(items, 'PYTHON_NUMPY').status, 'pass')
    assert.equal(byId(items, 'PYTHON_PIP').status, 'fail')
    assert.match(byId(items, 'PYTHON_PIP').detail, /超时/)
  })
  for (const [name, observed] of [
    ['乱输出', { status: 0, stdout: 'garbage', stderr: '' }],
    ['超时', { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } }],
    ['隔离失效', (() => { const value = pythonProbeFixture(); value.runtime.isolated = false; return { status: 0, stdout: JSON.stringify(value) } })()],
    ['字节码写保护失效', (() => { const value = pythonProbeFixture(); value.runtime.dontWriteBytecode = false; return { status: 0, stdout: JSON.stringify(value) } })()],
    ['解释器错位', (() => { const value = pythonProbeFixture(); value.runtime.sameExecutable = false; return { status: 0, stdout: JSON.stringify(value) } })()],
    ['请求路径错位', (() => { const value = pythonProbeFixture(); value.runtime.requestedExecutable = '/usr/bin/python3'; return { status: 0, stdout: JSON.stringify(value) } })()],
  ]) {
    await check(`${name}：不继续启动 pip`, () => {
      let calls = 0
      const items = runPythonSelftest(deps({ spawn: () => { calls++; return observed } }))
      assert.equal(calls, 1)
      assert.equal(items[0].status, 'fail')
      assert.equal(byId(items, 'PYTHON_PIP').status, 'skip')
    })
  }
  await check('合法报告中部分功能失败：仍运行 pip 收集其它依赖证据', () => {
    let calls = 0
    const items = runPythonSelftest(deps({ spawn: (file, args) => {
      calls++
      if (calls === 2) return pythonSpawnFixture(file, args)
      const value = pythonProbeFixture()
      value.checks.cffi = { ok: false, detail: 'ModuleNotFoundError: _cffi_backend' }
      return { status: 0, stdout: JSON.stringify(value) }
    } }))
    assert.equal(calls, 2)
    assert.equal(byId(items, 'PYTHON_CFFI').status, 'fail')
    assert.equal(byId(items, 'PYTHON_PIP').status, 'pass')
  })

  const pythonFlag = process.argv.indexOf('--python')
  if (pythonFlag !== -1) {
    const python = process.argv[pythonFlag + 1]
    if (!python || !isAbsolute(python) || !existsSync(python)) throw new Error('--python 必须显式给出存在的绝对路径，不允许回落到 PATH')
    await runProbeTests(python, check)
  } else {
    console.log('\n[5] 未提供 --python，仅运行 Node 离线回归（没有探测宿主 Python）')
  }
  console.log(`\nPython 自检离线测试：${passed} 通过 / ${failed} 失败`)
  if (failed) process.exitCode = 1
}

async function runProbeTests(python, check) {
  console.log('\n[5] 显式指定的测试 Python：受控探针协议与故障注入')
  await check('真实探针 smoke：-I -B 生效；缺包仍返回逐项结果', () => {
    const result = spawnSync(python, ['-I', '-B', PROBE_FILE, python], {
      encoding: 'utf8', timeout: PYTHON_TIMEOUT_MS, maxBuffer: PYTHON_MAX_OUTPUT_BYTES, shell: false,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    const value = JSON.parse(result.stdout)
    assert.equal(value.runtime.isolated, true)
    assert.equal(value.runtime.dontWriteBytecode, true)
    assert.equal(value.runtime.sameExecutable, true)
    assert.deepEqual(Object.keys(value.checks), ['cffi', 'aesgcm', 'openssl', 'numpy', 'psutil'])
    const items = judgePythonSelftest({ executable: python, probe: command(result.stdout), pip: command('not run in protocol smoke', 1) })
    assert.equal(items[0].status, 'pass')
    for (const entry of items) assert.notEqual(entry.status, 'skip')
  })
  await check('探针源码故障注入：CFFI/AEAD/OpenSSL/NumPy/psutil/标签/只读限制', () => {
    const result = spawnSync(python, ['-I', '-B', '-c', PYTHON_UNIT_TESTS, PROBE_FILE], {
      encoding: 'utf8', timeout: PYTHON_TIMEOUT_MS, maxBuffer: PYTHON_MAX_OUTPUT_BYTES, shell: false,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    const tested = JSON.parse(result.stdout)
    assert(tested.assertions >= 30)
    assert.equal(tested.failures, 0)
  })
  await check('探针源码没有 pip install、网络请求或临时文件落盘', () => {
    const source = readFileSync(PROBE_FILE, 'utf8')
    assert(!/\b(pip install|urlopen|requests\.|mkstemp|TemporaryDirectory|write_text|write_bytes)\b/.test(source))
  })
}

// 只在显式 --python 测试模式执行；通过内存模块桩验证探针本体，零 pip install。
// 所有夹具在内存中，不用 tempfile，也不在被读取的项目目录里运行解释器。
const PYTHON_UNIT_TESTS = String.raw`
import json, os, runpy, sys, types
from unittest.mock import patch

probe = runpy.run_path(sys.argv[1], run_name="kxxy_probe_tests")
assertions = 0

def check(value):
    global assertions
    assert value
    assertions += 1

def raises(kind, operation):
    try:
        operation()
    except kind:
        check(True)
        return
    raise AssertionError("expected " + kind.__name__)

check(not sys.dont_write_bytecode is False)
check(probe["runtime_info"](sys.executable)["sameExecutable"])
check(not probe["runtime_info"]("/__kxxy_missing_python__")["sameExecutable"])
log = probe["BoundedLog"](10)
check(log.write("x" * 100) == 100)
check(len(log.text) == 10 and log.truncated)
check("已截断" in log.value())

# 导入各自捕获异常，不让第一个缺包跳过后面的包。
mods = {name: types.SimpleNamespace(__file__="/engine/" + name, __version__="2.0.0") for name in probe["MODULE_NAMES"]}
def importer(name):
    if name == "_cffi_backend":
        raise ModuleNotFoundError("No module named '_cffi_backend'")
    return mods[name]
with patch.object(probe["importlib"], "import_module", importer):
    modules, records = probe["collect_modules"]()
check(not records["_cffi_backend"]["ok"])
check(records["numpy"]["ok"] and records["pip"]["ok"])
check("_cffi_backend" in records["_cffi_backend"]["error"])

# FFI 的声明解析/new/buffer 必须真的走到；后端/解析器缺失单独失败。
ffi_calls = []
class FFI:
    def cdef(self, source):
        ffi_calls.append("cdef")
        check("typedef struct" in source and "kxxy_probe" in source)
    def new(self, name, value):
        ffi_calls.append("new")
        return types.SimpleNamespace(value=value["value"], data=bytes(value["data"])) if isinstance(value, dict) else bytearray(value)
    def buffer(self, value, size):
        ffi_calls.append("buffer")
        return memoryview(value)[:size]
    def sizeof(self, name):
        return 8
cffi_mods = {"cffi": types.SimpleNamespace(FFI=FFI), "_cffi_backend": object(), "pycparser": object()}
check("通过" in probe["check_cffi"](cffi_mods))
check(ffi_calls.count("new") == 2 and ffi_calls.count("buffer") == 2)
raises(ImportError, lambda: probe["check_cffi"]({"cffi": cffi_mods["cffi"]}))
raises(ImportError, lambda: probe["check_cffi"]({key: val for key, val in cffi_mods.items() if key != "pycparser"}))
class BadFFI(FFI):
    def buffer(self, value, size):
        return b"bad!"
raises(AssertionError, lambda: probe["check_cffi"]({**cffi_mods, "cffi": types.SimpleNamespace(FFI=BadFFI)}))

# AEAD 正常解密不够：必须对篡改值拒绝，而且只能认 InvalidTag。
class InvalidTag(Exception):
    pass
class AESGCM:
    reject = True
    calls = []
    def __init__(self, key):
        check(len(key) == 32)
    def encrypt(self, nonce, plain, aad):
        self.plain = plain
        self.encrypted = plain + b"tag"
        AESGCM.calls.append((nonce, aad))
        return self.encrypted
    def decrypt(self, nonce, encrypted, aad):
        if encrypted != self.encrypted and self.reject:
            raise InvalidTag()
        return self.plain
crypto = types.ModuleType("cryptography")
crypto.__path__ = []
exceptions = types.ModuleType("cryptography.exceptions")
exceptions.InvalidTag = InvalidTag
hazmat = types.ModuleType("cryptography.hazmat")
hazmat.__path__ = []
primitives = types.ModuleType("cryptography.hazmat.primitives")
primitives.__path__ = []
ciphers = types.ModuleType("cryptography.hazmat.primitives.ciphers")
ciphers.__path__ = []
aead = types.ModuleType("cryptography.hazmat.primitives.ciphers.aead")
aead.AESGCM = AESGCM
backend = types.ModuleType("cryptography.hazmat.backends")
class Backend:
    openssl_version_text = lambda self: "OpenSSL test"
    openssl_version_number = lambda self: 0x30600000
    hash_supported = lambda self, algorithm: True
backend.default_backend = Backend
hashes = types.ModuleType("cryptography.hazmat.primitives.hashes")
hashes.SHA256 = lambda: object()
class Hash:
    def __init__(self, algorithm):
        self.data = b""
    def update(self, data):
        self.data += data
    def finalize(self):
        check(self.data == b"abc")
        return bytes.fromhex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
hashes.Hash = Hash
primitives.hashes = hashes
injected = {mod.__name__: mod for mod in [crypto, exceptions, hazmat, primitives, ciphers, aead, backend, hashes]}
with patch.dict(sys.modules, injected):
    check("InvalidTag" in probe["check_aesgcm"]({"cryptography": crypto}))
    AESGCM.reject = False
    raises(AssertionError, lambda: probe["check_aesgcm"]({"cryptography": crypto}))
    check("OpenSSL test" in probe["check_openssl"]({"cryptography": crypto}))
    backend.default_backend = lambda: (_ for _ in ()).throw(ImportError("backend missing"))
    raises(ImportError, lambda: probe["check_openssl"]({"cryptography": crypto}))

# 不要求宿主有 NumPy：内存里的小数组桩保证向量、dot、矩阵、solve 都被调用。
np_calls = []
class Array:
    def __init__(self, value):
        self.value = value
    def __mul__(self, factor):
        return Array([value * factor for value in self.value])
    def __add__(self, increment):
        return Array([value + increment for value in self.value])
    def __matmul__(self, other):
        np_calls.append("matmul")
        return Array([[sum(left * right for left, right in zip(row, col)) for col in zip(*other.value)] for row in self.value])
class NP:
    float64 = float
    array = staticmethod(lambda data, dtype=None: Array(data))
    array_equal = staticmethod(lambda left, right: left.value == right)
    allclose = staticmethod(lambda left, right, **kw: left.value == right)
    def dot(self, left, right):
        np_calls.append("dot")
        return sum(a * b for a, b in zip(left.value, right.value))
np = NP()
def solve(left, right):
    np_calls.append("solve")
    check(left.value == [[3.0, 1.0], [1.0, 2.0]] and right.value == [9.0, 8.0])
    return Array([2.0, 3.0])
np.linalg = types.SimpleNamespace(solve=solve)
check("通过" in probe["check_numpy"]({"numpy": np}))
check(np_calls == ["dot", "matmul", "solve"])
np.dot = lambda a, b: -1
raises(AssertionError, lambda: probe["check_numpy"]({"numpy": np}))
np.dot = lambda a, b: 14
np.linalg.solve = lambda a, b: Array([0, 0])
raises(AssertionError, lambda: probe["check_numpy"]({"numpy": np}))

# psutil 只查本进程，不扫描其它进程；pid/rss 都必须有效。
seen_pids = []
def process(pid):
    seen_pids.append(pid)
    return types.SimpleNamespace(pid=pid, memory_info=lambda: types.SimpleNamespace(rss=12345))
psutil = types.SimpleNamespace(Process=process)
check("rss=12345" in probe["check_psutil"]({"psutil": psutil}))
check(seen_pids == [os.getpid()])
psutil.Process = lambda pid: types.SimpleNamespace(pid=pid + 1, memory_info=lambda: types.SimpleNamespace(rss=12345))
raises(AssertionError, lambda: probe["check_psutil"]({"psutil": psutil}))
psutil.Process = lambda pid: types.SimpleNamespace(pid=pid, memory_info=lambda: types.SimpleNamespace(rss=0))
raises(AssertionError, lambda: probe["check_psutil"]({"psutil": psutil}))

# 单项异常捕获后其它四项仍保留，不把整个报告提前中断。
globals_for_checks = probe["collect_checks"].__globals__
with patch.dict(globals_for_checks, {
    "check_cffi": lambda mods: (_ for _ in ()).throw(ImportError("_cffi_backend")),
    "check_aesgcm": lambda mods: "aes ok", "check_openssl": lambda mods: "ssl ok",
    "check_numpy": lambda mods: "numpy ok", "check_psutil": lambda mods: "psutil ok",
}):
    checks = probe["collect_checks"]({})
check(not checks["cffi"]["ok"] and all(checks[key]["ok"] for key in ["aesgcm", "openssl", "numpy", "psutil"]))

# 用 pip 命名空间的内存桩，验证真实集合来源、WHEEL 原文、纯平台差异与坏 ABI。
class Tag:
    def __init__(self, interpreter, abi, platform):
        self.interpreter, self.abi, self.platform = interpreter, abi, platform
    def __str__(self):
        return "-".join([self.interpreter, self.abi, self.platform])
    def __hash__(self):
        return hash(str(self))
    def __eq__(self, other):
        return str(self) == str(other)
def parse_tag(text):
    return {Tag(*text.split("-"))}
compat = types.ModuleType("pip._internal.utils.compatibility_tags")
tags_module = types.ModuleType("pip._vendor.packaging.tags")
supported = [Tag("cp314", "cp314", "android_24_arm64_v8a"), Tag("cp39", "abi3", "android_24_arm64_v8a"), Tag("py3", "none", "any")]
compat.get_supported = lambda: supported
tags_module.parse_tag = parse_tag
metadata_tags = {name: "py3-none-any" for name in probe["DIST_NAMES"]}
metadata_tags.update(numpy="cp314-cp314-android_aarch64", psutil="cp39-abi3-android_aarch64")
class Dist:
    version = "2.0.0"
    _path = "/engine/site/dist-info"
    def __init__(self, name):
        self.name = name
    def locate_file(self, name):
        return "/engine/site"
    def read_text(self, name):
        check(name == "WHEEL")
        return "Wheel-Version: 1.0\nTag: " + metadata_tags[self.name] + "\n"
parents = ["pip", "pip._internal", "pip._internal.utils", "pip._vendor", "pip._vendor.packaging"]
fake_pip = {name: types.ModuleType(name) for name in parents}
for mod in fake_pip.values():
    mod.__path__ = []
fake_pip.update({compat.__name__: compat, tags_module.__name__: tags_module})
with patch.dict(sys.modules, fake_pip), patch.object(probe["metadata"], "distribution", Dist):
    data = probe["collect_packaging"]()
    check(data["ok"])
    check(data["wheels"]["numpy"]["legacyPlatformOnly"])
    check(data["wheels"]["psutil"]["legacyPlatformOnly"])
    check(data["wheels"]["numpy"]["tags"] == ["cp314-cp314-android_aarch64"])
    check(data["supportedTags"] == [str(tag) for tag in supported])
    check(data["wheels"]["psutil"]["legacyMatches"][0]["supported"] == "cp39-abi3-android_24_arm64_v8a")
    metadata_tags["numpy"] = "cp313-cp313-android_aarch64"
    check(not probe["collect_packaging"]()["wheels"]["numpy"]["legacyPlatformOnly"])
    metadata_tags["numpy"] = "cp314-cp314-linux_aarch64"
    check(not probe["collect_packaging"]()["wheels"]["numpy"]["legacyPlatformOnly"])
    metadata_tags["numpy"] = "cp314-cp314-android_24_arm64_v8a"
    check(probe["collect_packaging"]()["wheels"]["numpy"]["supported"])

# audit hook 自身不做操作：只触发禁用分支，零文件写入/网络连接。
audit = probe["readonly_audit"]
audit("open", ("/engine/lib/module.py", "r", 0))
for event, args in [("open", ("/not-created", "w", os.O_WRONLY)), ("open", ("/not-created", None, os.O_CREAT)),
                    ("socket.connect", ()), ("socket.__new__", ()), ("subprocess.Popen", ()),
                    ("os.remove", ()), ("os.rename", ()), ("os.mkdir", ()), ("os.system", ())]:
    raises(PermissionError, lambda event=event, args=args: audit(event, args))
print(json.dumps({"assertions": assertions, "failures": 0}))
`

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runTests()
