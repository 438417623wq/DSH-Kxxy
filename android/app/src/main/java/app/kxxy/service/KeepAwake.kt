package app.kxxy.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

/**
 * 息屏保活 —— 让「锁屏后任务继续跑」这件事真正成立。
 *
 * ── 事故现象 ────────────────────────────────────────────────────────────
 *
 * 用户原话：「会话执行任务调用模型，手机在后台运行是没问题的，但是手机息屏
 * 会话也不会中断，就是任务也不会继续 —— 我是看模型调用看出来的，已经不调用了。」
 *
 * 也就是说：进程没死（会话还在），但引擎停止发请求。这不是崩溃，是**整台设备
 * 睡过去了**。
 *
 * ── 为什么前台服务不够 ──────────────────────────────────────────────────
 *
 * 这套宿主原本只有 [EngineService]（specialUse 前台服务）这一层。它能防住
 * 「进程被 LMK 回收 / 被判为 cached 后冻结」，但**完全防不住 CPU 挂起**：
 * 屏幕一灭，只要没有别的应用持唤醒锁，内核几秒内就 suspend-to-idle，所有
 * 线程停在原地 —— Node 的事件循环不再转，正在飞的 HTTP 请求既不超时也不
 * 完成。表现正是「不报错、不中断、也不继续」。回前台时内核被点亮，事件循环
 * 从断点继续，于是看起来「一解锁就接着跑」。
 *
 * 所以必须有 [PowerManager.PARTIAL_WAKE_LOCK]。清单里早就有 WAKE_LOCK 权限，
 * 但**没有任何一行代码去取它** —— 这就是根因。
 *
 * ── 三个设计约束 ────────────────────────────────────────────────────────
 *
 * 1. **只在息屏时持锁**
 *    亮屏时屏幕本身就在阻止 suspend，再持锁纯属浪费。判断依据是
 *    `PowerManager.isInteractive` + SCREEN_ON/OFF 广播（这两条广播在
 *    Android 8+ 的后台广播限制白名单里，动态注册可靠）。
 *
 * 2. **闲置 10 分钟自动让位**
 *    整夜持锁会让待机耗电从 ~1%/h 涨到 ~2-3%/h。所以按**引擎进程树的 CPU
 *    时间**判断「到底有没有在干活」：连续 [IDLE_RELAX_MS] 没有任何增量就释放，
 *    检测到活动立刻重新持有。任务在跑（流式出字、工具执行、编译）时 CPU 必然
 *    有增量，不会误让位；纯等待模型首字（可能几分钟）也留足了窗口。
 *
 *    让位后采样协程**不退出**（只是不持锁），靠 `delay` 挂起、不占定时器 ——
 *    设备 suspend 期间它自然不跑，被任意网络包/闹钟唤醒后又继续采样，于是
 *    「新任务自己把锁要回来」。这正是「让位」不必配闹钟的原因。
 *
 * 3. **不改前台服务语义**
 *    只加一把 CPU 锁，不引入第二套保活机制、不申请新的危险权限。锁在进程
 *    死亡时由系统自动回收，不会出现「锁泄漏把电池吸干」的最坏情况。
 *
 * ── 与 Doze 的边界（必须说清） ──────────────────────────────────────────
 *
 * Android 的 Doze（深度休眠）里**系统会无视唤醒锁**，并且掐断应用的网络。
 * 息屏静止半小时以上就会进入。所以本类只解决「短时间息屏」；长时间息屏要
 * 用户把应用加入「电池优化白名单」（设置页「电池优化白名单」那一行，
 * 或打开开关时的系统对话框）。前端会按 [Status.batteryWhitelisted] 提示。
 */
object KeepAwake {

    private const val TAG = "KxxyKeepAwake"

    /** 偏好文件名。与 `kxxy-host` 的 `kxxy-prefs.json` 无关：那份是插件的，这份是原生的。 */
    private const val PREFS = "kxxy-keepawake"

    /** 开关。默认 **开** —— 修复上线即生效，用户不需要先去某个角落点一下。 */
    private const val KEY_ENABLED = "enabled"

    /** 唤醒锁 tag（`adb shell dumpsys power | grep kxxy` 能看到它）。 */
    private const val LOCK_TAG = "kxxy:engine"

    /** 采样周期。20 秒一次，单次读 /proc 约 1-3 ms，息屏期间的开销可忽略。 */
    private const val SAMPLE_INTERVAL_MS = 20_000L

    /** 连续这么久没有 CPU 增量就放开锁（让整机正常休眠）。 */
    private const val IDLE_RELAX_MS = 10 * 60_000L

    /**
     * 判定「在干活」的最小 CPU 增量（单位：jiffies，通常 100/s）。
     *
     * 一个采样周期内 ≥ 8 jiffies ≈ 80ms CPU ≈ 0.4% 单核占用。定这么低是刻意的：
     * 息屏期间管理页仍会轮询状态、引擎自己的定时器也在跑，这些「背景噪音」
     * 本来就不该被当成任务活动 —— 但宁可多持锁（费电）也不能误让位（丢任务）。
     */
    private const val ACTIVE_TICKS = 8L

    /** 一次 Kxxy 状态快照。字段名即 `/kxxy/api/state` 里 `keepAwake.*` 的键。 */
    data class Status(
        /** 用户开关。 */
        val enabled: Boolean = true,
        /** 此刻是否真的持着 CPU 锁。 */
        val held: Boolean = false,
        /** 屏幕是否亮着。 */
        val screenOn: Boolean = true,
        /** 引擎是否处于 Healthy。 */
        val engineRunning: Boolean = false,
        /** 是否已加入电池优化白名单（Doze 豁免）。 */
        val batteryWhitelisted: Boolean = false,
        /** 是否因为长时间闲置而主动让位。 */
        val idleRelaxed: Boolean = false,
        /** 距上一次检测到引擎活动的秒数。 */
        val idleSec: Int = 0,
        /** 本次已持续持锁的秒数。 */
        val heldSec: Int = 0,
    ) {
        fun toJson(): String = buildString {
            append("{\"enabled\":").append(enabled)
            append(",\"held\":").append(held)
            append(",\"screenOn\":").append(screenOn)
            append(",\"engineRunning\":").append(engineRunning)
            append(",\"batteryWhitelisted\":").append(batteryWhitelisted)
            append(",\"idleRelaxed\":").append(idleRelaxed)
            append(",\"idleSec\":").append(idleSec)
            append(",\"heldSec\":").append(heldSec)
            append("}")
        }
    }

    private val _status = MutableStateFlow(Status())

    /** 供 [EngineService] 刷通知、[EngineSupervisor] 落快照、管理页轮询。 */
    val status: StateFlow<Status> = _status.asStateFlow()

    private var appContext: Context? = null
    private var scope: CoroutineScope? = null
    private var wakeLock: PowerManager.WakeLock? = null

    /** 持锁/放锁的监视器（见 [acquire] 的注释）。 */
    private val lock = Any()

    private var sampler: Job? = null
    private var receiver: BroadcastReceiver? = null

    /** 最近一次检测到引擎活动的时刻。 */
    private var lastActiveAt = 0L

    /** 本次持锁起点。 */
    private var acquiredAt = 0L

    /** 上一次采样到的 CPU 时间；-1 表示「还没采过」，下一次只记录不比较。 */
    private var lastTicks = -1L

    /** 当前引擎 pid；0 表示未运行。 */
    private var enginePid = 0

    // ── 生命周期 ────────────────────────────────────────────────────────

    /** 由 [app.kxxy.KxxyApp] 调用一次。 */
    fun init(ctx: Context, coroutineScope: CoroutineScope) {
        if (appContext != null) return
        appContext = ctx.applicationContext
        scope = coroutineScope

        val power = ctx.getSystemService(PowerManager::class.java)
        val interactive = power?.isInteractive ?: true
        val enabled = prefs(ctx).getBoolean(KEY_ENABLED, true)

        _status.value = Status(
            enabled = enabled,
            screenOn = interactive,
            batteryWhitelisted = isBatteryWhitelisted(ctx),
        )

        // 屏幕开关必须动态注册：ACTION_SCREEN_ON/OFF 不能写进静态清单
        // （系统只对动态接收者派发这两条广播）。
        runCatching {
            val r = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    onScreenChanged(intent?.action == Intent.ACTION_SCREEN_ON)
                }
            }
            ctx.applicationContext.registerReceiver(
                r,
                IntentFilter().apply {
                    addAction(Intent.ACTION_SCREEN_ON)
                    addAction(Intent.ACTION_SCREEN_OFF)
                },
            )
            receiver = r
        }.onFailure { Log.w(TAG, "screen receiver failed: ${it.message}") }

        Log.i(TAG, "init · enabled=$enabled screenOn=$interactive")
    }

    /** 应用退出前调用（目前只有引擎显式退出路径会走到）。 */
    fun shutdown() {
        sampler?.cancel()
        sampler = null
        release("shutdown")
        runCatching { receiver?.let { appContext?.unregisterReceiver(it) } }
        receiver = null
    }

    // ── 外部输入 ────────────────────────────────────────────────────────

    /** 引擎状态变化：Healthy 时 running=true，其余全是 false。 */
    fun onEngineState(running: Boolean, pid: Int) {
        val wasRunning = _status.value.engineRunning
        enginePid = if (running) pid else 0
        if (running && !wasRunning) {
            // 引擎刚起来：重新开始计活跃时间，别让上一轮的闲置记录把它顶到让位
            lastActiveAt = System.currentTimeMillis()
            lastTicks = -1L
        }
        update { it.copy(engineRunning = running) }
        reconcile()
        ensureSampler()
    }

    /** 用户改了开关（设置页 → `kxxy://run/keepawake?on=`）。 */
    fun setEnabled(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_ENABLED, on).apply()
        if (on) {
            lastActiveAt = System.currentTimeMillis()
            lastTicks = -1L
        }
        update { it.copy(enabled = on, idleRelaxed = false) }
        Log.i(TAG, "setEnabled=$on")
        reconcile()
        ensureSampler()
    }

    /** 是否已加入电池优化白名单（Doze 豁免）。 */
    fun isBatteryWhitelisted(ctx: Context): Boolean = runCatching {
        ctx.getSystemService(PowerManager::class.java)
            ?.isIgnoringBatteryOptimizations(ctx.packageName) ?: false
    }.getOrDefault(false)

    /**
     * 拉起系统的「电池优化」对话框。
     *
     * 为什么必须由 Activity 发起：Android 10+ 对后台启动系统页面有额外限制，
     * 而且 `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 的弹窗本身要求应用
     * 处于前台可见状态。调用方是 [app.kxxy.MainActivity]，不要在这里自己 start。
     */
    fun batteryWhitelistIntent(ctx: Context): Intent? = runCatching {
        Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            android.net.Uri.parse("package:${ctx.packageName}"),
        )
    }.getOrNull()

    // ── 状态机 ──────────────────────────────────────────────────────────

    private fun onScreenChanged(screenOn: Boolean) {
        if (_status.value.screenOn == screenOn) return
        if (!screenOn) {
            // 息屏瞬间视为「刚刚活跃过」：给足 IDLE_RELAX_MS，避免刚锁屏就让位
            lastActiveAt = System.currentTimeMillis()
            lastTicks = -1L
        }
        update { it.copy(screenOn = screenOn, idleRelaxed = false) }
        Log.i(TAG, "screen interactive=$screenOn")
        reconcile()
        ensureSampler()
    }

    private fun reconcile() {
        val s = _status.value
        val want = s.enabled && s.engineRunning && !s.screenOn && !s.idleRelaxed
        if (want) acquire() else release(
            when {
                !s.enabled -> "disabled"
                s.screenOn -> "screen-on"
                !s.engineRunning -> "engine-down"
                else -> "idle"
            },
        )
    }

    /**
     * 持锁 / 放锁都在同一把监视器里做。
     *
     * 三条线程会同时走到这里：广播接收者（主线程）、状态协程、采样协程。
     * `WakeLock.release()` 在「没持有」时会抛 `WakeLock under-locked`，
     * 而 `setReferenceCounted(false)` 又让并发 release 直接落到系统调用上 ——
     * 不加锁的话，一次亮屏 + 一次引擎退出足以在同毫秒撞出这个异常。
     */
    private fun acquire() {
        val ctx = appContext ?: return
        synchronized(lock) {
            val wl = wakeLock ?: runCatching {
                ctx.getSystemService(PowerManager::class.java)
                    ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, LOCK_TAG)
                    ?.apply { setReferenceCounted(false) }
            }.getOrNull().also { wakeLock = it }

            if (wl == null) {
                Log.w(TAG, "wake lock unavailable")
                return
            }
            if (!wl.isHeld) {
                runCatching { wl.acquire() }
                    .onFailure { Log.w(TAG, "acquire failed: ${it.message}") }
                acquiredAt = System.currentTimeMillis()
                Log.i(TAG, "wake lock held")
            }
        }
        if (!_status.value.held) update { it.copy(held = true, heldSec = 0) }
    }

    private fun release(reason: String) {
        synchronized(lock) {
            val wl = wakeLock
            if (wl?.isHeld == true) {
                runCatching { wl.release() }
                    .onFailure { Log.w(TAG, "release failed: ${it.message}") }
                Log.i(TAG, "wake lock released ($reason)")
            }
            acquiredAt = 0L
        }
        if (_status.value.held) update { it.copy(held = false, heldSec = 0) }
    }

    /**
     * 采样协程：只在「息屏 + 引擎在跑 + 开关打开」期间存在。
     *
     * 注意它**不会**因为让位而退出 —— 见类注释第 2 条。
     */
    private fun ensureSampler() {
        val s = _status.value
        val shouldRun = s.enabled && s.engineRunning && !s.screenOn
        if (!shouldRun) {
            sampler?.cancel()
            sampler = null
            return
        }
        if (sampler?.isActive == true) return
        val sc = scope ?: return
        if (lastActiveAt == 0L) lastActiveAt = System.currentTimeMillis()
        sampler = sc.launch {
            Log.i(TAG, "sampler started")
            while (isActive) {
                delay(SAMPLE_INTERVAL_MS)
                val now = System.currentTimeMillis()
                val ticks = readEngineTicks(enginePid)
                val delta = if (lastTicks < 0L || ticks <= 0L) 0L else (ticks - lastTicks).coerceAtLeast(0L)
                lastTicks = ticks

                if (delta >= ACTIVE_TICKS) {
                    lastActiveAt = now
                    if (_status.value.idleRelaxed) {
                        Log.i(TAG, "activity resumed (delta=$delta ticks), re-arming")
                        update { it.copy(idleRelaxed = false) }
                    }
                } else if (!_status.value.idleRelaxed && now - lastActiveAt >= IDLE_RELAX_MS) {
                    Log.i(TAG, "idle ${IDLE_RELAX_MS / 1000}s, relaxing to save battery")
                    update { it.copy(idleRelaxed = true) }
                }

                // 秒级字段随采样刷新（前端用它显示「已保持 X 分钟」）
                update {
                    it.copy(
                        idleSec = ((now - lastActiveAt) / 1000).toInt(),
                        heldSec = if (acquiredAt > 0) ((now - acquiredAt) / 1000).toInt() else 0,
                    )
                }
                reconcile()
            }
        }
    }

    // ── /proc 采样 ──────────────────────────────────────────────────────

    /**
     * 引擎进程树累计的 CPU 时间（jiffies）。
     *
     * 为什么要连子进程一起算：`bash`/`node`/`python` 这类工具执行是引擎
     * spawn 出去的**子进程**，长时间编译/安装时引擎自己的 CPU 可能接近 0。
     * 只看引擎 pid 会让一次 20 分钟的构建被误判成「闲置」而放开锁 ——
     * 那正是最不能被打断的场景。
     */
    private fun readEngineTicks(pid: Int): Long {
        if (pid <= 0) return 0L
        var total = selfTicks(pid)
        if (total <= 0L) return 0L
        for (child in childPids(pid)) {
            total += selfTicks(child)
        }
        return total
    }

    /** utime + stime + cutime + cstime。 */
    private fun selfTicks(pid: Int): Long {
        val stat = runCatching { File("/proc/$pid/stat").readText() }.getOrNull() ?: return 0L
        // comm 字段可能含空格和括号，一律从**最后一个** ')' 之后开始切
        val close = stat.lastIndexOf(')')
        if (close < 0) return 0L
        val fields = stat.substring(close + 1).trim().split(Regex("\\s+"))
        fun at(i: Int): Long = fields.getOrNull(i)?.toLongOrNull() ?: 0L
        return at(11) + at(12) + at(13) + at(14)
    }

    /**
     * 直接子进程。优先读 `/proc/<pid>/task/<pid>/children`（O(子进程数)），
     * 读不到再退化成扫 /proc 比 ppid。
     */
    private fun childPids(pid: Int): List<Int> {
        val fast = File("/proc/$pid/task/$pid/children")
        if (fast.canRead()) {
            val parsed = runCatching {
                fast.readText().trim().split(' ').mapNotNull { it.toIntOrNull() }
            }.getOrNull()
            if (parsed != null) return parsed
        }
        val out = ArrayList<Int>(4)
        val dirs = runCatching { File("/proc").listFiles() }.getOrNull() ?: return out
        for (dir in dirs) {
            val child = dir.name.toIntOrNull() ?: continue
            val stat = runCatching { File(dir, "stat").readText() }.getOrNull() ?: continue
            val close = stat.lastIndexOf(')')
            if (close < 0) continue
            val ppid = stat.substring(close + 2).trim().split(Regex("\\s+")).firstOrNull()?.toIntOrNull()
            if (ppid == pid) out.add(child)
        }
        return out
    }

    // ── 杂项 ────────────────────────────────────────────────────────────

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 统一的状态写入点：顺带刷新 `batteryWhitelisted`（用户可能刚从系统页回来）。 */
    private fun update(block: (Status) -> Status) {
        val ctx = appContext ?: return
        val base = _status.value
        val next = block(base).copy(batteryWhitelisted = isBatteryWhitelisted(ctx))
        if (next != base) _status.value = next
    }

    /** 供 `publishState` 直接拼进 JSON（不引 gson，快照里就这一处需要）。 */
    fun snapshotJson(): String = _status.value.toJson()
}
