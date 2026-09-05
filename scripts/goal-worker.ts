#!/usr/bin/env bun
/**
 * scripts/goal-worker —— `dag_goal detached=true` 的**脱离会话工作进程** (S2 后半 / D-W, 2026-08-03);
 * 切片 2 (2026-09-05): 加 `--tool <name>` 与 `--args-json '<obj>'`,通用承接 `omd call` / `omd run --detached`。
 *
 * ## 为什么需要它
 *
 * omd 的 MCP server 是 `StdioServerTransport` + **客户端消失即自杀**(`server.ts` 的退出双保险,
 * 那是修僵尸忙转加的, 是设计)。于是 Claude 会话一结束, 正在跑的 goal 就死在半路 ——
 * 「无人值守跑真活」在那条路上**物理上不成立**, 不管引擎本身多结实。
 *
 * 本进程是**第二个适配器**, 不是第二套引擎: 它照 `omd mcp` 的引导序起来, 装同一份
 * `assembleOmdMcpTools`, 调目标工具 (默认 `dag_goal`)。零新执行路径 —— stamp / 闸 / checkpoint /
 * 留痕 / 毒集全部照旧。(本仓最贵的教训之一就是"第二套语义", 见 `iterateExecutorDag` 那条。)
 *
 * ## 三条必须与 `omd mcp` 逐字一致的引导 (错一条就是两套行为)
 *
 * 1. **不 import `script-bootstrap`。** 它会把 `OMD_DATA_HOME` 设成 `~/.omd`, 于是运行态出 cwd ——
 *    而 MCP server 那条路读的是 `<cwd>/.omd/`。一旦分叉, 母进程与本进程写读两份 `runs.db` 与
 *    两份 `continuity/`, 「掉线了接着跑」当场作废, **而且症状是沉默的** (两边各自都自洽)。
 * 2. **调 `bootstrapModelRuntime()`。** 短命进程不走 TUI boot, 不引导则 provider 注册表是空的,
 *    leaf 会全部静默秒败 (settle(null) 空 output)。
 * 3. **cwd 由 `--cwd` 显式给**, 与母进程一致 —— `.omd/` 全是 cwd 相对的。
 *
 * ## 生命周期
 *
 * 母进程 (dag_goal) 先把 runId 登记进共享的 `runs.db` (pending), 再 spawn 本进程; 本进程一起跑就
 * **把属主 pid 改成自己** (经 registry 的 start/resume), 于是任何后来的 session hydrate 时看到的是
 * "running 且属主活着" —— 而不是"属主死了 → 判成被打断"。母进程随时可以走。
 *
 * ## 转发矩阵 (切片 2)
 *
 * 转发矩阵必须与母进程 spawn cmd 一一对应 —— 漏一格 = 参数矩阵空格 (P0 2026-08-10 branch 同形)。
 * 两条路:
 *  · `--tool dag_goal` (默认) + 现有 flag 表 → `buildHandlerArgs(argv)`
 *  · `--tool <name>` + `--args-json '<obj>'` → 直接 JSON.parse,不走 flag 矩阵
 * 第二条路给 `omd call` / `omd run --detached` 用 —— 不可能为每个工具都列一份 flag 翻译。
 *
 * 用法 (通常由 `dag_goal detached=true` 起, 手动跑也行):
 *   bun run scripts/goal-worker.ts --run-id <id> --cwd <dir> --goal "..." [--tier simple|complex]
 *                                  [--max-rounds N] [--research-rounds N] [--slug <map-slug>]
 *                                  [--tool <name>] [--args-json '<obj>']
 */
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { assembleOmdMcpTools } from '../src/mcp/assemble';
import { RunRegistry } from '../src/mcp/run-registry';
import { createRunStore } from '../src/mcp/run-store';
import { verifyTerminalPersisted } from '../src/mcp/terminal-verify';
import { createTuiUsageLedger } from '../src/tui/usage/ledger';
import { observeModelUsage } from '../src/model/accounting';
import { join } from 'node:path';

/**
 * 把模型用量记进 `<cwd>/.omd/tui-usage.jsonl` —— **与 `omd mcp` 分支同一份账本同一条钩子**
 * (`src/harness/cli.ts:80-84`)。返回 detach。
 *
 * ⚠ **这一格漏了会静默**(G-1, 2026-08-25 活体):`emitModelUsage` 是观察者钩子,
 * 无订阅者 = 逐条通知进真空,没有任何报错。整夜四个 detached run 一条用量都没进账,
 * 账本零增长,而夜间 goal §3 恰恰要求从这本账增量读三个数。形态与 `cli.ts:74-79`
 * 注释里那条「机制在、生产零生效」逐字同族 —— 当时补了 mcp 分支,本进程漏了。
 *
 * 账本复用 tui 那份:**一个仓一本账**,两本账才分不清。`source` 由 emit 侧第三参带,
 * 订阅侧照抄,不自己编恒定标签(那样 chat 轮与引擎调用在账上分不开)。
 */
export function attachUsageLedger(cwd: string): () => void {
  // OMD_TUI_USAGE_DIR: 测试接缝 —— fixture 记账不许污染真仓的 5h 窗口。
  const ledger = createTuiUsageLedger({ dir: process.env.OMD_TUI_USAGE_DIR || join(cwd, '.omd') });
  return observeModelUsage((u, model, origin) => ledger.record(u, model, origin));
}

/** argv → dag_goal handler 参数 (纯函数, 供 goal-detached.test.ts 直接钉转发矩阵)。
 *  转发矩阵必须与母进程 spawn cmd 一一对应 —— 漏一格 = 参数矩阵空格 (P0 2026-08-10 branch 同形)。
 *  `--slug` 于 2026-08-11 (cb4a129 留账) 补入: detached × 多图仓与前台同路挂票。 */
export const buildHandlerArgs = (argv: string[]): Record<string, unknown> => {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    goal: opt('goal') ?? '',
    resume: opt('run-id') ?? '',
    ...(opt('tier') ? { tier: opt('tier') } : {}),
    ...(opt('max-rounds') ? { maxRounds: Number(opt('max-rounds')) } : {}),
    ...(opt('research-rounds') ? { researchRounds: Number(opt('research-rounds')) } : {}),
    ...(opt('budget-tokens') ? { budgetTokens: Number(opt('budget-tokens')) } : {}),
    ...(opt('budget-minutes') ? { budgetMinutes: Number(opt('budget-minutes')) } : {}),
    ...(opt('result-out') ? { resultOut: opt('result-out') } : {}),
    // P0 (2026-08-10): 不转发这一格 = branch 静默变 head (参数矩阵空格)。worker 里是同一个
    // dag_goal handler, 它拿到参数就会走进程内路径的 prepareRunWorktree —— 单一实现, 零复刻。
    ...(opt('branch-strategy') ? { branchStrategy: opt('branch-strategy') } : {}),
    // 直通入口 (SDD 2026-08-10-solve-sdd-direct-entry): 已结晶契约免转录, 同 handler 同语义。
    ...(opt('sdd-path') ? { sddPath: opt('sdd-path') } : {}),
    // 双端转发 (SDD goal-worker --slug, 2026-08-11): spawn cmd 每一格在此都有对应 —— 漏一格即盲区。
    ...(opt('slug') ? { slug: opt('slug') } : {}),
  };
};

/**
 * 切片 2: 把 `--tool <name>` + `--args-json '<obj>'` 解析成 (tool, args) 二元组。
 * 纯函数;非 dag_goal 走 args-json 直通,dag_goal 缺 args-json 时退回 buildHandlerArgs 兼容旧 spawn。
 *
 * JSON 解析失败 → 抛 (主流程接住即响亮退出 2,与「--run-id 与 --goal 必填」同源)。
 */
export function resolveToolAndArgs(
  argv: string[],
): { tool: string; args: Record<string, unknown> } {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tool = opt('tool') ?? 'dag_goal';
  const argsJson = opt('args-json');
  if (argsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsJson);
    } catch (e) {
      throw new Error(`--args-json 解析失败: ${(e as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--args-json 必须是 JSON 对象');
    }
    return { tool, args: parsed as Record<string, unknown> };
  }
  if (tool === 'dag_goal') {
    return { tool, args: buildHandlerArgs(argv) };
  }
  // 非 dag_goal 又没给 args-json → 让主流程以「缺参」响亮拒(同源用法错误,exit 2)。
  throw new Error(`--tool ${tool} 必须配 --args-json '<obj>' (非 dag_goal 工具无 flag 翻译)`);
}

// 主流程收进 import.meta.main: 测试 import 本模块只取 buildHandlerArgs, 不触发 argv 校验/起跑。
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const runId = opt('run-id');
  const cwd = opt('cwd') ?? process.cwd();
  if (!runId) {
    console.error('goal-worker: --run-id 必填');
    process.exit(2);
  }

  let resolved: { tool: string; args: Record<string, unknown> };
  try {
    resolved = resolveToolAndArgs(argv);
  } catch (e) {
    console.error(`goal-worker: ${(e as Error).message}`);
    process.exit(2);
  }
  const { tool, args } = resolved;

  // 旧约定保持: dag_goal 必须有 goal(向后兼容老 spawn 形态 —— 即便只是借道首跑也得有题面)。
  // 非 dag_goal 的工具不卡这一条,args-json 解析过了就算合法。
  if (tool === 'dag_goal' && !(typeof args.goal === 'string' && args.goal.length > 0)) {
    console.error('goal-worker: --run-id 与 --goal 必填');
    process.exit(2);
  }

  bootstrapModelRuntime();
  // G-1: 订阅必须在任何模型调用之前 —— 钩子是**只通知不回放**的, 起跑后再订阅就漏掉前面那些。
  attachUsageLedger(cwd);

  // 与母进程**同一份** runs.db —— 这是"脱离会话"的全部要害: 母进程写 pending, 本进程接手改 running
  // 并把属主 pid 换成自己, 后来的 session 才看得到一个"活着的 run"而不是一个孤儿。
  const registry = new RunRegistry(undefined, { store: createRunStore({ path: join(cwd, '.omd', 'runs.db') }) });
  const tools = assembleOmdMcpTools({ cwd, runRegistry: registry });
  const targetTool = tools.find((t) => t.name === tool);
  if (!targetTool) {
    console.error(`goal-worker: 装配里没有 ${tool} (assemble 变了?)`);
    process.exit(2);
  }

  // dag_goal 是 fire-and-forget (三段式: 起跑即返回 runId), 所以这里**必须等到终态**才能退 ——
  // 进程一退, 在飞的活就跟着没了, 那正是本进程存在的理由。
  // 非 dag_goal (例如 solve/run 等单发工具) 由 handler 自己决定同步语义,这里不强制 wait。
  const res = (await targetTool.handler(
    args as never,
    {} as never,
  )) as { content: { text: string }[]; isError?: boolean };

  if (tool !== 'dag_goal') {
    // 非 goal 工具 = 单发,直接 stdout 输出 handler 文本内容 + 同步 exit。
    // stdout(不放日志,日志走 stderr;CLI `call` 接管 stdout 拿到结果)。
    process.stdout.write(res.content.map((c) => c.text).join('\n'));
    process.exit(res.isError ? 1 : 0);
  }

  if (res.isError) {
    console.error(`goal-worker: dag_goal 拒绝起跑 — ${res.content[0]?.text ?? ''}`);
    // 登记成 failed, 否则盘上留一个 pending 的孤儿 (属主 pid 是本进程, 而本进程马上就没了)。
    try {
      registry.fail(runId, `起跑被拒: ${res.content[0]?.text ?? ''}`);
    } catch {
      /* 已是终态就算了 */
    }
    process.exit(1);
  }

  console.error(`goal-worker: runId=${runId} 已起跑 (pid ${process.pid}), 等终态…`);

  // #179: worker 真身自报 —— 母进程 (MCP server) 点火回执的座位行是它的内存态, 与本进程
  // (新进程, 读盘上 config + env) 漂移时以本自报为准。落 continuity 目录 —— **刻意不落**
  // `.omd/runs/<runId>` (那是 branch 档 worktree 的目标, 提前建目录会让 `git worktree add` 失败)。
  // fail-open 但留证据: 自报写不出不阻断 run, 一行错误原文进 stderr。
  try {
    const { resolveRoleModelConfigured } = await import('../src/model/role-models');
    const { writeSeatSelfReport } = await import('../src/mcp/seat-self-report');
    const actual = resolveRoleModelConfigured('agent', { env: process.env }).model;
    writeSeatSelfReport(join(cwd, '.omd', 'continuity', runId), {
      v: 1,
      schema: 'oh-my-dag.seat-self-report.v1',
      runId,
      seatId: 'agent',
      actualModel: actual,
      actualSeatLabel: null,
      reportedAt: new Date().toISOString(),
      source: `goal-worker pid=${process.pid}`,
    });
    console.error(`goal-worker: #179 seat 自报 agent=${actual}`);
  } catch (e) {
    console.error(`goal-worker: #179 seat 自报失败 (不阻断): ${e instanceof Error ? e.message : String(e)}`);
  }

  // 轮询自己的 registry 直到终态。`dag_goal` 的 .then 会把状态写成 done/failed/cancelled。
  const TERMINAL = new Set(['done', 'failed', 'cancelled']);
  for (;;) {
    const st = registry.getStatus(runId);
    if (st && TERMINAL.has(st)) {
      // 终态写穿核验 (S-12 的灯, 2026-08-02): 内存终态 ≠ 盘上终态 —— 三次 live 在这儿静默丢过。
      // 必须用**全新连接**核验与修复 (本进程的长命连接正是嫌疑面), 修不动才带着响亮日志退非零。
      // ⚠ 先 `registry.close()`: 干净关闭会 checkpoint WAL, 且核验时进程内只剩一条写连接
      // (2026-08-03 实测那次修复报 `disk I/O error` 时, 本进程这条还开着)。
      registry.close();
      const verdict = verifyTerminalPersisted(join(cwd, '.omd', 'runs.db'), runId, st);
      // S3 / C-3 / #250 / INV-11 终态分词 —— done 且 meta.doneKind 在场 (三值纪律: 缺席=不适用,
      // 非 goal 入口不在) 时一并念出, 让本进程 stdout 与 dag_status 同口径: 「机器判过」
      // 与「没人判」是两种状态, 不许素面记 done。
      const dk = st === 'done' ? registry.getRecord(runId)?.meta.doneKind : undefined;
      const dkLine = dk ? ` doneKind=${dk}` : '';
      console.error(`goal-worker: runId=${runId} 终态 ${st}${dkLine} (写穿核验: ${verdict})`);
      process.exit(verdict === 'unrecoverable' ? 3 : st === 'done' ? 0 : 1);
    }
    await Bun.sleep(2000);
  }
}
