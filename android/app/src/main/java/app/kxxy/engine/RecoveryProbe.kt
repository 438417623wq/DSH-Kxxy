package app.kxxy.engine

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 启动失败归因探针 —— 方案 K 的「先查清楚，再修」。
 *
 * ## 为什么需要它
 *
 * 引擎起不来时，宿主拿到的只有一个「连续 N 次启动失败」和一段滚动的
 * `engine.log`。让用户从那段日志里自己找出是哪一层配置坏了，等于把
 * 排障成本全部推给用户；而一个猜错的修复动作（例如把用户辛苦配的插件
 * 全禁掉）比不修更糟。
 *
 * 所以修复按钮背后必须是**确定的归因**，而不是「试试看」。
 *
 * ## 归因手段：官方 CLI 的两条 dump 路径
 *
 * `dsh-app-boot` 暴露了两个「不启动服务、只组装配置树」的诊断入口，它们
 * 恰好能把「层」切开：
 *
 * - `--dump-default-config` 只读 **bundle 层**，显式跳过用户层 patch 与
 *   `--patch`（见其文档：`userLayer: false`，所以「broken user layer」不会
 *   让它失败）。它成功 ⇒ 内置 bundle 与 profile manifest 都是好的。
 * - `--dump-config --patch <overlay>` 读 **全部层**：bundle → profile patch
 *   → home patch → overlays。它失败时的 stderr 一定点名了具体文件。
 *
 * 两者结合即可二分：`--dump-default-config` 挂 ⇒ 问题在 bundle/manifest；
 * 它过而 `--dump-config` 挂 ⇒ 问题在用户层或 overlay，且错误文本里带
 * 绝对路径，可以直接判定是哪一层。
 *
 * ## 为什么不用「一个个改名再试」
 *
 * 那种做法会**修改用户文件**。探针必须是只读的 —— 用户点「诊断」不该让
 * 任何文件发生变化，否则「看一眼」和「已经改了」就分不清了。
 *
 * ## 为什么必须带 `--patch` 而 `--dump-default-config` 不能带
 *
 * 官方 CLI 有互斥校验：`--dump-default-config` 与 `--patch` 同时出现会
 * 直接 `program.error(...)` 退出。带错了会得到一个「参数错误」的假故障，
 * 把归因引向完全错误的方向。
 */
class RecoveryProbe(private val ctx: Context) {

    /** 单条探针的判定结果。 */
    enum class Verdict {
        /** 命中：这条探针证明了自己是故障源。 */
        HIT,

        /** 未命中：这一层是好的。 */
        MISS,

        /** 无法判定：前置层已坏（例如 bundle 层就挂了，用户层没机会被读到）。 */
        UNKNOWN,
    }

    /** 一条探针。 */
    data class Check(
        /** 归因代号，与 UI 上的徽标一致。 */
        val code: String,
        val title: String,
        val verdict: Verdict,
        val detail: String,
    )

    /**
     * 归因结果。
     *
     * @param headline 一句话结论（UI 大字）
     * @param detail   具体到文件与错误行（UI 小字）
     * @param raw      原始错误文本，诊断页展示
     * @param recommended 建议的修复力度
     * @param checks   四条探针的完整结果
     */
    data class Diagnosis(
        val headline: String,
        val detail: String,
        val raw: String,
        val recommended: RecoveryManager.Level,
        val checks: List<Check>,
    ) {
        /** 给状态栏/通知用的一句话。 */
        fun summary(): String = if (detail.isBlank()) headline else "$headline：$detail"
    }

    /**
     * 跑一次完整归因。
     *
     * 全程只读：不写、不改名、不删除任何文件。
     */
    suspend fun diagnose(): Diagnosis = withContext(Dispatchers.IO) {
        val started = System.currentTimeMillis()
        val result = diagnoseInner()
        // 归因过程必须留痕：真机排障时 logcat 是唯一能拿到「探针看到了什么」的
        // 地方（UI 上只显示结论）。不带这行，用户报「点了修复没好」时无从判断
        // 是归因错了还是修复没生效。
        Log.i(
            TAG,
            "diagnose(${System.currentTimeMillis() - started}ms) → ${result.headline} | " +
                result.checks.joinToString(" ") { "${it.code}=${it.verdict}" } +
                " | ${result.detail.take(200)}",
        )
        result
    }

    private suspend fun diagnoseInner(): Diagnosis = withContext(Dispatchers.IO) {
        // ① 静态前置检查：manifest 与 overlay 是可以不启进程就判死的
        val manifestIssue = checkManifestJson()
        if (manifestIssue != null) {
            return@withContext Diagnosis(
                headline = "profile 清单损坏",
                detail = manifestIssue,
                raw = manifestIssue,
                recommended = RecoveryManager.Level.L1,
                checks = listOf(
                    Check("A", "profile patch 解析", Verdict.UNKNOWN, "未执行（前置层已坏）"),
                    Check("B", "bundle 挂载", Verdict.UNKNOWN, "未执行（前置层已坏）"),
                    Check("C", "运行时与环境", Verdict.MISS, "引擎可执行文件齐备"),
                    Check("D", "profile 清单", Verdict.HIT, manifestIssue),
                ),
            )
        }

        val runtimeIssue = checkRuntimeFiles()
        if (runtimeIssue != null) {
            return@withContext Diagnosis(
                headline = "运行时文件缺失",
                detail = runtimeIssue,
                raw = runtimeIssue,
                recommended = RecoveryManager.Level.L3,
                checks = listOf(
                    Check("A", "profile patch 解析", Verdict.UNKNOWN, "未执行（运行时已坏）"),
                    Check("B", "bundle 挂载", Verdict.UNKNOWN, "未执行（运行时已坏）"),
                    Check("C", "运行时与环境", Verdict.HIT, runtimeIssue),
                    Check("D", "profile 清单", Verdict.MISS, "JSON 可解析"),
                ),
            )
        }

        // ② 第一刀：只读 bundle 层
        val bundlesOnly = dump(defaultOnly = true)
        if (!bundlesOnly.ok) {
            val kind = classify(bundlesOnly.text)
            val headline = if (kind == Kind.MANIFEST) "profile 清单损坏" else "内置 bundle 挂载失败"
            return@withContext Diagnosis(
                headline = headline,
                detail = firstErrorLine(bundlesOnly.text),
                raw = bundlesOnly.text,
                recommended = RecoveryManager.Level.L2,
                checks = listOf(
                    Check("A", "profile patch 解析", Verdict.UNKNOWN, "未执行（bundle 层已坏）"),
                    Check("B", "bundle 挂载", Verdict.HIT, firstErrorLine(bundlesOnly.text)),
                    Check("C", "运行时与环境", Verdict.MISS, "引擎可执行文件齐备"),
                    Check("D", "profile 清单", if (kind == Kind.MANIFEST) Verdict.HIT else Verdict.MISS, "JSON 可解析"),
                ),
            )
        }

        // ③ 第二刀：全部层（用户 patch + overlays）
        val full = dump(defaultOnly = false)
        val homePatch = EngineConfig.homePatchFile(ctx)
        val profilePatch = EngineConfig.profilePatchFile(ctx)
        val overlay = EngineConfig.overlayFile(ctx)

        if (full.ok) {
            // 配置树能组装出来，却仍然起不来 —— 这类失败靠 dump 看不到，
            // 只能指向「原样重试」。此时最该做的是别动用户的东西。
            val extensionIssue = checkExtensions()
            if (extensionIssue != null) {
                return@withContext Diagnosis(
                    headline = "扩展加载失败",
                    detail = extensionIssue,
                    raw = extensionIssue,
                    recommended = RecoveryManager.Level.L2,
                    checks = listOf(
                        Check("A", "profile patch 解析", Verdict.MISS, "profile patch 可解析（或不存在）"),
                        Check("B", "bundle 挂载", Verdict.MISS, "内置 bundle 全部就位"),
                        Check("C", "运行时与环境", Verdict.MISS, "引擎可执行文件齐备"),
                        Check("D", "扩展目录", Verdict.HIT, extensionIssue),
                    ),
                )
            }
            return@withContext Diagnosis(
                headline = "配置可组装，引擎仍未能就绪",
                detail = firstErrorLine(full.text).ifBlank { "启动超时或运行时异常，见引擎日志" },
                raw = full.text,
                recommended = RecoveryManager.Level.L1,
                checks = listOf(
                    Check("A", "profile patch 解析", Verdict.MISS, "profile patch 可解析（或不存在）"),
                    Check("B", "bundle 挂载", Verdict.MISS, "内置 bundle 全部就位"),
                    Check("C", "运行时与环境", Verdict.MISS, "引擎可执行文件齐备"),
                    Check("D", "扩展目录", Verdict.MISS, "无扩展或扩展完好"),
                ),
            )
        }

        // ④ 全层失败：靠官方错误文本里点名的绝对路径定位
        val kind = classify(full.text)
        val evidence = firstErrorLine(full.text)
        val hittingPath = when (kind) {
            Kind.OVERLAY -> overlay
            Kind.HOME_PATCH -> homePatch
            Kind.PROFILE_PATCH -> profilePatch
            Kind.MANIFEST -> EngineConfig.profileManifestFile(ctx)
            else -> null
        }

        val headline = when (kind) {
            Kind.OVERLAY -> "Android 覆盖层异常"
            Kind.HOME_PATCH -> "\$HOME 级补丁损坏"
            Kind.PROFILE_PATCH -> "profile 补丁损坏"
            Kind.MANIFEST -> "profile 清单损坏"
            else -> "启动配置组装失败"
        }
        val detail = when {
            hittingPath != null -> "${hittingPath.name} · ${evidence}"
            else -> evidence
        }

        Diagnosis(
            headline = headline,
            detail = detail,
            raw = full.text,
            recommended = when (kind) {
                // overlay 由宿主自己生成，重新生成即可，不必动用户数据
                Kind.OVERLAY -> RecoveryManager.Level.L1
                else -> RecoveryManager.Level.L1
            },
            checks = listOf(
                Check(
                    "A", "profile patch 解析",
                    if (kind == Kind.PROFILE_PATCH) Verdict.HIT else Verdict.MISS,
                    if (kind == Kind.PROFILE_PATCH) evidence else "profile patch 可解析（或不存在）",
                ),
                Check(
                    "B", "bundle 挂载",
                    if (kind == Kind.MANIFEST) Verdict.HIT else Verdict.MISS,
                    if (kind == Kind.MANIFEST) evidence else "内置 bundle 全部就位",
                ),
                Check(
                    "C", "运行时与环境",
                    if (kind == Kind.OVERLAY) Verdict.HIT else Verdict.MISS,
                    if (kind == Kind.OVERLAY) evidence else "引擎可执行文件齐备",
                ),
                Check(
                    "D", "\$HOME 级补丁",
                    if (kind == Kind.HOME_PATCH) Verdict.HIT else Verdict.MISS,
                    if (kind == Kind.HOME_PATCH) evidence else "home 级 patch 可解析（或不存在）",
                ),
            ),
        )
    }

    // ── 内部 ────────────────────────────────────────────────────────────

    /** dump 命令的产物。 */
    private data class DumpResult(val ok: Boolean, val text: String)

    /** 官方错误文本的归类。 */
    private enum class Kind { OVERLAY, HOME_PATCH, PROFILE_PATCH, MANIFEST, OTHER }

    /**
     * 跑一次官方 dump。
     *
     * @param defaultOnly true → `--dump-default-config`（只 bundle 层，不能带
     *   `--patch`）；false → `--dump-config --patch <overlay>`（全部层）
     */
    private fun dump(defaultOnly: Boolean): DumpResult {
        val node = EngineConfig.nodeBin(ctx)
        val entry = EngineConfig.dshEntry(ctx)
        if (!node.isFile || !entry.isFile) {
            return DumpResult(false, "运行时缺失：${node.absolutePath} 或 ${entry.absolutePath} 不存在")
        }

        val argv = buildList {
            add(node.absolutePath)
            add("--expose-internals")
            add(entry.absolutePath)
            add("web")
            if (defaultOnly) {
                add("--dump-default-config")
            } else {
                add("--dump-config")
                // --patch 指向宿主自己生成的 overlay：诊断时必须带上它，
                // 否则「overlay 生成异常」这一整类故障会被漏掉。
                val overlay = EngineConfig.overlayFile(ctx)
                if (overlay.isFile) {
                    add("--patch")
                    add(overlay.absolutePath)
                }
            }
            // ⚠️ 这里**不能**加 `--no-open`。
            //
            // 官方 CLI 里两条 dump 走的是「无 app 参数」的早退分支，会在解析完
            // 自己的 flag 之后校验剩余参数必须为空：
            //
            //   error: config dumps take no app arguments, got "--no-open"
            //
            // 真机实测过：带上 `--no-open` 时**两条 dump 都以非零码退出**，于是
            // 每条探针都判定为「命中」，归因结果变成一个全红的假象 —— 比不诊断
            // 更误导人。dump 本身不启服务、不开浏览器，也就不需要 `--no-open`。
        }

        return runCatching {
            val pb = ProcessBuilder(argv)
            pb.directory(EngineConfig.workspaces(ctx).apply { mkdirs() })
            // 环境必须完整注入：node 是 Termux 编译的产物，缺 LD_LIBRARY_PATH
            // 时连自身都起不来，那样每条探针都会「失败」，归因就全是噪音。
            pb.environment().apply {
                clear()
                for (kv in EngineConfig.buildEnv(ctx, EngineConfig.DEFAULT_PORT, EngineConfig.readPrivMode(ctx))) {
                    val i = kv.indexOf('=')
                    if (i > 0) put(kv.substring(0, i), kv.substring(i + 1))
                }
            }
            pb.redirectErrorStream(true)
            val proc = pb.start()

            // 读与等待必须并行：dump 的输出可能超过管道缓冲（64 KB），
            // 先 waitFor 再读会死锁在「子进程写满缓冲阻塞」上。
            val text = proc.inputStream.bufferedReader().use { it.readText() }
            val finished = proc.waitFor(DUMP_TIMEOUT_SEC, TimeUnit.SECONDS)
            if (!finished) {
                proc.destroyForcibly()
                return@runCatching DumpResult(false, "诊断命令超时（${DUMP_TIMEOUT_SEC}s）")
            }
            DumpResult(proc.exitValue() == 0, text)
        }.getOrElse { e ->
            DumpResult(false, "无法执行诊断命令：${e.message}")
        }
    }

    /**
     * 从官方错误文本判定是哪一层。官方把它点名的文件写进了消息里。
     *
     * ## 真实错误文本（真机抓取，方案 K 的判据都以它为准）
     *
     * ```
     * Error: dsh: failed to parse overlay /data/user/0/app.kxxy/files/kxxy-home/
     *   profiles/web/cordis.patch.yml: YAMLException: unexpected end of the
     *   stream within a double quoted scalar (6:1)
     *     at parsePatchList (.../dsh-app-boot/lib/index.js:3998:9)
     *     at loadOverlayPatches (.../index.js:3968:9)
     *     at loadProfileDirectory (.../index.js:1042:73)
     * ```
     *
     * ⚠️ **最反直觉的一点**：profile 级补丁坏了，官方报的是
     * `failed to parse **overlay**`，而不是 `patches`。`parsePatchList` 的
     * `label` 参数被调用方传成了 `"overlay"`，所以「overlay」在这个文案里
     * 指代的是**任意一层 patch 列表**，不是那个 `android-overlay.yml`。
     *
     * 因此**绝不能**用「错误里出现 overlay 这个词」来判定 overlay 层故障 ——
     * 那会把最常见的「用户补丁写坏」误判成宿主自己的覆盖层出了问题，进而
     * 建议用户去做一次完全无关的修复。判定顺序必须是**先看路径再看文案**。
     */
    private fun classify(text: String): Kind {
        val homeDir = EngineConfig.dshHome(ctx).absolutePath
        val profileDir = EngineConfig.profileDir(ctx).absolutePath
        val overlayPath = EngineConfig.overlayFile(ctx).absolutePath

        // ① 路径优先：错误消息里点名了哪个文件，就是哪一层。
        //
        // 顺序上先判 profile 与 home 的补丁，因为它们的路径是 `$HOME/profiles/web/…`
        // 与 `$HOME/…`，而 overlay 的路径是 `$HOME/../engine/android-overlay.yml`；
        // 三者互不为前缀，所以谁先谁后不影响正确性，只是把最常见的放前面。
        val profilePatch = File(profileDir, "cordis.patch.yml").absolutePath
        val homePatch = File(homeDir, "cordis.patch.yml").absolutePath
        if (text.contains(profilePatch)) return Kind.PROFILE_PATCH
        if (text.contains(homePatch)) return Kind.HOME_PATCH
        if (text.contains(overlayPath)) return Kind.OVERLAY

        // ② manifest 相关：读不到 / 不是 JSON 对象
        if (text.contains("profile manifest")) return Kind.MANIFEST

        // ③ 文案兜底（路径缺失时才用）
        if (text.contains("failed to parse overlay") || text.contains("failed to read overlay")) {
            return Kind.OVERLAY
        }
        if (text.contains("failed to parse patches")) {
            // 没有路径信息时无法再细分，归到 profile 级（最常见）
            return Kind.PROFILE_PATCH
        }
        return Kind.OTHER
    }

    /**
     * 取第一行像错误的内容，供 UI 单行展示。
     *
     * ⚠️ 不能直接取输出第一行。node 抛未捕获异常时的输出形如：
     *
     * ```
     * file:///…/dsh-app-boot/lib/index.js:3998
     *         throw new Error(`${binName}: failed to parse …`);
     *               ^
     *
     * Error: dsh: failed to parse overlay …/cordis.patch.yml: YAMLException: …
     * ```
     *
     * 前三行是**源码定位**，真正的结论在 `Error:` 那一行。直接取首行会得到
     * 一个 `file:///…` 路径，用户看了完全不知道发生了什么。
     *
     * 另外 `Error:` 行本身常带 YAML 的坐标与后续几行上下文（`3 | name: …`、
     * `-----^`），单行展示时只保留到第一个换行为止就够，避免卡片被撑爆。
     */
    private fun firstErrorLine(text: String): String {
        val lines = text.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.toList()
        // ① 优先「Error:」/「error:」开头的行 —— 那是真正的结论
        lines.firstOrNull { it.startsWith("Error:") || it.startsWith("error:") }
            ?.let { return it.take(300) }
        // ② 退一步：任何包含 Error 关键字的行，排除堆栈
        lines.firstOrNull { it.contains("Error") && !it.startsWith("at ") }
            ?.let { return it.take(300) }
        // ③ 再退：首个非堆栈行（含 `file://` 定位行也不再往下退，因为那说明
        //    输出里没有任何 Error 字样，多半是超时或被杀）
        return lines.firstOrNull { !it.startsWith("at ") }?.take(300) ?: ""
    }

    /** manifest 能否解析成 JSON 对象；返回问题描述或 null。 */
    private fun checkManifestJson(): String? {
        val f = EngineConfig.profileManifestFile(ctx)
        if (!f.isFile) return "${f.name} 不存在"
        return runCatching {
            JSONObject(f.readText().replace("\uFEFF", ""))
            null
        }.getOrElse { e ->
            "${f.name} 不是合法 JSON：${e.message?.take(120) ?: e.javaClass.simpleName}"
        }
    }

    /** 引擎本体是否齐备；返回问题描述或 null。 */
    private fun checkRuntimeFiles(): String? {
        val node = EngineConfig.nodeBin(ctx)
        val entry = EngineConfig.dshEntry(ctx)
        if (!node.isFile) return "缺少 ${node.absolutePath}"
        if (!node.canExecute()) return "无执行权限：${node.absolutePath}"
        if (!entry.isFile) return "缺少入口 ${entry.absolutePath}"
        return null
    }

    /**
     * extensions 目录的体检。
     *
     * 这一层走的是 kxxy-host 插件的加载路径（不在 app-boot 的 profile 层叠里），
     * 所以 dump 查不出来，只能自己看。
     *
     * 判据是 `.links.json`（接入点清单），**不是 `package.json`**：
     * `engine/extensions/<id>/` 是 deb 包解出来的纯目录树（`bin/` `lib/`
     * `share/`），从来没有 `package.json`。首版按 npm 包的直觉去查它，
     * 得到的是一段永远走不到的代码（`!pkg.isFile` 直接 continue）——
     * 与 kxxy-host 侧 health.mjs 犯的是同一个错，两边一起改。
     */
    private fun checkExtensions(): String? {
        val root = EngineConfig.extensionsRoot(ctx)
        if (!root.isDirectory) return null
        val dirs = root.listFiles()?.filter { it.isDirectory } ?: return null
        for (dir in dirs) {
            val links = File(dir, ".links.json")
            // 没有清单文件不是错误：可能安装没跑完（自愈路径是重装），
            // 也可能是用户手工放进来的目录（根本不该管）。
            if (!links.isFile) continue
            val bad = runCatching {
                JSONObject(links.readText().replace("\uFEFF", ""))
            }.exceptionOrNull()
            if (bad != null) {
                return "${dir.name}/.links.json 解析失败：${bad.message?.take(120)}"
            }
        }
        return null
    }

    init {
        Log.d(TAG, "RecoveryProbe created")
    }

    companion object {
        private const val TAG = "KxxyRecovery"

        /**
         * 单次 dump 的超时。
         *
         * dump 不启动服务、不监听端口，只组装配置树；实测在真机上 2–4 秒。
         * 给 45 秒是因为首次运行时 node 可能需要预热 V8 缓存，而超时太短会把
         * 「慢」误判成「坏」—— 那就等于让探针自己制造假故障。
         */
        private const val DUMP_TIMEOUT_SEC = 45L
    }
}
