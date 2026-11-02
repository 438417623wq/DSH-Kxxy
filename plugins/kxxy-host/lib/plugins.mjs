/**
 * 插件启停（控制台侧入口）。
 *
 * 为什么需要它：官方插件管理页在**对话页侧栏**里，而用户遇到的恰恰是
 * 「装了插件导致对话页进不去」—— 需要停用插件的时候，那个入口正好打不开。
 * 于是只剩两条路：清数据（会话、模型配置全丢）或重装 APK。这个模块把
 * 「停用某个插件」变成控制台里一次点击，控制台与对话页同源（127.0.0.1），
 * 但它是独立路由，对话页白屏时照常可用。
 *
 * ## 改哪一层
 *
 * 引擎启动时 `dsh-app-boot` 会读 profile 的 `package.json`：
 *
 *   { "dependencies": { "pkg": "1.2.3" },
 *     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "pkg"] } } }
 *
 * 真正决定「加不加载」的是 `dsh.profile.bundles`。所以：
 *   · 停用 = 从 bundles 里摘掉，**dependencies 保留** —— 包还在盘上，
 *     版本信息还在，随时能一键恢复，不需要重新下载；
 *   · 启用 = 加回 bundles。
 *
 * 刻意不删 `node_modules` 里的包：一是慢（插件动辄几百 MB），二是删了再装
 * 需要网络与 npm 源，而用户当下的诉求是「让我先能进页面」。
 *
 * ## 不可停用的两类
 *
 *   · 核心 bundle（CORE_BUNDLES）—— 摘掉引擎直接起不来；
 *   · `kxxy-host` —— 这个控制台本身就是个插件，停用它等于把控制台的门
 *     从里面锁上，之后只能靠 adb 改文件。
 * 两者都在 UI 上标注「受保护」，不给开关。
 *
 * 全部改动前先备份（`package.json.bak-<时间戳>`），写盘用「临时文件 + rename」，
 * 避免写到一半掉电留下半截 JSON —— 那会让引擎下次完全起不来。
 *
 * @module kxxy-host/plugins
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { CORE_BUNDLES } from './health.mjs'
import { collectBootReport } from './bootreport.mjs'

/** 控制台插件本身：停用它会把「停用插件」的唯一入口也关掉。 */
const HOST_PLUGIN = 'kxxy-host'

/** 受保护名单：核心 bundle + 控制台宿主插件。 */
const PROTECTED = new Set([...CORE_BUNDLES, HOST_PLUGIN])

/** profile 目录（与 EngineConfig.profileDir 一致：$DSH_HOME/profiles/web）。 */
export function profileDir() {
  const home = process.env.DSH_HOME || process.env.HOME || ''
  return home ? join(home, 'profiles', 'web') : ''
}

function manifestPath() {
  const dir = profileDir()
  return dir ? join(dir, 'package.json') : ''
}

/**
 * 读清单。返回原始对象与稳定的 bundles 数组。
 *
 * `dsh.profile.bundles` 缺失时给空数组而不是报错 —— 老版本清单没有这一段，
 * 而被 native `ensureProfileManifest` 补过之后才有。空数组在 UI 上表现为
 * 「没有可停用的插件」，比抛异常更接近事实。
 */
function readManifest() {
  const file = manifestPath()
  if (!file) throw new Error('无法定位 DSH_HOME')
  if (!existsSync(file)) throw new Error(`profile 清单不存在：${file}`)
  let json
  try {
    json = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new Error(`profile 清单不是合法 JSON：${e.message}`)
  }
  const bundles = Array.isArray(json?.dsh?.profile?.bundles) ? json.dsh.profile.bundles : []
  const dependencies = json?.dependencies && typeof json.dependencies === 'object' ? json.dependencies : {}
  return { file, json, bundles, dependencies }
}

/**
 * 读一个包的元数据（版本、描述、真实包名）。
 *
 * 两个查找位置：profile 自己的 `node_modules`（用户从插件页装的）和引擎的
 * `lib/node_modules`（随 runtime 内置的）。都找不到时不算错误 —— 清单里
 * 有、盘上没有，正是「装了但没装全」的状态，UI 要能显示出来并允许停用它。
 */
function packageMeta(name, engineRoot) {
  const dirs = [profileDir() && join(profileDir(), 'node_modules'), engineRoot && join(engineRoot, 'lib', 'node_modules')].filter(Boolean)
  for (const dir of dirs) {
    const file = join(dir, name, 'package.json')
    if (!existsSync(file)) continue
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      return {
        version: String(pkg.version ?? ''),
        description: String(pkg.description ?? ''),
        // 依赖名留一份：判断「这个聚合包是不是因为子插件挂了才红」要用它
        // （见 listPlugins 里的 failed 判定）。不为它多读一次磁盘。
        deps: Object.keys(pkg.dependencies ?? {}),
        found: true,
      }
    } catch {
      return { version: '', description: '', found: true, corrupt: true }
    }
  }
  return { version: '', description: '', found: false }
}

/**
 * 聚合包的红点原因：从它依赖里借一条子插件的解释。
 *
 * `@neystan/dsh-web-ui-all` 这类包自己不上前 —— 它只是把若干子插件的 patch
 * 串起来。子插件加载失败时，红点落在聚合包上（那才是该停用的东西），但它
 * 自己没有任何报错，reasonOf 里也查不到它。这里顺着依赖表往下找一层。
 */
function failedReasonFromDeps(meta, reasonOf) {
  for (const dep of meta.deps ?? []) {
    const reason = reasonOf.get(dep)
    if (reason) return `${dep}: ${reason}`
  }
  return null
}

/**
 * 列表。
 *
 * 排序刻意是「失败的排最前」：用户进这个页面的场景基本就是「刚装了个插件，
 * 现在要把它关掉」，把出问题的那几个顶到最上面，省一次找。
 */
export function listPlugins(engineRoot) {
  const { file, bundles, dependencies } = readManifest()
  const boot = (() => {
    try {
      return collectBootReport(engineRoot, process.env.DSH_HOME || '')
    } catch {
      return { failedNames: [], inactive: [], skipped: [] }
    }
  })()

  const failedSet = new Set(boot.failedNames)
  const reasonOf = new Map()
  for (const item of boot.inactive) reasonOf.set(item.id, item.detail)
  for (const item of boot.skipped) reasonOf.set(item.name, item.reason)
  // 浏览器侧的失败原因也要能显示出来：那条消息里才有真正的根因
  // （`missed the module table - not a platform seed word…`）。用户点「停用」
  // 之前最想知道的就是这个，只给一个红点等于让他猜。
  for (const entry of boot.browser ?? []) {
    const text = String(entry.message ?? '')
    for (const n of entry.names ?? []) {
      if (reasonOf.has(n)) continue
      const line = text.split('\n').find((l) => l.includes(n)) ?? ''
      reasonOf.set(n, (line || text).replace(/\s+/g, ' ').trim().slice(0, 240))
    }
  }

  // 装过的 = 依赖表里的 + bundles 里的（有些 bundle 由 native 直接写进 bundles，
  // 但没写进 dependencies，例如 kxxy-host）
  const installed = new Set([...Object.keys(dependencies), ...bundles])

  // 「已跳过」档：前端降级补丁（patches.mjs 的 patchFrontendLenientBoot）把
  // 第三方插件的加载失败变成「跳过这个插件、页面照常」。这类失败与「对话页
  // 进不去」不是一回事，前端要把两种文案分开，所以在这里标出来。
  const softNames = new Set()
  for (const entry of boot.browser ?? []) {
    if (!/failed and were skipped/.test(String(entry.message ?? ''))) continue
    for (const n of entry.names ?? []) softNames.add(n)
  }

  const plugins = [...installed].map((name) => {
    const meta = packageMeta(name, engineRoot)
    const enabled = bundles.includes(name)
    const protectedPlugin = PROTECTED.has(name)
    // 名字匹配要够松（entry id 常常只是包名的一段），但也不能太松：
    // 4 个字符以下的片段（`dsh`、`kxxy`）会把无关插件一起标红。
    //
    // 也认「自己的依赖有没有挂」：聚合包（`@neystan/dsh-web-ui-all` 这种）自己
    // 不上前，patch 层里 insert 的是它的依赖。子插件挂了、聚合包不红，用户就会
    // 看到「插件页一切正常，对话页却少了三个面板」—— 而真正该停用的恰恰是这个
    // 聚合包（停用它会连带摘掉整张 patch 层）。
    const matched = [...failedSet].filter(
      (f) => nameMatches(name, f) || (meta.deps ?? []).some((d) => nameMatches(d, f)),
    )
    const failed = matched.length > 0
    const soft = failed && matched.every((m) => softNames.has(m))
    return {
      name,
      version: meta.version,
      description: meta.description,
      enabled,
      protected: protectedPlugin,
      kind: CORE_BUNDLES.includes(name) ? 'core' : name === HOST_PLUGIN ? 'host' : 'third',
      /** 清单里有、盘上没有：装了但没装全，停用它是最省事的处理。 */
      missing: !meta.found,
      failed,
      /** true = 失败但已被前端跳过（页面可用，只是功能不出现）。 */
      soft,
      // 聚合包自己没报错，原因来自它的子插件 —— 直接把子插件的那条原因借过来，
      // 否则聚合包只有一个红点、没有任何解释。
      reason: failed ? (reasonOf.get(name) ?? failedReasonFromDeps(meta, reasonOf) ?? '') : '',
    }
  })

  plugins.sort((a, b) => {
    if (a.failed !== b.failed) return a.failed ? -1 : 1
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    const rank = (p) => (p.kind === 'third' ? 0 : p.kind === 'host' ? 1 : 2)
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return a.name.localeCompare(b.name)
  })

  return {
    ok: true,
    profileDir: profileDir(),
    manifestPath: file,
    plugins,
    failures: [...failedSet],
    // 有失败项就说明「对话页可能进不去」，前端据此在顶部给一条醒目提示
    broken: boot.failedNames.length > 0,
  }
}

/**
 * 启停一个插件。
 *
 * @param {string} name 包名（必须是清单里已存在的）
 * @param {boolean} enabled true=启用（写回 bundles），false=停用（移出 bundles）
 */
export function setPluginEnabled(name, enabled, engineRoot) {
  const target = String(name ?? '').trim()
  if (!target) throw new Error('缺少插件名')

  if (PROTECTED.has(target)) {
    throw new Error(`${target} 是核心组件，停用会让引擎或控制台无法启动`)
  }

  const { file, json, bundles, dependencies } = readManifest()
  if (!bundles.includes(target) && !(target in dependencies)) {
    throw new Error(`清单里没有 ${target}，无法启停`)
  }

  const has = bundles.includes(target)
  if (has === Boolean(enabled)) {
    // 已经是目标状态：直接返回，不写盘。前端重复点击不该产生备份垃圾。
    return { ok: true, name: target, enabled: has, changed: false, requiresRestart: false }
  }

  const next = enabled ? [...bundles, target] : bundles.filter((b) => b !== target)

  // 备份：只留最近 5 份，避免每次开关都堆一个文件（body 里的备份是给
  // 「改错了想手工恢复」用的，不是版本历史）
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  try {
    copyFileSync(file, `${file}.bak-${stamp}`)
    pruneBackups(file, 5)
  } catch {
    // 备份失败不阻断：写盘本身是原子的，最坏情况也只是少一份手工恢复点
  }

  json.dsh = json.dsh && typeof json.dsh === 'object' ? json.dsh : {}
  json.dsh.profile = json.dsh.profile && typeof json.dsh.profile === 'object' ? json.dsh.profile : {}
  json.dsh.profile.bundles = next

  const text = `${JSON.stringify(json, null, 2)}\n`
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)

  return { ok: true, name: target, enabled: Boolean(enabled), changed: true, requiresRestart: true }
}

/**
 * 失败名与插件名是否指同一个东西。
 *
 * 两侧都可能只是「一段」：entry id 常常是包名的一部分（`pet` ↔
 * `@neystan/dsh-pet`），所以允许双向 endsWith。但 6 个字符以下不放开
 * `includes`，否则 `dsh`、`kxxy` 这种片段会把无关插件一起标红。
 */
function nameMatches(row, candidate) {
  if (!row || !candidate) return false
  return (
    row === candidate ||
    row.endsWith(`/${candidate}`) ||
    candidate.endsWith(`/${row}`) ||
    (candidate.length >= 6 && row.includes(candidate))
  )
}

/** 只保留最近 N 份 `package.json.bak-*`（时间戳后缀字典序即时间序）。 */
function pruneBackups(file, keep) {
  const dir = join(file, '..')
  const prefix = 'package.json.bak-'
  let names
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(prefix)).sort()
  } catch {
    return
  }
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      unlinkSync(join(dir, n))
    } catch {
      // 删不掉就算了：备份多留一份不影响功能
    }
  }
}
