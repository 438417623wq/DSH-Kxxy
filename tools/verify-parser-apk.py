#!/usr/bin/env python3
"""Verify parser-fix APK resources without extracting or executing archive code."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import tarfile
import zipfile


LANGUAGES = ("c", "lua", "markdown", "markdown_inline", "query", "vim", "vimdoc")


def digest_stream(stream):
    digest = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        digest.update(chunk)
    return digest.hexdigest()


class ZipMemberIO(io.RawIOBase):
    """Random-access STORE member, so the large nested runtime ZIP stays off heap."""
    def __init__(self, file, start, size):
        self.file = file
        self.start = start
        self.size = size
        self.position = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        position = offset if whence == 0 else self.position + offset if whence == 1 else self.size + offset
        if position < 0:
            raise ValueError("negative seek")
        self.position = position
        return position

    def read(self, size=-1):
        size = self.size - self.position if size < 0 else min(size, max(0, self.size - self.position))
        self.file.seek(self.start + self.position)
        data = self.file.read(size)
        self.position += len(data)
        return data


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apk", required=True, type=Path)
    ap.add_argument("--pool", required=True, type=Path)
    ap.add_argument("--project", required=True, type=Path)
    ap.add_argument("--report", required=True, type=Path)
    args = ap.parse_args()
    with args.apk.open("rb") as raw, zipfile.ZipFile(args.apk) as apk:
        names = apk.namelist()
        if len(names) != len(set(names)):
            raise AssertionError("duplicate APK ZIP entries")
        pool_info = apk.getinfo("assets/ext-pool/shells.pool")
        with apk.open(pool_info) as stream, args.pool.open("rb") as original:
            pool_hash = digest_stream(stream)
            if pool_hash != digest_stream(original):
                raise AssertionError("APK pool differs from verified pool")
        with apk.open(pool_info) as stream, tarfile.open(fileobj=stream, mode="r|gz") as pool:
            parsers = {}
            for member in pool:
                for lang in LANGUAGES:
                    if member.name == f"share/nvim/runtime/parser/{lang}.so":
                        if not member.isfile():
                            raise AssertionError(f"nonphysical parser: {lang}")
                        parsers[lang] = digest_stream(pool.extractfile(member))
            if set(parsers) != set(LANGUAGES):
                raise AssertionError("missing parser languages")
        meta = json.loads(apk.read("assets/meta/build.json"))
        runtime_info = apk.getinfo("assets/runtime.zip")
        if runtime_info.compress_type != zipfile.ZIP_STORED:
            raise AssertionError("runtime asset is not STORE")
        with apk.open(runtime_info) as stream:
            runtime_hash = digest_stream(stream)
        if runtime_hash != meta["runtimeSha256"] or runtime_info.file_size != meta["runtimeSize"]:
            raise AssertionError("runtime metadata mismatch")
        raw.seek(runtime_info.header_offset)
        local = raw.read(30)
        if local[:4] != b"PK\x03\x04":
            raise AssertionError("invalid runtime local header")
        name_length, extra_length = struct.unpack_from("<HH", local, 26)
        offset = runtime_info.header_offset + 30 + name_length + extra_length
        with zipfile.ZipFile(ZipMemberIO(raw, offset, runtime_info.file_size)) as runtime:
            runtime_names = runtime.namelist()
            if len(runtime_names) != len(set(runtime_names)):
                raise AssertionError("duplicate runtime ZIP entries")
            sources = {}
            for file in ("extinstall.mjs", "selftest.mjs"):
                suffix = f"/kxxy-host/lib/{file}"
                matches = [name for name in runtime_names if name.endswith(suffix)]
                if len(matches) != 1:
                    raise AssertionError(f"not unique runtime source: {file}")
                bundled = runtime.read(matches[0])
                original = (args.project / "plugins/kxxy-host/lib" / file).read_bytes()
                if bundled != original:
                    raise AssertionError(f"outdated runtime source: {file}")
                sources[file] = matches[0]
            index_name = next(name for name in runtime_names if name.endswith("/kxxy-host/lib/index.js"))
            index = runtime.read(index_name).decode("utf-8")
            if "extinstall.ensureNvimParsers(root)" not in index:
                raise AssertionError("parser startup/manual healing not bundled")
            if meta["kxxyHostMarker"] not in index[:256]:
                raise AssertionError("plugin marker differs from metadata")
            fingerprint_name = next(name for name in runtime_names if name.endswith("/kxxy-host/lib/.fingerprint"))
            fingerprint_text = runtime.read(fingerprint_name).decode()
            fingerprint_fields = dict(line.split(":", 1) for line in fingerprint_text.splitlines() if ":" in line)
            if fingerprint_fields.get("fingerprint") != meta["kxxyHostFingerprint"]:
                raise AssertionError("plugin fingerprint differs from APK metadata")
    with args.apk.open("rb") as stream:
        apk_hash = digest_stream(stream)
    result = {"apk": str(args.apk.resolve()), "apkBytes": args.apk.stat().st_size,
              "apkSha256": apk_hash, "poolSha256": pool_hash, "parserSha256": parsers,
              "runtimeSha256": runtime_hash, "pluginFingerprint": meta["kxxyHostFingerprint"],
              "sourceEntries": sources, "deviceLoadVerified": False}
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
