import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexService } from '../plugins/dsh-codex-sidebar/lib/service.mjs'
import { CodexError } from '../plugins/dsh-codex-sidebar/lib/transport.mjs'
import { WorkspaceTools } from '../plugins/dsh-codex-sidebar/lib/workspace-tools.mjs'

const modelInput = { name: 'Local test model', model: 'fixture-model', baseUrl: 'https://fixture.invalid/v1', apiKey: 'private-fixture-key', apiFormat: 'chat-completions', engine: 'workspace' }
const json = (message, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ message, finish_reason }] }), { headers: { 'content-type': 'application/json' } })
const tool = (id, name, args) => json({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
const safeEnv = () => Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'codex-actions-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const cwd = await realpath(workspace)
  const calls = [], replies = []
  const options = { paths: { home: join(root, 'home') }, env: safeEnv(), resolveWorkspace: async (session) => { if (session !== 'session') throw new CodexError('session-invalid', 'wrong session'); return cwd }, fetchImpl: async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) })
    const next = replies.shift()
    if (!next) throw new Error('unexpected model request')
    return typeof next === 'function' ? next(options) : next
  } }
  const service = new CodexService(options)
  try {
    await service.load()
    const model = await service.saveModel(modelInput)
    await fn({ root, cwd, model, service, calls, replies, options })
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}
async function until(check, label = 'operation', timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 8)) }
  assert.fail(`Timed out: ${label}`)
}
async function complete(service, threadId, turnId) {
  let result
  await until(() => {
    const thread = service.threads.get(threadId)
    result = thread?.turns.find(turn => turn.id === turnId)
    return result && result.status !== 'inProgress' && !service.running.has(threadId)
  }, 'terminal turn')
  await service.queue
  return result
}
async function send(service, thread, model, requestId, text, mode = 'chat') {
  const accepted = await service.send('session', { threadId: thread.id, model: model.id, effort: '', mode, requestId, text, files: [] })
  return complete(service, thread.id, accepted.turnId)
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

for (const invalidation of ['saveModel', 'revokeAccess']) {
  test(`HTTP full access revoked by ${invalidation} while awaiting upstream cannot execute late tools`, async (t) => fixture(async ({ service, model, replies, calls, cwd }) => {
    const { thread } = await service.create('session', { model: model.id, mode: 'agent', effort: '' })
    const challenge = await service.prepareAccess('session', { threadId: thread.id, mode: 'full' })
    await service.applyAccess('session', { threadId: thread.id, mode: 'full', token: challenge.token })
    const entered = deferred(), response = deferred()
    let signal
    replies.push(options => { signal = options.signal; entered.resolve(); return response.promise })
    const execute = WorkspaceTools.prototype.execute
    const dispatched = []
    t.mock.method(WorkspaceTools.prototype, 'execute', function (...args) {
      dispatched.push(args[0])
      return execute.apply(this, args)
    })
    const capture = t.mock.method(WorkspaceTools.prototype, 'capture', async () => assert.fail('revoked turn must never spawn a command'))
    const approval = t.mock.method(service, 'askCustomApproval', async () => assert.fail('revoked turn must not request approval'))
    const accepted = await service.send('session', { threadId: thread.id, model: model.id, effort: '', mode: 'agent', requestId: `late-${invalidation}`, text: 'wait for tools', files: [] })
    await entered.promise
    try {
      assert.equal(signal.aborted, false)
      if (invalidation === 'saveModel') await service.saveModel({ ...modelInput, id: model.id, name: 'Updated fixture model' })
      else service.revokeAccess(thread.id)
      assert.equal(signal.aborted, true)
      assert.equal(service.accessView(service.bindings.get(thread.id)).mode, 'approval')
    } finally {
      response.resolve(json({ role: 'assistant', content: '', tool_calls: [
        { id: 'late-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'late.txt', content: 'must not exist' }) } },
        { id: 'late-command', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'fixture-command-must-not-run' }) } },
      ] }, 'tool_calls'))
    }
    const result = await complete(service, thread.id, accepted.turnId)
    assert.equal(result.status, 'interrupted')
    assert.deepEqual(dispatched, [])
    assert.equal(capture.mock.callCount(), 0)
    assert.equal(approval.mock.callCount(), 0)
    assert.equal(service.approvals.size, 0)
    assert.equal(calls.length, 1)
    await assert.rejects(readFile(join(cwd, 'late.txt')), { code: 'ENOENT' })
  }))
}

test('published edit branch rejects ordinary sends and dispatches its requestId only once', async () => fixture(async ({ service, model, replies, calls }) => {
  const { thread } = await service.create('session', { model: model.id, mode: 'chat', effort: '' })
  replies.push(json({ content: 'source reply' }))
  const source = await send(service, thread, model, 'branch-source', 'source question')
  const entered = deferred(), release = deferred()
  const originalCreate = service.createCustom
  let branch
  service.createCustom = async function (...args) {
    const created = await originalCreate.apply(this, args)
    branch = created.thread
    entered.resolve()
    await release.promise
    return created
  }
  replies.push(json({ content: 'edited reply' }))
  const request = { threadId: thread.id, turnId: source.id, text: 'edited question', requestId: 'reserved-edit' }
  const action = service.messageAction('session', request, 'edit')
  const outcome = action.then(value => ({ value }), error => ({ error }))
  await entered.promise
  const attempts = []
  try {
    assert.ok(service.threads.has(branch.id))
    assert.ok(service.bindings.has(branch.id))
    for (const requestId of ['ordinary-send', request.requestId]) {
      attempts.push(await service.send('session', { threadId: branch.id, model: model.id, effort: '', mode: 'chat', requestId, text: 'racing ordinary send', files: [] }).then(value => ({ value }), error => ({ error })))
    }
  } finally { release.resolve(); service.createCustom = originalCreate }
  const settled = await outcome
  if (settled.error) throw settled.error
  const edited = settled.value
  const turn = await complete(service, edited.thread.id, edited.turnId)
  for (const attempt of attempts) assert.equal(attempt.error?.code, 'busy', 'ordinary callers cannot enter a reserved branch, even with the action requestId')
  assert.equal(turn.status, 'completed')
  assert.equal(calls.length, 2)
  assert.ok(!JSON.stringify(calls).includes('racing ordinary send'))
  const binding = service.bindings.get(branch.id)
  assert.equal(binding.requests.filter(entry => entry.id === request.requestId).length, 1)
  assert.equal(service.threads.get(branch.id).turns.filter(entry => !entry.imported).length, 1)
  const repeated = await service.messageAction('session', request, 'edit')
  assert.equal(repeated.thread.id, branch.id)
  assert.equal(repeated.turnId, edited.turnId)
  assert.equal(calls.length, 2)
}))

test('editing an HTTP message branches before the selected turn and does not replay later messages', async () => fixture(async ({ service, model, replies, calls }) => {
  const { thread } = await service.create('session', { model: model.id, mode: 'chat', engine: 'workspace', effort: '' })
  replies.push(json({ content: 'first reply' }))
  await send(service, thread, model, 'first', 'first question')
  replies.push(json({ content: 'old second reply' }))
  const second = await send(service, thread, model, 'second', 'old second question')
  replies.push(json({ content: 'third reply' }))
  await send(service, thread, model, 'third', 'third question')
  const original = structuredClone(service.threads.get(thread.id))
  replies.push(json({ content: 'edited reply' }))
  const request = { threadId: thread.id, turnId: second.id, itemId: second.items.find(item => item.type === 'userMessage').id, text: 'new second question', requestId: 'edit-second' }
  const [edited, repeated] = await Promise.all([service.messageAction('session', request, 'edit'), service.messageAction('session', request, 'edit')])
  assert.equal(edited.thread.id, repeated.thread.id)
  assert.notEqual(edited.thread.id, thread.id)
  assert.equal((await complete(service, edited.thread.id, edited.turnId)).status, 'completed')
  assert.deepEqual(service.threads.get(thread.id), original)
  const payload = calls.at(-1).payload
  assert.ok(JSON.stringify(payload).includes('first reply'))
  assert.ok(JSON.stringify(payload).includes('new second question'))
  assert.ok(!JSON.stringify(payload).includes('old second reply'))
  assert.ok(!JSON.stringify(payload).includes('third question'))
  assert.equal(calls.length, 4)
  await assert.rejects(service.messageAction('session', { ...request, text: 'different text' }, 'edit'), { code: 'action-reused' })
  assert.equal(service.threads.get(edited.thread.id).turns[0].imported, true)
  assert.equal(service.accessView(service.bindings.get(edited.thread.id)).mode, 'approval')
}))

test('full access is one-thread, confirmed, nonpersistent and not inherited by edited branches', async () => fixture(async ({ service, model, replies, options }) => {
  const { thread } = await service.create('session', { model: model.id, mode: 'agent', effort: '' })
  await assert.rejects(service.applyAccess('session', { threadId: thread.id, mode: 'full' }))
  assert.equal(service.accessView(service.bindings.get(thread.id)).mode, 'approval')
  const prepared = await service.prepareAccess('session', { threadId: thread.id, mode: 'full' })
  await service.applyAccess('session', { threadId: thread.id, mode: 'full', token: prepared.token })
  assert.equal(service.accessView(service.bindings.get(thread.id)).mode, 'full')
  const other = await service.create('session', { model: model.id, mode: 'agent', effort: '' })
  await assert.rejects(service.applyAccess('session', { threadId: other.thread.id, mode: 'full', token: prepared.token }))
  assert.equal(service.accessView(service.bindings.get(other.thread.id)).mode, 'approval')
  replies.push(json({ content: 'original answer' }))
  const original = await send(service, thread, model, 'source', 'original', 'agent')
  replies.push(json({ content: 'branch answer' }))
  const branch = await service.messageAction('session', { threadId: thread.id, turnId: original.id, text: 'edited', requestId: 'edited' }, 'edit')
  await complete(service, branch.thread.id, branch.turnId)
  assert.equal(service.accessView(service.bindings.get(branch.thread.id)).mode, 'approval')
  const restarted = new CodexService(options)
  try { await restarted.load(); assert.equal(restarted.accessView(restarted.bindings.get(thread.id)).mode, 'approval') } finally { await restarted.dispose() }
}))

test('read-only HTTP tools exclude writes and commands and reject provider attempts', async () => fixture(async ({ service, model, replies, calls, cwd }) => {
  const { thread } = await service.create('session', { model: model.id, mode: 'agent', effort: '' })
  await service.applyAccess('session', { threadId: thread.id, mode: 'readonly' })
  replies.push(tool('try-write', 'write_file', { path: 'unauthorized.txt', content: 'bad' }))
  const result = await send(service, thread, model, 'readonly-attempt', 'try writing', 'agent')
  assert.equal(result.status, 'failed')
  const names = calls[0].payload.tools.map(entry => entry.function.name)
  assert.ok(names.includes('read_file'))
  assert.ok(!names.includes('write_file'))
  assert.ok(!names.includes('run_command'))
  await assert.rejects(readFile(join(cwd, 'unauthorized.txt')), { code: 'ENOENT' })
  assert.equal(service.approvals.size, 0)
}))

test('retry uses completed tool results with tools disabled and keeps original writes untouched', async () => fixture(async ({ service, model, replies, calls, cwd }) => {
  const { thread } = await service.create('session', { model: model.id, mode: 'agent', effort: '' })
  const prepared = await service.prepareAccess('session', { threadId: thread.id, mode: 'full' })
  await service.applyAccess('session', { threadId: thread.id, mode: 'full', token: prepared.token })
  replies.push(tool('write-once', 'write_file', { path: 'once.txt', content: 'one write' }), json({ content: 'old final answer' }))
  const turn = await send(service, thread, model, 'write-source', 'create once.txt', 'agent')
  assert.equal(turn.status, 'completed')
  assert.equal(await readFile(join(cwd, 'once.txt'), 'utf8'), 'one write')
  replies.push(json({ content: 'new wording only' }))
  const result = await service.messageAction('session', { threadId: thread.id, turnId: turn.id, requestId: 'retry-write' }, 'retry')
  assert.equal((await complete(service, result.thread.id, result.turnId)).status, 'completed')
  assert.equal(calls.length, 3)
  const retried = calls.at(-1).payload
  assert.equal(retried.tools, undefined)
  assert.ok(retried.messages.some(message => message.role === 'tool'))
  assert.ok(!JSON.stringify(retried.messages).includes('old final answer'))
  assert.equal(service.bindings.get(result.thread.id).replyOnly, true)
  assert.equal(service.bindings.get(result.thread.id).mode, 'chat')
  assert.equal(await readFile(join(cwd, 'once.txt'), 'utf8'), 'one write')
  const snapshot = JSON.stringify(await service.snapshot('session'))
  assert.ok(!snapshot.includes('providerMessages'))
  assert.ok(!snapshot.includes('private-fixture-key'))
}))

test('controlled writes can be reverted, but a conflicting later edit changes no file', async () => fixture(async ({ service, model, replies, cwd }) => {
  await writeFile(join(cwd, 'existing.txt'), 'before')
  const { thread } = await service.create('session', { model: model.id, mode: 'agent', effort: '' })
  const challenge = await service.prepareAccess('session', { threadId: thread.id, mode: 'full' })
  await service.applyAccess('session', { threadId: thread.id, mode: 'full', token: challenge.token })
  replies.push(tool('update', 'write_file', { path: 'existing.txt', content: 'after' }), json({ content: 'written' }))
  const turn = await send(service, thread, model, 'write', 'change text', 'agent')
  assert.equal(turn.status, 'completed')
  assert.equal((await service.turnUndo(service.bindings.get(thread.id), turn)).available, true)
  const preview = await service.previewChanges('session', { threadId: thread.id, turnId: turn.id })
  assert.ok(preview.token)
  await writeFile(join(cwd, 'existing.txt'), 'later edit')
  const conflict = await service.revertChanges('session', { threadId: thread.id, turnId: turn.id, token: preview.token, requestId: 'undo-conflict' })
  assert.equal(conflict.ok, false)
  assert.equal(await readFile(join(cwd, 'existing.txt'), 'utf8'), 'later edit')
  await writeFile(join(cwd, 'existing.txt'), 'after')
  const fresh = await service.previewChanges('session', { threadId: thread.id, turnId: turn.id })
  const undone = await service.revertChanges('session', { threadId: thread.id, turnId: turn.id, token: fresh.token, requestId: 'undo-now' })
  assert.equal(undone.ok, true)
  assert.equal(await readFile(join(cwd, 'existing.txt'), 'utf8'), 'before')
}))

test('busy turns reject access changes, edit and retry without dispatching another request', async () => fixture(async ({ service, model, replies, calls }) => {
  const { thread } = await service.create('session', { model: model.id, mode: 'chat', effort: '' })
  let release
  replies.push(() => new Promise(resolve => { release = resolve }))
  const accepted = await service.send('session', { threadId: thread.id, model: model.id, effort: '', mode: 'chat', text: 'wait', requestId: 'waiting' })
  await until(() => !!release)
  await assert.rejects(service.applyAccess('session', { threadId: thread.id, mode: 'approval' }), { code: 'busy' })
  await assert.rejects(service.messageAction('session', { threadId: thread.id, turnId: accepted.turnId, text: 'edit', requestId: 'blocked' }, 'edit'), { code: 'busy' })
  assert.equal(calls.length, 1)
  release(json({ content: 'done' }))
  await complete(service, thread.id, accepted.turnId)
}))

class NativeTransport extends EventEmitter {
  constructor(cwd) { super(); this.cwd = cwd; this.closed = false; this.calls = []; this.serial = 0; this.turns = [] }
  async start() {}
  async request(method, params = {}) {
    this.calls.push({ method, params })
    if (method === 'account/read') return { account: { type: 'apiKey' }, requiresOpenaiAuth: true }
    if (method === 'model/list') return { data: [{ id: 'native-model', model: 'wire-model', displayName: 'Native model', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }
    if (method === 'thread/start') return { thread: { id: `native-${++this.serial}`, cwd: this.cwd, status: { type: 'idle' }, turns: [] } }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: params.threadId, cwd: this.cwd, status: { type: 'idle' }, turns: [] } }
    if (method === 'thread/turns/list') return { data: [...this.turns].reverse(), nextCursor: null }
    if (method === 'thread/fork') return { thread: { id: `fork-${++this.serial}`, cwd: this.cwd, status: { type: 'idle' }, turns: [] } }
    if (method === 'turn/start') return { turn: { id: `turn-${++this.serial}`, status: 'inProgress', items: [] } }
    return {}
  }
  respond() {}
  refuse() {}
  stop() { this.closed = true }
}

test('native send revalidates transport and authority after awaiting the request ledger save', async (t) => {
  for (const invalidation of ['revokeAccess', 'cwd']) await t.test(invalidation, async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-native-ledger-'))
    const cwd = await realpath(root)
    await mkdir(join(root, 'other-workspace'))
    const otherCwd = await realpath(join(root, 'other-workspace'))
    let currentCwd = cwd
    const rpc = new NativeTransport(cwd), replacement = new NativeTransport(cwd)
    const service = new CodexService({ paths: { home: join(root, 'home'), executable: process.execPath }, env: safeEnv(), resolveWorkspace: async () => currentCwd, transportFactory: () => rpc, probe: async () => ({ agent: false, chat: false }), nativeProbe: async () => ({ available: true }), fetchImpl: () => assert.fail('native send must not use HTTP') })
    const entered = deferred(), release = deferred()
    const originalSave = service.save
    let pending, intercepted = 0
    try {
      await service.connect(true)
      const { thread } = await service.create('session', { model: 'native-model', effort: 'high', mode: 'agent', engine: 'native' })
      const challenge = await service.prepareAccess('session', { threadId: thread.id, mode: 'full' })
      await service.applyAccess('session', { threadId: thread.id, mode: 'full', token: challenge.token })
      const requestId = `native-ledger-${invalidation}`
      service.save = async function (...args) {
        if (!intercepted && this.bindings.get(thread.id)?.requests?.some(entry => entry.id === requestId)) {
          intercepted += 1
          entered.resolve()
          await release.promise
        }
        return originalSave.apply(this, args)
      }
      const input = { threadId: thread.id, model: 'native-model', effort: 'high', mode: 'agent', requestId, text: 'must not reach replacement transport', files: [] }
      pending = service.send('session', input).then(value => ({ value }), error => ({ error }))
      await until(() => intercepted === 1, 'native request ledger save')
      await entered.promise
      assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 0)
      service.transport = replacement
      service.transportGeneration += 1
      if (invalidation === 'revokeAccess') service.revokeAccess(thread.id)
      else currentCwd = otherCwd
      release.resolve()
      const settled = await pending
      assert.equal(replacement.calls.filter(call => call.method === 'turn/start').length, 0, `${invalidation}: stale send must not submit to the replacement RPC`)
      assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 0)
      assert.ok(settled.error, `${invalidation}: pre-dispatch invalidation must reject send`)
      assert.equal(intercepted, 1)
      await assert.rejects(service.send('session', input))
      assert.equal(replacement.calls.filter(call => call.method === 'turn/start').length, 0)
    } finally {
      release.resolve()
      if (pending) await pending
      service.save = originalSave
      await service.dispose()
      rpc.stop()
      replacement.stop()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})

test('native edit uses an inclusive previous-turn fork and new branches do not inherit never approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-native-action-'))
  const cwd = await realpath(root)
  const rpc = new NativeTransport(cwd)
  const service = new CodexService({ paths: { home: join(root, 'home'), executable: process.execPath }, env: safeEnv(), resolveWorkspace: async () => cwd, transportFactory: () => rpc, probe: async () => ({ agent: false, chat: false }), nativeProbe: async () => ({ available: true }), fetchImpl: () => assert.fail('native branch must not call the HTTP assistant') })
  try {
    await service.connect(true)
    const { thread } = await service.create('session', { model: 'native-model', effort: 'high', mode: 'agent', engine: 'native' })
    rpc.turns = ['one', 'two', 'three'].map(id => ({ id, status: 'completed', items: [{ id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: id }] }, { id: `answer-${id}`, type: 'agentMessage', text: `reply ${id}` }] }))
    service.threads.get(thread.id).turns = structuredClone(rpc.turns)
    const permission = await service.prepareAccess('session', { threadId: thread.id, mode: 'full' })
    await service.applyAccess('session', { threadId: thread.id, mode: 'full', token: permission.token })
    const branch = await service.messageAction('session', { threadId: thread.id, turnId: 'two', itemId: 'user-two', text: 'edited two', requestId: 'edit-native' }, 'edit')
    const fork = rpc.calls.find(call => call.method === 'thread/fork').params
    assert.equal(fork.lastTurnId, 'one')
    assert.equal(fork.threadId, thread.id)
    assert.equal(fork.approvalPolicy, 'untrusted')
    const turn = rpc.calls.filter(call => call.method === 'turn/start').at(-1).params
    assert.equal(turn.threadId, branch.thread.id)
    assert.equal(turn.approvalPolicy, 'untrusted')
    assert.equal(turn.input[0].text, 'edited two')
    assert.equal(service.accessView(service.bindings.get(branch.thread.id)).mode, 'approval')
    await assert.rejects(service.messageAction('session', { threadId: thread.id, turnId: 'one', requestId: 'retry-native' }, 'retry'), { code: 'retry-unsupported' })
    await assert.rejects(service.applyAccess('session', { threadId: thread.id, mode: 'readonly' }), { code: 'access-unsupported' })
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
