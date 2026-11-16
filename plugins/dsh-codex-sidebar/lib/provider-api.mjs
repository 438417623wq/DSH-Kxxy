import { performance } from 'node:perf_hooks'
import { normalizeProvider, providerSecrets, redactProviderText, resolvedCompat } from './provider-config.mjs'
import { requestProvider, providerError } from './provider-http.mjs'
import { streamCustomChat } from './custom-chat.mjs'
import { CodexError } from './transport.mjs'

const MAX_REPLY_BYTES = 512 * 1024
const MAX_MODELS = 1000
const CHECKS = ['text', 'stream', 'tools']
const TEST_TOOL = { type: 'function', function: { name: 'provider_connection_echo', description: 'A connection-check-only echo. No files, commands, network or other side effects.', parameters: { type: 'object', properties: { value: { type: 'string', enum: ['connection-check'] } }, required: ['value'], additionalProperties: false } } }

/** Resolve edited or unsaved fields without returning or persisting credentials. */
export function providerConfiguration(input, { models, requireModel = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CodexError('model-input', '模型配置格式不正确')
  const saved = input.id ? models?.get(input.id) : null
  if (input.id && !saved) throw new CodexError('model-missing', '模型已被删除，请重新添加', 404)
  return normalizeProvider(input, { existing: saved, requireModel })
}

export async function fetchProviderModels(input, options = {}) {
  const provider = providerConfiguration(input, options)
  const start = performance.now()
  const result = await requestProvider({ ...options, model: provider, operation: 'models', stream: false, timeoutMs: options.timeoutMs ?? 20000, maxBytes: MAX_REPLY_BYTES, onEvent: () => { throw providerError('model-response', '模型列表接口未返回 JSON，请手动填写模型 ID', { apiFormat: provider.apiFormat }) } })
  const value = result.json
  if (!value || typeof value !== 'object' || value.error) throw providerError('model-response', '模型服务请求失败，请检查模型配置或服务状态', { apiFormat: provider.apiFormat })
  const entries = Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : Array.isArray(value) ? value : null
  if (!entries || entries.length > MAX_MODELS) throw providerError('models-response', '模型列表格式不正确或数量过多，请手动填写模型 ID', { apiFormat: provider.apiFormat })
  const found = new Map(), secrets = providerSecrets(provider)
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || secrets.some((secret) => id.includes(secret))) continue
    const name = typeof entry?.name === 'string' ? entry.name : typeof entry?.display_name === 'string' ? entry.display_name : id
    found.set(id.trim(), { id: id.trim(), name: redactProviderText(name, provider).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 256) })
  }
  if (!found.size) throw providerError('models-empty', '服务没有返回可用模型，请手动填写模型 ID', { apiFormat: provider.apiFormat })
  const models = [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
  return { models, count: models.length, latencyMs: Math.round(performance.now() - start) }
}

/** Deliberate diagnostics use the exact production protocol path and never execute provider tools. */
export async function testProviderModel(input, options = {}) {
  const provider = providerConfiguration(input, { ...options, requireModel: true })
  const check = input.check ?? 'text'
  if (!CHECKS.includes(check)) throw new CodexError('model-check', '请选择文字、流式或工具检查')
  const start = performance.now()
  const checks = CHECKS.map((id) => ({ id, status: 'untested', message: '尚未检查' }))
  const update = (id, value) => Object.assign(checks.find((item) => item.id === id), value)
  const round = (args) => streamCustomChat({ ...options, model: provider, timeoutMs: options.timeoutMs ?? 20000, maxOutputTokens: provider.maxOutputTokens ?? (provider.apiFormat === 'anthropic-messages' ? 4096 : 512), onDelta: () => {}, onReasoningDelta: () => {}, ...args })
  try {
    let response
    if (check === 'tools') {
      const messages = [{ role: 'user', content: 'This is a connection test. Call provider_connection_echo once with {"value":"connection-check"}. After the result, reply only OK.' }]
      const compat = resolvedCompat(provider)
      const forced = provider.apiFormat === 'anthropic-messages' && compat.reasoningFormat === 'thinking' && provider.reasoningEffort && provider.reasoningEffort !== 'none' ? 'auto' : { type: 'function', function: { name: TEST_TOOL.function.name } }
      const first = await round({ messages, tools: [TEST_TOOL], toolChoice: forced, stream: true })
      if (first.toolCalls.length !== 1 || first.toolCalls[0].name !== TEST_TOOL.function.name || first.finishReason !== 'tool_calls') throw providerError('model-test-tools', '服务未完成固定工具调用检查', { apiFormat: provider.apiFormat })
      const call = first.toolCalls[0]
      // A constant result is returned; no tool dispatcher, filesystem, shell or arbitrary callback.
      const assistant = { role: 'assistant', content: first.text, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }], ...(first.reasoningContent ? { reasoning_content: first.reasoningContent } : {}), ...(first.providerReplay ? { provider_replay: first.providerReplay } : {}) }
      response = await round({ messages: [...messages, assistant, { role: 'tool', tool_call_id: call.id, content: '{"value":"connection-check","ok":true}' }], stream: true })
      update('tools', { status: 'passed', message: '固定无副作用工具调用及结果回传成功' })
      update('text', { status: 'passed', message: '工具结果回传后已收到完整文字回复' })
      if (first.streamed && response.streamed) update('stream', { status: 'passed', message: '两轮流式响应均收到完整成功终态' })
    } else {
      response = await round({ messages: [{ role: 'user', content: 'This is a connection test. Reply with only OK.' }], stream: check === 'stream' })
      if (check === 'stream' && !response.streamed) throw providerError('model-test-stream', '服务忽略了流式请求并返回 JSON，尚未证明支持 SSE', { category: 'unsupported', apiFormat: provider.apiFormat })
      update('text', { status: 'passed', message: '已收到完整文字回复' })
      if (check === 'stream') update('stream', { status: 'passed', message: '已收到 SSE 输出和完整成功终态' })
    }
    if (!response.text.trim()) throw providerError('model-test-empty', '模型未返回文字回复，请检查模型 ID 与接口格式', { apiFormat: provider.apiFormat })
    return { ok: true, model: redactProviderText(provider.model, provider), latencyMs: Math.round(performance.now() - start), preview: redactProviderText(response.text, provider).slice(0, 180), checkedAt: new Date().toISOString(), checks }
  } catch (error) {
    const safe = error instanceof CodexError ? error : providerError('model-network', '模型检查失败，请检查网络或服务设置', { category: 'network', apiFormat: provider.apiFormat })
    if (safe.code === 'model-empty') { safe.code = 'model-test-empty'; safe.message = '模型未返回文字回复，请检查模型 ID 与接口格式' }
    const unsupported = ['model-unsupported', 'model-test-stream'].includes(safe.code)
    update(check, { status: unsupported ? 'unsupported' : 'failed', message: safe.message, code: safe.code, ...(safe.details?.diagnostics?.upstreamStatus ? { upstreamStatus: safe.details.diagnostics.upstreamStatus } : {}) })
    safe.details = { ...safe.details, checks, diagnostics: { category: unsupported ? 'unsupported' : 'protocol', apiFormat: provider.apiFormat, retryable: false, ...safe.details?.diagnostics } }
    throw safe
  }
}
