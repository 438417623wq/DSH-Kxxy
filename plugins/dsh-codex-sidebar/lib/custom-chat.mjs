import { CodexError } from './transport.mjs'
import { requestProvider } from './provider-http.mjs'
import { buildProviderPayload, createProtocolCollector, MAX_OUTPUT_CHARS } from './provider-protocols.mjs'

export { MAX_OUTPUT_CHARS }
export const MAX_CONTEXT_BYTES = 1024 * 1024
export const MAX_HISTORY_BYTES = 4 * 1024 * 1024

/** Replay payloads are private to the vendor that produced them and must not cross providers. */
const PRIVATE_REPLAY = ['responses_output', 'provider_replay', 'reasoning_content']
/** Statuses whose context can still be replayed; a live turn is never part of a new request. */
const CONTEXT_STATUSES = new Set(['completed', 'interrupted', 'failed'])
const INTERRUPTED_NOTE = '\n\n[上一轮回复在生成中途被停止，以上内容不完整。]'
const SKIPPED_TOOL_RESULT = { ok: false, code: 'tool-not-executed', error: '上一轮在工具执行前已停止，该工具没有被执行。' }

export function stripProviderPrivate(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message
  const copy = { ...message }
  for (const key of PRIVATE_REPLAY) delete copy[key]
  return copy
}

function messagesFromItems(turn) {
  const messages = []
  for (const item of turn.items ?? []) {
    if (item.type === 'userMessage') messages.push({ role: 'user', content: item.providerText ?? (item.content ?? []).map((entry) => entry.text ?? '').join('\n') })
    if (item.type === 'agentMessage' && item.text) messages.push({ role: 'assistant', content: item.text })
  }
  return messages
}

const callIds = (message) => Array.isArray(message?.tool_calls) ? message.tool_calls.map((call) => call?.id).filter((id) => typeof id === 'string') : []

/**
 * A turn that was stopped mid-flight can end with assistant tool_calls that never got their
 * `tool` results. Every supported protocol requires the pair, so synthesize an explicit
 * "not executed" result instead of dropping the whole turn or tripping a 400 from upstream.
 */
function repaired(messages) {
  const answered = new Set(messages.filter((message) => message?.role === 'tool').map((message) => message.tool_call_id))
  const result = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    result.push(message)
    const ids = callIds(message)
    if (message?.role !== 'assistant' || !ids.length) continue
    let next = index + 1
    while (next < messages.length && messages[next]?.role === 'tool' && ids.includes(messages[next].tool_call_id)) {
      result.push(messages[next])
      next += 1
    }
    for (const id of ids) if (!answered.has(id)) {
      answered.add(id)
      result.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(SKIPPED_TOOL_RESULT) })
    }
    index = next - 1
  }
  return result
}

/** Persist whatever the model already produced before the turn was stopped or failed. */
export function recordInterruptedTurn(turn, agent) {
  if (!Array.isArray(turn.providerMessages) || typeof agent?.text !== 'string' || !agent.text) return false
  const last = turn.providerMessages.at(-1)
  if (last?.role === 'assistant' && last.content === agent.text) return false
  turn.providerMessages.push({ role: 'assistant', content: agent.text })
  return true
}

/** Protocol-safe replay of one turn. Unfinished turns keep their usable context. */
export function turnMessages(turn, { stripPrivate = false } = {}) {
  if (!CONTEXT_STATUSES.has(turn.status ?? 'completed')) return []
  const messages = Array.isArray(turn.providerMessages) ? structuredClone(turn.providerMessages) : messagesFromItems(turn)
  if (turn.status === 'completed') return stripPrivate ? messages.map(stripProviderPrivate) : messages
  const text = [...(turn.items ?? [])].reverse().find((item) => item.type === 'agentMessage' && item.text)?.text
  const marked = text && !text.includes(INTERRUPTED_NOTE) ? `${text}${INTERRUPTED_NOTE}` : text
  const last = messages.at(-1)
  if (text && last?.role === 'assistant' && last.content === text) messages[messages.length - 1] = { ...last, content: marked }
  else if (text && !messages.some((message) => message.role === 'assistant' && message.content === text)) messages.push({ role: 'assistant', content: marked })
  const complete = repaired(messages)
  return stripPrivate ? complete.map(stripProviderPrivate) : complete
}

export function conversationMessages(thread, nextText, { stripPrivate = false } = {}) {
  const messages = []
  for (const turn of thread.turns ?? []) messages.push(...turnMessages(turn, { stripPrivate }))
  messages.push({ role: 'user', content: nextText })
  validateMessages(messages)
  return messages
}

/**
 * Inline images dwarf the text budget, so they are measured separately: the 1 MiB context cap
 * applies to everything else, and pictures get their own (still bounded) allowance.
 */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024
export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.some((message) => !message || typeof message !== 'object' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role))) throw new CodexError('model-messages', '对话消息格式不正确')
  let size, images = 0
  try {
    const measured = messages.map((message) => Array.isArray(message.content)
      ? { ...message, content: message.content.map((part) => {
        if (part?.type !== 'image') return part
        if (typeof part.mime !== 'string' || typeof part.data !== 'string' || !part.data) throw new CodexError('model-messages', '对话消息图片格式不正确')
        images += part.data.length
        return { type: 'text', text: '' }
      }) }
      : message)
    size = Buffer.byteLength(JSON.stringify(measured))
  } catch (error) {
    if (error instanceof CodexError) throw error
    throw new CodexError('model-messages', '对话消息不能序列化')
  }
  if (images > MAX_INLINE_IMAGE_BYTES) throw new CodexError('context-limit', '本条消息附带的图片总大小超过上限，请减少图片或压缩后重试', 413)
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
