package app.kxxy.pty

/**
 * 原生 PTY 桥（JNI → libdsh_pty.so）。
 *
 * 对应 `android/app/src/main/cpp/dsh_pty_jni.c` 的七个导出函数。
 * 刻意保持极薄：这里只有签名声明，不含任何业务逻辑，
 * 使原生层可以脱离 Android 单独编译与测试。
 *
 * 三个必须在原生层补齐的缺口（详见 cpp/dsh_pty.c 文件头）：
 *   G1 close_inherited_fds()      —— 防止孤儿进程占住 3080/3083
 *   G2 PR_SET_PDEATHSIG(SIGTERM)  —— 父进程死亡时子进程随退
 *   G3 execve(cmd, argv, envp)    —— 环境变量完整替换而非继承+覆盖
 */
object PtyBridge {

    init {
        System.loadLibrary("dsh_pty")
    }

    /**
     * 启动一个 PTY 子进程。
     *
     * @param executable 可执行文件**绝对路径**（execve 不搜索 PATH）
     * @param argv       参数数组；调用方无需自己塞 argv[0]，原生层直接透传
     * @param envp       完整环境变量数组（形如 `KEY=value`），非增量
     * @param cwd        工作目录；null 或空串表示不改
     * @param rows       终端行数（默认 40）
     * @param cols       终端列数（默认 120）
     * @return 长度 2 的数组：`[0]` = master fd（>= 0 成功，< 0 为 `-errno`）；
     *         `[1]` = 子进程 pid（失败时为 0）
     */
    external fun nativeForkPty(
        executable: String,
        argv: Array<String>,
        envp: Array<String>,
        cwd: String?,
        rows: Int,
        cols: Int,
    ): IntArray

    /** 调整 PTY 窗口尺寸。返回 0 成功。 */
    external fun nativeResize(master: Int, rows: Int, cols: Int): Int

    /** 向 PTY 写入字节。返回写入字节数，负值为 errno。 */
    external fun nativeWrite(master: Int, data: ByteArray): Int

    /** 关闭 master fd。 */
    external fun nativeClose(master: Int)

    /** 等待子进程退出，返回**原始 wait status**（不是 exit code）。 */
    external fun nativeWaitPid(pid: Int): Int

    /** 向子进程发送信号。返回 0 成功。 */
    external fun nativeKill(pid: Int, sig: Int): Int

    /** 子进程是否仍存活（不回收）。1 = 存活。 */
    external fun nativeAlive(pid: Int): Int

    // ── wait status 解码（POSIX 宏的 Kotlin 等价物）────────────────────
    //
    // 原生层返回原始 wait status，因为 POSIX 的 WIFEXITED/WEXITSTATUS
    // 是宏而非函数，无法跨 FFI 调用。这里手工解码：
    //   status & 0x7f == 0        → 正常退出，exit code = (status >> 8) & 0xff
    //   status & 0x7f != 0        → 信号终止，signal  = status & 0x7f
    // 对照参考项目：日志里以 "engine exited, raw status=0x%x" 记录原始值。

    /** 是否正常退出（未被信号杀死）。 */
    fun isExited(status: Int): Boolean = (status and 0x7f) == 0

    /** 是否被信号终止。 */
    fun isSignaled(status: Int): Boolean = ((status and 0x7f) != 0) && ((status and 0x7f) != 0x7f)

    /** 正常退出时的退出码；非正常退出返回 -1。 */
    fun exitCode(status: Int): Int = if (isExited(status)) (status shr 8) and 0xff else -1

    /** 被信号终止时的信号号；非信号终止返回 -1。 */
    fun termSignal(status: Int): Int = if (isSignaled(status)) status and 0x7f else -1

    /** 把 wait status 渲染成人类可读文本，用于日志。 */
    fun describe(status: Int): String = when {
        isExited(status) -> "exit ${exitCode(status)}"
        isSignaled(status) -> "signal ${termSignal(status)}"
        else -> "raw 0x${status.toString(16)}"
    }

    // ── 信号常量（避免依赖 android.system.OsConstants）──────────────
    const val SIGTERM = 15
    const val SIGKILL = 9
    const val SIGINT = 2
}
