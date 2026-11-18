# sherpa-onnx-android（Android 原生绑定）

`sherpa-onnx-node` 的 `addon.js` 按固定顺序找原生模块（`possible_paths`），其中
`./sherpa-onnx.node` 就在包根下。构建期由 `tools/lib/patches.mjs` 的
`patchSherpaOnnx` 把本目录的三个文件注入进 `sherpa-onnx-node/`：

```
prebuilds/android-arm64/
├── sherpa-onnx.node          # N-API 绑定壳，RUNPATH=$ORIGIN
├── libsherpa-onnx-c-api.so   # 真正干活的 C API（k2-fsa 上游发布）
└── libonnxruntime.so         # ONNX Runtime 1.28.2（随上面那个包一起发）
```

⚠️ **是三个文件，不是一个。** 只放 `.node` 会在 `dlopen` 阶段报
`library "libsherpa-onnx-c-api.so" not found`，看着像少了依赖包，其实是注入不完整。

## 为什么必须自己编

`sherpa-onnx-node@1.13.x` 的 `optionalDependencies` 只有
`darwin-{arm64,x64}` / `linux-{arm64,x64}` / `win-{x64,ia32}`，**没有 android**。
`sherpa-onnx-linux-arm64` 是 **glibc** 链接，Android 的 bionic 上 `dlopen` 必失败，
不能改名充数。上游的 Android 发行物是 AAR（`libsherpa-onnx-jni.so`，走 JNI），
不是 Node addon。

好消息是**上游发了一份 Termux 预编译包**，它已经是 bionic + aarch64 的：

```
sherpa-onnx-v1.13.8-android-aarch64-termux-shared.tar.bz2
  lib/libsherpa-onnx-c-api.so
  lib/libonnxruntime.so
  include/sherpa-onnx/c-api/*.h
```

所以只有那层薄薄的 N-API 壳需要自己编 —— 二十来个 `.cc`、一个 clang 命令。

## 复现步骤（v1.13.8，NDK r28，实测）

1. **取 C++ 核心**（bionic 版，不用自己编 sherpa/onnxruntime）：
   ```sh
   mkdir -p .cache/sherpa && cd .cache/sherpa
   curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/\
sherpa-onnx-v1.13.8-android-aarch64-termux-shared.tar.bz2
   tar -xjf sherpa-onnx-v1.13.8-android-aarch64-termux-shared.tar.bz2 -C dist
   ```

2. **取绑定源码**：`node tools/fetch-sherpa-addon.mjs`（默认 v1.13.8）。
   不要 `git clone` 兼取：仓库里 `scripts/node-addon-api/src/*.cc` **全是软链**，
   指向 `harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp/`，真正被编的是那一份；
   脚本按 contents API 只抓那一个目录。

3. **取 node 头文件与 node-addon-api**：
   ```sh
   curl -LO https://nodejs.org/dist/v24.22.1/node-v24.22.1-headers.tar.gz
   curl -LO https://registry.npmjs.org/node-addon-api/-/node-addon-api-<ver>.tgz
   ```

4. **编**（源列表抄上游 `CMakeLists.txt` 里 `NODE_ADDON_SRC`，别用 `src/*.cc`：
   目录里含 `wave-reader/wave-writer` 这类**不在内核列表里**的文件，会拉进额外依赖）：
   ```sh
   NDK=$ANDROID_HOME/ndk/28.2.13676358
   CXX=$NDK/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang++
   D=$PWD/dist/sherpa-onnx-v1.13.8-android-aarch64-termux-shared
   $CXX -std=c++17 -O2 -fPIC -shared \
     -Wno-deprecated-declarations -Wno-unused-parameter \
     -I./src -I"$D/include" -I./node-v24.22.1/include/node -I./inc/package \
     src/{audio-tagging,keyword-spotting,non-streaming-asr,non-streaming-speaker-diarization,
          non-streaming-speech-denoiser,non-streaming-tts,offline-punctuation,online-punctuation,
          streaming-speech-denoiser,sherpa-onnx-node-addon-api,speaker-identification,
          spoken-language-identification,streaming-asr,vad,version,resampler}.cc \
     -L"$D/lib" -lsherpa-onnx-c-api -lonnxruntime \
     -Wl,-rpath,'$ORIGIN' -static-libstdc++ -o out/sherpa-onnx.node
   ```
   `-static-libstdc++` 让壳自己不带 `libc++_shared`（壳只有 napi 调用，不需要）；
   `-Wl,-rpath,'$ORIGIN'` 钉成同目录查找，三个文件就可以放在任何地方。

5. **校验 ABI**（不能省，错了只在设备上炸）：
   ```sh
   $NDK/.../llvm-readelf -d out/sherpa-onnx.node | grep -E 'NEEDED|RUNPATH'
   ```
   期望：`RUNPATH=[$ORIGIN]`，`NEEDED` 只有 `libsherpa-onnx-c-api.so`、
   `libonnxruntime.so`、`libm.so`、`libdl.so`、`libc.so`。

6. 三个文件拷进 `prebuilds/android-arm64/`，重跑 `build-runtime.mjs` 与 `build-apk.ps1`。

## 一个容易漏的间接依赖

`libsherpa-onnx-c-api.so`（上游编的）**NEEDED `libc++_shared.so`**，而它自己的
RUNPATH 是 `/data/data/com.termux/...` + `$ORIGIN` —— Termux 那条在 App 里不存在。
能解析成功是因为引擎根下已经有 `lib/libc++_shared.so`（node 自己要），
且 node 进程带着 `LD_LIBRARY_PATH=<engine>/lib`。**换运行时布局时要复查这一条**。

## 验收集（Redmi K60 Pro / Android 13，0.9.66 运行时，旁路注入）

```sh
# 1. 能不能 dlopen（会打印三个版本号）
onnxruntime = 1.28.2
sherpa      = 1.13.8 11afbd00

# 2. 真跑一次推理（silero_vad.onnx，2 秒静音波形）
createVoiceActivityDetector ok, 18 ms
accepted 32000 samples; isDetected = false
VAD 推理跑通（两秒波形已过 ONNX Runtime）
```

模型不随包发（几百 KB 到几百 MB 不等，按需下载）。
