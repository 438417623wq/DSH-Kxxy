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
 *      base → fallback → 未知路由按协议兜底），并验证 `strict` 策略能退回纯文本。
 *
 * 不验证：真实网络请求、上游 `containsImage` 抛错路径、Android 设备行为。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAsar } from './lib/registry.mjs';
import { createPatchContext, patchCatalogModalityFallback, patchDefaultInputEmptyArray, patchModelSettingsDefaultInput } from './lib/patches.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KEY = 'lib/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
const IN_ASAR = 'dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
const CHAIN =
  'input: declaredInput(entry.input) ?? (request.defaultInputDeclared === true ? declaredInput(request.defaultInput) : void 0) ?? base?.input ?? modalityBase?.input ?? unknownRouteInput(api, entry.id, request.defaultInput),';

const CATALOG = {
  google: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', api: 'google-generative-ai', input: ['text', 'image'], contextWindow: 1048576, maxTokens: 65536 },
    { id: 'gemini-embedding-001', name: 'Gemini Embedding 001', api: 'google-generative-ai', input: ['text'], contextWindow: 2048, maxTokens: 1 },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', api: 'openai-responses', input: ['text', 'image'], contextWindow: 128000, maxTokens: 16384 },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', api: 'openai-responses', input: ['text', 'image'], contextWindow: 400000, maxTokens: 128000 },
    { id: 'o3-mini', name: 'o3-mini', api: 'openai-responses', input: ['text'], contextWindow: 200000, maxTokens: 100000 },
    { id: 'text-embedding-3-large', name: 'Text Embedding 3 Large', api: 'openai-embeddings', input: ['text'], contextWindow: 8191, maxTokens: 1 },
  ],
  anthropic: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', api: 'anthropic-messages', input: ['text', 'image'], contextWindow: 1000000, maxTokens: 64000 }],
  deepseek: [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', api: 'openai-completions', input: ['text', 'image'], contextWindow: 1000000, maxTokens: 384000 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', api: 'openai-completions', input: ['text'], contextWindow: 1000000, maxTokens: 384000 },
  ],
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
return { catalogModalityFallback, multimodalFallbackModels, normalizedFallbackId, unknownRouteInput };`,
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
  // 第三方中转按模型显示名写 id（如硅基流动 deepseek-ai/DeepSeek-V4.1-Flash）命中内置 name（DeepSeek V4.1 Flash）。
  assert.equal(pick('openai-completions', 'deepseek-ai/DeepSeek-V4.1-Flash')?.id, 'deepseek-flash', '按内置 name 匹配 DeepSeek-V4.1-Flash 失败');
  assert.deepEqual(pick('openai-completions', 'Pro/deepseek-ai/DeepSeek-V4.1-Flash')?.input, ['text', 'image'], '多段前缀 + name 匹配失败');
  // 小版本演进（如 gpt-6.2-astra / deepseek-v4.2-flash）保守回退到同家族多模态基线。
  assert.equal(pick('openai-responses', 'gpt-6.2-astra')?.id, 'gpt-6-astra', 'gpt-6.2-astra 主版本回退失败');
  assert.deepEqual(pick('openai-responses', 'gpt-6.2-astra')?.input, ['text', 'image']);
  assert.equal(pick('openai-completions', 'deepseek-ai/DeepSeek-V4.2-Flash')?.id, 'deepseek-flash', 'DeepSeek-V4.2-Flash 主版本回退失败');
  // 纯文本模型不得被当成多模态基线（即使 name 或主版本接近也不放行）。
  assert.equal(pick('openai-completions', 'deepseek-ai/DeepSeek-V4-Pro'), undefined, '纯文本 DeepSeek V4 Pro 被误判为多模态');
  assert.equal(pick('openai-completions', 'deepseek-ai/DeepSeek-V4.2-Pro'), undefined, '纯文本 DeepSeek V4.2 Pro 被误判为多模态');
  assert.equal(pick('openai-responses', 'o3-mini'), undefined, '纯文本 o3-mini 被误判为多模态');
  assert.equal(pick('openai-completions', 'text-embedding-3-large'), undefined, 'embedding 模型被误判为多模态');
  assert.equal(pick('google-generative-ai', 'gemini-embedding-001'), undefined, '纯文本 gemini 模型被误判为多模态');
  // 完全未知的 id 保持原判定（仍然只收文本）。
  assert.equal(pick('google-generative-ai', 'no-such-model-xyz'), undefined, '未知模型不应产生回退');
  // 索引缓存：第二次调用返回同一对象。
  assert.equal(api.multimodalFallbackModels().get('gpt-4o'), CATALOG.openai[0], '全局索引未缓存同一实体');

  // ── 目录与回退都落空时的最后一格 ──────────────────────────────────────
  // 中转 route 的模型名可能完全不在内置目录（guiji/chat/guge 这类），此时按协议兜底：
  // 对话协议视为可收图，非对话协议维持纯文本。
  assert.deepEqual(api.unknownRouteInput('openai-completions', 'guiji-v4-flash', ['text']), ['text', 'image'], '未知中转模型（openai-completions）未按可收图兜底');
  assert.deepEqual(api.unknownRouteInput('openai-responses', 'chat/astra-x', ['text']), ['text', 'image'], '未知中转模型（openai-responses，带网关前缀）未按可收图兜底');
  assert.deepEqual(api.unknownRouteInput('anthropic-messages', 'guge-sonnet', ['text']), ['text', 'image'], '未知中转模型（anthropic-messages）未按可收图兜底');
  assert.deepEqual(api.unknownRouteInput('google-generative-ai', 'guge-gemini', ['text']), ['text', 'image'], '未知中转模型（google-generative-ai）未按可收图兜底');
  assert.deepEqual(api.unknownRouteInput('openai-embeddings', 'embed-x', ['text']), ['text'], '非对话协议被放宽为可收图');
  assert.deepEqual(api.unknownRouteInput(undefined, 'embed-x', ['text']), ['text'], '协议未知时不得放宽');
  assert.deepEqual(api.unknownRouteInput('openai-completions', 'chat-x', ['text', 'image']), ['text', 'image'], '已声明 image 时不得重复追加');
  // 目录**明确**说是纯文本的，兜底也不得放行 —— 否则「纯文本模型仍然拒绝图片」这条契约就破了。
  assert.deepEqual(api.unknownRouteInput('openai-completions', 'deepseek-ai/DeepSeek-V4-Pro', ['text']), ['text'], '已知纯文本 DeepSeek V4 Pro 被协议兜底放行');
  assert.deepEqual(api.unknownRouteInput('openai-responses', 'o3-mini', ['text']), ['text'], '已知纯文本 o3-mini 被协议兜底放行');
  assert.deepEqual(api.unknownRouteInput('openai-completions', 'text-embedding-3-large', ['text']), ['text'], 'embedding 被协议兜底放行');

  // KXXY_MODALITY_UNKNOWN=strict 恢复「未知即纯文本」。
  const previous = process.env.KXXY_MODALITY_UNKNOWN;
  process.env.KXXY_MODALITY_UNKNOWN = 'strict';
  try {
    const strictFactory = new Function(
      'catalogProviderIds',
      'getAllBuiltinModels',
      `${helperBlock}
return { unknownRouteInput };`,
    );
    const strict = strictFactory(() => providerIds, (id) => CATALOG[id]);
    assert.deepEqual(strict.unknownRouteInput('openai-completions', 'chat-x', ['text']), ['text'], 'strict 策略未关闭兜底');
  } finally {
    if (previous === undefined) delete process.env.KXXY_MODALITY_UNKNOWN;
    else process.env.KXXY_MODALITY_UNKNOWN = previous;
  }
}

function verify(asarPath) {
  const asar = openAsar(asarPath);
  const files = new Map([[KEY, { data: asar.readFile(IN_ASAR), mode: 0o644 }]]);
  const ctx = createPatchContext(files);

  // ── 1. 真实文件上落地 + 幂等 ───────────────────────────────────────────
  const first = patchCatalogModalityFallback(ctx);
  assert.match(first, /继承内置目录模态/, `补丁未生效：${first}`);
  const original = files.get(KEY).data.toString('utf8');
  const second = patchCatalogModalityFallback(ctx);
  assert.match(second, /已打过/, `二次应用不幂等：${second}`);
  assert.equal(files.get(KEY).data.toString('utf8'), original, '二次应用改变了字节');

  // ── 2. 产物必须是合法 ESM ──────────────────────────────────────────────
  const scratch = mkdtempSync(path.join(ROOT, '.cache/modality-'));
  const target = path.join(scratch, 'pi-ai-adapter.mjs');
  writeFileSync(target, original);
  execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });

  // ── 2.5 空 defaultInput 数组按「未声明」处理（模型设置能保存）─────────
  const emptyFix = patchDefaultInputEmptyArray(ctx);
  assert.match(emptyFix, /空 defaultInput/, `空数组容错未生效：${emptyFix}`);
  const fixed = files.get(KEY).data.toString('utf8');
  assert.ok(
    fixed.includes('const defaultInput = Array.isArray(source.defaultInput) && source.defaultInput.length > 0 ? [...source.defaultInput] : [...DEFAULT_INPUT];'),
    '空 defaultInput 没有回落到 DEFAULT_INPUT —— provider 表单提交 [] 时保存必失败',
  );
  assert.ok(
    !fixed.includes('const defaultInput = [...source.defaultInput ?? DEFAULT_INPUT];'),
    '旧的 defaultInput 物化点仍在（空数组绕过 ?? 兜底）',
  );
  const emptyFix2 = patchDefaultInputEmptyArray(ctx);
  assert.match(emptyFix2, /已打过/, `空数组容错不幂等：${emptyFix2}`);
  assert.equal(files.get(KEY).data.toString('utf8'), fixed, '空数组容错二次应用改变了字节');
  writeFileSync(path.join(scratch, 'pi-ai-adapter-fixed.mjs'), fixed);
  execFileSync(process.execPath, ['--check', path.join(scratch, 'pi-ai-adapter-fixed.mjs')], { stdio: 'pipe' });

  // ── 3. input 回退链顺序逐字锁定 ────────────────────────────────────────
  assert.ok(original.includes(CHAIN), 'input 回退链的优先级顺序被改动');
  assert.ok(original.includes('const modalityBase = base ?? catalogModalityFallback(api, entry.id);'), '回退条目选择点被改动');
  assert.ok(!original.includes('const modalityBase = catalogModalityFallback'), '回退不得越过 base（目录命中的路由保持原判定）');
  assert.ok(!original.includes('?? [...request.defaultInput],'), 'input 仍直接落到 schema 默认值（未知中转永远发不了图）');

  // 三条判定语义（「方案 B」的契约，与实现方式无关）：
  //   ① 声明了 input        → 按声明；
  //   ② 未声明、目录与回退都查不到 → 不能落到 schema 的 ["text"]；
  //   ③ 显式写 defaultInput  → 按该值，且优先于 base。
  // 本产物里 ② 只能「按协议补 image」而不能置空 —— 见下面的第二道门。
  let cursor = -1;
  for (const needle of [
    'declaredInput(entry.input)',
    'request.defaultInputDeclared === true',
    'base?.input',
    'modalityBase?.input',
    'unknownRouteInput(',
  ]) {
    const at = CHAIN.indexOf(needle);
    assert.ok(at > cursor, `回退链优先级错位：${needle} 出现了两次或越过了前面的来源`);
    cursor = at;
  }

  // 第二道门（请求期）：pi-ai 在真正发请求前还会用 model.input 再判一次图片。
  // 只把 adapter 的 inputModalities 置空（准入放行）在这里会以 UNSUPPORTED_CONTENT
  // 失败，所以 input 必须真的带上 image —— 这条断言就是为了防止有人「简化」回去。
  assert.ok(
    original.includes('if (containsImage && !model.input.includes("image")) throw new LlmError('),
    '请求期的图片守卫不在了：请重核 input 兜底是否仍必要（闸门若已放宽，这里可以只报 modality）',
  );

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
