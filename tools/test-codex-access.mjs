import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, readFile, access, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessPolicy } from '../plugins/dsh-codex-sidebar/lib/access-policy.mjs'
import { WorkspaceTools, readOnlyTools, WORKSPACE_TOOLS } from '../plugins/dsh-codex-sidebar/lib/workspace-tools.mjs'
import { nativeExecutionParameters } from '../plugins/dsh-codex-sidebar/lib/native-models.mjs'

const scope = (cwd, extra = {}) => ({ id: 'thread', sessionId: 'session', cwd, model: 'model', providerId: 'provider', providerRevision: 'revision', engine: 'workspace', mode: 'agent', ...extra })
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'codex-access-'))
  try { const cwd = await realpath(root); await run(cwd) } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}
const psQuote = (text) => `'${text.replace(/'/g, "''")}'`
const command = (script) => process.platform === 'win32' ? `& ${psQuote(process.execPath)} -e ${psQuote(script)}` : `${psQuote(process.execPath)} -e ${psQuote(script)}`

test('access grants are volatile, exact-context, expiring and single-use', () => fixture(async (cwd) => {
  let now = 100
  const policy = new AccessPolicy({ now: () => now }), binding = scope(cwd)
  assert.equal(policy.mode({ ...binding, accessMode: 'full', approvalPolicy: 'never' }, 1), 'approval')
  assert.equal(policy.mode({ ...binding, readOnly: true }, 1), 'readonly')
  assert.throws(() => policy.apply(binding, 1, 'full'), { code: 'access-token' })
  const prepared = policy.prepare(binding, 1)
  assert.equal(prepared.expiresAt, now + 120000)
  assert.equal(prepared.scope.providerRevision, undefined)
  assert.throws(() => policy.apply({ ...binding, id: 'other' }, 1, 'full', prepared.token), { code: 'access-token' })
  assert.equal(policy.apply(binding, 1, 'full', prepared.token).mode, 'full')
  assert.equal(policy.mode(binding, 1), 'full')
  assert.equal(new AccessPolicy().mode(binding, 1), 'approval')
  assert.throws(() => policy.apply(binding, 1, 'full', prepared.token), { code: 'access-token' })
  policy.apply(binding, 1, 'approval')
  assert.equal(policy.mode(binding, 1), 'approval')
  policy.apply(binding, 1, 'readonly')
  assert.equal(policy.mode(binding, 1), 'readonly')
  policy.invalidate(binding.id)
  assert.equal(policy.mode(binding, 1), 'approval')
  const expired = policy.prepare(binding, 1)
  now += 120000
  assert.throws(() => policy.apply(binding, 1, 'full', expired.token), { code: 'access-expired' })
  for (const changed of ['id', 'sessionId', 'cwd', 'model', 'providerId', 'providerRevision', 'engine', 'mode']) {
    const challenge = policy.prepare(binding, 1)
    const modified = { ...binding, [changed]: changed === 'cwd' ? join(cwd, 'other') : 'other' }
    assert.throws(() => policy.apply(modified, 1, 'full', challenge.token), { code: 'access-token' })
    policy.apply(binding, 1, 'full', challenge.token)
    assert.notEqual(policy.mode(modified, 1), 'full')
    policy.invalidate()
  }
  const generation = policy.prepare(binding, 1)
  assert.throws(() => policy.apply(binding, 2, 'full', generation.token), { code: 'access-token' })
  policy.mode(binding, 2)
  assert.throws(() => policy.apply(binding, 1, 'full', generation.token), { code: 'access-token' })
  assert.throws(() => policy.mode(binding, undefined), { code: 'access-context' })
  assert.throws(() => policy.apply(binding, 1, 'unknown'), { code: 'access-mode' })
  const first = policy.prepare(binding, 1)
  for (let index = 0; index < 64; index++) policy.prepare({ ...binding, id: `thread-${index}` }, 1)
  assert.throws(() => policy.apply(binding, 1, 'full', first.token), { code: 'access-token' })
}))

test('native full is server-trusted only and readonly is genuinely unsupported', () => {
  assert.equal(nativeExecutionParameters({ available: true }, 'agent').approvalPolicy, 'untrusted')
  assert.equal(nativeExecutionParameters({ available: true }, 'agent', 'untrusted', { accessMode: 'full' }).approvalPolicy, 'never')
  assert.throws(() => nativeExecutionParameters({ available: true }, 'agent', 'never', { accessMode: 'full' }), { code: 'approval-policy' })
  assert.throws(() => nativeExecutionParameters({ available: true }, 'agent', 'untrusted', { accessMode: 'readonly' }), { code: 'access-unsupported' })
  assert.throws(() => nativeExecutionParameters({ available: false }, 'agent', 'untrusted', { accessMode: 'full' }), { code: 'execution-unavailable' })
  assert.throws(() => nativeExecutionParameters({ available: true }, 'agent', 'untrusted', { accessMode: 'typo' }), { code: 'access-mode' })
})

test('readonly blocks dispatch and direct mutation methods, not just schemas', () => fixture(async (cwd) => {
  let approvals = 0
  const tools = new WorkspaceTools({ cwd, accessMode: 'readonly', approve: () => { approvals++; return true } })
  assert.deepEqual(readOnlyTools, WORKSPACE_TOOLS.filter((entry) => !['write_file', 'run_command'].includes(entry.function.name)))
  assert.equal((await tools.execute('write_file', { path: 'blocked.txt', content: 'blocked' })).code, 'access-readonly')
  assert.equal((await tools.execute('run_command', { command: command('process.exit(0)') })).code, 'access-readonly')
  await assert.rejects(tools.write_file({ path: 'blocked.txt', content: 'blocked' }), { code: 'access-readonly' })
  await assert.rejects(tools.run_command({ command: command('process.exit(0)') }), { code: 'access-readonly' })
  await assert.rejects(access(join(cwd, 'blocked.txt')), { code: 'ENOENT' })
  assert.equal(approvals, 0)
  assert.throws(() => new WorkspaceTools({ cwd, accessMode: 'typo' }), { code: 'access-mode' })
  tools.accessMode = 'typo'
  assert.equal((await tools.execute('get_environment')).code, 'access-mode')
}))

test('full bypasses only approval and retains boundaries, timeouts and cancellation', () => fixture(async (cwd) => {
  const tools = new WorkspaceTools({ cwd, accessMode: 'full', approve: () => assert.fail('full must not ask permission') })
  assert.equal((await tools.execute('write_file', { path: 'ok.txt', content: 'real write' })).ok, true)
  assert.equal(await readFile(join(cwd, 'ok.txt'), 'utf8'), 'real write')
  assert.equal((await tools.execute('write_file', { path: '../outside', content: 'x' })).code, 'path-outside')
  assert.equal((await tools.execute('write_file', { path: '.env', content: 'x' })).code, 'sensitive-file')
  assert.equal((await tools.execute('write_file', { path: 'large', content: 'x'.repeat(256 * 1024 + 1) })).code, 'file-too-large')
  assert.equal((await tools.execute('run_command', { command: command('process.exit(0)'), timeoutMs: 60001 })).code, 'arguments-invalid')
  assert.equal((await tools.execute('run_command', { command: command('console.log(123)'), timeoutMs: 15000 })).ok, true)
  const timeout = await tools.execute('run_command', { command: command('setTimeout(()=>{},10000)'), timeoutMs: 100 })
  assert.equal(timeout.timedOut, true)
  const controller = new AbortController()
  const cancelled = new WorkspaceTools({ cwd, signal: controller.signal, accessMode: 'full' })
  controller.abort()
  await assert.rejects(cancelled.execute('write_file', { path: 'cancelled.txt', content: 'no' }), { name: 'AbortError' })
  await assert.rejects(access(join(cwd, 'cancelled.txt')), { code: 'ENOENT' })
}))
