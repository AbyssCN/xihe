/**
 * R-1 第 4 步 (2026-09-03): resultOut 头部的 `loop:` / `ledger:` 行与 summarizeGoal 的「循环」行。
 *
 * bench 容器里账本 (`dag-runs.db`) 不出容器, 这两行是循环读数与子 run 节点用量唯一能出去的路 ——
 * 形状在这里钉死, 读侧 (fork `scripts/omd-batch-report.py`) 按键读。
 * 证伪: renderLedgerLine 不走 listByRun → 第一条红; summarizeGoal 删掉 r.loop 分支 → 第二条红。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createDagRecorder, type DagRecorder } from '../../harness/dag/dag-record';
import type { ExecutorDagResult } from '../../harness/dag/types';
import type { LoopLedger } from '../../harness/goal/loop-ledger';
import type { RunGoalResult } from '../../harness/goal/run-goal';
import { ledgerHeaderRows, renderLedgerLine, summarizeGoal } from './goal';

type FakeNode = { id: string; kind?: string } & Record<string, unknown>;
const fake = (name: string, levels: string[][], nodes: FakeNode[]): ExecutorDagResult =>
  ({
    plan: { name, nodes: Object.fromEntries(nodes.map((n) => [n.id, { goal: n.id, executor: n.kind === 'command' ? 'command' : 'agent' }])) },
    levels,
    results: Object.fromEntries(nodes.map((n) => [n.id, { kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 1, out: 1 }, ...n }])),
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
    reusedNodes: [],
    observations: [],
  }) as unknown as ExecutorDagResult;

describe('R-1 第 4 步: resultOut 头部 ledger 行', () => {
  test('★ ledgerHeaderRows: 每账本行一项 (父行 + 同 run_id 的 conductor-* 子行), levels 只留每层节点数, 计数格没记 = null', () => {
    const rec = createDagRecorder({ db: new Database(':memory:') });
    rec.record(fake('goal-orchestrating-loop', [['conductor'], ['accept']], [
      { id: 'conductor', durationMs: 1000, llmCalls: 20, toolCalls: 6, model: 'bench:MiniMax-M3' },
      { id: 'accept', kind: 'command' },
    ]), { runId: 'R', entry: 'solve' });
    rec.record(fake('conductor-work-x', [['d1.a', 'd1.b']], [{ id: 'd1.a', durationMs: 400, llmCalls: 10 }, { id: 'd1.b', durationMs: 300, llmCalls: 5 }]), { runId: 'R', entry: 'solve' });
    rec.record(fake('goal-execute', [['e']], [{ id: 'e', llmCalls: 99 }]), { runId: 'OTHER', entry: 'solve' });
    const rows = ledgerHeaderRows(rec.listByRun('R'));
    expect(rows.map((r) => r.plan)).toEqual(['goal-orchestrating-loop', 'conductor-work-x']); // OTHER 那行不进
    expect(rows[0]!.levels).toEqual([1, 1]);
    expect(rows[1]!.levels).toEqual([2]); // 宽度 2 深度 1
    expect(rows[0]!.nodes.find((n) => n.id === 'conductor')).toEqual({
      id: 'conductor', kind: 'agent', status: 'done', model: 'bench:MiniMax-M3',
      tokensIn: 1, tokensOut: 1, cacheHitTokens: null, durationMs: 1000, toolCalls: 6, llmCalls: 20,
    });
    // command 叶没这两格 → null (不是 0): 读侧把它当「没记」, 不摊进 worker 调用数。
    expect(rows[0]!.nodes.find((n) => n.id === 'accept')!.llmCalls).toBeNull();
    const line = renderLedgerLine(rec, 'R');
    expect(line.startsWith('ledger: [')).toBe(true);
    expect(line.endsWith(']\n')).toBe(true);
    expect(JSON.parse(line.slice('ledger: '.length))).toEqual(rows); // 单行 JSON, 读侧 json.loads 即得
    expect(renderLedgerLine(rec, 'NOPE')).toBe(''); // 零行 = 头部没这一行 (不是 `ledger: []`)
    expect(renderLedgerLine(undefined, 'R')).toBe('');
    rec.close();
  });

  test('读账本抛错 → 空串 (fail-open), 不炸 resultOut 写入', () => {
    const boom = { listByRun: () => { throw new Error('db locked'); } } as unknown as DagRecorder;
    expect(renderLedgerLine(boom, 'R')).toBe('');
  });

  test('★ summarizeGoal: 有 loop → 一行「循环:」(终审 / 回灌后新派发 / 卡直达 / 常驻字符); 无 loop → 无此行', () => {
    const loop: LoopLedger = {
      path: 'orchestrating-loop', route: { kind: 'none', chainHit: false }, preActionLlmCalls: 1, residentPromptChars: 6400,
      verifier: { calls: 2, firstVerdict: 'fail', target: 'criterion', reinjected: true, afterReinject: 'green', recheck: 'pass' },
      cards: { calls: 3, ok: 2, rejectedSchema: 1, help: 0, rejectedCompile: 0, childRunError: 0, byCard: { work: 2 }, readOnlyShellBlocked: 0 },
      dispatches: [{ seq: 1, card: 'work', nodes: 1, briefHasRepro: true, failed: 0 }, { seq: 2, card: 'work', nodes: 1, briefHasRepro: false, failed: 0 }],
      dispatchesBeforeReinject: 2,
    };
    const base: RunGoalResult = {
      goal: 'g', tier: 'complex', acceptance: { kind: 'exploratory', learningGoal: 'x', affordableLoss: '一轮' },
      stages: [], sources: [], repoContext: '', converged: true, rounds: 1, reusedNodes: [], outcome: 'success',
    };
    const line = summarizeGoal({ ...base, loop }).split('\n').find((l) => l.startsWith('循环:'));
    expect(line).toBe('循环: 终审 2 次 (首判 fail · 对象 criterion) · 回灌 是 → green · 回灌后新派发 0 · 窄复审 pass · 派发 2 次 (卡 ok 2/3) · conductor 常驻 prompt 6400 字符 · 触碰 0 文件 / orphan 0 / missing 0');
    expect(summarizeGoal(base)).not.toContain('循环:');
  });
});
