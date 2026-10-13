package app.kxxy

import android.app.Application
import android.util.Log
import app.kxxy.engine.EngineSupervisor
import app.kxxy.engine.ShizukuBridge
import app.kxxy.engine.ShizukuShellServer
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
        supervisor = EngineSupervisor(this)
        Log.i(TAG, "KxxyApp created, version=${BuildConfig.VERSION_NAME}")
    }

    companion object {
        private const val TAG = "KxxyApp"
    }
}
