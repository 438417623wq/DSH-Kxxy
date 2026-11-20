#!/system/bin/sh
# [kxxy] kxxy-glibc —— 在 proot 里启动 glibc 用户态（未改动的 Ubuntu base rootfs）。
#
# 由「扩展中心 → glibc 用户态（Ubuntu 24.04）」安装时生成，重装扩展会覆盖本文件。
# 构建期只有占位符（@DSH_ROOT@ / @DSH_FILES@），安装时由 extinstall 回填成真实路径。
#
# 为什么需要它：Android 应用域跑的是 bionic，PyPI 的 manylinux 轮子、julia、
# dotnet、wkhtmltopdf 这类只有 glibc 构件的工具在这里一律起不来。proot 用
# ptrace 做路径/系统调用转译，不需要 root 也不需要内核模块，能在同一个
# uid 里跑一份完整 Ubuntu 用户态 —— 代价是每条 syscall 多一层转发。
#
# 用法：
#   kxxy-glibc                          进入登录 shell（bash）
#   kxxy-glibc -c 'apt-get update'      跑一条命令
#   kxxy-glibc -- /usr/bin/python3 -V    跑一个程序（参数原样透传）
#   kxxy-glibc -b /sdcard:/mnt/sd -- ls /mnt/sd
#   kxxy-glibc -w /kxxy -- ls           进容器后先 cd 到指定目录
#
# 首次运行会把 rootfs 种子解包到 <files>/glibc/rootfs（约 1 分钟、80 MB），
# 之后 apt 装的包都留在那里；重装扩展或升级 APK 都不会动它（不在 engine 目录下）。
#
# 已绑定：/dev /proc /sys、共享存储（/storage /sdcard，存在才绑）、
#         /system/etc/resolv.conf → /etc/resolv.conf（否则容器内没有 DNS），
#         <files> → /mnt/kxxy（工作区文件直通）。
#
# 注意：apt 在 fake root 下要加 `-o APT::Sandbox::User=root`，否则
#       `_apt` 用户不存在会导致下载阶段报 Permission denied。
set -u

ROOT=@DSH_ROOT@
FILES=@DSH_FILES@
EXT="$ROOT/extensions/glibc"
DATA="$FILES/glibc"
SEED="$EXT/rootfs/ubuntu-base.tgz"
ROOTFS="${KXXY_GLIBC_ROOTFS:-$DATA/rootfs}"

die() { echo "kxxy-glibc: $*" >&2; exit 1; }

usage() {
  sed -n 's/^# \{0,1\}//p' "$0" 2>/dev/null | sed -n '/^用法：/,/^注意：/p' | sed '$d'
}

BINDS=""
WD=/root
CMD=""
MODE=shell

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -b|--bind)
      [ "$#" -ge 2 ] || die "-b 需要一个 <宿主路径>[:<容器路径>] 参数"
      BINDS="$BINDS -b $2"; shift 2 ;;
    --bind=*)   BINDS="$BINDS -b ${1#--bind=}"; shift ;;
    -w|--workdir)
      [ "$#" -ge 2 ] || die "-w 需要一个目录参数"
      WD="$2"; shift 2 ;;
    --workdir=*) WD="${1#--workdir=}"; shift ;;
    -c)
      [ "$#" -ge 2 ] || die "-c 需要一条命令"
      MODE=cmd; CMD="$2"; shift 2; break ;;
    --) shift; break ;;
    *) break ;;
  esac
done

# ── 运行期依赖：proot 与它的 loader 都在引擎里（预装，不在扩展内）─────────
[ -x "$ROOT/bin/proot" ] || die "引擎里没有 proot：$ROOT/bin/proot"
PROOT_LOADER="$ROOT/libexec/proot/loader"
[ -f "$PROOT_LOADER" ] || die "缺 proot loader：$PROOT_LOADER"
command -v tar >/dev/null 2>&1 || die "引擎里没有 tar，无法解包 rootfs 种子"

# ── 首次运行：解 seed（rootfs 是一个不透明的 tar.gz，不能在构建期解成文件树）──
#
# 为什么不在池里直接放解开的文件树：设备端的解包器
# （plugins/kxxy-host/lib/tar.mjs）会**跳过符号链接**，而这个 rootfs 有 194 条
# 软链（`/bin -> usr/bin`、`/lib -> usr/lib`、`/usr/bin/awk -> mawk`…），
# 丢了软链的 rootfs 是废的。作一个 blob 放进来、交给设备上的 GNU tar 解，
# 软链与权限位都由 tar 自己处理，构建期只需要保证**没有硬链**（tarderef.py）。
if [ ! -f "$ROOTFS/.kxxy-seed" ]; then
  [ -f "$SEED" ] || die "缺少 rootfs 种子：$SEED（扩展没装全？）"
  echo "kxxy-glibc: 首次运行，解包 rootfs → $ROOTFS（约 1 分钟）..." >&2
  mkdir -p "$ROOTFS" || die "无法创建 $ROOTFS"
  if ! tar -xzf "$SEED" -C "$ROOTFS"; then
    rm -f "$ROOTFS/.kxxy-seed"
    die "rootfs 解包失败（磁盘空间不足？）"
  fi
  : > "$ROOTFS/.kxxy-seed" || die "无法写入 $ROOTFS/.kxxy-seed"
  echo "kxxy-glibc: rootfs 就绪。" >&2
fi
[ -x "$ROOTFS/bin/sh" ] || [ -L "$ROOTFS/bin" ] || die "rootfs 不完整：$ROOTFS 里没有 /bin/sh"

# ── 绑定与容器环境 ──────────────────────────────────────────────────────
BINDS="$BINDS -b /dev -b /proc -b /sys"
[ -d /storage ] && BINDS="$BINDS -b /storage:/storage"
[ -d /sdcard ] && BINDS="$BINDS -b /sdcard:/sdcard"
[ -d "$FILES" ] && BINDS="$BINDS -b $FILES:/mnt/kxxy"
if [ -f /system/etc/resolv.conf ]; then
  BINDS="$BINDS -b /system/etc/resolv.conf:/etc/resolv.conf"
elif [ -f /etc/resolv.conf ]; then
  BINDS="$BINDS -b /etc/resolv.conf:/etc/resolv.conf"
fi

# proot 自己要在可写目录里展开 loader 的临时件；不能给 /data/local/tmp
mkdir -p "$DATA/tmp" || die "无法创建 $DATA/tmp"
export PROOT_TMP_DIR="$DATA/tmp"
export PROOT_LOADER
[ -f "$ROOT/libexec/proot/loader32" ] && export PROOT_LOADER_32="$ROOT/libexec/proot/loader32"

# proot 自己带着 bionic 依赖（libtalloc / libandroid-shmem），必须能按引擎的
# lib 目录找到它们：真机实测裸跑 `bin/proot --version` 直接
# `CANNOT LINK EXECUTABLE: library "libtalloc.so.2" not found`。
# 但宿主的 preload（libkxxy_exec.so）对它没用，且会跟着 ptrace 一起进 tracee，
# 所以只摘 preload —— tracee 的环境最终由 `env -i` 整套重建，不会污染 glibc 程序。
export LD_LIBRARY_PATH="$ROOT/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
unset LD_PRELOAD

# -0        fake root（apt/dpkg 需要 uid 0 的假象）
# --link2symlink  容器内的 link(2) 一律降级成软链（应用域建不出硬链）
# -w        进容器后的 cwd
run_guest() {
  exec "$ROOT/bin/proot" -r "$ROOTFS" -0 --link2symlink $BINDS -w "$WD" \
    /usr/bin/env -i \
      HOME=/root \
      TERM="${TERM:-xterm-256color}" \
      LANG=C.UTF-8 \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      DEBIAN_FRONTEND=noninteractive \
      "$@"
}

if [ "$MODE" = cmd ]; then
  run_guest /bin/sh -c "$CMD"
fi
if [ "$#" -gt 0 ]; then
  run_guest "$@"
fi
run_guest /bin/bash -l
