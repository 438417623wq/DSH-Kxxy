import { createHash } from 'node:crypto'
import { CodexError } from './transport.mjs'

// Pinned rust-v0.167.0 (086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a):
// tools/src/{responses_api,tool_spec}.rs, protocol/src/models.rs,
// codex-api/src/{common,sse/responses}.rs. No downloaded code is executed.
export const APPLY_PATCH_GRAMMAR_SHA256 = '50b06e74592ca36baf0a0804a36d76aef1847b251c7b5b5bfd9bc81ec7794023'
export const BRIDGE_WARNINGS = Object.freeze({
  'validated-tools': 'Tool events are released only after the complete upstream round is validated; ordinary text remains streamed.',
  'grammar-advisory-only': 'The pinned apply_patch Lark grammar is advisory text, not an upstream constraint. The CLI remains responsible for validating and executing the tool.',
  'encrypted-reasoning-unavailable': 'This bridge does not manufacture Responses encrypted reasoning. Provider replay metadata remains private to this live binding.',
  'reasoning-summary-unavailable': 'Provider reasoning text, when available, is not a generated Responses reasoning summary.',
  'reasoning-delivery-buffered': 'Sequential reasoning-summary delivery is unavailable; reasoning is released after validation, separately from live ordinary text.',
  'text-verbosity-not-forwarded': 'Responses text verbosity is not a constraint supported by this bridge.',
  'prompt-cache-not-forwarded': 'The Responses prompt-cache key is not forwarded to the provider.',
  'client-metadata-local-only': 'Responses client metadata is validated locally and is not sent as model input or provider headers.',
  'message-phase-not-forwarded': 'Responses message phases are presentation metadata and are not a Chat Completions role.',
  'strict-not-enforced': 'The target protocol cannot enforce the Responses strict flag; the CLI still validates tool input.',
  'parallel-tools-disabled': 'This provider does not support parallel tool calls. The bridge explicitly narrows this request to at most one validated tool call.',
  'reasoning-effort-unavailable': 'This provider declares no reasoning-effort capability. The recognized CLI effort hint is omitted; no thinking mode or reasoning is fabricated.',
})

export class BridgeError extends CodexError {
  constructor(code, message, status = 400) { super(code, message, status) }
}
export function invalid(message = 'Invalid Responses request.') {
  throw new BridgeError('bridge-invalid-request', message)
}
export function unsupported(message = 'This Responses feature is not supported by the local bridge.') {
  throw new BridgeError('bridge-unsupported', message)
}
export function replayUnavailable() {
  throw new BridgeError('bridge-replay-unavailable', 'Private provider replay metadata is unavailable or no longer matches this binding. Restarting, changing configuration, or evicting history cannot restore signed reasoning; start a new thread.', 409)
}
export function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function fields(value, allowed, message) {
  if (!record(value)) invalid(message)
  if (Object.keys(value).some((key) => !allowed.includes(key))) unsupported(message)
}
function string(value, max = 262144, empty = true) {
  if (typeof value !== 'string' || (!empty && !value) || Buffer.byteLength(value) > max) invalid()
  return value
}
function name(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) invalid('Invalid tool name or namespace.')
  return value
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) invalid('A complete, valid tool-call identifier is required.')
  return value
}
function optionalId(value) { if (value != null) identifier(value) }
function nullableOnly(value, message) { if (value != null) unsupported(message) }
function emptyArrayOnly(value, message) { if (value != null && (!Array.isArray(value) || value.length)) unsupported(message) }
function boolean(value, fallback) { if (value === undefined) return fallback; if (typeof value !== 'boolean') invalid(); return value }
function nonnegative(value) { return Number.isSafeInteger(value) && value >= 0 }
function hash(value) { return createHash('sha256').update(value).digest('base64url') }

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const toolIdentity = (namespace, toolName) => JSON.stringify([namespace ?? null, toolName])
export function flatToolName(namespace, toolName) {
  // The complete SHA-256 digest fits the 64-character Chat function name limit.
  // All names, including top-level ones, use this scheme; reserved-prefix and
  // concatenation collisions are therefore impossible. Digest collisions fail closed.
  return `dsh_${toolName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 14)}_${hash(toolIdentity(namespace, toolName))}`
}
function argumentsObject(raw, maxBytes) {
  string(raw, maxBytes, false)
  let value
  try { value = JSON.parse(raw) } catch { invalid('Function arguments must be a complete JSON object.') }
  if (!record(value)) invalid('Function arguments must be a complete JSON object.')
  return value
}
export function unwrapCustomArguments(raw, maxBytes = 512 * 1024) {
  argumentsObject(raw, maxBytes)
  // This deliberately accepts exactly the documented wrapper, not duplicate keys,
  // extra keys, objects coerced to strings, or a second layer of JSON encoding.
  const match = /^\s*\{\s*"input"\s*:\s*("(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*")\s*\}\s*$/.exec(raw)
  if (!match) invalid('Custom tool arguments must contain exactly one input string, with no extra or duplicate members.')
  return JSON.parse(match[1])
}

export function compileTools(raw = [], { customGrammarMode = 'reject', maxTools = 128, maxToolBytes = 1024 * 1024, strictTools = false } = {}) {
  if (!Array.isArray(raw) || raw.length > maxTools || Buffer.byteLength(JSON.stringify(raw)) > maxToolBytes) invalid('Tool definitions exceed the bridge limits.')
  const warnings = new Set()
  const byIdentity = new Map()
  const byFlatName = new Map()
  const tools = []
  const add = (tool, namespace = null, namespaceDescription = '') => {
    if (!record(tool) || !['function', 'custom'].includes(tool.type)) unsupported('Only function, custom, and single-level namespace tools are supported. Hosted and tool-search tools are not supported.')
    fields(tool, tool.type === 'function' ? ['type', 'name', 'description', 'parameters', 'strict', 'defer_loading'] : ['type', 'name', 'description', 'format', 'defer_loading'], 'Unsupported tool-definition field.')
    const originalName = name(tool.name)
    const identity = toolIdentity(namespace, originalName)
    if (byIdentity.has(identity)) invalid('Duplicate tool identity.')
    if (tools.length >= maxTools) invalid('Too many tool definitions.')
    if (tool.defer_loading !== undefined && tool.defer_loading !== false) unsupported('Deferred tools require tool search, which this bridge does not support.')
    const description = tool.description === undefined ? '' : string(tool.description, 128 * 1024)
    let parameters
    let strict = false
    let advisory = ''
    if (tool.type === 'function') {
      if (!record(tool.parameters)) invalid('Function parameters must be a JSON-schema object.')
      parameters = structuredClone(tool.parameters)
      strict = boolean(tool.strict, false)
      if (strict && !strictTools) warnings.add('strict-not-enforced')
    } else {
      const format = tool.format ?? { type: 'text' }
      if (!record(format)) invalid()
      if (format.type === 'text') fields(format, ['type'], 'Unsupported custom text format field.')
      else if (format.type === 'grammar') {
        fields(format, ['type', 'syntax', 'definition'], 'Unsupported grammar format field.')
        const definition = string(format.definition, 128 * 1024, false)
        const digest = createHash('sha256').update(definition.replace(/\r\n/g, '\n').trim()).digest('hex')
        if (customGrammarMode !== 'wrap-known' || format.syntax !== 'lark' || originalName !== 'apply_patch' || digest !== APPLY_PATCH_GRAMMAR_SHA256) unsupported('This grammar is not supported. Only the pinned Codex apply_patch Lark grammar is accepted in explicit wrap-known compatibility mode.')
        warnings.add('grammar-advisory-only')
        advisory = `\nCompatibility notice: this grammar is advisory, NOT enforced by the upstream model. The CLI validates the raw input.\n${definition}`
      } else unsupported('Unknown custom tool format; no grammar or multimodal conversion is inferred.')
      parameters = { type: 'object', properties: { input: { type: 'string', description: 'The exact raw free-form tool input, preserving all whitespace, newlines, shell syntax, and patch markers. Do not JSON-encode this string again.' } }, required: ['input'], additionalProperties: false }
      strict = true
      advisory = `\nThis is a free-form tool. Return exactly one JSON property named input containing its original raw text; do not translate the input to a different command or object.${advisory}`
    }
    const flatName = flatToolName(namespace, originalName)
    if (byFlatName.has(flatName)) invalid('Tool-name collision.')
    const definition = { type: tool.type, name: originalName, namespace, flatName }
    byIdentity.set(identity, definition)
    byFlatName.set(flatName, definition)
    const qualified = namespace ? `${namespace}.${originalName}` : originalName
    tools.push({ type: 'function', function: { name: flatName, description: `Original CLI tool: ${qualified}.\n${namespaceDescription ? `${namespaceDescription}\n` : ''}${description}${advisory}`, parameters, strict } })
  }
  const namespaces = new Set()
  for (const tool of raw) {
    if (record(tool) && tool.type === 'namespace') {
      fields(tool, ['type', 'name', 'description', 'tools'], 'Unsupported namespace field or nested namespace.')
      const namespace = name(tool.name)
      if (namespaces.has(namespace)) invalid('Duplicate namespace definition.')
      namespaces.add(namespace)
      const description = tool.description === undefined ? '' : string(tool.description, 128 * 1024)
      if (!Array.isArray(tool.tools) || !tool.tools.length) invalid('A namespace must contain function or custom tools.')
      for (const child of tool.tools) add(child, namespace, description)
    } else add(tool)
  }
  return { tools, byIdentity, byFlatName, warnings }
}

function chooseTool(raw, catalog) {
  if (raw === undefined) return 'auto'
  if (typeof raw === 'string') {
    if (!['auto', 'none', 'required'].includes(raw)) unsupported('Unsupported tool_choice; it is never replaced with auto.')
    if (raw === 'required' && !catalog.tools.length) invalid('tool_choice required needs at least one tool.')
    return raw
  }
  fields(raw, ['type', 'name', 'namespace'], 'Unsupported named tool_choice.')
  if (!['function', 'custom'].includes(raw.type)) unsupported('Only an explicit function or custom tool choice is supported.')
  const found = catalog.byIdentity.get(toolIdentity(raw.namespace == null ? null : name(raw.namespace), name(raw.name)))
  if (!found || found.type !== raw.type) invalid('The selected tool is not declared in this request.')
  return { type: 'function', function: { name: found.flatName } }
}
function textParts(content, maxBytes, allowed = ['input_text', 'output_text']) {
  if (typeof content === 'string') return string(content, maxBytes)
  if (!Array.isArray(content) || content.length > 600) invalid('Message content must be text.')
  let result = ''
  for (const part of content) {
    fields(part, part?.type === 'output_text' ? ['type', 'text', 'annotations', 'logprobs'] : ['type', 'text'], 'Multimodal, annotated, and unknown content parts are not supported.')
    if (!allowed.includes(part.type)) unsupported('Only textual content is supported; images, audio, files, and other modalities are not converted.')
    emptyArrayOnly(part.annotations, 'Nonempty text annotations are not supported.')
    emptyArrayOnly(part.logprobs, 'Text log probabilities are not supported.')
    result += string(part.text, maxBytes)
    if (Buffer.byteLength(result) > maxBytes) invalid('Text content exceeds the bridge limit.')
  }
  return result
}
function status(raw) {
  if (raw !== undefined && raw !== null && raw !== 'completed') invalid('Incomplete output cannot be replayed as completed history.')
}
function historyCommon(item) {
  optionalId(item.id)
  nullableOnly(item.encrypted_content, 'Encrypted Responses history cannot be decrypted or fabricated by this bridge.')
  nullableOnly(item.internal_chat_message_metadata_passthrough, 'Opaque internal message metadata is not supported.')
  status(item.status)
}
export function normalizeInputItem(item, { maxArgumentBytes = 512 * 1024, maxOutputBytes = 2 * 1024 * 1024, warnings = new Set() } = {}) {
  if (!record(item)) invalid('Input items must be objects.')
  const type = item.type ?? (typeof item.role === 'string' ? 'message' : '')
  const common = ['type', 'id', 'encrypted_content', 'status', 'internal_chat_message_metadata_passthrough']
  if (type === 'message') {
    fields(item, [...common, 'role', 'content', 'phase'], 'Unsupported message field.')
    historyCommon(item)
    if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) unsupported('Unsupported message role.')
    if (item.phase != null) {
      if (!['commentary', 'final_answer'].includes(item.phase) || item.role !== 'assistant') unsupported('Unsupported message phase.')
      warnings.add('message-phase-not-forwarded')
    }
    const text = textParts(item.content, maxOutputBytes)
    return { type, ...(item.id ? { id: item.id } : {}), role: item.role, content: [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text }], ...(item.phase ? { phase: item.phase } : {}) }
  }
  if (type === 'function_call' || type === 'custom_tool_call') {
    fields(item, [...common, 'call_id', 'name', 'namespace', ...(type === 'function_call' ? ['arguments', 'encrypted_function_args'] : ['input'])], 'Unsupported tool-call field.')
    historyCommon(item)
    emptyArrayOnly(item.encrypted_function_args, 'Encrypted function arguments cannot be replayed.')
    const value = { type, ...(item.id ? { id: item.id } : {}), call_id: identifier(item.call_id), name: name(item.name), ...(item.namespace == null ? {} : { namespace: name(item.namespace) }) }
    if (type === 'function_call') { argumentsObject(item.arguments, maxArgumentBytes); value.arguments = item.arguments }
    else value.input = string(item.input, maxArgumentBytes)
    return value
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    fields(item, ['type', 'id', 'call_id', 'name', ...(type === 'function_call_output' ? ['namespace'] : []), 'output', 'internal_chat_message_metadata_passthrough'], 'Unsupported tool-output field.')
    optionalId(item.id)
    nullableOnly(item.internal_chat_message_metadata_passthrough, 'Opaque internal tool-output metadata is not supported.')
    return { type, call_id: identifier(item.call_id), output: textParts(item.output, maxOutputBytes, ['input_text']), ...(item.name == null ? {} : { name: name(item.name) }), ...(item.namespace == null ? {} : { namespace: name(item.namespace) }) }
  }
  if (type === 'reasoning') {
    fields(item, ['type', 'id', 'summary', 'content', 'encrypted_content', 'internal_chat_message_metadata_passthrough'], 'Unsupported reasoning field.')
    historyCommon(item)
    const summary = textParts(item.summary, maxOutputBytes, ['summary_text'])
    const content = item.content == null ? '' : textParts(item.content, maxOutputBytes, ['reasoning_text', 'text'])
    if (summary && !content) unsupported('Reasoning summaries cannot be substituted for original provider reasoning.')
    return { type, ...(item.id ? { id: item.id } : {}), summary: summary ? [{ type: 'summary_text', text: summary }] : [], ...(content ? { content: [{ type: 'reasoning_text', text: content }] } : {}) }
  }
  unsupported('Unsupported input item type. Compaction, configuration updates, hosted tools, tool search, and multimodal items are never silently discarded.')
}
function stringMap(value) {
  if (!record(value) || Object.keys(value).length > 64) invalid('Invalid request metadata.')
  for (const [key, entry] of Object.entries(value)) { string(key, 256, false); string(entry, 2048) }
}
export function decodeRequest(payload, { provider, customGrammarMode = 'reject', limits = {}, lookupReplay } = {}) {
  fields(payload, ['model', 'instructions', 'input', 'input_items', 'stream', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'max_output_tokens', 'store', 'include', 'text', 'previous_response_id', 'prompt_cache_key', 'metadata', 'client_metadata', 'service_tier', 'stream_options', 'background', 'truncation'], 'Unsupported Responses request parameter. Compact/context-management and unknown parameters are not dropped.')
  if (payload.model !== provider.model) throw new BridgeError('bridge-model-mismatch', 'The requested model must match the bound provider model.', 409)
  if (payload.previous_response_id != null) unsupported('previous_response_id is not supported. Send the complete ordered input history on the same live binding.')
  if (boolean(payload.store, false)) unsupported('Persistent Responses storage is not supported; use store:false and complete input history.')
  if (boolean(payload.background, false)) unsupported('Background Responses are not supported.')
  if (payload.truncation !== undefined && payload.truncation !== 'disabled') unsupported('Automatic truncation and compaction are not supported.')
  if (payload.service_tier != null && payload.service_tier !== 'auto') unsupported('Explicit service tiers are not supported.')
  const catalog = compileTools(payload.tools, { ...limits, customGrammarMode, strictTools: provider.compat?.strictTools === true })
  const warnings = catalog.warnings
  const stream = boolean(payload.stream, false)
  if (stream && catalog.tools.length) warnings.add('validated-tools')
  let parallelToolCalls = boolean(payload.parallel_tool_calls, true)
  if (parallelToolCalls && provider.compat?.parallelToolCalls === false) { parallelToolCalls = false; warnings.add('parallel-tools-disabled') }
  const toolChoice = chooseTool(payload.tool_choice, catalog)
  if (payload.include !== undefined) {
    if (!Array.isArray(payload.include) || payload.include.some((entry) => entry !== 'reasoning.encrypted_content')) unsupported('Only reasoning.encrypted_content is a recognized include request, and it is unavailable for translated providers.')
    if (payload.include.length) warnings.add('encrypted-reasoning-unavailable')
  }
  let effort
  let showReasoning = true
  if (payload.reasoning != null) {
    fields(payload.reasoning, ['effort', 'summary'], 'Unsupported reasoning controls.')
    if (payload.reasoning.effort != null) {
      if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(payload.reasoning.effort)) unsupported('Unsupported reasoning effort; no effort is guessed.')
      effort = payload.reasoning.effort
      if ((provider.compat?.reasoningFormat ?? 'none') === 'none' && !(provider.reasoningEfforts?.length)) { effort = undefined; warnings.add('reasoning-effort-unavailable') }
      else if (!provider.reasoningEfforts?.includes(effort)) unsupported('The requested reasoning effort is not in the bound provider capability list. Choose a declared effort or correct the provider configuration; no effort mapping is inferred.')
    }
    if (payload.reasoning.summary != null) {
      if (!['auto', 'concise', 'detailed', 'none'].includes(payload.reasoning.summary)) unsupported('Unsupported reasoning summary setting.')
      showReasoning = payload.reasoning.summary !== 'none'
      if (showReasoning) warnings.add('reasoning-summary-unavailable')
    }
  }
  let maxOutputTokens
  if (payload.max_output_tokens !== undefined) {
    if (!Number.isSafeInteger(payload.max_output_tokens) || payload.max_output_tokens <= 0 || payload.max_output_tokens > 1000000) invalid('Invalid max_output_tokens.')
    maxOutputTokens = payload.max_output_tokens
  }
  if (payload.text != null) {
    fields(payload.text, ['format', 'verbosity'], 'Unsupported text controls.')
    if (payload.text.format != null) {
      fields(payload.text.format, ['type'], 'Structured output schemas are not supported by this bridge.')
      if (payload.text.format.type !== 'text') unsupported('Only plain-text output formatting is supported.')
    }
    if (payload.text.verbosity != null) {
      if (!['low', 'medium', 'high'].includes(payload.text.verbosity)) unsupported('Unsupported text verbosity.')
      warnings.add('text-verbosity-not-forwarded')
    }
  }
  if (payload.stream_options != null) {
    fields(payload.stream_options, ['reasoning_summary_delivery'], 'Unsupported stream option.')
    if (payload.stream_options.reasoning_summary_delivery !== 'sequential_cutoff') unsupported('Unsupported reasoning-summary delivery mode.')
    warnings.add('reasoning-delivery-buffered')
  }
  if (payload.prompt_cache_key != null) { string(payload.prompt_cache_key, 512); warnings.add('prompt-cache-not-forwarded') }
  if (payload.client_metadata != null) { stringMap(payload.client_metadata); warnings.add('client-metadata-local-only') }
  if (payload.metadata != null) stringMap(payload.metadata)
  if (payload.input !== undefined && payload.input_items !== undefined) invalid('Specify input or input_items, not both.')
  let raw = payload.input ?? payload.input_items
  if (typeof raw === 'string') raw = [{ role: 'user', content: raw }]
  if (!Array.isArray(raw) || raw.length > (limits.maxInputItems ?? 600)) invalid('Complete input history is required and must fit the input-item limit.')
  const items = raw.map((item) => normalizeInputItem(item, { ...limits, warnings }))
  const messages = messagesFromInput(items, { apiFormat: provider.apiFormat, lookupReplay })
  if (payload.instructions != null) messages.unshift({ role: 'system', content: string(payload.instructions, limits.maxBodyBytes ?? 2 * 1024 * 1024) })
  if (!messages.length) invalid('At least one input message is required.')
  return { catalog, tools: catalog.tools, messages, stream, parallelToolCalls, toolChoice, responseToolChoice: structuredClone(payload.tool_choice ?? 'auto'), effort, maxOutputTokens, showReasoning, warnings: [...warnings].sort(), metadata: structuredClone(payload.metadata ?? {}) }
}

export function itemFingerprint(item) {
  if (item.type === 'message') return stableJson({ type: item.type, role: item.role, text: textParts(item.content, 2 * 1024 * 1024), phase: item.phase ?? null })
  if (item.type === 'reasoning') return stableJson({ type: item.type, summary: item.summary ?? [], content: item.content ?? [] })
  if (item.type === 'function_call' || item.type === 'custom_tool_call') return stableJson({ type: item.type, name: item.name, namespace: item.namespace ?? null, call_id: item.call_id, ...(item.type === 'function_call' ? { arguments: item.arguments } : { input: item.input }) })
  return stableJson(item)
}
export function replayItemMatches(expected, actual) {
  if (expected.id && actual.id && expected.id !== actual.id) return false
  // Fixed Codex may omit unencrypted reasoning content when serializing history.
  // An omitted content field can be restored only by the same standard item ID.
  if (expected.type === 'reasoning' && actual.type === 'reasoning' && !actual.content?.length && expected.id === actual.id) return stableJson(expected.summary ?? []) === stableJson(actual.summary ?? [])
  return itemFingerprint(expected) === itemFingerprint(actual)
}
export function itemKeys(item) {
  return [...(item.id ? [`id:${item.id}`] : []), ...(item.call_id ? [`call:${item.call_id}`] : [])]
}
function ownedItem(item) { return /^(?:msg|rs|fc|ct)_dsh_/.test(item.id ?? '') }
function textOf(item) { return (item.content ?? []).map((part) => part.text ?? '').join('') }
function callOf(item) { return { id: item.call_id, type: 'function', function: { name: flatToolName(item.namespace, item.name), arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments } } }
export function messagesFromInput(items, { apiFormat, lookupReplay } = {}) {
  if (apiFormat === 'anthropic-messages') {
    let sawConversation = false
    for (const item of items) {
      const system = item.type === 'message' && ['system', 'developer'].includes(item.role)
      if (system && sawConversation) unsupported('Anthropic system messages must precede conversation history; an interleaved system instruction cannot be silently reordered.')
      if (!system) sawConversation = true
    }
  }
  const messages = []
  const seenCalls = new Set()
  const pending = new Map()
  let previousKind = ''
  const register = (item) => {
    if (seenCalls.has(item.call_id)) invalid('Duplicate tool-call identifier in history.')
    seenCalls.add(item.call_id)
    pending.set(item.call_id, item)
  }
  for (let i = 0; i < items.length;) {
    const item = items[i]
    const isAssistant = item.type === 'reasoning' || item.type === 'function_call' || item.type === 'custom_tool_call' || (item.type === 'message' && item.role === 'assistant')
    if (isAssistant) {
      const replay = lookupReplay?.(items, i)
      if (replay) {
        if (pending.size) invalid('Tool outputs must precede the next assistant round.')
        for (const restored of items.slice(i, i + replay.count)) if (['function_call', 'custom_tool_call'].includes(restored.type)) register(restored)
        messages.push(structuredClone(replay.message))
        i += replay.count
        previousKind = 'cached'
        continue
      }
      if (apiFormat === 'anthropic-messages' || ownedItem(item)) replayUnavailable()
      if (item.type === 'message') {
        if (pending.size) invalid('Assistant text after tool calls cannot be reordered into Chat history.')
        if (previousKind === 'reasoning') messages.at(-1).content = textOf(item)
        else messages.push({ role: 'assistant', content: textOf(item) })
        previousKind = 'assistant'
      } else if (item.type === 'reasoning') {
        if (pending.size) invalid('Reasoning after tool calls cannot be reordered into Chat history.')
        if (!textOf(item)) replayUnavailable()
        messages.push({ role: 'assistant', content: '', reasoning_content: textOf(item) })
        previousKind = 'reasoning'
      } else {
        if (!['assistant', 'call', 'reasoning'].includes(previousKind)) {
          if (pending.size) invalid('Tool outputs must precede the next assistant round.')
          messages.push({ role: 'assistant', content: '' })
        }
        register(item)
        const message = messages.at(-1)
        message.tool_calls ??= []
        message.tool_calls.push(callOf(item))
        previousKind = 'call'
      }
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const call = pending.get(item.call_id)
      if (!call || `${call.type}_output` !== item.type) invalid('Tool outputs must match a preceding call exactly once and retain their original order.')
      if ((item.name != null && item.name !== call.name) || (item.namespace != null && item.namespace !== call.namespace)) invalid('Tool-output identity does not match its call.')
      pending.delete(item.call_id)
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output })
      previousKind = 'tool'
    } else {
      if (pending.size) invalid('Missing tool output before the next message.')
      messages.push({ role: item.role, content: textOf(item) })
      previousKind = 'message'
    }
    i += 1
  }
  if (pending.size) invalid('Every preceding tool call needs its CLI-produced output before another model round.')
  return messages
}

export function validateRound(result, request, { maxOutputBytes = 2 * 1024 * 1024, maxArgumentBytes = 512 * 1024, maxOutputCalls = 40 } = {}) {
  if (!record(result) || typeof result.text !== 'string' || (result.reasoningContent !== undefined && typeof result.reasoningContent !== 'string') || !Array.isArray(result.toolCalls)) throw new BridgeError('bridge-upstream-protocol', 'The provider did not return a validated complete round.', 502)
  if (result.status !== undefined && result.status !== 'completed' || result.finishReason !== undefined && !['stop', 'tool_calls'].includes(result.finishReason)) throw new BridgeError('bridge-upstream-protocol', 'The provider round did not have a successful terminal state.', 502)
  if (Buffer.byteLength(JSON.stringify(result)) > maxOutputBytes || result.toolCalls.length > maxOutputCalls) throw new BridgeError('bridge-output-limit', 'The complete provider output exceeds the bridge limit.', 413)
  const seen = new Set()
  const calls = result.toolCalls.map((call) => {
    if (!record(call)) invalid()
    const id = identifier(call.id)
    if (seen.has(id)) invalid('Duplicate provider tool-call identifier.')
    seen.add(id)
    const tool = request.catalog.byFlatName.get(call.name)
    if (!tool) throw new BridgeError('bridge-upstream-tool', 'The provider selected an undeclared tool.', 502)
    argumentsObject(call.arguments, maxArgumentBytes)
    return { id, tool, arguments: call.arguments, ...(tool.type === 'custom' ? { input: unwrapCustomArguments(call.arguments, maxArgumentBytes) } : {}) }
  })
  if (request.toolChoice === 'none' && calls.length) throw new BridgeError('bridge-upstream-tool', 'The provider violated tool_choice:none.', 502)
  if (request.toolChoice === 'required' && !calls.length) throw new BridgeError('bridge-upstream-tool', 'The provider did not satisfy tool_choice:required.', 502)
  if (record(request.toolChoice) && (!calls.length || calls.some((call) => call.tool.flatName !== request.toolChoice.function.name))) throw new BridgeError('bridge-upstream-tool', 'The provider did not satisfy the selected tool choice.', 502)
  if (!request.parallelToolCalls && calls.length > 1) throw new BridgeError('bridge-upstream-tool', 'The provider violated parallel_tool_calls:false.', 502)
  if (!result.text && !calls.length) throw new BridgeError('bridge-upstream-protocol', 'The provider returned no complete text or tool call.', 502)
  return { text: result.text, reasoningContent: result.reasoningContent ?? '', calls }
}
export function responsesUsage(usage) {
  if (usage == null) return null
  if (!record(usage) || !nonnegative(usage.inputTokens) || !nonnegative(usage.outputTokens)) throw new BridgeError('bridge-upstream-protocol', 'Invalid provider token usage.', 502)
  const total = usage.totalTokens ?? usage.inputTokens + usage.outputTokens
  if (!nonnegative(total) || (usage.cachedInputTokens !== undefined && !nonnegative(usage.cachedInputTokens)) || (usage.reasoningTokens !== undefined && !nonnegative(usage.reasoningTokens))) throw new BridgeError('bridge-upstream-protocol', 'Invalid provider token usage.', 502)
  return { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: total, ...(usage.cachedInputTokens === undefined ? {} : { input_tokens_details: { cached_tokens: usage.cachedInputTokens } }), ...(usage.reasoningTokens === undefined ? {} : { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } }) }
}
