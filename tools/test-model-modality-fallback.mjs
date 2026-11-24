/**
 * 图片模态回退补丁的真实产物回归：解析、幂等、回退判定。
 *
 * 用法：node tools/test-model-modality-fallback.mjs [asar ...]
 * 默认对**两份**上游 asar 各跑一遍（都取 `@deepseek-ai/dsh-llm-pi-ai/lib/index.js`）：
 *   · `.cache/.rc3-res/resources/app.asar` —— `build-runtime.mjs --asar` 的输入，
 *     真机运行时就是它打出来的；
 *   · `.cache/app.asar` —— 桌面 rc.5。
 * 两版的 `resolveRouteModels` 调用点**容量默认值不同**（rc.3 `?? 1e6` / `?? 128e3`，
 * rc.5 `?? 262144` / `?? 32768`），只用其中一份做夹具会在另一份上炸（本轮踩过），
 * 所以默认两版都覆盖。
 *
 * 覆盖：
 *   1. 真实上游文件上补丁能落地、二次应用幂等、产物是合法 ESM；
 *   2. 从产物里抽出真实的 `catalogModalityFallback` 等函数，用受控目录验证
 *      「协议映射 → 精确 id → 规范化 id → 全局多模态」四步回退；
 *   3. 纯文本模型（embedding 等）不会被当成多模态基线；
 *   4. `input` 回退链的优先级顺序逐字锁定（entry → 显式 defaultInput →
 *      base → fallback → ["text"]）。
 *
 * 不验证：真实网络请求、上游 `containsImage` 抛错路径、Android 设备行为。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAsar } from './lib/registry.mjs';
import { createPatchContext, patchCatalogModalityFallback } from './lib/patches.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KEY = 'lib/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
const IN_ASAR = 'dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
const CHAIN =
  'input: declaredInput(entry.input) ?? (request.defaultInputDeclared === true ? declaredInput(request.defaultInput) : void 0) ?? base?.input ?? modalityBase?.input ?? [...request.defaultInput],';

const CATALOG = {
  google: [
    { id: 'gemini-2.5-pro', api: 'google-generative-ai', input: ['text', 'image'], contextWindow: 1048576, maxTokens: 65536 },
    { id: 'gemini-embedding-001', api: 'google-generative-ai', input: ['text'], contextWindow: 2048, maxTokens: 1 },
  ],
  openai: [
    { id: 'gpt-4o', api: 'openai-responses', input: ['text', 'image'], contextWindow: 128000, maxTokens: 16384 },
    { id: 'text-embedding-3-large', api: 'openai-embeddings', input: ['text'], contextWindow: 8191, maxTokens: 1 },
  ],
  anthropic: [{ id: 'claude-sonnet-4-5', api: 'anthropic-messages', input: ['text', 'image'], contextWindow: 1000000, maxTokens: 64000 }],
};

function sliceFunction(source, name) {
  const head = `function ${name}(`;
  const start = source.indexOf(head);
  assert.ok(start >= 0, `产物里缺少函数 ${name}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 缺少闭合边界`);
}

/** 用受控目录跑**产物里真实的**回退函数（不是手抄一份逻辑）。 */
function exerciseFallback(patched) {
  const helperStart = patched.indexOf('/* KXXY_CATALOG_MODALITY_FALLBACK');
  assert.ok(helperStart >= 0, '产物里缺少回退辅助段');
  const tail = sliceFunction(patched, 'catalogModalityFallback');
  const helperBlock = patched.slice(helperStart, patched.indexOf(tail) + tail.length);
  const providerIds = Object.keys(CATALOG);
  const factory = new Function(
    'catalogProviderIds',
    'getAllBuiltinModels',
    `${helperBlock}
return { catalogModalityFallback, multimodalFallbackModels, normalizedFallbackId };`,
  );
  const api = factory(
    () => providerIds,
    (id) => {
      assert.ok(id in CATALOG, `受控目录里没有 provider "${id}"（协议映射写错）`);
      return CATALOG[id];
    },
  );
  const pick = (protocol, id) => api.catalogModalityFallback(protocol, id);

  assert.equal(pick('google-generative-ai', 'gemini-2.5-pro')?.id, 'gemini-2.5-pro', '协议映射精确命中失败');
  assert.deepEqual(pick('google-generative-ai', 'gemini-2.5-pro').input, ['text', 'image']);
  assert.equal(pick('google-generative-ai', 'Pro/gemini-2.5-pro')?.id, 'gemini-2.5-pro', '网关前缀规范化失败');
  assert.equal(pick('google-generative-ai', 'Gemini-2.5-Pro')?.id, 'gemini-2.5-pro', '大小写规范化失败');
  assert.equal(pick('openai-completions', 'gpt-4o')?.id, 'gpt-4o', 'openai-completions 未映射到 openai');
  assert.equal(pick('openai-responses', 'openai/gpt-4o')?.id, 'gpt-4o', 'openai 前缀未规范化');
  assert.equal(pick('anthropic-messages', 'claude-sonnet-4-5')?.id, 'claude-sonnet-4-5', 'anthropic 映射失败');
  // 未知协议也能按规范化 id 全局找到已知多模态模型。
  assert.equal(pick('openai-completions', 'claude-sonnet-4-5')?.id, 'claude-sonnet-4-5', '全局多模态回退失败');
  // 纯文本模型不得被当成多模态基线。
  assert.equal(pick('openai-completions', 'text-embedding-3-large'), undefined, 'embedding 模型被误判为多模态');
  assert.equal(pick('google-generative-ai', 'gemini-embedding-001'), undefined, '纯文本 gemini 模型被误判为多模态');
  // 完全未知的 id 保持原判定（仍然只收文本）。
  assert.equal(pick('google-generative-ai', 'no-such-model-xyz'), undefined, '未知模型不应产生回退');
  // 索引缓存：第二次调用返回同一对象。
  assert.equal(api.multimodalFallbackModels().get('gpt-4o'), CATALOG.openai[0], '全局索引未缓存同一实体');
}

function verify(asarPath) {
  const asar = openAsar(asarPath);
  const files = new Map([[KEY, { data: asar.readFile(IN_ASAR), mode: 0o644 }]]);
  const ctx = createPatchContext(files);

  // ── 1. 真实文件上落地 + 幂等 ───────────────────────────────────────────
  const first = patchCatalogModalityFallback(ctx);
  assert.match(first, /继承图片模态/, `补丁未生效：${first}`);
  const original = files.get(KEY).data.toString('utf8');
  const second = patchCatalogModalityFallback(ctx);
  assert.match(second, /已打过/, `二次应用不幂等：${second}`);
  assert.equal(files.get(KEY).data.toString('utf8'), original, '二次应用改变了字节');

  // ── 2. 产物必须是合法 ESM ──────────────────────────────────────────────
  const scratch = mkdtempSync(path.join(ROOT, '.cache/modality-'));
  const target = path.join(scratch, 'pi-ai-adapter.mjs');
  writeFileSync(target, original);
  execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });

  // ── 3. input 回退链顺序逐字锁定 ────────────────────────────────────────
  assert.ok(original.includes(CHAIN), 'input 回退链的优先级顺序被改动');
  assert.ok(original.includes('const modalityBase = base ?? catalogModalityFallback(api, entry.id);'), '回退条目选择点被改动');
  assert.ok(!original.includes('const modalityBase = catalogModalityFallback'), '回退不得越过 base（目录命中的路由保持原判定）');

  // ── 4. 用受控目录跑真实抽取出来的回退函数 ──────────────────────────────
  exerciseFallback(original);

  const label = path.relative(ROOT, asarPath).replace(/\\/g, '/');
  console.log(`ok ${label}：补丁落地 + 幂等 + ESM + 回退判定（${original.length} 字符）`);
  return { asar: asarPath, checks: 4 };
}

const candidates = process.argv.length > 2
  ? process.argv.slice(2).map((p) => path.resolve(p))
  : [path.join(ROOT, '.cache/.rc3-res/resources/app.asar'), path.join(ROOT, '.cache/app.asar')];
const present = candidates.filter((p) => existsSync(p));
if (present.length === 0) {
  console.log(`SKIP 缺少 asar：${candidates.join(', ')}`);
  process.exit(0);
}
const results = present.map(verify);

console.log(`\nRESULT ${JSON.stringify({ asars: results.length, checks: results.reduce((n, r) => n + r.checks, 0), passed: results.length * 4, failed: 0 })}`);
