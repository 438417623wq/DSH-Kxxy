import { openAsar } from './lib/registry.mjs';

const [archivePath, packageName, relativePath = 'lib/client.js', pattern = 'slots\\.register|sidebarRight|rightSidebar|registerTab|export\\s*\\{'] = process.argv.slice(2);
if (!archivePath || !packageName) {
  throw new Error('Usage: node tools/inspect-codex-host.mjs <app.asar> <package> [file] [pattern]');
}
const archive = openAsar(archivePath);
const base = `/dsh/node_modules/${packageName}`;
if (relativePath === '--files') {
  archive.walkFiles(base, (path, size) => console.log(`${size}\t${path}`));
} else {
  const path = `${base}/${relativePath}`;
  const source = archive.readFile(path).toString('utf8');
  console.log(`${path} (${source.length} characters)`);
  if (pattern === '--all') {
    console.log(source);
  } else {
    const ranges = [];
    for (const match of source.matchAll(new RegExp(pattern, 'g'))) {
      const start = Math.max(0, match.index - 200);
      const end = Math.min(source.length, match.index + 1250);
      const previous = ranges.at(-1);
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else ranges.push([start, end]);
      if (ranges.length >= 25) break;
    }
    for (const [start, end] of ranges) {
      console.log(`\n--- offset ${start} ---\n${source.slice(start, end)}`);
    }
  }
}
