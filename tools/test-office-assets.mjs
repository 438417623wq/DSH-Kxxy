// 仅执行 Office 局部回归：真实 ASAR/旧 runtime 只读，不生成最终 runtime 或 APK。
// 用法：JSON_JAR=<已有 org.json jar> [OFFICE_TEST_PARENT=<日志父目录>] node tools/test-office-assets.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { untarGz } from "./lib/targz.mjs";
import { openIndexedZip } from "./lib/zipedit.mjs";
import {
  ensureOfficeWasm, officeMapReader, officeDirectoryReader, verifyOfficeAssets, verifyOfficeFonts,
  OFFICE_KIT_ROOT, OFFICE_WASM_ROOT, OFFICE_LAYER_MARKER, OFFICE_LAYER_MARKER_FILE,
  OFFICE_RELEASES, OFFICE_FONT_FILES,
} from "./lib/office-assets.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parent = process.env.OFFICE_TEST_PARENT ?? path.join(project, ".cache");
assert.ok(fs.lstatSync(parent).isDirectory() && !fs.lstatSync(parent).isSymbolicLink(), "测试父目录必须是已有普通目录");
const temp = fs.mkdtempSync(path.join(parent, "test-office-"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = ["tools/lib/office-assets.mjs", "tools/build-runtime.mjs", "tools/verify-runtime.mjs",
  "tools/simulate-install.mjs", "android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt",
  "android/app/src/main/java/app/kxxy/engine/RuntimeInstallIo.kt", "tools/test-office-assets.mjs"];
const sourceHashes = Object.fromEntries(sources.map((name) => [name, sha256(fs.readFileSync(path.join(project, name)))]));
let passed = 0;
async function test(label, run) {
  await run();
  passed += 1;
  console.log(`通过 ${passed}：${label}`);
}
function section(text, begin, end) {
  assert.equal(text.split(begin).length, 2, `源码起始锚点必须唯一：${begin}`);
  const start = text.indexOf(begin);
  const stop = text.indexOf(end, start + begin.length);
  assert.ok(stop > start, `源码结束锚点缺失：${end}`);
  return text.slice(start, stop);
}
function readAt(fd, offset, size) {
  const bytes = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const count = fs.readSync(fd, bytes, got, size - got, offset + got);
    assert.ok(count > 0, `只读输入被截断：${offset} + ${size}`);
    got += count;
  }
  return bytes;
}
// 只读 Office 所需 ASAR 区间，避免把 781 MiB 新 ASAR 整份常驻内存。
function officeAsar(filename) {
  const fd = fs.openSync(filename, "r");
  const head = readAt(fd, 0, 16);
  const length = head.readUInt32LE(12);
  assert.ok(length > 0 && length <= 64 * 1024 * 1024 && length + 16 <= fs.fstatSync(fd).size);
  const header = JSON.parse(readAt(fd, 16, length));
  const base = 16 + Math.ceil(length / 4) * 4;
  const node = (name) => name.split("/").reduce((entry, part) => entry?.files?.[part], header);
  return {
    node,
    read(name) {
      const entry = node(name);
      assert.ok(entry && !entry.files && !entry.link, `ASAR 普通文件缺失：${name}`);
      const data = entry.unpacked ? fs.readFileSync(path.join(`${filename}.unpacked`, name))
        : readAt(fd, base + Number(entry.offset), Number(entry.size));
      assert.equal(data.length, entry.size, `ASAR 资源长度不符：${name}`);
      if (entry.integrity) {
        assert.equal(entry.integrity.algorithm, "SHA256");
        assert.equal(sha256(data), entry.integrity.hash, `ASAR integrity 不符：${name}`);
      }
      return data;
    },
    close: () => fs.closeSync(fd),
  };
}
function asarKit(asar) {
  return new Map(["package.json", "lib/index.js"].map((name) => [OFFICE_KIT_ROOT + name,
    { data: asar.read(`dsh/node_modules/@deepseek-ai/libreoffice-kit/${name}`), mode: 0o644 }]));
}
const buildSource = fs.readFileSync(path.join(project, "tools/build-runtime.mjs"), "utf8");
const installerSource = fs.readFileSync(path.join(project, sources[4]), "utf8");
const verifierSource = fs.readFileSync(path.join(project, "tools/verify-runtime.mjs"), "utf8");
const simulatorSource = fs.readFileSync(path.join(project, "tools/simulate-install.mjs"), "utf8");
const specs = new Function("OFFICE_LAYER_MARKER", `${section(buildSource,
  "const LEGACY_WASM_PKG =", "/**\n * 构建期补丁集版本标记")}\nreturn { LEGACY_WASM_PKG, WASM_0_2_3_PKG, PINNED_WASM_PKGS, FONT_PKG, OFFICE_FONTS_MARKER, OFFICE_FONTS_MARKER_FILE };`)(OFFICE_LAYER_MARKER);
function cachedTar(spec) {
  const data = fs.readFileSync(path.join(project, ".cache/office", spec.file));
  assert.equal(sha256(data), spec.sha256, `固定 tarball 摘要不符：${spec.file}`);
  return untarGz(data);
}
const legacyTar = cachedTar(specs.LEGACY_WASM_PKG);
const pinnedTars = new Map([[specs.LEGACY_WASM_PKG.version, legacyTar], [specs.WASM_0_2_3_PKG.version, cachedTar(specs.WASM_0_2_3_PKG)]]);
const fontTar = cachedTar(specs.FONT_PKG).filter((entry) => specs.FONT_PKG.pick.some(([name]) => name === entry.path))
  .map((entry) => ({ ...entry, data: Buffer.from(entry.data) }));
const bundleBody = section(buildSource, "async function bundleOfficeAssets(asarPart) {", "\n\n/**\n * 把第三方移动端");
const silent = { log() {} };
function bundle(loads) {
  const names = ["ensureOfficeWasm", "officeMapReader", "verifyOfficeFonts", "OFFICE_WASM_ROOT",
    "PINNED_WASM_PKGS", "FONT_PKG", "OFFICE_FONTS_MARKER", "OFFICE_FONTS_MARKER_FILE", "fetchTgz", "human", "console"];
  return new Function(...names, `return (${bundleBody});`)(ensureOfficeWasm, officeMapReader, verifyOfficeFonts,
    OFFICE_WASM_ROOT, specs.PINNED_WASM_PKGS, specs.FONT_PKG, specs.OFFICE_FONTS_MARKER, specs.OFFICE_FONTS_MARKER_FILE,
    async (pkg) => { loads.push(pkg.file); return pkg === specs.FONT_PKG ? fontTar : pinnedTars.get(pkg.version); }, String, silent);
}
const verifyBody = section(verifierSource, "// ---------------------------------------------------------------- Office 完整资产合同",
  "// ---------------------------------------------------------------- 补丁集版本标记");
const verifyBlock = new Function("entries", "readLocal", "verifyOfficeAssets", "OFFICE_LAYER_MARKER", "readFileSync", "join", "HERE", "console",
  `let missing = 0; const byName = new Map(entries.map(entry => [entry.name, entry]));\n${verifyBody}\nreturn missing;`);
function checkArchiveEntries(entries, read) {
  return verifyBlock(entries, read, verifyOfficeAssets, OFFICE_LAYER_MARKER, fs.readFileSync, path.join,
    path.join(project, "tools"), silent) === 0;
}
function archiveEntries(model) {
  return [...model].map(([name, entry]) => ({ name, data: entry.data,
    comment: entry.comment ?? (entry.target ? `LINK:${entry.target}` : ""), usize: entry.data?.length ?? 0,
    externalAttr: ((entry.mode ?? 0o100644) << 16) >>> 0 }));
}
function checkArchiveMap(model) { return checkArchiveEntries(archiveEntries(model), (entry) => entry.data); }
const simulateBody = section(simulatorSource, "{\n  // 锚点 9：与 Kotlin 相同的轻量合同", "\n{\n  // 锚点 10 的第二段判定");
const simulateBlock = new Function("target", "officeDirectoryReader", "verifyOfficeAssets", "OFFICE_LAYER_MARKER", "ok", "fail", simulateBody);
function checkInstalled(root) {
  let ok = 0, failed = 0;
  simulateBlock(root, officeDirectoryReader, verifyOfficeAssets, OFFICE_LAYER_MARKER, () => { ok += 1; }, () => { failed += 1; });
  assert.equal(ok + failed, 1, "Office 模拟安装段必须给出唯一结果");
  return ok === 1;
}
function accepts(model, full) {
  try { verifyOfficeAssets(officeMapReader(model), { full, runtime: true }); return true; }
  catch { return false; }
}

console.log(`Node ${process.version}；Office 局部测试目录 ${temp}`);
console.log(`源码摘要 ${JSON.stringify(sourceHashes)}`);
const oldAsar = officeAsar(path.join(project, ".cache/app.asar"));
const newAsar = officeAsar(path.join(project, ".cache/dsh-upstream-0.2.2-rc.2-dedup.asar"));
const models = {};
try {
  await test("真实旧 ASAR 是 kit 0.1.5，且没有 wasm 包", () => {
    models["0.1.5"] = asarKit(oldAsar);
    assert.equal(JSON.parse(models["0.1.5"].get(`${OFFICE_KIT_ROOT}package.json`).data).version, "0.1.5");
    assert.equal(oldAsar.node("dsh/node_modules/@deepseek-ai/libreoffice-kit-wasm"), undefined);
    assert.equal(sha256(models["0.1.5"].get(`${OFFICE_KIT_ROOT}lib/index.js`).data), "5583ce1754084cb63be913e67821282f484a14b43744f777fd10731af67e3c60");
  });
  await test("真实新 ASAR 与解包目录的 kit/wasm 0.2.3 逐文件一致", () => {
    const model = models["0.2.3"] = asarKit(newAsar);
    const prefix = "dsh/node_modules/@deepseek-ai/libreoffice-kit-wasm/";
    const manifest = JSON.parse(newAsar.read(prefix + "prebuilds.json"));
    for (const name of ["package.json", "prebuilds.json", ...Object.keys(manifest.files)]) {
      model.set(OFFICE_WASM_ROOT + name, { data: newAsar.read(prefix + name), mode: 0o644 });
    }
    const extracted = path.join(project, ".cache/dsh-upstream-0.2.2-rc.2-dedup/node_modules");
    for (const [name, entry] of model) assert.equal(sha256(entry.data), sha256(fs.readFileSync(path.join(extracted, name.slice("lib/node_modules/".length)))), name);
    assert.equal(verifyOfficeAssets(officeMapReader(model)).version, "0.2.3");
  });
  await test("新版 fontDirectories 调用块的源码/锚点摘要保持精确", () => {
    const data = newAsar.read("dsh/node_modules/@deepseek-ai/dsh-office-kit/lib/index.js");
    assert.equal(sha256(data), "88f0697ec0507ba25732f3a359ddca277e1890f215fbe1babf7b98f6c4c40e97");
    const block = section(data.toString("utf8"), "\t\tconstructor(ctx, config) {\n",
      "\t\t\tthis.queue = new ConversionQueue(config, this.generation, (bytes, request, signal) => this.runOperation(bytes, request, signal));");
    assert.equal(sha256(block), "04f8bac43c0ced64a478059435ab8b9ceedeacd6b11790bfd70a97c7fffb2278");
  });
} finally { oldAsar.close(); newAsar.close(); }
for (const version of Object.keys(models)) {
  await test(`${version} 执行真实 build Office 函数：选择正确引擎、保留已有条目`, async () => {
    const model = models[version];
    const before = new Map(model);
    const sentinel = { data: Buffer.from("非 Office 内容不得改写"), mode: 0o644 };
    model.set("lib/node_modules/unrelated/keep.txt", sentinel);
    const loads = [];
    const result = await bundle(loads)(model);
    assert.deepEqual(loads, version === "0.1.5" ? [specs.LEGACY_WASM_PKG.file, specs.FONT_PKG.file] : [specs.FONT_PKG.file]);
    assert.equal(result.fontCount, 2);
    assert.equal(result.wasmCount === 0, version === "0.2.3");
    for (const [name, entry] of before) assert.equal(model.get(name), entry, `不能覆盖已有条目：${name}`);
    assert.equal(model.get("lib/node_modules/unrelated/keep.txt"), sentinel);
    const resultOffice = verifyOfficeAssets(officeMapReader(model), { full: true, runtime: true });
    assert.equal(resultOffice.version, version);
    assert.equal(resultOffice.files.length, version === "0.1.5" ? 47 : 48);
    assert.ok(checkArchiveMap(model), "真实 verify Office 段必须通过");
  });
}

await test("旧已发布 runtime 0.9.43 的完整 Office 资源/字体有效，但旧标记不能冒充 @3", () => {
  const archive = openIndexedZip(path.join(project, ".cache/runtime-0.9.43/runtime.zip"));
  try {
    const names = new Set([`${OFFICE_KIT_ROOT}package.json`, `${OFFICE_KIT_ROOT}lib/index.js`, OFFICE_LAYER_MARKER_FILE,
      ...OFFICE_FONT_FILES.map((font) => font.path)]);
    const model = new Map(archive.entries.filter((entry) => names.has(entry.name) || entry.name.startsWith(OFFICE_WASM_ROOT))
      .map((entry) => [entry.name, { data: archive.read(entry.name), mode: entry.mode, comment: entry.comment }]));
    const office = verifyOfficeAssets(officeMapReader(model));
    assert.equal(office.version, "0.1.5");
    verifyOfficeFonts(officeMapReader(model));
    assert.equal(model.get(OFFICE_LAYER_MARKER_FILE).data.toString("utf8").trim(), "kxxy-office@2");
    assert.equal(accepts(model, true), false);
    const entries = archive.entries.map((entry) => ({ ...entry, usize: entry.size, externalAttr: (entry.mode << 16) >>> 0 }));
    assert.equal(checkArchiveEntries(entries, (entry) => archive.read(entry.name)), false);
    const updatedMarker = Buffer.from(`${OFFICE_LAYER_MARKER}\n`);
    const stampedEntries = entries.map((entry) => entry.name === OFFICE_LAYER_MARKER_FILE ? { ...entry, usize: updatedMarker.length } : entry);
    assert.ok(checkArchiveEntries(stampedEntries, (entry) => entry.name === OFFICE_LAYER_MARKER_FILE ? updatedMarker : archive.read(entry.name)),
      "只在只读视图替换标记后，旧版完整资源应通过新的 Office 归档合同");
    console.log(`旧 runtime：${archive.size} B；kit/wasm ${office.version}；${office.files.length} 项资源全哈希通过；未修改归档`);
  } finally { archive.close(); }
});

const cases = [];
function fault(version, label, changes, extra = {}) {
  cases.push({ version, label: `${version} ${label}`, changes, expectFull: false, expectLight: false, disk: true, ...extra });
}
function bytesChange(name, bytes) { return { path: name, kind: "bytes", base64: Buffer.from(bytes).toString("base64") }; }
function jsonFault(version, label, name, mutate) {
  const object = JSON.parse(models[version].get(name).data);
  mutate(object);
  fault(version, label, [bytesChange(name, JSON.stringify(object))]);
}
for (const version of Object.keys(models)) {
  const model = models[version];
  const manifestPath = `${OFFICE_WASM_ROOT}prebuilds.json`;
  const manifest = JSON.parse(model.get(manifestPath).data);
  const all = [...Object.keys(manifest.files).map((name) => OFFICE_WASM_ROOT + name), manifestPath,
    `${OFFICE_WASM_ROOT}package.json`, `${OFFICE_KIT_ROOT}package.json`, `${OFFICE_KIT_ROOT}lib/index.js`,
    OFFICE_LAYER_MARKER_FILE, ...OFFICE_FONT_FILES.map((font) => font.path)];
  for (const name of all) {
    fault(version, `缺失 ${name}`, [{ path: name, kind: "missing" }]);
    // kit JS 的正文由构建校验版本常量，启动侧不宣称能判定任意源码截断。
    if (name !== `${OFFICE_KIT_ROOT}lib/index.js`) {
      const length = model.get(name).data.length;
      const isMetadata = name === manifestPath || name.endsWith("/package.json") || name === OFFICE_LAYER_MARKER_FILE;
      fault(version, `截断 ${name}`, [{ path: name, kind: "truncate", length: isMetadata ? Math.floor(length / 2) : length - 1 }]);
    }
  }
  for (const data of ["", "{", "null", "[]", "{}"])
    fault(version, `非法 manifest JSON ${JSON.stringify(data)}`, [bytesChange(manifestPath, data)]);
  fault(version, "过大 manifest", [bytesChange(manifestPath, " ".repeat(65537))]);
  jsonFault(version, "manifest 版本错误", manifestPath, (m) => { m.version = "0.0.0"; });
  jsonFault(version, "manifest 状态错误", manifestPath, (m) => { m.status = "pending"; });
  jsonFault(version, "manifest 平台错误", manifestPath, (m) => { m.platform = "win32-x64"; });
  jsonFault(version, "manifest schema 错误", manifestPath, (m) => { m.schemaVersion = 2; });
  jsonFault(version, "引擎四项路径重复", manifestPath, (m) => { m.engine.metadata = m.engine.loader; });
  jsonFault(version, "引擎路径与 files 不匹配", manifestPath, (m) => { m.engine.wasm = "assets/other.wasm"; });
  jsonFault(version, "资源摘要格式错误", manifestPath, (m) => { m.files[m.engine.data] = "bad"; });
  jsonFault(version, "源码清单被裁剪", manifestPath, (m) => { delete m.files[m.source.files[0]]; m.source.files.shift(); });
  jsonFault(version, "许可证清单被裁剪", manifestPath, (m) => { delete m.files[m.licenses[0].path]; m.licenses.shift(); });
  for (const illegal of ["../escape.wasm", "/assets/x", "assets\\x", "C:/assets/x", "assets//x", "assets/./x", "assets/../x", "", "assets/x\u0000"]) {
    jsonFault(version, `非法 manifest 路径 ${JSON.stringify(illegal)}`, manifestPath, (m) => { m.engine.wasm = illegal; m.files[illegal] = "a".repeat(64); });
  }
  for (const [name, mutate, label] of [
    [`${OFFICE_KIT_ROOT}package.json`, (p) => { p.version = "0.2.4"; }, "不支持的 kit 版本"],
    [`${OFFICE_KIT_ROOT}package.json`, (p) => { p.optionalDependencies["@deepseek-ai/libreoffice-kit-wasm"] = `^${version}`; }, "kit 依赖不是精确版本"],
    [`${OFFICE_KIT_ROOT}package.json`, (p) => { p.exports["."].default = "../other.js"; }, "kit 导出逃逸"],
    [`${OFFICE_KIT_ROOT}package.json`, (p) => { p.exports["."].node = "./other.js"; }, "kit 条件导出遮蔽"],
    [`${OFFICE_WASM_ROOT}package.json`, (p) => { p.version = version === "0.1.5" ? "0.2.3" : "0.1.5"; }, "kit/wasm 版本混用"],
    [`${OFFICE_WASM_ROOT}package.json`, (p) => { p.name = "other"; }, "wasm 包名称错误"],
    [`${OFFICE_WASM_ROOT}package.json`, (p) => { p.exports["./prebuilds.json"] = "../old/prebuilds.json"; }, "manifest 导出逃逸"],
  ]) jsonFault(version, label, name, mutate);
  for (const name of [`${OFFICE_WASM_ROOT}package.json`, `${OFFICE_KIT_ROOT}package.json`, OFFICE_WASM_ROOT + manifest.engine.data]) {
    fault(version, `目录冒充资源 ${name}`, [{ path: name, kind: "directory" }]);
    fault(version, `LINK 冒充资源 ${name}`, [{ path: name, kind: "link" }], { disk: false });
  }
  fault(version, "WASM 文件头损坏", [{ path: OFFICE_WASM_ROOT + manifest.engine.wasm, kind: "flip", offset: 0 }]);
  fault(version, "等长 metadata 损坏只能由构建全哈希识别", [{ path: OFFICE_WASM_ROOT + manifest.engine.metadata, kind: "flip", offset: 100 }], { expectLight: true });
  fault(version, "字体文件头损坏", [{ path: OFFICE_FONT_FILES[0].path, kind: "flip", offset: 0 }]);
  fault(version, "等长字体正文损坏只能由构建全哈希识别", [{ path: OFFICE_FONT_FILES[1].path, kind: "flip", offset: 100 }], { expectLight: true });
  fault(version, "标记只包含目标字符串仍须拒绝", [bytesChange(OFFICE_LAYER_MARKER_FILE, `old-${OFFICE_LAYER_MARKER}-bad\n`)]);
  fault(version, "旧 Office 标记不能通过", [bytesChange(OFFICE_LAYER_MARKER_FILE, "kxxy-office@2\n")]);
  fault(version, "package 父路径为普通文件", [bytesChange(OFFICE_WASM_ROOT.slice(0, -1), "不是目录")]);
  fault(version, "package 父路径为 LINK", [{ path: OFFICE_WASM_ROOT.slice(0, -1), kind: "link" }], { disk: false });
  for (const name of [`${OFFICE_KIT_ROOT}node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json`,
    `lib/node_modules/@deepseek-ai/${version === "0.1.5" ? "dsh-office-to-pdf" : "dsh-office-kit"}/lib/node_modules/@deepseek-ai/libreoffice-kit/package.json`]) {
    fault(version, "较近嵌套包不得被顶层正例掩盖", [bytesChange(name, "{}")]);
  }
}
fault("0.2.3", "新资源缺失时即使旧 soffice.wasm 完整存在也不得回退", [
  { path: `${OFFICE_WASM_ROOT}assets/dsoffice.wasm`, kind: "missing" },
  { path: `${OFFICE_WASM_ROOT}assets/soffice.wasm`, kind: "legacy" },
]);
function changedModel(item) {
  const model = new Map(models[item.version]);
  for (const change of item.changes) {
    const original = model.get(change.path);
    if (change.kind === "missing") { model.delete(change.path); continue; }
    let entry;
    if (change.kind === "bytes") entry = { data: Buffer.from(change.base64, "base64"), mode: 0o644 };
    if (change.kind === "truncate") entry = { ...original, data: original.data.subarray(0, change.length) };
    if (change.kind === "directory") entry = { data: Buffer.alloc(0), type: "5", mode: 0o040755 };
    if (change.kind === "link") entry = { data: original?.data ?? Buffer.alloc(0), target: "old/cache", mode: 0o120777 };
    if (change.kind === "legacy") entry = models["0.1.5"].get(`${OFFICE_WASM_ROOT}assets/soffice.wasm`);
    if (change.kind === "flip") { entry = { ...original, data: Buffer.from(original.data) }; entry.data[change.offset] ^= 0x80; }
    assert.ok(entry, `未知故障类型：${change.kind}`);
    model.set(change.path, entry);
  }
  return model;
}
for (const item of cases) await test(`Map/归档：${item.label}`, () => {
  const model = changedModel(item);
  assert.equal(accepts(model, false), item.expectLight, "Map 轻量判据不符");
  assert.equal(accepts(model, true), item.expectFull, "Map 全哈希判据不符");
  assert.equal(checkArchiveMap(model), item.expectFull, "真实 verify Office 段判据不符");
});
await test("归档 Office 段拒绝重复条目与 DOS 目录伪装", () => {
  const entries = archiveEntries(models["0.2.3"]);
  const pkg = entries.find((entry) => entry.name === `${OFFICE_WASM_ROOT}package.json`);
  assert.equal(checkArchiveEntries([...entries, pkg], (entry) => entry.data), false);
  assert.equal(checkArchiveEntries(entries.map((entry) => entry === pkg ? { ...entry, externalAttr: 0x10 } : entry), (entry) => entry.data), false);
});
for (const version of Object.keys(models)) {
  // 旧 kit + 整包缺席是允许注入的正例，已由真实 build 函数覆盖，不注册为空跑负例。
  for (const incomplete of (version === "0.1.5" ? ["partial", "wrong"] : ["missing", "partial", "wrong"])) await test(`${version} ${incomplete} 不触发旧文件补齐或部分写入`, async () => {
    const model = new Map([...models[version]].filter(([name]) => !name.startsWith(OFFICE_WASM_ROOT)));
    if (incomplete === "partial") model.set(`${OFFICE_WASM_ROOT}README.md`, { data: Buffer.from("半包"), mode: 0o644 });
    if (incomplete === "wrong") model.set(`${OFFICE_WASM_ROOT}package.json`, { data: Buffer.from("{}"), mode: 0o644 });
    const before = [...model];
    let loads = 0;
    await assert.rejects(ensureOfficeWasm(model, async () => { loads += 1; return legacyTar; }));
    // 0.2.3「整包缺席」现在会先去取**已钉住**的那份 tarball 再全量核验（这里故意喂
    // 0.1.5 的内容，所以必然拒绝）；其余三种情况在 present 或版本检查处就停下，
    // 一次下载都不该发生。
    assert.equal(loads, version === "0.2.3" && incomplete === "missing" ? 1 : 0);
    assert.deepEqual([...model], before);
  });
}
for (const [label, tar] of [
  ["tar 根逃逸", [{ path: "other/package.json", type: "0", data: Buffer.from("{}") }]],
  ["tar 目录逃逸", [{ path: "package/../", type: "5", data: Buffer.alloc(0) }]],
  ["tar 文件逃逸", [{ path: "package/assets/../../outside", type: "0", data: Buffer.from("x") }]],
  ["tar LINK", [{ path: "package/prebuilds.json", type: "2", data: Buffer.from("x") }]],
  ["tar 重复文件", [...legacyTar, legacyTar.find((entry) => entry.path === "package/package.json")]],
  ["tar 缺少清单", legacyTar.filter((entry) => entry.path !== "package/prebuilds.json")],
]) await test(`${label} 拒绝且不提交 staged 文件`, async () => {
  const model = new Map([...models["0.1.5"]].filter(([name]) => !name.startsWith(OFFICE_WASM_ROOT)));
  const before = [...model];
  await assert.rejects(ensureOfficeWasm(model, async () => tar));
  assert.deepEqual([...model], before);
});

const roots = {};
for (const [version, model] of Object.entries(models)) {
  const root = roots[version] = path.join(temp, version);
  fs.mkdirSync(root);
  for (const [name, entry] of model) {
    const dest = path.join(root, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.data, { flag: "wx" });
  }
  await test(`${version} 真实磁盘正例与轻量读取预算`, () => {
    const reader = officeDirectoryReader(root), reads = [];
    const office = verifyOfficeAssets({ ...reader, read(name, limit) {
      assert.ok(limit <= 65536, `探针不得请求大文件：${name} ${limit}`);
      const bytes = reader.read(name, limit);
      reads.push({ name, bytes: bytes.length });
      return bytes;
    } }, { full: false, runtime: true });
    const total = reads.reduce((sum, item) => sum + item.bytes, 0);
    assert.equal(office.version, version);
    assert.ok(total > 0 && total < 200 * 1024);
    assert.equal(reads.find((read) => read.name.endsWith(".wasm"))?.bytes, 8);
    assert.ok(reads.filter((read) => read.name.endsWith(".ttf")).every((read) => read.bytes === 4));
    assert.ok(checkInstalled(root), "真实 simulate Office 段必须通过");
    console.log(`Node 探针 ${version}：读取 ${total} B；${JSON.stringify(reads)}`);
  });
}
const artifacts = path.join(temp, "fault-artifacts");
fs.mkdirSync(artifacts);
let mutationId = 0;
function mutateDisk(root, change) {
  const dest = path.join(root, change.path);
  let scope = dest;
  while (path.dirname(scope) !== root && !fs.existsSync(path.dirname(scope))) scope = path.dirname(scope);
  const backup = path.join(artifacts, `${++mutationId}-original`);
  const existed = fs.lstatSync(scope, { throwIfNoEntry: false }) !== undefined;
  if (existed) fs.renameSync(scope, backup);
  const restore = () => {
    if (fs.lstatSync(scope, { throwIfNoEntry: false })) fs.renameSync(scope, `${backup}-fault`);
    if (existed) fs.renameSync(backup, scope);
  };
  try {
    if (change.kind !== "missing") fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (change.kind === "bytes") fs.writeFileSync(dest, Buffer.from(change.base64, "base64"), { flag: "wx" });
    if (change.kind === "truncate") { const fd = fs.openSync(dest, "wx"); try { fs.ftruncateSync(fd, change.length); } finally { fs.closeSync(fd); } }
    if (change.kind === "directory") fs.mkdirSync(dest);
    if (change.kind === "legacy") fs.linkSync(path.join(roots["0.1.5"], OFFICE_WASM_ROOT, "assets/soffice.wasm"), dest);
    if (change.kind === "flip") {
      fs.copyFileSync(backup, dest, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(dest, "r+");
      try { const byte = readAt(fd, change.offset, 1); byte[0] ^= 0x80; fs.writeSync(fd, byte, 0, 1, change.offset); }
      finally { fs.closeSync(fd); }
    }
    return restore;
  } catch (error) { restore(); throw error; }
}
for (const item of cases.filter((item) => item.disk)) await test(`磁盘模拟：${item.label}`, () => {
  const restore = [];
  try {
    for (const change of item.changes) restore.push(mutateDisk(roots[item.version], change));
    assert.equal(checkInstalled(roots[item.version]), item.expectLight);
  } finally { restore.reverse().forEach((undo) => undo()); }
});
const rootCases = [
  { label: "相对根", root: "relative-office-root" },
  { label: "含点段根", root: `${roots["0.2.3"]}/../0.2.3` },
  { label: "不存在的根", root: path.join(temp, "missing-root") },
  { label: "普通文件根", root: path.join(temp, "file-root") },
  { label: "符号链接根", root: path.join(temp, "link-root") },
];
fs.writeFileSync(rootCases[3].root, "不是目录", { flag: "wx" });
fs.symlinkSync(roots["0.2.3"], rootCases[4].root, process.platform === "win32" ? "junction" : "dir");
for (const [label, subdir] of [["package 目录重定向", OFFICE_WASM_ROOT], ["assets 目录重定向", `${OFFICE_WASM_ROOT}assets/`]]) {
  const root = fs.mkdtempSync(path.join(temp, "redirect-"));
  // 只对测试私有正例创建只读硬链接；此夹具之后只移动目录，不写入文件内容。
  for (const name of models["0.2.3"].keys()) {
    const dest = path.join(root, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.linkSync(path.join(roots["0.2.3"], name), dest);
  }
  const dest = path.resolve(root, subdir);
  fs.renameSync(dest, `${dest}-original`);
  fs.symlinkSync(path.join(roots["0.2.3"], subdir), dest, process.platform === "win32" ? "junction" : "dir");
  rootCases.push({ label, root });
}
for (const item of rootCases) await test(`安装根/路径：${item.label}`, () => { assert.equal(checkInstalled(item.root), false); });
await test("所有磁盘故障后恢复的真实正例仍通过全哈希", () => {
  for (const root of Object.values(roots)) verifyOfficeAssets(officeDirectoryReader(root), { full: true, runtime: true });
});

// 编译真实 Kotlin Office helper 和真实取消原语；不复制其算法到测试里。
const helper = section(installerSource, "    private fun officeAssetsAreCurrent(root: File): Boolean {", "\n    /**\n     * 校验兼容层脚本");
const constants = section(installerSource, "        private const val OFFICE_LAYER_MARKER =", "\n\n        /**\n         * 构建期补丁集版本标记");
assert.match(installerSource, /if \(!officeAssetsAreCurrent\(root\)\) return false/);
assert.ok(!/readBytes\(|readText\(/.test(helper), "Kotlin Office 探针不能无界读取资源");
for (const release of Object.values(OFFICE_RELEASES)) {
  assert.ok(constants.includes(release.manifestSha256) && constants.includes(release.sizesSha256), "Node/Kotlin 合同摘要必须一致");
}
const wrapper = path.join(temp, "OfficeProbe.kt");
fs.writeFileSync(wrapper, `package app.kxxy.engine
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.nio.file.Files
import java.nio.file.LinkOption
class OfficeProbe {
    fun accepts(root: File): Boolean = officeAssetsAreCurrent(root)
${helper}
    companion object {
        private const val TAG = "OfficeProbe"
${constants}
    }
}
`, { flag: "wx" });
const stub = path.join(temp, "Log.kt");
fs.writeFileSync(stub, `package android.util
object Log {
    var lastMessage = ""
    fun w(tag: String, message: String): Int { lastMessage = tag + ": " + message; return 0 }
}
`, { flag: "wx" });
const plan = path.join(temp, "cases.json");
fs.writeFileSync(plan, JSON.stringify({ roots, rootCases, cases: cases.filter((item) => item.disk) }), { flag: "wx" });
const harness = path.join(temp, "OfficeProbeTest.kt");
fs.writeFileSync(harness, String.raw`package app.kxxy.engine
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.util.Base64
import jdk.jfr.Recording
import jdk.jfr.consumer.RecordingFile
import java.time.Duration

fun main(args: Array<String>) {
    val temp = File(args[0])
    val plan = JSONObject(File(args[1]).readText(Charsets.UTF_8))
    val roots = plan.getJSONObject("roots")
    val probe = OfficeProbe()
    var passed = 0
    fun pass(label: String) { passed++; println("KOTLIN PASS " + passed + " " + label) }
    for (version in roots.keys()) {
        val root = File(roots.getString(version))
        val recording = Recording()
        recording.enable("jdk.FileRead").withThreshold(Duration.ZERO).withoutStackTrace()
        recording.start()
        check(probe.accepts(root)) { "真实正例被拒绝：" + version + " " + android.util.Log.lastMessage }
        recording.stop()
        val log = File(temp, "office-read-" + version + ".jfr")
        recording.dump(log.toPath())
        recording.close()
        val prefix = root.canonicalPath.replace('\\', '/') + "/"
        val events = RecordingFile.readAllEvents(log.toPath()).filter {
            it.eventType.name == "jdk.FileRead" && (it.getString("path") ?: "").replace('\\', '/').startsWith(prefix)
        }
        val bytes = events.sumOf { it.getLong("bytesRead").coerceAtLeast(0) }
        check(bytes in 1L..(200L * 1024)) { "JFR 必须记录真实的小量读取：" + bytes }
        val wasm = events.filter { it.getString("path").endsWith(".wasm") }.sumOf { it.getLong("bytesRead") }
        val fonts = events.filter { it.getString("path").endsWith(".ttf") }.sumOf { it.getLong("bytesRead") }
        check(wasm == 8L && fonts == 8L) { "不得读取 WASM 或字体主体：" + wasm + "/" + fonts }
        println("JVM_READ_BYTES " + version + " " + bytes + " WASM " + wasm + " FONTS " + fonts)
        pass("真实正例及 JFR 读取预算 " + version)
    }
    val artifacts = File(temp, "kotlin-fault-artifacts")
    check(artifacts.mkdir())
    var serial = 0
    fun mutate(root: File, change: JSONObject): () -> Unit {
        val dest = File(root, change.getString("path"))
        var scope = dest
        while (scope.parentFile != root && !scope.parentFile.exists()) scope = scope.parentFile
        val backup = File(artifacts, (++serial).toString() + "-original")
        val existed = Files.exists(scope.toPath(), LinkOption.NOFOLLOW_LINKS)
        if (existed) Files.move(scope.toPath(), backup.toPath())
        val restore = {
            if (Files.exists(scope.toPath(), LinkOption.NOFOLLOW_LINKS)) Files.move(scope.toPath(), File(backup.path + "-fault").toPath())
            if (existed) Files.move(backup.toPath(), scope.toPath())
            Unit
        }
        try {
            val kind = change.getString("kind")
            if (kind != "missing") Files.createDirectories(dest.parentFile.toPath())
            when (kind) {
                "missing" -> Unit
                "bytes" -> dest.writeBytes(Base64.getDecoder().decode(change.getString("base64")))
                "truncate" -> RandomAccessFile(dest, "rw").use { it.setLength(change.getLong("length")) }
                "directory" -> check(dest.mkdir())
                "legacy" -> Files.createLink(dest.toPath(), File(roots.getString("0.1.5"), "${OFFICE_WASM_ROOT}assets/soffice.wasm").toPath())
                "flip" -> {
                    Files.copy(backup.toPath(), dest.toPath())
                    RandomAccessFile(dest, "rw").use {
                        val offset = change.getLong("offset")
                        it.seek(offset)
                        val byte = it.readUnsignedByte() xor 128
                        it.seek(offset)
                        it.write(byte)
                    }
                }
                else -> error("未知故障类型：" + kind)
            }
            return restore
        } catch (e: Throwable) { restore(); throw e }
    }
    val cases = plan.getJSONArray("cases")
    for (i in 0 until cases.length()) {
        val item = cases.getJSONObject(i)
        val root = File(roots.getString(item.getString("version")))
        val restore = mutableListOf<() -> Unit>()
        try {
            val changes = item.getJSONArray("changes")
            for (j in 0 until changes.length()) restore.add(mutate(root, changes.getJSONObject(j)))
            check(probe.accepts(root) == item.getBoolean("expectLight")) { "Kotlin 判据不符：" + item.getString("label") }
            pass(item.getString("label"))
        } finally { restore.asReversed().forEach { it() } }
    }
    val rootCases = plan.getJSONArray("rootCases")
    for (i in 0 until rootCases.length()) {
        val item = rootCases.getJSONObject(i)
        check(!probe.accepts(File(item.getString("root")))) { "非法根/路径被放行：" + item.getString("label") }
        pass(item.getString("label"))
    }
    Thread.currentThread().interrupt()
    try {
        try { probe.accepts(File(roots.getString("0.2.3"))); error("中断被吞掉") }
        catch (e: InterruptedException) { check(Thread.currentThread().isInterrupted); pass("取消原语抛出且保留中断标志") }
    } finally { Thread.interrupted() }
    for (version in roots.keys()) check(probe.accepts(File(roots.getString(version))))
    pass("所有故障后真实正例恢复")
    println("KOTLIN_TOTAL " + passed)
}
`, { flag: "wx" });
const cache = process.env.KOTLIN_CACHE ?? path.join(os.homedir(), ".gradle/caches/modules-2/files-2.1");
function jar(folder, version) {
  const base = path.join(cache, folder, version);
  const jars = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(base, entry.name)).filter((name) => name.endsWith(".jar") && !/-sources|-javadoc/.test(name))
      .map((name) => path.join(base, entry.name, name)));
  assert.equal(jars.length, 1, `需要唯一已缓存依赖：${base}`);
  return jars[0];
}
const jsonJar = process.env.JSON_JAR;
assert.ok(jsonJar && fs.statSync(jsonJar).isFile(), "设置 JSON_JAR 指向已有 org.json jar；测试不自行下载依赖");
const java = process.env.KXXY_JAVA ?? "E:/deepseek-harness/XJZB/_toolchain/jdk-17.0.20.1+1/bin/java.exe";
const std = jar("org.jetbrains.kotlin/kotlin-stdlib", "1.9.24");
const annotations = jar("org.jetbrains/annotations", "13.0");
const compiler = [jar("org.jetbrains.kotlin/kotlin-compiler-embeddable", "1.9.24"), std, annotations,
  jar("org.jetbrains.kotlin/kotlin-reflect", "1.9.24"), jar("org.jetbrains.kotlin/kotlin-script-runtime", "1.9.24"),
  jar("org.jetbrains.intellij.deps/trove4j", "1.0.20200330")].join(path.delimiter);
const cp = [std, annotations, jsonJar].join(path.delimiter);
const classes = path.join(temp, "classes");
function runJava(args) {
  const result = spawnSync(java, ["-Dfile.encoding=UTF-8", "-Dsun.stdout.encoding=UTF-8", "-Dsun.stderr.encoding=UTF-8", ...args],
    { cwd: temp, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `JVM 退出码 ${result.status}，信号 ${result.signal}`);
  return result.stdout;
}
console.log(`指定 JDK ${java}；JSON jar SHA256 ${sha256(fs.readFileSync(jsonJar))}；真实 helper SHA256 ${sha256(helper)}`);
await test("编译真实 Kotlin Office helper 与 RuntimeInstallIo", () => {
  runJava(["-Xmx384m", "-cp", compiler, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect",
    "-jvm-target", "1.8", "-classpath", cp, "-d", classes, wrapper, stub, harness, path.join(project, sources[5])]);
});
let kotlinPassed = 0;
await test("真实 Kotlin Office 探针全量行为与 JFR 读取预算回归", () => {
  const output = runJava(["-Xmx256m", "-cp", [classes, cp].join(path.delimiter), "app.kxxy.engine.OfficeProbeTestKt", temp, plan]);
  const totals = [...output.matchAll(/^KOTLIN_TOTAL (\d+)$/gm)];
  assert.equal(totals.length, 1, "JVM 必须给出唯一完整统计");
  kotlinPassed = Number(totals[0][1]);
  assert.equal(kotlinPassed, Object.keys(roots).length + cases.filter((item) => item.disk).length + rootCases.length + 2);
  assert.equal([...output.matchAll(/^KOTLIN PASS /gm)].length, kotlinPassed);
});
await test("回归期间生产源码未变化，正例资源恢复后全哈希仍通过", () => {
  for (const [name, hash] of Object.entries(sourceHashes)) assert.equal(sha256(fs.readFileSync(path.join(project, name))), hash, `测试期间源码发生变化：${name}`);
  for (const root of Object.values(roots)) verifyOfficeAssets(officeDirectoryReader(root), { full: true, runtime: true });
});
const report = { node: process.version, java, passed, kotlinPassed, failed: 0, skipped: 0,
  faultCases: cases.length, diskFaultCases: cases.filter((item) => item.disk).length, sourceHashes, helperSha256: sha256(helper), temp };
fs.writeFileSync(path.join(temp, "result.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(`OFFICE_RESULT ${JSON.stringify(report)}`);
console.log("仅验证 Office 资产合同与安装探针；未构建最终 runtime/APK，未验证 Android 真机 Office 转换。");
