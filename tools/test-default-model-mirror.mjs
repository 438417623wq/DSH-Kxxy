import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { mirrorSelectionToHeadless } = await import(
  new URL('../plugins/kxxy-host/lib/default-model.mjs', import.meta.url).href
)

const home = mkdtempSync(join(tmpdir(), 'kxxy-mirror-'))
const web = join(home, 'profiles', 'web')
const head = join(home, 'profiles', 'headless')
mkdirSync(web, { recursive: true })
mkdirSync(head, { recursive: true })

const WEB = `- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      dhd:
        apiKeyEnv: DHD_API_KEY
        baseURL: https://api.siliconflow.cn/v1
        models:
          - id: deepseek-ai/DeepSeek-V4.1-Flash
            name: deepseek-ai/DeepSeek-V4.1-Flash
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: dhd
    model: deepseek-ai/DeepSeek-V4.1-Flash
`
writeFileSync(join(web, 'cordis.patch.yml'), WEB)
writeFileSync(join(head, 'cordis.patch.yml'), '# 出厂空补丁\n[]\n')

// ① 出厂空补丁 → 写入，只带 llm-* 与 agent-default-model，不带 UI 条目
const r1 = mirrorSelectionToHeadless(home)
assert.equal(r1.changed, true)
const out = readFileSync(join(head, 'cordis.patch.yml'), 'utf8')
assert.ok(out.includes('llm-pi-ai'))
assert.ok(out.includes('agent-default-model'))
assert.ok(!out.includes('ui-settings-general'), 'UI 条目不该被镜像过去')
assert.ok(out.startsWith('# [kxxy]'))

// ② 再跑一次 → 内容一致，不写盘
assert.equal(mirrorSelectionToHeadless(home).changed, false)

// ③ 用户手写过（首行不是标记）→ 一个字都不动
writeFileSync(join(head, 'cordis.patch.yml'), '- id: agent-default-model\n  config:\n    provider: hand\n')
const before = readFileSync(join(head, 'cordis.patch.yml'), 'utf8')
assert.equal(mirrorSelectionToHeadless(home).changed, false)
assert.equal(readFileSync(join(head, 'cordis.patch.yml'), 'utf8'), before)

// ④ web 侧没有可镜像条目 → 跳过
writeFileSync(join(web, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: x\n')
assert.equal(mirrorSelectionToHeadless(home).changed, false)

console.log('mirror 测试通过：出厂写入 / 幂等 / 用户文件不动 / 无源跳过')
