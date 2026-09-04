/**
 * dag-record 的 `runId` 归组面 (2026-08-02)。
 *
 * 为什么要这一条: 留痕器写好之后**只挂在 TUI 侧的 `/cg` `/audit` `/iterate` 上**, MCP 生产路径
 * (dag_run / dag_goal) 从来没接过 —— `.omd/dag-runs.db` 在真跑上恒空。接线时才发现主键不够用:
 * `dag_goal` 一次跑**两张图** (契约段 + 执行段), 各落一条记录; 想回答「这次 goal 花了多少」
 * 就必须能把这两条认回同一次运行, 而主键按定义是每条都不同的。
 *
 * 于是加 `run_id` 列。这里钉三件事: ① 归组真的能用 ② 老库 (无该列) 不许炸 ③ 主键仍是每条独立。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDagRecorder, recordDagRun } from './dag-record';
import { runExecutorDagWithPlan } from './engine';
import type { AgentLeafRunner, LeafGateStates } from '../leaf-runners';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult, GenerateFn } from './types';

/** 最小可记的一张图结果 (只填 record 真读的那几个字段)。 */
const fakeResult = (planName: string, usage?: { leavesIn?: number; cacheHit?: number }): ExecutorDagResult =>
  ({
    plan: { name: planName, nodes: { a: { goal: 'x' } } },
    levels: [['a']],
    results: { a: { id: 'a', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 1, out: 1 } } },
    reusedNodes: [],
    usage: {
      conductor: { in: 10, out: 20 },
      leavesIn: usage?.leavesIn ?? 100,
      leavesOut: 50,
      leavesCacheHit: usage?.cacheHit ?? 0,
    },
  }) as unknown as ExecutorDagResult;

describe('dag-record 的 runId 归组', () => {
  test('同一个 runId 的两条 (goal 两段) 归得回一组, 主键各自独立', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id1 = rec.record(fakeResult('goal-contract', { leavesIn: 300, cacheHit: 120 }), { runId: 'run-A', question: '干点活' });
    const id2 = rec.record(fakeResult('goal-execute', { leavesIn: 700, cacheHit: 400 }), { runId: 'run-A', question: '干点活' });
    rec.record(fakeResult('别人的图'), { runId: 'run-B' });

    expect(id1).not.toBe(id2); // 主键每条不同 —— 归组不能靠它
    const group = rec.listByRun('run-A');
    expect(group.map((r) => r.planName)).toEqual(['goal-contract', 'goal-execute']); // 时间序
    // 「这次 goal 花了多少 / 吃到多少缓存」= 组内相加, 这正是 G3 与前缀缓存两个问题的数据源。
    expect(group.reduce((s, r) => s + r.usage.leavesIn, 0)).toBe(1000);
    expect(group.reduce((s, r) => s + r.usage.leavesCacheHit, 0)).toBe(520);
    expect(rec.listByRun('run-B')).toHaveLength(1);
    expect(rec.listByRun('不存在')).toEqual([]);
    rec.close();
  });

  test('runId 省略 → null (图外调用方照旧能记, 只是归不了组)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('/audit'));
    expect(rec.get(id)!.runId).toBeNull();
    rec.close();
  });

  test('老库 (建于加列之前) 就地补列, 不炸; 老行 runId = null', () => {
    // 逐字重建 2026-08-02 之前的表结构 —— `CREATE TABLE IF NOT EXISTS` 对已存在的表一个字都不改,
    // 所以少了这个 ALTER, 任何早建过库的机器都会在第一次 INSERT 上崩。
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE omd_dag_runs (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
        node_count INTEGER NOT NULL, question TEXT, levels TEXT NOT NULL,
        nodes TEXT NOT NULL, usage TEXT NOT NULL
      )
    `);
    db.run(
      `INSERT INTO omd_dag_runs VALUES ('old-1', 1, '老图', 1, null, '[]', '[]', '{"conductorIn":0,"conductorOut":0,"leavesIn":0,"leavesOut":0,"leavesCacheHit":0}')`,
    );

    const rec = createDagRecorder({ db });
    expect(rec.get('old-1')!.runId).toBeNull(); // 老行读得出来, 归组位为空
    const fresh = rec.record(fakeResult('新图'), { runId: 'run-C' }); // 新行照常写
    expect(rec.get(fresh)!.runId).toBe('run-C');
    rec.close();
  });
});

/**
 * R1 / §8.5 的两条派生面: 命令原文 与 效果指标计数。
 *
 * 两者共用同一条纪律 —— **留痕存原料, 不存派生值**。风险级的定义以后会改, 命令不会;
 * 所以存 `command` 让读数板现算级别, 而不是把当时算出来的级别写进历史记录。
 */
describe('留痕的派生面 — 命令原文 + 效果指标计数', () => {
  const withNodes = (nodes: Record<string, unknown>, results: Record<string, unknown>): ExecutorDagResult =>
    ({
      plan: { name: '图', nodes },
      levels: [Object.keys(nodes)],
      results,
      reusedNodes: [],
      usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
    }) as unknown as ExecutorDagResult;

  test('command 节点的命令原文进留痕 (读数板据它现算风险级)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { v: { goal: 'x', executor: 'command', command: 'bun test' }, a: { goal: 'y' } },
        {
          v: { id: 'v', kind: 'command', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
          a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-cmd' },
    );
    const nodes = rec.get(id)!.nodes;
    expect(nodes.find((n) => n.id === 'v')!.command).toBe('bun test');
    // 非 command 节点不该凭空多一个字段。
    expect(nodes.find((n) => n.id === 'a')!.command).toBeUndefined();
    rec.close();
  });

  test('R0 派卡记账位: plan 的 template 进留痕; 没派 = 缺席不编空串', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { t: { goal: 'x', template: 'researcher' }, p: { goal: 'y' }, e: { goal: 'z', template: '  ' } },
        {
          t: { id: 't', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
          p: { id: 'p', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
          // map 动态子节点: plan 里没有这个 id → 缺席 = 真不知道 (同 loopShape 口径)
          dyn: { id: 'dyn', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-tpl' },
    );
    const nodes = rec.get(id)!.nodes;
    expect(nodes.find((n) => n.id === 't')!.template).toBe('researcher');
    expect(nodes.find((n) => n.id === 'p')!.template).toBeUndefined(); // 没派 = 缺席
    expect(nodes.find((n) => n.id === 'dyn')!.template).toBeUndefined(); // plan 无此 id = 缺席
    // 空白串不算派卡 (别让 '  ' 混进派卡率分子)
    expect(nodes.find((n) => n.id === 'e')).toBeUndefined(); // e 无 result 行, 不入账 —— 见下一断言的世界
    const id2 = rec.record(
      withNodes(
        { e: { goal: 'z', template: '  ' } },
        { e: { id: 'e', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } } },
      ),
      { runId: 'run-tpl-2' },
    );
    expect(rec.get(id2)!.nodes.find((n) => n.id === 'e')!.template).toBeUndefined();
    rec.close();
  });

  test('writeCounts 原样进留痕; **缺席与 [0,0] 不许被抹平**', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { w: { goal: 'x' }, z: { goal: 'y' }, o: { goal: 'z' } },
        {
          // 写了 3 次, 其中 2 次 no-op
          w: { id: 'w', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, writeCounts: [3, 2] },
          // 跑了但一次没写 —— 这是一个**真实读数**, 不是"没记"
          z: { id: 'z', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, writeCounts: [0, 0] },
          // 这条链上没人报 (旧 runner / inproc) —— 与上面那条必须分得开
          o: { id: 'o', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-eff' },
    );
    const nodes = rec.get(id)!.nodes;
    expect(nodes.find((n) => n.id === 'w')!.writeCounts).toEqual([3, 2]);
    expect(nodes.find((n) => n.id === 'z')!.writeCounts).toEqual([0, 0]); // 存在且为零
    expect(nodes.find((n) => n.id === 'o')!.writeCounts).toBeUndefined(); // 缺席
    // 这条断言是本用例的全部意义: 两者若被抹成同一个东西, 读数板就会把「没记」念成「跑了但没写」。
    expect(nodes.find((n) => n.id === 'z')!.writeCounts).not.toBeUndefined();
    rec.close();
  });

  test('R-1 (2026-09-03): toolCalls / llmCalls 原样进节点 JSON; 没报 → null (不是 0)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { a: { goal: 'x' }, o: { goal: 'z' } },
        {
          a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, toolCalls: 7, llmCalls: 3 },
          o: { id: 'o', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-calls' },
    );
    const nodes = rec.get(id)!.nodes;
    expect(nodes.find((n) => n.id === 'a')!.llmCalls).toBe(3);
    expect(nodes.find((n) => n.id === 'a')!.toolCalls).toBe(7);
    // 证伪: 写成 `?? 0` → 下面两条红 —— 读数板会把「没记」念成「零次调用」, conductor/worker 分解的分母就假了。
    expect(nodes.find((n) => n.id === 'o')!.llmCalls).toBeNull();
    expect(nodes.find((n) => n.id === 'o')!.toolCalls).toBeNull();
    rec.close();
  });

  test('R-1 第 3 步: agent 叶 thinking 原样进节点 JSON; agent 叶没报 → null; 非 agent 叶 → 缺席 (两态不互换)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { a: { goal: 'x' }, b: { goal: 'y' }, o: { goal: 'z' } },
        {
          a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, thinking: { level: 'medium', channel: 'sdk' } },
          b: { id: 'b', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
          o: { id: 'o', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-thinking' },
    );
    const nodes = rec.get(id)!.nodes;
    expect(nodes.find((n) => n.id === 'a')!.thinking).toEqual({ level: 'medium', channel: 'sdk' });
    expect(nodes.find((n) => n.id === 'b')!.thinking).toBeNull(); // 派了 agent 叶但没报
    expect('thinking' in nodes.find((n) => n.id === 'o')!).toBe(false); // 非 agent 叶: 不适用, 不是 null
    rec.close();
  });

  /**
   * 闸在场态进留痕 (2026-09-02) —— 端到端一条链: **注入的 agentRunner 报 gates → 引擎 →
   * ExecutorDagResult → 留痕库 → 读回来能数出"多少节点根本没配写闸"**。
   *
   * 为什么走整条链而不是只喂一个假 result: `LeafGatePosture` 此前**只活在内存与一行日志里**,
   * 缺的正是"引擎有没有把它接上留痕"这一跳。只测留痕层会得到一个谁也不填的字段 —— 那是
   * 本仓反复踩的形态 (碰撞台账 `rows=2924 / strict=0`: 表在、列在、写侧没接)。
   *
   * 【怎么让它红 (反向自检, 三处任一)】
   *  ① 摘掉 `dag-record.ts` 里 `...(r.gates ? { gates: r.gates } : {})` 那一行 → 三个节点的
   *     `gates` 全变 undefined, 分母塌成 0 → 红;
   *  ② 摘掉 `engine.ts` 里 `if (r.gates) gates = r.gates;` 或 leaf 组装处的 `...(gates ? { gates } : {})`
   *     → 同上 (引擎那一跳断了, 留痕层再对也没用);
   *  ③ 把 dag-record 的搬运改成 `r.gates ?? { writeAllow: 'unavailable', ... }` (给没报的补一个
   *     "没配") → `noRunnerReport` 那条断言红 —— 那正是把「没记」写成「查过且没配」的抹平。
   */
  test('闸在场态随 run 台账落盘 —— "多少节点没配写闸" 数得出来, 且「没记」不被算进分母', async () => {
    const execTree = mkdtempSync(join(tmpdir(), 'omd-gate-ledger-'));
    try {
      // 三个 agent 节点各报一种在场态; 第四个是 command 节点 —— 它这条链上**没人报**。
      const posture: Record<string, LeafGateStates> = {
        A: { writeAllow: 'enforced', mcpAllow: 'enforced', touchSession: 'enforced' },
        B: { writeAllow: 'unavailable', mcpAllow: 'enforced', touchSession: 'unavailable' },
        C: { writeAllow: 'unavailable', mcpAllow: 'unavailable', touchSession: 'unavailable' },
      };
      const agentRunner: AgentLeafRunner = async (input) => {
        const id = Object.keys(posture).find((k) => input.prompt.includes(`#${k}#`))!;
        return { text: '做完了', usage: { in: 1, out: 1 }, filesTouched: [], cwd: execTree, gates: posture[id]! };
      };
      const plan: ConductorPlan = {
        name: 'gate-ledger',
        nodes: {
          A: { goal: '#A#', executor: 'agent', output_type: 'none' },
          B: { goal: '#B#', executor: 'agent', output_type: 'none' },
          C: { goal: '#C#', executor: 'agent', output_type: 'none' },
          D: { goal: '不打模型的一格', executor: 'command', command: 'true', output_type: 'none' },
        },
      };
      const generate: GenerateFn = async () => ({ text: 'unused', usage: { in: 1, out: 1 } });
      const result = await runExecutorDagWithPlan(plan, {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        agentRunner,
      } as ExecutorDagConfig);

      const rec = createDagRecorder({ path: ':memory:' });
      const nodes = rec.get(rec.record(result, { runId: 'run-gates' }))!.nodes;
      const byId = (id: string) => nodes.find((n) => n.id === id)!;

      // ① 三态各自读得回原样 (引擎没在中途把它压平)。
      expect(byId('A').gates).toEqual(posture.A!);
      expect(byId('B').gates).toEqual(posture.B!);
      expect(byId('C').gates).toEqual(posture.C!);
      // ② command 节点缺席 —— 「这条链上没人报」**不是**「三道闸都没配」。
      expect(byId('D').gates).toBeUndefined();

      // ③ 本用例的全部意义: 这条数现在**查得出来**, 不必去翻日志。
      const reported = nodes.filter((n) => n.gates !== undefined);
      const noWriteGate = reported.filter((n) => n.gates!.writeAllow === 'unavailable');
      expect({ reported: reported.length, noWriteGate: noWriteGate.length, ids: noWriteGate.map((n) => n.id).sort() }).toEqual({
        reported: 3, // ← 分母 = **报了的**那些, 不是全量 4
        noWriteGate: 2,
        ids: ['B', 'C'],
      });
      // ④ 分母不许含没报的那格: 拿全量当分母会把"老行/command 节点"读成"没配写闸"。
      const noRunnerReport = nodes.length - reported.length;
      expect(noRunnerReport).toBe(1);
      rec.close();
    } finally {
      rmSync(execTree, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * fan-in 产物锚账的三态。形状与上面 `writeCounts` 那条同源, 单列是因为**第二格的含义不同**:
   * `writeCounts:[0,0]` = 跑了没写; `faninAnchors:[0,0]` = 摘要做了但**全文里没有路径锚**,
   * 也就是**这把尺子不适用** —— 抹平之后读数板会把"不适用"念成"一个都没丢", 那是本仓 S-15 那族。
   */
  test('faninAnchors 三态: 缺席(没做摘要) / [0,0](做了但没锚) / [N,k] 都分得开', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { a: { goal: 'x' }, b: { goal: 'y' }, c: { goal: 'z' } },
        {
          // 摘要做了, 21 个锚里 LLM 丢了 20 个 (真实语料里量到过的形状)
          a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, faninAnchors: [21, 20] },
          // 摘要做了, 但全文一个路径锚都没有 → **尺子不适用**, 不是满分
          b: { id: 'b', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, faninAnchors: [0, 0] },
          // 压根没做过 fan-in 摘要 (扇出 <2 或输出太短) —— 绝大多数节点是这一格
          c: { id: 'c', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-fanin' },
    );
    const nodes = rec.get(id)!.nodes;
    expect(nodes.find((n) => n.id === 'a')!.faninAnchors).toEqual([21, 20]);
    expect(nodes.find((n) => n.id === 'c')!.faninAnchors).toBeUndefined();
    // ★ 本用例的全部意义在这两条: `[0,0]` 必须**存在**且不等于缺席。
    //   证伪方式(**实跑过**): 把 dag-record 的判据改成查元素 `r.faninAnchors?.[0] ?` → 这条红。
    //   ⚠ 首版写的证伪方式是"改回真值判断 `r.faninAnchors ?`", **那条是错的** ——
    //     数组恒为真值, 换过去 34 条照样全绿。变异验证当场抓出来, 才换成上面这条真会红的。
    //     教训: 证伪方式不实跑一遍, 它自己就是一句没验过的断言。
    expect(nodes.find((n) => n.id === 'b')!.faninAnchors).toEqual([0, 0]);
    expect(nodes.find((n) => n.id === 'b')!.faninAnchors).not.toBeUndefined();
    rec.close();
  });

  // P2e review-fix (2026-09-02): `budgetStopped` (预算拒派/环预算停) 之前没进这份留痕 ——
  // 契约声称"这个信号可 join dag-runs.db 的节点派发记录"落了空 (哪儿都不落), 一个被预算拒派
  // 的节点在盘上与任何别的 failed 节点没有区别。只搬运, 一个字不补: 缺席 = 没被拒派, 不是编
  // 一个 false/'' 出来。
  test('budgetStopped 原样进留痕; 普通失败节点这一位缺席 (不是被抹平成同一种 failed)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { w: { goal: 'x' }, z: { goal: 'y' } },
        {
          // 预算拒派 —— 未真派发, 引擎自己判 failed 并挂 budgetStopped (engine.ts:4487-4498)
          w: {
            id: 'w',
            kind: 'agent',
            status: 'failed',
            deps: [],
            output: '[时间预算已尽, 未派发]',
            usage: { in: 0, out: 0 },
            budgetStopped: '时间预算已尽: 剩余 0s ≤ 最小可用切片 5s (已用 60s / 上限 10s)',
          },
          // 普通失败 (与预算无关) —— 这一位必须缺席, 不许被抹平成同一种 failed
          z: { id: 'z', kind: 'agent', status: 'failed', deps: [], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-budget-stopped' },
    );
    const nodes = rec.get(id)!.nodes;
    expect(nodes.find((n) => n.id === 'w')!.budgetStopped).toContain('预算');
    expect(nodes.find((n) => n.id === 'z')!.budgetStopped).toBeUndefined();
    rec.close();
  });

  test('plan 里没有对应 id 的节点 (map 动态扇出的子节点) 不编命令', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { parent: { goal: 'x' } },
        { 'parent#1': { id: 'parent#1', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } } },
      ),
      { runId: 'run-map' },
    );
    expect(rec.get(id)!.nodes[0]!.command).toBeUndefined();
    rec.close();
  });

  /**
   * ⑧.1 内环形状 —— 这四条钉的是**四格不许互相冒充**。
   *
   * 反向自检:把 `maxRounds` 写成 `planNode?.max_rounds ?? 1`(不检查 planNode 在不在)会让
   * 第 4 条红 —— map 动态扇出的 conductor 会被记成 `maxRounds: 1`,读数板于是把「不知道」
   * 念成「单轮档」。把 `rounds` 的 `typeof === 'number'` 换成真值判断会让第 3 条红。
   */
  test('conductor 的内环形状 (rounds/maxRounds) 进留痕; 其它 kind 不该多出这两位', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { c: { goal: 'x', max_rounds: 3 }, a: { goal: 'y' } },
        {
          c: { id: 'c', kind: 'conductor', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, rounds: 2 },
          // agent 也可能带 rounds (别的语义) —— 这两位只对 conductor 有意义, 别的 kind 记了就是编
          a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, rounds: 7 },
        },
      ),
      { runId: 'run-loop' },
    );
    const nodes = rec.get(id)!.nodes;
    expect(nodes.find((n) => n.id === 'c')!.rounds).toBe(2);
    expect(nodes.find((n) => n.id === 'c')!.maxRounds).toBe(3);
    expect(nodes.find((n) => n.id === 'a')!.rounds).toBeUndefined();
    expect(nodes.find((n) => n.id === 'a')!.maxRounds).toBeUndefined();
    rec.close();
  });

  test('plan 没写 max_rounds → 记 1 (缺省是引擎**真跑**的值, 不是猜的)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { c: { goal: 'x' } },
        { c: { id: 'c', kind: 'conductor', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, rounds: 1 } },
      ),
      { runId: 'run-loop-default' },
    );
    expect(rec.get(id)!.nodes[0]!.maxRounds).toBe(1);
    rec.close();
  });

  test('conductor 没报 rounds (异常退出, 没跑到 settle) → 那一位缺席, **不补 0 也不补 1**', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { c: { goal: 'x', max_rounds: 2 } },
        { c: { id: 'c', kind: 'conductor', status: 'failed', deps: [], output: '', usage: { in: 0, out: 0 } } },
      ),
      { runId: 'run-loop-crash' },
    );
    const n = rec.get(id)!.nodes[0]!;
    expect(n.rounds).toBeUndefined(); // 「没记」
    expect(n.maxRounds).toBe(2); // 上限来自 plan, 跑没跑到都知道
    rec.close();
  });

  test('plan 里没有这个 conductor (map 动态扇出) → maxRounds 也缺席, 不拿缺省顶', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { parent: { goal: 'x' } },
        {
          'parent#1': {
            id: 'parent#1', kind: 'conductor', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 }, rounds: 1,
          },
        },
      ),
      { runId: 'run-loop-fanout' },
    );
    const n = rec.get(id)!.nodes[0]!;
    expect(n.rounds).toBe(1); // 这一位引擎报了, 是真的
    // 这条是本用例的全部意义: plan 里没有它 → 上限**不知道**。补一个 1 会让读数板把
    // 「不知道」念成「单轮档」, 而后者的下一步是"改缺省或收掉检测器" —— 结论完全不同。
    expect(n.maxRounds).toBeUndefined();
    rec.close();
  });

  /**
   * quorum 声明 (`requires`) 进节点投影 (2026-08-30) —— **这是一把此前根本不存在的尺子**。
   *
   * 它跟上面 `maxRounds` 那四条**刻意相反**: 那里 plan 没写就记缺省 1 (量的是引擎真跑的上限),
   * 这里 plan 没写就**缺席** (量的是 conductor 的声明率)。补一个 `?? 'all'` 会让「conductor
   * 没想过 quorum」与「conductor 声明了全量」在账本里长得一模一样, 而这一位存在的全部理由
   * 就是把这两件事分开数。
   *
   * ⚠ 证伪方式 (仓规: 一条永远绿的闸不是闸; 下面三条**每条都实跑变异验过, 括号里是真实读数**):
   *   · `parseRequires` 的 `return undefined` 改成 `return 'all'` (补缺省) → 42 pass / **2 fail**:
   *     「没声明 → 缺席」与「词表外按缺席读」同时红 (补缺省把两种缺席都填成了 'all');
   *   · `...(req !== undefined ? …)` 换成真值判断 `...(req ? …)` → 43 pass / **1 fail**:
   *     `requires: 0` 那条红 (0 被抹成缺席);
   *   · `parseRequires` 去掉词表校验 (直接 `return raw as …`) → 43 pass / **1 fail**: 词表外那条红。
   */
  test('quorum 声明 requires 原样进留痕: all/any/K 各自可辨', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        {
          a: { goal: 'A' },
          b: { goal: 'B' },
          any: { goal: '宽扇出合成', depends_on: ['a', 'b'], requires: 'any' },
          all: { goal: '严合成', depends_on: ['a', 'b'], requires: 'all' },
          k: { goal: '判', depends_on: ['a', 'b'], requires: 2 },
        },
        {
          a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
          b: { id: 'b', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
          any: { id: 'any', kind: 'agent', status: 'done', deps: ['a', 'b'], output: '', usage: { in: 0, out: 0 } },
          all: { id: 'all', kind: 'agent', status: 'done', deps: ['a', 'b'], output: '', usage: { in: 0, out: 0 } },
          k: { id: 'k', kind: 'agent', status: 'done', deps: ['a', 'b'], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-quorum' },
    );
    const nodes = rec.get(id)!.nodes;
    expect(nodes.find((n) => n.id === 'any')!.requires).toBe('any');
    expect(nodes.find((n) => n.id === 'all')!.requires).toBe('all');
    expect(nodes.find((n) => n.id === 'k')!.requires).toBe(2);
    rec.close();
  });

  test('★ plan 没声明 requires → **缺席**, 不是 `all` (调度器的判定缺省不许进历史记录)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        // sink 有多个依赖但没写 requires —— 调度器判定时按 'all' 走, 而账本上这一格是"没声明"
        { a: { goal: 'A' }, b: { goal: 'B' }, sink: { goal: '合成', depends_on: ['a', 'b'] } },
        {
          a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
          b: { id: 'b', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
          sink: { id: 'sink', kind: 'agent', status: 'done', deps: ['a', 'b'], output: '', usage: { in: 0, out: 0 } },
          // map 动态扇出: plan 里没有这个 id → 缺席 = 真不知道 (同 command/template/maxRounds 口径)
          'sink#1': { id: 'sink#1', kind: 'agent', status: 'done', deps: ['sink'], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-quorum-absent' },
    );
    const nodes = rec.get(id)!.nodes;
    // ★ 本用例的全部意义: 这两条若被补成 'all', 「quorum 声明率」这个数就永远是 100%,
    //   与它此前恒为 0 一样没有信息量 —— 一个在任何干预下都不动的数量的是尺子, 不是计划。
    expect(nodes.find((n) => n.id === 'sink')!.requires).toBeUndefined();
    expect(nodes.find((n) => n.id === 'a')!.requires).toBeUndefined();
    expect(nodes.find((n) => n.id === 'sink#1')!.requires).toBeUndefined();
    rec.close();
  });

  /**
   * ⚠ `requires: 0` 在 **PlanSchema 里是非法的** (`conductor-plan.ts:317` 的 `.int().min(1)`),
   *   所以经校验的 plan 里不该出现。这条用例钉的**不是**"0 合法", 而是: 真绕过校验冒出来一个 0
   *   (plan-patch / map 扇出 / checkpoint 重载), 账本必须**把它记下来**而不是抹成"没声明" ——
   *   前者是"某条路绕过了校验"的证据, 后者把证据变成了缺席。
   */
  test('★ requires: 0 (schema 外的异常值) 必须活着穿过来 —— 真值判断会把证据抹成缺席', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        { a: { goal: 'A' }, z: { goal: '零配额', depends_on: ['a'], requires: 0 } },
        {
          a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
          z: { id: 'z', kind: 'agent', status: 'done', deps: ['a'], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-quorum-zero' },
    );
    const n = rec.get(id)!.nodes.find((x) => x.id === 'z')!;
    expect(n.requires).toBe(0);
    expect(n.requires).not.toBeUndefined(); // 0 ≠ 缺席 (仓规: NULL ≠ 0 ≠ 不适用)
    rec.close();
  });

  test('★ 词表外的 requires (LLM 编的 `most` / 小数) 按**缺席**读, 不编一个 kind', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(
      withNodes(
        {
          m: { goal: '编的', depends_on: ['a'], requires: 'most' },
          f: { goal: '小数', depends_on: ['a'], requires: 1.5 },
          a: { goal: 'A' },
        },
        {
          m: { id: 'm', kind: 'agent', status: 'done', deps: ['a'], output: '', usage: { in: 0, out: 0 } },
          f: { id: 'f', kind: 'agent', status: 'done', deps: ['a'], output: '', usage: { in: 0, out: 0 } },
          a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
        },
      ),
      { runId: 'run-quorum-junk' },
    );
    const nodes = rec.get(id)!.nodes;
    expect(nodes.find((n) => n.id === 'm')!.requires).toBeUndefined();
    expect(nodes.find((n) => n.id === 'f')!.requires).toBeUndefined();
    rec.close();
  });

  /**
   * 旧库兼容: `requires` 骑在 `nodes` 那一列的 JSON 里, **不是新增表列** —— 所以没有 ALTER 通道,
   * 也不需要一个。老行的 JSON 里压根没有这个键, 读回来就是 `undefined` = 「没记」。
   *
   * ⚠ 「老行没记」与「新行没声明」在这一位上**读起来一样**, 靠 `created_at` 分 (< 2026-08-30 的
   *   行一律是前者) —— 与 `template` 那一位同一条纪律, 见 DagRunNode.requires 的注。
   */
  test('老库/老行 (nodes JSON 无该键) 读回来是缺席态, 不是假的 `all`', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE omd_dag_runs (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
        node_count INTEGER NOT NULL, question TEXT, levels TEXT NOT NULL,
        nodes TEXT NOT NULL, usage TEXT NOT NULL
      )
    `);
    // 逐字重现 2026-08-30 之前的节点投影: {id,kind,status,deps,command,template,detector,outputHash}
    const oldNodes = JSON.stringify([
      { id: 'a', kind: 'agent', status: 'done', deps: [] },
      { id: 'sink', kind: 'agent', status: 'done', deps: ['a'] },
    ]);
    db.run(
      `INSERT INTO omd_dag_runs VALUES ('old-q', 1, '老图', 2, null, '[["a"],["sink"]]', ?, '{"conductorIn":0,"conductorOut":0,"leavesIn":0,"leavesOut":0,"leavesCacheHit":0}')`,
      [oldNodes],
    );

    const rec = createDagRecorder({ db });
    const old = rec.get('old-q')!;
    expect(old.nodes).toHaveLength(2);
    for (const n of old.nodes) expect(n.requires).toBeUndefined(); // 「没记」, 不是 'all'
    // 新行照常写, 老库不炸 —— 这一位不需要 ALTER (骑在 nodes JSON 里)。
    const fresh = rec.record(
      {
        plan: { name: '新图', nodes: { s: { goal: 'x', depends_on: ['a'], requires: 'any' }, a: { goal: 'A' } } },
        levels: [['a'], ['s']],
        results: {
          a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } },
          s: { id: 's', kind: 'agent', status: 'done', deps: ['a'], output: '', usage: { in: 0, out: 0 } },
        },
        reusedNodes: [],
        usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
      } as unknown as ExecutorDagResult,
      { runId: 'run-quorum-old-db' },
    );
    expect(rec.get(fresh)!.nodes.find((n) => n.id === 's')!.requires).toBe('any');
    rec.close();
  });
});

describe('recordDagRun (onComplete 钩子工厂)', () => {
  test('记一条并带上 runId/question', async () => {
    const rec = createDagRecorder({ path: ':memory:' });
    await recordDagRun(rec, { runId: 'run-D', entry: 'dag_run', question: '问题' })(fakeResult('图'));
    const [row] = rec.listByRun('run-D');
    expect(row!.question).toBe('问题');
    expect(row!.entry).toBe('dag_run');
    rec.close();
  });

  test('**不吃掉调用方自己的 onComplete**', async () => {
    // 留痕是搭车的, 不是抢座的。基座今天没有 onComplete, 但以后加的那个不该被这里静默吞掉 ——
    // 与 `dag_goal` 的节点事件从 P1 漏到 07-30 是同一个形态 (接线时顺手覆盖了别人的钩子)。
    const rec = createDagRecorder({ path: ':memory:' });
    const order: string[] = [];
    const hook = recordDagRun(rec, { runId: 'run-E', entry: 'dag_run' }, async () => {
      order.push('prev');
    });
    await hook(fakeResult('图'));
    order.push('recorded');
    expect(order).toEqual(['prev', 'recorded']);
    expect(rec.listByRun('run-E')).toHaveLength(1);
    rec.close();
  });
});

/**
 * N9 的两位新数据源 (2026-07-31)。
 *
 * 加它们是 N9 「在读数板上把 score 四条轴试出来」时当场撞到的:**判据轴与效率轴没有数据源**。
 * `verification` 缺了,「judge 说没收敛而验收其实过了」那一格就永远看不见;模型坐标缺了,
 * `computeCost` 查不到价 —— `$/goal` 不是没做, 是算不出来。
 *
 * 钉的重点与 `writeCounts` 那条一样, 是**三态不许被抹平**: 没记 / 记了且为假 / 记了且为真,
 * 三者的结论互不相同, 合并任意两个都会让读数板念出一句错话。
 */
describe('N9 · verification / reused / model 的三态', () => {
  const withVerif = (v: { pass: boolean; reason?: string } | undefined, reused?: string[]) =>
    ({
      plan: { name: 'p', nodes: { a: { goal: 'x' } } },
      levels: [['a']],
      results: { a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 1, out: 1 }, model: 'deepseek:deepseek-v4-flash' } },
      ...(reused ? { reusedNodes: reused } : {}),
      ...(v ? { verification: v } : {}),
      usage: { conductor: { in: 1, out: 1 }, leavesIn: 10, leavesOut: 5, leavesCacheHit: 2 },
    }) as unknown as ExecutorDagResult;

  test('验收过了 / 没过 / 压根没验 —— 三态各自可辨', () => {
    const rec = createDagRecorder({ db: new Database(':memory:') });
    const pass = rec.get(rec.record(withVerif({ pass: true })))!;
    const fail = rec.get(rec.record(withVerif({ pass: false, reason: '退出码 1' })))!;
    const none = rec.get(rec.record(withVerif(undefined)))!;
    expect(pass.verification).toEqual({ pass: true });
    expect(fail.verification).toEqual({ pass: false, reason: '退出码 1' });
    // ★ 没验 ≠ 没过。编一个 `pass:false` 会让读数板把「这次没跑验收」念成「判据没通过」。
    expect(none.verification).toBeUndefined();
    rec.close();
  });

  test('reused: 0 是「记了且一个没复用」, 缺席是「没记」—— 不许合并', () => {
    const rec = createDagRecorder({ db: new Database(':memory:') });
    const zero = rec.get(rec.record(withVerif(undefined, [])))!;
    const two = rec.get(rec.record(withVerif(undefined, ['a', 'b'])))!;
    const unrecorded = rec.get(rec.record(withVerif(undefined)))!;
    expect(zero.reused).toBe(0);
    expect(two.reused).toBe(2);
    expect(unrecorded.reused).toBeUndefined();
    rec.close();
  });

  test('模型坐标原样进留痕 —— 存坐标不存算好的钱 (价表会改, 坐标不会)', () => {
    const rec = createDagRecorder({ db: new Database(':memory:') });
    const r = rec.get(rec.record(withVerif({ pass: true })))!;
    expect(r.nodes[0]!.model).toBe('deepseek:deepseek-v4-flash');
    // 没打模型的节点 (command 叶) 不编一个坐标出来。
    const noModel = {
      plan: { name: 'p', nodes: { c: { goal: 'x', command: 'ls' } } },
      levels: [['c']],
      results: { c: { id: 'c', kind: 'command', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } } },
      usage: { conductor: { in: 1, out: 1 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
    } as unknown as ExecutorDagResult;
    expect(rec.get(rec.record(noModel))!.nodes[0]!.model).toBeUndefined();
    rec.close();
  });

  test('老库 (无这三列) 就地补列不炸, 老行读回来是「没记」而不是假值', () => {
    const db = new Database(':memory:');
    // 造一张 2026-07-31 之前形状的表 (无 verification / reused)。
    db.run(`CREATE TABLE omd_dag_runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
            node_count INTEGER NOT NULL, question TEXT, run_id TEXT, levels TEXT NOT NULL, nodes TEXT NOT NULL, usage TEXT NOT NULL)`);
    db.run(`INSERT INTO omd_dag_runs VALUES ('old', 1, 'p', 1, NULL, NULL, '[]', '[]', '{}')`);
    const rec = createDagRecorder({ db });
    const old = rec.get('old')!;
    expect(old.verification).toBeUndefined();
    expect(old.reused).toBeUndefined();
    // 补列之后新记录照常写得进去。
    expect(rec.get(rec.record(withVerif({ pass: true }, ['a'])))!.verification).toEqual({ pass: true });
    rec.close();
  });
});

/**
 * N9 判据轴的两位布尔 (2026-07-31 起飞前检查抓到的那条)。
 *
 * 起因: 判据轴本来打算用 `outcome` 算, 静态一核发现它**结构上永远是空的** ——
 * `oracle-failed` 只活在 goal 级而本表的 `outcome` 是按每张图算的; 更要命的是反方向那格
 * 在词表上根本不存在 (goal 的算式里 judge 为假就一律落 `not-converged`, 不管冻结判据过没过)。
 * 于是把两个布尔单独存下来 —— 不然那一发 live 跑完, 这条轴照样是空的。
 */
describe('N9 · 两条判据按 runId 回填', () => {
  const graph = (name: string) =>
    ({
      plan: { name, nodes: { a: { goal: 'x' } } },
      levels: [['a']],
      results: { a: { id: 'a', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 1, out: 1 } } },
      usage: { conductor: { in: 1, out: 1 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 },
    }) as unknown as ExecutorDagResult;

  test('一次 goal 的两条记录都被回填成同一份 (读数板据此按 runId 去重)', () => {
    const rec = createDagRecorder({ db: new Database(':memory:') });
    rec.record(graph('goal-contract'), { runId: 'g1' });
    rec.record(graph('goal-execute'), { runId: 'g1' });
    rec.updateCriteria('g1', { judge: false, oracle: true });
    const both = rec.listByRun('g1');
    expect(both.length).toBe(2);
    // ★ 这一格就是「judge 说没成、冻结判据却过了」—— 词表压掉的那一格。
    for (const r of both) expect(r.criteria).toEqual({ judge: false, oracle: true });
    rec.close();
  });

  test('没回填过 → 缺席 (dag_run 没有这两条判据, 不该被编成 false/false)', () => {
    const rec = createDagRecorder({ db: new Database(':memory:') });
    const id = rec.record(graph('plain-run'), { runId: 'r1' });
    expect(rec.get(id)!.criteria).toBeUndefined();
    rec.close();
  });

  test('回填只碰本 runId, 不串到别的运行上', () => {
    const rec = createDagRecorder({ db: new Database(':memory:') });
    rec.record(graph('a'), { runId: 'g1' });
    const other = rec.record(graph('b'), { runId: 'g2' });
    rec.updateCriteria('g1', { judge: true, oracle: false });
    expect(rec.get(other)!.criteria).toBeUndefined();
    rec.close();
  });
});

describe('观察者留痕:归组的两位 + **原句**', () => {
  /** 带一条观察的图结果。 */
  const withObs = (): ExecutorDagResult =>
    ({
      ...fakeResult('obs'),
      observations: [
        {
          kind: 'unsupported-claim',
          nodes: ['P::abc'],
          message: '[引擎记录核对 · 只报不拦] P::abc 有 1 处「声称引擎已校验通过」: output 「本文件已由引擎实测通过」',
        },
      ],
    }) as unknown as ExecutorDagResult;

  test('★ 原句进留痕库 —— 只报不拦的判据要拨闸, 靠的是逐条读原句判是不是误伤', () => {
    // 立这一列时压成了 {kind, nodes} 两位, 理由是"全文在 _loop-<nodeId>.json 里"。
    // 而那份 journal 只在 max_rounds>1 时才写、且每轮覆写 —— 最常见的单轮档整个查不到。
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(withObs(), { runId: 'r-obs' });
    const o = rec.get(id)!.observations!;
    expect(o[0]!.kind).toBe('unsupported-claim');
    expect(o[0]!.nodes).toEqual(['P::abc']);
    expect(o[0]!.message).toContain('本文件已由引擎实测通过');
    rec.close();
  });

  test('★ 一条观察都没有 → **空数组**, 不是缺席 (两者是不同的读数)', () => {
    // NULL ≠ 0: `[]` = 这一跑记了、检出为零(可以进"活体基率的分母");
    // 缺席 = 这一行早于该列存在(压根没记)。把后者读成"零检出"就是把没量过的跑算进分母。
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('plain'), { runId: 'r-none' });
    expect(rec.get(id)!.observations).toEqual([]);
    rec.close();
  });
});

describe('★ 检出器三态: 不适用 / 查过零检出 / 检出', () => {
  // 首次 shadow 真跑撞到的坑: `dag_run` 那条路整张图没有 conductor 节点 —— 检出器结构上够不着,
  // 而账本记成 `observations: []`, 与"检查过、零检出"**逐字相同**。按 entry 数约一半流量走这条路,
  // 于是活体基率的分母会错近一倍。仓规第一条: NULL ≠ 0 ≠ 不适用。
  const cc = (conductor: [number, number, number], flat: [number, number]) => ({
    conductor: { rounds: conductor[0], nodes: conductor[1], findings: conductor[2] },
    flat: { nodes: flat[0], findings: flat[1] },
  });
  const withClaimCheck = (v?: ReturnType<typeof cc>): ExecutorDagResult =>
    ({ ...fakeResult('cc'), ...(v ? { claimCheck: v } : {}) }) as unknown as ExecutorDagResult;

  test('★ 早于本次改动的记录 → **缺席**(不进分母), 不是 findings:0', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(withClaimCheck(), { runId: 'r-na' });
    expect(rec.get(id)!.claimCheck).toBeUndefined();
    rec.close();
  });

  test('两道分开记: conductor 面含产物内容, flat 面只有 output+facts —— 合并即错', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(withClaimCheck(cc([2, 5, 0], [3, 0])), { runId: 'r-clean' });
    expect(rec.get(id)!.claimCheck).toEqual(cc([2, 5, 0], [3, 0]));
    rec.close();
  });

  test('真检出 → findings>0, 轮数与节点数一并留痕(基率的分子分母都在这一行上)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(withClaimCheck(cc([1, 3, 2], [4, 1])), { runId: 'r-hit' });
    expect(rec.get(id)!.claimCheck).toEqual(cc([1, 3, 2], [4, 1]));
    rec.close();
  });

  test('老库 (无该列) 就地补列不炸', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE omd_dag_runs (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
      node_count INTEGER NOT NULL, question TEXT, levels TEXT NOT NULL, nodes TEXT NOT NULL, usage TEXT NOT NULL)`);
    const rec = createDagRecorder({ db });
    const id = rec.record(withClaimCheck(cc([1, 1, 0], [0, 0])), { runId: 'r-old' });
    expect(rec.get(id)!.claimCheck).toEqual(cc([1, 1, 0], [0, 0]));
    rec.close();
  });
});

describe('★ 「产物没变」判据的分母三态: 没记 / 一次都没判得了 / 真判过', () => {
  // 同上一组是**同一条纪律的第二个实例**, 而这次藏得更深: 那条判据不但要有 conductor,
  // 还要内环**真转到第二圈**且两轮都有产物信号。读数板 ⑧ 段此前拿运行次数当分母, 把 53 跑 0 命中
  // 读成"活体基率 ≈ 0" —— 而真正的分母 (可比较的跨轮次数) 一次都没被记过。
  const am = (transitions: number, unobserved: number, findings: number) => ({ transitions, unobserved, findings });
  const withMove = (v?: ReturnType<typeof am>): ExecutorDagResult =>
    ({ ...fakeResult('am'), ...(v ? { artifactMove: v } : {}) }) as unknown as ExecutorDagResult;

  test('★ 老行 → **缺席**, 不是 transitions:0 (「没记」与「够不着」的下一步不同)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(withMove(), { runId: 'am-na' });
    expect(rec.get(id)!.artifactMove).toBeUndefined();
    rec.close();
  });

  test('★ transitions:0 = 这一跑一次跨轮比较都没发生 —— 记得下来, 不许被当成没记', () => {
    // 单轮档的 dag_run / 首轮即绿的 goal 全长这样。它与上一条在账本里必须分得开。
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(withMove(am(0, 0, 0)), { runId: 'am-zero' });
    expect(rec.get(id)!.artifactMove).toEqual(am(0, 0, 0));
    rec.close();
  });

  test('判不了的那部分单独留痕 —— 基率分母是 transitions - unobserved, 不是 transitions', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(withMove(am(5, 3, 1)), { runId: 'am-mixed' });
    expect(rec.get(id)!.artifactMove).toEqual(am(5, 3, 1));
    rec.close();
  });

  test('老库 (无该列) 就地补列不炸', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE omd_dag_runs (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
      node_count INTEGER NOT NULL, question TEXT, levels TEXT NOT NULL, nodes TEXT NOT NULL, usage TEXT NOT NULL)`);
    const rec = createDagRecorder({ db });
    const id = rec.record(withMove(am(2, 0, 2)), { runId: 'am-old' });
    expect(rec.get(id)!.artifactMove).toEqual(am(2, 0, 2));
    rec.close();
  });
});

describe('★ 运行时写竞争: 与静态那条同名不同义, 所以分开落账', () => {
  // 台账把 static-lint 的 4 次 `write-race` 当成了运行时那条的证据 —— 而运行时通道当时根本不存在。
  // 两者的下一步相反 (前者改图, 后者要问这两个 leaf 为什么碰同一个文件), 合成一列就永远分不开。
  const wr = (overlaps: number, pairs: number, findings: number) => ({ overlaps, pairs, findings });
  const withRace = (v?: ReturnType<typeof wr>): ExecutorDagResult =>
    ({ ...fakeResult('wr'), ...(v ? { writeRace: v } : {}) }) as unknown as ExecutorDagResult;

  test('★ 老行 → 缺席, 不是 overlaps:0', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    expect(rec.get(rec.record(withRace(), { runId: 'wr-na' }))!.writeRace).toBeUndefined();
    rec.close();
  });

  test('★ overlaps:0 = 这一跑压根没并发 —— 与「没记」在账本里分得开', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    expect(rec.get(rec.record(withRace(wr(0, 0, 0)), { runId: 'wr-zero' }))!.writeRace).toEqual(wr(0, 0, 0));
    rec.close();
  });

  test('看不见的那部分 (overlaps - pairs) 留在账本上 —— 它是"该补写的可见性"的读数', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    expect(rec.get(rec.record(withRace(wr(7, 2, 1)), { runId: 'wr-mix' }))!.writeRace).toEqual(wr(7, 2, 1));
    rec.close();
  });

  test('老库 (无该列) 就地补列不炸', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE omd_dag_runs (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
      node_count INTEGER NOT NULL, question TEXT, levels TEXT NOT NULL, nodes TEXT NOT NULL, usage TEXT NOT NULL)`);
    const rec = createDagRecorder({ db });
    expect(rec.get(rec.record(withRace(wr(1, 1, 0)), { runId: 'wr-old' }))!.writeRace).toEqual(wr(1, 1, 0));
    rec.close();
  });
});

/**
 * 外环重修半径进留痕 (2026-08-28)。
 *
 * ## 它治的是「算了不落盘 = 没算」
 *
 * `BlameRetryLedger` 2026-08-10 就造好了 (`engine.ts` 的 `blameRetry = {…}`), 五位数全算出来:
 * blameSize / closureSize / reuseHits / rerunWallMs / replanMode。**但它只活在返回值里** ——
 * 三个 run 记录库 (`~/.omd/dag-runs.db` · `runs.db` · `.wright/dag-runs.db`) 全是 0 行,
 * 日志里 grep 到的「重规划轮开始」全是源码回声。于是「verifier 打回的重修半径到底多大」
 * 这个决定外环投资方向的问题, 至今**一条读数都没有**。
 *
 * ## 反向自检 (这条闸怎么证伪)
 *
 * 把 dag-record.ts 里那句 `result.blameRetry ? JSON.stringify(result.blameRetry) : null`
 * 改成裸 `null`, 第一条当场红。把 NULL 那条的判据从「字段不存在」改成 `blameSize === 0`,
 * 第三条当场红 —— 那正是本列最容易被写错的一格 (仓规坑①: NULL ≠ 0)。
 */
describe('外环重修半径 (blameRetry) 进留痕', () => {
  const led = (blameSize: number, closureSize: number, mode: 'reinject' | 'deterministic' = 'reinject') => ({
    blameSize,
    closureSize,
    reuseHits: 3,
    rerunWallMs: 12_000,
    replanMode: mode,
    replanTokens: { in: 111, out: 222 },
  });
  const withBlame = (l?: ReturnType<typeof led>): ExecutorDagResult =>
    ({ ...fakeResult('goal-execute'), ...(l ? { blameRetry: l } : {}) }) as unknown as ExecutorDagResult;

  test('打回过 → 五位逐字进账本 (闭包放大倍数由此可算)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const got = rec.get(rec.record(withBlame(led(5, 20)), { runId: 'br-1' }))!.blameRetry!;
    expect(got).toEqual(led(5, 20));
    // 这一列存在的**全部理由**: 这个比值今天读不到, 而它决定外环该往哪投。
    expect(got.closureSize / got.blameSize).toBe(4);
    rec.close();
  });

  test('★ blameSize:0 = 打回了但围栏没解析出来 (走整轮) —— 记得下来, 不许当成没打回', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const got = rec.get(rec.record(withBlame(led(0, 0, 'reinject')), { runId: 'br-0' }))!.blameRetry!;
    expect(got.blameSize).toBe(0);
    expect(got.replanMode).toBe('reinject');
    rec.close();
  });

  test('★ 没被打回过 → 字段**缺席**, 与 blameSize:0 分得开 (NULL ≠ 0)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const row = rec.get(rec.record(withBlame(), { runId: 'br-none' }))!;
    expect('blameRetry' in row).toBe(false);
    rec.close();
  });

  test('老库 (无该列) 就地补列不炸', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE omd_dag_runs (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan_name TEXT NOT NULL,
      node_count INTEGER NOT NULL, question TEXT, levels TEXT NOT NULL, nodes TEXT NOT NULL, usage TEXT NOT NULL)`);
    const rec = createDagRecorder({ db });
    expect(rec.get(rec.record(withBlame(led(2, 9)), { runId: 'br-old' }))!.blameRetry).toEqual(led(2, 9));
    rec.close();
  });
});

describe('R-1 · loop 列: 只回填父行, 子 run 行与老行 NULL', () => {
  const graph = (name: string) =>
    ({
      plan: { name, nodes: { a: { goal: 'x' } } },
      levels: [['a']],
      results: { a: { id: 'a', kind: 'agent', status: 'done', deps: [], output: '', usage: { in: 1, out: 1 } } },
      usage: { conductor: { in: 1, out: 1 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 },
    }) as unknown as ExecutorDagResult;
  const loop = {
    path: 'orchestrating-loop' as const,
    route: { kind: 'none' as const, chainHit: false },
    preActionLlmCalls: 1,
    residentPromptChars: 7900,
    verifier: { calls: 2, firstVerdict: 'fail' as const, target: 'criterion' as const, reinjected: true, afterReinject: 'green' as const, recheck: 'pass' as const },
    cards: { calls: 3, ok: 2, rejectedSchema: 1, help: 0, rejectedCompile: 0, childRunError: 0, byCard: { work: 2 }, readOnlyShellBlocked: 1 },
    dispatches: [{ seq: 1, card: 'work' as const, nodes: 1, briefHasRepro: true, failed: 0 }],
  };

  test('★ 父行 (plan_name 点名) 拿到 loop; 同 runId 的子 run 行 (conductor-*) 仍缺席; 别的 runId 不串', () => {
    const rec = createDagRecorder({ db: new Database(':memory:') });
    const parent = rec.record(graph('goal-orchestrating-loop'), { runId: 'g1', entry: 'solve' });
    const child = rec.record(graph('conductor-work-fix-add'), { runId: 'g1', entry: 'solve' });
    const other = rec.record(graph('goal-orchestrating-loop'), { runId: 'g2', entry: 'solve' });
    rec.updateLoop('g1', 'goal-orchestrating-loop', loop);
    // 证伪: updateLoop 的 WHERE 去掉 plan_name → 子行也拿到 loop, 第二条红。
    expect(rec.get(parent)!.loop).toEqual(loop);
    expect(rec.get(child)!.loop).toBeUndefined();
    expect(rec.get(other)!.loop).toBeUndefined();
    rec.close();
  });

  test('老库无 loop 列 → 建 recorder 时 ALTER 补列, 老行读成缺席; 坏 JSON 也读成缺席 (不编形状)', () => {
    const db = new Database(':memory:');
    const rec0 = createDagRecorder({ db });
    const id = rec0.record(graph('goal-orchestrating-loop'), { runId: 'g3', entry: 'solve' });
    db.run(`UPDATE omd_dag_runs SET loop = '{not json' WHERE id = ?`, [id]);
    expect(rec0.get(id)!.loop).toBeUndefined();
    const cols = (db.query('PRAGMA table_info(omd_dag_runs)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('loop');
    rec0.close();
  });
});
