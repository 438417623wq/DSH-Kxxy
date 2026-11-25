"""Host mock contracts only; not an Android/proot or import verification.
Run: python -I tools/test-python-default.py
"""
import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).parent / "prebuilt/kxxy-tools/python-default.py"
spec = importlib.util.spec_from_file_location("python_default", SOURCE)
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


def elf_bytes(loader=b"/lib/ld-linux-aarch64.so.1"):
    blob = bytearray(256)
    blob[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<Q", blob, 32, 64)
    struct.pack_into("<HH", blob, 54, 56, 1)
    struct.pack_into("<I", blob, 64, 3)
    struct.pack_into("<Q", blob, 72, 128)
    struct.pack_into("<Q", blob, 96, len(loader) + 1)
    blob[128:128 + len(loader)] = loader
    return bytes(blob)


class DefaultPython(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kxxy python spaces ")
        self.addCleanup(self.temp.cleanup)
        self.files = Path(self.temp.name) / "app files"
        self.root = self.files / "engine"
        self.cwd = self.files / "workspace with spaces"
        self.cwd.mkdir(parents=True)
        self.rootfs = self.files / "glibc/rootfs"
        (self.rootfs / "usr/bin").mkdir(parents=True)
        (self.rootfs / ".kxxy-seed").write_text("ready")
        (self.rootfs / "usr/bin/python3").write_bytes(elf_bytes())
        for relative in ("bin/proot", "libexec/proot/loader", "libexec/python-default/kxxy-glibc"):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("mock")
            path.chmod(0o755)
        self.env = {"PATH": str(self.root / "libexec/python-default/bin"), "HOME": "/native home",
                    "PYTHONPATH": "/native/site", "PYTHONHOME": "/native", "LD_PRELOAD": "native-preload",
                    "LD_LIBRARY_PATH": "/wrong abi", "PIP_CONFIG_FILE": "/native pip", "SECRET": "must not enter guest"}
        # Windows drive ':' is not a representable Android/proot bind path.
        # Mock only that OS boundary: all actual list construction remains tested.
        self.real_bind = d.bind_arg
        patch = mock.patch.object(d, "bind_arg", side_effect=lambda host, guest=None: ["-b", str(host) + ":" + str(host if guest is None else guest)])
        patch.start()
        self.addCleanup(patch.stop)

    def call(self, command="python", args=None, venv=None):
        return d.dispatch(self.root, self.files, self.cwd, self.env, command, args or ["-V"], venv, execute=False)

    def test_default_bare_python_glibc_and_unchanged_arguments(self):
        args = ["script with spaces.py", "literal /mnt/kxxy", "--", "data with spaces.csv", "x;$(not shell)"]
        for name in ("python", "python3"):
            argv, env = self.call(name, args)
            self.assertEqual(argv[0], str(self.root / "libexec/python-default/kxxy-glibc"))
            self.assertIn("--require-ready", argv)
            self.assertEqual(argv[-len(args)-1:], ["/usr/bin/python3"] + args)
            self.assertNotIn("provision", " ".join(argv))
            self.assertNotIn("-c", argv)

    def test_same_absolute_cwd_and_files_bind_spaces(self):
        argv, _ = self.call()
        self.assertEqual(argv[argv.index("-w") + 1], str(self.cwd))
        self.assertIn(str(self.cwd) + ":" + str(self.cwd), argv)
        self.assertIn(str(self.files) + ":" + str(self.files), argv)

    def test_environment_isolation_protocol(self):
        argv, env = self.call()
        for key in ("LD_PRELOAD", "PYTHONPATH", "PYTHONHOME"):
            self.assertNotIn(key, env)
        self.assertEqual(env["LD_LIBRARY_PATH"], str(self.root / "lib"))
        values = [argv[i + 1:i + 3] for i, value in enumerate(argv) if value == "--guest-env"]
        self.assertEqual(values, [["HOME", "/root"], ["PATH", d.GUEST_PATH]])
        self.assertNotIn("/native/site", argv)
        self.assertNotIn("/native pip", argv)

    def test_pip_runs_selected_guest_module(self):
        for name in ("pip", "pip3"):
            argv, _ = self.call(name, ["install", "wheel with spaces.whl", "--no-index"])
            self.assertEqual(argv[-6:], ["/usr/bin/python3", "-m", "pip", "install", "wheel with spaces.whl", "--no-index"])

    def test_missing_rootfs_diagnostic_no_side_effects(self):
        (self.rootfs / ".kxxy-seed").unlink()
        with mock.patch.object(d.subprocess, "run") as run:
            with self.assertRaisesRegex(d.DispatchError, "nothing was downloaded"):
                self.call()
            run.assert_not_called()
        self.assertFalse((self.files / "glibc/tmp").exists())

    def test_missing_python_diagnostic_no_provisioning(self):
        (self.rootfs / "usr/bin/python3").unlink()
        with self.assertRaisesRegex(d.DispatchError, "no automatic"):
            self.call()

    def make_native(self):
        native = self.root / "bin/python3.14"
        native.parent.mkdir(parents=True, exist_ok=True)
        native.write_bytes(elf_bytes(b"/system/bin/linker64"))
        native.chmod(0o755)
        return native

    def test_ready_glibc_takes_precedence_over_native_python(self):
        self.make_native()
        argv, _ = self.call("python3", ["-c", "print(1)"])
        self.assertEqual(argv[0], str(self.root / "libexec/python-default/kxxy-glibc"))
        self.assertEqual(argv[-3:], ["/usr/bin/python3", "-c", "print(1)"])

    def test_missing_rootfs_falls_back_to_native_python(self):
        native = self.make_native()
        (self.rootfs / ".kxxy-seed").unlink()
        argv, _ = self.call("python3", ["-c", "print(1)"])
        self.assertEqual(argv, [str(native), "-c", "print(1)"])
        with mock.patch.object(d.os, "execve") as execute:
            d.dispatch(self.root, self.files, self.cwd, self.env, "python3", ["-c", "print(1)"])
        self.assertEqual(execute.call_args.args[0], str(native))
        self.assertEqual(execute.call_args.args[1], [str(native), "-c", "print(1)"])

    def test_native_fallback_pip_and_environment(self):
        native = self.make_native()
        (self.rootfs / "usr/bin/python3").unlink()
        argv, env = self.call("pip", ["install", "openpyxl"])
        self.assertEqual(argv, [str(native), "-m", "pip", "install", "openpyxl"])
        for key in ("LD_PRELOAD", "PYTHONPATH", "PYTHONHOME"):
            self.assertNotIn(key, env)
        # 原生解释器不需要 guest 隔离，调用方的其余环境原样保留。
        self.assertEqual(env["SECRET"], "must not enter guest")
        self.assertEqual(env["LD_LIBRARY_PATH"], "/wrong abi")

    def test_native_fallback_resolves_python_symlink(self):
        native = self.make_native()
        try:
            (self.root / "bin/python3").symlink_to(native.name)
        except (OSError, NotImplementedError):
            self.skipTest("host does not allow symlinks")
        (self.rootfs / ".kxxy-seed").unlink()
        argv, _ = self.call()
        self.assertEqual(argv[0], str(native))
        self.assertEqual(argv[1:], ["-V"])

    def test_require_glibc_env_keeps_hard_failure(self):
        self.make_native()
        self.env["KXXY_PYTHON_REQUIRE_GLIBC"] = "1"
        (self.rootfs / ".kxxy-seed").unlink()
        with self.assertRaisesRegex(d.DispatchError, "native Python instead"):
            self.call()

    def test_explicit_venv_never_falls_back(self):
        self.make_native()
        (self.rootfs / ".kxxy-seed").unlink()
        with self.assertRaisesRegex(d.DispatchError, "nothing was downloaded"):
            self.call(venv=self.cwd / "missing venv")

    def test_exec_inherits_real_streams_and_rc(self):
        with mock.patch.object(d.os, "execve") as execute, mock.patch.object(d.os, "chdir"):
            d.dispatch(self.root, self.files, self.cwd, self.env, "python", ["-c", "raise SystemExit(19)"])
            argv = execute.call_args.args[1]
            self.assertEqual(argv[-2:], ["-c", "raise SystemExit(19)"])
        with mock.patch.object(d.subprocess, "run", return_value=mock.Mock(returncode=19)) as run:
            self.assertEqual(d.wait_command(["mock"], {}), 19)
            run.assert_called_once_with(["mock"], env={})

    def test_native_bionic_activation_first_refusal(self):
        venv = self.cwd / "native venv"
        (venv / "bin").mkdir(parents=True)
        (venv / "pyvenv.cfg").write_text("home = native")
        native = venv / "bin/python"
        native.write_bytes(elf_bytes(b"/system/bin/linker64"))
        native.chmod(0o755)
        self.env["VIRTUAL_ENV"] = str(venv)
        self.env["PATH"] = str(venv / "bin") + os.pathsep + self.env["PATH"]
        (self.rootfs / ".kxxy-seed").unlink()
        argv, env = self.call("pip", ["--version"])
        self.assertEqual(argv, [str(native), "-m", "pip", "--version"])
        self.assertEqual(env, self.env)

    def test_stale_virtual_env_does_not_override_path(self):
        self.env["VIRTUAL_ENV"] = str(self.cwd / "not activated")
        argv, _ = self.call()
        self.assertEqual(argv[-2:], ["/usr/bin/python3", "-V"])

    def test_venv_standard_module_detection(self):
        self.assertIsNone(d.venv_request(["-c", "text", "-m", "venv", "x"]))
        self.assertIsNone(d.venv_request(["script.py", "-m", "venv", "x"]))
        self.assertIsNone(d.venv_request(["-m", "pip", "-m", "venv", "x"]))
        self.assertEqual(d.venv_request(["-I", "-X", "utf8", "-mvenv", "x"]), (["-I", "-X", "utf8"], ["x"]))
        self.assertEqual(d.venv_request(["-IBmvenv", "x"]), (["-I", "-B"], ["x"]))
        self.assertIsNone(d.venv_request(["-IBc", "print(1)", "-m", "venv", "x"]))
        with self.assertRaisesRegex(d.DispatchError, "unsupported Python interpreter"):
            d.venv_request(["--unknown", "-m", "venv", "x"])

    def test_venv_destructive_options_fail_before_side_effects(self):
        for value in ("--clear", "--upgrade", "--upgrade-deps", "--symlinks", "--unknown"):
            target = self.cwd / "fresh target"
            with mock.patch.object(d.subprocess, "run") as run:
                with self.assertRaisesRegex(d.DispatchError, "unsupported option"):
                    self.call(args=["-m", "venv", str(target), value])
                run.assert_not_called()
            self.assertFalse(target.exists())

    def test_venv_existing_target_protected(self):
        target = self.cwd / "existing"
        target.mkdir()
        original = target / "user file.txt"
        original.write_text("keep")
        with self.assertRaisesRegex(d.DispatchError, "refusing to overwrite"):
            self.call(args=["-m", "venv", str(target)])
        self.assertEqual(original.read_text(), "keep")

    def test_fresh_venv_host_launchers_guest_subprocess(self):
        target = self.cwd / "new venv"
        calls = []

        def guest(argv, env):
            calls.append((argv, env))
            if "venv" in argv:
                self.assertIn("--copies", argv)
                (target / "bin").mkdir()
                (target / "lib").mkdir()
                (target / "pyvenv.cfg").write_text("home = /usr/bin\ninclude-system-site-packages = false\n")
                for name in ("python", "python3", "python3.12"):
                    (target / "bin" / name).write_bytes(elf_bytes())
                for name in ("pip", "pip3", "pip3.12"):
                    (target / "bin" / name).write_text("#!" + str(target / "bin/python") + "\nfrom pip import main\n")
            return 0

        with mock.patch.object(d, "wait_command", side_effect=guest):
            self.assertEqual(self.call(args=["-m", "venv", "--prompt", "friendly name", str(target)]), 0)
        self.assertEqual(len(calls), 2)
        probe = calls[1][0]
        self.assertIn("subprocess.check_call([sys.executable", probe[-1])
        self.assertIn(str(target / "bin/python"), probe)
        self.assertIn(str(target / "libexec/kxxy/python") + ":" + str(target / "bin/python"), probe)
        self.assertIn("VIRTUAL_ENV", probe)
        for name in ("python", "python3", "python3.12", "pip", "pip3", "pip3.12"):
            data = (target / "bin" / name).read_text()
            self.assertTrue(data.startswith("#!/system/bin/sh\n"))
            self.assertIn(" --venv ", data)
            self.assertIn(' -- "$@"', data)
            self.assertIn("--command " + ("pip" if name.startswith("pip") else "python"), data)
        self.assertTrue(d.elf(target / "libexec/kxxy/python"))
        self.assertEqual((target / "pyvenv.cfg").read_text().splitlines()[0], "home = /usr/bin")
        self.env["VIRTUAL_ENV"] = str(target)
        self.env["PATH"] = str(target / "bin") + os.pathsep + self.env["PATH"]
        argv, _ = self.call("pip", ["--version"])
        self.assertEqual(argv[-4:], [str(target / "bin/python"), "-m", "pip", "--version"])
        self.assertIn(str(target / "bin") + ":" + d.GUEST_PATH, argv)
        with self.assertRaisesRegex(d.DispatchError, "nested glibc venv"):
            self.call(args=["-m", "venv", str(self.cwd / "nested")])
        self.assertFalse((self.cwd / "nested").exists())
        for args in (["-m", "pip", "install", "--upgrade", "pip"], ["-m", "ensurepip"]):
            with self.assertRaisesRegex(d.DispatchError, "unsupported"):
                self.call(args=args)
        self.env["PATH"] = str(self.root / "libexec/python-default/bin")
        argv, _ = self.call()
        self.assertEqual(argv[-2:], ["/usr/bin/python3", "-V"])

    def test_venv_partial_failure_does_not_claim_success(self):
        target = self.cwd / "failed venv"
        with mock.patch.object(d, "wait_command", return_value=23):
            self.assertEqual(self.call(args=["-m", "venv", str(target)]), 23)
        self.assertFalse((target / d.PRIVATE / d.MARKER).exists())

    def test_untrusted_guest_venv_not_overwritten(self):
        target = self.cwd / "unsafe venv"
        target.mkdir()
        (target / "bin").mkdir()
        (target / "lib").mkdir()
        (target / "pyvenv.cfg").write_text("home = /untrusted")
        original = target / "bin/python"
        original.write_text("do not overwrite")
        with self.assertRaisesRegex(d.DispatchError, "unexpected glibc venv base"):
            d.prepare_venv(self.root, target, d.identity(target))
        self.assertEqual(original.read_text(), "do not overwrite")

    def test_proot_colon_path_rejected(self):
        with self.assertRaises(d.DispatchError):
            self.real_bind("/data/a:b")

    def test_guest_symlink_resolution_not_host_usr(self):
        # Exercise symlink-coordinate logic without relying on Windows symlink privilege.
        root = Path("/rootfs")
        with mock.patch.object(Path, "is_symlink", side_effect=lambda: False):
            self.assertEqual(d.guest_file(root, "/usr/bin/../bin/python3"), root / "usr/bin/python3")


if __name__ == "__main__":
    unittest.main(verbosity=2)
