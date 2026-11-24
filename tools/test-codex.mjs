import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, cp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readPluginFiles } from './lib/assemble.mjs'
import { stampCodexPlugin, attachCodexRuntime, CODEX_PLUGIN_BASE, CODEX_PIN } from './lib/codex.mjs'
import { patchDshManifest, createPatchContext } from './lib/patches.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { CodexTransport, CodexError, redact } from '../plugins/dsh-codex-sidebar/lib/transport.mjs'
import { CodexService, reduceEvent } from '../plugins/dsh-codex-sidebar/lib/service.mjs'
import { childEnvironment, contextFile, probeRuntime, workspaceForSession } from '../plugins/dsh-codex-sidebar/lib/security.mjs'
import { authVerdict, checkNonce, checkWriteRequest, AUTH_ALLOW } from '../plugins/kxxy-host/lib/auth.mjs'

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.exitCode = null
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null) }
  let text = ''
  child.stdin.on('data', (data) => {
    text += data
    while (text.includes('\n')) {
      const at = text.indexOf('\n')
      const message = JSON.parse(text.slice(0, at))
      text = text.slice(at + 1)
      child.emit('sent', message)
    }
  })
  return child
}

function transportPair(options = {}) {
  const child = fakeChild()
  const transport = new CodexTransport({ executable: '/verified/codex', spawnProcess: () => child, timeoutMs: 100, env: {}, cwd: tmpdir(), ...options })
  child.on('sent', (message) => {
    if (message.method === 'initialize') child.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'test' } })}\n`)
  })
  return { child, transport }
}

test('transport handshake and split UTF-8 JSON lines', async () => {
  const { child, transport } = transportPair()
  await transport.start()
  const notification = new Promise((resolve) => transport.once('notification', resolve))
  const line = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '你好' } }) + '\n')
  for (const byte of line) child.stdout.write(Buffer.from([byte]))
  assert.equal((await notification).params.delta, '你好')
  transport.stop()
})

test('transport rejects invalid protocol and all pending requests', async () => {
  const { child, transport } = transportPair()
  await transport.start()
  const request = transport.request('wait')
  child.stdout.write('not-json\n')
  await assert.rejects(request, { code: 'protocol-invalid' })
  assert.equal(transport.closed, true)
})

test('transport timeout never resends a mutation', async () => {
  const { child, transport } = transportPair()
  await transport.start()
  let count = 0
  child.on('sent', (message) => { if (message.method === 'turn/start') count += 1 })
  await assert.rejects(transport.request('turn/start', {}, 10), { code: 'rpc-timeout' })
  assert.equal(count, 1)
  transport.stop()
})

test('transport process exit rejects pending requests', async () => {
  const { child, transport } = transportPair()
  await transport.start()
  const pending = transport.request('turn/start')
  child.kill()
  await assert.rejects(pending, { code: 'process-exit' })
})

test('redaction and environment do not leak unrelated credentials', () => {
  assert.ok(!redact('api_key=super-secret Bearer token-secret sk-abcdefghijklmnop').includes('super-secret'))
  const env = childEnvironment({ home: '/isolated/codex', executable: '/runtime/bin/codex' }, { PATH: '/bin', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require attacker', CODEX_HOME: '/real-home' })
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.CODEX_HOME, '/isolated/codex')
  const development = childEnvironment({ home: '/isolated/codex', executable: '/runtime/bin/codex' }, {
    PATH: '/bin', HOME: '/developer', KXXY_ROOT: '/runtime', KXXY_ENGINE_ROOT: '/runtime',
    DSH_HOME: '/developer/.dsh', GIT_EXEC_PATH: '/runtime/libexec/git', RUBYLIB: '/runtime/lib/ruby',
    EMACSLOADPATH: '/runtime/share/emacs/lisp', OPENAI_API_KEY: 'unrelated-account',
    NODE_OPTIONS: '--require attacker', CODEX_HOME: '/other-account',
  })
  assert.equal(development.HOME, '/developer')
  assert.equal(development.KXXY_ROOT, '/runtime')
  assert.equal(development.GIT_EXEC_PATH, '/runtime/libexec/git')
  assert.equal(development.RUBYLIB, '/runtime/lib/ruby')
  assert.equal(development.EMACSLOADPATH, '/runtime/share/emacs/lisp')
  assert.equal(development.CODEX_HOME, '/isolated/codex')
  assert.equal(development.OPENAI_API_KEY, undefined)
  assert.equal(development.NODE_OPTIONS, undefined)
})

test('transport redacts split diagnostic secrets and structured RPC errors', async () => {
  const secret = 'arbitrary-private-provider-credential'
  const sanitize = (value) => redact(String(value).split(secret).join('[redacted]'))
  const { child, transport } = transportPair({ sanitize })
  await transport.start()
  child.stderr.write(`request failed: ${secret.slice(0, 12)}`)
  assert.equal(transport.diagnostics, '', 'partial diagnostics must not be exposed')
  child.stderr.write(`${secret.slice(12)}\n`)
  assert.ok(transport.diagnostics.includes('[redacted]'))
  assert.ok(!transport.diagnostics.includes(secret.slice(12)))
  child.on('sent', (message) => {
    if (message.method === 'bad') child.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32001, message: `provider echoed ${secret}`, data: { secret } } })}\n`)
  })
  await assert.rejects(transport.request('bad'), (error) => error.code === 'rpc-error' && error.details.rpcCode === -32001 && !JSON.stringify({ message: error.message, details: error.details }).includes(secret))
  transport.stop()
})

test('authentication is fail-closed and writes require origin plus nonce', () => {
  const request = { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json', 'x-kxxy-nonce': 'correct' } }
  assert.equal(authVerdict({ get: () => null }, request), 'unavailable')
  assert.equal(authVerdict({ get: () => ({ admit: () => ({ peer: {} }) }) }, request), AUTH_ALLOW)
  assert.equal(checkWriteRequest(request).ok, true)
  assert.equal(checkNonce(request, ['correct']).ok, true)
  assert.equal(checkNonce(request, ['other']).ok, false)
  assert.equal(checkWriteRequest({ headers: { ...request.headers, origin: 'https://untrusted.example' } }).ok, false)
})

test('workspace derives from live or persisted host sessions, never caller cwd', async () => {
  const cwd = await realpath(tmpdir())
  const ctx = { get: (name) => name === 'sessions' ? { get: () => ({ header: { cwd } }) } : null }
  assert.equal(await workspaceForSession(ctx, 'session-test'), cwd)
  await assert.rejects(workspaceForSession(ctx, '../another'), { code: 'session-invalid' })
  const stored = { get: (name) => name === 'sessionPersistence' ? { list: async () => [{ header: { id: 'stored', cwd } }] } : null }
  assert.equal(await workspaceForSession(stored, 'stored'), cwd)
  await assert.rejects(workspaceForSession(stored, 'missing'), { code: 'session-invalid' })
})

test('context rejects traversal and credentials but references binary and truncates oversized files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-context-'))
  try {
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    await writeFile(join(cwd, 'test.txt'), 'hello')
    await writeFile(join(root, 'outside.txt'), 'outside')
    await writeFile(join(cwd, '.env'), 'secret')
    await writeFile(join(cwd, 'binary'), Buffer.from([0, 1]))
    await writeFile(join(cwd, 'large'), Buffer.alloc(140000, 65))
    assert.equal((await contextFile(cwd, 'test.txt')).text, 'hello')
    await assert.rejects(contextFile(cwd, '../outside.txt'), { code: 'file-outside' })
    await assert.rejects(contextFile(cwd, '.env'), { code: 'sensitive-file' })
    for (const name of ['sidebar-models.json', '.npmrc', '.netrc', '.git-credentials']) {
      await writeFile(join(cwd, name), 'private-value')
      await assert.rejects(contextFile(cwd, name), { code: 'sensitive-file' })
    }
    await mkdir(join(cwd, '.ssh'))
    await writeFile(join(cwd, '.ssh', 'config'), 'private-host')
    await assert.rejects(contextFile(cwd, '.ssh/config'), { code: 'sensitive-file' })
    // Binary attachments are referenced by path so the model can open them with its tools.
    const binary = await contextFile(cwd, 'binary')
    assert.equal(binary.binary, true); assert.equal(binary.text, undefined); assert.equal(binary.size, 2)
    // Long text is truncated in the prompt instead of failing the whole request.
    const large = await contextFile(cwd, 'large')
    assert.equal(large.truncated, true); assert.equal(large.text.length, 128 * 1024); assert.equal(large.size, 140000)
  } finally { await rm(root, { recursive: true, force: true }) }
})

class FakeTransport extends EventEmitter {
  constructor() { super(); this.closed = false; this.calls = []; this.responses = []; this.turns = 0; this.failTurn = false }
  async start() { return {} }
  async request(method, params) {
    this.calls.push({ method, params })
    if (method === 'account/read') return { account: { type: 'apiKey' }, requiresOpenaiAuth: true }
    if (method === 'model/list') return { data: [{ id: 'model', model: 'actual-model', displayName: 'Test model', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }] }
    if (method === 'thread/start') return { thread: { id: 'thread', cwd: params.cwd, turns: [] } }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: 'thread', cwd: this.cwd, turns: [] } }
    if (method === 'turn/start') {
      this.turns += 1
      if (this.failTurn) throw new CodexError('rpc-timeout', 'timeout', 504)
      return { turn: { id: 'turn', status: 'inProgress', items: [] } }
    }
    return {}
  }
  respond(id, result) { this.responses.push({ id, result }) }
  refuse(id) { this.responses.push({ id, refused: true }) }
  stop() { this.closed = true }
}

async function serviceFixture(fn, agent = true) {
  const home = await mkdtemp(join(tmpdir(), 'codex-service-'))
  const cwd = join(home, 'workspace')
  await mkdir(cwd)
  const canonical = await realpath(cwd)
  const transport = new FakeTransport()
  transport.cwd = canonical
  const service = new CodexService({ paths: { home, executable: process.execPath }, resolveWorkspace: async () => canonical, transportFactory: () => transport, probe: async () => ({ version: '0.167.0', agent, chat: false, reason: agent ? null : 'sandbox denied', chatReason: 'chat disabled' }) })
  try { await service.connect(true); await fn(service, transport, home, canonical) } finally { await service.dispose(); await rm(home, { recursive: true, force: true }) }
}

test('runtime failure never enables agent or chat', async () => {
  await serviceFixture(async (service, transport) => {
    assert.equal(service.status().health.agent, false)
    assert.equal(service.status().health.chat, false)
    await assert.rejects(service.create('session', { model: 'model', effort: 'medium', mode: 'agent' }), { code: 'execution-unavailable' })
    assert.equal(transport.calls.some((call) => call.method === 'thread/start'), false)
  }, false)
})

test('concurrent duplicate turns execute once with exact model and permission parameters', async () => {
  await serviceFixture(async (service, transport, home, cwd) => {
    await service.create('session', { model: 'model', effort: 'medium', mode: 'agent' })
    const input = { threadId: 'thread', requestId: 'request-1', text: 'create a test', model: 'model', effort: 'high', mode: 'agent' }
    const results = await Promise.all([service.send('session', input), service.send('session', input)])
    assert.deepEqual(results, [{ turnId: 'turn' }, { turnId: 'turn' }])
    assert.equal(transport.turns, 1)
    const params = transport.calls.find((call) => call.method === 'turn/start').params
    assert.equal(params.model, 'actual-model')
    assert.equal(params.effort, 'high')
    assert.equal(params.approvalPolicy, 'untrusted')
    assert.equal(params.sandboxPolicy.type, 'workspaceWrite')
    assert.deepEqual(params.sandboxPolicy.writableRoots, [cwd])
    assert.equal(params.sandboxPolicy.networkAccess, false)
    const index = JSON.parse(await readFile(join(home, 'sidebar-threads.json'), 'utf8'))
    assert.equal(index.threads[0].requests[0].turnId, 'turn')
    await assert.rejects(service.send('other-session', { ...input, requestId: 'request-2' }), { code: 'thread-forbidden' })
  })
})

test('a timed-out mutation is not retried and remains visibly pending', async () => {
  await serviceFixture(async (service, transport) => {
    await service.create('session', { model: 'model', effort: 'medium', mode: 'agent' })
    transport.failTurn = true
    const input = { threadId: 'thread', requestId: 'request', text: 'test', model: 'model', effort: 'medium', mode: 'agent' }
    await assert.rejects(service.send('session', input), { code: 'rpc-timeout' })
    await assert.rejects(service.send('session', input), { code: 'rpc-timeout' })
    assert.equal(transport.turns, 1)
    assert.equal((await service.snapshot('session')).threads[0].pending, true)
  })
})

test('one-time approval belongs to an active turn and cannot be answered twice', async () => {
  await serviceFixture(async (service, transport) => {
    await service.create('session', { model: 'model', effort: 'medium', mode: 'agent' })
    await service.send('session', { threadId: 'thread', requestId: 'r', text: 'test', model: 'model', effort: 'medium', mode: 'agent' })
    transport.emit('request', { id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'command', command: 'npm test' } })
    const [entry] = (await service.snapshot('session')).approvals
    await assert.rejects(service.decide('other-session', { approvalId: entry.id, decision: 'accept' }), { code: 'thread-forbidden' })
    await service.decide('session', { approvalId: entry.id, decision: 'accept' })
    assert.deepEqual(transport.responses[0], { id: 42, result: { decision: 'accept' } })
    await assert.rejects(service.decide('session', { approvalId: entry.id, decision: 'accept' }), { code: 'approval-expired' })
    transport.emit('request', { id: 43, method: 'item/permissions/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'extra' } })
    assert.equal(transport.responses[1].refused, true)
  })
})

test('event reducer merges deltas, terminal results, diff and rejects late start regression', () => {
  let thread = { id: 'thread', turns: [] }
  thread = reduceEvent(thread, 'turn/started', { turn: { id: 'turn', status: 'inProgress', items: [] } })
  thread = reduceEvent(thread, 'item/agentMessage/delta', { turnId: 'turn', itemId: 'message', delta: 'Hello' })
  thread = reduceEvent(thread, 'item/agentMessage/delta', { turnId: 'turn', itemId: 'message', delta: ' world' })
  thread = reduceEvent(thread, 'turn/diff/updated', { turnId: 'turn', diff: '+test' })
  thread = reduceEvent(thread, 'turn/completed', { turn: { id: 'turn', status: 'completed', items: [] } })
  thread = reduceEvent(thread, 'turn/started', { turn: { id: 'turn', status: 'inProgress', items: [] } })
  assert.equal(thread.turns[0].items[0].text, 'Hello world')
  assert.equal(thread.turns[0].status, 'completed')
  assert.equal(thread.turns[0].diff, '+test')
})

test('official client registration uses actual host tab and slot APIs', async () => {
  const source = await readFile(new URL('../plugins/dsh-codex-sidebar/lib/client.js', import.meta.url), 'utf8')
  let exported
  const react = { createElement: () => null, useState() {}, useEffect() {}, useRef() {} }
  const registrations = []
  const kinds = []
  const cleanups = []
  const sandbox = { window: { __ModuleLoader__: { load: ({ id, factory }) => {
    assert.equal(id, 'dsh-codex-sidebar')
    exported = factory((name) => name === 'react' ? react : { PluginArtworkTerminal() {}, Button() {} })
  } } }, document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } } }
  vm.runInNewContext(source, sandbox)
  exported.apply({
    effect: (fn) => { const off = fn(); cleanups.push(off); return off },
    locale: { register: () => () => {} },
    sidebarRight: { openTab() {} },
    sidebarRightTabs: { register: (definition) => { kinds.push(definition); return () => {} } },
    slots: { inject: (name, fn) => fn(), register: (definition) => { registrations.push(definition); return () => {} } },
  })
  assert.equal(kinds[0].kind, 'codex')
  assert.equal(kinds[0].keepMounted, true)
  assert.ok(registrations.some((entry) => entry.name === 'sidebar.right.pane.tab' && entry.key === 'dsh-codex-sidebar'))
  assert.ok(registrations.some((entry) => entry.name === 'sidebar.right.tab.guide.entry'))
  assert.ok(registrations.some((entry) => entry.name === 'sidebar.right.pane.tab.title'))
  assert.equal(registrations.some((entry) => entry.name === 'conversation.session.header.actions' || entry.id === 'codex-sidebar-open'), false, 'Codex must be accessed through the right drawer, not the conversation header')
  for (const cleanup of cleanups.reverse()) if (typeof cleanup === 'function') cleanup()
})

test('plugin packaging fingerprint covers both halves and preserves existing dependencies', () => {
  const files = new Map()
  readPluginFiles(fileURLToPath(new URL('../plugins/dsh-codex-sidebar/', import.meta.url)), files, CODEX_PLUGIN_BASE)
  const fingerprint = stampCodexPlugin(files)
  assert.match(fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(stampCodexPlugin(files), fingerprint)
  files.get(CODEX_PLUGIN_BASE + 'web/codex.css').data = Buffer.from('changed')
  assert.notEqual(stampCodexPlugin(files), fingerprint)
  files.set('lib/node_modules/@deepseek-ai/dsh/package.json', { data: Buffer.from(JSON.stringify({ dependencies: { existing: '1.0.0' } })) })
  patchDshManifest(createPatchContext(files))
  const manifest = JSON.parse(files.get('lib/node_modules/@deepseek-ai/dsh/package.json').data)
  assert.equal(manifest.dependencies.existing, '1.0.0')
  assert.equal(manifest.dependencies['dsh-codex-sidebar'], '0.1.0')
  assert.equal(attachCodexRuntime(files).included, false)
})

test('unverified native runtime cannot enter the APK bundle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-pack-'))
  try {
    await writeFile(join(directory, 'runtime.json'), JSON.stringify({ ...CODEX_PIN, sandboxVerified: false }))
    assert.throws(() => attachCodexRuntime(new Map(), directory), /isolation has not been verified/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('HTTP route requires authentication, nonce and a real host session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-http-'))
  const previous = { home: process.env.KXXY_CODEX_HOME, bin: process.env.KXXY_CODEX_BIN }
  const cleanup = []
  let server
  try {
    const modules = join(root, 'node_modules')
    await mkdir(modules)
    await cp(fileURLToPath(new URL('../plugins/dsh-codex-sidebar', import.meta.url)), join(modules, 'dsh-codex-sidebar'), { recursive: true })
    await mkdir(join(modules, 'kxxy-host', 'lib'), { recursive: true })
    await cp(fileURLToPath(new URL('../plugins/kxxy-host/package.json', import.meta.url)), join(modules, 'kxxy-host', 'package.json'))
    await cp(fileURLToPath(new URL('../plugins/kxxy-host/lib/auth.mjs', import.meta.url)), join(modules, 'kxxy-host', 'lib', 'auth.mjs'))
    const cwd = await realpath(root)
    process.env.KXXY_CODEX_HOME = join(root, 'home')
    process.env.KXXY_CODEX_BIN = join(root, 'absent-codex')
    let handler
    let currentCwd = cwd
    const ctx = {
      get: (name) => name === 'connection' ? { admit: (request) => request.headers.cookie === 'owner=test' ? { peer: {} } : { rejection: 401 } } : name === 'sessions' ? { get: (id) => id === 'session' ? { header: { cwd: currentCwd } } : undefined } : null,
      webServer: { register: (route) => { handler = route.handler; return () => {} } },
      effect: (fn) => { cleanup.push(fn()); return () => {} },
    }
    const plugin = await import(pathToFileURL(join(modules, 'dsh-codex-sidebar', 'lib', 'index.js')).href)
    plugin.apply(ctx)
    server = createServer((req, res) => handler(req, res))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    assert.equal((await fetch(`${origin}/kxxy/codex/bootstrap?sessionId=session`)).status, 401)
    const headers = { cookie: 'owner=test' }
    const bootstrap = await fetch(`${origin}/kxxy/codex/bootstrap?sessionId=session`, { headers })
    assert.equal(bootstrap.status, 200)
    const state = await bootstrap.json()
    assert.match(state.nonce, /^[a-f0-9]{64}$/)
    const request = { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session', consent: true }) }
    assert.equal((await fetch(`${origin}/kxxy/codex/connect`, request)).status, 403)
    request.headers['x-kxxy-nonce'] = state.nonce
    request.headers.origin = 'https://untrusted.example'
    assert.equal((await fetch(`${origin}/kxxy/codex/connect`, request)).status, 403)
    request.headers.origin = origin
    const response = await fetch(`${origin}/kxxy/codex/connect`, request)
    assert.notEqual(response.status, 200)
    assert.equal((await fetch(`${origin}/kxxy/codex/style.css`, { headers })).status, 200)
    currentCwd = null
    const noWorkspace = await fetch(`${origin}/kxxy/codex/bootstrap?sessionId=session`, { headers })
    assert.equal(noWorkspace.status, 200, 'valid sessions can manage models before choosing a workspace')
    const noWorkspaceState = await noWorkspace.json()
    assert.equal(noWorkspaceState.cwd, null)
    assert.ok(noWorkspaceState.workspaceError)
    const post = (action, input) => fetch(`${origin}/kxxy/codex${action}`, { method: 'POST', headers: { ...headers, origin, 'content-type': 'application/json', 'x-kxxy-nonce': noWorkspaceState.nonce }, body: JSON.stringify({ sessionId: 'session', ...input }) })
    const saved = await post('/models/save', { name: '无工作区配置', model: 'local-test', baseUrl: 'http://127.0.0.1:9/v1', authType: 'none', apiFormat: 'chat-completions' })
    assert.equal(saved.status, 200)
    const model = await saved.json()
    assert.equal((await post('/thread/new', { model: model.id, mode: 'chat', engine: 'workspace' })).status, 404)
    assert.equal((await post('/environment/check', {})).status, 404)
    const unknown = await post('/models/save', { sessionId: 'unknown', name: 'no', model: 'no', baseUrl: 'http://127.0.0.1:9', authType: 'none' })
    assert.notEqual(unknown.status, 200, 'removing the workspace requirement must not remove session authorization')
    currentCwd = cwd
    const createdResponse = await post('/thread/new', { model: model.id, mode: 'agent', engine: 'workspace', effort: '' })
    assert.equal(createdResponse.status, 200)
    const created = await createdResponse.json()
    const actions = ['/access/prepare', '/access/apply', '/thread/edit', '/thread/retry', '/changes/preview', '/changes/revert']
    for (const action of actions) {
      const payload = { sessionId: 'session', threadId: created.thread.id, mode: 'full', turnId: 'missing', text: 'example', requestId: `security-${action}` }
      const requestOptions = { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-kxxy-nonce': state.nonce }, body: JSON.stringify(payload) }
      assert.equal((await fetch(`${origin}/kxxy/codex${action}`, requestOptions)).status, 401)
      requestOptions.headers.cookie = 'owner=test'
      requestOptions.headers['x-kxxy-nonce'] = 'invalid'
      assert.equal((await fetch(`${origin}/kxxy/codex${action}`, requestOptions)).status, 403)
      requestOptions.headers['x-kxxy-nonce'] = state.nonce
      requestOptions.headers.origin = 'https://cross-site.invalid'
      assert.equal((await fetch(`${origin}/kxxy/codex${action}`, requestOptions)).status, 403)
    }
    assert.notEqual((await post('/access/apply', { threadId: created.thread.id, mode: 'full' })).status, 200)
    const prepared = await (await post('/access/prepare', { threadId: created.thread.id, mode: 'full' })).json()
    assert.ok(prepared.token)
    assert.equal(prepared.scope.threadId, created.thread.id)
    const applied = await post('/access/apply', { threadId: created.thread.id, mode: 'full', token: prepared.token })
    assert.equal(applied.status, 200)
    assert.equal((await applied.json()).access.mode, 'full')
    assert.notEqual((await post('/access/apply', { threadId: created.thread.id, mode: 'full', token: prepared.token })).status, 200)
    const current = await (await fetch(`${origin}/kxxy/codex/bootstrap?sessionId=session`, { headers })).json()
    assert.ok(!JSON.stringify(current).includes(prepared.token))
    assert.equal((await post('/access/apply', { threadId: created.thread.id, mode: 'readonly' })).status, 200)
  } finally {
    if (server) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
    for (const dispose of cleanup) await dispose?.()
    if (previous.home === undefined) delete process.env.KXXY_CODEX_HOME; else process.env.KXXY_CODEX_HOME = previous.home
    if (previous.bin === undefined) delete process.env.KXXY_CODEX_BIN; else process.env.KXXY_CODEX_BIN = previous.bin
    await rm(root, { recursive: true, force: true })
  }
})
