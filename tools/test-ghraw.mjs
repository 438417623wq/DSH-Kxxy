/**
 * GitHub 直链绕行（缺陷 EH 的方案 C）的单元测试。
 *
 * 被测对象是 `plugins/kxxy-host/lib/ghraw.mjs`：
 *   · parseRawUrl / apiUrl / apiCandidates / codeloadUrl —— 纯字符串映射
 *   · installHelpers —— 把两个 shell 助手落进 `$DSH_HOME/.kxxy/bin`
 *
 * 为什么这些断言值得写：这条链路的失败模式都很安静。
 *   · ref 与 path 的边界不可判定（`feature/x` 与 `main/docs` 同形），切错就是
 *     404，而 404 在用户眼里和"网络不通"没区别；
 *   · 脚本写出来但没有执行位 ⇒ `Permission denied`，看着像没装；
 *   · 幂等没做到 ⇒ 每次引擎启动都重写文件，mtime 一直变。
 *
 * 刻意**不联网**：镜像/API 的可用性由 netdiag 在设备上实测，这里只证明
 * "我们拼出来的 URL 与脚本是对的"。真机验证的对照组：
 *   ghraw octocat Hello-World master README → Hello World!
 *
 * 用法：node tools/test-ghraw.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HELPER_DIR_REL,
  apiCandidates,
  apiUrl,
  codeloadUrl,
  installHelpers,
  parseRawUrl,
} from '../plugins/kxxy-host/lib/ghraw.mjs'

let passed = 0
let failed = 0

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

function equal(name, actual, expected) {
  check(name, actual === expected, `实际 ${JSON.stringify(actual)}`)
}

const workdir = mkdtempSync(join(tmpdir(), 'kxxy-ghraw-'))

try {
  // ── 1. URL 解析 ──────────────────────────────────────────────────────
  console.log('\n[1] raw URL 解析')
  {
    const p = parseRawUrl('https://raw.githubusercontent.com/git/git/master/README.md')
    equal('owner', p?.owner, 'git')
    equal('repo', p?.repo, 'git')
    equal('segments', p?.segments.join('/'), 'master/README.md')

    const q = parseRawUrl('https://raw.githubusercontent.com/o/r/main/a/b.txt?raw=true')
    equal('查询串被剥掉', q?.segments.join('/'), 'main/a/b.txt')

    const h = parseRawUrl('https://raw.githubusercontent.com/o/r/main/a.txt#L12-L20')
    equal('fragment 被剥掉', h?.segments.join('/'), 'main/a.txt')

    equal('非 raw 域名 → null', parseRawUrl('https://example.com/o/r/main/a.txt'), null)
    equal('只有 ref 没有 path → null', parseRawUrl('https://raw.githubusercontent.com/o/r/main'), null)
    equal('空串 → null', parseRawUrl(''), null)
    // 大小写：复制出来的链接偶尔带 `Raw.GitHubUserContent.com`
    equal(
      '域名大小写不敏感',
      parseRawUrl('https://Raw.GitHubUserContent.com/o/r/main/a.txt')?.owner,
      'o',
    )
  }

  // ── 2. API URL 拼装 ──────────────────────────────────────────────────
  console.log('\n[2] Contents API 地址')
  {
    equal(
      '基本形状',
      apiUrl('git', 'git', 'master', 'README.md'),
      'https://api.github.com/repos/git/git/contents/README.md?ref=master',
    )
    // 整段 encodeURIComponent 会把 `/` 变成 %2F，而 Contents API 要求路径分隔
    // 符保持裸 `/`（%2F 会被当成文件名的一部分 → 404）。
    equal(
      '路径里的 / 保持裸的',
      apiUrl('o', 'r', 'main', 'docs/README.md'),
      'https://api.github.com/repos/o/r/contents/docs/README.md?ref=main',
    )
    // ref 里的 `/` 同理：`feature/x` 要按段编码后 join，不能整段编码
    equal(
      '分支名带 / 时不编码成 %2F',
      apiUrl('o', 'r', 'feature/x', 'a.txt'),
      'https://api.github.com/repos/o/r/contents/a.txt?ref=feature/x',
    )
    equal(
      '文件名里的空格被编码',
      apiUrl('o', 'r', 'main', 'a b.txt'),
      'https://api.github.com/repos/o/r/contents/a%20b.txt?ref=main',
    )
    equal(
      'codeload 整仓下载',
      codeloadUrl('o', 'r', 'main'),
      'https://codeload.github.com/o/r/tar.gz/refs/heads/main',
    )
  }

  // ── 3. 候选序列（ref 与 path 的边界歧义）─────────────────────────────
  console.log('\n[3] ref/path 切分候选')
  {
    const c = apiCandidates('https://raw.githubusercontent.com/o/r/main/a/b.txt')
    equal('候选数', c.length, 2)
    equal('第一个用最短 ref', c[0].ref, 'main')
    equal('第一个的 path', c[0].path, 'a/b.txt')
    equal('第二个把 a 并进 ref', c[1].ref, 'main/a')
    equal('第二个的 path', c[1].path, 'b.txt')

    // 最多试 3 段：再深的切分只会在额度上烧钱，且真实分支极少有 4 段
    const deep = apiCandidates('https://raw.githubusercontent.com/o/r/a/b/c/d/e.txt')
    equal('候选上限 3', deep.length, 3)
    equal('最后一个候选的 ref', deep[2].ref, 'a/b/c')
    equal('最后一个候选的 path', deep[2].path, 'd/e.txt')

    equal('非 raw URL → 空候选', apiCandidates('http://x/y').length, 0)
  }

  // ── 4. 助手脚本落盘 ──────────────────────────────────────────────────
  console.log('\n[4] shell 助手安装')
  {
    const home = join(workdir, 'home')
    const r = installHelpers(home)
    const dir = join(home, HELPER_DIR_REL)
    check('安装成功', r.ok, r.error)
    equal('目录 = $DSH_HOME/.kxxy/bin', r.dir, dir)
    equal('两个都写了', r.written.sort().join(','), 'ghraw,raw2api')

    const ghraw = readFileSync(join(dir, 'ghraw'), 'utf8')
    check('ghraw 是 sh 脚本', ghraw.startsWith('#!/system/bin/sh'))
    check('ghraw 带 raw 的 Accept 头', ghraw.includes('application/vnd.github.raw'))
    check('ghraw 走 contents API', ghraw.includes('api.github.com/repos/'))
    check('ghraw 读 GH_TOKEN', ghraw.includes('GH_TOKEN'))
    check('ghraw 用 TMPDIR 而不是硬编码 /tmp', ghraw.includes('TMPDIR:-') && !ghraw.includes('${TMPDIR:-/tmp}'))
    check('ghraw 带 4 参数用法', ghraw.includes('ghraw <owner> <repo> <ref> <path>'))
    check('ghraw 分支名歧义有退路（最多 3 轮）', ghraw.includes('-lt 3'))

    const r2 = readFileSync(join(dir, 'raw2api'), 'utf8')
    check('raw2api 是 sh 脚本', r2.startsWith('#!/system/bin/sh'))
    check('raw2api 用 sed 做替换', r2.includes('sed -E') && r2.includes('api.github.com/repos/'))

    // 执行位：Android 上 writeFileSync 的 mode 生效；Windows 上 stat 恒 666，
    // 所以只在真正支持 POSIX 权限时断言，否则这条会变成环境噪声。
    if (process.platform !== 'win32') {
      equal('ghraw 可执行', (statSync(join(dir, 'ghraw')).mode & 0o111) !== 0, true)
      equal('raw2api 可执行', (statSync(join(dir, 'raw2api')).mode & 0o111) !== 0, true)
    }

    // 幂等：第二次跑应该一个文件都不写（否则每次引擎启动都刷 mtime）
    const again = installHelpers(home)
    check('第二次不写盘', again.written.length === 0, again.written.join(','))
    equal('第二次都记为未变', again.unchanged.sort().join(','), 'ghraw,raw2api')
  }

  // ── 5. 内容被改坏 / 缺执行位时会重写 ─────────────────────────────────
  console.log('\n[5] 修复被改坏的助手')
  {
    const home = join(workdir, 'home2')
    installHelpers(home)
    const f = join(home, HELPER_DIR_REL, 'raw2api')
    writeFileSync(f, '#!/bin/sh\necho broken\n')
    const r = installHelpers(home)
    equal('只重写被改坏的那个', r.written.join(','), 'raw2api')
    check('内容已还原', readFileSync(f, 'utf8').includes('api.github.com/repos/'))
  }

  // ── 6. 边界 ──────────────────────────────────────────────────────────
  console.log('\n[6] 边界')
  {
    const r = installHelpers('')
    check('DSH_HOME 为空 → 不装并报错', !r.ok && Boolean(r.error), JSON.stringify(r))
    equal('也不写任何文件', r.written.length, 0)
    check('目录路径为空', r.dir === '')
  }

  // ── 7. 脚本真的能跑（有 sh 才测，不联网）─────────────────────────────
  console.log('\n[7] 脚本语法与 raw2api 行为')
  {
    const dir = join(workdir, 'home', HELPER_DIR_REL)
    const probe = spawnSync('sh', ['-n', join(dir, 'ghraw')], { encoding: 'utf8' })
    if (probe.error && probe.error.code === 'ENOENT') {
      console.log('  · 跳过（本机没有 sh）')
    } else {
      check('ghraw 语法正确', probe.status === 0, probe.stderr)
      const syntax = spawnSync('sh', ['-n', join(dir, 'raw2api')], { encoding: 'utf8' })
      check('raw2api 语法正确', syntax.status === 0, syntax.stderr)

      const one = spawnSync('sh', [join(dir, 'raw2api'), 'https://raw.githubusercontent.com/git/git/master/README.md'], {
        encoding: 'utf8',
      })
      equal(
        'raw2api 单行转换',
        one.stdout.trim(),
        'https://api.github.com/repos/git/git/contents/README.md?ref=master',
      )

      const piped = spawnSync('sh', ['-c', `printf '%s\\n' 'https://raw.githubusercontent.com/o/r/dev/a.txt' | sh ${JSON.stringify(join(dir, 'raw2api'))}`], {
        encoding: 'utf8',
      })
      equal(
        'raw2api 支持管道',
        piped.stdout.trim(),
        'https://api.github.com/repos/o/r/contents/a.txt?ref=dev',
      )

      // 已知限制：分支名带 / 时纯 sed 只能取第一段 —— 断言这个"错的"行为，
      // 免得以后有人以为它是对的，或者以为它坏了。
      const slash = spawnSync('sh', [join(dir, 'raw2api'), 'https://raw.githubusercontent.com/o/r/feature/x/a.txt'], {
        encoding: 'utf8',
      })
      equal(
        'raw2api 对带 / 的分支取第一段（已知限制，ghraw 才有重试）',
        slash.stdout.trim(),
        'https://api.github.com/repos/o/r/contents/x/a.txt?ref=feature',
      )
    }

    // 非 raw 链接必须明确拒绝，而不是拼出一个看着像的 URL
    const bad = spawnSync('sh', [join(dir, 'ghraw'), 'https://example.com/a/b/c'], { encoding: 'utf8' })
    if (!(bad.error && bad.error.code === 'ENOENT')) {
      equal('ghraw 拒绝非 raw 链接', bad.status, 2)
      check('并且说明了原因', /不是 raw\.githubusercontent\.com/.test(bad.stderr), bad.stderr)
    }
  }
} finally {
  rmSync(workdir, { recursive: true, force: true })
}

console.log(`\nGitHub 直链绕行测试：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
