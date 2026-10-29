package app.kxxy.engine

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.Process
import android.provider.Settings

/**
 * 权限目录 —— 清单、状态、申请路径的**单一事实源**。
 *
 * 为什么要抽这张表：权限这件事原本散在三处（AndroidManifest 声明、
 * EngineSupervisor 的状态快照、MainActivity 的 kxxy:// 桥分派），
 * 加一项要同时改三个文件、还容易漏掉其中一处 —— 漏声明的症状是
 * 「设置页有按钮、点了系统什么都不弹」，漏分派的症状是「点了没反应」，
 * 两种都很难从日志上看出来。
 *
 * 现在只在 [entries] 里加一行：状态快照与申请入口都从它派生。
 *
 * 四种 kind 的语义差别是**用户看到的东西完全不同**，所以必须显式区分：
 *
 *   · [Kind.RUNTIME]  —— 危险权限，`requestPermissions` 会弹系统对话框。
 *   · [Kind.SPECIAL]  —— 特殊权限（所有文件访问 / 悬浮窗 / 电池优化 /
 *                        安装未知应用）：系统**没有**对话框，只能跳设置页。
 *                        这类行如果做成「去授权」，用户会以为按钮坏了。
 *   · [Kind.NORMAL]   —— 安装即授予的普通权限（应用列表、媒体音量、
 *                        高采样率传感器、桌面快捷方式）。应用内无法撤销，
 *                        状态恒为已授予，只作「系统里确实有这项」的展示。
 *   · [Kind.NAVIGATE] —— 应用根本管不到的开关（MIUI/HyperOS 安全中心的
 *                        锁屏显示、后台弹出界面、链式启动、剪贴板后台读取）。
 *                        应用内唯一能做的是把用户送到对应的系统页面。
 */
object PermCatalog {

    enum class Kind {
        RUNTIME,
        SPECIAL,
        NORMAL,
        NAVIGATE,
    }

    /**
     * 一条权限项。
     *
     * @param id      与 kxxy://perm/request?name=… 的 name 一致，也是状态快照里
     *                的字段名 —— 前端用它把状态和文案对上，所以**改名等于改协议**。
     * @param kind    见类注释。
     * @param perms   该条目涉及的原生权限；RUNTIME/NORMAL 用于状态判定与申请，
     *                其余 kind 留空。
     */
    data class Entry(
        val id: String,
        val kind: Kind,
        val perms: List<String> = emptyList(),
    )

    /**
     * 媒体读取权限的版本分支。
     *
     * targetSdk 固定 28（见 app/build.gradle.kts 的说明：Android 10+ 的
     * execve 限制逼出来的决定），所以 Android 13+ 也走 legacy 的
     * READ_EXTERNAL_STORAGE —— 系统会把它在权限页上拆成「照片和视频」与
     * 「音乐和音频」两行，行为符合用户预期。
     *
     * 刻意**不**声明 READ_MEDIA_IMAGES / READ_MEDIA_AUDIO：那是 targetSdk 33+
     * 的通道，在 28 上申请会立刻返回 DENIED 并计入「拒绝两次不再询问」，
     * 之后连真正的对话框都不弹 —— 反而把媒体权限彻底做死。
     */
    private val mediaPerms: List<String> = ArrayList<String>(2).apply {
        add(Manifest.permission.READ_EXTERNAL_STORAGE)
        // WRITE 自 Android 11 起对应用无用（分区存储），10 及以下仍靠它写公共目录
        if (Build.VERSION.SDK_INT <= 29) add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
    }

    /** 桌面快捷方式权限（launcher 自定义权限，没有 Manifest.permission 常量）。 */
    private const val INSTALL_SHORTCUT = "com.android.launcher.permission.INSTALL_SHORTCUT"

    /** Android 11+ 包可见性（同上，属于 manifest-only 的权限名）。 */
    private const val QUERY_ALL_PACKAGES = "android.permission.QUERY_ALL_PACKAGES"

    /** 全部条目。顺序即前端渲染顺序（前端仍按自己的分组排，这里只保证稳定）。 */
    val entries: List<Entry> = listOf(
        // ── 媒体与输入 ────────────────────────────────────────────────
        Entry("camera", Kind.RUNTIME, listOf(Manifest.permission.CAMERA)),
        Entry("microphone", Kind.RUNTIME, listOf(Manifest.permission.RECORD_AUDIO)),
        Entry("media", Kind.RUNTIME, mediaPerms),
        // 媒体音量控制（MIUI 单列一行）：normal 权限，安装即授予
        Entry("audio_volume", Kind.NORMAL, listOf(Manifest.permission.MODIFY_AUDIO_SETTINGS)),

        // ── 文件与桌面 ────────────────────────────────────────────────
        Entry("all_files", Kind.SPECIAL),
        Entry("shortcut", Kind.NORMAL, listOf(INSTALL_SHORTCUT)),

        // ── 短信 ─────────────────────────────────────────────────────
        // 三条一起给：只发不收会让「验证码自动填」这类流程断在半路，
        // 只读不发又做不了回复。状态按「全有才算有」判定。
        Entry(
            "sms",
            Kind.RUNTIME,
            listOf(
                Manifest.permission.SEND_SMS,
                Manifest.permission.RECEIVE_SMS,
                Manifest.permission.READ_SMS,
            ),
        ),

        // ── 显示与后台 ────────────────────────────────────────────────
        Entry("overlay", Kind.SPECIAL),
        Entry("battery", Kind.SPECIAL),
        Entry("install_unknown", Kind.SPECIAL),
        // 获取应用列表：Android 11+ 的包可见性，normal 权限
        Entry("app_list", Kind.NORMAL, listOf(QUERY_ALL_PACKAGES)),
        // 获取设备动作与方向：高采样率传感器是 normal 权限；
        // 低采样率根本不需要权限，MIUI 的那一行由安全中心管（见 miui_perms）
        Entry("sensors", Kind.NORMAL, listOf(Manifest.permission.HIGH_SAMPLING_RATE_SENSORS)),
        // 通知不在本表内单独建模：它有三态（未授权 / 渠道静音 / 正常），
        // 需要 EngineSupervisor 的 notifications 快照配合，见 permissionSnapshot

        // ── 厂商安全中心 / 兜底出口 ────────────────────────────────────
        // 锁屏显示、后台弹出界面、链式启动管理、剪贴板后台读取、动态壁纸服务：
        // 都是 MIUI/HyperOS 在安全中心里单独加的开关，**没有对应的原生权限**，
        // 声明也声明不出来。唯一可行的做法是把用户送到 APP_PERM_EDITOR 页面。
        Entry("miui_perms", Kind.NAVIGATE),
        Entry("app_settings", Kind.NAVIGATE),
    )

    fun find(id: String): Entry? = entries.firstOrNull { it.id == id }

    /**
     * 该条目对应权限的当前状态。
     *
     * @return true 已授予 / false 未授予 / null 无法判定（NAVIGATE，或该权限
     *         在这台设备/这个系统版本上不存在）—— 前端据此把行渲染成
     *         「系统页管理」而不是一个永远点不亮的「去授权」。
     */
    fun status(ctx: Context, entry: Entry): Boolean? = when (entry.kind) {
        Kind.RUNTIME, Kind.NORMAL -> {
            // 只统计清单里真的声明过的：没声明的权限恒为 DENIED，
            // 直接 all{} 会让整行永远显示未授权
            val declared = entry.perms.filter { isDeclared(ctx, it) }
            if (declared.isEmpty()) null else declared.all { isGranted(ctx, it) }
        }
        Kind.SPECIAL -> specialStatus(ctx, entry.id)
        Kind.NAVIGATE -> null
    }

    /** 全部 RUNTIME 条目里尚未授予（且清单确实声明过）的权限，去重保序。 */
    fun missingRuntime(ctx: Context): List<String> {
        val out = LinkedHashSet<String>()
        for (entry in entries) {
            if (entry.kind != Kind.RUNTIME) continue
            for (perm in entry.perms) {
                if (isDeclared(ctx, perm) && !isGranted(ctx, perm)) out.add(perm)
            }
        }
        return out.toList()
    }

    /** 单条原生权限是否授予。 */
    fun isGranted(ctx: Context, permission: String): Boolean = runCatching {
        ctx.checkPermission(permission, Process.myPid(), Process.myUid()) ==
            PackageManager.PERMISSION_GRANTED
    }.getOrDefault(false)

    /**
     * 清单里是否声明过该权限。
     *
     * 这一步不能省：`requestPermissions` 里放一个没声明的权限，系统会立刻
     * 判 DENIED 并计入「拒绝两次不再询问」，于是**真正需要它的那天**，
     * 对话框再也不会出现。
     */
    @Suppress("DEPRECATION")
    fun isDeclared(ctx: Context, permission: String): Boolean = runCatching {
        val info = ctx.packageManager.getPackageInfo(
            ctx.packageName,
            PackageManager.GET_PERMISSIONS,
        )
        info.requestedPermissions?.contains(permission) == true
    }.getOrDefault(false)

    /** 硬件存在性（无硬件时前端把行标成「这台设备没有…」而不是去授权）。 */
    fun hasCamera(ctx: Context): Boolean = runCatching {
        ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }.getOrDefault(false)

    fun hasMicrophone(ctx: Context): Boolean = runCatching {
        ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)
    }.getOrDefault(false)

    /**
     * 特殊权限的状态。每一条的查询 API 都不一样，且各有版本门槛 ——
     * 低版本上返回 null（该行不显示状态），而不是谎报 false。
     */
    private fun specialStatus(ctx: Context, id: String): Boolean? = runCatching {
        when (id) {
            // Android 11 才有「所有文件访问」；10 及以下走 legacy storage 运行时权限
            "all_files" -> if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager() else null
            "overlay" -> Settings.canDrawOverlays(ctx)
            "battery" -> {
                val pm = ctx.getSystemService(PowerManager::class.java)
                pm?.isIgnoringBatteryOptimizations(ctx.packageName) ?: false
            }
            // minSdk 26，canRequestPackageInstalls 从 26 起可用
            "install_unknown" -> ctx.packageManager.canRequestPackageInstalls()
            else -> null
        }
    }.getOrNull()
}
