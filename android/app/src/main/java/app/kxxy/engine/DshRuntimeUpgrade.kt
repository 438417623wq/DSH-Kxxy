package app.kxxy.engine

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
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
 * 只修改可信 APK 清单列出的普通文件；调用方须先停止引擎及维护任务。
 * 全量冲突预检 → 私有流式暂存及校验 → 逐文件原子提交；不扫描或搬移用户包目录。
 * 不信任完成标记和遗留暂存；中断后重新验证每个旧/新/缺失文件。
 */
internal class DshRuntimeUpgrade(
    private val assets: Assets,
    private val privateDirectory: File,
    private val expectedHostFingerprint: String,
    // JVM 夹具只在这两个边界注入故障；生产绝不退化成复制后删除。
    private val atomicReplace: (Path, Path) -> Unit = { from, to -> Files.move(from, to, ATOMIC_MOVE, REPLACE_EXISTING); Unit },
    private val usableSpace: (File) -> Long = { it.usableSpace },
) {
    fun interface Assets { fun open(name: String): InputStream }
    data class Result(
        val supported: Boolean,
        val replaced: List<String>,
        val backups: Map<String, File>,
        val pruned: Int = 0,
    )
    open class Refused(message: String, cause: Throwable? = null) : IOException("DSH 离线升级：$message；不会自动清空或重装用户运行时", cause)

    /**
     * 载荷不适配本机（设备宿主指纹既非基线也非目标）。语义与
     * [PythonRuntimeRepair.NotApplicable] 一致：调用方可以安全地改走全量安装，
     * 用户文件冲突仍然只能是 [Refused]。
     */
    class NotApplicable(message: String) : Refused(message)

    private data class Managed(val path: String, val size: Long, val mode: Int, val sha: String?, val previous: Set<String>)
    private data class Manifest(val baseHost: String, val host: String, val payloadSha: String, val payloadSize: Long, val files: List<Managed>)
    private data class Content(val size: Long, val sha: String)
    private data class ArchiveEntry(val file: Managed, val offset: Long, val end: Long, val compressed: Long, val crc: Long, val method: Int)
    private enum class State { MISSING, CURRENT, PREVIOUS }
    private val manifest: Manifest? by lazy { loadManifest() }
    // Android/Linux 的 app 私有目录使用 POSIX；Windows JVM 夹具继承测试目录 ACL。
    private val windows = System.getProperty("os.name").orEmpty().startsWith("Windows")

    fun isConfigured(): Boolean = guarded { manifest != null }

    /** 仅查看根目录是否为空，不递归；符号链接/异常父链绝不能被判成可全量安装的新目录。 */
    fun isEmpty(root: File): Boolean = guarded { Scope(root).isEmpty() }

    /** 首次启动已发布状态并创建桥目录；这些原生元数据不代表运行时已安装。 */
    fun isFreshRoot(root: File): Boolean = guarded { Scope(root).isFreshRoot() }

    /** 完整内容探针，不以磁盘标记冒充校验；新装和每次重入都可调用。 */
    fun isCurrent(root: File): Boolean = guarded {
        val m = manifest ?: return@guarded true
        val scope = Scope(root)
        if (hostFingerprint(scope) != m.host) return@guarded false
        var current = true
        for (file in m.files) {
            val value = content(scope, file)
            if (file.sha == null) {
                if (value != null) current = false
            } else if (value?.sha != file.sha || value.size != file.size || !modeMatches(scope.target(file.path), file.mode)) {
                current = false
            }
        }
        current
    }

    /** 仅在全部目标内容已匹配时修正权限；冲突不写入，仍交给原增量升级处理。 */
    @Synchronized
    fun restoreCurrentModes(root: File): Boolean = guarded {
        val m = manifest ?: return@guarded true
        val scope = Scope(root)
        if (hostFingerprint(scope) != m.host) return@guarded false
        val pending = mutableListOf<Managed>()
        for (file in m.files) {
            val value = content(scope, file)
            if (file.sha == null) {
                if (value != null) return@guarded false
            } else {
                if (value?.sha != file.sha || value.size != file.size) return@guarded false
                if (!modeMatches(scope.target(file.path), file.mode)) pending += file
            }
        }
        for (file in pending) {
            cancelled()
            if (content(scope, file) != Content(file.size, file.sha!!)) refuse("修复权限前内容已变化：${file.path}")
            val path = scope.target(file.path)
            setMode(path, file.mode)
            if (!modeMatches(scope.target(file.path), file.mode)) refuse("权限修复未生效：${file.path}")
        }
        true
    }

    /**
     * 增量升级。[onProgress] 只做界面呈现，不参与任何判定；升级本身在失败时仍抛 [Refused]。
     *
     * 为什么必须有进度：真实设备上要写两万多个文件，原实现整段不上报，启动页会永久停在
     * 「解压 0%」——用户只能强杀，重来又从头开始，永远装不完。
     */
    @Synchronized
    fun upgrade(root: File, onProgress: (Float) -> Unit = {}): Result = guarded {
        val m = manifest ?: return@guarded Result(false, emptyList(), emptyMap())
        val scope = Scope(root)
        val report = progress(onProgress)
        report(0f)
        val before = inspect(scope, m)
        if (m.files.all { complete(it, before.getValue(it.path)) }) {
            // 内容已经是最新，但**目录**未必干净：旧实现退役文件时只搬走文件、把空目录留在原地。
            // 这一条必须放在快速路径上，否则已经踩过坑的设备装了新 APK 也永远修不回来
            // （文件全都匹配 → 提前返回 → 空目录继续遮蔽 → 引擎照旧 exit 1）。
            val pruned = scope.pruneEmptyDirectories(retiredDirectories(m))
            report(1f)
            return@guarded Result(true, emptyList(), emptyMap(), pruned)
        }

        val files = m.files.filter { it.sha != null }
        val needed = m.payloadSize + files.sumOf { it.size } + 16L * 1024 * 1024
        val free = usableSpace(scope.base.toFile())
        // 取不到 statvfs 数值时，由实际写入报告 ENOSPC；已知不足必须在暂存前拒绝。
        if (free in 1 until needed) refuse("私有暂存空间不足，旧文件未改动（剩余 $free 字节，需要 $needed 字节）")
        val stage = scope.newPrivateDirectory(".dsh-upgrade-stage-")
        val owned = linkedMapOf<Path, BasicFileAttributes>()
        val staged = files.mapIndexed { index, file -> file.path to stage.resolve("$index.part") }.toMap()
        val payload = stage.resolve("payload.zip")
        val replaced = mutableListOf<String>()
        val backups = linkedMapOf<String, File>()
        var backupDirectory: Path? = null
        try {
            scope.checkPrivateDirectory(stage)
            report(0.02f)
            createOwned(payload, owned).use { channel ->
                val digest = MessageDigest.getInstance("SHA-256")
                var total = 0L
                var reported = 0f
                assets.open(PAYLOAD_ASSET).use { input ->
                    val out = Channels.newOutputStream(channel)
                    val buffer = ByteArray(BUFFER_BYTES)
                    while (true) {
                        cancelled()
                        val n = input.read(buffer)
                        if (n < 0) break
                        total += n
                        if (total > m.payloadSize) refuse("payload 超出清单长度")
                        digest.update(buffer, 0, n)
                        out.write(buffer, 0, n)
                        val frac = 0.02f + 0.08f * (total.toDouble() / m.payloadSize.coerceAtLeast(1L)).toFloat()
                        if (frac - reported >= 0.01f) { reported = frac; report(frac) }
                    }
                    if (total != m.payloadSize || hex(digest.digest()) != m.payloadSha) refuse("payload 大小或 SHA-256 校验失败")
                    out.flush()
                    channel.force(true)
                }
            }
            scope.checkPrivateDirectory(stage)
            if (readContent(payload, MAX_PAYLOAD_BYTES) != Content(m.payloadSize, m.payloadSha)) refuse("暂存 payload 内容已变化")
            val payloadIdentity = regular(payload)
            report(0.10f)
            FileChannel.open(payload, READ, NOFOLLOW_LINKS).use { channel ->
                val archive = Archive(channel, m.payloadSize, files)
                archive.extract(onProgress = { index -> report(0.10f + 0.45f * index / files.size.coerceAtLeast(1)) }) { file ->
                    scope.checkPrivateDirectory(stage)
                    createOwned(staged.getValue(file.path), owned)
                }
            }
            checkUnchanged(payloadIdentity, regular(payload), payload)
            report(0.55f)
            for (file in files) {
                scope.checkPrivateDirectory(stage)
                val path = staged.getValue(file.path)
                if (readContent(path, MAX_FILE_BYTES) != Content(file.size, file.sha!!)) refuse("暂存文件校验失败：${file.path}")
                setMode(path, file.mode)
            }
            if (parseFingerprint(readSmallFile(staged.getValue(HOST_FP), MAX_FINGERPRINT_BYTES)) != m.host) {
                refuse("payload 宿主指纹不是此 APK 的目标指纹")
            }

            // 暂存期间任何一个受管目标发生冲突，都必须在第一次运行时写入前发现。
            report(0.62f)
            val current = inspect(scope, m)
            report(0.70f)
            var committed = 0
            val commitTotal = m.files.size.coerceAtLeast(1)
            for (file in m.files.sortedWith(compareBy<Managed> { commitOrder(it.path) }.thenBy { it.path })) {
                cancelled()
                committed++
                report(0.70f + 0.28f * committed / commitTotal)
                applicableHost(scope, m)
                if (complete(file, current.getValue(file.path))) continue
                if (file.sha == null) {
                    val backup = backupDirectory ?: scope.newPrivateDirectory(".dsh-upgrade-backup-").also { backupDirectory = it }
                    val to = scope.backupTarget(backup, file.path)
                    applicableHost(scope, m)
                    val from = scope.target(file.path)
                    val old = content(scope, file) ?: continue
                    if (old.sha !in file.previous || old.size != file.size) refuse("废弃文件提交前内容已变化：${file.path}")
                    scope.backupTarget(backup, file.path)
                    scope.target(file.path)
                    if (attributes(to) != null) refuse("备份目标已存在，拒绝覆盖：${file.path}")
                    atomicReplace(from, to)
                    backups[file.path] = to.toFile()
                    scope.backupTarget(backup, file.path)
                    if (readContent(to, MAX_FILE_BYTES) != old || content(scope, file) != null) refuse("废弃文件原子备份后校验失败：${file.path}")
                } else {
                    scope.target(file.path, createParents = true)
                    scope.checkPrivateDirectory(stage)
                    val from = staged.getValue(file.path)
                    if (readContent(from, MAX_FILE_BYTES) != Content(file.size, file.sha) || !modeMatches(from, file.mode)) {
                        refuse("提交前暂存文件已变化：${file.path}")
                    }
                    applicableHost(scope, m)
                    scope.checkPrivateDirectory(stage)
                    val to = scope.target(file.path)
                    atomicReplace(from, to)
                    replaced += file.path
                    if (state(scope, file) != State.CURRENT) refuse("原子替换后内容校验失败：${file.path}")
                }
            }
            val after = inspect(scope, m)
            if (hostFingerprint(scope) != m.host || m.files.any { !complete(it, after.getValue(it.path)) }) refuse("最终校验未完成，可安全重试")
            // 提交完成后再清空目录：此时新文件全部就位，剩下的空目录只能是退役留下的。
            val pruned = scope.pruneEmptyDirectories(retiredDirectories(m))
            Result(true, replaced.toList(), backups.toMap(), pruned)
        } finally {
            // 只清理本次创建且身份仍相同的平面暂存文件；永不清理备份或上次遗留目录。
            for ((path, identity) in owned) {
                try {
                    scope.checkPrivateDirectory(stage)
                    val now = attributes(path)
                    if (now != null && sameIdentity(identity, now)) Files.delete(path)
                } catch (_: IOException) { /* 清理失败不掩盖升级异常，也不追踪陌生文件。 */ }
            }
            try { scope.checkPrivateDirectory(stage); Files.delete(stage) } catch (_: IOException) { /* 非空或身份变化则保留。 */ }
        }
    }

    private fun inspect(scope: Scope, m: Manifest): Map<String, State> {
        applicableHost(scope, m)
        return m.files.associate { it.path to state(scope, it) }
    }

    /**
     * 退役文件的全部祖先目录，按路径长度降序（≈ 深度优先）。
     *
     * 顺序是有意的：父目录只有在子目录被删掉之后才可能变空，所以一趟降序扫描就能
     * 把整条链清干净，不需要反复收敛。目录只是「退役路径的祖先」候选，真正的判据
     * 永远是「现在是否真的空了」—— 里面还有任何一个非受管文件就原地保留。
     */
    private fun retiredDirectories(m: Manifest): List<String> {
        val dirs = linkedSetOf<String>()
        for (file in m.files) {
            if (file.sha != null) continue
            var dir = file.path.substringBeforeLast('/', "")
            while (dir.isNotEmpty() && dirs.size < MAX_PRUNED_DIRECTORIES) {
                dirs += dir
                dir = dir.substringBeforeLast('/', "")
            }
        }
        return dirs.sortedByDescending { it.length }
    }

    /** 只允许删 `lib/node_modules/<pkg>` 及其子目录；`lib`、`lib/node_modules`、`@scope` 本身永不触碰。 */
    private fun prunable(relative: String): Boolean {
        val parts = relative.split('/')
        if (parts.size < 3 || parts[0] != "lib" || parts[1] != "node_modules") return false
        return if (parts[2].startsWith('@')) parts.size >= 4 else true
    }

    private fun complete(file: Managed, state: State) = if (file.sha == null) state == State.MISSING else state == State.CURRENT

    private fun state(scope: Scope, file: Managed): State {
        val value = content(scope, file) ?: return State.MISSING
        if (file.sha != null && value.sha == file.sha && value.size == file.size) {
            return if (modeMatches(scope.target(file.path), file.mode)) State.CURRENT else State.PREVIOUS
        }
        if (value.sha in file.previous && (file.sha != null || value.size == file.size)) return State.PREVIOUS
        refuse("用户文件冲突或内容已修改：${file.path}（${value.size} 字节，sha256 ${value.sha.take(12)}）；保留原文件")
    }

    private fun applicableHost(scope: Scope, m: Manifest) {
        val actual = hostFingerprint(scope)
        // 缺失指纹也是受管缺失状态，随后逐条 SHA 预检；非空但陌生的指纹绝不放行。
        if (actual != null && actual != m.baseHost && actual != m.host) {
            throw NotApplicable("未知宿主指纹，不适用此增量升级（${actual.take(16)}）")
        }
    }

    private fun hostFingerprint(scope: Scope): String? {
        val path = scope.target(HOST_FP)
        if (attributes(path) == null) return null
        val value = parseFingerprint(readSmallFile(path, MAX_FINGERPRINT_BYTES)) ?: refuse("宿主指纹格式无效")
        scope.target(HOST_FP)
        return value
    }

    private fun content(scope: Scope, file: Managed): Content? {
        val path = scope.target(file.path)
        val value = if (attributes(path) == null) null else readContent(path, MAX_FILE_BYTES)
        scope.target(file.path)
        return value
    }

    private fun loadManifest(): Manifest? {
        val metadata = try { assets.open(META_ASSET).use { bounded(it, MAX_META_BYTES) } } catch (_: FileNotFoundException) { return null }
        val meta = Json(metadata).objectValue()
        if (!meta.containsKey("dshUpgradeManifestSha256") && !meta.containsKey("dshVersion")) return null
        val expectedSha = hash(meta["dshUpgradeManifestSha256"] as? String ?: refuse("DSH metadata 缺少清单 SHA-256"))
        if (meta["dshVersion"] != TO) refuse("DSH metadata 目标版本不支持")
        val host = hash(meta["kxxyHostFingerprint"] as? String ?: refuse("DSH metadata 缺少目标宿主指纹"))
        if (hash(expectedHostFingerprint) != host) refuse("目标宿主指纹与已编译 BuildConfig 不符")
        val bytes = assets.open(MANIFEST_ASSET).use { bounded(it, MAX_MANIFEST_BYTES) }
        if (sha(bytes) != expectedSha) refuse("manifest SHA-256 与可信 APK metadata 不符")
        val text = utf8(bytes)
        if (!text.endsWith('\n') || '\r' in text) refuse("manifest 必须使用 UTF-8、LF 且以单个换行结尾")
        val lines = text.dropLast(1).lineSequence().iterator()
        fun next(): String = if (lines.hasNext()) lines.next() else refuse("manifest 截断")
        fun header(name: String): String {
            val fields = next().split('\t')
            if (fields.size != 2 || fields[0] != name) refuse("manifest 头缺失、重复或顺序错误：$name")
            return fields[1]
        }
        if (next() != "kxxy-dsh-upgrade@1" || header("from") != FROM || header("to") != TO) refuse("manifest schema 或升级版本不支持")
        val base = hash(header("base-host"))
        if (hash(header("host")) != host) refuse("manifest 目标宿主与 metadata 不符")
        val payloadSha = hash(header("payload-sha256"))
        val payloadSize = decimal(header("payload-size"))
        if (payloadSize !in 22L..MAX_PAYLOAD_BYTES) refuse("payload 大小超出上限")
        val files = arrayListOf<Managed>()
        val paths = hashSetOf<String>()
        val spellings = hashMapOf<String, String>()
        var total = 0L
        while (lines.hasNext()) {
            cancelled()
            if (files.size >= MAX_FILES) refuse("manifest 记录数超出上限")
            val fields = next().split('\t')
            if (fields.size != 6 || fields[0] !in setOf("file", "delete")) refuse("manifest 记录必须恰好六列，不允许尾部垃圾")
            val path = fields[1]
            validatePath(path)
            if (!paths.add(path.lowercase(Locale.ROOT))) refuse("manifest 路径重复：$path")
            var prefix = ""
            for (part in path.split('/')) {
                prefix = if (prefix.isEmpty()) part else "$prefix/$part"
                val key = prefix.lowercase(Locale.ROOT)
                val old = spellings.putIfAbsent(key, prefix)
                if (old != null && old != prefix) refuse("manifest 路径存在大小写别名：$path")
            }
            val size = decimal(fields[2])
            if (size !in 0L..MAX_FILE_BYTES) refuse("单文件大小超出上限：$path")
            val mode = when (fields[3]) { "420" -> 420; "493" -> 493; else -> refuse("非法文件 mode：$path") }
            val target = if (fields[0] == "file") hash(fields[4]) else {
                if (fields[4] != "-") refuse("delete 记录不允许目标 SHA：$path")
                null
            }
            val previous = if (fields[5] == "-") emptySet() else fields[5].split(',').map(::hash).let {
                if (it.toSet().size != it.size) refuse("previous SHA 重复：$path")
                it.toSet()
            }
            if (target == null && previous.isEmpty()) refuse("delete 必须列出已发布旧 SHA：$path")
            if (target != null) total += size
            if (total > MAX_TOTAL_BYTES) refuse("总解压大小超出上限")
            if (path == HOST_FP && size > MAX_FINGERPRINT_BYTES) refuse("宿主指纹文件过大")
            files += Managed(path, size, mode, target, previous)
        }
        for (file in files) {
            var parent = file.path.substringBeforeLast('/', "")
            while (parent.isNotEmpty()) {
                if (parent.lowercase(Locale.ROOT) in paths) refuse("manifest 文件与父目录重叠：${file.path}")
                parent = parent.substringBeforeLast('/', "")
            }
        }
        if (listOf(RUNTIME_MANIFEST, HOST_FP).any { required -> files.none { it.path == required && it.sha != null } }) {
            refuse("manifest 必须包含根清单及目标宿主指纹文件")
        }
        if (base != host && files.single { it.path == HOST_FP }.previous.isEmpty()) refuse("跨宿主升级必须声明指纹文件的已发布旧 SHA")
        return Manifest(base, host, payloadSha, payloadSize, files)
    }

    private fun validatePath(path: String) {
        val parts = path.split('/')
        if (path.length !in 1..1024 || parts.any { it.length !in 1..255 || it == "." || it == ".." || it.endsWith('.') || !PART.matches(it) }) refuse("非法文件路径：$path")
        if (parts.any { DEVICE.matches(it.substringBefore('.').uppercase(Locale.ROOT)) }) refuse("保留设备路径：$path")
        if (path == RUNTIME_MANIFEST) return
        if (parts.size < 4 || parts[0] != "lib" || parts[1] != "node_modules") refuse("路径不在 DSH 包文件白名单：$path")
        val pkg = parts[2]
        if (pkg.startsWith('@')) {
            if (parts.size < 5 || !PACKAGE.matches(pkg.drop(1)) || !PACKAGE.matches(parts[3])) refuse("非法 scoped package 路径：$path")
        } else if (!PACKAGE.matches(pkg)) refuse("非法 package 路径：$path")
    }

    /** 固定私有边界及所有曾访问父目录的身份，不 canonicalize 运行时子路径。 */
    private inner class Scope(root: File) {
        private val boundary = linkedMapOf<Path, BasicFileAttributes>()
        private val parents = linkedMapOf<Path, BasicFileAttributes>()
        private val privateDirs = linkedMapOf<Path, BasicFileAttributes>()
        val base: Path
        private val engine: Path

        init {
            val rawBase = privateDirectory.toPath().toAbsolutePath()
            val rawRoot = root.toPath().toAbsolutePath()
            if (rawBase != rawBase.normalize() || rawRoot != rawRoot.normalize() || rawRoot.parent != rawBase) refuse("运行时不在预期 app 私有目录内")
            var part: Path? = rawBase
            while (part != null) {
                val p = part
                val a = attributes(p) ?: refuse("私有父目录缺失：$p")
                if (a.isSymbolicLink) {
                    // 仅允许 Android 根用户拥有的系统路径别名，拒绝 app 自己的链接边界。
                    val uid = try { (Files.getAttribute(p, "unix:uid", NOFOLLOW_LINKS) as? Number)?.toInt() } catch (_: Exception) { null }
                    if (p == rawBase || uid != 0) refuse("拒绝符号链接父目录：$p")
                } else if (!a.isDirectory) refuse("私有父链不是目录：$p")
                boundary[p] = a
                part = p.parent
            }
            base = rawBase.toRealPath()
            engine = base.resolve(rawRoot.fileName)
            checkBoundary()
            directory(engine)
        }

        private fun checkBoundary() {
            for ((path, old) in boundary) {
                val now = attributes(path) ?: refuse("私有父目录消失：$path")
                if (!sameIdentity(old, now)) refuse("私有父目录已替换：$path")
            }
        }

        private fun directory(path: Path): Boolean {
            val a = attributes(path)
            if (a == null) {
                if (parents.containsKey(path)) refuse("已固定的父目录消失：$path")
                return false
            }
            if (!a.isDirectory || a.isSymbolicLink) refuse("拒绝符号链接或非常规父目录：$path")
            val old = parents[path]
            if (old != null && !sameIdentity(old, a)) refuse("升级期间父目录已替换：$path")
            parents[path] = a
            return true
        }

        fun isEmpty(): Boolean {
            checkBoundary()
            if (!directory(engine)) return true
            val empty = Files.newDirectoryStream(engine).use { !it.iterator().hasNext() }
            checkBoundary()
            directory(engine)
            return empty
        }

        fun isFreshRoot(): Boolean {
            checkBoundary()
            if (!directory(engine)) return true
            val metadataFiles = setOf("kxxy-state.json", "install-error.json", "native-boot-failure.json")
            val bridgeDirs = setOf("shz", "tapi")
            val fresh = Files.newDirectoryStream(engine).use { entries ->
                entries.all { path ->
                    val a = attributes(path) ?: refuse("首次安装探测期间条目消失：$path")
                    when (path.fileName.toString()) {
                        in metadataFiles -> a.isRegularFile && !a.isSymbolicLink
                        in bridgeDirs -> directory(path) && Files.newDirectoryStream(path).use { children ->
                            val names = if (path.fileName.toString() == "shz") setOf("why", "capable") else setOf("capable")
                            children.all { child ->
                                val value = attributes(child) ?: refuse("首次安装探测期间桥文件消失：$child")
                                child.fileName.toString() in names && value.isRegularFile && !value.isSymbolicLink
                            }
                        }
                        else -> false
                    }
                }
            }
            checkBoundary()
            directory(engine)
            return fresh
        }

        fun target(relative: String, createParents: Boolean = false): Path {
            checkBoundary()
            if (!directory(engine)) refuse("运行时根目录不存在")
            return child(engine, relative, createParents)
        }

        private fun child(root: Path, relative: String, createParents: Boolean): Path {
            val target = root.resolve(relative).normalize()
            if (!target.startsWith(root) || target == root) refuse("目标路径逃逸")
            var current = root
            for (name in root.relativize(target.parent)) {
                current = current.resolve(name)
                if (!directory(current) && createParents) {
                    createDirectory(current, 493)
                    if (!directory(current)) refuse("无法创建受管父目录")
                }
            }
            val a = attributes(target)
            if (a != null && (!a.isRegularFile || a.isSymbolicLink)) refuse("拒绝符号链接或非常规目标：$relative")
            return target
        }

        fun newPrivateDirectory(prefix: String): Path {
            checkBoundary()
            val path = base.resolve(prefix + UUID.randomUUID())
            createDirectory(path, 448)
            privateDirs[path] = attributes(path) ?: refuse("私有目录创建失败")
            checkPrivateDirectory(path)
            return path
        }

        fun checkPrivateDirectory(path: Path) {
            checkBoundary()
            val now = attributes(path) ?: refuse("私有暂存/备份目录消失")
            if (!now.isDirectory || now.isSymbolicLink || !sameIdentity(privateDirs.getValue(path), now)) refuse("私有暂存/备份父目录已替换")
        }

        fun backupTarget(backup: Path, relative: String): Path {
            checkPrivateDirectory(backup)
            return child(backup, relative, createParents = true)
        }

        /**
         * 删除退役后变空的目录，返回实际删除个数。
         *
         * 为什么非删不可：0.2.2 把嵌套依赖整体提升到 `lib/node_modules` 顶层，旧树里
         * `pkg/node_modules/<dep>/` 的文件全部进了退役清单，只搬走文件会留下空目录。
         * Node 的 ESM 解析会把「存在、但没有 package.json 也没有 index.js」的目录当成
         * 包目录，`legacyMainResolve` 直接失败：
         * `Cannot find package '…/dsh-host-webserver/node_modules/negotiator/index.js'`，
         * 于是 webserver / web-app / working-directory / mcp-manager 全部 import 失败，
         * 引擎 exit 1（真机报告 kxxy-rescue-1794587746278 就是这个形状）。
         *
         * 边界：只删空目录、只在受管包路径内、绝不跟随符号链接；任何异常都只放弃这一个
         * 目录（目录里可能刚出现用户文件），绝不让清理失败反过来弄坏升级结果。
         */
        fun pruneEmptyDirectories(candidates: List<String>): Int {
            var pruned = 0
            for (relative in candidates) {
                if (pruned >= MAX_PRUNED_DIRECTORIES) break
                if (!prunable(relative)) continue
                val path = engine.resolve(relative).normalize()
                if (path == engine || !path.startsWith(engine)) continue
                // 健康设备上绝大多数候选目录早就不在了：先 stat 再谈边界校验，否则每次启动
                // 都要为两三千个不存在的目录白跑五层父链校验（这是启动关键路径）。
                val before = attributes(path) ?: continue
                if (!before.isDirectory || before.isSymbolicLink) continue
                checkBoundary()
                if (removeIfEmpty(path, before)) pruned++
            }
            return pruned
        }

        private fun removeIfEmpty(path: Path, expected: BasicFileAttributes): Boolean {
            val now = attributes(path) ?: return false
            if (!sameIdentity(expected, now) || !now.isDirectory || now.isSymbolicLink) return false
            // 逐级确认父目录都是真实目录：中间任何一层被换成链接，都不能顺着它删到外面去。
            var current = engine
            for (name in engine.relativize(path).parent) {
                current = current.resolve(name)
                val parent = attributes(current) ?: return false
                if (!parent.isDirectory || parent.isSymbolicLink) return false
            }
            val empty = try {
                Files.newDirectoryStream(path).use { !it.iterator().hasNext() }
            } catch (_: IOException) {
                return false
            }
            if (!empty) return false
            return try {
                Files.delete(path)
                // 已删掉的目录不能继续留在「已固定父目录」表里，否则后续 target() 会误判为被替换。
                parents.remove(path)
                true
            } catch (_: IOException) {
                false
            }
        }
    }

    /** 自行读取有界中央目录，避免依赖 Android 上缺少 Unix mode 的 ZipFile API 或反射。 */
    private inner class Archive(private val channel: FileChannel, private val length: Long, files: List<Managed>) {
        private val entries: List<ArchiveEntry>
        init {
            val tailStart = maxOf(0L, length - 65557)
            val tail = bytes(tailStart, (length - tailStart).toInt())
            val last = (tail.size - 22 downTo 0).firstOrNull {
                u32(tail, it) == 0x06054b50L && it + 22 + u16(tail, it + 20) == tail.size
            } ?: refuse("ZIP 缺少有效中央目录结束记录")
            val end = tailStart + last
            if (u16(tail, last + 4) != 0 || u16(tail, last + 6) != 0 || u16(tail, last + 8) != files.size || u16(tail, last + 10) != files.size) refuse("ZIP 多卷或条目数不匹配")
            val central = u32(tail, last + 16)
            val centralSize = u32(tail, last + 12)
            if (central + centralSize != end || central >= length) refuse("ZIP 中央目录范围不正确")
            var at = central
            val byName = files.associateBy { it.path }
            val seen = hashSetOf<String>()
            val parsed = arrayListOf<ArchiveEntry>()
            repeat(files.size) {
                cancelled()
                val head = bytes(at, 46)
                if (u32(head, 0) != 0x02014b50L) refuse("ZIP 中央目录记录无效")
                val flags = u16(head, 8)
                val method = u16(head, 10)
                val crc = u32(head, 16)
                val compressed = u32(head, 20)
                val size = u32(head, 24)
                val nameLength = u16(head, 28)
                val extraLength = u16(head, 30)
                val commentLength = u16(head, 32)
                if (nameLength !in 1..1024) refuse("ZIP 文件名长度非法")
                val name = utf8(bytes(at + 46, nameLength))
                val file = byName[name] ?: refuse("ZIP 含清单外条目：$name")
                if (!seen.add(name)) refuse("ZIP 重复条目：$name")
                val external = u32(head, 38)
                val mode = (external ushr 16).toInt()
                if (u16(head, 4) ushr 8 !in setOf(3, 19) || mode and 61440 != 32768 || mode and 4095 != file.mode || external and 16L != 0L) refuse("ZIP 条目不是约定的普通文件/mode：$name")
                if (u16(head, 6) !in 10..20 || flags and 0xf7f7 != 0 || method !in setOf(0, 8) || size != file.size || compressed > length || u16(head, 34) != 0) refuse("ZIP 方法、标记或大小无效：$name")
                checkExtra(bytes(at + 46 + nameLength, extraLength))
                if (utf8(bytes(at + 46 + nameLength + extraLength, commentLength)).startsWith("LINK:")) refuse("ZIP 禁止 LINK 条目：$name")
                val offset = u32(head, 42)
                if (offset >= central) refuse("ZIP 本地记录范围错误：$name")
                val local = bytes(offset, 30)
                val localName = u16(local, 26)
                val localExtra = u16(local, 28)
                if (u32(local, 0) != 0x04034b50L || u16(local, 4) != u16(head, 6) || u16(local, 6) != flags || u16(local, 8) != method || localName != nameLength || utf8(bytes(offset + 30, localName)) != name) refuse("ZIP 本地/中央记录不一致：$name")
                checkExtra(bytes(offset + 30 + localName, localExtra))
                var next = offset + 30 + localName + localExtra + compressed
                if (flags and 8 != 0) {
                    if (method != 8 || u32(local, 14) != 0L || u32(local, 18) != 0L || u32(local, 22) != 0L) refuse("ZIP descriptor 本地记录无效：$name")
                    if (u32(bytes(next, 4), 0) == 0x08074b50L) next += 4
                    val descriptor = bytes(next, 12)
                    if (u32(descriptor, 0) != crc || u32(descriptor, 4) != compressed || u32(descriptor, 8) != size) refuse("ZIP descriptor 不一致：$name")
                    next += 12
                } else if (u32(local, 14) != crc || u32(local, 18) != compressed || u32(local, 22) != size) refuse("ZIP 本地大小/CRC 不一致：$name")
                if (next > central || (method == 0 && compressed != size)) refuse("ZIP 数据范围无效：$name")
                parsed += ArchiveEntry(file, offset, next, compressed, crc, method)
                at += 46 + nameLength + extraLength + commentLength
                if (at > end) refuse("ZIP 中央目录越界")
            }
            if (at != end) refuse("ZIP 中央目录含多余或缺失记录")
            entries = parsed.sortedBy { it.offset }
            var offset = 0L
            for (entry in entries) {
                if (entry.offset != offset) refuse("ZIP 含未声明、重叠或间隙记录")
                offset = entry.end
            }
            if (offset != central) refuse("ZIP 含未声明本地数据")
        }

        fun extract(onProgress: (Int) -> Unit = {}, output: (Managed) -> FileChannel) {
            channel.position(0)
            ZipInputStream(BufferedInputStream(Channels.newInputStream(channel), BUFFER_BYTES)).use { zip ->
                val buffer = ByteArray(BUFFER_BYTES)
                entries.forEachIndexed { index, entry ->
                    onProgress(index)
                    cancelled()
                    val actual = zip.nextEntry ?: refuse("ZIP 条目提前结束")
                    if (actual.name != entry.file.path || actual.isDirectory || actual.method != entry.method) refuse("ZIP 本地条目不匹配")
                    val digest = MessageDigest.getInstance("SHA-256")
                    val crc = CRC32()
                    var total = 0L
                    output(entry.file).use { target ->
                        val out = Channels.newOutputStream(target)
                        while (true) {
                            cancelled()
                            val n = zip.read(buffer)
                            if (n < 0) break
                            total += n
                            if (total > entry.file.size) refuse("ZIP 解压大小超出清单：${actual.name}")
                            digest.update(buffer, 0, n)
                            crc.update(buffer, 0, n)
                            out.write(buffer, 0, n)
                        }
                        if (total != entry.file.size || hex(digest.digest()) != entry.file.sha || crc.value != entry.crc || actual.crc != entry.crc || actual.compressedSize != entry.compressed) refuse("ZIP SHA/size/CRC 校验失败：${actual.name}")
                        out.flush()
                        // 不再逐文件 fsync：暂存内容在提交前会被重新校验，且崩溃后新建的暂存目录
                        // 与旧目录身份不同、永不复用；每个文件一次 force(true) 会让两万多次
                        // 落盘等待把升级拖成几十分钟（真机表现为「卡在解压 0%」）。
                        // 唯一需要持久化保证的是 payload 本身，那一次 force 仍保留。
                    }
                    zip.closeEntry()
                }
                if (zip.nextEntry != null) refuse("ZIP 含额外本地条目")
            }
        }

        private fun bytes(at: Long, size: Int): ByteArray {
            if (at < 0 || size < 0 || at + size > length) refuse("ZIP 记录越界")
            val buffer = ByteBuffer.allocate(size)
            while (buffer.hasRemaining()) {
                cancelled()
                if (channel.read(buffer, at + buffer.position()) < 0) refuse("ZIP 记录截断")
            }
            return buffer.array()
        }

        private fun checkExtra(extra: ByteArray) {
            var at = 0
            val seen = hashSetOf<Int>()
            while (at < extra.size) {
                if (at + 4 > extra.size) refuse("ZIP extra 截断")
                val tag = u16(extra, at)
                val size = u16(extra, at + 2)
                if (!seen.add(tag) || tag in setOf(1, 0x000d, 0x756e, 0x7075) || at + 4 + size > extra.size) refuse("ZIP 不支持重复、链接、替代路径或 ZIP64 extra")
                at += 4 + size
            }
        }
    }

    private fun readContent(path: Path, limit: Long): Content {
        val before = regular(path)
        if (before.size() > limit) refuse("受管文件超出读取上限/用户冲突：$path")
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        FileChannel.open(path, READ, NOFOLLOW_LINKS).use { channel ->
            val buffer = ByteBuffer.allocate(BUFFER_BYTES)
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
        checkUnchanged(before, after, path)
        if (total != after.size()) refuse("读取期间文件长度变化：$path")
        return Content(total, hex(digest.digest()))
    }

    private fun readSmallFile(path: Path, limit: Int): ByteArray {
        val before = regular(path)
        if (before.size() > limit) refuse("小文件读取超限：$path")
        val bytes = FileChannel.open(path, READ, NOFOLLOW_LINKS).use { bounded(Channels.newInputStream(it), limit) }
        val after = regular(path)
        checkUnchanged(before, after, path)
        if (after.size() != bytes.size.toLong()) refuse("读取期间文件长度变化：$path")
        return bytes
    }

    private fun checkUnchanged(before: BasicFileAttributes, after: BasicFileAttributes, path: Path) {
        if (!sameIdentity(before, after) || before.size() != after.size() || before.lastModifiedTime() != after.lastModifiedTime()) refuse("读取期间文件被替换或修改：$path")
    }
    private fun regular(path: Path): BasicFileAttributes {
        val a = attributes(path) ?: refuse("受管文件消失：$path")
        if (!a.isRegularFile || a.isSymbolicLink) refuse("拒绝非常规文件或符号链接：$path")
        return a
    }
    private fun attributes(path: Path): BasicFileAttributes? = try { Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS) } catch (_: NoSuchFileException) { null }
    private fun sameIdentity(a: BasicFileAttributes, b: BasicFileAttributes): Boolean {
        val identity = if (a.fileKey() != null) a.fileKey() == b.fileKey() else windows && a.creationTime() == b.creationTime()
        return identity && a.isDirectory == b.isDirectory && a.isSymbolicLink == b.isSymbolicLink && a.isRegularFile == b.isRegularFile
    }
    private fun permission(mode: Int) = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString(when (mode) { 448 -> "rwx------"; 493 -> "rwxr-xr-x"; 420 -> "rw-r--r--"; else -> "rw-------" }))
    private fun createDirectory(path: Path, mode: Int) {
        if (windows) Files.createDirectory(path) else Files.createDirectory(path, permission(mode))
    }
    private fun createOwned(path: Path, owned: MutableMap<Path, BasicFileAttributes>): FileChannel {
        val channel = if (windows) FileChannel.open(path, CREATE_NEW, WRITE, NOFOLLOW_LINKS) else FileChannel.open(path, setOf(CREATE_NEW, WRITE, NOFOLLOW_LINKS), permission(384))
        try { owned[path] = regular(path) } catch (e: Exception) { channel.close(); throw e }
        return channel
    }
    private fun setMode(path: Path, mode: Int) { if (!windows) Files.setPosixFilePermissions(path, permission(mode).value()) }
    private fun modeMatches(path: Path, mode: Int): Boolean = windows || Files.getPosixFilePermissions(path, NOFOLLOW_LINKS) == permission(mode).value()
    private fun commitOrder(path: String) = when (path) { RUNTIME_MANIFEST -> 1; HOST_FP -> 2; else -> 0 }

    /**
     * 进度节流：只在变化达到 0.5% 时上报，避免两万多次跨线程回调拖慢写入。
     * 回调异常绝不影响升级结果 —— 界面崩了不该让安装失败。
     */
    private fun progress(sink: (Float) -> Unit): (Float) -> Unit {
        var lastBucket = -1
        return { value ->
            val clamped = value.coerceIn(0f, 1f)
            val bucket = (clamped * 200f).toInt()
            if (bucket != lastBucket) {
                lastBucket = bucket
                runCatching { sink(bucket / 200f) }
            }
        }
    }
    private inline fun <T> guarded(block: () -> T): T = try { cancelled(); block() } catch (e: InterruptedException) { Thread.currentThread().interrupt(); throw e } catch (e: Refused) { throw e } catch (e: Exception) { throw Refused(e.message ?: e.javaClass.simpleName, e) }

    /** metadata 使用严格 JSON 语法，拒绝重复字段、类型转换及尾部内容。 */
    private class Json(bytes: ByteArray) {
        private val text = utf8(bytes)
        private var at = 0
        private var nodes = 0
        fun objectValue(): Map<*, *> {
            val result = value(0) as? Map<*, *> ?: refuse("metadata 必须为 JSON 对象")
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
                    if (!take('}')) while (true) {
                        space()
                        val key = string()
                        if (result.containsKey(key)) refuse("JSON 重复字段：$key")
                        space(); expect(':'); result[key] = value(depth + 1); space()
                        if (take('}')) break
                        expect(',')
                    }
                    result
                }
                '[' -> {
                    at++; space()
                    val result = arrayListOf<Any?>()
                    if (!take(']')) while (true) { result += value(depth + 1); space(); if (take(']')) break; expect(',') }
                    result
                }
                '"' -> string()
                't' -> { literal("true"); true }
                'f' -> { literal("false"); false }
                'n' -> { literal("null"); null }
                else -> { number(); Unit }
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
                out.append(when (val escaped = text[at++]) {
                    '"', '\\', '/' -> escaped
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
        private fun number() {
            take('-')
            if (!take('0')) { if (at >= text.length || text[at] !in '1'..'9') refuse("JSON 数字无效"); while (at < text.length && text[at] in '0'..'9') at++ }
            if (take('.')) { val start = at; while (at < text.length && text[at] in '0'..'9') at++; if (start == at) refuse("JSON 小数无效") }
            if (at < text.length && text[at] in "eE") { at++; if (at < text.length && text[at] in "+-") at++; val start = at; while (at < text.length && text[at] in '0'..'9') at++; if (start == at) refuse("JSON 指数无效") }
        }
        private fun literal(word: String) { if (!text.startsWith(word, at)) refuse("JSON 字面量无效"); at += word.length }
        private fun space() { while (at < text.length && text[at] in " \r\n\t") at++ }
        private fun take(c: Char): Boolean = if (at < text.length && text[at] == c) { at++; true } else false
        private fun expect(c: Char) { if (!take(c)) refuse("JSON 语法错误（位置 $at）") }
    }

    companion object {
        private const val FROM = "0.2.1-rc.5"
        private const val TO = "0.2.2-rc.2"
        private const val META_ASSET = "meta/build.json"
        private const val MANIFEST_ASSET = "dsh-upgrade/manifest.tsv"
        private const val PAYLOAD_ASSET = "dsh-upgrade/payload.zip"
        private const val RUNTIME_MANIFEST = "kxxy-runtime.json"
        private const val HOST_FP = "lib/node_modules/kxxy-host/lib/.fingerprint"
        private const val MAX_META_BYTES = 128 * 1024
        private const val MAX_MANIFEST_BYTES = 16 * 1024 * 1024
        private const val MAX_PAYLOAD_BYTES = 512L * 1024 * 1024
        private const val MAX_FILE_BYTES = 128L * 1024 * 1024
        private const val MAX_TOTAL_BYTES = 1024L * 1024 * 1024
        private const val MAX_FILES = 40000
        private const val MAX_PRUNED_DIRECTORIES = 8192
        private const val MAX_FINGERPRINT_BYTES = 4096
        private const val BUFFER_BYTES = 64 * 1024
        private val HASH = Regex("[0-9a-f]{64}")
        private val DECIMAL = Regex("0|[1-9][0-9]*")
        private val PART = Regex("[A-Za-z0-9_+@.\\-]+")
        private val PACKAGE = Regex("[A-Za-z0-9][A-Za-z0-9_.\\-]*")
        private val DEVICE = Regex("CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]")
        private fun refuse(message: String): Nothing = throw Refused(message)
        private fun cancelled() { if (Thread.currentThread().isInterrupted) throw InterruptedException("DSH 升级已取消") }
        private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
        private fun sha(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
        private fun hash(text: String): String = text.lowercase(Locale.ROOT).also { if (!HASH.matches(it)) refuse("SHA-256 必须为 64 位十六进制") }
        private fun decimal(text: String): Long { if (!DECIMAL.matches(text)) refuse("大小必须为规范非负十进制整数"); return text.toLongOrNull() ?: refuse("大小整数溢出") }
        private fun parseFingerprint(bytes: ByteArray): String? = utf8(bytes).lineSequence().filter { it.startsWith("fingerprint:") }.map { it.removePrefix("fingerprint:").trim().lowercase(Locale.ROOT) }.toList().singleOrNull()?.takeIf { HASH.matches(it) }
        private fun utf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        private fun u16(bytes: ByteArray, at: Int): Int = (bytes[at].toInt() and 255) or ((bytes[at + 1].toInt() and 255) shl 8)
        private fun u32(bytes: ByteArray, at: Int): Long = u16(bytes, at).toLong() or (u16(bytes, at + 2).toLong() shl 16)
        private fun bounded(input: InputStream, limit: Int): ByteArray {
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) { cancelled(); val n = input.read(buffer); if (n < 0) break; if (out.size().toLong() + n > limit) refuse("输入超出读取上限"); out.write(buffer, 0, n) }
            return out.toByteArray()
        }
    }
}
