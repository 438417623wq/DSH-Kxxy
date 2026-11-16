#!/usr/bin/env python3
"""Stdlib-only builder regressions: python -I tools/test-build-python-deps.py.

Optional real-artifact checks (no target code/device execution):
  python -I tools/test-build-python-deps.py --artifacts <python-deps-dir>
      [--compare <second-python-deps-dir>]
"""
import argparse
import base64
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import struct
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile


MODULE_PATH = Path(__file__).resolve().with_name("build-python-deps.py")
SPEC = importlib.util.spec_from_file_location("android_python_deps_builder", MODULE_PATH)
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
ARTIFACTS = None
COMPARE = None


def symbol(name, undefined=False, binding="GLOBAL", visibility="DEFAULT"):
    return {"name": name, "undefined": undefined, "binding": binding,
            "visibility": visibility, "type": "FUNC"}


def synthetic_elf(alignment=16384, machine=183, api=24, executable_stack=False, truncated_note=False):
    data = bytearray(512)
    data[:16] = b"\x7fELF\x02\x01\x01" + b"\0" * 9
    struct.pack_into("<HHIQQQIHHHHHH", data, 16, 3, machine, 1, 0, 64, 0, 0, 64, 56, 4, 64, 0, 0)
    struct.pack_into("<IIQQQQQQ", data, 64, 1, 5, 0, 0, 0, 512, 512, alignment)
    struct.pack_into("<IIQQQQQQ", data, 120, 4, 4, 400, 400, 0, 24, 24, 4)
    struct.pack_into("<IIQQQQQQ", data, 176, 0x6474e552, 4, 0, 0, 0, 0, 0, 1)
    struct.pack_into("<IIQQQQQQ", data, 232, 0x6474e551, 7 if executable_stack else 6, 0, 0, 0, 0, 0, 0)
    struct.pack_into("<III", data, 400, 8, 100 if truncated_note else 4, 1)
    data[412:420] = b"Android\0"
    struct.pack_into("<I", data, 420, api)
    return bytes(data)


class ArchiveSafetyTests(unittest.TestCase):
    def test_portable_paths_reject_traversal_ads_and_device_names(self):
        for name in ("../escape", "/absolute", "a/../b", "a//b", "a\\b", "C:/evil", "file:ads",
                     "a/./b", "aux.py", "COM1.c", "safe/nul", "space /x", "dot./x", "a\0b"):
            with self.subTest(name=name), self.assertRaises(builder.BuildError):
                builder.safe_path(name)
        self.assertEqual(builder.safe_path("include/python3.14/internal/pycore_gc.h"),
                         "include/python3.14/internal/pycore_gc.h")

    def test_tar_validation_happens_before_any_member_is_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "source.tar.gz"
            dest = root / "extract"
            dest.mkdir()
            with tarfile.open(archive, "w:gz") as tar:
                for name in ("cffi-2.0.0/src/c/_cffi_backend.c", "cffi-2.0.0/../../escape"):
                    item = tarfile.TarInfo(name)
                    item.size = 4
                    tar.addfile(item, io.BytesIO(b"test"))
            with self.assertRaises(builder.BuildError):
                builder.extract_cffi(archive, dest)
            self.assertEqual(list(dest.iterdir()), [])
            self.assertFalse((root / "escape").exists())

    def test_tar_symlinks_and_case_collisions_are_rejected(self):
        for kind in ("symlink", "collision"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                archive, dest = root / "source.tar.gz", root / "extract"
                dest.mkdir()
                with tarfile.open(archive, "w:gz") as tar:
                    item = tarfile.TarInfo("cffi-2.0.0/x")
                    if kind == "symlink":
                        item.type, item.linkname = tarfile.SYMTYPE, "../../outside"
                    tar.addfile(item)
                    if kind == "collision":
                        tar.addfile(tarfile.TarInfo("cffi-2.0.0/X"))
                with self.assertRaises(builder.BuildError):
                    builder.extract_cffi(archive, dest)
                self.assertFalse(any(dest.iterdir()))

    def test_runtime_link_comment_and_unix_symlink_materialize_same_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive, dest = root / "runtime.zip", root / "extract"
            dest.mkdir()
            with zipfile.ZipFile(archive, "w") as zipf:
                zipf.writestr("lib/real.so.1", b"ELF target bytes")
                for name, target in (("lib/libffi.so", "lib/middle.so"), ("lib/middle.so", "lib/real.so.1")):
                    item = zipfile.ZipInfo(name)
                    item.comment = ("LINK:" + target).encode()
                    zipf.writestr(item, b"")
                item = zipfile.ZipInfo("lib/unix.so")
                item.external_attr = (stat.S_IFLNK | 0o777) << 16
                zipf.writestr(item, b"real.so.1")
                zipf.writestr("actual/header.h", b"target header")
                item = zipfile.ZipInfo("alias")
                item.comment = b"LINK:actual"
                zipf.writestr(item, b"")
            runtime = builder.RuntimeArchive(archive, dest)
            try:
                for name in ("lib/libffi.so", "lib/unix.so"):
                    path = runtime.materialize(name)
                    self.assertFalse(path.is_symlink())
                    self.assertEqual(path.read_bytes(), b"ELF target bytes")
                    self.assertEqual(runtime.files[name]["sha256"], hashlib.sha256(b"ELF target bytes").hexdigest())
                    self.assertEqual(runtime.files[name]["archiveTarget"], "lib/real.so.1")
                self.assertEqual(runtime.materialize("alias/header.h").read_bytes(), b"target header")
            finally:
                runtime.close()

    def test_runtime_links_reject_cycle_escape_and_missing_targets(self):
        for links in ({"a": "b", "b": "a"}, {"a": "../escape"}, {"a": "missing"}):
            with self.subTest(links=links), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                archive, dest = root / "runtime.zip", root / "extract"
                dest.mkdir()
                with zipfile.ZipFile(archive, "w") as zipf:
                    for name, target in links.items():
                        item = zipfile.ZipInfo(name)
                        item.comment = ("LINK:" + target).encode()
                        zipf.writestr(item, b"")
                runtime = builder.RuntimeArchive(archive, dest)
                try:
                    with self.assertRaises(builder.BuildError):
                        runtime.materialize("a")
                    self.assertFalse(any(dest.iterdir()))
                finally:
                    runtime.close()

    def test_new_file_and_new_directory_never_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first, second = builder.fresh(root, "python-deps-"), builder.fresh(root, "python-deps-")
            self.assertNotEqual(first, second)
            path = first / "manifest.json"
            builder.write_new(path, b"original")
            with self.assertRaises(FileExistsError):
                builder.write_new(path, b"replacement")
            self.assertEqual(path.read_bytes(), b"original")


class TargetAbiTests(unittest.TestCase):
    def test_elf64_aarch64_api_note_and_16k_alignment(self):
        info = builder.elf_layout(synthetic_elf())
        self.assertEqual(info["elfMachine"], 183)
        self.assertEqual(info["androidApiNotes"], [24])
        self.assertTrue(info["pageSize16KiBCompatible"])
        self.assertTrue(info["gnuRelro"])
        self.assertFalse(info["executableStack"])
        self.assertFalse(builder.elf_layout(synthetic_elf(alignment=4096))["pageSize16KiBCompatible"])
        self.assertTrue(builder.elf_layout(synthetic_elf(executable_stack=True))["executableStack"])

    def test_elf_rejects_wrong_machine_and_malformed_note(self):
        for data in (b"MZ" + b"\0" * 510, synthetic_elf(machine=62), synthetic_elf(truncated_note=True),
                     synthetic_elf()[:100]):
            with self.subTest(length=len(data)), self.assertRaises(builder.BuildError):
                builder.elf_layout(data)

    def test_symbol_parser_uses_binding_visibility_and_versions(self):
        data = """Symbol table '.dynsym' contains 5 entries:
     0: 0000000000000000     0 NOTYPE  LOCAL  DEFAULT   UND
     1: 0000000000000000     0 FUNC    GLOBAL DEFAULT   UND malloc@LIBC
     2: 0000000000000020     4 FUNC    GLOBAL DEFAULT     7 ffi_call@@LIBFFI_BASE_8.0
     3: 0000000000000000     0 FUNC    WEAK   DEFAULT   UND optional@LIBC_Q
     4: 0000000000000030     4 FUNC    GLOBAL HIDDEN      7 private
"""
        rows = builder.parse_dynamic_symbols(data)
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows[0]["name"], "malloc@LIBC")
        self.assertTrue(rows[0]["undefined"])
        self.assertEqual(rows[2]["binding"], "WEAK")
        self.assertEqual(rows[3]["visibility"], "HIDDEN")

    def test_versioned_strong_symbols_fail_but_unresolved_weak_are_reported(self):
        libraries = {
            "backend": {"symbols": [symbol("malloc@LIBC", True), symbol("ffi_call", True),
                                       symbol("api_new@LIBC_Q", True), symbol("optional", True, "WEAK")]},
            "libc.so": {"symbols": [symbol("malloc@@LIBC"), symbol("api_new@@LIBC")]},
            "libffi.so": {"symbols": [symbol("ffi_call@@LIBFFI_BASE_8.0")]},
        }
        checks = builder.check_symbols(libraries)
        self.assertEqual(checks["unresolvedStrong"], [{"library": "backend", "symbol": "api_new@LIBC_Q"}])
        self.assertEqual(checks["libraries"]["backend"]["strongUndefinedCount"], 3)
        self.assertEqual(checks["libraries"]["backend"]["weakUndefined"], ["optional"])
        self.assertEqual(checks["libraries"]["backend"]["resolvedStrong"]["ffi_call"]["library"], "libffi.so")
        libraries["libc.so"]["symbols"].append(symbol("api_new@LIBC_Q"))
        self.assertEqual(builder.check_symbols(libraries)["unresolvedStrong"], [])

    def test_hidden_and_nondefault_version_exports_do_not_satisfy_unversioned_uses(self):
        checks = builder.check_symbols({"use": {"symbols": [symbol("hidden", True), symbol("old", True)]},
                                        "provider": {"symbols": [symbol("hidden", visibility="HIDDEN"),
                                                                  symbol("old@LIBC_OLD")]}})
        self.assertEqual({item["symbol"] for item in checks["unresolvedStrong"]}, {"hidden", "old"})

    def test_compiler_environment_drops_host_include_and_link_overrides(self):
        with patch.dict(builder.os.environ, {"CPATH": "host", "CFLAGS": "-m64", "LIBRARY_PATH": "host",
                                            "INCLUDE": "host", "LDFLAGS": "host"}):
            env = builder.clean_environment()
        self.assertFalse({"CPATH", "CFLAGS", "LIBRARY_PATH", "INCLUDE", "LDFLAGS"} & set(env))
        self.assertEqual(env["SOURCE_DATE_EPOCH"], "315532800")


class WheelTests(unittest.TestCase):
    def test_wheel_bytes_are_deterministic_and_record_is_exact(self):
        files = {"example/data,with-comma.py": b"test\n", "example/__init__.py": b""}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first, second = root / "first.whl", root / "second.whl"
            builder.write_wheel(first, files, "example-1.dist-info")
            builder.write_wheel(second, dict(reversed(list(files.items()))), "example-1.dist-info")
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with self.assertRaises(FileExistsError):
                builder.write_wheel(first, files, "example-1.dist-info")
            with zipfile.ZipFile(first) as zipf:
                record = "example-1.dist-info/RECORD"
                rows = list(csv.reader(io.StringIO(zipf.read(record).decode())))
                self.assertEqual(set(row[0] for row in rows), set(zipf.namelist()))
                self.assertEqual(rows[-1], [record, "", ""])
                for name, digest, size in rows[:-1]:
                    data = zipf.read(name)
                    self.assertEqual(digest, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode())
                    self.assertEqual(size, str(len(data)))
                self.assertTrue(all(item.date_time == (1980, 1, 1, 0, 0, 0) for item in zipf.infolist()))

    def test_verifier_checks_record_and_preserves_pure_requirements(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "pycparser-2.23-py3-none-any.whl"
            dist = "pycparser-2.23.dist-info"
            files = {"pycparser/__init__.py": b"", dist + "/METADATA":
                     b"Metadata-Version: 2.4\nName: pycparser\nVersion: 2.23\nRequires-Python: >=3.8\n",
                     dist + "/WHEEL": b"Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n"}
            builder.write_wheel(path, files, dist)
            self.assertTrue(builder.verify_wheel(path, "pycparser", "2.23", "py3-none-any", True)["recordVerified"])
            corrupt = root / "corrupt.whl"
            with zipfile.ZipFile(path) as source, zipfile.ZipFile(corrupt, "w") as target:
                for item in source.infolist():
                    target.writestr(item, b"tampered" if item.filename == "pycparser/__init__.py" else source.read(item))
            with self.assertRaises(builder.BuildError):
                builder.verify_wheel(corrupt, "pycparser", "2.23", "py3-none-any", True)


class RealArtifactsTests(unittest.TestCase):
    def setUp(self):
        if ARTIFACTS is None:
            self.skipTest("Supply --artifacts to verify an actual cross-build")
        self.root = ARTIFACTS
        self.manifest = json.loads((self.root / "manifest.json").read_text(encoding="utf-8"))

    def test_artifacts_metadata_hashes_abi_symbols_and_runtime_binding(self):
        manifest = self.manifest
        self.assertEqual(manifest["schema"], 1)
        self.assertEqual(manifest["python"], {"version": "3.14.8", "majorMinor": "3.14", "soabi": builder.SOABI,
                                            "minApi": 24, "arch": "arm64-v8a"})
        self.assertEqual(manifest["build"]["runtimeSha256"], builder.RUNTIME_SHA256)
        inputs = {item["path"]: item["sha256"] for item in manifest["runtimeInputs"]}
        for name in ("include/python3.14/Python.h", "include/python3.14/pyconfig.h", "include/ffi.h",
                     "include/ffitarget.h", "lib/libffi.so", "lib/libpython3.14.so", "lib/libandroid-support.so"):
            self.assertIn(name, inputs)
        with tempfile.TemporaryDirectory() as tmp:
            runtime = builder.RuntimeArchive(Path(manifest["build"]["runtimeZip"]), Path(tmp))
            try:
                for name, digest in inputs.items():
                    _, data = runtime.resolve(name)
                    self.assertEqual(hashlib.sha256(data).hexdigest(), digest, name)
            finally:
                runtime.close()
        native = self.root / manifest["native"]["path"]
        self.assertEqual(builder.sha256(native), manifest["native"]["sha256"])
        layout = builder.elf_layout(native.read_bytes())
        self.assertEqual(layout["androidApiNotes"], [24])
        self.assertTrue(layout["pageSize16KiBCompatible"])
        self.assertTrue(layout["gnuRelro"])
        self.assertFalse(layout["executableStack"])
        self.assertEqual(manifest["build"]["symbolChecks"]["unresolvedStrong"], [])
        self.assertGreater(manifest["build"]["symbolChecks"]["libraries"][builder.NATIVE_NAME]["strongUndefinedCount"], 150)
        self.assertFalse(manifest["build"]["verification"]["targetCodeExecuted"])
        self.assertFalse(manifest["build"]["verification"]["deviceTestsPerformed"])
        self.assertFalse(manifest["build"]["dependencyClosure"][builder.NATIVE_NAME]["runpaths"])
        for wheel in manifest["wheels"]:
            path = self.root / wheel["filename"]
            self.assertEqual(builder.sha256(path), wheel["sha256"])
            pure = wheel["name"] == "pycparser"
            builder.verify_wheel(path, wheel["name"], wheel["version"], "py3-none-any" if pure else builder.WHEEL_TAG, pure)
        with zipfile.ZipFile(self.root / builder.CFFI_WHEEL) as zipf:
            self.assertEqual(zipf.read(builder.NATIVE_NAME), native.read_bytes())
            source = Path(manifest["build"]["sourcesDirectory"])
            self.assertEqual(zipf.read("cffi-2.0.0.dist-info/METADATA"), (source / "PKG-INFO").read_bytes())
            for path in (source / "src/cffi").rglob("*"):
                if path.is_file() and path.suffix in (".py", ".h"):
                    self.assertEqual(zipf.read(path.relative_to(source / "src").as_posix()), path.read_bytes())
            for name in ("LICENSE", "AUTHORS"):
                self.assertEqual(zipf.read("cffi-2.0.0.dist-info/licenses/" + name), (source / name).read_bytes())

    def test_repeated_build_native_and_wheels_are_byte_identical(self):
        if COMPARE is None:
            self.skipTest("Supply --compare for independent fresh-directory build reproducibility")
        self.assertNotEqual(self.root.resolve(), COMPARE.resolve())
        other = json.loads((COMPARE / "manifest.json").read_text(encoding="utf-8"))
        self.assertNotEqual(self.manifest["build"]["sourcesDirectory"], other["build"]["sourcesDirectory"])
        self.assertNotEqual(self.manifest["build"]["runtimeInputsDirectory"], other["build"]["runtimeInputsDirectory"])
        names = [builder.NATIVE_NAME] + [wheel["filename"] for wheel in self.manifest["wheels"]]
        for name in names:
            self.assertEqual((self.root / name).read_bytes(), (COMPARE / name).read_bytes(), name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path)
    parser.add_argument("--compare", type=Path)
    options, remaining = parser.parse_known_args()
    ARTIFACTS, COMPARE = options.artifacts, options.compare
    if not sys.flags.isolated:
        parser.error("Run with isolated host Python (-I)")
    unittest.main(argv=[sys.argv[0], *remaining], verbosity=2)
