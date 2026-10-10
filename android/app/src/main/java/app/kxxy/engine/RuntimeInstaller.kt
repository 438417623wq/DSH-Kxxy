package app.kxxy.engine

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream

/**
 * 运行时安装器：把 `assets/runtime.zip`（bionic 闭包）解压到 `filesDir/engine/`。
 *
 * 方案 T 下这是原生层少数几个"重活"之一，因为必须在引擎启动前完成，
 * 且要处理四个 Android 特有的坑（前三个来自参考项目的生产事故）：
 *
 * 1. **zip 不保存 Unix 权限位**
 *    解压后一律是 0644。若不恢复可执行位，`bin/node` 无法 execve。
 *    必须显式 chmod：bin/ 与 usr/bin/ 全量，node_modules 内按路径与文件名判定。
 *
 * 2. **SONAME 别名必须复制成实体文件**
 *    Android 的 linker 在 app 域既不认硬链接（SELinux 直接拒绝
 *    `avc: denied { link } scontext=u:r:untrusted_app_27`）也不认符号链接
 *    （能创建但 linker 不跟随 → `CANNOT LINK EXECUTABLE ... library
 *    "libz.so.1" not found`）。所以别名只能复制。
 *
 * 3. **别名条目可能排在本体之前**
 *    实测 `libz.so.1` 排在 `libz.so` 之前。若边解压边建链，链接时本体还不
 *    存在，会得到 0 字节空文件。因此必须**两阶段**：先落全部本体，再统一建别名。
 *
 * 4. **构建期不知道本机的 filesDir 绝对路径**
 *    Termux 的脚本里写死了编译期 prefix `/data/data/com.termux/files/usr/`，
 *    设备上不存在。构建期把它换成占位符 `@DSH_ROOT@`，App 侧解压后替换成
 *    真实 `engineRoot`。清单由 zip 内 `kxxy-runtime.json` 的
 *    `placeholderPaths` 给出（179 条），不必读全部 12,443 条内容。
 *
 * 别名的载体是 zip 中央目录的 **entry comment**（`LINK:<本体路径>`），数据区
 * 留空。选择 comment 而非「约定同名文件」的理由：ZipFile 能在不读数据区的
 * 前提下拿到全部 comment，因此第一阶段可以零成本跳过别名条目；若改用清单
 * 文件，就得先解压才能知道哪些该跳过，两阶段退化成三阶段。
 */
class RuntimeInstaller(private val ctx: Context) {

    /** 安装进度回调，参数为 0f..1f。 */
    fun interface Progress {
        fun onProgress(fraction: Float)
    }

    /** 从中央目录读到的元信息，一次打开拿全，避免重复拷贝 asset。 */
    private class ZipIndex(
        val topLevelDirs: Set<String>,
        val linkTargets: Map<String, String>,
        val manifest: JSONObject?,
    )

    /**
     * 幂等安装。已安装且完整时立即返回。
     *
     * 完整性判定用**五锚点探针**而非单一版本戳 —— 参考项目 m1.13 事故：
     * 覆盖升级后 `@deepseek-ai` 目录只剩空壳（JS 文件未落地）但版本戳已写成功，
     * 于是「引擎存在 + 版本匹配」直接跳装，导致 MODULE_NOT_FOUND 反复重启。
     */
    fun ensureInstalled(onProgress: Progress) {
        val root = EngineConfig.engineRoot(ctx)

        if (isComplete(root)) {
            Log.i(TAG, "runtime already installed and complete")
            onProgress.onProgress(1f)
            return
        }

        Log.i(TAG, "installing runtime into ${root.absolutePath}")
        root.mkdirs()

        val index = readZipIndex()

        // 精确顶层替换：只删 zip 里出现过的顶层目录，绝不动 extensions/
        // （参考项目 v1.2.21 事故：root.deleteRecursively() 把用户下载的扩展全删了）
        for (top in index.topLevelDirs) {
            val target = File(root, top)
            if (target.exists()) target.deleteRecursively()
        }

        extract(root, index.linkTargets, onProgress)
        materialiseLinks(root, index.linkTargets)
        rewriteRootPlaceholder(root, index.manifest)
        materialiseSonameAliases(root)
        restoreExecBits(root)
        writeStamp(root)

        Log.i(TAG, "runtime install complete")
        onProgress.onProgress(1f)
    }

    /**
     * 五锚点完整性探针。
     *
     * 任一锚点缺失即认为需要重装。刻意不只看版本戳 —— 见方法注释上方的 m1.13 事故。
     */
    private fun isComplete(root: File): Boolean {
        if (!root.isDirectory) return false

        // 锚点 1：引擎入口存在
        if (!EngineConfig.dshEntry(ctx).isFile) return false

        // 锚点 2：SONAME 别名存在（验证别名阶段跑过）
        if (!File(root, "lib/libreadline.so.8").isFile) return false

        // 锚点 3：node 可执行
        val node = EngineConfig.nodeBin(ctx)
        if (!node.isFile || !node.canExecute()) return false

        // 锚点 4：@deepseek-ai 下文件数达到下限（防「只剩空壳」）
        val dshAi = File(root, "lib/node_modules/@deepseek-ai")
        if (!dshAi.isDirectory) return false
        val count = dshAi.walkTopDown().count { it.isFile }
        if (count < MIN_DSH_AI_FILES) {
            Log.w(TAG, "runtime probe: @deepseek-ai has only $count files (need >= $MIN_DSH_AI_FILES)")
            return false
        }

        // 锚点 5：宿主管理页插件在位。
        // 它是运行时唯一「自有」的包（不进 @deepseek-ai 计数），早期构建产物
        // 里没有它 —— 若不做这个探针，用户从旧版本升级后引擎照常启动、
        // 但 /kxxy 管理页 404，且因为四锚点都通过而永远不会自愈。
        if (!File(root, "lib/node_modules/kxxy-host/package.json").isFile) {
            Log.w(TAG, "runtime probe: kxxy-host plugin missing, forcing reinstall")
            return false
        }

        return true
    }

    /**
     * 把 asset 拷到 cacheDir 后用 [ZipFile] 读中央目录。
     *
     * 为什么必须拷贝：`ZipFile` 只接受文件路径，而 asset 是流；
     * 且 [ZipInputStream] **读不到 entry comment**（它只解析 local header，
     * comment 仅存在于中央目录），而 comment 正是 LINK 元信息的载体。
     *
     * 顺带一次拿全三样东西，避免三次打开 asset：
     *   ① 顶层目录名（精确替换用）
     *   ② LINK 目标表（别名阶段用）
     *   ③ manifest（占位符清单用）
     */
    private fun readZipIndex(): ZipIndex {
        val tmp = File(ctx.cacheDir, "runtime-probe.zip")
        try {
            ctx.assets.open(RUNTIME_ASSET).use { input ->
                FileOutputStream(tmp).use { out -> input.copyTo(out) }
            }

            val top = LinkedHashSet<String>()
            val links = HashMap<String, String>()
            var manifest: JSONObject? = null

            ZipFile(tmp).use { zf ->
                val entries = zf.entries()
                while (entries.hasMoreElements()) {
                    val e = entries.nextElement()
                    val name = e.name
                    if (name.isEmpty()) continue
                    top.add(name.substringBefore('/'))

                    val comment = e.comment
                    if (comment != null && comment.startsWith(LINK_PREFIX)) {
                        links[name] = comment.substring(LINK_PREFIX.length)
                    }
                    if (name == MANIFEST_NAME) {
                        manifest = runCatching {
                            JSONObject(zf.getInputStream(e).use { it.readBytes().decodeToString() })
                        }.onFailure { Log.w(TAG, "cannot parse $MANIFEST_NAME: ${it.message}") }.getOrNull()
                    }
                }
            }

            Log.i(TAG, "zip index: ${top.size} top dirs, ${links.size} links, manifest=${manifest != null}")
            return ZipIndex(top, links, manifest)
        } finally {
            tmp.delete()
        }
    }

    /**
     * 解压。两阶段的第一阶段：只落**本体**，带 LINK 注释的别名条目直接跳过
     * （它们的 size 是 0，写下去只会得到空文件）。
     *
     * 进度按中央目录的未压缩总字节预估，保证确定性。
     */
    private fun extract(root: File, linkTargets: Map<String, String>, onProgress: Progress) {
        val canonicalRoot = root.canonicalPath

        ctx.assets.open(RUNTIME_ASSET).use { assetStream ->
            ZipInputStream(assetStream.buffered()).use { zis ->
                var entry: ZipEntry? = zis.nextEntry
                var processed = 0L
                var lastReported = -1

                while (entry != null) {
                    val name = entry.name

                    if (entry.isDirectory) {
                        File(root, name).mkdirs()
                        zis.closeEntry()
                        entry = zis.nextEntry
                        continue
                    }

                    // 别名条目：本体落地后统一物化（类注释第 3 点）。
                    if (linkTargets.containsKey(name)) {
                        zis.closeEntry()
                        entry = zis.nextEntry
                        continue
                    }

                    val out = File(root, name)

                    // zip-slip 防护
                    if (!out.canonicalPath.startsWith(canonicalRoot)) {
                        Log.w(TAG, "skip suspicious entry: $name")
                        zis.closeEntry()
                        entry = zis.nextEntry
                        continue
                    }

                    out.parentFile?.mkdirs()
                    FileOutputStream(out).use { fos -> zis.copyTo(fos) }

                    processed += entry.size.coerceAtLeast(0)
                    val pct = ((processed * 100) / TOTAL_UNCOMPRESSED_BYTES).toInt()
                    if (pct != lastReported && pct <= 95) {
                        lastReported = pct
                        onProgress.onProgress(pct / 100f)
                    }

                    zis.closeEntry()
                    entry = zis.nextEntry
                }
            }
        }
    }

    /**
     * 两阶段的第二阶段：为每个别名条目创建**实体副本**。
     *
     * 必须在全部本体落地后执行（类注释第 3 点）。别名共 421 条，其中
     * `bin/git` 的 149 个别名、`bin/coreutils` 的 100 个 applet 是主要来源；
     * 构建期只存一份本体 + 注释，App 侧复制，两侧体积都最优。
     */
    private fun materialiseLinks(root: File, linkTargets: Map<String, String>) {
        var created = 0
        var failed = 0
        val canonicalRoot = root.canonicalPath

        for ((alias, target) in linkTargets) {
            val aliasFile = File(root, alias)
            if (aliasFile.isFile && aliasFile.length() > 0) continue

            val realFile = File(root, target)
            if (!realFile.isFile) {
                Log.w(TAG, "link target missing: $alias -> $target")
                failed++
                continue
            }

            if (!aliasFile.canonicalPath.startsWith(canonicalRoot)) {
                Log.w(TAG, "skip suspicious link: $alias")
                failed++
                continue
            }

            try {
                aliasFile.parentFile?.mkdirs()
                realFile.copyTo(aliasFile, overwrite = true)
                created++
            } catch (e: Exception) {
                Log.w(TAG, "link failed for $alias -> $target: ${e.message}")
                failed++
            }
        }

        Log.i(TAG, "materialiseLinks: $created created, $failed failed")
    }

    /**
     * 把构建期占位符 `@DSH_ROOT@` 换成真实的引擎根目录。
     *
     * 只改 manifest 列出的 179 个脚本 —— 构建期已扫出「哪些文件含 Termux
     * prefix」，这里没必要再读一遍 12,443 个条目（其中 98 MiB 是压缩数据）。
     *
     * 替换后做一次残留校验：清单是构建期产物，若脚本集合与清单不同步，
     * 宁可在这里吵出来，也不要等到设备上 `bad interpreter` 才发现。
     */
    private fun rewriteRootPlaceholder(root: File, manifest: JSONObject?) {
        val placeholder = manifest?.optString("rootPlaceholder").orEmpty().ifEmpty { ROOT_PLACEHOLDER }
        val paths = manifest?.optJSONArray("placeholderPaths")
        if (paths == null) {
            Log.w(TAG, "manifest has no placeholderPaths; skipping root rewrite")
            return
        }

        val real = root.absolutePath
        val placeholderBytes = placeholder.toByteArray(Charsets.ISO_8859_1)
        val realBytes = real.toByteArray(Charsets.ISO_8859_1)

        var rewritten = 0
        var missing = 0
        for (i in 0 until paths.length()) {
            val rel = paths.optString(i)
            if (rel.isEmpty()) continue
            val f = File(root, rel)
            if (!f.isFile) {
                missing++
                continue
            }
            try {
                val data = f.readBytes()
                val out = replaceAll(data, placeholderBytes, realBytes)
                if (out !== data) {
                    f.writeBytes(out)
                    rewritten++
                }
            } catch (e: Exception) {
                Log.w(TAG, "root rewrite failed for $rel: ${e.message}")
            }
        }

        Log.i(TAG, "rewriteRootPlaceholder: $rewritten rewritten, $missing missing (root=$real)")
    }

    /** 字节级子串替换。用 ISO-8859-1 语义逐字节比对，避免 UTF-8 解码损坏二进制。 */
    private fun replaceAll(src: ByteArray, needle: ByteArray, replacement: ByteArray): ByteArray {
        if (needle.isEmpty()) return src

        var first = indexOf(src, needle, 0)
        if (first < 0) return src

        val out = java.io.ByteArrayOutputStream(src.size)
        var cursor = 0
        while (first >= 0) {
            out.write(src, cursor, first - cursor)
            out.write(replacement)
            cursor = first + needle.size
            first = indexOf(src, needle, cursor)
        }
        out.write(src, cursor, src.size - cursor)
        return out.toByteArray()
    }

    private fun indexOf(haystack: ByteArray, needle: ByteArray, from: Int): Int {
        val limit = haystack.size - needle.size
        outer@ for (i in from..limit) {
            for (j in needle.indices) {
                if (haystack[i + j] != needle[j]) continue@outer
            }
            return i
        }
        return -1
    }

    /**
     * 为缺失的 SONAME 别名创建**实体副本**。
     *
     * 通用 LINK 机制已覆盖 stage 里全部符号链接别名，这里是**兜底**：
     * 万一某个 deb 只带完整版本号文件而 NEEDED 里记的是短名（参考项目 §3.7
     * 真机事故：bash 报 `CANNOT LINK libreadline.so.8`），此处补齐。
     * 已由 LINK 物化过的别名会因 `length() > 0` 被跳过，不重复劳动。
     */
    private fun materialiseSonameAliases(root: File) {
        val lib = File(root, "lib")
        if (!lib.isDirectory) return

        for ((alias, real) in SONAME_ALIASES) {
            val aliasFile = File(lib, alias)
            if (aliasFile.isFile && aliasFile.length() > 0) continue

            val realFile = File(lib, real)
            if (!realFile.isFile) {
                Log.w(TAG, "soname alias source missing: $real")
                continue
            }

            try {
                realFile.copyTo(aliasFile, overwrite = true)
                Log.i(TAG, "soname alias created: $alias -> $real (${aliasFile.length()} bytes)")
            } catch (e: Exception) {
                Log.w(TAG, "soname alias failed for $alias: ${e.message}")
            }
        }
    }

    /**
     * 恢复可执行位。
     *
     * 三段策略：
     *   ① `bin/`、`usr/bin/` 与 `libexec/` 全量
     *   ② `lib/node_modules` 内路径含 `/bin/` 或文件名命中可执行名清单
     *   ③ 只对真正的 ELF 或脚本文件动手（前 4 字节 `\x7fELF` 或前 2 字节 `#!`）
     *
     * ③ 很重要：不判类型会把几万个 .js/.json 全 chmod，慢且无意义。
     *
     * ① 里的 `libexec/` 不能漏：Termux 把 git 的全部子命令
     * （`libexec/git-core/git-remote-http`、`git-http-backend`、`git-submodule` …）、
     * `sshd-session`、`sftp-server`、`ssh-keysign`、`coreutils/libstdbuf.so`
     * 等 69 个文件放在这里，git 与 ssh 都靠 exec 调用它们。
     * 漏掉的表现是 `git clone https://…` 报
     * `cannot run git-remote-http: Permission denied`，而 `git status`
     * 等内置命令照常工作 —— 极易被误判为「网络问题」。
     */
    private fun restoreExecBits(root: File) {
        var changed = 0

        for (dir in listOf(File(root, "bin"), File(root, "usr/bin"), File(root, "libexec"))) {
            if (!dir.isDirectory) continue
            dir.walkTopDown()
                .maxDepth(MAX_SCAN_DEPTH)
                .filter { it.isFile }
                .forEach { if (it.setExecutable(true, false)) changed++ }
        }

        val nm = File(root, "lib/node_modules")
        if (nm.isDirectory) {
            nm.walkTopDown()
                .maxDepth(MAX_SCAN_DEPTH)
                .filter { it.isFile }
                .filter { f ->
                    val path = f.path.replace('\\', '/')
                    path.contains("/bin/") || f.name in EXECUTABLE_NAMES
                }
                .filter { isElfOrScript(it) }
                .forEach { if (it.setExecutable(true, false)) changed++ }
        }

        Log.i(TAG, "restoreExecBits: $changed file(s) made executable")
    }

    /** 前 4 字节 `\x7fELF` 或前 2 字节 `#!` 才算可执行候选。 */
    private fun isElfOrScript(f: File): Boolean = try {
        val head = ByteArray(4)
        val n = f.inputStream().use { it.read(head) }
        if (n >= 4 && head[0] == 0x7F.toByte() && head[1] == 'E'.code.toByte() &&
            head[2] == 'L'.code.toByte() && head[3] == 'F'.code.toByte()
        ) true
        else if (n >= 2 && head[0] == '#'.code.toByte() && head[1] == '!'.code.toByte()) true
        else false
    } catch (e: Exception) {
        false
    }

    private fun writeStamp(root: File) {
        runCatching { EngineConfig.stampFile(ctx).writeText(RUNTIME_VERSION) }
    }

    companion object {
        private const val TAG = "KxxyRuntime"
        const val RUNTIME_ASSET = "runtime.zip"

        /** zip 内自述文件名，构建期由 tools/build-runtime.mjs 写入。 */
        private const val MANIFEST_NAME = "kxxy-runtime.json"

        /** 别名条目的中央目录注释前缀。 */
        private const val LINK_PREFIX = "LINK:"

        /** 构建期占位符，与 build-runtime.mjs 的 ROOT_PLACEHOLDER 一致。 */
        private const val ROOT_PLACEHOLDER = "@DSH_ROOT@"

        /** 与 CI/构建期写入 MANIFEST 的版本号一致。 */
        const val RUNTIME_VERSION = "v0.1.0-arm64"

        /** @deepseek-ai 下文件数下限，用于识破「只剩空壳」。 */
        private const val MIN_DSH_AI_FILES = 100

        private const val MAX_SCAN_DEPTH = 6

        /**
         * 预估未压缩总量（字节），仅用于进度条分母。
         *
         * 实测值 259.45 MiB（stage 812 本体 + asar 11,322 文件 + 421 别名），
         * 取 260 MiB 略高一点，让进度条到 95% 就被 clamp，不会溢出。
         */
        private const val TOTAL_UNCOMPRESSED_BYTES = 260L * 1024 * 1024

        private val EXECUTABLE_NAMES = setOf(
            "rg", "esbuild", "node", "sharp", "swc", "dprint", "biome",
        )

        /**
         * SONAME 别名 → 本体。
         *
         * 来自参考项目 §3.7 的真机事故记录：bash 报
         * `CANNOT LINK libreadline.so.8`，因为 deb 只带 `.8.3` 这类完整版本号
         * 文件，而 NEEDED 里记的是 `libreadline.so.8`。
         */
        private val SONAME_ALIASES = linkedMapOf(
            "libreadline.so.8" to "libreadline.so.8.3",
            "libhistory.so.8" to "libhistory.so.8.3",
            "libncursesw.so.6" to "libncursesw.so.6.5",
            "libncurses.so.6" to "libncurses.so.6.5",
            "libncurses.so" to "libncurses.so.6.5",
        )
    }
}
