import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamCustomChat } from '../plugins/dsh-codex-sidebar/lib/custom-chat.mjs'
import { CustomModels } from '../plugins/dsh-codex-sidebar/lib/custom-models.mjs'
import { normalizeProvider, normalizeBaseUrl, providerHeaders, providerUrl, resolvedCompat, providerMetadata, modelRevision, credentialRevision, providerSecrets, redactProviderText } from '../plugins/dsh-codex-sidebar/lib/provider-config.mjs'
import { buildProviderPayload } from '../plugins/dsh-codex-sidebar/lib/provider-protocols.mjs'
import { testProviderModel, fetchProviderModels, providerConfiguration } from '../plugins/dsh-codex-sidebar/lib/provider-api.mjs'

const KEY = 'private-protocol-key-no-prefix'
const MODEL = { name: 'Fixture', model: 'fixture-model', baseUrl: 'https://fixture.invalid/service', apiKey: KEY, apiFormat: 'chat-completions' }
const MESSAGES = [{ role: 'user', content: 'Hello' }]
const TOOLS = [{ type: 'function', function: { name: 'fixture_echo', description: 'No side effects', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }]
const jsonResponse = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' } })
const chat = (content = 'OK', extra = {}) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', ...extra }] })
const response = (text = 'OK', extra = {}) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], ...extra })
const anthropic = (content = [{ type: 'text', text: 'OK' }], extra = {}) => ({ type: 'message', role: 'assistant', content, stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 }, ...extra })
function sse(events, { separator = '\n', oneByte = false } = {}) {
  const raw = events.map((entry) => typeof entry === 'string' ? `data: ${entry}${separator}${separator}` : `${entry.event ? `event: ${entry.event}${separator}` : ''}data: ${JSON.stringify(entry.data ?? entry)}${separator}${separator}`).join('')
  const bytes = new TextEncoder().encode(raw)
  return new Response(oneByte ? new ReadableStream({ start(controller) { for (const value of bytes) controller.enqueue(Uint8Array.of(value)); controller.close() } }) : bytes, { headers: { 'content-type': 'text/event-stream' } })
}
const run = (body, options = {}) => streamCustomChat({ model: MODEL, messages: MESSAGES, fetchImpl: async () => body, ...options })
const ccall = (id = 'call-1', name = 'fixture_echo', args = '{"value":"ok"}') => ({ id, type: 'function', function: { name, arguments: args } })
const rcall = (id = 'call-1', name = 'fixture_echo', args = '{"value":"ok"}') => ({ type: 'function_call', id: `item-${id}`, call_id: id, name, arguments: args })

// No test in this file has a real network implementation: .invalid URLs must only reach fixtures.
test('configuration shares protocol, auth, explicit endpoint and independent query rules', () => {
  for (const [apiFormat, path] of [['chat-completions', '/chat/completions'], ['responses', '/responses'], ['anthropic-messages', '/messages']]) {
    const model = normalizeProvider({ ...MODEL, apiFormat, baseUrl: `https://fixture.invalid/custom${path}/`, query: { deployment: 'test value', 'api-version': '2026-01' } })
    assert.equal(model.baseUrl, `https://fixture.invalid/custom${path}`)
    assert.equal(providerUrl(model), `https://fixture.invalid/custom${path}?deployment=test+value&api-version=2026-01`)
    assert.equal(providerUrl(model, 'models'), 'https://fixture.invalid/custom/models?deployment=test+value&api-version=2026-01')
    assert.equal(providerHeaders(model).authorization, apiFormat === 'anthropic-messages' ? undefined : `Bearer ${KEY}`)
    if (apiFormat === 'anthropic-messages') { assert.equal(model.authType, 'x-api-key'); assert.equal(providerHeaders(model)['anthropic-version'], '2023-06-01') }
  }
  assert.equal(providerUrl(normalizeProvider({ ...MODEL, baseUrl: 'http://127.0.0.1:3000' })), 'http://127.0.0.1:3000/chat/completions')
  assert.throws(() => normalizeProvider({ ...MODEL, baseUrl: 'https://fixture.invalid/responses' }), { code: 'model-url' })
  for (const bad of ['file:///tmp/a', 'https://u:p@fixture.invalid/v1', 'https://@fixture.invalid/v1', 'https://fixture.invalid/v1?', 'https://fixture.invalid/v1#', 'https://fixture.invalid/%0a']) assert.throws(() => normalizeBaseUrl(bad))
})

test('all authentication modes and validated header/query preservation reach one request builder', async () => {
  for (const authType of ['bearer', 'x-api-key', 'api-key', 'none']) {
    let captured
    const model = { ...MODEL, authType, apiKey: authType === 'none' ? '' : KEY, headers: { 'X-Deployment': 'isolated' }, query: { region: 'west' } }
    await run(jsonResponse(chat()), { model, fetchImpl: async (url, init) => { captured = { url, init }; return jsonResponse(chat()) } })
    assert.equal(captured.url, 'https://fixture.invalid/service/chat/completions?region=west')
    assert.equal(captured.init.headers['x-deployment'], 'isolated')
    const authHeaders = Object.keys(captured.init.headers).filter((key) => ['authorization', 'x-api-key', 'api-key'].includes(key))
    assert.equal(authHeaders.length, authType === 'none' ? 0 : 1)
    if (authType !== 'none') assert.equal(captured.init.headers[authType === 'bearer' ? 'authorization' : authType], authType === 'bearer' ? `Bearer ${KEY}` : KEY)
  }
  const saved = normalizeProvider({ ...MODEL, id: 'saved', headers: { 'x-tenant': 'private-tenant' }, query: { key: 'private-query' } })
  const edited = providerConfiguration({ id: 'saved', apiKey: '', name: 'new' }, { models: { get: () => saved }, requireModel: true })
  assert.deepEqual(edited.headers, saved.headers); assert.deepEqual(edited.query, saved.query); assert.equal(edited.apiKey, KEY)
  const cleared = normalizeProvider({ headers: {}, query: {} }, { existing: saved })
  assert.deepEqual(cleared.headers, {}); assert.deepEqual(cleared.query, {})
  for (const name of ['Authorization', 'Host', 'content-length', 'connection', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'x-goog-api-key', 'Proxy-Authorization', 'sec-fetch-site', 'content-type', 'x-access-token', 'x-secret', 'x-key', 'ocp-apim-subscription-key']) assert.throws(() => normalizeProvider({ ...MODEL, headers: { [name]: 'bad' } }), { code: 'model-headers' })
  for (const headers of [{ 'bad\r\nname': 'x' }, { 'x-ok': 'bad\r\nx' }, { 'x-ok': 123 }, [], JSON.parse('{"__proto__":"bad"}'), { 'X-Test': 'a', 'x-test': 'b' }]) assert.throws(() => normalizeProvider({ ...MODEL, headers }))
  for (const query of [{ q: 'a\0b' }, { 'bad name': 'x' }, { q: 1 }, JSON.parse('{"constructor":"bad"}')]) assert.throws(() => normalizeProvider({ ...MODEL, query }))
})

test('presets are explicit, fields bounded and native engine accepts all protocols', () => {
  const named = normalizeProvider({ ...MODEL, model: 'deepseek-claude-local', name: 'Anthropic' })
  assert.equal(named.profile, 'standard'); assert.equal(named.authType, 'bearer'); assert.equal(named.compat.reasoningFormat, 'none')
  const local = normalizeProvider({ name: 'Local', model: 'model', baseUrl: 'http://127.0.0.1:3000', profile: 'local' })
  assert.equal(local.authType, 'none'); assert.equal(local.apiKey, '')
  const claude = normalizeProvider({ ...MODEL, apiFormat: undefined, profile: 'anthropic' })
  assert.equal(claude.apiFormat, 'anthropic-messages'); assert.equal(claude.authType, 'x-api-key'); assert.equal(claude.compat.reasoningFormat, 'thinking')
  const custom = normalizeProvider({ ...MODEL, profile: 'deepseek', compat: { parallelToolCalls: false } })
  assert.equal(custom.compat.reasoningFormat, 'deepseek'); assert.equal(custom.compat.parallelToolCalls, false)
  const edited = normalizeProvider({ name: 'Renamed' }, { existing: custom })
  assert.deepEqual(edited.compat, custom.compat)
  for (const apiFormat of ['chat-completions', 'responses', 'anthropic-messages']) assert.equal(normalizeProvider({ ...MODEL, apiFormat, engine: 'native' }).engine, 'native')
  for (const extra of [{ maxOutputTokens: 0 }, { maxOutputTokens: 1048577 }, { maxOutputTokens: 1.5 }, { thinkingBudget: 100 }, { thinkingBudget: 1024, maxOutputTokens: 1024 }, { compat: { store: 'true' } }, { compat: { invented: true } }, { reasoningEfforts: ['high'], reasoningEffort: 'low' }, { reasoningEfforts: ['high', 'high'] }]) assert.throws(() => normalizeProvider({ ...MODEL, ...extra }))
})

test('metadata has only safe parameter names, revisions preserve legacy hashes and rotate correctly', () => {
  const legacy = { ...MODEL, engine: 'workspace' }
  const hash = createHash('sha256').update(JSON.stringify([legacy.baseUrl, legacy.model, legacy.apiFormat])).digest('hex')
  assert.equal(modelRevision(legacy), hash)
  assert.equal(modelRevision(normalizeProvider(legacy)), hash)
  const extended = normalizeProvider({ ...MODEL, headers: { 'x-tenant': 'private-tenant-value' }, query: { deployment: 'private-deployment-value' } })
  const meta = providerMetadata(extended), serialized = JSON.stringify(meta)
  assert.equal(meta.hasApiKey, true); assert.equal(meta.hasHeaders, true); assert.equal(meta.hasQuery, true)
  assert.deepEqual(meta.headerNames, ['x-tenant']); assert.deepEqual(meta.queryNames, ['deployment'])
  for (const secret of [KEY, 'private-tenant-value', 'private-deployment-value']) assert.ok(!serialized.includes(secret))
  assert.ok(!/credentialRevision|providerRevision|apiKey"/.test(serialized))
  assert.equal(modelRevision({ ...extended, apiKey: 'rotated' }), modelRevision(extended))
  assert.notEqual(credentialRevision({ ...extended, apiKey: 'rotated' }), credentialRevision(extended))
  for (const value of [{ authType: 'none' }, { headers: { 'x-tenant': 'different' } }, { query: { deployment: 'different' } }, { compat: { ...resolvedCompat(extended), store: true } }, { maxOutputTokens: 900 }]) assert.notEqual(modelRevision({ ...extended, ...value }), modelRevision(extended))
  assert.equal(modelRevision({ ...extended, headers: { a: 'A', b: 'B' } }), modelRevision({ ...extended, headers: { b: 'B', a: 'A' } }))
  assert.ok(providerSecrets(extended).includes('private-tenant-value'))
  assert.ok(!redactProviderText(`${KEY} private-deployment-value`, extended).includes('private-'))
})

test('version-1 migration keeps valid legacy revisions, preserves broken entries and never fetches', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-protocol-store-'))
  try {
    const id = `custom-${randomUUID()}`, path = join(home, 'sidebar-models.json')
    const legacy = { ...MODEL, id }, bad = { id: `custom-${randomUUID()}`, apiFormat: 'secret-bad-format', apiKey: 'bad-entry-secret', strange: { retain: [1, 2] } }
    await writeFile(path, JSON.stringify({ version: 1, models: [legacy, bad, null, { ...legacy, name: 'duplicate', apiKey: 'duplicate-secret' }] }))
    const before = await readFile(path, 'utf8')
    const store = new CustomModels(home)
    await store.load()
    assert.equal(store.metadata().length, 1); assert.equal(store.warnings().length, 3)
    assert.equal(await readFile(path, 'utf8'), before)
    assert.equal(modelRevision(store.get(id)), modelRevision(legacy))
    assert.ok(!JSON.stringify(store.warnings()).includes('secret'))
    await store.save({ id, name: 'Renamed', apiKey: '' })
    const data = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(data.version, 2); assert.equal(data.models[0].apiKey, KEY)
    assert.deepEqual(data.models.slice(1), [bad, null, { ...legacy, name: 'duplicate', apiKey: 'duplicate-secret' }])
    await store.delete(id)
    const remaining = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(remaining.models, data.models.slice(1))
    const restarted = new CustomModels(home); await restarted.load()
    assert.equal(restarted.warnings().length, 3)
    assert.equal(restarted.metadata().length, 0) // Deleting the valid copy must not resurrect a quarantined duplicate.
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('request compatibility maps system, token limits, strict tools and explicit reasoning without guessing', () => {
  const model = { ...MODEL, compat: { systemRole: 'developer', tokenField: 'max_completion_tokens', parallelToolCalls: false, strictTools: true, store: true, includeReasoning: true, reasoningFormat: 'reasoning_effort' }, reasoningEfforts: ['low', 'high'], reasoningEffort: 'low', maxOutputTokens: 800 }
  const { payload } = buildProviderPayload({ model, messages: [{ role: 'system', content: 'sys' }, { role: 'assistant', content: 'previous', reasoning_content: 'private reasoning', provider_replay: { apiFormat: 'anthropic-messages', content: [] } }], tools: TOOLS, effort: 'high', maxOutputTokens: 1200, stream: false })
  assert.equal(payload.messages[0].role, 'developer'); assert.equal(payload.messages[1].provider_replay, undefined)
  assert.equal(payload.messages[1].reasoning_content, 'private reasoning')
  assert.equal(payload.max_completion_tokens, 1200); assert.equal(payload.max_tokens, undefined)
  assert.equal(payload.reasoning_effort, 'high'); assert.equal(payload.store, false); assert.equal(payload.parallel_tool_calls, undefined)
  assert.equal(payload.tools[0].function.strict, true)
  const deep = buildProviderPayload({ model: { ...MODEL, profile: 'deepseek' }, messages: MESSAGES }).payload
  assert.deepEqual(deep.thinking, { type: 'enabled' })
  const res = buildProviderPayload({ model: { ...MODEL, apiFormat: 'responses', compat: { store: false, includeReasoning: false, reasoningFormat: 'reasoning_effort' }, reasoningEfforts: ['high'] }, messages: MESSAGES, effort: 'high', maxOutputTokens: 99 }).payload
  assert.equal(res.max_output_tokens, 99); assert.deepEqual(res.reasoning, { effort: 'high' }); assert.equal(res.store, undefined); assert.equal(res.include, undefined)
})

test('all three JSON protocols require success terminals and collect usage', async () => {
  const values = [
    ['chat-completions', { ...chat('你好'), usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8, completion_tokens_details: { reasoning_tokens: 2 } } }],
    ['responses', response('你好', { usage: { input_tokens: 3, output_tokens: 5, input_tokens_details: { cached_tokens: 1 } } })],
    ['anthropic-messages', anthropic([{ type: 'text', text: '你好' }], { usage: { input_tokens: 3, output_tokens: 5 } })],
  ]
  for (const [apiFormat, value] of values) {
    let visible = ''
    const result = await run(jsonResponse(value), { model: { ...MODEL, apiFormat }, onDelta: (part) => { visible += part }, stream: false })
    assert.equal(result.text, '你好'); assert.equal(visible, '你好'); assert.equal(result.finishReason, 'stop'); assert.equal(result.usage.totalTokens, 8); assert.equal(result.streamed, false)
  }
  for (const finish_reason of [undefined, 'length', 'content_filter', 'error', 'tool_calls']) await assert.rejects(run(jsonResponse(chat('partial', { finish_reason }))), { code: 'model-response' })
  for (const status of [undefined, 'incomplete', 'failed', 'cancelled', 'in_progress']) await assert.rejects(run(jsonResponse(response('partial', { status })), { model: { ...MODEL, apiFormat: 'responses' } }), { code: 'model-response' })
  for (const stop_reason of [undefined, 'max_tokens', 'pause_turn', 'refusal', 'tool_use']) await assert.rejects(run(jsonResponse(anthropic(undefined, { stop_reason })), { model: { ...MODEL, apiFormat: 'anthropic-messages' } }), { code: 'model-response' })
})

test('SSE supports byte-split UTF-8, LF, CRLF, CR, event-only types and usage trailers', async () => {
  for (const separator of ['\n', '\r\n', '\r']) {
    const result = await run(sse([
      { choices: [{ index: 0, delta: { content: '你好' } }] },
      { choices: [{ delta: { reasoning_content: '思考' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }, '[DONE]',
    ], { separator, oneByte: true }))
    assert.equal(result.text, '你好'); assert.equal(result.reasoningContent, '思考'); assert.equal(result.usage.totalTokens, 5)
    const res = await run(sse([
      { event: 'response.output_text.delta', data: { delta: '你好' } },
      { event: 'response.completed', data: { response: response('你好') } },
    ], { separator, oneByte: true }), { model: { ...MODEL, apiFormat: 'responses' } })
    assert.equal(res.text, '你好'); assert.equal(res.providerOutput.length, 1)
  }
})

test('early DONE, incomplete JSON/SSE, truncated UTF-8 and malformed terminals never return calls', async () => {
  for (const body of [sse([{ choices: [{ delta: { content: 'partial' } }] }]), sse([{ choices: [{ delta: { content: 'partial' } }] }, '[DONE]']), sse([{ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }, '[DONE]']), sse(['not-json']), sse([{ error: { message: KEY } }])]) await assert.rejects(run(body), { code: 'model-response' })
  for (const events of [
    [{ type: 'response.output_text.delta', delta: 'partial' }, '[DONE]'],
    [{ type: 'response.output_text.delta', delta: 'partial' }],
    [{ type: 'response.incomplete', response: response('partial', { status: 'incomplete' }) }],
    [{ event: 'response.failed', data: { response: response('partial') } }],
    [{ type: 'response.completed', response: response('partial', { status: undefined }) }],
  ]) await assert.rejects(run(sse(events), { model: { ...MODEL, apiFormat: 'responses' } }), { code: 'model-response' })
  const badUtf8 = new Response(Uint8Array.of(0xc3), { headers: { 'content-type': 'text/event-stream' } })
  await assert.rejects(run(badUtf8), { code: 'model-response' })
})

test('Chat tools assemble sparse indexes, validate full JSON schema and enforce unique IDs and choice', async () => {
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 900, id: 'call-9', type: 'function', function: { name: 'fixture_echo', arguments: '{"val' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 900, function: { arguments: 'ue":"ok"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
  ]
  const deltas = []
  const result = await run(sse(events, { oneByte: true }), { tools: TOOLS, onToolCallDelta: (delta) => deltas.push(delta) })
  assert.deepEqual(result.toolCalls, [{ id: 'call-9', name: 'fixture_echo', arguments: '{"value":"ok"}' }]); assert.equal(result.finishReason, 'tool_calls')
  assert.equal(deltas[0].index, 0); assert.equal(deltas.at(-1).done, true)
  for (const args of ['{', '{"value":', 'null', '[]', '"text"', '{"value":1}', '{}', '{"value":"ok","extra":true}']) await assert.rejects(run(jsonResponse(chat(null, { message: { tool_calls: [ccall('call-1', 'fixture_echo', args)] }, finish_reason: 'tool_calls' })), { tools: TOOLS }), { code: 'model-response' })
  for (const toolCalls of [[ccall('call-1', 'unknown')], [ccall('bad id')], [ccall(), ccall()]]) await assert.rejects(run(jsonResponse(chat(null, { message: { tool_calls: toolCalls }, finish_reason: 'tool_calls' })), { tools: TOOLS, parallelToolCalls: true }), { code: 'model-response' })
  await assert.rejects(run(jsonResponse(chat()), { tools: TOOLS, toolChoice: 'required' }), { code: 'model-response' })
  await assert.rejects(run(jsonResponse(chat(null, { message: { tool_calls: [ccall()] }, finish_reason: 'tool_calls' })), { tools: TOOLS, toolChoice: 'none' }), { code: 'model-response' })
})

test('parallel tool permission and call count limits are independent of sparse provider indexes', async () => {
  const calls = Array.from({ length: 40 }, (_, index) => ccall(`call-${index}`))
  // Servers that ignore parallel_tool_calls:false must not lose an otherwise valid reply:
  // the agent loop executes the calls sequentially, so the order is preserved instead of failing.
  const sequential = await run(jsonResponse(chat(null, { message: { tool_calls: calls.slice(0, 2) }, finish_reason: 'tool_calls' })), { tools: TOOLS })
  assert.deepEqual(sequential.toolCalls.map((call) => call.id), ['call-0', 'call-1'])
  const result = await run(jsonResponse(chat(null, { message: { tool_calls: calls }, finish_reason: 'tool_calls' })), { tools: TOOLS, parallelToolCalls: true })
  assert.equal(result.toolCalls.length, 40)
  await assert.rejects(run(jsonResponse(chat(null, { message: { tool_calls: [...calls, ccall('call-40')] }, finish_reason: 'tool_calls' })), { tools: TOOLS, parallelToolCalls: true }), { code: 'model-tools-limit' })
  await assert.rejects(run(jsonResponse(chat()), { model: { ...MODEL, compat: { parallelToolCalls: false } }, tools: TOOLS, parallelToolCalls: true }), { code: 'model-unsupported' })
  const payload = buildProviderPayload({ model: MODEL, messages: MESSAGES, tools: TOOLS, parallelToolCalls: true }).payload
  assert.equal(payload.parallel_tool_calls, true)
})

test('SiliconFlow/vLLM style nulls, repeated names, missing indexes and stop terminals stay usable', async () => {
  const tools = [...TOOLS, { type: 'function', function: { name: 'fixture_noargs', description: 'No arguments', parameters: { type: 'object', properties: {}, additionalProperties: false } } }]
  const repeated = await run(sse([
    { choices: [{ index: 0, delta: { content: '查看。' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'fixture_echo', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: null, type: 'function', function: { name: 'fixture_echo', arguments: '{"value":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: null, arguments: '"ok"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: null, completion_tokens: 7, total_tokens: null } },
    '[DONE]',
  ]), { tools })
  assert.deepEqual(repeated.toolCalls, [{ id: 'call-1', name: 'fixture_echo', arguments: '{"value":"ok"}' }])
  assert.equal(repeated.finishReason, 'tool_calls'); assert.equal(repeated.text, '查看。'); assert.equal(repeated.usage.outputTokens, 7); assert.equal(repeated.usage.inputTokens, undefined)
  const cumulative = await run(sse([
    { choices: [{ delta: { tool_calls: [{ index: 3, id: 'call:1.a', type: 'function', function: { name: 'fixture_', arguments: '{"value":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 3, id: null, function: { name: 'fixture_echo', arguments: '"ok"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: 'call:2', type: 'function', function: { name: 'fixture_noargs', arguments: '' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]), { tools })
  assert.deepEqual(cumulative.toolCalls, [{ id: 'call:2', name: 'fixture_noargs', arguments: '{}' }, { id: 'call:1.a', name: 'fixture_echo', arguments: '{"value":"ok"}' }])
  const tolerant = await run(sse([
    { choices: [{ delta: { tool_calls: null, function_call: null, content: '等' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'fixture_echo', arguments: '{"value":"ok"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: null } },
    '[DONE]',
  ]), { tools })
  assert.equal(tolerant.text, '等'); assert.equal(tolerant.toolCalls.length, 1)
  const json = await run(jsonResponse(chat(null, { message: { content: '好', tool_calls: [ccall('call-1', 'fixture_noargs', '')], function_call: null }, finish_reason: 'stop' })), { tools })
  assert.deepEqual(json.toolCalls, [{ id: 'call-1', name: 'fixture_noargs', arguments: '{}' }]); assert.equal(json.finishReason, 'tool_calls')
  await assert.rejects(run(jsonResponse(chat(null, { message: { tool_calls: [ccall('call-1', 'fixture_echo', '{"value":"ok"}'), ccall('call-2', 'fixture_echo', '{"value":1}')] }, finish_reason: 'tool_calls' })), { tools }), { code: 'model-response' })
  assert.throws(() => buildProviderPayload({ model: MODEL, messages: MESSAGES, tools, parallelToolCalls: 'yes' }), { code: 'model-response' })
})

test('Responses tools and encrypted reasoning replay survive full terminal output without duplication', async () => {
  const reasoning = { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'opaque-ciphertext', summary: [{ type: 'summary_text', text: '摘要' }] }
  const call = rcall()
  const events = [
    { type: 'response.reasoning_summary_text.delta', delta: '摘要' },
    { type: 'response.output_item.done', output_index: 70, item: reasoning },
    { type: 'response.output_item.added', output_index: 90, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: call.id, delta: '{"value":' },
    { type: 'response.function_call_arguments.delta', item_id: call.id, delta: '"ok"}' },
    { type: 'response.function_call_arguments.done', item_id: call.id, arguments: call.arguments },
    { type: 'response.output_item.done', output_index: 90, item: call },
    { type: 'response.completed', response: { status: 'completed', output: [reasoning, call], usage: { input_tokens: 4, output_tokens: 6 } } },
  ]
  const result = await run(sse(events), { model: { ...MODEL, apiFormat: 'responses' }, tools: TOOLS })
  assert.equal(result.reasoningContent, '摘要'); assert.equal(result.toolCalls.length, 1); assert.equal(result.usage.totalTokens, 10)
  assert.deepEqual(result.providerReplay, { apiFormat: 'responses', output: [reasoning, call] })
  const messages = [...MESSAGES, { role: 'assistant', content: '', tool_calls: [ccall()], provider_replay: result.providerReplay }, { role: 'tool', tool_call_id: 'call-1', content: 'ok' }]
  const input = buildProviderPayload({ model: { ...MODEL, apiFormat: 'responses' }, messages }).payload.input
  assert.equal(input.filter((item) => item.type === 'function_call').length, 1); assert.deepEqual(input[1], reasoning)
  const old = buildProviderPayload({ model: { ...MODEL, apiFormat: 'responses' }, messages: [{ role: 'assistant', content: '', responses_output: [reasoning, call] }] }).payload.input
  assert.deepEqual(old, [reasoning, call])
})

test('Anthropic JSON and SSE preserve thinking signatures and merge adjacent tool results for replay', async () => {
  const events = [
    { event: 'message_start', data: { message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 0 } } } },
    { type: 'content_block_start', index: 10, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 10, delta: { type: 'thinking_delta', thinking: '思考过程' } },
    { type: 'content_block_delta', index: 10, delta: { type: 'signature_delta', signature: 'signed-' } },
    { type: 'content_block_delta', index: 10, delta: { type: 'signature_delta', signature: 'block' } },
    { type: 'content_block_stop', index: 10 },
    { type: 'content_block_start', index: 30, content_block: { type: 'tool_use', id: 'call-1', name: 'fixture_echo', input: {} } },
    { type: 'content_block_delta', index: 30, delta: { type: 'input_json_delta', partial_json: '{"value":' } },
    { type: 'content_block_delta', index: 30, delta: { type: 'input_json_delta', partial_json: '"ok"}' } },
    { type: 'content_block_stop', index: 30 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ]
  const model = { ...MODEL, apiFormat: 'anthropic-messages' }
  const result = await run(sse(events, { separator: '\r', oneByte: true }), { model, tools: TOOLS })
  assert.equal(result.reasoningContent, '思考过程'); assert.equal(result.usage.totalTokens, 13); assert.equal(result.finishReason, 'tool_calls')
  assert.equal(result.providerReplay.content[0].signature, 'signed-block'); assert.deepEqual(result.providerReplay.content[1].input, { value: 'ok' })
  const messages = [{ role: 'system', content: 'system' }, ...MESSAGES, { role: 'assistant', content: '', tool_calls: [ccall()], provider_replay: result.providerReplay }, { role: 'tool', tool_call_id: 'call-1', content: 'result' }, { role: 'user', content: 'continue' }]
  const payload = buildProviderPayload({ model, messages, tools: TOOLS }).payload
  assert.deepEqual(payload.system, [{ type: 'text', text: 'system' }]); assert.deepEqual(payload.messages[1].content, result.providerReplay.content)
  assert.equal(payload.messages[2].role, 'user'); assert.equal(payload.messages[2].content[0].type, 'tool_result'); assert.equal(payload.messages[2].content[1].text, 'continue')
  assert.equal(payload.messages[1].provider_replay, undefined); assert.equal(payload.tools[0].input_schema.type, 'object')
  const json = await run(jsonResponse(anthropic([{ type: 'thinking', thinking: 'plan', signature: 'sig' }, { type: 'text', text: 'OK' }])), { model })
  assert.equal(json.reasoningContent, 'plan'); assert.equal(json.providerReplay.content[0].signature, 'sig')
})

test('Anthropic rejects missing signatures, unfinished blocks, max_tokens and premature message_stop', async () => {
  const model = { ...MODEL, apiFormat: 'anthropic-messages' }
  await assert.rejects(run(jsonResponse(anthropic([{ type: 'thinking', thinking: 'partial' }, { type: 'text', text: 'OK' }])), { model }), { code: 'model-response' })
  const start = { type: 'message_start', message: { type: 'message', content: [] } }
  const block = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } }
  for (const events of [[start, block], [start, block, { type: 'message_stop' }], [start, block, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }], [start, block, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }]]) await assert.rejects(run(sse(events), { model }), { code: 'model-response' })
})

test('cancellation, first-byte, idle and total deadlines abort without retrying uncooperative mocks', async () => {
  let count = 0
  await assert.rejects(run(null, { timeoutMs: 100, firstByteTimeoutMs: 10, fetchImpl: () => { count++; return new Promise(() => {}) } }), (error) => error.code === 'model-timeout' && error.details.diagnostics.phase === 'first-byte')
  assert.equal(count, 1)
  const idle = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')) } }), { headers: { 'content-type': 'text/event-stream' } })
  await assert.rejects(run(idle, { timeoutMs: 100, firstByteTimeoutMs: 50, idleTimeoutMs: 10 }), (error) => error.code === 'model-timeout' && error.details.diagnostics.phase === 'idle')
  await assert.rejects(run(null, { timeoutMs: 10, firstByteTimeoutMs: 100, fetchImpl: () => new Promise(() => {}) }), (error) => error.code === 'model-timeout' && error.details.diagnostics.phase === 'total')
  const controller = new AbortController()
  const promise = run(null, { signal: controller.signal, fetchImpl: () => new Promise(() => {}) })
  controller.abort(new Error(KEY))
  await assert.rejects(promise, (error) => error.code === 'model-cancelled' && !JSON.stringify(error).includes(KEY))
  let contacted = false
  await assert.rejects(run(null, { signal: controller.signal, fetchImpl: () => { contacted = true } }), { code: 'model-cancelled' })
  assert.equal(contacted, false)
})

test('HTTP, stream and parser errors include safe classification without credential bodies or URLs', async () => {
  const model = { ...MODEL, headers: { 'x-tenant': 'header-secret' }, query: { token: 'query-secret' } }
  for (const status of [401, 403, 404, 429, 500]) {
    let cancelled = false
    const body = new ReadableStream({ cancel() { cancelled = true } })
    await assert.rejects(run(new Response(body, { status }), { model }), (error) => {
      assert.equal(error.details.diagnostics.upstreamStatus, status)
      assert.equal(error.details.diagnostics.retryable, false)
      assert.ok(!JSON.stringify(error).includes(KEY)); assert.ok(!JSON.stringify(error).includes('query-secret'))
      return true
    })
    assert.equal(cancelled, true)
  }
  await assert.rejects(run(null, { model, fetchImpl: () => { throw new Error(`${KEY} header-secret query-secret`) } }), (error) => error.code === 'model-network' && !JSON.stringify(error).includes('secret'))
})

test('diagnostics mark only actual text/stream/tool checks and redact all provider secret values', async () => {
  const secretModel = { ...MODEL, headers: { 'x-tenant': 'header-secret' }, query: { token: 'query-secret' } }
  const result = await testProviderModel({ ...secretModel, check: 'text' }, { fetchImpl: async () => jsonResponse(chat(`OK ${KEY} header-secret query-secret`)) })
  assert.equal(result.ok, true); assert.equal(result.checks[0].status, 'passed'); assert.equal(result.checks[1].status, 'untested'); assert.equal(result.checks[2].status, 'untested'); assert.ok(Number.isFinite(Date.parse(result.checkedAt)))
  assert.ok(!JSON.stringify(result).includes('secret'))
  await assert.rejects(testProviderModel({ ...MODEL, check: 'stream' }, { fetchImpl: async () => jsonResponse(chat()) }), (error) => error.code === 'model-test-stream' && error.details.checks[1].status === 'unsupported')
  const streamed = await testProviderModel({ ...MODEL, check: 'stream' }, { fetchImpl: async () => sse([{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }, '[DONE]']) })
  assert.equal(streamed.checks[0].status, 'passed'); assert.equal(streamed.checks[1].status, 'passed'); assert.equal(streamed.checks[2].status, 'untested')
  const requests = []
  const toolResult = await testProviderModel({ ...MODEL, check: 'tools' }, { fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); requests.push(body)
    if (requests.length === 1) {
      const call = ccall('fixed-call', 'provider_connection_echo', '{"value":"connection-check"}')
      return sse([{ choices: [{ delta: { tool_calls: [{ ...call, index: 0 }] }, finish_reason: 'tool_calls' }] }, '[DONE]'])
    }
    return sse([{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }, '[DONE]'])
  } })
  assert.equal(requests.length, 2); assert.equal(requests[0].tools[0].function.name, 'provider_connection_echo')
  assert.equal(requests[1].messages.at(-1).role, 'tool'); assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), { value: 'connection-check', ok: true })
  assert.ok(toolResult.checks.every((entry) => entry.status === 'passed'))
  await assert.rejects(testProviderModel({ ...MODEL, check: 'file' }, { fetchImpl: () => assert.fail('no fetch') }), { code: 'model-check' })
})

test('explicit standard profile is protocol-aware and normalized configs are idempotent', async () => {
  for (const apiFormat of ['chat-completions', 'responses', 'anthropic-messages']) {
    const model = normalizeProvider({ ...MODEL, profile: 'standard', apiFormat })
    assert.deepEqual(normalizeProvider(model), model)
    assert.equal(model.compat.store, apiFormat === 'responses')
    assert.equal(model.authType, apiFormat === 'anthropic-messages' ? 'x-api-key' : 'bearer')
  }
  const saved = normalizeProvider({ ...MODEL, id: 'saved', engine: 'native', headers: { 'x-route': 'private' }, query: { deployment: 'route' }, compat: { strictTools: true }, maxOutputTokens: 5000, reasoningEfforts: ['low', 'high'], reasoningEffort: 'low' })
  assert.deepEqual(normalizeProvider({}, { existing: saved }), saved)
  const discovery = providerConfiguration({ id: 'saved', model: '', apiKey: '' }, { models: { get: () => saved }, requireModel: false })
  assert.equal(discovery.model, null); assert.equal(discovery.engine, 'native'); assert.deepEqual(discovery.headers, saved.headers)
  const found = await fetchProviderModels({ ...discovery, id: undefined }, { fetchImpl: async () => jsonResponse({ data: [{ id: 'model' }] }) })
  assert.equal(found.count, 1)
  assert.throws(() => normalizeProvider({ ...MODEL, authType: 'none', headers: { 'x-key': 'a' }, query: { q: {} } }))
})

test('Responses terminal output cannot omit or rewrite streamed calls and completion callbacks wait for all validation', async () => {
  const call = rcall()
  for (const final of [{ status: 'completed', output_text: 'OK' }, { status: 'completed', output: [] }, { status: 'completed', output: [{ ...call, arguments: '{"value":"different"}' }] }, { status: 'completed', output: [{ type: 'message', id: call.id, content: [{ type: 'output_text', text: 'OK' }] }] }, { status: 'completed', output: [call, call] }]) {
    await assert.rejects(run(sse([{ type: 'response.output_item.added', output_index: 1, item: call }, { type: 'response.completed', response: final }]), { model: { ...MODEL, apiFormat: 'responses' }, tools: TOOLS }), { code: 'model-response' })
  }
  const deltas = []
  await assert.rejects(run(jsonResponse(chat(null, { message: { tool_calls: [ccall('good'), ccall('bad', 'fixture_echo', '{}')] }, finish_reason: 'tool_calls' })), { tools: TOOLS, parallelToolCalls: true, onToolCallDelta: (delta) => deltas.push(delta) }), { code: 'model-response' })
  assert.equal(deltas.some((delta) => delta.done), false)
  await assert.rejects(run(jsonResponse(chat('OK', { message: { content: 'OK', function_call: { name: 'fixture_echo', arguments: '{}' } } }))), { code: 'model-unsupported' })
})

test('output, SSE event, tool-argument and schema bounds fail before any completed tool is returned', async () => {
  await assert.rejects(run(jsonResponse(chat('a'.repeat(262145)))), { code: 'model-output-limit' })
  await assert.rejects(run(new Response(`data: ${'x'.repeat(1048577)}`, { headers: { 'content-type': 'text/event-stream' } })), { code: 'model-output-limit' })
  await assert.rejects(run(jsonResponse(chat('x'.repeat(2 * 1024 * 1024)))), { code: 'model-output-limit' })
  await assert.rejects(run(jsonResponse(chat(null, { message: { tool_calls: [ccall('call-1', 'fixture_echo', `{"value":"${'x'.repeat(524288)}"}`)] }, finish_reason: 'tool_calls' })), { tools: TOOLS }), { code: 'model-tools-limit' })
  const schemaTools = [{ type: 'function', function: { name: 'bounded', parameters: { type: 'object', required: ['count', 'names'], properties: { count: { type: 'integer', minimum: 1, maximum: 3 }, names: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 3 } } }, additionalProperties: false } } }]
  for (const args of [{ count: 0, names: ['a'] }, { count: 2.2, names: ['a'] }, { count: 2, names: ['a', 'a'] }, { count: 2, names: ['long'] }, { count: 2, names: [] }]) await assert.rejects(run(jsonResponse(chat(null, { message: { tool_calls: [ccall('call-1', 'bounded', JSON.stringify(args))] }, finish_reason: 'tool_calls' })), { tools: schemaTools }), { code: 'model-response' })
})

test('Responses and Anthropic tool diagnostics use production replay and fixed result echo', async () => {
  for (const apiFormat of ['responses', 'anthropic-messages']) {
    const requests = []
    const result = await testProviderModel({ ...MODEL, apiFormat, check: 'tools' }, { fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body)
      if (requests.length === 1) {
        if (apiFormat === 'responses') return jsonResponse({ status: 'completed', output: [{ type: 'reasoning', id: 'r', encrypted_content: 'private-cipher', summary: [] }, rcall('fixed-call', 'provider_connection_echo', '{"value":"connection-check"}')] })
        return jsonResponse(anthropic([{ type: 'thinking', thinking: 'test', signature: 'private-signature' }, { type: 'tool_use', id: 'fixed-call', name: 'provider_connection_echo', input: { value: 'connection-check' } }], { stop_reason: 'tool_use' }))
      }
      if (apiFormat === 'responses') return jsonResponse(response('OK'))
      return jsonResponse(anthropic())
    } })
    assert.equal(result.checks[2].status, 'passed'); assert.equal(result.checks[1].status, 'untested')
    assert.equal(requests.length, 2)
    if (apiFormat === 'responses') {
      assert.equal(requests[1].input.filter((item) => item.type === 'function_call').length, 1)
      assert.equal(requests[1].input.find((item) => item.type === 'reasoning').encrypted_content, 'private-cipher')
      assert.equal(requests[1].input.at(-1).type, 'function_call_output')
    } else {
      assert.equal(requests[1].messages[1].content[0].signature, 'private-signature')
      assert.equal(requests[1].messages.at(-1).content[0].type, 'tool_result')
    }
  }
})

test('discovery supports no-key auth and custom routing while suppressing secret echoed IDs', async () => {
  let captured
  const model = { ...MODEL, apiKey: '', authType: 'none', apiFormat: 'anthropic-messages', baseUrl: 'http://127.0.0.1:3000/v2/messages', headers: { 'x-tenant': 'secret-tenant' }, query: { version: 'secret-version' } }
  const result = await fetchProviderModels(model, { fetchImpl: async (url, init) => { captured = { url, init }; return jsonResponse({ data: [{ id: 'valid', name: 'secret-tenant secret-version' }, { id: 'secret-tenant' }, { id: 'secret-version' }] }) } })
  assert.equal(result.count, 1); assert.equal(result.models[0].id, 'valid'); assert.ok(!JSON.stringify(result).includes('secret-'))
  assert.equal(captured.url, 'http://127.0.0.1:3000/v2/models?version=secret-version'); assert.equal(captured.init.headers.authorization, undefined); assert.equal(captured.init.headers['x-api-key'], undefined)
})

test('images are encoded per protocol from one neutral block and malformed parts fail early', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]).toString('base64')
  const messages = [{ role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image', mime: 'image/png', data: png }] }]
  const chatPayload = buildProviderPayload({ model: MODEL, messages, stream: false }).payload
  assert.deepEqual(chatPayload.messages, [{ role: 'user', content: [
    { type: 'text', text: '看这张图' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
  ] }])
  const anthropicPayload = buildProviderPayload({ model: { ...MODEL, apiFormat: 'anthropic-messages' }, messages, stream: false }).payload
  assert.deepEqual(anthropicPayload.messages, [{ role: 'user', content: [
    { type: 'text', text: '看这张图' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
  ] }])
  const responsesPayload = buildProviderPayload({ model: { ...MODEL, apiFormat: 'responses' }, messages, stream: false }).payload
  assert.deepEqual(responsesPayload.input, [{ role: 'user', content: [
    { type: 'input_text', text: '看这张图' },
    { type: 'input_image', image_url: `data:image/png;base64,${png}` },
  ] }])
  // Text-only history still uses plain strings, so providers that never see images are untouched.
  assert.deepEqual(buildProviderPayload({ model: MODEL, messages: MESSAGES, stream: false }).payload.messages, [{ role: 'user', content: 'Hello' }])
  for (const content of [
    [{ type: 'image', mime: 'image/bmp', data: png }],
    [{ type: 'image', mime: 'image/png', data: '' }],
    [{ type: 'image', mime: 'image/png' }],
    [{ type: 'audio', data: png }],
  ]) {
    // Rejected either when the message is validated or when the protocol block is built.
    await assert.rejects(run(jsonResponse(chat()), { messages: [{ role: 'user', content }] }), (error) => ['model-messages', 'model-response'].includes(error.code))
  }
})

test('inline images are measured apart from the text context budget', async () => {
  const { validateMessages } = await import('../plugins/dsh-codex-sidebar/lib/custom-chat.mjs')
  const picture = 'A'.repeat(2 * 1024 * 1024)
  // 2 MiB of base64 would blow the 1 MiB text cap if it were counted as text.
  validateMessages([{ role: 'user', content: [{ type: 'text', text: '说明' }, { type: 'image', mime: 'image/png', data: picture }] }])
  assert.throws(() => validateMessages([{ role: 'user', content: 'x'.repeat(1100 * 1024) }]), { code: 'context-limit' })
  assert.throws(() => validateMessages([{ role: 'user', content: [{ type: 'image', mime: 'image/png', data: 'A'.repeat(8 * 1024 * 1024 + 4) }] }]), { code: 'context-limit' })
})
