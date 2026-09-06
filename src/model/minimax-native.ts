/**
 * src/model/minimax-native —— **MiniMax 原生端点直连**(owner 2026-08-14 点名:订阅 API 直连 + adaptive thinking)。
 *
 * ## 为什么不走 pi 通道(实测,不是偏好)
 *
 * pi 目录给 `minimax-cn` 的条目是 `api: 'anthropic-messages'` @ `https://api.minimaxi.com/anthropic`。
 * 走它拿回来的 `text` 是**推理与正文粘在一起**的:
 *
 * ```
 * callModel('minimax-cn:MiniMax-M3') → "<think>The user wants…</think>\n\n{\"n\": 5}"
 * ```
 *
 * 而 omd 全仓对 `<think>` 零处理。后果不是"多几个字":严格 `JSON.parse` 当场炸,
 * 宽松抽取会抠到 think 段里**被模型自己推翻的草稿**——后者不报错,更危险。
 * 量产座位实测(`.omd/eval/m3-inproc-strip`,N=3):**格式守 37%**(剥掉 think 后 100%)。
 *
 * 原生 `POST {baseUrl}/text/chatcompletion_v2` 上同一个模型同一道题:
 * `content` 是干净的 `{"n": 5}`,推理在 `reasoning_content` 单列,且延迟更低(1.4s vs 3.1s)。
 * **脏在通道,不在模型** —— 所以修在通道,不在下游加剥离器。
 *
 * ## thinking:adaptive 是默认,而这是量出来的
 *
 * `.omd/eval/m3-thinking-mode`(直连,N=3,10 题):
 *
 * | 臂 | 正确分 | 格式守 | 平均 out |
 * |---|---|---|---|
 * | `adaptive` | **100%** | **100%** | 1153 |
 * | `disabled` | 72% | 97% | 104 |
 *
 * `disabled` 便宜一个数量级,但推理题直接归零(`reason-pricing` / `reason-parallel` 100%→0%)。
 * 所以默认 `adaptive`;**只有调用方显式要 `thinkingLevel: 'off'` 才发 `disabled`** ——
 * 那是一次显式的"用质量换成本",不是默认。
 *
 * ⚠ 各端点的**缺省**还不一样(OpenAI-compat chat/completions 省略 = adaptive;
 * anthropic-compat / Responses 省略 = 关)。所以这里**永远显式发**,不吃任何端点的缺省。
 *
 * ## 边界
 *
 * 只接**单发完成位**(callModel)。agent leaf 的工具循环走 pi-agent-core 自己的栈,不经这里 ——
 * 那条路上 `<think>` 留在 text 里的代价小得多(交付物是文件改动,不是被 parse 的正文),
 * 而且它已由 `.omd/eval/m3-agent-smoke` 实测过 G0/G1 双过。**别把这里的结论套到那条路上。**
 */
import type { ModelMessage, ModelRequest, ModelUsage } from './types';
// ModelError 住在 index —— 与 pi-transport 同一条既有循环 import(那条 2026-08 起一直在跑)。
import { ModelError, type ModelFault } from './index';

/** 认这些 provider 名 —— 两个都是同一家的端点(国内/国际站)。 */
export const MINIMAX_NATIVE_PROVIDERS = new Set(['minimax-cn', 'minimax']);

/**
 * **业务码 → 两轴归属**(2026-08-16,S-40 的后半)。
 *
 * 码表来源:官方错误码页(platform.minimax.io/docs/api-reference/errorcode ·
 * platform.minimaxi.com/docs/api-reference/errorcode,两个镜像一致)。
 *
 * 两轴**正交**,一个字段服务不了:
 *   `fault`     换个 provider 有没有用 → 冷却轴(provider-health)
 *   `transient` 本跑再转一轮有没有用   → 环轴(engine 的 unreachable / 闸级熔断)
 * 坏 key 就是那个把它们分开的例子:该冷却(换座位能跑),但本跑再转必然同样错。
 *
 * ⚠ 未登记的码 → `provider` + 瞬时。官方对 1000/未知的处置就是「请稍后再试」,
 *   而重试上限由 `callModel` 的 maxRetries 与闸级熔断两道兜着,不会无限转。
 */
function classifyBaseResp(code: number): { fault: ModelFault; transient: boolean } {
  switch (code) {
    // 凭证坏:换座位能跑 → 该冷却;同一座位再转必然同样错 → 不瞬时。
    case 1004: // 未授权 / Token 不匹配
    case 2049: // 无效 API Key
      return { fault: 'provider', transient: false };
    // 配额耗尽:冷却窗按周期档算(2056 官方原话是「等下一个 5 小时窗口」)。
    case 1008: // 余额不足
    case 2056: // 超出 Token Plan 资源限制
      return { fault: 'quota', transient: false };
    // 请求本身错:换 provider 也不解决 → **不冷却**;改参数才行 → 不瞬时。
    case 2013: // 参数错误
    case 1039: // token 限制(该调 max_tokens)
    case 1042: // 不可见/非法字符超限
      return { fault: 'request', transient: false };
    // 内容涉敏:不冷却(provider 没病),但下一轮内容不同,可能就过了 → 瞬时。
    case 1026:
    case 1027:
      return { fault: 'request', transient: true };
    // provider 侧瞬时(官方处置一律「请稍后再试」)。
    default:
      return { fault: 'provider', transient: true };
  }
}

/** 原生端点只对 M3 家族开 `thinking` 旋钮(M2.x 关不掉,发了也没有意义)。 */
const M3_ID = /^MiniMax-M3/i;

export interface MinimaxRawResult {
  text: string;
  usage: ModelUsage;
  raw: unknown;
  finishReason?: string;
}

/** minimax 原生 chat 端点。pi 目录给的 baseUrl 是 anthropic 兼容那条, 这里不用它。 */
function endpointOf(): string {
  return process.env.MINIMAX_BASE_URL?.replace(/\/$/, '') ?? 'https://api.minimaxi.com/v1';
}

/**
 * env 侧凭证。`MINIMAX_CN_API_KEY` 优先(与 pi 的 env 表同名),回落 `MINIMAX_API_KEY`
 * —— 后者是本机 `~/.pi/agent/models.json` 里 minimax-cn 条目实际引用的那个名字,
 * 两个名字并存是既成事实,这里如实兼容而不是挑一个然后让另一半静默失效。
 */
export function minimaxApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.MINIMAX_CN_API_KEY || env.MINIMAX_API_KEY || undefined;
}

/**
 * 完整凭证链:env → `~/.pi/agent/auth.json`(与全仓其余座位同一条链)。
 *
 * ⚠ **只查 env 是不够的**,而这一格差点就漏了:本机的 minimax key 存在 `auth.json` 里,
 * `MINIMAX_*` env 只活在 `.env` —— 而长驻的 MCP server / `goal-worker` 子进程**不加载 `.env`**。
 * 只认 env 的话,座位探针(带 `--env-file`)全绿,真跑起来却是无凭证。
 */
async function resolveKey(provider: string): Promise<string | undefined> {
  const fromEnv = minimaxApiKey();
  if (fromEnv) return fromEnv;
  const { resolvePiApiKey } = await import('./pi-transport');
  return resolvePiApiKey(provider);
}

/**
 * `thinkingLevel` → minimax `thinking.type`(M3 三档: enabled / adaptive / disabled)。
 * 'off' → disabled;'high' / 'xhigh' → **enabled**(始终推理);其余(缺席 / low / medium)→ adaptive。
 * 2026-09-06 之前只翻两档(off 之外一律 adaptive),于是 `OMD_AGENT_EFFORT=high` 对 M3 等于没动,
 * code80-m3-author-effort 臂白跑。证伪: 把 enabled 那支去掉 ⇒ minimax-native-thinking.test.ts 红。
 */
/**
 * 「这是不是 MiniMax 模型」按 **provider 或模型 id** 认 (2026-09-07)。
 * bench 容器里坐标是 `bench:MiniMax-M3` (经桥透传), 只看 provider 会判假 ⇒ 请求体不带 `thinking` ⇒ 上游走缺省,
 * author2-enabled 臂因此没测到 (两臂墙钟/token 逐字相同)。与 `familyOf` 同一条纪律: 家族是模型的属性, 不是路由的。
 * 证伪: 去掉 id 那支 ⇒ minimax-native-thinking.test.ts「bench: 坐标也认」红。
 */
export function isMinimaxModel(provider: string | undefined, id: string | undefined): boolean {
  if (provider === 'minimax' || provider === 'minimax-cn') return true;
  return /minimax/i.test(id ?? '');
}

export function thinkingTypeFor(level: ModelRequest['thinkingLevel']): 'enabled' | 'adaptive' | 'disabled' {
  if (level === 'off') return 'disabled';
  if (level === 'high' || level === 'xhigh') return 'enabled';
  return 'adaptive';
}

/** 本仓 usage 语义: `in` = 总 prompt token(**含**命中段), `cacheHit ⊆ in`, `out` = 生成(含推理)。 */
export function toModelUsage(u: unknown): ModelUsage {
  const o = (u ?? {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  const cacheHit = o.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    in: o.prompt_tokens ?? 0,
    out: o.completion_tokens ?? 0,
    ...(cacheHit > 0 ? { cacheHit } : {}),
  };
}

/** minimax finish_reason → callModel 归一词表(与 pi 那张同表:'length' 触发截断守卫)。 */
function normalizeFinish(r: unknown): string | undefined {
  const s = typeof r === 'string' ? r : undefined;
  if (!s) return undefined;
  if (s === 'length' || s === 'max_tokens') return 'length';
  if (s === 'tool_calls') return 'tool_use';
  return s; // 'stop' 等原样
}

/** 请求体(导出供测试逐字段核对 —— 这几个键是本文件存在的全部理由)。 */
export function buildBody(modelId: string, messages: ModelMessage[], req: ModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    // ContentPart 已是 OpenAI 形状 (text / image_url) → 原样透传, 多模态腿不额外转换。
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  // JSON 模式与 pi 那条同口径 (有 responseSchema 就要 json_object) —— 丢了只会让 parse 重试变多,
  // 而那是最难察觉的那类退步。
  if (req.responseSchema) body.response_format = { type: 'json_object' };
  // **永不吃端点缺省**: 各端点缺省不一致, 省略 = 让"开没开思考"变成一个看不见的变量。
  if (M3_ID.test(modelId)) body.thinking = { type: thinkingTypeFor(req.thinkingLevel) };
  return body;
}

/** 原生直连单发。错误一律转 {@link ModelError},交给 callModel 的重试/熔断预算。 */
export async function minimaxCompleteRaw(
  modelId: string,
  messages: ModelMessage[],
  req: ModelRequest,
  deps: { fetch?: typeof fetch; apiKey?: string; provider?: string } = {},
): Promise<MinimaxRawResult> {
  const key = deps.apiKey || (await resolveKey(deps.provider ?? 'minimax-cn'));
  if (!key) throw new ModelError('config', 'minimax: 无凭证 (env MINIMAX_CN_API_KEY / MINIMAX_API_KEY, 或 pi auth.json 的 minimax-cn 条目)');
  const doFetch = deps.fetch ?? fetch;
  const url = `${endpointOf()}/text/chatcompletion_v2`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(modelId, messages, req)),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch (e) {
    throw new ModelError('transport', `minimax: ${(e as Error)?.message ?? String(e)}`, { cause: e });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ModelError('http', `minimax: HTTP ${res.status} ${body.slice(0, 300)}`, { status: res.status });
  }
  const json = (await res.json().catch((e) => {
    throw new ModelError('transport', `minimax: 响应不是 JSON: ${(e as Error).message}`, { cause: e });
  })) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: unknown;
    base_resp?: { status_code?: number; status_msg?: string };
  };
  // ⚠ minimax 的**业务错误走 HTTP 200 + base_resp.status_code≠0**。不查这一格的话,
  // 一次配额耗尽会伪装成"模型回了个空的" —— 两种失效在下游再也分不开。
  const code = json.base_resp?.status_code;
  if (code !== undefined && code !== 0) {
    const { fault, transient } = classifyBaseResp(code);
    // ⚠ 业务码进 `providerCode`, **不进 `status`** (那格只放真 HTTP 码) —— S-40。
    // 归属靠上面那张表**显式**给出, 不靠"业务码碰巧 ≥ 1000 于是落进 s >= 500"的数值巧合。
    throw new ModelError('http', `minimax: base_resp ${code} ${json.base_resp?.status_msg ?? ''}`.trim(), {
      providerCode: String(code),
      fault,
      transient,
    });
  }
  const choice = json.choices?.[0];
  return {
    // content 就是干净正文 (推理在 reasoning_content, 本仓不消费 → 不取, 免得又粘一起)。
    text: choice?.message?.content ?? '',
    usage: toModelUsage(json.usage),
    raw: json,
    ...(normalizeFinish(choice?.finish_reason) ? { finishReason: normalizeFinish(choice?.finish_reason)! } : {}),
  };
}
