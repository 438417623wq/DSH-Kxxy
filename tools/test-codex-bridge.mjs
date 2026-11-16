import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { connect as connectSocket } from 'node:net'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ResponsesBridge } from '../plugins/dsh-codex-sidebar/lib/responses-bridge.mjs'
import { APPLY_PATCH_GRAMMAR_SHA256, compileTools, decodeRequest, flatToolName, unwrapCustomArguments } from '../plugins/dsh-codex-sidebar/lib/responses-bridge-codec.mjs'
import { normalizeProvider, providerUrl } from '../plugins/dsh-codex-sidebar/lib/provider-config.mjs'

// All provider requests below are to a new loopback HTTP server or injected code.
// No CLI command, real model, workspace file, or downloaded script is executed.
const SECRET = 'private-provider-key-for-loopback-only'
const SIGNATURE = 'private-anthropic-signature-DO-NOT-EXPOSE'
const REDACTED = 'private-anthropic-redacted-data-DO-NOT-EXPOSE'
const MODEL = 'mock-bridge-model'
const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '检查，但由 CLI 执行工具。' }] }]
const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }
const tools = [
  { type: 'function', name: 'inspect', description: 'Inspect a path', parameters, strict: false },
  { type: 'custom', name: 'shell', description: 'Run original shell text via the CLI', format: { type: 'text' } },
  { type: 'namespace', name: 'workspace', description: 'Workspace operations', tools: [
    { type: 'function', name: 'inspect', description: 'Inspect in namespace', parameters, strict: false },
    { type: 'custom', name: 'shell', description: 'Original namespaced shell text', format: { type: 'text' } },
  ] },
]
const RAW_SHELL = 'printf "%s\\n" "中文"\ncat <<\'END\'\n{ unparsed: text }\nEND\n'
const PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`
const patchTool = { type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar', syntax: 'lark', definition: PATCH_GRAMMAR } }

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
async function until(check, label = 'condition', timeout = 4000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await delay(5) }
  assert.fail(`Timed out waiting for ${label}`)
}
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); return `http://127.0.0.1:${server.address().port}` }
async function close(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
async function mockUpstream() {
  const calls = [], handlers = [], errors = []
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const call = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      calls.push(call)
      const handler = handlers.shift()
      if (handler) await handler(req, res, call)
      else jsonRound(res, call, { text: '完成。' })
    } catch (error) {
      errors.push(error)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      if (!res.destroyed) res.end(JSON.stringify({ error: { message: 'Mock failure' } }))
    }
  })
  const origin = await listen(server)
  return { server, origin, calls, handlers, errors, close: () => close(server) }
}
function provider(origin = 'http://127.0.0.1:1', format = 'chat-completions', overrides = {}) {
  return normalizeProvider({ model: MODEL, name: 'Loopback test', engine: 'native', apiFormat: format, baseUrl: `${origin}/v1`, apiKey: SECRET, authType: format === 'anthropic-messages' ? 'x-api-key' : 'bearer', ...(format === 'anthropic-messages' ? { maxOutputTokens: 4096 } : {}), ...overrides })
}
async function fixture(fn, options = {}) {
  const upstream = await mockUpstream()
  const bridge = new ResponsesBridge({ timeoutMs: 5000, ...options.bridge })
  await bridge.start()
  const model = provider(upstream.origin, options.format ?? 'chat-completions', options.provider)
  const binding = bridge.bind(model, { bindingId: 'main', scope: 'public-test-scope' })
  try { await fn({ upstream, bridge, binding, model }) } finally { await bridge.dispose(); await upstream.close() }
  assert.deepEqual(upstream.errors, [])
}
function body(extra = {}) { return { model: MODEL, input: structuredClone(input), store: false, ...extra } }
async function post(binding, payload = body(), options = {}) {
  return fetch(`${binding.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${binding.apiKey}`, 'content-type': 'application/json', ...options.headers }, body: JSON.stringify(payload), ...options })
}
function sse(value) { return `data: ${JSON.stringify(value)}\n\n` }
function parseEvents(raw) {
  return raw.replace(/\r\n/g, '\n').split('\n\n').map((block) => block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')).filter(Boolean).map((data) => JSON.parse(data))
}
async function consume(response) {
  const raw = await response.text()
  const streaming = (response.headers.get('content-type') ?? '').includes('text/event-stream')
  const events = streaming ? parseEvents(raw) : []
  const result = streaming ? events.find((event) => ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type))?.response : JSON.parse(raw)
  return { raw, events, result }
}
function flatName(tool) { return tool.function?.name ?? tool.name }
function upstreamCalls(call) {
  return call.body.tools.map((tool, index) => ({ id: `call_${index}`, name: flatName(tool), arguments: JSON.stringify(index % 2 ? { input: RAW_SHELL } : { path: `dir/${index}/中文` }) }))
}
function jsonRound(res, call, { text = '', calls = [], reason = calls.length ? 'tool_calls' : 'stop', thinking = false } = {}) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  if (call.url.startsWith('/v1/messages')) {
    const content = [
      ...(thinking ? [{ type: 'thinking', thinking: 'Private reasoning text', signature: SIGNATURE }, { type: 'redacted_thinking', data: REDACTED }] : []),
      ...(text ? [{ type: 'text', text }] : []),
      ...calls.map((entry) => ({ type: 'tool_use', id: entry.id, name: entry.name, input: JSON.parse(entry.arguments) })),
    ]
    res.end(JSON.stringify({ id: 'anthropic-mock', type: 'message', role: 'assistant', model: MODEL, content, stop_reason: reason === 'tool_calls' ? 'tool_use' : reason === 'stop' ? 'end_turn' : reason, usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 2 } }))
  } else res.end(JSON.stringify({ id: 'chat-mock', choices: [{ index: 0, message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls.map((entry) => ({ id: entry.id, type: 'function', function: { name: entry.name, arguments: entry.arguments } })) } : {}) }, finish_reason: reason }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } } }))
}
async function streamRound(res, call, { text = '', calls = [], thinking = false, beforeTerminal } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
  if (call.url.startsWith('/v1/messages')) {
    res.write(sse({ type: 'message_start', message: { id: 'anthropic-stream', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } }))
    let index = 0
    if (thinking) {
      res.write(sse({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }))
      res.write(sse({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'Private reasoning text' } }))
      res.write(sse({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: SIGNATURE } }))
      res.write(sse({ type: 'content_block_stop', index: index++ }))
      res.write(sse({ type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data: REDACTED } }))
      res.write(sse({ type: 'content_block_stop', index: index++ }))
    }
    if (text) {
      res.write(sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
      res.write(sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }))
      res.write(sse({ type: 'content_block_stop', index: index++ }))
    }
    for (const entry of calls) {
      res.write(sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: entry.id, name: entry.name, input: {} } }))
      const split = Math.floor(entry.arguments.length / 2)
      for (const partial_json of [entry.arguments.slice(0, split), entry.arguments.slice(split)]) res.write(sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } }))
      res.write(sse({ type: 'content_block_stop', index: index++ }))
    }
    await beforeTerminal?.()
    if (res.destroyed) return
    res.write(sse({ type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 7 } }))
    res.end(sse({ type: 'message_stop' }))
  } else {
    if (text) res.write(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }))
    for (const [index, entry] of calls.entries()) {
      const split = Math.floor(entry.arguments.length / 2)
      res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: entry.id, type: 'function', function: { name: entry.name, arguments: entry.arguments.slice(0, split) } }] }, finish_reason: null }] }))
      res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: entry.arguments.slice(split) } }] }, finish_reason: null }] }))
    }
    await beforeTerminal?.()
    if (res.destroyed) return
    res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }))
    res.end('data: [DONE]\n\n')
  }
}
function requestRaw(binding, { method = 'POST', headers = {}, payload = body(), path = '/responses', chunked = false } = {}) {
  const url = new URL(binding.baseUrl)
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: url.port, path: `${url.pathname}${path}`, method, agent: false, headers: { authorization: `Bearer ${binding.apiKey}`, 'content-type': 'application/json', ...(chunked ? {} : { 'content-length': Buffer.byteLength(raw) }), ...headers } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (value) => { text += value }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: text }))
    })
    req.on('error', reject)
    if (chunked) { req.write(raw.slice(0, 20)); req.write(raw.slice(20)); req.end() } else req.end(raw)
  })
}
function assertPrivate(raw, binding) { for (const secret of [SECRET, SIGNATURE, REDACTED, binding.apiKey, new URL(binding.baseUrl).pathname]) assert.equal(raw.includes(secret), false, `Private value leaked: ${secret.slice(0, 8)}`) }

for (const format of ['chat-completions', 'anthropic-messages']) for (const stream of [false, true]) test(`${format}: function/custom/namespace full roundtrip, tools remain CLI-owned (${stream ? 'SSE' : 'JSON'})`, async () => {
  await fixture(async ({ upstream, binding }) => {
    upstream.handlers.push(async (_req, res, call) => {
      assert.equal(call.body.stream, stream)
      assert.equal(call.method, 'POST')
      assert.equal(call.body.model, MODEL)
      assert.equal(call.headers[format === 'anthropic-messages' ? 'x-api-key' : 'authorization'], format === 'anthropic-messages' ? SECRET : `Bearer ${SECRET}`)
      assert.equal(call.body.tools.length, 4)
      assert.equal(new Set(call.body.tools.map(flatName)).size, 4)
      if (format === 'anthropic-messages') {
        assert.equal(call.headers['anthropic-version'], '2023-06-01')
        assert.equal(call.body.tool_choice.type, 'any')
        assert.equal(call.body.tool_choice.disable_parallel_tool_use, false)
        assert.deepEqual(call.body.system, [{ type: 'text', text: 'Preserve instructions.' }])
      } else {
        assert.equal(call.body.parallel_tool_calls, true)
        assert.equal(call.body.tool_choice, 'required')
        assert.deepEqual(call.body.messages[0], { role: 'system', content: 'Preserve instructions.' })
      }
      const output = { text: '工具将由 CLI 审批执行。', calls: upstreamCalls(call), thinking: format === 'anthropic-messages' }
      if (stream) await streamRound(res, call, output)
      else jsonRound(res, call, output)
    })
    const response = await post(binding, body({ stream, tools, tool_choice: 'required', parallel_tool_calls: true, instructions: 'Preserve instructions.' }))
    assert.equal(response.status, 200)
    const first = await consume(response)
    assert.equal(first.result.status, 'completed', first.raw)
    assertPrivate(first.raw, binding)
    const callItems = first.result.output.filter((item) => ['function_call', 'custom_tool_call'].includes(item.type))
    assert.equal(callItems.length, 4)
    assert.deepEqual(callItems.map((item) => [item.type, item.name, item.namespace ?? null]), [['function_call', 'inspect', null], ['custom_tool_call', 'shell', null], ['function_call', 'inspect', 'workspace'], ['custom_tool_call', 'shell', 'workspace']])
    assert.equal(callItems[1].input, RAW_SHELL)
    assert.equal(callItems[3].input, RAW_SHELL)
    assert.deepEqual(JSON.parse(callItems[0].arguments), { path: 'dir/0/中文' })
    assert.equal(first.result.usage.input_tokens, 12)
    assert.equal(first.result.usage.output_tokens, 7)
    if (stream) {
      assert.equal(first.events[0].type, 'response.created')
      assert.equal(first.events[1].type, 'response.in_progress')
      assert.equal(first.events.at(-1).type, 'response.completed')
      assert.deepEqual(first.events.map((event) => event.sequence_number), first.events.map((_event, index) => index))
      for (const item of callItems) assert.deepEqual(first.events.find((event) => event.type === 'response.output_item.done' && event.item.id === item.id)?.item, item)
      assert.ok(first.events.some((event) => event.type === 'response.custom_tool_call_input.done' && event.input === RAW_SHELL))
      assert.ok(first.events.some((event) => event.type === 'response.function_call_arguments.done'))
    }
    upstream.handlers.push((_req, res, call) => {
      if (format === 'chat-completions') {
        assert.deepEqual(call.body.messages.map((message) => message.role), ['user', 'assistant', 'tool', 'tool', 'tool', 'tool', 'user'])
        const assistant = call.body.messages[1]
        assert.equal(assistant.tool_calls[1].function.arguments, JSON.stringify({ input: RAW_SHELL }))
        assert.equal(assistant.provider_replay, undefined)
        assert.deepEqual(call.body.messages.slice(2, 6).map((message) => message.tool_call_id), ['call_0', 'call_1', 'call_2', 'call_3'])
      } else {
        const assistant = call.body.messages.find((message) => message.role === 'assistant')
        assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'Private reasoning text', signature: SIGNATURE })
        assert.deepEqual(assistant.content[1], { type: 'redacted_thinking', data: REDACTED })
        assert.equal(assistant.content.filter((block) => block.type === 'tool_use')[1].input.input, RAW_SHELL)
        const user = call.body.messages.at(-1)
        assert.deepEqual(user.content.slice(0, 4).map((part) => part.tool_use_id), ['call_0', 'call_1', 'call_2', 'call_3'])
        assert.equal(user.content.at(-1).text, '继续')
      }
      jsonRound(res, call, { text: '全部完成。' })
    })
    const nextInput = [...input, ...first.result.output, ...callItems.map((item, index) => ({ type: `${item.type}_output`, call_id: item.call_id, output: index === 0 ? [{ type: 'input_text', text: '工具结果 0' }] : `工具结果 ${index}` })), { role: 'user', content: '继续' }]
    const second = await consume(await post(binding, body({ stream, tools, input: nextInput })))
    assert.equal(second.result.status, 'completed', second.raw)
    assert.equal(second.result.output.find((item) => item.type === 'message').content[0].text, '全部完成。')
    assert.equal(upstream.calls.length, 2)
  }, { format })
})

test('codec maps instructions, text, adjacent calls and outputs without reordering', () => {
  const model = provider()
  const request = decodeRequest(body({ instructions: 'first', tools: [tools[0]], input_items: undefined, input: [
    { role: 'developer', content: 'second' }, { role: 'user', content: 'third' },
    { type: 'function_call', call_id: 'first_call', name: 'inspect', arguments: '{"path":"one"}' },
    { type: 'function_call', call_id: 'second_call', name: 'inspect', arguments: '{"path":"two"}' },
    { type: 'function_call_output', call_id: 'second_call', output: 'second result arrives first' },
    { type: 'function_call_output', call_id: 'first_call', output: 'first result arrives second' },
    { role: 'user', content: 'last' },
  ] }), { provider: model })
  assert.deepEqual(request.messages.map((message) => message.role), ['system', 'developer', 'user', 'assistant', 'tool', 'tool', 'user'])
  assert.equal(request.messages[4].tool_call_id, 'second_call')
  assert.equal(request.messages[5].tool_call_id, 'first_call')
  assert.equal(request.messages[3].tool_calls.length, 2)
  assert.throws(() => decodeRequest(body({ input: [{ type: 'function_call_output', call_id: 'orphan', output: 'no call' }] }), { provider: model }), { code: 'bridge-invalid-request' })
  assert.throws(() => decodeRequest(body({ input: [{ type: 'function_call', call_id: 'orphan', name: 'inspect', arguments: '{}' }, { role: 'user', content: 'missing output' }] }), { provider: model }), { code: 'bridge-invalid-request' })
})

test('namespace flattening is deterministic and cannot collide with user prefixes or separator names', () => {
  const a = compileTools(tools), b = compileTools([...tools].reverse())
  assert.deepEqual([...a.byFlatName.keys()].sort(), [...b.byFlatName.keys()].sort())
  assert.notEqual(flatToolName('a_b', 'c'), flatToolName('a', 'b_c'))
  assert.notEqual(flatToolName(null, 'workspace.inspect'), flatToolName('workspace', 'inspect'))
  const forged = flatToolName('workspace', 'inspect')
  assert.notEqual(flatToolName(null, forged), forged)
  assert.ok([...a.byFlatName.keys()].every((name) => /^[\w-]{1,64}$/.test(name)))
  assert.throws(() => compileTools([tools[0], tools[0]]), { code: 'bridge-invalid-request' })
})

test('custom input wrapper preserves exact free text and rejects duplicate, extra and nonstring fields', () => {
  assert.equal(unwrapCustomArguments(JSON.stringify({ input: RAW_SHELL })), RAW_SHELL)
  for (const raw of ['{}', '{"input":{}}', '{"input":42}', '{"input":"one","input":"two"}', '{"input":"one","extra":0}', '{"\\u0069nput":"one"}', '"already encoded"']) assert.throws(() => unwrapCustomArguments(raw), { code: 'bridge-invalid-request' })
})

test('pinned apply_patch grammar requires explicit compatibility and preserves warning plus raw patch', async () => {
  assert.equal(createHash('sha256').update(PATCH_GRAMMAR.trim()).digest('hex'), APPLY_PATCH_GRAMMAR_SHA256)
  assert.throws(() => compileTools([patchTool]), { code: 'bridge-unsupported' })
  assert.throws(() => compileTools([{ ...patchTool, format: { ...patchTool.format, definition: `${PATCH_GRAMMAR}\nstart: altered` } }], { customGrammarMode: 'wrap-known' }), { code: 'bridge-unsupported' })
  assert.throws(() => compileTools([{ ...patchTool, name: 'unknown' }], { customGrammarMode: 'wrap-known' }), { code: 'bridge-unsupported' })
  assert.throws(() => compileTools([{ ...patchTool, format: { type: 'grammar', syntax: 'regex', definition: '.*' } }], { customGrammarMode: 'wrap-known' }), { code: 'bridge-unsupported' })
  await fixture(async ({ upstream, binding }) => {
    const patch = '*** Begin Patch\n*** Add File: untouched.txt\n+never executed here\n*** End Patch\n'
    upstream.handlers.push((_req, res, call) => {
      assert.match(call.body.tools[0].function.description, /NOT enforced/)
      jsonRound(res, call, { calls: [{ id: 'patch_call', name: flatName(call.body.tools[0]), arguments: JSON.stringify({ input: patch }) }] })
    })
    const response = await post(binding, body({ tools: [patchTool], tool_choice: { type: 'custom', name: 'apply_patch' } }))
    assert.match(response.headers.get('x-dsh-bridge-warnings'), /grammar-advisory-only/)
    const result = await response.json()
    assert.equal(result.status, 'completed')
    assert.equal(result.output[0].input, patch)
    assert.equal(result.output[0].type, 'custom_tool_call')
  }, { bridge: { customGrammarMode: 'wrap-known' } })
})

test('all unsupported request/tool/content controls fail explicitly before provider fetch', async () => {
  await fixture(async ({ upstream, binding }) => {
    const cases = [
      { input: [{ type: 'input_image', image_url: 'http://example.invalid/image' }] },
      { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'http://example.invalid/image' }] }] },
      { input: [{ type: 'compaction', encrypted_content: 'opaque' }] },
      { input: [{ type: 'compaction_trigger' }] },
      { input: [{ type: 'context_compaction' }] },
      { input: [{ type: 'configuration_update', reasoning: {} }] },
      { input: [{ type: 'reasoning', summary: [], encrypted_content: 'opaque' }] },
      { input: [{ role: 'assistant', content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'url_citation' }] }] }] },
      { tools: [{ type: 'web_search' }] }, { tools: [{ type: 'tool_search', execution: 'client' }] },
      { tools: [{ type: 'unknown' }] }, { tools: [{ ...tools[0], defer_loading: true }] },
      { tools: [{ type: 'namespace', name: 'nested', tools: [tools[2]] }] },
      { tools: [patchTool] },
      { tool_choice: 'magic' }, { tool_choice: { type: 'allowed_tools', tools: [] } },
      { previous_response_id: 'prior-response' }, { compact: true }, { context_management: [{ type: 'compaction' }] },
      { text: { format: { type: 'json_schema', name: 'result', schema: {} } } },
      { temperature: 0.1 }, { top_p: 0.1 }, { truncation: 'auto' }, { store: true },
      { include: ['web_search_call.action.sources'] }, { background: true }, { service_tier: 'priority' },
      { reasoning: { effort: 123 } }, { reasoning: { context: 'encrypted' } },
      { text: { unexpected: true } }, { stream_options: { unknown: true } },
    ]
    for (const extra of cases) {
      const response = await post(binding, body(extra))
      assert.ok([400, 409].includes(response.status), JSON.stringify(extra))
      const result = await response.json()
      assert.ok(['bridge-unsupported', 'bridge-invalid-request', 'bridge-replay-unavailable'].includes(result.error.code), JSON.stringify(result))
    }
    assert.equal(upstream.calls.length, 0)
  })
})

test('known presentation/cache controls have explicit capability warnings, not silent claims', async () => {
  await fixture(async ({ binding }) => {
    const response = await post(binding, body({ include: ['reasoning.encrypted_content'], reasoning: { summary: 'auto' }, text: { verbosity: 'medium' }, prompt_cache_key: 'a-cache-key', client_metadata: { client: 'codex' }, stream_options: { reasoning_summary_delivery: 'sequential_cutoff' } }))
    const result = await response.json()
    assert.equal(result.status, 'completed')
    for (const warning of ['encrypted-reasoning-unavailable', 'reasoning-summary-unavailable', 'text-verbosity-not-forwarded', 'prompt-cache-not-forwarded', 'client-metadata-local-only', 'reasoning-delivery-buffered']) {
      assert.ok(response.headers.get('x-dsh-bridge-warnings').includes(warning))
      assert.ok(result.metadata.dsh_bridge_warnings.includes(warning))
    }
    assert.equal(JSON.stringify(result).includes('encrypted_content'), false)
  })
})

for (const choice of ['auto', 'none', 'required', { type: 'function', namespace: 'workspace', name: 'inspect' }]) test(`tool choice ${JSON.stringify(choice)} is preserved or enforced`, async () => {
  await fixture(async ({ upstream, binding }) => {
    upstream.handlers.push((_req, res, call) => {
      if (typeof choice === 'string') assert.equal(call.body.tool_choice, choice)
      else assert.deepEqual(call.body.tool_choice, { type: 'function', function: { name: flatToolName('workspace', 'inspect') } })
      const calls = choice === 'none' || choice === 'auto' ? [] : [{ id: 'selected_call', name: typeof choice === 'object' ? flatToolName('workspace', 'inspect') : flatName(call.body.tools[0]), arguments: '{"path":"selected"}' }]
      jsonRound(res, call, { text: calls.length ? '' : 'text only', calls })
    })
    const result = await consume(await post(binding, body({ tools, tool_choice: choice })))
    assert.equal(result.result.status, 'completed', result.raw)
    assert.deepEqual(result.result.tool_choice, choice)
  })
})

test('provider model snapshot, endpoint restriction and credential rotation are independent of caller mutation', async () => {
  const seen = []
  await fixture(async ({ bridge, binding, model }) => {
    assert.throws(() => bridge.bind(model, { bindingId: 'main' }), { code: 'bridge-binding-exists' })
    const original = structuredClone(model)
    model.apiKey = 'changed-outside-binding'; model.model = 'different'; model.baseUrl = 'http://evil.invalid'
    assert.equal((await consume(await post(binding))).result.status, 'completed')
    assert.equal(seen[0].model.apiKey, SECRET)
    assert.equal(seen[0].model.model, MODEL)
    assert.equal((await post(binding, body({ model: 'different' }))).status, 409)
    assert.throws(() => bridge.rotateCredentials('main', { ...original, baseUrl: 'http://different.invalid' }), { code: 'bridge-provider-changed' })
    const rotated = { ...original, apiKey: 'rotated-secret-key', name: 'Renamed only' }
    assert.deepEqual(bridge.rotateCredentials('main', rotated), binding)
    assert.equal((await consume(await post(binding))).result.status, 'completed')
    assert.equal(seen[1].model.apiKey, 'rotated-secret-key')
    bridge.revoke('main')
    assert.equal((await post(binding)).status, 404)
  }, { bridge: { roundImpl: async (options) => { seen.push(options); return { text: 'private snapshot OK', reasoningContent: '', toolCalls: [], providerOutput: [] } } } })
})

test('start is required, routes and tokens are independently random, and stale bindings cannot authorize others', async () => {
  const bridge = new ResponsesBridge({ roundImpl: async () => ({ text: 'OK', toolCalls: [] }) })
  const model = provider()
  assert.throws(() => bridge.bind(model), { code: 'bridge-not-started' })
  await Promise.all([bridge.start(), bridge.start()])
  const first = bridge.bind(model, { bindingId: 'one', scope: 'same-scope' }), second = bridge.bind(model, { bindingId: 'two', scope: 'same-scope' })
  try {
    assert.notEqual(first.baseUrl, second.baseUrl)
    assert.notEqual(first.apiKey, second.apiKey)
    assert.equal(new URL(first.baseUrl).hostname, '127.0.0.1')
    assert.ok(first.apiKey.length >= 43)
    const mixed = { baseUrl: first.baseUrl, apiKey: second.apiKey }
    assert.equal((await post(mixed)).status, 401)
    bridge.clear()
    assert.equal((await post(first)).status, 404)
  } finally { await bridge.dispose() }
  await assert.rejects(bridge.start(), { code: 'bridge-disposed' })
})

test('authorization, exact Host, browser Origin, methods, paths and encodings are rejected without CORS', async () => {
  await fixture(async ({ upstream, binding }) => {
    const attempts = [
      { headers: { authorization: '' }, status: 401 }, { headers: { authorization: 'Bearer wrong' }, status: 401 },
      { headers: { host: 'evil.invalid' }, status: 403 }, { headers: { host: 'localhost' }, status: 403 },
      { headers: { origin: 'https://evil.invalid' }, status: 403 }, { headers: { origin: 'null' }, status: 403 },
      { headers: { origin: new URL(binding.baseUrl).origin }, status: 403 },
      { headers: { referer: 'https://evil.invalid' }, status: 403 }, { headers: { 'sec-fetch-site': 'cross-site' }, status: 403 },
      { method: 'GET', status: 405 }, { method: 'OPTIONS', status: 405 },
      { path: '/responses/compact', status: 404 }, { path: '/responses?target=http://evil.invalid', status: 404 },
      { headers: { 'content-type': 'text/plain' }, status: 415 }, { headers: { 'content-encoding': 'gzip' }, status: 415 },
    ]
    for (const { status, ...attempt } of attempts) {
      const response = await requestRaw(binding, attempt)
      assert.equal(response.status, status, JSON.stringify(attempt))
      assert.equal(response.headers['access-control-allow-origin'], undefined)
      assertPrivate(response.raw, binding)
    }
    assert.equal(upstream.calls.length, 0)
  })
})

test('JSON/body limits cover Content-Length and chunked transfer before any provider request', async () => {
  await fixture(async ({ upstream, binding }) => {
    assert.equal((await requestRaw(binding, { payload: body({ input: 'x'.repeat(1024) }) })).status, 413)
    assert.equal((await requestRaw(binding, { payload: body({ input: 'x'.repeat(1024) }), chunked: true })).status, 413)
    assert.equal((await requestRaw(binding, { payload: '{invalid' })).status, 400)
    assert.equal(upstream.calls.length, 0)
  }, { bridge: { limits: { maxBodyBytes: 512 } } })
})

test('global and per-binding concurrency limits, busy rotation and abort release the active slot', async () => {
  let signal
  const started = deferred()
  await fixture(async ({ bridge, binding, model }) => {
    const pending = post(binding, body({ stream: true }))
    await started.promise
    assert.equal((await post(binding)).status, 429)
    const other = bridge.bind(model, { bindingId: 'other' })
    assert.equal((await post(other)).status, 429)
    assert.throws(() => bridge.rotateCredentials('main', { ...model, apiKey: 'rotated' }), { code: 'bridge-busy' })
    bridge.abort('main')
    const failed = await consume(await pending)
    assert.ok(signal.aborted)
    assert.equal(failed.result.status, 'incomplete')
    assert.equal(failed.events.some((event) => event.type === 'response.completed'), false)
    await until(() => { try { bridge.rotateCredentials('main', { ...model, apiKey: 'rotated' }); return true } catch { return false } }, 'active slot release')
  }, { bridge: { limits: { maxConcurrent: 1 }, roundImpl: (options) => { signal = options.controller.signal; started.resolve(); return new Promise(() => {}) } } })
})

test('socket connection cap closes excess unauthenticated connections', async () => {
  await fixture(async ({ binding }) => {
    const port = Number(new URL(binding.baseUrl).port)
    const sockets = []
    try {
      for (let i = 0; i < 2; i++) { const socket = connectSocket({ host: '127.0.0.1', port }); sockets.push(socket); await once(socket, 'connect') }
      const extra = connectSocket({ host: '127.0.0.1', port }); sockets.push(extra)
      await Promise.race([once(extra, 'close'), delay(1500).then(() => assert.fail('excess connection stayed open'))])
    } finally { for (const socket of sockets) socket.destroy() }
  }, { bridge: { limits: { maxConnections: 2 } } })
})

for (const format of ['chat-completions', 'anthropic-messages']) test(`${format}: text delta arrives before upstream terminal, tools do not`, async () => {
  await fixture(async ({ upstream, binding }) => {
    const release = deferred(), waiting = deferred()
    let terminal = false
    upstream.handlers.push((_req, res, call) => streamRound(res, call, { text: 'Live text before upstream termination. '.repeat(5), calls: [{ id: 'held_call', name: flatName(call.body.tools[0]), arguments: '{"path":"safe"}' }], beforeTerminal: async () => { waiting.resolve(); await release.promise; terminal = true } }))
    const response = await post(binding, body({ stream: true, tools: [tools[0]], parallel_tool_calls: false }))
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let raw = ''
    try {
      await waiting.promise
      while (!parseEvents(raw).some((event) => event.type === 'response.output_text.delta')) {
        const next = await reader.read(); assert.equal(next.done, false); raw += decoder.decode(next.value, { stream: true })
      }
      assert.equal(terminal, false)
      assert.equal(parseEvents(raw).some((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call'), false)
      release.resolve()
      for (;;) { const next = await reader.read(); if (next.done) break; raw += decoder.decode(next.value, { stream: true }) }
      const events = parseEvents(raw)
      assert.equal(events.at(-1).type, 'response.completed')
      assert.ok(events.some((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call'))
    } finally { release.resolve(); await reader.cancel().catch(() => {}) }
  }, { format })
})

test('split known provider/header/query/token secrets are redacted across live text chunks', async () => {
  let localToken
  const headerSecret = 'private-header-value-123', querySecret = 'private-query-value-123'
  await fixture(async ({ binding }) => {
    localToken = binding.apiKey
    const response = await post(binding, body({ stream: true }))
    const result = await consume(response)
    assert.equal(result.result.status, 'completed', result.raw)
    assertPrivate(result.raw, binding)
    assert.equal(result.raw.includes(headerSecret), false)
    assert.equal(result.raw.includes(querySecret), false)
    assert.match(result.result.output[0].content[0].text, /\[redacted\]/)
    assert.ok(result.events.filter((event) => event.type === 'response.output_text.delta').length > 1)
  }, { provider: { headers: { 'x-test-context': headerSecret }, query: { tenant: querySecret } }, bridge: { roundImpl: async ({ onDelta }) => {
    const text = `prefix ${'a'.repeat(160)} ${SECRET} ${headerSecret} ${querySecret} ${localToken} suffix ${'z'.repeat(160)}`
    for (const character of text) onDelta(character)
    return { text, reasoningContent: '', toolCalls: [], providerOutput: [] }
  } } })
})

for (const failure of ['length-json', 'broken-sse', 'done-without-finish', 'malformed-tool', 'provider-http', 'network-error']) test(`${failure}: no completed or executable tool done, and no private errors`, async () => {
  await fixture(async ({ upstream, binding }) => {
    upstream.handlers.push((_req, res, call) => {
      const calls = [{ id: 'unsafe_partial', name: flatName(call.body.tools[0]), arguments: '{"path":"not-executed"}' }]
      if (failure === 'length-json') jsonRound(res, call, { text: 'partial', calls, reason: 'length' })
      else if (failure === 'provider-http') { res.writeHead(401); res.end(`authorization Bearer ${SECRET} ${SIGNATURE}`) }
      else if (failure === 'network-error') res.destroy(new Error(`never expose ${SECRET}`))
      else if (failure === 'malformed-tool') jsonRound(res, call, { calls: [{ ...calls[0], arguments: '{"path":' }] })
      else {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(sse({ choices: [{ index: 0, delta: { content: 'Partial visible text without a terminal. '.repeat(4), tool_calls: [{ index: 0, id: calls[0].id, type: 'function', function: { name: calls[0].name, arguments: calls[0].arguments } }] }, finish_reason: null }] }))
        res.end(failure === 'done-without-finish' ? 'data: [DONE]\n\n' : '')
      }
    })
    const result = await consume(await post(binding, body({ stream: true, tools: [tools[0]] })))
    assert.ok(['failed', 'incomplete'].includes(result.result.status), result.raw)
    assert.equal(result.events.some((event) => event.type === 'response.completed'), false)
    assert.equal(result.events.some((event) => event.type === 'response.output_item.done' && ['function_call', 'custom_tool_call'].includes(event.item.type)), false)
    assert.equal(result.events.some((event) => ['response.function_call_arguments.done', 'response.custom_tool_call_input.done'].includes(event.type)), false)
    assertPrivate(result.raw, binding)
  })
})

test('Anthropic truncated/missing-stop output fails without tool completion', async () => {
  for (const stop of ['max_tokens', null]) await fixture(async ({ upstream, binding }) => {
    upstream.handlers.push((_req, res, call) => jsonRound(res, call, { text: 'partial', calls: [{ id: 'partial_tool', name: flatName(call.body.tools[0]), arguments: '{"path":"pending"}' }], reason: stop }))
    const result = await consume(await post(binding, body({ stream: true, tools: [tools[0]] })))
    assert.equal(result.result.status, 'failed')
    assert.equal(result.events.some((event) => event.type === 'response.completed'), false)
    assert.equal(result.events.some((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call'), false)
  }, { format: 'anthropic-messages' })
})

test('upstream redirects are forbidden and no request is automatically retried', async () => {
  await fixture(async ({ upstream, binding }) => {
    upstream.handlers.push((_req, res) => { res.writeHead(307, { location: `${upstream.origin}/second-endpoint` }); res.end() })
    const result = await consume(await post(binding, body({ stream: true })))
    assert.equal(result.result.status, 'failed')
    assert.equal(upstream.calls.length, 1)
    assert.equal(upstream.calls[0].url, '/v1/chat/completions')
  })
})

test('injected round cannot retarget fetch away from the bound provider', async () => {
  let fetches = 0
  await fixture(async ({ binding }) => {
    const result = await consume(await post(binding, body({ stream: true })))
    assert.equal(result.result.status, 'failed')
    assert.equal(result.result.error.code, 'bridge-upstream-route')
    assert.equal(fetches, 0)
  }, { bridge: { fetchImpl: async () => { fetches++; throw new Error('must not fetch') }, roundImpl: ({ fetchImpl }) => fetchImpl('http://arbitrary.invalid/secret', { method: 'POST' }) } })
})

for (const action of ['abort', 'revoke', 'disconnect', 'dispose', 'timeout']) test(`${action}: real upstream fetch is cancelled on raw socket/lifecycle termination`, async () => {
  await fixture(async ({ upstream, bridge, binding }) => {
    const started = deferred(), closed = deferred()
    upstream.handlers.push((_req, res) => {
      res.once('close', () => closed.resolve())
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
      res.write(sse({ choices: [{ index: 0, delta: { content: 'Unfinished upstream data. '.repeat(4) }, finish_reason: null }] }))
      started.resolve()
    })
    const url = new URL(`${binding.baseUrl}/responses`)
    const raw = JSON.stringify(body({ stream: true }))
    const req = httpRequest(url, { method: 'POST', agent: false, headers: { authorization: `Bearer ${binding.apiKey}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } })
    let output = '', ended = false
    req.on('response', (res) => { res.setEncoding('utf8'); res.on('data', (chunk) => { output += chunk }); res.on('end', () => { ended = true }); res.on('error', () => {}) })
    req.on('error', () => {})
    req.end(raw)
    await started.promise
    if (action === 'abort') bridge.abort('main')
    if (action === 'revoke') bridge.revoke('main')
    if (action === 'disconnect') req.destroy()
    if (action === 'dispose') await bridge.dispose()
    await Promise.race([closed.promise, delay(2500).then(() => assert.fail('upstream connection was not cancelled'))])
    if (['abort', 'revoke', 'timeout'].includes(action)) {
      await until(() => ended, 'terminal failure')
      const events = parseEvents(output)
      assert.equal(events.some((event) => event.type === 'response.completed'), false)
      assert.equal(events.at(-1).type, 'response.incomplete')
    }
    req.destroy()
  }, { bridge: { timeoutMs: action === 'timeout' ? 150 : 5000 } })
})

test('Anthropic signed replay is same-binding only; cache loss, tampering and restart are explicit failures', async () => {
  await fixture(async ({ upstream, bridge, binding, model }) => {
    upstream.handlers.push((_req, res, call) => jsonRound(res, call, { text: 'Signed original', thinking: true }))
    const first = await consume(await post(binding))
    assertPrivate(first.raw, binding)
    const history = [...input, ...first.result.output, { role: 'user', content: 'next' }]
    const other = bridge.bind(model, { bindingId: 'same-scope-other', scope: 'public-test-scope' })
    const denied = await consume(await post(other, body({ input: history })))
    assert.equal(denied.result.error.code, 'bridge-replay-unavailable')
    const tampered = structuredClone(history)
    tampered.find((item) => item.type === 'message' && item.role === 'assistant').content[0].text = 'Changed text'
    const changed = await consume(await post(binding, body({ input: tampered })))
    assert.equal(changed.result.error.code, 'bridge-replay-unavailable')
    const reordered = [history[0], history[2], history[1], history[3]]
    const orderFailure = await consume(await post(binding, body({ input: reordered })))
    assert.equal(orderFailure.result.error.code, 'bridge-replay-unavailable')
    const original = structuredClone(model)
    bridge.rotateCredentials('main', { ...original, apiKey: 'new-anthropic-secret', name: 'Renamed' })
    upstream.handlers.push((_req, res, call) => {
      assert.equal(call.headers['x-api-key'], 'new-anthropic-secret')
      assert.equal(call.body.messages[1].content[0].signature, SIGNATURE)
      jsonRound(res, call, { text: 'Restored signed replay' })
    })
    const resumed = await consume(await post(binding, body({ input: history })))
    assert.equal(resumed.result.status, 'completed', resumed.raw)
    bridge.revoke('main')
    const renewed = bridge.bind(original, { bindingId: 'main', scope: 'public-test-scope' })
    const missing = await consume(await post(renewed, body({ input: history })))
    assert.equal(missing.result.error.code, 'bridge-replay-unavailable')
    assert.equal(upstream.calls.length, 2)
  }, { format: 'anthropic-messages' })
})

test('private replay entry and byte limits fail closed rather than fabricating metadata', async () => {
  await fixture(async ({ binding }) => {
    const first = await consume(await post(binding))
    const second = await consume(await post(binding, body({ input: 'a different independent round' })))
    assert.equal(second.result.status, 'completed')
    const evicted = await consume(await post(binding, body({ input: [...input, ...first.result.output, { role: 'user', content: 'old history' }] })))
    assert.equal(evicted.result.error.code, 'bridge-replay-unavailable')
  }, { format: 'anthropic-messages', bridge: { limits: { maxReplayEntries: 1 } } })
  await fixture(async ({ binding }) => {
    const result = await consume(await post(binding, body({ stream: true })))
    assert.equal(result.result.status, 'failed')
    assert.equal(result.result.error.code, 'bridge-replay-limit')
    assert.equal(result.events.some((event) => event.type === 'response.completed'), false)
  }, { bridge: { limits: { maxReplayBytes: 128 } } })
})

test('private values in executable tool fields are rejected, never rewritten into commands', async () => {
  await fixture(async ({ upstream, binding }) => {
    upstream.handlers.push((_req, res, call) => jsonRound(res, call, { calls: [{ id: 'private_call', name: flatName(call.body.tools[0]), arguments: JSON.stringify({ input: `printf ${SECRET}` }) }] }))
    const result = await consume(await post(binding, body({ stream: true, tools: [tools[1]] })))
    assert.equal(result.result.status, 'failed')
    assert.equal(result.events.some((event) => event.type === 'response.custom_tool_call_input.done'), false)
    assertPrivate(result.raw, binding)
    const reflectedChoice = await consume(await post(binding, body({ stream: true, tools: [{ ...tools[0], name: SECRET }], tool_choice: { type: 'function', name: SECRET } })))
    assert.equal(reflectedChoice.result.error.code, 'bridge-private-data')
    assertPrivate(reflectedChoice.raw, binding)
    assert.equal(upstream.calls.length, 1)
  })
})

test('rotated credentials remain redacted in subsequent history and version retention is bounded', async () => {
  const nextKey = 'next-provider-secret'
  await fixture(async ({ bridge, binding, model }) => {
    bridge.rotateCredentials('main', { ...model, apiKey: nextKey })
    const result = await consume(await post(binding, body({ stream: true })))
    assert.equal(result.result.status, 'completed', result.raw)
    assert.equal(result.raw.includes(SECRET), false)
    assert.equal(result.raw.includes(nextKey), false)
    assert.match(result.result.output[0].content[0].text, /\[redacted\]/)
    assert.throws(() => bridge.rotateCredentials('main', { ...model, apiKey: 'third-key' }), { code: 'bridge-credentials-limit' })
  }, { bridge: { limits: { maxCredentialVersions: 2 }, roundImpl: async ({ onDelta }) => {
    const text = `Old ${SECRET}; new ${nextKey}; no disclosure.`
    onDelta(text.slice(0, 10)); onDelta(text.slice(10))
    return { text, toolCalls: [], providerOutput: [] }
  } } })
})

test('only known CLI effort is narrowed for a provider that declares no reasoning capability', async () => {
  await fixture(async ({ binding, upstream }) => {
    const response = await post(binding, body({ reasoning: { effort: 'medium' } }))
    const result = await consume(response)
    assert.equal(result.result.status, 'completed', result.raw)
    assert.match(response.headers.get('x-dsh-bridge-warnings'), /reasoning-effort-unavailable/)
    assert.match(result.result.metadata.dsh_bridge_warnings, /reasoning-effort-unavailable/)
    assert.equal(upstream.calls[0].body.reasoning_effort, undefined)
    assert.equal(upstream.calls[0].body.thinking, undefined)
  })
  await fixture(async ({ binding, upstream }) => {
    const result = await consume(await post(binding, body({ reasoning: { effort: 'medium' } })))
    assert.equal(result.result.error.code, 'bridge-unsupported')
    assert.match(result.result.error.message, /capability list/)
    assert.equal(upstream.calls.length, 0)
  }, { provider: { reasoningEfforts: ['high'], reasoningEffort: 'high', compat: { reasoningFormat: 'reasoning_effort' } } })
})

test('a narrowed parallel request rejects multiple calls instead of retrying or releasing tools', async () => {
  await fixture(async ({ upstream, binding }) => {
    upstream.handlers.push((_req, res, call) => jsonRound(res, call, { calls: [
      { id: 'one', name: flatName(call.body.tools[0]), arguments: '{"path":"one"}' },
      { id: 'two', name: flatName(call.body.tools[0]), arguments: '{"path":"two"}' },
    ] }))
    const response = await post(binding, body({ stream: true, tools: [tools[0]], parallel_tool_calls: true }))
    const result = await consume(response)
    assert.match(response.headers.get('x-dsh-bridge-warnings'), /parallel-tools-disabled/)
    assert.equal(result.result.status, 'failed')
    assert.equal(result.events.some((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call'), false)
    assert.equal(upstream.calls.length, 1)
  }, { provider: { compat: { parallelToolCalls: false } } })
})

test('named choice and custom-wrapper violations fail before any tool-done event', async () => {
  for (const wrong of ['name', 'wrapper']) await fixture(async ({ upstream, binding }) => {
    upstream.handlers.push((_req, res, call) => jsonRound(res, call, { calls: [{ id: 'wrong', name: flatName(call.body.tools[wrong === 'name' ? 0 : 1]), arguments: wrong === 'name' ? '{"path":"a"}' : '{"input":"one","input":"two"}' }] }))
    const result = await consume(await post(binding, body({ stream: true, tools: tools.slice(0, 2), tool_choice: { type: 'custom', name: 'shell' } })))
    assert.equal(result.result.status, 'failed')
    assert.equal(result.events.some((event) => event.type === 'response.custom_tool_call_input.done'), false)
    assert.equal(result.events.some((event) => event.type === 'response.completed'), false)
  })
})

test('Anthropic interleaved input instructions are rejected instead of being moved to the front', async () => {
  await fixture(async ({ binding, upstream }) => {
    const result = await consume(await post(binding, body({ input: [...input, { role: 'developer', content: 'late instruction' }] })))
    assert.equal(result.result.error.code, 'bridge-unsupported')
    assert.match(result.result.error.message, /interleaved system instruction/)
    assert.equal(upstream.calls.length, 0)
  }, { format: 'anthropic-messages' })
})

test('Anthropic private replay retains interleaved provider block order without leaking signed fields', async () => {
  await fixture(async ({ upstream, binding }) => {
    let content
    upstream.handlers.push((_req, res, call) => {
      content = [{ type: 'thinking', thinking: 'before', signature: SIGNATURE }, { type: 'tool_use', id: 'interleaved', name: flatName(call.body.tools[0]), input: { path: 'original' } }, { type: 'text', text: 'after tool declaration' }, { type: 'redacted_thinking', data: REDACTED }]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'message', role: 'assistant', id: 'ordered', content, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2 } }))
    })
    const first = await consume(await post(binding, body({ tools: [tools[0]] })))
    assert.equal(first.result.status, 'completed', first.raw)
    assertPrivate(first.raw, binding)
    upstream.handlers.push((_req, res, call) => {
      assert.deepEqual(call.body.messages.find((message) => message.role === 'assistant').content, content)
      jsonRound(res, call, { text: 'order preserved' })
    })
    const next = await consume(await post(binding, body({ tools: [tools[0]], input: [...input, ...first.result.output, { type: 'function_call_output', call_id: 'interleaved', output: 'CLI result' }] })))
    assert.equal(next.result.status, 'completed', next.raw)
  }, { format: 'anthropic-messages' })
})

test('replay can restore Codex-omitted reasoning text only via the same live output item identity', async () => {
  await fixture(async ({ upstream, binding }) => {
    upstream.handlers.push((_req, res, call) => jsonRound(res, call, { text: 'signed', thinking: true }))
    const first = await consume(await post(binding))
    const history = structuredClone(first.result.output)
    delete history.find((item) => item.type === 'reasoning').content
    upstream.handlers.push((_req, res, call) => {
      assert.equal(call.body.messages[1].content[0].signature, SIGNATURE)
      jsonRound(res, call, { text: 'restored' })
    })
    const next = await consume(await post(binding, body({ input: [...input, ...history, { role: 'user', content: 'continue' }] })))
    assert.equal(next.result.status, 'completed', next.raw)
  }, { format: 'anthropic-messages' })
})

test('bridge lifetime restart cannot recover another server private replay even with matching scope', async () => {
  await fixture(async ({ upstream, bridge, binding, model }) => {
    upstream.handlers.push((_req, res, call) => jsonRound(res, call, { text: 'signed', thinking: true }))
    const first = await consume(await post(binding))
    await bridge.dispose()
    const restarted = new ResponsesBridge()
    await restarted.start()
    try {
      const nextBinding = restarted.bind(model, { bindingId: 'main', scope: 'public-test-scope' })
      const result = await consume(await post(nextBinding, body({ input: [...input, ...first.result.output, { role: 'user', content: 'resume' }] })))
      assert.equal(result.result.error.code, 'bridge-replay-unavailable')
      assert.equal(upstream.calls.length, 1)
    } finally { await restarted.dispose() }
  }, { format: 'anthropic-messages' })
})

test('bridge suppresses explicit unsuccessful injected terminal and forbids a second upstream request', async () => {
  await fixture(async ({ binding }) => {
    const result = await consume(await post(binding, body({ stream: true })))
    assert.equal(result.result.status, 'failed')
    assert.equal(result.events.some((event) => event.type === 'response.completed'), false)
  }, { bridge: { roundImpl: async () => ({ text: 'partial', toolCalls: [], finishReason: 'length' }) } })
  await fixture(async ({ binding, upstream }) => {
    const result = await consume(await post(binding, body({ stream: true })))
    assert.equal(result.result.status, 'failed')
    assert.equal(result.result.error.code, 'bridge-retry-forbidden')
    assert.equal(upstream.calls.length, 1)
  }, { bridge: { roundImpl: async ({ fetchImpl, model }) => {
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model.model, messages: [] }) }
    const response = await fetchImpl(providerUrl(model), init)
    await response.text()
    return fetchImpl(providerUrl(model), init)
  } } })
})

test('output and terminal buffering limits fail before executable tools are emitted', async () => {
  await fixture(async ({ upstream, binding }) => {
    upstream.handlers.push((_req, res, call) => jsonRound(res, call, { calls: [{ id: 'large', name: flatName(call.body.tools[0]), arguments: JSON.stringify({ input: 'x'.repeat(6000) }) }] }))
    const result = await consume(await post(binding, body({ stream: true, tools: [tools[1]] })))
    assert.equal(result.result.status, 'failed')
    assert.equal(result.result.error.code, 'bridge-output-limit')
    assert.equal(result.events.some((event) => event.type === 'response.custom_tool_call_input.done'), false)
    assert.equal(result.events.some((event) => event.type === 'response.completed'), false)
  }, { bridge: { limits: { maxBufferedBytes: 4096 } } })
})

test('UTF-16 pairs survive text and custom-input fragmentation for the Rust Responses parser', async () => {
  const pair = String.fromCodePoint(0x20000)
  await fixture(async ({ binding }) => {
    const result = await consume(await post(binding, body({ stream: true, tools: [tools[1]] })))
    assert.equal(result.result.status, 'completed', result.raw)
    const fragments = result.events.filter((event) => event.type.endsWith('.delta')).map((event) => event.delta)
    for (const fragment of fragments) assert.equal(fragment.isWellFormed(), true)
    assert.equal(result.result.output.find((item) => item.type === 'custom_tool_call').input, `raw ${'x'.repeat(4090)}${pair}${'y'.repeat(4096)}`)
  }, { bridge: { roundImpl: async ({ onDelta, tools }) => {
    const text = `${'x'.repeat(80)}${pair}${'z'.repeat(80)}`
    for (const character of text) onDelta(character)
    return { text, toolCalls: [{ id: 'unicode', name: tools[0].function.name, arguments: JSON.stringify({ input: `raw ${'x'.repeat(4090)}${pair}${'y'.repeat(4096)}` }) }] }
  } } })
})

test('optional effort, output limit and parallel setting are integrated with actual core', async () => {
  await fixture(async ({ upstream, binding }) => {
    upstream.handlers.push((_req, res, call) => {
      assert.equal(call.body.reasoning_effort, 'low')
      assert.equal(call.body.max_completion_tokens, 345)
      assert.equal(call.body.parallel_tool_calls, false)
      jsonRound(res, call, { text: 'mapped options' })
    })
    const result = await consume(await post(binding, body({ tools: [tools[0]], parallel_tool_calls: false, reasoning: { effort: 'low' }, max_output_tokens: 345 })))
    assert.equal(result.result.status, 'completed', result.raw)
  }, { provider: { reasoningEfforts: ['low', 'high'], reasoningEffort: 'high', compat: { reasoningFormat: 'reasoning_effort', tokenField: 'max_completion_tokens' } } })
  await fixture(async ({ binding, upstream }) => {
    const response = await post(binding, body({ parallel_tool_calls: true }))
    const result = await consume(response)
    assert.equal(result.result.status, 'completed', result.raw)
    assert.equal(result.result.parallel_tool_calls, false)
    assert.match(response.headers.get('x-dsh-bridge-warnings'), /parallel-tools-disabled/)
    assert.match(result.result.metadata.dsh_bridge_warnings, /parallel-tools-disabled/)
    assert.equal(upstream.calls.length, 1)
  }, { provider: { compat: { parallelToolCalls: false } } })
})
