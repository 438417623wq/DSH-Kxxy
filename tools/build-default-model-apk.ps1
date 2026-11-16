# 为「默认模型自愈」缺陷重打安装包（kxxy-host/lib/default-model.mjs）。
#
# 背景（2026-11-15 真机事故）：
#   上游 base 把 `agent-default-model` 写死成 `deepseek-official/deepseek-flash`，
#   而那条路由只认凭据库里的 `DEEPSEEK_API_KEY`；$DSH_HOME 一旦新建/重置，默认值
#   就落在这条从未配过的路由上，用户第一句话必报 MISSING_CREDENTIAL —— 哪怕他
#   已经配好了别的 provider 和可用的 key，只是默认选择没指过去（真机截图：硅基
#   流动可用，聊天却走 deepseek-official）。
#
# 本次改动只在自有插件 `plugins/kxxy-host`：
#   · lib/default-model.mjs（新增）—— 起步后自检默认选择，不可用就换成第一条真
#     能用的路由，并经官方 agentDefaultModel.saveSelection() 写回 profile 补丁；
#   · lib/index.js —— 挂上这个后台自愈任务。
#
# ⚠️ 不能靠热替换验证：`lib/index.js` 在 PYTHON_HOST_FILES 里，属于「受管修复
#    文件」，盘上内容与 APK 清单里的 sha256 不符时，原生层的 Python 离线修复会
#    直接判失败并停掉启动（实测：`既非期望内容，也不匹配显式previousSha256`）。
#    所以必须整包重编，让清单与指纹一起更新。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-default-model-apk.ps1
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot

# ── 本机工具链（与 build-startup-rescue.ps1 同源）────────────────────────
$env:KXXY_NODE = 'E:\deepseek-harness\deepseek-harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$env:JAVA_HOME = 'E:\deepseek-harness\XJZB\_toolchain\jdk-17.0.20.1+1'
$env:KXXY_JAVA = Join-Path $env:JAVA_HOME 'bin\java.exe'
$env:ANDROID_HOME = 'E:\deepseek-harness\XJZB\_toolchain\sdk'
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
$env:KXXY_VERSION_NAME = '0.9.54'
$env:KXXY_VERSION_CODE = '937018'
$gradle = 'E:\deepseek-harness\XJZB\_toolchain\gradle-8.10.2\bin\gradle.bat'
$apk = Join-Path $project 'dist\Kxxy-0.9.54.apk'

if (Test-Path -LiteralPath $apk) { throw 'Version 0.9.54 already exists; refusing to overwrite' }
foreach ($path in @($env:KXXY_NODE, $env:KXXY_JAVA, $gradle, "$project\.cache\stage\entries.json", "$project\.cache\app.asar", "$project\plugins\kxxy-host\lib\default-model.mjs")) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing input: $path" }
}

# ── 备份会被本次构建覆盖的输入 ───────────────────────────────────────────
$backup = Join-Path $project ('.cache\default-model-fix-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($rel in @('.cache\apk-assets-hold\runtime.zip', '.cache\apk-assets-hold\alias-links.txt', '.cache\build-meta.json', '.cache\manifest.json', 'android\app\src\main\assets\meta\build.json', 'android\.kxxy-version-code-floor', 'android\app\build\outputs\apk\debug')) {
    $src = Join-Path $project $rel
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $dest = Join-Path $backup $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dest -Recurse
}
Write-Output "BACKUP=$backup"

# ── 1) 重编运行时（新插件内容 + 新指纹 + 新修复清单 sha256）──────────────
$runtimeDir = Join-Path $backup 'new-runtime'
New-Item -ItemType Directory -Path $runtimeDir | Out-Null
$runtime = Join-Path $runtimeDir 'runtime.zip'
Write-Output '[1/4] build-runtime …'
& $env:KXXY_NODE --expose-gc --max-old-space-size=6144 "$project\tools\build-runtime.mjs" --stage "$project\.cache\stage" --asar "$project\.cache\app.asar" --plugins "$project\plugins" --out $runtime --manifest (Join-Path $runtimeDir 'manifest.json')
if ($LASTEXITCODE -ne 0) { throw 'Runtime build failed; previous inputs remain backed up' }

# ── 2) 锚点自检（十五锚点探针，防止「装完什么都没变」）──────────────────
Write-Output '[2/4] verify-runtime …'
& $env:KXXY_NODE "$project\tools\verify-runtime.mjs" $runtime
if ($LASTEXITCODE -ne 0) { throw 'Runtime verification failed; refusing to package' }

Copy-Item -LiteralPath $runtime -Destination "$project\.cache\apk-assets-hold\runtime.zip" -Force
Copy-Item -LiteralPath (Join-Path $runtimeDir 'alias-links.txt') -Destination "$project\.cache\apk-assets-hold\alias-links.txt" -Force

# ── 3) 小包 + 注入 + 对齐 + 签名 ─────────────────────────────────────────
Write-Output '[3/4] build-apk …'
& "$project\tools\build-apk.ps1" -Offline -Gradle $gradle
if ($LASTEXITCODE -ne 0) { throw 'APK build failed' }

# ── 4) 签名与产物核对 ────────────────────────────────────────────────────
Write-Output '[4/4] verify …'
$signed = Join-Path $project 'android\app\build\outputs\apk\debug\app-signed.apk'
& $env:KXXY_NODE "$project\tools\sign-apk.mjs" --check $signed
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }

Copy-Item -Force $signed $apk
$hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$apk.sha256", "$hash`n", [Text.Encoding]::ASCII)
Write-Output "FINAL_APK=$apk"
Write-Output "SHA256=$hash"
Write-Output ("SIZE={0}" -f (Get-Item $apk).Length)
