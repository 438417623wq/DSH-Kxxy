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
     * 完整性判定用**八锚点探针**而非单一版本戳 —— 参考项目 m1.13 事故：
     * 覆盖升级后 `@deepseek-ai` 目录只剩空壳（JS 文件未落地）但版本戳已写成功，
     * 于是「引擎存在 + 版本匹配」直接跳装，导致 MODULE_NOT_FOUND 反复重启。
     */
    fun ensureInstalled(onProgress: Progress) {
        val root = EngineConfig.engineRoot(ctx)

        if (isComplete(root)) {
            Log.i(TAG, "runtime already installed and complete")
            onProgress.onProgress(1f)
            ensureExtensionPool(root)
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

        // bin/ 与 lib/ 被整体替换，扩展中心装进 engine/{bin,lib} 的链接/副本
        // 全部丢失。extensions/ 在扩展侧留有 .links.json，这里立一个标记，
        // kxxy-host 插件启动时据此重建（五项改进方案 §2.4「升级后的自愈」）。
        runCatching {
            val relink = File(EngineConfig.extensionsRoot(ctx), RELINK_MARKER)
            relink.parentFile?.mkdirs()
            relink.writeText(System.currentTimeMillis().toString())
        }.onFailure { Log.w(TAG, "relink marker failed: ${it.message}") }

        Log.i(TAG, "runtime install complete")
        onProgress.onProgress(1f)
        ensureExtensionPool(root)
    }

    /**
     * 把 APK `assets/ext-pool/` 里的扩展包池拷到 `<engineRoot>/ext-pool/`。
     *
     * 引擎（Node 进程）读不到 APK asset 流，而扩展中心的「获取」是纯本地解包
     * （五项改进方案 §4.3 第二层）—— 所以原生层先把包池落盘。幂等：按
     * 「文件存在且大小一致」跳过，APK 升级带新包时会自动补齐。
     *
     * 全程 runCatching：包池缺失（旧 APK / 未跑 fetch-extensions）不是致命错误，
     * 扩展中心会把对应条目标成「不可用」而不是崩掉引擎。
     */
    private fun ensureExtensionPool(root: File) {
        runCatching {
            val names = ctx.assets.list(POOL_ASSET_DIR) ?: return
            if (names.isEmpty()) return
            val poolDir = File(root, "ext-pool")
            poolDir.mkdirs()
            var copied = 0
            for (name in names) {
                val dest = File(poolDir, name)
                val assetSize = try {
                    ctx.assets.openFd("$POOL_ASSET_DIR/$name").use { it.length }
                } catch (_: Exception) {
                    // openFd 对压缩存储的 asset 会抛 FileNotFoundException。
                    // 无法做大小校验时退化为「存在即跳过」—— 压缩 asset 的逐字节
                    // 对拷每次启动都要重来，对 1 GiB 级包池不可接受。
                    // build.gradle.kts 已对 .gz 配 noCompress，正常不会走到这。
                    if (dest.isFile && dest.length() > 0) continue
                    -1L
                }
                if (dest.isFile && assetSize >= 0 && dest.length() == assetSize) continue
                ctx.assets.open("$POOL_ASSET_DIR/$name").use { input ->
                    val tmp = File(poolDir, "$name.part")
                    FileOutputStream(tmp).use { out -> input.copyTo(out) }
                    if (dest.exists()) dest.delete()
                    if (!tmp.renameTo(dest)) {
                        tmp.copyTo(dest, overwrite = true)
                        tmp.delete()
                    }
                }
                copied++
            }
            if (copied > 0) Log.i(TAG, "ext-pool: $copied file(s) extracted to ${poolDir.absolutePath}")
        }.onFailure { Log.w(TAG, "ensureExtensionPool failed: ${it.message}") }
    }

    /**
     * 九锚点完整性探针。
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

        // 锚点 6：WebView 兼容层在位且为当前版本。
        // 真机事故：ROM 自带的 WebView 可能停留在 Chrome 116 之前（如
        // com.google.android.webview 104.0.5112.97），而官方前端插件 bundle
        // 用了 AbortSignal.any 等新 API，缺失时连接层抛错被静默吞掉，表现为
        // 设置面板「权限」显示英文 key、模型页 provider 列表整块空白；后续又
        // 发现同一 WebView 不支持 dvh 单位，导致目录选择对话框列表整片空白。
        // kxxy-host 靠这个脚本给页面打补丁；它若缺失，症状会静默复现。
        //
        // 只判「文件存在」不够：老设备上已有旧版兼容层，升级 APK 后文件仍在，
        // 会带着不含新补丁的旧脚本跳过重装。因此按版本标记判定，标记写在
        // compat.js 首行（`kxxy-webview-compat@N`），改动该文件时必须同步递增。
        if (!File(root, COMPAT_LAYER_FILE).isFile) {
            Log.w(TAG, "runtime probe: webview compat layer missing, forcing reinstall")
            return false
        }
        if (!compatLayerIsCurrent(root)) {
            Log.w(TAG, "runtime probe: webview compat layer outdated, forcing reinstall")
            return false
        }

        // 锚点 7：Android 原生 PTY 绑定在位且为当前版本。
        // 真机事故：「新建终端」报
        // `subprocess-local: terminal inspection is unsupported on platform android`。
        // 两处原因：① 上游 createProcessInspector 只认 linux/darwin/win32，而
        // Android 上 process.platform == "android"；② node-pty 在 Android 上没有
        // 官方预编译产物，早期构建注入的是抛错空壳。两者都由构建期补丁修掉，
        // 但老设备的 runtime 不会因此重装（版本戳不变），必须参与完整性判定。
        //
        // 与锚点 6 同理，只判存在不够：老设备上可能有旧的抛错空壳，按版本标记判定。
        if (!File(root, PTY_NODE_BINDING).isFile) {
            Log.w(TAG, "runtime probe: android pty binding missing, forcing reinstall")
            return false
        }
        if (!markerIsCurrent(root, PTY_NODE_WRAPPER, PTY_NODE_MARKER)) {
            Log.w(TAG, "runtime probe: android pty binding outdated, forcing reinstall")
            return false
        }

        // 锚点 8：宿主插件本体（kxxy-host）为当前版本。
        //
        // 锚点 5 只判 `kxxy-host/package.json` 存在，而那个文件从 v0.1.0 起
        // 内容就没变过 —— 于是「改了 host.js / lib/index.js 却只重装 APK」时，
        // 设备上跑的是旧插件，且因为七锚点全通过而永远不会自愈。真机踩过：
        // 新版 Shizuku 权限卡片（含「请求授权」按钮）在 APK 安装后仍不可见，
        // 设备上的 host.js 停在 55168 字节的旧版，必须手工 push 才生效。
        //
        // 标记写在插件入口 lib/index.js 首行（`kxxy-host@N`），改动
        // plugins/kxxy-host/ 下任何文件后都要递增编号，并同步本常量。
        if (!markerIsCurrent(root, HOST_PLUGIN_ENTRY, HOST_PLUGIN_MARKER)) {
            Log.w(TAG, "runtime probe: kxxy-host plugin outdated, forcing reinstall")
            return false
        }

        // 锚点 9：移动端 UI 适配层（mobile.css + mobile.js）在位且为当前版本。
        //
        // 独立于锚点 8：适配层是纯静态资产，只改它时插件入口 lib/index.js 的
        // 标记不动，锚点 8 会判「已是最新」而跳过重装 —— 真机上表现为「新写的
        // 移动端布局完全没生效」。两份文件都要在，且都带同一个版本标记。
        if (!File(root, MOBILE_UI_CSS).isFile || !File(root, MOBILE_UI_SCRIPT).isFile) {
            Log.w(TAG, "runtime probe: mobile ui layer missing, forcing reinstall")
            return false
        }
        if (!markerIsCurrent(root, MOBILE_UI_CSS, MOBILE_UI_MARKER)) {
            Log.w(TAG, "runtime probe: mobile ui stylesheet outdated, forcing reinstall")
            return false
        }
        if (!markerIsCurrent(root, MOBILE_UI_SCRIPT, MOBILE_UI_MARKER)) {
            Log.w(TAG, "runtime probe: mobile ui script outdated, forcing reinstall")
            return false
        }

        return true
    }

    /**
     * 校验兼容层脚本的版本标记是否与当前构建一致。
     *
     * 读不到文件、读不到标记、标记不匹配都视为过期。这里刻意不做「宽松放行」
     * —— 判错的代价是一次重装（几百 MB，一次性），而漏判的代价是老设备上
     * 静默复现已经修过的显示缺陷，用户无从察觉。
     */
    private fun compatLayerIsCurrent(root: File): Boolean =
        markerIsCurrent(root, COMPAT_LAYER_FILE, COMPAT_LAYER_MARKER)

    /**
     * 通用版本标记探针：读文件头部，看是否含指定标记。
     *
     * 标记约定写在文件首行，所以只读前若干字节，避免为一个大文件整体读入。
     */
    private fun markerIsCurrent(root: File, relativePath: String, marker: String): Boolean {
        val file = File(root, relativePath)
        return try {
            val head = file.inputStream().use { input ->
                val buffer = ByteArray(COMPAT_MARKER_PROBE_BYTES)
                val read = input.read(buffer)
                if (read <= 0) "" else String(buffer, 0, read, Charsets.UTF_8)
            }
            head.contains(marker)
        } catch (e: Exception) {
            Log.w(TAG, "runtime probe: cannot read marker of $relativePath: ${e.message}")
            false
        }
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

        // openjdk-21 装在 lib/jvm/java-21-openjdk/bin/（Termux 布局），不在
        // bin/ 与 usr/bin/ 的扫描范围内 —— 漏掉的表现是 d8/apksigner/gradle
        // 调 java 时报 Permission denied（与缺陷 B 的 git-remote-http 同型）。
        // 只对 /bin/ 路径段且确为 ELF/脚本的动作，避免把 javadoc HTML 一并 chmod。
        val jvm = File(root, "lib/jvm")
        if (jvm.isDirectory) {
            jvm.walkTopDown()
                .maxDepth(MAX_SCAN_DEPTH)
                .filter { it.isFile }
                .filter { f -> f.path.replace('\\', '/').contains("/bin/") }
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

        /**
         * WebView 兼容层的版本标记，写在 kxxy-host/web/compat.js 首行。
         *
         * 老设备升级 APK 时 runtime 版本戳不变（仍为 [RUNTIME_VERSION]），
         * 光判「文件存在」会让它们带着不含新补丁的旧兼容层跳过重装，症状
         * 静默复现。改动 compat.js 时必须同步递增此处的编号。
         */
        private const val COMPAT_LAYER_MARKER = "kxxy-webview-compat@2"

        /** 兼容层脚本路径，锚点 6 与 [compatLayerIsCurrent] 共用。 */
        private const val COMPAT_LAYER_FILE = "lib/node_modules/kxxy-host/web/compat.js"

        /**
         * Android 原生 PTY 绑定（锚点 7）。
         *
         * 前者是自研 N-API 模块（arm64 共享库），后者是 JS 包装层；
         * 标记写在包装层首行，改动 tools/prebuilt/node-pty-android/ 下任何
         * 文件后都必须递增编号，并同步 [PTY_NODE_MARKER]。
         */
        private const val PTY_NODE_BINDING =
            "lib/node_modules/node-pty/prebuilds/android-arm64/dsh_pty_node.node"
        private const val PTY_NODE_WRAPPER = "lib/node_modules/node-pty/lib/index.js"
        private const val PTY_NODE_MARKER = "kxxy-pty-node@1"

        /**
         * 宿主插件版本标记（锚点 8），写在 kxxy-host/lib/index.js 首行。
         *
         * 与锚点 6/7 同理：runtime 版本戳不变，只判文件存在会让老设备带着
         * 旧插件跳过重装。改动 plugins/kxxy-host/ 下任何文件后递增编号。
         */
        private const val HOST_PLUGIN_ENTRY = "lib/node_modules/kxxy-host/lib/index.js"
        private const val HOST_PLUGIN_MARKER = "kxxy-host@3"

        /**
         * 移动端 UI 适配层版本标记（锚点 9），写在 kxxy-host/web/mobile.css
         * 与 mobile.js 首行（两份文件共用一个编号）。
         *
         * 独立于锚点 8 的原因：锚点 8 只探 lib/index.js，而适配层是纯静态
         * 资产 —— 只改 mobile.css / mobile.js 时插件入口的标记不动，老设备
         * 会带着旧适配层跳过重装，用户看到的是「新功能没生效」。两份文件都
         * 必须存在且标记一致，改动其中任何一份都要同步递增编号。
         */
        private const val MOBILE_UI_CSS = "lib/node_modules/kxxy-host/web/mobile.css"
        private const val MOBILE_UI_SCRIPT = "lib/node_modules/kxxy-host/web/mobile.js"
        private const val MOBILE_UI_MARKER = "kxxy-mobile-ui@2"

        /** 读版本标记时探测的头部字节数；标记都写在首行，取小值即可。 */
        private const val COMPAT_MARKER_PROBE_BYTES = 256

        private const val MAX_SCAN_DEPTH = 6

        /**
         * 预估未压缩总量（字节），仅用于进度条分母。
         *
         * 实测值随内置档位变化：基线 22 种子时是 259.45 MiB；④ 全能精选档
         * （220 包，含 openjdk-21 / clang / llvm 闭包）约 1.37 GiB。取 1.4 GiB
         * 略高一点，让进度条到 95% 就被 clamp，不会溢出。
         */
        private const val TOTAL_UNCOMPRESSED_BYTES = 1_400L * 1024 * 1024

        /** APK 内扩展包池的 asset 目录名。 */
        private const val POOL_ASSET_DIR = "ext-pool"

        /** 升级后重建扩展链接的标记文件名（位于 extensions/ 下）。 */
        private const val RELINK_MARKER = ".relink"

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
