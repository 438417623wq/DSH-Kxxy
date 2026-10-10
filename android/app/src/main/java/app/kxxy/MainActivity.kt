package app.kxxy

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import app.kxxy.engine.EngineConfig
import app.kxxy.engine.EngineSupervisor
import app.kxxy.service.EngineService
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * 主界面 —— 纯 WebView 容器。
 *
 * 方案 T 的核心：**全部 UI 都在 Web 层**。
 *   `/`      → 官方 React 前端（对话 + 86 个插槽 + 插件生态）
 *   `/kxxy`  → 自研宿主管理页（由 kxxy-host Cordis 插件注册的路由）
 *
 * 本 Activity 只负责三件事：
 *   ① 把 WebView 铺满屏幕
 *   ② 加载带 token 的官方 URL（token 从引擎日志提取）
 *   ③ 注入方案 R 的移动端适配层
 *
 * 刻意不做的事：
 *   - 不构造任何原生控件（除了 WebView 本身）
 *   - 不实现任何业务 UI（设置页、扩展中心、终端都在 Web 层）
 *   - 不拦截 URL（除非是外部链接）
 */
class MainActivity : Activity() {

    private val app get() = application as KxxyApp
    private val supervisor: EngineSupervisor get() = app.supervisor

    private lateinit var webView: WebView

    @Volatile
    private var urlLoaded = false

    private var stateJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(
            FrameLayout(this).apply {
                setBackgroundColor(0xFF0B0D13.toInt())
                addView(
                    webView,
                    FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    ),
                )
            }
        )

        setupWebView()
        EngineService.start(this)

        // 引擎可能还在启动：订阅状态，Healthy 后加载
        val current = supervisor.state.value
        if (current is EngineSupervisor.State.Healthy) {
            loadEngineUrl(current.tokenUrl)
        } else {
            stateJob = app.appScope.launch {
                supervisor.state.collectLatest { st ->
                    if (st is EngineSupervisor.State.Healthy && !urlLoaded) {
                        loadEngineUrl(st.tokenUrl)
                    }
                }
            }
        }
    }

    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // 官方前端用 ES module + fetch，需要允许混合内容（本地 http）
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            // 本地回环不需要 file 访问，收紧攻击面
            allowFileAccess = false
            allowContentAccess = false
            // 视口交给前端自己控制（官方 index.html 已有 viewport meta）
            useWideViewPort = true
            loadWithOverviewMode = false
            // 缓存策略：引擎重启后前端资源未变，允许缓存以加速
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        // 诊断：把 console 消息与资源错误转发到 logcat，
        // 便于在用户设备上定位白屏（参考项目 v1.2.49 的做法）。
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                Log.d(TAG, "console/${msg.messageLevel()} ${msg.sourceId()}:${msg.lineNumber()} ${msg.message()}")
                return true
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url.toString()
                // 只放行回环地址；其余交给系统浏览器
                if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) {
                    return false
                }
                Log.i(TAG, "external url intercepted: $url")
                runCatching {
                    startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, request.url))
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                Log.i(TAG, "page finished: $url")
                // 方案 R：注入移动端适配层（触控尺寸 / 输入框字号 / safe-area / 去 hover）
                AdaptLayer.inject(view)
            }
        }
    }

    /**
     * 加载引擎 URL。
     *
     * token 来自引擎日志（`dsh web: http://127.0.0.1:3080/?token=…`）。
     * 若提取失败则退化为不带 token 加载 —— 官方前端会返回 401 并触发
     * 一次重定向，用户在界面上重新扫码/授权即可，比白屏好。
     */
    private fun loadEngineUrl(tokenUrl: String?) {
        if (urlLoaded) return
        urlLoaded = true

        val target = tokenUrl ?: "http://127.0.0.1:${EngineConfig.DEFAULT_PORT}/"
        Log.i(TAG, "loading engine url: ${target.take(64)}…")
        webView.loadUrl(target)
    }

    /** 恢复 WebView 的 JS 定时器。
     *
     * Android 在 Activity 进入后台时会**冻结 WebView 的 JS 定时器**。
     * 官方前端靠定时器轮询驱动流式渲染，冻结后「后台期间 AI 的回复刷不出来，
     * 切回前台才响应」。进程本身已由前台服务保活，所以这里保持 WebView 活跃。
     * 代价：后台仍会消耗少量 CPU。
     */
    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            runCatching { webView.onResume() }
            runCatching { webView.resumeTimers() }
        }
    }

    override fun onPause() {
        super.onPause()
        // 刻意不调用 super.onPause() 里的 WebView 暂停逻辑，同时显式 resumeTimers
        if (::webView.isInitialized) {
            runCatching { webView.resumeTimers() }
        }
    }

    override fun onDestroy() {
        stateJob?.cancel()
        if (::webView.isInitialized) {
            runCatching {
                (webView.parent as? ViewGroup)?.removeView(webView)
                webView.destroy()
            }
        }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "KxxyMain"
    }
}
