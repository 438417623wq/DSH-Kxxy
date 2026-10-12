/* kxxy-pty-node@1 */
"use strict";

/**
 * node-pty 的 Android 实现 —— JS 包装层。
 *
 * 上游 node-pty 是原生绑定（需要 posix_openpt / forkpty 的 N-API 实现），
 * 官方不发 Android 预编译产物、仓库里也没有源码，因此这里自研一份：
 * `../prebuilds/android-arm64/dsh_pty_node.node`（纯 C，见 src/dsh_pty_node.c）。
 *
 * 本文件只做三件事，每一件都对应一个真机上会炸的差异：
 *
 *   1. **契约适配**。`dsh-subprocess-local` 的 `LocalTerminalHandle` 用到
 *      `pid / onData / onExit / pause / resume / write / resize / kill`
 *      共 8 个成员，且形状有硬要求（详见各方法注释）。少一个就是
 *      「终端侧栏一点开就报错」。
 *   2. **参数顺序换算**。原生 `resize(fd, rows, cols)` 与 node-pty 的
 *      `resize(cols, rows)` 相反 —— 上游按后者调用，这里必须翻转，
 *      否则窗口尺寸被写成「行=列、列=行」。
 *   3. **可执行文件与环境的物化**。原生走 `execve`（理由见 C 文件头 G3），
 *      它**不搜索 PATH**，所以这里必须自己按 PATH 解析成绝对路径；
 *      同时把 JS 对象形态的 env 摊平成 `KEY=VALUE` 数组。
 *
 * 另外，`onData` 一律用 `StringDecoder` 做流式 utf8 解码：PTY 输出按
 * 64 KiB 分片投递，多字节字符（中文、emoji）会被切在分片边界上，
 * 直接 `buf.toString("utf8")` 会产出替换字符。
 */

const fs = require("fs");
const { StringDecoder } = require("string_decoder");

/** 原生模块只可能在这一个位置（patchNodePty 按此布局注入）。 */
const NATIVE_RELATIVE = "../prebuilds/android-arm64/dsh_pty_node.node";

function loadNative() {
  try {
    return require(NATIVE_RELATIVE);
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    const hint =
      process.platform === "android"
        ? "运行时缺少 Android PTY 原生模块（runtime.zip 可能未更新，或 ABI 不匹配）"
        : `当前平台是 ${process.platform}，本模块只为 Android/arm64 构建`;
    throw new Error(
      `node-pty: 无法加载原生 PTY 模块 ${NATIVE_RELATIVE}：${hint}；${detail}`,
    );
  }
}

const native = loadNative();

/* ── 环境与可执行文件 ──────────────────────────────────────────────────── */

/**
 * 把 `options.env` 摊平成 `KEY=VALUE` 数组。
 *
 * 刻意不合并 `process.env`：上游传来的本来就是一份完整环境
 * （`dsh-subprocess-local` 的 `targetEnvironment`），而 App 侧的
 * `buildEnv` 注入的 PATH / LD_LIBRARY_PATH / SHELL / PREFIX 等正是
 * shell 能跑起来的前提；合并反而会把引擎自己的变量泄进终端。
 * 只有在调用方完全没给 env 时才退化为 `process.env`。
 */
function buildEnvArray(env) {
  const source =
    env !== null && typeof env === "object" ? env : process.env;
  const out = [];
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    out.push(`${key}=${value}`);
  }
  return out;
}

/** 供 PATH 解析使用（需要按名字取值，不能只看摊平后的数组）。 */
function envValue(env, name) {
  const source = env !== null && typeof env === "object" ? env : process.env;
  if (source[name] !== undefined) return source[name];
  if (process.platform !== "win32") return undefined;
  const upper = name.toUpperCase();
  const hit = Object.keys(source).find((key) => key.toUpperCase() === upper);
  return hit === undefined ? undefined : source[hit];
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch (_notExecutable) {
    return false;
  }
}

/**
 * 解析成绝对路径。
 *
 * 与上游 node-pty 的差异点：它在 Linux 上走 `execvp` 会自己搜 PATH，
 * 而我们的原生层用 `execve`（必须如此，见 C 文件头 G3），
 * 所以「PATH 里有 bash」这件事必须在这里落地。
 *
 * 解析不到时原样返回：让 `execve` 去报 ENOENT，错误信息里带着调用方
 * 原本给的路径，比这里编一个更好归因。
 */
function resolveExecutable(file, env) {
  if (file.includes("/")) return file;
  const pathValue = envValue(env, "PATH");
  if (typeof pathValue !== "string" || pathValue.length === 0) return file;
  for (const dir of pathValue.split(":")) {
    if (dir.length === 0) continue;
    const candidate = `${dir.replace(/\/+$/, "")}/${file}`;
    if (isExecutableFile(candidate)) return candidate;
  }
  return file;
}

/* ── 信号名 → 编号（onExit 的 signal 必须是数字） ───────────────────────── */

/**
 * 上游用 `constants.signals` 反查名字（`signalName`），传名字过去会
 * 得到 `undefined`，最终 outcome.signal 变成 `undefined` 而非 `null`。
 * 因此这里把名字翻译成编号。原生层也接受字符串，但翻译一次更直观。
 */
const SIGNALS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
};

/* ── 监听器容器 ───────────────────────────────────────────────────────── */

function makeListeners() {
  const set = new Set();
  return {
    add(fn) {
      set.add(fn);
      return {
        dispose() {
          set.delete(fn);
        },
      };
    },
    fire(...args) {
      // 复制一份：监听器内部可能 dispose 自己
      for (const fn of [...set]) {
        try {
          fn(...args);
        } catch (_listenerThrew) {
          // 单个监听器抛错不能中断其它监听器，也不能污染原生回调栈
        }
      }
    },
    get size() {
      return set.size;
    },
  };
}

/* ── 终端对象 ─────────────────────────────────────────────────────────── */

class AndroidTerminal {
  constructor(handle, pid, rows, cols) {
    this._handle = handle;
    this._pid = pid;
    this._rows = rows;
    this._cols = cols;

    this._dataListeners = makeListeners();
    this._exitListeners = makeListeners();
    this._decoder = new StringDecoder("utf8");

    /** 监听器注册之前到达的数据先攒着（上游是 spawn 后同步注册，正常为空）。 */
    this._pendingData = [];
    /** onExit 之前就被 close 掉、之后才注册 onExit 的情况。 */
    this._pendingExit = null;

    this._paused = false;
    this._closed = false;
    this._exited = false;
  }

  get pid() {
    return this._pid;
  }

  /**
   * 上游调用点立刻 `Buffer.from(data, "utf8")`，说明它期望**字符串**
   * （`Buffer.from(buffer, "utf8")` 会忽略 encoding 直接拷贝，虽然也能跑，
   * 但语义上不该依赖这一点）。这里给字符串。
   */
  onData(listener) {
    const disposable = this._dataListeners.add(listener);
    if (this._pendingData.length > 0) {
      const backlog = this._pendingData;
      this._pendingData = [];
      for (const chunk of backlog) listener(chunk);
    }
    return disposable;
  }

  /**
   * cb 收 `{ exitCode, signal }`，**`signal` 是数字信号号**（上游用
   * `constants.signals` 反查名字，给字符串会反查失败）。
   */
  onExit(listener) {
    const disposable = this._exitListeners.add(listener);
    if (this._pendingExit !== null) {
      const outcome = this._pendingExit;
      this._pendingExit = null;
      listener(outcome);
    }
    return disposable;
  }

  /** 背压：上游在 `output.write()` 返回 false 时暂停读取。 */
  pause() {
    if (this._closed || this._paused || this._exited) return;
    this._paused = true;
    native.pausePoll(this._handle);
  }

  resume() {
    if (this._closed || !this._paused || this._exited) return;
    this._paused = false;
    native.resumePoll(this._handle);
  }

  write(data) {
    if (this._closed || this._exited) return;
    native.write(this._handle, data);
  }

  /** 注意顺序：node-pty 是 (cols, rows)，原生是 (fd, rows, cols)。 */
  resize(cols, rows) {
    if (this._closed) return;
    const safeCols = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : this._cols;
    const safeRows = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : this._rows;
    this._cols = safeCols;
    this._rows = safeRows;
    native.resize(this._handle, safeRows, safeCols);
  }

  /**
   * 上游有四种调用形态，含**无参** `kill()`。无参时走原生默认的 SIGTERM。
   * 原生优先杀整个进程组（子进程 setsid 后自己是组长），这样 shell 里
   * 正在跑的命令会一并收掉。
   */
  kill(signal) {
    if (this._exited) return;
    const name = typeof signal === "string" ? signal : undefined;
    const number = name === undefined ? undefined : SIGNALS[name];
    try {
      native.kill(this._pid, number === undefined ? name : number);
    } catch (_alreadyGone) {
      // 进程已退出：node-pty 在这种情况下也不抛
    }
  }

  /* ── 以下为诊断用附加 API（非 node-pty 契约，上游不会调用） ── */

  isatty() {
    return !this._closed && native.isatty(this._handle) === true;
  }

  getpgid() {
    return native.getpgid(this._pid);
  }

  /* ── 内部 ── */

  _emitData(buffer) {
    const text = this._decoder.write(buffer);
    if (text.length === 0) return;
    if (this._dataListeners.size === 0) {
      this._pendingData.push(text);
      return;
    }
    this._dataListeners.fire(text);
  }

  _emitExit(exitCode, signal) {
    if (this._exited) return;
    this._exited = true;

    // 冲刷解码器里残留的不完整序列（进程退出后不会再有后续字节补齐）
    const tail = this._decoder.end();
    if (tail.length > 0) this._emitData(Buffer.from(tail, "utf8"));

    const outcome = { exitCode, signal };
    if (this._exitListeners.size === 0) {
      this._pendingExit = outcome;
    } else {
      this._exitListeners.fire(outcome);
    }

    // 释放原生槽位。setImmediate 保证在所有 onExit 监听器跑完之后执行
    // —— 上游的 onExit 处理器会 output.end()，中途收掉 fd 会截断输出。
    // 顺序固定为 close(fd) → stopPoll(fd)：先关 fd 再释放槽位，
    // 避免「槽位已复用给新 PTY、却拿着同一个 fd 号去 close」的窗口。
    setImmediate(() => {
      if (this._closed) return;
      this._closed = true;
      try {
        native.close(this._handle);
      } catch (_closeFailed) {}
      try {
        native.stopPoll(this._handle);
      } catch (_stopFailed) {}
    });
  }
}

/* ── spawn ────────────────────────────────────────────────────────────── */

/**
 * 与 node-pty 的 `spawn(file, args, options)` 同签名。
 *
 * `args` **不含程序名**（上游传的是 `[...launch.argv.slice(1)]`），
 * argv[0] 由这里补上 —— 且刻意用调用方给的原始 `file` 而不是解析后的
 * 绝对路径：bash 等程序会读 argv[0] 判断是否为 login shell。
 */
function spawn(file, args, options) {
  if (typeof file !== "string" || file.length === 0) {
    throw new TypeError("node-pty: spawn(file, args, options) 的 file 必须是非空字符串");
  }
  const opts = options !== null && typeof options === "object" ? options : {};

  const argv = Array.isArray(args) ? args.map((item) => String(item)) : [];
  const cwd =
    typeof opts.cwd === "string" && opts.cwd.length > 0 ? opts.cwd : process.cwd();
  const rows = Number.isFinite(opts.rows) && opts.rows > 0 ? Math.floor(opts.rows) : 40;
  const cols = Number.isFinite(opts.cols) && opts.cols > 0 ? Math.floor(opts.cols) : 120;

  const env = opts.env !== null && typeof opts.env === "object" ? opts.env : process.env;
  const executable = resolveExecutable(file, env);
  const envArray = buildEnvArray(env);

  const result = native.spawn(executable, [file, ...argv], envArray, cwd, rows, cols);
  if (result === null || typeof result !== "object" || typeof result.fd !== "number") {
    throw new Error(`node-pty: 原生 spawn 返回了意外结果（${JSON.stringify(result)}）`);
  }

  const terminal = new AndroidTerminal(result.fd, result.pid, rows, cols);

  // 立刻开始读取。不这么做的话 master 端缓冲写满后子进程会阻塞在写系统调用上。
  native.startPoll(
    result.fd,
    (chunk) => terminal._emitData(chunk),
    (outcome) => {
      const exitCode = outcome && typeof outcome.exitCode === "number" ? outcome.exitCode : 0;
      const signal = outcome && typeof outcome.signal === "number" ? outcome.signal : 0;
      terminal._emitExit(exitCode, signal);
    },
  );

  return terminal;
}

module.exports = {
  spawn,
  /** 诊断用：原生模块自报的版本串。 */
  nativeVersion: native.version,
};
