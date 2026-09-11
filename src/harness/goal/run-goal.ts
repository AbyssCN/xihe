/**
 * goal/run-goal —— 自主 goal 引擎的**薄竖切** (SDD 2026-07-28 omd-goal-engine, P1 / D-9)。
 *
 * 一个 goal 进来, 自主走完 research → spec → execute → verify → 1 轮修复, 阶段间零人工介入
 * (INV-GOAL-1)。它替代的是手动技能链 `/omd-research-deep → /omd-grill → /omd-contract → /omd-execute`。
 *
 * **外层严格无环** (D-2): 这里是一条固定的阶段序列, 不画回边。
 *
 * **D-F (2026-07-30): 外层 fixpoint 已撤**。此前 execute 段走 `iterateExecutorDag` —— 一层 run 级
 * 的环 (重画整张内层图) 套着节点内可能存在的另一层。P1 的 double-loop 教训是两层 verify 必须
 * 二选一 (成本翻倍 + 谁负责收敛语义打架), D-A 定的是**留节点内那一层**。于是现在两段都是
 * 一个 `executor:'conductor'` 节点:
 *
 *   契约段 `goal-contract` (specRounds) · 执行段 `goal-execute` (maxRounds)
 *
 * 环因此封在节点内且有轮数上限 (INV-GOAL-4), 状态 (轮次/毒集/上轮原因) 落**节点级** journal
 * `_loop-<nodeId>.json` —— run 级 `_fixpoint.json` 在这条路上不再被写也不再被读 (概念没删,
 * 是从 run 级降到了节点级; 删掉它等于把"被拒产出借崩溃复活"那个缺陷换个方式重新引入)。
 *
 * ⚠ 撤外层的代价记在 `judge_final` 上: 内环 judge 判的是**一个节点的 goal**, 而执行段那个节点的
 * goal 就是整个任务, 所以「整体目标成了吗」仍有人问 —— 但只有 `judge_final:true` 才在最后一轮
 * 真去问。别把它当成可省的旋钮。
 *
 * 为什么阶段序列仍是**编排代码**而不是一张 DAG: 判卷标准 (D-I) 必须留在环外, 它是在 classify 段
 * 算好后冻进两个节点的输入的 —— 让它进图就等于让执行体自己的环去产出判据 (D-J 整套防作弊的地基
 * 就是"判卷标准是执行体动不了的东西")。
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { runExecutorDagWithPlan } from '../dag/engine';
import { makeDefaultGenerate } from '../dag/defaults';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagResult, LeafResult, DagObservation } from '../dag/types';
import { judgeRubric, DEFAULT_RUBRIC_MAX_FAILURES } from './rubric-judge';
import { classifyGoal, renderAcceptance, type AcceptanceSpec, type GoalClassification, type GoalTier } from './classify-acceptance';
import { writeWebOracleSpec } from './web-oracle';
import { ignitionPreflight, type FreezeCheckOpts, type ExclusiveLocksOpts } from './ignition-preflight';
import { releaseDreamLock } from '../dream/trigger';
import { IgnitionBlockedError } from './ignition-blocked-error';
import { loadPreFlightConfig } from './preflight-config';
import {
  acceptanceCommandBlockReason,
  acceptanceVacuityReason,
  checklistDiscriminationReason,
  isPytestHarnessInconclusive,
  missingPathArgs,
  type ProbeItemOutcome,
} from './acceptance-gate';
// P2b-runtime (2026-09-02): 冻结判据 harness-inconclusive 的运行尾巴要落进人读的 receipt,
// 但必须有界 —— 复用既有的头+尾裁剪, 不新写第二份。
import { failureExcerpt } from '../failure-trace';
import {
  settleRubric as settleRubricDefault,
  verifyFrozen,
  type RubricItem,
  type RubricItemTrace,
  type RubricVerdict,
} from './rubric-spec';
import type { RunOutcomeKind } from '../run-outcome';
import { loadSddContract } from './sdd-direct';
import type { ExecutorDagConfig } from '../dag/types';
import { TEST_STEP_PREFIX, acceptSideOf, buildAcceptDelta, extractFailSet, stableFailSet, unstableFailSet, type AcceptSide } from './accept-delta';
import { baselineCommandOf } from './accept-baseline';
import { classifySpecWrite, type SpecWrite, type SpecWriteSource } from './spec-write';
import { summarizeDelta, type DeltaReport, type VerifyStepStatus } from './delta-compare';
import { parseBreakdown, type SddContract, type SddSlice } from './sdd-direct';
import { acceptCommandFromBreakdown, compileBreakdown, describeParallelism, parallelismReadout } from './sdd-compile';
import { acceptanceCommand, describeAcceptance, unprovenMeansFail } from './acceptance-shape';
import {
  decideO6,
  collectSliceGitEvidence,
  defaultGitExec,
  type ExecGit,
  type SliceProbe,
} from './slice-delivery';
import { specAnchor } from './spec-anchor';
import { dryRunSddIgnition } from './sdd-ignition-check';
import { coverSlices, describeSliceCoverage, type SliceCoverageReport } from './slice-coverage';
import { attributeWriteSet, classifyWriteScope, describeWriteSet, SDD_DECLARED_WRITE_SET, type DeclaredWriteSet, type WriteScopeKind, type WriteSetDeclaration, type WriteSetReport } from '../writeset/write-set';
import { collectRunTickets, type RunTicketSink } from '../pathfinder/run-tickets';
import { logger } from '../logger';
import { appendBoard, type BoardEntry } from '../board/run-board';
import { notifyOwner } from '../notify';
import { resolveProfile, type LeafProfile } from '../profiles/profile';
import { fingerprintOf, type ReviewFinding } from '../profiles/review-ledger';
import { maybeRunDesignReview, type DesignReviewResult } from './design-review';
import { escalationProviderReady, type VerdictTarget, type VerifierFn } from '../verifier';
import { extractProtectedPaths } from './goal-protections';
import { TERMINAL_ZERO_WRITE, zeroWriteVerdict, type ZeroWriteInput } from './zero-write-gate';
import { withProtectedPaths } from '../agent-tools';
import { hashArtifact } from '../continuity/checkpoint-manager';
import { compilePlaybook } from '../playbook/compile';
import { loadPlaybookForGoal } from './playbook-direct';
import {
  CONDUCTOR_INFRA_FAILURE_KINDS,
  CONDUCTOR_NODE_ID,
  compileOrchestratingLoop,
  withReinjectedFinding,
  renderRecheckTask,
  RECHECK_UNPROVEN_PREFIX,
  checkCriterionFreeze,
  renderCriterionFreezeTruth,
} from './orchestrating-loop';
import type { AcceptanceProbe } from './acceptance-gate';
import { countExistingTestsTouched, createConductorCardLedger, withDispatchEvidence, type ConductorCardLedger, type FalsifyLedger, type LoopLedger } from './loop-ledger';
import { probeEnvFacts, type EnvFacts } from '../env-facts';
import { ensureTestRunner } from './runner-ready';
import { renderDiffEvidence } from '../diff-evidence';
import {
  FALSIFY_PLAN_SCHEMA,
  buildFalsifyPrompt,
  pickRunner,
  renderFalsifyFinding,
  runFalsifyTests,
  validateFalsifyPlan,
  type FalsifyPlan,
  type SpawnLike,
} from './falsify-tests';
import { resolveRoleModel, send } from '../../model/gateway';
import { surveyForCriterion, type CriterionSurvey } from './criterion-survey';
import { buildLoopSurveyPack, conductorCtxOf, conductorGoalOf, withLoopConfig, type LoopHost } from './loop-run';
import { authorCriterionCrossFamily, type CriterionAuthorResult } from './criterion-author';
import { buildSpecPack, specPackEnabled, type SpecPack } from './spec-pack';
import { buildGoalRecall, goalRecallEnabled, type GoalRecall } from './goal-recall';

// D-I: 两条轴的类型与分类器都归 ./acceptance (那里是判据轴的单一真源); 此处 re-export 保旧调用面。
export type { AcceptanceSpec, GoalClassification, GoalTier } from './classify-acceptance';

/**
 * 已结晶 SDD → 执行型验收 (直通档的判据来源, 2026-08-11 run 7d50fda2 修)。
 *
 * 命令怎么推在 `sdd-compile.acceptCommandFromBreakdown` (单真源); 这里只管**要不要用它**:
 * 分解段解析不了 / 无 verify 列 → undefined, 回落分类器那条 (fail-open 但不吞证据 —— 存量
 * SDD 里"分解段无表"的今天仍在跑, 拒起跑是无谓回归)。
 */
function sddDerivedAcceptance(sdd: SddContract): AcceptanceSpec | undefined {
  let command: string | undefined;
  try {
    command = acceptCommandFromBreakdown(parseBreakdown(sdd.text));
  } catch (err) {
    logger.warn(
      { sdd: sdd.path, err: String(err instanceof Error ? err.message : err).slice(0, 160) },
      '[run-goal] 直通档: 分解表解析不了 → 验收命令回落分类器 (不静默)',
    );
    return undefined;
  }
  if (!command) {
    logger.warn({ sdd: sdd.path }, '[run-goal] 直通档: verify 列推不出验收命令 → 回落分类器 (不静默)');
    return undefined;
  }
  // 推出来也得**跑得起来**: verify 列写了白名单外的命令 (pytest/make/…) 时, 直接拿去当验收
  // 会在命令闸上被拒 —— 那是"假红" (规划期说能跑, 执行期根本没跑), 比回落更坏。
  const blocked = acceptanceCommandBlockReason(command);
  if (blocked) {
    logger.warn({ sdd: sdd.path, command, blocked }, '[run-goal] 直通档: verify 列推出的命令过不了命令闸 → 回落分类器 (不静默)');
    return undefined;
  }
  // expectExit 恒 0: 这是**总验收** (全绿), TDD 中途那次证红由平铺图的 RED 节点带 expect_exit=1。
  return { kind: 'executable', command, expectExit: 0 };
}

export type GoalStageName = 'classify' | 'survey' | 'research' | 'spec' | 'execute' | 'escalate';

export interface GoalStage {
  stage: GoalStageName;
  status: 'done' | 'failed' | 'skipped';
  /**
   * **这一步是怎么结束的** (N5, 2026-07-31)。`status` 一字未动, 这是**加的那一位**。
   *
   * 治的是 2026-07-31 第二跑 live 抓到的那行: 一次判定正确的 BLOCKED 被 `status` 念成 `failed`
   * (`[failed] execute — 2 轮阻塞…`), 而同一份摘要底下另一行写着"阻塞(需外部输入)" ——
   * 同一份输出里两行互相打架。词表与判据在 {@link RunOutcomeKind}。
   */
  outcome: RunOutcomeKind;
  /** 一行人可读结论 (失败原因 / 跳过理由 / 产物指针)。 */
  summary: string;
}

export interface RunGoalConfig {
  /**
   * O-6 切片交付判定用的 git 执行面(注入点,2026-08-28)。
   *
   * 省略 = 用 `defaultGitExec(config.cwd)` 跑真 git。给替身是为了让接线测试造得出
   * 「非 git 仓」「git 调用失败」这些拿真仓造不出来的格 —— 判定本身在
   * `goal/slice-delivery.ts`,是零 IO 纯函数。
   *
   * ⚠ 放在这里而不是 `ExecutorDagConfig`:后者在 `dag/types.ts`,而那个文件是登记面
   * 泛化闸的 trigger(碰它就要连 `seams.md` 与结构绊线一起改)。这个注入点只服务 run-goal
   * 一处,没有必要付那份代价。
   */
  gitExec?: ExecGit;

  cwd: string;
  /** 引擎 config 基座 (座位 + agent/command/research runner)。execute 阶段直接用它。 */
  dag: ExecutorDagConfig;
  /**
   * execute 段 conductor 节点的**内环**轮数上限 (1 轮修复 = 2)。默认 2 —— D-9 薄竖切就是"一轮修复"。
   * 上限 4 (schema 钳)。轮的语义是**逐轮重展开**, 不是重跑同一张子图。
   */
  maxRounds?: number;
  /** research 节点内环轮数 (有界, INV-GOAL-4)。默认 1。⚠ S6a 起暂无消费点 (见 goal.ts:638)。 */
  researchRounds?: number;
  /**
   * 契约段 (survey/research/spec 那个 conductor 节点) 的内环轮数。默认 1 = 只画一次。
   * >1 才启用**补调研**: 契约写完若判未达成, 下一轮重画时可以长出一个上一轮没有的调研步 (D-G′/D-A)。
   * ⚠ S6a 起暂无消费点 (唯一读点随契约段自动展开撤销一起删除)。
   */
  specRounds?: number;
  /** 强制档位 (成本轴); 省略 = 自动分类 (D-5)。**不覆盖判据轴** —— 验收分型仍照跑 (D-I)。 */
  tier?: GoalTier;
  /** 强制验收分型 (判据轴, D-I); 省略 = 自动分类。 */
  acceptance?: AcceptanceSpec;
  /** spec 写入磁盘目录 (默认 <cwd>/docs/plan)。⚠ S6a 起暂无消费点 (同上)。 */
  specDir?: string;
  /**
   * 直通入口 (SDD 2026-08-10-solve-sdd-direct-entry): 已结晶 SDD 的路径。给了 → 契约段子图
   * **零展开零转录** (specPath/evidence 直接取自该文件, 与闸 C 同一条消费通路), research 不跑。
   * 文件读不到 / 缺契约·分解段 → 起跑即抛 (fail-loud, 不静默降级回全程 goal)。
   */
  sddPath?: string;
  /**
   * playbook 直通入口 (与 sddPath 同族的"零契约段"入口, 2026-09): playbook 名从内置层
   * (templates/playbooks/<name>/) 或项目层 (<cwd>/.omd/playbooks/<name>/) 叠加查找, 找到后
   * `compilePlaybook` 出平铺图, survey/research/spec 三段零展开零重画。
   * 与 sddPath **互斥** —— 一次只能走一条, 闸在 run-goal 入口 (本文件 bail 同款 fail-fast);
   * mcp/tools/goal.ts handler 那一层先返 MCP 错, 这一层是 defense in depth。
   */
  playbook?: string;
  /**
   * t-gate-inmigrate (2026-09-01) 三道机械前置闸的调用方声明 (全部可选; 缺席 = 闸段缺席,
   * 零行为变化 — C-4 增量纪律)。默认兜底从 `<cwd>/.omd/preflight.json` 读 (loadPreFlightConfig)。
   */
  freezeCheck?: FreezeCheckOpts;
  /** 闸 B: role → coordinate 期望表; 实配不符 → 拒。 */
  seatExpectations?: Record<string, string>;
  /** 闸 C: 互斥锁显式覆盖; 缺席时从 resultOut/sddPath 拼。 */
  exclusiveLocks?: ExclusiveLocksOpts;
  /** 结果文件路径 (闸 C 互斥键之一; goal-worker/CLI 透传)。 */
  resultOut?: string;
  /** 跳过三道前置闸 (owner 显式越闸; 审计走 run 记录)。 */
  force?: boolean;
  /** 日期串 (spec 文件名)。测试注入; 默认今天 YYYY-MM-DD。 */
  _today?: () => string;
  /** 注入式分类器 (测试 / 自定义): 一次出两条轴 (D-I)。 */
  _classify?: (goal: string) => Promise<GoalClassification>;
  /**
   * 分类定稿回调 (判据轴证据钩子): 分类成功 (含降级 / fail-open / 探索型) 后**恰好调一次**,
   * 在 `_runDag` 与任何运行记录之前 —— 调用方可在此持久化探针裁决 (`acceptanceProbe`)。
   * 分类器抛错时**不调** (那时没有定稿的分类可持久化)。
   */
  onClassified?: (classified: GoalClassification) => void;
  /**
   * 契约段定稿回调 (#209 写入磁盘证据钩子): 契约段收尾后**恰好调一次** —— 每条路都调, 包括
   * simple 档 / 无 agentRunner / 直通 / 复用 / 契约段抛错。调用方在此持久化 `SpecWrite`
   * (账本 `omd_dag_runs.spec_write`)。
   *
   * ⚠ **时机就是判据**: 它在 execute 段之前、worktree 还在的时候发。挪到整趟收尾之后
   * (或改成 `existsSync` 事后扫盘) 这一列在隔离档下会恒 NULL —— run-goal.spec-write.test.ts
   * 里那条"记录时盘上文件已不存在, 账本仍记 wrote"就是钉这一点的。
   */
  onContract?: (spec: SpecWrite) => void;
  /**
   * 注入式 DAG 执行 (测试传 fake; 默认 runExecutorDagWithPlan)。
   * **契约段与执行段共用这一个注入口** —— 两段都是一张单 conductor 节点的图 (D-F),
   * 靠 `plan.name` (`goal-contract` / `goal-execute`) 分辨是谁在调。
   */
  _runDag?: (plan: ConductorPlan, config: RunGoalConfig['dag']) => Promise<ExecutorDagResult>;
  /** D-7 证伪测试座位的注入口 (测试用); 缺省真 `send` 走 `resolveRoleModel('verifier')` 那个异族座。 */
  _falsifySeat?: typeof send;
  /** D-7 证伪测试 runner 的注入口 (测试用); 缺省 `Bun.spawnSync` (见 `./falsify-tests`)。 */
  _falsifyRun?: SpawnLike;
  /**
   * D-2 (SDD cairness-distill 2026-08-10): 写集对账的可注入面。写集 = plan 节点可选 `write_set`
   * 字段 (conductor-plan.ts); 本钩子在 execute 段跑完后把跑后 git diff 逐文件走归属阶梯
   * (write-set.ts 的 ①-⑤, orphan 红)。给 `_collectChangedFiles` = 注入 diff 收集 (测试 / 隔离档);
   * 缺省 git status --porcelain (照 rollback-anchor 的 git 惯例; 失败 → 闸缺席 fail-open, warn
   * 留痕, INV-1 不吞证据)。`globalExempt` / `intentional` 是阶梯 ②/④ 的清单。整 run 无节点声明
   * → verdict 'undeclared' (INV-3: 声明缺席 ≠ 违规, NULL≠0 —— 那正是 O-1 的声明覆盖率读数)。
   * `declared` = run 级声明写集面 (S-2, 裁「该不该写」, 与节点级阶梯正交): 并发 run (写面互异) /
   * 测试注入自己的面。
   *
   * ⚠ 两个消费者对「缺席」的处置**刻意不同**, 别以为是漏改一处:
   *   - **写集对账** (下方 `declared ?? SDD_DECLARED_WRITE_SET`): 缺席时兜底常量。对账是本 SDD
   *     run 自己的闸, 兜底的是"我这一趟该写哪儿", 与常量同物。
   *   - **board claim 行**: 缺席就是**字段缺席**, 不兜底。板是给**别的 run** 读的协调介质,
   *     在那里拿一份无关的常量冒充本 run 的写集, 会让每一条撞车告警都说同一句假话
   *     (2026-08-26 实账: 12 条僵尸 claim 写集逐字节相同)。
   */
  writeSet?: {
    _collectChangedFiles?: () => string[];
    globalExempt?: string[];
    intentional?: string[];
    declared?: DeclaredWriteSet;
  };
  /**
   * **D-2 散雾出口** (SDD 2026-08-11-control-plane-unification 切片 1) 的**可选注入面**:
   * 给了 map 句柄, 这趟 run 的未决/发现物/终态才落成 map 上的 suggested 票 (人 confirm 前不进前沿)。
   *
   * **不给 = 闸缺席**, 收尾一行不多跑 —— 无相关配置的 run 行为逐字节不变 (INV-1)。
   * 判据在 pathfinder/run-tickets.ts (纯核), 本文件只负责"拿到句柄就喂给它, 出事只留痕不掀桌"。
   */
  tickets?: {
    /** 目标地图 slug。 */
    slug: string;
    /** map 写入口 (`resolveBackend(cwd)` 的结果即可; 缺 `suggest` 实装 = 闸缺席)。 */
    sink: RunTicketSink;
    /** 票身 runId 锚 (G-2 票→runId→回执)。省略 = continuity.runId ?? dag.sessionId; 都没有则不开票。 */
    runId?: string;
    /** suggestionsLog 时间戳 (可重放); 省略 = 现在。 */
    at?: string;
    /** 读 spec 全文的注入口 (测试); 省略 = readFileSync(specPath)。 */
    _readSpec?: (path: string) => string;
  };
  /**
   * P4 设计审核触发接线: 给了 profile 名 (默认 'design-review'), execute 后写集与前端 glob
   * 相交时调度审核叶 (advisory, 不阻塞主流程); 审核失败/timeout → converged 逐位不变 (INV-3)。
   * 不给 = 整段缺席, 行为逐字节不变。
   */
  designReview?: {
    /** 岗位档案名 (默认 'design-review')。 */
    profile?: string;
    /** 项目提供的截图命令。给了才启用生产截图审核 runner; 省略严格走 diff-only。 */
    screenshotCommand?: string;
    /** 升档模型坐标。省略回落 dag.conductorEscalationModel; provider 不可解析时不升档。 */
    escalationSeat?: string;
    /** 注入式审核 runner (测试用); 给了压过生产截图 runner。 */
    _runReview?: (diff: string, cwd: string) => Promise<{ findings: ReviewFinding[]; usage: { in: number; out: number } }>;
    /** D-7 修复已尝试标志: true → 同指纹熔断/转票, 不再落账新 findings。 */
    repairAttempted?: boolean;
  };
  /**
   * F2 片 4: rubric 验收步的注入面。**只对 `kind: 'rubric'` 起作用** —— 其它分型给也无视
   * (INV-1: 两格是护栏不是判据, 接线不污染)。
   *
   * 生产路径上谁去生成这三个字段 (presented / degraded / traces) 不归本片: 母契约 D-4 是配置面约束,
   * 跨族劣化样本的生成实装仍在别处。本片只保证**接口收得下**, 并按母契约 §INV-3 / §INV-4
   * 串好冻检查 → 劣化自证 → 逐条判 → settle 这条流水线。
   *
   * 不给 = 闸缺席 (fail-open 不拦, 但留证据行进 summary, 不假装判过) —— 与
   * `acceptanceCommandBlockReason` 缺席的纪律同源。
   */
  rubricVerdictInputs?: {
    /** 验收期呈上来的 checklist —— 与冻结时那份逐字节比对 (rubric-spec.verifyFrozen)。 */
    presented: readonly RubricItem[];
    /** 判别力探针的劣化样本逐条判结果; 缺席 (undefined) = 没样本, 探针跳过 (fail-open)。 */
    degraded?: readonly ProbeItemOutcome[];
    /** 真实产物的逐条判结果 —— 仅在 frozen+probe 都通过时进入 settleRubric。 */
    traces: readonly RubricItemTrace[];
    /** 「几条不过算整体不过」注入值 (母契约未决第 1 条: 0 = 全过才算过)。本片不写 owner 数值。 */
    maxFailures: number;
    /**
     * 测试注入的 `settleRubric` —— 走这一条时 wiring 调用它而非默认实装, 量 "漂了/探针打不红时
     * settle 真的没被调"。生产**不传**, 走默认; ESM 下模块导出是 readonly binding, 没法 monkey-patch。
     */
    _settleRubric?: typeof settleRubricDefault;
  };
  /**
   * **异族座出题者** (R4, 2026-09-06 `docs/plan/2026-09-06-异族先写判据-执行契约.md` D-2)。
   * 开关 `OMD_CRITERION_AUTHOR=cross` 开着、且判据引用的文件此刻不存在时被调**恰一次**。
   *
   * 不给 = 走生产默认 (`./criterion-author` 的 `authorCriterionCrossFamily`, 模型走 `config.dag.generate`)。
   * 测试注入这一口是为了把「模型说了什么」与「探针判了什么」变成单变量 —— 出题人与探针都不许是真的随机源。
   */
  _authorCriterion?: (input: {
    goal: string;
    command: string;
    expectExit: number;
    missingFiles: string[];
    root: string;
    surveyText: string;
    conductorModel: string;
  }) => Promise<CriterionAuthorResult>;
  /**
   * **判据重建者** (INV-4, 2026-08-29 否决边契约 D-4)。触发条件成立时被调**至多一次**,
   * 返回一条候选判据命令 (返回 `null` = 提不出来, 照实记, 不编)。
   *
   * 不给 = 走生产默认: 一张单 agent 节点的图, 座位跟 conductor 走 (契约 Open 段:
   * 「重建者座位待实测, 首版随 conductor 座」)。**连 `agentRunner` 都没有 = 重建者缺席** ——
   * 触发照记, 但不假装重建过 (fail-open 不吞证据)。
   */
  _rebuildCriterion?: (input: {
    goal: string;
    /** 当前那条冻结判据 (被判"量不出差别"的那条)。 */
    current: string;
    /** 为什么触发重建 (shouldRebuildCriterion 的判词原文)。 */
    trigger: string;
    /** 计划声明的产物集 —— 重建者据它知道"谁会产出什么"。 */
    declaredArtifacts: readonly string[];
  }) => Promise<{ command: string; expectExit?: number; negativeSample?: string } | null>;
 }

/** 这一趟 goal 走的执行路径 (D-1: 路径身份记在结果上, 不进 GRAPH_SHAPES 卡表)。 */
export type RunGoalPath = 'sdd-direct' | 'orchestrating-loop' | 'playbook-direct';

export interface RunGoalResult {
  goal: string;
  tier: GoalTier;
  /** D-I 验收分型 + 冻结的判卷标准 (执行型带可跑命令; 探索型带学习目标 + 可承受损失)。 */
  acceptance: AcceptanceSpec;
  stages: GoalStage[];
  /** spec 写入磁盘路径 (simple 档 / 无 agentRunner → undefined)。 */
  specPath?: string;
  /** research 阶段真抓到正文的 URL (INV-GOAL-2 证据面)。 */
  sources: string[];
  /** 仓内勘察结论 (survey 阶段产出; 跳过则空串)。 */
  repoContext: string;
  /** execute 阶段是否收敛 (judge 判过)。 */
  converged: boolean;
  /** execute 阶段实跑轮数。 */
  rounds: number;
  /** 修复轮里被复用的节点 (INV-GOAL-3 可证面; 单轮收敛 = 空)。 */
  reusedNodes: string[];
  /**
   * **这一趟 goal 是怎么结束的** (N5, 2026-07-31)。词表与每格的下一步在 {@link RunOutcomeKind}。
   *
   * 与 `converged` 的关系: `converged` 只答"成没成"这一位, 而没成的那一侧此前要靠调用方
   * 自己去看 `blocked` / `budgetStopped` / `cancelled` 三个可选字段**有没有值**来拼 ——
   * 拼错的成本已经见过: 一次正确的 BLOCKED 被念成 failed。这一位把那次拼装收成一处。
   *
   * 恒等于最后那个 execute 阶段的 `outcome` (goal 就是以它收尾的)。
   */
  outcome: RunOutcomeKind;
  /**
   * 执行段走的路径 (P3 S6b, D-1)。缺席 = 没跑到执行段 (契约段就结束 / bail)。
   * `orchestrating-loop` 是默认档; 其它四档只在显式关掉循环或 owner 给 sddPath 时出现。
   */
  path?: RunGoalPath;
  /**
   * **两条判据各自说了什么**(N9, 2026-07-31)。`judge` = 收敛判据(judge 判词);
   * `oracle` = 冻结判据(可执行验收命令的退出码;判据不是可执行式时恒 true)。
   *
   * 为什么要把两个布尔单独暴露, 而不是让调用方从 {@link outcome} 反推:**反推不出来**。
   * `judge` 是**观测位不是裁决位** (#148, 2026-08-17): 终态由环的结论 × oracle 定,
   * judge 的票不进算式 —— 于是「判据绿收敛而 judge 判没成」这一格在 outcome 上是 `success`,
   * 只有这两个布尔 (加 summary 里的 ⚠ judge 异议注记) 能把它读出来。
   *
   * 而那一格恰恰是「收敛判据可不可信」的另一半证据: 只看 `oracle-failed` 只能发现 judge 太松,
   * 发现不了 judge 太紧。两侧都要看得见, 这条轴才是对称的。
   *
   * 契约段就结束(没跑 execute)→ 缺席, 不编 —— 那时两条判据一条都没判过。
   */
  criteria?: { judge: boolean; oracle: boolean; oracleInconclusive?: boolean };
  /** R-1 (2026-09-03): 编排循环父 run 的读数 (回填 omd_dag_runs.loop)。缺席 = 没走循环。 */
  loop?: LoopLedger;
  /**
   * **BLOCKED 异步出口** (D-Q): 环判定"没有外部输入推不动"而提前退出的原因。
   * 与 `converged: false` 的区别是**该怎么办**: 未收敛 = 轮数用尽/judge 说没达标, 再给几轮可能就成;
   * blocked = 判据是确定性的 (环空转 / 检测者喊停), 再给多少轮都一样, 该由 owner 看一眼。
   * 恒与 `converged: false` 同时出现。
   */
  blocked?: string;
  /**
   * **环因预算停的** (2026-07-31, Loop Engineering 第四条停止轴)。与 `blocked` 分开的理由是
   * **下一步不一样**: blocked = 再多轮都一样, 该 owner 看; budgetStopped = 加预算 resume 很可能就成。
   * 恒与 `converged: false` 同时出现。
   */
  budgetStopped?: string;
  /**
   * **协作式取消** (D-P) 的原因。给了 = 这次是被叫停的, 不是跑完的 —— 已跑完的节点与轮次
   * 全在盘上, `dag_goal resume=<同一个 runId>` 接着跑。
   */
  cancelled?: string;
  /**
   * **D-1 mode 感知基线 delta** (SDD cairness-distill D-1): 批前基线 vs accept 节点实判的比对。
   * 缺席 = 非执行型 / 没配 commandRunner (fail-open) / 基线抛错 —— 闸缺席, 不是"零 delta"。
   * `red` = 本次跑批新引入了失败 (非零退出码语义; 老失败单列不红, INV-4 老段/新增段分开)。
   */
  verifyDelta?: DeltaReport;
  /**
   * **D-2 写集对账报告** (SDD cairness-distill D-2): 声明(事前) × touch(过程) × diff(事后) 三面对账。
   * 缺席 = 没配 writeSet 注入面 (闸缺席, 不是「零越界」); `verdict:'undeclared'` = 有对账但整 run
   * 无节点声明写集 (INV-3 NULL≠0)。`red` = 存在 orphan —— 非零退出码语义, 与引擎回归分开报 (INV-4)。
   */
  writeSet?: WriteSetReport;
  /**
   * **run 级声明写集面** (S-2): diff 逐文件裁 allowed / forbidden / outside —— 判据与 enforcement
   * 同一真源 (write-set.ts 的 classifyWriteScope + SDD_DECLARED_WRITE_SET)。与 writeSet 正交:
   * 节点阶梯裁「谁写的」, 声明写集裁「该不该写」。`forbidden` = 撞禁写面 (并发 run 的写面,
   * 并发越界样本, 非零退出码语义 —— 与 orphan 分开报, INV-4); `outside` = 声明面外 (INV-3:
   * 声明缺席 ≠ 违规, 读数不冒充零越界)。缺席 = 没配 writeSet 注入面 (闸缺席, fail-open)。
   */
  writeScope?: WriteScopeReport;
  /**
   * **S-46 缺片闸**: 分解表每一片的写集有没有真的落出东西。与 writeSet 严格正交 ——
   * writeSet 判「改了没声明的」(orphan), 本项判「声明了没改的」(缺片)。
   * 缺席 = 没配 writeSet 注入面, **或走的不是直通v2**(回落 conductor 铺图时切片不是执行单位)
   * —— 闸缺席不是「零缺片」。`red` = 存在零产出的片; `partial` 有产出, 告警不红。
   */
  sliceCoverage?: SliceCoverageReport;
  /** P4 设计审核结果 (advisory, 不参与收敛判定)。缺席 = 未启用设计审核。 */
  designReview?: DesignReviewResult;
  /**
   * **F2 片 4: rubric 验收步的结果**(INV-1/3/4/5)。**只对 `kind: 'rubric'` 起作用**:
   *   · `verdict` 设了 = 冻检查 + 劣化自证 + 逐条判三关都过了 (含 fail-open 跳过探针那一路),
   *     `verdict.pass` 是 settleRubric 的整体裁决; `verdict.traces` 是逐条痕迹 (永不全压成 N/M,
   *     仓规坑 ①)。
   *   · `rejection` 设了 = 冻检查判漂 (`source: 'frozen-drift'`) 或劣化自证判虚 (`source: 'probe'`),
   *     此时 `verdict` **必为 undefined** —— 漂了照判是失败模式 (INV-3)。
   *   · 两都 undefined = 验收步缺席 (`config.rubricVerdictInputs` 没给, fail-open 不拦但留痕)。
   * 非 rubric 的 run 这两个字段**永远 undefined** —— 接线不污染另两格。
   */
  rubricVerdict?: RubricVerdict;
  rubricRejection?: { source: 'frozen-drift' | 'probe'; reason: string };
  /**
   * **终态字面** (INV-5, 2026-08-29 否决边契约)。默认逐字等于 {@link outcome};
   * 有几格例外 —— rubric 分型而验收步缺席时它是 {@link TERMINAL_RUBRIC_UNWIRED};
   * 判据命令自己没给出判词 (P2b-runtime, bare 整仓 pytest 命中 2/4/5) 时它是
   * {@link TERMINAL_CRITERION_INCONCLUSIVE} —— 两格都是"归因不是判红/没收敛"的同类例外;
   * 收敛判定成立而盘上零改动时它是 {@link TERMINAL_ZERO_WRITE} (D-1); 探索型收敛时它是
   * {@link TERMINAL_UNVERIFIED} (D-2, 机器根本没判据可判)。
   *
   * 为什么不新开一个 `RunOutcomeKind`: 那张词表有 9 个消费面 + db schema, 而这一位要答的
   * 问题是"归因时该把它算在哪一格", 不是"下一步做什么" (下一步与 not-converged 同: 别加轮数)。
   */
  terminalLabel?: string;
  /**
   * **D-1 零写入闸读数** (契约 2026-09-05 假 success 三闸)。三态, 不许压平 (仓规坑 ①):
   * `checked:false` = 没查 (resume 豁免 / git 取不到, 靠 `why` 分辨) · `checked:true, zero:false`
   * = 查了盘上有改动 · `checked:true, zero:true` = 查了盘上零改动 (这一格必伴随 `converged:false`)。
   * 缺席 = 收敛判定本来就不成立, 闸不适用 —— **不是**"查了没事"。
   */
  zeroWrite?: { checked: boolean; zero?: boolean; why?: string };
  /**
   * **判据判红时的红因** (INV-2)。含 `rolled-back` = 本 run 曾转绿而终态低于那次绿
   * (去看回滚/毒集那条链); 含 `never-green` = 一次都没转过绿 (去看修复轮); 含
   * `harness-inconclusive` (P2b-runtime) = 判据命令自己没给出判词 (bare 整仓 pytest 命中
   * 2/4/5), 不是代码被判红 —— 去看 `detail` 里带的跑输出尾, 换一条指到具体测试文件的命令。
   * 缺席 = 判据没判红 / 非可执行判据 (不是"红因不明")。
   */
  criterionRedCause?: string;
  /**
   * **终态棘轮读数** (INV-1)。缺席 = 本 run 判据一次都没机械转绿 (棘轮没有地板可守),
   * 不是"棘轮没跑"。`action` 四态见 {@link BestGreenAction}; `restoredFiles` 只在真还原时有值。
   */
  bestGreenFloor?: { action: BestGreenAction; label: string; snapshotFiles: number; restoredFiles?: number };
  /**
   * **verifier 否决原文** (INV-1: 否决从"物理销毁"降为"信息动作" —— 那条信息得到得了人手上)。
   * 缺席 = 没配 verifier / 判过了 (pass)。
   */
  verifierDissent?: string;
  /**
   * **D-14 窄复审判词原文** (2026-09-04)。回灌重跑后机械 oracle 转绿时, 跨模型判卷官只回答
   * 一个是非题「首判 finding 修了没有」的那份判词。
   *
   * 与 `verifierDissent` **分两位**是刻意的: 那位是第一次全量终审的判词 (找问题),
   * 这位是第二只眼的复核 (只判那条问题修没修)。合并会让读的人分不清哪句话是谁说的。
   * ⚠ 缺席有三种成因, 靠台账 `loop.verifier.recheck` 分辨 —— 没回灌 / 回灌后 oracle 已红
   * (不值得再花一次调用) / 判卷官调不通 (fail-open)。**别把三者读成同一件事** (§静默坑 1)。
   */
  recheckDissent?: string;
  /**
   * 分类期判据自证的裁决 (#205, 2026-09-04 透出到结果面)。
   *
   * 为什么必须在**这里**而不是只进账本: 它原本只写 `dag-runs.db` 的 `acceptance_probe` 列,
   * 而 bench 容器里那个库**不出容器** (R-1 第 4 步注已记同一条: 账本在 omd home, `omd-state.tgz`
   * 只扫 `<cwd>/.omd`)。于是 `unproven-missing` 这一格在 bench 上永远读不到 —— 一个读不到的
   * 读数等于没有这个读数。挂到结果面上, 它随 resultOut 的 JSON 一起出容器。
   */
  acceptanceProbe?: AcceptanceProbe;
  /**
   * **判据重建边的留痕** (INV-4)。缺席 = 未触发重建。
   * `proposed` 缺席 = 触发了但重建者缺席/提不出 (与"提了没过门"分开: 后者 `proposed` 在场而 `admitted` 假)。
   *
   * ⚠ **诚实边界**: 重建出的判据**不参与本 run 的终态判定** —— 让执行体家族提的判据当场
   *   决定自己的成败正是 D-J 要杀的形态。这一位是留给 owner 与下一次点火的。
   */
  criterionRebuild?: { trigger: string; proposed?: string; expectExit?: number; admitted: boolean; why: string };
}
export interface WriteScopeReport {
  /** 逐文件裁决 (allowed / forbidden / outside)。 */
  files: { file: string; kind: WriteScopeKind }[];
  /** 撞禁写面 (并发 run 的写面) 的文件 —— 红。 */
  forbidden: string[];
  /** 在声明允许面内的文件。 */
  allowed: string[];
  /** 声明面外的文件 (INV-3 读数面, 不红)。 */
  outside: string[];
}

/** kebab-case slug (spec 文件名用); 非字母数字折成 '-', 截断 48。 */
export function goalSlug(goal: string): string {
  const s = goal
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'goal';
}

/** RunOutcomeKind → board terminal outcome 的**四值投影** (S4)。细粒度留在 note, 粗态进 outcome。 */
export const BOARD_TERMINAL_OUTCOME: Record<RunOutcomeKind, 'converged' | 'failed' | 'cancelled' | 'not-converged'> = {
  success: 'converged',
  cancelled: 'cancelled',
  'not-converged': 'not-converged',
  // #165①: 交付达标 (判据复验绿) 但有红节点 —— 板上粗态按「没全绿」念, 细粒度在 outcome 词。
  'delivered-with-red': 'not-converged',
  // P3 S6b (D-14): 终审判红 + 回灌一次后仍不能证明修复 —— 板上粗态按「没全绿」念, 细粒度在 outcome 词。
  'verifier-rejected': 'not-converged',
  'oracle-failed': 'failed',
  blocked: 'failed',
  'budget-exhausted': 'failed',
  'infra-error': 'failed',
  'missing-capability': 'failed',
  'not-needed': 'failed',
  'empty-result': 'failed',
  unclassified: 'failed',
};

/**
 * 终态 entry 构造 (S4, **纯函数面**): 内容可单测。为何需要它: appendBoard 追加 terminal 后,
 * run-board 的 compact 会立刻删掉**本 run 的全部条目 (含 terminal 行本身)** —— 板是协调介质
 * 不是真源 (D-3/INV-1), 事后读板读不到这条, 内容只能经这里验证。
 */
export function boardTerminalEntry(runId: string, outcome: RunOutcomeKind): BoardEntry {
  return {
    v: 1,
    ts: new Date().toISOString(),
    runId,
    event: 'terminal',
    outcome: BOARD_TERMINAL_OUTCOME[outcome],
    note: outcome,
  };
}
/** D-2 diff 面: 跑后 git 工作树相对 HEAD 的改动 (相对路径, 含未跟踪, 不含被忽略的)。非 git 仓/失败 → 抛 (调用方 fail-open)。 */
/** rubric 判官证据面的产物段: 盘上改动文件 (≤12 个, 每个 ≤20KB, 总 ≤80KB), 文本文件才进; 取不到 = 空串 + 一行证据。 */
export function renderArtifactEvidence(config: RunGoalConfig): string {
  let files: string[];
  try {
    files = (config.writeSet?._collectChangedFiles ?? (() => collectChangedFiles(config.cwd)))();
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 160) }, '[run-goal] rubric 证据面: 改动文件取不到 → 只用报告正文 (fail-open)');
    return '';
  }
  const parts: string[] = [];
  let total = 0;
  for (const rel of files.slice(0, 12)) {
    const abs = isAbsolute(rel) ? rel : join(config.cwd, rel);
    try {
      if (!statSync(abs).isFile()) continue;
      const raw = readFileSync(abs);
      if (raw.includes(0)) continue; // 二进制不进
      const text = raw.toString('utf8').slice(0, 20_000);
      if (total + text.length > 80_000) break;
      total += text.length;
      parts.push(`--- ${rel} ---\n${text}`);
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据 (仓规静默坑 ②): 少了哪个文件判官就少看一份, 得留痕。
      logger.warn({ file: rel, err: String(err).slice(0, 120) }, '[run-goal] rubric 证据面: 产物文件读不到 → 跳过');
    }
  }
  return parts.length ? `\n\n===== 产物 (盘上改动文件, 与报告分开读; 判官以此为准) =====\n${parts.join('\n')}` : '';
}

function collectChangedFiles(cwd: string): string[] {
  const r = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    throw new Error(`git status 失败 (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
  }
  return new TextDecoder()
    .decode(r.stdout)
    .split('\n')
    .filter((l) => l.trim().length > 0)
    // porcelain v1: 'XY path'; 重命名 'R  old -> new' 取新路径; '!!' = 被忽略, 不进 diff 面。
    .map((l) => (l.includes(' -> ') ? l.slice(l.indexOf(' -> ') + 4) : l.slice(3)))
    .filter((p) => !p.startsWith('!!'));
}

/**
 * 一轮里 leaf **报过写**的文件 (INV-1 绿快照的收集面, 2026-08-29)。
 *
 * 用 `filesTouched` 而不是 git diff: 前者是受控写工具的**事实**且按轮切分, 后者是整棵树相对
 * HEAD 的累积 —— 拿累积面去照"这一轮的绿"会把别人的在途改动一起照进来, 还原时就是误伤。
 * 相对路径按 leaf 自己的 `artifactRoot` 解析 (那一位存在的全部理由), 缺席才回落 cwd。
 * 越出 cwd 的、以及 `.omd/` 下的 (引擎自己的留痕库) 一律不收 —— 还原是破坏性动作, 面要窄。
 */
function collectTouchedPaths(results: Record<string, LeafResult>, cwd: string): string[] {
  const out = new Set<string>();
  for (const r of Object.values(results)) {
    for (const f of r.filesTouched ?? []) {
      const abs = isAbsolute(f) ? f : join(r.artifactRoot ?? cwd, f);
      const rel = relative(cwd, abs);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      if (rel.split(/[\\/]/)[0] === '.omd') continue;
      out.add(abs);
    }
  }
  return [...out];
}

/** 单个产物照快照的大小上限。超过它就判"收不全" —— 绿快照住在内存里, 不做分块存储。 */
const SNAPSHOT_FILE_LIMIT = 512 * 1024;

/**
 * 把绿那一刻的产物内容照下来。**收不全就返 null** (fail-closed):
 * 半份还原会把树变成两轮的混合体, 那比不还原更坏, 也更难被人看出来。
 * 盘上已不存在的路径不算收不全 (leaf 删过它, 那本来就是绿的一部分)。
 */
function readSnapshotFiles(paths: readonly string[]): { path: string; content: string }[] | null {
  const files: { path: string; content: string }[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      if (statSync(p).size > SNAPSHOT_FILE_LIMIT) return null;
      files.push({ path: p, content: readFileSync(p, 'utf8') });
    } catch (err) {
      // 读不了 (二进制/权限/竞态删除) = 这一份照不下来 ⇒ 整张快照不算数, 但留证据。
      logger.warn({ path: p, err: String(err) }, '[run-goal] INV-1 绿快照: 这份产物读不下来 → 整张快照作废 (fail-closed)');
      return null;
    }
  }
  return files.length > 0 ? files : null;
}

type DesignReviewRunner = (
  diff: string,
  cwd: string,
) => Promise<{ findings: ReviewFinding[]; usage: { in: number; out: number } }>;

/** profile 叶只回结构化 finding; 指纹在边界重算, 不信模型自报。 */
function parseDesignReviewFindings(text: string): ReviewFinding[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? text.trim();
  const objectAt = fenced.indexOf('{');
  const arrayAt = fenced.indexOf('[');
  const starts = [objectAt, arrayAt].filter((n) => n >= 0);
  if (starts.length === 0) throw new Error('design-review 未返回 JSON');
  const start = Math.min(...starts);
  const isArray = fenced[start] === '[';
  const end = fenced.lastIndexOf(isArray ? ']' : '}');
  if (end < start) throw new Error('design-review JSON 不完整');
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : [];
  return rows.flatMap((raw): ReviewFinding[] => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    const severity = typeof r.severity === 'string' ? r.severity.toLowerCase() : '';
    if (severity !== 'p0' && severity !== 'p1' && severity !== 'p2') return [];
    if (
      typeof r.where !== 'string' || !r.where.trim() ||
      typeof r.evidence !== 'string' || !r.evidence.trim() ||
      typeof r.suggestion !== 'string' || !r.suggestion.trim() ||
      typeof r.uncertainty !== 'string' || !r.uncertainty.trim()
    ) return [];
    return [{
      where: r.where,
      severity,
      evidence: r.evidence,
      suggestion: r.suggestion,
      uncertainty: r.uncertainty,
      fingerprint: fingerprintOf(r.where, r.evidence),
    }];
  });
}

function screenshotReviewPrompt(
  diff: string,
  screenshotCommand: string,
  severe?: ReviewFinding[],
): string {
  const recheck = severe?.length
    ? `\n\n初审 P0/P1, 只保留复核后仍成立的项:\n${JSON.stringify(severe)}`
    : '';
  return `执行项目截图命令并审查真实截图像素, 不从代码猜视觉质量。\n` +
    `截图命令(逐字执行): ${screenshotCommand}\n\n` +
    `前端写集/diff 输入:\n${diff}${recheck}\n\n` +
    '只输出 JSON: {"findings":[{"where":"文件或截图区域","severity":"p0|p1|p2",' +
    '"evidence":"像素证据","suggestion":"具体修法","uncertainty":"不确定性"}]}。无问题输出 {"findings":[]}。';
}

/**
 * 生产截图审核装配。无 screenshotCommand 故意不造 runner → maybeRunDesignReview 的 diff-only 路径;
 * 有命令才调 profile agent。初审无 P0/P1 时不碰升档座, provider 不可达也不冒充已升档。
 */
/**
 * INV-4 的生产端重建者 —— **座位跟 conductor 走** (契约 Open 段: 首版随 conductor 座, 待实测)。
 *
 * 没有 `agentRunner` = 返 undefined = 重建者缺席 (触发照记, 不假装重建过)。
 * 只要一条命令: 它的产出还要过全部自证门才准冻结, 所以这一发不需要结构化输出的仪式。
 */
function productionCriterionRebuilder(
  config: RunGoalConfig,
  protectedPaths: readonly string[],
): RunGoalConfig['_rebuildCriterion'] | undefined {
  const agentRunner = config.dag.agentRunner;
  if (!agentRunner) return undefined;
  return async ({ goal, current, trigger, declaredArtifacts }) => {
    const r = await withProtectedPaths(protectedPaths, () => agentRunner({
      model: config.dag.conductorModel,
      prompt: [
        '这次运行的**验收判据本身**很可能是坏的 —— 它量不出"做完了"与"还没做"的差别。',
        `触发证据: ${trigger}`,
        '',
        `## 目标\n${goal}`,
        `## 现在这条判据 (坏的那条)\n\`${current}\``,
        `## 执行根 (一切相对路径以它为准)\n${config.cwd}`,
        `## 计划声明会产出的东西\n${declaredArtifacts.length ? declaredArtifacts.join('\n') : '(计划没声明任何产物)'}`,
        '',
        '重写**一条**判据命令: 指向仓里真实存在 (或上面声明会被产出) 的路径, 且在活没干完时必然红。',
        '只输出那一条命令本身, 不要解释、不要代码块、不要前缀。',
      ].join('\n'),
    }));
    const command = r.text.trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
    return command ? { command } : null;
  };
}

/**
 * R4 生产出题者: 异族座**一发纯文本**, 无工具 —— 出题人不许碰仓, 它写的每个字节都要过
 * `parseAuthoredFiles` 的形状闸再写入磁盘。没有 `generate` (装配没接注入口) ⇒ 缺席, 走今天那条路。
 */
/**
 * R4 生产端出题者。`generate` **必须回落到引擎默认实现** —— `config.dag.generate` 是测试注入口, 生产从来不设。
 * 2026-09-06 code80-m3-author-cons 实测: 只读注入口 ⇒ 80/80 题「开关开着但没有出题者」, 整臂量了个空
 * (与 classify 那条 2026-07-30 的教训同型: 机制在、测试全绿、生产零生效)。
 * 证伪: 把 `?? makeDefaultGenerate(...)` 去掉 ⇒ criterion-author-wiring.test.ts「无注入 generate 仍有出题者」红。
 */
export function productionCriterionAuthor(config: RunGoalConfig): RunGoalConfig['_authorCriterion'] {
  const generate = config.dag.generate ?? makeDefaultGenerate(config.dag.sessionId ?? randomUUID());
  return (input) =>
    authorCriterionCrossFamily({
      ...input,
      generate: async ({ model, prompt }) => (await generate({ messages: [{ role: 'user', content: prompt }], model, traceName: 'goal:criterion-author' })).text,
      ...(config.dag.commandRunner ? { runCommand: config.dag.commandRunner } : {}),
    });
}

function productionDesignReviewRunner(
  config: RunGoalConfig,
  protectedPaths: readonly string[],
  screenshotCommand: string | undefined,
  escalationSeat: string | undefined,
): DesignReviewRunner | undefined {
  const agentRunner = config.dag.agentRunner;
  if (!screenshotCommand || !agentRunner) return undefined;
  const profileName = config.designReview?.profile ?? 'design-review';
  const profile: LeafProfile | undefined = resolveProfile(profileName, config.cwd);
  if (!profile && config.designReview?.profile) {
    logger.warn(
      `Unknown profile "${profileName}"; running as ordinary leaf`,
      `Unknown profile "${profileName}"; running as ordinary leaf (未知 leaf profile; design-review fail-open)`,
    );
  }
  const initialModel = profile?.seat ?? config.dag.agentLeafModel ?? config.dag.leafModel;
  const call = async (model: string, prompt: string) => {
    const r = await withProtectedPaths(protectedPaths, () =>
      agentRunner({ prompt, model, ...(profile ? { profile } : {}) }),
    );
    return { findings: parseDesignReviewFindings(r.text), usage: { in: r.usage.in, out: r.usage.out } };
  };
  return async (diff) => {
    const initial = await call(initialModel, screenshotReviewPrompt(diff, screenshotCommand));
    const severe = initial.findings.filter((f) => f.severity === 'p0' || f.severity === 'p1');
    if (!escalationSeat || severe.length === 0) return initial;
    const rechecked = await call(escalationSeat, screenshotReviewPrompt(diff, screenshotCommand, severe));
    return {
      findings: [...initial.findings.filter((f) => f.severity === 'p2'), ...rechecked.findings],
      usage: { in: initial.usage.in + rechecked.usage.in, out: initial.usage.out + rechecked.usage.out },
    };
  };
}
/** S-2 声明写集面摘要: 红 = 撞禁写面 (并发 run 写面); outside 是 INV-3 读数, 不冒充零越界。 */
function describeWriteScope(r: WriteScopeReport): string {
  if (r.forbidden.length > 0) return `撞禁写面 ${r.forbidden.length} [${r.forbidden.join(', ')}]`;
  if (r.outside.length > 0) return `声明面外 ${r.outside.length} (INV-3 读数)`;
  return '声明面内';
}

/**
 * **D-2 散雾出口的接线** (SDD 2026-08-11-control-plane-unification 切片 1): 这趟 run 的
 * 未决/发现物/终态 → map 上的 suggested 票 (G-1: 人 confirm 前不进前沿, 由 suggested 态本身保证)。
 *
 * 判据全在 `pathfinder/run-tickets.collectRunTickets` (纯核), 这里只做三件事: 取 runId 锚、
 * 读 spec 正文、把清单交给 map 句柄。
 *
 * **每一条不开票的路都留痕** (仓规第二条: fail-open 可以吞异常, 不许吞证据):
 *  - 没配 tickets → 静默 (闸根本没装, 不是失败)。
 *  - 配了但后端没 `suggest` / 取不到 runId / spec 读不出 / 落图抛错 → warn 一行, run 照常返回。
 * 尤其 runId: 取不到就**不开票** —— 一张回不去 run 的票违反 G-2, 比没有票更糟。
 */
function openRunTickets(result: RunGoalResult, exec: ExecutorDagResult, config: RunGoalConfig): void {
  const t = config.tickets;
  if (!t) return; // 闸缺席: 没给 map 句柄 (INV-1 逐字节不变的那条路)
  try {
    if (!t.sink.suggest) {
      logger.warn({ slug: t.slug }, '[run-goal] D-2 散雾出口: 后端未实装 suggest (S-1 面) → 不开票');
      return;
    }
    const runId = t.runId ?? config.dag.continuity?.runId ?? config.dag.sessionId;
    if (!runId) {
      logger.warn({ slug: t.slug }, '[run-goal] D-2 散雾出口: 取不到 runId 锚 → 不开票 (票回不去 run 违反 G-2)');
      return;
    }
    // ① 未决的料 = 写入磁盘的 spec 全文。读不到 → 该条出口缺席 (NULL≠0: 不冒充"零未决")。
    let specText: string | undefined;
    if (result.specPath) {
      try {
        specText = (t._readSpec ?? ((p: string) => readFileSync(p, 'utf8')))(result.specPath);
      } catch (err) {
        logger.warn({ specPath: result.specPath, err: String(err) }, '[run-goal] D-2 ①未决出口: spec 读不到 → 该条缺席 (不是零未决)');
      }
    }
    const drafts = collectRunTickets(result, {
      runId,
      ...(specText !== undefined ? { specText } : {}),
      ...(exec.verification ? { verification: exec.verification } : {}),
      ...(exec.blameRetry ? { blameRetry: exec.blameRetry } : {}),
    });
    if (drafts.length === 0) return; // 无未决无发现物无终态面 = 这趟没什么要人看的
    const res = t.sink.suggest(config.cwd, t.slug, drafts, { at: t.at ?? new Date().toISOString() });
    logger.info({ slug: t.slug, runId, drafts: drafts.length, summary: res.summary }, '[run-goal] D-2 散雾出口: run 产出 → suggested 票');
  } catch (err) {
    logger.warn({ slug: t.slug, err: String(err) }, '[run-goal] D-2 散雾出口开票失败 → 闸缺席 (fail-open, 不吞证据)');
  }
}

const todayStr = (): string => new Date().toISOString().slice(0, 10);

/**
 * 闸 C (2026-08-10) 的写入磁盘状态: resume 同一 runId 且 goal 文本未变时, classify 与契约段
 * (survey/research/spec) 的产物直接复用, 不重跑。事故背景: 同一段 goal 被心跳续派重分类 117 遍
 * (平均 2.1M tokens/遍) —— 节点级 checkpoint 拦不住, conductor 子图逐轮重展开, D-O 输入面
 * 恒判"依赖输出已变"。状态键 = goal 全文 sha256: 文本动一个字就作废, "未变"是精确判据不是猜。
 */
interface GoalPhaseState {
  goalHash: string;
  classified: GoalClassification;
  contract?: { specPath?: string; evidence: string; repoContext: string; sources: string[] };
  /**
   * **判据重建的审计轨**(INV-4 回写, 2026-08-30)。追加, 不覆盖。
   *
   * 这一列存在的全部理由是**「移球门必须留痕」**: 引擎换掉自己的验收判据是本仓风险最高的
   * 一个动作, 换了而看不出来就是静默降分。所以每换一次都记 `from`/`to`/`trigger`/`at`,
   * 人一眼能看出球门动过几次、从什么动到什么。
   *
   * ⚠ 只记**被采纳的**那些(`criterionRebuildAdmission` 判 `admitted:true`, 即两道自证门
   * 都真跑过且都过 —— 含**空世界自检判红**, 证明新判据不是恒真)。提了没被采纳的候选
   * 不进这里(它们进当次回执的 `criterionRebuild`, 那是另一件事)。
   */
  criterionHistory?: { at: number; from: string; to: string; expectExit?: number; trigger: string }[];
}

/**
 * 跑一个 goal 到底 (INV-GOAL-1)。
 *
 * @returns 每阶段的结论 + spec 路径 + 证据 URL + 收敛情况。**失败不抛** —— 阶段级失败记在
 *   stages 里往下走 (execute 阶段仍会拿到手上有的东西), 调用方按 stages 判要不要人接手。
 */
/**
 * S-37 下沉 (2026-08-17): 基线赦免闭包 (D-3, goal 层半) —— 由 `runGoal` 在
 * `baselineSide` 算出来后注入 `freezeCriterion.waiveRed`, 引擎在判红点 (D-K / 环内)
 * 调用。判据 = `extractFailSet(text)` 出失败名集: **非空 ∧ 全在基线** → 返注记;
 * **空集** (解析不出测试名 = 编译错/跑不起来/超时, INV-2) → null;
 * **任一新名字不在基线** → null (D-3 fail-closed)。
 *
 * 注记原文含被赦免名单 (INV-3 响亮): `存量红赦免 (S-37 下沉): N 条失败全在基线 — <names>`。
 * 这是 goal 层的**判断逻辑**: engine (dag 层) 不 import goal, 依赖方向不倒灌 (D-1)。
 */
export function makeBaselineWaiver(baselineFailSet: readonly string[]): (text: string) => string | null {
  const baselineSet = new Set(baselineFailSet);
  return (text: string): string | null => {
    const after = extractFailSet(text);
    if (after.length === 0) return null;
    for (const n of after) if (!baselineSet.has(n)) return null;
    return `存量红赦免 (S-37 下沉): ${after.length} 条失败全在基线 — ${after.join(', ')}`;
  };
}

// ── 否决边 / 反馈边 / 目标修订边 (契约 docs/plan/2026-08-29-veto-feedback-revision-edges.md) ──
//
// 四条不变量全落在本文件的**内环终态区**, 而那一段是单文件热区 —— 所以判定逐条抽成纯函数
// 摆在这里: 判据能被单测直接打, 接线处只剩"喂参数 + 执行结论"。

/** INV-5: rubric 分型且验收步缺席时的终态字面 (契约 GWT-5 逐字)。 */
export const TERMINAL_RUBRIC_UNWIRED = 'rubric-unwired';

/**
 * P2b-runtime (2026-09-02): 判据命令自己没给出判词时的终态字面, 与 `TERMINAL_RUBRIC_UNWIRED`
 * 同一种"归因不是判红"的例外, 走同一套接线机制 (`terminalLabel` / `oracleNote` / 摘要分支) ——
 * 不新开一个 `RunOutcomeKind` (理由见 `RunGoalResult.terminalLabel` 的文档注释)。
 */
export const TERMINAL_CRITERION_INCONCLUSIVE = 'criterion-inconclusive';

/**
 * 1-B 终审否决**判据**时的终态字面 (2026-09-04, code80-p5 读数)。同上一格的"归因不是判红"例外,
 * 同一套接线, **不新开 `RunOutcomeKind`**。
 *
 * 为什么必须分出来: 1-B 判定 `target=criterion` 时不回灌 conductor 是对的 (判据量不出对错,
 * 重跑实装没有意义), 但终态仍与「实装没修好」共用 `verifier-rejected` —— 于是「判据坏」被念成了
 * 「活没干成」。**code80-p5 实测代价: 3 题 bench 测试 12/12 · 12/12 · 13/13 全过, 被记成失败。**
 * 两格的下一步相反: 这一格是 INV-4 判据重建, 那一格是重跑实装。念错就把人指到错误的下一步。
 *
 * ⚠ 它**不翻** `converged` / `outcome` —— 被否决的判据上 oracle 绿仍不构成交付证据 (1-B 原立场未变),
 * 改的只是「怎么念这件事」。想数「判据坏 vs 实装坏」的读侧按此字面分。
 */
export const TERMINAL_CRITERION_VETOED = 'criterion-vetoed';

/**
 * D-2 (2026-09-05, 契约「假 success 三闸」): **探索型验收收敛**时的终态字面。
 *
 * 探索型没有任何机械判据 —— 收敛的意思只是「环跑完了」, 没有任何机器判过这活成没成。
 * 而 resultOut 首行印的是 `outcome: success`, CLI 印的是 `outcome=success`, 于是「机器判过」
 * 与「机器没判据可判」在读侧长得一模一样, 两者的下一步却相反 (前者可以收, 后者要人看)。
 *
 * ⚠ 它**不翻** `converged` / `outcome` (同上两格的立场): 探索型收敛仍是 success, 改的只是
 * 「怎么念这件事」。rubric 型不入这一格 —— rubric 判官是弱 oracle, 但它存在。
 */
export const TERMINAL_UNVERIFIED = 'success-unverified';

/**
 * INV-5 的判据: **这一格是"没接线", 不是"判红"**。
 *
 * 历史: `rubricVerdictInputs` 曾无人注入 (2026-08 生产常态), rubric 分型恒非 success, 终态被折进 `oracle-failed`
 * —— 三批 240 trial 里这一格占 13~20 个/批, 其 reward 均值**高于**整批: 标签与成败零相关。
 * R-2 (2026-08-30) 起生产在验收时**现算** (`judgeRubric`, 见下方 acceptance.kind === 'rubric' 那段), 注入口只留给测试;
 * 这一格今天只在判官没产出可用判词时出现。判词与拒因**任一在场**就说明判过了 (判红是判据的正常结论, 不是缺席)。
 */
export function rubricAcceptanceUnwired(input: {
  kind: AcceptanceSpec['kind'];
  verdictPresent: boolean;
  rejectionPresent: boolean;
}): boolean {
  return input.kind === 'rubric' && !input.verdictPresent && !input.rejectionPresent;
}

/**
 * INV-2 的红因字面。`harness-inconclusive` (P2b-runtime, 2026-09-02) 与前两个不是同一根轴:
 * 那两个假定判据命令**给出了**真判词 (要么曾绿过要么没有), 这一格是判据命令**没给出判词**
 * (bare 整仓 pytest 命中 2/4/5) —— 不是"活没干成", 是"这条判据命令自己没跑起来"。
 */
export type CriterionRedCause = 'rolled-back' | 'never-green' | 'harness-inconclusive';

/**
 * INV-2: 冻结判据判红时**红因分道**。
 *
 * 分的是「树曾经到过绿、现在低于它」与「一次都没到过绿」——
 * 前者要去看回滚/毒集那条链 (交付被销毁了), 后者是活没干成 (该看修复轮)。
 * 判据是 `everGreen` 一位: **口径是「低于绿快照」, 不是「谁回滚的」** —— 回滚只是今天已知
 * 唯一的成因, 把判据写成"重规划过"就会漏掉别的掉绿路径, 而漏掉的那格会被念成"从未达标"。
 * `replanned` / `recheckRan` 只进 detail (证据, 不是判据)。
 *
 * `harnessInconclusive` (可选, 缺省 false) 优先于 `everGreen` 判定 —— 命令自己没给出判词时,
 * "曾经绿过吗"这个问题问不出答案, 不该被 `everGreen` 的既有取值 (通常是 false) 悄悄接住而
 * 读成"从未达标"。`tail` 是有界的运行输出尾 (调用方已用 `failureExcerpt` 裁过), 缺席时
 * 显式落 `(无)`, 不是空串静默吞掉 (仓规坑①)。
 */
export function classifyCriterionRed(input: {
  everGreen: boolean;
  replanned: boolean;
  recheckRan: boolean;
  harnessInconclusive?: boolean;
  tail?: string;
}): { cause: CriterionRedCause; detail: string } {
  if (input.harnessInconclusive) {
    return {
      cause: 'harness-inconclusive',
      detail:
        '判据红因 harness-inconclusive: 冻结判据命令是不带路径的整仓 pytest 调用, harness 自己没跑起来 ' +
        `(退出码 2/4/5), 不是代码被判红 —— 给一条指到具体测试文件的 pytest 命令。跑输出尾: ${input.tail ?? '(无)'}`,
    };
  }
  const evidence = `重规划=${input.replanned ? '是' : '否'} · 收尾复验=${input.recheckRan ? '跑了' : '没跑成'}`;
  return input.everGreen
    ? {
        cause: 'rolled-back',
        detail: `判据红因 rolled-back: 本 run 内冻结判据曾机械转绿, 终态树低于那次绿 (${evidence})`,
      }
    : {
        cause: 'never-green',
        detail: `判据红因 never-green: 本 run 内冻结判据一次都没转过绿 (从未达标; ${evidence})`,
      };
}

/** INV-1 终态棘轮的留痕锚串 (摘要与 result 都带它, 契约 GWT-1 `.includes('best-green')`)。 */
export const BEST_GREEN_LABEL = 'best-green';




/** INV-1 棘轮的四个动作 —— 「不必动」「动不了」「真动了」不许压平。 */
export type BestGreenAction = 'none' | 'already-green' | 'restore' | 'unrestorable';

/**
 * INV-1: 终态交付**不得低于本 run 曾达到的那次绿**。
 *
 * 归因样本 4/12 死在这里: 第 1 轮判据真绿 → verifier 否决 → 重规划 → 毒集丢绿 + 半回滚 →
 * 后续修复轮全挂 → 终态 patch 0 字节。**已达标的交付被销毁**, 而回执上看不出它曾经绿过。
 *
 * 契约的达标条件是**与**不是或:「当前树判据绿」**且**「终态产物 diff 非空」——
 * 判据绿而 diff 空是"绿得很可疑"的那一格 (判据恒真 / 活根本没落盘), 同样要还原。
 *
 * ⚠ `terminalDiffFiles: undefined` = **取不到** (非 git 仓 / git status 抛), 不是 0。
 *   取不到时不许拿"diff 空"当理由去动盘 —— 还原是破坏性动作, 证据不足就不动。
 */
export function decideBestGreenFloor(input: {
  everGreen: boolean;
  currentGreen: boolean;
  terminalDiffFiles: number | undefined;
  snapshotFiles: number;
}): { action: BestGreenAction; label: string } {
  if (!input.everGreen) return { action: 'none', label: '' };
  const diffNonEmpty = input.terminalDiffFiles === undefined ? true : input.terminalDiffFiles > 0;
  // 没有绿快照 = **没有可比的地板**。这时判据仍绿就别喊狼: "判据绿而 diff 空"还有一条合法
  // 成因 (活已提交, diff 面量的是未提交改动), 而拿它去报"终态低于那次绿"是一次纯误报。
  // 判据真红那一侧照喊 —— 那时"低于绿"是事实, 只是还原不了。
  if (input.snapshotFiles === 0) {
    return input.currentGreen
      ? { action: 'already-green', label: `${BEST_GREEN_LABEL}: 终态树判据绿 — 棘轮不必动 (无绿快照可比)` }
      : {
          action: 'unrestorable',
          label: `${BEST_GREEN_LABEL}: 判据曾转绿而终态低于那次绿, 绿快照收不全 → **还原不了** (不假装交付达标)`,
        };
  }
  if (input.currentGreen && diffNonEmpty) {
    return { action: 'already-green', label: `${BEST_GREEN_LABEL}: 终态树判据绿且产物 diff 非空 — 棘轮不必动` };
  }
  return {
    action: 'restore',
    label: `${BEST_GREEN_LABEL}: 终态低于本 run 曾达到的绿 → 还原绿快照 (${input.snapshotFiles} 文件)`,
  };
}

/** INV-4 判据重建的留痕锚串 (契约 GWT-4 `.includes('criterion-rebuild')`)。 */
export const CRITERION_REBUILD_LABEL = 'criterion-rebuild';

/**
 * INV-4: 什么时候该去**改判据**而不是再烧一轮修复。
 *
 * 三条触发路 (或):
 *  ① 否决分型指向判据 (verifier 说的是「判据错了/可被游戏」, 见 verifier.ts 的 VER-4);
 *  ② 判据读数**纹丝不动**而 leaf 在产出 —— 连续 2 轮 exitCode 逐字相同, 且这两轮 leaf
 *    都写了东西。少了后半条就会把「执行侧压根没动」误读成「判据瞎了」(#4 那格的反面)。
 *  ③ #205 方向性探针读到 `green-before` (2026-09-05): 判据文件刚写出来、实装还没做的那一刻,
 *    判据就已经绿了 —— 它量的不是本次目标。同批读数: green-before 7 题 reward 均值 0.212 而
 *    全批 0.610, 假阳性 1/7。**只触发重建, 不判失败、不拦派发** (探针本身仍是 fail-open)。
 *    ⚠ 去掉 1-A ① (首发必须是单独写判据的 work) 之后, green-before 多了一种成因: 同一发里
 *    实装已经做完。这正是它只配当「去看看判据」而不配当「判失败」的理由。
 *
 * ⚠ exitCode 缺席 (`null` / `undefined`) **不算"逐字相同"**: 没记与记了 0 是两件事,
 *   拿两个 NULL 相等去开重建轮, 等于让"没观测到"变成一条证据 (仓规坑 ①)。
 *
 * 每 run 至多 1 次 —— 重建判据本身是**执行体家族**在提判据, 次数不封顶就成了移球门。
 */
export function shouldRebuildCriterion(input: {
  verdictTarget?: VerdictTarget;
  /** #205 方向性探针的结论 (orchestrating-loop 冻结那一刻跑, 记在 `loopLedger.criterionDirection`)。 */
  criterionDirection?: 'red-before' | 'green-before' | 'inconclusive';
  rounds: readonly { exitCode: number | null | undefined; touched: number }[];
  alreadyRebuilt: boolean;
}): { rebuild: boolean; reason: string } {
  if (input.alreadyRebuilt) return { rebuild: false, reason: '本 run 已重建过一次判据 (上限 1, 不再重建)' };
  if (input.verdictTarget === 'criterion') {
    return { rebuild: true, reason: 'verifier 否决分型 target=criterion (判据错了/可被游戏), 烧修复轮治不了' };
  }
  if (input.criterionDirection === 'green-before') {
    return { rebuild: true, reason: '#205 方向性探针 green-before: 判据在本次改动发生前就已经绿, 它量的不是本次目标' };
  }
  const [a, b] = input.rounds.slice(-2);
  if (
    input.rounds.length >= 2 &&
    a !== undefined &&
    b !== undefined &&
    a.exitCode !== null && a.exitCode !== undefined &&
    b.exitCode !== null && b.exitCode !== undefined &&
    a.exitCode === b.exitCode &&
    a.touched > 0 &&
    b.touched > 0
  ) {
    return {
      rebuild: true,
      reason: `连续 2 轮判据 exitCode 逐字相同 (${a.exitCode}) 而两轮 leaf 都有非空 diff (${a.touched}/${b.touched} 文件) — 判据量不出差别`,
    };
  }
  return { rebuild: false, reason: '未触发: 否决分型非 criterion, 且判据读数不是"两轮纹丝不动 + leaf 在产出"' };
}

/**
 * INV-4 后半: 重建出的判据**过了全部自证门才准冻结**。
 *
 * fail-**closed**: 一道门"没跑成"(`ran: false`) 与"跑了被拒"一样不准入。
 * 理由是这条判据的出身 —— 它是执行体家族提的, 而判卷标准必须是执行体动不了的东西;
 * 拿不到证明就照收, 等于给移球门开了一条合法通道 (与 classify 那侧探针的 fail-open
 * **刻意相反**: 那边审的是分类器给的判据, 这边审的是环内产出的判据)。
 */
export function criterionRebuildAdmission(
  gates: readonly { name: string; ran: boolean; reason: string | null }[],
): { admitted: boolean; why: string } {
  if (gates.length === 0) return { admitted: false, why: '一道自证门都没跑 — 空集不算"全过" (fail-closed)' };
  const notes = gates.map((g) => (!g.ran ? `${g.name}: 没跑成` : g.reason ? `${g.name}: ${g.reason}` : `${g.name}: 过`));
  const admitted = gates.every((g) => g.ran && g.reason === null);
  return { admitted, why: notes.join(' · ') };
}

/**
 * O1 (2026-09-06, 契约 `docs/plan/2026-09-06-墙钟与读次数-执行契约.md`): 判据重建自证门的**第三道 —— 仓内锚定**。
 *
 * ## 它补的那个洞 (实账)
 *
 * `runs/2026-09-06-e0-e1-e2/readout.md`: 自证门放行了 `test -f .omd/conductor-readonly-sentinel`。
 * 那条命令过得了前两道 —— `test` 在白名单里、空世界里它也真的红 —— 但它测的是**引擎自己在
 * `.omd/` 下留的哨兵**, 与这个仓要做的事没有一点关系。判据一旦锚在引擎产物上, 执行体只要
 * 碰一下那个文件就赢, 而 oracle 全绿。
 *
 * ## 三条判据
 *
 *  ① 不许引 `.omd/` —— 那是引擎的地盘, 不是这个仓的内容;
 *  ② 首词必须是这个仓真跑得起来的测试 runner (`envFacts.testCommandCandidates` 的首词) 或
 *     {@link ANCHOR_BINS} 那八个;
 *  ③ **有路径形参数时**, 至少一个要落在 `git ls-files` (含目录前缀) 或图里声明的产物集里;
 *     一个路径形参数都没有的**裸命令直接过**。
 *
 * ## ③ 为什么对裸命令放行 (2026-09-06 owner 裁, 修的是本闸首版写紧了)
 *
 * 首版要求"至少引一个仓内路径", 于是 `pytest -q` / `bun test` / `python3 -m pytest -q` 这类
 * **指向既有测试整跑**的判据全被拒。而那恰恰是 reward 最高的判据形态 (dsw 批 0.683) ——
 * 它锚在整个仓的既有测试上, 比任何单文件判据都难被执行体游戏。
 * 「裸命令会不会是空的」是**另一道门的问题**: 空世界自检问的正是"活还没干它就绿了吗",
 * 恒真的裸命令在那里红。两道门各答各的, 本门不许越界替它答 (答了就是两份判据, 迟早漂)。
 *
 * ⚠ 有路径形参数时 `git ls-files` **算不出来就拒**, 不是放行: 这条判据是执行体家族提的,
 * 拿不到"它真锚在仓里"的证明就不准冻结 (与 `criterionRebuildAdmission` 同一条纪律)。
 * 裸命令那一支压根不问 git —— 没有路径要核, 就没有"核不出来"这回事 (NULL ≠ 不适用)。
 *
 * falsify (本闸必须能真红): 去掉 `.omd/` 那一条 ⇒ criterion-rebuild.test.ts 的
 * 「`.omd/` 哨兵 ⇒ 拒」当场绿转红; 把③的 `pathTokens.length === 0` 早返回删掉 ⇒
 * 「裸 `pytest -q` ⇒ 过」当场红; 把③改成"有路径就过、不核 ls-files" ⇒
 * 「`pytest -q tests/ghost.py` ⇒ 拒」当场红。
 */
const ANCHOR_BINS: readonly string[] = ['pytest', 'python', 'python3', 'bun', 'npm', 'node', 'go', 'cargo'];

/**
 * 「这个 token 是不是一个路径形参数」—— 含 `/` · 以 `.py/.ts/.js/.go/.rs` 结尾 · 含 `::` 测试 id。
 * 判宽了会把 `-q` 之外的普通实参当路径去核 (误拒); 判窄了会放过 `tests/ghost.py` 这类幻觉路径 (漏检)。
 * 三条形态是**当前判据命令里真出现过的**那些, 不是穷举 —— 加形态时连同一条测试一起加。
 */
const LOOKS_LIKE_PATH_TOKEN = /\/|::|\.(py|ts|js|go|rs)$/;

export function repoAnchorBlockReason(
  command: string,
  opts: {
    root: string;
    envFacts: EnvFacts;
    declaredArtifacts: readonly string[];
    /** 注入口 (测试用)。缺省 = `git ls-files`; 返回 `null` = 算不出来 (不是 git 仓 / git 调不通), **与空数组是两件事**。 */
    lsFiles?: () => readonly string[] | null;
  },
): string | null {
  const c = command.trim();
  if (!c) return '[blocked repo-anchor: 判据命令为空]';
  if (/(^|[\s"'=/])\.omd\//.test(c)) {
    return (
      `[blocked repo-anchor: 判据引用了 \`.omd/\` 路径 —— 那是引擎自己的产物目录, 不是这个仓的内容。` +
      `锚在那里的判据, 执行体碰一下那个文件就赢 (实账: \`test -f .omd/conductor-readonly-sentinel\` 曾过了前两道门)。]`
    );
  }
  // ② 首词
  const firstWordOf = (s: string): string => {
    const w = s.trim().split(/\s+/)[0] ?? '';
    return w.includes('/') ? w.slice(w.lastIndexOf('/') + 1) : w;
  };
  const allowedFirst = new Set<string>([...ANCHOR_BINS, ...opts.envFacts.testCommandCandidates.map(firstWordOf).filter(Boolean)]);
  const bin = firstWordOf(c);
  if (!allowedFirst.has(bin)) {
    return (
      `[blocked repo-anchor: 判据首词 '${bin}' 不是这个仓的测试 runner。允许: ${[...allowedFirst].join(' / ')} ` +
      `—— 判据要跑这个仓的测试, 不是拿别的命令验一个副作用。]`
    );
  }
  // ③ 路径形参数在场时才核锚点; 裸命令 (整跑既有测试) 直接过。
  const norm = (p: string): string =>
    (p.split('\\').join('/').replace(/^\.\//, '').split('::')[0] ?? '').replace(/\/+$/, '');
  const pathTokens: string[] = [];
  for (const link of c.split('&&')) {
    for (const token of link.trim().split(/\s+/).slice(1)) {
      if (token.startsWith('-')) continue;
      if (LOOKS_LIKE_PATH_TOKEN.test(token)) pathTokens.push(token);
    }
  }
  if (pathTokens.length === 0) return null; // 裸整跑: 空洞与否由「空世界自检」那道门管, 不在这里越界替它答
  const tracked = (opts.lsFiles ?? (() => defaultLsFiles(opts.root)))();
  if (tracked === null) {
    return '[blocked repo-anchor: 算不出仓内文件清单 (不是 git 仓 / git 调不通) —— 拿不到"它锚在仓里"的证明就不准冻结 (fail-closed)]';
  }
  const anchors = new Set<string>();
  for (const f of tracked) {
    const n = norm(f);
    if (!n) continue;
    anchors.add(n);
    // 目录也算锚: `pytest -q tests/` 指的是仓里真实存在的那个目录。
    const parts = n.split('/');
    for (let i = 1; i < parts.length; i++) anchors.add(parts.slice(0, i).join('/'));
  }
  for (const a of opts.declaredArtifacts) {
    const n = norm(a);
    if (n) anchors.add(n);
  }
  if (pathTokens.some((t) => anchors.has(norm(t)))) return null;
  return (
    `[blocked repo-anchor: 判据点名了路径 ${pathTokens.join(' / ')}, 但它们一个都不在 \`git ls-files\` ` +
    `(含目录) 与图里声明的产物集里 —— 这条判据指向的东西这个仓里没有, 恒红。` +
    `要整跑既有测试就别带路径 (裸命令本门放行)。]`
  );
}

/** 缺省 IO: `git ls-files`。git 调不通 / 不是 git 仓 → `null` (**算不出来 ≠ 空仓**, §静默坑 1)。 */
function defaultLsFiles(root: string): readonly string[] | null {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    // fail-open 可以吞异常, 不许吞证据 (§静默坑 2): 返 null 让门 fail-closed 地拒, 原文进日志。
    logger.warn({ root, err: String(err instanceof Error ? err.message : err) }, '[run-goal] O1 仓内锚定: git ls-files 调不通 → 该门 fail-closed 拒');
    return null;
  }
}

/**
 * board 结算的**跨栈帧信物**(2026-08-26)。`runGoal` 的外壳靠它判断「claim 写了但 terminal 没写」。
 *
 * 为什么不是布尔:结算要写的两个坐标 (板根 / runId) 在 `runGoalInner` 里才算得出来,
 * 而 `finally` 在外壳。三个字段一起放进来,外壳就不需要重算任何东西 —— 重算一遍就是
 * 第二份判据,两份迟早漂 (本仓 S-7)。
 */
interface BoardSettleBox {
  /** 板根。`undefined` = claim 那一步还没走到 (那时无账可结)。 */
  root?: string;
  runId?: string;
  /** terminal 已经**尝试过**写 (成功与否都算)。见 emitBoard 里的赋值点注释。 */
  settled: boolean;
  /** 闸 C 本次取到的互斥锁 —— 外壳 finally 无条件释放 (不释放 = 下一次同 key 点火撞残锁)。 */
  locks?: string[];
}

/**
 * `runGoal` 外壳 —— 只做一件事:**保证 claim 过的 run 一定有 terminal 收尾**。
 *
 * ## 这里推翻了一条既有决定,理由写在这儿
 *
 * 原注(本文件旧版 584-585 行)写着:「异常抛不写 terminal:那不是 run 的终态,留下的
 * claimed 由 liveRuns 当活 run 显形 —— 板的工作是把它显出来,不是替引擎撒谎。」
 *
 * 那个意图是对的,**落法是错的**。悬空的 `claimed` 显出来的不是「引擎抛了」,是「还在跑」——
 * 判据只有 `claimed ∧ ¬terminal` 一条(dag-run-board.ts:122),没有心跳也没有年龄上限。
 * 两种状态被压成一个,正是本仓 §NULL ≠ 0 ≠ 不适用 要防的那件事。
 *
 * 实账(2026-08-26 清点):板上 12 条判为"在跑",最早 8.3 天,`ps` 里零个对应进程;
 * 而它们让此后**每一次**点火回执都打印一段假的撞车告警。异常不但没被显出来,还把
 * 真正的撞车检测淹掉了。
 *
 * 新落法:异常路照样写 terminal,但 outcome 是 `infra-error` 且带 `note` 标明是异常收尾 ——
 * 引擎 bug **比以前更显眼**(一行明确的判词, 而不是一条含义要靠猜的悬空 claim)。
 *
 * ## 它盖不住什么(诚实标注)
 *
 * `finally` 只覆盖**本进程还能跑代码**的退出:抛错、reject、正常返回。
 * `SIGKILL` / 断电 / 容器被回收 一律盖不住 —— 那几种仍会留下悬空 claim。
 * 要盖住它们得给 claim 行带 PID 或心跳,那是另一件事(跨容器时 PID 还没意义)。
 */
export async function runGoal(goal: string, config: RunGoalConfig): Promise<RunGoalResult> {
  // 互斥闸 (defense in depth): sddPath 与 playbook 同给 → 一次只能走一条。goal.ts handler
  // 那层先返 MCP 错; 这一层在 worker / CLI 直调路径上仍然兜底, 不让两个互斥入口同时过门。
  // 错误文案必须同时提到 sddPath 与 playbook (compile.test.ts (c) 的反向自检点)。
  if (config.sddPath && config.playbook) {
    throw new Error(`sddPath 与 playbook 互斥 (sddPath=${config.sddPath}, playbook=${config.playbook}) — 一次只能走一条`);
  }
  const box: BoardSettleBox = { settled: false };
  try {
    return await runGoalInner(goal, config, box);
  } finally {
    // 闸 C 互斥锁释放:终态(成/败/抛)都放, 否则残锁卡后来者到 STALE_LOCK_MS。
    for (const p of box.locks ?? []) {
      try {
        releaseDreamLock(p);
      } catch (e) {
        // 不许吞证据 (§静默坑 2): 放锁失败 = 残锁在盘上, 必须留一行可查。
        console.error(`[run-goal] 闸 C 锁释放失败 (残锁 ${p}): ${String(e)}`);
      }
    }
    if (box.root !== undefined && box.runId !== undefined && !box.settled) {
      try {
        appendBoard(box.root, {
          ...boardTerminalEntry(box.runId, 'infra-error'),
          note: 'uncaught: runGoal 抛出/被拒, 由外壳兜底结算 (不是 run 自己判的终态)',
        });
      } catch (e) {
        // 板不是承重墙(与 emitBoard 同款纪律)。但**不许吞证据**:兜底都写不进去,
        // 说明板本身坏了, 那比这一条 run 更要紧。
        console.error(`[run-goal] board 兜底 terminal 写失败: ${String(e)}`);
      }
    }
  }
}

/**
 * 闸 C 锁路径派生: 工件路径 → `.omd/locks/<key>-<净化全路径>.lock`。
 * 全路径进名字 = 同一工件跨进程得同一把锁 (互斥成立), 不同工件永不同名 (不误伤)。
 */
function lockPathFor(key: string, artifactPath?: string): string | undefined {
  if (artifactPath === undefined) return undefined;
  return join('.omd', 'locks', `${key}-${artifactPath.replace(/[^\w.-]+/g, '_')}.lock`);
}

async function runGoalInner(goal: string, config: RunGoalConfig, box: BoardSettleBox): Promise<RunGoalResult> {
  const stages: GoalStage[] = [];
  const sources: string[] = [];

  // SDD D4.2 (2026-09-01): 一次 run 一份 goal 文本 → 一次提取全程复用。
  // 空 goal / 无命中 → `[]`, 行为与今日逐字节同 (INV-3)。
  // 与 `goal-protections.ts` 的纯函数定义配套: 词表扩/形态变都走那边。
  const goalProtectedPaths = extractProtectedPaths(goal);

  // ── t-gate-inmigrate (2026-09-01): 三道机械前置闸直调 (闸 A 冻结 / 闸 B 座位 / 闸 C 互斥) ─
  // 必须在 `loadSddContract` 之前 (SDD INV-4) —— 坏契约要烧任何 token 之前被拒, 闸拒同档严度。
  // ⚠ box 在这里**刻意不钉**:既有不变量「claim 之前抛 → 板上零条目 (外壳不许凭空造 terminal)」
  // (run-goal.test.ts) 覆盖闸拒 —— 闸在烧 token 之前拒, run 没「点过火」, 板上不该有它;
  // 拒因走 IgnitionBlockedError(message 带判词)与调用方退出码, 不走板。
  const boardRunId = config.tickets?.runId ?? config.dag.continuity?.runId ?? config.dag.sessionId ?? randomUUID();
  const boardRoot = config.dag.continuity?.repoRoot ?? config.cwd;
  // 默认配置兜底:调用方未传三字段 → 从 `<cwd>/.omd/preflight.json` 读;再缺席 → 闸段缺席。
  const defaultCfg = loadPreFlightConfig(config.cwd);
  const preflightOpts: {
    force?: boolean;
    freezeCheck?: FreezeCheckOpts;
    seatExpectations?: Record<string, string>;
    exclusiveLocks?: ExclusiveLocksOpts;
  } = {
    freezeCheck: config.freezeCheck ?? defaultCfg?.freezeCheck,
    seatExpectations: config.seatExpectations ?? defaultCfg?.seatExpectations,
    // exclusiveLocks 默认从 config.resultOut / config.sddPath **派生锁文件路径**
    // (.omd/locks/ 下, 与 extended 测试的约定一致)。⚠ 不许把工件路径本身当锁:
    // 闸 C 用 O_EXCL 创建锁文件, sddPath 指向的契约文件本来就存在 → 永远误判「撞锁」。
    exclusiveLocks: config.exclusiveLocks ?? {
      resultOut: lockPathFor('resultOut', config.resultOut),
      sddPath: lockPathFor('sddPath', config.sddPath),
    },
    ...(config.force !== undefined ? { force: config.force } : {}),
  };
  // 写集传空:闸 A/B/C 不依赖写集。② 写集相交 / ③ 已结晶 advisory 由 MCP 工具面
  // (`goal.ts:991-996`) 另行调用, 此处不重跑 (SDD INV-4 ④)。
  const entryPreflight = ignitionPreflight(boardRoot, [], preflightOpts);
  if (entryPreflight.verdict === 'blocked') {
    // 闸拒 → 抛 IgnitionBlockedError。板上零条目 (claim 之前抛不造 terminal, 既有不变量);
    // 拒因走异常 message 与调用方退出码。blocked 路径的锁已由 ignitionPreflight 自退。
    throw new IgnitionBlockedError(entryPreflight);
  }
  // 闸 C 取到的锁交外壳 finally 释放 (终态成/败/抛都放)。
  if (entryPreflight.acquiredLocks?.length) box.locks = [...entryPreflight.acquiredLocks];

  // 直通装载放在**一切之前** (G-2): 坏契约要在烧任何 token 之前被拒。
  const sdd = config.sddPath ? loadSddContract(config.sddPath) : undefined;
  // playbook-direct (2026-09-04): 与 sddPath 同处装载 (fail-loud: 未知名抛错列已知名); 互斥闸在 runGoal 入口。
  const playbookLoaded = config.playbook ? loadPlaybookForGoal(config.cwd, config.playbook) : undefined;
  let specPath: string | undefined = sdd?.path;
  let evidence = sdd?.text ?? '';
  let repoContext = '';
  // #209: 契约段这一位走的是**哪条路**。默认值恒被下面 `if (sdd)` 分支改写 (D-26/D-27: 门控
  // 换成 sddPath 之后无 sdd 就落 'loop'), 初值只是给类型一个起点, 不代表真发生过的路径。
  // 契约段收尾时一次性发给 `onContract` —— 只有一个发射点, 于是新增分支漏发时 tsc/测试看得见。
  let specSource: SpecWriteSource = 'loop';

  // ── S4: run 生命周期接线 (board = 协调介质, 不是真源; D-3/INV-1) ────────────────
  // 点火 → claimed (带声明写集, 相对路径, 与 sdd-direct 写集列同物); 终态 → terminal。
  // runId 锚与 D-2 散雾出口同一条解析序 (tickets → continuity → sessionId); 全缺 → 本跑
  // 自产一个 (claimed/terminal 仍配对, 只是没有外部回执锚)。写集与终态在别处都有真源
  // (SDD 声明 / RunGoalResult), 板只记指针 —— 不把历史唯一信息只写 board。
  // 异常抛 (classify/onClassified 这类引擎 bug) **也写 terminal**, 但走 `infra-error` +
  // `note: uncaught` —— 由 `runGoal` 外壳的 finally 兜底。改这条的理由与它盖不住的边界
  // (SIGKILL / 断电) 见 runGoal 的文档注。
  /**
   * claim 行的写集。**未注入就是缺席, 不兜底常量**(2026-08-26)。
   *
   * 旧版是 `config.writeSet?.declared ?? SDD_DECLARED_WRITE_SET` —— 那个常量
   * (`write-set.ts:139`) 是 **2026-08-10 那一份 SDD 自己的写集**, 与本 run 毫无关系。
   * 后果是每一条没注入写集的 claim 都声称自己要写
   * `src/harness/** + docs/silent-failures.md + docs/plan/2026-08-10-cairness-distill-report.md`;
   * 实账里 12 条僵尸 claim 的写集**逐字节相同**, 于是撞车告警每次都说同一句话, 信息量是零。
   *
   * `dag-run-board.ts` 头注 19-27 行早就立了这条纪律 (dag_run 路 claim 时刻意不写 writeSet
   * 字段而不是写 `[]`, 因为「没声明」与「声明了空集」是两件事)。goal 路当时违反了它,
   * 而且更糟 —— 不是写空集, 是写**别人的**集合。
   */
  const boardDeclared = config.writeSet?.declared;
  // #160 D-1 (s1): 板根钉主仓状态锚。branch 档 run 的 config.cwd 是 worktree (产物树),
  // 板落那里 = 主仓 (生产侧 + ignition 预检 + readout 全读者) 看不到这张 run; 钉到
  // continuity.repoRoot → 主仓。head 档 (repoRoot 缺席或 = cwd) 行为逐字节不变 (INV-1)。
  // (boardRoot/boardRunId 的声明已随 t-gate preflight 前移到本函数顶部;box 的钉定仍在
  //  下方 S4 段 —— 闸拒在 claim 之前, 板上零条目是既有不变量, 外壳 finally 不替闸拒造 terminal。)
  // F1 (片 2, 接线位): notify 配置的读法 —— `<root>/.omd/config.json`, 缺席返 null
  // (notify.ts 内部把 null 转成静默 no-op, INV-1)。与 assemble.ts 的 ownerNotifySink 内
  // 默认读法**逐字节一致** —— 两通道共用 .omd/config.json (主仓层面的 owner 意图)。
  const readConfigTextFromRoot = (root: string): string | null => {
    try {
      const p = join(root, '.omd', 'config.json');
      if (!existsSync(p)) return null;
      return readFileSync(p, 'utf8');
    } catch (err) {
      // exists 过了 read 还抛 = 竞态/权限/IO; 吞掉就再也分不清「真缺席」与「读挂了」(§静默坑 2)。
      logger.warn({ err: String(err) }, '[run-goal] 读 notify config 失败 → 按未配处理');
      return null;
    }
  };
  const emitBoard = (event: 'claimed' | 'terminal', outcome?: RunOutcomeKind): void => {
    // **写之前**就记账: appendBoard 抛错时 emitBoard 自己吞掉 (板不是承重墙), 那时外壳的
    // finally 再补一发也只会同样失败, 而且会把同一条 run 的 terminal 写成两行。
    // 「尝试过」才是 box 要记的语义, 不是「写成功了」。
    if (event === 'terminal') box.settled = true;
    try {
      const entry: BoardEntry =
        event === 'claimed'
          ? {
              v: 1,
              ts: new Date().toISOString(),
              runId: boardRunId,
              event,
              // 三态: 注入了 → 真写集; 未注入 → **字段缺席** (判不了交集), 见 boardDeclared 的注。
              ...(boardDeclared ? { writeSet: [...boardDeclared.allowed] } : {}),
            }
          : boardTerminalEntry(boardRunId, outcome!);
      appendBoard(boardRoot, entry);
      // F1 (片 2, INV-6 / INV-9): 终态发生 → 推一次 owner 通知。**在板写之后** (板是事实层, 通知
      // 是告知层, 后者依赖前者的真值)。fail-open: notifyOwner 自身吞异常留证据, 这里 try 不替它
      // 再包一层 (避免把证据覆盖掉)。未配置 notify → 全程 no-op, 行为与 s1 冻结的 INV-1 一致。
      if (event === 'terminal') {
        notifyOwner(
          { event: 'terminal', runId: boardRunId, at: new Date().toISOString(), outcome: outcome!, headline: outcome! },
          { readConfigText: () => readConfigTextFromRoot(boardRoot) },
        );
      }
    } catch (e) {
      // 板不是承重墙: 写板失败不掀桌, 留日志, run 照跑 (与 saveState 同款纪律)。
      console.error(`[run-goal] board ${event} 写失败 (不影响 run): ${String(e)}`);
    }
  };
  // 信物先装, claim 后发 —— 反过来的话, claim 写成功而装信物之前抛, 外壳就兜不住那一条。
  box.root = boardRoot;
  box.runId = boardRunId;
  emitBoard('claimed');

  // ── 闸 C: 续跑状态读写 (无 continuity = 无 runId 可锚 → 闸不启用, 行为与从前逐字一致) ──
  const continuityRunId = config.dag.continuity?.runId;
  const statePath = continuityRunId ? join(config.cwd, '.omd', 'continuity', continuityRunId, 'goal-state.json') : undefined;
  const goalHash = createHash('sha256').update(goal).digest('hex');
  let prior: GoalPhaseState | undefined;
  if (statePath && existsSync(statePath)) {
    try {
      const j = JSON.parse(readFileSync(statePath, 'utf8')) as GoalPhaseState;
      if (j.goalHash === goalHash) prior = j;
    } catch (e) {
      // fail-open 但留证据 (本仓铁律 2): 读坏了照常重跑契约段, 不吞原因。
      console.error(`[run-goal] goal-state 读失败 (照常重跑契约段): ${String(e)}`);
    }
  }
  // 最后一次写盘的内容。判据回写 (INV-4) 要以它为底做**合并**, 不能拿 run 开头读到的
  // `prior` 当底 —— 契约段收尾时 (:1307) 又存过一次, 拿 prior 当底会把那次的 contract 冲掉。
  let lastSaved: GoalPhaseState | undefined;
  const saveState = (s: GoalPhaseState): void => {
    if (!statePath) return;
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(s));
      lastSaved = s;
    } catch (e) {
      console.error(`[run-goal] goal-state 写失败 (下次续跑将重跑契约段): ${String(e)}`);
    }
  };

  // ── S0/S-classify: 轻重路由 (D-5, 成本轴) + **验收分型** (D-I, 判据轴) ──────────
  //
  // 一次调用出两条轴。显式配置各自压过分类结果 —— 但 `tier` 只压成本轴, 压不到判据轴:
  // "我知道这活儿轻" 与 "我知道这活儿怎么判" 是两句不同的话, 说了前一句不等于说了后一句。
  // ⚠ `generate` 必须**回落到引擎的默认实现**, 不能只读 config.dag.generate ——
  // 后者是**注入口** (测试传 fake), 生产从来不设它 (`runExecutorDag` 自己 `?? makeDefaultGenerate`)。
  // 只读它的后果是: 生产每一次 dag_goal 都拿不到分类器 → 静默降级成探索型 → **D-I 的执行型验收
  // (那条强制可跑命令) 在真实路径上从未成立过**。2026-07-30 第一次 live 冒烟才看见这行:
  //   「验收分型未成立: 无分类器 (缺 generate/model)」
  // ——机制在、测试全绿、生产零生效, 正是这仓一直在杀的空旋钮形态, 而这次空掉的是防作弊的地基。
  // 闸 C: goal 未变的续跑直接用上次的分类 (探针首跑已验过; 重分类 = 重烧一遍还可能分出不同的判据轴)。
  //
  // 勘察先于分类 (2026-09-05, D-3): 分类之前跑一次**零 LLM 只读勘察** (README / 既有测试清单 /
  // goal 点名的标识符在仓里的位置), 把仓内契约线索原样喂进那一发。判据写错方向的根因是
  // **输入缺失** —— 分类器此前只看得见 goal 文本, 于是它把判据指向自己编出来的新文件, 而真契约
  // (README 里逐字写着的输出键名 / 仓里已经在测这些键的用例) 它从来没读到过。
  // ⚠ 只在**真分类**这条路上跑: 注入 `_classify` 的调用方自己定判据, 闸 C 复用时那一发压根不发 ——
  // 两条路都没有"勘察给谁看"的对象。缺席 (undefined) 与"跑了三段全空"(全 0) 是两件事。
  // ── W3 (2026-09-06): runner 就绪预检 —— 一次, 分类之前 ────────────────────────
  //
  // 治的读数 (契约 §0 末段): `env-install` 步与「No module named pytest」在多题各自出现 ——
  // 每一题都在自己那一轮里发现 pytest 没装、自己去装一遍。那是**环境事实**, 属于点火前的
  // 一次性预检, 不该由每个执行体各花几轮去摸。
  //
  // ⚠ **默认只记不装**: 装别人的依赖是改环境。`OMD_ENSURE_TEST_RUNNER=1` (bench 的 version yaml
  // 会开) 才真装; 其余取值 (含缺席/空串) 一律只记事实, 产品路径逐字节同旧。
  // ⚠ 这一份 `envFacts` 下面 O1 仓内锚定门直接复用 —— 同一趟 run 里那道门与本预检必须看同一份事实,
  // 各探一遍就会在「pytest 装没装」这件事上给出两个答案。
  const envFacts = probeEnvFacts(config.cwd);
  const runnerReady = ensureTestRunner(envFacts, config.cwd, {
    install: process.env.OMD_ENSURE_TEST_RUNNER?.trim() === '1',
  });
  logger.info({ ...runnerReady, root: config.cwd }, '[run-goal] W3 runner 就绪预检 (installed 缺席 = 没试过装, false = 试了没成)');
  let survey: CriterionSurvey | undefined;
  let surveyError: string | undefined;
  /**
   * R7 规格包 (契约 `docs/plan/2026-09-07-规格包-上游对齐与需求枚举-执行契约.md`)。
   * 缺席 = 开关没开 / 走的不是真分类那条路 (注入式 `_classify` / 闸 C 复用) —— 与
   * 「算了但一份采样都没成」(在场且 `samples: 0`) 是两件事 (§静默坑 1)。
   */
  let specPack: SpecPack | undefined;
  /** 按 goal 召回 (2026-09-11): 与规格包同一条注入口, 缺席 = 没开。 */
  let goalRecall: GoalRecall | undefined;
  const classified = prior
    ? prior.classified
    : await (config._classify ??
      (async (g: string) => {
        try {
          survey = surveyForCriterion(g, config.cwd);
        } catch (e) {
          // fail-open 但留证据 (仓规静默坑 2): 勘察炸了照常分类, 只是这一发少一段证据。
          surveyError = String(e);
          logger.warn({ err: surveyError, root: config.cwd }, '[omd/goal] 分类前勘察失败 → 本次不带仓内契约线索');
        }
        // ── R7 规格包: 动手前的上游对齐 + 需求枚举 (D-1 / D-2) ───────────────────
        //
        // 位置在**分类之前**是硬要求, 不是顺手: 判据共识的那 3 发就在下面这一行发出去,
        // 而 D-6 要它们照规格包的 `interfaces` 写符号名 —— 排在分类之后就永远赶不上那趟车。
        // 同一份 `text` 稍后 (loopSurveyPack 那一处) 追加到勘察包末尾, conductor 面与 work
        // 子节点也读它 —— **一次生成, 一份文本**, 不新开第二个注入口 (D-1)。
        //
        // `generate` 必须回落到引擎默认实现: `config.dag.generate` 是测试注入口, 生产从来不设
        // (2026-09-06 author-cons 臂 80/80 题量了个空, 就是只读注入口那一次)。
        // 座位 = **执行座** (`agent` 座由装配层解析进 agentLeafModel/leafModel), 不换家族 ——
        // R4 换家族已判负, 这一发要的是"执行侧自己对上游的记忆", 换座反而换掉了那份记忆。
        if (specPackEnabled()) {
          const specGenerate = config.dag.generate ?? makeDefaultGenerate(config.dag.sessionId ?? randomUUID());
          specPack = await buildSpecPack(g, survey?.text ?? '', {
            generate: async ({ model, prompt }) =>
              (await specGenerate({ messages: [{ role: 'user', content: prompt }], model, traceName: 'goal:spec-pack' })).text,
            model: config.dag.agentLeafModel ?? config.dag.leafModel,
          });
        }
        // 按 goal 召回一次 (2026-09-11, `OMD_GOAL_RECALL=1`): 与规格包同款, 生成一次、一份文本, 挂勘察末尾。
        if (goalRecallEnabled()) {
          goalRecall = await buildGoalRecall(g, config.cwd);
          logger.info({ ...goalRecall.facts }, '[omd/goal] 按 goal 召回引擎记忆 (线索段)');
        }
        // 勘察空手且规格包缺席 ⇒ 整段不传, 那一发的 prompt 与加这一段之前**逐字相同** (INV-4)。
        // 规格包在场时挂在勘察正文**末尾** —— 与它稍后进勘察包的位置一致, 两处读到的是同一段文本。
        const surveyForClassify = [survey?.text, specPack?.text, goalRecall?.text].filter((t) => t !== undefined && t !== '').join('\n\n');
        return classifyGoal(g, {
          generate: config.dag.generate ?? makeDefaultGenerate(config.dag.sessionId ?? randomUUID()),
          model: config.dag.conductorModel,
          // **空世界自检** (2026-07-31, G4): 活还没干之前先跑一遍判出的验收命令 —— 这时候就过 =
          // 它区分不了"做完了"与"还没做"。给不给 runner 决定这层加固在不在, 与 `generate` 那条
          // 教训同源: 只在测试里接、生产不接, 就是又一个"机制在、生产零生效"的空旋钮。
          ...(config.dag.commandRunner ? { runCommand: config.dag.commandRunner } : {}),
          // #204 (承 #199 D1): 判别力探针的反面世界要建成**真仓副本**才量得到判别力 —— 不给
          // repoRoot 它就退回空目录, 而空目录里任何仓内判据都必然失败 ⇒ 探针恒判「分得出」
          // (账本读数: 真跑过的 69 跑里它红过 0 次)。这一行就是那条 wire。
          repoRoot: config.cwd,
          // 勘察空手 (三段全空) 时不传 —— 那一发的 prompt 与加这一段之前逐字相同 (D-2)。
          ...(surveyForClassify ? { survey: surveyForClassify } : {}),
          // Web oracle (2026-09-11, 契约 D-3): spec 落到 .omd/acceptance/web-oracle.json, 命令指向引擎 runner。
          materializeWebOracle: (spec) => writeWebOracleSpec(config.cwd, spec),
        });
      }))(goal);
  // 探针裁决钩子: 分类定稿后恰好调一次 (含 fallback / 探索型), 进 `_runDag` 与任何运行记录之前。
  // `_classify` 抛错时这行到不了 → 天然不调, 不存在"抛错也硬调"的路径。
  config.onClassified?.(classified);
  const tier = config.tier ?? classified.tier;
  // ── 直通档判据来源 (2026-08-11, run 7d50fda2 修): 有 SDD 就从**它的 verify 列**推 ────────
  //
  // 分类器只看得见 goal 文本, 看不见 SDD —— 让它去编一条测试命令, 编出来的路径就是幻觉
  // (那次: SDD 写 `src/harness/board/run-board.test.ts`, 它编成 `src/harness/dag/…`)。
  // 而这条命令同时是 accept 节点、冻结判据 (freezeCriterion) 与基线 delta 的那一条,
  // 于是整个判据轴挂在一个 SDD 里根本不存在的路径上。SDD 已经写明这个 run 要跑哪些测试,
  // 判据就该从那儿来。显式 config.acceptance 仍压过一切 (调用方比 SDD 更知道自己在干嘛)。
  const sddAcceptance = sdd ? sddDerivedAcceptance(sdd) : undefined;
  // playbook 自带 acceptance.command (装载时已过 A-3 判别力闸): 判据从它来, 分类器看不见 playbook 文档, 让它编只会编出幻觉路径。
  const playbookAcceptance: AcceptanceSpec | undefined = playbookLoaded
    ? { kind: 'executable', command: playbookLoaded.pb.acceptance.command, expectExit: 0 }
    : undefined;
  const acceptance = config.acceptance ?? sddAcceptance ?? playbookAcceptance ?? classified.acceptance;
  // T-2 (F2 收尾): 「有没有一条别人来跑的命令」在下面被问 10 次。此前每处各写一遍
  // `acceptance.kind === 'executable'` —— 那是**守卫式 `if` 没有 else**, `assertNever`
  // 那道闸够不着 (诚实边界写在 harness/exhaustive.ts 文件头), 于是加第四格时这 10 处
  // 一个都不会编译红。问一次、下面全读这一个绑定:新增分型只需在 `acceptanceCommand`
  // 那个穷尽 switch 里表态一次, 漏表态即编译错误。
  // ⚠ `null` 不是「跑不起来」, 是「这一型本来就不靠命令判」(见 acceptance-shape.ts)。
  const runnable = acceptanceCommand(acceptance);
  stages.push({
    stage: 'classify',
    // 判成执行型却拿不到可跑命令时, 分类器已降级成探索型 (acceptance.ts 的 fallbackExploratory)
    // 并把原因写进 learningGoal —— 这里把它抬成 stage 摘要, 别让降级只活在日志里。
    status: 'done',
    // 分类器降级 (判执行型却拿不到可跑命令) **不记 empty-result**: 它照样产出了一份可用的判据轴,
    // 只是换了一型。记成"空手而归"会让读数板把一次正常的探索型分类数成缺陷。
    outcome: 'success',
    summary:
      // F2: 三格各印各的。此前是 `executable ? A : B` 的**二值**分支, B 恒等于探索型 ——
      // 加第三格之后那个恒等式破了, 而 `.learningGoal` 在 rubric 上不存在, tsc 当场点名。
      // 三格各印各的 → 收敛进 describeAcceptance 一处 (判卷标准分两处写, 两处就会漂,
      // 而摘要正是人第一眼看「这次拿什么判的」)。
      `tier=${tier} · 验收=${describeAcceptance(acceptance)}` +
      // 判据换了来源要在摘要上看得见: 分类器编的那条与 SDD verify 列的差距, 正是 7d50fda2
      // 那次幻觉路径唯一能被人一眼看出的地方 (它当时只活在图里, 摘要上什么都没写)。
      (acceptance === sddAcceptance ? ' · 判据取自 SDD verify 列 (非分类器)' : '') +
      // 勘察读数上摘要 (D-3): 摘要是人第一眼看的地方, 「这次分类看到了什么」不该只活在 prompt 里。
      // 缺席 = 没跑勘察 (注入式分类器 / 闸 C 复用), 与"跑了三段全空"分得开 (仓规静默坑 1)。
      (survey
        ? ` · 勘察: README ${survey.facts.readme ? '是' : '否'} · 测试文件 ${survey.facts.testFiles} · 标识符 ${survey.facts.terms}/${survey.facts.termHits} 命中${survey.why ? ` · 勘察失败: ${survey.why}` : ''}`
        : '') +
      (surveyError ? ` · 勘察失败: ${surveyError}` : '') +
      (prior ? ' · 复用续跑前分类 (goal 未变, 闸 C)' : ''),
  });
  // 闸 C: 分类一定稿就落状态 (契约段中途炸也不用重分类; 契约段成了再补 contract 字段)。
  if (!prior) saveState({ goalHash, classified });
  // 冻结的判卷标准: 同一份文本进 spec 起草与 execute 任务文本 (两处各写一份就会漂,
  // 而"判据漂了"正是作弊达标最舒服的入口)。
  const acceptanceBlock = renderAcceptance(acceptance);

  if (sdd) {
    // ── S0.5–S3 契约段 (D-G′, 2026-07-29 → D-26/D-27 2026-09-02 改门控) ──────────────
    //
    // ⚠ 契约段(survey/research/spec)的唯一触发换成了 `sddPath` (INV-11) —— `tier` 不再门控
    // 这一段。旧的「complex 档且无 sddPath → 自动展开 conductor 子图勘察/调研/起草一份 SDD」
    // 整体撤销 (D-26/S6a): 循环 (S6b) 接手无 sddPath 的默认执行路径, 不再需要提前转录一份契约。
    // `tier` 仍是分类输出与读数字段 (座位/预算仍读它), 但从今往后只压成本轴, 压不到这条判据轴。
    //
    // 闸 C: 契约段产物在且 goal 未变 → 直接复用, 不重新走直通逻辑。
    // specPath 记了但盘上文件没了 → 条件不成立, 掉进下面照常走 sdd-direct (状态不是真源, 盘上文件才是)。
    const priorContract = prior?.contract;
    // D-27 闭包: 复用分支判据是 `sdd 在场 且 priorContract 命中`, 必须**排在 sdd-direct 之前**——
    // 外层已经判过 `sdd` 为真, 若把 sdd-direct 分支放在前面 (旧写法的分支顺序), sdd-direct 恒先
    // 命中, 复用分支就变成永远够不着的死代码 (旧默认下产过 spec 的续跑既不复用也不重跑)。
    if (priorContract && (!priorContract.specPath || existsSync(priorContract.specPath))) {
      specSource = 'reused';
      // P1 回流修正 (review 264df08b, 2026-09-02): sdd 在场时 specPath/evidence 禁止被旧契约
      // 顶掉 —— sdd-direct 本身已是零转录 (survey 跳过), 用上一轮的旧正文覆盖本轮新 sddPath 会让
      // execute 任务文本挂着"按下面这份 SDD 契约实施"的措辞却塞进旧内容, 新 sdd 被静默吞掉。
      // 只并入不与 sdd 冲突的旧勘察增量 (repoContext/sources); specPath/evidence 仍取本轮 sdd
      // (已在 :1194/:1195 初始化为 sdd.path / sdd.text, 这里不再赋值)。
      repoContext = priorContract.repoContext;
      sources.push(...priorContract.sources);
      stages.push({
        stage: 'survey',
        status: 'done',
        outcome: 'success',
        summary: `复用续跑前契约段勘察增量 (闸 C): ${repoContext ? `${repoContext.split('\n').length} 行仓内事实` : '首跑无勘察输出'}`,
      });
      stages.push({ stage: 'research', status: 'skipped', outcome: 'not-needed', summary: '复用续跑前契约段 (闸 C): 不重新调研' });
      stages.push({ stage: 'spec', status: 'done', outcome: 'success', summary: `SDD 直通 + 闸 C 勘察复用: ${sdd.path}` });
    } else {
      specSource = 'sdd-direct';
      // 直通 (G-1): 契约已结晶 —— 不勘察不调研不转录, SDD 全文 (含并行波形) 原样进 execute。
      stages.push({ stage: 'survey', status: 'skipped', outcome: 'not-needed', summary: 'SDD 直通: 契约已结晶, 不勘察' });
      stages.push({ stage: 'research', status: 'skipped', outcome: 'not-needed', summary: 'SDD 直通: 不调研' });
      stages.push({ stage: 'spec', status: 'done', outcome: 'success', summary: `SDD 直通 (零转录): ${sdd.path}` });
    }
  } else {
    // INV-11: 无 sddPath → 三个 stage 全部 skipped, specSource 如实记 'loop' (D-27) ——
    // 不区分 tier, 不区分 agentRunner 有没有配 (那道区分是旧「自动转录」分支才需要的, 契约段
    // 本身在这条路上已经不跑, 缺不缺 agentRunner 不再改变这三格的落点)。
    specSource = 'loop';
    stages.push({ stage: 'survey', status: 'skipped', outcome: 'not-needed', summary: '契约段唯一触发是 sddPath (D-26/D-27): 无 sddPath → 不勘察' });
    stages.push({ stage: 'research', status: 'skipped', outcome: 'not-needed', summary: '契约段唯一触发是 sddPath (D-26/D-27): 无 sddPath → 不调研' });
    stages.push({ stage: 'spec', status: 'skipped', outcome: 'not-needed', summary: '契约段唯一触发是 sddPath (D-26/D-27): 无 sddPath → 不产 spec (specSource=loop)' });
  }

  // ── #209: 「契约段有没有产出 spec 文件」在**这一刻**记账 ──────────────────────────
  // 这一位的原料是执行期事实 (契约段那张图的 filesTouched → 上面的 `wrote` → specPath),
  // **不是** `existsSync`。隔离档跑完 worktree 就被清、分支合进 main 后新增也归零 ——
  // 事后再问这一位就只剩 NULL, 而 NULL 会被念成"没写入磁盘" (#177 那次连错三次的根因)。
  // 回调不给 = 一行不多跑 (INV-1); 抛错只留痕不掀桌 —— 记账挂了不该让整趟 goal 陪葬。
  const specWrite = classifySpecWrite(specSource, specPath);
  try {
    config.onContract?.(specWrite);
  } catch (err) {
    logger.warn({ specWrite, err: String(err) }, '[run-goal] #209 spec 写入磁盘记账回调抛错 → 该跑这一列留 NULL (不影响执行)');
  }

  // ── S5-S8 Execute + Verify + 1 轮修复: 内层 DAG 的外层 fixpoint。
  // task = spec 全文 (有则) 否则 goal 本身; 执行器读到的是契约, 不是对话。
  //
  // D-I: 判卷标准**无条件**附在任务文本末尾 —— 包括 simple 档 (它不产 spec, 判据没有别的落点)
  // 与 spec 未写入磁盘的降级路径。conductor 据它把验收命令连成图里一个 executor:'command' 节点;
  // 探索型则据它知道"这次没有机器判据"从而不去伪造一个。
  const body = specPath
    ? sdd
      ? // 直通模式 (G-6 探针实测抓的洞): specPath 是**基座树**路径, 渲染进 prompt 会让 leaf
        // 把它当仓根 → 绝对路径写出隔离树 (bwrap 里自检还"成功", 产物闸才拦住)。
        // 改念执行根, 契约全文内联 —— leaf 的世界里只有 worktree。
        `按下面这份 SDD 契约实施 (执行根: ${config.cwd} —— 一切相对路径以它为准, 禁止写到执行根之外):\n\n${evidence}`
      : `按下面这份 SDD 契约实施 (契约全文已写入磁盘 ${specPath}):\n\n${evidence}`
    : evidence
      ? `${goal}\n\n参考材料:\n${evidence}`
      : goal;
  const task = `${body}\n\n${acceptanceBlock}`;
  // 成因由**调用点**给, 不在这里按 summary 文本猜 —— 猜就是又一处会漂的独立判断 (P1 为它付过账)。
  const bail = (summary: string, outcome: RunOutcomeKind): RunGoalResult => {
    stages.push({ stage: 'execute', status: 'failed', outcome, summary });
    emitBoard('terminal', outcome);
    return { goal, tier, acceptance, stages, ...(specPath ? { specPath } : {}), sources, repoContext, converged: false, rounds: 0, reusedNodes: [], outcome };
  };
  // ── 内环 v2 切片 5 (SDD 2026-08-11-inner-loop-v2 D-1): 直通 v2 —— 分解表可编译时零 conductor ──
  // 平铺图 = 切片×(RED/实装/GREEN) + accept (D-4 定向 TDD); accept 命令 = 冻结判据同一条命令,
  // D-3 停止规则合一。仅执行型验收可平铺: 探索型没有确定性停机判据, 平铺图会跑完即止无人判。
  //
  // D3 / INV-D3-1 接线: 平铺图编译块的 fatal/fallback 判定**走 dryRunSddIgnition**
  // (与 goal.ts 的 `sddIgnitionDryRunGate` 同源 —— 抄一份必漂, 漂的后果是「点火闸放行、
  // worker 里照样回落」恰是本契约要消灭的病)。**判定同源, 实装执行各管各的**:
  //   · dryRunSddIgnition(纯函数, 毫秒级, 零 IO) → 判 fatal/fallback/ok
  //   · run-goal 在 ok 之后才 parseBreakdown/compileBreakdown **第二次** (拿 slices/nodes 用),
  //     O-6 探针是另一回事 (要跑真命令, 属 run-goal 领地; INV-D3-5「空跑就是空跑」)
  //
  // D3 / INV-D3-4 sddPath 禁回落: 平铺图编译块 (`if (sdd && ...)`) 内部任何**回落条件**
  // 命中 (parseBreakdown 抛 / compileBreakdown 抛 / O-6 探针判虚), 一律 fail-fast 终态 + 原
  // 因原文进回执, 不再落 v1 conductor 铺图 (owner 2026-08-25 裁: 「v1 回落是要避免的结局,
  // 不是要预告的结局」; 回落 v1 会让叶子重写已完成的实装, 静默失效的真凶之一)。
  // 非 sddPath 入口: 本块整体不进 (外层 `if (sdd && ...)` 守门), 行为逐字节照旧 —— 这是
  // 「非 sddPath 入口本就没承诺平铺图」的逻辑必然, 不算回归。
  let flatPlan: ConductorPlan | undefined;
  let flatFallback: string | undefined;
  let flatParallelism: string | undefined;
  // playbook-direct (2026-09): 与 sdd-direct 同族的"零契约段"入口。playbook 名 → 编译出
  // 平铺图 (compilePlaybook), survey/research/spec 三段零展开零重画 —— 三段以 skipped 形态
  // 入 stage 表, summary 写明原因 (与 sdd-direct 同形态)。execution 段照常跑这份 flatPlan。
  // **不**走 O-6 探针 / 不写回路复用 —— compilePlaybook 自带 acceptance.command 的判别力探针,
  // 与 sdd-direct 的 sddIgnitionDryRunGate 不是同一道闸, 但目的一致 (判据不虚)。
  let playbookSource: 'builtin' | 'project' | undefined;
  if (playbookLoaded) {
    const { pb, root, source } = playbookLoaded;
    playbookSource = source;
    const planName = `playbook-${pb.name}`;
    flatPlan = await compilePlaybook(pb, { cwd: config.cwd, playbookRoot: root, name: planName });
    const skipSummary = 'playbook-direct 直通: 契约段零展开';
    stages.push({ stage: 'survey', status: 'skipped', outcome: 'not-needed', summary: skipSummary });
    stages.push({ stage: 'research', status: 'skipped', outcome: 'not-needed', summary: skipSummary });
    stages.push({ stage: 'spec', status: 'skipped', outcome: 'not-needed', summary: skipSummary });
  }
  /** S-46 缺片闸的判据面 —— 只在直通v2真编译成功时有值 (回落 conductor 铺图时切片不是执行单位)。 */
  let flatSlices: readonly SddSlice[] | undefined;
  /** #242 resume 复用的片号 (O-6 探针裁的「verify 当前已绿」那批) —— S-46 判缺片时豁免。 */
  let flatReusedSlices: ReadonlySet<number> | undefined;
  /**
   * **L1 路径走过的标** (SDD 2026-08-31, D-6 / INV-4)。SDD-direct 那条路 flatPlan 也赋值,
   * 但它**不**走升档协议 (契约已结晶, 无所谓升档); 升档只在 L1 (无 SDD ∧ flat-first opt-in
   * 走平铺) 上才需要。下面这一个是这两条路在「要不要升档」这步上的**唯一**区别。
   */
  /** P3 S6b: 编排循环路径的图 (回灌时按同一张图 append finding 重跑)。v1 / chain / flat-first 梯子已退役 (owner 2026-09-03)。 */
  let loopPlan: ConductorPlan | undefined;
  /** R-1 账本 (循环路径才用; 两跑合并)。 */
  const loopLedger: ConductorCardLedger = createConductorCardLedger();
  /** 循环装配的宿主面 (loop-run.ts 与 `run` 入口共用同一份装配, D-5)。 */
  const loopHost: LoopHost = { cwd: config.cwd, dag: config.dag, ...(config._runDag ? { runDag: config._runDag } : {}) };
  if (sdd && runnable) {
    // INV-D3-1: 同一份判定 —— fatal / fallback 与 goal.ts `sddIgnitionDryRunGate` 共用。
    const ignition = dryRunSddIgnition(sdd.text);
    if (ignition.kind !== 'ok') {
      // INV-D3-4: sddPath 触发任何回落条件 → fail-fast 终态, 不落 v1。原因原文进回执与
      // 日志, owner 拿它改契约或换 verify 后可重跑 (force 越闸也救不了 worker 内的回落 —
      // force 只在 goal.ts 闸那一层放过, 进了 worker 就是执行体自身的责任)。
      const reason = ignition.kind === 'fatal' ? ignition.err : ignition.reason;
      const tagged = `[INV-D3-4 fail-fast] ${ignition.kind}: ${reason}`.slice(0, 240);
      logger.warn(
        { sdd: sdd.path, kind: ignition.kind, reason },
        '[run-goal] INV-D3-4: sddPath 平铺图点火闸判定非 ok → fail-fast 终态 (不回落 v1)',
      );
      return bail(`sddPath 平铺图点火闸判定非 ok (${ignition.kind}): ${reason.slice(0, 200)}`, 'not-converged');
    }
    // ignition.kind === 'ok' —— 编译必定过; 剩下 O-6 探针是另一个**回落条件** (INV-D3-4 例)。
    try {
      const breakdown = parseBreakdown(sdd.text);
      const compiled = compileBreakdown(breakdown, {
        acceptCommand: runnable.command,
        ...(runnable.expectExit !== undefined ? { acceptExpectExit: runnable.expectExit } : {}),
        name: 'goal-execute-flat',
        // T-1b (S-51): 这里是**唯一**同时拿得到契约全文与编译器的地方 —— 编译器只吃
        // `SddBreakdown` (分解表的结构), 决策段与契约不变量根本不在它的入参里。
        // 锚进节点 → 进 `nodeFieldsKey` → 进语义指纹 → T-1a 的规格守卫在 resume 时比得着:
        // 改了决策段而节点逐字节不变的那一格 (S-51), 到这里才第一次有东西看得见。
        specAnchor: specAnchor(sdd.text),
      });
      // O-6 (2026-08-11 二发教训): RED 的前提是切片 verify 在**实装前是红的** —— 引用既有绿
      // 测试文件时结构性不成立 (旧测试全绿, RED 期望 1 得 0, 整图白跑一轮才发现)。有 commandRunner
      // 就逐片探一枪 (acceptance.ts 的 vacuous 纪律推广到切片级): 已绿 = 判据虚 **或** 活已干完,
      // 两种机械分不开, 都不该进平铺 —— 抛给 fail-fast (INV-D3-4: sddPath 不落 v1)。
      // 没 runner = 闸缺席 (fail-open, 测试/无命令能力档), 行为同今天。
      //
      // #242 (run 7f9c511a 复盘): 「已绿 = 判据虚」这条推理**只属于首次编图**。resume 是
      // 「活干到一半接着跑」, 切片 verify 当前绿在这条路上就是活已干完 —— 含「owner 人工修绿
      // verify 后 resume」这条合法路径。修前这里必抛 → 整图静默回落 conductor → 回落图叶子
      // 重写已完成实装 (23 节点把 live-children.ts 整套换 API 覆盖)。修后: resume 时已绿切片
      // 视为已达成, 实装节点降为 command 重验 (见下方节点映射) —— 不给 agent 任何重写机会;
      // verify 仍红的切片照常进图重跑 (settled=done 而判据在当前树上不成立 = 本来就该重做)。
      //
      // ── 2026-08-28 修:`resuming` 这个代理退役 ────────────────────────────────
      //
      // #242 拿 `continuity.resume === true` 当「这活可能已经干过」的代理, 而**代理选窄了**:
      // 活干完的原因还有人手做的、另一个窗口做的、上一跑用别的 runId 做的。
      // 实账 2026-08-28: F2 的片 1-3 由人做完提交后拿母契约点火, `resuming === false`,
      // 逃生门不适用 → 整图被拒, 而活确确实实干完了。
      //
      // 补一条 git 可查的证据 (`goal/slice-delivery.ts`): 契约入库之后本片写集被动过没有。
      // ⚠ 它是**并列**的第二条证据源, 不是替代: `resuming` 照旧先判 —— #242 那份回归用例
      // 跑在临时目录里拿不到 git 证据, 换掉 resume 会让它当场回落 (实测红过一次)。
      // 三格不压平: 动过 = 已交付(跳过); 没动过 = 判据虚(拒); 取不到证据 = 没能去看(也拒,
      // 但判词分得开)。判定与取证都是具名件, 这里只负责喂与执行结论。
      /** verify 已绿且有交付证据的切片 (实装节点降为 command 重验, 不判 vacuous)。 */
      let achievedSlices = new Set<number>();
      if (config.dag.commandRunner) {
        const probes: SliceProbe[] = [];
        for (const s of breakdown.slices) {
          const probe = await config.dag.commandRunner({ command: s.verify });
          probes.push({
            id: s.id,
            verify: s.verify,
            writeSet: s.writeSet,
            verifyGreen: probe.exitCode === 0,
          });
        }
        const gitExec = config.gitExec ?? defaultGitExec(config.cwd);
        const resuming = config.dag.continuity?.resume === true;
        const decision = decideO6(probes, (sp) =>
          collectSliceGitEvidence(config.sddPath ?? '', sp.writeSet, gitExec, resuming),
        );
        if (decision.kind === 'reject') {
          // ⚠ 判词首段**必须是静态字面量**且与闸登记表逐字一致 —— gate-registry 扫的是
          // run-goal.ts 源码里那一整串 (INV-1/4/7: id 找得到、原文非空无换行、整串仍在本文件)。
          // 2026-08-28 实测: 把整句搬进 slice-delivery.ts 只留插值, 对账闸 4 条当场红。
          // 动态的那半 (哪一片、凭什么判) 追加在后面, 不动首段。
          // ⚠ 这一整串**必须与闸登记表逐字一致且连续** (gate-registry.test.ts 的 INV-7:
          //    `[run-goal][o6-vacuous-verify] 切片 ${s.id} 的 verify 实装前已绿` 要能在本文件
          //    里被 `includes` 原样找到)。所以这里回头取真切片、变量仍叫 `s` ——
          //    2026-08-28 实测: 我把它拆成拼接字面量并改了变量名, 那条绊线当场红。
          //    它是在正确地拦我: 改闸的判词形状而不同步登记面, 正是它守的那件事。
          const s = breakdown.slices.find((x) => x.id === decision.sliceId);
          throw new Error(
            `[run-goal][o6-vacuous-verify] 切片 ${s?.id ?? decision.sliceId} 的 verify 实装前已绿: RED 无法成立 —— ${decision.message}`,
          );
        }
        achievedSlices = new Set(decision.achieved);
        // 放行也要留痕: 「跳过了哪几片、凭什么」不留下来, 事后没人分得清
        // 「引擎判它已交付」与「引擎压根没跑到它」。
        // ⚠ 前缀**不许写成双段方括号形状** (即 run-goal 后面再跟一个方括号 id) ——
        //    闸登记对账扫的正是那个形状; 连这条注释都不能把它写成字面量, 否则注释自己被扫成
        //    一个未登记的新闸 (2026-08-28 实测: 我写了个 xxx 举例, 对账当场多出一个 id)。一行普通日志
        // 会被当成一个未登记的新闸 id (2026-08-28 实测: 扫出 19 个 id 而表里 18 个, 3 条对账红)。
        // 这不是闸的判词, 是放行时的留痕, 所以写成单段前缀。
        for (const n of decision.notes) logger.info({ runId: continuityRunId }, `[run-goal] O-6 交付判定: ${n}`);
      }
      // 编译器刻意不内联 SDD 全文 (token 注入由接线方裁, 见 sdd-compile 头注): 这里给每个
      // **切片实装节点**前置与 conductor 路径同源的契约上下文 (G-6 教训: 内联全文, 不引用
      // 基座路径); RED/GREEN/accept 是 command 节点, 不读文本, 不背这份 token。
      //
      // #242: resume 已达成切片的实装节点降为 command 重验 —— id/deps 一字不动 (代数签名只含
      // goal+nodeIds+deps, 绿节点复用不作废), 但 executor 从 agent 换成跑同一条 verify 的确定性
      // 节点: 即使 checkpoint 因 owner 人工改文件而 hash 失配, 重跑的也是一条只读命令, 不是一只
      // 会重写写集的 agent。
      const sliceByNodeId = new Map<string, SddSlice>(breakdown.slices.map((s) => [`s${s.id}`, s]));
      flatPlan = {
        ...compiled,
        nodes: Object.fromEntries(
          Object.entries(compiled.nodes).map(([id, n]) => {
            const s = sliceByNodeId.get(id);
            if (s && achievedSlices.has(s.id)) {
              return [id, {
                executor: 'command',
                command: s.verify,
                expect_exit: 0,
                depends_on: n.depends_on ?? [],
                output_type: 'none',
                goal: `切片 ${s.id} resume 复用: verify 当前已绿 → 重验确认, 不重做实装 (#242)`,
              }];
            }
            return [id, n.executor === 'agent' ? { ...n, goal: `${body}\n\n${n.goal}` } : n];
          }),
        ),
      } as ConductorPlan;
      // 并行性 advisory (owner 2026-08-11): 只报不拒 —— 假串行点名给结晶期审问, 假并行归乱序闸。
      flatParallelism = describeParallelism(parallelismReadout(breakdown));
      // 赋值放在编译成功**之后**: 编译不过就回落 conductor 铺图, 那时切片只是给人读的,
      // 拿它去判缺片会对每一次回落都造一片假红。
      flatSlices = breakdown.slices;
      flatReusedSlices = achievedSlices;
    } catch (err) {
      // O-6 vacuous-verify 抛 / compileBreakdown 重算时异常 (理论上不会发生 — ignition 已过 —
      // 但保留兜底) —— 任何回落条件命中 = sddPath fail-fast (INV-D3-4)。
      const msg = String(err instanceof Error ? err.message : err).slice(0, 240);
      flatFallback = `[INV-D3-4 fail-fast] ${msg}`;
      logger.warn(
        { sdd: sdd.path, err: msg },
        '[run-goal] INV-D3-4: sddPath worker 触发回落条件 (O-6 vacuous-verify 等) → fail-fast, 不落 v1',
      );
      return bail(`sddPath worker 触发回落条件 (O-6 vacuous-verify 等): ${msg}`, 'not-converged');
    }
  } else if (flatPlan === undefined) {
    // playbook-direct 已编出平铺图时不进这里 (否则下面 `loopPlan ?? flatPlan` 让循环压过平铺图, 编译产物永远不跑)。
    // 证伪 (playbook/compile.test.ts e2e): 把这个守卫改回 `else` → 假引擎收到的是 goal-orchestrating-loop 而不是 playbook-* 图, 那条红。
    // ── P3 S6b 编排循环 (契约 D-1 / D-14 / D-17 / D-20; 2026-09-02) ─────────────────────
    //
    // 默认路径。图 = `conductor` (agent, 七张派工卡 + ≤8k 常驻 prompt, 只读手) → `accept` (冻结判据原文;
    // 无可执行判据时缺席, 那时终审是唯一判官)。**不要求 runnable**: 探索型 / rubric 型也走循环 ——
    // 它们此前走 v1 conductor, 而 v1 的内环 judge 与 30k 画图 prompt 正是 P3 要撤的东西。
    // 子图执行与终审恰一次的机械在下面 execCfg (leafFace / maxEscalations:0) 与 exec 之后的回灌段。
    const compiledLoop = compileOrchestratingLoop({
      goal: task,
      ...(runnable
        ? { acceptance: { command: runnable.command, expect_exit: runnable.expectExit ?? 0 } }
        : {}),
      ctx: conductorCtxOf(loopHost, runnable),
      // 编排节点坐 conductor 座 (owner 2026-09-03): 它就是 conductor, 不是 worker。
      ...(config.dag.conductorModel ? { conductorModel: config.dag.conductorModel } : {}),
    });
    loopPlan = compiledLoop;
    logger.info(
      { nodes: Object.keys(compiledLoop.nodes), acceptance: runnable !== null },
      '[run-goal] P3 编排循环 → conductor 节点 + 机械 oracle (D-17; v1 / chain / flat-first 梯子已退役, 这是 solve 唯一的非 SDD 路径)',
    );
  }
  // v1 规划式 conductor 回落图已退役 (owner 2026-09-03): solve 只剩 sdd-direct (flatPlan) 与编排循环 (loopPlan) 两条路。
  if (loopPlan === undefined && flatPlan === undefined) return bail('没有可执行的图 (sdd-direct 与编排循环都没编出图)', 'infra-error');
  const execPlan: ConductorPlan = (loopPlan ?? flatPlan)!;
  // ── D-1 (SDD cairness-distill): mode 感知基线 delta —— 跑批前存基线、跑后比对 ──────────
  // 基线 = 批前用同一份 commandRunner 跑一次验收命令 (与 accept 节点同 runner、同白名单闸);
  // 只把「新引入失败」判红, 基线里就在的老失败 (unchanged-failure) 单列不红 (INV-4)。
  // fail-open: 没配 runner (测试/无 command 能力) → 闸缺席; 抛错也缺席, 但不吞证据 (INV-1)。
  // ⚠ S-37: 基线**只存退出码那一格是不够的** —— 基线红在本仓是常态, 而 fail→fail 判
  //   unchanged-failure 会把真回归一起赦免。所以同时存 `(fail)` 名字集, 判据降到一条测试。
  let baselineSide: AcceptSide | undefined;
  if (runnable && config.dag.commandRunner) {
    try {
      // SDD 片 2 (D-1): 基线只跑末环 —— 直通档验收命令按 sdd-compile.ts:373-380 规定为
      // 「各片 verify 串联 && 末环全量」, 批前跑整条必停在第一环 ugrep 的反作弊条款上,
      // 基线失败集空 ⇒ makeBaselineWaiver fail-closed 返 null ⇒ 赦免恒失效。
      // 末环按构造是去掉路径的全量回归, 跑它量到的就是仓当下真实的存量红。
      const bl = await config.dag.commandRunner({ command: baselineCommandOf(runnable.command) });
      baselineSide = acceptSideOf(bl.exitCode === (runnable.expectExit ?? 0) ? 'pass' : 'fail', bl.text);
    } catch (err) {
      // 记**真跑的那条** (末环), 不是验收命令原串 —— fail-open 可以吞异常, 不许吞证据:
      // 记错命令会让排查的人拿一条根本没跑过的命令去复现。
      logger.warn(
        { command: baselineCommandOf(runnable.command), acceptCommand: runnable.command, err: String(err) },
        '[run-goal] D-1 基线跑不起来 → 闸缺席 (fail-open)',
      );
    }
  }
  // ── INV-1 / INV-4 的观察面: 判卷官那一刻的树 (2026-08-29 否决边契约) ────────────────
  //
  // 内环封在 conductor 节点里, 跑完只剩最后一轮的结果面 —— 而 INV-1 (终态不得低于曾达到的绿)
  // 与 INV-4 (连续两轮判据纹丝不动) 问的都是**中间那一轮**。引擎每轮跑完调一次 verifier,
  // 那一刻树还是那一轮的样子: 这是 run-goal 唯一够得着中间轮的钩子。
  //
  // 只观察不改判 —— 原 verdict 原样返回, verifier 缺席 = 整段缺席 (行为逐字节不变)。
  // 观察本身抛错也不许掀桌 (fail-open), 但每个 catch 留一行证据 (仓规静默坑 ②)。
  const roundObs: { exitCode: number | null | undefined; touched: number; green: boolean }[] = [];
  let lastVerdict: { pass: boolean; reason: string; target: VerdictTarget } | undefined;
  let greenSnapshot: { round: number; files: { path: string; content: string }[] } | undefined;
  /** INV-7 读数: 这一趟真调 verifier 的次数 (闸红短路 / verifier-error 不经这里, 它们不是一次判卷)。 */
  let verifierCalls = 0;
  // ── D-1 / D-7 证伪测试 (`OMD_VERIFIER_FALSIFY=1` 才开, 默认关) ────────────────────
  //
  // 终审换了家族, 但**没换证据来源**: 它判的仍是我们自己写的那条判据。这一步让一个没看过
  // 我们判据的异族座, 只读「原指令 + 勘察段 + 盘上 diff」写 ≤3 条可跑的测试, 由引擎机械跑 ——
  // 判词变成退出码, 相当于对「隐藏测试会查什么」做第二次独立采样 (D-2 刻意不给判据命令与判据文件:
  // 给了就等于让第二次采样复用第一次的盲点)。
  //
  // **位置** = 终审 `inner` 之前 (D-1「环收敛后、终审之前」): 引擎只在图跑完那一刻调终审,
  // 所以进到 tap 里就已经是环收敛之后了。**红不直接判死** —— 走 D-14 回灌一轮 (下方)。
  // 开关关着 ⇒ 整段一次都不执行, 卷面与 ledger 逐字节同旧 (INV-4)。
  let falsify: FalsifyLedger | undefined;
  /** 首跑那份计划与 runner —— 回灌后要重跑**同一组** (换一组等于换了把尺子, 前后不可比)。 */
  let falsifyPlan: FalsifyPlan | undefined;
  let falsifyRunner: string | undefined;
  /** 首跑判红时的 finding 正文 (挂掉的测试全文 + 输出尾); 缺席 = 没红。 */
  let falsifyFinding: string | undefined;
  const falsifyOn = process.env.OMD_VERIFIER_FALSIFY === '1';
  /** 一个 inconclusive 读数 —— 「什么都没量到」的四种成因共用这一格, 靠 `why` 分辨 (§静默坑 1)。 */
  const falsifyNothingMeasured = (written: number, why: string): FalsifyLedger => ({ written, ran: 0, status: 'inconclusive', failing: [], reinjected: false, why });
  const runFalsifyRound = async (): Promise<void> => {
    try {
      // D-1: 没有可跑 runner 就不花那一发座位钱 —— 写出来也跑不了。
      const candidates = probeEnvFacts(config.cwd).testCommandCandidates;
      if (candidates.length === 0) {
        falsify = falsifyNothingMeasured(0, '跑不起来: 这个仓探不出任何验收命令候选 (probeEnvFacts.testCommandCandidates 为空)');
        return;
      }
      // 盘上改动 = 引擎自己跑 git 取的事实, 不是执行体自述 (与终审卷面同一个来源)。
      const diffText = renderDiffEvidence(config.cwd).text;
      const r = await (config._falsifySeat ?? send)({
        model: resolveRoleModel('verifier'),
        // 与终审同族同座, 但**另记一格**: 并进 'verifier' 桶就答不出「证伪这一步烧了多少」。
        meta: { role: 'verifier-falsify' },
        messages: [{ role: 'user', content: buildFalsifyPrompt({ task, ...(survey?.text ? { survey: survey.text } : {}), ...(diffText ? { diff: diffText } : {}) }) }],
        maxTokens: 8192,
        responseSchema: FALSIFY_PLAN_SCHEMA,
      });
      const validated = validateFalsifyPlan(r.parsed);
      if ('error' in validated) {
        falsify = falsifyNothingMeasured(0, `写不出: ${validated.error}`);
        return;
      }
      const runner = pickRunner(candidates, validated);
      if (runner === undefined) {
        falsify = falsifyNothingMeasured(validated.tests.length, `跑不起来: 候选 [${candidates.join(' · ')}] 里没有跑得了这份计划的 runner`);
        return;
      }
      const res = runFalsifyTests(validated, config.cwd, runner, config._falsifyRun ? { run: config._falsifyRun } : {});
      falsifyPlan = validated;
      falsifyRunner = runner;
      falsify = { written: validated.tests.length, ran: res.ran, status: res.status, failing: res.failing, reinjected: false, ...(res.why ? { why: res.why } : {}) };
      if (res.status === 'red') falsifyFinding = renderFalsifyFinding(validated, res, runner);
      logger.warn({ status: res.status, ran: res.ran, failing: res.failing, why: res.why }, '[run-goal] D-7 证伪测试跑完 (红只回灌一轮, 不直接判死)');
    } catch (err) {
      // fail-open: 这一步坏了不许改终态 —— 但原文既进 why 也进日志 (仓规静默坑 2)。
      falsify = falsifyNothingMeasured(0, `跑不起来: 证伪那一步抛错 ${String(err).slice(0, 240)}`);
      logger.warn({ err: String(err) }, '[run-goal] D-7 证伪那一步抛错 → inconclusive (fail-open, 终态不变)');
    }
  };

  const tapVerifier = (inner: VerifierFn): VerifierFn => async (req) => {
    verifierCalls++;
    // D-1: 证伪跑在终审之前, 每 run 至多一轮 (`falsify` 已在场 = 这趟跑过了)。
    if (falsifyOn && loopPlan !== undefined && falsify === undefined) await runFalsifyRound();
    // 1-A: 判据文件冻结的引擎记录随卷 (D-5 按调用真值): 判卷时刻重算 hash 对照冻结值, 判卷官据此不再把
    // 「测试文件是本 run 写的」读成 target=criterion。没冻过 → 不注入, 卷面同旧。
    // R4 (D-6): 判据是异族座写的就多印一格「作者=异族座 X」 —— 1-B 否决判据时这条要一起出现,
    // 否则终审只能按"判据是执行体自己出的题"那套读它。没采纳 ⇒ 不印 (今天的路径, 卷面同旧)。
    const criterionAuthorModel = loopLedger.criterionAuthor?.accepted ? loopLedger.criterionAuthor.model : undefined;
    const freezeTruth = loopLedger.criterionFreeze ? renderCriterionFreezeTruth(loopLedger.criterionFreeze, config.cwd, criterionAuthorModel) : null;
    const withFreeze = freezeTruth ? { ...req, truths: { ...(req.truths ?? {}), criterionFreeze: freezeTruth } } : req;
    // D-2 (2026-09-04): 派发子图机械记录 (filesTouched / done / 写集对账 / 盘上存在 / git 状态) 随卷, 与 loop-run 同一跳。dispatches 空 → 同一个 req, 卷面同旧。
    const verdict = await inner(withDispatchEvidence(withFreeze, loopLedger.dispatches, { cwd: config.cwd }));
    try {
      const acc = req.results.accept;
      const green = acc?.status === 'done';
      const touchedPaths = collectTouchedPaths(req.results, config.cwd);
      roundObs.push({ exitCode: acc?.exitCode, touched: touchedPaths.length, green });
      // 分型缺席 ⇒ 按 'implementation' 读 (切片 2 的 VER-4 fail-open, 逐字同 verifier.ts)。
      lastVerdict = { pass: verdict.pass, reason: verdict.reason, target: verdict.target ?? 'implementation' };
      if (green) {
        const files = readSnapshotFiles(touchedPaths);
        // 收不全 = 不留快照 (半份还原比不还原更坏: 树会变成两轮的混合体)。
        if (files) greenSnapshot = { round: roundObs.length, files };
        else logger.warn({ round: roundObs.length, paths: touchedPaths.length }, '[run-goal] INV-1 绿快照收不全 → 这一轮不留快照 (半份还原比不还原更坏)');
      }
    } catch (err) {
      logger.warn({ err: String(err), round: roundObs.length }, '[run-goal] INV-1/INV-4 轮观察抛错 → 这一轮没观测 (fail-open, 不吞证据)');
    }
    return verdict;
  };
  // ── R4 异族座先写判据 (契约 `docs/plan/2026-09-06-异族先写判据-执行契约.md`) ────────────
  //
  // 治的病: 1-A 只留边界之后判据文件由**执行侧首次写出** —— 在会局部修的座位上等于让考生自己出题
  // (R2 现场: gold 改 2 文件, M3 只改 1 个, 自写判据去测辅助函数, 引擎判它成)。断言内容是任何
  // 机械闸都够不到的地方, 所以治法是**换出题人**, 不是再加一道闸。
  //
  // 位置: 分类定稿之后 (判据已知)、装配 conductor 面之前 (它要拿到"已经写好了"这句话)。
  // W1 勘察包在这里算一次: 出题人要它当输入, 装配面也要它 —— 同一份传下去, 不算两遍。
  let loopSurveyPack = loopPlan !== undefined ? buildLoopSurveyPack(conductorGoalOf(loopPlan, task), config.cwd) : undefined;
  // R7 (D-1): 规格包**追加到勘察包末尾**, 不新开注入口 —— 于是 conductor 面与每个 work 子节点
  // (`withLoopConfig` → `buildConductorFace` 的 `surveyPack`) 和 R4 出题人的 `surveyText`
  // 全都读到同一段文本, 与上面进共识 prompt 的那一段逐字相同。
  // 规格包缺席 ⇒ 这一步整个不动, 勘察包逐字节回到加它之前 (INV-4)。
  // ⚠ 开着开关时 `loop.surveyPack.chars` **含规格包那一段** (它就是真发出去的字节数);
  // 规格包自己那半在 `loop.specPack.chars` 上单列, 两个数相减即勘察包本身 —— 别把涨的那部分
  // 读成"勘察变大了" (加尺子必然让数难看那一条)。
  if (loopSurveyPack && specPack?.text) {
    // 勘察包本身空手时不补前导空行 —— 空壳头行会让对照臂的字节数无端变化。
    const text = loopSurveyPack.text === '' ? specPack.text : `${loopSurveyPack.text}\n\n${specPack.text}`;
    loopSurveyPack = { ...loopSurveyPack, text, facts: { ...loopSurveyPack.facts, chars: text.length } };
  }
  // 记忆线索同上 (2026-09-11): 追加到勘察包末尾, conductor 面与 work 子节点读同一段。`loop.goalRecall.chars` 单列。
  if (loopSurveyPack && goalRecall?.text) {
    const text = loopSurveyPack.text === '' ? goalRecall.text : `${loopSurveyPack.text}\n\n${goalRecall.text}`;
    loopSurveyPack = { ...loopSurveyPack, text, facts: { ...loopSurveyPack.facts, chars: text.length } };
  }
  // D-9 开关: 默认关 (先当单变量臂)。⚠ 只有显式 `cross` 才开, 其余取值 (含缺席/空串/'1') 一律照旧,
  // 存量行为逐字节不变 —— 那是对照臂能成立的前提。
  if (loopPlan !== undefined && runnable && process.env.OMD_CRITERION_AUTHOR?.trim() === 'cross') {
    // D-1: 只对**不存在**的判据文件。指向既有测试的判据不动 (那一类 reward 最高)。
    const missingFiles = missingPathArgs(runnable.command, config.cwd);
    const author = missingFiles.length ? config._authorCriterion ?? productionCriterionAuthor(config) : undefined;
    if (!missingFiles.length) {
      // 三态 (§静默坑 1): 开关开着但不适用 (判据指向既有文件) 也要留一格, 与「没开」分得开。
      loopLedger.criterionAuthor = { attempted: false, accepted: false, why: 'not-applicable: 判据不引用未存在文件' };
    }
    if (author) {
      try {
        loopLedger.criterionAuthor = await author({
          goal,
          command: runnable.command,
          expectExit: runnable.expectExit ?? 0,
          missingFiles,
          root: config.cwd,
          surveyText: loopSurveyPack?.text ?? '',
          conductorModel: config.dag.conductorModel,
        });
      } catch (err) {
        // fail-open: 换出题人是一次尝试, 不是前置条件 —— 它坏了就退回今天的路径 (§静默坑 2: 不吞证据)。
        logger.warn({ err: String(err) }, '[run-goal] R4 异族出题者抛错 → 退回执行侧自写 (读数记 attempted)');
        loopLedger.criterionAuthor = { attempted: true, accepted: false, why: `出题者抛错: ${String(err).slice(0, 240)}` };
      }
    }
    const authored = loopLedger.criterionAuthor;
    if (authored?.accepted && authored.files?.length) {
      // D-5 冻结: `frozenAtDispatch: 0` = 任何派发之前就冻上了。`initFreezeState` 从 `hashes` 恢复
      // 保护 (不是从 `frozenAtDispatch`), 于是**首发**的子 run 就在 withProtectedPaths 里跑。
      const hashes: Record<string, string | null> = {};
      for (const f of authored.files) hashes[f] = hashArtifact(join(config.cwd, f));
      loopLedger.criterionFreeze = { files: [...authored.files], frozenAtDispatch: 0, hashes };
      logger.info({ model: authored.model, hashes }, '[run-goal] R4 异族座判据已冻结 (frozenAtDispatch 0) → 执行侧只能让它过');
    }
  }
  // Web oracle 预冻结 (契约 D-3, 2026-09-11): spec 在分类期已物化 ⇒ loop-run 的 `missingPathArgs` 看它「已存在」不会冻,
  // 于是按 R4 同款在派发前冻上 (frozenAtDispatch 0): worker 改判据 = 移球门, 工具面当场拒。
  // ⚠ 放在 R4 那个 `OMD_CRITERION_AUTHOR === 'cross'` 块**外面** —— 首版放在里面, 默认关的开关让它一次也没跑 (活体探针 0ac9c5c0 日志无冻结行)。
  if (loopPlan !== undefined && classified.webOracle?.path && !loopLedger.criterionFreeze) {
    const f = classified.webOracle.path;
    loopLedger.criterionFreeze = { files: [f], frozenAtDispatch: 0, hashes: { [f]: hashArtifact(join(config.cwd, f)) } };
    logger.info({ file: f }, '[run-goal] web oracle spec 已冻结 (frozenAtDispatch 0) → 执行侧只能让页面过它');
  }
  let exec: ExecutorDagResult;
  /** P3 S6b: 循环路径第二跑 (D-14 回灌) 的 config 基座 = 第一跑的 execCfg (含 freezeCriterion.waiveRed 等), 不是裸 config.dag。 */
  let loopBase: ExecutorDagConfig = config.dag;
  try {
    // 护栏③: **只有可执行判据**才进环。非可执行判据的 `oracleOk` 恒 true, 给了它就等于第一轮必停。
    // 环外那个 `accept` 节点保留不动 —— 它仍是收尾时那次权威判定 (`oracleOk` 的取值源没变),
    // 环内这份只负责"能不能早点停", 两者判的是同一条命令, 不会给出相反的结论。
    // S-37 下沉 (D-3, goal 层半): baselineSide 算出来了就把闭包挂进 freezeCriterion.waiveRed,
    //   引擎在红点 (D-K 节点命令判红 / 环内冻结判据) 调用。缺席 → 闸缺席, 行为逐字节不变 (INV-1)。
    const waiveRed = baselineSide !== undefined ? makeBaselineWaiver(baselineSide.failSet) : undefined;
    const execCfg =
      runnable
        ? {
            ...config.dag,
            freezeCriterion: { command: runnable.command, ...(runnable.expectExit !== undefined ? { expectExit: runnable.expectExit } : {}), ...(waiveRed ? { waiveRed } : {}) },
            // SDD 2026-08-22 「冻结判据在重规划轮里并不冻结」, C-3/INV-6:
            // 只在 flatPlan 编译成功**之后**挂上 `accept` 钉点 — 回落 conductor 铺图
            // 那条路上 accept 由 run-goal 自己构造在环外 (今天的 v1 行为, 不动)。
            // 这里 `flatUsed` 还**没**赋值(线 1008 才赋), 用 `flatPlan !== undefined` 等价判。
            ...(flatPlan !== undefined ? { frozenNodes: ['accept'] } : {}),
            // 平铺图确定性重规划 (SDD 2026-08-22 「平铺图确定性重规划」, C-3/INV-6/INV-7):
            // 只在 flatPlan 编译成功**之后**挂上 `deterministicReplan`。回落 conductor
            // 铺图那条路上图是 conductor 跑出来的, 不是 `compileBreakdown(SDD)` 的产物
            // — 不传这条, 走今天逐字节相同的升级路径 (INV-4 零回归那一半)。
            // 传的是同一份编译产物 (`compileBreakdown` 是纯函数, 重算与复用等价; INV-7)。
            ...(flatPlan !== undefined ? { deterministicReplan: () => flatPlan } : {}),
            // playbook 的 loop.maxRounds (整套步骤最多跑 N 轮) 映射成升级轮数: 引擎今天对平铺图只有「原图 + finding 重跑」
            // 这一种重跑, N 轮 = 首跑 + N-1 次重跑, 上限 4 (solve maxRounds 上限)。缺席 = 沿用 config.dag 的缺省。
            ...(playbookLoaded?.pb.loop ? { maxEscalations: Math.max(0, Math.min(playbookLoaded.pb.loop.maxRounds, 4) - 1) } : {}),
          }
        : config.dag;
    loopBase = execCfg;
    // 包一层判卷官 (只观察不改判); 没配 verifier = 一个字段都不加, 同一份 execCfg 原样进。
    const tappedCfg = config.dag.verifier ? { ...execCfg, verifier: tapVerifier(config.dag.verifier) } : execCfg;
    // ── P3 S6b: 循环路径的引擎 config ─────────────────────────────────────────────
    //   · maxEscalations: 0 —— 终审判红**不开**升级重规划轮 (D-14: 重试单元不再是整图重画);
    //   · leafFace —— 只对 `conductor` 这一个 id 下发整副面 (只读手 + 七张卡 + 常驻 conductor prompt);
    //   · 卡的 `runChild` = 同一个 `_runDag` 注入口跑派发出的子图 (D-5 唯一执行入口), 子 run 剥掉
    //     verifier / maxEscalations / leafFace / freezeCriterion (子图节点各自带 self_check), 派生 runId。
    //   平铺图那几颗钉子 (frozenNodes / deterministicReplan) 不挂: 循环没有重规划轮。
    const loopCfg = loopPlan !== undefined ? withLoopConfig(tappedCfg, loopPlan, loopHost, runnable, task, loopLedger, loopSurveyPack) : tappedCfg;
    exec = await (config._runDag ?? runExecutorDagWithPlan)(execPlan, loopCfg);
  } catch (err) {
    return bail(`execute 抛错: ${String(err).slice(0, 200)}`, 'infra-error');
  }
  // ── P3 S6b / D-14: 终审恰一次 + 单次回灌不复审 ───────────────────────────────────
  //
  // 触发 = 循环路径 ∧ verifier **真被调过**且判红 (`lastVerdict` 只在 tapVerifier 里赋值 —— 闸红短路与
  // verifier-error 两条出口都不经过 tap, 所以它们天然不触发回灌: oracle 红走短路零 LLM, 判卷官坏了
  // 不替它开修复轮)。回灌 = finding 原文 append 到**同一 conductor 节点 id** 的 goal, 按同一张图重跑一次,
  // 第二次 **不带 verifier** (INV-7: 终审每 run 至多一次, 这里靠"字段不在"机械保证, 不靠计数)。
  // 之后终态由机械 oracle 定 (下方 outcome 的 verifier-rejected 分支)。
  let reinjected = false;
  /** 回灌后的图 —— 窄复审要按**第二跑真正跑的那张图**判卷, 不是首跑的 loopPlan。 */
  let reinjectedPlan: ConductorPlan | undefined;
  /** 首判 finding 原文 —— 窄复审的卷面主体 (`renderRecheckTask`)。 */
  let reinjectFinding: string | undefined;
  /** 窄复审判词原文 (pass 与 fail 都留: pass 时它是"为什么算修好了"的证据)。缺席 = 没跑复审 / 调不通。 */
  let recheckReason: string | undefined;
  /** R-1: 回灌第二跑开始时的派发数 (两跑共用 loopLedger), 读侧据此分「回灌后有没有新派发」。 */
  let dispatchesBeforeReinject: number | undefined;
  /**
   * 2026-09-03 (code80-p3 首批停批根因): conductor 节点死于基建 (529 / 超时 / 停摆 / 缺能力) 时**不回灌** —— 终审对着空产物
   * 判红是必然的, 再派只是再撞一次同一堵墙, 而终态会被标成 verifier-rejected (语义否决), 把引擎故障记成了模型没做对。
   * 这一格的下一步是「修引擎 / 换池, 别加轮数」, 所以直接走 infra-error (见下方 infraStopped 的循环路径分支)。
   */
  const conductorInfraFailure = ((): string | undefined => {
    const conductor = loopPlan !== undefined ? exec.results[CONDUCTOR_NODE_ID] : undefined;
    if (!conductor || conductor.status === 'done' || !conductor.failureKind || !CONDUCTOR_INFRA_FAILURE_KINDS.has(conductor.failureKind)) return undefined;
    return `conductor 节点基建失败 (${conductor.failureKind}): ${(conductor.output ?? '').slice(0, 240)}`;
  })();
  if (conductorInfraFailure !== undefined && lastVerdict !== undefined && !lastVerdict.pass) {
    logger.warn({ why: conductorInfraFailure }, '[run-goal] D-14: conductor 节点基建类败因 → 不回灌, 终态 infra-error (不是 verifier-rejected)');
  }
  /**
   * 1-B (2026-09-03): 终审否决**判据** (target=criterion) 不回灌 conductor —— smoke8 与主批实测 37/50 打回是这一型, 回灌后 conductor 零新派发、
   * oracle 绿即 success, finding 原地蒸发。判据量不出对错时重跑实装没有意义; 这一格的下一步是 INV-4 判据重建 (下方 rebuildTrigger
   * 对 target=criterion 恒触发), 终态按 verifier-rejected 记 (oracle 绿在被否决的判据上不构成证据)。
   */
  const criterionVeto =
    loopPlan !== undefined && lastVerdict !== undefined && !lastVerdict.pass && lastVerdict.target === 'criterion' && conductorInfraFailure === undefined;
  if (criterionVeto) {
    logger.warn({ reason: lastVerdict!.reason.slice(0, 200) }, '[run-goal] 1-B: 终审否决判据 (target=criterion) → 不回灌 conductor, 走 INV-4 判据重建');
  }
  /** 终审**真判红**过 —— 与「回灌过」分开: D-5 之后回灌还有第二个触发源 (证伪判红), 两者的下游处置不同。 */
  const verifierVetoed = lastVerdict !== undefined && !lastVerdict.pass;
  /** D-5: 证伪判红同样开一轮回灌。开关关着时 `falsify` 恒缺席 ⇒ 恒 false (INV-4)。 */
  const falsifyRed = falsify?.status === 'red';
  if (loopPlan !== undefined && (verifierVetoed || falsifyRed) && conductorInfraFailure === undefined && !criterionVeto) {
    // 两个触发源都在场时 finding 合并 —— 少带一半会让 conductor 只修看得见的那一半。
    const finding = [verifierVetoed ? lastVerdict!.reason : undefined, falsifyRed ? falsifyFinding : undefined]
      .filter((x): x is string => x !== undefined && x !== '')
      .join('\n\n---\n\n');
    logger.warn(
      { chars: finding.length, target: lastVerdict?.target, verifierVetoed, falsifyRed },
      '[run-goal] D-14 终审判红 / D-5 证伪判红 → finding 回灌 conductor 节点重派 1 次 (第二次不带 verifier, INV-7)',
    );
    const replanted = withReinjectedFinding(loopPlan, finding);
    try {
      // 基座 = 第一跑的 execCfg (同一份 freezeCriterion / waiveRed / 预算), 只是 verifier 不在 ——
      // 引擎侧仍然只跑一次终审 (靠"字段不在"机械保证, 不靠计数)。第二跑的语义复审由下方
      // **run-goal 自己手动调一次**, 不经引擎、不经 tapVerifier: 这样"至多一次"是调用点数出来的。
      // ⚠ 回灌第二跑**不复用**首跑那份勘察包: 那时 conductor 的 goal 已经追了 finding 原文,
      // 包是按 goal 抽词算的 —— 复用等于拿首跑的问题去答第二跑的题。这里不传, 由 withLoopConfig 自己算 (行为同旧)。
      const { verifier: _noVerifier, ...noVerifierCfg } = withLoopConfig(loopBase, replanted, loopHost, runnable, task, loopLedger);
      void _noVerifier;
      dispatchesBeforeReinject = loopLedger.dispatches.length;
      exec = await (config._runDag ?? runExecutorDagWithPlan)(replanted, noVerifierCfg);
      reinjected = true;
      reinjectedPlan = replanted;
      reinjectFinding = finding;
    } catch (err) {
      return bail(`D-14 回灌重跑抛错: ${String(err).slice(0, 200)}`, 'infra-error');
    }
  }
  // D-5: 回灌后重跑**同一组**证伪测试 (不重写 —— 换一组等于换了把尺子, 前后两次就不可比)。
  // 仍红 ⇒ 下方 `verifierRejected` 判死; 转绿 / inconclusive ⇒ 终态不变。
  if (reinjected && falsifyRed && falsify !== undefined && falsifyPlan !== undefined && falsifyRunner !== undefined) {
    const again = runFalsifyTests(falsifyPlan, config.cwd, falsifyRunner, config._falsifyRun ? { run: config._falsifyRun } : {});
    falsify = { ...falsify, reinjected: true, afterReinject: again.status };
    logger.warn({ afterReinject: again.status, failing: again.failing, why: again.why }, '[run-goal] D-5 回灌后重跑同一组证伪测试');
  }
  const flatUsed = flatPlan !== undefined;
  const loopUsed = loopPlan !== undefined;
  // P3 S6b: 循环路径的"执行叶"是 conductor 节点 —— 下游读 output (rubric 判官) / blocked / budgetStopped 的地方
  // 全部照旧, 只是换了个 id。
  const execLeaf = loopUsed ? exec.results[CONDUCTOR_NODE_ID] : undefined;
  if (!execLeaf && !flatUsed) return bail('conductor 节点无结果 (引擎没跑到它)', 'infra-error');
  // D-I 环外闸: 执行型才有这个节点。它**没跑**(引擎没走到 / 被 quorum 级联跳过)也算没过 ——
  // 冻结判据的意义就是"没被证明过就不算成", fail-closed 与 converged 缺席同一条纪律。
  const acceptLeaf = runnable ? exec.results.accept : undefined;
  // ── 判据的绿有「它是哪一轮量的」这个属性 (2026-08-21, run 58df6b9e 复盘) ──────────────
  //
  // P2 那跑的形状, 逐跳全部有盘上证据:
  //   05:25:50  accept 节点真跑真绿, 写下 checkpoint (accept.json, status:'done')
  //   ~05:28    verifier 否决 → 重规划 → 毒集丢绿 → 半回滚, **盘被改坏**
  //   第 2 轮    accept **不在毒集前向闭包里** → resume-skip 直接复用那份绿
  //   收尾      oracleOk = (status === 'done') = true → 终态 delivered-with-red + done
  //
  // 扎人的地方: 下面那道 #165① 收尾复验**只在 `!oracleOk` 时触发**, 而 oracleOk 已经被这份
  // **旧的**绿撑成 true —— **闸被自己要防的那个东西关上了**。P2 日志里确实没有任何 #165① 行。
  //
  // 所以判据要多问一句: 这份绿**属不属于最终这棵树**。两个条件都真才叫不属于 ——
  //   ① 它是 resume 复用来的 (`skipped === true`), 不是这一轮真量的;
  //   ② 本次 run 重规划过 (verifier 否决 → escalation), 也就是盘**可能**在那之后变过。
  // 少任一个都不判 stale: 只复用没重规划 = 盘没动过, 那份绿仍然作数 (别给每次 resume 都加
  // 一次全量测试的钱); 只重规划没复用 = accept 这一轮真跑过, 本来就算数。
  //
  // ⚠ `status === 'skipped'` (quorum 级联压死) 与 `skipped === true` (resume 复用) 是两个正交概念
  //   (见 LeafResult 那两个字段的注), 这里问的是后者。
  // F2 后续修 (2026-08-28): 原写法是 `kind !== 'executable' ? true : …` —— 二值,
  // 「不是执行型 ⇒ 没拿到证明也算绿」。加第三格之前没错 (不是执行型就只剩探索型, 而探索型
  // 本来就没有机器判据); 加了 rubric 之后错了。判定收敛进 `unprovenMeansFail` 一处表态,
  // 新增分型时那个 switch 漏表态即编译错误 (goal/acceptance-shape.ts + harness/exhaustive.ts)。
  const acceptCheckpointGreen = !unprovenMeansFail(acceptance) ? true : acceptLeaf?.status === 'done';
  // P3 S6b 跟进 (2026-09-02): 循环路径的「重规划过」= D-14 回灌过 —— 盘在第二跑里可能变过, 复用的绿同样不属于最终这棵树。
  const replanned = exec.verification?.escalated === true || (exec.verification?.attempts ?? 1) > 1 || reinjected;
  const acceptStale = runnable !== null && acceptCheckpointGreen && acceptLeaf?.skipped === true && replanned;
  // 复验一次。**两个触发条件合并在这一处** —— 分两处写就是两处会漂 (而这条闸的病正是"触发
  // 条件被另一个变量关掉"): ① 原 #165①: accept 压根没跑 (缺席 / 被级联压死), 复验绿只换终态词;
  // ② 新: 绿是陈旧的, 复验结果**直接顶替** oracleOk (它才是最终这棵树上的答案)。
  let oracleRecheckGreen = false;
  let oracleRecheckRan = false;
  // P2b-runtime (2026-09-02): 这次复验命令自己是不是 bare 整仓 pytest 且命中 2/4/5 ——
  // harness 没给出判词, 不能被下面 `oracleRecheckGreen` 的 false 悄悄接成"复验也没过"。
  let oracleRecheckInvalid = false;
  let recheckTail: string | undefined;
  if (
    runnable &&
    (!acceptCheckpointGreen || acceptStale) &&
    acceptLeaf?.status !== 'failed' &&
    config.dag.commandRunner
  ) {
    try {
      const rc = await config.dag.commandRunner({ command: runnable.command });
      oracleRecheckInvalid = isPytestHarnessInconclusive(runnable.command, rc.exitCode, rc.text ?? '');
      if (oracleRecheckInvalid) recheckTail = rc.text;
      // 带&&防呆: harness-inconclusive 的退出码不该被读成"复验也命中了 expectExit"这种巧合绿。
      oracleRecheckGreen = !oracleRecheckInvalid && rc.exitCode === (runnable.expectExit ?? 0);
      oracleRecheckRan = true;
      logger.info(
        { command: runnable.command, exitCode: rc.exitCode, green: oracleRecheckGreen, invalid: oracleRecheckInvalid, why: acceptStale ? 'stale-green' : 'accept-没跑' },
        acceptStale
          ? '[run-goal] 判据陈旧闸: accept 的绿是 resume 复用来的, 而本 run 重规划过 → 在最终这棵树上重量一次'
          : '[run-goal] #165① accept 没跑 (级联压死) → 冻结判据收尾复验',
      );
    } catch (err) {
      // fail-closed 不吞证据: 复验跑不起来时**不许**拿那份陈旧的绿冒充最终答案。
      logger.warn({ err: String(err), stale: acceptStale }, '[run-goal] 冻结判据复验跑不起来 → 维持原判 (fail-closed, 不吞证据)');
    }
  }
  // stale 时以复验为准; 复验没跑成 → 陈旧的绿**不作数** (fail-closed: 没在最终这棵树上证明过就不算成)。
  // ── F2 片 4: rubric 验收步 (INV-1/3/4/5) ─────────────────────────────────────
  //
  // 不建执行型 accept 叶 (上方的 `acceptCheckpointGreen` 已在 rubric 上恒 true);
  // 走自己这条流水线: 冻检查 → 劣化自证 → 逐条判 → settle。**任一关拒就不到 settle**,
  // 让 `rubricRejection` 取代 `rubricVerdict` —— 这正是 INV-3 "漂了照判" 与
  // INV-4 "探针在判真产物之前" 的机械落点。
  //
  // 不给 `rubricVerdictInputs` = 闸缺席 (fail-open 不吞证据: summary 里说"缺席", 不冒充零判)。
  // 非 rubric 走默认值 true, 后面 OR 算式把它当 NO-OP —— 接线不污染另两格 (INV-1 护栏不是判据)。
  let rubricVerdict: RubricVerdict | undefined;
  let rubricRejection: RunGoalResult['rubricRejection'] | undefined;
  // ⚠ 初值按 `unprovenMeansFail` 定, 不是无脑 true:
  // rubric **有**判据 (那份冻结的 checklist), 所以「没拿到证明」= 不算成 (fail-closed),
  // 与执行型同路。原来初值恒 true, 于是 `rubricVerdictInputs` 缺席 (今天的生产常态 ——
  // 还没有人注入) 时一个 rubric 目标会被判**已达成**, 那正是加第三格时那条静默错路
  // 换了个地方复现: 片 4 把它从 acceptCheckpointGreen 挪到了这里, 没有消灭它。
  let rubricOracleOk = !unprovenMeansFail(acceptance);
  if (acceptance.kind === 'rubric') {
    // R-2 (2026-08-30, owner 裁形状 C): **生产在这里现算**, 注入口只留给测试。
    //
    // 此前这一格只读 `config.rubricVerdictInputs` —— 而那个字段挂在开跑前的 config 上,
    // 要装的 `traces` 却是「对**真实产物**逐条判的结果」, 产物跑完才存在 ⇒ 时序上谁也填不了。
    // 归因实测的后果: rubric 类 success 数 = 0 (240 trial), 该分型**结构上不可能 success**。
    //
    // 注入优先: 给了就原样用 (测试控判词), 不给才真跑判官。与同字段里 `_settleRubric`
    // 「仅供测试的注入点 —— 生产不传, 走默认实装」逐字同源。
    //
    // 证据面 = 执行叶的产出正文。判官只能依据它判 —— 看不出来的一律判不成立 (prompt 里写死),
    // 所以证据越薄判得越严, 那个方向是安全的 (不会把没做的判成做了)。
    let inputs = config.rubricVerdictInputs;
    if (!inputs) {
      // 2026-09-03 (smoke8-p3 repo_understanding: 我们判 8/11 不过, bench 判 15/15 过): 证据面此前只有执行叶的
      // **报告正文**, 产物文件本身判官一个字没看见 —— conductor 经 bash 写的 analysis.json 就在盘上。证据 = 报告 + 盘上
      // 改动文件的内容 (git status 取, fail-open: 取不到就只剩报告, 留一行)。判官只能依据它判, 所以宁可给全。
      const judged = await judgeRubric(acceptance.checklist, `${execLeaf?.output ?? ''}${renderArtifactEvidence(config)}`, {
        generate: config.dag.generate ?? makeDefaultGenerate(config.dag.sessionId ?? randomUUID()),
        model: config.dag.conductorModel,
      });
      if (judged) {
        inputs = {
          presented: judged.presented,
          traces: judged.traces,
          // owner 未定 ⇒ 取最保守端 (全过才算过)。放宽是 owner 的决定, 不由默认值代劳。
          maxFailures: DEFAULT_RUBRIC_MAX_FAILURES,
          // `degraded` 刻意缺席: 劣化样本这一层本片不做, 而 `checklistDiscriminationReason`
          // 对 undefined 是 fail-open (探针跳过, 不拦)。缺席 ≠ 判过且没问题。
        };
      } else {
        logger.warn(
          { goal: goal.slice(0, 80) },
          '[run-goal] R-2 rubric 判官没产出可用判词 → 验收步仍缺席 (fail-open, 不冒充零判)',
        );
      }
    }
    if (inputs) {
      // 1) 冻检查 (INV-3: 漂了就拒, 调用方**不进入**逐条判定 —— settleRubric 一次都不该被调)
      const frozen = verifyFrozen(acceptance.checklist, inputs.presented);
      if (!frozen.ok) {
        rubricRejection = { source: 'frozen-drift', reason: frozen.detail };
        rubricOracleOk = false;
      } else {
        // 2) 劣化自证 (INV-4: fail-open; 拿不到样本 = 探针跳过, 不拦)
        const probeReject = checklistDiscriminationReason(inputs.degraded);
        if (probeReject) {
          rubricRejection = { source: 'probe', reason: probeReject };
          rubricOracleOk = false;
        } else {
          // 3) 逐条判 → settle (INV-5: traces 永不全压成 N/M, 走 settleRubric 默认形)
          const settleFn = inputs._settleRubric ?? settleRubricDefault;
          rubricVerdict = settleFn(inputs.traces, { maxFailures: inputs.maxFailures });
          rubricOracleOk = rubricVerdict.pass;
        }
      }
    }
  }
  const baseOracleOk = acceptStale ? oracleRecheckRan && oracleRecheckGreen : acceptCheckpointGreen;
  const oracleOk = acceptance.kind === 'rubric' ? rubricOracleOk : baseOracleOk;
  if (acceptStale && !oracleOk) {
    logger.warn(
      { command: runnable?.command, recheckRan: oracleRecheckRan },
      '[run-goal] 判据陈旧闸: 复用的绿在最终这棵树上**不成立** → 判据判红 (原实装会拿它发 delivered 终态)',
    );
  }
  // ── INV-2 红因分道 (2026-08-29 否决边契约 D-2 / GWT-2) ──────────────────────────
  //
  // 判据判红时「曾到过绿又掉下来」与「一次都没到过绿」的**下一步相反**:
  // 前者去看回滚/毒集那条链 (已达标的交付被销毁了), 后者去看修复轮 (活没干成)。
  // 此前两者共用一句"冻结判据没过", 于是 4 例被销毁的交付在回执上与 6 例没干成的活长得一样。
  //
  // 「曾转绿」的证据源有二, 取并: ① accept 的 checkpoint 是绿的 (那份绿是更早某轮量的);
  // ② 轮观察里有一轮 accept 绿 (verifier tap 看见的中间轮)。少任一个都会漏掉半张现场。
  const everGreenObserved = acceptCheckpointGreen || roundObs.some((o) => o.green) || greenSnapshot !== undefined;
  // P2b-runtime (2026-09-02): 判据/accept 节点自己没给出判词的三种形状统一在这里判——不依赖
  // `acceptLeaf?.failureKind === 'oracle-inconclusive'` 是否已经被引擎侧标上 (那一位在
  // L1→L2 escalation 那条路上 `freezeCriterion` 被剥掉之后仍可能没标上, 见 D-K/engine.ts
  // 的注), 而是直接读 run-goal 自己就有的 `acceptLeaf.exitCode` (D-K 执行器恒填这一位,
  // 与 `escalatedCfg` 有没有带 `freezeCriterion` 无关) 与上面已经算好的 `oracleRecheckInvalid`。
  const criterionHarnessInconclusive =
    isPytestHarnessInconclusive(runnable?.command, acceptLeaf?.exitCode ?? null, acceptLeaf?.output ?? '') || oracleRecheckInvalid;
  const criterionRed =
    runnable !== null && !oracleOk
      ? classifyCriterionRed({
          everGreen: everGreenObserved,
          replanned,
          recheckRan: oracleRecheckRan,
          harnessInconclusive: criterionHarnessInconclusive,
          tail: criterionHarnessInconclusive ? failureExcerpt(acceptLeaf?.output ?? recheckTail ?? '') : undefined,
        })
      : undefined;
  // ── INV-1 终态棘轮 (D-1 / GWT-1) ────────────────────────────────────────────────
  //
  // 冻结判据曾机械转绿的 run, 终态交付不得低于那次绿。棘轮**只加在终态** —— 中轮毒集回滚
  // 语义一字不动 (D-2, 理由在 poison-rollback.ts 文件头: 它治的是反向的病)。
  //
  // 放在写集对账**之前**: 还原之后那份 diff 才是真正交付出去的那棵树, 对账要看的是它。
  let bestGreenFloor: RunGoalResult['bestGreenFloor'];
  if (everGreenObserved) {
    let terminalDiffFiles: number | undefined;
    try {
      terminalDiffFiles = (config.writeSet?._collectChangedFiles ?? (() => collectChangedFiles(config.cwd)))().length;
    } catch (err) {
      // 取不到 ≠ 0 (仓规坑 ①): 非 git 仓 / git 起不来时**不许**拿"diff 空"当动盘的理由。
      logger.warn({ err: String(err) }, '[run-goal] INV-1 终态 diff 取不到 → 棘轮按「不知道」走 (不因此动盘)');
    }
    const decision = decideBestGreenFloor({
      everGreen: true,
      currentGreen: oracleOk || oracleRecheckGreen,
      terminalDiffFiles,
      snapshotFiles: greenSnapshot?.files.length ?? 0,
    });
    let restoredFiles: number | undefined;
    if (decision.action === 'restore' && greenSnapshot) {
      try {
        for (const f of greenSnapshot.files) {
          mkdirSync(dirname(f.path), { recursive: true });
          writeFileSync(f.path, f.content);
        }
        restoredFiles = greenSnapshot.files.length;
        logger.warn(
          { round: greenSnapshot.round, files: restoredFiles },
          '[run-goal] INV-1 终态棘轮: 终态低于本 run 曾达到的绿 → 已把绿快照写回工作树 (否决是信息动作, 不是物理销毁)',
        );
      } catch (err) {
        // 还原失败**不许静默**: 那一刻交付真的丢了, 而回执是唯一还能说出这件事的地方。
        logger.warn({ err: String(err) }, '[run-goal] INV-1 终态棘轮: 绿快照写回失败 → 终态仍低于那次绿 (不吞证据)');
      }
    }
    bestGreenFloor = {
      action: decision.action,
      label: decision.label,
      snapshotFiles: greenSnapshot?.files.length ?? 0,
      ...(restoredFiles !== undefined ? { restoredFiles } : {}),
    };
  }
  // ── INV-4 判据重建边 (D-4 / GWT-4) ──────────────────────────────────────────────
  //
  // 触发 = 否决分型指向判据, 或判据读数纹丝不动而 leaf 在产出, 或 #205 探针读到 green-before。
  // 判据在 shouldRebuildCriterion; 这里只负责喂参数、叫重建者、把重建出来的那条**过全部自证门**、留痕。
  //
  // ⚠ 诚实边界: 重建出的判据**不进本 run 的终态判定** (见 RunGoalResult.criterionRebuild 的注)。
  let criterionRebuild: RunGoalResult['criterionRebuild'];
  const rebuildTrigger = runnable
    ? shouldRebuildCriterion({
        ...(lastVerdict ? { verdictTarget: lastVerdict.target } : {}),
        // 路 ③ (2026-09-05): 探针没跑过就缺席, 不编 'red-before' —— 缺席 ≠ 红 (仓规坑 ①)。
        ...(loopLedger.criterionDirection !== undefined ? { criterionDirection: loopLedger.criterionDirection } : {}),
        rounds: roundObs.map((o) => ({ exitCode: o.exitCode, touched: o.touched })),
        alreadyRebuilt: false,
      })
    : { rebuild: false, reason: '非可执行判据 — 没有"命令量不出差别"这回事' };
  if (runnable && rebuildTrigger.rebuild) {
    // R4 D-7: 异族座出的题也被判死了 —— 重建照走 (重建者仍是执行体家族, 那是今天的行为),
    // 但读侧要分得出这一格: 「异族出题 + 仍被否决」与「执行侧自写 + 被否决」是两种病。
    if (loopLedger.criterionAuthor?.accepted) loopLedger.criterionAuthor.rebuiltAfterCross = true;
    // 声明产物集 = 图里节点声明会产出的东西。**给得出来就要给** —— 切片 1 那道门在拿不到
    // 这份事实时整道不跑 (缺席 ≠ 空集), 而重建判据恰恰最容易指向"还没被产出的文件"。
    const declaredArtifacts = [
      ...new Set(
        Object.values(exec.plan.nodes).flatMap((n) => [
          ...(n.output_path ? [n.output_path] : []),
          ...(Array.isArray(n.write_set) ? n.write_set : []),
        ]),
      ),
    ];
    const rebuilder = config._rebuildCriterion ?? productionCriterionRebuilder(config, goalProtectedPaths);
    let proposal: { command: string; expectExit?: number; negativeSample?: string } | null = null;
    if (rebuilder) {
      try {
        proposal = await rebuilder({ goal, current: runnable.command, trigger: rebuildTrigger.reason, declaredArtifacts });
      } catch (err) {
        logger.warn({ err: String(err) }, '[run-goal] INV-4 判据重建者抛错 → 这一次不重建 (触发照记, 不吞证据)');
      }
    }
    if (!proposal) {
      criterionRebuild = {
        trigger: rebuildTrigger.reason,
        admitted: false,
        why: rebuilder ? '重建者提不出候选判据 (返 null)' : '重建者缺席 (没注入 _rebuildCriterion, 也没有 agentRunner)',
      };
    } else {
      // 全部自证门。命令闸那道**带上产物集**走的就是切片 1 新加的路径参数门 (INV-6)。
      const expectExit = proposal.expectExit ?? 0;
      const gates: { name: string; ran: boolean; reason: string | null }[] = [
        {
          name: '命令闸 (含路径参数门)',
          ran: true,
          reason: acceptanceCommandBlockReason(proposal.command, { root: config.cwd, declaredArtifacts }),
        },
        {
          // O1 (2026-09-06): 第三道 —— 判据得锚在这个仓里, 不锚在引擎自己的 `.omd/` 产物上。
          // 前两道各答各的问题 (跑不跑得起来 / 恒不恒真), 都答不了「它量的是不是这个仓」。
          name: '仓内锚定',
          ran: true,
          reason: repoAnchorBlockReason(proposal.command, { root: config.cwd, envFacts, declaredArtifacts }),
        },
      ];
      if (config.dag.commandRunner) {
        gates.push({
          name: '空世界自检',
          ran: true,
          reason: await acceptanceVacuityReason(proposal.command, config.dag.commandRunner, expectExit),
        });
      } else {
        // fail-closed: 重建出的判据是**环内产出的**, 拿不到证明就不准冻结 (与 classify 那侧
        // 审分类器判据的 fail-open 刻意相反 —— 出身不同, 纪律不同)。
        gates.push({ name: '空世界自检', ran: false, reason: null });
      }
      const admission = criterionRebuildAdmission(gates);
      criterionRebuild = {
        trigger: rebuildTrigger.reason,
        proposed: proposal.command,
        ...(proposal.expectExit !== undefined ? { expectExit: proposal.expectExit } : {}),
        admitted: admission.admitted,
        why: admission.why,
      };
      logger.info(
        { proposed: proposal.command, admitted: admission.admitted, why: admission.why },
        '[run-goal] INV-4 判据重建: 候选判据已过自证门 (采纳与否见 admitted; 本 run 终态不用它)',
      );
      // ── INV-4 回写 (2026-08-30, owner 裁): 采纳的候选**冻进下一轮**, 不进这一轮 ──────
      //
      // 「不进这一轮」是承重的: 拿刚重建的判据去判**本轮**的产物, 就是字面意义的移球门
      // (环内产出的判据给环内产出的东西打分)。所以这里只写盘, 本 run 的 `oracleOk` /
      // 终态一个字节都不受影响 —— 上面那行日志的「本 run 终态不用它」仍然成立。
      //
      // 下一轮从 `goal-state.json` 读回 (:1084 那条 prior 路径, 按 goalHash 匹配),
      // 于是**同一个 goal 的下一次跑/续跑**才用新判据。
      //
      // 三重护栏, 少一道都不写:
      //   ① `admitted` —— 两道自证门都真跑过且都过, 含**空世界自检判红**(证明新判据不恒真);
      //      `criterionRebuildAdmission` 是 fail-closed 的: 门没跑成 (`ran:false`) 即不采纳。
      //   ② 只对 `executable` 分型回写 —— rubric/exploratory 的"判据"不是一条命令, 形状不同,
      //      硬塞会把分型抹平 (§静默坑 1)。
      //   ③ **审计轨必写** (`criterionHistory` 追加) —— 球门动了而看不出来 = 静默降分。
      if (admission.admitted && classified.acceptance.kind === 'executable') {
        const from = classified.acceptance.command;
        const next: GoalClassification = {
          ...classified,
          acceptance: {
            ...classified.acceptance,
            command: proposal.command,
            ...(proposal.expectExit !== undefined ? { expectExit: proposal.expectExit } : {}),
          },
        };
        saveState({
          goalHash,
          classified: next,
          ...((lastSaved ?? prior)?.contract ? { contract: (lastSaved ?? prior)!.contract } : {}),
          criterionHistory: [
            ...((lastSaved ?? prior)?.criterionHistory ?? []),
            {
              at: Date.now(),
              from,
              to: proposal.command,
              ...(proposal.expectExit !== undefined ? { expectExit: proposal.expectExit } : {}),
              trigger: rebuildTrigger.reason,
            },
          ],
        });
        logger.warn(
          { from, to: proposal.command, trigger: rebuildTrigger.reason },
          '[run-goal] INV-4 回写: 验收判据已换, **下一轮生效** (本轮不用) — 球门动过, 审计轨见 goal-state.criterionHistory',
        );
      }
    }
  }
  // `converged` 缺席 = 没人判过 → 一律**不算成** (judge_final 已保证它在, 缺席意味着引擎跑歪了)。
  // **裁决位 = 环自己的结论** (#148, 2026-08-17): 判据停时它是判据说的 (D-I 以判据为准),
  // judge 停时它是 judge 说的。此前这里让 judgeConverged **压过** converged —— 而那一位的类型
  // 契约 (LeafResult.judgeConverged) 明写「judge 的票只记录不决定, 单独带出去是给判据轴量的」。
  // 观测位当裁决位用的实测后果 (B0 run 6251afc4): 环记 stop.kind=success·判据绿, 回执判
  // not-converged, 指引「加轮数 resume」—— 而 resume 进环判据仍绿、round 1 再停, 是个不动点。
  // 平铺路径 (D-3): 没有 conductor 节点就没有 judge 投票 —— 停止规则唯一 = 冻结判据,
  // criteria.judge 恒等于 oracle, 「判词✅/判据❌打架」这个状态在平铺图上从型别消灭。
  // P3 S6b 循环路径 (D-14 「循环内以 oracle 为终止条件」): 有可执行判据 ⇒ 停止规则唯一 = 冻结判据, 与平铺同形;
  // 无判据 (探索型 / rubric) ⇒ 环的结论 = conductor 节点跑完 (status done), 判据轴由 rubric 判官 / 终审说话。
  const loopOk = flatUsed ? oracleOk : runnable ? oracleOk : execLeaf!.status === 'done';
  // judge 自己那一票 (判据轴观测位, 进 criteria.judge; 与裁决位分开 —— 「judge 太紧」那一格
  // 靠它才观测得到)。缺席 = 没走环内判据那条路, 环结论即 judge 说的。
  const judgeSaidOk = loopOk; // v1 内环 judge 已随 v1 退役; 环结论即 judge 说的
  // D-1 delta: after 侧 = accept 节点的实判 (done→pass / failed→fail / 没跑→缺席)。
  // 缺席 + 两侧都 full → 比对器判 new-failure (fail-closed, 与 oracleOk 同一条纪律:
  // 「没被证明过就不算成」—— 引擎没跑到 accept 节点, 覆盖就回退了)。
  let verifyDelta: DeltaReport | undefined;
  /** S-37 第 2 半:第一次读到、复跑没复现的失败(抖动证据,进判词不进判红)。 */
  let flakyFailures: string[] = [];
  if (baselineSide !== undefined && runnable) {
    const acceptStatus = exec.results.accept?.status;
    const afterStatus: VerifyStepStatus | undefined =
      acceptStatus === 'done' ? 'pass' : acceptStatus === 'failed' ? 'fail' : undefined;
    let afterSide = acceptSideOf(afterStatus, exec.results.accept?.output ?? '');
    verifyDelta = buildAcceptDelta(baselineSide, afterSide);
    // ★ 一次红不算红(S-37 半 a:同 HEAD 两次的 fail 名字集实测不相交)。**只在要判红时**
    //   才付这次复跑 —— 绿的那条路一次都不多跑。复跑抛错 = 不改判(fail-closed:
    //   证不了它是抖动就按红算), 但留证据。
    const needsConfirm = verifyDelta.red && verifyDelta.newFailures.some((id) => id.startsWith(TEST_STEP_PREFIX));
    if (needsConfirm && config.dag.commandRunner) {
      try {
        const again = await config.dag.commandRunner({ command: runnable.command });
        const againSet = acceptSideOf('fail', again.text).failSet;
        flakyFailures = unstableFailSet(afterSide.failSet, againSet);
        if (flakyFailures.length > 0) {
          logger.warn({ flaky: flakyFailures, command: runnable.command }, '[run-goal] D-1 复跑未复现 → 不判红, 记抖动 (S-37)');
          afterSide = { status: afterSide.status, failSet: stableFailSet(afterSide.failSet, againSet) };
          verifyDelta = buildAcceptDelta(baselineSide, afterSide);
        }
      } catch (err) {
        logger.warn({ err: String(err) }, '[run-goal] D-1 复跑跑不起来 → 维持原判红 (fail-closed, 不吞证据)');
      }
    }
  }
  // ── D-2 (SDD cairness-distill): ex-ante 写集声明 + 跑后 diff 对账 (孤儿检测) ──────────
  // 声明面 = exec 图里真跑过 (done/failed) 的节点的 write_set; 在跑节点 = 同一集合 —— 本 run 的
  // 节点在收尾当下都算在跑, 历史 run 的声明根本不进输入 (G-4: 已完成节点不再授权后续改动,
  // 由构造保证, 不靠运行时猜)。diff 面 = 跑后 git 工作树改动 (可注入); 收集失败 → 闸缺席
  // (fail-open, 不吞证据)。touch 面 = touch ledger 的写事件, 由判定器的声明面承接 ——
  // 本文件不持 ledger 句柄, 有句柄的装配层经同一个 attributeWriteSet 接对账。
  // S-2: 同一份 diff 再走 run 级声明写集面 (allowed/forbidden/outside) —— 判据在 write-set.ts,
  // 本文件不重写; 两轴 (节点归属 / run 声明面) 分开报, 不混成一个红 (INV-4)。
  let writeSet: WriteSetReport | undefined;
  let writeScope: WriteScopeReport | undefined;
  let sliceCoverage: SliceCoverageReport | undefined;
  if (config.writeSet) {
    try {
      const diffFiles = config.writeSet._collectChangedFiles
        ? config.writeSet._collectChangedFiles()
        : collectChangedFiles(config.cwd);
      // S-46 缺片闸: 与上面两轴共用**同一份 diffFiles** (各收各的 = 两个判词能互相矛盾)。
      // 只在直通v2真用上时判 —— flatUsed 之外切片不是执行单位。#242 复用片豁免 (零 diff 合法)。
      if (flatUsed && flatSlices) sliceCoverage = coverSlices(flatSlices, diffFiles, flatReusedSlices);
      // S-2 run 级声明写集面 (与节点级阶梯正交: 阶梯裁「谁写的」, 声明面裁「该不该写」)。
      // forbidden = 撞并发 run 的写面 (红, 非零退出码语义); outside = 声明面外 (INV-3 读数,
      // 声明缺席 ≠ 违规, 不红)。缺省面 = write-set.ts 的 SDD_DECLARED_WRITE_SET (本 SDD run);
      // 并发/其他 run 经 config.writeSet.declared 注入自己的面。
      const declared = config.writeSet.declared ?? SDD_DECLARED_WRITE_SET;
      const scopeFiles = diffFiles.map((file) => ({ file, kind: classifyWriteScope(file, declared) }));
      writeScope = {
        files: scopeFiles,
        forbidden: scopeFiles.filter((f) => f.kind === 'forbidden').map((f) => f.file),
        allowed: scopeFiles.filter((f) => f.kind === 'allowed').map((f) => f.file),
        outside: scopeFiles.filter((f) => f.kind === 'outside').map((f) => f.file),
      };
      const declarations: WriteSetDeclaration[] = Object.entries(exec.plan.nodes)
        .filter(([, n]) => Array.isArray(n.write_set))
        .filter(([id]) => {
          const st = exec.results[id]?.status;
          return st === 'done' || st === 'failed';
        })
        .map(([id, n]) => ({ nodeId: id, files: n.write_set ?? [], status: exec.results[id]!.status }));
      writeSet = attributeWriteSet({
        diffFiles,
        declarations,
        activeNodeIds: Object.keys(exec.results),
        ...(config.writeSet.globalExempt ? { globalExempt: config.writeSet.globalExempt } : {}),
        ...(config.writeSet.intentional ? { intentional: config.writeSet.intentional } : {}),
      });
    } catch (err) {
      logger.warn({ err: String(err) }, '[run-goal] D-2 写集对账起不来 → 闸缺席 (fail-open)');
    }
  }

  // ── P4 设计审核 (advisory, 不上关键路径) ────────────────────────────────────────
  // INV-3: 审核失败/timeout → converged 与无审核节点逐位相同。
  // INV-6 / G-4: 写集与前端 glob 不相交 → 零模型调用。
  let designReview: DesignReviewResult | undefined;
  if (config.designReview) {
    try {
      const reviewFiles = config.writeSet?._collectChangedFiles
        ? config.writeSet._collectChangedFiles()
        : collectChangedFiles(config.cwd);
      const requestedEscalation = config.designReview.escalationSeat ?? config.dag.conductorEscalationModel;
      const escalationSeat = escalationProviderReady(requestedEscalation) ? requestedEscalation : undefined;
      const runReview = config.designReview._runReview ??
        productionDesignReviewRunner(config, goalProtectedPaths, config.designReview.screenshotCommand, escalationSeat);
      designReview = await maybeRunDesignReview({
        cwd: config.cwd,
        changedFiles: reviewFiles,
        ...(config.designReview.profile ? { profile: config.designReview.profile } : {}),
        ...(runReview ? { runReview } : {}),
        ...(config.designReview.screenshotCommand ? { screenshotCommand: config.designReview.screenshotCommand } : {}),
        ...(escalationSeat ? { escalationSeat } : {}),
        ...(config.designReview.repairAttempted !== undefined
          ? { repairAttempted: config.designReview.repairAttempted }
          : {}),
      });
    } catch (err) {
      logger.warn({ err: String(err) }, '[run-goal] 设计审核起不来 → 闸缺席 (fail-open, INV-3)');
    }
  }
  // ── #165① 的复验**已上移**到 oracleOk 的定义处 (2026-08-21) ────────────────────────
  //
  // 原先它在这里, 而它的触发条件是 `!oracleOk` —— 于是 oracleOk 被一份**陈旧的**绿撑成 true 时,
  // 这道闸就再也不开火 (run 58df6b9e 的死法)。上移之后 oracleOk 在它的定义处就是可信的,
  // 下游一个字都不用改; 两个触发条件 (accept 没跑 / 绿是陈旧的) 也合并成一处, 不留两份会漂的判据。
  // 语义保持: #165① 那半复验绿仍然**不翻 converged** (见 `oracleRecheckGreen` 的下游用法),
  // 只把终态词从「交付没达标」换成 delivered-with-red。
  // ── D-14 窄复审 (2026-09-04, owner 裁「补第二跑的复审」) ─────────────────────────
  //
  // 原形状: 回灌重跑之后**终态由机械 oracle 独自定** —— oracle 绿即 success, 语义层没有第二只眼。
  // 而仓规 §静默坑 3 点名的就是这一格: oracle 绿 ≠ 语义对, 测试与实装由同一次改动一起产出时会
  // 一起错并互相背书。实测代价 = owner 每条 run 手工逐条读 diff 在补它。
  //
  // 触发**收窄到 oracle 会放行的那一格**: 回灌后 oracle 已经红时终态本来就是 verifier-rejected,
  // 再花一次跨模型调用买不到任何新信息。所以这次调用只发生在「机械闸说通过」的时候 —— 正是
  // 唯一一个没有第二只眼的位置。
  //
  // 卷面是**窄**的 (`renderRecheckTask`): 只判首判 finding 修没修, 不许开新战线。全量复审会让
  // 第一次终审本可提出却没提的问题在第二跑翻案, 等于把「至多回灌一次」变成无限轮。
  //
  // 判官坏了 (抛错) → fail-open 按 oracle 念: 判卷官故障不许改终态 (与 tapVerifier 那条
  // 「verifier-error 不触发回灌」同向)。
  let recheck: 'pass' | 'unproven' | 'fail' | 'error' | 'skipped' = 'skipped';
  const recheckOracleWouldPass = runnable ? oracleOk : false;
  // `verifierVetoed` 是 D-5 之后加的守卫: 复审问的是「**首判** finding 修没修」, 终审压根没判红时
  // 没有首判 finding 可复审。D-5 之前 `reinjected` 蕴含 `verifierVetoed`, 所以这一项对老行为是恒真。
  if (reinjected && verifierVetoed && recheckOracleWouldPass && config.dag.verifier && reinjectedPlan && reinjectFinding !== undefined) {
    try {
      verifierCalls++;
      const verdict = await config.dag.verifier({
        task: renderRecheckTask(task, reinjectFinding),
        plan: reinjectedPlan,
        results: exec.results,
      });
      // 三格从二值裁决 + 一个固定前缀读出来 (2026-09-04): 判官拿不出反证时按卷面要求以
      // `UNPROVEN:` 起头, 那是**放行但什么都没量到**, 与干净 pass 分开记账。
      // trimStart: 判官偶尔在前缀前留空白, 那不该把这一格降级成 'pass' (读数会虚高)。
      const unproven = verdict.pass && verdict.reason.trimStart().startsWith(RECHECK_UNPROVEN_PREFIX);
      recheck = verdict.pass ? (unproven ? 'unproven' : 'pass') : 'fail';
      recheckReason = verdict.reason;
      logger.warn(
        { recheck, chars: verdict.reason.length },
        recheck === 'pass'
          ? '[run-goal] D-14 窄复审: 首判 finding 已修 → 放行'
          : recheck === 'unproven'
            ? '[run-goal] D-14 窄复审: 拿不出反证也确认不了 → 放行但记 unproven (这次什么都没量到)'
            : '[run-goal] D-14 窄复审: 拿到反证判首判 finding 仍未修 → verifier-rejected (机械 oracle 绿不算数)',
      );
    } catch (err) {
      // fail-open 吞异常**不吞证据** (§静默坑 2): 错误原文进日志, 'error' 与 'skipped' 分两格记账。
      recheck = 'error';
      logger.warn({ err: String(err) }, '[run-goal] D-14 窄复审调不通 → fail-open, 终态按机械 oracle 念');
    }
  }
  // P3 S6b / D-14: 回灌过 ∧ (回灌后机械 oracle 仍红 ∨ 本 run 无机械 oracle) ⇒ 终审的否决没被证伪, 这趟不算成。
  // 2026-09-04 追加第三条: 回灌后 oracle 绿**但窄复审判首判 finding 仍没修** ⇒ 同样不算成。
  // `recheck === 'error'` 不在此列 —— 判官坏了按 oracle 念 (fail-open), 那是 'skipped' 之外单记一格的理由。
  // 2026-09-05 D-5 追加第四条: 证伪测试回灌后**仍红** ⇒ 同样不算成 (target = implementation:
  // 打的是产出不是判据, 所以不触发判据重建)。
  // 第一支加的 `verifierVetoed` 同样是 D-5 之后的守卫 —— 证伪触发的回灌不该拿「终审的否决没被证伪」
  // 这句话去判死; D-5 之前 `reinjected` 蕴含它, 对老行为恒真。
  const verifierRejected =
    loopUsed && ((reinjected && verifierVetoed && (runnable ? !oracleOk : true)) || criterionVeto || recheck === 'fail' || falsify?.afterReinject === 'red');
  // conductor 死于基建 (2026-09-03): 哪怕 accept 复用了一份绿, 这趟也不算成 —— 引擎侧停 (infra-error), 不是交付达标。
  const convergedByCriteria = loopOk && oracleOk && !verifierRejected && conductorInfraFailure === undefined;
  // ── D-1 零写入闸 (契约 2026-09-05 假 success 三闸) ────────────────────────────────
  //
  // 收敛判定成立而工作树一个字节都没动 ⇒ 不算成 (fail-closed)。判据纯逻辑在 zero-write-gate.ts。
  // resume 豁免: 续跑前那段活可能已被 #165② 自动收编进 commit, 工作树干净不等于没干。
  const isResumeRun = prior !== undefined || config.dag.continuity?.resume === true;
  const zeroWriteChanged: ZeroWriteInput['changed'] =
    convergedByCriteria && !isResumeRun
      ? (() => {
          try {
            return { files: (config.writeSet?._collectChangedFiles ?? (() => collectChangedFiles(config.cwd)))() };
          } catch (err) {
            // 取不到证据不等于零写入 —— fail-open 放行, 原文进 why (仓规静默坑 ②)。
            return { error: String(err).slice(0, 200) };
          }
        })()
      // 未收敛 / resume 两格在纯函数里先短路, 这个值读不到。给 error 壳而不是空 files:
      // 万一短路哪天被改坏, 退化方向也是放行, 不是凭空判一个零写入。
      : { error: '不适用 (未收敛 / resume, 闸不问盘)' };
  const zeroWrite = zeroWriteVerdict({ converged: convergedByCriteria, isResume: isResumeRun, changed: zeroWriteChanged });
  if (zeroWrite.block) {
    logger.warn({ cwd: config.cwd }, '[run-goal] D-1 零写入闸: 收敛判定成立而盘上零改动 → 不算成 (fail-closed)');
  }
  const converged = convergedByCriteria && !zeroWrite.block;
  // judge 异议 (判据绿收敛而 judge 判没成): **只报不翻终态** —— 这一格是判据轴「judge 太紧 /
  // 判据覆盖不够」的样本, 判词在 continuity 的 _loop-execute.json。翻终态的版本就是 #148。
  const judgeDissent = converged && !judgeSaidOk;
  // 平铺路径没有内环 —— rounds 恒 0 是事实不是缺数 (摘要有「直通v2平铺」注记, 不会读成"没跑")。
  const roundCount = execLeaf?.rounds ?? 0;
  // INV-GOAL-3 可证面: 复用现在全发生在**内环**里 (子节点内容寻址, 同 id ≡ 同规格 + 同祖先规格)。
  const reusedNodes = exec.reusedNodes ?? [];
  // D-Q / D-P: 两种"没跑完但不是失败"的收尾, 各自如实报 —— 都恒不算收敛 (fail-closed)。
  // P2e review-fix (2026-09-02): `execLeaf` 只在 conductor 回落图上存在 (id 恒为 `execute`) ——
  // 平铺图 (默认路径) 的节点键是 `s{sliceId}`, 于是同一个 `blocked`/`budgetStopped` 信号在
  // 平铺路径上此前读不出来, 落进 oracleRecheckGreen/oracle-failed 那几格, 给出"以判据为准"
  // 这类误导性下一步。回落: `execLeaf` 缺席时改问图里**任一**节点是否带这个字段。
  const blocked = execLeaf?.blocked ?? Object.values(exec.results).find((n) => n.blocked)?.blocked;
  const budgetStopped = execLeaf?.budgetStopped ?? Object.values(exec.results).find((n) => n.budgetStopped)?.budgetStopped;
  // **引擎自己出事**导致环提前退出 (今天唯一来源: judge 调不通)。与 blocked 分开的理由是
  // 下一步相反: blocked 要人给外部输入, 这个要**修引擎** —— 而它此前落 `not-converged`,
  // 于是读的人会去加轮数, 恰恰是最没用的那个动作。
  // 循环路径: conductor 节点的基建类败因也是「引擎侧停」(agent 叶没有 conductor 那种 infraStopped 字段, 从 failureKind 读)。
  const infraStopped = execLeaf?.infraStopped ?? conductorInfraFailure;
  const cancelledReason = exec.cancelled?.reason;
  // 判词与 oracle **分开报**: 两者不一致时那句话本身就是结论 —— judge 说成了而冻结判据没过,
  // 正是 D-I 要抓的"作弊达标"; 反过来则是"任务里还有命令覆盖不到的明确要求"。
  const oracleNote =
    acceptance.kind === 'executable'
      ? oracleOk
        ? ' · 冻结判据 ✅'
        // P2b-runtime: harness-inconclusive 与"没过"必须分开念 —— 这一条不是"代码被判红",
        // 是"这条命令自己没给出判词"。判在通用文案之前, 因为它是更精确的成因。
        : criterionRed?.cause === 'harness-inconclusive'
          ? ` · **冻结判据没给出判词** (harness-inconclusive: \`${acceptance.command}\` 命中退出码 2/4/5, 不是代码被判红)`
          : ` · **冻结判据没过** (\`${acceptance.command}\` → ${acceptLeaf?.status ?? '没跑'})`
      : acceptance.kind === 'rubric'
        ? rubricRejection
          ? ` · **rubric 拒** (${rubricRejection.source}: ${rubricRejection.reason.slice(0, 80)})`
          : rubricVerdict
            ? ` · rubric ✅ (${rubricVerdict.traces.length} 条逐查, ${rubricVerdict.failedIds.length} 不过)`
            : ' · rubric 验收步缺席 (fail-open, 没注入 rubricVerdictInputs)'
        : '';
  // ── N5: 终止原因**判一次, 两个消费者读同一份** ────────────────────────────────
  //
  // 此前这道阶梯只活在下面那句摘要文本里 —— 于是 `status` 那一位不得不用 `converged ? done : failed`
  // 独立再判一遍, 两处一漂就出现了 2026-07-31 live 那行「一次正确的 BLOCKED 被念成 failed」。
  // 阶梯顺序一字未改 (外部事件 > 资源轴 > 环的结论 > 判据分歧), 只是把它的结论抬成了一个词。
  // #165① 洞①: 走 outcome 细分路, 不走 verification 附注路 —— verification 附注路要动
  // `dag-record.ts:272/410/508/624` + `dag-tools.ts:247-274/272/350-352` +
  // `omd-readout.ts:952/961/1293/1348/1824-1866/2427` + `read-api.ts:22` 共 9+ 消费面, 并需
  // `ALTER omd_dag_runs` 存 attempts/escalated/circuitBroken; outcome 细分只扩
  // `run-goal.ts:1131-1147` 里已存在的 `delivered-with-red` 行为与测试, db schema 不变, 消费者改动面显著更小。
  // D-2 真值表: converged=true 不再无条件 success —— 图内有 status === 'failed' 的子节点 →
  // delivered-with-red (交付达标但有节点红, INV-2), 无红 → success (INV-1)。红节点检查只在
  // converged 真分支问 (converged=false 分支一字不动: 交付没达标优先, INV-3, 且保留既有
  // oracleRecheckGreen → delivered-with-red 复验分支)。
  const hasRedLeaf = Object.values(exec.results).some((n) => n.status === 'failed');
  // ── INV-5: 「rubric 没接线」不许再借 oracle-failed 的壳 (2026-08-29 否决边契约 D-5) ────
  //
  // 判据是**同一个**条件, 只算一次: 落在 oracle-failed 那一格 (环收敛而判据没绿) 且
  // 这一格的成因是"这条判据压根没被接上"。两处各判一遍就是两处会漂 —— 而这条闸治的
  // 正是"标签与成败零相关"。fail-closed 初值 (`rubricOracleOk`) 一字未动: success 仍不可达。
  const rubricUnwiredTerminal =
    loopOk &&
    !oracleOk &&
    rubricAcceptanceUnwired({
      kind: acceptance.kind,
      verdictPresent: rubricVerdict !== undefined,
      rejectionPresent: rubricRejection !== undefined,
    });
  const outcome: RunOutcomeKind = zeroWrite.block
    // D-1: 排在整张阶梯之前 —— 被它拦下时其余各格 (取消/引擎出事/预算停/终审判红) 恒不成立
    // (它们任一成立都会先让 convergedByCriteria 为假), 摆在最前只是让这一格的结论不依赖排序。
    ? 'not-converged'
    : converged
    ? hasRedLeaf
      ? 'delivered-with-red'
      : 'success'
    : cancelledReason
      ? 'cancelled'
      : infraStopped
        ? 'infra-error'
        : budgetStopped
          ? 'budget-exhausted'
          // P3 S6b / D-14: 排在外部事件 / 资源轴之后 (取消 / 引擎出事 / 预算停的止损动作更强), 排在
          // 环内结论细分之前 (它的下一步与 blocked / oracle-failed / not-converged 都不同: 读 finding, 别加轮数)。
          : verifierRejected
            ? 'verifier-rejected'
          : blocked
            ? 'blocked'
          // #165①: 复验绿排在环内结论细分之前 —— 交付真身已被独立判据证实, 「加轮数/看哪边错」
          // 的指引对它都是误导; 但排在外部事件/资源轴之后 (取消/引擎出事/预算停的止损动作更强)。
          : oracleRecheckGreen
            ? 'delivered-with-red'
          : loopOk && !oracleOk
            // INV-5: 这一格的下一步与 not-converged 同 (**别加轮数** —— 加多少轮都不会有人注入
            // rubricVerdictInputs), 所以复用那个 outcome; 「它其实是哪一格」由 terminalLabel 说。
            ? (rubricUnwiredTerminal ? 'not-converged' : 'oracle-failed')
            : 'not-converged';
  // P2b-runtime: 判据命令自己没给出判词 (与 "rubric 没接线" 同类"归因不是判红"的例外) ——
  // 不动 outcome/RunOutcomeKind 本身 (它可以照旧是 'oracle-failed', 与本契约"不新开 RunOutcomeKind"
  // 的立场一致), 只有 terminalLabel 需要第三态。
  const criterionInconclusiveTerminal = !oracleOk && criterionRed?.cause === 'harness-inconclusive';
  /** INV-5 终态字面: 默认逐字等于 outcome, "rubric 没接线" / "判据没给出判词" 各自独立成词。 */
  const terminalLabel = criterionInconclusiveTerminal
    ? TERMINAL_CRITERION_INCONCLUSIVE
    : rubricUnwiredTerminal ? TERMINAL_RUBRIC_UNWIRED
    // 1-B 否决判据 (2026-09-04): 排在上面两格之后 —— 那两格问的是「判据有没有给出判词」,
    // 这一格问的是「给了判词但判词本身被终审否决」, 前两格成立时它们的归因更靠前。
    : criterionVeto ? TERMINAL_CRITERION_VETOED
    // D-1: 零写入是「判据全绿而盘上什么都没有」, 上面三格问的都是判据本身, 与它正交。
    : zeroWrite.block ? TERMINAL_ZERO_WRITE
    // D-2: 排在 TERMINAL_CRITERION_VETOED 之后 —— 那三格问的是「判据有没有给出判词」,
    // 这一格问的是「有没有判据」。前三格成立时它们的归因更靠前。
    : converged && acceptance.kind === 'exploratory' ? TERMINAL_UNVERIFIED
    : outcome;
  stages.push({
    stage: 'execute',
    // ⚠ `status` 保持原样 (三态一字未动, 全仓 `=== 'done'` 的消费者行为不变) ——
    // 一次正确的 BLOCKED 在这一位上**仍然**是 failed。念对它是 `outcome` 的职责, 不是这一位的。
    status: converged ? 'done' : 'failed',
    outcome,
    summary:
      `${roundCount} 轮${
        outcome === 'success' ? '收敛'
        // D-1: 判在最前 —— 它的成因比后面任何一格都精确 (收敛判定本来成立, 只差产物),
        // 下一步也不同: 读 conductor 自述与 dispatches, 不是加轮数。
        : zeroWrite.block ? '零写入: 收敛判定成立但盘上没有任何改动 (git status 空) —— 不算成; 读 conductor 自述与 dispatches, 别加轮数'
        : outcome === 'cancelled' ? `被叫停 (${cancelledReason}) — 已跑完的保留, 同 runId 可 resume`
        : outcome === 'budget-exhausted' ? `预算停: ${budgetStopped!.slice(0, 300)}`
        : outcome === 'infra-error' ? `引擎侧停: ${infraStopped!.slice(0, 300)} —— **别加轮数**, 这是引擎该修的`
        : outcome === 'blocked' ? `阻塞: ${blocked!.slice(0, 300)}`
        // P2b-runtime: 判在 oracle-failed 通用文案之前 —— 同一个 outcome, 但成因是"判据命令
        // 自己没给出判词", 不是"代码被判红" (与 rubricUnwiredTerminal 同一种"归因不是判红"处置)。
        // review fix (P2): 这里只印标签, 不重复带 detail —— `criterionRed.detail` (含最多 800
        // 字的跑输出尾) 已经由本行下面 INV-2/INV-1/INV-4 那句 `· ${criterionRed.detail}` 统一
        // 追加一次, 两处都印会把同一段 pytest 输出在同一行里印两遍。
        : criterionInconclusiveTerminal ? TERMINAL_CRITERION_INCONCLUSIVE
        : outcome === 'verifier-rejected' ? (criterionVeto
            ? `终审否决判据 (target=criterion, 1-B): 不回灌 conductor, 走 INV-4 判据重建 (见 ${CRITERION_REBUILD_LABEL}); 被否决的判据上 oracle 绿不算证据, 本 run 不算成`
            : recheck === 'fail'
              ? `终审判红, finding 回灌 conductor 1 次后机械判据转绿, 但**窄复审判首判 finding 仍没修** (D-14; oracle 绿不算数, 读 recheckDissent, **别加轮数**)`
              // D-5: 终审没判红、只有证伪判红的那一格 —— 措辞不能照抄「终审判红」, 下一步要看的是
              // `loop.falsify.failing` 那几条测试, 不是终审判词。
              : !verifierVetoed
                ? `证伪测试判红, finding 回灌 conductor 1 次后**仍红** (D-5; 挂掉的测试见 loop.falsify.failing, **别加轮数**)`
              : `终审判红, finding 回灌 conductor 1 次后${runnable ? '机械判据仍红' : '无机械判据可证明修复'} (D-14; 读 verifierDissent, **别加轮数**)`)
        : outcome === 'oracle-failed' ? '环说成了但冻结判据(环外)没过 (D-I: 以判据为准)'
        // 两条路都落 delivered-with-red, 摘要必须说清是哪一条 —— 混着念就是在编现场:
        // converged=true 那条 accept **真跑真绿**, 照抄「accept 被级联压死没跑」会让读的人
        // 去查一个不存在的级联。判据 = converged (复验路恒 false, 见上面 oracleRecheckGreen 分支)。
        : outcome === 'delivered-with-red' ? (converged
            ? `交付达标但有节点红 (#165①: 冻结判据 ✅ 而图内 ≥1 子节点红 — 人审红节点, 别整轮重跑)`
            : `交付达标但有节点红 (#165①: accept 被级联压死没跑, 冻结判据收尾复验绿 \`${runnable?.command ?? ''}\` — 人审红节点, 别整轮重跑)`)
        // INV-5: 这一格此前被折进 oracle-failed —— 而它既不是"判据判红"也不是"环没收敛",
        // 是**这条判据压根没被接上**。归因时它该单独站一格 (三批 240 trial 里 13~20 个/批)。
        : rubricUnwiredTerminal ? `${TERMINAL_RUBRIC_UNWIRED}: rubric 分型而验收步缺席 (没人注入 rubricVerdictInputs) — 判据没被判过, 不是判红; **别加轮数**`
        : `未收敛 (${execLeaf?.status ?? '平铺图未过冻结判据'})`
      }${oracleNote}${judgeDissent ? ' · ⚠ judge 异议: 判据绿收敛而 judge 判没成 —— 判据轴「judge 太紧/判据覆盖不够」样本, 判词见 continuity _loop-execute.json' : ''}` +
      `${flatUsed ? ` · 直通v2平铺 (并行读数: ${flatParallelism})` : ''}${flatFallback ? ` · 直通v2回落: ${flatFallback}` : ''}` +
      // P3 S6b: 循环路径的三格读数印在同一行 —— 路径身份 / 终审调用次数 (INV-7 判词 ≤1) / 回灌发生没有。
      `${loopUsed ? ` · 编排循环 (conductor${runnable ? ' + accept' : ', 无机械判据'}) · 终审调用 ${verifierCalls} 次${reinjected ? ` · finding 回灌 1 次 (窄复审 ${recheck})` : ''}` : ''}` +
      `${reusedNodes.length ? ` · 复用 ${reusedNodes.length} 节点` : ''}` +
      // S-51 抓法 ③: 「因契约变更而失效的片」必须印在**同一行**。S-51 那次的摘要只说
      // 「复用 6 节点」, 而「改的那件事有没有做」一个字都没有 —— 人第一眼看的正是这一行。
      // ⚠ **0 也印**: 判据是 `!== undefined` 不是 `.length`。缺席 = 这跑不是 resume (不适用),
      //   空 = resume 了而一片都没失效 —— 压成同一个「不印」, 事后再也分不开 (仓规坑 ①,
      //   与 S-46 缺片那一行同一条纪律)。
      `${exec.specChangedNodes !== undefined ? ` · 规格变更失效 ${exec.specChangedNodes.length} 节点${exec.specChangedNodes.length ? ` [${exec.specChangedNodes.slice(0, 6).join(', ')}]` : ''}` : ''}` +
      `${exec.observations?.length ? ` · 图外观察 ${exec.observations.length} 条` : ''}` +
      `${verifyDelta ? ` · D-1 delta: ${summarizeDelta(verifyDelta)}` : ''}` +
      // S-37: 抖动**要写出来**。不写 = 「复跑一次就绿了所以放行」这件事在盘上没有痕迹,
      // 而那正是下一个人判断这条闸可不可信时唯一能拿到的证据。
      `${flakyFailures.length ? ` · 复跑未复现 ${flakyFailures.length} [${flakyFailures.join(', ')}]` : ''}` +
      `${writeSet ? ` · D-2 写集: ${describeWriteSet(writeSet)}` : ''}` +
      `${writeScope ? ` · D-2 声明面: ${describeWriteScope(writeScope)}` : ''}` +
      // S-46: 缺片必须**印在同一行**。P2 那跑判词齐全而「只做了 1/4」一个字都看不出来,
      // 就是因为没有任何一处印过「声明了几片、落了几片」。
      `${sliceCoverage ? ` · S-46 缺片: ${describeSliceCoverage(sliceCoverage)}` : ''}` +
      // INV-2 / INV-1 / INV-4 三条都印在**同一行**: 人第一眼看的是这一行, 而这三件事
      // (红因是哪一种 · 交付有没有被销毁 · 判据是不是该重建) 恰恰决定下一步该做什么。
      `${criterionRed ? ` · ${criterionRed.detail}` : ''}` +
      // 只印**有事发生**的那两格 (还原了 / 还原不了)。`already-green` 是"棘轮检查过、不必动",
      // 印它等于给每一条绿 run 的摘要挂一段恒定文本 —— 读数不丢, 它在 result.bestGreenFloor 里。
      `${bestGreenFloor && (bestGreenFloor.action === 'restore' || bestGreenFloor.action === 'unrestorable') ? ` · ${bestGreenFloor.label}${bestGreenFloor.restoredFiles !== undefined ? ` — 已写回 ${bestGreenFloor.restoredFiles} 文件` : ''}` : ''}` +
      `${criterionRebuild ? ` · ${CRITERION_REBUILD_LABEL}: ${criterionRebuild.admitted ? `候选判据过了全部自证门 \`${criterionRebuild.proposed}\`` : `未采纳 (${criterionRebuild.why.slice(0, 160)})`}` : ''}`,
  });

  // R-1 (2026-09-03): 编排循环父 run 的读数 (设计 docs/plan/2026-09-03-r1-ledger-columns.md)。只在循环路径组装; 其它路径缺席 = NULL。
  const loop: LoopLedger | undefined = loopUsed
    ? {
        path: 'orchestrating-loop',
        route: { kind: classified.route?.kind ?? 'none', chainHit: false }, // chain 路径已退役, 恒 false (与老记录同形)
        preActionLlmCalls: classified.llmCalls === undefined ? null : classified.llmCalls,
        residentPromptChars: loopLedger.residentPromptChars,
        verifier: {
          calls: verifierCalls,
          firstVerdict: lastVerdict ? (lastVerdict.pass ? 'pass' : 'fail') : null,
          target: lastVerdict && !lastVerdict.pass ? lastVerdict.target : null,
          reinjected,
          afterReinject: !reinjected ? 'skipped' : runnable ? (oracleOk ? 'green' : 'red') : 'no-oracle',
          recheck,
        },
        ...(conductorInfraFailure !== undefined ? { conductorInfraFailure } : {}),
        // #205: 冻结点写进卡账本, 这里提到顶层 (与 criterionFreeze 同款分层)。缺席 = 没跑这道探针。
        ...(loopLedger.criterionDirection !== undefined ? { criterionDirection: loopLedger.criterionDirection } : {}),
        // #205 ①: 判据自证裁决进 **loop** 而不是结果顶层 —— 只有 loop 整份 JSON 出得了 bench 容器
        // (code80-p6 实测: 挂顶层时 68 题全缺席)。顶层那份保留, 给非 bench 调用方读。
        ...(classified.acceptanceProbe ? { acceptanceProbe: classified.acceptanceProbe } : {}),
        // 勘察读数 (D-4): 同样只有挂在 loop 上才出得了 bench 容器。缺席 = 没跑勘察, 不是全 0。
        ...(survey ? { criterionSurvey: { ...survey.facts, ...(survey.why ? { why: survey.why } : {}) } } : {}),
        // 三候选共识读数 (2026-09-05 D-5): 同一条理由挂在 loop 上。缺席 = 没开共识 (开关默认关), 不是一致性为 0。
        ...(classified.criterionConsensus ? { criterionConsensus: classified.criterionConsensus } : {}),
        // W1 勘察包读数 (2026-09-06): 装配期写在 ConductorCardLedger 上, 这里提到 loop (同款分层)。缺席 = 没装配编排循环。
        ...(loopLedger.surveyPack ? { surveyPack: loopLedger.surveyPack } : {}),
        // R7 规格包读数 (2026-09-07): 同一条理由挂在 loop 上。缺席 = 开关没开 / 没走真分类那条路
        // (三态见 LoopLedger.specPack); 在场且 samples:0 = 采了没成, 两者别并掉 (§静默坑 1)。
        ...(specPack ? { specPack: { ...specPack.facts, ...(specPack.why ? { why: specPack.why } : {}) } } : {}),
        // 召回读数 (2026-09-11): 缺席 = 没开; 在场 admitted 0 = 开了没命中 (why 在场)。
        ...(goalRecall ? { goalRecall: goalRecall.facts } : {}),
        // R4 异族先写判据读数 (2026-09-06): 同一条理由挂在 loop 上。缺席 = 开关没开 (三态见 LoopLedger.criterionAuthor)。
        ...(loopLedger.criterionAuthor ? { criterionAuthor: loopLedger.criterionAuthor } : {}),
        // R5 并行实装扇出读数 (2026-09-06): 同一条理由挂在 loop 上。缺席 = 没扇出 (三态见 LoopLedger.fanout)。
        ...(loopLedger.fanout ? { fanout: loopLedger.fanout } : {}),
        // W3 runner 就绪预检 (2026-09-06): 同一条理由挂在 loop 上。恒写 —— 预检在这条路上一定跑过,
        // 「不适用」由 `runner: null` 表达, 不用缺席表达 (§静默坑 1)。
        runnerReady,
        // #205 第三刀: 执行体改了几个仓库自带的测试文件 (环外信号, 只记账不拦)。
        // `git cat-file -e HEAD:<path>` 判「改动前存在」; 非 git 仓 / git 调不通 → null, 不是 0。
        existingTestsTouched: countExistingTestsTouched(
          loopLedger.dispatches.flatMap((d) => d.filesTouched ?? []),
          loopLedger.criterionFreeze?.files ?? [],
          {
            existsInHead: (rel) => {
              try {
                execFileSync('git', ['cat-file', '-e', `HEAD:${rel}`], { cwd: config.cwd, stdio: 'ignore' });
                return true; // 退 0 = HEAD 里有这个路径 = 改动前就存在
              } catch (err) {
                // 退出码非 0 有两种成因, git 自己分不开地都抛 —— 用 stderr 分:
                // 「不是 git 仓」= 整个读数算不出来 (null); 「HEAD 里没这个路径」= 真的是新文件 (false)。
                const msg = String((err as { stderr?: Buffer }).stderr ?? err);
                return /not a git repository|fatal: not a git/i.test(msg) ? null : false;
              }
            },
          },
        ),
        // D-6 证伪读数: 同样只有挂在 loop 上才出得了 bench 容器。缺席 = 开关没开, 不是「跑了没查出来」。
        ...(falsify ? { falsify } : {}),
        cards: {
          calls: loopLedger.calls,
          ok: loopLedger.ok,
          rejectedSchema: loopLedger.rejectedSchema,
          help: loopLedger.help,
          rejectedCompile: loopLedger.rejectedCompile,
          childRunError: loopLedger.childRunError,
          byCard: loopLedger.byCard,
          readOnlyShellBlocked: loopLedger.readOnlyShellBlocked,
        },
        dispatches: loopLedger.dispatches,
        ...(dispatchesBeforeReinject !== undefined ? { dispatchesBeforeReinject } : {}),
        ...(loopLedger.criterionFreeze
          ? { criterionFreeze: { ...loopLedger.criterionFreeze, ...(loopLedger.criterionFreeze.hashes ? { tampered: checkCriterionFreeze(loopLedger.criterionFreeze, config.cwd) } : {}) } }
          : {}),
      }
    : undefined;
  const result: RunGoalResult = {
    goal,
    tier,
    acceptance,
    stages,
    outcome,
    ...(loop ? { loop } : {}),
    // P3 S6b (D-1): 路径身份。判定顺序 = D-17 的优先级 (sdd-direct > playbook-direct > loop)。
    // 互斥闸已在 runGoal 入口 (config.sddPath && config.playbook) 拒, 此处不会同时为真。
    path: sdd && runnable ? 'sdd-direct' : config.playbook ? 'playbook-direct' : 'orchestrating-loop',
    ...(specPath ? { specPath } : {}),
    sources,
    repoContext,
    converged,
    criteria: { judge: judgeSaidOk, oracle: oracleOk, ...(criterionHarnessInconclusive ? { oracleInconclusive: true as const } : {}) },
    rounds: roundCount,
    reusedNodes,
    ...(blocked ? { blocked } : {}),
    ...(budgetStopped ? { budgetStopped } : {}),
    ...(cancelledReason ? { cancelled: cancelledReason } : {}),
    ...(verifyDelta ? { verifyDelta } : {}),
    ...(writeSet ? { writeSet } : {}),
    ...(writeScope ? { writeScope } : {}),
    ...(sliceCoverage ? { sliceCoverage } : {}),
    ...(designReview ? { designReview } : {}),
    ...(rubricVerdict ? { rubricVerdict } : {}),
    ...(rubricRejection ? { rubricRejection } : {}),
    // 2026-08-29 否决边契约: 四位读数各自缺席即"不适用", 不兜底 (仓规坑 ①)。
    terminalLabel,
    // D-1: 只在收敛判定成立的跑上挂 —— 没收敛时这道闸不适用, 挂一个 checked:false 会让
    // 「闸不适用」与「查不到」混成一格 (仓规坑 ①)。
    ...(convergedByCriteria
      ? { zeroWrite: { checked: zeroWrite.checked, ...(zeroWrite.zero !== undefined ? { zero: zeroWrite.zero } : {}), ...(zeroWrite.why ? { why: zeroWrite.why } : {}) } }
      : {}),
    ...(criterionRed ? { criterionRedCause: criterionRed.detail } : {}),
    ...(bestGreenFloor ? { bestGreenFloor } : {}),
    // INV-1: 否决从"物理销毁"降为"信息动作" —— 那条信息必须到得了人手上, 不能只活在引擎日志里。
    ...(lastVerdict && !lastVerdict.pass ? { verifierDissent: lastVerdict.reason } : {}),
    // 窄复审判词与首判判词**分两个字段**: 合并会让读的人分不清"哪条是第二只眼说的"。
    // pass 时也带 —— 那是「为什么算修好了」的唯一记录, 丢掉它 recheck:'pass' 就成了无据的一个字。
    ...(recheckReason !== undefined ? { recheckDissent: recheckReason } : {}),
    // #205: 判据自证裁决随结果出容器 (见字段注 —— 账本那条路在 bench 上读不到)。
    ...(classified.acceptanceProbe ? { acceptanceProbe: classified.acceptanceProbe } : {}),
    ...(criterionRebuild ? { criterionRebuild } : {}),
   };
  // D-2 散雾出口 (切片 1): 拿到 map 句柄才开票; 没配 = 这一行直接返回, 行为逐字节不变 (INV-1)。
  // 放在 result 成形之后: 票身要的原因/未决/发现物全从终态读, 不从中途状态猜。
  openRunTickets(result, exec, config);
  // #160 D-2 (s1): 终态前发 verified (判据真身, 不是 converged; INV-2)。
  // 只在 executable 验收时发 (非可执行没机器结论, 不编)。同一 fail-open 性格: 写板失败不掀桌,
  // run 照跑。verdict = oracleOk ∨ oracleRecheckGreen (#165①: 判据被级联压死没跑时, 复验绿也算 pass)，
  // note = 验收命令 + accept 节点 status 指纹 (板层 serializeEntry 自截 500B)。
  if (runnable) {
    try {
      const verdict: 'pass' | 'fail' = oracleOk || oracleRecheckGreen ? 'pass' : 'fail';
      appendBoard(boardRoot, {
        v: 1,
        ts: new Date().toISOString(),
        runId: boardRunId,
        event: 'verified',
        verdict,
        note: `${runnable.command} → ${acceptLeaf?.status ?? '没跑'}`,
      });
    } catch (e) {
      console.error(`[run-goal] board verified 写失败 (不影响 run): ${String(e)}`);
    }
  }
  emitBoard('terminal', outcome);
  return result;
}
