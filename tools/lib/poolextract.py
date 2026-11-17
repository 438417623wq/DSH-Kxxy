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
                   文本文件内容里的 Termux 前缀在此换成 @DSH_ROOT@ / @DSH_HOME@ /
                   @DSH_TMP@ 占位符（见 PLACEHOLDER_REWRITES 与问题.txt【1】），
                   并在包内附一份 .pool-manifest.json 列出被改写的文件，
                   供设备端 extinstall.mjs 安装时回填真实路径。
  --report JSON    [{id, files, totalBytes, placeholderFiles}]，fetch-extensions.mjs 据此合成目录

用法：
  python poolextract.py --debs <deb目录> --spec <pool-spec.json> \
      --stage <stage目录> --out <输出目录> --report <report.json>
"""
import argparse
from bisect import bisect_left
from collections import deque
import io
import json
import os
import posixpath
import sys
import tarfile
import zipfile

TERMUX_PREFIX = "./data/data/com.termux/files/usr/"

# ---------------------------------------------------------------------------
# 内容中的 Termux 前缀重写（问题.txt【1】）
#
# 背景：runtime stage 一直在做这件事（tools/build-runtime.mjs 的
# normaliseStageFiles + RuntimeInstaller 的 rewriteRootPlaceholder），而
# **包池从来没有**。于是扩展装到设备上之后，脚本里写死的
# `/data/data/com.termux/files/usr/...` 全部指向不存在的目录 —— 真机症状是
# `--list-langs` 报 `No such file or directory ["/data/data/com.termux/..."]`、
# pkgconfig 的 prefix 落空、perl/golang 的各种 share 路径找不到。
#
# 做法与 runtime 侧完全一致：**构建期换成占位符、设备端安装时回填**。
# 不能在构建期就写死真实路径 —— 那是 app 私有目录，包名一变（或换设备）
# 就全错；必须让设备在自己安装的那一刻用 `context.filesDir` 算出来。
#
# 三个占位符与 tools/build-runtime.mjs 的 ROOT/HOME/TMP_PLACEHOLDER 逐字相同，
# 设备端的 RuntimeInstaller.ROOT_PLACEHOLDER 也是同一个串。
PLACEHOLDER_REWRITES = (
    (b"/data/data/com.termux/files/usr", b"@DSH_ROOT@"),
    (b"/data/data/com.termux/files/home", b"@DSH_HOME@"),
    (b"/data/data/com.termux/cache", b"@DSH_TMP@"),
    # 更短的父目录形态。必须放在最后三条：前面的规则都带更长后缀，
    # 顺序反了会把 `/data/data/com.termux/files/usr` 截成 `@DSH_FILES@/usr`。
    #
    # 为什么需要它们：perl 的 `Config_heavy.pl` 把 sysroot 写成
    # `-Dsysroot=-I/data/data/com.termux/files`（**不带 /usr**），三条长规则
    # 一条都匹配不到 —— 这是重打 pool 后仅剩的 3 个残留（autotools / perl /
    # exiftool 各带一份同一个文件）。
    (b"/data/data/com.termux/files", b"@DSH_FILES@"),
    (b"/data/data/com.termux", b"@DSH_DATA@"),
)
POOL_MANIFEST = ".pool-manifest.json"

# 只改文本。三类明确跳过：
#   · ELF（魔数 \x7fELF）—— 路径串也出现在里面（DT_RUNPATH / strings），
#     但占位符比原串短，改动长度会让节偏移与重定位表整体错位；
#     而且 RUNPATH 的优先级低于 LD_LIBRARY_PATH，留着那条无效路径无害。
#     **唯一例外**是「等长」的编译期 shell 路径改写，见 patch_elf_shell_path()。
#   · ar 静态库（!<arch>\n）—— 成员偏移与符号索引都按字节算，同理不能动。
#   · 任何含 NUL 字节的数据 —— 文本配置/脚本不会有 NUL，有就是二进制。
ELF_MAGIC = b"\x7fELF"
AR_MAGIC = b"!<arch>\n"

# golang 池里 `go` 的两份副本（Termux 的 bin/go 与 lib/go/bin/go 内容相同）。
# 见 --go-binary：这两条路径会在打包时被整体替换成编译期钉死引擎根的产物。
GO_OVERRIDE_PATHS = frozenset({"bin/go", "lib/go/bin/go"})

# 与 tools/lib/stage.mjs 的 PRUNE_DIRS / PRUNE_EXT 保持一致的子集：
# 纯文档在包池里同样没有价值（include/ 与 .a 必须保留 —— 工具链要编译）。
#
# `.map` **不在**这里（缺陷 BA）：扩展池里带 `.map` 的只有 emacs（131 个字符集
# 映射表，2.8 MiB）与 texlive-bin（3 个字体映射），缺了前者 emacs 连 --batch 都
# 起不来（`Loading charset map ... "8859-2"` + `Emacs will not function correctly
# without the character map files.`），缺了后者 dvipdfmx 找不到 CID 字体。
PRUNE_DIRS = (
    "share/doc/",
    "share/man/",
    "share/info/",
    "share/et/",
    "libexec/installed-tests/",
)
PRUNE_EXT = (".la", ".md", ".ps1", ".cmd")


def is_pruned(path):
    return (
        path.startswith(PRUNE_DIRS)
        or path.endswith(PRUNE_EXT)
    )


# ── ELF 里「编译期 shell 路径」的等长原位修补（问题清单【8】的根因）──────
#
# 为什么这条规则**必须**破例动 ELF：
#
#   Perl 把 `Configure -Dsh=…` 的结果编译进 `PL_sh_path`，位置在 `.rodata` 的一个
#   字符串常量表里（`lib/libperl.so` 偏移 550029 处，上下文是
#   `"…9ABCDEF\0/data/data/com.termux/files/usr/bin/sh\0\x05,\0`!\"#…"`）。
#   反引号 / `system("命令串")` 只要是**需要 shell 解析**的形态（带引号、管道、
#   重定向组合），perl 就走 `execv(PL_sh_path, ["sh","-c",cmd])`；这条路径
#   **不回落到 PATH**，`$Config{sh}` 也改不了它（我们早已把 Config.pm 的前缀
#   改写成引擎根，但那是运行时读的哈希表，与这个常量无关）。
#
#   真机症状（0.9.62 + perl/exiftool 扩展）：
#     `perl -e 'my $o = `"echo" hi 2>&1`'`   → 输出空，$? = -1
#     `perl -e 'my $o = `echo hi 2>&1`'`     → 正常（perl 自己 split 后直接 exec）
#   ExtUtils::MakeMaker 的 `find_perl()` 恰好用带引号的形态探测版本
#   （`"$file" -e 'print $]'`），于是版本号取到空串 → `PERL = ""` →
#   `make install` 的第一条 `$(ABSPERLRUN) -MModule ...` 展开成裸目录名 →
#   `sh: 1: <cwd>: Permission denied`。**cpan 因此装不了任何模块**，
#   而报错文案（Permission denied on a directory）离真正的原因有十万八千里。
#
#   为什么可以做「等长替换」：占位符方案（`@DSH_ROOT@`）比原串短 14 字节，
#   改动长度会让后续节的偏移与重定位整体错位 —— 这是上面 ELF 短路的正当理由。
#   但**本条不同**：目标串是 `/data/data/com.termux/files/usr/bin/sh`（36 字节），
#   替换成 `/system/bin/sh`（14 字节）后剩 22 字节用 NUL 填满，**总长不变**。
#   原串后面本来就紧跟一个 NUL，所以填完仍然是一个合法的 C 字符串，指针不变、
#   布局不变、对 ELF 结构零影响。
#
#   为什么选 `/system/bin/sh`（Android 自带的 mksh）而不是引擎里的 `bin/sh`：
#     · 引擎根在设备上是变量（`/data/user/<uid>/…`、多用户/wework 不同），
#       而 ELF 里的字符串必须在**构建期**就定稿；
#     · `/system/bin/sh` 是 bionic 平台上唯一保证存在、且 POSIX 语义完整的
#       shell，Termux 自己也用它做兜底；
#     · make / MakeMaker / cpan 用到的都是 POSIX 语法，mksh 足够。
#
#   只认「后面紧跟 NUL」的出现位置：说明它是独立字符串，不会截断更长的字面量。
TERMUX_SH_PATH = b"/data/data/com.termux/files/usr/bin/sh"
ANDROID_SH_PATH = b"/system/bin/sh"


def patch_elf_shell_path(data):
    """把 ELF 里编译期的 termux `sh` 路径等长改写成 `/system/bin/sh`。

    @returns (new_bytes, changed) —— 非 ELF / 未命中时原样返回。
    """
    if data[:4] != ELF_MAGIC:
        return data, False
    filler = b"\x00" * (len(TERMUX_SH_PATH) - len(ANDROID_SH_PATH))
    out = data
    start = 0
    changed = False
    while True:
        i = out.find(TERMUX_SH_PATH, start)
        if i < 0:
            break
        end = i + len(TERMUX_SH_PATH)
        # 后面不是 NUL ⇒ 它是更长字符串的前缀（理论上不会有，防御性跳过）。
        if out[end:end + 1] != b"\x00":
            start = end
            continue
        out = out[:i] + ANDROID_SH_PATH + filler + out[end:]
        changed = True
        start = i + len(TERMUX_SH_PATH)
    return (out, True) if changed else (data, False)


def rewrite_prefixes(data):
    """把内容里的 Termux 前缀换成占位符。

    @returns (new_bytes, changed) —— 未命中时原样返回且 changed=False。
    """
    if not data:
        return data, False
    if data[:4] == ELF_MAGIC:
        # ELF 只有这一条**等长**改写是安全的，见 patch_elf_shell_path。
        return patch_elf_shell_path(data)
    if data[:8] == AR_MAGIC:
        return data, False
    # NUL 字节 = 二进制（PNG/JPEG/加密数据/编译产物…）。文本配置里出现 NUL
    # 的唯一情形是编码异常，此时改动字节只会让它更坏。
    if b"\x00" in data:
        return data, False

    out = data
    for needle, repl in PLACEHOLDER_REWRITES:
        if needle in out:
            out = out.replace(needle, repl)
    return (out, True) if out is not data else (data, False)


# ── jar 内 jansi native 剥离（缺陷 BM）──────────────────────────────────
#
# jansi 2.4.0 把全平台的 `libjansi.so` 都打进 jar 的
# `org/fusesource/jansi/internal/native/<os>/<arch>/` 下，其中
# `Linux/arm64/libjansi.so` 是 **glibc 编译**的（DT_NEEDED 只有 `libc.so.6`），
# 在 Android 的 bionic 上 `System.load` 必抛
#   `UnsatisfiedLinkError: dlopen failed: "libc.so.6" not found`
# 而 `JansiLoader.loadNativeLibrary` 把这个 ULE catch 住之后会
# `System.err.println(ule)`（字节码 :89-93）—— 于是**每次**跑 kotlinc / gradle
# 都在 stderr 刷一段吓人的 UnsatisfiedLinkError，用户看到的「崩溃」其实是它。
#
# 真正干净的解法是让 jansi **压根没有 native 资源可解**：没有资源就跳过
# extractAndLoadLibraryFile，直接走到「所有候选都失败」的
# `throw new Exception("No native library found…")`，而这条被
# `initialize()` 的 catch(Exception) + `jansi.graceful=true`（默认值）静默吞掉，
# 一个字都不打印。叠加 EngineConfig 里的 `-Djansi.mode=strip`，jansi 这条
# 路径在设备上就彻底安静了。
JANSI_NATIVE_PREFIX = "org/fusesource/jansi/internal/native/"


def strip_jansi_native(data):
    """把 jar 里 jansi 的 native 库条目删掉，其余条目原样保留。

    @returns (new_bytes, removed_count)。不是 zip / 不含 native 条目时原样返回。
    """
    if not data or data[:4] != b"PK\x03\x04":
        return data, 0
    try:
        src = zipfile.ZipFile(io.BytesIO(data))
        names = src.namelist()
    except Exception:
        return data, 0
    # 目录条目也要删：JansiLoader 用 `hasResource("/<pkg>/native/<os>/<arch>")`
    # 判断要不要走解包分支，目录条目还在的话它仍会认为「有资源」，
    # 只是解不出文件、白跑一趟。全删干净才会直接落到「无 native 库」。
    doomed = [n for n in names if n.startswith(JANSI_NATIVE_PREFIX)]
    if not doomed:
        return data, 0

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as dst:
        for info in src.infolist():
            if info.filename in doomed:
                continue
            new = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            new.compress_type = zipfile.ZIP_DEFLATED
            new.external_attr = info.external_attr
            dst.writestr(new, src.read(info.filename))
    return buf.getvalue(), len(doomed)


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
    by_path = {
        e["path"]: e for e in data.get("entries", [])
        if e.get("type") in ("file", "dir", "directory")
        and is_safe_path(e.get("path", ""))
    }
    return by_path, os.path.join(stage_dir, "blobs")


def stage_blob(blob_root, sha256):
    path = os.path.join(blob_root, sha256[:2], sha256)
    with open(path, "rb") as fh:
        return fh.read()


def is_safe_path(path):
    """Only canonical, nonempty POSIX paths below usr can enter a pool."""
    return (isinstance(path, str) and bool(path) and "\\" not in path
            and "\x00" not in path and ":" not in path
            and all(part not in ("", ".", "..") for part in path.split("/")))


def normalize_target(link_path, target):
    """Normalize a link within usr; reject external paths and root escapes."""
    if (not is_safe_path(link_path) or not isinstance(target, str)
            or not target or "\\" in target or "\x00" in target or ":" in target):
        return None
    absolute_prefix = TERMUX_PREFIX[1:-1]
    if target.startswith(TERMUX_PREFIX):
        raw = target[len(TERMUX_PREFIX):]
    elif target.startswith(absolute_prefix + "/"):
        raw = target[len(absolute_prefix) + 1:]
    elif target.startswith("/"):
        return None
    else:
        raw = posixpath.join(posixpath.dirname(link_path), target)
    parts = []
    for part in raw.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                return None
            parts.pop()
        else:
            parts.append(part)
    normalized = "/".join(parts)
    return normalized if is_safe_path(normalized) else None


def materialize_links(merged, symlinks, stage_entries=None, blob_root=None,
                      *, max_files=1000000):
    """Materialize file and directory links in-place, returning unresolved links.

    Dependencies include links *inside* a directory target, so directory copies
    see fully resolved aliases rather than a partial snapshot. Each link is
    attempted once, after its dependencies; cyclic/failed dependencies remain
    pending until the graph is exhausted. Existing destination files always win.
    A file-count bound additionally limits expansion of nested directory aliases.
    Stage directories are inferred from file paths (or explicit directory entries).
    """
    if max_files < len(merged):
        raise ValueError("max_files is smaller than the existing file count")
    if any(not is_safe_path(path) for path in merged):
        raise ValueError("unsafe path in merged files")
    stage_entries = {
        path: entry for path, entry in (stage_entries or {}).items()
        if is_safe_path(path) and entry.get("type") in ("file", "dir", "directory")
    }
    targets = {}
    unresolved = {}
    for path, raw_target in symlinks.items():
        target = normalize_target(path, raw_target)
        if target is None:
            unresolved[path] = raw_target
        elif path in merged:
            continue
        elif (path == target or path.startswith(target + "/")
              or target.startswith(path + "/")):
            # Never copy an ancestor into itself, or a descendant over its parent.
            unresolved[path] = raw_target
        else:
            targets[path] = target

    link_paths = sorted(path for path in symlinks if is_safe_path(path))
    dependencies = {}
    dependents = {}
    for path, target in targets.items():
        # A target may traverse an alias, or refer to a directory with aliases.
        deps = set()
        parent = target
        while parent:
            if parent in symlinks and parent not in merged:
                deps.add(parent)
            parent = posixpath.dirname(parent)
        prefix = target + "/"
        index = bisect_left(link_paths, prefix)
        while index < len(link_paths) and link_paths[index].startswith(prefix):
            candidate = link_paths[index]
            if candidate not in merged:
                deps.add(candidate)
            index += 1
        dependencies[path] = deps
        for dependency in deps:
            dependents.setdefault(dependency, []).append(path)

    def ancestors(path):
        parent = posixpath.dirname(path)
        while parent:
            yield parent
            parent = posixpath.dirname(parent)

    directories = {parent for path in merged for parent in ancestors(path)}
    for path, entry in stage_entries.items():
        directories.update(ancestors(path))
        if entry["type"] in ("dir", "directory"):
            directories.add(path)

    def stage_file(entry):
        if not blob_root:
            return None
        digest = entry.get("sha256", "")
        if (not isinstance(digest, str) or len(digest) != 64
                or any(c not in "0123456789abcdefABCDEF" for c in digest)):
            return None
        try:
            return stage_blob(blob_root, digest), entry.get("mode", 0o644)
        except OSError:
            return None

    def can_add_file(path):
        if path in merged:
            return True
        return (is_safe_path(path) and path not in directories
                and not any(parent in merged for parent in ancestors(path)))

    ready = deque(path for path in targets if not dependencies[path])
    resolved = set()
    while ready:
        path = ready.popleft()
        target = targets[path]
        additions = {}
        file_value = merged.get(target)
        entry = stage_entries.get(target)
        if file_value is None and entry and entry["type"] == "file":
            file_value = stage_file(entry)
        if file_value is not None:
            additions[path] = file_value
        elif target in directories:
            prefix = target + "/"
            if any(parent in merged for parent in ancestors(path)):
                continue
            failed = False
            # Snapshot: newly copied destinations never become their own sources.
            sources = {name: value for name, value in merged.items()
                       if name.startswith(prefix)}
            for name, source_entry in stage_entries.items():
                if name.startswith(prefix) and source_entry["type"] == "file":
                    destination = path + "/" + name[len(prefix):]
                    if name not in sources and destination not in merged:
                        value = stage_file(source_entry)
                        if value is None:
                            failed = True
                            break
                        sources[name] = value
            if failed:
                continue
            additions = {path + "/" + name[len(prefix):]: value
                         for name, value in sources.items()}
        else:
            continue
        new_paths = set(additions).difference(merged)
        if (len(merged) + len(new_paths) > max_files
                or any(not can_add_file(name) for name in additions)):
            continue
        for name, value in additions.items():
            merged.setdefault(name, value)
            directories.update(ancestors(name))
        if file_value is None:
            directories.add(path)
        resolved.add(path)
        for dependent in dependents.get(path, ()):
            dependencies[dependent].discard(path)
            if not dependencies[dependent]:
                ready.append(dependent)

    unresolved.update({path: symlinks[path] for path in targets if path not in resolved})
    return unresolved

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--debs", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--stage", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--go-binary",
                    help="用这个 ELF 覆盖 golang 池里的 bin/go 与 lib/go/bin/go"
                         "（由 tools/build-go-android.ps1 交叉编译产出）")
    args = ap.parse_args()

    # 覆盖用的 go 二进制只读一次。它必须是交叉编译产物而不是 deb 里那份：
    # deb 里的 go 是在 Termux 环境编的，二进制里写死
    # /data/data/com.termux/files/usr/etc/resolv.conf；而 ELF 内容在本项目里
    # 是**绝不改写**的（见本文件 rewrite_prefixes 的 ELF 短路、以及
    # tools/build-runtime.mjs 的 isElf 跳过），所以路径只能在编译期钉死。
    go_override = None
    if args.go_binary:
        with open(args.go_binary, "rb") as fh:
            go_override = fh.read()
        if go_override[:4] != ELF_MAGIC:
            raise SystemExit(f"--go-binary 不是 ELF：{args.go_binary}")

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
                    if not is_safe_path(path) or is_pruned(path):
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

        # Directory aliases wait for all file/directory dependencies to resolve.
        pending = materialize_links(merged, symlinks, stage_entries, blob_root)
        for path, raw_target in pending.items():
            skipped += 1
            print(f"      · {ext_id}: 链接环/未解析/不安全 {path} -> {raw_target}，跳过",
                  file=sys.stderr)

        out_path = os.path.join(args.out, f"{ext_id}.pool")
        total_bytes = 0
        placeholder_paths = []
        stripped_native = 0
        go_overridden = 0
        with tarfile.open(out_path, "w:gz", format=tarfile.GNU_FORMAT, compresslevel=6) as out:
            for path in sorted(merged):
                data, mode = merged[path]
                # golang 池：把 deb 自带的 go 换成编译期已钉死引擎根的产物。
                # 两份都要换 —— Termux 里 bin/go 与 lib/go/bin/go 是同一个文件，
                # 但设备端 `go` 走 PATH 命中的是 bin/go，而 GOROOT 自检用的是
                # lib/go/bin/go；漏掉任一份就会出现「版本/行为不一致」。
                if (go_override is not None and ext_id == "golang"
                        and path in GO_OVERRIDE_PATHS):
                    data = go_override
                    mode = 0o755
                    go_overridden += 1
                    info = tarfile.TarInfo(path)
                    info.size = len(data)
                    info.mode = 0o755
                    info.mtime = 0
                    out.addfile(info, io.BytesIO(data))
                    total_bytes += len(data)
                    continue
                data, changed = rewrite_prefixes(data)
                # ELF 的改写只有 patch_elf_shell_path 那一条等长替换，产物里
                # **不含**占位符，不需要设备端回填 —— 不进 placeholders 清单。
                if changed and data[:4] != ELF_MAGIC:
                    placeholder_paths.append(path)
                # jar 内的 jansi native 剥离（缺陷 BM）：只对 .jar 试，且只
                # 命中 `org/fusesource/jansi/internal/native/` 前缀的条目。
                stripped = 0
                if path.endswith(".jar"):
                    data, stripped = strip_jansi_native(data)
                    if stripped:
                        stripped_native += stripped
                        print(f"      · {ext_id}: {path} 剥掉 {stripped} 个 jansi native 条目")
                info = tarfile.TarInfo(path)
                info.size = len(data)
                # 只保留「属主可执行」这一语义位，其余归一到 0644/0755，
                # 避免把 setuid/setgid/sticky 之类的脏位带进设备端 chmod
                info.mode = 0o755 if (mode & 0o100) else 0o644
                info.mtime = 0
                out.addfile(info, io.BytesIO(data))
                total_bytes += len(data)

            # 改写清单：设备端装完扩展后按它逐条做占位符 → 真实路径的回填。
            # 为什么把清单放进 pool 而不是返回给调用方：安装可能在任何一次
            # 运行时发生（用户点「获取」），构建期的 report 那时早已不在设备上；
            # 只有随包一起走的清单才能让安装器自给自足。
            manifest = json.dumps(
                {
                    "extId": ext_id,
                    "placeholders": {
                        "@DSH_ROOT@": "root",
                        "@DSH_HOME@": "home",
                        "@DSH_TMP@": "tmp",
                        "@DSH_FILES@": "files",
                        "@DSH_DATA@": "data",
                    },
                    "files": placeholder_paths,
                },
                ensure_ascii=False,
                indent=2,
            ).encode("utf-8")
            info = tarfile.TarInfo(POOL_MANIFEST)
            info.size = len(manifest)
            info.mode = 0o644
            info.mtime = 0
            out.addfile(info, io.BytesIO(manifest))

        report.append({
            "id": ext_id,
            "files": len(merged),
            "totalBytes": total_bytes,
            "placeholderFiles": len(placeholder_paths),
            "strippedJansiNative": stripped_native,
            "goOverridden": go_overridden,
        })
        print(
            f"      {ext_id}: {len(merged)} 文件 / {total_bytes / 1048576:.1f} MiB"
            f"（跳过 {skipped} 条，改写路径 {len(placeholder_paths)} 个）→ {out_path}"
        )
        if go_overridden:
            print(f"      {ext_id}: 已替换 {go_overridden} 份 go 二进制"
                  f"（{len(go_override)} B，引擎根已钉死）")

    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump({"items": report}, fh, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
