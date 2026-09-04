/**
 * miners.test —— 五个矿源纯函数的判别力 (契约 INV-3 / GWT-3)。
 *
 * 每个 miner 都配**两份**样本: 一份「该出题」, 一份「不该出题」。
 * 只写前者会把「恒出题」读成通过 —— 一条永远出题的矿源和一条永远不出题的矿源一样没用。
 *
 * 反向自检 —— **下面是真跑出来的读数** (改一处, 跑本文件 + autoresearch-mine.test.ts 共 29 条):
 *  · `REASON_RE` 改成永不匹配                       → 3 fail (两簇塌成一簇 `未记终止原因`)
 *  · 去掉 `updatedAt >= sinceIso` 过滤              → 1 fail (窗口外的 run 混进题)
 *  · `sample()` 改成返回全量                        → 1 fail (evidence 破 3 条上限)
 *  · 主尺 null 判改成 `!== null`                    → 2 fail (该出题的不出, 不该出的出)
 *  · `mineReadout(null)` 改成返一条题               → 1 fail (「读不到」被读成「有题」)
 *  · 去掉 `executorKind !== 'goal'` 过滤            → 3 fail
 *  · 去掉 inFlight 判                               → 1 fail (在途票被重复出题)
 * 每条都能红, 且红的位置各不相同 = 这几把尺量的是矿源, 不是尺子。
 */
import { describe, expect, test } from 'bun:test';
import {
  mineFailedRuns,
  mineReadout,
  mineTestHealth,
  mineTickets,
  type FailedRunRow,
  type TicketMapLike,
} from './miners';

const SINCE = '2026-08-26T00:00:00.000Z';

/** 真机判词原文 (从 .omd/runs.db 抄的形状, 不是手编的措辞)。 */
const ERR_STALLED =
  '终止原因: not-converged (STALLED) · 下一步: 加 maxRounds 后 resume —— 再给几轮可能就成;' +
  '连续两次落这格再去看是不是任务本身没写清。';
const ERR_INFRA =
  '终止原因: infra-error (ERROR) · 下一步: 看栈 / 换池;连续同因 = 引擎缺陷,不是运气\nconverged: 未收敛';

function row(i: number, error: string, over: Partial<FailedRunRow> = {}): FailedRunRow {
  return {
    runId: `run-${String(i).padStart(3, '0')}`,
    status: 'failed',
    error,
    updatedAt: '2026-08-30T12:00:00.000Z',
    ...over,
  };
}

describe('mineFailedRuns (GWT-3)', () => {
  test('68 条 not-converged + 13 条 infra-error → 两簇, count 68/13, evidence 各 ≤ 3', () => {
    const rows = [
      ...Array.from({ length: 68 }, (_, i) => row(i, ERR_STALLED)),
      ...Array.from({ length: 13 }, (_, i) => row(1000 + i, ERR_INFRA)),
    ];
    const items = mineFailedRuns(rows, SINCE);
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe('failed-runs:not-converged');
    expect(items[0]!.metrics?.count).toBe(68);
    expect(items[1]!.id).toBe('failed-runs:infra-error');
    expect(items[1]!.metrics?.count).toBe(13);
    for (const it of items) expect(it.evidence.length).toBeLessThanOrEqual(3);
    expect(items[0]!.evidence).toEqual(['run-000', 'run-001', 'run-002']);
  });

  test('窗口外的 run 不进题 (sinceIso 真在过滤)', () => {
    const rows = [
      row(1, ERR_STALLED, { updatedAt: '2026-07-01T00:00:00.000Z' }),
      row(2, ERR_STALLED, { updatedAt: '2026-08-30T00:00:00.000Z' }),
    ];
    const items = mineFailedRuns(rows, SINCE);
    expect(items).toHaveLength(1);
    expect(items[0]!.metrics?.count).toBe(1);
  });

  test('判词不是引擎格式的单列一簇 (不塞进既有簇 —— NULL ≠ 0)', () => {
    const items = mineFailedRuns(
      [row(1, ERR_STALLED), row(2, 'minimax: The operation timed out.')],
      SINCE,
    );
    expect(items.map((i) => i.id).sort()).toEqual([
      'failed-runs:not-converged',
      'failed-runs:未记终止原因',
    ]);
  });

  test('无失败 run → 空 (矿源不恒出题)', () => {
    expect(mineFailedRuns([], SINCE)).toEqual([]);
    // 状态 completed 且 error 列有残留 → 不算今天的失败
    expect(mineFailedRuns([row(1, ERR_STALLED, { status: 'completed' })], SINCE)).toEqual([]);
    // 有行但无判词 → 不出题
    expect(mineFailedRuns([row(1, '', { status: 'failed' })], SINCE)).toEqual([]);
  });
});

describe('mineReadout', () => {
  test('读不到 (null) → 空 —— 读不到 ≠ 出题, 也 ≠ 这一类是零', () => {
    expect(mineReadout(null)).toEqual([]);
  });

  test('主尺 null + 全剔 + shape 0% → 三条题 (objective O3a/O3b 的实测形态)', () => {
    const items = mineReadout({
      runMeasurable: 0, runShareGt1: null, runMedian: null,
      speedupMedian: null,
      measurable: 0,
      excludedMissing: 133,
      shapeDeclRate: 0,
    });
    expect(items.map((i) => i.id)).toEqual([
      'readout:speedup-null',
      'readout:duration-excluded',
      'readout:shape-decl-low',
    ]);
    // NULL ≠ 0: 主尺那条把 null 原样记进 metrics, 不写成 0
    expect(items[0]!.metrics?.speedupMedian).toBeNull();
  });

  test('三维都健康 → 空 (闸不恒真)', () => {
    expect(
      mineReadout({ speedupMedian: 1.8, measurable: 120, excludedMissing: 13, shapeDeclRate: 0.7, runMeasurable: 50, runShareGt1: 0.4, runMedian: 1.2 }),
    ).toEqual([]);
  });
});

// ── tickets ───────────────────────────────────────────────────────────────

const MAP: TicketMapLike = {
  slug: 'autoresearch-map',
  tickets: [
    { id: 't-goal-open', title: '修 speedup 剔除规则', status: 'open', executorKind: 'goal' },
    { id: 't-goal-flying', title: '已在飞的票', status: 'open', executorKind: 'goal' },
    { id: 't-cmd', title: 'command 档票', status: 'open', executorKind: 'command' },
    { id: 't-ruled', title: '已裁决', status: 'ruled', executorKind: 'goal' },
    { id: 't-no-kind', title: '没标 executorKind', status: 'open' },
  ],
};

describe('mineTickets', () => {
  test('只挑 open ∧ goal ∧ 不在途的票', () => {
    const items = mineTickets([MAP], new Set(['autoresearch-map:t-goal-flying']));
    expect(items.map((i) => i.id)).toEqual(['tickets:autoresearch-map:t-goal-open']);
  });

  test('inFlight 缺省 (单参调用, 与契约签名逐字一致) → 在飞的票也进', () => {
    expect(mineTickets([MAP])).toHaveLength(2);
  });

  test('无 goal 票的图 → 空', () => {
    expect(mineTickets([{ slug: 'x', tickets: [{ id: 'a', title: 'a', status: 'open' }] }])).toEqual(
      [],
    );
  });
});

// ── test-health ───────────────────────────────────────────────────────────

describe('mineTestHealth', () => {
  test('读不到 (null) → 空', () => {
    expect(mineTestHealth(null)).toEqual([]);
  });

  test('三类判词不合并 —— 超时/记账/断言的下一步不同', () => {
    const items = mineTestHealth({
      failures: [
        { kind: 'runner-timeout', test: 'A', evidence: 'timed out' },
        { kind: 'assertion', test: 'B', evidence: 'expect' },
        { kind: 'assertion', test: 'C', evidence: 'expect' },
        { kind: 'runtime-accounting', test: 'D', evidence: '退出事件丢' },
      ],
      totals: { pass: 9000, fail: 4, skip: 0 },
    });
    expect(items.map((i) => i.id)).toEqual([
      'test-health:assertion',
      'test-health:runner-timeout',
      'test-health:runtime-accounting',
    ]);
    expect(items[0]!.metrics?.count).toBe(2);
    expect(items[0]!.metrics?.totalFail).toBe(4);
  });

  test('零失败 → 空 (全绿的日志不出题)', () => {
    expect(
      mineTestHealth({ failures: [], totals: { pass: 9101, fail: 0, skip: 0 } }),
    ).toEqual([]);
  });

  test('读不到总数时 metrics.totalFail 是 null, 不是 0', () => {
    const items = mineTestHealth({
      failures: [{ kind: 'assertion', test: 'A', evidence: 'e' }],
      totals: { pass: null, fail: null, skip: null },
    });
    expect(items[0]!.metrics?.totalFail).toBeNull();
  });
});
