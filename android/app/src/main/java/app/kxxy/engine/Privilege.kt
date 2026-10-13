package app.kxxy.engine

import android.content.Context
import android.util.Log
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 三级权限模型：Normal / Shizuku / Root。
 *
 * 语义（对齐参考项目的设计，每条都有生产事故背书）：
 *
 * - **NORMAL**（默认）：引擎以 app uid 运行，无额外能力。
 * - **SHIZUKU**：引擎**不提权**。Shizuku 只能授予应用本体（binder/远程）能力，
 *   无法改变 fork 出的子进程 uid。所以这里做的是「给 AI 的执行工具注入
 *   adb 身份」，而不是提权引擎本体。
 * - **ROOT**：引擎整体以 su(uid 0) 启动，需要双重警告确认 + 启动前备份。
 */
enum class PrivMode(val id: String) {
    NORMAL("normal"),
    SHIZUKU("shizuku"),
    ROOT("root");

    companion object {
        fun fromId(id: String?): PrivMode =
            entries.firstOrNull { it.id == id } ?: NORMAL
    }
}

/**
 * 权限探测与执行原语。
 *
 * 这里踩过的坑全部与 su 的**实现差异**有关：
 *
 * 1. **su 形式必须实测挑选**
 *    `su -c id` / `su 0 id` / `su root -c id` 三种形式在不同 ROM 上表现不同。
 *    toybox 版 su 只认位置参数，收到 `-c` 会报 `su: invalid uid/gid '-c'`。
 *
 * 2. **探针必须经 shell 解释且必须有输出**
 *    用 `id` 作探针会把「不经 shell 直接 exec」的 su 形式误判为可用
 *    （因为 id 是真二进制，不需要 shell）；改成 `cd / && true` 又因为没有
 *    输出而无法确认，导致所有 su 形式判失败。
 *    正解：`cd / && echo uid=0`，既经 shell 又有可校验输出。
 *
 * 3. **execve 不搜索 PATH**
 *    启动 su 时必须用绝对路径。子进程已 chdir 到工作区，那里没有 su，
 *    传裸 "su" 会直接 ENOENT / exit 127。
 */
object Privilege {

    private const val TAG = "KxxyPrivilege"
    private const val PREFS = "kxxy_priv"
    private const val KEY_MODE = "priv_mode"

    /**
     * su 候选路径。
     *
     * 刻意列全：参考项目 v1.2.108 的事故是自带一份**不完整**的路径表
     * （漏了 /vendor/bin、/data/adb/magisk、/data/adb/ksu），
     * 导致 Magisk/KernelSU 设备上直接跳过击杀，孤儿进程占住端口。
     */
    private val SU_PATHS = listOf(
        "/system/bin/su",
        "/system/xbin/su",
        "/sbin/su",
        "/vendor/bin/su",
        "/su/bin/su",
        "/data/adb/magisk/su",
        "/data/adb/ksu/bin/su",
        "/system/bin/su.d",
        "/system/bin/busybox",
    )

    /**
     * su 的参数形式（**不含可执行文件本身**）。
     *
     * 刻意与 [SU_PATHS] 分离：这里只描述「怎么把命令交给 su」，可执行文件一律由
     * [findSu] 解析成绝对路径后再拼到最前面。二者混在一起正是缺陷 L 的成因 ——
     * 早期版本把裸名 "su" 写在这张表里并直接返回给调用方，而引擎是经 execve
     * 启动的（不搜索 PATH），于是每次 root 启动都 exit 127。
     */
    private val SU_ARG_FORMS = listOf(
        listOf("-c"),
        listOf("0"),
        listOf("root", "-c"),
    )

    // ── 模式持久化 ──────────────────────────────────────────────────────

    fun getMode(ctx: Context): PrivMode {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return PrivMode.fromId(prefs.getString(KEY_MODE, null))
    }

    fun setMode(ctx: Context, mode: PrivMode) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_MODE, mode.id).apply()
    }

    // ── Root 探测 ───────────────────────────────────────────────────────

    /** 仅 stat 判断 su 文件是否存在。**仅供 UI 变灰用** —— 每次读 UI 真跑 su 会反复弹授权框。 */
    fun rootAvailableMinimal(): Boolean = SU_PATHS.any { File(it).exists() }

    /**
     * 实际探测 root 可用性。必须在后台线程调用。
     *
     * 最坏情况要依次试 3 种 su 语法、每种 2 秒超时（首次还会弹 Magisk 授权框），
     * 放主线程最坏阻塞 6 秒以上 → ANR 风险。
     */
    fun probeRoot(): Boolean {
        for (f in SU_ARG_FORMS) {
            if (trySuPrefix(f, "cd / && echo uid=0")) {
                Log.i(TAG, "root probe succeeded with form: su ${f.joinToString(" ")}")
                return true
            }
        }
        Log.w(TAG, "root probe failed for all forms")
        return false
    }

    /**
     * 探测可用的 su 形式前缀，返回 null 表示不可用。
     *
     * **返回值的第一项一定是 su 的绝对路径**（缺陷 L 的修复点）：调用方会把它
     * 直接当作 execve 的 `file` 参数，传裸名会 exit 127。内部探测同样走
     * [trySuPrefix] 的绝对路径形态，保证「探测成功的形态」与「真正使用的形态」
     * 是同一个，不会出现探测通过但启动失败。
     *
     * 两条硬约束（都来自参考项目的回归事故）：
     *   ① 只有经 shell 解释才能成功（探针必须让 shell 执行，而非直接 exec 二进制）
     *   ② 输出必须含 `uid=0`（否则无法区分「su 成功但没输出」和「su 失败」）
     */
    fun usableSuPrefix(): List<String>? {
        val suBin = findSu() ?: return null
        for (f in SU_ARG_FORMS) {
            if (trySuPrefix(f, "cd / && echo uid=0")) {
                return listOf(suBin) + f
            }
        }
        return null
    }

    private fun trySuPrefix(args: List<String>, command: String): Boolean {
        return try {
            val suBin = findSu() ?: return false
            val argv = (listOf(suBin) + args + command).toTypedArray()
            val p = ProcessBuilder(*argv).redirectErrorStream(true).start()
            val finished = p.waitFor(2, TimeUnit.SECONDS)
            if (!finished) {
                p.destroy()
                false
            } else {
                val out = p.inputStream.bufferedReader().readText()
                out.contains("uid=0")
            }
        } catch (e: Exception) {
            Log.w(TAG, "trySuPrefix(${args.joinToString(" ")}) failed: ${e.message}")
            false
        }
    }

    /** 返回第一个存在的 su 绝对路径。 */
    fun findSu(): String? = SU_PATHS.firstOrNull { File(it).exists() }

    /**
     * 以 root 身份执行一条命令。
     *
     * 注意：调用方负责把 command 拼成**经 shell 解释**的形式，
     * 因为不同 su 形式对参数的处理不同。
     */
    fun runSu(command: String, timeoutMs: Long = 5_000L): String? {
        val prefix = usableSuPrefix() ?: return null
        val suBin = findSu() ?: prefix.first()
        val argv = (listOf(suBin) + prefix.drop(1) + command).toTypedArray()
        return try {
            val p = ProcessBuilder(*argv).redirectErrorStream(true).start()
            val finished = p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
            if (!finished) {
                p.destroy()
                null
            } else {
                p.inputStream.bufferedReader().readText()
            }
        } catch (e: Exception) {
            Log.w(TAG, "runSu failed: ${e.message}")
            null
        }
    }

    // ── Shizuku 探测 ────────────────────────────────────────────────────

    /**
     * Shizuku 管理器是否已安装。
     *
     * 委托给 [ShizukuBridge]（单一事实来源）。这里保留薄封装是因为历史调用点
     * 把它当作「Privilege 提供的能力探测」；真实的状态判定（binder 是否送达、
     * 是否已授权）都在 [ShizukuBridge.status] 里，见 [EngineSupervisor.privAvailability]。
     */
    fun shizukuInstalled(ctx: Context): Boolean = ShizukuBridge.installed(ctx)

    // ── dsh-home 属主修复 ───────────────────────────────────────────────

    /**
     * 检测 dsh-home 是否被上次 Root 启动改成了 root 属主。
     *
     * 参考项目 m1.26 的引擎崩溃根因：Root 整体提权会把 dsh-home 里新建/写过的
     * 文件变成 root 属主，之后任何非 Root 启动都会 EACCES。
     */
    fun dshHomeNeedsOwnershipFix(ctx: Context): Boolean {
        if (findSu() == null) return false
        val home = EngineConfig.dshHome(ctx)
        if (!home.isDirectory) return false

        val uid = android.os.Process.myUid()
        val out = runSu("find ${shellQuote(home.absolutePath)} -not -user $uid -print -quit", 3_000L)
        return !out.isNullOrBlank()
    }

    /** 把 dsh-home 递归 chown 回 app uid。 */
    fun fixHomeOwnership(ctx: Context) {
        val home = EngineConfig.dshHome(ctx)
        val uid = android.os.Process.myUid()
        runSu("chown -R $uid:$uid ${shellQuote(home.absolutePath)}", 5_000L)
    }

    // ── 启动前备份（Root 模式） ─────────────────────────────────────────

    /**
     * Root 模式启动前备份 dsh-home。
     *
     * 滚动保留最近 [KEEP_BACKUPS] 份。参考项目 v1.2.22 的事故是无清理，
     * 累积 204 份 × 295 MB = 57.6 GB 堆爆存储。
     */
    fun backupHome(ctx: Context): String? {
        val home = EngineConfig.dshHome(ctx)
        if (!home.isDirectory || home.listFiles().isNullOrEmpty()) return null

        val outDir = File(ctx.filesDir, "root-backup").apply { mkdirs() }
        val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US)
            .format(java.util.Date())
        val out = File(outDir, "kxxy-home.$stamp.tar")

        return try {
            val env = mapOf(
                "PATH" to "${EngineConfig.engineRoot(ctx).absolutePath}/bin:/system/bin:/system/xbin",
                "TMPDIR" to EngineConfig.tmpDir(ctx).absolutePath,
            )
            val pb = ProcessBuilder(
                "/system/bin/tar", "-cf", out.absolutePath, "-C", home.absolutePath, "."
            )
            pb.environment().putAll(env)
            val p = pb.start()
            if (p.waitFor(60, TimeUnit.SECONDS) && out.isFile && out.length() > 0) {
                pruneBackups(outDir)
                out.absolutePath
            } else {
                null
            }
        } catch (e: Exception) {
            Log.w(TAG, "backupHome failed: ${e.message}")
            null
        }
    }

    private fun pruneBackups(dir: File) {
        dir.listFiles()
            ?.filter { it.name.startsWith("kxxy-home.") && it.name.endsWith(".tar") }
            ?.sortedBy { it.name }
            ?.dropLast(KEEP_BACKUPS)
            ?.forEach { it.delete() }
    }

    private const val KEEP_BACKUPS = 2

    // ── 工具 ────────────────────────────────────────────────────────────

    /**
     * POSIX shell 单引号转义。
     *
     * 无特殊字符时仍加引号（保持一致），有单引号时用 `'\''` 序列。
     */
    fun shellQuote(s: String): String {
        if (!s.contains(Regex("[\\s\"'\\\\]"))) return "'$s'"
        return "'" + s.replace("'", "'\\''") + "'"
    }
}
