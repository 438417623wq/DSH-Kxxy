import { randomBytes } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { CodexError } from './transport.mjs'

const MODES = new Set(['approval', 'readonly', 'full'])
const TTL = 2 * 60 * 1000
const LIMIT = 64
const fail = (code, message) => new CodexError(code, message, 409)

export function validateAccessMode(mode) {
  if (!MODES.has(mode)) throw fail('access-mode', '未知的访问权限模式')
  return mode
}

function context(binding, generation) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw fail('access-context', '会话权限上下文无效')
  for (const field of ['id', 'sessionId', 'cwd', 'model']) {
    if (typeof binding[field] !== 'string' || !binding[field] || binding[field].length > 4096 || binding[field].includes('\0')) throw fail('access-context', '会话权限上下文不完整')
  }
  if (!isAbsolute(binding.cwd) || !Number.isSafeInteger(generation) || generation < 0) throw fail('access-context', '工作区或连接代次无效')
  const scope = { id: binding.id, sessionId: binding.sessionId, cwd: resolve(binding.cwd), model: binding.model, generation }
  for (const field of ['providerId', 'providerRevision', 'engine', 'mode']) {
    if (binding[field] !== undefined && binding[field] !== null && (typeof binding[field] !== 'string' || binding[field].length > 4096 || binding[field].includes('\0'))) throw fail('access-context', '模型权限上下文无效')
    scope[field] = binding[field] ?? null
  }
  return { signature: JSON.stringify(scope), scope }
}
function publicScope(scope) {
  const { providerRevision, ...safe } = scope
  return safe
}

/** Only server-validated bindings belong here. Full access is never persisted or read from binding input. */
export class AccessPolicy {
  #states = new Map()
  #challenges = new Map()
  #now

  constructor({ now = Date.now } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function')
    this.#now = now
  }

  #forgetChallenges(threadId) {
    for (const [token, challenge] of this.#challenges) if (threadId === undefined || challenge.scope.id === threadId) this.#challenges.delete(token)
  }

  mode(binding, generation) {
    const { signature } = context(binding, generation)
    const state = this.#states.get(binding.id)
    if (state && state.signature !== signature) {
      this.#states.delete(binding.id)
      this.#forgetChallenges(binding.id)
    }
    // Also invalidate a prepared challenge when the binding changes before it is confirmed.
    for (const [token, challenge] of this.#challenges) {
      if (challenge.expiresAt <= this.#now() || challenge.scope.id === binding.id && challenge.signature !== signature) this.#challenges.delete(token)
    }
    return this.#states.get(binding.id)?.mode ?? (binding.readOnly === true ? 'readonly' : 'approval')
  }

  prepare(binding, generation) {
    this.mode(binding, generation)
    const { scope, signature } = context(binding, generation)
    this.#forgetChallenges(binding.id)
    while (this.#challenges.size >= LIMIT) this.#challenges.delete(this.#challenges.keys().next().value)
    const token = randomBytes(32).toString('base64url')
    const expiresAt = this.#now() + TTL
    this.#challenges.set(token, { scope, signature, expiresAt })
    return {
      token, expiresAt, scope: publicScope(scope),
      message: '完整访问会允许此会话在应用进程权限下写文件和执行命令，不再逐项询问。仅当前会话及模型、工作区、连接代次有效；此确认两分钟内有效且仅能使用一次。',
    }
  }

  apply(binding, generation, mode, token) {
    validateAccessMode(mode)
    const { scope, signature } = context(binding, generation)
    if (mode === 'full') {
      const challenge = typeof token === 'string' ? this.#challenges.get(token) : null
      // A mismatched caller must not consume or revoke another binding's challenge.
      if (!challenge || challenge.signature !== signature) throw fail('access-token', '完整访问需要对此会话重新确认')
      if (challenge.expiresAt <= this.#now()) {
        this.#challenges.delete(token)
        throw fail('access-expired', '完整访问确认已过期，请重新确认')
      }
      this.#challenges.delete(token)
    }
    this.#forgetChallenges(binding.id)
    // Eviction is fail-closed: an evicted grant returns to its persisted readonly/approval default.
    if (!this.#states.has(binding.id) && this.#states.size >= 256) this.#states.delete(this.#states.keys().next().value)
    this.#states.set(binding.id, { signature, mode })
    return { mode, scope: publicScope(scope) }
  }

  invalidate(threadId) {
    if (threadId !== undefined && (typeof threadId !== 'string' || !threadId)) throw fail('access-context', '会话标识无效')
    if (threadId === undefined) this.#states.clear()
    else this.#states.delete(threadId)
    this.#forgetChallenges(threadId)
  }
}
