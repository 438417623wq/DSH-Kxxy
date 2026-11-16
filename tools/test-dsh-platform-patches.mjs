/**
 * 两项平台补丁的真实双版本行为回归，零第三方依赖、零磁盘夹具。
 * 用法：node tools/test-dsh-platform-patches.mjs [旧原始.asar 新原始.asar]
 * 默认严格读取 .cache/app.asar 与 .cache/dsh-upstream-0.2.2-rc.2-dedup.asar，绝不回退 runtime。
 * vm 执行 ASAR 内真实函数、失败守卫及错误类；仅 loader、文件系统和平台信息使用受控桩。
 * 不加载 WASM/native 二进制，不验证二进制内容哈希、Android SELinux、OS 并发或真实 Win32 DACL。
 * 并发用屏障同时放行两个真实 writeFileAtomic，独占原语在内存桩中建模，不创建/清理磁盘文件。
 */
import assert from 'node:assert/strict';
import { constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extname, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { openAsar } from './lib/registry.mjs';
import { createPatchContext, patchFsLocal, patchLibreOfficeKitPlatform } from './lib/patches.mjs';
import { createTestSuite, assertPatchRejected } from './test-client-compat.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NM = 'lib/node_modules/';
const FS_KEY = `${NM}@deepseek-ai/dsh-fs-local/lib/index.js`;
const ENGINE_KEY = `${NM}@deepseek-ai/libreoffice-kit/lib/index.js`;
const ENGINE_PREFIX = '@deepseek-ai/libreoffice-kit';
const ENGINE_START = '//#region lib/types/engine.js\n';
const ENGINE_END = '//#endregion\n//#region lib/types/operations.js';
const FS_MARKER = 'KXXY_FS_LOCAL_EXCLUSIVE_CREATE';
const OLD_GATE = '\tif (platform !== "linux") throw new Error(`Unsupported LibreOfficeKit host: ${platform}-${arch}`);';
const NEW_GATE = OLD_GATE.replace('platform !== "linux"', 'platform !== "linux" && platform !== "android"');
const DISPLAY = '/显示路径/目标.txt';
const DESTINATION = '/workspace/目标.txt';
const FORMS = {
  '0.2.1-rc.5': {
    kit: '0.1.5', end: '/**\n* Collapse CRLF to LF',
    fsHash: '8784ae8cfcb276ca307adfd83fd6a7347421c1a2bc1972833519c67ad207572e',
    engineHash: '8053aa88a4f1bebfdb284e28cb7abd06b528f9f639225d8a61ddda763fc8ccc2',
  },
  '0.2.2-rc.2': {
    kit: '0.2.3', end: '/**\n* Remove one resolved file',
    fsHash: '7f32a437b99cf959af636053cfe6c4d9e2fc065c654f429c0ddd7922b28368c1',
    engineHash: 'e678c368c926de84b1499528998b53d26571a6831805ac89c35fadba7866cf5e',
  },
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const errno = (code, message = `受控文件系统错误 ${code}`) => Object.assign(new Error(message), { code });
const missingModule = name => errno('MODULE_NOT_FOUND', `Cannot find module '${name}/package.json'`);

function anchor(source, needle) {
  const at = source.indexOf(needle);
  assert(at >= 0, `真实输入缺少锚点：${needle}`);
  assert.equal(source.indexOf(needle, at + 1), -1, `真实输入锚点不唯一：${needle}`);
  return at;
}
function mutate(source, before, after) {
  const at = anchor(source, before);
  return source.slice(0, at) + after + source.slice(at + before.length);
}
function section(source, head, tail) {
  const start = anchor(source, head);
  const end = anchor(source, tail);
  assert(end > start, '真实函数区段的边界顺序错误');
  return source.slice(start, end);
}
function functionSource(source, name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert(match, `未找到真实函数 ${name}`);
  anchor(source, match[0]);
  const end = source.indexOf('\n}', match.index);
  assert(end > match.index, `真实函数 ${name} 缺少顶层闭合边界`);
  const code = source.slice(match.index, end + 2);
  new vm.Script(`(${code}\n)`);
  return code;
}
function classSource(source, name) {
  const start = anchor(source, `var ${name} = class`);
  const end = source.indexOf('\n};', start);
  assert(end > start, `真实类 ${name} 缺少闭合边界`);
  const code = source.slice(start, end + 3);
  new vm.Script(code);
  return code;
}
function loadFixture(input, version) {
  const path = resolve(input);
  assert.equal(extname(path).toLowerCase(), '.asar', '仅接受原始 ASAR，不接受已补丁 runtime');
  assert(existsSync(path), `缺少原始输入：${path}`);
  const asar = openAsar(path);
  const read = (pkg, file = 'lib/index.js') => asar.readFile(`/dsh/node_modules/@deepseek-ai/${pkg}/${file}`).toString('utf8');
  for (const name of ['dsh', 'dsh-fs-local', 'dsh-fs', 'dsh-llm']) {
    const pkg = JSON.parse(read(name, 'package.json'));
    assert.equal(pkg.name, `@deepseek-ai/${name}`);
    assert.equal(pkg.version, version, `${name} 不得混用版本`);
  }
  const form = FORMS[version];
  assert.equal(JSON.parse(read('libreoffice-kit', 'package.json')).version, form.kit);
  const fs = read('dsh-fs-local');
  const engine = read('libreoffice-kit');
  assert(!fs.includes(FS_MARKER) && !engine.includes(NEW_GATE), '输入已经打过平台补丁');
  assert.equal(sha256(section(fs, 'async function throwGuardedCreateFailure(', form.end)), form.fsHash);
  assert.equal(sha256(section(engine, ENGINE_START, ENGINE_END)), form.engineHash);
  const modern = version === '0.2.2-rc.2';
  const llm = read('dsh-llm');
  if (modern) anchor(llm, 'import { HarnessError } from "@deepseek-ai/dsh-error";');
  const errors = `${classSource(modern ? read('dsh-error') : llm, 'HarnessError')}\n${classSource(read('dsh-fs'), 'FsError')}`;
  const engineFixtures = new Map();
  for (const target of modern ? ['win32-x64', 'wasm'] : ['win32-x64']) {
    engineFixtures.set(target, {
      pkg: JSON.parse(read(`libreoffice-kit-${target}`, 'package.json')),
      manifest: JSON.parse(read(`libreoffice-kit-${target}`, 'prebuilds.json')),
    });
  }
  const entry = statSync(path);
  console.log(`原始输入：${path}\n版本：DSH ${version} / LibreOfficeKit ${form.kit}；ASAR ${entry.size} 字节`);
  console.log(`真实区段 SHA256：fs=${form.fsHash}；engine=${form.engineHash}`);
  console.log(`资产桩：${modern ? 'WASM 与 win32-x64 使用本 ASAR 的真实清单' : '旧 ASAR 未含 WASM；仅 win32-x64 使用真实清单'}；其它目标按版本契约构造，均不加载二进制。`);
  return { ...form, version, modern, fs, engine, errors, engineFixtures, path, inputSize: entry.size, inputMtime: entry.mtimeMs };
}
function fsScript(fixture, source) {
  const helpers = ['isENOENT', 'isENOTDIR', 'isEEXIST', 'isPermissionError', 'isAbortError', 'errorMessage', 'throwIfAborted'];
  return new vm.Script(`${fixture.errors}\n${helpers.map(name => functionSource(source, name)).join('\n')}\n${section(source, 'async function removeStagingDirOrThrow(', fixture.end)}\n({ writeFileAtomic, FsError })`, { filename: `真实-fs-${fixture.version}.js` });
}
function engineScript(fixture, source) {
  // 只移除顶层 createRequire 胶水；所有实际选择器、manifest 与资产校验函数逐字保留。
  const code = mutate(section(source, ENGINE_START, ENGINE_END), 'const require = createRequire(import.meta.url);', '');
  return new vm.Script(`${code}\n({ resolveEngine, readEngine, platformTarget, glibcVersion })`, { filename: `真实-engine-${fixture.kit}.js` });
}
function evaluate(script, globals) {
  return script.runInNewContext({ Error, ...globals }, { timeout: 5000, contextCodeGeneration: { strings: false, wasm: false } });
}
function fileStatus(entry) {
  return { isFile: () => entry.type === 'file', isDirectory: () => entry.type === 'directory', isSymbolicLink: () => entry.type === 'symlink', mode: entry.mode ?? 0o755 };
}

function engineHost(fixture, script, { platform = 'android', arch = 'arm64', glibc = '2.36', targets = ['wasm'] } = {}) {
  const path = platform === 'win32' ? win32 : posix;
  const modules = path.resolve(platform === 'win32' ? 'C:/受控平台测试' : '/受控平台测试', 'node_modules');
  const packages = new Map();
  const entries = new Map();
  const texts = new Map();
  const calls = [];
  const resolutionErrors = new Map();
  const statErrors = new Map();
  const readErrors = new Map();
  function install(target) {
    const name = `${ENGINE_PREFIX}-${target}`;
    const root = path.join(modules, name);
    const version = target.endsWith('-glibc') ? '0.1.1' : fixture.kit;
    const backend = target === 'wasm' ? 'wasm' : 'native';
    const state = structuredClone(fixture.engineFixtures.get(target) ?? {
      pkg: { name, version },
      manifest: {
        schemaVersion: 1, version, platform: target, status: 'built',
        engine: backend === 'native'
          ? { kind: 'native', executable: 'program/soffice', programDirectory: 'program' }
          : { kind: 'wasm', loader: 'assets/loader.cjs', wasm: 'assets/engine.wasm', data: 'assets/engine.data', metadata: 'assets/metadata.json', programDirectory: '/instdir/program' },
      },
    });
    Object.assign(state, { name, root, packageFile: path.join(root, 'package.json'), manifestFile: path.join(root, 'prebuilds.json') });
    packages.set(target, state);
    entries.set(root, { type: 'directory' });
    entries.set(state.packageFile, { type: 'file' });
    entries.set(state.manifestFile, { type: 'file' });
    const keys = backend === 'native' ? ['programDirectory', 'executable'] : ['loader', 'wasm', 'data', 'metadata'];
    state.assets = Object.fromEntries(keys.map(key => [key, path.resolve(root, state.manifest.engine[key])]));
    for (const [key, filename] of Object.entries(state.assets)) entries.set(filename, { type: key === 'programDirectory' ? 'directory' : 'file', mode: 0o755 });
    update(target, () => {});
    return state;
  }
  function update(target, change) {
    const state = packages.get(target);
    assert(state, `受控包未安装：${target}`);
    change(state);
    texts.set(state.packageFile, JSON.stringify(state.pkg));
    texts.set(state.manifestFile, JSON.stringify(state.manifest));
  }
  for (const target of targets) install(target);
  function statFile(filename) {
    if (statErrors.has(filename)) throw statErrors.get(filename);
    const entry = entries.get(filename);
    if (!entry) throw errno('ENOENT', `受控资产缺失：${filename}`);
    return fileStatus(entry);
  }
  function resolvePackage(name) {
    calls.push(['resolve', name]);
    if (resolutionErrors.has(name)) throw resolutionErrors.get(name);
    const filename = path.join(modules, name, 'package.json');
    if (!entries.has(filename)) throw missingModule(name);
    return filename;
  }
  const require = () => assert.fail('引擎选择测试不得真正加载 native 或 WASM');
  require.resolve = request => {
    assert(request.endsWith('/package.json'));
    return resolvePackage(request.slice(0, -'/package.json'.length));
  };
  require.resolve.paths = name => { calls.push(['resolve.paths', name]); return [modules]; };
  const host = { platform, arch, report() { calls.push(['report']); return { header: { glibcVersionRuntime: glibc } }; } };
  const api = evaluate(script, {
    ...path, require,
    process: { platform, arch, report: { getReport: host.report } },
    readFile: async (filename, encoding) => {
      calls.push(['readFile', filename]);
      assert.equal(encoding, 'utf8');
      if (readErrors.has(filename)) throw readErrors.get(filename);
      if (!texts.has(filename)) throw errno('ENOENT', `受控清单缺失：${filename}`);
      return texts.get(filename);
    },
    stat: async filename => { calls.push(['stat', filename]); return statFile(filename); },
    statSync: filename => { calls.push(['statSync', filename]); return statFile(filename); },
    lstatSync: (filename, options) => {
      calls.push(['lstatSync', filename]);
      assert.equal(options.throwIfNoEntry, false);
      return entries.has(filename) ? fileStatus(entries.get(filename)) : undefined;
    },
  });
  return { api, path, host, packages, entries, texts, calls, resolutionErrors, statErrors, readErrors, update, resolvePackage, resolved: () => calls.filter(call => call[0] === 'resolve').map(call => call[1]) };
}

function fsHost(fixture, script, { platform = 'android', hooks = {} } = {}) {
  const entries = new Map([['/', { type: 'directory', mode: 0o755 }]]);
  const calls = [];
  const handles = new Set();
  let serial = 0;
  async function event(name, ...args) {
    calls.push([name, ...args]);
    await hooks[name]?.(...args);
  }
  function entry(path) {
    if (!entries.has(path)) throw errno('ENOENT');
    return entries.get(path);
  }
  function publication(source, target, exclusive, removeSource) {
    const staged = entry(source);
    assert.equal(staged.type, 'file');
    assert(![...handles].some(handle => handle.path === source), '发布前必须关闭暂存句柄');
    if (exclusive && entries.has(target)) throw errno('EEXIST');
    entries.set(target, { ...staged, content: Buffer.from(staged.content) });
    if (removeSource) entries.delete(source);
  }
  const io = {
    async mkdir(path, options = {}) {
      await event('mkdir', path, options);
      if (entries.has(path)) {
        if (options.recursive && entry(path).type === 'directory') return;
        throw errno('EEXIST');
      }
      assert.equal(entry(posix.dirname(path)).type, 'directory');
      entries.set(path, { type: 'directory', mode: options.mode ?? 0o755 });
    },
    async chmod(path, mode) { await event('chmod', path, mode); entry(path).mode = mode; },
    async open(path, flags, mode) {
      await event('open', path, flags, mode);
      assert.equal(flags, 'wx');
      if (entries.has(path)) throw errno('EEXIST');
      assert.equal(entry(posix.dirname(path)).type, 'directory');
      entries.set(path, { type: 'file', content: Buffer.alloc(0), mode });
      const handle = {
        path,
        async chmod(value) { await event('handle.chmod', path, value); entry(path).mode = value; },
        async writeFile(content, options) {
          await event('writeFile', path, content, options);
          assert.equal(options.encoding, 'utf8');
          if (options.signal?.aborted) throw Object.assign(errno('ABORT_ERR'), { name: 'AbortError' });
          entry(path).content = Buffer.from(content);
        },
        async sync() { await event('sync', path); },
        async close() { await event('close', path); assert(handles.delete(handle), '暂存句柄被重复关闭'); },
      };
      handles.add(handle);
      return handle;
    },
    async lstat(path, options) { await event('lstat', path, options); assert.equal(options.bigint, true); return fileStatus(entry(path)); },
    async copyFile(source, target, flags = 0) {
      await event('copyFile', source, target, flags);
      // 模拟内核独占发布点：存在检查与插入之间不 await；不模拟文件内容的原子可见性。
      publication(source, target, Boolean(flags & fsConstants.COPYFILE_EXCL), false);
    },
    async link(source, target) {
      await event('link', source, target);
      if (platform === 'android') throw errno('EPERM', '受控 Android link 拒绝');
      publication(source, target, true, false);
    },
    async rename(source, target) { await event('rename', source, target); publication(source, target, false, true); },
    async rm(path, options) {
      await event('rm', path, options);
      assert.equal(options.recursive, true);
      assert.equal(options.force, true);
      for (const key of entries.keys()) if (key === path || key.startsWith(`${path}/`)) entries.delete(key);
    },
    async copyFileDaclWin32(target, temp) { await event('copyDacl', target, temp); entry(target); entry(temp); },
    async replaceFileWin32(target, temp) { await event('replaceFile', target, temp); entry(target); publication(temp, target, false, true); },
  };
  const api = evaluate(script, { ...posix, ...io, fsConstants, process: { platform, pid: 1920 }, randomUUID: () => `受控-${++serial}` });
  const h = {
    api, io, entries, calls, handles,
    seed(content = '原始内容', type = 'file') { entries.set(DESTINATION, { type, content: Buffer.from(content), mode: 0o640 }); },
    content() { return entries.get(DESTINATION)?.content?.toString('utf8'); },
    names() { return calls.map(call => call[0]); },
    clean() { assert.equal(handles.size, 0); assert(![...entries.keys()].some(path => path.includes('.tmpdir')), '暂存目录未释放'); },
    write(content = '新的内容\n', { exclusive = false, mode, signal, internals = {}, options = {} } = {}) {
      const publicationOptions = fixture.modern ? { displayPath: DISPLAY, createIfAbsent: exclusive, ...options } : exclusive ? { displayPath: DISPLAY } : undefined;
      return api.writeFileAtomic(DESTINATION, content, mode, signal, internals, publicationOptions);
    },
  };
  return h;
}
async function fsFailure(h, promise, code, cause) {
  let failure;
  await assert.rejects(promise, error => {
    failure = error;
    assert(error instanceof h.api.FsError);
    assert.equal(error.code, code);
    if (cause !== undefined) assert.equal(error.cause, cause);
    return true;
  });
  return failure;
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('并发屏障未完成，不能报告通过')), 5000); })]); }
  finally { clearTimeout(timer); }
}

async function testPatchContracts(f, test, files) {
  const ctx = createPatchContext(files);
  await test('fs 补丁在真实区段成功应用', () => assert.match(patchFsLocal(ctx), /Android 独占创建/));
  await test('engine 补丁保留版本专属门禁', () => assert.match(patchLibreOfficeKitPlatform(ctx), f.modern ? /零改写/ : /仅放行 Android WASM/));
  const fs = files.get(FS_KEY).data.toString('utf8');
  const engine = files.get(ENGINE_KEY).data.toString('utf8');
  await test('两项补丁只改变指定代码及 import，区段外逐字保留', () => {
    const copy = '\t\t\t/* KXXY_FS_LOCAL_EXCLUSIVE_CREATE */\n\t\t\tif (platform === "android") await copyFile(tempPath, absolutePath, fsConstants.COPYFILE_EXCL);\n\t\t\telse await linkFile(tempPath, absolutePath);';
    let restored = mutate(fs, copy, '\t\t\tawait linkFile(tempPath, absolutePath);');
    restored = mutate(restored, 'import { constants as fsConstants, createReadStream, realpath }', 'import { createReadStream, realpath }');
    restored = mutate(restored, 'import { chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat }', 'import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat }');
    assert.equal(restored, f.fs);
    assert.equal(f.modern ? engine : mutate(engine, NEW_GATE, OLD_GATE), f.engine);
    assert.equal(files.get(FS_KEY).mode, 0o640);
    assert.equal(files.get(ENGINE_KEY).mode, 0o644);
  });
  for (const [name, patch] of [['fs', patchFsLocal], ['engine', patchLibreOfficeKitPlatform]]) {
    await test(`${name} 连续重入两次幂等且不写入任何 Map 条目`, () => {
      const before = [...files];
      for (let i = 0; i < 2; i += 1) {
        assert.match(patch(ctx), name === 'engine' && f.modern ? /已验证.*零改写/ : /已打过/);
        assert.deepEqual([...files.keys()], before.map(([key]) => key));
        for (const [key, value] of before) assert.equal(files.get(key), value);
      }
    });
    await test(`${name} 包缺失按约定跳过，不伪造成功产物`, () => {
      const empty = new Map();
      assert.match(patch(createPatchContext(empty)), /跳过/);
      assert.equal(empty.size, 0);
    });
  }
  for (const [label, source] of [['fs', fs], ['engine', engine]]) await test(`${label} 完整 ESM 经指定 Node 的 stdin 语法检查`, () => {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: source, stdio: 'pipe' });
  });
  const fsNegatives = [
    ['原始发布函数漂移', mutate(f.fs, 'await linkFile(tempPath, absolutePath);', 'await rename(tempPath, absolutePath);')],
    ['原始失败守卫被吞掉', mutate(f.fs, 'if (isEEXIST(error)) throw new FsError', 'if (false) throw new FsError')],
    ['仅有伪标记', `${f.fs}\n/* ${FS_MARKER} */`],
    ['重复标记', `${fs}\n/* ${FS_MARKER} */`],
    ['只有 fs import 半补丁', mutate(f.fs, 'import { createReadStream, realpath }', 'import { constants as fsConstants, createReadStream, realpath }')],
    ['只有 promises import 半补丁', mutate(f.fs, 'import { chmod, link, lstat', 'import { chmod, copyFile, link, lstat')],
    ['标记和发布点存在但缺少 import', mutate(fs, 'import { constants as fsConstants, createReadStream, realpath }', 'import { createReadStream, realpath }')],
    ['标记和发布点存在但缺少 copyFile import', mutate(fs, 'import { chmod, copyFile, link, lstat', 'import { chmod, link, lstat')],
    ['已补丁独占标志被移除', mutate(fs, 'fsConstants.COPYFILE_EXCL', '0')],
    ['已补丁 Android 分支被扩大到 Linux', mutate(fs, 'if (platform === "android") await copyFile', 'if (platform !== "win32") await copyFile')],
    ['已补丁守卫漂移', mutate(fs, 'if (isEEXIST(error)) throw new FsError', 'if (false) throw new FsError')],
    ['已补丁取消检查漂移', mutate(fs, '\t\tthrowIfAborted(signal, "write");\n\t\tif (', '\t\tvoid signal;\n\t\tif (')],
    ['重复真实模块', f.fs + f.fs],
    ['写入区段边界漂移', mutate(f.fs, f.end, f.end.replace('/**', '/* 改变边界'))],
  ];
  for (const [label, source] of fsNegatives) await test(`fs 拒绝${label}且零部分写入`, () => assertPatchRejected(patchFsLocal, FS_KEY, source));
  const engineNegatives = [
    ['原始 ABI 门禁改成 Android 冒充 Linux', mutate(f.engine, 'if (platform !== "linux") return void 0;', 'if (platform !== "linux" && platform !== "android") return void 0;')],
    ['原始版本清单漂移', mutate(f.engine, `const ENGINE_VERSION = "${f.kit}";`, 'const ENGINE_VERSION = "9.9.9";')],
    ['原始资产文件类型校验丢失', mutate(f.engine, 'kind === "directory" ? !status.isDirectory() : !status.isFile()', 'false')],
    ['原始 glibc 下限判据漂移', mutate(f.engine, 'part > (host[index] ?? 0)', 'part < (host[index] ?? 0)')],
    ['已补丁包版本校验丢失', mutate(engine, 'pkg.version !== ENGINE_VERSIONS[target]', 'false')],
    ['已补丁已安装损坏包守卫丢失', mutate(engine, 'if (packageExists(name)) throw new Error', 'if (false) throw new Error')],
    ['已补丁目录越界校验丢失', mutate(engine, 'relative(root, path) === ".."', 'false')],
    ['重复真实模块', f.engine + f.engine],
    ['engine 区段边界漂移', mutate(f.engine, ENGINE_END, '//#endregion\n//#region changed-operations')],
  ];
  if (f.modern) engineNegatives.push(['新版混入旧门禁半补丁', mutate(engine, '\tconst wasm = `${ENGINE_PREFIX}-wasm`;', `${NEW_GATE}\n\tconst wasm = \`${'${ENGINE_PREFIX}'}-wasm\`;`)]);
  else engineNegatives.push(
    ['旧版只放宽 native 必需门禁的半补丁', mutate(f.engine, 'if (platform !== "linux") throw new Error(`Required LibreOfficeKit native package is missing: ${name}`', 'if (platform !== "linux" && platform !== "android") throw new Error(`Required LibreOfficeKit native package is missing: ${name}`')],
    ['旧版已补丁尾门禁被放宽', mutate(engine, NEW_GATE, NEW_GATE.replace('platform !== "android"', 'platform !== "freebsd"'))],
  );
  for (const [label, source] of engineNegatives) await test(`engine 拒绝${label}且零部分写入`, () => assertPatchRejected(patchLibreOfficeKitPlatform, ENGINE_KEY, source));
  return { fs, engine };
}

async function testEngineBehavior(f, test, raw, patched) {
  const make = options => engineHost(f, patched, options);
  for (const arch of ['arm64', 'x64', 'arm']) await test(`Android ${arch} 只选择 WASM，不读取 Linux 包或 glibc 报告`, async () => {
    const h = make({ arch, targets: ['wasm', 'linux-arm64-glibc'] });
    h.texts.set(h.packages.get('linux-arm64-glibc').manifestFile, '{损坏的 native 清单');
    assert.equal(h.api.platformTarget(), undefined);
    const result = await h.api.resolveEngine();
    assert.equal(result.backend, 'wasm');
    assert.equal(result.programDirectory, '/instdir/program');
    for (const key of ['loader', 'wasm', 'data', 'metadata']) assert.equal(result[key], h.packages.get('wasm').assets[key]);
    assert.deepEqual(h.resolved(), [`${ENGINE_PREFIX}-wasm`]);
    assert(!h.calls.some(call => call[0] === 'report'));
  });
  await test('真实未补丁 Android 行为与补丁差异符合两个版本', async () => {
    const h = engineHost(f, raw);
    if (f.modern) assert.equal((await h.api.resolveEngine()).backend, 'wasm');
    else { await assert.rejects(h.api.resolveEngine(), /Unsupported LibreOfficeKit host: android-arm64/); assert.equal(h.resolved().length, 0); }
  });
  for (const platform of ['linux', 'darwin', 'win32']) for (const arch of ['arm64', 'x64']) await test(`${platform} ${arch} 优先 native，不读取损坏的 WASM 清单`, async () => {
    const target = `${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`;
    const h = make({ platform, arch, targets: [target, 'wasm'] });
    h.texts.set(h.packages.get('wasm').manifestFile, '{损坏的 WASM 清单');
    assert.equal(h.api.platformTarget(), target);
    const result = await h.api.resolveEngine();
    assert.equal(result.backend, 'native');
    assert.equal(result.executable, h.packages.get(target).assets.executable);
    assert.equal(result.programDirectory, h.packages.get(target).assets.programDirectory);
    assert.equal(Boolean(result.legacyInputPath), f.modern && platform === 'linux');
    assert.deepEqual(h.resolved(), [`${ENGINE_PREFIX}-${target}`]);
  });
  for (const [label, options] of [
    ['Linux 未安装 native', { platform: 'linux' }],
    ['Linux musl', { platform: 'linux', glibc: undefined }],
    ['Linux 非 native 架构', { platform: 'linux', arch: 'riscv64' }],
  ]) await test(`${label} 使用 WASM`, async () => {
    const h = make({ ...options, ...(label === 'Linux musl' ? { glibc: null } : {}) });
    assert.equal((await h.api.resolveEngine()).backend, 'wasm');
    assert.equal(h.resolved().at(-1), `${ENGINE_PREFIX}-wasm`);
    if (label !== 'Linux 未安装 native') assert.equal(h.resolved().length, 1);
  });
  for (const [host, minimum, backend] of [
    ['2.27', '2.28', 'wasm'], ['2.28', '2.28', 'native'], ['2.9', '2.28', 'wasm'],
    ['2.28', '2.28.1', 'wasm'], ['2.28.2', '2.28.1', 'native'], ['3.0', '2.99', 'native'],
  ]) await test(`Linux glibc ${host} / 引擎最低 ${minimum} 选择 ${backend}`, async () => {
    const h = make({ platform: 'linux', glibc: host, targets: ['linux-arm64-glibc', 'wasm'] });
    h.update('linux-arm64-glibc', state => { state.manifest.engine.glibcMinimum = minimum; });
    assert.equal((await h.api.resolveEngine()).backend, backend);
    assert.equal(h.resolved().length, backend === 'native' ? 1 : 2);
  });
  for (const platform of ['darwin', 'win32', 'freebsd']) await test(`${platform} 无 native 时保留上游版本专属边界`, async () => {
    const h = make({ platform });
    if (f.modern) assert.equal((await h.api.resolveEngine()).backend, 'wasm');
    else await assert.rejects(h.api.resolveEngine(), platform === 'freebsd' ? /Unsupported LibreOfficeKit host/ : /Required LibreOfficeKit native package is missing/);
  });
  for (const platform of ['linux', 'darwin', 'win32']) {
    const target = `${platform}-arm64${platform === 'linux' ? '-glibc' : ''}`;
    await test(`${platform} native 已安装但 package.json 缺失不得回退`, async () => {
      const h = make({ platform, targets: [target, 'wasm'] });
      h.entries.delete(h.packages.get(target).packageFile);
      await assert.rejects(h.api.resolveEngine(), error => { assert.match(error.message, /package is incomplete/); assert.equal(error.cause.code, 'MODULE_NOT_FOUND'); return true; });
      assert.deepEqual(h.resolved(), [`${ENGINE_PREFIX}-${target}`]);
    });
    await test(`${platform} native 清单损坏不得回退健康的 WASM`, async () => {
      const h = make({ platform, targets: [target, 'wasm'] });
      h.update(target, state => { state.manifest.version = '损坏版本'; });
      await assert.rejects(h.api.resolveEngine(), /incompatible or incomplete manifest/);
      assert.deepEqual(h.resolved(), [`${ENGINE_PREFIX}-${target}`]);
    });
  }
  await test('Android WASM 包缺失报错，绝不尝试已安装 Linux native', async () => {
    const h = make({ targets: ['linux-arm64-glibc'] });
    await assert.rejects(h.api.resolveEngine(), error => error.code === 'MODULE_NOT_FOUND');
    assert.deepEqual(h.resolved(), [`${ENGINE_PREFIX}-wasm`]);
  });
  const invalidManifests = [
    ['包名不匹配', state => { state.pkg.name = '@example/wrong'; }],
    ['包版本不匹配', state => { state.pkg.version = '9.9.9'; }],
    ['清单版本不匹配', state => { state.manifest.version = '9.9.9'; }],
    ['schemaVersion 错误', state => { state.manifest.schemaVersion = 2; }],
    ['未完成构建', state => { state.manifest.status = 'incomplete'; }],
    ['平台不匹配', state => { state.manifest.platform = 'wrong'; }],
    ['后端 kind 不匹配', state => { state.manifest.engine.kind = 'wrong'; }],
    ['engine 缺失', state => { delete state.manifest.engine; }],
  ];
  for (const target of ['wasm', 'linux-arm64-glibc']) for (const [label, change] of invalidManifests) await test(`${target} 拒绝${label}`, async () => {
    const h = make({ platform: target === 'wasm' ? 'android' : 'linux', targets: [target, ...(target === 'wasm' ? [] : ['wasm'])] });
    h.update(target, change);
    await assert.rejects(h.api.resolveEngine(), /incompatible or incomplete manifest/);
    assert.deepEqual(h.resolved(), [`${ENGINE_PREFIX}-${target}`]);
  });
  for (const file of ['packageFile', 'manifestFile']) for (const fault of ['missing', 'json', 'io']) await test(`WASM ${file} 的 ${fault} 故障必须报错`, async () => {
    const h = make();
    const filename = h.packages.get('wasm')[file];
    const failure = errno('EIO', '受控清单读取损坏');
    if (fault === 'missing') h.texts.delete(filename);
    if (fault === 'json') h.texts.set(filename, '{损坏 JSON');
    if (fault === 'io') h.readErrors.set(filename, failure);
    await assert.rejects(h.api.resolveEngine(), error => {
      if (fault === 'missing') assert.equal(error.code, 'ENOENT');
      if (fault === 'json') assert.equal(error.name, 'SyntaxError');
      if (fault === 'io') assert.equal(error, failure);
      return true;
    });
  });
  for (const target of ['wasm', 'linux-arm64-glibc']) {
    const keys = target === 'wasm' ? ['loader', 'wasm', 'data', 'metadata'] : ['executable', 'programDirectory'];
    for (const key of keys) for (const fault of ['missing', 'type', 'io']) await test(`${target} ${key} 资产 ${fault} 故障不得伪成功或降级`, async () => {
      const h = make({ platform: target === 'wasm' ? 'android' : 'linux', targets: target === 'wasm' ? ['wasm'] : [target, 'wasm'] });
      const filename = h.packages.get(target).assets[key];
      const failure = errno('EIO', '受控资产元数据损坏');
      if (fault === 'missing') h.entries.delete(filename);
      if (fault === 'type') h.entries.set(filename, { type: key === 'programDirectory' ? 'file' : 'directory' });
      if (fault === 'io') h.statErrors.set(filename, failure);
      await assert.rejects(h.api.resolveEngine(), error => {
        if (fault === 'missing') assert.equal(error.code, 'ENOENT');
        if (fault === 'type') assert.match(error.message, /is not a (file|directory)/);
        if (fault === 'io') assert.equal(error, failure);
        return true;
      });
      assert.deepEqual(h.resolved(), [`${ENGINE_PREFIX}-${target}`]);
    });
  }
  for (const value of ['', null, '/绝对路径', '../越界路径', '..']) await test(`WASM loader 拒绝非法资产路径 ${JSON.stringify(value)}`, async () => {
    const h = make();
    h.update('wasm', state => { state.manifest.engine.loader = value; });
    await assert.rejects(h.api.resolveEngine(), /invalid asset path|escapes its installed package/);
  });
  for (const platform of ['linux', 'win32']) await test(`${platform} 保留 native 可执行权限的上游平台边界`, async () => {
    const target = platform === 'linux' ? 'linux-arm64-glibc' : 'win32-arm64';
    const h = make({ platform, targets: [target, 'wasm'] });
    h.entries.get(h.packages.get(target).assets.executable).mode = 0o644;
    if (platform === 'linux') await assert.rejects(h.api.resolveEngine(), /executable is not executable/);
    else assert.equal((await h.api.resolveEngine()).backend, 'native');
    assert.deepEqual(h.resolved(), [`${ENGINE_PREFIX}-${target}`]);
  });
  for (const minimum of ['bad', '02.28', '2.28.0.1', '9007199254740992.0']) await test(`Linux 拒绝非法 glibcMinimum ${minimum}`, async () => {
    const h = make({ platform: 'linux', targets: ['linux-arm64-glibc', 'wasm'] });
    h.update('linux-arm64-glibc', state => { state.manifest.engine.glibcMinimum = minimum; });
    await assert.rejects(h.api.resolveEngine(), /invalid glibcMinimum/);
    assert.equal(h.resolved().length, 1);
  });
  await test('WASM 不接受仅适用于 glibc native 的最低版本字段', async () => {
    const h = make();
    h.update('wasm', state => { state.manifest.engine.glibcMinimum = '2.28'; });
    await assert.rejects(h.api.resolveEngine(), /invalid glibcMinimum/);
  });
  for (const failure of [errno('EACCES'), errno('MODULE_NOT_FOUND', '缺少另一个依赖包，而非目标 package.json')]) await test(`默认 resolver 不吞 ${failure.code} / ${failure.message}`, async () => {
    const h = make({ platform: 'linux' });
    h.resolutionErrors.set(`${ENGINE_PREFIX}-linux-arm64-glibc`, failure);
    await assert.rejects(h.api.resolveEngine(), error => error === failure);
    assert.equal(h.resolved().length, 1);
  });
  await test('自定义 resolver 的包存在判据保留双版本差异', async () => {
    const h = make({ platform: 'linux', targets: ['linux-arm64-glibc', 'wasm'] });
    const custom = name => { if (name.endsWith('-wasm')) return h.resolvePackage(name); throw missingModule(name); };
    if (f.modern) {
      assert.equal((await h.api.resolveEngine(custom, undefined, h.host)).backend, 'wasm');
      assert(!h.calls.some(call => call[0] === 'lstatSync'));
    } else await assert.rejects(h.api.resolveEngine(custom, undefined, h.host), /package is incomplete/);
  });
  if (f.modern) {
    for (const [label, value] of [['undefined', undefined], ['null', null], ['数字', 42], ['Promise', Promise.resolve('unused')], ['相对路径', './package.json']]) await test(`新版自定义 resolver 拒绝${label}，不能回退`, async () => {
      const h = make({ platform: 'linux' });
      await assert.rejects(h.api.resolveEngine(() => value, undefined, h.host), /synchronously return a string path|non-absolute path/);
      assert.equal(h.resolved().length, 0);
    });
    for (const type of ['missing', 'directory']) await test(`新版自定义 resolver 拒绝${type}路径`, async () => {
      const h = make({ platform: 'linux' });
      const filename = h.path.resolve('/受控路径/package.json');
      if (type === 'directory') h.entries.set(filename, { type });
      await assert.rejects(h.api.resolveEngine(() => filename, undefined, h.host), type === 'missing' ? /returned a missing path/ : /not a file/);
    });
  }
  for (const platform of ['linux', 'darwin', 'win32', 'freebsd']) await test(`${platform} 完整选择结果与未补丁版本一致`, async () => {
    const target = `${platform}-arm64${platform === 'linux' ? '-glibc' : ''}`;
    const options = { platform, targets: platform === 'freebsd' ? ['wasm'] : [target, 'wasm'] };
    const before = engineHost(f, raw, options);
    const after = make(options);
    const outcome = async h => {
      try { return { value: { ...await h.api.resolveEngine() }, calls: h.calls }; }
      catch (error) { return { error: { name: error.name, message: error.message }, calls: h.calls }; }
    };
    assert.deepEqual(await outcome(after), await outcome(before));
  });
}

async function testFsBehavior(f, test, raw, patched) {
  const make = options => fsHost(f, patched, options);
  await test('Android createIfAbsent 真实发布采用 COPYFILE_EXCL、保留字节和指定 mode', async () => {
    const h = make();
    const content = '中文与 UTF-8\r\n第二行\n';
    await h.write(content, { exclusive: true, mode: 0o640 });
    assert.equal(h.content(), content);
    assert.equal(h.entries.get(DESTINATION).mode, 0o640);
    assert.equal(h.calls.filter(call => call[0] === 'copyFile').length, 1);
    assert.equal(h.calls.find(call => call[0] === 'copyFile')[3], fsConstants.COPYFILE_EXCL);
    assert(!h.names().some(name => ['link', 'rename', 'replaceFile', 'lstat'].includes(name)));
    assert(h.names().indexOf('sync') < h.names().indexOf('close'));
    assert(h.names().indexOf('close') < h.names().indexOf('copyFile'));
    const open = h.calls.find(call => call[0] === 'open');
    assert.equal(open[3], 0o600);
    assert(h.calls.some(call => call[0] === 'chmod' && call[2] === 0o700));
    h.clean();
  });
  await test('Android 已有文件绝不覆盖，保留 FS_NOT_OBSERVED 和 EEXIST cause', async () => {
    const h = make(); h.seed();
    const error = await fsFailure(h, h.write('不能覆盖', { exclusive: true }), 'FS_NOT_OBSERVED');
    assert.equal(error.cause.code, 'EEXIST');
    assert(error.message.includes(DISPLAY));
    assert.equal(h.content(), '原始内容');
    assert(h.names().indexOf('copyFile') < h.names().indexOf('lstat'));
    assert(!h.names().includes('rename'));
    h.clean();
  });
  for (const type of ['directory', 'symlink', 'other']) await test(`Android createIfAbsent 不覆盖已有 ${type}`, async () => {
    const h = make(); h.seed('原始条目', type);
    await fsFailure(h, h.write('不能覆盖', { exclusive: true }), 'FS_NOT_REGULAR_FILE');
    assert.equal(h.entries.get(DESTINATION).type, type);
    assert.equal(h.content(), '原始条目');
    h.clean();
  });
  await test('两个真实 Android createIfAbsent 经屏障并发恰好一成功，失败者不覆盖胜者', async () => {
    const h = make();
    const gate = Promise.withResolvers();
    let staged = 0;
    const internals = { inspectTemp() { staged += 1; if (staged === 2) gate.resolve(); return gate.promise; } };
    const contents = ['并发创建者甲\n', '并发创建者乙\n'];
    const results = await bounded(Promise.allSettled(contents.map(content => h.write(content, { exclusive: true, internals }))));
    assert.equal(staged, 2);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    assert.equal(h.content(), contents[winner]);
    const failure = results[1 - winner].reason;
    assert(failure instanceof h.api.FsError);
    assert.equal(failure.code, 'FS_NOT_OBSERVED');
    assert.equal(failure.cause.code, 'EEXIST');
    assert.equal(h.calls.filter(call => call[0] === 'copyFile').length, 2);
    assert.equal(new Set(h.calls.filter(call => call[0] === 'open').map(call => call[1])).size, 2);
    assert(!h.names().includes('rename'));
    h.clean();
  });
  await test('真实未补丁 Android 独占创建仍因 link 拒绝而失败，测试能区分修复', async () => {
    const h = fsHost(f, raw);
    const error = await fsFailure(h, h.write('数据', { exclusive: true }), 'FS_IO_ERROR');
    assert.equal(error.cause.code, 'EPERM');
    assert.equal(h.content(), undefined);
    assert(h.names().includes('link'));
    h.clean();
  });
  for (const platform of ['linux', 'darwin', 'win32']) {
    await test(`${platform} createIfAbsent 仍调用 native link 而非 copyFile`, async () => {
      const h = make({ platform });
      await h.write('非 Android 独占创建', { exclusive: true });
      assert.equal(h.content(), '非 Android 独占创建');
      assert(h.names().includes('link'));
      assert(!h.names().some(name => ['copyFile', 'rename'].includes(name)));
      h.clean();
    });
    await test(`${platform} createIfAbsent 仍拒绝已有文件`, async () => {
      const h = make({ platform }); h.seed();
      const error = await fsFailure(h, h.write('不能覆盖', { exclusive: true }), 'FS_NOT_OBSERVED');
      assert.equal(error.cause.code, 'EEXIST');
      assert.equal(h.content(), '原始内容');
      assert(!h.names().includes('copyFile'));
      h.clean();
    });
  }
  for (const platform of ['android', 'linux', 'darwin', 'win32']) for (const existing of [false, true]) await test(`${platform} 默认写入${existing ? '替换已有文件' : '创建缺失文件'}仍采用 rename`, async () => {
    const h = make({ platform }); if (existing) h.seed();
    await h.write('默认替换的完整内容');
    assert.equal(h.content(), '默认替换的完整内容');
    assert.equal(h.calls.filter(call => call[0] === 'rename').length, 1);
    assert(!h.names().some(name => ['copyFile', 'link'].includes(name)));
    h.clean();
  });
  await test('完全省略 internals/options 时真实默认参数仍替换已有文件', async () => {
    const h = make(); h.seed();
    await h.api.writeFileAtomic(DESTINATION, '真实默认参数内容', undefined, undefined);
    assert.equal(h.content(), '真实默认参数内容');
    assert.equal(h.calls.filter(call => call[0] === 'rename').length, 1);
    assert(!h.names().some(name => ['copyFile', 'link', 'replaceFile'].includes(name)));
    h.clean();
  });
  for (const exclusive of [false, true]) for (const stage of ['before', 'parent', 'write', 'publish']) await test(`${exclusive ? '独占' : '默认'}写入在 ${stage} 取消时不发布且返回 FS_ABORTED`, async () => {
    const controller = new AbortController();
    const hooks = {};
    if (stage === 'parent') hooks.mkdir = (_path, options) => { if (options.recursive) controller.abort(); };
    if (stage === 'write') hooks.writeFile = () => controller.abort();
    const h = make({ hooks }); h.seed();
    if (stage === 'before') controller.abort();
    const internals = stage === 'publish' ? { inspectTemp: () => controller.abort() } : {};
    await fsFailure(h, h.write('取消内容', { exclusive, signal: controller.signal, internals }), 'FS_ABORTED');
    assert.equal(h.content(), '原始内容');
    assert(!h.names().some(name => ['copyFile', 'link', 'rename', 'replaceFile'].includes(name)));
    if (stage === 'before') assert.equal(h.calls.length, 0);
    h.clean();
  });
  for (const code of ['EIO', 'EPERM', 'ENOSPC']) await test(`Android 独占 copyFile ${code} 保留失败原因与显示路径`, async () => {
    const failure = errno(code);
    const h = make({ hooks: { copyFile: () => { throw failure; } } });
    const error = await fsFailure(h, h.write('失败内容', { exclusive: true }), 'FS_IO_ERROR', failure);
    assert(error.message.includes(DISPLAY));
    assert.equal(h.content(), undefined);
    assert(!h.names().some(name => ['link', 'rename'].includes(name)));
    h.clean();
  });
  for (const code of ['ENOENT', 'ENOTDIR']) await test(`独占发布 EEXIST 后元数据 ${code} 仍按冲突拒绝`, async () => {
    const failure = errno('EEXIST');
    const h = make({ hooks: { copyFile: () => { throw failure; }, lstat: () => { throw errno(code); } } });
    await fsFailure(h, h.write('失败内容', { exclusive: true }), 'FS_NOT_OBSERVED', failure);
    assert.equal(h.content(), undefined);
    h.clean();
  });
  await test('独占发布后元数据 EACCES 不得吞错或报成功', async () => {
    const metadataError = errno('EACCES');
    const h = make({ hooks: { copyFile: () => { throw errno('EIO'); }, lstat: () => { throw metadataError; } } });
    await fsFailure(h, h.write('失败内容', { exclusive: true }), 'FS_IO_ERROR', metadataError);
    h.clean();
  });
  for (const operation of ['mkdir', 'chmod', 'open', 'writeFile', 'sync', 'rename']) await test(`${operation} I/O 失败保留两版错误契约且清理暂存状态`, async () => {
    const failure = errno(operation === 'mkdir' ? 'EACCES' : 'EIO');
    const h = make({ hooks: { [operation]: () => { throw failure; } } }); h.seed();
    if (f.modern) await fsFailure(h, h.write('失败内容'), operation === 'mkdir' ? 'FS_PERMISSION_DENIED' : 'FS_IO_ERROR', failure);
    else await assert.rejects(h.write('失败内容'), error => error === failure);
    assert.equal(h.content(), '原始内容');
    h.clean();
  });
  await test('未创建成功的暂存目录属于别人时不删除其内容', async () => {
    const h = make();
    h.entries.set('/workspace', { type: 'directory' });
    h.entries.set('/workspace/已被占用.tmpdir', { type: 'directory' });
    h.entries.set('/workspace/已被占用.tmpdir/他人的文件', { type: 'file', content: Buffer.from('不得删除') });
    const promise = h.write('数据', { internals: { tempDirName: () => '已被占用.tmpdir' } });
    if (f.modern) { const error = await fsFailure(h, promise, 'FS_IO_ERROR'); assert.equal(error.cause.code, 'EEXIST'); }
    else await assert.rejects(promise, error => error.code === 'EEXIST');
    assert.equal(h.entries.get('/workspace/已被占用.tmpdir/他人的文件').content.toString(), '不得删除');
    assert(!h.names().includes('rm'));
    assert.equal(h.handles.size, 0);
  });
  for (const failure of [new Error('原始逻辑缺陷'), { reason: '非 Error 拒绝值' }]) await test(`默认写入不吞掉${failure instanceof Error ? '普通 Error' : '非 Error 拒绝值'}`, async () => {
    const h = make({ hooks: { rename: () => { throw failure; } } });
    await assert.rejects(h.write(), error => error === failure);
    h.clean();
  });
  await test('已分类 FsError 在默认发布失败时保持同一对象', async () => {
    let failure;
    const h = make({ hooks: { rename: () => { throw failure; } } });
    failure = new h.api.FsError('原始已分类错误', 'FS_STALE_VERSION');
    await assert.rejects(h.write(), error => error === failure);
    h.clean();
  });
  await test('主失败叠加暂存清理失败时继续拒绝并保留主 cause', async () => {
    const failure = new Error('原始发布失败');
    const cleanup = new Error('清理失败');
    const h = make({ hooks: { rename: () => { throw failure; }, rm: () => { throw cleanup; } } });
    const error = await fsFailure(h, h.write(), 'FS_NOT_FOUND', failure);
    assert.match(error.message, /原始发布失败.*清理失败/);
    assert.equal(h.content(), undefined);
    assert.equal(h.handles.size, 0);
    assert(h.names().includes('rm'));
  });
  await test('主写入失败叠加 close 失败时不伪成功且保留主 cause', async () => {
    const failure = new Error('原始写入失败');
    const h = make({ hooks: { writeFile: () => { throw failure; }, close: () => { throw new Error('关闭失败'); } } });
    const error = await fsFailure(h, h.write(), 'FS_NOT_FOUND', failure);
    assert.match(error.message, /原始写入失败.*关闭失败/);
    assert.equal(h.content(), undefined);
    assert(h.names().includes('rm'));
  });
  await test('发布已成功后的清理失败保持上游 best-effort 语义，不回滚目标', async () => {
    const h = make({ hooks: { rm: () => { throw new Error('发布后清理失败'); } } });
    await h.write('已提交内容', { exclusive: true });
    assert.equal(h.content(), '已提交内容');
    assert.equal(h.handles.size, 0);
    assert(h.names().includes('rm'));
  });
  await test('Windows 默认替换先复制 DACL 再写入，最后走 replaceFile', async () => {
    const h = make({ platform: 'win32' }); h.seed();
    await h.write('Windows 替换内容', { mode: 0o640 });
    assert.equal(h.content(), 'Windows 替换内容');
    assert(h.names().indexOf('copyDacl') < h.names().indexOf('writeFile'));
    assert(h.names().indexOf('close') < h.names().indexOf('replaceFile'));
    assert(!h.names().some(name => ['rename', 'copyFile', 'link'].includes(name)));
    h.clean();
  });
  for (const code of ['ENOENT', 'EIO']) await test(`Windows replaceFile ${code} 的回退/传播保持原样`, async () => {
    const failure = errno(code);
    const h = make({ platform: 'win32', hooks: { replaceFile: () => { throw failure; } } }); h.seed();
    const promise = h.write('Windows 替换内容', { mode: 0o640 });
    if (code === 'ENOENT') { await promise; assert.equal(h.content(), 'Windows 替换内容'); assert(h.names().includes('rename')); }
    else {
      if (f.modern) await fsFailure(h, promise, 'FS_IO_ERROR', failure);
      else await assert.rejects(promise, error => error === failure);
      assert.equal(h.content(), '原始内容');
      assert(!h.names().includes('rename'));
    }
    h.clean();
  });
  await test('Windows DACL 失败发生在写入前且不得发布', async () => {
    const failure = errno('EACCES');
    const h = make({ platform: 'win32', hooks: { copyDacl: () => { throw failure; } } }); h.seed();
    if (f.modern) await fsFailure(h, h.write('不能写入', { mode: 0o640 }), 'FS_PERMISSION_DENIED', failure);
    else await assert.rejects(h.write('不能写入', { mode: 0o640 }), error => error === failure);
    assert(!h.names().some(name => ['writeFile', 'replaceFile', 'rename'].includes(name)));
    assert.equal(h.content(), '原始内容');
    h.clean();
  });
  if (f.modern) for (const existingDestination of [false, true]) await test(`新版 Windows existingDestination=${existingDestination} 独立于 mode`, async () => {
    const h = make({ platform: 'win32' }); h.seed();
    await h.write('新选项内容', { mode: existingDestination ? undefined : 0o640, options: { existingDestination } });
    assert.equal(h.names().includes('copyDacl'), existingDestination);
    assert.equal(h.names().includes('replaceFile'), existingDestination);
    assert.equal(h.names().includes('rename'), !existingDestination);
    assert.equal(h.content(), '新选项内容');
    h.clean();
  });
  for (const platform of ['linux', 'darwin', 'win32']) await test(`${platform} 默认替换的调用序列与原始函数一致`, async () => {
    const before = fsHost(f, raw, { platform }); before.seed();
    const after = make({ platform }); after.seed();
    await before.write('比较内容', { mode: 0o640 });
    await after.write('比较内容', { mode: 0o640 });
    assert.deepEqual(JSON.parse(JSON.stringify(after.calls)), JSON.parse(JSON.stringify(before.calls)));
    assert.equal(after.content(), before.content());
    before.clean(); after.clean();
  });
}

async function runVersion(input, version) {
  const suite = createTestSuite(`平台补丁真实行为 ${version}`);
  const { test } = suite;
  try {
    const f = await test('载入未补丁原始 ASAR 并校验包身份、版本与两个真实区段 SHA', () => loadFixture(input, version));
    if (!f) return suite.finish();
    const sentinel = { data: Buffer.from('不应改写的第三个条目'), mode: 0o600 };
    const files = new Map([[FS_KEY, { data: Buffer.from(f.fs), mode: 0o640 }], [ENGINE_KEY, { data: Buffer.from(f.engine), mode: 0o644 }], ['lib/未修改条目', sentinel]]);
    const output = await testPatchContracts(f, test, files);
    await test('两项组合没有添加/删除文件且不触碰旁路条目', () => {
      assert.deepEqual([...files.keys()], [FS_KEY, ENGINE_KEY, 'lib/未修改条目']);
      assert.equal(files.get('lib/未修改条目'), sentinel);
    });
    const scripts = await test('从真实模块提取原版/补丁版 engine、writeFileAtomic、守卫和错误类供 vm 执行', () => ({
      fsRaw: fsScript(f, f.fs), fsPatched: fsScript(f, output.fs),
      engineRaw: engineScript(f, f.engine), enginePatched: engineScript(f, output.engine),
    }));
    if (scripts) {
      await testEngineBehavior(f, test, scripts.engineRaw, scripts.enginePatched);
      await testFsBehavior(f, test, scripts.fsRaw, scripts.fsPatched);
    }
    await test('原始 ASAR 的大小和修改时间未变，测试未回写归档', () => {
      const current = statSync(f.path);
      assert.equal(current.size, f.inputSize);
      assert.equal(current.mtimeMs, f.inputMtime);
    });
  } catch (error) { await test('测试编排必须完整执行，不能将中断当作通过', () => { throw error; }); }
  return suite.finish();
}

try {
  assert.equal(process.versions.node.split('.')[0], '24', '请使用任务指定的 Node24');
  const args = process.argv.slice(2);
  assert(args.length === 0 || args.length === 2, '请同时传入旧、新两个原始 ASAR，或使用明确的默认路径');
  const inputs = args.length ? args : [resolve(ROOT, '.cache/app.asar'), resolve(ROOT, '.cache/dsh-upstream-0.2.2-rc.2-dedup.asar')];
  const patchPath = fileURLToPath(new URL('./lib/patches.mjs', import.meta.url));
  const baseline = sha256(readFileSync(patchPath));
  console.log(`运行环境：${process.execPath}；Node ${process.version}；宿主 ${process.platform}/${process.arch}`);
  console.log(`patches.mjs SHA256：${baseline}\n测试文件 SHA256：${sha256(readFileSync(fileURLToPath(import.meta.url)))}`);
  console.log('边界：真实函数 + Windows 上的受控 loader/fs 桩；不是 Android 真机、Linux 内核、真实 DACL 或 Office 转换测试。');
  const results = [];
  for (const [index, version] of ['0.2.1-rc.5', '0.2.2-rc.2'].entries()) results.push(await runVersion(inputs[index], version));
  const audit = createTestSuite('测试期间源码保护');
  await audit.test('patches.mjs 字节与运行前一致', () => assert.equal(sha256(readFileSync(patchPath)), baseline));
  results.push(audit.finish());
  const passed = results.reduce((sum, result) => sum + result.passed, 0);
  const failed = results.reduce((sum, result) => sum + result.failed, 0);
  console.log(`\n平台行为实际合计：${passed} 通过 / ${failed} 失败（用例数；非断言数）`);
  console.log('资产故障覆盖：缺包、缺清单、损坏 JSON/版本/类型/路径/glibc 契约、资产缺失/错误类型/EIO；不宣称检测二进制内容损坏。');
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
