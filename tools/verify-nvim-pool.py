#!/usr/bin/env python3
"""只用缓存 deb 重打 shells 到新目录，验证 parser 内容与原始 ftplugin。"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile


LANGUAGES = ("c", "lua", "markdown", "markdown_inline", "query", "vim", "vimdoc")
FTPLUGINS = ("markdown", "lua", "help", "query")
RUNTIME = "share/nvim/runtime/"


def file_bytes(archive, name):
    member = archive.getmember(name)
    if not member.isfile():
        raise AssertionError(f"not a physical file: {name}")
    with archive.extractfile(member) as fh:
        return fh.read()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--spec", required=True, type=Path)
    ap.add_argument("--debs", required=True, type=Path)
    ap.add_argument("--stage", required=True, type=Path)
    ap.add_argument("--original-pool", required=True, type=Path)
    ap.add_argument("--out-parent", required=True, type=Path)
    args = ap.parse_args()
    with args.spec.open(encoding="utf-8") as fh:
        spec = json.load(fh)
    shells = [item for item in spec["items"] if item["id"] == "shells"]
    if len(shells) != 1:
        raise AssertionError("expected exactly one shells entry")
    out = Path(tempfile.mkdtemp(prefix="nvim-parser-validation-", dir=args.out_parent.resolve()))
    spec_path = out / "spec.json"
    spec_path.write_text(json.dumps({"items": shells}), encoding="utf-8")
    script = Path(__file__).resolve().parent / "lib" / "poolextract.py"
    subprocess.run([
        sys.executable, "-I", str(script), "--debs", str(args.debs.resolve()),
        "--spec", str(spec_path), "--stage", str(args.stage.resolve()),
        "--out", str(out), "--report", str(out / "report.json"),
    ], check=True, cwd=script.parent.parent)
    result = {"pool": str(out / "shells.pool"), "parsers": {}, "ftpluginsUnchanged": [],
              "deviceLoadVerified": False}
    with tarfile.open(out / "shells.pool", "r:gz") as new, tarfile.open(args.original_pool, "r:gz") as old:
        for lang in LANGUAGES:
            parser = file_bytes(new, RUNTIME + "parser/" + lang + ".so")
            source = "lib/tree_sitter/" + lang + ".so"
            if parser != file_bytes(new, source) or parser != file_bytes(old, source):
                raise AssertionError(f"parser content changed: {lang}")
            if parser[:4] != b"\x7fELF" or parser[4:6] != b"\x02\x01":
                raise AssertionError(f"not ELF64 little endian: {lang}")
            if int.from_bytes(parser[18:20], "little") != 183:
                raise AssertionError(f"not AArch64: {lang}")
            symbol = ("tree_sitter_" + lang).encode("ascii") + b"\x00"
            if symbol not in parser:
                raise AssertionError(f"missing language symbol: {lang}")
            result["parsers"][lang] = {"bytes": len(parser), "sha256": hashlib.sha256(parser).hexdigest()}
        for name in FTPLUGINS:
            path = RUNTIME + "ftplugin/" + name + ".lua"
            if file_bytes(new, path) != file_bytes(old, path):
                raise AssertionError(f"ftplugin changed: {name}")
            result["ftpluginsUnchanged"].append(name)
    report = out / "verification.json"
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"Verification report: {report}")


if __name__ == "__main__":
    main()
