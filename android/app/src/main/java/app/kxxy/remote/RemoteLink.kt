package app.kxxy.remote

import java.net.URI
import java.util.Locale

/**
 * 远程引擎连接串的解析与判定 —— 纯函数，没有 Android 依赖，便于单测。
 *
 * ## 为什么要有这一层
 *
 * 「手机控电脑」的入口只有一样东西：用户在电脑上拿到的一串 **连接串**。
 * 它可能是三种形态，且用户会从聊天记录/二维码/终端里以任意形式复制过来：
 *
 *   1. 连接器生成的配对地址：`http://192.168.1.23:8080/__kxxy_pair?code=7f3a-9c21`
 *   2. 引擎直连（电脑上把 dsh 绑到局域网 IP 并信任该 host）：
 *      `http://192.168.1.23:3080/?token=…`
 *   3. 隧道域名：`https://kxxy-mac.tail1a2b3c.ts.net/?token=…`
 *
 * 三者对「连接」这一步没有区别 —— 都是「用 WebView 打开这个 URL」。
 * 但**放行**这一步差别很大：WebView 默认只允许回环地址留在应用内，
 * 其余一律丢给系统浏览器。所以我们必须能从 URL 里稳定地算出
 * 「这台设备的来源（origin）」，把它记成白名单条目。
 *
 * ## 安全边界
 *
 * 允许用户手填任意域名，看起来宽松，但这是**用户显式信任**的语义 ——
 * 与「自动信任局域网内任何主机」完全不同。后者才是危险的那件事
 * （任意 WiFi 下都可能有一台同名设备等着被连上）。
 */
object RemoteLink {

    /** 远端身份：`scheme://host[:port]`，用于白名单比对，不含路径与 query。 */
    data class Parsed(
        /** 规范化后的完整连接串（带 token/code，用于真正加载）。 */
        val url: String,
        /** `scheme://host[:port]`，默认端口省略。 */
        val origin: String,
        val host: String,
        val port: Int,
        val secure: Boolean,
        /** `lan` | `tunnel` —— 只影响界面徽章与文案，不影响连接方式。 */
        val kind: String,
    )

    /**
     * 解析用户输入。
     *
     * 容错顺序刻意这么排：先按原样试，再去掉包裹的引号/尖括号，最后补 scheme。
     * 用户从终端复制时经常带上 `<>`（README 里写 `<你的地址>`）或成对引号，
     * 直接 `URI()` 会抛异常 —— 那会让「粘贴了却连不上」变成一个无解的报障。
     *
     * @return 解析失败返回 null（调用方负责提示），不抛异常。
     */
    fun parse(raw: String?): Parsed? {
        val trimmed = cleanup(raw ?: return null)
        if (trimmed.isEmpty()) return null

        val withScheme = when {
            trimmed.startsWith("http://", true) || trimmed.startsWith("https://", true) -> trimmed
            // 裸 host[:port] / host[:port]/path —— 一律按 http 补全。
            // 公网域名走 http 会在实际加载时才失败（连接器/隧道通常是 https，
            // 用户手打时漏了 s）；这里不猜，交给服务端 301 去纠正。
            else -> "http://$trimmed"
        }

        val uri = runCatching { URI(withScheme) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
        if (scheme != "http" && scheme != "https") return null

        val host = uri.host?.lowercase(Locale.ROOT)?.trimEnd('.') ?: return null
        if (host.isEmpty()) return null

        val defaultPort = if (scheme == "https") 443 else 80
        val port = if (uri.port > 0) uri.port else defaultPort

        // 连接串必须带认证信息，否则打开只会看到 401 —— 与其让用户面对一个
        // 英文 401 页面，不如在添加时就拒绝并说清楚「少了 token / 配对码」。
        if (!hasCredential(uri)) return null

        val hostForOrigin = if (host.contains(':')) "[$host]" else host
        val origin = if (port == defaultPort) "$scheme://$hostForOrigin" else "$scheme://$hostForOrigin:$port"

        return Parsed(
            url = withScheme,
            origin = origin,
            host = host,
            port = port,
            secure = scheme == "https",
            kind = if (isPrivateHost(host)) "lan" else "tunnel",
        )
    }

    /** 从任意 URL 取出 origin，用于「这个请求是否属于已配对设备」的判定。 */
    fun originOf(url: String): String? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
        val host = uri.host?.lowercase(Locale.ROOT)?.trimEnd('.') ?: return null
        if (host.isEmpty()) return null
        val defaultPort = if (scheme == "https") 443 else 80
        val port = if (uri.port > 0) uri.port else defaultPort
        val hostForOrigin = if (host.contains(':')) "[$host]" else host
        return if (port == defaultPort) "$scheme://$hostForOrigin" else "$scheme://$hostForOrigin:$port"
    }

    /**
     * 是否私有/本地网段地址。
     *
     * 只做字面量判断（不做 DNS 解析）—— 这是刻意的：解析域名会引入
     * 一次网络往返，而这里是同步路径；且「域名指向 192.168.x」这种情况
     * 走 tunnel 徽章也完全无害，仅仅是个标签。
     */
    fun isPrivateHost(host: String): Boolean {
        val h = host.lowercase(Locale.ROOT)
        if (h == "localhost" || h.endsWith(".local") || h.endsWith(".lan")) return true
        // IPv6 链路本地 fe80::/10 与唯一本地 fc00::/7
        if (h.contains(':')) {
            return h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd") ||
                h == "::1"
        }
        val parts = h.split('.')
        if (parts.size != 4) return false
        val nums = parts.map { it.toIntOrNull() ?: return false }
        if (nums.any { it < 0 || it > 255 }) return false
        return when {
            nums[0] == 10 -> true
            nums[0] == 127 -> true
            nums[0] == 192 && nums[1] == 168 -> true
            nums[0] == 172 && nums[1] in 16..31 -> true
            // Android 热点（SoftAP）常见网段
            nums[0] == 192 && nums[1] == 0 && nums[2] == 2 -> true
            else -> false
        }
    }

    /** 是否带 token / 配对码 —— 两种形态任一即可。 */
    private fun hasCredential(uri: URI): Boolean {
        val query = uri.rawQuery ?: return false
        for (pair in query.split('&')) {
            val key = pair.substringBefore('=', "").lowercase(Locale.ROOT)
            val value = pair.substringAfter('=', "")
            if (value.isEmpty()) continue
            if (key == "token" || key == "code" || key == "pair" || key == "key") return true
        }
        return false
    }

    /** 去掉首尾空白、包裹引号、尖括号，以及误粘进来的终端提示符。 */
    private fun cleanup(raw: String): String {
        var s = raw.trim()
        // 整串被引号/括号包住
        s = s.trim('`', '\'', '"', '<', '>', ' ')
        // 有的终端会把命令和输出粘在一起：`$ curl … \n http://…`
        if (s.contains('\n') || s.contains(' ')) {
            val hit = s.split('\n', ' ').lastOrNull { it.startsWith("http", true) || it.contains("://") }
            if (hit != null) s = hit.trim('`', '\'', '"', '<', '>', ' ')
        }
        return s
    }
}
