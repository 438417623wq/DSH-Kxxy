package app.kxxy.engine

import android.app.Application
import android.content.pm.PackageManager
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import moe.shizuku.server.IRemoteProcess
import moe.shizuku.server.IShizukuService
import rikka.shizuku.Shizuku
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

/**
 * Shizuku 桥接：**ADB 身份执行通道**。
 *
 * ## 语义边界（这是本模块存在的理由）
 *
 * Shizuku 的 binder 能力**不能**改变引擎进程的 uid —— 引擎是 `execve` 起的独立
 * 进程，uid 由内核在 fork 时决定，任何 binder 调用都改不了已存在进程的凭据。
 *
 * 所以「shizuku 模式」的正确语义不是「给引擎提权」，而是：
 *
 * > 在应用侧持有一条以 **adb/shell 身份**（uid 2000）执行命令的通道，
 * > 再把这条通道暴露给引擎内的脚本使用。
 *
 * 对照 root 模式：root 是**引擎整体以 uid 0 启动**（进程级），Shizuku 是
 * **按需以 uid 2000 执行单条命令**（调用级）。两者不可互换，也不应互相冒充。
 *
 * ## 为什么不用 `Shizuku.newProcess()`
 *
 * 该方法在 Shizuku 13.x 已是 `private static`，且官方 javadoc 标注
 * 「planned to be removed from Shizuku API 14」。但它内部只有一行：
 *
 * ```java
 * return new ShizukuRemoteProcess(requireService().newProcess(cmd, env, dir));
 * ```
 *
 * 而 `requireService()` 就是 `IShizukuService.Stub.asInterface(binder)`。所以这里
 * 直接复刻这一行即可，行为完全一致，且不受方法可见性约束。
 *
 * 注意区分：[ShizukuBinderWrapper] 是给**别的** binder 用的（把系统服务的事务
 * 转发给 Shizuku server 代执行），包在 Shizuku 自己的 binder 上反而会让 server
 * 对自己重入一次，是错的。
 *
 * ## 生命周期陷阱
 *
 * Shizuku server 的 binder **在应用启动后才异步送达**（ContentProvider 的
 * `call()` 把 binder 塞进来）。在此之前调用任何 `Shizuku.*` 方法都会抛
 * `IllegalStateException("binder haven't been received")`。所以：
 *
 * - 初始化必须在 [Application.onCreate] 里尽早完成（`addBinderReceivedListenerSticky`）；
 * - 所有对外查询都先过 [available]（内部用 `Shizuku.pingBinder()`，它不抛异常）；
 * - 权限状态用 [permissionGranted]，它在 binder 未就绪时返回 false 而非抛错。
 */
object ShizukuBridge {

    private const val TAG = "KxxyShizuku"

    /** 权限请求码。Shizuku 用它回调 [Shizuku.OnRequestPermissionResultListener]。 */
    const val REQUEST_CODE = 4204

    /** 管理器包名（两个历史包名都认）。 */
    private val SHIZUKU_PACKAGES = listOf(
        "moe.shizuku.privileged.api",
        "moe.shizuku.manager",
    )

    /** 对外状态快照。UI 与 `privAvailability()` 都读它。 */
    data class Status(
        /** 管理器是否安装。 */
        val installed: Boolean = false,
        /** binder 是否已送达（即 Shizuku 服务在运行且本应用拿到了通道）。 */
        val binderReady: Boolean = false,
        /** 是否已获得 Shizuku 授权。 */
        val granted: Boolean = false,
        /** Shizuku server 的 API 版本，未知为 -1。 */
        val version: Int = -1,
        /** Shizuku server 的运行 uid（正常是 2000=shell 或 0=root）。 */
        val serverUid: Int = -1,
        /** 最近一次失败原因，供 UI 展示。 */
        val lastError: String? = null,
    ) {
        /**
         * 是否真正可用 —— 这是 UI 判断「可启用 / 不可用」的唯一依据。
         *
         * 三态缺一不可：装了管理器但服务没起（未通过 ADB 启动 Shizuku），
         * 或服务起了但没授权，都不算可用。
         */
        val usable: Boolean get() = installed && binderReady && granted
    }

    private val _status = MutableStateFlow(Status())
    val status: StateFlow<Status> = _status.asStateFlow()

    @Volatile
    private var app: Application? = null

    @Volatile
    private var initialized = false

    // ── 初始化 ──────────────────────────────────────────────────────────

    /**
     * 绑定 binder 生命周期监听。**必须在 `Application.onCreate()` 里调用**。
     *
     * 用 `addBinderReceivedListenerSticky` 而非 `addBinderReceivedListener`：
     * sticky 版本会在注册时立刻回调一次「当前是否已有 binder」，避免应用启动
     * 晚于 Shizuku server 时永远收不到通知（这是最容易被忽略的一种失联）。
     */
    fun init(application: Application) {
        if (initialized) return
        initialized = true
        app = application

        val installed = detectInstalled(application)
        _status.value = _status.value.copy(installed = installed)
        Log.i(TAG, "init: manager installed=$installed")

        if (!installed) {
            // 没装管理器就不注册监听：Shizuku 的静态初始化会尝试连 provider，
            // 在没有管理器时只会刷一堆无意义的警告。
            return
        }

        try {
            Shizuku.addBinderReceivedListenerSticky { onBinderChanged() }
            Shizuku.addBinderDeadListener {
                Log.w(TAG, "binder dead")
                _status.value = _status.value.copy(
                    binderReady = false,
                    granted = false,
                    lastError = "Shizuku 服务已断开",
                )
            }
            Shizuku.addRequestPermissionResultListener { requestCode, grantResult ->
                if (requestCode != REQUEST_CODE) return@addRequestPermissionResultListener
                val ok = grantResult == PackageManager.PERMISSION_GRANTED
                Log.i(TAG, "permission result: granted=$ok")
                refresh(grantedHint = ok)
            }
        } catch (e: Throwable) {
            // Shizuku 的静态初始化在某些 ROM 上会抛（provider 未就绪）。
            // 这里吞掉是刻意的：Shizuku 是可选能力，不能拖垮应用启动。
            Log.w(TAG, "init listener failed: ${e.message}")
            _status.value = _status.value.copy(lastError = "Shizuku 初始化失败：${e.message}")
        }
    }

    private fun onBinderChanged() {
        Log.i(TAG, "binder received")
        refresh()
    }

    // ── 状态查询 ────────────────────────────────────────────────────────

    /** 管理器是否安装（只查包，不需要 binder）。 */
    fun installed(ctx: android.content.Context): Boolean = detectInstalled(ctx)

    private fun detectInstalled(ctx: android.content.Context): Boolean = SHIZUKU_PACKAGES.any { pkg ->
        try {
            ctx.packageManager.getPackageInfo(pkg, 0) != null
        } catch (e: PackageManager.NameNotFoundException) {
            false
        }
    }

    /**
     * 重新探测并广播状态。
     *
     * [grantedHint] 用于权限回调：`requestPermission` 的结果回调先于
     * `checkSelfPermission()` 的内部缓存刷新，此时直接采信回调值更可靠。
     */
    fun refresh(grantedHint: Boolean? = null) {
        val cur = _status.value
        if (!cur.installed) {
            _status.value = cur.copy(binderReady = false, granted = false)
            return
        }

        val ready = try {
            Shizuku.pingBinder()
        } catch (e: Throwable) {
            false
        }
        if (!ready) {
            _status.value = cur.copy(
                binderReady = false,
                granted = false,
                lastError = "Shizuku 服务未运行（需通过 ADB 或 root 启动 Shizuku）",
            )
            return
        }

        val granted = grantedHint ?: try {
            Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
        } catch (e: Throwable) {
            Log.w(TAG, "checkSelfPermission failed: ${e.message}")
            false
        }

        val version = try {
            Shizuku.getVersion()
        } catch (e: Throwable) {
            -1
        }
        val uid = try {
            Shizuku.getUid()
        } catch (e: Throwable) {
            -1
        }

        val next = Status(
            installed = true,
            binderReady = true,
            granted = granted,
            version = version,
            serverUid = uid,
            lastError = if (granted) null else "尚未授权（点击请求授权）",
        )
        // 只在状态真的变了才打日志。
        //
        // [refresh] 被 ShizukuShellServer 的轮询循环以 500ms 周期调用，
        // 无条件 Log.i 会以每秒两条的速度刷屏，把真正的事件（授权结果、
        // binder 断开、通道就绪）淹没在噪音里 —— 这在真机排查时是致命的。
        val changed = next != _status.value
        _status.value = next
        if (changed) {
            Log.i(TAG, "status: ready=true granted=$granted version=$version uid=$uid")
        }
    }

    /** 便捷判定：binder 已送达且已授权。 */
    fun usable(): Boolean = _status.value.usable

    // ── 权限请求 ────────────────────────────────────────────────────────

    /**
     * 请求 Shizuku 授权。会弹出 Shizuku 自己的授权界面（不是系统权限对话框）。
     *
     * 返回 false 表示当前根本无法请求（未安装 / 服务未运行 / 已授权）。
     */
    fun requestPermission(): Boolean {
        if (!_status.value.binderReady) {
            refresh()
        }
        if (!_status.value.binderReady) return false
        return try {
            Shizuku.requestPermission(REQUEST_CODE)
            true
        } catch (e: Throwable) {
            Log.w(TAG, "requestPermission failed: ${e.message}")
            _status.value = _status.value.copy(lastError = "请求授权失败：${e.message}")
            false
        }
    }

    // ── 执行通道 ────────────────────────────────────────────────────────

    /** 一次 ADB 身份执行的产物。 */
    data class ExecResult(
        val exitCode: Int,
        val stdout: String,
        val stderr: String,
        val timedOut: Boolean = false,
    )

    /**
     * 以 Shizuku server 的身份（正常是 uid 2000 = shell）执行一条 shell 命令。
     *
     * **必须在后台线程调用**：内部是同步 binder 调用，且会阻塞读子进程输出。
     *
     * 返回 null 表示通道不可用（未授权 / binder 断开 / 异常），调用方应据此
     * 决定降级路径，而不是把 null 当成「命令失败」。
     */
    fun execShell(command: String, timeoutMs: Long = 15_000L): ExecResult? {
        val s = _status.value
        if (!s.usable) {
            Log.w(TAG, "execShell rejected: usable=false (installed=${s.installed} ready=${s.binderReady} granted=${s.granted})")
            return null
        }

        return try {
            val service = serviceProxy() ?: return null
            // 环境变量刻意最小化：Shizuku server 侧的默认环境已含 PATH，
            // 这里只补 Android 上 shell 常用的几个，避免继承应用私有环境。
            val env = arrayOf(
                "PATH=/product/bin:/apex/com.android.runtime/bin:/apex/com.android.art/bin:/system/bin:/system/xbin",
                "ANDROID_DATA=/data",
                "ANDROID_ROOT=/system",
            )
            val proc = service.newProcess(arrayOf("/system/bin/sh", "-c", command), env, "/")

            val stdout = StringBuilder()
            val stderr = StringBuilder()
            val outThread = Thread { drain(proc.getInputStream(), stdout) }.apply {
                isDaemon = true
                name = "kxxy-shz-stdout"
            }
            val errThread = Thread { drain(proc.getErrorStream(), stderr) }.apply {
                isDaemon = true
                name = "kxxy-shz-stderr"
            }
            outThread.start()
            errThread.start()

            val finished = proc.waitForTimeout(timeoutMs, TimeUnit.MILLISECONDS.toString())
            val code = if (finished) {
                outThread.join(1_000L)
                errThread.join(1_000L)
                try {
                    proc.exitValue()
                } catch (e: Throwable) {
                    -1
                }
            } else {
                Log.w(TAG, "execShell timed out after ${timeoutMs}ms, destroying process")
                try {
                    proc.destroy()
                } catch (e: Throwable) {
                    // 忽略：进程可能刚好自己退出
                }
                -1
            }

            ExecResult(
                exitCode = code,
                stdout = stdout.toString(),
                stderr = stderr.toString(),
                timedOut = !finished,
            )
        } catch (e: Throwable) {
            Log.w(TAG, "execShell failed: ${e.javaClass.simpleName}: ${e.message}")
            _status.value = _status.value.copy(lastError = "执行失败：${e.message}")
            null
        }
    }

    /**
     * 构造 `IShizukuService` 代理。
     *
     * 直接对 `Shizuku.getBinder()` 做 `asInterface` —— 这正是 Shizuku 私有方法
     * `requireService()` 的实现（`IShizukuService.Stub.asInterface(binder)`），
     * 拿到的是 server binder 自身的本地代理，descriptor 匹配，事务直达。
     */
    private fun serviceProxy(): IShizukuService? {
        val binder: IBinder = try {
            Shizuku.getBinder()
        } catch (e: Throwable) {
            null
        } ?: run {
            Log.w(TAG, "getBinder returned null")
            return null
        }
        return try {
            IShizukuService.Stub.asInterface(binder)
        } catch (e: Throwable) {
            Log.w(TAG, "asInterface failed: ${e.message}")
            null
        }
    }

    /** 把 ParcelFileDescriptor 读干。异常一律吞掉（流被对端关闭是正常路径）。 */
    private fun drain(fd: ParcelFileDescriptor?, sink: StringBuilder) {
        if (fd == null) return
        try {
            ParcelFileDescriptor.AutoCloseInputStream(fd).use { input ->
                val buf = ByteArray(8 * 1024)
                val acc = ByteArrayOutputStream()
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    acc.write(buf, 0, n)
                    // 防御：单条命令的输出不该超过 1 MiB，超了直接截断，
                    // 否则恶意/失控命令会把应用内存吃光。
                    if (acc.size() > MAX_CAPTURE_BYTES) break
                }
                sink.append(acc.toString(Charsets.UTF_8.name()))
            }
        } catch (e: Throwable) {
            Log.d(TAG, "drain ended: ${e.message}")
        }
    }

    private const val MAX_CAPTURE_BYTES = 1 shl 20

    // ── 诊断 ────────────────────────────────────────────────────────────

    /** 供 `/kxxy` 控制台「快速刷新」与 `privAvailability()` 使用的一行状态 JSON。 */
    fun statusJson(): String {
        val s = _status.value
        val err = s.lastError?.let { ",\"shizukuError\":\"${it.replace("\"", "'")}\"" } ?: ""
        return "{\"shizuku\":${s.usable},\"shizukuInstalled\":${s.installed}," +
            "\"shizukuBinder\":${s.binderReady},\"shizukuGranted\":${s.granted}," +
            "\"shizukuVersion\":${s.version},\"shizukuUid\":${s.serverUid}$err}"
    }
}
