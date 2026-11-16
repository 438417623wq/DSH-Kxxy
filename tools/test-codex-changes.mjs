import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, readFile, access, realpath, lstat, chmod, symlink, link, readdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { FileChanges } from '../plugins/dsh-codex-sidebar/lib/file-changes.mjs'
import { WorkspaceTools } from '../plugins/dsh-codex-sidebar/lib/workspace-tools.mjs'

const hash = (data) => createHash('sha256').update(data).digest('hex')
async function fixture(run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-changes-'))
  const workspace = join(root, 'workspace'), home = join(root, 'home')
  await mkdir(workspace)
  const cwd = await realpath(workspace)
  const binding = { id: 'thread', sessionId: 'session', cwd, model: 'model', providerId: 'provider', providerRevision: 'revision', engine: 'workspace', mode: 'agent' }
  const changes = await new FileChanges(home, options).load()
  const tools = (turnId, extra = {}) => new WorkspaceTools({ cwd, approve: async () => true, journal: changes.adapter({ binding, turnId, signal: extra.signal }), ...extra })
  try { await run({ root, home, cwd, binding, changes, tools }) } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}
const missing = (path) => assert.rejects(access(path), { code: 'ENOENT' })
async function undo(changes, binding, turnId, requestId = 'request') {
  const preview = await changes.preview({ binding, turnId })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  return changes.revert({ binding, turnId, token: preview.token, requestId })
}
const write = (tools, path, content) => tools.execute('write_file', { path, content })

test('journal restores updates, removes additions, merges first-before/latest-after and persists privately', () => fixture(async ({ home, cwd, binding, changes, tools }) => {
  await writeFile(join(cwd, 'old.txt'), 'ORIGINAL private-text\n', { mode: 0o640 })
  const mode = (await lstat(join(cwd, 'old.txt'))).mode & 0o777
  const tool = tools('turn')
  assert.equal((await write(tool, 'old.txt', 'step one')).ok, true)
  assert.equal((await write(tool, 'old.txt', 'step two')).ok, true)
  assert.equal((await write(tool, 'new.txt', 'added')).ok, true)
  assert.equal((await write(tool, 'new.txt', 'added again')).ok, true)
  const metadata = await changes.describe(binding.id, 'turn')
  assert.equal(metadata.available, true)
  assert.equal(metadata.files.length, 2)
  assert.doesNotMatch(JSON.stringify(metadata), /ORIGINAL|private-text|step two|token|diff|beforeHash/)
  const directory = join(home, 'codex-change-journal'), journal = join(directory, 'journal.json')
  if (process.platform !== 'win32') {
    assert.equal((await lstat(directory)).mode & 0o777, 0o700)
    assert.equal((await lstat(journal)).mode & 0o777, 0o600)
  }
  const reopened = await new FileChanges(home).load()
  assert.equal((await reopened.describe(binding.id, 'turn')).available, true)
  const preview = await reopened.preview({ binding, turnId: 'turn' })
  assert.equal(JSON.stringify(preview).includes('ORIGINAL'), false)
  const wrong = { ...binding, id: 'other-thread' }
  await assert.rejects(reopened.revert({ binding: wrong, turnId: 'turn', token: preview.token, requestId: 'request' }), { code: 'changes-token' })
  const result = await reopened.revert({ binding, turnId: 'turn', token: preview.token, requestId: 'request' })
  assert.equal(result.ok, true)
  assert.deepEqual(await reopened.revert({ binding, turnId: 'turn', token: preview.token, requestId: 'request' }), result)
  await assert.rejects(reopened.revert({ binding, turnId: 'turn', token: preview.token, requestId: 'other' }), { code: 'changes-token' })
  assert.equal(await readFile(join(cwd, 'old.txt'), 'utf8'), 'ORIGINAL private-text\n')
  assert.equal((await lstat(join(cwd, 'old.txt'))).mode & 0o777, mode)
  await missing(join(cwd, 'new.txt'))
  assert.equal((await reopened.describe(binding.id, 'turn')).status, 'reverted')
  assert.deepEqual(await readdir(directory), ['journal.json'])
}))

test('approval refusal, stale writes, cancellation and unavailable journals prevent target mutation', () => fixture(async ({ cwd, changes, tools }) => {
  assert.equal((await write(tools('refused', { approve: () => false }), 'no.txt', 'no')).code, 'approval-declined')
  await missing(join(cwd, 'no.txt'))
  assert.equal((await changes.describe('thread', 'refused')).available, false)
  await writeFile(join(cwd, 'race.txt'), 'before')
  const race = tools('race', { approve: async () => { await writeFile(join(cwd, 'race.txt'), 'external'); return true } })
  assert.equal((await write(race, 'race.txt', 'after')).code, 'file-changed')
  assert.equal(await readFile(join(cwd, 'race.txt'), 'utf8'), 'external')
  const controller = new AbortController()
  const cancelled = tools('cancel', { signal: controller.signal, approve: async () => { controller.abort(); return true } })
  await assert.rejects(write(cancelled, 'cancel.txt', 'no'), { name: 'AbortError' })
  await missing(join(cwd, 'cancel.txt'))
  let failed = 0
  const bad = tools('unavailable', { journal: { prepareWrite: async () => { throw Object.assign(new Error('unavailable'), { code: 'changes-unavailable' }) }, commitWrite: async () => assert.fail(), failWrite: async () => { failed++ } } })
  assert.equal((await write(bad, 'bad.txt', 'no')).code, 'changes-unavailable')
  await missing(join(cwd, 'bad.txt'))
  assert.equal(failed, 0)
  let failToken
  const mid = new AbortController()
  const abortJournal = tools('abort-journal', { signal: mid.signal, journal: { prepareWrite: async () => { mid.abort(); return 'prepared-token' }, commitWrite: async () => assert.fail(), failWrite: async (token) => { failToken = token } } })
  await assert.rejects(write(abortJournal, 'abort.txt', 'no'), { name: 'AbortError' })
  assert.equal(failToken, 'prepared-token')
  await missing(join(cwd, 'abort.txt'))
}))

test('all-files preflight preserves every file on conflicts and old turns remain superseded', () => fixture(async ({ cwd, binding, changes, tools }) => {
  await writeFile(join(cwd, 'a.txt'), 'before a')
  await writeFile(join(cwd, 'b.txt'), 'before b')
  await write(tools('turn'), 'a.txt', 'after a')
  await write(tools('turn'), 'b.txt', 'after b')
  const preview = await changes.preview({ binding, turnId: 'turn' })
  await writeFile(join(cwd, 'b.txt'), 'external')
  const result = await changes.revert({ binding, turnId: 'turn', token: preview.token, requestId: 'conflict' })
  assert.equal(result.status, 'conflict')
  assert.equal(result.files.length, 0)
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'after a')
  assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'external')
  assert.equal((await changes.preview({ binding, turnId: 'turn' })).status, 'conflict')
  await write(tools('later'), 'a.txt', 'later')
  assert.equal((await changes.describe(binding.id, 'turn')).status, 'conflict')
  assert.equal((await undo(changes, binding, 'later')).ok, true)
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'after a')
  assert.equal((await changes.preview({ binding, turnId: 'turn' })).status, 'conflict')
}))

test('pending before/after images reconcile safely across restart after rename/commit failure', () => fixture(async ({ home, cwd, binding, changes, tools }) => {
  const journal = changes.adapter({ binding, turnId: 'committed-file' })
  const broken = tools('committed-file', { journal: { ...journal, commitWrite: async () => { throw Object.assign(new Error('commit failed'), { code: 'changes-unavailable' }) } } })
  const written = await write(broken, 'applied.txt', 'new actual bytes')
  assert.equal(written.ok, false)
  assert.equal(written.writeApplied, true)
  assert.equal(await readFile(join(cwd, 'applied.txt'), 'utf8'), 'new actual bytes')
  const pending = JSON.parse(await readFile(join(home, 'codex-change-journal', 'journal.json'), 'utf8')).data.pending
  assert.equal(pending.length, 1)
  const restarted = await new FileChanges(home).load()
  assert.equal((await restarted.describe(binding.id, 'committed-file')).available, true)
  assert.equal((await undo(restarted, binding, 'committed-file')).ok, true)
  await missing(join(cwd, 'applied.txt'))
  const before = Buffer.from('unchanged')
  await writeFile(join(cwd, 'before.txt'), before, { mode: 0o600 })
  await restarted.prepareWrite({ binding, turnId: 'not-applied', itemId: 'item', cwd, path: 'before.txt', before, beforeHash: hash(before), after: Buffer.from('never written'), afterHash: hash('never written'), mode: (await lstat(join(cwd, 'before.txt'))).mode & 0o777 })
  const again = await new FileChanges(home).load()
  assert.equal((await again.describe(binding.id, 'not-applied')).status, 'unavailable')
  assert.equal(await readFile(join(cwd, 'before.txt'), 'utf8'), 'unchanged')
}))

test('corrupt and externally changed journals fail closed without leaking before content', () => fixture(async ({ home, cwd, binding, changes, tools }) => {
  await write(tools('turn'), 'file.txt', 'current')
  await writeFile(join(home, 'codex-change-journal', 'journal.json'), '{broken')
  const broken = await new FileChanges(home).load()
  assert.equal((await broken.describe(binding.id, 'turn')).available, false)
  await assert.rejects(broken.preview({ binding, turnId: 'turn' }), { code: 'changes-unavailable' })
  const noWrite = new WorkspaceTools({ cwd, approve: () => true, journal: broken.adapter({ binding, turnId: 'new' }) })
  assert.equal((await write(noWrite, 'blocked.txt', 'no')).code, 'changes-unavailable')
  await missing(join(cwd, 'blocked.txt'))
  assert.equal((await write(tools('external-journal'), 'also-blocked.txt', 'no')).code, 'changes-unavailable')
  await missing(join(cwd, 'also-blocked.txt'))
  assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'current')
}))

test('bounded journal refuses more records and bytes without modifying files', async () => {
  await fixture(async ({ cwd, tools }) => {
    assert.equal((await write(tools('one'), 'one.txt', 'one')).ok, true)
    assert.equal((await write(tools('two'), 'two.txt', 'two')).code, 'changes-bounds')
    await missing(join(cwd, 'two.txt'))
  }, { maxEntries: 1 })
  await fixture(async ({ cwd, tools }) => {
    await writeFile(join(cwd, 'large.txt'), 'x'.repeat(4096))
    assert.equal((await write(tools('one'), 'large.txt', 'replacement')).code, 'changes-bounds')
    assert.equal((await readFile(join(cwd, 'large.txt'))).length, 4096)
  }, { maxBytes: 2048 })
})

test('undo rejects hardlinks, directory symlinks, credentials and non-text targets', () => fixture(async ({ cwd, binding, changes, tools }) => {
  await write(tools('hard'), 'hard.txt', 'after')
  await link(join(cwd, 'hard.txt'), join(cwd, 'linked.txt'))
  assert.equal((await changes.preview({ binding, turnId: 'hard' })).status, 'conflict')
  await mkdir(join(cwd, 'dir'))
  await write(tools('symlink'), 'dir/file.txt', 'after')
  await mkdir(join(cwd, 'other'))
  await writeFile(join(cwd, 'other', 'file.txt'), 'after')
  await rm(join(cwd, 'dir'), { recursive: true })
  await symlink(join(cwd, 'other'), join(cwd, 'dir'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await changes.preview({ binding, turnId: 'symlink' })).status, 'conflict')
  assert.equal((await write(tools('credentials'), '.env', 'secret')).code, 'sensitive-file')
  await mkdir(join(cwd, 'codex-change-journal'))
  assert.equal((await write(tools('private'), 'codex-change-journal/file', 'secret')).code, 'sensitive-file')
  await write(tools('binary'), 'binary.txt', 'text')
  await writeFile(join(cwd, 'binary.txt'), Buffer.from([0, 1]))
  assert.equal((await changes.preview({ binding, turnId: 'binary' })).status, 'conflict')
}))

test('undo tokens are scoped, expire, revoke and do not survive restart', async () => {
  let now = 10
  await fixture(async ({ home, binding, changes, tools }) => {
    await write(tools('turn'), 'file.txt', 'after')
    const first = await changes.preview({ binding, turnId: 'turn' })
    await assert.rejects(changes.revert({ binding: { ...binding, sessionId: 'other' }, turnId: 'turn', token: first.token, requestId: 'request' }), { code: 'changes-token' })
    now += 120000
    await assert.rejects(changes.revert({ binding, turnId: 'turn', token: first.token, requestId: 'request' }), { code: 'changes-expired' })
    const next = await changes.preview({ binding, turnId: 'turn' })
    changes.invalidate(binding.id)
    await assert.rejects(changes.revert({ binding, turnId: 'turn', token: next.token, requestId: 'request' }), { code: 'changes-token' })
    const fresh = await changes.preview({ binding, turnId: 'turn' })
    const restarted = await new FileChanges(home).load()
    await assert.rejects(restarted.revert({ binding, turnId: 'turn', token: fresh.token, requestId: 'request' }), { code: 'changes-token' })
    assert.equal((await changes.describe(binding.id, 'native-no-journal')).status, 'unavailable')
  }, { now: () => now })
})

test('execution-stage failure reports partial success and never silently claims all reverted', () => fixture(async ({ cwd, binding, changes, tools }) => {
  await write(tools('turn'), 'first.txt', 'added first')
  await write(tools('turn'), 'second.txt', 'added second')
  const preview = await changes.preview({ binding, turnId: 'turn' })
  const original = WorkspaceTools.prototype.writable
  let calls = 0
  WorkspaceTools.prototype.writable = async function (path) {
    const result = await original.call(this, path)
    if (path === 'second.txt' && ++calls === 2) await writeFile(join(cwd, 'second.txt'), 'concurrent change')
    return result
  }
  let result
  try { result = await changes.revert({ binding, turnId: 'turn', token: preview.token, requestId: 'partial' }) }
  finally { WorkspaceTools.prototype.writable = original }
  assert.equal(result.status, 'partial')
  assert.equal(result.ok, false)
  assert.deepEqual(result.files.map((file) => file.path), ['first.txt'])
  await missing(join(cwd, 'first.txt'))
  assert.equal(await readFile(join(cwd, 'second.txt'), 'utf8'), 'concurrent change')
  assert.equal((await changes.describe(binding.id, 'turn')).status, 'partial')
}))

test('linked or non-private journal storage never authorizes file mutation', async () => {
  await fixture(async ({ home, cwd, binding }) => {
    const journal = join(home, 'codex-change-journal', 'journal.json')
    const outside = join(home, 'outside.json')
    await writeFile(outside, '{}', { mode: 0o600 })
    await link(outside, journal)
    const linked = await new FileChanges(home).load()
    const tools = new WorkspaceTools({ cwd, approve: () => true, journal: linked.adapter({ binding, turnId: 'linked' }) })
    assert.equal((await write(tools, 'blocked.txt', 'no')).code, 'changes-unavailable')
    await missing(join(cwd, 'blocked.txt'))
    assert.equal(await readFile(outside, 'utf8'), '{}')
  })
  await fixture(async ({ home, cwd, binding }) => {
    await rm(join(home, 'codex-change-journal'), { recursive: true })
    const outside = join(home, 'outside-dir')
    await mkdir(outside, { mode: 0o700 })
    await symlink(outside, join(home, 'codex-change-journal'), process.platform === 'win32' ? 'junction' : 'dir')
    const linked = await new FileChanges(home).load()
    const tools = new WorkspaceTools({ cwd, approve: () => true, journal: linked.adapter({ binding, turnId: 'linked' }) })
    assert.equal((await write(tools, 'blocked.txt', 'no')).code, 'changes-unavailable')
    await missing(join(cwd, 'blocked.txt'))
    assert.deepEqual(await readdir(outside), [])
  })
  if (process.platform !== 'win32') await fixture(async ({ home, changes, binding, tools }) => {
    await write(tools('turn'), 'file.txt', 'after')
    await chmod(join(home, 'codex-change-journal', 'journal.json'), 0o644)
    const exposed = await new FileChanges(home).load()
    assert.equal((await exposed.describe(binding.id, 'turn')).available, false)
  })
})
