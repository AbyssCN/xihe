/**
 * omd-readout 的**可执行契约** —— 承 execute::1a3v8nvdfasqs 的统一契约草案 (§3/§4), 以**本仓留痕层
 * 真实数据模型**为准。草案是未过审计的草稿, 与本仓实况冲突处按下述三条以实况为准 (草案自己也
 * 声明「不符则以本契约为目标改造」—— 本测试就是那份改造后的契约):
 *
 * ① 风险级词表用本仓 `CommandRiskTier` (read_only / scoped_write / approval_required / never),
 *    不用草案里猜的 R1/R2/R3 —— 后者在本仓不存在, 编一套映射等于给价表编坐标。
 * ② usage 用本仓五字段 (conductorIn/conductorOut/leavesIn/leavesOut/leavesCacheHit),
 *    不用草案里的 cpu_ms/mem_kb —— 留痕层从不记那两个数, 也没有 duration。
 * ③ 「DAG 全量节点集」(草案 T6/T8 的「含 DAG 全量」) 取自每条记录的 `levels`
 *    (topoLevels 的全 plan 节点 id)—— :memory: 夹具没有 repo 可扫, levels 是留痕层唯一全量拓扑。
 *
 * ⚠ **实现前置① (实现节点的活, 不是本测试的)**: four_grid / two_grid_risk / reuse_rate 都建立在
 * 「能认出**哪些**节点被复用」之上, 而 dag-record 今天只存复用**计数** (`reused` 列)。实现节点须让
 * 留痕层持久化 reused 节点 id 列表 (一条新列, JSON 数组), 否则 not_executed 无从归属风险级 ——
 * 这正是草案 T7「not_executed 只含记录为 reused 的节点」的数据前提。
 * ⚠ **实现前置②**: `scripts/omd-readout.ts` 须导出纯函数 `readout(opts)` 并加 `import.meta.main`
 * 守卫 (先例 scripts/omd-path.ts), 否则本测试 import 它就会执行 CLI 顶层逻辑去读真库。
 *
 * 本测试只碰 :memory: 库 (createDagRecorder({db}): 两个独立 :memory: 连接互不相通, readout 必须
 * 与留痕器共用同一连接才看得见夹具)。契约要求 readout **只读不写** (原任务约束) —— 不靠自报,
 * 「读后状态断言」(排序/limit 那条末尾) 钉的是真证据: readout 之后行数与 schema 原样。
 * ⚠ **spec-first 已知态** (前置② 落地前): scripts/omd-readout.ts 目前是纯 CLI —— 无 import.meta.main
 *   守卫、未导出 readout/ReadoutResult, 本测试 import 它会执行 CLI 顶层 (真读 .omd/dag-runs.db)。
 *   这是**已知且有意**的状态: 本测试就是那份冻结契约, 实现节点落地前置② + readout 后它才转绿;
 *   在此之前本文件 tsc 红、import 会碰真库 —— 别把它当"现在的实况", 它是"实现后的判据"。
 * 零新依赖 (bun:test + bun:sqlite + 仓内模块)。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createDagRecorder } from './dag/dag-record';
import type { SpecWrite } from './goal/spec-write';
import type { LoopLedger } from './goal/loop-ledger';
import type { ExecutorDagResult } from './dag/types';
import { CLAIM_CHECK_MIN_NODES, LOOP_NO_MOVE_MIN_N, faceSufficiency, readout, reconstructWriteRace, summarizeFaces, summarizeLoopRounds, type ReadoutResult } from '../../scripts/omd-readout';
import type { NodeWindow } from './plan/observers';

interface FakeNode {
  goal: string;
  executor?: 'command' | 'agent' | 'inproc';
  command?: string;
}
interface FakeOpts {
  planName: string;
  plan: Record<string, FakeNode>;
  done?: string[];
  failed?: { id: string; failureKind: string }[];
  /** 缺席 = 这条链没报复用 → 留痕落 NULL (没记, 不是 0)。 */
  reused?: string[];
  usage?: { conductorIn?: number; conductorOut?: number; leavesIn?: number; leavesOut?: number; leavesCacheHit?: number };
}

const nodeKind = (n: FakeNode | undefined): string => n?.executor ?? 'inproc';

/** 最小可记的一张图结果 (只填 record 真读的那几个字段; 同 dag-record.test.ts 的 fakeResult)。 */
const fakeResult = (o: FakeOpts): ExecutorDagResult => {
  const results: Record<string, unknown> = {};
  for (const id of o.done ?? []) {
    results[id] = { id, kind: nodeKind(o.plan[id]), status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } };
  }
  for (const f of o.failed ?? []) {
    results[f.id] = { id: f.id, kind: nodeKind(o.plan[f.id]), status: 'failed', failureKind: f.failureKind, deps: [], output: '', usage: { in: 0, out: 0 } };
  }
  // ⚠ **复用节点也要进 `results`**(2026-08-06 修夹具)。此前它们只出现在 `reusedNodes` 里,
  //   而真引擎是 `results[cid] = { ...上轮结果, skipped: true }` —— 复用节点**就在结果里**。
  //   旧夹具照着读数板那条"推断"的假设造(在 plan 里、不在结果里 = 复用), 于是
  //   **推断与它的测试一起错、并且互相背书** —— 正是本仓 CLAUDE.md 警告的那一条
  //   (「测试与实装由同一次改动一起产出时会一起错」)。真数据上那条推断恒返空集。
  for (const id of o.reused ?? []) {
    results[id] = { id, kind: nodeKind(o.plan[id]), status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, skipped: true };
  }
  return {
    plan: { name: o.planName, nodes: o.plan },
    levels: [Object.keys(o.plan)],
    results,
    ...(o.reused ? { reusedNodes: o.reused } : {}),
    usage: {
      conductor: { in: o.usage?.conductorIn ?? 0, out: o.usage?.conductorOut ?? 0 },
      leavesIn: o.usage?.leavesIn ?? 0,
      leavesOut: o.usage?.leavesOut ?? 0,
      leavesCacheHit: o.usage?.leavesCacheHit ?? 0,
    },
  } as unknown as ExecutorDagResult;
};

/**
 * 夹具 (最小但完整): 五个 run, 七条记录。
 *
 *  · run-A (dag_goal): 契约段 + 执行段两条、**同一节点集** (真实 goal 两段跑同一张图,
 *    dag-record.test.ts 先例) —— 并集归并 / usage 求和 / 成功只计一次的主语; 收尾时回填
 *    criteria {judge:true, oracle:false} (判据轴, 见 dag-record.ts:updateCriteria)。
 *  · run-B (dag_resume): resume 链两条 —— 第二段**复用**第一段执行过的 x (跨记录归属风险级),
 *    z 在 plan 里但从未执行也从未复用 → 缺席 (四格「未记」)。
 *  · run-C: entry 没传 (→ NULL) + reusedNodes 缺席 (→ NULL) + usage 记了全 0。
 *  · run-D (dag_run): gate-rejected → run 级 blocked —— N5 词表里与 not-converged 相邻但
 *    下一步相反的那一格, 不许被塌成 failure。
 *  · old-1: 逐字模拟 2026-07-31 之前的老行 (就地补列后 outcome/criteria/entry/reused 全 NULL,
 *    run_id 也是 NULL —— 与补列前的实况一致)。
 */
const makeFixture = () => {
  const db = new Database(':memory:');
  const rec = createDagRecorder({ db });
  rec.record(
    fakeResult({
      planName: 'goal-contract',
      plan: { g1: { goal: 'x', executor: 'command', command: 'ls' }, g2: { goal: 'y', executor: 'agent' } },
      done: ['g1', 'g2'],
      reused: [],
      usage: { conductorIn: 10, conductorOut: 20, leavesIn: 300, leavesOut: 50, leavesCacheHit: 120 },
    }),
    { runId: 'run-A', entry: 'dag_goal', now: 1000 },
  );
  rec.record(
    fakeResult({
      planName: 'goal-execute',
      plan: { g1: { goal: 'x', executor: 'command', command: 'ls' }, g2: { goal: 'y', executor: 'agent' } },
      done: ['g1', 'g2'],
      reused: [],
      usage: { conductorIn: 10, conductorOut: 20, leavesIn: 700, leavesOut: 150, leavesCacheHit: 400 },
    }),
    { runId: 'run-A', entry: 'dag_goal', now: 2000 },
  );
  // 判据轴 (N9): 冻结判据在整趟 goal 收尾时才回填, 两条记录写同一份 (dag-record.ts:updateCriteria)。
  rec.updateCriteria('run-A', { judge: true, oracle: false });
  rec.record(
    fakeResult({
      planName: 'resume-1',
      plan: { x: { goal: 'a', executor: 'command', command: 'ls' }, y: { goal: 'b', executor: 'command', command: 'bun test' } },
      done: ['x', 'y'],
      reused: [],
      usage: { leavesIn: 100, leavesOut: 30 },
    }),
    { runId: 'run-B', entry: 'dag_resume', now: 3000 },
  );
  rec.record(
    fakeResult({
      planName: 'resume-2',
      plan: {
        x: { goal: 'a', executor: 'command', command: 'ls' },
        y: { goal: 'b', executor: 'command', command: 'bun test' },
        z: { goal: 'c', executor: 'command', command: 'codegraph' },
      },
      done: ['y'],
      reused: ['x'],
      usage: { leavesIn: 50, leavesOut: 10 },
    }),
    { runId: 'run-B', entry: 'dag_resume', now: 4000 },
  );
  rec.record(
    fakeResult({
      planName: '图C',
      plan: { f1: { goal: 'x', executor: 'command', command: 'ls' } },
      failed: [{ id: 'f1', failureKind: 'assert-failed' }],
      usage: { leavesIn: 0, leavesOut: 0 },
    }),
    { runId: 'run-C', now: 5000 }, // entry 缺席 → NULL (调用方没接入口轴)
  );
  rec.record(
    fakeResult({
      planName: '图D',
      plan: { d1: { goal: 'x', executor: 'command', command: 'ls' } },
      failed: [{ id: 'd1', failureKind: 'gate-rejected' }],
      usage: { leavesIn: 0, leavesOut: 0 },
    }),
    { runId: 'run-D', entry: 'dag_run', now: 5500 },
  );
  // 老行: 建表后逐列 ALTER 出来的 NULL, 逐字复刻迁移后实况 (nodes 形状同 recorder 写的)。
  db.run(
    `INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage, observations, outcome, verification, reused, criteria)
     VALUES ('old-1', 6000, '老图', 1, NULL, NULL, NULL, '[[\"old1\"]]', ?, ?, NULL, NULL, NULL, NULL, NULL)`,
    [
      JSON.stringify([{ id: 'old1', kind: 'command', status: 'done', deps: [], command: 'ls' }]),
      JSON.stringify({ conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 }),
    ],
  );
  return { db, readoutNow: (): ReadoutResult => readout({ db }) };
};

describe('omd-readout · runId 归并 (草案 §4)', () => {
  test('契约段 + 执行段: usage 各字段独立求和, attempts=2, 一条 run 而非两条', () => {
    const { readoutNow } = makeFixture();
    const a = readoutNow().runs.find((x) => x.run_id === 'run-A')!;
    expect(a.attempts).toBe(2);
    expect(a.first_at).toBe(1000);
    expect(a.last_at).toBe(2000);
    expect(a.status).toBe('success');
    expect(a.usage).toEqual({ conductorIn: 20, conductorOut: 40, leavesIn: 1000, leavesOut: 200, leavesCacheHit: 520 });
    expect(a.usage_unmeasured_attempts).toBe(0); // 留痕层恒写 usage, 夹具里没有 NULL usage
    expect(a.reused).toBe(0); // 两段都记了 0 复用 → 求和仍是 0, 不是 null
  });

  test('成功分母只计一次: 两段都成功的 run-A 在 outcome_distribution 里只占一个 success', () => {
    const { readoutNow } = makeFixture();
    expect(readoutNow().outcome_distribution).toEqual({
      success: 2, 'not-converged': 1, 'oracle-failed': 0, 'delivered-with-red': 0, 'verifier-rejected': 0, blocked: 1,
      'budget-exhausted': 0, cancelled: 0, 'infra-error': 0, 'missing-capability': 0, 'not-needed': 0,
      'empty-result': 0, unclassified: 0, 未记: 1, total: 5,
    });
    // 词表 = RunOutcomeKind 全量 (run-outcome.ts:RUN_OUTCOME_ORDER), 不许塌成 success/failure 两桶;
    // total = 去重后的 run_id 数 (5), 不是记录数 (7) —— 一次 goal 两段不数成两次。
  });
});

describe('omd-readout · NULL/缺席 ≠ 0, 已记录的 0 仍是 0 (草案 §5)', () => {
  test('reused: 没记 → null, 记了 0 → 0, 两段相加 → 和', () => {
    const { readoutNow } = makeFixture();
    const runs = readoutNow().runs;
    const byId = (id: string) => runs.find((x) => x.run_id === id)!;
    expect(byId('run-A').reused).toBe(0); // 记了且零复用
    expect(byId('run-B').reused).toBe(1); // 0 + 1 求和
    expect(byId('run-C').reused).toBeNull(); // reusedNodes 缺席 → 没记, 不许编 0
    expect(byId('run-D').reused).toBeNull(); // 同上
    expect(byId('(no-runid):old-1').reused).toBeNull();
  });

  test('outcome 缺席 → 状态「未记」; usage 记的 0 保持 0 且 usage 不为 null', () => {
    const { readoutNow } = makeFixture();
    const runs = readoutNow().runs;
    const old = runs.find((x) => x.run_id === '(no-runid):old-1')!;
    expect(old.status).toBe('未记'); // outcome NULL 不是 failure, 也不是 success
    expect(old.usage).toEqual({ conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 });
    const c = runs.find((x) => x.run_id === 'run-C')!;
    expect(c.status).toBe('not-converged'); // assert-failed → not-converged (run-outcome.ts), 词表原样不塌成 failure
    expect(c.usage).not.toBeNull();
    expect(c.usage!.leavesIn).toBe(0); // 记的 0, 不是 null
    const d = runs.find((x) => x.run_id === 'run-D')!;
    expect(d.status).toBe('blocked'); // gate-rejected → blocked —— 与 not-converged 分得开 (停止轴)
  });
});

describe('omd-readout · entry 分组 (2026-08-02 入口轴)', () => {
  test('不同 entry 完全分组, 缺席 entry 单列「未记」', () => {
    const { readoutNow } = makeFixture();
    const r = readoutNow();
    // fixture 写的是**旧词** (dag_goal/dag_run) —— 断言新词 (solve/run) 正是在钉读侧归一合并 (t7)。
    expect(r.entry_distribution).toEqual([
      { entry: 'solve', runs: 1, attempts: 2 }, // run-A 的两段合成一次 goal (旧词 dag_goal 归一)
      { entry: 'dag_resume', runs: 1, attempts: 2 }, // run-B 的两条 resume 链 (表外, 原样)
      { entry: '未记', runs: 2, attempts: 2 }, // run-C (没传 entry) + 老行 —— 各自成 run, 不互相合并
      { entry: 'run', runs: 1, attempts: 1 }, // run-D (闸拒 → blocked); 顺序 = 首次出现 (created_at)
    ]);
    // runs[] 里每个 run 也带 entry; 没记 entry 的用「未记」, 不编一个 'unknown'。
    expect(r.runs.filter((x) => x.entry === '未记').map((x) => x.run_id)).toEqual(['run-C', '(no-runid):old-1']);
  });
});

describe('omd-readout · criteria 四格 (草案 T6)', () => {
  test('四格互相独立, 和 = DAG 节点总数 (含缺席); reused 优先于 executed 归类', () => {
    const { readoutNow } = makeFixture();
    const g = readoutNow().criteria_grid.four_grid;
    expect(g).toEqual({ executed_success: 4, executed_failure: 2, reused_success: 1, 未记: 1 });
    // 节点全集: g1,g2,x,y,z,f1,d1,old1 = 8 —— 同 id 跨记录只算一格 (并集, 不按记录求和):
    //   g1/g2 在 run-A 两段都执行、y 在 run-B 两段都执行 → 各只算一格; x 复用优先
    //   (seg2 复用, seg1 执行过也归 reused); z 缺席进「未记」; f1/d1 失败。
    expect(g.executed_success + g.executed_failure + g.reused_success + g.未记).toBe(8);
  });
});

describe('omd-readout · 两个风险格 (草案 T7)', () => {
  test('每级一行 executed/not_executed; not_executed 只含记录为 reused 的节点', () => {
    const { readoutNow } = makeFixture();
    expect(readoutNow().criteria_grid.two_grid_risk).toEqual([
      { risk_level: 'read_only', executed: 4, not_executed: 1 }, // g1, f1, d1, old1 执行 · x 复用 (级从 run-B 第一段解析)
      { risk_level: 'scoped_write', executed: 1, not_executed: 0 }, // y
      { risk_level: 'approval_required', executed: 0, not_executed: 0 },
      { risk_level: 'never', executed: 0, not_executed: 0 },
    ]);
    // ⚠ 口径 (审查 F3, 与现有 CLI 一致): 风险级 = commandRiskTier(command) 的纯函数 →
    //   风险格**只统计带 command 的节点**; agent/inproc (g2) 不入格, 但它们在 four_grid 里照数,
    //   不许静默丢。z 缺席 → 归四格「未记」, 不许混进 not_executed (T7)。
  });
});

describe('omd-readout · 判据一致性: {judge, oracle} 四格 (原任务 ③)', () => {
  test('按 runId 去重数, 缺席单列 unrecorded; 不一致的两格单独标', () => {
    const { readoutNow } = makeFixture();
    const r = readoutNow();
    expect(r.criteria_consistency).toEqual({
      agree: 0, oracleFailed: 1, wastedRounds: 0, agreeFail: 0, unrecorded: 4, recorded: 1,
    });
    // run-A (goal): 回填 {judge:true, oracle:false} → judge 说成了而验收命令没过 =
    //   「判据说了不算」(judge 太松)。两条记录同一份 → 按 runId 去重只数 1, 不许按行数数成 2。
    // 其余 4 个 run (dag_resume / dag_run / 没接 entry / 老行) 没有两条判据 → unrecorded,
    //   不编 false/false (三态纪律, 同 dag-record.test.ts)。
    expect(r.runs.find((x) => x.run_id === 'run-A')!.criteria).toEqual({ judge: true, oracle: false });
    expect(r.runs.find((x) => x.run_id === '(no-runid):old-1')!.criteria).toBeNull();
  });
});

/**
 * 复用率(草案 T8;**2026-08-06 大改口径,理由在下面那条用例里**)。
 *
 * 旧实现是"按可证语义推":「节点在 plan 里、**不在执行结果里**、且更早跑过 → 那是复用」。
 * **而那个前提是假的** —— 复用节点**就在结果里**(引擎给它 `skipped: true` 并照常写进
 * `results`)。真数据上那条推断**恒返空集**,读数板于是印出「复用率 **0.0%**」与四格
 * `reused_success **0**`,而同一批记录里 32 条声明过复用、共 ~123 个节点。
 *
 * ⚠ **它的夹具是照着那个假前提造的**(`done: ['y'], reused: ['x']`,x 不进 results),
 *   于是推断在夹具上"работает"、在生产上恒零 ——
 *   **实装与测试一起错、并且互相背书**,正是本仓 CLAUDE.md 警告的那一条。
 *   夹具已改成像真引擎(复用节点进 `results` 并带 `skipped`)。
 */
describe('omd-readout · 复用率 (草案 T8 · 2026-08-06 改口径)', () => {
  test('分子/分母都只认**节点面记了复用的跑**; 空世界 rate = null', () => {
    const { readoutNow } = makeFixture();
    // total 从 8 → 7: 旧分母是 `universe`(plan 全集, 含从未执行的 z), 新分母是
    // **记了这一位的跑里出现过的节点** —— z 那种"在 plan 里但从没跑过"的不该进复用率的分母。
    expect(readoutNow().reuse_rate).toEqual({ reused_nodes: 1, total_nodes: 7, rate: 1 / 7, unknownRuns: 0 });
  });

  test('★★ 老行(声称复用而节点面没标)→ **算不出, 不进分母**, 不许当 0 复用', () => {
    // 这条是这次改口径的**全部意义**: 旧实现把这类跑算成"跑了但没复用", 于是
    // 复用率恒 0.0% —— 一个读起来像"复用根本没在工作"的假零, 而 ⑩ 段按 run 级计数
    // 算出来是 21.9%。**同一页两个数, 而 0 那个是错的。**
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    // 老格式: reused 列 > 0, 而 nodes 里一个 `reused: true` 都没有
    db.run(`INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage, reused)
            VALUES ('old-1', 1, 'p', 2, NULL, 'run-old', 'dag_run', '[["a","b"]]', ?, ?, 2)`, [
      JSON.stringify([
        { id: 'a', kind: 'command', status: 'done', deps: [] },
        { id: 'b', kind: 'command', status: 'done', deps: [] },
      ]),
      '{"conductorIn":0,"conductorOut":0,"leavesIn":0,"leavesOut":0,"leavesCacheHit":0}',
    ]);
    const rr = readout({ db, limit: 50 }).reuse_rate;
    expect(rr.unknownRuns).toBe(1); // ← 单独数
    expect(rr.total_nodes).toBe(0); // ← **不进分母**
    expect(rr.rate).toBeNull(); // ← 算不出, 而不是 0.0%
    rec.close();
    // 空世界: 建了表但一条记录都没有 → 分母 0, rate 是 null 不是 0 (草案 T14 的空世界是成功)。
    const emptyDb = new Database(':memory:');
    createDagRecorder({ db: emptyDb });
    const empty = readout({ db: emptyDb });
    expect(empty.runs).toEqual([]);
    expect(empty.outcome_distribution).toEqual({
      success: 0, 'not-converged': 0, 'oracle-failed': 0, 'delivered-with-red': 0, 'verifier-rejected': 0, blocked: 0,
      'budget-exhausted': 0, cancelled: 0, 'infra-error': 0, 'missing-capability': 0, 'not-needed': 0,
      'empty-result': 0, unclassified: 0, 未记: 0, total: 0,
    });
    expect(empty.entry_distribution).toEqual([]);
    expect(empty.criteria_grid.four_grid).toEqual({ executed_success: 0, executed_failure: 0, reused_success: 0, 未记: 0 });
    expect(empty.criteria_consistency).toEqual({ agree: 0, oracleFailed: 0, wastedRounds: 0, agreeFail: 0, unrecorded: 0, recorded: 0 });
    expect(empty.criteria_grid.two_grid_risk).toEqual([
      { risk_level: 'read_only', executed: 0, not_executed: 0 },
      { risk_level: 'scoped_write', executed: 0, not_executed: 0 },
      { risk_level: 'approval_required', executed: 0, not_executed: 0 },
      { risk_level: 'never', executed: 0, not_executed: 0 },
    ]);
    expect(empty.reuse_rate).toEqual({ reused_nodes: 0, total_nodes: 0, rate: null, unknownRuns: 0 });
  });
});

describe('omd-readout · cost-per-success (原任务 ①, 2026-08-02 补)', () => {
  test('按 entry 分层, 分母按 run 去重: run-A 两条记录 = 1 个 success, usage 求和后除', () => {
    const { readoutNow } = makeFixture();
    const cs = readoutNow().cost_per_success;
    // 顺序与 entry_distribution 一致 (首次出现序)。
    expect(cs.map((x) => x.entry)).toEqual(['solve', 'dag_resume', '未记', 'run']); // 旧词已归一 (t7)
    const goal = cs[0]!;
    expect(goal).toEqual({
      entry: 'solve',
      runs: 1,
      success_runs: 1, // 两条记录、一个 success run —— 分母是 run 数不是行数
      unmeasured_runs: 0,
      tokens: { conductorIn: 20, conductorOut: 40, leavesIn: 1000, leavesOut: 200, leavesCacheHit: 520 },
      tokens_per_success: 1260, // 20+40+1000+200; cacheHit 是折扣标记不进分子
    });
  });

  test('0 个 success → tokens_per_success 是 null (算不出), 不是 0; 记了 0 的 usage 仍进和', () => {
    const { readoutNow } = makeFixture();
    const noSuccess = readoutNow().cost_per_success.find((x) => x.entry === '未记')!;
    expect(noSuccess.runs).toBe(2); // run-C + old-1
    expect(noSuccess.success_runs).toBe(0);
    expect(noSuccess.tokens_per_success).toBeNull();
    expect(noSuccess.unmeasured_runs).toBe(0); // 两跑都记了 usage (全 0) —— 记了 0 ≠ 没记
  });

  test('usage 记坏 (按没记处理) 的 run 进 unmeasured_runs, 不被当 0 加进 tokens', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(
      fakeResult({ planName: 'm', plan: { p1: { goal: 'x' } }, done: ['p1'], usage: { leavesIn: 100, leavesOut: 10 } }),
      { runId: 'm1', entry: 'dag_run', now: 100 },
    );
    // usage 形状坏掉的行 (列恒 NOT NULL, 但记坏了按没记处理 —— readout 的既有防御路径)。
    db.run(
      `INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage, observations, outcome, verification, reused, criteria)
       VALUES ('m2r', 200, '坏usage', 1, NULL, 'm2', 'dag_run', '[["q1"]]', ?, '{"oops":1}', NULL, 'success', NULL, NULL, NULL)`,
      [JSON.stringify([{ id: 'q1', kind: 'inproc', status: 'done', deps: [] }])],
    );
    const cs = readout({ db }).cost_per_success;
    expect(cs).toHaveLength(1);
    expect(cs[0]).toEqual({
      entry: 'run',
      runs: 2,
      success_runs: 2,
      unmeasured_runs: 1, // m2 的 usage 坏了 → 没记, 不是 0
      tokens: { conductorIn: 0, conductorOut: 0, leavesIn: 100, leavesOut: 10, leavesCacheHit: 0 },
      tokens_per_success: 55, // 110 ÷ 2 —— 分子只含已记的 m1
    });
  });
});

describe('omd-readout · 排序与 limit (草案 §2/§4)', () => {
  test('runs 按 first_at 升序; limit 截断; meta 恒定', () => {
    const { db, readoutNow } = makeFixture();
    expect(readoutNow().runs.map((x) => x.run_id)).toEqual(['run-A', 'run-B', 'run-C', 'run-D', '(no-runid):old-1']);
    const r = readoutNow();
    expect(r.meta.readonly).toBe(true);
    expect(r.meta.limit).toBe(20);
    expect(readout({ db, limit: 2 }).runs.map((x) => x.run_id)).toEqual(['run-A', 'run-B']);
  });

  test('只读不写: readout 之后行数与 schema 原样 (meta.readonly 只是自报, 这里才是真证据)', () => {
    const { db, readoutNow } = makeFixture();
    const count = () => (db.query('SELECT COUNT(*) AS n FROM omd_dag_runs').get() as { n: number }).n;
    const tables = () =>
      (db.query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
    expect(count()).toBe(7); // 五 run 七条记录
    const before = { count: count(), tables: tables() };
    readoutNow();
    readoutNow();
    expect(count()).toBe(before.count); // 没插行
    expect(tables()).toEqual(before.tables); // 没建表
  });
});

describe('闸的分母不搭展示窗口的车 (2026-08-03)', () => {
  /**
   * 上线闸里 G3 要「20 次 live」、G4 要「采样 ≥10 次」, 而 run 表按冻结契约只显示**最早 limit 个**。
   * 两者一旦搭在一起: 历史 run 超过 limit 之后, **以后每跑一次都落在窗口外**, 闸的分母永远停在
   * 同一个数 —— 而板上看不出它停了。2026-08-03 连跑三次 live, `--limit 20` 下 entry 分布一动不动。
   *
   * 这条闸钉的就是「展示归展示, 判据归判据」: 把 limit 收到比 run 数还小, 闸的分母**不许跟着缩**。
   */
  test('limit 缩到 1, G3/G4 分母仍是全量 (窗口只截 runs 表)', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    for (let i = 0; i < 4; i++) {
      rec.record(fakeResult({ planName: `图${i}`, plan: { n1: { goal: 'g' } }, done: ['n1'] }), {
        runId: `gr-${i}`,
        entry: 'dag_goal',
        now: 1000 + i,
      });
    }
    const wide = readout({ db, limit: 20 });
    const narrow = readout({ db, limit: 1 });
    expect(narrow.runs.length).toBe(1); // 展示窗口确实缩了
    expect(wide.runs.length).toBe(4);
    // …但闸的分母一个都不许少。
    expect(narrow.gate_denominators.g3LiveRuns).toBe(4);
    expect(narrow.gate_denominators.g3LiveRuns).toBe(wide.gate_denominators.g3LiveRuns);
    expect(narrow.g4_sampling.denominator).toBe(wide.g4_sampling.denominator);
    rec.close();
  });

  test('反向自检: 窗口真的会截 runs 表 (闸不是恒真式)', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    for (let i = 0; i < 3; i++) {
      rec.record(fakeResult({ planName: `图${i}`, plan: { n1: { goal: 'g' } }, done: ['n1'] }), {
        runId: `x-${i}`,
        entry: 'dag_run',
        now: 1000 + i,
      });
    }
    expect(readout({ db, limit: 1 }).runs.length).toBe(1);
    expect(readout({ db, limit: 9 }).runs.length).toBe(3);
    rec.close();
  });

  test('ledgerGap: 注入夹具没有盘上兄弟库 → null (不知道), 不编 0', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(fakeResult({ planName: '图', plan: { n1: { goal: 'g' } }, done: ['n1'] }), {
      runId: 'r',
      entry: 'dag_goal',
      now: 1000,
    });
    // 编 0 会把"没查成"说成"没有" —— 本仓 S-12 那条纪律明确禁止。
    expect(readout({ db }).gate_denominators.ledgerGap).toBeNull();
    rec.close();
  });
});

// ── S-1 片d: 建议接受率聚合 (2026-08-04) ─────────────────────────────────────

import { aggregateSuggestionAcceptance } from '../../scripts/omd-readout';
import { renderMapMarkdown as renderForSugg } from './pathfinder/map-store';
import { mkdtempSync as mkdtempSugg, mkdirSync as mkdirSugg, writeFileSync as writeSugg, rmSync as rmSugg } from 'node:fs';
import { tmpdir as tmpdirSugg } from 'node:os';
import { join as joinSugg } from 'node:path';

describe('omd-readout · 建议接受率 (S-1 片d)', () => {
  test('聚合多图 suggestionsLog: rate=(accepted+edited)/decided, deduped 单列; 无处置史 → null', () => {
    const cwd = mkdtempSugg(joinSugg(tmpdirSugg(), 'sugg-acc-'));
    const dir = joinSugg(cwd, 'docs', 'plan', 'pathfinder');
    mkdirSugg(dir, { recursive: true });
    writeSugg(joinSugg(dir, 'a.md'), renderForSugg({
      destination: 'A', slug: 'a', tickets: [], decisionsLog: [],
      suggestionsLog: [
        { ticketId: 's1', outcome: 'accepted', at: 't', runId: 'r1' },
        { ticketId: 's2', outcome: 'edited', at: 't', runId: 'r1' },
        { ticketId: 's3', outcome: 'rejected', at: 't', runId: 'r1' },
        { ticketId: 't0', outcome: 'deduped', at: 't', runId: 'r1' },
      ],
    }));
    writeSugg(joinSugg(dir, 'b.md'), renderForSugg({
      destination: 'B', slug: 'b', tickets: [], decisionsLog: [],
      suggestionsLog: [{ ticketId: 's1', outcome: 'rejected', at: 't', runId: 'r2' }],
    }));
    const sa = aggregateSuggestionAcceptance(cwd)!;
    // t3: pending=0 (fixture 图上无 suggested 存量); dedupe_rate = 1/(1+4+0) = 0.2
    expect(sa).toEqual({ decided: 4, accepted: 1, edited: 1, rejected: 2, deduped: 1, pending: 0, rate: 0.5, dedupe_rate: 0.2 });
    rmSugg(cwd, { recursive: true, force: true });
  });

  test('图目录不存在 / 有图无台账 → null (「没数据」≠ 0%)', () => {
    const cwd = mkdtempSugg(joinSugg(tmpdirSugg(), 'sugg-acc-'));
    expect(aggregateSuggestionAcceptance(cwd)).toBeNull();
    const dir = joinSugg(cwd, 'docs', 'plan', 'pathfinder');
    mkdirSugg(dir, { recursive: true });
    writeSugg(joinSugg(dir, 'a.md'), renderForSugg({ destination: 'A', slug: 'a', tickets: [], decisionsLog: [] }));
    expect(aggregateSuggestionAcceptance(cwd)).toBeNull();
    rmSugg(cwd, { recursive: true, force: true });
  });
});

/**
 * ⑧.5 「声称 vs 引擎记录」检出器的活体读数(2026-08-05)。
 *
 * 这一段的口径**已经错过一次**:交接文里原本写「`observations: []` = 记了零检出,可进分母」——
 * 而 `dag_run` 那条路整张图可以一个 conductor 节点都没有,判据结构上够不着,账本记出来一模一样。
 * 按 entry 数约一半流量因此进错分母,基率会被算低近一倍。所以这里钉的是**分母怎么数**。
 */
describe('omd-readout · ⑧.5 检出器活体读数的分母', () => {
  const withCC = (
    runId: string,
    claimCheck: { conductor: { rounds: number; nodes: number; findings: number }; flat: { nodes: number; findings: number } } | undefined,
    observations?: { kind: string; nodes: string[]; message?: string }[],
  ) => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(
      {
        ...fakeResult({ planName: 'p', plan: { a: { goal: 'x' } }, done: ['a'], reused: [], usage: {} }),
        ...(claimCheck ? { claimCheck } : {}),
        ...(observations ? { observations } : {}),
      } as never,
      { runId, entry: 'dag_run', now: 1000 },
    );
    return readout({ db, limit: 50 }).claim_check;
  };

  test('★ 没记这一位 → 进 unrecorded, **不进分母**(不是零检出)', () => {
    const cc = withCC('r1', undefined);
    expect(cc.recordedRuns).toBe(0);
    expect(cc.unrecordedRuns).toBe(1);
    expect(cc.conductor.rate).toBeNull(); // 算不出 ≠ 0%
    expect(cc.flat.rate).toBeNull();
  });

  test('记了且零检出 → 进分母, 比例是**真的 0%**(与上一条分得开)', () => {
    const cc = withCC('r2', { conductor: { rounds: 1, nodes: 4, findings: 0 }, flat: { nodes: 2, findings: 0 } });
    expect(cc.recordedRuns).toBe(1);
    expect(cc.unrecordedRuns).toBe(0);
    expect(cc.conductor.rate).toBe(0);
    expect(cc.flat.rate).toBe(0);
  });

  test('★ 两面各算各的比例 —— 宽度不同, **不许相加**', () => {
    const cc = withCC('r3', { conductor: { rounds: 2, nodes: 4, findings: 1 }, flat: { nodes: 10, findings: 1 } });
    expect(cc.conductor.rate).toBeCloseTo(0.25, 5);
    expect(cc.flat.rate).toBeCloseTo(0.1, 5);
    // 合并口径 (2/14 ≈ 0.143) 两边都不是 —— 它没有意义, 所以读数板压根不提供这个数。
    expect(cc.conductor.rate).not.toBeCloseTo(2 / 14, 5);
  });

  test('★ 检出原句捞得出来(拨闸靠逐条读它判是不是误伤)', () => {
    const cc = withCC(
      'r4',
      { conductor: { rounds: 1, nodes: 1, findings: 1 }, flat: { nodes: 0, findings: 0 } },
      [{ kind: 'unsupported-claim', nodes: ['n1'], message: '[引擎记录核对 · 只报不拦] n1 有 1 处「本次已由引擎实测通过」' }],
    );
    expect(cc.samples).toHaveLength(1);
    expect(cc.samples[0]!.message).toContain('实测通过');
    expect(cc.samples[0]!.runId).toBe('r4');
  });

  test('别的 kind 的观察不进这段样本(它问的是这一条判据)', () => {
    const cc = withCC(
      'r5',
      { conductor: { rounds: 1, nodes: 1, findings: 0 }, flat: { nodes: 0, findings: 0 } },
      [{ kind: 'loop-no-artifact-change', nodes: ['n1'], message: '盘上没位移' }],
    );
    expect(cc.samples).toEqual([]);
  });

  // ── 样本量门槛 (2026-08-05, **在数据到达之前**钉的) ────────────────────────────
  //
  // 上面那组钉的是「分母怎么数」, 这一组钉的是「分母多大才够下结论」。缺了后者, 读数板在
  // N=2 个节点时也会印出一个 0.0% —— 而等数攒起来再定"多少算够"就是事后编判据 (§五 第 1 条)。
  // 证伪: 把 CLAIM_CHECK_MIN_NODES 改成 0 → 「不足」那两条当场红 (short/enough 全翻)。

  test('★ 样本不足时 enough=false, 且**自己算出还差多少**(不靠人心算)', () => {
    const cc = withCC('r6', { conductor: { rounds: 1, nodes: 4, findings: 0 }, flat: { nodes: 2, findings: 0 } });
    expect(cc.sufficiency.conductor).toEqual({ nodes: 4, short: CLAIM_CHECK_MIN_NODES - 4, enough: false });
    expect(cc.sufficiency.flat).toEqual({ nodes: 2, short: CLAIM_CHECK_MIN_NODES - 2, enough: false });
    // ⚠ 比例照常算得出 —— 「算得出」与「够得着结论」是两件事, 不许把前者当后者。
    expect(cc.flat.rate).toBe(0);
  });

  test('★ 两面**各自**判够不够 —— 一面够了不代表另一面够了', () => {
    const cc = withCC('r7', {
      conductor: { rounds: 1, nodes: CLAIM_CHECK_MIN_NODES, findings: 0 },
      flat: { nodes: 1, findings: 0 },
    });
    expect(cc.sufficiency.conductor.enough).toBe(true);
    expect(cc.sufficiency.conductor.short).toBe(0);
    expect(cc.sufficiency.flat.enough).toBe(false);
  });

  test('边界: 恰好等于门槛就算够 (>=, 不是 >)', () => {
    expect(faceSufficiency(CLAIM_CHECK_MIN_NODES).enough).toBe(true);
    expect(faceSufficiency(CLAIM_CHECK_MIN_NODES - 1).enough).toBe(false);
    expect(faceSufficiency(CLAIM_CHECK_MIN_NODES - 1).short).toBe(1);
  });

  test('没记这一位的跑 → 两面都是 0 节点, 即「不足」而不是「够了且零检出」', () => {
    const cc = withCC('r8', undefined);
    expect(cc.sufficiency.flat).toEqual({ nodes: 0, short: CLAIM_CHECK_MIN_NODES, enough: false });
  });
});

/**
 * ⑧ 段「产物没变」判据的**分母**(2026-08-06)。
 *
 * 与上一段是同一条纪律的第二个实例,而这次错得更久:⑧ 段一直只有分子。判词写着
 * 「长期 0 次 → 别再加检测器」,而"长期"被默读成了**运行次数** —— 可这条判据住在 conductor
 * 内环,一次比较要同时有上一轮 + 两轮都有产物信号。单轮档的 `dag_run` 与首轮即绿的 goal
 * 一次机会都没有,于是 53 跑 0 命中是「够不着」而不是「查过零检出」。
 *
 * 同表其他 kind 有数**不能反证它够得着**:`undeclared-artifact-dep`/`write-race` 是跑前静态判死,
 * `leaf-spin` 在 leaf 自己的工具循环里 —— 三条没有一条经过跨轮那条路。
 */
describe('omd-readout · ⑧ 「产物没变」判据的分母 (2026-08-06)', () => {
  const withAM = (runId: string, artifactMove: { transitions: number; unobserved: number; findings: number } | undefined) => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(
      {
        ...fakeResult({ planName: 'p', plan: { a: { goal: 'x' } }, done: ['a'], reused: [], usage: {} }),
        ...(artifactMove ? { artifactMove } : {}),
      } as never,
      { runId, entry: 'dag_run', now: 1000 },
    );
    return readout({ db, limit: 50 }).artifact_move;
  };

  test('★ 没记这一位 → 进 unrecorded, rate=null(**算不出 ≠ 0%**)', () => {
    const am = withAM('m1', undefined);
    expect(am.recordedRuns).toBe(0);
    expect(am.unrecordedRuns).toBe(1);
    expect(am.rate).toBeNull();
  });

  test('★ 记了但一次跨轮都没发生 → recorded=1 而 comparable=0, rate 仍是 null', () => {
    // 这一格与上一格在旧读数板里长得一模一样 (都只表现为"0 次命中"), 而下一步相反:
    // 上一格要跑一次新的才有数, 这一格已经在说话了 —— 它说的是"这条判据够不着"。
    const am = withAM('m2', { transitions: 0, unobserved: 0, findings: 0 });
    expect(am.recordedRuns).toBe(1);
    expect(am.comparable).toBe(0);
    expect(am.rate).toBeNull();
  });

  test('★ 基率分母是 comparable, **不是** transitions —— 判不了的那些不许充数', () => {
    const am = withAM('m3', { transitions: 10, unobserved: 6, findings: 1 });
    expect(am.comparable).toBe(4);
    expect(am.rate).toBeCloseTo(0.25, 5); // 1/4, 不是 1/10
    expect(am.rate).not.toBeCloseTo(0.1, 5);
  });

  test('★ 三个槽各自判够不够 —— 三个 0 的下一步相反, 不许合成一句「样本不足」', () => {
    // 证伪: 把 LOOP_NO_MOVE_MIN_N 改成 0 → 「不足」那两条当场红 (enough 全翻)。
    const am = withAM('m4', { transitions: LOOP_NO_MOVE_MIN_N, unobserved: LOOP_NO_MOVE_MIN_N, findings: 0 });
    expect(am.sufficiency.transitions.enough).toBe(true); // 轮转够了: population 闸吃掉多少可以判了
    expect(am.sufficiency.comparable.enough).toBe(false); // 但一次都没判得了 → 基率仍不许读
    expect(am.sufficiency.comparable.short).toBe(LOOP_NO_MOVE_MIN_N);
    expect(am.sufficiency.runs.enough).toBe(false); // 才 1 跑
  });

  test('边界: 恰好等于门槛就算够 (>=, 不是 >), 且门槛与 ⑧.5 那个是两个常量', () => {
    expect(faceSufficiency(LOOP_NO_MOVE_MIN_N, LOOP_NO_MOVE_MIN_N).enough).toBe(true);
    expect(faceSufficiency(LOOP_NO_MOVE_MIN_N - 1, LOOP_NO_MOVE_MIN_N).short).toBe(1);
    // 今天两处同数 (同一套比价), 但**各写一个常量** —— 以后其中一个该改时不该拖着另一个。
    expect(faceSufficiency(5, LOOP_NO_MOVE_MIN_N).short).toBe(LOOP_NO_MOVE_MIN_N - 5);
  });
});

/**
 * ⑧.6 运行时写竞争 —— 这条通道 2026-08-06 之前**根本不存在**。
 *
 * 台账把「leaf 级写竞争频率」标成「等读数」,而 ⑧ 段那 4 次 `write-race` 出自 `static-lint`
 * (跑之前按 `output_path` 声明判死的坏 plan)。**同名不同义**,而两者的下一步相反 ——
 * 交接 30 §五 第 2 条。再等也不会有数,因为没有一行代码写它。
 */
describe('omd-readout · ⑧.6 运行时写竞争的分母 (2026-08-06)', () => {
  const withWR = (
    runId: string,
    writeRace:
      | { overlaps: number; pairs: number; findings: number; pairsInferred?: number; findingsInferred?: number }
      | undefined,
  ) => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(
      {
        ...fakeResult({ planName: 'p', plan: { a: { goal: 'x' } }, done: ['a'], reused: [], usage: {} }),
        ...(writeRace ? { writeRace } : {}),
      } as never,
      { runId, entry: 'dag_run', now: 1000 },
    );
    return readout({ db, limit: 50 }).write_race;
  };

  test('★ 没记 → 进 unrecorded, rate=null', () => {
    const wr = withWR('w1', undefined);
    expect(wr.recordedRuns).toBe(0);
    expect(wr.unrecordedRuns).toBe(1);
    expect(wr.rate).toBeNull();
  });

  test('★ 记了但没并发 (overlaps:0) → recorded=1 而 rate 仍是 null —— 与上一格分得开', () => {
    const wr = withWR('w2', { overlaps: 0, pairs: 0, findings: 0 });
    expect(wr.recordedRuns).toBe(1);
    expect(wr.overlaps).toBe(0);
    expect(wr.rate).toBeNull();
  });

  test('★ 撞车基率的分母是 pairs, **不是** overlaps —— 看不见的那部分不许充数', () => {
    const wr = withWR('w3', { overlaps: 10, pairs: 4, findings: 1 });
    expect(wr.rate).toBeCloseTo(0.25, 5); // 1/4, 不是 1/10
    expect(wr.rate).not.toBeCloseTo(0.1, 5);
  });

  test('★ 两个槽各自判 —— 「有并发但看不见谁写了什么」与「有机会但没撞上」下一步不同', () => {
    const wr = withWR('w4', { overlaps: LOOP_NO_MOVE_MIN_N, pairs: 0, findings: 0 });
    expect(wr.sufficiency.overlaps.enough).toBe(true); // 并发这件事本身可以判了
    expect(wr.sufficiency.pairs.enough).toBe(false); // 但一次机会都没有 → 基率仍不许读
  });

  /**
   * **推断口径**(2026-08-06 补:写的可见性)。
   *
   * `filesTouched` 只认受控写工具,于是 command 节点那一路从不填、agent 的 bash 写也隐形 ——
   * 「看不见的那部分」里混着一大块其实**认得出**的写。补上之后两档必须**分得开**:
   * 推断那一档的证据更弱(`a && b > x` 里 a 失败时 x 并没有被写),而升不升闸恰恰要看这个分野。
   */
  test('★ 老行没记推断口径 → null(**没记 ≠ 0**),严格那两个照常读得出', () => {
    const wr = withWR('w5', { overlaps: 5, pairs: 2, findings: 1 });
    expect(wr.pairs).toBe(2);
    expect(wr.pairsInferred).toBeNull();
    expect(wr.findingsInferred).toBeNull();
    expect(wr.rateInferred).toBeNull();
  });

  test('★ 两档分开算 —— 推断口径更宽,而严格那两个**一个字都不许变**', () => {
    // 证伪: 让 readout 把 pairsInferred 累加进 pairs → 这条第一行当场红。
    const wr = withWR('w6', { overlaps: 10, pairs: 2, findings: 0, pairsInferred: 8, findingsInferred: 3 });
    expect(wr.pairs).toBe(2); // 严格: command/bash 那侧看不见
    expect(wr.findings).toBe(0);
    expect(wr.rate).toBe(0); // 严格口径查过零检出
    expect(wr.pairsInferred).toBe(8); // 推断: 把认得出的写并进来
    expect(wr.findingsInferred).toBe(3);
    expect(wr.rateInferred).toBeCloseTo(3 / 8, 5);
    // 这一行是本用例的全部意义: 「只有推断才看得见」的那一块单独有大小, 不许被合并掉
    expect(wr.pairsInferred! - wr.pairs).toBe(6);
  });

  test('★ 记了推断口径且为 0 → 是 0 不是 null(与"老行没记"分得开)', () => {
    const wr = withWR('w7', { overlaps: 3, pairs: 0, findings: 0, pairsInferred: 0, findingsInferred: 0 });
    expect(wr.pairsInferred).toBe(0); // 记了, 只是一次机会都没有
    expect(wr.rateInferred).toBeNull(); // 分母 0 → 算不出
    expect(wr.pairsInferred).not.toBeNull(); // ← 与上面 w5 那条相反, 两格不许被抹平
  });

  /**
   * command 节点这一侧写不写文件 —— 「推断口径为什么不涨」的先行答案。
   *
   * 那个 0 有两种成因,下一步相反:判据太窄(该收窄盲点)vs **这些命令本来就不写文件**。
   * 实测(2026-08-06,258 次执行 / 113 条不重复命令):认得出写目标的 **0 条**,
   * 而拆开看全是 grep/rg/cat/`bun test`/`tsc` —— 这台引擎的 command leaf 就是拿来读和断言的。
   */
  test('★ command 节点全是读和断言 → withTargets=0, 而那是**正确的零**不是判据漏认', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(
      fakeResult({
        planName: 'p',
        plan: {
          a: { goal: 'x', executor: 'command', command: 'grep -q FOO src/a.ts' },
          b: { goal: 'y', executor: 'command', command: 'bun test && bunx tsc --noEmit' },
        },
        done: ['a', 'b'],
      }),
      { runId: 'cw1', entry: 'dag_run', now: 1000 },
    );
    const cw = readout({ db, limit: 50 }).write_race.commandWrites;
    expect(cw.commands).toBe(2);
    expect(cw.distinct).toBe(2);
    expect(cw.withTargets).toBe(0);
  });

  test('★ command 节点真写文件时 withTargets 数得出来 —— 证明上面那个 0 不是恒 0', () => {
    // 反向自检: 少了这条, 上面那条与"判据整个失灵"逐字相同 (一条永远绿的闸不是闸)。
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(
      fakeResult({
        planName: 'p',
        plan: {
          a: { goal: 'x', executor: 'command', command: 'echo hi > out/note.md' },
          b: { goal: 'y', executor: 'command', command: 'grep -q FOO src/a.ts' },
        },
        done: ['a', 'b'],
      }),
      { runId: 'cw2', entry: 'dag_run', now: 1000 },
    );
    const cw = readout({ db, limit: 50 }).write_race.commandWrites;
    expect(cw.withTargets).toBe(1); // 只有重定向那条
  });

  test('推断机会也有自己的门槛槽 —— 三个 0 的下一步各不相同', () => {
    const wr = withWR('w8', {
      overlaps: LOOP_NO_MOVE_MIN_N, pairs: 0, findings: 0, pairsInferred: LOOP_NO_MOVE_MIN_N, findingsInferred: 0,
    });
    expect(wr.sufficiency.overlaps.enough).toBe(true);
    expect(wr.sufficiency.pairs.enough).toBe(false); // 严格口径仍不够
    expect(wr.sufficiency.pairsInferred.enough).toBe(true); // 推断口径够了 → 那一档的基率可以读
  });
});

/**
 * **老库(缺后加的列)不许把读数板打崩**(2026-08-06 收尾自查时撞到的)。
 *
 * `readout()` 的注释一直写着「老库可能缺后加的列 → 查一次 pragma 再拼」,而它
 * **只对一部分列这么做了**:`run_id` 同样是后加的列,却躺在**必选**那一半。
 * 于是一个 `createDagRecorder` 认得、打开就会自动迁移的老库,在**只读**的读数板上直接崩
 * (`dag-record.test.ts` 里就有一个正是这种 schema 的夹具)。
 *
 * **读侧不迁移,所以读侧必须容忍。** 只有建表那一刻就有的列
 * (`id`/`created_at`/`levels`/`nodes`/`usage`)才留在必选那一半。
 */
describe('omd-readout · 老库兼容 (只读侧不迁移, 所以必须容忍)', () => {
  test('★ 建表期那套最小 schema(无 run_id / 无任何后加列)→ **跑得出来, 不崩**', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE omd_dag_runs (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
        node_count INTEGER NOT NULL, question TEXT, levels TEXT NOT NULL,
        nodes TEXT NOT NULL, usage TEXT NOT NULL
      )
    `);
    db.run(
      `INSERT INTO omd_dag_runs VALUES ('old-1', 1, '老图', 1, NULL, '[["n1"]]', ?, ?)`,
      [
        JSON.stringify([{ id: 'n1', kind: 'command', status: 'done', deps: [] }]),
        '{"conductorIn":0,"conductorOut":0,"leavesIn":0,"leavesOut":0,"leavesCacheHit":0}',
      ],
    );
    const r = readout({ db, limit: 50 });
    expect(r.runs.length).toBe(1);
    // 后加的那些位全部**如实为「没记」**, 而不是编一个 0 出来
    expect(r.rollback.recordedRuns).toBe(0);
    expect(r.rollback.unrecordedRuns).toBe(1);
    expect(r.write_race.recordedRuns).toBe(0);
    expect(r.artifact_move.recordedRuns).toBe(0);
    expect(r.runs[0]!.entry).toBe('未记');
  });
});

/**
 * **「记了但读不出」≠「没记」** —— 坏 JSON 与 NULL 列必须落两个不同的格(2026-08-06 补网)。
 *
 * 这是本仓最在意的那条区分(CLAUDE.md 第 1 条:`NULL` ≠ 0 ≠ 不适用),而读数板那几个
 * `catch` 里的行为**此前没有任何一条闸钉着**。查过之后行为是**对的** —— 但对而没网,
 * 下次有人"顺手"把 catch 里改成 `unrecorded++` 就静默塌了,而那正好把
 * **缺陷(记坏了)伪装成历史(还没记)**:前者要去查谁写坏的,后者只要等。
 */
describe('omd-readout · 坏 JSON 算「记了但读不出」, 不算「没记」', () => {
  const world = (claim: string | null, am: string | null, wr: string | null, rb: string | null) => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE omd_dag_runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
      node_count INTEGER NOT NULL, question TEXT, run_id TEXT, entry TEXT, levels TEXT NOT NULL, nodes TEXT NOT NULL,
      usage TEXT NOT NULL, observations TEXT, outcome TEXT, claim_check TEXT, artifact_move TEXT, write_race TEXT, rollback TEXT)`);
    db.run(
      `INSERT INTO omd_dag_runs VALUES ('r1',1,'p',1,NULL,'run-1','dag_run','[["n1"]]',?,?,NULL,'success',?,?,?,?)`,
      [
        JSON.stringify([{ id: 'n1', kind: 'command', status: 'done', deps: [] }]),
        '{"conductorIn":0,"conductorOut":0,"leavesIn":0,"leavesOut":0,"leavesCacheHit":0}',
        claim, am, wr, rb,
      ],
    );
    return readout({ db, limit: 50 });
  };

  test('★ 坏 JSON → **recorded** 那一格(它记了,只是读不出)', () => {
    const r = world('{坏', '{坏', '{坏', '{坏');
    expect(r.artifact_move.recordedRuns).toBe(1);
    expect(r.artifact_move.unrecordedRuns).toBe(0);
    expect(r.write_race.recordedRuns).toBe(1);
    expect(r.rollback.recordedRuns).toBe(1);
    // rollback 还要落进 unknown —— **不许落 clean**(那会让 owner 以为有退路)
    expect(r.rollback.byKind.unknown).toBe(1);
    expect(r.rollback.byKind.clean).toBe(0);
  });

  test('★ 列为 NULL → **unrecorded** 那一格(这一跑压根没记)', () => {
    const r = world(null, null, null, null);
    expect(r.artifact_move.unrecordedRuns).toBe(1);
    expect(r.artifact_move.recordedRuns).toBe(0);
    expect(r.write_race.unrecordedRuns).toBe(1);
    expect(r.rollback.unrecordedRuns).toBe(1);
    // 这一行是两条用例合起来的意义: 「没记」不许被算成 unknown ——
    // 前者只要等, 后者要去查谁写坏的, 下一步不一样。
    expect(r.rollback.byKind.unknown).toBe(0);
  });

  test('坏 JSON 不许把整块读数打崩 (fail-open, 其余段照常出数)', () => {
    const r = world('{坏', '{坏', '{坏', '{坏');
    expect(r.runs.length).toBe(1);
    expect(r.outcome_distribution.success).toBe(1);
  });
});

/**
 * ⓪ **今天哪几格能下结论** —— 导航的分桶(2026-08-06)。
 *
 * 这块板 400+ 行,一大半是"在等数据"的段。加导航的理由与本仓治的那些静默失效同源:
 * **一份没人读得完的读数板等于没有**。
 *
 * 这组用例钉的是**分桶不许串**:「有答案」与「在等」下一步完全不同(据此决策 vs 继续攒),
 * 而把一格放错桶,读的人要么白等、要么拿一个还不能读的数去做决定。
 */
describe('omd-readout · ⓪ 导航分桶 (2026-08-06)', () => {
  /** 空世界当底,逐格改成想要的形状 —— 只测分桶,不测各段自己的算法。 */
  const base = (): ReadoutResult => readout({ db: new Database(':memory:'), limit: 50 });

  test('★ 空世界 → 一格都不"能下结论", 而那本身是读数(不是错误)', () => {
    const { ready } = summarizeFaces(base());
    expect(ready).toHaveLength(0);
  });

  test('★ ⑬ 有数就进「能下结论」—— 「有没有退路」不需要攒到 60', () => {
    // 与门槛型的那几格刻意不同: 每一跑的 rollback 都是一次**完整的**判断, 不是一次采样。
    const c = base();
    c.rollback = { ...c.rollback, recordedRuns: 3, byKind: { ...c.rollback.byKind, clean: 0, 'dirty-tracked': 3 } };
    const { ready, waiting } = summarizeFaces(c);
    expect(ready.some((l) => l.includes('⑬'))).toBe(true);
    expect(ready.some((l) => l.includes('一次都没有'))).toBe(true); // clean=0 要点破
    expect(waiting.some((l) => l.includes('⑬'))).toBe(false); // 不许同时出现在两个桶
  });

  test('★ ⑬ 一跑没记 → 进「在等」, 且提示**重连 MCP**(那是最常见的真因)', () => {
    const { ready, waiting } = summarizeFaces(base());
    expect(waiting.some((l) => l.includes('⑬') && l.includes('重连 MCP'))).toBe(true);
    expect(ready.some((l) => l.includes('⑬'))).toBe(false);
  });

  test('★ 门槛型的几格: 不够 → 「在等」, 够了 → **不再出现在等待列表**', () => {
    const c = base();
    c.write_race = { ...c.write_race, pairs: LOOP_NO_MOVE_MIN_N, sufficiency: { ...c.write_race.sufficiency, pairs: faceSufficiency(LOOP_NO_MOVE_MIN_N, LOOP_NO_MOVE_MIN_N) } };
    expect(summarizeFaces(c).waiting.some((l) => l.includes('⑧.6'))).toBe(false);
    expect(summarizeFaces(base()).waiting.some((l) => l.includes('⑧.6'))).toBe(true);
  });

  test('★★ 判据轴的**非零检出**直接进「能下结论」—— 它不受 60 那个门槛管', () => {
    // 2026-08-06 建 ⓪ 时**漏了这一格**, 而漏的原因值得记: 我只按门槛型的格子想了。
    // `LOOP_NO_MOVE_MIN_N = 60` 管的是**把 0 读成基率**要多少样本 (rule of three);
    // 而「judge 太紧 4 次」是**非零检出** —— 已经发生了 4 次, 不需要再攒到 60 才算数。
    // 混着用的代价: 一条真实存在的浪费被"样本不足"挡在导航外, 埋在 430 行板子的中段。
    const c = base();
    c.criteria_axis = { ...c.criteria_axis, wastedRounds: 4, recorded: 13 };
    const { ready } = summarizeFaces(c);
    expect(ready.some((l) => l.includes('判据轴') && l.includes('4/13') && l.includes('judge 比确定性判据严'))).toBe(true);
    // ⚠ **不许再说"白转了几轮"**(2026-08-06 核代码改的): `acceptance.command` 作为
    //   `freezeCriterion` 传进内环, 而内环**判据绿就直接收敛、judge 的票只记录** ——
    //   那几次**一轮都没白转**。它量的是 judge 的**校准**, 而它的价值在反面:
    //   要是只有 judge 没有判据, 这几次就会一直转到轮数耗尽。
    expect(summarizeFaces(c).ready.join('')).not.toContain('白转了几轮'); // ← 钉那句误导的原话
    expect(summarizeFaces(c).ready.join('')).toContain('没白转'); // 并正面说出来
  });

  test('★ 判据轴两格都为 0 → **不进任何桶** (它不是"在等", 是查过没有)', () => {
    const c = base();
    c.criteria_axis = { ...c.criteria_axis, wastedRounds: 0, oracleFailed: 0, recorded: 13 };
    const { ready, waiting } = summarizeFaces(c);
    expect(ready.some((l) => l.includes('判据轴'))).toBe(false);
    expect(waiting.some((l) => l.includes('判据轴'))).toBe(false);
  });

  test('★ ⑧.1 ① 只要有跑就能下结论 —— 它只看 kind, **可回溯**', () => {
    const c = base();
    c.loop_shape = { ...c.loop_shape, runsWithoutConductor: 7, runsWithConductor: 3 };
    expect(summarizeFaces(c).ready.some((l) => l.includes('⑧.1 ①') && l.includes('7/10'))).toBe(true);
  });
});

/**
 * ⑧.7 回溯重建的写竞争(2026-08-06)。
 *
 * 这一面的**全部价值**是「历史里已经有答案,不用等新跑」。所以这组用例的重心是两条:
 * ① 它**必须复用** `detectRuntimeWriteRace`(父子守卫白拿,两处各算一份必漂);
 * ② 输入**必须按 runId 分好组** —— `outputPaths` 相对该 run 的根,把两个 run 混进一个
 *    数组会**凭空造出撞车**,而那个约束在类型上表达不出来。
 */
describe('omd-readout · ⑧.7 回溯重建的写竞争 (2026-08-06)', () => {
  const st = { dirs: 1, checkpoints: 2, checkpointsWithPaths: 2 };
  const w = (id: string, startMs: number, endMs: number, paths: string[]): NodeWindow => ({ id, startMs, endMs, paths });

  test('★ 窗口重叠 + 两侧都写了同一个文件 → 撞车', () => {
    const r = reconstructWriteRace([{ runId: 'r1', nodes: [w('a', 0, 100, ['x.md']), w('b', 50, 150, ['x.md'])] }], st);
    expect(r.overlaps).toBe(1);
    expect(r.pairs).toBe(1);
    expect(r.findings).toBe(1);
    expect(r.clean.rate).toBe(1);
    expect(r.samples[0]).toMatchObject({ runId: 'r1', shared: ['x.md'], multiRound: false });
  });

  test('★ 窗口不重叠 → 一格都不进 (串行不是竞争)', () => {
    const r = reconstructWriteRace([{ runId: 'r1', nodes: [w('a', 0, 50, ['x.md']), w('b', 50, 150, ['x.md'])] }], st);
    expect(r.overlaps).toBe(0); // 首尾相接**不算**重叠 (半开区间)
    expect(r.findings).toBe(0);
    expect(r.clean.rate).toBeNull();
  });

  test('★ 父子对**一格都不进** —— 守卫是从 detectRuntimeWriteRace 白拿的', () => {
    // 这条同时钉着"复用而不是重写": 这里一行守卫代码都没有, 它照样得滤掉。
    // 实测代价: 不带守卫时历史上 46 条"撞车"里 45 条是这种父子对。
    const r = reconstructWriteRace([{ runId: 'r1', nodes: [w('C', 0, 200, ['x.md']), w('C::kid', 10, 100, ['x.md'])] }], st);
    expect(r.overlaps).toBe(0);
    expect(r.findings).toBe(0);
  });

  test('★ 一侧没报写 → 算重叠但**不算机会** (同 ⑧.6 的三态)', () => {
    const r = reconstructWriteRace([{ runId: 'r1', nodes: [w('a', 0, 100, ['x.md']), w('b', 50, 150, [])] }], st);
    expect(r.overlaps).toBe(1);
    expect(r.pairs).toBe(0);
    expect(r.clean.rate).toBeNull();
  });

  test('★★ 两个**不同 run** 的同名路径**不是**撞车 —— 按 runId 分组是硬约束', () => {
    // `outputPaths` 相对该 run 的根: 两个 run 里的 `src/a.ts` 是两回事。
    // 调用方把它们混进一个数组就会凭空造出撞车 —— 而类型表达不出这个约束, 所以用例钉着它。
    const grouped = reconstructWriteRace(
      [{ runId: 'r1', nodes: [w('a', 0, 100, ['src/a.ts'])] }, { runId: 'r2', nodes: [w('b', 0, 100, ['src/a.ts'])] }],
      st,
    );
    expect(grouped.findings).toBe(0); // 分了组 → 各自只有一个节点, 连对都配不出来

    const mixed = reconstructWriteRace(
      [{ runId: '混着的', nodes: [w('a', 0, 100, ['src/a.ts']), w('b', 0, 100, ['src/a.ts'])] }],
      st,
    );
    expect(mixed.findings).toBe(1); // ← 混进一个数组就报了。这就是那条约束的代价
  });

  test('★★ 多轮跑的数落在 **ambiguous** 面, **不许并进可信面**', () => {
    // 2026-08-06 核第一条 finding 时撞到的: `NodeCheckpoint` **不记轮次**, 而 checkpoint 按
    // nodeId **覆写** —— 多轮跑里两份可能来自**不同的轮**, 配成一对就是**跨轮伪影**,
    // 而"两个节点在不同轮里各跑一次"根本不是并发。
    // ⚠ 实测代价: 历史上唯一那条撞车**整条落在这一面** (单轮面 0/21, 多轮面 1/9) ——
    //   合着读就会把一条排除不掉伪影的证据说成"并发写竞争确实发生"。
    const r = reconstructWriteRace(
      [
        { runId: 'single', nodes: [w('a', 0, 100, ['x.md']), w('b', 50, 150, ['y.md'])] },
        { runId: 'multi', multiRound: true, nodes: [w('a', 0, 100, ['z.md']), w('b', 50, 150, ['z.md'])] },
      ],
      st,
    );
    expect(r.clean).toMatchObject({ pairs: 1, findings: 0, rate: 0 }); // 可信面: 查过零检出
    expect(r.ambiguous).toMatchObject({ runs: 1, pairs: 1, findings: 1 }); // 不可信面: 单独摆
    expect(r.samples[0]!.multiRound).toBe(true); // 样本要标出它落在哪一面
  });

  test('★★ 两侧都有轮次且**不同轮** → 不算一对 (跨轮伪影的直接修法)', () => {
    // checkpoint 按 nodeId 覆写, 多轮跑里两份可能来自不同的轮 —— 而"两个节点在不同轮里
    // 各跑一次"根本不是并发。2026-08-06 起 `NodeCheckpoint.round` 记下了轮次, 于是排得掉。
    const diff = reconstructWriteRace(
      [{ runId: 'r', multiRound: true, roundsKnown: true, nodes: [
        { ...w('C::a', 0, 100, ['x.md']), round: 1 },
        { ...w('C::b', 50, 150, ['x.md']), round: 2 },
      ] }],
      st,
    );
    expect(diff.clean).toMatchObject({ overlaps: 0, pairs: 0, findings: 0 });
    expect(diff.ambiguous.runs).toBe(0); // 认得出轮次 → 这一跑**进可信面**, 不再是"不可信"

    const same = reconstructWriteRace(
      [{ runId: 'r', multiRound: true, roundsKnown: true, nodes: [
        { ...w('C::a', 0, 100, ['x.md']), round: 2 },
        { ...w('C::b', 50, 150, ['x.md']), round: 2 },
      ] }],
      st,
    );
    expect(same.clean.findings).toBe(1); // 同一轮 → 真并发, 照报
  });

  test('★ 一侧缺轮次(顶层节点没有"轮")→ **不许据此排除** —— 它们确实可能真并发', () => {
    const r = reconstructWriteRace(
      [{ runId: 'r', multiRound: true, roundsKnown: true, nodes: [
        w('top', 0, 200, ['x.md']), // 顶层节点: 没有 round
        { ...w('C::a', 50, 150, ['x.md']), round: 2 },
      ] }],
      st,
    );
    expect(r.clean.findings).toBe(1);
  });

  test('★ 多轮但**认不出轮次**(老记录)→ 仍落不可信面', () => {
    const r = reconstructWriteRace(
      [{ runId: 'r', multiRound: true, roundsKnown: false, nodes: [w('C::a', 0, 100, ['x.md']), w('C::b', 50, 150, ['x.md'])] }],
      st,
    );
    expect(r.ambiguous).toMatchObject({ runs: 1, findings: 1 });
    expect(r.clean.findings).toBe(0);
  });

  test('★ **同一个节点不能和自己撞车** —— checkpoint 归档会让一个 nodeId 在盘上有好几份', () => {
    // 覆写前引擎会把上一轮归档成 `<nodeId>.__r<K>.json`, 于是同一个 nodeId 有多份 checkpoint
    // (实测: 9 个目录 / 43 个节点)。不滤掉就会把「同一节点的第 1 轮与第 2 轮」配成一对,
    // 而两轮写的通常正是同一批文件 → **保证撞车**。
    // ⚠ 诚实说明: 这个隐患在 2026-08-06 那批历史数据上**没有兑现** —— 不同轮的窗口在墙钟上
    //   本来就不重叠 (轮是串行的)。守卫是构造性防护, 不是对已观测错数的修正。
    const r = reconstructWriteRace(
      [{ runId: 'r', nodes: [w('C::a', 0, 100, ['x.md']), w('C::a', 50, 150, ['x.md'])] }],
      st,
    );
    expect(r.overlaps).toBe(0);
    expect(r.findings).toBe(0);
  });

  test('dirsUsable 只数「有 ≥2 个节点」的 —— 单节点的 run 连对都配不出来', () => {
    const r = reconstructWriteRace(
      [{ runId: 'r1', nodes: [w('a', 0, 100, ['x'])] }, { runId: 'r2', nodes: [w('a', 0, 100, ['x']), w('b', 0, 100, ['y'])] }],
      st,
    );
    expect(r.dirsUsable).toBe(1);
  });
});

/**
 * ⑧.1 的**第二个可回溯面**:内环 journal 的轮数分布(2026-08-06)。
 *
 * ⑧.1 首版把 ②③④ 整段标成「要跑一次新的才有数」,而那是**错的** ——
 * `.omd/continuity/<runId>/_loop-*.json` 里的 `completedRounds` 一直就记着内环跑了几轮,
 * 读数板甚至早就在读它(算 `roundsTotal`),只是从没接到「环转没转第二圈」这个问题上。
 *
 * ⚠ **这一次是刚立完「可回溯的那一格要先算」之后又犯的同一个错**(交接 32 §五 第 2 条)。
 * 所以这组用例的重心在:`turned`(无歧义)与 `oneRound`(**压着三种情况分不开**)不许合并。
 */
describe('omd-readout · ⑧.1 内环 journal 的轮数分布 (2026-08-06)', () => {
  test('★ completedRounds ≥ 2 → turned (**内环真转了第二圈**, 无歧义)', () => {
    const r = summarizeLoopRounds([{ completedRounds: 2 }, { completedRounds: 4 }]);
    expect(r.turned).toBe(2);
    expect(r.oneRound).toBe(0);
  });

  test('★ completedRounds === 1 → oneRound, **不许算进 turned** (它压着三种情况)', () => {
    // max_rounds=1 撞熔断/blocked/预算 · max_rounds=1 配 judge_final · max_rounds>1 首轮收敛
    // —— 三者从 journal 里分不开, 拆开要账本那一位 `maxRounds`。
    const r = summarizeLoopRounds([{ completedRounds: 1 }, { completedRounds: 1 }]);
    expect(r.oneRound).toBe(2);
    expect(r.turned).toBe(0);
  });

  test('★ 缺席 / 0 / 坏值 → **一格都不进** (缺席 ≠ 0 轮)', () => {
    const r = summarizeLoopRounds([{}, { completedRounds: 0 }]);
    expect(r.journals).toBe(2); // 份数照数
    expect(r.turned).toBe(0);
    expect(r.oneRound).toBe(0); // ← 两格都不进, 不许把"没记"塞进任何一格
  });

  test('★ turned 按 stop.kind 分组 —— 因为**转了第二圈 ≠ 跨轮比较真发生过**', () => {
    // success/blocked 的 return 在比较点之前, not-converged/budget-exhausted 在之后。
    // 这层对应关系绑在 executor-dag 的退出路径上, 所以只存原料、判词在渲染层解释。
    const r = summarizeLoopRounds([
      { completedRounds: 2, stop: { kind: 'success' } },
      { completedRounds: 2, stop: { kind: 'not-converged' } },
      { completedRounds: 3, stop: { kind: 'not-converged' } },
      { completedRounds: 2 }, // 早于 N6: 没记 stop
    ]);
    expect(r.turned).toBe(4);
    expect(r.turnedByStop).toEqual({ success: 1, 'not-converged': 2, '(没记)': 1 });
  });

  test('journals 数的是**份数**, 与 turned/oneRound 之和可以不等 (差额就是"没记")', () => {
    const r = summarizeLoopRounds([{ completedRounds: 2 }, { completedRounds: 1 }, {}]);
    expect(r.journals).toBe(3);
    expect(r.turned + r.oneRound).toBe(2); // ← 差的那 1 份是"没记", 它有意义
  });
});

/**
 * ⑬ 跑坏了回得去吗(D1,2026-08-06)。
 *
 * D-AB 说「范围内写」可以放手是因为 **git 就是 rollback**,而 R2 给的隔离档默认关着、
 * 只挂在一个入口上、**实测从来没被用过一次**。于是那句话的真实条件是「起跑时树干净」——
 * 这一段量的就是那个条件。五态的下一步互不相同,**不许合并成"有/没有"两格**。
 */
describe('omd-readout · ⑬ 跑坏了回得去吗 (2026-08-06)', () => {
  const withRB = (runId: string, rollback: { kind: string } | undefined) => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(
      {
        ...fakeResult({ planName: 'p', plan: { a: { goal: 'x' } }, done: ['a'], reused: [], usage: {} }),
        ...(rollback ? { rollback } : {}),
      } as never,
      { runId, entry: 'dag_run', now: 1000 },
    );
    return readout({ db, limit: 50 }).rollback;
  };

  test('★ 老行没记 → 进 unrecorded, cleanRate=null(**算不出 ≠ 0%**)', () => {
    const rb = withRB('r1', undefined);
    expect(rb.recordedRuns).toBe(0);
    expect(rb.unrecordedRuns).toBe(1);
    expect(rb.cleanRate).toBeNull();
    expect(rb.byKind.unknown).toBe(0); // ← 「没记」不许被算成 unknown, 两者下一步不同
  });

  test('★ 记了 clean → 进分母且 cleanRate=1', () => {
    const rb = withRB('r2', { kind: 'clean' });
    expect(rb.recordedRuns).toBe(1);
    expect(rb.byKind.clean).toBe(1);
    expect(rb.cleanRate).toBe(1);
  });

  test('★ dirty-untracked **不算 clean** —— 它只有半个回滚', () => {
    const rb = withRB('r3', { kind: 'dirty-untracked' });
    expect(rb.byKind['dirty-untracked']).toBe(1);
    expect(rb.byKind.clean).toBe(0);
    expect(rb.cleanRate).toBe(0); // 记了而没有完整回滚 = 0%, 与上面那条的 null 分得开
  });

  test('★ unknown 单独成格 —— 它进分母(记了)但不算 clean', () => {
    const rb = withRB('r4', { kind: 'unknown' });
    expect(rb.recordedRuns).toBe(1);
    expect(rb.byKind.unknown).toBe(1);
    expect(rb.cleanRate).toBe(0);
  });

  test('★ 词表外的字面量(老库/坏值)→ 归 unknown, **不许归 clean**', () => {
    const rb = withRB('r5', { kind: '随便什么' });
    expect(rb.byKind.unknown).toBe(1);
    expect(rb.byKind.clean).toBe(0);
  });
});

/**
 * ⑤.1 检查者只读吗(D4 / §7.3,2026-08-06)—— 以及它的机会分母。
 *
 * §7.3 说检查者应当只读,而 D-Q 检测者是**图内节点**:与被它检查的兄弟共享同一棵 worktree,
 * conductor 把它排成 `agent` 时它手里就是有写工具的。这一段的重心全在**分母**上 ——
 * `inproc` 检测者一个写工具都没有,把它算进去会把基率往低了报(拿"不可能"冒充"没发生")。
 */
describe('omd-readout · ⑤.1 检查者只读吗 (2026-08-06)', () => {
  const world = (nodes: { id: string; kind: string; detector?: boolean; writeCounts?: [number, number] }[]) => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    const plan: Record<string, unknown> = {};
    const results: Record<string, unknown> = {};
    for (const n of nodes) {
      plan[n.id] = { goal: 'x', ...(n.detector ? { detector: true } : {}) };
      results[n.id] = {
        id: n.id, kind: n.kind, status: 'done', deps: [], output: '', usage: { in: 0, out: 0 },
        ...(n.writeCounts ? { writeCounts: n.writeCounts } : {}),
      };
    }
    rec.record(
      {
        plan: { name: 'p', nodes: plan }, levels: [nodes.map((n) => n.id)], results, reusedNodes: [],
        usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
      } as unknown as ExecutorDagResult,
      { runId: 'dw', entry: 'dag_run', now: 1000 },
    );
    return readout({ db, limit: 50 }).detector_writes;
  };

  test('★ inproc 检测者**不进机会分母** —— 它没有写工具, 那是"不可能"不是"没发生"', () => {
    // 少了这条, 留痕里那 16 个 inproc 检测者会把分母灌大 3 倍, 把一个没量过的 0 说成很可信。
    const dw = world([{ id: 'c', kind: 'inproc', detector: true, writeCounts: [0, 0] }]);
    expect(dw.detectors).toBe(1);
    expect(dw.agentDetectors).toBe(0);
    expect(dw.rate).toBeNull(); // 算不出, 不是 0%
  });

  test('★ agent 检测者没记 writeCounts → 不进分母 (「没记」不是「没写」)', () => {
    const dw = world([{ id: 'c', kind: 'agent', detector: true }]);
    expect(dw.agentDetectors).toBe(1);
    expect(dw.observed).toBe(0); // ← 这一格与下一条的 0 长得一样而下一步相反
    expect(dw.rate).toBeNull();
  });

  test('★ agent 检测者记了且为 0 → 进分母, rate=0 (**查过零检出**, 与上一条分得开)', () => {
    const dw = world([{ id: 'c', kind: 'agent', detector: true, writeCounts: [0, 0] }]);
    expect(dw.observed).toBe(1);
    expect(dw.wroteControlled).toBe(0);
    expect(dw.rate).toBe(0);
  });

  test('★ agent 检测者真写了 → wroteControlled 数得出来 (证明这条不是恒 0)', () => {
    const dw = world([
      { id: 'c1', kind: 'agent', detector: true, writeCounts: [2, 0] },
      { id: 'c2', kind: 'agent', detector: true, writeCounts: [0, 0] },
      { id: 'w', kind: 'agent', writeCounts: [5, 0] }, // 不是检测者, 一格都不进
    ]);
    expect(dw.detectors).toBe(2);
    expect(dw.observed).toBe(2);
    expect(dw.wroteControlled).toBe(1);
    expect(dw.rate).toBe(0.5);
  });
});

/**
 * ⑥ §8.4 熔断的键该不该改 —— 以及它的**机会分母**(2026-08-06 修正)。
 *
 * 这一段此前把结论**读反了**,而它是 S-19/S-20 那一族的第三个实例:
 * 旧算法只分 `nearMiss`(同输出不同命令)与 `exactRepeat`(同输出同命令)两格,可后者对一个
 * **只出现过一次**的指纹同样成立 —— 熔断按构造要「≥2 次」,单次失败两种键都抓不到。
 * 于是 singleton 被算进了"现行键抓得到的那一格",读的人算出"现行键覆盖 88% → 够用",
 * 而在真机会分母上现行键**一组都没抓到**。
 *
 * 另外两格同样是这次照出来的:**跨 run 凑出来的 near-miss 不是真机会**(§8.4 是环内累计),
 * **空输出那个桶是反例不是机会**(所有 `grep -q` 式静默失败指纹成同一条)。
 */
describe('omd-readout · ⑥ 熔断键的机会分母 (2026-08-06 修正)', () => {
  /** 一个只含指定「失败 command 节点」的最小世界。同 hash 同 run 的进同一格。 */
  const world = (
    runs: { runId: string; nodes: { command: string; output: string }[] }[],
  ): ReadoutResult['breaker_key'] => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    let now = 1000;
    for (const r of runs) {
      now += 100;
      const plan: Record<string, unknown> = {};
      const results: Record<string, unknown> = {};
      r.nodes.forEach((n, i) => {
        const id = `n${i}`;
        plan[id] = { goal: 'x', executor: 'command', command: n.command };
        // status ≠ done 才记 outputHash —— 成功的输出不是"零位移"的证据 (见 dag-record 那条注)
        results[id] = { id, kind: 'command', status: 'failed', deps: [], output: n.output, usage: { in: 0, out: 0 } };
      });
      rec.record(
        {
          plan: { name: 'p', nodes: plan },
          levels: [Object.keys(plan)],
          results,
          reusedNodes: [],
          usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
        } as unknown as ExecutorDagResult,
        { runId: r.runId, entry: 'dag_run', now },
      );
    }
    return readout({ db, limit: 50 }).breaker_key;
  };

  test('★ 只失败过一次的指纹是 **singleton**, 不许算进"现行键抓得到的那一格"', () => {
    // 这条就是旧版读反结论的那一格。证伪: 把 exactRepeat 的 `e.hits >= 2` 去掉 → 当场红。
    const bk = world([{ runId: 'r1', nodes: [{ command: 'a', output: 'X' }, { command: 'b', output: 'Y' }] }]);
    expect(bk.fingerprints).toBe(2);
    expect(bk.singletons).toBe(2);
    expect(bk.opportunities).toBe(0); // 一次机会都没有
    expect(bk.exactRepeat).toBe(0); // ← 旧版这里会是 2
    expect(bk.rate).toBeNull(); // 分母 0 → 算不出, 不是 0%
  });

  test('★ 同输出同命令重复 ≥2 次 → exactRepeat (现行键真抓得到的)', () => {
    const bk = world([{ runId: 'r1', nodes: [{ command: 'a', output: 'X' }, { command: 'a', output: 'X' }] }]);
    expect(bk.opportunities).toBe(1);
    expect(bk.exactRepeat).toBe(1);
    expect(bk.nearMiss).toBe(0);
    expect(bk.rate).toBe(0); // 有机会而没 near-miss = **查过零检出**, 与上一条的 null 分得开
  });

  test('★ 同输出不同命令 → near-miss (现行键漏掉的)', () => {
    const bk = world([{ runId: 'r1', nodes: [{ command: 'a', output: 'X' }, { command: 'b', output: 'X' }] }]);
    expect(bk.nearMiss).toBe(1);
    expect(bk.nearMissSameRun).toBe(1);
    expect(bk.nearMissCrossRun).toBe(0);
    expect(bk.rate).toBe(1);
  });

  test('★ 跨 run 凑出来的 near-miss **不是真机会** —— §8.4 是同一次 run 的环内累计', () => {
    const bk = world([
      { runId: 'r1', nodes: [{ command: 'a', output: 'X' }] },
      { runId: 'r2', nodes: [{ command: 'b', output: 'X' }] },
    ]);
    expect(bk.nearMiss).toBe(1);
    expect(bk.nearMissCrossRun).toBe(1);
    // 这一行是本用例的全部意义: 两次失败在不同的 run 里, 根本碰不到一起
    expect(bk.nearMissSameRun).toBe(0);
  });

  test('★ **空输出**那个桶是反例不是机会 —— 不进任何一格', () => {
    // `grep -q` 那族失败没有输出 → 全指纹成 sha1('')。按输出合并会把两个不同断言
    // 各失败一次判成同一条在空转 —— 那是误熔断, 正是"只看输出"这条改法要避开的。
    const bk = world([{ runId: 'r1', nodes: [{ command: 'grep -q A f', output: '' }, { command: 'grep -q B g', output: '' }] }]);
    expect(bk.emptyOutputCommands).toBe(2);
    expect(bk.fingerprints).toBe(0); // 空输出那格不算进指纹种数
    expect(bk.nearMiss).toBe(0); // ← 不算进 near-miss, 否则读成"改宽键能多抓到它们"
    expect(bk.opportunities).toBe(0);
  });

  test('三格互斥且穷尽: singletons + opportunities === fingerprints, nearMiss + exactRepeat === opportunities', () => {
    const bk = world([
      { runId: 'r1', nodes: [
        { command: 'solo', output: 'S' }, // singleton
        { command: 'same', output: 'R' }, { command: 'same', output: 'R' }, // exactRepeat
        { command: 'p', output: 'N' }, { command: 'q', output: 'N' }, // nearMiss
        { command: 'grep -q z f', output: '' }, // 空输出: 不进任何一格
      ] },
    ]);
    expect(bk.singletons + bk.opportunities).toBe(bk.fingerprints);
    expect(bk.nearMiss + bk.exactRepeat).toBe(bk.opportunities);
    expect([bk.singletons, bk.exactRepeat, bk.nearMiss]).toEqual([1, 1, 1]);
  });
});

/**
 * ⑧.1 内环的形状(2026-08-06)—— 「⑧ 那个 0 为什么是 0」的分母。
 *
 * ⑧ 段补上分母之后判词说「轮转次数 ≈ 0 → 瓶颈是环只转一圈」,而那句话把**四件下一步不同
 * 的事**并成了一个括号:① 图里没有 conductor(判据不适用)② `max_rounds` 缺省 1(结构上
 * 没机会)③ 多轮档首轮收敛(检测器没有付费对象)④ 转了却提前退环(该查别处)。
 *
 * 本段每条钉的都是**某两格不许互相冒充**。整段的反向自检在 `dag-record.test.ts` 那四条上:
 * 留痕层一旦拿 `?? 1` 把「不知道」补成「单轮档」,这里的 ② 与「没记」就永久分不开了。
 */
describe('omd-readout · ⑧.1 内环的形状 (2026-08-06)', () => {
  /** 一个只含指定 conductor 形状的最小世界。`c` 缺席 = plan 里没有这个 id(map 动态扇出)。 */
  const world = (
    nodes: { id: string; kind: string; rounds?: number; inPlan?: { max_rounds?: number } }[],
  ): ReadoutResult['loop_shape'] => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    const plan: Record<string, unknown> = {};
    const results: Record<string, unknown> = {};
    for (const n of nodes) {
      if (n.inPlan) plan[n.id] = { goal: 'x', ...n.inPlan };
      results[n.id] = {
        id: n.id, kind: n.kind, status: 'done', deps: [], output: '', usage: { in: 0, out: 0 },
        ...(n.rounds === undefined ? {} : { rounds: n.rounds }),
      };
    }
    rec.record(
      {
        plan: { name: 'p', nodes: plan },
        levels: [nodes.map((n) => n.id)],
        results,
        reusedNodes: [],
        usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
      } as unknown as ExecutorDagResult,
      { runId: 'ls', entry: 'dag_run', now: 1000 },
    );
    return readout({ db, limit: 50 }).loop_shape;
  };

  test('★ ① 图里没有 conductor → 这一跑进 runsWithoutConductor, **不进任何一格分母**', () => {
    // 这一格是四格里唯一**可回溯**的 (只看 kind) —— 2026-08-06 实测 54 跑里 33 跑是它。
    const ls = world([{ id: 'a', kind: 'agent', inPlan: {} }]);
    expect(ls.runsWithoutConductor).toBe(1);
    expect(ls.runsWithConductor).toBe(0);
    expect(ls.conductorNodes).toBe(0);
  });

  test('★ ② max_rounds=1 (缺省) → singleRound。**结构上**没有跨轮比较的机会', () => {
    const ls = world([{ id: 'c', kind: 'conductor', rounds: 1, inPlan: {} }]);
    expect(ls.singleRound).toBe(1);
    expect(ls.firstRoundConverged).toBe(0);
    expect(ls.turned).toBe(0);
    expect(ls.unrecordedNodes).toBe(0);
  });

  test('★ ③ 多轮档而首轮就收敛 → firstRoundConverged, **不是** singleRound', () => {
    // 这两格的下一步相反: ② 是"缺省值掐死了判据", ③ 是"判据没有付费对象"的正面证据。
    const ls = world([{ id: 'c', kind: 'conductor', rounds: 1, inPlan: { max_rounds: 3 } }]);
    expect(ls.firstRoundConverged).toBe(1);
    expect(ls.singleRound).toBe(0);
  });

  test('★ ④ 真转了第二圈 → turned。⑧ 的机会只可能出自这一格', () => {
    const ls = world([{ id: 'c', kind: 'conductor', rounds: 2, inPlan: { max_rounds: 4 } }]);
    expect(ls.turned).toBe(1);
    expect(ls.firstRoundConverged).toBe(0);
  });

  test('★ 「没记」不许被念成「单轮档」—— 缺任一位就进 unrecordedNodes', () => {
    // 本段最重要的一条。老行 (2026-08-06 之前) 与 conductor 异常退出都落这一格, 而它与 ②
    // 在旧读数板里长得一模一样: 都表现为"⑧ 一次机会都没有"。下一步却相反 ——
    // 「没记」要跑一次新的, 「单轮档」已经在说话了。
    const ls = world([
      { id: 'c1', kind: 'conductor', inPlan: { max_rounds: 2 } }, // 没报 rounds (异常退出)
      { id: 'c2', kind: 'conductor', rounds: 1 }, // plan 里没有它 → 上限不知道
    ]);
    expect(ls.unrecordedNodes).toBe(2);
    expect(ls.singleRound).toBe(0);
    expect(ls.firstRoundConverged).toBe(0);
    expect(ls.turned).toBe(0);
  });

  test('四格之和 = conductorNodes (不重不漏 —— 一个节点只落一格)', () => {
    const ls = world([
      { id: 'a', kind: 'agent', inPlan: {} },
      { id: 'c1', kind: 'conductor', rounds: 1, inPlan: {} },
      { id: 'c2', kind: 'conductor', rounds: 1, inPlan: { max_rounds: 3 } },
      { id: 'c3', kind: 'conductor', rounds: 3, inPlan: { max_rounds: 3 } },
      { id: 'c4', kind: 'conductor', inPlan: { max_rounds: 3 } },
    ]);
    expect(ls.conductorNodes).toBe(4);
    expect(ls.singleRound + ls.firstRoundConverged + ls.turned + ls.unrecordedNodes).toBe(ls.conductorNodes);
    expect([ls.singleRound, ls.firstRoundConverged, ls.turned, ls.unrecordedNodes]).toEqual([1, 1, 1, 1]);
  });
});

describe('omd-readout · 消耗口径分桶 (LoopX 对照, 2026-08-05)', () => {
  /** 一个只含指定 outcome 的最小世界 (每 run 一条记录, 一个节点)。 */
  const world = (runs: { runId: string; failureKind?: string; tokens: number | null }[]): ReadoutResult => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    let now = 1000;
    for (const r of runs) {
      now += 100;
      if (r.tokens === null) {
        // usage 列恒 NOT NULL, 「没记」在本仓的实况是**记坏了** —— 走 readout 既有的那条防御路径
        // (先例: 上面「usage 记坏」那条)。这一格量的是"分不出成本的 run", 不是 0 成本的 run。
        db.run(
          `INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage, observations, outcome, verification, reused, criteria)
           VALUES (?, ?, '图-null', 1, NULL, ?, 'dag_run', '[["n1"]]', ?, '{"oops":1}', NULL, 'success', NULL, NULL, NULL)`,
          [r.runId, now, r.runId, JSON.stringify([{ id: 'n1', kind: 'command', status: 'done', deps: [], command: 'ls' }])],
        );
        continue;
      }
      rec.record(
        fakeResult({
          planName: `图-${r.runId}`,
          plan: { n1: { goal: 'x', executor: 'command', command: 'ls' } },
          ...(r.failureKind ? { failed: [{ id: 'n1', failureKind: r.failureKind }] } : { done: ['n1'] }),
          usage: { leavesIn: r.tokens },
        }),
        { runId: r.runId, entry: 'dag_run', now },
      );
    }
    return readout({ db });
  };

  test('分桶只从 RUN_OUTCOME_INFO 读; 「未记」单列第五桶, 不并进 unclassified', () => {
    const { readoutNow } = makeFixture();
    const b = readoutNow().spend_discipline.buckets;
    // run-A/run-B success + run-C not-converged → delivery 3 run; run-D blocked; old-1 outcome 列 NULL → 未记。
    expect(b.delivery).toEqual({ runs: 3, tokens: 1450, unmeasured_runs: 0 });
    expect(b.blocked).toEqual({ runs: 1, tokens: 0, unmeasured_runs: 0 });
    expect(b['未记'].runs).toBe(1);
    // 「这条记录没有这个字段」不是「引擎没交代」—— 编成同一桶就再也分不开。
    expect(b.unclassified.runs).toBe(0);
  });

  test('两个口径并排: overhead 的钱不进新分子, 差额 = overhead tokens', () => {
    const sd = world([
      { runId: 'ok', tokens: 100 },
      { runId: 'boom', failureKind: 'stall', tokens: 900 }, // stall → infra-error → overhead
    ]).spend_discipline;
    expect(sd.buckets.delivery.tokens).toBe(100);
    expect(sd.buckets.overhead.tokens).toBe(900);
    expect(sd.success_runs).toBe(1);
    expect(sd.tokens_per_success_all).toBe(1000);      // 老口径: 一次 429 让"每次成功"贵了 10 倍
    expect(sd.tokens_per_success_delivery).toBe(100);  // 新口径: 引擎效率本身
    expect(sd.overhead_share).toBe(0.9);
    expect(sd.blocked_share).toBe(0);
  });

  test('反向自检: 分桶失效则两口径必然重合 —— 没有 overhead 的世界里它们相等', () => {
    // 上一条断言"两数不等"只有在这一条成立时才有意义: 它证明差额是**分桶造出来的**,
    // 不是一个恒不等的式子。分桶要是塌了 (全归 delivery), 上一条会红而这一条照绿。
    const sd = world([
      { runId: 'ok1', tokens: 100 },
      { runId: 'ok2', tokens: 300 },
    ]).spend_discipline;
    expect(sd.buckets.overhead.tokens).toBe(0);
    expect(sd.tokens_per_success_all).toBe(sd.tokens_per_success_delivery);
  });

  test('usage 没记的 run 进 unmeasured_runs, 不被当 0 加进 tokens', () => {
    const sd = world([
      { runId: 'ok', tokens: 200 },
      { runId: 'nousage', tokens: null },
    ]).spend_discipline;
    expect(sd.buckets.delivery).toEqual({ runs: 2, tokens: 200, unmeasured_runs: 1 });
  });

  test('0 success → 两个每-success 都是 null (算不出 ≠ 0); 空世界三个比率全 null', () => {
    const sd = world([{ runId: 'boom', failureKind: 'stall', tokens: 900 }]).spend_discipline;
    expect(sd.success_runs).toBe(0);
    expect(sd.tokens_per_success_all).toBeNull();
    expect(sd.tokens_per_success_delivery).toBeNull();
    expect(sd.overhead_share).toBe(1); // 分母非 0, 这个数算得出来

    const empty = world([]).spend_discipline;
    expect(empty.total_tokens).toBe(0);
    expect(empty.overhead_share).toBeNull();
    expect(empty.blocked_share).toBeNull();
  });
});

describe('omd-readout · 注意力轴 (LoopX 对照, 2026-08-05)', () => {
  test('踢回率来自 outcome 分布; 没给 mapsCwd → 票的三个数是 null (不知道), 不编 0', () => {
    const { readoutNow } = makeFixture();
    const aa = readoutNow().attention_axis;
    // 夹具 5 跑里 run-D 是 blocked —— 环把球踢回给 owner 的那一格。
    expect(aa.blocked_runs).toBe(1);
    expect(aa.total_runs).toBe(5);
    expect(aa.handback_rate).toBe(0.2);
    // 没给 mapsCwd = 没看图, 不是"图上没有票"。
    expect(aa.pending_tickets).toBeNull();
    expect(aa.decided_tickets).toBeNull();
    expect(aa.wasted_review_share).toBeNull();
  });

  test('空世界: 踢回率 null (算不出 ≠ 0%) —— 0 次踢回与没量过不是一回事', () => {
    const db = new Database(':memory:');
    createDagRecorder({ db });
    const aa = readout({ db }).attention_axis;
    expect(aa.total_runs).toBe(0);
    expect(aa.handback_rate).toBeNull();
  });
});

describe('omd-readout · ⑭ 管线税 (2026-08-10)', () => {
  test('solve 路两段对照: contractShare / verifier 打回三态 / 重规划增量 / 词表外 plan 单列不进分母', () => {
    const db = new Database(':memory:');
    createDagRecorder({ db });
    const U = (cIn: number, cOut: number, lIn: number, lOut: number, lHit: number) =>
      JSON.stringify({ conductorIn: cIn, conductorOut: cOut, leavesIn: lIn, leavesOut: lOut, leavesCacheHit: lHit });
    const ins = (id: string, createdAt: number, planName: string, runId: string, entry: string, usage: string | null, verification: string | null) =>
      db.run(
        `INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage, verification) VALUES (?, ?, ?, 1, NULL, ?, ?, '[]', '[]', ?, ?)`,
        [id, createdAt, planName, runId, entry, usage, verification],
      );
    // run-P (dag_goal → 归一 solve): contract → execute(被打回) → execute(通过) → 重规划增量可算
    ins('p1', 100, 'goal-contract', 'run-P', 'dag_goal', U(10, 20, 300, 50, 120), null);
    ins('p2', 200, 'goal-execute', 'run-P', 'dag_goal', U(10, 20, 700, 150, 400), JSON.stringify({ pass: false, reason: 'x' }));
    ins('p3', 300, 'goal-execute', 'run-P', 'dag_goal', U(20, 30, 900, 200, 500), JSON.stringify({ pass: true }));
    // run-Q: execute 段 usage 没记 → 整 run 进 unmeasuredRuns; verification 记坏 → verifUnparsed
    ins('q1', 400, 'goal-contract', 'run-Q', 'solve', U(5, 5, 10, 10, 0), null);
    ins('q2', 500, 'goal-execute', 'run-Q', 'solve', 'null', '{broken');
    // run-X: 两段都记 (进分母) + 词表外 plan_name 一行 (直通 merge 改名会照在这里) + execute 行 verification 列缺 → verifUnrecorded
    ins('x1', 600, 'goal-contract', 'run-X', 'solve', U(1, 2, 3, 4, 5), null);
    ins('x2', 700, 'goal-execute', 'run-X', 'solve', U(1, 2, 3, 4, 5), null);
    ins('x3', 650, 'goal-contract-fast', 'run-X', 'solve', U(0, 0, 0, 0, 0), null);
    const pt = readout({ db }).pipeline_tax;
    expect(pt.solveRuns).toBe(3);
    expect(pt.bothMeasuredRuns).toBe(2); // run-P + run-X; run-Q 缺 execute 段 usage → 不算
    expect(pt.unmeasuredRuns).toBe(1);
    expect(pt.contractTokens).toBe(390); // 380 (run-P contract) + 10 (run-X contract)
    expect(pt.totalTokens).toBe(2430); // run-P 三行 380+880+1150 + run-X 两行 10+10; x3 词表外不进分母
    expect(pt.contractShare).toBeCloseTo(390 / 2430, 10);
    expect(pt.rejections).toBe(1);
    expect(pt.verifUnparsed).toBe(1);
    expect(pt.verifUnrecorded).toBe(1); // x2 列缺 (没记 ≠ 没打回)
    expect(pt.unknownPlans).toEqual([{ plan: 'goal-contract-fast', rows: 1 }]);
    expect(pt.replans).toEqual([
      { runId: 'run-P', deltas: { conductorIn: 10, conductorOut: 10, leavesIn: 200, leavesOut: 50, leavesCacheHit: 100 } },
    ]);
  });
});

describe('omd-readout · ⑮ 座位健康 (2026-08-10)', () => {
  test('偏离 / kimi 兜底哨 / byModel / usageByModel (单模型 run) / mixedRuns / unmappedKinds', () => {
    const db = new Database(':memory:');
    createDagRecorder({ db });
    const seats = { conductor: 'claude-code:claude-fable-5', leaf: 'claude-code:claude-sonnet-5' };
    const nodesJson = (...ns: { id: string; kind: string; model: string | null }[]) =>
      JSON.stringify(ns.map((n) => ({ id: n.id, kind: n.kind, status: 'done', deps: [], ...(n.model === null ? {} : { model: n.model }) })));
    const usage = (v: number) => JSON.stringify({ conductorIn: v, conductorOut: v, leavesIn: v, leavesOut: v, leavesCacheHit: 0 });
    const ins = (id: string, createdAt: number, runId: string, nodes: string, u: string) =>
      db.run(`INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage) VALUES (?, ?, 'p', 1, NULL, ?, 'solve', '[]', ?, ?)`, [id, createdAt, runId, nodes, u]);
    ins('s1', 1, 'run-S', nodesJson({ id: 'c1', kind: 'conductor', model: 'deepseek:deepseek-v4-flash' }, { id: 'a1', kind: 'agent', model: 'deepseek:deepseek-v4-flash' }), usage(5));
    ins('k1', 2, 'run-K', nodesJson({ id: 'a2', kind: 'agent', model: 'kimi-coding:k3' }), usage(1));
    ins('m1', 3, 'run-M', nodesJson({ id: 'c3', kind: 'conductor', model: 'deepseek:deepseek-v4-flash' }, { id: 'a3', kind: 'agent', model: 'kimi-coding:k3' }), usage(10));
    ins('n1', 4, 'run-N', nodesJson({ id: 'a4', kind: 'agent', model: null }), usage(2));
    ins('c1', 5, 'run-C', nodesJson({ id: 'cmd1', kind: 'command', model: 'deepseek:deepseek-v4-flash' }), usage(0));
    const sh = readout({ db, seats }).seat_health;
    expect(sh.deviations!.length).toBe(5); // run-S 2 · run-K 1 · run-M 2
    expect(sh.kimiFallbackEvents).toBe(2); // run-K a2 + run-M a3 (kimi-coding ≠ 期望 claude-code)
    expect(sh.noModelNodes).toBe(1); // a4 老节点没记 model (≠ 偏离, ≠ 0)
    expect(sh.unmappedKinds).toEqual({ command: 1 }); // cmd1 无座位映射, 不编期望
    expect(sh.byModel).toEqual([
      { model: 'deepseek:deepseek-v4-flash', nodes: 4 }, // c1+a1+c3+cmd1
      { model: 'kimi-coding:k3', nodes: 2 },
    ]);
    expect(sh.usageByModel).toEqual([
      { model: 'deepseek:deepseek-v4-flash', runs: 2, tokens: 20 }, // run-S (20) + run-C (0)
      { model: 'kimi-coding:k3', runs: 1, tokens: 4 },
    ]);
    expect(sh.mixedRuns).toBe(1); // run-M 混合座位 → 不摊账
    expect(sh.seatsRef).toEqual(seats);
  });

  test('没给座位参照 → deviations/kimiFallbackEvents 是 null (算不出 ≠ 0), 其余照数', () => {
    const db = new Database(':memory:');
    createDagRecorder({ db });
    db.run(`INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage) VALUES ('n1', 1, 'p', 1, NULL, 'r', 'solve', '[]', ?, 'null')`,
      [JSON.stringify([{ id: 'a', kind: 'agent', status: 'done', deps: [], model: 'kimi-coding:k3' }])]);
    const sh = readout({ db }).seat_health;
    expect(sh.deviations).toBeNull();
    expect(sh.kimiFallbackEvents).toBeNull();
    expect(sh.byModel).toEqual([{ model: 'kimi-coding:k3', nodes: 1 }]);
    expect(sh.noModelNodes).toBe(0);
  });
});

describe('omd-readout · ⑯ MCP policy (2026-08-10)', () => {
  test('七态分列不合并; 词表外 status 单列; server NULL 印 (没解析到); 没传 mcpDb → 无账 null', () => {
    const db = new Database(':memory:');
    createDagRecorder({ db });
    const mcpDb = new Database(':memory:');
    mcpDb.run(`CREATE TABLE calls (ts INTEGER NOT NULL, session TEXT, server TEXT, tool TEXT NOT NULL, status TEXT NOT NULL, error TEXT)`);
    const ins = (server: string | null, status: string) =>
      mcpDb.run(`INSERT INTO calls (ts, session, server, tool, status, error) VALUES (1, NULL, ?, 't', ?, NULL)`, [server, status]);
    ins('filesystem', 'ok');
    ins('filesystem', 'ok');
    ins('filesystem', 'error');
    ins('github', 'rejected-policy');
    ins('github', 'rejected-unfetched');
    ins(null, 'unknown-tool');
    ins(null, 'unknown-tool');
    ins('x', 'mystery-status');
    const mp = readout({ db, mcpDb }).mcp_policy!;
    expect(mp.byStatus).toEqual({
      ok: 2, error: 1, 'rejected-unfetched': 1, 'rejected-args': 0, 'rejected-policy': 1, 'unknown-tool': 2, 'connect-error': 0,
    });
    expect(mp.unknownStatus).toEqual([{ status: 'mystery-status', n: 1 }]);
    expect(mp.total).toBe(8);
    const fs = mp.byServer.find((s) => s.server === 'filesystem')!;
    expect(fs.byStatus).toEqual({ ok: 2, error: 1 });
    expect(fs.total).toBe(3);
    const unk = mp.byServer.find((s) => s.server === '(没解析到)')!;
    expect(unk.byStatus).toEqual({ 'unknown-tool': 2 });
    // 库没注入 → 整段 null (无账, 不是七格零)
    expect(readout({ db }).mcp_policy).toBeNull();
  });
});

describe('omd-readout · ⑰ cache 趋势 (2026-08-10)', () => {
  test('记录级时序取**最近** 20 行 (与 ⑫ 方向相反); leavesIn=0 → rate null + zeroIn; usage 没记 → unmeasured', () => {
    const db = new Database(':memory:');
    createDagRecorder({ db });
    const ins = (id: string, createdAt: number, usage: string | null) =>
      db.run(`INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage) VALUES (?, ?, 'p', 1, NULL, ?, 'solve', '[]', '[]', ?)`, [id, createdAt, id, usage]);
    for (let i = 0; i < 25; i++) {
      ins(`c${i}`, i, JSON.stringify({ conductorIn: 0, conductorOut: 0, leavesIn: i % 5 === 0 ? 0 : 10, leavesOut: 0, leavesCacheHit: i % 5 === 0 ? 0 : 3 }));
    }
    ins('c-null', 100, 'null'); // usage 没记 (JSON null)
    const ct = readout({ db }).cache_trend;
    expect(ct.rows.length).toBe(20); // 26 行取末尾 20
    expect(ct.rows[0]!.createdAt).toBe(6); // 窗口从 c6 开始 —— 证明是**最近** 20 行, 不是最早
    expect(ct.rows.find((x) => x.createdAt === 24)!.rate).toBeCloseTo(0.3, 10);
    expect(ct.rows.find((x) => x.createdAt === 20)!.rate).toBeNull(); // leavesIn=0 → 算不出
    expect(ct.rows.at(-1)).toEqual({ createdAt: 100, runId: 'c-null', leavesIn: null, leavesCacheHit: null, rate: null });
    expect(ct.zeroIn).toBe(3); // c10/c15/c20 在窗口内 leavesIn=0
    expect(ct.unmeasured).toBe(1);
  });
});

describe('omd-readout · ⑭-⑰ 空态与防御 (2026-08-10)', () => {
  test('空库: 四段各自空态 —— 全零 + 比率 null, mcp 无账 null, cache 空序列 (不编数)', () => {
    const db = new Database(':memory:');
    createDagRecorder({ db });
    const r = readout({ db });
    expect(r.pipeline_tax).toEqual({
      solveRuns: 0, bothMeasuredRuns: 0, unmeasuredRuns: 0, unknownPlans: [],
      contractTokens: 0, totalTokens: 0, contractShare: null,
      verifUnrecorded: 0, verifUnparsed: 0, rejections: 0, replans: [],
    });
    expect(r.seat_health.badNodesRows).toBe(0);
    expect(r.seat_health.deviations).toBeNull(); // 没给座位参照 → 算不出
    expect(r.seat_health.kimiFallbackEvents).toBeNull();
    expect(r.mcp_policy).toBeNull(); // 无账, 不是七格零
    expect(r.cache_trend).toEqual({ rows: [], zeroIn: 0, unmeasured: 0 });
  });

  test('坏 JSON nodes 行 → badNodesRows 单列不吞, 整块板不炸', () => {
    const db = new Database(':memory:');
    createDagRecorder({ db });
    db.run(`INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage) VALUES ('bad', 1, 'p', 1, NULL, 'r', 'solve', '[]', '{oops', 'null')`);
    const r = readout({ db });
    expect(r.seat_health.badNodesRows).toBe(1);
    expect(r.runs.length).toBe(1); // 坏行不吞, 板照常出数
  });
});

/**
 * #209 spec 写盘频率 —— 「契约段跑了却没产出 spec 文件」有多常见。
 *
 * 这一格存在的理由是**事后量不出来**: worktree 一清、分支一合, 两个信号同时归零, 而扫基座树
 * 数到的是它本来就有的文档。所以数据在 run 期就记进 `spec_write` 列, 这里只负责把它读成频率。
 */
describe('#209 spec_write_sampling', () => {
  test('三值各计一格; missRate 的分母只算真跑了契约段的那部分 (not-needed 不稀释)', async () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    const mk = (runId: string, now: number, specWrite?: SpecWrite) =>
      rec.record(fakeResult({ planName: 'goal-execute', plan: { a: { goal: 'x' } }, done: ['a'] }), { runId, entry: 'solve', now, ...(specWrite ? { specWrite } : {}) });
    mk('s-wrote', 1, { kind: 'wrote', source: 'contract', path: '/repo/docs/plan/x.md' });
    mk('s-missing', 2, { kind: 'missing', source: 'contract' });
    mk('s-simple', 3, { kind: 'not-needed', source: 'tier-simple' });
    mk('s-unrecorded', 4); // 没记 → 不进分母 (与"没写盘"不是一回事)
    const r = readout({ db });
    expect(r.spec_write_sampling).toEqual({ denominator: 3, wrote: 1, missing: 1, notNeeded: 1, contractRuns: 2, missRate: 0.5 });
    rec.close();
  });

  test('一个契约段都没跑过 → missRate = null (不知道), **不编 0**', () => {
    const db = new Database(':memory:');
    const rec = createDagRecorder({ db });
    rec.record(fakeResult({ planName: 'goal-execute', plan: { a: { goal: 'x' } }, done: ['a'] }), {
      runId: 's1', entry: 'solve', now: 1, specWrite: { kind: 'not-needed', source: 'tier-simple' },
    });
    const r = readout({ db });
    expect(r.spec_write_sampling.denominator).toBe(1);
    expect(r.spec_write_sampling.missRate).toBeNull();
    rec.close();
  });

  test('老库无 spec_write 列 → readout 只 SELECT, 整列读成没记, 分母为零, 不炸', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE omd_dag_runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
            node_count INTEGER NOT NULL, question TEXT, run_id TEXT, levels TEXT NOT NULL, nodes TEXT NOT NULL,
            usage TEXT NOT NULL, observations TEXT, outcome TEXT, verification TEXT, reused INTEGER, criteria TEXT, entry TEXT)`);
    db.run(`INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, run_id, entry, levels, nodes, usage)
            VALUES ('old-1', 1, '老图', 1, 'g1', 'solve', '[]', '[]', '{}')`);
    const r = readout({ db });
    expect(r.runs[0]!.specWrite).toBeNull();
    expect(r.spec_write_sampling).toEqual({ denominator: 0, wrote: 0, missing: 0, notNeeded: 0, contractRuns: 0, missRate: null });
    db.close();
  });
});

describe('omd-readout · ⑲ 编排循环 (R-1 第 4 步, 2026-09-03)', () => {
  const loopOf = (over: Partial<LoopLedger>): string =>
    JSON.stringify({
      path: 'orchestrating-loop', route: { kind: 'none', chainHit: false }, preActionLlmCalls: 1, residentPromptChars: 6400,
      verifier: { calls: 1, firstVerdict: 'pass', target: null, reinjected: false, afterReinject: 'skipped' },
      cards: { calls: 1, ok: 1, rejectedSchema: 0, help: 0, rejectedCompile: 0, childRunError: 0, byCard: { work: 1 }, readOnlyShellBlocked: 0 },
      dispatches: [{ seq: 1, card: 'work', nodes: 1, briefHasRepro: null, failed: 0 }],
      ...over,
    });
  const ins = (db: Database, id: string, at: number, plan: string, runId: string, levels: string[][], nodes: unknown[], loop: string | null): void => {
    db.run(
      `INSERT INTO omd_dag_runs (id, created_at, plan_name, node_count, question, run_id, entry, levels, nodes, usage, loop) VALUES (?, ?, ?, ?, NULL, ?, 'solve', ?, ?, ?, ?)`,
      [id, at, plan, nodes.length, runId, JSON.stringify(levels), JSON.stringify(nodes), JSON.stringify({ conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 }), loop],
    );
  };
  const makeLoopFixture = (): Database => {
    const db = new Database(':memory:');
    createDagRecorder({ db });
    // P1: 终审红 → 回灌 → 绿, 回灌后零新派发 (= 蒸发); 两次派发 (brief 有/无复现); conductor 20 次 LLM 调用, 墙钟 1000ms。
    ins(db, 'p1', 100, 'goal-orchestrating-loop', 'P1', [['conductor'], ['accept']], [
      { id: 'conductor', kind: 'agent', status: 'done', deps: [], durationMs: 1000, llmCalls: 20, selfReport: { self_report: 'leaf', acceptance_ran: true }, acceptance: { ran: false, rounds: 0, last: null }, thinking: { level: 'high', channel: 'pi' } },
      { id: 'accept', kind: 'command', status: 'done', deps: ['conductor'] },
    ], loopOf({
      verifier: { calls: 2, firstVerdict: 'fail', target: 'criterion', reinjected: true, afterReinject: 'green', recheck: 'pass' },
      cards: { calls: 3, ok: 2, rejectedSchema: 1, help: 0, rejectedCompile: 0, childRunError: 0, byCard: { work: 1, spawn: 1 }, readOnlyShellBlocked: 0 },
      dispatches: [{ seq: 1, card: 'work', nodes: 1, briefHasRepro: true, failed: 0 }, { seq: 2, card: 'spawn', nodes: 2, briefHasRepro: false, failed: 0 }],
      dispatchesBeforeReinject: 2,
    }));
    ins(db, 'c1', 101, 'conductor-work-a', 'P1', [['d1.a']], [{ id: 'd1.a', kind: 'agent', status: 'done', deps: [], durationMs: 400, llmCalls: 10, selfReport: { self_report: 'missing' }, thinking: { level: 'medium', channel: 'sdk' } }], null);
    ins(db, 'c2', 102, 'conductor-spawn', 'P1', [['d2.x', 'd2.y']], [
      { id: 'd2.x', kind: 'agent', status: 'done', deps: [], durationMs: 300, llmCalls: 5, acceptance: { ran: true, rounds: 1, last: { kind: 'exited', verdict: 'inconclusive' } } },
      { id: 'd2.y', kind: 'agent', status: 'done', deps: [], durationMs: 300, llmCalls: null },
    ], null);
    // P2: 没回灌; conductor 墙钟没记 (→ 加速比不可算); 一次派发无 brief 槽; 老 runner 的 conductor 没报 llmCalls。
    ins(db, 'p2', 200, 'goal-orchestrating-loop', 'P2', [['conductor']], [{ id: 'conductor', kind: 'agent', status: 'done', deps: [], durationMs: null, llmCalls: null }], loopOf({}));
    ins(db, 'c3', 201, 'conductor-work-b', 'P2', [['d1.b']], [{ id: 'd1.b', kind: 'agent', status: 'done', deps: [], durationMs: 100, llmCalls: 3 }], null);
    // 非循环行 (v1 solve 的执行段): 一格都不进 —— 它的 99 次调用若混进 worker, conductor/worker 分解就假了。
    ins(db, 'x1', 300, 'goal-execute', 'X', [['execute']], [{ id: 'execute', kind: 'conductor', status: 'done', deps: [], llmCalls: 99 }], null);
    return db;
  };

  test('★ 父行归并 / conductor-worker 分解 / 宽度深度 / 加速比缺席单列 / 回灌蒸发 / 直达率 / brief 三态 / 尾块三态', () => {
    const lp = readout({ db: makeLoopFixture() }).loop_readout;
    expect(lp.parents).toBe(2);
    expect(lp.childRows).toBe(3);
    expect(lp.width).toEqual([1, 2, 1]);
    expect(lp.depth).toEqual([1, 1, 1]);
    expect(lp.widthStats).toEqual({ min: 1, median: 1, max: 2 });
    // 加速比: P1 = (400+300+300)/1000 = 1.0; P2 conductor 墙钟 NULL → 「1 个 run 因 durationMs 缺席不可算」, **不并进分母**。
    expect(lp.speedup).toEqual({ ratios: [1], median: 1, unmeasurable: 1 });
    // LLM 调用: conductor 20 (P2 没报 → unmeasuredConductorRuns 1, /run 只摊给量到的 1 个); worker 10+5+3 = 18 (d2.y 没报 → 1 节点); x1 的 99 不进。
    expect(lp.llmCalls).toEqual({ conductor: 20, worker: 18, conductorPerRun: 20, workerPerRun: 9, unmeasuredConductorRuns: 1, unmeasuredWorkerNodes: 1 });
    // D-14 窄复审上线后 (2026-09-04): 回灌那条 run 付 2 次调用 (全量终审 1 + 窄复审 1), 判词 ≤ 2。
    // 另一个父行是**上线前形态**的老记录 (无 recheck 字段) → 进 unknown, 不并进 skipped。
    expect(lp.verifier).toEqual({ calls: 3, perRun: 1.5, firstFail: 1, reinjected: 1, recheck: { pass: 1, unproven: 0, fail: 0, error: 0, skipped: 0, unknown: 1 } });
    // 回灌蒸发: 分母 = 回灌过的 (只有 P1); P1 回灌后零新派发 ∧ 绿 → 1/1。P2 没回灌不进分母 (设计 §5 的公式; §6 例子里的「1/2」把没回灌的也算进了分母, 以 §5 为准)。
    expect(lp.evaporation).toEqual({ numerator: 1, denominator: 1, rate: 1, unknown: 0 });
    expect(lp.cards.calls).toBe(4);
    expect(lp.cards.ok).toBe(3);
    expect(lp.cards.firstPassRate).toBeCloseTo(0.75, 10);
    expect(lp.cards.byCard).toEqual({ work: 2, spawn: 1 });
    expect(lp.dispatches).toEqual({ total: 3, perRun: 1.5, briefTrue: 1, briefFalse: 1, briefNull: 1, briefReproRate: 0.5 });
    // 尾块: 记了 selfReport 的 agent 节点 2 个 (conductor@P1 leaf · d1.a missing) → 1/2; 其余 4 个 agent 节点没记 → 单列, 不进分母。
    expect(lp.trailer).toEqual({ agentNodes: 2, missing: 1, unrecorded: 4, missingRate: 0.5 });
    expect(lp.acceptanceRanMismatch).toBe(1); // conductor@P1: 尾块说跑了, 记录说没跑
    expect(lp.inconclusive).toEqual({ bare: 1, nonBare: 0 });
    expect(lp.residentPromptChars).toEqual({ max: 6400, over8000: 0, unrecorded: 0 });
    expect(lp.preActionLlmCalls).toEqual({ sum: 2, over1: 0, unrecorded: 0 });
    // thinking: conductor@P1 pi/high · d1.a sdk/medium; 其余 4 个 agent 节点没报 (缺席或 null 都算没报)。
    expect(lp.thinking).toEqual({ pi: { high: 1 }, sdk: { medium: 1 }, unreported: 4 });
  });

  test('回灌了但老记录没 dispatchesBeforeReinject → unknown 单列, 分子分母都不动', () => {
    const db = new Database(':memory:');
    createDagRecorder({ db });
    ins(db, 'p', 1, 'goal-orchestrating-loop', 'P', [['conductor']], [{ id: 'conductor', kind: 'agent', status: 'done', deps: [] }],
      loopOf({ verifier: { calls: 2, firstVerdict: 'fail', target: 'implementation', reinjected: true, afterReinject: 'green', recheck: 'pass' }, dispatches: [] }));
    expect(readout({ db }).loop_readout.evaporation).toEqual({ numerator: 0, denominator: 0, rate: null, unknown: 1 });
  });

  test('空库 / 老库无 loop 列 → parents 0, 全部比率 null (不编 0)', () => {
    const db = new Database(':memory:');
    createDagRecorder({ db });
    const lp = readout({ db }).loop_readout;
    expect(lp.parents).toBe(0);
    expect(lp.llmCalls.conductorPerRun).toBeNull();
    expect(lp.evaporation.rate).toBeNull();
    expect(lp.speedup.median).toBeNull();
    const old = new Database(':memory:');
    old.run(`CREATE TABLE omd_dag_runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL, node_count INTEGER NOT NULL, question TEXT, levels TEXT NOT NULL, nodes TEXT NOT NULL, usage TEXT NOT NULL)`);
    old.run(`INSERT INTO omd_dag_runs VALUES ('o', 1, 'goal-orchestrating-loop', 1, NULL, '[["conductor"]]', '[]', '{"conductorIn":0,"conductorOut":0,"leavesIn":0,"leavesOut":0,"leavesCacheHit":0}')`);
    expect(readout({ db: old }).loop_readout.parents).toBe(0); // 列不在 = 没记, 不是「循环 run」
  });
});
