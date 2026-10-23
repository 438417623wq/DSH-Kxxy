package app.kxxy.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import app.kxxy.engine.EngineConfig
import java.io.File
import java.nio.charset.StandardCharsets

/**
 * 通知按钮的回执写入器（方案 B3）。
 *
 * ── 为什么要绕一个广播 ──────────────────────────────────────────────────
 *
 * 通知按钮的点击本质上是一次「来自后台的触发」。Android 12 起禁止从后台启动
 * 前台服务，所以按钮的 [android.app.PendingIntent] **不能用 `getService`**
 * —— 那会在真机上抛 `ForegroundServiceStartNotAllowedException`，而且因为
 * 异常发生在系统进程里，应用侧连个崩溃都看不到，只表现为「点了没反应」。
 *
 * 广播没有这个限制。而这里要做的事确实很轻：往 `engine/attention/` 写一个
 * 几十字节的 JSON 文件，然后撤掉那条通知。真正处理逻辑在引擎进程里，它按
 * 已有的轮询节奏（`EngineSupervisor.startRequestWatcher`，与 restart/stdin/
 * recovery 三种请求同一套写法）发现回执文件并取走。
 *
 * ── 为什么不用 startActivity 直接回前端 ──────────────────────────────────
 *
 * 因为按钮可能是在应用被划掉、屏幕锁着的时候点的。拉起 Activity 会打断用户
 * 当前在做的事；而写文件这条路在引擎进程还活着时一定成功，引擎死了也会留在
 * 磁盘上等下次启动被读到（`recovery` 请求用的是同一套「先落盘再处理」的思路）。
 *
 * ── 幂等与去重 ─────────────────────────────────────────────────────────
 *
 * 回执文件名里带请求 id 的哈希，同一个按钮点两次只会覆盖同一个文件；引擎侧
 * 读完即删。即使两个进程同时写，也是写各自不同的目标文件，互不干扰。
 */
class AttentionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_RESPONSE) return

        val attentionId = intent.getStringExtra(EXTRA_ATTENTION_ID) ?: return
        val actionKey = intent.getStringExtra(EXTRA_ACTION_KEY) ?: return
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)

        Log.i(TAG, "attention response: id=$attentionId action=$actionKey")

        runCatching { writeResponse(context, attentionId, actionKey, sessionId) }
            .onFailure { Log.w(TAG, "failed to write attention response: ${it.message}") }

        // 不论写文件成功与否都要撤掉通知：让用户看到「点过了」比「静默失败
        // 然后一直挂着」要好 —— 后端没收到时引擎会重新投递一条新的。
        Notifier.cancelAttention(context, attentionId)

        // 同时清掉 engine/attention/ 下的 active 记录：控制台的「待确认」
        // 卡片以它为准，不清的话用户回答完还会看到一个已经处理过的请求。
        runCatching {
            val dir = File(EngineConfig.engineRoot(context), DIR_NAME)
            val safe = attentionId.replace(Regex("[^A-Za-z0-9._-]"), "_").take(64)
            File(dir, "active-$safe.json").delete()
        }
    }

    private fun writeResponse(
        context: Context,
        attentionId: String,
        actionKey: String,
        sessionId: String?,
    ) {
        val root = EngineConfig.engineRoot(context)
        val dir = File(root, DIR_NAME).apply { if (!exists()) mkdirs() }

        // 文件名只保留安全字符：id 由引擎给，可能是 UUID 也可能是任意字符串，
        // 直接拼进路径会被 `/` 或 `..` 弄出目录穿越。
        val safe = attentionId.replace(Regex("[^A-Za-z0-9._-]"), "_").take(64)
        val target = File(dir, "response-$safe-$SUB.json")

        val json = buildString {
            append("{\n")
            append("  \"id\": ").append(quote(attentionId)).append(",\n")
            append("  \"action\": ").append(quote(actionKey)).append(",\n")
            sessionId?.let { append("  \"sessionId\": ").append(quote(it)).append(",\n") }
            append("  \"answeredAt\": ").append(System.currentTimeMillis()).append(",\n")
            append("  \"source\": \"notification\"\n")
            append("}\n")
        }

        // 原子写：先写 .tmp 再 rename。引擎可能正好在轮询，看到半截 JSON 会
        // 解析失败并把整个请求丢掉 —— 这与 recovery 结果文件的写法一致。
        val tmp = File(dir, target.name + ".tmp")
        tmp.writeText(json, StandardCharsets.UTF_8)
        if (!tmp.renameTo(target)) {
            target.writeText(json, StandardCharsets.UTF_8)
            tmp.delete()
        }
        Log.i(TAG, "attention response written: ${target.name}")
    }

    /** 最小 JSON 字符串转义（只需要处理我们自己会产生的字符）。 */
    private fun quote(value: String): String {
        val sb = StringBuilder(value.length + 2)
        sb.append('"')
        for (ch in value) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        sb.append('"')
        return sb.toString()
    }

    companion object {
        private const val TAG = "KxxyAttention"

        /** 广播 action。 */
        const val ACTION_RESPONSE = "app.kxxy.service.action.ATTENTION_RESPONSE"

        const val EXTRA_ATTENTION_ID = "kxxy.extra.attention_id"
        const val EXTRA_ACTION_KEY = "kxxy.extra.action_key"
        const val EXTRA_SESSION_ID = "kxxy.extra.session_id"

        /** 引擎根目录下的子目录名，与 kxxy-host 侧约定一致。 */
        const val DIR_NAME = "attention"

        /** 文件名后缀，防止与将来其他类型的回执撞名。 */
        private const val SUB = "response"
    }
}
