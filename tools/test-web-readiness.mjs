import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 「引擎网页是否可用」三条判据的回归。
// 0.9.48 真机白屏就是判据错：404 被当成就绪 → 没有 token → 加载裸 / → 空 body 白页。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'android/app/src/main/java/app/kxxy/engine/WebReadiness.kt');
const fixture = path.join(root, 'tools/fixtures/WebReadinessTest.kt');
const cache = process.env.KOTLIN_CACHE || path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1');
const java = process.env.KXXY_JAVA || (process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : 'E:/deepseek-harness/XJZB/_toolchain/jdk-17.0.20.1+1/bin/java.exe');

const jar = (folder, version) => {
  const base = path.join(cache, folder, version);
  const candidates = fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(base, entry.name))
      .filter((name) => name.endsWith('.jar'))
      .map((name) => path.join(base, entry.name, name)))
    .sort();
  assert.ok(candidates.length, `缺少已缓存的 Kotlin 依赖：${base}`);
  return candidates[0];
};

const std = jar('org.jetbrains.kotlin/kotlin-stdlib', '1.9.24');
const annotations = jar('org.jetbrains/annotations', '13.0');
const compiler = [
  jar('org.jetbrains.kotlin/kotlin-compiler-embeddable', '1.9.24'),
  std,
  jar('org.jetbrains.kotlin/kotlin-reflect', '1.9.24'),
  jar('org.jetbrains.kotlin/kotlin-script-runtime', '1.9.24'),
  jar('org.jetbrains.intellij.deps/trove4j', '1.0.20200330'),
  annotations,
].join(path.delimiter);
const cp = [std, annotations].join(path.delimiter);

const scratch = path.join(root, '.cache');
fs.mkdirSync(scratch, { recursive: true });
const temp = fs.mkdtempSync(path.join(scratch, 'test-web-readiness-'));
const out = path.join(temp, 'classes');

const compile = spawnSync(java, [
  '-Xmx384m', '-cp', compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
  '-no-stdlib', '-no-reflect', '-jvm-target', '1.8', '-classpath', cp, '-d', out, source, fixture,
], { encoding: 'utf8' });
if (compile.status !== 0) {
  console.error(compile.stdout || '');
  console.error(compile.stderr || '');
  assert.fail('WebReadiness 夹具编译失败');
}

const run = spawnSync(java, [
  '-Dfile.encoding=UTF-8',
  '-cp', [out, cp].join(path.delimiter),
  'WebReadinessTestKt',
], { encoding: 'utf8' });

process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
assert.equal(run.status, 0, 'WebReadiness 判据回归失败');
const passed = (run.stdout.match(/^PASS /gm) || []).length;
assert.ok(passed >= 15, `用例数异常：${passed}`);
console.log(`RESULT {"passed":${passed},"failed":0}`);
