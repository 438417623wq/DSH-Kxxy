import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { fetchProviderModels, testProviderModel, providerConfiguration } from '../plugins/dsh-codex-sidebar/lib/provider-api.mjs'

const key = 'local-provider-test-credential'
async function fixture(fn) {
  const calls = []
  const responses = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const part of req) chunks.push(part)
    const call = { url: req.url, method: req.method, key: req.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null }
    calls.push(call)
    const response = responses.shift()
    if (typeof response === 'function') return response(req, res, call)
    res.writeHead(response?.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(response?.body ?? { data: [{ id: 'model' }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const input = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: key, model: 'model' }
  try { await fn({ input, calls, responses }) } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
}

test('model discovery accepts unsaved service fields and sorts, deduplicates and redacts models', async () => fixture(async ({ input, calls, responses }) => {
  responses.push({ body: { data: [{ id: 'z-model' }, { id: 'a-model', name: 'Alpha' }, { id: 'z-model' }, { id: key }, { id: 'bad\nmodel' }, { id: 'safe', name: key }] } })
  const result = await fetchProviderModels({ baseUrl: `${input.baseUrl}/chat/completions/`, apiKey: key })
  assert.deepEqual(result.models.map((model) => model.id), ['a-model', 'safe', 'z-model'])
  assert.equal(result.count, 3)
  assert.ok(result.latencyMs >= 0)
  assert.ok(!JSON.stringify(result).includes(key))
  assert.equal(calls[0].url, '/v1/models')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].key, `Bearer ${key}`)
  assert.equal(calls[0].body, null)
}))

test('saved service credentials remain private and blank edits preserve keys', async () => fixture(async ({ input, responses }) => {
  const saved = { ...input, id: 'saved', apiFormat: 'responses' }
  const models = { get: (id) => id === 'saved' ? saved : null }
  responses.push({ body: { models: ['one', 'two'] } })
  assert.equal((await fetchProviderModels({ id: 'saved', apiKey: '' }, { models })).count, 2)
  assert.deepEqual(saved, { ...input, id: 'saved', apiFormat: 'responses' })
  const edited = providerConfiguration({ id: 'saved', baseUrl: `${input.baseUrl}/new`, model: 'changed', apiKey: '' }, { models, requireModel: true })
  assert.equal(edited.model, 'changed')
  assert.equal(edited.baseUrl, `${input.baseUrl}/new`)
  assert.equal(edited.apiKey, key)
  assert.throws(() => providerConfiguration({ id: 'missing', ...input }, { models }), { code: 'model-missing' })
}))

test('model tests perform real inference for both API formats without tools or saving history', async () => fixture(async ({ input, calls, responses }) => {
  responses.push({ body: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } })
  const chat = await testProviderModel(input)
  assert.equal(chat.ok, true)
  assert.equal(chat.preview, 'OK')
  assert.equal(calls[0].url, '/v1/chat/completions')
  assert.equal(calls[0].body.model, 'model')
  assert.equal(calls[0].body.tools, undefined)
  assert.equal(calls[0].body.stream, false)
  responses.push({ body: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: `OK ${key}` }] }] } })
  const response = await testProviderModel({ ...input, apiFormat: 'responses' })
  assert.equal(response.ok, true)
  assert.ok(!response.preview.includes(key))
  assert.equal(calls[1].url, '/v1/responses')
  assert.equal(calls[1].body.store, false)
  assert.equal(calls[1].body.tools, undefined)
  assert.equal(input.apiKey, key)
}))

test('discovery errors identify manual entry fallback and never return provider secrets', async () => fixture(async ({ input, responses }) => {
  responses.push({ status: 404, body: { error: key } })
  await assert.rejects(fetchProviderModels(input), (error) => error.message.includes('手动') && !error.message.includes(key))
  responses.push({ status: 401, body: { error: key } })
  await assert.rejects(testProviderModel(input), (error) => error.message.includes('密钥') && !error.message.includes(key))
  responses.push({ body: { error: { message: key } } })
  await assert.rejects(fetchProviderModels(input), (error) => error.code === 'model-response' && !error.message.includes(key))
  responses.push({ body: { data: [] } })
  await assert.rejects(fetchProviderModels(input), { code: 'models-empty' })
  responses.push({ body: { data: Array.from({ length: 1001 }, () => ({ id: 'model' })) } })
  await assert.rejects(fetchProviderModels(input), { code: 'models-response' })
}))

test('invalid URLs and missing credentials are rejected before fetching', async () => {
  let requests = 0
  const fetchImpl = () => { requests++; throw new Error(key) }
  for (const baseUrl of ['file:///etc/passwd', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#anchor']) {
    await assert.rejects(fetchProviderModels({ baseUrl, apiKey: key }, { fetchImpl }), { code: 'model-url' })
  }
  await assert.rejects(fetchProviderModels({ baseUrl: 'https://example.com/v1', apiKey: '' }, { fetchImpl }), { code: 'model-key' })
  assert.equal(requests, 0)
  await assert.rejects(testProviderModel({ baseUrl: 'https://example.com/v1', apiKey: key, model: 'model' }, { fetchImpl }), (error) => error.code === 'model-network' && !error.message.includes(key))
})

test('test timeout and empty results are distinct from successful inference', async () => {
  await assert.rejects(testProviderModel({ baseUrl: 'https://provider.invalid/v1', apiKey: key, model: 'model' }, { timeoutMs: 25, fetchImpl: () => new Promise(() => {}) }), { code: 'model-timeout' })
  await fixture(async ({ input, responses }) => {
    responses.push({ body: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } })
    await assert.rejects(testProviderModel(input), { code: 'model-test-empty' })
  })
})
