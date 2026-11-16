import { constants } from 'node:fs'
import { mkdir, realpath, lstat, open, rename, unlink, opendir } from 'node:fs/promises'
import { resolve, join, dirname, isAbsolute } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { WorkspaceTools } from './workspace-tools.mjs'
import { CodexError, redact } from './transport.mjs'

const FILE_BYTES = 256 * 1024
const TTL = 120000
const HASH = /^[a-f0-9]{64}$/
const STATES = new Set(['applied', 'reverting', 'reverted', 'conflict'])
const digest = (data) => createHash('sha256').update(data).digest('hex')
const error = (code, message) => new CodexError(code, message, 409)
const copy = (value) => structuredClone(value)
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
const identity = (info) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(':')
const fileKey = (value) => { const key = resolve(value.cwd, value.path); return process.platform === 'win32' ? key.toLowerCase() : key }
const recordKey = (value) => JSON.stringify([value.threadId, value.sessionId, value.cwd, value.turnId, value.path])
const scopeKey = (value) => JSON.stringify([value.threadId, value.sessionId, value.cwd, value.turnId])
function scopeOf(binding, turnId) {
  if (!binding || !id(binding.id) || !id(binding.sessionId) || !id(binding.cwd) || !isAbsolute(binding.cwd) || !id(turnId)) throw error('changes-context', '文件变更会话上下文无效')
  return { threadId: binding.id, sessionId: binding.sessionId, cwd: resolve(binding.cwd), turnId }
}
function validateText(data) {
  if (!Buffer.isBuffer(data) || data.length > FILE_BYTES || data.includes(0)) throw error('changes-content', '只记录不超过 256 KiB 的 UTF-8 文本')
  try { new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { throw error('changes-content', '只记录 UTF-8 文本文件') }
}
function decodeBefore(value) {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > Math.ceil(FILE_BYTES / 3) * 4) throw error('changes-corrupt', '文件变更日志损坏')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw error('changes-corrupt', '文件变更日志损坏')
  validateText(bytes)
  return bytes
}
function safeFile(record) {
  return { path: redact(record.path), kind: record.before === null ? 'add' : 'update', status: record.status, beforeBytes: record.before === null ? 0 : Buffer.byteLength(record.before, 'base64'), afterBytes: record.afterBytes }
}
function conflict(path, code = 'changes-conflict') {
  return { path: redact(path), code, message: '文件、工作区或日志已改变，未覆盖当前内容' }
}

/** Private before-images only for approved HTTP write_file operations; never for shell/native changes. */
export class FileChanges {
  #home
  #homeRoot
  #directory
  #file
  #maxEntries
  #maxBytes
  #now
  #data = { version: 1, sequence: 0, records: [], pending: [] }
  #loaded
  #failure = null
  #diskIdentity = null
  #queue = Promise.resolve()
  #active = new Set()
  #challenges = new Map()
  #results = new Map()

  constructor(home, { now = Date.now, maxEntries = 256, maxBytes = 8 * 1024 * 1024 } = {}) {
    if (!id(home) || !isAbsolute(home)) throw error('changes-context', '变更日志目录必须是绝对路径')
    if (typeof now !== 'function' || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 2048 || !Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > 32 * 1024 * 1024) throw error('changes-bounds', '变更日志容量设置无效')
    this.#home = resolve(home)
    this.#now = now
    this.#maxEntries = maxEntries
    this.#maxBytes = maxBytes
  }

  async load() {
    if (!this.#loaded) this.#loaded = this.#load().catch(() => { this.#failure = error('changes-unavailable', '私有文件变更日志不可用；为避免丢失撤销证据，已禁止新的文件写入') })
    await this.#loaded
    return this
  }

  async #load() {
    await mkdir(this.#home, { recursive: true, mode: 0o700 })
    this.#homeRoot = await realpath(this.#home)
    this.#directory = join(this.#homeRoot, 'codex-change-journal')
    this.#file = join(this.#directory, 'journal.json')
    await mkdir(this.#directory, { mode: 0o700 }).catch((cause) => { if (cause.code !== 'EEXIST') throw cause })
    await this.#directorySafe()
    // Interrupted atomic saves may leave only our private, exclusive temporary files.
    const directory = await opendir(this.#directory)
    let count = 0
    try {
      for (;;) {
        const entry = await directory.read()
        if (!entry) break
        if (++count > 64) throw error('changes-bounds', '变更日志目录条目过多')
        if (entry.name === 'journal.json') continue
        if (!/^\.journal-[a-f0-9-]{36}\.tmp$/.test(entry.name)) throw error('changes-corrupt', '变更日志目录包含未知条目')
        const path = join(this.#directory, entry.name)
        await this.#privateFile(path)
        await unlink(path)
      }
    } finally { await directory.close() }
    let info
    try { info = await this.#privateFile(this.#file) } catch (cause) { if (cause.code === 'ENOENT') return; throw cause }
    const handle = await open(this.#file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    let bytes
    try {
      const opened = await handle.stat()
      if (identity(opened) !== identity(info)) throw error('changes-corrupt', '变更日志读取期间已改变')
      const buffer = Buffer.alloc(this.#maxBytes + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length > this.#maxBytes || identity(await handle.stat()) !== identity(info)) throw error('changes-corrupt', '变更日志读取期间已改变')
      bytes = buffer.subarray(0, length)
    } finally { await handle.close() }
    if (identity(await this.#privateFile(this.#file)) !== identity(info)) throw error('changes-corrupt', '变更日志读取期间已改变')
    const envelope = JSON.parse(bytes.toString('utf8'))
    if (!envelope || !envelope.data || envelope.sha256 !== digest(JSON.stringify(envelope.data))) throw error('changes-corrupt', '变更日志校验失败')
    this.#validate(envelope.data)
    this.#data = envelope.data
    this.#diskIdentity = identity(info)
  }

  async #directorySafe() {
    if (await realpath(this.#home) !== this.#homeRoot || await realpath(this.#directory) !== this.#directory) throw error('changes-corrupt', '变更日志目录已改变')
    const info = await lstat(this.#directory)
    if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw error('changes-private', '变更日志目录必须为私有目录')
  }

  async #privateFile(path) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > this.#maxBytes || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw error('changes-private', '变更日志文件不安全')
    return info
  }

  #validate(data) {
    if (!data || data.version !== 1 || !Number.isSafeInteger(data.sequence) || data.sequence < 0 || !Array.isArray(data.records) || !Array.isArray(data.pending) || data.records.length > this.#maxEntries || data.pending.length > this.#maxEntries) throw error('changes-corrupt', '文件变更日志格式无效')
    const keys = new Set(), paths = new Set(), tokens = new Set()
    const validate = (record) => {
      for (const field of ['threadId', 'sessionId', 'cwd', 'turnId', 'path', 'itemId']) if (!id(record[field])) throw error('changes-corrupt', '文件变更日志字段无效')
      if (!isAbsolute(record.cwd) || isAbsolute(record.path) || /^[a-z]:/i.test(record.path) || record.path.split(/[\\/]/).includes('..') || !HASH.test(record.afterHash) || !Number.isInteger(record.mode) || record.mode < 0 || record.mode > 0o777 || !Number.isSafeInteger(record.afterBytes) || record.afterBytes < 0 || record.afterBytes > FILE_BYTES) throw error('changes-corrupt', '文件变更日志字段无效')
      const before = decodeBefore(record.before)
      if (before === null ? record.beforeHash !== null : record.beforeHash !== digest(before)) throw error('changes-corrupt', '文件变更原始内容校验失败')
    }
    for (const record of data.records) {
      validate(record)
      const key = recordKey(record)
      if (keys.has(key) || !STATES.has(record.status) || !Number.isSafeInteger(record.revision) || record.revision < 1 || record.revision > data.sequence) throw error('changes-corrupt', '文件变更记录无效')
      keys.add(key)
    }
    for (const pending of data.pending) {
      validate(pending)
      if (!id(pending.token) || tokens.has(pending.token) || paths.has(fileKey(pending)) || pending.previousRevision !== null && (!Number.isSafeInteger(pending.previousRevision) || pending.previousRevision < 1 || pending.previousRevision > data.sequence)) throw error('changes-corrupt', '待确认文件变更无效')
      tokens.add(pending.token); paths.add(fileKey(pending))
      if (!keys.has(recordKey(pending))) keys.add(recordKey(pending))
    }
    if (keys.size > this.#maxEntries) throw error('changes-bounds', '文件变更日志记录数已达上限')
  }

  async #ready() {
    await this.load()
    if (this.#failure) throw this.#failure
  }

  #serial(work) {
    const result = this.#queue.then(work)
    this.#queue = result.catch(() => {})
    return result
  }

  async #save(next) {
    this.#validate(next)
    const bytes = Buffer.from(JSON.stringify({ sha256: digest(JSON.stringify(next)), data: next }))
    if (bytes.length > this.#maxBytes) throw error('changes-bounds', '文件变更日志空间已满，请保留日志并停止新的文件写入')
    let temporary
    try {
      await this.#directorySafe()
      let previous = null
      try { previous = await this.#privateFile(this.#file) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
      if ((previous ? identity(previous) : null) !== this.#diskIdentity) throw error('changes-corrupt', '文件变更日志被外部修改')
      temporary = join(this.#directory, `.journal-${randomUUID()}.tmp`)
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await this.#directorySafe()
      let current = null
      try { current = await this.#privateFile(this.#file) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
      if ((current ? identity(current) : null) !== this.#diskIdentity) throw error('changes-corrupt', '保存前文件变更日志已改变')
      await rename(temporary, this.#file)
      temporary = null
      this.#data = next
      this.#diskIdentity = identity(await this.#privateFile(this.#file))
      if (process.platform !== 'win32') {
        const directory = await open(this.#directory, constants.O_RDONLY)
        try { await directory.sync() } finally { await directory.close() }
      }
    } catch (cause) {
      this.#failure = error('changes-unavailable', '文件变更日志无法安全更新；已停止后续写入')
      throw this.#failure
    } finally { if (temporary) await unlink(temporary).catch(() => {}) }
  }

  #tools(scope, signal, secrets = []) {
    const tools = new WorkspaceTools({ cwd: scope.cwd, accessMode: 'readonly', signal, secrets })
    tools.canonicalRoot = scope.cwd
    return tools
  }

  async #current(record, signal) {
    const tools = this.#tools(record, signal)
    const target = await tools.writable(record.path)
    if (target.root !== record.cwd || target.name !== record.path) throw error('changes-context', '文件变更工作区或路径已改变')
    const file = target.exists ? await tools.bytes(target.path, FILE_BYTES) : null
    return { target, file, hash: file?.hash ?? null }
  }

  #superseded(record) {
    return this.#data.records.some((other) => fileKey(other) === fileKey(record) && other.revision > record.revision)
  }

  #commitPending(next, pending) {
    const index = next.records.findIndex((record) => recordKey(record) === recordKey(pending))
    const previous = index < 0 ? null : next.records[index]
    if (previous ? previous.revision !== pending.previousRevision || previous.afterHash !== pending.beforeHash || previous.status !== 'applied' : pending.previousRevision !== null) throw error('changes-conflict', '连续文件变更证据不匹配')
    const { token, previousRevision, ...fields } = pending
    const record = { ...fields, ...(previous ? { before: previous.before, beforeHash: previous.beforeHash, mode: previous.mode } : {}), revision: ++next.sequence, status: 'applied' }
    if (index < 0) next.records.push(record)
    else next.records[index] = record
    next.pending = next.pending.filter((entry) => entry.token !== pending.token)
  }

  async #reconcile(scope) {
    const pending = this.#data.pending.filter((entry) => scopeKey(entry) === scopeKey(scope) && !this.#active.has(entry.token))
    const reverting = this.#data.records.filter((entry) => scopeKey(entry) === scopeKey(scope) && entry.status === 'reverting')
    if (!pending.length && !reverting.length) return
    const next = copy(this.#data)
    let changed = false
    for (const entry of pending) {
      try {
        const current = await this.#current(entry)
        if (current.hash === entry.afterHash) { this.#commitPending(next, entry); changed = true }
        else if (current.hash === entry.beforeHash) { next.pending = next.pending.filter((value) => value.token !== entry.token); changed = true }
        // Neither image matches: retain the evidence and block undo rather than guessing.
      } catch { /* An inaccessible or relinked target is not evidence that a write failed. */ }
    }
    for (const entry of reverting) {
      try {
        const current = await this.#current(entry)
        const record = next.records.find((value) => recordKey(value) === recordKey(entry))
        record.status = current.hash === entry.beforeHash ? 'reverted' : current.hash === entry.afterHash ? 'applied' : 'conflict'
        changed = true
      } catch { /* Keep an unresolved reversal unavailable. */ }
    }
    if (changed) await this.#save(next)
  }

  adapter({ binding, turnId, signal, secrets = [] }) {
    const scope = scopeOf(binding, turnId)
    const bound = { id: scope.threadId, sessionId: scope.sessionId, cwd: scope.cwd }
    return {
      prepareWrite: (details) => this.prepareWrite({ ...details, binding: bound, turnId, signal, secrets }),
      commitWrite: (token) => this.commitWrite(token),
      failWrite: (token) => this.failWrite(token),
    }
  }

  async prepareWrite({ binding, turnId, itemId, path, cwd, before, beforeHash, after, afterHash, mode, signal }) {
    const scope = scopeOf(binding, turnId)
    return this.#serial(async () => {
      await this.#ready()
      if (!id(itemId) || !id(path) || cwd !== scope.cwd || !Number.isInteger(mode) || mode < 0 || mode > 0o777) throw error('changes-context', '文件写入日志上下文无效')
      if (before !== null) validateText(before)
      validateText(after)
      if ((before === null ? null : digest(before)) !== beforeHash || digest(after) !== afterHash) throw error('changes-content', '文件写入内容校验失败')
      const pending = { ...scope, itemId, path, before: before === null ? null : before.toString('base64'), beforeHash, afterHash, afterBytes: after.length, mode, token: randomBytes(32).toString('base64url'), previousRevision: null }
      const current = await this.#current(pending, signal)
      if (current.hash !== beforeHash || current.file && (current.file.info.mode & 0o777) !== mode) throw error('changes-conflict', '准备日志时文件已改变，已取消写入')
      await this.#reconcile(scope)
      if (this.#data.pending.some((entry) => fileKey(entry) === fileKey(pending))) throw error('changes-pending', '目标文件存在未确认的写入，已停止新的写入')
      const existing = this.#data.records.find((entry) => recordKey(entry) === recordKey(pending))
      if (existing) {
        if (existing.status !== 'applied' || existing.afterHash !== beforeHash || this.#superseded(existing)) throw error('changes-conflict', '此轮文件变更不连续，不能合并撤销记录')
        pending.previousRevision = existing.revision
      }
      const next = copy(this.#data)
      next.pending.push(pending)
      // Reserve enough room for the committed/reverting form before touching the target.
      const committed = copy(next)
      this.#commitPending(committed, pending)
      for (const record of committed.records) record.status = 'reverting'
      if (Buffer.byteLength(JSON.stringify({ sha256: '0'.repeat(64), data: committed })) > this.#maxBytes) throw error('changes-bounds', '文件变更日志空间不足，已取消写入')
      await this.#save(next)
      this.#active.add(pending.token)
      this.invalidate(scope.threadId)
      return pending.token
    })
  }

  async commitWrite(token) {
    return this.#serial(async () => {
      try {
        await this.#ready()
        const pending = this.#data.pending.find((entry) => entry.token === token)
        if (!pending) throw error('changes-token', '待确认的文件写入不存在')
        const current = await this.#current(pending)
        if (current.hash !== pending.afterHash) throw error('changes-conflict', '写入后文件已改变；保留待确认日志')
        const next = copy(this.#data)
        this.#commitPending(next, pending)
        await this.#save(next)
      } finally { this.#active.delete(token) }
    })
  }

  async failWrite(token) {
    return this.#serial(async () => {
      try {
        await this.#ready()
        if (!this.#data.pending.some((entry) => entry.token === token)) return
        const next = copy(this.#data)
        next.pending = next.pending.filter((entry) => entry.token !== token)
        await this.#save(next)
      } finally { this.#active.delete(token) }
    })
  }

  async describe(threadId, turnId) {
    return this.#serial(async () => {
      await this.load()
      if (this.#failure) return { available: false, status: 'unavailable', files: [], reason: '私有变更日志不可用' }
      const matching = (entry) => entry.threadId === threadId && entry.turnId === turnId
      const sample = this.#data.records.find(matching) ?? this.#data.pending.find(matching)
      if (sample) {
        try { await this.#reconcile(sample) } catch { return { available: false, status: 'unavailable', files: [], reason: '私有变更日志不可用' } }
      }
      const records = this.#data.records.filter(matching)
      const pending = this.#data.pending.some(matching) || records.some((entry) => entry.status === 'reverting')
      const files = records.map(safeFile)
      if (!records.length && !pending) return { available: false, status: 'unavailable', files, reason: '此轮没有可验证的 HTTP 文件写入日志；命令、原生及历史变更不能撤销' }
      const conflict = records.some((entry) => entry.status === 'conflict' || entry.status === 'applied' && this.#superseded(entry))
      const undone = records.filter((entry) => entry.status === 'reverted').length
      return { available: !pending && !conflict && undone < records.length, status: pending ? 'pending' : undone === records.length ? 'reverted' : undone ? 'partial' : conflict ? 'conflict' : 'available', files }
    })
  }

  #selected(scope) { return this.#data.records.filter((entry) => scopeKey(entry) === scopeKey(scope) && entry.status !== 'reverted') }
  #version(records) { return digest(JSON.stringify(records.map((entry) => [recordKey(entry), entry.revision, entry.afterHash, entry.status]))) }

  async #preflight(scope, records, signal) {
    const conflicts = [], checked = []
    for (const record of records) {
      try {
        if (!['applied', 'reverting'].includes(record.status) || this.#superseded(record) || this.#data.pending.some((entry) => fileKey(entry) === fileKey(record))) throw error('changes-conflict', '变更日志已改变')
        const current = await this.#current(record, signal)
        if (!current.file || current.hash !== record.afterHash) throw error('changes-conflict', '文件当前内容不匹配')
        checked.push({ record, ...current })
      } catch (cause) { conflicts.push(conflict(record.path, cause.code ?? 'changes-conflict')) }
    }
    if (this.#data.pending.some((entry) => scopeKey(entry) === scopeKey(scope)) && !conflicts.length) conflicts.push(conflict('.', 'changes-pending'))
    return { conflicts, checked }
  }

  async preview({ binding, turnId, signal }) {
    const scope = scopeOf(binding, turnId)
    return this.#serial(async () => {
      await this.#ready()
      await this.#reconcile(scope)
      const records = this.#selected(scope)
      if (!records.length) throw error('changes-unavailable', '此轮没有可撤销的文件变更日志')
      const { conflicts } = await this.#preflight(scope, records, signal)
      const files = records.map(safeFile)
      if (conflicts.length) return { ok: false, status: 'conflict', files, conflicts, message: '预检发现冲突，没有修改任何文件。' }
      this.invalidate(scope.threadId)
      for (const [token, challenge] of this.#challenges) if (challenge.expiresAt <= this.#now()) this.#challenges.delete(token)
      while (this.#challenges.size >= 64) this.#challenges.delete(this.#challenges.keys().next().value)
      const token = randomBytes(32).toString('base64url'), expiresAt = this.#now() + TTL
      this.#challenges.set(token, { scope, version: this.#version(records), expiresAt })
      return { ok: true, token, expiresAt, files, message: '仅撤销此轮已记录的文本写入：新建文件将删除，原文件将恢复。确认两分钟内有效；任何文件冲突都会阻止开始撤销。' }
    })
  }

  async #restore(entry, signal) {
    const { record } = entry
    let temporary = null
    const validate = async () => {
      const current = await this.#current(record, signal)
      if (!current.file || current.hash !== record.afterHash || identity(current.file.info) !== identity(entry.file.info)) throw error('changes-conflict', '撤销前文件已改变')
      return current
    }
    try {
      const current = await validate()
      if (record.before === null) {
        await validate()
        await unlink(current.target.path)
      } else {
        temporary = join(dirname(current.target.path), `.workspace-revert-${randomUUID()}.tmp`)
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), record.mode)
        try {
          await handle.writeFile(decodeBefore(record.before))
          await handle.chmod(record.mode)
          await handle.sync()
        } finally { await handle.close() }
        await validate()
        await rename(temporary, current.target.path)
        temporary = null
      }
    } finally { if (temporary) await unlink(temporary).catch(() => {}) }
  }

  async revert({ binding, turnId, token, requestId, signal }) {
    const scope = scopeOf(binding, turnId)
    if (!id(requestId) || requestId.length > 256) throw error('changes-request', '撤销请求标识无效')
    return this.#serial(async () => {
      await this.#ready()
      const resultKey = `${scopeKey(scope)}:${requestId}`
      const previous = this.#results.get(resultKey)
      if (previous) {
        if (previous.token !== token) throw error('changes-request', '撤销请求标识已被使用')
        return copy(previous.result)
      }
      const challenge = typeof token === 'string' ? this.#challenges.get(token) : null
      if (!challenge || scopeKey(challenge.scope) !== scopeKey(scope)) throw error('changes-token', '请先预览并确认此轮文件撤销')
      if (challenge.expiresAt <= this.#now()) { this.#challenges.delete(token); throw error('changes-expired', '撤销确认已过期，请重新预览') }
      this.#challenges.delete(token)
      await this.#reconcile(scope)
      const records = this.#selected(scope)
      if (!records.length || this.#version(records) !== challenge.version) throw error('changes-conflict', '确认后变更日志已改变，请重新预览')
      const preflight = await this.#preflight(scope, records, signal)
      const files = [], conflicts = preflight.conflicts
      if (!conflicts.length) {
        for (const entry of preflight.checked) {
          let applied = false
          try {
            const starting = copy(this.#data)
            starting.records.find((value) => recordKey(value) === recordKey(entry.record)).status = 'reverting'
            await this.#save(starting)
            await this.#restore(entry, signal)
            applied = true
            files.push({ ...safeFile(entry.record), status: 'reverted' })
            const completed = copy(this.#data)
            completed.records.find((value) => recordKey(value) === recordKey(entry.record)).status = 'reverted'
            await this.#save(completed)
          } catch (cause) {
            conflicts.push(conflict(entry.record.path, cause.code ?? 'changes-failed'))
            if (applied) files.at(-1).journalPending = true
            break
          }
        }
      }
      const result = { ok: conflicts.length === 0, status: conflicts.length ? files.length ? 'partial' : 'conflict' : 'reverted', files, conflicts, requestId }
      while (this.#results.size >= 64) this.#results.delete(this.#results.keys().next().value)
      this.#results.set(resultKey, { token, result: copy(result) })
      this.invalidate(scope.threadId)
      return result
    })
  }

  invalidate(threadId) {
    for (const [token, challenge] of this.#challenges) if (threadId === undefined || challenge.scope.threadId === threadId) this.#challenges.delete(token)
  }
}
