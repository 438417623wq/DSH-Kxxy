/**
 * 装配：把 Termux stage（bionic 系统运行时）与 asar（dsh 的 JS 依赖树）
 * 合成一份统一的「zip 条目集合」。
 *
 * 条目形态（三种）：
 *   { path, type: "file", blob }  数据来自 stage 的 blob（惰性读，省内存）
 *   { path, type: "file", data }  数据在内存里（asar 侧与补丁产物）
 *   { path, type: "link", target }  zip 数据区留空 + 中央目录注释 "LINK:<target>"
 *   { path, type: "dir" }
 *
 * 为什么必须有 link 条目：Android app 域既禁硬链接（SELinux `avc: denied { link }`）
 * 也禁符号链接（能创建但 linker 不跟随），所以别名只能物化成实体副本。若在构建期
 * 就把别名写成完整副本，`bin/git` 的 149 个别名要 513 MiB、`bin/coreutils` 的
 * 100 个 applet 要 125 MiB。用 LINK 条目把「谁是本体」编码进 zip，App 侧解压完
 * 本体后统一复制，体积与磁盘占用各自最优。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadStage, resolveSymlinks, pickCanonical, isPruned } from "./stage.mjs";
import { openAsar } from "./registry.mjs";

const ASAR_NM = "/dsh/node_modules";
const ZIP_NM = "lib/node_modules/";

/**
 * 平台专有包判定。
 *
 * 一条规则覆盖全部：**声明了 os / cpu / libc 的包一律排除**。
 * 理由是没有任何 Android 目标会在 package.json 里声明自己 —— 原生预编译包
 * 全是 darwin/win32/linux-glibc/linux-musl 目标，而 Android 是 bionic。
 * 实测被这条规则挡掉的是：@img/sharp-linux-arm64、@img/sharp-libvips-linux-arm64、
 * @vscode/ripgrep-linux-arm64、@koromix/koffi-linux-arm64、
 * node-addon-require-builtin-linux-arm64-gnu、@deepseek-ai/node-addon-system-linux-arm64、
 * sherpa-onnx-linux-arm64、@deepseek-ai/libreoffice-kit-win32-x64 等。
 *
 * 注意 @deepseek-ai/dsh-win32-process **不声明** os/cpu（它是「功能包」而非
 * 「二进制包」），所以会被保留 —— 这是对的，它的调用点全部在 win32 分支内。
 */
export function isPlatformSpecific(pkgJson) {
  if (!pkgJson) return false;
  const has = (v) => Array.isArray(v) && v.length > 0;
  return has(pkgJson.os) || has(pkgJson.cpu) || has(pkgJson.libc);
}

// ------------------------------------------------------------------ Termux 侧

/**
 * 收集 stage 条目。
 *
 * 三种条目在这里的归宿：
 *   dir      → 保留（未 prune 时）
 *   file     → 保留为 file（blob 引用，不读内容）
 *   hardlink → 解析成它指向的那个 file（实测 Termux 闭包 hardlink 数为 0，
 *              但代码保留以防某个包改用硬链接打包）
 *   symlink  → 解析成功则保留为 link 条目；解析不到则丢弃并记账
 */
export function collectStage(stageDir) {
  const stage = loadStage(stageDir);
  const { resolved } = resolveSymlinks(stage.entries);

  /** 未 prune 的条目，key 是运行时相对路径。 */
  const kept = new Map();
  for (const e of stage.entries) {
    if (isPruned(e.path)) continue;
    if (e.type === "dir") continue; // 目录由文件的父路径隐式创建，不单独出条目
    kept.set(e.path, e);
  }

  const files = [];
  const links = [];
  const dropped = [];

  for (const [path, e] of kept) {
    if (e.type === "file") {
      files.push({ path, type: "file", blob: e.sha256, mode: e.mode, size: e.size });
      continue;
    }
    if (e.type === "hardlink") {
      // 硬链接的 target 是归档内另一个成员；内容就是它的内容。
      const src = kept.get(e.target);
      if (src && src.type === "file") {
        files.push({ path, type: "file", blob: src.sha256, mode: e.mode, size: src.size });
      } else {
        dropped.push({ path, why: `硬链接目标不可用（${e.target}）` });
      }
      continue;
    }
    if (e.type === "symlink") {
      const target = resolved.get(path);
      // 目标可能自己也被 prune 掉了（例如 share/man 下的别名指向 share/man 本体）
      if (target === undefined || !kept.has(target)) {
        dropped.push({ path, why: `符号链接目标不可用（${e.target}）` });
        continue;
      }
      links.push({ path, type: "link", target, mode: e.mode });
      continue;
    }
    dropped.push({ path, why: `未知条目类型 ${e.type}` });
  }

  return { stage, files, links, dropped, kept };
}

/**
 * 内容级去重：同一份内容只留一个本体，其余降级为 LINK。
 *
 * 为什么符号链接解析之外还需要这一步：Termux 的部分包把多调用二进制
 * 打包成**内容相同的独立文件**（而非符号链接），sha256 相同但路径无关。
 * 用 sha256 分组能一并收掉，代价是必须选对本体 —— pickCanonical 优先
 * 「无版本号名」（libz.so 优于 libz.so.1.3.2），与参考项目 dedupe-runtime.py 一致。
 */
export function dedupeByContent(files, links) {
  const bySha = new Map();
  for (const f of files) {
    if (!bySha.has(f.blob)) bySha.set(f.blob, []);
    bySha.get(f.blob).push(f);
  }

  const keep = [];
  const added = [];
  let savedBytes = 0;
  for (const [, group] of bySha) {
    if (group.length < 2) {
      keep.push(group[0]);
      continue;
    }
    const canonical = pickCanonical(group.map((g) => g.path));
    for (const g of group) {
      if (g.path === canonical) {
        keep.push(g);
      } else {
        added.push({ path: g.path, type: "link", target: canonical, mode: g.mode });
        savedBytes += g.size ?? 0;
      }
    }
  }
  return { files: keep, links: [...links, ...added], savedBytes };
}

// ------------------------------------------------------------------ asar 侧

/** 从 asar 头部索引全部顶层包名（scope 目录要下钻一层）。 */
function indexTopPackages(header) {
  const nm = header.files?.dsh?.files?.node_modules?.files ?? {};
  const all = new Set();
  for (const [k, v] of Object.entries(nm)) {
    // 不能用 `v.files` 判断是否为 scope 目录 —— 普通包目录也有 .files。
    if (k.startsWith("@")) {
      for (const s of Object.keys(v.files ?? {})) all.add(`${k}/${s}`);
    } else {
      all.add(k);
    }
  }
  return all;
}

/**
 * 索引 asar 内**全部包实例**，键是相对 `dsh/node_modules` 的路径 —— 含嵌套
 * `node_modules`。
 *
 * 为什么必须建模嵌套：npm 的扁平提升不是绝对的。当同一个包需要两个不兼容
 * 版本时，其中一个会被**物理嵌套**进依赖方的 `node_modules/`。实测 asar 里
 * 有 15 个这样的实例，例如
 *   `@deepseek-ai/dsh-host-webserver/node_modules/negotiator`（1.1.0，而顶层是 0.6.4）
 *   `compression/node_modules/debug`（2.6.9，顶层 4.4.3）
 *   `@earendil-works/pi-ai/node_modules/https-proxy-agent`（9.1.0，顶层 7.0.6）
 * 早先的实现只把「顶层包名」当作包空间，于是：
 *   ① 解析时永远取顶层版本（版本错配）；
 *   ② `readClosureInto` 从不读嵌套目录（文件缺失）。
 * 两者叠加的结果是 `@deepseek-ai/dsh-host-webserver` 导入即
 * `Cannot find module 'content-type'`（嵌套 negotiator 1.1.0 需要 content-type ^2.1.0，
 * 而顶层 negotiator 0.6.4 不需要）—— webserver 是 required 插件，引擎直接启动失败。
 *
 * 键的形态就是 Node 自己的查找路径拼接结果，所以 `resolveDep` 只需按
 * `node_modules` 逐级上溯，不必再维护一张独立的版本表。
 */
function indexPackageInstances(asar) {
  const out = new Set();
  const root = asar.header?.files?.dsh?.files?.node_modules;
  if (!root) return out;

  /** 遍历一个 node_modules 目录节点，prefix 以 "/" 结尾（顶层为空串）。 */
  const walkNm = (nmNode, prefix) => {
    for (const [name, child] of Object.entries(nmNode.files ?? {})) {
      if (!child.files) continue; // 文件而非目录
      if (name.startsWith("@")) {
        // scope 目录：其子项全部是包，不再区分目录/文件
        for (const [pkg, pkgNode] of Object.entries(child.files)) {
          if (!pkgNode.files) continue;
          addPackage(`${prefix}${name}/${pkg}`, pkgNode);
        }
        continue;
      }
      addPackage(`${prefix}${name}`, child);
    }
  };

  const addPackage = (pkgPath, pkgNode) => {
    // 没有 package.json 的目录不是包（例如残留的空目录），不计入
    if (!pkgNode.files?.["package.json"]) return;
    out.add(pkgPath);
    const nested = pkgNode.files["node_modules"];
    if (nested) walkNm(nested, `${pkgPath}/node_modules/`);
  };

  walkNm(root, "");
  return out;
}

/**
 * 按 Node 的解析算法，从 `fromInstance` 出发找 `dep` 落在哪个包实例上。
 *
 * 顺序与 `Module._resolveFilename` 一致：当前包的 `node_modules/` → 逐级上溯
 * 到祖先包的 `node_modules/` → 最后是顶层 `node_modules/`。
 */
function resolveDep(instances, fromInstance, dep) {
  let dir = fromInstance;
  for (;;) {
    const cand = dir ? `${dir}/node_modules/${dep}` : dep;
    if (instances.has(cand)) return cand;
    const i = dir.lastIndexOf("/node_modules/");
    if (i < 0) break;
    dir = dir.slice(0, i);
  }
  return instances.has(dep) ? dep : null;
}

/**
 * 补上「只在 .unpacked 磁盘目录里、asar 头部没有」的包。
 *
 * electron-builder 的 asar 对标记 unpacked 的文件仍写头部条目，但有 8 个包
 * 连头部条目都没有，只躺在 app.asar.unpacked 里：
 *   @deepseek-ai/dsh-desktop-host、@deepseek-ai/dsh-session-log-export、
 *   @deepseek-ai/libreoffice-kit、@deepseek-ai/libreoffice-kit-win32-x64、
 *   @img/sharp-win32-x64、@koromix/koffi-win32-x64、@swc/helpers、
 *   @vscode/ripgrep-win32-x64
 * 只读头部会漏掉它们（其中 dsh-session-log-export 是会话导出功能的真实依赖）。
 */
function indexUnpackedOnly(asarPath, headerNames) {
  const root = join(`${asarPath}.unpacked`, "dsh", "node_modules");
  const extra = new Set();
  let top;
  try {
    top = readdirSync(root, { withFileTypes: true });
  } catch {
    return extra;
  }
  for (const d of top) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith("@")) {
      let inner;
      try {
        inner = readdirSync(join(root, d.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of inner) {
        if (!s.isDirectory()) continue;
        const full = `${d.name}/${s.name}`;
        if (!headerNames.has(full)) extra.add(full);
      }
    } else if (!headerNames.has(d.name)) {
      extra.add(d.name);
    }
  }
  return extra;
}

/**
 * 求 `dsh web` profile 真正需要的包闭包。
 *
 * 根取四个：CLI 本体、两个 bundle、前端 dist。
 * 跟随 dependencies + optionalDependencies + peerDependencies，不做
 * devDependencies —— 后者在安装时已被剥离（asar 里没有任何 devDependencies 产物）。
 *
 * peerDependencies 必须跟随，且必须按「可选」处理。原因：官方安装是**扁平提升**
 * 的 node_modules，peer 依赖被物理地摆在 `<root>/lib/node_modules/<name>`，
 * Node 直接就能解析到；而 DSH 大量使用「接缝包」模式 —— 实现包（如 dsh-fs-local）
 * 只把抽象层（dsh-fs）列为 peer，抽象层本身没有任何实现方以 dependencies 声明它。
 * 早先只跟随 deps+opt 时，25 个接缝包（dsh-fs、dsh-sandbox、dsh-shell、
 * dsh-compaction、dsh-workflow、dsh-session-persistence、cordis-plugin-group …）
 * 全部漏出闭包，设备上引擎启动即 `Cannot find package '@deepseek-ai/dsh-fs'`。
 * 反过来，peer 也**不能**按必需处理：bufferutil / kerberos / utf-8-validate 是
 * ws 与 proxy-agent-negotiate 的可选原生加速器，本来就不在树里，缺失正常。
 */
export function resolveClosure(asar, roots) {
  // 包空间不是「顶层包名集合」，而是「包实例集合」—— 含嵌套 node_modules。
  const instances = indexPackageInstances(asar);
  const top = indexTopPackages(asar.header);
  for (const n of indexUnpackedOnly(asar.path, top)) {
    top.add(n);
    instances.add(n);
  }

  const pkgCache = new Map();
  const readPkg = (instance) => {
    if (pkgCache.has(instance)) return pkgCache.get(instance);
    let v = null;
    try {
      v = JSON.parse(asar.readFile(`${ASAR_NM}/${instance}/package.json`).toString("utf8"));
    } catch {
      // 解包专用包在 header 里没有条目（`unpacked:true` 那种是有的），只能回退磁盘。
      try {
        const disk = join(`${asar.path}.unpacked`, "dsh", "node_modules", instance, "package.json");
        v = JSON.parse(readFileSync(disk, "utf8"));
      } catch {
        v = null;
      }
    }
    pkgCache.set(instance, v);
    return v;
  };

  const seen = new Set();
  const queue = [...roots];
  const missing = new Map();
  const platformSkipped = new Map();

  while (queue.length) {
    const instance = queue.shift();
    if (seen.has(instance)) continue;
    seen.add(instance);
    const pj = readPkg(instance);
    if (!pj) continue;
    // required：缺失即真问题。optional / peer：缺失正常（npm 按平台装、或本身是可选加速器）。
    const FIELDS = [
      ["dependencies", true],
      ["optionalDependencies", false],
      ["peerDependencies", false],
    ];
    for (const [field, required] of FIELDS) {
      for (const dep of Object.keys(pj[field] ?? {})) {
        // 按 Node 的解析算法定位这个依赖落在哪个实例上，而不是「顶层同名包」。
        const target = resolveDep(instances, instance, dep);
        if (target === null) {
          if (required && !missing.has(dep)) missing.set(dep, instance);
          continue;
        }
        if (seen.has(target)) continue;
        if (isPlatformSpecific(readPkg(target))) {
          platformSkipped.set(target, instance);
          continue;
        }
        queue.push(target);
      }
    }
  }
  return { seen, missing, platformSkipped, top, instances, readPkg };
}

/** 读一个包目录下全部文件，键为 zip 内路径。 */
function readPackageFiles(asar, pkg, out) {
  const base = `${ASAR_NM}/${pkg}`;
  asar.walkFiles(base, (p, size) => {
    const rel = p.slice(base.length + 1);
    const zipPath = ZIP_NM + pkg + "/" + rel;
    const data = asar.readFile(p);
    if (data.length !== size) {
      throw new Error(`asar 读取长度不符：${p} 期望 ${size} 实得 ${data.length}`);
    }
    out.set(zipPath, { data, mode: 0o644 });
  });
}

/**
 * 把闭包读进内存 Map。
 *
 * 113 MiB / 11,322 文件量级，全部驻留内存是刻意的取舍：补丁需要
 * `Map<路径, {data, mode}>` 的随机读写（patchKoffi/patchNodePty 要整包替换），
 * 而逐个文件按需读 asar 反而更慢且补丁逻辑要重写成异步。
 */
export function readClosureInto(asar, closure, out) {
  for (const pkg of closure.seen) {
    try {
      readPackageFiles(asar, pkg, out);
    } catch (e) {
      throw new Error(`读取 asar 包 ${pkg} 失败：${e.message}`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 自有插件

/**
 * 把项目自带的 Cordis 插件读进 asar 侧条目集合。
 *
 * 落点是 `lib/node_modules/<name>`，与 `createPatchContext` 的 `NM` 前缀一致，
 * 因此插件文件与上游包共用同一个 `Map<zip 路径, {data, mode}>`。
 *
 * 为什么放在这个位置能被加载：`@deepseek-ai/dsh/lib/bin.js` 的 installAnchor 是
 * `<root>/lib/node_modules/@deepseek-ai/dsh/package.json`，而
 * `collectInstallationScopePackages` 走 `createRequire(anchor).resolve.paths()`，
 * 其首项正是 `<root>/lib/node_modules` —— 只要插件名出现在 dsh 的 dependencies
 * 里（见 patches.mjs 的 patchDshManifest），它就会以 scope="installation" 进入
 * `resolution.entries`，此后**任何** profile 层的 import 都会被拦截到它。
 *
 * 排除 `_preview.html` 与 `harness-*.html`：设计稿阶段的产物，已于 v0.2.0
 * 从仓库删除（`_preview.html` 用 iframe 拼四个 `harness-*.html`，那四个各自
 * 内嵌一份**冻结的** host.js / host.css 副本，永远不会被 `/kxxy` 路由引用）。
 * 留着它们只会让「改了 host.js 但设备上还是老界面」这类排查变得困难 ——
 * 改一处、看另一处。真机产物只需 index.html。
 *
 * 这里仍保留过滤，是为了防止有人把旧快照从 git 历史里捡回来又忘了它不生效。
 */
export function readPluginFiles(pluginDir, out, zipBase = ZIP_NM) {
  const skip = new Set(["_preview.html"]);
  const base = zipBase.endsWith("/") ? zipBase : `${zipBase}/`;
  let count = 0;
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!st.isFile() || skip.has(name)) continue;
      if (/^harness-.*\.html$/.test(name)) continue;
      const zipPath = `${base}${rel}`;
      if (out.has(zipPath)) throw new Error(`插件条目与既有条目冲突：${zipPath}`);
      out.set(zipPath, { data: readFileSync(full), mode: 0o644 });
      count += 1;
    }
  };
  walk(pluginDir, "");
  return count;
}

// ------------------------------------------------------------------ 合并

/**
 * 合并 stage 与 asar 两侧。
 *
 * 冲突策略：两侧路径空间不重叠（stage 的 lib/node_modules 只有 corepack，
 * asar 侧全是 @deepseek-ai/* 与第三方包），真冲突说明假设被破坏，直接失败。
 */
export function mergeEntries(stagePart, asarFiles) {
  const conflicts = [];
  for (const e of [...stagePart.files, ...stagePart.links]) {
    if (asarFiles.has(e.path)) conflicts.push(e.path);
  }
  if (conflicts.length) {
    throw new Error(
      `stage 与 asar 条目冲突（${conflicts.length} 条）：${conflicts.slice(0, 5).join(", ")}`,
    );
  }
  return [...stagePart.files, ...stagePart.links];
}

/** 目录条目：从文件路径反推，避免 App 侧靠 mkdirs 猜。 */
export function collectDirs(entries) {
  const dirs = new Set();
  for (const e of entries) {
    const parts = e.path.split("/");
    parts.pop();
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      dirs.add(acc);
    }
  }
  return [...dirs].sort();
}
