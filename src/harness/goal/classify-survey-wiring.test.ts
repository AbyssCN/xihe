/**
 * src/harness/goal/classify-survey-wiring.test —— 勘察先于分类, 切片 3 的契约测试
 * (契约 `docs/plan/2026-09-05-勘察先于分类-执行契约.md` §不变量 INV-8)。
 *
 * 三件事一起钉:
 *  · 勘察**只在走真 `classifyGoal` 时跑** —— 注入 `_classify` 的既有测试一个字都不受影响;
 *  · 走真分类路径时, 勘察读数出现在 `stages[classify].summary` 上 (人第一眼看的就是这一行);
 *  · 读数进 `r.loop.criterionSurvey` —— 顶层字段出不了 bench 容器 (`resultOut` 只序列化 `r.loop`,
 *    `runs/2026-09-04-criterion-direction-result.md` §① 的教训: 读不到的读数等于没有这个读数)。
 *
 * **反向自检**:
 *  · 接线处不把 `text` 传进 `classifyGoal` ⇒ 「分类那一发看得见 SURVEY_HEADER」那条红 (契约 §证伪 第 3 条);
 *  · 不写 `criterionSurvey` 进 loop ledger ⇒ 「读数进 loop」那条红;
 *  · 把勘察挪到 `_classify` 分支之外 (无条件跑) ⇒ 「注入式分类器零勘察」那条红。
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal } from './run-goal';
import type { GoalClassification } from './classify-acceptance';
import { SURVEY_HEADER } from './criterion-survey';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult, GenerateFn } from '../dag/types';

/** 与 classify-route-once.test.ts 同款假图: conductor + 环外 accept 都判 done。 */
const executeDag = (): ExecutorDagResult =>
  ({
    plan: { name: 'goal-orchestrating-loop', nodes: {} },
    results: {
      accept: { id: 'accept', status: 'done', kind: 'command', output: '', deps: ['conductor'], usage: { in: 0, out: 0 }, timedOut: false, signal: null },
      conductor: { id: 'conductor', status: 'done', kind: 'agent', output: 'ok', deps: [], usage: { in: 1, out: 1 } },
    },
    reusedNodes: [],
  }) as unknown as ExecutorDagResult;

/** 真仓 (不 mock fs): README 写死键名 + 一个既有测试文件 —— 正是勘察该看见的两样东西。 */
function repoWithContract(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-survey-wiring-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# ab test\n\n输出必须含 conversion_lift 与 winner 两个键。\n');
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'tests', 'test_x.py'), 'def test_x():\n    assert 1\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

describe('INV-8 —— 勘察接线: 只在真分类路径上跑, 读数进摘要与 loop 账本', () => {
  test('★ 走真 classifyGoal ⇒ 勘察原文进那一发, 读数进 summary 与 r.loop.criterionSurvey', async () => {
    const cwd = repoWithContract();
    const prompts: string[] = [];
    const generate: GenerateFn = async (req) => {
      prompts.push(String(req.messages[0]?.content ?? ''));
      // 这个临时仓实测是 python (只有 tests/test_x.py), 给一条同族的命令, 免得判据轴被语言闸拒掉 ——
      // 那一支与本用例要测的接线无关。
      return { text: '{"tier":"simple","acceptance_kind":"executable","command":"python3 -m pytest -q tests/test_x.py"}', usage: { in: 1, out: 1 } };
    };

    const r = await runGoal('让输出带上 conversion_lift', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', generate } as unknown as ExecutorDagConfig,
      _runDag: async (plan: ConductorPlan) => {
        expect(plan.name).toBe('goal-orchestrating-loop');
        return executeDag();
      },
    });

    // 证伪: 接线处不传 `survey` ⇒ 本行红 (契约 §证伪 第 3 条)。
    expect(prompts[0]).toContain(SURVEY_HEADER);
    expect(prompts[0]).toContain('输出必须含 conversion_lift 与 winner 两个键。');

    const classify = r.stages.find((s) => s.stage === 'classify');
    // 证伪: 摘要里不追加勘察那一段 ⇒ 本行红。
    expect(classify?.summary ?? '').toContain('勘察: README 是 · 测试文件 1');

    // 证伪: 不把 facts 写进 loop ledger ⇒ 下面三行红 (顶层字段出不了 bench 容器)。
    expect(r.loop?.criterionSurvey).toBeDefined();
    expect(r.loop?.criterionSurvey?.readme).toBe(true);
    expect(r.loop?.criterionSurvey?.testFiles).toBe(1);
    expect((r.loop?.criterionSurvey?.chars ?? 0) > 0).toBe(true);
  });

  test('★ 注入 `_classify` ⇒ 一次勘察都不跑 (既有测试零影响); 读数缺席 ≠ 全 0', async () => {
    const cwd = repoWithContract();

    const r = await runGoal('让输出带上 conversion_lift', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _classify: async (): Promise<GoalClassification> => ({
        tier: 'simple',
        acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
        route: { kind: 'none' },
      }),
      _runDag: async () => executeDag(),
    });

    const classify = r.stages.find((s) => s.stage === 'classify');
    expect(classify?.summary ?? '').not.toContain('勘察');
    // 缺席 = 没跑勘察; 与「跑了三段全空」(全 0) 是两件事 (仓规静默坑 1)。
    expect(r.loop?.criterionSurvey).toBeUndefined();
  });
});
