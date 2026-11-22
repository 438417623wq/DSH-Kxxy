#!/system/bin/sh
#
# 在真机上（app.kxxy 的 bionic CPython 3.14 + Termux 同源的 clang/NDK）把
# opencv-python-headless 编成 cp314-cp314-android_24_arm64_v8a 轮子。
#
# 前置：先把 sdist 换成打过补丁的那份（tools/prebuilt/native-ml/
#       patch-opencv-android.py），放到 $T/.tmp/opencv_python_headless-5.1.0.95.tar.gz。
# 用法：run-as app.kxxy sh -c 'env LD_LIBRARY_PATH=$A/lib PATH=$A/bin:/system/bin \
#           sh /data/data/app.kxxy/files/.tmp/build-opencv.sh'
# 产出：轮子落在 $A/lib/python3.14/site-packages 的同级 pip 缓存里，
#       把它取出来放进 tools/prebuilt/native-ml/ 并登记到 pydeps.mjs 的 NATIVE_ML。
#
# 三个不能省的开关：CMAKE_SYSROOT（否则 sysroot 被解析成 /）、
# PYTHON3_INCLUDE_PATH/PYTHON3_NUMPY_INCLUDE_DIRS（Android 分支跳过
# find_package(PythonLibs)）、OPENCV_FORCE_PYTHON_LIBS（否则 cv2.so 不链
# libpython，dlopen 时找不到 _Py_NoneStruct）。
#
set -x
A=/data/user/0/app.kxxy/files/engine
T=/data/user/0/app.kxxy/files
export TMPDIR=$T/.tmp
export CC=clang
export CXX=clang++
export C_INCLUDE_PATH=$A/include
export CPLUS_INCLUDE_PATH=$A/include/c++/v1:$A/include
export LIBRARY_PATH=$A/lib
export LDFLAGS=-L$A/lib
export LD_LIBRARY_PATH=$A/lib
export PATH=$A/bin:/system/bin
SP=$A/lib/python3.14/site-packages
export CMAKE_ARGS="-G Ninja \
 -DCMAKE_SYSROOT=$A -DCMAKE_SYSTEM_VERSION=24 \
 -DPYTHON3_INCLUDE_PATH=$A/include/python3.14 \
 -DPYTHON3_INCLUDE_DIR=$A/include/python3.14 \
 -DPYTHON3_LIBRARIES=$A/lib/libpython3.14.so \
 -DPYTHON3_NUMPY_INCLUDE_DIRS=$SP/numpy/_core/include \
 -DPYTHON3_NUMPY_VERSION=2.5.5 \
 -DPYTHON3_PACKAGES_PATH=$SP \
 -DPYTHON3_LIMITED_API=OFF -DOPENCV_FORCE_PYTHON_LIBS=ON \
 -DBUILD_LIST=core,imgproc,imgcodecs,python3 \
 -DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF -DWITH_QT=OFF -DWITH_GTK=OFF \
 -DWITH_OPENCL=OFF -DWITH_IPP=OFF -DWITH_ITT=OFF -DWITH_ADE=OFF \
 -DWITH_PROTOBUF=OFF -DWITH_OPENEXR=OFF -DWITH_TIFF=OFF -DWITH_WEBP=OFF \
 -DWITH_OPENJPEG=OFF -DWITH_JASPER=OFF -DBUILD_JAVA=OFF -DBUILD_opencv_apps=OFF \
 -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF \
 -DBUILD_ANDROID_EXAMPLES=OFF -DBUILD_ANDROID_PROJECTS=OFF -DWITH_KLEIDICV=OFF"
exec "$A/bin/python3.14" -m pip install --no-cache-dir --no-clean --disable-pip-version-check \
  --no-build-isolation --no-binary opencv-python-headless \
  "$T/.tmp/opencv_python_headless-5.1.0.95.tar.gz"
