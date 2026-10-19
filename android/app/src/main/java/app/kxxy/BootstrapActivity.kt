package app.kxxy

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Typeface
import android.net.ConnectivityManager
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import app.kxxy.engine.EngineConfig
import app.kxxy.engine.EngineSupervisor
import app.kxxy.engine.RecoveryManager
import app.kxxy.engine.RecoveryProbe
import app.kxxy.service.EngineService
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * 引导页 —— 方案 T 下唯一必须原生的 UI。
 *
 * 为什么不能 Web 化：引擎尚未就绪时 127.0.0.1:3080 上没有任何服务，
 * WebView 无处可加载。所以这一屏必须用原生控件，且要尽量薄。
 *
 * 职责：
 *   ① WebView 版本门禁（< Chrome 85 明确提示而非白屏）
 *   ② 解压 runtime.zip（显示确定性进度）
 *   ③ 启动 EngineService
 *   ④ 轮询直到引擎 Healthy，然后跳 MainActivity
 *   ⑤ **崩溃自愈（方案 K）**：失败时给出归因 + 三级修复入口
 *
 * ## 关于 ⑤：为什么这一屏必须变厚一点
 *
 * 引擎起不来时，`supervisor.restart()` 是「用同样的输入再试一次」。如果坏的是
 * 某个配置文件，重试只会在 14 次退避后进入 `Failed` 终态，用户只剩「清除应用
 * 数据」——那会把会话、工作区、装好的插件一起丢掉。
 *
 * 而「管理插件」的页面跑在引擎进程里（`kxxy-host` 插件），引擎死了它当然也死
 * 了 —— 所以恢复入口只能建在这一屏：它是唯一能在那时活着、且能改文件的界面。
 *
 * 界面刻意用代码构造而非 XML 布局 —— 方案 T 的设计原则是把 UI 尽量留给 Web 层，
 * 这里只是在不 Web 可用的场景下补一个最小闭环。
 */
class BootstrapActivity : Activity() {

    private val app get() = application as KxxyApp
    private val supervisor: EngineSupervisor get() = app.supervisor
    private val recovery get() = RecoveryManager(this)
    private val probe get() = RecoveryProbe(this)

    private lateinit var titleView: TextView
    private lateinit var statusView: TextView
    private lateinit var hintView: TextView
    private lateinit var progress: ProgressBar

    /** 失败态的按钮行（重试 / 诊断），以及修复主按钮。 */
    private lateinit var retryButton: Button
    private lateinit var diagnoseButton: Button
    private lateinit var repairButton: Button
    private lateinit var actionRow: LinearLayout

    /** 归因结果的展示区（默认隐藏）。 */
    private lateinit var verdictCard: LinearLayout
    private lateinit var verdictHeadline: TextView
    private lateinit var verdictDetail: TextView

    /** 修复成功后的「修好了什么」卡片与「进入」按钮行（默认隐藏）。 */
    private lateinit var recoveredCard: LinearLayout
    private lateinit var recoveredHeadline: TextView
    private lateinit var recoveredDetail: TextView
    private lateinit var undoButton: Button
    private lateinit var enterRow: LinearLayout

    private var stateJob: Job? = null
    private var workJob: Job? = null

    /** 缓存最近一次归因，供诊断页复用（避免重复跑 dump）。 */
    private var lastDiagnosis: RecoveryProbe.Diagnosis? = null

    /**
     * 本次进程内是否执行过修复。
     *
     * 用来区分「正常启动」与「修复后启动」：后者要停在引导页给撤销入口，
     * 而不是像正常路径那样立刻跳进主界面。见 [showRecovered]。
     */
    private var repairedInThisRun = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())

        // ① WebView 版本门禁
        if (!WebViewGate.isSupported(this)) {
            statusView.text = getString(R.string.boot_webview_too_old)
            retryButton.visibility = Button.VISIBLE
            retryButton.text = getString(android.R.string.ok)
            retryButton.setOnClickListener { finishAffinity() }
            return
        }

        // ② 启动前台服务（它内部会驱动 supervisor）
        EngineService.start(this)

        // ③ 观察状态，Healthy 后跳主界面
        stateJob = app.appScope.launch {
            supervisor.state.collectLatest { render(it) }
        }
    }

    private fun render(state: EngineSupervisor.State) {
        runOnUiThread {
            // 非失败态一律收起归因卡片：上一次失败归因不该继续挂在「正在启动」上
            val failed = state is EngineSupervisor.State.Failed
            verdictCard.visibility = if (failed && lastDiagnosis != null) LinearLayout.VISIBLE else LinearLayout.GONE

            when (state) {
                is EngineSupervisor.State.Idle -> {
                    statusView.text = getString(R.string.boot_checking)
                    progress.visibility = ProgressBar.GONE
                    setFailureActionsVisible(false)
                }
                is EngineSupervisor.State.Installing -> {
                    statusView.text = getString(R.string.boot_installing)
                    progress.visibility = ProgressBar.VISIBLE
                    progress.isIndeterminate = false
                    progress.progress = (state.progress * 100).toInt()
                    setFailureActionsVisible(false)
                }
                is EngineSupervisor.State.Starting -> {
                    statusView.text = getString(R.string.boot_starting)
                    progress.visibility = ProgressBar.VISIBLE
                    progress.isIndeterminate = true
                    setFailureActionsVisible(false)
                }
                is EngineSupervisor.State.Healthy -> {
                    Log.i(TAG, "engine healthy (tokenUrl=${state.tokenUrl != null}, repaired=$repairedInThisRun)")
                    if (repairedInThisRun) {
                        // 刚修复过就别急着跳走：L1 会把用户的 profile 补丁整份移走，
                        // 那里面是主题、provider、欢迎语这些个人配置。用户此刻最需要
                        // 的是「知道刚才动了什么」和「一键还原」的入口 —— 一旦跳进
                        // 主界面，诊断页就只在 Failed 态可达，撤销按钮等于死代码。
                        showRecovered()
                    } else {
                        statusView.text = getString(R.string.boot_waiting)
                        progress.visibility = ProgressBar.VISIBLE
                        progress.isIndeterminate = true
                        enterMain()
                    }
                }
                is EngineSupervisor.State.Backoff -> {
                    statusView.text = getString(
                        R.string.status_backoff, state.delayMs / 1000, state.attempt
                    )
                    progress.visibility = ProgressBar.VISIBLE
                    progress.isIndeterminate = true
                    setFailureActionsVisible(false)
                }
                is EngineSupervisor.State.Failed -> {
                    statusView.text = "${getString(R.string.boot_failed)}：${state.reason}"
                    progress.visibility = ProgressBar.GONE
                    setFailureActionsVisible(true)
                    // 失败即归因：用户看到「修复启动」按钮时，原因应该已经在屏幕上了。
                    // 否则他得先点一次「诊断」才知道该不该点修复，多一步且反直觉。
                    autoDiagnoseOnce()
                }
                is EngineSupervisor.State.Stopped -> {
                    statusView.text = getString(R.string.status_idle)
                    progress.visibility = ProgressBar.GONE
                    setFailureActionsVisible(true)
                    verdictCard.visibility = LinearLayout.GONE
                }
            }
        }
    }

    /**
     * 修复成功且引擎已就绪：停在引导页展示「修好了什么」+ 撤销 + 进入。
     *
     * 见 [render] Healthy 分支的注释：不跳走是为了保住撤销入口。
     */
    private fun showRecovered() {
        statusView.text = getString(R.string.boot_recovered)
        progress.visibility = ProgressBar.GONE
        val record = runCatching { recovery.latestRecord() }.getOrNull()
        recoveredCard.visibility = LinearLayout.VISIBLE
        recoveredHeadline.text = record?.headline?.takeIf { it.isNotBlank() }
            ?: getString(R.string.boot_recovered)
        recoveredDetail.text = record?.changes?.joinToString("\n") { "· $it" }.orEmpty()
        recoveredDetail.visibility =
            if (recoveredDetail.text.isNullOrBlank()) View.GONE else View.VISIBLE
        undoButton.visibility =
            if (runCatching { recovery.backupCount() }.getOrDefault(0) > 0) Button.VISIBLE
            else Button.GONE
        setFailureActionsVisible(false)
        repairButton.visibility = Button.GONE
        enterRow.visibility = LinearLayout.VISIBLE
        hintView.text = getString(R.string.boot_recovered_hint)
    }

    private fun enterMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    /** 失败态下显示修复/诊断/重试三个按钮与提示。 */
    private fun setFailureActionsVisible(visible: Boolean) {
        val v = if (visible) LinearLayout.VISIBLE else LinearLayout.GONE
        repairButton.visibility = v
        actionRow.visibility = v
        hintView.text = if (visible) getString(R.string.boot_failed_hint) else getString(R.string.boot_hint)
        if (visible) {
            // 一旦回到失败/进行态，成功卡片就该消失 —— 它描述的是一次已经过期的修复
            recoveredCard.visibility = LinearLayout.GONE
            enterRow.visibility = LinearLayout.GONE
        }
    }

    /**
     * 失败后自动跑一次归因。
     *
     * 只跑一次：`Failed` 是终态，不会反复触发；但如果用户手动重试后再次失败，
     * `lastDiagnosis` 会被重置（见 [retry]），于是会重新归因。
     */
    private fun autoDiagnoseOnce() {
        if (lastDiagnosis != null) return
        runDiagnosis()
    }

    /**
     * 跑归因并把结果画到界面上。
     *
     * 诊断本身是纯只读的（两条官方 dump），所以随时可以安全地重跑 —— 尤其是
     * 修复之后重跑一次，能直接证明「坏的那层已经不在配置树里了」。
     */
    private fun runDiagnosis() {
        val busy = workJob?.isActive == true
        if (busy) return
        statusView.text = getString(R.string.boot_diagnosing)
        verdictCard.visibility = LinearLayout.GONE

        workJob = app.appScope.launch {
            val d = runCatching { probe.diagnose() }.getOrNull()
            runOnUiThread {
                // 引擎自己可能在这期间已经恢复（或用户点了重试），别用旧结论盖新状态
                if (supervisor.state.value !is EngineSupervisor.State.Failed) return@runOnUiThread
                if (d == null) {
                    statusView.text = "${getString(R.string.boot_failed)}：${getString(R.string.boot_diagnose_failed)}"
                } else {
                    lastDiagnosis = d
                    showDiagnosis(d)
                    statusView.text = getString(R.string.boot_failed)
                }
            }
        }
    }

    /** 把归因结果写进卡片。 */
    private fun showDiagnosis(d: RecoveryProbe.Diagnosis) {
        verdictCard.visibility = LinearLayout.VISIBLE
        verdictHeadline.text = d.headline
        verdictHeadline.setTextColor(getColor(R.color.kxxy_danger))
        verdictDetail.text = d.detail.ifBlank { d.summary() }
    }

    /**
     * 修复启动。
     *
     * 力度由归因结果决定：归因说 L1 就做 L1，说 L2 才做 L2。L3 永不自动 ——
     * 它要删 node_modules、要联网，必须用户在诊断页里明确点。
     */
    private fun repair() {
        if (workJob?.isActive == true) return
        val level = lastDiagnosis?.recommended ?: RecoveryManager.Level.L1
        statusView.text = getString(R.string.boot_repairing)
        repairButton.isEnabled = false
        actionRow.visibility = LinearLayout.GONE

        workJob = app.appScope.launch {
            val result = runCatching { recovery.recover(level, lastDiagnosis?.headline ?: "") }
            runOnUiThread {
                repairButton.isEnabled = true
                val ok = result.getOrNull()
                if (ok == null) {
                    statusView.text = getString(
                        R.string.boot_repair_failed,
                        result.exceptionOrNull()?.message?.take(160) ?: "unknown",
                    )
                    setFailureActionsVisible(true)
                    return@runOnUiThread
                }
                if (ok.changes.isEmpty()) {
                    // 没有可动的文件：说明配置层是好的，问题在运行时或更深的地方。
                    // 此时假装「修好了」再重启一次只会浪费用户一个 14 次的退避周期。
                    statusView.text = getString(R.string.boot_repair_nothing)
                    setFailureActionsVisible(true)
                    return@runOnUiThread
                }
                Log.i(TAG, "recovered L${level.name.last()}: ${ok.changes.joinToString("; ")}")
                statusView.text = getString(R.string.boot_repair_done)
                verdictCard.visibility = LinearLayout.GONE
                repairedInThisRun = true
                // 清空归因缓存：重启后的失败是新的一次，要重新归因
                lastDiagnosis = null
                supervisor.restart()
            }
        }
    }

    /** 诊断详情页：四条探针 + 三级修复 + 撤销。 */
    private fun openDiagnoseSheet() {
        val d = lastDiagnosis
        val dp = resources.displayMetrics.density
        fun dpx(v: Int) = (v * dp).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(getColor(R.color.kxxy_window_bg))
            setPadding(dpx(20), dpx(16), dpx(20), dpx(12))
        }

        val title = TextView(this).apply {
            text = getString(R.string.diag_title)
            setTextColor(getColor(R.color.kxxy_boot_title))
            textSize = 18f
            setTypeface(typeface, Typeface.BOLD)
        }
        root.addView(title)

        if (d != null) {
            root.addView(label(d.headline, R.color.kxxy_danger, 15f, dpx(8), bold = true))
            if (d.detail.isNotBlank()) {
                root.addView(label(d.detail, R.color.kxxy_boot_status, 12f, dpx(4)))
            }
        }

        // 四条探针
        d?.checks?.forEach { c ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dpx(10), 0, 0)
            }
            val (colorRes, glyph) = when (c.verdict) {
                RecoveryProbe.Verdict.HIT -> R.color.kxxy_danger to "✕"
                RecoveryProbe.Verdict.MISS -> R.color.kxxy_ok to "✓"
                RecoveryProbe.Verdict.UNKNOWN -> R.color.kxxy_boot_hint to "–"
            }
            val code = TextView(this).apply {
                text = "${c.code} $glyph"
                setTextColor(getColor(colorRes))
                textSize = 13f
                setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
                minWidth = dpx(44)
            }
            val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            body.addView(TextView(this@BootstrapActivity).apply {
                text = c.title
                setTextColor(getColor(R.color.kxxy_boot_title))
                textSize = 13f
            })
            if (c.detail.isNotBlank()) {
                body.addView(TextView(this@BootstrapActivity).apply {
                    text = c.detail
                    setTextColor(getColor(R.color.kxxy_boot_status))
                    textSize = 11f
                    setPadding(0, dpx(2), 0, 0)
                })
            }
            row.addView(code)
            row.addView(body, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            root.addView(row)
        }

        // 上一次修复
        recovery.latestRecord()?.let { r ->
            root.addView(divider(dpx(14)))
            root.addView(
                label(
                    getString(R.string.diag_last_repair, r.changes.joinToString("；")),
                    R.color.kxxy_boot_hint, 11f, dpx(6),
                )
            )
        }

        // 三级修复按钮
        root.addView(divider(dpx(14)))
        root.addView(label("修复力度（破坏性递增）", R.color.kxxy_boot_hint, 11f, dpx(4)))

        root.addView(levelButton(
            getString(R.string.diag_l1),
            "移走损坏的补丁文件，把启用列表收缩回核心三项。不删插件、不动数据。",
            RecoveryManager.Level.L1, offlineOk = true,
        ))
        root.addView(levelButton(
            getString(R.string.diag_l2),
            "在 L1 之上把非核心插件包移入隔离区。插件仍保留，只是暂不加载。",
            RecoveryManager.Level.L2, offlineOk = true,
        ))
        root.addView(levelButton(
            getString(R.string.diag_l3),
            "备份后清空 profile 的 node_modules，由引擎重新拉取依赖。需要联网。",
            RecoveryManager.Level.L3, offlineOk = false,
        ))

        // 撤销
        if (recovery.backupCount() > 0) {
            root.addView(Button(this).apply {
                text = getString(R.string.diag_undo)
                setOnClickListener { undoLatest() }
            })
        }

        root.addView(Button(this).apply {
            text = getString(R.string.diag_close)
            setOnClickListener { currentDialog?.dismiss() }
        })

        val scroll = ScrollView(this).apply { addView(root) }
        currentDialog = AlertDialog.Builder(this)
            .setView(scroll)
            .setCancelable(true)
            .create()
        currentDialog?.show()
    }

    private var currentDialog: AlertDialog? = null

    private fun levelButton(label: String, desc: String, level: RecoveryManager.Level, offlineOk: Boolean): LinearLayout {
        val dp = resources.displayMetrics.density
        fun dpx(v: Int) = (v * dp).toInt()
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpx(12), dpx(10), dpx(12), dpx(10))
        }
        box.addView(TextView(this).apply {
            text = label
            setTextColor(getColor(R.color.kxxy_accent))
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
        })
        box.addView(TextView(this).apply {
            text = desc
            setTextColor(getColor(R.color.kxxy_boot_status))
            textSize = 11f
            setPadding(0, dpx(3), 0, dpx(6))
        })
        box.addView(Button(this).apply {
            text = label
            setOnClickListener {
                if (!offlineOk && !isOnline()) {
                    toast(getString(R.string.diag_l3_offline))
                    return@setOnClickListener
                }
                if (level == RecoveryManager.Level.L3) {
                    AlertDialog.Builder(this@BootstrapActivity)
                        .setMessage(getString(R.string.diag_l3_confirm))
                        .setPositiveButton(getString(R.string.boot_repair)) { _, _ -> runRepair(level) }
                        .setNegativeButton(android.R.string.cancel, null)
                        .show()
                } else {
                    runRepair(level)
                }
            }
        })
        return box
    }

    /** 从诊断页发起的修复。 */
    private fun runRepair(level: RecoveryManager.Level) {
        currentDialog?.dismiss()
        statusView.text = getString(R.string.boot_repairing)
        setFailureActionsVisible(false)
        workJob = app.appScope.launch {
            val result = runCatching { recovery.recover(level, lastDiagnosis?.headline ?: "") }
            runOnUiThread {
                val ok = result.getOrNull()
                if (ok == null) {
                    statusView.text = getString(
                        R.string.boot_repair_failed,
                        result.exceptionOrNull()?.message?.take(160) ?: "unknown",
                    )
                    setFailureActionsVisible(true)
                    return@runOnUiThread
                }
                statusView.text = getString(R.string.boot_repair_done)
                repairedInThisRun = true
                lastDiagnosis = null
                supervisor.restart()
            }
        }
    }

    private fun undoLatest() {
        currentDialog?.dismiss()
        workJob = app.appScope.launch {
            val ok = runCatching { recovery.undoLatest() }.getOrDefault(false)
            runOnUiThread {
                statusView.text = getString(if (ok) R.string.diag_undo_done else R.string.diag_undo_none)
                lastDiagnosis = null
                if (ok) {
                    // 撤销后不再停在成功卡片上：配置已还原，若它能起来就是正常启动，
                    // 起不来会重新走归因，那时的结论才是有意义的。
                    repairedInThisRun = false
                    recoveredCard.visibility = LinearLayout.GONE
                    enterRow.visibility = LinearLayout.GONE
                    supervisor.restart()
                } else {
                    setFailureActionsVisible(true)
                }
            }
        }
    }

    /** 手动重试：清掉旧归因，让失败后重新诊断。 */
    private fun retry() {
        lastDiagnosis = null
        verdictCard.visibility = LinearLayout.GONE
        setFailureActionsVisible(false)
        statusView.text = getString(R.string.boot_starting)
        supervisor.restart()
    }

    private fun isOnline(): Boolean = runCatching {
        val cm = getSystemService(ConnectivityManager::class.java)
        val net = cm?.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }.getOrDefault(true)

    private fun toast(msg: String) {
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show()
    }

    private fun label(text: String, colorRes: Int, size: Float, topPad: Int, bold: Boolean = false) =
        TextView(this).apply {
            this.text = text
            setTextColor(getColor(colorRes))
            textSize = size
            setPadding(0, topPad, 0, 0)
            if (bold) setTypeface(typeface, Typeface.BOLD)
        }

    /** 一条 1dp 的分隔线（用裸 View + 背景色，避免为一条线引入 XML shape）。 */
    private fun divider(topPad: Int) = android.view.View(this).apply {
        setBackgroundColor(getColor(R.color.kxxy_divider))
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            (1 * resources.displayMetrics.density).toInt(),
        ).also { it.topMargin = topPad }
    }

    private fun buildUi(): ViewGroup {
        val dp = resources.displayMetrics.density
        fun d(v: Int) = (v * dp).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            // 跟随系统深浅色，取值见 res/values{,-night}/colors.xml
            setBackgroundColor(getColor(R.color.kxxy_window_bg))
            setPadding(d(32), d(32), d(32), d(32))
        }

        titleView = TextView(this).apply {
            text = getString(R.string.boot_title)
            setTextColor(getColor(R.color.kxxy_boot_title))
            textSize = 26f
            gravity = Gravity.CENTER
        }

        statusView = TextView(this).apply {
            text = getString(R.string.boot_checking)
            setTextColor(getColor(R.color.kxxy_boot_status))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(0, d(20), 0, d(20))
        }

        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = ProgressBar.GONE
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, d(4)
            )
        }

        // 归因卡片：只在失败且已有结论时显示
        verdictCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(getColor(R.color.kxxy_card_bg))
            setPadding(d(14), d(12), d(14), d(12))
            visibility = LinearLayout.GONE
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        verdictHeadline = TextView(this).apply {
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(getColor(R.color.kxxy_danger))
        }
        verdictDetail = TextView(this).apply {
            textSize = 11f
            setTextColor(getColor(R.color.kxxy_boot_status))
            setPadding(0, d(4), 0, 0)
            movementMethod = ScrollingMovementMethod()
            maxLines = 4
        }
        verdictCard.addView(verdictHeadline)
        verdictCard.addView(verdictDetail)

        // 主修复按钮
        repairButton = Button(this).apply {
            text = getString(R.string.boot_repair)
            visibility = Button.GONE
            setBackgroundResource(R.drawable.bg_button_primary)
            setTextColor(getColor(R.color.kxxy_accent_text))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setTypeface(typeface, Typeface.BOLD)
            minHeight = d(48)
            setOnClickListener { repair() }
        }

        // 次级按钮行：重试 / 诊断
        actionRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            visibility = LinearLayout.GONE
        }
        retryButton = Button(this).apply {
            text = getString(R.string.boot_retry)
            setOnClickListener { retry() }
        }
        diagnoseButton = Button(this).apply {
            text = getString(R.string.boot_diagnose)
            setOnClickListener {
                if (lastDiagnosis == null) runDiagnosis() else openDiagnoseSheet()
            }
        }
        actionRow.addView(retryButton, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        actionRow.addView(diagnoseButton, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        hintView = TextView(this).apply {
            text = getString(R.string.boot_hint)
            setTextColor(getColor(R.color.kxxy_boot_hint))
            textSize = 11f
            gravity = Gravity.CENTER
            setPadding(d(4), d(20), d(4), 0)
        }

        // 修复成功卡片：说明刚动了什么，并给出撤销入口
        recoveredCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(getColor(R.color.kxxy_card_bg))
            setPadding(d(14), d(12), d(14), d(12))
            visibility = LinearLayout.GONE
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        recoveredHeadline = TextView(this).apply {
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(getColor(R.color.kxxy_ok))
        }
        recoveredDetail = TextView(this).apply {
            textSize = 11f
            setTextColor(getColor(R.color.kxxy_boot_status))
            setPadding(0, d(6), 0, 0)
            movementMethod = ScrollingMovementMethod()
        }
        undoButton = Button(this).apply {
            text = getString(R.string.diag_undo)
            visibility = Button.GONE
            setOnClickListener { undoLatest() }
            setPadding(0, d(10), 0, 0)
        }
        recoveredCard.addView(recoveredHeadline)
        recoveredCard.addView(recoveredDetail)
        recoveredCard.addView(undoButton)

        // 「进入主界面」行（修复成功后出现，替代失败态的三个按钮）
        enterRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            visibility = LinearLayout.GONE
        }
        enterRow.addView(
            Button(this).apply {
                text = getString(R.string.boot_enter)
                setBackgroundResource(R.drawable.bg_button_primary)
                setTextColor(getColor(R.color.kxxy_accent_text))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                setTypeface(typeface, Typeface.BOLD)
                minHeight = d(48)
                setOnClickListener { enterMain() }
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )

        root.addView(titleView)
        root.addView(statusView)
        root.addView(progress)
        root.addView(verdictCard)
        root.addView(recoveredCard)
        root.addView(repairButton)
        root.addView(actionRow)
        root.addView(enterRow)
        root.addView(hintView)
        return root
    }

    override fun onDestroy() {
        stateJob?.cancel()
        workJob?.cancel()
        currentDialog?.dismiss()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "KxxyBootstrap"
    }
}
