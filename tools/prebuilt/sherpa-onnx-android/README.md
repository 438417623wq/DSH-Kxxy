# sherpa-onnx-android（Android 原生绑定接入位）

`sherpa-onnx-node` 的 JS 入口按固定顺序找原生模块（`addon.js` 的
`possible_paths`），其中 `./sherpa-onnx.node` 就在包根下。所以**只要把一份
Android arm64 的 `sherpa-onnx.node` 放进这个目录**，构建期就会自动注入，
`tools/lib/patches.mjs` 的 `patchSherpaOnnx` 不需要改。

```
prebuilds/
└── android-arm64/
    └── sherpa-onnx.node      # 缺失时构建仍成功，但设备上语音能力给可读错误
```

## 当前状态

目录里**没有** `.node`。原因不是懒得补，而是上游没有可用的构件：

- `sherpa-onnx-node@1.13.x` 的 `optionalDependencies` 只有
  `darwin-{arm64,x64}` / `linux-{arm64,x64}` / `win-{x64,ia32}`，**没有 android**；
- `sherpa-onnx-linux-arm64` 是 **glibc** 链接，Android 的 bionic 上 `dlopen` 必失败，
  不能拿来改名充数；
- 上游的 Android 发行物是 AAR（`libsherpa-onnx-jni.so`，走 JNI），不是 Node addon。

所以没有构件时，`patchSherpaOnnx` 会在 `addon.js` 顶部注入一段守卫，抛出
`code === 'KXXY_SHERPA_UNAVAILABLE'` 的错误，明确说「本构建没有 Android 绑定」，
而不是让调用方看到上游那句 `Could not find sherpa-onnx-node. Tried …` 去猜。

## 怎么补（交叉编译）

前置：NDK（与 App 的 `minSdk 26` 对齐，r26+）、CMake、一份 sherpa-onnx 源码。

1. 编 C++ 核心（静态库 + C API），目标 `android-arm64-v8a`：
   ```sh
   cmake -B build-android \
     -DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake \
     -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-26 \
     -DSHERPA_ONNX_ENABLE_TTS=ON -DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=ON \
     -DBUILD_SHARED_LIBS=OFF -DSHERPA_ONNX_ENABLE_PYTHON=OFF
   cmake --build build-android -j
   ```
2. 编 Node addon（上游 `nodejs-addon/` 目录，用 `node-addon-api`，仓库里已随包）：
   把上一步的静态库与 `onnxruntime` 的 Android 预编译包链进去。
   注意 **STL 必须与 Node 运行时一致**：本项目 node 用 `c++_static`。
3. 校验（这一步不能省，ABI 不对的 `.node` 只在设备上才炸）：
   ```sh
   $NDK/toolchains/llvm/prebuilt/*/bin/llvm-readelf -d sherpa-onnx.node | grep NEEDED
   ```
   期望只依赖 `libc.so` / `libm.so` / `libdl.so` / `liblog.so`，不应出现
   `libc++_shared.so` 或任何 glibc 名字。
4. 放进 `prebuilds/android-arm64/sherpa-onnx.node`，重跑
   `node tools/build-runtime.mjs …` 与 `build-apk.ps1`。

## 验收集

真机（Redmi K60 Pro / Android 13）：

```sh
$ENGINE/bin/node -e "require('$ENGINE/lib/node_modules/sherpa-onnx-node')"   # 不抛错
```

再用最小模型跑一段 3 秒 wav（`non-streaming-asr.js`），确认能出文本；
说话人分离用 `non-streaming-speaker-diarization.js` 复核一次。

## 体积预期

`libonnxruntime.so` + sherpa 核心约 40–80 MiB（取决于是不是把 TTS 一起带上）。
如果只需要 ASR，关掉 TTS 与 diarization 能省一半以上。
