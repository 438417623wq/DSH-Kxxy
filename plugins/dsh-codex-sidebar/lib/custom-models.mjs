import { mkdir, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexError } from './transport.mjs'
import { normalizeProvider, providerMetadata, groupIdOf, normalizeBaseUrl } from './provider-config.mjs'
export { normalizeBaseUrl, modelRevision, credentialRevision, providerSecrets } from './provider-config.mjs'

const MAX_MODELS = 300
const MAX_STORE_BYTES = 2 * 1024 * 1024
const ID = /^custom-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const CONNECTION_FIELDS = ['apiFormat', 'engine', 'authType', 'profile', 'compat', 'headers', 'query', 'reasoningEfforts', 'reasoningEffort', 'maxOutputTokens', 'thinkingBudget']
const has = (value, key) => Object.hasOwn(value, key) && value[key] !== undefined

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
      if (records.length > MAX_MODELS) throw new CodexError('models-limit', `最多可保存 ${MAX_MODELS} 个模型条目（包含需修复的条目）`, 413)
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

  /**
   * One connection, many models: validate the connection once, then create/update/remove
   * entries inside a single atomic mutation. Blank credentials are inherited from the
   * group so a second batch save never needs the key typed again (it is never returned).
   */
  async saveBatch(input) {
    return this.mutate((models) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CodexError('model-input', '模型设置必须是对象')
      const requests = input.models
      if (!Array.isArray(requests) || !requests.length) throw new CodexError('model-input', '请至少勾选 1 个模型')
      if (requests.length > MAX_MODELS) throw new CodexError('model-input', `一次最多保存 ${MAX_MODELS} 个模型`, 413)
      const baseUrl = normalizeBaseUrl(input.baseUrl)
      const apiFormat = typeof input.apiFormat === 'string' ? input.apiFormat : 'chat-completions'
      const engine = typeof input.engine === 'string' ? input.engine : 'workspace'
      let groupId = typeof input.groupId === 'string' && input.groupId.trim() ? input.groupId : ''
      if (!groupId) {
        const sameConnection = [...models.values()].find((entry) => entry.groupId && entry.baseUrl === baseUrl
          && (entry.apiFormat ?? 'chat-completions') === apiFormat && (entry.engine ?? 'workspace') === engine)
        groupId = sameConnection?.groupId ?? `group-${randomUUID()}`
      }
      const members = [...models.values()].filter((entry) => groupIdOf(entry) === groupId)
      const donor = members.find((entry) => entry.apiKey) ?? members[0] ?? null
      const template = { ...input, groupId }
      delete template.id
      delete template.models
      delete template.replaceGroup
      if (donor) {
        for (const key of CONNECTION_FIELDS) if (!has(template, key) && donor[key] !== undefined) template[key] = donor[key]
        // A blank key means "keep using this connection's saved key", never "erase it".
        if (!has(template, 'apiKey')) template.apiKey = donor.apiKey ?? ''
        else if (typeof template.apiKey === 'string' && !template.apiKey.trim() && donor.apiKey) template.apiKey = donor.apiKey
        if (!has(template, 'groupName')) template.groupName = donor.groupName
      }
      const saved = []
      const keep = new Set()
      for (const request of requests) {
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw new CodexError('model-input', '模型条目格式不正确')
        let existing = null
        if (request.id) {
          existing = models.get(request.id)
          if (!existing) throw new CodexError('model-missing', '部分模型条目已被删除，请重新获取模型列表', 404)
        } else {
          // A selection without an id still refers to the same model of this connection.
          existing = members.find((entry) => entry.model === request.model && !keep.has(entry.id)) ?? null
        }
        const entry = normalizeProvider({
          ...template,
          ...(existing ? { id: existing.id } : {}),
          model: request.model,
          name: typeof request.name === 'string' && request.name.trim() ? request.name : request.model,
        }, { existing, requireName: true })
        entry.id = existing?.id ?? `custom-${randomUUID()}`
        entry.groupId = groupId
        if (template.groupName) entry.groupName = template.groupName
        models.set(entry.id, entry)
        keep.add(entry.id)
        saved.push(providerMetadata(entry))
      }
      const removedIds = []
      if (input.replaceGroup !== false) {
        for (const member of members) {
          if (keep.has(member.id)) continue
          models.delete(member.id)
          removedIds.push(member.id)
        }
      }
      return { groupId, saved, removedIds }
    })
  }

  async deleteGroup(groupId) {
    return this.mutate((models) => {
      const removedIds = [...models.values()].filter((entry) => groupIdOf(entry) === groupId).map((entry) => entry.id)
      if (!removedIds.length) throw new CodexError('model-missing', '服务商连接不存在或已被删除', 404)
      for (const id of removedIds) models.delete(id)
      return { ok: true, groupId, removedIds }
    })
  }
}
