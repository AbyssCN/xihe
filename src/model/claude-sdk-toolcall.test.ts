/**
 * src/model/claude-sdk-toolcall.test —— 工具转发位的闸 (2026-09-04)。
 *
 * 这条通道的存在理由是实测出来的: smoke8-oc 里 opus 经桥当 conductor **8/8 零派发**
 * (`toolCalls:0 / tokensOut:44`), 而同一个 opus 在本地直连通道下 6/10 success、工具调用 8–18 次。
 * 缺口在 `callModel` 走的完成位通道「tools 全空」。
 *
 * 每条用例都带证伪方式 —— 一条永远绿的闸不是闸。
 */
import { describe, expect, test } from 'bun:test';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildStubToolServer, runToolCallTurn, serializeForToolTurn, stripToolPrefix, TOOLCALL_MCP_SERVER } from './claude-sdk-toolcall';

const TOOLS = [
  { type: 'function', function: { name: 'work', description: 'do one thing', parameters: { type: 'object', properties: { goal: { type: 'string' } } } } },
  { type: 'function', function: { name: 'explore', description: 'read-only recon', parameters: { type: 'object', properties: {} } } },
];

function fakeQuery(msgs: SDKMessage[]): (p: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> {
  return () => ({ async *[Symbol.asyncIterator]() { for (const m of msgs) yield m; } });
}
const asst = (content: unknown[]): SDKMessage => ({ type: 'assistant', message: { content } } as unknown as SDKMessage);

describe('串行化: role:tool 必须进 prompt', () => {
  test('★ 工具结果进 prompt —— 桥原有的 role filter 丢掉这一格, 带工具的对话第二轮就断了', () => {
    const p = serializeForToolTurn([
      { role: 'system', content: 'you are conductor' },
      { role: 'user', content: 'fix add()' },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'work', arguments: '{"goal":"x"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'worker done: wrote src/add.ts' },
    ]);
    // 证伪: 删掉 serializeForToolTurn 里的 role==='tool' 分支 → 下面第一条红。
    expect(p).toContain('worker done: wrote src/add.ts');
    expect(p).toContain('[tool result id=c1]');
    // 助手那一轮的意图也要回放, 否则 tool result 在上下文里没有来处。
    expect(p).toContain('work({"goal":"x"})');
    expect(p).toContain('you are conductor');
  });

  test('数组形 content (OpenAI 新式 parts) 也要取出文本', () => {
    const p = serializeForToolTurn([{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }]);
    expect(p).toContain('hello');
    expect(p).toContain('world');
  });
});

describe('工具声明: JSON Schema 直喂, handler 是桩', () => {
  test('★ allowedTools 带 mcp 前缀; 前缀能被剥回 OpenAI 名', () => {
    const { allowedTools } = buildStubToolServer(TOOLS);
    expect(allowedTools).toEqual([`mcp__${TOOLCALL_MCP_SERVER}__work`, `mcp__${TOOLCALL_MCP_SERVER}__explore`]);
    expect(stripToolPrefix(allowedTools[0]!)).toBe('work');
    // 没有前缀的名字原样返回 (SDK 行为变了也不至于把名字切坏)。
    expect(stripToolPrefix('work')).toBe('work');
  });
});

describe('截获: tool_use → OpenAI tool_calls', () => {
  test('★ 截获工具意图, finishReason=tool_calls, 名字剥前缀, 入参转 JSON 串', async () => {
    const r = await runToolCallTurn({
      modelId: 'claude-opus-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      _query: fakeQuery([asst([{ type: 'tool_use', id: 'tu_1', name: `mcp__${TOOLCALL_MCP_SERVER}__work`, input: { goal: 'fix add' } }])]),
    });
    // 证伪: 去掉 stripToolPrefix 调用 → name 变 mcp__omdbridge__work, 容器认不出这张卡, 本条红。
    expect(r.finishReason).toBe('tool_calls');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]!.function.name).toBe('work');
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ goal: 'fix add' });
  });

  test('模型直接文本作答 (没调工具) → finishReason=stop, text 带回', async () => {
    const r = await runToolCallTurn({
      modelId: 'claude-opus-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      _query: fakeQuery([asst([{ type: 'text', text: 'nothing to do' }])]),
    });
    expect(r.finishReason).toBe('stop');
    expect(r.text).toBe('nothing to do');
    expect(r.toolCalls).toHaveLength(0);
  });

  test('一轮多个 tool_use 全部带回 (卡可以一次派多个)', async () => {
    const r = await runToolCallTurn({
      modelId: 'claude-opus-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      _query: fakeQuery([asst([
        { type: 'tool_use', id: 'a', name: `mcp__${TOOLCALL_MCP_SERVER}__work`, input: { goal: '1' } },
        { type: 'tool_use', id: 'b', name: `mcp__${TOOLCALL_MCP_SERVER}__explore`, input: {} },
      ])]),
    });
    // 证伪: 把收集改成只取第一个 → 长度 1, 本条红。
    expect(r.toolCalls.map((c) => c.function.name)).toEqual(['work', 'explore']);
  });

  test('★ usage 从 assistant 消息收 —— 截获后就 abort, result 消息永远到不了', async () => {
    const r = await runToolCallTurn({
      modelId: 'claude-opus-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      _query: fakeQuery([
        { type: 'assistant', message: { usage: { input_tokens: 900, output_tokens: 12 }, content: [{ type: 'tool_use', id: 'a', name: `mcp__${TOOLCALL_MCP_SERVER}__work`, input: {} }] } } as unknown as SDKMessage,
      ]),
    });
    // 实测桥回包 usage 全 0 暴露的正是这一格: 只读 result 时每轮工具调用的记账都是 0,
    // 而 0 与「真的没花 token」不可分。证伪: 删掉 assistant.usage 那一跳 → 变 {0,0}, 本条红。
    expect(r.usage).toEqual({ in: 900, out: 12 });
    expect(r.toolCalls).toHaveLength(1);
  });

  test('★ cache_read 必须计入 in —— 否则 conductor 的 tokIn 会掉成个位数', async () => {
    const r = await runToolCallTurn({
      modelId: 'claude-opus-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      _query: fakeQuery([
        { type: 'assistant', message: { usage: { input_tokens: 52, cache_read_input_tokens: 133467, cache_creation_input_tokens: 200, output_tokens: 4844 }, content: [{ type: 'tool_use', id: 'a', name: `mcp__${TOOLCALL_MCP_SERVER}__work`, input: {} }] } } as unknown as SDKMessage,
      ]),
    });
    // 数字取自实测: code80-oc 的 conductor 记成 tokIn=52, 而 p6 同位置 (M3 字节透传) 是
    // tokIn=146981 / cacheHit=133467 —— 91% 的输入在缓存读取里。
    // 证伪: 去掉 cache_read_input_tokens 那一项 → in 变 52, 本条红。
    expect(r.usage).toEqual({ in: 52 + 133467 + 200, out: 4844 });
  });

  test('usage 从 result 消息读出 (没有工具调用时的口径)', async () => {
    const r = await runToolCallTurn({
      modelId: 'claude-opus-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      _query: fakeQuery([
        asst([{ type: 'text', text: 'ok' }]),
        { type: 'result', usage: { input_tokens: 120, output_tokens: 34 } } as unknown as SDKMessage,
      ]),
    });
    expect(r.usage).toEqual({ in: 120, out: 34 });
  });
});
