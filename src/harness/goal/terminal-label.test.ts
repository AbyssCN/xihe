/**
 * D-2 终态字面 (契约 `docs/plan/2026-09-05-假success三闸-执行契约.md` 切片 2) —— INV-3 / INV-4。
 *
 * 盘上事实: 探索型验收 (无机械判据) 收敛后 `doneKind=exploratory-unverified`, 而 resultOut 首行
 * 印 `outcome: success`、CLI 印 `omd solve: outcome=success` —— 读的人分不出「机器判过」与
 * 「机器根本没判据可判」。这两件事的下一步完全不同, 念成同一个词就是把没验过的活当验过的收。
 *
 * ⚠ `outcome` 一个字都不动 (pathfinder reflow 与 bench 读的是它), 新增的是**另一行**。
 *
 * ## 证伪 (每条真跑过一次)
 * · 去掉 run-goal.ts 里 `TERMINAL_UNVERIFIED` 那一格 ⇒ ★探索型那条红 (回到 'success')。
 * · 去掉 goal.ts resultOut 头部的 `terminal:` 行 ⇒ ★INV-4 那条红。
 * · 去掉 cli-solve.ts 收尾行的 `terminal=` ⇒ CLI 那条红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runGoal, TERMINAL_UNVERIFIED, type RunGoalConfig, type RunGoalResult } from './run-goal';
import type { AcceptanceSpec, GoalClassification } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import { createGoalTool, type GoalToolDeps } from '../../mcp/tools/goal';
import { RunRegistry } from '../../mcp/run-registry';
import { runSolveCLI, type SolveSpawn, type SolveSpawnHandle, type SolveSpawnOpts } from '../cli-solve';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// ── INV-3: run-goal 的终态字面 ───────────────────────────────────────────────────

/** 执行型带环外 `accept` 节点; 探索型没有它 (环的结论只看 conductor 跑没跑完)。 */
function executeDag(withAccept: boolean): ExecutorDagResult {
  return {
    plan: { name: 'goal-orchestrating-loop', nodes: {} },
    results: {
      ...(withAccept
        ? {
            accept: {
              id: 'accept', status: 'done', kind: 'command', output: '',
              deps: ['conductor'], usage: { in: 0, out: 0 }, timedOut: false, signal: null,
            },
          }
        : {}),
      conductor: {
        id: 'conductor', status: 'done', kind: 'agent', output: '[conductor 派工 2 次, 均成功]',
        deps: [], usage: { in: 1, out: 1 }, filesTouched: [],
      },
    },
    reusedNodes: [],
  } as unknown as ExecutorDagResult;
}

const EXEC_ACC: AcceptanceSpec = { kind: 'executable', command: 'true', expectExit: 0 };
const EXPLORE_ACC: AcceptanceSpec = { kind: 'exploratory', learningGoal: '学到点东西', affordableLoss: '一轮' };

function cfg(acceptance: AcceptanceSpec): RunGoalConfig {
  return {
    cwd: tmp('omd-terminal-label-'),
    dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
    _today: () => '2026-09-05',
    _classify: async (): Promise<GoalClassification> => ({ tier: 'simple', acceptance }),
    _runDag: (async (_plan: ConductorPlan) => executeDag(acceptance.kind === 'executable')) as never,
    // 非空 diff: 单一变量 —— 这组测的是终态字面, 别让零写入闸 (D-1) 掺进来。
    writeSet: { _collectChangedFiles: () => ['src/a.ts'] },
  };
}

describe('terminalLabel — INV-3', () => {
  test('★ 探索型收敛 ⇒ outcome 仍是 success, 而 terminal 是 success-unverified (机器没判据可判)', async () => {
    const r = await runGoal('探索一下', cfg(EXPLORE_ACC));
    expect(r.converged).toBe(true);
    expect(r.outcome).toBe('success'); // 一个字都没动
    expect(r.terminalLabel).toBe(TERMINAL_UNVERIFIED);
    expect(TERMINAL_UNVERIFIED).toBe('success-unverified');
  });

  test('对照臂: 执行型收敛 ⇒ terminal 逐字是 success (机器判过, 不降级)', async () => {
    const r = await runGoal('干个活', cfg(EXEC_ACC));
    expect(r.converged).toBe(true);
    expect(r.outcome).toBe('success');
    expect(r.terminalLabel).toBe('success');
  });
});

// ── INV-4: resultOut 头部 ───────────────────────────────────────────────────────

const fakeResult = (goal: string, extra: Partial<RunGoalResult>): RunGoalResult => ({
  goal,
  tier: 'simple',
  acceptance: EXPLORE_ACC,
  stages: [],
  sources: [],
  repoContext: '',
  converged: true,
  outcome: 'success',
  rounds: 1,
  reusedNodes: [],
  ...extra,
});

describe('resultOut 头部 — INV-4', () => {
  test('★ 第二行恒为 `terminal: <label>`, 且 `outcome:` 行逐字同旧', async () => {
    const root = tmp('omd-terminal-resultout-');
    const resultOut = join(root, '.omd', 'solve-results', 't.md');
    mkdirSync(dirname(resultOut), { recursive: true });
    const tool = createGoalTool({
      runGoal: async (goal: string) => fakeResult(goal, { terminalLabel: TERMINAL_UNVERIFIED }),
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    } as unknown as GoalToolDeps);
    await tool.handler({ goal: '探索一下', resultOut } as never, {} as never);
    await new Promise((r) => setTimeout(r, 30));
    const lines = readFileSync(resultOut, 'utf8').split('\n');
    expect(lines[0]).toBe('outcome: success'); // 字面未动 (pathfinder reflow / bench 读它)
    expect(lines[1]).toBe(`terminal: ${TERMINAL_UNVERIFIED}`);
  });

  test('terminalLabel 与 outcome 相同时也印 —— 机器读时不必判缺席', async () => {
    const root = tmp('omd-terminal-resultout-same-');
    const resultOut = join(root, '.omd', 'solve-results', 't.md');
    mkdirSync(dirname(resultOut), { recursive: true });
    const tool = createGoalTool({
      runGoal: async (goal: string) => fakeResult(goal, { terminalLabel: 'success' }),
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    } as unknown as GoalToolDeps);
    await tool.handler({ goal: '干个活', resultOut } as never, {} as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(readFileSync(resultOut, 'utf8').split('\n')[1]).toBe('terminal: success');
  });
});

// ── CLI 收尾行 ──────────────────────────────────────────────────────────────────

describe('omd solve 收尾行带 terminal=', () => {
  test('★ resultOut 有 terminal 行 ⇒ 收尾行印 outcome= 与 terminal= 两格', async () => {
    const cwd = tmp('omd-terminal-cli-');
    const resultOut = join(cwd, '.omd', 'solve-results', 't.md');
    mkdirSync(dirname(resultOut), { recursive: true });
    const seen: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      seen.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    const spawn = ((_cmd: string[], _opts: SolveSpawnOpts): SolveSpawnHandle => {
      writeFileSync(resultOut, `outcome: success\nterminal: ${TERMINAL_UNVERIFIED}\nrunId: r-test\nacceptance: exploratory\n`);
      return { exited: Promise.resolve(0) };
    }) as SolveSpawn;
    try {
      const code = await runSolveCLI(['探索一下', '--cwd', cwd, '--result-out', resultOut], { spawn });
      expect(code).toBe(0);
    } finally {
      process.stderr.write = orig;
    }
    expect(seen.join('')).toContain(`omd solve: outcome=success terminal=${TERMINAL_UNVERIFIED}`);
  });

  test('老格式 resultOut (没有 terminal 行) ⇒ 印「缺席」而不是拿 outcome 顶替 (仓规坑 ①)', async () => {
    const cwd = tmp('omd-terminal-cli-old-');
    const resultOut = join(cwd, '.omd', 'solve-results', 't.md');
    mkdirSync(dirname(resultOut), { recursive: true });
    const seen: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      seen.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    const spawn = ((_cmd: string[], _opts: SolveSpawnOpts): SolveSpawnHandle => {
      writeFileSync(resultOut, 'outcome: success\nrunId: r-test\nacceptance: executable\n');
      return { exited: Promise.resolve(0) };
    }) as SolveSpawn;
    try {
      await runSolveCLI(['干个活', '--cwd', cwd, '--result-out', resultOut], { spawn });
    } finally {
      process.stderr.write = orig;
    }
    expect(seen.join('')).toContain('omd solve: outcome=success terminal=(缺席)');
  });
});
