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

export const TERMUX_REPO = "https://packages.termux.dev/apt/termux-main";

/**
 * 种子包清单 —— 对照 termux-main `binary-aarch64/Packages` 索引逐项核实。
 *
 * 分组理由（每组都对应一个真实故障模式）：
 *   - nodejs-lts：引擎本体。刻意用 LTS 而非 nodejs（26.x）—— dsh 的
 *     internalModules() 只验证 Node 22/24/26 的 Internal 接口，24 最稳。
 *   - bash + readline/ncurses/libiconv/termux-tools：shell 工具链闭包。
 *     bash 的依赖不能靠 apt 自动递归（readline -> ncurses 是二级依赖），
 *     必须显式列出才能形成可审计的闭包。
 *   - ripgrep + pcre2：dsh-tool-fs-search 的原生搜索后端。
 *   - openssl/c-ares/libicu/libsqlite/zlib/libc++：nodejs-lts 的硬依赖。
 *   - ca-certificates：调模型 API 必需的根证书。
 *   - git：dsh 的 Git 工具与插件安装（dsh-plugin add 走 pnpm + git）。
 *   - openssh：@linxin666/dsh-ssh 之类的 SSH 扩展需要。
 */
export const SEED_PACKAGES = [
  "nodejs-lts",                                        // node 本体（含 npm）
  "bash", "readline", "ncurses", "libiconv", "termux-tools", // bash 执行闭包
  "ripgrep", "pcre2",                                  // bionic 原生 rg
  "openssl", "c-ares", "libicu", "libsqlite", "zlib", "libc++", // nodejs-lts 硬依赖
  "libuv", "brotli",                                   // 静态链接兜底
  "libandroid-support",                                // bionic 兼容层辅助
  "ca-certificates",                                   // HTTPS 根证书
  "git", "openssh", "libcurl", "libexpat",             // 版本控制与远程访问
];

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
  for (const name of pkgs) {
    const pkg = index.get(name);
    const dest = join(cacheDir, safeName(`${name}_${pkg.version}_${pkg.arch}.deb`));
    let status = "skip";
    try {
      status = await downloadTo(`${TERMUX_REPO}/${pkg.filename}`, dest);
    } catch (err) {
      console.error(`      ✗ ${name}: ${err.message}`);
      process.exitCode = 1;
      continue;
    }
    // 校验 SHA256：Termux 索引带完整摘要，下载损坏必须当场发现，
    // 否则会在设备上表现为莫名其妙的 link 失败。
    if (existsSync(dest)) {
      const { readFileSync } = await import("node:fs");
      const digest = sha256Hex(readFileSync(dest));
      if (pkg.sha256 && digest !== pkg.sha256) {
        console.error(`      ✗ ${name}: SHA256 不匹配 (${digest.slice(0, 16)}… != ${pkg.sha256.slice(0, 16)}…)`);
        process.exitCode = 1;
        continue;
      }
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
