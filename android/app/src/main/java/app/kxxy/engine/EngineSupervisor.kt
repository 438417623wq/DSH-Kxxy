package app.kxxy.engine

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 引擎监管器：状态机、崩溃退避、健康检查、token 提取。
 *
 * 这是方案 T 原生层最核心的模块。设计原则来自参考项目在生产环境踩出的坑：
 *
 * 1. **只有「真实死亡」才计入崩溃计数**
 *    健康检查超时后我们主动 stop 引擎，那是我们的决定而非引擎的故障。
 *    参考项目 m1.6.4 真机误伤教训：把超时计入计数会让正常慢启动的设备
 *    迅速耗尽重启配额进入 Failed 终态。
 *
 * 2. **崩溃签名必须归一化数字**
 *    崩溃堆栈里的行号/内存地址/时间戳每次都变。原文哈希会让 streak 永远重置，
 *    永远到不了阈值 → 自愈机制失效。所以过滤后把每行数字替换为 '#'。
 *
 * 3. **健康检查判定 200..499 即就绪**
 *    官方 WebUI 起来后可能返回任意 2xx-4xx（例如 401 待鉴权）。
 *    只要 HTTP 栈应答了就说明监听成功。
 */
class EngineSupervisor(private val ctx: Context) {

    /** 引擎生命周期状态。 */
    sealed interface State {
        data object Idle : State
        data class Installing(val progress: Float) : State
        data object Starting : State
        data class Healthy(val port: Int, val tokenUrl: String?) : State
        data class Backoff(val delayMs: Long, val attempt: Int) : State
        data class Failed(val reason: String) : State
        data object Stopped : State
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * 状态发布器：所有 `_state.value = …` 写入都会顺带把快照落盘到
     * `EngineConfig.stateFile(ctx)`，供 kxxy-host 插件跨进程读取。
     *
     * 刻意不做 RPC：引擎是 node 进程、监管器在 app 主进程，引入 socket 会
     * 多一条需要鉴权的通道；文件交换是单向只读的，插件侧没有写入能力。
     */
    private inner class StatePublisher {
        private val flow = MutableStateFlow<State>(State.Idle)
        private val readOnly = flow.asStateFlow()

        val state: StateFlow<State> get() = readOnly

        var value: State
            get() = flow.value
            set(v) {
                flow.value = v
                publishState(v)
            }
    }

    private val _state = StatePublisher()

    val state: StateFlow<State> get() = _state.state

    private val _installProgress = MutableStateFlow(0f)
    val installProgress: StateFlow<Float> = _installProgress.asStateFlow()

    @Volatile
    private var process: EngineProcess? = null

    @Volatile
    private var supervisionJob: Job? = null

    @Volatile
    private var heartbeatJob: Job? = null

    @Volatile
    private var requestJob: Job? = null

    /** 用户显式退出标记：置位后所有自动启动路径都必须跳过。 */
    private val userStopped = AtomicBoolean(false)

    /** 上次成功健康后的 URL，WebView 崩溃恢复时可直接复用。 */
    @Volatile
    var lastGoodUrl: String? = null
        private set

    // ── 对外控制面 ──────────────────────────────────────────────────────

    /** 用户点「退出」。 */
    fun markUserStopped() {
        userStopped.set(true)
    }

    fun isUserStopped(): Boolean = userStopped.get()

    /** 用户点「启动/重启」。清除退出标记并（重新）进入监管循环。 */
    fun start() {
        userStopped.set(false)
        if (supervisionJob?.isActive == true) {
            Log.i(TAG, "supervision already running, ignoring start()")
            return
        }
        supervisionJob = scope.launch {
            try {
                supervisionLoop()
            } finally {
                // 监管循环退出（用户停止、连续失败放弃）后心跳已无意义：
                // 继续跑只会每 5 秒读一次 /proc 再发现 process == null。
                heartbeatJob?.cancel()
                heartbeatJob = null
            }
        }
        startHeartbeat()
        startRequestWatcher()
    }

    /**
     * 引擎请求文件的轮询消费者（五项改进方案 §7-2 方案 A）。
     *
     * 挂在 start() 的生命周期里，与心跳同一条机制：文件交换是引擎插件
     * （kxxy-host，跑在引擎进程内）调用原生层能力的唯一通道 —— 进程没法
     * 重启自己，而宿主管理页的「重启引擎」「终端快捷键」都需要原生层配合。
     *
     * 消费顺序刻意是「先删文件、再执行动作」：动作执行途中被再次轮询
     * 命中会重复触发；先删顶多丢一次请求（下一次点按钮重发即可）。
     */
    private fun startRequestWatcher() {
        if (requestJob?.isActive == true) return
        requestJob = scope.launch {
            while (true) {
                delay(REQUEST_POLL_MS)

                val restartReq = EngineConfig.restartRequestFile(ctx)
                if (restartReq.isFile) {
                    runCatching { restartReq.delete() }
                    Log.i(TAG, "restart.request consumed -> restarting engine")
                    restart()
                    continue
                }

                val stdinReq = EngineConfig.stdinRequestFile(ctx)
                if (stdinReq.isFile) {
                    val bytes = runCatching { stdinReq.readBytes() }.getOrNull()
                    runCatching { stdinReq.delete() }
                    if (bytes != null && bytes.isNotEmpty()) {
                        process?.write(bytes)
                    }
                }
            }
        }
    }

    /**
     * 状态文件心跳。
     *
     * `StatePublisher` 只在**状态变化**时落盘，而 Healthy 是一个长期不变的状态 ——
     * 于是 `uptimeSec` 会停在健康那一刻、`memoryMB` 也永不刷新，管理页显示的运行
     * 时长和内存占用就成了死数。参考项目 v1.2.73 的通知栏事故是同一类问题
     * （StateFlow 只在变化时发事件）。这里用一条独立心跳协程定时重发快照。
     *
     * 只在有活进程时落盘：进程为 null 时状态变化本身已经写过一次，重复写只会
     * 让管理页看到 pid=0 的陈旧快照覆盖掉真实的 Stopped/Failed。
     */
    private fun startHeartbeat() {
        if (heartbeatJob?.isActive == true) return
        heartbeatJob = scope.launch {
            while (true) {
                delay(HEARTBEAT_INTERVAL_MS)
                val proc = process ?: continue
                if (proc.isAlive()) publishState(_state.value)
            }
        }
    }

    /** 用户点「停止」（不置退出标记，仅停当前进程）。 */
    suspend fun stop(graceMs: Long = 3_500L) {
        heartbeatJob?.cancel()
        heartbeatJob = null
        requestJob?.cancel()
        requestJob = null
        supervisionJob?.cancel()
        supervisionJob = null
        withContext(Dispatchers.IO) {
            process?.stop(graceMs)
            process = null
        }
        _state.value = State.Stopped
    }

    /**
     * 重启（用户点重启按钮）。
     *
     * 幂等互斥：重复点击直接忽略。参考项目 v1.2.37 的教训是旧实现每次点击
     * 都起一条线程，并发 stop/start 互相踩踏；且 stop 最长等 10 秒而 Stopped
     * 在其后置位，导致第一次点击毫无反馈。
     */
    fun restart() {
        if (restarting.getAndSet(true)) {
            Log.i(TAG, "restart already in progress, ignoring duplicate tap")
            return
        }
        scope.launch {
            try {
                _state.value = State.Starting
                stop(graceMs = 3_500L)
                userStopped.set(false)
                start()
            } finally {
                restarting.set(false)
            }
        }
    }

    private val restarting = AtomicBoolean(false)

    // ── 监管主循环 ──────────────────────────────────────────────────────

    private suspend fun supervisionLoop() {
        var backoffIndex = 0

        while (true) {
            if (userStopped.get()) {
                Log.i(TAG, "supervision loop exit: user stopped")
                _state.value = State.Stopped
                return
            }

            // 本轮是否因「真实死亡」而失败。健康超时不计入。
            var deterministicFailure: String? = null
            var proc: EngineProcess? = null

            try {
                _state.value = State.Installing(0f)
                RuntimeInstaller(ctx).ensureInstalled { frac ->
                    // 仅整 1% 变化才发布，避免高频 StateFlow 发射
                    val rounded = kotlin.math.floor(frac * 100f) / 100f
                    if (rounded != _installProgress.value) {
                        _installProgress.value = rounded
                        _state.value = State.Installing(rounded)
                    }
                }

                EngineConfig.ensureOverlay(ctx)
                ensureDirs()

                _state.value = State.Starting
                proc = spawnEngine()
                process = proc

                val healthy = pollHealth(EngineConfig.DEFAULT_PORT, proc)
                if (!healthy) {
                    // 健康检查超时：这是我们主动放弃，不是引擎故障
                    Log.w(TAG, "health check timed out after ${EngineConfig.HEALTH_TIMEOUT_MS}ms")
                    proc.stop(graceMs = 2_000L)
                    process = null
                    backoffIndex++
                    if (backoffIndex > EngineConfig.MAX_RESTART) {
                        _state.value = State.Failed("引擎连续 ${EngineConfig.MAX_RESTART} 次启动失败")
                        return
                    }
                    val delayMs = EngineConfig.BACKOFF_STEPS[
                        (backoffIndex - 1).coerceAtMost(EngineConfig.BACKOFF_STEPS.size - 1)
                    ]
                    _state.value = State.Backoff(delayMs, backoffIndex)
                    delay(delayMs)
                    continue
                }

                // 健康：清零退避
                backoffIndex = 0
                val tokenUrl = extractTokenUrlWithRetry(proc)
                lastGoodUrl = tokenUrl
                _state.value = State.Healthy(EngineConfig.DEFAULT_PORT, tokenUrl)

                // 阻塞等待引擎退出
                val status = proc.exitStatus.await()
                process = null

                if (userStopped.get()) {
                    _state.value = State.Stopped
                    return
                }

                // 运行中退出 = 真实死亡
                deterministicFailure = "engine exited: ${app.kxxy.pty.PtyBridge.describe(status)}"
                Log.w(TAG, deterministicFailure)

            } catch (e: EngineStartException) {
                deterministicFailure = e.message ?: "engine start failed"
                Log.e(TAG, "spawn failed", e)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                deterministicFailure = e.message ?: e.javaClass.simpleName
                Log.e(TAG, "supervision iteration failed", e)
            }

            if (deterministicFailure != null) {
                // EADDRINUSE 特判：孤儿进程占着端口。先清场再快速重试，
                // 不计入崩溃计数（这不是引擎配置问题，是环境残留）。
                if (deterministicFailure.contains("EADDRINUSE")) {
                    Log.w(TAG, "EADDRINUSE detected, reaping orphan engine processes")
                    reapOrphans()
                    backoffIndex = 0
                    delay(1_500L)
                    continue
                }

                backoffIndex++
                if (backoffIndex > EngineConfig.MAX_RESTART) {
                    _state.value = State.Failed(
                        "引擎连续 ${EngineConfig.MAX_RESTART} 次启动失败：$deterministicFailure"
                    )
                    return
                }
                val delayMs = EngineConfig.BACKOFF_STEPS[
                    (backoffIndex - 1).coerceAtMost(EngineConfig.BACKOFF_STEPS.size - 1)
                ]
                _state.value = State.Backoff(delayMs, backoffIndex)
                delay(delayMs)
            }
        }
    }

    private fun ensureDirs() {
        EngineConfig.dshHome(ctx).mkdirs()
        EngineConfig.tmpDir(ctx).mkdirs()
        EngineConfig.workspaces(ctx).mkdirs()
    }

    /**
     * 把当前状态写成 JSON 快照，供 kxxy-host 插件读取。
     *
     * 字段名与 `plugins/kxxy-host/lib/index.js` 的 `collectEngineState` 对齐：
     * 插件用 `Object.assign(state, JSON.parse(...))` 覆盖，所以这里给的键
     * （`supervisor` / `pid` / `uptimeSec` / `memoryMB` / `installProgress` /
     * `effectivePrivMode` / `permissions` / `privAvailable`）
     * 会直接出现在 `/kxxy/api/state` 的响应里。
     *
     * 全程 runCatching：状态发布绝不能让监管循环因磁盘问题中断。
     */
    private fun publishState(s: State) {
        runCatching {
            val proc = process
            val uptimeSec = if (proc != null) (System.currentTimeMillis() - startedAtMs) / 1000 else 0
            val memoryMB = if (proc != null) readRssMb(proc.pid) else 0
            val json = buildString {
                append("{\n")
                append("  \"supervisor\": \"${s.javaClass.simpleName}\",\n")
                append("  \"pid\": ${proc?.pid ?: 0},\n")
                append("  \"uptimeSec\": $uptimeSec,\n")
                append("  \"memoryMB\": $memoryMB,\n")
                append("  \"installProgress\": ${_installProgress.value},\n")
                append("  \"port\": ${EngineConfig.DEFAULT_PORT},\n")
                append("  \"effectivePrivMode\": \"$effectivePrivMode\",\n")
                append("  \"permissions\": ${permissionSnapshot()},\n")
                append("  \"privAvailable\": ${privAvailability()},\n")
                append("  \"updatedAt\": ${System.currentTimeMillis()}\n")
                append("}\n")
            }
            val f = EngineConfig.stateFile(ctx)
            f.parentFile?.mkdirs()
            // 先写临时文件再改名：插件可能正好在这一刻读，读到半个 JSON 会
            // 触发它的 stateFileError 分支（不致命，但没必要制造）。
            val tmp = File(f.parentFile, "${f.name}.tmp")
            tmp.writeText(json)
            if (!tmp.renameTo(f)) {
                f.writeText(json)
                tmp.delete()
            }
        }.onFailure { Log.w(TAG, "publishState failed: ${it.message}") }
    }

    /**
     * Android 能力开关快照（设置页「系统权限」卡片的数据源）。
     * 全部是即时查询，绕开「权限在设置里被收回但 UI 还显示已授」的陈旧态。
     */
    private fun permissionSnapshot(): String {
        val notifications = runCatching {
            val nm = ctx.getSystemService(android.app.NotificationManager::class.java)
            nm?.areNotificationsEnabled() ?: false
        }.getOrDefault(false)
        val allFiles = runCatching {
            android.os.Build.VERSION.SDK_INT >= 30 && android.os.Environment.isExternalStorageManager()
        }.getOrDefault(false)
        val battery = runCatching {
            val pm = ctx.getSystemService(android.os.PowerManager::class.java)
            pm?.isIgnoringBatteryOptimizations(ctx.packageName) ?: false
        }.getOrDefault(false)
        // Android 10 及以下走 legacy storage 的运行时权限；11+ 由「所有文件访问」
        // 接管，此字段报告 null 让前端隐藏该行。
        val legacyStorage: Boolean? = if (android.os.Build.VERSION.SDK_INT > 29) {
            null
        } else {
            android.content.pm.PackageManager.PERMISSION_GRANTED ==
                ctx.checkPermission(
                    android.Manifest.permission.WRITE_EXTERNAL_STORAGE,
                    android.os.Process.myPid(),
                    android.os.Process.myUid(),
                )
        }
        return buildString {
            append("{\n")
            append("    \"notifications\": $notifications,\n")
            append("    \"allFiles\": $allFiles,\n")
            append("    \"battery\": $battery,\n")
            append("    \"legacyStorage\": ${legacyStorage ?: "null"}\n")
            append("  }")
        }
    }

    /** root/shizuku 可用性（segmented 控件灰化依据，均只 stat 不弹框）。 */
    private fun privAvailability(): String {
        val root = Privilege.rootAvailableMinimal()
        val shizuku = Privilege.shizukuInstalled(ctx)
        return "{\"root\": $root, \"shizuku\": $shizuku}"
    }

    /** 读 /proc/<pid>/status 的 VmRSS（KB）。读不到返回 0。 */
    private fun readRssMb(pid: Int): Long = runCatching {
        if (pid <= 0) return 0L
        val status = File("/proc/$pid/status")
        if (!status.isFile) return 0L
        status.useLines { lines ->
            lines.firstOrNull { it.startsWith("VmRSS:") }
                ?.filter { it.isDigit() }
                ?.toLongOrNull()
                ?.div(1024)
                ?: 0L
        }
    }.getOrDefault(0L)

    @Volatile
    private var startedAtMs: Long = 0L

    /** 本次 spawn 实际生效的权限等级（root 探测失败会回落 normal，要与请求值区分）。 */
    @Volatile
    private var effectivePrivMode: String = "normal"

    private suspend fun spawnEngine(): EngineProcess {
        val logOffset = EngineConfig.logFile(ctx).let { if (it.isFile) it.length() else 0L }

        // 权限等级：前端写 kxxy-prefs.json + 一键重启 → 这里消费（此前硬编码 normal，
        // 管理页的权限等级开关是死的）。root 需要真提权，见下；shizuku 本期只改
        // 引擎可感知的环境变量，不改变进程 uid（Shizuku 的 binder 能力给不了子进程）。
        val requestedMode = EngineConfig.readPrivMode(ctx)
        var effectiveMode = requestedMode
        var rootPrefix: List<String>? = null

        if (requestedMode == "root") {
            val prefix = Privilege.usableSuPrefix()
            if (prefix == null) {
                Log.w(TAG, "privMode=root requested but no usable su; falling back to normal")
                effectiveMode = "normal"
            } else {
                // 参考项目 m1.26 事故链的两道防护：root 启动会把 dsh-home 写成
                // root 属主（之后非 root 启动全 EACCES），先修属主再备份。
                if (Privilege.dshHomeNeedsOwnershipFix(ctx)) {
                    Log.w(TAG, "dsh-home ownership broken (previous root run?), fixing")
                    Privilege.fixHomeOwnership(ctx)
                }
                Privilege.backupHome(ctx)
                rootPrefix = prefix
            }
        }

        val proc = EngineProcess.spawn(
            nodeBin = EngineConfig.nodeBin(ctx),
            entryJs = EngineConfig.dshEntry(ctx),
            cwd = EngineConfig.workspaces(ctx),
            env = EngineConfig.buildEnv(ctx, EngineConfig.DEFAULT_PORT, effectiveMode),
            logFile = EngineConfig.logFile(ctx),
            patchPath = EngineConfig.overlayFile(ctx).absolutePath,
            rootPrefix = rootPrefix,
        )
        // 记录日志基线，供 token 提取使用
        logBaseline = logOffset
        startedAtMs = System.currentTimeMillis()
        effectivePrivMode = effectiveMode
        return proc
    }

    @Volatile
    private var logBaseline: Long = 0L

    /**
     * 健康检查：HTTP 轮询直到应答或超时。
     *
     * 判定 `code in 200..499` 即就绪 —— 官方 WebUI 起来后可能返回 401
     * （等待 token 鉴权），但 HTTP 栈已应答就说明监听成功。
     */
    private suspend fun pollHealth(port: Int, proc: EngineProcess): Boolean =
        withContext(Dispatchers.IO) {
            val deadline = System.currentTimeMillis() + EngineConfig.HEALTH_TIMEOUT_MS

            while (System.currentTimeMillis() < deadline) {
                // 进程已死就没必要继续等
                if (proc.exitStatus.isCompleted) return@withContext false

                val code = try {
                    val conn = (URL("http://127.0.0.1:$port/").openConnection() as HttpURLConnection).apply {
                        connectTimeout = 2_000
                        readTimeout = 2_000
                        requestMethod = "GET"
                    }
                    try {
                        conn.responseCode
                    } finally {
                        runCatching { conn.disconnect() }
                    }
                } catch (e: Exception) {
                    -1
                }

                if (code in 200..499) return@withContext true
                delay(EngineConfig.HEALTH_INTERVAL_MS)
            }
            false
        }

    /**
     * 从日志提取带 token 的 URL，最多重试 6 次 × 100ms。
     *
     * ⚠️ 只搜 spawn 之后的日志段（logBaseline）。搜全文会拿到上一次启动的
     * 旧 token，导致 WebView 401 白页 —— 参考项目实测过这个事故。
     */
    private suspend fun extractTokenUrlWithRetry(proc: EngineProcess): String? {
        repeat(6) {
            val url = proc.extractTokenUrl(logBaseline)
            if (url != null) return url
            delay(100L)
        }
        Log.w(TAG, "token url not found in engine log")
        return null
    }

    /**
     * 清理孤儿引擎进程。
     *
     * 正常情况下 G2（PR_SET_PDEATHSIG）已经保证子进程随父进程退出，
     * 但历史遗留进程或 root 模式下的 su 外壳仍可能残留。
     */
    private fun reapOrphans() {
        runCatching {
            ProcessBuilder(
                "/system/bin/sh", "-c",
                "pkill -9 -f 'files/engine/bin/node' 2>/dev/null; true"
            ).start().waitFor()
        }.onFailure { Log.w(TAG, "reapOrphans failed: ${it.message}") }
    }

    /** 读取引擎日志尾部，供宿主管理页展示。 */
    fun tailLog(maxBytes: Int = 64 * 1024): String =
        process?.tailLog(maxBytes) ?: runCatching {
            val f: File = EngineConfig.logFile(ctx)
            if (f.isFile) f.readText().takeLast(maxBytes) else ""
        }.getOrDefault("")

    /** 引擎当前 pid；未运行时为 0。 */
    fun pid(): Int = process?.pid ?: 0

    companion object {
        private const val TAG = "KxxySupervisor"

        /**
         * 状态文件心跳间隔。
         *
         * 5 秒是「管理页看起来是活的」与「不白白唤醒 CPU」之间的折中：管理页
         * 自己按 3 秒轮询 `/kxxy/api/state`，心跳快于此没有意义；更慢则运行
         * 时长会以肉眼可见的步长跳变。写一个几百字节的文件本身极廉价。
         */
        private const val HEARTBEAT_INTERVAL_MS = 5_000L

        /**
         * 引擎请求文件的轮询间隔。
         *
         * 方案 §7-2 原定 2 秒；实际取 1 秒 —— 终端快捷键走同一通道，2 秒的
         * Ctrl+C 延迟已到肉眼可感的程度。stat 一次几百字节的文件开销可忽略。
         */
        private const val REQUEST_POLL_MS = 1_000L
    }
}
