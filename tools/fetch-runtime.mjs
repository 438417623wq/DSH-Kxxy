/**
 * 阶段 1：下载 Termux aarch64 运行时闭包。
 *
 * 为什么用 Termux 仓库而不是上游 Node 官方二进制：
 *   nodejs.org 的 linux-arm64 是 **glibc** 链接，在 Android 的 **bionic** 上
 *   无法 execve（会报 `CANNOT LINK EXECUTABLE`）。Termux 的 node 是针对
 *   bionic 交叉编译的，开箱即用。
 *
 * 为什么不用 npm 装 node-pty 之类：Android 上根本没有对应的预编译产物，
 * 全部由 Termux 的包提供（或由 App 自研的 libdsh_pty.so 承担）。
 *
 * 用法: node fetch-runtime.mjs
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  fetchBuffer, downloadTo, parsePackagesIndex, resolveClosure, sha256Hex, human,
} from "./lib/registry.mjs";
import { SEED_COMPAT_PACKAGES, SEED_PACKAGES, SEED_VERSION_PINS, TERMUX_REPO } from "./lib/seeds.mjs";

// 向后兼容：种子表与仓库常量已抽到 lib/seeds.mjs（fetch-extensions.mjs 与本脚本
// 必须用同一份清单求交；直接 import 本文件会连 main() 一起跑），这里原样再导出。
export { SEED_COMPAT_PACKAGES, SEED_PACKAGES, SEED_VERSION_PINS, TERMUX_REPO };

/**
 * 种子包清单已抽到 tools/lib/seeds.mjs（④ 全能精选档：基线 22 包 + G0–G9，
 * 分组理由见该文件的逐条注释）。
 */

/**
 * 版本钉住（见 seeds.mjs 的 SEED_VERSION_PINS）。
 *
 * 返回 `null` 表示「不钉」，调用方按索引最新版正常下载；返回对象表示缓存里
 * 已有该版本的 deb，直接用它、不走网络、也不再比对索引里的 sha256（那是新版
 * 的摘要）。摘要改为**现算缓存文件**，保证清单里的值描述的是真实文件。
 */
function applyVersionPin(name, pkg, cacheDir) {
  const pin = SEED_VERSION_PINS[name];
  if (!pin) return null;
  const file = safeName(`${name}_${pin}_${pkg.arch}.deb`);
  const dest = join(cacheDir, file);
  if (!existsSync(dest)) return null;
  return {
    version: pin,
    arch: pkg.arch,
    filename: pkg.filename,
    file,
    size: statSync(dest).size,
    sha256: sha256Hex(readFileSync(dest)),
    depends: pkg.depends,
    pinned: true,
  };
}

/**
 * Windows 文件名不允许 ':'，而 Debian 版本号带 epoch（如 `1:3.6.5`）会原样带进来
 * —— 直接用作文件名会 EINVAL。统一把非法字符替换为 '_'。
 *
 * 提到模块作用域是因为 applyVersionPin() 也要用它拼缓存文件名。
 */
const safeName = (s) => s.replace(/[:*?"<>|\\/]/g, "_");

async function main() {
  const cacheDir = process.env.KXXY_CACHE ?? join(process.cwd(), ".cache", "debs");
  mkdirSync(cacheDir, { recursive: true });

  console.log(`[1/3] 拉取 Termux 索引 ${TERMUX_REPO} ...`);
  const indexUrl = `${TERMUX_REPO}/dists/stable/main/binary-aarch64/Packages`;
  const indexText = (await fetchBuffer(indexUrl)).toString("utf8");
  const index = parsePackagesIndex(indexText);
  console.log(`      ${index.size} 个包可用`);

  console.log(`[2/3] 求解依赖闭包（${SEED_PACKAGES.length} 个种子）...`);
  const { ordered, missing } = resolveClosure(index, SEED_PACKAGES);
  if (missing.length) {
    // 关键运行依赖缺失时不再产出看似完整的离线清单。
    throw new Error(`Termux 依赖闭包不完整，索引中不存在: ${missing.join(", ")}`);
  }
  const pkgs = ordered.filter((n) => index.has(n));
  const totalBytes = pkgs.reduce((s, n) => s + index.get(n).size, 0);
  console.log(`      闭包 ${pkgs.length} 个包，下载量 ${human(totalBytes)}`);

  console.log(`[3/3] 下载到 ${cacheDir} ...`);
  const manifest = [];
  let done = 0;
  const failed = [];
  const tryDownload = async (name, pkg, dest) => {
    try {
      await downloadTo(`${TERMUX_REPO}/${pkg.filename}`, dest);
      // 校验 SHA256：Termux 索引带完整摘要。缓存命中也要验 —— 跨多次续传
      // 拼出来的文件可能损坏，设备端表现为莫名其妙的 link 失败。
      if (pkg.sha256) {
        const { readFileSync } = await import("node:fs");
        const digest = sha256Hex(readFileSync(dest));
        if (digest !== pkg.sha256) {
          console.error(`      ✗ ${name}: SHA256 不匹配 (${digest.slice(0, 16)}… != ${pkg.sha256.slice(0, 16)}…)`);
          return false;
        }
      }
      return true;
    } catch (err) {
      console.error(`      ✗ ${name}: ${err.message}`);
      return false;
    }
  };

  for (const name of pkgs) {
    const fromIndex = index.get(name);
    const pin = applyVersionPin(name, fromIndex, cacheDir);
    const pkg = pin ?? fromIndex;
    const dest = join(cacheDir, safeName(`${name}_${pkg.version}_${pkg.arch}.deb`));
    // 钉住的包在用缓存：不下载、不比对索引摘要（索引里根本没有这个版本了）。
    const good = pin ? true : await tryDownload(name, pkg, dest);
    if (!good) {
      failed.push([name, pkg, dest]);
      process.exitCode = 1;
      // 失败冷却：并行分段偶尔会触发服务端限流，立刻打下一个包只会连坐
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    done += 1;
    if (pin) console.log(`      ⏸ ${name}: 按 SEED_VERSION_PINS 停在 ${pin.version}（用缓存）`);
    manifest.push({
      name, version: pkg.version, arch: pkg.arch,
      file: dest.split(/[\\/]/).pop(), size: pkg.size, sha256: pkg.sha256,
      depends: pkg.depends,
    });
    if (done % 10 === 0 || done === pkgs.length) {
      console.log(`      ${done}/${pkgs.length} ...`);
    }
  }

  // 二轮重试：失败的包（多为限流窗口期误伤）冷却 30s 后再给一次机会
  if (failed.length) {
    console.log(`      ⏳ ${failed.length} 个包失败，冷却 30s 后二轮重试 ...`);
    await new Promise((r) => setTimeout(r, 30_000));
    for (const [name, pkg, dest] of failed) {
      if (await tryDownload(name, pkg, dest)) {
        done += 1;
        manifest.push({
          name, version: pkg.version, arch: pkg.arch,
          file: dest.split(/[\\/]/).pop(), size: pkg.size, sha256: pkg.sha256,
          depends: pkg.depends,
        });
        console.log(`      ↻ ${name} 二轮成功 (${done}/${pkgs.length})`);
      } else {
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  if (manifest.length !== pkgs.length) {
    throw new Error(`Termux 包下载不完整（${manifest.length}/${pkgs.length}），保留原 manifest，不发布残缺依赖清单`);
  }

  // 兼容包（见 seeds.mjs 的 SEED_COMPAT_PACKAGES）：同一软件包的第二个 major
  // 也要进运行时 —— ICU 78 之于 php/xetex，ICU 79 之于 nodejs-lts。
  //
  // 这里必须**unshift**：debextract 按 packages 顺序解、同名路径后者覆盖，
  // 兼容包排最后会把 `libicuuc.so` / `include/unicode/*` 抢走，整个运行时就会
  // 用 78 的头与开发链接（python/node 的 C 扩展再编译时就会踩）。
  const compat = [];
  for (const c of SEED_COMPAT_PACKAGES) {
    const arch = index.get(c.name)?.arch ?? "aarch64";
    const file = safeName(`${c.name}_${c.version}_${arch}.deb`);
    const dest = join(cacheDir, file);
    if (!existsSync(dest)) {
      // 老版本 deb 早从索引下架，联网拿不到；只能指望构建机缓存。
      throw new Error(
        `兼容包 ${c.name} ${c.version} 不在缓存里（缺 ${file}）——` +
        `需要先有一份该版本的 deb 放进 ${cacheDir}`,
      );
    }
    compat.push({
      name: c.name,
      version: c.version,
      arch,
      file,
      size: statSync(dest).size,
      sha256: sha256Hex(readFileSync(dest)),
      depends: [],
      compat: true,
    });
    console.log(`      ⇄ ${c.name} ${c.version}（兼容包）：${c.why}`);
  }

  process.exitCode = 0;
  const manifestPath = join(cacheDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    repo: TERMUX_REPO,
    arch: "aarch64",
    generatedAt: new Date().toISOString(),
    seeds: SEED_PACKAGES,
    compatPackages: compat.map((c) => `${c.name}_${c.version}`),
    packages: [...compat, ...manifest],
  }, null, 2));
  console.log(
    `\n完成：${manifest.length} 个 deb` +
    (compat.length ? ` + ${compat.length} 个兼容包` : "") +
    `，清单写入 ${manifestPath}`,
  );
}

main().catch((err) => { console.error(err); process.exit(1); });
