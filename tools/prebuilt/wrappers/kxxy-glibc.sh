#!/system/bin/sh
# kxxy-glibc: launch the installed Ubuntu userland in proot.
# Existing invocations may unpack the seed; default Python uses --require-ready.
# --guest-env NAME VALUE is a narrow, explicit env -i protocol, never shell text.
set -u
ROOT=@DSH_ROOT@
FILES=@DSH_FILES@
EXT="$ROOT/extensions/glibc"
DATA="$FILES/glibc"
SEED="$EXT/rootfs/ubuntu-base.tgz"
ROOTFS="${KXXY_GLIBC_ROOTFS:-$DATA/rootfs}"
WD=/root
REQUIRE_READY=0
GUEST_HOME=/root
GUEST_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
GUEST_VENV=""
die() { echo "kxxy-glibc: $*" >&2; exit 1; }
usage() {
  printf '%s\n' 'kxxy-glibc [-b HOST[:GUEST]] [-w DIR] [--require-ready] [-- COMMAND ...]' \
    'kxxy-glibc -c COMMAND' '--guest-env {HOME|PATH|VIRTUAL_ENV} VALUE'
}

# Queue invariant: REMAINING unparsed CLI arguments, followed by BIND_COUNT
# accumulated bind arguments. Rotate quoted argv elements, not a BINDS string.
# Counts are authoritative; user values (even spaces/newlines/option-like text)
# cannot become delimiters or shell code.
REMAINING="$#"
BIND_COUNT=0
while [ "$REMAINING" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -b|--bind)
      [ "$REMAINING" -ge 2 ] || die '-b requires HOST[:GUEST]'
      VALUE="$2"; shift 2
      set -- "$@" -b "$VALUE"
      BIND_COUNT="$((BIND_COUNT + 2))"; REMAINING="$((REMAINING - 2))" ;;
    --bind=*)
      VALUE="${1#--bind=}"; shift
      set -- "$@" -b "$VALUE"
      BIND_COUNT="$((BIND_COUNT + 2))"; REMAINING="$((REMAINING - 1))" ;;
    -w|--workdir)
      [ "$REMAINING" -ge 2 ] || die '-w requires a directory'
      WD="$2"; shift 2; REMAINING="$((REMAINING - 2))" ;;
    --workdir=*) WD="${1#--workdir=}"; shift; REMAINING="$((REMAINING - 1))" ;;
    --require-ready) REQUIRE_READY=1; shift; REMAINING="$((REMAINING - 1))" ;;
    --guest-env)
      [ "$REMAINING" -ge 3 ] || die '--guest-env requires NAME VALUE'
      case "$2" in
        HOME) case "$3" in /*) GUEST_HOME="$3" ;; *) die 'guest HOME must be absolute' ;; esac ;;
        PATH) GUEST_PATH="$3" ;;
        VIRTUAL_ENV) case "$3" in /*) GUEST_VENV="$3" ;; *) die 'guest VIRTUAL_ENV must be absolute' ;; esac ;;
        *) die "unsupported guest environment key: $2" ;;
      esac
      shift 3; REMAINING="$((REMAINING - 3))" ;;
    -c)
      [ "$REMAINING" -ge 2 ] || die '-c requires a command'
      VALUE="$2"
      while [ "$REMAINING" -gt 0 ]; do shift; REMAINING="$((REMAINING - 1))"; done
      set -- "$@" /bin/sh -c "$VALUE"
      break ;;
    --)
      shift; REMAINING="$((REMAINING - 1))"
      # CLI command currently precedes binds. Rotate it behind the binds.
      while [ "$REMAINING" -gt 0 ]; do
        VALUE="$1"; shift; set -- "$@" "$VALUE"; REMAINING="$((REMAINING - 1))"
      done
      break ;;
    *)
      while [ "$REMAINING" -gt 0 ]; do
        VALUE="$1"; shift; set -- "$@" "$VALUE"; REMAINING="$((REMAINING - 1))"
      done
      break ;;
  esac
done
# Queue now consists of binds followed by the command.
[ "$#" -gt "$BIND_COUNT" ] || set -- "$@" /bin/bash -l
COMMAND_COUNT="$(($# - BIND_COUNT))"

[ -x "$ROOT/bin/proot" ] || die "missing proot: $ROOT/bin/proot"
PROOT_LOADER="$ROOT/libexec/proot/loader"
[ -f "$PROOT_LOADER" ] || die "missing proot loader: $PROOT_LOADER"
if [ ! -f "$ROOTFS/.kxxy-seed" ]; then
  [ "$REQUIRE_READY" -eq 0 ] || die 'glibc rootfs is not ready; initialize the installed glibc extension explicitly'
  [ -f "$SEED" ] || die "missing rootfs seed: $SEED"
  command -v tar >/dev/null 2>&1 || die 'missing tar'
  echo "kxxy-glibc: extracting rootfs → $ROOTFS ..." >&2
  mkdir -p "$ROOTFS" || die "cannot create $ROOTFS"
  if ! tar -xzf "$SEED" -C "$ROOTFS"; then
    rm -f "$ROOTFS/.kxxy-seed"; die 'rootfs extraction failed'
  fi
  : > "$ROOTFS/.kxxy-seed" || die 'cannot write rootfs marker'
fi
[ -x "$ROOTFS/bin/sh" ] || [ -L "$ROOTFS/bin" ] || die 'incomplete rootfs'
mkdir -p "$DATA/tmp" || die "cannot create $DATA/tmp"
export PROOT_TMP_DIR="$DATA/tmp" PROOT_LOADER
[ -f "$ROOT/libexec/proot/loader32" ] && export PROOT_LOADER_32="$ROOT/libexec/proot/loader32"
export LD_LIBRARY_PATH="$ROOT/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
unset LD_PRELOAD

# Move binds behind the command, append ordinary defaults and env -i, then move
# the command to the very end. Each value remains exactly one argv element.
COUNT="$BIND_COUNT"
while [ "$COUNT" -gt 0 ]; do
  VALUE="$1"; shift; set -- "$@" "$VALUE"; COUNT="$((COUNT - 1))"
done
set -- "$@" -b /dev -b /proc -b /sys
[ ! -d /storage ] || set -- "$@" -b /storage:/storage
[ ! -d /sdcard ] || set -- "$@" -b /sdcard:/sdcard
[ ! -d "$FILES" ] || set -- "$@" -b "$FILES:/mnt/kxxy"
if [ -f /system/etc/resolv.conf ]; then
  set -- "$@" -b /system/etc/resolv.conf:/etc/resolv.conf
elif [ -f /etc/resolv.conf ]; then
  set -- "$@" -b /etc/resolv.conf:/etc/resolv.conf
fi
set -- "$@" -w "$WD" /usr/bin/env -i "HOME=$GUEST_HOME" "TERM=${TERM:-xterm-256color}" \
  LANG=C.UTF-8 "PATH=$GUEST_PATH" DEBIAN_FRONTEND=noninteractive
[ -z "$GUEST_VENV" ] || set -- "$@" "VIRTUAL_ENV=$GUEST_VENV"
COUNT="$COMMAND_COUNT"
while [ "$COUNT" -gt 0 ]; do
  VALUE="$1"; shift; set -- "$@" "$VALUE"; COUNT="$((COUNT - 1))"
done
# Fake root and link emulation remain unchanged for apt/dpkg and existing tools.
exec "$ROOT/bin/proot" -r "$ROOTFS" -0 --link2symlink "$@"
