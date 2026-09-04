#!/usr/bin/env bun
/**
 * scripts/bench-bridge —— 宿主侧 OpenAI 兼容桥 (E1c, 2026-08-26)。
 *
 * 场景: bench 容器里的 omd 需要 Opus (claude-code 订阅) 与 GPT (openai-codex 订阅) 座位,
 * 而订阅 OAuth 凭证**不进容器** (容器跑模型生成的代码, 凭证一旦入内即暴露给被测任务)。
 * 本桥跑在宿主, 容器经 `http://<宿主网关>:<port>/v1` 调用; 真正的通道路由走引擎既有
 * `callModel` (src/model/index.ts:363) —— 零第二套模型语义。
 *
 * 安全: 启动**必须**给 OMD_BRIDGE_TOKEN (fail-closed, 缺 token 拒启动);
 * 每请求校验 `Authorization: Bearer <token>`。绑定 0.0.0.0 只为容器网段可达,
 * token 即边界。桥只暴露补全面, 不暴露任何引擎控制面。
 *
 * 模型名映射: 容器侧用**裸 id** (bench provider 的 model 名不能再含冒号),
 * 桥按 OMD_BRIDGE_MAP 映射到真 coord, 形如:
 *   OMD_BRIDGE_MAP='claude-opus-5=claude-code:claude-opus-5,MiniMax-M3=minimax-cn:MiniMax-M3,gpt-5.6-sol=openai-codex:gpt-5.6-sol'
 * 未映射的模型名 → 404 (不猜, 不透传任意 coord —— 桥的暴露面 = 映射表的白名单)。
 *
 * stream 兼容: `stream:true` 时以单块 SSE 返回完整内容 + [DONE] (兼容捷径;
 * pi 的 openai 客户端两种都吃, 真流式待实测需要再做)。
 */
import type { ModelMessage, ModelRequest, ModelResponse } from '../src/model/types';
import { runToolCallTurn, type OpenAiToolCall, type OpenAiToolDecl, type WireMessage } from '../src/model/claude-sdk-toolcall';

/**
 * 订阅 OAuth 座 (无 base URL + API key, 所以进不了字节级透传白名单)。
 * 这两族是 translate 分支的全部住户, 也正是工具面此前蒸发的那两族。
 */
export function isSubscriptionCoord(coord: string | undefined): boolean {
  return !!coord && (coord.startsWith('claude-code:') || coord.startsWith('openai-codex:'));
}

export interface BridgeDeps {
  call: (req: ModelRequest) => Promise<ModelResponse>;
  /** 裸 model id → 真 coord;undefined = 不在白名单。 */
  mapModel: (id: string) => string | undefined;
}

export function parseBridgeMap(spec: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of (spec ?? '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    m.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return m;
}

interface OpenAiChatBody {
  model?: string;
  messages?: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: OpenAiToolCall[] }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  /** 2026-09-04: 工具面。translate 分支此前整条丢弃它 —— 那正是 opus/gpt 坐不了 conductor 的原因。 */
  tools?: OpenAiToolDecl[];
}

/**
 * minimax 透传道 (2026-08-26, 批 6 终局根因修): callModel 是**纯文本单发**, 桥的 translate 模式
 * 静默丢 `tools` 字段 → 容器内 agent 环的工具调用面整条蒸发 (MiniMax 只能文本假装调工具,
 * 零真实写入)。工具座必须走**字节级透传**: body 原样 (model 换真 id) 直达 minimax 原生
 * OpenAI-形状端点, `tools`/`tool_calls` 原生往返。文本座 (Opus/GPT, 单发结构化输出) 留 translate。
 */
export interface PassthroughRoute {
  url: string;
  apiKey: string;
  modelId: string;
}

/**
 * deepseek 透传前的形状归一 (2026-09-03, smoke8-dsw 第二次根因): pi 的 openai-completions 客户端把 system 发成
 * `role: "developer"` (OpenAI 新形状), minimax 吃, deepseek 400「messages[0].role: unknown variant」。只改这一个字,
 * 其余字节原样 —— 这不是 translate, 是同一形状里两家方言的一个词。
 */
export function normalizeForDeepseek<T extends { messages?: Array<Record<string, unknown>>; stream?: boolean; stream_options?: unknown; store?: unknown }>(body: T): T {
  // stream_options: deepseek 对「stream_options 而 stream≠true」400 (smoke8-dsw 第三次根因); store: OpenAI 专有, 不带。
  // ⚠ 一律剥 stream_options: 透传道上游恒 stream=false (单块回包再按需包成 SSE, 见 handlePassthrough), 留着就是 400。
  const { stream_options: _so, store: _st, ...rest } = body as T & { stream_options?: unknown; store?: unknown };
  void _so; void _st;
  const out = rest as unknown as T;
  if (!Array.isArray(out.messages)) return out;
  return { ...out, messages: out.messages.map((m) => (m.role === 'developer' ? { ...m, role: 'system' } : m)) };
}

export async function handlePassthrough(
  body: OpenAiChatBody & Record<string, unknown>,
  route: PassthroughRoute,
): Promise<{ status: number; json: unknown }> {
  const upstreamBody = { ...body, model: route.modelId, stream: false };
  let res: Response;
  try {
    res = await fetch(route.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${route.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    return { status: 502, json: { error: { message: `bridge passthrough: ${(e as Error).message}` } } };
  }
  const json = await res.json().catch(() => ({ error: { message: 'passthrough: 上游响应不是 JSON' } }));
  // ⚠ 2026-08-27 实测根因: minimax 把**软错误塞进 HTTP 200** —— body 形如
  //   {"choices": null, "base_resp": {"status_code": 2062, "status_msg": "已达到 Token Plan 速率限制…"}}
  // 字节透传原样转发时, 引擎看见 200 当成功, 却拿不到 choices → conductor
  // 「未产出有效 plan: not JSON: Unexpected EOF」→ 整个 run 崩成 infra-error。
  // 一次 40 并发的批里命中 1156 次, 该批 72% trial 报废。
  // 这正是本仓「fail-open 可以吞异常, 不许吞证据」的反面: 200 把限流伪装成成功,
  // 引擎连重试的机会都没有。故在此把上游的软错误翻成真错误码, 让重试路径通电。
  // 2062 = 速率限制 → 429 (可重试); 其余非零 status_code → 502 (上游异常)。
  const baseResp = (json as { base_resp?: { status_code?: number; status_msg?: string } })?.base_resp;
  const upstreamCode = baseResp?.status_code;
  if (typeof upstreamCode === 'number' && upstreamCode !== 0) {
    const mapped = upstreamCode === 2062 ? 429 : 502;
    process.stderr.write(
      `[bench-bridge] 上游软错误 base_resp.status_code=${upstreamCode} → 翻成 ${mapped}: ${baseResp?.status_msg ?? ''}\n`,
    );
    return {
      status: mapped,
      json: { error: { message: `minimax base_resp ${upstreamCode}: ${baseResp?.status_msg ?? ''}` } },
    };
  }
  return { status: res.status, json };
}

/**
 * 订阅座的**工具转发**分支 (2026-09-04)。
 *
 * 为什么单独一条: `callModel` 对 claude-code 走的是完成位通道 (`claude-sdk-complete`, 头注写明
 * 「tools 全空、无 MCP」), 于是带 tools 的请求在 translate 里工具面整条蒸发 —— 实测 smoke8-oc
 * opus 当 conductor **8/8 零派发** (`toolCalls:0 / tokensOut:44`), 而同一个 opus 本地直连
 * 6/10 success、工具调用 8–18 次。这是通道缺口, 不是模型能力。
 *
 * 工具**不在这里执行**: handler 是桩, 截获 `tool_use` 就中止, 转成 OpenAI `tool_calls` 交回容器 ——
 * 工具要操作容器的 /workspace, 桥在宿主, 在这边执行就是错的机器。
 * 可行性由 `scripts/claude-sdk-toolcall-passthrough-probe.ts` 实测坐实 (handler 未被调用即截获)。
 */
export async function handleSubscriptionToolCall(
  body: OpenAiChatBody,
  coord: string,
): Promise<{ status: number; json: unknown }> {
  const modelId = coord.slice(coord.indexOf(':') + 1);
  try {
    const r = await runToolCallTurn({
      modelId,
      messages: (body.messages ?? []) as WireMessage[],
      tools: body.tools ?? [],
      ...(body.max_tokens ?? body.max_completion_tokens ? { maxTokens: (body.max_tokens ?? body.max_completion_tokens)! } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
    });
    return {
      status: 200,
      json: {
        id: `chatcmpl-bridge-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: r.text || null,
              ...(r.toolCalls.length ? { tool_calls: r.toolCalls } : {}),
            },
            finish_reason: r.finishReason,
          },
        ],
        usage: { prompt_tokens: r.usage.in, completion_tokens: r.usage.out, total_tokens: r.usage.in + r.usage.out },
      },
    };
  } catch (e) {
    // 吞异常不许吞证据: 原文透传, 502 让客户端知道是桥后侧挂了 (同 translate 分支的纪律)。
    const msg = (e as Error).message;
    process.stderr.write(`[bench-bridge] 订阅座工具转发失败 (${coord}): ${msg}\n`);
    return { status: 502, json: { error: { message: `subscription tool-call channel: ${msg}` } } };
  }
}

/** 纯处理器: OpenAI body → callModel → OpenAI 响应体 (或错误 {status,error})。 */
export async function handleChatCompletions(
  body: OpenAiChatBody,
  deps: BridgeDeps,
): Promise<{ status: number; json: unknown }> {
  const id = body.model?.trim();
  if (!id) return { status: 400, json: { error: { message: 'model required' } } };
  const coord = deps.mapModel(id);
  if (!coord) return { status: 404, json: { error: { message: `model '${id}' 不在桥映射白名单 (OMD_BRIDGE_MAP)` } } };
  // ⚠ role 归一 (2026-08-26 终局根因, n=26): pi 的 openai 客户端把 system 以 OpenAI 新式
  // `developer` role 发出; 初版 filter 只认三 role, 把 24K 的 conductor 系统面**整条静默丢弃**,
  // 模型在真空里退回 CC 默认行为 + 用户全局 harness 填充 → 18/18 角色扮演, 而绕开 filter 的
  // 直调 8/8 干净 (serialize 把未知 role 当普通段拼入, 指令仍在)。静默 filter = 自家「fail-open
  // 吞证据」禁条的教科书违例; 现 developer→system 归一, 其余未知 role 保留并打警告。
  const messages = (body.messages ?? [])
    .map((m) => (m.role === 'developer' ? { ...m, role: 'system' } : m))
    .filter((m) => {
      const ok = m.role === 'system' || m.role === 'user' || m.role === 'assistant';
      if (!ok) process.stderr.write(`[bench-bridge] 未知 role '${String(m.role)}' 的消息被弃 (内容前 60: ${JSON.stringify(String(m.content).slice(0, 60))})\n`);
      return ok;
    }) as unknown as ModelMessage[];
  if (messages.length === 0) return { status: 400, json: { error: { message: 'messages required' } } };
  // JSON 模式 (2026-08-29): OpenAI 的 `response_format:{type:'json_object'}` 是一条**承诺** ——
  // 客户端据此直接 `JSON.parse(text)`, 不做围栏剥离。此前本桥把这个字段**静默丢掉**:
  // 客户端要了保证、什么也没得到、也没收到任何错误信号。
  // 实测代价 (ResearchRubrics 判官接桥): 20 条 rubric 里大半 `JSON decode error`,
  // 判词全成 Error/score=0 —— 看起来像"报告一条都没达标", 实则判官根本没判成。
  // 那正是本仓禁的静默降级形状 (与 role 归一那次同族)。
  // 修法: 上游没有通用 JSON 模式旋钮 (omd 走的是 responseSchema/Zod, 需要 schema),
  // 所以这里做两件**看得见**的事: ① 追加一句系统指令; ② 回程剥围栏取首个 JSON 对象。
  const wantsJson = (body as { response_format?: { type?: string } }).response_format?.type === 'json_object';
  if (wantsJson) {
    messages.push({ role: 'system', content: 'Reply with a single raw JSON object and nothing else. No prose, no markdown code fences.' } as unknown as ModelMessage);
  }
  let res: ModelResponse;
  try {
    res = await deps.call({
      messages,
      model: coord,
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
      ...(body.max_tokens ?? body.max_completion_tokens
        ? { maxTokens: (body.max_tokens ?? body.max_completion_tokens)! }
        : {}),
    });
  } catch (e) {
    // 上游通道错误原文透传 (吞异常不许吞证据); 502 让客户端知道是桥后侧挂了。
    return { status: 502, json: { error: { message: `bridge upstream: ${(e as Error).message}` } } };
  }
  return {
    status: 200,
    json: {
      id: `omdbridge-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: id,
      choices: [
        { index: 0, message: { role: 'assistant', content: wantsJson ? extractJsonText(res.text ?? '') : (res.text ?? '') }, finish_reason: 'stop' },
      ],
      usage: {
        prompt_tokens: res.usage?.in ?? 0,
        completion_tokens: res.usage?.out ?? 0,
        total_tokens: (res.usage?.in ?? 0) + (res.usage?.out ?? 0),
      },
    },
  };
}

/**
 * 单块 SSE 包装 (stream 兼容捷径)。tool_calls 原样进 delta —— 丢了 = agent 环工具面蒸发。
 *
 * **usage 必须单独再发一块** (2026-08-29 实测修): 客户端 (pi 的 openai-completions 路) 发的是
 * `stream:true` + `stream_options:{include_usage:true}`, 按 OpenAI 约定, 服务端应在末尾多发一块
 * `choices:[]` + `usage:{...}`。此前本函数只从 `choices` 造块, **usage 整个丢掉**, 于是:
 *
 *   容器里 `.omd/tui-usage.jsonl` 每一行 in=0/out=0, 每个节点的 `tokenUsage` 也是 0
 *   → **整个 bench 的 token 账是空的**: 协调税占比、座位成本、budgetTokens 全部量不了。
 *
 * ⚠ 定位过程记一笔 (差点归错因): 先怀疑「omd 对 openai 兼容 provider 不解析 usage」。
 * 用一个假 OpenAI 服务器直接量了一次 —— pi 确实发了 `include_usage:true`, 服务端给 usage 块时
 * omd 记到 `{in:123,out:45}`, **引擎侧本来就是对的**。错只在这座桥。
 * (照本仓 P-2: 一条命令就能看到的事别用推的。)
 */
export function toSingleChunkSse(completion: unknown): string {
  const c = completion as {
    id?: string; model?: string;
    usage?: unknown;
    choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown }; finish_reason?: string }>;
  };
  const msg = c.choices?.[0]?.message ?? {};
  const chunk = {
    id: c.id ?? `omdbridge-${Date.now()}`,
    object: 'chat.completion.chunk',
    model: c.model ?? '',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        content: msg.content ?? '',
        ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
      },
      finish_reason: c.choices?.[0]?.finish_reason ?? 'stop',
    }],
  };
  // usage 块: OpenAI 的 include_usage 约定是**末尾一块 choices 为空、只带 usage**。
  // 无 usage 时不发这一块 (缺席 ≠ 0: 发一个全零的 usage 会把"没量到"写成"量到了 0",
  // 正是本仓坑 ① 要防的那种抹平)。
  const usageChunk = c.usage
    ? `data: ${JSON.stringify({
        id: chunk.id, object: 'chat.completion.chunk', model: chunk.model, choices: [], usage: c.usage,
      })}\n\n`
    : '';
  return `data: ${JSON.stringify(chunk)}\n\n${usageChunk}data: [DONE]\n\n`;
}

/**
 * JSON 模式的回程处理: 从模型正文里抠出**第一个完整 JSON 对象**(容忍 ```json 围栏与前后散文)。
 *
 * 抠不出来就**原样返回** —— 让客户端自己的 JSON.parse 抛在它自己那一层, 拿到真正的原文;
 * 桥在这里替它编一个 `{}` 会把"模型没照做"抹成"模型说了空对象"(仓规坑 ①)。
 */
export function extractJsonText(text: string): string {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)?.[1]?.trim();
  for (const cand of [fenced, t]) {
    if (!cand) continue;
    const a = cand.indexOf('{');
    const b = cand.lastIndexOf('}');
    if (a >= 0 && b > a) {
      const slice = cand.slice(a, b + 1);
      try { JSON.parse(slice); return slice; } catch { /* 下一个候选 */ }
    }
  }
  return text;
}

export function checkAuth(header: string | null, token: string): boolean {
  return header === `Bearer ${token}`;
}

if (import.meta.main) {
  const token = process.env.OMD_BRIDGE_TOKEN?.trim();
  if (!token) {
    process.stderr.write('bench-bridge: OMD_BRIDGE_TOKEN 缺失 —— 无鉴权不启动 (fail-closed)\n');
    process.exit(1);
  }
  const map = parseBridgeMap(process.env.OMD_BRIDGE_MAP);
  if (map.size === 0) {
    process.stderr.write('bench-bridge: OMD_BRIDGE_MAP 空 —— 白名单为空的桥没有意义\n');
    process.exit(1);
  }
  const port = Number(process.env.OMD_BRIDGE_PORT ?? 4519);
  // 独立部署雷 (见 src/model/claude-sdk-complete.ts 头注): 脱离会话链的 CLI 会加载用户全局
  // CLAUDE.md 并压过 systemPrompt。桥自备只含凭证的隔离配置目录, 传给全部子调用。
  if (!process.env.CLAUDE_CONFIG_DIR) {
    const { mkdirSync, copyFileSync, existsSync } = await import('node:fs');
    const iso = `${process.env.HOME}/.omd/bridge-claude-home`;
    mkdirSync(iso, { recursive: true });
    const cred = `${process.env.HOME}/.claude/.credentials.json`;
    if (existsSync(cred)) copyFileSync(cred, `${iso}/.credentials.json`);
    process.env.CLAUDE_CONFIG_DIR = iso;
    process.stderr.write(`[bench-bridge] CLAUDE_CONFIG_DIR → ${iso} (隔离, 防用户全局 harness 注入)\n`);
  }
  // 一次性子进程 + 文件传参 + **有界并发 worker 池** (2026-08-26 二改):
  // 初版顶层**串行**队列是「异步上下文退化」疑点下的排除法产物; 该疑点后被终局根因
  // (filter 静默丢 developer role, 所有形状共用同一坏 filter, 形状实验整组被污染) 取代。
  // 串行队列在 8 容器并发下是独木桥: 队列深度 × 单发分钟级延迟 = E2 首批观测的 30 分钟
  // 尾延迟, spec 段超时 7/10 的直接机理。单发形状 (一次性子进程 + 文件传参) 一字不动,
  // 只把「一次一个」改成「至多 N 个同时」; 每发写一行延迟证据 (排队 ms + 执行 ms)。
  type Job = { req: ModelRequest; resolve: (r: ModelResponse) => void; reject: (e: Error) => void; enqueuedAt: number };
  const queue: Job[] = [];
  // 唤醒队列而非单槽: N 个 worker 同时空闲时各挂一个 resolver, 单槽会互相覆写,
  // 被覆写的 worker 永远醒不来 (并发池的经典饿死形态)。入队唤一个, 醒来抢不到活再睡。
  const sleepers: Array<() => void> = [];
  const callViaQueue = (req: ModelRequest): Promise<ModelResponse> =>
    new Promise((resolve, reject) => {
      queue.push({ req, resolve, reject, enqueuedAt: Date.now() });
      sleepers.shift()?.();
    });
  const concurrency = Math.max(1, Number(process.env.OMD_BRIDGE_CONCURRENCY ?? 4) || 4);
  const runWorker = async (workerId: number): Promise<void> => {
    const { writeFileSync, rmSync } = await import('node:fs');
    for (;;) {
      const job = queue.shift();
      if (!job) {
        await new Promise<void>((r) => sleepers.push(r));
        continue;
      }
      const startedAt = Date.now();
      try {
        const tmp = `/tmp/bench-call-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
        writeFileSync(tmp, JSON.stringify({ coord: job.req.model, messages: job.req.messages, maxTokens: job.req.maxTokens, temperature: job.req.temperature, topP: job.req.topP }));
        const proc = Bun.spawn(['bun', new URL('./bench-call.ts', import.meta.url).pathname, tmp], { stdout: 'pipe', stderr: 'inherit' });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        rmSync(tmp, { force: true });
        const j = JSON.parse(out || '{"ok":false,"error":"empty subprocess output"}') as
          | { ok: true; text: string; usage?: { in: number; out: number } }
          | { ok: false; error: string };
        if (!j.ok) throw new Error(j.error);
        job.resolve({ text: j.text, usage: j.usage } as ModelResponse);
      } catch (e) {
        job.reject(e as Error);
      } finally {
        // 延迟证据行 (E2 首批量不到单发延迟的补尺): 排队多久 + 跑多久 + 当下队列深度。
        process.stderr.write(
          `[bench-bridge] w${workerId} ${job.req.model} queued=${startedAt - job.enqueuedAt}ms exec=${Date.now() - startedAt}ms depth=${queue.length}\n`,
        );
      }
    }
  };
  for (let w = 0; w < concurrency; w++) void runWorker(w);
  const deps: BridgeDeps = { call: callViaQueue, mapModel: (id) => map.get(id) };
  // 透传道凭证 (启动期一次解析, env → auth.json 同引擎链)。缺 = 透传不可用, 响亮打一行,
  // minimax 路由退回 translate (工具面蒸发, 但不静默 —— 这一行就是证据)。
  const { minimaxApiKey } = await import('../src/model/minimax-native');
  const { resolvePiApiKey } = await import('../src/model/pi-transport');
  const passthroughKey = minimaxApiKey() ?? (await resolvePiApiKey('minimax-cn'));
  // deepseek 透传凭证: 同引擎 providers.ts 的来源 (DEEPSEEK_API_KEY, bun 自动读 cwd 的 .env)。缺 = deepseek 路由退回 translate, 响亮打一行。
  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim() || undefined;
  if (!deepseekKey) process.stderr.write('[bench-bridge] ⚠ DEEPSEEK_API_KEY 缺失 → deepseek 路由退回 translate (agent 工具面将蒸发)\n');
  if (!passthroughKey) {
    process.stderr.write('[bench-bridge] ⚠ minimax 凭证缺失 → 透传道不可用, minimax 路由退回 translate (agent 工具面将蒸发)\n');
  }
  Bun.serve({
    port,
    hostname: '0.0.0.0',
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);
      if (!checkAuth(req.headers.get('authorization'), token)) {
        return Response.json({ error: { message: 'unauthorized' } }, { status: 401 });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return Response.json({ object: 'list', data: [...map.keys()].map((id) => ({ id, object: 'model' })) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = (await req.json().catch(() => ({}))) as OpenAiChatBody & Record<string, unknown>;
        // 工具座路由: minimax / deepseek 坐标走字节级透传 (tools/tool_calls 原生往返); 其余走 translate。
        // deepseek (2026-09-03, smoke8-dsw 根因): 它是 OpenAI 形状端点, 走 translate 时 tools 被剥, conductor 一发文字就结束 (8/8 零派发)。
        const coordForRoute = body.model ? map.get(body.model.trim()) : undefined;
        const r = coordForRoute?.startsWith('minimax-cn:') && passthroughKey
          ? await handlePassthrough(body, {
              url: `${(process.env.MINIMAX_BASE_URL?.replace(/\/$/, '') ?? 'https://api.minimaxi.com/v1')}/text/chatcompletion_v2`,
              apiKey: passthroughKey,
              modelId: coordForRoute.slice('minimax-cn:'.length),
            })
          : coordForRoute?.startsWith('deepseek:') && deepseekKey
            ? await handlePassthrough(normalizeForDeepseek(body), {
                url: `${(process.env.DEEPSEEK_BASE_URL?.replace(/\/$/, '') ?? 'https://api.deepseek.com')}/chat/completions`,
                apiKey: deepseekKey,
                modelId: coordForRoute.slice('deepseek:'.length),
              })
            // 订阅座 (claude-code / openai-codex) 带 tools → 工具转发位。
            // 判据是「带没带 tools」而不是座位名: 不带 tools 的调用 (verifier 单发判词) 走
            // 既有 translate 一个字节不变, 零回归。
            : isSubscriptionCoord(coordForRoute) && (body.tools?.length ?? 0) > 0
              ? await handleSubscriptionToolCall(body, coordForRoute!)
              : await handleChatCompletions(body, deps);
        // 调试观测位 (env 开): 每笔请求/响应原文写入磁盘 —— 桥是唯一能看见"容器侧模型到底
        // 说了什么"的位置 (任务容器随 trial 回收, 容器内 .omd 现场拿不回来)。
        const logDir = process.env.OMD_BRIDGE_LOG_DIR?.trim();
        if (logDir) {
          const { mkdirSync, writeFileSync } = await import('node:fs');
          try {
            mkdirSync(logDir, { recursive: true });
            writeFileSync(`${logDir}/${Date.now()}-${body.model ?? 'x'}.json`, JSON.stringify({ req: body, status: r.status, res: r.json }, null, 1));
          } catch (e) {
            process.stderr.write(`[bench-bridge] 观测写入磁盘失败 (不影响转发): ${(e as Error).message}\n`);
          }
        }
        if (r.status === 200 && body.stream) {
          return new Response(toSingleChunkSse(r.json), {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return Response.json(r.json as Record<string, unknown>, { status: r.status });
      }
      return Response.json({ error: { message: 'not found' } }, { status: 404 });
    },
  });
  process.stderr.write(`[bench-bridge] 0.0.0.0:${port} · ${map.size} 模型白名单 · token 已启用\n`);
  // pidfile: 重启一律走 scripts/bench-bridge-restart.sh 按 pid 杀。
  // 2026-08-27 实账: `pkill -f 'bench-bridge.ts'` 与重启写在同一条命令行, pkill 自匹配到
  // 发起它的 shell, 桥死而重启没跑, 三个 code80-m3 批整批作废 (results/.../VOID.md)。
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${process.env.HOME}/.omd/bench-bridge.pid`, String(process.pid));
  } catch (e) {
    process.stderr.write(`[bench-bridge] pidfile 写入失败 (桥照常服务, 但重启脚本会退回 pgrep): ${(e as Error).message}\n`);
  }
}
