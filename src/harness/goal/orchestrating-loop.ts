/**
 * src/harness/goal/orchestrating-loop —— solve 的默认执行形态 = **编排循环** (P3 契约 S6b, 2026-09-02;
 * D-1 / D-3 / D-14 / D-17 / D-20 / D-22)。
 *
 * 一句话: conductor (conductor 本人) 作为**一个 agent 节点**主上下文连续到底, 手里握着七张封闭派工卡
 * (`src/harness/conductor/tools/*`); 每张卡 `compile` 出的子图**经引擎入口**当一次嵌套 run 执行
 * (`runExecutorDagWithPlan` → `executePlan(applyPlanFilters(…))`, INV-3: 写竞争串行化 / 命令链合并 /
 * oracle 过滤照走, 闸 / checkpoint / blame 全部照走); 图上另有一个机械 oracle 节点 (`accept`, 冻结判据原文),
 * 收尾由 run-goal 打**恰一次**跨家族 verifier (D-14 / INV-7)。
 *
 * ## 这里只做三件事, 各自单一
 *
 * 1. `compileOrchestratingLoop` —— 出那张两节点的 plan。**不进** `GRAPH_SHAPES` 卡表 (D-1): 卡表是 conductor
 *    画图的菜单, 这条路模型没有选择权; 路径身份记 `RunGoalResult.path`。
 * 2. `createConductorRuntimeTools` —— 把七张卡 (`ConductorTool`, zod + compile) 适配成 agent 叶能调的 `AnyOmdTool`:
 *    zod 拒 / `help:true` / 编译拒 → 拒因 + 该卡完整 manual 走 **tool result** (D-3, manual 永不进 system prompt);
 *    编译过 → `runChild(plan)` 跑子图 → 返回 fan-in 摘要 (节点状态 / 产出尾 / 尾块 / 验收台账)。
 * 3. `buildConductorFace` —— conductor 节点的整副面: 只读手 (read / ls / grep / bash, D-20: 无 write / edit) + 七张卡 +
 *    常驻 conductor prompt (S5, ≤8000)。由 run-goal 经 `ExecutorDagConfig.leafFace` 只对 `conductor` 这一个 id 下发。
 *
 * ## 诚实边界 (与契约措辞的偏离, 记进进度表)
 *
 * - 子单元是**嵌套 run** (同 sessionId, 派生 runId `<runId>:d<n>`), 不是同一 run 内的子图: 引擎今天没有
 *   「在一个 agent 工具调用里执行一批子节点」的内部接缝 (`runConductorRound` 的展开→局部调度是内联的),
 *   拆它超出本片。代价: 父 run 的 checkpoint 不含子节点 (父 conductor 节点自己有 checkpoint; 子 run 各自有);
 *   收益: 子图零新机制, 闸链与 `run`/`solve` 逐字节同一条。
 * - `work(resume_of)` 今天 = **同 id 重派** (fresh context), 不是续同一会话: 引擎没有按节点 id 续 agent 会话的
 *   机制 (全仓 resume 只有 checkpoint 复用)。owner 2026-09-02 裁 2-C: 上一次同 id 子 run 的结果 (状态 / 文件 /
 *   验收台账 / 尾块 / 报告尾) 由**运行时机械 append 进 goal** (`injectPriorResult`), 不指望 conductor 复制进 brief —
 *   丢的只是工具调用历史。真续会话 (pi session / SDK sessionId 按 `${runId}:${nodeId}` 留住) 留作单变量实验。
 *
 * 证伪方式 (orchestrating-loop.test.ts): 删掉 `runChild` 那一跳 → 卡调用不再产生嵌套 run 即红; 把 manual 拼进
 * face.systemPrompt → INV-8 长度闸红; `accept` 节点丢掉 `depends_on: ['conductor']` → 拓扑测试红。
 */
import { Type } from '@sinclair/typebox';
import { z } from 'zod';
import { withProtectedPaths, type AnyOmdTool } from '../agent-tools';
import { join } from 'node:path';
import { hashArtifact } from '../continuity/checkpoint-manager';
import { probeCriterionDirection } from './acceptance-gate';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagResult, LeafResult } from '../dag/types';
import type { LeafFace } from '../leaf-runners';
import { buildConductorSystemPrompt, CONDUCTOR_PROMPT_RESIDENT_MAX, type ConductorFacts } from '../conductor/conductor-prompt';
import { createConductorTools, formatRejection, invokeConductorTool } from '../conductor/tools/index';
import type { ConductorCtx, ConductorTool } from '../conductor/types';
import { logger } from '../logger';
import { checkCoords } from './coord-check';
import { briefHasRepro, computeLoopDispatchFacts, type CriterionFreeze, type ConductorCardLedger, type ConductorCardName } from './loop-ledger';

/** plan 名 —— run-goal 的 `_runDag` 注入口与测试靠它认路径 (与 `goal-execute` / `goal-execute-flat` 同一约定)。 */
// plan 形状真源挪到 conductor/loop-plan.ts (2026-09-04: decompose 卡也要编它, 留在这里是循环 import); 这里原名再导出。
export {
  CONDUCTOR_NODE_ID,
  CONDUCTOR_READONLY_SENTINEL,
  LOOP_ACCEPT_NODE_ID,
  LOOP_MAX_DEPTH,
  ORCHESTRATING_LOOP_PLAN_NAME,
  compileOrchestratingLoop,
  conductorNodeIdOf,
  isOrchestratingLoopPlan,
  loopDepthOf,
  type OrchestratingLoopInput,
} from '../conductor/loop-plan';
import { CONDUCTOR_NODE_ID } from '../conductor/loop-plan';
/** conductor 的只读手 (D-20: 无 write / edit)。bash 的边界 = 危险命令闸 + git 写闸 + 收尾写集对账, 不是首词白名单 (D-7)。 */
export const CONDUCTOR_HAND_TOOLS = ['read', 'ls', 'grep', 'bash'] as const;

/**
 * conductor 节点**基建类**败因 (2026-09-03, code80-p3 首批 09:22 停批的根因形态): MiniMax 529 → conductor 首发即 failed →
 * 终审对着空产物判红 → D-14 回灌 → 再 529 → `verifier-rejected`。基建失败不许被标成语义否决:
 * 这一集里的败因既不回灌 (再派只是再撞一次 529), 终态也走 infra-error 那一格 (下一步 = 修引擎/换池, 别加轮数)。
 * 不含 empty-artifact / assert-failed 等**语义类**败因 —— 那些正是回灌该处理的。
 */
export const CONDUCTOR_INFRA_FAILURE_KINDS: ReadonlySet<string> = new Set(['infra-error', 'timed-out', 'missing-capability', 'stall', 'spin-fused']);

/** 回灌锚的固定首行 —— 测试与人读日志都靠它认「这一发是回灌」。 */
export const REINJECT_ANCHOR_HEAD = '[verifier 打回 · 回灌 1 次 (D-14: 回灌后由机械 oracle + 一次窄复审定终态)]';

/**
 * 窄复审卷面首行 —— 与 `REINJECT_ANCHOR_HEAD` 同款:测试与人读日志靠它认「这一发是复审」。
 */
export const RECHECK_TASK_HEAD = '[D-14 窄复审 · 第二跑 · 只判首判 finding 修没修]';

/**
 * 「放行但没能确认」的固定前缀 (2026-09-04)。判官拿不出反证时按此起头写 reason,
 * run-goal 据此把读数记成 `'unproven'` —— 与干净 pass 分两格记账, 终态同样放行。
 * 常量而非散文正则: 卷面与解析共用这一个字面, 改一处两处跟着变。
 */
export const RECHECK_UNPROVEN_PREFIX = 'UNPROVEN:';

/**
 * D-14 窄复审的卷面 (2026-09-04, owner 裁「补第二跑的复审」)。
 *
 * ## 为什么需要它
 *
 * 原 D-14 是「终审判红 → finding 回灌 → 重跑 → **终态由机械 oracle 定**」。回灌后 oracle 绿即 success,
 * 语义层没有第二只眼。而仓规 §静默坑 3 点名的正是这一格:oracle 绿 ≠ 语义对,测试与实装由同一次改动
 * 一起产出时会一起错并互相背书。实测代价 = owner 每条 run 手工逐条读 diff 补这一格。
 *
 * ## 为什么是「窄」的
 *
 * 复审**不重开一次全量终审**:全量审会找出与首判 finding 无关的新问题,而那些问题在第一次终审时
 * 就有机会被提出却没有 —— 允许它们在第二跑翻案等于把「至多回灌一次」变成无限轮。所以卷面把职责
 * 收死成一个是非题:**首判那条 finding,修了没有**。找到新问题只记进 reason 供人读,不构成否决。
 *
 * ## 保守方向
 *
 * ## 找反证,不找正证(2026-09-04 回流,code80-p5 读数)
 *
 * 初版写的是「拿不准 → 判 fail」(与 VER-1 同向)。实测 8 条 fail 里 **3 条 reward ≥ 0.6**,
 * 最扎的一条 bench 测试 **4/4 全过**而复审判「四条要修项没有一条能被证据确认已修」——
 * 纯粹是"看不到",不是"看到了没修"。
 *
 * 根因不是判官太严,是**卷面把职责摆反了**:窄复审跑在**机械 oracle 已经绿之后**,
 * 这一格已经有一条独立证据在场。要求它正面证明"修好了"、否则否决,等于让 oracle 那条证据不算数
 * —— VER-1 的「拿不准判 fail」适用于第一次全量终审(那时没有任何东西证明活干成了),
 * 不适用于这里。
 *
 * 现行职责:**oracle 绿是 prior,复审要推翻它得拿出反证。**
 *  · 能指出具体反证(引擎记录显示没落盘 / 改了但机制是错的 / 只修一半且能点名哪半)→ `fail`,否决。
 *  · 拿不出反证,只是"看不到证据支持"→ `pass`,但 reason 必须以 `UNPROVEN:` 起头。
 *    run-goal 据此把读数记成 `'unproven'` 而不是 `'pass'`——**终态按放行走,读数分得开**。
 *    这样不动 `VerifierVerdict` 的 pass/fail 冻结二值面,也不把两种放行并成一格(§静默坑 1)。
 *
 * ⚠ 校准锚: code80-p5 里 5 条 reward ≤ 0.25 的真阳性,判词全是**反证**型
 * (「第二跑连一行编辑都没落盘, git diff --stat 为证」「只修一半且被修的那半机制是错的」),
 * 改成反证要求之后它们仍然红 —— 这是本次改动**不该**动到的那一半。
 */
export function renderRecheckTask(originalTask: string, firstFinding: string): string {
  return [
    RECHECK_TASK_HEAD,
    '',
    'A cross-model verifier rejected the first attempt. The finding below was injected back into the',
    'conductor, which then ran a second time. You are judging ONLY whether that finding is now fixed.',
    '',
    'Rules for this pass:',
    '- The question is a yes/no about the finding below. Do NOT open new lines of attack.',
    '- New problems you notice that are unrelated to the finding: mention them in `reason`, but they',
    '  do NOT make this pass fail. They are for the owner to read, not for you to veto on.',
    '- A mechanical oracle already passed on this tree. Treat that as the prior. It is weak evidence',
    '  (tests and implementation written in the same change fail together and vouch for each other),',
    '  but it IS evidence. Your job is to OVERTURN it, which takes counter-evidence — not to re-prove it.',
    '- Answer fail ONLY if you can point at concrete counter-evidence: engine records showing nothing',
    '  was written, a change that is there but whose mechanism is wrong, a fix that covers one half of',
    '  the finding and demonstrably not the other. Name it in `reason`.',
    '- If you simply cannot see evidence either way, that is NOT a fail. Answer pass and start `reason`',
    '  with the exact token `UNPROVEN:` followed by what you were unable to confirm. It is recorded',
    '  separately from a clean pass, and the owner reads it.',
    '',
    '--- first verdict (the finding under review) ---',
    firstFinding,
    '--- end of finding ---',
    '',
    '--- original task (context only; not the thing being judged this pass) ---',
    originalTask,
  ].join('\n');
}

/**
 * D-14 回灌: verifier finding 原文 append 到 **同一 conductor 节点 id** 的 goal 末尾, 其它节点逐字不动。
 * 用新对象替换 (不原地改): 与 engine.ts 的 blameAnchor 同一条纪律 —— 原地写会污染上一轮 plan 的引用。
 */
export function withReinjectedFinding(plan: ConductorPlan, finding: string): ConductorPlan {
  const conductor = plan.nodes[CONDUCTOR_NODE_ID];
  if (!conductor) return plan;
  return {
    ...plan,
    nodes: {
      ...plan.nodes,
      [CONDUCTOR_NODE_ID]: { ...conductor, goal: `${conductor.goal ?? ''}\n\n---\n${REINJECT_ANCHOR_HEAD}\n${finding}\n` },
    },
  } as ConductorPlan;
}

/** 子图节点 id 加派发前缀 (`d3.explore-1`): 同一 run 里两次 explore 都出 `explore-1`, 不加前缀事件面与 checkpoint 会撞。 */
export function prefixPlanIds(plan: ConductorPlan, prefix: string): ConductorPlan {
  const rename = (id: string): string => (/^d\d+\./.test(id) ? id : `${prefix}.${id}`);
  const nodes: ConductorPlan['nodes'] = {};
  for (const [id, n] of Object.entries(plan.nodes)) {
    nodes[rename(id)] = {
      ...n,
      ...(n.depends_on ? { depends_on: n.depends_on.map(rename) } : {}),
    };
  }
  return { ...plan, nodes } as ConductorPlan;
}

const OUTPUT_TAIL_CHARS = 1500;

function tail(text: string, n: number): string {
  return text.length > n ? `…${text.slice(-n)}` : text;
}

function describeAcceptance(a: LeafResult['acceptance']): string {
  if (a === undefined) return '';
  if (a === null) return ' · acceptance: 派了判据但叶子没报 (通道截断)';
  if (!a.ran) return ' · acceptance: 派了判据, 叶子没跑 run_acceptance';
  const last = a.last;
  const verdict = last
    ? last.kind === 'blocked'
      ? `blocked (${last.reason.slice(0, 80)})`
      : `${last.verdict} exit ${last.exitCode ?? 'null'}${last.why ? ` (${last.why.slice(0, 80)})` : ''}`
    : '(无最后一次记录)';
  return ` · acceptance: 跑了 ${a.rounds} 轮, 最后 ${verdict}`;
}

function describeTrailer(r: LeafResult): string {
  const t = r.selfReport;
  if (t === undefined) return '';
  if (t === null) return '\n  trailer: 解析失败 (原文见节点记录)';
  const lines = [
    `\n  trailer (${t.self_report}): changed=[${t.changed.join(', ')}] acceptance_ran=${t.acceptance_ran}` +
      `${t.acceptance_exit !== null ? ` exit=${t.acceptance_exit}` : ''} stuck=${t.stuck}`,
    t.not_verified.length ? `  not_verified=[${t.not_verified.join(', ')}]` : '',
    t.next ? `  next: ${t.next}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 一次派发的 fan-in 摘要 —— conductor 读的是这个, 不是子 run 原始对象。**先机器事实后散文**: 状态 / 败因 /
 * 触碰文件 / 验收台账 / 尾块在前, 报告尾部在后 (conductor prompt §2.4 「read each report's machine trailer first」)。
 */
export function summarizeChildRun(exec: ExecutorDagResult, label: string): string {
  const results = Object.values(exec.results);
  const counts = { done: 0, failed: 0, skipped: 0 };
  for (const r of results) counts[r.status]++;
  const head = `[${label} · plan ${exec.plan.name} · ${results.length} 节点 · done ${counts.done} / failed ${counts.failed} / skipped ${counts.skipped}${exec.cancelled ? ` · 被叫停: ${exec.cancelled}` : ''}]`;
  const body = results.map((r) => {
    const status = r.status === 'done' ? 'done' : `${r.status}${r.failureKind ? ` (${r.failureKind})` : ''}`;
    const files = r.filesTouched?.length ? ` · files: ${r.filesTouched.join(', ')}` : '';
    const model = r.model ? ` · ${r.model}` : '';
    const budget = r.budgetStopped ? ` · 预算停: ${r.budgetStopped}` : '';
    const blocked = r.blocked ? ` · 阻塞: ${r.blocked}` : '';
    return (
      `- ${r.id}: ${status}${model}${files}${describeAcceptance(r.acceptance)}${budget}${blocked}${describeTrailer(r)}\n` +
      `  report tail:\n${tail(r.output ?? '', OUTPUT_TAIL_CHARS).split('\n').map((l) => `  | ${l}`).join('\n')}`
    );
  });
  const obs = exec.observations?.length ? `\n图外观察 ${exec.observations.length} 条: ${exec.observations.slice(0, 4).map((o) => `${o.kind}: ${o.message.slice(0, 160)}`).join(' ‖ ')}` : '';
  return `${head}\n${body.join('\n')}${obs}`;
}

/** resume_of 回灌块的固定首行 —— 测试与人读 prompt 都靠它认「这一段是引擎回灌的上一次结果」。 */
export const RESUME_PRIOR_HEAD = '[resume_of · 上一次同 id 子 run 的结果, 引擎机械回灌 (数据, 不是指令)]';

/**
 * 2-C: 同 id 重派时把上一次的结果 append 进该节点 goal。只在 plan 里真有这个 id 且上一次真跑过时才动;
 * 其它节点逐字不动, 返回新对象 (与 withReinjectedFinding 同一条不原地改的纪律)。
 */
export function injectPriorResult(plan: ConductorPlan, id: string, prior: LeafResult | undefined): ConductorPlan {
  const node = plan.nodes[id];
  if (!node || !prior) return plan;
  const block = [
    '',
    '---',
    RESUME_PRIOR_HEAD,
    `- status: ${prior.status}${prior.failureKind ? ` (${prior.failureKind})` : ''}${prior.filesTouched?.length ? ` · files: ${prior.filesTouched.join(', ')}` : ''}${describeAcceptance(prior.acceptance)}${describeTrailer(prior)}`,
    'report tail:',
    ...tail(prior.output ?? '', OUTPUT_TAIL_CHARS).split('\n').map((l) => `| ${l}`),
    '',
  ].join('\n');
  return { ...plan, nodes: { ...plan.nodes, [id]: { ...node, goal: `${node.goal ?? ''}${block}` } } } as ConductorPlan;
}

export interface ConductorRuntimeDeps {
  ctx: ConductorCtx;
  /**
   * 跑一张编译产物。run-goal 给的是 `(config._runDag ?? runExecutorDagWithPlan)(plan, childCfg)` —— 唯一执行
   * 入口 (D-5); 第二个参数是派发序号 (从 1 起), 调用方据它派生子 runId / 前缀。
   */
  runChild: (plan: ConductorPlan, seq: number) => Promise<ExecutorDagResult>;
  /** R-1 账本 (可变计数器, run-goal 造一个, 回灌第二跑沿用同一个)。缺席 = 不记 (测试 / 非 run-goal 调用方)。 */
  ledger?: ConductorCardLedger;
  /**
   * 1-A (2026-09-03) 判据先落盘冻结: `files` = 判据命令引用、run 开始时不存在的文件 (相对 `root`)。
   * 非空 → 第一个派成的派发必须是一张 work() 且写集被强制为这些文件; 派发回来引擎记 hash 进 ledger.criterionFreeze,
   * 之后每次派发的子 run 都在 withProtectedPaths(已冻住的文件) 里跑 (工具写当场拒)。缺席 / 空 = 不适用, 行为逐字节同旧。
   */
  criterionFreeze?: { files: readonly string[]; root: string };
  /** 路径禁令的注入口 (测试用 spy); 缺省 = agent-tools 的 withProtectedPaths。 */
  withProtected?: typeof withProtectedPaths;
}

function toTypebox(schema: z.ZodType): ReturnType<typeof Type.Unsafe> {
  // zod 4 自带 JSON Schema 导出; TypeBox 只要一个结构上合法的 JSON Schema 对象 (Unsafe = 不重新校验)。
  return Type.Unsafe(z.toJSONSchema(schema, { target: 'draft-7' }));
}

/**
 * 七张卡 → agent 叶工具。`executionMode: 'sequential'`: 一次派发就是一次子 run, 并发由卡内的图宽与
 * 进程级 cap 管 (S8), 不由 conductor 同时按两张卡。
 */
/** 1-A 冻结的运行期状态 (每副工具面一份; 回灌第二跑从 ledger 里已有的 hashes 恢复)。 */
interface FreezeState {
  files: string[];
  root: string;
  /** 已冻住 (≥1 个文件在派发后存在)。冻住之前每次派发都强制写集; 冻住之后每次派发都走路径禁令。 */
  frozen: boolean;
  protectedFiles: string[];
}

function initFreezeState(deps: ConductorRuntimeDeps): FreezeState | undefined {
  const prior = deps.ledger?.criterionFreeze;
  const files = deps.criterionFreeze?.files.length ? [...deps.criterionFreeze.files] : prior?.files ?? [];
  if (files.length === 0) return undefined;
  const root = deps.criterionFreeze?.root ?? deps.ctx.writeRoot;
  const protectedFiles = prior?.hashes ? Object.entries(prior.hashes).filter(([, h]) => h !== null).map(([f]) => f) : [];
  if (deps.ledger && !deps.ledger.criterionFreeze) deps.ledger.criterionFreeze = { files: [...files] };
  return { files, root, frozen: protectedFiles.length > 0, protectedFiles };
}

/** 收尾 / 判卷时刻重算: 冻结时存在的文件里, 现在 hash 不同或缺席的 (有人绕过闸改了它)。没冻过 → []。 */
export function checkCriterionFreeze(freeze: CriterionFreeze, root: string): string[] {
  if (!freeze.hashes) return [];
  return Object.entries(freeze.hashes)
    .filter(([f, h]) => h !== null && hashArtifact(join(root, f)) !== h)
    .map(([f]) => f);
}

/** 给 verifier 的判卷真值一行 (D-5 注入面): 没冻过 → null (不编)。hash 是**判卷时刻**重算后对照冻结值的结论。 */
export function renderCriterionFreezeTruth(freeze: CriterionFreeze, root: string): string | null {
  if (freeze.frozenAtDispatch === undefined || !freeze.hashes) return null;
  const tampered = checkCriterionFreeze(freeze, root);
  const parts = Object.entries(freeze.hashes).map(([f, h]) =>
    h === null ? `${f} (派发后仍不存在)` : `${f} (${h}, 判卷时${tampered.includes(f) ? '已变' : '未变'})`,
  );
  return `派发 #${freeze.frozenAtDispatch} 单独产出并冻结: ${parts.join(' · ')}`;
}

export function createConductorRuntimeTools(deps: ConductorRuntimeDeps): AnyOmdTool[] {
  const cards = createConductorTools(deps.ctx);
  let seq = 0;
  /** 2-C: 本 run 里每个子节点最后一次的结果 (键 = 带前缀的节点 id), resume_of 回灌的来源。 */
  const priorById = new Map<string, LeafResult>();
  const freeze = initFreezeState(deps);
  return cards.map((card) => adaptCard(card, deps, () => ++seq, priorById, freeze));
}

function adaptCard(card: ConductorTool, deps: ConductorRuntimeDeps, nextSeq: () => number, priorById: Map<string, LeafResult>, freeze?: FreezeState): AnyOmdTool {
  return {
    name: card.name,
    label: card.name,
    description: card.short,
    promptSnippet: `${card.name}(…) — ${card.short}`,
    parameters: toTypebox(card.schema),
    executionMode: 'sequential',
    async execute(_id: string, params: unknown) {
      const ledger = deps.ledger;
      if (ledger) ledger.calls++;
      const isHelp = !!params && typeof params === 'object' && (params as { help?: unknown }).help === true;
      const compiled = invokeConductorTool(card, params, deps.ctx);
      if (!compiled.ok) {
        // R-1: 三种拒分开数 —— help 是 conductor 主动要 manual, 不是"没直达"; zod 拒与编译拒的修法不同 (读 manual vs 换形状)。
        if (ledger) {
          if (isHelp) ledger.help++;
          else if (card.schema.safeParse(params).success) ledger.rejectedCompile++;
          else ledger.rejectedSchema++;
        }
        // D-3: 拒因 + 完整 manual 只在这里出现 (tool result), 常驻 prompt 永远不含它。
        return { content: [{ type: 'text', text: formatRejection(compiled) }], details: { ok: false, card: card.name } };
      }
      // #241 坐标机械校验 (2026-09-04): conductor 写的派工文本也要过 —— 这是三个坐标缺口里最后一个。
      //
      // 前两个 (`solve` 的 goal / `run` 的 task) 拒在点火期, 那时只有人能改。**这一处不同**:
      // 拒因走 tool result 回给 conductor, 它当场自己改坐标再派一次 —— 不需要人介入, 也不需要
      // force 出口。这正是「拒了不许重试, 换一条合法的」那条纪律该有的形状。
      //
      // 判定与另外两处同一份实现 (`checkCoords` 白名单三形状)。误报代价 = conductor 多花一轮,
      // 而它有两条文本内出口 (同句「新建」/ 同行 `gate-allow(coord-check): <理由>`), 判词里写明。
      // 漏报代价 = 编造的符号照抄进 `rg -e ...`, 首败带塌整条链 (实账 run 0f67293b)。
      //
      // 反向自检: `orchestrating-loop-coord.test.ts` —— 把本块删掉, 那些 test 当场由绿转红。
      {
        const coordFindings = Object.entries(compiled.plan.nodes).flatMap(([id, node]) => {
          const goalText = (node as { goal?: unknown }).goal;
          return typeof goalText === 'string'
            ? checkCoords(goalText, { root: deps.ctx.cwd }).map((f) => `[${id}] ${f.message}`)
            : [];
        });
        if (coordFindings.length > 0) {
          if (ledger) ledger.rejectedCompile++;
          const text =
            `[#241 坐标机械校验] 你派的图里有 ${coordFindings.length} 处坐标与仓不符, 已拒 —— ` +
            `编造的符号/路径会被执行体照抄进命令, 无匹配即首败, 下游整条链 skipped (实账 run 0f67293b)。\n` +
            coordFindings.map((m) => `- ${m}`).join('\n') +
            `\n改正坐标后重派。确属**新建**物时在同一句里写明「新建」二字; ` +
            `确认是闸看错了 (例如在讲某个符号**不**出现在某文件里), 就在同一行写 \`gate-allow(coord-check): <理由>\`。`;
          return { content: [{ type: 'text', text }], details: { ok: false, card: card.name, coordRejected: coordFindings.length } };
        }
      }
      // 1-A: 冻住之前, 第一个派成的派发必须是一张 work() 单独产出判据文件 —— 写集被强制为这些文件 (闸, 不是提示)。
      let compiledPlan = compiled.plan;
      if (freeze && !freeze.frozen) {
        const ids = Object.keys(compiledPlan.nodes);
        if (card.name !== 'work' || ids.length !== 1) {
          if (ledger) ledger.rejectedCompile++;
          const text =
            `[1-A 判据先落盘] 判据引用的文件还不存在: ${freeze.files.join(', ')}。第一个派发必须是**一张 work()** 单独把它们写出来 ` +
            `(写集 = 这些文件), 引擎随后冻结它们; 你派的是 ${card.name} × ${ids.length} 节点, 已拒。先派 work() 写判据文件, 再派实装。`;
          return { content: [{ type: 'text', text }], details: { ok: false, card: card.name, criterionFreeze: 'first-dispatch-rejected' } };
        }
        const only = ids[0]!;
        compiledPlan = { ...compiledPlan, nodes: { [only]: { ...compiledPlan.nodes[only]!, write_set: [...freeze.files] } } } as ConductorPlan;
      }
      const n = nextSeq();
      const label = `dispatch d${n} (${card.name})`;
      let plan = prefixPlanIds(compiledPlan, `d${n}`);
      // 2-C: work(resume_of) —— 同 id 重派, 上一次的结果由引擎机械回灌进 goal (不靠 conductor 复制)。
      const resumeOf = card.name === 'work' && params && typeof params === 'object' ? (params as { resume_of?: unknown }).resume_of : undefined;
      if (typeof resumeOf === 'string') {
        const prior = priorById.get(resumeOf);
        if (prior) plan = injectPriorResult(plan, resumeOf, prior);
        else logger.warn({ resumeOf }, '[orchestrating-loop] resume_of 指向的 id 本 run 没跑过 → 不回灌 (fresh 派发, 留证)');
      }
      logger.info({ card: card.name, seq: n, plan: plan.name, nodes: Object.keys(plan.nodes).length }, '[orchestrating-loop] conductor 派发 → 嵌套 run');
      // R-1 派发台账: brief 有没有粘运行输出 (启发式, 只对有 brief 槽的卡判)。
      const briefRaw = params && typeof params === 'object' ? (params as { brief?: unknown }).brief : undefined;
      const dispatch = {
        seq: n,
        card: card.name as ConductorCardName,
        nodes: Object.keys(plan.nodes).length,
        briefHasRepro: typeof briefRaw === 'string' ? briefHasRepro(briefRaw) : null,
        ...(typeof resumeOf === 'string' ? { resumeOf } : {}),
      };
      let exec: ExecutorDagResult;
      // 1-A: 冻住之后, 子 run 在路径禁令里跑 —— 工具写到冻结文件当场拒 (agent-tools:664)。没冻 / 不适用 → 直接跑, 逐字节同旧。
      const guarded = (): Promise<ExecutorDagResult> =>
        freeze && freeze.frozen ? (deps.withProtected ?? withProtectedPaths)(freeze.protectedFiles, () => deps.runChild(plan, n)) : deps.runChild(plan, n);
      try {
        exec = await guarded();
      } catch (err) {
        // 嵌套 run 抛错 = 引擎侧事故, 不是 conductor 的错: 原文回给 conductor (它据此决定换形状还是上报), 不吞。
        const msg = String(err instanceof Error ? err.message : err).slice(0, 600);
        logger.warn({ card: card.name, seq: n, err: msg }, '[orchestrating-loop] 嵌套 run 抛错 (原文回给 conductor)');
        if (ledger) {
          ledger.childRunError++;
          // 硬约束 1 (D-2): 子 run 抛错 → 只记 error, 事实字段缺席 (没结果就没事实, 不编空数组 / 0)。
          ledger.dispatches.push({ ...dispatch, error: msg.slice(0, 200) });
        }
        return { content: [{ type: 'text', text: `[${label} · 引擎抛错, 未产出]\n${msg}` }], details: { ok: false, card: card.name, seq: n, error: msg } };
      }
      for (const r of Object.values(exec.results)) priorById.set(r.id, r);
      // 1-A: 第一个派成的派发回来 → 记 hash 冻结 (存在的那些); 一个都没写出来 = 没冻住, 下一次派发继续强制。
      let freezeNote = '';
      if (freeze && !freeze.frozen) {
        const hashes: Record<string, string | null> = {};
        for (const f of freeze.files) hashes[f] = hashArtifact(join(freeze.root, f));
        freeze.protectedFiles = freeze.files.filter((f) => hashes[f] !== null);
        freeze.frozen = freeze.protectedFiles.length > 0;
        if (ledger) ledger.criterionFreeze = { files: [...freeze.files], ...(freeze.frozen ? { frozenAtDispatch: n, hashes } : {}) };
        freezeNote = freeze.frozen
          ? `\n[1-A 判据文件已冻结: ${freeze.files.map((f) => `${f} ${hashes[f] ? `(${hashes[f]})` : '(仍不存在 — 没冻住, 判据对它仍恒红)'}`).join(' · ')}; 之后的派发不得改它们 (工具写当场拒)]`
          : `\n[1-A 判据文件一个都没写出来 (${freeze.files.join(', ')}); 下一个派发仍必须是单独写它们的 work()]`;
        logger.info({ seq: n, hashes, frozen: freeze.frozen }, '[orchestrating-loop] 1-A 判据文件冻结');
        // ── #205 方向性探针 (2026-09-04) ────────────────────────────────────────
        //
        // **这是唯一能问出「判据测没测对方向」的时刻**: 判据文件刚写出来 (存在了), 而实装还没做。
        // 把它放回改动前的代码里跑 —— 红 = 它在量本次改动; 绿 = 改动前就成立, 那它量的是别的东西。
        //
        // 为什么以前拿不到这个读数: `sdd-compile.ts` 2026-08-22 删 RED 节点的根因是「实装前跑
        // verify 必然是 `bun test <还不存在的文件>`, 红的理由是文件不存在」—— 那条根因在这里
        // **不成立**, 因为 1-A 保证了文件此刻已经写出来。
        //
        // fail-open 三层: 只在冻住了 (文件真写出来) + 有可跑判据时才跑; 抛错吞掉但留证据;
        // 结论只进账本, **不翻终态、不拦派发** (「改动前绿 ⇒ 方向错」零真实样本支撑, 先量再拦)。
        if (freeze.frozen && deps.ctx.acceptance && ledger) {
          try {
            const dv = await probeCriterionDirection(
              deps.ctx.acceptance.command,
              freeze.protectedFiles,
              freeze.root,
              deps.ctx.acceptance.expect_exit,
            );
            ledger.criterionDirection = dv.status;
            logger[dv.status === 'green-before' ? 'warn' : 'info'](
              { seq: n, status: dv.status, why: dv.why.slice(0, 300) },
              '[orchestrating-loop] #205 判据方向性探针',
            );
          } catch (err) {
            // fail-open 吞异常**不吞证据** (§静默坑 2)。
            ledger.criterionDirection = 'inconclusive';
            logger.warn({ seq: n, err: String(err) }, '[orchestrating-loop] #205 方向性探针抛错 → inconclusive (不拦)');
          }
        }
      }
      if (ledger) {
        ledger.ok++;
        ledger.byCard[card.name as ConductorCardName] = (ledger.byCard[card.name as ConductorCardName] ?? 0) + 1;
        const facts = computeLoopDispatchFacts(plan, exec);
        ledger.dispatches.push({ ...dispatch, failed: Object.values(exec.results).filter((r) => r.status !== 'done').length, ...facts });
      }
      const summary = summarizeChildRun(exec, label);
      const failed = Object.values(exec.results).filter((r) => r.status !== 'done').map((r) => r.id);
      return {
        content: [{ type: 'text', text: `${summary}${freezeNote}` }],
        details: { ok: true, card: card.name, seq: n, plan: exec.plan.name, nodes: Object.keys(exec.results).length, failed },
      };
    },
  } as AnyOmdTool;
}

/**
 * conductor 节点的整副面。常驻 prompt 超 INV-8 上限**不抛** (运行期不为一个字符掀桌), 但留一行证据 ——
 * 硬闸在 conductor-prompt.test.ts。
 */
export function buildConductorFace(facts: ConductorFacts, deps: ConductorRuntimeDeps): LeafFace {
  const cards = createConductorTools(deps.ctx);
  const systemPrompt = buildConductorSystemPrompt(facts, cards);
  if (systemPrompt.length > CONDUCTOR_PROMPT_RESIDENT_MAX) {
    logger.warn({ chars: systemPrompt.length, max: CONDUCTOR_PROMPT_RESIDENT_MAX }, '[orchestrating-loop] conductor 常驻 prompt 超 INV-8 上限 (照跑, 留证)');
  }
  if (deps.ledger) deps.ledger.residentPromptChars = systemPrompt.length;
  // grind 停滞钟的进度信号 (2026-09-05)。conductor 结构上不写文件 → 叶子那把"写入新路径"的尺子
  // 对它恒不走, 三档退化成无条件 25 分钟 abort (实账 R0 `stallAtAbort=1536108ms` ≈ 节点全寿命)。
  // 它的进展 = **真派出去并拿回了结果**: `dispatches` 在派成 (:492) 与子图报错 (:440) 两处都 push,
  // 而 help / schema 拒 / 编译拒 / 坐标拒**都不 push** —— 正是要的语义 (被拒的派工不算进展,
  // 否则 conductor 能靠刷拒把熔断钟按住)。判据见 LeafFace.progress。
  if (!deps.ledger) {
    logger.warn({}, '[orchestrating-loop] conductor face 没有 ledger → grind 停滞钟退回叶子口径 (它对 conductor 恒不走, 会在 ~25min 无条件 abort)');
  }
  const ledger = deps.ledger;
  return {
    toolNames: [...CONDUCTOR_HAND_TOOLS],
    customTools: createConductorRuntimeTools(deps),
    systemPrompt,
    ...(ledger ? { progress: () => ledger.dispatches.length } : {}),
    // D-20 机械面 (2026-09-03, smoke8-p3 repo_understanding 那题 conductor 用 heredoc 写了 22KB 产物): bash 只读, 改文件只能派 work()。
    readOnlyShell: true,
    ...(deps.ledger ? { onReadOnlyBlocked: () => { deps.ledger!.readOnlyShellBlocked++; } } : {}),
  };
}

