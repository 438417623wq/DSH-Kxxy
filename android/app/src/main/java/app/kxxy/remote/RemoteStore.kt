package app.kxxy.remote

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * 远程设备清单（「手机控电脑」的设备簿）。
 *
 * ## 存在哪里、为什么
 *
 * 放在原生 SharedPreferences，而不是前端 localStorage —— 原因很具体：
 * 连接建立后 WebView 加载的是**远端页面**，本地前端的 localStorage 在另一个
 * origin 下，远端页面根本读不到；而用户点「断开」回到本地时，本地前端是
 * 重新加载的。只有原生侧才能在两种模式之间保持这份清单。
 *
 * ## 凭证不落 state
 *
 * 连接串里带 token / 配对码。`snapshotJson()` 里出现的连接串**一律脱敏**：
 * 它会经 `kxxy-state.json` 落盘、再被 `/kxxy/api/state` 吐给前端，
 * 而 state 文件对插件是可读的。真正加载用的完整 URL 只在 `devices()` 里，
 * 由原生直接交给 WebView，不经过任何 JS 侧通道。
 */
object RemoteStore {

    private const val TAG = "KxxyRemote"
    private const val PREFS = "kxxy-remote"
    private const val KEY_DEVICES = "devices"
    private const val KEY_LAST_USED = "lastUsedId"
    private const val KEY_ERROR_SEQ = "errorSeq"
    private const val KEY_ERROR_MSG = "errorMsg"

    /** 一台已配对设备。`url` 含凭证，**不要**直接下发给页面。 */
    data class Device(
        val id: String,
        val label: String,
        val url: String,
        val origin: String,
        val kind: String,
        val secure: Boolean,
        val lastUsedAt: Long,
        val ok: Boolean,
    ) {
        val displayHost: String
            get() = origin.substringAfter("://")

        /** 纯主机名（不含端口）—— SSL 例外判定按 host 比对，不是 origin。 */
        val host: String
            get() {
                val afterScheme = origin.substringAfter("://")
                return if (afterScheme.startsWith("[")) {
                    afterScheme.substringAfter('[').substringBefore(']')
                } else {
                    afterScheme.substringBefore(':')
                }
            }
    }

    fun devices(ctx: Context): List<Device> {
        val raw = prefs(ctx).getString(KEY_DEVICES, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        val out = ArrayList<Device>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val url = o.optString("url")
            if (url.isEmpty()) continue
            out += Device(
                id = o.optString("id").ifEmpty { UUID.randomUUID().toString() },
                label = o.optString("label", "未命名设备"),
                url = url,
                origin = o.optString("origin").ifEmpty { RemoteLink.originOf(url).orEmpty() },
                kind = o.optString("kind", "lan"),
                secure = o.optBoolean("secure", url.startsWith("https://")),
                lastUsedAt = o.optLong("lastUsedAt", 0L),
                ok = o.optBoolean("ok", true),
            )
        }
        return out.sortedByDescending { it.lastUsedAt }
    }

    /**
     * 添加或更新一台设备。
     *
     * 去重键是 **origin** 而不是完整 URL：同一台电脑重新生成配对码后 origin
     * 不变、凭证变了，此时应该覆盖旧记录而不是多出一条「工作室的 Mac（2）」，
     * 否则用户每次重开连接器都要手工删一次旧条目。
     */
    fun upsert(ctx: Context, parsed: RemoteLink.Parsed, label: String?): Device {
        val now = System.currentTimeMillis()
        val list = devices(ctx).toMutableList()
        val idx = list.indexOfFirst { it.origin == parsed.origin }
        val resolvedLabel = label?.trim()?.takeIf { it.isNotEmpty() }
            ?: list.getOrNull(idx)?.label
            ?: suggestLabel(parsed)

        val device = Device(
            id = list.getOrNull(idx)?.id ?: UUID.randomUUID().toString(),
            label = resolvedLabel,
            url = parsed.url,
            origin = parsed.origin,
            kind = parsed.kind,
            secure = parsed.secure,
            lastUsedAt = now,
            ok = true,
        )
        if (idx >= 0) list[idx] = device else list += device
        write(ctx, list)
        prefs(ctx).edit().putString(KEY_LAST_USED, device.id).apply()
        Log.i(TAG, "upsert ${device.label} @ ${device.origin}")
        return device
    }

    fun remove(ctx: Context, id: String) {
        val list = devices(ctx).filterNot { it.id == id }
        write(ctx, list)
        if (prefs(ctx).getString(KEY_LAST_USED, null) == id) {
            prefs(ctx).edit().putString(KEY_LAST_USED, list.firstOrNull()?.id).apply()
        }
    }

    fun rename(ctx: Context, id: String, label: String) {
        val list = devices(ctx).map { if (it.id == id) it.copy(label = label) else it }
        write(ctx, list)
    }

    /** 记录一次连接结果 —— 列表里那台设备会显示「上次连接失败」。 */
    fun markUsed(ctx: Context, id: String, ok: Boolean) {
        val list = devices(ctx).map {
            if (it.id == id) it.copy(lastUsedAt = System.currentTimeMillis(), ok = ok) else it
        }
        write(ctx, list)
        prefs(ctx).edit().putString(KEY_LAST_USED, id).apply()
    }

    fun find(ctx: Context, id: String): Device? = devices(ctx).firstOrNull { it.id == id }

    fun lastUsedId(ctx: Context): String? = prefs(ctx).getString(KEY_LAST_USED, null)

    /** 该 URL 是否属于已配对设备（含子资源与 WebSocket）。 */
    fun isTrustedUrl(ctx: Context, url: String): Boolean {
        val origin = RemoteLink.originOf(url) ?: return false
        return devices(ctx).any { it.origin == origin }
    }

    /**
     * 下发给前端的快照。**凭证已脱敏**，见文件头注释。
     *
     * 时间字段给的是相对描述所需的时间戳（毫秒），由前端换算成
     * 「3 分钟前」——本地时区/语言交给页面，原生不参与文案。
     */
    fun snapshotJson(ctx: Context): String {
        val list = devices(ctx)
        val arr = JSONArray()
        for (d in list) {
            arr.put(
                JSONObject().apply {
                    put("id", d.id)
                    put("label", d.label)
                    put("host", d.displayHost)
                    put("origin", d.origin)
                    put("kind", d.kind)
                    put("secure", d.secure)
                    put("urlMasked", maskCredential(d.url))
                    put("lastUsedAt", d.lastUsedAt)
                    put("ok", d.ok)
                },
            )
        }
        return JSONObject().apply {
            put("devices", arr)
            put("lastUsedId", lastUsedId(ctx) ?: JSONObject.NULL)
            put("count", list.size)
            put(
                "error",
                JSONObject().apply {
                    put("seq", prefs(ctx).getLong(KEY_ERROR_SEQ, 0L))
                    put("message", prefs(ctx).getString(KEY_ERROR_MSG, "").orEmpty())
                },
            )
        }.toString()
    }

    /** 把 query 里的 token/code 值换成一串圆点，保留结构以便用户核对地址。 */
    fun maskCredential(url: String): String {
        val q = url.indexOf('?')
        if (q < 0) return url
        val base = url.substring(0, q)
        val query = url.substring(q + 1)
        val masked = query.split('&').joinToString("&") { pair ->
            val key = pair.substringBefore('=')
            val value = pair.substringAfter('=', "")
            val sensitive = key.lowercase() in setOf("token", "code", "pair", "key")
            if (sensitive && value.isNotEmpty()) "$key=••••••" else pair
        }
        return "$base?$masked"
    }

    private fun suggestLabel(parsed: RemoteLink.Parsed): String {
        val host = parsed.host
        return when {
            parsed.kind == "lan" -> "局域网设备 · $host"
            host.endsWith(".ts.net") -> "Tailscale · ${host.substringBefore('.')}"
            host.contains("trycloudflare") -> "Cloudflare 隧道"
            else -> host
        }
    }

    private fun write(ctx: Context, list: List<Device>) {
        val arr = JSONArray()
        for (d in list) {
            arr.put(
                JSONObject().apply {
                    put("id", d.id)
                    put("label", d.label)
                    put("url", d.url)
                    put("origin", d.origin)
                    put("kind", d.kind)
                    put("secure", d.secure)
                    put("lastUsedAt", d.lastUsedAt)
                    put("ok", d.ok)
                },
            )
        }
        prefs(ctx).edit().putString(KEY_DEVICES, arr.toString()).apply()
    }

    /**
     * 记一条「上一次操作失败」的消息。
     *
     * 走这个通道而不是原生 Toast：桥是单向的，拿不到返回值，而前端本来就在
     * 轮询 state。带自增序号是为了让前端能分辨「这是新错误」还是「同一条
     * 消息又被读了一遍」—— 否则每次轮询都会弹一次，用户会以为在刷屏。
     */
    fun noteError(ctx: Context, message: String) {
        val seq = prefs(ctx).getLong(KEY_ERROR_SEQ, 0L) + 1
        prefs(ctx).edit()
            .putLong(KEY_ERROR_SEQ, seq)
            .putString(KEY_ERROR_MSG, message)
            .apply()
        Log.w(TAG, "remote error #$seq: $message")
    }

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
