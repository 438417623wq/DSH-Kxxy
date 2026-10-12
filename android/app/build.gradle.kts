// DSH Kxxy — app 模块构建脚本
// 方案 T：Web-First 宿主
//
// ⚠️ 关键决策：targetSdk = 28
// Android 10+ (API 29+) 禁止对 app home 目录内的文件调用 execve()（W^X 违规）：
//   "Untrusted apps that target Android 10 cannot invoke execve() directly on
//    files within the app's home directory."
// 本应用走 sideload 分发（不上架 Play），因此把 targetSdk 固定为 28，
// 从而豁免该限制，允许从 filesDir 直接 execve bionic 二进制（Termux 同款策略）。
// minSdk 26 覆盖参考项目取值；compileSdk 36 仅决定编译期 API 可见性。
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.kxxy"
    compileSdk = 36
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "app.kxxy"
        minSdk = 26
        // 见文件头说明：28 是豁免 W^X 的阈值，不可提高
        targetSdk = 28
        versionCode = 1
        versionName = "0.1.0"

        ndk {
            abiFilters += listOf("arm64-v8a")
        }
        externalNativeBuild {
            cmake {
                cppFlags += "-std=c11"
                arguments += "-DANDROID_STL=none"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    // AGP 8 起 BuildConfig 默认不再生成，必须显式打开。
    // KxxyApp 用它打印版本号，缺了会报 "Unresolved reference: BuildConfig"。
    buildFeatures {
        buildConfig = true
    }

    androidResources {
        // assets/runtime.zip 已经是 98 MiB 的 deflate 产物（内部 14800 条，
        // 未压缩 259 MiB）。让 aapt2 再压一遍纯属浪费 —— 既压不动（zip 头
        // 与已压缩的二进制进去就是原样），又要多花几分钟和一大块临时空间。
        //
        // 更关键的是 RuntimeInstaller 会用 `ZipFile` 读**中央目录**取 LINK 注释，
        // 走 asset 流式读取拿不到 comment；它已经先拷贝到 cacheDir 再用 ZipFile，
        // 所以这里的 noCompress 只影响 APK 体积与构建耗时，不影响正确性。
        noCompress += "zip"
        // 扩展包池 assets/ext-pool/*.pool（内容是 gzip 的 tar）同理已是压缩态，
        // 再压一遍纯浪费；且不压缩时 AssetManager.openFd() 才能取到真实 length ——
        // RuntimeInstaller.ensureExtensionPool 靠它做「大小一致即跳过」的幂等判断。
        // ⚠️ 后缀必须是 .pool 而非 .tar.gz：aapt2 在资产合并阶段会解包 .gz 并剥掉
        // 后缀（实测 APK 条目变成 703MB 的明文 .tar），既撑大 APK 又破坏按名查池。
        noCompress += "pool"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        jniLibs {
            // 参考项目 UserLAnd 的第一手踩坑记录（原文）：
            //   "Confirmed live: with useLegacyPackaging=false, this device's
            //    PackageManager extracted *nothing* to legacyNativeLibraryDir at
            //    all ... Since busybox/proot/pulseaudio/etc. are 'fake .so'
            //    executables that only work by actually landing on disk (not by
            //    being mmap'd as real shared libraries), useLegacyPackaging=false
            //    breaks every session outright."
            // 方案 T 不用伪装 .so（targetSdk=28 已可 execve），但保持 legacy
            // 打包以便 libdsh_pty.so 落盘到 nativeLibraryDir，便于诊断。
            useLegacyPackaging = true
        }
    }

    lint {
        // targetSdk 28 会触发大量 lint 提示（前台服务类型、通知权限等），
        // 这些是刻意的兼容性决策，不阻断构建。
        abortOnError = false
    }
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // .deb 的 data.tar.xz 解码（纯 Java 实现，约 110 KB）—— 扩展中心解包链路
    implementation("org.tukaani:xz:1.10")
}
