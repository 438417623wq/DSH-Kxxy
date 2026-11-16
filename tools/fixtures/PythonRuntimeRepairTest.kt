package app.kxxy.engine

import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest

private var count = 0
private fun pass(name: String) { count++; println("PASS $name") }
private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
private const val SITE = "lib/python3.14/site-packages/"
private const val HOST = "lib/node_modules/kxxy-host/lib/"
private const val BACKEND = SITE + "_cffi_backend.cpython-314-aarch64-linux-android.so"
private const val FP = HOST + ".fingerprint"
private const val MARKER = "share/kxxy/python-runtime.json"
private val TARGET = "b".repeat(64)

private class AssetFiles(private val root: File, private val onOpen: (String) -> Unit = {}) : PythonRuntimeRepair.Assets {
    val opened = mutableListOf<String>()
    override fun open(name: String): InputStream {
        check(name != "runtime.zip") { "Repair must never read the full runtime ZIP" }
        opened += name
        onOpen(name)
        return FileInputStream(File(root, name))
    }
}

// NOFOLLOW traversal includes directories, inode identities, timestamps, bytes and link targets.
private fun snapshot(root: File): Map<String, String> {
    val base = root.toPath()
    return Files.walk(base).use { stream ->
        stream.iterator().asSequence().associate { path ->
            val a = Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
            val relative = base.relativize(path).toString().replace('\\', '/')
            relative to when {
                a.isSymbolicLink -> "link:" + Files.readSymbolicLink(path)
                a.isDirectory -> "directory:" + a.fileKey()
                else -> "file:" + a.fileKey() + ":" + a.lastModifiedTime() + ":" + digest(Files.readAllBytes(path))
            }
        }
    }
}

private fun refusal(action: () -> Unit): String {
    try { action() } catch (e: PythonRuntimeRepair.Refused) {
        val message = e.message ?: error("Refusal must explain the safe failure")
        check(message.contains("不会自动清空或重装用户运行时")) { e }
        return message
    }
    error("Expected fail-closed PythonRuntimeRepair.Refused")
}

fun main(args: Array<String>) {
    val temp = File(args[0])
    val scratch = File(temp, "scratch").apply { mkdirs() }
    val expected = File(temp, "expected")
    val baseline = File(temp, "baseline")
    val paths = File(temp, "managed-paths.txt").readLines()
    val fixtureRoot = File(temp, "assets")
    fun fresh(name: String): File {
        val root = File(scratch, "$name/engine").apply { mkdirs() }
        for (path in paths) {
            val old = File(baseline, path)
            if (old.exists()) File(root, path).apply { parentFile.mkdirs(); writeBytes(old.readBytes()) }
        }
        val keep = listOf("bin/node", "extensions/custom/data", "venv/lib/python3.14/site-packages/user.py",
            SITE + "user_pkg/data.bin", SITE + "cffi/local-user-notes.txt", SITE + "pycparser/user-extra.py",
            SITE + "numpy-2.4.0.dist-info/WHEEL", SITE + "psutil-7.2.0.dist-info/WHEEL",
            "home/sessions/keep.json", "kxxy-home/.credentials.yaml")
        for (path in keep) File(root, path).apply { parentFile.mkdirs(); writeText("KEEP:$path") }
        return root
    }
    fun asset(name: String = "valid", callback: (String) -> Unit = {}) = AssetFiles(File(fixtureRoot, name), callback)
    fun repair(root: File, assets: AssetFiles = asset(), target: String = TARGET, api: Int = 26,
               move: (Path, Path) -> Unit = { from, to -> Files.move(from, to, ATOMIC_MOVE, REPLACE_EXISTING); Unit }) =
        PythonRuntimeRepair(assets, root.parentFile, target, api, move)
    fun current(root: File) { for (path in paths) check(File(root, path).readBytes().contentEquals(File(expected, path).readBytes())) { path } }
    fun unexpected(root: File) = snapshot(root).filterKeys { it !in paths && !it.split('/').let { parts -> paths.any { p -> p.startsWith(parts.joinToString("/") + "/") } } }
    fun stages(root: File) = root.parentFile.listFiles()!!.filter { it.name.startsWith(".python-repair-") }

    val normal = fresh("missing-dependencies")
    val keep = unexpected(normal)
    val firstAssets = asset()
    val changed = repair(normal, firstAssets).repair(normal)
    check(changed.supported && changed.replaced.size == paths.size) { changed }
    current(normal)
    check(unexpected(normal) == keep)
    check(stages(normal).isEmpty())
    check(firstAssets.opened.count { it == "python-repair/payload.zip" } == 1)
    pass("missing cffi/backend/pycparser repaired; user packages, venv, extensions and numpy/psutil WHEEL untouched")
    val order = changed.replaced
    check(order.takeLast(3) == listOf(MARKER, "kxxy-runtime.json", FP)) { order }
    pass("commit order: Python marker then runtime manifest then host fingerprint last")
    val once = snapshot(normal.parentFile)
    val againAssets = asset()
    check(repair(normal, againAssets).repair(normal).replaced.isEmpty())
    check(repair(normal).isCurrent(normal))
    check(againAssets.opened.none { it == "python-repair/payload.zip" })
    check(snapshot(normal.parentFile) == once)
    pass("second repair and content probe are idempotent, read-only and skip payload")
    if (Files.getFileStore(normal.toPath()).supportsFileAttributeView("posix")) {
        check(Files.getPosixFilePermissions(File(normal, BACKEND).toPath()) == java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x"))
        check(Files.getPosixFilePermissions(File(normal, SITE + "cffi/__init__.py").toPath()) == java.nio.file.attribute.PosixFilePermissions.fromString("rw-r--r--"))
        pass("managed 0755/0644 modes applied on POSIX filesystem")
    }

    val freshRuntime = fresh("new-runtime")
    for (path in paths) File(freshRuntime, path).apply { parentFile.mkdirs(); writeBytes(File(expected, path).readBytes()) }
    val newBefore = snapshot(freshRuntime.parentFile)
    val newAssets = asset()
    check(repair(freshRuntime, newAssets).isCurrent(freshRuntime))
    check(repair(freshRuntime, newAssets).repair(freshRuntime).replaced.isEmpty())
    check(newAssets.opened.none { it == "python-repair/payload.zip" })
    check(snapshot(freshRuntime.parentFile) == newBefore)
    pass("healthy newly-extracted runtime needs no patch, repair journal or marker loop")
    val sameHost = fresh("same-host")
    for (path in paths.filter { it.startsWith("lib/node_modules/kxxy-host/") || it == "kxxy-runtime.json" }) File(sameHost, path).apply { parentFile.mkdirs(); writeBytes(File(expected, path).readBytes()) }
    val sameRepair = repair(sameHost, asset("same-host"))
    check(sameRepair.repair(sameHost).replaced.size == paths.count { !it.startsWith("lib/node_modules/kxxy-host/") && it != "kxxy-runtime.json" })
    check(sameRepair.isCurrent(sameHost))
    pass("baseHostFingerprint equal to target supports missing-only full-build payload")

    // 0.9.42 → 0.9.43 真机事故回归：`kxxy-runtime.json` 是安装器写出的构建元数据，每次发布都会重写
    // builtAt / plugins.codexFingerprint，单个 previousSha256 只可能命中一个从未发布过的中间产物。
    // 结构可识别的旧清单必须被覆盖；认不出的一律零写入拒绝。
    val codex = "6".repeat(64)
    fun runtimeManifest(host: String, schema: Int = 2, extra: String = "", pluginExtra: String = "") =
        "{\"schemaVersion\":$schema,\"runtimeVersion\":\"v0.1.0-arm64\",\"rootPlaceholder\":\"@DSH_ROOT@\"," +
            "\"termuxPrefix\":\"/data/data/com.termux/files/usr/\",\"arch\":\"aarch64\",\"node\":\"24.18.0\"," +
            "\"entries\":61063,\"directories\":5368,\"linkEntries\":1709," +
            "\"placeholderPaths\":[\"var/service/telnetd/run\"]," +
            "\"removedPaths\":[\"libexec/git-core/git-send-email\"]," +
            "\"builtAt\":\"2026-11-12T07:45:47.333Z\"," +
            "\"plugins\":{\"hostFingerprint\":\"$host\",\"hostMarker\":\"kxxy-host@3d6f2e90\"," +
            "\"mobileMarker\":\"kxxy-mobile-plugin@1\",\"codexFingerprint\":\"$codex\"$pluginExtra}$extra}"
    for ((label, body) in listOf(
        "previous release, base host lineage" to runtimeManifest("a".repeat(64)),
        "previous release, target host lineage" to runtimeManifest(TARGET),
    )) {
        val root = fresh("superseded-manifest-${label.hashCode()}")
        File(root, "kxxy-runtime.json").writeText(body)
        val userBefore = unexpected(root)
        val replaced = repair(root).repair(root).replaced
        check(replaced.contains("kxxy-runtime.json")) { replaced }
        current(root)
        check(repair(root).isCurrent(root))
        check(unexpected(root) == userBefore)
        pass("superseded runtime manifest is replaced, not reported as a user conflict: $label")
    }
    for ((label, body) in listOf(
        "unknown top-level field" to runtimeManifest("a".repeat(64), extra = ",\"userField\":1"),
        "unknown plugins field" to runtimeManifest("a".repeat(64), pluginExtra = ",\"userPlugin\":1"),
        "future schema" to runtimeManifest("a".repeat(64), schema = 3),
        "foreign host lineage" to runtimeManifest("c".repeat(64)),
        "not a JSON object" to "[1,2,3]",
        "plain text" to "USER MODIFIED DO NOT OVERWRITE",
    )) {
        val root = fresh("manifest-conflict-${label.hashCode()}")
        File(root, "kxxy-runtime.json").apply { parentFile.mkdirs(); writeText(body) }
        val before = snapshot(root.parentFile)
        val message = refusal { repair(root).repair(root) }
        check(message.contains("冲突") || message.contains("已修改")) { message }
        check(File(root, "kxxy-runtime.json").readText() == body) { "Manifest was overwritten: $label" }
        check(snapshot(root.parentFile) == before) { "Refusal wrote files: $label" }
        pass("unrecognised runtime manifest stays a zero-write conflict: $label")
    }

    for (name in listOf("legacy", "missing-meta")) {
        val root = fresh(name)
        val before = snapshot(root.parentFile)
        val assets = asset(name)
        val helper = repair(root, assets)
        check(!helper.repair(root).supported && helper.isCurrent(root))
        check(assets.opened == listOf("meta/build.json") && snapshot(root.parentFile) == before)
        pass("old APK without repair metadata is compatible and performs zero writes: $name")
    }

    val invalid = fixtureRoot.listFiles()!!.map { it.name }.filter { it !in listOf("valid", "same-host", "legacy", "missing-meta") }.sorted()
    for (name in invalid) {
        val root = fresh("invalid-$name")
        val before = snapshot(root.parentFile)
        refusal { repair(root, asset(name)).repair(root) }
        check(snapshot(root.parentFile) == before) { "Invalid asset wrote files: $name" }
        pass("untrusted/malformed asset rejected with ZERO writes: $name")
    }
    for ((name, host, api) in listOf(Triple("compiled-host-mismatch", "d".repeat(64), 26), Triple("device-api-too-old", TARGET, 23))) {
        val root = fresh(name)
        val before = snapshot(root.parentFile)
        refusal { repair(root, target = host, api = api).repair(root) }
        check(snapshot(root.parentFile) == before)
        pass("APK/device compatibility gate zero writes: $name")
    }
    for (host in listOf("c".repeat(64), "missing")) {
        val root = fresh("unsupported-$host")
        if (host == "missing") File(root, FP).delete() else File(root, FP).writeText("fingerprint: $host\n")
        val before = snapshot(root.parentFile)
        val error = refusal { repair(root).repair(root) }
        check(error.contains("不适用此增量修复"))
        check(snapshot(root.parentFile) == before)
        pass("other old host baseline explicitly inapplicable, never deletes lib: $host")
    }

    for (conflict in listOf(SITE + "cffi/api.py", BACKEND, HOST + "index.js", "kxxy-runtime.json", MARKER, FP)) {
        val root = fresh("conflict-${conflict.hashCode()}")
        File(root, conflict).apply { parentFile.mkdirs(); if (conflict == FP) writeText("fingerprint: ${"a".repeat(64)}\nuser edit\n") else writeText("USER MODIFIED DO NOT OVERWRITE") }
        val before = snapshot(root.parentFile)
        val message = refusal { repair(root).repair(root) }
        check(message.contains("冲突") || message.contains("已修改")) { message }
        check(snapshot(root.parentFile) == before)
        pass("user modification causes ZERO writes before staging: $conflict")
    }

    val late = fresh("late-conflict")
    val lateBefore = snapshot(late)
    var injected = false
    val lateAssets = asset { name -> if (name == "python-repair/payload.zip") {
        File(late, HOST + "index.js").writeText("LATE USER EDIT"); injected = true
    } }
    refusal { repair(late, lateAssets).repair(late) }
    check(injected && File(late, HOST + "index.js").readText() == "LATE USER EDIT")
    check(snapshot(late).filterKeys { it != HOST + "index.js" } == lateBefore.filterKeys { it != HOST + "index.js" } && stages(late).isEmpty())
    pass("target mutation while verifying payload rechecked before any staging/engine write")

    for (broken in listOf(BACKEND, SITE + "cffi/api.py", MARKER)) {
        val root = fresh("disk-damage-${broken.hashCode()}")
        repair(root).repair(root)
        File(root, broken).writeText("BROKEN")
        val before = snapshot(root.parentFile)
        check(!repair(root).isCurrent(root))
        refusal { repair(root).repair(root) }
        check(snapshot(root.parentFile) == before)
        pass("disk marker cannot hide modified native backend/package/marker; zero-write refusal: $broken")
    }
    val missingBackend = fresh("missing-backend-after-repair")
    repair(missingBackend).repair(missingBackend)
    File(missingBackend, BACKEND).delete()
    check(!repair(missingBackend).isCurrent(missingBackend))
    check(repair(missingBackend).repair(missingBackend).replaced == listOf(BACKEND))
    check(repair(missingBackend).isCurrent(missingBackend))
    pass("deleted native backend found despite current marker and safely refilled")

    val external = File(scratch, "outside").apply { mkdirs() }
    val precious = File(external, "precious").apply { writeText("PRESERVE EXTERNAL") }
    for (symlink in listOf(SITE + "cffi/api.py", SITE + "cffi", "lib", FP, "share")) {
        val root = fresh("symlink-${symlink.hashCode()}")
        val path = File(root, symlink)
        // Test setup deletes only its own fixture; production has no recursive deletion.
        if (path.exists()) path.deleteRecursively()
        path.parentFile.mkdirs()
        val isFile = symlink.endsWith(".py") || symlink == FP
        Files.createSymbolicLink(path.toPath(), if (isFile) precious.toPath() else external.toPath())
        val before = snapshot(root.parentFile)
        refusal { repair(root).repair(root) }
        check(snapshot(root.parentFile) == before && precious.readText() == "PRESERVE EXTERNAL")
        pass("symlink file/parent refuses zero writes and preserves external target: $symlink")
    }
    val rootLink = fresh("symlink-engine")
    val rootParent = rootLink.parentFile
    rootLink.deleteRecursively()
    Files.createSymbolicLink(rootLink.toPath(), external.toPath())
    val rootLinkBefore = snapshot(rootParent)
    refusal { repair(rootLink).repair(rootLink) }
    check(snapshot(rootParent) == rootLinkBefore && precious.readText() == "PRESERVE EXTERNAL")
    pass("symlink engine root rejected before following it")
    val baseLinkRoot = fresh("symlink-private-boundary")
    val alias = File(scratch, "private-alias")
    Files.createSymbolicLink(alias.toPath(), baseLinkRoot.parentFile.toPath())
    val aliasedRoot = File(alias, "engine")
    val realBefore = snapshot(baseLinkRoot.parentFile)
    refusal { repair(aliasedRoot).repair(aliasedRoot) }
    check(snapshot(baseLinkRoot.parentFile) == realBefore)
    pass("symlink private boundary cannot escape through canonicalization")
    val dirTarget = fresh("directory-instead-of-file")
    File(dirTarget, BACKEND).mkdirs()
    val dirBefore = snapshot(dirTarget.parentFile)
    refusal { repair(dirTarget).repair(dirTarget) }
    check(snapshot(dirTarget.parentFile) == dirBefore)
    pass("ordinary directory cannot masquerade as managed regular file")

    for (stopAfter in 0..paths.size) {
        val root = fresh("interrupted-$stopAfter")
        val userBefore = unexpected(root)
        var moves = 0
        var stageChecked = false
        val helper = repair(root, move = { from, to ->
            if (!stageChecked) {
                val staged = from.parent.toFile().listFiles()!!.filter { it.name.endsWith(".part") }
                check(staged.size == paths.size) { "Must stage ALL files before the first move" }
                check(staged.map { digest(it.readBytes()) }.sorted() == paths.map { digest(File(expected, it).readBytes()) }.sorted())
                check(from.parent.parent == root.parentFile.toPath())
                stageChecked = true
            }
            if (stopAfter == 0) throw IOException("injected before first atomic move")
            Files.move(from, to, ATOMIC_MOVE, REPLACE_EXISTING)
            moves++
            if (moves == stopAfter) throw IOException("injected interruption AFTER atomic move $moves")
        })
        refusal { helper.repair(root) }
        for (path in paths) {
            val value = File(root, path)
            if (value.exists()) {
                val bytes = value.readBytes()
                val old = File(baseline, path)
                check(bytes.contentEquals(File(expected, path).readBytes()) || (old.exists() && bytes.contentEquals(old.readBytes()))) { "Torn file $path after $stopAfter" }
            }
        }
        check(unexpected(root) == userBefore)
        check(stages(root).isEmpty())
        repair(root).repair(root)
        current(root)
        check(repair(root).isCurrent(root))
        check(unexpected(root) == userBefore)
        pass("partial atomic install resumes safely at interruption boundary $stopAfter/${paths.size}")
    }

    val orphan = fresh("orphan-stage")
    val orphanDir = File(orphan.parentFile, ".python-repair-stale-do-not-trust").apply { mkdirs() }
    val orphanData = File(orphanDir, "0.part").apply { writeText("UNTRUSTED PREVIOUS PROCESS DATA") }
    val orphanBefore = snapshot(orphanDir)
    repair(orphan).repair(orphan)
    check(snapshot(orphanDir) == orphanBefore && orphanData.readText() == "UNTRUSTED PREVIOUS PROCESS DATA")
    pass("stale/private staging never authorizes contents and is never recursively removed")

    val cancelled = fresh("cancelled")
    val cancelledBefore = snapshot(cancelled.parentFile)
    Thread.currentThread().interrupt()
    try { repair(cancelled).repair(cancelled); error("Expected cancellation") } catch (_: InterruptedException) { check(Thread.currentThread().isInterrupted) } finally { Thread.interrupted() }
    check(snapshot(cancelled.parentFile) == cancelledBefore)
    pass("thread cancellation preserved and performs zero writes")

    val bounded = fresh("bounded-user-file")
    File(bounded, SITE + "unmanaged-huge.bin").apply { RandomAccessFile(this, "rw").use { it.setLength(875L * 1024 * 1024) } }
    repair(bounded).repair(bounded)
    check(File(bounded, SITE + "unmanaged-huge.bin").length() == 875L * 1024 * 1024)
    pass("875 MiB unrelated file untouched with 192 MiB JVM heap; never scans runtime or user tree")
    println("TOTAL PASS $count")
}
