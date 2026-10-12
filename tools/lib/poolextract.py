#!/usr/bin/env python3
"""
把扩展包池的边际 deb 集合重打成设备端可用的 tar.gz（五项改进方案 §4.3）。

为什么需要 Python：Termux deb 的 data.tar 是 xz 压缩，Node 内置 zlib 没有
LZMA2 解码器（与 debextract.py 同一约束）；Python 的 lzma + tarfile 是标准库。

为什么不让设备端处理符号链接：
  包池里的链接目标可能落在「预装闭包」里（例如某工具把 libfoo.so 链到
  基线包的 libfoo.so.1）。设备端解到 extensions/<id>/ 后，相对链接在扩展
  目录里解析不到那个目标。所以这里统一**物化**：
    · 目标在边际集合内      → 直接复制目标内容
    · 目标在预装闭包（stage）内 → 从 stage blob 复制内容
    · 两边都解析不到        → 跳过并记账（不写坏条目）
  设备端 tar 读器（plugins/kxxy-host/lib/tar.mjs）因此只需要支持
  文件/目录/longname 三种最小情形。

输出（--out 目录）：
  <id>.pool        GNU tar 格式（gzip 压缩），仅文件与目录（无链接条目），路径相对 Termux usr。
                   后缀刻意用 .pool 而不是 .tar.gz —— aapt2 会在资产合并阶段把 .gz
                   解包并剥掉后缀，APK 里的条目名会变成 <id>.tar，破坏设备端按名
                   查包池的逻辑。中性后缀 + noCompress 才能字节保真进 APK。
  --report JSON    [{id, files, totalBytes}]，fetch-extensions.mjs 据此合成目录

用法：
  python poolextract.py --debs <deb目录> --spec <pool-spec.json> \
      --stage <stage目录> --out <输出目录> --report <report.json>
"""
import argparse
import io
import json
import os
import posixpath
import sys
import tarfile

TERMUX_PREFIX = "./data/data/com.termux/files/usr/"

# 与 tools/lib/stage.mjs 的 PRUNE_DIRS / PRUNE_EXT 保持一致的子集：
# 纯文档在包池里同样没有价值（include/ 与 .a 必须保留 —— 工具链要编译）。
PRUNE_DIRS = (
    "share/doc/",
    "share/man/",
    "share/info/",
    "share/et/",
    "libexec/installed-tests/",
)
PRUNE_EXT = (".la", ".md", ".ps1", ".cmd", ".map")


def is_pruned(path):
    return (
        path.startswith(PRUNE_DIRS)
        or path.endswith(PRUNE_EXT)
    )


def read_ar_members(blob):
    """极简 ar 读取器（与 debextract.py 同构）。"""
    if blob[:8] != b"!<arch>\n":
        raise ValueError("not an ar archive (missing !<arch> magic)")
    members = {}
    off = 8
    while off + 60 <= len(blob):
        hdr = blob[off:off + 60]
        name = hdr[0:16].decode("latin-1").strip().rstrip("/")
        try:
            size = int(hdr[48:58].decode("latin-1").strip())
        except ValueError:
            break
        start = off + 60
        members[name] = blob[start:start + size]
        off = start + size + (size % 2)
    return members


def open_data_tar(deb_path):
    with open(deb_path, "rb") as fh:
        blob = fh.read()
    members = read_ar_members(blob)
    name = next((n for n in members if n.startswith("data.tar")), None)
    if name is None:
        raise ValueError(f"no data.tar member in {deb_path}")
    raw = members[name]
    if name.endswith(".xz"):
        import lzma
        raw = lzma.decompress(raw)
    elif name.endswith(".gz"):
        import gzip
        raw = gzip.decompress(raw)
    elif name.endswith(".zst"):
        raise ValueError("zstd data.tar is not supported")
    return tarfile.open(fileobj=io.BytesIO(raw), mode="r:")


def load_stage(stage_dir):
    """读 debextract.py 产出的 stage 视图，供解析指向预装闭包的链接。"""
    entries_path = os.path.join(stage_dir, "entries.json")
    if not os.path.isfile(entries_path):
        return {}, None
    with open(entries_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    by_path = {e["path"]: e for e in data.get("entries", []) if e.get("type") == "file"}
    return by_path, os.path.join(stage_dir, "blobs")


def stage_blob(blob_root, sha256):
    path = os.path.join(blob_root, sha256[:2], sha256)
    with open(path, "rb") as fh:
        return fh.read()


def normalize_target(link_path, target):
    """把链接目标归一为相对 usr 的路径；指向 usr 之外返回 None。"""
    if target.startswith(TERMUX_PREFIX):
        return target[len(TERMUX_PREFIX):]
    if target.startswith("/data/data/com.termux/files/usr"):
        stripped = target[len("/data/data/com.termux/files/usr/"):]
        return stripped
    if target.startswith("/"):
        return None
    return posixpath.normpath(posixpath.join(posixpath.dirname(link_path), target))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--debs", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--stage", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", required=True)
    args = ap.parse_args()

    with open(args.spec, "r", encoding="utf-8") as fh:
        spec = json.load(fh)

    stage_entries, blob_root = load_stage(args.stage)
    if blob_root is None:
        print(f"      · stage 不可用（{args.stage} 缺 entries.json），"
              f"指向预装闭包的符号链接将无法物化", file=sys.stderr)

    os.makedirs(args.out, exist_ok=True)
    report = []

    for item in spec["items"]:
        ext_id = item["id"]
        merged = {}      # path -> (bytes, mode)
        symlinks = {}    # path -> raw target
        skipped = 0

        for pkg in item["packages"]:
            deb_path = os.path.join(args.debs, pkg["file"])
            with open_data_tar(deb_path) as tar:
                for member in tar:
                    rel = member.name
                    if not rel.startswith(TERMUX_PREFIX):
                        skipped += 1
                        continue
                    path = rel[len(TERMUX_PREFIX):]
                    if not path or is_pruned(path):
                        skipped += 1
                        continue

                    if member.isdir():
                        continue
                    if member.issym():
                        symlinks[path] = member.linkname
                        continue
                    if member.islnk():
                        # tarfile 对硬链接的 extractfile 会给出目标内容
                        fh = tar.extractfile(member)
                        if fh is None:
                            skipped += 1
                            continue
                        merged[path] = (fh.read(), member.mode)
                        continue
                    if not member.isfile():
                        skipped += 1
                        continue
                    fh = tar.extractfile(member)
                    if fh is None:
                        skipped += 1
                        continue
                    merged[path] = (fh.read(), member.mode)

        # 物化符号链接（迭代两轮：链接也可能指向另一条链接）
        pending = dict(symlinks)
        for _round in range(4):
            if not pending:
                break
            progressed = False
            for path, raw_target in list(pending.items()):
                target = normalize_target(path, raw_target)
                if target is None:
                    del pending[path]
                    skipped += 1
                    continue
                if target in merged:
                    data, mode = merged[target]
                    merged[path] = (data, mode)
                    del pending[path]
                    progressed = True
                elif target in stage_entries and blob_root:
                    entry = stage_entries[target]
                    merged[path] = (stage_blob(blob_root, entry["sha256"]), entry.get("mode", 0o644))
                    del pending[path]
                    progressed = True
                elif target in pending:
                    continue  # 下一轮再说
                else:
                    del pending[path]
                    skipped += 1
                    print(f"      · {ext_id}: 链接无法解析 {path} -> {raw_target}，跳过",
                          file=sys.stderr)
            if not progressed:
                break
        for path in pending:
            skipped += 1
            print(f"      · {ext_id}: 链接环/未解析 {path}，跳过", file=sys.stderr)

        out_path = os.path.join(args.out, f"{ext_id}.pool")
        total_bytes = 0
        with tarfile.open(out_path, "w:gz", format=tarfile.GNU_FORMAT, compresslevel=6) as out:
            for path in sorted(merged):
                data, mode = merged[path]
                info = tarfile.TarInfo(path)
                info.size = len(data)
                # 只保留「属主可执行」这一语义位，其余归一到 0644/0755，
                # 避免把 setuid/setgid/sticky 之类的脏位带进设备端 chmod
                info.mode = 0o755 if (mode & 0o100) else 0o644
                info.mtime = 0
                out.addfile(info, io.BytesIO(data))
                total_bytes += len(data)

        report.append({"id": ext_id, "files": len(merged), "totalBytes": total_bytes})
        print(
            f"      {ext_id}: {len(merged)} 文件 / {total_bytes / 1048576:.1f} MiB"
            f"（跳过 {skipped} 条）→ {out_path}"
        )

    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump({"items": report}, fh, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
