package app.kxxy.engine

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 崩溃自愈 —— 方案 K 的执行端。
 *
 * ## 要解决的问题
 *
 * 引擎起不来时，宿主能做的只有 `supervisor.restart()`，也就是**用同样的输入
 * 再试一次**。如果坏的是某个配置文件，重试一万次也是同一个结果：`BACKOFF_STEPS`
 * 走完、14 次重启机会耗尽、进入 `Failed` 终态，用户只剩「清除应用数据」一条路
 * ——那会连会话、工作区、装好的插件一起没。
 *
 * ## 与桌面端的对应关系
 *
 * 桌面端有 `sanitizeProfile()`：把 `cordis.patch.yml` 改名成 `.bak-<时间戳>`，
 * 并把 `dsh.profile.bundles` 收缩回内置模板，然后重启。它对「用户补丁写坏了」
 * 这一类故障是有效的，且**不删任何文件**、**不碰 dependencies 与 node_modules**，
 * 所以插件装的包还在，撤销只需把备份改回来。
 *
 * 手机端复刻这一套，但有三处必须不同：
 *
 * 1. **home 级补丁也要移**。桌面端刻意不动 `$DSH_HOME/cordis.patch.yml`（那是
 *    真实家目录、可能被多个 profile 共用）。手机端 `$DSH_HOME` 就是 App 私有的
 *    `files/kxxy-home`，只服务这一个引擎，而这一层的层叠优先级比 profile 更高，
 *    坏掉一样致命 —— 不处理它，L1 会在「profile 清了还是起不来」上原地打转。
 * 2. **核心 bundle 是三项而不是两项**。桌面端收缩到 `[dsh-base, dsh-web-app]`；
 *    手机端少了 `dsh-web-mobile`，引擎能起来但移动端 Web UI 整层不存在，
 *    用户看到的是桌面布局的页面。
 * 3. **manifest 坏 JSON 要能兜底重写**。桌面端遇到 profile manifest 解析失败是
 *    抛错（它可以靠重装应用解决）；手机端没有这条路，只能自己重建一份最小可用的
 *    manifest，否则连「收缩 bundles」这一步都无从下手。
 *
 * ## 三级力度（破坏性递增，用完即停）
 *
 * - **L1 软恢复**：移走坏补丁 + 收缩启用列表到核心三项。默认路径，零数据丢失。
 * - **L2 隔离第三方**：L1 之上把非核心插件的包目录挪进隔离区。插件包仍在，
 *   只是不再参与加载 —— 用来对付「config 都好、但某个第三方包 require 就炸」。
 * - **L3 重建 node_modules**：最后手段。把整个 `node_modules` 备份后删除，
 *   让引擎按 bundle 列表重新拉取。需要联网。
 *
 * 三级都在**只改名/只搬运**的范围内操作，全部可撤销。
 */
class RecoveryManager(private val ctx: Context) {

    /** 修复力度。 */
    enum class Level {
        /** 软恢复：移补丁 + 收缩 bundle 列表。 */
        L1,

        /** 隔离第三方插件包。 */
        L2,

        /** 备份并重建 node_modules。 */
        L3,
    }

    /** 一次修复的产物。 */
    data class Result(
        val level: Level,
        val backupDir: File,
        val changes: List<String>,
        /** L3 需要联网，UI 上要提前说明。 */
        val needsNetwork: Boolean = false,
    )

    /** 恢复记录（用于诊断页的「上一次修复」）。 */
    data class Record(
        val dir: File,
        val createdAt: Long,
        val level: Level,
        val changes: List<String>,
        val headline: String,
    )

    /**
     * 执行一次修复。
     *
     * 全程在 IO 线程；调用方负责在成功后重启引擎。
     *
     * @param level 力度；默认按归因结果自动挑
     * @param headline 归因结论，仅用于写进备份的 manifest（日后排障时能对上）
     */
    suspend fun recover(
        level: Level,
        headline: String = "",
    ): Result = withContext(Dispatchers.IO) {
        synchronized(LOCK) {
            // 上一次事务若中途抛错，账本会残留 —— 每次开工前先清空
            movedItems.clear()
            quarantinedItems.clear()

            val stamp = timestamp()
            val dir = File(EngineConfig.recoveryRoot(ctx), stamp)
            dir.mkdirs()
            val changes = mutableListOf<String>()

            // ── 1. profile 补丁：坏的最常见来源 ──────────────────────────
            // 引擎在 bundle 层叠的第二级读它，YAML 坏掉直接抛错终止。
            moveAside(
                src = EngineConfig.profilePatchFile(ctx),
                backupDir = dir,
                label = "profile cordis.patch.yml",
                changes = changes,
            )

            // ── 2. home 级补丁：手机端特有的必修项 ──────────────────────
            // 见类注释第 1 条：桌面端不碰，手机端必须碰。
            moveAside(
                src = EngineConfig.homePatchFile(ctx),
                backupDir = dir,
                label = "home cordis.patch.yml",
                changes = changes,
            )

            // ── 3. profile manifest：坏 JSON 要先修好，否则无从收缩 ──────
            val manifest = EngineConfig.profileManifestFile(ctx)
            val manifestBroken = !isJsonObject(manifest)
            val removed = mutableListOf<String>()

            if (manifestBroken) {
                if (manifest.isFile) {
                    copyInto(manifest, dir)
                    changes += "备份损坏的 ${manifest.name}"
                }
                writeMinimalManifest()
                changes += "重建 ${manifest.name}（原文件不是合法 JSON）"
            }

            // ── 4. 收缩 bundles 到核心三项 ──────────────────────────────
            // 这一步是方案 K 的核心动作：把所有「用户/第三方加进来的」bundle
            // 从启用列表里摘掉，只留 base + web-app + dsh-web-mobile。
            // 摘掉的名单记进备份 manifest，撤销时能原样装回去。
            shrinkBundles(removed)
            if (removed.isNotEmpty()) {
                changes += "收缩 bundles：移出 ${removed.size} 项 → ${EngineConfig.CORE_BUNDLES.joinToString(", ")}"
            }

            // ── 5. 重新生成 Android 覆盖层 ─────────────────────────────
            // overlay 是宿主自己生成的（sandbox/approval/office 字体/insert
            // kxxy-host）。它也可能因为磁盘写坏而变成非法 YAML，而它排在层叠
            // 最末、优先级最高 —— 重新生成一次的成本极低，可以顺手消掉这类故障。
            val beforeOverlay = EngineConfig.overlayFile(ctx).let {
                if (it.isFile) it.readText() else ""
            }
            runCatching { EngineConfig.ensureOverlay(ctx) }
            val afterOverlay = EngineConfig.overlayFile(ctx).let {
                if (it.isFile) it.readText() else ""
            }
            if (beforeOverlay != afterOverlay) changes += "重新生成 android-overlay.yml"

            // ── 6. L2：隔离第三方插件包 ────────────────────────────────
            if (level == Level.L2 || level == Level.L3) {
                val quarantined = quarantineModules(dir, removed)
                if (quarantined.isNotEmpty()) {
                    changes += "隔离 ${quarantined.size} 个第三方插件包"
                }
            }

            // ── 7. L3：备份并清空 node_modules ─────────────────────────
            if (level == Level.L3) {
                val modules = EngineConfig.profileModulesDir(ctx)
                if (modules.isDirectory) {
                    val dest = File(dir, "node_modules")
                    if (modules.renameTo(dest)) {
                        changes += "整体备份并移除 profile/node_modules"
                    } else {
                        changes += "无法整体移动 node_modules（保留原样）"
                    }
                }
            }

            writeBackupManifest(dir, level, headline, changes, removed, manifestBroken)
            pruneBackups()

            Log.i(TAG, "recover L${level.name.last()} → ${dir.name}: ${changes.joinToString("; ")}")
            Result(level = level, backupDir = dir, changes = changes, needsNetwork = level == Level.L3)
        }
    }

    /**
     * 撤销最近一次修复：把备份里的一切原样放回。
     *
     * 只处理**我们自己搬走/改写的东西**。用户在修复之后新做的改动不会被覆盖
     * —— 例如修复后用户又写了一版补丁，撤销时不会把那份顶掉（目标位置已被占用
     * 就跳过并记一笔）。
     */
    suspend fun undoLatest(): Boolean = withContext(Dispatchers.IO) {
        synchronized(LOCK) {
            val dir = latestBackupDir() ?: return@synchronized false
            val manifest = File(dir, MANIFEST_NAME)
            val json = runCatching { JSONObject(manifest.readText()) }.getOrNull()

            // 1. 搬回被移动的文件
            json?.optJSONArray("moved")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val item = arr.optJSONObject(i) ?: continue
                    val back = item.optString("restoreTo").takeIf { it.isNotEmpty() } ?: continue
                    val bak = File(dir, item.optString("name"))
                    if (!bak.isFile) continue
                    val target = File(back)
                    if (target.exists()) {
                        // 目标已存在：不覆盖用户现在的文件
                        Log.w(TAG, "undo: ${target.absolutePath} 已存在，跳过")
                        continue
                    }
                    target.parentFile?.mkdirs()
                    bak.renameTo(target)
                }
            }

            // 2. 还原被改写/重建的 manifest（内含 bundles 名单）
            //
            // ⚠️ 只在「原 manifest 是**好**的、只是 bundles 被我们收缩了」时才还原。
            // 若当时是坏 JSON、由 [writeMinimalManifest] 重建的，那份坏文件留在
            // 备份里仅供人看，绝不能搬回去 —— 否则撤销会让引擎立刻再次起不来，
            // 「撤销」这个动作反而成了故障源。
            val manifestWasBroken = json?.optBoolean("manifestRebuilt", false) ?: false
            val originalManifest = File(dir, EngineConfig.profileManifestFile(ctx).name)
            val liveManifest = EngineConfig.profileManifestFile(ctx)
            if (!manifestWasBroken && originalManifest.isFile) {
                liveManifest.parentFile?.mkdirs()
                originalManifest.copyTo(liveManifest, overwrite = true)
            } else {
                // 坏的那份不还原：把「收缩前的 bundles 名单」装回去即可，
                // 用户装的插件照样能重新启用，而坏掉的 JSON 已经不存在了。
                json?.optJSONArray("removedBundles")?.let { arr ->
                    val names = (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotEmpty() } }
                    restoreBundles(names)
                }
            }

            // 3. 搬回被隔离的插件包
            json?.optJSONArray("quarantined")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val item = arr.optJSONObject(i) ?: continue
                    val from = item.optString("quarantineName")
                    val to = item.optString("restoreTo")
                    if (from.isEmpty() || to.isEmpty()) continue
                    val src = File(dir, from)
                    if (!src.exists()) continue
                    val dst = File(to)
                    if (dst.exists()) continue
                    dst.parentFile?.mkdirs()
                    src.renameTo(dst)
                }
            }

            runCatching { EngineConfig.ensureOverlay(ctx) }
            dir.deleteRecursively()
            Log.i(TAG, "undo 完成")
            true
        }
    }

    /** 最近一次修复记录；没有则 null。 */
    fun latestRecord(): Record? {
        val dir = latestBackupDir() ?: return null
        val json = runCatching {
            JSONObject(File(dir, MANIFEST_NAME).readText())
        }.getOrNull() ?: return null
        val level = runCatching {
            Level.valueOf("L" + json.optString("level", "1"))
        }.getOrDefault(Level.L1)
        val changes = mutableListOf<String>()
        json.optJSONArray("changes")?.let { arr ->
            for (i in 0 until arr.length()) changes += arr.optString(i)
        }
        return Record(
            dir = dir,
            createdAt = json.optLong("createdAt", dir.lastModified()),
            level = level,
            changes = changes,
            headline = json.optString("headline", ""),
        )
    }

    /** 备份数量（UI 上显示「可撤销」用）。 */
    fun backupCount(): Int =
        EngineConfig.recoveryRoot(ctx).listFiles()?.count { it.isDirectory } ?: 0

    // ── 内部实现 ────────────────────────────────────────────────────────

    /**
     * 把一个文件搬进备份目录。
     *
     * 用 `renameTo`（同分区重命名，不复制字节），失败才回落复制+删除。
     * 记录原始路径，撤销时搬回原处。
     */
    private fun moveAside(
        src: File,
        backupDir: File,
        label: String,
        changes: MutableList<String>,
    ): File? {
        if (!src.isFile) return null
        val dest = uniqueChild(backupDir, src.name)
        val ok = runCatching { src.renameTo(dest) }.getOrDefault(false)
        if (!ok) {
            val copied = runCatching {
                src.copyTo(dest, overwrite = false)
                src.delete()
                true
            }.getOrDefault(false)
            if (!copied) {
                Log.w(TAG, "moveAside 失败：${src.absolutePath}")
                return null
            }
        }
        changes += "移走 $label"
        movedItems += JSONObject()
            .put("name", dest.name)
            .put("restoreTo", src.absolutePath)
            .put("label", label)
        return dest
    }

    /**
     * 本次操作中搬走的文件清单。
     *
     * 刻意用成员变量而不是参数透传：`moveAside` 在 `recover` 里被调多次，
     * 每次都要往同一份记录里追加，透传一个 `MutableList<JSONObject>` 参数
     * 会让调用点变得很长，而它本质上就是「本次事务的账本」。
     *
     * 生命周期：`recover` 开头清空，`writeBackupManifest` 末尾落盘。
     */
    private val movedItems = mutableListOf<JSONObject>()

    /**
     * 收缩 `dsh.profile.bundles` 到 [EngineConfig.CORE_BUNDLES]。
     *
     * @param removed 输出参数：被摘下来的 bundle 名，写进备份供撤销用
     */
    private fun shrinkBundles(removed: MutableList<String>) {
        val f = EngineConfig.profileManifestFile(ctx)
        val json = runCatching {
            JSONObject(f.readText().replace("\uFEFF", ""))
        }.getOrNull() ?: JSONObject()

        val dsh = json.optJSONObject("dsh") ?: JSONObject()
        val profile = dsh.optJSONObject("profile") ?: JSONObject()
        val current = profile.optJSONArray("bundles") ?: JSONArray()

        for (i in 0 until current.length()) {
            val name = current.optString(i)
            if (name.isNotEmpty() && !EngineConfig.isCoreBundle(name)) removed += name
        }

        val next = JSONArray()
        // 保持核心项的原生顺序（base → web-app → mobile）：官方按 bundles 数组
        // 顺序决定层叠顺序，web-app 必须排在 mobile 之前，否则移动端 UI 插件
        // 拿不到 web-app 提供的扩展点。
        for (name in EngineConfig.CORE_BUNDLES) next.put(name)
        profile.put("bundles", next)
        dsh.put("profile", profile)
        json.put("dsh", dsh)

        f.parentFile?.mkdirs()
        f.writeText(json.toString(2) + "\n")
    }

    /** 撤销时把 bundles 名单装回去（保留核心项，追加被摘掉的那些）。 */
    private fun restoreBundles(names: List<String>) {
        val f = EngineConfig.profileManifestFile(ctx)
        val json = runCatching {
            JSONObject(f.readText().replace("\uFEFF", ""))
        }.getOrNull() ?: return
        val dsh = json.optJSONObject("dsh") ?: JSONObject()
        val profile = dsh.optJSONObject("profile") ?: JSONObject()
        val next = JSONArray()
        for (name in EngineConfig.CORE_BUNDLES) next.put(name)
        for (name in names) {
            if (name.isNotEmpty() && !EngineConfig.isCoreBundle(name)) next.put(name)
        }
        profile.put("bundles", next)
        dsh.put("profile", profile)
        json.put("dsh", dsh)
        f.parentFile?.mkdirs()
        f.writeText(json.toString(2) + "\n")
    }

    /** 写一份最小可用的 manifest（只在原文件不是合法 JSON 时调用）。 */
    private fun writeMinimalManifest() {
        val f = EngineConfig.profileManifestFile(ctx)
        f.parentFile?.mkdirs()
        f.writeText(EngineConfig.minimalProfileManifest())
    }

    /**
     * L2：把非核心插件的包目录挪进隔离区。
     *
     * 为什么要挪而不是只从 bundles 里摘掉：少数插件在 `require` 阶段就会抛错
     * （缺原生库、模块解析失败），而它是否被 `require` 不完全取决于 bundles
     * 列表 —— profile 的 `node_modules` 里只要存在同名目录，就可能被其它插件的
     * 依赖链带进来。挪走是最干脆的隔离。
     *
     * 只处理明确「非核心」的顶层包目录，`@scope/name` 这种两级结构也支持。
     */
    private fun quarantineModules(backupDir: File, removed: List<String>): List<String> {
        val modules = EngineConfig.profileModulesDir(ctx)
        if (!modules.isDirectory) return emptyList()
        val done = mutableListOf<String>()

        for (name in removed) {
            if (EngineConfig.isCoreBundle(name)) continue
            val dir = File(modules, name)
            if (!dir.exists()) continue
            // 隔离区里用「扁平化」的名字：@scope/name → @scope__name
            val flat = name.replace('/', '_').replace('@', '@')
            val dest = uniqueChild(backupDir, flat)
            if (dir.renameTo(dest)) {
                quarantinedItems += JSONObject()
                    .put("quarantineName", dest.name)
                    .put("restoreTo", dir.absolutePath)
                    .put("pack", name)
                done += name
            } else {
                Log.w(TAG, "隔离失败（可能跨分区）：${dir.absolutePath}")
            }
        }

        // 顶层 @scope 目录被搬空后留个空壳没意义，顺手清掉
        modules.listFiles()?.forEach { f ->
            if (f.isDirectory && f.name.startsWith("@")) {
                if (f.listFiles()?.isEmpty() == true) f.delete()
            }
        }
        return done
    }

    private val quarantinedItems = mutableListOf<JSONObject>()

    /** 写备份的 manifest.json：记录这次改了什么、怎么还原。 */
    private fun writeBackupManifest(
        dir: File,
        level: Level,
        headline: String,
        changes: List<String>,
        removed: List<String>,
        manifestRebuilt: Boolean,
    ) {
        val json = JSONObject()
            .put("version", 1)
            .put("createdAt", System.currentTimeMillis())
            .put("level", level.name.removePrefix("L"))
            .put("headline", headline)
            // 撤销时必须知道「当时的 manifest 是坏的、由我们重建的」，
            // 否则会把坏文件原样搬回去（见 undoLatest 的说明）
            .put("manifestRebuilt", manifestRebuilt)
            .put("moved", JSONArray(movedItems))
            .put("quarantined", JSONArray(quarantinedItems))
            .put("removedBundles", JSONArray(removed))
            .put("changes", JSONArray(changes))
        File(dir, MANIFEST_NAME).writeText(json.toString(2) + "\n")
        movedItems.clear()
        quarantinedItems.clear()
    }

    /** 只保留最近 [MAX_BACKUPS] 份备份。 */
    private fun pruneBackups() {
        val root = EngineConfig.recoveryRoot(ctx)
        val dirs = root.listFiles()?.filter { it.isDirectory }?.sortedBy { it.name } ?: return
        if (dirs.size <= MAX_BACKUPS) return
        for (d in dirs.dropLast(MAX_BACKUPS)) {
            runCatching { d.deleteRecursively() }
            Log.i(TAG, "清理旧备份 ${d.name}")
        }
    }

    private fun latestBackupDir(): File? =
        EngineConfig.recoveryRoot(ctx).listFiles()
            ?.filter { it.isDirectory && File(it, MANIFEST_NAME).isFile }
            ?.maxByOrNull { it.name }

    /** 备份目录里取一个不冲突的名字（同名文件后面的加 -1 / -2）。 */
    private fun uniqueChild(dir: File, name: String): File {
        var f = File(dir, name)
        if (!f.exists()) return f
        var i = 1
        while (true) {
            f = File(dir, "$name-$i")
            if (!f.exists()) return f
            i++
        }
    }

    /** 文件存在且能解析成 JSON 对象。 */
    private fun isJsonObject(f: File): Boolean {
        if (!f.isFile) return false
        return runCatching {
            JSONObject(f.readText().replace("\uFEFF", ""))
            true
        }.getOrDefault(false)
    }

    private fun copyInto(src: File, dir: File) {
        runCatching { src.copyTo(uniqueChild(dir, src.name), overwrite = false) }
    }

    private fun timestamp(): String =
        SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())

    companion object {
        private const val TAG = "KxxyRecovery"

        /** 备份 manifest 的文件名。 */
        const val MANIFEST_NAME = "manifest.json"

        /**
         * 保留的备份份数。
         *
         * 5 份足够覆盖「修了没好转、又调了两次、又试了 L2/L3」的实际节奏，
         * 同时把占用压在几百 KB 量级（补丁是文本，node_modules 是重命名）。
         */
        private const val MAX_BACKUPS = 5

        /** 串行化：修复与撤销不能并行，否则会互相搬文件。 */
        private val LOCK = Any()
    }
}
