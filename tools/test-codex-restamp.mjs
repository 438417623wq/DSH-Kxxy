import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'
import { ZipWriter } from './lib/zipwrite.mjs'
import { readPluginFiles } from './lib/assemble.mjs'
import { stampCodexPlugin, CODEX_PLUGIN_BASE } from './lib/codex.mjs'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('./restamp-codex-plugin.mjs', import.meta.url))
const plugin = fileURLToPath(new URL('../plugins/dsh-codex-sidebar', import.meta.url))

function entriesOf(raw) {
  const end = raw.length - 22
  assert.equal(raw.readUInt32LE(end), 0x06054b50)
  const count = raw.readUInt16LE(end + 10)
  const cdOffset = raw.readUInt32LE(end + 16)
  const files = new Map()
  let at = cdOffset
  for (let index = 0; index < count; index += 1) {
    assert.equal(raw.readUInt32LE(at), 0x02014b50)
    const nameLength = raw.readUInt16LE(at + 28)
    const extraLength = raw.readUInt16LE(at + 30)
    const commentLength = raw.readUInt16LE(at + 32)
    const name = raw.toString('utf8', at + 46, at + 46 + nameLength)
    assert.ok(!files.has(name))
    const offset = raw.readUInt32LE(at + 42)
    assert.equal(raw.readUInt32LE(offset), 0x04034b50)
    const localNameLength = raw.readUInt16LE(offset + 26)
    const localExtraLength = raw.readUInt16LE(offset + 28)
    assert.equal(raw.toString('utf8', offset + 30, offset + 30 + localNameLength), name)
    const csize = raw.readUInt32LE(at + 20)
    const method = raw.readUInt16LE(at + 10)
    assert.equal(raw.readUInt16LE(offset + 8), method)
    assert.equal(raw.readUInt32LE(offset + 18), csize)
    const start = offset + 30 + localNameLength + localExtraLength
    const packed = raw.subarray(start, start + csize)
    files.set(name, { offset, extent: 30 + localNameLength + localExtraLength + csize, data: method === 8 ? inflateRawSync(packed) : packed, local: raw.subarray(offset, start + csize) })
    at += 46 + nameLength + extraLength + commentLength
  }
  assert.equal(at, end)
  let expected = 0
  for (const entry of [...files.values()].sort((a, b) => a.offset - b.offset)) { assert.equal(entry.offset, expected, 'no orphan local records'); expected += entry.extent }
  assert.equal(expected, cdOffset)
  return files
}

test('incremental restamp registers added modules, removes stale modules and preserves unrelated records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-restamp-'))
  try {
    const chunks = []
    const zip = new ZipWriter((data) => chunks.push(Buffer.from(data)))
    await zip.add('unrelated.txt', Buffer.from('unchanged content'), { comment: 'preserve this metadata' })
    await zip.add(`${CODEX_PLUGIN_BASE}lib/client.js`, Buffer.from('// old client'))
    await zip.add(`${CODEX_PLUGIN_BASE}lib/removed.mjs`, Buffer.from('// obsolete'))
    await zip.add('kxxy-runtime.json', Buffer.from(JSON.stringify({ schema: 1, plugins: { codexFingerprint: 'old', other: 'kept' } })))
    zip.finish()
    const input = join(root, 'original.zip')
    await writeFile(input, Buffer.concat(chunks))
    await writeFile(join(root, 'alias-links.txt'), 'lib/example\tlib/target\n')
    const meta = join(root, 'build.json')
    await writeFile(meta, JSON.stringify({ untouched: true }))
    const out = join(root, 'next', 'runtime.zip')
    await execute(process.execPath, [script, '--in', input, '--out', out, '--meta', meta, '--plugin', plugin], { timeout: 30000 })
    const original = entriesOf(await readFile(input))
    const actual = entriesOf(await readFile(out))
    assert.equal(actual.has(`${CODEX_PLUGIN_BASE}lib/removed.mjs`), false)
    assert.deepEqual(actual.get('unrelated.txt').local, original.get('unrelated.txt').local)
    const expected = new Map()
    readPluginFiles(plugin, expected, CODEX_PLUGIN_BASE)
    const fingerprint = stampCodexPlugin(expected)
    for (const [name, entry] of expected) assert.deepEqual(actual.get(name)?.data, entry.data, name)
    assert.equal(actual.size, expected.size + 2)
    const metadata = JSON.parse(await readFile(meta, 'utf8'))
    assert.equal(metadata.codexPluginFingerprint, fingerprint)
    assert.equal(metadata.runtimeEntries, actual.size)
    assert.equal(metadata.untouched, true)
    const manifest = JSON.parse(actual.get('kxxy-runtime.json').data.toString('utf8'))
    assert.equal(manifest.plugins.codexFingerprint, fingerprint)
    assert.equal(manifest.plugins.other, 'kept')
    assert.equal(await readFile(join(root, 'next', 'alias-links.txt'), 'utf8'), 'lib/example\tlib/target\n')
    const frozen = await readFile(out)
    await assert.rejects(execute(process.execPath, [script, '--in', input, '--out', out, '--meta', meta, '--plugin', plugin]))
    assert.deepEqual(await readFile(out), frozen, 'existing runtime must not be overwritten')
    assert.equal((await readdir(join(root, 'next'))).some((name) => name.includes('.tmp-')), false)
    const checked = await execute(process.execPath, [script, '--in', out, '--check-only', '--plugin', plugin])
    assert.ok(checked.stdout.includes('未写出任何文件'))
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
