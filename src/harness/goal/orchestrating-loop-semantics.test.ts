/**
 * src/harness/goal/orchestrating-loop-semantics.test —— P3 S6b 跟进 (owner 2026-09-02 裁 3-A):
 * 四类在旧路径测试里被钉住、而循环路径上此前**没有**对应判据的语义, 各写一条循环路径变体:
 *   · 判据陈旧闸 (stale-acceptance): 回灌过 ∧ accept 的绿是复用的 ⇒ 复验;
 *   · 最佳绿底 (best-green-floor): 第一跑判据绿 → 终审否决 → 回灌后红 ⇒ 还原到那次绿;
 *   · 板事件 (board verified): executable 发 verified, 探索型不发;
 *   · rubric 终态 (rubric-unwired): rubric 分型 + 验收步缺席 + conductor 跑完 ⇒ 终态字面 rubric-unwired, success 不可达。
 * 外加 2-C: work(resume_of) 的上一次结果由运行时机械回灌进 goal。
 *
 * 反向自检: run-goal 里 `replanned` 去掉 `|| reinjected` → 陈旧闸那条红; adaptCard 去掉 injectPriorResult → 2-C 那条红。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult, LeafResult } from '../dag/types';
import { readBoard } from '../board/run-board';
import type { ConductorCtx } from '../conductor/types';
import { RECHECK_TASK_HEAD } from './orchestrating-loop';
import { freezeRubric } from './rubric-spec';
import type { GoalClassification } from './classify-acceptance';
import { BEST_GREEN_LABEL, runGoal, TERMINAL_RUBRIC_UNWIRED, type RunGoalConfig } from './run-goal';
import { createConductorRuntimeTools, CONDUCTOR_NODE_ID, RESUME_PRIOR_HEAD } from './orchestrating-loop';

const EXEC_ACCEPT: GoalClassification['acceptance'] = { kind: 'executable', command: 'bun test src/a.test.ts', expectExit: 0 };
const EXPLORE_ACCEPT = { kind: 'exploratory', learningGoal: 'learn', acceptableLoss: 'none' } as unknown as GoalClassification['acceptance'];
const classify = (acceptance: GoalClassification['acceptance']) => async (): Promise<GoalClassification> => ({ tier: 'complex', acceptance, route: { kind: 'none' } });
const dissent = 'verifier 异议原文: 实装绕开了第 3 条要求';
/**
 * **首判红、D-14 窄复审绿**。本文件测的是判据陈旧闸 / 异议留痕这些**回灌之外**的语义,
 * 所以复审必须放行 —— 一个恒判 fail 的判官会让每条用例都在窄复审那一步翻成 verifier-rejected,
 * 于是测到的是复审而不是本文件要测的那道闸 (2026-09-04 窄复审上线时实测到这一点)。
 * 认第几发靠卷面首行 `RECHECK_TASK_HEAD`, 不靠调用计数猜。
 */
const failingVerifier = async (req: { task: string }) =>
  req.task.startsWith(RECHECK_TASK_HEAD)
    ? { pass: true, reason: 'finding addressed', target: 'implementation' as const, usage: { in: 0, out: 0 } }
    : { pass: false, reason: dissent, target: 'implementation' as const, usage: { in: 0, out: 0 } };

interface CallShape {
  acceptStatus?: 'done' | 'failed';
  /** conductor 节点按这个败因判 failed (缺席 = done)。 */
  conductorFailureKind?: string;
  acceptSkipped?: boolean;
  conductorFiles?: string[];
  /** 每次调用前跑一段副作用 (写盘 / 删盘)。 */
  before?: () => void;
}

/** 假引擎: 按调用序号取形状; accept 绿且有 verifier 时调一次 verifier (模拟闸红短路)。 */
const fakeEngine = (shapes: CallShape[], seen: ConductorPlan[] = []): NonNullable<RunGoalConfig['_runDag']> => async (plan, cfg) => {
  const shape = shapes[seen.length] ?? shapes[shapes.length - 1]!;
  seen.push(plan);
  shape.before?.();
  const results: ExecutorDagResult['results'] = {};
  for (const id of Object.keys(plan.nodes)) {
    const n = plan.nodes[id]!;
    results[id] =
      n.executor === 'command'
        ? ({ id, status: shape.acceptStatus ?? 'done', kind: 'command', output: '', deps: n.depends_on ?? [], usage: { in: 0, out: 0 }, exitCode: (shape.acceptStatus ?? 'done') === 'done' ? 0 : 1, ...(shape.acceptSkipped ? { skipped: true } : {}) } as never)
        : ({ id, status: shape.conductorFailureKind ? 'failed' : 'done', ...(shape.conductorFailureKind ? { failureKind: shape.conductorFailureKind } : {}), kind: 'agent', output: shape.conductorFailureKind ? '[agent-leaf] 529 overloaded_error' : 'conductor report', deps: [], usage: { in: 1, out: 1 }, ...(shape.conductorFiles ? { filesTouched: shape.conductorFiles, artifactRoot: cfg.continuity?.execRoot ?? cfg.continuity?.repoRoot } : {}) } as never);
  }
  let verification: ExecutorDagResult['verification'];
  if (cfg.verifier && (shape.acceptStatus ?? 'done') === 'done') {
    const v = await cfg.verifier({ task: 't', plan, results });
    verification = { pass: v.pass, reason: v.reason, attempts: 1, escalated: false, conductorModel: 'c:m' };
  }
  return { plan, sessionId: 's', levels: [], results, usage: { conductor: { in: 0, out: 0 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 }, reusedNodes: [], observations: [], ...(verification ? { verification } : {}) } as unknown as ExecutorDagResult;
};

describe('循环路径 · 判据陈旧闸 (回灌 = 重规划过)', () => {
  test('★ 回灌后 accept 的绿是复用的 ⇒ 复验 (commandRunner: 基线 1 + 复验 1 = 2); 复验红 ⇒ 不收敛', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-stale-'));
    const calls: string[] = [];
    const r = await runGoal('修 add()', {
      cwd,
      dag: {
        conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier,
        commandRunner: (async (req: { command: string }) => { calls.push(req.command); return { exitCode: 1, stdout: '', stderr: '', timedOut: false }; }) as never,
      } as ExecutorDagConfig,
      _classify: classify(EXEC_ACCEPT),
      _runDag: fakeEngine([{ acceptStatus: 'done' }, { acceptStatus: 'done', acceptSkipped: true }]),
    });
    // 证伪: `replanned` 去掉 `|| reinjected` → 复验不跑, calls 只有基线那 1 次, 且陈旧的绿撑起收敛。
    expect(calls.filter((c) => c === 'bun test src/a.test.ts').length).toBe(2);
    expect(r.converged).toBe(false);
  });

  test('判别力: 回灌过但 accept 这一跑真跑过 (skipped 缺席) ⇒ 不复验, 收敛', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-stale-no-'));
    const calls: string[] = [];
    const r = await runGoal('修 add()', {
      cwd,
      dag: {
        conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier,
        commandRunner: (async (req: { command: string }) => { calls.push(req.command); return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; }) as never,
      } as ExecutorDagConfig,
      _classify: classify(EXEC_ACCEPT),
      _runDag: fakeEngine([{ acceptStatus: 'done' }, { acceptStatus: 'done' }]),
    });
    expect(calls.filter((c) => c === 'bun test src/a.test.ts').length).toBe(1);
    expect(r.converged).toBe(true);
  });
});

describe('循环路径 · 最佳绿底 (INV-1)', () => {
  test('★ 第一跑判据绿 → 终审否决 → 回灌后红 ⇒ 还原到那次绿, 终态 verifier-rejected, 异议原文进 result', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-bgf-'));
    const artifact = join(cwd, 'delivered.txt');
    const r = await runGoal('做一件事', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier } as ExecutorDagConfig,
      _classify: classify(EXEC_ACCEPT),
      _runDag: fakeEngine([
        { acceptStatus: 'done', conductorFiles: [artifact], before: () => writeFileSync(artifact, '真交付') },
        { acceptStatus: 'failed', before: () => rmSync(artifact) },
      ]),
    });
    expect(existsSync(artifact)).toBe(true);
    expect(readFileSync(artifact, 'utf8')).toBe('真交付');
    expect(r.bestGreenFloor?.action).toBe('restore');
    expect(r.stages.at(-1)!.summary).toContain(BEST_GREEN_LABEL);
    expect(r.outcome).toBe('verifier-rejected');
    expect(r.verifierDissent).toBe(dissent);
  });
});

describe('循环路径 · 板事件 verified', () => {
  test('executable + accept 绿 ⇒ 板含 verified pass; 探索型 ⇒ 不发 verified', async () => {
    const cwd1 = mkdtempSync(join(tmpdir(), 'omd-loop-board-exec-'));
    await runGoal('修 add()', { cwd: cwd1, dag: { conductorModel: 'c:m', leafModel: 'l:m', sessionId: 'loop-b1' } as ExecutorDagConfig, _classify: classify(EXEC_ACCEPT), _runDag: fakeEngine([{ acceptStatus: 'done' }]) });
    const e1 = readBoard(cwd1);
    expect(e1.some((e) => e.runId === 'loop-b1' && e.event === 'verified' && (e as { verdict?: string }).verdict === 'pass')).toBe(true);
    expect(e1.some((e) => e.runId === 'loop-b1' && e.event === 'terminal')).toBe(true);

    const cwd2 = mkdtempSync(join(tmpdir(), 'omd-loop-board-explore-'));
    await runGoal('研究一下', { cwd: cwd2, dag: { conductorModel: 'c:m', leafModel: 'l:m', sessionId: 'loop-b2' } as ExecutorDagConfig, _classify: classify(EXPLORE_ACCEPT), _runDag: fakeEngine([{}]) });
    const e2 = readBoard(cwd2);
    expect(e2.some((e) => e.runId === 'loop-b2' && e.event === 'verified')).toBe(false);
    expect(e2.some((e) => e.runId === 'loop-b2' && e.event === 'terminal')).toBe(true);
  });
});

describe('循环路径 · rubric 终态 (INV-5)', () => {
  test('rubric 分型 + 验收步缺席 + conductor 跑完 ⇒ terminalLabel rubric-unwired, success 不可达, 图只有 conductor 节点', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-rubric-'));
    const seen: ConductorPlan[] = [];
    const r = await runGoal('写一份报告', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _classify: async () => ({ tier: 'complex', acceptance: { kind: 'rubric', checklist: freezeRubric([{ id: 'r1', requirement: '点名数据来源' }]) }, route: { kind: 'none' } }),
      _runDag: fakeEngine([{}], seen),
    });
    expect(Object.keys(seen[0]!.nodes)).toEqual([CONDUCTOR_NODE_ID]);
    expect(r.path).toBe('orchestrating-loop');
    expect(r.terminalLabel).toBe(TERMINAL_RUBRIC_UNWIRED);
    expect(r.converged).toBe(false);
    expect(r.outcome).not.toBe('success');
    expect(r.stages.at(-1)!.summary).toContain(TERMINAL_RUBRIC_UNWIRED);
  });
});

describe('2-C · work(resume_of) 上一次结果机械回灌', () => {
  const CTX: ConductorCtx = { cwd: '/tmp/x', writeRoot: '/tmp/x', allowlist: [], maxFanout: 2, seats: { worker: 'w', escalation: 'e', verify: 'v' }, researchAvailable: false };
  const exec = (plan: ConductorPlan, status: LeafResult['status']): ExecutorDagResult =>
    ({ plan, sessionId: 's', levels: [], results: Object.fromEntries(Object.keys(plan.nodes).map((id) => [id, { id, status, kind: 'agent', output: `report of ${id}: expected 2 got 3`, deps: [], usage: { in: 1, out: 1 }, filesTouched: ['src/a.ts'] }])), usage: { conductor: { in: 0, out: 0 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 }, reusedNodes: [], observations: [] }) as unknown as ExecutorDagResult;

  test('★ 同 id 重派: 节点 id 不再加前缀, goal 末尾带上一次的状态 / 文件 / 报告尾', async () => {
    const seen: ConductorPlan[] = [];
    const tools = createConductorRuntimeTools({ ctx: CTX, runChild: async (p) => { seen.push(p); return exec(p, seen.length === 1 ? 'failed' : 'done'); } });
    const work = tools.find((t) => t.name === 'work')!;
    const brief = 'repro: bun test → 1 fail (expected 2 got 3). scope: src/a.ts. do not touch b.';
    await work.execute('t1', { goal: 'fix add()', brief });
    const firstId = Object.keys(seen[0]!.nodes)[0]!;
    expect(firstId.startsWith('d1.')).toBe(true);
    await work.execute('t2', { goal: 'fix add() again', brief: `${brief} previous attempt was red on the empty-input case.`, resume_of: firstId });
    const ids = Object.keys(seen[1]!.nodes);
    expect(ids).toEqual([firstId]);
    const goal = seen[1]!.nodes[firstId]!.goal!;
    // 证伪: adaptCard 里去掉 injectPriorResult → 下面三条红。
    expect(goal).toContain(RESUME_PRIOR_HEAD);
    expect(goal).toContain('status: failed');
    expect(goal).toContain('expected 2 got 3');
    expect(goal).toContain('files: src/a.ts');
  });

  test('resume_of 指向没跑过的 id ⇒ 不回灌 (fresh 派发), 照常执行', async () => {
    const seen: ConductorPlan[] = [];
    const tools = createConductorRuntimeTools({ ctx: CTX, runChild: async (p) => { seen.push(p); return exec(p, 'done'); } });
    const work = tools.find((t) => t.name === 'work')!;
    await work.execute('t1', { goal: 'fix', brief: 'repro output here; scope src/a.ts; do not touch anything else.', resume_of: 'd9.ghost' });
    expect(Object.keys(seen[0]!.nodes)).toEqual(['d9.ghost']);
    expect(seen[0]!.nodes['d9.ghost']!.goal).not.toContain(RESUME_PRIOR_HEAD);
  });
});

describe('D-14 基建守卫 (2026-09-03, code80-p3 首批停批根因)', () => {
  test('★ conductor 首发 infra-error + 终审判红 ⇒ 不回灌 (只跑 1 次), 终态 infra-error 而不是 verifier-rejected', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-infra-'));
    const seen: ConductorPlan[] = [];
    const r = await runGoal('修 add()', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier } as ExecutorDagConfig,
      _classify: classify(EXEC_ACCEPT),
      _runDag: fakeEngine([{ acceptStatus: 'done', conductorFailureKind: 'infra-error' }, { acceptStatus: 'done' }], seen),
    });
    // 证伪: run-goal 去掉 conductorInfraFailure 守卫 → seen 变 2 且 outcome 落 success/verifier-rejected, 红。
    expect(seen).toHaveLength(1);
    expect(r.outcome).toBe('infra-error');
    expect(r.stages.at(-1)!.summary).toContain('529');
    expect(r.loop!.conductorInfraFailure).toContain('infra-error');
    expect(r.loop!.verifier.afterReinject).toBe('skipped');
  });

  test('判别力: conductor 语义类败因 (empty-artifact) 照常回灌', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-semantic-'));
    const seen: ConductorPlan[] = [];
    await runGoal('修 add()', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier } as ExecutorDagConfig,
      _classify: classify(EXEC_ACCEPT),
      _runDag: fakeEngine([{ acceptStatus: 'done', conductorFailureKind: 'empty-artifact' }, { acceptStatus: 'done' }], seen),
    });
    expect(seen).toHaveLength(2);
  });
});

describe('rubric 判官证据面含盘上产物 (2026-09-03)', () => {
  test('★ conductor 经 bash 写的产物文件内容进判官 prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-rubric-artifact-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd });
    writeFileSync(join(cwd, 'analysis.json'), '{"summary":"FEIGN-PROXY-EVIDENCE-7731"}');
    const prompts: string[] = [];
    await runGoal('写一份分析', {
      cwd,
      dag: {
        conductorModel: 'c:m', leafModel: 'l:m',
        generate: (async (req: { messages: { content: string }[]; traceName?: string }) => { if (req.traceName === 'judge:rubric') prompts.push(String(req.messages[0]!.content)); return { text: '{}', usage: { in: 0, out: 0 } }; }) as never,
      } as ExecutorDagConfig,
      _classify: async () => ({ tier: 'complex', acceptance: { kind: 'rubric', checklist: freezeRubric([{ id: 'r1', requirement: '点名数据来源' }]) }, route: { kind: 'none' } }),
      _runDag: fakeEngine([{}]),
    });
    // 证伪: judgeRubric 的证据只传 execLeaf.output → prompt 里没有文件内容, 红。
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('FEIGN-PROXY-EVIDENCE-7731');
    expect(prompts[0]).toContain('analysis.json');
  });
});
