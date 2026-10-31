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
import app.kxxy.engine.PermCatalog
import app.kxxy.engine.ShizukuBridge
import app.kxxy.engine.WebBootLog
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

    /**
     * 挂起的网页媒体权限请求（相机 / 麦克风）。
     *
     * `onPermissionRequest` 是**必须立刻作答**的回调：系统对话框要跨
     * `requestPermissions` 存活，所以先把 request 存在这里，等
     * [onRequestPermissionsResult] 拿到结果再 grant/deny。
     * 反复创建必须先把旧的 deny 掉，否则 WebView 里那条 request 永远悬空
     * （网页的 Promise 不 resolve，语音输入按钮一直转圈）。
     */
    private var pendingWebPermission: android.webkit.PermissionRequest? = null



    /**
     * 待投递的 attention 目标。
     *
     * 用户点通知时应用可能还在冷启动（WebView 一个字都没加载），此时调用
     * evaluateJavascript 会静默失败。所以先把意图存下来，等 `onPageFinished`
     * 再送 —— 这也是「点了通知却停在首页」这个 bug 的根因。
     */
    private var pendingAttentionId: String? = null
    private var pendingSessionId: String? = null

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

        // 冷启动时带过来的 attention 意图（用户点了通知栏里的「需要你确认」）。
        // 此时 WebView 还没开始加载，所以只会存进 pending，由 onPageFinished 消费。
        handleLaunchIntent(intent)
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
                // 体检只看得见磁盘，看不见浏览器 —— 而「装了插件后进不去页面」
                // 只发生在浏览器侧（前端 boot 阶段整页替换成 Failed to load
                // plugins，引擎本身活着）。这里把那条错误落盘，体检才可能报出来。
                WebBootLog.record(this@MainActivity, msg.message(), msg.sourceId(), msg.lineNumber())
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

            /**
             * 网页侧媒体权限（`getUserMedia` / `MediaRecorder` / `<input capture>`）。
             *
             * 为什么必须有这个回调：WebView 的默认实现是**一律拒绝**且不弹任何
             * 提示 —— 网页侧看到的是 `NotAllowedError: Permission denied`，
             * 而系统层根本没被问过。也就是说，光在清单里声明 CAMERA /
             * RECORD_AUDIO、光在设置里授权，网页仍然用不了摄像头：
             * 必须由 Activity 在 onPermissionRequest 里显式 grant。
             *
             * 授权范围刻意收窄到「本机回环页面 + 相机/麦克风两类资源」：
             * 官方前端与宿主管理页同源运行在 127.0.0.1，除此之外的来源
             * （含远程页面、file:）一律 deny，避免这套桥被做成通用提权口。
             */
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                handleWebPermissionRequest(request)
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
                //             kxxy://open?url=…（兼容层的 window.open 桥，见 handleOpenBridge）
                if (request.url.scheme == "kxxy") {
                    if (request.url.host == "open") return handleOpenBridge(request.url)
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
                // 页面就绪后立刻把挂起的 attention 意图送进去（冷启动路径）。
                flushPendingAttention()
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
     * `kxxy://open?url=…` 桥（缺陷 DF，登录白屏）。
     *
     * 背景见 `plugins/kxxy-host/web/compat.js` 的 `installWindowOpenBridge`：
     * 本宿主没有多窗口 WebView，官方账号登录的 `window.open('about:blank')`
     * 会把主框架导航成空白页。兼容层把这类调用改写成这条桥，由原生层交给
     * 系统浏览器打开 —— 与 Desktop 版 `platform-login` 的
     * `action: "open", external: true` 同义。
     *
     * 只接受 http/https：`file:` / `intent:` / `content:` 会被系统当成任意
     * 组件调用，等于把「打开一个网页」放大成「拉起任意应用」。
     */
    private fun handleOpenBridge(uri: android.net.Uri): Boolean {
        val raw = uri.getQueryParameter("url") ?: return true
        val target = runCatching { android.net.Uri.parse(raw) }.getOrNull() ?: return true
        val scheme = target.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            Log.w(TAG, "open bridge rejected scheme: $scheme")
            return true
        }
        Log.i(TAG, "open bridge: ${raw.take(120)}")
        runCatching {
            startActivity(
                android.content.Intent(android.content.Intent.ACTION_VIEW, target)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }.onFailure { Log.w(TAG, "open bridge failed: ${it.message}") }
        return true
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
                } else {
                    openNotificationSettings()
                }
            }
            "notification-channels" -> {
                // 「应用通知已允许，但『需要你确认』这条渠道被单独静音」是
                // 最容易被误判成「引擎坏了」的一种状态 —— 应用级开关是开的，
                // 权限也都授予了，可最重要的通知就是不响。这种情况必须把用户
                // 直接送到**渠道列表**，而不是笼统的应用通知页。
                openNotificationSettings()
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
            // 一键授予：所有「清单里声明过、还没授予」的运行时权限，一次问完。
            // 系统会按权限组依次弹框（相机 → 麦克风 → 短信 → 媒体…），
            // 逐个框而不是合并成一个，所以文案里不能承诺「只弹一次」。
            "all" -> requestRuntimeGroup(PermCatalog.missingRuntime(this).toTypedArray(), REQ_PERM_ALL)
            else -> {
                // 其余全部走权限目录：id 就是 PermCatalog 的条目名
                // （camera / microphone / media / sms / overlay / battery / …）。
                // 新增权限项时只需要改 PermCatalog + 清单，这里不用动。
                val entry = PermCatalog.find(name)
                if (entry == null) {
                    Log.w(TAG, "permission bridge: unknown entry $name")
                } else {
                    dispatchCatalogEntry(entry)
                }
            }
        }
        return true
    }

    /**
     * 按权限条目的类别分派到正确的申请路径。
     *
     * 这是整条链上最容易做错的一步：把特殊权限当成运行时权限去申请，
     * 系统不会有任何反应（没有对话框、也没有回调），用户只会觉得
     * 「这个按钮是假的」。所以四类必须分开：
     *
     *   RUNTIME  → 系统对话框
     *   SPECIAL  → 对应的 Settings 页
     *   NAVIGATE → 厂商安全中心（MIUI/HyperOS 的锁屏显示、后台弹出等）
     *   NORMAL   → 安装即授予，应用内无从修改，送到应用详情页让用户自己看
     */
    private fun dispatchCatalogEntry(entry: PermCatalog.Entry) {
        when (entry.kind) {
            PermCatalog.Kind.RUNTIME -> requestRuntimeGroup(
                entry.perms.filter { PermCatalog.isDeclared(this, it) && !hasPermission(it) }.toTypedArray(),
                REQ_PERM_MEDIA,
            )
            PermCatalog.Kind.SPECIAL -> openSpecialPermission(entry.id)
            PermCatalog.Kind.NAVIGATE -> if (entry.id == "miui_perms") openVendorPermissionEditor() else openAppSettings()
            PermCatalog.Kind.NORMAL -> openAppSettings()
        }
    }

    /** 特殊权限：每一条都得用各自的 Settings action，且都有版本门槛。 */
    private fun openSpecialPermission(id: String) {
        when (id) {
            "all_files" -> {
                // Android 11+ 起「所有文件访问」只能去系统页开
                val intent = try {
                    android.content.Intent(
                        android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        android.net.Uri.parse("package:$packageName"),
                    )
                } catch (_: Exception) {
                    android.content.Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                }
                runCatching { startActivity(intent) }
                    .onFailure { openAppSettings() }
            }
            "overlay" -> {
                // 悬浮窗：部分 ROM（含 MIUI）会把这个 action 吃掉，兜底走应用详情页
                runCatching {
                    startActivity(
                        android.content.Intent(
                            android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            android.net.Uri.parse("package:$packageName"),
                        ),
                    )
                }.onFailure { openAppSettings() }
            }
            "battery" -> {
                runCatching {
                    startActivity(
                        android.content.Intent(
                            android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            android.net.Uri.parse("package:$packageName"),
                        ),
                    )
                }.onFailure {
                    Log.w(TAG, "battery intent failed: ${it.message}")
                    openAppSettings()
                }
            }
            "install_unknown" -> {
                // Android 8.0+ 的「安装未知应用」是按应用授权的
                runCatching {
                    startActivity(
                        android.content.Intent(
                            android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            android.net.Uri.parse("package:$packageName"),
                        ),
                    )
                }.onFailure { openAppSettings() }
            }
            else -> openAppSettings()
        }
    }

    /**
     * MIUI / HyperOS 安全中心的「应用权限管理」页。
     *
     * 为什么需要它：截图里那些「锁屏显示」「后台弹出界面」「链式启动管理」
     * 「动态壁纸服务」**没有对应的 Android 权限**，是厂商安全中心自己加的
     * 开关，manifest 里声明不出来、requestPermissions 也唤不起。唯一可行的
     * 路径是厂商私有 action（小米系沿用多年），失败就退到应用详情页 ——
     * 那条路任何 ROM 都有，只是用户要多点两下。
     */
    private fun openVendorPermissionEditor() {
        val candidates = listOf(
            android.content.Intent("miui.intent.action.APP_PERM_EDITOR").apply {
                setClassName(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.permissions.PermissionsEditorActivity",
                )
                putExtra("extra_pkgname", packageName)
            },
            android.content.Intent("miui.intent.action.APP_PERM_EDITOR").apply {
                putExtra("extra_pkgname", packageName)
            },
        )
        for (intent in candidates) {
            if (runCatching { startActivity(intent) }.isSuccess) return
        }
        Log.i(TAG, "vendor permission editor unavailable, falling back to app settings")
        openAppSettings()
    }

    /** 应用详情页 —— 所有权限路径的最终兜底。 */
    private fun openAppSettings() {
        // 权限被拒两次后系统进入「不再询问」：之后 requestPermissions
        // 连对话框都不弹，回调里直接就是 DENIED —— 用户只会看到
        // 「点了没反应」。唯一出口是应用详情页，那里能手动开。
        runCatching {
            startActivity(
                android.content.Intent(
                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.parse("package:$packageName"),
                ),
            )
        }.onFailure { Log.w(TAG, "app settings intent failed: ${it.message}") }
    }

    /**
     * 请求一组运行时权限，**已授予的直接跳过**。
     *
     * 为什么要过滤：`requestPermissions` 里带上一个已授予的权限，系统仍然会
     * 把它塞进结果数组，但对话框上不会出现对应条目 —— 用户点「一键授予」
     * 后看到只有一个框，会以为剩下的没生效。滤掉已授予的之后，空数组这条
     * 路径直接返回（什么都不弹），由状态轮询把界面刷成已授权。
     */
    private fun requestRuntimeGroup(permissions: Array<String>, requestCode: Int) {
        val missing = permissions.filterNot { hasPermission(it) }
        if (missing.isEmpty()) {
            Log.i(TAG, "runtime group already granted: ${permissions.joinToString()}")
            return
        }
        runCatching { requestPermissions(missing.toTypedArray(), requestCode) }
            .onFailure { Log.w(TAG, "requestPermissions failed: ${it.message}") }
    }

    /** 单条权限的当前授予状态（不做缓存：用户随时可能在系统设置里收回）。 */
    private fun hasPermission(permission: String): Boolean = PermCatalog.isGranted(this, permission)

    /**
     * 处理网页侧的媒体权限请求（[WebChromeClient.onPermissionRequest] 的实体）。
     *
     * 三种情况：
     *   ① 来源不是本机回环页 → deny（这套桥只服务自家页面）；
     *   ② 请求里没有相机/麦克风 → deny（受保护媒体等资源本宿主不支持）；
     *   ③ 清单权限已授予 → 立刻 grant；
     *      未授予 → 先弹系统对话框，把 request 挂起，回执到了再作答。
     *
     * 注意 grant 的参数只放**已授予**的那部分：用户只批了麦克风时，
     * 把 CAMERA 一起塞进 grant 会让 WebView 认为相机也被允许，之后
     * `getUserMedia({video:true})` 抛的是底层 CameraService 的
     * SecurityException（闪退级），而不是可捕获的 NotAllowedError。
     */
    private fun handleWebPermissionRequest(request: android.webkit.PermissionRequest) {
        val origin = request.origin?.toString().orEmpty()
        if (!origin.startsWith("http://127.0.0.1:") && !origin.startsWith("http://localhost:")) {
            Log.w(TAG, "web permission denied for origin: $origin")
            runCatching { request.deny() }
            return
        }

        val wanted = request.resources.filter {
            it == android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE ||
                it == android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE
        }
        if (wanted.isEmpty()) {
            Log.i(TAG, "web permission: no supported resource in ${request.resources.joinToString()}")
            runCatching { request.deny() }
            return
        }

        val needed = LinkedHashSet<String>()
        if (wanted.contains(android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE) &&
            !hasPermission(android.Manifest.permission.CAMERA)
        ) {
            needed.add(android.Manifest.permission.CAMERA)
        }
        if (wanted.contains(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE) &&
            !hasPermission(android.Manifest.permission.RECORD_AUDIO)
        ) {
            needed.add(android.Manifest.permission.RECORD_AUDIO)
        }

        if (needed.isNotEmpty()) {
            // 上一次还没作答的请求必须收尾，否则它的 Promise 永远悬空
            pendingWebPermission?.let { runCatching { it.deny() } }
            pendingWebPermission = request
            runCatching { requestPermissions(needed.toTypedArray(), REQ_PERM_WEB_MEDIA) }
                .onFailure {
                    Log.w(TAG, "web permission request failed: ${it.message}")
                    pendingWebPermission = null
                    runCatching { request.deny() }
                }
            return
        }

        val granted = wanted.filter { resource ->
            when (resource) {
                android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE -> hasPermission(android.Manifest.permission.CAMERA)
                android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE -> hasPermission(android.Manifest.permission.RECORD_AUDIO)
                else -> false
            }
        }
        if (granted.isEmpty()) {
            runCatching { request.deny() }
        } else {
            runCatching { request.grant(granted.toTypedArray()) }
                .onFailure { runCatching { request.deny() } }
        }
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

        // 网页媒体请求在等这个回执：此时才轮到对 WebView 作答。
        if (requestCode != REQ_PERM_WEB_MEDIA) return
        val request = pendingWebPermission ?: return
        pendingWebPermission = null
        // 逐条复核，而不是信任 grantResults 的下标对齐 —— 某些 ROM 会合并
        // 相邻请求，下标与 permissions 的顺序对不上。hasPermission 是权威事实源。
        val granted = request.resources.filter { resource ->
            when (resource) {
                android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE -> hasPermission(android.Manifest.permission.CAMERA)
                android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE -> hasPermission(android.Manifest.permission.RECORD_AUDIO)
                else -> false
            }
        }
        if (granted.isEmpty()) {
            Log.i(TAG, "web permission denied by user")
            runCatching { request.deny() }
        } else {
            Log.i(TAG, "web permission granted: ${granted.joinToString()}")
            runCatching { request.grant(granted.toTypedArray()) }
                .onFailure { runCatching { request.deny() } }
        }
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

    /**
     * 热态点击通知：Activity 已在栈里（`launchMode=singleTask`）时走这里。
     *
     * 改造前 MainActivity **完全没有** onNewIntent —— 通知点击永远只会
     * `onResume`，把已经在前台的界面重新拉一次，用户看不出「点的是哪一条」。
     */
    override fun onNewIntent(intent: android.content.Intent?) {
        super.onNewIntent(intent)
        if (intent == null) return
        // 必须 setIntent：否则后续 getIntent() 仍返回冷启动那一条，重复点击
        // 同一条通知会看起来「第一次有用、之后都没反应」。
        setIntent(intent)
        handleLaunchIntent(intent)
    }

    /** 从启动意图里提取 attention 目标，存入 pending 等待页面就绪。 */
    private fun handleLaunchIntent(intent: android.content.Intent?) {
        val attentionId = intent?.getStringExtra(EXTRA_ATTENTION_ID) ?: return
        pendingAttentionId = attentionId
        pendingSessionId = intent.getStringExtra(EXTRA_SESSION_ID)
        Log.i(TAG, "launch intent: attention=$attentionId")
        flushPendingAttention()
    }

    /** 页面已就绪时把挂起的意图送进前端。 */
    private fun flushPendingAttention() {
        val id = pendingAttentionId ?: return
        if (!urlLoaded || !::webView.isInitialized) return
        pendingAttentionId = null
        val sessionId = pendingSessionId
        pendingSessionId = null
        navigateToAttention(id, sessionId)
    }

    /**
     * 把「打开某条 attention」的意图交给前端。
     *
     * **刻意不硬编码前端路由**：这里只做两件事 —— 把意图写进 URL hash（可回退、
     * 可分享）并发一个自定义事件（重复点同一条时 hash 不变、不会触发
     * hashchange，但事件仍会送达）。落到哪个视图由 kxxy-host 的 web 层决定，
     * 原生壳不需要知道前端有几个页面。
     *
     * 用 evaluateJavascript 而不是 loadUrl：loadUrl 会**重新加载整个文档**，
     * 用户正在看的会话会被刷没。
     */
    private fun navigateToAttention(attentionId: String, sessionId: String?) {
        val js = buildString {
            append("(function(){try{var d={id:").append(jsString(attentionId))
            if (sessionId != null) append(",sessionId:").append(jsString(sessionId))
            append("};")
            append("var h='#kxxy-attention='+encodeURIComponent(d.id);")
            append("if(d.sessionId){h+='&session='+encodeURIComponent(d.sessionId);}")
            append("if(location.hash!==h){location.hash=h;}")
            append("window.dispatchEvent(new CustomEvent('kxxy-attention',{detail:d}));")
            append("}catch(e){}})()")
        }
        runCatching { webView.evaluateJavascript(js, null) }
            .onFailure { Log.w(TAG, "attention route failed: ${it.message}") }
    }

    /** 转义成 JS 双引号字符串字面量。 */
    private fun jsString(value: String): String {
        val sb = StringBuilder(value.length + 2)
        sb.append('"')
        for (ch in value) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '<' -> sb.append("\\u003c")
                '>' -> sb.append("\\u003e")
                '&' -> sb.append("\\u0026")
                else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        sb.append('"')
        return sb.toString()
    }

    /**
     * 打开本应用的通知设置（含四条渠道的单独开关）。
     *
     * `EXTRA_APP_PACKAGE` 是 Android 8 起的分包写法；某些 ROM（HyperOS / EMUI）
     * 只认旧的两个 extra，所以两套都填，兜底再退化到全应用列表。
     */
    private fun openNotificationSettings() {
        val intents = listOf(
            android.content.Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName)
                .putExtra("android.provider.extra.APP_PACKAGE", packageName),
            android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$packageName")),
        )
        for (intent in intents) {
            if (runCatching { startActivity(intent) }.isSuccess) return
        }
        Log.w(TAG, "notification settings intent unavailable")
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
        // 同理：悬空的权限请求会让网页侧的 getUserMedia Promise 永不 resolve
        pendingWebPermission?.let { runCatching { it.deny() } }
        pendingWebPermission = null
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

        /** 设置页里「相机」「麦克风」「媒体」「短信」等单项授权共用的回执码。 */
        private const val REQ_PERM_MEDIA = 4204

        /** 设置页「一键授予全部权限」。 */
        private const val REQ_PERM_ALL = 4205

        /** 网页 getUserMedia 触发的权限请求，回执用来给 WebView 作答。 */
        private const val REQ_PERM_WEB_MEDIA = 4206

        /** 通知点击时带过来的请求标识（由 [app.kxxy.service.Notifier] 写入）。 */
        const val EXTRA_ATTENTION_ID = "kxxy.extra.attention_id"

        /** 该请求所属的会话（可能为空：引擎没给就不跳会话）。 */
        const val EXTRA_SESSION_ID = "kxxy.extra.session_id"
    }
}
