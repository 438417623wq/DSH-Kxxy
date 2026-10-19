/* kxxy-host@17 */
/**
 * kxxy-host — DSH Kxxy 宿主管理页插件。
 *
 * 设计要点（方案 T + 五项改进方案 v2）：
 *
 * 1. **复用官方 webServer 的公开扩展点**
 *    官方 `dsh-host-webserver` 的 `WebServer` 类公开四个注册点：
 *      register({ kind: "exact" | "prefix", path, handler })
 *      registerUpgrade({ path, handler })
 *      registerFallback(handler)
 *      tapIndex(transform)
 *    官方自己就有 8 个包在用（dsh-api-gateway 用 registerUpgrade、
 *    dsh-host-frontend-static 用 registerFallback 等），是稳定契约。
 *
 * 2. **同 origin 复用官方鉴权，不另造一套**
 *    管理页与官方前端同在 127.0.0.1:3080，因此自动共享官方的
 *    cookie/token 鉴权。管理 API 直接用官方 authorization 服务判定浏览器信任，
 *    避免自造鉴权带来的绕过风险。
 *
 * 3. **动作真做，做不到就明确失败**
 *    旧版 /kxxy/api/action 恒返回 202（什么都没做），前端却弹「成功」toast。
 *    现在的动作是分派表：
 *      restart-engine → 写 restart.request，原生层轮询消费（§7-2 方案 A）
 *      export-logs    → 真打包 tar.gz，A+B 双写落盘（§7-3）
 *      set-priv-mode / set-toggle → 写 kxxy-prefs.json
 *      term-key       → 写 stdin.request，原生层写进引擎 PTY
 *      install-ext / switch-mirror → 已迁往专用端点，此处明确 400
 *      未知动作       → 501，让前端抛错回滚按钮而不是假成功
 *
 * @module kxxy-host
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync, createReadStream } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as extinstall from './extinstall.mjs'
import * as health from './health.mjs'
import * as mirror from './mirror.mjs'
import { tarGzSync } from './tar.mjs'

/** 插件名。 */
export const name = 'kxxy-host'

/**
 * 依赖的官方服务。
 *
 * `webServer` 是官方公开服务（见 dsh-host-webserver 的 Service 声明）。
 * 刻意不 inject 可选服务 —— 缺任何一个都应视为部署错误而非静默降级。
 */
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = join(HERE, '..', 'web')

/** 宿主管理页 HTML 的缓存（首次读取后常驻）。 */
let cachedIndexHtml = null

/**
 * 主题偏好缓存（三轮优化 ①）。
 *
 * 官方对话页的主题偏好存在引擎 `dsh-settings` 服务的 `ui-theme` 命名空间
 * （字段 `preference` = light/dark/system，默认 system）。这里缓存最近一次
 * 读到的值供 /kxxy/api/state 轮询带出；POST 主题时同步更新。
 * `source: 'unavailable'` 表示 settings 服务不可达（前端退回跟随系统）。
 */
let themeCache = { preference: 'system', source: 'unavailable' }

/** 主题偏好合法值（与 dsh-client-ui-theme 的 THEME_PREFERENCES 一致）。 */
const THEME_PREFERENCES = ['light', 'dark', 'system']

/**
 * 读取 web 目录下的静态资源。
 *
 * 刻意不做目录遍历防护的复杂实现 —— 资源名来自固定白名单，
 * 且此路由仅在回环地址上暴露。
 */
function readWebAsset(relative) {
  const full = join(WEB_DIR, relative)
  if (!existsSync(full)) return null
  return readFileSync(full)
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

function contentTypeFor(path) {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return CONTENT_TYPES[path.slice(dot)] ?? 'application/octet-stream'
}

/**
 * 音视频后缀 → MIME 映射。
 *
 * 为什么不用上游 `/api/file`：那条路由的 `Content-Type` 来自引擎的 mime 表，
 * 本身没问题，但它有两处硬伤（见 media 路由的注释）：20 MiB 上限、无 Range。
 * 这里自己映射，顺带把「WebView 104 根本不支持的容器」也标出来 —— 让
 * 前端能在播放前就给出「格式不受支持」而不是让 `<video>` 抛一个
 * 用户看不懂的 `MEDIA_ELEMENT_ERROR: Format error`。
 */
const MEDIA_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
  '.mka': 'audio/x-matroska',
  '.wma': 'audio/x-ms-wma',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.au': 'audio/basic',
  '.amr': 'audio/amr',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
}

function mediaTypeFor(path) {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  return MEDIA_TYPES[path.slice(dot).toLowerCase()] ?? null
}

/**
 * WebView 兼容层（polyfill）的 inline 脚本，惰性读取后常驻。
 *
 * 见 web/compat.js 头部说明。核心事实：ROM 自带的 WebView 版本由系统决定，
 * 应用无法自带；官方前端插件 bundle 用了 `AbortSignal.any`（Chrome 116+），
 * 在旧 WebView 上抛 TypeError 并被连接层静默吞掉，表现为设置面板权限区
 * 渲染英文 key、模型区列表空白。
 */
let cachedCompatScript = null

function compatScript() {
  if (cachedCompatScript === null) {
    try {
      const raw = readFileSync(join(WEB_DIR, 'compat.js'), 'utf8')
      // inline script 内不得出现 `</script`，否则会提前闭合标签
      cachedCompatScript = raw.replace(/<\/script/gi, '<\\/script')
    } catch {
      cachedCompatScript = ''
    }
  }
  return cachedCompatScript
}

/**
 * 现代 JS 内建补齐层（含 blob 作用域注入），惰性读取后常驻。
 *
 * 与 compat.js 的分工见 web/modern.js 头部说明。一句话：compat.js 修「页面主
 * 作用域」，modern.js 修「页面 + blob worker / blob iframe」。真机事故是
 * pdf.js 的渲染 worker 与 HTML 预览 iframe 都跑在 blob: 的独立全局里，
 * `<head>` 注入够不到，导致右侧栏 PDF 显示「PDF 渲染进程无法继续」、
 * HTML 整片空白，而 logcat 里只有一条 blob: URL 上的
 * `ReferenceError: Iterator is not defined`。
 */
let cachedModernScript = null

function modernScript() {
  if (cachedModernScript === null) {
    try {
      const raw = readFileSync(join(WEB_DIR, 'modern.js'), 'utf8')
      // inline script 内不得出现 `</script`，否则会提前闭合标签
      cachedModernScript = raw.replace(/<\/script/gi, '<\\/script')
    } catch {
      cachedModernScript = ''
    }
  }
  return cachedModernScript
}

/**
 * 把兼容层插到 `<head>` 开标签之后（早于一切 module/classic script）。
 *
 * 时序是硬约束：官方前端入口是 `<head>` 内的 `<script type="module">`，
 * 兼容层必须排在它前面才能在其求值前装好 API。官方 `renderIndex` 的
 * 结构化注入行也插在同一位置、且在 tapIndex **之前**，因此本函数用
 * 相同的锚点即可，无需关心行顺序。
 *
 * 两份脚本共用一个注入点、且 compat 在前：compat.js 负责 URL/CSS 层面的
 * 修正，modern.js 负责内建补齐与 `URL.createObjectURL` 包装；后者包装的是
 * 全局函数，必须晚于任何可能读取它的代码（这里就是官方入口 module，仍在
 * 其后）。缺任何一份都不算失败 —— 文件缺失时静默降级，不影响页面启动。
 */
function injectCompat(html) {
  const script = compatScript()
  const modern = modernScript()
  let markup = ''
  if (script !== '') markup += `<script data-kxxy-compat>${script}</script>`
  if (modern !== '') markup += `<script data-kxxy-modern>${modern}</script>`
  if (markup === '') return html
  const open = /<head(?:\s[^>]*)?>/i.exec(html)
  if (open === null) return `${markup}${html}`
  const at = open.index + open[0].length
  return `${html.slice(0, at)}${markup}${html.slice(at)}`
}

/**
 * 判定请求是否来自可信浏览器。
 *
 * 复用官方 authorization 服务的判定（若可用）；不可用时退化为
 * 「只接受回环来源」这一保守策略 —— 绝不因为判定器缺失而放行任意来源。
 */
function isTrustedRequest(ctx, req) {
  try {
    const auth = ctx.get('authorization')
    if (auth && typeof auth.isTrustedRequest === 'function') {
      return auth.isTrustedRequest(req)
    }
  } catch {
    // 服务未注册：落到保守分支
  }
  const host = String(req.headers?.host ?? '')
  return host.startsWith('127.0.0.1:') || host.startsWith('localhost:')
}

/** 统一 JSON 应答。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读取请求体（限长，防滥用）。 */
function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// 状态采集
// ---------------------------------------------------------------------------

/**
 * 从引擎 `dsh-settings` 服务读官方主题偏好。
 *
 * settings 服务按名注入（与 dsh-api-settings-controller 的用法一致），
 * 运行时获取而非 inject 硬依赖 —— 缺失时前端退回跟随系统。
 * `describe()` 返回各 profile 条目的 {id, ns, revision, value}；
 * ui-theme 条目的 value 是 `{ preference, fontSize }`。
 */
function readThemePreference(settings) {
  if (!settings) return { preference: 'system', source: 'unavailable' }
  try {
    const descriptors = settings.describe()
    const entry = descriptors.find(
      (d) => (d.ns === 'ui-theme' || String(d.id).includes('ui-theme')) &&
        d.value && typeof d.value.preference === 'string',
    )
    if (!entry) return { preference: 'system', source: 'unavailable' }
    const preference = THEME_PREFERENCES.includes(entry.value.preference)
      ? entry.value.preference
      : 'system'
    return { preference, source: 'settings' }
  } catch {
    return { preference: 'system', source: 'unavailable' }
  }
}

/** 把主题偏好写回官方设置文档（控制台与对话页同源生效）。 */
async function writeThemePreference(settings, preference) {
  if (!settings) throw new Error('settings service unavailable')
  const descriptors = settings.describe()
  const entry = descriptors.find(
    (d) => (d.ns === 'ui-theme' || String(d.id).includes('ui-theme')) &&
      d.value && typeof d.value.preference === 'string',
  )
  if (!entry) throw new Error('ui-theme settings entry not found')
  await settings.update('ui-theme', { preference }, entry.revision)
}

/**
 * 采集引擎状态。
 *
 * 数据来源分两类：
 *   · 进程内可得：Node 版本、平台、cwd、环境变量摘要
 *   · 需原生层提供：pid、内存、运行时长（通过 KXXY_STATE_FILE 交换）
 *
 * 原生层（EngineService）会把状态写到 `$KXXY_STATE_FILE`，
 * 本插件只读该文件，避免引入跨进程 RPC。
 */
function collectEngineState(ctx) {
  const state = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    cwd: process.cwd(),
    uptimeSec: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    port: Number(process.env.PORT ?? 3080),
    privMode: process.env.DSH_ANDROID_PRIV_MODE ?? 'normal',
    permissionMode: process.env.DSH_PERMISSION_MODE ?? 'unknown',
    themePreference: themeCache.preference,
  }

  // 用户保存但尚未生效的权限等级（前端显示「已保存 · 重启引擎后生效」徽章）
  const engineRoot = extinstall.engineRoot()
  if (engineRoot) {
    try {
      const prefs = readPrefs(engineRoot)
      if (prefs.privMode) state.requestedPrivMode = String(prefs.privMode)
    } catch {
      // 偏好文件读不到就跳过该字段
    }
  }

  // 原生层写入的补充状态（可选）
  const stateFile = process.env.KXXY_STATE_FILE
  if (stateFile && existsSync(stateFile)) {
    try {
      // 容忍 UTF-8 BOM：Kotlin 的 File.writeText 默认不写 BOM，但外部工具
      // （编辑器、adb push 的 Windows 版本、诊断脚本）可能补上。
      // JSON.parse 遇到 BOM 会抛 "Unexpected token '\uFEFF'"，而这里的
      // catch 是静默的 —— 结果是 pid/uptimeSec/memoryMB 全部悄悄丢失，
      // 管理页只剩插件自身进程的数据，排查时极难定位。
      const raw = readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')
      const extra = JSON.parse(raw)
      Object.assign(state, extra)
    } catch {
      // 状态文件损坏不应让整个 API 失败
      state.stateFileError = true
    }
  }

  return state
}

/**
 * 采集运行时完整性信息（方案 P 的四层 ELF 审计结果的运行期视图）。
 *
 * 这里只做「存在性 + 可执行位 + 版本」的轻量检查；
 * 完整的 ELF 审计（e_machine / PT_INTERP / 16KB 对齐）在构建期由
 * tools/verify_runtime.py 完成，结果随 runtime.zip 一起分发。
 */
function collectRuntimeState() {
  const engineRoot = extinstall.engineRoot()
  const result = {
    engineRoot,
    checks: [],
  }

  const probes = [
    ['bin/node', 'Node 可执行文件'],
    ['bin/bash', 'bash 可执行文件'],
    ['bin/rg', 'ripgrep 可执行文件'],
    ['bin/python3', 'Python 解释器（④ 档内置）'],
    ['bin/clang', 'C/C++ 编译器（④ 档内置）'],
    ['lib/libreadline.so.8', 'SONAME 别名'],
    ['lib/node_modules/@deepseek-ai/dsh/lib/bin.js', 'DSH 引擎入口'],
    ['etc/tls/cert.pem', 'CA 证书'],
    ['android-overlay.yml', 'Android 适配覆盖层'],
  ]

  for (const [rel, label] of probes) {
    const full = join(engineRoot, rel)
    let ok = false
    let detail = 'missing'
    try {
      if (existsSync(full)) {
        const st = statSync(full)
        ok = st.isFile() && st.size > 0
        detail = ok ? `${st.size} bytes` : 'empty'
        if (ok && (rel.startsWith('bin/'))) {
          // 可执行位检查（Android 上 zip 解压后一律 0644，必须显式恢复）
          const exec = (st.mode & 0o111) !== 0
          if (!exec) {
            ok = false
            detail = 'not executable'
          }
        }
      }
    } catch (e) {
      detail = e.message
    }
    result.checks.push({ path: rel, label, ok, detail })
  }

  result.allOk = result.checks.every((c) => c.ok)
  return result
}

// ---------------------------------------------------------------------------
// 扩展中心
// ---------------------------------------------------------------------------

/** 正在进行的安装任务索引（extId → job 快照）。 */
function activeJobFor(extId) {
  for (const job of [...extinstall.jobsSnapshot()]) {
    if (job.extId === extId && (job.phase === 'queued' || job.phase === 'extract' || job.phase === 'link')) {
      return { jobId: job.id, phase: job.phase, percent: job.percent, message: job.message }
    }
  }
  return null
}

function collectExtensions() {
  const engineRoot = extinstall.engineRoot()
  const catalog = extinstall.readCatalog()
  const pool = extinstall.listPool(engineRoot)

  /** 已安装版本表。 */
  const installed = new Map()
  try {
    const extRoot = extinstall.extensionsDir(engineRoot)
    if (engineRoot && existsSync(extRoot)) {
      for (const entry of readdirSync(extRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.endsWith('.tmp-install')) continue
        const vf = join(extRoot, entry.name, '.ext-version')
        try {
          installed.set(entry.name, existsSync(vf) ? readFileSync(vf, 'utf8').trim() : 'unknown')
        } catch {
          installed.set(entry.name, 'unknown')
        }
      }
    }
  } catch {
    // 目录不可读时按全未安装处理
  }

  const items = (catalog?.items ?? []).map((item) => {
    const installedVersion = installed.get(item.id) ?? null
    if (installedVersion !== null) installed.delete(item.id)
    return {
      id: item.id,
      name: item.name,
      version: item.version,
      category: item.category ?? 'devtools',
      description: item.description ?? '',
      bins: item.bins ?? [],
      sizeBytes: item.sizeBytes ?? 0,
      // bundled = 包池里确实带着这个 tar.gz（APK 内置、点了就本地展开，零联网）
      bundled: pool.has(item.id),
      installed: installedVersion !== null,
      installedVersion,
      installing: activeJobFor(item.id),
    }
  })

  // 装过但目录里多出来的（目录清单没有的条目）也列出来，免得「装了却看不见」
  for (const [id, version] of installed) {
    items.push({
      id,
      name: id,
      version,
      category: 'devtools',
      description: '',
      bins: [],
      sizeBytes: 0,
      bundled: false,
      installed: true,
      installedVersion: version,
      installing: null,
    })
  }

  return {
    items,
    builtin: catalog?.builtin ?? null,
    poolCount: pool.size,
    engineRoot,
  }
}

// ---------------------------------------------------------------------------
// 动作分派表
// ---------------------------------------------------------------------------

/** 用户偏好文件（权限模式与三个开关的真值来源）。 */
function prefsFile(root) {
  return join(root, 'kxxy-prefs.json')
}

function readPrefs(root) {
  try {
    return JSON.parse(readFileSync(prefsFile(root), 'utf8'))
  } catch {
    return {}
  }
}

function writePrefs(root, patch) {
  if (!root) return { ok: false, error: 'engine root unknown (KXXY_ENGINE_ROOT not set)' }
  try {
    const prefs = { ...readPrefs(root), ...patch, updatedAt: Date.now() }
    writeFileSync(prefsFile(root), `${JSON.stringify(prefs, null, 2)}\n`)
    return { ok: true, prefs }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 终端快捷键 → 注入引擎 PTY 的字节序列。 */
const TERM_KEY_BYTES = {
  'ctrl-c': '\x03',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  esc: '\x1b',
  enter: '\r',
}

function writeStdinRequest(root, bytes) {
  if (!root) return { ok: false, error: 'engine root unknown' }
  try {
    writeFileSync(extinstall.stdinRequestPath(root), Buffer.from(bytes, 'utf8'))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 导出诊断日志（§7-3 方案 A + B 双写，默认公共下载目录，失败退回私有目录）。
 *
 * 内容：engine.log（环形上限 2 MiB，天然有界）+ 原生层状态快照 +
 * 一份 diag.json（进程/扩展/镜像摘要，不含任何凭证 —— mirror/npmrc 都只存 registry）。
 */
function exportLogs(root) {
  if (!root) return { status: 500, body: { error: 'engine root unknown' } }

  const files = []
  try {
    const logFile = join(root, 'engine.log')
    if (existsSync(logFile)) {
      const buf = readFileSync(logFile)
      files.push({ name: 'engine.log', data: buf.subarray(-2 * 1024 * 1024) })
    }
  } catch { /* 日志读不到就跳过，导出不因此失败 */ }
  try {
    const stateFile = process.env.KXXY_STATE_FILE || join(root, 'kxxy-state.json')
    if (existsSync(stateFile)) {
      files.push({ name: 'kxxy-state.json', data: readFileSync(stateFile) })
    }
  } catch { /* 同上 */ }

  const diag = {
    exportedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeSec: Math.round(process.uptime()),
    engineRoot: root,
    extensions: collectExtensions().items
      .filter((i) => i.installed)
      .map((i) => ({ id: i.id, version: i.installedVersion })),
    mirror: mirror.describe(root),
  }
  files.push({ name: 'diag.json', data: Buffer.from(`${JSON.stringify(diag, null, 2)}\n`, 'utf8') })

  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const name = `kxxy-logs-${stamp}.tar.gz`
  const tar = tarGzSync(files)

  // 方案 B：公共下载目录（文件管理器直接可见，微信/QQ 可直接发送）。
  // ⚠️ 先判存在再 mkdir —— Windows 上 Node 会把 /sdcard 解析成「当前盘根下的
  // \sdcard」，mkdirSync(recursive) 真会给你在 F:\ 建出一棵目录树来。
  // Android 上 /sdcard 恒存在，这个守卫只过滤非 Android 宿主。
  const PUBLIC_DIRS = ['/sdcard/Download/kxxy', '/storage/emulated/0/Download/kxxy']
  for (const dir of PUBLIC_DIRS) {
    try {
      if (!existsSync(dirname(dir))) continue
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), tar)
      return {
        status: 200,
        body: {
          ok: true,
          location: 'download',
          path: join(dir, name),
          note: '已保存到下载目录',
        },
      }
    } catch {
      // 权限未开（MANAGE_EXTERNAL_STORAGE / WRITE_EXTERNAL_STORAGE 未授）→ 下一个
    }
  }

  // 方案 A：应用私有目录 —— 一定能写成功，但文件管理器里看不到
  try {
    const priv = join(root, 'export')
    mkdirSync(priv, { recursive: true })
    writeFileSync(join(priv, name), tar)
    return {
      status: 200,
      body: {
        ok: true,
        location: 'private',
        path: join(priv, name),
        downloadUrl: `/kxxy/api/export/${name}`,
        note: '已保存到应用私有目录（可在系统设置里开启「所有文件访问」后重试，即可保存到下载目录）',
      },
    }
  } catch (e) {
    return { status: 500, body: { error: `导出失败：${e?.message ?? e}` } }
  }
}

/** 分派表。返回 {status, body}。 */
function dispatchAction(payload) {
  const root = extinstall.engineRoot()
  const action = payload?.action

  switch (action) {
    case 'restart-engine': {
      // 进程没法重启自己（本插件跑在引擎进程里）：写请求文件，
      // 由原生层 EngineSupervisor 的轮询消费（§7-2 方案 A）。
      if (!root) return { status: 503, body: { error: 'engine root unknown' } }
      try {
        writeFileSync(extinstall.restartRequestPath(root), `${Date.now()}\n`)
        return {
          status: 200,
          body: {
            ok: true,
            requested: true,
            note: '重启请求已写入，原生层将在 1~2 秒内重启引擎进程',
          },
        }
      } catch (e) {
        return { status: 500, body: { error: String(e?.message ?? e) } }
      }
    }

    case 'export-logs':
      return exportLogs(root)

    case 'set-priv-mode': {
      const value = String(payload.value ?? payload.mode ?? '')
      if (!['normal', 'shizuku', 'root'].includes(value)) {
        return { status: 400, body: { error: `invalid priv mode: ${value}` } }
      }
      const res = writePrefs(root, { privMode: value })
      if (!res.ok) return { status: 500, body: { error: res.error } }
      // 权限模式在引擎启动时注入（buildEnv 的 DSH_ANDROID_PRIV_MODE），
      // 改完必须重启引擎才生效 —— 明说，不给「假成功」。
      return { status: 200, body: { ok: true, requiresRestart: true, note: '权限模式已保存；重启引擎后生效' } }
    }

    case 'set-toggle': {
      const key = String(payload.key ?? '')
      if (!['foreground', 'watchdog', 'lan'].includes(key)) {
        return { status: 400, body: { error: `unknown toggle key: ${key}` } }
      }
      const res = writePrefs(root, { toggles: { ...(readPrefs(root).toggles ?? {}), [key]: Boolean(payload.value) } })
      if (!res.ok) return { status: 500, body: { error: res.error } }
      return { status: 200, body: { ok: true } }
    }

    case 'term-key': {
      const key = String(payload.key ?? '')
      const bytes = TERM_KEY_BYTES[key]
      if (!bytes) return { status: 400, body: { error: `unknown term key: ${key}` } }
      const res = writeStdinRequest(root, bytes)
      if (!res.ok) return { status: 500, body: { error: res.error } }
      return { status: 200, body: { ok: true } }
    }

    // ── 已迁往专用端点的旧动作：明确报错并指引，绝不假成功 ──────────
    case 'install-ext':
      return {
        status: 400,
        body: { error: 'install-ext 已迁往 POST /kxxy/api/extensions/install {id}' },
      }
    case 'switch-mirror':
      return {
        status: 400,
        body: { error: 'switch-mirror 已迁往 POST /kxxy/api/mirror/test 与 /kxxy/api/mirror/apply {id}' },
      }

    default:
      return { status: 501, body: { error: 'not implemented', action: action ?? null } }
  }
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 插件主体。
 *
 * @param ctx - Cordis 根上下文
 */
export function apply(ctx) {
  ctx.effect(() => {
    // ── 引擎 settings 服务（官方主题偏好的真值来源）──────────────────
    // 运行时获取而非 inject 硬依赖：服务缺失时主题端点降级为「跟随系统」，
    // 不拖垮整个插件。
    const getSettings = () => {
      try {
        return ctx.get('settings') ?? null
      } catch {
        return null
      }
    }

    // ── 升级自愈：runtime 升级后按 .links.json 重建扩展接入点 ──────────
    const root0 = extinstall.engineRoot()
    const rebuilt = extinstall.relinkAll(root0)
    if (rebuilt > 0) {
      ctx.logger?.info?.(`[kxxy-host] relinkAll: ${rebuilt} extension(s) relinked after runtime upgrade`)
    }

    // ── 布局迁移：把旧代码装的扩展重新装配一遍 ────────────────────────
    //
    // 为什么必须做：扩展目录是用户态资产，`RuntimeInstaller` 的自愈从不碰
    // `extensions/`，所以「代码修好了但设备上还是旧布局」会长期存在 ——
    // 真机实测 texlive 重装后 `bin/` 从 1218 涨到 1629（+411 个 TeX 引擎、
    // 这才让 pdftex/xelatex 真的可调用），而其余扩展仍缺 `lib/rustlib`、
    // `etc/fonts`、且 perl 的 Config_heavy.pl 还写着 Termux 前缀。
    //
    // 串行、后台、不阻塞启动：包池就在设备上，不必重新下载，但解包 13–250 MB
    // 仍要时间。startInstall 自带 installChain 串行与重复安装保护。
    try {
      const stale = extinstall.staleExtensions(root0)
      if (stale.length > 0) {
        const catalog = extinstall.readCatalog()
        ctx.logger?.info?.(`[kxxy-host] 装配布局升级：${stale.length} 个扩展待重装（${stale.join(', ')}）`)
        for (const id of stale) {
          const item = catalog?.items?.find((i) => i.id === id) ?? {}
          const started = extinstall.startInstall(root0, id, item)
          if (started.error) ctx.logger?.warn?.(`[kxxy-host] ${id} 重装未能启动：${started.error}`)
        }
      }
    } catch (e) {
      ctx.logger?.warn?.(`[kxxy-host] staleExtensions 检查失败：${String(e?.message ?? e)}`)
    }

    // ── WebView 兼容层：注入到官方前端 index.html 的 <head> ────────────
    // 必须走 tapIndex（官方公开扩展点）而不是在 onPageFinished 里
    // evaluateJavascript —— 后者晚于入口 module 求值，连接代际循环已经
    // 以失败态启动，补回 API 也不会让重试计数归零（实测：补回后 body 从
    // 31 恢复到 292，但 retry 仍继续）。
    const disposeCompat = ctx.webServer.tapIndex(injectCompat)

    // ── 静态资源：/kxxy/assets/* ─────────────────────────────────────
    // ⚠️ path 不能带尾斜杠：WebServer.match() 的判据是
    //     `pathname === prefix || pathname.startsWith(`${prefix}/`)`
    //   （见 @deepseek-ai/dsh-host-webserver/lib/index.js:328）。注册
    //   "/kxxy/assets/" 会让前缀变成 "/kxxy/assets//"，请求 "/kxxy/assets/host.css"
    //   既不等于前缀也不以其加斜杠开头 → 永不匹配 → 全部 404。
    const disposeAssets = ctx.webServer.register({
      kind: 'prefix',
      path: '/kxxy/assets',
      handler: async (req, res) => {
        const rel = decodeURIComponent(String(req.url ?? '').split('?')[0])
          .replace(/^\/kxxy\/assets\//, '')
        // 白名单式防穿越：只允许单层文件名
        if (rel.includes('/') || rel.includes('..')) {
          res.writeHead(400)
          res.end('bad asset path')
          return
        }
        const buf = readWebAsset(rel)
        if (buf === null) {
          res.writeHead(404)
          res.end('asset not found')
          return
        }
        res.writeHead(200, {
          'content-type': contentTypeFor(rel),
          'content-length': buf.length,
          'cache-control': 'no-cache',
        })
        res.end(buf)
      },
    })

    // ── 媒体流：/kxxy/media?path=<绝对路径> ──────────────────────────
    //
    // 为什么不直接用上游的 /api/file（缺陷 AI 的根因）：
    //   1. 它的上限取自 `ctx.attachments.imageLimits.maxImageBytes`（默认 20 MiB），
    //      一个 5 秒的手机视频就能超；超了直接 413，前端只看到一片空白。
    //   2. 它把整个文件 `readBytes` 进内存再 `new Response(bytes.slice())`，
    //      既没有 Range/206 也没有流式 —— `<video>` 拿不到 206 就无法 seek，
    //      而且一个 2 GB 的片子会直接把引擎 OOM。
    // 本路由做三件事：按 Range 切片流式回、始终给 `Accept-Ranges: bytes`、
    // 按后缀给准确的 Content-Type（上游 mime 表对 .mkv/.opus 之类会退化成
    // application/octet-stream，浏览器便拒绝播放）。
    //
    // 安全边界：仅回环可信请求（isTrustedRequest），且只接受绝对路径。
    // 引擎进程本身以 app uid 运行，能读的文件与官方 /api/file 完全一致，
    // 不额外放宽。
    const disposeMedia = ctx.webServer.register({
      kind: 'prefix',
      path: '/kxxy/media',
      handler: async (req, res) => {
        if (!isTrustedRequest(ctx, req)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end('method not allowed')
          return
        }

        let target = ''
        try {
          target = new URL(String(req.url ?? ''), 'http://127.0.0.1').searchParams.get('path') ?? ''
        } catch {
          target = ''
        }
        // 必须是绝对路径：相对路径会按引擎的工作目录解析，等于给网页一个
        // 「猜引擎 cwd」的入口。用 `isAbsolute` 而不是 `startsWith('/')`，
        // 这样冒烟测试在 Windows 构建机上跑同一套判据（Android 上 posix
        // 语义就是 `startsWith('/')`，两者对生产行为无差别）。
        if (target === '' || target.includes('\0') || !isAbsolute(target)) {
          res.writeHead(400)
          res.end('absolute path required')
          return
        }

        let stat = null
        try {
          stat = statSync(target)
        } catch {
          stat = null
        }
        if (stat === null || !stat.isFile()) {
          res.writeHead(404)
          res.end('file not found')
          return
        }

        const mediaType = mediaTypeFor(target)
        const headers = {
          'content-type': mediaType ?? contentTypeFor(target),
          'cache-control': 'private, no-store',
          // nosniff 会阻止浏览器「猜」类型 —— 对音视频是必要的保护，
          // 因为我们必须给准 Content-Type 才能播。
          'x-content-type-options': 'nosniff',
          'accept-ranges': 'bytes',
        }

        // Range 解析：只支持单段 `bytes=a-b`（`<video>` 的 seek 就是这个形态）。
        // 多段 Range 一律按「不支持」退化成全量 200 —— 浏览器会自行接受。
        const rangeHeader = String(req.headers?.range ?? '')
        let start = 0
        let end = stat.size - 1
        let partial = false
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
        if (match !== null && (match[1] !== '' || match[2] !== '')) {
          if (match[1] === '') {
            // 后缀形态 `bytes=-N`：最后 N 字节
            const suffix = Number(match[2])
            start = Math.max(0, stat.size - suffix)
          } else {
            start = Number(match[1])
            if (match[2] !== '') end = Math.min(end, Number(match[2]))
          }
          if (start > end || start >= stat.size) {
            res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
            res.end()
            return
          }
          partial = true
        }

        const length = end - start + 1
        if (partial) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`
        headers['content-length'] = String(length)
        res.writeHead(partial ? 206 : 200, headers)

        if (req.method === 'HEAD') {
          res.end()
          return
        }

        // 空文件（或 Range 恰好落在末尾之后）没有可读范围：`createReadStream` 收到
        // `end: -1` 会抛 ERR_OUT_OF_RANGE，这里直接收尾。
        if (length <= 0) {
          res.end()
          return
        }

        // 流式回，不整文件进内存。
        const stream = createReadStream(target, { start, end })
        stream.on('error', () => {
          // 头已发出，只能掐断连接让客户端看到「加载失败」而不是挂死。
          res.destroy()
        })
        // 客户端提前断开（用户切走、seek）时立刻释放 fd，否则连续 seek
        // 会耗尽描述符。
        res.on('close', () => stream.destroy())
        stream.pipe(res)
      },
    })

    // ── 管理 API：/kxxy/api/* ───────────────────────────────────────
    // 同样不能带尾斜杠，理由见上面的 assets 路由。
    const disposeApi = ctx.webServer.register({
      kind: 'prefix',
      path: '/kxxy/api',
      handler: async (req, res) => {
        if (!isTrustedRequest(ctx, req)) {
          sendJson(res, 403, { error: 'forbidden' })
          return
        }

        const path = String(req.url ?? '').split('?')[0]

        try {
          if (path === '/kxxy/api/state' && req.method === 'GET') {
            // 主题偏好随轮询刷新：官方设置页改了主题，控制台几秒内跟随
            themeCache = readThemePreference(getSettings())
            sendJson(res, 200, {
              engine: collectEngineState(ctx),
              runtime: collectRuntimeState(),
            })
            return
          }

          // ── 主题（读写官方 ui-theme 偏好，控制台与对话页同源生效）────
          if (path === '/kxxy/api/theme' && req.method === 'GET') {
            themeCache = readThemePreference(getSettings())
            sendJson(res, 200, themeCache)
            return
          }

          if (path === '/kxxy/api/theme' && req.method === 'POST') {
            const payload = JSON.parse((await readBody(req)) || '{}')
            const preference = String(payload.preference ?? '')
            if (!THEME_PREFERENCES.includes(preference)) {
              sendJson(res, 400, { error: `invalid preference: ${preference}` })
              return
            }
            try {
              await writeThemePreference(getSettings(), preference)
              themeCache = { preference, source: 'settings' }
              sendJson(res, 200, {
                ok: true,
                preference,
                note: '已写入官方外观偏好，对话界面同步生效',
              })
            } catch (e) {
              sendJson(res, 409, { error: String(e?.message ?? e) })
            }
            return
          }

          // ── 扩展中心 ────────────────────────────────────────────────
          if (path === '/kxxy/api/extensions' && req.method === 'GET') {
            sendJson(res, 200, collectExtensions())
            return
          }

          if (path === '/kxxy/api/extensions/install' && req.method === 'POST') {
            const payload = JSON.parse((await readBody(req)) || '{}')
            const root = extinstall.engineRoot()
            const catalog = extinstall.readCatalog()
            const item = catalog?.items?.find((i) => i.id === payload.id) ?? {}
            const started = extinstall.startInstall(root, String(payload.id ?? ''), item)
            if (started.error) {
              sendJson(res, 409, { error: started.error, jobId: started.jobId ?? null })
              return
            }
            // 202：异步安装，前端拿 jobId 轮询 /extensions/job
            sendJson(res, 202, { accepted: true, jobId: started.jobId })
            return
          }

          if (path === '/kxxy/api/extensions/job' && req.method === 'GET') {
            const jobId = new URL(req.url, 'http://127.0.0.1').searchParams.get('id') ?? ''
            const job = extinstall.getJob(jobId)
            if (!job) {
              sendJson(res, 404, { error: 'unknown job' })
              return
            }
            sendJson(res, 200, job)
            return
          }

          if (path === '/kxxy/api/extensions/remove' && req.method === 'POST') {
            const payload = JSON.parse((await readBody(req)) || '{}')
            const result = extinstall.removeExtension(extinstall.engineRoot(), String(payload.id ?? ''))
            if (result.error) {
              sendJson(res, 400, { error: result.error })
              return
            }
            sendJson(res, 200, result)
            return
          }

          // ── 镜像源 ──────────────────────────────────────────────────
          if (path === '/kxxy/api/mirror' && req.method === 'GET') {
            sendJson(res, 200, mirror.readCurrent(extinstall.engineRoot()))
            return
          }

          if (path === '/kxxy/api/mirror/test' && req.method === 'POST') {
            const results = await mirror.testMirrors()
            sendJson(res, 200, { results })
            return
          }

          if (path === '/kxxy/api/mirror/apply' && req.method === 'POST') {
            const payload = JSON.parse((await readBody(req)) || '{}')
            const result = mirror.applyMirror(extinstall.engineRoot(), String(payload.id ?? ''))
            sendJson(res, result.ok ? 200 : 400, result)
            return
          }

          // ── 导出的日志下载（私有目录场景的兜底取出通道）────────────
          const exportMatch = path.match(/^\/kxxy\/api\/export\/([A-Za-z0-9._-]+\.tar\.gz)$/)
          if (exportMatch && req.method === 'GET') {
            const root = extinstall.engineRoot()
            const file = join(root, 'export', exportMatch[1])
            if (!root || !existsSync(file)) {
              sendJson(res, 404, { error: 'export not found' })
              return
            }
            const buf = readFileSync(file)
            res.writeHead(200, {
              'content-type': 'application/gzip',
              'content-length': buf.length,
              'content-disposition': `attachment; filename="${exportMatch[1]}"`,
              'cache-control': 'no-store',
            })
            res.end(buf)
            return
          }

          // ── 启动配置体检（方案 K 的常驻形态）───────────────────────
          //
          // 只读：解析三层补丁、profile 清单、宿主覆盖层、扩展目录、
          // 运行时锚点。引擎健康时随时可调，不写盘、不重启。
          //
          // 为什么不是「等引擎崩了再诊断」：原生侧 RecoveryProbe 只能在
          // BootstrapActivity 的 Failed 分支跑，而用户真正想要的是提前
          // 知道「下次重启会不会挂」。体检放在这里才能满足这个诉求。
          if (path === '/kxxy/api/health' && req.method === 'GET') {
            // 体检绝不能把宿主插件搞崩。它要读用户配置文件、按路径推导
            // 引擎根，任何一处意外（权限、路径不存在、解析器缺失）都可能
            // 抛异常 —— 而这个路由挂在引擎进程内，未捕获异常会带走整个
            // 宿主插件，让「体检」本身变成故障源。所以兜住，把错误当成
            // 一条诊断结果返回。
            try {
              sendJson(res, 200, health.runHealthCheck(extinstall.engineRoot()))
            } catch (e) {
              sendJson(res, 500, {
                ok: false,
                headline: '体检执行失败',
                level: 'NONE',
                checks: [],
                error: String(e?.stack ?? e?.message ?? e),
              })
            }
            return
          }

          // 修复请求：写 recovery.request，由原生 EngineSupervisor 的
          // 请求轮询消费（与 restart.request / stdin.request 同一机制）。
          //
          // 引擎进程没法修自己 —— 修复要移文件、重写清单、重启进程，
          // 这些只有原生层能做。所以这里只落一个请求文件就返回 202，
          // 前端轮询 /api/health 看结果。
          if (path === '/kxxy/api/recovery' && req.method === 'POST') {
            const raw = await readBody(req)
            let payload
            try {
              payload = JSON.parse(raw || '{}')
            } catch {
              sendJson(res, 400, { error: 'invalid json' })
              return
            }
            const level = String(payload.level ?? 'L1').toUpperCase()
            // UNDO 走同一条通道：撤销同样是「请原生层动手」——它要搬回
            // 文件、恢复 bundle 列表、重启引擎，引擎自己做不到。
            if (!['L1', 'L2', 'L3', 'UNDO'].includes(level)) {
              sendJson(res, 400, { error: `invalid level: ${level}` })
              return
            }
            const root = extinstall.engineRoot()
            if (!root) {
              sendJson(res, 500, { error: 'engine root unknown' })
              return
            }
            try {
              writeFileSync(
                join(root, 'recovery.request'),
                `${JSON.stringify({
                  level,
                  headline: String(payload.headline ?? ''),
                  requestedAt: Date.now(),
                }, null, 2)}\n`,
              )
            } catch (e) {
              sendJson(res, 500, { error: String(e?.message ?? e) })
              return
            }
            ctx.logger?.info?.(`[kxxy-host] recovery requested: ${level}`)
            sendJson(res, 202, {
              accepted: true,
              level,
              note: '已请求原生层修复，引擎会重启',
            })
            return
          }

          // 最近一次修复的执行结果（原生层写 recovery-result.json）。
          // 引擎重启后新进程读它，页面就能显示「上次修了什么」。
          if (path === '/kxxy/api/recovery/result' && req.method === 'GET') {
            const root = extinstall.engineRoot()
            const file = root ? join(root, 'recovery-result.json') : ''
            if (!file || !existsSync(file)) {
              sendJson(res, 200, { pending: false, result: null })
              return
            }
            try {
              const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
              sendJson(res, 200, { pending: false, result: JSON.parse(raw) })
            } catch (e) {
              sendJson(res, 200, { pending: false, result: null, error: String(e?.message ?? e) })
            }
            return
          }

          if (path === '/kxxy/api/log' && req.method === 'GET') {
            const engineRoot = extinstall.engineRoot()
            const logFile = join(engineRoot, 'engine.log')
            let tail = ''
            try {
              if (existsSync(logFile)) {
                const all = readFileSync(logFile, 'utf8')
                tail = all.slice(-64 * 1024)
              }
            } catch (e) {
              tail = `log read failed: ${e.message}`
            }
            sendJson(res, 200, { tail })
            return
          }

          if (path === '/kxxy/api/action' && req.method === 'POST') {
            const raw = await readBody(req)
            let payload
            try {
              payload = JSON.parse(raw || '{}')
            } catch {
              sendJson(res, 400, { error: 'invalid json' })
              return
            }
            const result = dispatchAction(payload)
            ctx.logger?.info?.(
              `[kxxy-host] action=${payload.action ?? '?'} -> ${result.status}`,
            )
            sendJson(res, result.status, result.body)
            return
          }

          sendJson(res, 404, { error: 'unknown endpoint', path })
        } catch (e) {
          sendJson(res, 500, { error: e?.message ?? String(e) })
        }
      },
    })

    // ── 宿主管理页：/kxxy ───────────────────────────────────────────
    // 同时挂 "/kxxy/"：用户手输地址栏时很容易带上尾斜杠，而 exact 表是精确匹配，
    // 缺了这一条就是 404。两条都指向同一个 handler。
    const renderPage = async (req, res) => {
      if (cachedIndexHtml === null) {
        const buf = readWebAsset('index.html')
        cachedIndexHtml = buf ?? Buffer.from(
          '<!doctype html><meta charset="utf-8"><title>DSH Kxxy</title>' +
          '<p>宿主管理页资源缺失（web/index.html）。</p>',
          'utf8',
        )
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': cachedIndexHtml.length,
        'cache-control': 'no-cache',
      })
      res.end(cachedIndexHtml)
    }
    const disposePage = ctx.webServer.register({
      kind: 'exact',
      path: '/kxxy',
      handler: renderPage,
    })
    const disposePageSlash = ctx.webServer.register({
      kind: 'exact',
      path: '/kxxy/',
      handler: renderPage,
    })

    ctx.logger?.info?.('[kxxy-host] mounted: /kxxy (page), /kxxy/assets (prefix), /kxxy/media (prefix), /kxxy/api (prefix), index compat tap')

    return () => {
      disposePageSlash()
      disposePage()
      disposeApi()
      disposeMedia()
      disposeAssets()
      disposeCompat()
    }
  })
}
