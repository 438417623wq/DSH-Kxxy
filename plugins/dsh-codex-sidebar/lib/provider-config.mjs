import { createHash } from 'node:crypto'
import { CodexError } from './transport.mjs'

export const API_FORMATS = Object.freeze(['chat-completions', 'responses', 'anthropic-messages'])
export const AUTH_TYPES = Object.freeze(['bearer', 'x-api-key', 'api-key', 'none'])
export const PROVIDER_PROFILES = Object.freeze(['standard', 'deepseek', 'local', 'anthropic'])
const CONTROL = /[\u0000-\u001f\u007f]/
const MAX_TOKENS = 1048576
const HEADER_NAME = /^[!#$%&'*+.^_`|~\da-z-]{1,128}$/i
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-connection', 'expect', 'content-type', 'accept', 'accept-encoding', 'origin', 'referer'])
const CREDENTIAL_HEADER = /(?:authorization|authentication|cookie|(?:^|[-_])(?:auth|token|secret|password|credential|apikey|api[-_]key|access[-_]key|subscription[-_]key|key)(?:$|[-_]))/i
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ENDPOINTS = { 'chat-completions': '/chat/completions', responses: '/responses', 'anthropic-messages': '/messages' }
const has = (value, key) => Object.hasOwn(value, key) && value[key] !== undefined
const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function fail(code, message) { throw new CodexError(code, message) }
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) fail('model-input', `${label}格式不正确`)
  return value.trim()
}
function choice(value, values, code, label) {
  if (!values.includes(value)) fail(code, `${label}格式不正确`)
  return value
}
function integer(value, label, minimum = 1) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_TOKENS) fail('model-tokens', `${label}必须是 ${minimum}–${MAX_TOKENS} 范围内的整数`)
  return value
}

/** Keep explicit endpoints intact. Query parameters have a separately validated private field. */
export function normalizeBaseUrl(value) {
  const input = text(value, 'URL', 2048)
  let url
  try { url = new URL(input) } catch { fail('model-url', '请输入有效的 HTTP 或 HTTPS URL') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || input.includes('?') || input.includes('#') || /^https?:\/\/[^/]*@/i.test(input) || /%(?:0[\da-f]|1[\da-f]|7f)/i.test(input)) fail('model-url', 'URL 仅支持 HTTP/HTTPS，不能包含账号、密码、查询参数、控制字符或片段')
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.href.replace(/\/+$/, '')
}

function defaultCompat(format) {
  return {
    systemRole: 'system', tokenField: 'max_tokens', parallelToolCalls: true, strictTools: false,
    store: format === 'responses', includeReasoning: format === 'responses', reasoningFormat: 'none',
  }
}

export function resolvedCompat(model) {
  return { ...defaultCompat(model.apiFormat ?? 'chat-completions'), ...(model.compat ?? {}) }
}

function preset(profile) {
  if (profile === 'deepseek') return { apiFormat: 'chat-completions', authType: 'bearer', compat: { ...defaultCompat('chat-completions'), includeReasoning: true, reasoningFormat: 'deepseek' }, reasoningEfforts: ['none', 'high'], reasoningEffort: 'high', maxOutputTokens: null, thinkingBudget: null }
  if (profile === 'local') return { apiFormat: 'chat-completions', authType: 'none', compat: { ...defaultCompat('chat-completions'), parallelToolCalls: false }, reasoningEfforts: [], reasoningEffort: '', maxOutputTokens: null, thinkingBudget: null }
  if (profile === 'anthropic') return { apiFormat: 'anthropic-messages', authType: 'x-api-key', compat: { ...defaultCompat('anthropic-messages'), includeReasoning: true, reasoningFormat: 'thinking' }, reasoningEfforts: ['none', 'high'], reasoningEffort: 'none', maxOutputTokens: 4096, thinkingBudget: 1024 }
  return { apiFormat: 'chat-completions', authType: 'bearer', compat: defaultCompat('chat-completions'), reasoningEfforts: [], reasoningEffort: '', maxOutputTokens: null, thinkingBudget: null }
}

function privateObject(value, kind) {
  if (!plain(value)) fail(`model-${kind}`, `${kind === 'headers' ? '附加请求头' : '查询参数'}必须是 JSON 对象`)
  const entries = Object.entries(value)
  if (entries.length > 32) fail(`model-${kind}`, '附加参数数量超过上限')
  const result = {}
  for (const [rawName, item] of entries) {
    const name = kind === 'headers' ? rawName.toLowerCase() : rawName
    if (UNSAFE_KEYS.has(name.toLowerCase()) || (kind === 'headers' ? !HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name) || CREDENTIAL_HEADER.test(name) || name.startsWith('sec-') || name.startsWith('proxy-') : !/^[\da-z._~-]{1,128}$/i.test(name))) fail(`model-${kind}`, '附加参数名称不允许使用；认证请使用认证类型和 API key')
    if (typeof item !== 'string' || item.length > 4096 || CONTROL.test(item) || (kind === 'headers' && /[^\u0020-\u00ff]/.test(item)) || Object.hasOwn(result, name)) fail(`model-${kind}`, '附加参数值必须是不含控制字符的短字符串，且名称不能重复')
    result[name] = item
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 24576) fail(`model-${kind}`, '附加参数总大小超过上限')
  return result
}

function normalizeCompat(input, base, format) {
  if (input !== undefined && !plain(input)) fail('model-compat', '兼容选项必须是 JSON 对象')
  const result = { ...defaultCompat(format), ...base }
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!Object.hasOwn(defaultCompat(format), key)) fail('model-compat', '兼容选项包含不支持的字段')
    if (key === 'systemRole') choice(value, ['system', 'developer'], 'model-compat', '系统消息角色')
    else if (key === 'tokenField') choice(value, ['max_tokens', 'max_completion_tokens'], 'model-compat', '输出上限字段')
    else if (key === 'reasoningFormat') choice(value, ['none', 'reasoning_effort', 'deepseek', 'thinking'], 'model-compat', '推理格式')
    else if (typeof value !== 'boolean') fail('model-compat', '兼容开关必须是布尔值')
    result[key] = value
  }
  return result
}

/** The only configuration validator, shared by save, discovery, probes and generation. */
export function normalizeProvider(input, { existing = null, requireModel = true, requireName = false } = {}) {
  if (!plain(input)) fail('model-input', '模型设置必须是对象')
  const profile = choice(input.profile ?? existing?.profile ?? 'standard', PROVIDER_PROFILES, 'model-profile', '兼容预设')
  // Selecting a different preset is explicit intent. Ordinary edits never reapply it.
  let selectedPreset = has(input, 'profile') && (!existing || input.profile !== existing.profile) ? preset(profile) : null
  const field = (key, fallback) => has(input, key) ? input[key] : selectedPreset && has(selectedPreset, key) ? selectedPreset[key] : existing?.[key] ?? fallback
  const apiFormat = choice(field('apiFormat', 'chat-completions'), API_FORMATS, 'model-format', '接口协议')
  if (selectedPreset && ['standard', 'local'].includes(profile)) selectedPreset = { ...selectedPreset, compat: { ...defaultCompat(apiFormat), ...(profile === 'local' ? { parallelToolCalls: false } : {}) } }
  const engine = choice(field('engine', 'workspace'), ['workspace', 'native'], 'model-engine', '执行引擎')
  const defaultAuth = profile === 'standard' && apiFormat === 'anthropic-messages' ? 'x-api-key' : selectedPreset?.authType ?? (apiFormat === 'anthropic-messages' ? 'x-api-key' : 'bearer')
  const authType = choice(has(input, 'authType') ? input.authType : selectedPreset ? defaultAuth : existing?.authType ?? defaultAuth, AUTH_TYPES, 'model-auth', '认证类型')
  const baseUrl = normalizeBaseUrl(field('baseUrl'))
  let apiKey = existing?.apiKey ?? ''
  if (has(input, 'apiKey') && !(typeof input.apiKey === 'string' && !input.apiKey.trim())) apiKey = text(input.apiKey, 'API key', 4096)
  if (apiKey) apiKey = text(apiKey, 'API key', 4096)
  if (!apiKey && authType !== 'none') fail('model-key', '此认证类型需要填写 API key；无密钥服务请选择无认证')
  const compatBase = selectedPreset?.compat ?? (existing?.apiFormat === apiFormat ? existing?.compat : undefined)
  const compat = normalizeCompat(has(input, 'compat') ? input.compat : undefined, compatBase, apiFormat)
  if (compat.reasoningFormat === 'deepseek' && apiFormat !== 'chat-completions' || compat.reasoningFormat === 'thinking' && apiFormat !== 'anthropic-messages' || compat.reasoningFormat === 'reasoning_effort' && apiFormat === 'anthropic-messages') fail('model-compat', '所选推理格式与接口协议不匹配')
  const efforts = field('reasoningEfforts', [])
  if (!Array.isArray(efforts) || efforts.length > 16 || efforts.some((item) => typeof item !== 'string' || !/^[\da-z_-]{1,32}$/i.test(item)) || new Set(efforts).size !== efforts.length) fail('model-reasoning', '推理强度列表必须包含最多 16 个不同的短标识')
  const reasoningEffort = field('reasoningEffort', '')
  if (typeof reasoningEffort !== 'string' || reasoningEffort && !efforts.includes(reasoningEffort)) fail('model-reasoning', '默认推理强度必须位于已配置的强度列表中')
  const maxOutputTokens = integer(field('maxOutputTokens', null), '输出 token 上限')
  const thinkingBudget = integer(field('thinkingBudget', null), '思考预算', 1024)
  if (thinkingBudget !== null && maxOutputTokens !== null && thinkingBudget >= maxOutputTokens) fail('model-tokens', '思考预算必须小于输出 token 上限')
  const value = {
    ...(existing?.id || input.id ? { id: existing?.id ?? input.id } : {}),
    ...(requireName || has(input, 'name') || existing?.name ? { name: text(field('name'), '模型名称', 100) } : {}),
    model: requireModel ? text(field('model'), '模型 ID', 256) : typeof field('model') === 'string' && field('model').trim() ? text(field('model'), '模型 ID', 256) : null,
    baseUrl, apiFormat, engine, apiKey, authType, profile, compat,
    headers: privateObject(field('headers', {}), 'headers'), query: privateObject(field('query', {}), 'query'),
    reasoningEfforts: [...efforts], reasoningEffort, maxOutputTokens, thinkingBudget,
  }
  providerUrl(value) // Reject mismatching explicit endpoints before saving or sending.
  return value
}

export function providerUrl(model, operation = 'generate') {
  if (!['generate', 'models'].includes(operation)) fail('model-url', '不支持的模型服务操作')
  const url = new URL(normalizeBaseUrl(model.baseUrl))
  const path = url.pathname.replace(/\/+$/, '')
  const endpoint = Object.values(ENDPOINTS).find((suffix) => path.endsWith(suffix))
  if (operation === 'models') url.pathname = `${endpoint ? path.slice(0, -endpoint.length) : path}/models`
  else {
    const expected = ENDPOINTS[model.apiFormat ?? 'chat-completions']
    if (!expected || endpoint && endpoint !== expected) fail('model-url', '完整接口路径与所选协议不一致，请检查 URL 和接口类型')
    url.pathname = endpoint ? path : `${path}${expected}`
  }
  for (const [key, value] of Object.entries(privateObject(model.query ?? {}, 'query'))) url.searchParams.append(key, value)
  return url.href
}

export function providerHeaders(model, { json = true, stream = true } = {}) {
  const headers = { ...privateObject(model.headers ?? {}, 'headers'), accept: stream ? 'text/event-stream, application/json' : 'application/json' }
  if (json) headers['content-type'] = 'application/json'
  if (model.apiFormat === 'anthropic-messages' && !headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
  const auth = model.authType ?? (model.apiFormat === 'anthropic-messages' ? 'x-api-key' : 'bearer')
  choice(auth, AUTH_TYPES, 'model-auth', '认证类型')
  if (auth !== 'none') {
    const key = text(model.apiKey, 'API key', 4096)
    headers[auth === 'bearer' ? 'authorization' : auth] = auth === 'bearer' ? `Bearer ${key}` : key
  }
  return headers
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  return value
}
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/** Private semantic identity. Default extension fields intentionally retain the version-1 hash. */
export function modelRevision(model) {
  const format = model.apiFormat ?? 'chat-completions'
  const fields = [model.baseUrl, model.model, format]
  if (model.engine === 'native') fields.push('native')
  const extra = {}
  if (model.authType && model.authType !== (format === 'anthropic-messages' ? 'x-api-key' : 'bearer')) extra.authType = model.authType
  for (const key of ['headers', 'query']) if (Object.keys(model[key] ?? {}).length) extra[key] = model[key]
  const defaults = defaultCompat(format)
  const compat = Object.fromEntries(Object.entries(resolvedCompat(model)).filter(([key, value]) => value !== defaults[key]))
  if (Object.keys(compat).length) extra.compat = compat
  if (model.reasoningEfforts?.length) extra.reasoningEfforts = model.reasoningEfforts
  if (model.reasoningEffort) extra.reasoningEffort = model.reasoningEffort
  if (model.maxOutputTokens != null) extra.maxOutputTokens = model.maxOutputTokens
  if (model.thinkingBudget != null) extra.thinkingBudget = model.thinkingBudget
  if (Object.keys(extra).length) fields.push(stable(extra))
  return hash(fields)
}

/** Credential identity is server-only and must never be used as a public configuration version. */
export function credentialRevision(model) { return hash([model.apiKey ?? '']) }
export function providerSecrets(model) {
  const values = [model?.apiKey, ...Object.values(model?.headers ?? {}), ...Object.values(model?.query ?? {})].filter((value) => typeof value === 'string' && value.length)
  const variants = (value) => {
    let encoded = value
    try { encoded = encodeURIComponent(value) } catch {}
    return [value, encoded, new URLSearchParams({ v: value }).toString().slice(2)]
  }
  return [...new Set(values.flatMap(variants))].sort((a, b) => b.length - a.length)
}
export function redactProviderText(value, model) {
  let output = String(value)
  for (const secret of providerSecrets(model)) output = output.split(secret).join('[已隐藏]')
  return output.replace(/\bsk-[\w-]{12,}/g, '[已隐藏]').replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏]')
}

/** Public metadata contains parameter names, never parameter values or private fingerprints. */
export function providerMetadata(model) {
  const { id, name, apiFormat = 'chat-completions', engine = 'workspace', profile = 'standard' } = model
  const compat = resolvedCompat(model)
  return {
    id, name: redactProviderText(name ?? model.model, model), model: redactProviderText(model.model, model), baseUrl: redactProviderText(model.baseUrl, model),
    apiFormat, engine, profile, authType: model.authType ?? (apiFormat === 'anthropic-messages' ? 'x-api-key' : 'bearer'),
    hasApiKey: !!model.apiKey, hasHeaders: !!Object.keys(model.headers ?? {}).length, hasQuery: !!Object.keys(model.query ?? {}).length,
    headerNames: Object.keys(model.headers ?? {}).sort(), queryNames: Object.keys(model.query ?? {}).sort(),
    compat, reasoningEfforts: [...(model.reasoningEfforts ?? [])], reasoningEffort: model.reasoningEffort ?? '', maxOutputTokens: model.maxOutputTokens ?? null, thinkingBudget: model.thinkingBudget ?? null,
    source: engine === 'native' ? 'native-custom' : 'custom',
    capabilities: ['text', 'stream', 'tools'].map((id) => ({ id, source: 'protocol' })).concat(compat.reasoningFormat !== 'none' || compat.includeReasoning ? [{ id: 'reasoning', source: 'configuration' }] : []),
  }
}
