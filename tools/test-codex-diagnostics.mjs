import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexService } from '../plugins/dsh-codex-sidebar/lib/service.mjs'

const SECRET = 'diagnostic-private-provider-key'
const entry = { name: '测试模型', model: 'test-model', baseUrl: 'https://provider.invalid/v1', apiKey: SECRET, apiFormat: 'chat-completions', engine: 'workspace' }
const reply = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })

async function fixture(fn, fetchImpl = async () => reply()) {
  const root = await mkdtemp(join(tmpdir(), 'codex-diagnostics-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const cwd = await realpath(workspace)
  const service = new CodexService({ paths: { home: join(root, 'home') }, resolveWorkspace: async () => cwd, env: {}, fetchImpl })
  try { await fn(service) } finally { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

test('model diagnostics belong to the saved configuration and invalidate after credential changes', async () => {
  let requests = 0
  await fixture(async (service) => {
    const saved = await service.saveModel(entry)
    assert.equal(requests, 0, 'saving models must never initiate provider traffic')
    assert.equal(service.status().customModels[0].diagnostic, undefined)
    const report = await service.inspectModel({ id: saved.id, check: 'text' })
    assert.equal(report.ok, true)
    const status = service.status()
    assert.equal(status.customModels[0].diagnostic.ok, true)
    assert.equal(status.customModels[0].diagnostic.configVersion, saved.configVersion)
    assert.equal(status.models[0].configVersion, status.customModels[0].configVersion)
    await service.inspectModel({ id: saved.id, check: 'text', model: 'unsaved-draft-model' })
    assert.equal(service.status().customModels[0].diagnostic.model, 'test-model', 'draft tests must not replace saved model diagnostics')
    const updated = await service.saveModel({ ...entry, id: saved.id, apiKey: 'rotated-diagnostic-key' })
    assert.notEqual(updated.configVersion, saved.configVersion)
    assert.equal(service.status().customModels[0].diagnostic, undefined)
    assert.ok(!JSON.stringify(service.status()).includes(SECRET))
    assert.equal(requests, 2)
  }, async () => { requests += 1; return reply() })
})

test('a check completing after an edit cannot certify the replacement configuration', async () => {
  let release
  let started
  const entered = new Promise((resolve) => { started = resolve })
  await fixture(async (service) => {
    const saved = await service.saveModel(entry)
    const pending = service.inspectModel({ id: saved.id, check: 'text' })
    await entered
    await assert.rejects(service.inspectModel({ id: saved.id, check: 'text' }), { code: 'model-check-busy' })
    await service.saveModel({ ...entry, id: saved.id, apiKey: 'changed-during-test' })
    release(reply())
    await pending
    assert.equal(service.status().customModels[0].diagnostic, undefined)
  }, async () => { started(); return new Promise((resolve) => { release = resolve }) })
})

test('disposing a model check cancels its upstream request and keeps no successful diagnostic', async () => {
  let started
  let aborted = false
  const entered = new Promise((resolve) => { started = resolve })
  await fixture(async (service) => {
    const saved = await service.saveModel(entry)
    const pending = service.inspectModel({ id: saved.id, check: 'stream' }).then(() => null, (error) => error)
    await entered
    await service.dispose()
    const error = await pending
    assert.ok(error)
    assert.equal(aborted, true)
    assert.equal(service.modelChecks.size, 0)
    assert.equal(service.status().customModels[0].diagnostic, undefined)
  }, async (url, options) => {
    started()
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason) }, { once: true }))
  })
})

test('provider replay and credential-bearing fields never leave the service snapshot', async () => {
  await fixture(async (service) => {
    const saved = await service.saveModel({ ...entry, headers: { 'x-project': 'private-project' }, query: { tenant: 'private-tenant' } })
    const { thread } = await service.create('session', { model: saved.id, effort: '', mode: 'chat', engine: 'workspace' })
    service.threads.get(thread.id).turns.push({ id: 'turn', status: 'completed', providerMessages: [{ role: 'assistant', provider_replay: { apiFormat: 'anthropic-messages', content: [{ type: 'thinking', thinking: 'internal', signature: 'private-signature' }] } }], items: [{ id: 'agent', type: 'agentMessage', text: '公开回复', providerText: 'private-file-context' }] })
    const raw = JSON.stringify(service.threads.get(thread.id))
    assert.ok(raw.includes('private-signature'), 'private replay must remain available for future provider rounds')
    const snapshot = JSON.stringify(await service.snapshot('session'))
    for (const value of ['private-signature', 'private-project', 'private-tenant', 'private-file-context', SECRET, 'providerMessages', 'providerRevision', 'credentialRevision']) assert.ok(!snapshot.includes(value), value)
    assert.ok(snapshot.includes('公开回复'))
  })
})

test('native HTTP diagnostics never claim the native tool chain has been exercised', async () => {
  await fixture(async (service) => {
    const saved = await service.saveModel({ ...entry, engine: 'native' })
    const report = await service.inspectModel({ id: saved.id, check: 'text' })
    assert.equal(report.ok, true)
    assert.equal(report.checks.find((check) => check.id === 'native-tools').status, 'untested')
    assert.equal(report.checks.find((check) => check.id === 'native-environment').status, 'untested')
  })
})
