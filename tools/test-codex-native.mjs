import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexService } from '../plugins/dsh-codex-sidebar/lib/service.mjs'
import { CodexError } from '../plugins/dsh-codex-sidebar/lib/transport.mjs'
import { nativeProviderParameters } from '../plugins/dsh-codex-sidebar/lib/native-models.mjs'

const SECRET = 'native-provider-private-key'
const ENV_SECRET = 'native-unrelated-account-key'
const ENV_SAFE_KEYS = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']
const safeEnv = () => ({
  ...Object.fromEntries(ENV_SAFE_KEYS.filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]])),
  OPENAI_API_KEY: ENV_SECRET,
  NODE_OPTIONS: '--require untrusted.cjs',
})

const MODELS = [{ id: 'gpt-5-codex', model: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }]

/** Newline JSON-RPC server double: records every request and resolves protocol responses. */
class FakeNativeTransport extends EventEmitter {
  constructor(cwd) {
    super()
    this.closed = false
    this.calls = []
    this.responses = []
    this.threads = 0
    this.turns = 0
    this.cwd = cwd
    this.account = { account: { type: 'apiKey' }, requiresOpenaiAuth: true }
    this.models = MODELS
  }
  async start() { return {} }
  async request(method, params = {}) {
    this.calls.push({ method, params })
    if (method === 'account/read') return this.account
    if (method === 'model/list') return { data: this.models }
    if (method === 'thread/start') return { thread: { id: `native-thread-${++this.threads}`, cwd: params.cwd, status: { type: 'idle' }, turns: [] } }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: params.threadId, cwd: params.cwd ?? this.cwd, status: { type: 'idle' }, turns: [] } }
    if (method === 'thread/turns/list') return { data: [], nextCursor: null }
    if (method === 'turn/start') return { turn: { id: `turn-${++this.turns}`, status: 'inProgress', items: [] } }
    if (method === 'turn/interrupt') return {}
    return {}
  }
  respond(id, result) { this.responses.push({ id, result }) }
  refuse(id) { this.responses.push({ id, refused: true }) }
  stop() { this.closed = true }
  call(method) { return this.calls.filter((entry) => entry.method === method) }
  replyTo(id, result) {
    const entry = this.responses.find((response) => response.id === id)
    assert.ok(entry, `expected a protocol response for ${id}`)
    if (result) assert.deepEqual(entry.result, result)
    return entry
  }
  refused(id) {
    const entry = this.responses.find((response) => response.id === id)
    return entry?.refused === true
  }
}

const nativeAppHealth = () => ({
  available: true, executionMode: 'app-process', permissionMode: 'app-process', sandboxVerified: false,
  approvalPolicies: ['untrusted'], version: '0.167.0', manifestVerified: true, appServerVerified: true,
  shellVerified: true, uid: 10398, selinuxContext: 'u:r:untrusted_app:s0:c512,c768', shell: join(tmpdir(), 'runtime', 'bin', 'bash'), reason: null,
})

async function nativeFixture(fn, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-native-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const cwd = await realpath(workspace)
  const transport = new FakeNativeTransport(cwd)
  const probes = { workspace: 0, native: 0 }
  const service = new CodexService({
    paths: { home, executable: join(root, 'bin', 'codex') },
    env: safeEnv(),
    resolveWorkspace: async (id) => { if (id !== 'session') throw new CodexError('session-invalid', 'invalid session'); return cwd },
    probe: async () => { probes.workspace += 1; return { version: '0.167.0', agent: false, chat: false, reason: '未验证本机沙箱', chatReason: '对话模式不可用' } },
    nativeProbe: async (paths, { rpc } = {}) => { probes.native += 1; assert.ok(rpc, 'native probe must receive the app-server rpc'); return nativeAppHealth() },
    transportFactory: () => transport,
    fetchImpl: async () => assert.fail('native bindings must never call the HTTP assistant'),
    ...options,
  })
  try {
    await service.connect(true)
    assert.equal(probes.native, 1, 'connect must probe the native app capability exactly once')
    await fn({ root, home, cwd, service, transport, probes })
  } finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function until(check, label, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)) }
  assert.fail(`Timed out waiting for ${label}`)
}

async function terminal(service, threadId, turnId) {
  let turn
  await until(async () => {
    const snapshot = await service.snapshot('session')
    const thread = snapshot.threads.find((entry) => entry.id === threadId)
    turn = thread?.turns.find((entry) => entry.id === turnId)
    return turn && turn.status !== 'inProgress' && !thread.pending
  }, 'terminal native turn')
  await service.queue
  return turn
}

function completeTurn(transport, threadId, turnId, output = '原生回复已完成') {
  transport.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'agent-item', delta: output } })
  transport.emit('notification', { method: 'item/completed', params: { threadId, turnId, item: { id: 'agent-item', type: 'agentMessage', text: output } } })
  transport.emit('notification', { method: 'turn/completed', params: { threadId, turnId, turn: { id: turnId, status: 'completed' } } })
}

test('native connect keeps app-process health separate from unverified sandbox isolation', async () => {
  await nativeFixture(async ({ service, cwd }) => {
    const status = service.status()
    assert.equal(status.health.phase, 'connected')
    assert.equal(status.health.agent, false, 'app-process mode must not claim sandbox isolation')
    assert.equal(status.health.nativeApp.available, true)
    assert.equal(status.health.nativeApp.executionMode, 'app-process')
    assert.equal(status.health.nativeApp.sandboxVerified, false)
    assert.equal(status.health.nativeApp.version, '0.167.0')
    const snapshot = await service.snapshot('session')
    assert.equal(snapshot.environment.permissionMode, 'app-process')
    assert.equal(snapshot.cwd, cwd)
  })
})

test('native official model threads start with the fixed app-process contract', async () => {
  await nativeFixture(async ({ service, transport, cwd }) => {
    const { thread, binding } = await service.create('session', { model: 'gpt-5-codex', effort: 'medium', mode: 'agent', engine: 'native', approvalPolicy: 'untrusted' })
    assert.equal(binding.engine, 'native')
    assert.equal(binding.source, 'native')
    assert.equal(binding.approvalPolicy, 'untrusted')
    assert.equal(binding.executionMode, 'app-process')
    assert.equal(binding.permissionMode, 'app-process')
    const start = transport.call('thread/start')[0].params
    assert.equal(start.model, 'gpt-5-codex')
    assert.equal(start.modelProvider, 'openai')
    assert.equal(start.approvalPolicy, 'untrusted')
    assert.equal(start.approvalsReviewer, 'user')
    assert.equal(start.sandbox, 'danger-full-access')
    assert.equal(start.cwd, cwd)
    assert.equal(start.config, undefined, 'official threads must not carry provider config overrides')
    assert.equal(start.effort, undefined, 'effort is a per-turn override, not a thread start field')

    const accepted = await service.send('session', { threadId: thread.id, requestId: 'native-req-1', text: '检查当前目录', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' })
    const turnStart = transport.call('turn/start')[0].params
    assert.equal(turnStart.model, 'gpt-5-codex')
    assert.equal(turnStart.effort, 'medium')
    assert.equal(turnStart.approvalPolicy, 'untrusted')
    assert.equal(turnStart.approvalsReviewer, 'user')
    assert.deepEqual(turnStart.sandboxPolicy, { type: 'dangerFullAccess' })
    assert.equal(turnStart.cwd, cwd)
    assert.equal(turnStart.clientUserMessageId, 'native-req-1')
    assert.deepEqual(turnStart.input, [{ type: 'text', text: '检查当前目录', text_elements: [] }])
    for (const field of ['modelProvider', 'config', 'sandbox', 'providerId', 'providerRevision', 'source']) {
      assert.equal(turnStart[field], undefined, `turn/start must not carry ${field}`)
    }
    assert.equal(accepted.turnId, 'turn-1')

    // While the turn is live: concurrent sends are busy, same request id is idempotent,
    // and submitted records never replay blindly.
    await assert.rejects(service.send('session', { threadId: thread.id, requestId: 'other-req', text: '并发请求', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' }), { code: 'busy' })
    assert.deepEqual(await service.send('session', { threadId: thread.id, requestId: 'native-req-1', text: '重复请求', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' }), accepted)
    // create() returns sanitized copies; the live binding carries the request ledger.
    service.bindings.get(thread.id).requests.push({ id: 'submitted-req', outcome: 'submitted', at: Date.now() })
    await assert.rejects(service.send('session', { threadId: thread.id, requestId: 'submitted-req', text: '结果未知', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' }), { code: 'outcome-unknown' })

    completeTurn(transport, thread.id, accepted.turnId)
    const turn = await terminal(service, thread.id, accepted.turnId)
    assert.equal(turn.status, 'completed')
    assert.equal(turn.items.find((item) => item.type === 'agentMessage').text, '原生回复已完成')
    const snapshot = await service.snapshot('session')
    const stored = snapshot.threads.find((entry) => entry.id === thread.id)
    assert.equal(stored.engine, 'native')
    assert.equal(stored.environment.sandboxVerified, false)
    assert.ok(!JSON.stringify(snapshot).includes(ENV_SECRET))
  })
})

test('native official sends reject model, effort, mode and policy changes plus lost capability', async () => {
  await nativeFixture(async ({ service, transport }) => {
    const { thread } = await service.create('session', { model: 'gpt-5-codex', effort: 'medium', mode: 'agent', engine: 'native' })
    await assert.rejects(service.send('session', { threadId: thread.id, requestId: 'r1', text: '未知模型', model: 'missing-model', effort: 'medium', mode: 'agent' }), { code: 'model-change' })
    await assert.rejects(service.send('session', { threadId: thread.id, requestId: 'r2', text: '未知强度', model: 'gpt-5-codex', effort: 'xhigh', mode: 'agent' }), { code: 'effort-invalid' })
    await assert.rejects(service.send('session', { threadId: thread.id, requestId: 'r3', text: '切换模式', model: 'gpt-5-codex', effort: 'medium', mode: 'chat' }), { code: 'mode-change' })
    await service.saveModel({ name: '原生自定义', model: 'remote-model', baseUrl: 'https://provider.example/v1', apiKey: SECRET, apiFormat: 'responses', engine: 'native' })
    const custom = [...service.customModels.models.keys()][0]
    await assert.rejects(service.send('session', { threadId: thread.id, requestId: 'r4', text: '换服务商', model: custom, effort: '', mode: 'agent' }), { code: 'model-change' })
    await assert.rejects(service.create('session', { model: 'gpt-5-codex', effort: 'medium', mode: 'agent', engine: 'native', approvalPolicy: 'never' }), { code: 'approval-policy' })
    await assert.rejects(service.create('session', { model: 'gpt-5-codex', effort: 'medium', mode: 'chat', engine: 'native' }), { code: 'mode-invalid' })
    assert.equal(transport.call('turn/start').length, 0, 'rejected sends must not start turns')
    assert.equal(service.bindings.get(thread.id).model, 'gpt-5-codex')
    service.health = { ...service.health, nativeApp: { ...service.health.nativeApp, available: false, reason: '验证已失效' } }
    await assert.rejects(service.send('session', { threadId: thread.id, requestId: 'r5', text: '能力丢失', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' }), { code: 'execution-unavailable' })
    assert.equal(transport.call('turn/start').length, 0)
  })
})

test('native official threads require Codex login while native providers do not', async () => {
  await nativeFixture(async ({ service }) => {
    service.transport.account = { account: null, requiresOpenaiAuth: true }
    service.account = { type: null, requiresAuth: true, loggedIn: false }
    await assert.rejects(service.create('session', { model: 'gpt-5-codex', effort: 'medium', mode: 'agent', engine: 'native' }), { code: 'login-required' })
    await service.saveModel({ name: '免登录服务', model: 'remote-model', baseUrl: 'https://provider.example/v1', apiKey: SECRET, apiFormat: 'responses', engine: 'native' })
    const custom = [...service.customModels.models.keys()][0]
    const { binding } = await service.create('session', { model: custom, effort: '', mode: 'agent', engine: 'native' })
    assert.equal(binding.source, 'native-custom')
    assert.equal(binding.providerId, custom)
  })
})

test('native custom providers bind their Responses config server-side only', async () => {
  await nativeFixture(async ({ service, transport, cwd, home }) => {
    const saved = await service.saveModel({ name: '原生自定义', model: 'remote-model', baseUrl: 'https://provider.example/v1', apiKey: SECRET, apiFormat: 'responses', engine: 'native' })
    const { thread, binding } = await service.create('session', { model: saved.id, effort: 'high', mode: 'agent', engine: 'native' })
    assert.equal(binding.source, 'native-custom')
    const start = transport.call('thread/start')[0].params
    assert.equal(start.model, 'remote-model')
    assert.equal(start.modelProvider, `kxxy_${saved.id}`)
    const providerConfig = start.config[`model_providers.kxxy_${saved.id}`]
    assert.equal(providerConfig.base_url, 'https://provider.example/v1')
    assert.equal(providerConfig.wire_api, 'responses')
    assert.equal(providerConfig.experimental_bearer_token, SECRET, 'the bound provider key must reach the CLI thread config')
    assert.equal(providerConfig.requires_openai_auth, false)

    const accepted = await service.send('session', { threadId: thread.id, requestId: 'custom-req-1', text: '列出文件', model: saved.id, effort: 'high', mode: 'agent' })
    const turnStart = transport.call('turn/start')[0].params
    assert.equal(turnStart.model, 'remote-model')
    assert.equal(turnStart.effort, 'high')
    assert.equal(turnStart.modelProvider, undefined, 'TurnStart must reuse the provider bound at thread start')
    assert.equal(turnStart.config, undefined, 'TurnStart must not resend provider config')
    assert.ok(!JSON.stringify(turnStart).includes(SECRET), 'turn requests must not carry the provider key')
    completeTurn(transport, thread.id, accepted.turnId)
    await terminal(service, thread.id, accepted.turnId)

    // Per-turn effort override is allowed for custom providers; model/provider are not.
    const second = await service.send('session', { threadId: thread.id, requestId: 'custom-req-2', text: '继续', model: saved.id, effort: 'low', mode: 'agent' })
    assert.equal(transport.call('turn/start')[1].params.effort, 'low')
    assert.equal(service.bindings.get(thread.id).effort, 'low')
    assert.equal(second.turnId, 'turn-2')
    completeTurn(transport, thread.id, second.turnId, '自定义服务回复')
    const finished = await terminal(service, thread.id, second.turnId)
    assert.equal(finished.status, 'completed')
    assert.equal(finished.items.find((item) => item.type === 'agentMessage').text, '自定义服务回复')
    const rival = await service.saveModel({ name: '另一个原生服务', model: 'other-model', baseUrl: 'https://other.example/v1', apiKey: SECRET, apiFormat: 'responses', engine: 'native' })
    await assert.rejects(service.send('session', { threadId: thread.id, requestId: 'custom-req-3', text: '换模型', model: rival.id, effort: '', mode: 'agent' }), { code: 'model-change' })
    await assert.rejects(service.send('session', { threadId: thread.id, requestId: 'custom-req-4', text: '官方模型', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' }), { code: 'model-change' })

    const persisted = await readFile(join(home, 'sidebar-threads.json'), 'utf8')
    assert.ok(!persisted.includes(SECRET), 'thread persistence must not store provider keys')
    const snapshot = await service.snapshot('session')
    assert.ok(!JSON.stringify(snapshot).includes(SECRET), 'snapshots must scrub provider keys')
    assert.ok(!JSON.stringify(service.threads.get(thread.id)).includes(SECRET), 'thread records must not carry provider keys')
    assert.ok(!JSON.stringify(service.bindings.get(thread.id)).includes(SECRET), 'bindings must not carry provider keys')
  })
})

test('native approvals flow through the CLI contract with one-time decisions', async () => {
  await nativeFixture(async ({ service, transport, cwd }) => {
    const { thread } = await service.create('session', { model: 'gpt-5-codex', effort: 'medium', mode: 'agent', engine: 'native' })
    const requestId = 'approval-req-1'
    const accepted = await service.send('session', { threadId: thread.id, requestId, text: '运行命令', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' })
    // A stray approval before its turn is live must be cancelled, not queued.
    transport.emit('request', { id: 'srv-early', method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: 'turn-missing', itemId: 'item-0', command: 'rm -rf /', cwd, startedAtMs: 1 } })
    assert.ok(transport.refused('srv-early') === false, 'early approval is answered, not refused')
    transport.replyTo('srv-early', { decision: 'cancel' })

    const commandApproval = { threadId: thread.id, turnId: accepted.turnId, itemId: 'item-1', command: 'git status --short', cwd, reason: null, startedAtMs: 2 }
    transport.emit('request', { id: 'srv-cmd', method: 'item/commandExecution/requestApproval', params: commandApproval })
    await until(async () => (await service.snapshot('session')).approvals.length === 1, 'approval card')
    const snapshot = await service.snapshot('session')
    const card = snapshot.approvals[0]
    assert.equal(card.command, 'git status --short')
    assert.equal(card.cwd, cwd)
    assert.equal(card.turnId, accepted.turnId)
    assert.equal(card.source, 'native')
    const other = await service.snapshot('other-session').catch((error) => error)
    assert.ok(other instanceof CodexError, 'approvals belong to their own session')

    await service.decide('session', { approvalId: card.id, decision: 'accept' })
    transport.replyTo('srv-cmd', { decision: 'accept' })
    assert.equal((await service.snapshot('session')).approvals.length, 0)
    await assert.rejects(service.decide('session', { approvalId: card.id, decision: 'accept' }), { code: 'approval-expired' })

    transport.emit('request', { id: 'srv-file', method: 'item/fileChange/requestApproval', params: { threadId: thread.id, turnId: accepted.turnId, itemId: 'item-2', grantRoot: '/data', reason: '需要更多写入权限', startedAtMs: 3 } })
    transport.replyTo('srv-file', { decision: 'decline' }, )
    assert.equal((await service.snapshot('session')).approvals.length, 0, 'persistent grants get no one-time approval card')
    await service.interrupt('session', thread.id)
    assert.ok(transport.call('turn/interrupt').length === 1, 'interrupt reaches the CLI')
    assert.equal((await service.snapshot('session')).approvals.length, 0)
    await assert.rejects(service.decide('session', { approvalId: 'missing', decision: 'accept' }), { code: 'approval-expired' })
    await assert.rejects(service.decide('session', { approvalId: 'missing', decision: 'forever' }), { code: 'decision-invalid' })
  })
})

test('native and workspace capabilities gate their own approvals only', async () => {
  await nativeFixture(async ({ service, transport, cwd }) => {
    const { thread } = await service.create('session', { model: 'gpt-5-codex', effort: 'medium', mode: 'agent', engine: 'native' })
    const accepted = await service.send('session', { threadId: thread.id, requestId: 'gate-req-1', text: '运行命令', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' })
    const approval = { threadId: thread.id, turnId: accepted.turnId, itemId: 'item-1', command: 'ls', cwd, startedAtMs: 1 }
    transport.emit('request', { id: 'srv-native', method: 'item/commandExecution/requestApproval', params: approval })
    await until(async () => (await service.snapshot('session')).approvals.length === 1, 'native approval accepted while sandbox isolation is unverified')
    const card = (await service.snapshot('session')).approvals[0]
    await service.decide('session', { approvalId: card.id, decision: 'decline' })
    transport.replyTo('srv-native', { decision: 'decline' })

    // A workspace binding must not borrow the native app capability.
    service.bindings.set('ws-thread', { id: 'ws-thread', sessionId: 'session', cwd, title: '工作区', model: 'gpt-5-codex', effort: 'medium', mode: 'agent', engine: 'workspace', updatedAt: Date.now() })
    transport.emit('request', { id: 'srv-ws', method: 'item/commandExecution/requestApproval', params: { ...approval, threadId: 'ws-thread' } })
    assert.ok(transport.refused('srv-ws'), 'workspace approval requires verified sandbox isolation, not app-process mode')

    // Losing the native capability gates native approvals again.
    service.health = { ...service.health, nativeApp: { ...service.health.nativeApp, available: false } }
    transport.emit('request', { id: 'srv-native-2', method: 'item/commandExecution/requestApproval', params: { ...approval, itemId: 'item-9' } })
    assert.ok(transport.refused('srv-native-2'), 'native approval requires the verified app-process capability')

    transport.emit('request', { id: 'srv-perm', method: 'item/permissions/requestApproval', params: { threadId: thread.id, turnId: accepted.turnId, itemId: 'item-3', cwd, permissions: {}, startedAtMs: 4 } })
    assert.ok(transport.refused('srv-perm'), 'permission profiles are outside this approval surface')
  })
})

test('native events, stop and failure clean approvals and running state', async () => {
  await nativeFixture(async ({ service, transport, cwd }) => {
    const { thread } = await service.create('session', { model: 'gpt-5-codex', effort: 'medium', mode: 'agent', engine: 'native' })
    const accepted = await service.send('session', { threadId: thread.id, requestId: 'stop-req-1', text: '长任务', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' })
    transport.emit('request', { id: 'srv-stop', method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: accepted.turnId, itemId: 'item-1', command: 'sleep 30', cwd, startedAtMs: 1 } })
    await until(async () => (await service.snapshot('session')).approvals.length === 1, 'pending approval')
    await service.interrupt('session', thread.id)
    assert.ok(transport.replyTo('srv-stop', { decision: 'cancel' }), 'interrupt cancels the pending CLI approval')
    const interrupted = service.threads.get(thread.id).turns.find((entry) => entry.id === accepted.turnId)
    transport.emit('notification', { method: 'turn/completed', params: { threadId: thread.id, turnId: accepted.turnId, turn: { id: accepted.turnId, status: 'interrupted' } } })
    await until(async () => !(await service.snapshot('session')).threads.find((entry) => entry.id === thread.id).pending, 'running cleared')
    assert.equal(interrupted.status, 'inProgress', 'interrupt does not rewrite turn history before the CLI confirms')
    assert.equal((await service.snapshot('session')).approvals.length, 0)

    // turn/completed with a pending approval clears it without answering the dead request.
    const next = await service.send('session', { threadId: thread.id, requestId: 'stop-req-2', text: '再次运行', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' })
    transport.emit('request', { id: 'srv-late', method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: next.turnId, itemId: 'item-2', command: 'pwd', cwd, startedAtMs: 2 } })
    await until(async () => (await service.snapshot('session')).approvals.length === 1, 'second approval')
    const before = transport.responses.length
    transport.emit('notification', { method: 'turn/completed', params: { threadId: thread.id, turnId: next.turnId, turn: { id: next.turnId, status: 'completed' } } })
    await until(async () => (await service.snapshot('session')).approvals.length === 0, 'approval cleared by completion')
    assert.equal(transport.responses.length, before, 'completed turns must not answer stale approval requests')

    // A real process exit closes the transport and publishes the native failure.
    transport.closed = true
    transport.emit('exit', { code: 1, signal: null })
    const status = service.status()
    assert.equal(status.health.phase, 'failed')
    assert.equal(status.health.nativeApp.available, false)
    assert.ok(status.health.nativeApp.reason, 'failure reason is published for the native capability')
    await assert.rejects(service.send('session', { threadId: thread.id, requestId: 'stop-req-3', text: '断连后', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' }), { code: 'execution-unavailable' })
  })
})

test('native bindings persist, reload and resume without re-sending history', async () => {
  await nativeFixture(async ({ service, transport, cwd, home, root }) => {
    const { thread } = await service.create('session', { model: 'gpt-5-codex', effort: 'medium', mode: 'agent', engine: 'native' })
    await service.send('session', { threadId: thread.id, requestId: 'resume-req-1', text: '第一轮', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' })
    completeTurn(transport, thread.id, 'turn-1')
    await terminal(service, thread.id, 'turn-1')

    const restarted = new CodexService({
      paths: { home, executable: join(root, 'bin', 'codex') },
      env: safeEnv(),
      resolveWorkspace: async (id) => { if (id !== 'session') throw new CodexError('session-invalid', 'invalid session'); return cwd },
      probe: async () => ({ version: '0.167.0', agent: false, chat: false, reason: '未验证本机沙箱', chatReason: '对话模式不可用' }),
      nativeProbe: async () => nativeAppHealth(),
      transportFactory: () => transport,
      fetchImpl: async () => assert.fail('native bindings must never call the HTTP assistant'),
    })
    try {
      await restarted.connect(true)
      // Native CLI threads live in the CLI's own history; the sidebar index stores only bindings.
      const bindingView = (await restarted.snapshot('session')).history.find((entry) => entry.id === thread.id)
      assert.ok(bindingView, 'native binding must survive restart')
      assert.equal(bindingView.engine, 'native')
      assert.equal(bindingView.source, 'native')
      assert.equal(bindingView.mode, 'agent')
      assert.equal(bindingView.approvalPolicy, 'untrusted')
      const resumed = await restarted.resume('session', thread.id)
      assert.equal(resumed.id, thread.id)
      const read = transport.call('thread/read').at(-1).params
      assert.equal(read.threadId, thread.id)
      const resume = transport.call('thread/resume').at(-1).params
      assert.equal(resume.threadId, thread.id)
      assert.equal(resume.cwd, cwd)
      assert.equal(resume.model, 'gpt-5-codex')
      assert.equal(resume.modelProvider, 'openai')
      assert.equal(resume.sandbox, 'danger-full-access')
      assert.equal(resume.approvalPolicy, 'untrusted')
      assert.equal(resume.excludeTurns, true)
      assert.equal(resume.config, undefined, 'official resume must not carry provider config')
      assert.ok(transport.call('thread/turns/list').length >= 1, 'history page is fetched for the UI')
      const accepted = await restarted.send('session', { threadId: thread.id, requestId: 'resume-req-2', text: '重启后继续', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' })
      assert.equal(accepted.turnId, 'turn-2')
    } finally { await restarted.dispose() }
  })
})

test('corrupted native bindings fail closed instead of degrading to the HTTP assistant', async () => {
  await nativeFixture(async ({ home, root, cwd }) => {
    const index = {
      version: 1,
      threads: [{ id: 'native-thread-x', sessionId: 'session', cwd, title: '损坏', model: 'gpt-5-codex', effort: 'medium', mode: 'agent', engine: 'native', source: 'custom', providerId: 'custom-x', providerRevision: 'r1', executionMode: 'app-process', permissionMode: 'app-process', approvalPolicy: 'untrusted', updatedAt: 1 }],
      customThreads: [],
    }
    await writeFile(join(home, 'sidebar-threads.json'), JSON.stringify(index))
    const broken = new CodexService({
      paths: { home, executable: join(root, 'bin', 'codex') },
      env: safeEnv(),
      resolveWorkspace: async () => cwd,
      probe: async () => ({ version: '0.167.0', agent: false, chat: false, reason: null, chatReason: '' }),
      nativeProbe: async () => nativeAppHealth(),
      transportFactory: () => { throw new CodexError('unexpected', 'must not connect') },
    })
    const snapshot = await broken.snapshot('session')
    assert.ok(snapshot.historyError, 'invalid native binding must surface a history error')
    assert.equal(snapshot.threads.length, 0)
    await assert.rejects(broken.connect(true), { code: 'history-invalid' })
  })
})

test('native send keeps workspace sandbox rules for workspace engine bindings', async () => {
  await nativeFixture(async ({ service, transport, cwd }) => {
    // Simulate a verified-sandbox build serving a workspace-engine official binding:
    // its turn policy stays workspaceWrite even though app-process mode is present.
    service.health = { ...service.health, agent: true, nativeApp: { ...service.health.nativeApp, available: true } }
    const { thread, binding } = await service.create('session', { model: 'gpt-5-codex', effort: 'medium', mode: 'agent', engine: 'workspace' })
    assert.equal(binding.engine, 'workspace')
    const start = transport.call('thread/start')[0].params
    assert.equal(start.sandbox, 'workspace-write')
    await service.send('session', { threadId: thread.id, requestId: 'ws-req-1', text: '读取文件', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' })
    const turnStart = transport.call('turn/start')[0].params
    assert.deepEqual(turnStart.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true })
  })
})

for (const apiFormat of ['responses', 'chat-completions', 'anthropic-messages']) test(`native ${apiFormat} credentials refresh without changing the thread provider`, async () => {
  await nativeFixture(async ({ service, transport, home }) => {
    const original = { name: '模型', model: 'remote-model', baseUrl: 'https://provider.example/v1', apiKey: SECRET, apiFormat, engine: 'native' }
    const saved = await service.saveModel(original)
    const { thread } = await service.create('session', { model: saved.id, effort: '', mode: 'agent', engine: 'native' })
    const configName = `model_providers.kxxy_${saved.id}`
    const firstConfig = transport.call('thread/start').at(-1).params.config[configName]
    const bridged = apiFormat !== 'responses'
    assert.equal(firstConfig.wire_api, 'responses')
    assert.equal(firstConfig.experimental_bearer_token === SECRET, !bridged)
    if (bridged) {
      assert.match(firstConfig.base_url, /^http:\/\/127\.0\.0\.1:\d+\//)
      assert.equal(firstConfig.capabilities.remote_compaction, 'unsupported')
    }
    const first = await service.send('session', { threadId: thread.id, requestId: 'before-key', text: '第一轮', model: saved.id, effort: '', mode: 'agent' })
    assert.equal(transport.call('thread/resume').length, 0)
    const rotated = await service.saveModel({ ...original, id: saved.id, name: '改名', apiKey: 'updated-native-private-key' })
    assert.notEqual(rotated.configVersion, saved.configVersion)
    assert.equal(transport.call('thread/resume').length, 0, 'saving settings must not rebind an active turn')
    completeTurn(transport, thread.id, first.turnId)
    await terminal(service, thread.id, first.turnId)
    const second = await service.send('session', { threadId: thread.id, requestId: 'after-key', text: '第二轮', model: saved.id, effort: '', mode: 'agent' })
    const resumedConfig = transport.call('thread/resume').at(-1).params.config[configName]
    assert.equal(resumedConfig.experimental_bearer_token, bridged ? firstConfig.experimental_bearer_token : 'updated-native-private-key')
    assert.equal(resumedConfig.base_url, firstConfig.base_url)
    assert.equal(transport.call('turn/start').length, 2)
    const json = JSON.stringify(await service.snapshot('session'))
    const disk = await readFile(join(home, 'sidebar-threads.json'), 'utf8')
    for (const secret of [SECRET, 'updated-native-private-key', ...(bridged ? [firstConfig.experimental_bearer_token] : [])]) {
      assert.ok(!json.includes(secret))
      assert.ok(!disk.includes(secret))
    }
    assert.ok(!json.includes('providerRevision'))
    completeTurn(transport, thread.id, second.turnId)
    await terminal(service, thread.id, second.turnId)
    await service.saveModel({ ...original, id: saved.id, apiKey: '', query: { deployment: 'other' } })
    await assert.rejects(service.send('session', { threadId: thread.id, requestId: 'changed-query', text: '不能转发旧历史', model: saved.id, effort: '', mode: 'agent' }), { code: 'model-change' })
    assert.equal(transport.call('turn/start').length, 2)
  })
})

test('reconnecting an app-server loads cached threads once before new turns and ignores stale events', async () => {
  await nativeFixture(async ({ service, transport, cwd }) => {
    const { thread } = await service.create('session', { model: 'gpt-5-codex', effort: 'medium', mode: 'agent', engine: 'native' })
    const first = await service.send('session', { threadId: thread.id, requestId: 'first', text: '第一轮', model: 'gpt-5-codex', effort: 'medium', mode: 'agent' })
    completeTurn(transport, thread.id, first.turnId)
    await terminal(service, thread.id, first.turnId)
    transport.closed = true
    transport.emit('exit', { code: 1 })
    const replacement = new FakeNativeTransport(cwd)
    service.transportFactory = () => replacement
    await service.connect(true)
    transport.emit('exit', { code: 99 })
    assert.equal(service.status().health.phase, 'connected', 'old transport events must not poison a new connection')
    const input = { threadId: thread.id, requestId: 'after-reconnect', text: '新请求', model: 'gpt-5-codex', effort: 'high', mode: 'agent' }
    const turns = await Promise.all([service.send('session', input), service.send('session', input)])
    assert.deepEqual(turns[0], turns[1])
    assert.equal(replacement.call('thread/resume').length, 1)
    assert.equal(replacement.call('turn/start').length, 1)
    assert.ok(replacement.calls.findIndex((call) => call.method === 'thread/resume') < replacement.calls.findIndex((call) => call.method === 'turn/start'))
  })
})

test('native Responses authentication is configurable without exposing headers to snapshots', async () => {
  await nativeFixture(async ({ service }) => {
    for (const authType of ['bearer', 'x-api-key', 'api-key', 'none']) {
      const saved = await service.saveModel({ name: authType, model: 'model', baseUrl: 'https://provider.example/v1', apiKey: authType === 'none' ? '' : SECRET, apiFormat: 'responses', engine: 'native', authType, headers: { 'x-project': 'private-project-value' }, query: { 'api-version': '2026-01-01' } })
      const params = nativeProviderParameters(service.customModels.get(saved.id))
      const config = params.config[`model_providers.kxxy_${saved.id}`]
      assert.equal(config.experimental_bearer_token, authType === 'bearer' ? SECRET : undefined)
      assert.equal(config.http_headers[authType], ['x-api-key', 'api-key'].includes(authType) ? SECRET : undefined)
      assert.equal(config.query_params['api-version'], '2026-01-01')
      const snapshot = JSON.stringify(service.status())
      assert.ok(!snapshot.includes('private-project-value'))
      assert.ok(!snapshot.includes(SECRET))
    }
  })
})
