# -*- coding: utf-8 -*-
"""这条解释器里确实没有的包：导入失败时给一条能走通的路。

背景：运行时里有两套 Python。

* `python3`（默认）是 glibc 3.12 容器，PyPI 上绝大多数包直接 `pip install` 就行；
* `python3.14` 是 bionic 原生解释器，numpy / scipy / pandas / matplotlib /
  torch / scikit-learn / opencv 都由我们在真机编好了 bionic 轮子随包内置，
  但生态里仍有一批**只发 manylinux 轮子、官方不提供 Android 构建**的包
  （下面 `_BIONIC_MISSING` 里的这些）。

原生解释器碰到这些包时，`ModuleNotFoundError` 只会说「没有这个模块」，用户不
知道还有 glibc 容器这条现成的路。这里只做一件事：把失败信息换成「怎么做」。

真正的模块永远优先 —— finder 挂在 `sys.meta_path` 末尾，任何能正常导入的
环境（比如以后真有 bionic 轮子，或者用户自己 pip install 装上了）都不会被它
挡住。
"""

import sys

# 只列我们确认过「官方不发 Android 轮子、也没有随运行时内置」的包。
# sklearn / cv2 / torch / pandas 等已经内置 bionic 版，不在此列。
_BIONIC_MISSING = {
    "tensorflow": "tensorflow",
    "xgboost": "xgboost",
    "lightgbm": "lightgbm",
    "catboost": "catboost",
    "onnxruntime": "onnxruntime",
    "torchvision": "torchvision",
    "torchaudio": "torchaudio",
}


class _GlibcOnlyFinder:
    """对明确的 manylinux-only 包给出可操作提示。"""

    def find_spec(self, name, path=None, target=None):
        root = name.split(".", 1)[0]
        pkg = _BIONIC_MISSING.get(root)
        if pkg is None:
            return None
        raise ModuleNotFoundError(
            "%s 官方只发 manylinux 轮子，没有 Android/bionic 构建，"
            "原生 3.14 里装不上（不是漏装）。\n"
            "  用默认解释器：  python3 -c 'import %s'"
            "   （默认 python3 是 glibc 3.12 容器，"
            "numpy/scipy/sklearn/cv2/pandas/torch 同一个环境里全都有）\n"
            "  补齐 Python 包：kxxy-glibc-provision python-full\n"
            "  装单个包：      kxxy-glibc -c 'pip install %s'\n"
            "  进容器里做事：  kxxy-glibc\n"
            "  留在 3.14 也行：python3.14 已内置 numpy/scipy/pandas/matplotlib/"
            "torch/scikit-learn/opencv" % (pkg, root, pkg),
            name=name,
        )


def _install():
    try:
        if not any(isinstance(f, _GlibcOnlyFinder) for f in sys.meta_path):
            sys.meta_path.append(_GlibcOnlyFinder())
    except Exception:
        pass


_install()
