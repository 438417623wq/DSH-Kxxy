#!/usr/bin/env python3
"""Stdlib-only regressions: python -I tools/test-kxxy-rsync.py.

Optional native rsync integration: set KXXY_TEST_RSYNC to a host executable.
No Android, policy changes or full runtime builds are involved.
"""
import contextlib
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parent / "prebuilt" / "kxxy-tools" / "kxxy-rsync.py"
SPEC = importlib.util.spec_from_file_location("kxxy_rsync_guard", SCRIPT)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kxxy-rsync-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.basis = self.root / "basis with spaces"
        self.dest = self.root / "destination with spaces"
        self.source = self.root / "source"
        for directory in (self.basis, self.dest, self.source):
            directory.mkdir()
        self.real = str(self.root / "native rsync")
        self.args = ["-a", "--link-dest", str(self.basis), str(self.source) + "/", str(self.dest)]

    def run_guard(self, args=None, env=None, probe=None, execute=None):
        stderr = io.StringIO()
        with patch.dict(os.environ, env or {}, clear=True), \
                patch.object(guard.os, "execv", side_effect=execute) as execv, \
                contextlib.redirect_stderr(stderr):
            if probe is None:
                rc = guard.main([self.real] + (self.args if args is None else args))
            else:
                with patch.object(guard, "probe_hardlinks", return_value=probe) as prober:
                    rc = guard.main([self.real] + (self.args if args is None else args))
                execv.prober = prober
        return rc, stderr.getvalue(), execv

    def test_native_probe_has_real_identity_and_cleans_only_its_files(self):
        user = self.basis / "user-data"
        user.write_bytes(b"do not link this file")
        original = user.stat()
        before = sorted(self.basis.iterdir()), sorted(self.dest.iterdir())
        calls = []
        native_link = os.link
        native_lstat = os.lstat
        observed = []

        def link(source, destination):
            calls.append((source, destination))
            self.assertEqual(Path(source).parent, self.basis)
            self.assertEqual(Path(destination).parent, self.dest)
            self.assertNotEqual(Path(source), user)
            self.assertFalse(Path(destination).exists())
            native_link(source, destination)

        def lstat(path, *args, **kwargs):
            result = native_lstat(path, *args, **kwargs)
            observed.append(result)
            return result

        with patch.object(guard.os, "link", side_effect=link), \
                patch.object(guard.os, "lstat", side_effect=lstat):
            supported, problem = guard.probe_hardlinks(str(self.basis), str(self.dest))
        self.assertTrue(supported, problem)
        self.assertEqual(len(calls), 1)
        self.assertGreaterEqual(len(observed), 2)
        self.assertEqual((observed[0].st_dev, observed[0].st_ino),
                         (observed[1].st_dev, observed[1].st_ino))
        self.assertGreaterEqual(observed[0].st_nlink, 2)
        self.assertEqual(before, (sorted(self.basis.iterdir()), sorted(self.dest.iterdir())))
        self.assertEqual(user.read_bytes(), b"do not link this file")
        self.assertEqual(user.stat().st_nlink, original.st_nlink)

    def test_eacces_and_exdev_probe_fail_and_clean_source(self):
        for code in (errno.EACCES, errno.EXDEV, errno.EPERM, errno.ENOSYS):
            with self.subTest(code=code), patch.object(guard.os, "link", side_effect=OSError(code, "denied")):
                supported, problem = guard.probe_hardlinks(str(self.basis), str(self.dest))
            self.assertFalse(supported)
            self.assertIn("probe failed", problem)
            self.assertEqual(list(self.basis.iterdir()), [])
            self.assertEqual(list(self.dest.iterdir()), [])

    def test_os_link_missing_bionic_fallback_reports_gracefully(self):
        # 部分 Android 原生解释器没有 os.link（bionic 构建裁掉了）：探针必须
        # 退到 libc link(2) 兜底；兜底也不可用时报"能力不可用"，绝不裸崩。
        with patch.object(guard.os, "link",
                          side_effect=AttributeError("module 'os' has no attribute 'link'")), \
                patch("ctypes.CDLL",
                      side_effect=OSError("libc.so not loadable in this test env")):
            supported, problem = guard.probe_hardlinks(str(self.basis), str(self.dest))
        self.assertFalse(supported)
        self.assertIn("probe failed", problem)
        self.assertEqual(list(self.basis.iterdir()), [])
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_unwritable_basis_does_not_assume_another_directory_supports_links(self):
        with patch.object(guard.tempfile, "mkstemp", side_effect=PermissionError(errno.EACCES, "read-only basis")), \
                patch.object(guard.os, "link") as link:
            supported, problem = guard.probe_hardlinks(str(self.basis), str(self.dest))
        self.assertFalse(supported)
        self.assertIn("read-only basis", problem)
        link.assert_not_called()
        self.assertEqual(list(self.basis.iterdir()), [])
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_eexist_does_not_remove_someone_elses_destination(self):
        other = self.dest / ".kxxy-link-probe-fixed"
        other.write_bytes(b"owned by someone else")
        with patch.object(guard.secrets, "token_hex", return_value="fixed"):
            supported, problem = guard.probe_hardlinks(str(self.basis), str(self.dest))
        self.assertFalse(supported)
        self.assertIsNotNone(problem)
        self.assertEqual(other.read_bytes(), b"owned by someone else")
        self.assertEqual(list(self.basis.iterdir()), [])

    def test_probe_cleanup_failure_is_not_advertised_as_support(self):
        native_unlink = os.unlink
        failed_path = []

        def unlink(path):
            if Path(path).parent == self.dest:
                failed_path.append(path)
                raise PermissionError(errno.EACCES, "cleanup denied")
            return native_unlink(path)

        try:
            with patch.object(guard.os, "unlink", side_effect=unlink):
                supported, problem = guard.probe_hardlinks(str(self.basis), str(self.dest))
            self.assertFalse(supported)
            self.assertIn("cleanup failed", problem)
            self.assertEqual(list(self.basis.iterdir()), [])
        finally:
            for path in failed_path:
                native_unlink(path)  # Only the self-created probe left by this test.
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_lstat_failure_still_cleans_both_probe_files(self):
        with patch.object(guard.os, "lstat", side_effect=OSError(errno.EIO, "stat failed")):
            supported, problem = guard.probe_hardlinks(str(self.basis), str(self.dest))
        self.assertFalse(supported)
        self.assertIn("stat failed", problem)
        self.assertEqual(list(self.basis.iterdir()), [])
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_a_copy_or_symbolic_link_cannot_fabricate_hardlink_support(self):
        native_lstat = os.lstat
        for faulty in ("inode", "device", "nlink", "symlink", "zero-inode"):
            def wrong(path, *args, **kwargs):
                result = native_lstat(path, *args, **kwargs)
                attrs = {name: getattr(result, name) for name in
                         ("st_mode", "st_dev", "st_ino", "st_nlink")}
                if Path(path).parent == self.dest:
                    if faulty == "inode":
                        attrs["st_ino"] += 1
                    elif faulty == "device":
                        attrs["st_dev"] += 1
                    elif faulty == "nlink":
                        attrs["st_nlink"] = 1
                    elif faulty == "symlink":
                        attrs["st_mode"] = stat.S_IFLNK | 0o777
                    else:
                        attrs["st_ino"] = 0
                return types.SimpleNamespace(**attrs)
            with self.subTest(faulty=faulty), patch.object(guard.os, "lstat", side_effect=wrong):
                supported, problem = guard.probe_hardlinks(str(self.basis), str(self.dest))
            self.assertFalse(supported)
            self.assertIn("device/inode/nlink", problem)
            self.assertEqual(list(self.basis.iterdir()), [])
            self.assertEqual(list(self.dest.iterdir()), [])

    def test_strict_allows_real_supported_directory_and_keeps_argv(self):
        rc, stderr, execute = self.run_guard(env={"KXXY_RSYNC_LINK_STRICT": "1"})
        self.assertEqual(rc, 0)
        self.assertEqual(stderr, "")
        execute.assert_called_once_with(self.real, [self.real] + self.args)
        self.assertEqual(list(self.basis.iterdir()), [])
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_strict_wins_over_warn_copy_fallback_and_quiet(self):
        for mode in ("warn", "copy", "fallback", "", "unknown"):
            with self.subTest(mode=mode):
                rc, stderr, execute = self.run_guard(
                    env={"KXXY_RSYNC_LINK_STRICT": "1", "KXXY_RSYNC_LINK_MODE": mode,
                         "KXXY_RSYNC_QUIET": "1"}, probe=(False, "EACCES"))
                self.assertEqual(rc, 1)
                self.assertIn("strict", stderr)
                execute.assert_not_called()

    def test_symlink_mode_rejected_before_probe_or_transfer_even_without_link_dest(self):
        for args in (self.args, [], ["--dry-run", "src/", "dst/"]):
            for strict in ("0", "1"):
                with self.subTest(args=args, strict=strict):
                    rc, stderr, execute = self.run_guard(args=args, env={
                        "KXXY_RSYNC_LINK_MODE": "symlink", "KXXY_RSYNC_LINK_STRICT": strict,
                        "KXXY_RSYNC_QUIET": "1"}, probe=(True, None))
                    self.assertEqual(rc, 1)
                    self.assertIn("disabled", stderr)
                    execute.assert_not_called()
                    execute.prober.assert_not_called()

    def test_warn_failure_is_transparent_and_quiet_only_hides_warning(self):
        for quiet in ("0", "1"):
            rc, stderr, execute = self.run_guard(env={"KXXY_RSYNC_QUIET": quiet},
                                                probe=(False, "denied"))
            self.assertEqual(rc, 0)
            self.assertEqual(bool(stderr), quiet == "0")
            execute.assert_called_once_with(self.real, [self.real] + self.args)

    def test_dry_run_creates_no_probe_files_or_output_tree(self):
        for flag in ("-n", "-anv", "--dry-run"):
            for strict in ("0", "1"):
                with self.subTest(flag=flag, strict=strict), \
                        patch.object(guard.tempfile, "mkstemp", side_effect=AssertionError("dry-run wrote")), \
                        patch.object(guard.os, "link", side_effect=AssertionError("dry-run linked")):
                    rc, stderr, execute = self.run_guard(args=[flag] + self.args,
                                                        env={"KXXY_RSYNC_LINK_STRICT": strict})
                    self.assertEqual(rc, int(strict))
                    self.assertIn("dry-run", stderr)
                    self.assertEqual(execute.call_count, 1 - int(strict))
            self.assertEqual(list(self.basis.iterdir()), [])
            self.assertEqual(list(self.dest.iterdir()), [])

    def test_option_operands_are_not_paths_or_options(self):
        options = ["-e", "--rsh", "--exclude", "--include", "--filter", "-f",
                   "--files-from", "--out-format", "--backup-dir", "--partial-dir",
                   "--temp-dir", "--bwlimit", "--chmod", "--log-file"]
        for option in options:
            for value in ("--link-dest=/false-basis", "--dry-run", "--"):
                with self.subTest(option=option, value=value):
                    parsed = guard.parse_arguments([option, value] + self.args)
                    self.assertIsNone(parsed.problem)
                    self.assertEqual(parsed.link_dests, [str(self.basis)])
                    self.assertEqual(parsed.paths, [str(self.source) + "/", str(self.dest)])
                    self.assertFalse(parsed.dry_run)
                    rc, stderr, execute = self.run_guard(args=[option, value] + self.args,
                                                        env={"KXXY_RSYNC_LINK_STRICT": "1"},
                                                        probe=(True, None))
                    self.assertEqual(rc, 0)
                    self.assertEqual(stderr, "")
                    execute.assert_called_once_with(self.real, [self.real, option, value] + self.args)

    def test_attached_short_operands_and_double_dash_preserved(self):
        for option in ("-avzP", "-e--dry-run", "-f--link-dest=/ignored", "-B128", "-T/tmp/n"):
            parsed = guard.parse_arguments([option] + self.args)
            self.assertIsNone(parsed.problem)
            self.assertFalse(parsed.dry_run)
            self.assertEqual(parsed.link_dests, [str(self.basis)])
        args = ["--", "--link-dest=/literal-source", "--dry-run"]
        parsed = guard.parse_arguments(args)
        self.assertEqual(parsed.paths, args[1:])
        self.assertFalse(parsed.dry_run)
        self.assertFalse(parsed.possible_link_dest)
        rc, stderr, execute = self.run_guard(args=args, env={"KXXY_RSYNC_LINK_STRICT": "1"},
                                            probe=(False, "must not probe"))
        self.assertEqual(rc, 0)
        self.assertEqual(stderr, "")
        execute.prober.assert_not_called()
        execute.assert_called_once_with(self.real, [self.real] + args)

    def test_known_operands_remain_opaque_even_if_later_option_is_unknown(self):
        args = ["--exclude", "--link-dest=/not-an-option", "--future", "src/", "dst/"]
        parsed = guard.parse_arguments(args)
        self.assertIsNotNone(parsed.problem)
        self.assertFalse(parsed.possible_link_dest)
        rc, stderr, execute = self.run_guard(args=args, env={"KXXY_RSYNC_LINK_STRICT": "1"},
                                            probe=(False, "must not probe"))
        self.assertEqual(rc, 0)
        self.assertEqual(stderr, "")
        execute.prober.assert_not_called()
        execute.assert_called_once_with(self.real, [self.real] + args)

    def test_dry_run_flags_in_operand_not_interpreted(self):
        parsed = guard.parse_arguments(["-en"] + self.args)
        self.assertFalse(parsed.dry_run)
        parsed = guard.parse_arguments(["-n", "--no-dry-run"] + self.args)
        self.assertFalse(parsed.dry_run)
        parsed = guard.parse_arguments(["--dry-run", "--no-n"] + self.args)
        self.assertFalse(parsed.dry_run)

    def test_unknown_and_abbreviated_options_are_unverified_not_mutated(self):
        for args in (["--future", "operand"] + self.args,
                     ["--future", "--link-dest=operand", "src/", "dst/"],
                     ["--future", "--", "--link-dest=" + str(self.basis), str(self.source), str(self.dest)],
                     ["--link-des=" + str(self.basis), str(self.source), str(self.dest)],
                     ["-Q"] + self.args,
                     ["--link-dest"],
                     ["--dry-run=yes"] + self.args,
                     ["--remote-option", "--link-dest=/remote"] + self.args):
            for strict in ("0", "1"):
                with self.subTest(args=args, strict=strict):
                    rc, stderr, execute = self.run_guard(args=args,
                        env={"KXXY_RSYNC_LINK_STRICT": strict}, probe=(True, None))
                    self.assertEqual(rc, int(strict))
                    self.assertTrue(stderr)
                    execute.prober.assert_not_called()
                    if strict == "0":
                        execute.assert_called_once_with(self.real, [self.real] + args)
                    else:
                        execute.assert_not_called()

    def test_remote_missing_or_non_directory_destination_never_probe(self):
        regular = self.root / "output-file"
        regular.write_bytes(b"unchanged")
        cases = [
            self.args[:-1] + ["host:/remote/dst"],
            self.args[:-2] + ["host:/remote/src", str(self.dest)],
            self.args[:-2] + ["rsync://host/module/src", str(self.dest)],
            self.args[:-1] + [str(self.dest / "missing")],
            self.args[:-1] + [str(regular)],
            ["--link-dest=host:/basis", str(self.source), str(self.dest)],
            ["--link-dest=missing-basis", str(self.source), str(self.dest)],
        ]
        for args in cases:
            for strict in ("0", "1"):
                with self.subTest(args=args, strict=strict):
                    rc, stderr, execute = self.run_guard(args=args,
                        env={"KXXY_RSYNC_LINK_STRICT": strict}, probe=(True, None))
                    self.assertEqual(rc, int(strict))
                    self.assertTrue(stderr)
                    execute.prober.assert_not_called()
                    self.assertEqual(execute.call_count, 1 - int(strict))
        self.assertEqual(regular.read_bytes(), b"unchanged")
        self.assertFalse((self.dest / "missing").exists())

    def test_relative_and_multiple_link_dests_use_actual_receiver_directory(self):
        second = self.root / "second"
        second.mkdir()
        args = ["--link-dest=../" + self.basis.name, "--link-dest", str(second)] + self.args[3:]
        parsed = guard.parse_arguments(args)
        candidates, problem = guard.local_candidates(parsed)
        self.assertIsNone(problem)
        self.assertEqual(candidates, [(str(self.basis.resolve()), str(self.dest.resolve())),
                                      (str(second.resolve()), str(self.dest.resolve()))])
        rc, stderr, execute = self.run_guard(args=args, env={"KXXY_RSYNC_LINK_STRICT": "1"},
                                            probe=(True, None))
        self.assertEqual(rc, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(execute.prober.call_count, 2)
        execute.assert_called_once_with(self.real, [self.real] + args)
        with patch.object(guard, "probe_hardlinks", side_effect=[(True, None), (False, "denied")]), \
                patch.object(guard.os, "execv") as execute, \
                patch.dict(os.environ, {"KXXY_RSYNC_LINK_STRICT": "1"}, clear=True), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(guard.main([self.real] + args), 1)
            execute.assert_not_called()

    def test_symlink_directory_resolves_to_actual_probe_directory(self):
        alias = self.root / "basis-alias"
        try:
            alias.symlink_to(self.basis, target_is_directory=True)
        except OSError as error:
            self.skipTest("host cannot create directory symlink: " + str(error))
        parsed = guard.parse_arguments(["--link-dest=" + str(alias)] + self.args[3:])
        candidates, problem = guard.local_candidates(parsed)
        self.assertIsNone(problem)
        self.assertEqual(candidates, [(str(self.basis.resolve()), str(self.dest.resolve()))])

    def test_deleted_or_excluded_basis_files_never_recreated(self):
        (self.basis / "deleted").write_bytes(b"old version")
        (self.basis / "excluded").write_bytes(b"private")
        (self.dest / "deleted").write_bytes(b"stale")
        args = ["--delete", "--delete-excluded", "--exclude", "excluded"] + self.args

        def native(real, argv):
            self.assertEqual(argv, [real] + args)
            (self.dest / "deleted").unlink()  # Self-created test data only.
            (self.dest / "kept").write_bytes(b"rsync output")

        rc, stderr, execute = self.run_guard(args=args, probe=(False, "denied"), execute=native)
        self.assertEqual(rc, 0)
        self.assertIn("unchanged", stderr)
        self.assertFalse((self.dest / "deleted").exists())
        self.assertFalse((self.dest / "excluded").exists())
        self.assertEqual((self.dest / "kept").read_bytes(), b"rsync output")
        self.assertFalse(hasattr(guard, "linkify"))
        execute.assert_called_once()

    def test_exec_error_and_no_native_arguments(self):
        for error, expected in ((FileNotFoundError(errno.ENOENT, "missing"), 127),
                                (PermissionError(errno.EACCES, "denied"), 126)):
            rc, stderr, execute = self.run_guard(args=[], execute=error)
            self.assertEqual(rc, expected)
            self.assertIn("cannot execute", stderr)
            execute.assert_called_once_with(self.real, [self.real])

    @unittest.skipIf(os.name == "nt", "Windows CRT execv is not POSIX exec; target runtime is Android")
    def test_real_process_retains_argv_stdout_stderr_and_failure_status(self):
        code = ("import json,os,sys; "
                "os.write(1,json.dumps(sys.argv[1:],ensure_ascii=False).encode('utf-8')); "
                "os.write(2,b'native-stderr-no-newline'); sys.exit(23)")
        args = ["", "space operand", "--link-dest=/literal", "--", "-s", "line\nbreak", "雪"]
        env = dict(os.environ)
        for name in ("KXXY_RSYNC_LINK_MODE", "KXXY_RSYNC_LINK_STRICT", "KXXY_RSYNC_QUIET"):
            env.pop(name, None)
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), sys.executable,
                                 "-I", "-c", code, "--"] + args,
                                capture_output=True, env=env)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(result.stderr, b"native-stderr-no-newline")
        self.assertEqual(json.loads(result.stdout), ["--"] + args)

    @unittest.skipUnless(os.environ.get("KXXY_TEST_RSYNC"), "no native host rsync supplied")
    def test_optional_native_rsync_deleted_excluded_and_dry_run(self):
        real = os.environ["KXXY_TEST_RSYNC"]
        (self.basis / "deleted").write_bytes(b"old")
        (self.basis / "excluded").write_bytes(b"private")
        (self.dest / "deleted").write_bytes(b"stale")
        (self.source / "included").write_bytes(b"current")
        env = dict(os.environ, KXXY_RSYNC_LINK_MODE="warn", KXXY_RSYNC_LINK_STRICT="0")
        args = ["-a", "--delete", "--delete-excluded", "--exclude", "excluded",
                "--link-dest=" + str(self.basis), str(self.source) + "/", str(self.dest) + "/"]
        command = [sys.executable, "-I", str(SCRIPT), real]
        dry = subprocess.run(command + ["--dry-run"] + args, env=env, capture_output=True)
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertEqual(sorted(path.name for path in self.dest.iterdir()), ["deleted"])
        result = subprocess.run(command + args, env=env, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(path.name for path in self.dest.iterdir()), ["included"])
        self.assertEqual((self.dest / "included").read_bytes(), b"current")
        self.assertEqual(sorted(path.name for path in self.basis.iterdir()), ["deleted", "excluded"])

    # ── 显式符号链接去重（KXXY_RSYNC_DEDUP=symlink）──────────────────────
    def test_dedup_replaces_only_identical_files_and_keeps_basis_untouched(self):
        for directory, name, payload in (
            (self.basis, "same.txt", b"x" * 100),
            (self.basis, "diff.txt", b"a" * 100),
            (self.dest, "same.txt", b"x" * 100),
            (self.dest, "diff.txt", b"b" * 101),
        ):
            (directory / name).write_bytes(payload)
            os.utime(directory / name, (1700000000, 1700000000))
        replaced, kept = guard.dedup_symlink(str(self.basis), str(self.dest))
        self.assertEqual((replaced, kept), (1, 1))
        self.assertTrue((self.dest / "same.txt").is_symlink())
        # stat 跟随链接 → 与基准同 inode；lstat 仍能看出是软链
        self.assertEqual((self.dest / "same.txt").stat().st_ino,
                         (self.basis / "same.txt").stat().st_ino)
        self.assertFalse((self.dest / "diff.txt").is_symlink())
        self.assertFalse((self.basis / "same.txt").is_symlink())

    def test_dedup_never_recreates_files_missing_from_destination(self):
        (self.basis / "removed.txt").write_bytes(b"gone")
        (self.basis / "excluded").write_bytes(b"private")
        replaced, kept = guard.dedup_symlink(str(self.basis), str(self.dest))
        self.assertEqual((replaced, kept), (0, 0))
        self.assertEqual(sorted(p.name for p in self.dest.iterdir()), [])

    def test_dedup_copies_then_linkifies_and_skips_exec(self):
        (self.source / "f.txt").write_bytes(b"data")

        def fake_call(argv):
            (self.dest / "f.txt").write_bytes(b"data")
            os.utime(self.dest / "f.txt", (1700000000, 1700000000))
            (self.basis / "f.txt").write_bytes(b"data")
            os.utime(self.basis / "f.txt", (1700000000, 1700000000))
            return 0

        with patch.object(subprocess, "call", side_effect=fake_call) as call:
            rc, err, execv = self.run_guard(
                env={"KXXY_RSYNC_DEDUP": "symlink"},
                probe=(False, "native hard-link probe failed: denied"))
        self.assertEqual(rc, 0)
        self.assertIn("去重完成", err)
        call.assert_called_once()
        execv.assert_not_called()
        self.assertTrue((self.dest / "f.txt").is_symlink())

    def test_dedup_skipped_on_dry_run_and_keeps_native_exec(self):
        rc, _, execv = self.run_guard(
            args=["-a", "-n", "--link-dest", str(self.basis),
                  str(self.source) + "/", str(self.dest)],
            env={"KXXY_RSYNC_DEDUP": "symlink"},
            probe=(False, "denied"))
        execv.assert_called_once()
        self.assertEqual(rc, 0)

    def test_dedup_skipped_when_hardlinks_really_work(self):
        rc, err, execv = self.run_guard(env={"KXXY_RSYNC_DEDUP": "symlink"},
                                        probe=(True, None))
        execv.assert_called_once()
        self.assertNotIn("去重完成", err)

    def test_failed_transfer_does_not_linkify(self):
        def fake_call(argv):
            return 23

        with patch.object(subprocess, "call", side_effect=fake_call):
            rc, err, _ = self.run_guard(env={"KXXY_RSYNC_DEDUP": "symlink"},
                                        probe=(False, "denied"))
        self.assertEqual(rc, 23)
        self.assertNotIn("去重完成", err)


if __name__ == "__main__":
    unittest.main(verbosity=2)
