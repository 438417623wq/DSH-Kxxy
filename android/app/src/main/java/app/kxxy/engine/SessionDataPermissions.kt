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
import java.io.FileInputStream
import java.io.FileOutputStream

/** Explicit, metadata-only rescue of ONE log-identified private session, never all home/sessions. */
object SessionDataPermissions {
    private const val LOG_BYTES = 64 * 1024
    private const val NODE_LIMIT = 256
    private const val TIME_MS = 8_000L
    private const val DEPTH_LIMIT = 24
    private val lock = Mutex()
    private class Refused(val why: String, val root: Boolean = false) : Exception(why)
    private data class Meta(val dev: Long, val ino: Long, val uid: Int, val gid: Int, val mode: Int, val links: Long) {
        fun identity(m: Meta) = dev == m.dev && ino == m.ino && (mode and OsConstants.S_IFMT) == (m.mode and OsConstants.S_IFMT)
        fun text() = "inode=$dev:$ino owner=$uid:$gid mode=${Integer.toOctalString(mode)} nlink=$links"
    }
    private data class Scope(val files: File, val session: File, val ancestors: List<File>, val source: String)
    private class Budget(private val limitMs: Long = TIME_MS) {
        private var start = System.nanoTime()
        var nodes = 0
        fun check() { if ((System.nanoTime() - start) / 1_000_000 >= limitMs) throw Refused("session scope TIME_LIMIT；停止，可能已有部分元数据更改") }
        fun node() { check(); if (++nodes > NODE_LIMIT) throw Refused("session scope NODE_LIMIT=$NODE_LIMIT；停止，可能已有部分元数据更改") }
        fun remaining(): Long { check(); return (limitMs - (System.nanoTime() - start) / 1_000_000).coerceAtLeast(1) }
        fun excludeAuthorization(elapsed: Long) { start += elapsed }
    }
    private fun meta(s: StructStat) = Meta(s.st_dev, s.st_ino, s.st_uid, s.st_gid, s.st_mode, s.st_nlink)
    private fun metadata(f: File): Meta = meta(Os.lstat(f.absolutePath))
    private fun validate(f: File, m: Meta, directory: Boolean? = null) {
        if (OsConstants.S_ISLNK(m.mode)) throw Refused("${f.absolutePath}: unsupported 符号链接（sessions 可能连接公开 storage）；不跟随/不递归")
        if (!OsConstants.S_ISDIR(m.mode) && !OsConstants.S_ISREG(m.mode)) throw Refused("${f.absolutePath}: unsupported 特殊文件类型")
        if (directory == true && !OsConstants.S_ISDIR(m.mode)) throw Refused("${f.absolutePath}: 预期目录")
        if (OsConstants.S_ISREG(m.mode) && m.links != 1L) throw Refused("${f.absolutePath}: unsupported 多硬链接文件")
    }
    private fun access(f: File, m: Meta): Boolean = try {
        Os.access(f.absolutePath, OsConstants.R_OK or OsConstants.W_OK or if (OsConstants.S_ISDIR(m.mode)) OsConstants.X_OK else 0)
    } catch (_: ErrnoException) { false }
    // Keep existing ordinary permissions, including executable attachments; never grant group/other bits.
    // Special privilege bits are not preserved when restoring an app-owned private session.
    private fun desired(m: Meta) = (m.mode and 511) or if (OsConstants.S_ISDIR(m.mode)) 448 else 384
    private fun fault(f: File, m: Meta): String? = when {
        m.uid != android.os.Process.myUid() -> "${f.absolutePath}: 非应用属主 ${m.uid}:${m.gid}，需要显式 Root"
        (m.mode and 4095) != desired(m) -> "${f.absolutePath}: owner 缺少 rw${if (OsConstants.S_ISDIR(m.mode)) "X" else ""} 或含特殊权限位"
        !access(f, m) -> "${f.absolutePath}: 当前普通 uid EACCES（权限/SELinux）"
        else -> null
    }

    fun issue(ctx: Context): String? = try {
        val scope = scope(ctx)
        if (scope == null) null else inspect(scope, Budget()).firstOrNull()
    } catch (e: Exception) { if (missing(e)) null else reason(e) }

    fun report(ctx: Context): String = try {
        val scope = scope(ctx)
        if (scope == null) "session scope: 当前有界日志无明确 EACCES/scandir 私有 session 绝对路径；未扫描 sessions"
        else {
            val issues = inspect(scope, Budget())
            "session scope: ${scope.session.absolutePath}\nsource=${scope.source}; ancestors + only this subtree; limit=$NODE_LIMIT nodes/${TIME_MS}ms; metadata only\n" +
                if (issues.isEmpty()) "当前元数据/access 正常；旧日志不再作为故障" else issues.take(6).joinToString("\n") + if (issues.size > 6) "\n更多 scope issues=${issues.size - 6}" else ""
        }
    } catch (e: Exception) { "session scope: ${reason(e)}" }

    suspend fun repair(ctx: Context, allowRoot: Boolean = false): UserDataPermissions.Outcome = withContext(Dispatchers.IO) {
        lock.withLock {
            val changes = mutableListOf<String>()
            var journal: FileOutputStream? = null
            try {
                val scope = scope(ctx) ?: return@withLock UserDataPermissions.Outcome(true, emptyList(), "当前日志无 session 权限故障 scope；未操作/未扫描 sessions")
                val budget = Budget(if (allowRoot) 60_000L else TIME_MS)
                val expected = linkedMapOf<File, Meta>()
                var prefix: List<String>? = null
                fun record(text: String) {
                    if (journal == null) {
                        val m = checked(scope, scope.files, expected)
                        if (m.uid != android.os.Process.myUid() || (m.mode and 2) != 0 ||
                            ((m.mode and 16) != 0 && m.gid != Os.getgid()) || !access(scope.files, m)) {
                            throw Refused("files 不能安全保存私密元数据日志；停止，不放宽其他 uid 权限", true)
                        }
                        journal = UserDataPermissions.newJournal(scope.files)
                        UserDataPermissions.record(journal!!, "session planned scope=${scope.session.absolutePath} uid=${android.os.Process.myUid()} gid=${Os.getgid()} root=$allowRoot limit=$NODE_LIMIT")
                    }
                    UserDataPermissions.record(journal!!, text)
                }
                suspend fun root(): List<String> {
                    if (!allowRoot) throw Refused("需要用户明确确认 Root；allowRoot=false 未探测/执行 su", true)
                    if (prefix == null) {
                        val authStart = System.nanoTime()
                        try { prefix = Privilege.explicitRepairSuPrefix() ?: throw Refused("显式 Root 授权失败/不可用；未读取 session 正文", true) }
                        finally { budget.excludeAuthorization(System.nanoTime() - authStart) }
                    }
                    budget.check()
                    return prefix!!
                }
                suspend fun read(f: File, directory: Boolean? = null): Meta {
                    budget.node()
                    val m = try { checked(scope, f, expected) } catch (e: ErrnoException) {
                        if (!denied(e)) throw e
                        rootMeta(scope, f, expected, root(), budget)
                    }
                    validate(f, m, directory)
                    expected[f] = m
                    return m
                }
                suspend fun change(f: File, before: Meta) {
                    budget.check()
                    if (before.uid == android.os.Process.myUid()) {
                        try {
                            val now = checked(scope, f, expected)
                            validate(f, now)
                            if (now.uid != before.uid || now.gid != before.gid || now.mode != before.mode || now.links != before.links) throw Refused("${f.absolutePath}: 元数据已变更，停止")
                            if ((now.mode and 4095) != desired(now)) {
                                record("before ${f.absolutePath} ${now.text()} intent=owner-rw(X) chmod=${Integer.toOctalString(desired(now))}")
                                checked(scope, f, expected)
                                Os.chmod(f.absolutePath, desired(now))
                                changes += "${f.absolutePath}: owner rw(X dir), preserve exec; chmod ${Integer.toOctalString(desired(now))}"
                                checked(scope, f, expected)
                            }
                        } catch (e: ErrnoException) {
                            if (!denied(e)) throw e
                            val authorized = root()
                            record("before ${f.absolutePath} ${before.text()} intent=explicit-root-chown-chmod")
                            rootChange(scope, f, before, expected, authorized, budget, false)
                            changes += "${f.absolutePath}: 显式 Root metadata chown/chmod"
                        }
                    } else {
                        val authorized = root()
                        record("before ${f.absolutePath} ${before.text()} intent=explicit-root-chown-chmod")
                        rootChange(scope, f, before, expected, authorized, budget, false)
                        changes += "${f.absolutePath}: 显式 Root metadata chown/chmod"
                    }
                    var after = checked(scope, f, expected)
                    if (!access(f, after)) {
                        val authorized = root()
                        record("before ${f.absolutePath} ${after.text()} intent=restorecon-nonrecursive")
                        rootChange(scope, f, after, expected, authorized, budget, true)
                        changes += "${f.absolutePath}: restorecon（非递归）"
                        after = checked(scope, f, expected)
                    }
                    if (after.uid != android.os.Process.myUid() || (after.mode and 4095) != desired(before) || !access(f, after)) throw Refused("${f.absolutePath}: 普通 uid 最终 owner/rw(X)/SELinux 验证失败", true)
                    journal?.let { UserDataPermissions.record(it, "after ${f.absolutePath} ${after.text()}") }
                }
                // Parent first: owner 000 can be repaired without opening any content. Root-only inaccessible
                // children are lstat/enumerated in exactly this scope, after the fixed parent chain is pinned.
                for (f in scope.ancestors) { val m = read(f, true); change(f, m) }
                val pending = ArrayDeque<Pair<File, Int>>()
                pending.add(scope.session to 0)
                while (pending.isNotEmpty()) {
                    val (f, depth) = pending.removeLast()
                    if (depth > DEPTH_LIMIT) throw Refused("session scope DEPTH_LIMIT=$DEPTH_LIMIT")
                    val m = read(f, if (f == scope.session) true else null)
                    change(f, m)
                    if (OsConstants.S_ISDIR(m.mode)) {
                        val children = try { children(scope, f, expected, budget) } catch (e: Exception) {
                            if (!denied(e)) throw e
                            rootChildren(scope, f, expected, root(), budget)
                        }
                        children.forEach { pending.add(it to depth + 1) }
                    }
                }
                // Revalidate the entire visited scope and identities, not the stale log or su exit code alone.
                for ((f, before) in expected) {
                    budget.check()
                    val m = checked(scope, f, expected)
                    validate(f, m)
                    if (m.uid != android.os.Process.myUid() || (m.mode and 4095) != desired(before) || !access(f, m)) throw Refused("${f.absolutePath}: scope 复验失败", true)
                }
                journal?.let { UserDataPermissions.record(it, "session completed nodes=${expected.size}") }
                UserDataPermissions.Outcome(true, changes.toList(), "session scope 已验证 ${expected.size} 个节点：${scope.session.absolutePath}；仅元数据，正文未读/未改，未删除/隔离，保留现有 exec。")
            } catch (e: CancellationException) {
                journal?.let { runCatching { UserDataPermissions.record(it, "session cancelled; recheck metadata before retry") } }
                throw e
            } catch (e: Exception) {
                journal?.let { runCatching { UserDataPermissions.record(it, "session failed ${reason(e)} changes=${changes.size}") } }
                UserDataPermissions.Outcome(false, changes.toList(), reason(e), (e as? Refused)?.root == true || denied(e))
            } finally { journal?.close() }
        }
    }

    private fun files(ctx: Context): File {
        val raw = ctx.filesDir.absoluteFile
        var f: File? = raw
        while (f != null) {
            val m = metadata(f)
            if (OsConstants.S_ISLNK(m.mode) && (f == raw || m.uid != 0)) throw Refused("unsupported 用户可控 files 祖先符号链接")
            f = f.parentFile
        }
        return raw.toPath().toRealPath().toFile().also { validate(it, metadata(it), true) }
    }
    private fun scope(ctx: Context): Scope? {
        val files = files(ctx)
        val sessions = File(files, "kxxy-home/sessions")
        val engine = File(files, "engine")
        // No persistent round offset exists here. Prefer the latest fatal/boot segment in bounded engine
        // tail; a newer native failure can supersede it. Every candidate is then checked against NOW.
        val logs = listOf(File(engine, "engine.log"), File(engine, "native-boot-failure.json"))
        val texts = logs.mapNotNull { f ->
            try { safeLog(files, f)?.let { Triple(f, Os.lstat(f.absolutePath).st_mtime, it) } }
            catch (e: ErrnoException) { if (missing(e)) null else throw e }
        }.sortedByDescending { it.second }
        for ((log, _, raw) in texts) {
            val text = if (log.name.endsWith(".json")) raw.replace("\\/", "/").replace("\\n", "\n").replace("\\r", "\r") else raw
            // Preserve the whole round; a later connection error must not hide workspace scandir.
            // The trailing empty engine start is not yet a completed failure.
            val starts = Regex("(?m)^---- engine start [0-9]+ ----\\r?$").findAll(text).toList()
            val blocks = if (starts.isEmpty()) listOf(text) else starts.mapIndexed { i, m ->
                text.substring(m.range.last + 1, starts.getOrNull(i + 1)?.range?.first ?: text.length)
            }
            val current = blocks.asReversed().firstOrNull { it.contains(Regex("Error:|EACCES|failed|failure")) } ?: continue
            val matches = Regex("(?m)^[^\\r\\n]{0,400}EACCES[^\\r\\n']{0,160}\\bscandir\\s+'([^'\\r\\n]{1,1024})'[^\\r\\n]*$").findAll(current).toList()
            val path = matches.lastOrNull()?.groupValues?.get(1) ?: continue
            // Map only Context's validated system alias; never canonicalize below home/sessions.
            val aliases = listOf(sessions.absolutePath, File(ctx.filesDir.absoluteFile, "kxxy-home/sessions").absolutePath).distinct()
            val matchedRoot = aliases.firstOrNull { path.startsWith(it + File.separator) }
                ?: throw Refused("日志路径不在私有 home/sessions allowlist；拒绝操作")
            val suffix = path.removePrefix(matchedRoot + File.separator)
            // Upstream projectKey uses ~XXXX for Unicode and bounds the entire key at 255
            // ASCII bytes. Truncation may split an escape; keep the safe filename alphabet,
            // including legacy percent-encoded keys, without decoding or resolving it.
            val shape = Regex("[A-Za-z0-9_%+=@.~-]{1,255}" + Regex.escape(File.separator) + "session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
            if (!shape.matches(suffix) || suffix.substringBefore(File.separator) in listOf(".", "..") || path.indexOf('\u0000') >= 0) throw Refused("日志 session 路径不符合 encoded-workspace/session-uuid exact allowlist")
            val exact = File(path)
            if (!exact.isAbsolute || exact.absolutePath != path) throw Refused("日志 session 路径非 exact 绝对路径")
            val session = File(sessions, suffix)
            return Scope(files, session, listOf(files, File(files, "kxxy-home"), sessions, session.parentFile!!), log.name)
        }
        return null
    }
    private fun safeLog(files: File, log: File): String? {
        val parents = listOf(files, log.parentFile!!)
        val pinned = parents.associateWith { metadata(it).also { m -> validate(it, m, true) } }
        val before = metadata(log)
        validate(log, before, false)
        if (!OsConstants.S_ISREG(before.mode)) throw Refused("日志不是普通文件")
        fun check() {
            pinned.forEach { (f, m) -> val now = metadata(f); validate(f, now, true); if (!m.identity(now)) throw Refused("日志父 inode 已更换") }
            val now = metadata(log); validate(log, now, false); if (!before.identity(now)) throw Refused("日志 inode 已更换")
        }
        check()
        val fd = Os.open(log.absolutePath, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_NONBLOCK, 0)
        val stream = try { FileInputStream(fd) } catch (e: Exception) { Os.close(fd); throw e }
        try {
            val opened = Os.fstat(fd)
            if (!before.identity(meta(opened)) || !OsConstants.S_ISREG(opened.st_mode) || opened.st_nlink != 1L) throw Refused("日志 fd 类型/inode 不匹配")
            Os.lseek(fd, (opened.st_size - LOG_BYTES).coerceAtLeast(0), OsConstants.SEEK_SET)
            val bytes = ByteArray(LOG_BYTES)
            var count = 0
            while (count < bytes.size) { val n = stream.read(bytes, count, bytes.size - count); if (n <= 0) break; count += n }
            check()
            return String(bytes, 0, count, Charsets.UTF_8).let { if (opened.st_size > LOG_BYTES) it.substringAfter('\n', "") else it }
        } finally { stream.close() }
    }
    private fun chain(scope: Scope, f: File): List<File> {
        if (f !in scope.ancestors && !f.toPath().startsWith(scope.session.toPath())) throw Refused("scope escape")
        val result = mutableListOf<File>()
        var p: File? = f
        while (p != null) { result += p; p = p.parentFile }
        return result.asReversed()
    }
    private fun checked(scope: Scope, f: File, expected: Map<File, Meta>): Meta {
        val all = chain(scope, f)
        all.forEach { p ->
            val m = metadata(p)
            validate(p, m, if (p == f) null else true)
            if (expected[p]?.identity(m) == false) throw Refused("${p.absolutePath}: inode/父链已更换")
        }
        val m = metadata(f)
        validate(f, m)
        if (expected[f]?.identity(m) == false) throw Refused("${f.absolutePath}: inode 已更换")
        return m
    }
    private fun children(scope: Scope, f: File, expected: Map<File, Meta>, budget: Budget): List<File> {
        val before = checked(scope, f, expected)
        val found = mutableListOf<File>()
        // Streaming DirectoryStream, not File.listFiles(): the listing itself has a node/time bound.
        java.nio.file.Files.newDirectoryStream(f.toPath()).use { stream ->
            for (p in stream) {
                budget.check()
                if (found.size + budget.nodes >= NODE_LIMIT) throw Refused("session scope NODE_LIMIT=$NODE_LIMIT")
                val child = p.toFile()
                childName(child.name)
                if (child.parentFile != f) throw Refused("scope child escape")
                found += child
            }
        }
        if (!before.identity(checked(scope, f, expected))) throw Refused("枚举期间目录 inode 已更换")
        return found
    }
    private fun childName(name: String) {
        // Deliberately conservative: unsupported exotic names are refused, not interpreted by shell.
        if (!Regex("[A-Za-z0-9_. @%+=,-]{1,240}").matches(name) || name in listOf(".", "..")) throw Refused("unsupported session 子项名称；拒绝不安全转义/NUL")
    }
    private fun inspect(scope: Scope, budget: Budget): List<String> {
        val expected = linkedMapOf<File, Meta>()
        val issues = mutableListOf<String>()
        for (f in scope.ancestors) {
            budget.node()
            val m = checked(scope, f, expected)
            validate(f, m, true)
            expected[f] = m
            fault(f, m)?.let { issues += it }
        }
        val pending = ArrayDeque<Pair<File, Int>>()
        pending.add(scope.session to 0)
        while (pending.isNotEmpty()) {
            val (f, depth) = pending.removeLast()
            if (depth > DEPTH_LIMIT) throw Refused("session scope DEPTH_LIMIT=$DEPTH_LIMIT")
            budget.node()
            val m = checked(scope, f, expected)
            validate(f, m, if (f == scope.session) true else null)
            expected[f] = m
            fault(f, m)?.let { issues += it }
            if (OsConstants.S_ISDIR(m.mode)) children(scope, f, expected, budget).forEach { pending.add(it to depth + 1) }
        }
        return issues
    }
    private fun shellStart() = "export PATH=/system/bin:/system/xbin; cd / || exit 80; [ \"\$(/system/bin/id -u)\" = 0 ] || exit 81; "
    private fun guard(scope: Scope, f: File, expected: Map<File, Meta>): String = buildString {
        chain(scope, f).forEach { p ->
            val q = Privilege.shellQuote(p.absolutePath)
            append("[ ! -L $q ] || exit 82; [ -e $q ] || exit 83; ")
            append(if (p == f) "{ [ -d $q ] || [ -f $q ]; } || exit 84; " else "[ -d $q ] || exit 84; ")
            expected[p]?.let { append("[ \"\$(/system/bin/stat -c '%d:%i' $q)\" = '${it.dev}:${it.ino}' ] || exit 85; ") }
        }
    }
    private suspend fun execute(prefix: List<String>, script: String, budget: Budget): String {
        val result = Privilege.runExplicitRepairSu(prefix, shellStart() + script, budget.remaining().coerceAtMost(5_000))
        budget.check()
        if (!result.ok || result.truncated) throw Refused("Root metadata scope 失败 status=${result.status} exit=${result.exitCode}; 拒绝链接/类型/替换/限长；可能已有部分元数据更改", result.exitCode !in listOf(82, 83, 84, 85))
        return result.text
    }
    private suspend fun rootMeta(scope: Scope, f: File, expected: Map<File, Meta>, prefix: List<String>, budget: Budget): Meta {
        val q = Privilege.shellQuote(f.absolutePath)
        val text = execute(prefix, guard(scope, f, expected) + "s=\$(/system/bin/stat -c '%d:%i:%u:%g:%f:%h' $q) || exit 86; " + guard(scope, f, expected) + "printf 'SMETA|%s\\n' \"\$s\"; ", budget)
        val lines = text.lineSequence().filter { it.isNotBlank() }.toList()
        if (lines.size != 1 || !lines[0].startsWith("SMETA|")) throw Refused("Root metadata 协议无效")
        val v = lines[0].removePrefix("SMETA|").split(':')
        if (v.size != 6) throw Refused("Root metadata 字段无效")
        return Meta(v[0].toLong(), v[1].toLong(), v[2].toInt(), v[3].toInt(), v[4].toInt(16), v[5].toLong()).also { validate(f, it); if (expected[f]?.identity(it) == false) throw Refused("Root inode 已更换") }
    }
    private suspend fun rootChildren(scope: Scope, f: File, expected: Map<File, Meta>, prefix: List<String>, budget: Budget): List<File> {
        val q = Privilege.shellQuote(f.absolutePath)
        // No find -R, no external content read, no full sessions glob. Hidden children are included;
        // newline/control names are refused by the parser; NUL separates names from shell output.
        val text = execute(prefix, guard(scope, f, expected) +
            "set -o pipefail || exit 92; /system/bin/find $q -mindepth 1 -maxdepth 1 -print0 | (n=0; while IFS= read -r -d '' p; do n=\$((n+1)); [ \"\$n\" -le ${NODE_LIMIT - budget.nodes} ] || exit 91; [ ! -L \"\$p\" ] || exit 82; { [ -d \"\$p\" ] || [ -f \"\$p\" ]; } || exit 84; printf '%s\\000' \"\${p##*/}\"; done) || exit 91; " + guard(scope, f, expected), budget)
        if (text.isNotEmpty() && !text.endsWith('\u0000')) throw Refused("Root NUL listing 协议截断")
        return text.split('\u0000').dropLast(1).map { name -> budget.check(); childName(name); File(f, name) }
    }
    private suspend fun rootChange(scope: Scope, f: File, before: Meta, expected: Map<File, Meta>, prefix: List<String>, budget: Budget, restore: Boolean) {
        val q = Privilege.shellQuote(f.absolutePath)
        val g = guard(scope, f, expected)
        // fd read-open pins a validated regular file/directory but reads zero content bytes.
        // All path/parent checks bracket opening and operations. No chmod/chown -R.
        val script = g + "[ \"\$(/system/bin/stat -c '%d:%i:%u:%g:%f:%h' $q)\" = '${before.dev}:${before.ino}:${before.uid}:${before.gid}:${Integer.toHexString(before.mode)}:${before.links}' ] || exit 85; " +
            "exec 9<$q || exit 87; " + g +
            "[ \"\$(/system/bin/stat -L -c '%d:%i:%h' /proc/\$\$/fd/9)\" = '${before.dev}:${before.ino}:${before.links}' ] || exit 85; " +
            if (restore) "$g/system/bin/restorecon $q >/dev/null 2>&1 || exit 88; $g" else
                "/system/bin/chown ${android.os.Process.myUid()}:${Os.getgid()} /proc/\$\$/fd/9 || exit 89; /system/bin/chmod ${Integer.toOctalString(desired(before))} /proc/\$\$/fd/9 || exit 90; $g"
        execute(prefix, script, budget)
    }
    private fun denied(e: Exception) = (e as? ErrnoException)?.errno in listOf(OsConstants.EACCES, OsConstants.EPERM) || e is java.nio.file.AccessDeniedException
    private fun missing(e: Exception) = (e as? ErrnoException)?.errno == OsConstants.ENOENT || e is java.nio.file.NoSuchFileException
    private fun reason(e: Exception): String = when {
        e is Refused -> e.why
        missing(e) -> "ENOENT：日志 session scope 已消失/陈旧；未创建 session，未扫描其他会话"
        denied(e) -> "EACCES/EPERM：当前 scope 父目录/子项不可访问；需要显式 Root；未读取正文"
        else -> "session metadata rescue 失败（${e.javaClass.simpleName}）；未读取正文"
    }
}
