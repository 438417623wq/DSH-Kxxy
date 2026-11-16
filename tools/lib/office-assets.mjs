import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const OFFICE_KIT_ROOT = "lib/node_modules/@deepseek-ai/libreoffice-kit/";
export const OFFICE_WASM_ROOT = "lib/node_modules/@deepseek-ai/libreoffice-kit-wasm/";
export const OFFICE_LAYER_MARKER = "kxxy-office@3";
export const OFFICE_LAYER_MARKER_FILE = "lib/node_modules/kxxy-host/fonts/office-assets.version";

// 来自真实 0.1.5 npm 包和官方 0.2.3 ASAR；清单不允许删减源码、许可证或改写路径。
// sizesSha256 对排序后的 `${相对路径}:${字节数}\n` 求摘要，探针只需 stat 全部资源。
export const OFFICE_RELEASES = Object.freeze({
  "0.1.5": Object.freeze({
    manifestSha256: "302237d6b29faf2dc2edcf81cf97b6f8bedc45639216d2887911977c9a1b784e",
    sizesSha256: "de52c4cfba8673f8310e80a20dff5fb4a4f68fdb62fc75655ea16465af5298b0",
  }),
  "0.2.3": Object.freeze({
    manifestSha256: "de3888ea4f94ef0feb35dce4fb457bc6c837e4d957fd1a1c6f195827c21ffbda",
    sizesSha256: "8e6fe513c6ba849f0c1d935dfc6f2404434d03e453c426bec107aef4a64c0204",
  }),
});
export const OFFICE_FONT_FILES = Object.freeze([
  Object.freeze({
    path: "lib/node_modules/kxxy-host/fonts/NotoSansSC-Regular.ttf",
    size: 10559284,
    sha256: "d45f67f0a7c0ca3f256950777ce6a61cc7ce5f9696d02900cbbaac25f8aa7d16",
  }),
  Object.freeze({
    path: "lib/node_modules/kxxy-host/fonts/NotoSansSC-Bold.ttf",
    size: 10549020,
    sha256: "9a38ae0ab28cd5a256f9ea8e00dedc688aac17f7915fcb000572990afa956b96",
  }),
]);
const SHA256 = /^[0-9a-f]{64}$/;
const ENGINE_FIELDS = ["loader", "wasm", "data", "metadata"];
const WASM_HEADER = Buffer.from("0061736d01000000", "hex");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const requireOffice = (condition, message) => {
  if (!condition) throw new Error(`Office 资产合同：${message}`);
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function officePath(path) {
  requireOffice(typeof path === "string" && /^[A-Za-z0-9@._/-]+$/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== ".."), `非法资源路径 ${String(path)}`);
  return path;
}

/** 对构建中的普通文件 Map 取只读视图，不解析 LINK，也不寻找替代路径。 */
export function officeMapReader(entries) {
  const file = (path) => {
    const parts = officePath(path).split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const parentPath = parts.slice(0, i).join("/");
      for (const name of [parentPath, `${parentPath}/`]) {
        const parent = entries.get(name);
        if (!parent) continue;
        requireOffice(!parent.target && !parent.comment?.startsWith("LINK:") &&
          [0, 0o040000].includes((parent.mode ?? 0) & 0o170000) &&
          (parent.type === "dir" || parent.type === "5" || (parent.mode & 0o170000) === 0o040000),
        `Office 父路径不是原位目录 ${name}`);
      }
    }
    const entry = entries.get(path);
    requireOffice(entry && Buffer.isBuffer(entry.data) && !entry.target &&
      (!entry.type || entry.type === "file" || entry.type === "0") &&
      [0, 0o100000].includes((entry.mode ?? 0) & 0o170000) &&
      !entry.comment?.startsWith("LINK:"), `缺少普通文件 ${path}`);
    return entry.data;
  };
  return {
    has: (path) => entries.has(path) || [...entries.keys()].some((key) => key.startsWith(`${path}/`)),
    size: (path) => file(path).length,
    read: (path, limit) => file(path).subarray(0, limit),
  };
}

/** 安装后视图：拒绝非法根、目录冒充文件及根内任何路径重定向；read 严格限长。 */
export function officeDirectoryReader(root) {
  requireOffice(typeof root === "string" && isAbsolute(root) &&
    !root.split(/[\\/]/).some((part) => part === "." || part === ".."), "运行时根必须是合法绝对目录");
  const rootStat = lstatSync(root);
  requireOffice(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "运行时根不是普通目录");
  const canonicalRoot = realpathSync(root);
  const file = (path) => {
    const full = join(canonicalRoot, officePath(path));
    const stat = lstatSync(full);
    requireOffice(stat.isFile() && !stat.isSymbolicLink() && realpathSync(full) === full,
      `不是根内原位普通文件 ${path}`);
    return { full, size: stat.size };
  };
  return {
    has: (path) => lstatSync(join(canonicalRoot, officePath(path)), { throwIfNoEntry: false }) !== undefined,
    size: (path) => file(path).size,
    read: (path, limit) => {
      const { full, size } = file(path);
      const buffer = Buffer.alloc(Math.min(size, limit));
      const fd = openSync(full, "r");
      try {
        let offset = 0;
        while (offset < buffer.length) {
          const n = readSync(fd, buffer, offset, buffer.length - offset, offset);
          requireOffice(n > 0, `读取被截断 ${path}`);
          offset += n;
        }
        return buffer;
      } finally {
        closeSync(fd);
      }
    },
  };
}

function readSmall(reader, path, limit = 64 * 1024) {
  const size = reader.size(path);
  requireOffice(Number.isSafeInteger(size) && size > 0 && size <= limit, `小文件长度非法 ${path} (${size})`);
  const data = reader.read(path, size);
  requireOffice(Buffer.isBuffer(data) && data.length === size, `读取长度不符 ${path}`);
  return data;
}
function readJson(reader, path) {
  const data = readSmall(reader, path);
  const value = JSON.parse(data.toString("utf8"));
  requireOffice(isObject(value), `JSON 不是对象 ${path}`);
  return { value, data };
}

export function officeKitVersion(reader) {
  const { value: kit } = readJson(reader, `${OFFICE_KIT_ROOT}package.json`);
  requireOffice(kit.name === "@deepseek-ai/libreoffice-kit" && typeof kit.version === "string" &&
    Object.hasOwn(OFFICE_RELEASES, kit.version), `不支持的 kit 名称或版本 ${kit.name}@${kit.version}`);
  requireOffice(kit.optionalDependencies?.["@deepseek-ai/libreoffice-kit-wasm"] === kit.version,
    "kit 的 wasm 依赖必须是已核实的精确版本");
  const entry = kit.exports?.["."];
  requireOffice(kit.type === "module" && kit.main === "lib/index.js" &&
    kit.exports?.["./package.json"] === "./package.json" && isObject(entry) &&
    Object.keys(entry).sort().join(",") === "default,types" && entry.default === "./lib/index.js" &&
    entry.types === "./lib/types/index.d.ts", "kit 包入口路径不匹配");
  const size = reader.size(`${OFFICE_KIT_ROOT}lib/index.js`);
  requireOffice(Number.isSafeInteger(size) && size > 0 && size <= 1024 * 1024, "kit 入口缺失或长度非法");
  return kit.version;
}

function verifyKitSource(reader, version) {
  const src = readSmall(reader, `${OFFICE_KIT_ROOT}lib/index.js`, 1024 * 1024).toString("utf8");
  const versions = [...src.matchAll(/const ENGINE_VERSION = "([^"]+)";/g)];
  const tables = [...src.matchAll(/const ENGINE_VERSIONS = Object\.freeze\(\{([\s\S]*?)\}\);/g)];
  const wasm = tables.length === 1 ? [...tables[0][1].matchAll(/\bwasm:\s*"([^"]+)"/g)] : [];
  requireOffice(versions.length === 1 && versions[0][1] === version && wasm.length === 1 && wasm[0][1] === version,
    "kit 源码 ENGINE_VERSION / ENGINE_VERSIONS.wasm 与 package.json 不一致");
}

export function verifyOfficeFonts(reader, { full = true } = {}) {
  for (const font of OFFICE_FONT_FILES) {
    requireOffice(reader.size(font.path) === font.size, `字体缺失或被截断 ${font.path}`);
    const data = reader.read(font.path, full ? font.size : 4);
    requireOffice(data.length === (full ? font.size : 4) &&
      [0x00010000, 0x74727565, 0x4f54544f].includes(data.readUInt32BE(0)), `字体不是单文件 sfnt ${font.path}`);
    if (full) requireOffice(sha256(data) === font.sha256, `字体 SHA256 不匹配 ${font.path}`);
  }
}

/** full 用于构建/归档核验；安装探针关闭 full，只读小清单、8 字节 WASM 头及字体头。 */
export function verifyOfficeAssets(reader, { full = true, runtime = false } = {}) {
  // 约定安装在顶层；较近的同名包会改变 Node 实际解析结果，不能用顶层正例掩盖它。
  for (const shadow of [
    `${OFFICE_KIT_ROOT}lib/node_modules/@deepseek-ai/libreoffice-kit-wasm`,
    `${OFFICE_KIT_ROOT}node_modules/@deepseek-ai/libreoffice-kit-wasm`,
    "lib/node_modules/@deepseek-ai/node_modules/@deepseek-ai/libreoffice-kit-wasm",
    "lib/node_modules/@deepseek-ai/dsh-office-kit/lib/node_modules/@deepseek-ai/libreoffice-kit",
    "lib/node_modules/@deepseek-ai/dsh-office-kit/node_modules/@deepseek-ai/libreoffice-kit",
    "lib/node_modules/@deepseek-ai/dsh-office-to-pdf/lib/node_modules/@deepseek-ai/libreoffice-kit",
    "lib/node_modules/@deepseek-ai/dsh-office-to-pdf/node_modules/@deepseek-ai/libreoffice-kit",
    "lib/node_modules/@deepseek-ai/node_modules/@deepseek-ai/libreoffice-kit",
  ]) requireOffice(!reader.has(shadow), `Office 包路径被嵌套包遮蔽 ${shadow}`);
  const version = officeKitVersion(reader);
  const release = OFFICE_RELEASES[version];
  const { value: pkg } = readJson(reader, `${OFFICE_WASM_ROOT}package.json`);
  requireOffice(pkg.name === "@deepseek-ai/libreoffice-kit-wasm" && pkg.version === version,
    `kit 与 wasm 包名称/版本不匹配 (${version} / ${pkg.name}@${pkg.version})`);
  requireOffice(pkg.exports?.["./package.json"] === "./package.json" &&
    pkg.exports?.["./prebuilds.json"] === "./prebuilds.json", "wasm 包导出路径不匹配");
  const { value: manifest, data: manifestData } = readJson(reader, `${OFFICE_WASM_ROOT}prebuilds.json`);
  requireOffice(manifest.schemaVersion === 1 && manifest.version === version && manifest.status === "built" &&
    manifest.platform === "wasm" && isObject(manifest.engine) && manifest.engine.kind === "wasm" &&
    manifest.engine.programDirectory === "/instdir/program", "prebuilds manifest 版本或引擎声明非法");
  requireOffice(isObject(manifest.files) && Object.keys(manifest.files).length > 0, "manifest.files 缺失或为空");
  for (const [path, digest] of Object.entries(manifest.files)) {
    officePath(path);
    requireOffice(typeof digest === "string" && SHA256.test(digest), `manifest SHA256 非法 ${path}`);
  }
  const enginePaths = ENGINE_FIELDS.map((field) => officePath(manifest.engine[field]));
  requireOffice(new Set(enginePaths).size === ENGINE_FIELDS.length &&
    enginePaths.every((path) => Object.hasOwn(manifest.files, path)), "引擎四项资源必须各自出现在 manifest.files");
  requireOffice(Array.isArray(manifest.source?.files) && manifest.source.files.length > 0 &&
    Array.isArray(manifest.licenses) && manifest.licenses.length > 0, "源码或许可证清单缺失");
  for (const path of [...manifest.source.files, ...manifest.licenses.map((license) => license?.path)]) {
    requireOffice(Object.hasOwn(manifest.files, officePath(path)), `源码或许可证未列入资源合同 ${path}`);
  }
  requireOffice(sha256(manifestData) === release.manifestSha256, "prebuilds manifest 不是该版本完整官方清单");

  const files = Object.keys(manifest.files).sort();
  const sizes = new Map();
  for (const path of files) {
    const size = reader.size(OFFICE_WASM_ROOT + path);
    requireOffice(Number.isSafeInteger(size) && size > 0, `资源缺失、为空或不是普通文件 ${path}`);
    sizes.set(path, size);
  }
  const sizesSha256 = sha256(files.map((path) => `${path}:${sizes.get(path)}\n`).join(""));
  requireOffice(sizesSha256 === release.sizesSha256, "完整资源长度指纹不匹配（资源被截断或版本混用）");
  if (full) {
    verifyKitSource(reader, version);
    for (const path of files) {
      const data = reader.read(OFFICE_WASM_ROOT + path, sizes.get(path));
      requireOffice(data.length === sizes.get(path) && sha256(data) === manifest.files[path], `资源 SHA256 不匹配 ${path}`);
      if (path === manifest.engine.wasm) requireOffice(data.subarray(0, 8).equals(WASM_HEADER), "WASM 魔数或二进制版本非法");
    }
  } else {
    requireOffice(reader.read(OFFICE_WASM_ROOT + manifest.engine.wasm, 8).equals(WASM_HEADER), "WASM 魔数或二进制版本非法");
  }
  if (runtime) {
    requireOffice(readSmall(reader, OFFICE_LAYER_MARKER_FILE, 256).toString("utf8").trim() === OFFICE_LAYER_MARKER,
      `资产标记不是 ${OFFICE_LAYER_MARKER}`);
    verifyOfficeFonts(reader, { full });
  }
  return { version, manifest, files, sizesSha256 };
}

/**
 * 上游闭包带 wasm 就原样全校验；整包缺席时只注入**与 kit 版本精确对应**的官方 tarball。
 *
 * 为什么不再只允许 0.1.5：桌面版发行物按平台裁剪 optionalDependencies，
 * `libreoffice-kit-wasm` 是 `optionalDependencies` 且被桌面构建剔除，但在
 * Android 运行时是必需项。kit 一旦升到 0.2.3，闭包里就只剩 kit 本体，
 * 旧规则会把「上游漏带可选包」误判成「版本漂移」，直接挡住构建。
 *
 * 边界仍然卡死：注入的 tarball 必须命中 OFFICE_RELEASES 里已钉住的 manifest
 * 与长度指纹（见 verifyOfficeAssets），版本对不上照样失败；不接受任何
 * 「凑一个能跑的半包」。
 */
export async function ensureOfficeWasm(entries, loadWasmPackage) {
  const version = officeKitVersion(officeMapReader(entries));
  const present = [...entries.keys()].some((path) => path === OFFICE_WASM_ROOT.slice(0, -1) || path.startsWith(OFFICE_WASM_ROOT));
  if (present) return { ...verifyOfficeAssets(officeMapReader(entries)), added: 0 };
  requireOffice(Object.hasOwn(OFFICE_RELEASES, version), `kit ${version} 未列入已核实版本，禁止注入 wasm 包`);
  const staged = new Map(entries);
  const added = new Map();
  for (const entry of await loadWasmPackage(version)) {
    requireOffice(entry.path.startsWith("package/"), `wasm tar 包根非法 ${entry.path}`);
    if (entry.type === "5") {
      const directory = entry.path.slice(8).replace(/\/$/, "");
      if (directory) officePath(directory);
      continue;
    }
    requireOffice(entry.type === "0", `wasm tar 条目不是普通文件 ${entry.path}`);
    const path = OFFICE_WASM_ROOT + officePath(entry.path.slice(8));
    requireOffice(!added.has(path) && !staged.has(path), `wasm tar 条目重复或冲突 ${path}`);
    added.set(path, { data: entry.data, mode: 0o644 });
  }
  const packagePath = `${OFFICE_WASM_ROOT}package.json`;
  const pkgData = added.get(packagePath)?.data;
  requireOffice(Buffer.isBuffer(pkgData), "wasm tar 缺少 package.json");
  const pkg = JSON.parse(pkgData.toString("utf8"));
  // 只去掉包的安装平台约束；不篡改 name/version/exports 或 manifest。
  delete pkg.os;
  delete pkg.cpu;
  delete pkg.libc;
  added.set(packagePath, { data: Buffer.from(`${JSON.stringify(pkg, null, "\t")}\n`), mode: 0o644 });
  for (const [path, entry] of added) staged.set(path, entry);
  const result = verifyOfficeAssets(officeMapReader(staged));
  for (const [path, entry] of added) entries.set(path, entry);
  return { ...result, added: added.size };
}
