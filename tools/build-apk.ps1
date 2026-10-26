<#
.SYNOPSIS
  构建 Android APK（大资源两步注入 + 对齐 + 签名）。

.DESCRIPTION
  本脚本把「大资源不进 assets、build 后用流式追加器注入、再 zipalign、最后重签」这条流程固化，
避免每次重新踩 `compressDebugAssets` 的 OOM 与 AGP 增量打包残留两个坑。

必须先满足：
  · `node tools/build-runtime.mjs --manifest .cache/manifest.json` 已跑完（runtime.zip 就位）
  · `node tools/fetch-extensions.mjs` 已跑完（.cache/ext-pool 就位）
  · 跑 gradle 时需要 JDK 17 与 Android SDK；**只做注入+对齐+签名时两者都不需要**
    （签名用仓库自带 apksigner.jar，见 android/keystore/README.md 与缺陷 DX）

用法：
  powershell -File tools/build-apk.ps1

参数：
  -SkipGradle    跳过 gradle（只做注入 + 对齐 + 签名，用于仅改了注入器时快速迭代）。
                 前提是已有 app-debug.apk —— 没有时会在删任何东西**之前**报错。
  -KeepAligned   保留中间产物 app-aligned.apk
  -Offline       给 gradle 加 --offline（依赖全在 ~/.gradle 缓存里时才用；默认联网）

⚠️ 内存前提：本机物理 8 GB、提交上限 15.82 GB、常态余量 < 2 GB。
   `compressDebugAssets` 会把每个 asset 整份读进堆，runtime.zip 700+ MiB 必 OOM，
   `-Xmx` 调到 6 GB 也没用（已实测 1.5/2.5/3/3.5/4/6 GB 全挂）。所以大资源必须移出 assets。
#>

param(
    [switch]$SkipGradle,
    [switch]$KeepAligned,
    [switch]$Offline,
    [string]$Gradle = ""
)

$ErrorActionPreference = "Stop"
$Project = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$Project\tools\build-runtime.mjs")) {
    $Project = "F:\KF\DSKX\dsh-kxxy"
}
Push-Location $Project
try {
    # ── 工具链探测（缺陷 DI）─────────────────────────────────────────────
    #
    # 这个脚本原来把三处路径**写死成另一台机器**的绝对路径：
    #   node   = C:\Users\XiaoXin\.dsh\...\node.exe
    #   sdk    = C:\Users\XiaoXin\AppData\Local\Android\Sdk
    #   JAVA_HOME = C:\Program Files\Eclipse Adoptium\jdk-17.0.18.8-hotspot
    # 在当前构建机上三者都不存在，于是脚本在第一步就 `node` 找不到而失败。
    #
    # 现在改成「按优先级探测」：环境变量优先，其次本机实测可用的固定位置
    # （工具链放在 C:\KF\fbtools 下），最后才回落到 PATH。探测失败时给出
    # 明确的补救提示，而不是让后面的 gradle 报一个不相干的错。
    $nodeCandidates = @(
        $env:KXXY_NODE,
        "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin\node.exe",
        "C:\Users\XiaoXin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
    ) | Where-Object { $_ }
    $node = $null
    foreach ($cand in $nodeCandidates) {
        if (Test-Path $cand) { $node = $cand; break }
    }
    if (-not $node) {
        $cmd = Get-Command node -ErrorAction SilentlyContinue
        if ($cmd) { $node = $cmd.Source }
    }
    if (-not $node) {
        throw "找不到 node.exe（试过：$($nodeCandidates -join '; ')）。用 KXXY_NODE 指定。"
    }

    $assets   = "$Project\android\app\src\main\assets"
    $hold     = "$Project\.cache\apk-assets-hold"
    $apk      = "$Project\android\app\build\outputs\apk\debug\app-debug.apk"
    $aligned  = "$Project\android\app\build\outputs\apk\debug\app-aligned.apk"
    $signed   = "$Project\android\app\build\outputs\apk\debug\app-signed.apk"

    # SDK：只有 gradle 需要（`-SkipGradle` 的注入+对齐+签名三件事都不碰它 ——
    # apksigner 从缺陷 DX 起由 tools/sign-apk.mjs 自带 jar 兜底）。
    # 所以这里探测不到只记一笔，等到真要跑 gradle 时才报错。
    $sdkCandidates = @(
        $env:ANDROID_HOME,
        $env:ANDROID_SDK_ROOT,
        "C:\KF\fbtools\sdk",
        "$env:LOCALAPPDATA\Android\Sdk",
        "C:\Users\XiaoXin\AppData\Local\Android\Sdk"
    ) | Where-Object { $_ }
    # local.properties 里的 sdk.dir 也要认：那是 gradle 自己的事实源，
    # 机器上装了多个 SDK 时以它为准（本仓库的 local.properties 就是这种形态）。
    $localProps = "$Project\android\local.properties"
    if (Test-Path $localProps) {
        $line = Select-String -Path $localProps -Pattern '^\s*sdk\.dir\s*=\s*(.+)$' -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($line) {
            $sdkDir = $line.Matches[0].Groups[1].Value.Trim()
            # properties 里的 Windows 路径是 `C\:\\KF\\fbtools\\sdk` 这种转义形态。
            $sdkDir = $sdkDir -replace '\\\\', '\' -replace '\\([: ])', '$1'
            $sdkCandidates = @($sdkDir) + $sdkCandidates
        }
    }
    $sdk = $null
    foreach ($cand in $sdkCandidates) {
        if (Test-Path (Join-Path $cand "build-tools")) { $sdk = $cand; break }
    }

    # JDK：gradle 需要 JAVA_HOME，apksigner.bat 也需要。优先 JAVA_HOME，
    # 其次本机工具链目录，最后是 IDE 自带的 JBR / ~/.jdks。
    #
    # 缺陷 DX 之后这里**不再是硬前置**：签名走 `tools/sign-apk.mjs`，它自己按
    # KXXY_JAVA → JAVA_HOME → Android Studio JBR → ~/.jdks → PATH 找 java，
    # 找不到时给出「怎么装/怎么指」的明确提示。这里探测到就导出 JAVA_HOME，
    # 探测不到则只在**真要跑 gradle** 时才报错 —— 否则 `-SkipGradle`
    # （只注入 + 对齐 + 重签）这条快速迭代路径会被一个与它无关的前置挡住。
    $jdkCandidates = @($env:JAVA_HOME, $env:KXXY_JAVA_HOME, "C:\KF\fbtools\jdk") | Where-Object { $_ }
    $jdk = $null
    foreach ($cand in $jdkCandidates) {
        if (Test-Path (Join-Path $cand "bin\java.exe")) { $jdk = $cand; break }
    }
    if (-not $jdk -and $env:KXXY_JAVA -and (Test-Path $env:KXXY_JAVA)) {
        # KXXY_JAVA 直接给 java.exe 时，取 <jdk>/bin/java.exe 的上两级。
        $jdk = Split-Path -Parent (Split-Path -Parent $env:KXXY_JAVA)
    }
    if (-not $jdk) {
        $jdkRoots = @(
            "C:\Program Files\Eclipse Adoptium",
            "C:\Program Files\Java",
            "$env:LOCALAPPDATA\Programs\Android Studio\jbr",
            "C:\Program Files\Android\Android Studio\jbr",
            "$env:USERPROFILE\.jdks"
        ) | Where-Object { $_ -and (Test-Path $_) }
        foreach ($root in $jdkRoots) {
            if (Test-Path (Join-Path $root "bin\java.exe")) { $jdk = $root; break }
            $hit = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
                Where-Object { Test-Path (Join-Path $_.FullName "bin\java.exe") } |
                Select-Object -First 1
            if ($hit) { $jdk = $hit.FullName; break }
        }
    }

    # JAVA_HOME 必须在 gradle **之前**就导出。原来只在第 6 步签名时设置，
    # 于是 `gradle.bat` 一启动就报
    # `ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.`
    # 并已 exit 9009 结束（本机 PATH 里没有 java）。
    if ($jdk) {
        $env:JAVA_HOME = $jdk
        $env:PATH = "$jdk\bin;$env:PATH"
    }

    Write-Host "      node = $node"
    Write-Host ("      sdk  = " + $(if ($sdk) { $sdk } else { "（未探测到；仅 gradle 需要，-SkipGradle 时用不到）" }))
    Write-Host ("      jdk  = " + $(if ($jdk) { $jdk } else { "（未探测到；交给 tools/sign-apk.mjs 再找）" }))

    # gradle：优先本机工具链里的 8.10.2（AGP 8.5.2 的已验证组合），
    # 其次 PATH，最后才是 ~/.gradle/wrapper/dists。本项目没有 gradlew。
    if (-not $gradle) {
        $fixed = "C:\KF\fbtools\gradle\gradle-8.10.2\bin\gradle.bat"
        if (Test-Path $fixed) { $gradle = $fixed }
    }
    if (-not $gradle) {
        $cmd = Get-Command gradle -ErrorAction SilentlyContinue
        if ($cmd) { $gradle = $cmd.Source }
    }
    if (-not $gradle) {
        $wrapperRoot = "$env:USERPROFILE\.gradle\wrapper\dists"
        $preferred = @("gradle-8.10.2-bin", "gradle-8.10.2-all", "gradle-8.13-bin", "gradle-8.14-all")
        foreach ($name in $preferred) {
            $hit = Get-ChildItem "$wrapperRoot\$name" -Recurse -Depth 3 -Filter "gradle.bat" -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($hit) { $gradle = $hit.FullName; break }
        }
        if (-not $gradle) {
            $hit = Get-ChildItem $wrapperRoot -Recurse -Depth 3 -Filter "gradle.bat" -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($hit) { $gradle = $hit.FullName }
        }
    }
    # 只在真要跑 gradle 时才是硬前置（见上面 JDK 段落的说明）。
    if (-not $SkipGradle) {
        if (-not $sdk) {
            throw "跑 gradle 需要 Android SDK（试过：$($sdkCandidates -join '; ')）。用 ANDROID_HOME 指定，或改用 -SkipGradle。"
        }
        if (-not $gradle -or -not (Test-Path $gradle)) {
            throw "找不到 gradle（C:\KF\fbtools\gradle、PATH 与 ~/.gradle/wrapper/dists 都没有）。请用 -SkipGradle 或自行安装。"
        }
        if (-not $jdk) {
            throw "跑 gradle 需要 JDK 17：JAVA_HOME / KXXY_JAVA_HOME / C:\KF\fbtools\jdk 都没有 bin\java.exe。用 JAVA_HOME 指定，或改用 -SkipGradle 只做注入+签名。"
        }
        Write-Host "      gradle = $gradle"
    }

    # ── 1) 大资源移出 assets（compressDebugAssets 才不会 OOM）────────────
    Write-Host "[1/6] 将大资源移出 assets …" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $hold | Out-Null
    # `alias-links.txt` 只有 119 KB，本可以让 gradle 直接打进 assets；这里仍然
    # 移出来交给注入器，是为了让「APK 里的资源」只有一个来源（$hold），
    # 避免出现「gradle 打了一份、注入器又塞了一份」的重复条目。
    foreach ($item in @("runtime.zip", "alias-links.txt")) {
        $src = Join-Path $assets $item
        if (Test-Path $src) {
            Move-Item -Force $src (Join-Path $hold $item)
            Write-Host "      moved: $item"
        }
    }
    $poolSrc = Join-Path $assets "ext-pool"
    if (Test-Path $poolSrc) {
        Move-Item -Force $poolSrc (Join-Path $hold "ext-pool")
        Write-Host "      moved: ext-pool/"
    }

    # ── 2) 清干净产物（AGP 增量打包 append-only，会残留孤儿数据）──────────
    Write-Host "[2/6] 清理旧产物 …" -ForegroundColor Cyan
    #
    # 缺陷 DY（2026-10-26 真事故）：这里原来是无条件
    #
    #     Remove-Item -Force -ErrorAction SilentlyContinue $apk, $aligned, $signed
    #
    # 而 `-SkipGradle` 的本意是「复用上次 gradle 出的小包，只重做注入+对齐+签名」。
    # 两者放在一起就是：**先把唯一那份 app-debug.apk 删掉，再跳过生成它的步骤**，
    # 于是第 3 步之后立刻 `找不到 app-debug.apk`，退出码 1，磁盘上什么都不剩
    # —— 连上一次能装的包都没了。本次就是这样丢掉了 1.72 GiB 的成品（而本机
    # 没有 platform-36 / NDK / cmake，无法当场重编）。
    #
    # 现在分三种情况处理，原则是「删之前先确保能还原」：
    #   ① `-SkipGradle` 且没有 app-debug.apk → **在删任何东西之前**就报错；
    #   ② `-SkipGradle` 且有 app-debug.apk  → 保留它（它就是这次要注入的输入），
    #      只清 aligned / signed；
    #   ③ 正常跑 gradle → 把现有 app-debug.apk 先挪进备份目录再清，
    #      这样 gradle 失败时还能用上一次的包（备份目录单独放，不混进 $hold，
    #      否则注入器会把它当成大资源再塞一遍）。
    if ($SkipGradle) {
        if (-not (Test-Path $apk)) {
            throw @"
-SkipGradle 需要一份已存在的 $apk，但它不存在。
  本机没有可用的 gradle 产物时，请去掉 -SkipGradle 让 gradle 先出小包。
  （旧版本会先删掉它再跳过生成，结果是「什么都不剩」—— 见缺陷 DY。）
"@
        }
        Write-Host "      保留输入小包 app-debug.apk（-SkipGradle 的输入）"
        Remove-Item -Force -ErrorAction SilentlyContinue $aligned, $signed
    } else {
        # 备份上一次的成品：gradle 失败 / 中途抛错时至少还有一份能装的包。
        $backup = "$Project\.cache\apk-backup"
        foreach ($item in @($apk, $signed)) {
            if (Test-Path $item) {
                New-Item -ItemType Directory -Force -Path $backup | Out-Null
                Move-Item -Force $item (Join-Path $backup (Split-Path -Leaf $item))
                Write-Host ("      备份 " + (Split-Path -Leaf $item) + " → .cache/apk-backup/")
            }
        }
        Remove-Item -Force -ErrorAction SilentlyContinue $aligned
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$Project\android\app\build\intermediates\apk\debug"
    }

    # ── 3) gradle 出小 APK ────────────────────────────────────────────────
    if (-not $SkipGradle) {
        Write-Host "[3/6] gradle assembleDebug（小包）…" -ForegroundColor Cyan
        Push-Location "$Project\android"
        try {
            # 构建机提交内存只有 ~1 GB 余量时，默认 C2 编译器还要额外 malloc
            # （实测崩在 Chunk::new / 864816 bytes）。TieredStopAtLevel=1 关掉 C2、
            # ReservedCodeCacheSize 收窄，堆也压到 2 GB 以内。
            $jvmArgs = "-Xmx2048m -XX:MaxMetaspaceSize=384m " +
                       "-XX:ReservedCodeCacheSize=96m -XX:+UseSerialGC " +
                       "-XX:TieredStopAtLevel=1"
            # `--offline` 曾经是默认值，因为旧构建机上依赖全在 ~/.gradle 缓存里、
            # 联网反而慢。但它有一个只在**换机器/换版本**时才爆的坑：
            # 缓存里只有 AGP 8.5.1，而 build.gradle.kts 要 8.5.2 —— offline 下
            # 直接 `No cached version of com.android.tools.build:gradle:8.5.2`，
            # 报错看起来像「插件没装」，实际是「不许下载」。现在改成显式开关：
            # 默认联网（缓存命中时不会真的下载），`-Offline` 才强制离线。
            $offlineArg = @()
            if ($Offline) { $offlineArg = @("--offline") }
            & $gradle assembleDebug @offlineArg --console=plain --max-workers=1 `
                "-Dorg.gradle.jvmargs=$jvmArgs"
            if ($LASTEXITCODE -ne 0) { throw "gradle 失败（exit $LASTEXITCODE）" }
        } finally { Pop-Location }
    } else {
        Write-Host "[3/6] 跳过 gradle" -ForegroundColor DarkGray
    }
    if (-not (Test-Path $apk)) { throw "找不到 $apk" }
    $small = (Get-Item $apk).Length
    Write-Host ("      小包 {0:N0} B（{1:N2} MiB）" -f $small, ($small / 1MB))

    # ── 4) 注入大资源（STORE + 重写中央目录）─────────────────────────────
    Write-Host "[4/6] 注入大资源 …" -ForegroundColor Cyan
    # 先算清楚「应该有」的增量，而不是只判一个死阈值 `> 1GB`。
    # 2026-10-23 出过一次：清暂存目录时把 runtime.zip 一起删了，assets 里只剩
    # ext-pool 与 meta。小包本身就有 1.19 GB，`> 1GB` 的断言照样通过，于是
    # 「成功」打出一个没有运行时的 APK（1.19 GB，真机装上必然起不来）。
    $holdItems = @(Get-ChildItem $hold -ErrorAction SilentlyContinue)
    if ($holdItems.Count -eq 0) {
        throw "暂存目录 $hold 是空的：大资源没从 assets 移过来，注入只会打出一个瘦包"
    }
    if (-not (Test-Path (Join-Path $hold 'runtime.zip'))) {
        throw "暂存目录里没有 runtime.zip —— 先跑 node tools/build-runtime.mjs 生成运行时再打包"
    }
    $holdBytes = ($holdItems | ForEach-Object {
        if ($_.PSIsContainer) {
            (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum
        } else { $_.Length }
    } | Measure-Object -Sum).Sum
    & $node "$Project\tools\inject-apk-assets.mjs" --apk $apk --assets $hold
    if ($LASTEXITCODE -ne 0) { throw "注入失败（exit $LASTEXITCODE）" }
    $injected = (Get-Item $apk).Length
    Write-Host ("      注入后 {0:N0} B（{1:N2} MiB）" -f $injected, ($injected / 1MB))
    $expectInjected = $small + [int64]($holdBytes * 0.98)
    if ($injected -lt $expectInjected) {
        throw ("注入后 APK {0:N2} MiB，低于预期 {1:N2} MiB —— 大资源没全进去" -f ($injected / 1MB), ($expectInjected / 1MB))
    }

    # ── 5) zipalign ───────────────────────────────────────────────────────
    Write-Host "[5/6] zipalign …" -ForegroundColor Cyan
    & $node "$Project\packaging\zipalign.mjs" -f 4 $apk $aligned
    if ($LASTEXITCODE -ne 0) { throw "zipalign 失败（exit $LASTEXITCODE）" }

    # ── 6) 重签 ───────────────────────────────────────────────────────────
    Write-Host "[6/6] 固定签名（tools/sign-apk.mjs）…" -ForegroundColor Cyan
    # ── 缺陷 DX：签名从「本机 debug.keystore」改成「仓库内固定密钥」────────
    #
    # 原来这里读的是 `$env:USERPROFILE\.android\debug.keystore` —— AGP 在缺失时
    # **自动生成**的一次性密钥（密码固定 android / 别名 androiddebugkey），
    # 每台机器、每个 Windows 用户各一份。于是换构建机、换用户、清了
    # `%USERPROFILE%`，签出来的包在设备上都报
    #
    #     INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package app.kxxy signatures
    #     do not match previously installed version
    #
    # 这条错误没有任何绕过手段（版本号降级还能 `adb install -d` 硬压），
    # 只能卸载 —— 而卸载会连引擎、713 MiB 运行时、会话、扩展一起删掉。
    # 用户原话：「能不能固定签名啊，换了几次了，每次要卸载」。
    #
    # 现在三件事一起改掉：
    #   ① 密钥固定在 android/keystore/kxxy-signing.jks（入库，见该目录 README）；
    #   ② 签名动作收进 tools/sign-apk.mjs —— 它自带 apksigner.jar 兜底，
    #      **不要求本机装过 Android SDK**（这正是「换机器就出事」的另一半）；
    #   ③ 签完硬校验证书 SHA-256 与 properties 里的 certSha256 相等，
    #      不等直接抛错，而不是产出一个能装、不能升的包。
    #
    # 注意顺序仍然是「先 zipalign，再签名」：v2/v3 签名块覆盖整个文件字节，
    # 重排 offset 必然让它失效（见 packaging/zipalign.mjs 文件头）。
    & $node "$Project\tools\sign-apk.mjs" --in $aligned --out $signed
    if ($LASTEXITCODE -ne 0) { throw "固定签名失败（exit $LASTEXITCODE）" }
    if (-not (Test-Path $signed)) { throw "签名脚本声称成功，但 $signed 不存在" }

    $nAligned = (Get-Item $aligned).Length
    $nSigned = (Get-Item $signed).Length
    Write-Host ("      aligned {0:N0} B → signed {1:N0} B（+{2:N0} B 签名块）" -f `
        $nAligned, $nSigned, ($nSigned - $nAligned))

    if (-not $KeepAligned) { Remove-Item -Force -ErrorAction SilentlyContinue $aligned }

    $final = (Get-Item $signed).Length
    Write-Host ""
    Write-Host ("完成：{0}" -f $signed) -ForegroundColor Green
    Write-Host ("      {0:N0} B（{1:N2} MiB）" -f $final, ($final / 1MB)) -ForegroundColor Green
    Write-Host ""
    Write-Host "安装到真机（patchset 版本未变时必须 pm clear，否则 isComplete() 判真不重装）：" -ForegroundColor Yellow
    Write-Host "  adb install -r `"$signed`""
    Write-Host "  adb shell pm clear app.kxxy"
    Write-Host "  adb shell monkey -p app.kxxy -c android.intent.category.LAUNCHER 1"
    Write-Host ""
    Write-Host "签名是仓库内固定密钥（android/keystore/），此后换机器/换用户都不用再卸载。" -ForegroundColor DarkGray
    Write-Host "只有从**旧的 debug 签名包**迁到本密钥时，需要卸载一次：" -ForegroundColor DarkGray
    Write-Host "  adb uninstall app.kxxy" -ForegroundColor DarkGray
    Write-Host "想确认手里这个包用的是哪把钥匙：" -ForegroundColor DarkGray
    Write-Host "  node tools/sign-apk.mjs --check `"$signed`"" -ForegroundColor DarkGray
} finally {
    Pop-Location
}
