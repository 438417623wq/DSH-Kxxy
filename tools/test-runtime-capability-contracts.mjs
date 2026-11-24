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
  assert.equal(marker(build), 'kxxy-patchset@40');
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
await test('bundled npm keeps bin/npm offline and is restored as the local cli', async () => {
  const { untarGz } = await import('./lib/targz.mjs');
  const tarball = join(project, 'tools/prebuilt/npm/npm-11.21.3.tgz');
  const names = untarGz(readFileSync(tarball)).map((entry) => entry.path);
  for (const anchor of ['package/package.json', 'package/bin/npm-cli.js', 'package/bin/npx-cli.js', 'package/lib/cli.js']) {
    assert.ok(names.includes(anchor), `离线 npm 缺 ${anchor}`);
  }
  assert.ok(names.some((name) => name.startsWith('package/node_modules/')), '离线 npm 没带 bundleDependencies');
  // 构建期必须真的解包进 runtime，而不是只留一个 tarball。
  assert.ok(build.includes('const bundledNpmInfo = loadBundledNpm();'));
  assert.ok(build.includes('lib/node_modules/npm/bin/${cli}'), '包装器没有指向本地 npm-cli.js');
  // 设备端自愈同理：补回来的必须是本地 cli，不能退回 corepack（那要联网）。
  assert.ok(installer.includes('lib/node_modules/npm/bin/$name-cli.js'));
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

/** 取一个 Kotlin 函数的正文（到下一段 KDoc 之前），供「实现方式」类断言用。 */
function kotlinFunction(name) {
  const start = installer.indexOf(`private fun ${name}`);
  assert.ok(start > 0, `找不到 private fun ${name}`);
  const next = installer.indexOf('\n    /**', start + 1);
  return installer.slice(start, next > 0 ? next : installer.length);
}

/*
 * APK 里那份启动器模板必须与源码逐字节一致。
 *
 * 它是 RuntimeInstaller.healGlibcLaunchers 的唯一权威来源：升级后的第一次启动
 * 上，扩展池与 runtime.zip 两条分发路径都可能是旧的（时序见该函数注释），
 * 只有随 APK 走的这份模板一定是新的。模板漂移的后果不是「报错」，而是
 * 「装上新 APK 后容器内 DNS 依旧不可用」—— 恰好是这轮要修的那个症状，
 * 所以用测试钉死，而不是靠人记得跑同步脚本。
 */
await test('APK ships a byte-identical copy of the glibc launcher template', () => {
  const source = readFileSync(join(project, 'tools/prebuilt/wrappers/kxxy-glibc.sh'), 'utf8');
  const asset = readFileSync(join(project, 'android/app/src/main/assets/glibc-route/kxxy-glibc.sh'), 'utf8');
  assert.equal(asset, source, '资产与源码不一致：跑 node tools/sync-glibc-route-asset.mjs 重新生成');
  assert.equal(asset.includes('\r'), false, '资产是 CRLF：shebang 会变成 #!/system/bin/sh\\r');
  assert.ok(asset.includes('GUEST_ETC='), '模板缺 GUEST_ETC=，/etc/resolv.conf 与 /etc/hosts 的挂载会丢');
  assert.ok(asset.includes('GUEST_SHM='), '模板缺 GUEST_SHM=，容器内 /dev/shm 仍不可用（joblib 会退回串行）');
  assert.ok(asset.includes('"$GUEST_SHM:/dev/shm"'), '模板没有把私有 shm 目录绑到 /dev/shm');
  assert.ok(installer.includes('"glibc-route/kxxy-glibc.sh"'));
  assert.ok(installer.includes('"extensions/glibc/bin/kxxy-glibc"'));
  assert.ok(installer.includes('"libexec/python-default/kxxy-glibc"'));
});

await test('glibc launcher heal covers both device copies from the APK asset', () => {
  const heal = kotlinFunction('healGlibcLaunchers');
  // 两份都要覆盖：裸 python3 走 runtime 那份，kxxy-glibc-provision 走扩展那份
  assert.ok(heal.includes('GLIBC_LAUNCHER_EXTENSION'), heal);
  assert.ok(heal.includes('PYTHON_ROUTE_SCRIPT'), heal);
  // 不再拿扩展那份当捐赠者：升级首启时它还是旧的（时序倒挂）
  assert.equal(heal.includes('donor'), false, '扩展那份不能当捐赠者');
  assert.ok(kotlinFunction('glibcLauncherTemplate').includes('GLIBC_LAUNCHER_ASSET'));
  /*
   * 判据必须逐字节比，不能是「含某个特征串」。
   *
   * v0.9.82 用的是 `GUEST_ETC=` 特征串，结果 v0.9.83 的 `/dev/shm` 修复到了
   * 已升级设备上会被判「已最新」跳过 —— 症状是「升了 APK，joblib 还是串行」。
   * 钉死这一条，避免下一个人再往「加个 mark」的方向改。
   */
  assert.ok(heal.includes('contentEquals'), '自愈判据要逐字节比对，不能只看特征串');
});

/*
 * JVM 启动器壳不能用 `$0` 推同目录。
 *
 * PATH 上的 `<root>/bin/java` 是指向 `lib/jvm/<jdk>/bin/java` 的软链，经软链
 * 调用时 `$0` 是软链路径，`${0%/*}` 得到 `<root>/bin`，壳会去找
 * `<root>/bin/java.real`（不存在）—— 症状是 java / d8 / apksigner 一起失效。
 */
await test('JVM launcher shell locates its real binary by absolute path, not $0', () => {
  const body = kotlinFunction('jvmWrapperScript');
  assert.ok(body.includes('realPath: String'), body);
  assert.equal(body.includes('${0%/*}'), false, '壳不能按 $0 推同目录');
  assert.equal(body.includes('${0##*/}'), false, '壳不能按 $0 取文件名');
  const call = installer.slice(
    installer.indexOf('val data = jvmWrapperScript'),
    installer.indexOf('\n', installer.indexOf('val data = jvmWrapperScript')),
  );
  assert.ok(call.includes('real.absolutePath'), call);
});

