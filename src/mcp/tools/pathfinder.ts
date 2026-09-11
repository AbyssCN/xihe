/**
 * src/mcp/tools/pathfinder — pathfinder 决策地图的 MCP 工具面 (TUI-less 入口)。
 *
 * 背景: pathfinder 的命令面 (/path /tickets /rule /deliver) 原生长在 TUI 扩展上; MCP 客户端
 * (Claude 经 `omd mcp`) 不跑 TUI → 此处把同一套纯逻辑 (map-store/frontier/slice-compiler/
 * dispatch/afk-hook) 拆成六个无状态工具。**状态全在磁盘** (docs/plan/pathfinder/*.md 真相 +
 * .omd/pathfinder/*): MCP server 无常驻 watcher, 改为**每次 path_tickets/path_rule 先做一次
 * once-tick 回流** (landed AFK 结果折进地图) + 预算内 D-10 自续 —— pull 模型替代 TUI 的 4s 轮询。
 *
 * 权力闸与 TUI 同款: 区域散尽只报信, 执行必须显式 path_deliver (owner 扣扳机);
 * research 派发幂等 (结果已在/在途 pid 活着不重 spawn)。
 */
import { z } from 'zod';
import type { OmdMcpTool } from '../server';
import {
  executeSlice as realExecuteSlice,
  type ExecuteSliceOpts,
} from '../../harness/execute-slice';
import type { AgentLeafRunner, CommandLeafRunner } from '../../harness/leaf-runners';
import { slugifyDestination } from '../../harness/pathfinder/maps';
import {
  resolveBackend as realResolveBackend,
  type PathBackend,
} from '../../harness/pathfinder/backend';
import { makeInitDeps, runInit, type InitDeps } from '../../harness/pathfinder/init';
import {
  assertDispatchable,
  countDispatchedResearch,
  dispatchFrontier as realDispatchFrontier,
  dispatchGoalTicket as realDispatchGoalTicket,
} from '../../harness/pathfinder/dispatch';
import { reflowGoalResults, reflowOwnerCommands, reflowResearchResults } from '../../harness/pathfinder/afk-hook';
import { computeFrontier } from '../../harness/pathfinder/frontier';
import { mintRunId } from '../../harness/dag/run-id';
import { compileSlice, regionIsClear, specGateViolation } from '../../harness/pathfinder/slice-compiler';
import {
  canConfirm,
  canRule,
  resolveTicketId,
} from '../../harness/pathfinder/ticket-guard';
import type { PathMap, Ticket, TicketType } from '../../harness/pathfinder/types';
import type { OmdMemory } from '../../harness/memory/store';
import type { DagRecorder } from '../../harness/dag/dag-record';
import type { HudMirror } from '../../hud/mirror';
import { compactFog } from '../../hud/fog';

export interface PathfinderToolDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** slice 执行模型 (assemble 的 env 角色矩阵解析结果)。leafModel 空 → path_deliver 给引导 isError。 */
  models: { conductorModel: string; leafModel: string; agentLeafModel?: string };
  agentRunner: AgentLeafRunner;
  commandRunner: CommandLeafRunner;
  /** 注入接缝 (测试传替身, 永不真执行/真 spawn)。 */
  executeSlice?: typeof realExecuteSlice;
  dispatchFrontier?: typeof realDispatchFrontier;
  /** D-G1.2 注入接缝 (测试传替身, 永不起真 solve 进程)。 */
  dispatchGoal?: typeof realDispatchGoalTicket;
  /** 后端解析器 (省略 = resolveBackend(cwd, {env}): env OMD_PATH_BACKEND > 仓库配置 > md)。测试注入 gh 替身。 */
  resolveBackend?: (cwd: string) => PathBackend;
  /** omd-hud 迷雾镜像 (给则每次 renderStatus 把当前地图迷雾原子写 .omd/hud/fog.json)。省略 = 不写。 */
  hudMirror?: HudMirror;
  /**
   * 记忆接缝 (裁决增益): path_rule 成功后把「<destination>: <title> 裁决 = <ruling>」记为 omd.pattern
   * fact, 经 memory_remember 同款底层 (OmdMemory.writeFact, scanSecrets:false 用户主权), **不绕道 MCP
   * 工具面自调**。省略 = 不写 (纯导航测试无需); assemble 注入同款 OmdMemory。写入失败 warn 不 throw ——
   * 裁决已落 Issues/md, memory 是增益不是链路。
   */
  memory?: Pick<OmdMemory, 'writeFact'>;
  /** path_init 执行接缝覆盖 (测试注入 probes/gh/canary 替身; 省略 = 生产默认 gh/git/env 探测)。 */
  initOverrides?: Partial<InitDeps>;
  /**
   * 运行留痕器 (2026-08-02 补)。**此前 `path_deliver` 一次都没记过** —— 它是四个会真跑图的入口里
   * 唯一不进账本的那个,于是「各入口占比」这个读数会**系统性缺慢回路那一块**,
   * 而缺一个入口与"没人用这个入口"在读数上长得一模一样。省略 = 不留痕 (纯导航测试无需)。
   */
  recorder?: DagRecorder;
}

/** 八工具: path_init + path_map / path_add / path_tickets / path_rule / path_deliver / path_prefetch + map_confirm (S-1)。 */
export function createPathfinderTools(deps: PathfinderToolDeps): OmdMcpTool[] {
  return [makeInit(deps), makeMap(deps), makeAdd(deps), makeTickets(deps), makeRule(deps), makeConfirm(deps), makeDeliver(deps), makePrefetch(deps)];
}

// ── 共享 helpers ──────────────────────────────────────────────────────────────

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true as const });

/** 后端 throw 的错误取干净正文 (不带 "Error:" 前缀), 直接当工具 isError 文案。 */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 挑后端 (每次工具调用现挑; gh 会现探 repo, 无缓存层 — 与 SDD "实时拼" 一致)。 */
function backendOf(deps: PathfinderToolDeps): PathBackend {
  return (deps.resolveBackend ?? ((cwd: string) => realResolveBackend(cwd, { env: deps.env })))(deps.cwd);
}

/** slug 解析: 显式给 → 用; 省略 → 恰一张开放地图用它, 零/多张 → 报错列 slug。 */
function resolveSlug(backend: PathBackend, cwd: string, slug: string | undefined): { slug: string } | { error: string } {
  if (slug) {
    if (!backend.readMap(cwd, slug)) return { error: `找不到地图 "${slug}" — path_map 列出/新建` };
    return { slug };
  }
  const maps = backend.listMaps(cwd);
  if (maps.length === 0) return { error: '无开放地图 — path_map 带 destination 新建一张' };
  if (maps.length > 1) return { error: `多张开放地图, 需显式 slug: ${maps.map((m) => m.slug).join(', ')}` };
  return { slug: maps[0]!.slug };
}

/**
 * `resolveTicketId` 已在切片 1 抽到 `src/harness/pathfinder/ticket-guard.ts` (INV-BOX-1) ——
 * MCP 与 TUI 共用一份实现。下面这一行是**唯一**对外接口, 别再在本文件里改它。
 *
 * ## 这处漂的历史 (2026-08-19 实测, 改前记录)
 *
 * 同一个票 id 写法曾在这里的三条路里各做各事:
 *   · `path_rule` 的 suggested 守卫走精确匹配 (`t.id === ticketId`); 传裸 `177` 时
 *     `find` 返回 undefined → **守卫不响**;
 *   · `backend.rule` 写路走 `bareNumber()` 归一 (`backend-gh.ts`) → 裸 `177` 照样命中
 *     → **真去 comment + close**;
 *   · `map_confirm` 完全不归一 → 裸 `177` 报「票不存在」。
 * 同一张 suggested 票, `#177` 被守卫拒, `177` 直接裁掉并写了 gh。
 *
 * 抽到 `ticket-guard.ts` 后 `canRule` / `canConfirm` 同一把 `resolveTicketId`,
 * 该漂移**已经封堵**: 裸 id 与 `#` 前缀从此同解, suggested 守卫也不再走精确匹配。
 * 本注释保留作为闸存在的理由 —— 谁删谁负责 (#206 / SDD 片 6 INV-BOX-1)。
 */
export { resolveTicketId } from '../../harness/pathfinder/ticket-guard';

/** 列图 + 现算 open/frontier 计数 (两后端一致: listMaps 只给 slug/destination, 计数用 readMap+computeFrontier)。 */
function listMapsWithCounts(backend: PathBackend, cwd: string): Array<{ slug: string; destination: string; openCount: number; frontierCount: number }> {
  return backend.listMaps(cwd).map(({ slug, destination }) => {
    const map = backend.readMap(cwd, slug);
    const openCount = map ? map.tickets.filter((t) => t.status !== 'ruled' && t.status !== 'escalated').length : 0;
    const frontierCount = map ? computeFrontier(map).length : 0;
    return { slug, destination, openCount, frontierCount };
  });
}

function ticketLine(t: Ticket): string {
  return `• [${t.type}] ${t.id}: ${t.title}${t.status !== 'open' ? ` (${t.status})` : ''}`;
}

/** 战争迷雾条: █=delivered/ruled ▒=open frontier ░=blocked, 条宽 10。 */
export function fogBar(map: PathMap): string {
  const total = map.tickets.length;
  if (total === 0) return '          0/0 散雾';
  let ruled = 0, open = 0, blocked = 0;
  for (const t of map.tickets) {
    if (t.status === 'delivered' || t.status === 'ruled') ruled++;
    else if (t.status === 'blocked') blocked++;
    else open++;
  }
  const W = 10;
  const rb = Math.round((ruled / total) * W);
  const ob = Math.round((open / total) * W);
  const bb = W - rb - ob;
  const bar = '█'.repeat(Math.max(0, rb)) + '▒'.repeat(Math.max(0, ob)) + '░'.repeat(Math.max(0, bb));
  const ruledIds = map.tickets.filter((t) => t.status === 'delivered' || t.status === 'ruled').map((t) => t.id);
  const openIds = map.tickets.filter((t) => t.status !== 'delivered' && t.status !== 'ruled' && t.status !== 'blocked').map((t) => t.id);
  const blockedIds = map.tickets.filter((t) => t.status === 'blocked').map((t) => t.id);
  const lines = [
    `<${map.destination}>  ${bar}  ${ruled}/${total} 散雾`,
    `█ ${ruledIds.join(' ') || '—'}`,
    `▒ ${openIds.join(' ') || '—'}`,
    `░ ${blockedIds.join(' ') || '—'}`,
  ];
  return lines.join('\n');
}

/** 地图快照文本: 目的地 + 状态计数 + 前沿逐行 + 区域散尽提示 (path_deliver 报信)。
 *  副作用: 给 hudMirror 则把当前迷雾原子写 fog.json (omd-hud 数据源; fail-open 内建)。 */
function renderStatus(map: PathMap, hudMirror?: HudMirror): string {
  hudMirror?.writeFog(compactFog(map));
  const fr = computeFrontier(map);
  const counts = new Map<string, number>();
  for (const t of map.tickets) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const countStr = [...counts.entries()].map(([s, n]) => `${s}=${n}`).join(' ') || 'empty';
  const lines = [
    `◈ ${map.destination} (slug=${map.slug}) — ${map.tickets.length} tickets [${countStr}]`,
    fogBar(map),
     fr.length === 0 ? '前沿空 (全裁决/受阻/已交付)。' : `前沿 (${fr.length}):`,
     ...fr.map((t) => `  ${ticketLine(t)}`),
  ];
  const suggested = map.tickets.filter((t) => t.status === 'suggested');
  if (suggested.length > 0) {
    lines.push(`✋ 待确认建议 (${suggested.length}) — map_confirm accept/reject:`);
    for (const t of suggested) lines.push(`  • [${t.type}] ${t.id}: ${t.title} (来源 ${t.suggestedBy ?? '?'})`);
  }
  const region = readyRegion(map);
  if (region) {
    const parts: string[] = [];
    if (region.slice.length > 0) {
      try {
        compileSlice(map, region.slice);
        parts.push(`slice ${region.slice.length} 张编译通过`);
      } catch (e) {
        parts.push(`slice 编译失败: ${String(e)}`);
      }
    }
    if (region.goals.length > 0) parts.push(`goal 档 ${region.goals.length} 张待 fire solve`);
    lines.push(`★ 区域散尽 (${parts.join(' · ')}) — path_deliver 执行交付。`);
  }
  return lines.join('\n');
}

/** goal 档判定 (D-G1.1 / #135 裁②): 显式 executorKind='goal', 或 **prototype 一律** ——
 * 按 type 判, 与 executorKind 无关。旧判据 (prototype 仅在 executorKind 省略时走 goal) 让
 * prototype+agent 掉进 slice 而 compileSlice 拒非 task 票, 建票合法、几天后交付才炸 (#103 实踩)。
 * prototype 的语义就是"要收敛的实验", solve 环正是四要素实验的载体。 */
function isGoalKind(t: Ticket): boolean {
  return t.executorKind === 'goal' || t.type === 'prototype';
}

/** 可交付区域, 分流形状 (D-G1.2): slice = 编入 DAG 的票; goals = 逐张走 detached solve 的票。
 * ruled 的 task/prototype 票进区域 (delivered 终态不复入); 未散尽 → null。
 * #138: 交付级前置未满足的 ruled 票**排除** (ruled-but-waiting) 而不是冻结整区 ——
 * 一张等数据的票不押别的可交付票当人质; regionIsClear 另有硬闸拦绕行。
 * export 给 suggested.test 钉 INV-S1-1 (suggested 永不入区域); 生产只有本文件消费。 */
export function readyRegion(map: PathMap): { slice: string[]; goals: string[] } | null {
  const delivered = new Set(map.tickets.filter((t) => t.status === 'delivered').map((t) => t.id));
  const ruled = map.tickets.filter(
    (t) =>
      (t.type === 'task' || t.type === 'prototype') &&
      t.status === 'ruled' &&
      (t.blockedByDelivery ?? []).every((id) => delivered.has(id)),
  );
  if (ruled.length === 0) return null;
  const ids = ruled.map((t) => t.id);
  if (!regionIsClear(map, ids).clear) return null;
  return {
    slice: ruled.filter((t) => !isGoalKind(t)).map((t) => t.id),
    goals: ruled.filter(isGoalKind).map((t) => t.id),
  };
}

/**
 * once-tick 回流 + 预算内 D-10 自续 (MCP 无常驻 watcher 的 pull 等价):
 * landed 结果经**后端无关**折入 (reflowResearchResults: md 存盘文件 / gh issue 评论) → 新孵 research
 * 子票在预算内自动续派。返回回流摘要行 (无事 → [])。折入的状态读写全经 backend, 此处只做编排 + 记账。
 */
function reflowOnce(deps: PathfinderToolDeps, backend: PathBackend, slug: string): string[] {
  const { cwd } = deps;
  const dispatch = deps.dispatchFrontier ?? realDispatchFrontier;
  const outcomes = reflowResearchResults(backend, cwd, slug);
  const lines: string[] = [];
  // 评论裁决先折 (第五程): owner 在 GitHub 评论区写的 /rule /confirm 先落, 后面的 goal/research
  // 折入与区域计算才看得见最新裁决 (顺序错了会在过期视图上算前沿)。
  for (const oc of reflowOwnerCommands(backend, cwd, slug)) {
    lines.push(`◈ 评论裁决 ${oc.ticketId} [${oc.command}]: ${oc.applied ? '✓' : '✗'} ${oc.note}`);
  }
  // D-G1.3/G1.4: goal 票回流 (交付语义) — 与 research (蒸馏语义) 两条折入并行, 同一次 pull。
  for (const g of reflowGoalResults(backend, cwd, slug)) {
    const label = g.disposition === 'delivered' ? '已交付' : g.disposition === 'escalated' ? '需人 (escalated)' : `可续跑 (${g.outcome})`;
    lines.push(`◈ goal 票 ${g.ticketId} 回流: ${label} · runId ${g.runId}${g.suggested ? ` · 发现物→${g.suggested}` : ''}${g.warning ? ` ⚠ ${g.warning}` : ''}`);
  }
  let hadResearchChildren = false;
  for (const o of outcomes) {
    if (o.warning !== undefined) {
      // 结果缺失/折入失败: 票据可见, 未 ack, 下轮重试 (不静默跳过)。
      lines.push(`⚠ AFK 回流: ${o.ticketId} 结果未折入 (${o.warning}) — 未确认, 下轮重试。`);
      continue;
    }
    const childTail = o.newChildren.length ? ` (+${o.newChildren.length} 子票)` : '';
    const dropTail = o.droppedChildren ? ` (超上限丢弃 ${o.droppedChildren})` : '';
    lines.push(`↩ AFK 回流: ${o.ticketId} 已裁${childTail}${dropTail}`);
    if (o.newChildren.some((c) => c.type === 'research')) hadResearchChildren = true;
  }
  if (hadResearchChildren) {
    const budget = Number(deps.env.OMD_PATH_RESEARCH_BUDGET ?? 12);
    const used = countDispatchedResearch(cwd, slug);
    if (used >= budget) {
      lines.push(`⏸ 研究预算已用尽 (${used}/${budget}) — 自续暂停; 调 OMD_PATH_RESEARCH_BUDGET 或 path_prefetch 显式追加。`);
    } else {
      const fresh = backend.readMap(cwd, slug);
      if (fresh) {
        // 派发路径判据接后端 kind: gh 子票走云端 label 触发, md 走本地 detached 子进程。
        const fd = dispatch(fresh, { cwd, slug, backend: backend.kind }, {});
        if (fd.dispatched.length > 0) lines.push(`⚡ 自续: ${fd.dispatched.length} 张 research 子票入 AFK 后台 (预算 ${used + fd.dispatched.length}/${budget})。`);
      }
    }
  }
  return lines;
}

/**
 * 裁决写 memory (增益, 非链路): path_rule 成功后把「<destination>: <title> 裁决 = <ruling>」记为
 * omd.pattern fact (situation = 问题<destination>: <title>, approach = 裁决 ruling)。走注入的
 * OmdMemory.writeFact —— memory_remember 同款底层 + 同款 scanSecrets:false (用户主权, 裁决文本不过密钥闸)。
 * 写失败/被拒 warn 不 throw: 裁决已落 Issues/md, memory 只是消费端 (memory_recall / /start) 的检索增益。
 * 无 memory 接缝 → null (不写)。返回一行警告供工具输出, 成功则静默 (不污染裁决回报)。
 */
async function rememberRuling(
  deps: PathfinderToolDeps,
  map: PathMap,
  ticketId: string,
  ruling: string,
): Promise<string | null> {
  const memory = deps.memory;
  if (!memory) return null;
  const title = map.tickets.find((t) => t.id === ticketId)?.title ?? ticketId;
  const anchor = `path_rule:${map.slug}:${ticketId}`;
  const fact = {
    namespace: 'omd.pattern',
    situation: `${map.destination}: ${title}`,
    approach: ruling,
    outcome: 'worked' as const, // 裁决 = owner 拍板采纳的走法 (决定态即 "采用")。
    source_event_id: anchor,
    confidence: { level: 'human_verified' as const, by: 'owner', verified_at: new Date(), note: anchor },
  };
  try {
    const result = await memory.writeFact(fact, { scanSecrets: false });
    if (result.status === 'rejected') {
      return `⚠ 裁决未写入 memory (${result.reason}) — 裁决已落地, memory 是增益。`;
    }
    return null;
  } catch (e) {
    return `⚠ 裁决写 memory 失败 (${errMsg(e)}) — 裁决已落地, memory 是增益。`;
  }
}

// ── path_init ────────────────────────────────────────────────────────────────
//
// 独立工具 (非 path_map 增动作): init = 环境探测 + 后端选定 + 云端接线 (labels/secrets/canary/config)
// 的重副作用一次性编排, 与 path_map 的"列图/建图/看前沿"轻导航正交。折进 path_map 会给它塞
// action 判别符 + backend/cloudAfk 参, 污染每轮都调的导航工具 schema (D-11 description 税);
// 拆独立工具两者 schema 各自干净, MCP 客户端各自可发现。init 是**唯一**合法挑后端的地方 (探测决定),
// 不违 D-A (map/add/rule/deliver 仍零 backend.kind 分支)。

function makeInit(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_init',
    description: 'Init pathfinder backend: no args → probe report + recommendation; with backend/cloudAfk → execute setup.',
    inputSchema: {
      destination: z.string().optional().describe('Map destination text (required when executing; omit in report mode)'),
      backend: z.enum(['gh', 'md']).optional().describe('Backend choice; omit → return probe report + recommended answers'),
      cloudAfk: z.boolean().optional().describe('gh only: enable cloud AFK research (public repo → decision history is publicly readable)'),
    },
    handler: async ({ destination, backend, cloudAfk }) => {
      const initDeps = makeInitDeps(deps.cwd, deps.env, deps.initOverrides);
      const outcome = runInit(
        {
          ...(destination !== undefined ? { destination: destination as string } : {}),
          ...(backend !== undefined ? { backend: backend as 'gh' | 'md' } : {}),
          ...(cloudAfk !== undefined ? { cloudAfk: cloudAfk as boolean } : {}),
        },
        initDeps,
      );
      return outcome.isError ? err(outcome.text) : ok(outcome.text);
    },
  };
}

// ── path_map ─────────────────────────────────────────────────────────────────

function makeMap(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_map',
    description: 'Pathfinder map: no arg lists open maps; with destination/slug creates or resumes one and shows its frontier.',
    inputSchema: {
      destination: z.string().optional().describe('Destination text or existing slug; omit to list open maps'),
    },
    handler: async ({ destination }) => {
      const { cwd } = deps;
      const backend = backendOf(deps);
      if (!destination) {
        const maps = listMapsWithCounts(backend, cwd);
        if (maps.length === 0) return ok('无开放地图。path_map 带 destination 新建一张。');
        return ok(maps.map((m) => `• ${m.slug}: ${m.destination} (${m.openCount} open, ${m.frontierCount} frontier)`).join('\n'));
      }
      const d = destination as string;
      // 命中 (slug 原文 / slug 化后 / 目的地相等) → resume; 否则新建 (与 TUI /path 同语义)。
      const maps = backend.listMaps(cwd);
      const hit = maps.find((m) => m.slug === d || m.destination === d || m.slug === slugifyDestination(d));
      try {
        const map = hit ? backend.readMap(cwd, hit.slug)! : backend.createMap(cwd, d, slugifyDestination(d));
        return ok(renderStatus(map, deps.hudMirror));
      } catch (e) {
        return err(errMsg(e));
      }
    },
  };
}

// ── path_add ─────────────────────────────────────────────────────────────────

const TICKET_TYPES = ['research', 'grill', 'prototype', 'task'] as const;

function makeAdd(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_add',
    description: 'Add a ticket to a pathfinder map. Types: research (AFK auto) / grill (discuss) / prototype (spike) / task (build).',
    inputSchema: {
      title: z.string().describe('The open question / work item, one line'),
      type: z.enum(TICKET_TYPES).default('task').describe('Ticket type (default task)'),
      slug: z.string().optional().describe('Map slug (omit = the single open map)'),
      id: z.string().optional().describe('Stable ticket id (omit = auto t1/r1/…)'),
      blockedBy: z.array(z.string()).default([]).describe('Prerequisite ticket ids (gates ruling: all must be ruled before this enters the frontier)'),
      blockedByDelivery: z.array(z.string()).default([]).describe('#138: delivery-level prerequisites — these tickets must be DELIVERED (not just ruled) before this one can enter the deliverable region. Use when the prerequisite must actually produce data first.'),
      executorKind: z.enum(['command', 'inproc', 'agent', 'map', 'primitive', 'goal']).optional().describe("task: executor kind — command | inproc (single model call) | agent (tools, writes files) | goal (converge via detached solve, D-G1). 'map' / 'primitive' are rejected for task tickets (no spec at compile time, 2026-09-11). prototype always converges via solve (#135) — non-goal values are inert for it."),
    },
    handler: async ({ title, type, slug, id, blockedBy, blockedByDelivery, executorKind }) => {
      // 防御缺省 (schema default 只在 SDK 层生效; 直调 handler 也要稳)。
      const ttype = ((type as string | undefined) ?? 'task') as TicketType;
      const bb = (blockedBy as string[] | undefined) ?? [];
      const bbd = (blockedByDelivery as string[] | undefined) ?? [];
      const { cwd } = deps;
      const backend = backendOf(deps);
      const r = resolveSlug(backend, cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      // 缺 executorKind 拒绝闸 (与 slice-compiler 同源契约的装配期版): task/prototype 票进 compileSlice
      // 反向自检: 摘掉本闸 → task 票不带 executorKind 一路溜到 deliverSlice, 在 slice-compiler 里炸
      if ((ttype === 'task' || ttype === 'prototype') && executorKind === undefined) {
        return err(
          `task/prototype 票缺 executorKind — 默认会被编成无工具 leaf (单发模型调用, 写不了文件), 跑完却把票翻 delivered; 修复: 显式给 executorKind`,
        );
      }
      // 2026-09-11: map / primitive 票 slice 编译期必抛 (票不携带 MapSpec / primitive 参数, 见 slice-compiler
      // toPlanExecutor), 装配期就拒 —— 晚到交付期才炸等于让人白排一张票。反向自检: 摘掉本闸 → map_add 收下
      // executorKind='map' 的票, deliver 时在 slice-compiler 抛 (pathfinder-executor-kind.test.ts)。
      if (ttype === 'task' && (executorKind === 'map' || executorKind === 'primitive')) {
        return err(
          `executorKind='${executorKind}' 票不能进 slice 图: 票在编译期不携带 MapSpec / primitive 参数, 会在交付时炸 — 改用 agent (带工具改文件) 或 command (确定性命令)`,
        );
      }
      let created: Ticket;
      try {
        created = backend.addTicket(cwd, r.slug, {
          type: ttype,
          title: title as string,
          blockedBy: bb,
          ...(bbd.length ? { blockedByDelivery: bbd } : {}),
          ...(id ? { id: id as string } : {}),
          ...(executorKind ? { executorKind: executorKind as Ticket['executorKind'] } : {}),
        });
      } catch (e) {
        return err(errMsg(e));
      }
      // #135: prototype 恒走 goal 档 (isGoalKind 按 type 判) —— 非 goal 的 executorKind 在它身上
      // 是死旋钮, 死旋钮必须出声 (「配了但不生效」是本仓最难查的一种)。响亮提示, 不拒建票。
      const deadKnob =
        ttype === 'prototype' && executorKind !== undefined && executorKind !== 'goal'
          ? `\n⚠ prototype 恒走 goal 档 (detached solve, #135) — executorKind='${executorKind}' 不生效, 可去掉。`
          : '';
      const map = backend.readMap(cwd, r.slug);
      return ok(`✓ 已加票 ${created.id}${deadKnob}${map ? `\n${renderStatus(map, deps.hudMirror)}` : ''}`);
    },
  };
}

// ── path_tickets ─────────────────────────────────────────────────────────────

function makeTickets(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_tickets',
    description: 'Show a pathfinder map frontier; first folds in landed AFK results (pull reflow + budgeted self-expansion).',
    inputSchema: {
      slug: z.string().optional().describe('Map slug (omit = the single open map)'),
    },
    handler: async ({ slug }) => {
      const backend = backendOf(deps);
      const r = resolveSlug(backend, deps.cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      const reflow = reflowOnce(deps, backend, r.slug);
      // D-5/G-5 (切片 6 接线): 等人超时扫一遍 —— 挂在**读路径**上是因为 MCP server 无常驻
      // watcher (同 reflowOnce 的 pull 模型): 没人来看的图不需要催, 来看的时候必须是最新的。
      // 后端缺 sweepWaiting (gh) = 该后端没有超时升级, 不是"扫了没超时"。
      const stale = backend.sweepWaiting?.(deps.cwd, r.slug, { now: new Date().toISOString() }) ?? [];
      const staleLines = stale.map(
        (e) => `⏳ 等人超时: ${e.ticketId} 已等 ${Math.floor(e.waitedMs / 3_600_000)}h (自 ${e.waitingSince}) — 已标 stale, 台账留痕。`,
      );
      const map = backend.readMap(deps.cwd, r.slug)!;
      return ok([...reflow, ...staleLines, renderStatus(map, deps.hudMirror)].join('\n'));
    },
  };
}

// ── path_rule ────────────────────────────────────────────────────────────────

function makeRule(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_rule',
    description: 'Rule a frontier ticket (record the decision). Region-clear is only reported; execution stays behind path_deliver.',
    inputSchema: {
      ticketId: z.string().describe('Frontier ticket id to rule'),
      ruling: z.string().describe('The decision text (becomes the slice node goal for task tickets)'),
      slug: z.string().optional().describe('Map slug (omit = the single open map)'),
      disposition: z
        .enum(['execute', 'close'])
        .optional()
        .describe(
          "终结语义 (#161): 'execute' (默认, 与既有行为逐字节一致) = 裁后进区域; 'close' = 裁决即终结 (rule + markDelivered 复合路), 不进区域不执行。",
        ),
    },
    handler: async ({ ticketId, ruling, slug, disposition }) => {
      const backend = backendOf(deps);
      const r = resolveSlug(backend, deps.cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      const reflow = reflowOnce(deps, backend, r.slug); // 先折回流, 避免在过期视图上裁
      // INV-BOX-1: 守卫抽到 `ticket-guard.ts` —— MCP / TUI 共用一份 `canRule`, 同一根尺。
      // 经此改写, 裸 `177` 与 `#177` 同解, suggested 守卫也按归一后的 id 走读路, 漂封堵。
      const pre = backend.readMap(deps.cwd, r.slug);
      const guard = canRule(pre, ticketId as string);
      if (!guard.ok) return err(guard.reason);
      ticketId = guard.id;
      // D-1 (切片 1 #161): close 路 = rule 带前缀锚 + markDelivered (复用 delivered 终态;
      // 不加新 TicketStatus, 视图需求不污染真源 types.ts:75 的备注)。md / gh 两后端同步生效
      // (backend.ts:102/112 必备)。
      const mode = (disposition ?? 'execute') as 'execute' | 'close';
      const rulingText = mode === 'close' ? `[closed-by-ruling] ${ruling as string}` : (ruling as string);
      try {
        backend.rule(deps.cwd, r.slug, ticketId as string, rulingText);
      } catch (e) {
        return err(errMsg(e));
      }
      if (mode === 'close') {
        try {
          backend.markDelivered(deps.cwd, r.slug, [ticketId as string]);
        } catch (e) {
          // 部分失败缝 (收编时补): rule 已成、终态没落 —— 票此刻是「带锚的 ruled」, 仍会进区域。
          // 两步都幂等, 补救 = 原样重跑同一条命令; 不写这句, 读错误的人不知道盘上停在半路。
          return err(`${errMsg(e)} — ruling 已写入 (带 [closed-by-ruling] 锚) 但终态未落, 票仍是 ruled 会进区域; 原样重跑本命令即可补上终态`);
        }
      }
      const map = backend.readMap(deps.cwd, r.slug)!;
      const memNote = await rememberRuling(deps, map, ticketId as string, rulingText);
      // D-5 (切片 1 #161): 裁与终结在回话里必须可分辨 (同 N5「一次正确的 BLOCKED 被念成 failed」
      // 那条纪律)。close 路显式念「已终结 (closed-by-ruling)」, 不会与「✓ 已裁」串味。
      const ack =
        mode === 'close'
          ? `✓ 已终结 (closed-by-ruling) ${ticketId}: ${(ruling as string).slice(0, 60)}`
          : `✓ 已裁 ${ticketId}: ${(ruling as string).slice(0, 60)}`;
      return ok(
        [
          ...reflow,
          ack,
          ...(memNote ? [memNote] : []),
          renderStatus(map, deps.hudMirror),
        ].join('\n'),
      );
    },
  };
}

// ── map_confirm (S-1 片b) ────────────────────────────────────────────────────

function makeConfirm(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    // 新工具直接用新词表名 (t7 后出生, 无旧名无 alias)。
    name: 'map_confirm',
    description: 'Confirm a machine-suggested ticket: accept (optional retitle) into frontier, or reject. Logged for acceptance rate.',
    inputSchema: {
      ticketId: z.string().describe('Suggested ticket id to confirm'),
      action: z.enum(['accept', 'reject']).describe('accept → open (frontier lifecycle); reject → removed, logged'),
      title: z.string().optional().describe('accept only: replace title (logged as edited)'),
      slug: z.string().optional().describe('Map slug (omit = the single open map)'),
    },
    handler: async ({ ticketId, action, title, slug }) => {
      const backend = backendOf(deps);
      const r = resolveSlug(backend, deps.cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      if (!backend.confirmSuggestion) return err(`后端 ${backend.kind} 未实装 confirmSuggestion (S-1 片e) — md 后端可用`);
      // INV-BOX-1: 同 path_rule, 守卫共享一份 `canConfirm` (suggested 是它的合法目标, 不挡)。
      const confirm = canConfirm(backend.readMap(deps.cwd, r.slug), ticketId as string);
      if (!confirm.ok) return err(confirm.reason);
      ticketId = confirm.id;
      try {
        const entry = backend.confirmSuggestion(deps.cwd, r.slug, ticketId as string, action as 'accept' | 'reject', {
          at: new Date().toISOString(),
          ...(title !== undefined ? { title: title as string } : {}),
        });
        const map = backend.readMap(deps.cwd, r.slug)!;
        return ok([`✓ 建议 ${ticketId} → ${entry.outcome}`, renderStatus(map, deps.hudMirror)].join('\n'));
      } catch (e) {
        return err(errMsg(e));
      }
    },
  };
}

// ── path_deliver ─────────────────────────────────────────────────────────────

function makeDeliver(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_deliver',
    description: 'Execute the clear region: compile ruled task tickets to a slice, run the DAG, mark delivered on full success.',
    inputSchema: {
      slug: z.string().optional().describe('Map slug (omit = the single open map)'),
    },
    handler: async ({ slug }) => {
      const { cwd, models } = deps;
      const exec = deps.executeSlice ?? realExecuteSlice;
      const backend = backendOf(deps);
      const r = resolveSlug(backend, cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      const map = backend.readMap(cwd, r.slug)!;
      const region = readyRegion(map);
      if (!region) return err('无可交付区域: 没有已散尽的 ruled task 票 (先 path_rule 把前沿裁完)。');
      // D-G1.2: goal 档票逐张 fire detached solve (幂等: .goal-dispatched 标记), 票留 ruled 在飞;
      // 结果经 afk-hook 回流三态映射 (c2 波)。slice 票照旧编 DAG。
      const goalLines: string[] = [];
      if (region.goals.length > 0) {
        const fireGoal = deps.dispatchGoal ?? realDispatchGoalTicket;
        for (const gid of region.goals) {
          const gt = map.tickets.find((t) => t.id === gid)!;
          const goalText = gt.ruling ?? gt.title;
          try {
            // D-3/G-4 (切片 6): 派发口收**票**不收 id —— 裁决票在这里当场 throw (装配期拒),
            // 落进下面的 catch 成一行 `✗ fire 失败`, 不掀掉同批其它票 (整批炸 = 把闸做成故障)。
            const d = fireGoal(cwd, r.slug, assertDispatchable(gt), goalText);
            goalLines.push(`◈ goal 票 ${gid} → solve ${d.already ? '已在飞' : '已 fire'} (runId ${d.runId})`);
            // ⚠ **prototype 票的隔离今天没生效** (2026-08-06 查实的三环):
            //   ① D-13 给 prototype 设计的隔离 worktree 住在 `pathfinder/dispatch.ts` 的
            //      `case 'prototype'` 里, 而它**没有生产调用者** —— `dispatchFrontier` 只自动派
            //      research 票, 注释说 prototype "仅 reported 给 UI 由人显式触发", 而那个触发口
            //      **从来没建过** (盘上 `.omd/pathfinder/proto/` 一个目录都没有);
            //   ② prototype 票实际走的是这条路 (readyRegion → 这里 → detached solve);
            //   ③ 这条路**不传 branchStrategy** → 缺省 `head` → **直接写主树**。
            //   于是"沙盒 spike, 试验码不污主树"这句话在生产上是反的。**先让它看得见**:
            //   要不要改成隔离是单独的决定 (隔离树看不见未提交的活, 见 run-worktree 那条),
            //   不是一行 default 的事。
            if (gt.type === 'prototype') {
              goalLines.push(
                `   ⚠ 这是 **prototype (沙盒 spike) 票**, 而它正在**直接写主树** —— D-13 说的隔离 worktree ` +
                  '在这条路上没有生效 (那段代码没有生产调用者)。跑坏了能不能回滚, 见读数板 ⑬ 段: ' +
                  '起跑时工作树干净才有完整回滚对象。',
              );
            }
          } catch (e) {
            goalLines.push(`✗ goal 票 ${gid} fire 失败: ${errMsg(e)}`);
          }
        }
      }
      if (region.slice.length === 0) {
        // 纯 goal 区域: 没有 slice 可执行, 汇报 fire 结果即完成 (票留 ruled 等回流)。
        if (goalLines.length === 0) return err('区域为空 (不该发生: readyRegion 非 null 但两侧都空)。');
        return ok([...goalLines, renderStatus(backend.readMap(cwd, r.slug)!, deps.hudMirror)].join('\n'));
      }
      // D-3/G-4 (切片 6): **第二条派发路径**的装配期闸 —— compileSlice→executeSlice 这条同样
      // 会把票交给执行体, 而 readyRegion 只看 type+status **不看类**: 一张标了
      // `ticketClass:'ruling'` 的 ruled task 票照样进区域。这里编译**之前**拒, 整批不跑
      // (与 goal 档那条逐张报不同: slice 是一张图, 里面混进一张裁决票就该整张不发)。
      const sliceTickets = map.tickets.filter((t) => region.slice.includes(t.id));
      for (const t of sliceTickets) {
        try {
          assertDispatchable(t);
        } catch (e) {
          return err(`${errMsg(e)}\n区域未执行 —— 先把这张票从待交付区域里裁出去 (裁决票要的是人裁, 不是编译)。`);
        }
      }
      // deliver spec 护栏 (编译前, fail-loud): 复杂区域缺 docs/plan/ 契约引用 → 不编译不执行 (D-E)。
      const gate = specGateViolation(sliceTickets);
      if (gate) return err(gate);
      if (!models.leafModel) return err('未配 leaf 模型 — 设 OMD_ITER_LEAF_MODEL (或 OMD_RUNTIME_PROVIDER/MODEL) 后再 path_deliver。');
      let plan;
      try {
        plan = compileSlice(map, region.slice);
      } catch (e) {
        return err(`slice 编译失败: ${String(e)}`);
      }
      // D-6③ 派发锚 (control-plane G-2)。此前 runId 只在下面的 opts 里现造、只喂 recorder ——
      // 「这些票 ↔ 这个 run」的事实在那一行产生、当场被扔掉, 于是票从 ruled 直接跳 delivered,
      // 看板上「正在跑 / 跑完待验」两态盘上根本不存在 (控制台 SDD D-3 要的两列没有数据源)。
      // 现在 runId 提到这里生成: 它同时是账本键与票上的锚, **必须是同一个值**, 否则回执查不回来。
      // 形状 = `<slug>-<6hex>` (slug = map.destination 归一) —— 同票派两次不撞, `/runs`/palette 看见名字。
      const runId = mintRunId(map.destination);
      backend.markDispatch?.(cwd, r.slug, region.slice, { open: { runId, startedAt: new Date().toISOString() } });
      let settled = false;
      // 收工回填。放 finally 里跑 —— 异常路径 (编译期外的任何抛错) 若不 settle, 票就会永远停在
      // 「正在跑」。硬杀 (SIGKILL) 仍兜不住, 那个缺口写在 Ticket.dispatch 的注释里, 不假装解决。
      const settle = (outcome: 'passed' | 'failed'): void => {
        if (settled) return;
        settled = true;
        backend.markDispatch?.(cwd, r.slug, region.slice, { settle: { finishedAt: new Date().toISOString(), outcome } });
      };
      try {
        const opts: ExecuteSliceOpts = {
          leafModel: models.leafModel,
          ...(models.agentLeafModel ? { agentLeafModel: models.agentLeafModel } : {}),
          ...(models.conductorModel ? { conductorModel: models.conductorModel } : {}),
          agentRunner: deps.agentRunner,
          commandRunner: deps.commandRunner,
          cwd,
          // 运行留痕 (2026-08-02): 慢回路这条此前完全不进账本。runId 在上面生成 ——
          // pathfinder 没有 RunRegistry (它的身份是**票**不是 run), 但 executeSlice 可能落多条
          // 记录 (iterate 每轮一张图), 不给个共同的 runId 就归不成"这一次交付"的账。
          // entry 词表 (t7, 2026-08-04): 'map_deliver' (旧 'path_deliver' 只在历史行里, 读侧归一合并)。
          ...(deps.recorder ? { recorder: deps.recorder, entry: 'map_deliver', runId } : {}),
        };
        const result = await exec(plan, opts);
        const nodeStates = Object.values(result?.results ?? {});
        const failed = nodeStates.filter((n) => (n as { status?: string }).status !== 'done').length;
        const pass = result?.verification?.pass;
        if (failed > 0 || pass === false) {
          settle('failed');
          return err(`slice "${plan.name}" 执行有 ${failed}/${nodeStates.length} 节点未完成${pass === false ? ' · 校验未过' : ''} — 区域未标记交付, 修复后可再 path_deliver。`);
        }
        settle('passed');
        backend.markDelivered(cwd, r.slug, region.slice);
        return ok([
          ...goalLines,
          `◈ slice "${plan.name}" 已执行 (${Object.keys(plan.nodes ?? {}).length} 节点) — 区域 [${region.slice.join(', ')}] 已交付。`,
          renderStatus(backend.readMap(cwd, r.slug)!, deps.hudMirror),
        ].join('\n'));
      } catch (e) {
        return err(`slice 执行失败: ${String(e)}`);
      } finally {
        // 上面每条正常出口都已 settle 过 (settled 闸保幂等); 这里兜的是抛错那条路。
        settle('failed');
      }
    },
  };
}

// ── path_prefetch ────────────────────────────────────────────────────────────

function makePrefetch(deps: PathfinderToolDeps): OmdMcpTool {
  return {
    name: 'path_prefetch',
    description: 'Dispatch frontier research tickets to detached AFK background (owner-explicit); results fold in via path_tickets.',
    inputSchema: {
      slug: z.string().optional().describe('Map slug (omit = the single open map)'),
    },
    handler: async ({ slug }) => {
      const dispatch = deps.dispatchFrontier ?? realDispatchFrontier;
      const backend = backendOf(deps);
      const r = resolveSlug(backend, deps.cwd, slug as string | undefined);
      if ('error' in r) return err(r.error);
      const map = backend.readMap(deps.cwd, r.slug)!;
      // 派发路径判据接后端 kind: gh 后端 research → 云端 label 触发 (dispatch.ts dispatchResearchGh)。
      const fd = dispatch(map, { cwd: deps.cwd, slug: r.slug, backend: backend.kind }, {});
      const lines = [
        fd.dispatched.length > 0
          ? `⚡ ${fd.dispatched.length} 张 research 票已入 AFK 后台 (detached; path_tickets 拉回流)。`
          : '前沿无 research 票可派。',
      ];
      if (fd.reported.length > 0) {
        lines.push(`人工票 (${fd.reported.length}): ${fd.reported.map((t) => `[${t.type}] ${t.id}`).join(', ')}`);
      }
      return ok(lines.join('\n'));
    },
  };
}
