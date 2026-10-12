/* kxxy-webview-compat@2 */
/**
 * dsh-kxxy WebView 兼容层（polyfill + CSS 回退）
 *
 * 版本标记 `kxxy-webview-compat@2`（首行）：RuntimeInstaller 的锚点 6 按这个
 * 字符串判定运行时的兼容层是否过期 —— 只判「文件存在」不足以让老设备在
 * 升级后拿到新版兼容层。改动本文件后必须同步递增编号（连同
 * RuntimeInstaller.COMPAT_LAYER_MARKER），否则旧设备会带着旧兼容层静默跳过重装。
 *
 * 背景：app.kxxy 的 WebView 是 com.google.android.webview 104.0.5112.97
 * （2022-07，Android 系统 WebView 由 ROM 决定，应用无法自带）。官方 DSH
 * 前端插件 bundle 使用了若干 Chrome 108+/116+ 才有的能力，已证实两处致命：
 *
 * 1) `AbortSignal.any`（Chrome 116+）被 `dsh-api-gateway` 的 `pumpEvents`
 *    在代际循环开头调用，缺失时抛 TypeError，被 `ConnectionController.loop()`
 *    静默吞掉，表现为 `[connection] connection lost, retry #N` 无限重试、
 *    `connection.generation` 恒为 undefined，最终：
 *      - 设置 → 通用设置 → 权限：原样渲染英文 `permission catalog has no
 *        active Host connection`
 *      - 设置 → 模型：provider 列表取空，整块空白
 * 2) `dvh` 单位（Chrome 108+）被 CSS 解析器整条丢弃，见文件末尾
 *    `patchCssText` 处的详细说明 —— 表现为目录选择对话框列表整片空白。
 *
 * 本文件必须在任何页面脚本执行之前注入（<head> 内同步 inline script），
 * 在 onPageFinished 阶段注入已经太晚——连接循环一旦以失败代际启动，
 * 补回 API 也不会让重试计数立即归零。
 *
 * 幂等：API 补丁全部用 `typeof x !== 'function'` 守卫，已支持的环境原样
 * 跳过；只补「缺失」不覆盖「已有」，避免改变原生语义。CSS 回退在文本层面
 * 做 `dvh → vh` 替换，替换后不再含 `dvh`，重复执行是无操作。
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
  var patchCssText = function (text) {
    if (typeof text !== 'string' || text.indexOf('dvh') === -1) return null
    var fixed = text.replace(
      /url\([^)]*\)|(\d)dvh(?![0-9A-Za-z_])/g,
      function (match, digit) {
        return digit === undefined ? match : digit + 'vh'
      },
    )
    return fixed === text ? null : fixed
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
