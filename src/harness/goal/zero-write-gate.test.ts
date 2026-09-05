/**
 * D-1 零写入闸 (契约 `docs/plan/2026-09-05-假success三闸-执行契约.md` 切片 1)。
 *
 * 前半是纯逻辑 (INV-1), 后半是 run-goal 接线的端到端 (INV-2) —— 两半都要, 因为闸真正
 * 值钱的那一跳是「收敛判定成立时把 converged 压成 false」, 那一跳只活在接线处。
 *
 * ## 证伪 (每条真跑过一次)
 * · 去掉 run-goal.ts 里 D-1 的 `converged = ... && !zeroWrite.block` 压制 ⇒ ★INV-2 当场红
 *   (outcome 回到 success, execute 段回到 done)。
 * · 把 `zeroWriteVerdict` 的 resume 豁免删掉 ⇒ 「resume 不拦」那条红。
 * · 把 `error` 那一格判成 block ⇒ 「取不到证据不等于零写入」那条红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERMINAL_ZERO_WRITE, zeroWriteVerdict } from './zero-write-gate';
import { runGoal, type RunGoalConfig } from './run-goal';
import type { GoalClassification } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';

describe('zeroWriteVerdict — INV-1 纯逻辑四格', () => {
  test('★ 收敛 + 首跑 + 盘上零改动 ⇒ block (这一格是整条闸存在的理由)', () => {
    const v = zeroWriteVerdict({ converged: true, isResume: false, changed: { files: [] } });
    expect(v.block).toBe(true);
    expect(v.checked).toBe(true);
    expect(v.zero).toBe(true);
    expect(v.why).toContain('git status 空');
  });

  test('盘上有改动 ⇒ 不拦, 且如实记 zero=false (查过了, 不是没查)', () => {
    const v = zeroWriteVerdict({ converged: true, isResume: false, changed: { files: ['src/a.ts'] } });
    expect(v.block).toBe(false);
    expect(v.checked).toBe(true);
    expect(v.zero).toBe(false);
  });

  test('resume ⇒ 不查不拦 (续跑前的活可能已被 #165② 收编进 commit, 工作树干净不等于没干)', () => {
    const v = zeroWriteVerdict({ converged: true, isResume: true, changed: { files: [] } });
    expect(v.checked).toBe(false);
    expect(v.block).toBe(false);
    expect(v.zero).toBeUndefined();
    expect(v.why).toBe('resume');
  });

  test('git 取不到 ⇒ 不拦, 但错误原文留在 why (取不到证据 ≠ 零写入; 仓规静默坑 ②)', () => {
    const v = zeroWriteVerdict({ converged: true, isResume: false, changed: { error: '不是 git 仓' } });
    expect(v.checked).toBe(false);
    expect(v.block).toBe(false);
    expect(v.why).toContain('不是 git 仓');
  });

  test('没收敛 ⇒ 闸不适用 (它只问「说成了的那些跑到底动没动盘」)', () => {
    const v = zeroWriteVerdict({ converged: false, isResume: false, changed: { files: [] } });
    expect(v.block).toBe(false);
    expect(v.checked).toBe(false);
  });
});

// ── INV-2 接线 e2e ───────────────────────────────────────────────────────────────
//
// 造一份「冻结判据绿 + conductor 跑完」的执行段结果 —— 改前这份输入的终态逐字是 success。
function executeDag(): ExecutorDagResult {
  return {
    plan: { name: 'goal-orchestrating-loop', nodes: {} },
    results: {
      accept: {
        id: 'accept', status: 'done', kind: 'command', output: '',
        deps: ['conductor'], usage: { in: 0, out: 0 }, timedOut: false, signal: null,
      },
      conductor: {
        id: 'conductor', status: 'done', kind: 'agent', output: '[conductor 派工 2 次, 均成功]',
        deps: [], usage: { in: 1, out: 1 }, filesTouched: [],
      },
    },
    reusedNodes: [],
  } as unknown as ExecutorDagResult;
}

const cls = async (): Promise<GoalClassification> => ({
  tier: 'simple',
  acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
});

function cfg(diff: string[] | Error): RunGoalConfig {
  return {
    cwd: mkdtempSync(join(tmpdir(), 'omd-zero-write-')),
    dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
    _today: () => '2026-09-05',
    _classify: cls,
    _runDag: (async (_plan: ConductorPlan) => executeDag()) as never,
    writeSet: {
      _collectChangedFiles: () => {
        if (diff instanceof Error) throw diff;
        return diff;
      },
    },
  };
}

describe('runGoal × 零写入闸 — INV-2 接线', () => {
  test('★ 判据绿而盘上零改动 ⇒ 不算收敛, outcome=not-converged, terminal=zero-write', async () => {
    const r = await runGoal('写点东西', cfg([]));
    expect(r.converged).toBe(false);
    expect(r.outcome).toBe('not-converged');
    expect(r.terminalLabel).toBe(TERMINAL_ZERO_WRITE);
    expect(r.zeroWrite).toEqual({ checked: true, zero: true, why: '收敛判定成立但盘上没有任何改动 (git status 空)' });
    const execute = r.stages.find((s) => s.stage === 'execute')!;
    expect(execute.status).toBe('failed');
    expect(execute.summary).toContain('零写入');
  });

  test('对照臂: 同一份判据绿而盘上有改动 ⇒ 照旧 success, zeroWrite 记 zero=false', async () => {
    const r = await runGoal('写点东西', cfg(['src/a.ts']));
    expect(r.converged).toBe(true);
    expect(r.outcome).toBe('success');
    expect(r.zeroWrite).toEqual({ checked: true, zero: false });
  });

  test('fail-open: diff 取不到 ⇒ 不拦 (照旧 success), 但 zeroWrite 留一行证据', async () => {
    const r = await runGoal('写点东西', cfg(new Error('不是 git 仓')));
    expect(r.converged).toBe(true);
    expect(r.outcome).toBe('success');
    expect(r.zeroWrite!.checked).toBe(false);
    expect(r.zeroWrite!.why).toContain('不是 git 仓');
  });
});
