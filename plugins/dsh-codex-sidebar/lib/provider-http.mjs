import { CodexError } from './transport.mjs'
import { providerHeaders, providerUrl } from './provider-config.mjs'

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_EVENT_CHARS = 1024 * 1024
const MAX_TIMEOUT = 60 * 60 * 1000

export function providerError(code, message, { status = 502, category = 'protocol', apiFormat, upstreamStatus, phase } = {}) {
  const error = new CodexError(code, message, status)
  error.details = { diagnostics: { category, ...(apiFormat ? { apiFormat } : {}), ...(Number.isInteger(upstreamStatus) ? { upstreamStatus } : {}), ...(phase ? { phase } : {}), retryable: false } }
  return error
}

/** Incremental SSE framing. CR, LF and split CRLF are all first-class line endings. */
export function createSseParser(onEvent) {
  let line = '', name = '', data = [], size = 0, skipLf = false, first = true, stopped = false
  const dispatch = () => {
    if (data.length) stopped = onEvent({ event: name, data: data.join('\n') }) === true
    name = ''; data = []; size = 0
  }
  const endLine = () => {
    if (!line) dispatch()
    else if (!line.startsWith(':')) {
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') data.push(value)
      else if (field === 'event') name = value
    }
    line = ''
  }
  return {
    get stopped() { return stopped },
    push(text) {
      for (const char of text) {
        if (stopped) break
        if (first) { first = false; if (char === '\ufeff') continue }
        if (skipLf) { skipLf = false; if (char === '\n') continue }
        if (++size > MAX_EVENT_CHARS) throw providerError('model-output-limit', '模型流式事件超过大小上限', { status: 413, category: 'limit' })
        if (char === '\r' || char === '\n') { endLine(); skipLf = char === '\r' }
        else line += char
      }
    },
    finish() { if (!stopped) { if (line) endLine(); if (!stopped && data.length) dispatch() } },
  }
}

function duration(value, fallback) {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 1 || value > MAX_TIMEOUT) throw new CodexError('model-timeout-input', '请求超时必须是有效的正数毫秒值')
  return value
}
function cancelBody(body) {
  try { Promise.resolve(body?.cancel?.()).catch(() => {}) } catch {}
}

/** One request, no retries. Never expose upstream error bodies or fetch exception strings. */
export async function requestProvider({ model, payload, operation = 'generate', stream = true, controller = new AbortController(), signal, fetchImpl = globalThis.fetch, timeoutMs, firstByteTimeoutMs, idleTimeoutMs, maxBytes = MAX_RESPONSE_BYTES, onEvent = () => {} }) {
  const apiFormat = model.apiFormat
  // 超时三档是按「手机切后台」定的，不是按桌面网络定的：
  //   · 首字节 120s —— 推理模型思考阶段可以几十秒不出字，30s 会把正常请求判死；
  //   · 流间隔 90s —— 后台弱网/省电策略下的 TCP 抖动常在 30-60s 量级；
  //   · 总时长 600s —— 一轮工具调用加长回答，10 分钟是现实上限。
  // 三档都只是「多久放弃」，真正的抗抖动靠 service.mjs 在首包前的有界重试。
  const total = duration(timeoutMs, 600000)
  const firstByte = duration(firstByteTimeoutMs, Math.min(120000, total))
  const idle = duration(idleTimeoutMs, Math.min(90000, total))
  let reader, totalTimer, firstTimer, idleTimer, timeoutPhase, removeAbort, linkAbort
  let received = false
  const expire = (phase) => { timeoutPhase = phase; controller.abort(new Error('timeout')) }
  const abortError = () => providerError(timeoutPhase ? 'model-timeout' : 'model-cancelled', timeoutPhase ? '模型请求超时，已停止接收；重试请发送一条新消息' : '模型请求已停止', { status: timeoutPhase ? 504 : 409, category: timeoutPhase ? 'timeout' : 'cancelled', apiFormat, phase: timeoutPhase })
  try {
    if (typeof fetchImpl !== 'function') throw providerError('model-runtime', '当前运行时不支持模型 HTTP 请求', { status: 503, category: 'runtime', apiFormat })
    const url = providerUrl(model, operation)
    const headers = providerHeaders(model, { json: payload !== undefined, stream })
    if (signal && signal !== controller.signal) {
      linkAbort = () => controller.abort(signal.reason)
      if (signal.aborted) linkAbort()
      else signal.addEventListener('abort', linkAbort, { once: true })
    }
    if (controller.signal.aborted) throw abortError()
    const aborted = new Promise((_, reject) => {
      const onAbort = () => reject(abortError())
      controller.signal.addEventListener('abort', onAbort, { once: true })
      removeAbort = () => controller.signal.removeEventListener('abort', onAbort)
    })
    // The same rejection is raced for fetch and every read, even if a mock ignores its signal.
    aborted.catch(() => {})
    totalTimer = setTimeout(() => expire('total'), total)
    firstTimer = setTimeout(() => expire('first-byte'), firstByte)
    const pending = Promise.resolve().then(() => fetchImpl(url, {
      method: payload === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal, headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }))
    pending.then((response) => { if (controller.signal.aborted) cancelBody(response.body) }, () => {})
    const response = await Promise.race([pending, aborted])
    if (!response.ok) {
      cancelBody(response.body)
      const status = response.status
      const category = [401, 403].includes(status) ? 'authentication' : status === 404 ? 'endpoint' : status === 429 ? 'rate-limit' : 'http'
      const message = [401, 403].includes(status) ? '模型服务拒绝了密钥或权限，请检查认证设置' : status === 404 ? operation === 'models' ? '此服务未提供模型列表，请手动填写模型 ID' : '模型接口不存在，请检查 URL、接口类型和模型 ID' : status === 429 ? '模型服务请求过于频繁或额度不足，请稍后重试' : `模型服务返回 HTTP ${status}`
      throw providerError('model-http', message, { category, apiFormat, upstreamStatus: status })
    }
    if (!response.body || typeof response.body.getReader !== 'function') throw providerError('model-response', '模型服务返回了空响应', { apiFormat })
    reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const isJson = /application\/(?:[\w.-]+\+)?json\b/i.test(response.headers?.get?.('content-type') ?? '')
    const parser = isJson ? null : createSseParser(onEvent)
    let raw = '', bytes = 0
    while (!parser?.stopped) {
      const chunk = await Promise.race([reader.read(), aborted])
      if (chunk.done) break
      if (!chunk.value?.byteLength) continue
      if (!received) { received = true; clearTimeout(firstTimer) }
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => expire('idle'), idle)
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw providerError('model-output-limit', '模型响应超过大小上限，已停止接收', { status: 413, category: 'limit', apiFormat })
      let text
      try { text = decoder.decode(chunk.value, { stream: true }) } catch { throw providerError('model-response', '模型响应包含无效 UTF-8', { apiFormat }) }
      if (isJson) raw += text
      else parser.push(text)
    }
    if (controller.signal.aborted) throw abortError()
    let remaining
    try { remaining = decoder.decode() } catch { throw providerError('model-response', '模型响应包含不完整 UTF-8', { apiFormat }) }
    if (isJson) {
      raw += remaining
      let json
      try { json = JSON.parse(raw) } catch { throw providerError('model-response', '模型服务未返回有效 JSON，请检查 URL 和接口格式', { apiFormat }) }
      return { json, streamed: false }
    }
    parser.push(remaining)
    parser.finish()
    return { json: null, streamed: true }
  } catch (error) {
    if (controller.signal.aborted) throw abortError()
    if (error instanceof CodexError) {
      if (!error.details) error.details = { diagnostics: { category: 'protocol', apiFormat, retryable: false } }
      throw error
    }
    throw providerError('model-network', '无法连接模型服务，请检查 URL 和网络', { category: 'network', apiFormat })
  } finally {
    clearTimeout(totalTimer); clearTimeout(firstTimer); clearTimeout(idleTimer)
    removeAbort?.()
    if (linkAbort) signal.removeEventListener('abort', linkAbort)
    cancelBody(reader)
  }
}
