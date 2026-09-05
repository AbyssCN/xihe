/**
 * runGoal 契约测试 — INV-GOAL-1 (全自主) / INV-GOAL-4 (无环 + 有界)。
 * 全注入 (_classify / _runDag / researchRunner / agentRunner) — 零 live 模型、零真检索。
 *
 * **两段都是图**: 契约段 `goal-contract` 与执行段 `goal-orchestrating-loop` (P3 编排循环, v1 规划式
 * conductor 已于 2026-09-03 退役) 共用 `_runDag` 注入口, 靠 `plan.name` 分辨 —— 所以这里的注入器是个路由器。
 *
 * 循环路径的裁决位 (run-goal.ts `loopOk`): 有可执行判据 ⇒ 停止规则唯一 = 环外 `accept` 节点 (冻结判据);
 * 无判据 (探索型 / rubric) ⇒ `conductor` 节点跑完 (status done)。没有内环 judge, 没有 rounds。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_TERMINAL_OUTCOME, boardTerminalEntry, goalSlug, runGoal, type RunGoalConfig } from './run-goal';
import { TERMINAL_ZERO_WRITE } from './zero-write-gate';
import type { AcceptanceSpec, GoalClassification, GoalTier } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import { SDD_DECLARED_WRITE_SET, SDD_REPORT_FILE, type DeclaredWriteSet } from '../writeset/write-set';
import { appendBoard, BOARD_RUN_ID, liveRuns, readBoard, type BoardEntry } from '../board/run-board';
import { publishEntry } from '../../../scripts/board-publish';
import type { RunOutcomeKind } from '../run-outcome';
import { ignitionPreflight } from './ignition-preflight';
import { fingerprintOf } from '../profiles/review-ledger';

/**
 * D-I: 分类器一次出两条轴 (成本轴 tier + 判据轴 acceptance)。本文件多数用例只关心成本轴,
 * 判据轴给一个固定的执行型即可 —— 判据轴自己的行为在 `acceptance.test.ts` 里测。
 */
const ACC_EXEC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const cls =
  (tier: GoalTier, acceptance: AcceptanceSpec = ACC_EXEC) =>
  async (): Promise<GoalClassification> => ({ tier, acceptance });

/**
 * 造一份「契约段 conductor 节点」的执行结果 (D-G′ 之后 survey/research/spec 都在它的子图里)。
 * 子节点 id 前缀 `contract::` 是 D-B 内容寻址的形状; runGoal 靠 kind 认出各段。
 */
function contractDag(opts: { survey?: string; sources?: string[]; specFile?: string; specText?: string }): ExecutorDagResult {
  const results: Record<string, unknown> = {};
  if (opts.survey !== undefined) {
    results['contract::survey'] = { id: 'contract::survey', status: 'done', kind: 'agent', output: opts.survey, deps: [], usage: { in: 1, out: 1 }, filesTouched: [] };
  }
  if (opts.sources) {
    results['contract::research'] = { id: 'contract::research', status: 'done', kind: 'research', output: '研究终稿', deps: [], usage: { in: 1, out: 1 }, sources: opts.sources };
  }
  results['contract'] = {
    id: 'contract', status: 'done', kind: 'conductor',
    output: opts.specText ?? '# SDD\n...', deps: [], usage: { in: 1, out: 1 },
    ...(opts.specFile ? { filesTouched: [opts.specFile] } : {}),
  };
  return { plan: { name: 'goal-contract', nodes: {} }, results } as unknown as ExecutorDagResult;
}

/**
 * 造一份「编排循环」的执行结果: `conductor` (agent 叶) + 环外 `accept` (冻结判据)。
 * 有可执行判据时 runGoal 的整段结论只取自 `accept` 的状态; `conductor` 的 status 只影响
 * 「图内有没有红节点」(delivered-with-red) 与无判据分型的环结论。
 */
function executeDag(
  opts: {
    reused?: string[];
    status?: 'done' | 'failed';
    /**
     * D-I 环外闸 (2026-07-30): 执行型验收会在图上多一个 `accept` command 节点, 它的退出码是
     * **冻结判据**。缺省 done; 'failed' = 冻结判据没过 (循环路径上这就是 not-converged 的唯一来源);
     * 'absent' = 引擎没跑到它 (取消 / 级联压死), 没被证明过就不算成。
     */
    accept?: 'done' | 'failed' | 'absent';
    /** accept 节点的输出正文 —— S-37 那条闸的判据面(`(fail)` 名字集从这里抽)。 */
    acceptOutput?: string;
    /**
     * S4 终态 emit 的注入面: N5 outcome 阶梯 (run-goal.ts) 的各停止轴都能经 conductor 节点 /
     * dag 结果注入 —— 测"每个可达终态都真 append 过 terminal", 不靠投影表冒充端到端。
     */
    cancelled?: string;
    blocked?: string;
    budgetStopped?: string;
    infraStopped?: string;
  } = {},
): ExecutorDagResult {
  const accept = opts.accept ?? 'done';
  return {
    plan: { name: 'goal-orchestrating-loop', nodes: {} },
    results: {
      ...(accept === 'absent'
        ? {}
        : {
            accept: {
              id: 'accept', status: accept, kind: 'command', output: opts.acceptOutput ?? (accept === 'done' ? '' : '[exit 1]'),
              deps: ['conductor'], usage: { in: 0, out: 0 }, timedOut: false, signal: null,
            },
          }),
      conductor: {
        id: 'conductor',
        status: opts.status ?? 'done',
        kind: 'agent',
        output: '[conductor 派工 2 次, 均成功]',
        deps: [],
        usage: { in: 1, out: 1 },
        filesTouched: [],
        ...(opts.blocked === undefined ? {} : { blocked: opts.blocked }),
        ...(opts.budgetStopped === undefined ? {} : { budgetStopped: opts.budgetStopped }),
        ...(opts.infraStopped === undefined ? {} : { infraStopped: opts.infraStopped }),
      },
    },
    reusedNodes: opts.reused ?? [],
    ...(opts.cancelled === undefined ? {} : { cancelled: { reason: opts.cancelled, at: '2026-07-28T00:00:00Z', notRun: [] } }),
  } as unknown as ExecutorDagResult;
}

/** D-1 基线用 commandRunner fake: 固定退出码, 零副作用。 */
const cmdRunner = (exitCode: number) => async ({ command: _command }: { command: string }) => ({
  text: '', usage: { in: 0, out: 0 }, exitCode, timedOut: false, signal: null,
});

/** 两段共用一个 `_runDag`, 按 plan.name 路由 (省略的那段走缺省的"一切正常")。 */
const dagRouter = (h: {
  contract?: (plan: ConductorPlan) => Promise<ExecutorDagResult>;
  execute?: (plan: ConductorPlan) => Promise<ExecutorDagResult>;
}) =>
  (async (plan: ConductorPlan) =>
    plan.name === 'goal-orchestrating-loop'
      ? await (h.execute ?? (async () => executeDag()))(plan)
      : await (h.contract ?? (async () => contractDag({})))(plan)) as never;

function cfg(dag: Partial<ExecutorDagConfig> = {}, extra: Partial<RunGoalConfig> = {}): RunGoalConfig {
  return {
    cwd: mkdtempSync(join(tmpdir(), 'omd-goal-')),
    dag: { conductorModel: 'c:m', leafModel: 'l:m', ...dag } as ExecutorDagConfig,
    _today: () => '2026-07-28',
    _runDag: dagRouter({}),
    ...extra,
  };
}

describe('runGoal — INV-GOAL-1 全自主 (阶段间零人工介入)', () => {
  // D-26/D-27 (2026-09-02): 契约段的唯一触发换成了 sddPath, tier='complex' 不再自动展开一个
  // `goal-contract` conductor 节点。这条测试原来钉的正是那次自动展开 (INV-11 撤销的那条路);
  // 现在改钉它的替身 —— **零契约段调用**、三 stage 全 skipped、判卷标准仍流到 execute 任务文本。
  // 「sdd 在场」那一侧的行为 (真正的 sdd-direct / 闸 C 复用) 另钉在 contract-stage-gate.test.ts。
  test('complex 档 (无 sddPath): 契约段调用 0 次, 三 stage skipped, execute 一次跑完 (INV-11)', async () => {
    const seen: string[] = [];
    const r = await runGoal('给 omd 加一个自主 goal 引擎', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      _runDag: dagRouter({
        contract: async (plan) => {
          seen.push('contract'); // 不该被调 —— 契约段不再由 tier 自动展开
          return contractDag({});
        },
        execute: async (plan) => {
          seen.push('execute');
          const n = plan.nodes.conductor!;
          expect(n.executor).toBe('agent');
          expect(String(n.goal)).toContain('## 判卷标准'); // 判据仍流到 execute 任务文本 (D-I)
          return executeDag();
        },
      }),
    });
    expect(seen).toEqual(['execute']); // 契约段调用 0 次 (INV-11)
    expect(r.stages.map((s) => `${s.stage}:${s.status}`)).toEqual([
      'classify:done',
      'survey:skipped',
      'research:skipped',
      'spec:skipped',
      'execute:done',
    ]);
    expect(r.repoContext).toBe('');
    expect(r.sources).toEqual([]);
    expect(r.specPath).toBeUndefined();
    expect(r.converged).toBe(true);
  });

  // D-5: 做法已定的活不该先花一轮 research + 一份 SDD。
  test('simple 档: 跳过 research/spec 直接执行', async () => {
    let task = '';
    const r = await runGoal('把 foo 重命名成 bar', {
      ...cfg({ researchRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 }, sources: ['https://x'] }) }),
      _classify: cls('simple'),
      _runDag: dagRouter({
        execute: async (plan) => {
          task = String(plan.nodes.conductor!.goal);
          return executeDag();
        },
      }),
    });
    expect(r.tier).toBe('simple');
    expect(r.stages.find((s) => s.stage === 'research')!.status).toBe('skipped');
    expect(r.sources).toEqual([]); // research 没跑 → 没有来源
    // 目标原文原样进执行, 后面只跟着**冻结的判卷标准** (D-I) —— simple 档不产 spec,
    // 判据没有别的落点, 不附上去这一档就成了"没有验收的自主执行"。
    expect(task.startsWith('把 foo 重命名成 bar\n\n## 判卷标准')).toBe(true);
    expect(task).toContain('bun test');
  });
});

/**
 * **D-I 的冻结判据必须真跑** (2026-07-30 第三次 live 冒烟补的环外闸)。
 *
 * 实测挖出来的洞: 判卷标准只进任务文本, 指望 conductor 把它连成图里一个 command 节点 —— 它没连。
 * 冻结的是 `grep -qx "hello omd" notes/hello.md`, 它自己画的验证步是 `cat notes/hello.md`。
 * 于是"执行型验收"这四个字在生产上**从没被真跑过**, D-J 整套防作弊的地基只剩一句提醒。
 *
 * 闸放**环外**是 D-I 方案 A 的直接后果: 判卷标准必须是执行体动不了的东西 —— 环每轮重画子图,
 * 判据进环就跟着能变。
 */
describe('D-I 冻结判据 — 环外确定性闸', () => {
  const execCfg = (over: Partial<RunGoalConfig> = {}): RunGoalConfig =>
    cfg({}, {
      acceptance: { kind: 'executable', command: 'grep -qx "hello" a.md', expectExit: 0 },
      tier: 'simple',
      ...over,
    });

  test('执行型 → 图上多一个 accept 节点, 逐字带着冻结的命令与期望退出码', async () => {
    let seen: ConductorPlan | undefined;
    await runGoal('写个文件', execCfg({
      _runDag: (async (plan: ConductorPlan) => {
        if (plan.name === 'goal-orchestrating-loop') seen = plan;
        return executeDag();
      }) as never,
    }));
    const accept = seen!.nodes.accept!;
    expect(accept.executor).toBe('command');
    expect(accept.command).toBe('grep -qx "hello" a.md');
    expect(accept.expect_exit).toBe(0);
    expect(accept.depends_on).toEqual(['conductor']); // 环跑完才判 —— 它是环外的闸不是环内的一步
  });

  test('conductor 说成了但**冻结判据没过** → 不算收敛, 终态 not-converged (D-I 要抓的正是这种"作弊达标")', async () => {
    const r = await runGoal('写个文件', execCfg({
      _runDag: (async () => executeDag({ accept: 'failed' })) as never,
    }));
    expect(r.converged).toBe(false);
    // 循环路径没有 judge 票: criteria.judge 就是环结论, 而环结论 = 判据 —— 两格同向, 不存在「判词✅/判据❌打架」。
    expect(r.criteria).toEqual({ judge: false, oracle: false });
    expect(r.outcome).toBe('not-converged');
    expect(r.stages.at(-1)!.summary).toContain('冻结判据没过');
  });

  test('accept 节点**根本没跑** → 也不算收敛 (没被证明过就不算成, 同 converged 缺席那条纪律)', async () => {
    const r = await runGoal('写个文件', execCfg({
      _runDag: (async () => executeDag({ accept: 'absent' })) as never,
    }));
    expect(r.converged).toBe(false);
  });

  // #148 的循环版: 裁决位 = 判据 (D-I 以判据为准)。conductor 节点自己红了 (派工失败 / 报告没写完)
  // 而环外 accept 绿 → 交付已被独立判据证实, 算成; 节点红不漂白, 终态词是 delivered-with-red (#165①)。
  // 怎么让它红: 把 run-goal 的 loopOk 改成 `execLeaf.status === 'done'` 优先即红。
  test('conductor 节点红但**冻结判据绿** → converged, 终态 delivered-with-red (判据是裁决位, 节点红只改终态词)', async () => {
    const r = await runGoal('写个文件', execCfg({
      _runDag: (async () => executeDag({ status: 'failed', accept: 'done' })) as never,
    }));
    expect(r.converged).toBe(true);
    expect(r.outcome).toBe('delivered-with-red');
    expect(r.criteria).toEqual({ judge: true, oracle: true });
    expect(r.stages.at(-1)!.summary).not.toContain('judge 异议'); // 循环路径没有 judge 票, 这一格不该出现
  });

  test('两边都过 → 收敛, 摘要里两条结论都在', async () => {
    const r = await runGoal('写个文件', execCfg({
      _runDag: (async () => executeDag({ accept: 'done' })) as never,
    }));
    expect(r.converged).toBe(true);
    expect(r.stages.at(-1)!.summary).toContain('冻结判据 ✅');
  });

  test('探索型 → **不加** accept 节点 (没有机器判据就别伪造一个)', async () => {
    let seen: ConductorPlan | undefined;
    const r = await runGoal('摸清一个领域', cfg({}, {
      acceptance: { kind: 'exploratory', learningGoal: '学到什么', affordableLoss: '一轮' },
      tier: 'simple',
      _runDag: (async (plan: ConductorPlan) => {
        if (plan.name === 'goal-orchestrating-loop') seen = plan;
        return executeDag();
      }) as never,
    }));
    expect(seen!.nodes.accept).toBeUndefined();
    expect(r.converged).toBe(true); // 探索型只看判词
  });
});

describe('runGoal — D-1 mode 感知基线 delta (SDD cairness-distill D-1, 挂 goal 引擎验收路径)', () => {
  // 基线 = 批前用同一份 commandRunner 跑验收命令; after = accept 节点实判。
  // 只把「新引入失败」判红 (G-1), 老失败单列不红 (G-2 / INV-4)。
  const deltaCfg = (dag: Partial<ExecutorDagConfig>, run: (plan: ConductorPlan) => Promise<ExecutorDagResult>): RunGoalConfig =>
    cfg(dag, {
      acceptance: { kind: 'executable', command: 'grep -qx "hello" a.md', expectExit: 0 },
      tier: 'simple',
      _runDag: run as never,
    });

  /**
   * ★ **S-37 接线闸** —— 纯函数那侧在 `accept-delta.test.ts` 已经钉死;这两条钉的是
   * **run-goal 真把命令输出喂进去了**。少了它们,`buildAcceptDelta` 可以完全正确而
   * run-goal 照样只传一格退出码 —— 那正是 S-35「机制在、真发射点没接」的形状。
   *
   * 背景(为什么值得两条端到端):夜跑 run `c02ac67d` 的引擎印过「D-1 delta: 未新增失败」,
   * 而它说对是**碰巧** —— 基线本来就红,真引入回归它会印一模一样的话。
   */
  /** 按调用次序吐不同输出的 commandRunner(第 1 次 = 基线,第 2 次 = 判红前的复跑)。 */
  const cmdRunnerSeq = (...outs: Array<{ exitCode: number; text: string }>) => {
    let n = 0;
    return async ({ command: _command }: { command: string }) => ({ usage: { in: 0, out: 0 }, timedOut: false, signal: null, ...(outs[Math.min(n++, outs.length - 1)]!) });
  };
  const failLines = (...names: string[]): string => names.map((s) => `(fail) ${s} [1.00ms]`).join('\n');

  test('★ S-37: 基线本来就红(A) + after 红(A+B) → 报 test:B, 不再被 unchanged-failure 赦免', async () => {
    // 证伪(实跑): 把 run-goal 里 after 侧的 acceptSideOf 换回不带输出 → **这两条当场红**
    // (回到 S-37 的洞: 引擎会把 B 当老失败赦免掉)。
    const r = await runGoal('写个文件', deltaCfg(
      // 基线红且复跑同样红 ⇒ 复现确认放行, B 是真回归。
      { commandRunner: cmdRunnerSeq({ exitCode: 1, text: failLines('A') }, { exitCode: 1, text: failLines('A', 'B') }) },
      async () => executeDag({ accept: 'failed', acceptOutput: failLines('A', 'B') }),
    ));
    expect(r.verifyDelta!.red).toBe(true);
    expect(r.verifyDelta!.newFailures).toEqual(['test:B']);
    expect(r.stages.at(-1)!.summary).toContain('D-1 delta: 新增失败 1 [test:B]');
  });

  test('★ S-37 另一半: 复跑没复现 → 不判红, 但抖动写进判词(不留证据 = 偷偷放行)', async () => {
    // 证伪(实跑): 删掉复跑确认那整段 → **本条当场红**(闸被抖动推到假阳性那一端,
    // 人照样学会无视它 —— 那是 S-37 的另一个极端, 不是修好)。
    const r = await runGoal('写个文件', deltaCfg(
      { commandRunner: cmdRunnerSeq({ exitCode: 1, text: failLines('A') }, { exitCode: 1, text: failLines('A') }) },
      async () => executeDag({ accept: 'failed', acceptOutput: failLines('A', 'B') }),
    ));
    expect(r.verifyDelta!.red).toBe(false);
    expect(r.verifyDelta!.newFailures).toEqual([]);
    expect(r.stages.at(-1)!.summary).toContain('复跑未复现 1 [B]');
  });

  test('D-1 反向自检: 基线 pass → accept fail → new-failure, 红, 摘要点名新增失败', async () => {
    // 证伪: 若实现不判红 / 不挂 delta → 本次跑批引入的失败被当老账, 闸形同虚设 (G-1 主路)。
    const r = await runGoal('写个文件', deltaCfg(
      { commandRunner: cmdRunner(0) },
      async () => executeDag({ accept: 'failed' }),
    ));
    expect(r.verifyDelta).toBeDefined();
    expect(r.verifyDelta!.red).toBe(true);
    expect(r.verifyDelta!.newFailures).toEqual(['accept']);
    expect(r.verifyDelta!.steps).toEqual([{ id: 'accept', kind: 'new-failure', before: 'pass', after: 'fail' }]);
    expect(r.converged).toBe(false);
    expect(r.stages.at(-1)!.summary).toContain('D-1 delta: 新增失败 1 [accept]');
  });

  test('D-1: 基线 fail → accept fail → unchanged-failure, 不红 (老段, INV-4 不混算)', async () => {
    // 证伪: 若实现把老失败判红 → 存量语料首跑全红, 与引擎回归混算。
    const r = await runGoal('写个文件', deltaCfg(
      { commandRunner: cmdRunner(1) },
      async () => executeDag({ accept: 'failed' }),
    ));
    expect(r.verifyDelta!.red).toBe(false);
    expect(r.verifyDelta!.newFailures).toEqual([]);
    expect(r.verifyDelta!.steps).toEqual([{ id: 'accept', kind: 'unchanged-failure', before: 'fail', after: 'fail' }]);
  });

  test('D-1: 基线 pass → accept done → 零 delta 不红 (G-2)', async () => {
    const r = await runGoal('写个文件', deltaCfg(
      { commandRunner: cmdRunner(0) },
      async () => executeDag({ accept: 'done' }),
    ));
    expect(r.verifyDelta!.red).toBe(false);
    expect(r.verifyDelta!.steps).toEqual([]);
    expect(r.verifyDelta!.total).toBe(1);
    expect(r.stages.at(-1)!.summary).toContain('D-1 delta: 无变化');
  });

  test('D-1: accept 节点没跑 (缺席) + 基线 pass → new-failure 红 (fail-closed: 覆盖回退)', async () => {
    // 证伪: 若实现把缺席当零 delta → 漏报 —— 「没被证明过就不算成」, 与 D-I 同一条纪律。
    const r = await runGoal('写个文件', deltaCfg(
      { commandRunner: cmdRunner(0) },
      async () => executeDag({ accept: 'absent' }),
    ));
    expect(r.verifyDelta!.red).toBe(true);
    expect(r.verifyDelta!.newFailures).toEqual(['accept']);
    expect(r.verifyDelta!.steps).toEqual([{ id: 'accept', kind: 'new-failure', before: 'pass' }]);
  });

  test('D-1 fail-open: 没配 commandRunner → verifyDelta 缺席 (闸缺席 ≠ 零 delta)', async () => {
    const r = await runGoal('写个文件', deltaCfg(
      {},
      async () => executeDag({ accept: 'failed' }),
    ));
    expect(r.verifyDelta).toBeUndefined();
  });
});

describe('runGoal — 降级路径都留痕, 不假装', () => {
  // D-26/D-27 (2026-09-02): 上面四条原来钉的是「契约段自动展开 (conductor 子图) 里 survey/
  // research/spec 各自的降级分支」—— 那个自动展开的子图已撤销 (INV-11: 唯一触发换成 sddPath),
  // 无 sddPath 时这三个 stage 一律 skipped, 不再有"跑了但没产出" / "跑了但零来源"这些细分降级
  // 状态可留痕。撤销后仅存的一条 (execute 抛错) 与契约段无关, 照旧保留。
  test('execute 抛错 → 记 failed 并返回 (不把异常抛给调用方)', async () => {
    const r = await runGoal('做点事', {
      ...cfg(),
      _classify: cls('simple'),
      _runDag: dagRouter({
        execute: async () => {
          throw new Error('conductor 崩了');
        },
      }),
    });
    expect(r.converged).toBe(false);
    expect(r.stages.at(-1)!.summary).toContain('conductor 崩了');
  });
});

describe('runGoal — INV-GOAL-4 有界 / INV-GOAL-3 可证', () => {
  // 循环路径的有界性 = 引擎 `maxEscalations: 0` + D-14 回灌恰一次 (钉在 orchestrating-loop.test.ts);
  // 这里只钉「跑完了 ≠ 成了」与可证面。
  test('conductor 跑完但冻结判据没过 → 整段 failed 且 converged=false (不因"跑完了"就算成)', async () => {
    const r = await runGoal('g', {
      ...cfg(),
      _classify: cls('simple'),
      _runDag: dagRouter({ execute: async () => executeDag({ accept: 'failed' }) }),
    });
    expect(r.converged).toBe(false);
    expect(r.stages.at(-1)!.status).toBe('failed');
    expect(r.stages.at(-1)!.summary).toContain('冻结判据没过');
  });

  test('conductor 节点根本没结果 → failed 留痕 (不静默当收敛)', async () => {
    const r = await runGoal('g', {
      ...cfg(),
      _classify: cls('simple'),
      _runDag: dagRouter({
        execute: async () => ({ plan: { name: 'goal-orchestrating-loop', nodes: {} }, results: {} }) as unknown as ExecutorDagResult,
      }),
    });
    expect(r.converged).toBe(false);
    expect(r.stages.at(-1)!.summary).toContain('无结果');
  });

  // D-26/D-27 (2026-09-02): researchRounds 原来只能经契约段自动展开的 goal 文本传下去
  // (契约段是唯一读它的地方) —— 该子图已撤销, `researchRounds` 因此成了本次改动之外的一个
  // 空旋钮 (公开 dag_goal 参数仍在, 但内部已无消费点), 留给 owner 另立票处理, 不在本片动手。

  // D-F 之后复用发生在**内环**里 (子节点内容寻址), 由引擎并进结果面的 reusedNodes。
  test('复用集进结果 (INV-GOAL-3 可证面)', async () => {
    const r = await runGoal('g', {
      ...cfg(),
      _classify: cls('simple'),
      _runDag: dagRouter({ execute: async () => executeDag({ reused: ['a', 'b'] }) }),
    });
    expect(r.reusedNodes).toEqual(['a', 'b']);
  });
});

/**
 * 2026-07-30 第一次 live 冒烟才看见的空旋钮: `runGoal` 只读 `config.dag.generate` 去建分类器,
 * 而那是**注入口**, 生产从来不设 (引擎自己 `?? makeDefaultGenerate`) —— 于是真实路径上每一次
 * dag_goal 都走「无分类器」兜底 → 恒探索型 → **D-I 的执行型验收 (强制可跑命令) 从未成立过**。
 * 机制在、注入式测试全绿、生产零生效。这条钉的是"回落到引擎默认实现"这根接线。
 */
describe('runGoal — 分类器必须真接上 (D-I 的地基, 不许静默降级)', () => {
  test('不传 _classify 且 dag.generate 缺席 → 仍**建得出**分类器 (降级原因不是"无分类器")', async () => {
    const r = await runGoal('g', {
      ...cfg({ conductorModel: 'no-such-provider:m' }), // provider 没注册 → 调用会抛 → 走"调用失败"兜底
    });
    // 两种兜底文案分得开: "无分类器" = 压根没接上 (就是这次要防的那个 bug);
    // "分类调用或解析失败" = 接上了但这次调不通 (座位没配/网断, 那是另一回事)。
    const s = r.stages.find((x) => x.stage === 'classify')!.summary;
    expect(s).not.toContain('无分类器');
    expect(s).toContain('分类调用或解析失败');
  });
});

describe('goalSlug', () => {
  test('kebab 化 + 截断 + 空值兜底', () => {
    expect(goalSlug('Add A New Thing!')).toBe('add-a-new-thing');
    expect(goalSlug('!!!')).toBe('goal');
    expect(goalSlug('x'.repeat(80))).toHaveLength(48);
  });
});

// ── 仓内勘察 (survey): research 的 leaf 是 inproc 看不见仓库, agent 反过来有全套工具没 web。
// 这一站就是把两边接上 —— 少了它, research 是在不知道"仓里已有什么"的前提下去查外面。
describe('runGoal — survey 仓内勘察 (inproc 研究与仓库的接点)', () => {
  test('无 agentRunner → 整个契约段跳过 (没有工具就没有勘察, 也就写不出有根据的契约)', async () => {
    let ranDag = false;
    const r = await runGoal('g', {
      ...cfg({ researchRunner: async () => ({ text: 't', usage: { in: 1, out: 1 }, sources: ['https://x'] }) }),
      _classify: cls('complex'),
      _runDag: dagRouter({
        contract: async () => {
          ranDag = true;
          return contractDag({});
        },
      }),
    });
    expect(ranDag).toBe(false); // 连图都不跑, 不白花一次 conductor 调用
    for (const st of ['survey', 'research', 'spec'] as const) {
      expect(r.stages.find((s) => s.stage === st)!.status).toBe('skipped');
    }
    expect(r.repoContext).toBe('');
  });

  // D-26/D-27 (2026-09-02): 「勘察步跑了但空手而归」这个细分降级状态只存在于契约段自动展开
  // 的子图里 (survey 是子图里的一个 agent 子节点) —— 该子图已撤销, 无 sddPath 时 survey 恒
  // skipped, 不再有"跑了但空手"这个中间态可留痕。

  test('子图里压根没有勘察步 → skipped (与"跑了但空手"分开记)', async () => {
    const r = await runGoal('g', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      _runDag: dagRouter({ contract: async () => contractDag({ specFile: 'docs/plan/2026-07-28-g.md' }) }),
    });
    expect(r.stages.find((x) => x.stage === 'survey')!.status).toBe('skipped');
  });

  test('simple 档不勘察 (做法已定的活不值一次读仓)', async () => {
    let called = false;
    const r = await runGoal('g', {
      ...cfg({
        agentRunner: async () => {
          called = true;
          return { text: 'x', usage: { in: 1, out: 1 } };
        },
      }),
      _classify: cls('simple'),
    });
    expect(called).toBe(false);
    // D-26/D-27: 三 stage 统一 skipped (不再是 simple 档独有的"压根没有这个 stage") —— INV-11
    // 要求无 sddPath 时 survey/research/spec 一律出现且状态为 skipped, 不因 tier 而异。
    expect(r.stages.find((s) => s.stage === 'survey')!.status).toBe('skipped');
  });
});

// ── 闸 C (2026-08-10 事故): 续跑复用 classify ──────────────────────────────────
//
// 事故: 同一段 goal 被心跳续派重分类 117 遍 (平均 2.1M tokens/遍) —— 节点级 checkpoint
// 拦不住 (conductor 子图逐轮重展开, D-O 输入面恒判"依赖输出已变")。闸 C 把 classify
// 按 goal 全文哈希锚在 `.omd/continuity/<runId>/goal-state.json`, 未变即复用。
//
// ⚠ D-26/D-27 (2026-09-02) 之后, 闸 C 原来"契约段产物同锚复用"那一半改了归属: 契约段
// 唯一触发是 sddPath, 无 sddPath 时压根不产 contract 状态可供复用 (specSource='loop'),
// 这里的 counters 因此只留 classify/exec 两支。「sdd 在场 + prior.contract 命中 → 复用」
// 那条分支单独钉在 contract-stage-gate.test.ts (INV-11 第二格), 不在本文件重复。

import { existsSync, rmSync, writeFileSync } from 'node:fs';

describe('闸 C — 续跑复用 classify (goal-state 锚)', () => {
  const mkCounted = (cwd: string, counters: { classify: number; exec: number }): RunGoalConfig => ({
    cwd,
    dag: {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      continuity: { manager: {} as never, runId: 'run-c' },
    } as ExecutorDagConfig,
    _today: () => '2026-08-10',
    _classify: async () => (counters.classify++, { tier: 'complex' as GoalTier, acceptance: ACC_EXEC }),
    _runDag: async () => {
      counters.exec++;
      return executeDag();
    },
  });

  test('反向自检: 同 goal 同 runId 二跑 → classify 只跑一遍, 执行段照常跑两遍', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-c-'));
    const counters = { classify: 0, exec: 0 };
    const r1 = await runGoal('目标甲', mkCounted(cwd, counters));
    expect([counters.classify, counters.exec]).toEqual([1, 1]);
    const r2 = await runGoal('目标甲', mkCounted(cwd, counters));
    expect([counters.classify, counters.exec]).toEqual([1, 2]);
    expect(r2.stages.find((s) => s.stage === 'classify')!.summary).toContain('闸 C');
    expect(r2.converged).toBe(true); // 复用不改变执行段结论
  });

  test('对照臂: goal 文本变了 → 状态作废, classify 照常重跑', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-c-'));
    const counters = { classify: 0, exec: 0 };
    await runGoal('目标甲', mkCounted(cwd, counters));
    await runGoal('目标乙 (一字之差也算变)', mkCounted(cwd, counters));
    expect(counters.classify).toBe(2);
  });

  test('对照臂: 无 continuity (无 runId 可锚) → 闸不启用, 两跑两遍', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-c-'));
    const counters = { classify: 0, exec: 0 };
    const mk = (): RunGoalConfig => {
      const c = mkCounted(cwd, counters);
      delete (c.dag as { continuity?: unknown }).continuity;
      return c;
    };
    await runGoal('目标甲', mk());
    await runGoal('目标甲', mk());
    expect(counters.classify).toBe(2);
  });
});
describe('runGoal — D-2 写集声明 + 跑后 diff 对账 (SDD cairness-distill D-2, 挂 goal 引擎验收路径)', () => {
  // 声明面 = exec 图里真跑过节点的 write_set; diff 面 = 注入式收集 (测试不碰真 git)。
  // 只把「走完归属阶梯无归属」判红 (G-3); 无声明 → undeclared 不红 (INV-3); 收集失败 → 闸缺席 (fail-open)。
  // G-4 (历史声明不授权) 由 wiring 的「只收 done/failed 且 results 有条目」+ 判定器的 activeNodeIds 双裁。
  const writeSetCfg = (opts: {
    diff?: string[];
    declared?: Record<string, string[]>;
    accept?: 'done' | 'failed' | 'absent';
    extra?: Partial<NonNullable<RunGoalConfig['writeSet']>>;
  }): RunGoalConfig =>
    cfg({}, {
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
      writeSet: { _collectChangedFiles: () => opts.diff ?? [], ...opts.extra },
      _runDag: (async () => {
        const base = executeDag({ accept: opts.accept ?? 'done' });
        return {
          ...base,
          plan: {
            name: 'goal-orchestrating-loop',
            nodes: {
              conductor: { executor: 'conductor', goal: 'g', ...(opts.declared?.execute ? { write_set: opts.declared.execute } : {}) },
              accept: { executor: 'command', command: 'true' },
              // G-4 探针: 声明了但本轮 results 无条目 (= 没跑) 的节点 —— wiring 必须把它滤出声明面。
              ...(opts.declared?.history ? { history: { executor: 'command', command: 'true', write_set: opts.declared.history } } : {}),
            },
          },
        } as unknown as ExecutorDagResult;
      }) as never,
    });

  test('D-2 G-3 反向自检: 节点声明 [a.ts] 而 diff 含 a.ts+b.ts → b.ts orphan 红, 摘要点名越界', async () => {
    // 证伪: 若实现把 b.ts 放行 → 越界写 (声明了 A 却改了 B) 被当正常, 闸形同虚设。
    const r = await runGoal('写个文件', writeSetCfg({ diff: ['a.ts', 'b.ts'], declared: { execute: ['a.ts'] } }));
    expect(r.writeSet).toBeDefined();
    expect(r.writeSet!.red).toBe(true);
    expect(r.writeSet!.orphans).toEqual(['b.ts']);
    expect(r.writeSet!.files).toEqual([
      { file: 'a.ts', kind: 'node-owned', declaredBy: ['conductor'] },
      { file: 'b.ts', kind: 'orphan' },
    ]);
    expect(r.stages.at(-1)!.summary).toContain('D-2 写集: 写集越界 1 [b.ts]');
  });

  test('D-2: b.ts 在 intentional 例外表 → 放行不红 (G-3 第二子句接线)', async () => {
    const r = await runGoal('写个文件', writeSetCfg({
      diff: ['a.ts', 'b.ts'],
      declared: { execute: ['a.ts'] },
      extra: { intentional: ['b.ts'] },
    }));
    expect(r.writeSet!.red).toBe(false);
    expect(r.writeSet!.orphans).toEqual([]);
    expect(r.writeSet!.files.find((f) => f.file === 'b.ts')!.kind).toBe('intentional');
  });

  test('D-2 G-4: 历史 run 的 done 节点声明过 c.ts → 后续 diff 改 c.ts 不因该历史声明放行 (orphan 红)', async () => {
    // 证伪: 若 wiring 把没跑过的节点声明也喂进判定器 → 历史声明变永久通行证 (归档即授权),
    // 正是 SDD 点名要堵的洞; 本测的 history 节点本轮 results 无条目, 必须被滤出声明面。
    const r = await runGoal('写个文件', writeSetCfg({
      diff: ['a.ts', 'c.ts'],
      declared: { execute: ['a.ts'], history: ['c.ts'] },
    }));
    expect(r.writeSet!.red).toBe(true);
    expect(r.writeSet!.orphans).toEqual(['c.ts']);
    expect(r.writeSet!.files.find((f) => f.file === 'c.ts')!.kind).toBe('orphan');
  });

  test('D-2 INV-3: 整 run 无节点声明 → verdict undeclared, diff 有文件也不红 (声明缺席 ≠ 违规)', async () => {
    // 证伪: 若实现把无声明 run 判红 → 误伤 (声明是可选字段, 没声明 = 没进对账契约, 那是 O-1 读数)。
    const r = await runGoal('写个文件', writeSetCfg({ diff: ['x.ts'] }));
    expect(r.writeSet).toBeDefined();
    expect(r.writeSet!.verdict).toBe('undeclared');
    expect(r.writeSet!.red).toBe(false);
    expect(r.stages.at(-1)!.summary).toContain('D-2 写集: 未声明');
  });

  test('D-2 fail-open: diff 收集抛错 → writeSet 缺席 (闸缺席 ≠ 零越界), 不阻断 run', async () => {
    // 证伪: 若实现把收集失败当「零越界」报绿 → 闸缺席被念成通过; 若实现让 run 抛错 → 闸变拦路虎。
    const r = await runGoal('写个文件', {
      ...writeSetCfg({}),
      writeSet: { _collectChangedFiles: () => { throw new Error('不是 git 仓'); } },
    });
    expect(r.writeSet).toBeUndefined();
    expect(r.converged).toBe(true); // 对账失败不影响 execute 结论本身
  });

  test('D-2: 没配 writeSet 注入面 → writeSet 缺席 (闸没进场)', async () => {
    const r = await runGoal('写个文件', cfg({}, { acceptance: { kind: 'executable', command: 'true', expectExit: 0 }, tier: 'simple' }));
    expect(r.writeSet).toBeUndefined();
  });

/**
 * S-2 (SDD cairness-distill 2026-08-10, run 级声明写集面): diff 逐文件裁
 * allowed / forbidden / outside —— 判据与 enforcement 同一真源 (write-set.ts 的
 * classifyWriteScope + SDD_DECLARED_WRITE_SET), run-goal.ts 只做 wiring: 收集 diff →
 * 分类 → 分列报告。与上面节点级 writeSet 正交 (阶梯裁「谁写的」, 声明面裁「该不该写」),
 * 分开报不混成一个红 (INV-4)。GWT 逐条对应 docs/plan/2026-08-10-concurrent-sdd-execute-test.md
 * run B 的「预期写集(声明)」: 允许 src/harness/** · docs/silent-failures.md · 本 run 报告
 * (精确名, R-3 互异); 禁写 src/model/** (run C) · src/eval/** (run A)。
 */
describe('runGoal — D-2 声明写集面 (S-2, run 级 runtime 面)', () => {
  // declared 缺席 → 回落 write-set.ts 的缺省面 (本 SDD run 自己的声明), 同 run-goal.ts 的
  // `config.writeSet.declared ?? SDD_DECLARED_WRITE_SET` 接线。
  const scopeCfg = (opts: {
    diff?: string[];
    declared?: DeclaredWriteSet;
    extra?: Partial<NonNullable<RunGoalConfig['writeSet']>>;
  }): RunGoalConfig =>
    cfg({}, {
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
      writeSet: {
        _collectChangedFiles: () => opts.diff ?? [],
        ...(opts.declared ? { declared: opts.declared } : {}),
        ...opts.extra,
      },
      _runDag: (async () => executeDag()) as never,
    });

  test('S-2 fallback 阶梯: declared 缺席 → 回落缺省面, 本 run 落点全 allowed 不红', async () => {
    // 证伪: 若 wiring 不回落 SDD_DECLARED_WRITE_SET → 缺省声明面空转, 本 run 自己的
    // 测试落点 (src/harness/**) 全被裁 outside, S-2 自伤。
    const r = await runGoal('写个文件', scopeCfg({
      diff: ['src/harness/run-goal.test.ts', 'src/harness/plan/deep/x.test.ts', 'docs/silent-failures.md'],
    }));
    expect(r.writeScope).toBeDefined();
    expect(r.writeScope!.forbidden).toEqual([]);
    expect(r.writeScope!.outside).toEqual([]);
    expect(r.writeScope!.allowed.sort()).toEqual(['docs/silent-failures.md', 'src/harness/plan/deep/x.test.ts', 'src/harness/run-goal.test.ts']);
    expect(r.writeScope!.files.every((f) => f.kind === 'allowed')).toBe(true);
    expect(r.stages.at(-1)!.summary).toContain('声明面内');
  });

  test('S-2 R-3 精确报告路径: 本 run 报告文件名 → allowed, 并发 run 报告 → outside (docs/plan 不开通配)', async () => {
    // 证伪: 若 docs/plan/** 被当通配放行 → run A/C 的报告文件裁 allowed, R-3 互异形同虚设,
    // 并发 run 报告面相撞 (S-2 ① 不相交判据在报告面上失效)。
    expect(SDD_REPORT_FILE).toBe('docs/plan/2026-08-10-cairness-distill-report.md');
    const r = await runGoal('写个文件', scopeCfg({
      diff: [SDD_REPORT_FILE, 'docs/plan/2026-08-10-compression-experiment-report.md', 'docs/plan/2026-08-10-seats-doctor-report.md'],
    }));
    expect(r.writeScope!.allowed).toEqual([SDD_REPORT_FILE]);
    expect(r.writeScope!.outside.sort()).toEqual([
      'docs/plan/2026-08-10-compression-experiment-report.md',
      'docs/plan/2026-08-10-seats-doctor-report.md',
    ]);
    expect(r.writeScope!.forbidden).toEqual([]);
    expect(r.stages.at(-1)!.summary).toContain('声明面外 2 (INV-3 读数)');
  });

  test('S-2 注入 declared 压过缺省面 (fallback 不泄漏)', async () => {
    // 证伪: 若 wiring 只认缺省面 → 并发 run 注入自己互异的声明面失效, 声明写集变一仓一份,
    // 三写集互异 (concurrent-sdd-execute-test 三行声明) 无从表达。
    const r = await runGoal('写个文件', scopeCfg({
      diff: ['src/custom/x.ts', 'src/harness/x.ts', 'src/other/y.ts'],
      declared: { allowed: ['src/custom/**'], forbidden: ['src/other/**'] },
    }));
    expect(r.writeScope!.allowed).toEqual(['src/custom/x.ts']);
    expect(r.writeScope!.outside).toEqual(['src/harness/x.ts']); // 缺省面没搭车生效
    expect(r.writeScope!.forbidden).toEqual(['src/other/y.ts']);
  });

  test('S-2 禁写面: src/model/** (run C) 与 src/eval/** (run A) → forbidden, 摘要点名撞禁写面', async () => {
    // 证伪: 若禁写面缺失/放行 → 并发 run 的写面被本 run 静默踩踏且不落任何红,
    // S-2 隔离性第一道防线破 (concurrent-sdd-execute-test S-2 ①)。
    const r = await runGoal('写个文件', scopeCfg({
      diff: ['src/model/seat-quota.ts', 'src/model/a/b/c.ts', 'src/eval/runner.ts'],
    }));
    expect(r.writeScope!.forbidden.sort()).toEqual(['src/eval/runner.ts', 'src/model/a/b/c.ts', 'src/model/seat-quota.ts']);
    expect(r.writeScope!.allowed).toEqual([]);
    expect(r.stages.at(-1)!.summary).toContain('撞禁写面 3');
    expect(r.stages.at(-1)!.summary).toContain('src/model/seat-quota.ts');
  });

  test('S-2 INV-2 已知违规写必须红: 单文件 diff 撞 run C 写面 → forbidden 点名', async () => {
    // 证伪方法 (INV-2): 闸若缺失, classifyWriteScope 对该样本返回 allowed/outside,
    // 越界写被当正常 —— S-2 隔离破 → run C 写集面被静默踩踏且不落 orphan 语料 (D-2 手工首跑
    // 的判据正是 S-2 ①)。断言 forbidden 即当场证伪: 禁写面唯一合法答案就是红, 无灰色放行。
    const r = await runGoal('写个文件', scopeCfg({ diff: ['src/model/seat-quota.ts'] }));
    expect(r.writeScope!.forbidden).toEqual(['src/model/seat-quota.ts']);
    expect(r.writeScope!.files).toEqual([{ file: 'src/model/seat-quota.ts', kind: 'forbidden' }]);
    expect(r.stages.at(-1)!.summary).toContain('撞禁写面 1 [src/model/seat-quota.ts]');
  });

  test('S-2 近形负例: src/model.ts / src/eval.ts / src/harness.ts → outside, glob 不前缀匹配', async () => {
    // 证伪: 若 glob 退化成前缀匹配 → 顶层近形文件被裁 forbidden/allowed, 允许面/禁写面外扩,
    // 合法文件被当越界写 (假阳)。
    const r = await runGoal('写个文件', scopeCfg({ diff: ['src/model.ts', 'src/eval.ts', 'src/harness.ts'] }));
    expect(r.writeScope!.outside.sort()).toEqual(['src/eval.ts', 'src/harness.ts', 'src/model.ts']);
    expect(r.writeScope!.forbidden).toEqual([]);
    expect(r.writeScope!.allowed).toEqual([]);
  });

  test('S-2 混面 diff: 三种裁决各自点名, 禁写优先报红 (fail-closed 不回溯)', async () => {
    const r = await runGoal('写个文件', scopeCfg({
      diff: ['src/harness/x.ts', 'src/model/seat-quota.ts', 'scripts/foo.ts'],
    }));
    expect(r.writeScope!.allowed).toEqual(['src/harness/x.ts']);
    expect(r.writeScope!.forbidden).toEqual(['src/model/seat-quota.ts']);
    expect(r.writeScope!.outside).toEqual(['scripts/foo.ts']); // run C 允许面, 本 run 未声明 = INV-3 读数
    expect(r.stages.at(-1)!.summary).toContain('撞禁写面 1 [src/model/seat-quota.ts]');
  });

  test('S-2 fail-open: 没配 writeSet 注入面 → writeScope 缺席 (闸没进场, 不是零越界)', async () => {
    const r = await runGoal('写个文件', cfg({}, { acceptance: { kind: 'executable', command: 'true', expectExit: 0 }, tier: 'simple' }));
    expect(r.writeScope).toBeUndefined();
  });
});
});


// ── D-2 散雾出口 (SDD 2026-08-11-control-plane-unification 切片 1) ────────────────
//
// 这一组走**真 md 后端 + 真 map 写入磁盘 + 真 frontier**: 判据本身在 pathfinder/run-tickets.test.ts,
// 这里钉的是「接线真的通了」—— 而"接线在不在"恰恰是 S-1 此前那条缝的全部内容
// (机制在、pathfinder 派发线生效、直接 run 零命中)。
import { resolveBackend } from '../pathfinder/backend';
import { loadMap } from '../pathfinder/map-store';
import { computeFrontier } from '../pathfinder/frontier';

/** 一份带未决段的 spec 正文 (经 `_readSpec` 注入, 不真正写入磁盘)。 */
const SPEC_WITH_OPEN = [
  '# 某 SDD',
  '',
  '## 决策 (Decisions)',
  '- **D-1 这条不是未决**',
  '',
  '## 未决 (Open)',
  '',
  '- **O-1(待 owner)** 超时时长定多少。',
  '- **O-2(待实测)** 接受率读数。',
].join('\n');

/** 真 md 后端 + 一张空图 (env 传 {} 绕开外部 OMD_PATH_BACKEND 干扰)。 */
function mapCfg(goalCfg: RunGoalConfig, runId: string): { backend: ReturnType<typeof resolveBackend>; tickets: NonNullable<RunGoalConfig['tickets']> } {
  const backend = resolveBackend(goalCfg.cwd, { env: {} });
  backend.createMap(goalCfg.cwd, '把散雾出口接上', 'fog-exit');
  return { backend, tickets: { slug: 'fog-exit', sink: backend, runId, at: '2026-08-11T00:00:00.000Z' } };
}

describe('D-2 散雾出口 — 任一 run 挂票 (G-1 / G-2)', () => {
  /**
   * **G-1**: 不经 pathfinder 派发的 run 产出「未决」→ map 上出现 suggested 票, 携 runId 锚,
   * 且**人 confirm 前不进前沿**。
   *
   * 反向自检 (G-6, 实跑证伪): 把 run-goal.ts 收尾那行 `openRunTickets(result, exec, config)` 注释掉 →
   * `map.tickets` 恒为空, 本条前两个 expect 当场红 (实测 `expected 2, got 0`)。
   * 换句话说这条测试证的是**接线**, 不是判据 —— 判据红不红在 run-tickets.test.ts 那边。
   */
  // D-26/D-27 (2026-09-02): 原来靠契约段自动展开产出 `r.specPath` 来喂 ①。该子图已撤销
  // (契约段唯一触发是 sddPath), 这里改用 sdd-direct 拿到一份真实的 `r.specPath` ——
  // 判据用探索型 (非 executable) 是为了绕开 `if (sdd && runnable)` 那条平铺图编译分支
  // (D3, 与本测试的关注点无关, 走了反而要喂一份能真编译的分解表)。
  test('G-1: 契约段未决 → map 出现 suggested 票 (携 runId), 且不进前沿', async () => {
    const base = cfg();
    const { tickets } = mapCfg(base, 'run-g1');
    const sddPath = join(base.cwd, 'sdd.md');
    writeFileSync(sddPath, '# 契约\n\n## 契约\n给 omd 加个散雾出口。\n\n## 分解\n1. 做 → verify: `bun test`\n');
    let readSpecArg = '';
    const r = await runGoal('给 omd 加个散雾出口', {
      ...base,
      sddPath,
      _classify: cls('complex', { kind: 'exploratory', learningGoal: 'x', affordableLoss: 'y' }),
      _runDag: dagRouter({ execute: async () => executeDag() }),
      tickets: {
        ...tickets,
        _readSpec: (p) => {
          readSpecArg = p;
          return SPEC_WITH_OPEN;
        },
      },
    });
    expect(r.converged).toBe(true); // run 本身照常收敛 —— 开票是收尾的旁路, 不改结论
    expect(readSpecArg).toBe(r.specPath!); // ① 的料确实来自这趟 run 的 spec

    const map = loadMap(base.cwd, 'fog-exit')!;
    expect(map.tickets).toHaveLength(2);
    expect(map.tickets.map((t) => t.status)).toEqual(['suggested', 'suggested']);
    expect(map.tickets[0]!.title).toBe('[未决] O-1(待 owner) 超时时长定多少。');
    expect(map.tickets.map((t) => t.suggestedBy)).toEqual(['run-g1', 'run-g1']);
    // 人 confirm 前不进前沿 (suggested 没有执行力, INV-S1-1)。
    expect(computeFrontier(map).map((t) => t.id)).toEqual([]);
  });

  /**
   * **G-2**: 同因熔断 → 票带原因 + blame 摘要 + resume 把手, 且 run 终态与票**双向可达**
   * (票 → `suggestedBy` = runId → 回执; 票 → 标题里的 resume 把手 → 同一个 runId)。
   *
   * 反向自检 (G-6, 实跑证伪): 把 run-goal.ts 的 `...(exec.verification ? { verification: exec.verification } : {})`
   * 那一行删掉 (熔断面不再传给纯核) → 熔断票消失, 只剩发现物票, 本条 `[同因熔断]` 断言当场红
   * (实测 `expected 2, got 1` + 标题不匹配)。
   */
  test('G-2: 同因熔断 → 票带原因 + blame + resume 把手, 票↔runId 双向可达', async () => {
    const base = cfg();
    const { tickets } = mapCfg(base, 'run-g2');
    const stalledDag = (): ExecutorDagResult =>
      ({
        ...executeDag({ accept: 'failed' }),
        verification: { pass: false, reason: '连撞同一根因: 产物缺失', attempts: 2, escalated: true, conductorModel: 'c:m', circuitBroken: true },
        blameRetry: { blameSize: 2, closureSize: 4, reuseHits: 1, rerunWallMs: 42 },
      }) as ExecutorDagResult;
    const r = await runGoal('修个东西', {
      ...base,
      _classify: cls('simple'),
      _runDag: dagRouter({ execute: async () => stalledDag() }),
      tickets,
    });
    expect(r.outcome).toBe('not-converged');

    const map = loadMap(base.cwd, 'fog-exit')!;
    const circuit = map.tickets.find((t) => t.title.startsWith('[同因熔断]'))!;
    expect(circuit).toBeDefined();
    expect(circuit.status).toBe('suggested');
    expect(circuit.title).toBe('[同因熔断] 连撞同一根因: 产物缺失 · blame 2 节点/失效闭包 4 · resume: dag_goal resume=run-g2');
    // 双向可达: 票 → runId (溯源字段) / 票 → resume 把手 (标题自足, 人不必读 transcript)。
    expect(circuit.suggestedBy).toBe('run-g2');
    expect(circuit.title).toContain('resume: dag_goal resume=run-g2');
    // 熔断票排在发现物票之前 (perRunCap 从尾巴丢, 带把手的那张不能被挤掉)。
    expect(map.tickets[0]!.id).toBe(circuit.id);
  });

  test('INV-1 fail-open: 没配 tickets → map 一张票都不开, run 结论一字不变', async () => {
    const base = cfg();
    const { backend } = mapCfg(base, 'run-none');
    const r = await runGoal('修个东西', { ...base, _classify: cls('simple') });
    expect(r.converged).toBe(true);
    expect(backend.readMap(base.cwd, 'fog-exit')!.tickets).toEqual([]);
  });

  test('INV-1 fail-open: 后端没实装 suggest → 不抛不吞, run 照常返回', async () => {
    const base = cfg();
    const r = await runGoal('修个东西', {
      ...base,
      _classify: cls('simple'),
      tickets: { slug: 'no-such-map', sink: {}, runId: 'run-x' },
    });
    expect(r.converged).toBe(true);
  });

  test('落图抛错 (图不存在) → 闸缺席不掀桌, run 照常返回', async () => {
    const base = cfg();
    const r = await runGoal('修个东西', {
      ...base,
      _classify: cls('simple'),
      _runDag: dagRouter({ execute: async () => executeDag({ accept: 'failed' }) }),
      tickets: { slug: 'no-such-map', sink: resolveBackend(base.cwd, { env: {} }), runId: 'run-y' },
    });
    expect(r.outcome).toBe('not-converged'); // 开票炸了不改 run 结论
  });
});

describe('runGoal — S4 run 生命周期接线 (board: claimed → terminal)', () => {
  // D-5 修订: compact 只删**超保留期**(默认 24h, 自 terminal ts 起算)的终态 run 条目 ——
  // 刚终态的 run 条目保留期内仍可读 (await 谓词的满足/中止信号, G-2/G-3)。所以 claimed 经
  // onClassified 在 run 中途观测, "terminal 真 append 过" 由终态后 terminal 条目仍在板上 (保留期内) 证明。
  test('点火即 claimed: 带声明写集 (相对路径, 与 sdd-direct 写集列同物) + runId 锚; 终态后条目保留期内仍可读', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-s4-'));
    let claimedDuring: BoardEntry | undefined;
    await runGoal('做一个事', cfg(
      { sessionId: 'sess-s4-1' },
      {
        cwd,
        _classify: cls('simple'),
        writeSet: { declared: { allowed: ['docs/a.md', 'src/x/**'], forbidden: [] } },
        // claimed 在点火处已写、terminal 未写 —— 这个窗口正是观测点。
        onClassified: () => { claimedDuring = readBoard(cwd).find((e) => e.event === 'claimed'); },
      },
    ));
    expect(claimedDuring?.runId).toBe('sess-s4-1');
    expect(claimedDuring?.writeSet).toEqual(['docs/a.md', 'src/x/**']);
    // 终态后条目仍在板上 (保留期内, D-5: compact 不再"终态即清") —— terminal 确实经 appendBoard 落过。
    const after = readBoard(cwd);
    expect(after.some((e) => e.runId === 'sess-s4-1' && e.event === 'claimed')).toBe(true);
    expect(after.some((e) => e.runId === 'sess-s4-1' && e.event === 'terminal')).toBe(true);
  });

  /**
   * ⚠ **断言在 2026-08-26 翻过面** —— 原文是
   * `expect(claimedDuring?.writeSet).toEqual(SDD_DECLARED_WRITE_SET.allowed)`,
   * 即「未注入写集时 claim 行兜底那个模块级常量」。那条断言**把缺陷固化住了**
   * (本仓 §静默坑 3: 测试与实装一起产出时会一起错并互相背书)。
   *
   * `SDD_DECLARED_WRITE_SET` (write-set.ts:139) 是 2026-08-10 那一份 SDD 自己的写集,
   * 与任意一个后来的 run 都没有关系。实账: 板上 12 条僵尸 claim 的 writeSet 逐字节相同,
   * 于是每一次点火回执都打印同一句假撞车告警。
   *
   * 新契约 = 与 `dag_run` 路一致 (dag-run-board.ts 头注 19-27): **未声明就是字段缺席**,
   * 因为「没声明」(判不了交集) 与「声明了空集」(可断言无冲突) 是两件事。
   * 写集对账那一侧仍兜底常量 —— 两个消费者处置不同, 见 RunGoalConfig.writeSet 的注。
   */
  test('未注入声明写集 → claim 行**不带** writeSet 字段 (不兜底常量)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-s4-'));
    let claimedDuring: BoardEntry | undefined;
    await runGoal('做一个事', cfg({}, {
      cwd,
      _classify: cls('simple'),
      onClassified: () => { claimedDuring = readBoard(cwd).find((e) => e.event === 'claimed'); },
    }));
    expect(claimedDuring).toBeDefined();
    expect(claimedDuring?.writeSet).toBeUndefined();
    // 只断言 undefined 的话, 实装换成 `[]` 也能过 —— 而 `[]` 恰好是本仓明令禁止的那种压平。
    expect(JSON.stringify(claimedDuring)).not.toContain(SDD_DECLARED_WRITE_SET.allowed[0]!);
  });

  test('终态 entry 内容: outcome 四值投影 + note 留细粒度 (纯函数面, compact 后读不到原行)', () => {
    const e = boardTerminalEntry('run-t1', 'not-converged');
    expect(e.event).toBe('terminal');
    expect(e.runId).toBe('run-t1');
    expect(e.outcome).toBe('not-converged');
    expect(e.note).toBe('not-converged');
    expect(boardTerminalEntry('run-t2', 'success').outcome).toBe('converged');
    expect(boardTerminalEntry('run-t3', 'cancelled').outcome).toBe('cancelled');
    expect(boardTerminalEntry('run-t4', 'blocked').outcome).toBe('failed');
  });

  test('BOARD_TERMINAL_OUTCOME 全表投影: 三格直通, 其余→failed', () => {
    const kinds: RunOutcomeKind[] = ['success', 'not-converged', 'oracle-failed', 'blocked', 'budget-exhausted', 'cancelled', 'infra-error', 'missing-capability', 'not-needed', 'empty-result', 'unclassified'];
    for (const k of kinds) {
      const want: 'converged' | 'failed' | 'cancelled' | 'not-converged' =
        k === 'success' ? 'converged' : k === 'cancelled' ? 'cancelled' : k === 'not-converged' ? 'not-converged' : 'failed';
      expect(BOARD_TERMINAL_OUTCOME[k]).toBe(want);
    }
  });
  // ── 终态 emit 的端到端面: 不只测投影表, 每个可达终态 outcome 都真 append 过 terminal ──
  // 可达 run 终态 = N5 outcome 阶梯 (run-goal.ts) 能产出的那些; stage 级 outcome
  // (missing-capability / not-needed / empty-result / unclassified) 到不了 run 终态, 由投影表测试兜底。
  // 循环路径上「conductor 说成了而判据红」落 not-converged (停止规则唯一 = 判据), oracle-failed 只在
  // rubric 分型可达 (rubric-wiring.test.ts); verifier-rejected 走 D-14 (orchestrating-loop.test.ts)。
  // 外部事件 / 资源轴那几格 accept 用 'absent' —— 引擎在那一刻没跑到它, 这是真实形状。
  const TERMINAL_CASES: {
    kind: RunOutcomeKind;
    want: 'converged' | 'failed' | 'cancelled' | 'not-converged';
    dag: () => ExecutorDagResult;
  }[] = [
    { kind: 'success', want: 'converged', dag: () => executeDag() },
    { kind: 'not-converged', want: 'not-converged', dag: () => executeDag({ accept: 'failed' }) },
    { kind: 'delivered-with-red', want: 'not-converged', dag: () => executeDag({ status: 'failed', accept: 'done' }) },
    { kind: 'cancelled', want: 'cancelled', dag: () => executeDag({ accept: 'absent', cancelled: '外部叫停' }) },
    { kind: 'blocked', want: 'failed', dag: () => executeDag({ accept: 'absent', blocked: '等 owner 拍板' }) },
    { kind: 'budget-exhausted', want: 'failed', dag: () => executeDag({ accept: 'absent', budgetStopped: '预算用尽' }) },
    { kind: 'infra-error', want: 'failed', dag: () => executeDag({ accept: 'absent', infraStopped: 'conductor 座 529' }) },
  ];
  for (const c of TERMINAL_CASES) {
    test(`终态 emit: ${c.kind} → terminal(${c.want}), 与 claimed 配对同 runId`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-s4-'));
      const r = await runGoal('做一个事', cfg({ sessionId: 'sess-s4-t' }, {
        cwd,
        _classify: cls('simple'),
        _runDag: dagRouter({ execute: async () => c.dag() }),
      }));
      expect(r.outcome).toBe(c.kind); // 先证注入面把 run 推到了这个终态, 再证终态记了账
      const term = readBoard(cwd).find((e) => e.event === 'terminal');
      expect(term?.runId).toBe('sess-s4-t');
      expect(term?.outcome).toBe(c.want);
      expect(term?.note).toBe(c.kind); // 粗态进 outcome, 细粒度留在 note (S4)
      expect(readBoard(cwd).some((e) => e.runId === 'sess-s4-t' && e.event === 'claimed')).toBe(true);
    });
  }

  test('终态 emit: execute 抛错 (bail 路) → terminal(infra-error) 也落板', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-s4-'));
    const r = await runGoal('做一个事', cfg({ sessionId: 'sess-s4-bail' }, {
      cwd,
      _classify: cls('simple'),
      _runDag: dagRouter({ execute: async () => { throw new Error('exec 引擎炸'); } }),
    }));
    expect(r.outcome).toBe('infra-error');
    const term = readBoard(cwd).find((e) => e.event === 'terminal');
    expect(term?.outcome).toBe('failed');
    expect(term?.note).toBe('infra-error');
  });

  test('删板不抹历史: board 是协调介质不是真源, RunGoalResult + 写入磁盘 goal-state 才是', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-s4-'));
    const runId = 'sess-s4-del';
    const counters = { classify: 0, contract: 0, exec: 0 };
    const mk = (): RunGoalConfig => ({
      cwd,
      dag: {
        conductorModel: 'c:m',
        leafModel: 'l:m',
        agentRunner: (async () => ({ text: 'x', usage: { in: 1, out: 1 } })) as never,
        continuity: { manager: {} as never, runId },
      } as ExecutorDagConfig,
      _today: () => '2026-08-10',
      _classify: async () => (counters.classify++, { tier: 'complex' as GoalTier, acceptance: ACC_EXEC }),
      _runDag: async (plan) => {
        if (plan.name === 'goal-contract') {
          counters.contract++;
          return contractDag({ survey: 'src/a.ts:1 — 事实', specText: '# SDD 正文契约' });
        }
        counters.exec++;
        return executeDag();
      },
    });
    const r1 = await runGoal('目标甲', mk());
    expect(r1.outcome).toBe('success');
    // 终态与写入磁盘的真源都在 —— 板只是协调介质上的指针
    expect(readBoard(cwd).some((e) => e.runId === runId && e.event === 'terminal')).toBe(true);
    const statePath = join(cwd, '.omd', 'continuity', runId, 'goal-state.json');
    expect(existsSync(statePath)).toBe(true);
    // 删板: 协调介质消失
    rmSync(join(cwd, '.omd', 'run-board.jsonl'));
    expect(readBoard(cwd)).toEqual([]);
    // 权威 run 历史不依赖板: 返回面 (RunGoalResult) 的终态结论一字未变
    expect(r1.converged).toBe(true);
    expect(r1.stages.find((s) => s.stage === 'execute')!.outcome).toBe('success');
    // 写入磁盘的 goal-state 才是续跑真源: 同 goal 同 runId 二跑 → 契约段复用 (闸 C 锚在盘上 state, 不在板)
    const contractBefore = counters.contract;
    const r2 = await runGoal('目标甲', mk());
    expect(counters.contract).toBe(contractBefore); // 0 次重跑 → 删板没抹掉可续跑的历史
    expect(r2.converged).toBe(true);
  });

  test('越闸必留账 (INV-5 后半): force → ok 且板上 note 点名撞了谁; note 不进活 run 判定', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-goal-s4-'));
    appendBoard(root, { v: 1, ts: new Date().toISOString(), runId: 'sess-other', event: 'claimed', writeSet: ['docs/a.md'] });
    // 无 force → blocked 且零越闸证据 (不许偷偷过)
    expect(ignitionPreflight(root, ['docs/a.md'], {}).verdict).toBe('blocked');
    expect(readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID)).toHaveLength(0);
    // force → ok, 但账必留: note 点名撞了哪个 run、哪些文件
    const rep = ignitionPreflight(root, ['docs/a.md'], { force: true });
    expect(rep.verdict).toBe('ok');
    const notes = readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toContain('sess-other');
    expect(notes[0]!.note).toContain('docs/a.md');
    // 账是板级证据 (BOARD_RUN_ID), 不冒充活 run: liveRuns 判定只看 claimed/terminal 对
    expect([...liveRuns(readBoard(root)).keys()]).toEqual(['sess-other']);
    // 二次独立重读账还在 (持久化, 不是单次读的瞬时态)
    expect(readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID)).toHaveLength(1);
  });
});

describe('scripts/board-publish — published 条目 CLI (零 LLM)', () => {
  test('publishEntry 追加合法 published 条目 (artifact + commit)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-board-publish-'));
    publishEntry(root, 'run-p1', 'docs/plan/x.md', 'deadbeef');
    const pub = readBoard(root).find((e) => e.event === 'published');
    expect(pub?.runId).toBe('run-p1');
    expect(pub?.artifact).toBe('docs/plan/x.md');
    expect(pub?.commit).toBe('deadbeef');
  });

  test('CLI 四参追加; 缺参 exit 2 且不写板', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-board-publish-'));
    const script = join(import.meta.dir, '..', '..', '..', 'scripts', 'board-publish.ts');
    const ok = Bun.spawnSync(['bun', 'run', script, root, 'run-p2', 'docs/plan/y.md', 'cafebabe']);
    expect(ok.exitCode).toBe(0);
    const bad = Bun.spawnSync(['bun', 'run', script, root, 'run-p2']);
    expect(bad.exitCode).toBe(2);
    const pubs = readBoard(root).filter((e) => e.event === 'published');
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.commit).toBe('cafebabe');
  });
});

// ── P4 设计审核集成 (INV-3 / INV-6 / G-4 / D-7) ──────────────────────────────
//
// 这些测试走 runGoal() 全路径 (非 maybeRunDesignReview 纯核直调), 验证接线真的通了。
// 纯核判据在 design-review.test.ts 里, 这里钉的是「runGoal → designReview 结果面」的契约。

describe('runGoal — P4 设计审核集成 (INV-3 / INV-6 / G-4 / D-7)', () => {
  /** 造一份带设计审核的 config: 注入文件列表 + 可选的审核 runner。 */
  const drCfg = (opts: {
    changedFiles: string[];
    runReview?: (diff: string, cwd: string) => Promise<{ findings: import('../profiles/review-ledger').ReviewFinding[]; usage: { in: number; out: number } }>;
    repairAttempted?: boolean;
  }): RunGoalConfig => {
    const c = cfg({}, {
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
      writeSet: { _collectChangedFiles: () => opts.changedFiles },
      designReview: {
        _runReview: opts.runReview,
        ...(opts.repairAttempted !== undefined ? { repairAttempted: opts.repairAttempted } : {}),
      },
    });
    return c;
  };

  // ── G-4 / INV-6: 调度判定 ─────────────────────────────────────────────────

  test('INV-6 / G-4: [src/a.ts] 非前端文件 → designReview.scheduled=false, usage 零', async () => {
    const r = await runGoal('做个事', drCfg({ changedFiles: ['src/a.ts'] }));
    expect(r.designReview).toBeDefined();
    expect(r.designReview!.scheduled).toBe(false);
    expect(r.designReview!.usage.in).toBe(0);
    expect(r.designReview!.usage.out).toBe(0);
    expect(r.designReview!.added).toBe(0);
    expect(r.converged).toBe(true); // 不调度不影响收敛
  });

  test('G-4: [src/App.tsx] 前端文件 → designReview.scheduled=true, 用量如实', async () => {
    const fp = fingerprintOf('src/App.tsx', '间距不对');
    const r = await runGoal('做个事', drCfg({
      changedFiles: ['src/App.tsx'],
      runReview: async () => ({
        findings: [{
          where: 'src/App.tsx',
          severity: 'p2' as const,
          evidence: '间距不对',
          suggestion: '加 gap-4',
          uncertainty: '低',
          fingerprint: fp,
        }],
        usage: { in: 120, out: 60 },
      }),
    }));
    expect(r.designReview!.scheduled).toBe(true);
    expect(r.designReview!.usage.in).toBe(120);
    expect(r.designReview!.usage.out).toBe(60);
    expect(r.designReview!.added).toBe(1);
    expect(r.designReview!.findings).toHaveLength(1);
    expect(r.designReview!.findings[0]!.fingerprint).toBe(fp);
  });

  test('G-4: 写集混有前后端 → 仅前端部分触发调度, scheduled=true', async () => {
    const fp = fingerprintOf('src/ui/Modal.tsx', '层级错');
    const r = await runGoal('做个事', drCfg({
      changedFiles: ['src/model/types.ts', 'src/ui/Modal.tsx', 'README.md'],
      runReview: async () => ({
        findings: [{ where: 'src/ui/Modal.tsx', severity: 'p2', evidence: '层级错', suggestion: 'z-50', uncertainty: '中', fingerprint: fp }],
        usage: { in: 30, out: 15 },
      }),
    }));
    expect(r.designReview!.scheduled).toBe(true);
    expect(r.designReview!.added).toBe(1);
  });

  test('INV-6: 空写集 → 不调度, usage 零, 零模型调用', async () => {
    const r = await runGoal('做个事', drCfg({ changedFiles: [] }));
    expect(r.designReview!.scheduled).toBe(false);
    expect(r.designReview!.usage.in).toBe(0);
    // D-1 零写入闸 (2026-09-05) 之后, 空写集 = 盘上零改动 ⇒ 这趟本来就不算成。
    // 本条要钉的是「设计审核不参与收敛判定」, 那句话仍然成立: 没收敛的成因是零写入闸, 不是审核。
    expect(r.converged).toBe(false);
    expect(r.terminalLabel).toBe(TERMINAL_ZERO_WRITE);
  });

  // ── INV-3: 审核失败/timeout → converged 与无审核逐位相同 ──────────────────

  test('INV-3: _runReview 抛错 → scheduled=true 但 added=0, converged 同无审核基线', async () => {
    const base = cfg({}, {
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
      writeSet: { _collectChangedFiles: () => ['src/App.tsx'] },
    });
    // 有审核但审核崩了
    const rFail = await runGoal('做个事', {
      ...base,
      designReview: { _runReview: async () => { throw new Error('审核叶崩了'); } },
    });
    // 无审核基线
    const rBase = await runGoal('做个事', { ...base });
    // INV-3: converged 结论逐位相同
    expect(rFail.converged).toBe(rBase.converged);
    expect(rFail.outcome).toBe(rBase.outcome);
    expect(rFail.rounds).toBe(rBase.rounds);
    expect(rFail.stages.at(-1)!.status).toBe(rBase.stages.at(-1)!.status);
    expect(rFail.stages.at(-1)!.outcome).toBe(rBase.stages.at(-1)!.outcome);
    // 审核本身留痕: scheduled=true 但 added=0 (抛错后闸缺席不抛)
    expect(rFail.designReview!.scheduled).toBe(true);
    expect(rFail.designReview!.added).toBe(0);
    expect(rFail.designReview!.usage.in).toBe(0);
    // 基线无审核
    expect(rBase.designReview).toBeUndefined();
  });

  test('INV-3: 审核配了但 designReview 整段缺席 → 结果面 designReview=undefined, 收敛不变', async () => {
    const r = await runGoal('做个事', cfg({}, {
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
    }));
    expect(r.designReview).toBeUndefined();
    expect(r.converged).toBe(true);
  });

  // ── D-7: 一波一修 / 同因熔断 / 存活转票 ───────────────────────────────────

  test('D-7: 首轮 findings → added≥1, fused/tickets 全空 (repairAttempted 缺省 = false)', async () => {
    const fp = fingerprintOf('src/Header.tsx', '对齐不一致');
    const r = await runGoal('做个事', drCfg({
      changedFiles: ['src/Header.tsx'],
      runReview: async () => ({
        findings: [{ where: 'src/Header.tsx', severity: 'p2', evidence: '对齐不一致', suggestion: 'flex + gap', uncertainty: '低', fingerprint: fp }],
        usage: { in: 40, out: 20 },
      }),
    }));
    expect(r.designReview!.added).toBe(1);
    expect(r.designReview!.findings).toHaveLength(1);
    expect(r.designReview!.fused).toEqual([]);
    expect(r.designReview!.tickets).toEqual([]);
  });

  test('D-7: repairAttempted=true + 同指纹 → fused (熔断), added=0, 不落账', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-dr-'));
    const fp = fingerprintOf('src/Sidebar.tsx', '色相对比不够');
    const finding = { where: 'src/Sidebar.tsx', severity: 'p2' as const, evidence: '色相对比不够', suggestion: '加深', uncertainty: '中', fingerprint: fp };
    const mk = (repairAttempted: boolean): RunGoalConfig => ({
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _today: () => '2026-07-28',
      _runDag: dagRouter({}),
      _classify: cls('simple'),
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
      writeSet: { _collectChangedFiles: () => ['src/Sidebar.tsx'] },
      designReview: {
        _runReview: async () => ({ findings: [finding], usage: { in: 10, out: 5 } }),
        repairAttempted,
      },
    });
    // 首轮: repairAttempted=false → 落账
    const r1 = await runGoal('修侧栏', mk(false));
    expect(r1.designReview!.added).toBe(1);
    expect(r1.designReview!.fused).toEqual([]);
    // 修复后: repairAttempted=true, 同指纹 → fused, 不落账
    const r2 = await runGoal('修侧栏', mk(true));
    expect(r2.designReview!.added).toBe(0);
    expect(r2.designReview!.fused).toHaveLength(1);
    expect(r2.designReview!.fused[0]!.fingerprint).toBe(fp);
    expect(r2.designReview!.tickets).toEqual([]); // 同指纹归 fused, 不是 tickets
  });

  test('D-7: repairAttempted=true + 新指纹 (台账无记录) → tickets (存活转票), added=0', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-dr-'));
    const fpOld = fingerprintOf('src/Nav.tsx', '旧问题');
    const fpNew = fingerprintOf('src/Nav.tsx', '新问题');
    const mk = (fps: string[], repairAttempted: boolean): RunGoalConfig => ({
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _today: () => '2026-07-28',
      _runDag: dagRouter({}),
      _classify: cls('simple'),
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
      writeSet: { _collectChangedFiles: () => ['src/Nav.tsx'] },
      designReview: {
        _runReview: async () => ({
          findings: fps.map((fp) => ({ where: 'src/Nav.tsx', severity: 'p2' as const, evidence: fp === fpOld ? '旧问题' : '新问题', suggestion: '改', uncertainty: '低', fingerprint: fp })),
          usage: { in: 10, out: 5 },
        }),
        repairAttempted,
      },
    });
    // 首轮: 落账旧指纹
    const r1 = await runGoal('修导航', mk([fpOld], false));
    expect(r1.designReview!.added).toBe(1);
    // 修复后: 报新指纹 → tickets (台账里没有 = 修复后的新发现物)
    const r2 = await runGoal('修导航', mk([fpNew], true));
    expect(r2.designReview!.added).toBe(0);
    expect(r2.designReview!.fused).toEqual([]);
    expect(r2.designReview!.tickets).toHaveLength(1);
    expect(r2.designReview!.tickets[0]!.fingerprint).toBe(fpNew);
  });

  test('D-7: 同批内重复指纹 → 首轮去重 (deduped≥1), 不产生多轮修复', async () => {
    const fp = fingerprintOf('src/Footer.tsx', '版权年份');
    const r = await runGoal('做个事', drCfg({
      changedFiles: ['src/Footer.tsx'],
      runReview: async () => ({
        findings: [
          { where: 'src/Footer.tsx', severity: 'p2', evidence: '版权年份', suggestion: '改 2026', uncertainty: '低', fingerprint: fp },
          { where: 'src/Footer.tsx', severity: 'p2', evidence: '版权年份', suggestion: '改 2026', uncertainty: '低', fingerprint: fp }, // 同指纹
        ],
        usage: { in: 10, out: 5 },
      }),
    }));
    expect(r.designReview!.added).toBe(1); // 只落一条
    expect(r.designReview!.deduped).toBeGreaterThanOrEqual(1); // 第二条被去重
    expect(r.designReview!.fused).toEqual([]);
    expect(r.designReview!.tickets).toEqual([]);
  });
});

// ── 实验臂 contract-distill —— 撤销 (D-26/D-27, 2026-09-02) ────────────────────
//
// 原来测的是「契约段 (`goal-contract` conductor 节点) 的 dagCfg.faninSummary.minFanout 按
// `.omd/experiments.json` 的 `contractFaninDistill` 收紧」。契约段自动展开 (无 sddPath 时的
// 那条路) 整体撤销之后, 这个只挂在该节点上的实验臂**没有宿主可挂**了 (`readExperimentFlags` /
// `contractFaninDistill` 因此成了本次改动之外的一个空旋钮, 留给 owner 另立票清理, 不在本片动手)。

// ── #165① accept 被红级联压死 → 冻结判据收尾复验 (delivered-with-red) ──────────────
describe('#165① delivered-with-red: accept 没跑而判据复验绿', () => {
  // 证伪方式 (当场验过): 删掉 run-goal 里 oracleRecheckGreen 复验块 → 第一条红 (退回 not-converged); 恢复后绿。
  test('accept absent (级联压死) ∧ 复验 exit 0 → outcome=delivered-with-red, converged 仍 false (红节点不漂白)', async () => {
    const r = await runGoal('goal', {
      ...cfg({ commandRunner: cmdRunner(0) }),
      _classify: cls('complex'),
      _runDag: dagRouter({ execute: async () => executeDag({ accept: 'absent', status: 'failed' }) }),
    });
    expect(r.outcome).toBe('delivered-with-red');
    expect(r.converged).toBe(false);
    const exec = r.stages.find((s) => s.stage === 'execute')!;
    expect(exec.status).toBe('failed');
    expect(exec.summary).toContain('交付达标但有节点红');
  });

  test('accept absent ∧ 复验 exit 1 → 维持原判 (not-converged), 不编绿', async () => {
    const r = await runGoal('goal', {
      ...cfg({ commandRunner: cmdRunner(1) }),
      _classify: cls('complex'),
      _runDag: dagRouter({ execute: async () => executeDag({ accept: 'absent', status: 'failed' }) }),
    });
    expect(r.outcome).toBe('not-converged');
  });

  test('accept 真跑真红 → 不复验 (交付没达标如实报 not-converged, 抖动那半归 S-37)', async () => {
    // commandRunner 给 0: 若实现错把「真红」也拿去复验, 会误判 delivered-with-red —— 本断言即闸。
    const r = await runGoal('goal', {
      ...cfg({ commandRunner: cmdRunner(0) }),
      _classify: cls('complex'),
      _runDag: dagRouter({ execute: async () => executeDag({ accept: 'failed' }) }),
    });
    expect(r.outcome).toBe('not-converged');
    expect(r.criteria?.oracle).toBe(false);
  });

  test('无 commandRunner → 不复验, 行为与今天一致', async () => {
    const r = await runGoal('goal', {
      ...cfg(),
      _classify: cls('complex'),
      _runDag: dagRouter({ execute: async () => executeDag({ accept: 'absent', status: 'failed' }) }),
    });
    expect(r.outcome).toBe('not-converged');
  });
});
