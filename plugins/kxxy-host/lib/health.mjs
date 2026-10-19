/**
 * 启动配置体检（方案 K 的「常驻」形态）。
 *
 * 为什么放在引擎侧而不是原生侧：
 *
 * 原生侧的 `RecoveryProbe.kt` 只能在**引擎已经死了**之后才被调用（它挂在
 * BootstrapActivity 的 Failed 分支上）。用户真正想要的是「平时就能看见」——
 * 在引擎健康、会话正常的时候，提前知道「下次重启会不会挂」。而 kxxy-host
 * 跑在引擎进程内，能直接读文件、直接用 js-yaml 解析，天然就是最佳位置。
 *
 * 分工（刻意如此，不要混）：
 *   · 体检（本文件）—— **纯只读**，只解析、只比对，绝不改名、绝不删除、
 *     绝不写盘。引擎进程还活着，任何写操作都可能踩到运行中的引擎。
 *   · 修复（RecoveryManager.kt）—— 需要重启引擎、搬文件、重建清单，
 *     只能由原生层做。引擎侧通过写 `recovery.request` 请求原生层执行。
 *
 * 判定依据与原生侧 RecoveryProbe.kt 保持同源，但**不依赖子进程 dump**：
 * 引擎进程内跑 dump 会再起一个 node，既慢又要处理超时；而这里能直接
 * import 官方用的同一个解析器，出错信息与官方启动期逐字一致。
 *
 * @module kxxy-host/health
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * 官方 patch 列表解析器。
 *
 * 优先用 `yaml`（Eemeli Aro 那份）：官方 `dsh-app-boot` 的 `parsePatchList`
 * 用的就是它，报错文本（`YAMLParseError`）与引擎启动期逐字同源，所以体检
 * 结论和真实启动失败能对得上。
 *
 * 退化到 `js-yaml`：两者的错误信息虽然措辞不同（`unexpected end of the
 * stream within a flow collection` vs `... within a double quoted scalar`），
 * 但都属同一族描述，对「这一层能不能解析」这个二元判断足够。
 *
 * **为什么要显式按引擎根找**：正常 require 解析是从本文件向上找
 * `node_modules` —— 在真机上 kxxy-host 装在 `engine/lib/node_modules/` 里，
 * 向上第一跳就是引擎的 node_modules，能命中。但在仓库里开发时
 * （`plugins/kxxy-host/lib/`）向上找不到任何 node_modules，裸 require 必失败，
 * 于是所有 YAML 项都变成 UNKNOWN，体检页永远显示「无法验证」——
 * 开发期完全测不出判定逻辑对不对。所以补一条按 `KXXY_ENGINE_ROOT`
 * 显式解析的路径。
 */
let parserState
function parser() {
  if (parserState !== undefined) return parserState

  const roots = []
  const engineRoot = process.env.KXXY_ENGINE_ROOT
  if (engineRoot) roots.push(join(engineRoot, 'lib', 'node_modules'))

  // ① 官方同源解析器 `yaml`
  for (const base of [null, ...roots]) {
    try {
      const mod = base ? require(join(base, 'yaml')) : require('yaml')
      if (typeof mod?.parse === 'function') {
        parserState = { name: 'yaml', parse: (t) => mod.parse(t) }
        return parserState
      }
    } catch {
      // 换下一个候选
    }
  }

  // ② 退化到 js-yaml
  for (const base of [null, ...roots]) {
    try {
      const mod = base ? require(join(base, 'js-yaml')) : require('js-yaml')
      if (typeof mod?.load === 'function') {
        parserState = { name: 'js-yaml', parse: (t) => mod.load(t) }
        return parserState
      }
    } catch {
      // 换下一个候选
    }
  }

  parserState = null
  return parserState
}

/** 体检结论三态。与原生侧 RecoveryProbe.Verdict 同名同义。 */
export const Verdict = {
  OK: 'OK',
  BAD: 'BAD',
  UNKNOWN: 'UNKNOWN',
}

/**
 * 一条体检项。
 * @typedef {{code: string, title: string, verdict: string, detail: string, fixHint?: string}} Check
 */

function check(code, title, verdict, detail, fixHint) {
  return { code, title, verdict, detail, fixHint }
}

// ---------------------------------------------------------------------------
// 路径推导
// ---------------------------------------------------------------------------

/**
 * 体检需要的全部路径。
 *
 * `DSH_HOME` 由原生 `EngineConfig.buildEnv` 注入（= files/kxxy-home），
 * 引擎根由 `KXXY_ENGINE_ROOT` 注入。两者缺一就没法体检 —— 明确报错，
 * 不要猜默认值（猜错会把用户引导到错误的修复动作上）。
 */
export function healthPaths(root) {
  const home = process.env.DSH_HOME || process.env.HOME || ''
  return {
    engineRoot: root,
    dshHome: home,
    profileDir: home ? join(home, 'profiles', 'web') : '',
    profilePatch: home ? join(home, 'profiles', 'web', 'cordis.patch.yml') : '',
    profileManifest: home ? join(home, 'profiles', 'web', 'package.json') : '',
    profileModules: home ? join(home, 'profiles', 'web', 'node_modules') : '',
    homePatch: home ? join(home, 'cordis.patch.yml') : '',
    overlay: root ? join(root, 'android-overlay.yml') : '',
    // 备份根在 files/ 下（原生 EngineConfig.recoveryRoot），引擎根是
    // files/engine —— 所以是 engine 的兄弟目录，不是子目录。
    recoveryRoot: root ? join(root, '..', 'kxxy-recovery') : '',
  }
}

// ---------------------------------------------------------------------------
// 单项体检
// ---------------------------------------------------------------------------

/**
 * YAML patch 列表体检。
 *
 * 判定顺序与官方 `parsePatchList` 对齐：先解析，再要求「顶层是数组」，
 * 再要求「每个条目是 mapping」。任何一步不过，官方启动都会抛
 * `failed to parse overlay <path>` 并以退出码 1 结束 —— 也就是说这个
 * 文件坏了，引擎一定起不来，属于最高优先级的红项。
 *
 * 注意「overlay」这个词：官方把 label 传成 "overlay"，所以 profile 级
 * 补丁坏了报的也是 `failed to parse overlay`。文案不可作为归因依据，
 * 只有路径可以（缺陷 BU 的教训，见 README）。
 */
function checkPatchFile(file, code, title) {
  if (!file) return check(code, title, Verdict.UNKNOWN, '无法定位 $DSH_HOME')

  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') {
      // 不存在 ≠ 有问题。官方 `existsSync(patchPath)` 为假时直接跳过这一层，
      // 这是完全正常的状态（新装设备就没有 home 级补丁）。
      return check(code, title, Verdict.OK, '未创建（跳过，属正常状态）')
    }
    return check(code, title, Verdict.UNKNOWN, `读取失败：${e?.message ?? e}`)
  }

  if (!text.trim()) {
    // 空文件：官方 yaml.load('') 得到 undefined，随后 `Array.isArray` 为假
    // → 抛「must be a top-level YAML array」。所以空文件是**坏**的，
    // 不是「没问题」。这一点容易想反，注释在此留痕。
    return check(code, title, Verdict.BAD, '文件为空（官方会判为非数组并终止启动）',
      '删除该文件即可恢复默认')
  }

  const y = parser()
  if (!y) {
    return check(code, title, Verdict.UNKNOWN, 'YAML 解析器不可用（引擎 node_modules 里找不到 yaml/js-yaml）')
  }

  let doc
  try {
    doc = y.parse(text)
  } catch (e) {
    // 取第一行就够：YAMLException 的 message 是多行，首行带行列号最有用。
    const first = String(e?.message ?? e).split('\n')[0]
    return check(code, title, Verdict.BAD, `YAML 解析失败：${first}`,
      '这一层配置写坏了，引擎重启时会直接退出')
  }

  if (doc === undefined || doc === null) {
    return check(code, title, Verdict.BAD, '解析结果为空（官方要求顶层是数组）',
      '删除该文件即可恢复默认')
  }

  if (!Array.isArray(doc)) {
    return check(code, title, Verdict.BAD,
      `顶层不是数组（实际是 ${typeof doc}），官方要求 YAML 数组`,
      '每条插件配置都必须写成 `- id: xxx` 形式的数组元素')
  }

  for (let i = 0; i < doc.length; i += 1) {
    const entry = doc[i]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return check(code, title, Verdict.BAD,
        `第 ${i + 1} 个条目不是 mapping（实际是 ${entry === null ? 'null' : typeof entry}）`,
        '数组元素必须是 `- id: ...` 这样的键值对象')
    }
  }

  return check(code, title, Verdict.OK, `${doc.length} 条配置，可解析`)
}

/**
 * profile 清单（package.json）体检。
 *
 * 官方 `readProfileManifest` 的顺序是「先读文件 → 再 JSON.parse → 再
 * 要求是对象」，任一步失败都抛 `failed to read profile manifest` 并终止
 * 启动。这里逐条复刻，包括 BOM 容忍（官方 readFileSync + JSON.parse
 * 不容忍 BOM，但原生侧 ensureProfileManifest 读的时候会剥 BOM —— 两者
 * 不一致正是缺陷 C 的土壤，所以体检要按**官方**的口径判，因为起不来的
 * 是官方那条路径）。
 */
function checkProfileManifest(file, coreBundles) {
  const code = 'MANIFEST'
  const title = 'profile 清单'
  if (!file) return check(code, title, Verdict.UNKNOWN, '无法定位 $DSH_HOME')

  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return check(code, title, Verdict.BAD, '清单不存在（引擎无法解析 profile）',
        '点「一键修复」会自动重建一份最小清单')
    }
    return check(code, title, Verdict.UNKNOWN, `读取失败：${e?.message ?? e}`)
  }

  // 官方 readFileSync(path, 'utf8') + JSON.parse 不剥 BOM → BOM 会让
  // JSON.parse 抛 "Unexpected token"。原生侧 ensureProfileManifest 剥了，
  // 所以带 BOM 的清单能活到引擎启动，然后死在官方解析上。
  if (raw.charCodeAt(0) === 0xfeff) {
    return check(code, title, Verdict.BAD, '文件带 UTF-8 BOM（官方 JSON.parse 会失败）',
      '点「一键修复」会重写为无 BOM 的最小清单')
  }

  let json
  try {
    json = JSON.parse(raw)
  } catch (e) {
    return check(code, title, Verdict.BAD, `JSON 解析失败：${e?.message ?? e}`,
      '点「一键修复」会备份坏文件并重建最小清单')
  }

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return check(code, title, Verdict.BAD, '顶层不是 JSON 对象', '点「一键修复」会重建')
  }

  const bundles = json?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    return check(code, title, Verdict.BAD,
      'dsh.profile.bundles 缺失或不是数组（引擎会退回内置默认，移动端 UI 会消失）',
      '点「一键修复」会写入核心三项')
  }

  const missing = coreBundles.filter((b) => !bundles.includes(b))
  if (missing.length) {
    return check(code, title, Verdict.BAD,
      `核心 bundle 缺失：${missing.join(', ')}`,
      missing.includes('dsh-web-mobile')
        ? '缺移动端 UI 插件，修复后会补回'
        : '点「一键修复」会补回核心三项')
  }

  const extra = bundles.filter((b) => !coreBundles.includes(b))
  return check(code, title, Verdict.OK,
    extra.length
      ? `${bundles.length} 项（核心 3 项齐全，另有 ${extra.length} 个第三方 bundle）`
      : `${bundles.length} 项，全部为核心 bundle`)
}

/**
 * 宿主覆盖层体检。
 *
 * `android-overlay.yml` 是原生层生成的（EngineConfig.overlayContent），
 * 引擎侧不该改它，但可以检查「它是否还在、是否还能解析」。它坏了等于
 * 沙箱策略/权限三档/office 字体/kxxy-host 挂载全部失效 —— 引擎能起来
 * 但行为完全不对，属于「隐性故障」，正是常驻体检最该抓的一类。
 */
function checkOverlay(file) {
  const code = 'OVERLAY'
  const title = '宿主覆盖层'
  if (!file) return check(code, title, Verdict.UNKNOWN, '无法定位引擎根')

  let st
  try {
    st = statSync(file)
  } catch {
    return check(code, title, Verdict.BAD, '文件不存在',
      '引擎启动时原生层会自动重建；若反复消失说明运行时被改动')
  }
  if (!st.isFile() || st.size === 0) {
    return check(code, title, Verdict.BAD, '文件为空', '引擎启动时会自动重建')
  }

  const y = parser()
  if (!y) return check(code, title, Verdict.UNKNOWN, 'YAML 解析器不可用')

  let doc
  try {
    doc = y.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    const first = String(e?.message ?? e).split('\n')[0]
    return check(code, title, Verdict.BAD, `YAML 解析失败：${first}`,
      '引擎启动时原生层会按内容比对重写')
  }
  if (!Array.isArray(doc)) {
    return check(code, title, Verdict.BAD, '顶层不是数组', '引擎启动时会自动重建')
  }
  return check(code, title, Verdict.OK, `${doc.length} 条覆盖配置，可解析`)
}

/**
 * 扩展目录体检。
 *
 * `engine/extensions/` 下的每个子目录都由 kxxy-host 的扩展中心安装，
 * **它们没有 `package.json`** —— 那是 deb 包解出来的纯目录树（`bin/`
 * `lib/` `share/`），元数据在三个点文件里：
 *   · `.links.json`  —— 接入点清单（`views[]` 记录每条软链的 src/target，
 *                       还有 `layout` 布局版本与 `poolBytes`）
 *   · `.ext-version` —— 装的是哪个版本
 *   · `.ext-progress.json` —— 安装进度（装完不删，留着给 UI 显示）
 *
 * 首版按「npm 包」的直觉去查 `package.json`，结果 25 个扩展**全部**被判
 * 有问题 —— 一个把用户吓一跳、又完全修不掉的假红项（真机上实测到）。
 * 判据改成 `.links.json` 能不能解析：它才是扩展中心真正依赖的文件，
 * 坏了会让「扩展」页渲染不出接入点。
 *
 * 严重度：黄项。扩展是按需接入的，`.links.json` 坏了不影响引擎启动，
 * 只影响扩展中心页与那几个工具能不能在 PATH 里被找到。
 */
function checkExtensions(dir) {
  const code = 'EXTENSIONS'
  const title = '扩展目录'
  if (!dir) return check(code, title, Verdict.UNKNOWN, '无法定位引擎根')

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    if (e?.code === 'ENOENT') return check(code, title, Verdict.OK, '未安装任何扩展')
    return check(code, title, Verdict.UNKNOWN, `读取失败：${e?.message ?? e}`)
  }

  const dirs = entries.filter((x) => x.isDirectory() && !x.name.endsWith('.tmp-install'))
  if (!dirs.length) return check(code, title, Verdict.OK, '未安装任何扩展')

  const broken = []
  for (const d of dirs) {
    const linksFile = join(dir, d.name, '.links.json')
    if (!existsSync(linksFile)) {
      // 没有 .links.json 有两种可能：① 安装没跑完就被杀（.ext-progress.json
      // 还在、且目录里只有部分文件）② 用户手工扔进来的目录。两者都不该
      // 报红 —— 前者的自愈路径是「重装」，后者根本不该管。
      continue
    }
    try {
      const links = JSON.parse(readFileSync(linksFile, 'utf8'))
      if (!Array.isArray(links?.views)) broken.push(d.name)
    } catch {
      broken.push(d.name)
    }
  }

  if (broken.length) {
    return check(code, title, Verdict.BAD,
      `${broken.length}/${dirs.length} 个扩展的接入点清单损坏：${broken.slice(0, 3).join(', ')}${broken.length > 3 ? ' …' : ''}`,
      '在「扩展」页卸载后重装即可，不影响引擎启动')
  }
  return check(code, title, Verdict.OK, `${dirs.length} 个扩展接入点清单正常`)
}

/**
 * 运行时锚点体检。
 *
 * 只查「最关键的三个文件在不在、可不可执行」，完整十三锚点判定在原生
 * `RuntimeInstaller.isComplete` 里（它会在引擎启动前跑，那里才是权威）。
 * 这里查的是「引擎已经跑起来了，但运行时被中途破坏」这种边缘情况 ——
 * 真机上发生过（用户清缓存、外部工具误删）。
 */
function checkRuntime(root) {
  const code = 'RUNTIME'
  const title = '运行时文件'
  if (!root) return check(code, title, Verdict.UNKNOWN, '无法定位引擎根')

  const probes = [
    ['bin/node', 'Node 可执行文件', true],
    ['lib/node_modules/@deepseek-ai/dsh/lib/bin.js', 'DSH 引擎入口', false],
    ['lib/node_modules/kxxy-host/package.json', '宿主插件清单', false],
  ]
  const bad = []
  // 可执行位只在 POSIX 上有意义。Windows 的 stat 把 mode 合成为
  // 「可写就 0o666、只读就 0o444」，恒不带 x 位 —— 于是冒烟测试在开发机
  // 上会把 bin/node 判成「缺可执行位」，进而把力度抬到 L3（建议重建整个
  // 运行时）。那是个纯粹的构建机假阳性，必须按平台跳过。
  const checkExec = process.platform !== 'win32'
  for (const [rel, label, needExec] of probes) {
    const full = join(root, rel)
    try {
      const st = statSync(full)
      if (!st.isFile() || st.size === 0) bad.push(`${label} 为空`)
      else if (needExec && checkExec && (st.mode & 0o111) === 0) bad.push(`${label} 缺可执行位`)
    } catch {
      bad.push(`${label} 缺失`)
    }
  }
  if (bad.length) {
    return check(code, title, Verdict.BAD, bad.join('；'),
      '运行时被破坏，需要重新解压（L3 修复）')
  }
  return check(code, title, Verdict.OK, '关键文件齐全')
}

// ---------------------------------------------------------------------------
// 备份记录（只读）
// ---------------------------------------------------------------------------

/**
 * 读最近一次修复的备份记录。
 *
 * 备份目录由原生 `RecoveryManager` 写（`files/kxxy-recovery/<时间戳>/manifest.json`）。
 * 引擎侧只读，用于在页面上显示「上次修过什么、能不能撤销」。
 *
 * 目录名是 `yyyyMMdd-HHmmss`，字典序即时间序 —— 不需要解析时间戳就能
 * 取最新的一份（同秒碰撞由原生侧加 -1 后缀处理，字典序仍然正确）。
 */
export function latestRecovery(recoveryRoot) {
  if (!recoveryRoot) return null
  let names
  try {
    names = readdirSync(recoveryRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return null
  }
  for (let i = names.length - 1; i >= 0; i -= 1) {
    const dir = join(recoveryRoot, names[i])
    const manifest = join(dir, 'manifest.json')
    if (!existsSync(manifest)) continue
    try {
      const json = JSON.parse(readFileSync(manifest, 'utf8'))
      return {
        dirName: names[i],
        createdAt: json.createdAt ?? null,
        level: json.level ?? '?',
        headline: json.headline ?? '',
        changes: Array.isArray(json.changes) ? json.changes : [],
        manifestRebuilt: json.manifestRebuilt === true,
      }
    } catch {
      // 坏清单跳过，继续找上一份
    }
  }
  return null
}

/** 备份份数（页面上显示「保留 N 份，超出自动清理」）。 */
export function recoveryCount(recoveryRoot) {
  if (!recoveryRoot) return 0
  try {
    return readdirSync(recoveryRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(recoveryRoot, d.name, 'manifest.json')))
      .length
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/**
 * 核心 bundle 名单。**必须与原生 `EngineConfig.CORE_BUNDLES` 逐字一致**，
 * 否则体检会说「核心齐全」而原生修复写入另一套 —— 那是比不体检更坏的状态。
 * （同步点：EngineConfig.kt 的 CORE_BUNDLES；改动需两处同时改。）
 */
export const CORE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dsh-web-mobile',
]

/**
 * 跑一次完整体检。
 *
 * 返回的 `level` 是「建议的修复力度」，与原生 `RecoveryManager.Level`
 * 对应：NONE 表示不需要修复（页面显示全绿即可，不给按钮）。
 */
export function runHealthCheck(root) {
  const p = healthPaths(root)
  const checks = [
    checkPatchFile(p.profilePatch, 'PROFILE_PATCH', 'profile 补丁'),
    checkPatchFile(p.homePatch, 'HOME_PATCH', 'home 补丁'),
    checkProfileManifest(p.profileManifest, CORE_BUNDLES),
    checkOverlay(p.overlay),
    checkExtensions(p.engineRoot ? join(p.engineRoot, 'extensions') : ''),
    checkRuntime(p.engineRoot),
  ]

  const bad = checks.filter((c) => c.verdict === Verdict.BAD)
  const unknown = checks.filter((c) => c.verdict === Verdict.UNKNOWN)

  // 建议力度：红项里只要有「补丁/清单」类，L1 就能解（移文件 + 收缩 bundle）；
  // 只有运行时坏了才需要 L3。
  let level = 'NONE'
  if (bad.some((c) => c.code === 'RUNTIME')) level = 'L3'
  else if (bad.length) level = 'L1'

  let headline
  if (!bad.length && !unknown.length) headline = '启动配置健康，下次重启可以正常起来'
  else if (!bad.length) headline = `有 ${unknown.length} 项无法验证（不影响启动）`
  else headline = `发现 ${bad.length} 项问题，建议修复后再重启`

  return {
    ok: bad.length === 0,
    headline,
    level,
    checkedAt: Date.now(),
    paths: {
      dshHome: p.dshHome,
      profileDir: p.profileDir,
      engineRoot: p.engineRoot,
    },
    checks,
    lastRecovery: latestRecovery(p.recoveryRoot),
    recoveryCount: recoveryCount(p.recoveryRoot),
  }
}
