/* kxxy-webview-compat@11 */
/**
 * dsh-kxxy WebView 兼容层（polyfill + CSS 回退 + URL 修正）
 *
 * 版本标记 `kxxy-webview-compat@11`（首行）：RuntimeInstaller 的锚点 6 按这个
 * 字符串判定运行时的兼容层是否过期 —— 只判「文件存在」不足以让老设备在
 * 升级后拿到新版兼容层。改动本文件后必须同步递增编号（连同
 * RuntimeInstaller.COMPAT_LAYER_MARKER），否则旧设备会带着旧兼容层静默跳过重装。
 *
 * 背景：app.kxxy 的 WebView 是 com.google.android.webview 104.0.5112.97
 * （2022-07，Android 系统 WebView 由 ROM 决定，应用无法自带）。官方 DSH
 * 前端插件 bundle 使用了若干 Chrome 108+/116+ 才有的能力，已证实三处致命：
 *
 * 1) `AbortSignal.any`（Chrome 116+）被 `dsh-api-gateway` 的 `pumpEvents`
 *    在代际循环开头调用，缺失时抛 TypeError，被 `ConnectionController.loop()`
 *    静默吞掉，表现为 `[connection] connection lost, retry #N` 无限重试、
 *    `connection.generation` 恒为 undefined，最终：
 *      - 设置 → 通用设置 → 权限：原样渲染英文 `permission catalog has no
 *        active Host connection`
 *      - 设置 → 模型：provider 列表取空，整块空白
 * 2) `dvh` 单位（Chrome 108+）被 CSS 解析器整条丢弃，见 `patchCssText`
 *    处的详细说明 —— 表现为目录选择对话框列表整片空白。
 * 3) 非特殊协议的 `//authority` 解析（Chrome/WebView 105 前后对齐）——
 *    见 `urlAuthorityBroken` 处的详细说明 —— 表现为右侧栏 html / 图片 /
 *    任意工作区文件预览恒显示「文件资源服务不可用」。
 * 4) `:has()` 关系伪类（Chrome 105+）被 CSS 解析器整条丢弃（实测
 *    `CSS.supports('selector(div:has(span))') === false`）—— 见 `hasRewriteCss`
 *    处的详细说明 —— 表现为设置面板、插件样式表里以 `:has()` 为门控的规则
 *    全部失效（内置插件 dsh-web-mobile 那 278 KB 样式表里 301 处）。
 * 5) 内置插件按宿主「某一代」构建，选择器里写死了那一代的 CSS-module hash
 *    前缀 —— 见 `hashRefresh` 处的详细说明 —— 表现为插件 451 条规则里 330 条
 *    零命中（含「隐藏标题行 headerCorner」那条）。
 * 6) `window.open` 在本宿主里**不新开窗口**（见 `installWindowOpenBridge`）——
 *    表现为点「更多 → 登录」整页变白。这不是 WebView 版本问题，而是宿主
 *    WebView 没有 `setSupportMultipleWindows(true)` + `onCreateWindow`，
 *    于是 `window.open('about:blank','_blank')` 返回 null，官方账号登录的
 *    `BrowserLogin.begin()` 拿到 null 后 `follow()` 里那句
 *    `this.popup.location.replace(...)` 直接抛 TypeError，整个 SignInDialog
 *    的渲染树崩掉。
 * 7) 两类「宿主与内置移动端插件各自以为对方会处理」的布局重复/溢出 ——
 *    见 `installMobileLayoutTweaks` 处的详细说明 —— 表现为对话界面右上角
 *    多出一个与文件按钮重叠的侧栏图标，「标准模式」chip 左侧多出一个本该
 *    被 `@container` 藏掉的图标（`@container` 是 Chrome 105+，本 WebView
 *    整块丢弃），以及底部状态指标行三段被省略号截断。
 *
 * 任何一张样式表改写失败都不能拖垮整层（`patchStyleTag` 用 try/catch 隔离）：
 * 本层是「一次异常 = 全部 CSS 回退静默失效」的结构，曾经因为一个未定义的
 * `matchParen` 让 dvh / @scope / :has() 三段一起停摆了很久。
 *
 * 本文件必须在任何页面脚本执行之前注入（<head> 内同步 inline script），
 * 在 onPageFinished 阶段注入已经太晚——连接循环一旦以失败代际启动，
 * 补回 API 也不会让重试计数立即归零。
 *
 * 幂等：API 补丁全部用 `typeof x !== 'function'` 守卫，已支持的环境原样
 * 跳过；只补「缺失」不覆盖「已有」，避免改变原生语义。CSS 回退在文本层面
 * 做 `dvh → vh` 替换，替换后不再含 `dvh`，重复执行是无操作。URL 修正用
 * 行为探测（探测式补好后自然为 false）保证重复执行无副作用。
 */
(function () {
  'use strict'

  // ── AbortSignal.any（Chrome 116+）★ 已证实致命项 ────────────────────
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
    AbortSignal.any = function any(signals) {
      var controller = new AbortController()
      var list = Array.prototype.slice.call(signals)
      var abort = function (reason) {
        if (!controller.signal.aborted) controller.abort(reason)
      }
      for (var i = 0; i < list.length; i++) {
        var s = list[i]
        if (s.aborted) {
          abort(s.reason)
          return controller.signal
        }
        s.addEventListener('abort', function () { abort(this.reason) }, { once: true })
      }
      return controller.signal
    }
  }

  // ── AbortSignal.timeout（Chrome 103+，104 已有；幂等兜底）────────────
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
    AbortSignal.timeout = function timeout(ms) {
      var controller = new AbortController()
      setTimeout(function () {
        controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
      }, ms)
      return controller.signal
    }
  }

  // ── Promise.withResolvers（Chrome 119+）──────────────────────────────
  if (typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = function withResolvers() {
      var resolve, reject
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej })
      return { promise: promise, resolve: resolve, reject: reject }
    }
  }

  // ── Promise.try（Chrome 128+）────────────────────────────────────────
  if (typeof Promise.try !== 'function') {
    Promise.try = function try_(fn) {
      var args = Array.prototype.slice.call(arguments, 1)
      return new Promise(function (resolve) { resolve(fn.apply(undefined, args)) })
    }
  }

  // ── Array.prototype.toSorted / toReversed / toSpliced / with（Chrome 110+）
  var defineArray = function (name, fn) {
    if (typeof Array.prototype[name] === 'function') return
    Object.defineProperty(Array.prototype, name, {
      value: fn, writable: true, configurable: true, enumerable: false,
    })
  }
  defineArray('toSorted', function (compareFn) {
    return Array.prototype.slice.call(this).sort(compareFn)
  })
  defineArray('toReversed', function () {
    return Array.prototype.slice.call(this).reverse()
  })
  defineArray('toSpliced', function () {
    var copy = Array.prototype.slice.call(this)
    copy.splice.apply(copy, arguments)
    return copy
  })
  defineArray('with', function (index, value) {
    var copy = Array.prototype.slice.call(this)
    var i = index < 0 ? copy.length + index : index
    if (i < 0 || i >= copy.length) throw new RangeError('Invalid index')
    copy[i] = value
    return copy
  })

  // ── TypedArray 同族（Chrome 110+）────────────────────────────────────
  var typedCtor = typeof Uint8Array !== 'undefined' ? Object.getPrototypeOf(Uint8Array.prototype) : null
  if (typedCtor) {
    var defineTyped = function (name, fn) {
      if (typeof typedCtor[name] === 'function') return
      Object.defineProperty(typedCtor, name, {
        value: fn, writable: true, configurable: true, enumerable: false,
      })
    }
    defineTyped('toSorted', function (compareFn) {
      var copy = this.slice()
      return copy.sort(compareFn)
    })
    defineTyped('toReversed', function () { return this.slice().reverse() })
    defineTyped('with', function (index, value) {
      var copy = this.slice()
      var i = index < 0 ? copy.length + index : index
      if (i < 0 || i >= copy.length) throw new RangeError('Invalid index')
      copy[i] = value
      return copy
    })
  }

  // ── URL.canParse（Chrome 120+）───────────────────────────────────────
  if (typeof URL !== 'undefined' && typeof URL.canParse !== 'function') {
    URL.canParse = function canParse(url, base) {
      try { new URL(url, base); return true } catch (e) { return false }
    }
  }

  // ── URL.parse（Chrome 126+）──────────────────────────────────────────
  // 官方文档预览的 PDF 分块用它做链接识别：
  //   const hostname = URL.parse(`http://${emailDomain}`)?.hostname;
  // 缺失时抛 TypeError（不是返回 null），会打断整个链接标注流程。
  if (typeof URL !== 'undefined' && typeof URL.parse !== 'function') {
    URL.parse = function parse(url, base) {
      try { return new URL(url, base) } catch (e) { return null }
    }
  }

  // ── Object.groupBy / Map.groupBy（Chrome 117+）───────────────────────
  if (typeof Object.groupBy !== 'function') {
    Object.groupBy = function groupBy(items, callback) {
      var out = Object.create(null)
      var i = 0
      for (var item of items) {
        var key = callback(item, i++)
        if (out[key] === undefined) out[key] = []
        out[key].push(item)
      }
      return out
    }
  }
  if (typeof Map.groupBy !== 'function') {
    Map.groupBy = function groupBy(items, callback) {
      var out = new Map()
      var i = 0
      for (var item of items) {
        var key = callback(item, i++)
        var bucket = out.get(key)
        if (bucket === undefined) out.set(key, [item])
        else bucket.push(item)
      }
      return out
    }
  }

  // ── String.prototype.isWellFormed / toWellFormed（Chrome 111+）───────
  if (typeof String.prototype.isWellFormed !== 'function') {
    String.prototype.isWellFormed = function isWellFormed() {
      return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(this)
    }
  }
  if (typeof String.prototype.toWellFormed !== 'function') {
    String.prototype.toWellFormed = function toWellFormed() {
      return String(this).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, '\uFFFD')
    }
  }

  // ── Set 方法族（Chrome 122+）────────────────────────────────────────
  if (typeof Set.prototype.union !== 'function') {
    Object.defineProperty(Set.prototype, 'union', {
      value: function (other) {
        var out = new Set(this)
        for (var v of other) out.add(v)
        return out
      }, writable: true, configurable: true, enumerable: false,
    })
  }
  if (typeof Set.prototype.intersection !== 'function') {
    Object.defineProperty(Set.prototype, 'intersection', {
      value: function (other) {
        var out = new Set()
        var o = other instanceof Set ? other : new Set(other)
        for (var v of this) if (o.has(v)) out.add(v)
        return out
      }, writable: true, configurable: true, enumerable: false,
    })
  }
  if (typeof Set.prototype.difference !== 'function') {
    Object.defineProperty(Set.prototype, 'difference', {
      value: function (other) {
        var out = new Set()
        var o = other instanceof Set ? other : new Set(other)
        for (var v of this) if (!o.has(v)) out.add(v)
        return out
      }, writable: true, configurable: true, enumerable: false,
    })
  }

  // ── Array.fromAsync（Chrome 121+）────────────────────────────────────
  if (typeof Array.fromAsync !== 'function') {
    Array.fromAsync = function fromAsync(items, mapFn, thisArg) {
      return (async function () {
        var out = []
        var i = 0
        for await (var item of items) {
          out.push(mapFn ? await mapFn.call(thisArg, item, i++) : item)
        }
        return out
      })()
    }
  }

  // ── window.open 桥（宿主 WebView 无多窗口）★ 已证实致命项 ──────────────
  //
  // 真机事故（用户报，Android 真机 + ROM 自带 WebView）：
  //   侧栏「更多」→「登录」→ **整页变白**，没有任何错误提示，返回键也回不来。
  //
  // 根因链（三环，缺一不成立）：
  //   1. 官方账号登录在「非 Desktop」分支走 `BrowserLogin.begin()`：
  //          this.popup = window.open("about:blank", "_blank");
  //      —— 它假定宿主能开新窗口。
  //   2. 本宿主 MainActivity **没有** `setSupportMultipleWindows(true)` +
  //      `onCreateWindow`，Android WebView 在这种配置下对 `window.open`
  //      的语义是「在当前 WebView 里导航到该 URL」：于是**主框架被导航到
  //      about:blank** ⇒ 整个 SPA 没了 ⇒ 白屏。返回值同样是 null。
  //   3. 随后 `BrowserLogin.follow()` 里：
  //          if (this.popup && !this.popup.closed) this.popup.location.replace(...)
  //      虽然对 null 有守卫，但登录框组件自身依赖 attempt 状态机推进；
  //      而主页面已经变成 about:blank，任何后续渲染都不存在了。
  //
  // 为什么不在原生层补 `onCreateWindow`：那需要再造一个 WebView + 窗口栈
  // （官方前端是 SPA，弹窗里还要跑 React 登录页），而这一层要做的事只有
  // 一件 —— **把授权页交给系统浏览器**。这也正是 Desktop 版的行为
  // （`platform-login.js` 的 `watchPlatformLogin` 走 `action: "open",
  // external: true`）。所以最省事、也最贴近官方语义的做法是在 Web 层把
  // `window.open` 接住：
  //   · `about:blank` / 空串 → 返回一个**惰性弹窗桩**，它的
  //     `location.replace(url)` 触发「用系统浏览器打开」；
  //   · 真实 http(s) URL → 直接交给系统浏览器，返回 null（调用方全部有
  //     null 守卫：BrowserLogin、contactUs、文档预览的外链、聊天里的
  //     链接预览）。
  //
  // 打开动作走 `kxxy://open?url=…`，由 MainActivity 的
  // `handleOpenBridge` 用 ACTION_VIEW 交给系统浏览器（与既有的
  // `kxxy://perm/request` 同一条桥，见 MainActivity）。
  //
  // 安全性：只放行 http/https，且 `encodeURIComponent` 整串编码 —— 桥的
  // 另一端（Kotlin）会再 `Uri.parse` + scheme 校验一次，不接受 file:/intent:
  // 这类会被系统解释成任意组件的协议。
  //
  // 幂等：装上后在 window 上留一个标记，重复注入直接跳过；宿主若将来真的
  // 支持多窗口，把标记置真即可绕过本层，不必改代码。
  var kxxyOpenInSystemBrowser = function (url) {
    if (typeof url !== 'string') return false
    var target = url.trim()
    if (target === '' || target === 'about:blank') return false
    if (!/^https?:\/\//i.test(target)) return false
    try {
      window.location.href = 'kxxy://open?url=' + encodeURIComponent(target)
      return true
    } catch (error) {
      return false
    }
  }

  var installWindowOpenBridge = function () {
    if (typeof window === 'undefined') return
    if (window.__kxxyWindowOpenBridge === true) return
    if (typeof window.open !== 'function') return

    // 惰性弹窗桩：只实现 BrowserLogin 用到的那几个成员。
    var makePopupStub = function () {
      var stub = {
        closed: false,
        opener: null,
        name: '',
        focus: function () {},
        blur: function () {},
        postMessage: function () {},
        document: {
          open: function () {},
          write: function () {},
          writeln: function () {},
          close: function () {},
        },
      }
      var open = function (target) {
        kxxyOpenInSystemBrowser(target)
        // 页面已经交给系统浏览器，这个「窗口」在我们这里就结束了 ——
        // 置 closed 让调用方走「弹窗已关闭」的分支，而不是继续等一个
        // 永远不会出现的导航。
        stub.closed = true
      }
      stub.location = {
        href: 'about:blank',
        replace: open,
        assign: open,
        reload: function () {},
        toString: function () { return 'about:blank' },
      }
      stub.close = function () { stub.closed = true }
      return stub
    }

    try {
      window.open = function (url, name, features) {
        void name
        void features
        var target = typeof url === 'string' ? url.trim() : ''
        if (target === '' || target === 'about:blank') return makePopupStub()
        kxxyOpenInSystemBrowser(target)
        return null
      }
      window.__kxxyWindowOpenBridge = true
    } catch (error) {
      // window.open 不可写（部分 WebView 的 host object）：保持原样，
      // 主框架仍会被导航成 about:blank，但至少不额外抛错。
    }
  }

  installWindowOpenBridge()

  // ── 移动端布局微调：顶栏重复入口 + 底部状态行放不下 ───────────────────
  //
  // 两处症状都不是插件写错了，而是「内置插件 dsh-web-mobile 3.1.0 + 本宿主
  // 这一代」叠加 WebView 104 的能力缺口后剩下的坑。三条都要落在这里（而不是
  // 改插件包），原因见下：插件是 npm 上的第三方包，构建期整包塞进 asar，
  // 它的样式表在 `lib/client.js` 里是压缩成一行的字符串，改它等于改别人
  // 110 KB 的编译产物；而这三条全是**我们这台设备**的取舍。
  //
  // ① 右上角多出一个图标（与插件自己的文件按钮重叠）。
  //    插件自己有文件按钮（`[data-mobile-nav="files"]`，手机档座位 30px）；
  //    宿主 `dsh-client-ui-sidebar-right` 另有一个「右侧栏入口」挂在会话标题行
  //    的 `headerCorner` 上。手机档的右侧栏就是同一个 Files 面板 —— 两个入口
  //    指向同一处，而且 corner 带 `margin-right:-16px`，36px 的盒子在窄视口下
  //    会从文件按钮右侧漏出一角（插件注释里 2026-09-22 实测：corner
  //    [332,2 36x36]、图标 343..358 外露）。插件本来有规则藏它，但那条规则
  //    用 `:has()` 门控 —— 本宿主这一代的 `:has()` 全靠本层的 `hasRewriteCss`
  //    兜底，改写一变就惰性化，表现为「右上角多出一个侧栏图标」。
  //    这里改锚在宿主自己写在 DOM 上的稳定属性
  //    `data-conversation-header-corner`（见
  //    `dsh-client-ui-conversation/lib/client.js` 的 titleRow 渲染），不碰 hash。
  //    为什么要 `!important` + `:not(#kxxy)`：插件里有一条方向相反的规则
  //    （`... > :first-child > :last-child[class*="_headerCorner"]` 把 corner
  //    `display:flex` 放出来，给的是 0.1.6 那一代宿主用），特异性 (0,6,1)
  //    且带 `!important`；这一代宿主两个入口都活着，只能靠抬一级 id 特异性
  //    压过它。页面上没有 id 为 `kxxy` 的元素，匹配集不变。
  //
  // ② 「标准模式」chip 左侧那个 14px 图标。
  //    该 chip 由 `dsh-client-ui-agent-preset` 渲染，它自己的样式表写着
  //    `@container (width<=540px){.f8BMvq_label{display:none}}` —— 窄屏本来
  //    整块隐藏。但 `@container` 是 Chrome 105+ 特性，目标 WebView 104 会把
  //    整块丢掉，于是手机上反而常显（连同图标）。用户要保留「标准模式」这个
  //    文字、只去掉图标，所以这里不补容器查询（补了整块就没了），只隐掉 chip
  //    内的 svg。
  //
  // ③ 底部状态行三段被省略号截断。
  //    宿主 `StatsPills` 的 label 是 `text-overflow:ellipsis;overflow:hidden;
  //    min-width:0`，在横向 flex 里一旦被压缩就截断；字号是
  //    `calc(--dsh-content-font-size-secondary,13px - 1px)`，即 12px。
  //    插件另有一整套 `[data-mobile-nav="stats"]` 规则（字号压到 10px + 只让
  //    最后一组出省略号），但那套规则依赖插件自己给那一行打的标记 —— 本宿主
  //    这一代没被打上（否则不会是 12px，也不会前两组一起截断），所以整套是
  //    惰性的。这里改用宿主写在每个指标上的稳定属性 `data-composer-stat`
  //    （`dsh-client-ui-chat` 的 PlainPill / DialogPill 都带）做锚点，把字号
  //    收到 11px、内边距 8→4、分隔符 6→1、图标 14→12，抠出的宽度让三段都
  //    放得下；仍然保留省略号作为兜底（真放不下时宁可截尾，也不要溢出到
  //    看不见的地方）。
  // 为什么状态行要「分两种关系写」：字号挂在指标自己身上，但分隔符与内边距
  // 在**同一行的兄弟节点**上，不是指标的后代。第一版三条全写成
  // `[data-composer-stat] [class*="_sep"]`，无头 Chromium 实测 computed
  // margin 仍是 6px —— 选择器压根没命中，而这类失误在真机上只表现为
  // 「看起来没生效」，不会有任何报错。现在三种关系各用对的形式：
  //   指标自己        → `[data-composer-stat]`
  //   指标内部的内层  → `[data-composer-stat] [class*="_pill"]`
  //   指标旁边的分隔  → `[data-composer-stat] ~ [class*="_sep"]`（后续兄弟）
  // 刻意**不用** `:has()`：目标 WebView 104 没有它（Chrome 105+），而本层的
  // `patchAllStyles` 会把所有 `<style>` 过一遍 `hasRewriteCss` —— 靠垫片活着
  // 的规则一改写变化就惰性化（插件那几条 `[data-mobile-nav="stats"]` 规则正是
  // 这么失灵的先例）。这里只用 104 就认得的选择器，不给自己加依赖。
  var MOBILE_LAYOUT_CSS = [
    '@media (max-width: 767px) {',
    '  header [data-conversation-header-corner]:not(#kxxy) { display: none !important }',
    // ① 溢出保护：允许芯片盒子收缩（min-width:0），但不许文字画出盒子。
    //
    // 这是 2026-10-23 那三张截图里「压字」的**直接机制**：headerActions 是
    // `flex:0 1 auto; min-width:0`（dsh-web-mobile 自己的规则），盒子会缩到
    // 内容宽度以下，而文字照旧绘制，于是盖在邻居身上 —— 不是「太挤」，是
    // 「画到了盒子外面」。上游各芯片大多自带 `overflow:hidden`（agent-preset
    // 的 `.f8BMvq_label` 就有），但不是每个都带，且尺寸一旦被外部规则改写
    // 就会漏。
    //
    // 菜单不受影响：jobs / subagent 的下拉都用 portal 挂到 document.body，
    // 不是芯片后代，这里裁不到。
    '  header [class*="_headerActions"] > *:not(#kxxy) { min-width: 0; overflow: hidden }',
    '  [data-composer-stat]:not(#kxxy) { font-size: 11px !important; line-height: 18px !important }',
    '  [data-composer-stat] [class*="_pill"]:not(#kxxy) { padding-left: 4px !important; padding-right: 4px !important; gap: 4px !important }',
    '  [data-composer-stat]:not(#kxxy) ~ [class*="_sep"] { margin: 0 1px !important }',
    '  [data-composer-stat] svg { width: 12px !important; height: 12px !important }',
    '}',
    // ② 「标准模式」芯片在最窄一档整个不显示 —— 阈值 540px 抄的是上游自己的
    // 数（`@container (width<=540px){.f8BMvq_label{display:none}}`）。
    //
    // 这条**推翻了 2026-09-22 的旧取舍**（当时只隐芯片内图标、按用户要求
    // 保留「标准模式」文字）。推翻的理由是实测：这一行要同时装「标准模式」
    // 「N 个后台任务」「N 个子智能体」三个芯片，在 393dp 宽的竖屏上，
    // 三者加起来的 min-content 宽度已经超过「标题保底 30%」之后剩下的空间
    // —— 数学上装不下，不是调间距能救的。保留文字的代价是整行压字、
    // 连标题都只剩两个字，比少一个只读的芯片更糟。
    //
    // 为什么现在才敢这么做：上游这条 `@container` 原本在 WebView 104 上
    // 被整块丢弃（见 containerRewriteCss 的注释），所以「照上游意图隐藏」
    // 这条路以前根本走不通。垫片补上后它自己也会生效，这条规则因此是冗余
    // 的兜底 —— 留着是因为垫片只翻「无容器名的 width 查询」，上游哪天换成
    // 命名容器就会退回失效，而这里不能退回「压字」。
    //
    // 用直接子级 `> [class*="_label"]` 而不是后代：`_label` 这个片段在
    // subagent 的血缘行里也出现（`_3K3mEa_label`），那个不在 headerActions
    // 的直接子级，不能误伤。
    // 用 `header [class*="_label"]` 而**不**限定 `_headerActions` 祖先：
    // 2026-10-23 手机端截图显示官方会话头里那排芯片的容器类名并不是
    // `_headerActions`（那是 dsh-web-mobile 的命名），限定祖先等于一条都不命中。
    // 所以锚点只取两样：在 `header` 里 + 类名带 `_label` 片段。
    // 误伤面评估（2026-10-23 校正）：subagent 血缘行里的 `_3K3mEa_label` 确实不在
    // header 内，但 header 里带 `_label` 的**不只是按钮文字** —— 两个状态芯片自己的
    // 文字也是这个后缀。所以这一条必须配下面那条 `display: revert` 才有正确语义，
    // 单独存在会把「9 个子智能体」藏得只剩圆环。
    '@media (max-width: 540px) {',
    '  header [class*="_label"]:not(#kxxy) { display: none !important }',
    // ↑ 这条会连 headerActions 里两个状态芯片的文字一起藏掉 —— 2026-10-23 落地竖排时
    // 在预览里撞见：子智能体芯片只剩一个圆环，「9 个子智能体」六个字整个不见了。
    // 原因是上游各插件的 label 类名共用 `_label` 后缀（`.f8BMvq_label` 是标准模式、
    // `_3K3mEa_label` 是子智能体），按后缀锚根本分不开它们。上面「误伤面可控」那句
    // 结论是错的：header 里带 `_label` 的不只是按钮文字，还有这两个芯片的文字。
    //
    // 修法：先全藏、再把「在 headerActions 里」的恢复回来。能这么切是因为结构差异
    // 稳定 —— 标准模式的 label 挂在 titleRow 那一层（不在 headerActions 内），两个
    // 状态芯片则是 headerActions 的直接子级。
    // 恢复用 `display: revert` 而不是 `inline`：label 可能是 span 也可能是块级容器，
    // revert 回落到 UA 默认值，比猜一个具体值安全（Chrome 84+ 支持，104 没问题）。
    // 这条必须也带 `:not(#kxxy)`：同为 !important 时比特异性，低了就压不过上面那条。
    '  header [class*="_headerActions"] [class*="_label"]:not(#kxxy) { display: revert !important }',
    // ③ 两个状态芯片（后台任务 / 子智能体）改上下两行（2026-10-23 用户拍板「按 E 落地」）。
    //
    // 为什么不是「判断有几个芯片再竖排」：`flex-direction: column` 本身就是数量自适应
    // —— 只有一个时排成一列等于一行，视觉与横排一致；两个时自然上下两行。用 `:has()`
    // 数兄弟节点（104 不支持，要依赖垫片，且改写在 `_headerActions` 这种高特异性
    // 上下文里不可靠）或 JS 测量（窗口尺寸变化要重算，且首帧会跳）都比这一行 CSS 脆。
    //
    // 顺序不写死：移动档里后台任务 chip 被上游 `order: 9` 推到末位，column 下 order
    // 仍然生效，于是子智能体在上、后台任务在下。这里不抢这个 order —— 上游改回 0 时
    // 顺序应随之变回，写死反而打架。
    //
    // `overflow: visible` 是必须的：上游手机档把 headerActions 做成 `overflow-x: auto`
    // 的横向滚动盒（断点 A，2026-09-19）。column 主轴一换，这个 `auto` 会顺带把
    // 纵向也变成滚动容器 —— 两行芯片被裁、还多出一条不可见的滚动缝。宁可放弃
    // 「横排时能滑动」这条退路，因为竖排之后横排溢出这个前提已经不存在了。
    //
    // `:not(#kxxy)` 是为了提特异性：上游那条 `header:has([class*="_headerLeading"]) ...`
    // 的规则带 4 个属性选择器 + `!important`，本层若只写 `header [class*="_headerActions"]`
    // 会被压掉（同为 !important 时比特异性）。`:not(#kxxy)` 里的 id 让本规则升到 (1,1,1)，
    // 稳定压过它，又不依赖宿主是否带 `data-mobile-nav` 属性。
    '  header [class*="_headerActions"]:not(#kxxy) { flex-direction: column !important; align-items: flex-end !important; justify-content: center !important; gap: 0 !important; overflow: visible !important; max-width: none !important }',
    // 紧凑尺寸（E 档）：17px 行高让两行的总高 ≈ 34px，header 只增高约 11px。
    // 这确实牺牲了触摸热区（原 28px → 17px）；若真机实测难点，把 min-height
    // 提到 22px 即可，总高仍比 D 档（28px 行）矮一截。
    '  header [class*="_headerActions"] > *:not(#kxxy) { min-width: 0; min-height: 17px !important; padding-block: 0 !important; font-size: 11px !important; line-height: 15px !important }',
    // 芯片内部文字自己带 font-size（`.f8BMvq_label` 之类），只改根元素管不到它们。
    // 排除 svg：图标尺寸由下面那条单独定，继承 line-height 会把圆环类的 svg 拉变形。
    '  header [class*="_headerActions"] > *:not(#kxxy) > *:not(svg) { font-size: inherit !important; line-height: inherit !important }',
    '  header [class*="_headerActions"] svg { width: 11px !important; height: 11px !important }',
    // corner（右上角文件夹图标）原来 `margin-right: -16px` 顶出 header 右内边距；
    // 两行芯片之后它的负边距会把图标压到芯片列上，收一半。
    '  header [class*="_headerCorner"]:not(#kxxy) { margin-left: 2px !important; margin-right: -6px !important }',
    '}',
  ].join('\n')

  var installMobileLayoutTweaks = function () {
    // 整段包 try/catch：本层的位置在 IIFE 开头附近（所有 CSS 回退、API 补丁都在
    // 它后面），这里一旦抛异常，后面几百行补丁一条都不会执行 —— 而症状只是
    // 「手机上某些适配没生效」，不会留任何痕迹。test-compat-css 的极简 DOM 桩
    // 就踩过：它的 `document` 没有 `querySelector`，`TypeError` 直接从这一行
    // 冒出去，整层静默失效（缺陷 DS）。
    var apply = function () {
      try {
        var head = document.head || document.documentElement
        if (!head) return false
        if (typeof head.appendChild !== 'function') return false
        if (
          typeof document.querySelector === 'function' &&
          document.querySelector('style[data-kxxy-mobile-layout]') !== null
        ) {
          return true
        }
        var tag = document.createElement('style')
        tag.setAttribute('data-kxxy-mobile-layout', '')
        tag.textContent = MOBILE_LAYOUT_CSS
        head.appendChild(tag)
        return true
      } catch (error) {
        return false
      }
    }
    // 注入点在 <head> 里，`document.head` 一定已存在；保留 DOMContentLoaded
    // 兜底是为了「inline script 被搬到 body」这种改法不会静默失效。
    if (apply()) return
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', apply)
    }
  }

  installMobileLayoutTweaks()

  // ── URL：非特殊协议的 authority 解析 ★ 已证实致命项 ──────────────────
  //
  // 真机事故：右侧栏「工作区文件」里点开 html / 图片 / 任何文件，预览区只
  // 显示「文件资源服务不可用」，重试无效（文件树本身正常）。
  //
  // 根因：本机 WebView 104 的 URL 解析器对**非特殊协议**（non-special
  // scheme，即 http/https/ws/wss/ftp/file 之外的自定义协议）不承认
  // `//authority` 形式，把 authority 整段折进 pathname：
  //     new URL('dsh-resource://file/session/abc/whale.html')
  //       104  → hostname=""  pathname="//file/session/abc/whale.html"
  //       规范 → hostname="file" pathname="/session/abc/whale.html"
  // 对照：https://file/… 在 104 上 hostname="file"（特殊协议正常），
  // dsh-resource:file/x（无 //）也正常。这是 URL 规范对非特殊协议 host
  // 解析收紧后、Chrome/WebView 105 前后才对齐的行为。
  //
  // 后果链：dsh-client-resources 的 protocolOf(address) 用
  //     parsed.hostname === "" ? void 0 : parsed.hostname.toLowerCase()
  // 取协议名 → 本机恒为 undefined → providerOf() 找不到已注册的 file
  // provider（实测 providers=[subagentchat,plan,file]，注册本身没问题）→
  // ResourceRegistry.create() 建出 status:"none" 的记录 → TextPreview
  // 渲染 t("resourceUnavailable")＝「文件资源服务不可用」。
  //
  // 同一缺陷还打断另外两处：
  //   - dsh-client-ui-subagent 的 parseSubagentChatAddress：
  //     url.hostname.toLowerCase() !== "subagentchat" 恒真 → 子代理聊天标签页失效；
  //   - dsh-client-ui-sidebar-right 的 pathOf：
  //     new URL(address).pathname 返回 "//file/session/…" 而非 "/session/…"，
  //     无 scheme 前缀的 slot pattern 匹配失败。
  //
  // 修法：包一层 URL.prototype 的 hostname / host / pathname 取值器。三者都是
  // configurable 的访问器（实测 descriptor 为 get+set+configurable），因此无需
  // 替换 URL 构造函数、不影响 instanceof、不必复制静态方法（canParse 等）。
  // 只在「原生 hostname 为空 **且** 原生 pathname 以 // 开头」时改写，其余
  // 情况原样返回原生值 —— http(s) 等特殊协议、以及本来就没有 authority 的
  // 地址（dsh-resource:file/x、about:blank、blob:…、data:…）全部不受影响。
  // href / protocol / search / hash 在 104 上本就正确，不动；port / username /
  // password 也保持原生（本 app 的 dsh-resource 地址不带这些分量）。
  //
  // 幂等：补丁生效后这个探测式自然返回 false（hostname 已被修好），重复执行
  // 是无操作，不需要额外的全局标记。
  var urlAuthorityBroken = false
  try {
    urlAuthorityBroken = new URL('x-dsh-probe://host/p').hostname !== 'host'
  } catch (error) {
    urlAuthorityBroken = false
  }

  if (urlAuthorityBroken && typeof URL === 'function' && URL.prototype) {
    var nativeHostname = Object.getOwnPropertyDescriptor(URL.prototype, 'hostname')
    var nativeHost = Object.getOwnPropertyDescriptor(URL.prototype, 'host')
    var nativePathname = Object.getOwnPropertyDescriptor(URL.prototype, 'pathname')

    // 把折进 pathname 的 "//authority/rest" 拆回三个分量。
    // authority 允许为空：`//` → 空 authority；`///file/x` 也是空 authority
    // （第二个 `/` 终止了 authority），与规范一致。
    var splitFoldedAuthority = function (raw) {
      var end = raw.length
      for (var i = 2; i < raw.length; i++) {
        var ch = raw.charAt(i)
        if (ch === '/' || ch === '?' || ch === '#') {
          end = i
          break
        }
      }
      var authority = raw.slice(2, end)
      var at = authority.lastIndexOf('@')
      var hostPort = at === -1 ? authority : authority.slice(at + 1)
      var colon = hostPort.lastIndexOf(':')
      return {
        host: hostPort,
        hostname: colon === -1 ? hostPort : hostPort.slice(0, colon),
        pathname: raw.slice(end),
      }
    }

    // 特殊协议（有独立解析规则）在 104 上本来就正确，且它们的 pathname 也可能
    // 合法地以 `//` 开头（如 `file:////x` → host="" path="//x"，与规范一致）——
    // 必须排除，否则会把本来正确的地址改坏。
    var SPECIAL_SCHEMES = {
      'http:': true, 'https:': true, 'ws:': true, 'wss:': true, 'ftp:': true, 'file:': true,
    }
    var nativeProtocol = Object.getOwnPropertyDescriptor(URL.prototype, 'protocol').get

    var foldedAuthorityOf = function (self) {
      if (SPECIAL_SCHEMES[nativeProtocol.call(self)] === true) return null
      if (nativeHostname.get.call(self) !== '') return null
      var raw = nativePathname.get.call(self)
      if (raw.length < 2 || raw.charAt(0) !== '/' || raw.charAt(1) !== '/') return null
      // `//` 后紧跟 `/`（或已到结尾）表示 authority 为空：104 把分隔用的两个
      // 斜杠也留在了 pathname 里（`dsh-resource:///file/x` → `///file/x`、
      // `dsh-resource://` → `//`），规范则丢弃它们。只有 `//<非斜杠开头>`
      // 才是被折进来的 authority，走后一个分支。
      if (raw.length < 3 || raw.charAt(2) === '/') {
        return { host: '', hostname: '', pathname: raw.slice(2) }
      }
      return splitFoldedAuthority(raw)
    }

    var wrapUrlGetter = function (descriptor, key, pick) {
      Object.defineProperty(URL.prototype, key, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: function () {
          var folded = foldedAuthorityOf(this)
          return folded === null ? descriptor.get.call(this) : pick(folded)
        },
        set: descriptor.set,
      })
    }

    wrapUrlGetter(nativeHostname, 'hostname', function (folded) { return folded.hostname })
    wrapUrlGetter(nativeHost, 'host', function (folded) { return folded.host })
    wrapUrlGetter(nativePathname, 'pathname', function (folded) { return folded.pathname })
  }

  // ── CSS 动态视口单位回退（dvh → vh）★ 已证实致命项 ──────────────────
  //
  // 真机事故：目录选择对话框在老手机上列表整片空白，标题与底部按钮正常。
  // 根因是 dsh-client-ui-directory-picker-browse 注入的
  //   .Fv-y6W_dialog.Fv-y6W_dialog{...;height:min(500px,100dvh - 32px);...}
  // —— `dvh` 需要 Chrome 108+，而本机 WebView 是 104，CSS 解析器会把整条
  // height 声明丢弃，对话框退化为 height:auto；其内部是 flex 列 + 子项
  // flex:1 1 0，auto 高度下被压成 0，列表行虽在 DOM 里却被 0 高的
  // overflow:auto 容器裁掉。实测抹掉这条声明后 dialog 高度 500→229、
  // millerRow/column 271→0，补回一条 vh 版本即恢复 500/271。
  //
  // 修法是在样式文本层面把 `dvh` 改写成 `vh`：WebView 里不存在会收缩的
  // 浏览器工具栏，动态视口高度与最大视口高度恒等，两者数值完全一致，因此
  // 改写不改变任何布局意图，也不需要知道插件的 hash 类名。
  // dsh-client-ui-schedule 的 `height:min(420px,100dvh - 48px)` 是同一
  // 缺陷，一并被覆盖。
  //
  // 两处收紧，避免误伤数据：
  //   1. 只认「数字紧跟 dvh、且后面不是字母数字」的形式（`100dvh`、`100dvh)`、
  //      `100dvh - 32px`），不裸替三个字母 —— base64 里 `dvh` 后面几乎总是
  //      还跟着字母数字，因此不会命中；
  //   2. `url(...)` 片段整段原样保留 —— 内嵌的 data URI（base64）里偶然出现
  //      `dvh` 子串是可能的，替换会改坏图片。已实测当前 7 个含 dvh 的插件
  //      文件里都没有 data URI，但观察器会处理页面后续插入的任意 <style>，
  //      不能依赖这个事实永远成立。
  var patchDvhUnits = function (text) {
    return text.replace(
      /url\([^)]*\)|(\d)dvh(?![0-9A-Za-z_])/g,
      function (match, digit) {
        return digit === undefined ? match : digit + 'vh'
      },
    )
  }

  // ── @scope 展开（Chrome 118+）★ 已证实致命项 ────────────────────────
  //
  // 真机事故：侧边栏预览 .xlsx / .csv 时，表格控件（工具栏、公式栏、单元格
  // 网格）全部渲染成竖排单列，像是整张样式表没生效。
  //
  // 根因在 dsh-client-ui-sidebar-documentpreview 的 excel chunk：
  //   const scopedStyles = `@scope ([data-excel-preview]) { ${index_css_default} }`
  //   ...(0, react_jsx_runtime.jsx)("style", { children: scopedStyles })
  // 它把 fortune-sheet 那张 5 万字符的全局样式表整体塞进一个 @scope 块，
  // 好让 `.fortune-*` 这类全局类名只在预览区内生效。`@scope` 需要
  // Chrome 118+，而本机 WebView 是 104，CSS 解析器会把整块丢弃。
  //
  // 真机实测（探针读 style.sheet.cssRules）：
  //   @scope ([data-excel-preview]) { .fortune-container{...} }
  //   → 该 <style> 文本长度 50018，cssRules.length = 0
  //   对照：@media / @supports / @layer 均为 1（探针有效）
  //   同批探测：@container、@starting-style、`:has()` 也都是 0
  //
  // 修法是在样式文本层面把 `@scope (R) { S {…} }` 展开成 `R S {…}`：
  // 语义等价（@scope 只允许后代匹配），不依赖插件内部类名，也不改变
  // 任何声明。展开后文本里不再有 `@scope`，因此第二次调用返回 null，
  // 天然幂等，观察器不会自我循环。
  //
  // 两处收紧：
  //   1. `&` 是 @scope 的根引用，展开成 R 而不是加前缀；
  //   2. 嵌套 at-rule 只对「内部装规则」的那几个（@media/@supports/@layer/
  //      @container）递归，@keyframes/@font-face/@page/@property 原样保留 ——
  //      它们的内部是 `0%`/`from` 之类，加选择器前缀会改坏。
  var matchBrace = function (text, openIndex) {
    var depth = 0
    var i = openIndex
    while (i < text.length) {
      var c = text.charAt(i)
      if (c === '/' && text.charAt(i + 1) === '*') {
        var comment = text.indexOf('*/', i + 2)
        i = comment === -1 ? text.length : comment + 2
        continue
      }
      if (c === '"' || c === "'") {
        var quote = c
        i += 1
        while (i < text.length) {
          var d = text.charAt(i)
          if (d === '\\') { i += 2; continue }
          i += 1
          if (d === quote) break
        }
        continue
      }
      if (c === '{') depth += 1
      else if (c === '}') {
        depth -= 1
        if (depth === 0) return i
      }
      i += 1
    }
    return -1
  }

  // 从 `(` 的下标出发找到配对的 `)`，跳过注释与字符串；找不到返回 -1。
  var matchParen = function (text, openIndex) {
    var depth = 0
    var i = openIndex
    while (i < text.length) {
      var c = text.charAt(i)
      if (c === '/' && text.charAt(i + 1) === '*') {
        var comment = text.indexOf('*/', i + 2)
        i = comment === -1 ? text.length : comment + 2
        continue
      }
      if (c === '"' || c === "'") {
        var quote = c
        i += 1
        while (i < text.length) {
          var d = text.charAt(i)
          if (d === '\\') { i += 2; continue }
          i += 1
          if (d === quote) break
        }
        continue
      }
      if (c === '(') depth += 1
      else if (c === ')') {
        depth -= 1
        if (depth === 0) return i
      }
      i += 1
    }
    return -1
  }

  // `@scope ([data-x]) to ([data-y])` → `[data-x]`；空 prelude → ''（不加前缀）。
  var scopeRootOf = function (prelude) {
    var text = prelude.trim()
    if (text === '') return ''
    var to = text.search(/\bto\b/i)
    if (to !== -1) text = text.slice(0, to).trim()
    if (text.charAt(0) === '(' && text.charAt(text.length - 1) === ')') {
      var inner = text.slice(1, -1)
      var depth = 0
      var balanced = true
      for (var i = 0; i < inner.length; i++) {
        var c = inner.charAt(i)
        if (c === '(') depth += 1
        else if (c === ')') {
          if (depth === 0) { balanced = false; break }
          depth -= 1
        }
      }
      if (balanced && depth === 0) text = inner
    }
    return text.trim()
  }

  var scopeSelector = function (root, selector) {
    if (root === '' || root === ':scope') return selector
    var parts = selector.split(',')
    var out = []
    for (var i = 0; i < parts.length; i++) {
      var one = parts[i].trim()
      if (one === '') continue
      if (one.indexOf('&') !== -1) out.push(one.split('&').join(root))
      else out.push(root + ' ' + one)
    }
    return out.length === 0 ? selector : out.join(', ')
  }

  var RECURSIVE_AT_RULES = {
    '@media': true,
    '@supports': true,
    '@layer': true,
    '@container': true,
  }

  var expandScopeBody = function (body, root) {
    var out = ''
    var cursor = 0
    var n = body.length
    while (cursor < n) {
      var c = body.charAt(cursor)
      if (/\s/.test(c)) { out += c; cursor += 1; continue }
      if (c === '/' && body.charAt(cursor + 1) === '*') {
        var comment = body.indexOf('*/', cursor + 2)
        out += body.slice(cursor, comment === -1 ? n : comment + 2)
        cursor = comment === -1 ? n : comment + 2
        continue
      }
      // 读 prelude 到 `{`（跳过字符串与注释里的花括号）
      var open = -1
      var j = cursor
      while (j < n) {
        var p = body.charAt(j)
        if (p === '/' && body.charAt(j + 1) === '*') {
          var skip = body.indexOf('*/', j + 2)
          j = skip === -1 ? n : skip + 2
          continue
        }
        if (p === '"' || p === "'") {
          var q = p
          j += 1
          while (j < n) {
            var d = body.charAt(j)
            if (d === '\\') { j += 2; continue }
            j += 1
            if (d === q) break
          }
          continue
        }
        if (p === '{') { open = j; break }
        if (p === ';') break
        j += 1
      }
      if (open === -1) { out += body.slice(cursor); break }
      var close = matchBrace(body, open)
      if (close === -1) { out += body.slice(cursor); break }
      // prelude 与 `{` 之间的空白原样保留，让展开后的文本对输入更忠实
      // （真实插件 CSS 是压缩过的，没有这类空白，展开结果与原文等长）。
      var rawPrelude = body.slice(cursor, open)
      var prelude = rawPrelude.trim()
      var gap = rawPrelude.slice(prelude.length)
      var inner = body.slice(open + 1, close)
      if (prelude.charAt(0) === '@') {
        var head = prelude.split(/[\s({]/)[0].toLowerCase()
        out += prelude + gap + '{' +
          (RECURSIVE_AT_RULES[head] === true ? expandScopeBody(inner, root) : inner) +
          '}'
      } else {
        out += scopeSelector(root, prelude) + gap + '{' + inner + '}'
      }
      cursor = close + 1
    }
    return out
  }

  // 判断 at 处是否落在注释里（`/*` 未闭合）。compat.js 自己的注释就写着
  // `@scope`，虽然本补丁只作用于页面 <style> 文本，仍然守住这条。
  var insideComment = function (text, at) {
    var open = text.lastIndexOf('/*', at)
    if (open === -1) return false
    var close = text.lastIndexOf('*/', at)
    return close < open
  }

  var expandScopeBlocks = function (text) {
    var out = ''
    var cursor = 0
    var n = text.length
    while (cursor < n) {
      var at = text.indexOf('@scope', cursor)
      if (at === -1) { out += text.slice(cursor); break }
      var prev = at === 0 ? '' : text.charAt(at - 1)
      if (/[A-Za-z0-9_-]/.test(prev) || insideComment(text, at)) {
        out += text.slice(cursor, at + 6)
        cursor = at + 6
        continue
      }
      var open = text.indexOf('{', at)
      if (open === -1) { out += text.slice(cursor); break }
      var close = matchBrace(text, open)
      if (close === -1) { out += text.slice(cursor); break }
      out += text.slice(cursor, at)
      out += expandScopeBody(text.slice(open + 1, close).trim(), scopeRootOf(text.slice(at + 6, open)))
      cursor = close + 1
    }
    return out
  }

  // ── `@container` → `@media` 垫片（Chrome 105+）★ 已证实致命项 ───────
  //
  // 真机事故（2026-10-23，用户三张截图）：会话页右上角「标准模式」「N 个
  // 后台任务」「N 个子智能体」互相压字，标题被挤到只剩两个字。
  //
  // 根因在 `dsh-client-ui-agent-preset` 自己的样式表里：
  //     .f8BMvq_label{ …max-width:180px; white-space:nowrap; overflow:hidden… }
  //     @container (width<=540px){ .f8BMvq_label{ display:none } }
  // 上游的意思很明确 —— 窄于 540px 就把「标准模式」整个藏掉。但 `@container`
  // 是 Chrome 105+ 才有的（本机 WebView 104），CSS 解析器把整块丢弃，于是
  // 本该隐藏的芯片反而常显，和右边两个可点的芯片抢同一行宽度。
  //
  // 同一次探测里 `@scope` / `:has()` / `@starting-style` / `@container` 的
  // cssRules.length 全是 0（见上文两处记录）。前两个已经垫过，`@container`
  // 是唯一被漏掉的 —— 而 dsh-web-mobile 3.1.0 整族窄屏折叠都建在它上面。
  //
  // 修法：把 `@container [<name>] (<cond>) { R }` 在文本层改写成
  // `@media (<cond>) { R }`。`@media` 与 `@container` 的 range 语法完全一致，
  // 条件可以逐字搬。
  //
  // 四条收紧（都是「宁可放过」的取舍）：
  //   1. **带容器名的查询不翻**。`@container card (width > 400px)` 问的是
  //      某个命名盒子的宽度，`@media` 问的是视口 —— 猜错比不翻更糟。宁可
  //      维持现状（反正现在也是整块丢弃），等 WebView 升级后它自己会生效。
  //   2. `style()` / `scroll-state()` 查询不翻：这两个在 `@media` 里没有对应
  //      物，硬翻会变成恒真。
  //   3. `not (...)` 开头的条件不翻。Media Queries Level 4 里 `not` 只能修饰
  //      整个 media query、不能修饰单个条件，直接搬会静默失效。
  //   4. `inline-size` / `block-size` 换成 `width` / `height`（横排书写模式下
  //      两者等价），但转完若条件里一个宽度/高度都不用，仍然不翻。
  //
  // 精度说明：`@media` 量视口、`@container` 量容器。本项目的会话头部、
  // 侧栏、composer 容器宽度都等于视口宽度，误差为零；只有「窄容器里的卡片」
  // 会被提前折叠 —— 这是可接受的偏差，也是这条垫片唯一的失真来源。
  //
  // 幂等：翻成功的输出里不再有 `@container`；翻不了时**逐字保留原文**
  // （不是重建字符串），否则文本不变也会被判定为「改过了」，让
  // MutationObserver 自激。这一条是这类垫片最容易写错的地方。
  var CONTAINER_OPAQUE = /(^|[^\w-])(style|scroll-state)\s*\(/

  var containerPreludeToMedia = function (prelude) {
    var rest = prelude.replace(/\s+/g, ' ').trim()
    if (rest === '') return null
    // 命名容器：`<name> (<cond>)` 或 `<name> not (<cond>)`。
    // 判据是「第一个字符不是左括号」—— 条件本身一定以 `(` 或 `not` 开头。
    if (rest.charAt(0) !== '(') {
      if (!/^not\s*\(/.test(rest)) return null
    }
    if (/^not\s*\(/.test(rest)) return null
    if (CONTAINER_OPAQUE.test(rest)) return null
    var media = rest
      .replace(/\binline-size\b/g, 'width')
      .replace(/\bblock-size\b/g, 'height')
    // 范围语法 → min/max 语法。
    //
    // `@container (width<=540px)` 里的 `<=` 是 Media Queries Level 4 的**范围
    // 语法**。原样搬进 `@media (width<=540px)` 虽然「语法合法」，但它落在
    // Chrome 104 的支持边界上 —— 而设备就是 104。既然要搬，就落到最保守的
    // 写法：`(max-width: 540px)` 从 Chrome 1 起就能用，少一个「合法但浏览器
    // 不认」的失败面。
    //
    // `<` 与 `<=` 都落到 `max-width`（`>` / `>=` 落到 `min-width`）：差一个
    // 像素没有实际意义，而 `calc(N - 0.02px)` 这种精确写法在低版本 WebView 上
    // 反而多一个不确定项。
    media = media.replace(
      /\(\s*(width|height)\s*(<=|>=|<|>)\s*([0-9.]+(?:px|em|rem|ch|vw|vh|vmin|vmax|%))\s*\)/gi,
      function (whole, dim, op, value) {
        var upper = op === '<=' || op === '<'
        return '(' + (upper ? 'max-' : 'min-') + dim.toLowerCase() + ': ' + value + ')'
      },
    )
    // 转完必须真的提到宽度或高度；否则说明这是个我们读不懂的条件，
    // 搬进 @media 只会变成恒真或恒假。三种写法都要认：
    //   `(max-width: 540px)`  `(min-width: 400px)`  `(height >= 500px)`
    // 注意不能只写 `\bwidth\b`：`min-width` 里 `width` 前面是连字符，
    // `\b` 边界在 `-w` 之间成立但 `[^\w-]` 这种前置守卫会把整条否掉。
    if (!/((min|max)-)?(width|height)\s*[<>=:]/.test(media)) {
      return null
    }
    return media
  }

  var containerRewriteCss = function (text) {
    var out = ''
    var cursor = 0
    var n = text.length
    while (cursor < n) {
      var at = text.indexOf('@container', cursor)
      if (at === -1) { out += text.slice(cursor); break }
      var prev = at === 0 ? '' : text.charAt(at - 1)
      if (/[A-Za-z0-9_-]/.test(prev) || insideComment(text, at)) {
        out += text.slice(cursor, at + 10)
        cursor = at + 10
        continue
      }
      var open = text.indexOf('{', at)
      if (open === -1) { out += text.slice(cursor); break }
      var close = matchBrace(text, open)
      if (close === -1) { out += text.slice(cursor); break }

      out += text.slice(cursor, at)

      var prelude = text.slice(at + 10, open).trim()
      var body = text.slice(open + 1, close)
      var media = containerPreludeToMedia(prelude)

      if (media === null) {
        var innerKept = containerRewriteCss(body)
        out += innerKept === body
          ? text.slice(at, close + 1)
          : '@container ' + prelude + ' {' + innerKept + '}'
      } else {
        out += '@media ' + media + ' {' + containerRewriteCss(body) + '}'
      }
      cursor = close + 1
    }
    return out
  }

  // ── `:has()` 运行时垫片（Chrome 105+）★ 已证实致命项 ────────────────
  //
  // 真机事故：内置的移动端插件 dsh-web-mobile 整族窄屏适配规则失效 —— 设置
  // 面板仍是桌面两栏布局（「权限」「语言」「字号大小」被挤成一字一行）。
  //
  // 根因：该插件的「设置面板」规则族全部挂在结构门控上：
  //     [aria-modal="true"]:has(> :first-child > :last-child > button):not(...)
  // 而本机 WebView 104 不认识 `:has()`（Chrome 105 才有）。CSS 解析器遇到
  // 无法解析的选择器会**丢弃整条规则**（选择器列表里有一条非法就整条作废），
  // 于是这些规则连同上百条同类规则一起从 CSSOM 里消失。
  //
  // 真机探针（compat.js 尾部追加 IIFE，读 logcat）：
  //     CSS.supports('selector(:has(a))')            → false
  //     插件那张 278723 字符的 <style>：文本里 `:has(` 出现 301 次，
  //       而 CSSOM 里 selectorText 含 `:has(` 的规则 **0 条**
  //     对照：`:is()` / `:where()` / `:scope` 的 supports 均为 true
  //
  // 修法：把 `:has(X)` 在**文本层**改写成标记属性选择器
  //     `[data-kxxy-has~="hN"]`
  // 再用一个 MutationObserver 在真实 DOM 上维护这个标记：元素满足 `:has(X)`
  // 就带上 hN，不再满足就摘掉。属性选择器 104 完全支持，于是规则重新生效。
  //
  // 三条正确性依据：
  //   1. 后代前导（`E:has(A B)`）⇔ 「E 是某个匹配 `A B` 的元素的祖先」。由
  //      `querySelectorAll('A B')` 的命中集合向上收集全部祖先即**精确**得到。
  //   2. 子代前导（`E:has(> A B)`）⇔ 「E 是某个匹配 `A B` 的元素的祖先」是超集，
  //      再用 `E.querySelector(':scope > A B')` 精确验证。
  //   3. `:not(:has(X))` 必须精确：多标一个元素就会误排除。所以一律再用
  //      `E.matches(主体复合选择器)` 过滤，让标记集合恰好等于「既是该复合
  //      选择器的候选、又满足 X」。
  //
  // 特异性：`:has(X)` 对特异性的贡献等于 X 里最具体那个复合选择器。改写后若
  // 只放一个属性选择器会掉 1 个「类级」单位，可能在插件自己的 `!important`
  // 竞争里翻盘。所以按 X 的类级单位数把标记选择器**重复**若干次补齐权重。
  //
  // 幂等：改写后文本里不再有 `:has(`，第二次调用返回 null；标记只在值变化时
  // 才写，且观察器忽略 `data-kxxy-has` 自身的属性变更，不会自激。
  var HAS_ATTR = 'data-kxxy-has'
  var hasEntries = []
  var hasById = {}
  var hasByKey = {}
  var hasNextId = 0
  var hasTimer = null

  // 跳过一段引号字符串，返回闭引号之后的下标
  var hasSkipString = function (text, i) {
    var quote = text.charAt(i)
    var n = text.length
    i += 1
    while (i < n) {
      var d = text.charAt(i)
      if (d === '\\') { i += 2; continue }
      i += 1
      if (d === quote) break
    }
    return i
  }

  // 顶层逗号切分（尊重 () / [] 与字符串）
  var hasSplitCommas = function (text) {
    var out = []
    var depth = 0
    var start = 0
    var i = 0
    var n = text.length
    while (i < n) {
      var c = text.charAt(i)
      if (c === '"' || c === "'") { i = hasSkipString(text, i); continue }
      if (c === '[' || c === '(') depth += 1
      else if (c === ']' || c === ')') depth -= 1
      else if (c === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1 }
      i += 1
    }
    out.push(text.slice(start))
    return out
  }

  // 该选择器段是否含顶层组合符（后代空格 / > / + / ~）
  var hasTopLevelCombinator = function (sel) {
    var depth = 0
    var i = 0
    var n = sel.length
    while (i < n) {
      var c = sel.charAt(i)
      if (c === '"' || c === "'") { i = hasSkipString(sel, i); continue }
      if (c === '[' || c === '(') { depth += 1; i += 1; continue }
      if (c === ']' || c === ')') { depth -= 1; i += 1; continue }
      if (depth === 0 && (c === '>' || c === '+' || c === '~' || /\s/.test(c))) return true
      i += 1
    }
    return false
  }

  // 从 `at` 向前回溯到当前复合选择器的起点（`at` 是伪类的冒号位置）
  var hasCompoundStart = function (sel, at) {
    var depth = 0
    var i = at - 1
    while (i >= 0) {
      var c = sel.charAt(i)
      if (c === ']' || c === ')') { depth += 1; i -= 1; continue }
      if (c === '[' || c === '(') {
        if (depth === 0) break
        depth -= 1
        i -= 1
        continue
      }
      if (depth > 0) { i -= 1; continue }
      if (c === '>' || c === '+' || c === '~' || c === ',' || /\s/.test(c)) break
      i -= 1
    }
    return i + 1
  }

  // 把复合选择器里的 `:has(...)` 段落整段剥掉，剩下的就是「主体选择器」
  // （用于 matches() 过滤）。`:not(:has(X))` 连 `:not()` 一起剥。
  var hasStripHas = function (text) {
    var out = text
    for (var guard = 0; guard < 64; guard++) {
      var at = out.indexOf(':has(')
      if (at === -1) break
      var close = matchParen(out, at + 4)
      if (close === -1) break
      var start = at
      if (at >= 5 && out.slice(at - 5, at) === ':not(') {
        var notClose = matchParen(out, at - 1)
        if (notClose !== -1) { start = at - 5; close = notClose }
      }
      out = out.slice(0, start) + out.slice(close + 1)
    }
    return out.trim()
  }

  // 估算一段选择器对特异性的「类级」贡献（属性 / 类 / id / 伪类各算 1）。
  // `:where()` 恒为 0，`:not()` / `:is()` / `:has()` 取内部最大值（这里用累加
  // 近似，足以覆盖插件用到的形态）。
  var hasClassUnits = function (sel) {
    var best = 0
    var parts = hasSplitCommas(sel)
    for (var p = 0; p < parts.length; p++) {
      var s = parts[p]
      var units = 0
      var i = 0
      var n = s.length
      while (i < n) {
        var c = s.charAt(i)
        if (c === '"' || c === "'") { i = hasSkipString(s, i); continue }
        if (c === '[') {
          units += 1
          i += 1
          while (i < n) {
            var bc = s.charAt(i)
            if (bc === '"' || bc === "'") { i = hasSkipString(s, i); continue }
            i += 1
            if (bc === ']') break
          }
          continue
        }
        if (c === '.' || c === '#') {
          units += 1
          i += 1
          while (i < n && /[A-Za-z0-9_\\-]/.test(s.charAt(i))) i += 1
          continue
        }
        if (c === ':') {
          if (s.charAt(i + 1) === ':') {
            i += 2
            while (i < n && /[A-Za-z0-9_-]/.test(s.charAt(i))) i += 1
            continue
          }
          var j = i + 1
          while (j < n && /[A-Za-z0-9_-]/.test(s.charAt(j))) j += 1
          var name = s.slice(i + 1, j).toLowerCase()
          if (s.charAt(j) === '(') {
            var close = matchParen(s, j)
            if (close === -1) { i = n; continue }
            if (name === 'where') {
              // 恒为 0
            } else if (name === 'not' || name === 'is' || name === 'has' || name === 'matches' || name === 'any') {
              units += hasClassUnits(s.slice(j + 1, close))
            } else {
              units += 1
            }
            i = close + 1
            continue
          }
          units += 1
          i = j
          continue
        }
        i += 1
      }
      if (units > best) best = units
    }
    return best
  }

  // 登记一条 `:has()` 条件，返回稳定 id（同一「主体 + 参数」复用同一个 id）
  var hasRegister = function (subjectRaw, arg) {
    var subject = hasStripHas(subjectRaw)
    if (subject === '') subject = '*'
    var key = subject + '\u0000' + arg
    if (Object.prototype.hasOwnProperty.call(hasByKey, key)) return hasByKey[key]
    var id = 'h' + hasNextId
    hasNextId += 1
    var repeat = hasClassUnits(arg)
    if (repeat < 1) repeat = 1
    if (repeat > 4) repeat = 4
    var marker = '[' + HAS_ATTR + '~="' + id + '"]'
    var padded = ''
    for (var r = 0; r < repeat; r++) padded += marker
    var entry = { id: id, subject: subject, arg: arg, marker: padded }
    hasByKey[key] = id
    hasById[id] = entry
    hasEntries.push(entry)
    hasSchedule()
    return id
  }

  // 改写单个复杂选择器；无 `:has(` 或未发生变化时返回 null
  var hasRewriteSelector = function (sel) {
    if (sel.indexOf(':has(') === -1) return null
    var out = ''
    var i = 0
    var n = sel.length
    var changed = false
    while (i < n) {
      var c = sel.charAt(i)
      if (c === '"' || c === "'") {
        var e0 = hasSkipString(sel, i)
        out += sel.slice(i, e0)
        i = e0
        continue
      }
      if (c === '[') {
        var b = i + 1
        while (b < n) {
          var bc = sel.charAt(b)
          if (bc === '"' || bc === "'") { b = hasSkipString(sel, b); continue }
          b += 1
          if (bc === ']') break
        }
        out += sel.slice(i, b)
        i = b
        continue
      }
      if (c === ':') {
        var j = i + 1
        while (j < n && /[A-Za-z0-9_-]/.test(sel.charAt(j))) j += 1
        var name = sel.slice(i + 1, j).toLowerCase()
        if (sel.charAt(j) === '(') {
          var close = matchParen(sel, j)
          if (close === -1) { out += sel.slice(i); break }
          var content = sel.slice(j + 1, close)
          if (name === 'has') {
            var id = hasRegister(sel.slice(hasCompoundStart(sel, i), i), content)
            out += hasById[id].marker
            changed = true
            i = close + 1
            continue
          }
          var trimmed = content.trim()
          if (name === 'not' && trimmed.slice(0, 5) === ':has(' &&
              matchParen(trimmed, 4) === trimmed.length - 1) {
            var id2 = hasRegister(sel.slice(hasCompoundStart(sel, i), i), trimmed.slice(5, -1))
            out += ':not(' + hasById[id2].marker + ')'
            changed = true
            i = close + 1
            continue
          }
          if (name === 'not' || name === 'is' || name === 'where' ||
              name === 'matches' || name === 'any') {
            var fixed = hasRewriteSelector(content)
            if (fixed === null) out += sel.slice(i, close + 1)
            else { out += ':' + name + '(' + fixed + ')'; changed = true }
            i = close + 1
            continue
          }
          out += sel.slice(i, close + 1)
          i = close + 1
          continue
        }
        out += sel.slice(i, j)
        i = j
        continue
      }
      out += c
      i += 1
    }
    return changed ? out : null
  }

  // 改写一条规则的选择器列表（逗号分隔，逐段改写后原样拼回）
  var hasRewriteSelectorList = function (text) {
    var parts = hasSplitCommas(text)
    if (parts.length === 1) return hasRewriteSelector(text)
    var out = ''
    var changed = false
    for (var p = 0; p < parts.length; p++) {
      if (p > 0) out += ','
      var fixed = hasRewriteSelector(parts[p])
      if (fixed === null) out += parts[p]
      else { out += fixed; changed = true }
    }
    return changed ? out : null
  }

  // 走一遍 CSS 文本，只在「选择器 prelude」上改写（递归进 @media/@supports/
  // @layer/@container，@keyframes/@font-face 内部原样保留）
  var hasRewriteCss = function (text) {
    var out = ''
    var cursor = 0
    var n = text.length
    var changed = false
    while (cursor < n) {
      var c = text.charAt(cursor)
      if (/\s/.test(c)) { out += c; cursor += 1; continue }
      if (c === '/' && text.charAt(cursor + 1) === '*') {
        var comment = text.indexOf('*/', cursor + 2)
        out += text.slice(cursor, comment === -1 ? n : comment + 2)
        cursor = comment === -1 ? n : comment + 2
        continue
      }
      var open = -1
      var semi = -1
      var j = cursor
      while (j < n) {
        var p = text.charAt(j)
        if (p === '/' && text.charAt(j + 1) === '*') {
          var skip = text.indexOf('*/', j + 2)
          j = skip === -1 ? n : skip + 2
          continue
        }
        if (p === '"' || p === "'") { j = hasSkipString(text, j); continue }
        if (p === '{') { open = j; break }
        if (p === ';') { semi = j; break }
        j += 1
      }
      if (semi !== -1 && (open === -1 || semi < open)) {
        out += text.slice(cursor, semi + 1)
        cursor = semi + 1
        continue
      }
      if (open === -1) { out += text.slice(cursor); break }
      var close = matchBrace(text, open)
      if (close === -1) { out += text.slice(cursor); break }
      var prelude = text.slice(cursor, open)
      var inner = text.slice(open + 1, close)
      if (prelude.charAt(0) === '@') {
        var head = prelude.split(/[\s({]/)[0].toLowerCase()
        if (RECURSIVE_AT_RULES[head] === true) {
          var fixedInner = hasRewriteCss(inner)
          if (fixedInner !== null) { out += prelude + '{' + fixedInner + '}'; changed = true }
          else out += prelude + '{' + inner + '}'
        } else {
          out += prelude + '{' + inner + '}'
        }
      } else {
        var fixedSel = hasRewriteSelectorList(prelude)
        if (fixedSel !== null) { out += fixedSel + '{' + inner + '}'; changed = true }
        else out += prelude + '{' + inner + '}'
      }
      cursor = close + 1
    }
    return changed ? out : null
  }

  // 元素是否匹配登记时记下的「主体复合选择器」
  var hasSubjectMatch = function (el, subject) {
    if (subject === '*') return true
    try { return el.matches(subject) } catch (error) { return true }
  }

  var hasDescendantMatch = function (el, sel) {
    try { return el.querySelector(sel) !== null } catch (error) { return false }
  }

  var hasChildMatch = function (el, sel) {
    try { return el.querySelector(':scope ' + sel) !== null } catch (error) { return false }
  }

  // 求出当前 DOM 上满足该 `:has()` 条件、且是主体候选的全部元素
  var hasCollect = function (entry) {
    var hits = []
    var seen = new Set()
    var addHit = function (el) {
      if (el === null || el === undefined) return
      if (seen.has(el)) return
      if (!hasSubjectMatch(el, entry.subject)) return
      seen.add(el)
      hits.push(el)
    }
    var parts = hasSplitCommas(entry.arg)
    for (var p = 0; p < parts.length; p++) {
      var s = parts[p].trim()
      if (s === '') continue
      var head = s.charAt(0)
      if (head === '+' || head === '~') {
        var rest = s.slice(1).trim()
        var siblings = null
        try { siblings = document.querySelectorAll(rest) } catch (error) { continue }
        for (var a = 0; a < siblings.length; a++) {
          if (head === '+') {
            addHit(siblings[a].previousElementSibling)
          } else {
            var q = siblings[a].previousElementSibling
            while (q) { addHit(q); q = q.previousElementSibling }
          }
        }
        continue
      }
      var stripped = head === '>' ? s.slice(1).trim() : s
      var list = null
      try { list = document.querySelectorAll(stripped) } catch (error) { continue }
      // 后代前导且段内无组合符时，「命中元素的全部祖先」就是精确解，无需再验证
      var exact = head !== '>' && !hasTopLevelCombinator(s)
      var tried = new Set()
      for (var b = 0; b < list.length; b++) {
        var anc = list[b].parentElement
        while (anc) {
          if (!tried.has(anc)) {
            tried.add(anc)
            if (exact) addHit(anc)
            else if (head === '>' ? hasChildMatch(anc, s) : hasDescendantMatch(anc, s)) addHit(anc)
          }
          anc = anc.parentElement
        }
      }
    }
    return hits
  }

  var hasToggle = function (el, id, on) {
    var raw = el.getAttribute(HAS_ATTR)
    if (raw === null) raw = ''
    var list = raw === '' ? [] : raw.split(/\s+/)
    var at = list.indexOf(id)
    if (on) {
      if (at !== -1) return
      list.push(id)
      el.setAttribute(HAS_ATTR, list.join(' '))
      return
    }
    if (at === -1) return
    list.splice(at, 1)
    if (list.length === 0) el.removeAttribute(HAS_ATTR)
    else el.setAttribute(HAS_ATTR, list.join(' '))
  }

  var hasApply = function () {
    if (hasEntries.length === 0) return
    if (!document.body) { hasSchedule(); return }
    for (var i = 0; i < hasEntries.length; i++) {
      var entry = hasEntries[i]
      var hits = hasCollect(entry)
      var keep = new Set()
      for (var k = 0; k < hits.length; k++) keep.add(hits[k])
      var marked = null
      try {
        marked = document.querySelectorAll('[' + HAS_ATTR + '~="' + entry.id + '"]')
      } catch (error) {
        marked = null
      }
      if (marked) {
        for (var m = 0; m < marked.length; m++) {
          if (!keep.has(marked[m])) hasToggle(marked[m], entry.id, false)
        }
      }
      for (var k2 = 0; k2 < hits.length; k2++) hasToggle(hits[k2], entry.id, true)
    }
  }

  var hasSchedule = function () {
    if (hasTimer !== null) return
    hasTimer = setTimeout(function () {
      hasTimer = null
      try { hasApply() } catch (error) {}
    }, 60)
  }

  // 标记写入本身也是属性变更，必须按 attributeName 过滤掉，否则自激
  var hasObserve = function () {
    if (typeof MutationObserver !== 'function') return
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var record = records[i]
        if (record.type === 'attributes' && record.attributeName === HAS_ATTR) continue
        hasSchedule()
        return
      }
    })
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
    })
  }

  // ---- 缺陷 AC：插件选择器里宿主 class hash 的代际归一化 ---------------------
  // 插件是按宿主「某一代」构建的：它的选择器里写死了那一代的 CSS-module hash
  // 前缀（`wSkVaW_titleRow`）。宿主升级后 hash 换代（真机实测宿主为
  // `Dc7zOa_titleRow`），这些规则在页面上永远命中不到 —— 真机取证：插件那张
  // 样式表 451 条规则里 330 条的 selectorText 在 DOM 上零命中，其中就包括
  // 「隐藏标题行里的 headerCorner」那条，症状正是对话界面右上角多出一个侧栏
  // 图标（与插件自己的文件按钮重叠）。
  //
  // 做法：① 从插件样式表里收集每个 hash 的「后缀集合」；② 扫页面上真实存在的
  // hash 前缀，得到它们的后缀集合；③ 只有「后缀集合被完整包含」且候选前缀
  // 唯一时才建立映射，绝不猜。宿主 DOM 是渐进渲染的（hero 相位没有 header），
  // 所以必须反复重算，直到映射稳定或重试次数用尽。
  var hashMap = {}
  var hashTimer = null
  var hashRuns = 0
  var HASH_CLASS = /^([A-Za-z0-9]{6,8})_([A-Za-z0-9_]+)$/

  var hashScan = function (text) {
    var out = {}
    var re = /\[class\*="([A-Za-z0-9]{6,8})_([A-Za-z0-9_]+)"\]|\.([A-Za-z0-9]{6,8})_([A-Za-z0-9_]+)(?![A-Za-z0-9_-])/g
    var m = re.exec(text)
    while (m !== null) {
      var head = m[1] || m[3]
      var tail = m[2] || m[4]
      if (head && tail) {
        if (!out[head]) out[head] = {}
        out[head][tail] = 1
      }
      m = re.exec(text)
    }
    return out
  }

  var hashLivePrefixes = function () {
    var out = {}
    var add = function (raw) {
      var parts = raw.split(/\s+/)
      for (var j = 0; j < parts.length; j++) {
        var m = HASH_CLASS.exec(parts[j])
        if (m === null) continue
        if (!out[m[1]]) out[m[1]] = {}
        out[m[1]][m[2]] = 1
      }
    }
    // 宿主自己的样式表带完整类名清单（比当前 DOM 全，DOM 只有已渲染的那部分）。
    var tags = document.querySelectorAll('style[data-plugin]')
    for (var i = 0; i < tags.length; i++) {
      var owner = tags[i].getAttribute('data-plugin') || ''
      if (owner.indexOf('@deepseek-ai/') !== 0) continue
      var found = hashScan(tags[i].textContent || '')
      var heads = Object.keys(found)
      for (var h = 0; h < heads.length; h++) {
        if (!out[heads[h]]) out[heads[h]] = {}
        var tails = Object.keys(found[heads[h]])
        for (var t = 0; t < tails.length; t++) out[heads[h]][tails[t]] = 1
      }
    }
    add(document.documentElement.className || '')
    var nodes = document.querySelectorAll('[class]')
    for (var k = 0; k < nodes.length; k++) add(nodes[k].getAttribute('class') || '')
    return out
  }

  var hashRewrite = function (text) {
    var keys = Object.keys(hashMap)
    if (keys.length === 0) return null
    var next = text
    for (var i = 0; i < keys.length; i++) {
      var old = keys[i]
      var fresh = hashMap[old]
      if (next.indexOf(old + '_') === -1) continue
      next = next.split('[class*="' + old + '_').join('[class*="' + fresh + '_')
      next = next.split('.' + old + '_').join('.' + fresh + '_')
    }
    return next === text ? null : next
  }

  var hashRefresh = function () {
    // 只有第三方插件带 hash 锚点（宿主自己的样式表就是当前代，不需要映射）。
    var tags = document.querySelectorAll('style[data-plugin]')
    var used = {}
    for (var i = 0; i < tags.length; i++) {
      var owner = tags[i].getAttribute('data-plugin') || ''
      if (owner.indexOf('@deepseek-ai/') === 0) continue
      var found = hashScan(tags[i].textContent || '')
      var heads = Object.keys(found)
      for (var j = 0; j < heads.length; j++) {
        if (!used[heads[j]]) used[heads[j]] = {}
        var tails = Object.keys(found[heads[j]])
        for (var k = 0; k < tails.length; k++) used[heads[j]][tails[k]] = 1
      }
    }
    var live = hashLivePrefixes()
    var liveHeads = Object.keys(live)
    var added = false
    var heads = Object.keys(used)
    for (var a = 0; a < heads.length; a++) {
      var old = heads[a]
      if (live[old] || hashMap[old]) continue
      var want = Object.keys(used[old])
      var match = null
      var ambiguous = false
      for (var b = 0; b < liveHeads.length; b++) {
        var fresh = liveHeads[b]
        if (fresh === old || used[fresh]) continue
        var ok = true
        for (var c = 0; c < want.length; c++) {
          if (!live[fresh][want[c]]) { ok = false; break }
        }
        if (!ok) continue
        if (match === null) match = fresh
        else { ambiguous = true; break }
      }
      if (match !== null && !ambiguous) {
        hashMap[old] = match
        added = true
      }
    }
    if (added) patchAllStyles()
  }

  var hashObserve = function () {
    if (typeof MutationObserver !== 'function') return
    var observer = new MutationObserver(function () {
      if (hashTimer !== null || hashRuns >= 40) return
      hashTimer = setTimeout(function () {
        hashTimer = null
        hashRuns += 1
        try { hashRefresh() } catch (error) { hashRuns = 40 }
      }, 300)
    })
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
    })
    try { hashRefresh() } catch (error) { hashRuns = 40 }
  }

  var patchCssText = function (text) {
    if (typeof text !== 'string') return null
    var next = text
    if (next.indexOf('_') !== -1) {
      var fixedHash = hashRewrite(next)
      if (fixedHash !== null) next = fixedHash
    }
    if (next.indexOf('dvh') !== -1) next = patchDvhUnits(next)
    if (next.indexOf('@scope') !== -1) next = expandScopeBlocks(next)
    // `@container` 必须在 `:has()` 之前：容器查询块里常带 `:has()`，
    // 先搬成 `@media` 能少改一遍选择器文本（改得越少越不容易出岔）。
    if (next.indexOf('@container') !== -1) next = containerRewriteCss(next)
    if (next.indexOf(':has(') !== -1) {
      var fixedHas = hasRewriteCss(next)
      if (fixedHas !== null) next = fixedHas
    }
    return next === text ? null : next
  }

  // 任何一条样式表改写失败都不能拖垮整层适配：出错就保留原文，继续处理下一张。
  var patchStyleTag = function (tag) {
    var fixed = null
    try {
      fixed = patchCssText(tag.textContent)
    } catch (error) {
      return
    }
    if (fixed !== null) tag.textContent = fixed
  }

  var patchAllStyles = function () {
    var tags = document.querySelectorAll('style')
    for (var i = 0; i < tags.length; i++) patchStyleTag(tags[i])
  }

  // 插件 CSS 是各插件模块求值时才 append 到 head 的，晚于本脚本，所以必须
  // 观察后续插入，不能只在注入时扫一遍。回调里改写 textContent 会再触发一次
  // mutation，但那时已无 `dvh`，patchCssText 返回 null，不会自我循环。
  var observeStyles = function () {
    patchAllStyles()
    if (typeof MutationObserver !== 'function') return
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes
        for (var j = 0; j < added.length; j++) {
          var node = added[j]
          if (node.nodeType !== 1) continue
          if (node.tagName === 'STYLE') {
            patchStyleTag(node)
          } else if (node.querySelectorAll) {
            var inner = node.querySelectorAll('style')
            for (var k = 0; k < inner.length; k++) patchStyleTag(inner[k])
          }
        }
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  }

  // 注入点在 <head> 开标签之后，documentElement 一定已存在，可立即观察。
  observeStyles()
  hasObserve()
  hashObserve()
})()
