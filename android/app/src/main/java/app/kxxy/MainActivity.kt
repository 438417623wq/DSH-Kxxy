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
import app.kxxy.engine.ShizukuBridge
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

    /** 当前页面路径（onPageFinished + onDoUpdateVisitedHistory 双钩子维护）。 */
    @Volatile
    private var currentPath: String? = null

    /** 上一次按返回键的时刻（宿主页双击退出的判定窗口用）。 */
    private var lastBackAt = 0L

    /**
     * 进行中的文件选择回调。
     *
     * WebView 的 `<input type="file">`（官方前端的上传图片/上传附件/+ 菜单的
     * 「文件」全走它）必须由 onShowFileChooser 接手，否则点击静默失效。
     * 回调必须持有成字段：选择器跨 startActivityForResult 存活；且每条路径
     * （收到结果 / 用户取消 / Activity 销毁）都要回掉一次 —— 不回掉的话
     * WebView 认为还有一个悬空 chooser，之后所有点击都不再弹窗（经典坑）。
     */
    private var filePathCallback: android.webkit.ValueCallback<Array<android.net.Uri>>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(
            FrameLayout(this).apply {
                // 跟随系统深浅色：原先硬编码深色，浅色主题下会在 WebView
                // 首次绘制前闪一块深底。取值见 res/values{,-night}/colors.xml。
                setBackgroundColor(getColor(R.color.kxxy_window_bg))
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

            /**
             * 文件选择器：官方前端的 `<input type="file">` 全靠它才有反应。
             * createIntent() 会带上 accept 类型与多选标记，落到 DocumentsUI
             * （系统文件管理器/相册）。任何失败路径都必须回 null，见字段注释。
             */
            override fun onShowFileChooser(
                webView: WebView,
                callback: android.webkit.ValueCallback<Array<android.net.Uri>>,
                params: FileChooserParams,
            ): Boolean {
                // 上一次选择还没回来又点了一次：先把旧的作废，避免 WebView 卡死
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback

                val intent = params.createIntent().apply {
                    addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                return try {
                    startActivityForResult(intent, REQUEST_FILE_CHOOSER)
                    true
                } catch (e: android.content.ActivityNotFoundException) {
                    Log.w(TAG, "no activity for file chooser: ${e.message}")
                    filePathCallback = null
                    callback.onReceiveValue(null)
                    false
                }
            }
        }

        // 浏览器下载：官方「下载日志 export」等产生的 ZIP 是普通下载链接，
        // WebView 默认静默丢弃。交给系统 DownloadManager（自带通知与断点，
        // 写公共下载目录不需要应用自身持有存储权限）。
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            handleDownload(url, userAgent, contentDisposition, mimeType)
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url.toString()
                // 宿主内建桥：kxxy://perm/request?name=…（设置页权限卡片）
                if (request.url.scheme == "kxxy") {
                    return handlePermissionBridge(request.url)
                }
                // 子框架一律放行。右侧栏「工作区文件」的 HTML 预览是宿主拼出
                // bootstrap 文档、createObjectURL 成 blob: 再塞进 iframe ——
                // 它属于子框架导航，一旦被当外链丢给系统，预览区就只剩空白，
                // 而 logcat 里只有一行 "external url intercepted: blob:…"。
                // 外链拦截的本意只针对「用户点击链接离开应用」，那必然是主框架。
                if (!request.isForMainFrame) {
                    return false
                }
                // 页面内联资源（图片/字体/媒体）与 blob/data 文档不走网络请求，
                // 但少数路径仍会经过这里，同样必须放行。
                when (request.url.scheme) {
                    "blob", "data", "about", "javascript" -> return false
                }
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
                currentPath = pathOf(url)
            }

            /**
             * SPA 路由变化的捕获点：官方前端是 React 单页应用，
             * 站内跳转不触发 onPageFinished，只触发本回调。
             * （注意方法名没有 on 前缀 —— WebViewClient 的历史遗留命名。）
             */
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                super.doUpdateVisitedHistory(view, url, isReload)
                if (url != null) currentPath = pathOf(url)
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_FILE_CHOOSER) return
        val callback = filePathCallback
        filePathCallback = null
        // 不能直接用 FileChooserParams.parseResult：它只读 data.getData()，
        // 而系统 Photo Picker / HyperOS 文件选择器返回的是 ClipData-only 结果
        // （getData()==null），会被解析成 null ⇒ WebView 当成「用户取消」，
        // <input type=file> 的 change 永不触发，附件永远加不上。见缺陷 BD。
        callback?.onReceiveValue(fileChooserResult(resultCode, data))
    }

    /**
     * 文件选择结果的兜底解析（缺陷 BD）。
     *
     * 官方 `FileChooserParams.parseResult` 的实现只认 `Intent.getData()`：
     *   - DocumentsUI 单选 → `setData(uri)`，能拿到；
     *   - 系统 Photo Picker（`PhotoPickerGetContentActivity`）与部分 OEM
     *     文件选择器 → 只 `setClipData(...)`，`getData()` 是 null ⇒ 解析出 null。
     * 新版 WebView（Chromium 110+）客户端收到 null 就按「用户取消」处理，
     * 于是 `input[type=file]` 的 `change` 不触发；WebView 104 这类老版本
     * 自己还有 ClipData 分支，所以旧机型上看不出问题——这正是
     * 「Android 13 能加、Android 16 加不上」的版本分化来源。
     *
     * 解析顺序：ClipData 全部条目 → `getData()` 兜底；取消返回 null。
     */
    private fun fileChooserResult(resultCode: Int, data: android.content.Intent?): Array<android.net.Uri>? {
        if (resultCode == Activity.RESULT_CANCELED) return null
        val picked = ArrayList<android.net.Uri>()
        val clip = data?.clipData
        if (clip != null) {
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i).uri?.let { picked.add(it) }
            }
        }
        if (picked.isEmpty()) {
            val single = data?.data ?: return null
            picked.add(single)
        }
        Log.i(TAG, "file chooser result: ${picked.size} uri(s) ${picked.joinToString()}")
        return picked.toTypedArray()
    }

    /**
     * 下载处理：交给系统 DownloadManager（系统组件写公共下载目录不需要本应用
     * 持有存储权限，且自带完成通知）。文件名优先取 content-disposition，
     * 其次 URL 路径；统一落 Download/kxxy/，与导出日志的位置约定一致。
     */
    private fun handleDownload(url: String, userAgent: String, contentDisposition: String?, mimeType: String?) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            runCatching { startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
            return
        }
        runCatching {
            // 文件名：content-disposition 的 filename= → URL 末段 → 时间戳兜底
            val fromDisposition = contentDisposition
                ?.let { Regex("filename\\*?=(?:UTF-8'')?\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(it)?.groupValues?.get(1) }
            val fromUrl = android.net.Uri.parse(url).lastPathSegment
            val name = (fromDisposition ?: fromUrl ?: "kxxy-download.bin")
                .takeIf { it.isNotBlank() }
                ?: "kxxy-download.bin"

            val req = android.app.DownloadManager.Request(android.net.Uri.parse(url)).apply {
                setTitle(name)
                setDescription(getString(R.string.download_notification_description))
                mimeType?.let { setMimeType(it) }
                addRequestHeader("User-Agent", userAgent)
                // 引擎在同源 cookie 里放行鉴权；带 cookie 才能拿到需要登录的资源
                runCatching { addRequestHeader("Cookie", android.webkit.CookieManager.getInstance().getCookie(url) ?: "") }
                setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(
                    android.os.Environment.DIRECTORY_DOWNLOADS,
                    "kxxy/$name",
                )
            }
            val dm = getSystemService(android.app.DownloadManager::class.java)
            dm.enqueue(req)
            Log.i(TAG, "download enqueued: $name")
        }.onFailure { Log.w(TAG, "download failed: ${it.message}") }
    }

    /**
     * `kxxy://perm/request?name=…` 桥（设置页「系统权限」卡片触发）。
     *
     * 权限请求必须由 Activity 发起，而设置页跑在 WebView 里 —— 复用
     * shouldOverrideUrlLoading 的拦截点，自定义 scheme 在进入「外链转系统
     * 浏览器」分支之前处理。状态回显走 kxxy-state.json（原生心跳在写），
     * 页面轮询 /kxxy/api/state 自然可见。
     */
    private fun handlePermissionBridge(uri: android.net.Uri): Boolean {
        val name = uri.getQueryParameter("name") ?: return true
        Log.i(TAG, "permission bridge: $name")
        when (name) {
            "notifications" -> {
                if (android.os.Build.VERSION.SDK_INT >= 33) {
                    requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), REQ_PERM_NOTIFICATIONS)
                }
            }
            "all-files" -> {
                // Android 11+ 的「所有文件访问」必须去系统设置页，应用内弹不出来
                val intent = try {
                    android.content.Intent(
                        android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        android.net.Uri.parse("package:$packageName"),
                    )
                } catch (_: Exception) {
                    android.content.Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                }
                runCatching { startActivity(intent) }
            }
            "battery" -> {
                val intent = android.content.Intent(
                    android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    android.net.Uri.parse("package:$packageName"),
                )
                runCatching { startActivity(intent) }
                    .onFailure { Log.w(TAG, "battery intent failed: ${it.message}") }
            }
            "storage" -> {
                if (android.os.Build.VERSION.SDK_INT <= 29) {
                    requestPermissions(arrayOf(android.Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_PERM_STORAGE)
                }
            }
            "shizuku" -> {
                // Shizuku 的授权不是系统权限对话框，而是 Shizuku 自己的界面：
                // 由 Shizuku server 弹出，结果经 addRequestPermissionResultListener
                // 回到 ShizukuBridge（见 ShizukuBridge.init）。
                val ok = ShizukuBridge.requestPermission()
                if (!ok) {
                    Log.w(TAG, "shizuku permission request rejected (binder not ready)")
                }
            }
        }
        return true
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // 结果不需要主动回传：权限状态由 publishState 写进 kxxy-state.json，
        // 管理页轮询 /kxxy/api/state 数秒内自动刷新。
        Log.i(TAG, "permission result: req=$requestCode grants=${grantResults.joinToString()}")
    }

    /**
     * 系统返回键路由（五项改进方案 §5）。
     *
     * 现状是完全没有返回键处理 —— 系统默认行为 = finish() 直接退出。
     * 用 [onBackPressed] 而非 OnBackInvokedCallback：本项目 targetSdk = 28，
     * 后者是 API 33+ 且需要 manifest 开关，在 targetSdk 28 上根本不会被调用；
     * Android 10+ 的返回手势最终仍以 KEYCODE_BACK 派发到本方法。
     *
     * 路由规则：
     *   官方对话页（/ 及其子路径）→ 进入宿主管理页 /kxxy
     *   宿主管理页（/kxxy）       → 回对话页；2 秒内再按一次 → 退出
     */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (!urlLoaded || !::webView.isInitialized) {
            super.onBackPressed()
            return
        }
        val path = currentPath
        if (path != null && path.startsWith("/kxxy")) {
            val now = System.currentTimeMillis()
            if (now - lastBackAt < EXIT_CONFIRM_WINDOW_MS) {
                finish()
                return
            }
            lastBackAt = now
            webView.loadUrl("http://127.0.0.1:${EngineConfig.DEFAULT_PORT}/")
        } else {
            webView.loadUrl("http://127.0.0.1:${EngineConfig.DEFAULT_PORT}/kxxy")
        }
    }

    private fun pathOf(url: String): String? =
        runCatching { android.net.Uri.parse(url).path }.getOrNull()

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
        // 悬空的文件选择回调会让 WebView 之后所有 input 点击静默失效
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
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

        /** 宿主页上判定「双击退出」的按键窗口。 */
        private const val EXIT_CONFIRM_WINDOW_MS = 2_000L

        private const val REQUEST_FILE_CHOOSER = 4201
        private const val REQ_PERM_NOTIFICATIONS = 4202
        private const val REQ_PERM_STORAGE = 4203
    }
}
