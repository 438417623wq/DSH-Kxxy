package app.kxxy.engine

import android.content.Context
import android.util.Log
import app.kxxy.pty.PtyBridge
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 引擎进程句柄：PTY 启动、日志泵、优雅停止。
 *
 * 与参考项目的对应关系：本文件合并了其 `EngineProcess.kt`（166 行）与
 * `Pty.kt`（29 行），因为方案 T 下 PTY 的 JNI 声明已独立在
 * `app.kxxy.pty.PtyBridge`，此处只保留进程生命周期管理。
 */
class EngineProcess private constructor(
    private val masterFd: Int,
    val pid: Int,
    private val logFile: File,
) {

    /** 子进程退出时完成；值为**原始 wait status**（用 [PtyBridge.describe] 解码）。 */
    val exitStatus = CompletableDeferred<Int>()

    private val stopped = AtomicBoolean(false)

    @Volatile
    private var pumpThread: Thread? = null

    @Volatile
    private var waitThread: Thread? = null

    companion object {
        private const val TAG = "KxxyEngine"
        private const val READ_BUFFER = 4096

        /**
         * 启动引擎进程。
         *
         * @param nodeBin  `engine/bin/node` 的**绝对路径**（execve 不搜索 PATH）
         * @param entryJs  引擎入口 `.../dsh/lib/bin.js` 的绝对路径
         * @param cwd      工作目录
         * @param env      完整环境变量数组（见 [EngineConfig.buildEnv]）
         * @param patchPath `android-overlay.yml` 的绝对路径；null 表示不注入
         */
        suspend fun spawn(
            nodeBin: File,
            entryJs: File,
            cwd: File,
            env: Array<String>,
            logFile: File,
            patchPath: String?,
        ): EngineProcess = withContext(Dispatchers.IO) {

            cwd.mkdirs()

            // argv：node --expose-internals <entryJs> web --patch <overlay> --no-open
            //
            // --expose-internals 不是可选项：运行时里 node-addon-require-builtin
            //   已被替换为纯 JS shim，靠该 flag 才能 require internal/* 模块。
            // 刻意不设 V8 堆上限：用户真正吃内存的场景是软件编译（clang/rustc/gradle），
            //   限堆会直接导致构建 OOM。
            val argv = buildList {
                add(nodeBin.absolutePath)
                add("--expose-internals")
                add(entryJs.absolutePath)
                add("web")
                if (patchPath != null) {
                    add("--patch")
                    add(patchPath)
                }
                add("--no-open")
            }.toTypedArray()

            val result = PtyBridge.nativeForkPty(
                executable = nodeBin.absolutePath,
                argv = argv,
                envp = env,
                cwd = cwd.absolutePath,
                rows = 40,
                cols = 120,
            )

            val masterFd = result[0]
            val pid = result[1]

            if (masterFd < 0) {
                throw EngineStartException("fork failed, errno=${-masterFd}")
            }

            logFile.parentFile?.mkdirs()
            logFile.appendText("---- engine start ${System.currentTimeMillis()} ----\n")

            EngineProcess(masterFd, pid, logFile).also { it.startThreads() }
        }
    }

    private fun startThreads() {
        pumpThread = Thread(::pumpLoop, "kxxy-log-pump").apply { isDaemon = true; start() }
        waitThread = Thread(::waitLoop, "kxxy-waiter").apply { isDaemon = true; start() }
    }

    /**
     * 日志泵：把 PTY master 的输出同时写到 logcat 与 engine.log。
     *
     * 用反射构造 FileDescriptor 是 Android 平台惯例（libcore 未提供公开构造器）。
     * engine.log 采用环形截断：超过 [EngineConfig.MAX_LOG_BYTES] 时保留尾部一半，
     * 避免长跑设备把存储写满。
     */
    private fun pumpLoop() {
        val fd = FileDescriptor()
        try {
            val field = FileDescriptor::class.java.getDeclaredField("descriptor")
            field.isAccessible = true
            field.setInt(fd, masterFd)
        } catch (e: Exception) {
            Log.e(TAG, "cannot wrap master fd for reading", e)
            return
        }

        FileInputStream(fd).use { input ->
            val buf = ByteArray(READ_BUFFER)
            while (!stopped.get()) {
                val n = try {
                    input.read(buf)
                } catch (e: Exception) {
                    if (!stopped.get()) Log.w(TAG, "log pump read failed: ${e.message}")
                    break
                }
                if (n <= 0) break

                val chunk = String(buf, 0, n, Charsets.UTF_8)
                Log.d(TAG, chunk.trimEnd())
                appendLog(chunk)
            }
        }
    }

    private fun appendLog(chunk: String) {
        try {
            if (logFile.length() < EngineConfig.MAX_LOG_BYTES) {
                logFile.appendText(chunk)
            } else {
                val keep = (EngineConfig.MAX_LOG_BYTES / 2).toInt()
                val tail = logFile.readText().takeLast(keep)
                logFile.writeText(tail + chunk)
            }
        } catch (e: Exception) {
            Log.w(TAG, "appendLog failed: ${e.message}")
        }
    }

    private fun waitLoop() {
        val status = try {
            PtyBridge.nativeWaitPid(pid)
        } catch (e: Exception) {
            Log.e(TAG, "waitpid failed", e)
            -1
        }
        Log.i(TAG, "engine exited, raw status=0x${status.toString(16)} (${PtyBridge.describe(status)})")
        exitStatus.complete(status)
    }

    /**
     * 优雅停止：先 SIGTERM，轮询到 deadline，仍未退出则 SIGKILL。
     *
     * 选择 SIGTERM 而非直接 SIGKILL，是给引擎收尾机会（flush 会话日志、
     * 释放监听端口）。参考项目记录的教训：root 模式下 PTY 只能杀到 su 外壳，
     * `exec node` 的孙进程会成孤儿继续霸占端口 —— 本方案用 G2
     * （PR_SET_PDEATHSIG）从根上避免该问题。
     */
    fun stop(graceMs: Long = 10_000L) {
        if (stopped.getAndSet(true)) return

        PtyBridge.nativeKill(pid, PtyBridge.SIGTERM)

        val deadline = System.currentTimeMillis() + graceMs
        while (System.currentTimeMillis() < deadline) {
            if (exitStatus.isCompleted) break
            if (PtyBridge.nativeAlive(pid) == 0) break
            try {
                Thread.sleep(50)
            } catch (_: InterruptedException) {
                break
            }
        }

        if (PtyBridge.nativeAlive(pid) != 0) {
            Log.w(TAG, "graceful stop timed out after ${graceMs}ms, force killing pid=$pid")
            PtyBridge.nativeKill(pid, PtyBridge.SIGKILL)
        }

        runCatching { PtyBridge.nativeClose(masterFd) }
        pumpThread?.join(1_000)
        waitThread?.join(1_000)
    }

    /** 是否仍在运行。 */
    fun isAlive(): Boolean = !exitStatus.isCompleted && PtyBridge.nativeAlive(pid) != 0

    /** 调整终端尺寸。 */
    fun resize(rows: Int, cols: Int) {
        PtyBridge.nativeResize(masterFd, rows, cols)
    }

    /** 向引擎 stdin 写数据（终端交互用）。 */
    fun write(data: ByteArray): Int = PtyBridge.nativeWrite(masterFd, data)

    /** 读取日志尾部若干字节（供宿主管理页展示）。 */
    fun tailLog(maxBytes: Int = 64 * 1024): String = try {
        if (!logFile.isFile) "" else logFile.readText().takeLast(maxBytes)
    } catch (e: Exception) {
        "log read failed: ${e.message}"
    }

    /**
     * 从日志中提取带 token 的 WebUI URL。
     *
     * ⚠️ 只搜 [fromOffset] 之后的日志段：搜全文会拿到上一次启动的旧 token，
     * 导致 WebView 401 白页（参考项目实测）。
     */
    fun extractTokenUrl(fromOffset: Long): String? {
        val text = try {
            if (!logFile.isFile) return null
            val all = logFile.readText()
            if (fromOffset >= all.length) return null
            all.substring(fromOffset.toInt())
        } catch (e: Exception) {
            return null
        }
        return TOKEN_RE.findAll(text).lastOrNull()?.groupValues?.get(1)
    }

    /** 日志当前长度，用于 spawn 前记录偏移基线。 */
    fun logLength(): Long = try {
        if (logFile.isFile) logFile.length() else 0L
    } catch (e: Exception) {
        0L
    }
}

/** 引擎启动失败。 */
class EngineStartException(message: String) : Exception(message)

/**
 * 匹配官方启动时打印的带 token URL。
 *
 * 官方输出形如：`dsh web: http://127.0.0.1:3080/?token=<hex>`
 */
private val TOKEN_RE = Regex("""dsh web: (http://127\.0\.0\.1:\d+/\?token=\S+)""")
