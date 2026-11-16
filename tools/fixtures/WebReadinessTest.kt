import app.kxxy.engine.WebReadiness
import kotlin.system.exitProcess

/**
 * 「引擎网页可用性」判据的夹具。
 *
 * 这些判据写错的后果只有一种：白屏。它们不会抛异常、不会被崩溃报告抓到，
 * 所以必须逐条钉死在测试里 —— 0.9.48 的真机白屏就死在 404 那条上。
 */
private var passed = 0

private fun check(name: String, condition: Boolean) {
    if (!condition) {
        System.err.println("FAIL $name")
        exitProcess(1)
    }
    passed++
    println("PASS $name")
}

fun main() {
    // 就绪判据 -----------------------------------------------------------------
    check("200 是就绪", WebReadiness.isReady(200))
    check("401 是就绪（已挂载，只差 cookie）", WebReadiness.isReady(401))
    check("499 是就绪（5xx 之前都算 HTTP 栈活着）", WebReadiness.isReady(499))
    check("404 不是就绪（fallback owner 还没注册）", !WebReadiness.isReady(404))
    check("500 不是就绪", !WebReadiness.isReady(500))
    check("连接失败(-1) 不是就绪", !WebReadiness.isReady(-1))
    check("0 不是就绪", !WebReadiness.isReady(0))

    // 自愈判据 -----------------------------------------------------------------
    check("401 需要自愈（cookie 没换到）", WebReadiness.needsRecovery(401))
    check("403 需要自愈", WebReadiness.needsRecovery(403))
    check("404 需要自愈（可能正好落在未挂载窗口）", WebReadiness.needsRecovery(404))
    check("400 不走自愈", !WebReadiness.needsRecovery(400))
    check("405 不走自愈", !WebReadiness.needsRecovery(405))
    check("500 不走自愈（已由服务错误分支处理）", !WebReadiness.needsRecovery(500))

    // 空白页判据 ---------------------------------------------------------------
    check("空 root 且无文字 = 白", WebReadiness.isBlank("{\"c\":0,\"t\":0}"))
    check("没有 root = 白（404 空 body）", WebReadiness.isBlank("{\"c\":-1,\"t\":0}"))
    check("没有 root 但有文字 = 白（401 纯文本页）", WebReadiness.isBlank("{\"c\":-1,\"t\":67}"))
    check("root 有子元素 = 不白", !WebReadiness.isBlank("{\"c\":3,\"t\":120}"))
    check("纯图标页（有 root 无文字）= 不白", !WebReadiness.isBlank("{\"c\":2,\"t\":0}"))
    check("探针返回 null = 不白（不误伤）", !WebReadiness.isBlank(null))
    check("探针返回空串 = 不白", !WebReadiness.isBlank("   "))
    check("字段缺失 = 不白", !WebReadiness.isBlank("{\"x\":1}"))
    check("字段非法 = 不白", !WebReadiness.isBlank("{\"c\":\"a\",\"t\":0}"))

    // 探针脚本与解析必须对得上 ------------------------------------------------
    check("探针带 childElementCount", WebReadiness.BLANK_PROBE.contains("childElementCount"))
    check("探针带 innerText", WebReadiness.BLANK_PROBE.contains("innerText"))
    check("探针带 #root", WebReadiness.BLANK_PROBE.contains("getElementById('root')"))
    check("探针是自执行函数", WebReadiness.BLANK_PROBE.startsWith("(function(){"))

    // 移动端列宽兜底（0.9.50 真机白屏）----------------------------------------
    val css = WebReadiness.MOBILE_FRAME_CSS
    check("兜底样式把主列钉回第 1 轨", css.contains("grid-area:1/1/2/2 !important"))
    check("兜底样式命中 centerCol", css.contains("[class*=\"_centerCol\"]"))
    check("兜底样式限定直接子级（不误伤嵌套）", css.contains(">[class*=\"_centerCol\"]"))
    check("兜底样式只在移动端生效", css.contains("max-width: 1023px") && css.contains("pointer: coarse"))
    check("兜底样式带 !important（宿主 ._centerCol 是同层声明）", css.contains("!important"))
    check("兜底样式括号配平", css.count { it == '{' } == css.count { it == '}' })

    val script = WebReadiness.mobileFrameFixScript()
    check("注入脚本是自执行函数", script.startsWith("(function(){"))
    check("注入脚本幂等（按 id 去重）", script.contains("getElementById('kxxy-mobile-frame')"))
    check("注入脚本挂到 head", script.contains("document.head||document.documentElement"))
    check("注入脚本吞异常", script.contains("catch(e)"))
    // 样式是从常量拼进去的，不是手抄一份 —— 两边一旦漂移这里就红。
    check("注入脚本内联的样式与常量一致", script.contains(css))
    check("注入脚本没有未转义的换行", css.contains("\n").not() && !script.contains("\n"))

    println("ALL PASS $passed")
}
