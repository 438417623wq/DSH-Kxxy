/**
 * 启动失败上报 + 插件启停的契约测试。
 *
 * 这两件事都是「体检说没事、用户却进不去」这类事故的产物，靠手工点真机
 * 验证太贵，所以把判定钉在这里：
 *
 *   [1] engine.log 的三种诊断格式都能解析（未激活 / 跳过 bundle / 启动失败）
 *   [2] 只认**最后一次启动之后**的记录（日志是环形的，跨轮次串味会误报）
 *   [3] 浏览器侧失败（`Failed to load plugins`）→ 体检 BAD，且**不触发修复**
 *   [4] 只有 optional 未激活 → WARN，不是 BAD
 *   [5] 插件停用改的是 bundles，dependencies 保留，且留了备份
 *   [6] 核心 bundle 与 kxxy-host 拒绝停用（否则引擎或控制台自己就没了）
 *
 * 用法：node tools/test-bootreport.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

import { parseEngineLog, pluginNamesFrom, collectBootReport } from '../plugins/kxxy-host/lib/bootreport.mjs'
import { runHealthCheck } from '../plugins/kxxy-host/lib/health.mjs'
import { listPlugins, setPluginEnabled } from '../plugins/kxxy-host/lib/plugins.mjs'

let pass = 0
let fail = 0

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'kxxy-boot-'))

// 体检要求核心 bundle 齐全，否则 PROFILE_MANIFEST 会先报红、把 level 抬到 L1，
// 测不出 WEB_BOOT 到底有没有被排除在「修复」之外。
const CORE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-web-mobile']

/** 造一套 home + engine 目录，返回路径。 */
function fixture(name, { log = '', bundles = [], webBoot = null } = {}) {
  const home = join(root, name)
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-web',
        dependencies: Object.fromEntries(bundles.map((b) => [b, '1.0.0'])),
        dsh: { profile: { bundles } },
      },
      null,
      2,
    ),
  )
  const engine = join(root, `${name}-engine`)
  mkdirSync(engine, { recursive: true })
  if (log) writeFileSync(join(engine, 'engine.log'), log)
  // 造出「运行时完整」的最小形态：否则 RUNTIME 一项会是 BAD/L1，
  // 把 level 断言淹掉，测不出 WEB_BOOT 是否被排除在修复之外。
  mkdirSync(join(engine, 'bin'), { recursive: true })
  writeFileSync(join(engine, 'bin', 'node'), 'x', { mode: 0o755 })
  const dshLib = join(engine, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(dshLib, { recursive: true })
  writeFileSync(join(dshLib, 'bin.js'), 'x')
  const hosted = join(engine, 'lib', 'node_modules', 'kxxy-host')
  mkdirSync(hosted, { recursive: true })
  writeFileSync(join(hosted, 'package.json'), '{"name":"kxxy-host"}')
  // 覆盖层：原生层每次启动都会写，缺了会被判 BAD（同样会淹掉 level 断言）
  writeFileSync(join(engine, 'android-overlay.yml'), '- id: probe\n  name: probe\n')
  if (webBoot) {
    mkdirSync(join(home, 'web-boot'), { recursive: true })
    writeFileSync(join(home, 'web-boot', 'web-boot.json'), JSON.stringify(webBoot, null, 2))
  }
  return { home, engine, profile }
}

try {
  // ── [1] 三种诊断格式 ────────────────────────────────────────────────
  console.log('[1] engine.log 解析')
  const log = [
    '---- engine start 1000 ----',
    'web boot: warning: 2 entries did not activate',
    '@neystan/dsh-client-ui-task-board (task-board): pending: client-modules: missed the module table',
    '@neystan/dsh-pet (pet): failed: import failed',
    'web boot: skipping profile bundle "@foo/bar": cannot resolve',
    '',
  ].join('\n')
  const parsed = parseEngineLog(log)
  ok('识别 warning 的条数', parsed.inactive.length === 2, `got ${parsed.inactive.length}`)
  ok('拿到 entry id', parsed.inactive[0].id === '@neystan/dsh-client-ui-task-board')
  ok('识别被跳过的 bundle', parsed.skipped.length === 1 && parsed.skipped[0].name === '@foo/bar')
  ok('没有误判成 required', parsed.required === false)

  const requiredLog = '---- engine start 1 ----\nweb: startup failed: 2 required plugins did not activate\n'
  ok('识别 required 启动失败', parseEngineLog(requiredLog).required === true)

  // ── [2] 只认最后一次启动 ────────────────────────────────────────────
  console.log('[2] 跨轮次隔离')
  const twoRuns = [
    '---- engine start 1000 ----',
    'web boot: warning: 1 entries did not activate',
    '@old/plugin (old): failed: boom',
    '---- engine start 2000 ----',
    'web boot: ready',
    '',
  ].join('\n')
  const second = parseEngineLog(twoRuns)
  ok('上一轮的失败不再计入', second.inactive.length === 0, `got ${second.inactive.length}`)
  ok('启动时刻取最后一次', second.started === 2000, `got ${second.started}`)

  // ── 浏览器侧消息里摘包名 ────────────────────────────────────────────
  console.log('[3] 浏览器消息归因')
  const names = pluginNamesFrom(
    'Uncaught Error: web boot: 4 entries did not activate @neystan/dsh-client-ui-task-board @neystan/dsh-pet dsh-at-file',
  )
  ok('摘出两个 scope 包名', names.includes('@neystan/dsh-pet') && names.includes('@neystan/dsh-client-ui-task-board'))
  ok('摘出无 scope 包名', names.includes('dsh-at-file'))
  ok('不把正文单词当包名', !names.some((n) => n === 'entries' || n === 'activate'))

  // ── [3][4] 体检判定 ────────────────────────────────────────────────
  console.log('[4] 体检：网页端入口')
  const browserOnly = fixture('browser', {
    log: '---- engine start 1000 ----\nweb boot: ready\n',
    bundles: [...CORE],
    webBoot: {
      version: 1,
      updatedAt: 2000,
      entries: [
        {
          at: 1500,
          source: 'http://127.0.0.1:3080/',
          message: 'Uncaught Error: web boot: 2 entries did not activate @neystan/dsh-pet @neystan/dsh-at-file',
        },
      ],
    },
  })
  process.env.DSH_HOME = browserOnly.home
  let health = runHealthCheck(browserOnly.engine)
  let webBoot = health.checks.find((c) => c.code === 'WEB_BOOT')
  ok('浏览器失败 → BAD', webBoot.verdict === 'BAD', webBoot.verdict)
  ok('BAD 里点出包名', webBoot.detail.includes('@neystan/dsh-pet'), webBoot.detail)
  ok('不触发修复（level 仍 NONE）', health.level === 'NONE', health.level)
  ok('总评不是绿色', health.ok === false)
  ok('给出停用指引', /「插件」页停用/.test(webBoot.fixHint || ''), webBoot.fixHint)

  const optionalOnly = fixture('optional', {
    log: '---- engine start 1000 ----\nweb boot: warning: 1 entries did not activate\n@foo/opt (opt): failed: boom\n',
    bundles: [...CORE],
  })
  process.env.DSH_HOME = optionalOnly.home
  health = runHealthCheck(optionalOnly.engine)
  webBoot = health.checks.find((c) => c.code === 'WEB_BOOT')
  ok('只有 optional 失败 → WARN', webBoot.verdict === 'WARN', webBoot.verdict)
  ok('WARN 也不触发修复', health.level === 'NONE', health.level)

  // 补丁降级之后的形态（patches.mjs 的 patchFrontendLenientBoot）：第三方插件
  // 加载失败但被**跳过**，页面照常挂载。这一档必须是 WARN —— 报成 BAD 就等于
  // 又回到「明明进得去，体检说进不去」的老毛病。
  const lenient = fixture('lenient', {
    log: '---- engine start 1000 ----\nweb boot: ready\n',
    bundles: [...CORE],
    webBoot: {
      version: 1,
      updatedAt: 2000,
      entries: [
        {
          at: 1500,
          source: 'http://127.0.0.1:3080/',
          message:
            'web boot: 1 entr from third-party plugins failed and were skipped (their UI stays absent; details below)\n' +
            '@neystan/dsh-pet: import failed: client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table',
        },
      ],
    },
  })
  process.env.DSH_HOME = lenient.home
  health = runHealthCheck(lenient.engine)
  webBoot = health.checks.find((c) => c.code === 'WEB_BOOT')
  ok('已跳过的插件 → WARN（不是 BAD）', webBoot.verdict === 'WARN', webBoot.verdict)
  ok('WARN 里点出包名', webBoot.detail.includes('@neystan/dsh-pet'), webBoot.detail)
  ok('WARN 文案说明页面照常可用', /页面照常可用/.test(webBoot.detail), webBoot.detail)
  ok('降级也不触发修复', health.level === 'NONE', health.level)

  const healthy = fixture('healthy', {
    log: '---- engine start 1000 ----\nweb boot: ready\n',
    bundles: [...CORE],
  })
  process.env.DSH_HOME = healthy.home
  health = runHealthCheck(healthy.engine)
  webBoot = health.checks.find((c) => c.code === 'WEB_BOOT')
  ok('没有失败 → OK', webBoot.verdict === 'OK', webBoot.verdict)

  // 旧记录不该染色：文件里只有上一轮（早于 start）的失败
  const stale = fixture('stale', {
    log: '---- engine start 5000 ----\nweb boot: ready\n',
    bundles: [...CORE],
    webBoot: { version: 1, entries: [{ at: 1000, message: 'web boot: 1 entries did not activate @old/p' }] },
  })
  process.env.DSH_HOME = stale.home
  health = runHealthCheck(stale.engine)
  ok('上一轮的浏览器记录被忽略', health.checks.find((c) => c.code === 'WEB_BOOT').verdict === 'OK')

  console.log('[4b] 定向救援证据')
  ok('网页失败不推荐变更配置', health.target === 'UNKNOWN' && health.level === 'NONE')
  const rescue = fixture('rescue', { bundles: [...CORE] })
  process.env.DSH_HOME = rescue.home
  rmSync(join(rescue.engine, 'bin', 'node'))
  health = runHealthCheck(rescue.engine)
  ok('runtime 故障推荐 L1/RUNTIME 而不是 L3', health.level === 'L1' && health.target === 'RUNTIME')
  ok('runtime 提示独立离线入口', /离线重解/.test(health.checks.find(c => c.code === 'RUNTIME').fixHint))
  writeFileSync(join(rescue.engine, 'bin', 'node'), 'x', { mode: 0o755 })
  writeFileSync(join(rescue.profile, 'cordis.patch.yml'), ' ')
  health = runHealthCheck(rescue.engine)
  ok('坏 profile 补丁只推荐 PROFILE_PATCH', health.target === 'PROFILE_PATCH')
  rmSync(join(rescue.profile, 'cordis.patch.yml'))
  writeFileSync(join(rescue.profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  health = runHealthCheck(rescue.engine)
  ok('合法清单缺 bundle 推荐 BUNDLES 而非 MANIFEST', health.target === 'BUNDLES')
  writeFileSync(join(rescue.profile, 'package.json'), '{bad')
  health = runHealthCheck(rescue.engine)
  ok('坏 JSON 推荐 MANIFEST', health.target === 'MANIFEST')
  writeFileSync(join(rescue.profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: CORE } } }))
  health = runHealthCheck('')
  ok('运行时位置不确定时不推荐变更', health.target === 'UNKNOWN' && health.level === 'NONE')
  const ext = join(rescue.engine, 'extensions', 'broken')
  mkdirSync(ext, { recursive: true })
  writeFileSync(join(ext, '.links.json'), '{bad')
  health = runHealthCheck(rescue.engine)
  ok('仅扩展接入点损坏不推荐启动配置修复', health.target === 'UNKNOWN' && health.level === 'NONE')

  // 从现有宿主脚本提取实际函数做行为回归，无需浏览器或新增测试文件。
  console.log('[4c] 本次救援确认/关联/超时')
  const hostSource = readFileSync(fileURLToPath(new URL('../plugins/kxxy-host/web/host.js', import.meta.url)), 'utf8')
  const metaSource = hostSource.slice(hostSource.indexOf('  const LEVEL_META ='), hostSource.indexOf('  async function fetchHealth'))
  const rescueSource = hostSource.slice(hostSource.indexOf('  const TARGET_META ='), hostSource.indexOf('  function setHealthBusy'))
  async function browserCase({ result, healthy = true, confirm = true, target = 'RUNTIME', level = 'L1', acceptedAt = 1000, advanceTo } = {}) {
    let now = 0
    const timers = []
    const posts = []
    const toasts = []
    const reads = []
    const ctx = createContext({
      Date: { now: () => now }, lastHealth: null, recoveryPending: false,
      document: { createElement: () => ({ addEventListener() {} }) },
      dom: { healthLevels: { appendChild() {} } }, escapeHtml: s => s,
      confirmDialog: async opts => { reads.push(['confirm', opts]); return confirm },
      apiPost: async (url, body) => { posts.push(body); return { accepted: true, requestedAt: acceptedAt } },
      showToast: (message, tone) => toasts.push({ message, tone }),
      setHealthBusy() {}, renderHealth() {},
      setTimeout: (fn, delay) => { const t = { fn, delay }; timers.push(t); return t },
      clearTimeout: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) },
      fetch: async url => { reads.push(url); return { ok: true, json: async () => url.endsWith('/result') ? { result } : { ok: healthy } } },
    })
    runInContext(metaSource + rescueSource, ctx)
    await ctx.requestRecovery(level, target)
    const firstDelay = timers[0]?.delay
    async function tick() {
      const timer = timers.shift()
      if (timer) { now += timer.delay; await timer.fn() }
    }
    await tick()
    const earlySuccess = toasts.some(t => t.tone === 'success')
    // 默认快进 deadline；传 advanceTo 时验证长启动尚在正常等待预算内。
    if (timers.length) { now = advanceTo ?? 700_000; await tick() }
    return { posts, toasts, reads, firstDelay, earlySuccess, pending: runInContext('recoveryPending', ctx) }
  }
  const staleRes = await browserCase({ result: { ok: true, requestedAt: 999 } })
  ok('旧成功结果不能当本次成功', !staleRes.earlySuccess && !staleRes.toasts.some(t => t.tone === 'success'))
  ok('旧结果未触发成功体检捷径', !staleRes.reads.includes('/kxxy/api/health'))
  ok('受理不是成功，超时明确原生入口', staleRes.toasts.some(t => /尚未成功/.test(t.message)) && staleRes.toasts.some(t => /原生救援入口/.test(t.message)))
  ok('offline runtime 精确提交 L1/RUNTIME', staleRes.posts[0]?.level === 'L1' && staleRes.posts[0]?.target === 'RUNTIME')
  const matched = await browserCase({ result: { ok: true, requestedAt: 1000 } })
  ok('本次成功结果 + 成功体检才成功', matched.earlySuccess && !matched.pending)
  const badHealth = await browserCase({ result: { ok: true, requestedAt: 1000 }, healthy: false })
  ok('本次 ok=true 但体检失败不报成功', !badHealth.earlySuccess)
  const failure = await browserCase({ result: { ok: false, requestedAt: 1000, detail: '实际执行失败' } })
  ok('本次失败 detail 原样报告', failure.toasts.some(t => t.tone === 'error' && /实际执行失败/.test(t.message)))
  const missing = await browserCase({ result: null })
  ok('缺执行结果不报成功', !missing.earlySuccess)
  const noId = await browserCase({ acceptedAt: null, result: { ok: true } })
  ok('受理缺 requestedAt 不轮询历史结果', noId.firstDelay === undefined && !noId.earlySuccess)
  const normalStart = await browserCase({ result: null, target: null, advanceTo: 121_000 })
  ok('120 秒启动预算之后仍留合理余量', normalStart.pending)
  const unpacking = await browserCase({ result: null, advanceTo: 300_000 })
  ok('运行时解包数分钟仍等待，不误判成功或超时', unpacking.pending && !unpacking.earlySuccess)
  for (const level of ['L1', 'L2', 'L3', 'UNDO']) {
    const cancelled = await browserCase({ level, target: null, confirm: false })
    ok(`${level} 取消确认不发 POST`, cancelled.posts.length === 0 && /重启引擎/.test(cancelled.reads[0]?.[1]?.desc || ''))
  }
  const undo = await browserCase({ level: 'UNDO', target: undefined, result: { ok: true, requestedAt: 999 } })
  ok('UNDO 同样使用本次关联且不报受理成功', undo.posts[0]?.level === 'UNDO' && !undo.earlySuccess && !undo.pending)

  // ── [5][6] 插件启停 ────────────────────────────────────────────────
  console.log('[5] 插件启停')
  const pluginFixture = fixture('plugins', {
    log: [
      '---- engine start 1000 ----',
      'web boot: warning: 1 entries did not activate',
      '@neystan/dsh-pet (pet): failed: import failed',
      '',
    ].join('\n'),
    bundles: [...CORE, 'kxxy-host', '@neystan/dsh-pet'],
  })
  process.env.DSH_HOME = pluginFixture.home
  const listed = listPlugins(pluginFixture.engine)
  const pet = listed.plugins.find((p) => p.name === '@neystan/dsh-pet')
  ok('清单能列出第三方插件', Boolean(pet), JSON.stringify(listed.plugins.map((p) => p.name)))
  ok('失败插件被标红', pet && pet.failed === true)
  ok('失败插件排在最前', listed.plugins[0].name === '@neystan/dsh-pet', listed.plugins[0].name)
  ok('核心标为受保护', listed.plugins.find((p) => p.name === '@deepseek-ai/dsh-base').protected === true)
  ok('宿主插件标为受保护', listed.plugins.find((p) => p.name === 'kxxy-host').protected === true)

  // 失败原因必须来自**浏览器侧那条消息**：引擎日志只知道「没激活」，真正的
  // 根因（`missed the module table`）只有前端 console 里有。插件页只给红点
  // 不给原因，用户点「停用」时就是在盲猜。
  const reasonFixture = fixture('reason', {
    log: '---- engine start 1000 ----\nweb boot: ready\n',
    bundles: [...CORE, '@neystan/dsh-pet'],
    webBoot: {
      version: 1,
      updatedAt: 2000,
      entries: [
        {
          at: 1500,
          message:
            'web boot: 1 entr from third-party plugins failed and were skipped\n' +
            '@neystan/dsh-pet: import failed: client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table',
        },
      ],
    },
  })
  process.env.DSH_HOME = reasonFixture.home
  const reasonListed = listPlugins(reasonFixture.engine)
  const petReason = reasonListed.plugins.find((p) => p.name === '@neystan/dsh-pet')
  ok('浏览器侧失败也会标红插件的', petReason && petReason.failed === true)
  ok('失败原因取自浏览器消息', /missed the module table/.test(petReason.reason || ''), petReason.reason)

  // 聚合包：`@neystan/dsh-web-ui-all` 自己不上前，只是把子插件的 patch 串起来。
  // 子插件挂了、聚合包不红，用户会看到「插件页一切正常，对话页却少了三个面板」，
  // 而真正该停用的恰恰是这个聚合包。
  const aggFixture = fixture('aggregate', {
    log: '---- engine start 1000 ----\nweb boot: ready\n',
    bundles: [...CORE, '@neystan/dsh-web-ui-all'],
    webBoot: {
      version: 1,
      updatedAt: 2000,
      entries: [
        {
          at: 1500,
          message:
            'web boot: 1 entr from third-party plugins failed and were skipped\n' +
            '@neystan/dsh-pet: import failed: client-modules: missed the module table',
        },
      ],
    },
  })
  const aggDir = join(aggFixture.profile, 'node_modules', '@neystan', 'dsh-web-ui-all')
  mkdirSync(aggDir, { recursive: true })
  writeFileSync(
    join(aggDir, 'package.json'),
    JSON.stringify({
      name: '@neystan/dsh-web-ui-all',
      version: '0.1.16',
      dependencies: { '@neystan/dsh-pet': '0.1.16' },
    }),
  )
  process.env.DSH_HOME = aggFixture.home
  const aggRow = listPlugins(aggFixture.engine).plugins.find((p) => p.name === '@neystan/dsh-web-ui-all')
  ok('聚合包因子插件失败而标红', aggRow && aggRow.failed === true, JSON.stringify(aggRow))
  ok('聚合包借到子插件的原因', /missed the module table/.test(aggRow.reason || ''), aggRow.reason)

  process.env.DSH_HOME = pluginFixture.home

  const disabled = setPluginEnabled('@neystan/dsh-pet', false, pluginFixture.engine)
  ok('停用返回 requiresRestart', disabled.requiresRestart === true)
  const afterManifest = JSON.parse(readFileSync(join(pluginFixture.profile, 'package.json'), 'utf8'))
  ok('bundles 里已摘除', !afterManifest.dsh.profile.bundles.includes('@neystan/dsh-pet'))
  ok('dependencies 仍保留（可一键恢复）', afterManifest.dependencies['@neystan/dsh-pet'] === '1.0.0')
  ok(
    '写盘前留了备份',
    existsSync(join(pluginFixture.profile, 'package.json')) &&
      readFileSync(join(pluginFixture.profile, 'package.json'), 'utf8').includes('bundles'),
  )
  const backups = listBackups(pluginFixture.profile)
  ok('备份文件存在', backups.length >= 1, String(backups.length))

  const reEnabled = setPluginEnabled('@neystan/dsh-pet', true, pluginFixture.engine)
  ok('可以重新启用', reEnabled.enabled === true)
  const restored = JSON.parse(readFileSync(join(pluginFixture.profile, 'package.json'), 'utf8'))
  ok('启用后回到 bundles', restored.dsh.profile.bundles.includes('@neystan/dsh-pet'))

  let refused = ''
  try {
    setPluginEnabled('@deepseek-ai/dsh-base', false, pluginFixture.engine)
  } catch (e) {
    refused = e.message
  }
  ok('核心 bundle 拒绝停用', refused.includes('核心组件'), refused)

  let refusedHost = ''
  try {
    setPluginEnabled('kxxy-host', false, pluginFixture.engine)
  } catch (e) {
    refusedHost = e.message
  }
  ok('宿主插件拒绝停用', refusedHost.includes('核心组件'), refusedHost)

  const noop = setPluginEnabled('@neystan/dsh-pet', true, pluginFixture.engine)
  ok('重复启用不写盘、不报错', noop.changed === false)

  // 清单坏了要说清原因，而不是抛一个看不懂的 JSON 错误
  const broken = fixture('broken', { bundles: [...CORE] })
  writeFileSync(join(broken.profile, 'package.json'), '{ not json')
  process.env.DSH_HOME = broken.home
  let brokenMsg = ''
  try {
    listPlugins(broken.engine)
  } catch (e) {
    brokenMsg = e.message
  }
  ok('坏清单给出可读原因', brokenMsg.includes('不是合法 JSON'), brokenMsg)
} finally {
  delete process.env.DSH_HOME
  rmSync(root, { recursive: true, force: true })
}

function listBackups(dir) {
  try {
    return readdirSync(dir).filter((n) => n.startsWith('package.json.bak-'))
  } catch {
    return []
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
