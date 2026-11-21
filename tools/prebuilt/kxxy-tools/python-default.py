"""Native bionic dispatcher for bare Python. No downloads, package probes or installs.

The shell shims invoke absolute engine/bin/python -I. Only this control program
runs natively; user Python and pip arguments run unchanged in an already-ready
Ubuntu rootfs. Host venv shims are overlaid with their saved guest executables
inside proot, so guest sys.executable/subprocess never re-enter bionic Python.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
import stat
import struct
import subprocess
import sys

GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PRIVATE = Path("libexec/kxxy")
MARKER = "python-default.json"
ALIAS = re.compile(r"(?:python(?:3(?:\.\d+)?)?|pip(?:3(?:\.\d+)?)?)\Z")


class DispatchError(Exception):
    pass


def fail(message):
    raise DispatchError(message)


def plain_file(path):
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except OSError:
        return False


def elf(path):
    if not plain_file(path):
        return False
    with path.open("rb") as stream:
        return stream.read(4) == b"\x7fELF"


def guest_file(rootfs, name):
    """Resolve rootfs symlinks in guest coordinates, never the host's /usr."""
    todo = list(PurePosixPath(name).parts)[1:]
    parts = []
    links = 0
    while todo:
        part = todo.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        current = rootfs.joinpath(*parts, part)
        if current.is_symlink():
            links += 1
            if links > 40:
                fail("rootfs Python symlink loop")
            target = os.readlink(current)
            if target.startswith("/"):
                parts = []
            todo = [p for p in PurePosixPath(target).parts if p != "/"] + todo
        else:
            parts.append(part)
    return rootfs.joinpath(*parts)


def require_ready(root, files, env):
    rootfs = Path(env.get("KXXY_GLIBC_ROOTFS") or files / "glibc/rootfs")
    if not rootfs.is_absolute():
        fail("KXXY_GLIBC_ROOTFS must be an absolute path")
    if not (rootfs / ".kxxy-seed").is_file():
        fail("glibc rootfs is not ready; install/initialize the glibc extension explicitly, then run kxxy-glibc-provision python-ml if Python is missing (nothing was downloaded)")
    if not elf(guest_file(rootfs, "/usr/bin/python3")):
        fail("glibc Python is missing; run kxxy-glibc-provision python-ml explicitly (no automatic provisioning)")
    for path in (root / "bin/proot", root / "libexec/python-default/kxxy-glibc"):
        if not path.is_file() or not os.access(path, os.X_OK):
            fail("missing runtime helper: " + str(path))
    if not (root / "libexec/proot/loader").is_file():
        fail("missing runtime proot loader")
    return rootfs


def bind_arg(host, guest=None):
    host = str(host)
    guest = str(guest if guest is not None else host)
    # Colon is proot's bind grammar and cannot be represented as a literal path.
    if ":" in host or ":" in guest or not os.path.isabs(host):
        fail("cannot safely bind this path: " + host)
    return ["-b", host + ":" + guest]


def host_environment(root, env):
    out = dict(env)
    # Native proot needs only bionic libraries, never inherited glibc/preloads.
    for key in list(out):
        if key.startswith("LD_") or key.startswith("DYLD_") or key.startswith("PYTHON"):
            out.pop(key, None)
    out["LD_LIBRARY_PATH"] = str(root / "lib")
    out["PATH"] = str(root / "bin") + ":/system/bin"
    return out


def managed_venv(venv):
    private = venv / PRIVATE
    marker = private / MARKER
    if not plain_file(marker):
        fail("not a prepared kxxy glibc venv: " + str(venv))
    if private.is_symlink() or (venv / "bin").is_symlink():
        fail("venv executable directory must not be a symlink")
    try:
        record = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        fail("invalid glibc venv marker")
    if record.get("schema") != 1 or record.get("venv") != str(venv):
        fail("venv was moved or its marker is invalid; recreate it at the desired path")
    aliases = record.get("aliases", [])
    if not isinstance(aliases, list) or "python" not in aliases or len(set(aliases)) != len(aliases):
        fail("invalid glibc venv aliases")
    overlays = []
    for name in aliases:
        if not isinstance(name, str) or not ALIAS.fullmatch(name):
            fail("invalid glibc venv executable name")
        saved = private / name
        if not plain_file(saved) or (name.startswith("python") and not elf(saved)):
            fail("missing saved glibc venv executable: " + name)
        overlays.extend(bind_arg(saved, venv / "bin" / name))
    if not plain_file(venv / "pyvenv.cfg"):
        fail("glibc venv pyvenv.cfg is missing")
    return overlays


def guest_command(root, files, cwd, env, arguments, venv=None, extra_binds=()):
    require_ready(root, files, env)
    cwd = Path(cwd).absolute()
    cmd = [str(root / "libexec/python-default/kxxy-glibc"), "--require-ready", "-w", str(cwd)]
    # Preserve absolute app/workspace paths. Never rewrite arbitrary user argv.
    # cwd gets its own binding even when outside app files (shared workspaces).
    seen = set()
    for host in (files.absolute(), cwd, root.absolute()):
        if str(host) not in seen:
            cmd.extend(bind_arg(host))
            seen.add(str(host))
    if venv is not None:
        if str(venv) not in seen:
            cmd.extend(bind_arg(venv))
        cmd.extend(managed_venv(venv))
    cmd.extend(extra_binds)
    cmd.extend(["--guest-env", "HOME", "/root", "--guest-env", "PATH",
                (str(venv / "bin") + ":" if venv is not None else "") + GUEST_PATH])
    if venv is not None:
        cmd.extend(["--guest-env", "VIRTUAL_ENV", str(venv)])
    cmd.extend(["--", str(venv / "bin/python") if venv is not None else "/usr/bin/python3"])
    cmd.extend(arguments)
    return cmd, host_environment(root, env)


def bionic_elf(path):
    """PT_INTERP, not an arbitrary embedded string, identifies Android's loader."""
    try:
        data = path.resolve().read_bytes()
        if data[:6] != b"\x7fELF\x02\x01" or len(data) < 64:
            return False
        offset = struct.unpack_from("<Q", data, 32)[0]
        size, count = struct.unpack_from("<HH", data, 54)
        if size < 56 or offset + size * count > len(data):
            return False
        for index in range(count):
            at = offset + index * size
            if struct.unpack_from("<I", data, at)[0] == 3:
                start = struct.unpack_from("<Q", data, at + 8)[0]
                length = struct.unpack_from("<Q", data, at + 32)[0]
                return data[start:start + length].rstrip(b"\0") in (b"/system/bin/linker", b"/system/bin/linker64")
    except (OSError, ValueError, struct.error):
        pass
    return False


def selected_python(env):
    return next((os.path.join(directory, "python") for directory in env.get("PATH", "").split(os.pathsep)
                 if directory and os.path.isfile(os.path.join(directory, "python"))
                 and os.access(os.path.join(directory, "python"), os.X_OK)), None)


def native_activation(root, env):
    """Honor a genuinely PATH-selected bionic venv; VIRTUAL_ENV alone is not enough."""
    value = env.get("VIRTUAL_ENV")
    if not value:
        return None
    venv = Path(value).absolute()
    if (venv / PRIVATE / MARKER).exists():
        return None
    selected = selected_python(env)
    if not selected or Path(selected).absolute().parent != venv / "bin":
        return None
    if not (venv / "pyvenv.cfg").is_file() or not bionic_elf(Path(selected)):
        return None
    return selected


def venv_request(arguments, wanted="venv"):
    """Recognize CPython's module CLI, not -c/script content or script args.

    Parse standard short-option clusters as well (-IBmvenv). Unknown switches
    preceding venv are rejected conservatively, never passed through to create
    an apparently successful but unprepared host venv.
    """
    prefix = []
    i = 0
    unknown = False
    while i < len(arguments):
        arg = arguments[i]
        if arg == "--" or not arg.startswith("-") or arg == "-":
            return None
        if arg == "--check-hash-based-pycs":
            if i + 1 >= len(arguments):
                return None
            prefix.extend(arguments[i:i + 2]); i += 2
            continue
        if arg.startswith("--check-hash-based-pycs="):
            prefix.append(arg); i += 1
            continue
        if arg.startswith("--"):
            unknown = True
            prefix.append(arg); i += 1
            continue
        cluster = arg[1:]
        j = 0
        while j < len(cluster):
            option = cluster[j]
            if option == "c":
                return None
            if option == "m":
                module = cluster[j + 1:] or (arguments[i + 1] if i + 1 < len(arguments) else "")
                if module != wanted:
                    return None
                if unknown:
                    fail("unsupported Python interpreter option preceding -m venv")
                end = i + 1 if cluster[j + 1:] else i + 2
                return prefix, arguments[end:]
            if option in "WX":
                value = cluster[j + 1:]
                if value:
                    prefix.extend(["-" + option, value])
                elif i + 1 < len(arguments):
                    i += 1
                    prefix.extend(["-" + option, arguments[i]])
                else:
                    return None
                break
            if option in "bBdEiIOPqRsSuvVx":
                prefix.append("-" + option)
            else:
                unknown = True
                prefix.append("-" + option)
            j += 1
        i += 1
    return None


def venv_options(options, cwd):
    # Reject destructive/upgrading/network/ambiguous options before mkdir or GC.
    allowed = {"--system-site-packages", "--copies", "--without-pip"}
    forward, targets = [], []
    i = 0
    positional = False
    while i < len(options):
        value = options[i]
        if not positional and value == "--":
            positional = True
        elif not positional and value in allowed:
            forward.append(value)
        elif not positional and value in ("--prompt",):
            i += 1
            if i >= len(options):
                fail("venv --prompt requires a value")
            forward.extend([value, options[i]])
        elif not positional and value.startswith("--prompt="):
            forward.append(value)
        elif not positional and value.startswith("-"):
            fail("default glibc venv supports fresh targets, --copies, --without-pip, --system-site-packages and --prompt only; unsupported option: " + value)
        else:
            target = Path(os.path.abspath(os.path.join(str(cwd), value)))
            # Canonicalize the existing parent (Android /data/data -> /data/user/0
            # is normal), but never follow/overwrite an existing target symlink.
            if os.path.lexists(target):
                fail("refusing to overwrite an existing venv target: " + str(target))
            if not target.parent.is_dir():
                fail("venv requires an existing parent: " + str(target.parent))
            target = target.parent.resolve() / target.name
            bind_arg(target)
            if "\n" in str(target) or "\r" in str(target):
                fail("venv target must not contain newlines (activation script limitation)")
            if os.path.lexists(target):
                fail("refusing to overwrite an existing venv target: " + str(target))
            targets.append(target)
        i += 1
    if not targets:
        fail("venv requires at least one fresh target directory")
    if len(set(targets)) != len(targets) or any(a in b.parents or b in a.parents for i, a in enumerate(targets) for b in targets[i + 1:]):
        fail("venv targets must be distinct and non-nested")
    if "--copies" not in forward:
        forward.append("--copies")
    return forward, targets


def identity(path):
    info = path.lstat()
    return info.st_dev, info.st_ino


def validate_fresh(venv, token):
    if venv.is_symlink() or identity(venv) != token:
        fail("fresh venv directory changed during creation")
    for name in ("bin", "lib"):
        if (venv / name).is_symlink() or not (venv / name).is_dir():
            fail("fresh venv has an unsafe " + name + " directory")
    config = venv / "pyvenv.cfg"
    if not plain_file(config):
        fail("guest venv did not produce a regular pyvenv.cfg")
    # Read before modifying anything guest-generated. No preexisting user files
    # may be edited: the target was exclusively created by this invocation.
    text = config.read_text(encoding="utf-8")
    if not re.search(r"^home\s*=\s*/usr/bin\s*$", text, re.M):
        fail("unexpected glibc venv base interpreter; cannot prepare safely")
    aliases = {}
    for path in (venv / "bin").iterdir():
        if ALIAS.fullmatch(path.name):
            if not plain_file(path):
                fail("guest --copies venv produced a non-regular executable: " + path.name)
            data = path.read_bytes()
            if path.name.startswith("python") and not data.startswith(b"\x7fELF"):
                fail("guest venv Python is not an ELF executable")
            if path.name.startswith("pip") and b"pip" not in data:
                fail("guest venv pip script is unexpected")
            aliases[path.name] = data
    if "python" not in aliases or "python3" not in aliases:
        fail("guest venv did not create python/python3 aliases")
    if (venv / "libexec").exists():
        fail("guest venv unexpectedly contains libexec")
    return aliases


def launcher(root, venv, command):
    return ("#!/system/bin/sh\n# Host launcher for the saved glibc venv interpreter.\nexec "
            + shlex.quote(str(root / "bin/python")) + " -I "
            + shlex.quote(str(root / "libexec/python-default/python-default.py"))
            + " --venv " + shlex.quote(str(venv)) + " --command "
            + shlex.quote(command) + ' -- "$@"\n').encode("utf-8")


def prepare_venv(root, venv, token):
    aliases = validate_fresh(venv, token)
    private = venv / PRIVATE
    private.mkdir(parents=True, mode=0o700)
    for name, data in aliases.items():
        path = venv / "bin" / name
        # Reject a concurrent replacement rather than overwrite unexamined data.
        if not plain_file(path) or path.read_bytes() != data:
            fail("venv executable changed during preparation: " + name)
        path.rename(private / name)
        with path.open("xb") as stream:
            stream.write(launcher(root, venv, "pip" if name.startswith("pip") else "python"))
        path.chmod(0o755)
    record = {"schema": 1, "venv": str(venv), "aliases": sorted(aliases)}
    with (private / MARKER).open("x", encoding="utf-8") as stream:
        json.dump(record, stream)
        stream.write("\n")
    return aliases


def wait_command(command, env):
    # Inherit the actual handles, including pipes and interactive stdin.
    result = subprocess.run(command, env=env)
    return result.returncode


def create_venvs(root, files, cwd, env, arguments, request, active=None):
    prefix, options = request
    if active is not None:
        fail("creating a nested glibc venv from an activated venv is unsupported; deactivate it first")
    forward, targets = venv_options(options, cwd)
    if "-S" in prefix:
        fail("-S -m venv is not supported by the default glibc host-venv preparation")
    # Validate runtime, cwd, binds and every target before any filesystem changes.
    require_ready(root, files, env)
    for target in targets:
        guest_command(root, files, cwd, env, [], active, bind_arg(target.parent))
    for target in targets:
        target.mkdir(mode=0o700)
        token = identity(target)
        command, child_env = guest_command(root, files, cwd, env,
                                           prefix + ["-m", "venv"] + forward + ["--", str(target)],
                                           active, bind_arg(target))
        rc = wait_command(command, child_env)
        if rc:
            return rc  # Leave guest diagnostics and partial files; never fake success.
        prepare_venv(root, target, token)
        # Probe in the guest, with file overlays, including guest subprocess. This
        # is real execution only on device; Windows tests mock this call explicitly.
        probe = "import subprocess,sys; assert sys.prefix == " + repr(str(target)) + "; subprocess.check_call([sys.executable,'-c','import sys; assert sys.prefix == ' + repr(sys.prefix)])"
        command, child_env = guest_command(root, files, cwd, env, ["-c", probe], target)
        rc = wait_command(command, child_env)
        if rc:
            fail("prepared venv failed its guest interpreter/subprocess probe; creation is not successful")
    return 0


def dispatch(root, files, cwd, env, command, arguments, explicit_venv=None, execute=True):
    native = native_activation(root, env) if explicit_venv is None else None
    if native:
        argv = [native] + (["-m", "pip"] if command.startswith("pip") else []) + arguments
        if execute:
            os.execve(native, argv, dict(env))
        return argv, dict(env)
    venv = Path(explicit_venv).absolute() if explicit_venv else None
    if venv is None and env.get("VIRTUAL_ENV"):
        candidate = Path(env["VIRTUAL_ENV"]).absolute()
        selected = selected_python(env)
        if ((candidate / PRIVATE / MARKER).is_file() and selected
                and Path(selected).absolute().parent == candidate / "bin"):
            venv = candidate
    python_args = (["-m", "pip"] if command.startswith("pip") else []) + arguments
    if venv is not None:
        if venv_request(python_args, "ensurepip") is not None:
            fail("ensurepip maintenance in a host-prepared glibc venv is unsupported; recreate the fresh venv instead")
        pip_request = venv_request(python_args, "pip")
        if pip_request is not None:
            # Pip can atomically replace the bound host pip launchers during its
            # own install/uninstall. Reject identifiable pip maintenance before
            # invocation; indirect requirements/imported pip remain unsupported.
            tokens = pip_request[1]
            maintenance = any(value in ("install", "uninstall") for value in tokens)
            pip_target = any(re.match(r"(?i)^pip(?:$|[<>=!~\[]|[-_](?:\d|latest)|\s*@)", value) for value in tokens)
            if maintenance and pip_target:
                fail("pip self-install/uninstall in a host-prepared glibc venv is unsupported; recreate the venv instead")
    request = venv_request(python_args)
    if request is not None:
        return create_venvs(root, files, cwd, env, python_args, request, venv)
    argv, child_env = guest_command(root, files, cwd, env, python_args, venv)
    if execute:
        os.chdir(cwd)
        os.execve(argv[0], argv, child_env)
    return argv, child_env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--command", required=True, choices=("python", "python3", "pip", "pip3"))
    parser.add_argument("--venv")
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    arguments = args.arguments[1:] if args.arguments[:1] == ["--"] else args.arguments
    root = Path(__file__).resolve().parents[2]
    try:
        result = dispatch(root, root.parent, Path.cwd(), os.environ, args.command, arguments, args.venv)
        if isinstance(result, int):
            if result < 0:
                signal.signal(-result, signal.SIG_DFL)
                os.kill(os.getpid(), -result)
            return result
    except (DispatchError, OSError) as error:
        print("kxxy-python: " + str(error), file=sys.stderr)
        return 127
    return 0


if __name__ == "__main__":
    sys.exit(main())
