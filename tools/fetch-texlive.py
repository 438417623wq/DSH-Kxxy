#!/usr/bin/env python3
"""下载 TeX Live 宏包树（问题.txt【4】）。

为什么需要这一步
----------------
Termux 的 `texlive-bin` deb 里**只有引擎**，没有任何宏包。实测该 deb 的
data.tar 里 `tex/latex`、`tex/plain`、`tlpkg` 全为 0 条，到设备上表现为：

    pdftex t.tex   -> I can't find the format file `pdftex.fmt'!
    mktexfmt       -> Can't locate mktexlsr.pl in @INC
    tlmgr          -> Can't locate TeXLive/TLConfig.pm in @INC

即「引擎在、但一个文档都编不出来」。宏包树归 `texlive-installer`
（install-tl 的包装脚本）从 CTAN 现场下载，而我们不能让用户在设备上跑
一次几百 MiB 的联网安装。

做法
----
取 CTAN tlnet 的 `texlive.tlpdb`（约 20 MiB）算出 `scheme-basic` 的依赖闭包，
逐个下 `archive/<name>.tar.xz` 并解开到 `<out>/share/texlive/<年份>/texmf-dist/`。

关键前提（已实测）
------------------
CTAN 的包内路径是**相对的**（`tex/latex/base/article.cls`、
`texmf-dist/web2c/texmf.cnf`、`texmf-dist/scripts/texlive/mktexlsr.pl`），
不带任何安装前缀 —— 它们本来就是往 `$TEXMFDIST` 里叠加的，所以解包即用。
tlnet 侧没有 `install-tl` 那样的 path 重写需求。

为什么选 scheme-basic 而不是 scheme-small / scheme-full
--------------------------------------------------------
    scheme-basic    118 包    19.5 MiB xz   plain TeX + LaTeX（能编真文档）
    scheme-small    390 包   122.8 MiB xz   多字体与推荐包
    scheme-full    4972 包  1514.5 MiB xz   全量
本项目 APK 已经 1.6 GiB，再塞 120 MiB 只为「更全」不划算；缺的包用户可以用
设备上的 `tlmgr` 自己装（宏包树到位后 tlmgr 就能跑了）。

用法
----
    python tools/fetch-texlive.py [--out DIR] [--scheme NAME] [--year 2026.0]
"""

from __future__ import annotations

import argparse
import io
import lzma
import os
import re
import shutil
import sys
import tarfile
import time
import urllib.error
import urllib.request

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(PROJECT, ".cache")

MIRRORS = [
    "https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet/",
    "https://mirrors.ustc.edu.cn/CTAN/systems/texlive/tlnet/",
    "https://mirrors.aliyun.com/CTAN/systems/texlive/tlnet/",
    "https://mirror.ctan.org/systems/texlive/tlnet/",
]

# scheme-* 的依赖树里**不含** `texlive.infra`（tlnet 的 scheme 假定由 install-tl
# 安装，infra 由安装器单独带入），但设备上要能 `tlmgr install <包>` 就必须有它 ——
# `tlmgr.pl`（361 KB）与 `tlpkg/TeXLive/*.pm` 全在这个包里。
EXTRA_PACKAGES = ("texlive.infra",)

# 这些子树随包带 doc/src，体积大且运行时用不到 —— 与 poolextract.py 的
# PRUNE_DIRS 同路数。TeX Live 自己的 scheme 定义里 doc/src 也是可选的。
PRUNE_PREFIXES = (
    "doc/",
    "source/",
    "texmf-dist/doc/",
    "texmf-dist/source/",
)
PRUNE_SUFFIXES = (".pdf", ".html", ".md", ".1", ".info")

UA = {"User-Agent": "dsh-kxxy-build/1.0"}

# ---- ls-R 相关常量（缺陷 AY）------------------------------------------------
# 首行必须是 kpathsea 魔数，逐字比对；写错一个字符 kpathsea 就会整体跳过索引。
LS_R_MAGIC = "% ls-R -- filename database for kpathsea; do not change this line."

# dvipdfmx.cfg 里 `p  a4` 的替身：A4 的精确 pt 尺寸。用长度对可绕开真机上
# 失效的 paper 名字表（`xdvipdfmx:fatal: Unrecognized paper format: a4`）。
PAPER_FIX_LINE = "p  595.28pt,841.89pt"


def fetch(url: str, timeout: int = 180, retries: int = 3) -> bytes:
    last = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt < retries:
                sys.stdout.write(f"      重试 {attempt}/{retries}: {exc}\n")
                time.sleep(1.5 * attempt)
    raise RuntimeError(f"下载失败 {url}: {last}")


def pick_mirror() -> str:
    for base in MIRRORS:
        try:
            req = urllib.request.Request(base, headers=UA)
            with urllib.request.urlopen(req, timeout=25) as resp:
                if resp.status == 200:
                    print(f"[texlive] 使用镜像 {base}")
                    return base
        except Exception:  # noqa: BLE001
            continue
    raise RuntimeError("所有 CTAN 镜像都不通")


def archive_cache_dir() -> str:
    d = os.path.join(CACHE, "texlive-archive")
    os.makedirs(d, exist_ok=True)
    return d


def fetch_pkg_archive(name: str, mirrors: list[str]) -> bytes:
    """取一个包的 .tar.xz，带镜像轮换与本地缓存。

    ⚠️ 实测：单个镜像会间歇性抛
    `SSL: UNEXPECTED_EOF_WHILE_READING`（大文件传到一半被切断）。
    首版只对**同一个镜像**重试两次，于是 `latex`、`l3kernel`、`etoolbox`
    这些包被整轮跳过，最后 `article.cls` 缺失 —— 与「没装」症状相同。
    所以这里对**每个镜像各试一遍**，并先把成功的包缓存到磁盘（重跑时
    已缓存的直接命中，不必从头再下一遍）。
    """
    cached = os.path.join(archive_cache_dir(), name + ".tar.xz")
    if os.path.exists(cached) and os.path.getsize(cached) > 0:
        with open(cached, "rb") as fh:
            return fh.read()
    last = None
    for base in mirrors:
        url = f"{base}archive/{name}.tar.xz"
        for attempt in (1, 2):
            try:
                req = urllib.request.Request(url, headers=UA)
                with urllib.request.urlopen(req, timeout=300) as resp:
                    data = resp.read()
                if not data:
                    raise RuntimeError("空响应")
                with open(cached, "wb") as fh:
                    fh.write(data)
                return data
            except urllib.error.HTTPError as exc:
                last = exc
                if exc.code == 404:
                    break  # 这个镜像没有该包，换下一个镜像
                time.sleep(1.0 * attempt)
            except Exception as exc:  # noqa: BLE001
                last = exc
                time.sleep(1.0 * attempt)
    raise RuntimeError(f"下载失败 {name}: {last}")


def parse_tlpdb(text: str):
    """解析 texlive.tlpdb 为 {name: {container, deps}}。"""
    pkgs = {}
    # 记录之间以 "\nname " 分隔；首条可能以 "name " 开头
    chunks = re.split(r"^name ", text, flags=re.MULTILINE)
    for chunk in chunks:
        if not chunk.strip():
            continue
        lines = chunk.split("\n")
        name = lines[0].strip()
        if not name:
            continue
        container = 0
        deps = []
        for line in lines:
            if line.startswith("containersize "):
                try:
                    container = int(line.split(None, 1)[1].strip())
                except ValueError:
                    pass
            elif line.startswith("depend "):
                deps.append(line.split(None, 1)[1].strip())
        pkgs[name] = {"container": container, "deps": deps}
    return pkgs


def norm(name: str) -> str:
    """把 tlpdb 的依赖写法归一化成纯包名。

    ⚠️ **不能按 `.` 切分**：`texlive.infra`、`texlive.infra.ARCH`、
    `00texlive.config` 这些名字里的点都是名字本身的一部分。首版写成
    `re.split(r"[.(]", name)[0]`，于是 `texlive.infra` 被当成 `texlive`
    —— 闭包漏掉整个基础包（tlmgr 的 perl 模块、xz 二进制全在里面），
    而 `texlive` 这个 archive 里根本没有的条目又被列进去下载（404 跳过）。
    症状就是「117 包都解开了，但 tlmgr.pl 与 TLConfig.pm 一个都没有」。

    tlpdb 的依赖可以带版本约束：`depend foo>=2024`、`depend foo=1.2`、
    `depend foo.ARCH`。只剥这些后缀。
    """
    s = name.strip()
    # 版本约束
    for sep in (">=", "<=", ">", "<", "="):
        if sep in s:
            s = s.split(sep, 1)[0].strip()
    # 架构后缀：`foo.ARCH` / `foo.i386-linux` / `foo.x86_64-linux`
    for suffix in (".ARCH", ".i386-linux", ".x86_64-linux", ".aarch64-linux"):
        if s.endswith(suffix):
            s = s[: -len(suffix)]
    return s


def closure(pkgs, root: str):
    seen = set()

    def walk(n: str) -> int:
        key = norm(n)
        if key in seen:
            return 0
        seen.add(key)
        p = pkgs.get(key)
        if p is None:
            return 0
        total = p["container"]
        for d in p["deps"]:
            total += walk(d)
        return total

    total = walk(root)
    # `tlmgr` 与它依赖的 perl 模块在 `texlive.infra` 里，而 scheme-basic 的
    # 依赖树**不含**它（tlnet 的 scheme 假定你用 install-tl 装，infra 由安装器
    # 单独带入）。设备上要能 `tlmgr install <包>` 就必须显式补进来。
    for extra in EXTRA_PACKAGES:
        total += walk(extra)
    return seen, total

# ★ tlnet 的包内路径有**两套约定**，必须归一化：
#
#   ① 只写 TDS 相对路径（多数包）：`tex/latex/base/article.cls`、`fonts/tfm/…`、
#      `bibtex/bst/…`、`web2c/texmf.cnf` —— 这些是相对 `$TEXMFDIST` 的，
#      也就是要落到 `<root>/texmf-dist/`。
#   ② 显式写 `texmf-dist/…`（texlive-scripts、kpathsea 等）：要把这一层剥掉。
#   ③ `tlpkg/…` 是相对 `$TEXMFROOT` 的（**不在** texmf-dist 里）：落到 `<root>/tlpkg/`。
#   ④ 根级散文件（`install-tl`、`LICENSE.*`、`release-texlive.txt`）：落到 `<root>/`。
#
# 首版没有做这一步，把 ①②③④ 全部平铺进 `<root>/`，结果 `article.cls` 落在
# `<root>/tex/latex/base/`（少了一层 `texmf-dist/`），kpathsea 按 `$TEXMFDIST`
# 去 `texmf-dist/tex/latex/base/` 找必然落空 —— 与「没装」是同一个症状。
TEXMF_ROOT_DIRS = ("tlpkg",)
TEXMF_ROOT_FILES = ("install-tl", "release-texlive.txt")
TEXMF_ROOT_FILE_PREFIXES = ("LICENSE", "README", "readme-")


def tds_relative(rel: str) -> str:
    """把包内成员名归一化成相对 `<root>` 的路径。"""
    parts = rel.split("/")
    head = parts[0]

    # ③ tlpkg 与 ④ 根级散文件：留在 $TEXMFROOT
    if head in TEXMF_ROOT_DIRS:
        return rel
    if rel in TEXMF_ROOT_FILES or head.startswith(TEXMF_ROOT_FILE_PREFIXES):
        return rel
    # 其它 texmf-*（texmf-var / texmf-config）本来就相对 $TEXMFROOT
    if head in ("texmf-var", "texmf-config"):
        return rel

    # ② 显式带 texmf-dist/：剥掉这层，后面统一补回
    if head == "texmf-dist":
        return "texmf-dist/" + "/".join(parts[1:])

    # ① TDS 相对路径：补上 texmf-dist/
    return "texmf-dist/" + rel


def should_prune(rel: str) -> bool:
    if any(rel.startswith(p) for p in PRUNE_PREFIXES):
        return True
    low = rel.lower()
    if low.endswith(PRUNE_SUFFIXES):
        return True
    return False


def make_hyphenation_minimal(dest: str) -> tuple[str, int]:
    """把 `language.dat` / `language.def` 收窄到「闭包里真正有断词文件」的语言。

    为什么必须做（缺陷 AY 的第二处）：`scheme-basic` 的
    `tex/generic/config/language.dat` **不是** basic 版 —— 它由 tlmgr 从
    完整的 language.us 生成，里面引了 **226 个**语言的断词文件
    （`dehypht-x-2024-02-28.tex`、`loadhyph-af.tex` …），而闭包里只有
    `hyphen.tex` / `hyph-en-*.tex` 那几个。`pdftex -ini` 建格式时逐行读它，
    读到第一个缺失的文件就 `Emergency stop`，**格式文件一个都生不出来**。

    真机实测：`pdftex -ini pdflatex.ini` 报
    `! I can't find file 'dehypht-x-2024-02-28.tex'.` ⇒
    `Fatal error occurred, no output PDF file produced`。
    改成只留 english + nohyphenation 之后，同一命令 rc=0 产出
    `pdflatex.fmt`（2,264,024 B），`pdflatex t.tex` → `Output written on
    t.pdf (1 page, 3535 bytes)`。

    保留原文件为 `.orig` 以便排查（不打进 zip，见 bundleTexliveMacros 的
    条目过滤）。返回 (说明, 保留条数)。
    """
    kept: list[str] = []
    for rel in (
        "texmf-dist/tex/generic/config/language.dat",
        "texmf-dist/tex/generic/config/language.def",
    ):
        path = os.path.join(dest, rel)
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
        out: list[str] = ["% [kxxy] 收窄到闭包内实际存在的断词文件（见 fetch-texlive.py）"]
        for line in lines:
            s = line.strip()
            if not s or s.startswith("%"):
                continue
            # 条目形如 `<lang> <file>`，file 可能是 `=alias`（不落文件）
            parts = s.split()
            if len(parts) < 2:
                continue
            pattern = parts[1]
            if pattern.startswith("="):
                continue
            found = False
            for base in ("texmf-dist/tex/generic/hyph-utf8/patterns/tex",
                         "texmf-dist/tex/generic/hyphen",
                         "texmf-dist/tex/generic/dehyph"):
                if os.path.exists(os.path.join(dest, base, pattern)):
                    found = True
                    break
            if found:
                out.append(s)
                kept.append(s)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(out) + "\n")
    return (f"断词条目 {len(kept)} 条（原 226 条，其余闭包里没有）", len(kept))


def write_ls_r(dest: str) -> int:
    """在 `texmf-dist/` 下生成 `ls-R` 文件名索引（缺陷 AY 的第三处）。

    为什么必须做：`texmf.cnf` 把 `TEXMFDBS` 里的树标成 `!!` 前缀 ——
    按 TeX Live 的约定，`!!` 意味着「**只用文件名数据库，不扫目录**」。
    而我们只解了包、从未跑过 `mktexlsr`，于是 `ls-R` 不存在 ⇒ kpathsea
    在 `!!$TEXMFDIST` 里什么都找不到：

        kpsewhich article.cls   → 空
        kpsewhich plain.tex     → 空
        kpsewhich fmtutil.cnf   → 空   ⇒ texlinks 报 config file not found

    ⚠️ 格式有三个**缺一不可**的硬要求，任何一条错了 kpathsea 都会整体忽略
    这个文件（表现为「文件明明在，kpsewhich 就是空」）：

      1. **首行必须是 kpathsea 魔数**，逐字为
         `% ls-R -- filename database for kpathsea; do not change this line.`
         早期版本这里写的是中文注释，真机 `mktexlsr` 当场报
         `no magic string, skipping...`；kpathsea 读索引时同样跳过整个文件。
      2. **文件名必须顶格**，前面不能有任何缩进。早期版本按「文件缩进两格」
         写（那是早期的 dvips 变体），kpsewhich 一条也认不出。
      3. **根目录也要有 section 头**，且写作 `./:`（不是省略）。
         早期版本 `if rel:` 把根跳过了，于是第一批文件名直接跟在魔数后面。

    真机 A/B 的三步定位（`_recon/probe-lsr*.sh`）：
      · 只补魔数         → 仍全空（因为缩进还在）
      · 补魔数 + 顶格    → `article.cls` / `plain.tex` / `fmtutil.cnf` 全部命中
      · 再让 `texlinks` 跑一次 → `latex` / `pdflatex` / `xelatex` 三个入口就位

    排序按 mktexlsr 的做法：一个目录内的**文件与子目录合并按名字排序**，
    不分成两段（早期版本文件全在前、子目录全在后，与真实索引不一致）。
    返回写入的文件条目数。
    """
    root = os.path.join(dest, "texmf-dist")
    if not os.path.isdir(root):
        return 0
    lines = [LS_R_MAGIC]
    count = 0

    def walk(rel: str) -> None:
        nonlocal count
        abs_dir = os.path.join(root, rel) if rel else root
        try:
            names = sorted(os.listdir(abs_dir))
        except OSError:
            return
        subdirs = []
        entries = []
        for name in names:
            if name.startswith("."):
                continue
            full = os.path.join(abs_dir, name)
            if os.path.isdir(full):
                subdirs.append(name)
            elif os.path.isfile(full):
                count += 1
            else:
                continue
            entries.append(name)
        lines.append(f"./{rel}:" if rel else "./:")
        lines.extend(sorted(entries))
        for name in subdirs:
            walk(f"{rel}/{name}" if rel else name)

    walk("")
    with open(os.path.join(root, "ls-R"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return count


def build_pdftex_map(dest: str) -> tuple[str, int]:
    """拼出 `pdftex.map`（缺陷 AY 的第四处）。

    为什么必须做：`updmap-sys` 在真机上**跑不通** —— 它按 `updmap.cfg` 里列的
    339 个 map 名去 `!!$TEXMFDIST` 里逐个找，而 scheme-basic 闭包里只有 43 个：

        updmap [ERROR]: yhmath.map (in …/web2c/updmap.cfg)
        updmap [ERROR]: yv1.map (in …/web2c/updmap.cfg)
        updmap [ERROR]: … 共 296 条
        updmap [ERROR]: Did you run mktexlsr?

    `--syncwithtrees` 想剪掉这批死条目，却因为 `TLUtils.pm` 里
    `system("sh ...")` 硬编码 `/data/data/com.termux/files/usr/bin/sh` 而失败
    （`Can't exec ... No such file or directory`），于是 `pdftex.map` 始终生不出来。

    没有 `pdftex.map` 的后果：pdflatex 编到第一个字就要 Type1 字体映射，
    找不到就让 `mktexpk` 去现搓 PK 位图，最终

        !pdfTeX error: pdflatex (file cmbx12): Font cmbx12 at 720 not found
         ==> Fatal error occurred, no output PDF file produced!

    所以我们构建期直接把闭包里**真实存在**的 dvips 类 map 拼成 `pdftex.map`。
    **只并 `fonts/map/dvips/`**：`dvipdfm/` 与 `dvipdfmx/` 下的 map 行格式不同
    （多了 `ReEncodeFont` 与 `.enc` 引用），并进来会让 xdvipdfmx 报
    `Found a mismatched fontmap line … Ignore the current input buffer`。

    落点必须精确 —— kpathsea 的 `TEXFONTMAPS` 搜索路径是
    `…/fonts/map/{kpsewhich,pdftex,dvips,}//`，所以只有
    `fonts/map/pdftex/updmap/` 与 `fonts/map/dvips/` 会被看到，
    放 `web2c/` 下无论如何都搜不到（真机实测：`kpsewhich pdftex.map` 返回空）。
    返回 (描述, 并入的 map 文件数)。
    """
    base = os.path.join(dest, "texmf-dist", "fonts", "map")
    src = os.path.join(base, "dvips")
    if not os.path.isdir(src):
        return ("未找到 fonts/map/dvips，跳过 pdftex.map", 0)
    maps = []
    for dirpath, _dirnames, filenames in os.walk(src):
        for name in sorted(filenames):
            if name.endswith(".map"):
                maps.append(os.path.join(dirpath, name))
    if not maps:
        return ("fonts/map/dvips 下没有 .map，跳过", 0)
    out_dir = os.path.join(base, "pdftex", "updmap")
    os.makedirs(out_dir, exist_ok=True)
    chunks = []
    for path in sorted(maps):
        try:
            with open(path, "r", encoding="latin-1") as fh:
                chunks.append(fh.read())
        except OSError:
            continue
    with open(os.path.join(out_dir, "pdftex.map"), "w", encoding="latin-1") as fh:
        fh.write("\n".join(chunks))
    lines = sum(c.count("\n") + 1 for c in chunks)
    return (f"pdftex.map 由 {len(maps)} 个 dvips map 拼成（{lines} 行）", len(maps))


def fix_dvipdfmx_paper(dest: str) -> str:
    """把 `dvipdfmx.cfg` 的纸张设置从 `a4` 换成显式长度对（缺陷 AY 的第五处）。

    为什么必须做：真机上 xdvipdfmx 对 `p  a4` 直接致命退出 ——

        xdvipdfmx:fatal: Unrecognized paper format: a4

    而且 `-p a4` / `-p letter` / `-p 595pt,842pt` 命令行参数**完全不起作用**
    （它只读 cfg，命令行那份被忽略），只有改 cfg 才有效：

      · `%p  a4`（注释掉）          → rc=0，出 3113 B PDF
      · `p  595.28pt,841.89pt`      → rc=0，出 3120 B PDF

    推测是 Termux 交叉编译后 paper 名字表（libpaper 或内建表）没初始化成功，
    但长度对走的是纯数值解析，不依赖那张表。A4 就是 595.28pt × 841.89pt。
    返回一行描述。
    """
    cfg = os.path.join(dest, "texmf-dist", "dvipdfmx", "dvipdfmx.cfg")
    if not os.path.isfile(cfg):
        return "未找到 dvipdfmx.cfg，跳过"
    with open(cfg, "r", encoding="latin-1") as fh:
        text = fh.read()
    if PAPER_FIX_LINE in text:
        return "dvipdfmx.cfg 已是显式长度对"
    replaced = 0
    out = []
    for line in text.split("\n"):
        if line.strip() in ("p  a4", "p a4"):
            out.append(PAPER_FIX_LINE)
            replaced += 1
        else:
            out.append(line)
    if not replaced:
        return "dvipdfmx.cfg 里没有 `p  a4`，未改动"
    with open(cfg, "w", encoding="latin-1") as fh:
        fh.write("\n".join(out))
    return f"dvipdfmx.cfg 纸张改为 {PAPER_FIX_LINE.strip()}（{replaced} 处）"


def extract_pkg(data: bytes, dest: str) -> tuple[int, int]:
    """解开一个 archive/<name>.tar.xz 到 dest，返回 (文件数, 字节数)。"""
    raw = lzma.decompress(data)
    files = 0
    written = 0
    with tarfile.open(fileobj=io.BytesIO(raw)) as tf:
        for member in tf:
            name = member.name
            # tlnet 的包成员是相对路径（tex/... 或 texmf-dist/...）
            if name.startswith("./"):
                name = name[2:]
            if not name or name == ".":
                continue
            rel = tds_relative(name)
            if should_prune(rel) and not member.isdir():
                continue
            target = os.path.join(dest, rel)
            if member.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            if member.issym():
                os.makedirs(os.path.dirname(target), exist_ok=True)
                link = member.linkname
                if os.path.lexists(target):
                    os.remove(target)
                try:
                    os.symlink(link, target)
                except OSError:
                    pass
                continue
            if not member.isfile():
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            fh = tf.extractfile(member)
            if fh is None:
                continue
            blob = fh.read()
            with open(target, "wb") as out:
                out.write(blob)
            mode = member.mode & 0o777
            if mode:
                try:
                    os.chmod(target, mode)
                except OSError:
                    pass
            files += 1
            written += len(blob)
    return files, written


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(CACHE, "texlive-macros"))
    ap.add_argument("--scheme", default="scheme-basic")
    ap.add_argument("--year", default="2026.0")
    ap.add_argument("--keep", action="store_true", help="保留已有解包结果（增量续装）")
    args = ap.parse_args()

    base = pick_mirror()

    print(f"[texlive] 取 texlive.tlpdb …")
    tlpdb = fetch(base + "tlpkg/texlive.tlpdb", timeout=300).decode("utf-8", "replace")
    pkgs = parse_tlpdb(tlpdb)
    print(f"[texlive] tlpdb {len(tlpdb) / 1048576:.1f} MiB，{len(pkgs)} 个包")

    names, total = closure(pkgs, args.scheme)
    if not names:
        print(f"[texlive] scheme {args.scheme} 不存在", file=sys.stderr)
        return 1
    print(f"[texlive] {args.scheme} 闭包 {len(names)} 个包，{total / 1048576:.1f} MiB (xz)")

    dest = os.path.join(args.out, "share", "texlive", args.year)
    if not args.keep and os.path.isdir(dest):
        shutil.rmtree(dest)
    os.makedirs(dest, exist_ok=True)

    ordered = sorted(names)
    done = 0
    files_total = 0
    bytes_total = 0
    failed = []
    for i, name in enumerate(ordered, 1):
        try:
            data = fetch_pkg_archive(name, MIRRORS)
        except Exception as exc:  # noqa: BLE001
            # 有些条目（如 00texlive.* 的虚拟包）在 archive 里没有实体
            failed.append(name)
            sys.stdout.write(f"  [{i}/{len(ordered)}] {name}: 跳过（{str(exc)[:60]}）\n")
            continue
        n, w = extract_pkg(data, dest)
        files_total += n
        bytes_total += w
        done += 1
        if i % 20 == 0 or i == len(ordered):
            print(f"  [{i}/{len(ordered)}] 已解 {done} 包，{files_total} 文件，{bytes_total / 1048576:.1f} MiB")

    print(f"[texlive] 完成：{done}/{len(ordered)} 包，{files_total} 文件，{bytes_total / 1048576:.1f} MiB")
    if failed:
        print(f"[texlive] 跳过 {len(failed)} 个：{', '.join(failed[:10])}")

    # 五处「解包本身不会产生、但 kpathsea/字体链必需」的产物（缺陷 AY）：
    #   ① 断词表收窄到闭包内真实存在的条目，否则 pdftex -ini 建格式必失败；
    #   ② 生成 ls-R 文件名索引，否则 !!$TEXMFDIST 里的东西一条也搜不到；
    #   ③④⑤ pdftex.map / dvipdfmx 纸张 / web2c 下 mktex* 脚本的可执行位。
    hyp_desc, hyp_n = make_hyphenation_minimal(dest)
    print(f"[texlive] {hyp_desc}")
    lsr_n = write_ls_r(dest)
    print(f"[texlive] ls-R 索引 {lsr_n} 条 → texmf-dist/ls-R")
    map_desc, map_n = build_pdftex_map(dest)
    print(f"[texlive] {map_desc}")
    print(f"[texlive] {fix_dvipdfmx_paper(dest)}")

    # ls-R 里必须包含刚生成的 pdftex.map，所以最后再刷一次索引。
    if map_n:
        lsr_n = write_ls_r(dest)
        print(f"[texlive] ls-R 重建（含 pdftex.map）{lsr_n} 条")

    # 验收：关键文件必须在。注意路径按 tds_relative 归一化后的位置写 ——
    # `tlpkg/` 在 `<root>/tlpkg/`（$TEXMFROOT 下），其余在 `<root>/texmf-dist/`。
    checks = {
        "texmf-dist/tex/latex/base/article.cls": "LaTeX 核心类",
        "texmf-dist/tex/latex/base/latex.ltx": "LaTeX 格式源码",
        "texmf-dist/tex/plain/base/plain.tex": "plain TeX",
        "texmf-dist/web2c/texmf.cnf": "kpathsea 配置",
        "texmf-dist/web2c/fmtutil.cnf": "格式定义",
        "texmf-dist/scripts/texlive/mktexlsr.pl": "mktexlsr（perl 模块）",
        "texmf-dist/scripts/texlive/fmtutil.pl": "fmtutil",
        "texmf-dist/scripts/texlive/tlmgr.pl": "tlmgr",
        "tlpkg/TeXLive/TLConfig.pm": "tlmgr 依赖",
    }
    missing = []
    print("[texlive] 关键文件验收：")
    for rel, desc in checks.items():
        p = os.path.join(dest, rel)
        ok = os.path.exists(p)
        print(f"  {'✓' if ok else '✗'} {desc}  ({rel})")
        if not ok:
            missing.append(rel)
    if missing:
        print(f"[texlive] 缺 {len(missing)} 个关键文件", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
