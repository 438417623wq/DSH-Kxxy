#!/system/bin/sh
# [kxxy] kxxy-glibc-provision —— 在 glibc 容器里预置常用工具（幂等）。
#
# 由「扩展中心 → glibc 用户态」安装时生成，占位符在安装时回填。
# 各工具的垫片（bin/julia、bin/dotnet、bin/wkhtmltopdf、bin/kxxy-py）在首次
# 使用时自动调本脚本，所以多数情况下**不需要手动跑**。
#
# 用法：
#   kxxy-glibc-provision julia           官方 aarch64 tarball → /opt/julia-1.11.7
#   kxxy-glibc-provision dotnet          apt install dotnet-sdk-8.0
#   kxxy-glibc-provision wkhtmltopdf     apt install wkhtmltopdf
#   kxxy-glibc-provision python-ml       apt python3-pip + pip 装 numpy/sklearn/cv2
#   kxxy-glibc-provision python-data     pip 装 pandas（约 12 MiB）
#   kxxy-glibc-provision python-torch    pip 装 torch（aarch64 轮子约 485 MiB）
#   kxxy-glibc-provision python-full     以上三者：让默认 python3 一个环境全都有
#   kxxy-glibc-provision base            只做 apt update + ca-certificates/curl
#   kxxy-glibc-provision all             以上全做
#
# 每个目标成功后在 <files>/glibc/.provisioned/ 下留一个标记，重复执行直接跳过。
# 想重来就删掉对应标记；想换 rootfs 用 KXXY_GLIBC_ROOTFS（透传给 kxxy-glibc）。
#
# julia / dotnet / wkhtmltopdf 三个有随扩展的离线包，断网也能装（装成功会删包，
# 想留着复用设 KXXY_PROVISION_KEEP=1）。KXXY_GLIBC_OFFLINE=1 时禁止一切联网：
# 缺本地包直接报「需要联网」，不会静默去下载。
set -u

ROOT=@DSH_ROOT@
FILES=@DSH_FILES@
GC="$ROOT/extensions/glibc/bin/kxxy-glibc"
EXT="$ROOT/extensions/glibc"
STAMP="$FILES/glibc/.provisioned"
# 随扩展一起装下来的离线包（构建期 `tools/fetch-provision-bundles.mjs` 产出）。
# 有本地包就不联网；没有才回退 apt / curl。
BUNDLES="$EXT/provision"
ROOTFS="${KXXY_GLIBC_ROOTFS:-$FILES/glibc/rootfs}"

# 离线模式：KXXY_GLIBC_OFFLINE=1 时禁止一切联网（apt / pip / 官方 tarball）。
# 缺本地包就直接报「缺少本地缓存」并返回非 0，不静默转去下载 —— 弱网下
# 285 MiB 的 julia 能挂十几分钟，看起来像脚本卡死。
# 离线可用的只有随扩展的 julia / dotnet / wkhtmltopdf 三个；python-* 需要网络。
OFFLINE="${KXXY_GLIBC_OFFLINE:-0}"

[ -x "$GC" ] || { echo "kxxy-glibc-provision: 缺 $GC（glibc 扩展没装全？）" >&2; exit 127; }
mkdir -p "$STAMP" || { echo "kxxy-glibc-provision: 无法创建 $STAMP" >&2; exit 1; }

# apt 在 fake root 下必须加这条：`_apt` 用户不存在，否则下载阶段 Permission denied
APT='-o APT::Sandbox::User=root'

# PyPI 在国内网络下经常几十 KB/s 且会反复重试；允许显式换镜像：
#   KXXY_PIP_INDEX=https://mirrors.aliyun.com/pypi/simple kxxy-glibc-provision python-full
PIP_INDEX="${KXXY_PIP_INDEX:-}"
if [ -n "$PIP_INDEX" ]; then
  echo "== pip 索引：$PIP_INDEX ==" >&2
  PIP_OPT="-i $PIP_INDEX"
else
  PIP_OPT=""
fi

# 容器里跑一段脚本；失败时把日志尾巴打出来（否则用户只看到 exit 1）
in_guest() {
  "$GC" -c "$1"
}

# 离线模式下要联网的路径：直接失败，并说清缺的是什么。
offline_fail() {
  echo "kxxy-glibc-provision: KXXY_GLIBC_OFFLINE=1，但$1需要联网" >&2
  echo "  → 离线模式只走随扩展的本地包（julia / dotnet / wkhtmltopdf 三个）。" >&2
  echo "  → python-ml / python-data / python-torch 需要网络；" >&2
  echo "    想离线用 Python 请直接用原生 python3（已自带 numpy/scipy/pandas/torch）。" >&2
  return 1
}

# 装成功后删掉用过的离线包：它们已经在扩展目录里占了 ~580 MiB，而装好的东西
# 落在 <files>/glibc/rootfs（扩展重装/APK 升级都不会丢）。想留着复用就
# KXXY_PROVISION_KEEP=1。删了也能恢复 —— 重装扩展会重新释放。
drop_bundle() {
  [ "${KXXY_PROVISION_KEEP:-0}" = "1" ] && return 0
  rm -f "$1" 2>/dev/null || true
  return 0
}

# 解开 rootfs（首次调用会解 base seed 约 1 分钟）。离线包要直接写进 rootfs，
# 所以必须先确保它已经解出来。
ensure_rootfs() {
  [ -x "$ROOTFS/bin/sh" ] && return 0
  in_guest 'true' >/dev/null 2>&1 || return 1
  [ -d "$ROOTFS/usr/bin" ] || { echo "kxxy-glibc-provision: rootfs 还没解出来（$ROOTFS）" >&2; return 1; }
  return 0
}

prov_base() {
  [ -f "$STAMP/base" ] && return 0
  [ "$OFFLINE" = "1" ] && { offline_fail " apt 源（base）"; return 1; }
  # DNS 预检：容器里没有 nameserver 时，apt 的报错是一条
  # `Temporary failure resolving 'ports.ubuntu.com'` 后面紧跟
  # `Unable to locate package curl` —— 后半句太像「软件源写错了」，
  # 于是排错全跑偏。先单独探一次，失败就直接说是 DNS。
  # 只用 `-s` 允许跳过：有人的实测环境是「DNS 不通、sources.list 里全是 IP」，
  # 那种情况下这条预检是误伤，`touch <stamp>/base` 就能放行。
  if ! in_guest 'command -v getent >/dev/null 2>&1 || exit 0
    getent hosts ports.ubuntu.com >/dev/null 2>&1'; then
    echo "kxxy-glibc-provision: 容器内 DNS 不可用（getent hosts ports.ubuntu.com 失败）" >&2
    echo "  → 容器 /etc/resolv.conf 没有可用的 nameserver；确认 kxxy-glibc 是否把" >&2
    echo "    <root>/etc/resolv.conf 挂进了 guest（见 kxxy-glibc.sh 的 pick 段）" >&2
    echo "  → 若你的软件源本来就是 IP 直连、确实不需要 DNS：" >&2
    echo "    touch \"$STAMP/base\" 跳过本项后再重跑" >&2
    return 1
  fi
  echo "== 准备容器：apt update + ca-certificates/curl ==" >&2
  in_guest 'export DEBIAN_FRONTEND=noninteractive
    apt-get update '"$APT"' >/tmp/kp-base.log 2>&1 || { tail -3 /tmp/kp-base.log >&2; exit 1; }
    apt-get install -y --no-install-recommends ca-certificates curl '"$APT"' >>/tmp/kp-base.log 2>&1 \
      || { tail -5 /tmp/kp-base.log >&2; exit 1; }' || return 1
  : > "$STAMP/base"
}

# prov_apt <包名> <标记名>
prov_apt() {
  [ -f "$STAMP/$2" ] && return 0
  echo "== apt install $1 ==" >&2
  in_guest "export DEBIAN_FRONTEND=noninteractive
    apt-get install -y --no-install-recommends $1 $APT >/tmp/kp-$2.log 2>&1 \
      || { tail -5 /tmp/kp-$2.log >&2; exit 1; }" || return 1
  : > "$STAMP/$2"
}

prov_julia() {
  [ -f "$STAMP/julia" ] && return 0
  # 标记丢了（扩展重装过、手动删过）但东西还在：确认一下就走，不必重解 285 MiB。
  if in_guest 'test -x /opt/julia-1.11.7/bin/julia' 2>/dev/null; then
    : > "$STAMP/julia"
    return 0
  fi
  if [ -f "$BUNDLES/julia-1.11.7-linux-aarch64.tar.gz" ]; then
    echo "== 安装 Julia 1.11.7（离线包，约 285 MiB）==" >&2
    ensure_rootfs || return 1
    mkdir -p "$ROOTFS/opt" || return 1
    tar -xzf "$BUNDLES/julia-1.11.7-linux-aarch64.tar.gz" -C "$ROOTFS/opt" || return 1
    in_guest '/opt/julia-1.11.7/bin/julia -e "println(\"julia \", VERSION)"' || return 1
    : > "$STAMP/julia"
    drop_bundle "$BUNDLES/julia-1.11.7-linux-aarch64.tar.gz"
    return 0
  fi
  [ "$OFFLINE" = "1" ] && { offline_fail " Julia（离线包已缺失）"; return 1; }
  prov_base || return 1
  echo "== 下载 Julia 1.11.7（约 285 MiB，单线程；离线包缺失才走这条路）==" >&2
  in_guest 'cd /tmp && rm -f julia.tgz \
    && curl -fL --retry 3 -o julia.tgz https://julialang-s3.julialang.org/bin/linux/aarch64/1.11/julia-1.11.7-linux-aarch64.tar.gz \
    && mkdir -p /opt && tar -xzf julia.tgz -C /opt && rm -f julia.tgz \
    && /opt/julia-1.11.7/bin/julia -e "println(\"julia \", VERSION)"' || return 1
  : > "$STAMP/julia"
}

# dotnet：离线包是微软官方 linux-arm64 SDK tarball（自带宿主，不依赖 apt）。
# 容器里没有 libicu，所以包装器固定 DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
# —— 否则 `dotnet --info` 会以 "Couldn't find a valid ICU package" 退出。
prov_dotnet() {
  [ -f "$STAMP/dotnet" ] && return 0
  # 已装（标记丢了）就先确认包装器在：wrapper 是判定 dotnet 可用的唯一入口。
  if in_guest 'test -x /usr/bin/dotnet' 2>/dev/null; then
    : > "$STAMP/dotnet"
    return 0
  fi
  if [ -f "$BUNDLES/dotnet-sdk-8.0.404-linux-arm64.tar.gz" ]; then
    echo "== 安装 .NET SDK 8.0.404（离线包，约 200 MiB）==" >&2
    ensure_rootfs || return 1
    mkdir -p "$ROOTFS/opt/dotnet" "$ROOTFS/usr/bin" || return 1
    tar -xzf "$BUNDLES/dotnet-sdk-8.0.404-linux-arm64.tar.gz" -C "$ROOTFS/opt/dotnet" || return 1
    cat > "$ROOTFS/usr/bin/dotnet" <<'DOTNET_WRAPPER'
#!/bin/sh
# [kxxy] .NET SDK 包装器：rootfs 里没有 libicu，固定 invariant 全球化模式。
export DOTNET_ROOT=/opt/dotnet
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
exec /opt/dotnet/dotnet "$@"
DOTNET_WRAPPER
    chmod 0755 "$ROOTFS/usr/bin/dotnet" || return 1
    in_guest 'dotnet --version' || return 1
    : > "$STAMP/dotnet"
    drop_bundle "$BUNDLES/dotnet-sdk-8.0.404-linux-arm64.tar.gz"
    return 0
  fi
  [ "$OFFLINE" = "1" ] && { offline_fail " .NET（离线包已缺失）"; return 1; }
  prov_base || return 1
  prov_apt dotnet-sdk-8.0 dotnet || return 1
  in_guest 'dotnet --version' || return 1
  : > "$STAMP/dotnet"
}

# wkhtmltopdf：离线包是「noble/arm64 全依赖闭包」的 .deb，一次 dpkg -i 装齐。
# 之所以不用 apt 装本地 deb：apt 解本地文件仍会去索引里找依赖，断网直接失败。
prov_wkhtmltopdf() {
  [ -f "$STAMP/wkhtmltopdf" ] && return 0
  if in_guest 'command -v wkhtmltopdf >/dev/null 2>&1' 2>/dev/null; then
    : > "$STAMP/wkhtmltopdf"
    return 0
  fi
  if [ -f "$BUNDLES/wkhtmltopdf-noble-arm64-debs.tar.gz" ]; then
    echo "== 安装 wkhtmltopdf 0.12.6 + 依赖（离线包）==" >&2
    ensure_rootfs || return 1
    rm -rf "$ROOTFS/tmp/kxxy-wkhtmltopdf"
    mkdir -p "$ROOTFS/tmp/kxxy-wkhtmltopdf" || return 1
    tar -xzf "$BUNDLES/wkhtmltopdf-noble-arm64-debs.tar.gz" -C "$ROOTFS/tmp/kxxy-wkhtmltopdf" || return 1
    # dpkg -i 的退出码不可全信：proot 里 postinst 会碰到取不到的 /proc、/dev
    # 或 locale 设置而返回非 0，但文件已经落盘、程序照样能跑。所以这里把
    # dpkg 的失败降级成警告，真正的判据交给下一行的 `wkhtmltopdf --version`。
    if ! in_guest 'export DEBIAN_FRONTEND=noninteractive
      dpkg -i --force-confold /tmp/kxxy-wkhtmltopdf/*.deb >/tmp/kp-wkhtmltopdf.log 2>&1'; then
      echo "wkhtmltopdf: dpkg 返回非 0（postinst 警告？），日志尾巴——" >&2
      in_guest 'tail -8 /tmp/kp-wkhtmltopdf.log' >&2 || true
    fi
    in_guest 'wkhtmltopdf --version' || return 1
    : > "$STAMP/wkhtmltopdf"
    rm -rf "$ROOTFS/tmp/kxxy-wkhtmltopdf"
    drop_bundle "$BUNDLES/wkhtmltopdf-noble-arm64-debs.tar.gz"
    return 0
  fi
  [ "$OFFLINE" = "1" ] && { offline_fail " wkhtmltopdf（离线包已缺失）"; return 1; }
  prov_base || return 1
  prov_apt wkhtmltopdf wkhtmltopdf || return 1
  in_guest 'wkhtmltopdf --version' || return 1
  : > "$STAMP/wkhtmltopdf"
}

prov_python() {
  # 已经有整套就跳过：apt 自带一个 numpy，但没有 sklearn/cv2
  if in_guest 'python3 -c "import sklearn, cv2" >/dev/null 2>&1' 2>/dev/null; then
    : > "$STAMP/python-ml"
    return 0
  fi
  [ "$OFFLINE" = "1" ] && { offline_fail " pip（python-ml）"; return 1; }
  prov_base || return 1
  prov_apt python3-pip python-pip || return 1
  echo "== pip 安装 numpy / scikit-learn / opencv-python-headless（manylinux 轮子）==" >&2
  in_guest "python3 -m pip install --break-system-packages --no-cache-dir -q $PIP_OPT \
    numpy scikit-learn opencv-python-headless" || return 1
  in_guest 'python3 -c "import numpy,sklearn,cv2;print(\"numpy\",numpy.__version__,\"sklearn\",sklearn.__version__,\"cv2\",cv2.__version__)"' || return 1
  : > "$STAMP/python-ml"
}

# 数据栈：pandas（约 12 MiB）
prov_pandas() {
  in_guest 'python3 -c "import pandas" >/dev/null 2>&1' && { : > "$STAMP/pandas"; return 0; }
  prov_python || return 1
  echo "== pip 安装 pandas ==" >&2
  in_guest "python3 -m pip install --break-system-packages --no-cache-dir -q $PIP_OPT pandas" || return 1
  in_guest 'python3 -c "import pandas;print(\"pandas\",pandas.__version__)"' || return 1
  : > "$STAMP/pandas"
}

# torch：必须用 PyTorch 官方 CPU 索引。
# 坑：PyPI 上 torch 2.15 的 linux aarch64 轮子是 CUDA 链接版（170→485 MiB），
# 装进去 `import torch` 直接 OSError: libcudart.so.13 —— 官方 CPU 索引的
# 同名轮子是纯 CPU（约 171 MiB，torch.version.cuda is None），才在这个容器里能用。
TORCH_INDEX="${KXXY_PIP_TORCH_INDEX:-https://download.pytorch.org/whl/cpu}"
prov_torch() {
  in_guest 'python3 -c "import torch" >/dev/null 2>&1' && { : > "$STAMP/torch"; return 0; }
  prov_python || return 1
  echo "== pip 安装 torch（CPU 轮子约 171 MiB，索引 $TORCH_INDEX）==" >&2
  in_guest "python3 -m pip install --break-system-packages --no-cache-dir -i $TORCH_INDEX torch" || return 1
  in_guest 'python3 -c "import torch;print(\"torch\",torch.__version__)"' || return 1
  : > "$STAMP/torch"
}

rc=0
if [ "$#" -eq 0 ]; then
  echo "用法：kxxy-glibc-provision <base|julia|dotnet|wkhtmltopdf|python-ml|python-data|python-torch|python-full|all>" >&2
  exit 2
fi
for want in "$@"; do
  case "$want" in
    base) prov_base ;;
    julia) prov_julia ;;
    dotnet) prov_dotnet ;;
    wkhtmltopdf) prov_wkhtmltopdf ;;
    python-ml) prov_python ;;
    python-data|pandas) prov_pandas ;;
    python-torch|torch) prov_torch ;;
    python-full|python)
      prov_python; [ "$?" -eq 0 ] || rc=1
      prov_pandas; [ "$?" -eq 0 ] || rc=1
      prov_torch; [ "$?" -eq 0 ] || rc=1
      if [ "$rc" -eq 0 ]; then
        in_guest 'python3 -c "import numpy,scipy,sklearn,cv2,pandas,torch as t;print(\"numpy\",numpy.__version__,\"scipy\",scipy.__version__,\"sklearn\",sklearn.__version__,\"cv2\",cv2.__version__,\"pandas\",pandas.__version__,\"torch\",t.__version__)"'
      fi ;;
    all)
      prov_julia
      prov_dotnet
      prov_wkhtmltopdf
      prov_python
      prov_pandas
      prov_torch
      ;;
    *) echo "kxxy-glibc-provision: 未知目标 $want" >&2; rc=2 ;;
  esac
  [ "$?" -eq 0 ] || rc=1
done
exit "$rc"
