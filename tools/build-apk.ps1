<#
.SYNOPSIS
  构建 Android APK（大资源两步注入 + 对齐 + 签名）。

.DESCRIPTION
  本脚本把「大资源不进 assets、build 后用流式追加器注入、再 zipalign、最后重签」这条流程固化，
避免每次重新踩 `compressDebugAssets` 的 OOM 与 AGP 增量打包残留两个坑。

必须先满足：
  · `node tools/build-runtime.mjs --manifest .cache/manifest.json` 已跑完（runtime.zip 就位）
  · `node tools/fetch-extensions.mjs` 已跑完（.cache/ext-pool 就位）
  · `JAVA_HOME` 指向 JDK 17，`gradle` 与 `apksigner.bat` 可用

用法：
  powershell -File tools/build-apk.ps1

参数：
  -SkipGradle    跳过 gradle（只做注入 + 对齐 + 签名，用于仅改了注入器时快速迭代）
  -KeepAligned   保留中间产物 app-aligned.apk

⚠️ 内存前提：本机物理 8 GB、提交上限 15.82 GB、常态余量 < 2 GB。
   `compressDebugAssets` 会把每个 asset 整份读进堆，runtime.zip 700+ MiB 必 OOM，
   `-Xmx` 调到 6 GB 也没用（已实测 1.5/2.5/3/3.5/4/6 GB 全挂）。所以大资源必须移出 assets。
#>

param(
    [switch]$SkipGradle,
    [switch]$KeepAligned,
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

    $sdkCandidates = @(
        $env:ANDROID_HOME,
        $env:ANDROID_SDK_ROOT,
        "C:\KF\fbtools\sdk",
        "$env:LOCALAPPDATA\Android\Sdk",
        "C:\Users\XiaoXin\AppData\Local\Android\Sdk"
    ) | Where-Object { $_ }
    $sdk = $null
    foreach ($cand in $sdkCandidates) {
        if (Test-Path (Join-Path $cand "build-tools")) { $sdk = $cand; break }
    }
    if (-not $sdk) {
        throw "找不到 Android SDK（试过：$($sdkCandidates -join '; ')）。用 ANDROID_HOME 指定。"
    }

    # JDK：apksigner.bat 与 gradle 都需要。优先 JAVA_HOME，其次本机工具链目录。
    $jdkCandidates = @($env:JAVA_HOME, "C:\KF\fbtools\jdk") | Where-Object { $_ }
    $jdk = $null
    foreach ($cand in $jdkCandidates) {
        if (Test-Path (Join-Path $cand "bin\java.exe")) { $jdk = $cand; break }
    }
    if (-not $jdk) {
        $adoptium = Get-ChildItem "C:\Program Files\Eclipse Adoptium" -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName "bin\java.exe") } | Select-Object -First 1
        if ($adoptium) { $jdk = $adoptium.FullName }
    }
    if (-not $jdk) {
        throw "找不到 JDK 17（试过：$($jdkCandidates -join '; ')、C:\Program Files\Eclipse Adoptium）。用 JAVA_HOME 指定。"
    }

    # JAVA_HOME 必须在 gradle **之前**就导出。原来只在第 6 步签名时设置，
    # 于是 `gradle.bat` 一启动就报
    # `ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.`
    # 并已 exit 9009 结束（本机 PATH 里没有 java）。
    $env:JAVA_HOME = $jdk
    $env:PATH = "$jdk\bin;$env:PATH"

    Write-Host "      node = $node"
    Write-Host "      sdk  = $sdk"
    Write-Host "      jdk  = $jdk"

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
    if (-not $gradle -or -not (Test-Path $gradle)) {
        throw "找不到 gradle（C:\KF\fbtools\gradle、PATH 与 ~/.gradle/wrapper/dists 都没有）。请用 -SkipGradle 或自行安装。"
    }
    Write-Host "      gradle = $gradle"

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
    Remove-Item -Force -ErrorAction SilentlyContinue $apk, $aligned, $signed
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$Project\android\app\build\intermediates\apk\debug"

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
            & $gradle assembleDebug --offline --console=plain --max-workers=1 `
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
    & $node "$Project\tools\inject-apk-assets.mjs" --apk $apk --assets $hold
    if ($LASTEXITCODE -ne 0) { throw "注入失败（exit $LASTEXITCODE）" }
    $injected = (Get-Item $apk).Length
    Write-Host ("      注入后 {0:N0} B（{1:N2} MiB）" -f $injected, ($injected / 1MB))
    if ($injected -lt 1GB) {
        throw "注入后 APK 只有 $([math]::Round($injected/1MB,2)) MiB，大资源没进去"
    }

    # ── 5) zipalign ───────────────────────────────────────────────────────
    Write-Host "[5/6] zipalign …" -ForegroundColor Cyan
    & $node "$Project\packaging\zipalign.mjs" -f 4 $apk $aligned
    if ($LASTEXITCODE -ne 0) { throw "zipalign 失败（exit $LASTEXITCODE）" }

    # ── 6) 重签 ───────────────────────────────────────────────────────────
    Write-Host "[6/6] apksigner 重签 …" -ForegroundColor Cyan
    # 缺陷 DI：这里原来写死 `C:\Program Files\Eclipse Adoptium\jdk-17.0.18.8-hotspot`，
    # 本机没有该目录。改用上面探测到的 $jdk（apksigner.bat 需要 JAVA_HOME 才能跑）。
    $env:JAVA_HOME = $jdk
    $env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
    # build-tools 版本按目录探测（本机有 25.0.3 / 34.0.0 / 36.0.0），取最高的一个 ——
    # 写死 36.0.0 在只有 34 的机器上会直接失败。
    $signer = $null
    $btRoot = Join-Path $sdk "build-tools"
    $btDirs = Get-ChildItem $btRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName "apksigner.bat") } |
        Sort-Object { [version]($_.Name -replace '[^0-9.].*$','') } -Descending
    foreach ($d in $btDirs) {
        $cand = Join-Path $d.FullName "apksigner.bat"
        if (Test-Path $cand) { $signer = $cand; break }
    }
    $ks = "$env:USERPROFILE\.android\debug.keystore"
    if (-not $signer) { throw "找不到 apksigner（$btRoot 下没有任何 build-tools 带 apksigner.bat）" }
    if (-not (Test-Path $ks)) { throw "找不到 debug.keystore: $ks" }
    Write-Host "      apksigner = $signer"

    Copy-Item -Force $aligned $signed
    & $signer sign --ks $ks --ks-pass pass:android --key-pass pass:android `
        --ks-key-alias androiddebugkey $signed
    if ($LASTEXITCODE -ne 0) { throw "apksigner 失败（exit $LASTEXITCODE）" }

    # 硬校验：签名必须真的落盘。踩过一次 —— apksigner 声称 exit 0，
    # 但 signed 与 aligned 字节完全相同、且没有 APK Signing Block，
    # 装设备时才报 INSTALL_PARSE_FAILED_NO_CERTIFICATES。
    $nAligned = (Get-Item $aligned).Length
    $nSigned = (Get-Item $signed).Length
    if ($nSigned -le $nAligned) {
        throw "签名无效：signed=$nSigned B 未大于 aligned=$nAligned B（apksigner 没改动文件）"
    }
    # 注意：**不要**在这里用 `| Select-Object -First 4`。管道提前关闭会把
    # apksigner 进程直接掐掉（Windows 上表现为 exit -1），于是下面那句
    # `if ($LASTEXITCODE -ne 0)` 必然抛「apksigner verify 失败」，明明签名是好的。
    # 先把输出全收进变量再取前几行。
    $verifyOut = & $signer verify --print-certs $signed 2>&1
    $verifyRc = $LASTEXITCODE
    $verifyOut | Select-Object -First 4 | ForEach-Object { Write-Host "      $_" }
    if ($verifyRc -ne 0) { throw "apksigner verify 失败（exit $verifyRc）" }
    Write-Host ("      aligned {0:N0} B → signed {1:N0} B（+{2:N0} B 签名块）" -f `
        $nAligned, $nSigned, ($nSigned - $nAligned))

    if (-not $KeepAligned) { Remove-Item -Force -ErrorAction SilentlyContinue $aligned }

    $final = (Get-Item $signed).Length
    Write-Host ""
    Write-Host ("完成：{0}" -f $signed) -ForegroundColor Green
    Write-Host ("      {0:N0} B（{1:N2} MiB）" -f $final, ($final / 1MB)) -ForegroundColor Green
    Write-Host ""
    Write-Host "安装到真机（patchset 版本未变时必须 pm clear，否则 isComplete() 判真不重装）：" -ForegroundColor Yellow
    Write-Host "  adb install -r -d `"$signed`""
    Write-Host "  adb shell pm clear app.kxxy"
    Write-Host "  adb shell monkey -p app.kxxy -c android.intent.category.LAUNCHER 1"
} finally {
    Pop-Location
}
