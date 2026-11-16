package app.kxxy.engine

import android.content.Context
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/** 只救援两份用户数据及其父目录；不扫描 home，不读取凭据，也不隐式申请 Root。 */
object UserDataPermissions {
    data class Outcome(val success: Boolean, val changes: List<String>, val detail: String, val needsRoot: Boolean = false)

    private val lock = Mutex()
    private const val PRIVATE_DIR = 448 // 0700
    private const val PRIVATE_FILE = 384 // 0600
    private data class Target(val file: File, val name: String, val directory: Boolean) {
        val mode get() = if (directory) PRIVATE_DIR else PRIVATE_FILE
    }
    private data class Meta(val dev: Long, val inode: Long, val uid: Int, val gid: Int, val mode: Int, val links: Long, val context: String) {
        fun identity(other: Meta) = dev == other.dev && inode == other.inode && (mode and OsConstants.S_IFMT) == (other.mode and OsConstants.S_IFMT)
        fun text() = "dev=$dev inode=$inode owner=$uid:$gid mode=${Integer.toOctalString(mode)} nlink=$links context=$context"
    }
    private class Refused(val reason: String, val root: Boolean = false) : Exception(reason)
    private data class Scope(val targets: List<Target>)

    /** 元数据报告不启动 su；遇到不可搜索的父目录，子项报告 EACCES 而非猜测不存在。 */
    fun report(ctx: Context): String = try {
        val scope = scope(ctx)
        scope.targets.joinToString("\n") { target ->
            try {
                checkParents(scope, target)
                val meta = metadata(target)
                validate(target, meta)
                "${target.name}: ${meta.text()} access=${access(target)}"
            } catch (e: Exception) { "${target.name}: ${reason(e)}" }
        }
    } catch (e: Exception) { reason(e) }

    /** UI/启动前只做普通 uid 的检查。已授权的 su 也不是本次修复的用户许可。 */
    fun issue(ctx: Context): String? = try {
        val scope = scope(ctx)
        scope.targets.firstNotNullOfOrNull { target ->
            try {
                checkParents(scope, target)
                validate(target, metadata(target))
                if (!access(target)) "${target.name}: 普通应用 uid 无法${if (target.directory) "读写/搜索目录" else "读写文件"}（EACCES；可能是属主、权限或 SELinux）" else null
            } catch (e: Exception) {
                if (e is ErrnoException && e.errno == OsConstants.ENOENT) null else "${target.name}: ${reason(e)}"
            }
        }
    } catch (e: Exception) { if (e is ErrnoException && e.errno == OsConstants.ENOENT) null else reason(e) }

    suspend fun repair(ctx: Context, allowRoot: Boolean = false): Outcome = withContext(Dispatchers.IO) {
        lock.withLock {
            val changes = mutableListOf<String>()
            var journal: FileOutputStream? = null
            try {
                val scope = scope(ctx)
                val files = scope.targets.first()
                val filesMeta = metadata(files)
                validate(files, filesMeta)
                if (filesMeta.uid != android.os.Process.myUid() || (filesMeta.mode and 2) != 0 ||
                    ((filesMeta.mode and 16) != 0 && filesMeta.gid != Os.getgid()) || !access(files)) {
                    throw Refused("files 父目录不能安全保存私密元数据日志；停止修复，不放宽其他 uid 的目录权限", true)
                }
                journal = newJournal(files.file)
                record(journal, "planned uid=${android.os.Process.myUid()} gid=${Os.getgid()} root=$allowRoot")
                val before = linkedMapOf<Target, Meta>()
                var blocked = false
                for (target in scope.targets) {
                    try {
                        checkParents(scope, target, before)
                        val meta = metadata(target)
                        validate(target, meta)
                        before[target] = meta
                        record(journal, "before ${target.name} ${meta.text()}")
                        // 属主正确但父目录 000 时，先日志记录再只修本目录，子目标之后才可 lstat。
                        if (target.directory && meta.uid == android.os.Process.myUid() && (meta.mode and 4095) != target.mode) {
                            normalMode(scope, target, meta, before)
                            changes += "${target.name}: chmod ${Integer.toOctalString(target.mode)}"
                            record(journal, "after ${target.name} ${metadata(target).text()}")
                        }
                    } catch (e: ErrnoException) {
                        if (e.errno == OsConstants.EACCES || e.errno == OsConstants.EPERM) blocked = true else throw e
                    }
                }
                val foreign = before.values.any { it.uid != android.os.Process.myUid() }
                if ((blocked || foreign) && !allowRoot) {
                    return@withLock Outcome(false, changes.toList(), "固定目标或父目录由非应用 uid 持有/不可搜索；未执行 su。需要用户再次明确确认 Root 修复。\n${report(ctx)}", true)
                }
                // 父目录不通时，只有明确允许的 Root 元数据探针能区分 ENOENT 与 EACCES。
                val root = if (allowRoot) Privilege.explicitRepairSuPrefix() else null
                if (allowRoot && root == null && (blocked || foreign)) throw Refused("Root 授权/探测失败；未更改非应用属主目标", true)
                if (blocked) {
                    val result = rootMetadata(scope, root ?: throw Refused("Root 不可用", true))
                    before.clear(); before.putAll(result)
                }
                if (before.size != scope.targets.size) throw Refused("固定目标元数据不完整；未修复")
                before.forEach { (target, meta) -> validate(target, meta) }
                record(journal, before.entries.joinToString("\n") { "confirmed-before ${it.key.name} ${it.value.text()}" })
                for ((target, meta) in before) {
                    if (meta.uid == android.os.Process.myUid()) {
                        normalMode(scope, target, meta, before)
                        if ((meta.mode and 4095) != target.mode && !changes.any { it.startsWith("${target.name}:") }) {
                            changes += "${target.name}: chmod ${Integer.toOctalString(target.mode)}"
                            record(journal, "after ${target.name} ${metadata(target).text()}")
                        }
                    } else {
                        val prefix = root ?: throw Refused("非应用属主需要显式 Root 修复", true)
                        record(journal, "intent ${target.name}: chown/chmod")
                        val result = rootChange(scope, target, before, prefix, restore = false)
                        if (!result.ok) throw Refused("${target.name}: Root 修复失败（${rootFailure(result)}）；可能有部分元数据更改，请查看本地日志", true)
                        changes += "${target.name}: chown ${android.os.Process.myUid()}:${Os.getgid()} + chmod ${Integer.toOctalString(target.mode)}"
                        record(journal, "root-after ${target.name} ${result.text.trim()}")
                        if (target.directory && !access(target)) {
                            record(journal, "intent ${target.name}: restorecon parent before child")
                            val relabel = rootChange(scope, target, before, prefix, restore = true)
                            if (!relabel.ok || !access(target)) throw Refused("${target.name}: Root 恢复后普通 uid 仍不能搜索父目录（SELinux/权限）", true)
                            changes += "${target.name}: restorecon（非递归）"
                            record(journal, "root-after ${target.name} ${relabel.text.trim()}")
                        }
                    }
                }
                // chown/chmod 不能修复 SELinux 标签。只在普通 uid 仍失败且本次已明确允许 Root 时尝试非递归 restorecon。
                for (target in scope.targets) {
                    checkParents(scope, target)
                    val meta = metadata(target)
                    if (!meta.identity(before.getValue(target))) throw Refused("${target.name}: inode 已更换，停止修复")
                    if (!access(target) && root != null) {
                        record(journal, "intent ${target.name}: restorecon")
                        val result = rootChange(scope, target, before, root, restore = true)
                        if (!result.ok) throw Refused("${target.name}: restorecon 失败（${rootFailure(result)}）", true)
                        changes += "${target.name}: restorecon（非递归）"
                        record(journal, "root-after ${target.name} ${result.text.trim()}")
                    }
                }
                val after = scope.targets.map { target ->
                    checkParents(scope, target)
                    val meta = metadata(target)
                    validate(target, meta)
                    if (!meta.identity(before.getValue(target))) throw Refused("${target.name}: inode 已更换，停止修复")
                    if (meta.uid != android.os.Process.myUid() || (meta.mode and 4095) != target.mode || !access(target)) {
                        throw Refused("${target.name}: 普通应用 uid 最终读写/搜索验证失败（属主/权限/SELinux）；未读取文件内容", true)
                    }
                    "after ${target.name} ${meta.text()}"
                }
                record(journal, after.joinToString("\n") + "\ncompleted")
                Outcome(true, changes.toList(), "固定目标权限验证通过（普通 uid access R/W，目录另验 X）；内容未读取、未改写。\n" + after.joinToString("\n"))
            } catch (e: CancellationException) {
                journal?.let { runCatching { record(it, "cancelled; recheck metadata before retry") } }
                throw e
            } catch (e: Exception) {
                val detail = reason(e)
                journal?.let { runCatching { record(it, "failed $detail\n${report(ctx)}") } }
                Outcome(false, changes.toList(), detail, (e as? Refused)?.root == true || (e as? ErrnoException)?.errno in listOf(OsConstants.EACCES, OsConstants.EPERM))
            } finally { journal?.close() }
        }
    }

    private fun scope(ctx: Context): Scope {
        val raw = ctx.filesDir.absoluteFile
        // Context 的系统路径别名（例如 /data/data）可接受；files 本身或用户可控祖先链接不能接受。
        var ancestor: File? = raw
        while (ancestor != null) {
            val stat = Os.lstat(ancestor.absolutePath)
            if (OsConstants.S_ISLNK(stat.st_mode) && (ancestor == raw || stat.st_uid != 0)) {
                throw Refused("拒绝用户可控符号链接父目录")
            }
            ancestor = ancestor.parentFile
        }
        val files = raw.canonicalFile
        val home = File(files, "kxxy-home")
        return Scope(listOf(Target(files, "files", true), Target(home, "kxxy-home", true),
            Target(File(home, "storages"), "kxxy-home/storages", true),
            Target(File(home, ".credentials.yaml"), "kxxy-home/.credentials.yaml", false),
            Target(File(home, "storages/workspace.json"), "kxxy-home/storages/workspace.json", false)))
    }

    private fun metadata(target: Target): Meta {
        val stat = Os.lstat(target.file.absolutePath)
        val context = if (OsConstants.S_ISLNK(stat.st_mode)) "link-refused" else try {
            String(Os.getxattr(target.file.absolutePath, "security.selinux"), Charsets.UTF_8).trimEnd('\u0000').take(200)
                .replace(Regex("[^A-Za-z0-9_:.,?/-]"), "?")
        } catch (_: ErrnoException) { "unavailable" }
        // getxattr/access 不应使用一次旧的 lstat 结果信任之后被更换的 inode。
        val again = Os.lstat(target.file.absolutePath)
        if (stat.st_dev != again.st_dev || stat.st_ino != again.st_ino || stat.st_mode != again.st_mode) throw Refused("${target.name}: 元数据检查期间发生替换")
        return statMeta(stat, context)
    }
    private fun statMeta(stat: StructStat, context: String) = Meta(stat.st_dev, stat.st_ino, stat.st_uid, stat.st_gid, stat.st_mode, stat.st_nlink, context)
    private fun validate(target: Target, meta: Meta) {
        if (OsConstants.S_ISLNK(meta.mode)) throw Refused("${target.name}: 拒绝符号链接")
        if (if (target.directory) !OsConstants.S_ISDIR(meta.mode) else !OsConstants.S_ISREG(meta.mode)) throw Refused("${target.name}: 非预期文件类型")
        if (!target.directory && meta.links != 1L) throw Refused("${target.name}: 拒绝多硬链接文件")
    }
    private fun checkParents(scope: Scope, target: Target, expected: Map<Target, Meta>? = null) {
        for (parent in scope.targets.filter { it.directory && it != target && target.file.toPath().startsWith(it.file.toPath()) }) {
            val stat = Os.lstat(parent.file.absolutePath)
            if (!OsConstants.S_ISDIR(stat.st_mode)) throw Refused("${parent.name}: 父目录类型不安全/符号链接")
            if (expected?.get(parent)?.identity(statMeta(stat, "")) == false) throw Refused("${parent.name}: 父目录 inode 已更换")
        }
    }
    private fun access(target: Target): Boolean = try {
        Os.access(target.file.absolutePath, OsConstants.R_OK or OsConstants.W_OK or if (target.directory) OsConstants.X_OK else 0)
    } catch (_: ErrnoException) { false }

    private fun normalMode(scope: Scope, target: Target, expected: Meta, parents: Map<Target, Meta>) {
        checkParents(scope, target, parents)
        val actual = metadata(target)
        validate(target, actual)
        if (!expected.identity(actual)) throw Refused("${target.name}: inode 已更换")
        if (actual.uid != android.os.Process.myUid()) throw Refused("${target.name}: 属主已更换，需要显式 Root", true)
        if ((actual.mode and 4095) == target.mode) return
        // mode 000 时 O_RDONLY 根本无法打开；owner 的 chmod 不依赖文件 R 权限，不碰内容。
        // Android 公共 Os 没有 fchmodat(AT_SYMLINK_NOFOLLOW)，因此固定父链/目标紧邻重验并在调用后再验。
        checkParents(scope, target, parents)
        val last = Os.lstat(target.file.absolutePath)
        if (!expected.identity(statMeta(last, "")) || last.st_uid != android.os.Process.myUid() || OsConstants.S_ISLNK(last.st_mode)) throw Refused("${target.name}: 操作前发生替换")
        Os.chmod(target.file.absolutePath, target.mode)
        checkParents(scope, target, parents)
        if (!expected.identity(metadata(target))) throw Refused("${target.name}: 操作期间发生替换")
    }

    internal fun newJournal(files: File): FileOutputStream {
        val fd = Os.open(File(files, "user-data-permissions-${UUID.randomUUID()}.journal").absolutePath,
            OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW, PRIVATE_FILE)
        return try {
            val stat = Os.fstat(fd)
            if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_uid != android.os.Process.myUid() || stat.st_nlink != 1L || (stat.st_mode and 63) != 0) throw Refused("元数据日志不安全")
            FileOutputStream(fd)
        } catch (e: Exception) { Os.close(fd); throw e }
    }
    internal fun record(stream: FileOutputStream, text: String) { stream.write((text + "\n").toByteArray(Charsets.UTF_8)); stream.flush(); stream.fd.sync() }
    private fun reason(e: Exception): String = when (e) {
        is Refused -> e.reason
        is ErrnoException -> when (e.errno) {
            OsConstants.ENOENT -> "ENOENT：固定目标已不存在；不会创建文件，也不会将空操作标为成功"
            OsConstants.EACCES, OsConstants.EPERM -> "EACCES/EPERM：普通应用 uid 不可访问目标或搜索父目录"
            else -> "元数据系统调用失败 errno=${e.errno}"
        }
        else -> "权限救援失败（${e.javaClass.simpleName}）；内容未读取/未改写"
    }

    private fun shellStart(scope: Scope): String = buildString {
        append("export PATH=/system/bin:/system/xbin; cd / || exit 80; [ \"$(/system/bin/id -u)\" = 0 ] || exit 81; ")
        // 系统别名已在普通路径层验证；canonical files 之上的路径也拒绝链接。
        val ancestors = generateSequence(scope.targets.first().file) { it.parentFile }.toList().asReversed()
        ancestors.forEach { append("[ ! -L ${Privilege.shellQuote(it.absolutePath)} ] || exit 82; ") }
    }
    private fun rootGuard(scope: Scope, target: Target, expected: Map<Target, Meta>?): String = buildString {
        for (item in scope.targets.filter { it == target || (it.directory && target.file.toPath().startsWith(it.file.toPath())) }) {
            val p = Privilege.shellQuote(item.file.absolutePath)
            append("[ ! -L $p ] || exit 82; [ -e $p ] || exit 83; [ ${if (item.directory) "-d" else "-f"} $p ] || exit 84; ")
            expected?.get(item)?.let { append("[ \"$(/system/bin/stat -c '%d:%i' $p)\" = '${it.dev}:${it.inode}' ] || exit 85; ") }
        }
    }
    private fun rootPrint(target: Target, index: Int): String {
        val p = Privilege.shellQuote(target.file.absolutePath)
        return "s=$(/system/bin/stat -c '%d:%i:%u:%g:%f:%h' $p) || exit 86; c=$(/system/bin/ls -Zd $p 2>/dev/null); c=\${c%% *}; printf 'META|$index|%s|%s\\n' \"\$s\" \"\$c\"; "
    }
    private suspend fun rootMetadata(scope: Scope, prefix: List<String>): Map<Target, Meta> {
        val script = shellStart(scope) + scope.targets.mapIndexed { i, t -> rootGuard(scope, t, null) + rootPrint(t, i) }.joinToString("")
        val result = Privilege.runExplicitRepairSu(prefix, script)
        if (!result.ok || result.truncated) throw Refused("Root 元数据检查失败（${rootFailure(result)}）；未修复", result.exitCode !in listOf(82, 83, 84, 85))
        val parsed = linkedMapOf<Target, Meta>()
        for (line in result.text.lineSequence().filter { it.startsWith("META|") }) {
            val parts = line.split('|')
            if (parts.size != 4) throw Refused("Root 元数据协议无效")
            val target = scope.targets.getOrNull(parts[1].toIntOrNull() ?: -1) ?: throw Refused("Root 元数据目标无效")
            val v = parts[2].split(':')
            if (v.size != 6 || parsed.containsKey(target)) throw Refused("Root 元数据记录无效")
            val meta = Meta(v[0].toLong(), v[1].toLong(), v[2].toInt(), v[3].toInt(), v[4].toInt(16), v[5].toLong(), parts[3].take(200).replace(Regex("[^A-Za-z0-9_:.,?/-]"), "?"))
            validate(target, meta); parsed[target] = meta
        }
        if (parsed.size != scope.targets.size) throw Refused("Root 元数据不完整")
        return parsed
    }
    private suspend fun rootChange(scope: Scope, target: Target, expected: Map<Target, Meta>, prefix: List<String>, restore: Boolean): RecoveryProcessRunner.Output {
        val p = Privilege.shellQuote(target.file.absolutePath)
        val meta = expected.getValue(target)
        // shell 无 O_NOFOLLOW：先拒绝链接，再打开只用于元数据的 fd，并比对 inode；chmod/chown 钉在 fd 上，不读取字节。
        val guard = rootGuard(scope, target, expected)
        val script = shellStart(scope) + guard + "exec 9<$p || exit 87; " + guard +
            "[ \"$(/system/bin/stat -L -c '%d:%i:%h' /proc/\$\$/fd/9)\" = '${meta.dev}:${meta.inode}:${meta.links}' ] || exit 85; " +
            if (restore) {
                "$guard/system/bin/restorecon $p >/dev/null 2>&1 || exit 88; " + guard + rootPrint(target, scope.targets.indexOf(target))
            } else {
                "/system/bin/chown ${android.os.Process.myUid()}:${Os.getgid()} /proc/\$\$/fd/9 || exit 89; " +
                    "/system/bin/chmod ${Integer.toOctalString(target.mode)} /proc/\$\$/fd/9 || exit 90; " + guard + rootPrint(target, scope.targets.indexOf(target))
            }
        return Privilege.runExplicitRepairSu(prefix, script)
    }
    private fun rootFailure(result: RecoveryProcessRunner.Output): String = when (result.exitCode) {
        82 -> "拒绝符号链接"
        83 -> "ENOENT：固定目标已不存在，不会创建"
        84 -> "非预期文件类型"
        85 -> "inode/父目录已更换"
        else -> "status=${result.status} exit=${result.exitCode ?: "none"}"
    }
}
