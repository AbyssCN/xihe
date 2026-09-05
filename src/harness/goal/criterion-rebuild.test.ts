/**
 * INV-4 判据重建边 —— 契约 `docs/plan/2026-08-29-veto-feedback-revision-edges.md` D-4 / GWT-4。
 *
 * ## 它治的那个病 (归因样本 A 桶 6/12)
 *
 * leaf 多数把活干对了, 判据命令却写错了路径/错目录 —— 而**没有任何人有权改判据**
 * (D-I 把它冻在环外, 防的是执行体移球门)。于是修复轮一轮轮烧, 每轮读到**逐字相同**的
 * exitCode, 直到预算耗尽。#1 (改动落对文件、判据 grep 错目录)、#4 (四轮同 exitCode)。
 *
 * ## 边界 (诚实标注, 别把它读成"判据已经会自己修好了")
 *
 * 重建出来的判据**不参与本 run 的终态判定** —— 让执行体家族提的判据当场决定自己的成败,
 * 正是 D-J 整套防作弊要杀的形态。这一条**至今成立, 且是下面回写那一组的承重断言**。
 *
 * ## 2026-08-30 (owner 裁): 回写接上了 —— 采纳的候选**冻进下一轮**
 *
 * 头注原来写「『重建判据当场冻结进下一轮』要等内环把重建轮接进来」。现在接了, 但**不是**
 * 接进内环: 采纳的候选写进 `goal-state.json` 的 `classified.acceptance`, 于是**同一个 goal
 * 的下一次跑/续跑**(按 goalHash 匹配那条 prior 路径)才用新判据。本轮终态一个字节不受影响。
 *
 * 三重护栏(见 run-goal.ts 回写处的注): ① 只写 `admitted`(两道自证门都真跑过且都过,
 * 含空世界自检判红)· ② 只对 `executable` 分型 · ③ **审计轨 `criterionHistory` 必写**
 * —— 球门动了而看不出来 = 静默降分。
 *
 * ## 反向自检 (每条新分支当场证伪过一次)
 *
 *  · `shouldRebuildCriterion` 去掉 `alreadyRebuilt` 那一支 ⇒ 「第二次触发不再重建」当场红;
 *  · 去掉「两轮都要有非空 diff」那一条 ⇒ 「同 exitCode 但 leaf 空手」当场红;
 *  · `criterionRebuildAdmission` 把 `ran===false` 当放行 ⇒ 「门没跑成不准冻结」当场红;
 *  · 接线里去掉留痕串 ⇒ 「摘要含 criterion-rebuild」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGoal,
  shouldRebuildCriterion,
  criterionRebuildAdmission,
  CRITERION_REBUILD_LABEL,
  type RunGoalConfig,
} from './run-goal';
import type { GoalClassification } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { VerifierVerdict } from '../verifier';

// ── 纯核 ①: 触发谓词 ────────────────────────────────────────────────────────

const twoSameRounds = [
  { exitCode: 4, touched: 3 },
  { exitCode: 4, touched: 2 },
] as const;

describe('INV-4 纯核: shouldRebuildCriterion —— 两条触发路 + 一次上限', () => {
  test('★ 路 ①: 否决分型指向判据 ⇒ 重建 (哪怕只跑过一轮)', () => {
    const d = shouldRebuildCriterion({ verdictTarget: 'criterion', rounds: [{ exitCode: 1, touched: 0 }], alreadyRebuilt: false });
    expect(d.rebuild).toBe(true);
    expect(d.reason).toContain('criterion');
  });

  test('★ 路 ②: 连续 2 轮 exitCode 逐字相同且两轮 leaf 都有非空 diff ⇒ 重建', () => {
    const d = shouldRebuildCriterion({ verdictTarget: 'implementation', rounds: [...twoSameRounds], alreadyRebuilt: false });
    expect(d.rebuild).toBe(true);
    expect(d.reason).toContain('exitCode');
  });

  test('★ 判别力: 同 exitCode 但有一轮 leaf 空手 ⇒ 不重建 (那是执行侧没动, 不是判据瞎)', () => {
    const d = shouldRebuildCriterion({
      verdictTarget: 'implementation',
      rounds: [
        { exitCode: 4, touched: 3 },
        { exitCode: 4, touched: 0 },
      ],
      alreadyRebuilt: false,
    });
    expect(d.rebuild).toBe(false);
  });

  test('★ 判别力: exitCode 变了 ⇒ 不重建 (判据在动, 它量得出差别)', () => {
    const d = shouldRebuildCriterion({
      verdictTarget: 'implementation',
      rounds: [
        { exitCode: 4, touched: 3 },
        { exitCode: 1, touched: 3 },
      ],
      alreadyRebuilt: false,
    });
    expect(d.rebuild).toBe(false);
  });

  test('★ 判别力: exitCode 缺席 (null/undefined) 不算「逐字相同」—— NULL ≠ 0 ≠ 不适用', () => {
    expect(
      shouldRebuildCriterion({
        rounds: [
          { exitCode: null, touched: 3 },
          { exitCode: null, touched: 3 },
        ],
        alreadyRebuilt: false,
      }).rebuild,
    ).toBe(false);
    expect(
      shouldRebuildCriterion({
        rounds: [
          { exitCode: undefined, touched: 3 },
          { exitCode: undefined, touched: 3 },
        ],
        alreadyRebuilt: false,
      }).rebuild,
    ).toBe(false);
  });

  test('★ GWT-4 后半: 第二次触发时不再重建 (每 run 至多 1 次)', () => {
    const d = shouldRebuildCriterion({ verdictTarget: 'criterion', rounds: [...twoSameRounds], alreadyRebuilt: true });
    expect(d.rebuild).toBe(false);
    expect(d.reason).toContain('已重建');
  });

  test('一轮都没跑过 / 只跑了一轮 ⇒ 不重建 (没有"连续两轮"这回事)', () => {
    expect(shouldRebuildCriterion({ rounds: [], alreadyRebuilt: false }).rebuild).toBe(false);
    expect(shouldRebuildCriterion({ rounds: [{ exitCode: 4, touched: 3 }], alreadyRebuilt: false }).rebuild).toBe(false);
  });
});

// ── 路 ③: #205 方向性探针 green-before (2026-09-05, 契约 D-5) ────────────────────
//
// 同批读数: `green-before` (判据在改动前就绿) 7 题 reward 均值 0.212, 全批 0.610, 假阳性 1/7。
// 它此前只记账不动作; 现在升成**重建触发**, 仍不判失败、不拦派发 —— 判据在改动前就绿, 说明它量的
// 不是本次目标, 该去改判据而不是再烧修复轮。
describe('INV-5 (2026-09-05): criterionDirection green-before ⇒ 重建', () => {
  test('★ green-before 单独就够触发 (一轮都没跑过也算)', () => {
    const d = shouldRebuildCriterion({ criterionDirection: 'green-before', rounds: [], alreadyRebuilt: false });
    // 证伪: `shouldRebuildCriterion` 不读 `criterionDirection` → rebuild===false, 本条红。
    expect(d.rebuild).toBe(true);
    expect(d.reason).toContain('green-before');
  });

  test('★ 判别力: red-before / inconclusive / 缺席 ⇒ 落回既有规则 (不因方向性触发)', () => {
    for (const dir of ['red-before', 'inconclusive', undefined] as const) {
      const d = shouldRebuildCriterion({
        ...(dir ? { criterionDirection: dir } : {}),
        rounds: [{ exitCode: 4, touched: 3 }],
        alreadyRebuilt: false,
      });
      expect(d.rebuild).toBe(false);
    }
  });

  test('★ 优先级: alreadyRebuilt 仍压过一切; target=criterion 的 reason 仍是既有原文 (排在 direction 之前)', () => {
    expect(shouldRebuildCriterion({ criterionDirection: 'green-before', rounds: [], alreadyRebuilt: true }).rebuild).toBe(false);
    const d = shouldRebuildCriterion({ verdictTarget: 'criterion', criterionDirection: 'green-before', rounds: [], alreadyRebuilt: false });
    // 证伪: 把 direction 那一支排到 verdictTarget 之前 → reason 变成 green-before 那条, 本条红。
    expect(d.reason).toContain('target=criterion');
  });
});

// ── 纯核 ②: 自证门准入 ──────────────────────────────────────────────────────

describe('INV-4 纯核: criterionRebuildAdmission —— 全过才准冻结 (fail-closed)', () => {
  test('全部门都跑了且都放行 ⇒ 准入', () => {
    const a = criterionRebuildAdmission([
      { name: '命令闸', ran: true, reason: null },
      { name: '空世界自检', ran: true, reason: null },
    ]);
    expect(a.admitted).toBe(true);
  });

  test('★ 判别力: 任一门拒 ⇒ 不准入, 拒因原文进 why', () => {
    const a = criterionRebuildAdmission([
      { name: '命令闸', ran: true, reason: '[blocked missing-path-arg: 路径参数不存在 …]' },
      { name: '空世界自检', ran: true, reason: null },
    ]);
    expect(a.admitted).toBe(false);
    expect(a.why).toContain('路径参数不存在');
  });

  test('★ 判别力: 门没跑成 ⇒ 不准入 (拿不到证明就不准冻结, 不是 fail-open)', () => {
    const a = criterionRebuildAdmission([
      { name: '命令闸', ran: true, reason: null },
      { name: '空世界自检', ran: false, reason: null },
    ]);
    expect(a.admitted).toBe(false);
    expect(a.why).toContain('没跑成');
  });

  test('一道门都没有 ⇒ 不准入 (空集不算"全过")', () => {
    expect(criterionRebuildAdmission([]).admitted).toBe(false);
  });
});

// ── 接线面 ──────────────────────────────────────────────────────────────────

const leaf = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 'x',
  status: 'done',
  kind: 'agent',
  output: '',
  deps: [],
  usage: { in: 1, out: 1 },
  ...over,
});

/**
 * 终审否决分型 target=criterion 的一次 run —— 循环路径上判据重建**唯一可达**的触发路
 * (P3 S6b: maxEscalations 0 ⇒ 每跑只有一次判卷, 「两轮 exitCode 纹丝不动」那条路只在纯核可测;
 * 生产读数里 target=criterion 正是终审打回的多数形状, 见 2026-09-02-next-session.md)。
 * criterion 否决不回灌 (D-14: 判据错了, 再派也没用), 终态 verifier-rejected。
 */
const rebuildRun = async (over: Partial<RunGoalConfig> = {}): Promise<Awaited<ReturnType<typeof runGoal>>> => {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-criterion-rebuild-'));
  writeFileSync(join(cwd, 'out.txt'), 'OK\n');
  return rebuildRunIn(cwd, undefined, over);
};

/**
 * 同 `rebuildRun`, 但由调用方给 cwd 与 continuity runId ——
 * 回写那一组要读 `goal-state.json`, 而没有 runId 时 statePath 是 undefined、saveState 空转。
 */
const rebuildRunIn = async (
  cwd: string,
  continuityRunId: string | undefined,
  over: Partial<RunGoalConfig> = {},
): Promise<Awaited<ReturnType<typeof runGoal>>> => {
  const verifier = (async (): Promise<VerifierVerdict> => ({
    pass: false,
    reason: '判据命令指向仓里不存在的目录',
    target: 'criterion',
    usage: { in: 0, out: 0 },
  })) as ExecutorDagConfig['verifier'];
  return runGoal('做一件事', {
    cwd,
    dag: {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      verifier,
      // 空世界自检要跑得起来才可能准入 —— 这条 runner 在"活还没干"的世界里判红 (exit 1),
      // 于是重建出的判据不是恒绿的。
      commandRunner: (async () => ({ exitCode: 1, text: '' })) as never,
      ...(continuityRunId ? { continuity: { runId: continuityRunId } } : {}),
    } as ExecutorDagConfig,
    _today: () => '2026-08-29',
    _classify: (async (): Promise<GoalClassification> => ({
      tier: 'simple',
      acceptance: { kind: 'executable', command: 'grep -q OK missing-dir/out.txt', expectExit: 0 },
    })) as RunGoalConfig['_classify'],
    _rebuildCriterion: (async () => ({ command: 'grep -q OK out.txt', expectExit: 0 })) as RunGoalConfig['_rebuildCriterion'],
    _runDag: (async (plan: ConductorPlan, dagCfg: ExecutorDagConfig): Promise<ExecutorDagResult> => {
      const results = {
        conductor: leaf({ id: 'conductor', filesTouched: [join(cwd, 'out.txt')], artifactRoot: cwd }),
        accept: leaf({ id: 'accept', kind: 'command', status: 'failed', exitCode: 4 }),
      };
      // 循环路径每跑判卷恰一次; criterion 否决之后不回灌, 所以这个 fake 只会被调一次 (带 verifier)。
      if (dagCfg.verifier) await dagCfg.verifier({ task: '', plan, results: results as never });
      return { plan, results, reusedNodes: [] } as unknown as ExecutorDagResult;
    }) as never,
    ...over,
  });
};

describe('INV-4 接线 (GWT-4): 终审否决 target=criterion ⇒ 走判据重建分支', () => {
  test('★ 留痕含 criterion-rebuild (result 与摘要两面都要看得见)', async () => {
    const r = await rebuildRun();
    expect(r.criterionRebuild).toBeDefined();
    expect(r.criterionRebuild!.trigger).toContain('criterion');
    expect(r.outcome).toBe('verifier-rejected'); // criterion 否决不回灌 (D-14)
    expect(r.stages.at(-1)!.summary).toContain(CRITERION_REBUILD_LABEL);
  });

  test('★ 重建出的判据过了全部自证门才记 admitted, 且原文带出来', async () => {
    const r = await rebuildRun();
    expect(r.criterionRebuild!.proposed).toBe('grep -q OK out.txt');
    expect(r.criterionRebuild!.admitted).toBe(true);
  });

  test('★ 判别力: 重建出的判据过不了门 (路径参数不存在) ⇒ 不准入, 拒因原文进 result', async () => {
    const r = await rebuildRun({
      _rebuildCriterion: (async () => ({ command: 'grep -q OK nowhere/out.ts', expectExit: 0 })) as RunGoalConfig['_rebuildCriterion'],
    });
    expect(r.criterionRebuild!.admitted).toBe(false);
    expect(r.criterionRebuild!.why).toContain('路径参数不存在');
  });

  test('★ 判别力: 重建者缺席 (没注入 / 无 agentRunner) ⇒ 触发照记, 但不假装重建过', async () => {
    const r = await rebuildRun({ _rebuildCriterion: undefined });
    expect(r.criterionRebuild).toBeDefined();
    expect(r.criterionRebuild!.proposed).toBeUndefined();
    expect(r.criterionRebuild!.admitted).toBe(false);
    expect(r.criterionRebuild!.why).toContain('重建者缺席');
  });

  test('★ 判别力: 否决分型指向实装 (target=implementation) 且只有一次判卷 ⇒ 整段不触发', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-criterion-norebuild-'));
    const verifier = (async (): Promise<VerifierVerdict> => ({
      pass: false,
      reason: '实装没满足要求',
      target: 'implementation',
      usage: { in: 0, out: 0 },
    })) as ExecutorDagConfig['verifier'];
    const r = await runGoal('做一件事', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier } as ExecutorDagConfig,
      _today: () => '2026-08-29',
      _classify: (async (): Promise<GoalClassification> => ({
        tier: 'simple',
        acceptance: { kind: 'executable', command: 'grep -q OK out.txt', expectExit: 0 },
      })) as RunGoalConfig['_classify'],
      _rebuildCriterion: (async () => ({ command: 'grep -q OK out.txt' })) as RunGoalConfig['_rebuildCriterion'],
      _runDag: (async (plan: ConductorPlan, dagCfg: ExecutorDagConfig): Promise<ExecutorDagResult> => {
        const results = {
          conductor: leaf({ id: 'conductor', filesTouched: [join(cwd, 'out.txt')], artifactRoot: cwd }),
          accept: leaf({ id: 'accept', kind: 'command', status: 'failed', exitCode: 4 }),
        };
        // implementation 否决 → D-14 回灌 → 第二跑不带 verifier: 判据观察仍只有一轮, 「两轮纹丝不动」凑不齐。
        if (dagCfg.verifier) await dagCfg.verifier({ task: '', plan, results: results as never });
        return { plan, results, reusedNodes: [] } as unknown as ExecutorDagResult;
      }) as never,
    });
    expect(r.criterionRebuild).toBeUndefined();
    expect(r.stages.at(-1)!.summary).not.toContain(CRITERION_REBUILD_LABEL);
  });
});

// ── INV-4 回写 (2026-08-30): 采纳的候选冻进下一轮 ───────────────────────────────
//
// 反向自检 (逐条当场实跑过):
//  · 去掉 run-goal 回写那整段 ⇒ W-1 / W-2 红 (盘上判据没换、审计轨为空);
//  · 把 `admission.admitted &&` 去掉 ⇒ W-3 红 (没过门的候选也被写进去了);
//  · 把 `classified.acceptance.kind === 'executable'` 去掉 ⇒ W-4 红;
//  · 把合并底从 `lastSaved ?? prior` 改回 `prior` ⇒ W-5 红 (契约段存的 contract 被冲掉)。
describe('INV-4 回写: 采纳的判据冻进下一轮 (本轮终态不动)', () => {
  const stateOf = (cwd: string, runId: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(cwd, '.omd', 'continuity', runId, 'goal-state.json'), 'utf8')) as Record<string, unknown>;

  /** 带 continuity.runId 的一次 rebuildRun —— 没有它 statePath 是 undefined, saveState 空转。 */
  const runWithState = async (over: Partial<RunGoalConfig> = {}) => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-criterion-writeback-'));
    writeFileSync(join(cwd, 'out.txt'), 'OK\n');
    const runId = 'wb-run';
    const r = await rebuildRunIn(cwd, runId, over);
    return { cwd, runId, r };
  };

  test('★ W-1: 采纳 ⇒ 盘上的 acceptance.command 换成新判据, 且审计轨记下 from/to/trigger', async () => {
    const { cwd, runId, r } = await runWithState();
    expect(r.criterionRebuild!.admitted).toBe(true);
    const st = stateOf(cwd, runId) as { classified: { acceptance: { command: string } }; criterionHistory: { from: string; to: string; trigger: string }[] };
    expect(st.classified.acceptance.command).toBe('grep -q OK out.txt');
    expect(st.criterionHistory).toHaveLength(1);
    expect(st.criterionHistory[0]!.from).toBe('grep -q OK missing-dir/out.txt');
    expect(st.criterionHistory[0]!.to).toBe('grep -q OK out.txt');
    expect(st.criterionHistory[0]!.trigger).toContain('criterion');
  });

  test('★ W-2 (承重): **本轮终态不受影响** —— 换判据不许把这一轮判绿', async () => {
    const { r } = await runWithState();
    // 这一跑本来就是没收敛的 (verifier 判 fail target=criterion, accept 节点 exitCode 4)。
    // 回写若泄进本轮判定, 这里会翻绿 —— 那正是"环内产出的判据给环内产出的东西打分"。
    expect(r.converged).toBe(false);
  });

  test('★ W-3: 没过自证门的候选 ⇒ 一个字都不写回 (审计轨也不动)', async () => {
    const { cwd, runId, r } = await runWithState({
      _rebuildCriterion: (async () => ({ command: 'grep -q OK nowhere/out.ts', expectExit: 0 })) as RunGoalConfig['_rebuildCriterion'],
    });
    expect(r.criterionRebuild!.admitted).toBe(false);
    const st = stateOf(cwd, runId) as { classified: { acceptance: { command: string } }; criterionHistory?: unknown[] };
    expect(st.classified.acceptance.command).toBe('grep -q OK missing-dir/out.txt'); // 原样
    expect(st.criterionHistory ?? []).toHaveLength(0);
  });

  // ⚠ W-4 的**诚实版**。第一版写成「非 executable 分型 ⇒ 不回写」并声称它守着代码里那个
  // `classified.acceptance.kind === 'executable'` 守卫 —— **证伪时发现它是恒绿的**:
  // 把那个守卫整个去掉, 本条照样绿(20 pass / 0 fail)。
  //
  // 真正的原因是: 非 executable 分型下**重建触发根本不会发生**(没有 `runnable.command`,
  // 整个重建块进不去), 所以走不走那个守卫都一样。
  // ⇒ 代码里那个 `executable` 守卫是**纵深防御**, 今天的测试证伪不了它;
  //   照实说, 不假装它被守着(仓规: 一条永远绿的闸不是闸)。
  // 本条改成钉那个**真的机制**: 非 executable ⇒ 连 criterionRebuild 都不产生。
  test('★ W-4: 非 executable 分型 ⇒ 重建块整个进不去 (连 criterionRebuild 都没有) ⇒ 自然无回写', async () => {
    const { cwd, runId, r } = await runWithState({
      _classify: (async (): Promise<GoalClassification> => ({
        tier: 'simple',
        acceptance: { kind: 'exploratory', learningGoal: '看看能不能做', affordableLoss: '一轮' },
      })) as unknown as RunGoalConfig['_classify'],
    });
    expect(r.criterionRebuild, '非 executable 不该走到重建').toBeUndefined();
    const st = stateOf(cwd, runId) as { classified: { acceptance: { kind: string } }; criterionHistory?: unknown[] };
    expect(st.classified.acceptance.kind).toBe('exploratory');
    expect(st.criterionHistory ?? []).toHaveLength(0);
  });
});
