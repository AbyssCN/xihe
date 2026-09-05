/**
 * S2 后半 —— `dag_goal detached=true` 的接线 (2026-08-03)。
 *
 * 它要成立的那件事: MCP server 是 stdio + **客户端消失即自杀**, 所以在飞的 goal 随会话一起死,
 * 「无人值守」在那条路上物理上不成立。detached 把活交给一个子进程。
 *
 * 这条网盯三个失效形态, 每个都是沉默的:
 *  ① **母进程抢先登记 run** → 盘上那条的属主是母进程, 而母进程随时会走 → 下一个 session
 *     hydrate 就把一个**正在跑的** run 判成"被打断"。属主必须是 worker。
 *  ② **起不来却照样回 runId** → 调用方拿着一个永远不会出现的 id 等下去。要当场响亮失败。
 *  ③ **worker 脚本路径按 cwd 拼** → 在别的 repo 里必然 Script not found, 而错误只进日志文件,
 *     run 静默卡死。dispatch.ts 的 dag-research 踩过同一个坑。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalTool } from './goal';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { RunGoalResult } from '../../harness/goal/run-goal';
import { buildHandlerArgs, resolveToolAndArgs } from '../../../scripts/goal-worker';

const neverRuns = async (): Promise<RunGoalResult> => {
  throw new Error('detached 路径不该在母进程里跑 runGoal');
};

const make = (spawnDetached?: (cmd: string[], o: { cwd: string; logPath: string }) => number | undefined) => {
  const root = mkdtempSync(join(tmpdir(), 'omd-det-'));
  const registry = new RunRegistry();
  const tool = createGoalTool({
    runGoal: neverRuns,
    runRegistry: registry,
    cwd: root,
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    continuity: { manager: new CheckpointManager(root), repoRoot: root },
    ...(spawnDetached ? { spawnDetached } : {}),
  });
  return { tool, registry, root };
};

const call = (tool: ReturnType<typeof createGoalTool>, args: Record<string, unknown>) =>
  tool.handler(args as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;

describe('dag_goal detached', () => {
  test('起子进程并立刻回 runId, 命令行带齐 worker 要的四样', async () => {
    const seen: { cmd: string[]; cwd: string; logPath: string }[] = [];
    const { tool, root } = make((cmd, o) => {
      seen.push({ cmd, ...o });
      return 4242;
    });
    const out = await call(tool, { goal: '长活的活', tier: 'simple', maxRounds: 3, detached: true });
    const text = out.content[0]!.text;

    expect(out.isError).toBeUndefined();
    const runId = /runId: (\S+)/.exec(text)?.[1];
    expect(runId).toBeTruthy();
    expect(text).toContain('pid 4242');

    const { cmd, cwd } = seen[0]!;
    expect(cmd[0]).toBe('bun');
    // 脚本路径按**包安装位置**解析, 不是 cwd 相对 —— 换个 repo 也找得到。
    expect(cmd[2]).toContain('scripts/goal-worker.ts');
    expect(cmd[2]!.startsWith('/')).toBe(true);
    expect(existsSync(cmd[2]!)).toBe(true); // 真存在, 不是一个拼错的路径
    expect(cmd).toContain('--run-id');
    expect(cmd[cmd.indexOf('--run-id') + 1]).toBe(runId);
    expect(cmd[cmd.indexOf('--cwd') + 1]).toBe(root);
    expect(cmd[cmd.indexOf('--goal') + 1]).toBe('长活的活');
    expect(cmd[cmd.indexOf('--tier') + 1]).toBe('simple');
    expect(cmd[cmd.indexOf('--max-rounds') + 1]).toBe('3');
    expect(cwd).toBe(root);
  });

  test('**母进程不登记 run** —— 属主必须是 worker, 否则下个 session 会把在跑的判成被打断', async () => {
    const { tool, registry } = make(() => 1);
    const out = await call(tool, { goal: 'g', detached: true });
    const runId = /runId: (\S+)/.exec(out.content[0]!.text)![1]!;
    // 这正是"毫秒级窗口"的代价, 也是它换来的正确性: 盘上那条由 worker 写, 属主是 worker。
    expect(registry.getStatus(runId)).toBeNull();
  });

  test('起不来 → **当场响亮失败**, 不回一个永远不会出现的 runId', async () => {
    const { tool } = make(() => {
      throw new Error('bun 不在 PATH 上');
    });
    const out = await call(tool, { goal: 'g', detached: true });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('bun 不在 PATH 上');
    expect(out.content[0]!.text).not.toContain('runId:');
  });

  test('不给 detached → 老路径 (母进程内跑), 一个子进程都不起', async () => {
    const seen: string[][] = [];
    const root = mkdtempSync(join(tmpdir(), 'omd-det-'));
    const tool = createGoalTool({
      runGoal: async (goal) => ({
        goal, tier: 'simple', acceptance: { kind: 'executable', command: 'x', expectExit: 0 },
        stages: [], sources: [], repoContext: '', converged: true, rounds: 1, reusedNodes: [], outcome: 'success' as const,
      }),
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      spawnDetached: (cmd: string[]) => {
        seen.push(cmd);
        return 1;
      },
    });
    const out = await call(tool, { goal: 'g' });
    await Bun.sleep(5);
    expect(seen).toHaveLength(0);
    expect(out.content[0]!.text).toContain('status: running');
  });
});

describe('预算轴的接线 (七态词表抓出的那个空旋钮)', () => {
  test('`budgetTokens` / `budgetMinutes` 真的到达引擎 config', async () => {
    // 缺陷本身: 上一轮实装了 `loopBudget` + 7 条测试, 但**没有任何调用方传它** —— 三态状态表
    // (✅/🟡/❌) 里它长得像"做完了", 而按证据七态它是 `Present` 不是 `Wired`。这条就是那条 wire 的网。
    const root = mkdtempSync(join(tmpdir(), 'omd-bud-'));
    let seen: { loopBudget?: { tokens?: number; ms?: number } } | undefined;
    const tool = createGoalTool({
      runGoal: async (goal, cfg) => {
        seen = cfg.dag as never;
        return {
          goal, tier: 'simple', acceptance: { kind: 'executable', command: 'x', expectExit: 0 },
          stages: [], sources: [], repoContext: '', converged: true, rounds: 1, reusedNodes: [], outcome: 'success' as const,
        } satisfies RunGoalResult;
      },
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
    });
    await call(tool, { goal: 'g', budgetTokens: 50_000, budgetMinutes: 30 });
    await Bun.sleep(5);
    expect(seen?.loopBudget?.tokens).toBe(50_000);
    expect(seen?.loopBudget?.ms).toBe(30 * 60_000); // 分钟 → 毫秒, 别在这一步丢单位
  });

  test('不给预算 → 不设 loopBudget (老语义零回归)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-bud-'));
    let seen: { loopBudget?: unknown } | undefined;
    const tool = createGoalTool({
      runGoal: async (goal, cfg) => {
        seen = cfg.dag as never;
        return {
          goal, tier: 'simple', acceptance: { kind: 'executable', command: 'x', expectExit: 0 },
          stages: [], sources: [], repoContext: '', converged: true, rounds: 1, reusedNodes: [], outcome: 'success' as const,
        } satisfies RunGoalResult;
      },
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
    });
    await call(tool, { goal: 'g' });
    await Bun.sleep(5);
    expect(seen?.loopBudget).toBeUndefined();
  });

  test('detached 把预算原样透传给 worker 命令行', async () => {
    const seen: string[][] = [];
    const { tool } = make((cmd) => { seen.push(cmd); return 7; });
    await call(tool, { goal: 'g', detached: true, budgetTokens: 1234, budgetMinutes: 5 });
    const cmd = seen[0]!;
    expect(cmd[cmd.indexOf('--budget-tokens') + 1]).toBe('1234');
    expect(cmd[cmd.indexOf('--budget-minutes') + 1]).toBe('5');
  });
});

describe('detached × branchStrategy (P0 2026-08-10: 参数矩阵缺口)', () => {
  // 缺陷本身: 进程内路径的 branch 隔离是好的 (goal-branch-strategy.test.ts 钉着), detached 的
  // spawn 命令却把 --branch-strategy 漏了, worker 里同一个 handler 拿不到参数 → 静默主树直跑。
  // 2026-08-10 三 SDD 并发实测: 三个 branch run 全落主树, git worktree list 零登记。
  // 证伪方式 (实跑过): 注释掉 goal.ts spawn cmd 里的 branch-strategy 转发行 → 本组 1、3 当场红。
  test('detached 把 branchStrategy 透传给 worker 命令行', async () => {
    const seen: string[][] = [];
    const { tool } = make((cmd) => { seen.push(cmd); return 7; });
    await call(tool, { goal: 'g', detached: true, branchStrategy: 'branch' });
    const cmd = seen[0]!;
    expect(cmd).toContain('--branch-strategy');
    expect(cmd[cmd.indexOf('--branch-strategy') + 1]).toBe('branch');
  });

  test('缺省 head 不带该参数 (worker 端缺省语义 = 今天的行为, 零回归)', async () => {
    const seen: string[][] = [];
    const { tool } = make((cmd) => { seen.push(cmd); return 7; });
    await call(tool, { goal: 'g', detached: true });
    expect(seen[0]!).not.toContain('--branch-strategy');
  });

  test('branch 档的即时回话要念出隔离模式 (调用方不该以为隔离而实际主树)', async () => {
    const { tool } = make(() => 7);
    const out = await call(tool, { goal: 'g', detached: true, branchStrategy: 'branch' });
    expect(out.content[0]!.text).toContain('branchStrategy: branch');
    expect(out.content[0]!.text).toContain('退回 head');
  });
});
describe('detached × slug (cb4a129 六留账: 显式 slug 双端转发)', () => {
  // 缺陷本身: schema 收 `slug`, detached 的 spawn cmd 却把它静默丢弃 → worker 里同一个 handler
  // 拿不到参数 → detached × 多图仓不挂票 (log 留痕), 单图仓照常挂 —— 多图仓成了盲区。
  // 2026-08-11 双端各一行: spawn 侧条件参 + worker 侧条件转发 (与 --sdd-path 同路)。
  // G-2 反向自检: 摘掉**任一端**的转发行, 对应测试当场红。
  test('G-1 spawn 侧: detached+slug → 命令行带 --slug 且值原样', async () => {
    const seen: string[][] = [];
    const { tool } = make((cmd) => { seen.push(cmd); return 7; });
    await call(tool, { goal: 'g', detached: true, slug: 'x' });
    const cmd = seen[0]!;
    expect(cmd[cmd.indexOf('--slug') + 1]).toBe('x');
  });

  test('INV-1: 不带 slug → spawn cmd 无 --slug (老命令逐字节不变, 无死参数)', async () => {
    const seen: string[][] = [];
    const { tool } = make((cmd) => { seen.push(cmd); return 7; });
    await call(tool, { goal: 'g', detached: true });
    expect(seen[0]!).not.toContain('--slug');
  });

  test('G-1 worker 侧: --slug 并进 handler 参数 (与 --sdd-path 同路)', () => {
    expect(buildHandlerArgs(['--run-id', 'r1', '--goal', 'g', '--slug', 'x']).slug).toBe('x');
  });

  test('G-2 worker 侧: 不带 --slug → 参数无 slug 键 (缺省语义逐字节不变)', () => {
    expect('slug' in buildHandlerArgs(['--run-id', 'r1', '--goal', 'g'])).toBe(false);
  });
});

// 切片 2 (2026-09-05): worker 端 --tool / --args-json 直通。
// MCP `dag_goal` 这条 path 仍走 buildHandlerArgs (--tool 缺省即 dag_goal),不传 --args-json;
// 但 `omd solve --detached` 与 `omd run --detached` / `omd call` 走 worker 的新形 ——
// 必须验证 MCP 侧的转发矩阵**没漂**(老 spawn 不带 --tool/--args-json 也跑得通)。
describe('切片 2 · worker resolveToolAndArgs 对 MCP 老 spawn 的兼容 (无 --tool/--args-json 也要走得通)', () => {
  test('MCP 老 spawn 形态(无 --tool, 无 --args-json)→ resolveToolAndArgs 仍回 (dag_goal, buildHandlerArgs(argv))', () => {
    const argv = ['--run-id', 'r1', '--cwd', '/w', '--goal', 'g', '--tier', 'simple', '--max-rounds', '3'];
    const r = resolveToolAndArgs(argv);
    expect(r.tool).toBe('dag_goal');
    expect(r.args).toEqual(buildHandlerArgs(argv));
  });

  test('MCP 老 spawn 形态带 --slug → resolveToolAndArgs 透传 slug (cb4a129 同款)', () => {
    const argv = ['--run-id', 'r1', '--cwd', '/w', '--goal', 'g', '--slug', 'x'];
    const r = resolveToolAndArgs(argv);
    expect(r.tool).toBe('dag_goal');
    expect(r.args.slug).toBe('x');
  });
});
