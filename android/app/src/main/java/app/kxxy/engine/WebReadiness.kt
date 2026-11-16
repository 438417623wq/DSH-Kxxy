package app.kxxy.engine

/**
 * 「引擎网页到底能不能用」的三个判据 —— 独立成对象，方便无 Android 依赖地回归。
 *
 * 为什么值得单独一个文件：0.9.48 的真机白屏是**判据问题**，不是渲染问题：
 * webserver 在 WebUI 挂载完成前对 `/` 回 404 + 空 body（`responderFor` 找不到
 * 命名路由就 `writeHead(404); res.end()`），宿主把 404 当成「引擎已就绪」，
 * 取不到 token 就加载裸 `/`，于是 WebView 得到一张空 body 的白页 ——
 * 200 也不算、网络错误也没有、4xx 又不触发救援，永久白。
 *
 * 这三条判据彼此独立，任何一条写错都只是「白屏」或「无谓重试」，不会报错，
 * 所以必须能被测试直接调用。
 */
object WebReadiness {

    /** HTTP 404：fallback owner（官方前端）尚未注册。 */
    const val HTTP_NOT_FOUND = 404

    /**
     * 健康检查判据：HTTP 栈已应答，**且** WebUI 已经挂载。
     *
     * 401 算就绪 —— 那是「挂载好了但还没换 cookie」，正是我们要的状态；
     * 404 不算，它恰恰说明 `/` 还没有 owner。
     */
    fun isReady(statusCode: Int): Boolean = statusCode in 200..499 && statusCode != HTTP_NOT_FOUND

    /**
     * 主文档 4xx 里值得自愈的那三个。
     *
     * 401/403：cookie 没换到（token 过期或没取到）；404：WebUI 还没挂载。
     * 其余 4xx（比如深链接打错）重载也没用，交给普通错误处理。
     */
    fun needsRecovery(statusCode: Int): Boolean =
        statusCode == 401 || statusCode == 403 || statusCode == HTTP_NOT_FOUND

    /**
     * 空白页判据：没有 `#root`，或 `#root` 空且页面上没有任何可见文字。
     *
     * 空白探针由 MainActivity 注入，结果形如 `{"c":0,"t":0}`：
     *   · c = #root 的子元素数（没有 #root 时为 -1）
     *   · t = body.innerText 去掉首尾空白后的字符数
     *
     * 判「白」的两种形状：
     *   · c < 0：页面里根本没有 `#root` —— 404 空 body 或 401 纯文本页，
     *     两种都不是前端，用户看到的就是「一片白」或「一行报错」；
     *   · c == 0 且 t == 0：前端外壳在、但一个像素都没画（boot 抛错）。
     *
     * 只有 root 没文字是正常的纯图标页，不能误判。
     * 探针本身失败（null/空串/解析不出字段）一律判「不白」：宁可不动，
     * 也不要因为一次 evaluate 失败就把用户踢进救援。
     */
    fun isBlank(probe: String?): Boolean {
        val text = probe?.trim().orEmpty()
        if (text.isEmpty()) return false
        val children = Regex("\"c\":(-?\\d+)").find(text)?.groupValues?.get(1)?.toIntOrNull() ?: return false
        val chars = Regex("\"t\":(\\d+)").find(text)?.groupValues?.get(1)?.toIntOrNull() ?: return false
        if (children < 0) return true
        return children == 0 && chars == 0
    }

    /** 空白探针脚本；与 [isBlank] 的字段约定必须一致。 */
    const val BLANK_PROBE: String =
        "(function(){try{var r=document.getElementById('root');" +
            "return JSON.stringify({c:r?r.childElementCount:-1,t:((document.body&&document.body.innerText)||'').trim().length})" +
            "}catch(e){return JSON.stringify({c:-1,t:0})}})()"

    /**
     * 移动端「主列被挤成 0 宽」的兜底样式（0.9.50 真机白屏）。
     *
     * 现场（CDP 直连设备 WebView 量的，不是推测）：
     *
     * ```
     * frame       400×805  grid-template-columns: 400px 0px 0px
     * ._sidebarCol  x=-280  280×805  position: absolute   ← 抽屉模式，已脱离网格流
     * ._centerCol   x=400    0×805                       ← 对话界面全在这里，宽 0
     * ```
     *
     * 页面结构、React 树、正文（4,806 字符）全都正常，唯独主列宽 0 —— 所以
     * 看到的是**纯白**，不是空 DOM。这也解释了为什么判据层永远不会弹救援：
     * `#root` 有子元素、页面上有文字，`isBlank` 判「不白」。
     *
     * ── 成因：DSH 0.2.2 改了列定位方式 ────────────────────────────────────
     *
     * `@deepseek-ai/dsh-client-ui-layout` 在 0.2.2 给三列钉了显式 `grid-area`：
     *
     * ```
     * ._sidebarCol{grid-area:1/1}  ._centerCol{grid-area:1/2}  ._rightbarCol{grid-area:1/3}
     * ```
     *
     * （0.2.1 及以前这三个类**没有任何 grid-area**，靠 DOM 顺序自动排布。）
     *
     * 而内置的第三方插件 `dsh-web-mobile@3.1.0` 的移动端样式还按 0.2.1 的形状写：
     *
     * ```
     * html [data-mobile-nav="frame"]{ grid-template-columns: minmax(0,1fr) 0 0 !important }
     * ```
     *
     * 在 0.2.1 里侧栏是 `position:absolute`（脱离网格流），主列靠自动排布落进
     * **第 1 轨**，于是 `1fr` 归主列 —— 那行是对的。0.2.2 把主列钉到第 2 轨之后，
     * `1fr` 被空着的第 1 轨吃掉，主列落进 `0` 宽的第 2 轨，整页白。
     *
     * ── 修法：与插件作者在 3.3.5 里给出的完全一致 ────────────────────────
     *
     * 插件 3.3.5 保留了同一行 `1fr 0 0`，但补了一条：
     *
     * ```
     * [data-mobile-nav="frame"] > [class*="_centerCol"] { grid-area: 1/1/2/2 !important }
     * ```
     *
     * 即「把主列钉回第 1 轨」，模板不用动。这里照抄这条。
     *
     * 选择器特异性 (0,2,0) 高于宿主 `._xxx_centerCol` 的 (0,1,0)，再加 `!important`：
     * 插件的 CSS-in-JS 是**挂载后**才注入的，我们的 `<style>` 一定比它早，靠特异性
     * 和 importance 赢，不依赖注入顺序。
     *
     * 媒体条件原样沿用插件那条（`max-width:1023px` + `pointer:coarse`），桌面
     * 宽度的 WebView 天然不命中；`> ` 直接子级限定则保证不会误伤面板里的
     * 嵌套 centerCol。
     *
     * 为什么放在宿主而不是改插件：插件整包在 `runtime.zip` 里（966 MB，带版本
     * 标记），改它要重跑全量运行时与增量迁移清单；这一条样式属于「宿主适配
     * 第三方插件」的范畴，和 compat.js 里的移动端适配是同一层职责。插件升级到
     * 3.3.5 之后这条规则依然成立（正是它自己的写法），可以从这里删掉。
     */
    const val MOBILE_FRAME_CSS: String =
        "@media (max-width: 1023px) and (pointer: coarse){" +
            "[data-mobile-nav=\"frame\"]>[class*=\"_centerCol\"]{grid-area:1/1/2/2 !important}" +
            "}"

    /**
     * 注入 [MOBILE_FRAME_CSS] 的脚本。
     *
     * 幂等：同一个文档只插一次（`onPageCommitVisible` 与 `onPageFinished` 都会
     * 调它）。失败一律返回字符串而不是抛错 —— 这条补丁只影响移动端布局，
     * 任何情况下都不该把页面搞挂。
     */
    fun mobileFrameFixScript(): String =
        "(function(){try{" +
            "if(document.getElementById('kxxy-mobile-frame'))return 'exists';" +
            "var s=document.createElement('style');s.id='kxxy-mobile-frame';" +
            "s.textContent=" + jsStringLiteral(MOBILE_FRAME_CSS) + ";" +
            "(document.head||document.documentElement).appendChild(s);return 'ok'" +
            "}catch(e){return 'err'}})()"

    /** 把文本包成 JS 单引号字符串字面量（转义反斜杠、单引号、换行）。 */
    private fun jsStringLiteral(text: String): String {
        val escaped = text
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\r", "")
            .replace("\n", "\\n")
        return "'$escaped'"
    }
}
