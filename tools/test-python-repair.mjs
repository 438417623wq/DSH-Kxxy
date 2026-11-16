// Compile the real JVM-only Python repair helper using the existing JDK/Kotlin cache. No Gradle, APK or device writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ZipWriter } from './lib/zipwrite.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(root, 'android/app/src/main/java/app/kxxy/engine');
const cache = process.env.KOTLIN_CACHE || path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1');
const java = process.env.KXXY_JAVA || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'E:/deepseek-harness/XJZB/_toolchain/jdk-17.0.20.1+1/bin/java.exe');
const jar = (folder, version) => {
  const base = path.join(cache, folder, version);
  const result = fs.readdirSync(base).flatMap(hash => fs.readdirSync(path.join(base, hash)).filter(name => name.endsWith('.jar')).map(name => path.join(base, hash, name)))[0];
  assert.ok(result, `Missing cached Kotlin dependency ${base}`);
  return result;
};
const std = jar('org.jetbrains.kotlin/kotlin-stdlib', '1.9.24');
const annotations = jar('org.jetbrains/annotations', '13.0');
const compiler = [jar('org.jetbrains.kotlin/kotlin-compiler-embeddable', '1.9.24'), std,
  jar('org.jetbrains.kotlin/kotlin-reflect', '1.9.24'), jar('org.jetbrains.kotlin/kotlin-script-runtime', '1.9.24'),
  jar('org.jetbrains.intellij.deps/trove4j', '1.0.20200330'), annotations].join(path.delimiter);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kxxy-python-repair-test-'));
const fixtures = path.join(temp, 'assets');
fs.mkdirSync(fixtures);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const baseHost = 'a'.repeat(64), host = 'b'.repeat(64);
const revision = 'python-cffi-2.0.0-cp314-android24-arm64-v1';
const site = 'lib/python3.14/site-packages/';
const hostBase = 'lib/node_modules/kxxy-host/lib/';
const backend = `${site}_cffi_backend.cpython-314-aarch64-linux-android.so`;
const records = [
  { path: `${site}cffi/__init__.py`, text: '__version__ = "2.0.0"\n', role: 'python', mode: 420 },
  { path: `${site}cffi/api.py`, text: '# official cffi api fixture\n'.repeat(40), role: 'python', mode: 420 },
  { path: `${site}cffi-2.0.0.dist-info/METADATA`, text: 'Name: cffi\nVersion: 2.0.0\n', role: 'python', mode: 420 },
  { path: backend, text: '\x7fELF\x00android24-arm64-cp314-native-fixture\x01\xff', role: 'python', mode: 493 },
  { path: `${site}pycparser/__init__.py`, text: '__version__ = "2.23"\n', role: 'python', mode: 420 },
  { path: `${site}pycparser-2.23.dist-info/METADATA`, text: 'Name: pycparser\nVersion: 2.23\n', role: 'python', mode: 420 },
  { path: 'share/kxxy/python-runtime.json', text: JSON.stringify({ schema: 1, revision }), role: 'python', mode: 420 },
  { path: `${hostBase}selftest.mjs`, text: '// selftest with Python dependency diagnostics\n', old: '// old selftest\n', role: 'host', mode: 420 },
  { path: `${hostBase}python-selftest.mjs`, text: '// new Python dependency selftest\n', role: 'host', mode: 420 },
  { path: `${hostBase}python-probe.py`, text: 'import cffi, pycparser, _cffi_backend\n', role: 'host', mode: 420 },
  { path: `${hostBase}index.js`, text: '// new host entry\n', old: '// old host entry\n', role: 'host', mode: 420 },
  { path: 'lib/node_modules/kxxy-host/web/index.html', text: '一键验收（含 Python）', old: '一键验收（七项）', role: 'host', mode: 420 },
  { path: 'lib/node_modules/kxxy-host/web/host.js', text: '正在验收（包含 Python，通常约 20 秒）...', old: '正在验收（最多10s）', role: 'host', mode: 420 },
  { path: 'kxxy-runtime.json', text: JSON.stringify({ plugins: { hostFingerprint: host }, pythonRevision: revision }), old: JSON.stringify({ plugins: { hostFingerprint: baseHost } }), role: 'host', mode: 420 },
  { path: `${hostBase}.fingerprint`, text: `kxxy-host-fingerprint@1\nfingerprint: ${host}\n`, old: `kxxy-host-fingerprint@1\nfingerprint: ${baseHost}\n`, role: 'host', mode: 420 },
].map(record => ({ ...record, bytes: Buffer.from(record.text) }));
const write = (target, bytes) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
for (const record of records) {
  write(path.join(temp, 'expected', record.path), record.bytes);
  if (record.old !== undefined) write(path.join(temp, 'baseline', record.path), record.old);
}
write(path.join(temp, 'managed-paths.txt'), records.map(record => record.path).join('\n'));

async function fixture(name, { alterRecords, alterZip, alterManifest, rawManifest, alterMeta, omitMeta = false, beforeSeal } = {}) {
  const directory = path.join(fixtures, name);
  fs.mkdirSync(directory);
  const entries = structuredClone(records);
  alterRecords?.(entries);
  const chunks = [], zip = new ZipWriter(bytes => chunks.push(bytes));
  for (const record of entries) await zip.add(record.path, Buffer.from(record.bytes), { mode: record.mode, comment: record.comment || '' });
  zip.finish();
  let payload = Buffer.concat(chunks);
  if (alterZip) payload = alterZip(payload) || payload;
  const files = records.map(record => ({ path: record.path, size: record.bytes.length, sha256: sha(record.bytes), mode: record.mode, role: record.role,
    ...(record.old !== undefined ? { previousSha256: sha(Buffer.from(record.old)) } : {}) }));
  const manifest = { schema: 1, revision, python: { majorMinor: '3.14', soabi: 'cpython-314-aarch64-linux-android', minApi: 24 },
    payloadSha256: sha(payload), payloadSize: payload.length, baseHostFingerprint: baseHost, hostFingerprint: host, files };
  alterManifest?.(manifest);
  let raw = Buffer.from(rawManifest ? rawManifest(manifest) : JSON.stringify(manifest, null, 2));
  const meta = { pythonRepairManifestSha256: sha(raw), pythonRuntimeRevision: revision, kxxyHostFingerprint: host };
  alterMeta?.(meta);
  if (beforeSeal) ({ raw, payload } = beforeSeal({ raw, payload }));
  write(path.join(directory, 'python-repair/manifest.json'), raw);
  write(path.join(directory, 'python-repair/payload.zip'), payload);
  if (!omitMeta) write(path.join(directory, 'meta/build.json'), JSON.stringify(meta));
}
const centralPositions = bytes => {
  const end = bytes.length - 22;
  let at = bytes.readUInt32LE(end + 16);
  const positions = [];
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) { positions.push(at); at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32); }
  return positions;
};
await fixture('valid');
await fixture('same-host', { alterManifest: manifest => { manifest.baseHostFingerprint = host; for (const record of manifest.files) delete record.previousSha256; } });
await fixture('missing-meta', { omitMeta: true });
await fixture('legacy', { alterMeta: meta => { delete meta.pythonRepairManifestSha256; delete meta.pythonRuntimeRevision; } });
await fixture('manifest-hash', { beforeSeal: ({ raw, payload }) => ({ raw: Buffer.concat([raw, Buffer.from('\n')]), payload }) });
await fixture('payload-hash', { beforeSeal: ({ raw, payload }) => { payload[payload.length - 1] ^= 1; return { raw, payload }; } });
await fixture('payload-short', { beforeSeal: ({ raw, payload }) => ({ raw, payload: payload.subarray(0, -1) }) });
await fixture('payload-long', { beforeSeal: ({ raw, payload }) => ({ raw, payload: Buffer.concat([payload, Buffer.from([0])]) }) });
await fixture('entry-digest', { alterManifest: manifest => { manifest.files[1].sha256 = 'c'.repeat(64); } });
await fixture('entry-size', { alterManifest: manifest => { manifest.files[1].size++; } });
await fixture('extra-entry', { alterRecords: entries => { entries.push({ ...entries[0], path: `${site}cffi/unlisted.py` }); } });
await fixture('missing-entry', { alterRecords: entries => { entries.pop(); } });
await fixture('duplicate-entry', { alterRecords: entries => { entries[1] = entries[0]; } });
await fixture('link-comment', { alterRecords: entries => { entries[0].comment = 'LINK:../../precious'; } });
await fixture('symlink-entry', { alterZip: bytes => { bytes.writeUInt32LE((0o120777 * 65536) >>> 0, centralPositions(bytes)[0] + 38); } });
await fixture('fifo-entry', { alterZip: bytes => { bytes.writeUInt32LE((0o010644 * 65536) >>> 0, centralPositions(bytes)[0] + 38); } });
await fixture('no-unix-type', { alterZip: bytes => { bytes.writeUInt32LE(0, centralPositions(bytes)[0] + 38); } });
await fixture('directory-entry', { alterZip: bytes => { bytes.writeUInt32LE((0o040755 * 65536) >>> 0, centralPositions(bytes)[0] + 38); } });
await fixture('local-name', { alterZip: bytes => { bytes[30] = 0x58; } });
await fixture('local-size', { alterZip: bytes => { bytes.writeUInt32LE(99, 22); } });
await fixture('encrypted', { alterZip: bytes => { const p = centralPositions(bytes)[0]; bytes.writeUInt16LE(bytes.readUInt16LE(p + 8) | 1, p + 8); } });
await fixture('mode-mismatch', { alterManifest: manifest => { manifest.files[0].mode = 493; } });
await fixture('huge-payload', { alterManifest: manifest => { manifest.payloadSize = 32 * 1024 * 1024 + 1; } });
await fixture('huge-file', { alterManifest: manifest => { manifest.files[0].size = 16 * 1024 * 1024 + 1; } });
await fixture('huge-total', { alterManifest: manifest => { manifest.files.slice(0, 5).forEach(file => { file.size = 16 * 1024 * 1024; }); } });
await fixture('huge-file-count', { alterManifest: manifest => { while (manifest.files.length <= 1024) manifest.files.push({ ...manifest.files[0], path: `${site}cffi/entry${manifest.files.length}.py` }); } });
await fixture('meta-incomplete', { alterMeta: meta => { delete meta.pythonRepairManifestSha256; } });
await fixture('meta-host', { alterMeta: meta => { meta.kxxyHostFingerprint = 'c'.repeat(64); } });
await fixture('meta-revision', { alterMeta: meta => { meta.pythonRuntimeRevision = 'stale'; } });
await fixture('manifest-revision', { alterManifest: manifest => { manifest.revision = 'stale'; } });
await fixture('wrong-soabi', { alterManifest: manifest => { manifest.python.soabi = 'cpython-313-aarch64-linux-android'; } });
await fixture('wrong-api', { alterManifest: manifest => { manifest.python.minApi = 25; } });
await fixture('unknown-field', { alterManifest: manifest => { manifest.files[0].deleteAll = true; } });
await fixture('unknown-root-field', { alterManifest: manifest => { manifest.extra = true; } });
await fixture('number-coercion', { alterManifest: manifest => { manifest.files[0].size = String(manifest.files[0].size); } });
await fixture('fraction', { alterManifest: manifest => { manifest.files[0].size = 0.5; } });
await fixture('bad-mode', { alterManifest: manifest => { manifest.files[0].mode = 511; } });
await fixture('null-previous', { alterManifest: manifest => { manifest.files[0].previousSha256 = null; } });
await fixture('duplicate-field', { rawManifest: manifest => JSON.stringify(manifest).replace('"schema":1', '"schema":1,"schema":1') });
await fixture('trailing-json', { rawManifest: manifest => JSON.stringify(manifest) + '{}' });
await fixture('lenient-json', { rawManifest: manifest => JSON.stringify(manifest).replace('"schema"', "'schema'") });
await fixture('path-overlap', { alterManifest: manifest => { manifest.files.push({ ...manifest.files[0], path: `${site}cffi/__init__.py/child` }); } });
await fixture('path-case-alias', { alterManifest: manifest => { manifest.files.push({ ...manifest.files[0], path: `${site}cffi/__INIT__.py` }); } });
await fixture('missing-required', { alterManifest: manifest => { manifest.files = manifest.files.filter(file => file.path !== backend); } });
await fixture('missing-fingerprint-previous', { alterManifest: manifest => { delete manifest.files.at(-1).previousSha256; } });
await fixture('bad-fingerprint-payload', { alterRecords: entries => { entries.at(-1).bytes = Buffer.from(`fingerprint: ${'c'.repeat(64)}\n`); }, alterManifest: manifest => { manifest.files.at(-1).size = Buffer.byteLength(`fingerprint: ${'c'.repeat(64)}\n`); manifest.files.at(-1).sha256 = sha(Buffer.from(`fingerprint: ${'c'.repeat(64)}\n`)); } });
const invalidPaths = ['../outside', '/absolute', `${site}cffi/../../outside`, `${site}cffi//file.py`, `${site}cffi/./file.py`, `${site}cffi/x\\file.py`, `${site}cffi/x:stream`, `${site}cffi/NUL.py`, `${site}cffi/trailing.`, `${site}numpy/__init__.py`, 'extensions/precious', `${hostBase}client.js`, `${site}cffi/\u0000file.py`];
for (let i = 0; i < invalidPaths.length; i++) await fixture(`invalid-path-${i}`, { alterManifest: manifest => { manifest.files[0].path = invalidPaths[i]; } });

// Assert integration guards as well as running the actual helper: conflicts must not become false => deleteTreeSafely.
const installer = fs.readFileSync(path.join(engine, 'RuntimeInstaller.kt'), 'utf8');
assert.match(installer, /if \(!force && File\(root, "bin\/node"\)\.isFile\)\s*\{[\s\S]*?pythonRuntimeRepair\.preflight\(root\)[\s\S]*?dshRuntimeUpgrade\.upgrade\(root\)[\s\S]*?val repaired = pythonRuntimeRepair\.repair\(root\)/);
assert.ok(installer.indexOf('pythonRuntimeRepair.repair(root)') < installer.indexOf('if (!force && File(root, "bin/node").isFile) healPackagingWrappers(root)'));
assert.ok(installer.indexOf('pythonRuntimeRepair.repair(root)') < installer.indexOf('if (!force && isComplete(root))'));
assert.match(installer, /check\(pythonRuntimeRepair\.isCurrent\(root\)\)/);
assert.match(installer, /check\(isComplete\(root, checkMarker = false\)\)/);
console.log('PASS installer repair runs before wrappers/completeness; read-only fresh-install anchor and force bypass');

// Android 的 libcore 移除了 FileStore（Files.getFileStore 抛异常，消息就是 "getFileStore"），桌面 JVM 跑得通、
// 真机必炸 —— 0.9.44 真机事故就是它。这类调用一旦回来，本测试必须先失败。
const helperSource = fs.readFileSync(path.join(engine, 'PythonRuntimeRepair.kt'), 'utf8');
assert.ok(!/Files\.getFileStore\s*\(/.test(helperSource), 'PythonRuntimeRepair 不得调用 Files.getFileStore：Android libcore 已移除 FileStore');
assert.ok(!/\.supportsFileAttributeView\s*\(/.test(helperSource), 'PythonRuntimeRepair 不得用 FileStore.supportsFileAttributeView 探测视图');
assert.match(helperSource, /\.usableSpace/, '空间预检必须走 java.io.File.usableSpace');
console.log('PASS no FileStore dependency: free space via File.usableSpace, POSIX decided by platform');

const cp = [std, annotations].join(path.delimiter), out = path.join(temp, 'classes');
function run(args) {
  const result = spawnSync(java, ['-Dfile.encoding=UTF-8', ...args], { cwd: temp, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'JVM exited with ' + result.status);
}
console.log('Compiling actual PythonRuntimeRepair.kt with cached Kotlin 1.9.24; no downloads.');
run(['-cp', compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '1.8', '-classpath', cp, '-d', out,
  path.join(engine, 'PythonRuntimeRepair.kt'), path.join(root, 'tools/fixtures/PythonRuntimeRepairTest.kt')]);
run(['-Xmx192m', '-cp', [out, cp].join(path.delimiter), 'app.kxxy.engine.PythonRuntimeRepairTestKt', temp]);
console.log('Artifacts retained: ' + temp);
