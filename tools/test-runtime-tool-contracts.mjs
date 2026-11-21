import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifySoname, verifyBundledPnpm, rubyEnvironmentIsWired } from './lib/runtime-tool-contracts.mjs';

const elf = Buffer.alloc(64); elf.set([127, 69, 76, 70, 2, 1]); elf.writeUInt16LE(183, 18);
await test('SONAME resolves a changed zlib version to a complete real ELF', () => {
  const map = new Map([['lib/libz.so.1', { comment: 'LINK:lib/libz.so.1.4' }], ['lib/libz.so.1.4', { comment: '', data: elf }]]);
  assert.equal(verifySoname('lib/libz.so.1', map, (entry) => entry.data), 'lib/libz.so.1.4');
});
await test('missing, cyclic and non-ELF SONAME targets cannot pass', () => {
  assert.throws(() => verifySoname('z', new Map([['z', { comment: 'LINK:no' }]]), () => elf), /missing/);
  assert.throws(() => verifySoname('z', new Map([['z', { comment: 'LINK:z' }]]), () => elf), /cycle/);
  assert.throws(() => verifySoname('z', new Map([['z', { comment: '' }]]), () => Buffer.from('script')), /ELF/);
});
await test('native pnpm ARM64 SEA is accepted with owner-executable mode', () => {
  const raw = Buffer.alloc(20_000_000); elf.copy(raw);
  assert.doesNotThrow(() => verifyBundledPnpm(raw, 0o700));
  assert.doesNotThrow(() => verifyBundledPnpm(raw, 0o755));
});
await test('pnpm truncated, wrong architecture, missing execute bit cannot pass', () => {
  assert.throws(() => verifyBundledPnpm(elf, 0o755), /complete/);
  const raw = Buffer.alloc(20_000_000); elf.copy(raw);
  assert.throws(() => verifyBundledPnpm(raw, 0o600), /execute/);
  raw.writeUInt16LE(62, 18);
  assert.throws(() => verifyBundledPnpm(raw, 0o755), /ARM64/);
});
await test('Ruby accepts direct or actual variable wiring but rejects missing result injection', () => {
  const declaration = 'private fun rubyLibPath(root: File): String {';
  assert.equal(rubyEnvironmentIsWired(declaration + ' "RUBYLIB=${rubyLibPath(root)}"'), true);
  assert.equal(rubyEnvironmentIsWired(declaration + ' val rubyLib = rubyLibPath(root) "RUBYLIB=$rubyLib"'), true);
  assert.equal(rubyEnvironmentIsWired(declaration + ' val rubyLib = "wrong" "RUBYLIB=$rubyLib"'), false);
  assert.equal(rubyEnvironmentIsWired(declaration + ' val rubyLib = rubyLibPath(root)'), false);
});
