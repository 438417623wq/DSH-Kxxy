import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { streamCustomChat } from './custom-chat.mjs'
import { modelRevision, normalizeProvider, providerSecrets, providerUrl } from './provider-config.mjs'
import {
  BRIDGE_WARNINGS, BridgeError, decodeRequest, itemKeys, record, replayItemMatches,
  replayUnavailable, responsesUsage, stableJson, validateRound,
} from './responses-bridge-codec.mjs'

export { BridgeError } from './responses-bridge-codec.mjs'
export const DEFAULT_BRIDGE_LIMITS = Object.freeze({
  maxBodyBytes: 2 * 1024 * 1024, maxHeaderBytes: 16 * 1024,
  maxConnections: 32, maxConcurrent: 4, maxConcurrentPerBinding: 1, maxBindings: 128, maxCredentialVersions: 32,
  maxInputItems: 600, maxTools: 128, maxToolBytes: 1024 * 1024,
  maxOutputBytes: 2 * 1024 * 1024, maxArgumentBytes: 512 * 1024, maxOutputCalls: 40,
  maxReplayEntries: 64, maxReplayBytes: 8 * 1024 * 1024, maxReplayTotalBytes: 32 * 1024 * 1024,
  maxBufferedBytes: 512 * 1024, maxResponseBytes: 16 * 1024 * 1024,
  bodyTimeoutMs: 15000, headerTimeoutMs: 10000, socketTimeoutMs: 130000,
})
const SAFE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
const REMOVED_CREDENTIALS = new Set(['apiKey', 'name', 'displayName'])
const publicId = (prefix) => `${prefix}_dsh_${randomUUID().replaceAll('-', '')}`
const token = () => randomBytes(32).toString('base64url')
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value) }
  return value
}
function boundedInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024 * 1024) throw new BridgeError('bridge-config', `Invalid ${label}.`)
  return value
}
function semanticConfiguration(provider) { return stableJson(Object.fromEntries(Object.entries(provider).filter(([key]) => !REMOVED_CREDENTIALS.has(key)))) }
function privateProvider(provider) {
  let value
  try { value = normalizeProvider(structuredClone(provider)) } catch { throw new BridgeError('bridge-provider', 'Invalid private provider configuration.') }
  if (!['chat-completions', 'anthropic-messages'].includes(value.apiFormat)) throw new BridgeError('bridge-provider', 'This bridge only translates Chat Completions or Anthropic Messages; native Responses must use its original provider.')
  return deepFreeze(value)
}
function sameToken(value, expected) {
  if (typeof value !== 'string') return false
  const a = Buffer.from(value), b = Buffer.from(`Bearer ${expected}`)
  return a.length === b.length && timingSafeEqual(a, b)
}
function secretVariants(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value).flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))].sort((a, b) => b.length - a.length)
}
function containsSecret(text, secrets) { return secrets.some((secret) => text.includes(secret)) }
function redact(text, secrets) {
  for (const secret of secrets) text = text.split(secret).join('[redacted]')
  return text
}

/** Exact known-secret filtering with bounded look-behind, including split SSE chunks. */
class SecretWindow {
  constructor(secrets) { this.secrets = secrets; this.pending = ''; this.keep = Math.max(0, ...secrets.map((value) => value.length - 1)) }
  push(value, final = false) {
    this.pending += value
    let cutoff = final ? this.pending.length : Math.max(0, this.pending.length - this.keep)
    if (cutoff > 0 && cutoff < this.pending.length && /[\uD800-\uDBFF]/.test(this.pending[cutoff - 1]) && /[\uDC00-\uDFFF]/.test(this.pending[cutoff])) cutoff--
    let cursor = 0, output = ''
    while (cursor < cutoff) {
      let start = this.pending.length, match = ''
      for (const secret of this.secrets) {
        const index = this.pending.indexOf(secret, cursor)
        if (index !== -1 && (index < start || index === start && secret.length > match.length)) { start = index; match = secret }
      }
      if (!match || start >= cutoff) { output += this.pending.slice(cursor, cutoff); cursor = cutoff; break }
      output += this.pending.slice(cursor, start) + '[redacted]'
      cursor = start + match.length
    }
    this.pending = this.pending.slice(cursor)
    return output
  }
}

function safeFailure(error, controller) {
  if (controller?.signal.aborted) {
    const timeout = controller.signal.reason?.code === 'bridge-timeout'
    return { status: timeout ? 504 : 409, code: timeout ? 'bridge-timeout' : 'bridge-cancelled', message: timeout ? 'The upstream request timed out and was cancelled.' : 'The request was stopped and the upstream request was cancelled.', incomplete: 'interrupted' }
  }
  if (error instanceof BridgeError) return { status: error.status, code: error.code, message: error.message }
  if (error?.code === 'model-timeout') return { status: 504, code: 'bridge-timeout', message: 'The upstream request timed out and was cancelled.', incomplete: 'interrupted' }
  if (error?.code === 'model-cancelled') return { status: 409, code: 'bridge-cancelled', message: 'The model request was cancelled.', incomplete: 'interrupted' }
  if (['model-unsupported', 'effort-invalid', 'model-tokens'].includes(error?.code)) return { status: 400, code: 'bridge-unsupported', message: 'The bound provider configuration cannot represent the requested reasoning, token, tool-choice, or parallel-tool option.' }
  // Core errors and arbitrary fetch exceptions can contain headers or response bodies.
  // They never cross the loopback boundary verbatim, even for injected roundImpl.
  return { status: 502, code: 'bridge-upstream-failed', message: 'The upstream round failed validation or ended before a complete terminal response. No executable tool output was released.' }
}
function errorBody(failure) { return { error: { type: 'invalid_request_error', code: failure.code, message: failure.message, param: null } } }
function metadata(request) {
  const value = { ...request.metadata }
  if (request.warnings.length) value.dsh_bridge_warnings = request.warnings.join(',')
  return value
}
function responseObject(id, model, createdAt, request, status = 'in_progress', output = [], usage = null, failure = null) {
  return { id, object: 'response', created_at: createdAt, status, model, output, error: failure && !failure.incomplete ? { code: failure.code, message: failure.message } : null, incomplete_details: failure?.incomplete ? { reason: failure.incomplete } : null, usage, metadata: metadata(request), store: false, parallel_tool_calls: request.parallelToolCalls, tool_choice: request.responseToolChoice }
}

class ResponseWriter {
  constructor(response, controller, limits) {
    this.response = response; this.controller = controller; this.limits = limits
    this.sequence = 0; this.bytes = 0; this.streaming = false
  }
  start(warnings) {
    this.streaming = true
    this.response.writeHead(200, { ...SAFE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', ...(warnings.length ? { 'x-dsh-bridge-warnings': warnings.join(',') } : {}) })
    this.response.flushHeaders()
  }
  write(raw) {
    if (this.response.destroyed || this.response.writableEnded) throw new BridgeError('bridge-disconnected', 'The local client disconnected.', 409)
    const size = Buffer.byteLength(raw)
    if (this.bytes + size > this.limits.maxResponseBytes || this.response.writableLength + size > this.limits.maxBufferedBytes) {
      this.controller.abort(new BridgeError('bridge-backpressure', 'The local client is not consuming the response.', 413))
      this.response.destroy()
      throw new BridgeError('bridge-output-limit', 'The local response exceeded the buffering limit.', 413)
    }
    this.bytes += size
    this.response.write(raw)
  }
  event(type, fields = {}) {
    if (this.controller.signal.aborted && type !== 'response.failed' && type !== 'response.incomplete') throw this.controller.signal.reason
    this.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...fields })}\n\n`)
  }
  async drain() { if (this.response.writableNeedDrain) await once(this.response, 'drain', { signal: this.controller.signal }) }
  async send(type, fields = {}) { this.event(type, fields); await this.drain() }
  end() { if (!this.response.destroyed && !this.response.writableEnded) this.response.end() }
}

/**
 * A credential-scoped loopback Responses endpoint, not a general HTTP proxy.
 * start -> bind; abort retains replay; revoke removes it; rotateCredentials is idle-only.
 * Only this class owns its private maps. Nothing here executes a tool or a command.
 */
export class ResponsesBridge {
  #server = null
  #opening = null
  #closing = null
  #disposed = false
  #port = null
  #bindings = new Map()
  #routes = new Map()
  #sockets = new Set()
  #active = new Set()
  #replayTotalBytes = 0
  #fetchImpl
  #roundImpl
  #timeoutMs
  #limits
  #grammarMode

  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 120000, roundImpl = streamCustomChat, limits = {}, customGrammarMode = 'reject' } = {}) {
    if (typeof fetchImpl !== 'function' || typeof roundImpl !== 'function') throw new BridgeError('bridge-config', 'The bridge needs fetch and round implementations.')
    if (!['reject', 'wrap-known'].includes(customGrammarMode)) throw new BridgeError('bridge-config', 'Invalid custom grammar compatibility mode.')
    for (const key of Object.keys(limits)) if (!Object.hasOwn(DEFAULT_BRIDGE_LIMITS, key)) throw new BridgeError('bridge-config', 'Unknown bridge limit.')
    this.#limits = Object.freeze(Object.fromEntries(Object.entries({ ...DEFAULT_BRIDGE_LIMITS, ...limits }).map(([key, value]) => [key, boundedInteger(value, key)])))
    this.#timeoutMs = boundedInteger(timeoutMs, 'timeoutMs')
    this.#fetchImpl = fetchImpl; this.#roundImpl = roundImpl; this.#grammarMode = customGrammarMode
  }

  async start() {
    if (this.#disposed) throw new BridgeError('bridge-disposed', 'The bridge was disposed.', 503)
    if (this.#port) return
    if (this.#opening) return this.#opening
    this.#opening = (async () => {
      const server = createServer({ maxHeaderSize: this.#limits.maxHeaderBytes, requestTimeout: this.#limits.bodyTimeoutMs, headersTimeout: Math.min(this.#limits.headerTimeoutMs, this.#limits.bodyTimeoutMs) }, (req, res) => { void this.#handle(req, res) })
      this.#server = server
      server.maxHeadersCount = 64
      server.maxConnections = this.#limits.maxConnections
      server.keepAliveTimeout = 1000
      server.setTimeout(this.#limits.socketTimeoutMs, (socket) => socket.destroy())
      server.on('connection', (socket) => {
        if (this.#disposed || this.#sockets.size >= this.#limits.maxConnections) { socket.destroy(); return }
        this.#sockets.add(socket)
        socket.once('close', () => this.#sockets.delete(socket))
      })
      const rejectSocket = (socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); else socket.destroy() }
      server.on('clientError', (_error, socket) => rejectSocket(socket))
      server.on('upgrade', (_req, socket) => rejectSocket(socket))
      server.on('connect', (_req, socket) => rejectSocket(socket))
      server.on('checkContinue', (req, res) => this.#jsonError(req, res, { status: 417, code: 'bridge-unsupported', message: 'Expect requests are not supported.' }))
      server.on('checkExpectation', (req, res) => this.#jsonError(req, res, { status: 417, code: 'bridge-unsupported', message: 'Expect requests are not supported.' }))
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      if (this.#disposed) { await new Promise((resolve) => server.close(resolve)); return }
      this.#port = server.address().port
    })().finally(() => { this.#opening = null })
    return this.#opening
  }

  bind(provider, { bindingId = randomUUID(), scope = null } = {}) {
    if (!this.#port || this.#disposed) throw new BridgeError('bridge-not-started', 'Start the bridge before binding a provider.', 503)
    if (typeof bindingId !== 'string' || !bindingId || bindingId.length > 256 || scope !== null && (typeof scope !== 'string' || !scope || scope.length > 256)) throw new BridgeError('bridge-binding', 'Invalid binding or scope identifier.')
    if (this.#bindings.has(bindingId)) throw new BridgeError('bridge-binding-exists', 'A binding already exists. Never overwrite a live route; rotate credentials while idle or revoke explicitly.', 409)
    if (this.#bindings.size >= this.#limits.maxBindings) throw new BridgeError('bridge-bindings-limit', 'The bridge binding limit has been reached.', 429)
    const snapshot = privateProvider(provider)
    const route = `/dsh-responses/${token()}`
    const apiKey = token()
    const baseUrl = `http://127.0.0.1:${this.#port}${route}`
    const binding = { id: bindingId, scope, provider: snapshot, semantic: semanticConfiguration(snapshot), revision: modelRevision(snapshot), credentialVersions: new Set([snapshot.apiKey]), secrets: secretVariants(providerSecrets(snapshot)), route, apiKey, baseUrl, active: new Set(), replay: new Map(), replayIndex: new Map(), replayBytes: 0 }
    this.#bindings.set(bindingId, binding)
    this.#routes.set(`${route}/responses`, binding)
    return Object.freeze({ baseUrl, apiKey })
  }

  rotateCredentials(bindingId, provider) {
    const binding = this.#bindings.get(bindingId)
    if (!binding) throw new BridgeError('bridge-binding-missing', 'The binding does not exist.', 404)
    if (binding.active.size) throw new BridgeError('bridge-busy', 'Credentials can only change while the binding is idle.', 409)
    const snapshot = privateProvider(provider)
    if (modelRevision(snapshot) !== binding.revision || semanticConfiguration(snapshot) !== binding.semantic) throw new BridgeError('bridge-provider-changed', 'Only credentials and display names may change on an existing binding. Semantic configuration changes require a new thread.', 409)
    if (!binding.credentialVersions.has(snapshot.apiKey) && binding.credentialVersions.size >= this.#limits.maxCredentialVersions) throw new BridgeError('bridge-credentials-limit', 'The binding credential-version limit was reached. Start a new thread rather than forgetting secrets used in this history.', 409)
    binding.credentialVersions.add(snapshot.apiKey)
    binding.secrets = secretVariants([...binding.secrets, ...providerSecrets(snapshot)])
    binding.provider = snapshot
    return Object.freeze({ baseUrl: binding.baseUrl, apiKey: binding.apiKey })
  }

  /**
   * Server-only authorization after validating the native fork's inclusive prefix.
   * Scopes and HTTP input never grant access to another binding. Only complete
   * rounds whose every public output is explicitly allowed may cross this boundary.
   * Missing references poison the target until revoke: native item IDs can differ
   * from wire IDs, and Chat history must not silently fall back to lossy replay.
   */
  forkReplay(sourceBindingId, targetBindingId, allowlist = {}) {
    const source = this.#bindings.get(sourceBindingId), target = this.#bindings.get(targetBindingId)
    if (!source || !target) throw new BridgeError('bridge-binding-missing', 'Both replay bindings must exist.', 404)
    if (source.active.size || target.active.size) throw new BridgeError('bridge-busy', 'Replay can only be inherited while both bindings are idle.', 409)
    if (source === target || !source.scope || !target.scope || source.scope === target.scope) throw new BridgeError('bridge-replay-scope', 'Replay inheritance requires distinct, explicit thread scopes.', 409)
    if (typeof source.provider.id !== 'string' || !source.provider.id || source.provider.id !== target.provider.id || source.revision !== target.revision || source.semantic !== target.semantic) throw new BridgeError('bridge-provider-changed', 'Replay inheritance requires the same provider and semantic model configuration.', 409)
    if (target.replayForked || target.replay.size || target.replayIndex.size || target.replayBytes) throw new BridgeError('bridge-replay-target', 'Replay inheritance requires an empty, not previously initialized target cache.', 409)
    if (source.replayIncomplete) replayUnavailable()
    if (!record(allowlist) || Object.keys(allowlist).some((key) => !['itemIds', 'callIds'].includes(key)) || !['itemIds', 'callIds'].some((key) => Object.hasOwn(allowlist, key))) throw new BridgeError('bridge-replay-allowlist', 'An explicit, bounded replay reference allowlist is required.')
    const references = (key) => {
      if (!Object.hasOwn(allowlist, key)) return new Set()
      const values = allowlist[key]
      if (!Array.isArray(values) || values.length > this.#limits.maxInputItems) throw new BridgeError('bridge-replay-allowlist', 'Replay references must fit the input-item limit.')
      for (const value of values) if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new BridgeError('bridge-replay-allowlist', 'Replay references must be valid bounded item or call identifiers.')
      return new Set(values)
    }
    const itemIds = references('itemIds'), callIds = references('callIds')
    const allowed = new Set([...itemIds].map((id) => `id:${id}`).concat([...callIds].map((id) => `call:${id}`)))
    const selected = []
    for (const entry of source.replay.values()) {
      if (!entry.items.length || !entry.items.every((item) => record(item) && ['message', 'reasoning', 'function_call', 'custom_tool_call'].includes(item.type) && itemKeys(item).some((key) => allowed.has(key)))) continue
      if (entry.revision !== source.revision) replayUnavailable()
      selected.push(entry)
    }
    const bytes = selected.reduce((sum, entry) => sum + entry.bytes, 0)
    // Unlike ordinary LRU insertion, a fork must never evict or mutate its source
    // (or unrelated bindings) just to make the duplicate fit. Failure is atomic.
    if (selected.length > this.#limits.maxReplayEntries || bytes > this.#limits.maxReplayBytes || this.#replayTotalBytes + bytes > this.#limits.maxReplayTotalBytes) throw new BridgeError('bridge-replay-limit', 'The inherited history exceeds the available private replay cache budget.', 413)
    const credentialVersions = new Set([...target.credentialVersions, ...source.credentialVersions])
    if (credentialVersions.size > this.#limits.maxCredentialVersions) throw new BridgeError('bridge-credentials-limit', 'The inherited history exceeds the retained credential-version limit.', 409)
    // Keep target authentication independent, but redact old provider credentials
    // and source route/token values if private historical text later echoes them.
    // Merge normalized variants without repeatedly escaping ancestor secrets.
    const replaySecrets = selected.flatMap((entry) => (entry.message.provider_replay?.content ?? []).flatMap((block) => [block.signature, block.type === 'redacted_thinking' ? block.data : null]))
    const secrets = [...new Set([...target.secrets, ...source.secrets, ...secretVariants([source.apiKey, source.route, ...replaySecrets])])].sort((a, b) => b.length - a.length)
    if (Buffer.byteLength(JSON.stringify(secrets)) > this.#limits.maxReplayBytes) throw new BridgeError('bridge-credentials-limit', 'The inherited secret-redaction history exceeds its bounded storage budget.', 409)
    const found = new Set(selected.flatMap((entry) => entry.keys))
    const missing = { itemIds: [...itemIds].filter((id) => !found.has(`id:${id}`)), callIds: [...callIds].filter((id) => !found.has(`call:${id}`)) }
    const copies = selected.map((entry) => structuredClone(entry))
    for (const entry of copies) {
      target.replay.set(entry.id, entry)
      for (const key of entry.keys) target.replayIndex.set(key, entry.id)
    }
    target.replayBytes = bytes; this.#replayTotalBytes += bytes
    target.credentialVersions = credentialVersions; target.secrets = secrets
    target.replayForked = true
    target.replayIncomplete = !!(missing.itemIds.length || missing.callIds.length)
    return { copied: copies.length, missing }
  }

  abort(bindingId) {
    const bindings = bindingId === undefined ? this.#bindings.values() : [this.#bindings.get(bindingId)].filter(Boolean)
    for (const binding of bindings) for (const controller of binding.active) controller.abort(new BridgeError('bridge-cancelled', 'The local request was stopped.', 409))
  }
  revoke(bindingId) {
    const bindings = bindingId === undefined ? [...this.#bindings.values()] : [this.#bindings.get(bindingId)].filter(Boolean)
    for (const binding of bindings) {
      this.abort(binding.id)
      this.#routes.delete(`${binding.route}/responses`)
      this.#bindings.delete(binding.id)
      for (const key of [...binding.replay.keys()]) this.#removeReplay(binding, key)
    }
  }
  clear() { this.revoke() }
  async dispose() {
    if (this.#closing) return this.#closing
    this.#disposed = true
    this.#closing = (async () => {
      this.revoke()
      await this.#opening?.catch(() => {})
      for (const socket of this.#sockets) socket.destroy()
      if (this.#server?.listening) await new Promise((resolve) => this.#server.close(resolve))
      this.#server = null; this.#port = null
    })()
    return this.#closing
  }

  #jsonError(req, res, failure) {
    if (res.destroyed || res.writableEnded) return
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(failure.status, { ...SAFE_HEADERS, 'content-type': 'application/json; charset=utf-8', connection: 'close' })
    res.end(JSON.stringify(errorBody(failure)))
    req.resume()
  }
  #authenticate(req) {
    if (this.#disposed) throw new BridgeError('bridge-disposed', 'The bridge is unavailable.', 503)
    if (req.socket.remoteAddress !== '127.0.0.1') throw new BridgeError('bridge-forbidden', 'Only loopback clients are accepted.', 403)
    if (req.headers.host !== `127.0.0.1:${this.#port}`) throw new BridgeError('bridge-host', 'The exact loopback Host header is required.', 403)
    if (req.headers.origin !== undefined || req.headers.referer !== undefined || req.headers['sec-fetch-site'] !== undefined) throw new BridgeError('bridge-origin', 'Browser-origin and cross-site requests are not accepted.', 403)
    if (req.method !== 'POST') throw new BridgeError('bridge-method', 'Only POST responses requests are accepted.', 405)
    if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.includes('?') || req.url.includes('#')) throw new BridgeError('bridge-route', 'Unknown local bridge endpoint.', 404)
    const binding = this.#routes.get(req.url)
    if (!binding) throw new BridgeError('bridge-route', 'Unknown local bridge endpoint. Compact and other endpoints are not supported.', 404)
    const counts = new Map()
    for (let i = 0; i < req.rawHeaders.length; i += 2) { const key = req.rawHeaders[i].toLowerCase(); counts.set(key, (counts.get(key) ?? 0) + 1) }
    if (['host', 'authorization', 'content-type', 'content-length'].some((key) => (counts.get(key) ?? 0) > 1)) throw new BridgeError('bridge-headers', 'Ambiguous HTTP request headers are not accepted.')
    if (!sameToken(req.headers.authorization, binding.apiKey)) throw new BridgeError('bridge-auth', 'A valid local binding bearer token is required.', 401)
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new BridgeError('bridge-content-type', 'Use application/json with UTF-8 encoding.', 415)
    if (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') throw new BridgeError('bridge-content-encoding', 'Compressed request bodies are not accepted.', 415)
    const length = req.headers['content-length']
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > this.#limits.maxBodyBytes)) throw new BridgeError('bridge-body-limit', 'The request body exceeds the bridge limit.', 413)
    if (binding.active.size >= this.#limits.maxConcurrentPerBinding || this.#active.size >= this.#limits.maxConcurrent) throw new BridgeError('bridge-busy', 'The bridge concurrency limit has been reached.', 429)
    return binding
  }
  async #readBody(req, controller) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0
      const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', error); controller.signal.removeEventListener('abort', aborted) }
      const fail = (reason) => { cleanup(); reject(reason) }
      const data = (chunk) => {
        size += chunk.length
        if (size > this.#limits.maxBodyBytes) { req.pause(); fail(new BridgeError('bridge-body-limit', 'The request body exceeds the bridge limit.', 413)); return }
        chunks.push(chunk)
      }
      const end = () => {
        cleanup()
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
          resolve(JSON.parse(text))
        } catch { reject(new BridgeError('bridge-invalid-json', 'A complete valid UTF-8 JSON request is required.')) }
      }
      const error = () => fail(new BridgeError('bridge-body', 'The local request body was interrupted.', 400))
      const aborted = () => fail(controller.signal.reason)
      const timer = setTimeout(() => fail(new BridgeError('bridge-body-timeout', 'The local request body timed out.', 408)), this.#limits.bodyTimeoutMs)
      timer.unref?.()
      req.on('data', data); req.once('end', end); req.once('error', error); controller.signal.addEventListener('abort', aborted, { once: true })
      if (controller.signal.aborted) aborted()
    })
  }

  #lookupReplay(binding, items, offset) {
    const first = items[offset]
    let entry
    for (const key of itemKeys(first)) {
      const id = binding.replayIndex.get(key)
      if (id !== undefined) { entry = binding.replay.get(id); if (entry) break }
    }
    if (!entry) return null
    if (entry.revision !== binding.revision || offset + entry.items.length > items.length) replayUnavailable()
    for (let i = 0; i < entry.items.length; i++) if (!replayItemMatches(entry.items[i], items[offset + i])) replayUnavailable()
    // LRU is private to this binding; no route, scope or caller-supplied response ID
    // can search another binding's signed provider content.
    binding.replay.delete(entry.id); binding.replay.set(entry.id, entry)
    return { count: entry.items.length, message: entry.message }
  }
  #removeReplay(binding, id) {
    const entry = binding.replay.get(id)
    if (!entry) return
    binding.replay.delete(id)
    for (const key of entry.keys) if (binding.replayIndex.get(key) === id) binding.replayIndex.delete(key)
    binding.replayBytes -= entry.bytes; this.#replayTotalBytes -= entry.bytes
  }
  #saveReplay(binding, id, items, message) {
    const savedItems = structuredClone(items)
    const entry = { id, revision: binding.revision, items: savedItems, message: structuredClone(message), keys: savedItems.flatMap(itemKeys), bytes: 0 }
    entry.bytes = Buffer.byteLength(JSON.stringify(entry))
    if (entry.bytes > this.#limits.maxReplayBytes || entry.bytes > this.#limits.maxReplayTotalBytes) throw new BridgeError('bridge-replay-limit', 'This complete round exceeds the private replay cache limit; no tools were released.', 413)
    for (const key of entry.keys) if (binding.replayIndex.has(key)) throw new BridgeError('bridge-replay-collision', 'The provider reused a history identifier; no tools were released.', 502)
    while (binding.replay.size >= this.#limits.maxReplayEntries || binding.replayBytes + entry.bytes > this.#limits.maxReplayBytes) this.#removeReplay(binding, binding.replay.keys().next().value)
    while (this.#replayTotalBytes + entry.bytes > this.#limits.maxReplayTotalBytes) {
      const owner = [...this.#bindings.values()].find((candidate) => candidate.replay.size)
      if (!owner) break
      this.#removeReplay(owner, owner.replay.keys().next().value)
    }
    binding.replay.set(id, entry)
    for (const key of entry.keys) binding.replayIndex.set(key, id)
    binding.replayBytes += entry.bytes; this.#replayTotalBytes += entry.bytes
  }

  async #handle(req, res) {
    let binding, controller, writer, timer, heartbeat, disconnected, onAborted, responseId, createdAt, request, secrets
    let textItem = null, visibleText = '', rawText = '', savedReplay = false, receivedTextBytes = 0
    try {
      binding = this.#authenticate(req)
      controller = new AbortController()
      binding.active.add(controller); this.#active.add(controller)
      disconnected = () => { if (!res.writableFinished) controller.abort(new BridgeError('bridge-disconnected', 'The local client disconnected.', 409)) }
      onAborted = () => controller.abort(new BridgeError('bridge-disconnected', 'The local request was aborted.', 409))
      req.socket.once('close', disconnected); res.once('close', disconnected); req.once('aborted', onAborted)
      timer = setTimeout(() => controller.abort(new BridgeError('bridge-timeout', 'The upstream request timed out.', 504)), this.#timeoutMs)
      timer.unref?.()
      const payload = await this.#readBody(req, controller)
      if (binding.replayIncomplete) replayUnavailable()
      request = decodeRequest(payload, { provider: binding.provider, customGrammarMode: this.#grammarMode, limits: this.#limits, lookupReplay: (items, offset) => this.#lookupReplay(binding, items, offset) })
      secrets = secretVariants([...binding.secrets, binding.apiKey, binding.route])
      if (containsSecret(JSON.stringify({ metadata: request.metadata, tool_choice: request.responseToolChoice }), secrets)) throw new BridgeError('bridge-private-data', 'Request metadata and selected tool identity cannot contain private provider data.')
      if (containsSecret(binding.provider.model, secrets)) throw new BridgeError('bridge-provider', 'The model identifier must not contain provider credentials.')
      responseId = publicId('resp'); createdAt = Math.floor(Date.now() / 1000)
      writer = new ResponseWriter(res, controller, this.#limits)
      const filter = new SecretWindow(secrets)
      let visibleTextBytes = 0
      const emitText = (delta) => {
        if (!delta) return
        visibleText += delta
        visibleTextBytes += Buffer.byteLength(delta)
        if (visibleTextBytes > this.#limits.maxOutputBytes) throw new BridgeError('bridge-output-limit', 'The model text exceeds the bridge limit.', 413)
        if (!request.stream) return
        if (!textItem) {
          textItem = { type: 'message', id: publicId('msg'), status: 'in_progress', role: 'assistant', content: [] }
          writer.event('response.output_item.added', { output_index: 0, item: textItem })
          writer.event('response.content_part.added', { item_id: textItem.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        }
        // Keep SSE writes bounded even when a provider emits a whole JSON reply
        // as one delta; UTF-16 pairs must stay together for the Rust JSON parser.
        for (let start = 0; start < delta.length;) {
          let end = Math.min(delta.length, start + 4096)
          if (end < delta.length && /[\uD800-\uDBFF]/.test(delta[end - 1]) && /[\uDC00-\uDFFF]/.test(delta[end])) end--
          writer.event('response.output_text.delta', { item_id: textItem.id, output_index: 0, content_index: 0, delta: delta.slice(start, end) })
          start = end
        }
      }
      if (request.stream) {
        writer.start(request.warnings)
        writer.event('response.created', { response: responseObject(responseId, binding.provider.model, createdAt, request) })
        writer.event('response.in_progress', { response: responseObject(responseId, binding.provider.model, createdAt, request) })
        heartbeat = setInterval(() => { try { if (!controller.signal.aborted) writer.write(': keep-alive\n\n') } catch {} }, 10000)
        heartbeat.unref?.()
      }
      const endpoint = providerUrl(binding.provider)
      let fetchStarted = false
      const guardedFetch = (url, options = {}) => {
        // The provider URL is resolved once from the immutable snapshot. Neither
        // incoming body fields nor a custom round implementation can redirect it.
        if (typeof url !== 'string' || url !== endpoint) throw new BridgeError('bridge-upstream-route', 'Only the bound provider endpoint can be requested.', 502)
        if (options.method !== 'POST') throw new BridgeError('bridge-upstream-route', 'Only a bound provider POST is allowed.', 502)
        if (fetchStarted) throw new BridgeError('bridge-retry-forbidden', 'A bridge round can issue only one upstream request; automatic retries are disabled.', 502)
        fetchStarted = true
        const signal = options.signal && options.signal !== controller.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
        return this.#fetchImpl(endpoint, { ...options, redirect: 'error', signal })
      }
      const round = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason
        return this.#roundImpl({
        model: structuredClone(binding.provider), messages: request.messages, tools: request.tools,
        controller, stream: request.stream, effort: request.effort, maxOutputTokens: request.maxOutputTokens,
        toolChoice: request.toolChoice, parallelToolCalls: request.parallelToolCalls,
        fetchImpl: guardedFetch, timeoutMs: this.#timeoutMs,
        onDelta: (delta) => {
          if (controller.signal.aborted) throw controller.signal.reason
          if (typeof delta !== 'string') throw new BridgeError('bridge-upstream-protocol', 'Invalid upstream text delta.', 502)
          rawText += delta
          receivedTextBytes += Buffer.byteLength(delta)
          if (receivedTextBytes > this.#limits.maxOutputBytes) throw new BridgeError('bridge-output-limit', 'The model text exceeds the bridge limit.', 413)
          emitText(filter.push(delta))
        },
        // Reasoning, signatures, and redacted blocks never enter output_text.
        // The complete providerReplay is handled only after terminal validation.
        onReasoningDelta: () => {},
        })
      })
      let abortListener
      const aborted = new Promise((_resolve, reject) => {
        abortListener = () => reject(controller.signal.reason)
        if (controller.signal.aborted) abortListener()
        else controller.signal.addEventListener('abort', abortListener, { once: true })
      })
      let result
      try { result = await Promise.race([round, aborted]) } finally { controller.signal.removeEventListener('abort', abortListener) }
      if (controller.signal.aborted) throw controller.signal.reason
      const validated = validateRound(result, request, this.#limits)
      if (!validated.text.startsWith(rawText)) throw new BridgeError('bridge-upstream-protocol', 'Final provider text did not match the streamed deltas.', 502)
      emitText(filter.push(validated.text.slice(rawText.length), true))
      const usage = responsesUsage(result.usage)
      const replay = this.#validateProviderReplay(result, binding.provider.apiFormat)
      const replaySecrets = secretVariants((replay?.content ?? []).flatMap((block) => [block.signature, block.type === 'redacted_thinking' ? block.data : null]))
      const allSecrets = secretVariants([...secrets, ...replaySecrets])
      // Tool arguments cannot be rewritten: that would change executable meaning.
      // Reject private data in any executable field instead of silently redacting it.
      for (const call of validated.calls) if (containsSecret(JSON.stringify(call), allSecrets)) throw new BridgeError('bridge-private-data', 'The model placed private provider data in a tool call; no tool was released.', 502)
      if (containsSecret(visibleText, replaySecrets)) throw new BridgeError('bridge-private-data', 'The provider mixed signed private data into ordinary text; the round was rejected.', 502)
      const output = []
      if (visibleText) {
        textItem ??= { type: 'message', id: publicId('msg'), role: 'assistant' }
        textItem = { ...textItem, status: 'completed', content: [{ type: 'output_text', text: visibleText, annotations: [] }] }
        output.push(textItem)
      }
      const visibleReasoning = request.showReasoning ? redact(validated.reasoningContent, allSecrets) : ''
      if (visibleReasoning) output.push({ type: 'reasoning', id: publicId('rs'), summary: [], content: [{ type: 'reasoning_text', text: visibleReasoning }] })
      for (const call of validated.calls) output.push({ type: call.tool.type === 'custom' ? 'custom_tool_call' : 'function_call', id: publicId(call.tool.type === 'custom' ? 'ct' : 'fc'), status: 'completed', call_id: call.id, name: call.tool.name, ...(call.tool.namespace == null ? {} : { namespace: call.tool.namespace }), ...(call.tool.type === 'custom' ? { input: call.input } : { arguments: call.arguments }) })
      if (replay) {
        // Reasoning has its own Responses channel. Exact Anthropic block order,
        // including signatures and redacted blocks, is retained privately; never
        // reconstruct signed history from this public text/tool projection.
        const replayText = replay.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
        const replayReasoning = replay.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join('')
        const replayCalls = replay.content.filter((block) => block.type === 'tool_use')
        if (replayText !== validated.text || replayReasoning !== validated.reasoningContent || replayCalls.length !== validated.calls.length || replayCalls.some((block, index) => block.id !== validated.calls[index].id || block.name !== validated.calls[index].tool.flatName || stableJson(block.input) !== stableJson(JSON.parse(validated.calls[index].arguments)))) throw new BridgeError('bridge-upstream-protocol', 'Private provider replay does not match the complete text, reasoning, and tool calls.', 502)
      }
      const message = { role: 'assistant', content: validated.text, ...(validated.reasoningContent ? { reasoning_content: validated.reasoningContent } : {}), ...(validated.calls.length ? { tool_calls: validated.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.tool.flatName, arguments: call.arguments } })) } : {}), ...(replay ? { provider_replay: replay } : {}) }
      const response = responseObject(responseId, binding.provider.model, createdAt, request, 'completed', output, usage)
      const responseBytes = Buffer.byteLength(JSON.stringify(response))
      if (responseBytes + 512 > this.#limits.maxBufferedBytes || responseBytes + writer.bytes + 512 > this.#limits.maxResponseBytes) throw new BridgeError('bridge-output-limit', 'The final response exceeds the bounded local output buffer; no tool was released.', 413)
      this.#saveReplay(binding, responseId, output, message); savedReplay = true
      if (request.stream) {
        for (const [index, item] of output.entries()) {
          if (controller.signal.aborted) throw controller.signal.reason
          if (item.type === 'message') {
            await writer.send('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: visibleText })
            await writer.send('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part: item.content[0] })
            await writer.send('response.output_item.done', { output_index: index, item })
          } else if (item.type === 'reasoning') {
            await writer.send('response.output_item.added', { output_index: index, item: { ...item, content: [] } })
            await writer.send('response.reasoning_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: visibleReasoning })
            await writer.send('response.reasoning_text.done', { item_id: item.id, output_index: index, content_index: 0, text: visibleReasoning })
            await writer.send('response.output_item.done', { output_index: index, item })
          } else {
            const custom = item.type === 'custom_tool_call', field = custom ? 'input' : 'arguments'
            await writer.send('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', [field]: '' } })
            const event = custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments'
            // Fragment only after validation, keeping wire buffers bounded.
            for (let start = 0; start < item[field].length;) {
              let end = Math.min(item[field].length, start + 4096)
              if (end < item[field].length && /[\uD800-\uDBFF]/.test(item[field][end - 1]) && /[\uDC00-\uDFFF]/.test(item[field][end])) end--
              await writer.send(`${event}.delta`, { item_id: item.id, output_index: index, ...(custom ? { call_id: item.call_id } : {}), delta: item[field].slice(start, end) })
              start = end
            }
            await writer.send(`${event}.done`, { item_id: item.id, output_index: index, [field]: item[field] })
            await writer.send('response.output_item.done', { output_index: index, item })
          }
        }
        if (controller.signal.aborted) throw controller.signal.reason
        await writer.send('response.completed', { response })
        writer.end()
      } else {
        res.writeHead(200, { ...SAFE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...(request.warnings.length ? { 'x-dsh-bridge-warnings': request.warnings.join(',') } : {}) })
        res.end(JSON.stringify(response))
      }
    } catch (error) {
      if (savedReplay && binding && responseId) this.#removeReplay(binding, responseId)
      const failure = safeFailure(error, controller)
      if (controller && !controller.signal.aborted) controller.abort(new BridgeError('bridge-cancelled', 'The failed local request was cancelled.', 409))
      if (writer?.streaming && !res.destroyed && !res.writableEnded) {
        try {
          const output = textItem && visibleText ? [{ ...textItem, status: 'incomplete', content: [{ type: 'output_text', text: visibleText, annotations: [] }] }] : []
          writer.event(failure.incomplete ? 'response.incomplete' : 'response.failed', { response: responseObject(responseId, binding.provider.model, createdAt, request, failure.incomplete ? 'incomplete' : 'failed', output, null, failure) })
          writer.end()
        } catch { res.destroy() }
      } else this.#jsonError(req, res, failure)
    } finally {
      clearTimeout(timer); clearInterval(heartbeat)
      if (controller) { binding?.active.delete(controller); this.#active.delete(controller) }
      if (disconnected) { req.socket.off('close', disconnected); res.off('close', disconnected) }
      if (onAborted) req.off('aborted', onAborted)
    }
  }
  #validateProviderReplay(result, format) {
    if (result.providerReplay == null) {
      if (format === 'anthropic-messages') throw new BridgeError('bridge-replay-unavailable', 'The Anthropic provider did not return complete private replay blocks. No executable tool output was released.', 502)
      return null
    }
    const replay = result.providerReplay
    if (!record(replay) || replay.apiFormat !== format || format !== 'anthropic-messages' || !Array.isArray(replay.content) || !replay.content.length) throw new BridgeError('bridge-upstream-protocol', 'The provider replay metadata has an invalid protocol or shape.', 502)
    for (const block of replay.content) {
      if (!record(block) || !['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type)) throw new BridgeError('bridge-upstream-protocol', 'Unsupported private provider replay block.', 502)
      if (block.type === 'text' && typeof block.text !== 'string') throw new BridgeError('bridge-upstream-protocol', 'Invalid private text replay block.', 502)
      if (block.type === 'tool_use' && (typeof block.id !== 'string' || typeof block.name !== 'string' || !record(block.input))) throw new BridgeError('bridge-upstream-protocol', 'Invalid private tool replay block.', 502)
      if (block.type === 'thinking' && (typeof block.thinking !== 'string' || typeof block.signature !== 'string' || !block.signature)) replayUnavailable()
      if (block.type === 'redacted_thinking' && (typeof block.data !== 'string' || !block.data)) replayUnavailable()
    }
    return structuredClone(replay)
  }
}

// Static, non-secret capability descriptions for diagnostics; never provider details.
export const RESPONSES_BRIDGE_WARNINGS = BRIDGE_WARNINGS
