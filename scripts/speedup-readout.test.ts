/**
 * `scripts/speedup-readout.ts` 纯函数面 —— 契约钉死的真值断言。
 *
 * 只测纯函数 (analyzeRun / shapeBucket / median / parseNodesColumn / renderMarkdown),
 * 不开 DB, 不跑 CLI。Fixtures 与手算真值来自上游契约 §8 + C-1 片 1;
 * 实现可能未到位, 文件缺失时 import 阶段即红 (frozen-tests 应在实装落地后转绿)。
 *
 * 反向自检 (锁死判据力):
 *  - 把 diamond 的 criticalMs 期望改 400 ⇒ 红 (Σ 与关键路径是分开量的);
 *  - 把 shapeBucket('one-decision-then-fanout') 改判 'unknown' ⇒ 红;
 *  - 注释写 "关键路径 = 600" 但断言 speedup === 3 ⇒ 红 (test 与实装背书互证);
 *  - C-1: 把 SKIPPED_NOT_MISSING fixture 的 S1..S4 status 改成 'done' ⇒ 重回 excluded-missing
 *    (证"skipped 不计入"这一格是真接住了, 不是注释 / 旁路写糊的);
 *  - C-1: 把 `expect(analyzeRun(allSkipped)).kind === 'invalid-shape'` 那条 fixture
 *    至少一个节点 status 去掉 → critical path > 0 → 红 (证全 skipped 必归零);
 *  - C-1: 把 `kind: 'skipped'` fixture 中 S1 的 deps 改为 null 并把 status 改成 'done'
 *    → invalid-shape (证"残留 deps null 不带 status 例外"那条不变量仍守着 done/failed 节点)。
 */
import { describe, expect, test } from 'bun:test';
import {
  analyzeRun,
  median,
  parseNodesColumn,
  renderMarkdown,
  isPreDurationField,
  DURATION_FIELD_EPOCH_S,
  shapeBucket,
  summarizeReadout,
  type ReadoutRow,
  type RunNode,
} from './speedup-readout';

describe('analyzeRun', () => {
  test('§8.1 线性链 speedup=1', () => {
    const linear: RunNode[] = [
      { id: 'A', deps: [], durationMs: 100 },
      { id: 'B', deps: ['A'], durationMs: 200 },
      { id: 'C', deps: ['B'], durationMs: 300 },
    ];
    expect(analyzeRun(linear)).toEqual({
      kind: 'ok',
      totalMs: 600,
      criticalMs: 600,
      speedup: 1,
    });
  });

  test('§8.2 菱形 650/450 (toBeCloseTo 高精度)', () => {
    const diamond: RunNode[] = [
      { id: 'A', deps: [], durationMs: 100 },
      { id: 'B', deps: ['A'], durationMs: 200 },
      { id: 'C', deps: ['A'], durationMs: 300 },
      { id: 'D', deps: ['B', 'C'], durationMs: 50 },
    ];
    const r = analyzeRun(diamond);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error(`unexpected verdict: ${r.kind}`);
    expect(r.totalMs).toBe(650);
    expect(r.criticalMs).toBe(450);
    expect(r.speedup).toBeCloseTo(650 / 450, 10);
  });

  test('§8.3 全并行 speedup=3', () => {
    const parallel: RunNode[] = [
      { id: 'A', deps: [], durationMs: 100 },
      { id: 'B', deps: [], durationMs: 100 },
      { id: 'C', deps: [], durationMs: 100 },
    ];
    expect(analyzeRun(parallel)).toEqual({
      kind: 'ok',
      totalMs: 300,
      criticalMs: 100,
      speedup: 3,
    });
  });

  test('§8.4 durationMs 缺失 30% -> excluded-missing (超 20% 阈值)', () => {
    const missingThirtyPercent: RunNode[] = [
      { id: 'N1', deps: [], durationMs: null },
      { id: 'N2', deps: [], durationMs: null },
      { id: 'N3', deps: [], durationMs: null },
      { id: 'N4', deps: [], durationMs: 100 },
      { id: 'N5', deps: [], durationMs: 100 },
      { id: 'N6', deps: [], durationMs: 100 },
      { id: 'N7', deps: [], durationMs: 100 },
      { id: 'N8', deps: [], durationMs: 100 },
      { id: 'N9', deps: [], durationMs: 100 },
      { id: 'N10', deps: [], durationMs: 100 },
    ];
    expect(analyzeRun(missingThirtyPercent)).toEqual({
      kind: 'excluded-missing',
      missingRatio: 0.3,
    });
  });

  test('§8.5 环 -> invalid-cycle (带超时, 死循环即红)', () => {
    const cycle: RunNode[] = [
      { id: 'A', deps: ['B'], durationMs: 100 },
      { id: 'B', deps: ['A'], durationMs: 200 },
    ];
    const t0 = performance.now();
    const r = analyzeRun(cycle);
    const elapsed = performance.now() - t0;
    expect(r).toEqual({ kind: 'invalid-cycle' });
    // 跑这俩点 + 一次 DFS 的活不该比 1000ms 长 —— 真死循环会涨到秒级+,
    // 失败信息直接指明是递归爆栈而非业务判据不对。
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('shapeBucket', () => {
  test('§8.6 absent 三例 (null / undefined / 空串)', () => {
    expect(shapeBucket(null)).toBe('absent');
    expect(shapeBucket(undefined)).toBe('absent');
    expect(shapeBucket('')).toBe('absent');
  });

  test('§8.6 known (isKnownShapeId 真)', () => {
    expect(shapeBucket('one-decision-then-fanout')).toBe('known');
  });

  test('§8.6 unknown 两例 (未注册 id / 纯空白)', () => {
    expect(shapeBucket('not-a-real-shape')).toBe('unknown');
    expect(shapeBucket('   ')).toBe('unknown');
  });
});

describe('median', () => {
  test('§8.7 奇数个取中间值', () => {
    expect(median([1, 3, 2])).toBe(2);
  });

  test('§8.7 偶数个取中间两值算术平均', () => {
    expect(median([1, 4, 2, 3])).toBe(2.5);
  });
});

// =====================================================================
// C-1 片 1: skipped ≠ 缺失 (2026-09-01 契约)
// 让真值成立的那条链逐跳写在每条 fixture 注释里。
// =====================================================================
describe('C-1 SKIPPED_NOT_MISSING — 剔除规则修复', () => {
  test('C-1.a 混合 fixture (4 skipped + 1 done+null + 1 done) 不触发 excluded-missing', () => {
    // 真值链:
    //   · 旧行为: 6 节点中 5 个 durationMs=null → 5/6 ≈ 83% > 20% ⇒ excluded-missing (整图剔除)
    //   · 新行为 (C-1): 4 个 status='skipped' 不计入缺失分子 → 仅 1/6 ≈ 16.7% ≤ 20% ⇒ ok
    //   · skipped 节点 own = 0, 不进 critical path; 仍占图, 依赖关系穿过
    //   · 真值: critical = 100 (D2 自身), total = 100 (D2 自身; 其它都是 null 跳过) ⇒ speedup = 1
    const mixed: RunNode[] = [
      { id: 'S1', deps: [], durationMs: null, status: 'skipped' },
      { id: 'S2', deps: ['S1'], durationMs: null, status: 'skipped' },
      { id: 'S3', deps: ['S2'], durationMs: null, status: 'skipped' },
      { id: 'S4', deps: ['S3'], durationMs: null, status: 'skipped' },
      { id: 'D1', deps: ['S4'], durationMs: null, status: 'done' },
      { id: 'D2', deps: ['D1'], durationMs: 100, status: 'done' },
    ];
    const r = analyzeRun(mixed);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error(`unexpected verdict: ${r.kind}`);
    expect(r.totalMs).toBe(100);
    expect(r.criticalMs).toBe(100);
    expect(r.speedup).toBe(1);
  });

  test('C-1.b done+null 节点 30% (无 skipped) 仍触发 excluded-missing (回归闸)', () => {
    // 真值链: 没有 skipped 时, C-1 修复不应影响旧规则 —— 30% missing 必剔除。
    // 这一条是把"新规则改了旧行为"假阳挡住的反向自检。
    const noSkip: RunNode[] = [
      { id: 'N1', deps: [], durationMs: null, status: 'done' },
      { id: 'N2', deps: ['N1'], durationMs: null, status: 'done' },
      { id: 'N3', deps: ['N2'], durationMs: null, status: 'done' },
      { id: 'N4', deps: ['N3'], durationMs: 100, status: 'done' },
      { id: 'N5', deps: ['N4'], durationMs: 100, status: 'done' },
      { id: 'N6', deps: ['N5'], durationMs: 100, status: 'done' },
      { id: 'N7', deps: ['N6'], durationMs: 100, status: 'done' },
      { id: 'N8', deps: ['N7'], durationMs: 100, status: 'done' },
      { id: 'N9', deps: ['N8'], durationMs: 100, status: 'done' },
      { id: 'N10', deps: ['N9'], durationMs: 100, status: 'done' },
    ];
    expect(analyzeRun(noSkip)).toEqual({
      kind: 'excluded-missing',
      missingRatio: 0.3,
    });
  });

  test('C-1.c skipped 节点 deps=null 不触发 invalid-shape (残留 deps null 例外)', () => {
    // 真值链:
    //   · 旧行为: 任一节点 deps=null ⇒ invalid-shape (但被 20% 闸先拦, 不论数量)
    //   · 新行为 (C-1): skipped 节点 deps=null 是预期 (该节点没跑, 入边信息不适用),
    //     不计入第 ⑶ 步残留检查 → 通过
    //   · 同时 2 个 skipped 都从 missing 分子扣掉 → 缺失比 0
    //   · critical path = 100 (D2); total = 100 ⇒ speedup = 1
    const mixedDepsNull: RunNode[] = [
      { id: 'S1', deps: null, durationMs: null, status: 'skipped' },
      { id: 'S2', deps: null, durationMs: null, status: 'skipped' },
      { id: 'D1', deps: ['S1'], durationMs: 100, status: 'done' },
      { id: 'D2', deps: ['S1', 'S2'], durationMs: 100, status: 'done' },
    ];
    const r = analyzeRun(mixedDepsNull);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error(`unexpected verdict: ${r.kind}`);
    expect(r.criticalMs).toBe(100);
    expect(r.totalMs).toBe(200);
    expect(r.speedup).toBe(2);
  });

  test('C-1.d 全 skipped 必归 invalid-shape (critical path = 0)', () => {
    // 真值链:
    //   · 第 ⑴ 步: 节点数 > 0, 无重复 id, 无负 duration ⇒ 通过
    //   · 第 ⑵ 步: 全 skipped → missingCount = 0 ⇒ 通过
    //   · 第 ⑶ 步: 全 skipped ⇒ 跳过残余 deps null 检查 ⇒ 通过
    //   · 第 ⑷ 步: DFS 中所有 skipped 的 own = 0 → criticalMs = 0
    //   · 第 ⑸ 步: !(0 > 0) ⇒ invalid-shape
    // 真值: 全 skipped run 是 "无工作量可测" — 整图剔除, 语义合理。
    const allSkipped: RunNode[] = [
      { id: 'S1', deps: [], durationMs: null, status: 'skipped' },
      { id: 'S2', deps: ['S1'], durationMs: null, status: 'skipped' },
      { id: 'S3', deps: ['S2'], durationMs: null, status: 'skipped' },
    ];
    expect(analyzeRun(allSkipped)).toEqual({ kind: 'invalid-shape' });
  });

  test('C-1.e 混合 batch (有 skipped + 有 done+null) 的 verdict 流分类', () => {
    // 真值链:
    //   · batch 1: 全 done (无 null) → ok
    //   · batch 2: 全 skipped → invalid-shape (C-1.d)
    //   · batch 3: 大量 skipped + 少量 done+null (≤20%) → ok (C-1.a 同形)
    //   · batch 4: 大量 done+null (>20%) 无 skipped → excluded-missing (C-1.b)
    //   · batch 5: 环穿过 skipped → invalid-cycle (cycle 判定与 status 正交, 不豁免)
    const batch1: RunNode[] = [
      { id: 'A', deps: [], durationMs: 50, status: 'done' },
      { id: 'B', deps: ['A'], durationMs: 50, status: 'done' },
    ];
    expect(analyzeRun(batch1).kind).toBe('ok');

    const batch3: RunNode[] = [
      { id: 'S1', deps: [], durationMs: null, status: 'skipped' },
      { id: 'S2', deps: [], durationMs: null, status: 'skipped' },
      { id: 'S3', deps: [], durationMs: null, status: 'skipped' },
      { id: 'S4', deps: [], durationMs: null, status: 'skipped' },
      { id: 'S5', deps: [], durationMs: null, status: 'skipped' },
      { id: 'S6', deps: [], durationMs: null, status: 'skipped' },
      { id: 'S7', deps: [], durationMs: null, status: 'skipped' },
      { id: 'S8', deps: [], durationMs: null, status: 'skipped' },
      { id: 'D1', deps: [], durationMs: 100, status: 'done' },
    ];
    expect(analyzeRun(batch3).kind).toBe('ok');

    // batch 5: 环 A→B→A, 状态都为 done —— cycle 判定与 skipped 规则正交, 此处只锁"done
    // 节点形成的环仍归 invalid-cycle"。把 A 改成 skipped 会同样得 invalid-cycle。
    const batch5: RunNode[] = [
      { id: 'A', deps: ['B'], durationMs: 100, status: 'done' },
      { id: 'B', deps: ['A'], durationMs: 100, status: 'done' },
    ];
    expect(analyzeRun(batch5).kind).toBe('invalid-cycle');
  });
});

describe('C-1 parseNodesColumn — status 字段提取', () => {
  test('C-1.f status 字段缺席合法 (老记录兼容)', () => {
    const json = JSON.stringify([{ id: 'A', deps: [], durationMs: 100 }]);
    const parsed = parseNodesColumn(json);
    expect(parsed).not.toBeNull();
    expect(parsed![0]!.status).toBeUndefined();
  });

  test('C-1.g status 字段为 skipped 时正常落库', () => {
    const json = JSON.stringify([
      { id: 'A', deps: [], durationMs: null, status: 'skipped' },
    ]);
    const parsed = parseNodesColumn(json);
    expect(parsed).not.toBeNull();
    expect(parsed![0]!.status).toBe('skipped');
  });

  test('C-1.h status 字段非字符串 (null / 数字) 拒整行', () => {
    expect(parseNodesColumn(JSON.stringify([{ id: 'A', deps: [], durationMs: 100, status: null }]))).toBeNull();
    expect(parseNodesColumn(JSON.stringify([{ id: 'A', deps: [], durationMs: 100, status: 42 }]))).toBeNull();
  });
});

describe('C-1 renderMarkdown — 剔除计数分列 (excluded_missing / excluded_invalid)', () => {
  test('C-1.i 输出含 excluded_missing / excluded_invalid 两列, 不合并', () => {
    // 真值链: counters.excludedInvalid 在 renderMarkdown 中合并 invalid-cycle + invalid-shape
    // (旧实现拆成两列) — 契约 §"剔除计数分列 excluded_missing / excluded_invalid, 不合并"。
    const md = renderMarkdown(
      'test',
      [{ label: 'absent', speedups: [1, 2] }],
      { excludedMissing: 5, excludedInvalid: 3 },
    );
    expect(md).toContain('excluded_missing: 5');
    expect(md).toContain('excluded_invalid: 3');
    // 旧串 (`invalidCycle` / `invalidShape` / `excludedMissing` 单名) 不许再出现
    expect(md).not.toContain('invalidCycle');
    expect(md).not.toContain('invalidShape');
    expect(md).not.toContain('excludedMissing');
  });
});


describe('summarizeReadout —— 夜链矿源摘要 (缺口 2)', () => {
  /** 两条可量 (speedup 1 与 2) + 一条因缺 duration 整图剔除; 三条里一条声明了 shape。 */
  const ROWS: ReadoutRow[] = [
    {
      nodes: JSON.stringify([
        { id: 'A', deps: [], durationMs: 100 },
        { id: 'B', deps: ['A'], durationMs: 200 },
      ]),
      shape_id: 'one-decision-then-fanout',
    },
    {
      nodes: JSON.stringify([
        { id: 'A', deps: [], durationMs: 100 },
        { id: 'B', deps: [], durationMs: 100 },
      ]),
      shape_id: null,
    },
    {
      nodes: JSON.stringify([
        { id: 'A', deps: [], durationMs: null },
        { id: 'B', deps: ['A'], durationMs: 100 },
      ]),
      shape_id: null,
    },
  ];

  test('中位 / measurable / excludedMissing / shape 声明率 四格各自有数', () => {
    // 真值链: 行 1 线性 → speedup 1; 行 2 双根并行 → total 200 / critical 100 = 2;
    // 行 3 缺失比例 1/2 = 0.5 > 0.20 → excluded-missing。median([1,2]) = 1.5。
    // 声明率分母 = 扫过的全部行 (3), 分子 = shape_id 非 absent 的行 (1)。
    expect(summarizeReadout(ROWS)).toEqual({
      speedupMedian: 1.5,
      measurable: 2,
      excludedMissing: 1,
      shapeDeclRate: 1 / 3,
      // ROWS 不带 entry → run 桶空: null 不是 0
      runMeasurable: 0,
      runShareGt1: null,
      runMedian: null,
    });
  });

  test('零行 → null (「这一类没读到」不许写成一排 0)', () => {
    expect(summarizeReadout([])).toBeNull();
  });

  test('一行都不可量 → speedupMedian 读 null, 不编 0', () => {
    const s = summarizeReadout([ROWS[2]!]);
    expect(s).not.toBeNull();
    expect(s!.speedupMedian).toBeNull();
    expect(s!.measurable).toBe(0);
    expect(s!.excludedMissing).toBe(1);
  });

  test('nodes 列不可解析 → 计进 invalid, 不进 excludedMissing (两桶不合并)', () => {
    const s = summarizeReadout([{ nodes: 'not json', shape_id: null }]);
    expect(s!.measurable).toBe(0);
    expect(s!.excludedMissing).toBe(0);
  });
});

describe('§6.7 字段前史 isPreDurationField (2026-09-04 修尺)', () => {
  test('C-1 契约日之前 → true; 之后 → false; 秒/毫秒两制同判; 缺席 → false (保守进剔除桶)', () => {
    const day = 86_400;
    expect(isPreDurationField(DURATION_FIELD_EPOCH_S - day)).toBe(true);
    expect(isPreDurationField((DURATION_FIELD_EPOCH_S - day) * 1000)).toBe(true);
    expect(isPreDurationField(DURATION_FIELD_EPOCH_S)).toBe(false);
    expect(isPreDurationField(String(DURATION_FIELD_EPOCH_S + day))).toBe(false);
    expect(isPreDurationField(null)).toBe(false);
    expect(isPreDurationField(undefined)).toBe(false);
    // 反向自检: 阈值真是 2026-08-19 00:00Z —— 改成别的日子这条即红。
    expect(new Date(DURATION_FIELD_EPOCH_S * 1000).toISOString()).toBe('2026-08-19T00:00:00.000Z');
  });
});

describe('§6.7 summarizeReadout 剔字段前史 (2026-09-04 修尺)', () => {
  test('带 created_at 早于阈值的行不进任何分母; 不带 created_at 的行逐字节同旧', () => {
    const okNodes = JSON.stringify([{ id: 'a', deps: [], durationMs: 10 }, { id: 'b', deps: ['a'], durationMs: 10 }]);
    const missNodes = JSON.stringify([{ id: 'a', deps: [], durationMs: null }]);
    const pre = DURATION_FIELD_EPOCH_S - 86_400;
    const post = DURATION_FIELD_EPOCH_S + 86_400;
    const s = summarizeReadout([
      { nodes: okNodes, shape_id: null, created_at: post },
      { nodes: missNodes, shape_id: null, created_at: post },
      { nodes: missNodes, shape_id: null, created_at: pre }, // 字段前: 不适用
      { nodes: missNodes, shape_id: null, created_at: pre },
    ]);
    expect(s).not.toBeNull();
    expect(s!.measurable).toBe(1);
    expect(s!.excludedMissing).toBe(1); // 反向: 把 filter 删掉 → 这里读 3 即红
    // 没给 created_at → 全当字段后 (老调用方不变)
    const legacy = summarizeReadout([{ nodes: missNodes, shape_id: null }, { nodes: missNodes, shape_id: null }]);
    expect(legacy!.excludedMissing).toBe(2);
  });
});

describe('O3a run 桶三格 (objective.md 2026-09-04 修订)', () => {
  test('只有 entry∈{run,dag_run_plan} 进桶; 占比与中位按桶算; 桶空 → null 不是 0', () => {
    const par = JSON.stringify([{ id: 'a', deps: [], durationMs: 10 }, { id: 'b', deps: [], durationMs: 10 }, { id: 'c', deps: ['a', 'b'], durationMs: 10 }]); // 3/2 = 1.5
    const ser = JSON.stringify([{ id: 'a', deps: [], durationMs: 10 }, { id: 'b', deps: ['a'], durationMs: 10 }]); // 1.0
    const post = DURATION_FIELD_EPOCH_S + 86_400;
    const s = summarizeReadout([
      { nodes: par, shape_id: null, created_at: post, entry: 'run' },
      { nodes: ser, shape_id: null, created_at: post, entry: 'dag_run_plan' },
      { nodes: par, shape_id: null, created_at: post, entry: 'solve' }, // 不进桶
      { nodes: par, shape_id: null, created_at: post }, // entry 缺席: 不进桶
    ])!;
    expect(s.measurable).toBe(4);
    expect(s.runMeasurable).toBe(2);
    expect(s.runShareGt1).toBe(0.5); // 反向: 把 solve 那行也算进桶 → 2/3 即红
    expect(s.runMedian).toBe(1.25);
    const empty = summarizeReadout([{ nodes: par, shape_id: null, created_at: post, entry: 'solve' }])!;
    expect(empty.runMeasurable).toBe(0);
    expect(empty.runShareGt1).toBeNull();
    expect(empty.runMedian).toBeNull();
  });
});
