/**
 * src/harness/goal/loop-run —— 编排循环的**引擎 config 装配** + `run` 工具的任务入口 (2026-09-03, v1 规划式 conductor 退役)。
 *
 * 两个消费方共用同一份装配 (D-5 唯一执行入口, 不留第二套语义):
 *   · `solve` (run-goal.ts): 目标 → classify → 循环图 (conductor + 环外 accept) → 终审 / D-14 回灌 / 验收阶梯;
 *   · `run` (mcp/tools/dag-tools.ts 经 assemble 的 DagEngine.runExecutorDag 接缝): 任务原文 → 同一个 conductor 节点
 *     (七张卡 + 只读手 + 常驻 prompt), **没有** accept 节点 —— run 没有目标这个概念, 只有图, 所以也没有验收。
 *
 * `run` 的终审处理 = D-14 的最小形: 终审判红 → finding 回灌 conductor goal 重跑一次 (第二跑不带 verifier, INV-7 恰一次),
 * 之后**不复审** —— 回执里 verification 仍是第一次的判红 + attempts:2, 读的人看得出「回灌过、没人再判」。
 * conductor 节点死于基建 (529 / 超时 / 停摆) 不回灌 (再派只是再撞一次墙)。
 *
 * 证伪方式 (loop-run.test.ts): 把 `maxEscalations: 0` 去掉 → 「引擎不开升级重规划轮」红; 第二跑 config 带 verifier →
 * 「INV-7 恰一次」红; 回灌不 append finding → 「回灌锚」红; 基建败因也回灌 → 「基建不回灌」红。
 */
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import { runExecutorDagWithPlan } from '../dag/engine';
import type { ConductorCtx } from '../conductor/types';
import { allowlistForRoot } from '../command-leaf';
import { tryResolveSeatModel } from '../../model/role-models';
import { AGENT_DEFAULT_FANOUT } from '../fleet';
import { logger } from '../logger';
import { missingPathArgs } from './acceptance-gate';
import { extractProtectedPaths } from './goal-protections';
import { createConductorCardLedger, withDispatchEvidence, type ConductorCardLedger } from './loop-ledger';
// 2026-09-04 leaf plumbing:三份名册算一次,进 ctx.registries 给 compile 查,进 ConductorFacts 给
// conductor 自己看("我可以引那个名?")。renderConductorFacts 渲染时不再扫盘。
import { loadProfiles } from '../profiles/profile';
import { loadAgentTemplates } from '../agent-templates';
import { knownMcpServerNames } from '../../mcp/client/config';
import { createReadLedger } from '../read-ledger';
import {
  CONDUCTOR_INFRA_FAILURE_KINDS,
  CONDUCTOR_NODE_ID,
  buildConductorFace,
  compileOrchestratingLoop,
  conductorNodeIdOf,
  isOrchestratingLoopPlan,
  loopDepthOf,
  withReinjectedFinding,
} from './orchestrating-loop';

/** 运行冻结判据的形状 (run-goal 的 `runnable`); `run` 入口恒 null。 */
export type LoopRunnable = { command: string; expectExit?: number } | null;

/** 循环装配需要的宿主面: 工作树根 + 引擎 config + (测试) 注入的执行口。solve 与 run 各自从自己的 config 投影出来。 */
export interface LoopHost {
  cwd: string;
  dag: ExecutorDagConfig;
  /** D-5 唯一执行入口的注入面 (测试传 fake); 缺席 = 真 runExecutorDagWithPlan。 */
  runDag?: (plan: ConductorPlan, config: ExecutorDagConfig) => Promise<ExecutorDagResult>;
  /** 嵌套深度 (顶层缺席 = 0); decompose 派出的子循环 = 1。 */
  depth?: number;
}

/** conductor 面的坐标: 写根 / 命令白名单 / 并发 / 三个座位 / 有没有研究手。 */
export function conductorCtxOf(host: LoopHost, runnable: LoopRunnable): ConductorCtx {
  const seat = (id: 'agent' | 'escalation' | 'verifier'): string | undefined => {
    try {
      return tryResolveSeatModel(id)?.model;
    } catch (err) {
      // 座位表读不出来 (测试 / 无 config) = 这一格缺席, 留一行证据, 不掀桌。
      logger.warn({ seat: id, err: String(err).slice(0, 120) }, '[loop-run] conductor 座位坐标解析失败 → 缺席');
      return undefined;
    }
  };
  // 2026-09-04 leaf plumbing:三份名册一次性算好,work + spawn compile 读这个面,而非自己再扫盘
  // (D-25:compile 不读盘)。loadProfiles/loadAgentTemplates/knownMcpServerNames 内部都是 cwd 相对读,
  // 读不到就返各自的内置子集 —— 不会抛, 安全。
  const registries = {
    profiles: [...loadProfiles(host.cwd).keys()],
    templates: [...loadAgentTemplates({ root: host.cwd }).keys()],
    servers: [...knownMcpServerNames(host.cwd)],
  };
  return {
    cwd: host.cwd,
    writeRoot: host.cwd,
    ...(runnable ? { acceptance: { command: runnable.command, expect_exit: runnable.expectExit ?? 0 } } : {}),
    allowlist: allowlistForRoot(host.cwd),
    maxFanout: host.dag.maxFanout ?? AGENT_DEFAULT_FANOUT,
    seats: {
      worker: host.dag.agentLeafModel ?? host.dag.leafModel ?? seat('agent') ?? '',
      escalation: host.dag.conductorEscalationModel ?? seat('escalation') ?? host.dag.conductorModel ?? '',
      verify: seat('verifier') ?? '',
    },
    researchAvailable: Boolean(host.dag.researchRunner),
    registries,
    ...(host.depth ? { depth: host.depth } : {}),
  };
}

/**
 * P3 S6b: 循环路径的引擎 config —— 在 `base` 上加 (a) `maxEscalations: 0` (D-14 不开重规划轮) 与
 * (b) `leafFace` (只对 `conductor` id 返回整副面)。卡的 `runChild` 跑派发出的子图: 同一 `runDag` 注入口
 * (D-5 唯一执行入口), 子 run 的 config = base 剥掉 verifier / maxEscalations / leafFace / freezeCriterion
 * (子图节点各自带 self_check; 终审只在父 run 打一次), continuity 派生 runId `<runId>:d<n>` (子节点 checkpoint
 * 与父 run 不撞; `onComplete` / `onNodeEvent` 保留 —— 留痕库按 run_id 归组, 一次派发一行, 进度事件照发)。
 */
export function withLoopConfig(
  base: ExecutorDagConfig,
  plan: ConductorPlan,
  host: LoopHost,
  runnable: LoopRunnable,
  task: string,
  /** R-1 账本; 回灌第二跑传同一个对象 (两跑合并计数)。 */
  ledger?: ConductorCardLedger,
): ExecutorDagConfig {
  const ctx = conductorCtxOf(host, runnable);
  const { verifier: _v, maxEscalations: _m, leafFace: _f, freezeCriterion: _c, frozenNodes: _n, deterministicReplan: _d, ...childBase } = base;
  void _v; void _m; void _f; void _c; void _n; void _d;
  const runChild = (childPlan: ConductorPlan, seq: number): Promise<ExecutorDagResult> => {
    const continuity = base.continuity
      ? { ...base.continuity, runId: `${base.continuity.runId}:d${seq}`, resume: false }
      : undefined;
    let childCfg: ExecutorDagConfig = { ...childBase, ...(continuity ? { continuity } : {}) };
    // decompose 卡 (2026-09-04): 子 run 自己也是一张编排循环 —— 给它装同一副面 (七张卡 + 只读手), 深度 +1;
    // 终审仍只在父 run 打 (childBase 已剥 verifier), 子循环的 conductor 坐 escalation 座 (plan 上已钉)。
    if (isOrchestratingLoopPlan(childPlan)) {
      const depth = loopDepthOf(childPlan) || (host.depth ?? 0) + 1;
      childCfg = withLoopConfig(childCfg, childPlan, { ...host, depth }, null, childPlan.nodes[conductorNodeIdOf(childPlan)]?.goal ?? task, undefined);
    }
    return (host.runDag ?? runExecutorDagWithPlan)(childPlan, childCfg);
  };
  const budgetMs = base.loopBudget?.ms;
  // 1-A (2026-09-03; 2026-09-05 只留边界): 判据引用、此刻不存在的文件 —— 它们一旦被写出就冻结
  // (hash 记账, 之后任何派发改它们都会被工具闸拒); 先勘察还是先写判据由 conductor 定 (闸在 orchestrating-loop)。
  // 回灌第二跑时文件已存在 → 这里算出 [], 但 ledger.criterionFreeze 里已有 hashes → 工具面从那里恢复保护 (initFreezeState)。
  //
  // 逃生口 `OMD_CRITERION_FREEZE=0` (2026-09-05, 引擎回归定位实验): 关掉整个 1-A ——
  // criterionFiles 恒空 ⇒ 判据文件不冻结、之后的派发不走路径禁令。
  //
  // 为什么需要它: dsw/dswr (5458fd4a **之前**, 无 1-A) 0.740; p6/dsc (之后) 0.610/0.659,
  // 同座位同题集差 0.081 (2.3σ)。而 1-A 恰恰规定了「第一步必须做什么」, 与 §引擎理念 ②
  // 「边界之内引擎不规定怎么做」相悖; 同批实测判据方向性 green-before 7 题 reward 仅 0.212 ——
  // 判据方向本就不可靠, 1-A 却把整场锁死在第一步写出来的那个判据上。
  // 这是**可证伪假设**, 不是结论: 关掉后若仍 ~0.66, 说明 1-A 不是那 0.081 的主因, 回去二分。
  //
  // 读数回来了 (2026-09-05, 单变量同座位同题集): code80-dsc (开) 0.6592 vs code80-nofreeze (关) 0.7189,
  // 差 0.060 / 1.7σ (sd 0.0346)。据此砍掉 1-A 里「规定怎么做」的两条 (首发必须是一张 work() · 首发写集强制),
  // 只留边界那一条 (判据文件写出即冻结, 之后不可改)。本逃生口语义不变: `=0` 仍是关全部。
  //
  // ⚠ 默认恒开 —— 只有显式 `=0` 才关, 其余取值 (含缺席/空串/'1') 一律照旧, 存量行为逐字节不变。
  const freezeOff = process.env.OMD_CRITERION_FREEZE?.trim() === '0';
  const criterionFiles = runnable && !freezeOff ? missingPathArgs(runnable.command, host.cwd) : [];
  // 关掉时连 ledger 恢复那条也要断: 否则回灌第二跑会从 `ledger.criterionFreeze` 把保护捡回来,
  // 逃生口就只关了一半 (那种"关了但没全关"的旋钮比没有旋钮更坏 —— 读数会归错因)。
  const freezeFiles = freezeOff ? [] : criterionFiles.length ? criterionFiles : ledger?.criterionFreeze?.files ?? [];
  const conductorId = conductorNodeIdOf(plan);
  // 2026-09-04:三份名册进 ConductorFacts(与 ctx.registries 同源,不重复扫盘)。空数组也传(undefined 时
  // 渲染行不出现,但传过去 [] 不会让 conductor 误以为「没注册」)。
  const reg = ctx.registries ?? { profiles: [], templates: [], servers: [] };
  const face = buildConductorFace(
    {
      goal: plan.nodes[conductorId]?.goal ?? task,
      writeRoot: host.cwd,
      protectedPaths: extractProtectedPaths(task),
      ...(ctx.acceptance ? { acceptance: ctx.acceptance } : {}),
      ...(criterionFiles.length ? { criterionFiles } : {}),
      minutesLeft: budgetMs !== undefined ? Math.max(0, Math.floor(budgetMs / 60_000)) : null,
      tokensLeft: base.loopBudget?.tokens ?? null,
      maxFanout: ctx.maxFanout,
      researchAvailable: ctx.researchAvailable,
      profiles: reg.profiles,
      templates: reg.templates,
      mcpServers: reg.servers,
    },
    {
      ctx,
      runChild,
      ...(ledger ? { ledger } : {}),
      ...(freezeFiles.length ? { criterionFreeze: { files: freezeFiles, root: host.cwd } } : {}),
      // W2 (2026-09-06): 这一副面一本读账。**按面建, 不跨面复用** —— D-14 回灌的第二跑会再调一次
      // `withLoopConfig`, 那时是新的一副 conductor 面、新的一轮勘察; 沿用上一跑的账等于把上一跑
      // 读到的东西交接给这一跑的子节点 (与 `ConductorCardLedger` 刻意相反: 那本数的是「这趟 run」)。
      readLedger: createReadLedger(),
    },
  );
  return {
    ...base,
    maxEscalations: 0,
    leafFace: (node) => (node.id === conductorId ? face : undefined),
  };
}

/** conductor 节点基建类败因 (与 run-goal 的 `conductorInfraFailure` 同一判据): 有 → 不回灌。 */
export function conductorInfraFailureOf(exec: ExecutorDagResult): string | undefined {
  const conductor = exec.results[CONDUCTOR_NODE_ID];
  if (!conductor || conductor.status === 'done' || !conductor.failureKind || !CONDUCTOR_INFRA_FAILURE_KINDS.has(conductor.failureKind)) return undefined;
  return `conductor 节点基建失败 (${conductor.failureKind}): ${(conductor.output ?? '').slice(0, 240)}`;
}

/**
 * `run` 的任务入口 —— 与 `DagEngine.runExecutorDag` 同签名, assemble 把它钉进生产引擎接缝。
 *
 * 工作树根 = `continuity.repoRoot` (隔离档下 dag-tools 已钉到 worktree) ?? process.cwd(); 与 leaf runner 解析写集的
 * 根同源 (dag/types.ts `continuity.repoRoot ?? process.cwd()`), conductor 的 writeRoot / 白名单 / 保护路径都从它算。
 * conductorModel 必填 (编排节点坐 conductor 座, owner 2026-09-03); leafModel 必填 (派发的子图叶子要它)。
 */
export async function runOrchestratingLoop(task: string, config: ExecutorDagConfig): Promise<ExecutorDagResult> {
  if (!config.conductorModel) throw new Error('loop-run: conductorModel 必填 (编排节点坐 conductor 座, 形如 provider:modelId)');
  if (!config.leafModel) throw new Error('loop-run: leafModel 必填 (派发子图的叶子要它, 形如 provider:modelId)');
  const host: LoopHost = { cwd: config.continuity?.repoRoot ?? process.cwd(), dag: config };
  const runDag = runExecutorDagWithPlan;
  return runLoopTask(task, config, host, runDag);
}

/**
 * 可注入版 (测试用 fake `runDag`); `runOrchestratingLoop` 是它的生产绑定。
 * 拆开的理由: DagEngine 接缝的签名只有 (task, config), 注入口不能从那里进。
 */
export async function runLoopTask(
  task: string,
  config: ExecutorDagConfig,
  host: LoopHost,
  runDag: NonNullable<LoopHost['runDag']>,
): Promise<ExecutorDagResult> {
  const plan = compileOrchestratingLoop({
    goal: task,
    ctx: conductorCtxOf(host, null),
    ...(config.conductorModel ? { conductorModel: config.conductorModel } : {}),
  });
  const ledger = createConductorCardLedger();
  const hostWithRun: LoopHost = { ...host, runDag };
  // 判卷官只观察不改判: 第一跑判红时把原文留下来, 决定要不要回灌 (引擎结果面的 verification 没有 target 那一位)。
  let verdict: { pass: boolean; reason: string } | undefined;
  const tapped: ExecutorDagConfig = config.verifier
    ? {
        ...config,
        verifier: async (req) => {
          // D-2: 派发子图机械记录随卷 (与 run-goal 的 tapVerifier 同一跳 withDispatchEvidence)。dispatches 空 → 同一个 req, 卷面同旧。
          const v = await config.verifier!(withDispatchEvidence(req, ledger.dispatches, { cwd: host.cwd }));
          verdict = { pass: v.pass, reason: v.reason };
          return v;
        },
      }
    : config;
  logger.info({ nodes: Object.keys(plan.nodes), conductorModel: config.conductorModel }, '[loop-run] run → 编排循环 (conductor 节点, 无 accept; v1 规划式 conductor 已退役)');
  let exec = await runDag(plan, withLoopConfig(tapped, plan, hostWithRun, null, task, ledger));
  if (verdict === undefined || verdict.pass) return exec;
  const infra = conductorInfraFailureOf(exec);
  if (infra !== undefined) {
    logger.warn({ why: infra }, '[loop-run] D-14: conductor 节点基建类败因 → 不回灌 (下一步 = 修引擎/换池, 别加轮数)');
    return exec;
  }
  // D-14: 终审判红 → finding 回灌同一 conductor 节点 goal, 按同一张图重跑一次; 第二跑**不带 verifier** (INV-7 恰一次)。
  const replanted = withReinjectedFinding(plan, verdict.reason);
  const { verifier: _noVerifier, ...noVerifierCfg } = withLoopConfig(config, replanted, hostWithRun, null, task, ledger);
  void _noVerifier;
  logger.warn({ reason: verdict.reason.slice(0, 200), dispatches: ledger.dispatches.length }, '[loop-run] D-14: 终审判红 → finding 回灌 conductor, 重跑一次 (不复审)');
  const second = await runDag(replanted, noVerifierCfg);
  const first = exec.verification;
  exec = {
    ...second,
    // 诚实边界: 第二跑没人再判, 回执上留第一次的判红 + attempts:2 —— 「回灌过、未复审」两件事都看得见。
    verification: {
      pass: false,
      reason: `${verdict.reason} (D-14: finding 已回灌 conductor 重跑 1 次, 终审不复审)`,
      attempts: 2,
      escalated: false,
      conductorModel: first?.conductorModel ?? config.conductorModel,
      ...(first?.infraObserved !== undefined ? { infraObserved: first.infraObserved } : {}),
    },
  };
  return exec;
}
