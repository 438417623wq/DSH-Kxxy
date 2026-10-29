/*
 * kxxy-guard@1 —— 引擎进程的异常兜底。
 *
 * ## 为什么需要这个文件
 *
 * 引擎是 `node --expose-internals .../dsh/lib/bin.js web` 一个进程跑到底的，
 * 第三方插件和官方内核**共享同一个事件循环**。而 Node 的默认行为是：
 *
 *   · 一个没人 catch 的 Promise 被 reject      → 进程直接退出（node ≥ 15）
 *   · 一个异步回调里抛出的异常（定时器、socket
 *     事件、native addon 的回调）               → 同样直接退出
 *
 * cordis 的 Loader 只兜住了「插件 import 失败」和「apply 里同步抛错」两种，
 * 而移植到手机上的桌面插件最常见的死法恰恰是第三种：它在一个 `setTimeout` /
 * 事件监听 / 后台轮询里调了个 Android 上不存在的 API，抛出的异常没人接，
 * 于是**整个引擎连同正在跑的会话一起没了**。
 *
 * 用户的原话是「哪怕不兼容也不应该崩溃」。这个文件就是那句话的实现：
 * 插件自己烂掉可以，但不能把宿主带走。
 *
 * ## 装载方式
 *
 * 由 `EngineConfig.buildEnv()` 注入：
 *   NODE_OPTIONS=--require "<本文件>"
 *   KXXY_GUARD_DIR=<files/kxxy-home/guard>
 *
 * 用 `--require` 而不是改引擎入口，是因为入口在只读的 asar 里，而 preload
 * 对 ESM 入口同样生效（真机 Node 24、本机 Node 22 都验过）。
 *
 * 两个拼接细节都是踩出来的：
 *   · 路径**必须加双引号** —— NODE_OPTIONS 按空格切分，路径带空格（本仓库的
 *     `dsh kxxy` 就是）会断成两个参数，报 `Cannot find module 'E://deepseek-harness//dsh'`；
 *   · 路径**必须用正斜杠** —— 双引号里的反斜杠会被当转义吃掉（`\d` → `d`），
 *     Windows 路径会变成一串连在一起的字母。Android 上本来就是 `/`，这条是为了
 *     让同一份逻辑在构建机上也能跑通（tools/test-guard.mjs 就在带空格的路径下跑）。
 *
 * 刻意**不**加 `--unhandled-rejections=warn`：它同样会被子进程继承，插件去跑
 * `npm install` 时那些本该立刻失败的致命错误会变成警告，表现为构建卡死。
 *
 * ## 三条硬约束
 *
 * 1. **只装在主引擎进程里**。NODE_OPTIONS 会被子进程继承 —— 如果插件去跑
 *    `npm install`、`tsc`，那些子进程也会预加载本文件，把它们本该致命的报错
 *    也吞掉，表现为「构建卡住不动」。所以靠 `KXXY_GUARD_MAIN=1` 一次性开关：
 *    读完立刻 `delete process.env.KXXY_GUARD_MAIN`，之后 fork 出来的子进程
 *    只继承 NODE_OPTIONS、看不到开关，于是安静退出。
 *
 * 2. **自己绝不能抛**。整体包在 try/catch 里：兜底模块自身出问题时退回 Node
 *    默认行为（该崩就崩），而不是让引擎连启动都过不去。
 *
 * 3. **兜底不是无限兜**。同一句错误连续出现 3 次、或 60 秒内超过 60 次，
 *    说明进程已经处在不可信状态（典型：端口占着、事件循环里死循环报错），
 *    这时主动 `exit(1)` 交给原生监管循环重启，比留一个半死不活的进程好。
 *
 * ## 产物
 *
 *   <guard>/guard.log        追加式日志（超过 1 MiB 轮转成 guard.log.1）
 *   <guard>/guard-state.json 最近一次拦截的结构化快照，供 /kxxy/api/health 读
 */

;(function bootstrap() {
  'use strict'

  try {
    install()
  } catch (_) {
    // 兜底自己坏了：不打印、不改行为，把进程交回 Node 默认处理。
  }

  function install() {
    // 开关缺失 ⇒ 这是被继承到子进程里的预加载，什么都不做。
    if (process.env.KXXY_GUARD_MAIN !== '1') return
    delete process.env.KXXY_GUARD_MAIN

    const fs = require('node:fs')
    const path = require('node:path')

    const dir = process.env.KXXY_GUARD_DIR || ''
    if (!dir) return

    const LOG_FILE = path.join(dir, 'guard.log')
    const STATE_FILE = path.join(dir, 'guard-state.json')
    const LOG_MAX_BYTES = 1024 * 1024
    const RECENT_MAX = 5
    const STACK_MAX = 1600

    // 连续/高频判定：见文件头约束 3
    const FLOOD_WINDOW_MS = 60 * 1000
    const FLOOD_LIMIT = 60
    const REPEAT_LIMIT = 3

    const startedAt = new Date().toISOString()
    let total = 0
    let windowStart = Date.now()
    let windowCount = 0
    let lastSignature = ''
    let signatureHits = 0
    const recent = []

    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (_) {
      return
    }

    /**
     * 从调用栈里认出「这是哪个包」，以及「是不是内核自己的锅」。
     *
     * 不能只看 `node_modules/<pkg>` 就当成插件 —— 真机上内核（`@deepseek-ai/dsh*`）
     * 同样躺在 `node_modules` 里，只是它在**引擎根**下（`<root>/lib/node_modules`），
     * 而用户装的插件在 **profile** 下（`<home>/profiles/web/node_modules`）。
     * 所以判据是路径前缀，不是包名 —— 把内核的异常报成「某个插件有问题」，
     * 用户会去停用一个无辜的插件，然后问题照旧。
     *
     * 栈的两种格式都要认：
     *   `    at foo (/path/to/file.js:12:34)`
     *   `    at /path/to/file.js:12:34`
     */
    const ENGINE_ROOT = String(process.env.PREFIX || '').replace(/\\/g, '/').replace(/\/+$/, '')

    function framePath(line) {
      const m = /\(?([^()\s]+):\d+:\d+\)?\s*$/.exec(String(line).trim())
      return m ? m[1].replace(/\\/g, '/') : ''
    }

    function blame(stack) {
      if (typeof stack !== 'string') return { plugin: '', core: false }
      for (const line of stack.split('\n')) {
        const p = framePath(line)
        const idx = p.lastIndexOf('/node_modules/')
        if (idx < 0) continue
        const parts = p.slice(idx + '/node_modules/'.length).split('/')
        if (!parts[0]) continue
        const name = parts[0].charAt(0) === '@' && parts[1] ? parts[0] + '/' + parts[1] : parts[0]
        // 前缀比对即可，不要额外假设路径以 `/` 开头 —— 构建机上是 `C:/...`，
        // 真机上才是 `/data/...`（加了这条判断会让测试永远看不见 core=true）。
        const core = ENGINE_ROOT !== '' && p.indexOf(ENGINE_ROOT + '/') === 0
        return { plugin: name, core }
      }
      return { plugin: '', core: false }
    }

    /** 消息归一：去掉路径与行号，用来判「是不是同一句错误在循环」。 */
    function signatureOf(kind, message) {
      return kind + '::' + String(message).replace(/[\\/][^\s:]+:\d+:\d+/g, '<loc>').slice(0, 200)
    }

    function rotateLog() {
      try {
        const st = fs.statSync(LOG_FILE)
        if (st.size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1')
      } catch (_) {
        /* 文件还不存在，正常 */
      }
    }

    function appendLog(text) {
      rotateLog()
      try {
        fs.appendFileSync(LOG_FILE, text)
      } catch (_) {
        /* 磁盘满 / 权限问题：日志丢了也不能影响引擎 */
      }
    }

    function writeState(entry) {
      const state = {
        version: 1,
        guard: 'kxxy-guard@1',
        pid: process.pid,
        startedAt,
        updatedAt: new Date().toISOString(),
        total,
        lastKind: entry ? entry.kind : '',
        lastPlugin: entry ? entry.plugin : '',
        lastCore: entry ? entry.core : false,
        lastMessage: entry ? entry.message : '',
        lastStack: entry ? entry.stack : '',
        recent,
      }
      try {
        const tmp = STATE_FILE + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
        fs.renameSync(tmp, STATE_FILE)
      } catch (_) {
        /* 同上 */
      }
    }

    function onIncident(kind, reason) {
      const isError = reason && typeof reason === 'object' && (reason.stack || reason.message)
      const message = String(
        isError ? reason.message : typeof reason === 'string' ? reason : (() => {
          try {
            return JSON.stringify(reason)
          } catch (_) {
            return String(reason)
          }
        })(),
      ).slice(0, 600)
      const stack = isError && reason.stack ? String(reason.stack).slice(0, STACK_MAX) : ''
      const who = blame(stack)

      total += 1

      // 窗口计数
      const now = Date.now()
      if (now - windowStart > FLOOD_WINDOW_MS) {
        windowStart = now
        windowCount = 0
      }
      windowCount += 1

      // 同一句错误连续计数
      const sig = signatureOf(kind, message)
      if (sig === lastSignature) signatureHits += 1
      else {
        lastSignature = sig
        signatureHits = 1
      }

      const entry = {
        at: new Date(now).toISOString(),
        kind,
        plugin: who.plugin,
        core: who.core,
        message,
        stack,
      }
      recent.push(entry)
      if (recent.length > RECENT_MAX) recent.shift()

      appendLog(
        `[${entry.at}] ${kind} pid=${process.pid}` +
          (who.plugin ? ` plugin=${who.plugin}${who.core ? '(core)' : ''}` : ' plugin=?') +
          `\n  ${message}\n` +
          (stack ? stack.split('\n').slice(1, 8).map((l) => '  ' + l.trim()).join('\n') + '\n' : ''),
      )
      writeState(entry)

      // stderr 会进 engine.log 的环形缓冲，诊断页能直接看到
      try {
        process.stderr.write(
          `[kxxy-guard] 已拦截 ${kind}（第 ${total} 次）` +
            (who.plugin ? `：${who.plugin}` : '') +
            ` —— ${message}\n`,
        )
      } catch (_) {
        /* 忽略 */
      }

      // 兜不住的情形：交给监管循环重启，别留一个半死的进程
      if (signatureHits >= REPEAT_LIMIT || windowCount > FLOOD_LIMIT) {
        appendLog(
          `[${new Date().toISOString()}] give-up: signatureHits=${signatureHits} ` +
            `windowCount=${windowCount} → exit(1)，交由原生监管循环重启\n`,
        )
        try {
          process.stderr.write(
            `[kxxy-guard] 同一条异常连续 ${signatureHits} 次 / 一分钟内 ${windowCount} 次，` +
              `判断进程已不可信，主动退出让监管循环重启\n`,
          )
        } catch (_) {}
        process.exit(1)
      }
    }

    // 首启动时先落一次空快照：体检页据此区分「没装兜底」与「装了但一次没拦到」。
    writeState(null)

    process.on('unhandledRejection', (reason) => onIncident('unhandledRejection', reason))
    process.on('uncaughtException', (err) => onIncident('uncaughtException', err))
  }
})()
