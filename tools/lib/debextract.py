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
import contextlib
import hashlib
import io
import json
import lzma
import os
import posixpath
import re
import sys
import tarfile
import tempfile
from io import BytesIO

# Termux 的 deb 把内容装在绝对路径下，平铺时需要剥掉这个前缀。
TERMUX_PREFIX = "./data/data/com.termux/files/usr/"
TERMUX_ABS_PREFIX = "/data/data/com.termux/files/usr/"

# `update-alternatives --install "<link>" "<name>" "<target>" <priority>`
ALT_INSTALL_RE = re.compile(
    r"--install\s+\"([^\"]+)\"\s+\"([^\"]+)\"\s+\"([^\"]+)\"\s+(\d+)"
)


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


@contextlib.contextmanager
def open_data_tar(deb_path):
    """取出 deb 的 data.tar.* 并解成 tarfile（上下文管理器）。

    为什么不用 `lzma.decompress` 一把梭：
      首版就是那么写的，注释还断言「单个 data.tar 解压后最大约 60 MiB，构建机
      内存足够」——那个断言是错的。`erlang` 的 data.tar.xz 解压后 424 MiB、
      `rust` 更大，在 8 GB 的构建机上 `lzma.decompress` 直接
      `MemoryError: Unable to allocate output buffer.`（真机实测，整个
      stage 生成卡在 erlang 这一包）。改成**分块流式解压到临时文件**，
      峰值内存只剩压缩块本身；tarfile 直接打开该临时文件（用真文件而不是
      BytesIO，顺带避开 tarfile 对不可 seek 流做头部探测的问题）。
    """
    with open(deb_path, "rb") as fh:
        blob = fh.read()
    members = read_ar_members(blob)
    name = next((n for n in members if n.startswith("data.tar")), None)
    if name is None:
        raise ValueError(f"no data.tar member in {deb_path} (have: {list(members)})")
    raw = members[name]
    del blob  # 成员是切片拷贝，blob 本身可以立刻释放

    if name.endswith(".zst"):
        raise ValueError("zstd data.tar is not supported by this extractor")

    tmp_path = None
    try:
        if name.endswith(".xz"):
            fd, tmp_path = tempfile.mkstemp(prefix="debextract-", suffix=".tar")
            decomp = lzma.LZMADecompressor()
            view = memoryview(raw)
            step = 1 << 20
            with os.fdopen(fd, "wb") as out:
                for i in range(0, len(view), step):
                    chunk = decomp.decompress(view[i:i + step])
                    if chunk:
                        out.write(chunk)
                # 收尾：只在解压器尚未到流尾时喂空串，让它吐出最后一点缓冲。
                # （直接 `decompress(b"")` 在刚好读完时抛 `EOFError: Already at
                # end of stream` —— 首版就是这样把整轮 stage 生成打挂的。）
                if not decomp.eof:
                    tail = decomp.decompress(b"")
                    if tail:
                        out.write(tail)
            tar = tarfile.open(tmp_path, mode="r:")
        else:
            if name.endswith(".gz"):
                import gzip
                raw = gzip.decompress(raw)
            tar = tarfile.open(fileobj=BytesIO(raw), mode="r:")

        try:
            yield tar
        finally:
            tar.close()
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def read_control_member(deb_path, member_name):
    """从 deb 的 control.tar.* 里读一个成员（如 postinst）。没有则返回 None。"""
    with open(deb_path, "rb") as fh:
        blob = fh.read()
    members = read_ar_members(blob)
    key = next((k for k in members if k.startswith("control.tar")), None)
    if key is None:
        return None
    raw = members[key]
    del members
    del blob
    if key.endswith(".xz"):
        raw = lzma.decompress(raw)
    elif key.endswith(".gz"):
        import gzip
        raw = gzip.decompress(raw)
    elif key.endswith(".zst"):
        return None
    tar = tarfile.open(fileobj=io.BytesIO(raw), mode="r:")
    try:
        want = member_name.lstrip("./")
        for m in tar.getmembers():
            if m.name.lstrip("./") == want:
                fh2 = tar.extractfile(m)
                return fh2.read() if fh2 else None
        return None
    finally:
        tar.close()


def collect_alternatives(deb_path):
    """挖出 deb 的 postinst/prerm 里注册的 update-alternatives 项。

    为什么需要这个：
      Termux 的 vim 包**根本没有** `bin/vim`、`bin/vi`、`bin/ex`、`bin/view`
      这些文件 —— 它们是 postinst 里 `update-alternatives --install` 在装包
      时才创建的命令链接（`bin/vim -> ../libexec/vim/vim`，`bin/vi -> bin/vim`，
      `bin/editor -> bin/vim`）。我们只解 data.tar、不跑 postinst，于是
      「报告说装了 vim 却没有 vim 命令」。全仓 396 个 deb 里有 12 个包走这条路
      （vim 7 项、busybox 4 项、lua52/lua54 各 2 项、bat/coreutils/emacs/less/
      nano/netcat-openbsd/openjdk-21/util-linux 各 1 项）。
      这里把注册项读出来，由调用方按「目标存在才建链」合成 symlink 条目。
    """
    items = []
    for member in ("postinst", "prerm", "preinst"):
        data = read_control_member(deb_path, member)
        if not data:
            continue
        text = data.decode("utf-8", "replace")
        if "update-alternatives" not in text:
            continue
        if member != "postinst":
            continue  # 只有 postinst 会 --install，其余只 --remove
        for m in ALT_INSTALL_RE.finditer(text):
            link, name, target, prio = m.groups()
            if not link.startswith(TERMUX_ABS_PREFIX):
                continue
            items.append(
                {
                    "link": link[len(TERMUX_ABS_PREFIX):],
                    "name": name,
                    "target": target,
                    "priority": int(prio),
                }
            )
    return items


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
    # 每个包的 update-alternatives 注册项，循环结束后统一合成链接。
    alt_items = []

    for pkg in manifest["packages"]:
        deb_path = os.path.join(args.debs, pkg["file"])
        if not os.path.exists(deb_path):
            print(f"缺少 deb：{deb_path}", file=sys.stderr)
            return 1
        alt_items.extend(collect_alternatives(deb_path))
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

    # ── update-alternatives 合成 ──────────────────────────────────────────
    # 同一个 link 可能有多个包注册（`bin/editor`：nano prio 50 / vim 40 /
    # emacs 40 / busybox 10；`bin/pager`：less 50 / util-linux 25 / busybox 10 /
    # bat 10 / coreutils 1）。update-alternatives 的规则是**优先级最高者胜**，
    # 这里照抄。target 可能本身又是另一条 alternative 链（`bin/vi -> bin/vim`，
    # 而 `bin/vim -> libexec/vim/vim`），所以要做不动点解析。
    alt_links = {}
    for item in alt_items:
        link = item["link"]
        target = item["target"]
        if target.startswith(TERMUX_ABS_PREFIX):
            target = target[len(TERMUX_ABS_PREFIX):]
        prev = alt_links.get(link)
        if prev is None or item["priority"] > prev["priority"]:
            alt_links[link] = {"target": target, "priority": item["priority"], "name": item["name"]}

    resolved = 0
    for link, info in sorted(alt_links.items()):
        # 已有实体（包自己带了这个文件）时不覆盖 —— alternatives 只负责补缺口。
        if link in entries and entries[link]["type"] != "symlink":
            continue
        target = info["target"]
        seen = set()
        while target not in entries and target in alt_links and target not in seen:
            seen.add(target)
            target = alt_links[target]["target"]
        if target not in entries:
            continue
        # tar 里的链接目标一律是「相对所在目录」的写法（`bin/mvn -> ../opt/maven/bin/mvn`），
        # 而 alternatives 注册的是 usr 下的绝对路径。这里换算回相对形式，保持全仓一致。
        rel_target = posixpath.relpath(target, posixpath.dirname(link) or ".")
        entries[link] = {
            "path": link,
            "type": "symlink",
            "mode": 0o120777,
            "target": rel_target,
            "pkg": "alternatives:" + info["name"],
        }
        stats["symlink"] += 1
        resolved += 1

    if alt_links:
        print(
            f"update-alternatives：注册 {len(alt_items)} 项 / 去重后 {len(alt_links)} 个命令，"
            f"合成 {resolved} 条链接"
        )


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
