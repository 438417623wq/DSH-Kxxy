package app.kxxy.engine

import android.content.Context
import android.net.ConnectivityManager
import android.util.Log
import app.kxxy.BuildConfig
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.LinkOption
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
 * 2. **别名必须建成符号链接，绝不能复制成实体文件**（缺陷 DD，真机 A/B 定案）
 *    这里原先写着「Android 的 linker 在 app 域既不认硬链接也不认符号链接，
 *    所以别名只能复制」—— **该结论是错的**，真机 `run-as app.kxxy`
 *    （`u:r:runas_app:s0:c129,c257,c512,c768`）实测：跨目录、多级、绝对、
 *    相对四种软链全部可 exec、可读、可被 linker 跟随。见 [materialiseLinks]。
 *    硬链接确实不可用（SELinux 拒绝 `link`），但那是另一回事。
 *
 *    复制真正破坏的是**依赖自身位置的程序**：`$ORIGIN` 与 `$0`。`bin/java`
 *    的 RUNPATH 含 `$ORIGIN:$ORIGIN/../lib`，副本落在 `<root>/bin` 后
 *    `$ORIGIN` 变成 `<root>/bin`，于是 `CANNOT LINK ... "libjli.so" not found`；
 *    `mvn` 脚本用 `dirname "$0"/..` 推 `MAVEN_HOME`，副本从 `<root>/bin`
 *    上溯得到 `<root>`，`boot/classworlds.jar` 不在那儿。只有「别名与本体
 *    同目录」时复制才是等价替换。
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
     * 完整性判定用**十一锚点探针**而非单一版本戳 —— 参考项目 m1.13 事故：
     * 覆盖升级后 `@deepseek-ai` 目录只剩空壳（JS 文件未落地）但版本戳已写成功，
     * 于是「引擎存在 + 版本匹配」直接跳装，导致 MODULE_NOT_FOUND 反复重启。
     */
    fun ensureInstalled(onProgress: Progress) {
        val root = EngineConfig.engineRoot(ctx)

        // 锚点 15 的**安装前自愈**，必须早于 isComplete()。
        //
        // `corepack enable` / `corepack disable` 会合法地改写或删除
        // `bin/{corepack,npm,npx,pnpm}`：enable 换成指向 `dist/` 的软链（软链目标
        // 落盘是 0600，`pnpm` 报 `Permission denied`），disable 干脆把文件删掉
        // （实测 `ls: cannot access '…/bin/pnpm': No such file or directory`）。
        // 两者都是 corepack 官方文档里的命令，用户敲一次就整包重装 741 MiB 显然
        // 不对 —— 这些状态全都能就地修好。`bin/node` 在说明 runtime 已装过，
        // 此时才动；全新安装由 extract 从 zip 里取，不需要这里插手。
        if (File(root, "bin/node").isFile) healPackagingWrappers(root)

        if (isComplete(root)) {
            Log.i(TAG, "runtime already installed and complete")
            onProgress.onProgress(1f)
            // 缺陷 DD：老设备上 1618 条别名全是复制出来的实体，`bin/java`
            // 找不到 `libjli.so`、`bin/mvn` 推出错的 `MAVEN_HOME`。这一步把
            // 它们按安装期落下的清单改回符号链接；新装的设备上跑一遍全是
            // 「已是软链」的 no-op。放在最前面，后续步骤都在正确的形态上干活。
            healCopiedAliases(root)
            // 可执行位规则会随版本演进，而它**不是**锚点能表达的资产变更：
            // 文件全都在、标记也匹配，只是某几个文件的 mode 不够。所以这条
            // 修复单独走「每次启动都跑一次」的幂等路径（缺陷 AW）。
            ensureJvmExecBits(root)
            // SONAME 别名表会随版本增删（缺陷 BJ 新增了 `libc++.so` /
            // `libc++abi.so`），而它**不是**锚点能表达的资产变更：runtime.zip
            // 没变、标记也没变，只是别名表多了一项。所以和 ensureJvmExecBits
            // 一样走「每次启动都跑一次」的幂等路径 —— 已存在的别名会因
            // `length() > 0` 被跳过，开销就是几次 stat。
            materialiseSonameAliases(root)
            // texlinks 必须先于 ensureTexFormats —— 前者把 `bin/pdflatex` 这类
            // 标准名建出来，而格式生成虽然直接用 `bin/pdftex`/`bin/luahbtex`
            // 这类引擎本名（不依赖别名），但用户敲的是标准名，两个都到位才完整。
            ensureTexLinks(root)
            ensureTexFormats(root)
            ensureNoShadowingStubs(root)
            ensureEmacsSiteLoad(root)
            // 缺陷 CU：guile 的 `.go` 与 `.scm` 的 mtime 先后决定 gdb 是否卡死。
            // 扩展解包会把 `.scm` 的 mtime 抬到「现在」，而 pool 里的 `.go`
            // 是打包时刻（poolextract 统一写 mtime=0）—— 于是每次启动 guile
            // 都认为缓存过期、在内存里重编 boot-9.scm（分钟级），表现为
            // `gdb --version` 无输出、被 SIGKILL。必须每次启动都校一次。
            ensureGuileCcacheFresh(root)
            // 缺陷 CV：fontconfig 的 `<dir>` 不含 kxxy-host/fonts，中文 PDF 的
            // 字体永远找不到。这里落一份自建配置并用 FONTCONFIG_FILE 指过去
            // （不能改 etc/fonts/fonts.conf —— 那是扩展池的软链，重装即覆盖）。
            ensureFontConfig(root)
            // 缺陷 CW：TeX 的 `web2c/mktex*` 缺可执行位（extract 用
            // FileOutputStream 写出，忽略 zip 条目的 unix mode），于是
            // `mktextfm: 1: .../mktexnam: Permission denied`。
            ensureTexExecBits(root)
            // exec 重写器每次启动都从 APK 覆盖一次（缺陷 CF）。APK 升级后
            // nativeLibraryDir 会换，而 LD_PRELOAD 里写的是 <root>/lib 下的
            // 稳定路径，必须保证那份是**当前这个 APK 编译出来的**版本 ——
            // 否则重写逻辑改动不会生效，还会出现「半新半旧」的诡异行为。
            installExecShim(root)
            ensureDshWrapper(root)
            // 旧设备盘上 26 个别名脚本的 shebang 还是字面量 @DSH_ROOT@
            // （缺陷 CE 的历史残留），靠这一趟自愈，不必重装 runtime。
            repairPlaceholderScripts(root)
            // resolv.conf 随网络变化，必须每次启动重算（缺陷 CJ）。
            ensureResolvConf(root)
            ensureExtensionPool(root)
            ensureTmpDir(ctx)
            // texlive 与 perl 扩展都是**按需安装**的：全新设备上安装期这一趟
            // 跑得比扩展解包早，`bin/xetex` 还不存在，于是 ensureTexFormats
            // 打一句「pdftex/xetex/luahbtex 全缺，跳过格式生成」就放弃了 ——
            // 而它只在安装期跑过一次，之后用户装了 texlive 也没人来补。
            // 真机症状：`xelatex --version` 正常，但一编译就
            // `I can't find the format file 'xelatex.fmt'!`，pandoc 全链路失败
            // （缺陷 CX 的下游 —— 上游是 perl 的 @INC 指到 Termux 死路径，
            // 见 EngineConfig.buildEnv 里的 PERL5LIB）。
            //
            // **顺序**：texlinks 先、formats 后。texlinks 建出 `bin/xelatex`
            // 这类标准名，formats 用引擎本名（xetex）生成 `.fmt`，用户敲的
            // 是标准名，两个都到位才完整。
            //
            // 两趟都幂等（四个标准名齐了只剩 4 次 exists()，三个 `.fmt`
            // 齐了只剩 3 次 stat），所以放进每次启动的路径是安全的；
            // `.fmt` 的判据含文件大小，生成到一半被杀也会重来。
            ensureTexLinks(root)
            ensureTexFormats(root)
            return
        }

        Log.i(TAG, "installing runtime into ${root.absolutePath}")
        root.mkdirs()

        val index = readZipIndex()

        // 精确顶层替换：只删 zip 里出现过的顶层目录，绝不动 extensions/
        // （参考项目 v1.2.21 事故：root.deleteRecursively() 把用户下载的扩展全删了）
        for (top in index.topLevelDirs) {
            val target = File(root, top)
            if (target.exists()) deleteTreeSafely(target)
        }

        extract(root, index.linkTargets, onProgress)
        // ⚠️ 顺序曾是**语义要求**，缺陷 DD 改成软链后它退化成「无害但保留」。
        //
        // 历史上这里是「先物化链接、再改写占位符」，而物化用的是 `copyTo`：
        // 复制的是当时盘上的本体，此刻本体 shebang 还是字面量
        // `#!@DSH_ROOT@/bin/python3.14`；等 `rewriteRootPlaceholder` 跑起来，
        // 它改的是**本体**，别名那份副本已经固化在盘上了。真机症状：
        //   · `bin/pip`（本体）正常；
        //   · `bin/pip3`（别名副本）首行是 `#!@DSH_ROOT@/bin/python3.14`。
        //
        // 改成软链后别名不再持有字节，占位符改写对本体的效果天然传导到别名，
        // 先后顺序不再影响正确性。仍然保持「先改写、后建链」，一是因为语义更
        // 直观，二是 [materialiseLinks] 的 `realFile.isFile` 检查要求本体已落地。
        rewriteRootPlaceholder(root, index.manifest)
        materialiseLinks(root, index.linkTargets)
        materialiseSonameAliases(root)
        installExecShim(root)
        ensureDshWrapper(root)
        ensureResolvConf(root)
        restoreExecBits(root)
        ensureJvmExecBits(root)
        ensureTexLinks(root)
        ensureTexFormats(root)
        ensureNoShadowingStubs(root)
        ensureEmacsSiteLoad(root)
        ensureGuileCcacheFresh(root)
        ensureFontConfig(root)
        ensureTexExecBits(root)
        ensureTmpDir(ctx)
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

        // 上面 :106/:107 那两趟是在扩展尚未解包时跑的（全新安装时 `extensions/`
        // 还是空的，`texlinks` 与各引擎都不在），必然静默跳过。包池落盘后如果
        // 扩展已经就位（升级/重装场景），这里补跑一次就能立刻可用，不必等下一次
        // 启动走快路径。两个函数都是幂等的，且引擎缺失时开销接近零。
        ensureTexLinks(root)
        ensureTexFormats(root)
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
     * 十一锚点完整性探针。
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
        if (!File(root, MODERN_LAYER_FILE).isFile) {
            Log.w(TAG, "runtime probe: webview modern layer missing, forcing reinstall")
            return false
        }
        if (!compatLayerIsCurrent(root)) {
            Log.w(TAG, "runtime probe: webview compat layer outdated, forcing reinstall")
            return false
        }
        if (!modernLayerIsCurrent(root)) {
            Log.w(TAG, "runtime probe: webview modern layer outdated, forcing reinstall")
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
        // 判据是**内容指纹**而不是人手编号，理由见 [HOST_PLUGIN_FP_FILE] 的注释：
        // 这一个人工数字实际管辖整个插件目录，漏递增的症状是「装完什么都没变」。
        if (!hostPluginIsCurrent(root)) {
            Log.w(TAG, "runtime probe: kxxy-host plugin outdated, forcing reinstall")
            return false
        }

        // 锚点 9：office 预览链（LibreOffice wasm 引擎 + 单文件 CJK 字体）。
        //
        // 这两份都是「新增资产」：老设备升级 APK 时 runtime 版本戳不变，前面
        // 的锚点全通过 ⇒ isComplete() 判真 ⇒ 新资产永远不落地。真机踩过：手工
        // push 的 wasm 包与字体在下次自愈重装后被整体删除，Office 预览回到
        // 「Office 预览不可用」。
        //
        // 只判标记文件不够，还要判 wasm 主体在位 —— 标记文件很小、写入成功
        // 而 122 MiB 的 soffice.wasm 被中途截断是完全可能的（存储不足）。
        if (!markerIsCurrent(root, OFFICE_LAYER_MARKER_FILE, OFFICE_LAYER_MARKER)) {
            Log.w(TAG, "runtime probe: office assets outdated, forcing reinstall")
            return false
        }
        if (!File(root, OFFICE_WASM_ENGINE).isFile) {
            Log.w(TAG, "runtime probe: libreoffice wasm engine missing, forcing reinstall")
            return false
        }
        for (font in OFFICE_FONT_FILES) {
            if (!File(root, font).isFile) {
                Log.w(TAG, "runtime probe: office font $font missing, forcing reinstall")
                return false
            }
        }

        // 锚点 10：移动端 UI 插件（dsh-web-mobile）在位。
        //
        // 它是随 runtime 打包的第三方客户端插件（`dsh.client.platform === "web"`），
        // 由 `dsh-client-modules` 扫 Loader entries 发现。缺了它的表现是
        // 「手机上没有抽屉/全宽会话」——官方桌面布局原样呈现，不报错、不留日志，
        // 属于最难排查的一类。判 package.json 而不是判 client.js：后者的文件名
        // 由包自己决定（当前是 lib/client.js，但不保证不变）。
        if (!File(root, MOBILE_PLUGIN_ENTRY).isFile || !File(root, MOBILE_PLUGIN_CLIENT).isFile) {
            Log.w(TAG, "runtime probe: dsh-web-mobile plugin missing, forcing reinstall")
            return false
        }
        if (!markerIsCurrent(root, MOBILE_PLUGIN_MARKER_FILE, MOBILE_PLUGIN_MARKER)) {
            Log.w(TAG, "runtime probe: dsh-web-mobile plugin outdated, forcing reinstall")
            return false
        }

        // 锚点 11：构建期补丁集版本。
        //
        // 前面的锚点探的全是**自有资产**（compat.js / modern.js / node-pty /
        // kxxy-host / office 字体 / dsh-web-mobile），而绝大多数补丁改的是
        // **上游文件** —— documentpreview 的 client.js 与 client.pdf.js、
        // libreoffice-kit、dsh-office-to-pdf …… 这些文件没有任何版本标记可探。
        //
        // 真机事故：给 documentpreview 补上 zip / epub 两个 provider、重建
        // runtime.zip 与 APK、装机重启后，设备上 `grep -c kxxyArchiveApply`
        // 仍是 0，logcat 里只有一句 `runtime already installed and complete`。
        // 前面的锚点全部通过 ⇒ isComplete() 判真 ⇒ 新补丁根本没解出来。
        //
        // 标记由 build-runtime.mjs 写在 kxxy-host 目录下（自有插件的地盘，
        // 不与上游文件抢路径）。改动 patches.mjs 里任何补丁、或增删补丁时，
        // 必须同步递增 [PATCHSET_MARKER]。
        if (!markerIsCurrent(root, PATCHSET_MARKER_FILE, PATCHSET_MARKER)) {
            Log.w(TAG, "runtime probe: patch set outdated, forcing reinstall")
            return false
        }

        // 锚点 12：Tesseract 简体中文语言包。
        // 与锚点 9 同型（新增资产 + 版本戳不变 ⇒ 不加锚点老设备永不重装）。
        // 只判标记文件不够：标记 26 B、写入必然成功，而 2.4 MiB 的
        // .traineddata 中途被截断是完全可能的（存储不足）—— 截断的语言包
        // 能让 `ls` 显示存在，直到用户真去识别中文才炸。所以主体单独判体积。
        if (!markerIsCurrent(root, TESSDATA_MARKER_FILE, TESSDATA_MARKER)) {
            Log.w(TAG, "runtime probe: tessdata marker outdated, forcing reinstall")
            return false
        }
        val chiSim = File(root, TESSDATA_LANGUAGE_FILE)
        if (!chiSim.isFile) {
            Log.w(TAG, "runtime probe: chi_sim.traineddata missing, forcing reinstall")
            return false
        }
        if (chiSim.length() < MIN_TRAINEDDATA_BYTES) {
            Log.w(TAG, "runtime probe: chi_sim.traineddata truncated (${chiSim.length()} B)")
            return false
        }

        // 锚点 13：TeX Live 宏包树。
        // 同锚点 12 的道理，这里再加一层：宏包树是 5900 个文件、87 MiB，解到
        // 一半失败留下的半棵树仍能让 `pdftex --version` 正常，但 `pdflatex`
        // 会在找 article.cls / plain.tex 时失败。所以逐个探三个标志性文件的体积。
        if (!markerIsCurrent(root, TEXLIVE_MARKER_FILE, TEXLIVE_MARKER)) {
            Log.w(TAG, "runtime probe: texlive marker outdated, forcing reinstall")
            return false
        }
        for (rel in TEXLIVE_CORE_FILES) {
            val f = File(root, rel)
            if (!f.isFile || f.length() == 0L) {
                Log.w(TAG, "runtime probe: texlive core file missing/empty: $rel")
                return false
            }
        }

        // 锚点 14：带 resources.arsc 的 android.jar（缺陷 CQ）。
        // 同样是「新增资产」而非新增版本：RUNTIME_VERSION 从未变过，老设备
        // 升级 APK 时前十三锚点全通过，isComplete() 判真、跳过重装，于是
        // 旧的精简 stub 一直留在 share/java/android.jar 上，`aapt2 link`
        // 继续报 `No package ID 01 found for resource ID 0x0101053d`。
        //
        // 与其它锚点不同的是，这一条**同时探标记与实体**：标记只能证明 zip
        // 里带的是新版，证明不了 install 真的把它解出来了。所以再加一条
        // 「jar 里必须能搜到 resources.arsc 这个字符串」——arsc 是 jar 内部
        // 条目的名字，出现在 ZIP 中央目录里，普通文件读即可命中。
        if (!markerIsCurrent(root, ANDROID_JAR_MARKER_FILE, ANDROID_JAR_MARKER)) {
            Log.w(TAG, "runtime probe: android.jar marker outdated, forcing reinstall")
            return false
        }
        val androidJar = File(root, "share/java/android.jar")
        if (!androidJar.isFile || androidJar.length() < MIN_ANDROID_JAR_BYTES) {
            Log.w(
                TAG,
                "runtime probe: android.jar missing or still the stub " +
                    "(${androidJar.length()} B < $MIN_ANDROID_JAR_BYTES B)",
            )
            return false
        }

        // 锚点 15：打包工具包装器（缺陷 CT）。
        //
        // 与锚点 12–14 同型，但这次换的不是「新增文件」而是**已有文件的形态**：
        // `bin/corepack` 从「dist/corepack.js 的副本」变成 156 B 的 sh 包装器。
        // 它既不改变 RUNTIME_VERSION，也不影响任何既有标记 —— 前十四锚点全通过，
        // isComplete() 判真，老设备继续报
        // `Cannot find module './lib/corepack.cjs'`。
        //
        // 所以这一条**必须同时探标记与实体**（锚点 14 的教训）：标记只证明 zip
        // 里带的是新版，证明不了 install 真把它解出来了。实体判据取「首行是
        // #!/system/bin/sh」——副本的首行是 `#!/usr/bin/env node`，两者不可能混淆。
        if (!markerIsCurrent(root, PACKAGING_MARKER_FILE, PACKAGING_MARKER)) {
            Log.w(TAG, "runtime probe: packaging wrappers outdated, forcing reinstall")
            return false
        }
        for (rel in PACKAGING_WRAPPERS) {
            val f = File(root, rel)
            if (!f.isFile || f.length() == 0L) {
                Log.w(TAG, "runtime probe: packaging wrapper missing: $rel")
                return false
            }
            // 可执行位在这里**自愈而不是直接判死**。
            //
            // [extract] 用 `FileOutputStream` 逐条写出，忽略 zip 条目的 unix
            // mode，所以新装设备上这些包装器落盘是 0600/0644；正常流程靠
            // [restoreExecBits]（安装路径第 183 行，扫 `bin/` 全量置位）补回来。
            // 但若某次安装被系统杀掉在 `extract` 与 `restoreExecBits` 之间、
            // 或用户/清理工具动过权限，这里直接 `return false` 会触发 741 MB
            // 重装 —— 而重装正是最容易再次被打断的那件事，于是形成「越修越坏」
            // 的死循环。补一个 bit 就能恢复的情况，不该付重装的代价。
            if (!f.canExecute() && !f.setExecutable(true, false)) {
                Log.w(TAG, "runtime probe: packaging wrapper not executable: $rel")
                return false
            }
            // 合法形态有两种，缺一不可（真机实测踩过）：
            //
            // ① 自带的 sh 包装器 —— 首行 `#!/system/bin/sh`。这是 zip 里的形态，
            //    也是全新安装后的形态。
            // ② `corepack enable` 生成的软链 —— 指向
            //    `../lib/node_modules/corepack/dist/<name>.js`。用户手动跑一次
            //    `corepack enable`（corepack 的文档行为）就会把 `bin/npm` /
            //    `bin/pnpm` 换掉，首行变成 `#!/<root>/bin/env node`。
            //
            // 第一版只认 ①，结果真机上 `corepack enable` 之后下一次启动就判假，
            // 触发 741 MB 全量重装（日志 `restoreExecBits: 1241` +
            // `runtime install complete`）—— 用户只是敲了一条官方命令，代价是
            // 整个 runtime 重装一遍，且重装完再 enable 一次又是同样结果。
            // ② 之所以等价安全：corepack 的入口第一句是 `require('./lib/corepack.cjs')`，
            // 按 `__dirname` 解析，而软链的目标本身就在 `dist/` 里，`lib/corepack.cjs`
            // 与它同级，所以能跑（真机 `pnpm --version` → 12.14.0）。缺陷 CT 的
            // 根因从来不是「软链」，而是**副本落到了 `bin/`**。
            if (Files.isSymbolicLink(f.toPath())) {
                if (!COREPACK_SHIM_NAMES.contains(rel) || !isCorepackDistShim(f)) {
                    Log.w(TAG, "runtime probe: packaging wrapper symlink is not a corepack dist shim: $rel")
                    return false
                }
            } else {
                val head = readHead(f, COMPAT_MARKER_PROBE_BYTES)
                if (!head.startsWith("#!" + "/system/bin/sh")) {
                    Log.w(TAG, "runtime probe: packaging wrapper is not a sh shim: $rel (${head.take(32)})")
                    return false
                }
                // 副本形态的反例：正文里出现 `lib/corepack.cjs` 就说明它仍是从
                // `bin/` 出发按 __dirname 解析的那个入口，缺陷 CT 复发。
                if (head.contains("lib/corepack.cjs")) {
                    Log.w(TAG, "runtime probe: bin/corepack is still the copied entry: $rel")
                    return false
                }
            }
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

    /** 现代内建补齐层是否与当前构建一致；判据同 [compatLayerIsCurrent]。 */
    private fun modernLayerIsCurrent(root: File): Boolean =
        markerIsCurrent(root, MODERN_LAYER_FILE, MODERN_LAYER_MARKER)

    /**
     * 通用版本标记探针：读文件头部，看是否含指定标记。
     *
     * 标记约定写在文件首行，所以只读前若干字节，避免为一个大文件整体读入。
     */
    private fun markerIsCurrent(root: File, relativePath: String, marker: String): Boolean {
        val file = File(root, relativePath)
        return try {
            readHead(file, COMPAT_MARKER_PROBE_BYTES).contains(marker)
        } catch (e: Exception) {
            Log.w(TAG, "runtime probe: cannot read marker of $relativePath: ${e.message}")
            false
        }
    }

    /** 读文件头部若干字节（读不到就返回空串，不抛）。 */
    private fun readHead(file: File, limit: Int): String =
        try {
            file.inputStream().use { input ->
                val buffer = ByteArray(limit)
                val read = input.read(buffer)
                if (read <= 0) "" else String(buffer, 0, read, Charsets.UTF_8)
            }
        } catch (e: Exception) {
            ""
        }

    /**
     * 锚点 8：设备上的 kxxy-host 插件树是否与**这个 APK** 构建出来的一致。
     *
     * 判据是 `lib/.fingerprint` 里的 `fingerprint:` 行（构建期对整个插件树求的
     * sha256）与 `BuildConfig.HOST_PLUGIN_FINGERPRINT`（gradle 从
     * `assets/meta/build.json` 注入）是否相等。
     *
     * ── 三个失败路径的处理不一样，逐个说明 ──────────────────────────────
     *
     * 1. **期望值是 `unknown`**（没跑 `build-runtime.mjs` 就直接打包）：
     *    放行。此时没有任何可信的期望值，判假会让设备每次启动都去解压
     *    713 MiB 的 runtime，把一个构建疏漏放大成灾难。宁可放过一次旧插件，
     *    也不要让应用变成不能启动。
     * 2. **设备上没有 `.fingerprint`**（老版本 runtime）：判假，触发重装。
     *    这是**期望行为** —— 从 `kxxy-host@N` 时代升上来的设备本来就该换一次
     *    插件，否则永远拿不到新 web 层。代价是一次 700 MiB 解压，只需一次。
     * 3. **两边都有但不等**：判假。这是本锚点存在的全部理由。
     */
    private fun hostPluginIsCurrent(root: File): Boolean {
        val expected = BuildConfig.HOST_PLUGIN_FINGERPRINT
        if (expected.isBlank() || expected == "unknown") {
            Log.w(TAG, "runtime probe: host plugin fingerprint unknown (build.json missing), skipping")
            return true
        }
        val fpFile = File(root, HOST_PLUGIN_FP_FILE)
        if (!fpFile.isFile) {
            Log.w(TAG, "runtime probe: host plugin .fingerprint missing (pre-fingerprint runtime)")
            return false
        }
        val actual = try {
            // 文件只有几十字节，整份读完最省事；按行找前缀而不是固定第 2 行，
            // 这样以后往前面插字段不会把解析弄坏。
            fpFile.readLines(Charsets.UTF_8)
                .firstOrNull { it.startsWith("fingerprint:") }
                ?.removePrefix("fingerprint:")
                ?.trim()
        } catch (e: Exception) {
            Log.w(TAG, "runtime probe: cannot read host plugin fingerprint: ${e.message}")
            null
        }
        if (actual.isNullOrEmpty()) {
            Log.w(TAG, "runtime probe: host plugin .fingerprint has no fingerprint line")
            return false
        }
        if (actual != expected) {
            Log.w(
                TAG,
                "runtime probe: host plugin fingerprint mismatch " +
                    "device=${actual.take(16)}… apk=${expected.take(16)}…",
            )
            return false
        }
        return true
    }

    /**
     * 软链形态的包装器是否指向 corepack 的 `dist/`。
     *
     * 只接受「链到 `<root>/lib/node_modules/corepack/dist/<名字>.js`」这一种 ——
     * 那正是 `corepack enable` 的产物，也是唯一能正常工作的软链形态（目标与
     * `lib/corepack.cjs` 同级，`require('./lib/corepack.cjs')` 才解析得到）。
     * 指向别处的软链一律判假：`bin/` 下出现任意软链是可疑的，而这条判据的
     * 目的就是「`bin/` 里不许再出现那个按 `bin/` 解析相对路径的入口」。
     *
     * 注意：Kotlin 的块注释是可嵌套的，注释里不要写出「星号紧跟斜杠」的序列，
     * 那会开启一层新的嵌套注释，把文件后半段全吃掉（我在这里踩过一次）。
     */
    private fun isCorepackDistShim(file: File): Boolean =
        try {
            val target = Files.readSymbolicLink(file.toPath()).toString().replace('\\', '/')
            target.contains("lib/node_modules/corepack/dist/") && target.endsWith(".js")
        } catch (e: Exception) {
            Log.w(TAG, "runtime probe: cannot read symlink target of ${file.name}: ${e.message}")
            false
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
     * 兜底自愈：扫 `bin/` 与 `libexec/` 里残留占位符的小脚本（缺陷 CE）。
     *
     * 为什么需要它：修 `materialiseLinks` 的顺序只对**全新安装**生效 ——
     * 已经装过旧版本的设备，26 个别名文件在盘上已经是「本体副本 + 字面量
     * shebang」，`isComplete(root)` 为真，根本不会重走 extract。
     *
     * 扫描范围很小（`bin/` 有 ~400 个文件、`libexec/` 只有 git-core 一批），
     * 且只看大小 ≤ 64 KiB 的文件、只读前若干字节，每次启动的开销可以忽略。
     * 幂等：没有占位符的文件一个字节都不会被写。
     */
    private fun repairPlaceholderScripts(root: File) {
        val dirs = listOf(File(root, "bin"), File(root, "libexec"))
        val needles = listOf(ROOT_PLACEHOLDER, HOME_PLACEHOLDER, TMP_PLACEHOLDER)
            .map { it.toByteArray(Charsets.ISO_8859_1) }

        val filesDir = ctx.filesDir.absolutePath
        val values = listOf(
            ROOT_PLACEHOLDER to root.absolutePath,
            HOME_PLACEHOLDER to EngineConfig.dshHome(ctx).absolutePath,
            TMP_PLACEHOLDER to EngineConfig.tmpDir(ctx).absolutePath,
            FILES_PLACEHOLDER to filesDir,
            DATA_PLACEHOLDER to (ctx.filesDir.parentFile?.absolutePath ?: filesDir),
        ).map { (ph, value) ->
            ph.toByteArray(Charsets.ISO_8859_1) to value.toByteArray(Charsets.ISO_8859_1)
        }

        var repaired = 0
        fun scan(dir: File, depth: Int) {
            if (depth > 3) return
            val children = dir.listFiles() ?: return
            for (f in children) {
                if (f.isDirectory) {
                    scan(f, depth + 1)
                    continue
                }
                if (!f.isFile || f.length() > MAX_PLACEHOLDER_SCRIPT_BYTES) continue
                val data = runCatching { f.readBytes() }.getOrNull() ?: continue
                // 只碰脚本（`#!`）与极少数带占位符的文本，绝不逐个盲扫二进制。
                if (data.size < 2 || data[0] != '#'.code.toByte() || data[1] != '!'.code.toByte()) {
                    continue
                }
                var has = false
                for (n in needles) {
                    if (indexOf(data, n, 0) >= 0) {
                        has = true
                        break
                    }
                }
                if (!has) continue

                var out = data
                for ((needle, value) in values) out = replaceAll(out, needle, value)
                if (out !== data) {
                    runCatching { f.writeBytes(out) }
                        .onSuccess { repaired++ }
                        .onFailure { Log.w(TAG, "placeholder repair failed for ${f.path}: ${it.message}") }
                }
            }
        }

        scan(dirs[0], 0)
        scan(dirs[1], 0)
        if (repaired > 0) Log.i(TAG, "repairPlaceholderScripts: $repaired script(s) repaired")
    }

    /**
     * 两阶段的第二阶段：为每个别名条目建**符号链接**（缺陷 DD）。
     *
     * 必须在全部本体落地后执行（类注释第 3 点）。别名共 1618 条，来源有二：
     * stage 里的真符号链接，以及 [dedupeByContent] 把同内容文件降级成的别名；
     * `bin/git` 的 149 个别名、`bin/coreutils` 的 100 个 applet 是主要来源。
     *
     * **链接目标写成相对路径**（`../../lib/jvm/.../bin/java` 这种），理由有二：
     * ① 相对链接在 root 目录整体搬迁后仍然有效；② Termux 上游本身就这么写，
     * 与 `lib/` 下那 18 条扩展软链风格一致。
     *
     * 处理完把「别名 → 本体」映射交给构建期清单，快路径
     * [healCopiedAliases] 在老设备上把已经复制成实体的别名改回软链。
     */
    private fun materialiseLinks(root: File, linkTargets: Map<String, String>) {
        var created = 0
        var reused = 0
        var failed = 0
        val canonicalRoot = root.canonicalPath

        for ((alias, target) in linkTargets) {
            val aliasFile = File(root, alias)

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
                if (Files.isSymbolicLink(aliasFile.toPath())) {
                    // 已是软链：内容由 [extract] 跳过别名条目保证不会错，直接留用。
                    reused++
                } else if (aliasFile.isFile && aliasFile.length() != realFile.length()) {
                    // 盘上这份与本体不等长 ⇒ 不是本体的副本，而是别的东西
                    // （扩展往同名路径放的真文件）。绝不能删。
                    Log.w(TAG, "alias occupied by a foreign file, keep it: $alias")
                    failed++
                } else {
                    // 实体文件（上一版留下的副本，或本轮解出的残留）一律替换。
                    // 别名在本体集合里永远不是本体，删掉不会丢数据。
                    Files.deleteIfExists(aliasFile.toPath())
                    createRelativeSymlink(aliasFile, realFile)
                    created++
                }
            } catch (e: Exception) {
                Log.w(TAG, "link failed for $alias -> $target: ${e.message}")
                failed++
            }
        }

        Log.i(TAG, "materialiseLinks: $created created, $reused reused, $failed failed")
    }

    /**
     * 建一条指向 [realFile] 的相对符号链接 [aliasFile]。
     *
     * 相对路径由两条绝对路径 `relativize` 得出，所以 root 换位置也不断链。
     */
    private fun createRelativeSymlink(aliasFile: File, realFile: File) {
        val parent = aliasFile.parentFile ?: throw IllegalStateException("no parent: $aliasFile")
        val relative = parent.toPath().relativize(realFile.toPath())
        Files.createSymbolicLink(aliasFile.toPath(), relative)
    }

    /**
     * 快路径的别名自愈（缺陷 DD 的存量修复）。
     *
     * 老设备上 runtime 早已解完，`isComplete()` 判真走快路径，永远不会再跑
     * [materialiseLinks]，于是 1618 条别名全是复制出来的实体 —— `bin/java`
     * 找不到 `libjli.so`、`bin/mvn` 推出错的 `MAVEN_HOME`。这里按构建期产出的
     * [ALIAS_LIST_ASSET] 逐条检查，把「本该是软链却是实体」的改回软链。
     *
     * 清单读 APK 资产而不是安装期落盘，是因为快路径**从来没跑过**
     * [materialiseLinks] 的那批老设备上根本没有安装期记录；资产则随 APK
     * 一起升级，永远是最新的。清单只有几十 KB，`assets.open()` 一次读完。
     *
     * 每次启动都跑（1618 次 stat，毫秒级），幂等。
     */
    private fun healCopiedAliases(root: File) {
        val pairs = runCatching { readAliasList() }.getOrElse {
            Log.w(TAG, "healCopiedAliases: 读别名清单失败：${it.message}")
            return
        }
        if (pairs.isEmpty()) return

        var healed = 0
        var failed = 0

        for ((alias, target) in pairs) {
            val aliasFile = File(root, alias)
            if (Files.isSymbolicLink(aliasFile.toPath())) continue
            if (!aliasFile.isFile) continue
            val realFile = File(root, target)
            if (!realFile.isFile) continue
            // 只改「确实是本体副本」的实体：长度必须一致。扩展往同名路径放了
            // 自己的文件时长度不同，必须原样留着。
            if (aliasFile.length() != realFile.length()) continue

            try {
                Files.delete(aliasFile.toPath())
                createRelativeSymlink(aliasFile, realFile)
                healed++
            } catch (e: Exception) {
                Log.w(TAG, "heal alias failed for $alias: ${e.message}")
                failed++
            }
        }

        if (healed > 0 || failed > 0) {
            Log.i(TAG, "healCopiedAliases: $healed 个别名由实体副本改回符号链接，$failed 个失败")
        }
    }

    /** 读 APK 里的别名清单，每行 `<别名>\t<本体>`。 */
    private fun readAliasList(): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>()
        ctx.assets.open(ALIAS_LIST_ASSET).bufferedReader().useLines { lines ->
            for (line in lines) {
                val tab = line.indexOf('\t')
                if (tab <= 0) continue
                out.add(line.substring(0, tab) to line.substring(tab + 1))
            }
        }
        return out
    }

    /**
     * 把构建期占位符（`@DSH_ROOT@` 等五条）换成设备上的真实目录。
     *
     * 只改 manifest 列出的那批脚本（1122 条）—— 构建期已扫出「哪些文件含
     * Termux prefix」，这里没必要再读一遍 42,043 个条目（其中 590 MiB 是
     * 压缩数据）。
     */
    private fun rewriteRootPlaceholder(root: File, manifest: JSONObject?) {
        val placeholder = manifest?.optString("rootPlaceholder").orEmpty().ifEmpty { ROOT_PLACEHOLDER }
        val paths = manifest?.optJSONArray("placeholderPaths")
        if (paths == null) {
            Log.w(TAG, "manifest has no placeholderPaths; skipping root rewrite")
            return
        }

        val real = root.absolutePath

        // 规则表：五条占位符全部要回填，缺一条就会在设备上留字面量。
        //
        // 为什么不止 @DSH_ROOT@：构建期 `PATH_REWRITES` 把 Termux 的四棵树分别
        // 换成了独立占位符（见 build-runtime.mjs 与 tools/lib/poolextract.py，
        // 两边逐字一致）。`/data/data/com.termux/files/usr` → @DSH_ROOT@，
        // `/data/data/com.termux/files/home` → @DSH_HOME@，
        // `/data/data/com.termux/cache` → @DSH_TMP@，
        // `/data/data/com.termux/files` → @DSH_FILES@，
        // `/data/data/com.termux` → @DSH_DATA@。
        // 后两条只为 perl 的 `Config_heavy.pl` 而存在（它把 `-Dsysroot` 写成
        // 不带 `/usr` 的裸前缀）。实测当前 runtime.zip 里有 2 个文件残留
        // @DSH_HOME@（`var/service/ftpd/run`、proot_distro 的 METADATA），
        // 若只回填 @DSH_ROOT@，它们会被原样写到设备上。
        val filesDir = ctx.filesDir.absolutePath
        val rules = listOf(
            placeholder to real,
            HOME_PLACEHOLDER to EngineConfig.dshHome(ctx).absolutePath,
            TMP_PLACEHOLDER to EngineConfig.tmpDir(ctx).absolutePath,
            FILES_PLACEHOLDER to filesDir,
            DATA_PLACEHOLDER to (ctx.filesDir.parentFile?.absolutePath ?: filesDir),
        ).map { (ph, value) ->
            ph.toByteArray(Charsets.ISO_8859_1) to value.toByteArray(Charsets.ISO_8859_1)
        }

        var rewritten = 0
        var missing = 0
        var touchedFiles = 0
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
                var out = data
                for ((needle, value) in rules) {
                    out = replaceAll(out, needle, value)
                }
                if (out !== data) {
                    f.writeBytes(out)
                    rewritten++
                }
                touchedFiles++
            } catch (e: Exception) {
                Log.w(TAG, "root rewrite failed for $rel: ${e.message}")
            }
        }

        Log.i(
            TAG,
            "rewriteRootPlaceholder: $rewritten/$touchedFiles rewritten, $missing missing " +
                "(${rules.size} rules, root=$real)",
        )
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
     * 递归删除，**不跟随符号链接**。
     *
     * 为什么不能用 `File.deleteRecursively()`：它是 walkBottomUp + `listFiles()`，
     * 而 `listFiles()` 对「指向目录的软链」会返回该目录下的真实条目 —— 于是
     * walk 直接下钻进链接目标，删掉的是 `extensions/<id>/…` 里的真实内容，
     * 而不是链接本身。
     *
     * 而扩展装配恰恰会在 `bin/ lib/ etc/ share/` 下留这类目录软链
     * （`engine/bin/texlive -> extensions/texlive/bin/texlive`）。
     * 实测事故（layout 2 时代的设备）：texlive 的 411 个 TeX 引擎、rust 的
     * `lib/rustlib`、gdb 的 `share/guile` 全部被整片删除，且自愈路径 relinkAll
     * 也救不回来（清单里的 src 已不存在）。
     *
     * 所以这里用 `Files.readAttributes(..., NOFOLLOW_LINKS)` 先判是不是链接：
     * 是链接就**只删链接本身**（`File.delete()` 删链接不删目标），是目录才下钻。
     */
    private fun deleteTreeSafely(target: File) {
        val path = target.toPath()
        val isLink = try {
            Files.isSymbolicLink(path)
        } catch (e: Exception) {
            Log.w(TAG, "deleteTreeSafely: lstat failed for $target: ${e.message}")
            false
        }

        // 软链（含指向目录的软链）一律只删链接本体，绝不下钻。
        if (isLink) {
            if (!target.delete()) Log.w(TAG, "deleteTreeSafely: cannot unlink $target")
            return
        }

        if (target.isDirectory) {
            val children = target.listFiles()
            if (children != null) {
                for (child in children) deleteTreeSafely(child)
            }
        }

        if (!target.delete()) Log.w(TAG, "deleteTreeSafely: cannot delete $target")
    }

    /**
     * 把 APK 自带的 native 库（`libkxxy_exec.so`）落到 `<root>/lib`。
     *
     * 为什么不能直接用 `ApplicationInfo.nativeLibraryDir` 里那份：
     * LD_PRELOAD 要求绝对路径，而 nativeLibraryDir 随安装路径变化
     * （`/data/app/~~<hash>/app.kxxy-<hash>/lib/arm64`），且**在 app 升级后
     * 会失效**（旧目录被删）。而 LD_PRELOAD 是写进环境变量、传给子进程的，
     * 一旦路径失效，所有子进程启动都会因 preload 加载失败而 abort。
     *
     * 拷到 `<root>/lib` 后，路径稳定、跟着引擎根走，且已经在
     * LD_LIBRARY_PATH 里。
     *
     * 每次启动都覆盖一次（文件只有几十 KB）：避免升级 APK 后盘上留着
     * 旧版本的重写器 —— 那种「半新半旧」最难排查。
     */
    private fun installExecShim(root: File) {
        val lib = File(root, "lib")
        if (!lib.isDirectory) {
            Log.w(TAG, "installExecShim: lib dir missing")
            return
        }

        val target = File(lib, EXEC_SHIM_NAME)

        // APK 里的 native 库按 ABI 分目录，nativeLibraryDir 直接指向本机那份。
        val src = File(ctx.applicationInfo.nativeLibraryDir, EXEC_SHIM_NAME)

        if (!src.isFile) {
            // 极少数情况（比如 ABI 分裂安装）下这里取不到，退一步按 ABI 名拼。
            val abi = android.os.Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
            val alt = File(File(ctx.applicationInfo.nativeLibraryDir).parentFile, abi + "/" + EXEC_SHIM_NAME)
            if (alt.isFile) {
                copyShim(alt, target)
                return
            }
            Log.w(TAG, "installExecShim: $EXEC_SHIM_NAME not in APK native libs ($src)")
            return
        }

        copyShim(src, target)
    }

    private fun copyShim(src: File, target: File) {
        try {
            val inBytes = src.readBytes()
            // 内容一致就不重写：减少每次启动的 I/O 与 mtime 抖动。
            if (target.isFile && target.length() == inBytes.size.toLong()) {
                val old = runCatching { target.readBytes() }.getOrNull()
                if (old != null && old.contentEquals(inBytes)) {
                    target.setExecutable(true, false)
                    return
                }
            }
            target.writeBytes(inBytes)
            target.setExecutable(true, false)
            Log.i(TAG, "exec shim installed: ${target.absolutePath} (${inBytes.size} bytes)")
        } catch (e: Exception) {
            Log.w(TAG, "installExecShim failed: ${e.message}")
        }
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

        // ⚠️ JVM 的 `lib/jspawnhelper` 必须单独置位（不在任何 `bin/` 路径段下）。
        //
        // 它是 HotSpot 的 posix_spawn 辅助程序：JDK 在需要 fork 但不想付
        // fork 整进程代价的路径上直接 exec 这个 ELF（Gradle 起 daemon 就走它）。
        // 仓库里随 zip 存的是 `-rw-------`（12504 B），没有可执行位 ⇒ 子进程
        // 启动即 `Failed to exec spawn helper: pid: … exit code: 127`。
        //
        // 真机症状极具误导性（缺陷 AW）：`java -version` 与 kotlinc **完全正常**，
        // 只有 Gradle 挂 —— 因为 gradle 的 daemon 是用 posix_spawn 起的，报错是
        // `Could not start '…/bin/java'`，看起来像 java 不可执行。
        // A/B：`chmod +x lib/jspawnhelper` 之后同一个 gradle 立刻 BUILD SUCCESSFUL。
        //
        // 判据写成「lib/jvm 下 ELF 且无扩展名」而不是写死路径：目录名带 deb
        // 版本号（`java-21-openjdk` / 将来可能 `java-17-openjdk`），而
        // jspawnhelper 在 `lib/` 下、名字也没有后缀。这样顺带覆盖 `lib/jexec`
        // 这类同型文件，且不会误伤 `.so`（有扩展名）与 `modules`（非 ELF 头）。
        if (jvm.isDirectory) {
            jvm.walkTopDown()
                .maxDepth(MAX_SCAN_DEPTH)
                .filter { it.isFile }
                .filter { f -> f.name.indexOf('.') < 0 && isElfOrScript(f) }
                .forEach { if (it.setExecutable(true, false)) changed++ }
        }

        Log.i(TAG, "restoreExecBits: $changed file(s) made executable")
    }

    /**
     * JVM 可执行位的**幂等补漏**，每次启动都跑。
     *
     * 为什么不能只写在 [restoreExecBits] 里：那条路径只在「重装 runtime」时
     * 执行，而老设备上资产是全的、锚点全过 —— `isComplete()` 判真 ⇒ 永不重装
     * ⇒ 这条修复永远到不了设备（与缺陷 AV 同型的「自愈够不到」）。
     *
     * 而它又**不适合**做成锚点：锚点判定的是「资产在不在」，这里资产都在，
     * 差的是文件 mode —— `setExecutable` 之后连 mtime 都不变。所以走「每次
     * 启动补一次」：成本是遍历 `lib/jvm` 的 stat + 对候选读 4 字节，命中即返回。
     */
    private fun ensureJvmExecBits(root: File) {
        val jvm = File(root, "lib/jvm")
        if (!jvm.isDirectory) return
        var fixed = 0
        runCatching {
            jvm.walkTopDown()
                .maxDepth(MAX_SCAN_DEPTH)
                .filter { it.isFile && it.name.indexOf('.') < 0 }
                .filter { !it.canExecute() && isElfOrScript(it) }
                .forEach { if (it.setExecutable(true, false)) fixed++ }
        }.onFailure { Log.w(TAG, "ensureJvmExecBits failed: ${it.message}") }
        if (fixed > 0) Log.i(TAG, "ensureJvmExecBits: $fixed file(s) re-chmod'ed")
    }

    /**
     * 剔除**会遮蔽系统真库**的 Termux 桩库，每次启动都跑（缺陷 AZ）。
     *
     * 背景：`libandroid-stub_30-1` 发的 `<root>/lib/libbinder_ndk.so` 只有
     * 24,000 B、`soname=null`、`strings | grep '^_Z'` 零个符号，而系统
     * `/system/lib64/libbinder_ndk.so` 有 94,488 B / 190 个符号。因为
     * [EngineConfig.buildEnv] 把 `<root>/lib` 放在 `LD_LIBRARY_PATH` 首位
     * （curl / cmake 需要引擎里那批新库），这个桩库会**遮蔽**系统真库，
     * 于是 `/system/lib64/libui.so` 的 verneed 解析失败，`ffmpeg` / `ffprobe`
     * 报 `CANNOT LINK EXECUTABLE "…/ffmpeg": cannot find "libbinder_ndk.so"
     * from verneed[0] in DT_NEEDED list for "/system/lib64/libui.so"` ——
     * 措辞像「文件缺失」，实际是「版本符号缺失」。
     *
     * 为什么只删这一个：真机逐个 `mv` 的单变量 A/B 显示，移走它 ffmpeg 立刻
     * 恢复、其余 14 个工具输出逐字不变；而移走 `libmediandk.so` 反而让系统
     * `libunwindstack.so` 报 `cannot locate symbol "Xzs_Construct"`。所以另外
     * 四个桩库必须保留。安全性另由 `_recon/elfneeded2.py` 证明：整棵引擎
     * 3,577 个 ELF64 里 `DT_NEEDED` 引用 `libbinder_ndk.so` 的有 **0 个**。
     *
     * 为什么走「每次启动」而不是只靠构建期剔除：构建期 `DROPPED_LIBS` 只对
     * 新装的 runtime 生效，而老设备 `isComplete()` 判真 ⇒ 永不重装 ⇒ 修不到
     * （与 [ensureJvmExecBits] 同一类「自愈够不到」）。成本仅一次 `File` 存在性
     * 检查，命中才删一个文件。
     */
    private fun ensureNoShadowingStubs(root: File) {
        for (rel in SHADOWING_STUBS) {
            val f = File(root, rel)
            if (!f.exists()) continue
            val size = f.length()
            val removed = runCatching { f.delete() }.getOrDefault(false)
            if (removed) {
                Log.i(TAG, "ensureNoShadowingStubs: removed $rel ($size B, 遮蔽系统真库)")
            } else {
                Log.w(TAG, "ensureNoShadowingStubs: 无法删除 $rel ($size B)")
            }
        }
    }

    /**
     * 把 guile 的 `.go` 编译缓存的 mtime 抬到不早于对应的 `.scm`（缺陷 CU）。
     *
     * ── 症状 ────────────────────────────────────────────────────────────────
     *
     * `gdb --version` 20s / 45s / 90s 三档全是 0 字节输出、被 SIGKILL（rc=137）。
     * strace 看到它反复 `openat(...share/guile/3.0/ice-9/boot-9.scm)` 与
     * `psyntax-pp.scm`，随后卡在 `rt_sigprocmask` 节律里 —— 看起来像死循环，
     * 实际是**在内存里重编宏展开器自身**。而且 `ccache/ice-9/boot-9.go`
     * （933,053 B）明明存在，所以「缓存缺失」这个直觉是错的。
     *
     * ── 机制（真机 A/B 定案）────────────────────────────────────────────────
     *
     * guile 3.0 判断 `.go` 是否可用的依据是 **`.scm` 的 mtime vs `.go` 的
     * mtime**，不是内容哈希。任一 `.scm` 比对应 `.go` 新 ⇒ 走重编译路径。
     * 而 `GUILE_AUTO_COMPILE=0` 只阻止把结果**写回**磁盘，**不阻止在内存里
     * 重编** —— 于是每次启动都白编一遍。
     *
     * 触发条件在设备上必然成立：`.scm` 的 mtime 来自**扩展解包时刻**
     * （`bin/tar` 解包时按条目时间落盘），而 `.go` 的 mtime 来自**池打包时刻**
     * （`tools/lib/poolextract.py` 统一写 `info.mtime = 0`，解包后又被 tar
     * 归一）。谁新谁旧完全取决于「先装扩展还是先装 runtime」。
     *
     * 决定性实验：`touch` 全部 `.scm` → `gdb --version` **rc=124 / 137 秒超时**；
     * 再 `touch` 全部 `.go` → **rc=0 / 0 秒**。同一台设备、同一份二进制。
     *
     * ── 为什么走「每次启动」而不是构建期 ──────────────────────────────────────
     *
     * 扩展是用户按需安装/重装的，每次都会重写 `.scm` 的 mtime；构建期没有任何
     * 手段能预知。而且这不是「资产在不在」的问题（文件都在），锚点表达不了。
     * 成本：遍历 ccache 目录的 stat（真机 344 个 `.go`），只在需要时 `setLastModified`。
     */
    private fun ensureGuileCcacheFresh(root: File) {
        runCatching {
            // ccache 有两个候选位置：合并视图优先，回落扩展树（与 guileCompiledPath 同序）。
            val ccache = listOf(
                File(root, "lib/guile/3.0/ccache"),
                File(EngineConfig.extensionsRoot(ctx), "gdb/lib/guile/3.0/ccache"),
            ).firstOrNull { it.isDirectory } ?: return

            // `.go` 的路径是 `ccache/ice-9/boot-9.go`，对应源码在
            // `share/guile/3.0/ice-9/boot-9.scm`；两棵树的相对布局一致，
            // 所以按相对路径去 share 侧找同名 `.scm` 即可。
            val share = listOf(
                File(root, "share/guile/3.0"),
                File(EngineConfig.extensionsRoot(ctx), "gdb/share/guile/3.0"),
            ).firstOrNull { it.isDirectory }

            var touched = 0
            var checked = 0
            ccache.walkTopDown()
                .maxDepth(MAX_SCAN_DEPTH)
                .filter { it.isFile && it.name.endsWith(".go") }
                .forEach { go ->
                    checked++
                    val rel = go.relativeTo(ccache).path
                    val scmRel = rel.removeSuffix(".go") + ".scm"
                    // 源码可能在 share 侧，也可能就在 ccache 旁边（少数布局）。
                    val scm = listOfNotNull(share?.let { File(it, scmRel) }, File(ccache, scmRel))
                        .firstOrNull { it.isFile } ?: return@forEach
                    // 留 2 秒余量：同一次解包出来的文件 mtime 可能只差毫秒，
                    // 而 tar 的时间精度是秒，正好卡在边界上仍会被判「更新」。
                    val need = scm.lastModified() + 2_000L
                    if (go.lastModified() >= need) return@forEach
                    if (go.setLastModified(need)) touched++
                }
            if (touched > 0) {
                Log.i(TAG, "ensureGuileCcacheFresh: $touched/$checked .go re-dated（避免 gdb 每次重编 boot-9）")
            }
        }.onFailure { Log.w(TAG, "ensureGuileCcacheFresh failed: ${it.message}") }
    }

    /**
     * 创建 `$TMPDIR`（`filesDir/tmp`），并尽量把 `/tmp` 也变可用（缺口 A）。
     *
     * ── 为什么需要这一趟（真机缺口）──────────────────────────────────────────
     *
     * `EngineConfig` 只把 `TMPDIR` / `TMP` / `TEMP` / `GOTMPDIR` 等环境变量
     * **指向** `filesDir/tmp`，从来没有创建那个目录。全新安装后第一次启动：
     *
     *     $ touch /tmp/k2
     *     No such file or directory
     *     $ mkdir -p $TMPDIR && touch $TMPDIR/x   # 才能过
     *
     * 受影响的不止 `/tmp` 字面路径：
     *   · gdb 往 `$TMPDIR/gdbout.<pid>` 写输出，目录不存在时**静默挂起**
     *     （问题 2 的直接成因）；
     *   · `go build -o /tmp/...`、部分脚本的 `mktemp` 同样失败；
     *   · 少数工具（Java 的 `java.io.tmpdir` 回退、部分 shell 模板）只认字面
     *     `/tmp`，不读 `$TMPDIR`。
     *
     * 所以这里做两件事：
     *   1. 确保 `filesDir/tmp` 存在（幂等，`mkdirs()`）；
     *   2. 尝试把字面 `/tmp` 指过去。**`/tmp` 归 root 且 `chmod 1777`**，普通
     *      App 建不了它，所以这条只在能写父目录时成功 —— 失败不是错误，
     *      直接吞掉（引擎侧的 `TMPDIR` 已经可用，功能不受影响）。
     */
    private fun ensureTmpDir(ctx: Context) {
        val tmp = EngineConfig.tmpDir(ctx)
        if (!tmp.isDirectory && !tmp.mkdirs() && !tmp.isDirectory) {
            Log.w(TAG, "ensureTmpDir: 无法创建 ${tmp.absolutePath}")
            return
        }

        // 让 `getprop` / 三方脚本眼里的 `/tmp` 也指向同一处。Android 上
        // `/tmp` 通常不存在且 `/` 只读，这里失败是**预期**，不记错误。
        val slashTmp = File("/tmp")
        if (slashTmp.exists()) return
        runCatching {
            // 极少数机型 `/` 可写（userdebug / 已 root）。能建就建成软链，
            // 与 $TMPDIR 共享同一份内容，避免「两个 tmp 各写一半」。
            if (slashTmp.parentFile?.canWrite() == true) {
                Files.createSymbolicLink(slashTmp.toPath(), tmp.toPath())
                Log.i(TAG, "ensureTmpDir: /tmp → ${tmp.absolutePath}")
            }
        }.onFailure { Log.i(TAG, "ensureTmpDir: /tmp 不可创建（预期，${it.message}）") }
    }

    /**
     * 落一份自建 fontconfig 配置，让 fontconfig 看得见随 runtime 走的 CJK 字体（缺陷 CV）。
     *
     * ── 症状 ────────────────────────────────────────────────────────────────
     *
     * `pandoc zh.md -o zh.pdf --pdf-engine=xelatex -V CJKmainfont=NotoSansSC-Regular`
     * 报 `! Package fontspec Error: The font "NotoSansSC-Regular" cannot be found;`
     * 换成按文件路径给字体能出 PDF，但中文全丢（`Missing character: There is no
     * 文 ("6587) in font nullfont!`）。
     *
     * ── 根因 ────────────────────────────────────────────────────────────────
     *
     * `<root>/etc/fonts/fonts.conf` 是**扩展池的软链**（texlive 与 ffmpeg 各带
     * 一份，合并视图先到者胜），它的 `<dir>` 只有 `/system/fonts`、
     * `<root>/share/fonts`、`<dir prefix="xdg">fonts</dir>`、`~/.fonts` ——
     * 而 NotoSansSC 两个字体在 `lib/node_modules/kxxy-host/fonts/` 下，
     * 那个目录 fontconfig 完全看不到，索引里根本没有这个 face。
     *
     * 顺带纠正一个误判：用户清单里写「`fc-list | wc -l` = 0」—— 真机上
     * **`fc-list` 这个命令根本不存在**（Termux 的 fontconfig 包没进种子），
     * 所以那条证据是假的；但「索引里没有字体」这个结论是对的。
     *
     * ── 为什么不能改 fonts.conf ───────────────────────────────────────────────
     *
     * 它是扩展池落下来的软链，扩展重装/重打池就会覆盖，改它等于把修复放在
     * 随时会被冲掉的地方。所以这里写**自己的**文件（`etc/fonts/kxxy-fonts.conf`），
     * 由 `EngineConfig` 用 `FONTCONFIG_FILE` 指过去 —— fontconfig 认这个变量，
     * 有它就完全不读默认路径。
     *
     * 配置内容照抄标准 fonts.conf 的骨架（含 `conf.d` 的 include），只额外把
     * kxxy-host 的字体目录插到最前，并给 CJK 加一条 sans-serif 别名，
     * 这样 `fc-match sans-serif:lang=zh` 也能命中。
     */
    private fun ensureFontConfig(root: File) {
        val fontsDir = EngineConfig.officeFontsDir(ctx)

        val conf = buildString {
            append("<?xml version=\"1.0\"?>\n")
            append("<!DOCTYPE fontconfig SYSTEM \"urn:fontconfig:fonts.dtd\">\n")
            append("<!-- generated by Kxxy RuntimeInstaller — do not edit -->\n")
            append("<fontconfig>\n")
            // 随 runtime 走的 CJK 字体必须排第一：它是唯一含完整简中字形的
            // 单文件 TTF（`/system/fonts` 里的 NotoSansCJK 是 .ttc 集合，
            // LibreOffice wasm 会把它导成无字形空壳，见 officeFontsDir 注释）。
            append("  <dir>${xmlEscape(fontsDir.absolutePath)}</dir>\n")
            append("  <dir>/system/fonts</dir>\n")
            append("  <dir>${xmlEscape(File(root, "share/fonts").absolutePath)}</dir>\n")
            append("  <dir prefix=\"xdg\">fonts</dir>\n")
            append("  <dir>~/.fonts</dir>\n")
            append("  <cachedir>${xmlEscape(File(root, "var/cache/fontconfig").absolutePath)}</cachedir>\n")
            append("  <cachedir>~/.fontconfig</cachedir>\n")
            // 复用扩展池带来的 conf.d（抗锯齿/微调/子像素那批），有则包含。
            val confD = File(root, "etc/fonts/conf.d")
            if (confD.isDirectory) {
                append("  <include ignore_missing=\"yes\">${xmlEscape(confD.absolutePath)}</include>\n")
            }
            // CJK 别名：`fontspec` 按 PostScript 名找（NotoSansSC-Regular），
            // 而 fontconfig 的 family 是 `Noto Sans SC`（带空格）。两条都登记，
            // 这样 `fc-match`、`fontspec`、`fontconfig` 三条路都能命中。
            append("  <alias binding=\"same\"><family>sans-serif</family>")
            append("<accept><family>Noto Sans SC</family></accept></alias>\n")
            append("  <alias binding=\"same\"><family>sans-serif</family>")
            append("<accept><family>NotoSansSC-Regular</family></accept></alias>\n")
            append("</fontconfig>\n")
        }.toByteArray(Charsets.UTF_8)

        val target = File(root, "etc/fonts/kxxy-fonts.conf")
        if (target.isFile && target.length() == conf.size.toLong()) {
            val existing = runCatching { target.readBytes() }.getOrNull()
            if (existing != null && existing.contentEquals(conf)) return
        }
        runCatching {
            target.parentFile?.mkdirs()
            target.writeBytes(conf)
            Log.i(TAG, "ensureFontConfig: wrote ${target.path}")
        }.onFailure { Log.w(TAG, "ensureFontConfig failed: ${it.message}") }
    }

    /** 极简 XML 文本转义（路径里可能有 `&`，虽然 Android 上基本不会）。 */
    private fun xmlEscape(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    /**
     * 给 TeX 的 `web2c/mktex*` 补可执行位（缺陷 CW）。
     *
     * 症状：`xelatex` 找不到字体时会调 `mktextfm`，后者内部 exec
     * `$TEXMFDIST/web2c/mktexnam`，报
     *   `mktextfm: 1: .../texmf-dist/web2c/mktexnam: Permission denied`
     * 于是字体永远建不出来。
     *
     * 根因是两层叠加：
     *   ① `tools/build-runtime.mjs` 的 `bundleTexliveMacros` 确实把
     *      `texmf-dist/web2c/mktex*` 的 zip 条目 mode 写成 0o755；
     *   ② 但 [extract] 用 `ZipInputStream` + `FileOutputStream` 逐条写出，
     *      **完全忽略 entry 的 unix mode**，落盘一律 0600/0644；
     *   ③ 而 [restoreExecBits] 只扫 `bin/`、`usr/bin/`、`libexec/`、
     *      `lib/node_modules`、`lib/jvm` 五处，`share/texlive/.../web2c` 不在其中。
     *
     * 为什么走「每次启动」：TeX 树随扩展重装重建，构建期改不到设备盘；
     * 且这不是资产缺失，锚点表达不了。成本是一次 `listFiles` + 七个 `setExecutable`。
     */
    private fun ensureTexExecBits(root: File) {
        runCatching {
            val texlive = File(root, "share/texlive")
            if (!texlive.isDirectory) return
            var fixed = 0
            texlive.listFiles()?.forEach { year ->
                if (!year.isDirectory) return@forEach
                val web2c = File(year, "texmf-dist/web2c")
                if (!web2c.isDirectory) return@forEach
                web2c.listFiles()?.forEach { f ->
                    // 只认 `mktex*`：同目录下还有 `texmf.cnf`、`fmtutil.cnf`
                    // 这类配置文件，不该有可执行位。
                    if (!f.isFile || !f.name.startsWith("mktex")) return@forEach
                    if (!f.canExecute() && f.setExecutable(true, false)) fixed++
                }
            }
            if (fixed > 0) Log.i(TAG, "ensureTexExecBits: $fixed mktex* made executable")
        }.onFailure { Log.w(TAG, "ensureTexExecBits failed: ${it.message}") }
    }

    /**
     * 锚点 15 的安装前自愈：把 `corepack enable` / `corepack disable` 弄出来的
     * 状态就地修好，而不是判假重装 741 MiB。
     *
     * 三种状态，全部来自 corepack 的官方命令（用户敲一次就触发，实测）：
     *
     *   ① **被删掉** —— `corepack disable` 直接 `unlink` 四个入口。实测
     *      `ls: cannot access '…/bin/pnpm': No such file or directory`，
     *      而 `bin/corepack` 本体还在。这里按构建期同一份内容补回 sh 包装器。
     *   ② **被换成软链** —— `corepack enable` 建成
     *      `bin/pnpm -> ../lib/node_modules/corepack/dist/pnpm.js`。软链本身没问题
     *      （目标与 `lib/corepack.cjs` 同级，`require('./lib/corepack.cjs')` 按
     *      `__dirname` 解析命中），但 `dist/` 下的 js 在 zip 里是 0644、被
     *      `extract` 落成 0600，于是 `pnpm` 报 `Permission denied` ——
     *      `restoreExecBits` 扫不到它（它只扫 `bin/` / `usr/bin/` / `libexec/`，
     *      以及 `lib/node_modules` 与 `lib/jvm` 下路径含 `/bin/` 的）。这里给
     *      软链目标补上可执行位。
     *   ③ **可执行位丢了** —— 直接补。
     *
     * 只处理 corepack 管的四个。`bin/zipalign` / `bin/bundletool` 是自造的，
     * 没有任何官方命令会动它们；它们缺失或变形就是真缺陷，留给 `isComplete()`
     * 判假重装 —— 在那里补回来反而会掩盖构建问题。
     *
     * 幂等且只在 `bin/node` 存在时调用（见 [ensureInstalled]），全新安装不受影响。
     */
    private fun healPackagingWrappers(root: File) {
        for (rel in COREPACK_SHIM_NAMES) {
            val name = rel.substringAfterLast('/')
            val target = File(root, rel)
            if (Files.isSymbolicLink(target.toPath())) {
                // ② 软链：给它指向的那份补可执行位（补不上不算错，isComplete 会判假）。
                runCatching {
                    val real = target.canonicalFile
                    if (real.isFile && !real.canExecute() && real.setExecutable(true, false)) {
                        Log.i(TAG, "healPackagingWrappers: made $rel target executable")
                    }
                }.onFailure { Log.w(TAG, "healPackagingWrappers: $rel link target failed: ${it.message}") }
                continue
            }
            if (!target.exists()) {
                // ① 被删掉：按构建期同一份内容补回。
                val data = buildString {
                    append("#!/system/bin/sh\n")
                    append("# generated by dsh-kxxy build-runtime.mjs — do not edit\n")
                    append("d=\${0%/*}\n")
                    append("exec \"\$d/node\" \"\$d/../lib/node_modules/corepack/dist/$name.js\" \"\$@\"\n")
                }.toByteArray(Charsets.UTF_8)
                runCatching {
                    target.parentFile?.mkdirs()
                    target.writeBytes(data)
                    target.setExecutable(true, false)
                    Log.i(TAG, "healPackagingWrappers: restored $rel")
                }.onFailure { Log.w(TAG, "healPackagingWrappers: restore $rel failed: ${it.message}") }
                continue
            }
            // ③ 形态对、可执行位丢了。
            if (target.isFile && !target.canExecute()) {
                if (target.setExecutable(true, false)) Log.i(TAG, "healPackagingWrappers: made $rel executable")
            }
        }
    }

    /**
     * 让 `dsh` 出现在 PATH 里（缺陷 CI，问题清单 P17）。
     *
     * 真机症状：`command -v dsh` 为空。包本体在
     * `lib/node_modules/@deepseek-ai/dsh/lib/bin.js`（package.json 的
     * `bin: { dsh: "lib/bin.js" }`），但 **npm 的 bin 软链只由 npm install
     * 创建**；runtime.zip 是构建期从 deb 组装出来的，从来没有跑过 npm install，
     * 所以 `bin/dsh` 这个入口根本不存在 —— 用户只能敲一长串
     * `node lib/node_modules/@deepseek-ai/dsh/lib/bin.js`。
     *
     * 为什么用 `#!/system/bin/sh` 包装而不是把它物化成 `bin/node` 的副本：
     * `lib/bin.js` 是 ESM、首行 `#!/usr/bin/env node`，直接当可执行文件跑要靠
     * `LD_PRELOAD` 的 exec 拦截器把 `/usr/bin/env` 重写掉 —— 那条路能用，但
     * 它对**每次**调用都是额外一层依赖。包装脚本只走一个 `exec`，且
     * `/system/bin/sh` 在任何 Android 上都存在（与 [corepackWrappers] 同一取舍）。
     *
     * 幂等：内容一致就不写。`bin/` 在 runtime 重装时会被删空重建，所以这条必须
     * 在快路径也跑一次，不能只在 extract 之后跑。
     */
    private fun ensureDshWrapper(root: File) {
        val entry = File(root, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js")
        if (!entry.isFile) {
            Log.w(TAG, "ensureDshWrapper: ${entry.path} 不存在，跳过")
            return
        }
        val data = buildString {
            append("#!/system/bin/sh\n")
            append("# generated by Kxxy RuntimeInstaller — do not edit\n")
            append("# 缺陷 CI：npm 的 bin 软链只由 npm install 创建，runtime.zip 里没有它。\n")
            append("d=\${0%/*}\n")
            append("exec \"\$d/node\" \"\$d/../lib/node_modules/@deepseek-ai/dsh/lib/bin.js\" \"\$@\"\n")
        }.toByteArray(Charsets.UTF_8)

        val target = File(root, "bin/dsh")
        if (target.isFile && target.length() == data.size.toLong()) {
            val existing = runCatching { target.readBytes() }.getOrNull()
            if (existing != null && existing.contentEquals(data)) {
                if (!target.canExecute()) target.setExecutable(true, false)
                return
            }
        }
        runCatching {
            target.parentFile?.mkdirs()
            target.writeBytes(data)
            target.setExecutable(true, false)
            Log.i(TAG, "ensureDshWrapper: wrote ${target.path}")
        }.onFailure { Log.w(TAG, "ensureDshWrapper failed: ${it.message}") }
    }

    /**
     * 落一份 `<root>/etc/resolv.conf`（缺陷 CJ，问题清单 R2 / P4）。
     *
     * ── 为什么缺这个文件 ────────────────────────────────────────────────────
     *
     * bionic 的 `getaddrinfo` 不看 `/etc/resolv.conf`，它走 netd 的
     * `android_getaddrinfofornet`（Binder 到 netd 进程）。所以 Node / curl /
     * git / python 这些用 libc 解析的工具**一直都是好的**，`/etc/resolv.conf`
     * 不存在这件事在它们身上完全暴露不出来。
     *
     * 但 **Go 的纯 Go resolver 是自己读文件的**：它按
     * `/etc/resolv.conf` → `$GOROOT/../etc/resolv.conf` → Termux 前缀的顺序找。
     * Termux 编的 go 把 `--prefix=/data/data/com.termux/files/usr` 编进了
     * `net` 包，构建期的 PATH_REWRITES 会把那个路径改写成
     * `@DSH_ROOT@/etc/resolv.conf`，落地后就是 `<root>/etc/resolv.conf`。
     *
     * strace 实证（真机，v0.9.1 + 本补丁）：
     *   openat(AT_FDCWD, "/etc/hosts", O_RDONLY|O_CLOEXEC) = 3
     *   openat(AT_FDCWD, "<root>/etc/resolv.conf", O_RDONLY|O_CLOEXEC) = 3
     * —— 它确实打开了，只是文件不存在时 open 失败、fallback 到 `[::1]:53`，
     * 于是 `dial tcp: lookup proxy.golang.org on [::1]:53: connection refused`。
     *
     * ── 内容从哪来 ─────────────────────────────────────────────────────────
     *
     * 不能在构建期写死：DNS 随网络（Wi-Fi / 蜂窝 / 热点 / 代理）变化，
     * 写死的 nameserver 换网络就废。这里从 `ConnectivityManager` 当前
     * **活动网络**的 `LinkProperties.dnsServers` 取，落成 `nameserver` 行。
     *
     * 取不到时**不写文件**（让 go 维持原样报错，比写一份错的更诚实），
     * 只在日志里留一行。每次引擎启动都会重跑，换网后重启引擎即生效。
     */
    private fun ensureResolvConf(root: File) {
        val target = File(root, "etc/resolv.conf")
        val servers = runCatching { activeDnsServers() }.getOrElse {
            Log.w(TAG, "ensureResolvConf: 读 DNS 失败：${it.message}")
            emptyList()
        }
        if (servers.isEmpty()) {
            Log.w(TAG, "ensureResolvConf: 没有可用的 DNS 服务器，跳过（Go 的纯 resolver 会不可用）")
            return
        }
        val data = buildString {
            append("# generated by Kxxy RuntimeInstaller — do not edit\n")
            for (s in servers) append("nameserver $s\n")
            // 搜索域留空：Go 的 resolver 对 `search` 的支持不完整（只认首个），
            // 而 Android 上短名访问本来就不常见，写进去反而干扰 `hostLookupOrder`。
            append("options edns0\n")
        }.toByteArray(Charsets.UTF_8)

        if (target.isFile && target.length() == data.size.toLong()) {
            val existing = runCatching { target.readBytes() }.getOrNull()
            if (existing != null && existing.contentEquals(data)) return
        }
        runCatching {
            target.parentFile?.mkdirs()
            target.writeBytes(data)
            Log.i(TAG, "ensureResolvConf: wrote ${target.path} (${servers.size} servers)")
        }.onFailure { Log.w(TAG, "ensureResolvConf failed: ${it.message}") }
    }

    /** 当前活动网络的 DNS 服务器（IPv4 与 IPv6 都收，去重保序）。 */
    private fun activeDnsServers(): List<String> {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return emptyList()
        val network = cm.activeNetwork ?: return emptyList()
        val props = cm.getLinkProperties(network) ?: return emptyList()
        return props.dnsServers.mapNotNull { it.hostAddress }.distinct()
    }

    /**
     * 给 Emacs 落一份 `site-load.el`，抹掉 Android 构建期的 git 探测噪音（缺陷 BA 收尾）。
     *
     * 真机症状：`emacs --batch` 每次启动都往 stderr 刷两行
     * `Error running git rev-parse: (file-missing "Setting current directory"
     * "No such file or directory" "/data/data/com.termux/files/usr/share/emacs/31.1/")`
     * （`--abbrev-ref` 那条同款）。来源是 `loadup.el:463`：
     * `(if (and (eq system-type 'android) (not (pdumper-stats))) (setq
     * emacs-repository-version (ignore-errors (emacs-repository-get-version)) …))`
     * —— 无 dump 时它会拿 `source-directory`（编译期常量，指向 Termux 前缀）
     * 当工作目录去 `call-process "git" rev-parse HEAD`，目录不存在于是失败。
     *
     * 两个动作：
     *   1. `(setq source-directory <root>/share/emacs/<版本>/)` —— 让它至少是
     *      真实存在的目录。这一步单独做**不够**（git 命令仍会跑，只是不再报
     *      `Setting current directory` 而是别的失败形态）。
     *   2. `(defalias 'emacs-repository-get-version #'ignore)` 与 `-get-branch`
     *      —— 直接把这两个探测函数打成空操作，才是彻底消音的那一刀。真机 A/B：
     *      `git=2 → git=0`，且 `source-directory`、`load-path`、`latin-2` 全正常。
     *
     * 文件落在 `$HOME/.emacs.d/kxxy/site-load.el`，由
     * [EngineConfig.emacsLoadPath] 把这个目录放在 `EMACSLOADPATH` **最前面**，
     * 于是 `loadup.el:411` 的 `(load "site-load" t)` 会先命中我们这份。
     * 放 `$HOME` 而不是引擎树：引擎树是 runtime.zip 的产物，重装即整棵重建。
     *
     * 幂等：内容一致就不重写（避免每次启动都碰 mtime 让缓存失效）。
     */
    private fun ensureEmacsSiteLoad(root: File) {
        runCatching {
            val dir = EngineConfig.emacsSiteLoadDir(ctx)
            val f = File(dir, "site-load.el")
            val shareDir = runCatching {
                val base = File(root, "share/emacs")
                // 只认纯版本号形态的目录名 —— `share/emacs/` 下还有 `site-lisp`，
                // 按字典序 `"site-lisp" > "31.1"`，不过滤会取错（缺陷 BA 真机踩过）。
                val ver = base.listFiles { x -> x.isDirectory }
                    ?.map { it.name }
                    ?.filter { it.isNotEmpty() && it[0].isDigit() }
                    ?.sorted()
                    ?.lastOrNull()
                if (ver != null) File(base, ver) else File(root, "share/emacs/31.1")
            }.getOrDefault(File(root, "share/emacs/31.1"))

            val body = buildString {
                appendLine(";;; site-load.el --- Kxxy: 抹掉 Android 构建期的 git 探测噪音  -*- lexical-binding: t; -*-")
                appendLine(";;")
                appendLine(";; 由 RuntimeInstaller.ensureEmacsSiteLoad 自动生成，请勿手改。")
                appendLine(";; 成因见 loadup.el:463 —— 无 dump 时它会拿 source-directory 去问 git。")
                appendLine("(setq source-directory")
                appendLine("      ${quoteElisp(shareDir.absolutePath + "/")})")
                appendLine("(defalias 'emacs-repository-get-version #'ignore)")
                appendLine("(defalias 'emacs-repository-get-branch #'ignore)")
                appendLine(";;; site-load.el ends here.")
            }

            if (f.isFile && f.readText() == body) return
            dir.mkdirs()
            f.writeText(body)
            Log.i(TAG, "ensureEmacsSiteLoad: wrote ${f.absolutePath} (${body.length} chars)")
        }.onFailure { Log.w(TAG, "ensureEmacsSiteLoad failed: ${it.message}") }
    }

    /** 把字符串转成 Elisp 字符串字面量（路径里可能有引号/反斜杠）。 */
    private fun quoteElisp(s: String): String = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    /**
     * 跑 TeX Live 的 `texlinks`，把 411 个引擎名补成 `<root>/bin/` 下的软链。
     *
     * **这是 `pdflatex` / `xelatex` / `lualatex` / `latex` 四个标准命令长期
     * 缺失的直接原因。** 它们的真身一直在
     * `extensions/texlive/bin/texlive/<name>`，但只有 `pdftex`/`xetex`/`tex`/
     * `luatex`/`luahbtex` 这几个「引擎本名」被 extinstall 的 `collectBins`
     * 展平进了 `<root>/bin/`；`pdflatex`/`latex`/`xelatex`/`lualatex` 是
     * `texlinks` 建的**运行时别名**，安装流程从未调用过它。
     *
     * 真机实测：手工跑一次 `texlinks` 后，四个命令立刻全部出现在
     * `<root>/bin/`，且 `pdflatex t.tex` → 12,267 B PDF、`xelatex` → 2,985 B、
     * `latex` → 260 B DVI、`lualatex` → 3,321 B PDF，全部 rc=0。
     *
     * `texlinks` 本身是 perl 脚本，但**它不走 `system("…")` 那种在 Android 上
     * 会失败-1 的路径**（那是 `mktexfmt`/`fmtutil` 的毛病）—— 它只用 perl 的
     * `symlink` 内建，所以能跑通。它对已存在的目标只报
     * `install_link … failed: file already exists.` 且仍 rc=0，天然幂等。
     *
     * 幂等判据用「四个标准命令是否都已存在」：都在就只做 4 次 `exists()`。
     */
    private fun ensureTexLinks(root: File) {
        runCatching {
            val bin = File(root, "bin")
            if (TEX_LINK_NAMES.all { File(bin, it).exists() }) return

            // texlinks 的真身**只**在扩展树里（`extensions/texlive/bin/texlive/texlinks`）：
            // `runtime.zip` 里没有 `bin/texlinks`，整个 `extensions/` 都不在 zip 里 ——
            // 它由 ext-pool 解包 + 插件 relinkAll 建立。而完整重装会把 `bin/` 与
            // `lib/` 整体删空重建，此刻 `bin/texlinks` 还不存在，旧实现因此每次都
            // 打「texlinks 缺失，跳过」然后静默放弃（缺陷 BD 的持久化根因）。
            val extBin = File(EngineConfig.extensionsRoot(ctx), "texlive/bin/texlive")
            val texlinks = listOf(File(extBin, "texlinks"), File(bin, "texlinks"))
                .firstOrNull { it.isFile }
            if (texlinks == null) {
                Log.w(TAG, "ensureTexLinks: texlinks 缺失（扩展树与 bin/ 都没有），跳过")
                return
            }

            val started = System.currentTimeMillis()
            // texlinks 是 **shell 脚本**（10,284 B，首行 `#!<root>/bin/sh`），不是 perl
            // 脚本 —— 旧实现 `ProcessBuilder(perl, texlinks)` 用 perl 去跑 shell 脚本，
            // 必然失败。它有 shebang 与可执行位，直接 exec 即可。
            val pb = ProcessBuilder(texlinks.absolutePath)
            pb.environment().clear()
            val env = EngineConfig.buildEnv(ctx, EngineConfig.DEFAULT_PORT, "normal")
                .mapNotNull { line ->
                    val i = line.indexOf('=')
                    if (i <= 0) null else line.substring(0, i) to line.substring(i + 1)
                }
                .toMap()
                .toMutableMap()
            // texlinks 靠 `kpsewhich` 定位 `fmtutil.cnf` 与各引擎。重装后
            // `<root>/bin/kpsewhich` 要等插件 relinkAll 才出现，所以必须把扩展树的
            // bin 目录也塞进 PATH —— 否则报 `kpsewhich: Permission denied` 再报
            // `texlinks: config file 'fmtutil.cnf' not found.`（真机实测）。
            val path = env["PATH"].orEmpty()
            env["PATH"] = if (path.isEmpty()) extBin.absolutePath else "${extBin.absolutePath}:$path"
            pb.environment().putAll(env)
            pb.directory(root)
            pb.redirectErrorStream(true)
            val out = File(EngineConfig.tmpDir(ctx), "texlinks.log")
            pb.redirectOutput(out)
            val rc = runCatching { pb.start().waitFor() }
                .onFailure { Log.w(TAG, "ensureTexLinks failed: ${it.message}") }
                .getOrDefault(-1)

            // texlinks 只把标准名建在**扩展树**里（`…/bin/texlive/pdflatex -> pdftex`），
            // 不会碰 `<root>/bin/`。用户敲的是 `<root>/bin/pdflatex`，所以补一步。
            val linked = linkExtensionBinaries(extBin, bin)

            val cost = System.currentTimeMillis() - started
            val still = TEX_LINK_NAMES.filterNot { File(bin, it).exists() }
            if (still.isEmpty()) {
                Log.i(TAG, "ensureTexLinks: ${TEX_LINK_NAMES.size} 个标准命令就位 (rc=$rc, 补链 $linked, ${cost}ms)")
            } else {
                Log.w(TAG, "ensureTexLinks: 仍缺 ${still.joinToString(",")} (rc=$rc, 补链 $linked, ${cost}ms)")
            }
            runCatching { out.delete() }
        }.onFailure { Log.w(TAG, "ensureTexLinks failed: ${it.message}") }
    }

    /**
     * 把扩展树里的标准 TeX 命令名补链进 `<root>/bin/`（只补缺失的，幂等）。
     *
     * 为什么必须有这一步：`collectBins`（`plugins/kxxy-host/lib/extinstall.mjs`）
     * 在建 `.links.json` 时就把扩展 bin 目录里的文件展平进 `<root>/bin/` 并登记，
     * 但 **`texlinks` 是在那之后才跑的** —— 它新建的 `pdflatex`/`latex`/`xelatex`/
     * `lualatex` 等标准名一个都不在 `.links.json` 里，所以 `relinkAll` 永远不会
     * 重建它们。重装一次 `bin/` 就全丢，这正是「修好的内容又被重建覆盖」的
     * 直接机制（真机 `.links.json` 里 `pdflatex` 的 name-hits = 0 就是铁证）。
     *
     * **只补 [TEX_LINK_NAMES] 这四个**，不做全量遍历：扩展树 `bin/texlive/`
     * 有 446 个文件（含 eptex/uptex 等别名与 411 个引擎变体），其余名字
     * `relinkAll` 会从 `.links.json` 重建；这里全量补链会与它撞名，
     * 而 `linkExact` 对已存在的目标行为不明确，没必要冒险。
     *
     * 用 `NOFOLLOW_LINKS` 判存在：悬空链接也算「已存在」，否则 `symlink` 抛
     * EEXIST 后条目永远修不回来（与 `extinstall.mjs` 的 `isPresent` 同型）。
     */
    private fun linkExtensionBinaries(extBin: File, bin: File): Int {
        bin.mkdirs()
        var linked = 0
        for (name in TEX_LINK_NAMES) {
            val source = File(extBin, name)
            if (!source.isFile) continue
            val dest = File(bin, name)
            val present = runCatching {
                Files.exists(dest.toPath(), LinkOption.NOFOLLOW_LINKS)
            }.getOrDefault(false)
            if (present) continue
            val ok = runCatching {
                Files.createSymbolicLink(dest.toPath(), source.toPath())
                true
            }.onFailure { Log.w(TAG, "ensureTexLinks: symlink $name failed: ${it.message}") }
                .getOrDefault(false)
            if (ok) linked++
        }
        return linked
    }

    /**
     * 生成 TeX Live 的格式文件（`.fmt`），缺则补、有则跳（缺陷 AY 收尾）。
     *
     * 为什么安装期做、而不是留给设备上的 `mktexfmt`：TeX Live 的 `fmtutil.pl` /
     * `mktexfmt` 全是 perl 脚本，内部用 `system("kpsewhich … >$nul 2>&1")`
     * 这种**带重定向的字符串形式**，在 Android 上 perl 的 `system` 直接返回 -1
     * （`Config{sh}` 正常、`bin/sh` 是正常 ELF、反引号可用、list-form
     * `system("sh","-c",…)` 也 rc=0 —— 只有字符串形式带重定向失败）。于是
     * `mktexfmt pdflatex.fmt` 永远报 `inifile pdflatex.ini … not found`，
     * 哪怕 `kpsewhich pdflatex.ini` 明明能命中。
     *
     * 设备上手工 `-ini` 只需 11~12 秒/个，三条命令都 rc=0。这里照抄同一组
     * 参数，用 `-output-directory` 直接落到 `$TEXMFVAR/web2c/`。**为什么是
     * 用户树**：`TEXFORMATS` 里 `$TEXMFSYSVAR` 带 `!!` 前缀（只查 `ls-R`
     * 不扫目录），而 `$TEXMFVAR` 不带 —— 落这里一个索引都不需要，设备上
     * 也就不用跑 `mktexlsr`（那个同样是 perl）。真机 A/B 已验证：清空所有
     * `ls-R`、只留 `$TEXMFVAR/web2c/` 下的三个格式文件，三件套照样全过。
     *
     * 幂等：三个 `.fmt` 都在就整体跳过，所以每次启动只是 3 次 `exists()`。
     * 全程 runCatching —— TeX 装不了不该拖垮引擎启动（其余工具都还能用）。
     */
    private fun ensureTexFormats(root: File) {
        val var_ = EngineConfig.texmfVar(ctx)
        val web2c = File(var_, "web2c")

        // 先看缓存：三个格式齐了就直接返回。注意 `xelatex.fmt` 有 4.4 MB，
        // 光看存在性就够 —— 生成到一半被杀会留下半截文件，所以顺带查大小。
        val wanted = TEX_FORMATS.associateWith { File(web2c, "$it.fmt") }
        if (wanted.values.all { it.isFile && it.length() >= MIN_FMT_BYTES }) return

        val bin = File(root, "bin")
        // `pdftex` / `xetex` / `luahbtex` 也**不在** `runtime.zip` 里，它们是扩展
        // `texlive` 的文件经 `collectBins` 展平进 `bin/` 的。完整重装把 `bin/`
        // 清空后、插件 relinkAll 之前，`bin/<engine>` 一律不存在 —— 旧实现直接
        // 打「全缺，跳过」放弃（与 ensureTexLinks 同源，缺陷 BD）。
        // 所以这里先看 `bin/`，回落扩展树。
        val extBin = File(EngineConfig.extensionsRoot(ctx), "texlive/bin/texlive")
        fun engineBin(name: String): File? =
            listOf(File(bin, name), File(extBin, name)).firstOrNull { it.isFile }

        // pdftex / xetex / luahbtex 三者全缺才整体放弃。**逐个**判而不是一起判：
        // 闭包里某个引擎缺失时，其余格式仍然值得生成（真机上 `luahbtex` 是有的，
        // 早前注释错误地断定 scheme-basic 不含 luatex，导致 lualatex 长期没 fmt）。
        if (engineBin("pdftex") == null && engineBin("xetex") == null && engineBin("luahbtex") == null) {
            Log.w(TAG, "ensureTexFormats: pdftex/xetex/luahbtex 全缺，跳过格式生成")
            return
        }

        web2c.mkdirs()
        var made = 0
        for ((name, fmt) in wanted) {
            if (fmt.isFile && fmt.length() >= MIN_FMT_BYTES) continue
            // 引擎选择：`lualatex` 走 `luahbtex`（HarfBuzz 版 LuaTeX），
            // `xelatex` 走 `xetex`，其余都是 pdftex 系。
            val engine = when (name) {
                "xelatex" -> "xetex"
                "lualatex" -> "luahbtex"
                else -> "pdftex"
            }
            val engineFile = engineBin(engine)
            if (engineFile == null) {
                Log.w(TAG, "ensureTexFormats: $engine 缺失，跳过 $name")
                continue
            }
            // `latex` 的 ini 要用 `'*latex.ini'` 形式传：latex.ini 把 * 当输入文件，
            // 没有前导星号时 pdftex 会去读 `latex.ini` 里的 `\input` 而不是当格式源。
            val ini = if (name == "latex") "*latex.ini" else "$name.ini"
            val argv = mutableListOf(
                engineFile.absolutePath,
                "-ini",
                "-jobname=$name",
                "-progname=$name",
                "-output-directory=${web2c.absolutePath}",
            )
            // 参数按引擎特性分三档（与 fmtutil.cnf 的写法一致）：
            //   · `-translate-file=cp227.tcx` 只有 pdftex 系认（pdflatex / latex）；
            //     xetex 与 luahbtex 都不认这个选项。
            //   · `-etex` 除 `latex` 外都要（latex 已用 `*latex.ini` 表达同一语义）。
            if (name == "pdflatex" || name == "latex") argv.add("-translate-file=cp227.tcx")
            if (name != "latex") argv.add("-etex")
            argv.add(ini)

            val started = System.currentTimeMillis()
            val rc = runCatching {
                val pb = ProcessBuilder(argv)
                // 环境必须与引擎进程一致：TEXMFROOT / TEXMFCNF / TEXMFVAR 少一个
                // 都会让 kpsewhich 找不到 ini，进而 rc!=0。
                pb.environment().clear()
                pb.environment().putAll(
                    EngineConfig.buildEnv(ctx, EngineConfig.DEFAULT_PORT, "normal")
                        .mapNotNull { line ->
                            val i = line.indexOf('=')
                            if (i <= 0) null else line.substring(0, i) to line.substring(i + 1)
                        }
                        .toMap()
                )
                pb.directory(var_)
                pb.redirectErrorStream(true)
                // 不用 `Redirect.DISCARD`：那是 Java 9+ 的 API，Android 上
                // 到 API 34 才有（编译期能过、低版本运行期 NoSuchMethodError）。
                // 落到一个临时文件，跑完随中间文件一起删。
                pb.redirectOutput(File(web2c, "$name.out"))
                pb.start().waitFor()
            }.onFailure { Log.w(TAG, "ensureTexFormats($name) failed: ${it.message}") }
                .getOrDefault(-1)

            val cost = System.currentTimeMillis() - started
            if (rc == 0 && fmt.isFile && fmt.length() >= MIN_FMT_BYTES) {
                made++
                Log.i(TAG, "ensureTexFormats: $name.fmt ${fmt.length()} B (${cost}ms)")
            } else {
                Log.w(TAG, "ensureTexFormats: $name 失败 rc=$rc (${cost}ms)")
            }
            // 顺手清掉 -ini 留下的中间文件，不然 $TEXMFVAR/web2c 会堆 log/aux。
            runCatching {
                listOf("$name.log", "texsys.aux", "texsys.cfg", "$name.aux", "$name.out")
                    .forEach { File(web2c, it).delete() }
            }
        }
        if (made > 0) Log.i(TAG, "ensureTexFormats: $made format(s) generated")
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

        /**
         * 别名清单资产（缺陷 DD），每行 `<别名相对路径>\t<本体相对路径>`。
         *
         * 构建期由 `tools/build-runtime.mjs` 与 runtime.zip 同时产出（同一份
         * `merged` 计算），`tools/inject-apk-assets.mjs` 的白名单把它注入 APK。
         * [healCopiedAliases] 在快路径上读它，把老设备上已复制成实体的别名
         * 改回符号链接。
         */
        private const val ALIAS_LIST_ASSET = "alias-links.txt"

        /** 构建期占位符，与 build-runtime.mjs 的 ROOT_PLACEHOLDER 一致。 */
        private const val ROOT_PLACEHOLDER = "@DSH_ROOT@"

        /**
         * exec 族路径重写预加载库的名字（缺陷 CF，问题清单 P3）。
         *
         * 与 `android/app/src/main/cpp/CMakeLists.txt` 的 `add_library(kxxy_exec …)`
         * 对应 —— CMake 会给产物加 `lib` 前缀与 `.so` 后缀，所以目标名是
         * `kxxy_exec`、文件名是 `libkxxy_exec.so`。两处必须一致，否则
         * `nativeLibraryDir` 下找不到它，P3 静默失效。
         */
        private const val EXEC_SHIM_NAME = "libkxxy_exec.so"

        /**
         * 占位符自愈只处理不大于这个尺寸的脚本（缺陷 CE）。
         * 真机上残留占位符的都是脚本，最大的是 corepack.js（约 1 KB）。
         */
        private const val MAX_PLACEHOLDER_SCRIPT_BYTES = 64L * 1024
        /**
         * Termux 的 `$HOME`（`/data/data/com.termux/files/home`）。
         *
         * 构建期 `PATH_REWRITES` 把它换成这个占位符，App 侧回填成
         * `EngineConfig.dshHome(ctx)`。实测 runtime.zip 里仍有两个脚本引用它：
         * `var/service/ftpd/run` 与 proot_distro 的 METADATA。
         *
         * 值必须与 `tools/build-runtime.mjs` 的 `HOME_PLACEHOLDER` 逐字一致 ——
         * `tools/verify-runtime.mjs` 的「占位符常量自洽」检查会核对两侧字面值。
         */
        private const val HOME_PLACEHOLDER = "@DSH_HOME@"

        /** Termux 的 `$TMPDIR`（`/data/data/com.termux/cache`），回填成 `EngineConfig.tmpDir(ctx)`。 */
        private const val TMP_PLACEHOLDER = "@DSH_TMP@"

        /**
         * 「files 的上级」= `/data/data/com.termux`，回填成 `ctx.filesDir.parentFile`。
         *
         * 只给 perl 的 `Config_heavy.pl` 用：它把 `-Dsysroot` 写成不带 `/usr`
         * 的裸前缀，三条长规则一条都匹配不到（`/data/data/com.termux/files/usr`、
         * `/data/data/com.termux/files/home`、`/data/data/com.termux/cache`
         * 都以 `/data/data/com.termux/` 开头但更长，先匹配长的即可）。
         */
        private const val DATA_PLACEHOLDER = "@DSH_DATA@"

        /** `/data/data/com.termux/files`，同样只给 `Config_heavy.pl` 一类裸前缀用。 */
        private const val FILES_PLACEHOLDER = "@DSH_FILES@"

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
        private const val COMPAT_LAYER_MARKER = "kxxy-webview-compat@10"

        /** 兼容层脚本路径，锚点 6 与 [compatLayerIsCurrent] 共用。 */
        private const val COMPAT_LAYER_FILE = "lib/node_modules/kxxy-host/web/compat.js"

        /**
         * 现代 JS 内建补齐层（锚点 6 的第二份资产）。
         *
         * 与 compat.js 分开成两个文件、两套标记的原因：职责不同、失效表现
         * 也不同。compat.js 修页面主作用域的 URL/CSS 缺陷；modern.js 补齐
         * Chrome 105–139 才有的内建，并包装 `URL.createObjectURL` 把同一份
         * 代码注入 blob worker / blob iframe —— 真机上 PDF 渲染 worker 与
         * HTML 预览 iframe 都跑在 blob: 的独立全局里，`<head>` 注入够不到。
         * 分开标记可以让「只改了其中一份」时仍然强制重装。
         */
        private const val MODERN_LAYER_MARKER = "kxxy-modern@2"
        private const val MODERN_LAYER_FILE = "lib/node_modules/kxxy-host/web/modern.js"

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
         * 宿主插件内容指纹文件（锚点 8，`kxxy-host/lib/.fingerprint`）。
         *
         * ── 为什么不再用人手编号 ──────────────────────────────────────────
         *
         * 这里原本是 `HOST_PLUGIN_MARKER = "kxxy-host@N"`，靠人工在
         * `plugins/kxxy-host/lib/index.js` 首行与本常量里同步递增。它管辖的
         * 其实是**整个 `plugins/kxxy-host/` 目录**：web 层那四个文件、lib 下
         * 全部 `.mjs`、样式与图标，一个都不例外。只要漏递增一次，设备上就会
         * 带着旧 web 层继续跑 —— 而且前十六个锚点全通过、`isComplete()` 判真、
         * 跳过重装，**整条链路一声不响**。真机踩过一次（缺陷 DP：新版弹窗
         * 怎么都不出现），根因不是「忘了」而是「没有守护」：全仓只有两处写着
         * 那个数字，任何改动都要人工同步。
         *
         * ⚠️ 写注释时注意：这里不能出现「星号紧跟斜杠」的连写（例如把
         * 「web 目录下的星号点 html」原样敲出来）。Kotlin 的块注释是可嵌套的，
         * 那两个字符会开启一层新注释，把文件后半段全吃掉 —— 编译报的是
         * 「Unclosed comment」和一堆莫名其妙的 Unresolved reference，位置却
         * 指向几百行之外。本文件已经因为这个踩了三次。
         *
         * 现在改成构建期算的内容指纹（`tools/build-runtime.mjs` 的
         * `stampHostPluginFingerprint()`）：对整棵插件树按「路径 + 内容 sha256」
         * 求一次总哈希，写进本文件。改动任何一个字节，指纹必变。
         *
         * ── 期望值从哪来 ────────────────────────────────────────────────
         *
         * 从 **APK 的 BuildConfig**（`HOST_PLUGIN_FINGERPRINT`）来，由 gradle
         * 在配置阶段读 `assets/meta/build.json` 注入。绝不能读设备上那份 ——
         * 老 runtime 里躺着的 `build.json` 是旧插件自己带的，读它等于让嫌疑人
         * 自证清白。
         */
        private const val HOST_PLUGIN_FP_FILE = "lib/node_modules/kxxy-host/lib/.fingerprint"

        /**
         * 移动端 UI 插件（第三方 dsh-web-mobile）版本标记（锚点 10）。
         *
         * 为什么需要独立锚点：它是**随 runtime 打包的第三方包**，既不进
         * `@deepseek-ai` 计数（锚点 4），也不属于 kxxy-host（锚点 5/8）。缺了它
         * 的表现是「手机上仍是官方桌面布局」——不报错、不留日志，最难排查。
         *
         * 标记写成包根目录下的独立小文件（`plugin.version`），由
         * build-runtime.mjs 写入（与那里的 MOBILE_PLUGIN_MARKER 逐字一致）。
         * 不写在 package.json 里：那个文件要交给 `dsh-client-modules` 解析，
         * 多一个未知字段虽然无害，但把它留给上游更省心。升级插件版本时，
         * 两个常量必须一起递增。
         */
        private const val MOBILE_PLUGIN_ENTRY = "lib/node_modules/dsh-web-mobile/package.json"
        private const val MOBILE_PLUGIN_CLIENT = "lib/node_modules/dsh-web-mobile/lib/client.js"
        private const val MOBILE_PLUGIN_MARKER_FILE =
            "lib/node_modules/dsh-web-mobile/plugin.version"
        private const val MOBILE_PLUGIN_MARKER = "kxxy-mobile-plugin@1"

        /**
         * office 预览链版本标记（锚点 9），由构建期写入
         * `kxxy-host/fonts/office-assets.version`（与 build-runtime.mjs 的
         * OFFICE_FONTS_MARKER 逐字一致）。
         *
         * 为什么需要独立锚点：LibreOffice wasm 引擎（145 MiB）与单文件 CJK
         * 字体（约 21 MiB）是随 runtime 一起发的**新增资产**，而 runtime 版本
         * 戳（[RUNTIME_VERSION]）从未变过。老设备升级 APK 时前九个锚点全部通过，
         * isComplete() 判真并跳过重装，设备上就永远没有这两份文件，Office 预览
         * 一直报「Office 预览不可用」。改动字体字重、字体包版本或 wasm 引擎包
         * 版本时，必须同步递增此编号。
         *
         * 标记写成独立小文件而不是字体首行 —— TTF 的 sfnt 头部不能动。
         *
         * @2 —— wasm 引擎包 0.1.1 → 0.1.5（缺陷 CL，问题清单 R3 / P7）。
         * kit 0.1.5 的 `ENGINE_VERSIONS.wasm` 就是 `"0.1.5"`，而 0.1.1 的
         * `prebuilds.json` 里 `version` 是 `0.1.1`，两者不等 ⇒ kit 抛
         * `Installed LibreOfficeKit wasm package has an incompatible or
         *  incomplete manifest.`。不带标记的设备只靠重装 runtime 是拿不到
         * 新引擎的，所以标记必须一起升。
         */
        private const val OFFICE_LAYER_MARKER = "kxxy-office@2"
        private const val OFFICE_LAYER_MARKER_FILE =
            "lib/node_modules/kxxy-host/fonts/office-assets.version"

        /** wasm 引擎主体；122 MiB，光有标记文件不足以证明它完整落地。 */
        private const val OFFICE_WASM_ENGINE =
            "lib/node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/soffice.wasm"

        /** 随 runtime 发布的单文件 CJK 字体（正体 + 粗体）。 */
        private val OFFICE_FONT_FILES = listOf(
            "lib/node_modules/kxxy-host/fonts/NotoSansSC-Regular.ttf",
            "lib/node_modules/kxxy-host/fonts/NotoSansSC-Bold.ttf",
        )

        /**
         * 构建期补丁集版本标记（锚点 11），由 build-runtime.mjs 写在
         * `kxxy-host/patchset.version`（与该脚本的 PATCHSET_MARKER 逐字一致）。
         *
         * 为什么必须有：前十个锚点探的全是**自有资产**，而绝大多数补丁改的是
         * **上游文件** —— documentpreview 的 `client.js` 与 `client.pdf.js`、
         * `libreoffice-kit/lib/index.js`、`dsh-office-to-pdf/lib/index.js` 等等，
         * 它们没有任何可探的版本标记。真机事故：给 documentpreview 补上
         * zip / epub provider、重建 runtime 与 APK 装机后，设备上
         * `grep -c kxxyArchiveApply` 仍是 0，logcat 只有一句
         * `runtime already installed and complete` —— 前十个锚点全通过，
         * isComplete() 判真，补丁根本没解出来。
         *
         * 改动 patches.mjs 里任何补丁、或增删补丁时，必须同步递增此编号。
         */
        private const val PATCHSET_MARKER = "kxxy-patchset@6"
        private const val PATCHSET_MARKER_FILE = "lib/node_modules/kxxy-host/patchset.version"

        /**
         * Tesseract 简体中文语言包标记（锚点 12）。
         *
         * 为什么必须有：Termux 的 `tesseract` 包只带 `eng.traineddata`，索引里
         * 也没有任何 `tesseract-lang*` 包 —— 中文识别能力只能靠随 runtime
         * 内置。它与 office 资产同型：**新增资产** + [RUNTIME_VERSION] 从未变过
         * ⇒ 老设备前面十一个锚点全过、跳过重装，`tesseract -l chi_sim` 永远报错。
         *
         * 标记写成独立小文件而不塞进 language 包：`.traineddata` 是二进制格式，
         * 首部不能动。标记与 tools/build-runtime.mjs 的 TESSDATA_MARKER 逐字一致。
         */
        private const val TESSDATA_MARKER = "kxxy-tessdata@1"
        private const val TESSDATA_MARKER_FILE = "lib/node_modules/kxxy-host/tessdata.version"

        /** 语言包主体；约 2.4 MiB，光有标记文件不足以证明它完整落地。 */
        private const val TESSDATA_LANGUAGE_FILE = "share/tessdata/chi_sim.traineddata"

        /**
         * TeX Live 宏包树标记（锚点 13）。
         *
         * 为什么必须有：Termux 的 `texlive-bin` deb 只发**引擎**（pdftex/xetex/
         * luatex + kpathsea），`tex/latex`/`tex/plain`/`tlpkg` 全是 0 条 ——
         * 宏包树由构建期从 CTAN 取 scheme-basic 打进 runtime。真机上表现为
         * `command -v pdflatex` 什么都没有、`texlinks` 报
         * `config file 'fmtutil.cnf' not found`、`pdftex` 连 `plain.tex` 都找不到。
         *
         * 与锚点 12 同型：新增资产 + 版本戳不变 ⇒ 不加锚点老设备永不重装。
         * 标记与 tools/build-runtime.mjs 的 TEXLIVE_MARKER 逐字一致。
         *
         * @3：宏包闭包从「scheme-basic 原样」扩到「scheme-basic + 56 个日常宏包
         * 的 WANT 清单，同时跳过 10 个互斥字库」（缺陷 CO，问题清单 R4 / P8）。
         * @2 的树里 `tex/latex` 只有 54 个目录，连 `xcolor.sty` 都没有 ——
         * pandoc 出 PDF 立刻 `! LaTeX Error: File 'xcolor.sty' not found.`。
         * 涨版本号是让老设备把整棵 200 多包的树重装一遍。
         */
        private const val TEXLIVE_MARKER = "kxxy-texlive@3"
        private const val TEXLIVE_MARKER_FILE = "lib/node_modules/kxxy-host/texlive.version"

        /**
         * 宏包树的标志性文件：
         * `article.cls` 是 latex 类、`plain.tex` 是 plain 格式的源、`TLConfig.pm`
         * 在 `tlpkg/` 下（tlmgr 的 Perl 库，`latex/base` 与 `tlpkg` 是两个
         * 独立顶层，只探其中一个会漏掉「解到一半」）。宏包树 5900 个文件，
         * 写入中途失败（存储不足）会留下半棵树 —— 半棵树照样能过
         * `pdftex --version`，所以必须逐个探体积。
         */
        private val TEXLIVE_CORE_FILES = listOf(
            "share/texlive/2026.0/texmf-dist/tex/latex/base/article.cls",
            "share/texlive/2026.0/texmf-dist/tex/plain/base/plain.tex",
            "share/texlive/2026.0/tlpkg/TeXLive/TLConfig.pm",
        )

        /**
         * 带 `resources.arsc` 的 android.jar 的版本标记（缺陷 CQ）。
         *
         * 与 `TEXLIVE_MARKER` 完全同型：`share/java/android.jar` 在上游（ecj 的
         * deb）里是一份 4555 条目的精简 stub，没有 `resources.arsc` ——
         * `aapt2 link` 处理任何 `@android:*` 引用都报
         * `No package ID 01 found for resource ID 0x0101053d`。
         * 构建期由 `tools/build-runtime.mjs` 的 `bundleAndroidJar()` 从本机
         * SDK `platforms/android-36/android.jar` 裁出 arsc + 清单 + class 覆盖。
         * 标记与 `ANDROID_JAR_MARKER` 逐字一致。
         */
        private const val ANDROID_JAR_MARKER = "kxxy-androidjar@1"
        private const val ANDROID_JAR_MARKER_FILE = "lib/node_modules/kxxy-host/androidjar.version"

        /**
         * 打包工具包装器的版本标记（锚点 15，缺陷 CT）。
         *
         * 为什么这个锚点不能省：`bin/corepack` 的修复是**原地换掉一个文件的
         * 形态**（`dist/corepack.js` 的副本 → 156 B 的 `#!/system/bin/sh`
         * 包装器），既不改变 [RUNTIME_VERSION]，也不影响锚点 1–14 的任何判据。
         * 没有这一条，老设备升级 APK 后前十四锚点全通过、`isComplete()` 判真、
         * 跳过重装，corepack 继续报 `Cannot find module './lib/corepack.cjs'`。
         *
         * 标记与 `tools/build-runtime.mjs` 的 `PACKAGING_MARKER` 逐字一致。
         */
        private const val PACKAGING_MARKER = "kxxy-packaging@1"
        private const val PACKAGING_MARKER_FILE =
            "lib/node_modules/kxxy-host/packaging.version"

        /**
         * 包装器实体清单（锚点 15 的第二段判据）。
         *
         * 只探标记不够 —— 标记只能证明 zip 里带的是新版，证明不了 install 真把
         * 它解出来了（锚点 14 的教训）。这五个文件在设备上都必须是可执行的
         * sh 包装器：corepack 修缺陷 CT，zipalign / bundletool 补上 Termux
         * 仓库里根本不存在的两个 Android 打包工具。
         */
        private val PACKAGING_WRAPPERS = listOf(
            "bin/corepack",
            "bin/npm",
            "bin/npx",
            "bin/pnpm",
            "bin/zipalign",
            "bin/bundletool",
        )

        /**
         * 允许以「corepack dist 软链」形态出现的包装器。
         *
         * 只有 corepack 管的那四个 —— `corepack enable` 会自己接管它们，属于官方
         * 文档行为。`zipalign` / `bundletool` 是自造的，没有这个合法形态：它们
         * 一旦变成软链就说明被人动过，按缺陷处理。
         */
        private val COREPACK_SHIM_NAMES = setOf(
            "bin/corepack",
            "bin/npm",
            "bin/npx",
            "bin/pnpm",
        )

        /**
         * android.jar 的下限体积。
         *
         * 旧 stub 是 3,881,757 B，裁剪后的新版是 10,576,708 B —— 取 6 MiB 作
         * 分界：既能拦下没换过的旧 stub，也不会因为将来 platform 版本变化
         * （arsc 大小随资源数量增长）而误判。
         */
        private const val MIN_ANDROID_JAR_BYTES = 6L * 1024 * 1024

        /** 读版本标记时探测的头部字节数；标记都写在首行，取小值即可。 */
        private const val COMPAT_MARKER_PROBE_BYTES = 256

        private const val MAX_SCAN_DEPTH = 6

        /**
         * `chi_sim.traineddata` 的下限体积。
         *
         * tessdata_fast 的简体中文包是 2,438,400 B 左右。取 1 MiB 作下限：
         * 截断到一半（1.2 MiB）仍能过，但明显的半截文件（几百 KB）会拦下 ——
         * 这个值只防「解压中途失败」，不是精确校验，故留足余量。
         */
        private const val MIN_TRAINEDDATA_BYTES = 1_000_000L

        /**
         * 会遮蔽系统真库、必须从 `<root>/lib/` 删掉的库（缺陷 AZ + 缺陷 BH）。
         *
         * **`lib/libbinder_ndk.so`（缺陷 AZ）**：Termux 的 `libandroid-stub`
         * 包里塞的 24,000 B 空壳（0 个 `_Z` 符号），系统真库是 94,488 B /
         * 190 个符号。真机逐个 `mv` 的单变量 A/B 证明：移走其余四个桩库
         * 任意一个，ffmpeg 依旧报错且其它 14 个工具无变化；移走
         * `libmediandk.so` 更糟 —— 系统 `libunwindstack.so` 会报
         * `cannot locate symbol "Xzs_Construct"`。详见 [ensureNoShadowingStubs]。
         *
         * **`lib/liblzma.so`（缺陷 BH）**：这一类不是「桩库太小」，而是
         * **soname 与裸文件名不一致**。`<root>/lib/liblzma.so` 在 zip 里是
         * 软链 `LINK:lib/liblzma.so.5.8.4`，内容是 liblzma 5.8.4
         * （soname `liblzma.so.5`、导出 114 个 `lzma_*`、`Xzs_*` 零个）；
         * 系统的 `/system/lib64/liblzma.so` 是 164,576 B、soname
         * `liblzma.so`、导出 230 个符号、其中 5 个是 `Xzs_*` —— 两者根本
         * 不是同一个库。`<root>/lib` 在 `LD_LIBRARY_PATH` 首位，于是系统
         * `libui.so` → `libunwindstack.so` 那条链 NEEDED 的裸名
         * `liblzma.so` 会命中引擎这个文件，报
         * `CANNOT LINK EXECUTABLE "ffmpeg": cannot locate symbol
         * "Xzs_Construct" referenced by "/system/lib64/libunwindstack.so"`。
         *
         * 安全性：全引擎 3,569 个 ELF64 递归扫 `DT_NEEDED`，精确等于
         * `liblzma.so` 的有 **0 个**（消费者一律用 `liblzma.so.5`，共 50 个）。
         * 删掉后 21 项工具回归全绿且产物字节数逐一相同。
         *
         * ⚠️ `libheif.so` 是同一类（引擎版 soname `libheif.so.1`、1,928,648 B、
         * 469 个符号；系统版 soname `libheif.so`、43,368 B、37 个符号，两者
         * 符号零重叠，系统独有 `_Z17createHeifDecoderv` 正是 `libhwui.so` 要的）。
         * 它**不在 runtime.zip 里** —— 由 gnuplot / imagemagick / texlive 三个
         * 扩展的 `.links.json` 复制进 `<root>/lib/`。所以除了这里删，
         * `plugins/kxxy-host/lib/extinstall.mjs` 的 `SHADOWING_BARE_LIBS` 还要
         * 保证安装/relink 时不再复制回来；两处都做是因为
         * `relinkAll` 只在 `.relink` 标记存在时跑，而快路径不写这个标记，
         * 老设备升级后光靠 relink 摘不掉已经躺在盘上的那份。
         *
         * 与 `tools/build-runtime.mjs` 的 `DROPPED_LIBS` 必须保持一致 —— 后者
         * 管 zip 侧的（binder_ndk、liblzma），`libheif.so` 不在 zip 里所以
         * 只在本清单与 extinstall 的 `SHADOWING_BARE_LIBS` 出现。
         */
        private val SHADOWING_STUBS = listOf(
            "lib/libbinder_ndk.so",
            "lib/liblzma.so",
            "lib/libheif.so",

            /*
             * 缺陷 BQ：v0.8.0 曾把 `libc++.so` / `libc++abi.so` 作为
             * 「链接名别名」复制进 `<root>/lib`，结果遮蔽了 Android 系统的
             * `/system/lib64/libc++.so`（`std::__1` ABI）——
             * `LD_LIBRARY_PATH=<root>/lib` 让它优先命中 Termux 的
             * `libc++_shared.so`（`std::__ndk1` ABI），于是**所有系统二进制**
             * （toybox 的 `rm`/`mkdir`/`ls`/`sh`）都报
             * `CANNOT LINK EXECUTABLE "rm": cannot locate symbol
             * "_ZNKSt3__121__basic_string_commonILb1EE20__throw_length_errorEv"
             * referenced by "/system/lib64/liblog.so"`，整个终端全废。
             *
             * 别名本身也没用：这个 clang 的 driver 在 android triple 下推的是
             * `-lc++_shared`（`clang++ -v` 的链接行实测），从不推 `-lc++`。
             *
             * 只从 `SONAME_ALIASES` 里删**不够** —— 装过 v0.8.0 的设备盘上
             * 已经躺着这两个文件，而快路径（`isComplete()` 为真）不会重装
             * `lib/`。所以必须同时列进这份「每次启动都清一遍」的清单。
             */
            "lib/libc++.so",
            "lib/libc++abi.so",
        )

        /**
         * 安装期要生成的 TeX 格式文件名（不含 `.fmt` 后缀）。
         *
         * 四个都做：`pdflatex`（主流）、`latex`（DVI 路线，jdvips 类工具链
         * 需要）、`xelatex`（CJK 与 OTF 字体）、`lualatex`（LuaTeX，HarfBuzz）。
         *
         * ⚠️ `lualatex` 曾经被排除，注释理由是「闭包里没有 luatex 二进制」——
         * 这是**错的**。真机实测 `<root>/bin/luahbtex` 与 `luatex` 都在（都是
         * `extensions/texlive/bin/texlive/` 的软链），`lualatex.ini` 也能被
         * `kpsewhich` 命中，手工 `luahbtex -ini -jobname=lualatex -progname=lualatex
         * -etex lualatex.ini` **只要 2 秒**就产出 6,859,642 B 的 fmt，之后
         * `lualatex t.tex` 直接出 3,321 B 的 PDF。
         *
         * 设备上实测 pdftex/xetex 系每个 11~12 秒、luahbtex 约 2 秒，四个合计
         * 约 37 秒，只在首次安装/格式缺失时跑一次。参数见 [ensureTexFormats]。
         */
        private val TEX_FORMATS = listOf("pdflatex", "latex", "xelatex", "lualatex")

        /**
         * `texlinks` 应当补出来的标准命令名（见 [ensureTexLinks]）。
         *
         * 只列用户真正会敲的四个 LaTeX 入口，不列全部 411 个引擎别名 ——
         * 判据只用来决定「要不要再跑一次 texlinks」，列全了反而更慢。
         */
        private val TEX_LINK_NAMES = listOf("pdflatex", "latex", "xelatex", "lualatex")

        /**
         * `.fmt` 的下限体积。
         *
         * 设备上真值：`pdflatex.fmt` 2,264,217 B、`latex.fmt` 2,264,136 B、
         * `xelatex.fmt` 4,488,398 B。取 1 MiB 作下限只为拦「生成到一半被杀」
         * 留下的半截文件（-ini 跑到一半确实会留下几百 KB 的残file），
         * 不是精确校验，故留足余量。
         */
        private const val MIN_FMT_BYTES = 1_000_000L

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

            /*
             * 缺陷 BQ（v0.8.1 回滚）：这里**曾经**有 `libc++.so` 与
             * `libc++abi.so` 两条别名，指向 `libc++_shared.so`，理由是
             * 「clang++ 链接期按 -lc++ 找 libc++.so，找不到就 cannot find -lc++」。
             * 那个理由是**错的**，而且修出了比原缺陷严重得多的回归。
             *
             * 真机实测（缺陷 BP 的探针，`clang++ -v` 的完整链接行）：
             *
             *   ld.lld … -L/system/lib64 -L<root>/lib … -lc++_shared …
             *
             * 这个 clang 的 driver 在 android triple 下推的是 `-lc++_shared`，
             * **从不推 `-lc++`**。所以那两条别名对 C++ 链接毫无用处。
             *
             * 但它们在 `<root>/lib` 里造出了两个**同名文件**，而
             * `LD_LIBRARY_PATH=<root>/lib` 会让动态链接器优先命中它们：
             * Android 系统库 `/system/lib64/libc++.so` 用的是 `std::__1` ABI，
             * Termux 的 `libc++_shared.so` 用的是 `std::__ndk1`，两者同名不兼容。
             * 于是**每一个系统二进制**（`rm`/`mkdir`/`ls`/`sh` 的 toybox）在
             * 启动时都 `CANNOT LINK EXECUTABLE "rm": cannot locate symbol
             * "_ZNKSt3__121__basic_string_commonILb1EE20__throw_length_errorEv"
             * referenced by "/system/lib64/liblog.so"` —— 整个终端全废。
             *
             * 所以：这两条别名必须删除。C++ 的**链接期**本来就不需要它们
             * （driver 直接 `-lc++_shared`），**编译期**才是真缺口，由
             * `CPLUS_INCLUDE_PATH` 补（见 EngineConfig.buildEnv）。
             */
        )
    }
}
