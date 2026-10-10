# DSH Kxxy — ProGuard 规则
# 方案 T 下原生层很薄，主要保护反射与 JNI 入口。

# JNI：PtyBridge 的 native 方法与 dsh_pty_jni.c 的导出符号按名字绑定，
# 混淆后会找不到符号 → UnsatisfiedLinkError。
-keepclasseswithmembernames class app.kxxy.pty.PtyBridge {
    native <methods>;
}
-keep class app.kxxy.pty.PtyBridge { *; }

# 反射：EngineProcess.pumpLoop 用反射读 FileDescriptor.descriptor
-keepclassmembers class java.io.FileDescriptor {
    private int descriptor;
}

# Kotlin 协程
-keepclassmembers class kotlinx.coroutines.** { volatile <fields>; }
-dontwarn kotlinx.coroutines.**

# 保留行号，便于崩溃日志定位（引擎日志里会记录堆栈）
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
