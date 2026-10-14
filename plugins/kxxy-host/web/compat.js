/* kxxy-webview-compat@4 */
/**
 * dsh-kxxy WebView 兼容层（polyfill + CSS 回退 + URL 修正）
 *
 * 版本标记 `kxxy-webview-compat@4`（首行）：RuntimeInstaller 的锚点 6 按这个
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

  var patchCssText = function (text) {
    if (typeof text !== 'string') return null
    var next = text
    if (next.indexOf('dvh') !== -1) next = patchDvhUnits(next)
    if (next.indexOf('@scope') !== -1) next = expandScopeBlocks(next)
    return next === text ? null : next
  }

  var patchStyleTag = function (tag) {
    var fixed = patchCssText(tag.textContent)
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
})()
