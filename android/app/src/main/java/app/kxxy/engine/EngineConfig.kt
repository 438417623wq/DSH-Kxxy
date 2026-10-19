package app.kxxy.engine

import android.content.Context
import java.io.File

/**
 * DSH Kxxy 引擎配置：路径、环境变量与全局常量。
 *
 * 方案 T（Web-First 宿主）下的职责边界：
 *   本文件只负责「引擎进程如何被启动、在哪里运行、看到什么环境」。
 *   所有 UI（含宿主管理页）都在 Web 层，不在这里构造。
 *
 * 目录布局（对齐参考项目 Soodok 的 EngineConfig）：
 *   filesDir/engine/                     运行时根，升级整体替换
 *     bin/node                           引擎可执行文件
 *     bin/{bash,rg,pnpm,curl}            Termux 闭包提供的工具
 *     lib/                               LD_LIBRARY_PATH 首位
 *     lib/node_modules/@deepseek-ai/dsh/lib/bin.js   ← 引擎入口
 *     etc/tls/{cert.pem,openssl.cnf}
 *     android-overlay.yml                启动参数 --patch 指向它
 *     engine.log                         引擎 stdout/stderr 环形日志（2 MB）
 *     kxxy-state.json                    原生层写给 kxxy-host 插件的状态快照
 *     .runtime-version                   安装戳
 *     extensions/<id>/{bin,lib}          扩展中心，永不随 runtime 替换
 *   filesDir/kxxy-home/                  = $HOME = $DSH_HOME
 *     profiles/                          配置面（凭证 0600，绝不外置）
 *     sessions/  workspaces/             → 软链到公开目录
 *   filesDir/tmp/                        = $TMPDIR
 */
object EngineConfig {

    /** 引擎监听端口。官方前端与 WebView 都硬编码它。 */
    const val DEFAULT_PORT = 3080

    /** 健康检查总超时（毫秒）。 */
    const val HEALTH_TIMEOUT_MS = 45_000L

    /** 健康检查轮询间隔（毫秒）。 */
    const val HEALTH_INTERVAL_MS = 500L

    /** 崩溃退避步长（毫秒）；超出后取最后一项。 */
    val BACKOFF_STEPS = longArrayOf(2_000, 4_000, 8_000, 16_000, 32_000)

    /** 连续重启上限。 */
    const val MAX_RESTART = 14

    /** engine.log 环形上限（2 MB，超出保留尾部一半）。 */
    const val MAX_LOG_BYTES = 2L shl 20

    /**
     * 原生层 ↔ 引擎进程的状态交换文件名。
     *
     * 跨进程（app 主进程 vs node 引擎）不引入 RPC：原生层按轮询把
     * pid / 内存 / 运行时长 / 监管状态写进这个 JSON 文件，kxxy-host 插件
     * 只读它（见 plugins/kxxy-host/lib/index.js 的 collectEngineState）。
     */
    const val STATE_FILE_NAME = "kxxy-state.json"

    /**
     * 引擎 → 原生层的重启请求文件。
     *
     * 一个进程无法「重启自己」：kxxy-host 插件跑在引擎进程里，它只能写这个
     * 文件，由原生层（EngineSupervisor 的请求轮询）消费后 stop+start。
     * 与镜像源切换配套 —— buildEnv 注入的 registry 在进程启动时已固定，
     * 改完 npmrc 必须重启引擎才生效（五项改进方案 §7-2 方案 A）。
     */
    const val RESTART_REQUEST_FILE_NAME = "restart.request"

    /**
     * 引擎 → 原生层的 stdin 注入文件。
     *
     * 宿主管理页「终端」视图的快捷键（Ctrl+C / Tab / ↑ / ↓ / Esc）借它写进
     * 引擎的 PTY。同一轮询循环顺带消费，避免为几个字节再开一条通道。
     */
    const val STDIN_REQUEST_FILE_NAME = "stdin.request"

    /** 运行时根目录。 */
    fun engineRoot(ctx: Context): File = File(ctx.filesDir, "engine")

    /** 引擎可执行文件（execve 必须绝对路径，不搜 PATH）。 */
    fun nodeBin(ctx: Context): File = File(engineRoot(ctx), "bin/node")

    /** 引擎入口脚本。 */
    fun dshEntry(ctx: Context): File =
        File(engineRoot(ctx), "lib/node_modules/@deepseek-ai/dsh/lib/bin.js")

    /** Android 适配覆盖层（--patch 参数）。 */
    fun overlayFile(ctx: Context): File = File(engineRoot(ctx), "android-overlay.yml")

    /** 引擎日志。 */
    fun logFile(ctx: Context): File = File(engineRoot(ctx), "engine.log")

    /** 安装戳。 */
    fun stampFile(ctx: Context): File = File(engineRoot(ctx), ".runtime-version")

    /** 原生层写给 kxxy-host 插件的状态快照（见 STATE_FILE_NAME）。 */
    fun stateFile(ctx: Context): File = File(engineRoot(ctx), STATE_FILE_NAME)

    /** 引擎请求原生层重启的文件（见 RESTART_REQUEST_FILE_NAME）。 */
    fun restartRequestFile(ctx: Context): File = File(engineRoot(ctx), RESTART_REQUEST_FILE_NAME)

    /** 引擎请求向引擎 stdin 注入按键的文件（见 STDIN_REQUEST_FILE_NAME）。 */
    fun stdinRequestFile(ctx: Context): File = File(engineRoot(ctx), STDIN_REQUEST_FILE_NAME)

    /**
     * 宿主偏好文件（kxxy-host 插件写的 set-priv-mode / set-toggle 落在这里）。
     *
     * 这是权限等级的**唯一真值来源**：前端改完写这个文件 + 触发引擎重启，
     * 原生层 spawnEngine 时读取 —— 不再需要第二条原生通道。
     */
    fun prefsFile(ctx: Context): File = File(engineRoot(ctx), "kxxy-prefs.json")

    /**
     * 读偏好里的权限等级；缺省/损坏/非法值一律回落 normal。
     *
     * 容忍 UTF-8 BOM（与 kxxy-state.json 同样的事故来源）。
     */
    fun readPrivMode(ctx: Context): String {
        val valid = setOf("normal", "shizuku", "root")
        return runCatching {
            val f = prefsFile(ctx)
            if (!f.isFile) return "normal"
            val json = org.json.JSONObject(f.readText().replace("\uFEFF", ""))
            json.optString("privMode", "normal").takeIf { it in valid } ?: "normal"
        }.getOrDefault("normal")
    }

    /** 扩展根目录（用户资产，升级时绝不触碰）。 */
    fun extensionsRoot(ctx: Context): File = File(engineRoot(ctx), "extensions")

    /** $HOME 与 $DSH_HOME 同址。 */
    fun dshHome(ctx: Context): File = File(ctx.filesDir, "kxxy-home")

    /** $TMPDIR。 */
    fun tmpDir(ctx: Context): File = File(ctx.filesDir, "tmp")

    /** 引擎工作目录（会话 cwd）。 */
    fun workspaces(ctx: Context): File = File(dshHome(ctx), "workspaces")

    /**
     * TeX Live 的**用户树** `$TEXMFVAR`（缺陷 AY 的最后一块拼图）。
     *
     * 为什么要自己指定而不是让 kpathsea 用默认值：TeX Live 的默认值是
     * `$HOME/.texlive<年份>/texmf-var`，年份（当前 `2026`）随发行版变，
     * App 侧不该去猜。显式设成固定目录后可写死，也不必解析 `texlive.cnf`。
     * 真机实测：设 `TEXMFVAR` 后 `kpsewhich --var-value=TEXMFVAR` 逐字回显，
     * 生成到这里的 `pdflatex.fmt` 也能被干净目录里的 `pdflatex` 找到。
     *
     * 它与 `$TEXMFSYSVAR`（`<root>/share/texlive/<年份>/texmf-var`，系统树）
     * 的区别是**这个不带 `!!` 前缀** —— `TEXFORMATS` 里凡是带 `!!` 的树只查
     * `ls-R` 索引、不扫目录，所以系统树放格式必须同时有 `texmf-var/ls-R`；
     * 用户树是逐次扫目录的，**一个索引都不需要**（真机 A/B 已验证）。
     */
    fun texmfVar(ctx: Context): File = File(dshHome(ctx), ".texlive/texmf-var")

    /** 证书目录。 */
    fun tlsDir(ctx: Context): File = File(engineRoot(ctx), "etc/tls")

    /**
     * 随 runtime 打包的单文件字体目录（office 预览用）。
     *
     * 为什么不能直接用 `/system/fonts`：安卓 13 上唯一含完整 CJK 的是
     * `NotoSansCJK-Regular.ttc`，而 LibreOffice 的 wasm 后端把 **`.ttc` 集合**
     * 里的 face 导出成**无字形的 Type1 空壳**（descriptor 用 `/FontFile`、没有
     * `/CharStrings`），pdf.js 据此建不出 `toFontChar`，于是把字符码当 ASCII 画
     * —— 真机症状是「Office」渲染成「O f ce」。单文件 TTF 才会被正确嵌入为
     * `/FontFile2`。所以字体随 runtime 走（见 build-runtime.mjs 的
     * bundleOfficeAssets），落在 kxxy-host 插件目录下。
     */
    fun officeFontsDir(ctx: Context): File =
        File(engineRoot(ctx), "lib/node_modules/kxxy-host/fonts")

    /**
     * 自带的 OpenJDK 主目录（`<root>/lib/jvm/<name>`），找不到返回 null。
     *
     * 为什么不写死 `java-21-openjdk`：目录名由 deb 包版本决定，换一条 Termux
     * 源就可能变成 `java-17-openjdk`。判据用「存在 bin/java 可执行文件」，
     * 这样目录名怎么变都能命中。
     *
     * 为什么必须做这一步（问题.txt【3】）：OpenJDK 装在 `lib/jvm/.../bin` 下，
     * 既没链进 `<root>/bin` 也没设 `JAVA_HOME`，于是 `java` 根本不在 PATH 上 ——
     * kotlinc / gradle 全靠 `command -v java` 或 `$JAVA_HOME/bin/java` 找它，
     * 两处都落空就报「No such file or directory」。
     */
    fun javaHome(ctx: Context): File? {
        val jvmRoot = File(engineRoot(ctx), "lib/jvm")
        if (!jvmRoot.isDirectory) return null
        return jvmRoot.listFiles()
            ?.filter { it.isDirectory && File(it, "bin/java").isFile }
            ?.sortedBy { it.name }
            ?.firstOrNull()
    }

    /**
     * Go 的安装根（GOROOT）—— 缺陷 BI。
     *
     * 真机症状：`go` 能跑起来但一切命令都报
     *   `go: cannot find GOROOT directory: /data/data/com.termux/files/usr/lib/go`
     * 因为 Go 的 GOROOT 推导规则是「取可执行文件的真实路径 → 上溯两级」，
     * 而扩展的 `bin/go` 是 poolextract 物化出来的**真实 ELF 副本**（不是软链），
     * 落在 `<root>/bin/go` ⇒ 上溯两级得到 `<root>`，不是 `<root>/lib/go`。
     * 而且 go 二进制里根本没有把 Termux 的 lib/go 路径编进去（实测 grep 零命中），
     * 所以「装好就能自动找到」这条路是不存在的，只能显式给 GOROOT。
     *
     * 首选 `<root>/lib/go`：extinstall 的合并视图会把 golang 扩展的 `lib/go`
     * 摊到引擎根（与 guile / perl5 / rustlib 同路）。
     * 合并视图还没建立时回落到扩展目录，两处都没有就返回 null（不设 GOROOT，
     * 让 go 自己报错，比给一个错路径更容易排查）。
     */
    private fun goRoot(root: File): File? {
        val merged = File(root, "lib/go")
        if (File(merged, "src/runtime").isDirectory) return merged
        val inExt = File(root, "extensions/golang/lib/go")
        if (File(inExt, "src/runtime").isDirectory) return inExt
        // 兜底：只看 VERSION 文件，兼容上游改了 src 布局的情形。
        return listOf(merged, inExt).firstOrNull { File(it, "VERSION").isFile }
    }

    /**
     * Guile 的 Scheme 源搜索路径（问题.txt【5】，gdb 依赖它）。
     *
     * 首选 `<root>/share/guile/3.0` —— extinstall 的合并视图会把 gdb 扩展的
     * `share/guile` 摊到引擎根，与 FONTCONFIG_PATH / TESSDATA_PREFIX 同路。
     * 合并视图尚未建立时（扩展刚装好、插件还没跑过 relink）回落到扩展目录，
     * 免得 gdb 在这个窗口里 abort。两个都没有就返回首选值 —— 让 guile 自己
     * 报错比给一个空路径更好排查。
     */
    private fun guileLoadPath(root: File): String {
        val merged = File(root, "share/guile/3.0")
        val inExt = File(root, "extensions/gdb/share/guile/3.0")
        return when {
            merged.isDirectory -> merged.absolutePath
            inExt.isDirectory -> inExt.absolutePath
            else -> merged.absolutePath
        }
    }

    /**
     * Guile 的**预编译字节码**（`.go`）搜索路径 —— 缺陷 BC，性能修复。
     *
     * 这一条是 gdb「启动要 150 秒」的真正解药，与 [guileLoadPath]（源码路径）
     * 完全独立：源码路径只解决「能不能启动」，这条解决「要等多久」。
     *
     * 真机 A/B（同一设备、同一份 gdb，`guile -c '1'` 各跑两次）：
     *   什么都不设                        → 14 s / 13 s
     *   只设 GUILE_AUTO_COMPILE=0         → 13 s   ← 关自动编译**毫无作用**
     *   只设 GUILE_LOAD_COMPILED_PATH     →  0 s   ← 唯一有效的那一个
     *   两者都设                          →  0 s
     * 对应 `gdb --version`：151 s CPU / 2:37 墙钟 → 亚秒级。
     *
     * ⚠️ 旧注释里「AUTO_COMPILE=0 是纯粹收益（225 s vs 1837 s）」的结论是
     * **测量假象**：两组都没设 LOAD_COMPILED_PATH，guile 每次都现场把
     * `system/repl` 下的 `.scm`（`command.scm` 32 KB、`repl.scm` 8 KB ……）编译成
     * 字节码，落不落盘只影响「下次是否重编」，量级都在百秒级。设上这条之后
     * 编译产物直接被命中，**两条路一起消失**。
     *
     * 路径取 `<root>/lib/guile/3.0/ccache`：扩展里打包的预编译产物在
     * `extensions/gdb/lib/guile/3.0/ccache`（344 个 `.go`），由 extinstall 的
     * 合并视图摊到引擎根的 `lib/` 下 —— 与 `share/guile/3.0` 的源码树同构。
     *
     * 注意有 17 个辅助 `.scm`（`ice-9/psyntax.scm`、`system/repl/describe.scm`、
     * `sxml/upstream` 下的几个 …）在 ccache 里没有对应 `.go`（上游不预编译它们，
     * 都是被 `include` 进别的模块的），这些仍然只能解释执行 —— 但它们不是
     * 那 150 秒的来源，实测不设本条时 `system repl` 一棵树就要 141 s。
     *
     * ⚠️ 上面几处路径**不能写成带星号的 glob**：KDoc 本身是块注释，
     * 而 Kotlin 的块注释**支持嵌套** —— 路径里出现斜杠紧跟星号就被当成新的
     * 注释开层，本段的结束标记只关掉内层，外层一直吞到文件末尾，报
     * `Missing '}'` + `Unclosed comment` 两个完全不指向真因的错误。
     */
    private fun guileCompiledPath(root: File): String {
        val merged = File(root, "lib/guile/3.0/ccache")
        val inExt = File(root, "extensions/gdb/lib/guile/3.0/ccache")
        return when {
            merged.isDirectory -> merged.absolutePath
            inExt.isDirectory -> inExt.absolutePath
            else -> merged.absolutePath
        }
    }

    /**
     * Emacs 的版本目录（`<root>/share/emacs/<版本>`），缺陷 BA。
     *
     * 版本号（当前 `31.1`）随包升级而变，所以扫 `share/emacs/` 取**字典序最大**
     * 的那个 —— 与 [guileLoadPath] 的「合并视图优先、扩展目录兜底」同一套路。
     * 合并视图尚未建立时回落到 `extensions/emacs/share/emacs/`。
     *
     * ⚠️ 必须**只认纯版本号形态的目录名**。真机踩过：`share/emacs/` 下除了
     * `31.1` 还有一个 `site-lisp`，而按字典序 `"site-lisp" > "31.1"`（`s` > `3`），
     * 于是取到 `share/emacs/site-lisp`，`EMACSDATA` 指向不存在的
     * `share/emacs/site-lisp/etc`，emacs 直接报
     * `Emacs will not function correctly without the character map files.` +
     * `The EMACSDATA environment variable is set.  Maybe it has the wrong value?`
     * 并 rc=1。判据用「首字符是数字」而不是「全部是数字和点」，因为版本可能
     * 带后缀（`31.1-rc1`）；但必须排除 `site-lisp`/`etc` 这类非版本目录。
     *
     * 全都没有就返回合并视图的猜测路径：让 emacs 自己报错比给空字符串好排查
     * （空串会被 emacs 当成「用编译期默认值」，反而看不出问题）。
     */
    private fun emacsVersionDir(root: File): File {
        for (base in listOf(File(root, "share/emacs"), File(root, "extensions/emacs/share/emacs"))) {
            if (!base.isDirectory) continue
            val versions = base.listFiles { f -> f.isDirectory }
                ?.map { it.name }
                ?.filter { it.isNotEmpty() && it[0].isDigit() }
                ?.sorted()
            if (!versions.isNullOrEmpty()) return File(base, versions.last())
        }
        return File(root, "share/emacs/31.1")
    }

    /** Emacs 的 `etc/`（charsets、DOC、HELLO…）。对应 `EMACSDATA` / `EMACSDOC`。 */
    private fun emacsDataDir(root: File): String = File(emacsVersionDir(root), "etc").absolutePath

    /**
     * Emacs 的 `load-path` 初值，对应 `EMACSLOADPATH`。
     *
     * 顺序照搬 emacs 自己的默认值：`lisp` → `site-lisp` → `lisp/leim`（输入法）。
     * `site-lisp` 排在 `leim` 前面是有意的 —— 用户自己装的包应当优先于内置
     * 输入法目录被找到。
     *
     * **最前面多插一条 Kxxy 自己的目录**（[emacsSiteLoadDir]），里面只有一个
     * 安装期生成的 `site-load.el`：它把 `source-directory` 改成真实存在的
     * `<root>/share/emacs/<版本>/`，并让 `emacs-repository-get-version` /
     * `-get-branch` 直接返回 nil。没有它，每次启动（含 `--batch`）都会刷两条
     * `Error running git rev-parse: (file-missing "Setting current directory" …
     * "/data/data/com.termux/files/usr/share/emacs/31.1/")` —— 因为
     * `loadup.el:463` 在 `(and (eq system-type 'android) (not (pdumper-stats)))`
     * 成立时会去那个不存在的 Termux 源码目录里问 git。
     *
     * 为什么用 `site-load.el` 而不是改 `share/` 里的文件：`loadup.el:411` 的
     * `(load "site-load" t)` 走的是普通 `load`，会沿 `load-path` 找到我们这条；
     * 而 `share/emacs/<版本>/lisp/` 是 runtime.zip 的产物，重建 runtime 会被
     * 覆盖掉，用户树里的文件才活得久。
     */
    private fun emacsLoadPath(root: File, ctx: Context): String {
        val v = emacsVersionDir(root)
        return listOf(
            emacsSiteLoadDir(ctx),
            File(v, "lisp"),
            File(v, "site-lisp"),
            File(v, "lisp/leim"),
        ).joinToString(":") { it.absolutePath }
    }

    /**
     * Kxxy 给 Emacs 准备的 `site-load.el` 所在目录（`<home>/.emacs.d/kxxy`）。
     *
     * 放在 `$HOME` 下而不是引擎树里：引擎树是 runtime.zip 的产物，重装/升级
     * 会整棵重建，而 `$HOME` 是用户数据，跨版本保留。
     */
    fun emacsSiteLoadDir(ctx: Context): File = File(dshHome(ctx), ".emacs.d/kxxy")

    /**
     * Emacs 的架构相关 libexec 目录，对应 **`EMACSPATH`**。
     *
     * 布局是 `libexec/emacs/<版本>/<arch>/`，`<arch>` 形如 `aarch64-linux-android`。
     * 这里扫目录取第一个（正常只有一个）；没有就返回合并视图的猜测路径。
     *
     * 变量名是 `EMACSPATH` 而不是 `EMACSLIBEXEC` —— 真机 A/B 定死：
     * 只有 `EMACSPATH` 能让 emacs 31.1 的 `exec-path`/`exec-directory` 指向这里，
     * `EMACSLIBEXEC` 对它**完全无效**（设了等于没设，`arch-warn` 仍是 1）。
     * 二进制里被 `getenv` 的 EMACS* 名字只有五个：`EMACSDATA` / `EMACSDOC` /
     * `EMACSLOADPATH` / `EMACSPATH` / `EMACS_FONT_LOG`（`EMACS_IGNORE_TIMERFD`）。
     */
    private fun emacsLibExecDir(root: File): String {
        val version = emacsVersionDir(root).name
        for (base in listOf(
            File(root, "libexec/emacs/$version"),
            File(root, "extensions/emacs/libexec/emacs/$version"),
        )) {
            if (!base.isDirectory) continue
            val arch = base.listFiles { f -> f.isDirectory }?.firstOrNull()
            if (arch != null) return arch.absolutePath
        }
        return File(root, "libexec/emacs/$version/aarch64-linux-android").absolutePath
    }

    /**
     * Perl 的模块搜索路径（问题.txt【1】【6】）。
     *
     * 真机症状：`perl -Mstrict -e 1` 报
     * `Can't locate strict.pm in @INC … (@INC entries checked:
     * /data/data/com.termux/files/usr/lib/perl5/5.42.2/…)`
     * —— 连 `strict` 这个核心 pragma 都找不到。@INC 里的**每一条**都是
     * Termux 前缀（`/data/data/com.termux/…`），一条都不存在。
     *
     * 根因：perl 把编译期的 `$PREFIX` 编译进了 `@INC` 与 `Config.pm`，
     * 而 `/data/data/com.termux/files/usr` 在安卓引擎里不存在。perl 的
     * `@INC` 编译期条目无法用文件回填修掉（那是 C 字符串），只能靠
     * `PERL5LIB` 在其**前面**插入真实路径。
     *
     * 布局是 `<root>/lib/perl5/[site_perl/]<版本>[/<arch>]`，版本号随 perl 包
     * 升级而变（当前 5.42.2），所以这里扫目录而不是写死。
     *
     * ⚠️ 只收「版本目录」与「版本目录下的架构目录」，**不要**把版本目录里的
     * 每个模块目录（`App/`、`Archive/`、`B/`…）都塞进来 —— 首版就是这么写的，
     * 结果 PERL5LIB 变成 60 多条、几 KB 长（真机 `/proc/<pid>/environ` 实测）。
     *
     * 架构目录的判据是**名字**：perl 的 `$Config{archname}` 形如
     * `aarch64-android`，与模块目录（`App`、`CPAN`、`Compress`…）的区别很明确 ——
     * 恰好一个小写字母数字段、一个连字符、再一个小写字母数字段。
     * （用「含 .so」判断会漏掉它：`.so` 都在 `aarch64-android/CORE/` 里。）
     */
    private val perlArchName = Regex("^[a-z0-9_]+-[a-z0-9_]+$")

    private fun perlLibPath(root: File): String {
        val dirs = linkedSetOf<File>()
        // 候选根：合并视图 `lib/perl5` **加上**每个扩展自己的 `lib/perl5`。
        //
        // 为什么必须双份：`lib/perl5` 下的 `5.44.0` / `site_perl` 是插件
        // `relinkAll` 建的软链视图（指向 `extensions/autotools/lib/perl5/…`），
        // 而 `exiftool` 的 `Image/ExifTool.pm` 又是 relink 从
        // `extensions/exiftool/lib/perl5/site_perl/5.44.0/Image` 再链进
        // autotools 那一层的。完整重装会把 `lib/` 整体删空，此刻 relink 还没跑，
        // `lib/perl5` 整棵树都不存在 ⇒ exiftool 报
        // `Can't locate Image/ExifTool.pm in @INC`（缺陷 BD 的第二个出口）。
        // 直接扫扩展树就不受 relink 时序影响。
        val roots = linkedSetOf<File>()
        File(root, "lib/perl5").let { roots += it }
        File(root, "extensions").listFiles()
            ?.filter { it.isDirectory }
            ?.sortedBy { it.name }
            ?.forEach { ext -> roots += File(ext, "lib/perl5") }
        for (base in roots) {
            if (!base.isDirectory) continue
            for (root5 in listOf(base, File(base, "site_perl"))) {
                val versions = root5.listFiles()?.filter { it.isDirectory }?.sortedBy { it.name } ?: continue
                for (version in versions) {
                    dirs += version
                    version.listFiles()
                        ?.filter { it.isDirectory && perlArchName.matches(it.name) }
                        ?.sortedBy { it.name }
                        ?.forEach { dirs += it }
                }
                dirs += root5
            }
        }
        if (dirs.isEmpty()) return File(root, "lib/perl5").absolutePath
        return dirs.joinToString(":") { it.absolutePath }
    }

    /**
     * Ruby 的 `$LOAD_PATH` 补丁（缺陷 BS）。
     *
     * 真机症状：`ruby -e 'puts 1'` 正常，但任何 `require` 标准库都炸 ——
     * `gem --version` 报 `cannot load such file -- rubygems/gem_runner`，
     * `ruby -rjson -e …` 报 `cannot load such file -- json`。
     *
     * 根因与 perl / gdb 同族：`libruby.so` 把 `$LOAD_PATH` 的前缀**编译期写死**
     * 成 Termux 的 `/data/data/com.termux/files/usr/lib/ruby/…`（真机实测
     * `ruby -e 'puts $LOAD_PATH'` 打印的八条全是 `com.termux` 路径），而
     * `poolextract.py` 的 `rewrite_prefixes` **跳过 ELF**，所以这些字符串在
     * 设备上仍是字面量，一个都不存在。`libruby` 会读 `RUBYLIB` 并在内置
     * 路径**之前**插入，这正是官方的覆盖点。
     *
     * 目录形状（Termux 的 ruby 包）：
     *   `lib/ruby/<ver>/{,<arch>}`          —— 标准库与架构扩展（.so）
     *   `lib/ruby/site_ruby/<ver>/{,<arch>}` —— 站点库
     *   `lib/ruby/vendor_ruby/<ver>/{,<arch>}` —— 第三方库
     * `gem` 的 `rubygems/gem_runner` 在 `lib/ruby/<ver>/rubygems/`，`json` 在
     * `lib/ruby/<ver>/json.rb` 与 `lib/ruby/<ver>/<arch>/json/` 两处，所以
     * 版本目录与架构目录**都要**加。
     *
     * 版本号与架构名都随包版本变（当前 `4.0.0` / `aarch64-linux-android`），
     * 所以扫目录而不是写死 —— 与 [perlLibPath] 同一套思路。
     */
    private fun rubyLibPath(root: File): String {
        // 架构目录的判据：名字里带连字符（`aarch64-linux-android`），
        // 与 `rubygems`、`bundler` 这类普通模块目录区分得开。
        fun archDirs(version: File): List<File> =
            version.listFiles()
                ?.filter { it.isDirectory && it.name.contains('-') }
                ?.sortedBy { it.name }
                ?: emptyList()

        // 候选根：合并视图 `lib/ruby` **加上**每个扩展自己的 `lib/ruby`。
        // 双份的理由与 [perlLibPath] 完全相同：`lib/ruby` 是 extinstall 建的
        // 软链视图，完整重装会把 `lib/` 删空、relink 还没跑，此刻只有扩展树里有。
        val roots = linkedSetOf<File>()
        roots += File(root, "lib/ruby")
        File(root, "extensions").listFiles()
            ?.filter { it.isDirectory }
            ?.sortedBy { it.name }
            ?.forEach { ext -> roots += File(ext, "lib/ruby") }

        val dirs = linkedSetOf<File>()
        for (base in roots) {
            if (!base.isDirectory) continue
            // `site_ruby` 与 `vendor_ruby` 先于版本目录（Ruby 官方顺序），
            // 它们下面还有一层版本目录。
            for (sub in listOf("site_ruby", "vendor_ruby")) {
                val holder = File(base, sub)
                if (!holder.isDirectory) {
                    dirs += holder
                    continue
                }
                dirs += holder
                val versions = holder.listFiles()?.filter { it.isDirectory }?.sortedBy { it.name }
                    ?: continue
                for (version in versions) {
                    dirs += version
                    dirs += archDirs(version)
                }
            }
            // 主版本目录：`lib/ruby/4.0.0` 与 `lib/ruby/4.0.0/<arch>`。
            val versions = base.listFiles()
                ?.filter { it.isDirectory && !it.name.contains('-') && it.name != "gems" }
                ?.sortedBy { it.name }
                ?: continue
            for (version in versions) {
                dirs += version
                dirs += archDirs(version)
            }
            // `gems/` 是 `gem install` 的落地根，RubyGems 靠 `GEM_HOME` 找它，
            // 但 `gem` 自己的 `rubygems/*.rb` 在版本目录里，不需要 `gems/`。
        }
        if (dirs.isEmpty()) return File(root, "lib/ruby").absolutePath
        return dirs.joinToString(":") { it.absolutePath }
    }

    /**
     * kpathsea 的配置文件搜索路径（问题.txt【4】）。
     *
     * 真机症状：`kpsewhich` 与 `pdftex` 都报
     * `warning: kpathsea: configuration file texmf.cnf not found in these
     * directories: /data/user/0/app.kxxy/…/extensions/texlive/bin/texlive:…`
     * —— 它把 `texmf.cnf` 找遍了**可执行文件所在目录**的上下级，一个都没有。
     *
     * 根因：TeX Live 的 `texmf.cnf` 装在
     * `share/texlive/<年份>/texmf-dist/web2c/texmf.cnf`，而 kpathsea 默认
     * 只从 `$TETEXDIR`/自身目录/编译期前缀那一串里找 —— Termux 的原生安装
     * 靠 `$PREFIX/share/texlive/…` 命中，搬到 extensions/ 后全落空。
     *
     * 设置 `TEXMFCNF` 后 kpsewhich 立刻能报出正确的 `TEXMFROOT`。年份目录
     * 随 TeX Live 版本变（当前 `2026.0`），所以扫目录而不是写死。
     */
    private fun texmfCnfPath(root: File): String {
        val base = File(root, "share/texlive")
        val fallback = File(base, "2026.0/texmf-dist/web2c")
        val found = base.listFiles()
            ?.filter { it.isDirectory }
            ?.sortedBy { it.name }
            ?.map { File(it, "texmf-dist/web2c") }
            ?.firstOrNull { it.isDirectory }
        return (found ?: fallback).absolutePath
    }

    /**
     * `TEXMFROOT` —— TeX Live 的「树根」，`texmf.cnf` 里的 `$TEXMFDIST`、
     * `$TEXMFSYSVAR`、`$TEXMFLOCAL` 全都相对它展开（缺陷 AY）。
     *
     * **它是那三处 TeX 故障里最隐蔽的一处**：不设它时 kpathsea 把
     * `TEXMFROOT` 解析成 `$SELFAUTOPARENT`（可执行文件的祖父目录），
     * 于是变成 `<root>/extensions/texlive` —— 而宏包树根本不在那儿，
     * 一切「文件找不到」的报错都指向一个**语法正确但不存在**的路径：
     *
     *   · `kpsewhich fmtutil.cnf` 空 ⇒ texlinks 报 `config file not found`；
     *   · `kpsewhich article.cls` 空 ⇒ fmtutil 报 `inifile not found`；
     *   · `tlmgr` 报 `Can't locate TeXLive/TLConfig.pm`（`tlpkg/` 也在这棵树下）。
     *
     * 与 [texmfCnfPath] 同源：宏包树被我们摊到 `share/texlive/<年份>/`，
     * 而它的布局是 `texmf-dist/` 与 `tlpkg/` **同级**在根下。
     * 年份随版本变，扫目录不写死。
     */
    private fun texmfRoot(root: File): String {
        val base = File(root, "share/texlive")
        val fallback = File(base, "2026.0")
        val found = base.listFiles()
            ?.filter { it.isDirectory }
            ?.sortedBy { it.name }
            ?.firstOrNull { File(it, "texmf-dist").isDirectory }
        return (found ?: fallback).absolutePath
    }

    /**
     * 构造引擎进程的完整环境变量数组。
     *
     * ⚠️ 这是**完整替换**而非增量：原生层用 `execve(cmd, argv, envp)`，
     * 父进程环境一律不继承（见 cpp/dsh_pty.c 的 G3 说明）。
     *
     * PATH 首位是 engine/bin —— 这是刻意设计：它让 engine/bin 下的
     * su / shz 闸门脚本能遮蔽 /system/bin 的同名命令。
     */
    fun buildEnv(ctx: Context, port: Int, privMode: String): Array<String> {
        val root = engineRoot(ctx)
        val home = dshHome(ctx)
        val tmp = tmpDir(ctx)

        // ⚠️ 这里曾经拼进 `<root>/usr/bin` 与 `<root>/usr/lib`，而引擎根下根本
        // 没有 `usr/` 目录（runtime 的顶层是 bin/lib/etc/var/share/libexec/include）
        // —— 那是 Termux 前缀 `$PREFIX/usr` 的残留写法。PATH/LD_LIBRARY_PATH 里的
        // 死路径本身不报错，但会让 `command -v` 类诊断误导排查方向（问题.txt【7】）。
        val javaHome = javaHome(ctx)

        val path = buildList {
            // 缺陷 BN：`opt/<name>/bin` 必须排在 `<root>/bin` **之前**。
            //
            // maven / gradle / kotlin 这三个包的启动脚本都用「`dirname $0` 的上一级」
            // 反推自己的 home：
            //   · mvn     → `MAVEN_HOME=$(dirname "$PRG")/..`，再找 `boot/plexus-classworlds-*.jar`
            //   · gradle  → `APP_HOME=$(cd -P "${APP_HOME:-./}.." && pwd)`，再找 `lib/gradle-*-cli-main.jar`
            //   · kotlinc → `findKotlinHome()` 用 `BASH_SOURCE` 上溯一级，再找 `lib/kotlin-compiler.jar`
            // 而 extinstall 的 collectBins 会把每个扩展 `bin/` 下的**每个**文件都摊平软链到
            // `<root>/bin`，于是 `<root>/bin/mvn` 存在但它的「上一级」是 `<root>` ——
            // 三个工具全都找不到自己的 jar，报的却是一句毫无线索的
            // `Error: Could not find or load main class ...`。
            // 真身在 `<root>/opt/<name>/bin/<name>`（`opt/` 由 mergeViews 摊到引擎根）。
            for (name in listOf("maven", "gradle", "kotlin")) {
                val dir = File(root, "opt/$name/bin")
                if (dir.isDirectory) add(dir.absolutePath)
            }
            // 缺陷 BR：yarn 的启动脚本不在 `opt/` 而在 `share/yarn/bin`，且它
            // 用 `basedir=$(dirname "$(readlink -f "$0")")` 反推 `yarn.js` 的位置。
            //
            // 真机症状：`yarn --version` 报
            //   Error: Cannot find module '…/engine/extensions/yarn/bin/yarn.js'
            // 根因与 maven 同型但方向相反：deb 里 `bin/yarn` 是
            // `-> ../share/yarn/bin/yarn` 的符号链接，而 `tools/lib/poolextract.py`
            // 会把符号链接**物化成实体副本**（`plugins/kxxy-host/lib/tar.mjs` 不解
            // type '2' 的条目），于是 `extensions/yarn/bin/yarn` 是一份真文件，
            // `readlink -f` 解析到的就是它自己所在的 `extensions/yarn/bin/` ——
            // 那个目录下只有 `yarn` 与 `yarnpkg`，没有 `yarn.js`。
            // 真正带 `yarn.js` 的是 `<root>/share/yarn/bin/`（extinstall 的 mergeViews
            // 把扩展的 `share/` 摊到引擎根），所以把它排在 `<root>/bin` 之前即可。
            val yarnBin = File(root, "share/yarn/bin")
            if (yarnBin.isDirectory) add(yarnBin.absolutePath)
            add(File(root, "bin").absolutePath)
            // git-core 的 `git-remote-https` / `git-remote-http` 等 helper 与
            // termux-api 的 shim 都在 `<root>/libexec`。不在这里的话
            // `git clone https://…` 会报 `git: 'remote-https' is not a git command`。
            val libexec = File(root, "libexec")
            if (libexec.isDirectory) add(libexec.absolutePath)
            // OpenJDK 不在 <root>/bin 下，必须显式加进去，否则 kotlinc / gradle
            // 的 `command -v java` 与 `$JAVA_HOME/bin/java` 两条路都落空。
            javaHome?.let { add(File(it, "bin").absolutePath) }
            add("/system/bin")
            add("/system/xbin")
        }.joinToString(":")

        val ldPath = File(root, "lib").absolutePath

        // 引擎自带的头文件目录（问题.txt【5】）。
        //
        // 实测：这个 clang 的默认系统头搜索路径**只有** `<root>/lib/clang/21/include`
        // 一项（`cc -E -Wp,-v` 输出），连 `stdio.h` 都找不到 —— Termux 的 libc 头装在
        // `<root>/include`，而它是靠包的 specs/wrapper 加进去的，脱离 Termux 的
        // `$PREFIX` 布局后那层配置失效。所以必须由环境变量补上。
        //
        // `aarch64-linux-android/` 是 NDK 那份（`asm/types.h` 只在这里，
        // 而 `<root>/include/linux/types.h` 第 9 行就 `#include <asm/types.h>`）。
        //
        // `include/c++/v1` 是 **C++ 标准库头**（缺陷 BJ）—— 真机症状是
        // `fatal error: 'iostream' file not found`，`g++`/`clang++` 一律编译不过。
        // 那一千多个头文件（`iostream`、`vector`、`__config` …）确实在 runtime.zip
        // 里、也确实解到了 `<root>/include/c++/v1`，但这个 clang 的驱动**不会**
        // 自动把 `<sysroot>/include/c++/v1` 加进搜索列表 —— 它只认自己
        // resource-dir 下的 `lib/clang/21/include`。Termux 那边是 libc++ 的包
        // 往 clang 的配置里塞了 `-stdlib=libc++ -isystem .../c++/v1`，我们脱离
        // 了那套包管理，只能自己用环境变量补。
        //
        // ⚠️ **它不能放进 `CPATH` / `C_INCLUDE_PATH`**（缺陷 BP，v0.8.1 修正）。
        // 那两个变量对 C 与 C++ **都**生效，而 libc++ 的 `c++/v1/stdio.h` 是
        // 一层 `#include_next` 包装头，要求「C++ 头目录排在 C 头目录之前」。
        // 放在 `CPATH` 末尾时顺序反了，真机报：
        //
        //   c++/v1/cstdio:107:5: error: <cstdio> tried including <stdio.h> but
        //   didn't find libc++'s <stdio.h> header. …
        //
        // 放在 `CPATH` 最前又会污染纯 C 编译（`stdio.h` 先命中 libc++ 包装头）。
        // 正解是 `CPLUS_INCLUDE_PATH`：GCC/Clang 都只对 C++ 输入生效，
        // 且天然排在 `CPATH` 之前。真机四组对照（V1~V4）里只有
        // 「`CPATH` 只放 C 头 + `CPLUS_INCLUDE_PATH` = c++/v1 + C 头」这一组
        // 让 C++ 与 C 同时通过，`clang++ -v` 也确认它被展开成
        // `-cxx-isystem .../c++/v1` 且排在 `-c-isystem` 之前。
        val includeDirs = listOf(
            File(root, "include"),
            File(root, "include/aarch64-linux-android"),
        )
            .filter { it.isDirectory }
            .joinToString(":") { it.absolutePath }

        // C++ 专用头搜索路径：`c++/v1` 必须**排在 C 头之前**（见上）。
        val cxxIncludeDirs = listOf(
            File(root, "include/c++/v1"),
            File(root, "include"),
            File(root, "include/aarch64-linux-android"),
        )
            .filter { it.isDirectory }
            .joinToString(":") { it.absolutePath }

        val env = mutableListOf(
            "PATH=$path",
            "LD_LIBRARY_PATH=$ldPath",
            // 链接期库搜索路径（问题.txt【5】）。
            //
            // 为什么非它不可：cc 的链接驱动把 LIBRARY_PATH 展开成 `-L`，而
            // **rustc 不认 RUSTFLAGS**（那个变量只对 cargo 生效）。rustc 的链接行
            // 里写死 `-lunwind`，而 `libunwind` 在 rustlib 目录下只有 `.rlib`/`.rmeta`，
            // 真身在 `<root>/lib/libunwind.a`。真机实测：不加就是
            // `ld.lld: error: unable to find library -lunwind`，加了直接编译通过。
            "LIBRARY_PATH=$ldPath",
            "CPATH=$includeDirs",
            "C_INCLUDE_PATH=$includeDirs",
            // 缺陷 BP：C++ 头搜索路径单独走 CPLUS_INCLUDE_PATH ——
            // `c++/v1` 必须排在 C 头之前，而 CPATH 对 C 也生效、顺序上做不到两全。
            "CPLUS_INCLUDE_PATH=$cxxIncludeDirs",
            "PREFIX=${root.absolutePath}",
            "HOME=${home.absolutePath}",
            "DSH_HOME=${home.absolutePath}",
            "TMPDIR=${tmp.absolutePath}",
            // 官方终端面板的默认 shell 取 process.env.SHELL || userInfo().shell；
            // Termux 编译的 node 在 libuv 里把 passwd 回落硬编码成 Termux 的 bash
            // （真机症状：终端报 ".../com.termux/.../bash is not an executable file"），
            // 必须显式指回自带 bash。
            "SHELL=${File(root, "bin/bash").absolutePath}",
            "PORT=$port",
            "NODE_ENV=production",
            // 小写：AI 按文档写 [ "$DSH_ANDROID_PRIV_MODE" = "root" ] 才能成立
            "DSH_ANDROID_PRIV_MODE=$privMode",
            // Android 无 landlock/seatbelt，受限模式会让 shell 工具拒绝执行
            "DSH_PERMISSION_MODE=danger-full-access",
            // aapt/apksigner/zipalign 靠它判断是否运行在 Android 上
            "ANDROID_DATA=/data",
            "ANDROID_ROOT=/system",
            "ANDROID_STORAGE=/storage",
            // 扩展装到 extensions/<id>/ 后，各工具的配置文件与资源仍在自己的目录里，
            // 而它们编译期记下的路径是 Termux 的单一前缀（$PREFIX/etc、$PREFIX/share）。
            // extinstall 会把每个扩展的 etc/ 与 share/ 逐项软链进引擎根的 etc/ 与
            // share/（见 buildViews），所以这里指回引擎根即可（问题.txt【6】）。
            "FONTCONFIG_PATH=${File(root, "etc/fonts").absolutePath}",
            "TESSDATA_PREFIX=${File(root, "share/tessdata").absolutePath}",
            // perl 的 @INC 修复（问题.txt【1】）。没有它，任何 `use strict` 的
            // perl 脚本都直接 BEGIN failed —— 包括 TeX Live 的 fmtutil.pl /
            // mktexfmt / tlmgr（它们全是 perl 脚本），于是「装了 TeX Live 却
            // 生成不了格式文件、编不出任何文档」。
            "PERL5LIB=${perlLibPath(root)}",
            // ruby 的 $LOAD_PATH 修复（缺陷 BS）。没有它，`ruby` 本身能跑，
            // 但任何 `require` 都失败 —— `gem`、`bundle`、`irb` 全部不可用。
            // 详见 [rubyLibPath] 的注释。
            "RUBYLIB=${rubyLibPath(root)}",
            // kpathsea 的 texmf.cnf 定位（问题.txt【4】）。没有它，pdftex 会去
            // 可执行文件所在目录上下级找 texmf.cnf、遍寻不获后回落到编译期前缀，
            // 最终 `I can't find the format file 'pdftex.fmt'!`。
            "TEXMFCNF=${texmfCnfPath(root)}",
            // TeX Live 的树根（缺陷 AY）。没有它，`$TEXMFDIST` 等一律被解析成
            // `<root>/extensions/texlive/...`（可执行文件的祖父目录）—— 一个
            // 语法正确但不存在的路径，于是 kpsewhich 什么都找不到，而报错文案
            // 看起来像「宏包没打包」。真机三处症状全由它派生：texlinks 报
            // `fmtutil.cnf not found`、fmtutil 报 `inifile not found`、
            // tlmgr 报 `Can't locate TeXLive/TLConfig.pm`。
            "TEXMFROOT=${texmfRoot(root)}",
            // TeX Live 的用户树（缺陷 AY 的收尾）。指到固定目录有两个作用：
            //   ① 设备上第一次用 pdflatex 时，格式文件（.fmt）就装在这里 —— 它
            //      不带 `!!` 前缀，kpathsea 会扫目录，因此**不需要 ls-R 索引**；
            //   ② 格式由 [RuntimeInstaller.ensureTexFormats] 在安装期生成，
            //      不依赖设备上的 mktexfmt（那个走 perl 的 system("sh …")，
            //      在 Android 上必然失败 —— 见缺陷 AY 的第五处）。
            "TEXMFVAR=${texmfVar(ctx).absolutePath}",
            // gdb 的 Guile 扩展（问题.txt【5】）。
            //
            // 真机症状：`gdb --version` 直接 SIGABRT（退出码 134），栈是
            // `ext_lang_initialization` → `scm_i_init_guile` → `scm_load_startup_files`
            // → `scm_misc_error` → `abort`。根因是 libguile 编译期把 Scheme 源的
            // 搜索前缀写死成 Termux 的 `/data/data/com.termux/files/usr/share/guile`，
            // 而真实源码在扩展目录里；启动时读不到 `ice-9/boot-9.scm` 就抛错。
            //
            // 路径取 `<root>/share/guile/3.0`：extinstall 的合并视图已经把各扩展的
            // `share/` 递归合并进引擎根，所以 gdb 装好后这里就是它的源码树 —— 与
            // FONTCONFIG_PATH / TESSDATA_PREFIX 走的是同一条路。扩展目录作为兜底，
            // 覆盖「刚装好但合并视图还没建立」的窗口。
            "GUILE_LOAD_PATH=${guileLoadPath(root)}",
            // Guile 的预编译字节码路径（缺陷 BC）。这一条才是 gdb 启动慢的解药：
            // 只设它可以 151 s → 亚秒级，只设下面的 AUTO_COMPILE=0 则**毫无作用**
            // （13–14 s 与不设持平）。真机 A/B 与推导详见 [guileCompiledPath]。
            "GUILE_LOAD_COMPILED_PATH=${guileCompiledPath(root)}",
            // 关掉自动编译。
            //
            // ⚠️ 这条的旧结论「AUTO_COMPILE=0 是纯粹收益（225 s vs 1837 s）」已被
            // 推翻，见缺陷 BC：那两组测量**都没设 GUILE_LOAD_COMPILED_PATH**，
            // guile 每次都在现场编译 `system/repl/*.scm`，落不落盘只是「下次重编」
            // 的差别，量级都在百秒级。真正起作用的是上面那条编译路径。
            //
            // 保留 =0 的理由变成了「防御」：万一某个扩展的 ccache 缺 `.go`（或用户
            // 动了 share/ 里的 .scm 让缓存过期），自动编译会试图把产物写回
            // **只读的合并视图**、失败后每次启动重试一遍；而静态编译产物命中的
            // 路径下它本来就不该被触发。真机实测两条都设 → 0 s，与只设编译路径持平，
            // 所以保留它没有代价。
            //
            // ⚠️ 曾经的测量陷阱：早期探针写成 `gdb --version | head -1`，head
            // 读完一行就关管道、gdb 收 SIGPIPE 提前退出，自动编译循环被中断，
            // 于是「缓存目录一个 .go 都没有」被误读成「自动编译不落盘」。
            // 判断这类代价必须重定向到文件，**绝不接管道**。
            "GUILE_AUTO_COMPILE=0",
            // Emacs 的四个数据路径（问题修复.txt 里最后一项，缺陷 BA）。
            //
            // 真机症状：`emacs --version` 能出版本号，但每次都先刷三条警告 ——
            //   Warning: arch-dependent data dir '/data/data/com.termux/files/usr/libexec/emacs/31.1/aarch64-linux-android/': No such file or directory
            //   Warning: arch-independent data dir '/data/data/com.termux/files/usr/share/emacs/31.1/etc/': No such file or directory
            //   Warning: Lisp directory '/data/data/com.termux/files/usr/share/emacs/31.1/lisp': No such file or directory
            // 而 `--batch` 更直接死掉：`Error: file-missing ("Loading charset map" …
            // "8859-2")` + `Emacs will not function correctly without the character
            // map files.` —— 因为 charsets 目录里的 `.map` 被 `PRUNE_EXT` 误裁了
            // （见 tools/lib/stage.mjs，那一半是构建期修的；这里修的是路径）。
            //
            // 根因：这三个路径是 Emacs 编译期写进 C 字符串的 `$prefix` 派生值，
            // 和 JVM 的 `user.home`、perl 的 `@INC` 完全同型 —— 文件回填改不掉。
            // 只能靠环境变量在其**前面**插入真实路径。四个变量各有分工：
            //   EMACSDATA     → etc/（charsets/、DOC、HELLO…）
            //   EMACSLOADPATH → lisp/ + site-lisp/ + lisp/leim（输入法）
            //   EMACSPATH     → libexec/emacs/<版本>/<arch>/（hexl、movemail、rcs2log）
            //   EMACSDOC      → etc/（`C-h F` 查 docstring 用）
            // 路径取 `<root>/share/emacs/<版本>`：extinstall 的合并视图已把
            // emacs 扩展的 `share/` 摊到引擎根，与 GUILE_LOAD_PATH 同路。
            //
            // 版本号（当前 31.1）随包升级而变，所以扫目录而不是写死 —— 与
            // [guileLoadPath]、[perlIncDirs] 的做法一致。
            "EMACSDATA=${emacsDataDir(root)}",
            "EMACSLOADPATH=${emacsLoadPath(root, ctx)}",
            "EMACSPATH=${emacsLibExecDir(root)}",
            "EMACSDOC=${emacsDataDir(root)}",
            // 合并视图把扩展的 share/ 与 etc/ 摊到了引擎根，凡是按 XDG 找资源的
            // 工具（fontconfig、gdk-pixbuf、shared-mime-info、GLib schema）都能
            // 因此命中 —— 这些包在 Termux 下本来就靠 `$PREFIX/share` 生效。
            "XDG_DATA_DIRS=${File(root, "share").absolutePath}:/usr/share",
            "XDG_CONFIG_DIRS=${File(root, "etc/xdg").absolutePath}:/etc/xdg",
            // ImageMagick 的配置文件目录（问题.txt【6】第三层）。
            //
            // 合并视图已经把 `<ext>/etc/ImageMagick-7` 软链到 `<root>/etc/ImageMagick-7`，
            // 但 magick 找这个目录**不看 $PREFIX**：它只按内置的 Termux 前缀与
            // `$MAGICK_CONFIGURE_PATH` 找，找不到就 `UnableToOpenConfigureFile colors.xml`
            // 一路告警（真机实测：软链在位、`etc/ImageMagick-7/colors.xml` 读得到，
            // 不加这个变量仍然告警；加上就干净）。真机 8x8 出图 A/B 通过。
            "MAGICK_CONFIGURE_PATH=${File(root, "etc/ImageMagick-7").absolutePath}",
            // Ghostscript 的初始化文件目录（问题.txt【6】第二层，**同一个坑的另一半**）。
            //
            // `gs -h` 报的 search path 第一位就是编译期写死的
            // `/data/data/com.termux/files/usr/share/ghostscript/Resource/Init`；
            // 合并视图把真身摊到 `<root>/share/ghostscript/Resource/Init`（gs_init.ps
            // 在那儿，实测存在），但它不在 gs 的任何搜索路径上 ⇒ 启动即
            // `Can't find initialization file gs_init.ps`，退出码却仍是 0
            // （**静默失败**，只出一份空 PDF）。加上 GS_LIB 后 pdfwrite 出真 PDF 2433 B。
            "GS_LIB=${File(root, "share/ghostscript/Resource/Init").absolutePath}:" +
                "${File(root, "share/ghostscript/lib").absolutePath}:" +
                "${File(root, "share/ghostscript/Resource/Font").absolutePath}",
            // Termux 编译期 gitconfig 指向不存在的 Termux 前缀
            "GIT_CONFIG_NOSYSTEM=1",
            // 包管理器镜像（corepack/npm/pnpm 在 runtime 内无 .npmrc）
            "COREPACK_NPM_REGISTRY=https://registry.npmmirror.com",
            "npm_config_registry=https://registry.npmmirror.com",
            "NPM_CONFIG_REGISTRY=https://registry.npmmirror.com",
            // Go 的临时目录（go build 往这里写中间产物）。GOTMPDIR 只解决 tmp，
            // 真正的 GOROOT 在下面按目录探测后追加（缺陷 BI）。
            "GOTMPDIR=${tmp.absolutePath}",
            // Python 的字节码缓存（缺陷 BK，gdb 启动慢的第二条腿）。
            //
            // gdb 的 `share/gdb/python/gdb/**` 有 53 个 `.py`、**一个 `.pyc` 都没有**，
            // 而合并视图是只读软链 ⇒ 每次启动 gdb 的 Python 初始化都要把这一批
            // 重新编译一遍，写不进 `__pycache__` 又重试，`gdb --version` 因此能挂
            // 到分钟级。用 `PYTHONPYCACHEPREFIX` 把字节码重定向到 tmp 下的独立
            // 前缀：首次生成、之后直接命中，且永远不往只读视图里戳。
            //
            // 刻意**不**设 `PYTHONDONTWRITEBYTECODE=1` —— 那只是「不写」，
            // 于是每次启动都要重新编译全部 53 个文件，等于把慢速固化下来。
            "PYTHONPYCACHEPREFIX=${File(tmp, "pycache").absolutePath}",
            // Ruby 的 gem 装到用户目录（Termux 前缀只读/不存在）
            "GEM_HOME=${File(home, ".gem").absolutePath}",
            "GEM_PATH=${File(home, ".gem").absolutePath}",
            // kxxy-host 插件靠这两个变量定位宿主资源：KXXY_ENGINE_ROOT 用于
            // collectRuntimeState 的七项探针（有 PREFIX 兜底，但显式给出更稳），
            // KXXY_STATE_FILE 用于 collectEngineState 读取原生层写入的
            // pid / 内存 / 运行时长（**无兜底，缺了就是 null**）。
            "KXXY_ENGINE_ROOT=${root.absolutePath}",
            "KXXY_STATE_FILE=${File(root, STATE_FILE_NAME).absolutePath}",
        )

        // JAVA_HOME：kotlinc 与 gradle 都优先读它，比 PATH 更硬。
        if (javaHome != null) env += "JAVA_HOME=${javaHome.absolutePath}"

        // GOROOT / GOPATH / GOCACHE（缺陷 BI）。
        //
        // 为什么必须显式给：扩展的 `<root>/bin/go` 是 poolextract 物化出来的
        // **真实 ELF 副本**（16 MB，不是软链），而 go 的默认 GOROOT 推导是
        // 「取自身路径上溯两级」⇒ 得到 `<root>` 而不是 `<root>/lib/go`，
        // 于是每个子命令都 `cannot find GOROOT directory`。go 二进制里也**没有**
        // 编入 Termux 的 `lib/go` 路径（实测 strings 零命中），所以不存在
        // 「装好就自动对」的可能。
        //
        // GOPATH/GOCACHE 指向 HOME 下：不设时它们默认 `$HOME/go` 与
        // `$HOME/.cache/go-build`，HOME 已经指到 kxxy-home，本来也能用；
        // 但显式写出来可以避免 `go env -w` 写进只读的 `lib/go/go.env`。
        // GOTOOLCHAIN=local 很关键：go 1.21+ 默认 `auto`，一旦 go.mod 里
        // 要求更高版本，go 会**试图联网下载新工具链**（在手机上下几百 MB，
        // 且 Termux 的 go 不带 toolchain 模块），本地锁死更符合预期。
        val goRoot = goRoot(root)
        if (goRoot != null) {
            env += "GOROOT=${goRoot.absolutePath}"
            env += "GOPATH=${File(home, "go").absolutePath}"
            env += "GOCACHE=${File(home, ".cache/go-build").absolutePath}"
            env += "GOTOOLCHAIN=local"
        }

        // PHP 的 ini 与扩展目录（缺陷 BL）。
        //
        // Termux 的 php 编译期把 `--with-config-file-path` 钉在
        // `/data/data/com.termux/files/usr/etc/php`，那个目录在设备上不存在 ⇒
        // 启动刷 `PHP Warning:  PHP Startup: Unable to load dynamic library`，
        // 且 `php.ini` 完全不生效。`PHPRC` 指向引擎根下合并视图的 `etc/php`。
        val phpEtc = File(root, "etc/php")
        if (phpEtc.isDirectory) env += "PHPRC=${phpEtc.absolutePath}"
        // Maven 的本地仓库落在 HOME 下，避免往只读的引擎根写
        env += "MAVEN_OPTS=-Dmaven.repo.local=${File(home, ".m2/repository").absolutePath}"

        // Erlang 的根目录（缺陷 BO）。
        //
        // `bin/erl`（扩展池里的顶层入口，`#!/system/bin/sh`）用
        // `ROOTDIR=$(find_rootdir "$0" "@DSH_ROOT@/lib/erlang")`：从 $0 逐级上溯，
        // 找「含 `erts-*/` 的目录」，找不到就**回落到第二个参数**。从
        // `<root>/bin/erl` 上溯只会经过 `<root>` 与 `/`，两者都没有 `erts-*`，
        // 所以实际永远走回落分支 —— 而回落值来自安装期回填的占位符，引擎根
        // 一旦迁移（备份还原、换 filesDir）就失效。
        //
        // `ERL_ROOTDIR` 是 erl 脚本自己认的官方覆盖点（脚本里
        // `if [ -z "$ERL_ROOTDIR" ]; then ROOTDIR=$(find_rootdir ...)`），
        // 显式给死最稳，也不依赖安装顺序。判据用 `erts-*` 目录而不是
        // `isDirectory`：池解包到一半时 `lib/erlang` 可能已存在但没有 erts。
        val erlRoot = listOf(
            File(root, "lib/erlang"),
            File(root, "extensions/erlang/lib/erlang"),
        ).firstOrNull { dir ->
            dir.isDirectory && dir.listFiles()?.any { it.name.startsWith("erts-") } == true
        }
        if (erlRoot != null) env += "ERL_ROOTDIR=${erlRoot.absolutePath}"

        // JVM 的 user.home / java.io.tmpdir 是**编译期写死的 C 字符串**
        // （`/data/data/com.termux/files/home` 与 `.../usr/tmp/`），跟 perl 的 @INC
        // 同一类残留，改文件改不掉、只能从环境变量盖（问题.txt【1】的 Java 侧）。
        // 真机取证：`java -XshowSettings:properties` 报 `user.home=/data/data/com.termux/files/home`、
        // `java.io.tmpdir=/data/data/com.termux/files/usr/tmp/`，两个目录都不存在。
        //
        // 后果链（问题.txt【3】【4】的第二层）：
        //   · Gradle 的 native-platform 在 `$user.home/.gradle` 下建临时探针文件，
        //     父目录不存在 ⇒ `IOException: No such file or directory` ⇒
        //     `Failed to load native library 'libnative-platform.so' for Linux aarch64`
        //     ⇒ `Could not initialize native services`，**连 `gradle --version` 都不出**；
        //   · jansi（kotlinc 的终端着色库）往 `java.io.tmpdir` 解 .so，报
        //     `.../com.termux/files/usr/tmp/jansi-*.so.lck (No such file or directory)`。
        //
        // A/B 真机实测（同一个 java、同一个 gradle 9.8.1）：
        //   基线（现状）                        → rc=1  Could not initialize native services
        //   只加 java.io.tmpdir                 → rc=1  Could not initialize native services
        //   只加 GRADLE_USER_HOME               → rc=1  createVirtualFileSystem 失败
        //   **两个都加**                        → rc=0  真的编出 A.class
        //   不设 GRADLE_USER_HOME、只靠 -Duser.home → 也能过（两者等价，任选其一）
        // 所以这里两个都给：GRADLE_USER_HOME 显式钉死缓存根，JAVA_TOOL_OPTIONS 覆盖
        // 任意 JVM 进程（kotlinc / d8 / apksigner 也一并受益）。用空格拼成一条值而不是
        // 两条导出，是因为 JAVA_TOOL_OPTIONS 本身就是「由 JVM 自行按空格拆分」的变量。
        val jvmOpts = buildList {
            add("-Djava.io.tmpdir=${tmp.absolutePath}")
            add("-Duser.home=${home.absolutePath}")
            // jansi 的 native 库在 bionic 上必然 dlopen 失败（缺陷 BM）。
            //
            // 字节码级取证（jansi 2.4.0，打进 kotlin-compiler.jar 与 gradle 里）：
            //   · `Linux/arm64/libjansi.so` 的 DT_NEEDED 只有 `libc.so.6`，
            //     而 Android 是 bionic，只有 `libc.so` ⇒ `System.load` 必抛
            //     `UnsatisfiedLinkError: dlopen failed: "libc.so.6" not found`；
            //   · `JansiLoader.loadNativeLibrary` 只 catch `UnsatisfiedLinkError`，
            //     然后**把异常对象 println 到 stderr**（字节码 :89-93），
            //     所以真机日志里那两行 "Failed to load native library…" 后面
            //     紧跟的 ULE 只是**噪音**，不是崩溃；
            //   · `initialize()` 在 graceful（默认 true）下静默返回 false，
            //     `AnsiConsole.ansiStream` 的异常表也把 `Throwable` 兜住了。
            // 即便如此，噪音会让人误判成「工具链崩了」，而且每次 JVM 启动都刷。
            // `jansi.mode=strip` 让 AnsiConsole 直接走「不输出 ANSI」的分支，
            // 配合构建期剥掉 jar 内 native 资源（见 tools/lib/poolextract.py）
            // 之后，jansi 这条路径彻底安静。
            add("-Djansi.mode=strip")
            add("-Djansi.graceful=true")
        }.joinToString(" ")
        env += "JAVA_TOOL_OPTIONS=$jvmOpts"
        env += "GRADLE_USER_HOME=${File(home, ".gradle").absolutePath}"

        // Termux 编译的 node 把 OpenSSL 目录硬编码为 /data/data/com.termux/...，
        // 设备共存真实 Termux 时会命中 EACCES 导致 node 启动即退，必须显式指回自带目录。
        val cert = File(tlsDir(ctx), "cert.pem")
        if (cert.isFile) env += "SSL_CERT_FILE=${cert.absolutePath}"
        val opensslConf = File(tlsDir(ctx), "openssl.cnf")
        if (opensslConf.isFile) env += "OPENSSL_CONF=${opensslConf.absolutePath}"

        return env.toTypedArray()
    }

    /**
     * Android 适配覆盖层内容（启动时由 --patch 注入）。
     *
     * 三条硬约束（每条都是上游行为决定，不是可选项）：
     *   1. patch **整体替换**目标行整个 config（applyEntryPatches 做 target[key] = value），
     *      所以每行必须重述它拥有的全部 key；
     *   2. sandbox-policy / approval / permission 三件套必须同时钉死，
     *      否则 permission-presets 抛 "composed sandbox and approval defaults match no preset"；
     *   3. permission 必须给全 presets 表 —— 插件 schema 默认只带
     *      workspace-write + danger-full-access，丢 read-only 会少一个预设。
     *
     * `office-to-pdf` 那一行同样受约束 1 支配：它原本在上游
     * `@deepseek-ai/dsh-web-app/cordis.patch.yml` 里没有 config，这里补上
     * `fontDirectories`。不给它就只能靠 `systemFontDirectories()`，而那条路在
     * Android 上返回的是 XDG 目录（`/usr/share/fonts` 之类），一个都不存在。
     */
    fun overlayContent(ctx: Context): String = """
        # [dsh-kxxy] Android compatibility overlay (auto-generated, do not edit)
        - id: sandbox-policy
          config:
            mode: danger-full-access
            workspaceRoot: !!js process.cwd()
        - id: approval
          config:
            policy: never
        - id: permission
          config:
            defaultPreset: danger-full-access
            presets:
              read-only:
                sandbox: read-only
                approval: ask
                name: read-only
                description: Deny every file modification.
              workspace-write:
                sandbox: workspace-write
                approval: ask
                name: workspace-write
                description: Write only inside the session workspace.
              danger-full-access:
                sandbox: danger-full-access
                approval: never
                name: danger-full-access
                description: No sandbox boundary.
        - id: office-to-pdf
          config:
            fontDirectories:
              - ${officeFontsDir(ctx).absolutePath}
        - insert:
            - id: kxxy-host
              name: kxxy-host
    """.trimIndent() + "\n"

    /** 确保覆盖层文件存在且内容最新（幂等，内容比对后才写）。 */
    fun ensureOverlay(ctx: Context) {
        val f = overlayFile(ctx)
        val text = overlayContent(ctx)
        if (!f.isFile || f.readText() != text) {
            f.parentFile?.mkdirs()
            f.writeText(text)
        }
    }

    /** `$HOME/.bashrc`（用户 shell 初始化，非 runtime 资产，升级不触碰）。 */
    fun userShellInitFile(ctx: Context): File = File(dshHome(ctx), ".bashrc")

    /** 官方 profile 目录（`$HOME/profiles/<name>/`；本宿主只用 `web`）。 */
    fun profileDir(ctx: Context): File = File(dshHome(ctx), "profiles/web")

    /** profile 的 `package.json`：官方插件页「已安装」列表的唯一数据源。 */
    fun profileManifestFile(ctx: Context): File = File(profileDir(ctx), "package.json")

    /**
     * 把内置的移动端插件登记进 profile manifest，使其出现在官方插件页。
     *
     * 为什么必须写这个文件：官方「插件」页（`dsh-client-ui-plugin-manager`）的
     * 「已安装」分组只认 `pluginManager.listBundles()` 的返回，而那个方法把
     * `installed` 判成 **`.dependencies` 里有这个名字**、把 `enabled` 判成
     * **`dsh.profile.bundles` 里有这个名字**。只往 overlay 里 `insert` 一个
     * Loader entry 是不够的 —— 那样插件能跑，但页面上完全不显示，用户会以为
     * 没装上。只有写进 profile，插件页才会给出「已安装」卡片与启停开关。
     *
     * 为什么不能交给上游：`dsh-app-boot` 的 `initProfile` 只在文件**不存在**时
     * 写模板，设备上 profile 早已存在，永远不会被改写，所以只能由宿主补写。
     *
     * 覆盖规则：**读-改-写，只做「确保存在」**。用户通过插件页自行安装的插件
     * 会写进同一个 `.dependencies`，绝不能整体覆盖 —— 那会把用户装的插件抹掉。
     *
     * 幂等：序列化结果与原文本一致时不写盘。
     */
    fun ensureProfileManifest(ctx: Context) {
        runCatching {
            val f = profileManifestFile(ctx)
            val original = if (f.isFile) f.readText().replace("\uFEFF", "") else null
            val json = if (original.isNullOrBlank()) {
                org.json.JSONObject()
                    .put("name", "dsh-profile-web")
                    .put("private", true)
                    .put("dependencies", org.json.JSONObject())
                    .put(
                        "dsh",
                        org.json.JSONObject().put(
                            "profile",
                            org.json.JSONObject().put(
                                "bundles",
                                org.json.JSONArray()
                                    .put("@deepseek-ai/dsh-base")
                                    .put("@deepseek-ai/dsh-web-app"),
                            ),
                        ),
                    )
            } else {
                org.json.JSONObject(original)
            }

            val dependencies = json.optJSONObject("dependencies") ?: org.json.JSONObject()
            if (!dependencies.has(MOBILE_PLUGIN_NAME)) {
                dependencies.put(MOBILE_PLUGIN_NAME, MOBILE_PLUGIN_VERSION)
            }
            json.put("dependencies", dependencies)

            val dsh = json.optJSONObject("dsh") ?: org.json.JSONObject()
            val profile = dsh.optJSONObject("profile") ?: org.json.JSONObject()
            val bundles = profile.optJSONArray("bundles") ?: org.json.JSONArray()
            var present = false
            for (i in 0 until bundles.length()) {
                if (bundles.optString(i) == MOBILE_PLUGIN_NAME) present = true
            }
            if (!present) bundles.put(MOBILE_PLUGIN_NAME)
            profile.put("bundles", bundles)
            dsh.put("profile", profile)
            json.put("dsh", dsh)

            val text = json.toString(2) + "\n"
            if (text == original) return
            f.parentFile?.mkdirs()
            f.writeText(text)
        }
    }

    /**
     * 给官方终端补上「显示当前目录」的默认提示符。
     *
     * 上游官方终端走 `dsh-api-terminal-controller` → `dsh-subprocess-local`：
     * `spawnTerminal` 只传 `env = { DSH_SESSION_ID }`，随后
     * `prepareShellActivity` 生成一个临时 rcfile，并以
     * `bash --rcfile <临时文件> -i` 启动。那个临时 rcfile 的**第一行**是
     *
     *     [[ ! -r ~/.bashrc ]] || builtin source ~/.bashrc
     *
     * —— 这正是上游留给用户自定义提示符的**正式挂点**。但 `$HOME` 下原本
     * 没有 `.bashrc`，于是 bash 回落到内置默认提示符 `\s-\v\$`；真机症状是
     * 终端只显示 `bash-5.3$`，完全看不出自己在哪个目录。
     *
     * 覆盖规则：**只在文件不存在、或首行仍带本项目标记时写入**。用户自己
     * 改过（首行不再是 `# kxxy-shell@`）就绝不再覆盖 —— 这是用户资产。
     *
     * 幂等：内容一致时不写盘。标记版本递增后会自动重写一次。
     */
    fun ensureUserShellInit(ctx: Context) {
        val f = userShellInitFile(ctx)
        val text = userShellInitContent()
        if (f.isFile) {
            val firstLine = runCatching {
                f.bufferedReader().use { it.readLine() }
            }.getOrNull()
            if (firstLine == null || !firstLine.startsWith(USER_SHELL_INIT_TAG)) return
            if (f.readText() == text) return
        }
        runCatching {
            f.parentFile?.mkdirs()
            f.writeText(text)
        }
    }

    /**
     * 默认 `~/.bashrc` 内容。
     *
     * `\w` 会把 `$HOME` 缩写成 `~`，于是会话工作区显示为
     * `~/workspaces/<name>`，与桌面系统的观感一致；不用颜色，是为了在浅色与
     * 深色两套终端主题下都保持可读。
     *
     * `# kxxy-shell@2` 追加了一段 Guile 编译缓存的**运行期自愈**（缺陷 BC/BH 的
     * 同型问题）。`GUILE_LOAD_COMPILED_PATH` 是引擎进程启动时由 [buildEnv]
     * 算好的，一旦那一刻 `lib/guile/3.0/ccache` 这个合并视图还不存在（runtime
     * 刚重装、`relinkAll` 尚未跑），变量就固化成一条坏路径，之后终端里跑
     * `gdb` 会退回「现场编译 `system/repl` 下的 .scm」，真机实测 **160 秒**。
     * 扩展树里那份 ccache 是持久资产（`runtime` 重装从不碰 `extensions/`），
     * 所以在这里补一道判断即可。
     */
    private fun userShellInitContent(): String = """
        # kxxy-shell@2
        # [dsh-kxxy] 官方终端在 Android 上的默认交互式 shell 初始化。
        #
        # 上游以 `bash --rcfile <临时文件> -i` 启动终端，那个临时 rcfile 的第一行是
        #     [[ ! -r ~/.bashrc ]] || builtin source ~/.bashrc
        # 而 ${'$'}HOME 下原本没有 .bashrc，bash 于是回落到内置默认提示符 `\s-\v\${'$'}`，
        # 终端里只显示 `bash-5.3${'$'}`，看不出当前目录。本文件补上这一环。
        #
        # 可以随意修改；一旦首行不再是我们写的标记，宿主就不再覆盖它
        # （见 EngineConfig.ensureUserShellInit）。
        PS1='\w\${'$'} '

        # ── Guile 编译缓存自愈（缺陷 BC）────────────────────────────────────
        # gdb 启动慢 150 秒的唯一原因是 guile 找不到预编译的 .go，只能现场编译
        # `system/repl` 下的 .scm。引擎进程的 GUILE_LOAD_COMPILED_PATH 在启动时
        # 就算好，若那一刻合并视图还不存在就会固化坏值；这里按目录真实存在与否
        # 重新挑一次，优先合并视图、回落扩展树。
        if [ ! -d "${'$'}{GUILE_LOAD_COMPILED_PATH:-/nonexistent}" ]; then
            for _gc in "${'$'}KXXY_ENGINE_ROOT/lib/guile/3.0/ccache" \
                       "${'$'}KXXY_ENGINE_ROOT/extensions/gdb/lib/guile/3.0/ccache"; do
                if [ -d "${'$'}_gc" ]; then
                    export GUILE_LOAD_COMPILED_PATH="${'$'}_gc"
                    break
                fi
            done
            unset _gc
        fi
        if [ ! -d "${'$'}{GUILE_LOAD_PATH:-/nonexistent}" ]; then
            for _gl in "${'$'}KXXY_ENGINE_ROOT/share/guile/3.0" \
                       "${'$'}KXXY_ENGINE_ROOT/extensions/gdb/share/guile/3.0"; do
                if [ -d "${'$'}_gl" ]; then
                    export GUILE_LOAD_PATH="${'$'}_gl"
                    break
                fi
            done
            unset _gl
        fi
    """.trimIndent() + "\n"

    /** 首行标记前缀，用于识别「这个 .bashrc 是我们写的」，避免覆盖用户自定义。 */
    private const val USER_SHELL_INIT_TAG = "# kxxy-shell@"

    /**
     * 内置移动端插件的包名与声明版本（见 build-runtime.mjs 的 MOBILE_PLUGIN_PKG）。
     *
     * 版本只用于写进 profile 的 `dependencies` —— 真实代码来自 runtime.zip 里那份
     * 已解包的 `lib/node_modules/dsh-web-mobile`，不依赖 profile 目录做任何安装。
     */
    private const val MOBILE_PLUGIN_NAME = "dsh-web-mobile"
    private const val MOBILE_PLUGIN_VERSION = "3.1.0"
}
