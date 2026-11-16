package app.kxxy.engine

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** Read-only startup diagnosis. A nonzero exit, timeout or mention of a path is not proof of corruption. */
class RecoveryProbe(private val ctx: Context) {
    enum class Verdict { HIT, MISS, UNKNOWN }
    data class Check(val code: String, val title: String, val verdict: Verdict, val detail: String)
    data class Diagnosis(
        val headline: String,
        val detail: String,
        val raw: String,
        val recommended: RecoveryManager.Level,
        val checks: List<Check>,
        val target: RecoveryManager.Target = RecoveryManager.Target.UNKNOWN,
    ) {
        fun summary(): String = if (detail.isBlank()) headline else "$headline：$detail"
    }

    suspend fun diagnose(): Diagnosis = withContext(Dispatchers.IO) {
        val started = System.currentTimeMillis()
        val result = diagnoseInner()
        Log.i(TAG, "diagnose(${System.currentTimeMillis() - started}ms) → ${result.target} | ${result.detail.take(200)}")
        result
    }

    private suspend fun diagnoseInner(): Diagnosis {
        currentCoroutineContext().ensureActive()
        currentDataIssue()?.let { return it }
        val node = EngineConfig.nodeBin(ctx)
        val entry = EngineConfig.dshEntry(ctx)
        if (!node.isFile || !entry.isFile) return diagnosis(
            RecoveryManager.Target.RUNTIME, "运行时文件缺失", "缺少 ${if (!node.isFile) node.absolutePath else entry.absolutePath}",
        )
        if (!node.canExecute()) return diagnosis(RecoveryManager.Target.ENVIRONMENT, "运行环境异常", "无执行权限：${node.absolutePath}")

        val manifest = EngineConfig.profileManifestFile(ctx)
        if (!manifest.isFile) return diagnosis(RecoveryManager.Target.MANIFEST, "profile 清单缺失", manifest.absolutePath)
        try {
            // Limit static reads as well. A large valid file must not be classified as damaged.
            if (manifest.length() > MAX_STATIC_BYTES) return diagnosis(RecoveryManager.Target.UNKNOWN, "清单过大，未判定", manifest.absolutePath)
            JSONObject(manifest.readText().removePrefix("\uFEFF"))
        } catch (e: JSONException) {
            return diagnosis(RecoveryManager.Target.MANIFEST, "profile 清单损坏", "${manifest.absolutePath}：${e.message}")
        } catch (e: IOException) {
            return diagnosis(RecoveryManager.Target.ENVIRONMENT, "无法读取 profile 清单", "${manifest.absolutePath}：${e.message}")
        } catch (e: SecurityException) {
            return diagnosis(RecoveryManager.Target.ENVIRONMENT, "无法读取 profile 清单", e.message.orEmpty())
        }

        val defaults = dump(true)
        if (!defaults.ok) return failedDump(defaults, defaultsPassed = false)
        val full = dump(false)
        if (!full.ok) return failedDump(full, defaultsPassed = true)
        // dump-config does not read credentials/sessions/storage; current metadata alone can veto RETRY.
        currentDataIssue(defaultsPassed = true, fullPassed = true)?.let { return it }
        return diagnosis(
            RecoveryManager.Target.RETRY, "配置可组装，建议原样重试", "配置检查通过；启动超时或服务异常应检查引擎日志，不修改配置。",
            raw = full.text, defaultsPassed = true, fullPassed = true,
        )
    }

    /** Current read-only helper evidence, in priority order; stale boot logs never authorize recovery. */
    private fun currentDataIssue(defaultsPassed: Boolean = false, fullPassed: Boolean = false): Diagnosis? {
        UserDataPermissions.issue(ctx)?.let { return userDataPermissions(it, defaultsPassed, fullPassed) }
        val issue = SessionDataPermissions.issue(ctx) ?: CredentialsLockRecovery.issue(ctx) ?: return null
        return diagnosis(RecoveryManager.Target.BOOT_DATA, "启动数据异常（会话权限 / 凭据锁）", issue,
            defaultsPassed = defaultsPassed, fullPassed = fullPassed)
    }

    private fun userDataPermissions(detail: String, defaultsPassed: Boolean = false, fullPassed: Boolean = false): Diagnosis =
        diagnosis(RecoveryManager.Target.USER_DATA_PERMISSIONS, "用户数据权限异常", detail,
            defaultsPassed = defaultsPassed, fullPassed = fullPassed)

    private fun failedDump(output: RecoveryProcessRunner.Output, defaultsPassed: Boolean): Diagnosis {
        currentDataIssue(defaultsPassed)?.let { return it }
        val target = if (output.status != RecoveryProcessRunner.Status.EXITED || output.truncated)
            RecoveryManager.Target.UNKNOWN else classify(output.text)
        val headline = when (target) {
            RecoveryManager.Target.PROFILE_PATCH -> "profile 补丁损坏"
            RecoveryManager.Target.HOME_PATCH -> "\$HOME 级补丁损坏"
            RecoveryManager.Target.OVERLAY -> "Android 覆盖层异常"
            RecoveryManager.Target.MANIFEST -> "profile 清单损坏"
            RecoveryManager.Target.BUNDLES -> "bundle 挂载失败"
            RecoveryManager.Target.RUNTIME -> "运行时加载失败"
            RecoveryManager.Target.ENVIRONMENT -> "运行环境异常"
            else -> "诊断未能确定故障层"
        }
        return diagnosis(target, headline, firstErrorLine(output.text).ifBlank { "诊断命令失败，未确定配置损坏" }, output.text, defaultsPassed)
    }

    private fun diagnosis(
        target: RecoveryManager.Target, headline: String, detail: String, raw: String = detail,
        defaultsPassed: Boolean = false, fullPassed: Boolean = false,
    ): Diagnosis {
        fun check(code: String, title: String, targets: Set<RecoveryManager.Target>, passed: Boolean = false): Check =
            Check(code, title, when { target in targets -> Verdict.HIT; passed -> Verdict.MISS; else -> Verdict.UNKNOWN },
                when { target in targets -> detail; passed -> "检查通过"; else -> "未确定，保留原配置" })
        return Diagnosis(headline, detail, raw, when (target) {
            RecoveryManager.Target.RUNTIME -> RecoveryManager.Level.L3
            RecoveryManager.Target.BUNDLES -> RecoveryManager.Level.L2
            else -> RecoveryManager.Level.L1
        }, listOf(
            check("A", "用户补丁与覆盖层", setOf(RecoveryManager.Target.PROFILE_PATCH, RecoveryManager.Target.HOME_PATCH, RecoveryManager.Target.OVERLAY), fullPassed),
            check("B", "bundle 挂载", setOf(RecoveryManager.Target.BUNDLES), defaultsPassed),
            check("C", "运行时与环境", setOf(RecoveryManager.Target.RUNTIME, RecoveryManager.Target.ENVIRONMENT), fullPassed),
            check("D", "profile 清单", setOf(RecoveryManager.Target.MANIFEST), defaultsPassed),
            check("E", "用户数据权限（凭据与存储，仅元数据）", setOf(RecoveryManager.Target.USER_DATA_PERMISSIONS), target != RecoveryManager.Target.USER_DATA_PERMISSIONS),
            check("F", "启动数据（会话权限 / 凭据锁，仅元数据）", setOf(RecoveryManager.Target.BOOT_DATA), fullPassed),
        ), target)
    }

    private suspend fun dump(defaultOnly: Boolean): RecoveryProcessRunner.Output {
        val argv = buildList {
            add(EngineConfig.nodeBin(ctx).absolutePath); add("--expose-internals")
            add(EngineConfig.dshEntry(ctx).absolutePath); add("web")
            add(if (defaultOnly) "--dump-default-config" else "--dump-config")
            if (!defaultOnly && EngineConfig.overlayFile(ctx).isFile) {
                add("--patch"); add(EngineConfig.overlayFile(ctx).absolutePath)
            }
        }
        val builder = ProcessBuilder(argv)
        // Do not mkdir workspaces: diagnosis is strictly read-only, including static/preflight errors.
        val workspace = EngineConfig.workspaces(ctx)
        builder.directory(if (workspace.isDirectory) workspace else ctx.filesDir)
        builder.environment().apply {
            clear()
            for (kv in EngineConfig.buildEnv(ctx, EngineConfig.DEFAULT_PORT, EngineConfig.readPrivMode(ctx))) {
                val i = kv.indexOf('='); if (i > 0) put(kv.substring(0, i), kv.substring(i + 1))
            }
        }
        return RecoveryProcessRunner.run(builder)
    }

    /** Only explicit failure messages naming the exact layer authorize its mutation. No prose/path fallbacks. */
    private fun classify(text: String): RecoveryManager.Target {
        val errors = text.lineSequence().map { it.trim() }.filter {
            (it.startsWith("Error:") || it.startsWith("error:") || it.startsWith("YAMLException:")) && !it.contains("throw new Error")
        }.toList()
        if (errors.any { line -> listOf("EACCES", "EPERM", "ENOSPC", "CANNOT LINK EXECUTABLE", "Permission denied").any { line.contains(it, true) } })
            return RecoveryManager.Target.ENVIRONMENT
        val layers = listOf(
            EngineConfig.profilePatchFile(ctx) to RecoveryManager.Target.PROFILE_PATCH,
            EngineConfig.homePatchFile(ctx) to RecoveryManager.Target.HOME_PATCH,
            EngineConfig.overlayFile(ctx) to RecoveryManager.Target.OVERLAY,
        )
        for (line in errors) {
            if (line.contains("failed to parse", true)) {
                for ((path, target) in layers) if (namesPath(line, path)) return target
                if (line.contains("profile manifest", true)) return RecoveryManager.Target.MANIFEST
            }
            if (line.contains("profile manifest", true) && listOf("not a JSON object", "invalid JSON", "not valid JSON").any { line.contains(it, true) })
                return RecoveryManager.Target.MANIFEST
            if (line.contains("bundle", true) && listOf("failed to load bundle", "failed to mount bundle", "cannot find bundle", "failed to resolve bundle").any { line.contains(it, true) })
                return RecoveryManager.Target.BUNDLES
        }
        return RecoveryManager.Target.UNKNOWN
    }

    private fun namesPath(line: String, file: File): Boolean {
        val path = file.absolutePath
        val start = line.indexOf(path)
        if (start < 0) return false
        val end = start + path.length
        return (start == 0 || line[start - 1] in " \"'(") && (end == line.length || line[end] in ": \"')")
    }

    private fun firstErrorLine(text: String): String {
        val lines = text.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }
        return (lines.firstOrNull { it.startsWith("Error:") || it.startsWith("error:") }
            ?: text.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty()).take(300)
    }

    companion object {
        private const val TAG = "KxxyRecovery"
        private const val MAX_STATIC_BYTES = 1024 * 1024L
    }
}
