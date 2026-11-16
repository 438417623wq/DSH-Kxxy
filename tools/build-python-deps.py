#!/usr/bin/env python3
"""Build pinned CFFI wheels for the runtime's GIL-enabled Android CPython.

Run with the *host* Python in isolated mode (never run setup.py or target Python):
  python -I tools/build-python-deps.py --runtime <runtime.zip> --ndk <ndk-root>
      [--out-parent <cache-dir>] [--cffi-source <cffi-2.0.0.tar.gz>]
      [--pycparser-wheel <pycparser-2.23-py3-none-any.whl>]

Every invocation creates a fresh python-deps-* artifact directory. Downloads,
archive extractions, generated probe sources, and project scripts are separated.
stdout is one JSON object containing absolute artifact paths; progress is stderr.
Only static ABI/linkage checks run: this does not connect to or install on devices.
"""
from __future__ import annotations

import argparse
import ast
import base64
import csv
from email.parser import BytesParser
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile


PROJECT = Path(__file__).resolve().parent.parent
RUNTIME_SHA256 = "07c9fa7479a08139bed1765d57f2818c0d30b5d5256ffd31b9fec78449bf52b8"
NDK_REVISION = "28.2.13676358"
PYTHON_VERSION = "3.14.8"
SOABI = "cpython-314-aarch64-linux-android"
EXT_SUFFIX = "." + SOABI + ".so"
NATIVE_NAME = "_cffi_backend" + EXT_SUFFIX
MIN_API = 24
TARGET = "aarch64-linux-android24"
WHEEL_TAG = "cp314-cp314-android_24_arm64_v8a"
CFFI_WHEEL = "cffi-2.0.0-" + WHEEL_TAG + ".whl"
SOURCE_DATE_EPOCH = "315532800"
PLATFORM_LIBRARIES = frozenset(("libc.so", "libdl.so", "libm.so", "liblog.so"))
SOURCES = (
    {
        "name": "cffi", "version": "2.0.0",
        "url": "https://files.pythonhosted.org/packages/eb/56/b1ba7935a17738ae8453301356628e8147c79dbb825bcbc73dc7401f9846/cffi-2.0.0.tar.gz",
        "sha256": "44d1b5909021139fe36001ae048dbdde8214afa20200eda0f64c068cac5d5529",
    },
    {
        "name": "pycparser", "version": "2.23",
        "url": "https://files.pythonhosted.org/packages/a0/e3/59cd50310fc9b59512193629e1984c1f95e5c8ae6e5d8c69532ccc65a7fe/pycparser-2.23-py3-none-any.whl",
        "sha256": "e5c6e8d3fbad53479cab09ac03729e0a9faf2bee3db8208a550daf5af81a5934",
    },
)


class BuildError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise BuildError(message)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bytes_sha256(data):
    return hashlib.sha256(data).hexdigest()


def checked_digest(path, expected):
    actual = sha256(path)
    require(actual == expected, f"SHA256 mismatch for {path}: expected {expected}, got {actual}")
    return actual


def safe_path(name):
    """Validate portable archive paths, including Windows ADS/device pitfalls."""
    require(isinstance(name, str) and name and len(name) <= 1024, "Invalid archive path")
    require(not any(c in name for c in ("\\", ":", "\x00")), f"Unsafe archive path: {name!r}")
    require(not name.startswith("/"), f"Absolute archive path: {name!r}")
    parts = name.rstrip("/").split("/")
    for part in parts:
        require(part not in ("", ".", "..") and not part.endswith((" ", ".")),
                f"Unsafe archive path: {name!r}")
        require(not any(ord(c) < 32 or c in '<>"|?*' for c in part), f"Unsafe archive path: {name!r}")
        require(not re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])", part.split(".")[0]),
                f"Windows device path in archive: {name!r}")
    return "/".join(parts)


def write_new(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(data)


def fresh(parent, prefix):
    return Path(tempfile.mkdtemp(prefix=prefix, dir=parent)).resolve()


class PinnedRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        require(parsed.scheme == "https" and parsed.hostname == "files.pythonhosted.org",
                "Refusing a source download redirect outside files.pythonhosted.org")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def acquire_source(spec, offline, parent):
    directory = fresh(parent, spec["name"] + "-download-")
    target = directory / PurePosixPath(urllib.parse.urlsplit(spec["url"]).path).name
    if offline:
        source = Path(offline).resolve(strict=True)
        checked_digest(source, spec["sha256"])
        with source.open("rb") as src, target.open("xb") as dst:
            shutil.copyfileobj(src, dst)
    else:
        request = urllib.request.Request(spec["url"], headers={"User-Agent": "DSH-Android-Python-Deps/1"})
        opener = urllib.request.build_opener(PinnedRedirects())
        with opener.open(request, timeout=90) as src, target.open("xb") as dst:
            total = 0
            while chunk := src.read(1024 * 1024):
                total += len(chunk)
                require(total <= 16 * 1024 * 1024, "Source download exceeds 16 MiB")
                dst.write(chunk)
    checked_digest(target, spec["sha256"])
    return target


def extract_cffi(archive, directory):
    require(not any(directory.iterdir()), "CFFI extraction directory must be empty")
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        require(len(members) <= 10000, "Too many source archive members")
        seen = set()
        total = 0
        for member in members:
            name = safe_path(member.name)
            require(name == "cffi-2.0.0" or name.startswith("cffi-2.0.0/"),
                    f"Unexpected CFFI source root: {name}")
            require(member.isfile() or member.isdir(), f"Source links/special files are forbidden: {name}")
            require(name.casefold() not in seen, f"Duplicate/case-colliding source path: {name}")
            seen.add(name.casefold())
            total += member.size
            require(0 <= member.size <= 16 * 1024 * 1024 and total <= 64 * 1024 * 1024,
                    "Oversized CFFI source archive")
        for member in members:
            target = directory / safe_path(member.name)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                with source.extractfile(member) as stream:
                    write_new(target, stream.read())
    root = directory / "cffi-2.0.0"
    require((root / "src/c/_cffi_backend.c").is_file(), "CFFI backend source is missing")
    return root


class RuntimeArchive:
    """Materialize only needed headers/libraries, not runtime executables.

    Runtime ZIP LINK: comments contain archive-root-relative paths. Unix ZIP
    symlink payloads instead use normal relative/Termux-prefix semantics.
    No symlinks are created on the host; every requested alias becomes bytes.
    """
    def __init__(self, path, directory):
        require(not any(directory.iterdir()), "Runtime extraction directory must be empty")
        self.zip = zipfile.ZipFile(path)
        self.directory = directory
        self.entries = {}
        for item in self.zip.infolist():
            require(item.filename not in self.entries, f"Duplicate runtime entry: {item.filename}")
            self.entries[item.filename] = item
        self.files = {}
        self.link_evidence = []

    def close(self):
        self.zip.close()

    def _link_target(self, name, item):
        if item.comment.startswith(b"LINK:"):
            require(item.file_size == 0, f"Ambiguous LINK entry with content: {name}")
            raw = item.comment[5:].decode("utf-8")
            target = safe_path(raw)
            kind = "runtime-zip-root-relative-comment"
        elif stat.S_ISLNK(item.external_attr >> 16):
            require(item.file_size <= 8192, f"Oversized runtime symlink: {name}")
            raw = self.zip.read(item).decode("utf-8")
            prefix = "/data/data/com.termux/files/usr/"
            if raw.startswith(prefix):
                target = safe_path(raw[len(prefix):])
            else:
                require(not raw.startswith("/") and "\\" not in raw and ":" not in raw,
                        f"Unsafe symlink target: {name} -> {raw}")
                target = safe_path(posixpath.normpath(posixpath.join(posixpath.dirname(name), raw)))
            kind = "unix-symlink-payload"
        else:
            return None
        self.link_evidence.append({"path": name, "target": raw, "resolvedTarget": target, "kind": kind})
        return target

    def resolve(self, name):
        current = safe_path(name)
        seen = set()
        for _ in range(64):
            require(current not in seen, f"Cyclic runtime link: {name}")
            seen.add(current)
            item = self.entries.get(current)
            if item is not None:
                target = self._link_target(current, item)
                if target is not None:
                    current = target
                    continue
                require(not item.is_dir(), f"Runtime file resolves to directory: {name}")
                require(0 < item.file_size <= 64 * 1024 * 1024, f"Invalid runtime file size: {name}")
                mode = stat.S_IFMT(item.external_attr >> 16)
                require(mode in (0, stat.S_IFREG), f"Runtime special file is forbidden: {name}")
                return current, self.zip.read(item)
            # A needed library/header may also live behind a directory alias.
            parts = current.split("/")
            for length in range(len(parts) - 1, 0, -1):
                prefix = "/".join(parts[:length])
                ancestor = self.entries.get(prefix)
                if ancestor is not None:
                    target = self._link_target(prefix, ancestor)
                    if target is not None:
                        current = safe_path(target + "/" + "/".join(parts[length:]))
                        break
            else:
                raise BuildError(f"Runtime dependency/header is missing: {name} (resolved {current})")
        raise BuildError(f"Runtime link chain too deep: {name}")

    def materialize(self, name):
        name = safe_path(name)
        if name not in self.files:
            resolved, data = self.resolve(name)
            target = self.directory / name
            write_new(target, data)
            self.files[name] = {"path": name, "archiveTarget": resolved,
                                "sha256": bytes_sha256(data), "size": len(data)}
        return self.directory / name

    def extract_headers(self):
        names = sorted(n for n, item in self.entries.items()
                       if n.startswith("include/python3.14/") and not item.is_dir())
        require(names, "Target Python headers are missing")
        for name in names + ["include/ffi.h", "include/ffitarget.h"]:
            self.materialize(name)


def target_python_config(runtime):
    name = "lib/python3.14/_sysconfigdata__android_aarch64-linux-android.py"
    text = runtime.materialize(name).read_text(encoding="utf-8")
    tree = ast.parse(text, filename=name)
    assignments = [node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(t, ast.Name) and t.id == "build_time_vars" for t in node.targets)]
    require(len(assignments) == 1, "Cannot locate target build_time_vars literal")
    # Parse data only. Importing this file would execute archived Python code.
    config = ast.literal_eval(assignments[0].value)
    expected = {"SOABI": SOABI, "EXT_SUFFIX": EXT_SUFFIX, "ANDROID_API_LEVEL": MIN_API,
                "Py_GIL_DISABLED": 0, "VERSION": "3.14", "MULTIARCH": "aarch64-linux-android"}
    require(isinstance(config, dict), "Target build_time_vars is not a dictionary")
    for key, value in expected.items():
        require(config.get(key) == value, f"Target config mismatch: {key}={config.get(key)!r}, expected {value!r}")
    patch = runtime.materialize("include/python3.14/patchlevel.h").read_text(encoding="utf-8")
    require(re.search(r'^\s*#\s*define\s+PY_VERSION\s+"3\.14\.8"\s*$', patch, re.M),
            "Runtime Python headers are not version 3.14.8")
    return expected


def clean_environment():
    remove = {"CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "OBJC_INCLUDE_PATH",
              "COMPILER_PATH", "LIBRARY_PATH", "SDKROOT", "INCLUDE", "LIB", "LIBPATH",
              "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "CC", "CXX", "CL", "_CL_"}
    env = {key: value for key, value in os.environ.items() if key.upper() not in remove}
    env.update({"LC_ALL": "C", "LANG": "C", "SOURCE_DATE_EPOCH": SOURCE_DATE_EPOCH})
    return env


class Commands:
    def __init__(self, out):
        self.out = out
        self.records = []
        self.env = clean_environment()

    def run(self, label, argv, check=True):
        argv = [str(arg) for arg in argv]
        result = subprocess.run(argv, cwd=PROJECT, env=self.env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300,
                                shell=False)
        prefix = f"evidence/{len(self.records):02d}-{label}"
        write_new(self.out / (prefix + ".stdout.txt"), result.stdout)
        write_new(self.out / (prefix + ".stderr.txt"), result.stderr)
        self.records.append({"label": label, "argv": argv, "cwd": str(PROJECT),
                             "exitCode": result.returncode, "stdout": prefix + ".stdout.txt",
                             "stderr": prefix + ".stderr.txt"})
        stdout = result.stdout.decode("utf-8", "replace")
        stderr = result.stderr.decode("utf-8", "replace")
        if check and result.returncode:
            raise BuildError(f"{label} failed (exit {result.returncode}); see {self.out / (prefix + '.stderr.txt')}\n{stderr[-8000:]}")
        return result.returncode, stdout, stderr


def ndk_tools(ndk, commands):
    revision_path = ndk / "source.properties"
    properties = revision_path.read_text(encoding="utf-8")
    match = re.search(r"^Pkg\.Revision\s*=\s*(\S+)", properties, re.M)
    require(match and match.group(1) == NDK_REVISION, f"Expected pinned NDK {NDK_REVISION}")
    host = {"win32": "windows-x86_64", "linux": "linux-x86_64", "darwin": "darwin-x86_64"}.get(sys.platform)
    require(host is not None, f"Unsupported compiler host: {sys.platform}")
    toolchain = ndk / "toolchains/llvm/prebuilt" / host
    suffix = ".exe" if sys.platform == "win32" else ""
    paths = {name: toolchain / "bin" / (name + suffix)
             for name in ("clang", "ld.lld", "llvm-readelf", "llvm-nm")}
    for path in paths.values():
        require(path.is_file(), f"Missing NDK tool: {path}")
    _, version, _ = commands.run("clang-version", [paths["clang"], "--version"])
    sysroot = toolchain / "sysroot"
    api_libs = sysroot / f"usr/lib/aarch64-linux-android/{MIN_API}"
    require(api_libs.is_dir(), "NDK API24 aarch64 library stubs are missing")
    evidence = {"path": str(ndk), "revision": match.group(1), "hostTag": host,
                "sourcePropertiesSha256": sha256(revision_path), "clangVersion": version.strip(),
                "tools": {name: {"path": str(path), "sha256": sha256(path)} for name, path in paths.items()},
                "apiStubDirectory": str(api_libs)}
    return paths, sysroot, api_libs, evidence


def elf_layout(data):
    require(len(data) >= 64 and data[:7] == b"\x7fELF\x02\x01\x01", "Expected little-endian ELF64")
    header = struct.unpack_from("<HHIQQQIHHHHHH", data, 16)
    elf_type, machine, _, _, phoff, _, _, _, phentsize, phnum, _, _, _ = header
    require(elf_type == 3 and machine == 183, f"Expected AArch64 shared ELF, got type={elf_type}, machine={machine}")
    require(phentsize == 56 and 0 < phnum < 1024 and phoff + phnum * phentsize <= len(data),
            "Invalid ELF program-header table")
    loads, notes = [], []
    relro, executable_stack = False, None
    for index in range(phnum):
        kind, flags, offset, vaddr, _, filesz, memsz, alignment = struct.unpack_from("<IIQQQQQQ", data, phoff + index * phentsize)
        require(offset + filesz <= len(data), "ELF segment exceeds file length")
        if kind == 1:
            loads.append({"offset": offset, "virtualAddress": vaddr, "fileSize": filesz,
                          "memorySize": memsz, "flags": flags, "alignment": alignment})
        elif kind == 0x6474e552:
            relro = True
        elif kind == 0x6474e551:
            executable_stack = bool(flags & 1)
        elif kind == 4:
            cursor, end = offset, offset + filesz
            while cursor + 12 <= end:
                namesz, descsz, note_type = struct.unpack_from("<III", data, cursor)
                start = cursor + 12
                desc = start + ((namesz + 3) & ~3)
                next_cursor = desc + ((descsz + 3) & ~3)
                require(next_cursor <= end, "Malformed ELF note")
                owner = data[start:start + namesz].rstrip(b"\0")
                if owner == b"Android" and note_type == 1:
                    require(descsz >= 4, "Truncated Android ident note")
                    notes.append(struct.unpack_from("<I", data, desc)[0])
                cursor = next_cursor
    require(loads, "ELF has no loadable segments")
    aligned = all(item["alignment"] >= 16384
                  and (item["virtualAddress"] - item["offset"]) % 16384 == 0 for item in loads)
    return {"elfClass": "ELF64", "elfMachine": machine, "androidApiNotes": sorted(set(notes)),
            "loadSegments": loads, "pageSize16KiBCompatible": aligned,
            "gnuRelro": relro, "executableStack": executable_stack,
            "writableExecutableSegments": any(item["flags"] & 3 == 3 for item in loads)}


def parse_dynamic_symbols(text):
    result = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 8 and re.fullmatch(r"\d+:", parts[0]):
            result.append({"name": parts[7], "type": parts[3], "binding": parts[4],
                           "visibility": parts[5], "undefined": parts[6] == "UND"})
    require(result, "No dynamic symbols parsed from llvm-readelf")
    return result


def inspect_elf(path, label, tools, commands, platform_stub=False, new_native=False):
    data = path.read_bytes()
    layout = elf_layout(data)
    _, text, _ = commands.run("elf-" + label, [tools["llvm-readelf"], "--file-header", "--program-headers",
                                               "--dynamic", "--notes", "--dyn-syms", "--wide", path])
    needed = re.findall(r"\(NEEDED\)\s+Shared library: \[([^\]]+)\]", text)
    runpaths = re.findall(r"\((?:RUNPATH|RPATH)\).*?\[([^\]]*)\]", text)
    sonames = re.findall(r"\(SONAME\)\s+Library soname: \[([^\]]+)\]", text)
    for dependency in needed:
        require(re.fullmatch(r"lib[A-Za-z0-9_.+-]+\.so(?:\.\d+)*", dependency)
                and dependency not in ("libc.so.6", "libm.so.6", "libdl.so.2", "libpthread.so.0"),
                f"Non-Android/unsafe DT_NEEDED in {label}: {dependency}")
    if not platform_stub:
        require(layout["androidApiNotes"] and max(layout["androidApiNotes"]) <= MIN_API,
                f"Missing or incompatible Android min-API note in {label}: {layout['androidApiNotes']}")
        require(layout["pageSize16KiBCompatible"], f"{label} is not 16-KiB page compatible")
        require(not layout["writableExecutableSegments"] and layout["executableStack"] is False,
                f"Executable stack or writable/executable LOAD in {label}")
    if new_native:
        require(layout["androidApiNotes"] == [MIN_API], "New backend must identify Android API24")
        require(not runpaths, "New backend must not contain RPATH/RUNPATH")
        require(layout["gnuRelro"] and re.search(r"\(FLAGS(?:_1)?\).*\b(?:BIND_NOW|NOW)\b", text),
                "New backend lacks RELRO/BIND_NOW")
        require("(TEXTREL)" not in text, "New backend contains text relocations")
        require({"libffi.so", "libpython3.14.so"}.issubset(needed), "New backend must link target libffi and libpython3.14")
    symbols = parse_dynamic_symbols(text)
    require(not any("@GLIBC" in s["name"] for s in symbols), f"glibc symbol versions in {label}")
    return {"path": str(path), "sha256": bytes_sha256(data), "size": len(data),
            "needed": needed, "runpaths": runpaths, "soname": sonames[0] if sonames else None,
            "source": "ndk-api24-platform-stub" if platform_stub else "runtime",
            **layout, "symbols": symbols}


def export_keys(symbol):
    name = symbol["name"]
    if "@@" in name:
        base, version = name.split("@@", 1)
        return (base, base + "@" + version)
    return (name,)


def check_symbols(libraries):
    """Version-aware lookup against the complete target DT_NEEDED closure."""
    exports = {}
    for library, info in libraries.items():
        for symbol in info["symbols"]:
            if not symbol["undefined"] and symbol["binding"] in ("GLOBAL", "WEAK", "GNU_UNIQUE") \
                    and symbol["visibility"] in ("DEFAULT", "PROTECTED"):
                for key in export_keys(symbol):
                    exports.setdefault(key, {"library": library, "export": symbol["name"]})
    checks, missing = {}, []
    for library, info in libraries.items():
        resolved, weak = {}, []
        for symbol in info["symbols"]:
            if not symbol["undefined"]:
                continue
            if symbol["binding"] == "WEAK":
                weak.append(symbol["name"])
            elif symbol["binding"] != "LOCAL":
                key = symbol["name"].replace("@@", "@")
                if key in exports:
                    resolved[symbol["name"]] = exports[key]
                else:
                    missing.append({"library": library, "symbol": symbol["name"]})
        checks[library] = {"strongUndefinedCount": len(resolved) + sum(m["library"] == library for m in missing),
                           "resolvedStrong": resolved, "weakUndefined": sorted(weak)}
    return {"method": "version-aware dynamic symbols against runtime DT_NEEDED closure and NDK API24 stubs",
            "unresolvedStrong": missing, "libraries": checks}


def dependency_closure(native, runtime, api_libs, tools, commands):
    libraries = {NATIVE_NAME: inspect_elf(native, "cffi-backend", tools, commands, new_native=True)}
    libraries[NATIVE_NAME]["source"] = "built-cffi"
    pending = list(libraries[NATIVE_NAME]["needed"])
    while pending:
        name = pending.pop(0)
        if name in libraries:
            continue
        platform_stub = name in PLATFORM_LIBRARIES
        path = api_libs / name if platform_stub else runtime.materialize("lib/" + name)
        require(path.is_file(), f"Missing target dependency in closure: {name}")
        info = inspect_elf(path, name.replace(".", "-"), tools, commands, platform_stub=platform_stub)
        if info["soname"]:
            require(info["soname"] == name, f"Dependency SONAME mismatch for {name}: {info['soname']}")
        libraries[name] = info
        pending.extend(info["needed"])
    checks = check_symbols(libraries)
    write_new(commands.out / "evidence/symbol-checks.json", (json.dumps(checks, indent=2) + "\n").encode())
    require(not checks["unresolvedStrong"], "Unresolved target strong symbols; see evidence/symbol-checks.json: "
            + json.dumps(checks["unresolvedStrong"][:20]))
    init = [s for s in libraries[NATIVE_NAME]["symbols"] if s["name"] == "PyInit__cffi_backend"
            and not s["undefined"] and s["type"] == "FUNC" and s["binding"] == "GLOBAL"
            and s["visibility"] == "DEFAULT"]
    require(len(init) == 1, "Backend must export PyInit__cffi_backend")
    _, nm, _ = commands.run("nm-backend-exports", [tools["llvm-nm"], "--dynamic", "--defined-only", native])
    require(re.search(r"\bT\s+PyInit__cffi_backend\s*$", nm, re.M), "llvm-nm did not confirm backend entry point")
    return libraries, checks


def compile_backend(source, runtime, native, tools, sysroot, commands):
    build = native.parent / "build"
    build.mkdir()
    includes = ["-I" + str(runtime.directory / "include/python3.14"),
                "-I" + str(runtime.directory / "include")]
    common = [tools["clang"], "--target=" + TARGET, "--sysroot=" + str(sysroot),
              "-fPIC", "-shared", "-O2", "-fstack-protector-strong",
              "-Wl,-z,relro,-z,now,-z,max-page-size=16384", "-Wl,--no-undefined", "-Wl,--build-id=sha1"]
    for root, stable in ((source, "/cffi-2.0.0"), (runtime.directory, "/target-runtime"),
                         (native.parent, "/python-deps-build"), (PROJECT, "/dsh-project")):
        common += ["-ffile-prefix-map=" + str(root) + "=" + stable,
                   "-ffile-prefix-map=" + root.as_posix() + "=" + stable]
    abi = b'''#include <Python.h>
#if PY_MAJOR_VERSION != 3 || PY_MINOR_VERSION != 14 || PY_MICRO_VERSION != 8
#error Incorrect CPython headers
#endif
#if !defined(__ANDROID__) || !defined(__aarch64__) || __ANDROID_API__ != 24 || ANDROID_API_LEVEL != 24
#error Incorrect Android ABI
#endif
#if defined(Py_GIL_DISABLED) || defined(Py_DEBUG)
#error This wheel requires a release GIL-enabled CPython
#endif
_Static_assert(sizeof(void *) == 8, "64-bit target required");
int dsh_target_abi_probe(void) { return PY_MICRO_VERSION; }
'''
    probes = {"target-abi": abi,
              "thread-local": b"__thread volatile int dsh_probe_tls;\nint probe(void) { return ++dsh_probe_tls; }\n",
              "sync-synchronize": b"int probe(void) { __sync_synchronize(); return 0; }\n"}
    results = {}
    for label, data in probes.items():
        path = build / (label + ".c")
        write_new(path, data)
        argv = common + includes + [path, "-o", build / (label + ".so")]
        code, _, _ = commands.run("probe-" + label, argv)
        results[label] = {"compileAndLinkSucceeded": code == 0, "executed": False,
                          "source": str(path), "sourceSha256": bytes_sha256(data)}
    defines = ["FFI_BUILDING=1", "USE__THREAD", "HAVE_SYNC_SYNCHRONIZE"]
    argv = common + includes + ["-D" + value for value in defines]
    argv += ["-H", source / "src/c/_cffi_backend.c", "-L" + str(runtime.directory / "lib"),
             "-Wl,--as-needed", "-lffi", "-lpython3.14", "-ldl", "-lm", "-o", native]
    _, _, stderr = commands.run("compile-cffi-backend", argv)
    # -H lists every actually included header. Reject a host-header leak even if
    # someone configured compiler search paths in the invoking environment.
    headers = []
    roots = ((runtime.directory, "runtime"), (source, "cffi-source"), (sysroot.parent, "ndk"))
    for line in stderr.splitlines():
        match = re.match(r"^\.+ (.+)$", line)
        if not match:
            continue
        path = Path(match.group(1)).resolve(strict=True)
        group = next(((root, label) for root, label in roots if path.is_relative_to(root)), None)
        require(group is not None, f"Host header leaked into Android compilation: {path}")
        root, label = group
        headers.append({"source": label, "path": path.relative_to(root).as_posix(), "sha256": sha256(path)})
    required = {("runtime", "include/python3.14/Python.h"), ("runtime", "include/python3.14/pyconfig.h"),
                ("runtime", "include/ffi.h"), ("runtime", "include/ffitarget.h")}
    require(required.issubset({(h["source"], h["path"]) for h in headers}), "Compiler header trace omitted target headers")
    return {"defines": defines, "featureProbes": results, "includedHeaders": headers}


def record_hash(data):
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")


def write_wheel(path, files, dist_info):
    record = dist_info + "/RECORD"
    require(record not in files, "RECORD is generated, not supplied")
    table = io.StringIO(newline="")
    writer = csv.writer(table, lineterminator="\n")
    for name, data in sorted(files.items()):
        safe_path(name)
        writer.writerow((name, record_hash(data), len(data)))
    writer.writerow((record, "", ""))
    payload = dict(files)
    payload[record] = table.getvalue().encode("utf-8")
    with zipfile.ZipFile(path, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(payload.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | (0o755 if name.endswith(".so") else 0o644)) << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def verify_wheel(path, package, version, tag, pure):
    dist_info = package + "-" + version + ".dist-info"
    with zipfile.ZipFile(path) as archive:
        files, folded = {}, set()
        for item in archive.infolist():
            name = safe_path(item.filename)
            require(name.casefold() not in folded, f"Duplicate wheel path: {name}")
            folded.add(name.casefold())
            require(not item.is_dir() and not stat.S_ISLNK(item.external_attr >> 16), f"Non-file wheel entry: {name}")
            require(item.file_size <= 16 * 1024 * 1024, f"Oversized wheel entry: {name}")
            files[name] = archive.read(item)
        metadata = BytesParser().parsebytes(files[dist_info + "/METADATA"])
        require(metadata["Name"] == package and metadata["Version"] == version, "Wheel metadata name/version mismatch")
        wheel = BytesParser().parsebytes(files[dist_info + "/WHEEL"])
        require(wheel["Wheel-Version"] == "1.0" and wheel["Root-Is-Purelib"] == str(pure).lower()
                and wheel.get_all("Tag") == [tag], "Wheel tag or purelib metadata mismatch")
        record = dist_info + "/RECORD"
        rows = list(csv.reader(io.StringIO(files[record].decode("utf-8"))))
        require(all(len(row) == 3 for row in rows) and len(rows) == len(files), "Invalid wheel RECORD rows")
        require(len({row[0] for row in rows}) == len(rows) and {row[0] for row in rows} == set(files),
                "Wheel RECORD does not cover exactly all files")
        for name, digest, size in rows:
            if name == record:
                require(digest == size == "", "RECORD self-entry must have blank hash and size")
            else:
                require(digest == record_hash(files[name]) and size == str(len(files[name])),
                        f"Wheel RECORD mismatch: {name}")
        native_names = [n for n in files if n.lower().endswith((".so", ".pyd", ".dll", ".exe"))]
        require(native_names == ([] if pure else [NATIVE_NAME]), f"Unexpected native wheel members: {native_names}")
        if pure:
            require(not metadata.get_all("Requires-Dist") and metadata["Requires-Python"] == ">=3.8",
                    "Unexpected pycparser dependency/Python requirement")
        else:
            require(any(re.match(r"^pycparser\b", value) for value in metadata.get_all("Requires-Dist", [])),
                    "CFFI wheel lost its pycparser requirement")
            for license_name in metadata.get_all("License-File", []):
                require(dist_info + "/licenses/" + safe_path(license_name) in files, "Wheel license file is missing")
    return {"filename": path.name, "files": len(files), "recordVerified": True, "tag": tag}


def package_cffi(source, native, out):
    dist_info = "cffi-2.0.0.dist-info"
    files = {NATIVE_NAME: native.read_bytes(), dist_info + "/METADATA": (source / "PKG-INFO").read_bytes(),
             dist_info + "/WHEEL": ("Wheel-Version: 1.0\nGenerator: dsh-android-python-deps 1\n"
                                    "Root-Is-Purelib: false\nTag: " + WHEEL_TAG + "\n\n").encode(),
             dist_info + "/top_level.txt": b"_cffi_backend\ncffi\n"}
    for path in sorted((source / "src/cffi").rglob("*")):
        if path.is_file() and path.suffix in (".py", ".h"):
            files[path.relative_to(source / "src").as_posix()] = path.read_bytes()
    metadata = BytesParser().parsebytes(files[dist_info + "/METADATA"])
    for name in metadata.get_all("License-File", []):
        files[dist_info + "/licenses/" + safe_path(name)] = (source / safe_path(name)).read_bytes()
    require(dist_info + "/licenses/LICENSE" in files, "Upstream CFFI LICENSE missing")
    path = out / CFFI_WHEEL
    write_wheel(path, files, dist_info)
    return path


def build(args):
    runtime_zip = Path(args.runtime).resolve(strict=True)
    ndk = Path(args.ndk).resolve(strict=True)
    parent = Path(args.out_parent).resolve()
    parent.mkdir(parents=True, exist_ok=True)
    print("Verifying pinned runtime SHA256...", file=sys.stderr, flush=True)
    checked_digest(runtime_zip, RUNTIME_SHA256)
    out = fresh(parent, "python-deps-")
    print("Fresh artifact directory: " + str(out), file=sys.stderr, flush=True)
    commands = Commands(out)
    tools, sysroot, api_libs, ndk_evidence = ndk_tools(ndk, commands)
    cffi_archive = acquire_source(SOURCES[0], args.cffi_source, parent)
    pycparser_archive = acquire_source(SOURCES[1], args.pycparser_wheel, parent)
    source_dir = fresh(parent, "cffi-extracted-")
    source = extract_cffi(cffi_archive, source_dir)
    runtime_dir = fresh(parent, "python-deps-runtime-input-")
    runtime = RuntimeArchive(runtime_zip, runtime_dir)
    try:
        runtime.extract_headers()
        config = target_python_config(runtime)
        runtime.materialize("lib/libffi.so")
        runtime.materialize("lib/libpython3.14.so")
        native = out / NATIVE_NAME
        print("Cross-compiling CFFI for " + TARGET + " (no target execution)...", file=sys.stderr, flush=True)
        compile_evidence = compile_backend(source, runtime, native, tools, sysroot, commands)
        libraries, symbols = dependency_closure(native, runtime, api_libs, tools, commands)
        native_info = libraries[NATIVE_NAME]
        cffi_wheel = package_cffi(source, native, out)
        pycparser_wheel = out / pycparser_archive.name
        write_new(pycparser_wheel, pycparser_archive.read_bytes())
        checked_digest(pycparser_wheel, SOURCES[1]["sha256"])
        wheel_checks = [verify_wheel(cffi_wheel, "cffi", "2.0.0", WHEEL_TAG, False),
                        verify_wheel(pycparser_wheel, "pycparser", "2.23", "py3-none-any", True)]
        manifest = {
            "schema": 1,
            "python": {"version": PYTHON_VERSION, "majorMinor": "3.14", "soabi": SOABI,
                       "minApi": MIN_API, "arch": "arm64-v8a"},
            "sources": list(SOURCES),
            "runtimeInputs": [{"path": item["path"], "sha256": item["sha256"]}
                              for _, item in sorted(runtime.files.items())],
            "wheels": [{"name": spec["name"], "version": spec["version"], "filename": path.name,
                        "sha256": sha256(path)} for spec, path in zip(SOURCES, (cffi_wheel, pycparser_wheel))],
            "native": {"path": NATIVE_NAME, "sha256": native_info["sha256"], "needed": native_info["needed"],
                       "minApi": MIN_API, "elfMachine": 183},
            "build": {
                "runtimeZip": str(runtime_zip), "runtimeSha256": RUNTIME_SHA256,
                "builderSha256": sha256(Path(__file__).resolve()), "ndk": ndk_evidence,
                "target": TARGET, "targetConfig": config, "gilEnabled": True,
                "sourceDateEpoch": int(SOURCE_DATE_EPOCH), "wheelTimestamp": "1980-01-01T00:00:00",
                "cwd": str(PROJECT), "commands": commands.records,
                "sourcesDirectory": str(source), "runtimeInputsDirectory": str(runtime_dir),
                "headerDigests": [item for name, item in sorted(runtime.files.items()) if name.startswith("include/")],
                "runtimeFiles": list(runtime.files.values()), "runtimeLinkResolution": runtime.link_evidence,
                **compile_evidence,
                "dependencyClosure": {name: {key: value for key, value in info.items() if key != "symbols"}
                                      for name, info in libraries.items()},
                "symbolChecks": symbols, "wheelChecks": wheel_checks,
                "verification": {"kind": "cross-compilation-and-static-ABI-linkage", "deviceTestsPerformed": False,
                                 "targetCodeExecuted": False, "entryPoint": "PyInit__cffi_backend",
                                 "newNativeHasNoRpath": True, "newNativeSupports16KiBPages": True},
            },
        }
        manifest_path = out / "manifest.json"
        write_new(manifest_path, (json.dumps(manifest, indent=2, ensure_ascii=True) + "\n").encode("utf-8"))
        return {"outDir": str(out), "manifest": str(manifest_path), "native": str(native),
                "wheels": [str(cffi_wheel), str(pycparser_wheel)]}
    finally:
        runtime.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runtime", required=True, help="Pinned runtime-0.9.41 ZIP (SHA256 is enforced)")
    parser.add_argument("--ndk", required=True, help="Android NDK 28.2.13676358 root")
    parser.add_argument("--out-parent", default=str(PROJECT / ".cache"), help="Parent for fresh, never-overwritten output/input directories")
    parser.add_argument("--cffi-source", help="Optional pinned CFFI source archive for offline use")
    parser.add_argument("--pycparser-wheel", help="Optional pinned pycparser wheel for fully offline use")
    args = parser.parse_args(argv)
    if not sys.flags.isolated:
        parser.error("Use isolated host Python: python -I tools/build-python-deps.py ...")
    try:
        result = build(args)
    except (BuildError, OSError, ValueError, KeyError, tarfile.TarError, zipfile.BadZipFile, subprocess.SubprocessError) as exc:
        print("Python dependency build failed: " + str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
