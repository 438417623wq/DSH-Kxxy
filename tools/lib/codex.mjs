import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const CODEX_PLUGIN_NAME = 'dsh-codex-sidebar';
export const CODEX_PLUGIN_BASE = `lib/node_modules/${CODEX_PLUGIN_NAME}/`;
export const CODEX_PIN = {
  version: '0.167.0',
  target: 'aarch64-unknown-linux-musl',
  archiveSha256: '843489acb4d4b1079745c36b03c5963b887b83155af208fd53584e33ee8eb281',
  archiveUrl: 'https://github.com/openai/codex/releases/download/rust-v0.167.0/codex-aarch64-unknown-linux-musl.tar.gz',
  binarySha256: '2fe94d848540ff2a6868c7ebcc494126a974aa409711676d14fa0379e49e6143',
};

export function stampCodexPlugin(files) {
  const required = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/transport.mjs', 'lib/security.mjs', 'lib/service.mjs', 'lib/custom-models.mjs', 'lib/custom-chat.mjs', 'lib/native-models.mjs', 'lib/provider-api.mjs', 'lib/provider-config.mjs', 'lib/provider-http.mjs', 'lib/provider-protocols.mjs', 'lib/responses-bridge.mjs', 'lib/responses-bridge-codec.mjs', 'lib/workspace-tools.mjs', 'lib/access-policy.mjs', 'lib/file-changes.mjs', 'lib/thread-actions.mjs', 'web/codex.css'];
  for (const path of required) {
    if (!files.has(CODEX_PLUGIN_BASE + path)) throw new Error(`Codex plugin asset missing: ${path}`);
  }
  const manifest = JSON.parse(files.get(CODEX_PLUGIN_BASE + 'package.json').data.toString('utf8'));
  if (manifest.name !== CODEX_PLUGIN_NAME || manifest.dsh?.client?.platform !== 'web' || manifest.exports?.['./client'] !== './lib/client.js') {
    throw new Error('Codex plugin host/client manifest does not match the installation contract');
  }
  const rows = [];
  for (const [path, entry] of files) {
    if (!path.startsWith(CODEX_PLUGIN_BASE) || path === CODEX_PLUGIN_BASE + 'plugin.fingerprint') continue;
    rows.push(`${path.slice(CODEX_PLUGIN_BASE.length)}\t${createHash('sha256').update(entry.data).digest('hex')}`);
  }
  const fingerprint = createHash('sha256').update(rows.sort().join('\n')).digest('hex');
  files.set(CODEX_PLUGIN_BASE + 'plugin.fingerprint', { data: Buffer.from(`${fingerprint}\n`), mode: 0o644 });
  return fingerprint;
}

/** Native assets are optional until on-device isolation is accepted; never fetch during APK build. */
export function attachCodexRuntime(files, directory) {
  if (!directory) return { version: CODEX_PIN.version, included: false, reason: 'Native sandbox validation pending; no executable included' };
  const manifest = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'));
  if (manifest.version !== CODEX_PIN.version || manifest.target !== CODEX_PIN.target || manifest.archiveSha256 !== CODEX_PIN.archiveSha256) {
    throw new Error('Codex runtime provenance/version does not match the pinned official release');
  }
  const appExecution = manifest.executionMode === 'app-process';
  if (appExecution) {
    if (manifest.appServerVerified !== true || manifest.sandboxVerified !== false || manifest.files?.codex !== CODEX_PIN.binarySha256) throw new Error('Codex application execution has not been verified against the pinned official binary');
  } else if (manifest.sandboxVerified !== true) throw new Error('Codex native isolation has not been verified; refusing to bundle an executable');
  for (const name of appExecution ? ['codex'] : ['codex', 'bwrap']) {
    const path = join(directory, name);
    if (!statSync(path).isFile()) throw new Error(`Codex runtime asset missing: ${name}`);
    const data = readFileSync(path);
    if (data.subarray(0, 4).toString('hex') !== '7f454c46' || data.readUInt16LE(18) !== 183) throw new Error(`Codex runtime is not an ARM64 ELF: ${name}`);
    const hash = createHash('sha256').update(data).digest('hex');
    if (manifest.files?.[name] !== hash) throw new Error(`Codex runtime checksum mismatch: ${name}`);
    if (files.has(`bin/${name}`)) throw new Error(`Codex runtime collides with an existing file: bin/${name}`);
    files.set(`bin/${name}`, { data, mode: 0o755 });
  }
  if (appExecution) files.set('lib/codex/runtime.json', { data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), mode: 0o644 });
  return { version: manifest.version, included: true, target: manifest.target, executionMode: appExecution ? 'app-process' : 'workspace-sandbox', appServerVerified: appExecution && manifest.appServerVerified === true, sandboxVerified: manifest.sandboxVerified === true };
}
