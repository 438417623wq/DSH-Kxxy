import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export class CodexError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function redact(text) {
  return String(text)
    .replace(/\bsk-[\w-]{12,}/g, '[redacted]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
}

/** Newline-delimited JSON-RPC. stdout is protocol only; stderr is bounded diagnostics. */
export class CodexTransport extends EventEmitter {
  constructor({ executable, args = ['app-server', '--stdio'], env, cwd, spawnProcess = spawn, timeoutMs = 30000, maxLineBytes = 8 * 1024 * 1024, sanitize = redact }) {
    super()
    Object.assign(this, { executable, args, env, cwd, spawnProcess, timeoutMs, maxLineBytes, sanitize })
    this.pending = new Map()
    this.serial = 0
    this.child = null
    this.opening = null
    this.closed = false
    this.diagnostics = ''
  }

  async start() {
    if (this.closed) throw new CodexError('stopped', 'Codex 进程已关闭', 503)
    if (this.opening) return this.opening
    this.opening = this.initialize().catch((error) => {
      this.stop()
      throw error
    })
    return this.opening
  }

  async initialize() {
    const child = this.spawnProcess(this.executable, this.args, {
      cwd: this.cwd,
      env: this.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    const decoder = new StringDecoder('utf8')
    let buffered = ''
    child.stdout.on('data', (data) => {
      buffered += decoder.write(data)
      let end
      while ((end = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, end).trim()
        buffered = buffered.slice(end + 1)
        if (Buffer.byteLength(line) > this.maxLineBytes) {
          this.fail(new CodexError('protocol-overflow', 'Codex 协议消息过大', 502))
          return
        }
        if (line) this.receive(line)
      }
      if (Buffer.byteLength(buffered) > this.maxLineBytes) this.fail(new CodexError('protocol-overflow', 'Codex 协议消息超过上限', 502))
    })
    const stderrDecoder = new StringDecoder('utf8')
    let diagnosticLine = ''
    let discardLine = false
    const appendDiagnostic = (line) => { this.diagnostics = (this.diagnostics + this.sanitize(line) + '\n').slice(-8192) }
    child.stderr.on('data', (data) => {
      diagnosticLine += stderrDecoder.write(data)
      let end
      while ((end = diagnosticLine.indexOf('\n')) !== -1) {
        const line = diagnosticLine.slice(0, end)
        diagnosticLine = diagnosticLine.slice(end + 1)
        if (!discardLine && line.length <= 65536) appendDiagnostic(line)
        else appendDiagnostic('[oversized diagnostic omitted]')
        discardLine = false
      }
      // Never emit a truncated credential prefix before the complete log line is known.
      if (diagnosticLine.length > 65536) { diagnosticLine = ''; discardLine = true }
    })
    child.stderr.on('end', () => {
      diagnosticLine += stderrDecoder.end()
      if (discardLine) appendDiagnostic('[oversized diagnostic omitted]')
      else if (diagnosticLine) appendDiagnostic(diagnosticLine)
      diagnosticLine = ''
    })
    child.stdin.on('error', (error) => this.fail(new CodexError('process-input', this.sanitize(error.message), 502)))
    child.on('error', (error) => this.fail(new CodexError('process-start', `Codex 启动失败：${this.sanitize(error.message)}`, 503)))
    child.on('exit', (code, signal) => {
      const wasClosed = this.closed
      this.closed = true
      this.rejectAll(new CodexError('process-exit', `Codex 已退出 (${code ?? signal ?? 'unknown'})`, 503))
      if (!wasClosed) this.emit('exit', { code, signal, diagnostics: this.diagnostics })
    })
    const initialized = await this.request('initialize', {
      clientInfo: { name: 'dsh-codex-sidebar', title: 'DSH Kxxy Codex', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    })
    this.notify('initialized', {})
    return initialized
  }

  receive(line) {
    let message
    try { message = JSON.parse(line) } catch {
      this.fail(new CodexError('protocol-invalid', 'Codex 返回了非 JSON 协议数据', 502))
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.fail(new CodexError('protocol-invalid', 'Codex 消息形状不正确', 502))
      return
    }
    if (typeof message.method === 'string') {
      try { this.emit(message.id === undefined ? 'notification' : 'request', message) } catch (error) {
        this.fail(new CodexError('protocol-handler', `Codex 事件处理失败：${this.sanitize(error.message)}`, 502))
      }
      return
    }
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) {
      const error = new CodexError('rpc-error', this.sanitize(message.error.message ?? 'Codex 请求失败'), 502)
      if (Number.isInteger(message.error.code)) error.details = { rpcCode: message.error.code }
      waiter.reject(error)
    } else waiter.resolve(message.result)
  }

  write(message) {
    if (this.closed || !this.child?.stdin.writable) throw new CodexError('not-connected', 'Codex 尚未连接', 503)
    const line = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new CodexError('request-too-large', '请求内容过大', 413)
    this.child.stdin.write(line)
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // A mutating request may have reached Codex. Never retry it automatically.
        reject(new CodexError('rpc-timeout', 'Codex 请求超时；执行结果未知，请刷新会话后确认', 504))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method, params) { this.write({ method, params }) }
  respond(id, result) { this.write({ id, result }) }
  refuse(id, message = '此客户端不支持该权限请求') { this.write({ id, error: { code: -32601, message } }) }

  rejectAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    this.pending.clear()
  }

  fail(error) {
    if (this.closed) return
    this.emit('failure', error)
    this.rejectAll(error)
    this.stop()
  }

  stop() {
    if (this.closed) return
    this.closed = true
    this.rejectAll(new CodexError('stopped', 'Codex 连接已停止', 503))
    this.child?.stdin.end()
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM')
      const child = this.child
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 1500)
      timer.unref()
    }
  }
}
