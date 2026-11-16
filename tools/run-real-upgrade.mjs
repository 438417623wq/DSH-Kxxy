// 用真实资产与真实旧运行时根目录跑一次离线升级；只读生产源码，不做任何设备写入。
// 用途：复现「设备升级卡在解压 0%」，取得真实 Refused 文本与各阶段耗时。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const engine = path.join(root, 'android/app/src/main/java/app/kxxy/engine')
const cache = process.env.KOTLIN_CACHE || path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1')
const java = process.env.KXXY_JAVA || 'E:/deepseek-harness/XJZB/_toolchain/jdk-17.0.20.1+1/bin/java.exe'
const jar = (folder, version) => {
  const base = path.join(cache, folder, version)
  const found = fs.readdirSync(base)
    .flatMap(hash => fs.readdirSync(path.join(base, hash)).filter(n => n.endsWith('.jar')).map(n => path.join(base, hash, n)))[0]
  if (!found) throw new Error(`Missing cached Kotlin dependency ${base}`)
  return found
}
const std = jar('org.jetbrains.kotlin/kotlin-stdlib', '1.9.24')
const annotations = jar('org.jetbrains/annotations', '13.0')
const compiler = [
  jar('org.jetbrains.kotlin/kotlin-compiler-embeddable', '1.9.24'), std,
  jar('org.jetbrains.kotlin/kotlin-reflect', '1.9.24'), jar('org.jetbrains.kotlin/kotlin-script-runtime', '1.9.24'),
  jar('org.jetbrains.intellij.deps/trove4j', '1.0.20200330'), annotations,
].join(path.delimiter)
const cp = [std, annotations].join(path.delimiter)

const runtimeRoot = process.argv[2]
const assets = process.argv[3] ?? path.join(root, 'android/app/src/main/assets')
const host = process.argv[4] ?? '533b8d844071cd729c8a393f49ddc54be1e8f70237b7cd6ea6df59f7dd54a9b7'
if (!runtimeRoot) throw new Error('usage: node tools/run-real-upgrade.mjs <runtime-root> [assets-dir] [expected-host]')

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kxxy-real-upgrade-'))
const source = path.join(engine, 'DshRuntimeUpgrade.kt')
const python = path.join(engine, 'PythonRuntimeRepair.kt')
const harness = path.join(root, 'tools/fixtures/RealUpgradeHarness.kt')
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const before = { dsh: sha(source), py: sha(python) }

console.log(`runtime root: ${runtimeRoot}`)
console.log(`assets: ${assets}`)
console.log(`expected host: ${host}`)
console.log(`source sha256: dsh=${before.dsh} python=${before.py}`)

const compile = spawnSync(java, ['-Xmx512m', '-cp', compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
  '-no-stdlib', '-no-reflect', '-jvm-target', '1.8', '-classpath', cp, '-d', out, source, python, harness],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
if (compile.status !== 0) {
  console.error(compile.stdout?.slice(-4000))
  console.error(compile.stderr?.slice(-4000))
  throw new Error(`Kotlin 编译失败，退出码 ${compile.status}`)
}
if (sha(source) !== before.dsh || sha(python) !== before.py) throw new Error('编译期间生产源码被修改')

const started = Date.now()
// inherit：让夹具的打印实时进日志，长任务期间可以看进度而不是空等。
const run = spawnSync(java, ['-Xmx768m', '-cp', [out, cp].join(path.delimiter), 'app.kxxy.engine.RealUpgradeHarnessKt',
  runtimeRoot, assets, host], { stdio: 'inherit', timeout: 3 * 60 * 60 * 1000 })
console.log(`harness exit=${run.status} wall=${Math.round((Date.now() - started) / 1000)}s`)
console.log(`work dir: ${out}`)
