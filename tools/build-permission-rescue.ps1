# Native-only permission rescue; reuse verified runtime and never install/clear device data.
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$env:KXXY_NODE = 'E:\deepseek-harness\deepseek-harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$env:JAVA_HOME = 'E:\deepseek-harness\XJZB\_toolchain\jdk-17.0.20.1+1'
$env:KXXY_JAVA = Join-Path $env:JAVA_HOME 'bin\java.exe'
$env:ANDROID_HOME = 'E:\deepseek-harness\XJZB\_toolchain\sdk'
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
$env:KXXY_VERSION_NAME = '0.9.30'
$env:KXXY_VERSION_CODE = '930000'
$gradle = 'E:\deepseek-harness\XJZB\_toolchain\gradle-8.10.2\bin\gradle.bat'
$apk = Join-Path $project 'dist\Kxxy-0.9.30.apk'
$runtime = Join-Path $project '.cache\apk-assets-hold\runtime.zip'
if (Test-Path -LiteralPath $apk) { throw 'Version 0.9.30 already exists; refusing to overwrite' }
foreach ($path in @($env:KXXY_NODE, $env:KXXY_JAVA, $gradle, $runtime)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing input: $path" }
}
$meta = Get-Content -LiteralPath "$project\android\app\src\main\assets\meta\build.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$runtimeHash = (Get-FileHash -LiteralPath $runtime -Algorithm SHA256).Hash.ToLowerInvariant()
if ($runtimeHash -ne $meta.runtimeSha256) { throw 'Runtime input differs from build metadata; refusing to package' }
$backup = Join-Path $project ('.cache\permission-rescue-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($rel in @('android\app\src\main\assets\meta\build.json', 'android\.kxxy-version-code-floor', 'android\app\build\outputs\apk\debug', '.cache\apk-backup')) {
    $src = Join-Path $project $rel
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $dest = Join-Path $backup $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dest -Recurse
}
Write-Output "BACKUP=$backup"
& $env:KXXY_NODE "$project\tools\verify-runtime.mjs" $runtime
if ($LASTEXITCODE -ne 0) { throw 'Runtime verification failed; refusing to package' }
& "$project\tools\build-apk.ps1" -Offline -Gradle $gradle
if ($LASTEXITCODE -ne 0) { throw 'APK build failed' }
& $env:KXXY_NODE "$project\tools\sign-apk.mjs" --check $apk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
& $env:KXXY_NODE "$project\tools\verify-startup-rescue-apk.mjs" $apk $runtime --permissions
if ($LASTEXITCODE -ne 0) { throw 'APK permission rescue verification failed' }
$hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$apk.sha256", "$hash`n", [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $backup 'build-result.json'), ((@{ apk = $apk; sha256 = $hash; backup = $backup; runtime = $runtime; runtimeSha256 = $runtimeHash } | ConvertTo-Json) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Output "FINAL_APK=$apk"
Write-Output "SHA256=$hash"
