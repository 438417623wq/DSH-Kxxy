/**
 * 扩展安装器 —— 「获取」按钮背后的真装配链（五项改进方案 §2.3 / §2.4）。
 *
 * 安装 = 从 APK 内置包池解包，全程零联网：
 *   <engineRoot>/ext-pool/<id>.tar.gz            ← 构建期由 tools/fetch-extensions.mjs 生成，
 *                                                  原生层 RuntimeInstaller 落盘到此处
 *   → 流式解到 extensions/<id>.tmp-install/       （命名约定沿用旧版，见旧 index.js:232）
 *   → 回填路径占位符（回填清单在包内 .pool-manifest.json）  ← 问题.txt【1】
 *   → 原子 rename 成 extensions/<id>/             （断电不会留半个扩展）
 *   → bin/** 软链进 <engineRoot>/bin、lib/*.so* 复制进 <engineRoot>/lib，
 *     并把各扩展的 etc/ share/ opt/ 递归合并进引擎根的同名位置
 *     （递归合并而非整目录覆盖的理由见 mergeViews 的注释）
 *
 * 为什么要回填占位符（问题.txt【1】）：
 *   扩展里的脚本与配置写死了 Termux 的单一前缀 `/data/data/com.termux/files/usr`。
 *   安卓上引擎根是 app 私有目录（`/data/user/0/<pkg>/files/engine`），两者毫无关系，
 *   于是真机上出现 `--list-langs` 去读 `/data/data/com.termux/.../share/tessdata`
 *   这种「路径存在但不属于我」的失败。构建期（tools/lib/poolextract.py）已把文本
 *   内容里的前缀换成 `@DSH_ROOT@` 等占位符，安装时用真实路径替换回来 —— 与
 *   RuntimeInstaller 对 runtime stage 做的事完全同构，只是多了一次设备端回填。
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
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
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

/**
 * 不允许被复制进 `<root>/lib/` 的**裸名**动态库（缺陷 BH）。
 *
 * 判据不是「桩库太小」，而是 **soname 与裸文件名不一致**：这类文件一旦落到
 * `<root>/lib/`，因为该目录在 `LD_LIBRARY_PATH` 首位，系统侧要裸名的库链
 * 就会命中它，然后缺符号、`CANNOT LINK EXECUTABLE`。
 *
 * `libheif.so`：扩展（gnuplot / imagemagick / texlive）带来的那份是
 * libheif 1.23.6（soname `libheif.so.1`、1,928,648 B、469 个符号），
 * 系统的 `/system/lib64/libheif.so` 是 43,368 B / 37 个符号，两者符号
 * **零重叠**，系统独有 20 个 `android::Heif*` 与
 * `_Z17createHeifDecoderv` —— 后者正是系统 `libhwui.so` 要的。
 * 全引擎 3,569 个 ELF64 扫 `DT_NEEDED`：要裸名 `libheif.so` 的 **0 个**，
 * 13 个消费者一律要 `libheif.so.1`（那个照常复制，不受影响）。
 *
 * `liblzma.so` 是同一类，但它在 runtime.zip 里，剔除点由
 * `tools/build-runtime.mjs` 的 `DROPPED_LIBS` 与 `RuntimeInstaller.kt` 的
 * `SHADOWING_STUBS` 负责，不在这里。这里仍然列出它，是为了让
 * 「运行期自愈删除」与「安装期不再复制」两处判据共用同一份清单。
 */
export const SHADOWING_BARE_LIBS = new Set(['libheif.so', 'liblzma.so'])

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

  // 回填路径占位符（问题.txt【1】）：构建期 poolextract.py 把文本内容里的
  // Termux 前缀换成了 @DSH_ROOT@ 等占位符，清单随包（.pool-manifest.json），
  // 这里换成引擎的真实目录。必须在 buildViews 之前 —— 清单本身也会被删掉。
  const applied = applyPlaceholders(root, extDir, join(extDir, POOL_MANIFEST))

  // layout 戳由 buildViews 一并返回（见那里的注释）
  const links = buildViews(root, id, extDir)
  writeFileSync(join(extDir, '.links.json'), `${JSON.stringify(links, null, 2)}\n`)

  const rewritten = applied.skipped ? '' : `，回填路径 ${applied.rewritten} 个`
  updateJob(
    job,
    {
      phase: 'done',
      percent: 100,
      message: `完成：${result.files} 个文件，${links.bins.length} 个命令、${links.libs.length} 个库、${links.views.length} 项资源已接入${rewritten}`,
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

/** 包内回填清单的文件名（构建期由 tools/lib/poolextract.py 写入）。 */
export const POOL_MANIFEST = '.pool-manifest.json'

/**
 * 装配布局版本。写进每个扩展的 `.links.json`，用来识别「旧代码装的」扩展。
 *
 * 为什么需要它：装配链的**内容**会随版本演进（1 → 2 加了 `etc/` `share/`
 * `lib/` 的递归合并视图、`bin/**` 递归展平、路径占位符回填）。老设备上已经
 * 装好的扩展目录**不会**自动重装 —— `RuntimeInstaller` 的自愈只覆盖
 * runtime.zip 顶层目录，`extensions/` 是用户态资产，故意不碰。于是出现
 * 「代码修好了，但设备上还是旧布局」：真机实测 texlive 重装后 `bin/` 从
 * 1218 涨到 1629（+411 个 TeX 引擎），而其余 19 个扩展仍是旧布局，
 * rust 缺 `lib/rustlib`、perl 的 `Config_heavy.pl` 仍写着 Termux 前缀。
 *
 * 所以：布局升级靠**重新装配**（pool 已在设备上，不必重新下载），
 * 由 [staleExtensions] 找出落后的扩展，交回调用方重装。
 *
 * 3 → 修掉 `RuntimeInstaller` 的 `deleteRecursively()` 跟随软链事故。
 * 2 时代的设备上，`engine/bin`、`engine/lib`、`engine/etc`、`engine/share` 里
 * 的**目录软链**让 runtime 重装时把扩展目录里的真实内容删掉了
 * （`engine/bin/texlive -> extensions/texlive/bin/texlive` ⇒ 411 个 TeX 引擎
 * 整片消失，rust 的 `lib/rustlib`、gdb 的 `share/guile` 同型）。这些文件的
 * `.links.json` 完好、`layout` 也是 2，光靠 [staleExtensions] 判不出来 ——
 * 所以升到 3 强制全体重新装配一次，把丢失的内容从 pool 里补回来。
 */
export const LAYOUT_VERSION = 3

/**
 * 包池文件的体积指纹（扩展 id → 安装时那个 pool 的字节数）。
 *
 * 为什么 `layout` 不够：布局版本只随**装配代码**变，而 pool 的**内容**是随
 * APK 变的。真机事故（缺陷 BA 的第二层）：emacs 的字符集映射 `*.map` 曾被
 * `PRUNE_EXT` 误裁，修好后新 APK 里的 `emacs.pool` 从 53,391,296 B 长到
 * 54,413,123 B，`RuntimeInstaller.ensureExtensionPool` 也如实把新文件拷到了
 * 设备上 —— 但 `extensions/emacs` 里仍是旧池解出来的 4,239 个文件（charsets
 * 只剩一个 README），`layout` 仍是 3，于是 `staleExtensions` 判它「已最新」，
 * 缺陷在设备上原样复现。判据必须包含「池本身变了没有」。
 *
 * 只比字节数、不比内容哈希：1 GiB 级的池在启动路径上做全量哈希不可接受，
 * 而池是由 deb 重新打包的，内容一变体积几乎必然变。代价是「改了内容但体积
 * 恰好不变」探测不到 —— 那种情况需要用户手动在扩展中心重装。
 *
 * @returns {number} 池文件字节数；池不存在时为 0
 */
export function poolSignature(root, id) {
  if (!root) return 0
  for (const name of [`${id}.pool`, `${id}.tar.gz`]) {
    try {
      const st = statSync(join(poolDir(root), name))
      if (st.isFile()) return st.size
    } catch {
      // 换下一个后缀
    }
  }
  return 0
}

/**
 * 占位符 → 引擎实际的目录。与构建期 poolextract.py 的映射表逐字对应。
 *
 * `@DSH_ROOT@` 是 `<root>` 本身（Termux 的 `usr`）；`@DSH_HOME@` / `@DSH_TMP@`
 * 是 Termux 里与之平级的另两棵树；`@DSH_FILES@` / `@DSH_DATA@` 则是它们的
 * **祖先**——perl 的 `Config_heavy.pl` 把 `-Dsysroot` 写成不带 `/usr` 的裸前缀，
 * 三条长规则一条都匹配不到，只能单独给两个更短的占位符。
 */
export function placeholderMap(root) {
  const files = dirname(root)
  return {
    '@DSH_ROOT@': root,
    '@DSH_HOME@': process.env.DSH_HOME || process.env.HOME || join(root, '..'),
    '@DSH_TMP@': process.env.TMPDIR || '/data/local/tmp',
    '@DSH_FILES@': files,
    '@DSH_DATA@': dirname(files),
  }
}

/**
 * 把 pool 里文本内容的路径占位符回填成真实路径（问题.txt【1】）。
 *
 * 构建期只把文本文件的内容改了（ELF / ar / 含 NUL 的二进制一律跳过，
 * 见 poolextract.py 的 rewrite_prefixes），所以这里也只需要读文本清单里
 * 列出的那些文件 —— 不必再遍历整个扩展（rust/kotlin 动辄上万文件）。
 *
 * 返回 { rewritten, missing }；install 流程用它拼进度文案。
 *
 * 导出仅供 tools/test-extinstall.mjs 直接测（真机路径是 runInstall）。
 */
export function applyPlaceholders(root, dir, manifestPath) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    // 老 APK 的 pool 没有清单（构建期还没做路径重写）→ 不是错误，静默跳过
    return { rewritten: 0, missing: 0, skipped: true }
  }

  const map = placeholderMap(root)
  const table = Object.entries(map).sort((a, b) => b[0].length - a[0].length)

  let rewritten = 0
  let missing = 0
  for (const rel of manifest.files ?? []) {
    const file = join(dir, rel)
    if (!existsSync(file)) {
      missing += 1
      continue
    }
    try {
      // 只读清单里的文本文件。它们一定不含 NUL —— 构建期就是这么筛的。
      let text = readFileSync(file, 'utf8')
      let hit = false
      for (const [needle, value] of table) {
        if (!text.includes(needle)) continue
        text = text.split(needle).join(value)
        hit = true
      }
      if (hit) {
        writeFileSync(file, text, 'utf8')
        rewritten += 1
      }
    } catch {
      // 单个文件失败不阻断安装
      missing += 1
    }
  }

  // 清单本身不再需要留在扩展目录里（免得被 collectExtensions 当条目）
  try { unlinkSync(manifestPath) } catch { /* 已不存在 */ }
  return { rewritten, missing, skipped: false }
}

/**
 * 把扩展接进引擎（问题.txt【4】【6】）。
 *
 * 四件事，每一件都对应一类真机事故：
 *
 * ① `bin/**` 递归展平进 `<root>/bin`
 *    旧实现只做一层 `readdirSync(extBin)`，于是 TeX Live 的 `bin/texlive/`
 *    这个**目录**被整体软链成 `<root>/bin/texlive` —— 411 个引擎（pdftex /
 *    xetex / luatex / fmtutil / kpsewhich …）一个都不在 PATH 上，真机症状是
 *    「装完 81 MB 的 TeX Live，却一个 TeX 引擎都没有」。
 *    PATH 只有 `<root>/bin` 一个条目，所以子目录里的可执行必须**展平**才能被
 *    找到；同时把子目录本身也建成目录软链，让 `texlinks` / `fmtutil` 这类
 *    「按自己所在目录找人」的工具仍能工作。
 *
 * ② `<extDir>/lib` → `<extDir>/opt/<name>/lib` 目录软链
 *    Gradle 与 Kotlin 的发行包把 jar 放在 `opt/<name>/lib/`，而它们的 launcher
 *    用 `readlink -f` 解链后再向上一层取 `$APP_HOME`，落在 `<extDir>/` —— 那里
 *    没有 `lib/`。两个 launcher 都是上游脚本，改它们等于维护 fork；补一条目录
 *    软链即可让 `$APP_HOME/lib/*.jar` 命中。
 *
 * ③ `etc/` `share/` `opt/` `sbin/` 合并视图
 *    扩展里的配置与资源在自己目录下（`<extDir>/etc/fonts/…`、
 *    `<extDir>/share/tessdata/…`），而这些程序编译期记的是 Termux 的单一前缀
 *    （`$PREFIX/etc`、`$PREFIX/share`），等同于引擎根。旧实现完全不处理这四个
 *    目录，于是 fontconfig 找不到 `fonts.conf`、tesseract 找不到语言包 ——
 *    真机症状就是 `--list-langs` 去读 `/data/data/com.termux/...`。
 *    逐项软链进引擎根同名目录，多个扩展的贡献自然合并（同名后者覆盖）。
 *
 * ④ 回填过的文本文件已由 applyPlaceholders 处理，此处不再涉及。
 *
 * 返回 .links.json 的内容；relinkAll 靠它重建。
 *
 * 导出仅供 tools/test-extinstall.mjs 直接测装配逻辑（真机路径是 runInstall）。
 */
export function buildViews(root, id, extDir) {
  const engineBin = join(root, 'bin')
  const engineLib = join(root, 'lib')
  mkdirSync(engineBin, { recursive: true })
  mkdirSync(engineLib, { recursive: true })

  const bins = []
  const libs = []
  const views = []

  const extBin = join(extDir, 'bin')
  if (existsSync(extBin)) {
    // used 用来避免同一扩展内部展平后重名（不同子目录里同名命令）
    const used = new Set()
    collectBins(extBin, '', engineBin, used, bins, views)
  }

  const extLib = join(extDir, 'lib')
  if (existsSync(extLib)) {
    for (const name of readdirSync(extLib)) {
      // 只有真正的动态库才进 LD_LIBRARY_PATH；jvm/ 目录树等原样留在扩展里
      if (!name.includes('.so')) continue
      // 缺陷 BH：裸名会遮蔽系统真库，装进来就是给系统链埋雷
      if (SHADOWING_BARE_LIBS.has(name)) continue
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

  // ② opt/<name>/lib → <extDir>/lib（Gradle / Kotlin 布局）
  if (!existsSync(extLib)) {
    const optDir = join(extDir, 'opt')
    if (existsSync(optDir)) {
      for (const name of readdirSync(optDir)) {
        const candidate = join(optDir, name, 'lib')
        if (!existsSync(candidate)) continue
        try {
          symlinkSync(candidate, extLib)
          views.push({ name: 'lib', target: extLib, src: candidate, kind: 'dir' })
          break
        } catch { /* 已存在或只读，忽略 */ }
      }
    }
  }

  // ②b 扩展 lib/ 下的**子目录**也接入引擎根 lib/（rustlib、guile、perl5、
  //    cmake、pkgconfig 这类运行时资源树）
  //
  // 为什么（问题.txt【5】）：上面那段只复制 `*.so`，而 rustc 的 sysroot 是从
  // `librustc_driver*.so` **实际被加载的目录**上溯一层推出来的 —— 引擎把
  // `<root>/lib` 放进 LD_LIBRARY_PATH，于是 sysroot 被算成 `<root>`，接着
  // 按 `<root>/lib/rustlib/<target>/lib` 找标准库，那里空无一物，编译任何
  // 程序都报 `error[E0463]: can't find crate for 'std'`。
  // 把 `<extDir>/lib/rustlib` 链到 `<root>/lib/rustlib` 后 target-libdir 就
  // 落到真实目录上，标准库随之可见（真机实测：编译产出可执行文件并正确运行）。
  //
  // ★必须递归合并，不能「目标已存在就跳过」：实测扩展 lib/ 下有 14 个子目录，
  // 其中 3 个与 runtime 自带目录**同名**（pkgconfig 有 12 个扩展贡献、cmake 有
  // 9 个、girepository-1.0 有 6 个，runtime 自己也各带一份）；gdb 的 guile
  // 模块树同理。跳过分支会让这些扩展的贡献**静默丢失**，与 etc/share 那次
  // 是同型缺陷。走同一个 mergeEntry，规则与理由见它的注释。
  if (existsSync(extLib)) {
    for (const name of readdirSync(extLib)) {
      const src = join(extLib, name)
      try {
        if (!statSync(src).isDirectory()) continue
      } catch { continue }
      mergeEntry(src, join(engineLib, name), `lib/${name}`, views)
    }
  }

  // ③ etc / share / opt / sbin / var 合并视图
  for (const sub of ['etc', 'share', 'opt', 'sbin', 'var']) {
    const from = join(extDir, sub)
    if (!existsSync(from)) continue
    mergeViews(from, join(root, sub), sub, views)
  }

  // layout 戳在这里打，而不是在 runInstall 里补 —— 凡是走到 buildViews 的
  // 路径（安装、将来的重装配工具）写出的清单都自带版本，漏一个就会让
  // staleExtensions 永远判它「落后」而无限重装。
  //
  // `poolBytes` 同理必须在这里打：它记录「这次装配用的是多大的池」，池被
  // 新 APK 换掉之后（见 poolSignature 的注释）staleExtensions 靠它发现。
  return {
    extId: id,
    bins,
    libs,
    views,
    linkedAt: Date.now(),
    layout: LAYOUT_VERSION,
    poolBytes: poolSignature(root, id),
  }
}

/**
 * 把一个视图子树（`<extDir>/etc` 等）合并进引擎根的同名位置。
 *
 * **为什么不能「同名就把整个目录软链过去」**（旧实现，实测两个真缺陷）：
 * 各扩展贡献的子树经常是**互补的**而不是重复的，整目录覆盖会静默丢内容：
 *   · 与 runtime 自带真目录同名（`share/xml`、`share/icons`、`share/vala`、
 *     `var/service` 等 10 处）⇒ runtime 那份内容被整块遮掉；
 *   · 多个扩展同名（`share/aclocal` 有 10 个贡献者）⇒ autotools 只贡献
 *     `README`、ffmpeg 只贡献 `freetype2.m4`，谁后装谁把对方挤掉。
 * 而 `etc/fonts`（7 个贡献者）、`share/fontconfig`、`share/fonts` 恰好是本
 * 任务最需要的 —— fontconfig 的配置与 tesseract 的语言包分属不同扩展。
 *
 * 递归合并规则：
 *   1. 目标不存在          → 整棵子树一条软链；
 *   2. 目标是**真目录**（runtime 自带，或已经物化过的合并目录）→ 递归合并子项；
 *   3. 目标是**软链**（前一个扩展整目录链过来的）→ 先物化，再递归合并；
 *   4. 叶子同名            → **保留先到的**。
 *
 * 规则 4 有实测依据：全部 pool 与 runtime 之间，同名相对路径共 583 条，
 * 大小**全部一致**（同一上游包的数据被多个包重复携带），所以「先到者胜」
 * 是无损的；真正会丢内容的只有规则 2/3 覆盖的目录级遮蔽。
 *
 * 成本已量化：改成递归合并后新增链接约 80 条（旧实现 43 条），可忽略。
 */
function mergeViews(srcDir, dstDir, rel, views) {
  let names
  try { names = readdirSync(srcDir) } catch { return }
  try { mkdirSync(dstDir, { recursive: true }) } catch { return }

  for (const name of names) {
    mergeEntry(join(srcDir, name), join(dstDir, name), rel ? `${rel}/${name}` : name, views)
  }
}

/**
 * 合并**单个条目**（目录或叶子）到目标位置。
 *
 * 从 mergeViews 里抽出来，是因为 `lib/` 下的子目录（rustlib / guile / perl5 /
 * cmake / pkgconfig …）也必须走同一套规则 —— 它们与 runtime 自带的 lib 子目录
 * 有 3 处同名，跳过式处理会静默丢内容。
 *
 * @param src   源路径（扩展里的真实文件或目录）
 * @param dst   目标路径（引擎根里的位置）
 * @param here  记录进 .links.json 的名字
 */
function mergeEntry(src, dst, here, views) {
  let srcIsDir = false
  try { srcIsDir = statSync(src).isDirectory() } catch { return }

  if (srcIsDir) {
    if (!isPresent(dst)) {
      try {
        symlinkSync(src, dst)
        views.push({ name: here, target: dst, src, kind: 'view' })
      } catch { /* 单条失败继续 */ }
      return
    }
    // 目标**就是自己**（重跑安装 / relink 自愈）：记成自有条目直接跳过。
    // 少了这一条，重跑会把扩展自己的链接误标成 shadowed，此后卸载就再也
    // 回收不掉这些条目了。这也让合并过程变成幂等的。
    try {
      if (lstatSync(dst).isSymbolicLink() && readlinkSync(dst) === src) {
        views.push({ name: here, target: dst, src, kind: 'view' })
        return
      }
    } catch { /* 继续走物化分支 */ }
    // 目标已被占用：软链先物化（否则递归进去会写进别人的扩展目录里），
    // 真目录直接递归。
    //
    // 物化出来的子链接归属**原主**（会被写进原主的清单），不记进本扩展的
    // views —— 本扩展只登记自己真正贡献的条目。
    try {
      if (lstatSync(dst).isSymbolicLink()) materialise(dst, here)
    } catch { return }
    mergeViews(src, dst, here, views)
    return
  }

  // 叶子同名：保留先到的（见上文 583 条实测）。但**目标就是自己**时要
  // 记成自有条目（同上，重跑 / 自愈场景）；否则记 shadowed —— 占位者
  // 卸载后，自愈路径才能从这个扩展把文件补回来，否则「卸一个扩展，
  // 另一个扩展的配置跟着消失」。
  if (isPresent(dst)) {
    let mine = false
    try { mine = lstatSync(dst).isSymbolicLink() && readlinkSync(dst) === src } catch { mine = false }
    views.push({ name: here, target: dst, src, kind: 'view', ...(mine ? {} : { shadowed: true }) })
    return
  }
  try {
    symlinkSync(src, dst)
    views.push({ name: here, target: dst, src, kind: 'view' })
  } catch { /* 单条失败继续 */ }
}

/**
 * 把「整目录软链」物化成真目录，并把它原来的子项逐条补链进来。
 *
 * 必须物化的理由：软链 `root/etc/fonts → <extA>/etc/fonts` 存在时，若直接
 * 往里递归合并 extB 的贡献，写进去的其实是 **extA 的扩展目录**（软链会被
 * 跟随），extA 一卸载就全没了；反过来 extA 卸载时也会把 extB 的东西一起删掉。
 *
 * 物化之后还必须**改写原主的清单**：它记的是「`root/etc/fonts` 是一个指向我的
 * 整目录软链」，而这条软链已经不存在了。不改写的话，原主自愈（relinkAll）时
 * 会把合并目录整个顶掉、卸载时又摘不掉自己留在里面的子链接。
 */
function materialise(dst, rel) {
  let oldTarget = ''
  try { oldTarget = readlinkSync(dst) } catch { return }
  // <extA>/etc/fonts → 上溯两层得到 <extA>
  const oldExtDir = dirname(dirname(oldTarget))

  let children = []
  try { children = readdirSync(oldTarget) } catch { children = [] }

  unlinkSync(dst)
  mkdirSync(dst, { recursive: true })

  const created = []
  for (const child of children) {
    const csrc = join(oldTarget, child)
    const cdst = join(dst, child)
    try {
      symlinkSync(csrc, cdst)
      created.push({ name: `${rel}/${child}`, target: cdst, src: csrc, kind: 'view' })
    } catch { /* 单条失败继续 */ }
  }

  try {
    const file = join(oldExtDir, '.links.json')
    const prev = JSON.parse(readFileSync(file, 'utf8'))
    prev.views = (prev.views ?? []).filter((v) => v.target !== dst).concat(created)
    writeFileSync(file, JSON.stringify(prev, null, 2) + '\n')
  } catch {
    // 老清单没有 views、或清单损坏/只读：交给卸载时的归属校验兜底
  }
}

/**
 * 递归收集 `<extBin>` 下的所有可执行文件，展平软链进 `<engineBin>`。
 *
 * 目录本身也建成目录软链（`<engineBin>/<rel>`），因为 TeX Live 的辅助脚本靠
 * 「自己所在目录」定位兄弟程序（`fmtutil` 找 `pdftex`、`texlinks` 找 `mktexlsr`）。
 *
 * **先处理文件、再下潜目录**：浅层的名字优先拿到干净的命令名。反过来的话，
 * 先递归 `bin/texlive/` 会把 411 个引擎名全占掉，之后 `bin/` 顶层的同名文件
 * 既拿不到干净名、退回相对路径形态也还是同一个串，只能被丢弃。
 */
function collectBins(dir, prefix, engineBin, used, bins, views) {
  let names
  try { names = readdirSync(dir) } catch { return }

  const dirs = []
  for (const name of names) {
    const src = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    let isDir = false
    try { isDir = statSync(src).isDirectory() } catch { continue }
    if (isDir) {
      dirs.push({ name, src, rel })
      continue
    }

    // 文件：展平到 <root>/bin。同一扩展内重名时退回相对路径形态，
    // 保证两个同名命令都还在（跨扩展的重名则后者覆盖前者，与旧行为一致）。
    let flat = name
    if (used.has(flat)) flat = rel.split('/').join('_')
    if (used.has(flat)) continue
    used.add(flat)

    const dest = join(engineBin, flat)
    try {
      if (isPresent(dest)) unlinkSync(dest)
      symlinkSync(src, dest)
      // src 必须记下来：展平后 name 已经不等于扩展内的相对路径
      // （latexmk 实际在 bin/texlive/latexmk），relinkAll 靠它重建。
      bins.push({ name: flat, target: dest, src })
    } catch {
      // 单个命令失败不阻断安装（例如目标只读）
      used.delete(flat)
    }
  }

  for (const { name, src, rel } of dirs) {
    // 目录：按原层级建一条目录软链（`<root>/bin/a/b`），再递归进去展平内容。
    // 用 rel 而不是 name —— 否则多层子目录会全被拍到 `<root>/bin/` 下同名位置。
    const dirDest = join(engineBin, rel)
    try {
      // 已经是本扩展指过来的链接就只登记、不重建 —— 与 mergeEntry 同型。
      // 不这样写的话，从旧布局迁移时 `bin/texlive` 这条旧链接会「存在即跳过」，
      // 于是永远不进 views，之后卸载/自愈都认不出它。
      const mine = isPresent(dirDest)
        && lstatSync(dirDest).isSymbolicLink()
        && readlinkSync(dirDest) === src
      if (mine) {
        views.push({ name: rel, target: dirDest, src, kind: 'dir' })
      } else if (!isPresent(dirDest)) {
        symlinkSync(src, dirDest)
        views.push({ name: rel, target: dirDest, src, kind: 'dir' })
      }
    } catch { /* 忽略 */ }
    // 目录名也占位：展平出来的同名文件不能把这条目录软链顶掉
    used.add(name)
    collectBins(src, rel, engineBin, used, bins, views)
  }
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
  let removedViews = 0
  /** 本次腾空的位置（可能要让位者补位） */
  const freed = new Set()
  try {
    const links = JSON.parse(readFileSync(join(extDir, '.links.json'), 'utf8'))
    for (const bin of links.bins ?? []) {
      // 用 lstat：指向已消失扩展目录的**悬空**链接 existsSync 为 false，
      // 正好会漏掉最需要清的那一批。
      try {
        lstatSync(bin.target)
      } catch { continue }
      try {
        unlinkSync(bin.target)
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
    // 合并视图与目录软链：必须按清单回收，否则卸载后引擎根会留一整套
    // 悬空链接（下一次装机才会发现，报错点离现场很远）。
    // 删之前确认它确实指向本扩展 —— 多个扩展贡献同名资源时后者覆盖前者，
    // 卸载前者不能把后者的链接一起摘掉。用 lstat 而不是 exists：悬空链接
    // existsSync 会返回 false，正好漏掉最需要清的那一批。
    for (const view of links.views ?? []) {
      try {
        if (!lstatSync(view.target).isSymbolicLink()) continue
        if (readlinkSync(view.target) !== view.src) continue
        unlinkSync(view.target)
        removedViews += 1
        freed.add(view.target)
      } catch { /* 单条失败继续 */ }
    }
  } catch {
    // 没有 .links.json（老版本装的扩展）：目录本身照删，链接残留可由
    // relink 机制的下一次升级清理
  }
  rmSync(extDir, { recursive: true, force: true })
  // 让位者补位：自己被遮住的同名叶子在占位者卸载后要重新接上，
  // 否则「卸一个扩展，另一个扩展的配置跟着一起消失」。
  const reclaimed = freed.size > 0 ? reclaimViews(root, freed, id) : 0
  return { ok: true, removedBins, removedLibs, removedViews, reclaimed }
}

/**
 * 补位：把 `freed` 里刚刚空出来的位置，交给仍记着 `shadowed` 条目的扩展。
 *
 * 只在清单里明确标了 `shadowed: true` 的条目上动手 —— 那是 mergeViews 留下的
 * 「我知道这个位置被谁占了」的记录，据此补位是精确的；没有这条记录就不动，
 * 免得把用户手工放进去的东西顶掉。
 */
function reclaimViews(root, freed, skipId) {
  let count = 0
  let entries = []
  try { entries = readdirSync(extensionsDir(root), { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === skipId || entry.name.endsWith('.tmp-install')) continue
    const extDir = join(extensionsDir(root), entry.name)
    let views = []
    try { views = JSON.parse(readFileSync(join(extDir, '.links.json'), 'utf8')).views ?? [] } catch { continue }
    for (const view of views) {
      if (!view.shadowed || !freed.has(view.target)) continue
      if (isPresent(view.target) || !existsSync(view.src)) continue
      try {
        symlinkSync(view.src, view.target)
        count += 1
      } catch { /* 单条失败继续 */ }
    }
  }
  return count
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
    // 缺陷 BH 自愈：老设备上这些裸名库已经躺在 <root>/lib/ 里了（安装期
    // 还没有 SHADOWING_BARE_LIBS 这条规则），rebuild 只跳过复制不会删旧的。
    // 必须在这里主动摘掉，否则用户升级后仍会踩 `Xzs_Construct` /
    // `_Z17createHeifDecoderv`。
    for (const name of SHADOWING_BARE_LIBS) {
      const victim = join(root, 'lib', name)
      try {
        if (lstatSync(victim).isSymbolicLink()) unlinkSync(victim)
        else if (statSync(victim).isFile()) unlinkSync(victim)
      } catch { /* 不存在或删不掉，忽略 */ }
    }
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
          // 新清单带 src（展平后 bin.name 已不等于扩展内相对路径）；旧清单退回一层
          const src = bin.src ?? join(extDir, 'bin', bin.name)
          linkExact(src, bin.target)
        }
        for (const lib of links.libs ?? []) {
          // 缺陷 BH：裸名会遮蔽系统真库，重建时也不再补回来
          if (SHADOWING_BARE_LIBS.has(lib.name)) continue
          try {
            if (existsSync(lib.target)) continue
            const src = join(extDir, 'lib', lib.name)
            if (!existsSync(src)) continue
            copyFileSync(src, lib.target)
          } catch { /* 单条失败继续 */ }
        }
        // 目录软链与 etc/share/opt 合并视图（问题.txt【4】【6】）
        //
        // ⚠️ 不能一律用 linkExact（先摘后建）：合并视图里同一个目录下可能同时
        // 挂着多个扩展的子项（`root/etc/fonts/conf.d` 来自 A、`root/etc/fonts/
        // fonts.conf` 来自 B）。linkExact 会 unlink 掉目标本身 —— 目标若是**真
        // 目录**（物化过的合并目录）会抛错，若是别人的软链则被无谓地摘掉重指。
        // 所以只修「已经存在但指错/悬空」的条目，目标不存在时**只有当父目录不
        // 是别人的扩展目录**才补建 —— 父目录是软链说明原主已被抢先物化覆盖。
        for (const view of links.views ?? []) {
          try {
            const parent = dirname(view.target)
            mkdirSync(parent, { recursive: true })
            if (isPresent(view.target)) {
              if (lstatSync(view.target).isSymbolicLink() && readlinkSync(view.target) === view.src) continue
              // 指错或悬空：只在它仍属于本扩展时修正
              if (lstatSync(view.target).isSymbolicLink()) unlinkSync(view.target)
              else continue // 真目录/真文件，不是我们的链接
            } else if (lstatSync(parent).isSymbolicLink()) {
              continue // 父目录还是软链，说明尚未物化，交给下一次安装时的合并
            }
            if (!existsSync(view.src)) continue
            symlinkSync(view.src, view.target)
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

/**
 * 找出「装配布局落后于当前代码」的扩展 id（问题.txt【4】【6】的升级路径）。
 *
 * 判据是 `.links.json` 里的 `layout` 字段：缺少该字段 = 旧代码装的，小于
 * [LAYOUT_VERSION] = 中间版本装的。两者都需要重新装配。
 *
 * 为什么不让 `RuntimeInstaller` 顺手删掉 `extensions/` 重装：那是**用户态
 * 资产**（用户可以只装自己需要的扩展，也可能往里放过东西），宿主自愈碰它
 * 会误伤。所以布局升级走「检测 → 重新装配」这条路，且只针对**包池里仍然
 * 存在的**扩展 —— 包池没有的（用户自己从别处装的）不动。
 *
 * @returns {string[]} 需要重新装配的扩展 id
 */
export function staleExtensions(root) {
  if (!root) return []
  const extRoot = extensionsDir(root)
  if (!existsSync(extRoot)) return []
  // listPool 返回的是 Map（id → 包文件路径），不是数组
  const pool = new Set(listPool(root).keys())
  const stale = []
  try {
    for (const entry of readdirSync(extRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.endsWith('.tmp-install')) continue
      if (!pool.has(entry.name)) continue
      const linksFile = join(extRoot, entry.name, '.links.json')
      if (!existsSync(linksFile)) continue
      let layout = 0
      let recordedBytes = 0
      try {
        const links = JSON.parse(readFileSync(linksFile, 'utf8'))
        layout = Number(links.layout) || 0
        recordedBytes = Number(links.poolBytes) || 0
      } catch {
        layout = 0
      }
      if (layout < LAYOUT_VERSION) {
        stale.push(entry.name)
        continue
      }
      // 池内容变了（新 APK 换了包）→ 装配出来的目录已经和池对不上。
      // `recordedBytes === 0` 是「这份 .links.json 由还没记 poolBytes 的旧代码
      // 写的」，一律当落后处理；否则比对当前池体积。
      const nowBytes = poolSignature(root, entry.name)
      if (nowBytes > 0 && recordedBytes !== nowBytes) {
        stale.push(entry.name)
      }
    }
  } catch {
    return []
  }
  return stale
}

/**
 * 条目是否存在 —— 连**悬空符号链接**也算存在。
 *
 * `existsSync` 会跟随链接，上一轮遗留的悬空链接返回 false，于是后面的
 * `symlinkSync` 抛 EEXIST、`unlinkSync` 被跳过，条目永远修不回来。
 * 本模块所有「先删后建」「是否已建」的判断都必须用它。
 */
function isPresent(target) {
  try {
    lstatSync(target)
    return true
  } catch {
    return false
  }
}

/**
 * 把 `target` 精确指向 `src`，无论那里现在是什么。
 *
 * 与「只在缺失时创建」不同：自愈路径（relinkAll）必须能**修正指错的链接** ——
 * 扩展目录被移动、runtime 升级换了布局之后，旧链接可能仍存在但指向已经不存在的
 * 目标（悬空）。`existsSync` 对悬空链接返回 false，所以「缺失才建」的老写法会
 * 直接跳过、永远修不回来；这里一律先摘掉再建。
 */
function linkExact(src, target) {
  if (!src || !target) return false
  try {
    if (!existsSync(src)) return false
    if (isPresent(target)) unlinkSync(target)
    symlinkSync(src, target)
    return true
  } catch {
    return false
  }
}
