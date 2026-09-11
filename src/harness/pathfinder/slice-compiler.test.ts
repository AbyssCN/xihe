import { describe, expect, test } from 'bun:test';
import { compileSlice, regionIsClear, specGateViolation } from './slice-compiler';
import { PlanSchema } from '../conductor-plan';
import type { PathMap, Ticket } from './types';

function ticket(partial: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket {
  return { type: 'task', title: partial.id, blockedBy: [], status: 'ruled', ...partial };
}
function mapOf(tickets: Ticket[]): PathMap {
  return { destination: 'Ship feature X', slug: 'feat-x', tickets, decisionsLog: [] };
}

describe('compileSlice', () => {
  test('ruled task 票 → PlanNode + 边映射, 且过 PlanSchema', () => {
    const m = mapOf([
      ticket({ id: 'a', ruling: 'build module A', executorKind: 'agent' }),
      ticket({ id: 'b', ruling: 'build module B', executorKind: 'agent', blockedBy: ['a'] }),
    ]);
    const plan = compileSlice(m, ['a', 'b']);
    // schema 校验通过
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    // 每票一节点
    expect(Object.keys(plan.nodes).sort()).toEqual(['a', 'b']);
    // goal = ruling
    expect(plan.nodes.a!.goal).toBe('build module A');
    // 边: b depends_on a
    expect(plan.nodes.b!.depends_on).toEqual(['a']);
    // executorKind 'agent' → PlanNode.executor 'agent'
    expect(plan.nodes.b!.executor).toBe('agent');
  });

  /**
   * #197: 旧「executorKind 缺省 → inproc → leaf」静默回落已摘; 缺 kind 编译期必抛
   * (语义同 pathfinder.ts map_add 装配期闸, 同一份契约两面印)。本条只保留**goal 回落
   * title**那一半, 缺 executorKind 的失败形状搬到下条独立钉。
   */
  test('goal 缺 ruling 时回落 title (executorKind 显式给)', () => {
    const m = mapOf([ticket({ id: 'a', title: 'do the thing', ruling: undefined, executorKind: 'agent' })]);
    // ruling 缺 但 status ruled — 这里显式不给 ruling 测回落
    const withRuled = mapOf([{ ...m.tickets[0]!, status: 'ruled' }]);
    const plan = compileSlice(withRuled, ['a']);
    expect(plan.nodes.a!.goal).toBe('do the thing');
    expect(plan.nodes.a!.executor).toBe('agent');
  });

  /** #197: 缺 executorKind 不再静默 inproc→leaf; 编译期当场抛, 契约抄自 map_add 同源闸。 */
  test('executorKind 缺省 → 抛 (不再静默回落 leaf, #197)', () => {
    const m = mapOf([ticket({ id: 'a', ruling: 'r' })]); // factory 缺省 executorKind 缺席
    expect(() => compileSlice(m, ['a'])).toThrow(/缺 executorKind/);
  });

  test('executorKind 映射: command/agent 直通, inproc → leaf', () => {
    const m = mapOf([
      ticket({ id: 'c', ruling: 'r', executorKind: 'command' }),
      ticket({ id: 'ag', ruling: 'r', executorKind: 'agent' }),
      ticket({ id: 'i', ruling: 'r', executorKind: 'inproc' }),
    ]);
    const plan = compileSlice(m, ['c', 'ag', 'i']);
    expect(plan.nodes.c!.executor).toBe('command');
    expect(plan.nodes.ag!.executor).toBe('agent');
    expect(plan.nodes.i!.executor).toBe('leaf');
  });

  /**
   * 2026-09-11: map / primitive 不再静默塌成 leaf —— 编译期抛。
   * 反向自检: 把 slice-compiler.ts 的 `case 'map': case 'primitive':` 改回 `return 'leaf'` → 本条红。
   */
  test('executorKind map/primitive → 编译期抛, 不降级 leaf', () => {
    for (const kind of ['map', 'primitive'] as const) {
      const m = mapOf([ticket({ id: 'x', ruling: 'r', executorKind: kind })]);
      expect(() => compileSlice(m, ['x'])).toThrow(new RegExp(`executorKind='${kind}'`));
    }
  });

  test('depends_on 只保留 region 内的边 (region 外前置被裁掉) — #197: executorKind 显式给', () => {
    const m = mapOf([
      ticket({ id: 'a', ruling: 'r', executorKind: 'agent' }),
      ticket({ id: 'b', ruling: 'r', blockedBy: ['a', 'outside'], executorKind: 'agent' }),
    ]);
    const plan = compileSlice(m, ['b']); // a 不在 region
    expect(plan.nodes.b!.depends_on ?? []).toEqual([]); // a 与 outside 都被过滤
  });

  test('抛错: region 含未裁票 (雾未散)', () => {
    const m = mapOf([ticket({ id: 'a', status: 'open', ruling: undefined, executorKind: 'agent' })]);
    expect(() => compileSlice(m, ['a'])).toThrow(/ruled|裁/);
  });

  test('抛错: region 含非 task 票', () => {
    const m = mapOf([ticket({ id: 'a', type: 'grill', status: 'ruled', ruling: 'r' })]);
    expect(() => compileSlice(m, ['a'])).toThrow(/task/);
  });

  test('抛错: region 内依赖成环', () => {
    const m = mapOf([
      ticket({ id: 'a', ruling: 'r', blockedBy: ['b'] }),
      ticket({ id: 'b', ruling: 'r', blockedBy: ['a'] }),
    ]);
    expect(() => compileSlice(m, ['a', 'b'])).toThrow(/cycle|环/);
  });

  test('抛错: region 引用不存在的票', () => {
    const m = mapOf([ticket({ id: 'a', ruling: 'r' })]);
    expect(() => compileSlice(m, ['a', 'ghost'])).toThrow();
  });

  test('抛错: region 为空 (无节点)', () => {
    expect(() => compileSlice(mapOf([]), [])).toThrow();
  });
});

describe('regionIsClear', () => {
  test('全 ruled task 且前置都散 → clear', () => {
    const m = mapOf([
      ticket({ id: 'a', ruling: 'r' }),
      ticket({ id: 'b', ruling: 'r', blockedBy: ['a'] }),
    ]);
    expect(regionIsClear(m, ['a', 'b'])).toEqual({ clear: true });
  });

  test('含未裁票 → not clear + reason', () => {
    const m = mapOf([ticket({ id: 'a', status: 'open', ruling: undefined })]);
    const r = regionIsClear(m, ['a']);
    expect(r.clear).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  test('含非 task 票 → not clear', () => {
    const m = mapOf([ticket({ id: 'a', type: 'research', status: 'ruled', ruling: 'r' })]);
    expect(regionIsClear(m, ['a']).clear).toBe(false);
  });

  test('前置 (region 内或外) 未裁 → not clear (open blocker 指进来)', () => {
    const m = mapOf([
      ticket({ id: 'dep', status: 'open', ruling: undefined }),
      ticket({ id: 'a', ruling: 'r', blockedBy: ['dep'] }),
    ]);
    expect(regionIsClear(m, ['a']).clear).toBe(false);
  });

  test('未知票 id → not clear', () => {
    expect(regionIsClear(mapOf([]), ['ghost']).clear).toBe(false);
  });
});

describe('specGateViolation', () => {
  test('简单区域 (<3 票且无 agent) → 豁免 (null)', () => {
    const ts = [
      ticket({ id: 'a', ruling: 'do it' }),
      ticket({ id: 'b', ruling: 'do that' }),
    ];
    expect(specGateViolation(ts)).toBeNull();
  });

  test('≥3 票且无 docs/plan/ 引用 → 拦截 (返回引导文案)', () => {
    const ts = [
      ticket({ id: 'a', ruling: 'do it' }),
      ticket({ id: 'b', ruling: 'do that' }),
      ticket({ id: 'c', ruling: 'do more' }),
    ];
    const v = specGateViolation(ts);
    expect(v).toBeTruthy();
    expect(v).toContain('docs/plan/');
    expect(v).toContain('/omd-contract');
  });

  test('agent 节点且无 docs/plan/ 引用 → 拦截 (即便 <3 票)', () => {
    const ts = [ticket({ id: 'a', ruling: 'complex build', executorKind: 'agent' })];
    const v = specGateViolation(ts);
    expect(v).toBeTruthy();
    expect(v).toContain('agent');
  });

  test('复杂区域但有票 ruling 含 docs/plan/ 引用 → 放行 (null)', () => {
    const ts = [
      ticket({ id: 'a', ruling: '按 docs/plan/2026-07-22-x.md §2 施工' }),
      ticket({ id: 'b', ruling: 'do that' }),
      ticket({ id: 'c', ruling: 'do more' }),
    ];
    expect(specGateViolation(ts)).toBeNull();
  });
});
