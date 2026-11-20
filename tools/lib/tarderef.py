#!/usr/bin/env python3
"""把 tar.gz 里的**硬链条目**改写成独立文件副本，符号链接原样保留。

为什么需要这一步
================

`glibc` 扩展池要带一份 Ubuntu base 的 rootfs。设备端解包用的是引擎里的
GNU tar，而 Android 应用域**建不出硬链接**（`link(2)` 返回 EACCES，见
v0.9.72 的定性报告）：归档里只要有一条硬链条目，tar 就会在那里报错、
留下半份 rootfs，最坏的结果是 `usr/bin/perl5.38.2`、`usr/bin/uncompress`
这类条目直接缺失。

两份解法：
  · 解包时加 `--hard-dereference` —— 依赖设备端 tar 的版本与实现，
    bsdtar 没有这个选项，GNU tar 在**读取**模式下是否生效也没有文档保证；
  · 构建期把硬链改成副本 —— 产物是「零硬链」的普通 tar.gz，设备端
    `tar -xzf` 一条命令即可，不依赖任何扩展选项。

这里选后者。改写的代价只有几十 KB（Ubuntu base 里只有两条硬链）。

`tools/lib/targz.mjs` 的读取器不能干这件事：它遇到链接条目直接抛错
（那个读取器只服务 npm tarball）。设备端的 `plugins/kxxy-host/lib/tar.mjs`
也**跳过符号链接**，所以 rootfs 不能以「解开的文件树」形式进池 —— 只能作为
一个不透明的 blob 放进去、由 wrapper 在首次运行时解包（见 kxxy-glibc 模板）。

输出：改写后的 tar.gz + 一行 JSON 统计（stdout），供构建脚本记录体积。
"""

import argparse
import io
import json
import sys
import tarfile

# 设备上既不能 chown 也不能 mknod，这几种条目解出来也没意义
SKIP_TYPES = (
    tarfile.CHRTYPE,
    tarfile.BLKTYPE,
    tarfile.FIFOTYPE,
)


def rewrite(src_path, dst_path, level):
    stats = {
        "files": 0,
        "dirs": 0,
        "symlinks": 0,
        "hardlinks": 0,
        "skipped": 0,
        "bytes": 0,
    }
    with tarfile.open(src_path, "r:*") as src, tarfile.open(
        dst_path, "w:gz", compresslevel=level, format=tarfile.GNU_FORMAT
    ) as out:
        for member in src:
            if member.islnk():
                # 硬链 → 普通文件：内容取自 linkname 指向的那条成员。
                # tarfile.extractfile() 对硬链会解析到目标成员（同一归档内）。
                data = src.extractfile(member).read()
                plain = tarfile.TarInfo(member.name)
                plain.type = tarfile.REGTYPE
                plain.mode = member.mode
                plain.mtime = member.mtime
                plain.uid = member.uid
                plain.gid = member.gid
                plain.uname = member.uname
                plain.gname = member.gname
                plain.size = len(data)
                out.addfile(plain, io.BytesIO(data))
                stats["hardlinks"] += 1
                stats["bytes"] += len(data)
                continue

            if member.isreg():
                handle = src.extractfile(member)
                if handle is None:  # 理论上不会发生，保守跳过
                    stats["skipped"] += 1
                    continue
                out.addfile(member, handle)
                stats["files"] += 1
                stats["bytes"] += member.size
                continue

            if member.isdir():
                out.addfile(member)
                stats["dirs"] += 1
                continue

            if member.issym():
                # 符号链接原样保留：设备上 symlink(2) 是允许的，
                # 而且 rootfs 里 /bin -> usr/bin 这类链接必须保住。
                out.addfile(member)
                stats["symlinks"] += 1
                continue

            stats["skipped"] += 1

    # 复核：产物里不允许再有任何硬链，否则「构建期解决、设备端零依赖」不成立。
    with tarfile.open(dst_path, "r:gz") as check:
        left = [m.name for m in check if m.islnk()]
    if left:
        raise SystemExit(f"改写后仍残留硬链：{left[:5]}")

    return stats


def main():
    ap = argparse.ArgumentParser(description="把 tar.gz 的硬链改写成副本")
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--level", type=int, default=6, help="gzip 压缩级别（默认 6）")
    args = ap.parse_args()

    try:
        stats = rewrite(args.src, args.dst, args.level)
    except (OSError, tarfile.TarError) as exc:
        print(f"tarderef: {exc}", file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
