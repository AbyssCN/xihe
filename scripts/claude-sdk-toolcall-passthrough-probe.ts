/**
 * scripts/claude-sdk-toolcall-passthrough-probe —— 最小实验:SDK 能不能「声明工具但不执行,
 * 把 tool_use 吐回来」。
 *
 * ## 为什么要这个实验
 *
 * bench 桥要让 opus/gpt 坐 conductor,必须把模型的工具调用意图转成 OpenAI `tool_calls`
 * 返回容器、由**容器**执行(工具要操作容器的 /workspace,而桥在宿主)。
 * 但 omd 现有的 SDK 通道是 in-process MCP bridge(claude-sdk-loop.ts:252),handler 在
 * **omd 进程内**执行 —— 那在 bench 场景下是错的机器。
 *
 * 所以整条路依赖一个我不确定的 SDK 行为,先证伪它再动桥。
 *
 * 【实验四要素 —— 动手前钉死】
 * 单一变量:能否在 handler 被调用**之前**截获 tool_use 并中止。模型/任务/工具面固定。
 * 成败信号(预先声明):
 *   ✅ 成 = ① 流里出现 tool_use 块(拿到工具名 + 入参)
 *          ② 截获时 handlerCalled === false(handler 没跑)
 *          ③ abort 之后进程能正常收尾(不挂死)
 *   ❌ 塌 = handler 先被调用(说明 SDK 在 emit 之前就执行了),或流里根本没有可截获的
 *          tool_use 块。塌了记第一条相关消息的原文 —— 那决定换哪条方案。
 * 对照基线:无(二值可行性)。
 * 收数:成 → tool_use 的 name/input 原文 + 截获耗时;塌 → 消息序列前若干条的 type。
 *
 * ⚠ 两侧都要写:塌了同样是读数 —— 它把「改桥」这条路直接判掉,省下的是几天的白工。
 *
 * 跑法:bun run scripts/claude-sdk-toolcall-passthrough-probe.ts
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const NONCE = Math.random().toString(36).slice(2, 10);
let handlerCalled = false;
let handlerCalledAt = 0;
const seen: string[] = [];

const server = createSdkMcpServer({
  name: 'probe',
  version: '0',
  tools: [
    tool('echo_nonce', 'Echo back the nonce you are given.', { nonce: z.string() }, async (args) => {
      handlerCalled = true;
      handlerCalledAt = Date.now();
      return { content: [{ type: 'text' as const, text: `echoed:${(args as { nonce: string }).nonce}` }] };
    }),
  ],
});

const t0 = Date.now();
const ac = new AbortController();
let captured: { name: string; input: unknown } | null = null;

try {
  const q = query({
    prompt: `Call the echo_nonce tool exactly once with nonce="${NONCE}". Do not answer in text first.`,
    options: {
      model: 'claude-opus-5',
      systemPrompt: 'You are a tool-calling probe. Call the tool immediately.',
      tools: [],
      mcpServers: { probe: { type: 'sdk', name: 'probe', instance: server.instance } },
      allowedTools: ['mcp__probe__echo_nonce'],
      permissionMode: 'bypassPermissions',
      abortController: ac,
      maxTurns: 2,
    },
  });
  for await (const msg of q) {
    seen.push((msg as { type: string }).type);
    const m = msg as { type: string; message?: { content?: Array<{ type: string; name?: string; input?: unknown }> } };
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const blk of m.message.content) {
        if (blk.type === 'tool_use') {
          captured = { name: blk.name ?? '?', input: blk.input };
          ac.abort(); // 截获即中止 —— 这一步正是要验的:handler 有没有先跑
          break;
        }
      }
    }
    if (captured) break;
  }
} catch (err) {
  seen.push(`THROWN:${String(err).slice(0, 120)}`);
}

const dt = Date.now() - t0;
console.log('=== SDK tool_use 截获探针 ===');
console.log('消息序列:', seen.join(' → ') || '(空)');
console.log('截获到 tool_use:', captured ? `${captured.name} ${JSON.stringify(captured.input)}` : '❌ 没有');
console.log('handler 被调用了吗:', handlerCalled ? `❌ 是 (+${handlerCalledAt - t0}ms)` : '✅ 否');
console.log('耗时:', `${dt}ms`);
const ok = !!captured && !handlerCalled;
console.log(ok ? '\n✅ 可行 —— 能在 handler 之前拿到 tool_use, 桥可以转成 OpenAI tool_calls 返回容器' : '\n❌ 不可行 —— 换方案');
process.exit(ok ? 0 : 1);
