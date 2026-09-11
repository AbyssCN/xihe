/**
 * callModel — provider-agnostic single-shot inference (mimo-leaf contract piece 1).
 *
 * One request → one response (INV-1). No tool loop, no multi-turn: an agentic
 * leaf goes through executor='agent' (omd own-loop), not here. When a
 * `responseSchema` is given the reply is JSON-parsed + Zod-validated and only a
 * validated object is returned; transport, parse and validation failures share a
 * single bounded retry budget (INV-3), validation/parse failures re-prompt with
 * the concrete error, transport failures back off exponentially.
 */
import type { ModelMessage, ModelRequest, ModelResponse, ModelUsage } from './types';
import { getProvider } from './providers';
import { emitModelUsage } from './accounting';
import { resolvePiModel, piModelFromProviderConfig, piRequest, type PiModel } from './pi-transport';
import { CLAUDE_SDK_PROVIDER, sdkCompleteRaw } from './claude-sdk-complete';
import { AGY_CLI_PROVIDER, agyCompleteRaw } from './agy-cli-complete';
import { MINIMAX_NATIVE_PROVIDERS, minimaxCompleteRaw } from './minimax-native';
import { reportProviderFailure, cooldownMsFor } from './provider-health';
import { reportTruncation } from './truncation';
import { capsFor } from './model-caps';

export type {
  ContentPart,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ProviderApi,
  ProviderConfig,
  Role,
} from './types';
export {
  registerProvider,
  getProvider,
  listProviders,
  clearProviders,
  registerProvidersFromEnv,
  registerProvidersFromModelsJson,
} from './providers';

export type ModelErrorKind = 'config' | 'transport' | 'http' | 'parse' | 'validation' | 'truncation';

/**
 * 故障归属 —— **冷却轴**(provider-health)。回答的是「换个 provider 有没有用」:
 *   `provider` = 这个 provider 现在不可用 (超时/限流/内部错/坏 key) → 冷却 + 顺延兜底
 *   `quota`    = 同上但属配额耗尽 → 冷却窗按周期档算 (与 402/403 同口径)
 *   `request`  = 我们这一发请求本身错 (参数不合法) → **不冷却**, 换 provider 也不解决
 */
export type ModelFault = 'provider' | 'quota' | 'request';

/** Typed error so a node's on_failure / a caller can branch on the failure mode. */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  /** 1-based attempt count when thrown; set at throw time so callers can budget on it (INV-3). */
  attempts: number;
  /** **只放真 HTTP 状态码**。provider 自己的业务码放 `providerCode` —— 一格一义 (S-40)。 */
  readonly status?: number;
  /** provider 自己的错误码原文 (minimax `base_resp.status_code` 等)。只用于留痕与判词, 不参与判据。 */
  readonly providerCode?: string;
  /** 冷却轴的显式表态; 省略 → 由 `status` 启发式判 (老调用点行为不变)。 */
  readonly fault?: ModelFault;
  /**
   * 环轴的显式表态: **再转一轮有没有用**; 省略 → 由 `kind` 判。
   * ⚠ 与 `fault` **正交**, 一个字段服务不了两轴: 坏 key 该冷却 (换座位能跑) 但本跑再转必然同样错。
   */
  readonly transient?: boolean;
  constructor(
    kind: ModelErrorKind,
    message: string,
    opts?: {
      attempts?: number;
      status?: number;
      cause?: unknown;
      providerCode?: string;
      fault?: ModelFault;
      transient?: boolean;
    },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ModelError';
    this.kind = kind;
    this.attempts = opts?.attempts ?? 0;
    this.status = opts?.status;
    this.providerCode = opts?.providerCode;
    this.fault = opts?.fault;
    this.transient = opts?.transient;
  }
}

interface RawResult {
  text: string;
  usage: ModelUsage;
  raw: unknown;
  /** Normalised finish reason (see ModelResponse.finishReason). */
  finishReason?: string;
}

/**
 * 一个解析好的调用目标 —— **只有一种**(2026-08-01)。
 *
 * 此前这里是个判别联合 (`own` 走本文件手写的 HTTP, `pi` 走 pi-transport)。两条传输并成一条之后,
 * 解析仍是两个来源、但产物同一种: 自有 registry 命中 → 把条目按 pi `Model` 的形状表达出来
 * (端点与凭证来自 registry, 协议知识来自 pi 目录, 见 `piModelFromProviderConfig`);
 * 否则探 pi 目录。**"走哪条路"这个问题从此不存在**, 于是"某条路上忘了做某件事"也不存在。
 */
interface ResolvedTarget {
  piModel: PiModel;
  resolved: string;
  /** 自有 registry 条目自带的 key (注册时必填) —— 有它就不必再去 auth.json/env 里找。 */
  apiKey?: string;
}

function resolveModel(req: ModelRequest): ResolvedTarget {
  const raw = req.model;
  if (!raw) {
    throw new ModelError('config', 'callModel: req.model required (format "provider:modelId")');
  }
  const sep = raw.indexOf(':');
  const providerName = sep === -1 ? raw : raw.slice(0, sep);
  // ⓪ Claude 订阅通道 (NOTES 2026-08-10): 不在两栈里, 造合成 target —— piModel 只有 doRequest
  //    消费, 而 claude-code 分支在那里改走 SDK, 这个 stub 不会被当真模型用。
  if (providerName === CLAUDE_SDK_PROVIDER) {
    const modelId = sep === -1 ? '' : raw.slice(sep + 1);
    if (!modelId) throw new ModelError('config', `callModel: '${raw}' 缺 model id (claude-code 无 defaultModel)`);
    return {
      piModel: { id: modelId, provider: CLAUDE_SDK_PROVIDER, contextWindow: 1_000_000 } as unknown as PiModel,
      resolved: `${CLAUDE_SDK_PROVIDER}:${modelId}`,
    };
  }
  // ⓪' Google 订阅通道 (agy CLI, 2026-09-11): 同 claude-code 形状 —— 合成 target, doRequest 处改走 agy 子进程。
  if (providerName === AGY_CLI_PROVIDER) {
    const modelId = sep === -1 ? '' : raw.slice(sep + 1);
    if (!modelId) throw new ModelError('config', `callModel: '${raw}' 缺 model id (agy-cli 无 defaultModel; 见 \`agy models\`)`);
    return {
      piModel: { id: modelId, provider: AGY_CLI_PROVIDER, contextWindow: 1_000_000 } as unknown as PiModel,
      resolved: `${AGY_CLI_PROVIDER}:${modelId}`,
    };
  }
  const cfg = getProvider(providerName);
  if (cfg) {
    const modelId = sep === -1 ? cfg.defaultModel ?? '' : raw.slice(sep + 1);
    if (!modelId) {
      throw new ModelError(
        'config',
        `callModel: no model id in '${raw}' and provider '${providerName}' has no defaultModel`,
      );
    }
    return {
      piModel: piModelFromProviderConfig(providerName, modelId, cfg),
      resolved: `${providerName}:${modelId}`,
      apiKey: cfg.apiKey,
    };
  }
  // ② pi-ai 目录 (registry 不认识 → 纯目录查询, 无网络)。
  // 裸 provider 坐标 (无 ':model') 不走这条 — 必须显式 model id, 保持旧错误语义。
  const modelId = sep === -1 ? '' : raw.slice(sep + 1);
  if (modelId) {
    const piModel = resolvePiModel(providerName, modelId);
    if (piModel) return { piModel, resolved: `${providerName}:${modelId}` };
  }
  // ③ 都不认 → 既有清晰错误 (文案保持不变)。
  throw new ModelError('config', `callModel: provider '${providerName}' not registered`);
}

/**
 * 纯解析校验: 坐标能否解析成可调模型 (有 model id 或裸 provider 有 defaultModel)。
 * 解析规则单一真理源 = resolveModel — **两个来源都查**: 自有 registry 优先, miss 再探 pi-ai 目录
 * (getModel/getModels 纯查表)。不能解析 → 抛 ModelError('config')。无网络副作用。
 * 用途: wiring 层 (如 resolveVerification) fail-fast —— 把"DAG 跑完才崩"提到"DAG 跑前崩"。
 * `label` 进错误信息, 点名是哪个角色坐标坏 (如 'verifier')。
 */
export function assertModelResolvable(coord: string, label = 'model'): void {
  try {
    resolveModel({ messages: [], model: coord });
  } catch (err) {
    const msg = err instanceof ModelError ? err.message : String(err);
    throw new ModelError('config', `${label} 坐标无法解析: ${msg}`);
  }
}

/**
 * provider → 该 provider 真正接受的 `reasoning_effort` 字面量 (由弱到强)。
 * **实测事实, 不是推测** —— 发错值不是降级而是 HTTP 400/500, 整个节点白挂:
 *   - mimo / mimo-platform: 2026-07-25 实测 `Input should be 'low', 'medium' or 'high'`;
 *     'max' 与 'minimal' 均 400 (与 .env 里"ultraspeed 在 max 上 500"的旧记录同源)。
 *   - deepseek: 'high' / 'max' (R6 验 api-docs.deepseek.com)。
 * 未列的 provider 走 UNKNOWN_EFFORTS: 只发 'high' —— 保守到底, 宁可不省也不发坏参数。
 * 新增一行前请**先真打一次 API**, 别照抄别家文档。
 */
const PROVIDER_EFFORTS: Record<string, readonly string[]> = {
  mimo: ['low', 'medium', 'high'],
  'mimo-platform': ['low', 'medium', 'high'],
  deepseek: ['high', 'max'],
};
const UNKNOWN_EFFORTS: readonly string[] = ['high'];

/** 内部档 → provider 字面量的候选序 (由该档出发, 先找同义, 再向下退)。 */
const EFFORT_LADDER: Record<string, readonly string[]> = {
  off: [],
  low: ['low', 'minimal'],
  medium: ['medium', 'low'],
  high: ['high', 'medium'],
  // xhigh 想要"最强": 有 max 用 max, 没有就**降到 high** (owner 2026-07-25: xhigh 不是每个模型都有)。
  xhigh: ['max', 'high'],
};

/**
 * 内部 thinkingLevel → 该 provider 可接受的 reasoning_effort 字面量; 取不到 → undefined (不发该字段)。
 * 'off' 恒不发 —— OpenAI 兼容端点没有统一的关思考开关 (mimo 实测 enable_thinking/thinking 三种写法
 * 全被忽略, 输出 token 与不发时同量级), 与其发一个假装有效的字段, 不如诚实地什么都不发。
 */
export function reasoningEffortFor(
  provider: string,
  level: string | undefined,
  modelId?: string,
): string | undefined {
  if (!level) return undefined;
  // 词表优先级: **模型 > provider > 保守兜底**。聚合渠道 (opencode-go) 底下住着六个家族, 按 provider 查
  // 会把 deepseek 的词表套到 qwen 头上 —— 而 qwen 实测拒 'max', 发错即 400。
  const supported = (modelId && capsFor(modelId)?.efforts) ?? PROVIDER_EFFORTS[provider] ?? UNKNOWN_EFFORTS;
  for (const cand of EFFORT_LADDER[level] ?? []) {
    if (supported.includes(cand)) return cand;
  }
  return undefined;
}

/**
 * 唯一的传输出口 (2026-08-01)。此前这里按 `target.kind` 分叉去两套手写的 HTTP;
 * 现在没有分叉可分 —— 目标已经是一个 pi `Model`, 协议怎么发是 pi 的事。
 */
function doRequest(
  target: ResolvedTarget,
  messages: ModelMessage[],
  req: ModelRequest,
): Promise<RawResult> {
  // Claude 订阅完成位: 单发 SDK query, 外层重试/截断守卫/schema 纠错/熔断原样复用。
  if ((target.piModel as { provider?: string }).provider === CLAUDE_SDK_PROVIDER) {
    return sdkCompleteRaw((target.piModel as { id: string }).id, messages, req);
  }
  if ((target.piModel as { provider?: string }).provider === AGY_CLI_PROVIDER) {
    return agyCompleteRaw((target.piModel as { id: string }).id, messages, req);
  }
  // MiniMax 原生位 (owner 2026-08-14): pi 目录给 minimax-cn 的是 anthropic 兼容那条端点, 它把推理
  // **内联进 text** (`<think>…</think>{…}`), 而本仓对 `<think>` 零处理 → 量产座位格式守实测 37%。
  // 原生 chatcompletion_v2 上 content 干净、推理单列, 且能显式发 thinking:adaptive。见 minimax-native.ts。
  if (MINIMAX_NATIVE_PROVIDERS.has((target.piModel as { provider?: string }).provider ?? '')) {
    const p = (target.piModel as { provider?: string }).provider!;
    return minimaxCompleteRaw((target.piModel as { id: string }).id, messages, req, {
      provider: p,
      ...(target.apiKey ? { apiKey: target.apiKey } : {}),
    });
  }
  // piRequest 的 PiCallResult 与 RawResult 结构同形 (text/usage/raw/finishReason)。
  return piRequest(target.piModel, messages, req, target.apiKey ? { apiKey: target.apiKey } : undefined);
}

/**
 * 结构化回复的 JSON 正文候选 (按优先序), 调用方逐个试 parse, 第一个成的算数。
 *
 * **围栏不是可靠线索, 因为 payload 里天然会有围栏。** 判官协议 (verifier.ts 的责备集 D-1)
 * 要求把 ```blame 围栏写进 `reason` **字段值**里 —— 于是一份完全合规的结构化判词内部就含
 * 内嵌围栏。老实现只有一条路 (「第一个 ``` 到下一个 ```」), 把 payload 里的内嵌围栏当成
 * 包裹层抠出来, 送进 JSON.parse 的是 `blame\n[...]`:
 *
 *   2026-08-11 run 7d50fda2 —— `ModelError: invalid JSON: Unexpected identifier "blame"`,
 *   模型层三次纠偏重试全撞同一条 (回的其实是**对的** JSON), 判卷失败连累一个已收敛的 run。
 *   已用真样本形状复现, 闸见 model/json-fence.test.ts。
 *
 * 三个候选各治一种形状, 顺序即"越少猜越靠前":
 *   ① 原文 —— 裸 JSON (最常见, 也正是上面那条被内嵌围栏坑掉的形状)
 *   ② 贪婪围栏 (到**最后一个** ```) —— 外层 ```json 包裹且内部含内嵌围栏
 *   ③ 懒惰围栏 (到**下一个** ```) —— 散文里夹一段围栏, 或多段围栏取第一段 (老行为)
 */
export function jsonCandidates(text: string): string[] {
  const t = text.trim();
  const out = [t];
  for (const re of [/```(?:json)?\s*([\s\S]*)```/i, /```(?:json)?\s*([\s\S]*?)```/i]) {
    const body = re.exec(t)?.[1]?.trim();
    if (body && !out.includes(body)) out.push(body);
  }
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new ModelError('transport', 'callModel: aborted during backoff'));
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new ModelError('transport', 'callModel: aborted during backoff'));
    };
    // Drop the listener on a normal wake so a long-lived signal never leaks listeners.
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 该错误是否 = provider 运行时故障 (值得熔断该 provider): fetch 失败 (非 abort) 或 HTTP 402/429/5xx。
 * abort = 调用方意图停止 (非后端故障) → 不熔断。config/parse/validation/truncation = 请求/内容问题,
 * 换 provider 也不解决 → 不熔断 (熔断只针对「这个后端此刻不健康」)。
 *
 * ## ⚠ 402 是 2026-08-06 两次真跑买来的
 *
 * 同一天两跑、两个不同 provider、同一个形状 —— **钱的问题不让熔断跳,于是自动兜底从不接管**:
 *   · `pi: Codex error: The usage limit has been reached`(额度用尽)
 *   · `pi: 402: {"code":"402","message":"Insufficient account balance"}`(余额不足)
 * 后果不是"这一发失败"而是**整趟白跑**:`roleModelWithFallback` 有一条现成的顺延链,
 * 而它只在 `usable()` 判首选不可用时才走,`usable()` = 有凭证 ∧ 不在冷却窗 —— 熔断不跳就永远可用。
 * 实测代价:4 个座位是人手工换的,而引擎本来有能力自己绕过去。
 *
 * **402 = 「这个后端在你付钱之前不会服务你」**,正是"此刻不健康"的定义,重试同一个座位必然同样失败。
 *
 * ## 403 是同一天第三跑加的(当天下午还刻意没加它)
 *
 * 上一版这里写着「没加 401/403,因为我手上一次实测都没有」。**第三跑就撞上了**:
 * `pi: 403: {"type":"RegionError","message":"The latest version of this model is only
 * available hosted in China and requires explicit opt in"}` —— judge 与 6 个子节点里的 5 个全挂在它上面。
 *
 * 它**不是凭证配错**:key 是好的、认证过了,是这个**坐标**不给你用。
 * 「认证通过但不给服务」正是熔断该管的那格 —— 重试同一个坐标必然同样失败,而换一个能成。
 *
 * ⚠ **401 仍然不加**:401 = 没认证上 = key 配错,悄悄绕过去会把一个该让人去修的配置错误藏起来
 *   (熔断的语义是"这个后端此刻不健康",不是"替你隐瞒你的 key 坏了")。同样,没实测就不加。
 * ⚠ Codex 那条**这里仍然接不住**:它经 pi 传上来时不带 HTTP status。别去匹配 "usage limit"
 *   字符串(那是给每个 provider 的措辞打地鼠)—— 探针见交接 34 §四之二。
 */
/**
 * 冷却轴: 这次失败该不该冷却该 provider 并顺延兜底 (issue #6)。
 *
 * 抛错方给了 `fault` 就听它的 —— 它比"从状态码猜"知道得多。省略才走原来的启发式,
 * 于是所有老调用点行为一个字不变 (S-40 的教训: 判据靠数值巧合成立时, 没人选过那个行为)。
 */
export function isProviderFault(err: ModelError): boolean {
  if (err.fault) return err.fault !== 'request';
  if (err.kind === 'transport') return !String(err.message).includes('abort');
  if (err.kind === 'http') {
    const s = err.status ?? 0;
    return s === 402 || s === 403 || s === 429 || s >= 500;
  }
  return false;
}

/**
 * 「再转一轮可能就好」的那一类 —— 供**环层**判断该不该提前退出用 (engine 的 `unreachable`)。
 *
 * 为什么在这里而不是在 engine 里手写一份: `isProviderFault` 已经是熔断在用的分类,
 * 一套分类两处用, 不新造第二份会漂的表。
 *
 * 2026-08-16 订正的那条: engine 此前拿 `err instanceof ModelError` 当"确定性故障"的判据,
 * 而 ModelError 的 kind 有六个 —— `parse` (invalid JSON) 与 `validation` (schema 不合)
 * 恰恰是"模型这一发没说清楚, 下一轮可能就好"的那类, 却被当成了"再转多少轮都一样"。
 * 打亮它的是 gate 座位换 M3 (`.omd/eval/gate-m3`): flash 上 0/120 从没亮过, M3 上 1/60。
 *
 * ⚠ `transport` **不算**瞬时: 它是本文件的**未分类兜底桶** (任何非 ModelError 的 provider
 *   抛错都落这儿, 含 codex 那个确定性 `Unsupported parameter`)。当瞬时就退回 2026-07-31
 *   那次 65 分钟空转。要拆它得先给那些错分对 kind, 那是另一件事。
 * ⚠ 2026-08-16 补: `http` 这一支读 `err.status`, 而 status **只放真 HTTP 码**了 ——
 *   provider 自己的业务码走 `providerCode`, 归属走 `fault`/`transient` 两个显式表态 (S-40)。
 *   此前 minimax 把业务码塞进 status, 靠"业务码都 ≥ 1000 于是落进 s >= 500"这个**数值巧合**
 *   得到今天的行为; 1004/2049 (鉴权/无效 key) 就是被它判成瞬时的。
 */
export function isTransientModelFault(err: ModelError): boolean {
  // 抛错方显式表过态就听它的 (与 `fault` 正交: 坏 key 该冷却, 但本跑再转必然同样错)。
  if (err.transient !== undefined) return err.transient;
  if (err.kind === 'parse' || err.kind === 'validation' || err.kind === 'truncation') return true;
  if (err.kind === 'http') return isProviderFault(err);
  return false;
}

export async function callModel(req: ModelRequest): Promise<ModelResponse> {
  if (!req.messages || req.messages.length === 0) {
    throw new ModelError('config', 'callModel: messages required');
  }
  const target = resolveModel(req);
  const resolved = target.resolved;
  const maxRetries = req.maxRetries ?? 2;
  const baseDelay = req.retryDelayMs ?? 250;

  // `messages` may grow with corrective turns on parse/validation failure; the
  // original request is preserved so each correction restates it from scratch.
  let messages = req.messages;
  let lastErr: ModelError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // A caller-cancelled request fails fast and is never retried — the signal is
    // intent to stop, not a transient fault (P1-B).
    if (req.signal?.aborted) {
      const aborted = new ModelError('transport', 'callModel: aborted');
      aborted.attempts = attempt;
      throw aborted;
    }
    let result: RawResult;
    try {
      result = await doRequest(target, messages, req);
    } catch (e) {
      if (req.signal?.aborted) {
        const aborted = new ModelError('transport', 'callModel: aborted', { cause: e });
        aborted.attempts = attempt + 1;
        throw aborted;
      }
      lastErr = e instanceof ModelError ? e : new ModelError('transport', String(e), { cause: e });
      lastErr.attempts = attempt + 1; // accurate budget on exhaustion (P1-C / INV-3)
      // 运行时熔断: provider-fault (429/5xx/网络) → 冷却该 provider, 后续 role 解析顺延兜底
      // (provider-health)。本次 in-flight 重试仍打原 target — 冷却只改**未来**的角色路由。
      // 402/403 走周期档长窗 (配额/计费级下线, 30s 退避无意义 — NOTES 2026-08-09 样本 A)。
      if (isProviderFault(lastErr)) {
        // 冷却窗: `fault:'quota'` 显式走周期档 (与 402/403 同口径) —— 不靠把业务码伪装成 402。
        reportProviderFailure(
          target.resolved,
          cooldownMsFor(lastErr.kind === 'http' ? lastErr.status : undefined, { period: lastErr.fault === 'quota' }),
        );
      }
      if (attempt < maxRetries) {
        await sleep(baseDelay * 2 ** attempt, req.signal);
        continue;
      }
      break;
    }

    // Silent-truncation guard: a reasoning model can spend the whole token budget on
    // reasoning and return finish_reason 'length' with EMPTY content. That is a failure, not
    // a success — the old code returned "" as if it were a real answer. Surface it as a
    // retryable `truncation` error: truncation length is partly stochastic (reasoning size
    // varies per sample), so a bounded retry often clears it; on exhaustion the caller gets a
    // clear signal to raise maxTokens. A 'length' finish with NON-empty content is a real (if
    // cut) answer and is returned untouched — only `finishReason` flags it.
    if (result.finishReason === 'length' && !result.text.trim()) {
      emitModelUsage(result.usage, resolved); // reasoning still spent tokens (INV-4: usage lands)
      lastErr = new ModelError(
        'truncation',
        'output truncated at max_tokens with empty content (reasoning consumed the budget) — raise maxTokens',
        { attempts: attempt + 1 },
      );
      if (attempt < maxRetries) {
        await sleep(baseDelay * 2 ** attempt, req.signal);
        continue;
      }
      break;
    }

    // 'length' + 非空 = 真答案但被切。老路径原样返回 → 半截文当成品往下游传 (finishReason 有生产者
    // 零消费者)。这里**必上报**: 静默截断会伪装成"模型更差 / 综合丢点", 是最难查的那类失真。
    if (result.finishReason === 'length' && result.text.trim()) {
      reportTruncation({
        model: resolved,
        out: result.usage.out,
        ...(req.maxTokens !== undefined ? { cap: req.maxTokens } : {}),
      });
    }

    if (!req.responseSchema) {
      emitModelUsage(result.usage, resolved); // V2-ECON: 通知 ledger (不持久, 守 INV-4)
      return { text: result.text, usage: result.usage, raw: result.raw, model: resolved, attempts: attempt + 1, finishReason: result.finishReason };
    }

    // Structured output: parse → validate → only ever return validated data (INV-3).
    // 候选阶梯逐个试 (见 jsonCandidates): 报错取**第一个候选**的原话 —— 那是模型真回的东西,
    // 后面几个是我们自己的猜法, 拿猜法的报错去纠正模型会把它引向别处。
    let obj: unknown;
    let parseErr: Error | undefined;
    for (const cand of jsonCandidates(result.text)) {
      try {
        obj = JSON.parse(cand);
        parseErr = undefined;
        break;
      } catch (e) {
        parseErr ??= e as Error;
      }
    }
    if (parseErr) {
      lastErr = new ModelError('parse', `invalid JSON: ${parseErr.message}`, { attempts: attempt + 1 });
      messages = [
        ...req.messages,
        {
          role: 'user',
          content: `Your previous reply was not valid JSON (${parseErr.message}). Reply with ONLY a JSON object — no prose, no code fences.`,
        },
      ];
      if (attempt < maxRetries) continue;
      break;
    }

    const parsed = req.responseSchema.safeParse(obj);
    if (parsed.success) {
      emitModelUsage(result.usage, resolved); // V2-ECON: 通知 ledger (不持久, 守 INV-4)
      return {
        text: result.text,
        parsed: parsed.data,
        usage: result.usage,
        raw: result.raw,
        model: resolved,
        attempts: attempt + 1,
        finishReason: result.finishReason,
      };
    }

    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    lastErr = new ModelError('validation', `schema validation failed: ${issues}`, { attempts: attempt + 1 });
    messages = [
      ...req.messages,
      { role: 'assistant', content: result.text },
      {
        role: 'user',
        content: `Your JSON failed schema validation (${issues}). Return a corrected JSON object that matches the schema — nothing else.`,
      },
    ];
    if (attempt < maxRetries) continue;
    break;
  }

  throw (
    lastErr ?? new ModelError('transport', 'callModel: retries exhausted with no captured error')
  );
}
