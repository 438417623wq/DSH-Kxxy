# Android CPython 3.14 的固定离线依赖

本目录是已验证的构建输入，不是 Windows Python 的安装目录。两个 wheel 共约 304 KiB；不会在构建机上安装/执行 Android 后端。

- `cffi-2.0.0-cp314-cp314-android_24_arm64_v8a.whl`：从官方 PyPI 源码，用 Android NDK 28.2.13676358、发布运行时的 CPython 3.14.8/libffi 头与库构建。
- `pycparser-2.23-py3-none-any.whl`：官方 PyPI wheel，原样保存。
- `manifest.json`：来源 URL/SHA256、wheel/后端摘要、289 项编译输入、工具命令、ELF 与符号闭包检查。路径字段是本次构建证据，不用于猜测其它机器路径。

默认 `tools/build-runtime.mjs` 加载这里的构件，并核对 stage 中的 ABI/库摘要。Python 或原生库变化时拒绝混用，须重新构建并审查固定合同。

复现（当前脚本固定 0.9.41 基线 runtime SHA256）：

```text
python -I tools/build-python-deps.py --runtime .cache/runtime-0.9.41/runtime.zip --ndk <NDK目录> --out-parent .cache
```

两次独立构建字节一致。原始开源许可与作者信息在 wheel 中保留。此目录通过的是构建/静态链接检查，**没有真机执行验收**。

完整说明见 `docs/python-runtime-repair-0.9.42.md`。
