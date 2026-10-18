package app.kxxy.engine

import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Termux:API 的原生替代实现（缺陷 BE）。
 *
 * ## 为什么需要它
 *
 * Termux 闭包里那 52 个 `bin/termux-*` 脚本本身是干净的（shebang 与正文里的
 * `com.termux` 前缀已在构建期被改写），但它们尾部统一调
 * `<root>/libexec/termux-api <Method> …` —— 那是个 **ELF**，内部把
 * `/data/data/com.termux/files/usr/bin/am` 与
 * `com.termux.api/.TermuxApiReceiver` 写死在 rodata 里：
 *
 * ```
 * execv("/data/data/com.termux/files/usr/bin/am")
 * am broadcast --user 0 -a com.termux.api://listen -n com.termux.api/.TermuxApiReceiver …
 * ```
 *
 * 它在设备上的实际表现是 `execv(…): No such file or directory` 而 **rc=0**
 * —— 静默失败，用户拿到的是一行空白 + 成功退出码。即使把 `am` 路径改对，
 * `com.termux.api` 这个独立 App 在本机也不存在（Kxxy 不是 Termux）。
 *
 * 构建期修不了：`tools/build-runtime.mjs` 的 `normaliseStageFiles` 对 ELF
 * 是 `if (isElf(buf)) continue`（改二进制字符串会破坏重定位/校验）。
 *
 * ⇒ 唯一正确的修法：**用脚本换掉那个 ELF 转发层**
 * （[installShim]），把请求送进应用进程，由本对象用 Android SDK 直接实现。
 *
 * ## 通道选型
 *
 * 与 [ShizukuShellServer] 完全同型：引擎是独立进程，拿不到任何 binder 与
 * Activity 上下文，所以走「应用私有目录内的文件请求/响应」。理由见
 * [ShizukuShellServer] 的头部注释（TCP 被否、Unix domain socket 公开
 * 构造器不支持文件路径）。差异只有三点：
 *
 * - 目录是 `<engineRoot>/tapi`（`shz` 是特权命令通道，语义不同，不混用）；
 * - 不需要「模式开关」：termux-api 是普通应用能力，任何权限模式下都该可用；
 * - 请求必须携带 **argv 列表 + stdin 两份数据**（`shz` 只有一条命令字符串）。
 *
 * ## 协议
 *
 * ```
 * tapi/request       引擎写入：argv，各项以 NUL 分隔（argv[0] = Method）
 * tapi/request.in    引擎写入：stdin 原文字节（可为空文件）
 * tapi/response      应用写入：第一行 = 退出码，其余 = 要打到 stdout 的内容
 * tapi/capable       应用写入：通道就绪标记
 * tapi/lock          引擎侧 mkdir 原子加锁
 * ```
 *
 * ## 能力边界（真机实测，见缺陷 BE 的取证）
 *
 * 在 `app.kxxy` 自身 uid（u0_a385）下实测：
 *
 * | 探测 | 结果 |
 * |---|---|
 * | `dumpsys battery` | `Can't find service: battery` |
 * | `settings get …` | `SecurityException: requires INTERACT_ACROSS_USERS` |
 * | `input keyevent …` | `SecurityException: requires INJECT_EVENTS` |
 * | `cmd vibrator` | `Can't find service: vibrator` |
 * | `/sys/class/power_supply/battery` 下各项 | 全部不可读 |
 *
 * 也就是说 **shell 层面一条硬件 API 都走不通**，但同一批能力用 Android SDK
 * 在应用进程里调用是正常的 —— 这正是本实现存在的意义。反过来，确实越界的
 * 那些（短信、通话、联系人、位置、NFC、USB、传感器流、指纹）在本应用里
 * 没有对应权限也没有接收者，一律返回 `UNSUPPORTED` 与非零退出码，
 * **不再静默 rc=0**。
 */
object TermuxApiServer {

    private const val TAG = "KxxyTermuxApi"

    /** 请求轮询间隔，与 [ShizukuShellServer] 保持一致。 */
    private const val POLL_MS = 150L

    /** 单条请求的处理上限，防止某个系统调用卡死整条通道。 */
    private const val HANDLE_TIMEOUT_MS = 15_000L

    /** 通道目录：`<engineRoot>/tapi`。 */
    private fun dir(ctx: Context): File = File(EngineConfig.engineRoot(ctx), "tapi")

    @Volatile
    private var started = false

    /**
     * 启动服务循环，**幂等**。
     *
     * 由 [app.kxxy.KxxyApp.onCreate] 调用 —— 必须在应用进程里跑，因为只有
     * 应用进程有 Activity 上下文与已授予的运行时权限。
     */
    fun start(ctx: Context, scope: CoroutineScope) {
        if (started) return
        started = true
        scope.launch(Dispatchers.IO) { loop(ctx) }
        Log.i(TAG, "termux-api bridge started, dir=${dir(ctx).absolutePath}")
    }

    private suspend fun CoroutineScope.loop(ctx: Context) {
        val d = dir(ctx)
        runCatching {
            d.mkdirs()
            // 上一进程残留的请求对应的调用方早已超时退出，若不清掉会被当成
            // 新请求执行一次（幽灵执行）——与 shz 的处理一致。
            File(d, "request").delete()
            File(d, "request.in").delete()
            File(d, "response").delete()
            File(d, "lock").delete()
            File(d, "capable").writeText("termux-api bridge ready\n")
        }

        while (isActive) {
            try {
                val req = File(d, "request")
                if (!req.isFile) {
                    delay(POLL_MS)
                    continue
                }
                handleRequest(ctx, d, req)
            } catch (e: Throwable) {
                // 循环绝不能因单次异常退出：一旦退出，引擎侧脚本会永久超时，
                // 用户看到的是「termux-toast 卡住」而没有任何线索。
                Log.w(TAG, "loop iteration failed: ${e.javaClass.simpleName}: ${e.message}")
                delay(POLL_MS)
            }
        }
    }

    private fun handleRequest(ctx: Context, d: File, req: File) {
        val argv = try {
            splitNul(req.readBytes())
        } catch (e: Throwable) {
            Log.w(TAG, "read request failed: ${e.message}")
            req.delete()
            return
        }
        // 先删再执行：客户端等的是「本次」的响应，response 残留会读到过期结果。
        req.delete()

        val stdinFile = File(d, "request.in")
        val stdin = try {
            if (stdinFile.isFile) String(stdinFile.readBytes(), Charsets.UTF_8) else ""
        } catch (e: Throwable) {
            Log.w(TAG, "read stdin failed: ${e.message}")
            ""
        }
        runCatching { stdinFile.delete() }

        if (argv.isEmpty()) {
            writeAtomically(File(d, "response"), "64\n")
            return
        }

        val method = argv[0]
        val t0 = System.currentTimeMillis()
        val result = try {
            runWithTimeout(HANDLE_TIMEOUT_MS) {
                dispatch(ctx, method, argv.drop(1), stdin)
            } ?: (1 to errorJson("TIMEOUT", "$method 超过 ${HANDLE_TIMEOUT_MS}ms 未返回"))
        } catch (e: Throwable) {
            Log.w(TAG, "$method failed: ${e.javaClass.simpleName}: ${e.message}")
            1 to errorJson("EXCEPTION", "${e.javaClass.simpleName}: ${e.message}")
        }
        val cost = System.currentTimeMillis() - t0
        Log.i(TAG, "$method -> exit=${result.first} (${cost}ms)")

        writeAtomically(File(d, "response"), "${result.first}\n${result.second}")
    }

    /**
     * 在独立线程里执行 [block]，超时返回 null。
     *
     * 为什么需要：某些系统调用（`startActivity` 等接收方无响应、
     * `MediaScanner` 卡在 media provider）会无限期阻塞。一旦阻塞发生在
     * 这个单线程循环里，**后续所有** termux-api 调用都会一起卡死，用户看到
     * 的是「termux-toast 之后再调什么都超时」。给自己一个上限，牺牲掉那一条
     * 请求总比拖死整条通道好。
     *
     * 超时后线程无法强杀（Java 没有安全的取消手段），但它是 daemon 且最多
     * 只有一条，泄漏可控。
     */
    private fun <T> runWithTimeout(ms: Long, block: () -> T): T? {
        var value: T? = null
        var error: Throwable? = null
        val worker = Thread {
            try {
                value = block()
            } catch (e: Throwable) {
                error = e
            }
        }
        worker.isDaemon = true
        worker.start()
        worker.join(ms)
        if (worker.isAlive) return null
        error?.let { throw it }
        return value
    }

    /**
     * 按 NUL 切分 argv。
     *
     * 不用空白切分：`termux-share --es file "/sdcard/a b.png"` 这类参数允许
     * 含空格，而原版 ELF 转发层也是按 argv 边界传的，不能退化。
     */
    private fun splitNul(bytes: ByteArray): List<String> {
        val out = ArrayList<String>()
        var from = 0
        for (i in bytes.indices) {
            if (bytes[i].toInt() == 0) {
                if (i > from) out.add(String(bytes, from, i - from, Charsets.UTF_8))
                from = i + 1
            }
        }
        if (from < bytes.size) out.add(String(bytes, from, bytes.size - from, Charsets.UTF_8))
        return out
    }

    private fun writeAtomically(target: File, content: String) {
        val tmp = File(target.parentFile, target.name + ".tmp")
        tmp.writeText(content)
        if (!tmp.renameTo(target)) {
            target.writeText(content)
            tmp.delete()
        }
    }

    // ── 参数解析 ─────────────────────────────────────────────────────────

    /**
     * 解析 `termux-api` 的 Intent 风格参数。
     *
     * 与 `am` 的约定逐字对齐（这是 52 个脚本写死在尾部的形式）：
     * - `-a <action>`：子动作（`set-volume` / `cleanup` / `list` / `sensors`），
     *   **不是**方法名 —— 方法名永远是 argv[0]；
     * - `-e` / `--es <k> <v>`：字符串；
     * - `--ez <k> true|false`：布尔；
     * - `--ei <k> <n>`：整数；
     * - `--esa` / `--ela <k> a,b,c`：数组（按逗号切）；
     * - 其余：位置参数。
     */
    private class Args(raw: List<String>) {
        var action: String? = null
        val strings = HashMap<String, String>()
        val ints = HashMap<String, Int>()
        val bools = HashMap<String, Boolean>()
        val arrays = HashMap<String, List<String>>()
        val positional = ArrayList<String>()

        init {
            var i = 0
            while (i < raw.size) {
                val a = raw[i]
                when {
                    a == "-a" && i + 1 < raw.size -> { action = raw[i + 1]; i += 2 }
                    (a == "-e" || a == "--es") && i + 2 < raw.size -> {
                        strings[raw[i + 1]] = raw[i + 2]; i += 3
                    }
                    a == "--ez" && i + 2 < raw.size -> {
                        bools[raw[i + 1]] = raw[i + 2].equals("true", ignoreCase = true); i += 3
                    }
                    a == "--ei" && i + 2 < raw.size -> {
                        raw[i + 2].trim().toIntOrNull()?.let { ints[raw[i + 1]] = it }; i += 3
                    }
                    (a == "--esa" || a == "--ela") && i + 2 < raw.size -> {
                        arrays[raw[i + 1]] = raw[i + 2].split(',').filter { it.isNotEmpty() }; i += 3
                    }
                    else -> { positional.add(a); i += 1 }
                }
            }
        }

        fun str(k: String, def: String = ""): String = strings[k] ?: def
        fun int(k: String, def: Int): Int = ints[k] ?: def
        fun bool(k: String): Boolean = bools[k] == true
    }

    private fun errorJson(code: String, message: String): String =
        JSONObject().put("error", code).put("message", message).toString(2) + "\n"

    // ── 方法分发 ─────────────────────────────────────────────────────────

    /**
     * 返回 `退出码 to stdout`。
     *
     * 退出码语义与 Termux:API 对齐：0 = 成功，1 = 失败/不支持。**不再有
     * 「失败但 rc=0」**——那正是缺陷 BE 的核心症状。
     */
    private fun dispatch(
        ctx: Context,
        method: String,
        raw: List<String>,
        stdin: String,
    ): Pair<Int, String> {
        val args = Args(raw)
        return when (method) {
            "Toast" -> toast(ctx, args, stdin)
            "Vibrate" -> vibrate(ctx, args)
            "Clipboard" -> clipboard(ctx, args, stdin)
            "BatteryStatus" -> batteryStatus(ctx)
            "Volume" -> volume(ctx, args)
            "WifiConnectionInfo" -> wifiConnectionInfo(ctx)
            "CameraInfo" -> cameraInfo(ctx)
            "MediaScanner" -> mediaScanner(ctx, args)
            "Download" -> download(ctx, args)
            "Notification" -> notification(ctx, args, stdin)
            "NotificationChannel" -> notificationChannel(ctx, args)
            "NotificationRemove" -> notificationRemove(ctx, args)
            "NotificationList" -> notificationList(ctx)
            "Brightness" -> brightness(ctx, args)
            "Torch" -> torch(ctx, args)
            "Share" -> share(ctx, args, stdin)
            else -> 1 to errorJson(
                "UNSUPPORTED",
                "termux-api 方法「$method」在 DSH Kxxy 中未实现。" +
                    "它依赖 Termux:API 应用或本应用没有的系统权限" +
                    "（短信/通话/联系人/位置/NFC/USB/传感器流/指纹等）。",
            )
        }
    }

    // ── 各方法实现 ───────────────────────────────────────────────────────

    private fun toast(ctx: Context, args: Args, stdin: String): Pair<Int, String> {
        val text = stdin.trim().ifEmpty { args.positional.joinToString(" ") }
        if (text.isEmpty()) return 1 to errorJson("BAD_ARGS", "toast 需要文本（参数或 stdin）")
        val long = !args.bool("short")
        Handler(Looper.getMainLooper()).post {
            runCatching { Toast.makeText(ctx, text, if (long) Toast.LENGTH_LONG else Toast.LENGTH_SHORT).show() }
        }
        return 0 to ""
    }

    private fun vibrate(ctx: Context, args: Args): Pair<Int, String> {
        val ms = args.int("duration_ms", 1000).coerceIn(1, 60_000).toLong()
        val vibrator = ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            ?: return 1 to errorJson("NO_SERVICE", "设备没有振动服务")
        if (!vibrator.hasVibrator()) return 1 to errorJson("NO_VIBRATOR", "设备没有振动马达")
        // API 26 起必须走 VibrationEffect，旧的 vibrate(long) 在 26+ 直接抛
        // IllegalArgumentException（不是静默忽略）。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(ms)
        }
        return 0 to ""
    }

    private fun clipboard(ctx: Context, args: Args, stdin: String): Pair<Int, String> {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            ?: return 1 to errorJson("NO_SERVICE", "设备没有剪贴板服务")
        if (args.bool("set")) {
            val text = stdin.ifEmpty { args.positional.joinToString(" ") }
            cm.setPrimaryClip(ClipData.newPlainText("termux-api", text))
            return 0 to ""
        }
        // Android 10+ 限制后台应用读剪贴板：没有前台窗口时系统直接返回空。
        // 这不是缺陷，必须如实告知，否则用户会以为剪贴板是空的。
        val clip = cm.primaryClip
        if (clip == null || clip.itemCount == 0) {
            return 1 to errorJson(
                "NO_ITEMS",
                "剪贴板为空。注意 Android 10+ 只允许前台应用读取剪贴板，" +
                    "从后台服务调用时系统会拒绝。",
            )
        }
        val text = clip.getItemAt(0).coerceToText(ctx).toString()
        return 0 to JSONObject().put("text", text).toString() + "\n"
    }

    private fun batteryStatus(ctx: Context): Pair<Int, String> {
        // ACTION_BATTERY_CHANGED 是粘性广播，registerReceiver(null, …) 直接
        // 拿到最近一次的 Intent —— 不需要权限，也不需要长期注册。
        val it = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?: return 1 to errorJson("NO_BATTERY", "读不到电池状态广播")
        val level = it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = it.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val pct = if (level >= 0 && scale > 0) level * 100 / scale else -1
        val health = when (it.getIntExtra(BatteryManager.EXTRA_HEALTH, 0)) {
            BatteryManager.BATTERY_HEALTH_GOOD -> "GOOD"
            BatteryManager.BATTERY_HEALTH_COLD -> "COLD"
            BatteryManager.BATTERY_HEALTH_DEAD -> "DEAD"
            BatteryManager.BATTERY_HEALTH_OVERHEAT -> "OVERHEAT"
            BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "OVER_VOLTAGE"
            BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE -> "UNSPECIFIED_FAILURE"
            else -> "UNKNOWN"
        }
        val plug = it.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        val plugged = when (plug) {
            BatteryManager.BATTERY_PLUGGED_AC -> "AC"
            BatteryManager.BATTERY_PLUGGED_USB -> "USB"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "WIRELESS"
            else -> "UNPLUGGED"
        }
        val status = when (it.getIntExtra(BatteryManager.EXTRA_STATUS, 0)) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "CHARGING"
            BatteryManager.BATTERY_STATUS_DISCHARGING -> "DISCHARGING"
            BatteryManager.BATTERY_STATUS_FULL -> "FULL"
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "NOT_CHARGING"
            else -> "UNKNOWN"
        }
        // EXTRA_TEMPERATURE 是 0.1 °C 为单位的整数
        val temp = it.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0
        val voltage = it.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0)
        return 0 to JSONObject()
            .put("health", health)
            .put("percentage", pct)
            .put("plugged", plugged)
            .put("status", status)
            .put("temperature", temp)
            .put("voltage", voltage)
            .toString() + "\n"
    }

    private fun volume(ctx: Context, args: Args): Pair<Int, String> {
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            ?: return 1 to errorJson("NO_SERVICE", "设备没有音频服务")
        val streams = listOf(
            "call" to AudioManager.STREAM_VOICE_CALL,
            "system" to AudioManager.STREAM_SYSTEM,
            "ring" to AudioManager.STREAM_RING,
            "music" to AudioManager.STREAM_MUSIC,
            "alarm" to AudioManager.STREAM_ALARM,
            "notification" to AudioManager.STREAM_NOTIFICATION,
        )
        if (args.action == "set-volume") {
            val name = args.str("stream")
            val pair = streams.firstOrNull { it.first == name }
                ?: return 1 to errorJson("BAD_ARGS", "未知音频流「$name」，可用：${streams.joinToString { it.first }}")
            val vol = args.int("volume", -1)
            if (vol < 0) return 1 to errorJson("BAD_ARGS", "volume 必须是非负整数")
            val max = am.getStreamMaxVolume(pair.second)
            am.setStreamVolume(pair.second, vol.coerceIn(0, max), 0)
            return 0 to ""
        }
        val arr = JSONArray()
        for ((name, stream) in streams) {
            arr.put(
                JSONObject()
                    .put("stream", name)
                    .put("volume", am.getStreamVolume(stream))
                    .put("max_volume", am.getStreamMaxVolume(stream))
                    .put("is_muted", am.isStreamMute(stream)),
            )
        }
        return 0 to arr.toString() + "\n"
    }

    private fun wifiConnectionInfo(ctx: Context): Pair<Int, String> {
        val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
            ?: return 1 to errorJson("NO_SERVICE", "设备没有 Wifi 服务")
        @Suppress("DEPRECATION")
        val info = wm.connectionInfo
            ?: return 1 to errorJson("NO_INFO", "读不到 Wifi 连接信息（可能未开启 Wifi）")
        val dhcp = wm.dhcpInfo
        @Suppress("DEPRECATION")
        return 0 to JSONObject()
            .put("bssid", info.bssid ?: "")
            .put("frequency", info.frequency)
            .put("ip", intToIp(dhcp.ipAddress))
            .put("link_speed_mbps", info.linkSpeed)
            .put("mac_address", info.macAddress ?: "")
            .put("network_id", info.networkId)
            .put("rssi", info.rssi)
            .put("ssid", (info.ssid ?: "").trim('"'))
            .put("supplicant_state", info.supplicantState?.name ?: "")
            .put("hidden_ssid", info.hiddenSSID)
            .toString() + "\n"
    }

    private fun intToIp(v: Int): String =
        "${v and 0xff}.${v shr 8 and 0xff}.${v shr 16 and 0xff}.${v shr 24 and 0xff}"

    private fun cameraInfo(ctx: Context): Pair<Int, String> {
        val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
            ?: return 1 to errorJson("NO_SERVICE", "设备没有相机服务")
        val arr = JSONArray()
        for (id in cm.cameraIdList) {
            val ch = cm.getCameraCharacteristics(id)
            val o = JSONObject().put("id", id)
            o.put(
                "facing",
                when (ch.get(CameraCharacteristics.LENS_FACING)) {
                    CameraCharacteristics.LENS_FACING_FRONT -> "FRONT"
                    CameraCharacteristics.LENS_FACING_BACK -> "BACK"
                    CameraCharacteristics.LENS_FACING_EXTERNAL -> "EXTERNAL"
                    else -> "UNKNOWN"
                },
            )
            runCatching {
                val sizes = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                    ?.getOutputSizes(android.graphics.ImageFormat.JPEG)
                val sa = JSONArray()
                sizes?.forEach { sa.put(JSONObject().put("width", it.width).put("height", it.height)) }
                o.put("jpeg_output_sizes", sa)
            }
            runCatching {
                val focal = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                val fa = JSONArray()
                focal?.forEach { fa.put(it) }
                o.put("focal_lengths", fa)
            }
            runCatching {
                val size = ch.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
                if (size != null) {
                    o.put("sensor_physical_size", JSONObject().put("width", size.width).put("height", size.height))
                }
            }
            arr.put(o)
        }
        return 0 to arr.toString() + "\n"
    }

    private fun mediaScanner(ctx: Context, args: Args): Pair<Int, String> {
        // 脚本把路径列表**整体**当位置参数传（`--esa paths` 后面只跟一个
        // 逗号拼接的字符串），并对路径里的逗号做了 `\,` 转义。所以这里要
        // 先按未转义的逗号切分，再把 `\,` 还原成 `,`。
        val joined = args.arrays["paths"]?.joinToString(",") ?: args.positional.joinToString(",")
        val paths = splitEscapedCommas(joined)
        if (paths.isEmpty()) return 1 to errorJson("BAD_ARGS", "media-scan 需要至少一个文件路径")
        MediaScannerConnection.scanFile(ctx, paths.toTypedArray(), null, null)
        return 0 to ""
    }

    /**
     * 按未转义的逗号切分，`\,` 还原为 `,`。
     *
     * `termux-media-scan` 在脚本里做了 `s/,/\\\\,/g;s/\n/,/g`，所以
     * `/sdcard/a,b.png` 传过来是 `/sdcard/a\,b.png`。直接 split(',') 会把它
     * 拆成两个不存在的路径，扫描静默失败。
     */
    private fun splitEscapedCommas(s: String): List<String> {
        val out = ArrayList<String>()
        val cur = StringBuilder()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '\\' && i + 1 < s.length && s[i + 1] == ',' -> { cur.append(','); i += 2 }
                c == ',' -> { if (cur.isNotEmpty()) out.add(cur.toString()); cur.setLength(0); i += 1 }
                else -> { cur.append(c); i += 1 }
            }
        }
        if (cur.isNotEmpty()) out.add(cur.toString())
        return out
    }

    private fun download(ctx: Context, args: Args): Pair<Int, String> {
        val url = args.positional.firstOrNull()
            ?: return 1 to errorJson("BAD_ARGS", "download 需要一个 URL")
        val dm = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
            ?: return 1 to errorJson("NO_SERVICE", "设备没有下载管理器")
        val name = Uri.parse(url).lastPathSegment?.takeIf { it.isNotBlank() } ?: "download.bin"
        val req = DownloadManager.Request(Uri.parse(url))
            .setTitle(args.str("title", name))
            .setDescription(args.str("description", ""))
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)

        // `-p <path>` 是「完整的下载落点」。targetSdk 28 在 Android 10+ 上拿不到
        // WRITE_EXTERNAL_STORAGE 的实际授权（分区存储），写公共 /sdcard/Download
        // 会静默失败（enqueue 成功但文件永远不出现）。所以：
        //   - 路径在应用私有外部目录（/sdcard/Android/data/app.kxxy/…）内 → 允许；
        //   - 其余（含 /sdcard/Download/…）→ 明确报错，不假装成功。
        val dst = args.str("path")
        if (dst.isNotEmpty()) {
            val ext = ctx.getExternalFilesDir(null)?.canonicalPath
            val canonical = try {
                File(dst).canonicalPath
            } catch (e: Throwable) {
                return 1 to errorJson("BAD_ARGS", "path 非法：$dst")
            }
            if (ext != null && canonical.startsWith(ext + File.separator)) {
                val parent = File(canonical).parentFile
                parent?.mkdirs()
                req.setDestinationUri(Uri.fromFile(File(canonical)))
            } else {
                return 1 to errorJson(
                    "NO_PERMISSION",
                    "无法写入 $dst。Android 10+ 的分区存储不允许本应用写公共目录" +
                        "（/sdcard/Download 等）。请改用应用私有目录：" +
                        "${ctx.getExternalFilesDir(null)}/Download/<文件名>。",
                )
            }
        } else {
            req.setDestinationInExternalFilesDir(ctx, Environment.DIRECTORY_DOWNLOADS, name)
        }
        return try {
            val id = dm.enqueue(req)
            0 to JSONObject().put("download_id", id).toString() + "\n"
        } catch (e: Throwable) {
            1 to errorJson("ENQUEUE_FAILED", e.message ?: e.javaClass.simpleName)
        }
    }

    private fun notification(ctx: Context, args: Args, stdin: String): Pair<Int, String> {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return 1 to errorJson("NO_SERVICE", "设备没有通知服务")
        val content = args.str("content").ifEmpty { stdin.trim() }
        val title = args.str("title", "DSH Kxxy")
        val channelId = args.str("channel", DEFAULT_CHANNEL)
        ensureChannel(nm, channelId, "Termux API")
        val id = args.str("id").ifEmpty { String.format("%d", System.currentTimeMillis() % 100_000) }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.Notification.Builder(ctx, channelId)
        } else {
            @Suppress("DEPRECATION")
            android.app.Notification.Builder(ctx)
        }
        builder.setContentTitle(title)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setAutoCancel(!args.bool("ongoing"))
            .setOngoing(args.bool("ongoing"))
        if (content.isNotEmpty()) builder.setContentText(content)
        if (args.bool("sound")) {
            builder.setDefaults(android.app.Notification.DEFAULT_SOUND)
        }
        if (args.bool("vibrate")) {
            builder.setDefaults(android.app.Notification.DEFAULT_VIBRATE)
        }
        return try {
            nm.notify(id.hashCode(), builder.build())
            0 to id + "\n"
        } catch (e: Throwable) {
            1 to errorJson("NOTIFY_FAILED", e.message ?: e.javaClass.simpleName)
        }
    }

    private fun notificationChannel(ctx: Context, args: Args): Pair<Int, String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return 0 to ""
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return 1 to errorJson("NO_SERVICE", "设备没有通知服务")
        val id = args.str("id").ifEmpty { return 1 to errorJson("BAD_ARGS", "需要 --id <channel-id>") }
        ensureChannel(nm, id, args.str("name", id))
        return 0 to ""
    }

    private fun ensureChannel(nm: NotificationManager, id: String, name: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (nm.getNotificationChannel(id) == null) {
            nm.createNotificationChannel(NotificationChannel(id, name, NotificationManager.IMPORTANCE_DEFAULT))
        }
    }

    private fun notificationRemove(ctx: Context, args: Args): Pair<Int, String> {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return 1 to errorJson("NO_SERVICE", "设备没有通知服务")
        val id = args.str("id").ifEmpty { return 1 to errorJson("BAD_ARGS", "需要 --id <id>") }
        nm.cancel(id.hashCode())
        return 0 to ""
    }

    private fun notificationList(ctx: Context): Pair<Int, String> {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return 1 to errorJson("NO_SERVICE", "设备没有通知服务")
        // getActiveNotifications 只返回**本应用**的通知（Android 的限制，
        // 第三方应用看不到别人的）。这与 Termux:API 的语义不同，如实返回
        // 本应用的通知总比报错好，但要在 JSON 里标清楚。
        val arr = JSONArray()
        nm.activeNotifications?.forEach { sbn ->
            arr.put(
                JSONObject()
                    .put("key", sbn.key)
                    .put("id", sbn.id)
                    .put("package_name", sbn.packageName)
                    .put("title", sbn.notification.extras.getCharSequence("android.title")?.toString() ?: "")
                    .put("content", sbn.notification.extras.getCharSequence("android.text")?.toString() ?: ""),
            )
        }
        return 0 to JSONObject()
            .put("notifications", arr)
            .put("note", "Android 只允许应用读取自身的通知")
            .toString() + "\n"
    }

    private fun brightness(ctx: Context, args: Args): Pair<Int, String> {
        if (!Settings.System.canWrite(ctx)) {
            return 1 to errorJson(
                "NO_WRITE_SETTINGS",
                "缺少「修改系统设置」权限。请在系统设置 → 应用 → DSH Kxxy → " +
                    "修改系统设置 中授权，或从控制台跳转授权页。",
            )
        }
        // termux-brightness 传 `auto` 时只有 `--ez auto true`，**不带**
        // brightness 参数；所以必须先判 auto，再判数值，否则 auto 分支会因为
        // 缺参被误报成 BAD_ARGS。
        if (args.bool("auto")) {
            // SCREEN_BRIGHTNESS_MODE_AUTOMATIC 一旦打开，具体亮度值由系统接管，
            // 此时再写 SCREEN_BRIGHTNESS 是无效的，如实返回成功即可。
            Settings.System.putInt(
                ctx.contentResolver,
                Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC,
            )
            return 0 to ""
        }
        val v = args.int("brightness", -1)
        if (v < 0 || v > 255) return 1 to errorJson("BAD_ARGS", "brightness 必须在 0..255")
        // 手动设值必须先把模式切回手动，否则系统会立刻用自动值覆盖。
        Settings.System.putInt(
            ctx.contentResolver,
            Settings.System.SCREEN_BRIGHTNESS_MODE,
            Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL,
        )
        Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS, v)
        return 0 to ""
    }

    private fun torch(ctx: Context, args: Args): Pair<Int, String> {
        val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
            ?: return 1 to errorJson("NO_SERVICE", "设备没有相机服务")
        val id = cm.cameraIdList.firstOrNull {
            cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        } ?: return 1 to errorJson("NO_FLASH", "设备没有闪光灯")
        // 脚本传的是 `--ez enabled true|false`（不是 `--ez on`），照抄会永远
        // 得到 false —— 这个参数名是从 bin/termux-torch 逐字读出来的。
        val on = if (args.bools.containsKey("enabled")) args.bool("enabled") else args.bool("on")
        return try {
            cm.setTorchMode(id, on)
            0 to ""
        } catch (e: Throwable) {
            1 to errorJson("TORCH_FAILED", e.message ?: e.javaClass.simpleName)
        }
    }

    private fun share(ctx: Context, args: Args, stdin: String): Pair<Int, String> {
        val file = args.str("file")
        val action = when (args.str("action", "view")) {
            "edit" -> Intent.ACTION_EDIT
            "send" -> Intent.ACTION_SEND
            else -> Intent.ACTION_VIEW
        }
        val title = args.str("title", "分享")

        if (file.isNotEmpty()) {
            // 文件分享必须走 content:// + 临时读授权：file:// 在 targetSdk>=24
            // 会抛 FileUriExposedException（见 KxxyFilesProvider 的说明）。
            val root = EngineConfig.engineRoot(ctx).canonicalFile
            val target = try {
                File(file).canonicalFile
            } catch (e: Throwable) {
                return 1 to errorJson("BAD_ARGS", "file 路径非法：$file")
            }
            if (!target.isFile) return 1 to errorJson("NO_FILE", "不是文件：$file")
            if (!target.path.startsWith(root.path + File.separator)) {
                // provider 只服务 engine/ 下的文件；随便什么路径都报清楚，
                // 否则用户会看到「分享成功但没有反应」。
                return 1 to errorJson(
                    "UNSUPPORTED",
                    "只能分享引擎目录（$root）下的文件，实际为 $target。" +
                        "请先把文件拷进引擎目录再分享。",
                )
            }
            val rel = target.path.substring(root.path.length + 1)
            val uri = KxxyFilesProvider.uriFor(rel)
                ?: return 1 to errorJson("BAD_ARGS", "无法为 $rel 生成分享 URI")
            val mime = args.str("content-type").ifEmpty {
                ctx.contentResolver.getType(uri) ?: "application/octet-stream"
            }
            // ACTION_EDIT 带 EXTRA_STREAM 是不合法的（编辑器只认 data URI），
            // 退化成 VIEW，否则会抛 ActivityNotFoundException 或目标应用拿到
            // 空流。
            val intent = Intent(if (action == Intent.ACTION_EDIT) Intent.ACTION_VIEW else action).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, title)
                // 单个 URI 的临时读授权，随接收方任务结束自动失效。
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val out = if (args.bool("default-receiver")) intent else Intent.createChooser(intent, title)
            out.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            return try {
                ctx.startActivity(out)
                0 to ""
            } catch (e: Throwable) {
                1 to errorJson("NO_ACTIVITY", e.message ?: e.javaClass.simpleName)
            }
        }

        val text = stdin.trim().ifEmpty { args.positional.joinToString(" ") }
        if (text.isEmpty()) return 1 to errorJson("BAD_ARGS", "share 需要文件或文本")
        val send = Intent(Intent.ACTION_SEND).apply {
            type = args.str("content-type", "text/plain")
            putExtra(Intent.EXTRA_TEXT, text)
            putExtra(Intent.EXTRA_SUBJECT, title)
        }
        val chooser = Intent.createChooser(send, title).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            ctx.startActivity(chooser)
            0 to ""
        } catch (e: Throwable) {
            1 to errorJson("NO_ACTIVITY", e.message ?: e.javaClass.simpleName)
        }
    }

    // ── 引擎侧 shim 安装 ─────────────────────────────────────────────────

    private const val DEFAULT_CHANNEL = "kxxy-termux-api"

    /** 要替换掉的 ELF 转发层（两个都得删：后者是前者的软链目标）。 */
    private val SHIM_TARGETS = listOf(
        "libexec/termux-api",
        "libexec/termux-api-broadcast",
    )

    /**
     * 把 `<root>/libexec/termux-api` 换成脚本 shim。
     *
     * **每次引擎启动都要重写**：`RuntimeInstaller` 重装 runtime 时会整棵覆盖
     * `libexec/`，ELF 会回来；而且 zip 里 `libexec/termux-api` 是一条
     * `LINK:` 条目，`materialiseLinks` 也会把软链重建出来。放在启动路径上
     * 重写比在安装器里登记「额外产物」更不容易漏（与
     * [ShizukuShellServer.installGateScript] 同一决策）。
     *
     * 幂等判据用内容比对：已经是我们写的脚本就不重复落盘，只修可执行位。
     */
    fun installShim(ctx: Context): Boolean {
        val root = EngineConfig.engineRoot(ctx)
        val libexec = File(root, "libexec")
        if (!libexec.isDirectory) {
            Log.w(TAG, "installShim skipped: ${libexec.absolutePath} is not a directory")
            return false
        }
        val script = File(libexec, "termux-api")
        val text = SHIM_SCRIPT
            .replace("@ROOT@", root.absolutePath)
            .replace("@SH@", File(root, "bin/sh").absolutePath)
        return try {
            // 删掉 ELF 本体：`termux-api` 此刻可能是一条指向
            // `termux-api-broadcast` 的软链，必须先删链接再删目标，
            // 且 delete() 对软链只删链接本身（不会跟随）。
            for (rel in SHIM_TARGETS) {
                val f = File(root, rel)
                if (f.exists() || java.nio.file.Files.isSymbolicLink(f.toPath())) {
                    if (f.isFile && !java.nio.file.Files.isSymbolicLink(f.toPath())) {
                        // 实体 ELF（termux-api-broadcast 就是）——只删它，
                        // 不碰别的扩展文件。
                        f.delete()
                    } else if (java.nio.file.Files.isSymbolicLink(f.toPath())) {
                        f.delete()
                    }
                }
            }
            if (!script.isFile || script.readText() != text) {
                script.delete()
                script.writeText(text)
            }
            script.setExecutable(true, false)
            Log.i(TAG, "termux-api shim installed at ${script.absolutePath}")
            true
        } catch (e: Throwable) {
            Log.w(TAG, "installShim failed: ${e.message}")
            false
        }
    }

    /**
     * shim 脚本正文。
     *
     * `@ROOT@` / `@SH@` 由 [installShim] 替换。**Kotlin 原始字符串里每个
     * shell 的 `$` 都必须写成 `${'$'}`**，否则会被当成模板插值
     * （这个坑在 [ShizukuShellServer.GATE_SCRIPT] 上踩过一次）。
     *
     * 退出码约定：方法自身的退出码；通道未就绪 69；等待超时 124；
     * argv 为空 64。
     */
    private val SHIM_SCRIPT = """
#!@SH@
# DSH Kxxy —— Termux:API 原生桥（替代 Termux 闭包里的 libexec/termux-api）
#
# 由 App 在每次引擎启动时生成，请勿手工编辑（会被覆盖）。
#
# 为什么需要它：Termux 闭包里那个 libexec/termux-api 是 ELF，内部 execv 的是
# /data/data/com.termux/files/usr/bin/am 并通过广播找 com.termux.api 这个
# 独立应用 —— 两者在本机都不存在，实测表现为「无声失败、退出码 0」。
# 本脚本把同样的 argv 转给应用进程里的 TermuxApiServer，由它用 Android SDK
# 直接实现（Toast / 剪贴板 / 通知 / 振动 / 电池 / 音量 / Wifi / 相机信息 /
# 媒体扫描 / 下载 / 亮度 / 手电筒 / 分享）。
#
# 用法（与 Termux:API 逐字一致）：
#   termux-api <Method> [-a action] [--es k v] [--ez k true] [--ei k n] [--esa k a,b]
# 需要的文本走 stdin。结果以 JSON 打到 stdout。

set -u

R="@ROOT@"
D="${'$'}R/tapi"
CAP="${'$'}D/capable"
REQ="${'$'}D/request"
RIN="${'$'}D/request.in"
RES="${'$'}D/response"
LOCK="${'$'}D/lock"

if [ "${'$'}#" -eq 0 ]; then
  echo "termux-api: 缺少方法名" >&2
  exit 64
fi

if [ ! -f "${'$'}CAP" ]; then
  echo "termux-api: 原生桥未就绪（应用进程未启动？）" >&2
  exit 69
fi

# stdin：只有当调用方确实喂了数据时才写 request.in。
#
# 这里**必须**带超时：`termux-battery-status` 这类脚本不会重定向 stdin，
# 直接 `cat` 会继承一个永不关闭的管道（或终端）而永久挂住。100ms 足够
# 读完 `echo … | termux-api …` 这种已成管道的输入（pipe 上有数据时
# read 立即返回），而不会把无输入的调用拖住。
if [ -t 0 ]; then
  : > "${'$'}RIN"
else
  if command -v timeout >/dev/null 2>&1; then
    timeout 0.1 cat > "${'$'}RIN" 2>/dev/null || true
  else
    : > "${'$'}RIN"
  fi
fi

# 串行化：mkdir 是原子操作
n=0
while ! mkdir "${'$'}LOCK" 2>/dev/null; do
  n=${'$'}((n+1))
  if [ "${'$'}n" -gt 600 ]; then
    echo "termux-api: 等待上一条请求超时（60s）" >&2
    exit 75
  fi
  sleep 0.1
done
trap 'rmdir "${'$'}LOCK" 2>/dev/null' EXIT

rm -f "${'$'}RES"

# argv 以 NUL 分隔写入，保证含空格的参数（如 --es file "/sdcard/a b.png"）
# 不被拆开 —— 原版 ELF 也是按 argv 边界传的。
if command -v printf >/dev/null 2>&1; then
  printf '%s\0' "${'$'}@" > "${'$'}REQ"
else
  # 极端退化：没有 printf 时用换行分隔，服务端 splitNul 会把它当成
  # 单个参数——此时至少不会静默成功（方法名对不上会返回 UNSUPPORTED）。
  for a in "${'$'}@"; do echo "${'$'}a"; done > "${'$'}REQ"
fi

n=0
while [ ! -f "${'$'}RES" ]; do
  n=${'$'}((n+1))
  if [ "${'$'}n" -gt 300 ]; then
    echo "termux-api: 请求超时（30s）" >&2
    rm -f "${'$'}REQ" "${'$'}RIN"
    exit 124
  fi
  sleep 0.1
done

CODE="${'$'}(head -n 1 "${'$'}RES")"
tail -n +2 "${'$'}RES"
rm -f "${'$'}RES"

case "${'$'}CODE" in
  ''|*[!0-9]*)
    echo "termux-api: 响应格式异常" >&2
    exit 70
    ;;
esac
exit "${'$'}CODE"
""".trimStart('\n')
}
