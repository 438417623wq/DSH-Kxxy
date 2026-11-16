package app.kxxy.engine

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.TimeUnit

/** Small JVM-only primitives, also exercised by the rescue regression harness. */
internal object RuntimeInstallIo {
    private val protectedNames = setOf("home", "kxxy-home", "dsh-home", "profile", "workspace", "workspaces", "extensions", "recovery")

    fun checkCancelled() {
        if (Thread.currentThread().isInterrupted) throw InterruptedException("Runtime operation cancelled")
    }

    fun validateEntry(name: String) {
        val parts = name.trimEnd('/').split('/')
        require(name.isNotEmpty() && !name.startsWith('/') && !name.contains('\\') &&
            parts.none { it.isEmpty() || it == "." || it == ".." || it.contains(':') }) {
            "Invalid runtime ZIP path: $name"
        }
        require(parts.first().lowercase() !in protectedNames) { "Runtime ZIP contains protected user data: $name" }
    }

    fun requiredSpace(zipBytes: Long, unpackedBytes: Long): Long {
        require(zipBytes >= 0 && unpackedBytes >= 0) { "Invalid runtime ZIP sizes" }
        val reserve = maxOf(128L * 1024 * 1024, unpackedBytes / 20)
        return Math.addExact(Math.addExact(zipBytes, unpackedBytes), reserve)
    }

    fun requireSpace(available: Long, required: Long, location: String) {
        if (available < required) throw IOException(
            "运行时重装空间不足：$location 可用 ${available / (1024 * 1024)} MiB，需要至少 ${required / (1024 * 1024)} MiB（含 APK ZIP 缓存、解压及安全余量）；旧运行时未删除"
        )
    }

    fun copy(input: InputStream, output: OutputStream): Long {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            checkCancelled()
            val n = input.read(buffer)
            if (n < 0) break
            output.write(buffer, 0, n)
            total += n
        }
        return total
    }

    /** Output must be redirected to a file: never wait while an unread pipe can fill. */
    fun run(builder: ProcessBuilder, timeoutMs: Long): Int {
        checkCancelled()
        val process = builder.start()
        try {
            process.outputStream.close() // TeX may otherwise wait forever for interactive input.
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
            while (true) {
                checkCancelled()
                if (process.waitFor(100, TimeUnit.MILLISECONDS)) return process.exitValue()
                if (System.nanoTime() >= deadline) throw IOException("维护命令超时（${timeoutMs}ms）：${builder.command().first()}")
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            throw e
        } finally {
            // Always reap the direct child, including interruption and timeout paths.
            val interrupted = Thread.interrupted()
            try {
                if (process.isAlive) {
                    process.destroy()
                    if (!process.waitFor(500, TimeUnit.MILLISECONDS)) {
                        process.destroyForcibly()
                        process.waitFor(2_000, TimeUnit.MILLISECONDS)
                    }
                }
                process.inputStream.close()
                process.errorStream.close()
            } finally {
                if (interrupted) Thread.currentThread().interrupt()
            }
        }
    }
}
