/**
 * 扩展安装器 —— 「获取」按钮背后的真装配链（五项改进方案 §2.3 / §2.4）。
 *
 * 安装 = 从 APK 内置包池解包，全程零联网：
 *   <engineRoot>/ext-pool/<id>.tar.gz            ← 构建期由 tools/fetch-extensions.mjs 生成，
 *                                                  原生层 RuntimeInstaller 落盘到此处
 *   → 流式解到 extensions/<id>.tmp-install/       （命名约定沿用旧版，见旧 index.js:232）
 *   → 原子 rename 成 extensions/<id>/             （断电不会留半个扩展）
 *   → bin/* 软链进 <engineRoot>/bin、lib/*.so* 复制进 <engineRoot>/lib
 *
 * 为什么 bin 软链、lib 复制（不照抄方案原文的「都软链」）：
 *   PATH 是目录查找，execve 打开软链由内核解析 —— bin 软链立即生效，无需重启引擎；
 *   而 Android linker 在 app 域**不跟随**符号链接（RuntimeInstaller.kt 头注的
 *   真机事故：CANNOT LINK EXECUTABLE ... library not found），所以进
 *   LD_LIBRARY_PATH 的 .so 必须是实体副本。副本的代价记在 .links.json 里，
 *   卸载时按 sha256 判断「还是不是我装的那份」再删，避免误删共享库。
 *
 * 升级自愈：runtime 升级时 RuntimeInstaller 会整体替换 bin/ lib/，链接全丢；
 *   它会写 extensions/.relink 标记，本模块的 relinkAll() 在插件启动时重建。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractTarGz } from './tar.mjs'

/** 引擎根目录（原生层注入的环境变量；smoke 测试等场景缺失时为空串）。 */
export function engineRoot() {
  return process.env.KXXY_ENGINE_ROOT || process.env.PREFIX || ''
}

export const poolDir = (root) => join(root, 'ext-pool')
export const extensionsDir = (root) => join(root, 'extensions')

/** 引擎 → 原生层的请求文件名（与 EngineConfig.kt 的两个常量严格一致）。 */
export const RESTART_REQUEST_FILE = 'restart.request'
export const STDIN_REQUEST_FILE = 'stdin.request'
export const restartRequestPath = (root) => join(root, RESTART_REQUEST_FILE)
export const stdinRequestPath = (root) => join(root, STDIN_REQUEST_FILE)

/** 全部任务的只读快照（collectExtensions 判断「安装中」用）。 */
export function jobsSnapshot() {
  return [...jobs.values()].map((j) => ({ ...j }))
}

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 构建期生成并随插件打包的扩展目录清单。 */
export function readCatalog() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'extensions.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 包池里实际可用的扩展 id → 文件路径。
 *
 * 后缀说明：构建期产出 `.pool`（内容是 gzip 的 tar）。刻意不用 `.tar.gz` ——
 * aapt2 会在资产合并时解包 .gz 并剥掉后缀，APK 里拿到的是改名后的 `.tar`。
 * 两种后缀都认，历史 APK 也能继续工作。
 */
export function listPool(root) {
  const dir = poolDir(root)
  const out = new Map()
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.pool')) {
        out.set(name.slice(0, -'.pool'.length), join(dir, name))
      } else if (name.endsWith('.tar.gz')) {
        out.set(name.slice(0, -'.tar.gz'.length), join(dir, name))
      }
    }
  } catch {
    // 包池不存在（旧 APK / 未跑构建期工具）→ 空池
  }
  return out
}

// ---------------------------------------------------------------------------
// 任务登记与进度
// ---------------------------------------------------------------------------

const jobs = new Map()
let jobSeq = 0

/** 全局安装互斥：手机的 flash 上并发解两个 200 MiB 的 tar 没有好处。 */
let installChain = Promise.resolve()

export function getJob(jobId) {
  const job = jobs.get(jobId)
  if (!job) return null
  const { id, extId, phase, percent, message, startedAt, finishedAt, error } = job
  return { id, extId, phase, percent, message, startedAt, finishedAt, error }
}

function updateJob(job, patch, tmpDir) {
  Object.assign(job, patch)
  // 进度同时落一份文件：管理页轮询走 API，但「装到一半被刷新」之后
  // 页面还能从 .ext-progress.json 读到上一次的状态（五项改进方案 §2.3）。
  if (tmpDir) {
    try {
      writeFileSync(
        join(tmpDir, '.ext-progress.json'),
        `${JSON.stringify(
          { phase: job.phase, percent: job.percent, message: job.message, updatedAt: Date.now() },
          null,
          2,
        )}\n`,
      )
    } catch {
      // 进度文件写不进去不影响安装本身
    }
  }
}

/**
 * 发起一次安装。返回 jobId；真正的解包在后台串行执行。
 *
 * @param {string} root  引擎根目录
 * @param {string} id    扩展 id（= 包池文件名主干）
 * @param {object} [item] 目录清单条目（version / sizeBytes 用于进度与版本戳）
 */
export function startInstall(root, id, item = {}) {
  if (!root) return { error: 'engine root unknown (KXXY_ENGINE_ROOT not set)' }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return { error: 'invalid extension id' }

  const running = [...jobs.values()].find(
    (j) => j.extId === id && (j.phase === 'queued' || j.phase === 'extract' || j.phase === 'link'),
  )
  if (running) return { error: `extension ${id} is already installing`, jobId: running.id }

  const jobId = `extjob-${Date.now().toString(36)}-${(jobSeq += 1)}`
  const job = {
    id: jobId,
    extId: id,
    phase: 'queued',
    percent: 0,
    message: '排队等待',
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  }
  jobs.set(jobId, job)

  installChain = installChain
    .then(() => runInstall(job, root, id, item))
    .catch((e) => {
      updateJob(job, { phase: 'error', percent: 0, message: String(e?.message ?? e), error: String(e?.message ?? e), finishedAt: Date.now() })
    })
  return { jobId }
}

async function runInstall(job, root, id, item) {
  const extRoot = extensionsDir(root)
  const extDir = join(extRoot, id)
  const tmpDir = `${extDir}.tmp-install`
  mkdirSync(extRoot, { recursive: true })

  let poolFile = join(poolDir(root), `${id}.pool`)
  if (!existsSync(poolFile)) {
    // 旧 APK 里的包池是 .tar.gz 命名
    const legacy = join(poolDir(root), `${id}.tar.gz`)
    if (!existsSync(legacy)) {
      updateJob(job, { phase: 'error', percent: 0, message: '包池缺失：APK 里没有这个扩展包', error: 'pool missing', finishedAt: Date.now() })
      return
    }
    poolFile = legacy
  }

  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  updateJob(job, { phase: 'extract', percent: 1, message: '开始解包' }, tmpDir)

  const totalBytes = Number(item.sizeBytes) || 0
  let lastReported = 0
  const result = await extractTarGz(poolFile, tmpDir, {
    totalBytes,
    onProgress: (info) => {
      // 解包阶段占 0..85%；按累计字节算，没有总量估计时按条目数凑合
      const frac = totalBytes > 0
        ? info.written / totalBytes
        : Math.min(1, info.written / (info.written + 8 * 1024 * 1024))
      const percent = 1 + Math.floor(frac * 84)
      if (percent !== lastReported) {
        lastReported = percent
        updateJob(job, { phase: 'extract', percent, message: `解包 ${id}` }, tmpDir)
      }
    },
  })

  updateJob(job, { phase: 'link', percent: 88, message: '接入 PATH 与链接库' }, tmpDir)

  // 版本戳（collectExtensions 读这个文件判断 installed）
  writeFileSync(join(tmpDir, '.ext-version'), `${item.version ?? 'unknown'}\n`)

  // 先原子启用（rename 到正式目录），**再**建软链 —— 软链目标是绝对路径，
  // 若先建链后 rename，所有目标都会指向已消失的 .tmp-install 路径，
  // 得到一批悬空链接（首测真机前在本机回环测试中抓到）。
  if (existsSync(extDir)) rmSync(extDir, { recursive: true, force: true })
  renameSync(tmpDir, extDir)

  const links = buildLinks(root, id, extDir)
  writeFileSync(join(extDir, '.links.json'), `${JSON.stringify(links, null, 2)}\n`)

  updateJob(
    job,
    {
      phase: 'done',
      percent: 100,
      message: `完成：${result.files} 个文件，${links.bins.length} 个命令、${links.libs.length} 个库已接入 PATH`,
      finishedAt: Date.now(),
    },
  )
  // 完成态的进度快照也落一份到正式目录（.ext-progress.json 随 tmp 一起被 rename）
  try {
    writeFileSync(
      join(extDir, '.ext-progress.json'),
      `${JSON.stringify({ phase: 'done', percent: 100, message: job.message, updatedAt: Date.now() }, null, 2)}\n`,
    )
  } catch { /* 非致命 */ }
}

// ---------------------------------------------------------------------------
// 链接与库的装配
// ---------------------------------------------------------------------------

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * 把 tmpDir 里的 bin / lib 接进引擎的 PATH 与 LD_LIBRARY_PATH。
 *
 * 返回 .links.json 的内容；relinkAll 靠它重建。
 */
function buildLinks(root, id, tmpDir) {
  const engineBin = join(root, 'bin')
  const engineLib = join(root, 'lib')
  mkdirSync(engineBin, { recursive: true })
  mkdirSync(engineLib, { recursive: true })

  const bins = []
  const libs = []

  const extBin = join(tmpDir, 'bin')
  if (existsSync(extBin)) {
    for (const name of readdirSync(extBin)) {
      const src = join(extBin, name)
      const dest = join(engineBin, name)
      try {
        // 覆盖旧链接/旧文件（同名命令以新装的扩展为准）
        if (existsSync(dest)) unlinkSync(dest)
        symlinkSync(src, dest)
        bins.push({ name, target: dest })
      } catch {
        // 单个命令失败不阻断安装（例如目标只读）
      }
    }
  }

  const extLib = join(tmpDir, 'lib')
  if (existsSync(extLib)) {
    for (const name of readdirSync(extLib)) {
      // 只有真正的动态库才进 LD_LIBRARY_PATH；jvm/ 目录树等原样留在扩展里
      if (!name.includes('.so')) continue
      const src = join(extLib, name)
      const dest = join(engineLib, name)
      try {
        const digest = sha256(readFileSync(src))
        copyFileSync(src, dest)
        libs.push({ name, target: dest, sha256: digest })
      } catch {
        // 单个库失败不阻断安装
      }
    }
  }

  return { extId: id, bins, libs, linkedAt: Date.now() }
}

/**
 * 卸载：按 .links.json 回收自己的链接与库。
 *
 * 库只有在「磁盘上的内容仍是我装的那份」时才删 —— 两个扩展共用同一个
 * libfoo.so 时，后装的覆盖了前者的副本，先卸载的那个不能把新的删掉。
 */
export function removeExtension(root, id) {
  if (!root) return { error: 'engine root unknown' }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return { error: 'invalid extension id' }
  const extDir = join(extensionsDir(root), id)
  if (!existsSync(extDir)) return { error: `extension ${id} not found` }

  let removedBins = 0
  let removedLibs = 0
  try {
    const links = JSON.parse(readFileSync(join(extDir, '.links.json'), 'utf8'))
    for (const bin of links.bins ?? []) {
      try {
        if (existsSync(bin.target)) unlinkSync(bin.target)
        removedBins += 1
      } catch { /* 目标已不在，忽略 */ }
    }
    for (const lib of links.libs ?? []) {
      try {
        if (!existsSync(lib.target)) continue
        if (sha256(readFileSync(lib.target)) === lib.sha256) {
          unlinkSync(lib.target)
          removedLibs += 1
        }
      } catch { /* 内容比对失败，保守保留 */ }
    }
  } catch {
    // 没有 .links.json（老版本装的扩展）：目录本身照删，链接残留可由
    // relink 机制的下一次升级清理
  }
  rmSync(extDir, { recursive: true, force: true })
  return { ok: true, removedBins, removedLibs }
}

/**
 * 升级自愈：runtime 升级整体替换 bin/ lib/ 之后，按各扩展的 .links.json
 * 重建接入点。由插件启动时调用（extensions/.relink 标记由 RuntimeInstaller 写）。
 *
 * @returns {number} 重建的扩展数
 */
export function relinkAll(root) {
  if (!root) return 0
  const marker = join(extensionsDir(root), '.relink')
  if (!existsSync(marker)) return 0

  let rebuilt = 0
  try {
    const extRoot = extensionsDir(root)
    for (const entry of readdirSync(extRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.endsWith('.tmp-install')) continue
      const extDir = join(extRoot, entry.name)
      const linksFile = join(extDir, '.links.json')
      if (!existsSync(linksFile)) continue
      try {
        const links = JSON.parse(readFileSync(linksFile, 'utf8'))
        // runtime 升级后 bin/ lib/ 可能被整体删空（目录本身都没了），
        // copyFileSync / symlinkSync 不会自动建父目录，必须先补上
        mkdirSync(join(root, 'bin'), { recursive: true })
        mkdirSync(join(root, 'lib'), { recursive: true })
        // 逐条隔离：Windows 构建机 / 只读目录下单个软链失败，
        // 不能拖垮同一扩展的其余链接与库恢复
        for (const bin of links.bins ?? []) {
          try {
            if (existsSync(bin.target)) continue
            const src = join(extDir, 'bin', bin.name)
            if (!existsSync(src)) continue
            symlinkSync(src, bin.target)
          } catch { /* 单条失败继续 */ }
        }
        for (const lib of links.libs ?? []) {
          try {
            if (existsSync(lib.target)) continue
            const src = join(extDir, 'lib', lib.name)
            if (!existsSync(src)) continue
            copyFileSync(src, lib.target)
          } catch { /* 单条失败继续 */ }
        }
        rebuilt += 1
      } catch {
        // 清单损坏等整体失败不阻断其他扩展
      }
    }
    unlinkSync(marker)
  } catch {
    // 标记读不出来就留着，下次启动再试
  }
  return rebuilt
}
