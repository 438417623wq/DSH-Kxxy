$ErrorActionPreference = 'Stop'
$P = Split-Path -Parent $PSScriptRoot
$env:KXXY_NODE = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$env:KXXY_PYTHON = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$env:JAVA_HOME = 'E:\deepseek-harness\XJZB\_toolchain\jdk-17.0.20.1+1'
$env:KXXY_JAVA = Join-Path $env:JAVA_HOME 'bin\java.exe'
$env:ANDROID_HOME = 'E:\deepseek-harness\XJZB\_toolchain\sdk'
$env:KXXY_VERSION_NAME = '0.9.25'
$env:KXXY_VERSION_CODE = '925000'
$gradle = 'E:\deepseek-harness\XJZB\_toolchain\gradle-8.10.2\bin\gradle.bat'
$validated = Join-Path $P '.cache\nvim-parser-validation-p1cuyn_4'
$backup = Join-Path $P ('.cache\apk-parser-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
if (Test-Path -LiteralPath $backup) { throw 'Backup directory already exists' }
if (Test-Path -LiteralPath "$P\dist\Kxxy-0.9.25.apk") { throw 'Version 0.9.25 already exists; refusing to overwrite it' }
foreach ($path in @($env:KXXY_NODE, $env:KXXY_PYTHON, $env:KXXY_JAVA, $gradle, "$validated\shells.pool")) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing build input: $path" }
}
$hold = Join-Path $P '.cache\apk-assets-hold'
if ((Get-ChildItem -LiteralPath $hold -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) {
  throw 'Asset hold is not empty; inspect it before replacing build resources'
}
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($rel in @(
  'android\app\build\outputs\apk\debug', 'dist\Kxxy-0.9.24.apk', 'dist\Kxxy-0.9.24.apk.sha256',
  'android\app\src\main\assets\runtime.zip', 'android\app\src\main\assets\alias-links.txt',
  'android\app\src\main\assets\ext-pool\shells.pool', 'android\app\src\main\assets\meta\build.json',
  '.cache\build-meta.json', '.cache\manifest.json', 'plugins\kxxy-host\extensions.json',
  'plugins\kxxy-host\web\theme.css', 'android\.kxxy-version-code-floor', '.cache\apk-backup'
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
$report = Get-Content -LiteralPath "$validated\report.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$item = @($report.items | Where-Object { $_.id -eq 'shells' })
if ($item.Count -ne 1) { throw 'Validated pool report has no unique shells item' }
$catalogPath = Join-Path $P 'plugins\kxxy-host\extensions.json'
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$shells = @($catalog.items | Where-Object { $_.id -eq 'shells' })
if ($shells.Count -ne 1) { throw 'Catalog has no unique shells item' }
$shells[0].sizeBytes = $item[0].totalBytes
$shells[0].fileCount = $item[0].files
[IO.File]::WriteAllText($catalogPath, (($catalog | ConvertTo-Json -Depth 20) + "`n"), [Text.UTF8Encoding]::new($false))
& $env:KXXY_NODE --expose-gc --max-old-space-size=6144 "$P\tools\build-runtime.mjs" `
  --stage "$P\.cache\stage" --asar "$P\.cache\app.asar" --plugins "$P\plugins" `
  --out $runtimeOut --manifest "$P\.cache\manifest.json"
if ($LASTEXITCODE -ne 0) { throw 'Runtime build failed; old resources remain backed up' }
Copy-Item -LiteralPath "$validated\shells.pool" -Destination "$P\android\app\src\main\assets\ext-pool\shells.pool" -Force
Copy-Item -LiteralPath $runtimeOut -Destination "$P\android\app\src\main\assets\runtime.zip" -Force
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $runtimeOut) 'alias-links.txt') -Destination "$P\android\app\src\main\assets\alias-links.txt" -Force
& "$P\tools\build-apk.ps1" -Offline -Gradle $gradle
if ($LASTEXITCODE -ne 0) { throw 'APK build failed' }
& $env:KXXY_NODE "$P\tools\sign-apk.mjs" --check "$P\dist\Kxxy-0.9.25.apk"
if ($LASTEXITCODE -ne 0) { throw 'Final APK signature check failed' }
$hash = (Get-FileHash -LiteralPath "$P\dist\Kxxy-0.9.25.apk" -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$P\dist\Kxxy-0.9.25.apk.sha256", "$hash`n", [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $backup 'build-result.json'), ((@{
  apk = "$P\dist\Kxxy-0.9.25.apk"; sha256 = $hash; backup = $backup; runtime = $runtimeOut
} | ConvertTo-Json) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Output "FINAL_APK=$P\dist\Kxxy-0.9.25.apk"
Write-Output "SHA256=$hash"
