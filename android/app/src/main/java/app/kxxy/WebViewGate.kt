package app.kxxy

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.util.Log
import android.webkit.WebView

/** WebView 版本门禁；系统实际 provider 优先，候选包扫描只作兜底。 */
object WebViewGate {

    /** 官方前端实际门槛：补齐 19 个 API guard 后降到 Chrome 85。 */
    const val MIN_CHROME_MAJOR = 85

    private const val TAG = "KxxyWebViewGate"

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

    // minSdk=26；该 API 查询当前/选定的包，不创建 WebView，也不加载网页。
    private fun actualProvider(): PackageInfo? = try {
        WebView.getCurrentWebViewPackage()
    } catch (e: RuntimeException) {
        Log.w(TAG, "actual provider query unavailable: ${e.javaClass.simpleName}")
        null
    } catch (e: LinkageError) {
        Log.w(TAG, "actual provider query unavailable: ${e.javaClass.simpleName}")
        null
    }

    private fun major(info: PackageInfo): Int? =
        info.versionName?.substringBefore('.')?.toIntOrNull()?.takeIf { it > 0 }

    /** 无法确定时放行；实际 provider 版本未知时不拿另一个已安装包冒充它。 */
    fun chromeMajor(ctx: Context): Int? {
        val actual = actualProvider()
        if (actual != null) {
            Log.i(TAG, "actual provider=${actual.packageName} version=${actual.versionName}")
            return major(actual)
        }
        for (pkg in PROVIDERS) {
            try {
                val info = ctx.packageManager.getPackageInfo(pkg, 0)
                val value = major(info) ?: continue
                Log.i(TAG, "fallback candidate=$pkg version=${info.versionName} major=$value (actual unknown)")
                return value
            } catch (_: PackageManager.NameNotFoundException) {
                continue
            } catch (_: SecurityException) {
                continue
            }
        }
        Log.w(TAG, "webview version cannot be determined")
        return null
    }

    /** 诊断仅声明实际 provider；候选包存在不能证明它正在被使用。 */
    @Suppress("UNUSED_PARAMETER")
    fun diagnosticLabel(ctx: Context): String {
        val actual = actualProvider()
            ?: return "actual provider: 无法确定（系统未返回实际包；fallback 候选不代表实际 provider）"
        val version = actual.versionName ?: "无法确定"
        val chrome = major(actual)?.toString() ?: "无法确定"
        return "actual provider: ${actual.packageName}; version=$version; Chrome major=$chrome"
    }

    fun isSupported(ctx: Context): Boolean {
        val value = chromeMajor(ctx) ?: return true
        return value >= MIN_CHROME_MAJOR
    }
}
