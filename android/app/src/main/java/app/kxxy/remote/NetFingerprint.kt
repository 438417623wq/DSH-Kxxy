package app.kxxy.remote

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * 「现在处于什么网络」的轻量指纹。
 *
 * ## 为什么不取 SSID
 *
 * 拿 WiFi 名字（`getConnectionInfo().ssid`）在 Android 10+ 需要
 * `ACCESS_FINE_LOCATION`，而且被授予后系统会持续把它当成定位权限来审计。
 * 为了一个「自动连」多要一个位置权限，收益和代价完全不成比例 ——
 * 用户看到的是「一个远程控制 App 要我的位置」，信任成本远高于省下的那一次点击。
 *
 * 所以这里只用**零权限**的信息：
 *
 *   transport（wifi / cell / eth） + 内网地址前三段
 *
 * 家庭 WiFi 是 `wifi:192.168.1`、公司是 `wifi:10.12.3`、4G 是 `cell`。
 * 这个粒度正好对应「同样的环境」这句话在用户脑子里的含义，而且换了 WiFi
 * 名字但同一个网段时仍然算同一环境 —— 那恰恰是我们想要的。
 *
 * ## 拿不到就返回 null
 *
 * 调用方（[RemoteStore.fingerprintMatches]）把 null 当作「不限制」。
 * 反过来把「拿不到」当「不匹配」会让虚拟网卡、飞行模式切换瞬间这些情况
 * 变成「自动连时灵时不灵」，而用户完全无从排查。
 */
object NetFingerprint {

    fun current(ctx: Context): String? {
        val cm = ctx.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return null
        val caps = usableCaps(cm) ?: return null

        val transport = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "eth"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cell"
            else -> return null
        }
        // 蜂窝网络的内网地址每拨一次号就变，带上它等于让指纹永远不匹配；
        // 而且「在 4G 下连局域网设备」本来就不可能成功。
        if (transport == "cell") return transport
        val prefix = lanPrefix() ?: return transport
        return "$transport:$prefix"
    }

    /**
     * 活动网络的 capabilities。
     *
     * 单独抽出来是因为 Tailscale / 其它 VPN 在场时 `activeNetwork` 是那条
     * VPN，`hasTransport(WIFI)` 会变成 false —— 于是「开着 Tailscale 在家」
     * 会被判成陌生网络，局域网那台就不自动连了。这种情况退回 `allNetworks`
     * 里找一条真实链路，语义上更接近用户说的「现在在哪个网里」。
     */
    private fun usableCaps(cm: ConnectivityManager): NetworkCapabilities? {
        val active = cm.activeNetwork?.let { runCatching { cm.getNetworkCapabilities(it) }.getOrNull() }
        if (active != null && !active.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return active
        return runCatching {
            cm.allNetworks
                .mapNotNull { cm.getNetworkCapabilities(it) }
                .firstOrNull {
                    it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                        it.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ||
                        it.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                }
        }.getOrNull() ?: active
    }

    /** 本机某个私有 IPv4 地址的前三段，例如 `192.168.1`。 */
    private fun lanPrefix(): String? {
        return runCatching {
            NetworkInterface.getNetworkInterfaces().asSequence()
                .filter { it.isUp && !it.isLoopback && !it.isVirtual }
                .flatMap { it.inetAddresses.asSequence() }
                .filterIsInstance<Inet4Address>()
                .firstOrNull { it.isSiteLocalAddress }
                ?.hostAddress
                ?.split('.')
                ?.take(3)
                ?.joinToString(".")
        }.getOrNull()
    }
}
