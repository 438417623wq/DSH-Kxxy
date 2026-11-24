/**
 * pydeps — 把「纯 Python 的办公/文档库」补进运行时的 user site。
 *
 * 背景（问题清单【9】）：真机探测报告 `docx / openpyxl / pptx / requests` 全部
 * `ModuleNotFoundError`，于是任何「读一个 xlsx、生成一份 docx、抓一个网页」的
 * 脚本都跑不起来。
 *
 * 为什么只补纯 Python 的那几个：
 *   · 带 C 扩展的（lxml / Pillow / pandas / matplotlib）走**运行时预装**
 *     （tools/lib/seeds.mjs 里的 Termux deb）—— PyPI 上没有 bionic 的 wheel，
 *     manylinux 的 aarch64 轮子又链 glibc，手机上现编一律失败；
 *   · 纯 Python 的没有 deb，只能 pip。而它们一旦有了 lxml/Pillow 打底，pip 落地
 *     就是纯解包，几秒钟完成，不需要编译。
 *
 * 为什么装在 **user site**（`$HOME/.local/lib/python3.14/site-packages`）而不是
 * 引擎自己的 `lib/python3.14/site-packages`：
 *   · 引擎根是**受管资产**：运行时有清单指纹（`kxxy-runtime.json` 的 entries /
 *     host fingerprint），往里塞文件会让「指纹与安装记录不符」的校验在下一次
 *     启动时拒绝安装（真机踩过）；
 *   · `$HOME` 是用户资产，运行时重装/升级都不碰，装一次长期有效；
 *   · python 默认就把 user site 放进 `sys.path`，不需要额外环境变量。
 *
 * 触发策略：每次引擎启动后台跑一次，**失败不阻塞**、也不刷屏 —— 没网时 pip 会
 * 在几十秒内超时，标记文件记下当天已试过，避免每次启动都重试。
 */
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, join, resolve, sep } from 'node:path'

/**
 * 清单版本：加/换包时改这个数字，标记文件不匹配就会重跑一次。
 *
 * v2（2026-11-17）：补 `python-dateutil` / `six` / `pytz` / `tzdata`。
 *   Termux 的 `python-pandas` 只声明 `libc++, python, python-numpy, python-pip`，
 *   **没有把 dateutil 写进 Depends**（Termux 仓库里压根没有 dateutil 包），
 *   于是 `import pandas` 在真机上死在
 *   `ImportError: Unable to import required dependency dateutil`。
 *   pytz/tzdata 是 pandas 的时区配套（3.x 起 pytz 变成可选，但 `tz_localize`
 *   的老代码仍会 import 它，纯 Python 几百 KB，一并装上）。
 *
 * v3（同日）：补 matplotlib 的四个纯 Python 依赖 —— `packaging` / `cycler` /
 *   `fonttools` / `pyparsing`。Termux 的 `matplotlib` deb 的 Depends 只写了
 *   `freetype libc++ libraqm patchelf qhull ninja python python-contourpy
 *   python-kiwisolver python-numpy python-pillow python-pip`，而这四个它既不带
 *   也不声明（Termux 仓库里也都没有），真机 `import matplotlib` 第一步就死在
 *   `ModuleNotFoundError: No module named 'packaging'`（matplotlib/__init__.py:157）。
 *
 * v4（2026-11-25）：标记文件改记「**实际被探测的解释器**」——绝对路径 + 运行模式
 *   （bionic / glibc / dispatcher 回落）+ 运行时锚（runtime 清单的 hostFingerprint
 *   或 patchset 版本）。此前只记 `revision`，于是 `engine/bin/python3` 探出 ok 之后
 *   解释器换人（glibc 容器就绪、运行时整包升级）仍然判「已就位」，用户看到的是
 *   「文档库全都 import 不到」而体检页写着 ok。探针同时改成走**当前生效**的
 *   `python3`（PATH 里引擎自己的那一条），与用户敲命令的是同一个解释器。
 */
const REVISION = 'pydeps@4'

/**
 * 要装的包。刻意**不带版本号**：这些库互相之间的兼容窗口很宽，钉死版本反而
 * 会在镜像同步滞后时卡住；需要精确版本的用户自己 `pip install foo==x.y` 即可
 * （装进同一个 user site，覆盖我们这份）。
 *
 * 全是**纯 Python**（py3-none-any 轮子），不需要编译 —— 带 C 扩展的
 * （lxml / Pillow / pandas / numpy / matplotlib）走运行时预装，见 seeds.mjs。
 */
const PACKAGES = [
  'python-docx',
  'openpyxl',
  'python-pptx',
  'requests',
  // pandas 的运行时依赖（Termux 的 pandas deb 没带）
  'python-dateutil',
  'six', // dateutil 的依赖
  'pytz',
  'tzdata',
  // matplotlib 的运行时依赖（Termux 的 matplotlib deb 同样没带）
  'packaging',
  'cycler',
  'fonttools',
  'pyparsing',
]

/**
 * 探针：**pydeps 自己装的东西**必须全部导入成功（两条模式都一样）。
 *
 * 两条都必须实测 —— 它们是「装好了但缺一个依赖就 import 失败」的典型：
 *   · pandas：缺 dateutil（v1 只探 docx/openpyxl/pptx/requests，把这种坏状态
 *     判成 ok，之后再也不重跑，真机踩过）；
 *   · matplotlib：缺 packaging（v2 踩过，报错在 matplotlib/__init__.py:157）。
 */
const BASE_IMPORTS = [
  'import docx, openpyxl, pptx, requests, dateutil, pytz',
  'import packaging, cycler, fontTools, pyparsing',
]

/**
 * 运行时预装的 C 扩展（bionic：seeds 预装；glibc：`kxxy-glibc-provision
 * python-ml` 提供）。
 *
 * glibc 模式下**不把它们算进门槛**：容器里有 python3 但没 provision 时，
 * pandas/matplotlib 本来就缺失，把它们当门槛会让「纯 Python 包已装好」被
 * 判成 failed，顺带每天重复下载几 MB 而永远无法转 ok。缺 ML 由体检项单独报。
 */
const ML_IMPORTS = [
  'import pandas',
  'import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot',
]

/** @param mode 运行模式：`glibc` 只探 pydeps 自己的包，其余模式连 ML 一起探。 */
function probeSource(mode) {
  return [...BASE_IMPORTS, ...(mode === 'glibc' ? [] : ML_IMPORTS), 'print("ok")'].join('; ')
}

/** pip 单次最多跑这么久：手机网络差时 150 s 足够下载这几 MB 的纯 wheel。 */
const PIP_TIMEOUT_MS = 150_000

function engineRoot() {
  return process.env.KXXY_ENGINE_ROOT || process.env.PREFIX || ''
}

function home() {
  return process.env.DSH_HOME || process.env.HOME || ''
}

function markerPath() {
  return join(home(), '.kxxy', 'pydeps.json')
}

function readMarker() {
  try {
    return JSON.parse(readFileSync(markerPath(), 'utf8'))
  } catch {
    return null
  }
}

function writeMarker(value) {
  try {
    const target = markerPath()
    mkdirSync(join(home(), '.kxxy'), { recursive: true })
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
  } catch {
    /* 标记写不进去最多是下次多跑一遍，不影响功能 */
  }
}

/** 今天（本地时区）的 `YYYY-MM-DD`。 */
function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function run(argv, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (code, text) => {
      if (settled) return
      settled = true
      resolve({ code, text })
    }
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch (error) {
      finish(-1, String(error?.message ?? error))
      return
    }
    let out = ''
    const collect = (chunk) => {
      if (out.length < 16_384) out += String(chunk)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
      finish(-2, `${out}\n[timeout ${timeoutMs} ms]`)
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      finish(-1, String(error?.message ?? error))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code ?? -1, out)
    })
  })
}

/** 前 4 字节是 ELF 魔数（容器里的 python3 必须是真 ELF，软链先解析）。 */
function isElf(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(4)
    if (readSync(fd, head, 0, 4, 0) !== 4) return false
    return head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 已经关闭 */
      }
    }
  }
}

/**
 * glibc 容器是否真的能跑 Python（与 python-default.py 的 `require_ready` 同判据）。
 *
 * 只看 `.kxxy-seed` 不够：装了 glibc 扩展但没 `kxxy-glibc-provision python-ml`
 * 时，种子在、`/usr/bin/python3` 不在 —— 此时裸 `python3` 会落到运行时的原生
 * bionic 解释器（见 tools/prebuilt/kxxy-tools/python-default.py 的回退）。
 */
function glibcPythonReady(root) {
  const rootfs = process.env.KXXY_GLIBC_ROOTFS || join(root, 'glibc', 'rootfs')
  if (!existsSync(join(rootfs, '.kxxy-seed'))) return false
  try {
    return isElf(realpathSync(join(rootfs, 'usr', 'bin', 'python3')))
  } catch {
    return false
  }
}

/**
 * 是不是一个**普通文件**（目录、断掉的软链都算否）。
 *
 * 两处都要用：PATH 扫描与最后那条 `<root>/bin/python3` 回退 —— 后者先前只判
 * `existsSync`，`bin/python3` 万一是个目录也会被当成解释器，随后每次探测都
 * 以 EACCES 失败并把 `failed` 写进标记。
 */
function isPlainFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 当前**生效**的 python3：与用户敲命令时 PATH 解析出来的同一个文件。
 *
 * 只接受引擎根内的 PATH 条目 —— 桌面开发机上 PATH 里是宿主 Python，
 * 往里 `pip install --user` 会污染开发环境（历史行为也从不碰它）。
 * 引擎根内一条都没有时退回 `<root>/bin/python3`（运行时自带的原生解释器）。
 *
 * @returns `{ path, mode }`；`mode` 取值 `glibc` / `bionic` / `dispatcher`。
 */
function effectivePython(root) {
  const rootAbs = resolve(root)
  const inside = (dir) => {
    const abs = resolve(dir)
    return abs === rootAbs || abs.startsWith(rootAbs + sep)
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !inside(dir)) continue
    for (const name of ['python3', 'python']) {
      const candidate = join(dir, name)
      if (!isPlainFile(candidate)) continue
      const dispatcher = join(rootAbs, 'libexec', 'python-default', 'bin')
      if (resolve(dir) === dispatcher) {
        return { path: candidate, mode: glibcPythonReady(rootAbs) ? 'glibc' : 'dispatcher' }
      }
      return { path: candidate, mode: 'bionic' }
    }
  }
  const native = join(rootAbs, 'bin', 'python3')
  return isPlainFile(native) ? { path: native, mode: 'bionic' } : null
}

/**
 * 运行时锚：标记只在**同一份运行时 + 同一个解释器**下复用。
 *
 * 只用 `kxxy-runtime.json` 的 size + mtime 与 `kxxy-host/patchset.version` 的
 * 内容，**不解析**那份清单 —— 它有 7 万多条目、十几 MB，每次启动读进内存
 * 不划算；重装必改 mtime、内容补丁集必改版本号，两条足够判「换了一份运行时」。
 */
function runtimeAnchor(root) {
  const parts = []
  try {
    const stat = statSync(join(root, 'kxxy-runtime.json'))
    parts.push(`${stat.size}:${Math.trunc(stat.mtimeMs)}`)
  } catch {
    /* 老包可能没有清单，继续看补丁集标记 */
  }
  try {
    parts.push(readFileSync(join(root, 'lib', 'node_modules', 'kxxy-host', 'patchset.version'), 'utf8').trim())
  } catch {
    /* 插件还没解出来（首启竞态）：只剩清单统计量也要能判等 */
  }
  return parts.length > 0 ? parts.join('/') : 'unknown'
}

/**
 * 标记是否仍然成立 —— v4 的核心判据，四项**全等**才算数：
 * 补丁集版本、解释器路径、运行模式、运行时锚。
 *
 * 单独提出来是为了可测（`tools/test-pydeps-probe.mjs`）：这条判据一旦退化成
 * 「只看 revision」，用户看到的就是体检页写着 `ok`、文档库却一整个 import 不到的
 * 老毛病 —— 而这在运行期没有任何报错，只能靠回归钉住。
 */
function markerMatches(record, expect) {
  return (
    record?.revision === expect.revision &&
    record?.python === expect.python &&
    record?.mode === expect.mode &&
    record?.runtime === expect.runtime
  )
}

/**
 * 确保 [PACKAGES] 已就位。返回 `{ status, detail }`，永不抛错。
 *
 * status: `skipped`（无需动作）/ `installed` / `failed`
 */
export async function ensurePythonLibs() {
  const root = engineRoot()
  if (!root) return { status: 'skipped', detail: '引擎根未知' }
  const python = effectivePython(root)
  if (!python) return { status: 'skipped', detail: 'engine python3 不存在' }
  const py = python.path
  const mode = python.mode
  const runtime = runtimeAnchor(root)
  const probeCode = probeSource(mode)

  const expect = { revision: REVISION, python: py, mode, runtime }
  const current = (record) => markerMatches(record, expect)

  const marker = readMarker()
  // `ok` 才表示这批包真的能 import；`failed` 只表示「今天试过了」，明天还能再来。
  if (current(marker) && marker.status === 'ok') {
    return { status: 'skipped', detail: '已就位' }
  }
  if (current(marker) && marker.status === 'failed' && marker.day === today()) {
    return { status: 'skipped', detail: '今日已尝试，留待明天' }
  }
  if (marker && !current(marker) && marker.revision === REVISION && marker.status === 'ok') {
    // 解释器/运行时换人了：旧结论不再成立，必须重探（这是 v4 的核心修复）。
    console.log(
      `[pydeps] 解释器或运行时已变化（${marker.mode} ${marker.python} → ${mode} ${py}），重新探测`,
    )
  }

  // 先探一下：能 import 就只写标记，不碰网络（用户可能自己装过）。
  const probeTimeout = mode === 'glibc' ? 120_000 : 60_000
  const probe = await run([py, '-c', probeCode], probeTimeout)
  if (probe.code === 0) {
    writeMarker({
      revision: REVISION,
      status: 'ok',
      day: today(),
      installedAt: new Date().toISOString(),
      source: 'preexisting',
      mode,
      python: py,
      runtime,
    })
    return { status: 'skipped', detail: '库已可 import' }
  }

  const result = await run(
    [
      py, '-m', 'pip', 'install', '--user', '--no-input',
      '--disable-pip-version-check', '--no-warn-script-location',
      // 容器里的 pip 把运行时包当「externally managed」（PEP 668），不加这句直接
      // 拒绝安装；bionic 侧没有这个标记文件，加了也无害 —— 但不加更保险。
      ...(mode === 'glibc' ? ['--break-system-packages'] : []),
      ...PACKAGES,
    ],
    PIP_TIMEOUT_MS,
  )
  if (result.code !== 0) {
    writeMarker({
      revision: REVISION,
      status: 'failed',
      day: today(),
      failedAt: new Date().toISOString(),
      mode,
      python: py,
      runtime,
    })
    return { status: 'failed', detail: result.text.slice(-400) }
  }
  // pip 说装好了不代表真能 import（镜像给错 wheel、user site 不在 sys.path 都会这样）。
  const verify = await run([py, '-c', probeCode], probeTimeout)
  if (verify.code !== 0) {
    writeMarker({
      revision: REVISION,
      status: 'failed',
      day: today(),
      failedAt: new Date().toISOString(),
      mode,
      python: py,
      runtime,
    })
    return { status: 'failed', detail: `装上但 import 失败：${verify.text.slice(-300)}` }
  }
  writeMarker({
    revision: REVISION,
    status: 'ok',
    day: today(),
    installedAt: new Date().toISOString(),
    packages: PACKAGES,
    mode,
    python: py,
    runtime,
  })
  return { status: 'installed', detail: PACKAGES.join(', ') }
}

/**
 * 纯函数的测试出口（唯一消费者是 `tools/test-pydeps-probe.mjs`）。
 *
 * 这里导出的每一个都是**无副作用**的判据函数：不 spawn、不写标记、不碰网络。
 * 之所以要让它们可测：`pydeps@4` 修的就是「标记陈旧却判 ok」，而这种错误在
 * 运行期完全静默 —— 没有测试就只能靠真机上「体检 ok 但 import 不到」来发现。
 */
export const __pydepsInternals = {
  REVISION,
  PACKAGES,
  BASE_IMPORTS,
  ML_IMPORTS,
  probeSource,
  isElf,
  isPlainFile,
  glibcPythonReady,
  effectivePython,
  runtimeAnchor,
  markerMatches,
}

