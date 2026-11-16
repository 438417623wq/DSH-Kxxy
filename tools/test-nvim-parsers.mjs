import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildViews, ensureNvimParsers, relinkAll, removeExtension } from '../plugins/kxxy-host/lib/extinstall.mjs'

const work = mkdtempSync(join(tmpdir(), 'kxxy-nvim-parsers-'))
const languages = ['c', 'lua', 'markdown', 'markdown_inline', 'query', 'vim', 'vimdoc']
let assertions = 0
function check(value, message) { assert.ok(value, message); assertions++ }
function equal(actual, expected, message) { assert.equal(actual, expected, message); assertions++ }
function fixture(root, fixed = false) {
  const ext = join(root, 'extensions/shells')
  const tree = { 'share/nvim/runtime/syntax/syntax.vim': 'syntax', 'bin/nvim': 'nvim' }
  for (const lang of languages) {
    tree[`lib/tree_sitter/${lang}.so`] = `ELF-${lang}`
    if (fixed) tree[`share/nvim/runtime/parser/${lang}.so`] = `ELF-${lang}`
  }
  for (const [path, data] of Object.entries(tree)) {
    mkdirSync(dirname(join(ext, path)), { recursive: true })
    writeFileSync(join(ext, path), data)
  }
  return ext
}
function save(ext, links) { writeFileSync(join(ext, '.links.json'), JSON.stringify(links)) }
function physical(root) {
  for (const path of ['share', 'share/nvim', 'share/nvim/runtime', 'share/nvim/runtime/parser']) {
    const st = lstatSync(join(root, path))
    check(st.isDirectory() && !st.isSymbolicLink(), `physical parent: ${path}`)
  }
}
try {
  // 新旧两种 pool 都走新安装；新 pool 的资源合并链接也必须换成实体副本。
  for (const fixed of [false, true]) {
    const root = join(work, `new-${fixed}`)
    const ext = fixture(root, fixed)
    const links = buildViews(root, 'shells', ext)
    save(ext, links)
    for (const lang of languages) {
      const path = join(root, 'share/nvim/runtime/parser', `${lang}.so`)
      equal(readFileSync(path, 'utf8'), `ELF-${lang}`, `content: ${lang}`)
      check(!lstatSync(path).isSymbolicLink(), `physical copy: ${lang}`)
    }
    physical(root)
    equal(links.libs.filter((v) => v.name.startsWith('tree_sitter/')).length, 7, 'copy ledger')
    equal(ensureNvimParsers(root).added, 0, 'idempotent')
    rmSync(join(root, 'share/nvim/runtime/parser'), { recursive: true })
    writeFileSync(join(root, 'extensions/.relink'), '')
    relinkAll(root)
    equal(readFileSync(join(root, 'share/nvim/runtime/parser/markdown_inline.so'), 'utf8'), 'ELF-markdown_inline', 'relink restores missing parent and copy')
    writeFileSync(join(root, 'share/nvim/runtime/parser/lua.so'), 'USER')
    equal(ensureNvimParsers(root).added, 0, 'modified copy not overwritten')
    removeExtension(root, 'shells')
    equal(readFileSync(join(root, 'share/nvim/runtime/parser/lua.so'), 'utf8'), 'USER', 'modified copy survives uninstall')
    check(!existsSync(join(root, 'share/nvim/runtime/parser/markdown.so')), 'owned unmodified copy removed')
  }
  {
    const root = join(work, 'legacy')
    const ext = fixture(root)
    mkdirSync(join(root, 'share'), { recursive: true })
    symlinkSync(join(ext, 'share/nvim'), join(root, 'share/nvim'))
    save(ext, { extId: 'shells', libs: [], bins: [], views: [
      { name: 'share/nvim', target: join(root, 'share/nvim'), src: join(ext, 'share/nvim'), kind: 'view' },
    ], custom: 'preserved' })
    equal(ensureNvimParsers(root).added, 7, 'legacy install healed')
    equal(ensureNvimParsers(root).added, 0, 'legacy idempotent')
    equal(JSON.parse(readFileSync(join(ext, '.links.json'))).custom, 'preserved', 'manifest fields preserved')
    physical(root)
    check(!existsSync(join(ext, 'share/nvim/runtime/parser')), 'legacy source tree unchanged')
    rmSync(join(root, 'share/nvim/runtime/parser/query.so'))
    equal(ensureNvimParsers(root).added, 1, 'missing copy healed without relink marker')
  }
  {
    const root = join(work, 'user')
    const ext = fixture(root)
    mkdirSync(join(root, 'share/nvim/runtime/parser'), { recursive: true })
    writeFileSync(join(root, 'share/nvim/runtime/parser/lua.so'), 'USER')
    const links = buildViews(root, 'shells', ext)
    save(ext, links)
    equal(readFileSync(join(root, 'share/nvim/runtime/parser/lua.so'), 'utf8'), 'USER', 'user parser preserved')
    check(!links.libs.some((v) => v.target === join(root, 'share/nvim/runtime/parser/lua.so')), 'user parser not claimed')
    removeExtension(root, 'shells')
    equal(readFileSync(join(root, 'share/nvim/runtime/parser/lua.so'), 'utf8'), 'USER', 'user parser not removed')
  }
  for (const dangling of [false, true]) {
    const root = join(work, `foreign-${dangling}`)
    const ext = fixture(root, true)
    const foreign = join(work, `outside-${dangling}`)
    if (!dangling) mkdirSync(foreign)
    mkdirSync(join(root, 'share'), { recursive: true })
    symlinkSync(foreign, join(root, 'share/nvim'))
    const before = readlinkSync(join(root, 'share/nvim'))
    const links = buildViews(root, 'shells', ext)
    save(ext, links)
    equal(readlinkSync(join(root, 'share/nvim')), before, 'foreign/dangling ancestor not changed')
    equal(links.libs.filter((v) => v.name.startsWith('tree_sitter/')).length, 0, 'foreign route no ledger')
    equal(ensureNvimParsers(root).added, 0, 'foreign route no heal writes')
    check(!existsSync(join(foreign, 'runtime')), 'foreign directory unchanged')
  }
  {
    const root = join(work, 'foreign-leaf')
    const ext = fixture(root)
    const outside = join(work, 'user-parser.so')
    writeFileSync(outside, 'USER')
    mkdirSync(join(root, 'share/nvim/runtime/parser'), { recursive: true })
    symlinkSync(outside, join(root, 'share/nvim/runtime/parser/lua.so'))
    const links = buildViews(root, 'shells', ext)
    save(ext, links)
    equal(readlinkSync(join(root, 'share/nvim/runtime/parser/lua.so')), outside, 'user leaf link not replaced')
    equal(ensureNvimParsers(root).added, 0, 'user leaf link not healed')
    removeExtension(root, 'shells')
    equal(readFileSync(outside, 'utf8'), 'USER', 'foreign source not changed')
    equal(readlinkSync(join(root, 'share/nvim/runtime/parser/lua.so')), outside, 'user leaf link survives uninstall')
  }
  {
    const root = join(work, 'replaced-owned-leaf')
    const ext = fixture(root)
    save(ext, buildViews(root, 'shells', ext))
    const target = join(root, 'share/nvim/runtime/parser/lua.so')
    const outside = join(work, 'replacement-parser.so')
    writeFileSync(outside, 'ELF-lua') // 同摘要也不能把用户后来放的链接认成自有副本
    rmSync(target)
    symlinkSync(outside, target)
    removeExtension(root, 'shells')
    equal(readlinkSync(target), outside, 'replaced owned leaf link survives uninstall')
    equal(readFileSync(outside, 'utf8'), 'ELF-lua', 'replacement source survives uninstall')
  }
  {
    const root = join(work, 'unmanaged')
    const ext = fixture(root)
    equal(ensureNvimParsers(root).added, 0, 'unmanaged extension skipped')
    check(!existsSync(join(root, 'share/nvim')), 'unmanaged engine untouched')
    writeFileSync(join(ext, '.links.json'), '{bad-json')
    equal(ensureNvimParsers(root).added, 0, 'broken manifest skipped')
    save(ext, { extId: 'someone-else', libs: [], views: [] })
    equal(ensureNvimParsers(root).added, 0, 'mismatched manifest skipped')
  }
  console.log(`Neovim parser regression: ${assertions} passed, 0 failed (host filesystem only; loading/ABI not tested)`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
