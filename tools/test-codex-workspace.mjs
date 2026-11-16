import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { setImmediate as nextTick } from 'node:timers/promises'
import { CodexService } from '../plugins/dsh-codex-sidebar/lib/service.mjs'
import { WorkspaceTools, workspaceEnvironment } from '../plugins/dsh-codex-sidebar/lib/workspace-tools.mjs'
import { CodexError } from '../plugins/dsh-codex-sidebar/lib/transport.mjs'

const SECRET = 'workspace-provider-private-key'
const ENV_SECRET = 'unrelated-account-credential'
const safeEnv = () => ({ ...Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'TEMP', 'TMP'].filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]])), OPENAI_API_KEY: ENV_SECRET, NODE_OPTIONS: '--require untrusted.cjs' })
const hash = (text) => createHash('sha256').update(text).digest('hex')

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}
async function close(server) {
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
}
function json(res, value) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
function answer(res, text = '操作完成', format = 'chat-completions') {
  json(res, format === 'responses' ? { status: 'completed', output_text: text } : { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] })
}
function toolJson(res, name, args, id = 'tool-call') {
  json(res, { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })
}
async function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  res.flushHeaders()
  for (const byte of Buffer.from(events)) { if (res.destroyed) return; res.write(Buffer.from([byte])); await nextTick() }
  res.end()
}
const event = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`
async function fragmentedChatTool(res, name, args, id = 'fragmented-call') {
  const raw = JSON.stringify(args)
  const middle = Math.floor(raw.length / 2)
  return sse(res, ': heartbeat\r\n\r\n' + [
    { choices: [{ delta: { reasoning_content: '读取真实文件', tool_calls: [{ index: 0, id: id.slice(0, 5), type: 'function', function: { name: name.slice(0, 4), arguments: raw.slice(0, middle) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: id.slice(5), function: { name: name.slice(4), arguments: raw.slice(middle) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ].map(event).join('') + 'data: [DONE]\r\n\r\n')
}
async function fragmentedResponsesTool(res, name, args, id = 'response-call') {
  const raw = JSON.stringify(args), middle = Math.floor(raw.length / 2)
  const reasoning = { type: 'reasoning', id: 'reasoning-item', summary: [], encrypted_content: 'opaque-reasoning-content' }
  return sse(res, [
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'function-item', call_id: id, name, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'function-item', delta: raw.slice(0, middle) },
    { type: 'response.function_call_arguments.delta', item_id: 'function-item', delta: raw.slice(middle) },
    { type: 'response.function_call_arguments.done', output_index: 1, arguments: raw },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'function-item', call_id: id, name, arguments: raw } },
    { type: 'response.completed', response: { status: 'completed', output: [reasoning, { type: 'function_call', id: 'function-item', call_id: id, name, arguments: raw }] } },
  ].map(event).join(''))
}
async function providerFixture() {
  const calls = [], handlers = []
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      const call = { url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null }
      calls.push(call)
      if (handlers.length) await handlers.shift()(req, res, call)
      else answer(res)
    } catch (error) { if (!res.destroyed) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })) } }
  })
  return { origin: await listen(server), calls, handlers, close: () => close(server) }
}
async function fixture(fn, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-workspace-'))
  const home = join(root, 'home'), workspace = join(root, 'workspace')
  await mkdir(workspace)
  const cwd = await realpath(workspace)
  const provider = await providerFixture()
  let currentCwd = cwd
  const services = []
  const makeService = (options = {}) => {
    const service = new CodexService({ paths: { home, executable: null }, env: safeEnv(),
      resolveWorkspace: async (id) => { if (!['session', 'other-session'].includes(id)) throw new CodexError('session-invalid', 'invalid session'); return currentCwd },
      probe: async () => { assert.fail('Custom agent must not probe Codex CLI') },
      transportFactory: () => { assert.fail('Custom agent must not launch Codex CLI') },
      ...overrides, ...options,
    })
    services.push(service)
    return service
  }
  const service = makeService()
  try { await fn({ root, home, cwd, provider, service, makeService, changeWorkspace: (path) => { currentCwd = path } }) }
  finally { for (const service of services) await service.dispose(); await provider.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}
async function modelAndThread(service, provider, format = 'chat-completions') {
  const model = await service.saveModel({ name: '工作区模型', model: 'workspace-model', baseUrl: `${provider.origin}/v1`, apiKey: SECRET, apiFormat: format })
  const { thread } = await service.create('session', { model: model.id, mode: 'agent', effort: '' })
  return { model, thread }
}
function input(thread, model, extra = {}) { return { threadId: thread.id, model: model.id, mode: 'agent', effort: '', requestId: 'request', text: '处理工作区任务', ...extra } }
async function until(check, label, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)) }
  assert.fail(`Timed out waiting for ${label}`)
}
async function terminal(service, thread, turnId) {
  let turn
  await until(async () => {
    const state = await service.snapshot('session'), current = state.threads.find((entry) => entry.id === thread.id)
    turn = current?.turns.find((entry) => entry.id === turnId)
    return turn && turn.status !== 'inProgress' && !current.pending
  }, 'terminal turn')
  await service.queue
  return turn
}
async function approval(service, kind) {
  let entry
  await until(async () => { entry = (await service.snapshot('session')).approvals.find((entry) => entry.kind === kind); return !!entry }, `${kind} approval`)
  return entry
}
const toolResult = (call, id = undefined) => JSON.parse(call.body.messages.findLast((entry) => entry.role === 'tool' && (!id || entry.tool_call_id === id)).content)
const psQuote = (text) => `'${text.replace(/'/g, "''")}'`
function nodeCommand(script) { return process.platform === 'win32' ? `& ${psQuote(process.execPath)} ${psQuote(script)}` : `${psQuote(process.execPath)} ${psQuote(script)}` }
async function missing(path) { await assert.rejects(access(path), { code: 'ENOENT' }) }

test('workspace tools read real files and enforce traversal, symlink, credential and binary boundaries', async () => {
  await fixture(async ({ root, cwd }) => {
    const tools = new WorkspaceTools({ cwd, env: safeEnv() })
    await writeFile(join(cwd, 'readme.txt'), 'hello\nneedle 中文\n')
    await writeFile(join(cwd, '.env'), 'needle credential')
    await writeFile(join(cwd, 'binary.dat'), Buffer.from([0, 1, 2]))
    await writeFile(join(root, 'outside.txt'), 'needle outside')
    await mkdir(join(cwd, 'src'))
    await writeFile(join(cwd, 'src', 'code.txt'), 'needle code')
    assert.equal((await tools.execute('read_file', { path: 'readme.txt' })).text, 'hello\nneedle 中文\n')
    const listing = await tools.execute('list_directory', {})
    assert.equal(listing.ok, true)
    assert.ok(listing.entries.some((entry) => entry.name === 'readme.txt'))
    assert.ok(!listing.entries.some((entry) => entry.name === '.env'))
    const found = await tools.execute('search_files', { query: 'needle', glob: '**/*.txt' })
    assert.deepEqual(found.matches.map((entry) => entry.path).sort(), ['readme.txt', 'src/code.txt'])
    for (const [name, args, expected] of [
      ['read_file', { path: '../outside.txt' }, 'path-outside'],
      ['read_file', { path: '.env' }, 'sensitive-file'],
      ['read_file', { path: 'binary.dat' }, 'file-binary'],
      ['write_file', { path: '../outside.txt', content: 'unsafe' }, 'path-outside'],
      ['write_file', { path: '.env', content: 'unsafe' }, 'sensitive-file'],
      ['run_command', { command: 'echo unsafe', cwd: '..' }, 'path-outside'],
      ['read_file', { path: 'readme.txt', unexpected: true }, 'arguments-invalid'],
    ]) assert.equal((await tools.execute(name, args)).code, expected)
    await symlink(root, join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await tools.execute('read_file', { path: 'escape/outside.txt' })).code, 'path-outside')
    assert.equal((await tools.execute('write_file', { path: 'escape/new.txt', content: 'unsafe' })).code, 'path-outside')
    assert.equal((await tools.execute('list_directory', {})).entries.some((entry) => entry.name === 'escape'), false)
    await missing(join(root, 'new.txt'))
    const environment = workspaceEnvironment(cwd, safeEnv())
    assert.equal(environment.cwd, cwd)
    assert.equal(environment.permissionMode, 'app-process')
    assert.equal(environment.platform, process.platform)
    assert.equal(environment.arch, process.arch)
    assert.ok(isAbsolute(environment.shell))
    assert.equal(environment.env.OPENAI_API_KEY, undefined)
    assert.equal(environment.env.NODE_OPTIONS, undefined)
    assert.equal(environment.env.PWD, cwd)
    const reported = await tools.execute('get_environment', {})
    assert.equal(reported.cwd, cwd)
    assert.equal(reported.node, process.version)
    assert.equal(reported.capabilities.shellAvailable, true)
    assert.equal(reported.capabilities.commandsRequireApproval, true)
    assert.ok(reported.capabilities.tools.includes('get_environment'))
    assert.ok(!JSON.stringify(reported).includes(ENV_SECRET))
    const protectedTools = new WorkspaceTools({ cwd, env: safeEnv(), secrets: [SECRET] })
    await writeFile(join(cwd, 'provider-key.txt'), `ordinary file contains ${SECRET}`)
    assert.ok(!(await protectedTools.execute('read_file', { path: 'provider-key.txt' })).text.includes(SECRET))
    assert.ok(!JSON.stringify(await protectedTools.execute('search_files', { query: SECRET })).includes(SECRET))
  })
})

test('fragmented Chat tool calls read the workspace and persist tool context across restart', async () => {
  await fixture(async ({ service, provider, cwd, home, makeService }) => {
    await writeFile(join(cwd, '说明.txt'), '真实工作区内容')
    await writeFile(join(cwd, 'attached.txt'), '引用上下文')
    const { model, thread } = await modelAndThread(service, provider)
    provider.handlers.push((_req, res) => fragmentedChatTool(res, 'read_file', { path: '说明.txt' }, 'read-call'))
    const accepted = await service.send('session', input(thread, model, { files: ['attached.txt'] }))
    const turn = await terminal(service, thread, accepted.turnId)
    assert.equal(turn.status, 'completed')
    assert.equal(provider.calls.length, 2)
    assert.equal(toolResult(provider.calls[1]).text, '真实工作区内容')
    assert.equal(provider.calls[1].body.messages.find((entry) => entry.role === 'tool').tool_call_id, 'read-call')
    assert.ok(provider.calls[0].body.messages.find((entry) => entry.role === 'system').content.includes(JSON.stringify(cwd)))
    assert.ok(provider.calls[0].body.messages.some((entry) => entry.role === 'user' && entry.content.includes('引用上下文')))
    assert.ok(provider.calls[0].body.tools.some((entry) => entry.function.name === 'run_command'))
    assert.equal(provider.calls[0].body.parallel_tool_calls, false)
    assert.ok(turn.items.some((entry) => entry.type === 'reasoning' && entry.text === '读取真实文件'))
    assert.ok(turn.items.some((entry) => entry.type === 'workspaceTool' && entry.result?.text === '真实工作区内容'))
    const state = await service.snapshot('session')
    assert.equal(state.environment.permissionMode, 'app-process')
    assert.equal(state.threads[0].environment.toolsMode, 'agent')
    assert.ok(!JSON.stringify(state).includes(SECRET))
    assert.ok(!JSON.stringify(provider.calls.map((call) => call.body)).includes(ENV_SECRET))
    await service.dispose()
    const restarted = makeService({ paths: undefined, env: { ...safeEnv(), KXXY_CODEX_HOME: home } })
    assert.equal((await restarted.resume('session', thread.id)).turns[0].providerMessages.filter((entry) => entry.role === 'tool').length, 1)
    assert.deepEqual(await restarted.send('session', input(thread, model)), accepted)
    assert.equal(provider.calls.length, 2)
    const next = await restarted.send('session', input(thread, model, { requestId: 'next', text: '继续' }))
    await terminal(restarted, thread, next.turnId)
    assert.ok(provider.calls[2].body.messages.some((entry) => entry.role === 'tool' && entry.content.includes('真实工作区内容')))
    assert.ok(!((await readFile(join(home, 'sidebar-threads.json'), 'utf8')).includes(SECRET)))
  })
})

test('fragmented Responses function calls return real file data as function_call_output', async () => {
  await fixture(async ({ service, provider, cwd }) => {
    await writeFile(join(cwd, 'response.txt'), 'Responses 文件内容')
    const { model, thread } = await modelAndThread(service, provider, 'responses')
    provider.handlers.push((_req, res) => fragmentedResponsesTool(res, 'read_file', { path: 'response.txt' }))
    provider.handlers.push((_req, res) => answer(res, '已读取', 'responses'))
    const accepted = await service.send('session', input(thread, model))
    assert.equal((await terminal(service, thread, accepted.turnId)).status, 'completed')
    assert.equal(provider.calls.length, 2)
    assert.equal(provider.calls[0].url, '/v1/responses')
    assert.deepEqual(provider.calls[0].body.include, ['reasoning.encrypted_content'])
    assert.ok(provider.calls[0].body.tools.some((entry) => entry.name === 'read_file'))
    const returned = provider.calls[1].body.input.find((entry) => entry.type === 'function_call_output')
    assert.equal(returned.call_id, 'response-call')
    assert.equal(JSON.parse(returned.output).text, 'Responses 文件内容')
    assert.equal(provider.calls[1].body.input.filter((entry) => entry.type === 'function_call').length, 1)
    assert.deepEqual(provider.calls[1].body.input.filter((entry) => entry.type === 'reasoning'), [{ type: 'reasoning', id: 'reasoning-item', summary: [], encrypted_content: 'opaque-reasoning-content' }])
  })
})

for (const decision of ['accept', 'decline', 'race']) test(`workspace agent write ${decision} uses the reviewed diff and current file hash`, async () => {
  await fixture(async ({ service, provider, cwd }) => {
    await writeFile(join(cwd, 'edit.txt'), 'before\n')
    const { model, thread } = await modelAndThread(service, provider)
    provider.handlers.push((_req, res) => toolJson(res, 'write_file', { path: 'edit.txt', content: 'after 中文\n' }))
    const accepted = await service.send('session', input(thread, model))
    const pending = await approval(service, 'fileChange')
    assert.equal(pending.source, 'custom')
    assert.equal(pending.path, 'edit.txt')
    assert.equal(pending.expectedHash, hash('before\n'))
    assert.ok(pending.diff.includes('-before') && pending.diff.includes('+after 中文'))
    assert.equal(await readFile(join(cwd, 'edit.txt'), 'utf8'), 'before\n')
    await assert.rejects(service.decide('other-session', { approvalId: pending.id, decision: 'accept' }), { code: 'thread-forbidden' })
    if (decision === 'race') await writeFile(join(cwd, 'edit.txt'), 'changed by another editor\n')
    await service.decide('session', { approvalId: pending.id, decision: decision === 'decline' ? 'decline' : 'accept' })
    const turn = await terminal(service, thread, accepted.turnId)
    assert.equal(turn.status, 'completed')
    await assert.rejects(service.decide('session', { approvalId: pending.id, decision: 'accept' }), { code: 'approval-expired' })
    const result = toolResult(provider.calls[1])
    if (decision === 'accept') { assert.equal(result.ok, true); assert.equal(await readFile(join(cwd, 'edit.txt'), 'utf8'), 'after 中文\n') }
    else { assert.equal(result.code, decision === 'race' ? 'file-changed' : 'approval-declined'); assert.equal(await readFile(join(cwd, 'edit.txt'), 'utf8'), decision === 'race' ? 'changed by another editor\n' : 'before\n') }
    assert.equal((await service.snapshot('session')).approvals.length, 0)
  })
})

test('commands require approval and run in the reviewed cwd with unrelated account variables removed', async () => {
  const relocation = { PERL5LIB: '/app/runtime/lib/perl5', RUBYLIB: '/app/runtime/lib/ruby', EMACSLOADPATH: '/app/runtime/share/emacs/lisp', XDG_DATA_DIRS: '/app/runtime/share' }
  await fixture(async ({ service, provider, cwd }) => {
    const sub = join(cwd, 'sub')
    await mkdir(sub)
    await writeFile(join(sub, 'command.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('command-result.txt','ran');console.log(JSON.stringify({cwd:process.cwd(),key:process.env.OPENAI_API_KEY??null,options:process.env.NODE_OPTIONS??null,relocation:Object.fromEntries(['PERL5LIB','RUBYLIB','EMACSLOADPATH','XDG_DATA_DIRS'].map(key=>[key,process.env[key]??null]))}));")
    const command = nodeCommand('command.mjs')
    const { model, thread } = await modelAndThread(service, provider)
    provider.handlers.push((_req, res) => toolJson(res, 'run_command', { command, cwd: 'sub', timeoutMs: 5000 }, 'denied-command'))
    const denied = await service.send('session', input(thread, model, { requestId: 'denied' }))
    const first = await approval(service, 'commandExecution')
    assert.equal(first.cwd, await realpath(sub))
    assert.equal(first.command, command)
    await missing(join(sub, 'command-result.txt'))
    await service.decide('session', { approvalId: first.id, decision: 'decline' })
    await terminal(service, thread, denied.turnId)
    assert.equal(toolResult(provider.calls[1]).code, 'approval-declined')
    await missing(join(sub, 'command-result.txt'))
    provider.handlers.push((_req, res) => toolJson(res, 'run_command', { command, cwd: 'sub', timeoutMs: 5000 }, 'accepted-command'))
    const accepted = await service.send('session', input(thread, model, { requestId: 'accepted' }))
    const second = await approval(service, 'commandExecution')
    await service.decide('session', { approvalId: second.id, decision: 'accept' })
    const turn = await terminal(service, thread, accepted.turnId)
    assert.equal(turn.status, 'completed')
    const result = toolResult(provider.calls[3], 'accepted-command')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(await readFile(join(sub, 'command-result.txt'), 'utf8'), 'ran')
    const output = JSON.parse(result.output.trim())
    assert.equal(output.cwd, await realpath(sub))
    assert.equal(output.key, null)
    assert.equal(output.options, null)
    assert.deepEqual(output.relocation, relocation)
    assert.ok(turn.items.some((entry) => entry.type === 'commandExecution' && entry.exitCode === 0))
  }, { env: { ...safeEnv(), ...relocation } })
})

test('Stop kills an approved command process and duplicate requests cannot run it again', async () => {
  await fixture(async ({ service, provider, cwd }) => {
    await writeFile(join(cwd, 'long-command.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('started.json',JSON.stringify({pid:process.pid}));console.log('STARTED');setTimeout(()=>{writeFileSync('late.txt','must not run');process.exit(0)},10000);")
    const { model, thread } = await modelAndThread(service, provider)
    provider.handlers.push((_req, res) => toolJson(res, 'run_command', { command: nodeCommand('long-command.mjs'), timeoutMs: 15000 }, 'long-command'))
    const request = input(thread, model)
    const results = await Promise.all([service.send('session', request), service.send('session', request)])
    assert.deepEqual(results[0], results[1])
    const pending = await approval(service, 'commandExecution')
    await service.decide('session', { approvalId: pending.id, decision: 'accept' })
    let pid
    await until(async () => { try { pid = JSON.parse(await readFile(join(cwd, 'started.json'), 'utf8')).pid; return !!pid } catch { return false } }, 'approved command process')
    assert.equal((await service.interrupt('session', thread.id)).requested, true, JSON.stringify(await service.snapshot('session')))
    const turn = await terminal(service, thread, results[0].turnId)
    assert.equal(turn.status, 'interrupted')
    await until(() => { try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }, 'command process termination')
    await missing(join(cwd, 'late.txt'))
    assert.deepEqual(await service.send('session', request), results[0])
    assert.equal(provider.calls.length, 1)
    assert.equal((await service.snapshot('session')).approvals.length, 0)
  })
})

test('Stop during pending write approval leaves files unchanged and invalidates approval', async () => {
  await fixture(async ({ service, provider, cwd, makeService }) => {
    const { model, thread } = await modelAndThread(service, provider)
    provider.handlers.push((_req, res) => toolJson(res, 'write_file', { path: 'new.txt', content: 'should not exist' }))
    const accepted = await service.send('session', input(thread, model))
    const pending = await approval(service, 'fileChange')
    await service.interrupt('session', thread.id)
    assert.equal((await terminal(service, thread, accepted.turnId)).status, 'interrupted')
    await missing(join(cwd, 'new.txt'))
    await assert.rejects(service.decide('session', { approvalId: pending.id, decision: 'accept' }), { code: 'approval-expired' })
    assert.equal(provider.calls.length, 1)
    await service.dispose()
    const restarted = makeService()
    assert.equal((await restarted.resume('session', thread.id)).turns[0].status, 'interrupted')
    assert.deepEqual(await restarted.send('session', input(thread, model)), accepted)
    assert.equal(provider.calls.length, 1)
  })
})

test('overall agent timeout includes approval waits and does not write or retry tools', async () => {
  await fixture(async ({ service, provider, cwd }) => {
    const { model, thread } = await modelAndThread(service, provider)
    provider.handlers.push((_req, res) => toolJson(res, 'write_file', { path: 'timeout.txt', content: 'unsafe' }))
    const accepted = await service.send('session', input(thread, model))
    const turn = await terminal(service, thread, accepted.turnId)
    assert.equal(turn.status, 'failed')
    assert.equal(turn.error.code, 'model-timeout')
    assert.equal((await service.snapshot('session')).approvals.length, 0)
    assert.deepEqual(await service.send('session', input(thread, model)), accepted)
    assert.equal(provider.calls.length, 1)
    await missing(join(cwd, 'timeout.txt'))
  }, { customAgentTimeoutMs: 80 })
})

test('reused tool call ids terminate an agent turn before a second tool can execute', async () => {
  await fixture(async ({ service, provider, cwd }) => {
    await writeFile(join(cwd, 'readme.txt'), 'read once')
    const { model, thread } = await modelAndThread(service, provider)
    provider.handlers.push((_req, res) => toolJson(res, 'read_file', { path: 'readme.txt' }, 'same-id'))
    provider.handlers.push((_req, res) => toolJson(res, 'write_file', { path: 'unsafe.txt', content: 'unsafe' }, 'same-id'))
    const accepted = await service.send('session', input(thread, model))
    const turn = await terminal(service, thread, accepted.turnId)
    assert.equal(turn.status, 'failed')
    assert.equal(turn.error.code, 'model-tools-duplicate')
    assert.equal(turn.items.filter((entry) => entry.type === 'workspaceTool').length, 1)
    assert.equal((await service.snapshot('session')).approvals.length, 0)
    await missing(join(cwd, 'unsafe.txt'))
  })
})
