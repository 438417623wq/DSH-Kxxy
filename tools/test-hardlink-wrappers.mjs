import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { hardlinkWrappers, rsyncWrappers } from './lib/hardlink-wrappers.mjs';

const ln = hardlinkWrappers()[0];
const rsync = rsyncWrappers()[0];
const shell = process.env.KXXY_TEST_SH || (process.platform === 'win32' ? null : '/bin/sh');
const posixNode = process.env.KXXY_TEST_POSIX_NODE || process.execPath;

await test('ln builder only execs coreutils ln with untouched positional arguments', () => {
  assert.equal(ln.path, 'bin/ln');
  assert.equal(ln.mode, 0o755);
  assert.ok(Buffer.isBuffer(ln.data));
  const lines = ln.data.toString('utf8').trimEnd().split('\n');
  assert.deepEqual(lines.filter(line => !line.startsWith('#')), [
    'd=${0%/*}',
    'exec "$d/coreutils" --coreutils-prog=ln "$@"',
  ]);
  assert.ok(!ln.data.includes('KXXY_LN_'));
  assert.ok(!ln.data.includes('2>&1'));
});

await test('rsync builder always routes through runtime-owned Python and real rsync', () => {
  assert.equal(rsync.path, 'bin/kxxy-rsync');
  assert.equal(rsync.mode, 0o755);
  assert.ok(Buffer.isBuffer(rsync.data));
  assert.deepEqual(rsync.data.toString('utf8').trimEnd().split('\n').filter(line => !line.startsWith('#')), [
    'd=${0%/*}',
    'case "$d" in /*) ;; *) d=$PWD/$d ;; esac',
    'root=$(cd "$d/.." 2>/dev/null && pwd) || exit 127',
    'exec "$root/bin/python" "$root/libexec/kxxy-tools/kxxy-rsync.py" "$root/bin/rsync" "$@"',
  ]);
  assert.ok(!rsync.data.includes('--compare-dest'));
  assert.ok(!rsync.data.includes('py=python'));
});

function withRuntime(callback) {
  const root = mkdtempSync(join(tmpdir(), 'kxxy-hardlink-wrapper-test-'));
  try {
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'libexec', 'kxxy-tools'), { recursive: true });
    for (const entry of [ln, rsync]) {
      writeFileSync(join(root, entry.path), entry.data);
      chmodSync(join(root, entry.path), entry.mode);
    }
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true }); // Only this test's own temp tree.
  }
}

function fakeNative(root, name) {
  const recorder = join(root, 'record-native.mjs');
  writeFileSync(recorder, `
import { writeSync } from 'node:fs';
writeSync(1, Buffer.from(JSON.stringify(process.argv.slice(2))));
writeSync(2, Buffer.from('native-stderr-no-newline'));
process.exit(23);
`);
  const executable = join(root, 'bin', name);
  writeFileSync(executable, '#!/bin/sh\nexec "$KXXY_TEST_NODE" "$KXXY_TEST_RECORDER" "$@"\n');
  chmodSync(executable, 0o755);
  return { ...process.env, KXXY_TEST_NODE: posixNode, KXXY_TEST_RECORDER: recorder };
}

await test('ln execution preserves every argument, binary streams and failure status', {
  skip: !shell && 'No POSIX shell available on this Windows host',
}, () => withRuntime(root => {
  const env = fakeNative(root, 'coreutils');
  const args = ['-vf', '--', '-s is a file', 'space operand', '', 'line\nbreak', '雪'];
  const result = spawnSync(shell, [join(root, 'bin', 'ln'), ...args], {
    env: { ...env, KXXY_LN_STRICT: '0', KXXY_LN_STRATEGY: 'symlink' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 23);
  assert.equal(result.stderr.toString(), 'native-stderr-no-newline');
  assert.deepEqual(JSON.parse(result.stdout.toString()), ['--coreutils-prog=ln', ...args]);
}));

await test('rsync execution keeps separate operands and -- intact through runtime Python', {
  skip: !shell && 'No POSIX shell available on this Windows host',
}, () => withRuntime(root => {
  const env = fakeNative(root, 'python');
  const args = ['-av', '-e', 'ssh -p 2222', '--link-dest', '../basis with spaces', '--', '-source', 'destination'];
  const result = spawnSync(shell, [join(root, 'bin', 'kxxy-rsync'), ...args], { env });
  assert.ifError(result.error);
  assert.equal(result.status, 23);
  assert.equal(result.stderr.toString(), 'native-stderr-no-newline');
  assert.deepEqual(JSON.parse(result.stdout.toString()), [
    resolve(root, 'libexec', 'kxxy-tools', 'kxxy-rsync.py'),
    resolve(root, 'bin', 'rsync'),
    ...args,
  ]);
}));

await test('rsync guard keeps default path exec-only and gates dedup behind an opt-in', () => {
  const script = readFileSync(new URL('./prebuilt/kxxy-tools/kxxy-rsync.py', import.meta.url), 'utf8');
  assert.ok(script.includes('os.execv(real, [real] + argv)'));
  assert.ok(script.includes('os.link(source, link)'));
  assert.ok(script.includes('os.lstat(source)'));
  assert.ok(script.includes('os.lstat(link)'));
  assert.ok(!script.includes('def linkify('));
  // 默认路径仍然原样 exec 原生 rsync；去重必须先过显式 opt-in 这道门
  const gate = script.indexOf('if dedup and link_dest_unsupported and pairs and not parsed.dry_run:');
  const exec = script.indexOf('os.execv(real, [real] + argv)');
  assert.ok(gate > 0, 'explicit dedup gate missing');
  assert.ok(gate < exec, 'dedup gate must precede the native exec');
  assert.ok(script.includes('KXXY_RSYNC_DEDUP'));
  // 去重只在原生 rsync 成功返回之后发生
  const transfer = script.indexOf('subprocess.call([real] + argv)');
  const linkify = script.indexOf('dedup_symlink(basis, destination, verify=verify)');
  assert.ok(transfer > 0 && linkify > transfer, 'linkify must run after a successful transfer');
  assert.ok(script.includes('if status != 0:'));
});
