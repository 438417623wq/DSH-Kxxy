package app.kxxy.engine

import android.content.Context
import android.util.Log
import app.kxxy.BuildConfig
import org.json.JSONObject

/**
 * 构建元数据：这一份 APK 里到底装了哪一版运行时、哪一版宿主插件。
 *
 * ── 为什么需要这个对象（缺陷 DP / 「版本号三套互不相干」）───────────────
 *
 * 改造前，「版本」在项目里有三个互不知情的来源：
 *   1. `build.gradle.kts` 里写死的 `versionCode = 1 / versionName = "0.1.0"`
 *      —— 仓库早已 v0.9.2，它从没被动过；
 *   2. git tag —— 只在 README 与发布说明里出现，代码里读不到；
 *   3. 资源版本 —— 靠人手递增的 `kxxy-host@N`，写死在 `lib/index.js` 首行与
 *      `RuntimeInstaller.HOST_PLUGIN_MARKER` 两处，全靠人记着同步。
 *
 * 后果不是「显示不好看」，而是排障时无法对齐：用户报「XX 坏了」，唯一能问的
 * 只有「哪一版」，而关于页显示的是 DSH 前端版本，与 APK 完全无关。
 *
 * 现在三条线各自归一：
 *   · 版本号 ← `git describe`（见 build.gradle.kts，编译期注入 BuildConfig）
 *   · runtime 指纹 ← `runtime.zip` 的 sha256（构建期算出，写进 assets/meta/build.json）
 *   · 插件指纹 ← kxxy-host 目录树内容哈希（构建期算出，同上）
 *
 * 这个对象把三者摊平成一份快照，给三处消费：
 *   · `EngineSupervisor.publishState()` → 落进 `kxxy-state.json` →
 *     `/kxxy/api/state` → 控制台关于弹窗与体检页；
 *   · `kxxy-host` 的 `exportLogs()` → 塞进 diag.json，用户导日志时自带版本；
 *   · `KxxyApp` 启动日志 → logcat 一行自证。
 *
 * ── 为什么值优先取 BuildConfig 而不是 assets ─────────────────────────────
 *
 * `assets/meta/build.json` 是**构建期的输入**（gradle 配置阶段读它注入
 * BuildConfig），编译后它和常量可能对不上 —— 只要有人在 gradle 跑完之后又
 * 重新生成了一遍 build.json。这时以 BuildConfig 为准（那才是真正打进这个
 * APK dex 的值），并在发现不一致时打一条 warning，让这个缝隙可见。
 *
 * 反过来，BuildConfig 为 "unknown"（没跑过 build-runtime.mjs 就打包）时
 * 回落到 assets —— 至少能给出一个值。
 */
object BuildMeta {

    private const val TAG = "KxxyBuildMeta"
    private const val ASSET_PATH = "meta/build.json"

    /** 全部拿不到时的占位值。刻意用字符串而不是 null：JSON 里少个字段比多个 null 更难排查。 */
    const val UNKNOWN = "unknown"

    /**
     * 构建元数据快照。
     *
     * @param versionName `0.9.2+12.3b24a6d.dirty` 形态，见 build.gradle.kts
     * @param versionCode 严格单调递增的整数，覆盖安装的依据
     * @param commit      短 SHA（7 位）；无 git 时为 `nogit`
     * @param buildTime   ISO-8601 构建时刻
     * @param dirty       构建时工作区是否有未提交改动
     * @param runtimeFingerprint runtime.zip 的 sha256 全文（64 hex）
     * @param hostPluginFingerprint kxxy-host 目录树内容哈希全文（64 hex）
     */
    data class Snapshot(
        val versionName: String,
        val versionCode: Int,
        val commit: String,
        val buildTime: String,
        val dirty: Boolean,
        val runtimeFingerprint: String,
        val hostPluginFingerprint: String,
        val runtimeSize: Long,
        val runtimeEntries: Int,
        /**
         * 源码仓库地址（https 形态，构建期从 `git remote get-url origin` 取）。
         *
         * 只有关于弹窗那条链接用它 —— 设备上没有 git，运行期无从推断。
         * 空串表示「不知道」，前端会把整条链接隐藏。
         */
        val repoUrl: String = "",
    ) {
        /**
         * 给人看的短版本：`0.9.2+12.3b24a6d · rt 8f3a1c2d · host 4b77e0a1`
         *
         * 关于弹窗顶部的副标题与通知栏小字都用它 —— 一行就能说清「你装的是
         * 哪一版、运行时和插件分别是哪一份」。
         */
        val shortLabel: String
            get() = buildString {
                append(versionName)
                if (runtimeFingerprint != UNKNOWN) append(" · rt ${runtimeFingerprint.take(8)}")
                if (hostPluginFingerprint != UNKNOWN) append(" · host ${hostPluginFingerprint.take(8)}")
            }

        /** 写进 JSON 的字段集合（手工拼串，与本项目其它 state 发布保持同一风格）。 */
        fun toJson(): String = buildString {
            append("{\n")
            append("    \"versionName\": ${quote(versionName)},\n")
            append("    \"versionCode\": $versionCode,\n")
            append("    \"commit\": ${quote(commit)},\n")
            append("    \"buildTime\": ${quote(buildTime)},\n")
            append("    \"dirty\": $dirty,\n")
            append("    \"runtimeFingerprint\": ${quote(runtimeFingerprint)},\n")
            append("    \"hostPluginFingerprint\": ${quote(hostPluginFingerprint)},\n")
            append("    \"runtimeSize\": $runtimeSize,\n")
            append("    \"runtimeEntries\": $runtimeEntries,\n")
            append("    \"repoUrl\": ${quote(repoUrl)}\n")
            append("  }")
        }

        private fun quote(s: String): String =
            "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\""
    }

    @Volatile
    private var assetJson: JSONObject? = null

    @Volatile
    private var loaded = false

    /** 读一次 assets/meta/build.json 并缓存（失败只记一次日志，不反复读盘）。 */
    private fun ensureAssetLoaded(context: Context?) {
        if (loaded) return
        synchronized(this) {
            if (loaded) return
            loaded = true
            val ctx = context ?: return
            assetJson = runCatching {
                ctx.assets.open(ASSET_PATH).bufferedReader(Charsets.UTF_8).use {
                    JSONObject(it.readText())
                }
            }.getOrElse { e ->
                Log.w(TAG, "读不到 assets/$ASSET_PATH（${e.message}）—— 构建元数据将退化为 unknown")
                null
            }
            assetJson?.let { json ->
                val fromAssets = json.optString("runtimeSha256", "")
                if (fromAssets.isNotEmpty() && fromAssets != BuildConfig.RUNTIME_FINGERPRINT) {
                    // 这两者本该相等：gradle 配置阶段读的正是这个文件。不相等说明
                    // 有人在 gradle 之后重新生成了它 —— 值得喊一声，但不必中断。
                    Log.w(
                        TAG,
                        "构建元数据与 BuildConfig 不一致：assets=$fromAssets " +
                            "BuildConfig=${BuildConfig.RUNTIME_FINGERPRINT}（以 BuildConfig 为准）",
                    )
                }
            }
        }
    }

    private fun assetString(context: Context?, key: String, fallback: String): String {
        ensureAssetLoaded(context)
        val v = assetJson?.optString(key, "") ?: ""
        return v.ifEmpty { fallback }
    }

    private fun assetLong(context: Context?, key: String, fallback: Long): Long {
        ensureAssetLoaded(context)
        return assetJson?.optLong(key, fallback) ?: fallback
    }

    private fun assetInt(context: Context?, key: String, fallback: Int): Int {
        ensureAssetLoaded(context)
        return assetJson?.optInt(key, fallback) ?: fallback
    }

    /** 取快照。`context` 可为 null（此时只给 BuildConfig 里的值）。 */
    fun snapshot(context: Context?): Snapshot {
        val runtimeFp = BuildConfig.RUNTIME_FINGERPRINT
            .takeIf { it.isNotEmpty() && it != UNKNOWN }
            ?: assetString(context, "runtimeSha256", UNKNOWN)
        val hostFp = BuildConfig.HOST_PLUGIN_FINGERPRINT
            .takeIf { it.isNotEmpty() && it != UNKNOWN }
            ?: assetString(context, "kxxyHostFingerprint", UNKNOWN)
        return Snapshot(
            versionName = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE,
            commit = BuildConfig.BUILD_COMMIT.ifEmpty { UNKNOWN },
            buildTime = BuildConfig.BUILD_TIME_ISO,
            dirty = BuildConfig.BUILD_DIRTY,
            runtimeFingerprint = runtimeFp,
            hostPluginFingerprint = hostFp,
            runtimeSize = assetLong(context, "runtimeSize", 0L),
            runtimeEntries = assetInt(context, "runtimeEntries", 0),
            // 仓库地址优先 BuildConfig（gradle 配置阶段从 build.json 注入），
            // 注入失败（没跑过 build-runtime.mjs）时回落到 assets 里的原文。
            repoUrl = BuildConfig.REPO_URL
                .takeIf { it.isNotEmpty() && it != UNKNOWN }
                ?: assetString(context, "repoUrl", ""),
        )
    }

    /** logcat 用的单行自述。 */
    fun startupLine(context: Context?): String {
        val s = snapshot(context)
        val sizeMiB = if (s.runtimeSize > 0) "%.1f MiB".format(s.runtimeSize / 1048576.0) else "?"
        return "build=${s.versionName} code=${s.versionCode} commit=${s.commit} " +
            "dirty=${s.dirty} runtime=${s.runtimeFingerprint.take(16)}($sizeMiB, ${s.runtimeEntries} 条) " +
            "host=${s.hostPluginFingerprint.take(16)}"
    }
}
