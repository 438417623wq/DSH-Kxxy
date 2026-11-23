import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { pythonDefaultWrappers, PYTHON_DEFAULT_PATHS } from './lib/python-default.mjs';
import { hardlinkWrappers, rsyncWrappers } from './lib/hardlink-wrappers.mjs';
import { writeSmallZip, openIndexedZip } from './lib/zipedit.mjs';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = readFileSync(join(project, 'tools/build-runtime.mjs'), 'utf8');
const installer = readFileSync(join(project, 'android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt'), 'utf8');
const config = readFileSync(join(project, 'android/app/src/main/java/app/kxxy/engine/EngineConfig.kt'), 'utf8');
const generated = [...pythonDefaultWrappers(), ...hardlinkWrappers(), ...rsyncWrappers()];

await test('runtime and native installer share the new patchset contract', () => {
  const marker = (text) => /(?:const|val) PATCHSET_MARKER\s*=\s*"([^"]+)"/.exec(text)?.[1];
  assert.equal(marker(build), 'kxxy-patchset@38');
  assert.equal(marker(installer), marker(build));
});
await test('all independent Python routes have native completeness anchors', () => {
  assert.equal(PYTHON_DEFAULT_PATHS.length, 6);
  for (const path of PYTHON_DEFAULT_PATHS) assert.ok(installer.includes('"' + path + '"'), path);
  assert.ok(installer.includes('for (rel in PYTHON_DEFAULT_FILES)'));
});
await test('build integrates generated files and declares their placeholder rewriting', () => {
  assert.ok(build.includes('...pythonDefaultWrappers()'));
  assert.ok(build.includes('norm.placeholderPaths.push(w.path)'));
  assert.ok(build.includes('...hardlinkWrappers()'));
  assert.ok(build.includes('...rsyncWrappers()'));
  assert.ok(!build.includes('function hardlinkWrappers()'));
  assert.ok(!build.includes('function rsyncWrappers()'));
});
await test('default shims do not replace native interpreter or privilege gates', () => {
  const routes = pythonDefaultWrappers();
  assert.equal(routes.some(({ path }) => path.startsWith('bin/')), false);
  assert.equal(routes.some(({ path }) => /\/(su|shz)$/.test(path)), false);
  for (const route of routes.filter(({ path }) => path.includes('/bin/'))) {
    assert.ok(route.data.toString('utf8').includes('/bin/python'));
  }
  const pythonBin = config.indexOf('libexec/python-default/bin');
  const nativeBin = config.indexOf('add(File(root, "bin").absolutePath)', pythonBin);
  assert.ok(pythonBin >= 0 && nativeBin > pythonBin);
});
await test('native Python health contract still uses its original absolute executable', () => {
  const selftest = readFileSync(join(project, 'plugins/kxxy-host/lib/python-selftest.mjs'), 'utf8');
  assert.ok(selftest.includes("posix.join(root, 'bin', 'python3')"));
  assert.ok(selftest.includes("['-I', '-B', PROBE_FILE, executable]"));
});
await test('bundled native wheels exist, match their pinned sha256 and carry android tags', async () => {
  const { NATIVE_ML } = await import('./lib/pydeps.mjs');
  const { createHash } = await import('node:crypto');
  assert.ok(NATIVE_ML.length >= 2, '原生包至少包含 scikit-learn 与 opencv');
  const anchors = NATIVE_ML.map((item) => item.anchor);
  assert.ok(anchors.includes('sklearn/__init__.py'));
  assert.ok(anchors.includes('cv2/__init__.py'));
  for (const item of NATIVE_ML) {
    assert.match(item.file, /cp314-cp314-android_24_arm64_v8a\.whl$/, item.file);
    const buf = readFileSync(join(project, 'tools/prebuilt/native-ml', item.file));
    assert.equal(createHash('sha256').update(buf).digest('hex'), item.sha256, item.file);
  }
});
await test('build-time shell templates are LF (a CRLF shebang fails exec)', async () => {
  const { readdirSync } = await import('node:fs');
  const { normalizeScriptText } = await import('./lib/script-source.mjs');
  assert.equal(normalizeScriptText('a\r\nb\rc\n'), 'a\nb\nc\n');
  const bad = [];
  for (const dir of ['prebuilt/wrappers', 'prebuilt/kxxy-tools']) {
    for (const name of readdirSync(join(project, 'tools', dir))) {
      if (!/\.(sh|py)$/.test(name)) continue;
      if (readFileSync(join(project, 'tools', dir, name), 'utf8').includes('\r')) {
        bad.push(`${dir}/${name}`);
      }
    }
  }
  assert.deepEqual(bad, [], '这些脚本是 CRLF，会让设备上 exec 报「No such file or directory」：' + bad.join(', '));
});
await test('packers read templates through the LF normalizer', () => {
  const asset = readFileSync(join(project, 'tools/lib/asset-pack.mjs'), 'utf8');
  const py = readFileSync(join(project, 'tools/lib/python-default.mjs'), 'utf8');
  assert.ok(asset.includes('readScriptText(tpl'));
  assert.ok(py.includes('readScriptText(PYTHON_DEFAULT_SOURCE'));
  assert.ok(py.includes('readScriptText(PYTHON_DEFAULT_GLIBC_SOURCE'));
  assert.ok(build.includes('readScriptText(p'));
});
await test('runtime route archive preserves bytes, permission bits and unique paths', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kxxy-capability-contract-'));
  const path = join(scratch, 'routes.zip');
  const files = new Map(generated.map((entry) => [entry.path, entry]));
  assert.equal(files.size, generated.length);
  await writeSmallZip(path, files);
  const zip = openIndexedZip(path);
  try {
    for (const entry of generated) {
      assert.ok(zip.read(entry.path).equals(entry.data), entry.path);
      assert.equal(zip.byName.get(entry.path).mode & 0o777, entry.mode);
    }
  } finally { zip.close(); }
  console.log('Contract-only archive retained: ' + path);
});
