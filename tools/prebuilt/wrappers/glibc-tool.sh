#!/system/bin/sh
# [kxxy] __NAME__ —— 在 glibc 容器里运行 __LABEL__。
#
# 由「扩展中心 → glibc 用户态」安装时生成（模板：tools/prebuilt/wrappers/glibc-tool.sh），
# 双下划线包围的模板令牌都在构建/安装期替换，重装扩展会覆盖本文件。
#
# 为什么要垫一层：容器里的程序只有进了 proot 才有 glibc，直接 exec 会挂在
# `CANNOT LINK EXECUTABLE`。垫片把「首次要预置」这件事也一起做了，于是用户
# 拿到的就是一条普通命令：__NAME__ --version。
set -u

ROOT=@DSH_ROOT@
EXT="$ROOT/extensions/__EXT_ID__"
GC="$EXT/bin/kxxy-glibc"
PROV="$EXT/bin/kxxy-glibc-provision"
EXE=__EXE__

[ -x "$GC" ] || { echo "__NAME__: 缺 $GC（glibc 扩展没装全？）" >&2; exit 127; }

if ! "$GC" -c "test -x $EXE" >/dev/null 2>&1; then
  if [ "${KXXY_GLIBC_NO_AUTO:-0}" = "1" ]; then
    echo "__NAME__: 容器里还没有 __LABEL__，先执行：kxxy-glibc-provision __GROUP__" >&2
    exit 127
  fi
  echo "__NAME__: 首次使用，正在预置 __LABEL__（__HINT__，需要联网）…" >&2
  if ! "$PROV" __GROUP__; then
    echo "__NAME__: 预置失败。可重试：kxxy-glibc-provision __GROUP__" >&2
    exit 1
  fi
fi

exec "$GC" -- "$EXE" "$@"
