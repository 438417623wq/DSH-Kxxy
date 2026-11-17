/**
 * pydeps — 把「纯 Python 的办公/文档库」补进运行时的 user site。
 *
 * 背景（问题清单【9】）：真机探测报告 `docx / openpyxl / pptx / requests` 全部
 * `ModuleNotFoundError`，于是任何「读一个 xlsx、生成一份 docx、抓一个网页」的
 * 脚本都跑不起来。
 *
 * 为什么只补纯 Python 的那几个：
 *   · 带 C 扩展的（lxml / Pillow / pandas）走**运行时预装**（tools/lib/seeds.mjs
 *     里的 Termux deb）—— PyPI 上没有 android_arm64 的 wheel，手机上现编一律失败；
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 清单版本：加/换包时改这个数字，标记文件不匹配就会重跑一次。 */
const REVISION = 'pydeps@1'

/**
 * 要装的包。刻意**不带版本号**：这些库互相之间的兼容窗口很宽，钉死版本反而
 * 会在镜像同步滞后时卡住；需要精确版本的用户自己 `pip install foo==x.y` 即可
 * （装进同一个 user site，覆盖我们这份）。
 */
const PACKAGES = ['python-docx', 'openpyxl', 'python-pptx', 'requests']

/** pip 单次最多跑这么久：手机网络差时 90 s 足够下载这几百 KB 的纯 wheel。 */
const PIP_TIMEOUT_MS = 90_000

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

/**
 * 确保 [PACKAGES] 已就位。返回 `{ status, detail }`，永不抛错。
 *
 * status: `skipped`（无需动作）/ `installed` / `failed`
 */
export async function ensurePythonLibs() {
  const root = engineRoot()
  const py = join(root, 'bin', 'python3')
  if (!root || !existsSync(py)) return { status: 'skipped', detail: 'engine python3 不存在' }

  const marker = readMarker()
  // `ok` 才表示这批包真的能 import；`failed` 只表示「今天试过了」，明天还能再来。
  if (marker?.revision === REVISION && marker?.status === 'ok') {
    return { status: 'skipped', detail: '已就位' }
  }
  if (marker?.status === 'failed' && marker?.day === today()) {
    return { status: 'skipped', detail: '今日已尝试，留待明天' }
  }

  // 先探一下：能 import 就只写标记，不碰网络（用户可能自己装过）。
  const probe = await run(
    [py, '-c', 'import docx, openpyxl, pptx, requests'],
    20_000,
  )
  if (probe.code === 0) {
    writeMarker({ revision: REVISION, status: 'ok', day: today(), installedAt: new Date().toISOString(), mode: 'preexisting' })
    return { status: 'skipped', detail: '四个库已可 import' }
  }

  const result = await run(
    [
      py, '-m', 'pip', 'install', '--user', '--no-input',
      '--disable-pip-version-check', '--no-warn-script-location',
      ...PACKAGES,
    ],
    PIP_TIMEOUT_MS,
  )
  if (result.code !== 0) {
    writeMarker({ revision: REVISION, status: 'failed', day: today(), failedAt: new Date().toISOString() })
    return { status: 'failed', detail: result.text.slice(-400) }
  }
  // pip 说装好了不代表真能 import（镜像给错 wheel、user site 不在 sys.path 都会这样）。
  const verify = await run([py, '-c', 'import docx, openpyxl, pptx, requests'], 20_000)
  if (verify.code !== 0) {
    writeMarker({ revision: REVISION, status: 'failed', day: today(), failedAt: new Date().toISOString() })
    return { status: 'failed', detail: `装上但 import 失败：${verify.text.slice(-300)}` }
  }
  writeMarker({
    revision: REVISION,
    status: 'ok',
    day: today(),
    installedAt: new Date().toISOString(),
    packages: PACKAGES,
  })
  return { status: 'installed', detail: PACKAGES.join(', ') }
}
