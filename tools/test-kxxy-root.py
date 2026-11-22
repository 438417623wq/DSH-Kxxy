#!/usr/bin/env python3
import importlib.util
import shlex
import unittest
from pathlib import Path


PATH = Path(__file__).resolve().parent / "prebuilt" / "kxxy-tools" / "kxxy-root.py"
SPEC = importlib.util.spec_from_file_location("kxxy_root", PATH)
root = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(root)


class RootBridgeTest(unittest.TestCase):
    def test_fixed_operation_commands(self):
        base = "/engine root"
        self.assertEqual(root.target_command(base, "ln", ["a", "b"]),
                         [root.os.path.join(base, "bin", "coreutils"),
                          "--coreutils-prog=ln", "a", "b"])
        self.assertEqual(root.target_command(base, "rsync", ["-a", "a/", "b/"]),
                         [root.os.path.join(base, "bin", "rsync"), "-a", "a/", "b/"])
        perf = root.target_command(base, "perf", ["stat", "--", "true"])
        self.assertEqual(perf[1:3], ["-I", root.os.path.join(
            base, "libexec", "kxxy-tools", "perf.py")])
        self.assertEqual(root.target_command(base, "exec", ["--", "/x/y", "a"]), ["/x/y", "a"])
        # `bin/kxxy-root` 与文档写法各带一层 `--`，双层也得剥干净
        self.assertEqual(root.target_command(base, "exec", ["--", "--", "/x/y"]), ["/x/y"])
        with self.assertRaises(ValueError):
            root.target_command(base, "exec", ["--"])
        with self.assertRaises(ValueError):
            root.target_command(base, "exec", ["--", "--"])
        with self.assertRaises(ValueError):
            root.target_command(base, "unknown", [])

    def test_su_command_round_trips_arbitrary_arguments(self):
        args = ["record", "-o", "a b;$(touch nope)\n雪", "--", "/system/bin/true"]
        command = root.su_shell_command("/engine root", "perf", args, "10398:10398")
        words = shlex.split(command)
        self.assertEqual(words[:3], ["exec", "env", "-i"])
        marker = words.index("--root-active")
        self.assertEqual(words[marker + 1], "perf")
        self.assertEqual(words[marker + 2:], args)
        self.assertIn("KXXY_PERF_MODE=pmu", words)
        self.assertIn("KXXY_ROOT_OWNER=10398:10398", words)
        self.assertFalse(any(word.startswith("LD_PRELOAD=") for word in words))
        self.assertFalse(any(word.startswith("PYTHONPATH=") for word in words))

    def test_root_environment_is_fixed(self):
        env = root.root_environment("/engine", "rsync", "1:2")
        self.assertEqual(set(env), {"HOME", "PATH", "LD_LIBRARY_PATH", "KXXY_ROOT_OWNER"})
        self.assertNotIn("KXXY_PERF_MODE", env)


if __name__ == "__main__":
    unittest.main()
