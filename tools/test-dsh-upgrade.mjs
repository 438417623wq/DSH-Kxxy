// 直接编译真实 DSH helper；不调用 Gradle、不下载依赖、不读写发布资产。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'android/app/src/main/java/app/kxxy/engine/DshRuntimeUpgrade.kt');
const fixture = path.join(root, 'tools/fixtures/DshRuntimeUpgradeTest.kt');
const cache = process.env.KOTLIN_CACHE || path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1');
const java = process.env.KXXY_JAVA || (process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : 'E:/deepseek-harness/XJZB/_toolchain/jdk-17.0.20.1+1/bin/java.exe');
const jar = (folder, version) => {
  const base = path.join(cache, folder, version);
  const candidates = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(entry => fs.readdirSync(path.join(base, entry.name)).filter(name => name.endsWith('.jar'))
      .map(name => path.join(base, entry.name, name))).sort();
  assert.ok(candidates.length, `缺少已缓存的 Kotlin 依赖：${base}`);
  return candidates[0];
};
const std = jar('org.jetbrains.kotlin/kotlin-stdlib', '1.9.24');
const annotations = jar('org.jetbrains/annotations', '13.0');
const compiler = [jar('org.jetbrains.kotlin/kotlin-compiler-embeddable', '1.9.24'), std,
  jar('org.jetbrains.kotlin/kotlin-reflect', '1.9.24'), jar('org.jetbrains.kotlin/kotlin-script-runtime', '1.9.24'),
  jar('org.jetbrains.intellij.deps/trove4j', '1.0.20200330'), annotations].join(path.delimiter);
const cp = [std, annotations].join(path.delimiter);
const sourceHash = () => createHash('sha256').update(fs.readFileSync(source)).digest('hex');
const before = sourceHash();

assert.ok(fs.statSync(root).isDirectory());
const scratchParent = path.join(root, '.cache');
if (!fs.existsSync(scratchParent)) fs.mkdirSync(scratchParent);
assert.ok(fs.lstatSync(scratchParent).isDirectory() && !fs.lstatSync(scratchParent).isSymbolicLink(), '.cache 必须是普通目录');
const temp = fs.mkdtempSync(path.join(scratchParent, 'test-dsh-upgrade-'));
const identity = fs.lstatSync(temp);
const out = path.join(temp, 'classes');
const helperSource = fs.readFileSync(source, 'utf8');
const installer = fs.readFileSync(path.join(path.dirname(source), 'RuntimeInstaller.kt'), 'utf8');
assert.ok(!/Files\.getFileStore\s*\(/.test(helperSource), 'Android helper must not depend on FileStore');
assert.match(helperSource, /\.usableSpace/, 'Use File.usableSpace on Android');
assert.ok(!/deleteRecursively|deleteTreeSafely/.test(helperSource), 'No recursive runtime deletion in incremental upgrade');
assert.match(installer, /pythonRuntimeRepair\.preflight\(root\)[\s\S]*?dshRuntimeUpgrade\.upgrade\(root\)[\s\S]*?pythonRuntimeRepair\.repair\(root\)/);
assert.match(installer, /check\(dshRuntimeUpgrade\.isCurrent\(root\)\)/);
assert.ok(installer.indexOf('增量升级后的其它运行时锚点尚未就绪') < installer.indexOf('deleteTreeSafely(target)'), 'Existing installations must refuse before full-tree replacement');

const fixtureHash = () => createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
const fixtureBefore = fixtureHash();
const timeoutMs = 600000;
const shardCount = 4;
const started = performance.now();

function run(label, args, deadline = performance.now() + timeoutMs) {
  return new Promise(resolve => {
    const start = performance.now();
    const remaining = Math.max(1, Math.floor(deadline - start));
    const child = spawn(java, ['-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8', ...args], {
      cwd: temp, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let outputBytes = 0;
    let error;
    const timer = setTimeout(() => {
      error = new Error(`${label}耗尽共享时间预算（${timeoutMs} ms），不能视为通过`);
      child.kill();
    }, remaining);
    console.log(`PROCESS START ${label}; PID ${child.pid}; BUDGET_MS ${remaining}`);
    for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      input.setEncoding('utf8');
      input.on('data', chunk => {
        output.write(chunk);
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes <= 16 * 1024 * 1024) {
          if (input === child.stdout) stdout += chunk;
        } else if (!error) {
          error = new Error(`${label}输出超出 16 MiB 上限`);
          child.kill();
        }
      });
    }
    child.on('error', cause => { error = cause; });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      const elapsedMs = Math.round(performance.now() - start);
      console.log(`PROCESS END ${label}; EXIT ${status}; SIGNAL ${signal}; ELAPSED_MS ${elapsedMs}`);
      resolve({ label, stdout, status, signal, error, elapsedMs });
    });
  });
}
function checkExit(result) {
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.label}失败，JVM 退出码 ${result.status}，信号 ${result.signal}`);
}

try {
  console.log(`真实 helper：${source}\nSHA-256：${before}\n夹具 SHA-256：${fixtureBefore}`);
  console.log(`Node：${process.version}\nJDK：${java}\n测试私有目录：${temp}`);
  console.log('使用现有 Kotlin 1.9.24 缓存编译真实源码与 JVM 夹具。');
  const compilation = await run('Kotlin 编译', ['-Xmx384m', '-cp', compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
    '-no-stdlib', '-no-reflect', '-jvm-target', '1.8', '-classpath', cp, '-d', out, source, fixture]);
  checkExit(compilation);
  assert.equal(sourceHash(), before, '编译期间 helper 被其他进程修改，请对最新源码重新测试');
  assert.equal(fixtureHash(), fixtureBefore, '编译期间夹具被其他进程修改，请重新测试');
  console.log(`测试分组：${shardCount} 个独立 JVM，按用例编号均衡分配，共享 ${timeoutMs} ms 总预算（不累加分组 timeout）。`);
  const testStarted = performance.now();
  const deadline = testStarted + timeoutMs;
  // 等所有子进程真正退出后再检查结果；单组失败不截断其它组的证据。
  const results = await Promise.all(Array.from({ length: shardCount }, (_, index) => run(`DSH 分组 ${index + 1}/${shardCount}`,
    ['-Xmx192m', '-cp', [out, cp].join(path.delimiter), 'app.kxxy.engine.DshRuntimeUpgradeTestKt', temp, String(index + 1), String(shardCount)], deadline)));
  const testMs = Math.round(performance.now() - testStarted);
  assert.equal(sourceHash(), before, '测试期间 helper 被其他进程修改，请对最新源码重新测试');
  assert.equal(fixtureHash(), fixtureBefore, '测试期间夹具被其他进程修改，请重新测试');
  const summaries = results.map((result, index) => {
    const matches = [...result.stdout.matchAll(/^RESULT (\{[^\r\n]+\})$/gm)];
    assert.equal(matches.length, 1, `${result.label}缺少唯一最终结果，不能视为通过：${result.error || `退出码 ${result.status}`}`);
    const summary = JSON.parse(matches[0][1]);
    assert.equal(summary.shard, index + 1);
    assert.equal(summary.shards, shardCount);
    for (const field of ['registered', 'passed', 'failed', 'skipped']) assert.ok(Number.isSafeInteger(summary[field]) && summary[field] >= 0, `非法统计字段 ${field}`);
    assert.ok(summary.registered > 0, '分组未注册任何测试');
    const outcomes = [...result.stdout.matchAll(/^(PASS|FAIL|SKIP) \[shard=(\d+)\/(\d+) case=(\d+) elapsedMs=\d+ cpuMs=-?\d+\] /gm)];
    assert.ok(outcomes.every(match => Number(match[2]) === summary.shard && Number(match[3]) === shardCount), '用例归属分组错误');
    const expected = Array.from({ length: summary.registered }, (_, id) => id + 1).filter(id => (id - 1) % shardCount === index);
    assert.deepEqual(outcomes.map(match => Number(match[4])), expected, `${result.label}有遗漏、重复或乱序用例`);
    for (const [status, field] of [['PASS', 'passed'], ['FAIL', 'failed'], ['SKIP', 'skipped']]) {
      assert.equal(outcomes.filter(match => match[1] === status).length, summary[field], `${result.label}的 ${status} 计数不符`);
    }
    return summary;
  });
  assert.ok(summaries.every(summary => summary.registered === summaries[0].registered && summary.inventorySha256 === summaries[0].inventorySha256), '分组注册的测试清单不一致');
  const total = summaries.reduce((sum, item) => ({ passed: sum.passed + item.passed, failed: sum.failed + item.failed, skipped: sum.skipped + item.skipped }), { passed: 0, failed: 0, skipped: 0 });
  assert.equal(total.passed + total.failed + total.skipped, summaries[0].registered, '全量测试覆盖数不符');
  console.log(`ALL TOTAL PASS ${total.passed}; FAIL ${total.failed}; SKIP ${total.skipped}; REGISTERED ${summaries[0].registered}; SHARDS ${shardCount}; TEST_MS ${testMs}; COMPILE_MS ${compilation.elapsedMs}`);
  console.log(`用例清单 SHA-256：${summaries[0].inventorySha256}`);
  results.forEach(checkExit);
  assert.equal(total.failed, 0, '真实 helper 回归存在失败');
} finally {
  // 保留夹具与编译产物以便复查；不触发批量删除，也不掩盖原始测试错误。
  const now = fs.lstatSync(temp);
  assert.ok(now.isDirectory() && !now.isSymbolicLink() && now.dev === identity.dev && now.ino === identity.ino,
    `测试目录身份变化：${temp}`);
  console.log(`测试产物保留在：${temp}\n总用时：${Math.round(performance.now() - started)} ms`);
}
