$ErrorActionPreference = 'Stop'
$P = Split-Path -Parent $PSScriptRoot
$env:KXXY_NODE = 'E:\deepseek-harness\deepseek-harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$env:JAVA_HOME = 'E:\deepseek-harness\XJZB\_toolchain\jdk-17.0.20.1+1'
$env:KXXY_JAVA = Join-Path $env:JAVA_HOME 'bin\java.exe'
$env:ANDROID_HOME = 'E:\deepseek-harness\XJZB\_toolchain\sdk'
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
$env:KXXY_VERSION_NAME = '0.9.28'
$env:KXXY_VERSION_CODE = '928000'
$gradle = 'E:\deepseek-harness\XJZB\_toolchain\gradle-8.10.2\bin\gradle.bat'
foreach ($path in @($env:KXXY_NODE, $env:KXXY_JAVA, $gradle, "$P\.cache\stage\entries.json", "$P\.cache\app.asar")) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing input: $path" }
}
if (Test-Path -LiteralPath "$P\dist\Kxxy-0.9.28.apk") { throw 'Version 0.9.28 already exists; refusing to overwrite' }
$backup = Join-Path $P ('.cache\install-fix-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($rel in @(
  '.cache\apk-assets-hold\runtime.zip', '.cache\apk-assets-hold\alias-links.txt',
  '.cache\build-meta.json', '.cache\manifest.json', 'plugins\kxxy-host\web\theme.css',
  'android\app\src\main\assets\meta\build.json', 'android\.kxxy-version-code-floor',
  'android\app\build\outputs\apk\debug', '.cache\apk-backup'
)) {
  $src = Join-Path $P $rel
  if (-not (Test-Path -LiteralPath $src)) { continue }
  $dest = Join-Path $backup $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Copy-Item -LiteralPath $src -Destination $dest -Recurse
}
Write-Output "BACKUP=$backup"
$runtimeOut = Join-Path $backup 'new-runtime\runtime.zip'
New-Item -ItemType Directory -Path (Split-Path -Parent $runtimeOut) | Out-Null
& $env:KXXY_NODE --expose-gc --max-old-space-size=6144 "$P\tools\build-runtime.mjs" `
  --stage "$P\.cache\stage" --asar "$P\.cache\app.asar" --plugins "$P\plugins" `
  --out $runtimeOut --manifest (Join-Path $backup 'new-runtime\manifest.json')
if ($LASTEXITCODE -ne 0) { throw 'Runtime build failed; previous inputs remain backed up' }
& $env:KXXY_NODE "$P\tools\verify-runtime.mjs" $runtimeOut
if ($LASTEXITCODE -ne 0) { throw 'Runtime verification failed; refusing to package' }
Copy-Item -LiteralPath $runtimeOut -Destination "$P\.cache\apk-assets-hold\runtime.zip" -Force
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $runtimeOut) 'alias-links.txt') -Destination "$P\.cache\apk-assets-hold\alias-links.txt" -Force
& "$P\tools\build-apk.ps1" -Offline -Gradle $gradle
if ($LASTEXITCODE -ne 0) { throw 'APK build failed' }
$apk = "$P\dist\Kxxy-0.9.28.apk"
& $env:KXXY_NODE "$P\tools\sign-apk.mjs" --check $apk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
$hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$apk.sha256", "$hash`n", [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $backup 'build-result.json'), ((@{
  apk = $apk; sha256 = $hash; backup = $backup; runtime = $runtimeOut
} | ConvertTo-Json) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Output "FINAL_APK=$apk"
Write-Output "SHA256=$hash"
