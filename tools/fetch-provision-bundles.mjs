/**
 * glibc 容器的**离线**预置包：julia / dotnet / wkhtmltopdf。
 *
 * 背景：`kxxy-glibc-provision` 原来一律走 `apt` / `curl`，断网就等于「装了扩展也用不了」。
 * 这里把三份产物在构建期下好、钉死摘要，随 glibc 扩展一起进池；设备侧
 * `kxxy-glibc-provision` 优先用本地包（<ext>/provision/*），拿不到才回退联网。
 *
 *   node tools/fetch-provision-bundles.mjs [--only julia|dotnet|wkhtmltopdf|all] [--print-sha]
 *
 * 产物（都在 `.cache/glibc/provision/`，`from` 相对项目根）：
 *
 *   julia-1.11.7-linux-aarch64.tar.gz        官方 aarch64 tarball（顶层 julia-1.11.7/）
 *   dotnet-sdk-8.0.404-linux-arm64.tar.gz    微软官方 SDK tarball（自带宿主，不依赖 apt）
 *   wkhtmltopdf-noble-arm64-debs.tar.gz      wkhtmltopdf 及其完整依赖闭包的 .deb
 *
 * 为什么不直接 `apt-get download`：宿主是 Windows，没有 dpkg/apt，也不跑 arm64。
 * 这里改成「读 Packages 索引 + 递归解析 Depends」，按 base rootfs 的
 * `/var/lib/dpkg/status` 跳过已满足的依赖，最后在设备容器里 `dpkg -i` 一次装齐。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { tarGzSync } from '../plugins/kxxy-host/lib/tar.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE = join(ROOT, '.cache/glibc/provision');
const BASE_ROOTFS = join(ROOT, '.cache/glibc/ubuntu-base-24.04.3-base-arm64.tar.gz');
const MIRROR = 'http://ports.ubuntu.com/ubuntu-ports';
const SUITES = ['noble', 'noble-updates', 'noble-security'];
const COMPONENTS = ['main', 'universe'];

const JULIA = {
  name: 'julia',
  file: 'julia-1.11.7-linux-aarch64.tar.gz',
  url: 'https://julialang-s3.julialang.org/bin/linux/aarch64/1.11/julia-1.11.7-linux-aarch64.tar.gz',
  bytes: 299168427,
};

const DOTNET = {
  name: 'dotnet',
  file: 'dotnet-sdk-8.0.404-linux-arm64.tar.gz',
  url: 'https://builds.dotnet.microsoft.com/dotnet/Sdk/8.0.404/dotnet-sdk-8.0.404-linux-arm64.tar.gz',
  bytes: 208215919,
};

const args = process.argv.slice(2);
const only = (() => {
  const i = args.indexOf('--only');
  return i >= 0 ? String(args[i + 1] ?? 'all') : 'all';
})();
const printSha = args.includes('--print-sha');

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function download(url, dest, { expectBytes = 0 } = {}) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    const size = statSync(dest).size;
    if (!expectBytes || size === expectBytes) {
      log(`复用 ${dest}（${size} 字节）`);
      return dest;
    }
    log(`${dest} 大小不符（${size} ≠ ${expectBytes}），重新下载`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  log(`下载 ${url} → ${dest}`);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execFileSync('curl', ['-fL', '--retry', '2', '--connect-timeout', '30', '-o', dest, url], { stdio: 'inherit' });
      if (expectBytes && statSync(dest).size !== expectBytes) throw new Error(`大小不符：${statSync(dest).size} ≠ ${expectBytes}`);
      return dest;
    } catch (error) {
      if (attempt === 3) throw error;
      log(`  第 ${attempt} 次失败，重试：${error.message}`);
    }
  }
  return dest;
}

async function downloadTarball(spec) {
  const dest = join(CACHE, spec.file);
  await download(spec.url, dest, { expectBytes: spec.bytes });
  const digest = sha256File(dest);
  log(`${spec.name}: ${statSync(dest).size} 字节，sha256 ${digest}`);
  return { ...spec, sha256: digest, actualBytes: statSync(dest).size };
}

// ── Debian 版本比较（dpkg 语义的子集，够用来判断「已装版本是否满足约束」）──────
function orderChar(c) {
  if (c === '~') return -1;
  if (c === '') return 0;
  if (/[0-9]/.test(c)) return 0;
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
  return c.charCodeAt(0) + 256;
}

function comparePart(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    let first = '';
    while (i < a.length && !/[0-9]/.test(a[i])) first += a[i++];
    let second = '';
    while (j < b.length && !/[0-9]/.test(b[j])) second += b[j++];
    for (let k = 0; k < Math.max(first.length, second.length); k += 1) {
      const diff = orderChar(first[k] ?? '') - orderChar(second[k] ?? '');
      if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    let n1 = '';
    while (i < a.length && /[0-9]/.test(a[i])) n1 += a[i++];
    let n2 = '';
    while (j < b.length && /[0-9]/.test(b[j])) n2 += b[j++];
    n1 = n1.replace(/^0+(?=\d)/, '');
    n2 = n2.replace(/^0+(?=\d)/, '');
    if (n1.length !== n2.length) return n1.length < n2.length ? -1 : 1;
    if (n1 !== n2) return n1 < n2 ? -1 : 1;
  }
  return 0;
}

function compareVersion(a, b) {
  const split = (v) => {
    const epochSplit = v.split(':');
    const epoch = epochSplit.length > 1 ? Number(epochSplit[0]) : 0;
    const rest = epochSplit.length > 1 ? epochSplit[1] : v;
    const dash = rest.lastIndexOf('-');
    return {
      epoch,
      upstream: dash > 0 ? rest.slice(0, dash) : rest,
      revision: dash > 0 ? rest.slice(dash + 1) : '0',
    };
  };
  const x = split(a);
  const y = split(b);
  if (x.epoch !== y.epoch) return x.epoch < y.epoch ? -1 : 1;
  const up = comparePart(x.upstream, y.upstream);
  if (up !== 0) return up;
  return comparePart(x.revision, y.revision);
}

function satisfies(installed, constraint) {
  if (!constraint) return true;
  const m = /^(>=|<=|=|>>|<<|>|<)\s*(.+)$/.exec(constraint.trim());
  if (!m) return true;
  const cmp = compareVersion(installed, m[2]);
  switch (m[1]) {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>>':
    case '>': return cmp > 0;
    case '<<':
    case '<': return cmp < 0;
    case '=': return cmp === 0;
    default: return true;
  }
}

// ── Packages 索引 ───────────────────────────────────────────────────────────
async function loadIndexes() {
  const byName = new Map();
  const providers = new Map();
  for (const suite of SUITES) {
    for (const component of COMPONENTS) {
      const url = `${MIRROR}/dists/${suite}/${component}/binary-arm64/Packages.gz`;
      const local = join(CACHE, `Packages-${suite}-${component}.gz`);
      if (!existsSync(local)) await download(url, local);
      // 不用 `gzip -dc`：Windows 上 PATH 里的 gzip 未必是 Git 那份，行为不可控。
      const text = gunzipSync(readFileSync(local)).toString('utf8');
      let entry = null;
      for (const line of text.split('\n')) {
        if (line.startsWith('Package: ')) {
          if (entry) commit(entry, byName, providers);
          entry = { name: line.slice(9).trim() };
        } else if (entry && line.startsWith('Version: ')) entry.version = line.slice(9).trim();
        else if (entry && line.startsWith('Depends: ')) entry.depends = line.slice(9).trim();
        else if (entry && line.startsWith('Provides: ')) entry.provides = line.slice(10).trim();
        else if (entry && line.startsWith('Filename: ')) entry.filename = line.slice(10).trim();
        else if (entry && line.startsWith('SHA256: ')) entry.sha256 = line.slice(8).trim();
        else if (entry && line.startsWith('Size: ')) entry.size = Number(line.slice(6).trim());
        else if (entry && line === '') {
          commit(entry, byName, providers);
          entry = null;
        }
      }
      if (entry) commit(entry, byName, providers);
    }
  }
  return { byName, providers };
}

function commit(entry, byName, providers) {
  if (!entry?.filename) return;
  const prev = byName.get(entry.name);
  // 后面的套件（updates/security）优先：同版本覆盖，更高版本胜出。
  if (!prev || compareVersion(entry.version, prev.version) >= 0) byName.set(entry.name, entry);
  for (const raw of (entry.provides ?? '').split(',')) {
    const name = raw.trim().split(/\s+/)[0];
    if (name) {
      const list = providers.get(name) ?? [];
      list.push(entry);
      providers.set(name, list);
    }
  }
}

// ── base rootfs 里已装的包（避免把 libc6 之类再装一遍）───────────────────────
function installedPackages() {
  const map = new Map();
  if (!existsSync(BASE_ROOTFS)) return map;
  // 用 Python 的 tarfile 读：Windows 上 `tar` 可能是 bsdtar，`-xzOf` 的路径语义
  // 与 GNU tar 不一致（实测直接报 Not found / 把 `E:` 当远端主机）。
  let status = '';
  try {
    status = execFileSync(process.env.PYTHON ?? 'python', ['-c', [
      'import tarfile,sys',
      `t = tarfile.open(r"${BASE_ROOTFS.replace(/\\/g, '\\\\')}")`,
      'm = t.extractfile("var/lib/dpkg/status")',
      'sys.stdout.write(m.read().decode("utf-8"))',
    ].join('\n')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    log(`警告：读不到 base rootfs 的 dpkg status（${error.message}），闭包会包含全部依赖`);
    return map;
  }
  let name = null;
  for (const line of status.split('\n')) {
    if (line.startsWith('Package: ')) name = line.slice(9).trim();
    else if (name && line.startsWith('Status: ')) {
      if (!/install ok installed/.test(line)) name = null;
    } else if (name && line.startsWith('Version: ')) {
      map.set(name, line.slice(9).trim());
      name = null;
    }
  }
  return map;
}

// ── 闭包解析 ────────────────────────────────────────────────────────────────
function parseDepends(text) {
  if (!text) return [];
  return text.split(',').map((group) => group.split('|').map((alt) => {
    const m = /^([a-z0-9][a-z0-9+.-]*)(?::[a-z0-9]+)?\s*(?:\((.*?)\))?/i.exec(alt.trim());
    return m ? { name: m[1], constraint: m[2] ?? null } : null;
  }).filter(Boolean));
}

function pickAlternative(group, installed, byName, providers) {
  const available = group.find((candidate) => {
    const version = installed.get(candidate.name);
    if (version !== undefined && satisfies(version, candidate.constraint)) return true;
    const entry = byName.get(candidate.name);
    if (entry) return !candidate.constraint || satisfies(entry.version, candidate.constraint);
    return (providers.get(candidate.name) ?? []).length > 0;
  });
  if (available) return available;
  const inIndex = group.find((candidate) => byName.has(candidate.name) || providers.has(candidate.name));
  return inIndex ?? group[0];
}

function resolveClosure(rootNames, index, installed) {
  const roots = Array.isArray(rootNames) ? rootNames : [rootNames];
  const rootSet = new Set(roots);
  const { byName, providers } = index;
  const picked = new Map();
  const queue = roots.map((name) => ({ name, constraint: null }));
  while (queue.length) {
    const { name, constraint } = queue.shift();
    const installedVersion = installed.get(name);
    // 已装且满足约束 ⇒ 不用带（base rootfs 里的 libc6 / libstdc++6 就该这样跳过）。
    if (!rootSet.has(name) && installedVersion !== undefined && satisfies(installedVersion, constraint)) continue;
    const entry = byName.get(name) ?? providers.get(name)?.[0];
    if (!entry) {
      log(`  警告：索引里找不到依赖 ${name}（若 rootfs 已装可忽略）`);
      continue;
    }
    if (picked.has(entry.name)) continue;
    picked.set(entry.name, entry);
    for (const group of parseDepends(entry.depends)) {
      const alt = pickAlternative(group, installed, byName, providers);
      if (alt) queue.push(alt);
    }
  }
  return picked;
}

async function buildDebBundle(name, roots, bundleFile, { index, installed } = {}) {
  log(`解析 ${name} 依赖闭包…`);
  const idx = index ?? await loadIndexes();
  const inst = installed ?? installedPackages();
  log(`base rootfs 已装 ${inst.size} 个包`);
  const closure = resolveClosure(roots, idx, inst);
  const sorted = [...closure.values()].sort((a, b) => a.name.localeCompare(b.name));
  log(`${name} 闭包 ${sorted.length} 个包，共 ${(sorted.reduce((n, e) => n + (e.size ?? 0), 0) / 1048576).toFixed(1)} MiB`);
  const debDir = join(CACHE, 'debs');
  mkdirSync(debDir, { recursive: true });
  for (const entry of sorted) {
    const dest = join(debDir, `${entry.name}_${entry.version.replace(/:/g, '%3a')}_arm64.deb`);
    if (existsSync(dest) && statSync(dest).size === entry.size) continue;
    await download(`${MIRROR}/${entry.filename}`, dest, { expectBytes: entry.size });
    const got = sha256File(dest);
    if (entry.sha256 && got !== entry.sha256) throw new Error(`${entry.name} 摘要不符`);
  }
  const list = sorted.map((entry) => `${entry.name}=${entry.version}`).join('\n') + '\n';
  writeFileSync(join(debDir, `${name}.list`), list, 'utf8');
  const bundle = join(CACHE, bundleFile);
  // 用仓库自带的 tar 写入器：Windows 的 `tar` 会把 `E:` 当成远端主机。
  const files = sorted.map((entry) => ({
    name: `${entry.name}_${entry.version.replace(/:/g, '%3a')}_arm64.deb`,
    data: readFileSync(join(debDir, `${entry.name}_${entry.version.replace(/:/g, '%3a')}_arm64.deb`)),
    mode: 0o644,
    mtimeSec: 0,
  }));
  files.push({ name: 'debs.list', data: Buffer.from(list, 'utf8'), mode: 0o644, mtimeSec: 0 });
  writeFileSync(bundle, tarGzSync(files));
  log(`${name} 闭包 → ${bundle}（${(statSync(bundle).size / 1048576).toFixed(1)} MiB，${files.length} 条）`);
  return { name, file: bundleFile, sha256: sha256File(bundle), actualBytes: statSync(bundle).size, packages: sorted.map((entry) => entry.name) };
}

async function buildWkhtmltopdf() {
  return buildDebBundle('wkhtmltopdf', ['wkhtmltopdf'], 'wkhtmltopdf-noble-arm64-debs.tar.gz');
}

async function buildLibreOffice() {
  return buildDebBundle(
    'libreoffice',
    ['libreoffice-writer-nogui', 'libreoffice-calc-nogui', 'libreoffice-impress-nogui'],
    'libreoffice-noble-arm64-debs.tar.gz',
  );
}

async function buildPythonMl() {
  log('解析 python-ml 离线套件（Ubuntu noble/arm64 python3+pip deb + cp312 aarch64 manylinux 轮子）…');
  const index = await loadIndexes();
  const installed = installedPackages();
  const closure = resolveClosure(['python3', 'python3-pip'], index, installed);
  const sorted = [...closure.values()].sort((a, b) => a.name.localeCompare(b.name));
  log(`python-ml deb 闭包 ${sorted.length} 个包，共 ${(sorted.reduce((n, e) => n + (e.size ?? 0), 0) / 1048576).toFixed(1)} MiB`);
  const debDir = join(CACHE, 'debs');
  mkdirSync(debDir, { recursive: true });
  for (const entry of sorted) {
    const dest = join(debDir, `${entry.name}_${entry.version.replace(/:/g, '%3a')}_arm64.deb`);
    if (existsSync(dest) && statSync(dest).size === entry.size) continue;
    await download(`${MIRROR}/${entry.filename}`, dest, { expectBytes: entry.size });
    const got = sha256File(dest);
    if (entry.sha256 && got !== entry.sha256) throw new Error(`${entry.name} 摘要不符`);
  }

  const wheelDir = join(CACHE, 'py-wheels-cp312-aarch64');
  mkdirSync(wheelDir, { recursive: true });
  const existingWhls = readdirSync(wheelDir).filter((f) => f.endsWith('.whl'));
  if (existingWhls.length === 0) {
    const py = process.env.PYTHON ?? 'python';
    const pipArgs = [
      '-m', 'pip', 'download',
      '--only-binary=:all:',
      '--python-version', '3.12',
      '--implementation', 'cp',
      '--abi', 'cp312',
      '--abi', 'abi3',
      '--abi', 'none',
      '--platform', 'manylinux_2_28_aarch64',
      '--platform', 'manylinux_2_17_aarch64',
      '--platform', 'manylinux2014_aarch64',
      '--platform', 'linux_aarch64',
      '--platform', 'any',
      '-d', wheelDir,
      'numpy', 'scikit-learn', 'opencv-python-headless',
    ];
    if (process.env.KXXY_PIP_INDEX) pipArgs.push('-i', process.env.KXXY_PIP_INDEX);
    log(`下载 cp312 aarch64 轮子 → ${wheelDir}`);
    execFileSync(py, pipArgs, { stdio: 'inherit' });
  } else {
    log(`复用已缓存轮子 ${wheelDir}（${existingWhls.length} 个 .whl）`);
  }

  const wheelNames = readdirSync(wheelDir).filter((f) => f.endsWith('.whl')).sort();
  if (wheelNames.length < 3) throw new Error(`python-ml 轮子数量异常：${wheelNames.length}`);
  const list = sorted.map((entry) => `${entry.name}=${entry.version}`).join('\n') + '\n';
  const files = [
    ...sorted.map((entry) => ({
      name: `debs/${entry.name}_${entry.version.replace(/:/g, '%3a')}_arm64.deb`,
      data: readFileSync(join(debDir, `${entry.name}_${entry.version.replace(/:/g, '%3a')}_arm64.deb`)),
      mode: 0o644,
      mtimeSec: 0,
    })),
    { name: 'debs/debs.list', data: Buffer.from(list, 'utf8'), mode: 0o644, mtimeSec: 0 },
    ...wheelNames.map((w) => ({
      name: `wheels/${w}`,
      data: readFileSync(join(wheelDir, w)),
      mode: 0o644,
      mtimeSec: 0,
    })),
  ];
  const bundleFile = 'python-ml-noble-arm64.tar.gz';
  const bundle = join(CACHE, bundleFile);
  writeFileSync(bundle, tarGzSync(files));
  log(`python-ml 离线包 → ${bundle}（${(statSync(bundle).size / 1048576).toFixed(1)} MiB，${sorted.length} debs + ${wheelNames.length} wheels）`);
  return {
    name: 'python-ml',
    file: bundleFile,
    sha256: sha256File(bundle),
    actualBytes: statSync(bundle).size,
    packages: sorted.map((entry) => entry.name),
    wheels: wheelNames,
  };
}

const manifestPath = join(CACHE, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { bundles: {} };

if (only === 'all' || only === 'julia') manifest.bundles.julia = await downloadTarball(JULIA);
if (only === 'all' || only === 'dotnet') manifest.bundles.dotnet = await downloadTarball(DOTNET);
if (only === 'all' || only === 'wkhtmltopdf') manifest.bundles.wkhtmltopdf = await buildWkhtmltopdf();
if (only === 'all' || only === 'libreoffice') manifest.bundles.libreoffice = await buildLibreOffice();
if (only === 'all' || only === 'python-ml') manifest.bundles['python-ml'] = await buildPythonMl();

manifest.generated = new Date().toISOString().slice(0, 10);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

if (printSha) {
  for (const [name, bundle] of Object.entries(manifest.bundles)) {
    process.stdout.write(`${name}\t${bundle.sha256}\t${bundle.actualBytes}\n`);
  }
}
log(`清单 → ${resolve(manifestPath)}`);
