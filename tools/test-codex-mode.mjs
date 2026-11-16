import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, cp, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CodexService } from '../plugins/dsh-codex-sidebar/lib/service.mjs'
import * as workspaceTools from '../plugins/dsh-codex-sidebar/lib/workspace-tools.mjs'
import { CodexError } from '../plugins/dsh-codex-sidebar/lib/transport.mjs'

const SECRET = 'mode-provider-private-key'
const ENV_SECRET = 'mode-unrelated-account-private-key'
const safeEnv = () => ({
  ...Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'TEMP', 'TMP'].filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]])),
  OPENAI_API_KEY: ENV_SECRET,
  NODE_OPTIONS: '--require untrusted.cjs',
})

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}
async function close(server) {
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
}
function json(res, body) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
function answer(res, text = '回复已完成', format = 'chat-completions') {
  json(res, format === 'responses' ? { status: 'completed', output_text: text } : { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] })
}
function readCall(res, format) {
  const args = JSON.stringify({ path: 'project.txt' })
  json(res, format === 'responses'
    ? { status: 'completed', output: [{ type: 'function_call', id: 'read-item', call_id: 'read-call', name: 'read_file', arguments: args }] }
    : { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'read-call', type: 'function', function: { name: 'read_file', arguments: args } }] }, finish_reason: 'tool_calls' }] })
}
async function providerFixture() {
  const calls = [], handlers = []
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      const call = { headers: req.headers, url: req.url, body: raw ? JSON.parse(raw) : null }
      calls.push(call)
      if (handlers.length) await handlers.shift()(req, res, call)
      else answer(res)
    } catch (error) {
      if (!res.destroyed) { if (!res.headersSent) res.writeHead(500); res.end('provider fixture error') }
    }
  })
  return { origin: await listen(server), calls, handlers, close: () => close(server) }
}
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'codex-mode-'))
  const home = join(root, 'home'), workspace = join(root, 'workspace')
  await mkdir(workspace)
  const cwd = await realpath(workspace)
  let currentCwd = cwd
  const provider = await providerFixture()
  const services = []
  const makeService = (options = {}) => {
    const service = new CodexService({ paths: { home, executable: null }, env: safeEnv(),
      resolveWorkspace: async (id) => { if (!['session', 'other-session'].includes(id)) throw new CodexError('session-invalid', 'invalid session'); return currentCwd },
      probe: async () => assert.fail('Custom workspace mode must not probe native Codex'),
      transportFactory: () => assert.fail('Custom workspace mode must not launch native Codex'),
      ...options,
    })
    services.push(service)
    return service
  }
  try { await fn({ root, home, cwd, provider, service: makeService(), makeService, changeWorkspace: (path) => { currentCwd = path } }) }
  finally {
    for (const service of services) await service.dispose()
    await provider.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
async function modelAndThread(service, provider, format = 'chat-completions') {
  const model = await service.saveModel({ name: '模式模型', model: 'mode-model', baseUrl: `${provider.origin}/v1`, apiKey: SECRET, apiFormat: format })
  const { thread } = await service.create('session', { model: model.id, mode: 'chat', effort: '' })
  return { model, thread }
}
function input(thread, model, extra = {}) { return { threadId: thread.id, model: model.id, mode: 'chat', effort: '', requestId: 'same-request', text: '项目需要保留之前的上下文', ...extra } }
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
  }, 'terminal turn')
  await service.queue
  return turn
}
async function completeChat(service, provider, format) {
  const { model, thread } = await modelAndThread(service, provider, format)
  provider.handlers.push((_req, res) => answer(res, '旧对话回复：继续保留这条上下文', format))
  const accepted = await service.send('session', input(thread, model))
  assert.equal((await terminal(service, thread.id, accepted.turnId)).status, 'completed')
  return { model, thread, accepted }
}
async function missing(path) { await assert.rejects(access(path), { code: 'ENOENT' }) }

for (const format of ['chat-completions', 'responses']) test(`${format} chat can continue as a workspace agent without replaying old operations`, async () => {
  await fixture(async ({ service, provider, cwd, makeService }) => {
    await writeFile(join(cwd, 'project.txt'), '实际工作区文件内容')
    const { model, thread: original, accepted: oldAccepted } = await completeChat(service, provider, format)
    const oldThread = structuredClone(service.threads.get(original.id))
    const oldBinding = structuredClone(service.bindings.get(original.id))
    const continued = await service.create('session', { model: model.id, mode: 'agent', effort: '', continueFrom: original.id })
    const { thread, binding } = continued
    assert.notEqual(thread.id, original.id)
    assert.equal(thread.continuedFrom, original.id)
    assert.equal(thread.inheritedTurns, 1)
    assert.equal(binding.mode, 'agent')
    assert.equal(thread.turns.length, 1)
    assert.notEqual(thread.turns[0].id, oldThread.turns[0].id)
    assert.ok(thread.turns[0].items.every((item) => !oldThread.turns[0].items.some((source) => source.id === item.id)))
    assert.deepEqual(thread.turns[0].providerMessages, oldThread.turns[0].providerMessages)
    assert.equal((binding.requests || []).length, 0)
    assert.equal(provider.calls.length, 1, 'continuation must not send history or tools automatically')
    assert.deepEqual(service.threads.get(original.id), oldThread)
    assert.deepEqual(service.bindings.get(original.id), oldBinding)
    assert.deepEqual(await service.send('session', input(original, model)), oldAccepted)
    assert.equal(provider.calls.length, 1)
    await assert.rejects(service.send('session', input(original, model, { requestId: 'change-old-mode', mode: 'agent' })), { code: 'mode-change' })

    provider.handlers.push((_req, res) => readCall(res, format))
    provider.handlers.push((_req, res) => answer(res, '读取工作区完成', format))
    const next = await service.send('session', input(thread, model, { mode: 'agent', text: '请读取项目文件' }))
    assert.notEqual(next.turnId, oldAccepted.turnId, 'old request IDs must not dedupe the new conversation')
    const turn = await terminal(service, thread.id, next.turnId)
    assert.equal(turn.status, 'completed')
    assert.equal(provider.calls.length, 3)
    const payload = provider.calls[1].body
    assert.ok(payload.tools.some((entry) => (entry.name || entry.function?.name) === 'read_file'))
    assert.match(JSON.stringify(payload), /项目需要保留之前的上下文/)
    assert.match(JSON.stringify(payload), /旧对话回复/)
    const feedback = format === 'responses'
      ? provider.calls[2].body.input.find((entry) => entry.type === 'function_call_output' && entry.call_id === 'read-call').output
      : provider.calls[2].body.messages.find((entry) => entry.role === 'tool' && entry.tool_call_id === 'read-call').content
    assert.equal(JSON.parse(feedback).text, '实际工作区文件内容')
    assert.deepEqual(service.threads.get(original.id), oldThread)
    assert.deepEqual(service.bindings.get(original.id), oldBinding)
    assert.ok(!JSON.stringify(await service.snapshot('session')).includes(SECRET))
    const restarted = makeService()
    const state = await restarted.snapshot('session')
    assert.equal(state.threads.find((entry) => entry.id === original.id).mode, 'chat')
    assert.equal(state.threads.find((entry) => entry.id === thread.id).mode, 'agent')
    assert.equal(state.threads.find((entry) => entry.id === thread.id).continuedFrom, original.id)
    assert.deepEqual(await restarted.send('session', input(thread, model, { mode: 'agent', text: '请读取项目文件' })), next)
    assert.equal(provider.calls.length, 3)
  })
})

test('workspace continuation rejects another session, workspace, provider and unsupported source or target modes', async () => {
  await fixture(async ({ service, provider, cwd, changeWorkspace }) => {
    const { model, thread } = await completeChat(service, provider, 'chat-completions')
    const continuation = { model: model.id, mode: 'agent', effort: '', continueFrom: thread.id }
    const oldCount = service.bindings.size
    await assert.rejects(service.create('other-session', continuation), { code: 'thread-forbidden' })
    await assert.rejects(service.create('session', { ...continuation, mode: 'chat' }), { code: 'continuation-invalid' })
    await assert.rejects(service.create('session', { ...continuation, continueFrom: 'missing-thread' }), { code: 'thread-forbidden' })
    const other = await service.saveModel({ name: '另一个服务', model: 'mode-model', baseUrl: `${provider.origin}/v1`, apiKey: SECRET, apiFormat: 'chat-completions' })
    await assert.rejects(service.create('session', { ...continuation, model: other.id }), { code: 'model-change' })
    const second = join(cwd, 'another-workspace')
    await mkdir(second)
    changeWorkspace(await realpath(second))
    await assert.rejects(service.create('session', continuation), { code: 'workspace-changed' })
    changeWorkspace(cwd)
    const binding = service.bindings.get(thread.id)
    binding.source = 'native'
    await assert.rejects(service.create('session', continuation), { code: 'continuation-invalid' })
    binding.source = 'custom'; binding.mode = 'agent'
    await assert.rejects(service.create('session', continuation), { code: 'continuation-invalid' })
    binding.mode = 'chat'
    await service.saveModel({ ...model, apiKey: '', baseUrl: `${provider.origin}/changed/v1` })
    await assert.rejects(service.create('session', continuation), { code: 'model-change' })
    assert.equal(service.bindings.size, oldCount)
    assert.equal(provider.calls.length, 1)
  })
})

test('running and interrupted chat turns are never replayed by workspace continuation', async () => {
  await fixture(async ({ service, provider }) => {
    const { model, thread } = await completeChat(service, provider, 'chat-completions')
    provider.handlers.push((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); res.write('data: {"choices":[{"delta":{"content":"部分输出"}}]}\n\n') })
    const pending = await service.send('session', input(thread, model, { requestId: 'interrupted-request', text: '这个请求将被停止' }))
    await until(() => provider.calls.length === 2, 'running provider request')
    await assert.rejects(service.create('session', { model: model.id, mode: 'agent', continueFrom: thread.id }), { code: 'busy' })
    await service.interrupt('session', thread.id)
    assert.equal((await terminal(service, thread.id, pending.turnId)).status, 'interrupted')
    const old = structuredClone(service.threads.get(thread.id))
    const continued = await service.create('session', { model: model.id, mode: 'agent', continueFrom: thread.id })
    assert.equal(continued.thread.inheritedTurns, 1)
    assert.equal(continued.thread.turns.length, 1)
    assert.ok(!JSON.stringify(continued.thread).includes('这个请求将被停止'))
    assert.deepEqual(service.threads.get(thread.id), old)
    assert.equal(provider.calls.length, 2)
  })
})

test('workspace continuation reserves context and output room before accepting saved history', async () => {
  await fixture(async ({ service, provider }) => {
    const { model, thread } = await completeChat(service, provider, 'chat-completions')
    const source = service.threads.get(thread.id)
    const saved = structuredClone(source.turns)
    const count = service.bindings.size
    const cloneTurn = (index) => {
      const turn = structuredClone(saved[0])
      turn.id = `saved-turn-${index}`
      turn.items.forEach((item, itemIndex) => { item.id = `saved-item-${index}-${itemIndex}` })
      return turn
    }
    const continuation = { model: model.id, mode: 'agent', continueFrom: thread.id }
    source.turns = Array.from({ length: 100 }, (_, index) => cloneTurn(index))
    await assert.rejects(service.create('session', continuation), { code: 'continuation-limit' })
    assert.equal(source.turns.length, 100)
    source.turns = [cloneTurn(0)]
    source.turns[0].providerMessages[0].content = 'x'.repeat(1024 * 1024)
    await assert.rejects(service.create('session', continuation), { code: 'context-limit' })
    source.turns = Array.from({ length: 16 }, (_, index) => {
      const turn = cloneTurn(index)
      turn.items.push({ id: `saved-reasoning-${index}`, type: 'reasoning', text: 'r'.repeat(240000) })
      return turn
    })
    assert.ok(Buffer.byteLength(JSON.stringify(source)) < 4 * 1024 * 1024)
    await assert.rejects(service.create('session', continuation), { code: 'history-limit' })
    assert.equal(service.bindings.size, count)
    assert.equal(provider.calls.length, 1)
    source.turns = saved
  })
})

test('environment check probes real executables, verifies scratch writes and leaves the project intact', async () => {
  await fixture(async ({ service, provider, cwd }) => {
    await writeFile(join(cwd, 'project.txt'), 'keep this file unchanged')
    await mkdir(join(cwd, 'folder'))
    const before = (await readdir(cwd)).sort()
    const report = await workspaceTools.checkWorkspaceEnvironment({ cwd, env: safeEnv(), timeoutMs: 5000 })
    assert.equal(report.environment.cwd, cwd)
    assert.equal(report.environment.permissionMode, 'app-process')
    assert.ok(report.checks.length >= 5)
    assert.ok(report.checks.every((entry) => ['ok', 'error'].includes(entry.status) && typeof entry.detail === 'string'))
    for (const name of ['workspace', 'fileAccess', 'shell', 'node', 'python', 'git']) assert.ok(report.checks.some((entry) => entry.id === name), `missing ${name} probe`)
    for (const name of ['workspace', 'fileAccess', 'shell', 'node']) assert.equal(report.checks.find((entry) => entry.id === name).status, 'ok')
    assert.deepEqual((await readdir(cwd)).sort(), before, 'scratch write must be removed')
    assert.equal(await readFile(join(cwd, 'project.txt'), 'utf8'), 'keep this file unchanged')
    assert.ok(!JSON.stringify(report).includes(ENV_SECRET))
    assert.ok(!JSON.stringify(report).includes('untrusted.cjs'))
    assert.equal(report.environment.env, undefined)
    assert.equal(provider.calls.length, 0, 'environment diagnostics must not contact a model')
    const status = await service.environmentCheck('session')
    assert.equal(status.environment.cwd, cwd)
    assert.deepEqual((await readdir(cwd)).sort(), before)
    assert.equal((await service.snapshot('session')).approvals.length, 0)
  })
})

test('environment diagnostics report genuine failures and timeout without disclosing account secrets or leaving scratch files', async () => {
  await fixture(async ({ root, cwd }) => {
    const absent = join(root, 'absent-workspace')
    await assert.rejects(workspaceTools.checkWorkspaceEnvironment({ cwd: absent, env: safeEnv(), timeoutMs: 5000 }), { code: 'ENOENT' })
    await missing(absent)
    const before = (await readdir(cwd)).sort()
    const started = Date.now()
    await assert.rejects(workspaceTools.checkWorkspaceEnvironment({ cwd, env: safeEnv(), timeoutMs: 1 }), { code: 'arguments-invalid' })
    const timed = await workspaceTools.checkWorkspaceEnvironment({ cwd, env: { ...safeEnv(), PATH: dirname(process.execPath) }, timeoutMs: 100 })
    assert.equal(timed.ok, false)
    assert.ok(timed.checks.some((entry) => entry.status === 'error'))
    assert.ok(Date.now() - started < 2000, 'probe timeout must stop the diagnostics promptly')
    assert.deepEqual((await readdir(cwd)).sort(), before)
    assert.ok(!JSON.stringify(timed).includes(ENV_SECRET))
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(workspaceTools.checkWorkspaceEnvironment({ cwd, env: safeEnv(), signal: controller.signal, timeoutMs: 5000 }), { name: 'AbortError' })
    assert.deepEqual((await readdir(cwd)).sort(), before)
  })
})

test('environment diagnostics reject repeated or excess concurrent checks and release their slots', async () => {
  await fixture(async ({ cwd, makeService }) => {
    const service = makeService({ resolveWorkspace: async () => cwd })
    const first = service.environmentCheck('session')
    const second = service.environmentCheck('other-session')
    const tooMany = service.environmentCheck('third-session')
    const repeated = service.environmentCheck('session')
    await Promise.all([
      assert.rejects(tooMany, { code: 'environment-busy' }),
      assert.rejects(repeated, { code: 'environment-busy' }),
    ])
    const reports = await Promise.all([first, second])
    assert.ok(reports.every((report) => report.checks.find((entry) => entry.id === 'fileAccess').status === 'ok'))
    assert.equal(service.environmentChecks.size, 0)
    assert.deepEqual(await readdir(cwd), [])
    assert.equal((await service.environmentCheck('session')).environment.cwd, cwd)
    assert.equal(service.environmentChecks.size, 0)
  })
})

test('disposing during workspace resolution prevents a late environment check from starting', async () => {
  await fixture(async ({ cwd, makeService }) => {
    let release
    const resolving = new Promise((resolve) => { release = resolve })
    const service = makeService({ resolveWorkspace: () => resolving })
    const pending = service.environmentCheck('session')
    await service.dispose()
    release(cwd)
    await assert.rejects(pending, { code: 'disposed' })
    assert.equal(service.environmentChecks.size, 0)
    assert.deepEqual(await readdir(cwd), [])
  })
})

test('continuation and environment HTTP routes enforce host auth, origin, nonce and session before accessing the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mode-http-'))
  const environmentKeys = ['KXXY_CODEX_HOME', 'KXXY_CODEX_BIN', 'KXXY_ENGINE_ROOT', 'NODE_OPTIONS', 'OPENAI_API_KEY']
  const savedEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]))
  const cleanups = []
  const provider = await providerFixture()
  let server
  try {
    const modules = join(root, 'node_modules')
    await mkdir(join(modules, 'kxxy-host', 'lib'), { recursive: true })
    await cp(fileURLToPath(new URL('../plugins/dsh-codex-sidebar', import.meta.url)), join(modules, 'dsh-codex-sidebar'), { recursive: true })
    await cp(fileURLToPath(new URL('../plugins/kxxy-host/package.json', import.meta.url)), join(modules, 'kxxy-host', 'package.json'))
    await cp(fileURLToPath(new URL('../plugins/kxxy-host/lib/auth.mjs', import.meta.url)), join(modules, 'kxxy-host', 'lib', 'auth.mjs'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const cwd = await realpath(workspace)
    process.env.KXXY_CODEX_HOME = join(root, 'home')
    process.env.OPENAI_API_KEY = ENV_SECRET
    process.env.NODE_OPTIONS = '--require untrusted.cjs'
    delete process.env.KXXY_CODEX_BIN; delete process.env.KXXY_ENGINE_ROOT
    let handler
    const ctx = {
      get: (name) => name === 'connection'
        ? { admit: (request) => request.headers.cookie === 'owner=test' ? { peer: {} } : { rejection: 401 } }
        : name === 'sessions' ? { get: (id) => ['session', 'other-session'].includes(id) ? { header: { cwd } } : undefined } : null,
      webServer: { register: (route) => { handler = route.handler; return () => {} } },
      effect: (fn) => { cleanups.push(fn()); return () => {} },
    }
    const plugin = await import(pathToFileURL(join(modules, 'dsh-codex-sidebar', 'lib', 'index.js')).href)
    plugin.apply(ctx)
    server = createServer((req, res) => handler(req, res))
    const origin = await listen(server)
    const owner = { cookie: 'owner=test' }
    const stateUrl = `${origin}/kxxy/codex/bootstrap?sessionId=session`
    const initial = await (await fetch(stateUrl, { headers: owner })).json()
    const headers = { ...owner, origin, 'content-type': 'application/json', 'x-kxxy-nonce': initial.nonce }
    const post = (route, body, overrides = {}) => fetch(`${origin}/kxxy/codex${route}`, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) })
    const saved = await post('/models/save', { sessionId: 'session', name: '路由模型', model: 'route-model', baseUrl: `${provider.origin}/v1`, apiKey: SECRET, apiFormat: 'chat-completions' })
    assert.equal(saved.status, 200)
    const model = await saved.json()
    const created = await post('/thread/new', { sessionId: 'session', model: model.id, mode: 'chat', effort: '' })
    const { thread } = await created.json()
    const sent = await post('/turn', { sessionId: 'session', ...input(thread, model) })
    const { turnId } = await sent.json()
    await until(async () => {
      const state = await (await fetch(stateUrl, { headers: owner })).json()
      return state.threads.find((entry) => entry.id === thread.id)?.turns.find((entry) => entry.id === turnId)?.status === 'completed'
    }, 'HTTP chat completion')
    const continuation = { sessionId: 'session', model: model.id, mode: 'agent', continueFrom: thread.id }
    const diagnostic = { sessionId: 'session' }
    for (const [route, body] of [['/thread/new', continuation], ['/environment/check', diagnostic]]) {
      assert.equal((await post(route, body, { cookie: '' })).status, 401)
      assert.equal((await post(route, body, { origin: 'https://untrusted.example' })).status, 403)
      assert.equal((await post(route, body, { 'x-kxxy-nonce': '' })).status, 403)
      assert.equal((await post(route, body, { 'sec-fetch-site': 'cross-site' })).status, 403)
      assert.notEqual((await post(route, { ...body, sessionId: 'unknown' })).status, 200)
    }
    assert.equal((await post('/thread/new', { ...continuation, sessionId: 'other-session' })).status, 403)
    assert.equal(provider.calls.length, 1)
    const resumed = await post('/thread/new', continuation)
    assert.equal(resumed.status, 200)
    const next = await resumed.json()
    assert.equal(next.thread.continuedFrom, thread.id)
    assert.equal(next.binding.mode, 'agent')
    assert.equal(provider.calls.length, 1)
    const before = (await readdir(cwd)).sort()
    const checked = await post('/environment/check', {
      ...diagnostic, cwd: root, command: 'DO NOT EXECUTE CALLER COMMANDS', timeoutMs: 999999999,
      env: { OPENAI_API_KEY: SECRET, NODE_OPTIONS: '--require untrusted.cjs' },
    })
    assert.equal(checked.status, 200)
    const report = await checked.json()
    assert.equal(report.environment.cwd, cwd, 'diagnostics must use session workspace, not caller cwd')
    assert.ok(!JSON.stringify(report).includes(SECRET))
    assert.ok(!JSON.stringify(report).includes(ENV_SECRET))
    assert.ok(!JSON.stringify(report).includes('DO NOT EXECUTE CALLER COMMANDS'))
    assert.deepEqual((await readdir(cwd)).sort(), before)
    assert.equal(provider.calls.length, 1)
    const final = await (await fetch(stateUrl, { headers: owner })).json()
    assert.equal(final.threads.find((entry) => entry.id === thread.id).mode, 'chat')
    assert.equal(final.threads.find((entry) => entry.id === next.thread.id).mode, 'agent')
    assert.equal(final.approvals.length, 0)
    assert.ok(!JSON.stringify(final).includes(SECRET))
  } finally {
    if (server) await close(server)
    for (const dispose of cleanups) await dispose?.()
    await provider.close()
    for (const [key, value] of Object.entries(savedEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
