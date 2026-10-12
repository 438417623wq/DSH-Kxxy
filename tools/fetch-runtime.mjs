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
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  fetchBuffer, downloadTo, parsePackagesIndex, resolveClosure, sha256Hex, human,
} from "./lib/registry.mjs";
import { SEED_PACKAGES, TERMUX_REPO } from "./lib/seeds.mjs";

// 向后兼容：种子表与仓库常量已抽到 lib/seeds.mjs（fetch-extensions.mjs 与本脚本
// 必须用同一份清单求交；直接 import 本文件会连 main() 一起跑），这里原样再导出。
export { SEED_PACKAGES, TERMUX_REPO };

/**
 * 种子包清单已抽到 tools/lib/seeds.mjs（④ 全能精选档：基线 22 包 + G0–G9，
 * 分组理由见该文件的逐条注释）。
 */

async function main() {
  const cacheDir = process.env.KXXY_CACHE ?? join(process.cwd(), ".cache", "debs");
  mkdirSync(cacheDir, { recursive: true });

  // Windows 文件名不允许 ':'，而 Debian 版本号带 epoch（如 `1:3.6.5`）会原样
  // 带进来 —— 直接用作文件名会 EINVAL。统一把非法字符替换为 '_'。
  const safeName = (s) => s.replace(/[:*?"<>|\\/]/g, "_");

  console.log(`[1/3] 拉取 Termux 索引 ${TERMUX_REPO} ...`);
  const indexUrl = `${TERMUX_REPO}/dists/stable/main/binary-aarch64/Packages`;
  const indexText = (await fetchBuffer(indexUrl)).toString("utf8");
  const index = parsePackagesIndex(indexText);
  console.log(`      ${index.size} 个包可用`);

  console.log(`[2/3] 求解依赖闭包（${SEED_PACKAGES.length} 个种子）...`);
  const { ordered, missing } = resolveClosure(index, SEED_PACKAGES);
  if (missing.length) {
    // 缺包不直接失败：先列出来，让用户判断是不是包名变更
    console.warn(`      ⚠️  索引中不存在: ${missing.join(", ")}`);
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
    const pkg = index.get(name);
    const dest = join(cacheDir, safeName(`${name}_${pkg.version}_${pkg.arch}.deb`));
    const good = await tryDownload(name, pkg, dest);
    if (!good) {
      failed.push([name, pkg, dest]);
      process.exitCode = 1;
      // 失败冷却：并行分段偶尔会触发服务端限流，立刻打下一个包只会连坐
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    done += 1;
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

  const manifestPath = join(cacheDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    repo: TERMUX_REPO,
    arch: "aarch64",
    generatedAt: new Date().toISOString(),
    seeds: SEED_PACKAGES,
    packages: manifest,
  }, null, 2));
  console.log(`\n完成：${manifest.length} 个 deb，清单写入 ${manifestPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
