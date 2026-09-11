/**
 * src/harness/pathfinder/slice-compiler —— 票 → ConductorPlan 编译器 (组件 5, **零 LLM**)。
 *
 * D-7 adapter B: 散尽区域的 ruled **task** 票 + blockedBy 边 → 直接编译成 ConductorPlan (接缝),
 * 不经廉价模型从散文重推 (消除交接税 D-8)。只**组装不发明** (D-11): 票的 ruling/executorKind
 * 已由裁决定, 编译器只做形状搬运 + Zod 校验。
 *
 * 接缝: import ConductorPlan/PlanSchema from '../conductor-plan' (只读, 不改)。
 *
 * ★ ConductorPlan.executor 枚举 = 'agent'|'leaf'|'command'|'map', 与 Ticket.executorKind
 *   ('command'|'inproc'|'agent'|'map'|'primitive') **不同**。编译期映射 (见 toPlanExecutor):
 *   inproc→leaf (单发模型调用), primitive→leaf (票不带 primitive id/params, 降级为 leaf),
 *   command/agent/map 直通。这是唯一的 shape 适配。
 */
import { PlanSchema, type ConductorPlan } from '../conductor-plan';
import type { ExecutorKind, PathMap, Ticket } from './types';

/**
 * Ticket.executorKind → ConductorPlan.executor 枚举映射。
 * command/agent 直通。inproc → leaf (单发模型调用 = leaf 语义)。
 * primitive 需 kind/primitive/params, map 需完整 MapSpec (lister/over/template) —— 票在编译期
 * **不携带**这些 (D-11 只组装不发明), 强行 emit `executor:'map'` 会撞 PlanSchema 的
 * map⇔executor 互 required 交叉校验。旧行为「降级为 leaf」2026-09-11 摘掉: 改为编译期抛。
 */
function toPlanExecutor(kind: ExecutorKind | undefined): 'agent' | 'leaf' | 'command' | 'map' {
  if (kind === undefined) {
    // 反向自检: 绕过加票入口直接喂 slice-compiler 一张缺省票 → 编译必抛
    throw new Error('票缺 executorKind 不进 slice 图 — 默认会被编成无工具 leaf (单发模型调用, 写不了文件), 跑完却把票翻 delivered; 修复: 显式给 executorKind');
  }
  switch (kind) {
    // D-G1.2: goal 档票不进 slice 图 — 走到这里 = deliver 没分流, 响亮炸而不是静默降级成 leaf
    // (静默降级会把"要收敛的子目标"跑成单发调用, 症状是沉默的)。
    case 'goal':
      throw new Error('goal 档票不进 slice 图 (D-G1.2) — path_deliver 应先分流走 detached solve');
    case 'command':
      return 'command';
    case 'agent':
      return 'agent';
    case 'inproc':
      return 'leaf';
    // 2026-09-11: map / primitive 此前静默塌成 leaf (schema 露 6 个值, 3 个塌成同一个) —— 票要的是
    // 运行期展开的清单节点 / 原语节点, 编成单发 leaf 跑完照样翻 delivered, 症状沉默。票在编译期不携带
    // MapSpec / primitive 参数 (D-11 只组装不发明), 所以这里**拒**, 不降级; 要用它们先把票拆成 agent
    // 或 command, 或等 runtime-finalize 把 spec 接上。反向自检: slice-compiler.test.ts「map/primitive 编译期抛」。
    case 'map':
    case 'primitive':
      throw new Error(`executorKind='${kind}' 票在 slice 编译期无 spec 可展开, 不降级成 leaf — 改 executorKind 为 agent/command, 或补 MapSpec/primitive 参数后再交付`);
    default:
      return 'leaf';
  }
}

/** 取 region 内的票, 缺失即抛 (region 引用不存在的票 = 编译不出)。 */
function collectRegion(map: PathMap, regionTicketIds: string[]): Ticket[] {
  const byId = new Map(map.tickets.map((t) => [t.id, t]));
  return regionTicketIds.map((id) => {
    const t = byId.get(id);
    if (!t) throw new Error(`slice-compiler: region 引用不存在的票 "${id}"`);
    return t;
  });
}

/** region 内 (只含 region 成员的边) 环检测 → 有环即抛。 */
function assertAcyclic(region: Ticket[]): void {
  const inRegion = new Set(region.map((t) => t.id));
  const edges = new Map(region.map((t) => [t.id, t.blockedBy.filter((d) => inRegion.has(d))]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(region.map((t) => [t.id, WHITE]));
  const visit = (id: string): void => {
    color.set(id, GRAY);
    for (const dep of edges.get(id) ?? []) {
      const c = color.get(dep);
      if (c === GRAY) throw new Error(`slice-compiler: region 内依赖成环 (cycle at "${dep}")`);
      if (c === WHITE) visit(dep);
    }
    color.set(id, BLACK);
  };
  for (const t of region) if (color.get(t.id) === WHITE) visit(t.id);
}

/**
 * 编译区域 → 已校验的 ConductorPlan (零 LLM)。
 * 每张 ruled task 票 → 一个 PlanNode (键 = 票 id):
 *  - goal = ruling ?? title
 *  - executor = toPlanExecutor(executorKind) (缺省 inproc→leaf)
 *  - depends_on = blockedBy ∩ region (region 外前置裁掉)
 * 抛错: region 空 / 含未裁票 / 含非 task 票 / 引用不存在 / region 内成环。
 * 出参经 PlanSchema 校验 (弱信任: 代码校验形状, 不信裸构造)。
 */
export function compileSlice(map: PathMap, regionTicketIds: string[]): ConductorPlan {
  if (regionTicketIds.length === 0) throw new Error('slice-compiler: region 为空, 编译不出节点 (plan 需 ≥1 node)');
  const region = collectRegion(map, regionTicketIds);
  const inRegion = new Set(region.map((t) => t.id));

  for (const t of region) {
    if (t.status !== 'ruled') throw new Error(`slice-compiler: region 含未裁票 "${t.id}" (status=${t.status}), 雾未散不能编译`);
    if (t.type !== 'task') throw new Error(`slice-compiler: region 含非 task 票 "${t.id}" (type=${t.type})`);
    // #138 交付级前置硬闸 (readyRegion 的排除是好走的路, 这里拦绕过它直呼编译的):
    // "被裁"≠"真出数" —— #124 差一步就拿从没量出来过的 T=10/W=5 实装 (误杀回测 72:2)。
    for (const dep of t.blockedByDelivery ?? []) {
      const st = map.tickets.find((x) => x.id === dep)?.status;
      if (st !== 'delivered') {
        throw new Error(`slice-compiler: 票 "${t.id}" 的交付前置 "${dep}" 未交付 (status=${st ?? '未知'}) — 等它真出数 (#138)`);
      }
    }
  }
  assertAcyclic(region);

  const nodes: Record<string, Record<string, unknown>> = {};
  for (const t of region) {
    const depends_on = t.blockedBy.filter((d) => inRegion.has(d));
    nodes[t.id] = {
      goal: t.ruling ?? t.title,
      executor: toPlanExecutor(t.executorKind),
      ...(depends_on.length > 0 ? { depends_on } : {}),
    };
  }

  const draft = { name: `pathfinder-slice:${map.slug}`, description: map.destination, nodes };
  const res = PlanSchema.safeParse(draft);
  if (!res.success) {
    throw new Error(`slice-compiler: 编出的 plan 未过 PlanSchema — ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return res.data;
}

/**
 * region 是否已散尽 (可编译): 当且仅当 region 内每票都是 ruled task 票, 且无 open blocker 指进来
 * (每个 blockedBy 指向的票 — region 内或外 — 都已裁)。不抛, 返回 {clear, reason?}。
 */
export function regionIsClear(map: PathMap, regionTicketIds: string[]): { clear: boolean; reason?: string } {
  const byId = new Map(map.tickets.map((t) => [t.id, t]));
  // 前置满足 = ruled ∨ delivered (delivered 是"已裁且已交付"的终态, 不能反而挡住后续区域)。
  const ruled = new Set(map.tickets.filter((t) => t.status === 'ruled' || t.status === 'delivered').map((t) => t.id));
  if (regionTicketIds.length === 0) return { clear: false, reason: 'region 为空' };
  for (const id of regionTicketIds) {
    const t = byId.get(id);
    if (!t) return { clear: false, reason: `未知票 "${id}"` };
    // D-G1.1: prototype 票可进区域 (goal 档默认载体); 其余类型仍拒 (research/grill 不是交付单位)。
    if (t.type !== 'task' && t.type !== 'prototype') return { clear: false, reason: `票 "${id}" 非 task/prototype (type=${t.type})` };
    if (t.status !== 'ruled') return { clear: false, reason: `票 "${id}" 未裁 (status=${t.status})` };
    for (const dep of t.blockedBy) {
      if (!ruled.has(dep)) return { clear: false, reason: `票 "${id}" 的前置 "${dep}" 未裁 (open blocker 指进来)` };
    }
    // #138 交付级前置的**硬闸半** (readyRegion 的排除是好走的路, 这里拦绕过它直呼编译的):
    // "被裁"不等于"真出数" —— #124 差一步就拿着从没量出来过的 T=10/W=5 实装 (误杀回测 72:2)。
    for (const dep of t.blockedByDelivery ?? []) {
      if (byId.get(dep)?.status !== 'delivered') {
        return { clear: false, reason: `票 "${id}" 的交付前置 "${dep}" 未交付 (status=${byId.get(dep)?.status ?? '未知'}) — 等它真出数 (#138)` };
      }
    }
  }
  return { clear: true };
}

/**
 * deliver spec 护栏 (纯函数, **权力闸层用**, 不进 compileSlice —— D-11 编译器只组装不发明,
 * 护栏是 deliver 层的政策闸不是编译逻辑)。把「复杂活必须有契约」从纪律变可证伪的闸。
 *
 * 入参 = 待交付区域的 task 票。判定「复杂区域」= task 票数 ≥3 **或** 任一票 executorKind==='agent'。
 * 复杂且**没有任何一张票**的 ruling 含 `docs/plan/` 引用 → 返回引导文案 (含修复路径); 否则 null。
 * 简单区域 (<3 票且无 agent 节点) 直接豁免 (null): 小活不必背契约。
 */
export function specGateViolation(tickets: Ticket[]): string | null {
  const taskCount = tickets.filter((t) => t.type === 'task').length;
  const hasAgentNode = tickets.some((t) => t.executorKind === 'agent');
  const complex = taskCount >= 3 || hasAgentNode;
  if (!complex) return null;
  const hasContractRef = tickets.some((t) => (t.ruling ?? '').includes('docs/plan/'));
  if (hasContractRef) return null;
  const why = hasAgentNode
    ? `含 agent 执行节点 (${taskCount} 张 task 票)`
    : `${taskCount} 张 task 票 (≥3)`;
  return [
    `◈ deliver 拦截: 复杂区域 (${why}) 缺契约引用 —— 无任何票的 ruling 含 docs/plan/ 章节引用。`,
    '  复杂活必须有契约: 先 /omd-contract 结晶契约, 把 ruling 补上 docs/plan/ 章节引用后重试;',
    '  简单区域 (<3 票且无 agent 节点) 不受此闸约束。',
  ].join('\n');
}
