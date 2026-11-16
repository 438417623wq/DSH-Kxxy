package app.kxxy

import android.animation.ObjectAnimator
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.os.Bundle
import android.provider.Settings
import android.text.method.ScrollingMovementMethod
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import app.kxxy.engine.EngineSupervisor
import app.kxxy.engine.RecoveryManager
import app.kxxy.engine.RecoveryProbe
import app.kxxy.engine.RescueDiagnostics
import app.kxxy.service.EngineService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * 引导页 —— 方案 T 下唯一必须原生的 UI。
 *
 * 为什么不能 Web 化：引擎尚未就绪时 127.0.0.1:3080 上没有任何服务，
 * WebView 无处可加载。所以这一屏必须用原生控件。
 *
 * 职责：
 *   ① WebView 版本门禁（< Chrome 85 明确提示而非白屏）
 *   ② 解压 runtime.zip（显示确定性进度）
 *   ③ 启动 EngineService
 *   ④ 轮询直到引擎 Healthy，然后跳 MainActivity
 *   ⑤ **崩溃自愈（方案 K）**：失败时给出归因 + 三级修复入口
 *
 * ## 界面：「深海悬浮」（女仆大肥鲸）
 *
 * 设计稿为会话内渲染的 HTML 原型（深蓝径向渐变 + 光晕 + 抠好底的鲸鱼 PNG +
 * 玻璃拟态进度面板）。要点：
 *   · 固定深色品牌视觉，不跟随系统深浅色 —— boot_* 色板只放 values/，
 *     不提供 night 姊妹值，也不与主界面共用的 kxxy_* 混用；
 *   · 鲸鱼是位图插画（res/drawable-nodpi/boot_whale_maid.png），不是矢量；
 *   · 界面仍用代码构造而非 XML 布局 —— 沿用本文件原有的设计原则；
 *   · 状态机、诊断、三级修复、撤销逻辑与旧版逐条等价，只换了展示层。
 */
class BootstrapActivity : Activity() {

    private val app get() = application as KxxyApp
    private val supervisor: EngineSupervisor get() = app.supervisor
    private val recovery get() = RecoveryManager(this)
    private val probe get() = RecoveryProbe(this)

    /** 中密度像素 → 像素。 */
    private fun dpx(v: Float): Int = (v * resources.displayMetrics.density + 0.5f).toInt()

    private val mediumTypeface: Typeface by lazy { Typeface.create("sans-serif-medium", Typeface.NORMAL) }

    // ── 深海悬浮 UI 句柄 ──────────────────────────────────────────────
    private lateinit var greetingView: TextView
    private lateinit var subView: TextView
    private lateinit var statusView: TextView
    private lateinit var valueView: TextView
    private lateinit var detailView: TextView
    private lateinit var stateDot: View
    private lateinit var panel: LinearLayout
    private lateinit var track: FrameLayout
    private lateinit var trackFill: View
    private lateinit var stepsRow: LinearLayout
    private lateinit var stepMarkers: List<TextView>
    private lateinit var stepLabels: List<TextView>
    private lateinit var actionsRow: LinearLayout
    private lateinit var whaleView: ImageView
    private lateinit var footerView: TextView

    /** 动作按钮（对齐设计稿的动作区，具体显隐由 [applyBootState] 统一裁决）。 */
    private lateinit var repairButton: Button
    private lateinit var retryButton: Button
    private lateinit var diagnoseButton: Button
    private lateinit var undoButton: Button
    private lateinit var enterButton: Button

    /** 鲸鱼待机的上下浮动动画；系统关闭动画时长时保持静止。 */
    private var floatAnimator: ObjectAnimator? = null

    /** 最近一次写入进度条的百分比，track 尺寸变化时重放。 */
    private var lastFillPct = 0

    private var stateJob: Job? = null
    private var workJob: Job? = null
    private var diagnosing = false
    private var diagnosisAttempted = false
    private var operationBusy = false
    private var rescueMode = false
    private var webViewBlocked = false
    private var pendingReport: String? = null

    /** 缓存最近一次归因，供诊断页复用（避免重复跑 dump）。 */
    private var lastDiagnosis: RecoveryProbe.Diagnosis? = null

    /**
     * 本次进程内是否执行过修复。
     *
     * 用来区分「正常启动」与「修复后启动」：后者要停在引导页给撤销入口，
     * 而不是像正常路径那样立刻跳进主界面。
     */
    private var repairedInThisRun = false
    private var lastRepairUndoable = false
    private var lastRepairChanges: List<String> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyWindowChrome()
        setContentView(buildUi())

        rescueMode = savedInstanceState?.getBoolean(EXTRA_RESCUE)
            ?: intent.getBooleanExtra(EXTRA_RESCUE, false)
        repairedInThisRun = savedInstanceState?.getBoolean("rescue.repaired") ?: false
        lastRepairUndoable = savedInstanceState?.getBoolean("rescue.undoable") ?: false
        lastRepairChanges = savedInstanceState?.getStringArrayList("rescue.changes") ?: emptyList()
        webViewBlocked = !WebViewGate.isSupported(this)
        // 救援入口不依赖 WebView，更不能因为版本门禁把日志和修复入口一起关掉。
        if (webViewBlocked) {
            applyBootState(
                greetingRes = R.string.boot_maid_greeting_failed,
                subRes = R.string.boot_maid_sub_failed,
                statusText = getString(R.string.boot_failed),
                valueText = "!",
                pct = null,
                detailText = getString(R.string.boot_webview_too_old),
                doneUpTo = 0,
                activeStep = -1,
                footerRes = R.string.boot_maid_footer_failed,
                actions = listOf(diagnoseButton),
                danger = true,
                showSteps = false,
            )
        }

        // 救援模式不主动启动或自动跳走，先让用户看清原因。
        if (!rescueMode && !webViewBlocked) EngineService.start(this)
        stateJob = app.appScope.launch {
            supervisor.state.collectLatest { render(it) }
        }
    }

    /** 这一屏是恒定深海夜色：状态栏 / 导航栏吃进底色，图标强制浅色。 */
    private fun applyWindowChrome() {
        window.statusBarColor = getColor(R.color.boot_bg_deep)
        window.navigationBarColor = getColor(R.color.boot_bg_deep)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = window.decorView.systemUiVisibility and
            (View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR).inv()
    }

    private fun render(state: EngineSupervisor.State) {
        runOnUiThread { applyState(state) }
    }

    private fun applyState(state: EngineSupervisor.State) {
        if (operationBusy || diagnosing) return
        if (webViewBlocked) {
            applyBootState(
                greetingRes = R.string.boot_maid_greeting_failed,
                subRes = R.string.boot_maid_sub_failed,
                statusText = getString(R.string.boot_failed),
                valueText = "!", pct = null,
                detailText = getString(R.string.boot_webview_too_old),
                doneUpTo = 0, activeStep = -1,
                footerRes = R.string.boot_maid_footer_failed,
                actions = listOf(diagnoseButton), danger = true, showSteps = false,
            )
            return
        }
        when (state) {
            is EngineSupervisor.State.Idle -> applyBootState(
                greetingRes = R.string.boot_maid_greeting_starting,
                subRes = R.string.boot_maid_sub_starting,
                statusText = getString(R.string.boot_checking),
                valueText = "···",
                pct = null,
                detailText = "",
                doneUpTo = 0,
                activeStep = -1,
                footerRes = R.string.boot_maid_footer_starting,
                actions = listOf(diagnoseButton),
            )
            is EngineSupervisor.State.Installing -> {
                val pct = (state.progress * 100).toInt().coerceIn(0, 100)
                applyBootState(
                    greetingRes = R.string.boot_maid_greeting_wait,
                    subRes = R.string.boot_maid_sub_wait,
                    statusText = getString(R.string.boot_installing),
                    valueText = "$pct%",
                    pct = pct,
                    detailText = getString(R.string.boot_maid_detail_installing),
                    doneUpTo = 0,
                    activeStep = 0,
                    footerRes = R.string.boot_maid_footer_wait,
                    actions = listOf(diagnoseButton),
                )
            }
            is EngineSupervisor.State.Starting -> applyBootState(
                greetingRes = R.string.boot_maid_greeting_starting,
                subRes = R.string.boot_maid_sub_starting,
                statusText = getString(R.string.boot_starting),
                valueText = "···",
                pct = null,
                detailText = getString(R.string.boot_maid_detail_starting),
                doneUpTo = 1,
                activeStep = 1,
                footerRes = R.string.boot_maid_footer_starting,
                actions = listOf(diagnoseButton),
            )
            is EngineSupervisor.State.Healthy -> {
                Log.i(TAG, "engine healthy (tokenUrl=${state.tokenUrl != null}, repaired=$repairedInThisRun)")
                if (rescueMode && !repairedInThisRun) {
                    applyBootState(
                        greetingRes = R.string.boot_maid_greeting_ready,
                        subRes = R.string.boot_maid_sub_ready,
                        statusText = getString(R.string.rescue_title),
                        valueText = "✓", pct = null,
                        detailText = intent.getStringExtra(EXTRA_RESCUE_REASON).orEmpty(),
                        doneUpTo = 3, activeStep = -1,
                        footerRes = R.string.boot_maid_footer_ready,
                        actions = listOf(diagnoseButton, enterButton), ok = true,
                    )
                } else if (repairedInThisRun) {
                    // 修复后先展示实际改动与可用的撤销入口，再由用户进入主界面。
                    showRecovered()
                } else {
                    applyBootState(
                        greetingRes = R.string.boot_maid_greeting_ready,
                        subRes = R.string.boot_maid_sub_ready,
                        statusText = getString(R.string.boot_waiting),
                        valueText = "···",
                        pct = null,
                        detailText = "",
                        doneUpTo = 3,
                        activeStep = -1,
                        footerRes = R.string.boot_maid_footer_ready,
                        actions = listOf(diagnoseButton),
                        ok = true,
                    )
                    enterMain()
                }
            }
            is EngineSupervisor.State.Backoff -> applyBootState(
                greetingRes = R.string.boot_maid_greeting_starting,
                subRes = R.string.boot_maid_sub_starting,
                statusText = getString(R.string.status_backoff, state.delayMs / 1000, state.attempt),
                valueText = "···",
                pct = null,
                detailText = getString(R.string.boot_maid_detail_starting),
                doneUpTo = 1,
                activeStep = 1,
                footerRes = R.string.boot_maid_footer_starting,
                actions = listOf(diagnoseButton),
            )
            is EngineSupervisor.State.Failed -> {
                applyBootState(
                    greetingRes = R.string.boot_maid_greeting_failed,
                    subRes = R.string.boot_maid_sub_failed,
                    statusText = getString(R.string.boot_failed),
                    valueText = "!",
                    pct = null,
                    detailText = state.reason,
                    doneUpTo = 1,
                    activeStep = 1,
                    footerRes = R.string.boot_maid_footer_failed,
                    actions = listOf(repairButton, retryButton, diagnoseButton),
                    danger = true,
                    showSteps = false,
                )
                // 失败即归因：用户看到「修复启动」按钮时，原因应该已经在屏幕上了。
                // 否则他得先点一次「诊断」才知道该不该点修复，多一步且反直觉。
                autoDiagnoseOnce()
            }
            is EngineSupervisor.State.Stopped -> applyBootState(
                greetingRes = R.string.boot_maid_greeting_failed,
                subRes = R.string.boot_maid_sub_failed,
                statusText = getString(R.string.status_idle),
                valueText = "!",
                pct = null,
                detailText = "",
                doneUpTo = 0,
                activeStep = -1,
                footerRes = R.string.boot_maid_footer_failed,
                actions = listOf(repairButton, retryButton, diagnoseButton),
                danger = true,
                showSteps = false,
            )
        }
    }

    /**
     * 修复成功且引擎已就绪：停在引导页展示「修好了什么」+ 撤销 + 进入。
     *
     * 见 [applyState] Healthy 分支的注释：不跳走是为了保住撤销入口。
     */
    private fun showRecovered() {
        applyBootState(
            greetingRes = R.string.boot_maid_greeting_recovered,
            subRes = R.string.boot_maid_sub_recovered,
            statusText = getString(R.string.boot_recovered),
            valueText = "✓",
            pct = null,
            detailText = lastRepairChanges.joinToString("\n") { "· $it" },
            doneUpTo = 3,
            activeStep = -1,
            footerRes = R.string.boot_maid_footer_recovered,
            actions = if (lastRepairUndoable) listOf(undoButton, diagnoseButton, enterButton)
                else listOf(diagnoseButton, enterButton),
            ok = true,
            showSteps = false,
        )
        // 没有备份时撤销入口没有意义（与旧版 recoveredCard 的规则一致）。
        if (runCatching { recovery.backupCount() }.getOrDefault(0) <= 0) {
            undoButton.visibility = View.GONE
        }
    }

    private fun enterMain() {
        val state = supervisor.state.value
        if (state !is EngineSupervisor.State.Healthy) {
            toast(getString(R.string.boot_waiting))
            return
        }
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    /**
     * 把一个启动状态写到界面上 —— 设计稿五态（安装 / 启动 / 就绪 / 失败 / 修复完成）
     * 的统一入口，所有显隐与配色都在这里裁决。
     *
     * @param pct        确定性进度（仅 Installing 非 null）；null 隐藏进度条
     * @param doneUpTo   序号小于它的步骤画 ✓
     * @param activeStep 当前进行中的步骤（-1 表示无）
     * @param actions    本状态可见的动作按钮，其余一律隐藏
     * @param danger     失败态：面板与数值换成警示色，鲸鱼停止浮动
     * @param ok         成功态：状态点换 ok 绿，鲸鱼抬头
     * @param showSteps  失败 / 修复完成态按设计稿隐藏步骤条
     */
    private fun applyBootState(
        greetingRes: Int,
        subRes: Int,
        statusText: String,
        valueText: String,
        pct: Int?,
        detailText: String,
        doneUpTo: Int,
        activeStep: Int,
        footerRes: Int,
        actions: List<Button>,
        danger: Boolean = false,
        ok: Boolean = false,
        showSteps: Boolean = true,
    ) {
        greetingView.setText(greetingRes)
        subView.setText(subRes)
        statusView.text = statusText
        valueView.text = valueText

        track.visibility = if (pct == null) View.GONE else View.VISIBLE
        if (pct != null) applyFill(pct)

        detailView.text = RescueDiagnostics.redact(detailText)
        detailView.setTextColor(getColor(R.color.boot_text_secondary))
        detailView.visibility = if (detailText.isBlank()) View.GONE else View.VISIBLE

        stepsRow.visibility = if (showSteps) View.VISIBLE else View.GONE
        for (i in 0 until 3) {
            val marker = stepMarkers[i]
            val label = stepLabels[i]
            when {
                showSteps && i < doneUpTo -> {
                    marker.text = "✓"
                    marker.background = circleBg(R.color.boot_step_done_bg)
                    marker.setTextColor(getColor(R.color.boot_step_done_text))
                    label.setTextColor(getColor(R.color.boot_step_done_text))
                }
                showSteps && i == activeStep -> {
                    marker.text = (i + 1).toString()
                    marker.background = circleBg(R.color.boot_step_active_bg)
                    marker.setTextColor(getColor(R.color.boot_btn_primary_text))
                    label.setTextColor(getColor(R.color.boot_text_primary))
                }
                else -> {
                    marker.text = (i + 1).toString()
                    marker.background = circleBg(R.color.boot_step_idle_bg)
                    marker.setTextColor(getColor(R.color.boot_step_idle_text))
                    label.setTextColor(getColor(R.color.boot_text_muted))
                }
            }
        }

        footerView.setText(footerRes)

        actionsRow.visibility = if (actions.isEmpty()) View.GONE else View.VISIBLE
        for (button in listOf(repairButton, retryButton, diagnoseButton, undoButton, enterButton)) {
            button.visibility = if (button in actions) View.VISIBLE else View.GONE
        }

        panel.background = panelBg(danger)
        stateDot.background = circleBg(
            when {
                danger -> R.color.boot_danger_light
                ok -> R.color.boot_ok_light
                else -> R.color.boot_accent
            }
        )
        valueView.setTextColor(getColor(if (danger) R.color.boot_danger_value else R.color.boot_value))

        if (danger) {
            settleWhale(ok = false)
        } else if (ok) {
            settleWhale(ok = true)
        } else {
            whaleView.animate().rotation(-2f).setDuration(350).start()
            startWhaleFloat()
        }
    }

    // ── 崩溃自愈（方案 K）：诊断 / 修复 / 撤销 ─────────────────────────

    /**
     * 失败后自动跑一次归因。
     *
     * 只跑一次；诊断超时也算一次，避免失败状态刷新触发无限诊断循环。
     */
    private fun autoDiagnoseOnce() {
        if (diagnosisAttempted || operationBusy) return
        runDiagnosis()
    }

    /**
     * 跑归因并把结果画到界面上。
     *
     * 诊断本身是纯只读的（两条官方 dump），所以随时可以安全地重跑 —— 尤其是
     * 修复之后重跑一次，能直接证明「坏的那层已经不在配置树里了」。
     */
    private fun runDiagnosis(after: ((RecoveryProbe.Diagnosis?) -> Unit)? = null) {
        if (operationBusy || diagnosing) {
            toast(getString(R.string.rescue_busy))
            return
        }
        diagnosisAttempted = true
        diagnosing = true
        statusView.text = getString(R.string.boot_diagnosing)
        detailView.text = getString(R.string.rescue_diagnosing_hint)
        detailView.visibility = View.VISIBLE
        actionsRow.visibility = View.VISIBLE
        repairButton.visibility = View.GONE
        retryButton.visibility = View.GONE
        diagnoseButton.visibility = View.VISIBLE
        val generation = supervisor.state.value
        workJob = app.appScope.launch(Dispatchers.IO) {
            var d: RecoveryProbe.Diagnosis? = null
            try {
                d = probe.diagnose()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "diagnosis failed", e)
            } finally {
                withContext(NonCancellable + Dispatchers.Main) {
                    diagnosing = false
                }
            }
            withContext(Dispatchers.Main) {
                if (isFinishing || isDestroyed) return@withContext
                if (supervisor.state.value != generation) {
                    applyState(supervisor.state.value)
                    return@withContext
                }
                lastDiagnosis = d
                applyState(supervisor.state.value)
                if (d != null) showDiagnosis(d)
                else {
                    detailView.text = getString(R.string.boot_diagnose_failed)
                    detailView.visibility = View.VISIBLE
                }
                after?.invoke(d)
            }
        }
    }

    /** 把归因结果写进详情区（设计稿：失败态的 detail 承载原因）。 */
    private fun showDiagnosis(d: RecoveryProbe.Diagnosis) {
        detailView.text = RescueDiagnostics.redact(buildString {
            append(d.headline)
            val detail = d.detail.ifBlank { d.summary() }
            if (detail.isNotBlank()) {
                append('\n')
                append(detail)
            }
        })
        detailView.setTextColor(getColor(R.color.boot_danger_detail))
        detailView.visibility = View.VISIBLE
    }

    /** 修复启动：没有证据时不猜层级，更不能自动执行 L3。 */
    private fun repair() {
        if (operationBusy || diagnosing) {
            toast(getString(R.string.rescue_busy))
            openRescueSheet()
            return
        }
        val before = supervisor.state.value
        if (before is EngineSupervisor.State.Healthy) {
            openRescueSheet()
            return
        }
        val d = lastDiagnosis
        if (d == null) {
            runDiagnosis { diagnosis ->
                if (diagnosis != null) repair() else openRescueSheet()
            }
            return
        }
        when (d.target) {
            RecoveryManager.Target.UNKNOWN, RecoveryManager.Target.ENVIRONMENT -> openRescueSheet()
            RecoveryManager.Target.RETRY -> retry()
            RecoveryManager.Target.RUNTIME -> confirmRuntimeRepair()
            RecoveryManager.Target.USER_DATA_PERMISSIONS -> confirmPermissionsRepair()
            RecoveryManager.Target.BOOT_DATA -> confirmBootDataRepair()
            else -> confirmRepair(d.recommended, d.target)
        }
    }

    /** 诊断详情页：四条探针 + 三级修复 + 撤销。 */
    private fun openDiagnoseSheet() {
        val d = lastDiagnosis
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(getColor(R.color.kxxy_window_bg))
            setPadding(dpx(20f), dpx(16f), dpx(20f), dpx(12f))
        }

        val title = TextView(this).apply {
            text = getString(R.string.diag_title)
            setTextColor(getColor(R.color.kxxy_boot_title))
            textSize = 18f
            typeface = mediumTypeface
        }
        root.addView(title)

        if (d != null) {
            root.addView(label(d.headline, R.color.kxxy_danger, 15f, dpx(8f), bold = true))
            if (d.detail.isNotBlank()) {
                root.addView(label(d.detail, R.color.kxxy_boot_status, 12f, dpx(4f)))
            }
        }

        // 四条探针
        d?.checks?.forEach { c ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dpx(10f), 0, 0)
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
                typeface = Typeface.MONOSPACE
                minWidth = dpx(44f)
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
                    setPadding(0, dpx(2f), 0, 0)
                })
            }
            row.addView(code)
            row.addView(body, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            root.addView(row)
        }

        // 上一次修复
        recovery.latestRecord()?.let { r ->
            root.addView(divider(dpx(14f)))
            root.addView(
                label(
                    getString(R.string.diag_last_repair, r.changes.joinToString("；")),
                    R.color.kxxy_boot_hint, 11f, dpx(6f),
                )
            )
        }

        root.addView(Button(this).apply {
            setText(R.string.rescue_logs)
            setOnClickListener { showRescueLogs() }
        })
        root.addView(Button(this).apply {
            setText(R.string.rescue_boot_data)
            setOnClickListener { confirmBootDataRepair() }
        })
        root.addView(Button(this).apply {
            setText(R.string.rescue_permissions)
            setOnClickListener { confirmPermissionsRepair() }
        })
        root.addView(Button(this).apply {
            setText(R.string.rescue_runtime)
            setOnClickListener { confirmRuntimeRepair() }
        })

        // 手动配置修复不替代运行时重装，各层动作都需确认。
        root.addView(divider(dpx(14f)))
        root.addView(label("高级配置修复（先备份，执行前确认）", R.color.kxxy_boot_hint, 11f, dpx(4f)))

        root.addView(levelButton(
            getString(R.string.diag_l1),
            "只备份并隔离已证实损坏的补丁；手动恢复可收缩启用列表，不移合法个人配置。",
            RecoveryManager.Level.L1,
        ))
        root.addView(levelButton(
            getString(R.string.diag_l2),
            "在 L1 之上把非核心插件包移入隔离区。插件仍保留，只是暂不加载。",
            RecoveryManager.Level.L2,
        ))
        root.addView(levelButton(
            getString(R.string.diag_l3),
            "备份后清空 profile 的 node_modules，由引擎重新拉取依赖。需要联网。",
            RecoveryManager.Level.L3,
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

    private fun levelButton(labelText: String, desc: String, level: RecoveryManager.Level): LinearLayout {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpx(12f), dpx(10f), dpx(12f), dpx(10f))
        }
        box.addView(TextView(this).apply {
            text = labelText
            setTextColor(getColor(R.color.kxxy_accent))
            textSize = 14f
            typeface = mediumTypeface
        })
        box.addView(TextView(this).apply {
            text = desc
            setTextColor(getColor(R.color.kxxy_boot_status))
            textSize = 11f
            setPadding(0, dpx(3f), 0, dpx(6f))
        })
        box.addView(Button(this).apply {
            text = labelText
            setOnClickListener {
                confirmRepair(level)
            }
        })
        return box
    }

    /** 修改前必须退出旧启动任务，成功只表示动作完成，仍需验证 Healthy。 */
    private fun runRepair(level: RecoveryManager.Level, target: RecoveryManager.Target? = null, allowRoot: Boolean = false) {
        if (operationBusy || diagnosing) {
            toast(getString(R.string.rescue_busy))
            return
        }
        currentDialog?.dismiss()
        operationBusy = true
        rescueMode = true
        statusView.text = getString(R.string.boot_repairing)
        actionsRow.visibility = View.VISIBLE
        for (button in listOf(repairButton, retryButton, undoButton, enterButton)) button.visibility = View.GONE
        diagnoseButton.visibility = View.VISIBLE
        val headline = lastDiagnosis?.headline.orEmpty()
        workJob = app.appScope.launch(Dispatchers.IO) {
            val result = try {
                Result.success(supervisor.performRecovery(level, headline, target, allowRoot))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
            withContext(Dispatchers.Main) {
                operationBusy = false
                if (isFinishing || isDestroyed) return@withContext
                val ok = result.getOrNull()
                applyState(supervisor.state.value)
                if (ok == null || !ok.success) {
                    statusView.text = getString(R.string.boot_failed)
                    detailView.text = getString(R.string.boot_repair_failed,
                        RescueDiagnostics.redact(ok?.detail ?: result.exceptionOrNull()?.message.orEmpty()).take(500))
                    detailView.visibility = View.VISIBLE
                    if (ok?.needsRoot == true && !allowRoot) {
                        if (ok.target == RecoveryManager.Target.BOOT_DATA) confirmBootDataRepair(allowRoot = true)
                        else confirmPermissionsRepair(allowRoot = true)
                    }
                } else if (ok.changes.isEmpty() && target !in setOf(RecoveryManager.Target.USER_DATA_PERMISSIONS, RecoveryManager.Target.BOOT_DATA)) {
                    statusView.text = getString(R.string.boot_repair_nothing)
                    detailView.text = RescueDiagnostics.redact(ok.detail)
                    detailView.visibility = View.VISIBLE
                } else {
                    repairedInThisRun = true
                    lastRepairUndoable = ok.undoable
                    lastRepairChanges = ok.changes.ifEmpty { listOf("本次救援目标检查通过，未修改数据内容") }
                    lastDiagnosis = null
                    diagnosisAttempted = false
                    statusView.text = getString(R.string.boot_repair_done)
                    EngineService.start(this@BootstrapActivity)
                    supervisor.restart()
                }
            }
        }
    }

    private fun undoLatest() {
        if (operationBusy || diagnosing) {
            toast(getString(R.string.rescue_busy))
            return
        }
        AlertDialog.Builder(this)
            .setMessage(getString(R.string.rescue_undo_confirm))
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.diag_undo) { _, _ ->
                currentDialog?.dismiss()
                operationBusy = true
                statusView.text = getString(R.string.boot_repairing)
                actionsRow.visibility = View.GONE
                workJob = app.appScope.launch(Dispatchers.IO) {
                    val ok = try {
                        supervisor.performUndo()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        Log.w(TAG, "undo failed", e)
                        false
                    }
                    withContext(Dispatchers.Main) {
                        operationBusy = false
                        if (isFinishing || isDestroyed) return@withContext
                        lastDiagnosis = null
                        diagnosisAttempted = false
                        applyState(supervisor.state.value)
                        statusView.text = getString(if (ok) R.string.diag_undo_done else R.string.rescue_undo_failed)
                        if (ok) {
                            repairedInThisRun = false
                            rescueMode = false
                            supervisor.restart()
                        }
                    }
                }
            }.show()
    }

    /** 重试不改配置；取消诊断后再启动，避免旧结论覆盖新一轮状态。 */
    private fun retry() {
        if (operationBusy) {
            toast(getString(R.string.rescue_busy))
            return
        }
        val previous = workJob
        operationBusy = true
        workJob = app.appScope.launch {
            previous?.cancelAndJoin()
            diagnosing = false
            lastDiagnosis = null
            diagnosisAttempted = false
            rescueMode = false
            operationBusy = false
            withContext(Dispatchers.Main) { statusView.text = getString(R.string.boot_starting) }
            EngineService.start(this@BootstrapActivity)
            supervisor.restart()
        }
    }

    /** 引擎、控制台和 WebView 均不可用时，仍可打开的原生救援菜单。 */
    private fun openRescueSheet() {
        rescueMode = true
        currentDialog?.dismiss()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpx(20f), dpx(12f), dpx(20f), dpx(12f))
        }
        val summary = listOfNotNull(
            intent.getStringExtra(EXTRA_RESCUE_REASON)?.takeIf { it.isNotBlank() },
            lastDiagnosis?.summary(),
            if (diagnosing) getString(R.string.rescue_diagnosing_hint) else null,
            if (operationBusy) getString(R.string.rescue_busy) else null,
            if (webViewBlocked) getString(R.string.boot_webview_too_old) else null,
        ).joinToString("\n")
        if (summary.isNotBlank()) root.addView(label(RescueDiagnostics.redact(summary), R.color.kxxy_boot_status, 13f, 0))
        fun action(title: Int, enabled: Boolean = true, block: () -> Unit) {
            root.addView(Button(this).apply {
                setText(title)
                isEnabled = enabled
                setOnClickListener { block() }
            })
        }
        action(R.string.rescue_logs) { showRescueLogs() }
        action(R.string.rescue_probe, !operationBusy && !diagnosing) {
            currentDialog?.dismiss()
            if (supervisor.state.value is EngineSupervisor.State.Installing ||
                supervisor.state.value is EngineSupervisor.State.Starting ||
                supervisor.state.value is EngineSupervisor.State.Backoff) {
                confirmStopAndDiagnose()
            } else runDiagnosis { openDiagnoseSheet() }
        }
        if (diagnosing) action(R.string.rescue_cancel_probe) {
            currentDialog?.dismiss()
            val previous = workJob
            operationBusy = true
            workJob = app.appScope.launch {
                previous?.cancelAndJoin()
                withContext(Dispatchers.Main) {
                    diagnosing = false
                    operationBusy = false
                    applyState(supervisor.state.value)
                }
            }
        }
        action(R.string.rescue_boot_data, !operationBusy && !diagnosing) { confirmBootDataRepair() }
        action(R.string.rescue_permissions, !operationBusy && !diagnosing) { confirmPermissionsRepair() }
        action(R.string.rescue_runtime, !operationBusy && !diagnosing) { confirmRuntimeRepair() }
        action(R.string.rescue_advanced, !operationBusy && !diagnosing) { openDiagnoseSheet() }
        if (recovery.backupCount() > 0) action(R.string.diag_undo, !operationBusy && !diagnosing) { undoLatest() }
        if (webViewBlocked) action(R.string.rescue_webview_settings) {
            runCatching { startActivity(Intent(Settings.ACTION_SETTINGS)) }
        }
        currentDialog = AlertDialog.Builder(this)
            .setTitle(R.string.rescue_title)
            .setView(ScrollView(this).apply { addView(root) })
            .setNegativeButton(android.R.string.cancel, null)
            .create()
        currentDialog?.show()
    }

    private fun confirmStopAndDiagnose() {
        AlertDialog.Builder(this)
            .setMessage(R.string.rescue_stop_confirm)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.rescue_probe) { _, _ ->
                operationBusy = true
                statusView.text = getString(R.string.rescue_stopping)
                workJob = app.appScope.launch(Dispatchers.IO) {
                    try {
                        supervisor.stop()
                        withContext(Dispatchers.Main) {
                            operationBusy = false
                            runDiagnosis { openDiagnoseSheet() }
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        withContext(Dispatchers.Main) {
                            operationBusy = false
                            applyState(supervisor.state.value)
                            toast(getString(R.string.boot_repair_failed, e.message.orEmpty()))
                        }
                    }
                }
            }.show()
    }

    private fun confirmBootDataRepair(allowRoot: Boolean = false) {
        if (operationBusy || diagnosing) {
            toast(getString(R.string.rescue_busy))
            return
        }
        AlertDialog.Builder(this)
            .setTitle(if (allowRoot) R.string.rescue_boot_data_root else R.string.rescue_boot_data)
            .setMessage(if (allowRoot) R.string.rescue_boot_data_root_confirm else R.string.rescue_boot_data_confirm)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.boot_repair) { _, _ ->
                runRepair(RecoveryManager.Level.L1, RecoveryManager.Target.BOOT_DATA, allowRoot)
            }.apply {
                if (!allowRoot) setNeutralButton(R.string.rescue_boot_data_root) { _, _ -> confirmBootDataRepair(allowRoot = true) }
            }.show()
    }

    private fun confirmPermissionsRepair(allowRoot: Boolean = false) {
        if (operationBusy || diagnosing) {
            toast(getString(R.string.rescue_busy))
            return
        }
        AlertDialog.Builder(this)
            .setTitle(if (allowRoot) R.string.rescue_permissions_root else R.string.rescue_permissions)
            .setMessage(if (allowRoot) R.string.rescue_permissions_root_confirm else R.string.rescue_permissions_confirm)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.boot_repair) { _, _ ->
                runRepair(RecoveryManager.Level.L1, RecoveryManager.Target.USER_DATA_PERMISSIONS, allowRoot)
            }.apply {
                if (!allowRoot) setNeutralButton(R.string.rescue_permissions_root) { _, _ -> confirmPermissionsRepair(allowRoot = true) }
            }.show()
    }

    private fun confirmRuntimeRepair() {
        if (operationBusy || diagnosing) {
            toast(getString(R.string.rescue_busy))
            return
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.rescue_runtime)
            .setMessage(R.string.rescue_runtime_confirm)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.boot_repair) { _, _ ->
                runRepair(RecoveryManager.Level.L1, RecoveryManager.Target.RUNTIME)
            }.show()
    }

    private fun confirmRepair(level: RecoveryManager.Level, target: RecoveryManager.Target? = null) {
        if (operationBusy || diagnosing) {
            toast(getString(R.string.rescue_busy))
            return
        }
        if (level == RecoveryManager.Level.L3 && !isOnline()) {
            toast(getString(R.string.diag_l3_offline))
            return
        }
        val explanation = if (level == RecoveryManager.Level.L3) getString(R.string.diag_l3_confirm)
            else getString(R.string.rescue_config_confirm)
        AlertDialog.Builder(this)
            .setMessage(listOfNotNull(lastDiagnosis?.summary(), explanation).joinToString("\n\n"))
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.boot_repair) { _, _ -> runRepair(level, target) }
            .show()
    }

    private fun showRescueLogs() {
        val body = TextView(this).apply {
            text = getString(R.string.rescue_loading_logs)
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
            setPadding(dpx(16f), dpx(12f), dpx(16f), dpx(12f))
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.rescue_logs)
            .setView(ScrollView(this).apply { addView(body) })
            .setPositiveButton(R.string.rescue_save_logs, null)
            .setNegativeButton(android.R.string.cancel, null)
            .create()
        currentDialog?.dismiss()
        currentDialog = dialog
        dialog.show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
        app.appScope.launch(Dispatchers.IO) {
            val report = runCatching { RescueDiagnostics.report(this@BootstrapActivity, supervisor) }
                .getOrElse { getString(R.string.boot_repair_failed, it.message.orEmpty()) }
            withContext(Dispatchers.Main) {
                if (!dialog.isShowing || isDestroyed) return@withContext
                body.text = report
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).apply {
                    isEnabled = true
                    setOnClickListener {
                        pendingReport = report
                        startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "text/plain"
                            putExtra(Intent.EXTRA_TITLE, "kxxy-rescue-${System.currentTimeMillis()}.txt")
                        }, SAVE_REPORT_REQUEST)
                    }
                }
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != SAVE_REPORT_REQUEST) return
        val report = pendingReport
        pendingReport = null
        val uri = data?.data ?: return
        if (resultCode != RESULT_OK || report == null) return
        app.appScope.launch(Dispatchers.IO) {
            val saved = runCatching {
                checkNotNull(contentResolver.openOutputStream(uri)).bufferedWriter(Charsets.UTF_8).use { it.write(report) }
            }
            withContext(Dispatchers.Main) {
                toast(if (saved.isSuccess) getString(R.string.rescue_saved_logs)
                    else getString(R.string.boot_repair_failed, saved.exceptionOrNull()?.message.orEmpty()))
            }
        }
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
            if (bold) typeface = mediumTypeface
        }

    /** 一条 1dp 的分隔线（用裸 View + 背景色，避免为一条线引入 XML shape）。 */
    private fun divider(topPad: Int) = View(this).apply {
        setBackgroundColor(getColor(R.color.kxxy_divider))
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dpx(1f),
        ).also { (it as LinearLayout.LayoutParams).topMargin = topPad }
    }

    // ── 「深海悬浮」界面构建 ──────────────────────────────────────────

    /**
     * 深海底色：圆形径向渐变（中心 50% / 34% 处最亮），半径按屏高放宽，
     * 模拟设计稿里「深海里上方透光」的观感。
     */
    private fun deepSeaBg(): GradientDrawable = GradientDrawable(
        GradientDrawable.Orientation.TOP_BOTTOM,
        intArrayOf(
            getColor(R.color.boot_bg_core),
            getColor(R.color.boot_bg_mid),
            getColor(R.color.boot_bg_deep),
        ),
    ).apply {
        gradientType = GradientDrawable.RADIAL_GRADIENT
        gradientRadius = resources.displayMetrics.heightPixels * 0.75f
        setGradientCenter(0.5f, 0.34f)
    }

    private fun circleBg(colorRes: Int): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(getColor(colorRes))
    }

    private fun panelBg(danger: Boolean): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dpx(20f).toFloat()
        setColor(getColor(if (danger) R.color.boot_danger_panel_bg else R.color.boot_panel_bg))
        setStroke(dpx(1f), getColor(if (danger) R.color.boot_danger_panel_stroke else R.color.boot_panel_stroke))
    }

    private fun actionBg(primary: Boolean): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dpx(11f).toFloat()
        setColor(getColor(if (primary) R.color.boot_btn_primary_bg else R.color.boot_btn_secondary_bg))
        setStroke(dpx(1f), getColor(if (primary) R.color.boot_btn_primary_stroke else R.color.boot_btn_secondary_stroke))
    }

    private fun styleAction(button: Button, primary: Boolean) {
        button.background = actionBg(primary)
        button.setTextColor(getColor(if (primary) R.color.boot_btn_primary_text else R.color.boot_btn_secondary_text))
        button.textSize = 12f
        button.isAllCaps = false
        button.stateListAnimator = null
        button.minHeight = dpx(40f)
        button.setPadding(dpx(10f), 0, dpx(10f), 0)
    }

    private fun buildUi(): ViewGroup {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = deepSeaBg()
        }

        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            addView(buildContent())
        }
        root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(buildFooter())
        return root
    }

    private fun buildContent(): ViewGroup {
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        // ── 品牌行：DSH Kxxy ｜ MAID EDITION ──
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dpx(24f), dpx(22f), dpx(24f), 0)
        }
        header.addView(TextView(this).apply {
            text = getString(R.string.boot_title)
            setTextColor(getColor(R.color.boot_text_primary))
            textSize = 17f
            typeface = mediumTypeface
            letterSpacing = 0.03f
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(TextView(this).apply {
            text = getString(R.string.boot_edition)
            setTextColor(getColor(R.color.boot_edition))
            textSize = 11f
            letterSpacing = 0.17f
        })
        content.addView(header)

        // ── 主视觉：光晕 + 落地阴影 + 气泡 + 鲸鱼 ──
        val hero = FrameLayout(this)
        hero.addView(View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                gradientType = GradientDrawable.RADIAL_GRADIENT
                setGradientCenter(0.5f, 0.5f)
                colors = intArrayOf(
                    getColor(R.color.boot_halo),
                    getColor(R.color.boot_halo_mid),
                    0x00000000,
                )
                gradientRadius = dpx(156f).toFloat()
            }
        }, FrameLayout.LayoutParams(dpx(312f), dpx(312f), Gravity.CENTER))
        hero.addView(View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                gradientType = GradientDrawable.RADIAL_GRADIENT
                setGradientCenter(0.5f, 0.5f)
                colors = intArrayOf(getColor(R.color.boot_ground_shadow), 0x00061222)
                gradientRadius = dpx(90f).toFloat()
            }
        }, FrameLayout.LayoutParams(dpx(180f), dpx(22f), Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM).also {
            it.bottomMargin = dpx(15f)
        })
        // 三颗气泡：位置照抄设计稿（左中 / 右上 / 右下各一）。
        bubble(hero, 9, left = 25, top = 111)
        bubble(hero, 15, right = 25, top = 53)
        bubble(hero, 6, right = 38, top = 276)

        whaleView = ImageView(this).apply {
            setImageResource(R.drawable.boot_whale_maid)
            adjustViewBounds = true
            rotation = -2f
            contentDescription = getString(R.string.boot_maid_alt)
        }
        hero.addView(whaleView, FrameLayout.LayoutParams(dpx(286f), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        hero.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dpx(344f)
        ).also { it.topMargin = dpx(12f) }
        content.addView(hero)

        // ── 问候语 ──
        greetingView = TextView(this).apply {
            setTextColor(getColor(R.color.boot_text_primary))
            textSize = 21f
            typeface = mediumTypeface
            gravity = Gravity.CENTER
            setLineSpacing(0f, 1.5f)
        }
        subView = TextView(this).apply {
            setTextColor(getColor(R.color.boot_text_secondary))
            textSize = 12f
            gravity = Gravity.CENTER
            setLineSpacing(0f, 1.7f)
            setPadding(0, dpx(8f), 0, 0)
        }
        content.addView(greetingView, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also { it.setMargins(dpx(24f), dpx(4f), dpx(24f), 0) })
        content.addView(subView, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also { it.setMargins(dpx(24f), 0, dpx(24f), 0) })

        // ── 启动面板 ──
        panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpx(18f), dpx(18f), dpx(18f), dpx(17f))
        }
        content.addView(panel, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also {
            it.setMargins(dpx(24f), dpx(22f), dpx(24f), dpx(10f))
        })

        panel.addView(TextView(this).apply {
            text = getString(R.string.boot_eyebrow)
            setTextColor(getColor(R.color.boot_eyebrow))
            textSize = 11f
            letterSpacing = 0.16f
        })

        // 状态行：圆点 + 状态文案 ｜ 数值
        val stateRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        stateRow.addView(FrameLayout(this).apply {
            stateDot = View(this@BootstrapActivity).apply { background = circleBg(R.color.boot_accent) }
            addView(stateDot, FrameLayout.LayoutParams(dpx(6f), dpx(6f), Gravity.CENTER))
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                gradientType = GradientDrawable.RADIAL_GRADIENT
                setGradientCenter(0.5f, 0.5f)
                colors = intArrayOf(0x4092BCFF, 0x0092BCFF)
                gradientRadius = dpx(7f).toFloat()
            }
        }, FrameLayout.LayoutParams(dpx(14f), dpx(14f)).also {
            it.rightMargin = dpx(7f)
        })
        statusView = TextView(this).apply {
            setTextColor(getColor(R.color.boot_text_primary))
            textSize = 13f
        }
        stateRow.addView(statusView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        valueView = TextView(this).apply {
            setTextColor(getColor(R.color.boot_value))
            textSize = 22f
            typeface = mediumTypeface
        }
        stateRow.addView(valueView, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        panel.addView(stateRow, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also { it.topMargin = dpx(12f) })

        // 进度条：圆角轨道 + 渐变填充（宽度由 [applyFill] 按百分比精确落位）
        track = FrameLayout(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dpx(3f).toFloat()
                setColor(getColor(R.color.boot_track))
            }
            trackFill = View(this@BootstrapActivity).apply {
                background = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, intArrayOf(
                    getColor(R.color.boot_accent_deep), getColor(R.color.boot_accent),
                )).apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = dpx(3f).toFloat()
                }
                layoutParams = FrameLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT)
            }
            addView(trackFill)
            // 尺寸变化（如 GONE→VISIBLE）后按最近一次百分比重新落位。
            addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> applyFill(lastFillPct) }
        }
        panel.addView(track, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dpx(6f)
        ).also { it.topMargin = dpx(15f) })

        detailView = TextView(this).apply {
            setTextColor(getColor(R.color.boot_text_secondary))
            textSize = 11f
            setLineSpacing(0f, 1.8f)
            maxLines = 5
            movementMethod = ScrollingMovementMethod()
        }
        panel.addView(detailView, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also { it.topMargin = dpx(11f) })

        // 步骤条：解压 → 启动 → 就绪
        stepsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val markerViews = ArrayList<TextView>(3)
        val labelViews = ArrayList<TextView>(3)
        listOf(R.string.boot_maid_step_extract, R.string.boot_maid_step_launch, R.string.boot_maid_step_ready)
            .forEachIndexed { i, res ->
                if (i > 0) {
                    stepsRow.addView(View(this@BootstrapActivity).apply {
                        setBackgroundColor(getColor(R.color.boot_track))
                    }, LinearLayout.LayoutParams(0, dpx(1f), 1f).also {
                        it.marginStart = dpx(7f)
                        it.marginEnd = dpx(7f)
                    })
                }
                val cell = LinearLayout(this@BootstrapActivity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                }
                val marker = TextView(this@BootstrapActivity).apply {
                    gravity = Gravity.CENTER
                    textSize = 10f
                    minWidth = dpx(17f)
                    minHeight = dpx(17f)
                    background = circleBg(R.color.boot_step_idle_bg)
                    setTextColor(getColor(R.color.boot_step_idle_text))
                }
                val stepLabel = TextView(this@BootstrapActivity).apply {
                    text = getString(res)
                    textSize = 11f
                    setTextColor(getColor(R.color.boot_text_muted))
                    setPadding(dpx(5f), 0, 0, 0)
                }
                cell.addView(marker)
                cell.addView(stepLabel)
                stepsRow.addView(cell)
                markerViews += marker
                labelViews += stepLabel
            }
        stepMarkers = markerViews
        stepLabels = labelViews
        panel.addView(stepsRow, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also { it.topMargin = dpx(15f) })

        // 动作区：失败（修复/重试/诊断）与修复完成（撤销/进入）共用一行
        actionsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            visibility = View.GONE
        }
        repairButton = Button(this).apply {
            text = getString(R.string.boot_repair)
            styleAction(this, primary = true)
            setOnClickListener { repair() }
        }
        retryButton = Button(this).apply {
            text = getString(R.string.boot_retry)
            styleAction(this, primary = false)
            setOnClickListener { retry() }
        }
        diagnoseButton = Button(this).apply {
            text = getString(R.string.rescue_entry)
            styleAction(this, primary = false)
            setOnClickListener { openRescueSheet() }
        }
        undoButton = Button(this).apply {
            text = getString(R.string.diag_undo)
            styleAction(this, primary = false)
            setOnClickListener { undoLatest() }
        }
        enterButton = Button(this).apply {
            text = getString(R.string.boot_enter)
            styleAction(this, primary = true)
            setOnClickListener { enterMain() }
        }
        for (button in listOf(repairButton, retryButton, diagnoseButton, undoButton, enterButton)) {
            actionsRow.addView(button, LinearLayout.LayoutParams(0, dpx(40f), 1f).also {
                it.marginStart = dpx(4f)
                it.marginEnd = dpx(4f)
            })
        }
        panel.addView(actionsRow, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also {
            it.topMargin = dpx(14f)
            it.marginStart = -dpx(4f)
            it.marginEnd = -dpx(4f)
        })

        return content
    }

    private fun buildFooter(): ViewGroup {
        val footer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dpx(24f), dpx(14f), dpx(24f), dpx(20f))
        }
        footerView = TextView(this).apply {
            setTextColor(getColor(R.color.boot_text_muted))
            textSize = 11f
            gravity = Gravity.CENTER
            setLineSpacing(0f, 1.8f)
        }
        footer.addView(footerView)
        footer.addView(View(this).apply {
            background = GradientDrawable().apply {
                cornerRadius = dpx(2f).toFloat()
                setColor(getColor(R.color.boot_home_bar))
            }
        }, LinearLayout.LayoutParams(dpx(88f), dpx(4f)).also { it.topMargin = dpx(16f) })
        return footer
    }

    private fun bubble(hero: FrameLayout, sizeDp: Int, left: Int = -1, right: Int = -1, top: Int) {
        val view = View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0x10FFFFFF)
                setStroke(dpx(1f), getColor(R.color.boot_bubble_stroke))
            }
        }
        val params = FrameLayout.LayoutParams(dpx(sizeDp.toFloat()), dpx(sizeDp.toFloat())).also {
            if (left >= 0) it.leftMargin = dpx(left.toFloat()) else it.rightMargin = dpx(right.toFloat())
            it.topMargin = dpx(top.toFloat())
            it.gravity = if (left >= 0) Gravity.START else Gravity.END
        }
        hero.addView(view, params)
    }

    /** 按百分比落位进度填充；track 还没量出宽度时等下一次布局重放。 */
    private fun applyFill(pct: Int) {
        lastFillPct = pct.coerceIn(0, 100)
        val width = track.width
        if (width <= 0) {
            track.post { applyFill(lastFillPct) }
            return
        }
        val target = (width * lastFillPct / 100).coerceIn(dpx(6f), width)
        val params = trackFill.layoutParams as FrameLayout.LayoutParams
        if (params.width != target) {
            params.width = target
            trackFill.requestLayout()
        }
    }

    /** 待机时让鲸鱼轻轻上下浮动；系统动画时长被关到 0 时保持静止。 */
    private fun startWhaleFloat() {
        val scale = Settings.Global.getFloat(
            contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f,
        )
        if (scale == 0f) return
        if (floatAnimator?.isRunning == true) return
        floatAnimator = ObjectAnimator.ofFloat(
            whaleView, View.TRANSLATION_Y, 0f, -dpx(7f).toFloat(),
        ).apply {
            duration = 2600
            repeatCount = ObjectAnimator.INFINITE
            repeatMode = ObjectAnimator.REVERSE
            interpolator = AccelerateDecelerateInterpolator()
            start()
        }
    }

    /** 终态（就绪 / 失败）时让鲸鱼停下来：成功抬头，失败回正。 */
    private fun settleWhale(ok: Boolean) {
        floatAnimator?.cancel()
        whaleView.animate()
            .rotation(if (ok) 1f else -2f)
            .translationY(if (ok) -dpx(5f).toFloat() else 0f)
            .setDuration(350)
            .start()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(EXTRA_RESCUE, rescueMode || operationBusy)
        outState.putBoolean("rescue.repaired", repairedInThisRun)
        outState.putBoolean("rescue.undoable", lastRepairUndoable)
        outState.putStringArrayList("rescue.changes", ArrayList(lastRepairChanges))
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        stateJob?.cancel()
        workJob?.cancel()
        floatAnimator?.cancel()
        currentDialog?.dismiss()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "KxxyBootstrap"
        const val EXTRA_RESCUE = "kxxy.rescue"
        const val EXTRA_RESCUE_REASON = "kxxy.rescue.reason"
        private const val SAVE_REPORT_REQUEST = 7301
    }
}
