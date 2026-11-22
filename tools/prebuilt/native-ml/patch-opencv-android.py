"""Patch the opencv-python-headless sdist so the python3 bindings can be built on Android.

Two independent edits:

1. `modules/python/CMakeLists.txt` hard-disables the `python3` module when `ANDROID`
   is true:

       if(ANDROID OR APPLE_FRAMEWORK OR WINRT)
         ocv_module_disable_(python3)
         return()
       endif()

   That guard is meant for the regular Android SDK flow (Java bindings only).  When
   building natively *on* Android with a real CPython toolchain the binding is
   buildable, so we drop the `ANDROID` term and keep the other two.

2. `cmake/package/install_package.cmake` treats the PEP 561 marker `py.typed` as a
   hard requirement.  The marker is emitted by the typing-stubs generator, which
   produces nothing in this build (the `cv2/typing` directory comes out empty), so
   `cmake --build --target install` aborts *after* `cv2.cpython-314-...so` has
   already been built and installed.  Stubs are type-checker hints only — make the
   glob optional instead of failing the wheel.

   The same applies to the `mat_wrapper` / `misc` / `utils` / `typing` loader
   sub-packages: `cv2/typing` is produced by that same generator, so it comes out
   empty and its `*.py` glob has to be optional too.
"""

import argparse
import hashlib
import io
import os
import tarfile

PATCHES = {
    "modules/python/CMakeLists.txt": [
        (
            b"if(ANDROID OR APPLE_FRAMEWORK OR WINRT)\n"
            b"  ocv_module_disable_(python3)\n"
            b"  return()\n",
            b"# kxxy: python3 bindings are buildable for a native Android CPython toolchain\n"
            b"if(APPLE_FRAMEWORK OR WINRT)\n"
            b"  ocv_module_disable_(python3)\n"
            b"  return()\n",
        )
    ],
    "cmake/package/install_package.cmake": [
        (
            b'opencv_python_install("" GLOB "${_loader}/py.typed")',
            b'opencv_python_install("" OPTIONAL GLOB "${_loader}/py.typed")',
        ),
        (
            b'  opencv_python_install(${_subpackage} RECURSE GLOB "${_loader}/${_subpackage}/*.py")',
            b'  opencv_python_install(${_subpackage} OPTIONAL RECURSE GLOB "${_loader}/${_subpackage}/*.py")',
        ),
    ],
}


def rewrite(src, dst):
    applied = {}
    with tarfile.open(src, "r:gz") as tin, tarfile.open(dst, "w:gz") as tout:
        for member in tin:
            data = None
            if member.isfile():
                for target, edits in PATCHES.items():
                    if member.name.endswith("/" + target):
                        data = tin.extractfile(member).read()
                        for old, new in edits:
                            if old not in data:
                                raise SystemExit(f"anchor not found in {member.name}: {old!r}")
                            data = data.replace(old, new, 1)
                        applied[target] = applied.get(target, 0) + 1
            if data is None:
                tout.addfile(member, tin.extractfile(member) if member.isfile() else None)
            else:
                member.size = len(data)
                member.mtime = 0
                tout.addfile(member, io.BytesIO(data))
    missing = sorted(set(PATCHES) - set(applied))
    if missing:
        raise SystemExit(f"expected files not found: {missing}")
    if any(count != 1 for count in applied.values()):
        raise SystemExit(f"expected one copy of each file, got {applied}")
    return applied


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("target")
    args = ap.parse_args()
    if os.path.abspath(args.source) == os.path.abspath(args.target):
        raise SystemExit("source and target must differ")
    applied = rewrite(args.source, args.target)
    for name, count in sorted(applied.items()):
        print(f"patched: {name} x{count}")
    print("sha256 :", sha256(args.target))
    print("bytes  :", os.path.getsize(args.target))


if __name__ == "__main__":
    main()
