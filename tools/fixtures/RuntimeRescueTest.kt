package app.kxxy.engine

import android.content.Context
import android.content.res.AssetManager
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.concurrent.thread

private fun expectFailure(block: () -> Unit): Exception {
    try { block() } catch (e: Exception) { return e }
    error("Expected failure")
}

private class SpaceFile(path: String, private val space: Long) : File(path) {
    override fun getUsableSpace() = space
}

fun main(args: Array<String>) {
    if (args.firstOrNull() == "child") {
        when (args[1]) {
            "stdin" -> { while (System.`in`.read() != -1) {}; return }
            "sleep" -> { Thread.sleep(60_000); return }
        }
    }
    val root = Files.createTempDirectory("runtime-rescue-test").toFile()
    try {
        val helper = RuntimeInstallIo
        val zipSize = 801_519_819L
        val unpacked = 2_030_936_372L
        check(helper.requiredSpace(zipSize, unpacked) == zipSize + unpacked + 128L * 1024 * 1024)
        expectFailure { helper.requireSpace(2_100_000_000L, helper.requiredSpace(zipSize, unpacked), "test") }
        expectFailure { helper.requiredSpace(Long.MAX_VALUE, 1) }
        listOf("../home/config", "/home/config", "bin/../../home/config", "home/config", "extensions/a", "profile/a", "workspace/a", "bin\\a", "bin/../a").forEach {
            expectFailure { helper.validateEntry(it) }
        }
        listOf("bin/node", "lib/node_modules/a.js", "share/texmf/").forEach { helper.validateEntry(it) }
        var cancelled = false
        val copyThread = thread {
            Thread.currentThread().interrupt()
            cancelled = expectFailure { helper.copy("abc".byteInputStream(), java.io.ByteArrayOutputStream()) } is InterruptedException
        }
        copyThread.join()
        check(cancelled)

        val java = File(System.getProperty("java.home"), "bin/java.exe").absolutePath
        val cp = System.getProperty("java.class.path")
        fun child(mode: String) = ProcessBuilder(java, "-cp", cp, "app.kxxy.engine.RuntimeRescueTestKt", "child", mode)
            .redirectErrorStream(true).redirectOutput(File(root, "$mode.log"))
        check(helper.run(child("stdin"), 5_000L) == 0) // stdin must be closed.
        val before = System.nanoTime()
        check(expectFailure { helper.run(child("sleep"), 200L) } is IOException)
        check((System.nanoTime() - before) / 1_000_000 < 5_000)
        var interrupted = false
        val runner = thread {
            try { helper.run(child("sleep"), 60_000L) }
            catch (_: InterruptedException) { interrupted = true }
        }
        Thread.sleep(500)
        runner.interrupt()
        runner.join(5_000)
        check(!runner.isAlive && interrupted)

        val assets = File(root, "assets").apply { mkdirs() }
        val archive = File(assets, "runtime.zip")
        ZipOutputStream(archive.outputStream()).use { out ->
            for ((name, text) in listOf("bin/node" to "apk-node", "kxxy-runtime.json" to "{\"placeholderPaths\":[]}")) {
                out.putNextEntry(ZipEntry(name)); out.write(text.toByteArray()); out.closeEntry()
            }
        }
        File(assets, "meta").mkdirs()
        File(assets, "meta/build.json").writeText("{\"runtimeSize\":${archive.length()},\"runtimeUncompressedBytes\":128}")
        val files = File(root, "files").apply { mkdirs() }
        val cache = File(root, "cache").apply { mkdirs() }
        val normal = Context(files, cache, AssetManager(assets))
        val engine = EngineConfig.engineRoot(normal).apply { mkdirs() }
        File(engine, "bin").mkdirs()
        val oldNode = File(engine, "bin/node").apply { writeText("old-node") }
        val stamp = EngineConfig.stampFile(normal).apply { writeText("old-stamp") }
        val protected = listOf("extensions/user/content", "home/secret", "profile/manifest", "workspace/code", "recovery/record", "native-boot-failure.json")
            .map { path -> File(engine, path).apply { parentFile.mkdirs(); writeText("user-$path") } }
        val saved = protected.associateWith { it.readBytes() }

        val lowSpace = Context(SpaceFile(files.absolutePath, 1), SpaceFile(cache.absolutePath, 1), AssetManager(assets))
        val noSpace = expectFailure { RuntimeInstaller(lowSpace).forceReinstall {} }
        check(noSpace is IOException)
        check(oldNode.readText() == "old-node" && stamp.readText() == "old-stamp")
        check(!File(engine, ".runtime-incomplete").exists())
        saved.forEach { (file, bytes) -> check(file.readBytes().contentEquals(bytes)) }

        // Our tiny APK deliberately lacks production anchors: no success marker or
        // 100% completion may be emitted, but APK files are replaced, never user data.
        var complete = false
        expectFailure { RuntimeInstaller(normal).forceReinstall { if (it == 1f) complete = true } }
        check(oldNode.readText() == "apk-node")
        check(!complete && !stamp.exists() && File(engine, ".runtime-incomplete").isFile)
        saved.forEach { (file, bytes) -> check(file.readBytes().contentEquals(bytes)) }

        // APK protected top-level entry must reject the entire transaction pre-delete.
        oldNode.writeText("keep-before-invalid-archive")
        ZipOutputStream(archive.outputStream()).use { out ->
            out.putNextEntry(ZipEntry("extensions/evil")); out.write(byteArrayOf(1)); out.closeEntry()
        }
        File(assets, "meta/build.json").writeText("{\"runtimeSize\":${archive.length()},\"runtimeUncompressedBytes\":1}")
        expectFailure { RuntimeInstaller(normal).forceReinstall {} }
        check(oldNode.readText() == "keep-before-invalid-archive")
        saved.forEach { (file, bytes) -> check(file.readBytes().contentEquals(bytes)) }
        println("PASS: space preflight, archive protection, interrupted copy, stdin EOF, timeout/cancel, failed install markers, preserved user config")
    } finally { root.deleteRecursively() }
}
