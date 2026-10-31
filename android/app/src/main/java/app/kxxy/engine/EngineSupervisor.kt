package app.kxxy.engine

import android.content.Context
import android.util.Log
import app.kxxy.R
import app.kxxy.service.Notifier
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

    /**
     * 构建元数据快照（缺陷 DP）。
     *
     * 取一次缓存住：`publishState()` 每 5 秒被心跳调一次，而快照里的
     * versionName / 指纹在整个进程生命周期内不可能变。`lazy` 而非 `val` 直接
     * 算，是因为它要读 assets —— 构造函数里做 IO 会让 Activity 启动多一次阻塞。
     */
    private val buildSnapshot: BuildMeta.Snapshot by lazy { BuildMeta.snapshot(ctx) }

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

    /**
     * 上一轮失败的判定文本 + 同一条错误连续出现的次数。
     *
     * 用途只有一个：**同一条确定性错误不再退避 14 次**。配置类故障（补丁 YAML
     * 写坏、bundle 装坏）在输入不变时是 100% 复现的，重试第 2 次和第 14 次
     * 结果一模一样，用户却要为此等 2+4+8+16+32×10 ≈ 5 分钟。判定文本相同即
     * 认为「重试无意义」，提前进入 Failed 态并带着原因让用户走修复流程。
     *
     * 反过来，不同错误（或同一条错误在健康之后又出现）仍走完整退避 ——
     * 网络抖动、端口残留这类瞬时故障靠重试自愈，不能被这条规则误杀。
     */
    @Volatile
    private var lastFailureText: String? = null

    @Volatile
    private var repeatFailure = 0

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

                // 体检页「一键修复」/「撤销修复」请求。
                //
                // 排在 restart/stdin 之后：修复本身会重启引擎，而用户此刻
                // 更可能在点重启按钮，先满足更轻的意图。
                val recoveryReq = EngineConfig.recoveryRequestFile(ctx)
                if (recoveryReq.isFile) {
                    val raw = runCatching { recoveryReq.readText() }.getOrNull()
                    runCatching { recoveryReq.delete() }
                    if (!raw.isNullOrBlank()) {
                        Log.i(TAG, "recovery.request consumed: ${raw.take(120)}")
                        runRecovery(raw)
                        // 修复必然伴随重启（配置改完不重启不生效），
                        // 所以这里 continue，别再走本轮的后续判断。
                        continue
                    }
                }

                // 「需要你确认」的请求（方案 B3）。排最后，因为它最轻：
                // 只是发一条通知，不影响引擎生命周期。
                consumeAttentionRequests()
                sweepStaleAttention()
            }
        }
    }

    /**
     * 消费引擎写来的 attention 请求（方案 B3）。
     *
     * 协议与另外三种请求同构 —— 引擎往 `engine/attention/request.json` 写一个
     * JSON，原生这边读走、删掉、发通知；用户点按钮时由
     * [app.kxxy.service.AttentionReceiver] 往同目录写 `response-*.json`，引擎
     * 自己轮询取走。全程没有任何长连接或 AIDL：引擎可能重启、可能崩，
     * 文件交换是唯一不会因为「另一头不在」而失败的方式。
     *
     * 为什么一次只取一个：请求文件是**单槽**的，引擎连发两条会互相覆盖。
     * 这是有意的取舍 —— 通知栏本来就该合并同类项，真需要排队的情况
     * （批量权限请求）由引擎自己合并成一条「N 个请求」再发。
     */
    /** 上次清理 `attention/` 目录的时刻，用来给逐轮轮询做节流。 */
    private var attentionSweepAt = 0L

    /**
     * 清理 `attention/` 下的过期文件。
     *
     * 这个目录里堆的东西只有两种来源：`active-*.json`（原生发通知时写的待办
     * 副本）与引擎没取走的回执。前者正常情况会被「用户回答」删掉，但用户锁屏
     * 走开、通知被系统清掉、或者应用被杀，都会留下永远没人删的记录 ——
     * 攒多了以后控制台每次轮询都要把它们全读一遍，而且会看到一堆早已作废的
     * 「待确认」卡片。
     *
     * 24 小时是刻意的宽松值：跨夜还在的请求，用户第二天点进去也还是有意义的；
     * 再久就纯属垃圾。节流两分钟一次，扫的只是几个小文件，开销可以忽略。
     */
    private fun sweepStaleAttention() {
        val now = System.currentTimeMillis()
        if (now - attentionSweepAt < 2 * 60 * 1000L) return
        attentionSweepAt = now
        runCatching {
            val dir = File(EngineConfig.engineRoot(ctx), "attention")
            if (!dir.isDirectory) return@runCatching
            val cutoff = now - 24 * 60 * 60 * 1000L
            dir.listFiles()?.forEach { f ->
                if (f.isFile && f.lastModified() < cutoff) {
                    Log.i(TAG, "attention sweep: drop stale ${f.name}")
                    f.delete()
                }
            }
        }.onFailure { Log.w(TAG, "attention sweep failed: ${it.message}") }
    }

    private fun consumeAttentionRequests() {
        val file = File(EngineConfig.engineRoot(ctx), "attention/request.json")
        if (!file.isFile) return

        val raw = runCatching { file.readText() }.getOrNull()
        runCatching { file.delete() }
        if (raw.isNullOrBlank()) return

        val parsed = runCatching { org.json.JSONObject(raw) }.getOrNull()
        if (parsed == null) {
            Log.w(TAG, "attention.request malformed, dropped")
            return
        }

        val id = parsed.optString("id")
        if (id.isBlank()) {
            Log.w(TAG, "attention.request without id, dropped")
            return
        }

        val actionsRaw = parsed.optJSONArray("actions")
        val actions = buildList {
            if (actionsRaw != null) {
                for (i in 0 until actionsRaw.length()) {
                    val a = actionsRaw.optJSONObject(i) ?: continue
                    val key = a.optString("key")
                    if (key.isBlank()) continue
                    add(
                        Notifier.Action(
                            key = key,
                            label = a.optString("label").ifBlank { key },
                        )
                    )
                }
            }
        }

        // 没给按钮时补一对默认的「允许 / 拒绝」：权限类请求最怕的就是
        // 通知上只有一条正文，用户点了才发现要回应用里再点一次。
        val finalActions = actions.ifEmpty {
            if (parsed.optString("kind") == "permission") {
                listOf(
                    Notifier.Action("allow", ctx.getString(R.string.notif_action_allow)),
                    Notifier.Action("deny", ctx.getString(R.string.notif_action_deny)),
                )
            } else {
                emptyList()
            }
        }

        val attention = Notifier.Attention(
            id = id,
            sessionId = parsed.optString("sessionId").ifBlank { null },
            kind = parsed.optString("kind").ifBlank { "question" },
            title = parsed.optString("title").ifBlank { ctx.getString(R.string.notif_title) },
            body = parsed.optString("body"),
            actions = finalActions,
            createdAt = parsed.optLong("createdAt", System.currentTimeMillis()),
        )

        Log.i(TAG, "attention.request consumed: id=$id kind=${attention.kind}")
        Notifier.notifyAttention(ctx, attention)

        // 留一份「待办」副本（方案 B3 的配套）。
        //
        // 为什么需要它：`request.json` 是单槽的，原生读走后必须立刻删除，
        // 否则下一轮轮询会把同一条请求再发一次通知。但这样一来，用户从通知
        // 正文点进应用后，控制台就再也找不到「刚才那条请求是什么」了 ——
        // 只剩通知栏里那条通知。
        //
        // 所以这里另存一份按 id 命名的 active 记录：控制台读它渲染待确认卡片，
        // 用户回答后由 AttentionReceiver 删掉。写入者与删除者都只有原生侧，
        // 不存在两边各写一份导致的不一致。
        runCatching {
            val dir = File(EngineConfig.engineRoot(ctx), "attention").apply { mkdirs() }
            val safe = id.replace(Regex("[^A-Za-z0-9._-]"), "_").take(64)
            val target = File(dir, "active-$safe.json")
            val tmp = File(dir, "${target.name}.tmp")
            tmp.writeText(
                buildString {
                    append("{\n")
                    append("  \"id\": ").append(jsonString(id)).append(",\n")
                    attention.sessionId?.let { append("  \"sessionId\": ").append(jsonString(it)).append(",\n") }
                    append("  \"kind\": ").append(jsonString(attention.kind)).append(",\n")
                    append("  \"title\": ").append(jsonString(attention.title)).append(",\n")
                    append("  \"body\": ").append(jsonString(attention.body)).append(",\n")
                    append("  \"createdAt\": ").append(attention.createdAt).append(",\n")
                    append("  \"source\": \"notification\"\n")
                    append("}\n")
                }
            )
            if (!tmp.renameTo(target)) {
                target.writeText(tmp.readText())
                tmp.delete()
            }
        }.onFailure { Log.w(TAG, "attention active record failed: ${it.message}") }
    }

    /** 最小 JSON 字符串转义（只处理我们自己会写出的字符）。 */
    private fun jsonString(value: String): String {
        val sb = StringBuilder(value.length + 2)
        sb.append('"')
        for (ch in value) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        sb.append('"')
        return sb.toString()
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

    /**
     * 执行体检页下发的修复请求（消费 recovery.request）。
     *
     * 载荷形如 `{"level":"L1","headline":"...","requestedAt":123}`，
     * `level` 取 L1/L2/L3/UNDO。
     *
     * 三个必须做对的地方：
     *
     * 1. **先落结果再重启**。修复完立刻写 recovery-result.json，然后才
     *    restart() —— 重启会把本进程杀掉，写在后面的东西永远写不出来。
     *    引擎重启后由新进程的插件读这个文件展示「上次修了什么」。
     *
     * 2. **失败也必须写结果**。修复失败时不会有备份目录，manifest.json
     *    也就无从谈起；页面只剩 result 这一个信息源。静默失败是最坏的结果
     *    —— 用户看到按钮转了一圈、引擎重启了、问题还在，却不知道为什么。
     *
     * 3. **撤销失败不重启**。撤销本身不改配置，失败了重启只会让用户
     *    多等一次；而成功则必须重启（配置被搬回去了）。
     */
    private suspend fun runRecovery(raw: String) {
        val level = runCatching {
            org.json.JSONObject(raw).optString("level", "L1").uppercase()
        }.getOrElse { "L1" }
        val headline = runCatching {
            org.json.JSONObject(raw).optString("headline", "")
        }.getOrDefault("")

        val manager = RecoveryManager(ctx)
        val resultFile = EngineConfig.recoveryResultFile(ctx)

        if (level == "UNDO") {
            val ok = runCatching { manager.undoLatest() }
                .onFailure { Log.w(TAG, "undo failed: ${it.message}") }
                .getOrDefault(false)
            writeRecoveryResult(resultFile, level, ok, emptyList(),
                if (ok) "" else "没有可撤销的修复记录，或撤销过程中出错")
            if (!ok) return
            Log.i(TAG, "undo done -> restarting engine")
            restart()
            return
        }

        val outcome = runCatching { manager.recover(level = parseLevel(level), headline = headline) }
            .onFailure { Log.w(TAG, "recover($level) failed: ${it.message}") }

        val failure = outcome.exceptionOrNull()
        if (failure != null) {
            writeRecoveryResult(resultFile, level, false, emptyList(), failure.message ?: "未知错误")
            Log.w(TAG, "recovery failed, engine left as-is: ${failure.message}")
            return
        }

        val result = outcome.getOrThrow()
        writeRecoveryResult(resultFile, level, true, result.changes, "")
        Log.i(TAG, "recover($level) done, ${result.changes.size} change(s) -> restarting engine")
        restart()
    }

    private fun parseLevel(level: String): RecoveryManager.Level = when (level.uppercase()) {
        "L2" -> RecoveryManager.Level.L2
        "L3" -> RecoveryManager.Level.L3
        else -> RecoveryManager.Level.L1
    }

    /**
     * 写修复结果快照。
     *
     * 手写 JSON 而不是引 JSONObject 序列化：这里的字段全是 ASCII 安全的值
     * （level/ok/error 是我们自己产出的），只有 changes 是中文文案，而
     * JSONObject 会把中文转成 \uXXXX —— 页面上虽然能还原，但引擎日志里
     * 会变成一串转义，排障时读不了。手动拼 + 转义引号/反斜杠即可。
     */
    private fun writeRecoveryResult(
        file: File,
        level: String,
        ok: Boolean,
        changes: List<String>,
        error: String,
    ) {
        runCatching {
            val json = buildString {
                append("{\n")
                append("  \"level\": \"$level\",\n")
                append("  \"ok\": $ok,\n")
                append("  \"at\": ${System.currentTimeMillis()},\n")
                append("  \"error\": \"${escapeJson(error)}\",\n")
                append("  \"changes\": [")
                changes.forEachIndexed { i, c ->
                    if (i > 0) append(", ")
                    append("\"${escapeJson(c)}\"")
                }
                append("]\n")
                append("}\n")
            }
            file.parentFile?.mkdirs()
            file.writeText(json)
        }.onFailure { Log.w(TAG, "writeRecoveryResult failed: ${it.message}") }
    }

    private fun escapeJson(s: String): String = s
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")
        .replace("\n", "\\n")
        .replace("\r", "")
        .replace("\t", "\\t")

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
                // 闸门脚本必须每轮重装：RuntimeInstaller 重装 runtime 时会整棵覆盖
                // bin/，写在那里的 shz 会消失。放在启动路径上比在安装器里登记
                // 「额外产物」更不容易漏（见 ShizukuShellServer.installGateScript）。
                ShizukuShellServer.installGateScript(ctx)
                // termux-api 的脚本 shim 同理必须每轮重装：闭包里的
                // libexec/termux-api 是 ELF（execv 到不存在的 termux am），
                // 重装 runtime 会让它复活。见 TermuxApiServer.installShim。
                TermuxApiServer.installShim(ctx)

                _state.value = State.Starting
                proc = spawnEngine()
                process = proc

                val healthy = pollHealth(EngineConfig.DEFAULT_PORT, proc)
                if (!healthy) {
                    if (proc.exitStatus.isCompleted) {
                        // 引擎在健康检查期间就自己退出了 —— 这不是「我们主动放弃」，
                        // 而是确定性失败。原实现把它并进超时分支，于是每次都要白等
                        // 满 45 秒、真正的崩溃原因（如 profile 补丁解析失败）被丢掉，
                        // 14 轮下来要 11 分钟才进 Failed 态（缺陷 BT：方案 K 的归因
                        // 拿不到第一手证据，用户只看到「32 秒后重试」）。
                        val status = proc.exitStatus.getCompleted()
                        deterministicFailure =
                            "engine exited: ${app.kxxy.pty.PtyBridge.describe(status)}${errorHint(proc)}"
                        proc.stop(graceMs = 1_000L)
                        process = null
                        Log.w(TAG, deterministicFailure)
                    } else {
                        // 健康检查超时：进程还活着只是没监听端口，这是我们主动放弃
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
                } else {
                    // 健康：清零退避（连同「同一条错误重复了几次」的账）
                    backoffIndex = 0
                    lastFailureText = null
                    repeatFailure = 0
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
                }

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

                // 同一条确定性错误连续出现：输入没变，重试注定复现。
                // 第 2 次就放弃（而不是 14 次），把真正的原因尽快交给用户 ——
                // 见 lastFailureText 的注释。阈值 2 是因为「第一次失败」也可能是
                // 安装器刚写完文件、还没落盘的瞬时状态，值得再试一次。
                if (deterministicFailure == lastFailureText) {
                    repeatFailure++
                } else {
                    lastFailureText = deterministicFailure
                    repeatFailure = 1
                }

                if (repeatFailure >= DETERMINISTIC_GIVE_UP || backoffIndex > EngineConfig.MAX_RESTART) {
                    _state.value = State.Failed(
                        if (repeatFailure >= DETERMINISTIC_GIVE_UP) {
                            "同一条启动错误连续出现 $repeatFailure 次，重试已无意义：$deterministicFailure"
                        } else {
                            "引擎连续 ${EngineConfig.MAX_RESTART} 次启动失败：$deterministicFailure"
                        }
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

    /**
     * 从引擎日志尾部抓一行「像原因」的输出，拼进失败描述。
     *
     * 官方 CLI 崩溃时把真实原因写在 stderr（经 PTY 进 engine.log），而进程退出
     * 状态只有一句 `exit code 1`。少了这行，用户在 Failed 态看到的永远是
     * 「引擎连续 14 次启动失败：engine exited: exit code 1」—— 等于没说。
     *
     * 抓取范围刻意限定在 [logBaseline] 之后（本轮启动的日志），否则会捞到上一次
     * 正常运行时的旧内容；`Error:` / `throw` / `Exception` / `Cannot find` 这些
     * 前缀覆盖了官方启动链上绝大多数致命错误的开头。
     */
    private fun errorHint(proc: EngineProcess): String {
        val tail = runCatching { proc.tailLog(16 * 1024) }.getOrDefault("")
        if (tail.isEmpty()) return ""
        val line = tail.lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .firstOrNull { l ->
                (l.startsWith("Error:") || l.startsWith("TypeError:") ||
                    l.startsWith("YAMLException") || l.startsWith("Cannot find") ||
                    l.contains("failed to parse") || l.contains("failed to read") ||
                    l.contains("must be a mapping") || l.contains("MODULE_NOT_FOUND"))
            }
            ?: return ""
        return " · ${line.take(220)}"
    }

    private fun ensureDirs() {
        EngineConfig.dshHome(ctx).mkdirs()
        EngineConfig.tmpDir(ctx).mkdirs()
        EngineConfig.workspaces(ctx).mkdirs()
        // Gradle 的 GRADLE_USER_HOME 默认取 `$user.home/.gradle`，而 JVM 的
        // user.home 是编译期写死的 Termux 路径（见 EngineConfig.buildEnv 的注释）。
        // 我们已用 -Duser.home + GRADLE_USER_HOME 双保险指回来，这里再把目录
        // 预建出来：native-platform 会在其下建临时探针文件，父目录缺失时报的
        // 是 `Failed to load native library 'libnative-platform.so'`，
        // 与「库真的缺了」同症状，极易误判（缺陷 AW）。
        File(EngineConfig.dshHome(ctx), ".gradle").mkdirs()
        // 官方终端以 `bash --rcfile <临时文件> -i` 启动，该 rcfile 首行会
        // source ~/.bashrc —— 这是唯一能给出「显示当前目录」提示符的挂点。
        EngineConfig.ensureUserShellInit(ctx)
        // 内置的移动端插件只有写进 profile manifest，官方「插件」页才会把它
        // 列进「已安装」并给出启停开关（overlay 里 insert 的 Loader entry
        // 能跑但不显示，见 EngineConfig.ensureProfileManifest 的说明）。
        EngineConfig.ensureProfileManifest(ctx)
        // 异常兜底脚本：必须在 buildEnv 之前落盘，否则 NODE_OPTIONS 不会注入
        // （buildEnv 检查文件存在才拼 --require，见 EngineConfig 里的四条纪律）。
        EngineConfig.ensureGuard(ctx)
        // 网页端启动失败记录按「一次引擎启动」为一轮：上一轮抓到的失败属于
        // 上一次的插件配置，留着会让体检在用户已经停用插件、重启过之后仍然报红。
        // 新页面一旦再次失败会立刻重新写入（MainActivity 的 console 回调）。
        WebBootLog.reset(ctx)
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
                /*
                 * 构建元数据（缺陷 DP）。
                 *
                 * 四个值缺一不可，且**必须由原生侧给出**：引擎跑在自己的进程里，
                 * 它连「APK 是哪个 versionCode」都看不到，而用户排障时第一句
                 * 永远是「你装的是哪一版」。
                 *
                 * 契约：kxxy-host 的 `/kxxy/api/state` 用 `Object.assign` 把这份
                 * JSON 摊平后返回，所以 `build.*` 会原样出现在响应里 —— 前端
                 * 不需要为它改任何路由。
                 */
                append("  \"build\": ${buildSnapshot.toJson()},\n")
                /*
                 * 通知可用性（方案 B5）。
                 *
                 * 控制台体检页需要这三个值才能解释一种最难自查的故障：
                 * 引擎明明在跑、请求也确实发出来了，但用户手机上一次都没响过 ——
                 * 因为通知权限被系统或 ROM 关掉了。没有这三个值，体检页只能说
                 * 「一切正常」，把问题甩回给用户。
                 *
                 * 与上面 `build` 同理：kxxy-host 用 Object.assign 摊平，
                 * 前端拿到的是 `notifications.enabled` 之类。
                 */
                append("  \"notifications\": ${notificationSnapshot()},\n")
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
     * 通知可用性快照（方案 B5，控制台体检页的数据源）。
     *
     * 三个值分别回答三个不同的问题：
     *
     *   · `enabled` —— 应用级通知总开关。关掉后**所有**通知都发不出去，
     *     包括常驻状态条。
     *   · `attentionImportance` —— 「需要你确认」这条渠道的当前重要性。
     *     Android 允许用户单独把某条渠道静音，此时 `enabled` 仍是 true，
     *     但最重要的那类通知已经不响了。
     *   · `attentionBlocked` —— 上面那条的布尔化，前端不必知道重要性常量表。
     *
     * 全部即时查询，不做缓存：用户可能在设置里改完就切回来，缓存会给出
     * 与事实相反的结论。
     */
    private fun notificationSnapshot(): String = runCatching {
        val st = Notifier.status(ctx)
        buildString {
            append("{")
            append("\"enabled\": ").append(st.enabled).append(", ")
            append("\"attentionImportance\": ").append(st.attentionImportance).append(", ")
            append("\"attentionBlocked\": ").append(st.attentionBlocked)
            append("}")
        }
    }.getOrDefault(
        "{\"enabled\": true, \"attentionImportance\": -1, \"attentionBlocked\": false}"
    )

    /**
     * Android 能力开关快照（设置页「系统权限」卡片的数据源）。
     * 全部是即时查询，绕开「权限在设置里被收回但 UI 还显示已授」的陈旧态。
     */
    private fun permissionSnapshot(): String {
        val notifications = runCatching {
            val nm = ctx.getSystemService(android.app.NotificationManager::class.java)
            nm?.areNotificationsEnabled() ?: false
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
        val cameraHardware = PermCatalog.hasCamera(ctx)
        val microphoneHardware = PermCatalog.hasMicrophone(ctx)
        val camera = cameraHardware && PermCatalog.isGranted(ctx, android.Manifest.permission.CAMERA)
        val microphone = microphoneHardware && PermCatalog.isGranted(ctx, android.Manifest.permission.RECORD_AUDIO)
        return buildString {
            append("{\n")
            append("    \"notifications\": $notifications,\n")
            append("    \"allFiles\": ${PermCatalog.status(ctx, PermCatalog.find("all_files")!!) ?: false},\n")
            append("    \"battery\": ${PermCatalog.status(ctx, PermCatalog.find("battery")!!) ?: false},\n")
            append("    \"camera\": $camera,\n")
            append("    \"microphone\": $microphone,\n")
            append("    \"cameraHardware\": $cameraHardware,\n")
            append("    \"microphoneHardware\": $microphoneHardware,\n")
            append("    \"legacyStorage\": ${legacyStorage ?: "null"},\n")
            /*
             * 通用条目状态（权限目录驱动）。
             *
             * 与上面那几个扁平字段的关系：扁平字段是旧版前端的契约，不能删
             * （老网页配新 APK 时会读不到）；`entries` 是新卡片的唯一数据源 ——
             * 键就是 PermCatalog 的 id，值三态：true / false / null（无法判定，
             * 例如厂商安全中心里才有的开关）。
             *
             * 写成 Map 而不是数组：前端要按 id 查，数组还得自己建索引；
             * 而且多一个未知 id 也不会让老前端整体解析失败。
             */
            append("    \"entries\": {")
            PermCatalog.entries.forEachIndexed { index, entry ->
                if (index > 0) append(", ")
                append("\"").append(entry.id).append("\": ")
                append(PermCatalog.status(ctx, entry)?.toString() ?: "null")
            }
            append("}\n")
            append("  }")
        }
    }

    /**
     * root/shizuku 可用性（segmented 控件灰化依据，均只 stat 不弹框）。
     *
     * shizuku 的判定用 [ShizukuBridge.status]：装了管理器即可选（用户点「应用」时
     * 若还没授权，会引导去授权），但**是否真正可用**由 `shizukuUsable` 单独给出，
     * 前端据此显示不同的徽章。此前这里只看「管理器是否安装」，
     * 导致「装了但服务没起 / 没授权」也被显示成可用 —— 那是旧版把 shizuku 模式
     * 做成纯环境变量的遗留判定，现在通道是真实的，判定必须跟着变严。
     */
    private fun privAvailability(): String {
        val root = Privilege.rootAvailableMinimal()
        val shz = ShizukuBridge.status.value
        return buildString {
            append("{")
            append("\"root\": $root,")
            // 可选项：装了管理器就让用户能选（否则连授权入口都点不到）
            append("\"shizuku\": ${shz.installed},")
            append("\"shizukuUsable\": ${shz.usable},")
            append("\"shizukuInstalled\": ${shz.installed},")
            append("\"shizukuGranted\": ${shz.granted},")
            append("\"shizukuVersion\": ${shz.version},")
            append("\"shizukuUid\": ${shz.serverUid},")
            append("\"shizukuError\": \"${(shz.lastError ?: "").replace("\"", "'").replace("\\", "/")}\"")
            append("}")
        }
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
        // 管理页的权限等级开关是死的）。三种模式的语义各不相同，不可互相冒充：
        //   normal  —— 引擎以应用身份运行，不申请任何提权。
        //   root    —— 引擎**整体**以 uid 0 启动（进程级提权），见下。
        //   shizuku —— 引擎仍以应用身份运行，但获得一条**按需**以 adb/shell 身份
        //              （uid 2000）执行单条命令的通道 `bin/shz`。通道的服务端在应用
        //              进程里（只有它持有 Shizuku binder），见 ShizukuShellServer。
        //              shizuku **不会**改变引擎进程的 uid —— 这是 Shizuku 的固有边界，
        //              不是实现取巧：引擎是 execve 起的独立进程，uid 由内核在 fork 时决定。
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
        } else if (requestedMode == "shizuku") {
            // 不回落。回落会让用户以为「已生效」，而真实原因（服务没起 / 没授权）
            // 被掩盖成「设置没保存」。通道不可用时 shz 会打印确切原因，
            // 控制台权限卡片也会显示对应徽章。
            val s = ShizukuBridge.status.value
            if (!s.usable) {
                Log.w(
                    TAG,
                    "privMode=shizuku but channel not ready " +
                        "(installed=${s.installed} binder=${s.binderReady} granted=${s.granted}); " +
                        "engine starts anyway, bin/shz will report the reason",
                )
            } else {
                Log.i(TAG, "privMode=shizuku, adb channel ready (server uid=${s.serverUid})")
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
         * 同一条确定性错误连续出现多少次就放弃重试。
         *
         * 取 2 而非 1：第一次失败可能是安装器刚落盘、文件系统还没同步的瞬时
         * 状态，值得再试一次；但第二次结果一模一样就说明输入没变，再退避
         * 14 次也只是让用户干等 5 分钟。
         */
        private const val DETERMINISTIC_GIVE_UP = 2

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
