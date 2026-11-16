package app.kxxy.engine

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** Read-only child process runner. Waiting and BOTH pipe drains share a real deadline. */
internal object RecoveryProcessRunner {
    enum class Status { EXITED, TIMED_OUT, EXECUTION_FAILED }
    data class Output(val status: Status, val exitCode: Int?, val text: String, val truncated: Boolean) {
        val ok: Boolean get() = status == Status.EXITED && exitCode == 0
    }

    suspend fun run(builder: ProcessBuilder, timeoutMs: Long = 45_000, maxBytes: Int = 256 * 1024): Output =
        withContext(Dispatchers.IO) {
            require(timeoutMs > 0 && maxBytes >= 2)
            currentCoroutineContext().ensureActive()
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
            val process = try { builder.start() } catch (e: Exception) {
                currentCoroutineContext().ensureActive()
                return@withContext Output(Status.EXECUTION_FAILED, null, "无法执行诊断命令：${e.message}", false)
            }
            val out = Drain(process.inputStream, maxBytes / 2)
            val err = Drain(process.errorStream, maxBytes - maxBytes / 2)
            out.start(); err.start()
            try {
                // Dumps do not need stdin. Do not leave a child waiting for inherited input.
                process.outputStream.close()
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val remaining = deadline - System.nanoTime()
                    if (remaining <= 0) {
                        return@withContext output(Status.TIMED_OUT, null, out, err, "诊断命令超时（${timeoutMs}ms）")
                    }
                    if (process.waitFor(minOf(remaining, TimeUnit.MILLISECONDS.toNanos(50)), TimeUnit.NANOSECONDS)) break
                }
                // A descendant can retain a pipe after the direct child exits: EOF also has a deadline.
                while (out.isAlive || err.isAlive) {
                    currentCoroutineContext().ensureActive()
                    if (System.nanoTime() >= deadline) {
                        return@withContext output(Status.TIMED_OUT, null, out, err, "诊断输出排空超时（${timeoutMs}ms）")
                    }
                    out.join(20); err.join(20)
                }
                val readError = out.error ?: err.error
                if (readError != null) output(Status.EXECUTION_FAILED, null, out, err, "诊断输出读取失败：${readError.message}")
                else output(Status.EXITED, process.exitValue(), out, err)
            } finally {
                // On Windows/JVM destroyForcibly itself can wait behind a blocked pipe-reader lock.
                // Schedule termination first, but never let cleanup defeat timeout/cancellation delivery.
                Thread({
                    runCatching { if (process.isAlive) process.destroyForcibly() }
                    runCatching { process.inputStream.close() }
                    runCatching { process.errorStream.close() }
                    runCatching { process.outputStream.close() }
                }, "recovery-pipe-close").apply { isDaemon = true; start() }
            }
        }

    private fun output(status: Status, code: Int?, out: Drain, err: Drain, prefix: String = ""): Output {
        val truncated = out.truncated || err.truncated
        val text = listOf(prefix, out.text(), err.text(), if (truncated) "[诊断输出已限长，保留首尾]" else "")
            .filter { it.isNotBlank() }.joinToString("\n")
        return Output(status, code, text, truncated)
    }

    /** Bounded first/last byte capture; still consumes every byte, even after the cap. */
    private class Drain(private val input: InputStream, cap: Int) : Thread("recovery-pipe-drain") {
        private val head = ByteArray((cap + 1) / 2)
        private val tail = ByteArray(cap / 2)
        private var headSize = 0
        private var tailSize = 0
        private var cursor = 0
        @Volatile var truncated = false
            private set
        @Volatile var error: Exception? = null
            private set
        init { isDaemon = true }
        override fun run() {
            try {
                val bytes = ByteArray(8192)
                while (true) {
                    val n = input.read(bytes)
                    if (n < 0) break
                    synchronized(this) {
                        for (i in 0 until n) {
                            if (headSize < head.size) head[headSize++] = bytes[i]
                            else if (tail.isNotEmpty()) {
                                if (tailSize == tail.size) truncated = true else tailSize++
                                tail[cursor] = bytes[i]
                                cursor = (cursor + 1) % tail.size
                            } else truncated = true
                        }
                    }
                }
            } catch (e: Exception) { error = e }
        }
        fun text(): String = synchronized(this) {
            val bytes = ByteArray(headSize + tailSize)
            head.copyInto(bytes, endIndex = headSize)
            val start = if (tailSize == tail.size) cursor else 0
            for (i in 0 until tailSize) bytes[headSize + i] = tail[(start + i) % tail.size]
            if (!truncated) String(bytes, Charsets.UTF_8)
            else String(bytes, 0, headSize, Charsets.UTF_8) + "\n[...truncated...]\n" +
                String(bytes, headSize, tailSize, Charsets.UTF_8)
        }
    }
}
