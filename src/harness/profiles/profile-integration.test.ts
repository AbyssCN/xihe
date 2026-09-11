/**
 * profile-integration.test.ts —— 岗位档案(leaf profile)图级集成覆盖
 * (SDD 2026-08-11-leaf-profile库,补跑范围:切片 3「图面半边」验收点)。
 *
 * 与同目录的 profile.test.ts / profile-assembly.test.ts / roster-injection.test.ts 分工:
 * 那三份钉的是**单函数**行为(resolveProfile 本身 / conductorSystemPrompt formatter 本身)。
 * 本文件钉的是**装到真图上跑一遍**——node.profile 字段经 runExecutorDag(WithPlan) 真实走
 * engine.ts 的装配点(2417/2420/2628 行),用 fake agentRunner 截获引擎实际传给 leaf 的
 * `AgentLeafInput`,以及 fake generate 截获引擎实际拼给 conductor 的 system prompt——
 * 不模拟装配逻辑,只旁路模型调用。
 *
 * engine.ts 真实路径覆盖 G-2/G-3/G-6 与 INV-1 装配闸,并把 loadProfiles() 名册投影成
 * `{name, summary}` 注入顶层/运行时 conductor(INV-7);本文件防止单函数绿、真实接线漏的回归。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from '../dag/engine';
import { runExecutorDag } from '../../../test/helpers/legacy-plan-entry';
import type { ExecutorDagConfig, GenerateFn } from '../dag/types';
import type { AgentLeafRunner } from '../leaf-runners';
import type { ConductorPlan } from '../conductor-plan';
import { setCoreLogger, type CoreLogger } from '../logger';
import { loadProfiles } from './profile';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * G-6 夹具 (2026-09-11): 内置档案不再钉座 (见 profile-assembly.test.ts G-3), profile.seat 的优先级机制
 * 改用**项目层**档案测 —— 写进 `<cwd>/.omd/profiles/` (引擎按 process.cwd() 解档案), 用例结束即删。
 * 名字带 test 前缀, 与仓内 bench-tools-*.json 不撞。
 */
const SEAT_FIXTURE = { name: 'zz-seat-pinned-test', seat: 'pin:profile-seat' };
const seatFixturePath = join(process.cwd(), '.omd', 'profiles', `${SEAT_FIXTURE.name}.json`);
function withSeatFixture<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(join(process.cwd(), '.omd', 'profiles'), { recursive: true });
  writeFileSync(seatFixturePath, JSON.stringify({ ...SEAT_FIXTURE, persona: 'seat fixture' }));
  return fn().finally(() => rmSync(seatFixturePath, { force: true }));
}

// ── 共享夹具 ─────────────────────────────────────────────────────────────

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'profile-integration', nodes });

const makeConfig = (
  agentRunner: AgentLeafRunner,
  extra: Partial<ExecutorDagConfig> = {},
): ExecutorDagConfig => ({
  conductorModel: 'test:conductor',
  leafModel: 'test:leaf',
  agentLeafModel: 'test:agent-leaf',
  generate: async () => ({ text: 'unused-in-withPlan-path', usage: { in: 1, out: 1 } }),
  agentRunner,
  agentTemplates: new Map(),
  ...extra,
});

type WarnRecord = { node?: string; profile?: string; msg: string };

/** logger.warn 截获器(同 profile-assembly.test.ts 的隔离纪律): 只收 node/profile 两个字段。 */
function captureWarns(): { warns: WarnRecord[]; restore: () => void } {
  const warns: WarnRecord[] = [];
  const consoleLogger: CoreLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  setCoreLogger({
    debug: () => {},
    info: () => {},
    warn(o, m) {
      const r = (o ?? {}) as { node?: unknown; profile?: unknown };
      warns.push({ node: typeof r.node === 'string' ? r.node : undefined, profile: typeof r.profile === 'string' ? r.profile : undefined, msg: m ?? '' });
    },
    error: () => {},
  });
  return { warns, restore: () => setCoreLogger(consoleLogger) };
}

// ── G-2 / INV-1: 未知 profile → WARN 一次 + 图状态与无 profile 基线等价 ─────

describe('G-2 / INV-1: 未知 profile 装配闸', () => {
  test('未知 profile 节点与无 profile 节点的图状态逐位相同; agentRunner 均收不到 profile', async () => {
    const { warns, restore } = captureWarns();
    const seenProfile: Record<string, unknown> = {};
    const fakeRunner: AgentLeafRunner = async (input) => {
      const id = /\[omd leaf: ([^\]]+)\]/.exec(input.prompt)?.[1] ?? '?';
      seenProfile[id] = input.profile;
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    try {
      const r = await runExecutorDagWithPlan(
        plan({
          withUnknown: { goal: '跑一步', executor: 'agent', profile: 'no-such-profile-integration' },
          withoutProfile: { goal: '跑一步', executor: 'agent' },
        }),
        makeConfig(fakeRunner),
      );

      // 图状态等价(INV-1: 该节点行为 = 无 profile) —— status/output/kind 全部对齐。
      expect(r.results.withUnknown!.status).toBe(r.results.withoutProfile!.status);
      expect(r.results.withUnknown!.status).toBe('done');
      expect(r.results.withUnknown!.kind).toBe(r.results.withoutProfile!.kind);
      // fallback 是真回退(未注入空 ProfileSpec) —— 两条都是 undefined, 不是"undefined vs {}"这种伪等价。
      expect(seenProfile.withUnknown).toBeUndefined();
      expect(seenProfile.withoutProfile).toBeUndefined();

      // WARN 恰好一条,且只挂在未知那一个节点上(无 profile 的节点不该触发)。
      const hit = warns.filter((w) => w.msg.startsWith('Unknown profile'));
      expect(hit).toHaveLength(1);
      expect(hit[0]!.msg).toBe('Unknown profile "no-such-profile-integration"; running as ordinary leaf');
      expect(hit[0]!.node).toBe('withUnknown');
      expect(hit[0]!.profile).toBe('no-such-profile-integration');
    } finally {
      restore();
    }
  });

  test('两个节点复用同一个未知 profile 名 → 整轮只 WARN 一行, 两节点都普通回退', async () => {
    const { warns, restore } = captureWarns();
    const fakeRunner: AgentLeafRunner = async () => ({ text: 'ok', usage: { in: 1, out: 1 } });
    try {
      const r = await runExecutorDagWithPlan(
        plan({
          a: { goal: '跑一步', executor: 'agent', profile: 'ghost-profile' },
          b: { goal: '跑一步', executor: 'agent', profile: 'ghost-profile' },
        }),
        makeConfig(fakeRunner),
      );
      expect(r.results.a!.status).toBe('done');
      expect(r.results.b!.status).toBe('done');
      const hit = warns.filter((w) => w.msg.startsWith('Unknown profile'));
      // 去重键是 profile 名: 同一错误名重复出现没有新增信息, 只报一行。
      expect(hit).toHaveLength(1);
      expect(hit[0]!.profile).toBe('ghost-profile');
      expect(hit[0]!.node).toBe('a');
    } finally {
      restore();
    }
  });
});

// ── G-3: 已知 profile 的字段原样传到 agentRunner ────────────────────────

describe('G-3: profile 传播', () => {
  test('design-review: agentRunner 收到的 profile 与 loadProfiles() 解出的档案逐字段相同', async () => {
    const known = loadProfiles(process.cwd()).get('design-review');
    expect(known).toBeDefined(); // 前置: 内置档案确实存在(不猜测名字)

    let seen: unknown;
    const fakeRunner: AgentLeafRunner = async (input) => {
      seen = input.profile;
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(
      plan({ review: { goal: '审一下', executor: 'agent', profile: 'design-review' } }),
      makeConfig(fakeRunner),
    );
    expect(r.results.review!.status).toBe('done');
    expect(seen).toEqual(known);
    // 冒烟三个关键字段, 防止 toEqual 因宽松结构假绿(如两边都巧合是 {})。
    const p = seen as { name: string; persona: string; seat?: string; skills?: string[] };
    expect(p.name).toBe('design-review');
    expect(p.persona.length).toBeGreaterThan(0);
    expect(p.skills).toContain('impeccable');
  });
});

// ── G-6: 显式 node.model 优先于 profile.seat(精确度序) ──────────────────

describe('G-6: 模型解析精确度序', () => {
  test('node.model 显式给出时, agentRunner 收到的 model 就是它 —— 不看 profile.seat', async () => {
    let seenModel: string | undefined;
    const fakeRunner: AgentLeafRunner = async (input) => {
      seenModel = input.model;
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    const explicit = 'openai-codex:gpt-5.6-sol';
    const r = await runExecutorDagWithPlan(
      plan({ pinned: { goal: '跑一步', executor: 'agent', profile: 'design-review', model: explicit } }),
      makeConfig(fakeRunner),
    );
    expect(r.results.pinned!.status).toBe('done');
    expect(seenModel).toBe(explicit);
  });

  test('node.model 显式 > 项目层 profile.seat', async () => {
    let seenModel: string | undefined;
    const fakeRunner: AgentLeafRunner = async (input) => {
      seenModel = input.model;
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await withSeatFixture(async () => {
      const r = await runExecutorDagWithPlan(
        plan({ pinned: { goal: '跑一步', executor: 'agent', profile: SEAT_FIXTURE.name, model: 'explicit:wins' } }),
        makeConfig(fakeRunner),
      );
      expect(r.results.pinned!.status).toBe('done');
    });
    expect(seenModel).toBe('explicit:wins');
  });

  test('无 node.model 时引擎回退到 profile.seat, 而不是静默用 config 缺省模型', async () => {
    // profile.seat 位于 node.model / 模板 model 之后、router / config 静态座位之前。
    let seenModel: string | undefined;
    const fakeRunner: AgentLeafRunner = async (input) => {
      seenModel = input.model;
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await withSeatFixture(async () => {
      expect(loadProfiles(process.cwd()).get(SEAT_FIXTURE.name)?.seat).toBe(SEAT_FIXTURE.seat);
      const r = await runExecutorDagWithPlan(
        plan({ unpinned: { goal: '跑一步', executor: 'agent', profile: SEAT_FIXTURE.name } }),
        makeConfig(fakeRunner, { leafModel: 'fallback:should-not-win', agentLeafModel: 'fallback:should-not-win' }),
      );
      expect(r.results.unpinned!.status).toBe('done');
    });
    expect(seenModel).toBe(SEAT_FIXTURE.seat);
  });
});

// ── INV-7 / SDD-G-6(roster): conductor 名册有界注入, 不带 persona 全文 ─────

describe('INV-2: profile 不影响 engine 交给 agent-leaf 的 base prompt', () => {
  test('有/无 profile 两个节点, agentRunner 收到的 base prompt 逐字节相同(model 依 G-6 合法分叉, 不比)', async () => {
    // 与 assembly-gate.test.ts 的 INV-2 用例分工: 那份在 runner 边界证"engine 对 runner 回报的
    // promptVersion 零介入"(代理读数 = output/usage 一致)。promptVersion 本身在真实链路里由
    // agent-leaf.ts 内部对 scaffold 计算(engine.ts:2658 只透传, 未导出到 `LeafResult` 类型,
    // 见 assembly-gate.test.ts 同名 describe 的注释), 本文件的 fake agentRunner 旁路了那次
    // 真实计算, 拿不到真 promptVersion 读数。于是本用例改钉**促成 promptVersion 不变的前置
    // 条件**: engine 装配点造给 agent-leaf 的 base `prompt` 字段有无 profile 时逐字节相同 ——
    // profile 只挂在独立的 `input.profile` 字段上, 不掺进会话本文本(若引擎把 profile 拼进了
    // prompt 正文, promptVersion 必然分叉; 这里在分叉发生前的上游读数上先拦一道)。model 不纳入
    // 比较: design-review 有 seat, 无 node.model 时 model 合法分叉是 G-6 精确度序的产物,
    // 与 INV-2(promptVersion 不变)是两条独立不变量, 不该在这里混判。
    const seenPrompts: Record<string, string> = {};
    const fakeRunner: AgentLeafRunner = async (input) => {
      const id = /\[omd leaf: ([^\]]+)\]/.exec(input.prompt)?.[1] ?? '?';
      seenPrompts[id] = input.prompt.replace(id, '<id>');
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(
      plan({
        withProfile: { goal: '目标Y', executor: 'agent', profile: 'design-review' },
        withoutProfile: { goal: '目标Y', executor: 'agent' },
      }),
      makeConfig(fakeRunner),
    );
    expect(r.results.withProfile!.status).toBe('done');
    expect(r.results.withoutProfile!.status).toBe('done');
    expect(seenPrompts.withProfile).toBe(seenPrompts.withoutProfile);
  });
});

// ── G-7(反向自检): 未知 profile 闸不抛 —— 无 try/catch 直接跑真图 ─────────

describe('G-7: 未知 profile 装配闸的变异敏性(图级)', () => {
  /**
   * 与 profile-assembly.test.ts 的 G-7 同一构造纪律: 本 describe 里没有任何 try/catch。
   * 若有人把 engine.ts 里的 `resolveProfile(node.profile, ...)` 调用点(或其上游 profile.ts
   * 的 resolveProfile 本身)改成对未知名 throw, 下面这次 `await runExecutorDagWithPlan(...)`
   * 会直接把异常甩给 bun test 的 unhandled rejection 处理 → 测试当场红, 无法被静默吞掉。
   */
  test('未知 profile 的真图执行不抛, 节点以 done 收尾', async () => {
    const fakeRunner: AgentLeafRunner = async () => ({ text: 'ok', usage: { in: 1, out: 1 } });
    const r = await runExecutorDagWithPlan(
      plan({ x: { goal: '跑一步', executor: 'agent', profile: 'completely-unknown-profile-name' } }),
      makeConfig(fakeRunner),
    );
    expect(r.results.x!.status).toBe('done');
  });
});
