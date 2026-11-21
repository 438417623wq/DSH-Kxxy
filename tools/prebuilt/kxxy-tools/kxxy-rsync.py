#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kxxy-rsync 的 --link-dest 替代实现（本机建不出硬链接时用）。

本机 SELinux 拒绝 link(2)/linkat(2)（EACCES），rsync 的 --link-dest 会**静默**
退化成整份复制（rc=0，inode 不同），快照备份会悄悄把盘写满。

这里用「两次作业」实现等效语义：
  1. rsync --compare-dest=<base>  只复制与 base 不同的文件（省 IO 省空间）
  2. linkify：base 里有、目标里没有的文件 → 建**绝对路径符号链接**指回 base

结果目录是完整的，未变更的文件不占额外空间（软链共享同一份数据），
后续 rsync 写入走临时文件 + rename，不会顺着链接改坏 base。

用法（由 bin/kxxy-rsync 调用，不直接暴露）：
  kxxy-rsync.py <real-rsync> [rsync 原始参数...]
"""

import os
import subprocess
import sys


def split_link_dest(argv):
    """抽出 --link-dest（两种写法都可能），返回 (剩余参数, base)。"""
    out = []
    base = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--link-dest="):
            if base is None:
                base = a.split("=", 1)[1]
        elif a == "--link-dest":
            if i + 1 < len(argv):
                if base is None:
                    base = argv[i + 1]
                i += 1
        else:
            out.append(a)
        i += 1
    return out, base


def positional(argv):
    """rsync 的位置参数（源... 目标），用于判断 base 的相对路径和找 DST。"""
    res = []
    after_dd = False
    for a in argv:
        if after_dd:
            res.append(a)
            continue
        if a == "--":
            after_dd = True
            continue
        if a.startswith("-"):
            continue
        res.append(a)
    return res


def linkify(base, dst):
    """把 base 里有而 dst 里没有的文件链接过去。"""
    created = 0
    skipped = 0
    for root, dirs, files in os.walk(base):
        rel = os.path.relpath(root, base)
        target_dir = dst if rel == "." else os.path.join(dst, rel)
        if not os.path.isdir(target_dir):
            try:
                os.makedirs(target_dir, exist_ok=True)
            except OSError as ex:
                sys.stderr.write(f"kxxy-rsync: 建目录失败 {target_dir}（{ex.strerror}）\n")
                continue
        for name in files:
            src = os.path.join(root, name)
            if os.path.islink(src):
                continue
            try:
                if not os.path.isfile(src):
                    continue
            except OSError:
                continue
            link = os.path.join(target_dir, name)
            if os.path.lexists(link):
                skipped += 1
                continue
            try:
                os.symlink(src, link)
                created += 1
            except OSError as ex:
                if ex.errno not in (17,):  # EEXIST
                    sys.stderr.write(
                        f"kxxy-rsync: 建链接失败 {link}（{ex.strerror}）\n")
                    skipped += 1
    return created, skipped


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("kxxy-rsync: 内部用法 <real-rsync> [args...]\n")
        return 2
    real = sys.argv[1]
    argv, base = split_link_dest(sys.argv[2:])
    if base is None:
        return subprocess.call([real] + argv)

    pos = positional(argv)
    dst = pos[-1] if len(pos) >= 2 else None
    if dst is None:
        sys.stderr.write("kxxy-rsync: 找不到目标目录，--link-dest 无法替代\n")
        return 2

    # rsync 的 --link-dest 相对路径是相对**目标目录**的，这里照同样规则解析
    base_abs = base if os.path.isabs(base) else os.path.abspath(
        os.path.join(dst, base))
    if not os.path.isdir(base_abs):
        sys.stderr.write(
            f"kxxy-rsync: --link-dest 的基准目录不存在 {base_abs}\n")
        return 1

    if os.environ.get("KXXY_RSYNC_QUIET", "0") != "1":
        sys.stderr.write(
            "kxxy-rsync: 本机 SELinux 拒绝 link(2)，改用 --compare-dest + 符号链接\n"
            f"            基准 {base_abs}\n"
            "            （未变更文件不占额外空间；写入走临时文件+rename，不会改坏基准）\n")

    # --inplace 是直接往目标文件里写，目标若是软链就会顺着改写基准 —— 快照全毁。
    if any(a == "--inplace" or a.startswith("--inplace=") for a in argv):
        sys.stderr.write(
            "kxxy-rsync: --inplace 与符号链接去重不能共存（会顺着链接改写基准快照）。\n"
            "            去掉 --inplace，或改用 --copy-dest 接受整份复制。\n")
        return 1

    rc = subprocess.call([real, "--compare-dest=" + base_abs] + argv)
    if rc != 0:
        return rc

    created, skipped = linkify(base_abs, dst)
    if os.environ.get("KXXY_RSYNC_QUIET", "0") != "1":
        sys.stderr.write(
            f"kxxy-rsync: 已链接 {created} 个未变更文件到基准"
            f"（目标里已有 {skipped} 个，跳过）\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
