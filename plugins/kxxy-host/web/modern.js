/* kxxy-modern@2 */
/**
 * 现代 JS 内建补齐层 + blob 作用域注入。
 *
 * 为什么与 compat.js 分开：compat.js 解决的是「页面主作用域」的缺口（它的注入点
 * 是 <head> 内联脚本）。本文件解决两件事：
 *
 *   1. 把 DSH 前端用到的、Chrome 105–139 才有的 JS 内建一次性补齐，避免
 *      「修好一个才暴露下一个」——真机实测的暴露顺序是：
 *        `v` 标志正则 SyntaxError（构建期补丁已改写）
 *        → `ReferenceError: Iterator is not defined`（本文件第 1 段）
 *        → 同一条 slot 反复崩溃，所有格式的右侧栏预览一起空白。
 *   2. **把同一份补齐代码注入 blob: 作用域**。这是真机实测的关键结论：
 *      PDF 渲染 worker 与 HTML 预览 iframe 都跑在 `blob:` 地址的**独立全局**里，
 *      `<head>` 注入的 compat.js/modern.js 完全够不到它们。pdf.js 6.3.289 的
 *      worker 源码里有
 *        `"function"!=typeof Iterator.prototype.join && (Iterator.prototype.join=…)`
 *      模块求值第一行就抛 ReferenceError，被 `worker.addEventListener("error", …)`
 *      接住，界面显示「PDF 渲染进程无法继续，请重试」。
 *
 * 注入手法：包装 `URL.createObjectURL`，在**创建 URL 之前**替换 Blob 内容。
 * 之所以在 createObjectURL 而不是 Worker 构造函数上做：`new Worker(url)` 是同步
 * 的，拿到 URL 后无法再把内容读出来；而 `new Blob([前缀字符串, 原 Blob])` 是同步
 * 且廉价的（Blob 的 part 允许是 Blob，不会立即读字节）。
 *
 * 版本标记 `kxxy-modern@1`（首行）：RuntimeInstaller 的锚点按这个字符串判定资产
 * 是否过期。改动本文件后必须同步递增编号。
 *
 * 约束：本文件由宿主内联注入，先于一切页面脚本执行；必须幂等、必须不抛错
 * （任何一处抛错都会让整段失效，而错误只出现在 logcat 里）。
 */
;(function () {
  'use strict'

  var g = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this)
  if (!g) return
  if (g.__kxxyModernInstalled) return
  g.__kxxyModernInstalled = true

  /**
   * 唯一的补齐实现。**必须完全自包含**：它的源码文本会被
   * `Function.prototype.toString()` 取出并注入 worker / iframe 的独立全局，
   * 因此不能引用本文件作用域里的任何变量。
   */
  function kxxyModernInstall(g) {
    function def(obj, key, fn, isGetter) {
      if (!obj) return
      try {
        Object.defineProperty(obj, key, isGetter
          ? { get: fn, enumerable: false, configurable: true }
          : { value: fn, writable: true, enumerable: false, configurable: true })
      } catch (e) { /* ignore */ }
    }

    function defIf(obj, key, fn, isGetter) {
      if (!obj) return
      var has
      try { has = key in obj } catch (e) { has = false }
      if (has) return
      def(obj, key, fn, isGetter)
    }

    function done(v) { return { value: v, done: true } }
    function val(v) { return { value: v, done: false } }

    // ────────────────────────────────────────────────────────────
    // 1. 迭代器 helpers（Chrome 122）+ AsyncIterator helpers（Chrome 124）
    //    pdf.js worker 第一行就要 Iterator.prototype，缺了直接炸。
    // ────────────────────────────────────────────────────────────
    var IteratorPrototype = null
    try { IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())) } catch (e) {}
    var AsyncIteratorPrototype = null
    try {
      AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf((async function* () {})()))
    } catch (e) {}

    function installIteratorHelpers(proto) {
      defIf(proto, Symbol.iterator, function () { return this })

      defIf(proto, 'map', function (fn, thisArg) {
        var self = this
        return makeIterator(function () {
          var r = self.next()
          if (r.done) return r
          return val(fn.call(thisArg, r.value))
        }, function () { return self.return ? self.return() : done() })
      })

      defIf(proto, 'filter', function (fn, thisArg) {
        var self = this
        return makeIterator(function () {
          for (;;) {
            var r = self.next()
            if (r.done) return r
            if (fn.call(thisArg, r.value)) return r
          }
        }, function () { return self.return ? self.return() : done() })
      })

      defIf(proto, 'take', function (limit) {
        var self = this
        var n = Math.max(0, Number(limit) || 0)
        return makeIterator(function () {
          if (n <= 0) { if (self.return) self.return(); return done() }
          n--
          return self.next()
        }, function () { return self.return ? self.return() : done() })
      })

      defIf(proto, 'drop', function (limit) {
        var self = this
        var n = Math.max(0, Number(limit) || 0)
        var dropped = false
        return makeIterator(function () {
          if (!dropped) {
            dropped = true
            while (n-- > 0) { if (self.next().done) return done() }
          }
          return self.next()
        }, function () { return self.return ? self.return() : done() })
      })

      defIf(proto, 'flatMap', function (fn, thisArg) {
        var self = this
        var innerIt = null
        return makeIterator(function () {
          for (;;) {
            if (innerIt) {
              var ir = innerIt.next()
              if (!ir.done) return ir
              innerIt = null
            }
            var r = self.next()
            if (r.done) return r
            var inner = fn.call(thisArg, r.value)
            if (inner != null && typeof inner[Symbol.iterator] === 'function') innerIt = inner[Symbol.iterator]()
          }
        }, function () {
          if (innerIt && innerIt.return) innerIt.return()
          return self.return ? self.return() : done()
        })
      })

      defIf(proto, 'forEach', function (fn, thisArg) {
        var i = 0
        for (;;) {
          var r = this.next()
          if (r.done) return undefined
          fn.call(thisArg, r.value, i++)
        }
      })

      defIf(proto, 'some', function (fn, thisArg) {
        var i = 0
        for (;;) {
          var r = this.next()
          if (r.done) return false
          if (fn.call(thisArg, r.value, i++)) return true
        }
      })

      defIf(proto, 'every', function (fn, thisArg) {
        var i = 0
        for (;;) {
          var r = this.next()
          if (r.done) return true
          if (!fn.call(thisArg, r.value, i++)) return false
        }
      })

      defIf(proto, 'find', function (fn, thisArg) {
        var i = 0
        for (;;) {
          var r = this.next()
          if (r.done) return undefined
          var v = r.value
          if (fn.call(thisArg, v, i++)) return v
        }
      })

      defIf(proto, 'reduce', function (fn) {
        var hasInit = arguments.length > 1
        var acc = hasInit ? arguments[1] : undefined
        var i = 0
        for (;;) {
          var r = this.next()
          if (r.done) {
            if (!hasInit && i === 0) throw new TypeError('Reduce of empty iterator with no initial value')
            return acc
          }
          if (!hasInit && i === 0) acc = r.value
          else acc = fn(acc, r.value, i)
          i++
        }
      })

      defIf(proto, 'toArray', function () {
        var out = []
        for (;;) {
          var r = this.next()
          if (r.done) return out
          out.push(r.value)
        }
      })

      // 真机实测 pdf.js worker 主动定义 join，这里一并给出规范版本，
      // 免得它依赖「Iterator.prototype.join 不存在」这一前提。
      defIf(proto, 'join', function (sep) {
        var out = []
        for (;;) {
          var r = this.next()
          if (r.done) return out.join(sep === undefined ? ',' : sep)
          out.push(r.value)
        }
      })
    }

    /** 造一个符合迭代器协议、原型挂在 %IteratorPrototype% 上的对象。 */
    function makeIterator(next, ret) {
      var o = IteratorPrototype ? Object.create(IteratorPrototype) : {}
      def(o, 'next', next)
      if (ret) def(o, 'return', ret)
      if (!IteratorPrototype) {
        def(o, Symbol.iterator, function () { return this })
        installIteratorHelpers(o)
      }
      return o
    }

    if (IteratorPrototype) installIteratorHelpers(IteratorPrototype)

    defIf(g, 'Iterator', (function () {
      function Iterator() { throw new TypeError('Iterator is not a constructor') }
      Iterator.prototype = IteratorPrototype || {}
      def(Iterator, 'from', function (obj) {
        if (obj == null) throw new TypeError('Iterator.from: argument is not iterable')
        if (typeof obj.next === 'function') return obj
        if (typeof obj[Symbol.iterator] === 'function') return obj[Symbol.iterator]()
        throw new TypeError('Iterator.from: argument is not iterable')
      })
      return Iterator
    })())

    defIf(g, 'AsyncIterator', (function () {
      function AsyncIterator() { throw new TypeError('AsyncIterator is not a constructor') }
      AsyncIterator.prototype = AsyncIteratorPrototype || {}

      function makeAsync(next) {
        var o = AsyncIteratorPrototype ? Object.create(AsyncIteratorPrototype) : {}
        def(o, 'next', next)
        def(o, Symbol.asyncIterator, function () { return this })
        return o
      }

      if (AsyncIteratorPrototype) {
        defIf(AsyncIteratorPrototype, Symbol.asyncIterator, function () { return this })
        defIf(AsyncIteratorPrototype, 'map', function (fn, thisArg) {
          var self = this
          return makeAsync(function () {
            return self.next().then(function (r) {
              return r.done ? r : val(fn.call(thisArg, r.value))
            })
          })
        })
        defIf(AsyncIteratorPrototype, 'filter', function (fn, thisArg) {
          var self = this
          return makeAsync(function step() {
            return self.next().then(function (r) {
              if (r.done) return r
              return fn.call(thisArg, r.value) ? r : step()
            })
          })
        })
        defIf(AsyncIteratorPrototype, 'take', function (limit) {
          var self = this
          var n = Math.max(0, Number(limit) || 0)
          return makeAsync(function () {
            if (n <= 0) return Promise.resolve(done())
            n--
            return self.next()
          })
        })
        defIf(AsyncIteratorPrototype, 'drop', function (limit) {
          var self = this
          var n = Math.max(0, Number(limit) || 0)
          var dropped = false
          return makeAsync(function () {
            if (dropped) return self.next()
            dropped = true
            return (function loop(k) {
              if (k <= 0) return self.next()
              return self.next().then(function (r) { return r.done ? r : loop(k - 1) })
            })(n)
          })
        })
        defIf(AsyncIteratorPrototype, 'toArray', function () {
          var self = this
          var out = []
          return (function loop() {
            return self.next().then(function (r) {
              if (r.done) return out
              out.push(r.value)
              return loop()
            })
          })()
        })
        defIf(AsyncIteratorPrototype, 'forEach', function (fn, thisArg) {
          var self = this
          var i = 0
          return (function loop() {
            return self.next().then(function (r) {
              if (r.done) return undefined
              fn.call(thisArg, r.value, i++)
              return loop()
            })
          })()
        })
      }

      def(AsyncIterator, 'from', function (obj) {
        if (obj == null) throw new TypeError('AsyncIterator.from: argument is not iterable')
        if (typeof obj.next === 'function') return obj
        if (typeof obj[Symbol.asyncIterator] === 'function') return obj[Symbol.asyncIterator]()
        if (typeof obj[Symbol.iterator] === 'function') {
          var it = obj[Symbol.iterator]()
          return makeAsync(function () { return Promise.resolve(it.next()) })
        }
        throw new TypeError('AsyncIterator.from: argument is not iterable')
      })
      return AsyncIterator
    })())

    // ────────────────────────────────────────────────────────────
    // 2. Promise（withResolvers 119 / try 129）
    // ────────────────────────────────────────────────────────────
    defIf(g.Promise, 'withResolvers', function withResolvers() {
      var resolve, reject
      var promise = new g.Promise(function (res, rej) { resolve = res; reject = rej })
      return { promise: promise, resolve: resolve, reject: reject }
    })

    defIf(g.Promise, 'try', function tryFn(fn) {
      var args = Array.prototype.slice.call(arguments, 1)
      return new g.Promise(function (resolve) { resolve(fn.apply(undefined, args)) })
    })

    // ────────────────────────────────────────────────────────────
    // 3. AbortSignal.any / timeout（116 / 124）
    //    页面主作用域已由 compat.js 覆盖；worker / iframe 里没有 compat.js。
    // ────────────────────────────────────────────────────────────
    if (g.AbortSignal) {
      defIf(g.AbortSignal, 'timeout', function timeout(ms) {
        var controller = new g.AbortController()
        var timer = setTimeout(function () {
          controller.abort(new g.DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        }, ms)
        if (timer && typeof timer.unref === 'function') timer.unref()
        return controller.signal
      })

      defIf(g.AbortSignal, 'any', function any(signals) {
        var controller = new g.AbortController()
        var list = Array.prototype.slice.call(signals)
        var onAbort = function (event) {
          controller.abort(event.target.reason)
        }
        for (var i = 0; i < list.length; i++) {
          var s = list[i]
          if (s.aborted) { controller.abort(s.reason); return controller.signal }
          s.addEventListener('abort', onAbort, { once: true })
        }
        return controller.signal
      })
    }

    // ────────────────────────────────────────────────────────────
    // 4. Object.groupBy / Map.groupBy（117）
    // ────────────────────────────────────────────────────────────
    defIf(g.Object, 'groupBy', function groupBy(items, fn) {
      var out = Object.create(null)
      var i = 0
      if (items == null) throw new TypeError('Object.groupBy: items is not iterable')
      var it = items[Symbol.iterator]()
      for (;;) {
        var r = it.next()
        if (r.done) break
        var k = fn(r.value, i++)
        var key = typeof k === 'symbol' ? k : String(k)
        if (out[key] === undefined) out[key] = []
        out[key].push(r.value)
      }
      return out
    })

    defIf(g.Map, 'groupBy', function groupBy(items, fn) {
      var out = new g.Map()
      var i = 0
      if (items == null) throw new TypeError('Map.groupBy: items is not iterable')
      var it = items[Symbol.iterator]()
      for (;;) {
        var r = it.next()
        if (r.done) break
        var k = fn(r.value, i++)
        var bucket = out.get(k)
        if (bucket === undefined) { bucket = []; out.set(k, bucket) }
        bucket.push(r.value)
      }
      return out
    })

    // ────────────────────────────────────────────────────────────
    // 5. Map / WeakMap 的 upsert 提案（getOrInsert / getOrInsertComputed）
    //    ★ 真机实测：pdf.js 主 chunk 里 40 处、worker 里 16 处，bundle 自身
    //      完全没有兜底定义，104 上必然 TypeError。
    // ────────────────────────────────────────────────────────────
    function defineUpsert(Ctor) {
      if (!Ctor) return
      defIf(Ctor.prototype, 'getOrInsert', function getOrInsert(key, value) {
        if (this.has(key)) return this.get(key)
        this.set(key, value)
        return value
      })
      defIf(Ctor.prototype, 'getOrInsertComputed', function getOrInsertComputed(key, callbackfn) {
        if (this.has(key)) return this.get(key)
        if (typeof callbackfn !== 'function') throw new TypeError('callbackfn is not a function')
        var value = callbackfn(key)
        this.set(key, value)
        return value
      })
    }
    defineUpsert(g.Map)
    defineUpsert(g.WeakMap)

    // ────────────────────────────────────────────────────────────
    // 6. Array.fromAsync（121）
    // ────────────────────────────────────────────────────────────
    defIf(g.Array, 'fromAsync', function fromAsync(items, mapFn, thisArg) {
      return new g.Promise(function (resolve, reject) {
        try {
          var out = []
          if (items != null && typeof items[Symbol.asyncIterator] === 'function') {
            var it = items[Symbol.asyncIterator]()
            var i = 0
            ;(function loop() {
              it.next().then(function (r) {
                if (r.done) return resolve(out)
                g.Promise.resolve(mapFn ? mapFn.call(thisArg, r.value, i++) : r.value)
                  .then(function (v) { out.push(v); loop() }, reject)
              }, reject)
            })()
            return
          }
          var sync = items == null ? [] : items
          var sit = sync[Symbol.iterator]()
          var j = 0
          ;(function loopSync() {
            var r
            try { r = sit.next() } catch (e) { return reject(e) }
            if (r.done) return resolve(out)
            g.Promise.resolve(mapFn ? mapFn.call(thisArg, r.value, j++) : r.value)
              .then(function (v) { out.push(v); loopSync() }, reject)
          })()
        } catch (e) { reject(e) }
      })
    })

    // ────────────────────────────────────────────────────────────
    // 7. 非变异数组 / TypedArray 方法（110）
    // ────────────────────────────────────────────────────────────
    var ARRAY_COPY_METHODS = {
      toSorted: function (cmp) { return Array.prototype.slice.call(this).sort(cmp) },
      toReversed: function () { return Array.prototype.slice.call(this).reverse() },
      toSpliced: function () {
        var a = Array.prototype.slice.call(this)
        return Array.prototype.splice.apply(a, Array.prototype.slice.call(arguments))
      },
    }
    var TypedProto = g.Uint8Array ? Object.getPrototypeOf(g.Uint8Array.prototype) : null

    function defWith(proto) {
      Object.keys(ARRAY_COPY_METHODS).forEach(function (k) { defIf(proto, k, ARRAY_COPY_METHODS[k]) })
      defIf(proto, 'with', function (index, value) {
        var a = Array.prototype.slice.call(this)
        var i = Number(index)
        if (i < 0) i += a.length
        if (!Number.isInteger(i)) throw new RangeError('Invalid index')
        if (i < 0 || i >= a.length) throw new RangeError('Invalid index: ' + index)
        a[i] = value
        return a
      })
    }
    defWith(g.Array.prototype)
    if (TypedProto) defWith(TypedProto)

    // ────────────────────────────────────────────────────────────
    // 7b. TypedArray / ArrayBuffer 的 transfer 族（ArrayBuffer 114 / TypedArray 137）
    //     ★ 真机实测钉死的 PDF 空白根因：pdf.js 的 compileFontInfo /
    //       compileSystemFontInfo 结尾是 `return buffer.transferToFixedLength(len)`，
    //       把字体数据截断成定长缓冲。104 上该方法不存在 ⇒ worker 抛
    //       UnknownErrorException "o.transferToFixedLength is not a function"，
    //       该异常把 PDFDataTransportStream 的字体 stream 打成 stream=5(ERROR)，
    //       于是 operatorList 的首个算子 `dependency ["g_d0_f1"]` 永远等不到字体对象，
    //       CanvasGraphics.executeOperatorList 静默 `return i` 挂死 ——
    //       表现为画布铺完白底后一个算子都不执行，PDF 永久空白且无任何报错。
    //     语义：返回同类型、长度为 newLength 的新视图，前 min(len, newLength) 字节照抄，
    //       并（尽力）分离原缓冲，与原方法一致。
    // ────────────────────────────────────────────────────────────
    function transferView(view, newLength) {
      var Ctor = view.constructor
      var srcLen = view.length
      var len = newLength === undefined ? srcLen : Number(newLength)
      if (!(len >= 0) || len !== Math.floor(len)) throw new RangeError('Invalid typed array length')
      var out = new Ctor(len)
      var n = srcLen < len ? srcLen : len
      for (var i = 0; i < n; i++) out[i] = view[i]
      try {
        var buf = view.buffer
        if (buf && !buf.detached) g.structuredClone(buf, { transfer: [buf] })
      } catch (e) { /* 分离失败不影响返回值 */ }
      return out
    }
    if (TypedProto) {
      defIf(TypedProto, 'transfer', function transfer(newLength) { return transferView(this, newLength) })
      defIf(TypedProto, 'transferToFixedLength', function transferToFixedLength(newLength) {
        return transferView(this, newLength)
      })
    }
    if (g.ArrayBuffer) {
      defIf(g.ArrayBuffer.prototype, 'transfer', function transfer(newLength) {
        var len = newLength === undefined ? this.byteLength : Number(newLength)
        var out = new g.ArrayBuffer(len)
        new g.Uint8Array(out).set(new g.Uint8Array(this, 0, Math.min(len, this.byteLength)))
        try { if (!this.detached) g.structuredClone(this, { transfer: [this] }) } catch (e) { }
        return out
      })
      defIf(g.ArrayBuffer.prototype, 'transferToFixedLength', function transferToFixedLength(newLength) {
        return g.ArrayBuffer.prototype.transfer.call(this, newLength)
      })
    }

    // ────────────────────────────────────────────────────────────
    // 8. String（isWellFormed / toWellFormed，111）
    // ────────────────────────────────────────────────────────────
    defIf(g.String.prototype, 'isWellFormed', function isWellFormed() {
      var s = String(this)
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i)
        if (c >= 0xd800 && c <= 0xdbff) {
          var n = s.charCodeAt(i + 1)
          if (!(n >= 0xdc00 && n <= 0xdfff)) return false
          i++
        } else if (c >= 0xdc00 && c <= 0xdfff) return false
      }
      return true
    })

    defIf(g.String.prototype, 'toWellFormed', function toWellFormed() {
      var s = String(this)
      var out = ''
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i)
        if (c >= 0xd800 && c <= 0xdbff) {
          var n = s.charCodeAt(i + 1)
          if (n >= 0xdc00 && n <= 0xdfff) { out += s[i] + s[i + 1]; i++ } else { out += '\ufffd' }
        } else if (c >= 0xdc00 && c <= 0xdfff) out += '\ufffd'
        else out += s[i]
      }
      return out
    })

    // ────────────────────────────────────────────────────────────
    // 9. RegExp.escape（136）
    // ────────────────────────────────────────────────────────────
    defIf(g.RegExp, 'escape', function escape(str) {
      var s = String(str)
      var out = s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
      return out.replace(/^[0-9A-Za-z]/, function (c) {
        return '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')
      })
    })

    // ────────────────────────────────────────────────────────────
    // 10. Set 集合运算（122）
    // ────────────────────────────────────────────────────────────
    function asSet(v) { return v instanceof g.Set ? v : new g.Set(v) }
    defIf(g.Set.prototype, 'union', function union(other) {
      var out = new g.Set(this)
      asSet(other).forEach(function (v) { out.add(v) })
      return out
    })
    defIf(g.Set.prototype, 'intersection', function intersection(other) {
      var o = asSet(other)
      var out = new g.Set()
      this.forEach(function (v) { if (o.has(v)) out.add(v) })
      return out
    })
    defIf(g.Set.prototype, 'difference', function difference(other) {
      var o = asSet(other)
      var out = new g.Set()
      this.forEach(function (v) { if (!o.has(v)) out.add(v) })
      return out
    })
    defIf(g.Set.prototype, 'symmetricDifference', function symmetricDifference(other) {
      var o = asSet(other)
      var self = this
      var out = new g.Set()
      this.forEach(function (v) { if (!o.has(v)) out.add(v) })
      o.forEach(function (v) { if (!self.has(v)) out.add(v) })
      return out
    })
    defIf(g.Set.prototype, 'isSubsetOf', function isSubsetOf(other) {
      var o = asSet(other)
      var ok = true
      this.forEach(function (v) { if (!o.has(v)) ok = false })
      return ok
    })
    defIf(g.Set.prototype, 'isSupersetOf', function isSupersetOf(other) {
      var self = this
      var ok = true
      asSet(other).forEach(function (v) { if (!self.has(v)) ok = false })
      return ok
    })
    defIf(g.Set.prototype, 'isDisjointFrom', function isDisjointFrom(other) {
      var o = asSet(other)
      var ok = true
      this.forEach(function (v) { if (o.has(v)) ok = false })
      return ok
    })

    // ────────────────────────────────────────────────────────────
    // 11. Uint8Array base64/hex（130 / 133）★ pdf.js worker 用了 fromBase64 / toHex
    // ────────────────────────────────────────────────────────────
    if (g.Uint8Array && TypedProto) {
      defIf(g.Uint8Array, 'fromBase64', function fromBase64(str) {
        var s = String(str).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
        var bin = (typeof g.atob === 'function') ? g.atob(s) : ''
        var out = new g.Uint8Array(bin.length)
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
        return out
      })

      defIf(TypedProto, 'toBase64', function toBase64() {
        var bin = ''
        for (var i = 0; i < this.length; i++) bin += String.fromCharCode(this[i])
        return (typeof g.btoa === 'function') ? g.btoa(bin) : ''
      })

      defIf(g.Uint8Array, 'fromHex', function fromHex(str) {
        var s = String(str)
        var out = new g.Uint8Array(Math.floor(s.length / 2))
        for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16)
        return out
      })

      defIf(TypedProto, 'toHex', function toHex() {
        var out = ''
        for (var i = 0; i < this.length; i++) out += this[i].toString(16).padStart(2, '0')
        return out
      })
    }

    // ────────────────────────────────────────────────────────────
    // 12. URL.parse（126）★ pdf.js worker 用了 2 处
    // ────────────────────────────────────────────────────────────
    if (g.URL) {
      defIf(g.URL, 'parse', function parse(url, base) {
        try { return new g.URL(url, base) } catch (e) { return null }
      })
    }

    // ────────────────────────────────────────────────────────────
    // 13. Math.sumPrecise（Chrome 138）★ pdf.js worker 重建字体表的必经调用
    //
    // 这一条是「docx/pptx 预览中文正常、ASCII 却错位」的真根因（真机 + Node 双
    // 侧复现）：pdf.js 的 worker 在 checkAndRepair 里要把修好的 glyf/loca/name
    // 表重新拼装成字体二进制，而拼装长度计算用的是
    //   Glyph.prototype.getSize() { return Math.sumPrecise(this.glyphs.map(…)) }
    //   CompositeGlyph / nameTable 里还有 3 处同样调用。
    // 104（以及 Node 24）都没有这个方法 ⇒ 每次拼字体都抛 TypeError，字体修复
    // 整体中断，`FontFaceObject.missingFile` 变成 true、`toFontChar` 为空，于是
    // pdf.js 退化成「把 PDF 字符码直接当 ASCII 解释」：`Office` → `O f ce`、
    // `器等软件` → `！" 件`、列表项 → `' ( )`。
    //
    // 语义按提案实现（Kahan–Babuška–Neumaier 补偿求和，误差可忽略）：
    // 入参必须是可迭代对象，元素非数字时抛 TypeError。
    // ────────────────────────────────────────────────────────────
    defIf(g.Math, 'sumPrecise', function sumPrecise(values) {
      if (values === null || values === undefined) {
        throw new TypeError('Math.sumPrecise requires an iterable')
      }
      var sum = 0
      var compensation = 0
      var seen = false
      var it
      if (typeof values[Symbol.iterator] === 'function') {
        it = values[Symbol.iterator]()
      } else {
        throw new TypeError('Math.sumPrecise requires an iterable')
      }
      for (;;) {
        var step = it.next()
        if (step.done) break
        var v = step.value
        if (typeof v !== 'number') {
          throw new TypeError('Math.sumPrecise requires numbers')
        }
        seen = true
        var t = sum + v
        // Neumaier 补偿：把这次加法丢掉的低位补回来
        compensation += (Math.abs(sum) >= Math.abs(v) ? (sum - t) + v : (v - t) + sum)
        sum = t
      }
      if (!seen) return 0
      return sum + compensation
    })

    // ────────────────────────────────────────────────────────────
    // 14. DOM / Web API 小缺口（仅页面与 iframe 作用域有意义）
    // ────────────────────────────────────────────────────────────
    if (g.Element) {
      defIf(g.Element.prototype, 'checkVisibility', function checkVisibility() {
        if (this.offsetWidth || this.offsetHeight) return true
        try { return !!(this.getClientRects && this.getClientRects().length) } catch (e) { return false }
      })
    }

    if (g.URLSearchParams) {
      defIf(g.URLSearchParams.prototype, 'size', function () {
        var n = 0
        this.forEach(function () { n++ })
        return n
      }, true)
    }

    if (g.Response) {
      defIf(g.Response, 'json', function json(data, init) {
        var headers = new g.Headers(init && init.headers)
        if (!headers.has('content-type')) headers.set('content-type', 'application/json')
        var body = JSON.stringify(data)
        var next = {}
        if (init) for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) next[k] = init[k]
        next.headers = headers
        return new g.Response(body, next)
      })

      defIf(g.Response.prototype, 'bytes', function bytes() {
        return this.arrayBuffer().then(function (b) { return new g.Uint8Array(b) })
      })
    }

    if (g.Blob) {
      defIf(g.Blob.prototype, 'bytes', function bytes() {
        return this.arrayBuffer().then(function (b) { return new g.Uint8Array(b) })
      })
    }
  }

  // 暴露给宿主/诊断用；同时它的源码文本就是注入 blob 作用域的那份代码。
  g.__kxxyModernInstall = kxxyModernInstall

  // ── 第一步：本页面直接生效 ──────────────────────────────────────
  try { kxxyModernInstall(g) } catch (e) { /* 单点失败不影响后面的 blob 注入 */ }

  // ── 第二步：把同一份代码注入 blob: 作用域 ───────────────────────
  //
  // 覆盖两类目标：
  //   * `text/javascript` 的 Blob —— PDF 渲染 worker（pdf.js 以字符串常量内联
  //     自己的 worker 源码，再 createObjectURL 成 module worker）。
  //   * `text/html` 的 Blob —— HTML 预览 iframe（宿主先拼一个 bootstrap 文档，
  //     bootstrap 再 document.open/write 用户 html）。document.open 只清 DOM，
  //     不动 window，所以前置脚本装好的内建在用户 html 里依然可用。
  //
  // 不做的话这两处的报错都只出现在 logcat 的 blob: URL 行上，界面上只表现为
  // 「PDF 渲染进程无法继续」或整片空白，排查成本极高。
  var INSTALL_SOURCE = '(' + kxxyModernInstall.toString() + ')(globalThis);\n'

  var SCRIPT_TYPES = {
    'text/javascript': true,
    'application/javascript': true,
    'text/ecmascript': true,
    'application/ecmascript': true,
    'module': true,
  }

  /** 按 blob 的 MIME 决定怎么塞前置代码；不需要处理时返回 null。 */
  function patchedBlob(blob) {
    var type = (blob.type || '').toLowerCase()
    var base = type.split(';')[0].trim()

    if (SCRIPT_TYPES[base] === true) {
      return new g.Blob([INSTALL_SOURCE, blob], { type: blob.type })
    }

    if (base === 'text/html' || base === 'application/xhtml+xml') {
      // 必须自带 doctype：原文档的 `<!doctype html>` 被顶到第二个位置会被解析器
      // 忽略，若这里只前置一个 <script>，文档就会掉进 quirks 模式。
      var head = '<!doctype html><meta charset="utf-8"><script>' +
        INSTALL_SOURCE.replace(/<\/script/gi, '<\\/script') +
        '</script>'
      return new g.Blob([head, blob], { type: blob.type })
    }

    return null
  }

  if (g.URL && typeof g.URL.createObjectURL === 'function' && g.Blob) {
    var nativeCreateObjectURL = g.URL.createObjectURL
    var patchedCreateObjectURL = function createObjectURL(obj) {
      try {
        if (obj instanceof g.Blob) {
          var next = patchedBlob(obj)
          if (next !== null) obj = next
        }
      } catch (e) { /* 失败就原样放行 */ }
      return nativeCreateObjectURL.call(this, obj)
    }
    patchedCreateObjectURL.__kxxyPatched = true
    g.URL.createObjectURL = patchedCreateObjectURL
  }
})()
