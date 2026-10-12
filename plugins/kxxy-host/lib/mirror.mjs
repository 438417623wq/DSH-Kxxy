/**
 * npm 镜像源：真实测速 + 真实切换（五项改进方案 §3）。
 *
 * 与旧版「点了返回 202、页面显示写死的『清华源 38ms』」的本质区别：
 *   - 测速是真的：对每个候选源发 `GET <registry>/-/ping`，3 次取中位数；
 *   - 切换是真的：写三处配置（$HOME/.npmrc、<root>/etc/npmrc、<root>/etc/mirror.json），
 *     并同步改本进程的 npm_config_registry —— kxxy-host 自己 spawn 的子进程立即生效。
 *
 * ⚠️ 必须向用户明示的边界：引擎进程的 buildEnv 在**启动时**把 registry 注进了
 * 环境变量，正在跑的引擎进程不会因为改了 .npmrc 就换源 —— 所以 apply 返回
 * requiresRestart: true，前端拿它引导用户走 restart-engine（§7-2 方案 A 之后
 * 那是一键可用的）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const CANDIDATES = [
  { id: 'npmmirror', name: 'npmmirror（阿里）', url: 'https://registry.npmmirror.com' },
  { id: 'npm', name: 'npm 官方源', url: 'https://registry.npmjs.org' },
  { id: 'tencent', name: '腾讯云镜像', url: 'https://mirrors.cloud.tencent.com/npm' },
  { id: 'huawei', name: '华为云镜像', url: 'https://mirrors.huaweicloud.com/repository/npm' },
]

const TEST_TIMEOUT_MS = 2_500
const PROBE_ROUNDS = 3

function median(list) {
  const s = [...list].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

async function probeOnce(url) {
  const started = Date.now()
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  })
  // 只要 HTTP 栈应答就算通：有的镜像没有 /-/ping，404 也证明了连通性
  await res.arrayBuffer()
  return Date.now() - started
}

/** 对单个候选源测 PROBE_ROUNDS 次，返回中位数毫秒；全失败返回 null。 */
async function probeCandidate(candidate) {
  const pingUrl = `${candidate.url}/-/ping`
  const samples = []
  for (let i = 0; i < PROBE_ROUNDS; i += 1) {
    try {
      samples.push(await probeOnce(pingUrl))
    } catch {
      // 单次失败不计入；全部失败时降级探测根路径
    }
  }
  if (samples.length === 0) {
    try {
      samples.push(await probeOnce(candidate.url))
    } catch {
      return { ...candidate, ms: null }
    }
  }
  return { ...candidate, ms: median(samples) }
}

/** 并发探测全部候选源。 */
export async function testMirrors() {
  return Promise.all(CANDIDATES.map(probeCandidate))
}

/** 持久化位置：<root>/etc/mirror.json。 */
function mirrorStateFile(root) {
  return join(root, 'etc', 'mirror.json')
}

/**
 * 读当前生效源。优先级：mirror.json（用户明确选择过）→ 环境变量 → 缺省 npmmirror。
 */
export function readCurrent(root) {
  let chosen = null
  if (root) {
    try {
      const raw = JSON.parse(readFileSync(mirrorStateFile(root), 'utf8'))
      const hit = CANDIDATES.find((c) => c.id === raw.id || c.url === raw.url)
      if (hit) {
        chosen = { ...hit, testedAt: raw.testedAt ?? null }
      }
    } catch {
      // 没测过/没切过 → 走环境变量
    }
  }
  if (!chosen) {
    const envUrl = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || ''
    let envHost = ''
    try {
      envHost = envUrl ? new URL(envUrl).host : ''
    } catch {
      envHost = ''
    }
    const hit = CANDIDATES.find((c) => c.url === envUrl)
      ?? CANDIDATES.find((c) => envHost && c.url.includes(envHost))
    chosen = hit ?? CANDIDATES[0]
  }
  return { ...chosen, appliedAt: null }
}

function npmrcText(url) {
  // registry 之外不给 npmrc 添任何东西：auth token 绝不经手
  return `registry=${url}\n`
}

/**
 * 切换镜像源：写三处 + 改本进程环境变量。
 *
 * @returns {{ok: true, mirror, requiresRestart: true} | {ok: false, error: string}}
 */
export function applyMirror(root, id) {
  const candidate = CANDIDATES.find((c) => c.id === id)
  if (!candidate) return { ok: false, error: `unknown mirror id: ${id}` }

  const testedAt = Date.now()
  try {
    // ① $HOME/.npmrc —— npm/pnpm 直接读
    const home = process.env.HOME || (root ? dirname(root) : '')
    if (home) {
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, '.npmrc'), npmrcText(candidate.url))
    }

    if (root) {
      // ② <root>/etc/npmrc —— npm_config_userconfig 的兜底
      const etc = join(root, 'etc')
      mkdirSync(etc, { recursive: true })
      writeFileSync(join(etc, 'npmrc'), npmrcText(candidate.url))

      // ③ <root>/etc/mirror.json —— 本模块与 UI 的真值来源
      writeFileSync(
        mirrorStateFile(root),
        `${JSON.stringify({ id: candidate.id, url: candidate.url, testedAt }, null, 2)}\n`,
      )
    }

    // ④ 本进程环境变量：kxxy-host 自己 spawn 的子进程（如 dsh plugin add）立即用新源
    process.env.npm_config_registry = candidate.url
    process.env.NPM_CONFIG_REGISTRY = candidate.url
    process.env.COREPACK_NPM_REGISTRY = candidate.url

    return {
      ok: true,
      mirror: { id: candidate.id, name: candidate.name, url: candidate.url, testedAt },
      requiresRestart: true,
      note: '已切换；引擎进程的 registry 在启动时注入，重启引擎后对引擎生效',
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 诊断导出用：当前配置的只读摘要（绝不包含 token —— 本模块从不写 token）。 */
export function describe(root) {
  const current = readCurrent(root)
  let npmrc = null
  const home = process.env.HOME
  if (home && existsSync(join(home, '.npmrc'))) {
    try {
      npmrc = readFileSync(join(home, '.npmrc'), 'utf8').trim()
    } catch {
      npmrc = null
    }
  }
  return { current, npmrc }
}
