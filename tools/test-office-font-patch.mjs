// Office 字体局部回归：只读真实双版本 ASAR，在内存中打补丁，不构建 runtime/APK。
// 用法：[OFFICE_FONT_TEST_PARENT=<已有 .cache 子目录>] node --experimental-vm-modules tools/test-office-font-patch.mjs
// 完整 Office 模块、Config/schema、队列、转换/读 PDF/清理方法原样执行；仅宿主与 Kit 边界使用受控桩。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createPatchContext, patchOfficeDefaultFonts, applyAllPatches } from "./lib/patches.mjs";
import { createTestSuite } from "./test-client-compat.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parent = path.resolve(process.env.OFFICE_FONT_TEST_PARENT ?? path.join(project, ".cache"));
assert.ok(fs.lstatSync(parent).isDirectory() && !fs.lstatSync(parent).isSymbolicLink(), "日志父目录必须已存在且不是链接");
const withinCache = path.relative(path.join(project, ".cache"), parent);
assert.ok(!path.isAbsolute(withinCache) && withinCache !== ".." && !withinCache.startsWith(`..${path.sep}`), "日志必须放在项目 .cache 内");
const evidence = fs.mkdtempSync(path.join(parent, "test-office-font-"));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const NM = "lib/node_modules/";
const FONT_REL = "lib/node_modules/kxxy-host/fonts";
const ROOT = "/data/user/0/app.kxxy/files/engine";
const MARKER = "KXXY_OFFICE_DEFAULT_FONTS";
const INPUT = Buffer.from("受控 Office 输入；真实解析仅在 Kit 边界替代");
const PDF = Buffer.from("%PDF-1.7\n受控 PDF 输出\n%%EOF\n");
const sourceNames = ["tools/lib/patches.mjs", "android/app/src/main/java/app/kxxy/engine/EngineConfig.kt", "tools/test-office-font-patch.mjs"];
const sourceHashes = Object.fromEntries(sourceNames.map((name) => [name, sha256(fs.readFileSync(path.join(project, name)))]));
const suite = createTestSuite("Office 默认字体真实双版本回归");
const test = suite.test;
console.log(`Node ${process.version}；可执行文件 ${process.execPath}；证据目录 ${evidence}`);

function readAt(fd, offset, size) {
  assert.ok(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(size) && size >= 0);
  const bytes = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const count = fs.readSync(fd, bytes, got, size - got, offset + got);
    assert.ok(count > 0, "真实 ASAR 输入被截断");
    got += count;
  }
  return bytes;
}

// 只读所需区间及 ASAR integrity，不把整个大包载入内存，也不回退已构建 runtime。
function loadFixture(modern) {
  const archive = path.join(project, modern ? ".cache/dsh-upstream-0.2.2-rc.2-dedup.asar" : ".cache/app.asar");
  const fd = fs.openSync(archive, "r");
  try {
    const head = readAt(fd, 0, 16);
    const length = head.readUInt32LE(12);
    assert.ok(length > 0 && length < 64 * 1024 * 1024 && length + 16 <= fs.fstatSync(fd).size);
    const header = JSON.parse(readAt(fd, 16, length));
    const base = 16 + Math.ceil(length / 4) * 4;
    const hashes = {};
    const read = (relative) => {
      const name = `dsh/node_modules/${relative}`;
      const entry = name.split("/").reduce((node, part) => node?.files?.[part], header);
      assert.ok(entry && !entry.files && !entry.link, `真实 ASAR 普通文件缺失：${name}`);
      const bytes = entry.unpacked ? fs.readFileSync(path.join(`${archive}.unpacked`, name))
        : readAt(fd, base + Number(entry.offset), Number(entry.size));
      assert.equal(bytes.length, entry.size);
      if (entry.integrity) {
        assert.equal(entry.integrity.algorithm, "SHA256");
        assert.equal(sha256(bytes), entry.integrity.hash, `ASAR integrity 不符：${name}`);
      }
      hashes[relative] = sha256(bytes);
      if (modern) assert.equal(sha256(fs.readFileSync(path.join(project, ".cache/dsh-upstream-0.2.2-rc.2-dedup/node_modules", relative))), sha256(bytes), `新版解包副本与 ASAR 不符：${relative}`);
      return bytes.toString("utf8");
    };
    const pkg = `@deepseek-ai/${modern ? "dsh-office-kit" : "dsh-office-to-pdf"}`;
    const manifest = JSON.parse(read(`${pkg}/package.json`));
    const version = modern ? "0.2.2-rc.2" : "0.2.1-rc.5";
    assert.equal(manifest.name, pkg);
    assert.equal(manifest.version, version);
    const sources = new Map();
    const dependencyVersions = {};
    for (const name of ["@deepseek-ai/schemastery", "@deepseek-ai/cosmokit", "@deepseek-ai/dsh-brand", "js-yaml"]) {
      const info = JSON.parse(read(`${name}/package.json`));
      assert.equal(info.name, name);
      dependencyVersions[name] = info.version;
      const entry = info.module ?? info.exports?.["."]?.import ?? info.main;
      assert.equal(typeof entry, "string", `缺少真实 ESM 入口：${name}`);
      sources.set(name, read(`${name}/${entry.replace(/^\.\//, "")}`));
    }
    // 完整入口还会执行前端审计和 manifest 补丁；提供真实最小闭包，不用伪源码绕过。
    const assets = "dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets".split("/")
      .reduce((node, part) => node?.files?.[part], header)?.files;
    const mains = Object.keys(assets ?? {}).filter((name) => /^index-[^/]+\.js$/.test(name));
    assert.equal(mains.length, 1, "真实 ASAR 必须恰有一个前端主 chunk");
    const pipelineFiles = new Map(["@deepseek-ai/dsh/package.json", `@deepseek-ai/dsh-web-frontend/dist/assets/${mains[0]}`]
      .map((name) => [`${NM}${name}`, { data: Buffer.from(read(name)), mode: 0o644 }]));
    return {
      modern, archive, version, pkg, id: modern ? "office-kit" : "office-to-pdf", key: `${NM}${pkg}/lib/index.js`,
      source: read(`${pkg}/lib/index.js`), sources, dependencyVersions, hashes, pipelineFiles,
      boot: read("@deepseek-ai/dsh-app-boot/lib/index.js"),
      baseYaml: read("@deepseek-ai/dsh-base/cordis.patch.yml"),
      webYaml: read("@deepseek-ai/dsh-web-app/cordis.patch.yml"),
      digest: modern ? "88f0697ec0507ba25732f3a359ddca277e1890f215fbe1babf7b98f6c4c40e97" : "74cf9df9ab605a7675797ee1304d7af7059e97e90c3728ce4e40fbd2333fd7b8",
      fontDigest: modern ? "04f8bac43c0ced64a478059435ab8b9ceedeacd6b11790bfd70a97c7fffb2278" : "e85c76f603af39038aaafcc5bc829fc760c3889b879078890ccbb910cd54beea",
      queue: modern
        ? "\t\t\tthis.queue = new ConversionQueue(config, this.generation, (bytes, request, signal) => this.runOperation(bytes, request, signal));"
        : "\t\t\tthis.queue = new ConversionQueue(config, this.generation, (bytes, extension, signal) => this.convertBytes(bytes, extension, signal));",
    };
  } finally { fs.closeSync(fd); }
}

function section(source, begin, end) {
  assert.equal(source.split(begin).length, 2, `源码起点必须唯一：${begin}`);
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start + begin.length);
  assert.ok(stop > start, `源码终点缺失：${end}`);
  return source.slice(start, stop);
}
function replace(source, from, to) {
  assert.equal(source.split(from).length, 2, `负例锚点必须唯一：${from}`);
  return source.replace(from, to);
}
function model(fixture, source = fixture.source) {
  return new Map([[fixture.key, { data: Buffer.from(source), mode: 0o640 }],
    [`${NM}unrelated/keep.txt`, { data: Buffer.from("其他内容不得改写"), mode: 0o600 }]]);
}
function countedContext(files) {
  const ctx = createPatchContext(files);
  const writes = [];
  const write = ctx.write;
  ctx.write = (rel, content) => { writes.push(rel); write(rel, content); };
  return { ctx, writes };
}
function rejectPatch(files) {
  const before = [...files].map(([key, entry]) => [key, { ...entry, data: Buffer.from(entry.data) }]);
  const { ctx, writes } = countedContext(files);
  assert.throws(() => patchOfficeDefaultFonts(ctx), /补丁失败/);
  assert.deepEqual(writes, [], "拒绝漂移时必须在任何写入之前失败");
  assert.deepEqual([...files], before, "失败不得留下部分修改");
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function optionsData(options) {
  const { resolveEnginePackage, ...data } = options;
  return structuredClone(data);
}

async function officeModule(fixture, source, platform, root, forbidEnv = false) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const home = platform === "win32" ? "C:/office-test" : "/office-test";
  const kitEntry = "file:///office-test/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js";
  const files = new Map(), directories = new Set(), effects = [];
  const state = { options: [], renders: [], envReads: [], warnings: [], sourceReads: 0, imports: 0, locates: 0,
    requires: [], removed: [], opened: 0, closed: 0, disposed: 0, sweeps: 0, pdf: PDF, root };
  const env = new Proxy({}, { get(_target, key) {
    state.envReads.push(key);
    assert.ok(!forbidEnv, "此分支不得读取 Android 环境变量");
    assert.equal(key, "KXXY_ENGINE_ROOT", "不得使用 PREFIX/HOME 等替代路径");
    return state.root;
  } });
  const context = vm.createContext({ Buffer, AbortController, AbortSignal, URL, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, structuredClone, process: { platform, env, cwd() { assert.fail("不得从 cwd 猜测字体目录"); } } });
  const stats = (name) => {
    assert.ok(files.has(name), `受控输出文件不存在：${name}`);
    return { size: files.get(name).length, isFile: () => true, isDirectory: () => false };
  };
  const boundaryFs = {
    async mkdtemp(prefix) { const name = `${prefix}${directories.size + state.removed.length + 1}`; directories.add(name); return name; },
    async writeFile(name, bytes, options) {
      options.signal?.throwIfAborted();
      assert.equal(options.flag, "wx");
      assert.equal(options.mode, 0o600);
      assert.ok(directories.has(p.dirname(name)) && !files.has(name));
      files.set(name, Buffer.from(bytes));
    },
    async lstat(name) { return stats(name); },
    async open(name, flags) {
      assert.equal(flags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      stats(name);
      state.opened += 1;
      let cursor = 0, closed = false;
      return {
        async stat() { assert.ok(!closed); return stats(name); },
        async read(target, offset, length, position) {
          assert.ok(!closed);
          assert.equal(position, null);
          const data = files.get(name);
          const count = Math.min(length, data.length - cursor);
          data.copy(target, offset, cursor, cursor + count);
          cursor += count;
          return { bytesRead: count };
        },
        async close() { assert.ok(!closed); closed = true; state.closed += 1; },
      };
    },
    async rm(name, options) {
      assert.ok(directories.has(name), "仅允许清理本次转换的内存 scratch");
      assert.deepEqual(structuredClone(options), { recursive: true, force: true });
      for (const key of files.keys()) if (key.startsWith(name + p.sep)) files.delete(key);
      directories.delete(name);
      state.removed.push(name);
    },
    async readdir(_name, options) { assert.equal(options.withFileTypes, true); state.sweeps += 1; return []; },
    async mkdir() { assert.fail("此 PDF 回归不应进入 OutputStore 写入分支"); },
    async rmdir() { assert.fail("此 PDF 回归不应删除任何宿主目录"); },
  };
  const createConverter = async (options) => {
    state.options.push(options);
    if (state.createError) throw state.createError;
    return {
      async render(request, signal) {
        signal.throwIfAborted();
        assert.ok(files.has(request.inputPath), "必须经过真实转换链写入源文件");
        assert.ok(directories.has(p.dirname(request.outputPath)));
        state.renders.push({ request, input: Buffer.from(files.get(request.inputPath)) });
        files.set(request.outputPath, Buffer.from(state.pdf));
        return { missingFonts: ["受控缺失字体"] };
      },
      async dispose() { state.disposed += 1; },
    };
  };
  class TypertRemoteService { constructor(ctx, name) { this.ctx = ctx; this.remoteName = name; } }
  class RemoteError extends Error { constructor(code, message, data, options) { super(message, options); this.code = code; this.data = data; } }
  function Remote(value) { return typeof value === "string" ? (method) => method : value; }
  const boundaries = new Map([
    ["node:path", p], ["node:crypto", { createHash, randomUUID }], ["node:os", { tmpdir: () => p.join(home, "tmp") }],
    ["node:fs/promises", boundaryFs], ["node:fs", { constants: fs.constants, lstatSync() { assert.fail("不得访问真实引擎文件系统"); } }],
    ["node:module", { createRequire(entry) {
      state.requires.push(entry);
      assert.equal(entry, kitEntry);
      return { resolve: (name) => p.join(home, "kit-install", "node_modules", name) };
    } }],
    ["@deepseek-ai/dsh-home-paths", { dshHomePath: (...parts) => p.join(home, ...parts) }],
    ["@deepseek-ai/dsh-typert-protocol", { Remote, RemoteError, TypertRemoteService }],
    ["@deepseek-ai/libreoffice-kit", { createConverter }],
  ]);
  const modules = new Map();
  const link = (name) => {
    if (modules.has(name)) return modules.get(name);
    let module;
    if (fixture.sources.has(name)) module = new vm.SourceTextModule(fixture.sources.get(name), { context, identifier: name });
    else {
      assert.ok(boundaries.has(name), `未声明的依赖边界：${name}`);
      const exports = boundaries.get(name);
      module = new vm.SyntheticModule(Object.keys(exports), function() {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context, identifier: name });
    }
    modules.set(name, module);
    return module;
  };
  const module = new vm.SourceTextModule(source, {
    context, identifier: fixture.pkg,
    initializeImportMeta(meta) {
      meta.resolve = (name) => { assert.equal(name, "@deepseek-ai/libreoffice-kit"); state.locates += 1; return kitEntry; };
    },
    async importModuleDynamically(name) {
      assert.equal(name, kitEntry);
      state.imports += 1;
      const kit = link("@deepseek-ai/libreoffice-kit");
      if (kit.status === "unlinked") await kit.link(link);
      if (kit.status === "linked") await kit.evaluate();
      return kit;
    },
  });
  await module.link(link);
  await module.evaluate({ timeout: 5000 });
  const metadata = { absolutePath: p.join(home, "workspace", "example.docx"), version: "source-v1", bytes: INPUT.length };
  const workspaceFiles = {
    async readBytes(_scope, _name, range, signal) { signal.throwIfAborted(); assert.deepEqual(structuredClone(range), { range: { offset: 0, length: 1 } }); return metadata; },
    async stat() { return metadata; },
  };
  const sourceFs = {
    async resolve(name, { signal }) { signal.throwIfAborted(); assert.equal(name, metadata.absolutePath); return name; },
    async stat() { return { type: "file", version: metadata.version }; },
    processPath: (name) => name,
    async readBytes(_name, signal, limit) { signal.throwIfAborted(); assert.ok(limit >= INPUT.length); state.sourceReads += 1; return INPUT; },
  };
  const ctx = {
    logger: { warn: (...args) => state.warnings.push(args) },
    effect: (start) => { effects.push(start()); },
    on: (name, callback) => { assert.equal(name, "session/disposed"); assert.equal(typeof callback, "function"); },
    get: (name) => { assert.ok(["workspaceFiles", "fs"].includes(name)); return name === "workspaceFiles" ? workspaceFiles : sourceFs; },
  };
  return {
    state, Config: module.namespace.Config, Office: module.namespace.default, metadata,
    construct(config) { freeze(config); return new module.namespace.default(ctx, config); },
    request(key = "source-1", extension = "docx", bytes = INPUT) {
      return { extension, priority: "foreground", source: { key, version: "v1", bytes: bytes.length,
        async read(signal, limit) { signal.throwIfAborted(); assert.ok(limit >= bytes.length); state.sourceReads += 1; return { bytes, version: "v1" }; } } };
    },
    async dispose() {
      for (const dispose of effects.reverse()) await dispose();
      assert.equal(files.size, 0, "真实 finally 必须清理所有受控输出");
      assert.equal(directories.size, 0);
      assert.equal(state.opened, state.closed, "真实 PDF 读取必须关闭文件句柄");
    },
  };
}

async function convertCase(fixture, source, platform, raw, root = ROOT, forbidEnv = false) {
  const h = await officeModule(fixture, source, platform, root, forbidEnv);
  try {
    const config = h.Config(structuredClone(raw));
    const before = structuredClone(config);
    const instance = h.construct(config);
    const result = await instance.convert(h.request());
    assert.deepEqual(Buffer.from(result.pdf), PDF);
    assert.deepEqual(Array.from(result.missingFonts), ["受控缺失字体"]);
    assert.equal(instance.config, config);
    assert.equal(instance.queue.config, config);
    assert.deepEqual(structuredClone(config), before, "构造器/转换不能回写用户 config");
    assert.equal(h.state.options.length, 1);
    assert.equal(h.state.renders.length, 1);
    assert.equal(h.state.sourceReads, 1);
    assert.equal(h.state.removed.length, 1);
    assert.equal(h.state.imports, Number(fixture.modern));
    assert.equal(h.state.locates, Number(fixture.modern));
    assert.equal(h.state.requires.length, Number(fixture.modern));
    if (fixture.modern) {
      assert.equal(typeof h.state.options[0].resolveEnginePackage, "function");
      assert.match(h.state.options[0].resolveEnginePackage("@deepseek-ai/libreoffice-kit-wasm"), /libreoffice-kit-wasm[/\\]package\.json$/);
      assert.equal(instance.outputDirectory, config.outputDirectory);
    } else assert.equal(h.state.options[0], instance.options);
    if (config.fontDirectories !== undefined) assert.equal(instance.options.fontDirectories, config.fontDirectories, "显式字体数组必须沿用原引用");
    return { options: optionsData(h.state.options[0]), config: before, envReads: [...h.state.envReads],
      methods: Object.fromEntries(Object.getOwnPropertyNames(h.Office.prototype).filter((name) => name !== "constructor").map((name) => [name, h.Office.prototype[name].toString()])) };
  } finally { await h.dispose(); }
}

async function constructError(fixture, source, platform, raw) {
  const h = await officeModule(fixture, source, platform, "relative-root");
  try {
    let stage = "schema";
    try {
      const config = h.Config(structuredClone(raw));
      stage = "constructor";
      h.construct(config);
    } catch (error) {
      assert.equal(h.state.options.length, 0);
      assert.equal(h.state.envReads.length, 0, "无效配置必须保留上游校验顺序，不先报 root 错误");
      return { stage, name: error.name, message: error.message };
    }
    assert.fail("真实上游应拒绝该错误配置");
  } finally { await h.dispose(); }
}

async function yamlReader(fixture) {
  const module = new vm.SourceTextModule(fixture.sources.get("js-yaml"));
  await module.link((name) => { assert.fail(`js-yaml 不应依赖外部模块：${name}`); });
  await module.evaluate({ timeout: 5000 });
  const yaml = module.namespace;
  // 保留 !!js 为普通表达式节点，绝不执行配置中的 JavaScript。
  const schema = yaml.JSON_SCHEMA.extend(new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (data) => ({ __jsExpr: data }) }));
  return (text) => yaml.load(text, { schema });
}
function officeRow(rows, id) {
  const found = [];
  const visit = (entries) => { for (const row of entries) { if (row.id === id) found.push(row); if (row.group && Array.isArray(row.config)) visit(row.config); } };
  visit(rows);
  assert.equal(found.length, 1, `真实配置必须恰有一个 ${id}`);
  return found[0];
}

let fixtures = [], fatal;
try {
  assert.equal(typeof vm.SourceTextModule, "function", "必须使用 --experimental-vm-modules 执行真实 ESM 模块");
  fixtures = [loadFixture(false), loadFixture(true)];
  for (const f of fixtures) {
    console.log(`\n真实输入 ${f.archive}；版本 ${f.version}；依赖 ${JSON.stringify(f.dependencyVersions)}`);
    await test(`${f.version} 全源码、构造字体块及 ASAR/解包 integrity`, () => {
      assert.equal(sha256(f.source), f.digest);
      assert.equal(sha256(section(f.source, "\t\tconstructor(ctx, config) {\n", f.queue)), f.fontDigest);
    });
    await test(`${f.version} 仅在 this.options 后插入一个完整补丁，保留权限及其他文件`, () => {
      const files = model(f);
      const sentinel = files.get(`${NM}unrelated/keep.txt`);
      const { ctx, writes } = countedContext(files);
      patchOfficeDefaultFonts(ctx);
      f.patched = files.get(f.key).data.toString("utf8");
      const start = f.source.indexOf(f.queue);
      const delta = f.patched.length - f.source.length;
      assert.ok(delta > 0);
      f.inject = f.patched.slice(start, start + delta);
      assert.equal(f.patched.slice(0, start) + f.patched.slice(start + delta), f.source);
      assert.equal(f.inject.split(MARKER).length, 2);
      assert.ok(f.inject.includes(FONT_REL) && !f.inject.includes("/system/fonts"));
      assert.equal(files.get(f.key).mode, 0o640);
      assert.equal(files.get(`${NM}unrelated/keep.txt`), sentinel);
      assert.deepEqual(writes, [`${f.pkg}/lib/index.js`]);
      assert.equal(files.size, 2);
    });
    await test(`${f.version} 精确逆变换幂等，多次调用零重复写入`, () => {
      const files = model(f, f.patched);
      const entry = files.get(f.key);
      const { ctx, writes } = countedContext(files);
      for (let i = 0; i < 3; i += 1) assert.match(patchOfficeDefaultFonts(ctx), /逆变换复验通过/);
      assert.deepEqual(writes, []);
      assert.equal(files.get(f.key), entry);
    });
    const faults = [
      ["未知完整源码", () => f.source + "\n"],
      ["构造块漂移", () => replace(f.source, "\t\t\tthis.config = config;", "\t\t\tthis.config = { ...config };")],
      ["真实转换链漂移", () => replace(f.source, f.modern ? "...this.options," : "createConverter(this.options)", f.modern ? "...{}," : "createConverter({})")],
      ["只有伪 marker", () => f.source + `\n/* ${MARKER} */\n`],
      ["marker 被改名", () => replace(f.patched, MARKER, `${MARKER}_BROKEN`)],
      ["缺少注入中的赋值", () => replace(f.patched, '\t\t\t\tthis.options.fontDirectories = [join(kxxyRoot, "lib/node_modules/kxxy-host/fonts")];\n', "")],
      ["改为系统字体", () => replace(f.patched, `join(kxxyRoot, "${FONT_REL}")`, '"/system/fonts"')],
      ["重复完整注入", () => replace(f.patched, f.inject, f.inject + f.inject)],
      ["完整注入被移到文件头", () => f.inject + f.source],
      ["已打补丁的上游内容漂移", () => f.patched + "\n"],
      ["已打补丁改为 CRLF", () => f.patched.replaceAll("\n", "\r\n")],
    ];
    for (const [name, mutate] of faults) await test(`${f.version} 拒绝${name}且不写入`, () => rejectPatch(model(f, mutate())));
    await test(`${f.version} 包存在但入口缺失必须拒绝`, () => rejectPatch(new Map([[`${NM}${f.pkg}/package.json`, { data: Buffer.from("{}"), mode: 0o644 }]])));
    await test(`${f.version} 执行真实 applyAllPatches 接线，随后字体补丁仍可幂等复验`, () => {
      const files = new Map([...model(f), ...f.pipelineFiles]);
      const results = applyAllPatches(files, () => { assert.fail("Office 局部测试不得请求 Termux/build 资源"); });
      assert.ok(results.some((line) => line.includes(f.pkg) && line.includes("Android 缺省字体")));
      f.pipeline = files.get(f.key).data.toString("utf8");
      const { ctx, writes } = countedContext(files);
      patchOfficeDefaultFonts(ctx);
      assert.deepEqual(writes, []);
      if (f.modern) assert.equal(f.pipeline, f.patched);
      else {
        const formatOnly = replace(f.pipeline, f.inject, "");
        assert.equal(sha256(formatOnly), "597215530f11d493126a4ce0b5ef4d8dda394082861ff6f5886f968c258cfd2f");
        const reversedOrder = model(f, formatOnly);
        patchOfficeDefaultFonts(createPatchContext(reversedOrder));
        assert.equal(reversedOrder.get(f.key).data.toString("utf8"), f.pipeline, "与既有旧格式补丁的组合顺序应等价");
      }
    });

    const custom = { timeoutMs: 4321, maxInputBytes: 2048, maxSourceBytes: 8192, maxOutputBytes: 4096,
      maxFontFiles: 128, maxFontFileBytes: 8192, maxLoadedFontBytes: 16384, fontFallbacks: [["用户字体", "用户替代字体"]] };
    for (const [label, raw] of [["缺省字段", {}], ["显式 undefined", { fontDirectories: undefined }], ["保留其他用户配置", custom]]) {
      await test(`${f.version} Android ${label}：真实 constructor→queue→createConverter→render→readPdf`, async () => {
        const original = await convertCase(f, f.source, "android", raw, undefined, true);
        const patched = await convertCase(f, f.patched, "android", raw);
        assert.equal(patched.config.fontDirectories, undefined);
        assert.deepEqual(patched.options, { ...original.options, fontDirectories: [path.posix.join(ROOT, FONT_REL)] });
        assert.deepEqual(patched.config, original.config);
        assert.deepEqual(patched.methods, original.methods, "不得重写任何转换方法来替代真实路径");
        assert.deepEqual(patched.envReads, ["KXXY_ENGINE_ROOT"]);
      });
    }
    for (const platform of ["android", "linux", "darwin", "win32", "freebsd"]) {
      const userFonts = platform === "win32" ? ["C:/Fonts/User", "D:/Fonts/Secondary"] : ["/user/fonts/中文", "/user/fonts/second"];
      const cases = [["显式 []", { ...custom, fontDirectories: [] }], ["显式用户路径", { ...custom, fontDirectories: userFonts }],
        ["null 的真实 schema 语义", { fontDirectories: null }]];
      if (platform !== "android") cases.push(["缺省字段", {}], ["显式 undefined", { fontDirectories: undefined }]);
      for (const [label, raw] of cases) await test(`${f.version} ${platform} ${label}：与未补丁上游相同，禁止读取 root`, async () => {
        const original = await convertCase(f, f.source, platform, raw, undefined, true);
        const patched = await convertCase(f, f.patched, platform, raw, undefined, true);
        assert.deepEqual(patched, original);
      });
    }
    for (const [label, root] of [["缺失", undefined], ["空", ""], ["空白", " "], ["相对路径", "engine"],
      ["点相对路径", "./engine"], ["父相对路径", "../engine"], ["Windows 盘符路径", "C:/engine"],
      ["Windows 根相对路径", "\\engine"], ["NUL 路径", "/engine\0other"], ["数字", 7], ["对象", {}], ["null", null]]) {
      await test(`${f.version} Android ${label} root：缺省字体 fail closed，不启动转换器`, async () => {
        const h = await officeModule(f, f.patched, "android", root);
        try {
          const config = h.Config({});
          const before = structuredClone(config);
          assert.throws(() => h.construct(config), /KXXY_ENGINE_ROOT/);
          assert.deepEqual(structuredClone(config), before);
          assert.equal(h.state.options.length, 0);
          assert.equal(h.state.sourceReads, 0);
          assert.equal(h.state.sweeps, 0);
          assert.deepEqual(h.state.envReads, ["KXXY_ENGINE_ROOT"]);
        } finally { await h.dispose(); }
      });
    }
    for (const root of [ROOT + "/", "/data/用户 空格/engine"]) await test(`${f.version} Android 合法绝对 root ${JSON.stringify(root)} 不被误拒绝`, async () => {
      const result = await convertCase(f, f.patched, "android", {}, root);
      assert.deepEqual(result.options.fontDirectories, [path.posix.join(root, FONT_REL)]);
    });
    const invalid = [["字体字符串", { fontDirectories: "/user/fonts" }], ["字体对象", { fontDirectories: {} }],
      ["字体数字", { fontDirectories: 1 }], ["数组元素错误", { fontDirectories: [1] }], ["空字体路径", { fontDirectories: [""] }],
      ["相对字体路径", { fontDirectories: ["relative/fonts"] }], ["混合绝对/相对路径", { fontDirectories: ["/fonts", "relative"] }],
      ["错误回退表", { fontFallbacks: [["only-one"]] }], ["错误字体上限", { maxFontFiles: 0 }],
      ["错误超时", { timeoutMs: 0 }], ["源容量小于输入上限", { maxSourceBytes: 1, maxInputBytes: 2 }]];
    if (f.modern) invalid.push(["相对输出目录", { outputDirectory: "relative/output" }], ["空输出目录", { outputDirectory: "" }]);
    for (const platform of ["android", "linux"]) for (const [label, raw] of invalid) await test(`${f.version} ${platform} ${label}：真实 schema/constructor 错误与校验顺序不变`, async () => {
      const original = await constructError(f, f.source, platform, raw);
      const patched = await constructError(f, f.patched, platform, raw);
      assert.deepEqual(patched, original);
    });
    await test(`${f.version} 直接调用真实 constructor：已解析的 null 字段不等同 undefined`, async () => {
      const h = await officeModule(f, f.patched, "android", undefined, true);
      try {
        const config = { ...h.Config({}), fontDirectories: null };
        const instance = h.construct(config);
        assert.equal(instance.options.fontDirectories, null);
        assert.equal(config.fontDirectories, null);
        assert.deepEqual(h.state.envReads, []);
      } finally { await h.dispose(); }
    });
    await test(`${f.version} 同一冻结 config 重建服务仅补各自缺省值，不累积、不污染用户配置`, async () => {
      const h = await officeModule(f, f.patched, "android", ROOT);
      try {
        const config = h.Config({});
        delete config.fontDirectories;
        const first = h.construct(config);
        h.state.root = "/data/other-engine";
        const second = h.construct(config);
        await first.convert(h.request("first"));
        await second.convert(h.request("second"));
        assert.equal(Object.hasOwn(config, "fontDirectories"), false);
        assert.deepEqual(Array.from(first.options.fontDirectories), [path.posix.join(ROOT, FONT_REL)]);
        assert.deepEqual(Array.from(second.options.fontDirectories), [path.posix.join(h.state.root, FONT_REL)]);
        assert.notEqual(first.options.fontDirectories, second.options.fontDirectories);
        assert.equal(h.state.options.length, 2);
      } finally { await h.dispose(); }
    });
    await test(`${f.version} 真实 render/renderFile 授权读源、重复队列缓存与转换器复用`, async () => {
      const h = await officeModule(f, f.pipeline, "android", ROOT);
      try {
        const instance = h.construct(h.Config({}));
        const signal = new AbortController().signal;
        const scope = { sessionId: "test-session", workspaceRoot: "/office-test/workspace" };
        for (let i = 0; i < 2; i += 1) {
          const result = await instance.render(scope, h.metadata.absolutePath, "foreground", signal);
          assert.deepEqual(Buffer.from(result.data), PDF);
          assert.equal(result.generation, instance.generation);
        }
        for (const extension of ["xlsx", "pptx"]) await instance.convert(h.request(extension, extension));
        assert.equal(h.state.options.length, 1, "不得每次转换重建或覆盖字体配置");
        assert.equal(h.state.renders.length, 3, "第二次相同源应走真实队列缓存");
        assert.equal(h.state.sourceReads, 3);
        assert.deepEqual(Array.from(h.state.options[0].fontDirectories), [path.posix.join(ROOT, FONT_REL)]);
      } finally { await h.dispose(); }
      assert.equal(h.state.disposed, 1);
    });
    await test(`${f.version} Kit 创建失败保留真实分类/重试逻辑，不回退其他字体目录`, async () => {
      const h = await officeModule(f, f.patched, "android", ROOT);
      try {
        const instance = h.construct(h.Config({}));
        h.state.createError = Object.assign(new Error("受控 Kit 创建失败"), { code: "unavailable" });
        await assert.rejects(instance.convert(h.request("failed")), (error) => error.code === "unavailable");
        h.state.createError = undefined;
        await instance.convert(h.request("retry"));
        assert.equal(h.state.options.length, 2);
        assert.deepEqual(optionsData(h.state.options[0]), optionsData(h.state.options[1]));
        assert.deepEqual(Array.from(h.state.options[1].fontDirectories), [path.posix.join(ROOT, FONT_REL)]);
      } finally { await h.dispose(); }
    });
    await test(`${f.version} 截断 PDF 由真实 readPdf 拒绝且清理 scratch`, async () => {
      const h = await officeModule(f, f.patched, "android", ROOT);
      try {
        h.state.pdf = Buffer.from("%PDF-1.7\n没有结束标记");
        const instance = h.construct(h.Config({}));
        await assert.rejects(instance.convert(h.request()), (error) => error.code === "invalid-output");
        assert.equal(h.state.opened, 1);
        assert.equal(h.state.closed, 1);
        assert.equal(h.state.removed.length, 1);
      } finally { await h.dispose(); }
    });

    const parse = await yamlReader(f);
    const name = f.modern ? "applyPatches" : "applyEntryPatches";
    const body = section(f.boot, `function ${name}(data, patches, warn) {`, "\n}\n") + "\n}";
    const apply = new vm.Script(`(${body})`).runInNewContext({ structuredClone }, { timeout: 5000 });
    const baseWarnings = [];
    const official = apply([], [...parse(f.baseYaml), ...parse(f.webYaml)], (...args) => baseWarnings.push(args));
    const kotlin = fs.readFileSync(path.join(project, sourceNames[1]), "utf8");
    const template = section(kotlin, '    fun overlayContent(ctx: Context): String = """\n', '    """.trimIndent() + "\\n"')
      .split("\n").slice(1).map((line) => line.replace(/^ {8}/, "")).join("\n").trim();
    const rendered = template.replaceAll("${'$'}", "$").replace("${workspaces(ctx).apply { mkdirs() }.absolutePath}", "/office-test/workspace");
    assert.ok(!rendered.includes("${"), "Kotlin overlay 新增了未受控的插值，须更新回归夹具");
    const overlay = parse(rendered);
    await test(`${f.version} 真实官方 row/加载器与当前 overlay：无 Office 覆盖或旧 id 告警`, () => {
      assert.deepEqual(baseWarnings, []);
      const row = officeRow(official, f.id);
      assert.equal(row.name, f.pkg);
      if (f.modern) assert.deepEqual(structuredClone(row.config.outputDirectory), { __jsExpr: "dshHomePath('office-kit', 'outputs')" });
      assert.ok(overlay.every((entry) => !["office-to-pdf", "office-kit"].includes(entry.id)));
      const warnings = [];
      const output = apply(official, overlay, (...args) => warnings.push(args));
      assert.deepEqual(warnings, []);
      assert.deepEqual(structuredClone(officeRow(output, f.id)), structuredClone(row));
    });
    await test(`${f.version} 真实加载器对不存在 id 告警跳过，对命中 config 整体替换`, () => {
      const warnings = [];
      const missing = f.modern ? "office-to-pdf" : "office-kit";
      const output = apply(official, [{ id: missing, config: { fontDirectories: ["/forced"] } }], (...args) => warnings.push(args));
      assert.deepEqual(warnings, [["patch: entry %C not found", missing]]);
      assert.deepEqual(structuredClone(officeRow(output, f.id)), structuredClone(officeRow(official, f.id)));
      const configured = apply(official, [{ id: f.id, config: { outputDirectory: "/user/output", timeoutMs: 9876, fontDirectories: [] } }], assert.fail);
      const overridden = apply(configured, [{ id: f.id, config: { fontDirectories: ["/forced"] } }], assert.fail);
      assert.deepEqual(structuredClone(officeRow(overridden, f.id).config), { fontDirectories: ["/forced"] });
    });
    for (const fonts of [[], ["/user/fonts"]]) await test(`${f.version} 真实加载器重复应用当前 overlay 仍保留用户 ${JSON.stringify(fonts)} 及全部其他 config`, () => {
      const config = { outputDirectory: "/user/output", timeoutMs: 9876, fontDirectories: fonts };
      const user = apply(official, [{ id: f.id, config }], assert.fail);
      const before = structuredClone(user);
      const first = apply(user, overlay, assert.fail);
      const again = apply(first, overlay, assert.fail);
      assert.deepEqual(structuredClone(officeRow(first, f.id).config), config);
      assert.deepEqual(structuredClone(officeRow(again, f.id).config), config);
      assert.deepEqual(structuredClone(user), before, "真实加载器不能回写输入用户配置");
    });
  }

  await test("缺少两个 Office 包时不注入任何内容", () => {
    const files = new Map();
    const { ctx, writes } = countedContext(files);
    assert.match(patchOfficeDefaultFonts(ctx), /跳过/);
    assert.deepEqual(writes, []);
    assert.equal(files.size, 0);
  });
  await test("新旧 Office 包并存时各写一次，二次调用各自精确复验", () => {
    const files = new Map(fixtures.map((f) => [f.key, { data: Buffer.from(f.source), mode: 0o644 }]));
    const { ctx, writes } = countedContext(files);
    patchOfficeDefaultFonts(ctx);
    assert.equal(writes.length, 2);
    for (const f of fixtures) assert.equal(files.get(f.key).data.toString("utf8"), f.patched);
    patchOfficeDefaultFonts(ctx);
    assert.equal(writes.length, 2);
  });
  for (const broken of fixtures) for (const already of [false, true]) await test(`${broken.version} 漂移时，另一版本${already ? "已打补丁" : "未打补丁"}也不得留下半份写入`, () => {
    const files = new Map(fixtures.map((f) => [f.key, { data: Buffer.from(f === broken ? f.source + "\n" : already ? f.patched : f.source), mode: 0o644 }]));
    rejectPatch(files);
  });
  await test("两个包并存但旧版入口丢失时，新版也不得先写入", () => {
    const files = model(fixtures[1]);
    files.set(`${NM}${fixtures[0].pkg}/package.json`, { data: Buffer.from("{}"), mode: 0o644 });
    rejectPatch(files);
  });
  await test("沿用真实 officeFontsDir 和现有 KXXY_ENGINE_ROOT，不修改其余字体/环境逻辑", () => {
    const kotlin = fs.readFileSync(path.join(project, sourceNames[1]), "utf8");
    assert.ok(kotlin.includes('fun officeFontsDir(ctx: Context): File =\n        File(engineRoot(ctx), "lib/node_modules/kxxy-host/fonts")'));
    assert.ok(kotlin.includes('"KXXY_ENGINE_ROOT=${root.absolutePath}"'));
  });
  await test("回归结束后生产源码、真实 ASAR/解包输入摘要保持不变", () => {
    for (const name of sourceNames) assert.equal(sha256(fs.readFileSync(path.join(project, name))), sourceHashes[name], name);
    for (const f of fixtures) assert.deepEqual(loadFixture(f.modern).hashes, f.hashes);
  });
} catch (error) {
  fatal = error.stack ?? String(error);
  console.error(`回归前置条件或夹具失败：${fatal}`);
}
const totals = suite.finish();
const result = { ...totals, failed: totals.failed + Number(Boolean(fatal)), skipped: 0, fatal,
  node: process.version, executable: process.execPath, evidence, sourceHashes,
  fixtures: fixtures.map(({ archive, version, digest, fontDigest, dependencyVersions, hashes }) => ({ archive, version, digest, fontDigest, dependencyVersions, hashes })),
  androidDeviceConversionTested: false, runtimeOrApkBuilt: false };
const resultPath = path.join(evidence, "result.json");
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(`结果 ${resultPath}；${result.passed} 通过 / ${result.failed} 失败 / 0 跳过；Android 真机转换未测`);
if (result.failed) process.exitCode = 1;
