import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, cp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setImmediate as nextTick } from 'node:timers/promises'
import { CodexService } from '../plugins/dsh-codex-sidebar/lib/service.mjs'
import { conversationMessages, recordInterruptedTurn, turnMessages } from '../plugins/dsh-codex-sidebar/lib/custom-chat.mjs'
import { CodexError } from '../plugins/dsh-codex-sidebar/lib/transport.mjs'

const SECRET = 'private-test-key-without-sk-prefix'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  await new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  })
}

async function mockProvider() {
  const calls = []
  const responses = []
  const server = createServer(async (req, res) => {
    try {
      const parts = []
      for await (const part of req) parts.push(part)
      const raw = Buffer.concat(parts).toString('utf8')
      const call = { url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null }
      calls.push(call)
      const handler = responses.shift()
      if (handler) await handler(req, res, call)
      else completion(res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      if (!res.destroyed) res.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  const origin = await listen(server)
  return { origin, calls, responses, close: () => close(server) }
}

function completion(res, text = '回答完成') {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ id: 'chat-mock', choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }))
}

async function splitSse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  res.flushHeaders()
  for (const byte of Buffer.from(events)) {
    if (res.destroyed) return
    res.write(Buffer.from([byte]))
    await nextTick()
  }
  res.end()
}

async function fixture(fn, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-custom-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const cwd = await realpath(workspace)
  const provider = await mockProvider()
  const lifecycle = { probes: 0, transports: 0 }
  let currentCwd = cwd
  const services = []
  const makeService = (overrides = {}) => {
    const service = new CodexService({
      paths: { home, executable: null },
      resolveWorkspace: async (id) => {
        if (!['session', 'other-session'].includes(id)) throw new CodexError('session-invalid', 'Invalid session')
        return currentCwd
      },
      probe: async () => { lifecycle.probes += 1; throw new Error('CLI must not be needed') },
      transportFactory: () => { lifecycle.transports += 1; throw new Error('CLI must not be needed') },
      ...options,
      ...overrides,
    })
    services.push(service)
    return service
  }
  const service = makeService()
  try {
    await fn({ service, makeService, provider, root, home, cwd, lifecycle, changeWorkspace: (path) => { currentCwd = path } })
  } finally {
    for (const service of services) await service.dispose()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function addModel(service, origin, overrides = {}) {
  const input = { name: '自定义模型', model: 'vendor-chat-model', baseUrl: `${origin}/v1`, apiKey: SECRET, apiFormat: 'chat-completions', ...overrides }
  await service.saveModel(input)
  return (await service.snapshot('session')).customModels.find((entry) => entry.name === input.name)
}

async function newThread(service, model) {
  return (await service.create('session', { model: model.id, effort: '', mode: 'chat' })).thread
}

function input(thread, model, requestId = 'request-1', extra = {}) {
  return { threadId: thread.id, model: model.id, effort: '', mode: 'chat', requestId, text: '你好', ...extra }
}

async function waitUntil(check, label = 'condition', timeout = 2500) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`Timed out waiting for ${label}`)
}

async function completedTurn(service, threadId, turnId, timeout = 2500) {
  let found
  await waitUntil(async () => {
    const snapshot = await service.snapshot('session')
    const thread = snapshot.threads.find((entry) => entry.id === threadId)
    found = thread?.turns?.find((entry) => entry.id === turnId)
    return found && found.status !== 'inProgress' && !thread.pending
  }, 'terminal turn', timeout)
  // The visible terminal state precedes the atomic history rename.
  await service.queue
  return found
}

function assistantText(turn) {
  return (turn.items ?? []).filter((item) => item.type === 'agentMessage').map((item) => item.text ?? '').join('')
}

async function filesText(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await filesText(path))
    else result.push({ path, text: await readFile(path, 'utf8') })
  }
  return result
}

test('custom model settings persist metadata, normalize URL, and preserve a blank edited key', async () => {
  await fixture(async ({ service, makeService, provider, home, lifecycle }) => {
    const model = await addModel(service, provider.origin, { baseUrl: `${provider.origin}/v1/chat/completions/` })
    assert.equal(model.baseUrl, `${provider.origin}/v1/chat/completions`)
    assert.equal(model.hasApiKey, true)
    assert.match(model.id, /^custom-/)
    assert.ok(!Object.hasOwn(model, 'apiKey'))
    const edited = await service.saveModel({ ...model, name: '重命名模型', apiKey: '' })
    assert.equal(edited.name, '重命名模型')
    assert.equal(edited.hasApiKey, true)
    await service.dispose()
    const restarted = makeService({ paths: undefined, env: { KXXY_CODEX_HOME: home } })
    const snapshot = await restarted.snapshot('session')
    assert.equal(snapshot.customModels.length, 1)
    assert.equal(snapshot.customModels[0].name, '重命名模型')
    assert.equal(snapshot.health.agent, false)
    assert.ok(snapshot.models.some((entry) => entry.id === model.id && entry.source === 'custom'))
    assert.ok(!JSON.stringify(snapshot).includes(SECRET))
    const thread = await newThread(restarted, model)
    const { turnId } = await restarted.send('session', input(thread, model))
    assert.equal((await completedTurn(restarted, thread.id, turnId)).status, 'completed')
    assert.equal(provider.calls[0].headers.authorization, `Bearer ${SECRET}`)
    const files = await filesText(home)
    assert.deepEqual(files.filter((entry) => entry.text.includes(SECRET)).map((entry) => entry.path.split(/[\\/]/).at(-1)), ['sidebar-models.json'])
    assert.deepEqual(lifecycle, { probes: 0, transports: 0 })
  })
})

test('custom chat streams split UTF-8 SSE without CLI, login, tools, or reasoning effort', async () => {
  await fixture(async ({ service, provider, cwd, lifecycle }) => {
    await writeFile(join(cwd, 'context.txt'), '工作区上下文')
    const model = await addModel(service, provider.origin)
    const thread = await newThread(service, model)
    provider.responses.push(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.flushHeaders()
      const first = `data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\r\n\r\n`
      for (const byte of Buffer.from(first)) { res.write(Buffer.from([byte])); await nextTick() }
      await waitUntil(async () => assistantText((await service.snapshot('session')).threads[0].turns[0]) === '你好', 'visible streamed delta')
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '，世界' }, finish_reason: 'stop' }] })}\r\n\r\ndata: [DONE]\r\n\r\n`)
    })
    const { turnId } = await service.send('session', input(thread, model, 'stream-request', { files: ['context.txt'] }))
    const turn = await completedTurn(service, thread.id, turnId)
    assert.equal(turn.status, 'completed')
    assert.equal(assistantText(turn), '你好，世界')
    const [call] = provider.calls
    assert.equal(call.url, '/v1/chat/completions')
    assert.equal(call.method, 'POST')
    assert.equal(call.headers.authorization, `Bearer ${SECRET}`)
    assert.equal(call.body.model, 'vendor-chat-model')
    assert.equal(call.body.stream, true)
    assert.ok(call.body.messages.some((entry) => entry.role === 'user' && entry.content.includes('你好') && entry.content.includes('工作区上下文')))
    assert.equal(call.body.tools, undefined)
    assert.equal(call.body.functions, undefined)
    assert.equal(call.body.reasoning_effort, undefined)
    assert.deepEqual(lifecycle, { probes: 0, transports: 0 })
    const snapshot = await service.snapshot('session')
    assert.equal(snapshot.approvals.length, 0)
    assert.ok(!JSON.stringify(snapshot).includes(SECRET))
  })
})

test('Responses-compatible models use /responses and stream text without duplicating final output', async () => {
  await fixture(async ({ service, provider }) => {
    const model = await addModel(service, provider.origin, { apiFormat: 'responses', baseUrl: `${provider.origin}/v1/responses` })
    provider.responses.push((_req, res) => splitSse(res, [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '你好' })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '，世界' })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好，世界' }] }] } })}\n\n`,
    ].join('')))
    const thread = await newThread(service, model)
    const { turnId } = await service.send('session', input(thread, model))
    const turn = await completedTurn(service, thread.id, turnId)
    assert.equal(turn.status, 'completed')
    assert.equal(assistantText(turn), '你好，世界')
    const [call] = provider.calls
    assert.equal(call.url, '/v1/responses')
    assert.equal(call.body.model, model.model)
    assert.equal(call.body.stream, true)
    assert.ok(JSON.stringify(call.body.input).includes('你好'))
    assert.equal(call.body.tools, undefined)
  })
})

test('custom chat history survives restart and remains readable after model deletion', async () => {
  await fixture(async ({ service, makeService, provider, home }) => {
    const model = await addModel(service, provider.origin)
    const thread = await newThread(service, model)
    const first = await service.send('session', input(thread, model, 'history-1', { text: '第一条消息' }))
    await completedTurn(service, thread.id, first.turnId)
    await service.dispose()
    const restarted = makeService({ paths: undefined, env: { KXXY_CODEX_HOME: home } })
    const restored = await restarted.resume('session', thread.id)
    assert.equal(restored.turns.length, 1)
    assert.equal(assistantText(restored.turns[0]), '回答完成')
    assert.deepEqual(await restarted.send('session', input(thread, model, 'history-1', { text: '第一条消息' })), first)
    assert.equal(provider.calls.length, 1)
    const second = await restarted.send('session', input(thread, model, 'history-2', { text: '第二条消息' }))
    await completedTurn(restarted, thread.id, second.turnId)
    const sent = provider.calls[1].body.messages
    assert.ok(sent.some((entry) => entry.role === 'user' && entry.content.includes('第一条消息')))
    assert.ok(sent.some((entry) => entry.role === 'assistant' && entry.content === '回答完成'))
    assert.ok(sent.some((entry) => entry.role === 'user' && entry.content.includes('第二条消息')))
    await restarted.deleteModel(model.id)
    await restarted.dispose()
    const afterDelete = makeService({ paths: undefined, env: { KXXY_CODEX_HOME: home } })
    assert.equal((await afterDelete.snapshot('session')).customModels.length, 0)
    assert.equal((await afterDelete.resume('session', thread.id)).turns.length, 2)
    await assert.rejects(afterDelete.send('session', input(thread, model, 'history-3')), { code: 'model-missing' })
    assert.equal(provider.calls.length, 2)
    const files = await filesText(home)
    assert.ok(files.every((entry) => !entry.text.includes(SECRET)))
    assert.ok(!JSON.stringify(await afterDelete.snapshot('session')).includes(SECRET))
  })
})

test('custom chat enforces session, workspace, context and mode validation before calling provider', async () => {
  await fixture(async ({ service, provider, root, cwd, changeWorkspace }) => {
    const model = await addModel(service, provider.origin)
    const thread = await newThread(service, model)
    await writeFile(join(cwd, '.env'), 'sensitive credential')
    await writeFile(join(root, 'outside.txt'), 'outside')
    await assert.rejects(service.create('session', { model: model.id, effort: '', mode: 'unsupported' }), { code: 'mode-invalid' })
    await assert.rejects(service.send('session', input(thread, model, 'mode-change', { mode: 'agent' })), { code: 'mode-change' })
    await assert.rejects(service.send('other-session', input(thread, model, 'wrong-session')), { code: 'thread-forbidden' })
    await assert.rejects(service.send('session', input(thread, model, 'sensitive', { files: ['.env'] })), { code: 'sensitive-file' })
    await assert.rejects(service.send('session', input(thread, model, 'traversal', { files: ['../outside.txt'] })), { code: 'file-outside' })
    await assert.rejects(service.send('session', input(thread, model, 'too-many', { files: Array(11).fill('missing.txt') })), { code: 'context-limit' })
    const different = join(root, 'different-workspace')
    await mkdir(different)
    changeWorkspace(await realpath(different))
    await assert.rejects(service.send('session', input(thread, model, 'changed-workspace')), { code: 'workspace-changed' })
    assert.equal(provider.calls.length, 0)
  })
})

test('concurrent custom turns deduplicate and allow an in-thread model switch only while the target config is unchanged', async () => {
  await fixture(async ({ service, provider }) => {
    const model = await addModel(service, provider.origin)
    const thread = await newThread(service, model)
    let finish
    provider.responses.push(async (_req, res) => {
      await new Promise((resolve) => { finish = resolve })
      completion(res)
    })
    const request = input(thread, model, 'same-request')
    const results = await Promise.all([service.send('session', request), service.send('session', request)])
    assert.equal(results[0].turnId, results[1].turnId)
    await waitUntil(() => provider.calls.length === 1, 'first provider request')
    await assert.rejects(service.send('session', input(thread, model, 'busy-request')), { code: 'busy' })
    finish()
    await completedTurn(service, thread.id, results[0].turnId)
    assert.deepEqual(await service.send('session', request), results[0])
    assert.equal(provider.calls.length, 1)
    // Same engine, same mode: the thread keeps its context and the provider is swapped.
    const other = await addModel(service, provider.origin, { name: '另一个模型', model: 'another-model' })
    const switched = await service.send('session', input(thread, other, 'switch-model'))
    await completedTurn(service, thread.id, switched.turnId)
    assert.equal(provider.calls[1].body.model, 'another-model')
    assert.equal(provider.calls[1].body.messages.filter((entry) => entry.role === 'user').length, 2)
    assert.equal((await service.snapshot('session')).threads.find((entry) => entry.id === thread.id).model, other.id)
    // Editing the bound provider still requires a fresh conversation.
    await service.saveModel({ ...other, baseUrl: `${provider.origin}/alternate/v1`, apiKey: '' })
    await assert.rejects(service.send('session', input(thread, other, 'edited-provider')), { code: 'model-change' })
    assert.equal(provider.calls.length, 2)
    const changed = (await service.snapshot('session')).customModels.find((entry) => entry.id === other.id)
    const newChat = await newThread(service, changed)
    const next = await service.send('session', input(newChat, changed, 'new-chat'))
    await completedTurn(service, newChat.id, next.turnId)
    assert.equal(provider.calls[2].url, '/alternate/v1/chat/completions')
  })
})

test('batch save keeps one connection, many models, inherits the saved key and drops deselected entries', async () => {
  await fixture(async ({ service, provider, home }) => {
    const group = {
      groupName: 'DeepSeek 中转', engine: 'workspace', apiFormat: 'chat-completions',
      baseUrl: `${provider.origin}/v1`, authType: 'bearer', apiKey: SECRET,
      models: [
        { model: 'deepseek-chat', name: 'DeepSeek Chat' },
        { model: 'deepseek-reasoner', name: 'DeepSeek R1' },
        { model: 'deepseek-coder', name: 'DeepSeek Coder' },
      ],
    }
    const first = await service.saveModels(group)
    assert.match(first.groupId, /^group-/)
    assert.equal(first.saved.length, 3)
    const snapshot = await service.snapshot('session')
    assert.equal(snapshot.customModels.length, 3)
    assert.ok(snapshot.customModels.every((entry) => entry.groupId === first.groupId && entry.groupName === group.groupName))
    assert.ok(!JSON.stringify(snapshot).includes(SECRET))
    // A second save reuses the group, inherits the stored key and keeps the untouched id.
    const byModel = Object.fromEntries(first.saved.map((entry) => [entry.model, entry]))
    const second = await service.saveModels({
      ...group, apiKey: '', groupId: first.groupId,
      models: [
        { id: byModel['deepseek-chat'].id, model: 'deepseek-chat', name: 'DeepSeek V3' },
        { model: 'deepseek-reasoner', name: 'DeepSeek R1' },
        { id: byModel['deepseek-coder'].id, model: 'deepseek-coder', name: 'DeepSeek Coder' },
        { model: 'deepseek-vl', name: 'DeepSeek VL' },
      ],
    })
    assert.equal(second.groupId, first.groupId)
    assert.deepEqual(second.removedIds, [])
    const three = await service.snapshot('session')
    assert.equal(three.customModels.length, 4)
    assert.equal(three.customModels.find((entry) => entry.model === 'deepseek-chat').id, byModel['deepseek-chat'].id)
    assert.equal(three.customModels.find((entry) => entry.model === 'deepseek-chat').name, 'DeepSeek V3')
    const remaining = Object.fromEntries(second.saved.map((entry) => [entry.model, entry.id]))
    const third = await service.saveModels({
      ...group, apiKey: '', groupId: first.groupId,
      models: [{ id: remaining['deepseek-chat'], model: 'deepseek-chat', name: 'DeepSeek V3' }],
    })
    assert.equal(third.saved.length, 1)
    assert.equal(third.removedIds.length, 3)
    assert.equal((await service.snapshot('session')).customModels.length, 1)
    // The inherited key still works for the surviving model.
    const survivor = (await service.snapshot('session')).customModels[0]
    const chat = await newThread(service, survivor)
    const sent = await service.send('session', input(chat, survivor, 'batch-key'))
    await completedTurn(service, chat.id, sent.turnId)
    assert.equal(provider.calls[0].headers.authorization, `Bearer ${SECRET}`)
    const files = await filesText(home)
    assert.ok(files.filter((entry) => entry.text.includes(SECRET)).every((entry) => entry.path.endsWith('sidebar-models.json')))
  })
})

test('switching models inside a thread strips vendor-private replay fields but keeps standard context', async () => {
  await fixture(async ({ service, provider }) => {
    const responses = await addModel(service, provider.origin, { name: 'Responses 模型', model: 'gpt-responses', apiFormat: 'responses' })
    const chat = await addModel(service, provider.origin, { name: 'Chat 模型', model: 'vendor-chat-model' })
    const thread = await newThread(service, responses)
    provider.responses.push((_req, res) => splitSse(res, [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '第一轮' })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', id: 'resp-1', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一轮' }] }] } })}\n\n`,
    ].join('')))
    const first = await service.send('session', { ...input(thread, responses, 'turn-a'), mode: 'chat' })
    await completedTurn(service, thread.id, first.turnId)
    const second = await service.send('session', { ...input(thread, chat, 'turn-b'), mode: 'chat' })
    await completedTurn(service, thread.id, second.turnId)
    const sent = provider.calls[1].body.messages
    assert.equal(provider.calls[1].url, '/v1/chat/completions')
    assert.ok(sent.some((entry) => entry.role === 'assistant' && entry.content === '第一轮'))
    assert.ok(sent.every((entry) => !('responses_output' in entry) && !('provider_replay' in entry) && !('reasoning_content' in entry)))
    const turn = (await service.snapshot('session')).threads.find((entry) => entry.id === thread.id).turns.find((entry) => entry.id === second.turnId)
    assert.equal(turn.metadata.model, 'vendor-chat-model')
  })
})

test('custom chat cancellation and timeout end the turn and never resend an accepted request', async () => {
  await fixture(async ({ service, makeService, provider }) => {
    const model = await addModel(service, provider.origin)
    const thread = await newThread(service, model)
    provider.responses.push((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders() })
    const request = input(thread, model, 'cancel-request')
    const accepted = await service.send('session', request)
    await waitUntil(() => provider.calls.length === 1, 'running request')
    assert.equal((await service.interrupt('session', thread.id)).requested, true)
    const cancelled = await completedTurn(service, thread.id, accepted.turnId)
    assert.notEqual(cancelled.status, 'completed')
    assert.deepEqual(await service.send('session', request), accepted)
    const timedService = makeService({ customTimeoutMs: 40 })
    const timedThread = await newThread(timedService, model)
    provider.responses.push((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders() })
    const timedRequest = input(timedThread, model, 'timeout-request')
    const timed = await timedService.send('session', timedRequest)
    const timedTurn = await completedTurn(timedService, timedThread.id, timed.turnId)
    assert.notEqual(timedTurn.status, 'completed')
    assert.ok(JSON.stringify(timedTurn).includes('timeout') || JSON.stringify(timedTurn).includes('超时'))
    assert.deepEqual(await timedService.send('session', timedRequest), timed)
    assert.equal(provider.calls.length, 2)
  })
})

test('history keeps the usable part of a stopped turn and repairs dangling tool calls', () => {
  const completed = { status: 'completed', providerMessages: [{ role: 'user', content: '一' }, { role: 'assistant', content: '答一', provider_replay: { apiFormat: 'anthropic-messages', content: [{ type: 'text', text: '答一' }] } }], items: [] }
  const dangling = {
    status: 'interrupted',
    providerMessages: [
      { role: 'user', content: '二' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'look', arguments: '{}' } }, { id: 'call-2', type: 'function', function: { name: 'look', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
    ],
    items: [{ type: 'agentMessage', text: '' }],
  }
  const partial = { status: 'failed', providerMessages: [{ role: 'user', content: '三' }], items: [{ type: 'agentMessage', text: '写到一半' }] }
  assert.deepEqual(turnMessages(completed).map((entry) => entry.role), ['user', 'assistant'])
  assert.equal(turnMessages(completed, { stripPrivate: true })[1].provider_replay, undefined)
  const repairedMessages = turnMessages(dangling)
  assert.deepEqual(repairedMessages.map((entry) => entry.role), ['user', 'assistant', 'tool', 'tool'])
  assert.deepEqual(repairedMessages.map((entry) => entry.tool_call_id), [undefined, undefined, 'call-1', 'call-2'])
  assert.match(repairedMessages[3].content, /not-executed/)
  const stopped = turnMessages(partial)
  assert.equal(stopped[1].role, 'assistant'); assert.ok(stopped[1].content.startsWith('写到一半')); assert.ok(stopped[1].content.includes('停止'))
  assert.deepEqual(turnMessages({ status: 'inProgress', providerMessages: [{ role: 'user', content: '四' }] }), [])
  // Legacy turns without providerMessages still contribute their visible items.
  assert.deepEqual(turnMessages({ status: 'interrupted', items: [{ type: 'userMessage', content: [{ type: 'text', text: '五' }] }, { type: 'agentMessage', text: '半' }] }).map((entry) => entry.role), ['user', 'assistant'])
  const turn = { status: 'interrupted', providerMessages: [{ role: 'user', content: '六' }], items: [{ type: 'agentMessage', text: '半' }] }
  assert.equal(recordInterruptedTurn(turn, { text: '半' }), true)
  assert.equal(recordInterruptedTurn(turn, { text: '半' }), false)
  assert.deepEqual(turn.providerMessages, [{ role: 'user', content: '六' }, { role: 'assistant', content: '半' }])
  const messages = conversationMessages({ turns: [completed, dangling, partial] }, '继续')
  assert.deepEqual(messages.map((entry) => entry.role), ['user', 'assistant', 'user', 'assistant', 'tool', 'tool', 'user', 'assistant', 'user'])
  assert.equal(messages.at(-1).content, '继续')
})

test('phone attachments are stored inside the workspace and referenced by path', async () => {
  await fixture(async ({ service, provider, cwd }) => {
    const model = await addModel(service, provider.origin)
    const thread = await newThread(service, model)
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0xff])
    const saved = await service.uploadAttachment('session', { name: '扫描件.pdf', data: pdf.toString('base64') })
    assert.match(saved.path, /^\.codex-uploads\/[\da-z]+-扫描件\.pdf$/)
    assert.equal(saved.binary, true); assert.equal(saved.size, pdf.length)
    assert.ok(!('text' in saved))
    assert.ok((await readFile(join(cwd, saved.path))).equals(pdf))
    const note = await service.uploadAttachment('session', { name: 'notes.md', data: Buffer.from('# 标题').toString('base64') })
    assert.equal(note.binary, false); assert.ok(!('text' in note))
    await writeFile(join(cwd, 'context.txt'), '工作区上下文')
    const { turnId } = await service.send('session', input(thread, model, 'attach-request', { text: '看看附件', files: [saved.path, note.path, 'context.txt'] }))
    assert.equal((await completedTurn(service, thread.id, turnId)).status, 'completed')
    const prompt = provider.calls[0].body.messages.find((entry) => entry.role === 'user').content
    assert.ok(prompt.includes('<workspace-attachment path=')); assert.ok(prompt.includes(saved.path))
    assert.ok(prompt.includes('二进制附件'))
    assert.ok(prompt.includes(`<workspace-file path="${note.path}">\n# 标题`))
    assert.ok(prompt.includes('<workspace-file path="context.txt">\n工作区上下文'))
    assert.ok(!prompt.includes('\u0000'))
    await assert.rejects(service.uploadAttachment('session', { name: '../escape.txt', data: 'aGk=' }), { code: 'attachment-name' })
  })
})

test('picked images are sent as vision blocks and never persisted in the history', async () => {
  await fixture(async ({ service, provider }) => {
    const model = await addModel(service, provider.origin)
    const thread = await newThread(service, model)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52])
    const saved = await service.uploadAttachment('session', { name: '截图.png', data: png.toString('base64') })
    assert.equal(saved.mime, 'image/png'); assert.equal(saved.binary, true)
    const { turnId } = await service.send('session', input(thread, model, 'vision-request', { text: '这张图里是什么', files: [saved.path] }))
    const turn = await completedTurn(service, thread.id, turnId)
    assert.equal(turn.status, 'completed')
    const sent = provider.calls[0].body.messages.filter((entry) => entry.role !== 'system')
    const last = sent.at(-1)
    assert.equal(last.role, 'user')
    assert.ok(Array.isArray(last.content))
    assert.equal(last.content[0].type, 'text')
    assert.ok(last.content[0].text.includes('这张图里是什么'))
    assert.ok(last.content[0].text.includes('<workspace-image path='))
    assert.deepEqual(last.content[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } })
    assert.equal(turn.items[0].images[0].path, saved.path)
    assert.equal(turn.items[0].images[0].mime, 'image/png')
    // The base64 must never reach the on-disk history: the replay keeps the path note only.
    assert.ok(!JSON.stringify(await service.snapshot('session')).includes(png.toString('base64')))
    const second = await service.send('session', input(thread, model, 'vision-follow-up', { text: '继续', files: [] }))
    assert.equal((await completedTurn(service, thread.id, second.turnId)).status, 'completed')
    const replay = provider.calls[1].body.messages.filter((entry) => entry.role === 'user')
    // History replay is text again: the image path note survives, the pixels are not resent.
    assert.equal(typeof replay[0].content, 'string')
    assert.ok(replay[0].content.includes(saved.path))
    assert.ok(!replay[0].content.includes(png.toString('base64')))
  })
})

test('a stopped turn keeps its partial answer as context for the next message', async () => {
  await fixture(async ({ service, provider }) => {
    const model = await addModel(service, provider.origin)
    const thread = await newThread(service, model)
    provider.responses.push(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.flushHeaders()
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '部分回答' } }] })}\n\n`)
      await waitUntil(async () => assistantText((await service.snapshot('session')).threads[0].turns[0]) === '部分回答', 'visible delta')
    })
    const first = await service.send('session', input(thread, model, 'partial-request'))
    await waitUntil(() => provider.calls.length === 1, 'running request')
    await waitUntil(async () => assistantText((await service.snapshot('session')).threads[0].turns[0]) === '部分回答', 'streamed text')
    await service.interrupt('session', thread.id)
    const stopped = await completedTurn(service, thread.id, first.turnId)
    assert.equal(stopped.status, 'interrupted')
    const second = await service.send('session', input(thread, model, 'resume-request', { text: '继续' }))
    assert.equal((await completedTurn(service, thread.id, second.turnId)).status, 'completed')
    const sent = provider.calls[1].body.messages.filter((entry) => entry.role !== 'system')
    assert.deepEqual(sent.map((entry) => entry.role), ['user', 'assistant', 'user'])
    assert.ok(sent[0].content.includes('你好'))
    assert.ok(sent[1].content.startsWith('部分回答')); assert.ok(sent[1].content.includes('停止'))
    assert.equal(sent[2].content, '继续')
  })
})

test('upstream failures never expose the API key or execute tool requests', async () => {
  await fixture(async ({ service, provider, home }) => {
    const model = await addModel(service, provider.origin)
    const thread = await newThread(service, model)
    provider.responses.push((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Rejected credential ${SECRET}` } }))
    })
    const accepted = await service.send('session', input(thread, model, 'upstream-failure'))
    const turn = await completedTurn(service, thread.id, accepted.turnId)
    assert.notEqual(turn.status, 'completed')
    assert.ok(!JSON.stringify(turn).includes(SECRET))
    assert.ok(!JSON.stringify(await service.snapshot('session')).includes(SECRET))
    provider.responses.push((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'tool-call', type: 'function', function: { name: 'run_command', arguments: '{"command":"touch should-not-exist"}' } }] }, finish_reason: 'tool_calls' }] }))
    })
    const toolAttempt = await service.send('session', input(thread, model, 'tool-attempt'))
    const toolTurn = await completedTurn(service, thread.id, toolAttempt.turnId)
    assert.notEqual(toolTurn.status, 'inProgress')
    assert.equal((await service.snapshot('session')).approvals.length, 0)
    for (const call of provider.calls) {
      assert.equal(call.body.tools, undefined)
      assert.equal(call.body.functions, undefined)
    }
    const history = (await filesText(home)).filter((entry) => !entry.path.endsWith('sidebar-models.json'))
    assert.ok(history.every((entry) => !entry.text.includes(SECRET)))
  })
})

test('invalid custom settings are rejected without accepting URL credentials or empty initial keys', async () => {
  await fixture(async ({ service, provider }) => {
    for (const overrides of [
      { baseUrl: 'file:///tmp/model' },
      { baseUrl: `http://user:password@127.0.0.1:${new URL(provider.origin).port}/v1` },
      { baseUrl: `${provider.origin}/v1?api_key=${SECRET}` },
      { baseUrl: `${provider.origin}/v1#secret` },
      { apiKey: '' },
      { model: '' },
      { name: '' },
      { apiFormat: 'unknown' },
    ]) {
      await assert.rejects(addModel(service, provider.origin, overrides), (error) => {
        assert.ok(!error.message.includes(SECRET))
        return true
      })
    }
    assert.equal((await service.snapshot('session')).customModels.length, 0)
  })
})

test('custom model HTTP routes require host authentication, origin, nonce and a valid session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-custom-http-'))
  const savedEnvironment = Object.fromEntries(['KXXY_CODEX_HOME', 'KXXY_CODEX_BIN', 'KXXY_ENGINE_ROOT'].map((key) => [key, process.env[key]]))
  const cleanups = []
  const provider = await mockProvider()
  let server
  try {
    const modules = join(root, 'node_modules')
    await mkdir(join(modules, 'kxxy-host', 'lib'), { recursive: true })
    await cp(fileURLToPath(new URL('../plugins/dsh-codex-sidebar', import.meta.url)), join(modules, 'dsh-codex-sidebar'), { recursive: true })
    await cp(fileURLToPath(new URL('../plugins/kxxy-host/package.json', import.meta.url)), join(modules, 'kxxy-host', 'package.json'))
    await cp(fileURLToPath(new URL('../plugins/kxxy-host/lib/auth.mjs', import.meta.url)), join(modules, 'kxxy-host', 'lib', 'auth.mjs'))
    const cwd = await realpath(root)
    process.env.KXXY_CODEX_HOME = join(root, 'home')
    delete process.env.KXXY_CODEX_BIN
    delete process.env.KXXY_ENGINE_ROOT
    let handler
    const ctx = {
      get: (name) => name === 'connection'
        ? { admit: (request) => request.headers.cookie === 'owner=test' ? { peer: {} } : { rejection: 401 } }
        : name === 'sessions' ? { get: (id) => id === 'session' ? { header: { cwd } } : undefined } : null,
      webServer: { register: (route) => { handler = route.handler; return () => {} } },
      effect: (fn) => { cleanups.push(fn()); return () => {} },
    }
    const plugin = await import(pathToFileURL(join(modules, 'dsh-codex-sidebar', 'lib', 'index.js')).href)
    plugin.apply(ctx)
    server = createServer((req, res) => handler(req, res))
    const origin = await listen(server)
    const stateUrl = `${origin}/kxxy/codex/bootstrap?sessionId=session`
    const owner = { cookie: 'owner=test' }
    assert.equal((await fetch(stateUrl)).status, 401)
    const bootstrap = await fetch(stateUrl, { headers: owner })
    assert.equal(bootstrap.status, 200)
    const initial = await bootstrap.json()
    assert.match(initial.nonce, /^[a-f0-9]{64}$/)
    const headers = { ...owner, origin, 'content-type': 'application/json', 'x-kxxy-nonce': initial.nonce }
    const modelInput = { sessionId: 'session', name: 'HTTP 模型', model: 'route-model', baseUrl: `${provider.origin}/v1`, apiKey: SECRET, apiFormat: 'chat-completions' }
    const post = (action, body, overrides = {}) => fetch(`${origin}/kxxy/codex${action}`, { method: 'POST', headers: { ...headers, ...overrides }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    assert.equal((await post('/models/save', modelInput, { cookie: '' })).status, 401)
    assert.equal((await post('/models/save', modelInput, { origin: 'https://untrusted.example' })).status, 403)
    assert.equal((await post('/models/save', modelInput, { 'x-kxxy-nonce': '' })).status, 403)
    assert.equal((await post('/models/save', modelInput, { 'sec-fetch-site': 'cross-site' })).status, 403)
    assert.notEqual((await post('/models/save', { ...modelInput, sessionId: 'unknown' })).status, 200)
    assert.equal((await post('/models/save', '[]')).status, 400)
    const saved = await post('/models/save', modelInput)
    assert.equal(saved.status, 200)
    const model = await saved.json()
    assert.equal(model.name, 'HTTP 模型')
    assert.equal(model.hasApiKey, true)
    assert.ok(!JSON.stringify(model).includes(SECRET))
    const created = await post('/thread/new', { sessionId: 'session', model: model.id, mode: 'chat', effort: '' })
    assert.equal(created.status, 200)
    const { thread } = await created.json()
    const sent = await post('/turn', { sessionId: 'session', ...input(thread, model, 'route-turn') })
    assert.equal(sent.status, 200)
    const accepted = await sent.json()
    assert.ok(accepted.turnId)
    let state
    await waitUntil(async () => {
      state = await (await fetch(stateUrl, { headers: owner })).json()
      const turn = state.threads.find((entry) => entry.id === thread.id)?.turns.find((entry) => entry.id === accepted.turnId)
      return turn?.status === 'completed'
    }, 'HTTP chat completion')
    assert.equal(provider.calls[0].headers.authorization, `Bearer ${SECRET}`)
    assert.ok(!JSON.stringify(state).includes(SECRET))
    assert.equal(state.health.agent, false)
    for (const action of ['/models/fetch', '/models/test']) {
      const configuration = { sessionId: 'session', id: model.id, apiKey: '' }
      assert.equal((await post(action, configuration, { cookie: '' })).status, 401)
      assert.equal((await post(action, configuration, { origin: 'https://untrusted.example' })).status, 403)
      assert.equal((await post(action, configuration, { 'x-kxxy-nonce': '' })).status, 403)
      assert.notEqual((await post(action, { ...configuration, sessionId: 'unknown' })).status, 200)
    }
    assert.equal(provider.calls.length, 1)
    provider.responses.push((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'route-model', name: '模型列表' }, { id: 'second-model', name: `Display ${SECRET}` }] }))
    })
    const fetched = await post('/models/fetch', { sessionId: 'session', id: model.id, apiKey: '' })
    assert.equal(fetched.status, 200)
    const catalog = await fetched.json()
    assert.equal(catalog.count, 2)
    assert.ok(catalog.models.some((entry) => entry.id === 'route-model'))
    assert.ok(!JSON.stringify(catalog).includes(SECRET))
    assert.equal(provider.calls[1].method, 'GET')
    assert.equal(provider.calls[1].url, '/v1/models')
    assert.equal(provider.calls[1].headers.authorization, `Bearer ${SECRET}`)
    provider.responses.push((_req, res) => completion(res, 'OK'))
    const tested = await post('/models/test', { sessionId: 'session', id: model.id, apiKey: '' })
    assert.equal(tested.status, 200)
    assert.equal((await tested.json()).preview, 'OK')
    assert.equal(provider.calls[2].url, '/v1/chat/completions')
    assert.equal(provider.calls[2].headers.authorization, `Bearer ${SECRET}`)
    assert.equal(provider.calls[2].body.model, 'route-model')
    assert.equal(provider.calls[2].body.stream, false)
    assert.equal(provider.calls[2].body.tools, undefined)
    assert.equal((await post('/models/delete', { sessionId: 'session', id: model.id }, { cookie: '' })).status, 401)
    assert.equal((await post('/models/delete', { sessionId: 'session', id: model.id }, { 'x-kxxy-nonce': '' })).status, 403)
    assert.notEqual((await post('/models/delete', { sessionId: 'unknown', id: model.id })).status, 200)
    assert.equal((await post('/models/delete', { sessionId: 'session', id: model.id })).status, 200)
    const afterDelete = await (await fetch(stateUrl, { headers: owner })).json()
    assert.equal(afterDelete.customModels.length, 0)
    assert.ok(afterDelete.history.some((entry) => entry.id === thread.id))
  } finally {
    if (server) await close(server)
    for (const dispose of cleanups) await dispose?.()
    await provider.close()
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

// 手机切后台最典型的两种断法：还没吐字就断（可以安全重发）、吐了半个字再断（不能重发）。
// 这条用例钉住的就是「重发的边界」—— 边界错了会重复执行工具命令，比超时严重得多。
test('首包前的网络错误重发一次，已产出内容后绝不重发', async () => {
  await fixture(async ({ service, provider }) => {
    const model = await addModel(service, provider.origin)
    const thread = await newThread(service, model)
    provider.responses.push((_req, res) => { res.destroy() })
    provider.responses.push((_req, res) => completion(res, '重试后成功'))
    const first = await service.send('session', input(thread, model, 'retry-request'))
    const recovered = await completedTurn(service, thread.id, first.turnId, 15000)
    assert.equal(recovered.status, 'completed')
    assert.equal(assistantText(recovered), '重试后成功')
    assert.equal(provider.calls.length, 2)

    const second = await newThread(service, model)
    provider.responses.push((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      res.write('data: {"choices":[{"delta":{"content":"半个字"}}]}\n\n')
      setTimeout(() => res.destroy(), 10)
    })
    const partial = await service.send('session', input(second, model, 'partial-request'))
    const failed = await completedTurn(service, second.id, partial.turnId, 15000)
    assert.notEqual(failed.status, 'completed')
    assert.equal(assistantText(failed), '半个字')
    assert.equal(provider.calls.length, 3)
  })
})
