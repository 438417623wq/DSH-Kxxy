#!/usr/bin/env python3
"""
把 Termux .deb 闭包解成一个「文件系统视图」，供 Node 侧构建 runtime.zip。

为什么不让 Node 自己解：
  Termux 的 data.tar 是 xz 压缩，而 Node 内置 zlib 不含 LZMA2 解码器，
  也没有可用的纯 JS xz 依赖（构建机无法访问 npm registry 装包）。
  Python 的 lzma + tarfile 是标准库，内置 Python 3.12 已具备。

为什么不用 bsdtar 解到磁盘：
  Windows 上 tar 会把符号链接还原为真实 symlink（需要开发者模式/管理员），
  而我们要的是「把链接当数据读出来」，由构建脚本决定是否物化成实体副本。
  走 Python 直接读 tar 成员，链接目标是普通字符串，不受宿主平台权限影响。

输出（写到 --out 目录）：
  blobs/<sha256[0:2]>/<sha256>   去重后的文件内容（符号链接不占 blob）
  entries.json                   合并后的路径 → 条目视图

用法：
  python debextract.py --debs <deb目录> --out <输出目录>
"""
import argparse
import hashlib
import json
import lzma
import os
import sys
import tarfile
from io import BytesIO

# Termux 的 deb 把内容装在绝对路径下，平铺时需要剥掉这个前缀。
TERMUX_PREFIX = "./data/data/com.termux/files/usr/"


def read_ar_members(blob):
    """极简 ar 读取器。.deb = b"!<arch>\\n" + 若干 60 字节头 + 数据。"""
    if blob[:8] != b"!<arch>\n":
        raise ValueError("not an ar archive (missing !<arch> magic)")
    members = {}
    off = 8
    while off + 60 <= len(blob):
        hdr = blob[off:off + 60]
        # 成员名带尾部 '/'（data.tar.xz/），必须剥掉才能按名字匹配。
        name = hdr[0:16].decode("latin-1").strip().rstrip("/")
        try:
            size = int(hdr[48:58].decode("latin-1").strip())
        except ValueError:
            break
        start = off + 60
        members[name] = blob[start:start + size]
        off = start + size + (size % 2)  # ar 成员按偶数字节对齐
    return members


def open_data_tar(deb_path):
    """取出 deb 的 data.tar.* 并解成 tarfile。"""
    with open(deb_path, "rb") as fh:
        blob = fh.read()
    members = read_ar_members(blob)
    name = next((n for n in members if n.startswith("data.tar")), None)
    if name is None:
        raise ValueError(f"no data.tar member in {deb_path} (have: {list(members)})")
    raw = members[name]
    if name.endswith(".xz"):
        # 不能用 lzma.LZMAFile 流式喂给 tarfile：tarfile 的 seek 探测会报
        # "invalid header"。全量解压后再包 BytesIO 是稳的（单个 data.tar
        # 解压后最大约 60 MiB，构建机内存足够）。
        raw = lzma.decompress(raw)
    elif name.endswith(".gz"):
        import gzip
        raw = gzip.decompress(raw)
    elif name.endswith(".zst"):
        raise ValueError("zstd data.tar is not supported by this extractor")
    return tarfile.open(fileobj=BytesIO(raw), mode="r:")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--debs", required=True, help="包含 .deb 与 manifest.json 的目录")
    ap.add_argument("--out", required=True, help="输出目录")
    args = ap.parse_args()

    with open(os.path.join(args.debs, "manifest.json"), "r", encoding="utf-8") as fh:
        manifest = json.load(fh)

    blob_root = os.path.join(args.out, "blobs")
    os.makedirs(blob_root, exist_ok=True)

    # 路径 → 条目。多个包写同一路径时后者覆盖（Termux 包之间基本不冲突）。
    entries = {}
    stats = {"file": 0, "symlink": 0, "dir": 0, "hardlink": 0, "skipped": 0}
    blob_bytes = 0

    for pkg in manifest["packages"]:
        deb_path = os.path.join(args.debs, pkg["file"])
        if not os.path.exists(deb_path):
            print(f"缺少 deb：{deb_path}", file=sys.stderr)
            return 1
        with open_data_tar(deb_path) as tar:
            for member in tar:
                rel = member.name
                if not rel.startswith(TERMUX_PREFIX):
                    # 少数包会带 ./data/data/com.termux/files/usr 之外的路径
                    stats["skipped"] += 1
                    continue
                path = rel[len(TERMUX_PREFIX):]
                if not path:
                    continue

                if member.isdir():
                    stats["dir"] += 1
                    entries.setdefault(path, {"path": path, "type": "dir", "mode": member.mode})
                    continue

                if member.issym():
                    # 链接目标原样保留；是否物化由 Node 侧决定。
                    stats["symlink"] += 1
                    entries[path] = {
                        "path": path,
                        "type": "symlink",
                        "mode": member.mode,
                        "target": member.linkname,
                        "pkg": pkg["name"],
                    }
                    continue

                if member.islnk():
                    # tar 硬链接：指向同一归档内的另一个成员，语义上就是同一份内容。
                    stats["hardlink"] += 1
                    entries[path] = {
                        "path": path,
                        "type": "hardlink",
                        "mode": member.mode,
                        "target": member.linkname[len(TERMUX_PREFIX):]
                        if member.linkname.startswith(TERMUX_PREFIX)
                        else member.linkname,
                        "pkg": pkg["name"],
                    }
                    continue

                if not member.isfile():
                    stats["skipped"] += 1
                    continue

                fh = tar.extractfile(member)
                if fh is None:
                    stats["skipped"] += 1
                    continue
                data = fh.read()
                digest = hashlib.sha256(data).hexdigest()
                blob_path = os.path.join(blob_root, digest[:2], digest)
                if not os.path.exists(blob_path):
                    os.makedirs(os.path.dirname(blob_path), exist_ok=True)
                    with open(blob_path, "wb") as out:
                        out.write(data)
                    blob_bytes += len(data)
                stats["file"] += 1
                entries[path] = {
                    "path": path,
                    "type": "file",
                    "mode": member.mode,
                    "size": len(data),
                    "sha256": digest,
                    "pkg": pkg["name"],
                }

    with open(os.path.join(args.out, "entries.json"), "w", encoding="utf-8") as fh:
        json.dump(
            {
                "packages": len(manifest["packages"]),
                "count": len(entries),
                "stats": stats,
                "blobBytes": blob_bytes,
                "entries": sorted(entries.values(), key=lambda e: e["path"]),
            },
            fh,
            ensure_ascii=False,
        )

    print(
        f"{len(manifest['packages'])} 个包 → {len(entries)} 个条目 "
        f"(file={stats['file']} symlink={stats['symlink']} hardlink={stats['hardlink']} "
        f"dir={stats['dir']} skipped={stats['skipped']})，"
        f"去重后内容 {blob_bytes / 1048576:.1f} MiB"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
