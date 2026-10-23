package app.kxxy

import android.app.Application
import android.util.Log
import app.kxxy.engine.BuildMeta
import app.kxxy.engine.EngineSupervisor
import app.kxxy.engine.ShizukuBridge
import app.kxxy.engine.ShizukuShellServer
import app.kxxy.engine.TermuxApiServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * 应用入口。
 *
 * 持有进程级单例：监管器与协程作用域。
 * 用 SupervisorJob 是为了让某个子协程失败不牵连整个作用域 —— 引擎监管循环
 * 与 UI 协程各自独立失败。
 */
class KxxyApp : Application() {

    /** 进程级协程作用域。 */
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** 引擎监管器（进程级单例，UI 与前台服务共享）。 */
    lateinit var supervisor: EngineSupervisor
        private set

    override fun onCreate() {
        super.onCreate()
        // Shizuku 初始化必须最早：它的 binder 由 ContentProvider 异步送达，
        // 注册 sticky 监听越早，越不会漏掉「应用启动时 server 已经在跑」这种情况。
        // 未安装管理器时该调用内部直接返回，无副作用。
        ShizukuBridge.init(this)
        // Shizuku 执行通道的服务端：应用进程是唯一持有 binder 的地方，
        // 引擎侧脚本经文件请求/响应把命令送到这里执行。
        ShizukuShellServer.start(this, appScope)
        // Termux:API 原生桥的服务端（缺陷 BE）。闭包里 libexec/termux-api 是
        // 一个 execv 到 /data/data/com.termux/.../am 的 ELF，在本机必然失败且
        // 静默 rc=0；这里把它换成脚本 shim，请求经文件通道回到应用进程执行。
        // 必须在这里启动：Toast / 剪贴板 / 通知都要求应用进程的上下文。
        TermuxApiServer.start(this, appScope)
        supervisor = EngineSupervisor(this)
        /*
         * 启动日志必须自证版本（缺陷 DP）。
         *
         * 原来只有一行 `version=0.1.0` —— 那是 gradle 里写死的常量，与仓库
         * 的 v0.9.x 毫无关系，用户贴 logcat 过来也判断不出装的是哪一版。
         * 现在一次打全三样：APK 版本（git 推导）、runtime.zip 的 sha256 前 16 位、
         * 宿主插件的内容指纹前 16 位。有了这一行，「插件到底是新的还是旧的」
         * 这类问题不用再猜。
         */
        Log.i(TAG, "KxxyApp created · ${BuildMeta.startupLine(this)}")
    }

    companion object {
        private const val TAG = "KxxyApp"
    }
}
