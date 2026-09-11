/**
 * src/model/agy-cli-complete —— Google 订阅通道 (Antigravity CLI `agy`) 的**完成位**。
 *
 * ## 它解决什么 (2026-09-11, owner 裁)
 *
 * Google AI Pro 订阅没有按量 API key, 额度只能经 `agy` CLI 用; 本机实测 `agy models` 里除 gemini 系
 * 还有 `claude-opus-4-6-thinking` / `claude-sonnet-4-6` / `gpt-oss-120b`, 且 Gemini 桶与 Claude/GPT 桶
 * 是**两本独立配额** (`agy -p='/quota'`)。于是它是 verifier 撞限时的降级座 (与 M3 异族) 与 work 的
 * 第二实装源。本文件只管**单发无工具完成** (verifier / judge 那一型); 带工具的 leaf 在
 * `src/harness/agy-leaf.ts`。
 *
 * ## 调用形状 (本机 agy 1.1.28 实测)
 *   `agy --output-format json --model <id> --mode plan -p='<prompt>'`
 *   · `-p=` 必须用等号连写, 否则 `-p` 会把下一个 flag 当 prompt (实测坑)。
 *   · `--mode plan` = 只读; 完成位不该改盘, 与 claude-sdk-complete 的 `tools: []` 同义。
 *   · stdout 一行 JSON: `{ status, response, usage: { input_tokens, output_tokens, thinking_tokens,
 *     cache_read_tokens }, duration_seconds, conversation_id }`。
 *   · 冷启动 ≈ 2 s, flash-low 单答 ≈ 8 s 墙钟; 高频座别坐它 (M3 每调用 2.9 s)。
 *
 * ## 与 claude-sdk-complete 同款的诚实边界
 *   ① temperature/topP/maxTokens 不支持 → warn 一次, 不静默丢。
 *   ② 多轮 messages 串行化成单 prompt, system 段前置 (agy 无 systemPrompt 参数)。
 *   ③ 凭证 = `agy` 自己的登录 (`~/.gemini/antigravity-cli`), 没有 env key; `agyCredentialed()` 只探
 *     二进制在 PATH + 凭证目录存在, 不发真请求。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../harness/logger';
import type { ModelMessage, ModelRequest, ModelUsage } from './types';

export const AGY_CLI_PROVIDER = 'agy-cli';

/** 与 SdkRawResult / RawResult 同形 (不 import, 免得 model/index 反向依赖)。 */
export interface AgyRawResult {
  text: string;
  usage: ModelUsage;
  raw: unknown;
  finishReason?: string;
}

/** agy `--output-format json` 的结果行 (只取本仓消费的字段)。 */
export interface AgyJsonResult {
  status?: string;
  response?: string;
  conversation_id?: string;
  duration_seconds?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

/** 子进程接缝 (测试注入; 真实现 = Bun.spawn)。 */
export interface AgySpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type AgySpawn = (argv: string[], opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<AgySpawnResult>;

/** 默认 print 超时 (agy 自己的 `--print-timeout` 默认 5m; 完成位给 10m, 长 verifier 判词也够)。 */
export const AGY_PRINT_TIMEOUT = '10m';

function textOf(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  const parts = content.filter((p): p is { type: 'text'; text: string } => (p as { type?: string }).type === 'text');
  if (parts.length !== content.length) {
    logger.warn({ dropped: content.length - parts.length }, '[agy-cli-complete] 非文本 part 丢弃 (完成位不支持多模态)');
  }
  return parts.map((p) => p.text).join('');
}

/**
 * system 段前置 + 其余按角色串行化 (单 user 常态原样)。agy 无 systemPrompt 参数, 只能拼进 prompt。
 * 导出供测试钉形状。
 */
export function serializeForAgy(messages: ModelMessage[]): string {
  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content));
  const rest = messages.filter((m) => m.role !== 'system');
  const body = rest.length === 1 ? textOf(rest[0]!.content) : rest.map((m) => `[${m.role}]\n${textOf(m.content)}`).join('\n\n');
  return system.length ? `${system.join('\n\n')}\n\n${body}` : body;
}

/** 完成位 argv (只读 plan 模式, 无 --add-dir: 完成位不该看仓)。导出供测试钉 `-p=` 连写形状。 */
export function agyCompleteArgv(modelId: string, prompt: string, opts: { printTimeout?: string } = {}): string[] {
  return [
    'agy',
    '--output-format',
    'json',
    '--model',
    modelId,
    '--mode',
    'plan',
    '--print-timeout',
    opts.printTimeout ?? AGY_PRINT_TIMEOUT,
    `-p=${prompt}`,
  ];
}

/** 解析 json 结果行 → 正文 + 账。stdout 可能夹杂非 JSON 行 (登录提示等) → 取最后一个能 parse 的对象。 */
export function parseAgyJson(stdout: string): AgyJsonResult | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.startsWith('{')) continue;
    try {
      return JSON.parse(l) as AgyJsonResult;
    } catch {
      // 不是这一行 —— 继续往上找; 全找不到由调用方报 stdout 原文。
    }
  }
  return null;
}

/** agy usage → 本仓 ModelUsage (cache_read 并进 in, 与 SDK 通道同口径; thinking 计入 out)。 */
export function agyUsageToModelUsage(u: AgyJsonResult['usage'] | undefined): ModelUsage {
  const hit = u?.cache_read_tokens ?? 0;
  return {
    in: (u?.input_tokens ?? 0) + hit,
    out: (u?.output_tokens ?? 0) + (u?.thinking_tokens ?? 0),
    cacheHit: hit,
  };
}

/** 凭证判据: 二进制在 PATH 且 agy 凭证目录存在。不发真请求 (座位自检那一行不该掏配额)。 */
export function agyCredentialed(env: Record<string, string | undefined> = process.env): boolean {
  const home = env.HOME || homedir();
  const credDir = env.AGY_CREDENTIAL_DIR || join(home, '.gemini', 'antigravity-cli');
  return !!Bun.which('agy') && existsSync(credDir);
}

const realSpawn: AgySpawn = async (argv, { cwd, timeoutMs, signal }) => {
  const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  const onAbort = () => proc.kill();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(killer);
    signal?.removeEventListener('abort', onAbort);
  }
};

let spawnOverride: AgySpawn | null = null;
/** 测试接缝 (同 claude-sdk-complete 的 setSdkCompleteQueryForTest)。 */
export function setAgySpawnForTest(fn: AgySpawn | null): void {
  spawnOverride = fn;
}

/**
 * 单发完成。失败 → 抛 Error 带 stdout/stderr 尾 (callModel 外层的重试/熔断原样复用)。
 * `req.thinkingLevel` 不映射: agy 的档在模型 id 里 (`gemini-3.8-flash-high` / `-low`), 座位表选 id 即选档。
 */
export async function agyCompleteRaw(modelId: string, messages: ModelMessage[], req: ModelRequest): Promise<AgyRawResult> {
  if (req.temperature !== undefined || req.topP !== undefined || req.maxTokens !== undefined) {
    logger.warn(
      { model: `${AGY_CLI_PROVIDER}:${modelId}`, temperature: req.temperature, topP: req.topP, maxTokens: req.maxTokens },
      '[agy-cli-complete] 采样/上限参数在 agy 通道不支持 —— 已忽略 (差异①)',
    );
  }
  const prompt = serializeForAgy(messages);
  const argv = agyCompleteArgv(modelId, prompt);
  const r = await (spawnOverride ?? realSpawn)(argv, { cwd: process.cwd(), timeoutMs: 11 * 60_000, signal: req.signal });
  const parsed = parseAgyJson(r.stdout);
  if (!parsed || parsed.status !== 'SUCCESS' || typeof parsed.response !== 'string') {
    throw new Error(
      `[agy-cli-complete] agy 未返回 SUCCESS (exit ${r.code}, status=${parsed?.status ?? 'n/a'}): ` +
        `${(r.stderr || r.stdout).trim().slice(-400)}`,
    );
  }
  return { text: parsed.response, usage: agyUsageToModelUsage(parsed.usage), raw: parsed, finishReason: 'stop' };
}
