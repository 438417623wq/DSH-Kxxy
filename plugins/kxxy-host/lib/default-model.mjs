/**
 * kxxy-host / default-model.mjs —— 默认模型自愈。
 *
 * 缺陷背景（真机事故，2026-11-15）：
 *   上游 `@deepseek-ai/dsh-base/cordis.patch.yml` 把入口默认值写死成
 *   `agent-default-model: { provider: deepseek-official, model: deepseek-flash }`。
 *   而 `deepseek-official` 这条路由由 `dsh-llm-deepseek-api-key` 提供，
 *   `resolveDeepSeekApiKey()` 只认凭据库里的 `DEEPSEEK_API_KEY`（装了凭据服务时
 *   以它为准，读不到就直接抛 `MISSING_CREDENTIAL`，**不会**回落到账号登录 ——
 *   账号登录走的是另一条路由 `deepseek-account`）。
 *
 *   于是只要 `$DSH_HOME` 是新建/被重置的（本机实测：18:51 home 被重建），
 *   profile 补丁里那条"用户选过的默认模型"就没了，默认值掉回 deepseek-official，
 *   用户第一句话必然报：
 *     `本轮运行失败 llm-deepseek: no API key for provider route "deepseek-official" … MISSING_CREDENTIAL`
 *   而更困惑的是：用户其实已经在「模型」页配好了别的 provider（硅基流动等）并填了
 *   可用的 key —— 只是默认选择没指过去。界面上看不出这两件事的关联。
 *
 * 决策（为什么不改上游、不改 Kotlin）：
 *   1. 不改 base 的默认值：换台真配了 `DEEPSEEK_API_KEY` 的设备，那个默认值是对的；
 *      改死成第三方 provider 反而是新的错误默认值。
 *   2. 不改 Kotlin 的 android-overlay.yml：overlay 在层叠顺序里**晚于** profile 补丁，
 *      写进去会盖掉用户自己选过的模型（每次启动都被覆盖回默认，比缺陷本身更糟）。
 *   3. 而是**在引擎起步后自检一次**：当前选择不可用（路由没注册 / 路由的模型目录
 *      拉不出来，即凭据缺失）时，按注册顺序挑第一条真正能用的路由，用官方
 *      `agentDefaultModel.saveSelection()` 写回 —— 落点就是「用户自己选过」的那份
 *      profile 补丁，语义完全一致，且只发生一次：下次启动当前选择已可用，直接跳过。
 *
 * 约束：
 *   · 只用引擎公开服务（llm / agentDefaultModel / credentials），全部经 `ctx.get()`
 *     懒取，缺任何一个都静默跳过，绝不拖垮插件加载。
 *   · 每次都给自己上超时：`listModels()` 对官方路由会去拉 /models 列表，没网时不能
 *     把启动拖住。
 *   · 全程吞异常：这是自愈旁路，失败只记日志。
 *
 * @module kxxy-host/default-model
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 等 provider 注册完成的上限（插件是并发加载的，llm 目录可能还没填满）。 */
const PROVIDER_WAIT_MS = 30000

/** 单条路由的模型目录探测上限。 */
const PROBE_TIMEOUT_MS = 8000

/** 轮询 provider 目录的间隔。 */
const POLL_MS = 500

/**
 * 懒取一个引擎服务。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {string} name 服务名。
 * @returns {object | null} 服务实例，缺失时为 null。
 */
function service(ctx, name) {
  try {
    return ctx.get(name) ?? null
  } catch {
    return null
  }
}

/**
 * 给一个可能一直不返回的调用加上超时。
 * @template T
 * @param {() => Promise<T>} factory 调用工厂。
 * @param {number} ms 超时毫秒数。
 * @returns {Promise<T | undefined>} 结果；超时或抛错时为 undefined。
 */
function withTimeout(factory, ms) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(undefined)
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    Promise.resolve()
      .then(factory)
      .then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(undefined)
        },
      )
  })
}

/**
 * 等到 llm 目录里有 provider 为止。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {object} llm `llm` 服务。
 * @param {number} limitMs 最长等待毫秒数。
 * @returns {Promise<Array<{ id: string, name?: string }>>} 已注册路由。
 */
async function waitForProviders(ctx, llm, limitMs) {
  const startedAt = Date.now()
  for (;;) {
    let providers = []
    try {
      providers = llm.listProviders?.() ?? []
    } catch {
      providers = []
    }
    if (providers.length > 0) return providers
    if (Date.now() - startedAt >= limitMs) return providers
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, POLL_MS)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }
}

/**
 * 便宜的先验判断：这条路由的凭据是否明显缺失。
 *
 * 只针对已知的官方 API 路由做精确判断（缺陷就是它）；其它路由一律放行，
 * 交给下面的 `listModels()` 实测。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {string} providerId 路由 id。
 * @returns {Promise<boolean>} true 表示值得探测。
 */
async function routeLooksConfigured(ctx, providerId) {
  if (providerId !== 'deepseek-official') return true
  const credentials = service(ctx, 'credentials')
  if (credentials === null || typeof credentials.describe !== 'function') return true
  try {
    const described = await credentials.describe('DEEPSEEK_API_KEY')
    return described?.configured === true
  } catch {
    return false
  }
}

/**
 * 取一条路由此刻可用的模型目录。
 * @param {object} llm `llm` 服务。
 * @param {string} providerId 路由 id。
 * @returns {Promise<Array<{ id: string }> | null>} 模型列表，不可用时为 null。
 */
async function usableModels(llm, providerId) {
  const models = await withTimeout(() => llm.listModels(providerId), PROBE_TIMEOUT_MS)
  if (Array.isArray(models) && models.length > 0) return models
  return null
}

/**
 * 探测一条路由，并把「为什么不行」记进轨迹。
 *
 * 只看最终结论时，真机上只能看到 `unresolvable`，分不清是「没凭据」「请求超时」
 * 还是「返回空目录」—— 这三种在名单里的处置完全不同（前两种等用户配置，后一种
 * 是路由自己坏了）。所以每条路由的判定依据都落一行。
 *
 * 这里自己 race 而不是复用 `withTimeout()`：后者把异常和超时都压成 `undefined`，
 * 正好把要诊断的东西丢掉。
 *
 * @param {object} llm `llm` 服务。
 * @param {string} providerId 路由 id。
 * @returns {Promise<Array<{ id: string }> | null>} 可用模型目录。
 */
async function probeModels(llm, providerId) {
  /** @type {{ settled: boolean }} */
  const state = { settled: false }
  let outcome
  const timer = new Promise((resolve) => {
    const handle = setTimeout(() => {
      if (state.settled) return
      state.settled = true
      resolve({ timedOut: true })
    }, PROBE_TIMEOUT_MS)
    if (typeof handle.unref === 'function') handle.unref()
  })
  const call = Promise.resolve()
    .then(() => llm.listModels(providerId))
    .then(
      (value) => (state.settled ? { ignored: true } : { value }),
      (error) => (state.settled ? { ignored: true } : { error }),
    )
  outcome = await Promise.race([call, timer])
  state.settled = true
  if (outcome === undefined || outcome.ignored === true) return null
  if (outcome.timedOut === true) {
    await trace({ phase: 'probe', provider: providerId, error: `timeout>${PROBE_TIMEOUT_MS}ms` })
    return null
  }
  if (outcome.error !== undefined) {
    await trace({ phase: 'probe', provider: providerId, error: String(outcome.error?.message ?? outcome.error) })
    return null
  }
  if (!Array.isArray(outcome.value) || outcome.value.length === 0) {
    await trace({ phase: 'probe', provider: providerId, error: 'empty-catalog' })
    return null
  }
  await trace({ phase: 'probe', provider: providerId, models: outcome.value.slice(0, 5).map((model) => model?.id) })
  return outcome.value
}

/**
 * 把一次自检的结果追加到 `$DSH_HOME/.kxxy/default-model.log`（JSONL，每行一条）。
 *
 * 为什么要落盘：这条自愈跑在引擎起步的后台，`ctx.logger` 在移动端 profile 里
 * 没有导出器（`dsh-llm-deepseek-api-key` 的注释也写了同一件事），`warn()` 出去
 * 没人接。真机出事时只剩「什么都没发生」这一种观测结果，排障只能靠猜。
 *
 * 写失败一律吞掉：影响诊断，不影响自愈。
 *
 * @param {object} entry 结果条目。
 * @returns {Promise<void>} 落盘完成。
 */
async function trace(entry) {
  const home = process.env.DSH_HOME ?? ''
  if (home === '') return
  const file = join(home, '.kxxy', 'default-model.log')
  try {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    /* 诊断旁路，忽略 */
  }
}

/**
 * 确认默认模型落在一条真能用的路由上；不可用就换成第一条能用的。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ providerWaitMs?: number, logger?: object }} [options] 覆盖项。
 * @returns {Promise<{ changed: boolean, from?: object | null, to?: object, skipped?: string, unresolvable?: boolean }>}
 *   自愈结果；`changed` 为 true 表示已经写回 profile 补丁。
 */
export async function ensureUsableDefaultModel(ctx, options = {}) {
  let result
  try {
    result = await run(ctx, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await trace({ phase: 'error', message })
    throw error
  }
  await trace({ phase: 'result', ...result })
  // 顺手把这份选择镜像给 headless profile：`dsh headless` 只有 base + headless
  // 两个 bundle，看不到「模型」页写进 web 的那条路由，默认掉回
  // `deepseek-official`（要 DEEPSEEK_API_KEY）→ 用户拿着能用 key 却被告知
  // MISSING_CREDENTIAL。见 mirrorSelectionToHeadless 的文件头。
  try {
    const mirrored = mirrorSelectionToHeadless()
    if (mirrored.changed) await trace({ phase: 'mirror-headless', blocks: mirrored.blocks })
  } catch {
    // 镜像失败不影响自愈本身
  }
  return result
}

/** 镜像文件的首行标记：用户改掉它，宿主就不再覆盖（与 .bashrc 同一套规矩）。 */
const HEADLESS_MIRROR_MARK = '# [kxxy] 由 kxxy-host 从 web profile 镜像，勿手改'

/** 要镜像的条目：模型选择本身 + 定义路由的 llm-* 插件条目。 */
const MIRRORED_ID = /^(agent-default-model$|llm-)/

/**
 * 把一个 patch 文本按**顶层列表项**切开。
 *
 * 不用 YAML 解析器往返一次（`parse` → `stringify`）是刻意的：那样会把用户写的
 * 注释、引号风格、`!!js` 表达式全部重排，镜像文件看起来就成了另一份东西。
 * patch 的顶层项一律以 `- ` 开头（第 0 列），按行切足够，也不会误伤嵌套内容。
 *
 * @param {string} text
 * @returns {string[]} 每个顶层项的原文
 */
function topLevelBlocks(text) {
  const out = []
  let cur = null
  for (const line of String(text).split(/\r?\n/)) {
    if (/^- /.test(line)) {
      if (cur) out.push(cur.join('\n'))
      cur = [line]
    } else if (cur) {
      cur.push(line)
    }
  }
  if (cur) out.push(cur.join('\n'))
  return out.map((block) => block.replace(/\s+$/, ''))
}

/**
 * 把 web profile 里的模型选择（以及定义路由的 `llm-*` 条目）镜像到 headless。
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────────
 *
 * `dsh headless "…"` 起的是 base + headless 两个 bundle，**没有** web 的
 * `cordis.patch.yml`，于是模型选择掉回上游默认 `deepseek-official`；那条路由
 * 只认 `DEEPSEEK_API_KEY`，而用户通常配的是别的 provider（本机是硅基流动）。
 * 症状是 `MISSING_CREDENTIAL: … provider route "deepseek-official"`，看起来
 * 像凭据丢了，其实是"选错路由"。
 *
 * 判据与写回策略都尽量保守：
 *   · 源就是 web 的 patch 文本，只摘 `agent-default-model` 与 `llm-*` 条目；
 *   · 目标文件只接管两种状态：`[]`（出厂空补丁）或**首行是我们的标记**；
 *   · 用户手写过的（首行不是标记）一律不动 —— 那是用户资产；
 *   · 内容一致就不写盘（每次引擎启动都会跑一次）。
 *
 * @param {string} [home] `$DSH_HOME`，默认为环境变量
 * @returns {{changed: boolean, blocks?: number, reason?: string}}
 */
export function mirrorSelectionToHeadless(home = process.env.DSH_HOME ?? '') {
  if (!home) return { changed: false, reason: 'no-home' }
  const from = join(home, 'profiles', 'web', 'cordis.patch.yml')
  const to = join(home, 'profiles', 'headless', 'cordis.patch.yml')

  let source
  try {
    source = readFileSync(from, 'utf8')
  } catch {
    return { changed: false, reason: 'no-web-patch' }
  }

  const blocks = topLevelBlocks(source).filter((block) => {
    const m = /^- id:\s*(\S+)/.exec(block)
    return Boolean(m && MIRRORED_ID.test(m[1].replace(/^['"]|['"]$/g, '')))
  })
  if (!blocks.length) return { changed: false, reason: 'nothing-to-mirror' }

  const body = `${HEADLESS_MIRROR_MARK}\n${blocks.join('\n')}\n`

  let prev = ''
  try {
    prev = readFileSync(to, 'utf8')
  } catch {
    // 文件还不存在：下面按"出厂空补丁"处理
  }
  if (prev === body) return { changed: false, reason: 'same' }
  const isOurs = prev.startsWith(HEADLESS_MIRROR_MARK)
  // 去掉注释行后只剩 `[]` 或空 ⇒ 还是出厂的空补丁
  const isVanilla = prev.replace(/^\s*#.*$/gm, '').trim() === '[]'
  if (prev && !isOurs && !isVanilla) return { changed: false, reason: 'user-edited' }

  try {
    writeFileSync(to, body, 'utf8')
  } catch {
    return { changed: false, reason: 'write-failed' }
  }
  return { changed: true, blocks: blocks.length }
}

/**
 * `ensureUsableDefaultModel` 的实现体（结果统一由外层的包装落盘）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ providerWaitMs?: number, logger?: object }} options 覆盖项。
 * @returns {Promise<object>} 自愈结果。
 */
async function run(ctx, options) {
  const logger = options.logger ?? ctx.logger ?? null
  const defaultModel = service(ctx, 'agentDefaultModel')
  const llm = service(ctx, 'llm')
  if (
    defaultModel === null
    || llm === null
    || typeof defaultModel.currentSelection !== 'function'
    || typeof defaultModel.saveSelection !== 'function'
    || typeof llm.listProviders !== 'function'
    || typeof llm.listModels !== 'function'
  ) {
    return { changed: false, skipped: 'missing-service' }
  }

  const providers = await waitForProviders(ctx, llm, options.providerWaitMs ?? PROVIDER_WAIT_MS)
  if (providers.length === 0) return { changed: false, skipped: 'no-providers' }

  let selection = null
  try {
    selection = defaultModel.currentSelection()
  } catch {
    selection = null
  }

  // 当前选择还能用就什么都不做 —— 用户选过的模型必须原样保留。
  //
  // ⚠️ 必须先过凭据这一关再去问模型目录：`deepseek-official` 的
  // `discoverModels()` 在没密钥时返回空，但 `llm.listModels()` 走的是插件注册时
  // 声明的静态 `models`，没有密钥照样返回 `deepseek-flash` —— 只看列表会把
  // 「写死的默认值 + 从没配过的路由」误判成可用，自愈当场失效（实测过）。
  if (selection?.provider) {
    const configured = await routeLooksConfigured(ctx, selection.provider)
    const currentModels = configured ? await usableModels(llm, selection.provider) : null
    if (currentModels !== null && (!selection.model || currentModels.some((model) => model.id === selection.model))) {
      return { changed: false, from: selection, to: selection, skipped: 'current-usable' }
    }
  }

  for (const provider of providers) {
    if (!(await routeLooksConfigured(ctx, provider.id))) {
      await trace({ phase: 'probe', provider: provider.id, error: 'credential-missing' })
      continue
    }
    const models = await probeModels(llm, provider.id)
    if (models === null) continue
    const pick = models.find((model) => model.id === selection?.model) ?? models[0]
    if (typeof pick?.id !== 'string' || pick.id.length === 0) continue
    let applied = true
    try {
      await defaultModel.saveSelection({ provider: provider.id, model: pick.id })
    } catch (error) {
      logger?.warn?.(`[kxxy-host] 默认模型自愈写回失败：${error instanceof Error ? error.message : String(error)}`)
      return { changed: false, from: selection, skipped: 'save-failed' }
    }
    // `saveSelection()` 在部署里没挂 configEditor 时是**静默返回**的：不抛错，
    // 也不落盘。所以写完必须回读一次 —— 否则日志会撒谎，用户下次启动照旧失败。
    try {
      const after = defaultModel.currentSelection()
      applied = after?.provider === provider.id && after?.model === pick.id
    } catch {
      applied = true
    }
    if (!applied) {
      logger?.warn?.('[kxxy-host] 默认模型自愈：写回后回读未生效（configEditor 未挂载？），请在「模型」页手动选择一次')
      return { changed: false, from: selection, skipped: 'not-applied' }
    }
    logger?.warn?.(
      `[kxxy-host] 默认模型自愈：${selection?.provider ?? '-'}/${selection?.model ?? '-'}`
      + ` → ${provider.id}/${pick.id}（原选择的路由没有可用凭据）`,
    )
    return { changed: true, from: selection, to: { provider: provider.id, model: pick.id } }
  }

  logger?.warn?.('[kxxy-host] 默认模型自愈：没有任何路由可用，保持原选择')
  return { changed: false, from: selection, unresolvable: true }
}
