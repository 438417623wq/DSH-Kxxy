cmake_minimum_required(VERSION 3.22.1)
project(dsh_pty C)

set(CMAKE_C_STANDARD 11)

# 两个源文件：dsh_pty.c 是纯 C 核心（无 JNI 依赖，可独立编译测试），
# dsh_pty_jni.c 只做 Java/Kotlin 类型转换。
add_library(dsh_pty SHARED
        dsh_pty.c
        dsh_pty_jni.c)

target_link_libraries(dsh_pty
        android
        log)

# libkxxy_exec.so —— exec 族路径重写预加载库（缺陷 CC，问题清单 P3）。
#
# 它**不链接进 dsh_pty**，而是一个独立的共享库：运行期由 Kotlin 侧从 APK
# 的 lib/ 拷到 <engineRoot>/lib/，再通过 LD_PRELOAD 注入到每个子进程。
# 之所以走预加载而不是静态编进各工具：那些工具是 Termux 编好的二进制，
# 我们改不了它们的链接行。
#
# 不写 target_link_libraries：预加载库只该依赖 libc/libdl。链 log 或 android
# 会让它在 LD_PRELOAD 阶段多拉两个 .so，在 linker 极早期更易失败。
add_library(kxxy_exec SHARED kxxy_exec.c)
