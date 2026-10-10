package app.kxxy

import android.app.Application
import android.util.Log
import app.kxxy.engine.EngineSupervisor
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
        supervisor = EngineSupervisor(this)
        Log.i(TAG, "KxxyApp created, version=${BuildConfig.VERSION_NAME}")
    }

    companion object {
        private const val TAG = "KxxyApp"
    }
}
