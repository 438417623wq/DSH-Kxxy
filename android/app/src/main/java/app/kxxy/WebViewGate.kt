package app.kxxy

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log

/**
 * WebView 版本门禁。
 *
 * 为什么必须做：官方前端用了 `??=` 等**解析期**语法，polyfill 补不了。
 * 低于 Chrome 85 的设备会直接白屏（日志里只有一句 SyntaxError）。
 * 与其让用户面对白屏，不如前置检测并给出明确升级指引。
 *
 * 版本探测不用 `WebView.getCurrentWebViewPackage()` —— 参考项目记录该
 * 官方 API「实测有坑」，改为扫 provider 包名。
 */
object WebViewGate {

    /** 官方前端实际门槛：补齐 19 个 API guard 后降到 Chrome 85。 */
    const val MIN_CHROME_MAJOR = 85

    private const val TAG = "KxxyWebViewGate"

    /** 系统 WebView 的候选 provider 包名。 */
    private val PROVIDERS = listOf(
        "com.google.android.webview",
        "com.android.webview",
        "com.google.android.webview.beta",
        "com.google.android.webview.dev",
        "com.google.android.webview.canary",
        "com.android.chrome",
        "com.huawei.webview",
        "com.miui.webview",
    )

    /**
     * 检测 WebView 主版本号。
     *
     * 返回 null 表示无法确定 —— 此时**放行**（宁可尝试后白屏，
     * 也不要因为探测失败把可用设备挡在门外）。
     */
    fun chromeMajor(ctx: Context): Int? {
        val pm = ctx.packageManager
        for (pkg in PROVIDERS) {
            try {
                val info = pm.getPackageInfo(pkg, 0)
                val ver = info.versionName ?: continue
                // 版本形如 "120.0.6099.144"
                val major = ver.substringBefore('.').toIntOrNull()
                if (major != null && major > 0) {
                    Log.i(TAG, "webview provider=$pkg version=$ver major=$major")
                    return major
                }
            } catch (e: PackageManager.NameNotFoundException) {
                continue
            }
        }
        Log.w(TAG, "no webview provider found")
        return null
    }

    /** 是否满足官方前端的最低要求。探测失败时放行。 */
    fun isSupported(ctx: Context): Boolean {
        val major = chromeMajor(ctx) ?: return true
        return major >= MIN_CHROME_MAJOR
    }
}
