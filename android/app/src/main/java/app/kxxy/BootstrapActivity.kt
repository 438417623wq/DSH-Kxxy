package app.kxxy

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.app.Activity
import app.kxxy.engine.EngineSupervisor
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
 * 职责（对应方案 T 的 T0 验收）：
 *   ① WebView 版本门禁（< Chrome 85 明确提示而非白屏）
 *   ② 解压 runtime.zip（显示确定性进度）
 *   ③ 启动 EngineService
 *   ④ 轮询直到引擎 Healthy，然后跳 MainActivity
 *
 * 界面刻意用代码构造而非 XML 布局 —— 只有十来个控件，且方案 T 的
 * 设计原则是把 UI 尽量留给 Web 层（可删 12 个 layout XML）。
 */
class BootstrapActivity : Activity() {

    private val app get() = application as KxxyApp
    private val supervisor: EngineSupervisor get() = app.supervisor

    private lateinit var titleView: TextView
    private lateinit var statusView: TextView
    private lateinit var hintView: TextView
    private lateinit var progress: ProgressBar
    private lateinit var retryButton: Button

    private var stateJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())

        // ① WebView 版本门禁
        if (!WebViewGate.isSupported(this)) {
            statusView.text = getString(R.string.boot_webview_too_old)
            retryButton.visibility = Button.VISIBLE
            retryButton.setOnClickListener { finishAffinity() }
            return
        }

        // ③ 启动前台服务（它内部会驱动 supervisor）
        EngineService.start(this)

        // ④ 观察状态，Healthy 后跳主界面
        stateJob = app.appScope.launch {
            supervisor.state.collectLatest { render(it) }
        }
    }

    private fun render(state: EngineSupervisor.State) {
        runOnUiThread {
            when (state) {
                is EngineSupervisor.State.Idle -> {
                    statusView.text = getString(R.string.boot_checking)
                    progress.visibility = ProgressBar.GONE
                    retryButton.visibility = Button.GONE
                }
                is EngineSupervisor.State.Installing -> {
                    statusView.text = getString(R.string.boot_installing)
                    progress.visibility = ProgressBar.VISIBLE
                    progress.isIndeterminate = false
                    progress.progress = (state.progress * 100).toInt()
                    retryButton.visibility = Button.GONE
                }
                is EngineSupervisor.State.Starting -> {
                    statusView.text = getString(R.string.boot_starting)
                    progress.visibility = ProgressBar.VISIBLE
                    progress.isIndeterminate = true
                    retryButton.visibility = Button.GONE
                }
                is EngineSupervisor.State.Healthy -> {
                    statusView.text = getString(R.string.boot_waiting)
                    progress.visibility = ProgressBar.VISIBLE
                    progress.isIndeterminate = true
                    Log.i(TAG, "engine healthy, entering MainActivity (tokenUrl=${state.tokenUrl != null})")
                    startActivity(Intent(this, MainActivity::class.java))
                    finish()
                }
                is EngineSupervisor.State.Backoff -> {
                    statusView.text = getString(
                        R.string.status_backoff, state.delayMs / 1000, state.attempt
                    )
                    progress.visibility = ProgressBar.VISIBLE
                    progress.isIndeterminate = true
                    retryButton.visibility = Button.GONE
                }
                is EngineSupervisor.State.Failed -> {
                    statusView.text = "${getString(R.string.boot_failed)}：${state.reason}"
                    progress.visibility = ProgressBar.GONE
                    retryButton.visibility = Button.VISIBLE
                }
                is EngineSupervisor.State.Stopped -> {
                    statusView.text = getString(R.string.status_idle)
                    progress.visibility = ProgressBar.GONE
                    retryButton.visibility = Button.VISIBLE
                }
            }
        }
    }

    private fun buildUi(): ViewGroup {
        val dp = resources.displayMetrics.density
        fun d(v: Int) = (v * dp).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xFF0B0D13.toInt())
            setPadding(d(32), d(32), d(32), d(32))
        }

        titleView = TextView(this).apply {
            text = getString(R.string.boot_title)
            setTextColor(0xFFF0F3F8.toInt())
            textSize = 26f
            gravity = Gravity.CENTER
        }

        statusView = TextView(this).apply {
            text = getString(R.string.boot_checking)
            setTextColor(0xFF9DA7B8.toInt())
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

        hintView = TextView(this).apply {
            text = getString(R.string.boot_hint)
            setTextColor(0xFF5C6577.toInt())
            textSize = 11f
            gravity = Gravity.CENTER
            setPadding(0, d(20), 0, 0)
        }

        retryButton = Button(this).apply {
            text = getString(R.string.boot_retry)
            visibility = Button.GONE
            setOnClickListener {
                retryButton.visibility = Button.GONE
                supervisor.restart()
            }
        }

        root.addView(titleView)
        root.addView(statusView)
        root.addView(progress)
        root.addView(retryButton)
        root.addView(hintView)
        return root
    }

    override fun onDestroy() {
        stateJob?.cancel()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "KxxyBootstrap"
    }
}
