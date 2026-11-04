/**
 * 息屏保活的契约测试。
 *
 * 这一层没法在本地做端到端验证 —— 真机上的现象是「内核 suspend-to-idle」，
 * 本地既没有屏幕也没有 ALARM。所以测试钉的是**接线**：哪段代码必须在、
 * 必须由谁调用、JSON 字段必须叫什么。每一条都对应一个「漏了就会静默退化成
 * 原来那个 bug」的点：
 *
 *   [1] 清单与前台服务类型没被改坏（specialUse 是 6 小时限制的解法）
 *   [2] KeepAwake 真的取了 PARTIAL_WAKE_LOCK（只声明权限不算）
 *   [3] 三条驱动都在：引擎状态、屏幕开关、用户开关
 *   [4] 三条退出路径都放锁（用户退出 / 服务销毁 / 引擎停止）
 *   [5] 状态快照的字段名与前端读的键逐字对齐（改名等于改协议）
 *   [6] 设置页开关走 kxxy:// 桥，而不是写 kxxy-prefs.json
 *   [7] 前端脚本语法有效 + 幂等（重复轮询不会把开关刷回去）
 *
 * 用法：node tools/test-keepawake.mjs
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const read = (p) => readFileSync(p, 'utf8')
const norm = (s) => s.replace(/\r\n/g, '\n')

const manifest = read('android/app/src/main/AndroidManifest.xml')
const keepAwake = norm(read('android/app/src/main/java/app/kxxy/service/KeepAwake.kt'))
const service = norm(read('android/app/src/main/java/app/kxxy/service/EngineService.kt'))
const supervisor = norm(read('android/app/src/main/java/app/kxxy/engine/EngineSupervisor.kt'))
const activity = norm(read('android/app/src/main/java/app/kxxy/MainActivity.kt'))
const app = norm(read('android/app/src/main/java/app/kxxy/KxxyApp.kt'))
const html = norm(read('plugins/kxxy-host/web/index.html'))
const js = norm(read('plugins/kxxy-host/web/host.js'))
const css = norm(read('plugins/kxxy-host/web/host.css'))

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

/** 去掉空白后再比对，避免因为换行/缩进让断言假失败。 */
const has = (haystack, needle) => haystack.replace(/\s+/g, ' ').includes(needle.replace(/\s+/g, ' '))

function main() {
  console.log('[1] 清单与前台服务类型')
  {
    ok('WAKE_LOCK 已声明', manifest.includes('android.permission.WAKE_LOCK'))
    // 换成 dataSync 会在 Android 14+ 被 6 小时限时强杀，长任务必断
    ok('前台服务仍是 specialUse', manifest.includes('android:foregroundServiceType="specialUse"'))
    ok('specialUse 子类型仍在', manifest.includes('local_ai_agent_engine'))
    // 不加这一条，Android 14+ 起 specialUse 的前台服务连启动都会被拒
    ok('FOREGROUND_SERVICE_SPECIAL_USE 已声明', manifest.includes('FOREGROUND_SERVICE_SPECIAL_USE'))
    ok('电池优化白名单权限已声明', manifest.includes('REQUEST_IGNORE_BATTERY_OPTIMIZATIONS'))
  }

  console.log('[2] 唤醒锁本体')
  {
    ok('取的是 PARTIAL_WAKE_LOCK', keepAwake.includes('PowerManager.PARTIAL_WAKE_LOCK'))
    ok('关闭引用计数（重复 acquire 不会堆叠）', keepAwake.includes('setReferenceCounted(false)'))
    ok('持锁前检查 isHeld', keepAwake.includes('if (!wl.isHeld)'))
    ok('放锁前检查 isHeld', keepAwake.includes('if (wl?.isHeld == true)'))
    ok('持锁/放锁串行化', keepAwake.includes('synchronized(lock)'))
    // 屏幕亮着时持锁纯属浪费：want 的表达式必须带 !screenOn
    ok('只在息屏时持锁', /want = s\.enabled && s\.engineRunning && !s\.screenOn/.test(keepAwake))
    ok('闲置让位窗口存在', keepAwake.includes('IDLE_RELAX_MS'))
    ok('让位后仍靠采样自愈', keepAwake.includes('activity resumed'))
    // 只算引擎自己会让长时间编译被误判闲置
    ok('CPU 采样含子进程', keepAwake.includes('childPids(pid)'))
    ok('CPU 采样覆盖 cutime/cstime', /at\(13\) \+ at\(14\)/.test(keepAwake))
    ok('开关默认开（修复即生效）', keepAwake.includes('getBoolean(KEY_ENABLED, true)'))
  }

  console.log('[3] 三条驱动')
  {
    ok('KxxyApp 初始化', app.includes('KeepAwake.init(this, appScope)'))
    ok('引擎状态驱动', has(service, 'KeepAwake.onEngineState(st is EngineSupervisor.State.Healthy, supervisor.pid())'))
    ok('订阅息屏保活状态刷通知', service.includes('KeepAwake.status.collectLatest'))
    ok('通知文案区分持锁态', keepAwake !== null && service.includes('R.string.status_healthy_awake'))
    ok('字符串资源存在', read('android/app/src/main/res/values/strings.xml').includes('status_healthy_awake'))
    ok('注册屏幕开关广播', keepAwake.includes('Intent.ACTION_SCREEN_OFF'))
    ok('用户开关入口', keepAwake.includes('fun setEnabled(ctx: Context, on: Boolean)'))
  }

  console.log('[4] 放锁路径')
  {
    ok('用户退出时放锁', has(service, 'KeepAwake.onEngineState(false, 0)'))
    ok('服务销毁（划卡）时放锁', /onDestroy\(\)[\s\S]{0,600}KeepAwake\.onEngineState\(false, 0\)/.test(service))
    ok('shutdown 放锁', /fun shutdown\(\)[\s\S]{0,300}release\("shutdown"\)/.test(keepAwake))
  }

  console.log('[5] 状态快照契约')
  {
    ok('publishState 输出 keepAwake', supervisor.includes('\\"keepAwake\\"'))
    const keys = ['enabled', 'held', 'screenOn', 'engineRunning', 'batteryWhitelisted', 'idleRelaxed', 'idleSec', 'heldSec']
    for (const k of keys) {
      // Kotlin 里是 `append(",\"held\":")`，源码中带反斜杠转义
      ok(`快照字段 ${k}`, keepAwake.includes(`\\"${k}\\"`), 'toJson 少字段会让前端读到 undefined')
    }
    // 键名对齐：前端读的就是这几个
    ok('前端读 enabled', js.includes('ka.enabled'))
    ok('前端读 held', js.includes('ka.held'))
    ok('前端读 batteryWhitelisted', js.includes('ka.batteryWhitelisted'))
    ok('前端读 idleRelaxed', js.includes('ka.idleRelaxed'))
  }

  console.log('[6] 设置页接线')
  {
    ok('开关 DOM 存在', html.includes('id="toggle-keepawake"'))
    ok('电池白名单提示行存在', html.includes('id="row-keepawake-whitelist"'))
    ok('开关走 kxxy://run 桥', js.includes('kxxy://run/keepawake?on='))
    ok('did 不再走 set-toggle（那条只写 kxxy-prefs.json）', !/toggle-keepawake[\s\S]{0,400}set-toggle/.test(js))
    ok('MainActivity 拦截 kxxy://run', has(activity, 'if (request.url.host == "run") return handleRunBridge(request.url)'))
    ok('handleRunBridge 分派 keepawake', has(activity, '"keepawake" ->'))
    ok('打开开关顺手申请 Doze 豁免', activity.includes('batteryWhitelistIntent'))
    ok('渲染进程不随不可见降级', activity.includes('setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)'))
    // 前台保活的另一半：后台时 JS 定时器不能被冻结
    ok('onPause 仍恢复定时器', /override fun onPause\(\)[\s\S]{0,400}resumeTimers\(\)/.test(activity))
    // [hidden] 会被 .setting-row{display:flex} 盖掉 —— 这条 CSS 缺了提示行永远不消失
    ok('hidden 有显式 display:none', /\.setting-row\[hidden\]\s*\{\s*display:\s*none/.test(css))
  }

  console.log('[7] 前端脚本可执行性')
  {
    try {
      execFileSync(process.execPath, ['--check', 'plugins/kxxy-host/web/host.js'], { stdio: 'pipe' })
      ok('host.js 语法有效', true)
    } catch (e) {
      ok('host.js 语法有效', false, String(e.stderr ?? e.message).slice(0, 200))
    }
    // 每次轮询都写 textContent 会让概览/设置页闪一下，且会把用户刚点的开关刷回去
    // —— 只在值真的变了才动 DOM 是这套前端一贯的约定（见 lastBuildKey）
    ok('开关只按快照赋值（不会被轮询刷回）', /dom\.toggleKeepAwake\.checked = ka\.enabled === true/.test(js))
    ok('缺少字段时禁用而非静默', js.includes('当前宿主版本不支持息屏保活'))
  }

  console.log('')
  console.log(fail === 0 ? `全部通过（${pass} 项）` : `${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
