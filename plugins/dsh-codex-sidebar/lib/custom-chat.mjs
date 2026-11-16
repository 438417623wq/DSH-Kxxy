import { CodexError } from './transport.mjs'
import { requestProvider } from './provider-http.mjs'
import { buildProviderPayload, createProtocolCollector, MAX_OUTPUT_CHARS } from './provider-protocols.mjs'

export { MAX_OUTPUT_CHARS }
export const MAX_CONTEXT_BYTES = 1024 * 1024
export const MAX_HISTORY_BYTES = 4 * 1024 * 1024

export function conversationMessages(thread, nextText) {
  const messages = []
  for (const turn of thread.turns ?? []) {
    if (turn.status !== 'completed') continue
    if (Array.isArray(turn.providerMessages)) { messages.push(...structuredClone(turn.providerMessages)); continue }
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') messages.push({ role: 'user', content: item.providerText ?? (item.content ?? []).map((entry) => entry.text ?? '').join('\n') })
      if (item.type === 'agentMessage' && item.text) messages.push({ role: 'assistant', content: item.text })
    }
  }
  messages.push({ role: 'user', content: nextText })
  validateMessages(messages)
  return messages
}

export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.some((message) => !message || typeof message !== 'object' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role))) throw new CodexError('model-messages', '对话消息格式不正确')
  let size
  try { size = Buffer.byteLength(JSON.stringify(messages)) } catch { throw new CodexError('model-messages', '对话消息不能序列化') }
  if (messages.length > 600 || size > MAX_CONTEXT_BYTES) throw new CodexError('context-limit', '对话上下文超过上限，请新建对话或减少引用文件', 413)
}

/** One provider round. Only its caller may execute terminal, schema-validated tool calls. */
export async function streamCustomChat({ model, messages, controller, signal, onDelta = () => {}, onReasoningDelta = () => {}, onToolCallDelta = () => {}, tools = [], stream = true, effort, maxOutputTokens, toolChoice = 'auto', parallelToolCalls = false, fetchImpl = globalThis.fetch, timeoutMs, firstByteTimeoutMs, idleTimeoutMs }) {
  validateMessages(messages)
  const request = buildProviderPayload({ model, messages, tools, stream, effort, maxOutputTokens, toolChoice, parallelToolCalls })
  const collector = createProtocolCollector({ ...request, parallelToolCalls, onDelta, onReasoningDelta, onToolCallDelta })
  try {
    const response = await requestProvider({ model: request.model, payload: request.payload, stream, controller, signal, fetchImpl, timeoutMs, firstByteTimeoutMs, idleTimeoutMs, onEvent: collector.event })
    if (!response.streamed) collector.parseJson(response.json)
    return { ...collector.finish(response), streamed: response.streamed }
  } catch (error) {
    if (error instanceof CodexError) error.details = { ...error.details, diagnostics: { category: 'protocol', ...error.details?.diagnostics, apiFormat: request.model.apiFormat, retryable: false } }
    throw error
  }
}
