package app.kxxy.engine

import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest

private const val FP = "lib/node_modules/kxxy-host/lib/.fingerprint"
private const val ROOT_MANIFEST = "kxxy-runtime.json"
private const val PYTHON_FILE = "lib/python3.14/site-packages/cffi/__init__.py"
private var passed = 0
private fun pass(name: String) { passed++; println("PASS $name") }
private fun sha(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(65536)
        while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
    }
    return digest.digest().joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
}
private fun snapshot(root: File): Map<String, String> = Files.walk(root.toPath()).use { stream ->
    stream.iterator().asSequence().associate { path ->
        val attrs = Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
        val name = root.toPath().relativize(path).toString().replace('\\', '/')
        name to when {
            attrs.isSymbolicLink -> "link:${Files.readSymbolicLink(path)}"
            attrs.isDirectory -> "directory:${attrs.fileKey()}"
            else -> "file:${attrs.fileKey()}:${attrs.size()}:${attrs.lastModifiedTime()}:${sha(path.toFile())}"
        }
    }
}
private fun refused(action: () -> Unit): String {
    try { action() } catch (e: Exception) {
        check(e is PythonRuntimeRepair.Refused || e is DshRuntimeUpgrade.Refused) { e }
        check(e.message.orEmpty().contains("不会自动清空或重装用户运行时")) { e }
        return e.message.orEmpty()
    }
    error("Expected an explicit safe refusal")
}
private fun atomic(from: Path, to: Path) { Files.move(from, to, ATOMIC_MOVE, REPLACE_EXISTING) }

fun main(args: Array<String>) {
    val scratch = File(args[0])
    val target = args[1]
    val interrupt = args[2] == "interrupt"
    val engine = File(scratch, "private/engine")
    val assetRoot = File(scratch, "assets")
    val opened = mutableListOf<String>()
    fun asset(name: String): FileInputStream {
        check(name != "runtime.zip") { "Incremental helpers must never read the full runtime ZIP" }
        opened += name
        return FileInputStream(File(assetRoot, name))
    }
    fun python(move: (Path, Path) -> Unit = ::atomic) = PythonRuntimeRepair(
        PythonRuntimeRepair.Assets { asset(it) }, engine.parentFile, target, 36, move)
    fun dsh(move: (Path, Path) -> Unit = ::atomic) = DshRuntimeUpgrade(
        DshRuntimeUpgrade.Assets { asset(it) }, engine.parentFile, target, move)
    val records = File(assetRoot, "dsh-upgrade/manifest.tsv").readLines().drop(7).map { it.split('\t') }
    val pythonRecords = File(scratch, "python-records.tsv").readLines().map { it.split('\t') }
    val managed = (records.map { it[1] } + pythonRecords.map { it[0] }).toSet()
    fun userFiles() = snapshot(engine).filterKeys { it !in managed && !it.isEmpty() && !managed.any { p -> p.startsWith("$it/") } }
    val originalUserFiles = userFiles()
    val beforePreflight = snapshot(engine)
    python().preflight(engine)
    check(snapshot(engine) == beforePreflight)
    check(opened.none { it.endsWith("payload.zip") })
    pass("real H0 Python preflight is read-only and does not open a payload")

    fun zeroWriteConflict(name: String, bytes: ByteArray?, operation: () -> Unit) {
        val file = File(engine, name)
        val original = file.readBytes()
        val time = file.lastModified()
        if (bytes == null) check(file.delete()) else file.writeBytes(bytes)
        val before = snapshot(engine)
        val message = refused(operation)
        check(snapshot(engine) == before) { "Conflict changed runtime files: $name" }
        println("REFUSAL $message")
        file.writeBytes(original)
        check(file.setLastModified(time))
    }
    zeroWriteConflict(PYTHON_FILE, "# user changed CFFI\n".toByteArray()) {
        var reachedDsh = false
        try { python().preflight(engine); reachedDsh = true; dsh().upgrade(engine) }
        finally { check(!reachedDsh) { "Python conflict must stop before DSH commit" } }
    }
    pass("Python user conflict stops the installer chain before any DSH write")
    zeroWriteConflict("lib/node_modules/@deepseek-ai/dsh/package.json", "{\"user\":true}\n".toByteArray()) {
        python().preflight(engine)
        dsh().upgrade(engine)
    }
    pass("DSH user conflict is refused after Python preflight with zero runtime writes")
    zeroWriteConflict(FP, null) {
        var reachedDsh = false
        try { python().preflight(engine); reachedDsh = true; dsh().upgrade(engine) }
        finally { check(!reachedDsh) }
    }
    pass("missing host fingerprint is refused by Python preflight; DSH-only recovery is not misreported as chain support")
    val unknown = File(engine, FP).readText().replace(Regex("fingerprint: [0-9a-f]{64}"), "fingerprint: " + "f".repeat(64)).toByteArray()
    zeroWriteConflict(FP, unknown) { python().preflight(engine); dsh().upgrade(engine) }
    pass("unknown host lineage fails closed without touching user or managed files")

    python().preflight(engine)
    check(userFiles() == originalUserFiles)
    val oldFingerprint = File(engine, FP).readBytes()
    if (interrupt) {
        var injected = false
        val message = refused {
            dsh { from, to ->
                if (to == File(engine, FP).toPath()) { injected = true; throw IOException("INJECTED_STOP_BEFORE_HOST_FINGERPRINT") }
                atomic(from, to)
            }.upgrade(engine)
        }
        check(injected && message.contains("INJECTED_STOP_BEFORE_HOST_FINGERPRINT"))
        check(File(engine, FP).readBytes().contentEquals(oldFingerprint))
        check(sha(File(engine, ROOT_MANIFEST)) == records.single { it[1] == ROOT_MANIFEST }[4])
        python().preflight(engine)
        check(userFiles() == originalUserFiles)
        pass("real DSH commit interrupted after target manifest but before H1 fingerprint; Python preflight accepts the safe mixed state")
    }
    val upgraded = dsh().upgrade(engine)
    check(upgraded.supported)
    check(upgraded.replaced.last() == FP)
    if (interrupt) check(upgraded.replaced == listOf(FP)) { upgraded.replaced }
    val repaired = python().repair(engine)
    check(repaired.supported && repaired.replaced.isEmpty()) { repaired }
    check(dsh().isCurrent(engine) && python().isCurrent(engine))
    check(userFiles() == originalUserFiles)
    println("UPGRADE replaced=${upgraded.replaced.size} retiredBackups=${upgraded.backups.size} pythonReplaced=${repaired.replaced.size}")
    pass("real H0 to H1 chain completed; both helpers report current and H1 fingerprint committed last")

    for (row in records) {
        val file = File(engine, row[1])
        if (row[0] == "delete") check(!file.exists()) { row[1] }
        else check(file.length() == row[2].toLong() && sha(file) == row[4]) { row[1] }
    }
    for (row in pythonRecords) check(File(engine, row[0]).length() == row[1].toLong() && sha(File(engine, row[0])) == row[2]) { row[0] }
    pass("all 32073 real DSH records and 61 Python repair records match final target bytes")
    val retired = records.filter { it[0] == "delete" }
    val backupDirectories = engine.parentFile.listFiles()!!.filter { it.name.startsWith(".dsh-upgrade-backup-") }
    for (row in retired) {
        val copies = backupDirectories.map { File(it, row[1]) }.filter { it.isFile }
        check(copies.size == 1 && copies[0].length() == row[2].toLong() && sha(copies[0]) in row[5].split(',')) { "Missing original retired file backup: ${row[1]}" }
    }
    pass("all 3980 retired official files retained in private backups, not recursively deleted")

    opened.clear()
    val complete = snapshot(engine)
    python().preflight(engine)
    check(dsh().upgrade(engine).replaced.isEmpty())
    check(python().repair(engine).replaced.isEmpty())
    check(snapshot(engine) == complete)
    check(opened.none { it.endsWith("payload.zip") })
    pass("second complete installer chain performs zero writes and opens no payload")

    if (interrupt) {
        // A missing Python file remains repairable after the DSH transition, including a stopped repair attempt.
        check(File(engine, PYTHON_FILE).delete())
        python().preflight(engine)
        check(dsh().upgrade(engine).replaced.isEmpty())
        var injected = false
        refused {
            python { _, _ -> injected = true; throw IOException("INJECTED_PYTHON_STOP") }.repair(engine)
        }
        check(injected && !File(engine, PYTHON_FILE).exists())
        python().preflight(engine)
        check(dsh().upgrade(engine).replaced.isEmpty())
        check(python().repair(engine).replaced == listOf(PYTHON_FILE))
        check(python().isCurrent(engine))
        pass("missing Python file at H1 survives an interrupted repair and is restored by the complete chain")
        check(userFiles() == originalUserFiles)
        pass("user Python packages, venv, extensions, global npm, sessions and work data remain byte-and-identity unchanged")
    }
    println("RESULT {\"passed\":$passed,\"failed\":0,\"skipped\":0,\"records\":${records.size},\"pythonFiles\":${pythonRecords.size}}")
}
