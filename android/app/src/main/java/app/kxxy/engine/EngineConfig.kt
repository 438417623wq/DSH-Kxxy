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

    /** 证书目录。 */
    fun tlsDir(ctx: Context): File = File(engineRoot(ctx), "etc/tls")

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

        val path = listOf(
            File(root, "bin").absolutePath,
            File(root, "usr/bin").absolutePath,
            "/system/bin",
            "/system/xbin",
        ).joinToString(":")

        val ldPath = listOf(
            File(root, "lib").absolutePath,
            File(root, "usr/lib").absolutePath,
        ).joinToString(":")

        val env = mutableListOf(
            "PATH=$path",
            "LD_LIBRARY_PATH=$ldPath",
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
            // Termux 编译期 gitconfig 指向不存在的 Termux 前缀
            "GIT_CONFIG_NOSYSTEM=1",
            // 包管理器镜像（corepack/npm/pnpm 在 runtime 内无 .npmrc）
            "COREPACK_NPM_REGISTRY=https://registry.npmmirror.com",
            "npm_config_registry=https://registry.npmmirror.com",
            "NPM_CONFIG_REGISTRY=https://registry.npmmirror.com",
            "GOTMPDIR=${tmp.absolutePath}",
            // kxxy-host 插件靠这两个变量定位宿主资源：KXXY_ENGINE_ROOT 用于
            // collectRuntimeState 的七项探针（有 PREFIX 兜底，但显式给出更稳），
            // KXXY_STATE_FILE 用于 collectEngineState 读取原生层写入的
            // pid / 内存 / 运行时长（**无兜底，缺了就是 null**）。
            "KXXY_ENGINE_ROOT=${root.absolutePath}",
            "KXXY_STATE_FILE=${File(root, STATE_FILE_NAME).absolutePath}",
        )

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
     */
    fun overlayContent(): String = """
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
        - insert:
            - id: kxxy-host
              name: kxxy-host
    """.trimIndent() + "\n"

    /** 确保覆盖层文件存在且内容最新（幂等，内容比对后才写）。 */
    fun ensureOverlay(ctx: Context) {
        val f = overlayFile(ctx)
        val text = overlayContent()
        if (!f.isFile || f.readText() != text) {
            f.parentFile?.mkdirs()
            f.writeText(text)
        }
    }
}
