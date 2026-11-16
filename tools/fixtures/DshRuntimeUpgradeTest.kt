package app.kxxy.engine

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.lang.management.ManagementFactory
import java.nio.file.FileSystemException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

// 合同来自 DshRuntimeUpgrade.kt；包根来自 upgrade-dsh-runtime.mjs，入口来自 EngineConfig.kt。
// fixture-new/fixture-retired 是合成测试文件，不宣称是发布包中的实际增删项。
private const val FROM = "0.2.1-rc.5"
private const val TO = "0.2.2-rc.2"
private const val META = "meta/build.json"
private const val MANIFEST = "dsh-upgrade/manifest.tsv"
private const val PAYLOAD = "dsh-upgrade/payload.zip"
private const val RUNTIME = "kxxy-runtime.json"
private const val NM = "lib/node_modules/"
private const val DSH = NM + "@deepseek-ai/dsh/"
private const val ENTRY = DSH + "lib/bin.js"
private const val NEW_FILE = DSH + "fixture-new/deep/feature.js"
private const val RETIRED = DSH + "fixture-retired/legacy.js"
// 旧版嵌套依赖（0.2.2 起被提升到顶层），退役后必须把整条空目录链一起删掉。
private const val NESTED = DSH + "fixture-nested/node_modules/stub"
private const val FP = NM + "kxxy-host/lib/.fingerprint"
private val BASE = "a".repeat(64)
private val TARGET = "b".repeat(64)
private val OTHER = "c".repeat(64)
private val WINDOWS = System.getProperty("os.name").startsWith("Windows")
private fun bytes(text: String) = text.toByteArray(Charsets.UTF_8)
private fun sha(value: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value)
    val hex = "0123456789abcdef"
    return String(CharArray(digest.size * 2) { index ->
        val n = digest[index / 2].toInt() and 255
        hex[if (index % 2 == 0) n ushr 4 else n and 15]
    })
}
private fun fingerprint(host: String) = "kxxy-host-fingerprint@1\nfingerprint: $host\n"

private data class Record(val path: String, val old: String?, val target: String?, val mode: Int = 420) {
    fun row() = mutableListOf(if (target == null) "delete" else "file", path, bytes(target ?: old!!).size.toString(),
        mode.toString(), target?.let { sha(bytes(it)) } ?: "-", old?.let { sha(bytes(it)) } ?: "-")
}
private val RECORDS = (listOf("dsh", "dsh-base", "dsh-web-app").map { name ->
    Record("${NM}@deepseek-ai/$name/package.json", "{\"name\":\"@deepseek-ai/$name\",\"version\":\"$FROM\"}\n",
        "{\"name\":\"@deepseek-ai/$name\",\"version\":\"$TO\"}\n")
} + listOf(
    Record(ENTRY, "#!/usr/bin/env node\n// DSH $FROM\n", "#!/usr/bin/env node\n// DSH $TO\n", 493),
    Record(NEW_FILE, null, "// 新增且父目录缺失的测试文件\n".repeat(8)),
    Record(RETIRED, "// 仅允许原子备份的旧版夹具\n", null),
    // 复刻真实形态：0.2.2 把嵌套依赖提升到顶层，旧 `pkg/node_modules/<dep>/` 整棵退役，
    // 只搬文件会留下空目录，Node 会把它当成「存在但坏掉的包」。
    Record("${NM}@deepseek-ai/dsh/fixture-nested/node_modules/stub/index.js", "// 旧版嵌套依赖\n", null),
    Record("${NM}@deepseek-ai/dsh-base/fixture-retired/other.js", "// 第二个废弃文件\n", null),
    Record("${NM}kxxy-host/patchset.version", "kxxy-patchset@24\n", "kxxy-patchset@25\n"),
    Record(RUNTIME, "{\"schemaVersion\":2,\"plugins\":{\"hostFingerprint\":\"$BASE\"}}\n",
        "{\"schemaVersion\":2,\"plugins\":{\"hostFingerprint\":\"$TARGET\"}}\n"),
    Record(FP, fingerprint(BASE), fingerprint(TARGET)),
)).sortedBy { it.path }
private val TARGETS = RECORDS.filter { it.target != null }
private val RETIRED_FILES = RECORDS.filter { it.target == null }
private val COMMIT_ORDER = RECORDS.filter { it.path != RUNTIME && it.path != FP }.map { it.path }.sorted() + listOf(RUNTIME, FP)
private val MANAGED_PATHS = RECORDS.map { it.path }.toSet()

private data class Member(val name: String, val data: ByteArray, val mode: Int = 420, val comment: String = "", val extra: ByteArray? = null)
private val MEMBERS = TARGETS.map { Member(it.path, bytes(it.target!!), it.mode) }
private fun u16(b: ByteArray, at: Int) = (b[at].toInt() and 255) or ((b[at + 1].toInt() and 255) shl 8)
private fun u32(b: ByteArray, at: Int) = u16(b, at).toLong() or (u16(b, at + 2).toLong() shl 16)
private fun put16(b: ByteArray, at: Int, value: Int) { repeat(2) { b[at + it] = (value ushr (8 * it)).toByte() } }
private fun put32(b: ByteArray, at: Int, value: Long) { repeat(4) { b[at + it] = (value ushr (8 * it)).toByte() } }
private fun centralPositions(b: ByteArray): List<Int> {
    val end = b.size - 22
    check(u32(b, end) == 0x06054b50L)
    var at = u32(b, end + 16).toInt()
    val result = mutableListOf<Int>()
    repeat(u16(b, end + 10)) {
        check(u32(b, at) == 0x02014b50L)
        result += at
        at += 46 + u16(b, at + 28) + u16(b, at + 30) + u16(b, at + 32)
    }
    check(at == end)
    return result
}
private fun zip(members: List<Member> = MEMBERS, method: Int = ZipEntry.DEFLATED): ByteArray {
    val output = ByteArrayOutputStream()
    ZipOutputStream(output, Charsets.UTF_8).use { zip ->
        for (member in members) {
            val entry = ZipEntry(member.name).apply {
                time = System.currentTimeMillis()
                this.method = method
                comment = member.comment
                member.extra?.let { extra = it }
                if (method == ZipEntry.STORED) {
                    size = member.data.size.toLong()
                    compressedSize = size
                    crc = CRC32().apply { update(member.data) }.value
                }
            }
            zip.putNextEntry(entry)
            zip.write(member.data)
            zip.closeEntry()
        }
    }
    val result = output.toByteArray()
    // java.util.zip 不公开 UNIX external mode；补齐中央目录的 creator OS、S_IFREG 和权限位。
    centralPositions(result).forEachIndexed { index, at ->
        put16(result, at + 4, (3 shl 8) or 20)
        put32(result, at + 38, (0x8000 or members[index].mode).toLong() shl 16)
    }
    return result
}
private val VALID_ZIP by lazy { zip() }
private fun alteredZip(method: Int = ZipEntry.DEFLATED, edit: (ByteArray, Int, Int) -> Unit): ByteArray {
    val b = zip(method = method)
    val central = centralPositions(b).first()
    edit(b, central, u32(b, central + 42).toInt())
    return b
}
private fun renameEntry(b: ByteArray, old: String, name: String) {
    check(bytes(old).size == bytes(name).size)
    val central = centralPositions(b).single { String(b, it + 46, u16(b, it + 28), Charsets.UTF_8) == old }
    val local = u32(b, central + 42).toInt()
    bytes(name).copyInto(b, central + 46)
    bytes(name).copyInto(b, local + 30)
}
private fun descriptor(b: ByteArray, central: Int, local: Int): Int {
    val at = local + 30 + u16(b, local + 26) + u16(b, local + 28) + u32(b, central + 20).toInt()
    return at + if (u32(b, at) == 0x08074b50L) 4 else 0
}

private class MemoryAssets(private val values: Map<String, ByteArray>) : DshRuntimeUpgrade.Assets {
    val opened = mutableListOf<String>()
    var onOpen: (String) -> Unit = {}
    override fun open(name: String): InputStream {
        check(name in setOf(META, MANIFEST, PAYLOAD)) { "不允许读取完整运行时或其它资产：$name" }
        opened += name
        onOpen(name)
        return ByteArrayInputStream(values[name] ?: throw FileNotFoundException(name))
    }
}
private class Fixture {
    var payload = VALID_ZIP.copyOf()
    val headers = linkedMapOf<String, String>()
    val rows = RECORDS.map { it.row() }.toMutableList()
    var manifest: (String) -> String = { it }
    var metadata: (String) -> String? = { it }
    var servedManifest: (ByteArray) -> ByteArray = { it }
    var servedPayload: (ByteArray) -> ByteArray = { it }
    fun row(path: String = ENTRY) = rows.single { it[1] == path }
    fun assets(): MemoryAssets {
        val head = linkedMapOf("from" to FROM, "to" to TO, "base-host" to BASE, "host" to TARGET,
            "payload-sha256" to sha(payload), "payload-size" to payload.size.toString()).apply { putAll(headers) }
        val text = (listOf("kxxy-dsh-upgrade@1") + head.map { "${it.key}\t${it.value}" } + rows.map { it.joinToString("\t") }).joinToString("\n") + "\n"
        val raw = bytes(manifest(text))
        val meta = metadata("{\"dshUpgradeManifestSha256\":\"${sha(raw)}\",\"dshVersion\":\"$TO\",\"kxxyHostFingerprint\":\"$TARGET\"}")
        val values = mutableMapOf(MANIFEST to servedManifest(raw), PAYLOAD to servedPayload(payload))
        if (meta != null) values[META] = bytes(meta)
        return MemoryAssets(values)
    }
}

private fun write(file: File, data: ByteArray, mode: Int = 420) {
    Files.createDirectories(file.parentFile.toPath())
    Files.write(file.toPath(), data)
    if (!WINDOWS) Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString(if (mode == 493) "rwxr-xr-x" else "rw-r--r--"))
}
private fun move(from: Path, to: Path) { Files.move(from, to, ATOMIC_MOVE, REPLACE_EXISTING) }
private data class Box(val area: File, val base: File, val root: File, val outside: File)
private fun helper(box: Box, assets: MemoryAssets = Fixture().assets(), target: String = TARGET,
                   atomic: (Path, Path) -> Unit = ::move, space: (File) -> Long = { it.usableSpace }) =
    DshRuntimeUpgrade(assets, box.base, target, atomic, space)

// 不跟随链接；记录身份、内容、文件时间。严格预检还比较目录 mtime，防止先暂存再假称零写入。
private fun snapshot(root: File, directoryTimes: Boolean = false): Map<String, String> = Files.walk(root.toPath()).use { stream ->
    stream.iterator().asSequence().associate { path ->
        val a = Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
        val name = root.toPath().relativize(path).toString().replace('\\', '/')
        val identity = "${a.fileKey()}:${a.creationTime()}"
        val mode = if (WINDOWS || a.isSymbolicLink) "" else Files.getPosixFilePermissions(path, NOFOLLOW_LINKS).toString()
        name to when {
            a.isSymbolicLink -> "link:$identity:${Files.readSymbolicLink(path)}"
            a.isDirectory -> "dir:$identity:$mode" + if (directoryTimes) ":${a.lastModifiedTime()}" else ""
            else -> "file:$identity:$mode:${a.size()}:${a.lastModifiedTime()}:${sha(Files.readAllBytes(path))}"
        }
    }
}
private fun unmanaged(box: Box) = snapshot(box.root).filterKeys { path ->
    path.isNotEmpty() && path !in MANAGED_PATHS && MANAGED_PATHS.none { it.startsWith("$path/") }
} + snapshot(box.outside, true).mapKeys { "outside/${it.key}" }
private fun stages(box: Box) = box.base.listFiles()!!.filter { it.name.startsWith(".dsh-upgrade-stage-") }
private fun backupDirectories(box: Box) = box.base.listFiles()!!.filter { it.name.startsWith(".dsh-upgrade-backup-") }
private fun checkCurrent(box: Box) {
    for (record in RECORDS) {
        val file = File(box.root, record.path)
        if (record.target == null) check(!Files.exists(file.toPath(), NOFOLLOW_LINKS)) { "废弃文件仍在原位：${record.path}" }
        else {
            check(file.readBytes().contentEquals(bytes(record.target))) { "内容不符：${record.path}" }
            if (!WINDOWS) check(Files.getPosixFilePermissions(file.toPath(), NOFOLLOW_LINKS) ==
                PosixFilePermissions.fromString(if (record.mode == 493) "rwxr-xr-x" else "rw-r--r--")) { "权限不符：${record.path}" }
        }
    }
    check(helper(box).isCurrent(box.root))
}
private fun checkBackups(box: Box) {
    val found = backupDirectories(box).flatMap { directory ->
        Files.walk(directory.toPath()).use { stream -> stream.iterator().asSequence()
            .filter { Files.isRegularFile(it, NOFOLLOW_LINKS) }
            .map { directory.toPath().relativize(it).toString().replace('\\', '/') to it.toFile().readBytes() }.toList() }
    }
    check(found.size == RETIRED_FILES.size) { "备份缺失或重复：${found.map { it.first }}" }
    for (record in RETIRED_FILES) check(found.single { it.first == record.path }.second.contentEquals(bytes(record.old!!))) { record.path }
}
private fun refusal(fragment: String, action: () -> Unit): DshRuntimeUpgrade.Refused {
    try { action() } catch (e: DshRuntimeUpgrade.Refused) {
        check(e.message!!.contains("不会自动清空或重装用户运行时")) { e }
        check(e.message!!.contains(fragment)) { "预期原因包含 '$fragment'，实际为 ${e.message}" }
        return e
    }
    error("应拒绝但执行成功：$fragment")
}
private fun zeroWrite(box: Box, assets: MemoryAssets, reason: String, preflight: Boolean = true,
                      target: String = TARGET, space: (File) -> Long = { it.usableSpace }) {
    val before = snapshot(box.area)
    val runtimeBefore = snapshot(box.root, true)
    val strictBefore = if (preflight) snapshot(box.area, true) else emptyMap()
    var commits = 0
    refusal(reason) { helper(box, assets, target, atomic = { _, _ -> commits++; error("拒绝前不应触达原子提交") }, space = space).upgrade(box.root) }
    check(commits == 0)
    check(snapshot(box.area) == before) { "拒绝改变了文件内容/身份，或留下暂存" }
    check(snapshot(box.root, true) == runtimeBefore) { "拒绝改变了运行时文件或目录" }
    if (preflight) {
        check(PAYLOAD !in assets.opened) { "全量预检失败不应读取 payload" }
        check(snapshot(box.area, true) == strictBefore) { "全量预检不是零写入" }
    }
}
private fun tampered(record: Record, useTarget: Boolean = false): ByteArray = bytes(if (useTarget) record.target!! else record.old ?: record.target!!).also {
    check(it.isNotEmpty())
    // 指纹只改首行，不改 fingerprint: 行；确保经过宿主门禁后仍须逐文件 SHA 预检。
    it[0] = (it[0].toInt() xor 1).toByte()
}
private var passed = 0
private var failed = 0
private var skipped = 0
private var shard = 1
private var shards = 1
private val caseNames = mutableListOf<String>()
private val threadTimes = ManagementFactory.getThreadMXBean()
private class SkippedTest(reason: String) : Exception(reason)
private fun test(name: String, block: () -> Unit) {
    caseNames += name
    val id = caseNames.size
    if ((id - 1) % shards != shard - 1) return
    val start = System.nanoTime()
    val cpuStart = if (threadTimes.isCurrentThreadCpuTimeSupported) threadTimes.currentThreadCpuTime else -1L
    println("START [shard=$shard/$shards case=$id] $name")
    fun report(status: String, detail: String = "") {
        val elapsed = (System.nanoTime() - start) / 1_000_000
        val cpu = if (cpuStart < 0) -1 else (threadTimes.currentThreadCpuTime - cpuStart) / 1_000_000
        println("$status [shard=$shard/$shards case=$id elapsedMs=$elapsed cpuMs=$cpu] $name$detail")
    }
    try { block(); passed++; report("PASS") } catch (e: SkippedTest) {
        skipped++
        report("SKIP", "：${e.message}")
    } catch (e: Exception) {
        failed++
        report("FAIL")
        e.printStackTrace()
    }
}
private fun skip(reason: String): Nothing = throw SkippedTest(reason)

fun main(args: Array<String>) {
    check(args.size == 1 || args.size == 3)
    if (args.size == 3) { shard = args[1].toInt(); shards = args[2].toInt() }
    check(shards in 1..4 && shard in 1..shards)
    val start = System.nanoTime()
    val temp = File(args[0]).absoluteFile
    check(temp.parentFile.name == ".cache" && temp.name.startsWith("test-dsh-upgrade-") && temp.isDirectory)
    val scratch = File(temp, "cases-$shard").apply { check(mkdir()) }
    println("分组 $shard/$shards；PID ${ProcessHandle.current().pid()}；夹具目录 ${scratch.absolutePath}")
    var sequence = 0
    fun fresh(seed: Boolean = true, users: Boolean = true): Box {
        val area = File(scratch, "case-${++sequence}").apply { check(mkdir()) }
        val base = File(area, "private").apply { check(mkdir()) }
        val root = File(base, "engine").apply { check(mkdir()) }
        val outside = File(area, "outside").apply { check(mkdir()) }
        if (seed) RECORDS.forEach { record -> record.old?.let { write(File(root, record.path), bytes(it), record.mode) } }
        if (users) for (name in listOf("bin/node", "bin/python3.14", "lib/python3.14/site-packages/cffi/__init__.py",
            "lib/python3.14/site-packages/user_pkg/data.bin", "venv/lib/python3.14/site-packages/user.py",
            "extensions/custom/data", "${NM}npm/package.json", "${NM}user-global/package.json",
            DSH + "user-notes.txt", DSH + "fixture-retired/user-extra.txt", "home/sessions/keep.json", "kxxy-home/.credentials.yaml")) {
            write(File(root, name), bytes("仅供测试的用户保留文件：$name\n"))
        }
        write(File(outside, "precious"), bytes("测试私有目录之外的合成哨兵，禁止修改\n"))
        return Box(area, base, root, outside)
    }
    fun bad(name: String, reason: String, preflight: Boolean = true, change: Fixture.() -> Unit) = test(name) {
        zeroWrite(fresh(), Fixture().apply(change).assets(), reason, preflight)
    }

    test("合法升级、原子备份、提交顺序及重入；Python/venv/extensions/global npm/外部哨兵不变") {
        val box = fresh()
        val userBefore = unmanaged(box)
        val assets = Fixture().assets()
        val seen = mutableListOf<String>()
        val oldKeys = RETIRED_FILES.associate { it.path to Files.readAttributes(File(box.root, it.path).toPath(), BasicFileAttributes::class.java).fileKey() }
        val upgrade = helper(box, assets, atomic = { from, to ->
            seen += box.root.toPath().relativize(if (from.startsWith(box.root.toPath())) from else to).toString().replace('\\', '/')
            move(from, to)
        })
        check(upgrade.isConfigured() && !upgrade.isCurrent(box.root) && !upgrade.isEmpty(box.root))
        val result = upgrade.upgrade(box.root)
        check(result.supported && result.replaced == COMMIT_ORDER.filter { it !in RETIRED_FILES.map { r -> r.path } }) { result }
        check(seen == COMMIT_ORDER && seen.takeLast(2) == listOf(RUNTIME, FP)) { seen }
        check(result.backups.keys == RETIRED_FILES.map { it.path }.toSet())
        for ((name, file) in result.backups) {
            check(file.toPath().startsWith(box.base.toPath()) && !file.toPath().startsWith(box.root.toPath()))
            check(Files.readAttributes(file.toPath(), BasicFileAttributes::class.java).fileKey() == oldKeys[name]) { "应移动而非复制废弃文件：$name" }
        }
        checkCurrent(box)
        checkBackups(box)
        check(File(box.root, RETIRED).parentFile.isDirectory)
        check(unmanaged(box) == userBefore && stages(box).isEmpty())
        check(assets.opened.count { it == PAYLOAD } == 1)
        // 退役文件搬走后必须连空目录一起删：空的 node_modules/<pkg>/ 会被 Node 当成
        // 「存在但坏掉的包」，正是真机 engine exit 1 的形状（kxxy-rescue-1794587746278）。
        check(result.pruned == 4) { "应清理 4 个退役留下的空目录，实际 ${result.pruned}" }
        check(!Files.exists(File(box.root, "${NM}@deepseek-ai/dsh-base/fixture-retired").toPath(), NOFOLLOW_LINKS)) { "空目录必须删除" }
        check(!Files.exists(File(box.root, NESTED).toPath(), NOFOLLOW_LINKS)) { "嵌套 node_modules 整条链必须删除" }
        check(!Files.exists(File(box.root, NESTED.substringBeforeLast('/')).toPath(), NOFOLLOW_LINKS))
        val before = snapshot(box.area, true)
        val againAssets = Fixture().assets()
        val again = helper(box, againAssets)
        val result2 = again.upgrade(box.root)
        check(result2.supported && result2.replaced.isEmpty() && result2.backups.isEmpty() && again.isCurrent(box.root))
        check(PAYLOAD !in againAssets.opened && snapshot(box.area, true) == before)
    }
    // ── 退役后必须连空目录一起删 ────────────────────────────────────────────────
    // 真机 kxxy-rescue-1794587746278：0.2.2 把嵌套依赖提升到顶层，退役清单把旧
    // `pkg/node_modules/<dep>/` 的文件全搬走，只留下空目录。Node 把「存在但既没有
    // package.json 也没有 index.js」的目录当成包目录，legacyMainResolve 报
    // `Cannot find package '…/negotiator/index.js'`，webserver/web-app/mcp-manager 全挂。
    test("退役后删除空目录，含用户文件的目录与包根一律保留") {
        val box = fresh()
        val result = helper(box).upgrade(box.root)
        check(result.pruned == 4) { "应清理 4 个退役留下的空目录，实际 ${result.pruned}" }
        check(!Files.exists(File(box.root, "${NM}@deepseek-ai/dsh-base/fixture-retired").toPath(), NOFOLLOW_LINKS)) { "空目录必须删除" }
        check(!Files.exists(File(box.root, NESTED).toPath(), NOFOLLOW_LINKS)) { "空的嵌套依赖目录必须删除" }
        check(!Files.exists(File(box.root, NESTED.substringBeforeLast('/')).toPath(), NOFOLLOW_LINKS)) { "空的 node_modules 父目录必须删除" }
        check(File(box.root, RETIRED).parentFile.isDirectory) { "该目录里还有用户文件，不能删" }
        check(File(box.root, DSH + "fixture-retired/user-extra.txt").isFile)
        check(File(box.root, NM).isDirectory && File(box.root, DSH).isDirectory) { "lib/node_modules 与包根绝不能被清理" }
        checkCurrent(box)
        checkBackups(box)
    }
    test("重入快速路径就地清理历史遗留空目录（不读 payload、不重写文件）") {
        val box = fresh()
        helper(box).upgrade(box.root)
        checkCurrent(box)
        val clean = snapshot(box.root)
        // 复刻真机现场：内容已是最新，只剩退役留下的空嵌套依赖目录。
        val stale = File(box.root, NESTED)
        Files.createDirectories(stale.toPath())
        check(helper(box).isCurrent(box.root)) { "空目录不影响内容判定 —— 这正是它被一直漏掉的原因" }
        val assets = Fixture().assets()
        val result = helper(box, assets).upgrade(box.root)
        check(result.supported && result.replaced.isEmpty() && result.backups.isEmpty())
        check(result.pruned == 3) { "应删掉 stub、node_modules 与 fixture-nested 三层，实际 ${result.pruned}" }
        check(!Files.exists(stale.toPath(), NOFOLLOW_LINKS))
        check(PAYLOAD !in assets.opened) { "清理空目录不需要读 payload" }
        check(snapshot(box.root) == clean) { "除空目录外不得改变任何文件或目录" }
    }
    test("残留目录里有非受管文件时原地保留") {
        val box = fresh()
        helper(box).upgrade(box.root)
        val keep = File(box.root, NESTED)
        write(File(keep, "user.txt"), bytes("用户自己放的东西\n"))
        val result = helper(box).upgrade(box.root)
        check(result.pruned == 0) { "非空目录一个都不该删，实际 ${result.pruned}" }
        check(Files.isDirectory(keep.toPath(), NOFOLLOW_LINKS))
        check(File(keep, "user.txt").readBytes().contentEquals(bytes("用户自己放的东西\n")))
    }
    test("Java STORED ZIP 与 DEFLATED+descriptor ZIP 均可合法升级") {
        val stored = zip(method = ZipEntry.STORED)
        check(centralPositions(stored).all { u16(stored, it + 4) ushr 8 == 3 && (u32(stored, it + 38) ushr 16).toInt() and 61440 == 32768 })
        check(centralPositions(VALID_ZIP).all { u16(VALID_ZIP, it + 8) and 8 != 0 })
        val box = fresh()
        helper(box, Fixture().apply { payload = stored }.assets()).upgrade(box.root)
        checkCurrent(box)
    }
    for (legacy in listOf("缺失 metadata", "无升级配置")) test("兼容旧 APK：$legacy") {
        val box = fresh()
        val assets = Fixture().apply { metadata = { if (legacy == "缺失 metadata") null else "{}" } }.assets()
        val before = snapshot(box.area, true)
        val upgrade = helper(box, assets)
        check(!upgrade.isConfigured() && upgrade.isCurrent(box.root))
        val result = upgrade.upgrade(box.root)
        check(!result.supported && result.replaced.isEmpty() && result.backups.isEmpty())
        check(assets.opened == listOf(META) && snapshot(box.area, true) == before)
    }
    test("未知 host 零写入拒绝") {
        val box = fresh()
        write(File(box.root, FP), bytes(fingerprint(OTHER)))
        zeroWrite(box, Fixture().assets(), "未知宿主指纹")
    }
    test("BuildConfig 与 metadata host 不一致零写入拒绝") {
        zeroWrite(fresh(), Fixture().assets(), "已编译 BuildConfig 不符", target = OTHER)
    }
    test("缺失指纹及全部受管文件可补齐，不生成无来源备份") {
        val box = fresh(seed = false)
        val before = unmanaged(box)
        val result = helper(box).upgrade(box.root)
        check(result.replaced.size == TARGETS.size && result.backups.isEmpty())
        checkCurrent(box)
        check(unmanaged(box) == before && stages(box).isEmpty())
    }
    for (record in TARGETS) test("新版本任一受管文件缺失都能单独补齐：${record.path}") {
        val box = fresh()
        helper(box).upgrade(box.root)
        Files.delete(File(box.root, record.path).toPath())
        val before = unmanaged(box)
        check(!helper(box).isCurrent(box.root))
        val result = helper(box).upgrade(box.root)
        check(result.replaced == listOf(record.path) && result.backups.isEmpty()) { result }
        checkCurrent(box)
        checkBackups(box)
        check(unmanaged(box) == before)
    }
    for (record in RECORDS) test("旧态任一同大小用户篡改均全量预检零写入：${record.path}") {
        val box = fresh()
        val changed = tampered(record)
        write(File(box.root, record.path), changed, record.mode)
        check(changed.size == bytes(record.old ?: record.target!!).size)
        zeroWrite(box, Fixture().assets(), "用户文件冲突或内容已修改")
    }
    for (record in TARGETS) test("新指纹不能掩盖同大小篡改：${record.path}") {
        val box = fresh()
        helper(box).upgrade(box.root)
        write(File(box.root, record.path), tampered(record, useTarget = true), record.mode)
        check(!helper(box).isCurrent(box.root))
        zeroWrite(box, Fixture().assets(), "用户文件冲突或内容已修改")
    }
    test("暂存期间的同大小篡改由二次全量预检阻止，首次原子提交尚未发生") {
        val box = fresh()
        val assets = Fixture().assets()
        var expected: Map<String, String>? = null
        var commits = 0
        assets.onOpen = { name -> if (name == PAYLOAD) {
            write(File(box.root, RUNTIME), tampered(RECORDS.single { it.path == RUNTIME }))
            expected = snapshot(box.root, true)
        } }
        refusal("用户文件冲突或内容已修改") { helper(box, assets, atomic = { _, _ -> commits++; error("不应提交") }).upgrade(box.root) }
        check(expected != null && snapshot(box.root, true) == expected && commits == 0 && stages(box).isEmpty())
    }

    bad("metadata 缺少 SHA", "metadata 缺少清单 SHA-256") { metadata = { "{\"dshVersion\":\"$TO\"}" } }
    bad("metadata 非法 SHA 格式", "SHA-256 必须") { metadata = { it.replace(Regex("[0-9a-f]{64}"), "bad") } }
    bad("metadata 错误目标版本", "metadata 目标版本不支持") { metadata = { it.replace(TO, FROM) } }
    bad("metadata 错误 host", "已编译 BuildConfig 不符") { metadata = { it.replace(TARGET, OTHER) } }
    bad("metadata 重复字段", "JSON 重复字段") { metadata = { it.dropLast(1) + ",\"dshVersion\":\"$TO\"}" } }
    bad("metadata 尾部垃圾", "JSON 尾部含额外内容") { metadata = { it + "{}" } }
    bad("metadata 超出读取大小上限", "输入超出读取上限") { metadata = { " ".repeat(128 * 1024 + 1) } }
    bad("manifest 与可信 metadata SHA 不符", "manifest SHA-256") { servedManifest = { it + bytes("\n") } }
    bad("manifest 超出读取大小上限", "输入超出读取上限") { servedManifest = { ByteArray(16 * 1024 * 1024 + 1) { 32 } } }
    bad("manifest schema 错误", "manifest schema 或升级版本不支持") { manifest = { it.replace("kxxy-dsh-upgrade@1", "kxxy-dsh-upgrade@2") } }
    bad("manifest 起始版本错误", "manifest schema 或升级版本不支持") { headers["from"] = "0.0.0" }
    bad("manifest 目标 host 错误", "manifest 目标宿主与 metadata 不符") { headers["host"] = OTHER }
    bad("manifest 头顺序错误", "manifest 头缺失、重复或顺序错误") { manifest = { it.replace("from\t$FROM\nto\t$TO", "to\t$TO\nfrom\t$FROM") } }
    bad("manifest 缺少末尾 LF", "manifest 必须使用") { manifest = { it.dropLast(1) } }
    bad("manifest CRLF", "manifest 必须使用") { manifest = { it.replace("\n", "\r\n") } }
    bad("manifest 额外空行", "manifest 记录必须恰好六列") { manifest = { it + "\n" } }
    bad("manifest 多余列", "manifest 记录必须恰好六列") { row().add("garbage") }
    bad("manifest 非法 mode", "非法文件 mode") { row()[3] = "511" }
    bad("manifest 非法文件 SHA", "SHA-256 必须") { row()[4] = "not-a-hash" }
    bad("manifest 文件大小上限", "单文件大小超出上限") { row()[2] = (128L * 1024 * 1024 + 1).toString() }
    bad("manifest payload 大小上限", "payload 大小超出上限") { headers["payload-size"] = (512L * 1024 * 1024 + 1).toString() }
    bad("manifest 宿主指纹大小上限", "宿主指纹文件过大") { row(FP)[2] = "4097" }
    // 通过真实公开入口验证清单上限；不把解析 40k 条记录冒称为落盘升级 40k 个文件。
    for (count in listOf(40000, 40001)) test("manifest 受管文件记录数边界：$count") {
        val box = fresh()
        val fixture = Fixture().apply {
            val emptySha = sha(byteArrayOf())
            repeat(count - rows.size) { index ->
                rows.add(mutableListOf("file", "${DSH}fixture-count/$index.js", "0", "420", emptySha, "-"))
            }
        }
        check(fixture.rows.size == count)
        val assets = fixture.assets()
        if (count == 40001) zeroWrite(box, assets, "manifest 记录数超出上限")
        else {
            val before = snapshot(box.area, true)
            check(helper(box, assets).isConfigured())
            check(assets.opened == listOf(META, MANIFEST) && snapshot(box.area, true) == before)
        }
    }
    for (total in listOf(1024L * 1024 * 1024, 1024L * 1024 * 1024 + 1)) test("manifest 总解压大小边界：$total") {
        val box = fresh()
        val fixture = Fixture().apply {
            val original = rows.filter { it[0] == "file" }.sumOf { it[2].toLong() }
            val maxFile = 128L * 1024 * 1024
            val emptySha = sha(byteArrayOf())
            repeat(8) { index ->
                val size = if (index < 7) maxFile else total - original - 7 * maxFile
                rows.add(mutableListOf("file", "${DSH}fixture-size/$index.js", size.toString(), "420", emptySha, "-"))
            }
        }
        check(fixture.rows.filter { it[0] == "file" }.sumOf { it[2].toLong() } == total)
        val assets = fixture.assets()
        if (total > 1024L * 1024 * 1024) zeroWrite(box, assets, "总解压大小超出上限")
        else {
            val before = snapshot(box.area, true)
            check(helper(box, assets).isConfigured())
            check(assets.opened == listOf(META, MANIFEST) && snapshot(box.area, true) == before)
        }
    }
    bad("manifest 非规范大小", "大小必须为规范非负十进制整数") { row()[2] = "01" }
    bad("manifest 缺少必需根清单", "manifest 必须包含根清单") { rows.removeAll { it[1] == RUNTIME } }
    bad("manifest 缺少跨 host 旧指纹 SHA", "跨宿主升级必须声明") { row(FP)[5] = "-" }
    bad("manifest delete 无旧 SHA", "delete 必须列出") { row(RETIRED)[5] = "-" }
    bad("manifest 重复 previous SHA", "previous SHA 重复") { row()[5] += "," + row()[5] }
    bad("manifest 重复路径", "manifest 路径重复") { rows.add(row().toMutableList()) }
    bad("manifest 大小写重复路径", "manifest 路径重复") { rows.add(row().toMutableList().apply { this[1] = ENTRY.replace("bin.js", "BIN.js") }) }
    bad("manifest 父目录大小写别名", "manifest 路径存在大小写别名") { rows.add(row().toMutableList().apply { this[1] = "${NM}@deepseek-ai/DSH/fixture-extra.js" }) }
    bad("manifest 文件与父目录重叠", "manifest 文件与父目录重叠") { rows.add(row().toMutableList().apply { this[1] = "$ENTRY/child" }) }
    for ((path, reason) in listOf("../outside" to "非法文件路径", "/absolute" to "非法文件路径", "${DSH}../../outside" to "非法文件路径",
        "${DSH}lib//file.js" to "非法文件路径", "${DSH}lib/./file.js" to "非法文件路径", "${DSH}lib/x\\file.js" to "非法文件路径",
        "${DSH}lib/x:stream" to "非法文件路径", "${DSH}lib/NUL.js" to "保留设备路径", "${DSH}lib/trailing." to "非法文件路径",
        "extensions/precious" to "白名单", "lib/python3.14/site-packages/user.py" to "白名单")) {
        bad("manifest 路径拒绝：$path", reason) { row()[1] = path }
    }
    bad("payload SHA 不符", "payload 大小或 SHA-256 校验失败", false) { headers["payload-sha256"] = OTHER }
    bad("payload 实际短于清单", "payload 大小或 SHA-256 校验失败", false) { servedPayload = { it.copyOf(it.size - 1) } }
    bad("payload 实际长于清单", "payload 超出清单长度", false) { servedPayload = { it + byteArrayOf(0) } }
    bad("payload 中单文件 SHA 不符", "ZIP SHA/size/CRC 校验失败", false) { row()[4] = OTHER }
    bad("payload 中单文件大小不符", "ZIP 方法、标记或大小无效", false) { row()[2] = (row()[2].toLong() + 1).toString() }
    bad("payload 内指纹与目标 host 不符", "payload 宿主指纹不是此 APK 的目标指纹", false) {
        val changed = bytes(fingerprint(OTHER))
        payload = zip(MEMBERS.map { if (it.name == FP) it.copy(data = changed) else it })
        row(FP)[2] = changed.size.toString()
        row(FP)[4] = sha(changed)
    }

    bad("ZIP 缺失条目", "ZIP 多卷或条目数不匹配", false) { payload = zip(MEMBERS.dropLast(1)) }
    bad("ZIP 额外条目", "ZIP 多卷或条目数不匹配", false) { payload = zip(MEMBERS + Member(DSH + "unlisted.js", bytes("extra"))) }
    bad("ZIP 等数量清单外条目", "ZIP 含清单外条目", false) { payload = zip(MEMBERS.mapIndexed { i, m -> if (i == 0) m.copy(name = DSH + "unlisted.js") else m }) }
    bad("ZIP 路径穿越条目", "ZIP 含清单外条目", false) { payload = zip(MEMBERS.mapIndexed { i, m -> if (i == 0) m.copy(name = "../outside/precious") else m }) }
    bad("ZIP 大小写别名条目", "ZIP 含清单外条目", false) { payload = zip(MEMBERS.mapIndexed { i, m -> if (i == 0) m.copy(name = m.name.uppercase()) else m }) }
    bad("ZIP 重复条目", "ZIP 重复条目", false) {
        val first = MEMBERS.first().name
        val alias = first.dropLast(1) + "X"
        payload = zip(MEMBERS.mapIndexed { i, m -> if (i == 1) m.copy(name = alias) else m })
        renameEntry(payload, alias, first)
    }
    bad("ZIP LINK 注释", "ZIP 禁止 LINK 条目", false) { payload = zip(MEMBERS.mapIndexed { i, m -> if (i == 0) m.copy(comment = "LINK:../../outside/precious") else m }) }
    bad("ZIP 链接 extra", "ZIP 不支持重复、链接、替代路径或 ZIP64 extra", false) { payload = zip(MEMBERS.mapIndexed { i, m -> if (i == 0) m.copy(extra = byteArrayOf(13, 0, 0, 0)) else m }) }
    bad("ZIP64 extra 拒绝", "ZIP 不支持重复、链接、替代路径或 ZIP64 extra", false) {
        // ZipOutputStream 会过滤手工传入的 ZIP64 extra，因此先写普通 extra，再改标识。
        payload = zip(MEMBERS.mapIndexed { i, m -> if (i == 0) m.copy(extra = byteArrayOf(0xfe.toByte(), 0xca.toByte(), 0, 0)) else m })
        val central = centralPositions(payload).first()
        val local = u32(payload, central + 42).toInt()
        check(u16(payload, central + 30) == 4 && u16(payload, local + 28) == 4)
        put16(payload, central + 46 + u16(payload, central + 28), 1)
        put16(payload, local + 30 + u16(payload, local + 26), 1)
    }
    bad("ZIP32 拒绝 ZIP64 条目数哨兵", "ZIP 多卷或条目数不匹配", false) {
        put16(payload, payload.size - 22 + 8, 65535)
        put16(payload, payload.size - 22 + 10, 65535)
    }
    for ((offset, label) in listOf(12 to "中央目录大小", 16 to "中央目录偏移")) {
        bad("ZIP32 拒绝 ZIP64 $label 哨兵", "ZIP 中央目录范围不正确", false) { put32(payload, payload.size - 22 + offset, 0xffffffffL) }
    }
    bad("ZIP32 拒绝 ZIP64 所需版本", "ZIP 方法、标记或大小无效", false) {
        payload = alteredZip { b, c, l -> put16(b, c + 6, 45); put16(b, l + 4, 45) }
    }
    for ((label, mode) in listOf("symlink" to 0xa1ff, "目录" to 0x41ed, "FIFO" to 0x11a4, "缺失 UNIX 类型" to 0,
        "权限不匹配" to 0x81ed, "setuid" to 0x89a4)) {
        bad("ZIP 非法 mode：$label", "ZIP 条目不是约定的普通文件/mode", false) { payload = alteredZip { b, c, _ -> put32(b, c + 38, mode.toLong() shl 16) } }
    }
    bad("ZIP creator 不是 UNIX", "ZIP 条目不是约定的普通文件/mode", false) { payload = alteredZip { b, c, _ -> put16(b, c + 4, 20) } }
    bad("ZIP DOS 目录标记", "ZIP 条目不是约定的普通文件/mode", false) { payload = alteredZip { b, c, _ -> put32(b, c + 38, u32(b, c + 38) or 16) } }
    bad("ZIP 加密标记", "ZIP 方法、标记或大小无效", false) { payload = alteredZip { b, c, l -> put16(b, c + 8, u16(b, c + 8) or 1); put16(b, l + 6, u16(b, l + 6) or 1) } }
    bad("ZIP 未支持压缩算法", "ZIP 方法、标记或大小无效", false) { payload = alteredZip { b, c, l -> put16(b, c + 10, 99); put16(b, l + 8, 99) } }
    bad("ZIP 本地文件名不一致", "ZIP 本地/中央记录不一致", false) { payload = alteredZip { b, _, l -> b[l + 30] = 'X'.code.toByte() } }
    bad("ZIP descriptor 本地大小非零", "ZIP descriptor 本地记录无效", false) { payload = alteredZip { b, _, l -> put32(b, l + 22, 1) } }
    bad("ZIP descriptor 大小不一致", "ZIP descriptor 不一致", false) { payload = alteredZip { b, c, l -> val d = descriptor(b, c, l); put32(b, d + 8, u32(b, d + 8) + 1) } }
    bad("ZIP STORED 本地 CRC 不一致", "ZIP 本地大小/CRC 不一致", false) { payload = alteredZip(ZipEntry.STORED) { b, _, l -> put32(b, l + 14, u32(b, l + 14) xor 1) } }
    bad("ZIP STORED 内容 CRC 错误，中央/本地头保持一致", "CRC", false) { payload = alteredZip(ZipEntry.STORED) { b, c, l ->
        val wrong = u32(b, c + 16) xor 1
        put32(b, c + 16, wrong); put32(b, l + 14, wrong)
    } }
    bad("ZIP DEFLATED 内容 CRC 错误，中央/descriptor 保持一致", "CRC", false) { payload = alteredZip { b, c, l ->
        val wrong = u32(b, c + 16) xor 1
        put32(b, c + 16, wrong); put32(b, descriptor(b, c, l), wrong)
    } }
    bad("ZIP 缺少 EOCD", "ZIP 缺少有效中央目录结束记录", false) { payload[payload.size - 22] = 0 }
    bad("ZIP 中央目录记录签名错误", "ZIP 中央目录记录无效", false) { payload = alteredZip { b, c, _ -> b[c] = 0 } }
    bad("ZIP 本地 offset 越界", "ZIP 本地记录范围错误", false) { payload = alteredZip { b, c, _ -> put32(b, c + 42, u32(b, b.size - 22 + 16)) } }

    val needed = VALID_ZIP.size.toLong() + TARGETS.sumOf { bytes(it.target!!).size.toLong() } + 16L * 1024 * 1024
    for (free in listOf(1L, needed - 1)) test("低空间 $free 字节在暂存前零写入拒绝") {
        val box = fresh()
        zeroWrite(box, Fixture().assets(), "私有暂存空间不足", space = { file -> check(file.toPath().toRealPath() == box.base.toPath().toRealPath()); free })
    }
    for (free in listOf(0L, needed)) test("空间探针 ${if (free == 0L) "未知" else "恰好充足"} 时依实际写入完成") {
        val box = fresh()
        helper(box, space = { free }).upgrade(box.root)
        checkCurrent(box)
    }

    for (phase in listOf("前", "后")) for (boundary in 1..COMMIT_ORDER.size) test("原子提交$phase 中断并重试 $boundary/${COMMIT_ORDER.size}：${COMMIT_ORDER[boundary - 1]}") {
        val box = fresh()
        val before = unmanaged(box)
        val completed = mutableListOf<String>()
        var calls = 0
        val injected = IOException("夹具注入：第 $boundary 次提交$phase")
        val error = refusal("夹具注入") { helper(box, atomic = { from, to ->
            if (calls == 0) {
                val stage = stages(box).single()
                val parts = stage.listFiles()!!.filter { it.name.endsWith(".part") }
                check(parts.size == TARGETS.size && parts.map { sha(it.readBytes()) }.sorted() == TARGETS.map { sha(bytes(it.target!!)) }.sorted()) { "首个提交前必须完成全部文件暂存与校验" }
                check(File(stage, "payload.zip").readBytes().contentEquals(VALID_ZIP))
            }
            val name = box.root.toPath().relativize(if (from.startsWith(box.root.toPath())) from else to).toString().replace('\\', '/')
            check(name == COMMIT_ORDER[calls])
            calls++
            if (phase == "前" && calls == boundary) throw injected
            move(from, to)
            completed += name
            if (phase == "后" && calls == boundary) throw injected
        }).upgrade(box.root) }
        check(error.cause === injected && calls == boundary && completed.size == boundary - if (phase == "前") 1 else 0)
        for (record in RECORDS) {
            val expected = if (record.path in completed) record.target else record.old
            val file = File(box.root, record.path)
            if (expected == null) check(!Files.exists(file.toPath(), NOFOLLOW_LINKS)) { "意外出现文件：${record.path}" }
            else check(file.readBytes().contentEquals(bytes(expected))) { "提交撕裂或越界：${record.path}" }
        }
        check(unmanaged(box) == before && stages(box).isEmpty())
        val saved = backupDirectories(box).associateWith { snapshot(it, true) }
        val retryAssets = Fixture().assets()
        helper(box, retryAssets).upgrade(box.root)
        if (completed.size == COMMIT_ORDER.size) check(PAYLOAD !in retryAssets.opened)
        checkCurrent(box)
        checkBackups(box)
        check(unmanaged(box) == before && stages(box).isEmpty())
        for ((directory, state) in saved) check(snapshot(directory, true) == state) { "重试改变已有备份" }
    }
    test("不信任也不清理历史 stage/backup；只清理本次拥有的暂存") {
        val box = fresh()
        val stage = File(box.base, ".dsh-upgrade-stage-user-owned").apply { check(mkdir()) }
        val backup = File(box.base, ".dsh-upgrade-backup-user-owned").apply { check(mkdir()) }
        write(File(stage, "0.part"), bytes("不能信任的历史暂存"))
        write(File(backup, "precious"), bytes("不能清理的历史备份"))
        val a = snapshot(stage, true)
        val b = snapshot(backup, true)
        helper(box).upgrade(box.root)
        checkCurrent(box)
        check(snapshot(stage, true) == a && snapshot(backup, true) == b && stages(box) == listOf(stage))
    }
    test("当前内容仅权限不符时就地恢复合同权限") {
        val box = fresh()
        helper(box).upgrade(box.root)
        val before = snapshot(box.area, true)
        if (!WINDOWS) for (record in TARGETS) {
            Files.setPosixFilePermissions(File(box.root, record.path).toPath(), PosixFilePermissions.fromString("rw-------"))
        }
        check(helper(box).restoreCurrentModes(box.root) && helper(box).isCurrent(box.root))
        check(snapshot(box.area, true) == before && stages(box).isEmpty())
    }
    test("目标内容冲突时权限修复不写入且不冒充完整") {
        val box = fresh()
        helper(box).upgrade(box.root)
        write(File(box.root, ENTRY), bytes("用户修改入口"))
        val before = snapshot(box.area, true)
        check(!helper(box).restoreCurrentModes(box.root))
        check(snapshot(box.area, true) == before)
    }
    test("空根和缺失根只读探测") {
        val box = fresh(seed = false, users = false)
        val before = snapshot(box.area, true)
        check(helper(box).isEmpty(box.root) && snapshot(box.area, true) == before)
        Files.delete(box.root.toPath())
        val missing = snapshot(box.area, true)
        check(helper(box).isEmpty(box.root) && snapshot(box.area, true) == missing)
    }
    test("首次启动的原生状态和桥目录不冒充存量运行时") {
        val box = fresh(seed = false, users = false)
        check(helper(box).isFreshRoot(box.root))
        for (name in listOf("kxxy-state.json", "install-error.json", "native-boot-failure.json")) {
            write(File(box.root, name), bytes("{}"))
        }
        write(File(box.root, "shz/why"), bytes("Shizuku unavailable"))
        write(File(box.root, "tapi/capable"), bytes("Termux API bridge"))
        val before = snapshot(box.area, true)
        check(!helper(box).isEmpty(box.root) && helper(box).isFreshRoot(box.root))
        check(snapshot(box.area, true) == before)
        write(File(box.root, "shz/request.json"), bytes("不能删除用户请求"))
        check(!helper(box).isFreshRoot(box.root))
    }
    for (name in listOf("bin", "lib", "home", "extensions", ".runtime-install-incomplete", "unknown")) {
        test("首次安装不放行存量或未知条目：$name") {
            val box = fresh(seed = false, users = false)
            write(File(box.root, "$name/preserved"), bytes("不能删除"))
            val before = snapshot(box.area, true)
            check(!helper(box).isFreshRoot(box.root) && snapshot(box.area, true) == before)
        }
    }
    test("原生元数据目录不能冒充状态文件") {
        val box = fresh(seed = false, users = false)
        Files.createDirectory(File(box.root, "kxxy-state.json").toPath())
        check(!helper(box).isFreshRoot(box.root))
    }
    test("目录不能冒充受管普通文件") {
        val box = fresh()
        Files.delete(File(box.root, ENTRY).toPath())
        Files.createDirectory(File(box.root, ENTRY).toPath())
        zeroWrite(box, Fixture().assets(), "拒绝符号链接或非常规目标")
    }
    test("预先取消保留线程中断标志且零写入") {
        val box = fresh()
        val before = snapshot(box.area, true)
        val assets = Fixture().assets()
        Thread.currentThread().interrupt()
        try {
            try { helper(box, assets).upgrade(box.root); error("应抛 InterruptedException") }
            catch (_: InterruptedException) { check(Thread.currentThread().isInterrupted) }
        } finally { Thread.interrupted() }
        check(assets.opened.isEmpty() && snapshot(box.area, true) == before)
    }

    val linkUnavailable: String? by lazy {
        val probe = fresh(seed = false, users = false)
        val link = File(probe.root, "probe-link").toPath()
        try {
            Files.createSymbolicLink(link, File(probe.outside, "precious").toPath())
            Files.delete(link)
            null
        } catch (e: UnsupportedOperationException) { e.toString() } catch (e: FileSystemException) { e.toString() }
    }
    // 每组注册相同用例；宿主不支持链接时逐项标为 SKIP，不能算 PASS 或整组漏计。
    fun linkTest(name: String, block: () -> Unit) = test(name) {
        linkUnavailable?.let { skip("宿主文件系统不能创建 symlink：$it") }
        block()
    }
    for (name in listOf(ENTRY, FP, "lib", DSH + "lib", "")) linkTest("磁盘 symlink 文件/父目录/根拒绝且外部不变：${name.ifEmpty { "engine" }}") {
        val box = fresh(seed = false, users = false)
        val target = if (name == ENTRY || name == FP) File(box.outside, "precious") else box.outside
        val path = if (name.isEmpty()) box.root.toPath() else File(box.root, name).toPath()
        if (name.isEmpty()) Files.delete(path) else Files.createDirectories(path.parent)
        Files.createSymbolicLink(path, target.toPath())
        val before = snapshot(box.area, true)
        refusal("符号链接") { helper(box).upgrade(box.root) }
        if (name.isEmpty()) refusal("符号链接") { helper(box).isEmpty(box.root) }
        check(snapshot(box.area, true) == before)
    }
    linkTest("私有边界 symlink 不得通过 canonicalization 越界") {
        val box = fresh()
        val alias = File(box.area, "private-alias")
        Files.createSymbolicLink(alias.toPath(), box.base.toPath())
        val before = snapshot(box.area, true)
        refusal("符号链接父目录") { DshRuntimeUpgrade(Fixture().assets(), alias, TARGET).upgrade(File(alias, "engine")) }
        check(snapshot(box.area, true) == before)
    }
    linkTest("非受管扩展 symlink 不跟随、不修改外部文件") {
        val box = fresh()
        val path = File(box.root, "extensions/custom/external-link")
        Files.createSymbolicLink(path.toPath(), box.outside.toPath())
        val before = unmanaged(box)
        helper(box).upgrade(box.root)
        checkCurrent(box)
        check(unmanaged(box) == before)
    }
    linkTest("候选目录是符号链接时升级拒绝，绝不跟随或清理外部内容") {
        val box = fresh()
        helper(box).upgrade(box.root)
        val outsideDir = File(box.outside, "shadow").apply { check(mkdir()) }
        val stale = File(box.root, NESTED)
        Files.createDirectories(stale.parentFile.toPath())
        Files.createSymbolicLink(stale.toPath(), outsideDir.toPath())
        val before = snapshot(box.outside, true)
        // 清理只删「自己验证过的空目录」，链接在预检阶段就被拒绝（fail-closed），
        // 既不跟进去删外部文件，也不会把链接本身当成可删的空目录。
        refusal("符号链接") { helper(box).upgrade(box.root) }
        check(Files.isSymbolicLink(stale.toPath()))
        check(snapshot(box.outside, true) == before)
    }
    check(caseNames.size == caseNames.toSet().size) { "测试名称重复" }
    println("TOTAL shard=$shard/$shards PASS $passed; FAIL $failed; SKIP $skipped; REGISTERED ${caseNames.size}; ELAPSED_MS ${(System.nanoTime() - start) / 1_000_000}")
    println("RESULT {\"shard\":$shard,\"shards\":$shards,\"registered\":${caseNames.size},\"passed\":$passed,\"failed\":$failed,\"skipped\":$skipped,\"inventorySha256\":\"${sha(bytes(caseNames.joinToString("\n")))}\"}")
    println(if (WINDOWS) "平台边界：Windows JVM；未验证 Android/Linux POSIX 权限、UID、文件系统及进程掉电语义。" else "平台边界：桌面 JVM；不等同于 Android 真机验证。")
    check(failed == 0) { "$failed 项 DSH 升级回归失败，详见上方真实堆栈" }
}
