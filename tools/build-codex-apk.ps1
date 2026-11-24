# Package the current Codex sidebar as a development APK; never install on a device.
param(
    [Parameter(Mandatory = $true)][string]$Runtime,
    [Parameter(Mandatory = $true)][string]$Backup,
    [string]$Version = '0.9.31',
    [int]$VersionCode = 931000,
    [switch]$NativeApp
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$tools = 'E:\deepseek-harness\XJZB\_toolchain'
$env:KXXY_NODE = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$python = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$env:KXXY_GIT = 'C:\Users\Administrator\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe'
$env:JAVA_HOME = Join-Path $tools 'jdk-17.0.20.1+1'
$env:KXXY_JAVA = Join-Path $env:JAVA_HOME 'bin\java.exe'
$env:ANDROID_HOME = Join-Path $tools 'sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PATH = "$(Split-Path -Parent $env:KXXY_GIT);$env:JAVA_HOME\bin;$env:PATH"
$env:KXXY_CODEX_RUNTIME_DIR = $null
$env:KXXY_VERSION_NAME = $Version
$env:KXXY_VERSION_CODE = "$VersionCode"
$gradle = Join-Path $tools 'gradle-8.10.2\bin\gradle.bat'
$apk = Join-Path $project "dist\Kxxy-$Version.apk"
$report = Join-Path $project "dist\Kxxy-$Version-verification.json"
$hold = Join-Path $project '.cache\apk-assets-hold'
# `-Backup` / `-Runtime` 都可能传相对路径，而 build-apk.ps1 会 Push-Location 到 android/：
# 收尾再写 `codex-apk-result.json` 时相对路径就解析到 android\ 下面。v0.9.89 实际踩到一次 ——
# 包、签名、两段终验全过，最后一步抛 DirectoryNotFoundException，构建结果没落盘。
# 这里一次性锚成绝对路径，后面的 Copy-Item / Get-FileHash 也一并受益。
$Backup = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Backup))
$Runtime = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Runtime))
foreach ($path in @($Runtime, $env:KXXY_NODE, $python, $env:KXXY_JAVA, $gradle, (Join-Path $Backup '.cache\apk-assets-hold\runtime.zip'))) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing build input/backup: $path" }
}
if (Test-Path -LiteralPath $apk) { throw "Refusing to replace existing APK: $apk" }
if (Test-Path -LiteralPath $report) { throw "Refusing to replace existing verification report: $report" }
$floor = Join-Path $project 'android\.kxxy-version-code-floor'
if (Test-Path -LiteralPath $floor) {
    $previousCode = [int](Get-Content -LiteralPath $floor -Raw)
    if ($VersionCode -le $previousCode) { throw "New version code must be greater than $previousCode" }
}
$meta = Get-Content -LiteralPath "$project\android\app\src\main\assets\meta\build.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$runtimeHash = (Get-FileHash -LiteralPath $Runtime -Algorithm SHA256).Hash.ToLowerInvariant()
if ($runtimeHash -ne $meta.runtimeSha256 -or -not $meta.codexPluginFingerprint) { throw 'Runtime and Codex metadata do not match' }
if ($meta.codexRuntimeIncluded) {
    if (-not $NativeApp -or $meta.codexRuntimeExecutionMode -ne 'app-process' -or -not $meta.codexRuntimeAppServerVerified) { throw 'Native APK requires explicitly verified application execution metadata' }
} elseif ($NativeApp) { throw 'Native application APK must contain the official CLI' }
& $env:KXXY_NODE "$project\tools\verify-runtime.mjs" $Runtime
if ($LASTEXITCODE -ne 0) { throw 'Runtime verification failed; refusing to package' }
# APK 里那份 glibc 启动器模板必须是当前源码：设备侧自愈只认它（扩展池与 runtime.zip
# 两条分发路径在升级后的第一次启动上都可能是旧的）。漂移的后果不是构建报错，而是
# 「装上新 APK 后容器内 DNS 依旧不可用」，所以必须在这里拦住。
& $env:KXXY_NODE "$project\tools\sync-glibc-route-asset.mjs" --check
if ($LASTEXITCODE -ne 0) { throw 'APK glibc launcher asset out of sync; run node tools/sync-glibc-route-asset.mjs' }
if ($meta.pythonRuntimeRevision) {
    & $env:KXXY_NODE "$project\tools\verify-python-repair.mjs" $Runtime "$project\android\app\src\main\assets\python-repair" "$project\android\app\src\main\assets\meta\build.json"
    if ($LASTEXITCODE -ne 0) { throw 'Python offline repair assets do not match the runtime' }
}
if (($meta.PSObject.Properties.Name -contains 'dshUpgradeManifestSha256') -or ($meta.PSObject.Properties.Name -contains 'dshVersion')) {
    & $env:KXXY_NODE "$project\tools\verify-dsh-upgrade.mjs" $Runtime "$project\android\app\src\main\assets\dsh-upgrade" "$project\android\app\src\main\assets\meta\build.json"
    if ($LASTEXITCODE -ne 0) { throw 'DSH_UPGRADE_ASSETS_MISMATCH' }
}
Copy-Item -LiteralPath $Runtime -Destination (Join-Path $hold 'runtime.zip') -Force
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $Runtime) 'alias-links.txt') -Destination (Join-Path $hold 'alias-links.txt') -Force
& "$project\tools\build-apk.ps1" -Offline -Gradle $gradle
if ($LASTEXITCODE -ne 0) { throw 'APK build failed' }
if (-not (Test-Path -LiteralPath $apk)) { throw 'Build did not produce the requested version' }
& $env:KXXY_NODE "$project\tools\sign-apk.mjs" --check $apk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
& $env:KXXY_NODE "$project\tools\verify-startup-rescue-apk.mjs" $apk $Runtime --permissions
if ($LASTEXITCODE -ne 0) { throw 'APK native/runtime asset verification failed' }
$nativeArgs = @()
if ($NativeApp) { $nativeArgs += '--native-app' }
& $python -I -X utf8 "$project\tools\verify-codex-apk.py" $apk $Runtime --project $project --report $report @nativeArgs
if ($LASTEXITCODE -ne 0) { throw 'Packaged Codex sidebar source verification failed' }
if ($meta.pythonRuntimeRevision) {
    & $python -I -X utf8 "$project\tools\verify-python-apk.py" $apk $Runtime --project $project --report "$project\dist\Kxxy-$Version-python-verification.json"
    if ($LASTEXITCODE -ne 0) { throw 'Packaged Python repair verification failed' }
}
if (($meta.PSObject.Properties.Name -contains 'dshUpgradeManifestSha256') -or ($meta.PSObject.Properties.Name -contains 'dshVersion')) {
    & $python -I -X utf8 "$project\tools\verify-dsh-apk.py" $apk $Runtime --project $project --report "$project\dist\Kxxy-$Version-dsh-verification.json"
    if ($LASTEXITCODE -ne 0) { throw 'APK 内 DSH 升级资产验证失败' }
}
$sha = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$apk.sha256", "$sha`n", [Text.Encoding]::ASCII)
# 构建结果必须落盘：这是交付记录，缺了就得靠人回忆「这一版到底哪份 runtime 打的」。
New-Item -ItemType Directory -Force -Path $Backup | Out-Null
[IO.File]::WriteAllText((Join-Path $Backup 'codex-apk-result.json'), ((@{ apk = $apk; report = $report; version = $Version; versionCode = $VersionCode; sha256 = $sha; runtime = $Runtime; runtimeSha256 = $runtimeHash; nativeCodexIncluded = [bool]$meta.codexRuntimeIncluded; nativeExecutionMode = $meta.codexRuntimeExecutionMode; deviceInstalled = $false } | ConvertTo-Json) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Output "FINAL_APK=$apk"
Write-Output "SHA256=$sha"
Write-Output "VERIFICATION=$report"
