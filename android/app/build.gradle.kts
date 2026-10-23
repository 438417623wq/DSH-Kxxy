// DSH Kxxy — app 模块构建脚本
// 方案 T：Web-First 宿主
//
// ⚠️ 关键决策：targetSdk = 28
// Android 10+ (API 29+) 禁止对 app home 目录内的文件调用 execve()（W^X 违规）：
//   "Untrusted apps that target Android 10 cannot invoke execve() directly on
//    files within the app's home directory."
// 本应用走 sideload 分发（不上架 Play），因此把 targetSdk 固定为 28，
// 从而豁免该限制，允许从 filesDir 直接 execve bionic 二进制（Termux 同款策略）。
// minSdk 26 覆盖参考项目取值；compileSdk 36 仅决定编译期 API 可见性。
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * 这两个 import 不能省。
 *
 * Kotlin DSL 脚本里 `java` 这个名字优先解析成 Gradle 的 JavaPluginExtension
 * （`project.java`），于是 `java.io.ByteArrayOutputStream()` 会报
 * `Unresolved reference: io`、`java.time.OffsetDateTime` 报 `Unresolved
 * reference: time` —— 报错位置和真正的原因（名字被 extension 遮住）差得很远，
 * 已经在这上面浪费过一轮。显式 import 之后，下面可以直接写短名字。
 */
import java.io.File
import java.time.OffsetDateTime
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit

// ══════════════════════════════════════════════════════════════════════════
// 版本号与构建元数据：git 是唯一事实源
// ══════════════════════════════════════════════════════════════════════════
//
// 背景（真事故）：这两行原来写死成 `versionCode = 1 / versionName = "0.1.0"`，
// 而仓库早已到 v0.9.2。后果不是「显示不对」这么轻 ——
//
//   · 覆盖安装判据失效：每次打出的包 versionCode 都是 1，`adb install -r`
//     在设备已有同号包时不认为是升级，只能先 `pm clear` 再装；用户侧则是
//     「装了新包，打开还是老界面」，因为 runtime 版本戳没变、锚点全过。
//   · 线上排障无从对齐：用户报「XX 坏了」，问是哪一版，答「不知道」，
//     因为关于页显示的是 DSH 前端版本，与 APK 完全无关。
//
// 现在改为从 git 推导，CI 可用环境变量强制覆盖（浅克隆 / 无 tag 的构建机）。

/**
 * 找 git 可执行文件。
 *
 * 为什么要自己找：`providers.exec { commandLine("git", …) }` 走的是 **Gradle
 * daemon 进程的 PATH**，而 daemon 往往是几天前启动的，PATH 里常常没有
 * `C:\Program Files\Git\cmd`。实测本机就是这样 —— 终端里 `git --version`
 * 一切正常，到了 gradle 里每条命令都返回空串，于是 versionName 变成
 * `0.9.0+nogit`、versionCode 掉回兜底的 1000：一个**看起来正常**的错误值，
 * 比直接报错难发现得多（这条是踩出来的，不是想出来的）。
 *
 * 顺序：环境变量 KXXY_GIT → 常见安装路径 → 裸名交给 PATH。
 */
fun findGit(): String {
    System.getenv("KXXY_GIT")?.takeIf { it.isNotBlank() && File(it).isFile }?.let { return it }
    val localAppData = System.getenv("LOCALAPPDATA").orEmpty()
    val candidates = buildList {
        add("C:\\Program Files\\Git\\cmd\\git.exe")
        add("C:\\Program Files (x86)\\Git\\cmd\\git.exe")
        if (localAppData.isNotEmpty()) add("$localAppData\\Programs\\Git\\cmd\\git.exe")
        add("/usr/bin/git")
    }
    return candidates.firstOrNull { File(it).isFile } ?: "git"
}

val gitExe = findGit()

/**
 * 仓库根目录（`android/` 的上一级）。
 *
 * 单独存成 File 而不是在 gitOut 里直接用 `rootProject`：后者会把 Project
 * 引用带进闭包，正是上一版 `providers.exec` 崩溃的原因。File 是纯值。
 * 注意 git 允许在子目录里工作（它会自己向上找 `.git`），所以这里给 `android/`
 * 也能跑通；给仓库根是为了让 `git status` 的路径过滤范围与提交范围一致。
 */
val repoRoot: File = rootProject.projectDir.parentFile ?: rootProject.projectDir

/**
 * 跑一条 git 命令取 stdout（失败返回空串，绝不让构建因 git 缺失而失败）。
 *
 * 为什么用 `providers.exec` 而不是 `Project.exec`：后者在配置阶段执行会在
 * Gradle 9 被移除，且不方便取输出。
 */
/**
 * 跑一条 git 命令取 stdout（失败返回空串，绝不让构建因 git 缺失而失败）。
 *
 * **为什么不用 `providers.exec`**：那是第一版写法，在配置阶段每次都抛
 * `Could not create provider for value source ProcessOutputValueSource` ——
 * 它要求 lambda 可序列化（value source 语义），而 `workingDir = rootProject.projectDir`
 * 把 Project 引用带进了闭包。报错信息离原因很远，且 runCatching 会把它吞成
 * 空串，最后表现为「版本号变成 0.0.0+nogit」这种看起来正常的错值。
 *
 * 这里直接起进程：同步、可控、30 秒硬超时。git 输出都很小（最大是
 * `log -n 200`，几十 KB），不必担心管道缓冲。
 */
fun gitOut(vararg args: String): String = try {
    val process = ProcessBuilder(listOf(gitExe, *args))
        .directory(repoRoot)
        .redirectErrorStream(true)
        .start()
    // 没有 stdin 要写，直接关掉；否则子进程可能等输入。
    process.outputStream.close()
    val text = process.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    if (!process.waitFor(30, TimeUnit.SECONDS)) {
        process.destroyForcibly()
        logger.warn("[kxxy] git ${args.joinToString(" ")} 超时 30s（git=$gitExe）")
        ""
    } else {
        text.trim()
    }
} catch (e: Exception) {
    // 不静默：git 取不到值会让 versionName 变成 0.0.0+nogit（一个「看起来正常」
    // 的错误值），必须能在 --warning-mode all 下看到原因。
    logger.warn("[kxxy] git ${args.joinToString(" ")} 失败：${e.message}（git=$gitExe）")
    ""
}

// v0.9.2-12-g3b24a6d-dirty  →  major=0 minor=9 patch=2 ahead=12 commit=g3b24a6d dirty=true
val gitDescribe = gitOut("describe", "--tags", "--long", "--dirty")
val gitCommit = gitOut("rev-list", "-1", "HEAD").take(7).ifEmpty { "nogit" }
val gitCommitCount = gitOut("rev-list", "--count", "HEAD").toIntOrNull() ?: 0
val gitDirty = gitOut("status", "--porcelain").isNotEmpty()

/*
 * ── 基线版本：优先 git tag，退回「提交信息里的 vX.Y.Z 前缀」─────────────
 *
 * 本仓库的真实情况：**一个 tag 都没有**（`git tag -l` 输出为空），版本号只
 * 活在提交信息里（`v0.9.2: 打包工具三件套…`）。所以只认 tag 的写法在这里
 * 永远走 fallback —— 这本身就是「版本号三套互不相干」的第三个证据：README
 * 写着 v0.9.2、APK 写着 0.1.0、而 git 里根本没有这个版本的名字。
 *
 * 所以加第二层：在最近 200 条提交里找第一条带 `vX.Y.Z` 前缀的提交当锚点，
 * ahead = 锚点到 HEAD 的提交数。于是：
 *   · 规范的仓库（有 tag）     → 走 tag，语义最准；
 *   · 只在提交信息写版本（本仓库）→ 得到 `0.9.2+0.caf7a90`；
 *   · 两者都没有              → 0.0.0，并在 printVersionInfo 里喊出来。
 *
 * **建议后续补 tag**：`git tag -a v0.9.2 -m ...`，此后第一层就能命中，
 * 提交信息写错也不会污染版本号。
 */
val describeRegex = Regex("""^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+)-g([0-9a-f]+))?(-dirty)?$""")
val subjectRegex = Regex("""^v?(\d+)\.(\d+)\.(\d+)""")

var baseMajor = 0
var baseMinor = 0
var basePatch = 0
var ahead = 0
var versionSource = "none"

describeRegex.find(gitDescribe)?.let { m ->
    baseMajor = m.groupValues[1].toIntOrNull() ?: 0
    baseMinor = m.groupValues[2].toIntOrNull() ?: 0
    basePatch = m.groupValues[3].toIntOrNull() ?: 0
    ahead = m.groupValues[4].toIntOrNull() ?: 0
    versionSource = "git-tag"
}

if (versionSource == "none") {
    val rows = gitOut("log", "-n", "200", "--pretty=%H%x09%s").lines().filter { it.isNotBlank() }
    for (row in rows) {
        val sha = row.substringBefore('\t').trim()
        val subject = row.substringAfter('\t', "").trim()
        val m = subjectRegex.find(subject) ?: continue
        baseMajor = m.groupValues[1].toIntOrNull() ?: 0
        baseMinor = m.groupValues[2].toIntOrNull() ?: 0
        basePatch = m.groupValues[3].toIntOrNull() ?: 0
        ahead = gitOut("rev-list", "--count", "$sha..HEAD").toIntOrNull() ?: 0
        versionSource = "commit-subject@${sha.take(7)}"
        break
    }
}

/**
 * versionCode 必须**严格单调递增**，否则 `adb install -r` 直接
 * `INSTALL_FAILED_VERSION_DOWNGRADE`。
 *
 * 取两个候选值的较大者：
 *   · 语义码：0.9.2 (+ahead) → 902（major*10000 + minor*100 + patch + ahead）
 *   · 提交累计：commitCount + 1000。加偏移是因为**已发布到用户设备上的包**
 *     写的是 versionCode=1，而历史提交数远大于它；偏移保证从第一个 git 版本
 *     开始就比任何已装包都大，不需要用户卸载重装。
 *
 * 用 max 而不是二选一：打了 tag 时语义码人可读且跳变大；同 tag 下连续打包
 * 时提交数递增（保证覆盖安装成功）。
 */
val tagVersionCode = baseMajor * 10_000 + baseMinor * 100 + basePatch + ahead
val countVersionCode = gitCommitCount + 1_000
val computedVersionCode = maxOf(tagVersionCode, countVersionCode)

/**
 * versionName 形如 `0.9.2+3.caf7a90`，dirty 时追加 `.dirty`。
 *
 * `+` 之后是构建元数据（SemVer 语义）：ahead 提交数 + 短 commit。不含空格与
 * 斜杠 —— `PackageParser`、崩溃上报平台、`adb shell dumpsys package` 都能
 * 安全处理。不带 `v` 前缀：git tag 有 v，版本名字段惯例没有。
 */
val computedVersionName = buildString {
    append("$baseMajor.$baseMinor.$basePatch")
    append("+")
    if (ahead > 0) {
        append(ahead)
        append(".")
    }
    append(gitCommit)
    if (gitDirty) append(".dirty")
}

// CI 覆盖口：浅克隆（--depth=1）下 `git describe --tags` 直接返回空，
// 全落进 fallback，两个构建机可能算出同一个 code。这时由 build-apk.ps1
// 把 tag 解析好再传进来。
val finalVersionCode = System.getenv("KXXY_VERSION_CODE")?.toIntOrNull() ?: computedVersionCode
val finalVersionName = System.getenv("KXXY_VERSION_NAME")?.takeIf { it.isNotBlank() }
    ?: computedVersionName

// ── 构建清单：由 tools/build-runtime.mjs 在打包 runtime 时写出 ──────────────
//
// 位置固定在 `src/main/assets/meta/build.json`（小文件，gradle 正常打进 APK）。
// 它同时是**原生探针的期望值来源**：探针要判断「APK 换了、设备上插件没换」，
// 此时设备上那份旧 build.json 还在旧 runtime 里，读它等于自证清白；期望值
// 只能来自 APK 本体。
val buildMetaFile = file("src/main/assets/meta/build.json")
val buildMetaText = if (buildMetaFile.isFile) buildMetaFile.readText() else ""
fun metaString(key: String): String =
    Regex("\"$key\"\\s*:\\s*\"([^\"]*)\"").find(buildMetaText)?.groupValues?.get(1) ?: "unknown"

android {
    namespace = "app.kxxy"
    compileSdk = 36
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "app.kxxy"
        minSdk = 26
        // 见文件头说明：28 是豁免 W^X 的阈值，不可提高
        targetSdk = 28
        versionCode = finalVersionCode
        versionName = finalVersionName

        ndk {
            abiFilters += listOf("arm64-v8a")
        }
        externalNativeBuild {
            cmake {
                cppFlags += "-std=c11"
                arguments += "-DANDROID_STL=none"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    // AGP 8 起 BuildConfig 默认不再生成，必须显式打开。
    // KxxyApp 用它打印版本号，缺了会报 "Unresolved reference: BuildConfig"。
    buildFeatures {
        buildConfig = true
    }

    defaultConfig {
        // 版本与构建元数据字段。
        //
        // 为什么塞进 BuildConfig 而不是运行时到处读文件：BuildConfig 是编译期
        // 常量，`EngineSupervisor.publishState()` 每 5 秒写一次状态快照，从这里
        // 取值零成本；而读 assets 要走 AssetManager、还有 IO 失败分支。
        //
        // `RUNTIME_FINGERPRINT` / `HOST_PLUGIN_FINGERPRINT` 都取自
        // `assets/meta/build.json`（由 tools/build-runtime.mjs 末尾写出）：
        // 前者是 runtime.zip 的 sha256 **全文**（64 hex，展示时截前 16 位），
        // 后者是 kxxy-host 目录树的内容哈希 —— 也就是锚点 8 在设备上要比对的那个。
        //
        // 未跑过 build-runtime.mjs 时两者都是 "unknown"：构建照常通过，锚点 8
        // 会主动放行（RuntimeInstaller.hostPluginIsCurrent 的第一个分支），
        // 关于页则把指纹行整块收起。
        buildConfigField("String", "BUILD_COMMIT", "\"$gitCommit\"")
        buildConfigField(
            "String",
            "BUILD_TIME_ISO",
            "\"${OffsetDateTime.now().truncatedTo(ChronoUnit.SECONDS)}\"",
        )
        // 类型必须写 "boolean"（而不是 "String"）：BuildMeta.Snapshot 里
        // `dirty` 是 Boolean，写成字符串会在 `dirty = BuildConfig.BUILD_DIRTY`
        // 处报 “Type mismatch: inferred type is String but Boolean was expected”。
        buildConfigField("boolean", "BUILD_DIRTY", "${gitDirty}")
        buildConfigField("String", "RUNTIME_FINGERPRINT", "\"${metaString("runtimeSha256")}\"")
        buildConfigField("String", "HOST_PLUGIN_FINGERPRINT", "\"${metaString("kxxyHostFingerprint")}\"")
        // 源码仓库地址：关于弹窗里那条「GitHub」链接用它。值由
        // tools/build-runtime.mjs 在构建期从 `git remote get-url origin`
        // 取（规范化成 https），设备上没有 git，也读不到仓库元数据。
        buildConfigField("String", "REPO_URL", "\"${metaString("repoUrl")}\"")
    }

    androidResources {
        // assets/runtime.zip 已经是 98 MiB 的 deflate 产物（内部 14800 条，
        // 未压缩 259 MiB）。让 aapt2 再压一遍纯属浪费 —— 既压不动（zip 头
        // 与已压缩的二进制进去就是原样），又要多花几分钟和一大块临时空间。
        //
        // 更关键的是 RuntimeInstaller 会用 `ZipFile` 读**中央目录**取 LINK 注释，
        // 走 asset 流式读取拿不到 comment；它已经先拷贝到 cacheDir 再用 ZipFile，
        // 所以这里的 noCompress 只影响 APK 体积与构建耗时，不影响正确性。
        noCompress += "zip"
        // 扩展包池 assets/ext-pool/*.pool（内容是 gzip 的 tar）同理已是压缩态，
        // 再压一遍纯浪费；且不压缩时 AssetManager.openFd() 才能取到真实 length ——
        // RuntimeInstaller.ensureExtensionPool 靠它做「大小一致即跳过」的幂等判断。
        // ⚠️ 后缀必须是 .pool 而非 .tar.gz：aapt2 在资产合并阶段会解包 .gz 并剥掉
        // 后缀（实测 APK 条目变成 703MB 的明文 .tar），既撑大 APK 又破坏按名查池。
        noCompress += "pool"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        jniLibs {
            // 参考项目 UserLAnd 的第一手踩坑记录（原文）：
            //   "Confirmed live: with useLegacyPackaging=false, this device's
            //    PackageManager extracted *nothing* to legacyNativeLibraryDir at
            //    all ... Since busybox/proot/pulseaudio/etc. are 'fake .so'
            //    executables that only work by actually landing on disk (not by
            //    being mmap'd as real shared libraries), useLegacyPackaging=false
            //    breaks every session outright."
            // 方案 T 不用伪装 .so（targetSdk=28 已可 execve），但保持 legacy
            // 打包以便 libdsh_pty.so 落盘到 nativeLibraryDir，便于诊断。
            useLegacyPackaging = true
        }
    }

    lint {
        // targetSdk 28 会触发大量 lint 提示（前台服务类型、通知权限等），
        // 这些是刻意的兼容性决策，不阻断构建。
        abortOnError = false
    }
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // .deb 的 data.tar.xz 解码（纯 Java 实现，约 110 KB）—— 扩展中心解包链路
    implementation("org.tukaani:xz:1.10")

    // Shizuku：ADB 身份执行通道。
    //
    // 为什么要它：Shizuku 的 binder 能力给不了引擎子进程（引擎是 execve 起的独立
    // 进程，uid 由内核决定），所以「shizuku 模式」的语义是**给引擎注入一个以
    // adb/shell 身份执行命令的通道**，而不是给引擎提权。
    //
    // api 传递带入 aidl（moe.shizuku.server.IShizukuService / IRemoteProcess）与
    // shared；provider 传递带入 api。三者都在 mavenCentral，无需新增仓库。
    //
    // 为什么用 13.1.5 而不是更新版本：Shizuku.newProcess() 在 13.x 已降级为
    // private static，官方推荐 UserService 或 transactRemote。我们走
    // ShizukuBinderWrapper + IShizukuService.Stub.asInterface(...) 这条等价路径，
    // 不依赖该私有方法，因此 13.1.5 的 API 面足够且长期稳定。
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
}

/**
 * 构建机核对用：`gradle -q :app:printVersionInfo`
 *
 * 存在的理由很具体 —— 浅克隆或两套构建机并行出包时，最容易出的事故是
 * 「两个包 versionCode 相同」，而 gradle 对此一声不响。这个任务把推导过程
 * 全部打出来，CI 里跑一遍就能对齐。
 */
tasks.register("printVersionInfo") {
    group = "help"
    description = "打印推导出的 versionCode / versionName / 构建元数据"
    doLast {
        println("KXXY  versionCode = $finalVersionCode")
        println("      versionName = $finalVersionName")
        println("      baseline    = $baseMajor.$baseMinor.$basePatch + $ahead ahead  <- $versionSource")
        println("      git describe= '$gitDescribe'")
        println("      git exe     = $gitExe")
        println("      commit= $gitCommit  count= $gitCommitCount  dirty= $gitDirty")
        println("      runtime= ${metaString("runtimeSha256")}")
        println("      hostPlugin= ${metaString("kxxyHostFingerprint")}")
        // 三条前置条件，缺任何一条都会让产物「看起来正常但其实是降级」。
        // 用 ASCII 输出：Windows 控制台按 GBK 解码，中文会变成乱码。
        when (versionSource) {
            "git-tag" -> {}
            "none" -> println(
                "      [WARN] no git tag and no 'vX.Y.Z' commit subject -> version falls back to 0.0.0.\n" +
                    "             fix: git tag -a v0.9.2 -m 'v0.9.2' (then describe will anchor on it)",
            )
            else -> println(
                "      [WARN] baseline comes from a commit subject, not a tag.\n" +
                    "             run `git tag -a v$baseMajor.$baseMinor.$basePatch -m '...'` to make it authoritative",
            )
        }
        if (buildMetaText.isEmpty()) {
            println(
                "      [WARN] src/main/assets/meta/build.json is missing\n" +
                    "             -> run `node tools/build-runtime.mjs --manifest .cache/manifest.json` first;\n" +
                    "             without it runtime/host fingerprints are 'unknown' and anchor 8 always passes",
            )
        }
    }
}
