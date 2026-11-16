/**
 * 客户端别名与启动审计的真实双版本回归，零第三方依赖。
 * 用法：node tools/test-client-compat.mjs [未打补丁的.asar或.zip]
 * 默认只读新版 ASAR；缺少新版时硬失败，不回退旧 app.asar 或构建产物。
 * 完整前端通过 stdin 做 ESM 语法检查，不创建或删除临时目录。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { openZip } from './lib/zipread.mjs';
import { openAsar } from './lib/registry.mjs';
import { createPatchContext, patchClientRuntimeAlias, patchFrontendLenientBoot } from './lib/patches.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const NM = 'lib/node_modules/';
export const CLIENT_MODULES = `${NM}@deepseek-ai/dsh-client-modules/lib/client.js`;
export const DOCUMENT_PREVIEW = `${NM}@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js`;
export const FE_PREFIX = `${NM}@deepseek-ai/dsh-web-frontend/dist/assets/`;

export function loadClientFixture(input, includePreview = false) {
  const inputPath = resolve(input ?? resolve(HERE, '../.cache/dsh-upstream-0.2.2-rc.2.asar'));
  assert(existsSync(inputPath), `缺少未打补丁输入：${inputPath}；请显式提供本地 ASAR 或 ZIP`);
  const extension = extname(inputPath).toLowerCase();
  assert(extension === '.asar' || extension === '.zip', '输入必须为未打补丁的 ASAR 或 ZIP');
  let read;
  const names = [];
  if (extension === '.asar') {
    const asar = openAsar(inputPath);
    read = name => asar.readFile(`/dsh/node_modules/${name.slice(NM.length)}`);
    asar.walkFiles('/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets', name => {
      names.push(`${FE_PREFIX}${name.split('/').pop()}`);
    });
  } else {
    const zip = openZip(inputPath);
    read = name => zip.read(name);
    names.push(...zip.names());
  }
  const mains = names.filter(name => name.startsWith(FE_PREFIX) && /\/index-[^/]+\.js$/.test(name));
  assert.equal(mains.length, 1, '真实输入必须恰有一个前端主 chunk');
  const packages = ['dsh-client-modules', 'dsh-web-frontend'];
  if (includePreview) packages.push('dsh-client-ui-sidebar-documentpreview');
  const versions = packages.map(name => {
    const manifest = JSON.parse(read(`${NM}@deepseek-ai/${name}/package.json`).toString('utf8'));
    assert.equal(manifest.name, `@deepseek-ai/${name}`, '包身份必须与输入路径一致');
    return manifest.version;
  });
  assert(versions.every(version => version === versions[0]), `输入包版本不一致：${versions.join(', ')}`);
  const version = versions[0];
  assert(['0.2.1-rc.5', '0.2.2-rc.2'].includes(version), `未验证的真实版本：${version}`);
  if (input === undefined) assert.equal(version, '0.2.2-rc.2', '默认新版输入不能冒用旧版内容');
  const keys = [CLIENT_MODULES, mains[0], ...(includePreview ? [DOCUMENT_PREVIEW] : [])];
  // 脱离 ASAR 大 Buffer，测试上下文仅保留实际需要的几个客户端文件。
  const files = new Map(keys.map(name => [name, { data: Buffer.from(read(name)), mode: 0o644 }]));
  console.log(`参照物：${inputPath}\n真实包版本：${version}（${packages.length} 包一致）`);
  return { files, version, feKey: mains[0], inputPath };
}

export function createTestSuite(title) {
  let passed = 0;
  let failed = 0;
  console.log(`\n${title}`);
  return {
    async test(label, fn) {
      try {
        const value = await fn();
        passed += 1;
        console.log(`  ok   ${label}`);
        return value;
      } catch (error) {
        failed += 1;
        console.log(`  FAIL ${label} —— ${error.stack ?? error}`);
        return undefined;
      }
    },
    finish() {
      console.log(`\n${title}：${passed} 通过 / ${failed} 失败（用例数）`);
      return { passed, failed };
    },
  };
}

export function captureClientBundle(source, globals = {}) {
  const registrations = [];
  new vm.Script(source).runInNewContext({
    ...globals,
    window: { __ModuleLoader__: { load: registration => registrations.push(registration) } },
  }, { timeout: 5000, contextCodeGeneration: { strings: false, wasm: false } });
  assert.equal(registrations.length, 1, '完整脚本必须只注册一个 factory');
  assert.equal(typeof registrations[0].factory, 'function');
  return registrations[0];
}

export function assertPatchRejected(patch, key, source, extra = new Map()) {
  const files = new Map(extra);
  files.set(key, { data: Buffer.from(source), mode: 0o640 });
  const snapshot = [...files];
  assert.throws(() => patch(createPatchContext(files)), /补丁失败/);
  assert.deepEqual([...files], snapshot, '失败不得留下部分写入');
}

function replaceFixture(source, from, to) {
  assert(source.includes(from), `负例输入缺少锚点：${from}`);
  return source.replace(from, to);
}

function auditSlice(source, modern) {
  const head = modern ? 'async function VJ(' : 'function IZ(';
  const next = modern ? 'function a9(e)' : 'function Yn(e,t)';
  const start = source.indexOf(head);
  const end = source.indexOf(next, start);
  assert(start >= 0 && end > start, '必须提取真实审计函数，而非测试重写的判据');
  const code = source.slice(start, end);
  new vm.Script(`(${code})`);
  return { start, end, code };
}

function loadAudit(source, modern) {
  const state = modern ? 'No' : 'Vi';
  const labels = modern ? 'o$' : 'yx';
  const literal = needle => {
    const start = source.indexOf(needle);
    assert(start >= 0, `审计依赖缺失：${needle}`);
    return source.slice(start, source.indexOf('}', start) + 1);
  };
  const support = [`const ${literal(`${state}={`)};`, `const ${literal(`${labels}={`)};`];
  if (modern) {
    const setStart = source.indexOf('UJ=new Set(');
    assert(setStart >= 0);
    support.push(`const ${source.slice(setStart, source.indexOf(');', setStart) + 2)}`);
    const helpersStart = source.indexOf('function a9(e)');
    const helpersEnd = source.indexOf('function $r(e,t)', helpersStart);
    assert(helpersStart >= 0 && helpersEnd > helpersStart);
    support.push(source.slice(helpersStart, helpersEnd));
  }
  const warned = [];
  const result = new vm.Script(`${support.join('\n')}\n({audit:(${auditSlice(source, modern).code}),states:${state}})`).runInNewContext({
    console: { warn: message => warned.push(String(message)) },
  }, { timeout: 5000 });
  return { ...result, warned };
}

async function runAudit(api, rows, { errors = new Map(), available = [], warn } = {}) {
  const imports = [];
  const ctx = { loader: { entries: () => rows }, get: name => available.includes(name) ? {} : undefined };
  const modules = { importError(name) { imports.push(name); return errors.get(name); } };
  const begin = api.warned.length;
  let error;
  try { await api.audit(ctx, modules, warn); } catch (caught) { error = caught; }
  return { error, warnings: api.warned.slice(begin), imports };
}

export async function runClientCompat(fixture) {
  const { files: input, version, feKey } = fixture;
  const modern = version === '0.2.2-rc.2';
  const suite = createTestSuite(`客户端兼容回归 ${version}`);
  const { test } = suite;
  // 旧调用者仍只需提供这两个文件，不需要 package.json 或 acorn 进入补丁 ctx。
  const files = new Map([CLIENT_MODULES, feKey].map(key => [key, input.get(key)]));
  const ctx = createPatchContext(files);
  const rawLoader = files.get(CLIENT_MODULES).data.toString('utf8');
  const rawFrontend = files.get(feKey).data.toString('utf8');
  await test('补丁上下文仅含加载器和前端两个文件', () => assert.equal(files.size, 2));
  await test('真实输入尚未应用客户端兼容补丁', () => {
    assert(!rawLoader.includes('KXXY_CLIENT_RUNTIME_ALIAS'));
    assert(!rawFrontend.includes('failed and were skipped'));
  });
  await test('别名补丁应用成功', () => assert.match(patchClientRuntimeAlias(ctx), /别名/));
  const loader = files.get(CLIENT_MODULES).data.toString('utf8');
  await test('完整加载器脚本通过语法检查', () => { new vm.Script(loader); });
  const modules = await test('真实 factory 导出可实例化的 ClientModuleSystem', () => {
    const registration = captureClientBundle(loader);
    assert.equal(registration.id, '@deepseek-ai/dsh-client-modules');
    const result = registration.factory(name => { throw new Error(`意外依赖：${name}`); });
    assert.equal(typeof result.ClientModuleSystem, 'function');
    return result;
  });
  const STORE = '@deepseek-ai/dsh-client-store';
  const ALIAS = '@deepseek-ai/dsh-client-runtime/client';
  const BARE = '@deepseek-ai/dsh-client-runtime';
  const store = Object.freeze({ createSnapshotStore: () => ({}), defineStore: () => ({}), shallowEqual: Object.is });
  const makeSystem = staticModules => new modules.ClientModuleSystem({
    manifest: { modules: [], plugins: [] }, staticModules,
    bootstrapModule: { id: '@deepseek-ai/dsh-client-modules', exports: modules },
    registrationTarget: { mode: 'queue', pendingQueue: [] },
    loadBundle: () => { throw new Error('离线测试不允许加载网络 bundle'); },
  });
  const system = await test('真实构造器接受 store 静态种子', () => {
    const value = makeSystem({ [STORE]: store });
    assert.equal(value.seed.get(STORE), store);
    return value;
  });
  await test('同步 require 返回同一个 store 对象', () => {
    const require = system.makeRequire('test-plugin', new Set());
    assert.equal(require(ALIAS), store);
    assert.equal(require(ALIAS), require(STORE));
  });
  await test('异步 import 返回同一个 store 对象', async () => assert.equal(await system.import(ALIAS), store));
  await test('不对 runtime 裸包名做别名', async () => {
    assert.equal(system.seed.has(BARE), false);
    assert.throws(() => system.makeRequire('test-plugin', new Set())(BARE), /missed the module table/);
    await assert.rejects(system.import(BARE), /cannot resolve/);
  });
  await test('已有别名对象不被覆盖', async () => {
    const existing = {};
    const value = makeSystem({ [STORE]: store, [ALIAS]: existing });
    assert.equal(value.makeRequire('test-plugin', new Set())(ALIAS), existing);
    assert.equal(await value.import(ALIAS), existing);
  });
  await test('已有 undefined 别名仍视为存在', () => {
    const value = makeSystem({ [STORE]: store, [ALIAS]: undefined });
    assert(value.seed.has(ALIAS));
    assert.equal(value.seed.get(ALIAS), undefined);
  });
  await test('缺少 store 时不注入虚假种子', () => assert.equal(makeSystem({}).seed.has(ALIAS), false));
  await test('别名幂等且不改变字节或权限', () => {
    const before = files.get(CLIENT_MODULES);
    assert.match(patchClientRuntimeAlias(ctx), /已打过/);
    assert.equal(files.get(CLIENT_MODULES), before);
  });
  const seed = modern ? 'this.seed=new Map(Object.entries(options.staticModules));' : 'this.seed = new Map(Object.entries(options.staticModules));';
  for (const [label, source] of [
    ['重复 seed 构造', replaceFixture(rawLoader, seed, seed + seed)],
    ['seed 来源漂移', replaceFixture(rawLoader, 'Object.entries(options.staticModules)', 'Object.entries(options.otherModules)')],
    ['构造函数改成普通方法', replaceFixture(rawLoader, 'constructor(options)', 'initialize(options)')],
    ['seed 移进嵌套语句', replaceFixture(rawLoader, seed, `if(true){${seed}}`)],
    ['伪造标记', `${rawLoader}\n/* KXXY_CLIENT_RUNTIME_ALIAS */`],
    ['已打补丁的目标存在判据被删', replaceFixture(loader, 'this.seed.has(kxxyTarget)', 'true')],
    ['重复完整 factory', rawLoader + rawLoader],
  ]) await test(`拒绝${label}且不部分写入`, () => assertPatchRejected(patchClientRuntimeAlias, CLIENT_MODULES, source));

  await test('启动审计补丁应用成功', () => assert.match(patchFrontendLenientBoot(ctx), /降级/));
  const frontend = files.get(feKey).data.toString('utf8');
  await test('完整前端 ESM 经 stdin 通过 node --check', () => {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: frontend, stdio: 'pipe' });
  });
  await test('审计之外的前端代码逐字不变', () => {
    const before = auditSlice(rawFrontend, modern);
    const after = auditSlice(frontend, modern);
    assert.equal(frontend.slice(0, after.start), rawFrontend.slice(0, before.start));
    assert.equal(frontend.slice(after.end), rawFrontend.slice(before.end));
  });
  const api = loadAudit(frontend, modern);
  const entry = (name, state, inject = {}, wait = async () => {}) => ({
    options: { name },
    ...(state === undefined ? {} : { fiber: { state, inject, await: wait } }),
  });
  const official = '@deepseek-ai/dsh-client-ui-chat';
  const nonCore = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview';
  const third = '@example/broken-plugin';
  await test('空列表不告警不抛错', async () => {
    const result = await runAudit(api, []);
    assert.equal(result.error, undefined);
    assert.equal(result.warnings.length, 0);
  });
  await test('全部 active 不告警不抛错', async () => {
    const result = await runAudit(api, [entry(official, api.states.ACTIVE), entry(third, api.states.ACTIVE)]);
    assert.equal(result.error, undefined);
    assert.equal(result.warnings.length, 0);
  });
  await test('第三方 importError 提及官方包也只告警', async () => {
    const reason = `require(${STORE}) missed the module table`;
    const result = await runAudit(api, [entry(third)], { errors: new Map([[third, new Error(reason)]]) });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.imports, [third]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /web boot: .*failed and were skipped/);
    assert(result.warnings[0].includes(third) && result.warnings[0].includes(reason));
  });
  await test('缺失 importError 时保留上游原因文案', async () => {
    const result = await runAudit(api, [entry(third)]);
    assert.equal(result.error, undefined);
    assert.match(result.warnings[0], /import failed \(see console for the import error\)/);
  });
  for (const name of [official, nonCore]) await test(`${name} 失败仍致命`, async () => {
    const result = await runAudit(api, [entry(name)]);
    assert.match(result.error?.message ?? '', /did not activate/);
    assert(result.error.message.includes(name));
    assert.equal(result.warnings.length, 0);
  });
  for (const name of ['kxxy-host', '@deepseek-ai-extra/plugin']) await test(`${name} 不误判为官方包`, async () => {
    const result = await runAudit(api, [entry(name)]);
    assert.equal(result.error, undefined);
    assert.match(result.warnings[0], /failed and were skipped/);
  });
  await test('混合失败只把官方包写进致命汇总', async () => {
    const result = await runAudit(api, [entry(third), entry(nonCore)]);
    assert(result.error?.message.includes(nonCore));
    assert(!result.error.message.includes(third));
    assert.match(result.error.message, /1 entry did not activate/);
    assert.equal(result.warnings.length, 0);
  });
  await test('pending 只列真正缺失的服务', async () => {
    const result = await runAudit(api, [entry(third, api.states.PENDING, { locale: {}, slots: {} })], { available: ['locale'] });
    assert.equal(result.error, undefined);
    assert.match(result.warnings[0], /pending \(waiting for service: slots\)/);
  });
  await test('pending 缺失多个服务保留复数诊断', async () => {
    const result = await runAudit(api, [entry(third, api.states.PENDING, { locale: {}, slots: {} })]);
    assert.match(result.warnings[0], /waiting for services: locale, slots/);
  });
  for (const [state, label] of [['LOADING', 'loading'], ['DISPOSED', 'disposed'], ['UNLOADING', 'unloading']]) {
    await test(`保留 ${label} 状态原因`, async () => {
      const result = await runAudit(api, [entry(third, api.states[state])]);
      assert.equal(result.error, undefined);
      assert(result.warnings[0].includes(`${third}: ${label}`));
    });
  }
  await test('failed 激活状态保留且不会误杀第三方', async () => {
    const result = await runAudit(api, [entry(third, api.states.FAILED, {}, async () => { throw new Error('activation probe'); })]);
    assert.equal(result.error, undefined);
    assert(result.warnings[0].includes(modern ? 'failed: Error: activation probe' : `${third}: failed`));
  });
  await test('真实上游与补丁的行为差异符合版本', async () => {
    const original = loadAudit(rawFrontend, modern);
    const result = await runAudit(original, [entry(modern ? nonCore : third)]);
    if (modern) {
      assert.equal(result.error, undefined);
      assert.match(result.warnings[0], /web boot: warning:/);
    } else assert.match(result.error?.message ?? '', /did not activate/);
  });
  if (modern) {
    await test('保留自定义告警接收器而非强写 console', async () => {
      const warnings = [];
      const result = await runAudit(api, [entry(third)], { warn: message => warnings.push(message) });
      assert.equal(result.warnings.length, 0);
      assert.match(warnings[0], /failed and were skipped/);
    });
    await test('异步激活失败原因完成前审计不会提前结束', async () => {
      let reject;
      const delayed = new Promise((_, no) => { reject = no; });
      let settled = false;
      const result = runAudit(api, [entry(third, api.states.FAILED, {}, () => delayed)]).then(value => { settled = true; return value; });
      await Promise.resolve();
      assert.equal(settled, false);
      reject(new Error('late activation reason'));
      assert.match((await result).warnings[0], /failed: Error: late activation reason/);
    });
    await test('官方异步激活错误仍致命且包含原始原因', async () => {
      const result = await runAudit(api, [entry(nonCore, api.states.FAILED, {}, async () => { throw 'activation token'; })]);
      assert.match(result.error?.message ?? '', /failed: activation token/);
      assert.equal(result.warnings.length, 0);
    });
    await test('FAILED fiber 的 await 正常返回仍有 failed 原因', async () => {
      const result = await runAudit(api, [entry(third, api.states.FAILED)]);
      assert(result.warnings[0].includes(`${third}: failed`));
    });
  }
  await test('启动审计幂等且不改变字节或权限', () => {
    const before = files.get(feKey);
    assert.match(patchFrontendLenientBoot(ctx), /已打过/);
    assert.equal(files.get(feKey), before);
  });
  const audit = auditSlice(rawFrontend, modern);
  const enumNeedle = modern ? 'No={PENDING:0' : 'Vi={PENDING:0';
  const negative = [
    ['重复审计函数', rawFrontend.slice(0, audit.end) + audit.code + rawFrontend.slice(audit.end)],
    ['收集器结构漂移', replaceFixture(rawFrontend, modern ? 't.importError(d)' : 't.importError(n)', 't.changedImportError()')],
    ['状态枚举漂移', replaceFixture(rawFrontend, enumNeedle, enumNeedle.replace(':0', ':9'))],
    ['伪造降级标记', `${rawFrontend}\n/* failed and were skipped */`],
    ['已打补丁的来源判定被改', replaceFixture(frontend, modern ? '.test(kxxyLine.name)' : '.test(kxxyLine)', '.test("not-official")')],
  ];
  if (modern) negative.push(
    ['启动调用丢失 await', replaceFixture(rawFrontend, 'await VJ(t,e.modules)', 'VJ(t,e.modules)')],
    ['激活错误等待被改', replaceFixture(rawFrontend, 'try{await e.await()}catch(t){return`failed:', 'try{e.await()}catch(t){return`failed:')],
    ['上游核心集合漂移', replaceFixture(rawFrontend, 'UJ=new Set(["@deepseek-ai/dsh-client-modules"', 'UJ=new Set(["third-party-core"')],
  );
  for (const [label, source] of negative) await test(`拒绝${label}且不部分写入`, () => assertPatchRejected(patchFrontendLenientBoot, feKey, source));
  await test('拒绝多个前端主 chunk', () => {
    assertPatchRejected(patchFrontendLenientBoot, feKey, rawFrontend, new Map([[`${FE_PREFIX}index-duplicate.js`, { data: Buffer.from(rawFrontend), mode: 0o644 }]]));
  });
  await test('拒绝缺失前端主 chunk', () => assert.throws(() => patchFrontendLenientBoot(createPatchContext(new Map())), /命中 0 个/));
  return suite.finish();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runClientCompat(loadClientFixture(process.argv[2]));
    process.exitCode = result.failed === 0 ? 0 : 1;
  } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  }
}
