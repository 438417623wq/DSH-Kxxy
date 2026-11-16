import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ResponsesBridge } from '../plugins/dsh-codex-sidebar/lib/responses-bridge.mjs'
import { normalizeProvider } from '../plugins/dsh-codex-sidebar/lib/provider-config.mjs'

// Real loopback bridge requests, injected provider rounds only: no CLI, external
// provider, workspace command, or tool execution is needed for fork authorization.
const MODEL = 'bridge-fork-test-model'
const OLD_KEY = 'fork-old-provider-"key%+value'
const NEXT_KEY = 'fork-next-provider-private-key'
const TARGET_KEY = 'fork-target-provider-private-key'
const SIGNATURE = 'fork-private-anthropic-signature'
const REDACTED = 'fork-private-anthropic-redacted-block'
const TOOL = { type: 'function', name: 'inspect', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }
const CUSTOM_TOOL = { type: 'custom', name: 'original_shell', format: { type: 'text' } }
const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const refs = (output) => ({ itemIds: output.map((item) => item.id), callIds: output.flatMap((item) => item.call_id ? [item.call_id] : []) })
const toolName = (options) => options.tools[0].function?.name ?? options.tools[0].name
const toolOutputs = (output) => output.filter((item) => item.call_id).map((item) => ({ type: `${item.type}_output`, call_id: item.call_id, output: 'CLI-owned result; no tool ran in this test.' }))
const history = (output) => [user('begin'), ...structuredClone(output), ...toolOutputs(output), user('continue')]
const emptyMissing = { itemIds: [], callIds: [] }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
function round(format, { text = 'continued', reasoning = '', calls = [] } = {}) {
  return { text, reasoningContent: reasoning, toolCalls: calls, ...(format === 'anthropic-messages' ? { providerReplay: { apiFormat: format, content: [
    ...(reasoning ? [{ type: 'thinking', thinking: reasoning, signature: SIGNATURE }, { type: 'redacted_thinking', data: REDACTED }] : []),
    ...(text ? [{ type: 'text', text }] : []),
    ...calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) })),
  ] } } : {}) }
}
async function fixture(run, { format = 'chat-completions', limits = {}, provider = {}, targetProvider = {} } = {}) {
  const handlers = [], seen = []
  const model = normalizeProvider({ id: 'fork-provider', name: 'Source provider', engine: 'native', apiFormat: format, model: MODEL, baseUrl: 'http://127.0.0.1:1/v1', apiKey: OLD_KEY, ...(format === 'anthropic-messages' ? { maxOutputTokens: 4096 } : {}), ...provider })
  const bridge = new ResponsesBridge({ limits, timeoutMs: 5000, fetchImpl: async () => { assert.fail('No upstream network requests are allowed') }, roundImpl: async (options) => {
    seen.push(structuredClone({ model: options.model, messages: options.messages, tools: options.tools, toolChoice: options.toolChoice, parallelToolCalls: options.parallelToolCalls }))
    return handlers.length ? handlers.shift()(options) : round(format)
  } })
  await bridge.start()
  try {
    const source = bridge.bind(model, { bindingId: 'source', scope: 'source-thread' })
    const target = bridge.bind({ ...model, ...targetProvider }, { bindingId: 'target', scope: 'target-thread' })
    await run({ bridge, model, source, target, handlers, seen, format })
    assert.equal(handlers.length, 0, 'All expected provider rounds were consumed')
  } finally { await bridge.dispose() }
}
async function post(binding, payload = {}, headers = {}) {
  const response = await fetch(`${binding.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${binding.apiKey}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: MODEL, store: false, input: [user('begin')], ...payload }) })
  const raw = await response.text()
  const events = response.headers.get('content-type')?.includes('text/event-stream') ? raw.split('\n\n').flatMap((block) => block.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))) : []
  const result = events.length ? events.find((event) => ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type))?.response : JSON.parse(raw)
  return { status: response.status, raw, result, events }
}
function completed(reply) { assert.equal(reply.result.status, 'completed', reply.raw); return reply.result.output }
function denied(reply, code = 'bridge-replay-unavailable') { assert.equal(reply.result.error?.code, code, reply.raw) }
function forkError(bridge, source, target, allowlist, code) {
  assert.throws(() => bridge.forkReplay(source, target, allowlist), (error) => {
    assert.equal(error.code, code)
    for (const secret of [OLD_KEY, NEXT_KEY, TARGET_KEY, SIGNATURE, REDACTED]) assert.equal(error.message.includes(secret), false)
    return true
  })
}

for (const format of ['chat-completions', 'anthropic-messages']) test(`${format}: complete message/reasoning/tool prefix, independent scope and revoke`, async () => {
  await fixture(async ({ bridge, model, source, target, handlers, seen }) => {
    handlers.push((options) => round(format, { text: 'Allowed prefix', reasoning: 'Original reasoning', calls: [{ id: 'prefix_call', name: toolName(options), arguments: '{"path":"prefix"}' }] }))
    const first = await post(source, { tools: [TOOL] })
    const output = completed(first), prefix = history(output)
    assert.deepEqual(output.map((item) => item.type), ['message', 'reasoning', 'function_call'])
    handlers.push(() => round(format, { text: 'Future output must stay on the source', reasoning: 'Future reasoning' }))
    const future = completed(await post(source, { input: prefix }))
    const originalAssistant = structuredClone(seen[1].messages[1])
    denied(await post(target, { input: prefix }))
    const sameScope = bridge.bind(model, { bindingId: 'same-scope', scope: 'source-thread' })
    denied(await post(sameScope, { input: prefix }))
    denied(await post(target, { input: prefix, scope: 'source-thread', sourceBindingId: 'source' }), 'bridge-unsupported')
    denied(await post(target, { input: prefix }, { authorization: `Bearer ${source.apiKey}` }), 'bridge-auth')
    assert.equal(seen.length, 2, 'Unauthorized requests must not reach the provider')
    assert.notEqual(source.apiKey, target.apiKey)
    assert.notEqual(source.baseUrl, target.baseUrl)
    assert.deepEqual(bridge.forkReplay('source', 'target', refs(output)), { copied: 1, missing: emptyMissing })

    const tampered = structuredClone(prefix)
    tampered[1].content[0].text = 'Changed prefix'
    denied(await post(target, { input: tampered }))
    const changedCall = structuredClone(prefix)
    changedCall.find((item) => item.type === 'function_call').arguments = '{"path":"not-the-prefix"}'
    denied(await post(target, { input: changedCall }))
    const reordered = structuredClone(prefix)
    ;[reordered[1], reordered[2]] = [reordered[2], reordered[1]]
    denied(await post(target, { input: reordered }))
    const normalized = structuredClone(prefix)
    delete normalized[1].status
    delete normalized[1].content[0].annotations
    delete normalized.find((item) => item.type === 'reasoning').content
    handlers.push((options) => {
      assert.deepEqual(options.messages[1], originalAssistant, 'Private replay must retain exact original normalized history')
      assert.deepEqual(options.tools, [])
      assert.equal(options.toolChoice, 'none')
      assert.equal(options.parallelToolCalls, false)
      options.messages[1].content = 'Injected consumer mutation'
      if (options.messages[1].provider_replay) options.messages[1].provider_replay.content[0].signature = 'consumer mutation'
      return round(format)
    })
    completed(await post(target, { input: normalized, tools: [], tool_choice: 'none', parallel_tool_calls: false }))
    const futureHistory = [...prefix, ...future, user('after cutoff')]
    denied(await post(target, { input: futureHistory }))
    handlers.push((options) => { assert.deepEqual(options.messages[1], originalAssistant); return round(format) })
    completed(await post(source, { input: prefix }))
    bridge.revoke('target')
    completed(await post(source, { input: futureHistory }))
    denied(await post(target), 'bridge-route')

    const child = bridge.bind(model, { bindingId: 'child', scope: 'child-thread' })
    assert.deepEqual(bridge.forkReplay('source', 'child', refs(output)), { copied: 1, missing: emptyMissing })
    bridge.revoke('source')
    handlers.push((options) => { assert.deepEqual(options.messages[1], originalAssistant); return round(format) })
    completed(await post(child, { input: prefix }))
    denied(await post(source), 'bridge-route')
    const recreated = bridge.bind(model, { bindingId: 'source', scope: 'source-thread' })
    denied(await post(recreated, { input: prefix }))
  }, { format })
})

test('partial rounds never inherit sibling outputs; native ID mismatches poison the next request', async () => {
  await fixture(async ({ bridge, model, source, target, handlers, seen, format }) => {
    handlers.push((options) => round(format, { text: 'First round', reasoning: 'Must not copy without authorization', calls: [{ id: 'cutoff_call', name: toolName(options), arguments: '{"path":"cutoff"}' }] }))
    const first = completed(await post(source, { tools: [TOOL] }))
    handlers.push(() => round(format, { text: 'Separate allowed round' }))
    const second = completed(await post(source))
    const allowlist = { itemIds: [first[0].id, second[0].id], callIds: ['cutoff_call'] }
    assert.deepEqual(bridge.forkReplay('source', 'target', allowlist), { copied: 1, missing: { itemIds: [first[0].id], callIds: ['cutoff_call'] } })
    denied(await post(target, { input: history(second) }))
    denied(await post(target, { input: [user('even a history-free request must fail closed')], stream: true }))
    forkError(bridge, 'source', 'target', refs(first), 'bridge-replay-target')
    assert.equal(seen.length, 2)
    completed(await post(source, { input: history(first) }))

    const native = bridge.bind(model, { bindingId: 'native', scope: 'native-thread' })
    const nativeIds = { itemIds: ['agentMessage_native_id'], callIds: ['native_missing_call'] }
    assert.deepEqual(bridge.forkReplay('source', 'native', nativeIds), { copied: 0, missing: nativeIds })
    denied(await post(native, { input: [{ type: 'message', id: 'agentMessage_native_id', role: 'assistant', content: [{ type: 'output_text', text: 'Not a bridge wire item' }] }, user('next')] }))
    const descendant = bridge.bind(model, { bindingId: 'descendant', scope: 'descendant-thread' })
    forkError(bridge, 'native', 'descendant', { itemIds: [] }, 'bridge-replay-unavailable')
  })
})

for (const tool of [TOOL, CUSTOM_TOOL]) test(`${tool.type}: call-ID-only full entry retains CLI identity without granting tools`, async () => {
  await fixture(async ({ bridge, source, target, handlers, format, seen }) => {
    const argumentsText = tool.type === 'custom' ? '{"input":"original unexecuted command"}' : '{"path":"original"}'
    handlers.push((options) => round(format, { text: '', calls: [{ id: 'only_call', name: toolName(options), arguments: argumentsText }] }))
    const output = completed(await post(source, { tools: [tool] }))
    assert.equal(output.length, 1)
    assert.deepEqual(bridge.forkReplay('source', 'target', { callIds: ['only_call'] }), { copied: 1, missing: emptyMissing })
    const normalized = history(output)
    delete normalized[1].id
    handlers.push((options) => {
      assert.equal(options.messages[1].tool_calls[0].function.arguments, argumentsText)
      assert.deepEqual(options.tools, [])
      return round(format)
    })
    completed(await post(target, { input: normalized, tools: [], tool_choice: 'none' }))
    const originalToolName = seen[1].messages[1].tool_calls[0].function.name
    handlers.push(() => round(format, { text: '', calls: [{ id: 'new_undeclared_call', name: originalToolName, arguments: argumentsText }] }))
    denied(await post(target, { input: normalized, tools: [] }), 'bridge-upstream-tool')
  })
})

test('server authorization rejects missing scopes/providers, changed semantics and implicit or unbounded lists', async () => {
  await fixture(async ({ bridge, model, source, target }) => {
    for (const allowlist of [undefined, null, [], {}, { all: true }, { itemIds: undefined }, { callIds: new Set() }, { itemIds: [''] }, { itemIds: ['bad/id'] }, { callIds: ['x'.repeat(201)] }, { itemIds: ['a', 'b', 'c', 'd'] }, { callIds: ['a', 'b', 'c', 'd'] }, { itemIds: [], copyAll: true }, Object.create({ itemIds: [] }), { itemIds: Array(1) }]) forkError(bridge, 'source', 'target', allowlist, 'bridge-replay-allowlist')
    forkError(bridge, 'unknown', 'target', { itemIds: [] }, 'bridge-binding-missing')
    forkError(bridge, 'source', 'unknown', { itemIds: [] }, 'bridge-binding-missing')
    forkError(bridge, 'source', 'source', { itemIds: [] }, 'bridge-replay-scope')
    bridge.bind(model, { bindingId: 'no-scope' })
    bridge.bind(model, { bindingId: 'same-scope', scope: 'source-thread' })
    forkError(bridge, 'source', 'no-scope', { itemIds: [] }, 'bridge-replay-scope')
    forkError(bridge, 'no-scope', 'target', { itemIds: [] }, 'bridge-replay-scope')
    forkError(bridge, 'source', 'same-scope', { itemIds: [] }, 'bridge-replay-scope')
    const changes = [
      { id: undefined }, { id: 'different-provider' }, { model: 'different-model' }, { baseUrl: 'http://127.0.0.1:2/v1' },
      { authType: 'x-api-key' }, { headers: { 'x-tenant': 'other' } }, { query: { tenant: 'other' } },
      { maxOutputTokens: 2048 }, { compat: { ...model.compat, parallelToolCalls: false } },
    ]
    for (const [index, change] of changes.entries()) {
      bridge.bind({ ...model, ...change }, { bindingId: `changed-${index}`, scope: `changed-thread-${index}` })
      forkError(bridge, 'source', `changed-${index}`, { itemIds: [] }, 'bridge-provider-changed')
    }
    const first = completed(await post(source))
    completed(await post(target))
    forkError(bridge, 'source', 'target', refs(first), 'bridge-replay-target')
    const fresh = bridge.bind(model, { bindingId: 'fresh', scope: 'fresh-thread' })
    assert.deepEqual(bridge.forkReplay('source', 'fresh', { itemIds: [], callIds: [] }), { copied: 0, missing: emptyMissing })
    denied(await post(fresh, { input: history(first) }))
    forkError(bridge, 'source', 'fresh', refs(first), 'bridge-replay-target')
    bridge.revoke('fresh')
    forkError(bridge, 'source', 'fresh', refs(first), 'bridge-binding-missing')
    denied(await post(source, { model: 'different-model' }), 'bridge-model-mismatch')
  }, { limits: { maxInputItems: 3 } })
})

test('fork preserves old credential/signature redaction while keeping the new token and provider key', async () => {
  const header = 'fork-private-header-value', query = 'fork-private-query-value'
  await fixture(async ({ bridge, model, source, target, handlers, format }) => {
    handlers.push(() => round(format, { text: `Historical ${OLD_KEY}`, reasoning: 'Signed historical reasoning' }))
    const output = completed(await post(source))
    bridge.rotateCredentials('source', { ...model, apiKey: NEXT_KEY, name: 'Renamed source' })
    assert.deepEqual(bridge.forkReplay('source', 'target', refs(output)), { copied: 1, missing: emptyMissing })
    const secrets = [OLD_KEY, encodeURIComponent(OLD_KEY), NEXT_KEY, TARGET_KEY, source.apiKey, new URL(source.baseUrl).pathname, target.apiKey, new URL(target.baseUrl).pathname, SIGNATURE, REDACTED, header, query]
    const text = secrets.join(' | ') + ' all history stays private'
    handlers.push((options) => {
      assert.equal(options.model.apiKey, TARGET_KEY)
      assert.equal(options.model.name, 'Renamed target')
      assert.equal(options.messages[1].content, `Historical ${OLD_KEY}`)
      assert.equal(options.messages[1].provider_replay.content[0].signature, SIGNATURE)
      for (let start = 0; start < text.length; start += 7) options.onDelta(text.slice(start, start + 7))
      return round(format, { text, reasoning: `Private reasoning ${OLD_KEY} ${SIGNATURE}` })
    })
    const resumed = await post(target, { input: history(output), stream: true })
    completed(resumed)
    for (const secret of secrets) assert.equal(resumed.raw.includes(secret), false, 'A retained private value must not cross the loopback boundary')
    assert.match(resumed.result.output[0].content[0].text, /\[redacted\]/)
    assert.throws(() => bridge.rotateCredentials('target', { ...model, apiKey: 'fourth-provider-key' }), { code: 'bridge-credentials-limit' })
    assert.deepEqual(bridge.rotateCredentials('source', { ...model, apiKey: 'fourth-provider-key' }), source, 'Forking must not mutate source credential retention')
  }, { format: 'anthropic-messages', limits: { maxCredentialVersions: 3 }, provider: { headers: { 'x-context': header }, query: { tenant: query } }, targetProvider: { apiKey: TARGET_KEY, name: 'Renamed target' } })
})

test('fork bounds are atomic and never evict the source or unrelated caches', async () => {
  await fixture(async ({ bridge, model, source, target, handlers, format }) => {
    handlers.push(() => round(format, { text: 'x'.repeat(350) }))
    const output = completed(await post(source))
    forkError(bridge, 'source', 'target', refs(output), 'bridge-replay-limit')
    // Failure did not partially initialize or poison the target.
    assert.deepEqual(bridge.forkReplay('source', 'target', { itemIds: [] }), { copied: 0, missing: emptyMissing })
    const untouched = bridge.bind(model, { bindingId: 'untouched', scope: 'untouched-thread' })
    denied(await post(untouched, { input: history(output) }))
    completed(await post(source, { input: history(output) }))
    completed(await post(target))
  }, { limits: { maxReplayBytes: 4096, maxReplayTotalBytes: 1600 } })
  await fixture(async ({ bridge, source, target, handlers, format }) => {
    handlers.push(() => round(format, { text: 'evicted entry' }))
    const first = completed(await post(source))
    handlers.push(() => round(format, { text: 'retained entry' }))
    const second = completed(await post(source))
    assert.deepEqual(bridge.forkReplay('source', 'target', { itemIds: [...refs(first).itemIds, ...refs(second).itemIds] }), { copied: 1, missing: { itemIds: refs(first).itemIds, callIds: [] } })
    denied(await post(target))
    completed(await post(source, { input: history(second) }))
  }, { limits: { maxReplayEntries: 1 } })
  await fixture(async ({ bridge, model, source, target }) => {
    const output = completed(await post(source))
    bridge.rotateCredentials('source', { ...model, apiKey: NEXT_KEY })
    forkError(bridge, 'source', 'target', refs(output), 'bridge-credentials-limit')
    completed(await post(target))
    completed(await post(source, { input: history(output) }))
  }, { limits: { maxCredentialVersions: 2 }, targetProvider: { apiKey: TARGET_KEY } })
  await fixture(async ({ bridge }) => {
    forkError(bridge, 'source', 'target', { itemIds: [] }, 'bridge-credentials-limit')
  }, { limits: { maxReplayBytes: 512 }, provider: { apiKey: 's'.repeat(1024) } })
})

test('both active source and active target forbid inheritance until abort releases the slot', async () => {
  await fixture(async ({ bridge, source, target, handlers }) => {
    for (const binding of [source, target]) {
      const started = deferred()
      handlers.push(() => { started.resolve(); return new Promise(() => {}) })
      const pending = post(binding)
      await started.promise
      forkError(bridge, 'source', 'target', { itemIds: [] }, 'bridge-busy')
      bridge.abort(binding === source ? 'source' : 'target')
      denied(await pending, 'bridge-cancelled')
    }
    assert.deepEqual(bridge.forkReplay('source', 'target', { itemIds: [] }), { copied: 0, missing: emptyMissing })
  })
})
