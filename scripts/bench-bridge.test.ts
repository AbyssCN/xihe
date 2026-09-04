import { describe, expect, test } from 'bun:test';
import { checkAuth, handleChatCompletions, parseBridgeMap, toSingleChunkSse } from './bench-bridge';
import { isSubscriptionCoord, normalizeForDeepseek } from './bench-bridge';
import type { ModelRequest, ModelResponse } from '../src/model/types';

const fakeCall = (capture: ModelRequest[]) => async (req: ModelRequest): Promise<ModelResponse> => {
  capture.push(req);
  return { text: 'hi', usage: { in: 7, out: 3 } } as ModelResponse;
};

describe('bench-bridge (E1c 宿主桥)', () => {
  test('★ 白名单映射: 裸 id → coord 传给 callModel, usage 透传', async () => {
    const cap: ModelRequest[] = [];
    const r = await handleChatCompletions(
      { model: 'claude-opus-5', messages: [{ role: 'user', content: 'x' }], temperature: 0.2 },
      { call: fakeCall(cap), mapModel: (id) => (id === 'claude-opus-5' ? 'claude-code:claude-opus-5' : undefined) },
    );
    expect(r.status).toBe(200);
    expect(cap[0]!.model).toBe('claude-code:claude-opus-5');
    expect(cap[0]!.temperature).toBe(0.2);
    const j = r.json as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
    expect(j.choices[0]!.message.content).toBe('hi');
    expect(j.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  test('★ developer role 归一为 system (2026-08-26 根因回归钉: 丢它 = 系统面蒸发)', async () => {
    const cap: ModelRequest[] = [];
    const r = await handleChatCompletions(
      { model: 'm', messages: [{ role: 'developer', content: 'SYS-RULES' }, { role: 'user', content: 'x' }] },
      { call: fakeCall(cap), mapModel: () => 'a:b' },
    );
    expect(r.status).toBe(200);
    expect(cap[0]!.messages.length).toBe(2);
    expect(cap[0]!.messages[0]!.role).toBe('system');
    expect(String(cap[0]!.messages[0]!.content)).toBe('SYS-RULES');
  });

  test('★ 不在白名单 → 404 (不透传任意 coord)', async () => {
    const r = await handleChatCompletions(
      { model: 'evil:coord', messages: [{ role: 'user', content: 'x' }] },
      { call: fakeCall([]), mapModel: () => undefined },
    );
    expect(r.status).toBe(404);
  });

  test('缺 model / 缺 messages → 400', async () => {
    const deps = { call: fakeCall([]), mapModel: () => 'a:b' };
    expect((await handleChatCompletions({ messages: [{ role: 'user', content: 'x' }] }, deps)).status).toBe(400);
    expect((await handleChatCompletions({ model: 'm' }, deps)).status).toBe(400);
  });

  test('上游抛错 → 502 且错误原文在 (吞异常不许吞证据)', async () => {
    const r = await handleChatCompletions(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { call: async () => { throw new Error('channel down'); }, mapModel: () => 'a:b' },
    );
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).toContain('channel down');
  });

  test('parseBridgeMap: 逗号表解析, coord 内冒号保留', () => {
    const m = parseBridgeMap('a=x:y,b=p:q:r, c = s:t ');
    expect(m.get('a')).toBe('x:y');
    expect(m.get('b')).toBe('p:q:r');
    expect(m.get('c')).toBe('s:t');
  });

  test('checkAuth: 恰等 Bearer 才过', () => {
    expect(checkAuth('Bearer tok', 'tok')).toBe(true);
    expect(checkAuth('Bearer wrong', 'tok')).toBe(false);
    expect(checkAuth(null, 'tok')).toBe(false);
  });

  test('SSE 单块包装含内容与 [DONE]', () => {
    const s = toSingleChunkSse({ id: 'i', model: 'm', choices: [{ message: { content: 'body' } }] });
    expect(s).toContain('"content":"body"');
    expect(s.trim().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('SSE usage 块 (2026-08-29: bench token 账全是 0 的根因)', () => {
  // 反向自检: 把 toSingleChunkSse 里的 usageChunk 那一段删掉 → 前两条当场红。
  test('completion 带 usage → 末尾多一块 choices 空、只带 usage 的 chunk', () => {
    const s = toSingleChunkSse({
      id: 'i', model: 'm',
      choices: [{ message: { content: 'body' } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
    const blocks = s.split('\n\n').filter((b) => b.startsWith('data: ') && !b.includes('[DONE]'));
    expect(blocks).toHaveLength(2);
    const last = JSON.parse(blocks[1]!.slice('data: '.length)) as { choices: unknown[]; usage: { prompt_tokens: number } };
    expect(last.choices).toEqual([]);
    expect(last.usage.prompt_tokens).toBe(7);
    expect(s.trim().endsWith('data: [DONE]')).toBe(true);
  });

  test('内容块仍在前, 且顺序是 内容 → usage → [DONE]', () => {
    const s = toSingleChunkSse({ id: 'i', model: 'm', choices: [{ message: { content: 'body' } }], usage: { prompt_tokens: 1 } });
    expect(s.indexOf('body')).toBeLessThan(s.indexOf('usage'));
    expect(s.indexOf('usage')).toBeLessThan(s.indexOf('[DONE]'));
  });

  test('⚠ 无 usage → **不发**空块 (缺席 ≠ 0, 别把"没量到"写成"量到了 0")', () => {
    const s = toSingleChunkSse({ id: 'i', model: 'm', choices: [{ message: { content: 'body' } }] });
    expect(s).not.toContain('usage');
    const blocks = s.split('\n\n').filter((b) => b.startsWith('data: ') && !b.includes('[DONE]'));
    expect(blocks).toHaveLength(1);
  });
});

describe('JSON 模式 (2026-08-29: 静默丢 response_format 的代价是判官全体 Error)', () => {
  // 反向自检: 把 wantsJson 那一支删掉 → 前两条当场红。
  const call = (text: string) => async () => ({ text, usage: { in: 1, out: 1 } }) as ModelResponse;
  const deps = (text: string) => ({ call: call(text), mapModel: () => 'x:y' });

  test('请求 json_object → 追加一句系统指令 (让模型知道要裸 JSON)', async () => {
    let seen: Array<{ role: string; content: string }> = [];
    const d = {
      call: async (req: { messages: Array<{ role: string; content: string }> }) => {
        seen = req.messages;
        return { text: '{"a":1}', usage: { in: 1, out: 1 } } as ModelResponse;
      },
      mapModel: () => 'x:y',
    };
    await handleChatCompletions(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } } as never,
      d as never,
    );
    expect(seen.some((m) => m.role === 'system' && m.content.includes('raw JSON object'))).toBe(true);
  });

  test('★ 回程剥围栏: ```json 包裹的正文 → 客户端拿到可直接 JSON.parse 的裸对象', async () => {
    const r = await handleChatCompletions(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } } as never,
      deps('这是判词:\n```json\n{"verdict":"Satisfied","score":1}\n```\n以上。') as never,
    );
    const content = (r.json as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content;
    expect(() => JSON.parse(content)).not.toThrow();
    expect(JSON.parse(content)).toEqual({ verdict: 'Satisfied', score: 1 });
  });

  test('不要 json 模式 → 正文逐字不动 (存量路径零影响)', async () => {
    const raw = '这是一段散文, 里面碰巧有 {不是JSON} 的花括号。';
    const r = await handleChatCompletions({ model: 'm', messages: [{ role: 'user', content: 'hi' }] } as never, deps(raw) as never);
    expect((r.json as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe(raw);
  });

  test('⚠ 抠不出 JSON → 原样返回, 不编一个 {} (让 parse 抛在客户端那层, 拿到真原文)', async () => {
    const raw = 'I cannot comply with that request.';
    const r = await handleChatCompletions(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } } as never,
      deps(raw) as never,
    );
    expect((r.json as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe(raw);
  });
});

describe('deepseek 透传形状归一 (2026-09-03)', () => {
  test('★ developer → system, 其余消息与字段原样; 无 messages 原样返回', () => {
    const body = { model: 'x', messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a', tool_calls: [] }], tools: [{ type: 'function' }], reasoning_effort: 'medium' };
    const out = normalizeForDeepseek(body);
    expect(out.messages!.map((m) => m.role)).toEqual(['system', 'user', 'assistant']); // 证伪: 去掉归一 → ['developer', …] 红 (deepseek 400)
    expect(out.messages![0]!.content).toBe('sys');
    expect(out.tools).toBe(body.tools); // 其余字节原样
    expect(out.reasoning_effort).toBe('medium');
    const bare: { model: string; messages?: Array<Record<string, unknown>> } = { model: 'x' };
    expect(normalizeForDeepseek(bare)).toEqual({ model: 'x' });
    // stream_options / store 一律去掉 (上游恒 stream=false, 留 stream_options 就是 deepseek 400); stream 本身原样留给透传道处理。
    type B = { model: string; stream?: boolean; stream_options?: unknown; store?: unknown; messages?: Array<Record<string, unknown>> };
    const withOpts: B = { model: 'x', stream: true, stream_options: { include_usage: true }, store: false };
    expect(normalizeForDeepseek(withOpts) as B).toEqual({ model: 'x', stream: true });
  });
});

// ── 订阅座工具转发 (2026-09-04) ────────────────────────────────────────────────
//
// 来历: smoke8-oc 里 opus 经桥当 conductor **8/8 零派发** (`toolCalls:0 / tokensOut:44`),
// 而同一个 opus 本地直连 6/10 success、工具调用 8–18 次 —— 缺口在 callModel 走的完成位通道
// 「tools 全空」。这几条钉住路由判据与零回归。
describe('订阅座工具转发路由', () => {
  test('★ 判据是「带没带 tools」, 不是座位名 —— 不带 tools 的订阅座调用仍走既有 translate', () => {
    expect(isSubscriptionCoord('claude-code:claude-opus-5')).toBe(true);
    expect(isSubscriptionCoord('openai-codex:gpt-5.6-sol')).toBe(true);
    // 透传座不该被误判进来 (它们本来就工具原生往返)。
    // 证伪: 把 isSubscriptionCoord 改成恒 true → 下面两条红, minimax/deepseek 会被抢走。
    expect(isSubscriptionCoord('minimax-cn:MiniMax-M3')).toBe(false);
    expect(isSubscriptionCoord('deepseek:deepseek-v4-flash')).toBe(false);
    expect(isSubscriptionCoord(undefined)).toBe(false);
  });
});
