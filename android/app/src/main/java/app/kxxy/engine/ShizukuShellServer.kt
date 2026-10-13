package app.kxxy.engine

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

/**
 * Shizuku 执行通道的**应用侧服务端**。
 *
 * ## 为什么需要它
 *
 * 引擎是 `execve` 起的独立进程，Shizuku 的 binder 通道只存在于应用进程里。
 * 引擎内的 AI 要跑一条 adb 身份的命令，必须有一个跨进程通道把请求送回应用进程，
 * 由应用调用 `IShizukuService.newProcess` 执行，再把结果送回去。
 *
 * ## 通道选型：文件请求/响应，而不是 socket
 *
 * 三种候选与取舍：
 *
 * 1. **TCP 127.0.0.1:3082**（harness 原型里 mock 过 `[shz] shizuku bridge 3082 idle`）
 *    —— 否决：Android 上任何应用都能连 127.0.0.1，等于把 shell 开放给全设备。
 *    加 token 能挡，但 token 文件与应用私有目录同权限，安全性并没有变好，
 *    却多了一个常驻监听端口。
 * 2. **Unix domain socket** —— 安全（socket 文件在应用私有目录，靠文件权限隔离），
 *    但 `LocalServerSocket` 的公开构造器只支持抽象命名空间（**没有**文件权限保护），
 *    绑定文件系统路径需要包私有构造器。为一个可选能力不值得冒反射风险。
 * 3. **应用私有目录内的文件请求/响应** —— 选定。安全性与 Unix socket 等价
 *    （`/data/data/app.kxxy/` 是 0700 + SELinux 标签，其他应用读不到），
 *    零新增网络面，且与本工程既有的 `restart.request` / `stdin.request`
 *    引擎→应用通道是同一种模式（一致的心智模型比多一种机制更值钱）。
 *
 * 代价是轮询延迟（[POLL_MS]）。对「AI 偶尔跑一条特权命令」的场景，
 * 150ms 的额外延迟无关紧要；真正密集的调用应该走 root 模式。
 *
 * ## 协议
 *
 * ```
 * shz/request   引擎写入：命令原文（无换行约定，整体即命令）
 * shz/response  应用写入：第一行 = 退出码，其余 = stdout+stderr 合并
 * shz/capable   应用写入：通道可用标记，内容为一行说明
 * shz/why       应用写入：通道不可用的原因（供 shz 打印）
 * shz/lock      引擎侧用 mkdir 原子加锁，保证串行
 * ```
 *
 * 客户端脚本见 [GATE_SCRIPT]，由应用在引擎启动时写入 `bin/shz`。
 */
object ShizukuShellServer {

    private const val TAG = "KxxyShzServer"

    /** 请求轮询间隔。150ms 是在「响应够快」与「空转开销可忽略」之间的折中。 */
    private const val POLL_MS = 150L

    /** 通道不可用时的重检间隔。状态可能因 Shizuku 服务启停而变，不需要高频。 */
    private const val IDLE_POLL_MS = 500L

    /**
     * 状态重探的最小间隔。
     *
     * [ShizukuBridge.refresh] 内部是 4 次 binder 调用（ping / checkSelfPermission /
     * getVersion / getUid）。轮询循环最密时每 150ms 转一圈，不加节流就是每秒
     * 二十几次跨进程调用，纯属浪费 —— 而通道状态的变化（授权、服务启停）
     * 本来就是秒级事件，1 秒的陈旧度完全够用。
     */
    private const val REFRESH_MS = 1_000L

    /** 单条命令最长执行时间，超过即中止（与 [ShizukuBridge.execShell] 的超时一致）。 */
    private const val EXEC_TIMEOUT_MS = 120_000L

    /** 单条命令的输出上限，防止失控命令把应用内存吃光。 */
    private const val MAX_OUTPUT_BYTES = 4 shl 20

    @Volatile
    private var started = false

    /** 通道目录：`<engineRoot>/shz`。 */
    private fun dir(ctx: Context): File = File(EngineConfig.engineRoot(ctx), "shz")

    /**
     * 启动服务循环。**幂等**，重复调用无副作用。
     *
     * 由 [app.kxxy.KxxyApp.onCreate] 调用 —— 必须在应用进程里跑，因为只有
     * 应用进程持有 Shizuku binder。
     */
    fun start(ctx: Context, scope: CoroutineScope) {
        if (started) return
        started = true
        scope.launch(Dispatchers.IO) { loop(ctx) }
        Log.i(TAG, "shell server started, dir=${dir(ctx).absolutePath}")
    }

    private suspend fun CoroutineScope.loop(ctx: Context) {
        val d = dir(ctx)
        // 清理上一进程残留的请求：它对应的调用方早就超时退出了，
        // 若不清掉会在本轮被当成新请求执行一次（幽灵执行）。
        runCatching {
            d.mkdirs()
            File(d, "request").delete()
            File(d, "response").delete()
            File(d, "lock").delete()
        }

        var lastRefresh = 0L

        while (isActive) {
            try {
                // 先刷新状态再做任何判断：这个循环同时承担「让 ShizukuBridge 的
                // 状态保持新鲜」的职责，而控制台的权限卡片、privAvailability()
                // 都读它。若把它放在模式判断之后，normal/root 模式下状态会一直是
                // 应用启动那一刻的快照（只有 binder 事件才更新），
                // 用户看到的就是「明明已经授权了却还显示未授权」。
                //
                // 但要有节流：最密时每 150ms 转一圈，无节流就是每秒二十几次
                // 跨进程调用。授权与启停都是秒级事件，1 秒陈旧度完全够用。
                val now = System.currentTimeMillis()
                if (now - lastRefresh >= REFRESH_MS) {
                    lastRefresh = now
                    ShizukuBridge.refresh()
                }
                val s = ShizukuBridge.status.value

                // 通道只在「权限模式 = shizuku」时开放。
                //
                // 这不是多余的开关：normal 模式对用户的承诺是「不申请任何提权」，
                // 如果此时 shz 仍能执行 adb 身份命令，那条承诺就是假的。
                // 用户切到 shizuku 模式后才开放，切走后立刻关闭（capable 被删）。
                val mode = EngineConfig.readPrivMode(ctx)
                if (mode != "shizuku") {
                    markUnavailable(d, "当前权限模式为「$mode」，切换到「Shizuku ADB」并重启引擎后可用")
                    delay(IDLE_POLL_MS)
                    continue
                }

                if (!s.usable) {
                    markUnavailable(d, reasonOf(s))
                    delay(IDLE_POLL_MS)
                    continue
                }
                markAvailable(d, s)

                val req = File(d, "request")
                if (!req.isFile) {
                    delay(POLL_MS)
                    continue
                }
                handleRequest(d, req)
            } catch (e: Throwable) {
                // 循环绝不能因单次异常退出：一旦退出，引擎侧 shz 会永久超时，
                // 而用户看到的现象是「Shizuku 模式没反应」，极难定位。
                Log.w(TAG, "loop iteration failed: ${e.javaClass.simpleName}: ${e.message}")
                delay(IDLE_POLL_MS)
            }
        }
    }

    private fun markAvailable(d: File, s: ShizukuBridge.Status) {
        val cap = File(d, "capable")
        val text = "Shizuku 通道就绪（server uid=${s.serverUid}，api=${s.version}）\n"
        if (!cap.isFile || cap.readText() != text) cap.writeText(text)
        File(d, "why").delete()
    }

    private fun markUnavailable(d: File, reason: String) {
        File(d, "capable").delete()
        val f = File(d, "why")
        val text = reason + "\n"
        if (!f.isFile || f.readText() != text) f.writeText(text)
    }

    private fun reasonOf(s: ShizukuBridge.Status): String = when {
        !s.installed -> "未检测到 Shizuku 管理器"
        !s.binderReady -> "Shizuku 服务未运行（需通过 ADB 或 root 启动 Shizuku）"
        !s.granted -> "尚未授予 Shizuku 权限（在控制台点「请求授权」）"
        else -> s.lastError ?: "Shizuku 通道不可用"
    }

    private suspend fun handleRequest(d: File, req: File) {
        val command = try {
            req.readText()
        } catch (e: Throwable) {
            Log.w(TAG, "read request failed: ${e.message}")
            req.delete()
            return
        }
        // 先删请求再执行：这样客户端等待的是「本次」的响应，
        // 不会因为上一轮的 response 还在而读到过期结果。
        req.delete()

        Log.i(TAG, "exec: ${command.take(200)}")
        val t0 = System.currentTimeMillis()
        val result = ShizukuBridge.execShell(command, EXEC_TIMEOUT_MS)
        val cost = System.currentTimeMillis() - t0

        val payload = if (result == null) {
            Log.w(TAG, "exec returned null (channel lost), cost=${cost}ms")
            "70\nshz: Shizuku 通道在执行期间失效（binder 断开或授权被撤销）\n"
        } else {
            Log.i(TAG, "exec done: exit=${result.exitCode} cost=${cost}ms")
            buildString {
                append(result.exitCode).append('\n')
                append(result.stdout)
                append(result.stderr)
            }.takeBytes(MAX_OUTPUT_BYTES)
        }
        writeAtomically(File(d, "response"), payload)
    }

    /**
     * 原子写：先写 `.tmp` 再 rename。
     *
     * 客户端是「看到 response 存在就读」，非原子写会让它读到半截内容 ——
     * 这是文件通道最容易踩的坑。
     */
    private fun writeAtomically(target: File, content: String) {
        val tmp = File(target.parentFile, target.name + ".tmp")
        tmp.writeText(content)
        if (!tmp.renameTo(target)) {
            // rename 失败（罕见，通常是目标被占用）时退化为直接写。
            // 直接写有读到半截的风险，但比丢失整个响应好。
            target.writeText(content)
            tmp.delete()
        }
    }

    private fun String.takeBytes(max: Int): String {
        val bytes = toByteArray(Charsets.UTF_8)
        if (bytes.size <= max) return this
        return "（输出超过 ${max / (1 shl 20)} MiB，已截断）\n" +
            String(bytes, 0, max, Charsets.UTF_8)
    }

    // ── 引擎侧闸门脚本 ──────────────────────────────────────────────────

    /**
     * 写入 `<engineRoot>/bin/shz`。
     *
     * **每次引擎启动都要重写**：`RuntimeInstaller` 重装 runtime 时会把
     * `bin/` 整棵覆盖掉，写在里面的闸门脚本会消失。放在引擎启动路径上重写，
     * 比在安装器里登记一个「额外产物」更不容易漏。
     */
    fun installGateScript(ctx: Context): Boolean {
        val root = EngineConfig.engineRoot(ctx)
        val bin = File(root, "bin")
        if (!bin.isDirectory) {
            Log.w(TAG, "installGateScript skipped: ${bin.absolutePath} is not a directory")
            return false
        }
        val script = File(bin, "shz")
        val text = GATE_SCRIPT.replace("@BASH@", File(bin, "bash").absolutePath)
        return try {
            if (!script.isFile || script.readText() != text) {
                script.writeText(text)
            }
            script.setExecutable(true, false)
            true
        } catch (e: Throwable) {
            Log.w(TAG, "installGateScript failed: ${e.message}")
            false
        }
    }

    /**
     * 闸门脚本正文。`@BASH@` 由 [installGateScript] 替换为引擎自带 bash 的绝对路径。
     *
     * 用引擎自带 bash 而不是 `/system/bin/sh`：脚本里用到了 `sleep 0.1`（小数秒）
     * 与 `trap ... EXIT`，engine 自带的是 GNU bash 5.3，行为确定；Android 的
     * toybox sh 对小数秒的支持随版本而异，不值得赌。
     *
     * **`${'$'}` 的写法不是笔误**：Kotlin 的原始字符串（`"""`）里 `$` 依然会触发
     * 模板插值，所以 shell 的每一个 `$VAR` / `$1` / `$(...)` 都必须写成
     * `${'$'}…`。漏掉一个就会得到 `Unresolved reference: VAR` 这类
     * 看起来与 shell 毫无关系的编译错误（这个坑已经踩过一次）。
     */
    private val GATE_SCRIPT = """
#!@BASH@
# DSH Kxxy —— Shizuku ADB 身份执行闸门
#
# 由 App 在每次引擎启动时生成，请勿手工编辑（会被覆盖）。
#
# 语义：以 adb / shell 身份（uid 2000）执行一条命令。
# 与 root 模式的区别：root 是**引擎整体**以 uid 0 启动（进程级）；
# shz 是**按需**以 shell 身份执行单条命令（调用级）。两者不可互换。
#
# 用法：
#   shz pm list packages            # 参数以空格拼接后交给 shell
#   shz -c 'echo "hello" && id'     # 需要引号/管道时用 -c 显式传入
#
# 退出码：命令自身的退出码；通道不可用 69，未设置环境 78，超时 124，参数错 64。

set -u

R="${'$'}{KXXY_ENGINE_ROOT:-}"
if [ -z "${'$'}R" ]; then
  echo "shz: 环境变量 KXXY_ENGINE_ROOT 未设置（本命令只能从 DSH 引擎内调用）" >&2
  exit 78
fi

D="${'$'}R/shz"
CAP="${'$'}D/capable"
REQ="${'$'}D/request"
RES="${'$'}D/response"
LOCK="${'$'}D/lock"

if [ "${'$'}#" -eq 0 ]; then
  echo "用法: shz <命令...>" >&2
  echo "      shz -c '<shell 命令>'" >&2
  exit 64
fi

if [ "${'$'}{1:-}" = "-c" ]; then
  shift
  CMD="${'$'}{1:-}"
else
  CMD="${'$'}*"
fi

if [ ! -f "${'$'}CAP" ]; then
  echo "shz: Shizuku 通道未就绪" >&2
  if [ -f "${'$'}D/why" ]; then
    echo -n "shz: 原因：" >&2
    cat "${'$'}D/why" >&2
  fi
  echo "shz: 请在 DSH Kxxy 控制台 → 权限模式 中启用 Shizuku 模式并授权" >&2
  exit 69
fi

# 串行化：mkdir 是原子操作，比 test-then-create 安全
n=0
while ! mkdir "${'$'}LOCK" 2>/dev/null; do
  n=${'$'}((n+1))
  if [ "${'$'}n" -gt 600 ]; then
    echo "shz: 等待上一个命令超时（60s）" >&2
    exit 75
  fi
  sleep 0.1
done
trap 'rmdir "${'$'}LOCK" 2>/dev/null' EXIT

rm -f "${'$'}RES"
printf '%s' "${'$'}CMD" > "${'$'}REQ"

n=0
while [ ! -f "${'$'}RES" ]; do
  n=${'$'}((n+1))
  if [ "${'$'}n" -gt 1200 ]; then
    echo "shz: 执行超时（120s）" >&2
    rm -f "${'$'}REQ"
    exit 124
  fi
  sleep 0.1
done

CODE="${'$'}(head -n 1 "${'$'}RES")"
tail -n +2 "${'$'}RES"
rm -f "${'$'}RES"

case "${'$'}CODE" in
  ''|*[!0-9]*)
    echo "shz: 响应格式异常" >&2
    exit 70
    ;;
esac
exit "${'$'}CODE"
""".trimStart('\n')
}
