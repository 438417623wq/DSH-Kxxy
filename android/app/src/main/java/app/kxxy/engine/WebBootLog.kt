package app.kxxy.engine

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 网页端启动失败记录。
 *
 * 为什么需要它：体检（kxxy-host/lib/health.mjs）在**引擎进程内**读文件，
 * 它能看见补丁、清单、运行时这些磁盘状态，但看不见**浏览器里发生的事**。
 * 而「装了插件之后进不去页面」恰恰只发生在浏览器侧 —— 官方前端的
 * client-modules 解析失败时会整页替换成 `Failed to load plugins`，
 * 引擎本身活得好好的，于是体检 7/7 全绿、用户却进不了对话页。
 * （真机上实测到的就是这个组合。）
 *
 * 取数点：WebView 的 `onConsoleMessage`。那条错误是前端 boot 阶段
 * `throw new Error(...)` 产生的，必然先经过 console —— 这是浏览器内
 * 唯一可靠、且不需要改前端 bundle 的观测点。
 *
 * 落盘位置 `$DSH_HOME/web-boot/web-boot.json`：和 guard 一样放在引擎 home
 * 下，体检按 `DSH_HOME` 直接读，不需要再开一条原生→插件的通道。
 *
 * 只记「看起来是启动失败」的那几类，其余 console 一概不写盘 —— 官方前端
 * 在正常使用中也会打大量 debug 日志，全收会让文件变成噪音，而体检每次
 * 轮询都要解析它。
 */
object WebBootLog {
    private const val TAG = "KxxyWebBoot"

    /** 只保留最近几条：页面反复刷新时同一句错误会重复出现，留多了没意义。 */
    private const val MAX_ENTRIES = 8

    /** 同一个错误在这么短的窗口内重复，只认一次（存在感去重，避免写盘风暴）。 */
    private const val DEDUPE_WINDOW_MS = 3_000L

    /**
     * 判定特征串。
     *
     * - `did not activate`：app-boot 的 entry 未激活（前端 boot 阶段抛出）
     * - `Failed to load plugins`：前端错误页标题，最直接的「进不去」
     * - `missed the module table`：client-modules 缺模块表，插件前端入口挂掉的根因
     * - `Failed to fetch dynamically imported module`：动态 import 404，同族故障
     *
     * 刻意**不**收 `console.error` 的通用错误：官方前端在插件自己报错时也会
     * 打 error，但那种页面照常可用，收进来会让体检误报成「进不去」。
     */
    private val MARKERS = arrayOf(
        "did not activate",
        "Failed to load plugins",
        "missed the module table",
        "Failed to fetch dynamically imported module",
    )

    private val lock = Any()
    private var lastAt = 0L
    private var lastMessage = ""

    fun looksLikeFailure(message: String): Boolean = MARKERS.any { message.contains(it) }

    /**
     * 记一条启动失败。**任何异常都不能往外抛** —— 这个方法挂在 WebView 的
     * console 回调上（主线程），抛出去会直接影响页面交互。
     */
    fun record(ctx: Context, message: String, source: String?, line: Int) {
        if (message.isBlank() || !looksLikeFailure(message)) return
        val now = System.currentTimeMillis()
        synchronized(lock) {
            // 同一个错误在 3 秒内可能被打印多次（同一帧里多个 entry 各自失败），
            // 只留一条；超过窗口后仍会记录，因为那通常意味着页面又 reload 了。
            if (message == lastMessage && now - lastAt < DEDUPE_WINDOW_MS) return
            lastAt = now
            lastMessage = message
        }
        runCatching {
            val file = EngineConfig.webBootFile(ctx)
            val entries = readEntries(file)
            // 同一条消息只留最新一条（更新它的时间戳），否则刷新几次就把
            // 真正不同的错误挤出窗口。
            entries.removeAll { (it.optString("message") == message) }
            entries.add(
                JSONObject()
                    .put("at", now)
                    .put("source", source ?: "")
                    .put("line", line)
                    .put("message", message.take(2000)),
            )
            while (entries.size > MAX_ENTRIES) entries.removeAt(0)

            val json = JSONObject()
                .put("version", 1)
                .put("updatedAt", now)
                .put("entries", JSONArray(entries))

            val dir = file.parentFile
            dir?.mkdirs()
            val tmp = File(dir, file.name + ".tmp")
            tmp.writeText(json.toString(2) + "\n")
            if (!tmp.renameTo(file)) {
                // rename 在少数文件系统上会失败（跨挂载点），退回直接覆盖。
                file.writeText(json.toString(2) + "\n")
                tmp.delete()
            }
        }.onFailure { Log.w(TAG, "record failed: ${it.message}") }
    }

    private fun readEntries(file: File): MutableList<JSONObject> {
        if (!file.isFile) return mutableListOf()
        return runCatching {
            val root = JSONObject(file.readText().replace("\uFEFF", ""))
            val arr = root.optJSONArray("entries") ?: JSONArray()
            MutableList(arr.length()) { arr.getJSONObject(it) }
        }.getOrElse { mutableListOf() }
    }

    /** 引擎重启时清空：旧记录的时间戳会小于新的启动时刻，体检本来也会忽略，
     *  但留着会让 `web-boot.json` 变成越滚越大的历史文件，直接删干净。 */
    fun reset(ctx: Context) {
        runCatching {
            val f = EngineConfig.webBootFile(ctx)
            if (f.isFile) f.delete()
        }.onFailure { Log.w(TAG, "reset failed: ${it.message}") }
    }
}
