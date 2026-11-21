import { Buffer } from 'node:buffer';

/** Validate a SONAME by following only archive LINK entries to a real ELF body. */
export function verifySoname(name, byName, read) {
  const seen = new Set();
  let current = name;
  for (;;) {
    if (seen.has(current) || seen.size > 16) throw new Error(`SONAME LINK cycle: ${name}`);
    seen.add(current);
    const entry = byName.get(current);
    if (!entry || current.endsWith('/')) throw new Error(`SONAME target missing: ${current}`);
    if (entry.comment?.startsWith('LINK:')) {
      current = entry.comment.slice(5);
      continue;
    }
    const raw = read(entry);
    if (!Buffer.isBuffer(raw) || raw.length < 64 || !raw.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) {
      throw new Error(`SONAME target is not a complete ELF: ${current}`);
    }
    return current;
  }
}

/** Match the native pnpm SEA accepted by RuntimeInstaller, not arbitrary ELF bytes. */
export function verifyBundledPnpm(raw, mode) {
  if (!Buffer.isBuffer(raw) || raw.length < 20_000_000 || !raw.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) {
    throw new Error('bundled pnpm is not a complete native executable');
  }
  if (raw[4] !== 2 || raw[5] !== 1 || raw.readUInt16LE(18) !== 183) throw new Error('bundled pnpm is not ARM64 ELF');
  if (!(mode & 0o100)) throw new Error('bundled pnpm has no owner execute permission');
}

export function rubyEnvironmentIsWired(source) {
  return /fun rubyLibPath\(root: File\): String/.test(source) && (
    /"RUBYLIB=\$\{rubyLibPath\(root\)\}"/.test(source) ||
    (/val rubyLib\s*=\s*rubyLibPath\(root\)/.test(source) && /"RUBYLIB=\$rubyLib"/.test(source))
  );
}
