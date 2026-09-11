/**
 * pathfinder MCP 工具面测试: 全链 map→add→rule→deliver 在临时 cwd 上走通 (fake executeSlice,
 * 永不真跑模型/真 spawn); 交付语义与 TUI 同款 (全节点 done 才翻 delivered, 失败可重试)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPathfinderTools, type PathfinderToolDeps } from './pathfinder';
import { loadMap, saveMap } from '../../harness/pathfinder/map-store';
import { dispatchPhaseOf } from '../../serve/board-page';
import type { Ticket } from '../../harness/pathfinder/types';
import { createOmdMemory } from '../../harness/memory/store';
import { validateFactWrite } from '../../memory/safeguards/validator';
import { checkEvolve } from '../../memory/safeguards/evolution-lock';
import { ConfidenceSchema } from '../../memory/safeguards/namespace-kernel';
import type { ValidatedFact } from '../../memory/safeguards/namespaces';

function tools(cwd: string, overrides: Partial<PathfinderToolDeps> = {}) {
  const deps: PathfinderToolDeps = {
    cwd,
    env: {},
    models: { conductorModel: '', leafModel: 'fake:leaf' },
    agentRunner: (async () => ({ text: '', usage: { in: 0, out: 0 } })) as PathfinderToolDeps['agentRunner'],
    commandRunner: (async () => ({ text: '', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 })) as PathfinderToolDeps['commandRunner'],
    dispatchFrontier: (() => ({ dispatched: [], reported: [] })) as unknown as PathfinderToolDeps['dispatchFrontier'],
    ...overrides,
  };
  const list = createPathfinderTools(deps);
  const byName = new Map(list.map((t) => [t.name, t]));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await byName.get(name)!.handler(args as never, {} as never)) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: r.content[0]!.text, isError: r.isError === true };
  };
  return { call };
}

describe('pathfinder MCP tools', () => {
  /**
   * #197③ 装配期那一半 —— 裁决要求「两处各证一次」, 而实装落地时只钉了 slice-compiler 那半
   * (slice-compiler.test.ts:47 `executorKind 缺省 → 抛`), map_add 这半只有注释没有用例。
   * 冻结判据 `grep -q "无工具" src/mcp/tools/pathfinder.ts` 只查这三个字在不在文件里,
   * 拦不住「有闸无证」—— 同 #165 那条假反向自检, 今晚第三次同一形状, 故补钉。
   *
   * ★ 反向自检 (已实测会红): 摘掉 pathfinder.ts:387 那个 `executorKind === undefined` 判断
   *   → task/prototype 两条 isError 断言同时红 (票会被正常建出来)。
   */
  test('#197③ map_add 缺 executorKind 即拒 (task/prototype), research/grill 不受影响', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const { call } = tools(dir);
      await call('path_map', { destination: 'Ship X' });

      for (const type of ['task', 'prototype'] as const) {
        const r = await call('path_add', { title: `缺 kind 的 ${type} 票`, type });
        expect(r.isError).toBe(true);
        // 判词要说清「为什么」, 不能只说「缺参数」—— 裁决①逐字要求。
        expect(r.text).toContain('无工具');
        expect(r.text).toContain('delivered');
      }
      // 一张都没建出来。
      expect((await call('path_tickets')).text).toContain('0 tickets');

      // research/grill 不是交付单位 → 缺省照收 (裁决①的范围下界)。
      for (const type of ['research', 'grill'] as const) {
        expect((await call('path_add', { title: `${type} 票`, type })).isError).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 2026-09-11: task 票 executorKind=map/primitive 装配期即拒 (slice 编译期本就无 spec 可展开)。
   * 反向自检: 摘掉 pathfinder.ts 里那道闸 → 本条第一段红 (票被收下)。
   */
  test('map_add 拒 task 票的 executorKind=map/primitive; agent/command/inproc 照收', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const { call } = tools(dir);
      await call('path_map', { destination: 'Ship X' });
      for (const executorKind of ['map', 'primitive'] as const) {
        const r = await call('path_add', { title: `${executorKind} 票`, type: 'task', executorKind });
        expect(r.isError).toBe(true);
        expect(r.text).toContain(`executorKind='${executorKind}'`);
        expect(r.text).toContain('agent');
      }
      expect((await call('path_tickets')).text).toContain('0 tickets');
      for (const executorKind of ['agent', 'command', 'inproc'] as const) {
        expect((await call('path_add', { title: `${executorKind} 票`, type: 'task', executorKind })).isError).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('map→add→rule→deliver 全链: 区域报信 → 显式交付 → 票翻 delivered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      let executed = 0;
      const { call } = tools(dir, {
        executeSlice: (async (plan: { nodes: Record<string, unknown> }) => {
          executed++;
          return {
            results: Object.fromEntries(Object.keys(plan.nodes).map((id) => [id, { status: 'done' }])),
          };
        }) as unknown as PathfinderToolDeps['executeSlice'],
      });

      expect((await call('path_map')).text).toContain('无开放地图');
      expect((await call('path_map', { destination: 'Ship X' })).text).toContain('slug=ship-x');

      // #197: executorKind 显式给 (用 'inproc' 取代旧静默回落; 'agent' 会撞 spec gate 因 ruling 无 docs/plan/)
      const add = await call('path_add', { title: 'build the thing', type: 'task', executorKind: 'inproc' });
      expect(add.text).toContain('✓ 已加票 t1');

      const rule = await call('path_rule', { ticketId: 't1', ruling: 'do it with bun' });
      expect(rule.text).toContain('✓ 已裁 t1');
      expect(rule.text).toContain('path_deliver'); // 区域散尽只报信
      expect(executed).toBe(0); // rule 绝不执行

      const deliver = await call('path_deliver');
      expect(deliver.isError).toBe(false);
      expect(executed).toBe(1);
      expect(deliver.text).toContain('已交付');
      expect(deliver.text).toContain('delivered=1');

      // 已交付区域不复入: 再 deliver 无可交付。
      const again = await call('path_deliver');
      expect(again.isError).toBe(true);
      expect(executed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deliver 失败不标记: 有节点未 done → isError, 票保持 ruled 可重试', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const { call } = tools(dir, {
        executeSlice: (async () => ({ results: { t1: { status: 'failed' } } })) as unknown as PathfinderToolDeps['executeSlice'],
      });
      await call('path_map', { destination: 'Ship X' });
      // #197: 同上 ('inproc' 取代旧静默回落)
      await call('path_add', { title: 'build', type: 'task', executorKind: 'inproc' });
      await call('path_rule', { ticketId: 't1', ruling: 'go' });
      const deliver = await call('path_deliver');
      expect(deliver.isError).toBe(true);
      expect(deliver.text).toContain('未标记交付');
      // 仍可交付 (票还是 ruled)。
      expect((await call('path_tickets')).text).toContain('ruled=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deliver spec 护栏: 复杂区域 (≥3 票) 缺 docs/plan/ 引用 → 拦截, 不编译不执行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      let executed = 0;
      const { call } = tools(dir, {
        executeSlice: (async () => {
          executed++;
          return { results: {} };
        }) as unknown as PathfinderToolDeps['executeSlice'],
      });
      await call('path_map', { destination: 'Ship X' });
      // 3 张 task 票 → 复杂区域, ruling 都无 docs/plan/ 引用 → 应被闸拦。
      for (const id of ['t1', 't2', 't3']) {
        // #197: executorKind 显式给
        await call('path_add', { title: `build ${id}`, type: 'task', id, executorKind: 'agent' });
        await call('path_rule', { ticketId: id, ruling: `just do ${id}` });
      }
      const deliver = await call('path_deliver');
      expect(deliver.isError).toBe(true);
      expect(deliver.text).toContain('docs/plan/');
      expect(deliver.text).toContain('/omd-contract');
      expect(executed).toBe(0); // 拦下时无 dag 执行调用
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * **prototype 票的隔离今天没生效, 而回话得说出来**(2026-08-06 查实)。
   *
   * D-13 给 prototype 设计的隔离 worktree 住在 `pathfinder/dispatch.ts` 的 `case 'prototype'` 里,
   * 而它**没有生产调用者** —— `dispatchFrontier` 只自动派 research 票, 注释说 prototype
   * 「仅 reported 给 UI 由人显式触发」,**而那个触发口从来没建过**
   * (盘上 `.omd/pathfinder/proto/` 一个目录都没有)。
   *
   * prototype 票实际走的是 `readyRegion → path_deliver → detached solve`, 而这条路
   * **不传 `branchStrategy`** → 缺省 `head` → **直接写主树**。
   * 于是「沙盒 spike, 试验码不污主树」这句话在生产上是反的。
   *
   * ⚠ 这条只钉**说出来**, 不钉改行为 —— 改成隔离是单独的决定 (隔离树看不见未提交的活),
   *   不是一行 default 的事。
   */
  test('★ prototype 票 fire 时, 回话必须说出「它正在直接写主树」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-proto-'));
    try {
      const { call } = tools(dir, {
        dispatchGoal: (() => ({ runId: 'r-proto', already: false })) as unknown as PathfinderToolDeps['dispatchGoal'],
      });
      await call('path_map', { destination: 'Ship X' });
      // #197: prototype 显式 executorKind='goal' (#135 prototype 恒 goal 档)
      await call('path_add', { title: 'spike 一下', type: 'prototype', id: 'p1', executorKind: 'goal' });
      await call('path_rule', { ticketId: 'p1', ruling: '试一版看看' });
      const deliver = await call('path_deliver');
      expect(deliver.text).toContain('prototype');
      expect(deliver.text).toContain('直接写主树'); // ← 本用例的全部意义
      expect(deliver.text).toContain('D-13');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('path_init 引导两步流: 无 backend → 报告; md 全参 → 执行建本地图', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      // 注入探针替身 (全绿) + 一触发即抛的 gh (md 路径不该调 gh)。
      const initOverrides: PathfinderToolDeps['initOverrides'] = {
        probes: {
          isGitRepo: () => true,
          githubRemote: () => 'acme/repo',
          ghAuthScopes: () => ['repo', 'workflow'],
          repoVisibility: () => 'private',
          actionsEnabled: () => true,
          hasKey: () => true,
        },
        gh: () => {
          throw new Error('md 路径不该调 gh');
        },
      };
      const { call } = tools(dir, { initOverrides });

      // 第一步: 无 backend → 探测报告 + 推荐, 不执行。
      const report = await call('path_init', { destination: 'Ship X' });
      expect(report.isError).toBe(false);
      expect(report.text).toContain('探测报告');
      expect(report.text).toContain('推荐: backend=gh');

      // 第二步: md 全参 → 执行建本地图。
      const exec = await call('path_init', { destination: 'Ship X', backend: 'md' });
      expect(exec.isError).toBe(false);
      expect(exec.text).toContain('backend=md');
      // 建成的图后续 path_map 可见。
      expect((await call('path_map')).text).toContain('ship-x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('裁决写 memory: 经注入替身断言 fact 形状 (omd.pattern + scanSecrets:false)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const writes: Array<{ fact: Record<string, unknown>; opts: { scanSecrets?: boolean } }> = [];
      const memory: PathfinderToolDeps['memory'] = {
        writeFact: (async (fact: Record<string, unknown>, opts: { scanSecrets?: boolean } = {}) => {
          writes.push({ fact, opts });
          return { status: 'written', id: 'm1', action: 'insert' };
        }) as NonNullable<PathfinderToolDeps['memory']>['writeFact'],
      };
      const { call } = tools(dir, { memory });

      await call('path_map', { destination: 'Ship Widget' });
      await call('path_add', { title: 'pick the datastore', type: 'grill' });
      const rule = await call('path_rule', { ticketId: 'g1', ruling: 'use SQLite' });
      expect(rule.isError).toBe(false);
      expect(rule.text).toContain('✓ 已裁 g1');

      expect(writes.length).toBe(1);
      const { fact, opts } = writes[0]!;
      expect(fact.namespace).toBe('omd.pattern');
      expect(fact.situation).toBe('Ship Widget: pick the datastore');
      expect(fact.approach).toBe('use SQLite');
      expect(fact.outcome).toBe('worked');
      // memory_remember 同款: 显式写绕过密钥闸 (用户主权)。
      expect(opts.scanSecrets).toBe(false);
      // 裁决 8 改判 human_verified 后, confidence 为 owner 确认态。
      const conf = fact.confidence as Record<string, unknown>;
      expect(conf.level).toBe('human_verified');
      expect(conf.by).toBe('owner');
      expect(conf.verified_at).toBeInstanceOf(Date);
      expect(conf.note).toBe('path_rule:ship-widget:g1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('裁决写 memory 真往返: 真 OmdMemory remember → recall(destination 关键词) 召回该 fact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    const memory = createOmdMemory(); // 默认 :memory: + UNIVERSAL_SAFEGUARD (含 omd.pattern), 进程内真往返。
    try {
      const { call } = tools(dir, { memory });
      await call('path_map', { destination: 'Ship Widget' });
      await call('path_add', { title: 'pick the datastore', type: 'grill' });
      await call('path_rule', { ticketId: 'g1', ruling: 'use SQLite for the ledger' });

      // 消费端真检索 (memory_recall 同款 retrieve): 用 destination 关键词命中该裁决 fact。
      const hits = await memory.retrieve('Widget datastore', 10);
      expect(hits.length).toBeGreaterThan(0);
      const joined = hits.map((h) => h.text).join('\n');
      expect(joined).toContain('use SQLite for the ledger');
      expect(joined).toContain('Ship Widget');
    } finally {
      memory.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('裁决写 memory 失败不阻断: writeFact throw → 裁决仍成功 + warn 行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const memory: PathfinderToolDeps['memory'] = {
        writeFact: (async () => {
          throw new Error('memory offline');
        }) as NonNullable<PathfinderToolDeps['memory']>['writeFact'],
      };
      const { call } = tools(dir, { memory });
      await call('path_map', { destination: 'Ship Widget' });
      await call('path_add', { title: 'x', type: 'grill' });
      const rule = await call('path_rule', { ticketId: 'g1', ruling: 'go' });
      // 裁决本身不受 memory 故障影响 (增益不是链路)。
      expect(rule.isError).toBe(false);
      expect(rule.text).toContain('✓ 已裁 g1');
      expect(rule.text).toContain('⚠');
      expect(rule.text).toContain('memory 是增益');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('slug 歧义: 多图省略 slug → 报错列 slug; blockedBy 引用不存在 → 拒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const { call } = tools(dir);
      await call('path_map', { destination: 'Ship X' });
      await call('path_map', { destination: 'Ship Y' });
      const amb = await call('path_tickets');
      expect(amb.isError).toBe(true);
      expect(amb.text).toContain('ship-x');
      const bad = await call('path_add', { title: 'x', slug: 'ship-x', blockedBy: ['nope'] });
      expect(bad.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 闸 (a): path_rule 写入的 fact (human_verified) 过 validator 不被拒。
   *
   * 反向自检: 把 pathfinder.ts:271 临时改成 `{ level:'agent_confident', source_event_ids:[anchor], created_at:new Date() }`
   * (单锚, 不满足 agent_confident 的 min(3) source_event_ids) → validator 返回 `schema:Too small: expected array to have >=3 items`。
   * 证伪方式: 改 pathfinder.ts → 跑本测试 → 见 `expect(v.ok).toBe(true)` 变红, reason 如上。
   * 已改回 human_verified 形态, 测试绿。
   */
  test('闸(a): path_rule 写入 human_verified fact 过 validator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
    try {
      const writes: Array<Record<string, unknown>> = [];
      const memory: PathfinderToolDeps['memory'] = {
        writeFact: (async (fact: Record<string, unknown>) => {
          writes.push(fact);
          return { status: 'written', id: 'm1', action: 'insert' };
        }) as NonNullable<PathfinderToolDeps['memory']>['writeFact'],
      };
      const { call } = tools(dir, { memory });

      await call('path_map', { destination: 'Ship V' });
      await call('path_add', { title: 'choose db', type: 'grill' });
      await call('path_rule', { ticketId: 'g1', ruling: 'use pg' });

      expect(writes.length).toBe(1);
      const fact = writes[0]!;

      // 过全量 validator (与 writeFact 实际路径同款)。
      const v = validateFactWrite(fact);
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.validated.confidence.level).toBe('human_verified');
      }

      // 额外: 确认 agent_confident 单锚确实会被 schema 拒 (文档化, 非运行时闸)。
      const bad = ConfidenceSchema.safeParse({
        level: 'agent_confident',
        source_event_ids: ['single-anchor'],
        created_at: new Date(),
      });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(bad.error.issues[0]?.message).toContain('3');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 闸 (b): 同 identity 已有 human_verified → agent_tentative 写入被 checkEvolve 拒。
   *
   * 反向自检: 把 existing 从 human_verified 改成 agent_tentative (同 identity), 同样 incoming 应为 replace。
   * 证伪方式: 改 existing.confidence 为 tentative → 跑本测试 → 见 `expect(result.action).toBe('reject')` 变红,
   * action='replace'。已改回 human_verified, 测试绿。证明闸分得开 human_verified(reject) 与 tentative(replace) 两档。
   */
  test('闸(b): human_verified 现有 → agent_tentative 写入 checkEvolve 判 reject', () => {
    const existing: ValidatedFact = {
      namespace: 'omd.pattern',
      situation: 'Ship X: pick db',
      approach: 'use SQLite',
      outcome: 'worked',
      source_event_id: 'path_rule:ship-x:g1',
      confidence: {
        level: 'human_verified',
        by: 'owner',
        verified_at: new Date('2026-08-01'),
        note: 'path_rule:ship-x:g1',
      },
    };

    const incoming: ValidatedFact = {
      namespace: 'omd.pattern',
      situation: 'Ship X: pick db',
      approach: 'use Postgres',
      outcome: 'worked',
      source_event_id: 'path_rule:ship-x:g1-v2',
      confidence: {
        level: 'agent_tentative',
        source_event_ids: ['path_rule:ship-x:g1-v2'],
        created_at: new Date('2026-08-02'),
      },
    };

    // human_verified 是 immutable → reject
    const result = checkEvolve(existing, incoming);
    expect(result.action).toBe('reject');
    expect(result.reason).toBe('human-verified-immutable');

    // 反向自检: existing 为 tentative 时, 同样 incoming 应为 replace
    const existingTentative: ValidatedFact = {
      ...existing,
      confidence: {
        level: 'agent_tentative',
        source_event_ids: ['path_rule:ship-x:g1'],
        created_at: new Date('2026-08-01'),
      },
    };
    const resultReplace = checkEvolve(existingTentative, incoming);
    expect(resultReplace.action).toBe('replace');
  });
});
/**
 * **切片 6 ②④** —— 第二条派发路径的装配期闸 + 等人超时扫描接线
 * (SDD `docs/plan/2026-08-11-control-plane-unification.md` G-4 / G-5 / G-6)。
 *
 * ⚠ 这两条闸都建立在同一个事实上: `readyRegion` / 前沿计算**不看票的类** —— 它们判的是
 * type + status。于是一张被人手改成 `ticketClass: 'ruling'` 的 ruled task 票, 今天照样进
 * 待交付区域, 照样被编译进 slice 交给执行体。裁决票要的是人裁, 不是执行体 (INV-2)。
 * 违规样本就按"真相文件被人手改"的形状造 (saveMap 直写), 那是它真实的来路。
 */
describe('★ 切片6② path_deliver 的两条派发路径都拒裁决票 (G-4/G-6)', () => {
  /** 造一张图: 一张 ruled task 票, 可选标类。 */
  function seed(dir: string, cls?: string): void {
    // #197: executorKind 显式给; 旧缺省 inproc→leaf 已被裁
    const t: Ticket = { id: 't1', type: 'task', title: '干活', blockedBy: [], status: 'ruled', ruling: '按 docs/plan/x.md 干', executorKind: 'agent' };
    if (cls) (t as Ticket & { ticketClass?: string }).ticketClass = cls;
    saveMap({ destination: 'Ship X', slug: 'ship-x', tickets: [t], decisionsLog: [] }, dir);
  }

  test('★ slice 路径: 区域里混进裁决票 → 编译前整批拒, executeSlice 一次都不调', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-cls-'));
    try {
      seed(dir, 'ruling');
      let executed = 0;
      const { call } = tools(dir, {
        executeSlice: (async () => ((executed++), { results: {}, verification: { pass: true } })) as unknown as PathfinderToolDeps['executeSlice'],
      });
      const r = await call('path_deliver');
      // 证伪: 去掉 path_deliver 里那个 assertDispatchable 循环 → 区域照跑, executed 变 1, 这条红。
      expect(r.isError).toBe(true);
      expect(r.text).toContain('装配期拒');
      expect(r.text).toContain('t1');
      expect(executed).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('★ 未标类的同一张票照旧交付 (证明这不是"恒拒" —— 存量语义逐字节不变)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-cls-'));
    try {
      seed(dir); // 只差 ticketClass 一个字段
      let executed = 0;
      const { call } = tools(dir, {
        executeSlice: (async (plan: { nodes: Record<string, unknown> }) => (
          (executed++), { results: Object.fromEntries(Object.keys(plan.nodes).map((id) => [id, { status: 'done' }])) }
        )) as unknown as PathfinderToolDeps['executeSlice'],
      });
      const r = await call('path_deliver');
      expect(r.isError).toBe(false);
      expect(executed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('★ goal 档路径: 裁决票 → fire 失败一行, 派发替身一次都不被调 (不掀同批其它票)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-cls-'));
    try {
      const t = (id: string, cls?: string): Ticket => {
        const x: Ticket = { id, type: 'task', title: `活 ${id}`, blockedBy: [], status: 'ruled', ruling: `干 ${id}`, executorKind: 'goal' };
        if (cls) (x as Ticket & { ticketClass?: string }).ticketClass = cls;
        return x;
      };
      saveMap({ destination: 'Ship X', slug: 'ship-x', tickets: [t('g1', 'ruling'), t('g2')], decisionsLog: [] }, dir);
      const fired: string[] = [];
      const { call } = tools(dir, {
        dispatchGoal: ((_c: string, _s: string, gt: Ticket) => {
          fired.push(gt.id);
          return { runId: 'run-x', already: false };
        }) as unknown as PathfinderToolDeps['dispatchGoal'],
      });
      const r = await call('path_deliver');
      // 证伪: 摘掉 dispatchGoalTicket 首行的 assertDispatchable (或这里的 assertDispatchable 包装)
      // → g1 进 fired, 这条红。同批的 g2 必须照常 fire —— 闸不是故障。
      expect(fired).toEqual(['g2']);
      expect(r.text).toContain('✗ goal 票 g1');
      expect(r.text).toContain('裁决票永不可派发');
      expect(r.text).toContain('◈ goal 票 g2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('★ 切片6④ path_tickets 顺手扫等人超时 (D-5/G-5)', () => {
  const H = 3_600_000;
  const ago = (h: number): string => new Date(Date.now() - h * H).toISOString();

  test('★ 等了 73h 的 escalated 票 → 标 stale + 台账存盘 + 回话念出来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-sweep-'));
    try {
      const t: Ticket = { id: 'g1', type: 'grill', title: '等人裁的问题', blockedBy: [], status: 'escalated', waitingSince: ago(73) };
      saveMap({ destination: 'Ship X', slug: 'ship-x', tickets: [t], decisionsLog: [] }, dir);
      const { call } = tools(dir);
      const r = await call('path_tickets');
      // 证伪: 摘掉 makeTickets 里的 backend.sweepWaiting 调用 → 回话没这行且盘上没 staleAt, 这条红。
      expect(r.text).toContain('等人超时: g1');
      const after = loadMap(dir, 'ship-x')!;
      expect(after.tickets[0]!.staleAt).toBeTruthy(); // 存盘了 (mutateMap 那一跳真的走到)
      expect(after.waitingLog).toHaveLength(1);
      // 幂等: 同一轮等待只标一次 (再看一次不再重复报)。
      expect((await call('path_tickets')).text).not.toContain('等人超时: g1');
      expect(loadMap(dir, 'ship-x')!.waitingLog).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('★ 才等了 1h 的票不报 + 没记进入时刻的票不报 (fail-safe: 不知道等了多久就不催)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-sweep-'));
    try {
      saveMap(
        {
          destination: 'Ship X',
          slug: 'ship-x',
          tickets: [
            { id: 'g1', type: 'grill', title: '刚等上', blockedBy: [], status: 'escalated', waitingSince: ago(1) },
            { id: 'g2', type: 'grill', title: '老票没戳', blockedBy: [], status: 'escalated' },
          ],
          decisionsLog: [],
        },
        dir,
      );
      const { call } = tools(dir);
      // 证伪: 把 sweepWaitingHuman 的 `waiting-unknown-since` 也当 waiting 升级 (缺席回落到 0) →
      // g2 立刻"等了 56 年"被标 stale, 这条红。那正是 NULL≠0 要挡的抹平。
      expect((await call('path_tickets')).text).not.toContain('等人超时');
      expect(loadMap(dir, 'ship-x')!.waitingLog).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * D-6③ 派发锚 (control-plane G-2「票→runId→回执」双向可达) —— 控制台 SDD D-3 两新列的地基。
 *
 * 改这条之前:runId 在 `path_deliver` 里现造、只喂 recorder, 跑完直接 markDelivered ——
 * 「这些票 ↔ 这个 run」的事实在那一行产生、当场被扔掉, 票从 ruled 直接跳 delivered。
 */
describe('D-6③ 派发锚: 票 → runId', () => {
  const setup = async (dir: string, exec: unknown) => {
    const { call } = tools(dir, { executeSlice: exec as PathfinderToolDeps['executeSlice'] });
    await call('path_map', { destination: 'Ship X' });
    // #197: executorKind 显式给 ('inproc' 取代旧静默回落, 不撞 spec gate)
    await call('path_add', { title: 'build the thing', type: 'task', executorKind: 'inproc' });
    await call('path_rule', { ticketId: 't1', ruling: 'do it with bun' });
    return call;
  };
  const ticket = (dir: string): Ticket => loadMap(dir, 'ship-x')!.tickets.find((t) => t.id === 't1')!;

  test('派发**期间**锚已在盘上且无 finishedAt → in-flight (锚必须早于 exec 写)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-anchor-'));
    try {
      let midRun: Ticket | undefined;
      const call = await setup(dir, async (plan: { nodes: Record<string, unknown> }) => {
        // 在执行**当中**读盘 —— 这是本条的全部意义: 锚若写在 exec 之后,「正在跑」那一列
        // 永远看不到任何票 (窗口为零)。证伪: 把 markDispatch(open) 挪到 exec 之后 → 这里读到 undefined。
        midRun = ticket(dir);
        return { results: Object.fromEntries(Object.keys(plan.nodes).map((id) => [id, { status: 'done' }])) };
      });
      await call('path_deliver');

      expect(midRun?.dispatch).toBeDefined();
      // runId 形状 = `<destination-slug>-<6hex>` (src/harness/dag/run-id.ts mintRunId) —— 任务可读、撞名有防。
      expect(midRun!.dispatch!.runId).toMatch(/^ship-x-[0-9a-f]{6}$/);
      expect(midRun!.dispatch!.finishedAt).toBeUndefined(); // 还在跑
      expect(dispatchPhaseOf(midRun!)).toBe('in-flight');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('跑过 → 锚 settle 成 passed, 票进 delivered, 相位归 null (它由 status 说了算)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-anchor-'));
    try {
      const call = await setup(dir, async (plan: { nodes: Record<string, unknown> }) => ({
        results: Object.fromEntries(Object.keys(plan.nodes).map((id) => [id, { status: 'done' }])),
      }));
      await call('path_deliver');

      const t = ticket(dir);
      expect(t.status).toBe('delivered');
      expect(t.dispatch!.outcome).toBe('passed');
      expect(t.dispatch!.finishedAt).toBeTruthy();
      expect(dispatchPhaseOf(t)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('跑挂 → 票仍 ruled + 锚已 settle → in-review (「跑完待验」这一列的数据源)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-anchor-'));
    try {
      const call = await setup(dir, async (plan: { nodes: Record<string, unknown> }) => ({
        results: Object.fromEntries(Object.keys(plan.nodes).map((id) => [id, { status: 'failed' }])),
      }));
      const r = await call('path_deliver');
      expect(r.isError).toBe(true);

      const t = ticket(dir);
      expect(t.status).toBe('ruled'); // 失败不翻交付 (既有语义, 不动)
      expect(t.dispatch!.outcome).toBe('failed');
      // 证伪: 删掉失败分支里的 settle('failed') → finishedAt 缺席 → 相位变 in-flight (永远在跑)。
      expect(dispatchPhaseOf(t)).toBe('in-review');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exec 抛错 → finally 兜住 settle, 票不会永远停在「正在跑」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-anchor-'));
    try {
      const call = await setup(dir, async () => {
        throw new Error('boom');
      });
      const r = await call('path_deliver');
      expect(r.isError).toBe(true);

      const t = ticket(dir);
      // 证伪: 去掉 finally 里的 settle('failed') → finishedAt 缺席 → in-flight 永久悬挂。
      expect(t.dispatch!.finishedAt).toBeTruthy();
      expect(dispatchPhaseOf(t)).toBe('in-review');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dispatchPhaseOf 纯判据四格 (缺席 ≠ 在跑 ≠ 待验)', () => {
    const base = { status: 'ruled' as const };
    expect(dispatchPhaseOf(base)).toBeNull(); // 从没派发过
    expect(dispatchPhaseOf({ ...base, dispatch: { runId: 'r', startedAt: 'x' } })).toBe('in-flight');
    expect(dispatchPhaseOf({ ...base, dispatch: { runId: 'r', startedAt: 'x', finishedAt: 'y', outcome: 'failed' } })).toBe('in-review');
    // 跑过了但 markDelivered 没执行到 (进程死在两步之间) 也算「跑完待验」—— 刻意不看 outcome。
    expect(dispatchPhaseOf({ ...base, dispatch: { runId: 'r', startedAt: 'x', finishedAt: 'y', outcome: 'passed' } })).toBe('in-review');
    expect(dispatchPhaseOf({ status: 'delivered', dispatch: { runId: 'r', startedAt: 'x', finishedAt: 'y', outcome: 'passed' } })).toBeNull();
  });
});

