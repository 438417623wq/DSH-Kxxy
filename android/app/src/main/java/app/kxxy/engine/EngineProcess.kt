package app.kxxy.engine

import android.content.Context
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
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
    private val rootWrapper: Boolean,
) {

    /** 子进程退出时完成；值为**原始 wait status**（用 [PtyBridge.describe] 解码）。 */
    val exitStatus = CompletableDeferred<Int>()

    private val stopped = AtomicBoolean(false)
    private val masterClosed = AtomicBoolean(false)
    @Volatile private var actualStarted = !rootWrapper

    /** Root wrappers must be observed exec'ing this exact engine, not inferred from wait status. */
    private fun confirmStarted(nodeBin: File, entryJs: File) {
        if (!rootWrapper) return
        val deadline = System.nanoTime() + 1_000_000_000L
        while (System.nanoTime() < deadline && !exitStatus.isCompleted) {
            val argv = try { File("/proc/$pid/cmdline").readText().split('\u0000') } catch (_: java.io.IOException) { emptyList() }
            if (argv.firstOrNull() == nodeBin.absolutePath && entryJs.absolutePath in argv) {
                actualStarted = true
                return
            }
            Thread.sleep(25)
        }
    }

    @Volatile
    private var pumpThread: Thread? = null

    @Volatile
    private var waitThread: Thread? = null

    companion object {
        private const val TAG = "KxxyEngine"
        private const val READ_BUFFER = 4096

        /**
         * 校验 execve 的 `file` 参数是绝对路径。
         *
         * 原生层走 `execve(3)`（`dsh_pty.c` 的 G3 硬约束），它**不搜索 PATH**：
         * 传裸名会让子进程以 exit 127 立即死亡，而 PTY 随即 EIO，宿主侧看不到
         * 任何 stderr —— 表现为「启动失败 + 无限重试」且日志空白。宁可在这里
         * 抛一个带名字的异常，也不要把裸名交给 fork。
         */
        private fun requireAbsolute(path: String, what: String): String {
            if (!path.startsWith("/")) {
                throw EngineStartException(
                    "$what 必须是绝对路径，收到 \"$path\"（execve 不搜索 PATH，裸名会 exit 127）",
                )
            }
            return path
        }

        /**
         * 启动引擎进程。
         *
         * @param nodeBin  `engine/bin/node` 的**绝对路径**（execve 不搜索 PATH）
         * @param entryJs  引擎入口 `.../dsh/lib/bin.js` 的绝对路径
         * @param cwd      工作目录
         * @param env      完整环境变量数组（见 [EngineConfig.buildEnv]）
         * @param patchPath `android-overlay.yml` 的绝对路径；null 表示不注入
         * @param rootPrefix 非 null 时以 root 启动：经探测可用的 su 形式前缀，
         *   **首项必须是 su 的绝对路径**（如 `["/system/bin/su","-c"]`）。argv 改为
         *   `[su, …, "exec 'node' …"]` —— Magisk/KernelSU 的 su 会 exec 替换自身，
         *   引擎进程仍是 forkpty 的直接子进程，PR_SET_PDEATHSIG 继续有效。
         *
         *   传裸名会直接 ENOENT：原生层用 execve 启动（见 `dsh_pty.c` 的 G3），
         *   execve 不搜索 PATH。此处用 [requireAbsolute] 硬校验，把这类错误挡在
         *   fork 之前 —— 否则症状是子进程 exit 127、PTY 立即 EIO、日志里连一行
         *   报错都没有，只能靠 logcat 反推（缺陷 L 就是这样排查了两轮）。
         */
        suspend fun spawn(
            nodeBin: File,
            entryJs: File,
            cwd: File,
            env: Array<String>,
            logFile: File,
            patchPath: String?,
            rootPrefix: List<String>? = null,
        ): EngineProcess = withContext(Dispatchers.IO) {

            cwd.mkdirs()

            // argv：node --expose-internals <entryJs> web --patch <overlay> --no-open
            //
            // --expose-internals 不是可选项：运行时里 node-addon-require-builtin
            //   已被替换为纯 JS shim，靠该 flag 才能 require internal/* 模块。
            // 刻意不设 V8 堆上限：用户真正吃内存的场景是软件编译（clang/rustc/gradle），
            //   限堆会直接导致构建 OOM。
            val nodeArgv = buildList {
                add(nodeBin.absolutePath)
                add("--expose-internals")
                add(entryJs.absolutePath)
                add("web")
                if (patchPath != null) {
                    add("--patch")
                    add(patchPath)
                }
                add("--no-open")
            }

            val argv: List<String> = if (rootPrefix == null) {
                nodeArgv
            } else {
                val suPath = requireAbsolute(rootPrefix.first(), "rootPrefix")
                // 拼成经 shell 解释的单命令（su 的各种形式都以 -c/位置参数收命令）
                val command = "exec " + nodeArgv.joinToString(" ") { arg ->
                    if (arg.contains(Regex("[\\s\"'\\\\]"))) "'" + arg.replace("'", "'\\''") + "'" else arg
                }
                listOf(suPath) + rootPrefix.drop(1) + listOf(command)
            }

            val result = PtyBridge.nativeForkPty(
                executable = argv.first(),
                argv = argv.toTypedArray(),
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

            val proc = EngineProcess(masterFd, pid, logFile, rootPrefix != null)
            var handedOff = false
            try {
                logFile.parentFile?.mkdirs()
                logFile.appendText("---- engine start ${System.currentTimeMillis()} ----\n")
                proc.startThreads()
                proc.confirmStarted(nodeBin, entryJs)
                handedOff = true
                proc
            } finally {
                // Includes failed log append and a partially started thread pair.
                // A cleanup failure propagates; no unverified writer-stop is reported.
                if (!handedOff) {
                    try { proc.abortSpawn() } catch (e: Exception) {
                        throw EngineStartException("fork 后清理未验证：${e.message}", proc).also { it.initCause(e) }
                    } catch (e: LinkageError) {
                        throw EngineStartException("fork 后原生清理失败：${e.message}", proc).also { it.initCause(e) }
                    }
                }
            }
        }
    }

    private fun startThreads() {
        pumpThread = Thread(::pumpLoop, "kxxy-log-pump").apply { isDaemon = true }
        waitThread = Thread(::waitLoop, "kxxy-waiter").apply { isDaemon = true }
        // Start the reaper first, so a pump-start failure still has a waiter.
        waitThread!!.start()
        pumpThread!!.start()
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

        // The stream owns a duplicate, never the native master (avoid double-close/fd reuse).
        val inputFd = try { Os.dup(fd) } catch (e: ErrnoException) {
            Log.w(TAG, "cannot duplicate master fd: ${e.errno}")
            return
        }
        FileInputStream(inputFd).use { input ->
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
    @Synchronized
    fun stop(graceMs: Long = 10_000L) {
        stopped.set(true)
        terminate(graceMs)
        closeMaster()
        joinThreads()
        if (!actualStarted) throw EngineStartException("Root wrapper 的实际 engine PID 未被确认；不能声明 writersStopped")
        if (!definitelyExited()) throw EngineStartException("engine pid=$pid 未证实 ESRCH；禁止修复锁")
    }

    private fun definitelyExited(): Boolean = try {
        if (pid <= 0) throw EngineStartException("无效 engine PID")
        Os.kill(pid, 0)
        false
    } catch (e: ErrnoException) {
        if (e.errno == OsConstants.ESRCH) true
        else if (e.errno == OsConstants.EPERM) false else throw e
    }

    private fun awaitDeath(ms: Long): Boolean {
        val deadline = System.nanoTime() + ms.coerceIn(0L, 10_000L) * 1_000_000L
        do {
            if (definitelyExited()) return true
            if (System.nanoTime() >= deadline) return false
            Thread.sleep(25)
        } while (true)
    }

    private fun terminate(graceMs: Long) {
        if (definitelyExited()) return
        PtyBridge.nativeKill(pid, PtyBridge.SIGTERM)
        if (!awaitDeath(graceMs)) {
            Log.w(TAG, "force killing known child pid=$pid")
            PtyBridge.nativeKill(pid, PtyBridge.SIGKILL)
            if (waitThread?.isAlive != true && !exitStatus.isCompleted) {
                // waitpid can block even when SIGKILL failed (EPERM); never call it inline.
                waitThread = Thread(::waitLoop, "kxxy-abort-reaper").apply { isDaemon = true }
                waitThread!!.start()
            }
            if (!awaitDeath(2_000L)) throw EngineStartException("engine pid=$pid 停止失败（存活/EPERM/未知）；保留句柄")
        }
    }

    private fun closeMaster() {
        if (!masterClosed.get()) {
            PtyBridge.nativeClose(masterFd)
            masterClosed.set(true)
        }
    }

    private fun joinThreads() {
        listOfNotNull(pumpThread, waitThread).forEach { thread ->
            if (thread === Thread.currentThread()) throw EngineStartException("不能等待自身 engine task")
            thread.join(2_000L)
            if (thread.isAlive) throw EngineStartException("engine task ${thread.name} 未停止")
        }
    }

    private fun abortSpawn() {
        stopped.set(true)
        try {
            if (waitThread?.isAlive != true && !exitStatus.isCompleted) {
                waitThread = Thread(::waitLoop, "kxxy-abort-reaper").apply { isDaemon = true }
                waitThread!!.start()
            }
            terminate(0L)
        } finally {
            closeMaster()
            joinThreads()
        }
    }

    /** EPERM means possibly alive, never proof of death. */
    fun isAlive(): Boolean = !definitelyExited()

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

    /**
     * 取日志里**最后一次**出现的 token URL，只看尾部 128 KB。
     *
     * 与 [extractTokenUrl] 的分工：那个按 spawn 偏移取「本次启动的第一条」，
     * 用于把就绪判定和启动对齐；这个用于页面已经白掉之后**补救**——
     * 此时进程可能已经重启过，或者第一条落在环形日志被裁剪的区间里，
     * 只有「最后一条」才一定属于当前活着的那个引擎进程。
     */
    fun extractLastTokenUrl(): String? {
        val text = try {
            if (!logFile.isFile) return null
            val all = logFile.readText()
            if (all.length > TOKEN_TAIL_BYTES) all.substring(all.length - TOKEN_TAIL_BYTES) else all
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
class EngineStartException(message: String, internal val failedProcess: EngineProcess? = null) : Exception(message)

/**
 * 匹配官方启动时打印的带 token URL。
 *
 * 官方输出形如：`dsh web: http://127.0.0.1:3080/?token=<hex>`
 */
private val TOKEN_RE = Regex("""dsh web: (http://127\.0\.0\.1:\d+/\?token=\S+)""")

/** [EngineProcess.extractLastTokenUrl] 的扫描窗口。 */
private const val TOKEN_TAIL_BYTES = 128 * 1024
