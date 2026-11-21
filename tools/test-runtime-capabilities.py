#!/usr/bin/env python3
"""Local native hardlink and mocked command regressions; python -I tools/test-runtime-capabilities.py."""
import ast
import contextlib
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parent / "probe-runtime-capabilities.py"
SPEC = importlib.util.spec_from_file_location("capabilities_under_test", MODULE_PATH)
capabilities = importlib.util.module_from_spec(SPEC)
previous = sys.dont_write_bytecode
try:
    sys.dont_write_bytecode = True
    SPEC.loader.exec_module(capabilities)
finally:
    sys.dont_write_bytecode = previous


def command_output(code=0, stdout="", stderr=""):
    return {"status": "pass" if code == 0 else "fail", "code": code, "stdout": stdout, "stderr": stderr}


class RuntimeCapabilityTests(unittest.TestCase):
    def test_native_hardlink_survival_restore_and_reject_emulation(self):
        with tempfile.TemporaryDirectory(prefix="kxxy-capabilities-test-") as directory:
            scratch = Path(directory)
            result = capabilities.link_probe(scratch / "missing-engine", scratch, "os.link")
            self.assertEqual(result["status"], "pass", result)
            self.assertTrue(result["true_hardlink"])
            self.assertTrue(result["unlink_source_survives"])
            self.assertTrue(result["source_restored"])
            self.assertEqual(result["source"]["ino"], result["destination"]["ino"])
            self.assertGreaterEqual(result["source"]["nlink"], 2)
            source, copied = scratch / "source", scratch / "copied"
            source.write_bytes(b"payload")
            copied.write_bytes(b"payload")
            rejected = capabilities.verify_link(source, copied, b"payload")
            self.assertEqual(rejected["status"], "fail")
            self.assertFalse(rejected["true_hardlink"])
            real = capabilities.file_info(source)
            fake = dict(real, is_symlink=True, is_regular=False, nlink=2)
            with mock.patch.object(capabilities, "file_info", side_effect=[dict(real, nlink=2), fake]):
                rejected = capabilities.verify_link(source, copied, b"payload")
            self.assertEqual(rejected["status"], "fail")
            self.assertFalse(rejected["true_hardlink"])

    def test_native_ln_rsync_commands_and_exact_matched_attributes(self):
        with tempfile.TemporaryDirectory(prefix="kxxy-capabilities-test-") as directory:
            scratch = Path(directory)
            root = scratch / "engine"
            root.mkdir()
            seen = []
            def execute(argv, cwd, timeout=45):
                seen.append(argv)
                self.assertEqual(cwd, scratch)
                if Path(argv[0]).name == "coreutils":
                    self.assertEqual(argv[1], "--coreutils-prog=ln")
                    os.link(argv[2], argv[3])
                else:
                    self.assertEqual(argv[1], "-a")
                    self.assertTrue(argv[2].startswith("--link-dest="))
                    base = Path(argv[2].split("=", 1)[1]) / "item"
                    source = Path(argv[3]) / "item"
                    dest = Path(argv[4]) / "item"
                    self.assertEqual(source.read_bytes(), base.read_bytes())
                    for key in ("mode", "uid", "gid", "size", "mtime_ns"):
                        self.assertEqual(capabilities.file_info(source)[key], capabilities.file_info(base)[key])
                    os.link(base, dest)
                return command_output()
            with mock.patch.object(capabilities, "installed", return_value={"status": "pass"}), \
                    mock.patch.object(capabilities, "run_command", side_effect=execute):
                ln = capabilities.link_probe(root, scratch, "ln")
                rsync = capabilities.link_probe(root, scratch, "rsync")
            self.assertEqual(ln["status"], "pass", ln)
            self.assertEqual(rsync["status"], "pass", rsync)
            self.assertTrue(rsync["matched_attributes"])
            self.assertTrue(rsync["destination_matched_attributes"])
            self.assertEqual(seen[0][0], str(root / "bin/coreutils"))
            self.assertEqual(seen[1][0], str(root / "bin/rsync"))
            self.assertEqual(capabilities.installed(root / "bin/absent")["status"], "skip")

    def test_default_python_uses_real_path_no_environment_substitution_and_preserves_output(self):
        with tempfile.TemporaryDirectory(prefix="kxxy-capabilities-test-") as directory:
            scratch = Path(directory)
            info = json.dumps({"executable": "/usr/bin/python3", "prefix": "/venv", "soabi": "cpython-314-aarch64-linux-gnu"})
            numerical = json.dumps({"prediction": [7.0], "resized_shape": [2, 2]})
            raw = info + "\n" + numerical + "\n"
            with mock.patch.object(capabilities.shutil, "which", return_value="/engine/default-bin/python3") as which, \
                    mock.patch.object(capabilities.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, raw, "actual warning")) as run:
                result = capabilities.python_probe(scratch / "engine", scratch, True)
            which.assert_called_once_with("python3")
            self.assertEqual(result["status"], "pass")
            self.assertEqual(result["resolved_command"], "/engine/default-bin/python3")
            self.assertEqual(result["PATH"], os.environ.get("PATH", ""))
            self.assertEqual(result["stdout"], raw)
            self.assertEqual(result["stderr"], "actual warning")
            self.assertEqual(run.call_args.args[0][:4], ["python3", "-I", "-B", "-c"])
            self.assertNotIn("env", run.call_args.kwargs)
            self.assertFalse(run.call_args.kwargs.get("shell", False))
            self.assertIn("LinearRegression().fit", run.call_args.args[0][4])
            self.assertIn("cv2.resize", run.call_args.args[0][4])
            with mock.patch.object(capabilities.subprocess, "run", side_effect=PermissionError(errno.EACCES, "denied")):
                denied = capabilities.run_command(["python3"], scratch)
            self.assertEqual(denied["status"], "fail")
            self.assertEqual(denied["errno"], errno.EACCES)
            with mock.patch.object(capabilities.shutil, "which", return_value=None):
                missing = capabilities.python_probe(scratch, scratch, True)
            self.assertEqual(missing["status"], "skip")
            self.assertIn("python3 absent", missing["reason"])
            with mock.patch.object(capabilities, "read_metadata", return_value={"status": "skip"}), \
                    mock.patch.object(capabilities.sysconfig, "get_platform", return_value="linux-aarch64"), \
                    mock.patch.object(capabilities.sysconfig, "get_config_var", return_value="cpython-314-aarch64-linux-gnu"):
                caller = capabilities.process_info()
            self.assertEqual(caller["build_platform"], "linux-aarch64")
            self.assertEqual(caller["soabi"], "cpython-314-aarch64-linux-gnu")
            self.assertEqual(caller["sys_platform"], sys.platform)
            self.assertIn("do not prove native execution or real root", caller["runtime_context_note"])
            self.assertNotIn("is_root", caller)
            child_output = io.StringIO()
            with contextlib.redirect_stdout(child_output):
                exec(capabilities.SELF_INFO, {})
            child_metadata = json.loads(child_output.getvalue())
            self.assertIn("soabi", child_metadata)
            self.assertIn("build_platform", child_metadata)
            self.assertIn("sys_platform", child_metadata)

    def test_perf_keeps_actual_results_distinguishes_zero_and_no_counter_and_owns_writes(self):
        with tempfile.TemporaryDirectory(prefix="kxxy-capabilities-test-") as directory:
            scratch = Path(directory)
            root = scratch / "engine"
            seen = []
            def execute(argv, cwd, timeout=45):
                seen.append(argv)
                self.assertEqual(cwd, scratch)
                if argv[-1] != "true":
                    target = Path(argv[-1])
                    self.assertEqual(target.parent, scratch)
                    target.write_text('{"elapsed": 2.0}', encoding="utf-8")
                return command_output(0, "", "perf record: 3 个样本 → owned\n") if argv[1] == "record" else command_output(0, "Performance counter stats\n", "")
            with mock.patch.object(capabilities, "installed", return_value={"status": "pass"}), \
                    mock.patch.object(capabilities, "run_command", side_effect=execute):
                for record in (False, True):
                    for load in (False, True):
                        result = capabilities.perf_probe(root, scratch, record, load)
                        self.assertEqual(result["status"], "pass", result)
            self.assertEqual(seen[0], [str(root / "bin/perf"), "stat", "--", "true"])
            self.assertEqual(seen[2], [str(root / "bin/perf"), "record", "-o", os.devnull, "--", "true"])
            self.assertEqual(Path(seen[3][3]).parent, scratch)
            self.assertEqual(seen[1][-5:-2], [sys.executable, "-I", "-B"])
            zero = capabilities.classify_perf(command_output(0, "", "perf record: 0 个样本 → /dev/null\n"), True)
            self.assertEqual(zero["status"], "fail")
            self.assertTrue(zero["zero_samples"])
            self.assertFalse(zero["no_counters"])
            denied = capabilities.classify_perf(command_output(1, "", "perf stat: 没有可用计数器\nerrno=1\n"), False)
            self.assertTrue(denied["no_counters"])
            self.assertFalse(denied["zero_samples"])
            self.assertEqual(denied["code"], 1)
            self.assertEqual(denied["stderr"], "perf stat: 没有可用计数器\nerrno=1\n")
            with mock.patch.object(capabilities, "installed", return_value={"status": "pass"}), \
                    mock.patch.object(capabilities, "run_command", side_effect=lambda *args, **kwargs: command_output(0, "", "perf record: 0 个样本 → /dev/null\n")):
                short = capabilities.perf_probe(root, scratch, True, False)
                load = capabilities.perf_probe(root, scratch, True, True)
            self.assertEqual(short["status"], "skip")
            self.assertTrue(short["zero_samples"])
            self.assertFalse(short["no_counters"])
            self.assertIn("load determines capability", short["reason"])
            self.assertEqual(load["status"], "fail")

    def test_cleanup_failures_overall_exit_and_read_only_contract(self):
        with tempfile.TemporaryDirectory(prefix="kxxy-capabilities-test-") as directory:
            parent = Path(directory)
            sentinel = parent / "outside-probe"
            sentinel.write_bytes(b"KEEP")
            def collect(root, scratch):
                self.assertEqual(scratch.parent, parent)
                (scratch / "owned").write_bytes(b"test")
                return {"blocked_device_operation": {"status": "fail", "errno": errno.EPERM}, "missing_tool": {"status": "skip"}}
            with mock.patch.object(capabilities, "collect", side_effect=collect):
                report = capabilities.probe(parent / "engine", parent)
            self.assertEqual(report["status"], "fail")
            self.assertEqual(report["counts"], {"pass": 1, "fail": 1, "skip": 1})
            self.assertTrue(report["checks"]["scratch_cleanup"]["removed"])
            self.assertFalse(Path(report["scratch"]).exists())
            self.assertEqual(list(parent.iterdir()), [sentinel])
            self.assertEqual(sentinel.read_bytes(), b"KEEP")
            with mock.patch.object(capabilities, "collect", return_value={"process": {"status": "skip"}}):
                unverified = capabilities.probe(parent, parent)
            self.assertEqual(unverified["status"], "unverified")
            self.assertIn("default_python", unverified["unverified_required_checks"])
            with mock.patch.object(capabilities, "probe", return_value=unverified), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(capabilities.main(["--root", str(parent), "--scratch-parent", str(parent)]), 1)
            passing = {name: {"status": "pass"} for name in unverified["unverified_required_checks"]}
            passing.update({"process": {"status": "skip"}, "perf_record_true": {"status": "skip", "zero_samples": True}})
            with mock.patch.object(capabilities, "collect", return_value=passing):
                self.assertEqual(capabilities.probe(parent, parent)["status"], "pass")
            with mock.patch.object(capabilities.tempfile, "mkdtemp", side_effect=PermissionError(errno.EACCES, "not writable")):
                denied = capabilities.probe(parent, parent)
            self.assertEqual(denied["status"], "fail")
            output = io.StringIO()
            with mock.patch.object(capabilities, "probe", return_value=denied), contextlib.redirect_stdout(output):
                self.assertEqual(capabilities.main(["--root", str(parent), "--scratch-parent", str(parent)]), 1)
            self.assertEqual(json.loads(output.getvalue())["status"], "fail")
            with mock.patch.object(capabilities.Path, "read_text", side_effect=PermissionError(errno.EACCES, "blocked metadata")):
                self.assertEqual(capabilities.read_metadata("/proc/self/attr/current")["status"], "fail")
            tree = ast.parse(MODULE_PATH.read_text(encoding="utf-8"))
            calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)]
            prohibited = {"chmod", "chown", "setuid", "setgid", "system", "putenv"}
            self.assertFalse(any(isinstance(call.func, ast.Attribute) and call.func.attr in prohibited for call in calls))
            self.assertFalse(any(isinstance(call.func, ast.Attribute) and call.func.attr == "run" and
                                 any(keyword.arg in ("env", "shell") for keyword in call.keywords) for call in calls))
            for name in ("CPU_LOAD", "PYTHON_CAPABILITIES", "SELF_INFO"):
                compile(getattr(capabilities, name), "<" + name + ">", "exec")


if __name__ == "__main__":
    unittest.main(verbosity=2)
