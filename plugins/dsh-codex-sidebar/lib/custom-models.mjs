import { mkdir, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexError } from './transport.mjs'
import { normalizeProvider, providerMetadata } from './provider-config.mjs'
export { normalizeBaseUrl, modelRevision, credentialRevision, providerSecrets } from './provider-config.mjs'

const MAX_MODELS = 100
const MAX_STORE_BYTES = 1024 * 1024
const ID = /^custom-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

/** Credentials and unparseable entries stay in private storage, never in snapshots. */
export class CustomModels {
  constructor(home) {
    this.home = home
    this.models = new Map()
    this.records = []
    this.loaded = false
    this.loading = null
    this.queue = Promise.resolve()
  }

  async load() {
    if (this.loaded) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      await mkdir(this.home, { recursive: true, mode: 0o700 })
      try {
        const path = join(this.home, 'sidebar-models.json')
        const raw = await readFile(path)
        if (raw.byteLength > MAX_STORE_BYTES) throw new Error('Oversized model store')
        const data = JSON.parse(raw.toString('utf8'))
        if (!data || ![1, 2].includes(data.version) || !Array.isArray(data.models) || data.models.length > MAX_MODELS) throw new Error('Invalid model store')
        const quarantined = data.version === 2 ? data.invalidModelIndices ?? [] : []
        if (!Array.isArray(quarantined) || quarantined.some((index) => !Number.isInteger(index) || index < 0 || index >= data.models.length)) throw new Error('Invalid quarantine indices')
        const models = new Map()
        const records = []
        for (const [index, entry] of data.models.entries()) {
          try {
            if (quarantined.includes(index) || !entry || !ID.test(entry.id) || models.has(entry.id)) throw new Error('Invalid model ID')
            const model = normalizeProvider(entry, { existing: entry, requireName: true })
            models.set(entry.id, model)
            records.push({ id: entry.id })
          } catch {
            // Preserve the complete original JSON value. One broken entry must not hide the rest.
            records.push({ invalid: true, raw: entry })
          }
        }
        await chmod(path, 0o600)
        this.models = models
        this.records = records
      } catch (error) {
        if (error.code !== 'ENOENT') throw new CodexError('models-invalid', '自定义模型配置无法读取，原文件已保留，请修复后重试', 503)
      }
      this.loaded = true
    })().finally(() => { this.loading = null })
    return this.loading
  }

  get(id) { return this.models.get(id) }
  warnings() { return this.records.flatMap((record, index) => record.invalid ? [{ code: 'model-entry-invalid', index, message: '此模型条目无效，已跳过并保留原始配置；请在私有配置文件中修复' }] : []) }
  metadata() { return [...this.models.values()].map(providerMetadata) }
  catalog() {
    return this.metadata().map((entry) => ({
      ...entry, displayName: entry.name, isDefault: false,
      supportedModes: entry.engine === 'native' ? ['agent'] : ['agent', 'chat'],
      defaultReasoningEffort: entry.reasoningEffort,
      supportedReasoningEfforts: entry.reasoningEfforts.map((reasoningEffort) => ({ reasoningEffort })),
    }))
  }

  async mutate(operation) {
    await this.load()
    const task = this.queue.then(async () => {
      const models = new Map(this.models)
      const result = operation(models)
      const records = this.records.filter((record) => record.invalid || models.has(record.id))
      const known = new Set(records.filter((record) => !record.invalid).map((record) => record.id))
      for (const id of models.keys()) if (!known.has(id)) records.push({ id })
      if (records.length > MAX_MODELS) throw new CodexError('models-limit', '最多可保存 100 个模型条目（包含需修复的条目）', 413)
      const invalidModelIndices = records.flatMap((record, index) => record.invalid ? [index] : [])
      const raw = JSON.stringify({ version: 2, models: records.map((record) => record.invalid ? record.raw : models.get(record.id)), ...(invalidModelIndices.length ? { invalidModelIndices } : {}) }, null, 2) + '\n'
      if (Buffer.byteLength(raw) > MAX_STORE_BYTES) throw new CodexError('models-limit', '模型配置总大小超过上限', 413)
      const path = join(this.home, 'sidebar-models.json')
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, raw, { mode: 0o600, flag: 'wx' })
        await rename(temporary, path)
        this.models = models
        this.records = records
      } catch {
        await unlink(temporary).catch(() => {})
        throw new CodexError('models-save', '自定义模型保存失败，请检查应用私有目录是否可写', 503)
      }
      return result
    })
    this.queue = task.catch(() => {})
    return task
  }

  async save(input) {
    return this.mutate((models) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CodexError('model-input', '模型设置必须是对象')
      let existing = null
      if (input.id !== undefined && input.id !== '') {
        existing = models.get(input.id)
        if (!existing) throw new CodexError('model-missing', '自定义模型已被删除，请重新添加', 404)
      }
      const entry = normalizeProvider(input, { existing, requireName: true })
      entry.id = existing?.id ?? `custom-${randomUUID()}`
      models.set(entry.id, entry)
      return providerMetadata(entry)
    })
  }

  async delete(id) {
    return this.mutate((models) => {
      if (!models.has(id)) throw new CodexError('model-missing', '自定义模型不存在', 404)
      models.delete(id)
      return { ok: true, id }
    })
  }
}
