<#
.SYNOPSIS
  构建期交叉编译 Android/arm64 的 `go` 命令（缺陷：go 无法拉取远程模块）。

.DESCRIPTION
  ── 症状 ──────────────────────────────────────────────────────────────────
  设备上 `go get github.com/google/uuid` 报：

      dial tcp: lookup goproxy.cn on [::1]:53: read udp ...: connection refused

  但同一台机器上 `curl` / `node` 联网都正常。

  ── 根因 ──────────────────────────────────────────────────────────────────
  扩展池里那份 `go` 二进制是 Termux 官方构建的，编译期把 resolv.conf 路径
  **写死**成 `/data/data/com.termux/files/usr/etc/resolv.conf`（47 字节，
  在该 ELF 里只出现 1 次，偏移 6862579）。本项目的运行时根是
  `<filesDir>/engine`（`/data/user/0/app.kxxy/files/engine`），那个 Termux
  路径在设备上不存在，于是 `dnsReadConfig()` 读不到文件、退到
  `net/dnsconfig.go` 的 `defaultNS = []string{"127.0.0.1:53", "[::1]:53"}`。

  本机恰好有 dnsmasq 监听这两个地址时「看起来能联网」—— 这就是同一个故障
  时好时坏的原因：dnsmasq 起着就解析成功，没起就 connection refused。
  `strace` 可以直接看到 `openat(... "/data/data/com.termux/files/usr/etc/
  resolv.conf", O_RDONLY) = -1 ENOENT`。

  ── 为什么不能在打包时改写二进制 ────────────────────────────────────────────
  `tools/build-runtime.mjs:369` 与 `tools/lib/poolextract.py:116` 都有硬约定
  「ELF 一律跳过」：占位符 `@DSH_ROOT@`（10 字节）比真实路径（36 字节）短，
  改动长度会让节偏移与重定位表整体错位。所以必须**源码期**把路径改对再编译。

  ── 做法 ──────────────────────────────────────────────────────────────────
  1. 官方 Windows 版 go1.27.2 当宿主（版本必须与 Termux 的 Go 完全一致，
     否则 `go build cmd/go` 会用宿主标准库而不是我们改过的 Termux 源码）；
  2. 叠加 Termux 的 Go 源码树 —— 官方 Windows 发行版删掉了 4 个
     android-only 文件（`net/dnsclient_android.go`、`net/conf_android.go`、
     `net/interface_android.go`、`syscall/netlink_android.go`），必须补回；
  3. 把 4 处 `@DSH_ROOT@` 换成设备上的真实引擎路径；
  4. `GOOS=android GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w"
     -o out/go-android cmd/go`；
  5. 硬校验二进制里的字面量（正确路径 = 1、旧 Termux 串 = 0、占位符 = 0）。

  产物 → `.cache\gotool\out\go-android`，由 `tools/lib/poolextract.py` 的
  `--go-binary` 参数替换进 `golang.pool` 的 `bin/go` 与 `lib/go/bin/go`。

  为什么必须 CGO_ENABLED=0：运行时没有 C 头文件/sysroot（实测设备上
  `fatal error: 'stdlib.h' file not found`），cgo 编不出来；而且 Go 的纯
  DNS 解析器（`netdns=go`）才是要修的那条路径，cgo 解析器走 bionic 的
  `getaddrinfo`，本来就正常。

.PARAMETER GoZip
  宿主 go 的 zip。默认 `.cache\gotool\go1.27.2.windows-amd64.zip`，缺了会下载。

.PARAMETER EngineRoot
  编译期写死的引擎根。默认按 `applicationId` 推出
  `/data/user/0/<applicationId>/files/engine`。

.PARAMETER Force
  忽略增量判定，强制重新编译。

.EXAMPLE
  pwsh -File tools\build-go-android.ps1
#>

param(
    [string]$GoZip = "",
    [string]$EngineRoot = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$Project = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$Project\tools\build-runtime.mjs")) {
    $Project = "F:\KF\DSKX\dsh-kxxy"
}
$Cache   = "$Project\.cache"
$Gotool  = "$Cache\gotool"
$OutDir  = "$Gotool\out"
$OutBin  = "$OutDir\go-android"
$HostRoot = "$Gotool\go"
$TermuxGo = "$Gotool\termux-go"
$BuildRoot = "$Gotool\build-android"

function Write-Step($n, $msg) { Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "      $msg" -ForegroundColor DarkGray }

# ── 0) 定位 Python（解 golang.pool 里的 Go 源码树）────────────────────────
function Find-Python {
    # 本脚本按 PowerShell 5.1 写（本机只有 5.1），所以不能用 `??` 空合并运算符。
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData) { $localAppData = "" }
    $userProfile = $env:USERPROFILE
    if (-not $userProfile) { $userProfile = "" }
    $candidates = @(
        $env:KXXY_PYTHON,
        "python",
        "python3",
        (Join-Path $localAppData "Programs\Python\Python312\python.exe"),
        "C:\Python312\python.exe",
        # DSH 自带运行时（本机常态：装了 Python 但不在 PATH）
        (Join-Path $userProfile ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe")
    ) | Where-Object { $_ }
    foreach ($c in $candidates) {
        # 裸名（"python"）不在 PATH 时 `& $c` 抛的是**终止性**错误
        # （CommandNotFoundException），不是普通非零退出，所以先解析再试跑。
        if (Test-Path $c) {
            $exe = $c
        } else {
            $cmd = Get-Command $c -ErrorAction SilentlyContinue
            if (-not $cmd) { continue }
            $exe = $cmd.Source
        }
        try {
            $probe = & $exe --version 2>&1
            if ($LASTEXITCODE -eq 0 -or "$probe" -match "^Python 3") { return $exe }
        } catch {
            continue
        }
    }
    throw "找不到 Python 解释器（试过：$($candidates -join ', ')）。解 golang.pool 需要 Python 的 tarfile+lzma。"
}

# ── 1) 引擎根：从 applicationId 推 ────────────────────────────────────────
Write-Step "1/7" "确定编译期写死的引擎根 …"
$gradleKts = "$Project\android\app\build.gradle.kts"
if (-not $EngineRoot) {
    if (-not (Test-Path $gradleKts)) { throw "找不到 $gradleKts，无法推断 applicationId" }
    $m = Select-String -Path $gradleKts -Pattern 'applicationId\s*=\s*"([^"]+)"' -Encoding UTF8 |
        Select-Object -First 1
    if (-not $m) { throw "build.gradle.kts 里没有 applicationId" }
    $appId = $m.Matches[0].Groups[1].Value
    # 注意不能拼 `/data/data/<id>`：那只是 `/data/user/0/<id>` 的兼容别名，
    # 而 `ctx.filesDir.absolutePath` 在设备上实测给出的是 `/data/user/0/...`。
    $EngineRoot = "/data/user/0/$appId/files/engine"
    Write-Ok "applicationId = $appId → $EngineRoot"
} else {
    Write-Ok "显式指定 → $EngineRoot"
}
if ($EngineRoot.Length -lt 20) { throw "EngineRoot 看着不对：$EngineRoot" }

New-Item -ItemType Directory -Force -Path $Gotool, $OutDir | Out-Null

# ── 2) 定位 Go 源码树的来源 ──────────────────────────────────────────────
#
# 优先 deb，其次 pool。**这个顺序不能反**：`golang.pool` 里那两份 `go` 二进制
# 正是本脚本的产物（poolextract.py 的 --go-binary 会覆盖它们），若从 pool 取
# 源码，就形成了「建池 → 要 go → 编 go → 要池」的死锁 —— 全新仓库第一次构建
# 时必然撞上。deb 里的 `lib/go/src` 与 pool 里的完全同源（Termux 同一版本），
# 只是前缀还没被 poolextract 改写成 @DSH_ROOT@（是原始 Termux 前缀），
# 第 6 步两种形态都认。
Write-Step "2/7" "定位 Go 源码树（deb 优先，pool 兜底）…"
$debCandidates = @()
if (Test-Path "$Cache\debs") {
    $debCandidates = Get-ChildItem "$Cache\debs\golang_*_aarch64.deb" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Select-Object -ExpandProperty FullName
}
$poolCandidates = @(
    "$Cache\apk-assets-hold\ext-pool\golang.pool",
    "$Project\android\app\src\main\assets\ext-pool\golang.pool"
)
$deb = $debCandidates | Select-Object -First 1
$pool = $poolCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $deb -and -not $pool) {
    throw ("既没有 golang deb 也没有 golang.pool。请先跑：" +
        "`n  node tools\fetch-runtime.mjs`n  node tools\fetch-extensions.mjs")
}
if ($deb) {
    $srcKind = "deb"
    $srcPath = $deb
    Write-Ok "deb = $deb（$([math]::Round((Get-Item $deb).Length/1MB,1)) MiB）"
    if ($pool) { Write-Ok "（pool 也存在，但按上面的理由不从这里取源码）" }
} else {
    $srcKind = "pool"
    $srcPath = $pool
    Write-Ok "pool = $pool（$([math]::Round((Get-Item $pool).Length/1MB,1)) MiB，无 deb 可用）"
}

# ── 3) 解出 Go 源码树（幂等）──────────────────────────────────────────────
Write-Step "3/7" "解出 Termux Go 源码树（$srcKind）…"
$py = Find-Python
$extractScript = Join-Path $env:TEMP "kxxy_extract_gosrc.py"
# 两种来源的成员名前缀不同：deb 是 `./data/data/com.termux/files/usr/lib/go/...`，
# pool 是 `lib/go/...`（相对 Termux usr）。脚本按 basename 找 lib/go 起点，
# 因此两边都能吃。
@'
import io, os, sys, tarfile

src, kind, out = sys.argv[1], sys.argv[2], sys.argv[3]
MARK = "lib/go/"
want = ("src/", "go.env", "VERSION")


def open_tar():
    """返回 (tarfile 对象, 需要清理的临时对象列表)。"""
    if kind == "deb":
        with open(src, "rb") as fh:
            data = fh.read()
        if not data.startswith(b"!<arch>\n"):
            raise SystemExit("不是 ar 归档：%s" % src)
        off = 8
        while off + 60 <= len(data):
            hdr = data[off:off + 60]
            name = hdr[0:16].decode("ascii", "replace").strip()
            size = int(hdr[48:58].decode("ascii", "replace").strip())
            body = data[off + 60:off + 60 + size]
            if name.startswith("data.tar"):
                buf = io.BytesIO(body)
                return tarfile.open(fileobj=buf, mode="r:xz"), [buf]
            off += 60 + size + (size % 2)
        raise SystemExit("deb 里没有 data.tar 成员")
    return tarfile.open(src, "r:gz"), []


def rel_of(name):
    """把成员名归一成 `lib/go/` 之后的相对路径；不在 lib/go 下返回 None。"""
    idx = name.find(MARK)
    if idx < 0:
        return None
    rel = name[idx + len(MARK):]
    if not rel or not any(rel == w.rstrip("/") or rel.startswith(w) for w in want):
        return None
    return rel


t, extra = open_tar()
n = 0
try:
    for m in t:
        rel = rel_of(m.name)
        if rel is None:
            continue
        dest = os.path.join(out, rel)
        if m.isdir():
            os.makedirs(dest, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if m.issym():
            if os.path.lexists(dest):
                os.remove(dest)
            os.symlink(m.linkname, dest)
            n += 1
            continue
        if m.islnk():
            linked = rel_of(m.linkname)
            target = os.path.join(out, linked) if linked else None
            if target and os.path.exists(target):
                if os.path.lexists(dest):
                    os.remove(dest)
                os.link(target, dest)
                n += 1
            continue
        fh = t.extractfile(m)
        if fh is None:
            continue
        with open(dest, "wb") as f:
            f.write(fh.read())
        os.chmod(dest, 0o755 if (m.mode & 0o100) else 0o644)
        n += 1
finally:
    t.close()
    for x in extra:
        x.close()

print("      extracted %d entries" % n)
'@ | Set-Content -Path $extractScript -Encoding UTF8

$needExtract = $true
if (Test-Path "$TermuxGo\src\cmd\go\main.go") {
    # 版本号探测也要认两种来源（deb 的成员名带 Termux 前缀）。
    $verProbe = @'
import io, sys, tarfile
src, kind = sys.argv[1], sys.argv[2]
if kind == "deb":
    data = open(src, "rb").read()
    off = 8
    while off + 60 <= len(data):
        hdr = data[off:off + 60]
        name = hdr[0:16].decode("ascii", "replace").strip()
        size = int(hdr[48:58].decode("ascii", "replace").strip())
        body = data[off + 60:off + 60 + size]
        if name.startswith("data.tar"):
            t = tarfile.open(fileobj=io.BytesIO(body), mode="r:xz")
            break
        off += 60 + size + (size % 2)
    else:
        raise SystemExit("no data.tar")
else:
    t = tarfile.open(src, "r:gz")
for m in t:
    if m.name.endswith("lib/go/VERSION"):
        print(t.extractfile(m).read().decode().strip().splitlines()[0])
        break
'@
    $verScript = Join-Path $env:TEMP "kxxy_gosrc_ver.py"
    Set-Content -Path $verScript -Value $verProbe -Encoding UTF8
    $srcVer = (& $py $verScript $srcPath $srcKind 2>&1) -join ""
    $localVer = if (Test-Path "$TermuxGo\VERSION") { (Get-Content "$TermuxGo\VERSION" -Encoding UTF8 | Select-Object -First 1) } else { "" }
    if ("$srcVer".Trim() -eq "$localVer".Trim() -and $localVer) {
        $needExtract = $false
        Write-Ok "已就绪（$localVer），跳过解包"
    } else {
        Write-Ok "版本不一致（源=$srcVer 本地=$localVer），重新解包"
    }
}
if ($needExtract) {
    if (Test-Path $TermuxGo) { Remove-Item -Recurse -Force $TermuxGo }
    New-Item -ItemType Directory -Force -Path $TermuxGo | Out-Null
    & $py $extractScript $srcPath $srcKind $TermuxGo
    if ($LASTEXITCODE -ne 0) { throw "解 Go 源码树失败（exit $LASTEXITCODE）" }
}
$goVersion = (Get-Content "$TermuxGo\VERSION" -Encoding UTF8 | Select-Object -First 1).Trim()
Write-Ok "Go 版本 = $goVersion"

# ── 4) 宿主 Go（版本必须与 Termux 一致）──────────────────────────────────
Write-Step "4/7" "准备宿主 Go（$goVersion windows/amd64）…"
$hostGoExe = "$HostRoot\bin\go.exe"
if (-not (Test-Path $hostGoExe)) {
    if (-not $GoZip) { $GoZip = "$Gotool\$goVersion.windows-amd64.zip" }
    if (-not (Test-Path $GoZip)) {
        $url = "https://go.dev/dl/$goVersion.windows-amd64.zip"
        Write-Ok "下载 $url …"
        New-Item -ItemType Directory -Force -Path $Gotool | Out-Null
        # Invoke-WebRequest 的进度条会让 79 MB 下载慢一个数量级
        $prev = $ProgressPreference
        $ProgressPreference = "SilentlyContinue"
        try { Invoke-WebRequest -Uri $url -OutFile $GoZip -UseBasicParsing }
        finally { $ProgressPreference = $prev }
    }
    Write-Ok "解压 $([math]::Round((Get-Item $GoZip).Length/1MB,1)) MiB …"
    if (Test-Path $HostRoot) { Remove-Item -Recurse -Force $HostRoot }
    # Windows 10+ 自带 bsdtar，认 zip，比 Expand-Archive 快得多
    & tar -xf $GoZip -C $Gotool
    if ($LASTEXITCODE -ne 0) {
        Expand-Archive -Path $GoZip -DestinationPath $Gotool -Force
    }
    if (-not (Test-Path $hostGoExe)) { throw "宿主 go 解压后仍找不到：$hostGoExe" }
}
$hostVer = (& $hostGoExe version 2>&1)
if ("$hostVer" -notmatch [regex]::Escape($goVersion)) {
    throw "宿主 Go 版本不匹配：$hostVer（要求 $goVersion）。版本不一致会让 go build 用宿主标准库而非改过的 Termux 源码。"
}
Write-Ok "$hostVer"

# ── 5) 组装 build-android = 宿主 GOROOT + Termux 源码 ─────────────────────
Write-Step "5/7" "组装交叉编译 GOROOT（宿主 + Termux src）…"
$stamp = "$BuildRoot\.kxxy-src-stamp"
$srcStamp = "$TermuxGo\VERSION|$EngineRoot"
$needAssemble = $Force -or -not (Test-Path "$BuildRoot\src\net\dnsclient_android.go") -or
    -not (Test-Path $stamp) -or ((Get-Content $stamp -Raw -ErrorAction SilentlyContinue) -ne $srcStamp)
if ($needAssemble) {
    if (Test-Path $BuildRoot) { Remove-Item -Recurse -Force $BuildRoot }
    Write-Ok "复制宿主 GOROOT → build-android（15,000+ 文件，约 1 分钟）…"
    # robocopy 的退出码 0–7 都是成功（1 = 有文件被复制）
    & robocopy $HostRoot $BuildRoot /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（exit $LASTEXITCODE）" }
    Write-Ok "叠加 Termux src …"
    & robocopy "$TermuxGo\src" "$BuildRoot\src" /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy(src) 失败（exit $LASTEXITCODE）" }
    Copy-Item -Force "$TermuxGo\go.env" "$BuildRoot\go.env"
    Copy-Item -Force "$TermuxGo\VERSION" "$BuildRoot\VERSION"
    Set-Content -Path $stamp -Value $srcStamp -NoNewline -Encoding UTF8
    Write-Ok "组装完成"
} else {
    Write-Ok "已组装（stamp 一致），跳过"
}

# ── 6) 打补丁：把占位符（或原始 Termux 前缀）换成真实引擎路径 ─────────────
Write-Step "6/7" "改写 Go 源码里的前缀 → $EngineRoot …"
# 这 4 个文件是 Termux 相对上游 Go 的全部**运行时**补丁（其余命中都是
# .sh/.bash 的 shebang，与 go 命令行为无关，且不会被编进二进制）：
#   · net/dnsclient_android.go  —— resolv.conf 路径（本缺陷的根因，2 处）
#   · net/conf_android.go       —— mdns.allow 探测（路径错只会退回 cgo，无害）
#   · os/file_unix.go           —— tempDir() 的兜底（TMPDIR 已由 EngineConfig 设置）
#   · crypto/x509/root_linux.go —— Termux 的 CA bundle
#
# 两种来源的前缀形态不同，都要认：
#   · deb 里的源码是**原始 Termux 前缀** `/data/data/com.termux/files/usr`
#   · pool 里的源码已被 poolextract 改写成占位符 `@DSH_ROOT@`
$patched = @(
    "src\net\dnsclient_android.go",
    "src\net\conf_android.go",
    "src\os\file_unix.go",
    "src\crypto\x509\root_linux.go"
)
$fromPrefixes = @('@DSH_ROOT@', '/data/data/com.termux/files/usr')
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
foreach ($rel in $patched) {
    $f = Join-Path $BuildRoot $rel
    if (-not (Test-Path $f)) { throw "缺文件：$f" }
    $text = [IO.File]::ReadAllText($f)
    $total = 0
    foreach ($p in $fromPrefixes) {
        $hits = ([regex]::Matches($text, [regex]::Escape($p))).Count
        if ($hits -eq 0) { continue }
        $text = $text.Replace($p, $EngineRoot)
        $total += $hits
    }
    if ($total -eq 0) {
        if ($text.Contains($EngineRoot)) { Write-Ok "$rel 已是目标路径，跳过"; continue }
        throw "$rel 里既没有占位符也没有原始 Termux 前缀 —— 源码形态变了？"
    }
    [IO.File]::WriteAllText($f, $text, $utf8NoBom)
    Write-Ok ("{0}: {1} 处 → {2}" -f $rel, $total, $EngineRoot)
}

# ── 7) 交叉编译 ──────────────────────────────────────────────────────────
Write-Step "7/7" "交叉编译 cmd/go（GOOS=android GOARCH=arm64 CGO_ENABLED=0）…"
$env:GOROOT = $BuildRoot
$env:GOOS = "android"
$env:GOARCH = "arm64"
$env:CGO_ENABLED = "0"
$env:GOTOOLCHAIN = "local"
$env:GOCACHE = "$Gotool\gocache"
# 显式清掉可能从外部环境漏进来的交叉编译污染（CC_FOR_TARGET / GOARM / GOAMD64 等）
foreach ($v in @("GOARM", "GO386", "GOAMD64", "GOEXPERIMENT", "GOFLAGS")) {
    Remove-Item "env:$v" -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $env:GOCACHE | Out-Null

$sw = [Diagnostics.Stopwatch]::StartNew()
Push-Location "$BuildRoot\src"
try {
    # ── 两个必须同时给的编译期开关 ────────────────────────────────────────
    #
    # `-trimpath`：让 `cmd/link/internal/ld/main.go:183-189` 走「`buildcfg.GOROOT`
    # 为空 ⇒ 不写 `runtime.defaultGOROOT`」那条分支。不加的话链接器会把**宿主**
    # GOROOT（`F:\KF\DSKX\...\.cache\gotool\build-android`）烧进二进制 —— 真机上
    # 表现为 `go: cannot find GOROOT directory: F:\KF\DSKX\dsh-kxxy\.cache\gotooluild-android`
    # （注意 `\b` 被当成退格符，路径里的 `build-android` 少了首字母）。
    #
    # `-X runtime.defaultGOROOT=<设备路径>`：`-trimpath` 之后默认值是空串，而
    # `go` 会靠 `os.Executable()` 上溯两级猜 GOROOT。设备上 `go` 有两个入口：
    #   · `<root>/lib/go/bin/go` → 上溯两级正好是 `<root>/lib/go`，猜得对；
    #   · `<root>/bin/go`（PATH 里的那个，软链到 `extensions/golang/bin/go`）
    #     → 上溯两级是 `extensions/golang`，**不是** GOROOT，猜错。
    # 所以必须把设备路径显式写死，不能依赖运行时推导。
    #
    # 代价：这个路径把 `applicationId` 编码进了二进制，换包名就得重编。
    # 本项目的 `applicationId` 是固定的 `app.kxxy`（无 `applicationIdSuffix`），
    # 且脚本第 1 步就是从 `build.gradle.kts` 读它，所以这条依赖是显式的。
    & $hostGoExe build -trimpath `
        -ldflags="-s -w -X runtime.defaultGOROOT=$EngineRoot/lib/go" `
        -o $OutBin cmd/go 2>&1 | Select-Object -First 40
    $rc = $LASTEXITCODE
} finally { Pop-Location }
$sw.Stop()
if ($rc -ne 0) { throw "交叉编译失败（exit $rc）" }
Write-Ok ("编译完成：{0:N0} B，耗时 {1:N1}s" -f (Get-Item $OutBin).Length, $sw.Elapsed.TotalSeconds)

# ── 校验：字面量必须真的落在二进制里 ─────────────────────────────────────
Write-Host ""
Write-Host "字面量校验（这是判断修没修的唯一标准）：" -ForegroundColor Yellow
$bytes = [IO.File]::ReadAllBytes($OutBin)
# PowerShell 5.1 没有 [Text.Encoding]::Latin1 这个静态属性（会静默返回 $null，
# 后面的 Matches 就报「不能对 Null 值表达式调用方法」），所以显式取 iso-8859-1。
$latin = [Text.Encoding]::GetEncoding("iso-8859-1").GetString($bytes)
$checks = @(
    @{ Name = "目标路径 <root>/etc/resolv.conf"; Needle = "$EngineRoot/etc/resolv.conf"; Want = 1 },
    @{ Name = "旧 Termux resolv.conf";          Needle = "/data/data/com.termux/files/usr/etc/resolv.conf"; Want = 0 },
    @{ Name = "@DSH_ROOT@ 残留";                Needle = "@DSH_ROOT@"; Want = 0 },
    @{ Name = "默认 linker64";                  Needle = "/system/bin/linker64"; Want = 1 },
    # 缺陷 DE：宿主路径绝不能漏进产物。`-trimpath` 之前链接器会把 Windows 的
    # GOROOT 烧进 `runtime.defaultGOROOT`，真机上报
    # `go: cannot find GOROOT directory: F:\...\gotooluild-android`
    # （`\b` 被当退格符吃掉）。这条断言是那种「不加就静默失败」的防线。
    @{ Name = "宿主构建目录残留";                Needle = "build-android"; Want = 0 },
    @{ Name = "设备 GOROOT 默认值";              Needle = "$EngineRoot/lib/go"; Want = 1 }
)
$bad = @()
foreach ($c in $checks) {
    $n = ([regex]::Matches($latin, [regex]::Escape($c.Needle))).Count
    $ok = if ($c.Want -eq 0) { $n -eq 0 } else { $n -ge $c.Want }
    $mark = if ($ok) { "OK  " } else { "FAIL" }
    Write-Host ("  [{0}] {1,-34} 命中 {2}" -f $mark, $c.Name, $n) -ForegroundColor $(if ($ok) { "Green" } else { "Red" })
    if (-not $ok) { $bad += $c.Name }
}
if ($bad.Count) {
    throw "字面量校验未通过：$($bad -join ', ')。产物不可用，不要打包。"
}

# ELF 头与架构再确认一次（防呆：编成 windows/amd64 也会「编译成功」）
$magic = ($bytes[0..3] | ForEach-Object { $_.ToString("x2") }) -join ""
$machine = [BitConverter]::ToUInt16($bytes, 18)
if ($magic -ne "7f454c46") { throw "产物不是 ELF（magic=$magic）" }
if ($machine -ne 0xB7) { throw ("产物不是 AArch64（e_machine=0x{0:x4}）" -f $machine) }
Write-Host ("  [OK  ] ELF/AArch64  magic={0} e_machine=0x{1:x4}" -f $magic, $machine) -ForegroundColor Green

Write-Host ""
Write-Host "完成：$OutBin" -ForegroundColor Green
Write-Host ("      {0:N0} B（{1:N2} MiB），引擎根写死为 {2}" -f (Get-Item $OutBin).Length, ((Get-Item $OutBin).Length / 1MB), $EngineRoot) -ForegroundColor Green
Write-Host ""
Write-Host "下一步（把它装进扩展池）：" -ForegroundColor Yellow
Write-Host "  `$env:KXXY_POOL_ONLY='golang'; node tools\fetch-extensions.mjs"
