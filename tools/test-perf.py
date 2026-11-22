#!/usr/bin/env python3
"""Mock-only perf regressions; run python -I tools/test-perf.py. No real perf syscalls."""
import contextlib
import ctypes
import errno
import importlib.util
import io
import os
from pathlib import Path
import struct
import sys
from types import SimpleNamespace
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parent / "prebuilt" / "kxxy-tools" / "perf.py"
SPEC = importlib.util.spec_from_file_location("perf_under_test", MODULE_PATH)
perf = importlib.util.module_from_spec(SPEC)
# The target is Android/Linux; supply just its import-time platform values on Windows.
with mock.patch.object(os, "uname", return_value=SimpleNamespace(machine="aarch64"), create=True), \
        mock.patch.object(os, "sysconf", return_value=4096, create=True):
    previous = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        SPEC.loader.exec_module(perf)
    finally:
        sys.dont_write_bytecode = previous


class PerfDiagnosticsTests(unittest.TestCase):
    def invoke(self, command, argv, errors, mode="pmu"):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(contextlib.redirect_stdout(stdout))
            stack.enter_context(contextlib.redirect_stderr(stderr))
            stack.enter_context(mock.patch.dict(os.environ, {"KXXY_PERF_MODE": mode}))
            patches = {
                "perf_open": mock.Mock(side_effect=errors),
                "ev_ioctl": mock.Mock(),
                "spawn_stopped": mock.Mock(return_value=1234),
                "resume": mock.Mock(),
                "reap": mock.Mock(return_value=0),
                "kill_child": mock.Mock(),
                "Ring": mock.Mock(),
            }
            for name, value in patches.items():
                stack.enter_context(mock.patch.object(perf, name, value))
            patches["sleep"] = stack.enter_context(mock.patch.object(perf.time, "sleep"))
            patches["read"] = stack.enter_context(mock.patch.object(perf.os, "read", return_value=struct.pack("<Q", 42)))
            patches["close"] = stack.enter_context(mock.patch.object(perf.os, "close"))
            patches["open"] = stack.enter_context(mock.patch("builtins.open"))
            result = getattr(perf, "cmd_" + command)(argv)
        return result, stdout.getvalue(), stderr.getvalue(), patches

    def assert_failure(self, line, command, event, error, etype, config, pid, attr_flags):
        self.assertIn(f"perf {command}: {event}: perf_event_open failed:", line)
        self.assertIn(f"errno={error.errno} ({errno.errorcode[error.errno]}: {error.strerror})", line)
        self.assertIn(f"type={etype} config={config} pid={pid} cpu=-1", line)
        self.assertIn(f"attr_flags=0x{attr_flags:x}", line)
        self.assertIn(f"exclude_kernel={int(bool(attr_flags & (1 << perf.B_EXCL_KERNEL)))} flags=0x0", line)

    def test_libc_keeps_use_errno_and_immediate_errno_capture(self):
        error = errno.EACCES
        syscall = mock.Mock(side_effect=lambda *args: ctypes.set_errno(error) or -1)
        lib = SimpleNamespace(syscall=syscall)
        blob = perf.attr_blob(perf.SW, 1, bits=[perf.B_DISABLED])
        with mock.patch.object(ctypes, "CDLL", return_value=lib) as loader:
            ctypes.set_errno(errno.EINVAL)
            with self.assertRaises(OSError) as caught:
                perf.perf_open(blob, pid=1234)
        loader.assert_called_once_with("libc.so", use_errno=True)
        self.assertEqual(caught.exception.errno, error)
        self.assertEqual(caught.exception.strerror, os.strerror(error))
        self.assertIs(syscall.restype, ctypes.c_long)
        self.assertEqual(len(syscall.argtypes), 6)

    def test_stat_reports_both_failures_without_verbose(self):
        for codes in ((errno.EPERM, errno.EACCES), (errno.EINVAL, errno.ENOSYS), (errno.ESRCH, errno.EOPNOTSUPP)):
            with self.subTest(codes=codes):
                errors = [OSError(code, os.strerror(code)) for code in codes]
                result, stdout, stderr, calls = self.invoke("stat", ["-e", "task-clock", "-p", "4321"], errors)
                self.assertEqual(result, 1)
                self.assertEqual(stdout, "")
                lines = stderr.splitlines()
                self.assertEqual(len(lines), 3)
                self.assert_failure(lines[0], "stat", "task-clock", errors[0], perf.SW, 1, 4321, 1)
                self.assert_failure(lines[1], "stat", "task-clock", errors[1], perf.SW, 1, 4321, 33)
                self.assertIn("没有可用计数器", lines[2])
                self.assertNotIn("内核/sepolicy 拒绝", stderr)
                self.assertEqual(calls["perf_open"].call_count, 2)
                calls["sleep"].assert_called_once_with(3.0)

    def test_stat_multiple_failed_events_keep_each_context(self):
        errors = [OSError(errno.EINVAL, "first invalid"), OSError(errno.EPERM, "second denied")] * 2
        result, _, stderr, _ = self.invoke("stat", ["-e", "cycles,instructions", "-p", "4321"], errors)
        self.assertEqual(result, 1)
        lines = stderr.splitlines()
        self.assert_failure(lines[0], "stat", "cycles", errors[0], perf.HW, 0, 4321, 1)
        self.assert_failure(lines[1], "stat", "cycles", errors[1], perf.HW, 0, 4321, 33)
        self.assert_failure(lines[2], "stat", "instructions", errors[2], perf.HW, 1, 4321, 1)
        self.assert_failure(lines[3], "stat", "instructions", errors[3], perf.HW, 1, 4321, 33)

    def test_stat_failed_child_still_resumes_and_reaps(self):
        errors = [OSError(errno.EPERM, "denied"), OSError(errno.EACCES, "denied again")]
        result, _, stderr, calls = self.invoke("stat", ["-e", "cycles", "--", "true"], errors)
        self.assertEqual(result, 1)
        self.assertIn("pid=1234 cpu=-1", stderr)
        calls["spawn_stopped"].assert_called_once_with(["true"])
        calls["resume"].assert_called_once_with(1234)
        calls["reap"].assert_called_once_with(1234)
        calls["kill_child"].assert_not_called()

    def test_stat_all_cpus_is_rejected_before_any_spawn(self):
        for option in ("-a", "--all-cpus"):
            with self.subTest(option=option):
                result, stdout, stderr, calls = self.invoke("stat", [option, "--", "true"], [])
                self.assertEqual(result, 2)
                self.assertEqual(stdout, "")
                self.assertIn(option, stderr)
                self.assertIn("未实现系统范围计数", stderr)
                calls["spawn_stopped"].assert_not_called()
                calls["perf_open"].assert_not_called()

    def test_stat_user_only_fallback_succeeds_and_verbose_keeps_first_failure(self):
        error = OSError(errno.EPERM, "denied kernel")
        result, stdout, stderr, calls = self.invoke("stat", ["-v", "-e", "task-clock", "-p", "4321"], [error, 17])
        self.assertEqual(result, 0)
        self.assertIn("不含内核态", stdout)
        self.assert_failure(stderr.strip(), "stat", "task-clock", error, perf.SW, 1, 4321, 1)
        self.assertEqual(calls["perf_open"].call_count, 2)
        calls["read"].assert_called_once_with(17, 8)
        calls["close"].assert_called_once_with(17)

    def test_stat_nonverbose_success_is_quiet_and_closes_default_counters(self):
        fds = list(range(20, 20 + len(perf.DEFAULT_STAT)))
        result, stdout, stderr, calls = self.invoke("stat", ["--", "true"], fds)
        self.assertEqual(result, 0)
        self.assertIn("Performance counter stats", stdout)
        self.assertEqual(stderr, "")
        self.assertEqual(calls["close"].call_args_list, [mock.call(fd) for fd in fds])
        calls["resume"].assert_called_once_with(1234)
        calls["reap"].assert_called_once_with(1234)

    def test_stat_partial_success_still_reports_unavailable_event(self):
        errors = [OSError(errno.EINVAL, "invalid"), OSError(errno.ENOSYS, "unavailable")]
        result, stdout, stderr, calls = self.invoke("stat", ["-e", "cycles,task-clock", "-p", "4321"], errors + [18])
        self.assertEqual(result, 0)
        self.assertIn("task-clock", stdout)
        self.assertNotIn("没有可用计数器", stderr)
        self.assertEqual(stderr.count("perf_event_open failed"), 2)
        calls["close"].assert_called_once_with(18)

    def test_record_reports_both_frequency_attempts_and_cleans_child(self):
        errors = [OSError(errno.EINVAL, "unsupported attribute"), OSError(errno.EPERM, "not permitted")]
        result, stdout, stderr, calls = self.invoke("record", ["-F", "99", "-g", "--", "true"], errors)
        self.assertEqual(result, 1)
        self.assertEqual(stdout, "")
        lines = stderr.splitlines()
        self.assertEqual(len(lines), 3)
        self.assert_failure(lines[0], "record", "cpu-clock", errors[0], perf.SW, 0, 1234, 9985)
        self.assert_failure(lines[1], "record", "cpu-clock", errors[1], perf.SW, 0, 1234, 10017)
        for call in calls["perf_open"].call_args_list:
            attr = call.args[0]
            self.assertEqual(struct.unpack_from("<Q", attr, 16)[0], 99)
            self.assertEqual(struct.unpack_from("<Q", attr, 24)[0], 39)
        calls["kill_child"].assert_called_once_with(1234)
        calls["resume"].assert_not_called()
        calls["Ring"].assert_not_called()
        calls["open"].assert_not_called()
        self.assertIn("没有可用采样事件", lines[2])
        self.assertNotIn("内核/sepolicy 拒绝", stderr)

    def test_record_period_failure_has_no_frequency_bit_and_does_not_kill_attached_pid(self):
        errors = [OSError(errno.EACCES, "access denied"), OSError(errno.ENOSYS, "no syscall")]
        result, _, stderr, calls = self.invoke("record", ["-c", "7", "-e", "instructions", "-p", "4321"], errors)
        self.assertEqual(result, 1)
        lines = stderr.splitlines()
        self.assert_failure(lines[0], "record", "instructions", errors[0], perf.HW, 1, 4321, 8961)
        self.assert_failure(lines[1], "record", "instructions", errors[1], perf.HW, 1, 4321, 8993)
        for call in calls["perf_open"].call_args_list:
            self.assertEqual(struct.unpack_from("<Q", call.args[0], 16)[0], 7)
        calls["kill_child"].assert_not_called()
        calls["spawn_stopped"].assert_not_called()
        calls["open"].assert_not_called()

    def test_record_successful_fallback_preserves_first_failure_and_closes_counter(self):
        error = OSError(errno.EPERM, "denied kernel")
        ring = mock.Mock()
        output = mock.mock_open()
        def files(name, *args, **kwargs):
            if str(name).startswith("/proc/"):
                raise FileNotFoundError(name)
            return output(name, *args, **kwargs)
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(contextlib.redirect_stdout(stdout))
            stack.enter_context(contextlib.redirect_stderr(stderr))
            opener = stack.enter_context(mock.patch.object(perf, "perf_open", side_effect=[error, 19]))
            stack.enter_context(mock.patch.object(perf, "Ring", return_value=ring))
            ioctl = stack.enter_context(mock.patch.object(perf, "ev_ioctl"))
            closer = stack.enter_context(mock.patch.object(perf.os, "close"))
            stack.enter_context(mock.patch.object(perf.time, "time", side_effect=[0.0, 1.0, 1.0]))
            stack.enter_context(mock.patch("builtins.open", side_effect=files))
            result = perf.cmd_record(["-p", "4321", "--duration", "0.01"])
        self.assertEqual(result, 0)
        self.assertEqual(opener.call_count, 2)
        self.assert_failure(stderr.getvalue().splitlines()[0], "record", "cpu-clock", error, perf.SW, 0, 4321, 9985)
        self.assertIn("0 个样本", stderr.getvalue())
        self.assertEqual(ioctl.call_args_list, [mock.call(19, perf.PERF_IOC_ENABLE), mock.call(19, perf.PERF_IOC_DISABLE)])
        ring.close.assert_called_once_with()
        closer.assert_called_once_with(19)
        output.assert_called_once_with("perf.data", "w", encoding="utf-8")

    def test_kill_child_uses_sigkill_and_waitpid(self):
        import signal
        with mock.patch.object(signal, "SIGKILL", 9, create=True), \
                mock.patch.object(perf.os, "kill") as kill, \
                mock.patch.object(perf.os, "waitpid", create=True) as wait:
            perf.kill_child(1234)
        kill.assert_called_once_with(1234, 9)
        wait.assert_called_once_with(1234, 0)

    def test_header_does_not_guarantee_counter_availability(self):
        self.assertNotIn("SW/HW 事件都返回正常 fd", perf.__doc__)
        self.assertIn("以现场系统调用结果为准", perf.__doc__)

    # ── 降级路径：应用域拿不到 PMU 时仍要有结果 ──────────────────────────
    def test_stat_falls_back_to_rusage_when_policy_denies_every_event(self):
        errors = [OSError(errno.EACCES, "denied"), OSError(errno.EACCES, "denied")]
        with mock.patch.object(perf, "stat_fallback", return_value=0) as fallback:
            result, _, _, calls = self.invoke("stat", ["-e", "cycles", "--", "true"],
                                              errors, mode="auto")
        self.assertEqual(result, 0)
        fallback.assert_called_once()
        self.assertEqual(fallback.call_args.args[0], 1234)      # 子进程交给降级路径
        self.assertEqual(fallback.call_args.args[3], "true")
        # 子进程必须由降级路径 resume+wait4，不能在这里被提前 reap 掉
        calls["reap"].assert_not_called()
        calls["resume"].assert_not_called()

    def test_stat_explicit_fallback_mode_skips_perf_event_open(self):
        with mock.patch.object(perf, "stat_fallback", return_value=0) as fallback:
            result, _, _, calls = self.invoke("stat", ["--", "true"], [], mode="fallback")
        self.assertEqual(result, 0)
        calls["perf_open"].assert_not_called()
        fallback.assert_called_once()

    def test_stat_pmu_mode_still_fails_loudly(self):
        errors = [OSError(errno.EACCES, "denied"), OSError(errno.EACCES, "denied")]
        result, _, stderr, _ = self.invoke("stat", ["-e", "cycles", "--", "true"], errors)
        self.assertEqual(result, 1)
        self.assertIn("没有可用计数器", stderr)

    def test_record_falls_back_to_ptrace_with_the_command(self):
        errors = [OSError(errno.EACCES, "denied"), OSError(errno.EACCES, "denied")]
        with mock.patch.object(perf, "record_fallback", return_value=0) as fallback:
            result, _, _, calls = self.invoke("record", ["--", "true"], errors, mode="auto")
        self.assertEqual(result, 0)
        fallback.assert_called_once()
        self.assertEqual(fallback.call_args.kwargs["cmd"], ["true"])
        self.assertEqual(fallback.call_args.args[0], 1234)
        calls["kill_child"].assert_not_called()

    def test_record_explicit_fallback_mode_spawns_traced_child(self):
        with mock.patch.object(perf, "record_fallback", return_value=0) as fallback, \
                mock.patch.object(perf, "spawn_traced", return_value=777) as traced:
            result, _, _, calls = self.invoke("record", ["--", "true"], [], mode="fallback")
        self.assertEqual(result, 0)
        traced.assert_called_once_with(["true"])
        calls["spawn_stopped"].assert_not_called()
        self.assertEqual(fallback.call_args.args[0], 777)

    def test_pc_index_matches_import_architecture(self):
        self.assertEqual(perf.MACHINE, "aarch64")
        self.assertEqual(perf._pc_index(), 32)      # user_pt_regs.pc 在 32*8

    def test_stat_fallback_explicit_hardware_only_returns_failure(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(perf, "proc_cpu", return_value=(1.0, 0.5, 3, 1)), \
                mock.patch.object(perf, "proc_switches", return_value={"voluntary_ctxt_switches": 2}), \
                mock.patch.object(perf.time, "sleep"), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = perf.stat_fallback(None, 4321, 0.1, "pid 4321", [],
                                        attempted=False, requested=["cycles"])
        self.assertEqual(result, 1)
        self.assertIn("需要 PMU", err.getvalue())
        self.assertIn("cycles", err.getvalue())
        self.assertNotIn("task-clock", out.getvalue())

    def test_stat_fallback_partial_explicit_reports_only_available(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(perf, "proc_cpu", return_value=(1.0, 0.5, 3, 1)), \
                mock.patch.object(perf, "proc_switches", return_value={"voluntary_ctxt_switches": 2}), \
                mock.patch.object(perf.time, "sleep"), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = perf.stat_fallback(None, 4321, 0.1, "pid 4321", [],
                                        attempted=False,
                                        requested=["cycles", "task-clock", "major-faults"])
        self.assertEqual(result, 0)
        self.assertIn("task-clock", out.getvalue())
        self.assertIn("major-faults", out.getvalue())
        self.assertNotIn("page-faults", out.getvalue())
        self.assertIn("cycles", err.getvalue())

    def test_list_separates_pmu_failure_from_fallback_capability(self):
        out = io.StringIO()
        denied = OSError(errno.EACCES, "denied")
        with mock.patch.object(perf, "perf_open", side_effect=denied), \
                mock.patch.object(perf, "current_domain", return_value="u:r:untrusted_app_27:s0"), \
                contextlib.redirect_stdout(out):
            result = perf.cmd_list([])
        text = out.getvalue()
        self.assertEqual(result, 0)
        self.assertIn("✗ EACCES", text)
        self.assertIn("stat:rusage//proc", text)
        self.assertIn("record:ptrace", text)
        self.assertIn("PMU 全部 ✗ 只表示", text)
        self.assertIn("untrusted_app_27", text)

    def test_record_exit_status_preserves_target_and_pid_zero_sample_semantics(self):
        with mock.patch.multiple(
                perf.os,
                WIFSIGNALED=mock.Mock(side_effect=lambda s: s == 9),
                WTERMSIG=mock.Mock(return_value=9),
                WIFEXITED=mock.Mock(side_effect=lambda s: s != 9),
                WEXITSTATUS=mock.Mock(side_effect=lambda s: s >> 8),
                create=True):
            self.assertEqual(perf.sampled_exit_status(0, False, True), 0)
            self.assertEqual(perf.sampled_exit_status(7 << 8, True, True), 7)
            self.assertEqual(perf.sampled_exit_status(9, False, True), 128 + 9)
            self.assertEqual(perf.sampled_exit_status(None, True, False), 0)
            self.assertEqual(perf.sampled_exit_status(None, False, False), 1)

    def test_report_prints_fallback_mode_header(self):
        data = "\n".join([
            "#kxxy-perf 1",
            "#label true",
            "#event cpu-clock",
            "#mode ptrace-fallback",
            "#elapsed 0.100",
            "C 1 true",
            "M 400000 1000 0 /bin/true",
            "S 400000 1 1 400000",
        ]) + "\n"
        with mock.patch("builtins.open", mock.mock_open(read_data=data)):
            with mock.patch.object(perf, "symbolize", return_value=("main", 0, "/bin/true")):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    result = perf.cmd_report(["-i", "x"])
        self.assertEqual(result, 0)
        self.assertIn("ptrace-fallback", out.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
