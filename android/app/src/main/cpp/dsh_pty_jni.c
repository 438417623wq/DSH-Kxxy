/*
 * dsh_pty_jni.c — dsh_pty 的 JNI 包装层
 *
 * 与 dsh_pty.c 分离的原因：dsh_pty.c 保持纯 C（无 JNI 依赖），便于在
 * 宿主上单独编译与测试；本文件只做 Java/Kotlin 类型 ↔ C 类型的转换。
 *
 * 所有 native 方法都是 static，绑定到 app.kxxy.pty.PtyBridge。
 */

#include <jni.h>
#include <android/log.h>

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#define LOG_TAG "DshPtyJni"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

/* 来自 dsh_pty.c */
extern int dsh_forkpty(const char *executable,
                       char *const argv[],
                       char *const envp[],
                       const char *cwd,
                       int rows,
                       int cols,
                       int *out_pid);
extern int dsh_resize(int master, int rows, int cols);
extern int dsh_write(int master, const char *data, int length);
extern void dsh_close(int master);
extern int dsh_waitpid(int pid);
extern int dsh_kill(int pid, int sig);
extern int dsh_alive(int pid);

/* ── jobjectArray → NULL 结尾的 char* 数组 ───────────────────────────────
 *
 * 返回的指针数组与其中每个字符串都由调用方负责 free。
 * 任一环节失败时清理已分配部分并返回 NULL。
 */
static char **to_c_array(JNIEnv *env, jobjectArray arr, int *out_count)
{
    if (arr == NULL) {
        *out_count = 0;
        return NULL;
    }

    jsize n = (*env)->GetArrayLength(env, arr);
    /* 多留一格放 NULL 结尾 */
    char **out = (char **)calloc((size_t)n + 1, sizeof(char *));
    if (out == NULL) {
        *out_count = 0;
        return NULL;
    }

    for (jsize i = 0; i < n; i++) {
        jstring js = (jstring)(*env)->GetObjectArrayElement(env, arr, i);
        if (js == NULL) continue;

        const char *utf = (*env)->GetStringUTFChars(env, js, NULL);
        if (utf == NULL) {
            (*env)->DeleteLocalRef(env, js);
            /* 清理并放弃 */
            for (jsize k = 0; k < i; k++) free(out[k]);
            free(out);
            *out_count = 0;
            return NULL;
        }
        out[i] = strdup(utf);
        (*env)->ReleaseStringUTFChars(env, js, utf);
        (*env)->DeleteLocalRef(env, js);
    }

    out[n] = NULL;
    *out_count = n;
    return out;
}

static void free_c_array(char **arr, int count)
{
    if (arr == NULL) return;
    for (int i = 0; i < count; i++) free(arr[i]);
    free(arr);
}

/*
 * 启动 PTY 子进程。
 *
 * 返回一个长度 2 的 int 数组：
 *   [0] = master fd（>= 0 成功；< 0 为 -errno）
 *   [1] = 子进程 pid（失败时为 0）
 */
JNIEXPORT jintArray JNICALL
Java_app_kxxy_pty_PtyBridge_nativeForkPty(
        JNIEnv *env, jclass clazz,
        jstring executable, jobjectArray argv, jobjectArray envp,
        jstring cwd, jint rows, jint cols)
{
    jintArray result = (*env)->NewIntArray(env, 2);
    if (result == NULL) return NULL;

    jint values[2] = { -EINVAL, 0 };

    if (executable == NULL) {
        (*env)->SetIntArrayRegion(env, result, 0, 2, values);
        return result;
    }

    const char *exe = (*env)->GetStringUTFChars(env, executable, NULL);
    const char *cwdStr = NULL;
    if (cwd != NULL) cwdStr = (*env)->GetStringUTFChars(env, cwd, NULL);

    int argc = 0, envc = 0;
    char **cargv = to_c_array(env, argv, &argc);
    char **cenvp = to_c_array(env, envp, &envc);

    /* argv[0] 必须是可执行文件自身（execve 约定） */
    if (cargv == NULL || argc == 0) {
        free_c_array(cargv, argc);
        free_c_array(cenvp, envc);
        if (cwdStr) (*env)->ReleaseStringUTFChars(env, cwd, cwdStr);
        (*env)->ReleaseStringUTFChars(env, executable, exe);
        (*env)->SetIntArrayRegion(env, result, 0, 2, values);
        return result;
    }

    int pid = 0;
    int master = dsh_forkpty(exe, cargv, cenvp, cwdStr, rows, cols, &pid);

    values[0] = master;
    values[1] = (master >= 0) ? pid : 0;

    (*env)->SetIntArrayRegion(env, result, 0, 2, values);

    free_c_array(cargv, argc);
    free_c_array(cenvp, envc);
    if (cwdStr) (*env)->ReleaseStringUTFChars(env, cwd, cwdStr);
    (*env)->ReleaseStringUTFChars(env, executable, exe);

    return result;
}

JNIEXPORT jint JNICALL
Java_app_kxxy_pty_PtyBridge_nativeResize(JNIEnv *env, jclass clazz, jint master, jint rows, jint cols)
{
    (void)env; (void)clazz;
    return dsh_resize(master, rows, cols);
}

JNIEXPORT jint JNICALL
Java_app_kxxy_pty_PtyBridge_nativeWrite(JNIEnv *env, jclass clazz, jint master, jbyteArray data)
{
    (void)clazz;
    if (data == NULL) return -EINVAL;

    jsize len = (*env)->GetArrayLength(env, data);
    if (len == 0) return 0;

    jbyte *buf = (*env)->GetByteArrayElements(env, data, NULL);
    if (buf == NULL) return -ENOMEM;

    int n = dsh_write(master, (const char *)buf, (int)len);

    (*env)->ReleaseByteArrayElements(env, data, buf, JNI_ABORT);
    return n;
}

JNIEXPORT void JNICALL
Java_app_kxxy_pty_PtyBridge_nativeClose(JNIEnv *env, jclass clazz, jint master)
{
    (void)env; (void)clazz;
    dsh_close(master);
}

/* 返回原始 wait status（不是 exit code） */
JNIEXPORT jint JNICALL
Java_app_kxxy_pty_PtyBridge_nativeWaitPid(JNIEnv *env, jclass clazz, jint pid)
{
    (void)env; (void)clazz;
    return dsh_waitpid(pid);
}

JNIEXPORT jint JNICALL
Java_app_kxxy_pty_PtyBridge_nativeKill(JNIEnv *env, jclass clazz, jint pid, jint sig)
{
    (void)env; (void)clazz;
    return dsh_kill(pid, sig);
}

JNIEXPORT jint JNICALL
Java_app_kxxy_pty_PtyBridge_nativeAlive(JNIEnv *env, jclass clazz, jint pid)
{
    (void)env; (void)clazz;
    return dsh_alive(pid);
}
