/**
 * src/harness/agy-leaf —— Google 订阅通道 (Antigravity CLI `agy`) 的**带工具 leaf** (2026-09-11, owner 裁)。
 *
 * ## 形状
 * 引擎派一张 work 卡到 `agy-cli:<model>` 座 → 这里 spawn 一次
 *   `agy --output-format stream-json --model <id> --add-dir <root> --dangerously-skip-permissions -p=<prompt>`
 * 工具在 agy **自己的进程**里跑 (57 个内置工具, 含 browser_* 全套 —— 前端任务能自己把页面跑起来),
 * 引擎不给它工具面。所以与 pi / SDK 两条腿的差异要写清:
 *   · **写集只能事后对账**: NDJSON 里每个 write/edit 工具步带目标路径, 结束后逐一过 `checkWriteAllowed`;
 *     越界 → 响亮失败 (文件已经写了, 但节点判 failed 并列出越界文件, 不冒充成功)。pi/SDK 腿是工具调用那一刻拒。
 *   · **活性信号** = NDJSON 有新行 (onActivity), 没有模型回合边界事件。
 *   · **必须传 `--add-dir <root>`**: 本机实测不传时 agy 把文件写到 `~/.gemini/antigravity-cli/scratch/`,
 *     cwd 被忽略 (2026-09-11 探针)。
 *   · 账本: result.usage 带 input/output/thinking/cache_read, 不用记 NULL。
 *   · 冷启动 ≈ 2 s; 高频座别坐它。
 *
 * ## 反向自检 (agy-leaf.test.ts)
 *   把 `--add-dir` 从 argv 拿掉 → argv 用例红; 把越界检查删掉 → 「写集越界事后拒」用例红。
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { logger } from './logger';
import { AGY_CLI_PROVIDER, agyUsageToModelUsage, type AgyJsonResult } from '../model/agy-cli-complete';
import { checkWriteAllowed } from './writeset/write-allow';
import type { AgentLeafInput, AgentLeafResult, AgentLeafRunner } from './leaf-runners';

/** agy stream-json 的一行 (只取本仓消费的字段)。 */
export interface AgyStreamEvent {
  event?: 'init' | 'step_update' | 'result' | string;
  step_update?: {
    step_type?: 'user_input' | 'agent_response' | 'tool' | string;
    state?: 'ACTIVE' | 'DONE' | string;
    tool_name?: string;
    tool_info?: { name?: string; parameters?: Record<string, unknown> };
    text_delta?: string;
    usage?: AgyJsonResult['usage'];
  };
  result?: AgyJsonResult;
}

export interface AgyParsed {
  text: string;
  status: string | null;
  usage: AgyJsonResult['usage'] | undefined;
  /** 写/改文件工具步的目标路径 (原样, 可能绝对)。 */
  written: string[];
  toolCalls: number;
  llmCalls: number;
  shellRuns: number;
}

/** 写/改类工具名 (agy 1.1.28 实测: write_to_file / replace_file_content / multi_replace_file_content …)。 */
const WRITE_TOOL = /write|replace|edit|create_file|append/i;
const SHELL_TOOL = /run_command|shell|terminal|bash/i;
const PATH_PARAM_KEYS = ['TargetFile', 'AbsolutePath', 'target_file', 'file_path', 'path', 'filePath'];

function pathOf(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined;
  for (const k of PATH_PARAM_KEYS) {
    const v = params[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** NDJSON → 结构化读数。非 JSON 行跳过 (agy 偶发打提示)。 */
export function parseAgyStream(lines: Iterable<string>): AgyParsed {
  const out: AgyParsed = { text: '', status: null, usage: undefined, written: [], toolCalls: 0, llmCalls: 0, shellRuns: 0 };
  const seenWrite = new Set<string>();
  for (const raw of lines) {
    const l = raw.trim();
    if (!l.startsWith('{')) continue;
    let e: AgyStreamEvent;
    try {
      e = JSON.parse(l) as AgyStreamEvent;
    } catch {
      continue;
    }
    if (e.event === 'result' && e.result) {
      out.status = e.result.status ?? null;
      out.usage = e.result.usage;
      if (typeof e.result.response === 'string' && !out.text) out.text = e.result.response;
      continue;
    }
    const s = e.step_update;
    if (!s) continue;
    if (s.step_type === 'agent_response' && s.state === 'DONE' && s.usage) out.llmCalls += 1;
    if (s.step_type === 'tool' && s.state === 'DONE') {
      out.toolCalls += 1;
      const name = s.tool_name ?? s.tool_info?.name ?? '';
      if (SHELL_TOOL.test(name)) out.shellRuns += 1;
      if (WRITE_TOOL.test(name)) {
        const p = pathOf(s.tool_info?.parameters);
        if (p && !seenWrite.has(p)) {
          seenWrite.add(p);
          out.written.push(p);
        }
      }
    }
  }
  return out;
}

/** leaf argv。`-p=` 连写 + `--add-dir <root>` 两条是实测必需 (见文件头)。 */
export function agyLeafArgv(modelId: string, prompt: string, root: string, opts: { printTimeout?: string } = {}): string[] {
  return [
    'agy',
    '--output-format',
    'stream-json',
    '--model',
    modelId,
    '--add-dir',
    root,
    '--dangerously-skip-permissions',
    '--print-timeout',
    opts.printTimeout ?? '30m',
    `-p=${prompt}`,
  ];
}

/** 写集事后对账: 越界的 root 相对路径列表 (空 = 全在集内或没声明写集)。 */
export function agyWriteViolations(written: readonly string[], allow: readonly string[] | undefined, root: string): string[] {
  if (!allow || allow.length === 0) return [];
  const bad: string[] = [];
  for (const w of written) {
    const abs = isAbsolute(w) ? w : resolve(root, w);
    const rel = relative(root, abs).split('\\').join('/');
    if (!checkWriteAllowed(abs, allow, root).allowed) bad.push(rel);
  }
  return bad;
}

export interface AgyLeafDeps {
  /** 子进程接缝: 逐行回调 stdout, 返回退出码 + stderr 尾。测试注入。 */
  spawn?: (argv: string[], opts: { cwd: string; timeoutMs: number; onLine: (l: string) => void }) => Promise<{ code: number; stderr: string }>;
  /**
   * 盘面快照 (root 相对路径 → 内容指纹)。默认 `git status --porcelain -uall`。
   * 实账 (run e85f2715, 2026-09-11 首跑): agy 用 shell 重定向写文件, 流里没有 write 工具步 → touched=0,
   * conductor 以为没产物, 同一张卡连派 4 次。与 engine.ts:2336 的 bash 重定向盲点同族, 这里按盘面对账。
   */
  snapshot?: (root: string) => Map<string, string>;
}

/** `git status --porcelain -uall` → { 路径 → 状态码 }。不是 git 仓 / git 不在 → 空表 (fail-open, 留一行证据)。 */
export function gitDirtySnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const r = Bun.spawnSync(['git', 'status', '--porcelain', '-uall'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) {
      logger.debug({ root, code: r.exitCode, err: r.stderr.toString().slice(0, 200) }, '[agy-leaf] git status 不可用 → 盘面对账跳过');
      return out;
    }
    for (const line of r.stdout.toString().split('\n')) {
      if (line.length < 4) continue;
      const status = line.slice(0, 2);
      let path = line.slice(3);
      const arrow = path.indexOf(' -> ');
      if (arrow >= 0) path = path.slice(arrow + 4);
      out.set(path.replace(/^"|"$/g, ''), `${status}:${statSafe(root, path)}`);
    }
  } catch (err) {
    logger.debug({ root, err: err instanceof Error ? err.message : String(err) }, '[agy-leaf] 盘面快照失败 → 跳过');
  }
  return out;
}

function statSafe(root: string, rel: string): string {
  try {
    const s = require('node:fs').statSync(resolve(root, rel)) as { mtimeMs: number; size: number };
    return `${s.size}@${Math.round(s.mtimeMs)}`;
  } catch {
    return 'gone';
  }
}

/** 两次快照之差 = 本次 leaf 碰过的文件 (新增 / 内容变了 / 删了)。 */
export function diskDeltaPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [p, sig] of after) if (before.get(p) !== sig) out.push(p);
  for (const p of before.keys()) if (!after.has(p)) out.push(p);
  return out.sort();
}

const realSpawn: NonNullable<AgyLeafDeps['spawn']> = async (argv, { cwd, timeoutMs, onLine }) => {
  const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf.trim()) onLine(buf);
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr };
  } finally {
    clearTimeout(killer);
  }
};

/**
 * 造 agy leaf runner (与 createAgentLeafRunner 同型, 只消费 input 的 prompt/model/writeAllow/leafTimeoutMs)。
 */
export function createAgyLeafRunner(opts: { cwd: string; leafTimeoutMs?: number }, deps: AgyLeafDeps = {}): AgentLeafRunner {
  const spawn = deps.spawn ?? realSpawn;
  const snapshot = deps.snapshot ?? gitDirtySnapshot;
  return async (input: AgentLeafInput): Promise<AgentLeafResult> => {
    const sep = input.model.indexOf(':');
    const provider = sep === -1 ? input.model : input.model.slice(0, sep);
    const modelId = sep === -1 ? '' : input.model.slice(sep + 1);
    if (provider !== AGY_CLI_PROVIDER || !modelId) {
      throw new Error(`[agy-leaf] 坐标 '${input.model}' 不是 ${AGY_CLI_PROVIDER}:<model> 形状`);
    }
    const timeoutMs = input.leafTimeoutMs ?? opts.leafTimeoutMs ?? 3_600_000;
    const lines: string[] = [];
    const t0 = Date.now();
    const before = snapshot(opts.cwd);
    const r = await spawn(agyLeafArgv(modelId, input.prompt, opts.cwd), {
      cwd: opts.cwd,
      timeoutMs,
      onLine: (l) => {
        lines.push(l);
      },
    });
    const parsed = parseAgyStream(lines);
    const usage = agyUsageToModelUsage(parsed.usage);
    // touched = 流里的 write 工具步 ∪ 盘面差 (shell 重定向写的文件只在盘面差里)。
    const fromStream = parsed.written.map((w) => relative(opts.cwd, isAbsolute(w) ? w : resolve(opts.cwd, w)).split('\\').join('/'));
    const fromDisk = diskDeltaPaths(before, snapshot(opts.cwd));
    const filesTouched = [...new Set([...fromStream, ...fromDisk])];
    if (parsed.status !== 'SUCCESS') {
      throw new Error(
        `[agy-leaf] agy 未返回 SUCCESS (exit ${r.code}, status=${parsed.status ?? 'n/a'}, ${Date.now() - t0} ms): ${r.stderr.trim().slice(-400)}`,
      );
    }
    const violations = agyWriteViolations(filesTouched, input.writeAllow, opts.cwd);
    if (violations.length) {
      // 事后对账 (文件头): 写已经发生, 但不冒充成功 —— 节点 failed, 越界清单进败因, 与 pi 腿的 BLOCKED 同一口径。
      throw new Error(
        `[agy-leaf] 写集越界 (事后对账, agy 工具在自己进程里跑, 引擎只能事后拒): ${violations.join(', ')} 不在 write_set ${JSON.stringify(input.writeAllow)} 内`,
      );
    }
    logger.info(
      { model: input.model, toolCalls: parsed.toolCalls, llmCalls: parsed.llmCalls, shellRuns: parsed.shellRuns, touched: filesTouched.length, ms: Date.now() - t0 },
      '[agy-leaf] done',
    );
    // shellRuns (ShellRun[] 形状: 命令 + 退出码) agy 流里拿不到退出码 → 不冒充, 只在日志里记次数。
    return { text: parsed.text, usage, filesTouched, toolCalls: parsed.toolCalls, llmCalls: parsed.llmCalls };
  };
}

/**
 * 装配点用: 给既有 agentRunner 套一层 —— 坐标是 `agy-cli:*` 就走 agy leaf, 否则原样。
 * 零回归: 非 agy 坐标的调用逐字节同旧。
 */
export function withAgyLeaf(inner: AgentLeafRunner, opts: { cwd: string; leafTimeoutMs?: number }, deps: AgyLeafDeps = {}): AgentLeafRunner {
  const agy = createAgyLeafRunner(opts, deps);
  return (input) => (input.model.startsWith(`${AGY_CLI_PROVIDER}:`) ? agy(input) : inner(input));
}
