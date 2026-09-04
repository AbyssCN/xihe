/**
 * src/model/claude-sdk-toolcall —— Claude 订阅通道的**工具转发位**(第四条通道,2026-09-04)。
 *
 * ## 它解决什么
 *
 * bench 容器里的 agent 经桥调 opus/gpt。桥的 translate 分支走 `callModel`,而 claude-code 在
 * `callModel` 下走的是**完成位通道**(`claude-sdk-complete.ts`,头注写明「tools 全空、无 MCP」)——
 * 于是工具面整条蒸发,conductor 一发文字就结束。实测 smoke8-oc 8/8 零派发,
 * `toolCalls:0 / tokensOut:44`;而同一个 opus 在**本地直连**通道下 6/10 success、工具调用 8–18 次。
 * 所以那是通道缺口,不是模型能力(`bench-bridge.ts:355` 记过 deepseek 撞的同一个坑)。
 *
 * ## 为什么不能直接复用 agent loop
 *
 * `claude-sdk-loop.ts` 的 MCP 桥把 handler 跑在**omd 进程内**。桥在宿主,而工具要操作
 * **容器的 /workspace** —— 在宿主执行就是错的机器。所以这里的形状必须是:
 * **声明工具但绝不执行**,把模型的 `tool_use` 意图转成 OpenAI `tool_calls` 交回容器,
 * 由容器执行完再把结果发回来(OpenAI 协议本来就是这么单轮往返的)。
 *
 * 可行性由 `scripts/claude-sdk-toolcall-passthrough-probe.ts` 实测坐实:能在 handler 被调用
 * **之前**从流里截获 `tool_use`(handlerCalled=false),abort 后进程正常收尾。
 *
 * ## 三处刻意差异(同 claude-sdk-complete 的诚实边界)
 *  ① handler 是**桩**,被调用即说明截获逻辑漏了 —— 它会响亮抛错而不是静默返回(见 STUB_MSG)。
 *  ② `temperature/topP` SDK 不暴露,带了就 warn 留痕,不静默丢。
 *  ③ 多轮 messages 串行化成单 prompt(SDK 单发不吃 assistant 轮)——**含 `role:'tool'` 的
 *     工具结果**。那一格此前被桥的 role filter 整条丢弃,带工具的对话第二轮必断。
 */
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../logger';
import { effortOf } from './claude-sdk-complete';
import type { ModelRequest, ModelUsage } from './types';

/** 桥内 MCP server 名 —— SDK 会把工具名前缀成 `mcp__<此名>__<tool>`, 回程要剥掉。 */
export const TOOLCALL_MCP_SERVER = 'omdbridge';
const TOOL_PREFIX = `mcp__${TOOLCALL_MCP_SERVER}__`;

/** handler 桩被调用 = 截获逻辑漏了。**响亮抛**, 不静默 —— 静默会让工具在宿主执行而没人知道。 */
const STUB_MSG = '[bench-bridge] 工具 handler 桩被调用 —— 截获逻辑漏了, 工具本该由容器执行';

/** OpenAI 的一条工具声明(只取桥要用的那几位)。 */
export interface OpenAiToolDecl {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

/** OpenAI 的一条工具调用(回给客户端的形状)。 */
export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolCallTurnResult {
  text: string;
  toolCalls: OpenAiToolCall[];
  usage: ModelUsage;
  /** 'tool_calls' = 截获到工具意图; 'stop' = 模型直接文本作答。与 OpenAI finish_reason 同名。 */
  finishReason: 'tool_calls' | 'stop';
}

/** 一条 OpenAI message(桥收到的原样, 含 tool role)。 */
export interface WireMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === 'string' ? p : typeof (p as { text?: string }).text === 'string' ? (p as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return c == null ? '' : String(c);
}

/**
 * messages → 单 prompt。**`role:'tool'` 必须进**:它承载上一轮工具的执行结果,
 * 丢了模型就看不见自己刚才那一步的产出, 第二轮必然重复调用或空转。
 * (桥原有的 role filter 只留 system/user/assistant, 正是这一格漏的。)
 */
export function serializeForToolTurn(messages: readonly WireMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = contentText(m.content);
    if (m.role === 'tool') {
      const id = m.tool_call_id ? ` id=${m.tool_call_id}` : '';
      parts.push(`[tool result${id}]\n${text}`);
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      // 助手那一轮的工具意图也要回放, 否则 [tool result] 在上下文里没有来处。
      const calls = m.tool_calls.map((c) => `${c.function.name}(${c.function.arguments})`).join(', ');
      parts.push(`[assistant called]\n${calls}${text ? `\n${text}` : ''}`);
      continue;
    }
    if (!text) continue;
    parts.push(m.role === 'user' ? text : `[${m.role}]\n${text}`);
  }
  return parts.join('\n\n');
}

/** OpenAI tools → 进程内 MCP server(**桩 handler**)。JSON Schema 直喂, 不经 zod(同 claude-sdk-loop 的做法)。 */
export function buildStubToolServer(tools: readonly OpenAiToolDecl[]): { instance: McpServer; allowedTools: string[] } {
  const decls = tools
    .map((t) => t.function)
    .filter((f): f is NonNullable<OpenAiToolDecl['function']> => !!f?.name);
  const instance = new McpServer({ name: TOOLCALL_MCP_SERVER, version: '0' }, { capabilities: { tools: {} } });
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: decls.map((f) => ({
      name: f.name!,
      description: f.description ?? '',
      inputSchema: (f.parameters ?? { type: 'object', properties: {} }) as { type: 'object'; [k: string]: unknown },
    })),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async () => {
    throw new Error(STUB_MSG);
  });
  return { instance, allowedTools: decls.map((f) => `${TOOL_PREFIX}${f.name}`) };
}

/** SDK 工具名 → OpenAI 工具名(剥 `mcp__<server>__` 前缀; 没有前缀就原样)。 */
export function stripToolPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

export interface ToolCallTurnOpts {
  modelId: string;
  messages: readonly WireMessage[];
  tools: readonly OpenAiToolDecl[];
  maxTokens?: number;
  thinkingLevel?: ModelRequest['thinkingLevel'];
  temperature?: number;
  topP?: number;
  /** 注入点(测试用): 缺省 = 真 SDK query。 */
  _query?: (props: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;
}

/**
 * 跑一轮:声明工具 → 截获 `tool_use` → 中止 → 转 OpenAI `tool_calls`。
 * 模型没调工具就正常读文本, `finishReason:'stop'`。
 */
export async function runToolCallTurn(opts: ToolCallTurnOpts): Promise<ToolCallTurnResult> {
  if (opts.temperature !== undefined || opts.topP !== undefined) {
    // 静默丢参会伪装成「模型行为变了」(同 claude-sdk-complete 的第 ① 条)。
    logger.warn({ modelId: opts.modelId }, '[claude-sdk-toolcall] SDK 不暴露 temperature/topP → 本次忽略 (留痕不静默)');
  }
  const stub = buildStubToolServer(opts.tools);
  const prompt = serializeForToolTurn(opts.messages);
  const ac = new AbortController();
  const effort = effortOf(opts.thinkingLevel);
  const q = (opts._query ?? query)({
    prompt,
    options: {
      model: opts.modelId,
      tools: [], // 内置工具全清 —— 座位的工具面就是闸(同 claude-sdk-loop 的纪律)
      mcpServers: { [TOOLCALL_MCP_SERVER]: { type: 'sdk', name: TOOLCALL_MCP_SERVER, instance: stub.instance } },
      allowedTools: [...stub.allowedTools],
      permissionMode: 'bypassPermissions',
      abortController: ac,
      maxTurns: 1, // 单轮:工具由容器执行, 桥这边永远不进第二轮
      ...(effort ? { effort } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    } as Options,
  });

  const toolCalls: OpenAiToolCall[] = [];
  let text = '';
  let usage: ModelUsage = { in: 0, out: 0 };
  try {
    for await (const msg of q) {
      const m = msg as {
        type: string;
        message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }> };
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      // usage 要在 abort **之前**尽量收: 截获 tool_use 就中止 → SDK 的 `result` 消息永远到不了,
      // 只读 result 会让每一轮工具调用的记账都是 0 —— 而 0 与「真的没花 token」不可分 (§静默坑 1)。
      // assistant 消息自带 usage, 从它收(实测桥回包 usage 全 0 暴露的正是这一格)。
      const au = (m as { message?: { usage?: { input_tokens?: number; output_tokens?: number } } }).message?.usage;
      if (au && (au.input_tokens || au.output_tokens)) usage = { in: au.input_tokens ?? 0, out: au.output_tokens ?? 0 };
      if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
        for (const blk of m.message.content) {
          if (blk.type === 'text' && blk.text) text += blk.text;
          if (blk.type === 'tool_use' && blk.name) {
            toolCalls.push({
              id: blk.id ?? `call_${toolCalls.length}`,
              type: 'function',
              function: { name: stripToolPrefix(blk.name), arguments: JSON.stringify(blk.input ?? {}) },
            });
          }
        }
      }
      if (m.type === 'result') {
        const u = (m as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        if (u) usage = { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0 };
      }
      // 截获到工具意图就停 —— 再往下 SDK 会去调 handler 桩(那是错的机器)。
      if (toolCalls.length > 0) {
        ac.abort();
        break;
      }
    }
  } catch (err) {
    const msg = String(err);
    if (msg.includes(STUB_MSG)) throw err; // 桩被调用 = 真 bug (工具跑在了错的机器上), 必须炸出来
    // 我们自己 abort 的是**截获成功的正常出口**, 但仍要留一行 —— fail-open 可以吞异常,
    // 不许吞证据 (§静默坑 2; 本仓的 catch-evidence 闸当场抓过这一处的第一版空分支)。
    const ourAbort = toolCalls.length > 0 && /abort/i.test(msg);
    logger[ourAbort ? 'debug' : 'warn'](
      { err: msg.slice(0, 200), toolCalls: toolCalls.length, textChars: text.length },
      ourAbort ? '[claude-sdk-toolcall] 截获 tool_use 后自行中止 (正常出口)' : '[claude-sdk-toolcall] SDK 流异常',
    );
    if (!ourAbort && !toolCalls.length && !text) throw err;
  }
  return { text, toolCalls, usage, finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop' };
}
