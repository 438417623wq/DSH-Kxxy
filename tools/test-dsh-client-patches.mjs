/**
 * 用真实未打补丁的 ASAR/ZIP 运行五项客户端补丁的完整组合。
 * 用法：node tools/test-dsh-client-patches.mjs [未打补丁的.asar或.zip]
 * 默认只接受本地 0.2.2-rc.2 ASAR；旧版必须显式传入。
 * 不截取 provider 片段代替 bundle：真实加载器实例负责 materialize 预览 factory，
 * 再执行真正导出的 apply，保留上游 DocumentPreviewRegistry 和 store actions。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import {
  createPatchContext, patchDocumentPreviewOfficeExtensions, patchDocumentPreviewArchiveProviders,
  patchDocumentPreviewMediaProviders, patchClientRuntimeAlias, patchFrontendLenientBoot,
} from './lib/patches.mjs';
import {
  loadClientFixture, createTestSuite, captureClientBundle, assertPatchRejected,
  CLIENT_MODULES, DOCUMENT_PREVIEW,
} from './test-client-compat.mjs';

function mutate(source, before, after) {
  assert(source.includes(before), `负例输入缺少锚点：${before}`);
  return source.replace(before, after);
}

function nestedFunction(source, head, next) {
  const start = source.indexOf(head);
  const end = source.indexOf(next, start);
  assert(start >= 0 && end > start);
  return source.slice(0, start) + 'if(true){' + source.slice(start, end) + '}\n' + source.slice(end);
}

function createPreviewHost() {
  const effects = [];
  const registrations = [];
  const dictionaries = [];
  const stores = [];
  const styles = [];
  const document = {
    baseURI: 'http://127.0.0.1:3080/chat',
    querySelector(selector) { return styles.find(tag => selector === `style[data-plugin-css=${JSON.stringify(tag.dataset.pluginCss)}]`) ?? null; },
    createElement(tag) { assert.equal(tag, 'style'); return { dataset: {}, textContent: '' }; },
    head: { appendChild(tag) { styles.push(tag); } },
  };
  let reads = 0;
  let elementCalls = 0;
  let hooks = [];
  let cursor = 0;
  let pendingEffects = [];
  const react = {
    createElement(type, props, ...children) {
      elementCalls += 1;
      return { type, props: { ...props, children: children.flat().filter(child => child != null && child !== false) } };
    },
    lazy: () => () => { throw new Error('组合注册测试不加载懒组件'); },
    memo: fn => fn,
    forwardRef: fn => fn,
    createContext: value => ({ Provider: {}, Consumer: {}, value }),
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(hooks, index)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!Object.hasOwn(hooks, index)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useEffect: fn => pendingEffects.push(fn),
  };
  const store = {
    defineStore(definition) { stores.push(definition); return definition; },
    notifySubscribers(listeners) { for (const listener of listeners) listener(); },
  };
  const dependencies = {
    react,
    'react/jsx-runtime': { jsx: react.createElement, jsxs: react.createElement, Fragment: Symbol.for('react.fragment') },
    'react-dom': {},
    // 仅模拟本组合用例涉及的外部代码后缀，注册逻辑仍来自真实 bundle。
    '@deepseek-ai/dsh-client-ui-primitives': { CODE_HIGHLIGHT_EXTENSIONS: ['ts'] },
    '@deepseek-ai/dsh-client-store': store,
  };
  const noRead = () => { reads += 1; throw new Error('组合测试不允许真实文件或网络读取'); };
  const office = { render: noRead, generation: noRead };
  const ctx = {
    reflect: { provide(name, value) { assert.equal(name, 'documentPreviews'); ctx[name] = value; return () => { delete ctx[name]; }; } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); },
    locale: {
      bind: namespace => (key, params) => `${namespace}.${key}${params === undefined ? '' : JSON.stringify(params)}`,
      register(namespace, value) { dictionaries.push([namespace, value]); return () => {}; },
    },
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject: (_name, fn) => fn(),
      register(options, body) { registrations.push({ options, body }); return () => {}; },
    },
    inject(_names, fn) { return fn(ctx); },
    on: () => () => {},
    configForms: { register: () => () => {} },
    resources: {},
    remote: { workspaceFiles: { read: noRead, readBytes: noRead, stat: noRead }, officeKit: office, officeToPdf: office },
  };
  return {
    ctx, dependencies, store, registrations, dictionaries, stores, document,
    get reads() { return reads; },
    get elementCalls() { return elementCalls; },
    render(body, props, reset = false) {
      if (reset) hooks = [];
      cursor = 0;
      pendingEffects = [];
      const result = body(props);
      for (const effect of pendingEffects) effect();
      return result;
    },
    async dispose() { for (const effect of effects.reverse()) await effect(); },
  };
}

function findElement(tree, type) {
  if (tree === null || typeof tree !== 'object') return undefined;
  if (Array.isArray(tree)) return tree.map(child => findElement(child, type)).find(Boolean);
  return tree.type === type ? tree : findElement(tree.props?.children, type);
}

async function run() {
  const fixture = loadClientFixture(process.argv[2], true);
  const { version, feKey } = fixture;
  const modern = version === '0.2.2-rc.2';
  const suite = createTestSuite(`五项客户端真实组合 ${version}`);
  const { test } = suite;
  const files = new Map(fixture.files);
  const ctx = createPatchContext(files);
  const raw = files.get(DOCUMENT_PREVIEW).data.toString('utf8');
  const archiveFragment = readFileSync(new URL('./prebuilt/documentpreview-archive/providers.js', import.meta.url), 'utf8').trimEnd();
  const mediaFragment = readFileSync(new URL('./prebuilt/documentpreview-media/providers.js', import.meta.url), 'utf8').trimEnd();
  await test('真实文档 bundle 没有本地片段或预先扩展的 Office 清单', () => {
    assert(!raw.includes('kxxyArchiveApply') && !raw.includes('kxxyMediaApply'));
    assert(raw.includes(modern ? 'const extensions=[`doc`,`docx`,`ppt`,`pptx`];' : 'const extensions = [\n\t\t\t\t"doc",'));
  });
  await test('应用 Office 扩展名补丁', () => assert.match(patchDocumentPreviewOfficeExtensions(ctx), /odt/));
  const officeOnly = files.get(DOCUMENT_PREVIEW).data.toString('utf8');
  await test('在同一 bundle 应用归档补丁', () => assert.match(patchDocumentPreviewArchiveProviders(ctx), /zip \/ epub/));
  const withArchive = files.get(DOCUMENT_PREVIEW).data.toString('utf8');
  await test('在归档之后应用媒体补丁', () => assert.match(patchDocumentPreviewMediaProviders(ctx), /video \/ audio/));
  const preview = files.get(DOCUMENT_PREVIEW).data.toString('utf8');
  await test('在同一上下文应用加载器别名补丁', () => assert.match(patchClientRuntimeAlias(ctx), /别名/));
  await test('在同一上下文应用前端启动补丁', () => assert.match(patchFrontendLenientBoot(ctx), /降级/));
  await test('组合补丁只写入三个目标文件并保留 mode', () => {
    assert.deepEqual([...files.keys()], [...fixture.files.keys()]);
    for (const [key, value] of files) assert.equal(value.mode, fixture.files.get(key).mode);
  });
  await test('完整预览 bundle 和加载器均通过语法检查', () => {
    new vm.Script(preview);
    new vm.Script(files.get(CLIENT_MODULES).data.toString('utf8'));
  });
  await test('组合后的完整前端 ESM 通过 stdin 语法检查', () => {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: files.get(feKey).data, stdio: 'pipe' });
  });
  await test('新增调用均有前导分号且归档在媒体之前', () => {
    const archive = preview.indexOf(';kxxyArchiveApply(ctx);');
    const media = preview.indexOf(';kxxyMediaApply(ctx);');
    assert(archive > 0 && media > archive);
    assert.equal(preview.indexOf(';kxxyArchiveApply(ctx);', archive + 1), -1);
    assert.equal(preview.indexOf(';kxxyMediaApply(ctx);', media + 1), -1);
    assert(preview.indexOf(archiveFragment) < preview.indexOf(mediaFragment));
  });
  await test('二进制不可预览清单保持逐字不变', () => {
    const pattern = /(?:const|var) UNVIEWABLE_BINARY_EXTENSIONS\s*=\s*\[[^\]]*\]/;
    const before = pattern.exec(raw);
    const after = pattern.exec(preview);
    assert(before && after);
    assert.equal(after[0], before[0]);
  });

  const host = createPreviewHost();
  const exports = await test('真实加载器 materialize 完整预览 factory', async () => {
    const loaderRegistration = captureClientBundle(files.get(CLIENT_MODULES).data.toString('utf8'));
    const loader = loaderRegistration.factory(name => { throw new Error(`加载器意外依赖：${name}`); });
    const previewRegistration = captureClientBundle(preview, {
      document: host.document,
      URL, TextDecoder, TextEncoder, DecompressionStream, Blob, Response, AbortController, AbortSignal,
    });
    assert.equal(previewRegistration.id, '@deepseek-ai/dsh-client-ui-sidebar-documentpreview');
    const system = new loader.ClientModuleSystem({
      manifest: { modules: [], plugins: [] }, staticModules: host.dependencies,
      bootstrapModule: { id: loaderRegistration.id, exports: loader },
      registrationTarget: { mode: 'queue', pendingQueue: [previewRegistration] },
      loadBundle: () => { throw new Error('不允许加载网络 bundle'); },
    });
    assert.equal(await system.import('@deepseek-ai/dsh-client-runtime/client'), host.store);
    const module = await system.import(previewRegistration.id);
    assert.equal(typeof module.apply, 'function');
    assert(Array.isArray(module.inject));
    return module;
  });
  await test('执行真正导出的 apply 及全部同步注册 effect', () => {
    exports.apply(host.ctx);
    assert(host.ctx.documentPreviews);
    assert(host.stores.length > 0);
    assert.equal(host.reads, 0);
  });
  const registry = host.ctx.documentPreviews;
  const definitions = registry?.getSnapshot() ?? [];
  const prefix = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/';
  const names = Array.from(definitions, definition => definition.id.slice(prefix.length));
  await test('八个内置与四个本地 provider 恰好注册一次且顺序正确', () => {
    assert.deepEqual(names, ['text', 'markdown', 'html', 'image', 'pdf', 'office', 'excel', 'code', 'archive', 'epub', 'media-video', 'media-audio']);
    assert.equal(new Set(definitions.map(definition => definition.id)).size, 12);
  });
  await test('使用上游真实注册表的重复与二进制子集校验', () => {
    assert.throws(() => registry.register(definitions[0]), /duplicate implementation/);
    assert.throws(() => registry.register({ id: 'bad-subset', extensions: ['txt'], binaryExtensions: ['zip'] }), /outside its extensions/);
  });
  await test('Office 扩展名单、共享数组及 renderer 模式正确', () => {
    const office = definitions.find(definition => definition.id === `${prefix}office`);
    assert.deepEqual(Array.from(office.extensions), ['doc', 'docx', 'odt', 'ppt', 'pptx', 'odp', 'ods']);
    assert.equal(office.binaryExtensions, office.extensions);
    assert.equal(office.loading, 'renderer');
  });
  const candidates = path => Array.from(registry.candidates(path), definition => definition.id.slice(prefix.length));
  for (const extension of ['odt', 'ods', 'odp']) await test(`真实注册表将 .${extension} 交给 Office`, () => assert.deepEqual(candidates(`sample.${extension}`), ['office']));
  await test('Excel 不受 Office ODF 扩展影响', () => {
    const excel = definitions.find(definition => definition.id === `${prefix}excel`);
    assert.deepEqual(Array.from(excel.extensions), ['xlsx', 'xls', 'csv', 'tsv']);
    assert.deepEqual(candidates('sample.xlsx'), ['excel']);
  });
  await test('代码 provider 采用外部 primitives 的后缀契约', () => {
    const code = definitions.find(definition => definition.id === `${prefix}code`);
    assert.equal(code.extensions, host.dependencies['@deepseek-ai/dsh-client-ui-primitives'].CODE_HIGHLIGHT_EXTENSIONS);
    assert.deepEqual(Array.from(code.extensions), ['ts']);
    assert.equal(code.loading, 'text-pages');
  });
  await test('外部后缀桩中的 .ts 优先由代码 provider 打开，视频只是额外候选', () => assert.deepEqual(candidates('sample.ts'), ['code', 'media-video']));
  for (const [extension, name, loading] of [
    ['zip', 'archive', 'bytes-complete'], ['epub', 'epub', 'bytes-complete'],
    ['mp4', 'media-video', 'renderer'], ['mp3', 'media-audio', 'renderer'],
  ]) await test(`完整 bundle 的 .${extension} 候选、加载模式和 body 正确`, () => {
    assert.deepEqual(candidates(`sample.${extension}`), [name]);
    const definition = definitions.find(item => item.id === prefix + name);
    assert.equal(definition.loading, loading);
    assert.equal(definition.priority, 'builtin');
    assert(definition.binaryExtensions.every(ext => definition.extensions.includes(ext)));
    const bodies = host.registrations.filter(item => item.options.name === 'sidebar.right.tab.document' && item.options.key === definition.id);
    assert.equal(bodies.length, 1);
    assert.equal(typeof bodies[0].body, 'function');
  });
  await test('媒体组件使用 factory 的 React，并通过真实 store action 写字符串版本', () => {
    const textStore = host.registrations.find(item => item.options.name === 'sidebar.right.pane.tab').options.store;
    const draft = textStore.init();
    textStore.actions.loading(draft, 'tab', 'renderer');
    const revision = draft.byTab.tab.loadRevision;
    let loaded = 0;
    const body = host.registrations.find(item => item.options.key === `${prefix}media-video`).body;
    const props = {
      content: { kind: 'renderer', revision, loaded(version) { loaded += 1; textStore.actions.rendered(draft, 'tab', revision, version); }, failed: () => textStore.actions.rendererFailed(draft, 'tab', revision), reload: () => {} },
      resourceAddress: 'test-resource', useResource: () => ({ status: 'live', value: { absolutePath: '/workspace/测试 a&b.mp4', version: 'file-version-42' } }),
      t: key => key, scrollportRef: () => {},
    };
    const tree = host.render(body, props, true);
    const player = findElement(tree, 'video');
    assert(player);
    assert.equal(player.props.src, `http://127.0.0.1:3080/kxxy/media?path=${encodeURIComponent('/workspace/测试 a&b.mp4')}`);
    assert.equal(player.props.preload, 'metadata');
    assert.equal(loaded, 0);
    player.props.onLoadedMetadata();
    host.render(body, props);
    host.render(body, { ...props, content: { ...props.content } });
    assert.equal(loaded, 1);
    assert.equal(draft.byTab.tab.version, 'file-version-42');
    assert.equal(draft.byTab.tab.loading, false);
    assert(host.elementCalls > 0);
    assert.equal(host.reads, 0);
  });
  await test('缺失版本经真实 rendererFailed 清掉 loading 且不写假版本', () => {
    const textStore = host.registrations.find(item => item.options.name === 'sidebar.right.pane.tab').options.store;
    const draft = textStore.init();
    textStore.actions.loading(draft, 'tab', 'renderer');
    const revision = draft.byTab.tab.loadRevision;
    const body = host.registrations.find(item => item.options.key === `${prefix}media-audio`).body;
    const tree = host.render(body, {
      content: { kind: 'renderer', revision, loaded: () => assert.fail('不能伪造版本'), failed: () => textStore.actions.rendererFailed(draft, 'tab', revision) },
      resourceAddress: 'test-resource', useResource: () => ({ status: 'live', value: { absolutePath: '/workspace/audio.mp3' } }), t: key => key,
    }, true);
    assert.equal(findElement(tree, 'audio'), undefined);
    assert.equal(draft.byTab.tab.loading, false);
    assert.equal(draft.byTab.tab.version, undefined);
  });
  await test('组合产物的别名和启动审计仍然幂等', () => {
    const loader = files.get(CLIENT_MODULES);
    const frontend = files.get(feKey);
    assert.match(patchClientRuntimeAlias(ctx), /已打过/);
    assert.match(patchFrontendLenientBoot(ctx), /已打过/);
    assert.equal(files.get(CLIENT_MODULES), loader);
    assert.equal(files.get(feKey), frontend);
  });
  await test('所有 provider effect 可释放注册表', async () => {
    await host.dispose();
    assert.equal(registry.getSnapshot().length, 0);
  });

  const officeHead = modern ? 'function apply$2(ctx,config){' : 'function apply$2(ctx, config) {';
  const applyHead = modern ? 'function apply(ctx){' : 'function apply(ctx) {';
  const exportText = modern ? 'exports.apply=apply;' : 'exports.apply = apply;';
  const binary = modern ? 'binaryExtensions:extensions,priority:`builtin`' : 'binaryExtensions: extensions,\n\t\t\t\tpriority: "builtin"';
  const officeStart = raw.indexOf(officeHead);
  const officeEnd = raw.indexOf('function conversionErrorKey(code)', officeStart);
  const officeCode = raw.slice(officeStart, officeEnd);
  const badBinary = raw.slice(0, officeStart) + mutate(officeCode, binary, binary.replace('extensions', '[]')) + raw.slice(officeEnd);
  const tailCall = modern ? 'apply$1(ctx,config.excel);apply$3(ctx)' : 'apply$1(ctx, config.excel);\n\t\t\tapply$3(ctx);';
  const negative = [
    ['Office 重复应用', patchDocumentPreviewOfficeExtensions, officeOnly],
    ['归档重复应用', patchDocumentPreviewArchiveProviders, withArchive],
    ['媒体重复应用', patchDocumentPreviewMediaProviders, preview],
    ['媒体先于归档', patchDocumentPreviewMediaProviders, officeOnly],
    ['归档晚于媒体', patchDocumentPreviewArchiveProviders, preview],
    ['Office factory 身份漂移', patchDocumentPreviewOfficeExtensions, mutate(raw, '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', 'different-preview')],
    ['Office provider ID 漂移', patchDocumentPreviewOfficeExtensions, raw.slice(0, officeStart) + mutate(officeCode, `${prefix}office`, `${prefix}changed-office`) + raw.slice(officeEnd)],
    ['Office 共享二进制数组漂移', patchDocumentPreviewOfficeExtensions, badBinary],
    ['Office 函数嵌套进其他作用域', patchDocumentPreviewOfficeExtensions, nestedFunction(raw, officeHead, 'function conversionErrorKey(code)')],
    ['Office 函数重复', patchDocumentPreviewOfficeExtensions, raw.slice(0, officeEnd) + officeCode + raw.slice(officeEnd)],
    ['归档导出 apply 绑定漂移', patchDocumentPreviewArchiveProviders, mutate(officeOnly, exportText, exportText.replace('=apply', '=other').replace('= apply', '= other'))],
    ['归档 apply 嵌套进其他作用域', patchDocumentPreviewArchiveProviders, nestedFunction(officeOnly, applyHead, exportText)],
    ['归档内置调用移进条件分支', patchDocumentPreviewArchiveProviders, mutate(officeOnly, tailCall, `if(true){${tailCall}}`)],
    ['归档内置注册顺序改变', patchDocumentPreviewArchiveProviders, mutate(officeOnly, tailCall, tailCall.replace('apply$3', 'apply$4'))],
    ['媒体缺失归档片段', patchDocumentPreviewMediaProviders, mutate(withArchive, archiveFragment, '')],
    ['媒体归档片段被改变', patchDocumentPreviewMediaProviders, mutate(withArchive, archiveFragment, archiveFragment.replace('KXXY_ARCHIVE_NS', 'KXXY_CHANGED_NS'))],
    ['媒体缺失归档调用', patchDocumentPreviewMediaProviders, mutate(withArchive, ';kxxyArchiveApply(ctx);', '')],
    ['媒体归档调用重复', patchDocumentPreviewMediaProviders, mutate(withArchive, ';kxxyArchiveApply(ctx);', ';kxxyArchiveApply(ctx);kxxyArchiveApply(ctx);')],
    ['媒体导出 apply 绑定漂移', patchDocumentPreviewMediaProviders, mutate(withArchive, exportText, exportText.replace('=apply', '=other').replace('= apply', '= other'))],
  ];
  for (const [label, patch, source] of negative) await test(`拒绝${label}且不部分写入`, () => assertPatchRejected(patch, DOCUMENT_PREVIEW, source));
  for (const [label, patch, source] of [
    ['Office', patchDocumentPreviewOfficeExtensions, raw],
    ['归档', patchDocumentPreviewArchiveProviders, officeOnly],
    ['媒体', patchDocumentPreviewMediaProviders, withArchive],
  ]) await test(`${label} 拒绝多个完整 factory`, () => assertPatchRejected(patch, DOCUMENT_PREVIEW, source + source));
  const result = suite.finish();
  process.exitCode = result.failed === 0 ? 0 : 1;
}

try { await run(); }
catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
