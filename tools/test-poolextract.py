#!/usr/bin/env python3
"""Isolated stdlib regressions; run python -I tools/test-poolextract.py."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).resolve().parent / "lib" / "poolextract.py"
SPEC = importlib.util.spec_from_file_location("poolextract_under_test", MODULE_PATH)
poolextract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(poolextract)
PREFIX = "/data/data/com.termux/files/usr/"


class MaterializeLinksTests(unittest.TestCase):
    def test_relative_absolute_and_multihop_files(self):
        value = (b"payload", 0o755)
        merged = {"lib/real.so": value}
        links = {"bin/tool": PREFIX + "lib/link0.so"}
        links.update({f"lib/link{i}.so": f"link{i + 1}.so" for i in range(12)})
        links["lib/link12.so"] = "real.so"
        self.assertEqual(poolextract.materialize_links(merged, links), {})
        for path in links:
            self.assertEqual(merged[path], value)

    def test_multihop_directories_wait_for_nested_file_aliases(self):
        value = (b"shared", 0o644)
        links = {
            "dest": "middle",
            "middle": "source",
            "source/nested/alias": "../../payload",
            "source/nested/chain": "alias",
            "consumer": "dest/nested/chain",
        }
        for ordered_links in (links, dict(reversed(list(links.items())))):
            merged = {"payload": value, "source/plain": (b"plain", 0o600)}
            self.assertEqual(poolextract.materialize_links(merged, ordered_links), {})
            for root in ("source", "middle", "dest"):
                self.assertEqual(merged[root + "/nested/alias"], value)
                self.assertEqual(merged[root + "/nested/chain"], value)
            self.assertEqual(merged["consumer"], value)
            self.assertEqual(merged["dest/plain"], (b"plain", 0o600))

    def test_links_through_directory_alias_and_nested_directory_alias(self):
        value = (b"nested", 0o755)
        merged = {"payload/item": value}
        links = {
            "copy": "source",
            "through": "copy/nested/item",
            "source/nested": "../payload",
        }
        self.assertEqual(poolextract.materialize_links(merged, links), {})
        self.assertEqual(merged["source/nested/item"], value)
        self.assertEqual(merged["copy/nested/item"], value)
        self.assertEqual(merged["through"], value)

    def test_actual_neovim_parser_alias_layout(self):
        languages = ("c", "lua", "markdown", "markdown_inline", "query", "vim", "vimdoc")
        merged = {}
        # The directory link is deliberately first, before its source aliases.
        links = {"share/nvim/runtime/parser": PREFIX + "lib/tree_sitter"}
        for index, language in enumerate(languages):
            base = "lib/libtree-sitter-" + language + ".so"
            merged[base + ".15.0"] = (b"\x7fELF\x00" + bytes([index]), 0o755)
            links["lib/tree_sitter/" + language + ".so"] = "../libtree-sitter-" + language + ".so"
            links[base] = "libtree-sitter-" + language + ".so.15"
            links[base + ".15"] = "libtree-sitter-" + language + ".so.15.0"
        for name in ("c", "lua", "query", "vim"):
            merged["share/nvim/runtime/ftplugin/" + name + ".vim"] = (b"original " + name.encode(), 0o644)
        original = dict(merged)
        self.assertEqual(poolextract.materialize_links(merged, links), {})
        for language in languages:
            value = original["lib/libtree-sitter-" + language + ".so.15.0"]
            self.assertEqual(merged["lib/tree_sitter/" + language + ".so"], value)
            self.assertEqual(merged["share/nvim/runtime/parser/" + language + ".so"], value)
        for path, value in original.items():
            self.assertEqual(merged[path], value)

    def test_directory_prefix_boundary_and_preserve_destination_files(self):
        merged = {
            "source/item": (b"source", 0o755),
            "source/nested/item": (b"nested", 0o600),
            "source-other/leak": (b"wrong", 0o644),
            "dest/item": (b"keep", 0o644),
        }
        self.assertEqual(poolextract.materialize_links(merged, {"dest": "source"}), {})
        self.assertEqual(merged["dest/item"], (b"keep", 0o644))
        self.assertEqual(merged["dest/nested/item"], (b"nested", 0o600))
        self.assertNotIn("dest-other/leak", merged)
        self.assertNotIn("dest/leak", merged)

    def test_explicit_file_wins_over_link(self):
        merged = {"dest": (b"keep", 0o644), "source": (b"source", 0o755)}
        self.assertEqual(poolextract.materialize_links(merged, {"dest": "source"}), {})
        self.assertEqual(merged["dest"], (b"keep", 0o644))

    def test_file_and_directory_conflicts_are_atomic(self):
        cases = [
            ({"source/a": (b"a", 0o644), "source/blocked/b": (b"b", 0o644),
              "dest/blocked": (b"keep", 0o644)}, {"dest": "source"}),
            ({"source": (b"a", 0o644), "dest/child": (b"keep", 0o644)},
             {"dest": "source"}),
            ({"source/a": (b"a", 0o644), "parent": (b"keep", 0o644)},
             {"parent/dest": PREFIX + "source"}),
        ]
        for merged, links in cases:
            with self.subTest(links=links):
                original = dict(merged)
                self.assertEqual(poolextract.materialize_links(merged, links), links)
                self.assertEqual(merged, original)

    def test_cycles_and_ancestor_self_links_remain_unresolved(self):
        merged = {"source/file": (b"safe", 0o644)}
        links = {
            "a": "b", "b": "a", "self": "self",
            "source/parent": "..", "source/ancestor": ".",
            "source/child": "child/nested",
            "source/same": "same", "dir1/alias": "../dir2",
            "dir2/alias": "../dir1",
        }
        original = dict(merged)
        self.assertEqual(poolextract.materialize_links(merged, links), links)
        self.assertEqual(merged, original)

    def test_unresolved_descendant_defers_directory_copy(self):
        merged = {"source/file": (b"safe", 0o644)}
        links = {"dest": "source", "source/missing": "missing-target"}
        self.assertEqual(poolextract.materialize_links(merged, links), links)
        self.assertNotIn("dest/file", merged)

    def test_expansion_bound(self):
        merged = {"source/a": (b"a", 0o644), "source/b": (b"b", 0o644)}
        original = dict(merged)
        links = {"dest": "source"}
        self.assertEqual(poolextract.materialize_links(merged, links, max_files=3), links)
        self.assertEqual(merged, original)
        self.assertEqual(poolextract.materialize_links(merged, links, max_files=4), {})
        self.assertEqual(len(merged), 4)

    def test_stage_files_directories_and_destination_precedence(self):
        with tempfile.TemporaryDirectory(prefix="poolextract-test-") as directory:
            root = Path(directory)
            payload = b"stage payload"
            digest = hashlib.sha256(payload).hexdigest()
            blob = root / "blobs" / digest[:2] / digest
            blob.parent.mkdir(parents=True)
            blob.write_bytes(payload)
            entries = [
                {"path": "stage/nested/file", "type": "file", "sha256": digest, "mode": 0o755},
                {"path": "empty", "type": "dir"},
                {"path": "bad/../path", "type": "file", "sha256": digest},
            ]
            (root / "entries.json").write_text(json.dumps({"entries": entries}), encoding="utf-8")
            stage, blobs = poolextract.load_stage(str(root))
            self.assertNotIn("bad/../path", stage)
            merged = {"copy/nested/file": (b"keep", 0o600)}
            links = {"file": PREFIX + "stage/nested/file", "copy": "stage", "empty-copy": "empty"}
            self.assertEqual(poolextract.materialize_links(merged, links, stage, blobs), {})
            self.assertEqual(merged["file"], (payload, 0o755))
            self.assertEqual(merged["copy/nested/file"], (b"keep", 0o600))
            self.assertNotIn("empty-copy", merged)
            merged = {"stage/nested/file": (b"pool wins", 0o644)}
            self.assertEqual(poolextract.materialize_links(merged, {"copy": "stage"}, stage, blobs), {})
            self.assertEqual(merged["copy/nested/file"], (b"pool wins", 0o644))

    def test_missing_and_unsafe_stage_blobs_do_not_escape(self):
        with tempfile.TemporaryDirectory(prefix="poolextract-test-") as directory:
            for digest in ("../outside", "0" * 64):
                with self.subTest(digest=digest):
                    merged = {}
                    stage = {"stage/file": {"type": "file", "sha256": digest}}
                    links = {"copy": "stage"}
                    self.assertEqual(poolextract.materialize_links(merged, links, stage, directory), links)
                    self.assertEqual(merged, {})

    def test_unsafe_merged_paths_are_rejected(self):
        with self.assertRaises(ValueError):
            poolextract.materialize_links({"../outside": (b"bad", 0o644)}, {})


class NormalizeTargetTests(unittest.TestCase):
    def test_normalizes_in_root_relative_and_absolute_paths(self):
        cases = {
            "../lib/./file": "lib/file",
            PREFIX + "lib/../share/file": "share/file",
            "./data/data/com.termux/files/usr/lib/file": "lib/file",
            "../lib/sub/../file": "lib/file",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(poolextract.normalize_target("bin/link", raw), expected)

    def test_external_traversal_root_and_platform_paths_are_rejected(self):
        targets = (
            "/etc/passwd", "/data/data/com.termux/files/usr-other/lib/file",
            "/data/data/com.termux/files/usr", PREFIX + "../home/file",
            PREFIX + "../../usr/file", "../../outside", "../../usr/file",
            "../", "", "C:/outside", "..\\outside", "file\x00name",
        )
        for raw in targets:
            with self.subTest(raw=raw):
                self.assertIsNone(poolextract.normalize_target("bin/link", raw))
        for path in ("../link", "/link", "bin//link", "bin/./link", "bin\\link", "C:/link"):
            with self.subTest(path=path):
                self.assertIsNone(poolextract.normalize_target(path, "target"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
