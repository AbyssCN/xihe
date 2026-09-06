/**
 * pi-transport — callModel 的**唯一**传输通道 (2026-08-01 起; 此前它只是"后备"那条)。
 *
 * ## 为什么从两条并成一条
 *
 * 此前 `callModel` 有两条路: 自有 registry 命中走本仓手写的 `POST /chat/completions`,
 * 认不出来才落到 pi。两条路各自演化, 于是**同一件事要记得做两遍** —— 而漏掉的那一遍
 * 不是"少了个功能", 是一个隐形故障: `model-caps` 的采样过滤原生那条早就查、pi 这条从来没查
 * → codex 座位每一发都带 `temperature` 出门、每一发 400。而 judge 就坐在那个座位上 →
 * **goal 环在那个配置下根本不可能收敛**, 表面症状却是"任务太难, 一直在修"(实测空转 65 分钟)。
 *
 * 并成一条之后分工是: **自有 registry 供端点与凭证, pi-ai 供协议知识**
 * (compat 怪癖 / thinkingLevelMap / 流式解析 / OAuth)。见 {@link piModelFromProviderConfig}。
 *
 * 解析序 (owner 锁定设计, 未变): ① 自有 registry (自定网关 / env 注册的 mimo·deepseek /
 * models.json 自定条目) ② provider 不在 registry 但 pi-ai 目录认识 ③ 都不认 → config 错。
 * 变的只是 ①② 之后走同一个 {@link piRequest}。
 *
 * 认证事实 (pi-ai 0.77.0 实测 grounding):
 *   - `complete()/completeSimple()` 只认 `options.apiKey ?? getEnvApiKey(provider)`, **不**自动读
 *     ~/.pi/agent/auth.json —— auth.json 的读取/刷新在 pi-coding-agent 的 AuthStorage 层。
 *   - pi-ai oauth 内置 provider 只有 anthropic / github-copilot / openai-codex。kimi-coding **无**
 *     内置 OAuthProviderInterface (pi 侧经 extension 动态注册) → 过期刷新对它不可行, 与旧
 *     pi-auth-bridge 同语义: 直接用 access 快照, 过期则 401 响亮报错 (绝不静默)。
 *   - 目录滞后事实: auth.json 里用户实跑的 model id (如 kimi-coding:k3) 可能不在 pi 目录; pi 自己的
 *     model-resolver `buildFallbackModel` 用同 provider 目录条目克隆换 id —— 此处同策略。
 *
 * 测试注入: setPiTransportDepsForTest() 换 getModel/getModels/completeSimple/env/auth 路径。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { capsFor, maxOutputFor, samplingFor } from './model-caps';
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
  Usage,
} from '@earendil-works/pi-ai';
// 0.80: 目录读/completeSimple 挪进 /compat (deprecated shim, 行为等价; 深迁移 Models API 另行);
// oauth 子路径变纯类型入口, 全局 OAuth 注册表已删 — kimi-coding 刷新走本仓 kimi-oauth 登录件。
import {
  completeSimple as piCompleteSimple,
  getModel as piGetModel,
  getModels as piGetModels,
} from '@earendil-works/pi-ai/compat';
import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth';
import { createKimiCodingOAuthProvider } from './kimi-oauth';
import { createOpenAICodexOAuthProvider } from './openai-codex-oauth';
import type { ContentPart, ModelMessage, ModelRequest, ModelUsage } from './types';
import { ModelError, reasoningEffortFor } from './index';
import { thinkingTypeFor } from './minimax-native';
import { logger } from '../logger';

export type PiModel = Model<Api>;

/** piRequest 的归一结果 — 与 index.ts 内部 RawResult 结构一致 (text/usage/raw/finishReason)。 */
export interface PiCallResult {
  text: string;
  usage: ModelUsage;
  raw: unknown;
  finishReason?: string;
}

// ── 依赖注入 (测试换假件; 默认 = 真 pi-ai 面) ─────────────────────────────────────

export interface PiTransportDeps {
  getModel: (provider: string, modelId: string) => PiModel | undefined;
  getModels: (provider: string) => PiModel[];
  completeSimple: (
    model: PiModel,
    context: Context,
    options?: SimpleStreamOptions,
  ) => Promise<AssistantMessage>;
  getEnvApiKey: (provider: string) => string | undefined;
  /** OAuth 刷新件 (pi-ai/oauth)。内置只有 anthropic/copilot/codex; 其余 (kimi-coding) → undefined。 */
  getOAuthProvider: (id: string) => { getApiKey: (c: OAuthCredentials) => string } | undefined;
  getOAuthApiKey: (
    id: string,
    creds: Record<string, OAuthCredentials>,
  ) => Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null>;
  authPath: string;
  now: () => number;
}

/**
 * provider → env key 映射 (对齐 pi-ai 0.80 env-api-keys.js 的表; 0.80 不再从入口导出该函数,
 * 表本身是稳定公开事实)。未知 provider → undefined (与 pi 同语义)。
 */
const PI_ENV_KEY_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY', 'azure-openai-responses': 'AZURE_OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
  google: 'GEMINI_API_KEY', 'google-vertex': 'GOOGLE_CLOUD_API_KEY', groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY', xai: 'XAI_API_KEY', openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY', zai: 'ZAI_API_KEY', mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY', 'minimax-cn': 'MINIMAX_CN_API_KEY', moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY', huggingface: 'HF_TOKEN', fireworks: 'FIREWORKS_API_KEY',
  together: 'TOGETHER_API_KEY', opencode: 'OPENCODE_API_KEY', 'opencode-go': 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY', 'cloudflare-workers-ai': 'CLOUDFLARE_API_KEY',
  'cloudflare-ai-gateway': 'CLOUDFLARE_API_KEY', xiaomi: 'XIAOMI_API_KEY',
  'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY', 'xiaomi-token-plan-ams': 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'xiaomi-token-plan-sgp': 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
};

/** env key 解析 (anthropic 双名/copilot 特例 + 上表)。导出供 wizard provider 总览复用。 */
export function piEnvApiKey(provider: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const names =
    provider === 'anthropic' ? ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
    : provider === 'github-copilot' ? ['COPILOT_GITHUB_TOKEN']
    : PI_ENV_KEY_MAP[provider] ? [PI_ENV_KEY_MAP[provider]!] : [];
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** 真实现 (静态 import: pi-ai 是 ESM-only export map, Bun require 解析不到 import 条件)。 */
function realDeps(): PiTransportDeps {
  // OAuth 刷新件 (0.80 删了全局 OAuth 注册表且未再 re-wire bundled flows): kimi 走本仓 kimi-oauth
  // (pi-ai 无内置), openai-codex 走本仓 openai-codex-oauth (pi-ai 有内置但 loader 不在 public export
  // map, 无法干净 import) —— 两者同结构面 (id/getApiKey/refreshToken), 过期路统一按 id 分派。
  const oauthFlows = [createKimiCodingOAuthProvider(), createOpenAICodexOAuthProvider()];
  const findFlow = (id: string) => oauthFlows.find((f) => f.id === id);
  return {
    getModel: piGetModel as unknown as PiTransportDeps['getModel'],
    getModels: piGetModels as unknown as PiTransportDeps['getModels'],
    completeSimple: piCompleteSimple,
    getEnvApiKey: (p) => piEnvApiKey(p),
    getOAuthProvider: (id) => {
      const f = findFlow(id);
      return f ? { getApiKey: (c) => f.getApiKey(c) } : undefined;
    },
    getOAuthApiKey: async (id, creds) => {
      const f = findFlow(id);
      if (!f || !creds[id]) return null;
      const next = await f.refreshToken(creds[id]!);
      return { newCredentials: next, apiKey: f.getApiKey(next) };
    },
    authPath: join(homedir(), '.pi', 'agent', 'auth.json'),
    now: () => Date.now(),
  };
}

let depsOverride: Partial<PiTransportDeps> | null = null;
let realCache: PiTransportDeps | null = null;

function deps(): PiTransportDeps {
  const base = (realCache ??= realDeps());
  return depsOverride ? { ...base, ...depsOverride } : base;
}

/** 测试钩子: 注入假 pi 面 (可部分覆盖, 缺键回落真实现)。不带参 = 还原。 */
export function setPiTransportDepsForTest(overrides?: Partial<PiTransportDeps>): void {
  depsOverride = overrides ?? null;
}

// ── 目录解析 ───────────────────────────────────────────────────────────────────

/**
 * pi 目录探针: 精确命中 → 目录 Model; miss 但 provider 在目录 → 克隆同 provider 首条换 id
 * (= pi model-resolver buildFallbackModel 语义, 兜目录滞后, 如 kimi-coding:k3)。
 * provider 目录不认识 → undefined (调用方回落 config 错)。纯目录查询, 无网络。
 */
export function resolvePiModel(provider: string, modelId: string): PiModel | undefined {
  if (!provider || !modelId) return undefined;
  const d = deps();
  const exact = d.getModel(provider, modelId);
  if (exact) return exact;
  const siblings = d.getModels(provider);
  const base = siblings[0];
  if (!base) return undefined;
  return { ...base, id: modelId, name: modelId };
}

/** ProviderConfig 与目录都没给上下文窗口时的保守兜底 (够放下一次 fan-in, 不敢往大了猜)。 */
const FALLBACK_CONTEXT_WINDOW = 128_000;
/** 同上, 输出上限的兜底 (anthropic 协议要求必给 max_tokens, 不能留空)。 */
const MAX_TOKENS_FALLBACK = 32_768;

/**
 * 自有 registry 条目 → pi `Model` (2026-08-01, 两条传输并成一条时的接缝)。
 *
 * **分工**: registry 供端点与凭证 (它存在的理由就是"pi 不认识这个地址"), pi 目录供协议知识。
 * 于是这里的做法是: 目录认识这一格 (provider+modelId) 就以目录条目**打底**, 再把 registry 的
 * baseUrl/headers/上限盖上去; 目录不认识才从零捏一个骨架。
 *
 * 为什么不干脆全部自己捏: 目录条目里那些字段不是装饰 —— `compat`(deepseek 的
 * `requiresReasoningContentOnAssistantMessages` 之类端点怪癖) 与 `thinkingLevelMap`(哪档真存在)
 * 正是"手写一条 HTTP 通道"迟早会漏的东西, 而漏了不报错, 只是悄悄地不生效。
 *
 * 反过来 baseUrl **必须**用 registry 的: `DEEPSEEK_BASE_URL` 指到自建网关时, 目录里那个
 * 官方地址会把请求送错地方 —— 那是配置的本意, 不是要被目录覆盖的默认值。
 */
export function piModelFromProviderConfig(
  provider: string,
  modelId: string,
  cfg: {
    baseUrl: string;
    api: string;
    maxTokens?: number;
    contextWindow?: number;
    headers?: Record<string, string>;
  },
): PiModel {
  const api = cfg.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
  const catalog = deps().getModel(provider, modelId);
  const hit = catalog && catalog.api === api ? catalog : undefined;
  const base: PiModel = hit ?? {
    id: modelId,
    name: modelId,
    api,
    provider: provider as PiModel['provider'],
    baseUrl: cfg.baseUrl,
    // 目录不认识 → 假定**支持** reasoning: 该发不发是静默降级 (弱模型不思考, 没人看得见),
    // 该不发发了是 400 (响亮)。而"发什么字面量"由 model-caps 的实测词表兜着, 见 piRequest。
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: cfg.maxTokens ?? MAX_TOKENS_FALLBACK,
  };
  // ⚠ 上限/窗口的优先序是 **per-model 优先, provider 级兜底** —— 反过来会重演 model-caps 治的那个 bug:
  // `cfg.maxTokens` 是 models.json 条目内**所有模型的最大值**, opencode-go 底下 deepseek 是 384K,
  // 拿它盖上去, glm(128K)/qwen(65K) 就都变成 384K 了。
  const maxTokens = maxOutputFor(modelId) ?? hit?.maxTokens ?? cfg.maxTokens ?? MAX_TOKENS_FALLBACK;
  const contextWindow = hit?.contextWindow ?? cfg.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  return {
    ...base,
    id: modelId,
    provider: provider as PiModel['provider'],
    api,
    baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
    contextWindow,
    maxTokens,
    ...(cfg.headers ? { headers: { ...base.headers, ...cfg.headers } } : {}),
  };
}

// ── 认证 (auth.json → env; 优先序与 pi AuthStorage 一致) ──────────────────────────

interface AuthEntry {
  type?: unknown;
  key?: unknown;
  access?: unknown;
  refresh?: unknown;
  expires?: unknown;
}

/** 读 auth.json 单条; 缺文件/坏 JSON/缺条目 → null (永不抛)。 */
function readAuthEntry(provider: string, authPath: string): AuthEntry | null {
  try {
    if (!existsSync(authPath)) return null;
    const all = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, AuthEntry | undefined>;
    return all[provider] ?? null;
  } catch {
    return null;
  }
}

/** 刷新成功后把新凭证写回 auth.json (读-改-写; 单 omd 进程, 不做 pi 的 proper-lockfile)。 */
function persistRefreshedCredentials(
  provider: string,
  creds: OAuthCredentials,
  authPath: string,
): void {
  try {
    const all = existsSync(authPath)
      ? (JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>)
      : {};
    all[provider] = { type: 'oauth', ...creds };
    writeFileSync(authPath, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  } catch (e) {
    logger.warn({ provider, err: (e as Error).message }, '[omd/pi] 刷新凭证写回 auth.json 失败 (本次调用仍用新 token)');
  }
}

/**
 * pi 通道 API key 解析 (优先序 = pi AuthStorage: auth.json api_key → auth.json oauth → env):
 *   - oauth 未过期: 有 OAuthProviderInterface → getApiKey(creds); 无 (kimi-coding) → 直接 access。
 *   - oauth 已过期: 有刷新件 → getOAuthApiKey 刷新 + 写回; 无 → 警告后仍用 access (旧 bridge 语义,
 *     请求会 401 响亮失败, 用户跑一次 pi 触发刷新即可)。
 * 全 miss → undefined (调用方抛 config 错)。
 */
export async function resolvePiApiKey(provider: string): Promise<string | undefined> {
  const d = deps();
  const entry = readAuthEntry(provider, d.authPath);
  if (entry) {
    if (entry.type === 'api_key' && typeof entry.key === 'string' && entry.key.trim()) {
      return entry.key;
    }
    if (typeof entry.access === 'string' && entry.access.trim()) {
      const creds: OAuthCredentials = {
        access: entry.access,
        refresh: typeof entry.refresh === 'string' ? entry.refresh : '',
        expires: typeof entry.expires === 'number' ? entry.expires : 0,
      };
      const expired = creds.expires !== 0 && creds.expires <= d.now();
      const oauthProvider = d.getOAuthProvider(provider);
      if (!expired) {
        return oauthProvider ? oauthProvider.getApiKey(creds) : creds.access;
      }
      if (oauthProvider) {
        try {
          const refreshed = await d.getOAuthApiKey(provider, { [provider]: creds });
          if (refreshed) {
            persistRefreshedCredentials(provider, refreshed.newCredentials, d.authPath);
            return refreshed.apiKey;
          }
        } catch (e) {
          logger.warn({ provider, err: (e as Error).message }, '[omd/pi] OAuth 刷新失败 — 回落过期 access (请求将 401)');
        }
      } else {
        logger.warn(
          `[omd/pi] ${provider} token 已过期且 pi-ai 无内置刷新件 — 跑一次 pi/kimi 命令触发刷新 (请求将 401 响亮失败)`,
        );
      }
      return creds.access;
    }
  }
  return d.getEnvApiKey(provider);
}

/**
 * provider 是否有**可用凭证** —— 同步、无副作用 (不触发 OAuth 刷新/写回), 供角色兜底链 + 起跑坐席
 * 检查廉价判定 (issue #6)。与 resolvePiApiKey 同优先序但只探"在不在", 不解析实际 key:
 *   auth.json api_key 条目 ∨ auth.json oauth access (kimi-coding 等 OAuth) ∨ env key 映射。
 * assertModelResolvable 是 **key-blind** (pi 目录认识 deepseek 全坐标即便无 key) → 判"能否真调用"
 * 必须走凭证维度, 否则无 DEEPSEEK_API_KEY 时 judge/review 的 deepseek 坐标"看似可解析"实则 call 时抛无凭证。
 */
export function piHasCredential(
  provider: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const entry = readAuthEntry(provider, deps().authPath);
  if (entry) {
    if (entry.type === 'api_key' && typeof entry.key === 'string' && entry.key.trim()) return true;
    if (typeof entry.access === 'string' && entry.access.trim()) return true;
  }
  return !!piEnvApiKey(provider, env);
}

// ── 请求/响应适配 ──────────────────────────────────────────────────────────────

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** data:<mime>;base64,... → pi ImageContent。http(s) URL pi 不收裸链接 → config 错 (响亮不静默)。 */
function toPiImage(url: string): { type: 'image'; data: string; mimeType: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m || !m[1] || m[2] === undefined) {
    throw new ModelError(
      'config',
      'pi 通道多模态只收 data:<mime>;base64 URI (pi ImageContent 无 URL 形态) — http(s) 图链请走自有 registry 的 openai-compatible provider',
    );
  }
  return { type: 'image', data: m[2], mimeType: m[1] };
}

function toPiUserContent(content: string | ContentPart[]): Message & { role: 'user' } {
  if (typeof content === 'string') {
    return { role: 'user', content, timestamp: Date.now() };
  }
  return {
    role: 'user',
    content: content.map((p) =>
      p.type === 'text' ? { type: 'text' as const, text: p.text } : toPiImage(p.image_url.url),
    ),
    timestamp: Date.now(),
  };
}

/**
 * ModelMessage[] → pi Context。system 抽出拼 systemPrompt (pi 单独收); assistant 合成最小
 * AssistantMessage (callModel 纠错重试轮的 assistant 回填; usage 置零 — 历史轮不重复计量)。
 */
export function toPiContext(messages: ModelMessage[], model: PiModel): Context {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .join('\n\n');
  const turns: Message[] = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'assistant') {
        const text = typeof m.content === 'string'
          ? m.content
          : m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
        const assistant: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
          stopReason: 'stop',
          timestamp: Date.now(),
        };
        return assistant;
      }
      return toPiUserContent(m.content);
    });
  return system ? { systemPrompt: system, messages: turns } : { messages: turns };
}

/**
 * pi Usage → 本仓 ModelUsage。语义对齐 (types.ts: `in` = 总 prompt token 含命中段, cacheHit ⊆ in):
 * pi 的 input **不含** cacheRead/cacheWrite (anthropic input_tokens / openai prompt-cached 均已扣,
 * providers/*.js 实测) → in = input + cacheRead + cacheWrite 才是总 prompt。cacheWrite 本仓价表无
 * 写价字段, 并入 in 按全价计 (诚实近似, 不虚构字段)。out = output 直取。
 */
export function piUsageToModelUsage(u: Usage): ModelUsage {
  return {
    in: u.input + u.cacheRead + u.cacheWrite,
    out: u.output,
    ...(u.cacheRead > 0 ? { cacheHit: u.cacheRead } : {}),
  };
}

/** pi StopReason → callModel 归一 finish 词表 (normalizeFinish 同表)。error/aborted 在上游转抛。 */
function piFinishReason(stop: AssistantMessage['stopReason']): string {
  switch (stop) {
    case 'length':
      return 'length';
    case 'toolUse':
      return 'tool_call';
    default:
      return 'stop';
  }
}

/** errorMessage 里嗅 HTTP 状态码 (pi 只给 message 串, 无结构化 status — 尽力而为, 嗅不到算 transport)。 */
function classifyPiError(message: string): ModelError {
  const m = /\b([45]\d\d)\b/.exec(message);
  if (m && m[1]) {
    return new ModelError('http', `pi: ${message.slice(0, 300)}`, { status: Number(m[1]) });
  }
  return new ModelError('transport', `pi: ${message.slice(0, 300)}`);
}

/** 「这个 api 收不下这个旋钮」只吼一次 (同 model-caps 的丢弃告警纪律: 噪音里没人看得见第一条)。 */
const topPDropShouted = new Set<string>();

/**
 * pi 通道单发: ModelRequest → completeSimple → PiCallResult。
 *
 * 两条通道并成一条之后, 原来只长在原生那条上的三样**搬到了这里**(而不是丢掉):
 *   · **effort 词表** (`reasoningEffortFor` + `model-caps.efforts`): 发错 reasoning_effort 不是降级
 *     而是 400。**只在 caps 登记过这一格时用我们的表** —— 没登记就把档位原样交给 pi, 由它按目录的
 *     `thinkingLevelMap` 夹 (自家目录它比我们清楚; 而我们的 UNKNOWN 兜底会把所有未登记模型压成 'high')。
 *   · **输出上限** (`maxOutputFor`): 别朝 glm/qwen 要 deepseek 的 384K。
 *   · **top_p / response_format**: pi 的 `SimpleStreamOptions` 没有这两项, 但有 `onPayload`
 *     (发出去之前改 body) —— 这才是它们该走的门。**不能"诚实丢弃"了事**: topP 是 best-of-N /
 *     distill 的发散度旋钮, 悄悄吃掉它会让 N 个 lens 塌成同一份 (那正是 526bcf4 在治的形状)。
 *     `onPayload` 只对 chat-completions / anthropic-messages 两种 body 形状生效, 别的 api 照旧
 *     发不出去 —— 那时**出声**, 不装作发了。
 *
 * `apiKey` 覆盖: 自有 registry 的条目自带 key (注册时就要求必填), 不必再去 auth.json/env 里找。
 * stopReason 'error'/'aborted' → ModelError (http 嗅状态码 / transport), 供 callModel 统一重试预算。
 */
export async function piRequest(
  model: PiModel,
  messages: ModelMessage[],
  req: ModelRequest,
  opts?: { apiKey?: string },
): Promise<PiCallResult> {
  const d = deps();
  const apiKey = opts?.apiKey ?? (await resolvePiApiKey(model.provider));
  if (!apiKey) {
    throw new ModelError(
      'config',
      `pi 通道: provider '${model.provider}' 无凭证 — 设对应 env key 或先在 pi 里登录 (~/.pi/agent/auth.json)`,
    );
  }
  const context = toPiContext(messages, model);
  // 采样参数按模型能力过滤 (2026-07-31)。个别路由对 temperature/topP 直接 400 (codex 拒 temperature,
  // kimi-k3 经 opencode-go 拒两者) —— 发过去不是降级而是整节点挂。丢弃要出声, 判据的单一真源在 model-caps。
  // effort: caps 登记过 → 用实测词表 (它知道目录不知道的事: 哪些字面量会被拒);
  // 没登记 → 原样交给 pi 按 thinkingLevelMap 夹。两者都吐 pi 的 ThinkingLevel 字面量。
  const level = capsFor(model.id)
    ? reasoningEffortFor(model.provider, req.thinkingLevel, model.id)
    : req.thinkingLevel;
  const reasoning: ThinkingLevel | undefined =
    model.reasoning && level && level !== 'off' ? (level as ThinkingLevel) : undefined;
  // ⚠ **采样必须算在 reasoning 之后**: 「收下但不生效」是思考模式的性质, 不是模型的固有属性
  // (deepseek 官方: 思考模式不支持 temperature/top_p, 不报错也不生效)。同一个坐标关了思考就认 ——
  // 所以判它生不生效, 得先知道这一发到底开没开思考。
  const sampling = samplingFor(model.id, req, { thinking: reasoning !== undefined });
  // 上限收敛到该模型官方能力 (调用方没给就不发, 由 pi 用目录的 maxTokens)。
  const ceiling = maxOutputFor(model.id);
  const maxTokens =
    req.maxTokens !== undefined && ceiling ? Math.min(req.maxTokens, ceiling) : req.maxTokens;
  // body 直改 (pi SimpleStreamOptions 表达不了的两项)。
  const bodyShaped = model.api === 'openai-completions' || model.api === 'anthropic-messages';
  if (sampling.topP !== undefined && !bodyShaped && !topPDropShouted.has(model.api)) {
    topPDropShouted.add(model.api);
    logger.warn(
      { model: model.id, api: model.api, topP: sampling.topP },
      `[omd/pi] ${model.api} 的请求体形状不在 top_p 注入范围内 → 本次 topP **没发出去**。` +
        '若这是 best-of-N / distill 的某个 lens, 它与别的 lens 现在跑的是同一档采样。同 api 只吼一次。',
    );
  }
  const wantTopP = bodyShaped ? sampling.topP : undefined;
  // JSON 模式: 原生那条一直在发, 并成一条不能把它丢了 (丢了只是让 parse 重试变多, 是最难察觉的那类退步)。
  const wantJsonObject = !!req.responseSchema && model.api === 'openai-completions';
  /**
   * **minimax 私有两参** (2026-08-14 实测接线, 单变量四臂):
   *
   *   ① `reasoning_split` —— 控制**推理放哪**。不发 (或 false) 时 minimax 把推理**内联进 `content`**
   *      的 `<think>…</think>` 里, 而下面取 text 只按 block 类型过滤、认不出这个标记 ⇒ 推理混进正文。
   *      后果不是"多几个字": 严格 `JSON.parse` 当场炸; 宽松抽取 (`jsonCandidates`) 会抠到 **think 里
   *      被模型自己推翻的草稿**——后者不报错, 更危险 (仓规 §坑-3「oracle 绿 ≠ 语义对」)。
   *      实测四臂: 什么都不发 → 含 think · 只发 thinking → **仍含 think** · 发 split → 干净。
   *      **所以修这条的是 split, 不是 thinking** (一开始我以为是后者, 被对照臂驳回)。
   *
   *   ② `thinking.type` —— 控制**思不思考**。minimax 不认 OpenAI 的 `reasoning_effort`
   *      (实测六档 off/low/…/xhigh 的 out token 与质量全在噪声内 = 那个旋钮在 M3 上是空的),
   *      认的是自家 `{type:'disabled'|'adaptive'}`。接上之后 `thinkingLevel:'off'` 才真的关得掉。
   *      ⚠ 这不是免费的: 实测关思考 worker-quality 正确分 **100% → 72%**(两道推理题全灭),
   *      省 out token 9×、延迟 2×。所以只在调用方**显式要 off** 时才关, 缺省一律 adaptive。
   *      ⚠ M2.x **关不掉**思考 (官方明写), 对它发 disabled 不要假设生效。
   */
  const isMinimax = model.provider === 'minimax' || model.provider === 'minimax-cn';
  const wantMinimaxShape = isMinimax && model.api === 'openai-completions';
  const onPayload =
    wantTopP !== undefined || wantJsonObject || wantMinimaxShape
      ? (payload: unknown): unknown => {
          const body = payload as Record<string, unknown>;
          if (wantTopP !== undefined) body.top_p = wantTopP;
          if (wantJsonObject) body.response_format = { type: 'json_object' };
          if (wantMinimaxShape) {
            body.reasoning_split = true;
            // ⚠ 判据用 `req.thinkingLevel` 而**不是** `level`: 后者是经 effort 词表夹过的值,
            // 而那张词表的用途是"哪些 reasoning_effort 字面量会被该 provider 拒" —— minimax 压根
            // 不认 reasoning_effort, 拿它的过滤结果去决定"开不开思考"是借错了尺子。
            // (实测踩到: caps 命中与否会让同一个 'off' 在两条路径上得出相反结果, ★② 当场红。)
            // 三档与 minimax-native 的 thinkingTypeFor 同一张表 (single source): off→disabled · high/xhigh→enabled · 其余→adaptive。
            body.thinking = { type: thinkingTypeFor(req.thinkingLevel) };
          }
          return body;
        }
      : undefined;
  let msg: AssistantMessage;
  try {
    msg = await d.completeSimple(model, context, {
      apiKey,
      ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(onPayload ? { onPayload } : {}),
    });
  } catch (e) {
    if (e instanceof ModelError) throw e;
    throw new ModelError('transport', `pi: ${(e as Error)?.message ?? String(e)}`, { cause: e });
  }
  // pi 的 complete() 对 API 错误**不抛** — resolve 出 stopReason 'error'/'aborted' 的部分消息
  // (event-stream.js: error 事件也 extractResult)。此处转回 ModelError 走 callModel 重试预算。
  if (msg.stopReason === 'aborted') {
    throw new ModelError('transport', `pi: aborted${msg.errorMessage ? `: ${msg.errorMessage}` : ''}`);
  }
  if (msg.stopReason === 'error') {
    throw classifyPiError(msg.errorMessage ?? 'unknown provider error');
  }
  const text = msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const finishReason = piFinishReason(msg.stopReason);
  // 空-content guard (INV-3 / C-5, 镜像 index.ts:363): reasoning 模型可把整个 token 预算烧在推理上,
  // 返 finish 'length' + 空 content。此前静默返 {text:''} → agent 节点 empty-done, 看着像成功。
  // 转 retryable `truncation` (截断长度部分随机, 有界重试常能过; 耗尽则调用方得"抬 maxTokens"的明确信号)。
  // 'length' + 非空 = 真 (虽被切) 答案, 原样返, 仅 finishReason 标记。
  if (finishReason === 'length' && !text.trim()) {
    throw new ModelError(
      'truncation',
      'pi: output truncated at max_tokens with empty content (reasoning consumed the budget) — raise maxTokens',
    );
  }
  return {
    text,
    usage: piUsageToModelUsage(msg.usage),
    raw: msg,
    finishReason,
  };
}
