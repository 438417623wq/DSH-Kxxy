/**
 * 默认模型自愈收敛性测试（kxxy-host/lib/default-model.mjs）。
 *
 * 覆盖：
 *   1. 出厂默认 `deepseek-official` 无凭据 → 自愈切到第一条可用路由 `guiji`，
 *      且第二次启动收敛跳过（不再调 `saveSelection`）；
 *   2. 用户明确选择的自定义路由（如 `chat/gpt-6.2-astra`）即使探测返回空目录
 *      或尚未注册，也绝不静默覆盖，不调 `saveSelection`，且把原因落进 trace；
 *   3. 并发加载竞态：首个 provider（`guiji`）先注册，期待的路由（`chat`）晚一步
 *      注册时，`waitForProviders` 会等待宽限期并判定 `current-usable`。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { ensureUsableDefaultModel } = await import(
  new URL('../plugins/kxxy-host/lib/default-model.mjs', import.meta.url).href
)

function makeCtx({ selection, providers, modelsByProvider, deepseekConfigured = false }) {
  let current = selection
  let saves = 0
  const services = {
    agentDefaultModel: {
      currentSelection: () => current,
      saveSelection: async (next) => {
        saves += 1
        current = next
      },
    },
    llm: {
      listProviders: () => (typeof providers === 'function' ? providers() : providers),
      listModels: async (id) => {
        const entry = modelsByProvider[id]
        if (typeof entry === 'function') return entry()
        return entry ?? []
      },
    },
    credentials: {
      describe: async (key) => ({ configured: key === 'DEEPSEEK_API_KEY' ? deepseekConfigured : true }),
    },
  }
  return {
    get: (name) => services[name] ?? null,
    logger: { warn: () => {}, info: () => {} },
    getSaves: () => saves,
    getCurrent: () => current,
  }
}

const home = mkdtempSync(join(tmpdir(), 'kxxy-selfheal-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = home
// waitForProviders 的轮询 timer 调用了 unref()，纯单测进程里没有其它活跃句柄，需要保活。
const keepAlive = setInterval(() => {}, 1000)

try {
  // 1. 出厂默认 deepseek-official 缺凭据 → 自愈一次，第二轮收敛跳过
  {
    const ctx = makeCtx({
      selection: { provider: 'deepseek-official', model: 'deepseek-flash' },
      providers: [{ id: 'deepseek-official' }, { id: 'guiji' }],
      modelsByProvider: {
        'deepseek-official': [{ id: 'deepseek-flash' }],
        guiji: [{ id: 'deepseek-ai/DeepSeek-V4.1-Flash' }],
      },
      deepseekConfigured: false,
    })
    const r1 = await ensureUsableDefaultModel(ctx, { providerWaitMs: 500, preferredWaitMs: 100 })
    assert.equal(r1.changed, true)
    assert.deepEqual(r1.to, { provider: 'guiji', model: 'deepseek-ai/DeepSeek-V4.1-Flash' })
    assert.equal(ctx.getSaves(), 1)

    const r2 = await ensureUsableDefaultModel(ctx, { providerWaitMs: 500, preferredWaitMs: 100 })
    assert.equal(r2.changed, false)
    assert.equal(r2.skipped, 'current-usable')
    assert.equal(ctx.getSaves(), 1, '第二轮必须收敛，不得重复写回')
  }

  // 2. 用户选择的自定义路由 chat/gpt-6.2-astra 探测返回空目录 → 绝不覆盖，保留用户选择并记日志
  {
    const ctx = makeCtx({
      selection: { provider: 'chat', model: 'gpt-6.2-astra' },
      providers: [{ id: 'guiji' }, { id: 'chat' }],
      modelsByProvider: {
        guiji: [{ id: 'deepseek-ai/DeepSeek-V4.1-Flash' }],
        chat: [],
      },
    })
    const r = await ensureUsableDefaultModel(ctx, { providerWaitMs: 500, preferredWaitMs: 100 })
    assert.equal(r.changed, false)
    assert.equal(r.skipped, 'user-selection-preserved')
    assert.equal(r.reason, 'probe-failed')
    assert.equal(ctx.getSaves(), 0, '不得覆盖用户选定的非默认路由')
    assert.deepEqual(ctx.getCurrent(), { provider: 'chat', model: 'gpt-6.2-astra' })
  }

  // 3. 并发加载竞态：guiji 先注册，chat 延迟 120ms 注册 → 等待宽限期后命中 current-usable
  {
    let calls = 0
    const ctx = makeCtx({
      selection: { provider: 'chat', model: 'gpt-6.2-astra' },
      providers: () => {
        calls += 1
        return calls >= 2 ? [{ id: 'guiji' }, { id: 'chat' }] : [{ id: 'guiji' }]
      },
      modelsByProvider: {
        guiji: [{ id: 'deepseek-ai/DeepSeek-V4.1-Flash' }],
        chat: [{ id: 'gpt-6.2-astra' }],
      },
    })
    const r = await ensureUsableDefaultModel(ctx, { providerWaitMs: 3000, preferredWaitMs: 1500 })
    assert.equal(r.changed, false)
    assert.equal(r.skipped, 'current-usable')
    assert.equal(ctx.getSaves(), 0)
  }

  const log = readFileSync(join(home, '.kxxy', 'default-model.log'), 'utf8')
  assert.ok(log.includes('"phase":"start"'), '缺少 start 诊断轨迹')
  assert.ok(log.includes('"phase":"preserve"'), '缺少 preserve 诊断轨迹')
  assert.ok(log.includes('"error":"empty-catalog"'), '缺少 empty-catalog 诊断轨迹')
  console.log('selfheal 测试通过：出厂自愈收敛 / 保留用户自定义路由 / 并发注册等待 / 诊断落盘')
} finally {
  clearInterval(keepAlive)
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
}
