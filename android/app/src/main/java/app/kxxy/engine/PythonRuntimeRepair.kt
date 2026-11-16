package app.kxxy.engine

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.channels.Channels
import java.nio.channels.FileChannel
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.READ
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.zip.CRC32
import java.util.zip.ZipInputStream

/**
 * APK-only, bounded Python dependency repair. No pip, shell, network, recursive deletion or disk marker trust.
 * The installer calls repair BEFORE its destructive completeness fallback. Every refusal must propagate.
 * Staging is private and flat; a killed process leaves only complete old/new files. A retry rechecks all bytes.
 * The engine must be stopped; parent identities and target contents are rechecked immediately before rename.
 */
internal class PythonRuntimeRepair(
    private val assets: Assets,
    private val privateDirectory: File,
    private val expectedHostFingerprint: String,
    private val androidApi: Int,
    // A narrow fault-injection seam for the JVM harness; production never falls back to copy/delete.
    private val atomicReplace: (Path, Path) -> Unit = { from, to -> Files.move(from, to, ATOMIC_MOVE, REPLACE_EXISTING); Unit },
) {
    fun interface Assets { fun open(name: String): InputStream }
    data class Result(val supported: Boolean, val replaced: List<String>)
    class Refused(message: String, cause: Throwable? = null) : IOException("Python 离线修复：$message；不会自动清空或重装用户运行时", cause)

    private data class Managed(val path: String, val size: Long, val sha256: String, val mode: Int, val role: String, val previous: String?)
    private data class Manifest(val revision: String, val payloadSha: String, val payloadSize: Int, val baseHost: String, val host: String, val files: List<Managed>)
    private data class Content(val size: Long, val sha: String)
    private data class ArchiveEntry(val file: Managed, val offset: Int, val end: Int)
    private enum class State { MISSING, CURRENT, PREVIOUS }
    private val manifest: Manifest? by lazy { loadManifest() }
    // POSIX 视图不能用 FileStore 探测（Android 上 Files.getFileStore / supportsFileAttributeView 一并不可用）。
    // 目标平台只有两种：Android/Linux 的 app 私有目录必然是 POSIX；JVM 测试夹具跑在 Windows 上，没有 POSIX 视图。
    private val windows = System.getProperty("os.name").orEmpty().startsWith("Windows")
    private val posix = !windows

    /** No repair metadata means an old APK, not a broken Python installation. This method never writes. */
    fun isCurrent(root: File): Boolean = guarded {
        val m = manifest ?: return@guarded true
        val scope = Scope(root)
        if (hostFingerprint(scope) != m.host) return@guarded false
        m.files.all { file -> content(scope, file)?.let { it.size == file.size && it.sha == file.sha256 } == true }
    }

    /** DSH 提交前复用完整冲突检查；只读，不创建暂存、标记或修改 Python/host 文件。 */
    fun preflight(root: File): Unit = guarded {
        val m = manifest ?: return@guarded Unit
        inspect(Scope(root), m)
        Unit
    }

    @Synchronized
    fun repair(root: File): Result = guarded {
        val m = manifest ?: return@guarded Result(false, emptyList())
        val scope = Scope(root)
        val before = inspect(scope, m)
        if (before.values.all { it == State.CURRENT }) return@guarded Result(true, emptyList())

        // All failure-prone input validation happens before even creating a staging directory.
        val payload = assets.open(PAYLOAD_ASSET).use { input ->
            val bytes = ByteArray(m.payloadSize)
            var offset = 0
            while (offset < bytes.size) {
                cancelled()
                val n = input.read(bytes, offset, bytes.size - offset)
                if (n < 0) refuse("payload 长度与清单不符")
                if (n == 0) continue
                offset += n
            }
            if (input.read() != -1) refuse("payload 超出清单长度")
            if (sha(bytes) != m.payloadSha) refuse("payload SHA-256 校验失败")
            bytes
        }
        val archive = Archive(payload, m.files)
        val fp = ByteArrayOutputStream()
        archive.visit { file -> if (file.path == HOST_FP) fp else null }
        if (m.files.any { it.path == HOST_FP } && parseFingerprint(fp.toByteArray()) != m.host) {
            refuse("payload 宿主指纹不是此 APK 的目标指纹")
        }
        inspect(scope, m)
        val unpacked = m.files.sumOf { it.size }
        // Android 的 libcore 已整体移除 FileStore：Files.getFileStore 直接抛异常，消息就是 "getFileStore"，
        // 所以在真机上这一行必然失败（桌面 JVM 测试跑不出来）。改用 java.io.File.usableSpace，同一条 statvfs。
        // 取不到（<=0，例如 statvfs 被拒）时不在这里阻断，让后续写入按真实 ENOSPC 失败并保留旧文件。
        val needed = unpacked + 16L * 1024 * 1024
        val free = scope.base.toFile().usableSpace
        if (free in 1 until needed) refuse("私有暂存空间不足，旧文件未改动（剩余 $free 字节，需要 $needed 字节）")

        val stage = scope.newStage()
        val staged = m.files.mapIndexed { index, file -> file.path to stage.resolve("$index.part") }.toMap()
        val replacements = mutableListOf<String>()
        try {
            archive.visit { file ->
                scope.checkStage(stage)
                val channel = newFile(staged.getValue(file.path))
                object : OutputStream() {
                    private val out = Channels.newOutputStream(channel)
                    override fun write(b: Int) = out.write(b)
                    override fun write(b: ByteArray, off: Int, len: Int) = out.write(b, off, len)
                    override fun close() {
                        try { out.flush(); channel.force(true) } finally { out.close() }
                        setMode(staged.getValue(file.path), file.mode)
                    }
                }
            }
            for (file in m.files) {
                scope.checkStage(stage)
                val value = readContent(staged.getValue(file.path), MAX_FILE_BYTES)
                if (value.size != file.size || value.sha != file.sha256) refuse("暂存内容校验失败：${file.path}")
            }
            // Recheck the WHOLE target set after staging: a late conflict must not partially install anything.
            inspect(scope, m)
            for (file in m.files.sortedWith(compareBy<Managed> { commitOrder(it.path) }.thenBy { it.path })) {
                cancelled()
                applicableHost(scope, m)
                if (state(scope, m, file) == State.CURRENT) continue
                scope.target(file.path, createParents = true)
                scope.checkStage(stage)
                val from = staged.getValue(file.path)
                val value = readContent(from, MAX_FILE_BYTES)
                if (value.size != file.size || value.sha != file.sha256) refuse("替换前暂存内容已变化：${file.path}")
                applicableHost(scope, m)
                val to = scope.target(file.path)
                // The last content read is of the destination, after all slower staging checks.
                if (state(scope, m, file) == State.CURRENT) continue
                // No arbitrary unlink, no non-atomic fallback, and no trusting a previous interrupted journal.
                atomicReplace(from, to)
                replacements += file.path
                val after = content(scope, file)
                if (after?.size != file.size || after.sha != file.sha256) refuse("原子替换后校验失败：${file.path}")
            }
            if (hostFingerprint(scope) != m.host || inspect(scope, m).values.any { it != State.CURRENT }) {
                refuse("最终内容校验失败，可安全重试")
            }
            Result(true, replacements.toList())
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            throw e
        } catch (e: Exception) {
            throw Refused("修复未完成，已确认替换 ${replacements.size} 个受管文件，其余文件请重试时重新校验。${e.message}", e)
        } finally {
            // Only paths created by THIS invocation. Never walk/delete an old staging tree or an engine tree.
            for (path in staged.values) runCatching { scope.checkStage(stage); Files.deleteIfExists(path) }
            runCatching { scope.checkStage(stage); Files.delete(stage) }
        }
    }

    private fun inspect(scope: Scope, m: Manifest): Map<String, State> {
        applicableHost(scope, m)
        return m.files.associate { it.path to state(scope, m, it) }
    }

    private fun applicableHost(scope: Scope, m: Manifest) {
        val actual = hostFingerprint(scope)
        if (actual != m.baseHost && actual != m.host) refuse("不适用此增量修复：设备宿主指纹不匹配基线或目标（${actual?.take(16) ?: "缺失"}）")
    }

    private fun hostFingerprint(scope: Scope): String? {
        val path = scope.target(HOST_FP)
        if (attributes(path) == null) return null
        readContent(path, MAX_FINGERPRINT_BYTES.toLong())
        // Use NOFOLLOW again, and pin the identity across the small text read as well.
        return parseFingerprint(readSmallFile(path, MAX_FINGERPRINT_BYTES))
    }

    private fun state(scope: Scope, m: Manifest, file: Managed): State {
        val actual = content(scope, file) ?: return State.MISSING
        if (actual.sha == file.sha256 && actual.size == file.size) return State.CURRENT
        if (file.previous != null && actual.sha == file.previous) return State.PREVIOUS
        if (file.path == RUNTIME_MANIFEST && supersededManifest(scope, m)) return State.PREVIOUS
        refuse("用户文件冲突或内容已修改：${file.path}（盘上 ${actual.size} 字节，sha256 ${actual.sha.take(12)}；既非期望内容，也不匹配显式 previousSha256）；保留原文件")
    }

    /**
     * 根清单 `kxxy-runtime.json` 是安装器自己写出来的**构建元数据**，不是用户内容：
     * 每次发布都会重写 `builtAt`，只要动过插件就会重写 `plugins.codexFingerprint`
     * （0.9.42 与 0.9.43 之间只有这两个字段不同）。用单个 `previousSha256` 表达
     * 「上一版」根本无法覆盖真实设备：那枚哈希来自 0.9.41 基线重封后的中间产物，
     * 从来不是发行物 —— 于是 0.9.42 → 0.9.43 的真机升级被判成「用户文件冲突」，
     * 安装阶段直接 Refused，六次同因失败后启动放弃。
     *
     * 这里改用**结构判据**：盘上那份只要仍是本 APK 认识的清单 schema、只出现我们自己写过的
     * 字段、且插件谱系仍是本次的基线或目标宿主指纹，就允许被本次修复整体覆盖。
     * 其余 60 个代码文件依旧逐字节校验（含 `previousSha256`），所以「用户换掉了运行时」
     * 这类情况照旧 fail-closed：认不出的一律不写。
     */
    private fun supersededManifest(scope: Scope, m: Manifest): Boolean {
        // Bounded, NOFOLLOW, identity-pinned read of the very file whose bytes we are about to supersede.
        val value = try {
            Json(readSmallFile(scope.target(RUNTIME_MANIFEST), MAX_MANIFEST_BYTES)).objectValue()
        } catch (_: Exception) {
            return false
        }
        if (value.keys.any { it !in MANIFEST_KEYS }) return false
        if (value.integerOrNull("schemaVersion") != MANIFEST_SCHEMA) return false
        if (value["arch"] != "aarch64") return false
        val plugins = value["plugins"] as? Map<*, *> ?: return false
        if (plugins.keys.any { (it as? String) !in MANIFEST_PLUGIN_KEYS }) return false
        val lineage = (plugins["hostFingerprint"] as? String)?.lowercase(Locale.ROOT) ?: return false
        return lineage == m.baseHost || lineage == m.host
    }

    private fun content(scope: Scope, file: Managed): Content? {
        val path = scope.target(file.path)
        if (attributes(path) == null) return null
        return readContent(path, MAX_FILE_BYTES)
    }

    private fun loadManifest(): Manifest? {
        val metadataBytes = try { assets.open(META_ASSET).use { bounded(it, MAX_META_BYTES) } } catch (_: FileNotFoundException) { return null }
        val meta = Json(metadataBytes).objectValue()
        if (!meta.containsKey("pythonRepairManifestSha256") && !meta.containsKey("pythonRuntimeRevision")) return null
        val expectedSha = meta.hash("pythonRepairManifestSha256")
        val revision = meta.string("pythonRuntimeRevision")
        if (revision != REVISION) refuse("此 APK 声明了不支持的 Python 修复 revision")
        val bytes = assets.open(MANIFEST_ASSET).use { bounded(it, MAX_MANIFEST_BYTES) }
        if (sha(bytes) != expectedSha) refuse("manifest SHA-256 与可信 APK meta/build.json 不符")
        val obj = Json(bytes).objectValue()
        obj.keysExactly(setOf("schema", "revision", "python", "payloadSha256", "payloadSize", "baseHostFingerprint", "hostFingerprint", "files"))
        if (obj.integer("schema") != 1L || obj.string("revision") != revision) refuse("manifest schema/revision 不匹配")
        val python = obj.obj("python")
        python.keysExactly(setOf("majorMinor", "soabi", "minApi"))
        if (python.string("majorMinor") != "3.14" || python.string("soabi") != SOABI || python.integer("minApi") != 24L || androidApi < 24) {
            refuse("Python ABI 或 Android API 不匹配")
        }
        val host = obj.hash("hostFingerprint")
        if (meta.hash("kxxyHostFingerprint") != host) refuse("目标宿主指纹与 APK metadata 不符")
        if (expectedHostFingerprint.isNotBlank() && expectedHostFingerprint != "unknown" && expectedHostFingerprint.lowercase(Locale.ROOT) != host) {
            refuse("目标宿主指纹与已编译 BuildConfig 不符")
        }
        val base = obj.hash("baseHostFingerprint")
        val payloadSize = obj.integer("payloadSize")
        if (payloadSize !in 22L..MAX_PAYLOAD_BYTES.toLong()) refuse("payload 大小超出上限")
        val list = obj["files"] as? List<*> ?: refuse("files 必须是数组")
        if (list.isEmpty() || list.size > MAX_FILES) refuse("受管文件数量超出范围")
        val paths = HashSet<String>()
        var total = 0L
        val files = list.map { value ->
            val f = objectMap(value)
            f.keysExactly(setOf("path", "size", "sha256", "mode", "role"), setOf("previousSha256"))
            val path = f.string("path")
            val role = f.string("role")
            validatePath(path, role)
            if (!paths.add(path.lowercase(Locale.ROOT))) refuse("清单路径重复：$path")
            val size = f.integer("size")
            if (size !in 0L..MAX_FILE_BYTES || (path == HOST_FP && size > MAX_FINGERPRINT_BYTES)) refuse("文件大小超出范围：$path")
            total += size
            if (total > MAX_TOTAL_BYTES) refuse("总解压大小超出上限")
            val mode = f.integer("mode")
            if (mode != 420L && mode != 493L) refuse("不允许的文件 mode：$path")
            Managed(path, size, f.hash("sha256"), mode.toInt(), role, if (f.containsKey("previousSha256")) f.hash("previousSha256") else null)
        }
        for (file in files) {
            var parent = file.path.substringBeforeLast('/', "")
            while (parent.isNotEmpty()) {
                if (parent.lowercase(Locale.ROOT) in paths) refuse("清单文件/父目录重叠：${file.path}")
                parent = parent.substringBeforeLast('/', "")
            }
        }
        if (!paths.containsAll(REQUIRED_FILES.map { it.lowercase(Locale.ROOT) })) refuse("清单缺少 Python 原生后端、包元数据或版本文件")
        if (base != host && files.none { it.path == HOST_FP && it.previous != null }) refuse("跨宿主版本修复必须包含指纹文件及 previousSha256")
        return Manifest(revision, obj.hash("payloadSha256"), payloadSize.toInt(), base, host, files)
    }

    private fun validatePath(path: String, role: String) {
        val parts = path.split('/')
        if (path.length !in 1..512 || parts.any { it.isEmpty() || it == "." || it == ".." || it.endsWith('.') || !it.matches(Regex("[A-Za-z0-9_+.\\-]+")) || it.length > 255 }) {
            refuse("非法文件路径：$path")
        }
        if (parts.any { it.substringBefore('.').uppercase(Locale.ROOT).matches(Regex("CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]")) }) refuse("保留设备路径：$path")
        val allowed = when (role) {
            "python" -> path == PYTHON_MARKER || path == BACKEND || PYTHON_PREFIXES.any { path.startsWith(it) }
            "host" -> path == RUNTIME_MANIFEST || path in HOST_WEB_FILES || HOST_FILES.any { path == HOST_BASE + it }
            else -> false
        }
        if (!allowed) refuse("路径不在 $role 修复白名单：$path")
    }

    /** Pin the app-private boundary and each encountered directory. Never canonicalize an engine child. */
    private inner class Scope(root: File) {
        private val boundary = linkedMapOf<Path, BasicFileAttributes>()
        private val parents = linkedMapOf<Path, BasicFileAttributes>()
        private val stages = linkedMapOf<Path, BasicFileAttributes>()
        val base: Path
        private val engine: Path

        init {
            val rawBase = privateDirectory.toPath().toAbsolutePath()
            val rawRoot = root.toPath().toAbsolutePath()
            if (rawBase != rawBase.normalize() || rawRoot != rawRoot.normalize() || rawRoot.parent != rawBase) refuse("运行时不在预期私有目录内")
            var part: Path? = rawBase
            while (part != null) {
                val p = part
                val a = attributes(p) ?: refuse("私有父目录缺失：$p")
                if (a.isSymbolicLink) {
                    // Android /data/user/0 or /data/data may be a root-owned system alias. Not app-controlled links.
                    val uid = runCatching { Files.getAttribute(p, "unix:uid", NOFOLLOW_LINKS) as? Number }.getOrNull()?.toInt()
                    if (p == rawBase || uid != 0) refuse("拒绝符号链接父目录：$p")
                } else if (!a.isDirectory) refuse("父链不是普通目录：$p")
                boundary[p] = a
                part = p.parent
            }
            base = rawBase.toRealPath()
            engine = base.resolve(rawRoot.fileName)
            directory(engine)
        }

        private fun checkBoundary() {
            for ((path, old) in boundary) {
                val now = attributes(path) ?: refuse("私有父目录已消失：$path")
                if (!sameIdentity(old, now)) refuse("私有父目录已替换：$path")
            }
        }

        private fun directory(path: Path): Boolean {
            val a = attributes(path) ?: return false
            if (!a.isDirectory || a.isSymbolicLink) refuse("拒绝符号链接或非目录父链：$path")
            val old = parents[path]
            if (old != null && !sameIdentity(old, a)) refuse("修复期间父目录已替换：$path")
            parents[path] = a
            return true
        }

        fun target(relative: String, createParents: Boolean = false): Path {
            checkBoundary()
            if (!directory(engine)) refuse("运行时根目录不存在")
            val target = engine.resolve(relative).normalize()
            if (!target.startsWith(engine) || target == engine) refuse("目标逃逸运行时目录")
            var current = engine
            for (name in engine.relativize(target.parent)) {
                current = current.resolve(name)
                if (!directory(current) && createParents) {
                    createDirectory(current, 493)
                    if (!directory(current)) refuse("无法创建受管文件父目录")
                }
            }
            val a = attributes(target)
            if (a != null && (!a.isRegularFile || a.isSymbolicLink)) refuse("拒绝符号链接或非常规目标文件：$relative")
            return target
        }

        fun newStage(): Path {
            checkBoundary()
            val path = base.resolve(".python-repair-${UUID.randomUUID()}")
            createDirectory(path, 448)
            stages[path] = attributes(path) ?: refuse("私有暂存目录创建失败")
            checkStage(path)
            return path
        }

        fun checkStage(path: Path) {
            checkBoundary()
            val now = attributes(path) ?: refuse("私有暂存目录消失")
            if (!now.isDirectory || now.isSymbolicLink || !sameIdentity(stages.getValue(path), now)) refuse("私有暂存父目录被替换")
        }
    }

    /** CEN and local headers are both checked: ZipInputStream alone cannot see Unix types or LINK comments. */
    private inner class Archive(private val bytes: ByteArray, private val files: List<Managed>) {
        private val entries: List<ArchiveEntry>
        init {
            val end = (bytes.size - 22 downTo maxOf(0, bytes.size - 65557)).firstOrNull {
                u32(it) == 0x06054b50L && it + 22 + u16(it + 20) == bytes.size
            } ?: refuse("ZIP 缺少有效中央目录结束记录")
            if (u16(end + 4) != 0 || u16(end + 6) != 0 || u16(end + 8) != files.size || u16(end + 10) != files.size) refuse("ZIP 多卷/条目数量不匹配")
            val central = u32(end + 16)
            val centralSize = u32(end + 12)
            if (central + centralSize != end.toLong() || central > bytes.size) refuse("ZIP 中央目录范围不正确")
            var at = central.toInt()
            val byName = files.associateBy { it.path }
            val seen = HashSet<String>()
            val parsed = ArrayList<ArchiveEntry>()
            repeat(files.size) {
                cancelled()
                range(at, 46)
                if (u32(at) != 0x02014b50L) refuse("ZIP 中央目录记录无效")
                val flags = u16(at + 8)
                val method = u16(at + 10)
                val compressed = u32(at + 20)
                val size = u32(at + 24)
                val nameLength = u16(at + 28)
                val extraLength = u16(at + 30)
                val commentLength = u16(at + 32)
                range(at + 46, nameLength + extraLength + commentLength)
                val name = text(at + 46, nameLength)
                val file = byName[name] ?: refuse("ZIP 含清单外条目：$name")
                if (!seen.add(name)) refuse("ZIP 重复条目：$name")
                val unixMode = (u32(at + 38) ushr 16).toInt()
                if (u16(at + 4) ushr 8 !in setOf(3, 19) || unixMode and 61440 != 32768 || unixMode and 4095 != file.mode || u32(at + 38) and 16L != 0L) refuse("ZIP 条目不是约定的普通文件/mode：$name")
                if (text(at + 46 + nameLength + extraLength, commentLength).startsWith("LINK:")) refuse("ZIP 禁止 LINK 条目：$name")
                if (u16(at + 6) > 20 || flags and 0xf7f7 != 0 || method !in setOf(0, 8) || size != file.size || compressed > bytes.size || u16(at + 34) != 0) refuse("ZIP 方法、标记或大小不匹配：$name")
                checkExtra(at + 46 + nameLength, extraLength)
                val localLong = u32(at + 42)
                if (localLong >= central) refuse("ZIP 本地记录范围不正确：$name")
                val local = localLong.toInt()
                range(local, 30)
                val localName = u16(local + 26)
                val localExtra = u16(local + 28)
                range(local + 30, localName + localExtra)
                if (u32(local) != 0x04034b50L || u16(local + 4) > 20 || u16(local + 6) != flags || u16(local + 8) != method || text(local + 30, localName) != name) refuse("ZIP 本地/中央记录不一致：$name")
                checkExtra(local + 30 + localName, localExtra)
                var next = local + 30L + localName + localExtra + compressed
                if (flags and 8 != 0) {
                    if (method != 8 || u32(local + 14) != 0L || u32(local + 18) != 0L || u32(local + 22) != 0L) refuse("ZIP descriptor 本地记录无效：$name")
                    range(next.toInt(), 12)
                    if (u32(next.toInt()) == 0x08074b50L) next += 4
                    range(next.toInt(), 12)
                    if (u32(next.toInt()) != u32(at + 16) || u32(next.toInt() + 4) != compressed || u32(next.toInt() + 8) != size) refuse("ZIP descriptor 不一致：$name")
                    next += 12
                } else if (u32(local + 14) != u32(at + 16) || u32(local + 18) != compressed || u32(local + 22) != size) refuse("ZIP 本地大小/CRC 不一致：$name")
                if (next > central || (method == 0 && compressed != size)) refuse("ZIP 数据范围不正确：$name")
                parsed += ArchiveEntry(file, local, next.toInt())
                at += 46 + nameLength + extraLength + commentLength
            }
            if (at.toLong() != central + centralSize) refuse("ZIP 中央目录含额外记录")
            entries = parsed.sortedBy { it.offset }
            var offset = 0
            for (entry in entries) {
                if (entry.offset != offset) refuse("ZIP 含未声明、重叠或间隙记录")
                offset = entry.end
            }
            if (offset.toLong() != central) refuse("ZIP 含未声明数据")
        }

        fun visit(output: (Managed) -> OutputStream?) {
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                for (entry in entries) {
                    cancelled()
                    val actual = zip.nextEntry ?: refuse("ZIP 条目提前结束")
                    if (actual.name != entry.file.path || actual.isDirectory) refuse("ZIP 本地条目不匹配")
                    val digest = MessageDigest.getInstance("SHA-256")
                    val crc = CRC32()
                    var total = 0L
                    val out = output(entry.file)
                    try {
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            cancelled()
                            val n = zip.read(buffer)
                            if (n < 0) break
                            total += n
                            if (total > entry.file.size) refuse("ZIP 解压大小超出清单：${actual.name}")
                            digest.update(buffer, 0, n); crc.update(buffer, 0, n)
                            out?.write(buffer, 0, n)
                        }
                    } finally { out?.close() }
                    if (total != entry.file.size || hex(digest.digest()) != entry.file.sha256 || actual.crc != crc.value) refuse("ZIP 文件内容校验失败：${actual.name}")
                    zip.closeEntry()
                }
                if (zip.nextEntry != null) refuse("ZIP 含额外本地条目")
            }
        }

        private fun range(at: Int, size: Int) { if (at < 0 || size < 0 || at.toLong() + size > bytes.size) refuse("ZIP 记录越界") }
        private fun u16(at: Int): Int { range(at, 2); return (bytes[at].toInt() and 255) or ((bytes[at + 1].toInt() and 255) shl 8) }
        private fun u32(at: Int): Long = u16(at).toLong() or (u16(at + 2).toLong() shl 16)
        private fun text(at: Int, size: Int): String { range(at, size); return utf8(bytes.copyOfRange(at, at + size)) }
        private fun checkExtra(at: Int, size: Int) {
            var p = at
            val end = at + size
            while (p < end) {
                if (p + 4 > end) refuse("ZIP extra 截断")
                val tag = u16(p)
                val n = u16(p + 2)
                if (tag in setOf(1, 0x000d, 0x756e, 0x7075) || p + 4 + n > end) refuse("ZIP 不支持链接、替代路径或 ZIP64 extra")
                p += 4 + n
            }
        }
    }

    private fun readContent(path: Path, limit: Long): Content {
        val before = regular(path)
        if (before.size() > limit) refuse("受管文件超出读取上限/用户冲突：$path")
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        FileChannel.open(path, READ, NOFOLLOW_LINKS).use { channel ->
            val buffer = ByteBuffer.allocate(64 * 1024)
            while (true) {
                cancelled()
                buffer.clear()
                val n = channel.read(buffer)
                if (n < 0) break
                total += n
                if (total > limit) refuse("文件读取期间超出上限：$path")
                digest.update(buffer.array(), 0, n)
            }
        }
        val after = regular(path)
        if (!sameIdentity(before, after) || before.size() != after.size() || before.lastModifiedTime() != after.lastModifiedTime() || total != after.size()) refuse("读取期间文件被替换或修改：$path")
        return Content(total, hex(digest.digest()))
    }

    private fun readSmallFile(path: Path, limit: Int): ByteArray {
        val before = regular(path)
        val bytes = FileChannel.open(path, READ, NOFOLLOW_LINKS).use { bounded(Channels.newInputStream(it), limit) }
        val after = regular(path)
        if (!sameIdentity(before, after) || before.lastModifiedTime() != after.lastModifiedTime() || after.size() != bytes.size.toLong()) refuse("读取期间指纹文件变化")
        return bytes
    }

    private fun regular(path: Path): BasicFileAttributes {
        val a = attributes(path) ?: refuse("受管文件消失：$path")
        if (!a.isRegularFile || a.isSymbolicLink) refuse("拒绝非常规文件或符号链接：$path")
        return a
    }

    private fun attributes(path: Path): BasicFileAttributes? = try { Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS) } catch (_: NoSuchFileException) { null }
    private fun sameIdentity(a: BasicFileAttributes, b: BasicFileAttributes): Boolean {
        // Android/Linux exposes (device,inode). The Windows JVM harness exposes only creationTime.
        val identity = if (a.fileKey() != null) a.fileKey() == b.fileKey()
            else windows && a.creationTime() == b.creationTime()
        return identity && a.isDirectory == b.isDirectory && a.isSymbolicLink == b.isSymbolicLink && a.isRegularFile == b.isRegularFile
    }
    private fun permission(mode: Int) = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString(when (mode) { 448 -> "rwx------"; 493 -> "rwxr-xr-x"; 420 -> "rw-r--r--"; else -> "rw-------" }))
    private fun createDirectory(path: Path, mode: Int) {
        if (posix) Files.createDirectory(path, permission(mode))
        else if (windows) Files.createDirectory(path) // JVM harness: inherits its private app/test boundary ACL.
        else refuse("文件系统不支持私有 POSIX 暂存权限")
    }
    private fun newFile(path: Path): FileChannel = if (posix) FileChannel.open(path, setOf(CREATE_NEW, WRITE, NOFOLLOW_LINKS), permission(384)) else FileChannel.open(path, CREATE_NEW, WRITE, NOFOLLOW_LINKS)
    private fun setMode(path: Path, mode: Int) { if (posix) Files.setPosixFilePermissions(path, permission(mode).value()) }
    private fun parseFingerprint(bytes: ByteArray): String? {
        val values = utf8(bytes).lineSequence().filter { it.startsWith("fingerprint:") }.map { it.removePrefix("fingerprint:").trim().lowercase(Locale.ROOT) }.toList()
        return values.singleOrNull()?.takeIf { HASH.matches(it) }
    }
    private fun commitOrder(path: String) = when (path) { PYTHON_MARKER -> 1; RUNTIME_MANIFEST -> 2; HOST_FP -> 3; else -> 0 }
    private inline fun <T> guarded(block: () -> T): T = try { cancelled(); block() } catch (e: InterruptedException) { Thread.currentThread().interrupt(); throw e } catch (e: Refused) { throw e } catch (e: Exception) { throw Refused(e.message ?: e.javaClass.simpleName, e) }

    /** Strict JSON (unlike Android JSONObject's coercions/lenient grammar), bounded before parsing. */
    private class Json(bytes: ByteArray) {
        private val text = utf8(bytes)
        private var at = 0
        private var nodes = 0
        fun objectValue(): Map<String, Any?> {
            val result = objectMap(value(0))
            space()
            if (at != text.length) refuse("JSON 尾部含额外内容")
            return result
        }
        private fun value(depth: Int): Any? {
            if (depth > 16 || ++nodes > 20000) refuse("JSON 结构超出上限")
            space()
            if (at >= text.length) refuse("JSON 截断")
            return when (text[at]) {
                '{' -> {
                    at++; space()
                    val result = linkedMapOf<String, Any?>()
                    if (take('}')) result else {
                        while (true) {
                            space()
                            val key = string()
                            if (result.containsKey(key)) refuse("JSON 重复字段：$key")
                            space(); expect(':')
                            result[key] = value(depth + 1)
                            space()
                            if (take('}')) break
                            expect(',')
                        }
                        result
                    }
                }
                '[' -> {
                    at++; space()
                    val result = arrayListOf<Any?>()
                    if (take(']')) result else {
                        while (true) { result += value(depth + 1); space(); if (take(']')) break; expect(',') }
                        result
                    }
                }
                '"' -> string()
                't' -> { literal("true"); true }
                'f' -> { literal("false"); false }
                'n' -> { literal("null"); null }
                else -> number()
            }
        }
        private fun string(): String {
            expect('"')
            val out = StringBuilder()
            while (at < text.length) {
                val c = text[at++]
                if (c == '"') return out.toString()
                if (c < ' ') refuse("JSON 字符串含控制字符")
                if (c != '\\') { out.append(c); continue }
                if (at >= text.length) refuse("JSON 转义截断")
                out.append(when (val escape = text[at++]) {
                    '"', '\\', '/' -> escape
                    'b' -> '\b'; 'f' -> '\u000c'; 'n' -> '\n'; 'r' -> '\r'; 't' -> '\t'
                    'u' -> {
                        if (at + 4 > text.length) refuse("JSON Unicode 转义截断")
                        val code = text.substring(at, at + 4)
                        if (!code.matches(Regex("[0-9a-fA-F]{4}"))) refuse("JSON Unicode 转义无效")
                        at += 4; code.toInt(16).toChar()
                    }
                    else -> refuse("JSON 转义无效")
                })
            }
            refuse("JSON 字符串截断")
        }
        private fun number(): NumberText {
            val start = at
            take('-')
            if (!take('0')) { if (at >= text.length || text[at] !in '1'..'9') refuse("JSON 数字无效"); while (at < text.length && text[at] in '0'..'9') at++ }
            if (take('.')) { val p = at; while (at < text.length && text[at] in '0'..'9') at++; if (p == at) refuse("JSON 小数无效") }
            if (at < text.length && text[at] in "eE") { at++; if (at < text.length && text[at] in "+-") at++; val p = at; while (at < text.length && text[at] in '0'..'9') at++; if (p == at) refuse("JSON 指数无效") }
            return NumberText(text.substring(start, at))
        }
        private fun literal(word: String) { if (!text.startsWith(word, at)) refuse("JSON 字面量无效"); at += word.length }
        private fun space() { while (at < text.length && text[at] in " \r\n\t") at++ }
        private fun take(c: Char): Boolean = if (at < text.length && text[at] == c) { at++; true } else false
        private fun expect(c: Char) { if (!take(c)) refuse("JSON 语法错误（位置 $at）") }
    }

    private data class NumberText(val text: String)
    companion object {
        const val REVISION = "python-cffi-2.0.0-cp314-android24-arm64-v1"
        private const val SOABI = "cpython-314-aarch64-linux-android"
        private const val SITE = "lib/python3.14/site-packages/"
        private const val BACKEND = SITE + "_cffi_backend.cpython-314-aarch64-linux-android.so"
        private const val HOST_BASE = "lib/node_modules/kxxy-host/lib/"
        private const val HOST_FP = HOST_BASE + ".fingerprint"
        private const val PYTHON_MARKER = "share/kxxy/python-runtime.json"
        private const val RUNTIME_MANIFEST = "kxxy-runtime.json"
        private const val META_ASSET = "meta/build.json"
        private const val MANIFEST_ASSET = "python-repair/manifest.json"
        private const val PAYLOAD_ASSET = "python-repair/payload.zip"
        private const val MAX_META_BYTES = 128 * 1024
        private const val MAX_MANIFEST_BYTES = 512 * 1024
        private const val MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
        private const val MAX_FILE_BYTES = 16L * 1024 * 1024
        private const val MAX_TOTAL_BYTES = 64L * 1024 * 1024
        private const val MAX_FINGERPRINT_BYTES = 4096
        private const val MAX_FILES = 1024
        private         val HASH = Regex("[0-9a-f]{64}")
        /**
         * 运行时根清单的结构白名单：`tools/build-runtime.mjs` 写出的顶层键与 plugins 键。
         * 新增字段必须同步这里，否则升级会被当成用户冲突而 fail-closed（方向安全，但会挡住启动）。
         */
        private val MANIFEST_KEYS = setOf(
            "schemaVersion", "runtimeVersion", "rootPlaceholder", "termuxPrefix", "arch", "node",
            "entries", "directories", "linkEntries", "placeholderPaths", "removedPaths", "builtAt",
            "plugins", "pythonRuntimeRevision",
        )
        private val MANIFEST_PLUGIN_KEYS = setOf("hostFingerprint", "hostMarker", "mobileMarker", "codexFingerprint", "codexRuntime")
        /** 与 `kxxy-runtime.json.schemaVersion` 同步；`tools/verify-python-repair.mjs` 会核对这两处。 */
        private const val MANIFEST_SCHEMA = 2L
        private val PYTHON_PREFIXES = listOf("cffi/", "cffi-2.0.0.dist-info/", "pycparser/", "pycparser-2.23.dist-info/").map { SITE + it }
        private val HOST_FILES = setOf("selftest.mjs", "python-selftest.mjs", "python-probe.py", "index.js", ".fingerprint")
        private val HOST_WEB_FILES = setOf("lib/node_modules/kxxy-host/web/index.html", "lib/node_modules/kxxy-host/web/host.js")
        private val REQUIRED_FILES = setOf(BACKEND, SITE + "cffi/__init__.py", SITE + "cffi-2.0.0.dist-info/METADATA", SITE + "pycparser/__init__.py", SITE + "pycparser-2.23.dist-info/METADATA", PYTHON_MARKER)
        private fun refuse(message: String): Nothing = throw Refused(message)
        private fun cancelled() { if (Thread.currentThread().isInterrupted) throw InterruptedException("Python repair cancelled") }
        private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
        private fun sha(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
        private fun utf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        private fun bounded(input: InputStream, limit: Int): ByteArray {
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) { cancelled(); val n = input.read(buffer); if (n < 0) break; if (output.size().toLong() + n > limit) refuse("输入超出读取上限"); output.write(buffer, 0, n) }
            return output.toByteArray()
        }
        @Suppress("UNCHECKED_CAST") private fun objectMap(value: Any?): Map<String, Any?> = value as? Map<String, Any?> ?: refuse("JSON 字段必须是对象")
        private fun Map<String, Any?>.obj(key: String) = objectMap(this[key])
        private fun Map<String, Any?>.string(key: String): String = this[key] as? String ?: refuse("$key 必须是字符串")
        private fun Map<String, Any?>.hash(key: String): String = string(key).lowercase(Locale.ROOT).also { if (!HASH.matches(it)) refuse("$key 必须是 64 位 SHA-256") }
        private fun Map<String, Any?>.integer(key: String): Long {
            val text = (this[key] as? NumberText)?.text ?: refuse("$key 必须是整数，不能做类型转换")
            if (!text.matches(Regex("0|[1-9][0-9]*"))) refuse("$key 必须是非负整数")
            return text.toLongOrNull() ?: refuse("$key 整数溢出")
        }
        /** Same strict grammar as [integer], but for device-side state: unreadable values answer null instead of throwing. */
        private fun Map<String, Any?>.integerOrNull(key: String): Long? {
            val text = (this[key] as? NumberText)?.text ?: return null
            return if (text.matches(Regex("0|[1-9][0-9]*"))) text.toLongOrNull() else null
        }
        private fun Map<String, Any?>.keysExactly(required: Set<String>, optional: Set<String> = emptySet()) {
            if (!keys.containsAll(required) || keys.any { it !in required && it !in optional }) refuse("清单含缺失或未知字段")
        }
    }
}
