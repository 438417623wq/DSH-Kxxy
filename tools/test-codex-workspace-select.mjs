import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, access, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { CodexService } from '../plugins/dsh-codex-sidebar/lib/service.mjs'
import { WorkspaceTools, unifiedDiff } from '../plugins/dsh-codex-sidebar/lib/workspace-tools.mjs'
import { FileChanges } from '../plugins/dsh-codex-sidebar/lib/file-changes.mjs'
import { WorkspaceStore, listWorkspace, checkDirectoryName } from '../plugins/dsh-codex-sidebar/lib/workspace-state.mjs'
import { workspaceForSession } from '../plugins/dsh-codex-sidebar/lib/security.mjs'

const SECRET = 'workspace-select-provider-key'
const baseEnv = () => Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]]))
const missing = (path) => assert.rejects(access(path), { code: 'ENOENT' })

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}
// The provider is never called: these tests only create bindings and inspect workspace state.
async function stubProvider() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '未使用' }, finish_reason: 'stop' }] }))
  })
  return { origin: await listen(server), close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}

/**
 * Two sibling projects plus a private Codex home inside the same sandbox root so the deny list
 * (KXXY_CODEX_HOME / credentials / filesystem root) can be exercised without touching the host.
 */
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-select-')))
  const home = join(root, 'codex-home'), dsh = join(root, 'dsh')
  const workspaceA = join(root, 'alpha'), workspaceB = join(root, 'beta')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(dsh, { recursive: true })
  for (const directory of [workspaceA, workspaceB]) {
    await mkdir(directory)
    await writeFile(join(directory, 'README.md'), `# ${directory}\n`)
    await mkdir(join(directory, '.git'))
  }
  const env = { ...baseEnv(), HOME: root, USERPROFILE: root, KXXY_CODEX_HOME: home, DSH_HOME: dsh }
  const cwdA = await realpath(workspaceA), cwdB = await realpath(workspaceB)
  const defaults = { session: cwdA, 'other-session': cwdB }
  const ctx = { get: (name) => name === 'sessions' ? { get: (id) => (id in defaults ? { header: { id, cwd: defaults[id] } } : undefined) } : undefined }
  const provider = await stubProvider()
  const services = []
  const makeService = () => {
    const service = new CodexService({
      paths: { home, executable: null }, env,
      resolveWorkspace: (id, store) => workspaceForSession(ctx, id, { store, env }),
      probe: async () => assert.fail('workspace sessions must not probe the Codex CLI'),
      transportFactory: () => assert.fail('workspace sessions must not launch the Codex CLI'),
    })
    services.push(service)
    return service
  }
  const service = makeService()
  try { await run({ root, home, env, ctx, cwdA, cwdB, service, makeService, provider }) }
  finally {
    for (const entry of services) await entry.dispose()
    await provider.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function modelAndThread(service, provider, name = 'alpha-thread') {
  const model = await service.saveModel({ name: '工作区模型', model: 'workspace-model', baseUrl: `${provider.origin}/v1`, apiKey: SECRET, apiFormat: 'chat-completions' })
  const { thread } = await service.create('session', { model: model.id, mode: 'agent', effort: '' })
  await service.renameThread('session', { threadId: thread.id, title: name })
  return { model, thread }
}

test('workspace listing hides credential directories and refuses guarded or escaping paths', async () => {
  await fixture(async ({ root, home, env, ctx, cwdA, cwdB }) => {
    await mkdir(join(cwdA, '.ssh'))
    await writeFile(join(cwdA, '.ssh', 'id_ed25519'), 'PRIVATE KEY')
    await mkdir(join(cwdA, 'secrets'))
    await mkdir(join(cwdA, 'packages'))
    await mkdir(join(cwdA, '.env.d'))
    await writeFile(join(cwdA, 'plain.txt'), 'not a directory')
    await symlink(cwdB, join(cwdA, 'to-beta'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(home, join(cwdA, 'to-home'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(root, join(cwdA, 'to-root'), process.platform === 'win32' ? 'junction' : 'dir')

    const listing = await listWorkspace({ path: cwdA, env })
    const names = listing.entries.map((entry) => entry.name)
    assert.deepEqual(names.sort(), ['packages', 'to-beta', 'to-root'])
    assert.equal(listing.entries.find((entry) => entry.name === 'packages').isProject, false)
    assert.equal(listing.entries.find((entry) => entry.name === 'to-beta').isProject, true)
    assert.equal(listing.path, cwdA)
    assert.equal(listing.name, 'alpha')
    assert.equal(listing.parent, root)
    // Hidden, credential-named and denied-link targets are never offered.
    for (const hidden of ['.git', '.ssh', '.env.d', 'secrets', 'plain.txt', 'to-home']) assert.equal(names.includes(hidden), false, hidden)

    // The canonical guard runs before the listing: links cannot smuggle the deny list in.
    for (const [path, code] of [
      [home, 'workspace-denied'],
      [join(cwdA, 'to-home'), 'workspace-denied'],
      [parse(cwdA).root, 'workspace-denied'],
      [join(cwdA, '.ssh'), 'workspace-denied'],
      [join(cwdA, 'missing'), 'workspace-unavailable'],
      [join(cwdA, 'plain.txt'), 'workspace-invalid'],
    ]) await assert.rejects(listWorkspace({ path, env }), { code })
    await assert.rejects(listWorkspace({ path: 'relative/dir', env }), { code: 'workspace-invalid' })

    // The same rejections apply to the resolver the whole sidebar relies on.
    const store = await new WorkspaceStore(home, { env }).load()
    await store.setOverride('session', join(cwdA, 'to-home'))
    assert.equal(await workspaceForSession(ctx, 'session', { store, env }), cwdA)
    assert.equal(store.override('session'), null)
  })
})

test('switching the workspace detaches old threads and drops every one-shot grant', async () => {
  await fixture(async ({ cwdA, cwdB, service, provider, makeService, home, env }) => {
    const { thread } = await modelAndThread(service, provider)
    const challenge = await service.prepareAccess('session', { threadId: thread.id, mode: 'full' })
    await service.applyAccess('session', { threadId: thread.id, mode: 'full', token: challenge.token })
    let snapshot = await service.snapshot('session')
    assert.equal(snapshot.threads[0].access.mode, 'full')
    assert.equal(snapshot.workspace.override, false)
    assert.equal(snapshot.workspace.sessionDefault, cwdA)

    const selected = await service.selectWorkspace('session', { path: cwdB, pin: true })
    assert.equal(selected.cwd, cwdB)
    assert.equal(selected.override, true)
    assert.ok(selected.pinned.includes(cwdB))

    snapshot = await service.snapshot('session')
    assert.equal(snapshot.cwd, cwdB)
    assert.equal(snapshot.workspace.override, true)
    assert.equal(snapshot.workspace.name, 'beta')
    assert.equal(snapshot.threads.length, 0, 'threads from the previous directory must not leak in')
    assert.equal(snapshot.history.length, 1)
    assert.equal(snapshot.history[0].workspaceName, 'alpha')
    assert.equal(snapshot.history[0].active, false)
    // The binding is detached, so no action can reach it from the new workspace.
    await assert.rejects(service.prepareAccess('session', { threadId: thread.id, mode: 'full' }), { code: 'workspace-changed' })
    await assert.rejects(service.renameThread('session', { threadId: thread.id, title: 'x' }), { code: 'workspace-changed' })

    await service.selectWorkspace('session', { path: cwdA })
    snapshot = await service.snapshot('session')
    assert.equal(snapshot.threads.length, 1)
    assert.equal(snapshot.threads[0].id, thread.id)
    assert.equal(snapshot.history[0].active, true)
    assert.equal(snapshot.threads[0].access.mode, 'approval', 'full access must not survive a workspace switch')

    // The override is persisted privately and re-read by a fresh service instance.
    const restarted = makeService()
    await restarted.selectWorkspace('session', { path: cwdB })
    const stored = JSON.parse(await readFile(join(home, 'sidebar-workspaces.json'), 'utf8'))
    assert.equal(stored.sessions.session, cwdB)
    assert.equal((await restarted.snapshot('session')).cwd, cwdB)
    const reset = await restarted.selectWorkspace('session', { reset: true })
    assert.equal(reset.cwd, cwdA)
    assert.equal((await restarted.snapshot('session')).workspace.override, false)
    const mode = await import('node:fs/promises').then((fs) => fs.stat(join(home, 'sidebar-workspaces.json')))
    if (process.platform !== 'win32') assert.equal(mode.mode & 0o777, 0o600)
  })
})

test('session grants stay on one thread and are dropped by a workspace switch', async () => {
  await fixture(async ({ cwdA, cwdB, service, provider, home }) => {
    const { thread } = await modelAndThread(service, provider)
    assert.deepEqual(service.grantsFor(thread.id), { write: false, readonlyCommands: false })
    assert.deepEqual(service.setGrant(thread.id, 'write'), { write: true, readonlyCommands: false })
    assert.deepEqual(service.setGrant(thread.id, 'readonly-commands'), { write: true, readonlyCommands: true })
    assert.equal(service.setGrant(thread.id, 'everything'), null, 'unknown grant kinds are ignored')

    let snapshot = await service.snapshot('session')
    assert.deepEqual(snapshot.threads[0].grants, { write: true, readonlyCommands: true })
    // A grant lives in memory only; it must never reach the persisted binding file.
    assert.equal((await readFile(join(home, 'sidebar-threads.json'), 'utf8')).includes('readonlyCommands'), false)

    await service.selectWorkspace('session', { path: cwdB })
    await service.selectWorkspace('session', { path: cwdA })
    snapshot = await service.snapshot('session')
    assert.deepEqual(snapshot.threads[0].grants, { write: false, readonlyCommands: false }, 'a workspace switch revokes session grants')
  })
})

test('workspace directories are created one level at a time with validated names', async () => {
  await fixture(async ({ cwdA, service }) => {
    const created = await service.createWorkspaceDirectory('session', { name: '新项目' })
    assert.equal(created.path, join(cwdA, '新项目'))
    assert.equal(created.parent, cwdA)
    assert.equal((await stat(join(cwdA, '新项目'))).isDirectory(), true)
    await assert.rejects(service.createWorkspaceDirectory('session', { name: '新项目' }), { code: 'workspace-exists' })
    for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b', 'a\u0000b', '.ssh', 'secrets', 'key.pem', 'tail.']) {
      await assert.rejects(service.createWorkspaceDirectory('session', { name }), { code: 'workspace-name' }, `rejects ${JSON.stringify(name)}`)
    }
    assert.throws(() => checkDirectoryName('x'.repeat(65)), { code: 'workspace-name' })
    assert.throws(() => checkDirectoryName('a/b'), { code: 'workspace-name' })
    assert.equal(checkDirectoryName('  合法目录  '), '合法目录')
    const nested = await service.createWorkspaceDirectory('session', { parentPath: cwdA, name: 'nested' })
    assert.equal(nested.path, join(cwdA, 'nested'))
    await assert.rejects(service.createWorkspaceDirectory('session', { parentPath: join(cwdA, 'missing'), name: 'x' }), { code: 'workspace-unavailable' })
  })
})

test('edit_file requires a unique match, reports both failure modes and stays undoable', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-edit-')))
  const cwd = join(root, 'workspace'), home = join(root, 'home')
  try {
  await mkdir(cwd)
  const binding = { id: 'thread', sessionId: 'session', cwd, model: 'model', providerId: 'provider', providerRevision: 'revision', engine: 'workspace', mode: 'agent' }
  const changes = await new FileChanges(home).load()
  const items = []
  const tools = new WorkspaceTools({ cwd, approve: async () => true, journal: changes.adapter({ binding, turnId: 'turn' }), onItem: (item) => items.push(item) })
  await writeFile(join(cwd, 'app.js'), 'const a = 1\nconst b = 2\nrepeat()\nrepeat()\n')

  const absent = await tools.execute('edit_file', { path: 'app.js', edits: [{ oldText: 'not present', newText: 'x' }] })
  assert.equal(absent.ok, false)
  assert.equal(absent.code, 'edit-not-found')
  assert.match(absent.error, /第 1 个替换项/)
  const ambiguous = await tools.execute('edit_file', { path: 'app.js', edits: [{ oldText: 'repeat()', newText: 'run()' }] })
  assert.equal(ambiguous.code, 'edit-ambiguous')
  assert.match(ambiguous.error, /2 次/)
  assert.equal(await readFile(join(cwd, 'app.js'), 'utf8'), 'const a = 1\nconst b = 2\nrepeat()\nrepeat()\n')

  const applied = await tools.execute('edit_file', { path: 'app.js', edits: [{ oldText: 'const a = 1', newText: 'const a = 10' }, { oldText: 'const b = 2', newText: 'const b = 20' }] })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.kind, 'update')
  assert.equal(await readFile(join(cwd, 'app.js'), 'utf8'), 'const a = 10\nconst b = 20\nrepeat()\nrepeat()\n')

  // One bad edit in a batch aborts the whole batch: nothing is half-applied.
  const partial = await tools.execute('edit_file', { path: 'app.js', edits: [{ oldText: 'repeat()\nrepeat()', newText: 'once()' }, { oldText: 'gone', newText: 'x' }] })
  assert.equal(partial.code, 'edit-not-found')
  assert.equal(await readFile(join(cwd, 'app.js'), 'utf8'), 'const a = 10\nconst b = 20\nrepeat()\nrepeat()\n')

  // The diff the reader sees in the timeline is a real hunk diff, not a whole-file dump.
  const changeItem = items.findLast((item) => item.type === 'fileChange' && item.status === 'completed')
  const shownDiff = changeItem.changes[0].diff
  assert.match(shownDiff, /^@@ -\d+,\d+ \+\d+,\d+ @@/m)
  assert.match(shownDiff, /^-const a = 1$/m)
  assert.match(shownDiff, /^\+const a = 10$/m)
  assert.match(shownDiff, /^-const b = 2$/m)
  assert.match(shownDiff, /^\+const b = 20$/m)
  assert.match(shownDiff, /^ repeat\(\)$/m)

  const preview = await changes.preview({ binding, turnId: 'turn' })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(preview.files.length, 1)
  assert.equal(preview.files[0].path, 'app.js')
  assert.equal(preview.files[0].kind, 'update')
  assert.equal(preview.files[0].diff, undefined, 'previews must not leak file contents')
  const reverted = await changes.revert({ binding, turnId: 'turn', token: preview.token, requestId: 'request' })
  assert.equal(reverted.ok, true, JSON.stringify(reverted))
  assert.equal(await readFile(join(cwd, 'app.js'), 'utf8'), 'const a = 1\nconst b = 2\nrepeat()\nrepeat()\n')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('read_file ranges, find_files and regex search stay inside the workspace', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-read-')))
  const cwd = join(root, 'workspace')
  try {
    await mkdir(join(cwd, 'src'), { recursive: true })
    await mkdir(join(cwd, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(cwd, 'src', 'a.ts'), 'line1\nline2\nline3\nline4\n')
    await writeFile(join(cwd, 'src', 'b.md'), '# title\nTARGET\n')
    await writeFile(join(cwd, 'node_modules', 'pkg', 'index.js'), 'TARGET')
    await writeFile(join(cwd, '.env'), 'TARGET=secret')
    const tools = new WorkspaceTools({ cwd, approve: () => assert.fail('read-only tools must not ask permission') })
    const range = await tools.execute('read_file', { path: 'src/a.ts', startLine: 2, endLine: 3 })
    assert.equal(range.text, '2| line2\n3| line3')
    assert.equal(range.startLine, 2)
    assert.equal(range.endLine, 3)
    assert.equal(range.totalLines, 5)
    // Out-of-range and inverted requests clamp instead of failing: the model always gets text back.
    assert.equal((await tools.execute('read_file', { path: 'src/a.ts', startLine: 9 })).text, '')
    assert.equal((await tools.execute('read_file', { path: 'src/a.ts', startLine: 3, endLine: 1 })).text, '3| line3')

    const found = await tools.execute('find_files', { pattern: '*.md' })
    assert.deepEqual(found.files.map((entry) => entry.path), ['src/b.md'])
    assert.deepEqual((await tools.execute('find_files', { pattern: '*.ts' })).files.map((entry) => entry.path), ['src/a.ts'])
    assert.deepEqual((await tools.execute('find_files', { pattern: 'src/*.md' })).files.map((entry) => entry.path), ['src/b.md'])
    assert.equal((await tools.execute('find_files', { pattern: 'nomatch' })).files.length, 0)
    assert.equal((await tools.execute('find_files', { pattern: '*' })).files.some((entry) => entry.path.startsWith('node_modules')), false)
    assert.equal((await tools.execute('find_files', { pattern: '*' })).files.some((entry) => entry.path === '.env'), false)

    const regex = await tools.execute('search_files', { query: 'T[A-Z]+GET', regex: true })
    assert.deepEqual(regex.matches.map((entry) => entry.path).sort(), ['src/b.md'])
    assert.equal((await tools.execute('search_files', { query: '(', regex: true })).code, 'arguments-invalid')
    assert.equal((await tools.execute('find_files', { pattern: '../*' })).code, 'arguments-invalid')
    assert.equal((await tools.execute('find_files', { pattern: '*', path: '..' })).code, 'path-outside')
    assert.equal(JSON.stringify(await tools.execute('get_environment', {})).includes(SECRET), false)
    assert.equal((await tools.execute('get_environment', {})).capabilities.commandTimeoutMaxMs, 180000)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('unifiedDiff emits real hunks with three lines of context', () => {
  const before = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
  const after = before.replace('line 2\n', 'line two\n').replace('line 9\n', 'line nine\n')
  const diff = unifiedDiff('src/app.js', before, after, false)
  const lines = diff.split('\n')
  assert.equal(lines[0], '--- a/src/app.js')
  assert.equal(lines[1], '+++ b/src/app.js')
  const hunks = lines.filter((line) => line.startsWith('@@'))
  assert.equal(hunks.length, 2, 'distant edits must not collapse into one hunk')
  assert.equal(hunks[0], '@@ -1,5 +1,5 @@')
  assert.equal(hunks[1], '@@ -6,7 +6,7 @@')
  assert.deepEqual(lines.slice(3, 9), [' line 1', '-line 2', '+line two', ' line 3', ' line 4', ' line 5'])
  assert.deepEqual(lines.slice(9), ['@@ -6,7 +6,7 @@', ' line 6', ' line 7', ' line 8', '-line 9', '+line nine', ' line 10', ' line 11', ' line 12', ''])
  assert.match(diff, /^-line 9$/m)
  assert.match(diff, /^\+line nine$/m)

  // A single edit far into a long file still carries exactly three context lines per side.
  const long = Array.from({ length: 40 }, (_, index) => `row ${index + 1}`).join('\n')
  const narrow = unifiedDiff('big.txt', long, long.replace('row 20', 'changed'), false)
  assert.deepEqual(narrow.split('\n').slice(3), [
    ' row 17', ' row 18', ' row 19', '-row 20', '+changed', ' row 21', ' row 22', ' row 23', '',
  ])

  // New files use the /dev/null header and a zero-length old range.
  const added = unifiedDiff('new.txt', '', 'a\nb\n', true)
  assert.equal(added.split('\n')[0], '--- /dev/null')
  assert.match(added, /^@@ -0,0 \+1,2 @@$/m)
  assert.match(added, /^\+a$/m)
  // Missing trailing newlines are marked instead of silently normalized away.
  assert.match(unifiedDiff('t.txt', 'x', 'y', false), /\\ No newline at end of file/)
  // Identical content produces headers only, never a bogus hunk.
  assert.equal(unifiedDiff('same.txt', 'a\n', 'a\n', false), '--- a/same.txt\n+++ b/same.txt\n')
})

test('thread rename and delete only touch sidebar bindings', async () => {
  await fixture(async ({ cwdA, service, provider, makeService }) => {
    const { thread } = await modelAndThread(service, provider, '第一版标题')
    const renamed = await service.renameThread('session', { threadId: thread.id, title: '  新标题  ' })
    assert.equal(renamed.title, '新标题')
    assert.equal((await service.snapshot('session')).history[0].title, '新标题')
    for (const title of ['', '   ', 'x'.repeat(81), 'bad\u0000title']) {
      await assert.rejects(service.renameThread('session', { threadId: thread.id, title }), { code: 'title-invalid' }, `rejects ${JSON.stringify(title)}`)
    }
    await assert.rejects(service.renameThread('other-session', { threadId: thread.id, title: 'x' }), { code: 'thread-forbidden' })

    // Renames survive a restart because they live in the binding file, not in memory.
    const restarted = makeService()
    assert.equal((await restarted.snapshot('session')).history[0].title, '新标题')

    assert.deepEqual(await restarted.deleteThread('session', { threadId: thread.id }), { ok: true, threadId: thread.id })
    const snapshot = await restarted.snapshot('session')
    assert.equal(snapshot.history.length, 0)
    assert.equal(snapshot.threads.length, 0)
    await assert.rejects(restarted.deleteThread('session', { threadId: thread.id }), { code: 'thread-forbidden' })
    // Deleting a conversation never removes workspace files.
    await access(join(cwdA, 'README.md'))
    await missing(join(cwdA, 'deleted-thread'))
  })
})
