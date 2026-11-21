# -*- coding: utf-8 -*-
"""bionic 上装不了的包：导入时给一条能执行的出路。

背景：numpy/scipy/torch 这些我们能提供 bionic 轮子，但 scikit-learn、opencv
只有 glibc 的 manylinux 轮子（官方没有 Android 构建，交叉编要 cythonize 40+ 个
扩展）。原生 `python -c "import sklearn"` 只会回一句 ModuleNotFoundError，
用户不知道有 `kxxy-py` 这条现成的路。

这里只做一件事：把失败信息换成「怎么做」。真正的模块一定优先 —— 这个 finder
挂在 sys.meta_path 末尾，任何能正常导入的环境（比如以后真有 bionic 轮子）
都不会被它挡住。
"""

import sys

_HINTS = {
    "sklearn": "scikit-learn",
    "scikit_learn": "scikit-learn",
    "cv2": "opencv-python",
    "opencv": "opencv-python",
    "joblib": "joblib",
    "threadpoolctl": "threadpoolctl",
}


class _GlibcOnlyFinder:
    """对明确的 glibc-only 包给出可操作提示。"""

    def find_spec(self, name, path=None, target=None):
        root = name.split(".", 1)[0]
        pkg = _HINTS.get(root)
        if pkg is None:
            return None
        raise ImportError(
            "%s 只有 glibc 的 manylinux 轮子，bionic 的原生 Python 装不了"
            "（不是没装，是装不上）。\n"
            "  直接用：      kxxy-py -c 'import %s'\n"
            "  装更多包：    kxxy-glibc -c 'pip install %s'\n"
            "  进容器里做事：kxxy-glibc\n"
            "（kxxy-py 跑在扩展中心装的 glibc 用户态里，numpy/scipy/torch 之外"
            "还有 sklearn/cv2）" % (pkg, root, pkg)
        )


def _install():
    try:
        if not any(isinstance(f, _GlibcOnlyFinder) for f in sys.meta_path):
            sys.meta_path.append(_GlibcOnlyFinder())
    except Exception:
        pass


_install()
