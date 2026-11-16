package app.kxxy.engine

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Targeted recovery with a write-ahead, atomically persisted undo journal. No automatic backup pruning. */
class RecoveryManager(private val ctx: Context) {
    enum class Level { L1, L2, L3 }
    enum class Target { PROFILE_PATCH, HOME_PATCH, OVERLAY, MANIFEST, BUNDLES, RUNTIME, RETRY, ENVIRONMENT, USER_DATA_PERMISSIONS, BOOT_DATA, UNKNOWN }
    data class Result(
        val level: Level, val backupDir: File, val changes: List<String>, val needsNetwork: Boolean = false,
        val target: Target? = null, val success: Boolean = true, val detail: String = "", val undoable: Boolean = true,
        val needsRoot: Boolean = false,
    )
    data class Record(val dir: File, val createdAt: Long, val level: Level, val changes: List<String>, val headline: String)

    @Volatile var lastUndoDetail: String = ""
        private set

    suspend fun recover(level: Level, headline: String = "", target: Target? = null, allowRoot: Boolean = false,
        writersStopped: Boolean = false): Result = withContext(Dispatchers.IO + RecoveryFiles.trustedContext(ctx.filesDir)) {
        LOCK.withLock {
            if (target in setOf(Target.RETRY, Target.UNKNOWN, Target.ENVIRONMENT)) {
                return@withLock Result(level, EngineConfig.recoveryRoot(ctx), emptyList(), target = target,
                    detail = "未修改任何配置；请原样重试或检查运行环境。", undoable = false)
            }
            // null is an explicit old/manual call, not permission to discard both valid patches.
            val observed = if (target == null) RecoveryProbe(ctx).diagnose().target else target
            if (observed == Target.BOOT_DATA) {
                if (!writersStopped) return@withLock Result(level, EngineConfig.recoveryRoot(ctx), emptyList(),
                    target = Target.BOOT_DATA, success = false, detail = "未确认旧引擎已停止，未修改会话权限或凭据锁。", undoable = false)
                val rootAllowed = target == Target.BOOT_DATA && allowRoot
                val sessions = SessionDataPermissions.repair(ctx, rootAllowed)
                if (!sessions.success) return@withLock Result(level, EngineConfig.recoveryRoot(ctx), sessions.changes,
                    target = Target.BOOT_DATA, success = false, detail = sessions.detail, undoable = false, needsRoot = sessions.needsRoot)
                val credentialsLock = CredentialsLockRecovery.repair(ctx, rootAllowed, writersStopped)
                return@withLock Result(level, EngineConfig.recoveryRoot(ctx), sessions.changes + credentialsLock.changes,
                    target = Target.BOOT_DATA, success = credentialsLock.success,
                    detail = sessions.detail + "\n" + credentialsLock.detail, undoable = false, needsRoot = credentialsLock.needsRoot)
            }
            if (observed == Target.USER_DATA_PERMISSIONS) {
                // 权限恢复只改元数据，不能借配置修复移走凭据或收缩插件列表。
                val outcome = UserDataPermissions.repair(ctx, allowRoot = target == Target.USER_DATA_PERMISSIONS && allowRoot)
                return@withLock Result(level, EngineConfig.recoveryRoot(ctx), outcome.changes,
                    target = Target.USER_DATA_PERMISSIONS, success = outcome.success, detail = outcome.detail,
                    undoable = false, needsRoot = outcome.needsRoot)
            }
            val tx = Transaction(level, headline, target)
            try {
                when (target) {
                    Target.RUNTIME -> {
                        // Record the non-undoable managed-runtime action BEFORE invoking installer.
                        tx.json.put("undoable", false).put("runtimeReinstall", "planned"); tx.save()
                        val recoveryContext = currentCoroutineContext()
                        var loggedProgress = -1
                        runInterruptible(Dispatchers.IO) {
                            RuntimeInstaller(ctx).forceReinstall { fraction ->
                                recoveryContext.ensureActive()
                                val progress = (fraction.coerceIn(0f, 1f) * 10).toInt()
                                if (progress > loggedProgress) {
                                    loggedProgress = progress
                                    Log.i(TAG, "runtime recovery ${progress * 10}%")
                                }
                            }
                        }
                        tx.json.put("runtimeReinstall", "completed")
                        tx.change("重新安装受管理运行时（不修改用户配置；此动作不可撤销）")
                    }
                    Target.PROFILE_PATCH -> tx.move(EngineConfig.profilePatchFile(ctx), "移走 profile 补丁")
                    Target.HOME_PATCH -> tx.move(EngineConfig.homePatchFile(ctx), "移走 home 补丁")
                    Target.OVERLAY -> tx.write(EngineConfig.overlayFile(ctx), EngineConfig.overlayContent(ctx), "重新生成 Android 覆盖层")
                    Target.MANIFEST -> tx.write(EngineConfig.profileManifestFile(ctx), EngineConfig.minimalProfileManifest(), "重建 profile 清单")
                    Target.BUNDLES -> repairBundles(tx, level)
                    null -> {
                        when (observed) {
                            Target.PROFILE_PATCH -> tx.move(EngineConfig.profilePatchFile(ctx), "移走已确认损坏的 profile 补丁")
                            Target.HOME_PATCH -> tx.move(EngineConfig.homePatchFile(ctx), "移走已确认损坏的 home 补丁")
                            Target.OVERLAY -> tx.write(EngineConfig.overlayFile(ctx), EngineConfig.overlayContent(ctx), "重新生成已确认异常的覆盖层")
                            Target.MANIFEST -> tx.write(EngineConfig.profileManifestFile(ctx), EngineConfig.minimalProfileManifest(), "重建已确认损坏的清单")
                            else -> Unit // unknown, timeout and valid patches are retained
                        }
                        // Manual L1/2/3 explicitly permits bundle isolation; unreadable JSON is NOT replaced by guessing.
                        repairBundles(tx, level)
                    }
                    else -> Unit
                }
                tx.json.put("status", "completed").put("undoable", target != Target.RUNTIME && tx.actions.length() > 0)
                tx.save()
                Result(level, tx.dir, tx.changes.toList(), needsNetwork = target != Target.RUNTIME && level == Level.L3 &&
                    (target == null || target == Target.BUNDLES), target = target,
                    detail = if (tx.changes.isEmpty()) "配置验证后保留原样，无需修改。" else "修改已登记，备份完整保留。",
                    undoable = tx.json.optBoolean("undoable"))
            } catch (e: Exception) {
                tx.json.put("status", "failed").put("error", e.message ?: e.javaClass.simpleName)
                    .put("undoable", target != Target.RUNTIME && tx.actions.length() > 0)
                runCatching { tx.save() }
                if (e is CancellationException) throw e
                Log.w(TAG, "recover 失败，保留事务 ${tx.dir}: ${e.message}")
                Result(level, tx.dir, tx.changes.toList(), target = target, success = false,
                    detail = "恢复未全部完成：${e.message}；已保留备份与清单。", undoable = tx.json.optBoolean("undoable"))
            }
        }
    }

    private suspend fun repairBundles(tx: Transaction, level: Level) {
        val file = EngineConfig.profileManifestFile(ctx)
        RecoveryFiles.requireSafeParents(file)
        check(file.isFile && file.length() <= MAX_MANIFEST_BYTES) { "清单缺失/过大；未确定损坏，不自动覆盖" }
        val json = JSONObject(file.readText().removePrefix("\uFEFF"))
        val dsh = json.optJSONObject("dsh") ?: error("清单缺少 dsh 对象，需明确选择清单恢复")
        val profile = dsh.optJSONObject("profile") ?: error("清单缺少 profile 对象，需明确选择清单恢复")
        val bundles = profile.optJSONArray("bundles") ?: error("清单缺少 bundles 数组，需明确选择清单恢复")
        val current = (0 until bundles.length()).map { i ->
            val value = bundles.get(i)
            check(value is String && validPackage(value)) { "非法 bundle 名称；不隔离未知路径" }
            value
        }
        val removed = current.filterNot { EngineConfig.isCoreBundle(it) }
        // After an L1 shrink, reuse recorded original names for an explicit L2 escalation.
        val reusable = recoverableRecords().flatMap { (_, record) -> strings(record.optJSONArray("removedBundles")) }
        val candidates = (removed + reusable).distinct().filter { validPackage(it) && !EngineConfig.isCoreBundle(it) }
        tx.json.put("removedBundles", JSONArray(candidates)); tx.save()
        if (current != EngineConfig.CORE_BUNDLES) {
            profile.put("bundles", JSONArray(EngineConfig.CORE_BUNDLES))
            tx.write(file, json.toString(2) + "\n", "收缩 bundles 到核心三项（原清单完整备份）")
        }
        if (level == Level.L2) {
            for (name in candidates) {
                currentCoroutineContext().ensureActive()
                tx.move(File(EngineConfig.profileModulesDir(ctx), name), "隔离第三方包 $name")
            }
            // Keep empty @scope parents: deleting them would be another unregistered modification.
        } else if (level == Level.L3) {
            tx.move(EngineConfig.profileModulesDir(ctx), "整体备份 profile/node_modules（可撤销）")
        }
    }

    /** Returns false on ANY conflict/failure; successfully restored actions remain marked for retry. */
    suspend fun undoLatest(): Boolean = withContext(Dispatchers.IO + RecoveryFiles.trustedContext(ctx.filesDir)) {
        LOCK.withLock {
            val selected = recoverableRecords().firstOrNull()
            if (selected == null) { lastUndoDetail = "没有可撤销的恢复记录"; return@withLock false }
            val (dir, json) = selected
            if (json.optInt("version", 1) != 2) {
                lastUndoDetail = "旧版清单缺少完整写入前状态，不能安全自动撤销；备份保留在 ${dir.absolutePath}"
                return@withLock false
            }
            val conflicts = mutableListOf<String>()
            val actions = json.optJSONArray("actions") ?: JSONArray()
            for (i in actions.length() - 1 downTo 0) {
                currentCoroutineContext().ensureActive()
                val action = actions.optJSONObject(i) ?: continue
                if (action.optString("state") == "restored") continue
                try {
                    undoAction(dir, action)
                    action.put("state", "restored")
                    RecoveryFiles.atomicText(File(dir, MANIFEST_NAME), json.toString(2) + "\n")
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    conflicts += "${action.optString("label")}：${e.message}"
                }
            }
            if (conflicts.isEmpty()) {
                json.put("status", "undone").put("undoable", false)
                RecoveryFiles.atomicText(File(dir, MANIFEST_NAME), json.toString(2) + "\n")
                lastUndoDetail = "已完整撤销；备份与清单保留。"
                true
            } else {
                json.put("status", "undo_conflict").put("undoErrors", JSONArray(conflicts))
                RecoveryFiles.atomicText(File(dir, MANIFEST_NAME), json.toString(2) + "\n")
                lastUndoDetail = "未全部撤销，冲突文件未覆盖，备份保留：${conflicts.joinToString("；")}"
                false
            }
        }
    }

    private fun undoAction(dir: File, action: JSONObject) {
        val target = File(action.getString("restoreTo"))
        val backup = File(dir, action.getString("backup"))
        // Treat records as untrusted: no path escape, external writes or traversal through a symlink.
        val allowed = listOf(EngineConfig.profilePatchFile(ctx), EngineConfig.homePatchFile(ctx),
            EngineConfig.overlayFile(ctx), EngineConfig.profileManifestFile(ctx), EngineConfig.profileModulesDir(ctx))
        val modules = EngineConfig.profileModulesDir(ctx).absoluteFile.toPath().normalize()
        val normalized = target.absoluteFile.toPath().normalize()
        check(allowed.any { it.absoluteFile.toPath().normalize() == normalized } ||
            (normalized.startsWith(modules) && validPackage(modules.relativize(normalized).toString().replace('\\', '/')))) { "非法还原路径" }
        check(backup.parentFile == dir && backup.name == action.getString("backup")) { "非法备份路径" }
        RecoveryFiles.requireSafeParents(target); RecoveryFiles.requireSafeParents(backup)
        val before = action.getString("before")
        val after = action.getString("after")
        val live = RecoveryFiles.fingerprint(target)
        if (action.getString("kind") == "write" && before == "absent") {
            if (live == "absent") return
            check(live == after) { "新建目标已被用户修改，保留现状" }
            RecoveryFiles.deleteTreeNoFollow(target)
            return
        }
        if (!RecoveryFiles.exists(backup)) {
            // Crash before modification, or crash after a completed move-back: already at original state.
            check(live == before) { "备份缺失且目标不是原状态" }
            return
        }
        check(RecoveryFiles.fingerprint(backup) == before) { "备份内容已变化，拒绝覆盖" }
        if (action.getString("kind") == "move") {
            // A pending rename can have a backup only after it actually happened.
            check(live == "absent") { "目标已存在，保留新文件和备份" }
            RecoveryFiles.move(backup, target)
        } else {
            if (live == before) return // Write never happened, or already undone before a journal flush.
            check(live == after) { "目标被用户修改，保留现状和备份" }
            if (before == "absent") RecoveryFiles.deleteTreeNoFollow(target)
            else {
                check(backup.isFile) { "备份不是普通文件" }
                RecoveryFiles.atomicWrite(target, backup.readBytes())
                target.setExecutable(backup.canExecute(), true)
            }
        }
    }

    fun latestRecord(): Record? = allRecords().firstOrNull()?.let { (dir, json) ->
        Record(dir, json.optLong("createdAt", dir.lastModified()),
            runCatching { Level.valueOf("L" + json.optString("level", "1")) }.getOrDefault(Level.L1),
            strings(json.optJSONArray("changes")), json.optString("headline"))
    }
    fun backupCount(): Int = recoverableRecords().size

    private fun allRecords(): List<Pair<File, JSONObject>> =
        EngineConfig.recoveryRoot(ctx).listFiles().orEmpty().mapNotNull { dir ->
            if (!dir.isDirectory || java.nio.file.Files.isSymbolicLink(dir.toPath())) return@mapNotNull null
            val manifest = File(dir, MANIFEST_NAME)
            if (!manifest.isFile || java.nio.file.Files.isSymbolicLink(manifest.toPath()) || manifest.length() > MAX_MANIFEST_BYTES) return@mapNotNull null
            runCatching { dir to JSONObject(manifest.readText()) }.getOrNull()
        }.sortedWith(compareByDescending<Pair<File, JSONObject>> { it.second.optLong("createdAt") }.thenByDescending { it.first.name })

    private fun recoverableRecords() = allRecords().filter { (_, json) ->
        json.optBoolean("undoable", true) && json.optString("status") != "undone"
    }
    private fun strings(arr: JSONArray?): List<String> = if (arr == null) emptyList() else
        (0 until arr.length()).mapNotNull { arr.optString(it).takeIf(String::isNotBlank) }
    private fun validPackage(name: String): Boolean = Regex("(?:@[A-Za-z0-9._~-]+/)?[A-Za-z0-9_~][A-Za-z0-9._~-]*").matches(name) &&
        name.split('/').none { it == "." || it == ".." }

    private inner class Transaction(level: Level, headline: String, target: Target?) {
        private val createdAt = NEXT_ID.updateAndGet { maxOf(System.currentTimeMillis(), it + 1) }
        val dir = File(EngineConfig.recoveryRoot(ctx), "${createdAt}-${UUID.randomUUID()}")
        val actions = JSONArray()
        val changes = mutableListOf<String>()
        val json = JSONObject().put("version", 2).put("id", dir.name).put("createdAt", createdAt)
            .put("level", level.name.removePrefix("L")).put("target", target?.name ?: "MANUAL")
            .put("headline", headline).put("status", "planned").put("undoable", target != Target.RUNTIME)
            .put("actions", actions).put("changes", JSONArray())
        init {
            RecoveryFiles.requireSafeParents(dir)
            check(dir.mkdirs()) { "无法创建唯一备份目录：$dir" }
            save() // A durable transaction exists before ANY live-file changes.
        }
        fun save() {
            json.put("changes", JSONArray(changes))
            RecoveryFiles.atomicText(File(dir, MANIFEST_NAME), json.toString(2) + "\n")
        }
        fun change(label: String) { changes += label; save() }
        suspend fun move(source: File, label: String) {
            currentCoroutineContext().ensureActive()
            if (!RecoveryFiles.exists(source)) return
            RecoveryFiles.requireSafeParents(source)
            check(source.isFile || source.isDirectory || java.nio.file.Files.isSymbolicLink(source.toPath())) { "不支持的文件类型" }
            val backup = File(dir, "${actions.length()}-${source.name}")
            val before = RecoveryFiles.fingerprint(source)
            val action = register("move", source, backup, before, "absent", label)
            check(RecoveryFiles.fingerprint(source) == before) { "文件在登记期间发生变化，保留原样" }
            // Journal is persisted before rename (including L3 whole-directory moves).
            RecoveryFiles.move(source, backup)
            action.put("state", "applied"); change(label)
        }
        suspend fun write(source: File, text: String, label: String) {
            currentCoroutineContext().ensureActive()
            RecoveryFiles.requireSafeParents(source)
            check(!java.nio.file.Files.isSymbolicLink(source.toPath())) { "拒绝改写软链：$source" }
            if (source.isFile && source.readText() == text) return
            val backup = File(dir, "${actions.length()}-${source.name}")
            val before = RecoveryFiles.fingerprint(source)
            // Compute intended post-write fingerprint with the same primitive, without touching live config.
            val staging = File(dir, "${actions.length()}-next")
            val action = register("write", source, backup, before, "pending", label)
            RecoveryFiles.atomicText(staging, text)
            action.put("after", RecoveryFiles.fingerprint(staging)); save()
            if (before != "absent") RecoveryFiles.copySnapshot(source, backup)
            action.put("state", "backed_up"); save()
            check(RecoveryFiles.fingerprint(source) == before) { "文件在备份期间发生变化，保留原样" }
            RecoveryFiles.atomicText(source, text)
            action.put("state", "applied"); change(label)
            // Retain staging as evidence too; no unregistered cleanup of user/backup trees.
        }
        private fun register(kind: String, source: File, backup: File, before: String, after: String, label: String): JSONObject {
            val action = JSONObject().put("kind", kind).put("restoreTo", source.absolutePath).put("backup", backup.name)
                .put("before", before).put("after", after).put("label", label).put("state", "planned")
            actions.put(action); save()
            return action
        }
    }
    companion object {
        const val MANIFEST_NAME = "manifest.json"
        private const val TAG = "KxxyRecovery"
        private const val MAX_MANIFEST_BYTES = 1024 * 1024L
        private val LOCK = Mutex()
        private val NEXT_ID = java.util.concurrent.atomic.AtomicLong(0)
    }
}
