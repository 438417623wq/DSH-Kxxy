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
  // 造出「运行时完整」的最小形态：否则 RUNTIME 一项会是 BAD/L3，
  // 把 level 断言淹掉，测不出 WEB_BOOT 是否被排除在修复之外。
  mkdirSync(join(engine, 'bin'), { recursive: true })
  writeFileSync(join(engine, 'bin', 'node'), 'x')
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
