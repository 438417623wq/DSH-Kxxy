import { normalizeProvider, resolvedCompat } from './provider-config.mjs'
import { providerError } from './provider-http.mjs'

export const MAX_OUTPUT_CHARS = 262144
const MAX_TOOL_CALLS = 40
const MAX_ARGUMENT_CHARS = 512 * 1024
const TOOL_NAME = /^[\w-]{1,100}$/
// Some OpenAI-compatible servers emit call ids that contain ':' or '.', e.g. "call_0:1".
const CALL_ID = /^[\w.:-]{1,200}$/
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const clone = (value) => structuredClone(value)
const fault = (message, code = 'model-response') => providerError(code, message, { status: code.endsWith('-limit') ? 413 : 502 })

function contentText(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (!Array.isArray(value)) throw fault('模型消息内容格式不正确')
  return value.map((part) => imageBlock(part) ? '' : ['text', 'output_text', 'input_text'].includes(part?.type) ? typeof part.text === 'string' ? part.text : '' : '').join('')
}
const IMAGE_MIME = /^image\/(?:png|jpeg|webp|gif)$/
/**
 * Images travel as protocol-neutral `{ type: 'image', mime, data }` blocks; every format below
 * maps that one shape onto its own encoding. Anything else in the array is rejected so a
 * malformed part fails before the request is spent.
 */
function imageBlock(part) {
  if (!object(part) || part.type !== 'image') return null
  if (typeof part.mime !== 'string' || !IMAGE_MIME.test(part.mime) || typeof part.data !== 'string' || !part.data) throw fault('模型消息图片格式不正确')
  return part
}
const dataUrl = (block) => `data:${block.mime};base64,${block.data}`
function chatContent(parts) {
  return parts.map((part) => {
    const image = imageBlock(part)
    if (image) return { type: 'image_url', image_url: { url: dataUrl(image) } }
    if (part?.type === 'text') return { type: 'text', text: typeof part.text === 'string' ? part.text : '' }
    throw fault('模型消息内容格式不正确')
  })
}
function anthropicContent(value) {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : []
  if (!Array.isArray(value)) throw fault('模型消息内容格式不正确')
  const blocks = []
  for (const part of value) {
    const image = imageBlock(part)
    if (image) blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } })
    else if (part?.type === 'text') { if (part.text) blocks.push({ type: 'text', text: String(part.text) }) }
    else throw fault('模型消息内容格式不正确')
  }
  return blocks
}
function responsesContent(parts) {
  return parts.map((part) => {
    const image = imageBlock(part)
    if (image) return { type: 'input_image', image_url: dataUrl(image) }
    if (part?.type === 'text') return { type: 'input_text', text: typeof part.text === 'string' ? part.text : '' }
    throw fault('模型消息内容格式不正确')
  })
}
function replay(message, format) {
  const value = message.provider_replay
  if (value != null && (!object(value) || !['responses', 'anthropic-messages'].includes(value.apiFormat))) throw fault('模型回放数据格式不正确')
  if (value && value.apiFormat !== format) throw fault('模型回放数据的协议不匹配，请新建对话')
  return value
}
function chatMessages(messages, compat) {
  return messages.map((message) => {
    const result = { role: ['system', 'developer'].includes(message.role) ? compat.systemRole : message.role, content: Array.isArray(message.content) ? chatContent(message.content) : message.content ?? '' }
    if (message.role === 'tool') result.tool_call_id = message.tool_call_id
    if (message.role === 'assistant') {
      if (message.tool_calls?.length) result.tool_calls = clone(message.tool_calls)
      if (compat.includeReasoning && typeof message.reasoning_content === 'string') result.reasoning_content = message.reasoning_content
    }
    return result
  })
}
function responsesInput(messages, compat) {
  const input = []
  for (const message of messages) {
    const saved = message.role === 'assistant' ? replay(message, 'responses') : null
    if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' })
    else if (saved?.output?.length || message.responses_output?.length) {
      const output = saved?.output ?? message.responses_output
      if (!Array.isArray(output)) throw fault('Responses 回放数据格式不正确')
      input.push(...clone(output))
    } else {
      const content = Array.isArray(message.content) ? responsesContent(message.content) : message.content ?? ''
      if (content || !message.tool_calls?.length) input.push({ role: ['system', 'developer'].includes(message.role) ? compat.systemRole : message.role, content })
      for (const call of message.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
    }
  }
  return input
}
function anthropicInput(messages) {
  const input = [], system = []
  const add = (role, content) => {
    if (!content.length) return
    if (input.at(-1)?.role === role) input.at(-1).content.push(...content)
    else input.push({ role, content })
  }
  for (const message of messages) {
    if (['system', 'developer'].includes(message.role)) { const text = contentText(message.content); if (text) system.push({ type: 'text', text }); continue }
    if (message.role === 'tool') { add('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: contentText(message.content) }]); continue }
    const saved = message.role === 'assistant' ? replay(message, 'anthropic-messages') : null
    if (saved) {
      if (!Array.isArray(saved.content) || saved.content.some((block) => !object(block) || !['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type) || block.type === 'thinking' && (typeof block.thinking !== 'string' || typeof block.signature !== 'string' || !block.signature))) throw fault('Anthropic 回放数据格式不正确')
      add('assistant', clone(saved.content)); continue
    }
    const blocks = anthropicContent(message.content)
    for (const call of message.tool_calls ?? []) {
      let input
      try { input = JSON.parse(call.function.arguments) } catch { throw fault('历史工具参数不是完整 JSON') }
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
    }
    add(message.role, blocks)
  }
  return { messages: input, ...(system.length ? { system } : {}) }
}

export function validateToolDefinitions(tools) {
  if (!Array.isArray(tools) || tools.length > 128) throw fault('工具定义数量超过上限', 'model-tools-limit')
  const definitions = new Map()
  for (const tool of tools) {
    const fn = tool?.function
    if (tool?.type !== 'function' || !object(fn) || !TOOL_NAME.test(fn.name) || definitions.has(fn.name) || !object(fn.parameters ?? {})) throw fault('工具定义格式不正确')
    definitions.set(fn.name, fn.parameters ?? { type: 'object' })
  }
  return definitions
}
function selection(choice, definitions) {
  if (['auto', 'none', 'required'].includes(choice)) {
    if (choice === 'required' && !definitions.size) throw fault('强制工具调用需要至少一个工具')
    return choice
  }
  const name = typeof choice === 'string' ? choice : choice?.function?.name ?? choice?.name
  if (!definitions.has(name)) throw fault('指定的工具不存在')
  return { type: 'function', function: { name } }
}

/** Chat-shaped input is transformed only at this boundary; private replay is never sent to Chat. */
export function buildProviderPayload({ model: rawModel, messages, stream = true, tools = [], toolChoice = 'auto', effort, maxOutputTokens, parallelToolCalls = false }) {
  const model = normalizeProvider(rawModel)
  const compat = resolvedCompat(model)
  const definitions = validateToolDefinitions(tools)
  if (typeof stream !== 'boolean' || typeof parallelToolCalls !== 'boolean') throw fault('stream 和并行工具开关必须是布尔值')
  if (parallelToolCalls && !compat.parallelToolCalls) throw fault('所选兼容配置不支持并行工具调用', 'model-unsupported')
  const choice = selection(toolChoice, definitions)
  const selectedEffort = effort === undefined || effort === '' ? model.reasoningEffort : effort
  if (selectedEffort && !model.reasoningEfforts.includes(selectedEffort)) throw fault('所选推理强度不在模型配置列表中', 'effort-invalid')
  const limit = maxOutputTokens === undefined || maxOutputTokens === null ? model.maxOutputTokens : maxOutputTokens
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1048576)) throw fault('输出 token 上限必须是有效整数', 'model-tokens')
  let payload
  if (model.apiFormat === 'responses') {
    payload = { model: model.model, input: responsesInput(messages, compat), stream }
    if (limit !== null) payload.max_output_tokens = limit
    if (compat.store) payload.store = false
    if (compat.includeReasoning) payload.include = ['reasoning.encrypted_content']
  } else if (model.apiFormat === 'anthropic-messages') {
    payload = { model: model.model, ...anthropicInput(messages), stream, max_tokens: limit ?? 4096 }
  } else {
    payload = { model: model.model, messages: chatMessages(messages, compat), stream }
    if (limit !== null) payload[compat.tokenField] = limit
    if (compat.store) payload.store = false
  }
  if (definitions.size) {
    if (model.apiFormat === 'responses') payload.tools = tools.map(({ function: fn }) => ({ type: 'function', name: fn.name, ...(fn.description ? { description: fn.description } : {}), parameters: clone(fn.parameters ?? { type: 'object' }), strict: compat.strictTools }))
    else if (model.apiFormat === 'anthropic-messages') payload.tools = tools.map(({ function: fn }) => ({ name: fn.name, ...(fn.description ? { description: fn.description } : {}), input_schema: clone(fn.parameters ?? { type: 'object' }), ...(compat.strictTools ? { strict: true } : {}) }))
    else payload.tools = tools.map(({ function: fn }) => ({ type: 'function', function: { name: fn.name, ...(fn.description ? { description: fn.description } : {}), parameters: clone(fn.parameters ?? { type: 'object' }), ...(compat.strictTools ? { strict: true } : {}) } }))
    if (model.apiFormat === 'anthropic-messages') payload.tool_choice = typeof choice === 'string' ? { type: choice === 'required' ? 'any' : choice } : { type: 'tool', name: choice.function.name }
    else payload.tool_choice = model.apiFormat === 'responses' && object(choice) ? { type: 'function', name: choice.function.name } : choice
    if (compat.parallelToolCalls) {
      if (model.apiFormat === 'anthropic-messages') payload.tool_choice.disable_parallel_tool_use = !parallelToolCalls
      else payload.parallel_tool_calls = parallelToolCalls
    }
  }
  if (selectedEffort && compat.reasoningFormat !== 'none') {
    if (compat.reasoningFormat === 'reasoning_effort') {
      if (model.apiFormat === 'responses') payload.reasoning = { effort: selectedEffort }
      else payload.reasoning_effort = selectedEffort
    } else if (compat.reasoningFormat === 'deepseek') payload.thinking = { type: selectedEffort === 'none' ? 'disabled' : 'enabled' }
    else if (compat.reasoningFormat === 'thinking') {
      if (selectedEffort === 'none') payload.thinking = { type: 'disabled' }
      else {
        const budget = model.thinkingBudget ?? 1024
        if (budget >= payload.max_tokens) throw fault('思考预算必须小于输出 token 上限', 'model-tokens')
        if (definitions.size && (choice === 'required' || object(choice))) throw fault('Anthropic 思考模式不能强制指定工具；请关闭思考后重试诊断', 'model-unsupported')
        payload.thinking = { type: 'enabled', budget_tokens: budget }
      }
    }
  }
  return { model, payload, definitions, choice }
}

/** Bounded, dependency-free validation of the JSON-schema vocabulary used by tool definitions. */
function schemaMatches(value, schema, root = schema, state = { count: 0 }, depth = 0) {
  if (++state.count > 20000 || depth > 64) return false
  if (typeof schema === 'boolean') return schema
  if (!object(schema)) return false
  const recurse = (value, schema) => schemaMatches(value, schema, root, state, depth + 1)
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) return false
    let target = root
    for (const part of schema.$ref.slice(2).split('/')) target = target?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]
    if (!recurse(value, target)) return false
  }
  const equal = (a, b) => {
    if (a === b) return true
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equal(item, b[i]))
    return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  }
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.some((item) => equal(value, item)))) return false
  if (Object.hasOwn(schema, 'const') && !equal(value, schema.const)) return false
  for (const key of ['allOf', 'anyOf', 'oneOf']) if (schema[key]) {
    if (!Array.isArray(schema[key])) return false
    const matches = schema[key].map((item) => recurse(value, item))
    if (key === 'allOf' ? matches.some((v) => !v) : key === 'anyOf' ? !matches.some(Boolean) : matches.filter(Boolean).length !== 1) return false
  }
  if (schema.not && recurse(value, schema.not)) return false
  if (schema.if && !recurse(value, recurse(value, schema.if) ? schema.then ?? true : schema.else ?? true)) return false
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? object(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : ['string', 'boolean'].includes(type) && typeof value === type)) return false
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum || typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum || typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum || schema.multipleOf && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) return false
  }
  if (typeof value === 'string') {
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) return false
    if (schema.pattern) { try { if (!new RegExp(schema.pattern, 'u').test(value)) return false } catch { return false } }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return false
    if (schema.uniqueItems && value.some((item, i) => value.slice(0, i).some((other) => equal(item, other)))) return false
    if (schema.contains && !value.some((item) => recurse(item, schema.contains))) return false
    for (const [index, item] of value.entries()) {
      const spec = schema.prefixItems?.[index] ?? (Array.isArray(schema.items) ? schema.items[index] ?? schema.additionalItems ?? true : schema.items ?? true)
      if (!recurse(item, spec)) return false
    }
  }
  if (object(value)) {
    const keys = Object.keys(value)
    if (schema.minProperties !== undefined && keys.length < schema.minProperties || schema.maxProperties !== undefined && keys.length > schema.maxProperties || schema.required?.some((key) => !Object.hasOwn(value, key))) return false
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames && !recurse(key, schema.propertyNames)) return false
      let matched = false
      if (schema.properties && Object.hasOwn(schema.properties, key)) { matched = true; if (!recurse(item, schema.properties[key])) return false }
      for (const [pattern, spec] of Object.entries(schema.patternProperties ?? {})) {
        let matches
        try { matches = new RegExp(pattern, 'u').test(key) } catch { return false }
        if (matches) { matched = true; if (!recurse(item, spec)) return false }
      }
      if (!matched && !recurse(item, schema.additionalProperties ?? true)) return false
    }
    for (const [key, required] of Object.entries(schema.dependentRequired ?? {})) if (Object.hasOwn(value, key) && (!Array.isArray(required) || required.some((name) => !Object.hasOwn(value, name)))) return false
  }
  return true
}

function usageOf(value, format, previous = {}) {
  if (!object(value)) return previous
  const mapping = format === 'chat-completions'
    ? { inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens, totalTokens: value.total_tokens, cachedInputTokens: value.prompt_tokens_details?.cached_tokens, reasoningTokens: value.completion_tokens_details?.reasoning_tokens }
    : { inputTokens: value.input_tokens, outputTokens: value.output_tokens, totalTokens: value.total_tokens, cachedInputTokens: value.input_tokens_details?.cached_tokens ?? value.cache_read_input_tokens, reasoningTokens: value.output_tokens_details?.reasoning_tokens }
  const result = { ...previous }
  // Servers that omit a counter as often send an explicit null; treat both as "not reported".
  for (const [key, item] of Object.entries(mapping)) if (item !== undefined && item !== null) {
    if (!Number.isSafeInteger(item) || item < 0) throw fault('模型 token 用量格式不正确')
    result[key] = item
  }
  if (result.inputTokens !== undefined && result.outputTokens !== undefined && mapping.totalTokens === undefined) result.totalTokens = result.inputTokens + result.outputTokens
  return result
}

// parallelToolCalls only shapes the outgoing payload; the collector accepts any number of
// calls per reply because the agent loop always executes them sequentially.
export function createProtocolCollector({ model, definitions, choice, parallelToolCalls = false, onDelta = () => {}, onReasoningDelta = () => {}, onToolCallDelta = () => {} }) {
  const format = model.apiFormat
  let text = '', reasoningContent = '', terminal = false, finishReason = null, usage = {}, sawEvent = false, stopped = false
  const calls = new Map(), outputs = new Map(), itemIndices = new Map(), blocks = new Map()
  let anthropicStarted = false, anthropicReason = null
  const addText = (delta, reasoning = false) => {
    if (delta === undefined || delta === null || delta === '') return
    if (typeof delta !== 'string') throw fault('模型文字增量格式不正确')
    if ((reasoning ? reasoningContent : text).length + delta.length > MAX_OUTPUT_CHARS) throw fault('模型输出超过长度上限', 'model-output-limit')
    if (reasoning) { reasoningContent += delta; onReasoningDelta(delta) } else { text += delta; onDelta(delta) }
  }
  const syncText = (value, reasoning = false) => {
    if (!value) return
    const current = reasoning ? reasoningContent : text
    if (value === current) return
    if (!value.startsWith(current)) throw fault('模型最终输出与流式增量不一致')
    addText(value.slice(current.length), reasoning)
  }
  const indexOf = (value) => {
    if (!Number.isSafeInteger(value) || value < 0) throw fault('模型输出索引格式不正确')
    return value
  }
  const declared = [...definitions.keys()]
  /**
   * vLLM/SGLang style servers resend the whole function name on every chunk, sometimes
   * cumulatively. Declared tool names are the authority: pick whichever candidate is still a
   * prefix of a real tool instead of blindly concatenating (which produced "read_fileread_file").
   */
  const mergeName = (current, incoming) => {
    if (!current) return incoming
    if (incoming === current) return current
    const match = [current + incoming, incoming].find((name) => declared.some((tool) => tool.startsWith(name)))
    return match ?? current + incoming
  }
  const collect = (index, value, replace = false) => {
    indexOf(index)
    if (!definitions.size || choice === 'none') throw fault('此请求不允许工具调用')
    if (!calls.has(index) && calls.size >= MAX_TOOL_CALLS) throw fault('模型工具调用数量超过上限', 'model-tools-limit')
    const call = calls.get(index) ?? { id: '', name: '', arguments: '', ordinal: calls.size }
    const delta = { index: call.ordinal }
    for (const field of ['id', 'name', 'arguments']) {
      // OpenAI-compatible servers commonly send explicit nulls for fields this chunk omits.
      if (value[field] === undefined || value[field] === null) continue
      if (typeof value[field] !== 'string') throw fault('模型工具调用格式不正确')
      if (replace) {
        if (call[field] && value[field] !== call[field] && !value[field].startsWith(call[field])) throw fault('模型最终工具调用与流式增量不一致')
        call[field] = field === 'name' ? mergeName(call[field], value[field]) : value[field]
      } else if (field === 'id' && value[field] === call[field]) { /* Some servers repeat the stable id. */ }
      else if (field === 'name') call[field] = mergeName(call[field], value[field])
      else call[field] += value[field]
      if (field === 'arguments') delta[replace ? 'arguments' : 'argumentsDelta'] = value[field]
      else delta[field] = call[field]
    }
    if (call.id.length > 200 || call.name.length > 100 || call.arguments.length > MAX_ARGUMENT_CHARS) throw fault('模型工具调用参数超过上限', 'model-tools-limit')
    calls.set(index, call)
    onToolCallDelta(delta)
  }
  const collectResponseItem = (item, index) => {
    if (!object(item) || typeof item.type !== 'string') throw fault('Responses 输出条目格式不正确')
    indexOf(index)
    if (!outputs.has(index) && outputs.size >= 256) throw fault('模型输出条目数量超过上限', 'model-output-limit')
    if (typeof item.id === 'string' && item.id) {
      if (itemIndices.has(item.id) && itemIndices.get(item.id) !== index) throw fault('Responses 输出 ID 重复')
      itemIndices.set(item.id, index)
    }
    if (calls.has(index) && item.type !== 'function_call') throw fault('Responses 工具条目类型在同一索引发生变化')
    if (['reasoning', 'message', 'function_call'].includes(item.type)) outputs.set(index, clone(item))
    else throw fault('模型返回了此客户端不支持的原生工具或输出类型', 'model-unsupported')
    if (item.type === 'function_call') collect(index, { id: item.call_id, name: item.name, arguments: item.arguments ?? '' }, true)
  }
  const responseText = (response) => {
    if (typeof response.output_text === 'string') return response.output_text
    return (response.output ?? []).filter((item) => item.type === 'message').map((item) => contentText(item.content)).join('')
  }
  const responseReasoning = (response) => (response.output ?? []).filter((item) => item.type === 'reasoning').map((item) => (item.summary ?? []).map((part) => part.text ?? '').join('')).join('')
  const completeResponses = (response) => {
    if (!object(response) || response.status !== 'completed' || response.error || response.incomplete_details) throw fault('模型服务未能完整生成回复')
    if (response.output !== undefined && !Array.isArray(response.output) || calls.size && !Array.isArray(response.output)) throw fault('Responses 最终输出缺少完整工具调用列表')
    if (response.output) {
      const seen = new Set(), seenIds = new Set(), seenCallIds = new Set()
      for (const [position, item] of response.output.entries()) {
        if (!object(item)) throw fault('Responses 最终输出条目格式不正确')
        if (item.id && seenIds.has(item.id) || item.type === 'function_call' && seenCallIds.has(item.call_id)) throw fault('Responses 最终输出包含重复标识')
        if (item.id) seenIds.add(item.id)
        if (item.type === 'function_call') seenCallIds.add(item.call_id)
        const index = typeof item.id === 'string' && itemIndices.has(item.id) ? itemIndices.get(item.id) : position
        if (seen.has(index) || item.status && item.status !== 'completed') throw fault('Responses 输出条目未完成或标识重复')
        seen.add(index)
        collectResponseItem(item, index)
      }
      if ([...calls.keys()].some((index) => !seen.has(index))) throw fault('Responses 最终输出缺少已收到的工具调用')
      for (const index of outputs.keys()) if (!seen.has(index)) outputs.delete(index)
    }
    syncText(responseText(response))
    const reasoning = responseReasoning(response)
    if (reasoning) syncText(reasoning, true)
    usage = usageOf(response.usage, format, usage)
    terminal = true; finishReason = calls.size ? 'tool_calls' : 'stop'; stopped = true
  }
  const chatTerminal = (reason) => {
    // Several OpenAI-compatible servers report 'stop' even though the message carries complete
    // tool calls; treat that as 'tool_calls' instead of failing an otherwise usable reply.
    const actual = reason === 'stop' && calls.size ? 'tool_calls' : reason
    if (!['stop', 'tool_calls'].includes(actual)) throw fault(actual === 'length' ? '模型回复被服务截断，请调整输出上限后重试' : '模型服务未返回完整回复')
    if (!calls.size && actual === 'tool_calls') throw fault('工具调用与模型结束原因不一致')
    terminal = true; finishReason = actual
  }
  const anthropicStop = (reason) => {
    if (!['end_turn', 'stop_sequence', 'tool_use'].includes(reason)) throw fault(reason === 'max_tokens' ? '模型回复被服务截断，请调整输出上限后重试' : '模型服务未返回完整回复')
    if (calls.size && reason !== 'tool_use' || !calls.size && reason === 'tool_use') throw fault('工具调用与模型结束原因不一致')
    anthropicReason = reason; finishReason = calls.size ? 'tool_calls' : 'stop'
  }
  const anthropicBlock = (block, index, streaming = false) => {
    indexOf(index)
    if (!object(block) || blocks.has(index) || blocks.size >= 256) throw fault('Anthropic 内容块格式或数量不正确')
    if (!['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type)) throw fault('不支持的 Anthropic 内容块类型', 'model-unsupported')
    const value = clone(block)
    blocks.set(index, { value, closed: !streaming })
    if (block.type === 'text') addText(block.text)
    if (block.type === 'thinking') addText(block.thinking, true)
    if (block.type === 'tool_use') collect(index, { id: block.id, name: block.name, arguments: streaming ? '' : JSON.stringify(block.input) }, true)
  }
  const parseJson = (value) => {
    if (!object(value) || value.error || value.type === 'error') throw fault('模型服务生成失败，请检查模型配置或服务状态')
    if (format === 'responses') completeResponses(value)
    else if (format === 'anthropic-messages') {
      if (value.type !== 'message' || value.role && value.role !== 'assistant' || !Array.isArray(value.content)) throw fault('Anthropic 消息格式不正确')
      value.content.forEach((block, index) => anthropicBlock(block, index))
      anthropicStop(value.stop_reason)
      usage = usageOf(value.usage, format, usage)
      terminal = true; stopped = true
    } else {
      if (!Array.isArray(value.choices) || value.choices.length !== 1 || !object(value.choices[0].message)) throw fault('Chat Completions 消息格式不正确')
      const entry = value.choices[0], message = entry.message
      addText(contentText(message.content)); addText(message.reasoning_content ?? message.reasoning, true)
      if (entry.type === 'function_call' || message.function_call != null) throw fault('旧版 function_call 不受支持，请使用 tool_calls', 'model-unsupported')
      if (message.tool_calls != null && !Array.isArray(message.tool_calls)) throw fault('工具调用列表格式不正确')
      for (const [index, call] of (message.tool_calls ?? []).entries()) {
        if (call?.type && call.type !== 'function') throw fault('不支持的工具调用类型')
        collect(call?.index ?? index, { id: call?.id, name: call?.function?.name, arguments: call?.function?.arguments }, true)
      }
      chatTerminal(entry.finish_reason)
      usage = usageOf(value.usage, format, usage); stopped = true
    }
  }
  const event = ({ event: eventName, data }) => {
    sawEvent = true
    if (data.trim() === '[DONE]') {
      if (format !== 'chat-completions' || !terminal) throw fault('模型流式连接在成功终态之前结束')
      stopped = true; return true
    }
    let value
    try { value = JSON.parse(data) } catch { throw fault('模型服务返回了无效的流式 JSON') }
    if (!object(value)) throw fault('模型流式事件格式不正确')
    const type = value.type ?? eventName
    if (value.type && eventName && eventName !== 'message' && eventName !== value.type) throw fault('模型流式事件类型不一致')
    if (value.error || ['error', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(type)) throw fault('模型服务生成失败或未完整生成回复')
    if (format === 'responses') {
      if (type === 'response.output_text.delta') addText(value.delta)
      else if (['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(type)) addText(value.delta, true)
      else if (type === 'response.output_item.added' || type === 'response.output_item.done') collectResponseItem(value.item, value.output_index)
      else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
        const index = value.output_index ?? itemIndices.get(value.item_id)
        if (!calls.has(index)) throw fault('工具参数先于工具标识到达')
        collect(index, { arguments: type.endsWith('.done') ? value.arguments : value.delta }, type.endsWith('.done'))
      } else if (type === 'response.completed') completeResponses(value.response)
    } else if (format === 'anthropic-messages') {
      if (type === 'ping') return false
      if (type === 'message_start') {
        if (anthropicStarted || !object(value.message) || value.message.type !== 'message' || value.message.role && value.message.role !== 'assistant' || value.message.content?.length) throw fault('Anthropic 起始事件格式不正确')
        anthropicStarted = true; usage = usageOf(value.message.usage, format, usage)
      } else {
        if (!anthropicStarted) throw fault('Anthropic 缺少消息起始事件')
        if (type === 'content_block_start') {
          if (anthropicReason) throw fault('消息终态后收到内容块')
          anthropicBlock(value.content_block, value.index, true)
        } else if (type === 'content_block_delta') {
          const block = blocks.get(indexOf(value.index))
          if (!block || block.closed || anthropicReason || !object(value.delta)) throw fault('Anthropic 内容增量次序不正确')
          const delta = value.delta
          if (delta.type === 'text_delta' && block.value.type === 'text') { addText(delta.text); block.value.text = (block.value.text ?? '') + delta.text }
          else if (delta.type === 'thinking_delta' && block.value.type === 'thinking') { addText(delta.thinking, true); block.value.thinking = (block.value.thinking ?? '') + delta.thinking }
          else if (delta.type === 'signature_delta' && block.value.type === 'thinking' && typeof delta.signature === 'string') {
            block.value.signature = (block.value.signature ?? '') + delta.signature
            if (block.value.signature.length > MAX_ARGUMENT_CHARS) throw fault('思考签名超过上限', 'model-output-limit')
          } else if (delta.type === 'input_json_delta' && block.value.type === 'tool_use') collect(value.index, { arguments: delta.partial_json })
          else throw fault('Anthropic 内容增量类型不匹配')
        } else if (type === 'content_block_stop') {
          const block = blocks.get(indexOf(value.index))
          if (!block || block.closed) throw fault('Anthropic 内容块结束次序不正确')
          block.closed = true
          if (block.value.type === 'tool_use' && !calls.get(value.index).arguments) collect(value.index, { arguments: JSON.stringify(block.value.input ?? {}) }, true)
        } else if (type === 'message_delta') {
          if ([...blocks.values()].some((block) => !block.closed)) throw fault('Anthropic 内容块尚未结束')
          if (value.delta?.stop_reason != null) { if (anthropicReason) throw fault('Anthropic 重复结束原因'); anthropicStop(value.delta.stop_reason) }
          usage = usageOf(value.usage, format, usage)
        } else if (type === 'message_stop') {
          if (!anthropicReason || [...blocks.values()].some((block) => !block.closed)) throw fault('Anthropic 消息没有完整终态')
          terminal = true; stopped = true
        }
      }
    } else {
      if (value.choices !== undefined && (!Array.isArray(value.choices) || value.choices.length > 1)) throw fault('模型返回了多个或无效的候选回复')
      const entry = value.choices?.[0]
      if (entry) {
        if (entry.index !== undefined && entry.index !== 0) throw fault('模型候选回复索引不正确')
        const delta = entry.delta ?? {}
        if (terminal && (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls?.length || entry.finish_reason)) throw fault('模型成功终态后仍返回内容')
        addText(contentText(delta.content)); addText(delta.reasoning_content ?? delta.reasoning, true)
        if (delta.function_call != null) throw fault('旧版 function_call 不受支持，请使用 tool_calls', 'model-unsupported')
        if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) throw fault('工具调用增量格式不正确')
        for (const [position, call] of (delta.tool_calls ?? []).entries()) {
          if (call?.type && call.type !== 'function') throw fault('不支持的工具调用类型')
          // A single-call delta may omit its index; multi-call deltas must identify themselves.
          const index = call?.index ?? (delta.tool_calls.length === 1 ? 0 : undefined)
          if (index === undefined) throw fault('工具调用增量缺少索引')
          collect(index, { id: call?.id, name: call?.function?.name, arguments: call?.function?.arguments })
        }
        if (entry.finish_reason != null) chatTerminal(entry.finish_reason)
      }
      usage = usageOf(value.usage, format, usage)
    }
    return stopped
  }
  const finish = ({ streamed }) => {
    if (!terminal || streamed && !sawEvent) throw fault('模型流式连接提前结束，未收到完整成功终态')
    // The caller executes tool calls strictly one after another, so a server that ignores
    // parallel_tool_calls:false must not lose an otherwise valid reply. Keep the sequential
    // order and the unique-id/limit checks instead of failing the whole turn.
    const toolCalls = [], completedDeltas = []
    const ids = new Set()
    for (const [index, call] of [...calls].sort(([a], [b]) => a - b)) {
      if (!CALL_ID.test(call.id) || !TOOL_NAME.test(call.name) || ids.has(call.id) || !definitions.has(call.name)) throw fault('模型工具调用缺少有效且唯一的标识或已声明名称')
      if (object(choice) && call.name !== choice.function.name) throw fault('模型未调用指定的工具')
      // Argument-less tools legitimately arrive as an empty string on some servers.
      const rawArguments = call.arguments.trim() ? call.arguments : '{}'
      let args
      try { args = JSON.parse(rawArguments) } catch { throw fault('模型工具参数不是完整 JSON 对象') }
      if (!object(args) || !schemaMatches(args, definitions.get(call.name))) throw fault('模型工具参数不符合已声明的 JSON schema')
      ids.add(call.id)
      toolCalls.push({ id: call.id, name: call.name, arguments: rawArguments })
      if (format === 'anthropic-messages') blocks.get(index).value.input = args
      completedDeltas.push({ index: call.ordinal, id: call.id, name: call.name, arguments: rawArguments, done: true })
    }
    if ((choice === 'required' || object(choice)) && !toolCalls.length) throw fault('模型未按要求返回工具调用')
    if (!text && !toolCalls.length) throw fault('模型没有返回文字回复或有效工具调用', 'model-empty')
    const providerOutput = format === 'responses' ? [...outputs].sort(([a], [b]) => a - b).map(([, item]) => item) : []
    let providerReplay = null
    if (format === 'responses' && providerOutput.length) providerReplay = { apiFormat: format, output: clone(providerOutput) }
    if (format === 'anthropic-messages') {
      const content = [...blocks].sort(([a], [b]) => a - b).map(([, block]) => block.value)
      if (content.some((block) => block.type === 'thinking' && (typeof block.thinking !== 'string' || typeof block.signature !== 'string' || !block.signature) || block.type === 'redacted_thinking' && (typeof block.data !== 'string' || !block.data))) throw fault('Anthropic 思考块缺少完整签名或密文，不能安全回放')
      providerReplay = { apiFormat: format, content }
    }
    for (const delta of completedDeltas) onToolCallDelta(delta)
    return { text, reasoningContent, toolCalls, providerOutput, providerReplay, usage: Object.keys(usage).length ? usage : null, finishReason }
  }
  return { event, parseJson, finish }
}
