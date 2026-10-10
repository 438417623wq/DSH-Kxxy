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
