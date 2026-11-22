/**
 * 内置清单：④ 全能精选档种子包 + 扩展包池目录（J/K 组）。
 *
 * 抽成共享模块的理由：fetch-runtime.mjs（预装闭包）与 fetch-extensions.mjs
 * （包池边际闭包）必须用**同一份种子表**求交 —— 包池条目 = 包的闭包 − 预装闭包，
 * 两边种子表一旦漂移，包池里就会出现与预装重复的文件。
 *
 * 档位决策（用户已确认 ④ 全能精选档，2026-10-10）：
 *   预装 = ①②③④ 全量（220 包，APK ~366 MiB），J/K 组进包池（点了才本地展开，仍零联网）。
 */

/** Termux 主仓库（预装与包池共用；镜像切换只影响 npm 源，不影响构建期）。 */
export const TERMUX_REPO = "https://packages.termux.dev/apt/termux-main";

/**
 * 版本钉住：这些包**不跟索引走**，必须停在指定版本。
 *
 * 为什么需要它（2026-11-17 真事故）：
 *   Termux 把 `python` 从 3.14.8 推到 3.14.10 之后，`fetch-runtime` 照索引取了
 *   新版，于是 `build-runtime` 在 `verifyPythonInputs` 处直接失败：
 *
 *       Error: Python 构件的编译输入已变化，必须重新构建：
 *              include/python3.14/cpython/code.h
 *
 *   这是**正确**的失败 —— `tools/prebuilt/python-android-cp314/` 里那份 cffi
 *   wheel 是用 3.14.8 的头编出来的，`PYTHON_TARGET.version` 也钉着 3.14.8。
 *   重编 cffi 要 NDK + 一个**已经被 SHA256 钉死的 0.9.41 运行时 zip**，那条路
 *   在常规迭代里根本走不通。所以正确做法是让 python 停在 3.14.8：
 *
 *   · 3.14.8 → 3.14.10 是补丁级更新，功能上零收益；
 *   · 而它会让整个 Python 侧（cffi / cryptography / numpy 的 ABI 面）失去
 *     已验证的构建证明。
 *
 * 机制：`resolveClosure` 仍按索引解析（依赖关系取自新版条目，通常无变化），
 * 真正取包时如果缓存里已有 `<name>_<pin>_<arch>.deb`，就用缓存那份并把清单里
 * 的 version/size/sha256 换成实际值 —— 老版本 deb 早已从索引里下架，联网拿
 * 不到，所以这个钉只在「构建机缓存还在」时生效（缓存没了就按最新版走，并会在
 * build-runtime 的 CFFI 校验处立刻报错，而不是产出坏包）。
 */
export const SEED_VERSION_PINS = {
  python: "3.14.8",
  // `python-ensurepip-wheels` 必须与 python **同版本**，这不是洁癖而是硬约束：
  // python 包的 `ensurepip/__init__.py` 里写着 `_PIP_VERSION`，`_bootstrap()`
  // 按**精确文件名**去 `ensurepip/_bundled/` 找 `pip-<ver>-py3-none-any.whl`，
  // 找不到就 `assert` 失败 —— `python -m venv` exit 1，建出来的环境没有 pip。
  //
  // 真事故（2026-11-17，问题清单 P6）：python 被钉在 3.14.8（`_PIP_VERSION`
  // 要求 `pip-26.2.1-py3-none-any.whl`），而 ensurepip-wheels 跟着索引漂到
  // 3.14.10，带的只有 `pip-26.2.2`。两个包必须成对；单钉 python 不够。
  // 实测核对（解包 deb 的 data.tar.xz）：
  //   python-ensurepip-wheels 3.14.8  → _bundled/pip-26.2.1-py3-none-any.whl
  //   python-ensurepip-wheels 3.14.10 → _bundled/pip-26.2.2-py3-none-any.whl
  // 3.14.8 的 deb 在构建机缓存里（2026-10-25），离线可用。
  "python-ensurepip-wheels": "3.14.8",
  // libffi 同理，而且更隐蔽：它不带版本号痕迹，只会让 `build-runtime` 在
  // `verifyPythonInputs` 处报
  //     Error: Python 构件的编译输入已变化，必须重新构建：include/ffi.h
  // 真事故（2026-11-17）：索引把 3.8.0 推到 3.8.1，`include/ffi.h` 与
  // `lib/libffi.so` 摘要双双变化，而 `tools/prebuilt/python-android-cp314/`
  // 里那份 cffi 是用 **3.8.0** 的头编出来的（manifest 的 runtimeInputs 逐字
  // 记着 3e34056b… / e118d741…）。补丁级升级对 cffi 零收益，却要 NDK 重编。
  libffi: "3.8.0",
  // numpy 不是 cffi 的编译输入，但 `build-runtime` 的 verifyPythonRuntime 会
  // 核 `site-packages/numpy-<ver>.dist-info/WHEEL` 的平台标签（Termux 这份还是
  // 旧的 `android_aarch64` 标签，要留在 warnings 里而不是消失）。真事故
  // （2026-11-17 当天第二次）：索引把 2.5.4 推到 2.5.5，断言直接报
  // 「Python 运行时缺少 lib/python3.14/site-packages/numpy-2.5.4.dist-info/WHEEL」。
  // 补丁级升级对本项目零收益，钉住即可（缓存里有 2.5.4）。
  "python-numpy": "2.5.4",
};

/**
 * 兼容包：**同一软件包的第二个 major** 也要一起装（与 SEED_VERSION_PINS 相反）。
 *
 * 为什么需要（2026-11-17 真事故，清单第 2/3/4 项）：
 *   Termux 把 `libicu` 从 78.3 推到 79.1，但**索引里那一批包仍是按 78 编译的**：
 *
 *       php / php-cgi / phpdbg      → CANNOT LINK: "libicuio.so.78" not found
 *       xelatex / xetex / bibtexu / upmendex / libharfbuzz-icu.so → "libicuuc.so.78"
 *       tesseract 的 libpango_training.so / libunicharset_training.so → 同
 *
 *   而基线里的 `nodejs-lts` 是按 79 编译的。ICU 每个 major 都把导出符号重命名
 *   （`u_strlen_78` / `u_strlen_79`），所以「把 78 的 soname 指到 79」不是可行解
 *   —— 只能让两个 major 的文件同时存在于 `<root>/lib`。
 *
 * 为什么不用 SEED_VERSION_PINS：pin 是「换成老版本」，而这里**新旧都要**。
 * 顺序有语义：`debextract.py` 按 packages 顺序解包、同名路径**后者覆盖**，
 * 所以兼容包排在清单最前 —— 当前版本继续占住 `libicuuc.so` 这种不带版本号的
 * 开发链接与 `include/unicode/*` 头文件，兼容包只净增 `.so.78` 那一族。
 *
 * 体积代价：libicu 78.3 的 deb 10.2 MiB（解开 44 MiB，几乎全是 libicudata）。
 * 这是唯一能让 php 与 xetex 同时可用的办法 —— 除非上游把 php/texlive 重编到 79。
 * 一旦索引里那批包改链 79，这一项就该删掉（症状是「多了一份没人用的 .so.78」）。
 */
export const SEED_COMPAT_PACKAGES = [
  {
    name: "libicu",
    version: "78.3",
    why: "php / xetex / tesseract 训练库按 ICU 78 链接，nodejs-lts 需要 ICU 79",
  },
];

/** ④ 档种子：基线 22 包 + G0–G9 十组。 */
export const SEED_PACKAGES = [
  // ── 基线：让 DSH 引擎本身跑起来（22 个，缺一不可）──────────────────
  "nodejs-lts",                                        // node 本体（含 npm）
  "bash", "readline", "ncurses", "libiconv", "termux-tools", // bash 执行闭包
  "ripgrep", "pcre2",                                  // bionic 原生 rg
  "openssl", "c-ares", "libicu", "libsqlite", "zlib", "libc++", // nodejs-lts 硬依赖
  "libuv", "brotli",                                   // 静态链接兜底
  "libandroid-support",                                // bionic 兼容层辅助
  "ca-certificates",                                   // HTTPS 根证书
  "git", "openssh", "libcurl", "libexpat",             // 版本控制与远程访问

  // ── G0 构建小件：所有「./configure && make」流程的地基 ──────────────
  "make", "ninja", "cmake", "pkg-config",

  // ── G1 脚本与数据：AI 写脚本、处理 JSON/CSV/SQLite 的日常工具 ───────
  // python-ensurepip-wheels 必须跟着 python 一起装（缺陷 CM，问题清单 P6）：
  // `python` deb 自己只发 `ensurepip/{__init__,__main__,_uninstall}.py`，
  // 而 `ensurepip/_bundled/pip-<version>-py3-none-any.whl` 在这个**独立包**里。
  // 缺了它 `python -m venv .venv` 直接失败：
  //   Error: Command '[... /bin/python3.14, '-m', 'ensurepip', ...]' returned non-zero exit status 1.
  // shell 里的 `pip` 不受影响（python-pip 把 site-packages/pip 装好了），
  // 所以这个缺陷只在 venv 上暴露，很容易漏。
  // ⚠️ 不能只抄 wheels 包名了事：wheels 包声明 `Depends: python (= <同版本>)`，
  // 两者版本必须由 resolveClosure 一起解析，硬挑某个 whl 版本会和 python 的
  // `_PIP_VERSION` 常量错位（实测 3.14.6 期望 pip-26.1.2，而新 wheels 带 26.2.1）。
  "python", "python-pip", "python-ensurepip-wheels",
  // 三个最常用、且 PyPI 上**没有 Android wheel** 的扩展，由 Termux 预编译
  // 版本顶上（缺陷 CP，问题清单 P14）：
  //   `pip install numpy psutil cryptography` → `No matching distribution found`
  //   （numpy/psutil 没有 android_arm64 的 wheel），转源码编译又要 ninja/meson
  //   与完整 NDK 头，手机上一律失败。
  // 装这三个只多 7.1 MiB（numpy 5.93 含 libopenblas / psutil 0.08 / crypto 1.08），
  // 却把「数据分析、进程监控、加密」三条最常走的 Python 路打通。
  "python-numpy", "python-psutil", "python-cryptography",
  // 办公/文档/图像三件套（问题清单【9】）：`docx`、`openpyxl`、`pptx`、`PIL`、
  // `pandas` 之前一个都没有，任何「读一个 xlsx」「生成一份 docx」「裁一张图」
  // 的脚本都停在 `ModuleNotFoundError`。
  //
  // 为什么走 Termux 而不是 pip：这三个都带 C 扩展（lxml 的 libxml2 绑定、
  // Pillow 的 libjpeg/libwebp、pandas 的 numpy 扩展），PyPI 上没有 android_arm64
  // 的 wheel，现场编译要 meson/ninja + 完整 NDK 头，手机上一律失败。
  // Termux 侧是预编译好的 3.14 版（与内置 python 同 ABI：cp314 + aarch64）。
  //
  // 纯 Python 的那几个（python-docx / openpyxl / python-pptx / requests）**不放
  // 这里** —— 它们没有 deb，靠 `pip install` 即可（pip 与环境变量里的清华源都在）。
  // 补上 lxml/Pillow 之后这些 pip 安装全是纯 wheel 落地，几秒完成。
  "python-lxml", "python-pillow", "python-pandas",
  // 绘图库（问题清单【9】里唯一还没着落的那项）。
  //
  // 为什么必须是 Termux 的 `matplotlib` 而不是 `pip install matplotlib`：
  //   · PyPI 的 aarch64 轮子是 **manylinux**（glibc）链接，Android 的 bionic
  //     加载器直接拒绝（`dlopen failed: library "libstdc++.so.6" not found`）；
  //   · pip 在 Termux 上不做 manylinux 标签匹配，于是回落到源码包，
  //     现场编译要 freetype/qhull 头 + meson/ninja + 完整 NDK，手机上必败。
  // Termux 这份 3.11.2 是 bionic 交叉编译的，边际闭包只有 4 包 / 5.53 MiB
  // （`qhull` `python-contourpy` `python-kiwisolver` + 本体），
  // freetype/libraqm/ninja/patchelf 早已被 imagemagick 那条链带进来。
  // 装完 `import matplotlib.pyplot` 即可用（后端由 EngineConfig 钉成 Agg）。
  "matplotlib",
  // cryptography deb 的 postinst 会再用 pip 装 cffi；离线解包不运行维护脚本。
  // cffi>=2 + pycparser 由 build-python-deps.py 的 Android 构件显式补齐，
  // build-runtime 默认使用已验证构件（可用 --python-deps 指定）并核对 ABI/摘要，
  // 不能只依赖 apt 闭包。
  "jq", "yq", "fd", "fzf", "bat", "eza",
  "tree", "sd", "sqlite", "bc", "lua54",

  // ── G1.5 图片编解码后端：`sharp` 的 Android 替身必须能 spawn 到 magick ──
  //
  // 为什么必须在**预装**闭包里，而不是留在扩展池（缺陷 DX）：
  //
  // 上游 `sharp` 没有 android 预编译产物，`dsh-attachment-local` 的
  // `detectImage()` / `normalizeImage()` / `probeImage()` 一碰图片就必抛
  // `Could not load the "sharp" module using the android-arm64 runtime`。
  // 本项目的修法是换掉整个 `sharp` 包，用 `tools/prebuilt/sharp-android/`
  // 里的纯 JS 替身，**编解码全部 spawn `<root>/bin/magick`**（见缺陷 BF）。
  //
  // 但那个修法只写对了「替身」，没保证「magick 在设备上」：imagemagick 当时
  // 只存在于扩展池 `imagemagick` 条目里，而扩展池是**用户点「获取」才解包**
  // 的可选项。于是全新安装的设备上 `<root>/bin/magick` 根本不存在，替身
  // 每次 spawn 都是 `ENOENT`，`detectImage()` 把它包成
  // `AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE")`，
  // 前端 `attachmentErrorText()` 再把 `INVALID_IMAGE` 映射成
  // `image.unsupportedType` —— 用户看到的就是截图里那句
  // **「仅支持 PNG、JPG、WebP、GIF 格式的图片」**，而他发的恰恰是 PNG。
  // 也就是说：后端缺失被伪装成了「格式不支持」，完全误导排查方向。
  //
  // 体积代价：边际 47 包 / 46.95 MiB（含 ghostscript 19.47 MiB）。
  // 相对 1.85 GiB 的 APK 是 +2.5%，换来「开箱即可发图片」。
  // 顺带把 ghostscript 也变成预装 —— Office 预览与 PDF 那条链本来就要它。
  //
  // ⚠️ 副作用（已核实）：`imagemagick` 与 `ghostscript` 两个扩展池条目会因此
  // 变成「边际集合为空」，`fetch-extensions.mjs` 会跳过它们，扩展中心的
  // 卡片数从 26 降到 24。这两个工具**仍然可用**（已预装进 runtime.zip），
  // 只是不再需要用户手动获取。`verify-runtime.mjs` 的下限断言同步下调。
  "imagemagick",

  // ── G2 归档压缩：任何格式都能解 ────────────────────────────────────
  // xz-utils/tar/gzip/bzip2 已在基线（Termux deb 内层就是 data.tar.xz）。
  "zstd", "lz4", "zip", "unzip", "7zip", "unrar", "cpio", "libarchive",

  // ── G3 C/C++ 编译链：让 AI 能编译原生代码（含 Node 原生模块）────────
  // 注意 ndk-sysroot 提供 bionic 的 libc 头文件，clang 单独装不出可编译环境。
  "clang", "libllvm", "llvm", "lld", "libcompiler-rt", "binutils",
  "ndk-sysroot", "patchelf", "termux-elf-cleaner", "file",

  // ── G4 安卓打包链：dex → 签名 → 对齐，全套官方工具 ─────────────────
  // d8/apksigner/aapt2 只依赖 openjdk-21（不依赖 17），装两个 JDK 纯浪费 91.8 MiB。
  "openjdk-21", "d8", "ecj", "aapt2", "apksigner", "android-tools",

  // ── G5 移动端专属：让 AI 能调手机硬件 ──────────────────────────────
  "termux-api", "termux-services", "termux-auth", "termux-exec",
  "libandroid-glob", "libandroid-execinfo", "libandroid-sysv-semaphore",
  "libandroid-posix-semaphore", "libandroid-wordexp", "libandroid-utimes",
  "libandroid-shmem", "libandroid-spawn",

  // ── G6 容器提权：proot 里跑完整 Debian/Ubuntu ──────────────────────
  "proot", "proot-distro", "tsu", "fakeroot", "libcap",

  // ── G7 终端生存：标准 Unix 环境补全 ────────────────────────────────
  // coreutils/findutils/diffutils/less/procps/psmisc/util-linux 已在基线。
  "which", "time", "lsof", "strace", "htop", "tmux", "busybox", "nano", "ed",

  // ── G8 网络：下载、同步、隧道、诊断 ────────────────────────────────
  "wget", "rsync", "aria2", "sshpass", "socat", "netcat-openbsd",
  "dnsutils", "inetutils", "mosh", "dropbear", "gnupg",

  // ── G9 包管理：AI 能自己查/装包 ────────────────────────────────────
  "dpkg", "debianutils", "command-not-found", "root-repo", "x11-repo",

  // ── G10 标准 Unix 环境补缺（缺陷 CN，问题清单 P18）──────────────────
  //
  // 原报告「缺 man/libtool/zsh/fish/vim/nvim/gh/zipalign/bundletool/btop/ncdu」
  // 里，zipalign / bundletool / btop 在 Termux 主仓库**根本不存在**（不是漏装）：
  //   · zipalign   —— Android SDK build-tools 的二进制，从不在 Termux 仓库。
  //                   已自建：`build-runtime.mjs` 的 `packagingWrappers()`
  //                   生成 `bin/zipalign` 包装器（转调自研
  //                   `packaging/zipalign.mjs`，纯 JS 做 4/8/16 KiB 对齐、
  //                   不重压数据）。见流水线 6.9 步。
  //   · bundletool —— Google 的 Java jar，靠 `java -jar bundletool.jar` 跑，
  //                   不是 apt 包。已自建：`bundletool-all.jar`（32.5 MiB，
  //                   取自 GitHub Releases 1.18.3）随插件落
  //                   `lib/node_modules/kxxy-host/packaging/`，
  //                   `bin/bundletool` 包装器先找 `share/java/` 再回落这里，
  //                   并自动用引擎自带 JDK（不依赖 PATH 上的 java）。
  //   · btop       —— 仓库里只有 htop（已在 G7）。**这一项是真的不装**：
  //                   它只是 htop 的替代品，功能重叠且没有独有能力。
  // 剩下能装的分两档：便宜的、几乎所有构建脚本都会碰的进预装；
  // fish / neovim / gh 体积各 6.8–9.6 MiB、且和已装的 tmux/nano/emacs 功能重叠，
  // 放进扩展池 `shells` 项，用户按需获取。
  //
  // libtool 属于「autoreconf 缺它就 Exit 127」的地基（G0 同族），
  // mandoc + manpages 让 `man ls` 这类最基础的求助方式可用，
  // ncdu 只有 40 KiB 却能救磁盘满的现场，zsh 1.9 MiB、vim 6.7 MiB
  // （报告明确点了 vim/nvim 都没有，而现有只有 nano/emacs）。
  "mandoc", "manpages", "libtool", "ncdu", "zsh", "vim",

  // ── G11 科学计算与排版（真机反馈第 10 项，v0.9.68）─────────────────────
  //
  // ① `python-scipy` —— numpy 已在预装，但 `scipy` 一直没进来，于是
  //    `import scipy` / `from scipy import stats` 一律 ModuleNotFoundError。
  //    Termux 侧是 cp314 + aarch64 的预编译件，边际只有 2 包 / 12.0 MiB
  //    （本体 + libandroid-complex-math），是所有科学计算包里最划算的一项。
  //    它同时把 `numpy.linalg` 之外的 `scipy.linalg` / `optimize` / `signal`
  //    / `sparse` 全部打通 —— sklearn 那类纯 Python 上层库随后 `pip install`
  //    就能落地（它们只依赖 numpy/scipy 的 ABI）。
  //
  // ② `typst` —— 现代排版引擎（单二进制 13.7 MiB，无运行时依赖）。
  //    `typst compile x.typ` 与 `typst watch` 开箱即用，比 texlive 那条
  //    700 MiB 的链轻两个数量级；两者面向的场景不同，不冲突。
  //
  // ③ `ltrace` —— 跟踪库调用（`ltrace -e malloc ./prog`）。0.1 MiB，
  //    与已预装的 strace 成对：strace 看系统调用，ltrace 看 so 调用。
  "python-scipy", "typst", "ltrace",

  // ── G12 包管理器：pnpm 必须**离线可用**（真机反馈第 10 项）──────────────
  //
  // `dsh plugin …` 子命令与 `pnpm` 本身在手机上会卡死到超时（`exit 124`，
  // 单跑 `pnpm --version` 也 150 s 不返回）。原因不是网络慢，而是 `bin/pnpm`
  // 当时指向 **corepack shim**：corepack 首次运行要把 `packageManager` 字段
  // 指定的 `pnpm@12.21.0` 整包下载并解到 `~/.cache/node/corepack`，手机侧
  // 既慢又常被 CDN 挂住。
  //
  // 为什么取 Termux 的 `pnpm` 而不是 npm 上的同名包：pnpm 官方 12.x 发行物
  // 是**原生可执行文件**（`@pnpm/exe.*`，只有 glibc/musl 两种 linux 目标，
  // 没有 bionic），npm 包里只剩一个「找不到就去 registry 现下载」的 shim，
  // 装到设备上第一次运行照样要联网。Termux 这份是源码编的纯 JS 版本，
  // 直接跑在引擎自带的 node 上。`Depends: git` 由基线里的 git 满足。
  "pnpm",
];

/**
 * 扩展包池目录（五项改进方案 §4.1 J/K 组，全部进池不预装）。
 *
 * 每一项在构建期展开为「闭包 − 预装闭包」的边际集合，打成
 * `android/app/src/main/assets/ext-pool/<id>.tar.gz`；用户在扩展中心点
 * 「获取」时由 kxxy-host 本地解包（零联网）。
 *
 * 不收录：openjdk-17（与 21 并存纯浪费）、swift（安卓开发用不上）——
 * 见方案 §4.1 K 组「不建议」注记。
 */
export const POOL_ITEMS = [
  // ── J 组：媒体与文档 ────────────────────────────────────────────────
  {
    id: "ffmpeg", seeds: ["ffmpeg"], category: "media",
    name: "FFmpeg 多媒体工具链",
    description: "音视频转换、剪辑、抽帧、抽音轨。手机端做语音/视频处理绕不开它。",
    bins: ["ffmpeg", "ffprobe"],
  },
  {
    id: "imagemagick", seeds: ["imagemagick"], category: "media",
    name: "ImageMagick 图像处理",
    description: "图像缩放/裁剪/格式转换/合成（与 DSH 自带 sharp 有部分重叠，重场景仍需要它）。",
    bins: ["magick", "convert", "identify"],
  },
  {
    id: "tesseract", seeds: ["tesseract"], category: "media",
    name: "Tesseract OCR 文字识别",
    description: "离线 OCR（与 DSH 自带 modlens 视觉模型互补：批量、精确坐标场景更省电）。",
    bins: ["tesseract"],
  },
  {
    id: "poppler", seeds: ["poppler"], category: "media",
    name: "Poppler PDF 工具",
    description: "PDF 提取文字 / 渲染成图 / 拆页合并。",
    bins: ["pdftotext", "pdftoppm", "pdfinfo"],
  },
  {
    id: "ghostscript", seeds: ["ghostscript"], category: "media",
    name: "Ghostscript",
    description: "PDF/PS 转图、压缩、打印处理。",
    bins: ["gs"],
  },
  {
    id: "exiftool", seeds: ["exiftool"], category: "media",
    name: "ExifTool 元数据",
    description: "读写图片/视频的 EXIF / XMP 元数据。",
    bins: ["exiftool"],
  },
  {
    id: "mediainfo", seeds: ["mediainfo"], category: "media",
    name: "MediaInfo",
    description: "读取媒体文件的编码、码率、轨道信息。",
    bins: ["mediainfo"],
  },
  {
    id: "sox", seeds: ["sox"], category: "media",
    name: "SoX 音频处理",
    description: "音频格式转换、降噪、变速（语音识别前的切片预处理）。",
    bins: ["sox"],
  },
  {
    id: "yt-dlp", seeds: ["yt-dlp"], category: "media",
    name: "yt-dlp 视频下载",
    description: "主流视频站点的命令行下载器（需自备网络环境）。",
    bins: ["yt-dlp"],
  },
  {
    id: "qpdf", seeds: ["qpdf"], category: "media",
    name: "QPDF",
    description: "PDF 结构级拆分、合并、解密、线性化。",
    bins: ["qpdf"],
  },

  // ── K 组：可选重件（体积大，全部进池不预装）─────────────────────────
  {
    id: "gradle", seeds: ["gradle"], category: "toolchain",
    name: "Gradle 构建系统",
    description: "安卓官方构建系统。注意：构建时还要联网拉依赖，手机上体验有限。",
    bins: ["gradle"],
  },
  {
    id: "rust", seeds: ["rust"], category: "toolchain",
    name: "Rust 工具链",
    description: "rustc + cargo，编译 Rust 项目与 Node 原生模块。",
    bins: ["rustc", "cargo"],
  },
  {
    id: "kotlin", seeds: ["kotlin"], category: "toolchain",
    name: "Kotlin 编译器",
    description: "kotlinc。d8 已能处理 kotlinc 产出的 class。",
    bins: ["kotlinc"],
  },
  {
    id: "golang", seeds: ["golang"], category: "toolchain",
    name: "Go 工具链",
    description: "go 编译器与工具（含 go mod）。",
    bins: ["go", "gofmt"],
  },
  {
    id: "gdb", seeds: ["gdb"], category: "toolchain",
    name: "GDB 调试器",
    description: "C/C++ 断点调试。",
    bins: ["gdb"],
  },
  // ── L 组：Java / 脚本语言运行时（缺陷 BL / BN / BO 的补齐）─────────────
  //
  // 这五个都是「用户报缺、Termux 主仓确实有」的常驻语言工具链，此前完全
  // 没进池 —— 真机上 `mvn` / `php` / `ruby` / `erl` / `yarn` 一律 command
  // not found。边际体积（相对 ④ 预装闭包）实测：maven 9.17 MiB、
  // yarn 875 KiB、php 13.33 MiB、ruby 9.33 MiB、erlang 44.82 MiB，合计
  // 约 77.5 MiB，相对现有 1.1 GiB 池增 7%，可以接受。
  //
  // ⚠️ maven 的 37 包闭包里 36 包已在预装基线（openjdk-21 等），所以边际
  // 只有 maven 本体 —— 但它**依赖 openjdk-21**，而 openjdk-21 只在 ④ 档
  // 预装里；③ 档用户装 maven 时 `java` 可能不存在。所以 Maven 的运行
  // 还依赖 EngineConfig 注入的 JAVA_HOME（见 buildEnv 的 javaHome 探测）。
  {
    id: "maven", seeds: ["maven"], category: "toolchain",
    name: "Apache Maven",
    description: "mvn 构建 Java 工程。依赖引擎自带 OpenJDK 21，联网拉依赖仍走手机网络。",
    bins: ["mvn"],
  },
  {
    id: "php", seeds: ["php"], category: "devtools",
    name: "PHP",
    description: "php 8.x 解释器与 CLI（含 libxml/libzip/tidy 等扩展依赖）。",
    bins: ["php"],
  },
  {
    id: "ruby", seeds: ["ruby"], category: "devtools",
    name: "Ruby",
    description: "ruby 4.x 解释器与 gem 基础设施。",
    bins: ["ruby", "gem", "irb"],
  },
  {
    id: "erlang", seeds: ["erlang"], category: "devtools",
    name: "Erlang/OTP",
    description: "erl / escript / erlc，OTP 运行时（体积较大，44 MiB）。",
    bins: ["erl", "erlc", "escript"],
  },
  {
    id: "yarn", seeds: ["yarn"], category: "devtools",
    name: "Yarn",
    description: "经典 Yarn 1.x 包管理器（引擎已带 node，不需要它拉 nodejs）。",
    bins: ["yarn", "yarnpkg"],
  },
  {
    id: "texlive", seeds: ["texlive-bin"], category: "toolchain",
    name: "TeX Live (bin)",
    description: "LaTeX 排版引擎本体（宏包需另外获取）。",
    bins: ["pdflatex", "latex", "xelatex"],
  },
  {
    id: "autotools", seeds: ["autoconf", "automake"], category: "toolchain",
    name: "Autoconf/Automake",
    description: "老式「./configure && make」工程的构建套件。",
    bins: ["autoconf", "automake"],
  },
  {
    id: "pandoc", seeds: ["pandoc"], category: "devtools",
    name: "Pandoc",
    description: "Markdown / HTML / docx / LaTeX 之间的万能文档转换。",
    bins: ["pandoc"],
  },
  {
    id: "emacs", seeds: ["emacs"], category: "devtools",
    name: "Emacs",
    description: "无头模式可用的编辑器 / org-mode 处理器。",
    bins: ["emacs", "emacsclient"],
  },
  {
    id: "gnuplot", seeds: ["gnuplot"], category: "devtools",
    name: "Gnuplot",
    description: "命令行画图表（数据可视化、函数绘图）。",
    bins: ["gnuplot"],
  },
  {
    id: "perl", seeds: ["perl"], category: "devtools",
    name: "Perl",
    description: "git-svn / git-p4 的依赖，经典脚本语言。",
    bins: ["perl"],
  },
  // ── L 组：编辑器与 shell（缺陷 CN，问题清单 P18 里体积大的那几个）───────
  //
  // 报告点的 man/libtool/zsh/vim 已进预装（G10），这里只放「功能和已有东西
  // 重叠 / 单个体积不小」的三个：neovim 的 runtime 带全套 vim 语法；
  // treesitter parser 由依赖包放在 lib/tree_sitter，runtime/parser 的目录
  // 链接必须在打包时物化，否则 .md / .lua / :help / query 会报 E5113。
  // fish 自带 6.8 MiB 的 function 库、gh 是老版本 git 之外的 GitHub 客户端。
  {
    id: "shells", seeds: ["fish", "neovim", "gh"], category: "devtools",
    name: "fish / Neovim / GitHub CLI",
    description: "交互式 shell（fish）、现代编辑器（nvim，语法高亮齐全）、GitHub 命令行客户端。",
    bins: ["fish", "nvim", "gh"],
  },

  // ── N 组：多语言运行时与系统级工具（问题清单 P9 的剩余部分）────────────
  //
  // 这些在 Termux 主仓里都有（所以只是「没进池」，不是「编译不出来」）。
  // 逐个查过索引：julia / gfortran / perf / dotnet 主仓**没有**，那几项仍是
  // 能力缺口，不要写进这里假装补上。
  //
  // 体积（deb 压缩后）：deno 27 MiB、valgrind 2.7 MiB、racket+sbcl 15 MiB。
  //
  // ⚠️ 有两个**打了池但没进包**的，理由不是体积，是真机装完用不起来：
  //
  //   · tcc（0.24 MiB）：`tcc` 的 CONFIG_TCCDIR 指 Termux 前缀还能靠重写层兜住，
  //     但它没有自己的 libc —— 拿 bionic 头编任何带 `#include <stdio.h>` 的文件，
  //     第一步就停在
  //       sys/cdefs.h:365: #error Unversioned target triples are not supported!
  //     因为 bionic 要求 `--target=aarch64-linux-androidNN` 这种带版本的三元组，
  //     而 tcc 的预定义宏里没有 `__ANDROID_API__`。要修得给 tcc 打补丁或塞一份
  //     裁剪过的 musl 头 —— 而引擎已经自带 clang 21（target 已是
  //     aarch64-unknown-linux-android24），`tcc -run` 那点便利不值这个维护成本。
  //   · nim（7.1 MiB）：编译器本体没问题（`nim --version` 报 2.4.2 arm64），
  //     但它生成 C 之后要交给后端编译器，默认 `gcc` 在这个引擎里不存在，
  //     显式 `--cc:clang --lib:<ext>/lib/nim/lib` 能过前几步、仍在生成 C 的
  //     标准头阶段失败（`#include <string.h>` 找不到）。归因是 nim 的
  //     `config/nim.cfg` 里那套 gcc/clang 选项假设了 Termux 的 `$PREFIX/bin/cc`。
  //     要修得给每个版本维护一份 nim.cfg；同样属于「配好能用但没有验证过就不发」。
  //
  // 两个池仍可按需单独打（`KXXY_POOL_ONLY=tcc` / `=nim`），产物在
  // `.cache/apk-assets-hold/ext-pool/`，装法与 node-tools 相同。
  {
    id: "deno", seeds: ["deno"], category: "devtools",
    name: "Deno 运行时",
    description:
      "原生 TypeScript/JavaScript 运行时（自带权限沙箱、fmt/lint/test/bundle），" +
      "不需要 node_modules 就能跑 .ts。",
    bins: ["deno"],
  },
  // ⚠️ Zig 从 v0.9.68 起**进池**（此前"有意不进包"的结论被真机反馈推翻）：
  // 解包 511 MiB、压完 ~145 MiB，是整套池子里最大的一项，会把 APK 顶到
  // 2.4 GiB 以上。之所以改主意：`zig cc` 自带 libc/头文件与增量缓存，
  // 手机上是少数**不需要 ndk-sysroot 也能独立编出 aarch64 产物**的工具链，
  // 而引擎里的 clang 一旦离开 NDK 头就编不动。代价可控（池子 +12%），
  // 收益是「用户点名要的东西真的有」。
  // 需要单独重打某几个池（不重跑全量）时：
  //     KXXY_POOL_ONLY=zig,dotnet node tools/fetch-extensions.mjs
  {
    id: "zig", seeds: ["zig"], category: "toolchain",
    name: "Zig 工具链",
    description:
      "zig 0.17（自带 libc 头与链接器）：`zig cc` 当 C 交叉编译器用，" +
      "`zig build-exe` 直接出 aarch64 可执行文件，不依赖 NDK。体积较大（约 511 MiB）。",
    bins: ["zig"],
  },
  {
    id: "fortran", seeds: ["lfortran", "flang"], category: "toolchain",
    name: "Fortran 编译器 (flang + LFortran + gfortran 前端)",
    description:
      "Termux 主仓**没有 gfortran**（GCC 的 Fortran 前端没打包，`gcc`/`gfortran` 索引零命中），" +
      "改由 LLVM 的 `flang`（21.x，Fortran 2018 + OpenMP）与 `lfortran`（轻量、可直接解释）顶上，" +
      "并由引擎补一个 `gfortran` 前端转发到 flang —— `./configure`、Makefile、CMake 工具链里" +
      "硬写 `gfortran` 的项目因此能直接跑（`-c -o -O2 -fPIC -shared -I -L -l -J -cpp -std=` " +
      "以及 `-ffree-form`/`-ffixed-form`/`-fopenmp` 实测全部接受）。" +
      "注意它仍是前端：GNU 方言扩展（`-fdec`、部分 legacy 行为）到不了位。" +
      "池内会自动把引擎的 crt 对象、compiler-rt builtins、libunwind.a 链进来，" +
      "否则 `flang` 只能 `--version`、真编译全在 ld.lld 阶段失败。",
    bins: ["flang", "flang-new", "lfortran"],
  },
  // ⚠️ dotnet **不发包**（v0.9.69 实测后撤下）：Termux 侧的 dotnet 闭包缺宿主。
  //
  // `dotnet-sdk-8.0` / `dotnet-runtime-8.0` / `dotnet-targeting-pack-8.0` 的全部文件
  // 都落在 `lib/dotnet/` 里（SDK、运行时、模板、targeting pack 一样不缺，解包
  // 116 MiB），但**没有任何一个 deb 提供 `dotnet` 宿主可执行文件** ——
  // 逐个 deb 扫过 basename 为 `dotnet` 的条目（含符号链接/硬链）零命中，
  // 而 `dotnet-host_10.0_aarch64.deb` 只有 **700 字节**、内容只有一个 `.` 目录项，
  // 是个空壳。于是 `bin/dotnet` 无从生成，SDK 那一大坨 DLL 永远跑不起来。
  //
  // 要真正可用得自己编 host（`dotnet/runtime` 的 native host，交叉编 bionic），
  // 或者在扩展池里塞一份 linux-arm64 的 host —— 后者**现在可以了**：
  // 见下方 `glibc` 条目，`kxxy-glibc` 里 `apt install dotnet-sdk-8.0` 即可，
  // 代价是要过一层 proot（慢，但功能是全的）。本条目仍保留 Mono 这一档。
  //
  // 需要时的替代：C# 脚本类需求用 `mono`（Termux 也没有）、或走 `dotnet` 官方
  // 的 wasm/容器方案 —— 都属于「换工具链」，不在本包范围内。
  {
    // C#：Termux 的 dotnet 闭包缺宿主（见上方 dotnet 注释），能真正用的是 Mono 6.14 ——
    // 自带 C# 编译器（`m` + `cs` 两个字母那条命令、以及 `csc`）、`mono` 运行时与
    // `csharp` 交互式 shell，覆盖 .NET Framework 时代的类库子集。
    // 新式 `dotnet new/build`、NuGet 还原、`net8.0` 目标框架都用不了。
    id: "csharp", seeds: ["mono"], category: "devtools",
    name: "C# 编译器与运行时 (Mono)",
    description:
      "Mono 6.14：mcs / csc 编译、mono 运行、csharp 交互式。支持 C# 7 语法与 .NET " +
      "Framework 类库子集；dotnet SDK 在 Termux 下缺宿主可执行，不可用。",
    bins: ["mono", "mcs", "csc", "csharp"],
  },
  // ── glibc 用户态：bionic 装不下的那一整类工具的解 ────────────────────────
  //
  // 起因是四条一直补不上的缺口（julia / dotnet / wkhtmltopdf / glibc 轮子），
  // 它们不是「Termux 忘了打包」，而是**根本没有 bionic 构件**：
  //   · julia 只发 linux-x86_64 / linux-aarch64（glibc）；
  //   · dotnet 的宿主是 glibc 链接（Termux 闭包里连宿主都没有，见上）；
  //   · wkhtmltopdf 依赖打包好的 Qt/WebKit（glibc）；
  //   · PyPI 的 manylinux 轮子（sklearn/cv2 之类）同理 —— 见 MEMORY 里
  //     「glibc 轮子在 bionic 上不可能可用」那条：垫片方案最后必然卡在
  //     `ld-linux-aarch64.so.1 is not accessible for the namespace`。
  //
  // 唯一走得通的路是**换一个完整的 glibc 用户态**：proot + 一份 Ubuntu base
  // rootfs。proot 本身已在预装闭包里（`<root>/bin/proot` + `libexec/proot/loader`），
  // 这一项只带 rootfs 与一个 `kxxy-glibc` 入口。
  //
  // 真机实测（Redmi K60 Pro，patchset 31 之后的验证）：
  //   `kxxy-glibc -c 'apt-get update'` → apt 2.7 MB/s；
  //   `apt install python3-pip` 后 `pip install scikit-learn opencv-python-headless`
  //   → numpy 2.5.5 / sklearn 1.9.1 / cv2 5.1.0，`LinearRegression` 真拟合 coef=2.0。
  //
  // 为什么进池而不预装：rootfs 种子 29.8 MB（解出来 80 MB），加上用户 apt 装的
  // 东西很容易上 GB，塞进 APK 对「不用 glibc」的人是纯负担；而且它是**有状态**的
  // （用户在里面装包），放池里按需解包、数据落在 `<files>/glibc/` 才不会被
  // runtime 重装清掉。
  //
  // 为什么 seed 是一整块 tar.gz 而不是解开的文件树：池解包器会跳过符号链接，
  // 而这份 rootfs 有 194 条软链 —— 详见 `tools/lib/asset-pack.mjs` 顶部注释。
  {
    id: "glibc", source: "asset", category: "toolchain",
    version: "24.04.3-r3",
    name: "glibc 用户态（Ubuntu 24.04 + proot）",
    description:
      "在 proot 里跑一份**未改动的 Ubuntu 24.04 base**：`kxxy-glibc` 进容器，" +
      "`kxxy-glibc -c 'apt-get update'` 直接装包。所有只有 glibc 构件的工具都能用了 —— " +
      "julia、dotnet-sdk、wkhtmltopdf、PyPI 的 manylinux 轮子（sklearn/cv2）都在这一类。" +
      "装完扩展还多出四条**普通命令**：`julia`、`dotnet`、`wkhtmltopdf`、`kxxy-py`，" +
      "首次运行时各自在容器里预置（要联网，之后一直复用），所以不必记容器用法。" +
      "无需 root、不改系统，代价是每条系统调用多一层 ptrace 转发（比原生慢 2–5 倍）。" +
      "首次运行解包 rootfs 约 1 分钟；之后 apt 装的东西都留在 <files>/glibc/rootfs，" +
      "重装扩展或升级 APK 都不会丢。",
    // 用户能看到/点到的命令。`kxxy-glibc` 是入口，四条工具命令是垫片（首次自动预置），
    // `kxxy-glibc-provision` 用于手动补/重做预置。
    bins: ["kxxy-glibc", "kxxy-glibc-provision", "julia", "dotnet", "wkhtmltopdf", "kxxy-py"],
    assets: [
      {
        // Ubuntu Base 24.04.3（arm64）：29 865 086 字节，与 sha256 一起钉死。
        // 24.04 的 `release/` 目录会随点版本滚动（现在指向 24.04.5），
        // 所以固定到 24.04.3 自己的目录，避免某天产物悄悄换掉。
        from: ".cache/glibc/ubuntu-base-24.04.3-base-arm64.tar.gz",
        url: "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04.3/release/ubuntu-base-24.04.3-base-arm64.tar.gz",
        sha256: "7b2dced6dd56ad5e4a813fa25c8de307b655fdabc6ea9213175a92c48dabb048",
        to: "rootfs/ubuntu-base.tgz",
        // 归档里有两条硬链（perl5.38.2 / uncompress），应用域建不出来 → 构建期改写
        dereference: true,
      },
    ],
    wrappers: ["kxxy-glibc", "kxxy-glibc-provision"],
    // 垫片：模板 `glibc-tool.sh` 渲染，`exe` 是容器内的绝对路径。
    // 之所以要垫片：容器里的程序直接 exec 会 `CANNOT LINK EXECUTABLE`，必须过 proot；
    // 顺带把「首次预置」也收进来，用户拿到的就是一条普通命令。
    toolTemplate: "glibc-tool",
    tools: [
      {
        name: "julia", exe: "/opt/julia-1.11.7/bin/julia", group: "julia",
        label: "Julia 1.11.7", hint: "官方 aarch64 包约 285 MiB",
      },
      {
        name: "dotnet", exe: "/usr/bin/dotnet", group: "dotnet",
        label: ".NET SDK 8.0", hint: "apt 包约 200 MiB",
      },
      {
        name: "wkhtmltopdf", exe: "/usr/bin/wkhtmltopdf", group: "wkhtmltopdf",
        label: "wkhtmltopdf 0.12.6", hint: "apt 包约 30 MiB",
      },
      {
        name: "kxxy-py", exe: "/usr/bin/python3", group: "python-ml",
        label: "容器内 Python 3.12 + numpy/scikit-learn/cv2", hint: "pip manylinux 轮子约 120 MiB",
      },
    ],
  },
  {
    id: "torch", seeds: ["python-torch"], category: "devtools",
    name: "PyTorch",
    description:
      "python-torch 2.x（Termux 预编译，cp314 + aarch64）。CPU 推理与训练，" +
      "`import torch` 即用；需要视觉扩展时另装 torchvision（未随包，体积换边际收益不值）。",
    bins: [],
  },
  {
    id: "valgrind", seeds: ["valgrind"], category: "toolchain",
    name: "Valgrind 内存调试",
    description:
      "memcheck / callgrind / massif：定位越界、未初始化读取、泄漏与热点，" +
      "比在 gdb 里手搓断点快得多。",
    bins: ["valgrind"],
  },
  {
    id: "lisp", seeds: ["racket", "sbcl"], category: "devtools",
    name: "Racket / SBCL",
    description:
      "两个 Lisp 系运行时：Racket（教学与脚本，含 raco）与 SBCL（Common Lisp 高性能实现）。",
    bins: ["racket", "raco", "sbcl"],
  },

  // ── M 组：npm 源的工具链（不是 deb，见 tools/lib/npm-pack.mjs）────────
  //
  // 为什么单列一组：这些包在 Termux 索引里根本不存在（前端工具链只发 npm），
  // 而 `npm install` 在构建机上会按 **宿主** 平台过滤 `os:["android"]` 的可选
  // 依赖 —— 所以打包时必须显式 `--os=android --cpu=arm64`，否则设备上「命令
  // 在、二进制不在」。这正是 `assemble.mjs` 的 `declaresAndroid` 例外要放行的
  // 那类包（`@esbuild/android-arm64`、`@rollup/rollup-android-arm64`）。
  //
  // 版本写范围而不是精确值：首次构建会把实际解析结果写进
  // `tools/npm-tools.lock.json`，之后按锁文件装，产物可复现。
  // 刻意不用 `latest`：TypeScript 7（原生编译器）与 ESLint 10 刚换代，先跟
  // 稳定线（TS 5 / ESLint 9 / Vite 7），升大版本应当是独立一次改动。
  {
    id: "node-tools",
    source: "npm",
    seeds: [],
    category: "devtools",
    name: "前端与脚本工具链",
    description:
      "TypeScript / ESLint / Prettier / esbuild / Rollup / Vite / Webpack，含 Android arm64 原生构件，" +
      "离线可用（不依赖运行时 npm 安装）。",
    bins: ["tsc", "tsserver", "eslint", "prettier", "esbuild", "rollup", "vite", "webpack", "webpack-cli"],
    npmPackages: {
      typescript: "^5.9",
      eslint: "^9",
      prettier: "^3",
      esbuild: "^0.28",
      rollup: "^4",
      vite: "^7",
      // webpack 本体 + CLI（v6 起 CLI 拆成独立包，只有本体时 `webpack` 命令不存在）。
      // 纯 JS，无原生构件；`webpack --version` 与 webpack.config.js 全流程已在
      // 真机验证（v0.9.68）。
      webpack: "^5",
      "webpack-cli": "^6",
    },
    // 少任何一个都说明 npm 按宿主平台装了 —— 构建期直接失败，别等上设备。
    requiredPlatformPackages: ["@esbuild/android-arm64", "@rollup/rollup-android-arm64"],
  },
];
