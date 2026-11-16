package app.kxxy.engine

import kotlinx.coroutines.asContextElement
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.security.MessageDigest
import java.util.UUID

/** Filesystem primitives used by recovery; symlinks are entries, never recursive traversal roots. */
internal object RecoveryFiles {
    fun exists(file: File): Boolean = Files.exists(file.toPath(), NOFOLLOW_LINKS)

    private val trustedRoot = ThreadLocal<File?>()

    /** filesDir itself may live under Android's system /data/user/0 alias. Trust only that prefix. */
    fun trustedContext(root: File) = trustedRoot.asContextElement(root.absoluteFile)

    fun requireSafeParents(file: File) {
        val root = trustedRoot.get()
        if (root != null) {
            val path = file.absoluteFile.toPath().normalize()
            val boundary = root.toPath().normalize()
            check(path.startsWith(boundary) && path != boundary) { "拒绝修改私有目录之外的路径：$file" }
            var parent = file.absoluteFile.parentFile
            while (parent != null && parent.toPath().normalize() != boundary) {
                check(!Files.isSymbolicLink(parent.toPath())) { "拒绝经用户软链修改：${parent.absolutePath}" }
                parent = parent.parentFile
            }
            check(parent != null) { "文件不在可信目录内：$file" }
            return
        }
        var parent = file.absoluteFile.parentFile
        while (parent != null) {
            check(!Files.isSymbolicLink(parent.toPath())) { "拒绝经软链修改：${parent.absolutePath}" }
            parent = parent.parentFile
        }
    }

    fun atomicWrite(file: File, bytes: ByteArray) {
        requireSafeParents(file)
        check(!Files.isSymbolicLink(file.toPath())) { "拒绝改写软链：$file" }
        val parent = requireNotNull(file.parentFile)
        check(parent.isDirectory || parent.mkdirs()) { "无法创建目录：$parent" }
        val temp = File(parent, ".${file.name}.${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temp).use { it.write(bytes); it.fd.sync() }
            // No non-atomic fallback: an unsupported filesystem must fail before overwriting live data.
            Files.move(temp.toPath(), file.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
        } finally { Files.deleteIfExists(temp.toPath()) }
    }

    fun atomicText(file: File, text: String) = atomicWrite(file, text.toByteArray(Charsets.UTF_8))

    fun move(source: File, destination: File) {
        requireSafeParents(source); requireSafeParents(destination)
        check(!exists(destination)) { "目标已存在：$destination" }
        check(destination.parentFile!!.isDirectory || destination.parentFile!!.mkdirs()) { "无法创建备份父目录" }
        // Same filesDir filesystem. If rename fails do not silently copy/delete a directory or lose metadata.
        check(source.renameTo(destination)) { "移动失败（原文件保留）：$source" }
    }

    fun copySnapshot(source: File, destination: File) {
        requireSafeParents(source); requireSafeParents(destination)
        check(Files.isRegularFile(source.toPath(), NOFOLLOW_LINKS)) { "不是普通文件：$source" }
        check(!exists(destination)) { "备份已存在：$destination" }
        atomicWrite(destination, source.readBytes())
        destination.setReadable(source.canRead(), true)
        destination.setWritable(source.canWrite(), true)
        destination.setExecutable(source.canExecute(), true)
    }

    fun deleteTreeNoFollow(file: File) {
        requireSafeParents(file)
        if (!exists(file)) return
        if (Files.isDirectory(file.toPath(), NOFOLLOW_LINKS)) {
            val children = file.listFiles() ?: error("无法读取目录：$file")
            children.forEach { deleteTreeNoFollow(it) }
        }
        Files.delete(file.toPath())
    }

    /** Content fingerprint also captures directory entries and symlink targets, not linked contents. */
    fun fingerprint(file: File): String {
        requireSafeParents(file)
        if (!exists(file)) return "absent"
        val digest = MessageDigest.getInstance("SHA-256")
        fun walk(entry: File, relative: String) {
            digest.update(relative.toByteArray(Charsets.UTF_8)); digest.update(0.toByte())
            when {
                Files.isSymbolicLink(entry.toPath()) -> {
                    digest.update('L'.code.toByte())
                    digest.update(Files.readSymbolicLink(entry.toPath()).toString().toByteArray(Charsets.UTF_8))
                }
                Files.isDirectory(entry.toPath(), NOFOLLOW_LINKS) -> {
                    digest.update('D'.code.toByte())
                    (entry.listFiles() ?: error("无法读取目录：$entry")).sortedBy { it.name }
                        .forEach { walk(it, "$relative/${it.name}") }
                }
                Files.isRegularFile(entry.toPath(), NOFOLLOW_LINKS) -> {
                    digest.update('F'.code.toByte())
                    entry.inputStream().use { stream ->
                        val buffer = ByteArray(8192)
                        while (true) { val n = stream.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
                    }
                }
                else -> error("不支持的文件类型：$entry")
            }
            digest.update(0.toByte())
        }
        walk(file, "")
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
