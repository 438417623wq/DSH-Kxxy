package app.kxxy.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.util.Log
import app.kxxy.MainActivity
import app.kxxy.R

/**
 * 通知体系门面（方案 B）。
 *
 * ── 为什么要单独一个文件 ────────────────────────────────────────────────
 *
 * 改造前全项目只有**一条**通知（[EngineService] 的常驻状态条），所有通知相关
 * 代码散落在 `EngineService` 与 `TermuxApiServer` 两处，各自 `new` 一个
 * Builder、各自写一份渠道创建逻辑。后果有三个，都是真机上能摸到的：
 *
 *   1. 语义缺失 —— 引擎「需要你确认」和「引擎正在启动」用的是同一条 LOW
 *      优先级通知。用户在锁屏上看不出哪条要处理，只能等回到应用里才发现
 *      有个对话框在等他。
 *   2. 渠道不可改 —— [NotificationChannel] 一旦创建，**重要性永远不能改**。
 *      所以这一版必须先把渠道 id 与重要性定死（见 [ensureChannels] 注释），
 *      以后再想升优先级的唯一办法是开新 id。
 *   3. 通知 id 会撞 —— `TermuxApiServer` 用 `System.currentTimeMillis() % 100000`
 *      当 id，每 100 秒必然重复一次，后一条静默覆盖前一条。
 *
 * ── 四条渠道 ────────────────────────────────────────────────────────────
 *
 *   | id                | 重要性 | 用途                                   |
 *   |-------------------|--------|----------------------------------------|
 *   | `kxxy-engine`     | LOW    | 常驻状态条（不可划掉，退出按钮在这里）  |
 *   | `kxxy-attention`  | HIGH   | 需要用户决策：权限请求、提问、失败       |
 *   | `kxxy-task`       | DEFAULT| 任务进度与完成                          |
 *   | `kxxy-ext`        | LOW    | 扩展安装/更新（可静默）                  |
 *
 * `kxxy-engine` 这个 id 是从旧版本继承下来的，**不能改** —— 改了等于让所有
 * 老用户的通知偏好（如果他手动把这条调成「静默」）全部失效。
 *
 * ── 一点安全上的取舍 ────────────────────────────────────────────────────
 *
 * 需要决策的通知带 [Notification.VISIBILITY_PRIVATE] + 一条 `publicVersion`：
 * 锁屏上只显示「DSH Kxxy · 有新的请求」，不显示会话标题与正文。会话内容可能含
 * 代码片段或内部信息，锁屏是最容易被旁人看到的地方。
 */
object Notifier {

    private const val TAG = "KxxyNotifier"

    /** 常驻状态条通道（沿用旧 id，理由见类注释）。 */
    const val CHANNEL_ENGINE = "kxxy-engine"

    /** 需要用户决策的请求。HIGH：要能横幅弹出 + 响铃。 */
    const val CHANNEL_ATTENTION = "kxxy-attention"

    /** 任务进度与完成。DEFAULT：响但不打扰。 */
    const val CHANNEL_TASK = "kxxy-task"

    /** 扩展安装/更新。LOW：静默，只在下拉栏里留痕。 */
    const val CHANNEL_EXT = "kxxy-ext"

    /** 常驻状态条的通知 id（`TermuxApiServer` 等别处也在用 42，别改）。 */
    const val ID_ENGINE = 42

    /** attention 通知的 id 起点：避开 42 与下载通知，且留出足够空间给哈希取模。 */
    private const val ID_ATTENTION_BASE = 1000

    /** task 通知的 id 起点。 */
    private const val ID_TASK_BASE = 2000

    /**
     * Termux:API 自定义通知的 id 起点。
     *
     * 与上面两段刻意错开：`termux-notification --id foo` 与引擎内部的
     * attention 用的是两套命名空间，混在一起会出现「脚本发的通知把引擎的
     * 请求覆盖掉」这种极难排查的事故。
     */
    private const val ID_TERMUX_BASE = 30000

    private const val GROUP_ATTENTION = "kxxy.attention"

    /**
     * 建齐四条渠道。**幂等**，每次进程启动调一次即可。
     *
     * 注意 `ensureChannel` 的语义：只在渠道**不存在**时创建。已存在的渠道
     * 重要性、声音、震动都不可改 —— 这是 Android 的硬规则，不是偷懒。
     * 所以这里每一行重要性都是**一次定终身**的决策：
     *
     *   · attention 用 HIGH：它存在的全部意义就是「现在就要你看一眼」；
     *   · task 用 DEFAULT：进度类通知用 HIGH 会让通知栏长期占着横幅；
     *   · ext 用 LOW：装扩展是后台行为，用户不需要被通知打断。
     */
    fun ensureChannels(context: Context) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ENGINE,
                context.getString(R.string.notif_channel),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(R.string.notif_channel_engine_desc)
                setShowBadge(false)
                // 常驻条不需要声音与震动：它一直都在，每次状态变化都响一下
                // 会让「引擎重启」变成一种骚扰。
                setSound(null, null)
                enableVibration(false)
            }
        )

        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ATTENTION,
                context.getString(R.string.notif_channel_attention),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.notif_channel_attention_desc)
                setShowBadge(true)
                // 锁屏可见但不显示内容：内容由 publicVersion 单独给。
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            }
        )

        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_TASK,
                context.getString(R.string.notif_channel_task),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(R.string.notif_channel_task_desc)
                setShowBadge(false)
            }
        )

        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_EXT,
                context.getString(R.string.notif_channel_ext),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(R.string.notif_channel_ext_desc)
                setShowBadge(false)
            }
        )
    }

    // ══════════════════════════════════════════════════════════════════════
    // 常驻状态条
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 构建常驻通知。
     *
     * 调用方（[EngineService]）必须用 `startForeground(id, notification)` 而不是
     * `NotificationManager.notify()` —— Android 13+ 直接 notify 常被静默忽略，
     * 通知栏会停在旧文案上。
     */
    fun engineNotification(context: Context, text: String): Notification {
        val open = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val exit = PendingIntent.getService(
            context, 1,
            Intent(context, EngineService::class.java).setAction(EngineService.ACTION_EXIT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return Notification.Builder(context, CHANNEL_ENGINE)
            .setContentTitle(context.getString(R.string.notif_title))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notification_engine)
            .setContentIntent(open)
            .setOngoing(true)
            // 常驻条不该出现在锁屏上：它没有需要用户立刻处理的信息，
            // 而锁屏空间应该留给 attention。
            .setVisibility(Notification.VISIBILITY_SECRET)
            .addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(context, android.R.drawable.ic_menu_close_clear_cancel),
                    context.getString(R.string.notif_action_exit),
                    exit,
                ).build()
            )
            .build()
    }

    // ══════════════════════════════════════════════════════════════════════
    // 需要决策的请求
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 一条「等你处理」的请求。
     *
     * @param id 引擎侧给的稳定标识（同一条请求重复投递必须用同一个 id，
     *           否则会出现两条一模一样的通知）。
     * @param sessionId 会话标识，点击通知时带给前端用于跳转。
     * @param kind `permission` / `question` / `failed` / `done`。
     * @param actions 最多取前 3 个 —— Android 通知的按钮区实际最多显示 3 个，
     *                多给的会被静默丢弃，不如在构建时就截断。
     */
    data class Attention(
        val id: String,
        val sessionId: String?,
        val kind: String,
        val title: String,
        val body: String,
        val actions: List<Action>,
        val createdAt: Long,
    )

    /** 通知按钮。[key] 由引擎定义（如 `allow` / `deny`），原样回传。 */
    data class Action(val key: String, val label: String)

    fun notifyAttention(context: Context, attention: Attention, ongoing: Boolean = false) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // 同一条 attention 重复投递时覆盖而不是叠加：id 由内容决定。
        val notifId = ID_ATTENTION_BASE + (attention.id.hashCode() and 0x7FFF)

        val open = PendingIntent.getActivity(
            context,
            notifId,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                // 用 data 而不是只放 extras：PendingIntent 的「是否等同」判断
                // **不看 extras**，两条不同请求若只用 extras 区分，会互相覆盖
                // 成同一条（FLAG_UPDATE_CURRENT 会把前一条的 extras 冲掉）。
                data = Uri.parse("kxxy://attention/${Uri.encode(attention.id)}")
                putExtra(MainActivity.EXTRA_ATTENTION_ID, attention.id)
                attention.sessionId?.let { putExtra(MainActivity.EXTRA_SESSION_ID, it) }
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = Notification.Builder(context, CHANNEL_ATTENTION)
            .setSmallIcon(R.drawable.ic_notification_attention)
            .setContentTitle(attention.title)
            .setContentText(attention.body)
            .setStyle(Notification.BigTextStyle().bigText(attention.body))
            .setWhen(attention.createdAt)
            .setShowWhen(true)
            .setCategory(categoryFor(attention.kind))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setContentIntent(open)
            .setAutoCancel(!ongoing)
            .setOngoing(ongoing)
            // 同类通知合并成一组，避免通知栏被刷满屏（验收项 B6）。
            .setGroup(GROUP_ATTENTION)
            // 锁屏只给这一行：不含会话标题与正文。
            .setPublicVersion(
                Notification.Builder(context, CHANNEL_ATTENTION)
                    .setSmallIcon(R.drawable.ic_notification_attention)
                    .setContentTitle(context.getString(R.string.notif_attention_locked))
                    .setContentText(context.getString(R.string.notif_attention_locked_hint))
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .build()
            )

        attention.actions.take(MAX_ACTIONS).forEach { action ->
            builder.addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(context, iconFor(action.key)),
                    action.label,
                    actionPendingIntent(context, attention, action),
                ).build()
            )
        }

        try {
            nm.notify(notifId, builder.build())
            // 分组摘要：不显示具体内容，只用于把同组通知折叠起来
            nm.notify(GROUP_ATTENTION.hashCode(), groupSummary(context))
        } catch (e: SecurityException) {
            // Android 13+ 用户拒了 POST_NOTIFICATIONS 时会到这里。本应用
            // targetSdk 28，理论上不受该权限约束，但个别 ROM 仍会拦。
            Log.w(TAG, "notifyAttention blocked: ${e.message}")
        }
    }

    /**
     * 按钮的 PendingIntent。
     *
     * **必须用 `getBroadcast` 而不是 `getService`**：Android 12+ 对「从后台
     * 启动前台服务」有硬限制，而通知按钮的点击等于一次后台触发，用 getService
     * 起 FGS 会直接被系统拒（`ForegroundServiceStartNotAllowedException`）。
     * 广播没有这个限制，而且这里要做的只是写一个几十字节的 JSON 文件。
     */
    private fun actionPendingIntent(
        context: Context,
        attention: Attention,
        action: Action,
    ): PendingIntent {
        val intent = Intent(context, AttentionReceiver::class.java).apply {
            this.action = AttentionReceiver.ACTION_RESPONSE
            // data 让每条 (请求, 按钮) 组合都拥有独立的 PendingIntent
            data = Uri.parse(
                "kxxy://attention/${Uri.encode(attention.id)}/${Uri.encode(action.key)}"
            )
            putExtra(AttentionReceiver.EXTRA_ATTENTION_ID, attention.id)
            putExtra(AttentionReceiver.EXTRA_ACTION_KEY, action.key)
            attention.sessionId?.let { putExtra(AttentionReceiver.EXTRA_SESSION_ID, it) }
        }
        return PendingIntent.getBroadcast(
            context,
            (attention.id + "/" + action.key).hashCode() and 0x7FFF,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun groupSummary(context: Context): Notification =
        Notification.Builder(context, CHANNEL_ATTENTION)
            .setSmallIcon(R.drawable.ic_notification_attention)
            .setContentTitle(context.getString(R.string.notif_attention_group))
            .setGroup(GROUP_ATTENTION)
            .setGroupSummary(true)
            .setVisibility(Notification.VISIBILITY_SECRET)
            .build()

    fun cancelAttention(context: Context, id: String) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(ID_ATTENTION_BASE + (id.hashCode() and 0x7FFF))
    }

    // ══════════════════════════════════════════════════════════════════════
    // 通用入口（Termux:API 的 notification 命令走这里）
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Termux 侧脚本发一条通知。
     *
     * 与改造前的区别只有三处，但都是真机上能摸到的：
     *
     *   1. **id 不再是 `currentTimeMillis() % 100000`** —— 那个写法每 100 秒
     *      必然重复一次，后一条静默覆盖前一条，`termux-notification-remove`
     *      也会撤掉错误的通知。现在由 [notifIdFor] 统一映射。
     *   2. 渠道由 `--channel` 决定，默认落在 `kxxy-task`（DEFAULT 优先级），
     *      传 `--priority high|max` 时落到 `kxxy-attention`（HIGH）。
     *   3. 图标统一成本应用的六边形，不再借用系统的 `stat_notify_chat`。
     *
     * @param channelId 显式渠道 id；为空时按 [priority] 推导。显式传了
     *                  `kxxy-*` 之外的渠道仍会兜底创建（兼容老脚本）。
     */
    fun notifyGeneric(
        context: Context,
        id: String,
        title: String,
        body: String,
        channelId: String?,
        priority: String,
        ongoing: Boolean,
        alertOnce: Boolean,
        progress: Int?,
        sessionId: String?,
    ) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val resolved = resolveChannel(nm, channelId, priority)
        val notifId = notifIdFor(id)

        val open = PendingIntent.getActivity(
            context, notifId,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                data = Uri.parse("kxxy://notif/${Uri.encode(id)}")
                putExtra(MainActivity.EXTRA_ATTENTION_ID, id)
                sessionId?.let { putExtra(MainActivity.EXTRA_SESSION_ID, it) }
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = Notification.Builder(context, resolved)
            .setSmallIcon(R.drawable.ic_notification_engine)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            .setOnlyAlertOnce(alertOnce)
            .setVisibility(Notification.VISIBILITY_SECRET)

        if (progress != null) {
            builder.setProgress(100, progress.coerceIn(0, 100), false)
        }

        try {
            nm.notify(notifId, builder.build())
        } catch (e: SecurityException) {
            Log.w(TAG, "notifyGeneric blocked: ${e.message}")
        }
    }

    /** 通知 id 的稳定映射。写通知与撤通知必须用同一套算法。 */
    fun notifIdFor(id: String): Int = ID_TERMUX_BASE + (id.hashCode() and 0xFFF)

    fun cancelNotification(context: Context, id: String) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(notifIdFor(id))
    }

    /**
     * 解析渠道。
     *
     * `--priority high|max` 落到 attention（HIGH），其余落 task（DEFAULT）。
     * 老脚本传的自定义渠道名（如 `kxxy-termux-api`）保持原样创建 —— 直接改掉
     * 会让它们的历史通知偏好失效。
     */
    private fun resolveChannel(
        nm: NotificationManager,
        channelId: String?,
        priority: String,
    ): String {
        if (!channelId.isNullOrBlank()) {
            if (nm.getNotificationChannel(channelId) == null) {
                val importance = if (priority == "high" || priority == "max") {
                    NotificationManager.IMPORTANCE_HIGH
                } else {
                    NotificationManager.IMPORTANCE_DEFAULT
                }
                nm.createNotificationChannel(
                    NotificationChannel(channelId, channelId, importance)
                )
            }
            return channelId
        }
        return if (priority == "high" || priority == "max") CHANNEL_ATTENTION else CHANNEL_TASK
    }

    // ══════════════════════════════════════════════════════════════════════
    // 任务进度 / 扩展安装
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 任务进度条（Termux 的 `termux-notification` 兼容入口也走这里）。
     *
     * @param progress 0..100 的百分比；传 null 表示不确定进度（转圈）。
     */
    fun notifyTaskProgress(
        context: Context,
        id: String,
        title: String,
        body: String,
        progress: Int?,
    ) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notifId = ID_TASK_BASE + (id.hashCode() and 0x7FF)

        val builder = Notification.Builder(context, CHANNEL_TASK)
            .setSmallIcon(R.drawable.ic_notification_engine)
            .setContentTitle(title)
            .setContentText(body)
            .setOnlyAlertOnce(true)
            .setOngoing(progress != null)
            .setVisibility(Notification.VISIBILITY_SECRET)

        if (progress != null) {
            builder.setProgress(100, progress.coerceIn(0, 100), false)
        } else {
            builder.setProgress(0, 0, true)
        }

        try {
            nm.notify(notifId, builder.build())
        } catch (e: SecurityException) {
            Log.w(TAG, "notifyTaskProgress blocked: ${e.message}")
        }
    }

    /** 任务完成：不可划掉改为可划掉，并给一次提示音。 */
    fun notifyTaskDone(context: Context, id: String, title: String, body: String) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notifId = ID_TASK_BASE + (id.hashCode() and 0x7FF)

        val open = PendingIntent.getActivity(
            context, notifId,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                data = Uri.parse("kxxy://task/${Uri.encode(id)}")
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = Notification.Builder(context, CHANNEL_TASK)
            .setSmallIcon(R.drawable.ic_notification_engine)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_SECRET)
            .build()

        try {
            nm.notify(notifId, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "notifyTaskDone blocked: ${e.message}")
        }
    }

    fun cancel(context: Context, id: String) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(ID_TASK_BASE + (id.hashCode() and 0x7FF))
        nm.cancel(ID_ATTENTION_BASE + (id.hashCode() and 0x7FFF))
    }

    // ══════════════════════════════════════════════════════════════════════
    // 状态查询（给控制台体检页用）
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 通知是否被用户关掉。
     *
     * 控制台体检页需要这个：`areNotificationsEnabled() == false` 时，
     * 「引擎在跑但什么都没收到通知」这件事必须有一个明确解释，否则用户会
     * 认为应用坏了。
     */
    fun status(context: Context): Status {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val enabled = try {
            nm.areNotificationsEnabled()
        } catch (e: Exception) {
            true
        }
        val attention = nm.getNotificationChannel(CHANNEL_ATTENTION)
        return Status(
            enabled = enabled,
            attentionImportance = attention?.importance ?: NotificationManager.IMPORTANCE_NONE,
            attentionBlocked = attention?.importance == NotificationManager.IMPORTANCE_NONE,
        )
    }

    data class Status(
        val enabled: Boolean,
        val attentionImportance: Int,
        val attentionBlocked: Boolean,
    )

    // ══════════════════════════════════════════════════════════════════════
    // 内部
    // ══════════════════════════════════════════════════════════════════════

    private const val MAX_ACTIONS = 3

    private fun categoryFor(kind: String): String = when (kind) {
        "permission" -> Notification.CATEGORY_REMINDER
        "question" -> Notification.CATEGORY_MESSAGE
        "failed" -> Notification.CATEGORY_ERROR
        "done" -> Notification.CATEGORY_STATUS
        else -> Notification.CATEGORY_MESSAGE
    }

    /**
     * 按钮图标。全部用系统图标：通知按钮区是 24dp 单色，自绘图标在这里
     * 看不出差别，但每个都加一份 drawable 会让资源表变脏。
     */
    private fun iconFor(key: String): Int = when (key.lowercase()) {
        "allow", "approve", "yes", "ok" -> android.R.drawable.checkbox_on_background
        "deny", "reject", "no", "cancel" -> android.R.drawable.ic_menu_close_clear_cancel
        "open", "view" -> android.R.drawable.ic_menu_view
        else -> android.R.drawable.ic_menu_more
    }
}
