package app.kxxy.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import app.kxxy.KxxyApp
import app.kxxy.MainActivity
import app.kxxy.R
import app.kxxy.engine.EngineSupervisor
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

/**
 * 引擎前台服务 —— 保活第一层。
 *
 * 三个关键决策（每条都有生产事故背书）：
 *
 * 1. **foregroundServiceType = specialUse**
 *    dataSync 类型在 Android 14+ 有 6 小时系统限时，长任务会被强杀。
 *    specialUse 无此限制，且 sideload 分发无需 Play 审核豁免。
 *
 * 2. **onStartCommand 立刻用 force 更新一次通知**
 *    参考项目 v1.2.73 事故：StateFlow 只在状态**变化**时才发事件，
 *    而 MainActivity.onResume 每次都调 start()，于是「重进 onStartCommand
 *    → 通知被重置为启动中 → 已 Healthy 的状态不再重发」→ 小字永远卡住。
 *
 * 3. **退出走独立线程**
 *    supervisor.stop() 是阻塞式（内部轮询最多 10 秒）。若跑在 onStartCommand
 *    主线程上，通知栏十几秒纹丝不动（参考项目 v1.2.73 实测）。
 */
class EngineService : Service() {

    private val app get() = application as KxxyApp
    private val supervisor: EngineSupervisor get() = app.supervisor

    private var stateJob: Job? = null

    @Volatile
    private var lastNotifText: String? = null

    override fun onCreate() {
        super.onCreate()
        running = this
        // 四条通知渠道统一由 Notifier 建（含 attention/task/ext）。
        // 这里不再自己 createNotificationChannel —— 渠道重要性一次定终身，
        // 散在两处建迟早会出现「同一个 id 两种重要性」的分裂。
        Notifier.ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Android 14+ 要求启动前台服务时声明类型
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, buildNotification(getString(R.string.status_starting)),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, buildNotification(getString(R.string.status_starting)))
        }

        if (intent?.action == ACTION_EXIT) {
            handleExit()
            return START_NOT_STICKY
        }

        // 闸门 1：用户显式退出后不再自动启动（否则「退出不了」）
        if (supervisor.isUserStopped()) {
            Log.i(TAG, "skip auto-start: user explicitly exited")
            return START_STICKY
        }

        observeState()
        supervisor.start()

        // 参考项目 v1.2.44：更新 FGS 通知必须用 startForeground 再发一次 ——
        // NotificationManager.notify() 在 Android 13+ 常被静默忽略。
        updateNotification(supervisor.state.value, force = true)

        return START_STICKY
    }

    /**
     * 划掉任务卡片后自拉回。
     *
     * 默认行为是「划掉卡片连同前台服务一起被杀」。这里只做最基础也最关键的一环：
     * 被划掉后立刻把自己拉回来。
     *
     * 不做更激进保活手段的理由：targetSdk 28（sideload）下前台服务已足够稳；
     * 过度保活显著增加耗电且属灰色手段。
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        if (supervisor.isUserStopped()) {
            Log.i(TAG, "task removed but user explicitly exited, not restarting")
            return
        }
        Log.i(TAG, "task removed, restarting foreground service")
        start(this)
        super.onTaskRemoved(rootIntent)
    }

    private fun observeState() {
        if (stateJob?.isActive == true) return
        stateJob = app.appScope.launch {
            supervisor.state.collectLatest { st -> updateNotification(st, force = false) }
        }
    }

    private fun updateNotification(state: EngineSupervisor.State, force: Boolean) {
        val text = textFor(state)
        if (!force && text == lastNotifText) return
        lastNotifText = text

        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    /** 每个状态都要有文案，否则通知栏会显示空白。 */
    private fun textFor(state: EngineSupervisor.State): String = when (state) {
        is EngineSupervisor.State.Idle -> getString(R.string.status_idle)
        is EngineSupervisor.State.Installing ->
            getString(R.string.status_installing, (state.progress * 100).toInt())
        is EngineSupervisor.State.Starting -> getString(R.string.status_starting)
        is EngineSupervisor.State.Healthy -> getString(R.string.status_healthy)
        is EngineSupervisor.State.Backoff ->
            getString(R.string.status_backoff, state.delayMs / 1000, state.attempt)
        is EngineSupervisor.State.Failed -> state.reason
        is EngineSupervisor.State.Stopped -> getString(R.string.status_exiting)
    }

    /**
     * 常驻通知的构建交给 [Notifier]。
     *
     * 这里只保留「怎么发」（`startForeground`）—— 因为常驻通知必须走
     * `startForeground` 才会被系统认作前台服务标识，`notify()` 在 Android 13+
     * 常被静默忽略。
     */
    private fun buildNotification(text: String): Notification = Notifier.engineNotification(this, text)

    /**
     * 退出：三步走，全部避开主线程阻塞。
     *   ① 取消状态订阅并立刻推一条「正在退出」
     *   ② 独立 daemon 线程执行阻塞式 stop
     *   ③ 回主线程撤前台并 stopSelf
     */
    private fun handleExit() {
        supervisor.markUserStopped()
        stateJob?.cancel()
        stateJob = null
        pushStatusText(getString(R.string.status_exiting))

        Thread({
            // stop() 是 suspend 函数，而这里刻意用裸线程（不能在主线程阻塞）。
            // runBlocking 只是为把 suspend 调用桥接进这个线程，不会阻塞主线程。
            runBlocking { supervisor.stop(graceMs = 3_000L) }
            Handler(Looper.getMainLooper()).post {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }, "kxxy-exit").apply { isDaemon = true }.start()
    }

    private fun pushStatusText(text: String) {
        lastNotifText = text
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    override fun onDestroy() {
        stateJob?.cancel()
        if (running === this) running = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "KxxyEngineService"

        /**
         * 常驻通知 id。数值写死在 [Notifier.ID_ENGINE]，因为 `TermuxApiServer`
         * 的通知实现、体检页的状态查询都用它，改一处会静默断开另一处。
         */
        private const val NOTIF_ID = Notifier.ID_ENGINE

        const val ACTION_EXIT = "app.kxxy.service.action.EXIT"

        @Volatile
        private var running: EngineService? = null

        fun isRunning(): Boolean = running != null

        /**
         * 唯一的自动启动汇聚点。所有自动启动路径（Activity.onResume、
         * 无障碍看门狗、通知点击）都必须走这里，以保证闸门一致。
         */
        fun start(context: Context) {
            val app = context.applicationContext as KxxyApp
            if (app.supervisor.isUserStopped()) {
                Log.i(TAG, "skip auto-start: user explicitly exited")
                return
            }
            val intent = Intent(context, EngineService::class.java)
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
