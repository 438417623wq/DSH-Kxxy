#!/usr/bin/env python3
"""Explicit Magisk/root bridge for operations blocked in the Android app domain.

This is never used implicitly. The caller opts in through a KXXY_*_ROOT=1 wrapper
or invokes bin/kxxy-root directly. Arguments are shell-quoted for su -c and the
root process receives a small, fixed environment instead of caller-controlled
PYTHONPATH/LD_PRELOAD/etc.
"""

import os
import shlex
import subprocess
import sys


OPERATIONS = frozenset(("ln", "perf", "rsync", "exec"))


def engine_root():
    return os.path.realpath(os.path.join(os.path.dirname(__file__), "..", ".."))


def target_command(root, operation, args):
    if operation == "ln":
        return [os.path.join(root, "bin", "coreutils"), "--coreutils-prog=ln"] + list(args)
    if operation == "perf":
        return [os.path.join(root, "bin", "python"), "-I",
                os.path.join(root, "libexec", "kxxy-tools", "perf.py")] + list(args)
    if operation == "rsync":
        return [os.path.join(root, "bin", "rsync")] + list(args)
    if operation == "exec":
        args = list(args)
        # `bin/kxxy-root` 和文档里的 `kxxy-root.py exec -- cmd` 两种写法都会
        # 带 `--`；重复的也一并剥掉，否则 `--` 会被当成要执行的命令。
        while args and args[0] == "--":
            args = args[1:]
        if not args:
            raise ValueError("kxxy-root: missing command")
        return args
    raise ValueError("kxxy-root: unsupported operation " + operation)


def root_environment(root, operation, owner):
    env = {
        "HOME": "/",
        "PATH": os.path.join(root, "bin") + ":/system/bin",
        "LD_LIBRARY_PATH": os.path.join(root, "lib"),
        "KXXY_ROOT_OWNER": owner,
    }
    if operation == "perf":
        # Explicit root perf means real perf_event_open. Never substitute ptrace.
        env["KXXY_PERF_MODE"] = "pmu"
    return env


def su_shell_command(root, operation, args, owner):
    python = os.path.join(root, "bin", "python")
    script = os.path.join(root, "libexec", "kxxy-tools", "kxxy-root.py")
    command = ["env", "-i"]
    command += [key + "=" + value
                for key, value in root_environment(root, operation, owner).items()]
    command += [python, "-I", script, "--root-active", operation] + list(args)
    return "exec " + shlex.join(command)


def main(args=None):
    args = sys.argv[1:] if args is None else list(args)
    active = bool(args and args[0] == "--root-active")
    if active:
        args = args[1:]
    if not args or args[0] not in OPERATIONS:
        sys.stderr.write("usage: kxxy-root.py [--root-active] ln|perf|rsync|exec [args...]\n")
        return 2
    operation, rest = args[0], args[1:]
    try:
        command = target_command(engine_root(), operation, rest)
    except ValueError as ex:
        sys.stderr.write(str(ex) + "\n")
        return 2

    root = engine_root()
    owner = os.environ.get("KXXY_ROOT_OWNER", f"{os.getuid()}:{os.getgid()}")
    if os.geteuid() == 0:
        env = root_environment(root, operation, owner)
        try:
            os.execvpe(command[0], command, env)
        except OSError as ex:
            sys.stderr.write("kxxy-root: cannot execute " + command[0] + ": " + str(ex) + "\n")
            return 127 if isinstance(ex, FileNotFoundError) else 126
    if active:
        sys.stderr.write("kxxy-root: su returned a non-root process; refusing recursion\n")
        return 1

    su = os.environ.get("KXXY_SU", "/system/bin/su")
    if not os.path.isabs(su):
        sys.stderr.write("kxxy-root: KXXY_SU must be an absolute path\n")
        return 2
    shell_command = su_shell_command(root, operation, rest, owner)
    sys.stderr.write(
        "kxxy-root: 显式提权执行 " + operation +
        "；如 Magisk 询问，请仅授权可信的 app.kxxy。\n")
    try:
        return subprocess.call([su, "-c", shell_command])
    except OSError as ex:
        sys.stderr.write("kxxy-root: cannot execute su: " + str(ex) + "\n")
        return 127 if isinstance(ex, FileNotFoundError) else 126


if __name__ == "__main__":
    sys.exit(main())
