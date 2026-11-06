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
    private const val KEY_COOLDOWN = "autoCooldownUntil"
    private const val KEY_AUTO_BACKOFF = "autoBackoffUntil"

    /**
     * 手动断开后的自动连冷却（毫秒）。
     *
     * 这条不是节流，是**语义**：用户点「断开」的意思是「现在不要连」。
     * 没有冷却的话，退出远程回到本机页 → 页面重新拉起 → 自动连逻辑立刻
     * 又把他拽回去，按钮看起来就是坏的。
     */
    private const val DISCONNECT_COOLDOWN_MS = 10 * 60 * 1000L

    /** 连续失败到这个次数就不再自动重试，交回给用户手动点。 */
    private const val MAX_AUTO_FAILS = 2

    /**
     * 一次自动连接失败后的退避窗口。
     *
     * 失败会把用户送回本机页，而本机页重新加载后又会读一次快照 ——
     * 没有这段窗口，`failStreak` 还没到 2 的时候就会立刻再试一次，
     * 用户看到的是「页面闪两下」。60 秒足够让人把电脑唤醒或换个网络。
     */
    private const val AUTO_RETRY_BACKOFF_MS = 60_000L

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
        /**
         * 用户显式信任 —— 自动连接的前提。
         *
         * 只在**一次真正加载成功之后**才允许授予（见 MainActivity 的
         * onPageFinished 路径）：否则扫到一条死链就会被固化成「每次启动都
         * 白等几秒」的默认行为。
         */
        val trusted: Boolean = false,
        /** 连续自动连接失败次数，成功一次清零。达到 [MAX_AUTO_FAILS] 即降级为手动。 */
        val failStreak: Int = 0,
        /** 最近一次**成功**加载的时间。0 表示从来没成功过。 */
        val lastOkAt: Long = 0L,
        /**
         * 上次成功时的网络指纹（`wifi:192.168.1` / `cell:10.12` …）。
         *
         * 用来回答「同样的环境」—— 但只作为**提示**而非硬门槛：拿不到指纹
         * （无权限、无网络、虚拟网卡）时一律放行，否则用户会遇到「明明该自动
         * 连却没连」这种无从排查的状态。
         */
        val netFingerprint: String? = null,
        /** 用户点过「以后再说」，别再拿信任提示烦他。 */
        val trustPromptSkipped: Boolean = false,
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
                trusted = o.optBoolean("trusted", false),
                failStreak = o.optInt("failStreak", 0),
                lastOkAt = o.optLong("lastOkAt", 0L),
                netFingerprint = o.optString("netFingerprint").takeIf { it.isNotEmpty() },
                trustPromptSkipped = o.optBoolean("trustPromptSkipped", false),
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
        val existing = list.getOrNull(idx)
        val resolvedLabel = label?.trim()?.takeIf { it.isNotEmpty() }
            ?: existing?.label
            ?: suggestLabel(parsed)

        val device = Device(
            id = existing?.id ?: UUID.randomUUID().toString(),
            label = resolvedLabel,
            url = parsed.url,
            origin = parsed.origin,
            kind = parsed.kind,
            secure = parsed.secure,
            lastUsedAt = now,
            ok = true,
            // 信任状态与失败计数**必须**从旧记录继承。
            //
            // 重新配对（连接器重启换了配对码 → 用户重新扫码）走的就是这条路：
            // 如果这里按默认值重建，用户每次换码后都要重新勾一次「自动连接」，
            // 而那恰恰是他最常用的路径。
            trusted = existing?.trusted ?: false,
            failStreak = existing?.failStreak ?: 0,
            lastOkAt = existing?.lastOkAt ?: 0L,
            netFingerprint = existing?.netFingerprint,
            trustPromptSkipped = existing?.trustPromptSkipped ?: false,
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

    /**
     * 记录一次连接结果 —— 列表里那台设备会显示「上次连接失败」。
     *
     * `ok=true` 的语义是**真的把页面加载出来了**（MainActivity 在
     * onPageFinished 里调用），不是「用户点了一下连接」。这个区分决定了
     * 自动连接会不会把一条死链当成可用设备反复重试。
     */
    fun markUsed(ctx: Context, id: String, ok: Boolean) {
        val now = System.currentTimeMillis()
        val list = devices(ctx).map {
            if (it.id != id) {
                it
            } else if (ok) {
                it.copy(
                    lastUsedAt = now,
                    ok = true,
                    lastOkAt = now,
                    failStreak = 0,
                    netFingerprint = NetFingerprint.current(ctx) ?: it.netFingerprint,
                )
            } else {
                it.copy(lastUsedAt = now, ok = false, failStreak = it.failStreak + 1)
            }
        }
        write(ctx, list)
        prefs(ctx).edit().putString(KEY_LAST_USED, id).apply()
    }

    /** 开关「信任这台电脑」（= 允许下次自动连接）。 */
    fun setTrusted(ctx: Context, id: String, trusted: Boolean) {
        val list = devices(ctx).map {
            if (it.id != id) {
                it
            } else {
                it.copy(
                    trusted = trusted,
                    // 重新信任时把失败计数清掉：用户此刻是明确表达「还要再自动连」，
                    // 保留旧的 2 次失败会让开关看起来没生效。
                    failStreak = if (trusted) 0 else it.failStreak,
                )
            }
        }
        write(ctx, list)
        Log.i(TAG, "trusted=$trusted for $id")
    }

    /** 用户对信任提示点了「以后再说」。 */
    fun skipTrustPrompt(ctx: Context, id: String) {
        write(ctx, devices(ctx).map { if (it.id == id) it.copy(trustPromptSkipped = true) else it })
    }

    /** 手动断开后进入冷却：这段时间内不自动连。 */
    fun startCooldown(ctx: Context) {
        prefs(ctx).edit()
            .putLong(KEY_COOLDOWN, System.currentTimeMillis() + DISCONNECT_COOLDOWN_MS)
            .apply()
    }

    fun cooldownUntil(ctx: Context): Long = prefs(ctx).getLong(KEY_COOLDOWN, 0L)

    /** 一次自动连接失败后的静默窗口（见 [AUTO_RETRY_BACKOFF_MS]）。 */
    fun startAutoBackoff(ctx: Context) {
        prefs(ctx).edit()
            .putLong(KEY_AUTO_BACKOFF, System.currentTimeMillis() + AUTO_RETRY_BACKOFF_MS)
            .apply()
    }

    /**
     * 挑一台可以自动连的设备，没有就返回 null。
     *
     * 判定顺序刻意如此：先看冷却（用户意愿最高），再看信任，再看失败降级，
     * 最后才是网络指纹。每一条都短，因为任何一条判断错都会变成「App 一开
     * 就自作主张」或者「明明该连却不动」—— 两种都很难让用户自己归因。
     */
    fun autoCandidate(ctx: Context): Device? {
        val now = System.currentTimeMillis()
        if (cooldownUntil(ctx) > now) return null
        if (prefs(ctx).getLong(KEY_AUTO_BACKOFF, 0L) > now) return null
        val list = devices(ctx)
        val lastId = lastUsedId(ctx)
        val ordered = list.sortedByDescending { if (it.id == lastId) Long.MAX_VALUE else it.lastUsedAt }
        val fp = NetFingerprint.current(ctx)
        return ordered.firstOrNull { d ->
            d.trusted &&
                d.failStreak < MAX_AUTO_FAILS &&
                d.lastOkAt > 0 &&
                fingerprintMatches(d, fp)
        }
    }

    /**
     * 网络指纹比对。
     *
     * 隧道设备一律放行：它的地址本来就不依赖当前网段，用户在外网用 4G 连
     * 家里电脑是**正常用法**，拿网段去卡它只会制造「在家能自动连、出门不能」。
     */
    private fun fingerprintMatches(device: Device, current: String?): Boolean {
        if (device.kind == "tunnel") return true
        val recorded = device.netFingerprint ?: return true
        if (current == null) return true
        return recorded == current
    }

    /**
     * 「刚才连上了，要不要以后自动连」的提示对象。
     *
     * 只在**成功过、还没信任、也没被拒绝过**时才给 —— 这就是「我连接之后
     * 要能保存方案」这句话真正的落点：提示出现在用户刚连上、最想要这个
     * 能力的时刻，而不是藏进设置里。
     */
    fun trustTip(ctx: Context): Device? {
        val lastId = lastUsedId(ctx) ?: return null
        val d = devices(ctx).firstOrNull { it.id == lastId } ?: return null
        if (d.trusted || d.trustPromptSkipped || d.lastOkAt <= 0 || !d.ok) return null
        return d
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
                    put("trusted", d.trusted)
                    put("failStreak", d.failStreak)
                    put("lastOkAt", d.lastOkAt)
                },
            )
        }
        val auto = autoCandidate(ctx)
        val tip = trustTip(ctx)
        return JSONObject().apply {
            put("devices", arr)
            put("lastUsedId", lastUsedId(ctx) ?: JSONObject.NULL)
            put("count", list.size)
            // 自动连接与信任提示**都由原生判定**，页面只负责画。
            // 反过来（前端自己算）会让「冷却、失败降级、网络指纹」这三条规则
            // 在 JS 与 Kotlin 里各存一份，改一处忘一处就是线上不一致。
            put(
                "autoConnect",
                if (auto == null) {
                    JSONObject.NULL
                } else {
                    JSONObject().apply {
                        put("id", auto.id)
                        put("label", auto.label)
                    }
                },
            )
            put(
                "trustTip",
                if (tip == null) {
                    JSONObject.NULL
                } else {
                    JSONObject().apply {
                        put("id", tip.id)
                        put("label", tip.label)
                    }
                },
            )
            put("cooldownUntil", cooldownUntil(ctx))
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
                    put("trusted", d.trusted)
                    put("failStreak", d.failStreak)
                    put("lastOkAt", d.lastOkAt)
                    d.netFingerprint?.let { put("netFingerprint", it) }
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
