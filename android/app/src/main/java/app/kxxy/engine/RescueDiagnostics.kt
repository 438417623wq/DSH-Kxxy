package app.kxxy.engine

import android.content.Context
import android.os.Build
import android.os.Process
import android.os.StatFs
import android.system.Os
import app.kxxy.WebViewGate
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files

/**
 * 原生救援的只读诊断出口。只读构建元数据、内存状态及固定日志白名单。
 * 不读取 profiles/凭据/会话内容，只查固定用户数据路径的元数据及锁的非敏感 PID；不运行 probe、不写盘、不联网。
 */
object RescueDiagnostics {
    private const val LOG_TAIL_BYTES = 16 * 1024
    private const val DETAIL_TAIL_BYTES = 8 * 1024
    private const val TOTAL_CHARS = 48 * 1024
    private const val TRUNCATED = "\n[output truncated]\n"

    // 对齐 plugins/kxxy-host/lib/redact.mjs，额外覆盖短密码、JSON 引号字段与多词头值。
    private val rules = listOf(
        Regex("""([?&](?:token|access_token|api_key|apikey|key|secret|password|passwd|pwd)=)[^&\s"'<>`]+""", RegexOption.IGNORE_CASE) to "$1***",
        Regex("""__kxxy_pair\?code=[0-9a-f]{6,16}""", RegexOption.IGNORE_CASE) to "__kxxy_pair?code=***",
        Regex("""(authorization:\s*(?:bearer|basic|token)\s+)\S+""", RegexOption.IGNORE_CASE) to "$1***",
        Regex("""(\b(?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]+""", RegexOption.IGNORE_CASE) to "$1***",
        Regex("""\bsk-[A-Za-z0-9_-]{16,}""") to "sk-***",
        Regex("""\bgh[pousr]_[A-Za-z0-9]{16,}""") to "***",
        Regex("""\b(token|secret|password|api[_a-z]*key)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}["']?""", RegexOption.IGNORE_CASE) to "$1=***",
        Regex("""/data/user/0/app\.kxxy/files/home""") to "~",
        Regex("""/data/user/\d+/[^/\s]+/files/home""") to "~",
    )

    private const val SECRET_KEY = "(?:[a-z0-9]+[_-])*(?:token|access[_-]?token|refresh[_-]?token|api[_a-z-]*key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|authorization|set-cookie|cookie)"
    private val quotedValue = Regex(
        """((?<![\w-])["']?$SECRET_KEY["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')""",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
    )
    private val unterminatedValue = Regex(
        """((?<![\w-])["']?$SECRET_KEY["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*\z|'(?:\\.|[^'\\])*\z)""",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
    )
    private val bareValue = Regex(
        """((?<![\w-])["']?$SECRET_KEY["']?\s*[:=]\s*)(?!["'])[^\s,;}&<>"'`]+""",
        RegexOption.IGNORE_CASE,
    )

    /** 可独立测试的纯函数；脱敏先于任何输出截断，保留诊断行的非敏感信息。 */
    fun redact(text: String): String {
        // JSON/带引号赋值先处理，避免 Cookie 规则跨过 JSON 的字段边界。
        var out = quotedValue.replace(text) { "${it.groupValues[1]}\"***\"" }
        out = unterminatedValue.replace(out) { "${it.groupValues[1]}\"***\"" }
        for ((regex, replacement) in rules) out = regex.replace(out, replacement)
        out = bareValue.replace(out) { "${it.groupValues[1]}***" }
        return out
    }

    /** 最多 48 Ki UTF-16 字符（包括截断标识）；每个磁盘来源只读取固定字节尾部。 */
    fun report(ctx: Context, supervisor: EngineSupervisor): String {
        val out = StringBuilder()
        fun section(label: String, text: String) {
            out.append("\n--- ").append(label).append(" ---\n")
            out.append(redact(text).take(LOG_TAIL_BYTES)).append('\n')
        }
        out.append("Kxxy native rescue diagnostics\nLocal read-only; credentials excluded; secrets redacted.\n")
        section("BuildMeta", BuildMeta.snapshot(ctx).toJson())
        section("Build / ABI", buildString {
            append("manufacturer=${Build.MANUFACTURER}; model=${Build.MODEL}\n")
            append("Android=${Build.VERSION.RELEASE}; sdk=${Build.VERSION.SDK_INT}\n")
            append("build=${Build.DISPLAY}\n")
            append("ABI=${Build.SUPPORTED_ABIS.joinToString()}\n")
        })
        val available = try {
            "availableBytes=${StatFs(ctx.filesDir.absolutePath).availableBytes}"
        } catch (_: IllegalArgumentException) {
            "availableBytes=无法确定"
        } catch (_: SecurityException) {
            "availableBytes=无法确定（无权查询）"
        }
        section("Storage (StatFs)", available)
        section("Privilege mode / app identity", buildString {
            append("appUid=${Process.myUid()}; appGid=${Os.getgid()}\n")
            append("requested=${EngineConfig.readPrivMode(ctx)}; effective=${supervisor.effectivePrivilegeMode()}\n")
        })
        section("User data permissions (metadata only)", UserDataPermissions.report(ctx))
        section("Session data permissions (metadata only)", SessionDataPermissions.report(ctx))
        section("Credentials lock (metadata / nonsecret PID only)", CredentialsLockRecovery.report(ctx))
        section("actualWebview", WebViewGate.diagnosticLabel(ctx))
        val state = supervisor.state.value
        section("Engine state", when (state) {
            EngineSupervisor.State.Idle -> "Idle"
            is EngineSupervisor.State.Installing -> "Installing progress=${state.progress}"
            EngineSupervisor.State.Starting -> "Starting"
            is EngineSupervisor.State.Healthy -> "Healthy port=${state.port} (token URL excluded)"
            is EngineSupervisor.State.Backoff -> "Backoff attempt=${state.attempt} delayMs=${state.delayMs}"
            is EngineSupervisor.State.Failed -> "Failed: ${redact(state.reason).take(2000)}"
            EngineSupervisor.State.Stopped -> "Stopped"
        })
        section("native-boot-failure", readTail(ctx,
            File(EngineConfig.engineRoot(ctx), "native-boot-failure.json"), DETAIL_TAIL_BYTES))
        section("engine.log", readTail(ctx, EngineConfig.logFile(ctx), LOG_TAIL_BYTES))
        section("WebBootLog", readTail(ctx, EngineConfig.webBootFile(ctx), DETAIL_TAIL_BYTES))
        section("recovery-result", readTail(ctx, EngineConfig.recoveryResultFile(ctx), DETAIL_TAIL_BYTES))
        section("install-error", readTail(ctx, EngineConfig.installErrorFile(ctx), DETAIL_TAIL_BYTES))
        // 再过一次出口，包含所有元数据/路径及提示；截断绝不暴露半截凭据。
        val safe = redact(out.toString())
        return if (safe.length <= TOTAL_CHARS) safe
        else safe.take(TOTAL_CHARS - TRUNCATED.length) + TRUNCATED
    }

    private fun readTail(ctx: Context, file: File, limit: Int): String = try {
        // 允许 filesDir 自身的系统别名；拒绝白名单内部的软链，不能被引导去读凭据。
        val base = ctx.filesDir.canonicalFile
        val relative = file.relativeTo(ctx.filesDir).path
        val expected = File(base, relative).absoluteFile
        var cursor: File? = expected
        var symlink = false
        while (cursor != null && cursor != base) {
            if (Files.isSymbolicLink(cursor.toPath())) symlink = true
            cursor = cursor.parentFile
        }
        if (cursor != base || symlink || file.canonicalFile != expected) {
            "[omitted: symlink/outside diagnostic path]"
        } else if (!file.isFile) {
            "[missing]"
        } else {
            RandomAccessFile(file, "r").use { input ->
                val length = input.length()
                val count = minOf(length, limit.toLong()).toInt()
                val start = length - count
                input.seek(start)
                val bytes = ByteArray(count)
                var read = 0
                while (read < count) {
                    val n = input.read(bytes, read, count - read)
                    if (n <= 0) break // 兼容并发日志轮转/缩短。
                    read += n
                }
                // 缺失前缀的半行可能是半个 token：丢掉整段半行，不能只做裸 regex。
                val offset = if (start > 0) {
                    val newline = (0 until read).firstOrNull { bytes[it] == '\n'.code.toByte() }
                    if (newline == null) read else newline + 1
                } else 0
                val tail = String(bytes, offset, read - offset, Charsets.UTF_8)
                (if (start > 0) "[tail truncated; first partial line omitted]\n" else "") + redact(tail)
            }
        }
    } catch (_: IOException) {
        "[unavailable: I/O error]"
    } catch (_: SecurityException) {
        "[unavailable: permission denied]"
    } catch (_: IllegalArgumentException) {
        "[omitted: invalid diagnostic path]"
    }
}
