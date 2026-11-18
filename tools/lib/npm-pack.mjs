/**
 * npm 源的工具包池（扩展池的第二种来源）。
 *
 * 为什么需要它：`fetch-extensions.mjs` 原来只会从 Termux 索引求 deb 闭包，
 * 而前端工具链（TypeScript / ESLint / Prettier / esbuild / Rollup / Vite）
 * 根本不在 deb 世界里 —— 它们只有 npm 包。缺的不是「下载」，是**一种打包方式**。
 *
 * ── 为什么不能直接 `npm install` 就算完 ──────────────────────────────────
 *
 * npm 会按**构建机**的 `process.platform`/`arch` 过滤 `os`/`cpu` 声明的可选依赖。
 * 在 Windows 上装 esbuild，拿到的是 `@esbuild/win32-x64`，`@esbuild/android-arm64`
 * 会被静默跳过 —— 打到设备上就是「命令在、一跑就找不到二进制」。
 *
 * 两个解法里选了后者：
 *   · 手写依赖解析（要自己处理扁平化、版本冲突、peer deps）—— 工作量大且易错；
 *   · `npm install --os=android --cpu=arm64`（npm ≥ 10 的官方开关，见
 *     `npm help config` 的 `os`/`cpu`/`libc`）—— 让 npm 按目标平台解析。
 *
 * 所以这里只做四件事：定位 npm、按目标平台装到 staging、生成 `bin/` 包装器、
 * 打成 `<id>.pool`。依赖解析全部交给 npm 自己。
 *
 * ── 产物形态 ────────────────────────────────────────────────────────────
 *
 * 与 `poolextract.py` 的 deb 池**逐字节同构**，设备端 `extinstall` 不需要任何
 * 新分支：
 *
 *   <id>.pool               tar.gz，路径相对扩展目录
 *   bin/<cmd>               包装器（含 `@DSH_ROOT@` 占位符，装完回填）
 *   node_modules/**         真实包树
 *   .pool-manifest.json     列出待回填的文本文件（只有包装器）
 *
 * 包装器为什么用占位符而不是相对路径：`bin/` 里的文件会被 `collectBins`
 * 软链进 `<engine>/bin`，`$0` 已经指不回扩展目录了；而引擎根在安装时才确定。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { tarGzSync } from '../../plugins/kxxy-host/lib/tar.mjs'

/** 池条目的 `source` 值；deb 池没有这个字段。 */
export const NPM_SOURCE = 'npm'

/**
 * 包装器里的引擎根占位符。
 *
 * 与 `tools/lib/poolextract.py` 的 `PLACEHOLDER_REWRITES`、
 * `plugins/kxxy-host/lib/extinstall.mjs` 的 `placeholderMap` 必须逐字一致 ——
 * 三处对不上就是「装完命令指向字面量 `@DSH_ROOT@`」。
 */
const ROOT_PH = '@DSH_ROOT@'

/** npm 自己在 `node_modules/.bin` 里建的软链，设备端用不到（我们另生成包装器）。 */
const PRUNE_NAMES = new Set(['.bin', '.package-lock.json', '.modules.yaml'])

/** 与池内体积统计口径一致：source map 只服务调试，占体积极大。 */
const PRUNE_SUFFIXES = ['.map']

function log(msg) {
  console.log(`      ${msg}`)
}

function human(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * 找到 npm 的 CLI 入口。
 *
 * 优先用「当前 node 自带的 npm」：构建脚本可能被 `KXXY_NODE` 指到某个便携
 * node，`PATH` 上的 `npm` 未必是同一个版本，而 `--os/--cpu` 需要 npm ≥ 10。
 */
function npmCli() {
  const beside = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(beside)) return { node: process.execPath, args: [beside], version: npmVersion(beside) }
  return { node: process.execPath, args: [], version: null }
}

function npmVersion(cli) {
  try {
    const r = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

/**
 * 把一次 `npm install` 跑到 staging 里。
 *
 * `--ignore-scripts` 是必须的：esbuild/rollup 的 postinstall 会去校验甚至下载
 * **宿主平台**的二进制，在交叉安装场景下只会失败或写错文件；真正要的二进制由
 * `optionalDependencies` 里的平台包提供，不需要脚本。
 */
function installInto(stage, deps, { registry } = {}) {  const pkgJson = {
    name: 'kxxy-node-tools',
    private: true,
    version: '0.0.0',
    dependencies: deps,
  }
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkgJson, null, 2)}\n`)

  const cli = npmCli()
  const args = [
    ...cli.args,
    'install',
    '--os=android',
    '--cpu=arm64',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--install-strategy=hoisted',
    '--loglevel=error',
  ]
  if (registry) args.push(`--registry=${registry}`)

  const r = spawnSync(cli.node, args, { cwd: stage, stdio: 'inherit' })
  if (r.error) throw new Error(`无法启动 npm（${cli.node}）：${r.error.message}`)
  if (r.status !== 0) throw new Error(`npm install 退出码 ${r.status}（deps=${JSON.stringify(deps)}）`)
}

/** 读某个已安装包的 package.json；不在就返回 null。 */
function readInstalled(stage, name) {
  const p = join(stage, 'node_modules', ...name.split('/'), 'package.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 依赖集合的指纹（**只**由 `name@精确版本` 决定）。
 *
 * 用途是给 staging 目录起名：同一批依赖永远命中同一个目录，就不再需要
 * 「先 `rm -rf` 再装」这种写法。这一点在本机是硬约束 —— 逐个顶层包算下来
 * 1500+ 个文件，递归删除会被判成批量删除而直接拒绝（审计钩子），
 * 于是「重建一次产物」等于「先手工清缓存」，很不合理。
 *
 * 内容寻址还有个副作用是好事：依赖没变时直接复用上一轮的 `node_modules`，
 * 冷装 7 分钟不必每次都付。
 */
function depsKey(deps) {
  const rows = Object.entries(deps)
    .map(([name, range]) => `${name}@${range}`)
    .sort()
  return createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 10)
}

/**
 * 判断这个 staging 目录是否已经是「这批依赖装好了」的状态。
 *
 * 判据是每个顶层包都在、且版本与依赖声明**逐字相等**。依赖是范围（`^5`）时
 * 永远判不相等 —— 那正是要重装的情形（要么解析出新的精确版本写锁文件，
 * 要么锁文件缺失），所以这里不去猜范围语义。
 */
function stageReady(stage, deps) {
  if (!existsSync(join(stage, 'node_modules'))) return false
  for (const [name, want] of Object.entries(deps)) {
    const pkg = readInstalled(stage, name)
    if (!pkg || pkg.version !== want) return false
  }
  return true
}

/**
 * 校验「声明为 android 平台」的包真的落地了。
 *
 * 这一步是整条链路唯一能提前发现「npm 按宿主平台装错」的地方：装错时命令还在，
 * 只有在设备上第一次执行才会炸，排查成本极高。
 */
function assertPlatformPackages(stage, required) {
  for (const name of required ?? []) {
    const pkg = readInstalled(stage, name)
    if (!pkg) throw new Error(`缺少 Android 平台包 ${name}（npm 未按 --os=android 解析？）`)
    const os = Array.isArray(pkg.os) ? pkg.os : []
    const cpu = Array.isArray(pkg.cpu) ? pkg.cpu : []
    if (os.length && !os.includes('android')) {
      throw new Error(`${name} 的 os 是 ${JSON.stringify(os)}，不是 android`)
    }
    if (cpu.length && !cpu.includes('arm64')) {
      throw new Error(`${name} 的 cpu 是 ${JSON.stringify(cpu)}，不是 arm64`)
    }
  }
}

/** 收集一个包的 `bin` 字段 → `[{ command, rel }]`（rel 相对该包根）。 */
function binEntries(pkgName, pkg) {
  const bin = pkg?.bin
  if (!bin) return []
  if (typeof bin === 'string') {
    const cmd = pkgName.includes('/') ? pkgName.split('/').pop() : pkgName
    return [{ command: cmd, rel: bin }]
  }
  return Object.entries(bin).map(([command, rel]) => ({ command, rel: String(rel) }))
}

/**
 * 判断包装器该不该用引擎的 node 起。
 *
 * Android 上没有 `/usr/bin/env`，所以 `#!/usr/bin/env node` 直接执行必失败；
 * 反过来，esbuild 那种真正的 ELF 不能拿 node 喂。判据只看 shebang 里有没有
 * `node` 这个词 —— 比按包名硬编码稳。
 */
function needsNode(absTarget) {
  try {
    const buf = readFileSync(absTarget)
    if (buf.length < 3 || buf[0] !== 0x23 || buf[1] !== 0x21) return false
    const head = buf.subarray(0, Math.min(buf.length, 200)).toString('utf8').split('\n')[0]
    return /\bnode\b/.test(head)
  } catch {
    return false
  }
}

function shQuote(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`
}

/** 生成一个包装器脚本（内容不含真实路径，装完由 extinstall 回填）。 */
function wrapperScript(command, targetRel, useNode, { note } = {}) {
  const target = `${ROOT_PH}/extensions/__EXT_ID__/${targetRel}`
  const lines = [
    '#!/system/bin/sh',
    `# [kxxy] ${command} —— node-tools 扩展生成的入口，不要手改（重装扩展会覆盖）。`,
  ]
  if (note) lines.push(`# ${note}`)
  lines.push('set -u')
  if (useNode) {
    lines.push(`exec ${shQuote(`${ROOT_PH}/bin/node`)} ${shQuote(target)} "$@"`)
  } else {
    lines.push(`exec ${shQuote(target)} "$@"`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * 判断文件在设备上该是 0755 还是 0644。
 *
 * **不能信 `statSync().mode`**：构建机是 Windows，除 `.exe` 外一律没有执行位，
 * 于是 `@esbuild/android-arm64/bin/esbuild` 会以 0644 进池 —— 设备上
 * `spawnSync ... EACCES`，而 `esbuild --version` 报的是一大段 `child_process`
 * 堆栈，看着像 node 的 bug，其实是权限位。所以按**内容**判：
 *   · `\x7fELF` —— 原生可执行（esbuild 的 Go 二进制就是这种，名字不带后缀）；
 *   · `#!` —— 脚本，设备端由 `#!/system/bin/sh` 或引擎 node 起。
 * `.node` 是 dlopen 的，不需要执行位，故意不在此列。
 */
function execModeByContent(abs, detected) {
  if (detected & 0o111) return 0o755
  let fd = null
  try {
    fd = openSync(abs, 'r')
    const buf = Buffer.alloc(4)
    const n = readSync(fd, buf, 0, 4, 0)
    if (n >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return 0o755
    if (n >= 2 && buf[0] === 0x23 && buf[1] === 0x21) return 0o755
  } catch {
    // 读不到就按普通文件处理：宁可少一个执行位，也不要让打包整体失败
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
  return 0o644
}

/** 只沿真实目录走，遇到软链一律跳过（npm 的软链只出现在 .bin）。 */
function walkFiles(dir, relBase, out) {
  for (const name of readdirSync(dir)) {
    if (PRUNE_NAMES.has(name)) continue
    const abs = join(dir, name)
    const rel = relBase ? `${relBase}/${name}` : name
    let st
    try {
      st = statSync(abs, { throwIfNoEntry: false })
    } catch {
      continue
    }
    if (!st) continue
    if (st.isDirectory()) {
      walkFiles(abs, rel, out)
      continue
    }
    if (!st.isFile()) continue
    if (PRUNE_SUFFIXES.some((s) => name.endsWith(s))) continue
    out.push({ abs, rel, mode: execModeByContent(abs, st.mode), size: st.size })
  }
}

/**
 * 构建一个 npm 源池条目。
 *
 * @param {object} item `POOL_ITEMS` 里的条目（`source: 'npm'`）
 * @param {{outDir: string, stageDir: string, lockPath?: string, lockedPackages?: Record<string,string>, registry?: string}} opts
 * @returns {Promise<{id: string, version: string, files: number, totalBytes: number, platformPackages: string[]}>}
 */
export async function buildNpmPack(item, opts) {
  const { outDir, stageDir } = opts

  // 锁文件优先：`npmPackages` 写的是范围（`^5` 这种），锁文件记的是上次实际
  // 装到的精确版本。有锁就按精确版本装，产物才可复现。
  const deps = { ...(item.npmPackages ?? {}), ...(opts.lockedPackages ?? {}) }
  const names = Object.keys(deps)
  if (!names.length) throw new Error(`${item.id}: npmPackages 为空`)

  // staging 目录按依赖指纹寻址，不删旧目录（见 depsKey 注释里的原因）。
  const stage = join(stageDir, `${item.id}-${depsKey(deps)}`)
  mkdirSync(stage, { recursive: true })

  if (stageReady(stage, deps)) {
    log(`${item.id}: 复用已装好的 staging（${stage.split(/[\\/]/).pop()}）`)
  } else {
    log(`${item.id}: npm install（目标 os=android cpu=arm64）…`)
    installInto(stage, deps, { registry: opts.registry })
  }

  // 解析出来的真实版本写进锁文件，之后构建按精确版本重装 —— 与
  // `SEED_VERSION_PINS` 同一套「索引会漂，产物不能漂」的立场。
  const resolved = {}
  for (const name of names) {
    const pkg = readInstalled(stage, name)
    if (!pkg) throw new Error(`${item.id}: ${name} 没装上`)
    resolved[name] = pkg.version
  }
  if (opts.lockPath) {
    try {
      writeFileSync(opts.lockPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), packages: resolved }, null, 2)}\n`)
    } catch (err) {
      log(`${item.id}: 锁文件写入失败（${err.message}），本次不阻断`)
    }
  }

  assertPlatformPackages(stage, item.requiredPlatformPackages)

  // ── 包装器 ──────────────────────────────────────────────────────────
  const binDir = join(stage, 'bin')
  mkdirSync(binDir, { recursive: true })
  const wrappers = []
  for (const name of names) {
    const pkg = readInstalled(stage, name)
    for (const { command, rel } of binEntries(name, pkg)) {
      const targetRel = `node_modules/${name}/${rel}`.replace(/\/\.\//g, '/')
      const abs = join(stage, targetRel)
      if (!existsSync(abs)) {
        log(`${item.id}: ⚠️ ${name} 声明的 bin ${rel} 不存在，跳过 ${command}`)
        continue
      }
      const useNode = needsNode(abs)
      const body = wrapperScript(command, targetRel, useNode, {
        note: useNode ? '上游 #! 指向 /usr/bin/env，Android 上不存在，改由引擎 node 执行' : '原生可执行，直接 exec',
      })
      writeFileSync(join(binDir, command), body, { mode: 0o755 })
      wrappers.push({ command, targetRel, useNode })
    }
  }
  if (!wrappers.length) throw new Error(`${item.id}: 一个 bin 都没解析出来`)

  // ── 校验声明的命令都真的产出了 ──────────────────────────────────────
  const produced = new Set(wrappers.map((w) => w.command))
  const missingBins = (item.bins ?? []).filter((b) => !produced.has(b))
  if (missingBins.length) {
    throw new Error(`${item.id}: 缺命令 ${missingBins.join(', ')}（实际产出 ${[...produced].join(', ')}）`)
  }

  // ── 清单 ────────────────────────────────────────────────────────────
  const wrapperRels = wrappers.map((w) => `bin/${w.command}`)
  const manifest = {
    extId: item.id,
    placeholders: {
      '@DSH_ROOT@': 'root',
      '@DSH_HOME@': 'home',
      '@DSH_TMP@': 'tmp',
      '@DSH_FILES@': 'files',
      '@DSH_DATA@': 'data',
    },
    files: wrapperRels,
  }

  // ── 打包 ────────────────────────────────────────────────────────────
  const entries = []
  const nm = join(stage, 'node_modules')
  walkFiles(nm, 'node_modules', entries)
  for (const rel of wrapperRels) {
    const abs = join(stage, rel)
    entries.push({ abs, rel, mode: 0o755, size: statSync(abs).size })
  }

  // 包装器里的 `__EXT_ID__` 在打包时替换成真实 id：安装路径是
  // `extensions/<id>`，而 id 只有构建期知道。
  const files = entries.map((e) => {
    const data = readFileSync(e.abs)
    if (!wrapperRels.includes(e.rel)) return { name: e.rel, data, mode: e.mode, mtimeSec: 0 }
    const text = data.toString('utf8').split('__EXT_ID__').join(item.id)
    return { name: e.rel, data: Buffer.from(text, 'utf8'), mode: 0o755, mtimeSec: 0 }
  })
  files.push({
    name: '.pool-manifest.json',
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    mode: 0o644,
    mtimeSec: 0,
  })

  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${item.id}.pool`)
  const gz = tarGzSync(files)
  writeFileSync(outPath, gz)

  const totalBytes = files.reduce((n, f) => n + f.data.length, 0)
  const platformPackages = []
  for (const name of readdirSync(nm)) {
    const full = name.startsWith('@') ? null : name
    if (full) {
      const pkg = readInstalled(stage, name)
      if (Array.isArray(pkg?.os) && pkg.os.includes('android')) platformPackages.push(name)
      continue
    }
    for (const sub of readdirSync(join(nm, name))) {
      const pkg = readInstalled(stage, `${name}/${sub}`)
      if (Array.isArray(pkg?.os) && pkg.os.includes('android')) platformPackages.push(`${name}/${sub}`)
    }
  }

  log(
    `${item.id}: ${wrappers.length} 个命令 · ${files.length} 文件 · ${human(totalBytes)} ` +
      `→ ${outPath.split(/[\\/]/).pop()}（android 构件：${platformPackages.join(', ') || '无'}）`,
  )

  return {
    id: item.id,
    version: Object.values(resolved).join('+'),
    files: files.length,
    totalBytes,
    platformPackages,
    resolved,
  }
}
