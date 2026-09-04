/**
 * src/harness/goal/orchestrating-loop.test —— P3 S6b 编排循环默认路径的闸 (契约 D-1 / D-3 / D-14 / D-17 / D-20;
 * INV-3 / INV-7 / INV-8 / INV-12)。
 *
 * 反向自检 (本仓惯例, 证伪方式写在各 test 注释里): 每条闸配已知违规样本, 删掉对应机制该条当场红。
 *
 * 涵盖:
 *  · 编译形状: conductor(agent, 只读哨兵写集) → accept(command, 冻结判据原文); 无判据时 accept 缺席; 过 parsePlan (格式闸)。
 *  · 回灌: finding 只 append 到 conductor 节点 goal, 其它节点逐字不动, 返回新对象。
 *  · 派发前缀: 子图 id 与 depends_on 同步改名, 已带前缀的不重复加。
 *  · 运行期卡: zod 拒 / help → manual 走 tool result 且不派子图 (D-3); 合法 → runChild 拿到带前缀的编译产物,
 *    回 fan-in 摘要 (先机器事实后报告尾)。
 *  · conductor 面: 只读四手 + 七张卡; 常驻 prompt ≤ 8000 且不含任何 manual 首行 (INV-8)。
 *  · runGoal 接线: 缺省走循环 (plan 名 / 节点 / leafFace 只对 conductor / maxEscalations 0 / path); 显式关回 v1 (D-17);
 *    动手前 classify 恰一次 (INV-12)。
 *  · D-14: verifier 判红 → 第二次 `_runDag` 带回灌锚且**无 verifier** (INV-7 恰一次); 回灌后 oracle 绿 → success,
 *    仍红 → verifier-rejected, 无 oracle → verifier-rejected; verifier 过 → 只跑一次。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { withProtectedPaths } from '../agent-tools';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan, type ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import { CONDUCTOR_TOOL_NAMES } from '../conductor/tools/index';
import { renderManual } from '../conductor/render-manual';
import { briefHasRepro, createConductorCardLedger } from './loop-ledger';
import { CONDUCTOR_PROMPT_RESIDENT_MAX } from '../conductor/conductor-prompt';
import type { ConductorCtx } from '../conductor/types';
import type { GoalClassification } from './classify-acceptance';
import { runGoal, TERMINAL_CRITERION_VETOED, type RunGoalConfig } from './run-goal';
import {
  CONDUCTOR_HAND_TOOLS,
  CONDUCTOR_NODE_ID,
  CONDUCTOR_READONLY_SENTINEL,
  LOOP_ACCEPT_NODE_ID,
  ORCHESTRATING_LOOP_PLAN_NAME,
  REINJECT_ANCHOR_HEAD,
  RECHECK_TASK_HEAD,
  RECHECK_UNPROVEN_PREFIX,
  buildConductorFace,
  compileOrchestratingLoop,
  createConductorRuntimeTools,
  prefixPlanIds,
  withReinjectedFinding,
  checkCriterionFreeze,
  renderCriterionFreezeTruth,
} from './orchestrating-loop';

const CTX: ConductorCtx = {
  cwd: '/tmp/x',
  writeRoot: '/tmp/x',
  acceptance: { command: 'bun test src/a.test.ts', expect_exit: 0 },
  allowlist: ['bun', 'git'],
  maxFanout: 4,
  seats: { worker: 'w:1', escalation: 'e:1', verify: 'v:1' },
  researchAvailable: false,
};

const FACTS = {
  goal: 'fix the thing',
  writeRoot: '/tmp/x',
  acceptance: CTX.acceptance,
  minutesLeft: 30,
  tokensLeft: null,
  maxFanout: 4,
  researchAvailable: false,
};

/** 一个"已收敛"的假子 run 结果 (agent 节点 done + 报告)。 */
const fakeExec = (plan: ConductorPlan, overrides: Partial<ExecutorDagResult> = {}): ExecutorDagResult =>
  ({
    plan,
    sessionId: 's',
    levels: [Object.keys(plan.nodes)],
    results: Object.fromEntries(
      Object.keys(plan.nodes).map((id) => [
        id,
        { id, status: 'done', kind: 'agent', output: `report of ${id}\nline 2`, deps: plan.nodes[id]?.depends_on ?? [], usage: { in: 1, out: 1 }, filesTouched: ['src/a.ts'] },
      ]),
    ),
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 },
    reusedNodes: [],
    observations: [],
    ...overrides,
  }) as unknown as ExecutorDagResult;

describe('compileOrchestratingLoop — 形状 (D-1)', () => {
  test('conductor(agent, 只读哨兵写集) → accept(command, 判据原文, depends_on conductor); 过 parsePlan', () => {
    const plan = compileOrchestratingLoop({ goal: 'G', acceptance: CTX.acceptance, ctx: CTX });
    expect(plan.name).toBe(ORCHESTRATING_LOOP_PLAN_NAME);
    expect(Object.keys(plan.nodes)).toEqual([CONDUCTOR_NODE_ID, LOOP_ACCEPT_NODE_ID]);
    expect(plan.nodes[CONDUCTOR_NODE_ID]).toMatchObject({ executor: 'agent', goal: 'G', write_set: [CONDUCTOR_READONLY_SENTINEL] });
    expect(plan.nodes[CONDUCTOR_NODE_ID]!.model).toBeUndefined(); // 没给座 → 不钉 (落回 agent 叶静态座)
    // owner 2026-09-03: 编排节点就是 conductor, 给了座就显式钉在节点上 (TPL-3 最高优先)。证伪: 删掉 compile 里那行 spread → 红。
    expect(compileOrchestratingLoop({ goal: 'G', ctx: CTX, conductorModel: 'c:sota' }).nodes[CONDUCTOR_NODE_ID]!.model).toBe('c:sota');
    // 证伪: 把 accept 的 depends_on 去掉 → 这条红 (oracle 会与 conductor 并行跑, 判的是改前的树)。
    expect(plan.nodes[LOOP_ACCEPT_NODE_ID]).toMatchObject({ executor: 'command', command: 'bun test src/a.test.ts', expect_exit: 0, depends_on: [CONDUCTOR_NODE_ID] });
    // 格式闸: 编译产物必须过 parsePlan (D-5: parsePlan 是格式闸, 执行面只经 executePlan(applyPlanFilters))。
    expect(parsePlan(JSON.stringify(plan), { knownServers: new Set() }).ok).toBe(true);
  });

  test('无判据 → accept 缺席 (终审是唯一判官), 仍过 parsePlan', () => {
    const plan = compileOrchestratingLoop({ goal: 'explore', ctx: { ...CTX, acceptance: undefined } });
    expect(Object.keys(plan.nodes)).toEqual([CONDUCTOR_NODE_ID]);
    expect(parsePlan(JSON.stringify(plan), { knownServers: new Set() }).ok).toBe(true);
  });
});

describe('withReinjectedFinding / prefixPlanIds', () => {
  test('finding 只 append 到 conductor 的 goal, accept 逐字不动, 原 plan 不被原地改', () => {
    const plan = compileOrchestratingLoop({ goal: 'G', acceptance: CTX.acceptance, ctx: CTX });
    const before = JSON.stringify(plan);
    const next = withReinjectedFinding(plan, 'missing test for edge case');
    expect(next.nodes[CONDUCTOR_NODE_ID]!.goal).toContain(REINJECT_ANCHOR_HEAD);
    expect(next.nodes[CONDUCTOR_NODE_ID]!.goal).toContain('missing test for edge case');
    expect(next.nodes[CONDUCTOR_NODE_ID]!.goal!.startsWith('G')).toBe(true);
    expect(next.nodes[LOOP_ACCEPT_NODE_ID]).toEqual(plan.nodes[LOOP_ACCEPT_NODE_ID]);
    // 证伪: 改成原地 `conductor.goal += …` → 这条红 (与 engine.ts blameAnchor 同一条纪律)。
    expect(JSON.stringify(plan)).toBe(before);
  });

  test('前缀: id 与 depends_on 同步改名; 已带 d<n>. 前缀的 id 不重复加', () => {
    const plan = { name: 'p', nodes: { a: { executor: 'agent', goal: 'x' }, b: { executor: 'agent', goal: 'y', depends_on: ['a'] }, 'd1.c': { executor: 'agent', goal: 'z' } } } as ConductorPlan;
    const out = prefixPlanIds(plan, 'd2');
    expect(Object.keys(out.nodes)).toEqual(['d2.a', 'd2.b', 'd1.c']);
    expect(out.nodes['d2.b']!.depends_on).toEqual(['d2.a']);
  });
});

describe('createConductorRuntimeTools — 七张卡的运行期形态 (D-3)', () => {
  test('名字 = CONDUCTOR_TOOL_NAMES; zod 拒 → manual 首行在 tool result 里, runChild 零调用', async () => {
    const calls: ConductorPlan[] = [];
    const tools = createConductorRuntimeTools({ ctx: CTX, runChild: async (p) => { calls.push(p); return fakeExec(p); } });
    expect(tools.map((t) => t.name)).toEqual([...CONDUCTOR_TOOL_NAMES]);
    const work = tools.find((t) => t.name === 'work')!;
    const res = (await work.execute('t1', { goal: 'g' })) as { content: { text: string }[] };
    const text = res.content[0]!.text;
    // 证伪: 把 formatRejection 换成只返拒因 → manual 首行不在, 这条红。
    expect(text.startsWith(renderManual('work').split('\n')[0]!)).toBe(true);
    expect(text).toContain('--- rejected ---');
    expect(calls).toHaveLength(0);
  });

  test('help:true → 只返 manual, 不派子图', async () => {
    const calls: ConductorPlan[] = [];
    const tools = createConductorRuntimeTools({ ctx: CTX, runChild: async (p) => { calls.push(p); return fakeExec(p); } });
    const spawn = tools.find((t) => t.name === 'spawn')!;
    const res = (await spawn.execute('t1', { help: true })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toContain(renderManual('spawn').split('\n')[0]!);
    expect(calls).toHaveLength(0);
  });

  test('合法 work → runChild 拿到带 d1. 前缀的编译产物 (含 self_check = 冻结判据), 回 fan-in 摘要', async () => {
    const calls: { plan: ConductorPlan; seq: number }[] = [];
    const tools = createConductorRuntimeTools({ ctx: CTX, runChild: async (p, seq) => { calls.push({ plan: p, seq }); return fakeExec(p); } });
    const work = tools.find((t) => t.name === 'work')!;
    const brief = 'repro: bun test src/a.test.ts → 1 fail (expected 2 got 3). scope: src/a.ts only. do not touch src/b.ts.';
    const res = (await work.execute('t1', { goal: 'fix add()', brief })) as { content: { text: string }[]; details: { ok: boolean; seq: number } };
    // 证伪: 删掉 adaptCard 里 runChild 那一跳 → calls 空, 这条红 (卡调用不再产生嵌套 run)。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.seq).toBe(1);
    const ids = Object.keys(calls[0]!.plan.nodes);
    expect(ids).toHaveLength(1);
    expect(ids[0]!.startsWith('d1.')).toBe(true);
    expect(calls[0]!.plan.nodes[ids[0]!]).toMatchObject({ executor: 'agent', self_check: { command: 'bun test src/a.test.ts', expect_exit: 0 } });
    expect(res.details.ok).toBe(true);
    const text = res.content[0]!.text;
    expect(text).toContain('dispatch d1 (work)');
    expect(text).toContain('done 1 / failed 0 / skipped 0');
    expect(text).toContain('files: src/a.ts');
    expect(text).toContain('report of ');
    // 第二次派发序号递增 (事件面 / checkpoint 不撞)。
    await work.execute('t2', { goal: 'fix sub()', brief });
    expect(calls[1]!.seq).toBe(2);
    expect(Object.keys(calls[1]!.plan.nodes)[0]!.startsWith('d2.')).toBe(true);
  });

  test('runChild 抛错 → 原文回给 conductor, 不吞', async () => {
    const tools = createConductorRuntimeTools({ ctx: CTX, runChild: async () => { throw new Error('leafModel 必填'); } });
    const explore = tools.find((t) => t.name === 'explore')!;
    const res = (await explore.execute('t1', { questions: ['where is add()?'] })) as { content: { text: string }[]; details: { ok: boolean } };
    expect(res.details.ok).toBe(false);
    expect(res.content[0]!.text).toContain('leafModel 必填');
  });
});

describe('buildConductorFace — INV-8 / D-20', () => {
  test('只读四手 + 七张卡; 常驻 prompt ≤ 8000 且不含任何 manual 首行', () => {
    const face = buildConductorFace(FACTS, { ctx: CTX, runChild: async (p) => fakeExec(p) });
    expect([...face.toolNames]).toEqual([...CONDUCTOR_HAND_TOOLS]);
    expect(face.toolNames).not.toContain('write');
    expect(face.toolNames).not.toContain('edit');
    expect(face.customTools!.map((t) => t.name)).toEqual([...CONDUCTOR_TOOL_NAMES]);
    expect(face.systemPrompt.length).toBeLessThanOrEqual(CONDUCTOR_PROMPT_RESIDENT_MAX);
    // 证伪: 把任一 manual 拼进 buildConductorSystemPrompt → 这条红 (D-3: manual 只走 tool result)。
    for (const name of CONDUCTOR_TOOL_NAMES) expect(face.systemPrompt).not.toContain(renderManual(name).split('\n')[0]!);
    expect(face.systemPrompt).toContain('bun test src/a.test.ts');
  });
});

// ── runGoal 接线 ────────────────────────────────────────────────────────────────

interface Observed {
  plan: ConductorPlan;
  cfg: ExecutorDagConfig;
}

/**
 * 假引擎: 记下 plan + cfg; conductor 节点 done; accept 按 opts 绿/红; 有 verifier 且 accept 绿时**调一次 verifier**
 * (模拟引擎的闸红短路: oracle 红时不请强模型)。
 */
const fakeEngine = (
  seen: Observed[],
  opts: { acceptRed?: (call: number) => boolean } = {},
): NonNullable<RunGoalConfig['_runDag']> => {
  return async (plan, cfg) => {
    const call = seen.length + 1;
    seen.push({ plan, cfg });
    const red = opts.acceptRed?.(call) ?? false;
    const results: ExecutorDagResult['results'] = {};
    for (const id of Object.keys(plan.nodes)) {
      const n = plan.nodes[id]!;
      results[id] =
        n.executor === 'command'
          ? ({ id, status: red ? 'failed' : 'done', kind: 'command', output: red ? '1 fail' : '0 fail', deps: n.depends_on ?? [], usage: { in: 0, out: 0 }, exitCode: red ? 1 : 0 } as never)
          : ({ id, status: 'done', kind: 'agent', output: 'conductor report', deps: n.depends_on ?? [], usage: { in: 1, out: 1 } } as never);
    }
    let verification: ExecutorDagResult['verification'];
    if (cfg.verifier && !red) {
      const v = await cfg.verifier({ task: 't', plan, results });
      verification = { pass: v.pass, reason: v.reason, attempts: 1, escalated: false, conductorModel: 'c:m' };
    }
    return { plan, sessionId: 's', levels: [], results, usage: { conductor: { in: 0, out: 0 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 }, reusedNodes: [], observations: [], ...(verification ? { verification } : {}) } as unknown as ExecutorDagResult;
  };
};

const classify = (calls: { n: number }, acceptance: GoalClassification['acceptance']) => async (): Promise<GoalClassification> => {
  calls.n++;
  return { tier: 'complex', acceptance, route: { kind: 'none' } };
};

const EXEC_ACCEPT: GoalClassification['acceptance'] = { kind: 'executable', command: 'bun test src/a.test.ts', expectExit: 0 };
const EXPLORE_ACCEPT = { kind: 'exploratory', learningGoal: 'learn', acceptableLoss: 'none' } as unknown as GoalClassification['acceptance'];

const baseCfg = (cwd: string, extra: Partial<RunGoalConfig> = {}): RunGoalConfig =>
  ({
    cwd,
    dag: { conductorModel: 'c:m', leafModel: 'l:m', maxFanout: 3 } as ExecutorDagConfig,
    ...extra,
  }) as RunGoalConfig;

describe('runGoal — 编排循环是 solve 唯一的非 SDD 路径 (D-17; v1 已退役 2026-09-03)', () => {
  test('★ 缺省: plan 名 / 节点 / leafFace 只对 conductor / maxEscalations 0 / path; classify 恰 1 次 (INV-12)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-default-'));
    const seen: Observed[] = [];
    const calls = { n: 0 };
    const r = await runGoal('修 add()', baseCfg(cwd, { _classify: classify(calls, EXEC_ACCEPT), _runDag: fakeEngine(seen) }));
    expect(seen).toHaveLength(1);
    const { plan, cfg } = seen[0]!;
    expect(plan.name).toBe(ORCHESTRATING_LOOP_PLAN_NAME);
    expect(Object.keys(plan.nodes)).toEqual([CONDUCTOR_NODE_ID, LOOP_ACCEPT_NODE_ID]);
    expect(plan.nodes[CONDUCTOR_NODE_ID]!.goal).toContain('## 判卷标准');
    expect(plan.nodes[CONDUCTOR_NODE_ID]!.model).toBe('c:m'); // 编排节点坐 conductor 座 (baseCfg 的 conductorModel), 不是 leafModel 'l:m'
    // 证伪: 把 withLoopConfig 里 leafFace 的 id 判断去掉 → 'other' 也拿到面, 第二条红。
    expect(cfg.leafFace?.({ id: CONDUCTOR_NODE_ID, executor: 'agent' })).toBeDefined();
    expect(cfg.leafFace?.({ id: 'other', executor: 'agent' })).toBeUndefined();
    expect(cfg.leafFace!({ id: CONDUCTOR_NODE_ID })!.customTools!.map((t) => t.name)).toEqual([...CONDUCTOR_TOOL_NAMES]);
    expect(cfg.maxEscalations).toBe(0);
    expect(calls.n).toBe(1);
    expect(r.path).toBe('orchestrating-loop');
    expect(r.outcome).toBe('success');
    expect(r.stages.find((s) => s.stage === 'execute')!.summary).toContain('编排循环');
  });

  test('子图经同一个 _runDag 注入口跑 (D-5 唯一执行入口), 子 run 无 verifier / 无 leafFace / runId 派生', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-child-'));
    const seen: Observed[] = [];
    const verifier = async () => ({ pass: true, reason: '', usage: { in: 0, out: 0 } });
    const manager = {} as never;
    await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier, continuity: { manager, runId: 'R1', resume: true, repoRoot: cwd } } as ExecutorDagConfig,
    });
    const face = seen[0]!.cfg.leafFace!({ id: CONDUCTOR_NODE_ID })!;
    const work = face.customTools!.find((t) => t.name === 'work')!;
    await work.execute('t', { goal: 'g', brief: 'repro output: 1 fail in src/a.test.ts; scope src/a.ts; do not touch b.' });
    // 证伪: runChild 改成直接 import runExecutorDagWithPlan 而不走 config._runDag → seen 仍 1, 这条红。
    expect(seen).toHaveLength(2);
    const child = seen[1]!;
    expect(child.plan.name.startsWith('conductor-work-')).toBe(true);
    expect(child.cfg.verifier).toBeUndefined();
    expect(child.cfg.leafFace).toBeUndefined();
    expect(child.cfg.maxEscalations).toBeUndefined();
    expect(child.cfg.continuity).toMatchObject({ runId: 'R1:d1', resume: false, repoRoot: cwd });
  });
});

describe('D-14 — 全量终审 1 次 + 回灌 1 次 + 窄复审 1 次 (INV-7 ≤ 2)', () => {
  const failingVerifier = (calls: { n: number }) => async () => {
    calls.n++;
    return { pass: false, reason: 'edge case for empty input not covered', usage: { in: 1, out: 1 } };
  };

  /**
   * 首判红、窄复审绿的判官 —— 这是 D-14 的**正常修复路径**: 终审挑出问题, 回灌后 conductor 修好,
   * 第二只眼确认修好了。靠卷面首行 (`RECHECK_TASK_HEAD`) 认第几发, 不靠调用计数猜。
   */
  const failThenPass = (calls: { n: number; recheckTask?: string }) => async (req: { task: string }) => {
    calls.n++;
    if (req.task.startsWith(RECHECK_TASK_HEAD)) {
      calls.recheckTask = req.task;
      return { pass: true, reason: 'the uncovered empty-input branch now has a test and it fails without the fix', usage: { in: 1, out: 1 } };
    }
    return { pass: false, reason: 'edge case for empty input not covered', usage: { in: 1, out: 1 } };
  };

  test('★ 判红 → 第二次 _runDag: conductor goal 带回灌锚 + finding, cfg **无 verifier**; 回灌后 oracle 绿 → 窄复审绿 → success', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-reinject-green-'));
    const seen: Observed[] = [];
    const vcalls: { n: number; recheckTask?: string } = { n: 0 };
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failThenPass(vcalls) } as ExecutorDagConfig,
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.plan.nodes[CONDUCTOR_NODE_ID]!.goal).toContain(REINJECT_ANCHOR_HEAD);
    expect(seen[1]!.plan.nodes[CONDUCTOR_NODE_ID]!.goal).toContain('edge case for empty input not covered');
    // 证伪: 回灌那次不剥 verifier → fakeEngine 也会调一次, vcalls 变 3, 下面那条红。
    expect(seen[1]!.cfg.verifier).toBeUndefined();
    // 全量终审 1 + 窄复审 1 = 2 (2026-09-04 前是 1: 那时回灌后无人复审)。
    expect(vcalls.n).toBe(2);
    expect(r.outcome).toBe('success');
    expect(r.verifierDissent).toContain('edge case');
    expect(r.recheckDissent).toContain('now has a test');
    expect(r.loop!.verifier.recheck).toBe('pass');
    expect(r.stages.find((s) => s.stage === 'execute')!.summary).toContain('finding 回灌 1 次');
  });

  test('★ 窄复审的卷面是**窄**的: 首行是 RECHECK_TASK_HEAD, 带首判 finding 原文 + 原任务, 并明写不许开新战线', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-recheck-paper-'));
    const vcalls: { n: number; recheckTask?: string } = { n: 0 };
    await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine([]) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failThenPass(vcalls) } as ExecutorDagConfig,
    });
    const paper = vcalls.recheckTask!;
    expect(paper.startsWith(RECHECK_TASK_HEAD)).toBe(true);
    expect(paper).toContain('edge case for empty input not covered'); // 首判 finding 原文
    expect(paper).toContain('修 add()'); // 原任务作为上下文
    // 证伪: 把 renderRecheckTask 的这条纪律删掉 → 复审会开新战线, 这条红。
    expect(paper).toContain('Do NOT open new lines of attack');
    // 「拿不准判 fail」那句已于 2026-09-04 撤下 (code80-p5 实测它是 3/8 假阳性的根因),
    // 反证要求与 UNPROVEN 出口的断言搬到下面那条专门的卷面用例。
  });

  test('★ 回灌后 oracle 绿但窄复审判「仍没修」→ verifier-rejected (机械 oracle 绿不算数)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-recheck-fail-'));
    const vcalls = { n: 0 };
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine([]) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier(vcalls) } as ExecutorDagConfig,
    });
    // 这是本次改动买到的那一格: 2026-09-04 之前 oracle 绿即 success, 语义层没有第二只眼。
    // 证伪: 把 verifierRejected 里的 `|| recheck === 'fail'` 去掉 → outcome 变回 success, 这条红。
    expect(r.outcome).toBe('verifier-rejected');
    expect(r.converged).toBe(false);
    expect(r.loop!.verifier.recheck).toBe('fail');
    expect(vcalls.n).toBe(2);
    expect(r.terminalLabel).toBe('verifier-rejected'); // 终态词不新开一格 (成因写在 summary 里)
    expect(r.stages.find((st) => st.stage === 'execute')!.summary).toContain('窄复审判首判 finding 仍没修');
  });

  test('★ 拿不出反证 (reason 以 UNPROVEN: 起头) → 放行 success, 但读数记 unproven 而不是 pass', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-recheck-unproven-'));
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine([]) }),
      dag: {
        conductorModel: 'c:m', leafModel: 'l:m',
        verifier: async (req: { task: string }) =>
          req.task.startsWith(RECHECK_TASK_HEAD)
            ? { pass: true, reason: 'UNPROVEN: 四条要修项里没有一条能从卷面证据确认, 也拿不出反证', usage: { in: 1, out: 1 } }
            : { pass: false, reason: 'edge case for empty input not covered', usage: { in: 1, out: 1 } },
      } as ExecutorDagConfig,
    });
    // code80-p5 的 3/8 假阳性正是这一型 (最扎的一条 bench 测试 4/4 全过却被判 fail): oracle 绿是
    // prior, 拿不出反证就不该推翻它。证伪: 去掉 run-goal 里 unproven 的判定 → recheck 变 'pass', 下面第二条红。
    expect(r.outcome).toBe('success');
    expect(r.loop!.verifier.recheck).toBe('unproven');
    expect(r.recheckDissent).toContain('UNPROVEN:');
  });

  test('UNPROVEN 前缀前有空白仍算 unproven (否则这一格会被降级成 pass, 读数虚高)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-recheck-unproven-ws-'));
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine([]) }),
      dag: {
        conductorModel: 'c:m', leafModel: 'l:m',
        verifier: async (req: { task: string }) =>
          req.task.startsWith(RECHECK_TASK_HEAD)
            ? { pass: true, reason: '\n  UNPROVEN: 看不出来', usage: { in: 1, out: 1 } }
            : { pass: false, reason: 'edge case for empty input not covered', usage: { in: 1, out: 1 } },
      } as ExecutorDagConfig,
    });
    // 证伪: 把 trimStart() 去掉 → 变 'pass', 这条红。
    expect(r.loop!.verifier.recheck).toBe('unproven');
  });

  test('窄复审卷面要反证不要正证: 明写 counter-evidence / UNPROVEN 出口, 不再有 Uncertain = fail', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-recheck-paper2-'));
    const vcalls: { n: number; recheckTask?: string } = { n: 0 };
    await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine([]) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failThenPass(vcalls) } as ExecutorDagConfig,
    });
    const paper = vcalls.recheckTask!;
    expect(paper).toContain('concrete counter-evidence');
    expect(paper).toContain(RECHECK_UNPROVEN_PREFIX);
    // 证伪 (回归钉): 初版那句把「看不到」与「看到没修」并成 fail, 是 3/8 假阳性的根因, 不许回来。
    expect(paper).not.toContain('Uncertain = fail');
  });

  test('窄复审调不通 (判卷官抛错) → fail-open 按 oracle 念 success, recheck 记 error (与 skipped 分开)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-recheck-error-'));
    const vcalls = { n: 0 };
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine([]) }),
      dag: {
        conductorModel: 'c:m', leafModel: 'l:m',
        verifier: async (req: { task: string }) => {
          vcalls.n++;
          if (req.task.startsWith(RECHECK_TASK_HEAD)) throw new Error('judge provider 503');
          return { pass: false, reason: 'edge case for empty input not covered', usage: { in: 1, out: 1 } };
        },
      } as ExecutorDagConfig,
    });
    // 判卷官故障不许改终态 (与 tapVerifier 那条「verifier-error 不触发回灌」同向)。
    expect(r.outcome).toBe('success');
    expect(r.loop!.verifier.recheck).toBe('error');
    // 证伪: 把 catch 里的 'error' 写成 'skipped' → 「判官坏了」与「没跑复审」并成一格, 这条红。
    expect(r.recheckDissent).toBeUndefined();
  });

  test('回灌后 oracle 仍红 → 不跑窄复审 (那时终态本就是 verifier-rejected, 再调一次买不到新信息)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-recheck-skip-red-'));
    const vcalls = { n: 0 };
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine([], { acceptRed: (call) => call === 2 }) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier(vcalls) } as ExecutorDagConfig,
    });
    expect(r.outcome).toBe('verifier-rejected');
    // 证伪: 把触发条件里的 `recheckOracleWouldPass` 去掉 → vcalls 变 2, recheck 变 'fail', 这两条红。
    expect(vcalls.n).toBe(1);
    expect(r.loop!.verifier.recheck).toBe('skipped');
  });

  test('回灌后 oracle 仍红 → verifier-rejected (不是 oracle-failed / not-converged)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-reinject-red-'));
    const seen: Observed[] = [];
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen, { acceptRed: (call) => call === 2 }) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier({ n: 0 }) } as ExecutorDagConfig,
    });
    expect(seen).toHaveLength(2);
    expect(r.outcome).toBe('verifier-rejected');
    expect(r.converged).toBe(false);
    expect(r.terminalLabel).toBe('verifier-rejected');
  });

  test('无机械判据 (探索型) + 判红 → 回灌一次, 终态 verifier-rejected (终审是唯一判官, 不复审就不许说成)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-reinject-noacc-'));
    const seen: Observed[] = [];
    const vcalls = { n: 0 };
    const r = await runGoal('研究一下 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXPLORE_ACCEPT), _runDag: fakeEngine(seen) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier(vcalls) } as ExecutorDagConfig,
    });
    expect(Object.keys(seen[0]!.plan.nodes)).toEqual([CONDUCTOR_NODE_ID]);
    expect(seen).toHaveLength(2);
    expect(vcalls.n).toBe(1);
    expect(r.outcome).toBe('verifier-rejected');
  });

  test('verifier 过 → 只跑一次, 不回灌', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-verifier-pass-'));
    const seen: Observed[] = [];
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: async () => ({ pass: true, reason: 'ok', usage: { in: 0, out: 0 } }) } as ExecutorDagConfig,
    });
    expect(seen).toHaveLength(1);
    expect(r.outcome).toBe('success');
  });

  test('oracle 红 (闸红短路, verifier 没被调) → 不回灌, 终态走判据分支', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-oracle-red-'));
    const seen: Observed[] = [];
    const vcalls = { n: 0 };
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen, { acceptRed: () => true }) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier(vcalls) } as ExecutorDagConfig,
    });
    expect(seen).toHaveLength(1);
    expect(vcalls.n).toBe(0);
    expect(r.outcome).toBe('not-converged');
    expect(r.criteria?.oracle).toBe(false);
  });
});

describe('R-1 账本: 卡调用计数 / 派发台账 / 常驻字符数 / briefHasRepro', () => {
  test('★ zod 拒 + help + ok 各计一次; dispatches 带 briefHasRepro; residentPromptChars 由 buildConductorFace 写', async () => {
    const ledger = createConductorCardLedger();
    const face = buildConductorFace(FACTS, { ctx: CTX, runChild: async (p) => fakeExec(p), ledger });
    expect(ledger.residentPromptChars).toBe(face.systemPrompt.length);
    const work = face.customTools!.find((t) => t.name === 'work')!;
    await work.execute('t', { goal: 'g' }); // zod 拒 (brief 缺)
    await work.execute('t', { help: true });
    await work.execute('t', { goal: 'fix add()', brief: 'repro: pytest -q tests/x.py → 1 failed, exit 1. scope src/a.ts; do not touch b.' });
    await work.execute('t', { goal: 'polish docs', brief: 'please tidy the README wording and keep the headings as they are, nothing else.' });
    // 证伪: adaptCard 不计数 → calls 0, 红。
    expect(ledger.calls).toBe(4);
    expect(ledger.ok).toBe(2);
    expect(ledger.rejectedSchema).toBe(1);
    expect(ledger.help).toBe(1);
    expect(ledger.byCard).toEqual({ work: 2 });
    expect(ledger.dispatches.map((d) => d.briefHasRepro)).toEqual([true, false]);
    expect(ledger.dispatches[0]!.failed).toBe(0);
    const explore = face.customTools!.find((t) => t.name === 'explore')!;
    await explore.execute('t', { questions: ['where?'] });
    expect(ledger.dispatches.at(-1)!.briefHasRepro).toBeNull(); // 无 brief 槽 = null, 不是 false
    expect(ledger.readOnlyShellBlocked).toBe(0);
    face.onReadOnlyBlocked!();
    expect(ledger.readOnlyShellBlocked).toBe(1);
  });

  test('briefHasRepro 启发式矩阵', () => {
    for (const b of ['exit 1', 'Traceback (most recent call last)', '3 failed, 2 passed', 'AssertionError: x', '$ bun test\n1 fail', 'Expected: 2\nReceived: 3']) expect(briefHasRepro(b), b).toBe(true);
    for (const b of ['fix the bug in add()', 'run pytest first', '']) expect(briefHasRepro(b), b).toBe(false);
  });
});

describe('R-1 账本: runGoal 结果上的 loop', () => {
  test('★ 回灌绿的 run: verifier {calls 1, fail, reinjected, green}; v1 路径无 loop', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-ledger-'));
    const seen: Observed[] = [];
    const vcalls = { n: 0 };
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: async () => ({ tier: 'complex', acceptance: EXEC_ACCEPT, route: { kind: 'none' }, llmCalls: 1 }), _runDag: fakeEngine(seen) }),
      // 1-B 之后 target=criterion 不再回灌 (见下一组用例); 回灌路径的样本改用 target=implementation。
      // 首判红 → 回灌 → 窄复审绿 (D-14 的正常修复路径; 靠卷面首行认第几发)。
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: async (req: { task: string }) => {
        vcalls.n++;
        if (req.task.startsWith(RECHECK_TASK_HEAD)) return { pass: true, reason: 'sum is correct now', target: 'implementation' as const, usage: { in: 0, out: 0 } };
        return { pass: false, reason: 'add() still returns wrong sum', target: 'implementation' as const, usage: { in: 0, out: 0 } };
      } } as ExecutorDagConfig,
    });
    expect(r.loop).toMatchObject({
      path: 'orchestrating-loop',
      route: { kind: 'none', chainHit: false },
      preActionLlmCalls: 1,
      // calls 2 = 全量终审 1 + 窄复审 1 (INV-7 判词 ≤ 2)。firstVerdict 仍是**首判**, 不被复审覆盖。
      verifier: { calls: 2, firstVerdict: 'fail', target: 'implementation', reinjected: true, afterReinject: 'green', recheck: 'pass' },
    });
    expect(r.loop!.residentPromptChars).toBeGreaterThan(1000);
    expect(r.loop!.cards.calls).toBe(0);
    // R-1 第 4 步: 回灌分界线 —— 第二跑开始时派发数 (这里 conductor 一次没派 → 0, **是 0 不是缺席**); 读侧靠它判「回灌后有没有新派发」。
    expect(r.loop!.dispatchesBeforeReinject).toBe(0);
  });

  test('没回灌 (verifier 过) ⇒ afterReinject skipped, firstVerdict pass; 注入式分类器无 llmCalls ⇒ null', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-ledger2-'));
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine([]) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: async () => ({ pass: true, reason: 'ok', usage: { in: 0, out: 0 } }) } as ExecutorDagConfig,
    });
    expect(r.loop!.verifier).toEqual({ calls: 1, firstVerdict: 'pass', target: null, reinjected: false, afterReinject: 'skipped', recheck: 'skipped' });
    expect(r.loop!.preActionLlmCalls).toBeNull();
    expect(r.loop!.dispatchesBeforeReinject).toBeUndefined(); // 没回灌 = 没有分界线 (缺席, 不是 0)
  });
});

describe('1-B (2026-09-03): 终审否决判据 (target=criterion) → 不回灌 conductor, 走 INV-4 判据重建', () => {
  test('★ 只跑一次; outcome verifier-rejected; loop.verifier {fail, criterion, reinjected false, skipped}; criterionRebuild 触发 (重建者缺席 → 未采纳, 照记); 摘要含 1-B', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-1b-'));
    const seen: Observed[] = [];
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: async () => ({ pass: false, reason: '冻结判据指向实施前不存在的测试文件', target: 'criterion' as const, usage: { in: 0, out: 0 } }) } as ExecutorDagConfig,
    });
    expect(seen).toHaveLength(1); // 证伪: 去掉 D-14 条件里的 `!criterionVeto` → 2 (回灌了), 红
    expect(r.outcome).toBe('verifier-rejected');
    expect(r.loop!.verifier).toEqual({ calls: 1, firstVerdict: 'fail', target: 'criterion', reinjected: false, afterReinject: 'skipped', recheck: 'skipped' });
    expect(r.loop!.dispatchesBeforeReinject).toBeUndefined();
    expect(r.criterionRebuild).toBeDefined();
    expect(r.criterionRebuild!.admitted).toBe(false);
    expect(r.criterionRebuild!.trigger).toContain('target=criterion');
    expect(r.stages.some((s) => s.summary.includes('1-B'))).toBe(true);
    // 2026-09-04 (code80-p5 读数): 「判据坏」与「实装没修好」共用 verifier-rejected 这个字面, 把
    // 3 题 bench 测试 12/12 · 12/12 · 13/13 全过的活念成了失败 —— 两格的下一步相反 (判据重建 vs
    // 重跑实装)。outcome 仍不新开一格 (被否决的判据上 oracle 绿仍不算交付证据), 只有字面分开。
    // 证伪: 把 terminalLabel 里的 `criterionVeto ?` 那一支去掉 → 退回 'verifier-rejected', 这条红。
    expect(r.terminalLabel).toBe(TERMINAL_CRITERION_VETOED);
    expect(r.outcome).toBe('verifier-rejected');
  });
});

describe('1-A (2026-09-03): 判据先落盘冻结', () => {
  test('★ runGoal 接线: 判据引用的文件在 cwd 下不存在 → 判据行尾有 "Missing now: src/a.test.ts"; 文件已存在 → 无', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-1a-wire-'));
    const seen: Observed[] = [];
    await runGoal('修 add()', baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen) }));
    expect(seen[0]!.cfg.leafFace!({ id: CONDUCTOR_NODE_ID })!.systemPrompt!).toContain('Missing now: src/a.test.ts');
    const cwd2 = mkdtempSync(join(tmpdir(), 'omd-1a-wire2-'));
    mkdirSync(join(cwd2, 'src'), { recursive: true });
    writeFileSync(join(cwd2, 'src/a.test.ts'), 'test');
    const seen2: Observed[] = [];
    await runGoal('修 add()', baseCfg(cwd2, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen2) }));
    expect(seen2[0]!.cfg.leafFace!({ id: CONDUCTOR_NODE_ID })!.systemPrompt!).not.toContain('Missing now:');
  });

  test('★ 工具面: 冻住前非 work 拒 (计 rejectedCompile); 第一张 work 写集被强制为判据文件; 回来记 hash; 之后派发在路径禁令里跑; 改动后 tampered 可见', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-1a-face-'));
    const ledger = createConductorCardLedger();
    const guarded: (readonly string[])[] = [];
    const plans: ConductorPlan[] = [];
    const ctx = { ...CTX, cwd: root, writeRoot: root, acceptance: { command: 'bun test tests/a.test.ts', expect_exit: 0 } };
    const face = buildConductorFace(
      { ...FACTS, writeRoot: root, criterionFiles: ['tests/a.test.ts'] },
      {
        ctx,
        ledger,
        criterionFreeze: { files: ['tests/a.test.ts'], root },
        withProtected: ((paths, fn) => { guarded.push(paths ?? []); return fn(); }) as typeof withProtectedPaths,
        runChild: async (p) => {
          plans.push(p);
          // 模拟 worker: 第一张 work 真把判据文件写出来。
          if (!existsSync(join(root, 'tests/a.test.ts'))) {
            mkdirSync(join(root, 'tests'), { recursive: true });
            writeFileSync(join(root, 'tests/a.test.ts'), 'expect(1).toBe(1)');
          }
          return fakeExec(p);
        },
      },
    );
    const work = face.customTools!.find((t) => t.name === 'work')!;
    const explore = face.customTools!.find((t) => t.name === 'explore')!;
    // 冻住前派 explore → 拒, 文案指明先派 work 写判据文件。
    const rej = await explore.execute('t', { questions: ['where?'] });
    expect((rej as { content: { text: string }[] }).content[0]!.text).toContain('[1-A 判据先落盘]');
    expect(ledger.rejectedCompile).toBe(1);
    expect(plans).toHaveLength(0);
    // 第一张 work 带了别的写集 → 被强制成判据文件。
    const ok1 = await work.execute('t', { goal: 'write the acceptance test', brief: 'repro: none yet; create tests/a.test.ts covering add(); do not touch src.', write_set: ['src/add.ts'] });
    expect(Object.values(plans[0]!.nodes)[0]!.write_set).toEqual(['tests/a.test.ts']); // 证伪: 去掉强制 → ['src/add.ts'], 红
    expect(guarded).toHaveLength(0); // 第一张不在禁令里跑 (它就是来写这些文件的)
    expect(ledger.criterionFreeze!.frozenAtDispatch).toBe(1);
    expect(ledger.criterionFreeze!.hashes!['tests/a.test.ts']).toMatch(/^[0-9a-f]{16}$/);
    expect((ok1 as { content: { text: string }[] }).content[0]!.text).toContain('[1-A 判据文件已冻结');
    // 第二张 work: 写集不再被改, 但子 run 在路径禁令里跑。
    await work.execute('t', { goal: 'implement add', brief: 'repro: bun test tests/a.test.ts → 1 fail exit 1. scope src/add.ts only.', write_set: ['src/add.ts'] });
    expect(Object.values(plans[1]!.nodes)[0]!.write_set).toEqual(['src/add.ts']);
    expect(guarded).toEqual([['tests/a.test.ts']]); // 证伪: 不包 withProtected → [], 红
    // 判卷真值: 未变 → "未变"; 有人绕过闸改了 → tampered + "已变"。
    expect(renderCriterionFreezeTruth(ledger.criterionFreeze!, root)).toContain('判卷时未变');
    expect(checkCriterionFreeze(ledger.criterionFreeze!, root)).toEqual([]);
    writeFileSync(join(root, 'tests/a.test.ts'), 'expect(1).toBe(2)');
    expect(checkCriterionFreeze(ledger.criterionFreeze!, root)).toEqual(['tests/a.test.ts']);
    expect(renderCriterionFreezeTruth(ledger.criterionFreeze!, root)).toContain('判卷时已变');
  });

  test('第一张 work 回来文件仍不存在 → 没冻住 (hashes 缺席), 下一次派发继续强制; 回灌第二跑从 ledger 恢复保护', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-1a-miss-'));
    const ledger = createConductorCardLedger();
    const plans: ConductorPlan[] = [];
    const ctx = { ...CTX, cwd: root, writeRoot: root };
    const face = buildConductorFace({ ...FACTS, writeRoot: root, criterionFiles: ['tests/a.test.ts'] }, { ctx, ledger, criterionFreeze: { files: ['tests/a.test.ts'], root }, runChild: async (p) => { plans.push(p); return fakeExec(p); } });
    const work = face.customTools!.find((t) => t.name === 'work')!;
    const r1 = await work.execute('t', { goal: 'g', brief: 'b'.repeat(40) });
    expect((r1 as { content: { text: string }[] }).content[0]!.text).toContain('一个都没写出来');
    expect(ledger.criterionFreeze).toEqual({ files: ['tests/a.test.ts'] }); // 没冻住 = frozenAtDispatch / hashes 缺席, 不编
    await work.execute('t', { goal: 'g2', brief: 'c'.repeat(40), write_set: ['src/x.ts'] });
    expect(Object.values(plans[1]!.nodes)[0]!.write_set).toEqual(['tests/a.test.ts']); // 第二次仍强制
    // 回灌第二跑: 新工具面, deps 不带 criterionFreeze, 只靠 ledger 里已有 hashes 恢复。
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests/a.test.ts'), 'x');
    ledger.criterionFreeze = { files: ['tests/a.test.ts'], frozenAtDispatch: 2, hashes: { 'tests/a.test.ts': 'abc' } };
    const guarded: (readonly string[])[] = [];
    const face2 = buildConductorFace({ ...FACTS, writeRoot: root }, { ctx, ledger, withProtected: ((paths, fn) => { guarded.push(paths ?? []); return fn(); }) as typeof withProtectedPaths, runChild: async (p) => fakeExec(p) });
    await face2.customTools!.find((t) => t.name === 'work')!.execute('t', { goal: 'g3', brief: 'd'.repeat(40) });
    expect(guarded).toEqual([['tests/a.test.ts']]);
  });
});
