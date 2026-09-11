/**
 * src/mcp/assemble —— omd MCP 工具面装配 (SDD 2026-07-19 omd-mcp-server, P1 期 v1 工具面)。
 *
 * 把 src/mcp/tools/* 的纯函数工厂接上生产接缝 (纯组装, 零业务逻辑; 逻辑全在被注入的接缝里):
 *   - dag 四工具: 真引擎 {runExecutorDag, runExecutorDagWithPlan} + 新 RunRegistry + cwd。
 *     engine config 与 execute-extension 已解析形状同款: conductor/leaf/agent 模型从 env 角色矩阵读
 *     (OMD_ITER_* > runtime 坐标 OMD_RUNTIME_PROVIDER:OMD_RUNTIME_MODEL —— 解析序镜像
 *     resolveConductorDefault, 但 env 可注入故此处自带纯函数版),
 *     agentRunner = createAgentLeafRunner({cwd, hashlineEdit:false}) (tui 同款真改文件叶子;
 *     行锚定编辑 2026-08-18 起默认关, 见 readings/2026-08-18-hashline-ab.md),
 *     commandRunner = tui 同款白名单 (D-10: fail-closed 闸在引擎层, 入口不新增权限)。
 *   - memory 两工具: createOmdMemory (OMD_MEMORY_PATH ?? .omd/memory.db + HOST_SAFEGUARD, 同 tui 默认;
 *     写入仍过 validateFactWrite 校验闸, D-5)。
 *   - research 工具: 现有 researchFanout 接缝 (harness/research/fanout) 适配成 MCP 三段返回
 *     {runId, reportPath, summary} (报告全文写入磁盘 .omd/research/, D-8 宽出)。
 *   - fleet 四工具: createFleetTools (dag_review/slim/deepen/debug 异步子进程;
 *     spawn 接缝默认 Bun.spawn; runRegistry/cwd 同现有)。
 *   - runs 工具: createRunsTools (dag_runs 同步列表: 内存 registry ∪ 磁盘 continuity 合并去重)。
 *
 * 可测: 全部 deps 可选覆盖 (测试传 fake 引擎/内存记忆/fake research, 零网络零磁盘)。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { OmdMcpTool } from './server';
import { RunRegistry } from './run-registry';
import { CheckpointManager } from '../harness/continuity/checkpoint-manager';
// 生产 jail 的可用性判据 —— 与对话位围栏**共用同一个已缓存的真探针** (2026-08-21, 见下方 jailRoot 注)。
import { probeShellSandbox } from '../harness/hooks/shell-sandbox';
import { HudMirror } from '../hud/mirror';
import { createDagTools, type DagEngine } from './tools/dag-tools';
import type { BranchStrategy } from '../harness/run-worktree';
import { createMemoryTools } from './tools/memory';
import { createPathfinderTools, type PathfinderToolDeps } from './tools/pathfinder';
import { createDagResearchTool, type ResearchFanout } from './tools/research';
import { createGoalTool } from './tools/goal';
import { runGoal } from '../harness/goal/run-goal';
import { createFleetTools, type SpawnFn } from './tools/fleet';
import { AGENT_DEFAULT_FANOUT, CPU_FALLBACK_FANOUT, effectiveFanout, resolveProviderCap } from '../harness/fleet';
import { createRunsTools } from './tools/runs';
import { createInterveneTools } from './tools/intervene';
import { createConfigTools } from './tools/config-tools';
import { createComposeTools } from './tools/compose';
import { createWebTools, createDistillTools } from './tools/web';
import { createPlansTool } from './tools/plans';
import { createModelRouterFromEnv, type ModelRouterHandle } from '../harness/model-router';
import { createModelQueryExpander, createWebStackFromEnv, retrieveWeb } from '../harness/web';
import { researchWebFanout } from '../harness/research/web-fanout';
import type { ResearchLeafRunner } from '../harness/leaf-runners';
import { createModelSourceDistiller } from '../harness/web/distill-source';
import { createChallengerDistiller } from '../harness/web/distill-challenger';
import { createPlanLedger, type PlanLedger } from '../harness/plan/plan-ledger';
import { createDagRecorder, type DagRecorder } from '../harness/dag/dag-record';
import { createRunStore } from './run-store';
import { createOwnerInbox, type OwnerInbox } from './owner-inbox';
import { createTriageTools } from './tools/triage';
import { runExecutorDagWithPlan } from '../harness/dag/engine';
import { runOrchestratingLoop } from '../harness/goal/loop-run';
import type { DagNodeEvent, ExecutorDagConfig } from '../harness/dag/types';
import { extNodeEventSink } from '../harness/ext-tools';
import type { ConductorPlan } from '../harness/conductor-plan';
import { prunePass } from '../harness/plan-passes/prune-pass';
import { dedupPass } from '../harness/plan-passes/dedup-pass';
import { stampPass } from '../harness/plan-passes/stamp-pass';
import { evidencePass } from '../harness/plan-passes/evidence-pass';
import { describeRenderProbe, detectRenderCommand } from '../harness/plan-passes/render-command';
import { triggerPass } from '../harness/plan-passes/trigger-pass';
import { loadAgentTemplates } from '../harness/agent-templates';
import { modelFamily } from '../model/channels';
import { isStrongCoord } from '../model/model-ratings';
import {
  resolveRoleModelConfigured,
  resolveMultimodalPool,
  resolveSeatAdvisor,
  resolveSeatThinking,
  resolveConfiguredPools,
  type OmdNode,
  type ThinkingLevel,
} from '../model/role-models';
import { createAgentLeafRunner } from '../harness/agent-leaf';
import { withAgyLeaf } from '../harness/agy-leaf';
import { createLeafTranscriptSink } from '../harness/leaf-transcript';
import { runtimeAllowlistForRoot } from '../harness/env-facts';
import type { SpinRung2StampPools } from '../harness/dag/spin-rung2';
import { loadRepoChecksManifest } from '../harness/repo-checks-manifest';
import type { AnyOmdTool } from '../harness/agent-tools';
import { resolveVerification } from '../harness/verifier';
import { allowlistForRoot, createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } from '../harness/command-leaf';
import type { AgentLeafRunner, CommandLeafRunner } from '../harness/leaf-runners';
import { createOmdMemory, type OmdMemory } from '../harness/memory';
import { resolveMemoryDbPath } from '../harness/memory/db-path';
import { HOST_SAFEGUARD } from '../memory/safeguards/namespaces';
import type { ResearchFanoutResult } from '../harness/research/fanout';
import { logger } from '../harness/logger';
import { applyToolRenames } from './tool-renames';
import { createConductorChatTool, type ConductorChatDeps } from './tools/chat';
import { checkWeeklyBudget, usageLedgerDir } from './budget';
import { createOmdSessionStore, type OmdSessionStore } from '../harness/chat/session-store';
import { notifyOwner, type NotifyDeps } from '../harness/notify';

/**
 * 生产引擎接缝 (真 DAG 引擎)。`runExecutorDag` 这一位 = `run` 的任务入口: 2026-09-03 起走编排循环
 * (任务原文 → conductor 节点 + 七张卡, 无 accept 节点; loop-run.ts), 不再是引擎里的 v1 规划式 conductor
 * (`engine.runExecutorDag` 只剩 iterate.ts / eval oracles 在用)。预构造图入口 `runExecutorDagWithPlan` 不变。
 */
const PROD_ENGINE: DagEngine = { runExecutorDag: runOrchestratingLoop, runExecutorDagWithPlan };

/**
 * owner 推式桥接缝 (SDD F1 片 2) —— 引擎事件 → ownerNotifyEvent 翻译器。
 * 与 `extNodeEventSink` (ext-tools.ts:126) 同型: 单回调形状, 组合进
 * `onNodeEventComposed` 不替换, fail-open (观察者不扰动被观察者)。
 *
 * 翻译表 (D-2 / D-5):
 *   - `replan`   → escalation (round, poisoned 计数)
 *   - `budget`   → budget-half (axis, spent, cap)
 *   - 其余 type (planned/start/settle/verdict/...) → 静默忽略 (INV-10 additive)
 *
 * 词表冻结于 notify.ts 的 NOTIFY_EVENTS; 加新事件型时**改这里与片 1 同处同步**。
 * 测试: 注入 `deps` (含 readConfigText / spawn) —— 零 fs 零真子进程。
 */
export function ownerNotifySink(cwd: string, deps?: NotifyDeps): (runId: string, e: DagNodeEvent) => void {
  const notifyDeps: NotifyDeps = {
    readConfigText: deps?.readConfigText ?? (() => {
      // 生产默认读 <cwd>/.omd/config.json (与 config-discovery.omdConfigPath 同形态)。
      // 缺席 / IO 错 → null (notify.ts readNotifyConfig 内部把它转成静默 no-op, INV-1)。
      try {
      const p = join(cwd, '.omd', 'config.json');
      if (!existsSync(p)) return null;
      return readFileSync(p, 'utf8');
    } catch (err) {
      // 通知配置读不到 = 视同未配 (notify.ts 内部还会再判一次, 双保险); 证据留一行
      // 不然 owner 跑了看不见通知还以为 hook 没接 (§静默坑 2)。
      logger.debug({ err: String(err) }, '[omd/assemble] owner notify config 读不到 (按未配处理)');
      return null;
    }
    }),
    ...(deps?.spawn ? { spawn: deps.spawn } : {}),
    ...(deps?.now ? { now: deps.now } : {}),
  };
  return (runId, e) => {
    try {
      if (e.type === 'replan') {
        notifyOwner({
          event: 'escalation',
          runId,
          at: new Date().toISOString(),
          round: e.round,
          poisoned: e.poisoned.length,
        }, notifyDeps);
      } else if (e.type === 'budget') {
        notifyOwner({
          event: 'budget-half',
          runId,
          at: new Date().toISOString(),
          axis: e.axis,
          spent: e.spent,
          cap: e.cap,
        }, notifyDeps);
      }
      // 其余事件型 → 静默 (INV-10 additive 兼容)。
    } catch (err) {
      // notifyOwner 自己 fail-open; 这一层兜底是防 notify.ts 之外的错 (例如构造 payload 抛)。
      logger.debug({ err: String(err) }, '[omd/assemble] ownerNotifySink 抛错 (已吞, 不扰动 run)');
    }
  };
}

/**
 * S2 (2026-08-25, 片 2) — rung 2 单节点选择器的池源: 装配层导出的同一份 stampPools。
 *
 * engine 侧 runNode 在 rung 2 派发前调 `pickHigherTierSeat` 需要这份池 (SDD D-5); 而
 * 池的座位推导与 stamp pass 共享一份 `roleCoord` 解析, 必须在装配层导出才能避免
 * engine 重新解一遍出第二个答案 (INV-MODEL-1 同款纪律)。函数纯化 (只读 env, 不读 IO)
 * 是片 2 的最小注入接口。
 */
export function resolveSpinRung2StampPools(env: NodeJS.ProcessEnv): SpinRung2StampPools {
  const roleCoord = (n: OmdNode): string => resolveRoleModelConfigured(n, { env }).model;
  const uniqCoords = (xs: string[]): string[] => [...new Set(xs.filter((x) => x.includes(':')))];
  return {
    strong: uniqCoords([roleCoord('judge'), roleCoord('reason'), roleCoord('verifier')]),
    mid: uniqCoords([roleCoord('leaf'), roleCoord('agent'), roleCoord('overflow')]),
    cheap: uniqCoords([roleCoord('lens'), roleCoord('expand'), roleCoord('distill')]),
  };
}

/** assemble 的可选依赖覆盖 —— 省略任何一项 = 该项用生产默认。 */
export interface AssembleOmdMcpDeps {
  /** env 注入 (默认 process.env) —— 角色矩阵解析可测, 测试不必污染进程 env。 */
  env?: NodeJS.ProcessEnv;
  /** 工作目录 (默认 process.cwd()): 工具作用域 + agent/command runner 基准 + 报告写入磁盘的根目录 (D-10)。 */
  cwd?: string;
  /** ext 工具 (S4): 调用方 (cli.ts / goal.ts, 本就在 async 上下文) 按 run cwd 预加载后注入。空数组 = 不挂 (D-4 零变化)。 */
  extTools?: AnyOmdTool[];
  /** DAG 引擎接缝 (默认真 runExecutorDag/runExecutorDagWithPlan)。 */
  engine?: DagEngine;
  /** run 注册表 (默认新 RunRegistry, 纯内存; 三段式 runId 生命周期的载体, D-3)。 */
  runRegistry?: RunRegistry;
  /** 记忆接缝 (默认 createOmdMemory tui 同款路径 + HOST_SAFEGUARD, D-5 共库)。 */
  memory?: OmdMemory;
  /** research 接缝 (默认 createDefaultResearchFanout: 真 researchFanout + 报告写入磁盘)。 */
  researchFanout?: ResearchFanout;
  /** agent-kind leaf 执行器 (默认 createAgentLeafRunner({cwd, hashlineEdit:false}))。 */
  agentRunner?: AgentLeafRunner;
  /** command-kind leaf 执行器 (默认 tui 同款白名单 bun/tsc/npx, 180s 超时)。 */
  commandRunner?: CommandLeafRunner;
  /** research-kind leaf 执行器 (默认 createDefaultResearchRunner: 真 web; 无 search key → 不挂)。 */
  researchRunner?: ResearchLeafRunner;
  /** engine config 追加覆盖 (在 env 角色矩阵解析结果之上, caller 显式指定优先)。 */
  configOverrides?: Partial<ExecutorDagConfig>;
  /** pathfinder 工具接缝覆盖 (测试传 fake executeSlice/dispatchFrontier)。 */
  pathfinder?: Partial<Pick<PathfinderToolDeps, 'executeSlice' | 'dispatchFrontier'>>;
  /** fleet spawn 接缝 (测试注入 fake; 生产默认 Bun.spawn)。 */
  spawn?: SpawnFn;
  /**
   * **进程内节点事件旁路** (TUI SDD §6, 切片 S11): TUI 的 HUD 靠它拿活体进度。
   * 给了不改任何执行行为, 只是在 hud 镜像写盘之后多转一份。省略 = 不转。
   */
  onNodeEvent?: (runId: string, e: DagNodeEvent) => void;
  /** plan-memory 账本接缝 (测试注入 :memory:; 默认 .omd/plan-ledger.db)。 */
  ledger?: PlanLedger;
  /** DAG 运行留痕接缝 (测试注入 :memory:; 默认 .omd/dag-runs.db)。 */
  recorder?: DagRecorder;
  /**
   * B-2 bandit 选型路由接缝 (测试注入 `:memory:`; 默认 `createModelRouterFromEnv` → `.omd/model-router.db`)。
   *
   * 与 `recorder` **同一族缺陷的第五例**, 2026-08-30 实测补上: 默认路径是 `.omd/model-router.db`
   * 这个**进程 cwd 相对**的串 (model-router.ts:90), 于是任何调 `assembleOmdMcpTools` 的测试
   * 都会去开**真仓那一个库**。宿主上只要还有一个活的 omd 进程握着它 (实测: bench 模型桥
   * `scripts/bench-bridge.ts`), 就并发出 `SQLiteError: disk I/O error` 的**假红** ——
   * 红的是测试基建, 不是被测代码。
   *
   * `chat-seat.test.ts:18` 的注早把这个坑写清楚了, 但只堵了 `recorder` 那一个口:
   * 同一次 `assembleOmdMcpTools` 里 router 也开库, 而它当时**没有注入口**, 堵不了。
   * 症状是间歇的 (取决于外部进程有没有正在写), 所以它以"全量偶尔 1 fail、单跑必绿"的形态
   * 存在了一段时间 —— 见 `docs/plan/2026-08-30-next-session.md` §1 那条未定位的红。
   */
  router?: ModelRouterHandle;
  /** owner 收件箱接缝 (S3; 测试注入 :memory:; 默认与 runs.db 同库)。 */
  inbox?: OwnerInbox;
  /** 会话持久层接缝 (S1 conductor_chat; 测试注入临时目录 store, 默认 createOmdSessionStore(cwd))。 */
  chatStore?: OmdSessionStore;
  /** conductor_chat 的 agent 循环接缝 (真循环要真模型; 测试注入 fake)。 */
  chatLoopFn?: ConductorChatDeps['loopFn'];
  /**
   * 自主环接缝 (默认真 `runGoal`)。
   *
   * ⚠ **`engine` 覆盖不到 `dag_goal`** —— 它走自己的 `runGoal`, 而 `runGoal` 内部才调
   * `runExecutorDagWithPlan`。于是"注入 fake engine 就能测 goal 这条路"是错的, 装配层的
   * goal 分支此前**没有任何注入口**(2026-07-31 写 S3 装配集成测试时撞出来的)。
   */
  runGoal?: typeof runGoal;
}

/**
 * engine config 的模型三件套 —— **全部经单一 resolver** (INV-MODEL-1, P0 2026-07-28)。
 *
 * 此前这里是第 5 套并行解析器: OMD_ITER_* > OMD_RUNTIME_* > config。那个序把 env 排在 config
 * **之上**, 于是"改了 .omd/config.json 却还是老 conductor" —— 同一个座位在引擎路与 dag_run 路
 * 解出两个答案。现在 OMD_ITER_* 是座位链里的 env 别名、OMD_RUNTIME_* 是 defaultModel 层,
 * 两条路同解。resolveNode 仍可注入 (测试)。
 *
 * @throws {SeatUnresolvedError} conductor/leaf/agent 任一座位一层都没配 (INV-MODEL-5 计划期响亮失败)。
 */
export function resolveEngineModels(
  env: NodeJS.ProcessEnv,
  resolveNode: typeof resolveRoleModelConfigured = resolveRoleModelConfigured,
): {
  conductorModel: string;
  leafModel: string;
  agentLeafModel?: string;
} {
  return {
    conductorModel: resolveNode('conductor', { env }).model,
    leafModel: resolveNode('leaf', { env }).model,
    agentLeafModel: resolveNode('agent', { env }).model,
  };
}

/**
 * 生产 memory 接缝 (MCP 装配与 TUI 对话位**同一真源**, S0 共库): resolveMemoryDbPath + HOST_SAFEGUARD。
 *
 * ⚠ 2026-08-19 (#206) 由 `UNIVERSAL_SAFEGUARD` 换成 `HOST_SAFEGUARD`(= universal + continuity)。
 * 原因是读路**也**走 schema:`sinkCheckpoint` 把 continuity 写进的正是这个共享库,而 universal
 * 装配没有 continuity 分支 ⇒ `listCheckpoints` 每次 parse 抛、被 `catch` 吞成空列表。
 * 判据在 `test/core/session-continuity-trigger.test.ts` 的「读面装配」那组(换回 universal 即红)。
 */
export function createDefaultMemory(env: NodeJS.ProcessEnv): OmdMemory {
  const memoryPath = resolveMemoryDbPath(env);
  mkdirSync(dirname(memoryPath), { recursive: true });
  return createOmdMemory({ path: memoryPath, safeguard: HOST_SAFEGUARD });
}

/**
 * 生产 research **节点**执行器 (D-6, P1): `executor:'research'` 节点经此跑 —— **真 web**
 * (researchWebFanout: 检索 → 抓正文 → 蒸馏 → 多镜头扇出判优), 不是 dag_research 那条纯模型档。
 *
 * 为什么不复用 agent 节点带 web 工具: agent 节点的 `DEFAULT_EXTENSION_DIRS=[]` 没有 web,
 * 拿到的"引用"来自模型记忆 = 假 grounded (本 SDD D-6 的实证)。
 *
 * 无搜索 provider (零 TAVILY/ANYSEARCH/SEARXNG) → 返 undefined = **不挂 runner**,
 * research 节点因此响亮失败, 而不是静默退化成没有 web 的 leaf。
 */
export function createDefaultResearchRunner(deps: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 测试注入 (默认真 researchWebFanout)。 */
  _webFanout?: typeof researchWebFanout;
  /** 测试注入 (默认真 createWebStackFromEnv)。 */
  _webStack?: typeof createWebStackFromEnv;
}): ResearchLeafRunner | undefined {
  const { cwd, env } = deps;
  const stackFn = deps._webStack ?? createWebStackFromEnv;
  const fanoutFn = deps._webFanout ?? researchWebFanout;
  let stack: ReturnType<typeof createWebStackFromEnv>;
  try {
    stack = stackFn(env);
  } catch (e) {
    logger.warn(
      { err: (e as Error).message },
      "[omd/mcp] 无 search provider → executor:'research' 节点不可用 (设 TAVILY_API_KEY / ANYSEARCH_API_KEY / SEARXNG_URL)",
    );
    return undefined;
  }
  return async (input) => {
    const runId = input.runId ?? randomUUID(); // S2: dag_research 进程化后 runId 由调用方透传, 报告与 registry 同源
    const res = await fanoutFn(stack, input.question, {
      // council: 按问题自适应出镜头 (分解器职责); 显式 false = 固定档单维, 省一次 conductor 调用。
      council: input.council !== false,
      // deep 档: 种子作者化 (3-4 个互补角度各自检索) —— dag_research 的 super 旗标落到这里。
      ...(input.deep ? { authorSeeds: true, mode: 'aggregate' as const } : {}),
      conductorModel: resolveRoleModelConfigured('conductor', { env }).model,
      lensModel: resolveRoleModelConfigured('lens', { env }).model,
      reasonModel: resolveRoleModelConfigured('reason', { env }).model,
      expander: createModelQueryExpander({}),
      distiller: createModelSourceDistiller({}),
      // 内环的界 (INV-GOAL-4): 调用方给多少跑多少, 缺省单轮; schema 已钳 ≤4。
      rounds: input.rounds ?? 1,
      // 仓内腿默认开: research 的 leaf 是 inproc 看不见仓库, 轮间那次确定性检索是
      // "这个在我们仓里怎么实现的"唯一能落地的地方。
      repoCwd: cwd,
      ...(input.k ? { k: input.k } : {}),
      // A1: lensCount = 镜头数/广度 (与 k = 召回条数分开) → authorFanoutSpec 透传。
      // 省略 = conductor 自定, 零回归 (WebFanoutOpts.lensCount 缺省 undefined 同原行为)。
      ...(input.lensCount !== undefined ? { lensCount: input.lensCount } : {}),
      ...(input.groundTruth ? { anchors: [{ label: '上游节点产出', text: input.groundTruth }] } : {}),
      onWarn: (m: string) => logger.warn({ warn: m }, '[omd/research-node]'),
    });
    // INV-GOAL-2 的证据面 = **真抓到正文的** URL (搜到但没抓下来的不算痕迹)。
    // 三个来源都要算 —— 只数主检索会把多轮档的证据漏掉大半:
    //   ① 主检索  ② 种子 query 各自的检索 (deep 档)  ③ 轮 2+ 的 probe 补抓 (secondPass.probedUrls,
    // 那批是"上一轮冠军引用了但没读过"的缺料, 恰恰是多轮研究**新增**的证据)。
    const bodied = (r: { sources: { url: string; body?: string }[] }): string[] =>
      r.sources.filter((x) => x.body).map((x) => x.url);
    const sources = [
      ...new Set([
        ...bodied(res.retrieval),
        ...(res.seedRetrievals ?? []).flatMap(bodied),
        ...res.fanout.secondPass.flatMap((sp) => sp.probedUrls),
      ]),
    ];
    const reportDir = join(cwd, '.omd', 'research');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, `${runId}.md`);
    // 报告里把轮次留痕摊开 (哪一轮补了什么缺口、抓了哪几条) —— 多轮档的"第二轮到底干了什么"
    // 不该只活在日志里。
    const roundTrace = res.fanout.secondPass.length
      ? `\n## 轮次留痕 (共 ${res.fanout.roundsRun} 轮)\n\n${res.fanout.secondPass
          .map(
            (sp) =>
              `### 第 ${sp.round} 轮\n缺口: ${sp.gaps.map((g) => g.key).join(' · ') || '(无)'}\n补抓 (web): ${sp.probedUrls.map((u) => `\n  - ${u}`).join('') || ' (无)'}\n命中 (仓内): ${(sp.repoHits ?? []).map((h) => `\n  - ${h}`).join('') || ' (无)'}`,
          )
          .join('\n\n')}\n`
      : '';
    writeFileSync(
      reportPath,
      `${renderResearchReport(input.question, runId, res.fanout)}${roundTrace}\n## 来源 (真抓到正文)\n\n${sources.map((u) => `- ${u}`).join('\n')}\n`,
    );
    // usage = 整轮各模型 in/out 之和 (账本口径与 leaf 一致 —— 一个 research 节点是几十次调用)。
    const usage = Object.values(res.fanout.costStats.perModel).reduce(
      (acc, m) => ({ in: acc.in + m.in, out: acc.out + m.out }),
      { in: 0, out: 0 },
    );
    return { text: res.fanout.final, usage, sources, reportPath };
  };
}

/** 研究报告全文 (零丢失, D-8: 客户端上下文只拿 summary, 细节自己 Read 写入磁盘的文件)。 */
function renderResearchReport(question: string, runId: string, result: ResearchFanoutResult): string {
  const sections = [
    `# omd research — ${question}`,
    '',
    `- runId: ${runId}`,
    `- leafCount: ${result.leafCount}`,
    `- cost: $${result.costStats.totalUsd.toFixed(4)} (cache 省 $${result.costStats.totalSavingsUsd.toFixed(4)})`,
    '',
    '## 最终方案',
    '',
    result.final,
    '',
    '## 镜头冠军',
    '',
    ...result.lensChampions.map((c) => `### ${c.key}\n\n${c.text}`),
    '',
    '## 融合分析 (共识/矛盾/缺口/洞察/盲点)',
    '',
    result.fusionAnalysis,
    '',
    '## judge 评审',
    '',
    ...result.judgeCritiques.map((c) => `### ${c.key}\n\n${c.text}`),
    '',
  ];
  return sections.join('\n');
}

/**
 * 装配 v1 全工具面: dag_run/dag_run_plan/dag_status/dag_result + dag_research +
 * memory_recall/memory_remember + dag_review/dag_slim/dag_deepen + dag_runs +
 * config 工具族 (omd_set_key/omd_apply_preset/omd_set_role/omd_config_status/omd_toggle_hud)。
 * 纯组装: 解析 deps → 调各工厂 → 拍平返回。
 */
export function assembleOmdMcpTools(deps: AssembleOmdMcpDeps = {}): OmdMcpTool[] {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  // D4 (#271): 仓规检查清单一次加载 (INV-D4-3) —— 三处装配点 (assembly-time agent runner /
  // buildDefaultConfig 隔离档 agent runner / buildDefaultConfig config.repoChecks) 共用同一份,
  // 不各读各的 (三份必漂)。文件不存在 → [] (零回归锚点); 格式坏 → throw (fail-loud, INV-D4-2)。
  const repoChecks = loadRepoChecksManifest(cwd);
  const extTools = deps.extTools ?? [];
  const engine = deps.engine ?? PROD_ENGINE;
  // S2: registry 带上身份持久面 —— MCP server 是 stdio + 客户端消失即自杀, 「重启」是每次会话
  // 结束都发生的事。此前一重启就没人记得那个 runId 存在过 (而 checkpoint 一直在盘上), 于是
  // 「掉线了之后接着跑」缺的正是这一格。构造时 hydrate; 属主进程已死的 running 记录会被如实
  // 判成"被打断", 不会挂成一个永远在跑却没人跑它的幽灵。
  const runRegistry =
    deps.runRegistry ?? new RunRegistry(undefined, { store: createRunStore({ path: join(cwd, '.omd', 'runs.db') }) });
  const memory = deps.memory ?? createDefaultMemory(env);
  // 记忆卫生 (TUI prune-scheduler parity — MCP 长驻进程 D-9): 默认 memory 时启动即 TTL 扫一次
  // + 每 6h 一次。注入 memory 的调用方 (测试/宿主) 自管卫生; OMD_MEMORY_PRUNE=0 关闭。
  // 定时器 unref: 不阻进程退出 (stdin EOF 干净退出语义不变)。prune 失败永不砖 server。
  if (!deps.memory && env.OMD_MEMORY_PRUNE !== '0') {
    const sweep = (): void => {
      try {
        memory.prune();
      } catch {
        /* 卫生失败不砖 */
      }
    };
    sweep();
    const timer = setInterval(sweep, 6 * 3600 * 1000);
    timer.unref?.();
  }
  // dag_research = **真 web** (与 executor:'research' 节点同一条管线, 不再有"纯模型档"分身)。
  // 此前这里是 createDefaultResearchFanout: groundTruth 直接等于 question, 零检索 —— 一个叫
  // research 的工具做的正是 D-6 判死的事 (拿模型记忆当调研)。无 search provider → 不挂 runner,
  // 工具响亮拒绝, 而不是静默降级成"看起来像调研的一段话"。
  const researchFanout: ResearchFanout =
    deps.researchFanout ??
    (async ({ question, council, super: superMode, k, rounds, runId }) => {
      if (!researchRunner) {
        throw new Error(
          '[dag_research] 无 search provider → 没有 web 就没有调研 (设 TAVILY_API_KEY / ANYSEARCH_API_KEY / SEARXNG_URL)。' +
            '要纯模型的多视角综合请用 dag_run, 别把它当调研。',
        );
      }
      const r = await researchRunner({
        question,
        ...(runId ? { runId } : {}),
        ...(k ? { k } : {}),
        rounds: rounds ?? 1,
        ...(council === false ? { council: false } : {}),
        ...(superMode ? { deep: true } : {}),
      });
      return {
        // 透传的 runId 优先 (报告已按它命名); 没透传 (老调用方/自定义 runner 不认) → 回退文件名。
        runId: runId ?? basename(r.reportPath ?? '', '.md'),
        reportPath: r.reportPath ?? '',
        summary: `${r.sources.length} 个来源真抓到正文\n${r.text.slice(0, 600)}`,
      };
    });
  // 长任务叶子超时: OMD_LEAF_TIMEOUT_MS 覆 240s 默认, 1h 兜底防泄漏 (session.abort 不杀子进程)。
  const leafTimeoutMs = (() => { const n = env.OMD_LEAF_TIMEOUT_MS ? Number.parseInt(env.OMD_LEAF_TIMEOUT_MS, 10) : NaN; return Number.isFinite(n) && n > 0 ? n : 3_600_000; })();
  // agent 座位 advisor: 装配期解一次 (runner 生命周期同 MCP 进程; 热改 config 后重启生效 —— 与
  // leafTimeoutMs 同精神)。未配 = 无 (不自动选)。
  const agentAdvisor = resolveSeatAdvisor('agent', { env });
  // 叶子留痕开关 (见下方接线处的注释)。`1`/`true`/`on` → 默认路径; 其它非空值当路径用。
  const leafTranscriptPath = ((): string | null => {
    const v = env.OMD_LEAF_TRANSCRIPT?.trim();
    if (!v) return null;
    return /^(1|true|on)$/i.test(v) ? join(cwd, '.omd', 'leaf-transcript.jsonl') : v;
  })();
  // agy-cli:* 坐标 → Google 订阅 CLI leaf (2026-09-11); 其余坐标原样进 createAgentLeafRunner。注入的 deps.agentRunner 不套。
  const agentRunner =
    deps.agentRunner ??
    withAgyLeaf(createAgentLeafRunner({
      // hashlineEdit **默认关** (owner 2026-08-18, 读数见 scripts/probes/readings/2026-08-18-hashline-ab.md):
      // 加难度 A/B (4 题, 两题的实现文件 3.9k 行, 两臂同去位置提示, 座位钉 M3) 8/8 全过,
      // 关闭臂 tokensIn 中位 675,683 → 404,930。开关与实装都留着 —— 优化+补测之后再考虑上线。
      // ⚠ 逐题配对是 2:2, 每格 n=1, 而同臂方差实测 1.4–1.8×: 这是"没证据支持开着", 不是"证明了它有害"。
      hashlineEdit: false,
      cwd,
      leafTimeoutMs,
      // P3 S4 (owner 2026-09-02 裁): DAG worker leaf 精益面 —— 四只手 + 条件件 run_acceptance, prompt v2。
      leanLeaf: true,
      ...(agentAdvisor ? { advisor: agentAdvisor } : {}),
      // S4 ext (D-1): 调用方按 run cwd 预加载注入。空数组 → 不传 customTools 键 = 工具面零变化 (D-4)。
      ...(extTools.length ? { customTools: extTools } : {}),
      // D2 切片 2 (#266): 仓规检查清单默认空数组, 行为与切片前逐字节相同 (INV-D2-4)。
      // 仓库侧提供实际清单 (jargon-scan / catch-evidence-net-add 等) 的方式 = config.repoChecks
      // (DagRunnersSeam.repoChecks), 见 buildDefaultConfig 的解析点。
      repoChecks,
      // 叶子逐事件留痕 (2026-08-29, 默认关): `OMD_LEAF_TRANSCRIPT` 给路径就用它, 给 `1`/`true`
      // 落 `<cwd>/.omd/leaf-transcript.jsonl`。不设 = **不传这个键**, 热路径逐字节同改前。
      // 为什么需要: leaf 空转是本仓目前最强的一条负相关 (reward 0.453 → 0.238), 而判它是
      // 病因还是伴随现象要看叶子当时在调什么 —— 那份 transcript 此前一个字节都没留。
      ...(leafTranscriptPath ? { onEvent: createLeafTranscriptSink({ path: leafTranscriptPath }) } : {}),
    }), { cwd, leafTimeoutMs });
  // 运行期白名单 = marker 表 ∪ **真探测**实测启用的 bin (2026-08-29)。
  //
  // ⚠ 这一处必须与分类期同源, 否则就是本仓最怕的那种「假红」: classify 用真探测判这个仓能跑
  // pytest, 于是冻了一条 `pytest -q`; 而命令 leaf 若还用 marker 表, 执行时把它拒掉 ——
  // 看起来像"测试没过", 实际上根本没跑。两处口径必须同时换。
  const runAllowlist = (root: string): string[] => {
    const base = allowlistForRoot(root);
    const combined = runtimeAllowlistForRoot(root, env);
    const extra = combined.filter((b) => !base.includes(b));
    if (extra.length > 0) logger.info({ root, extra }, '[omd/mcp] 命令白名单按仓环境真探测扩充');
    return combined;
  };
  const commandRunner =
    deps.commandRunner ??
    createCommandLeafRunner({ allowlist: runAllowlist(cwd), cwd, timeoutMs: 180_000 });
  // research 节点执行器 (D-6): web stack 带配额状态 → 装配期建一次复用 (同 router)。
  // 无 search provider → undefined = 不挂 → research 节点响亮失败 (见 createDefaultResearchRunner)。
  const researchRunner = deps.researchRunner ?? createDefaultResearchRunner({ cwd, env });

  // per-kind 闸。**2026-07-31 改动: 从"零默认"改成"本机足迹有默认, 网络等待型不设限"。**
  //
  // 此前这里刻意零默认 (「MCP 是中立基础设施, 不烤机器立场」), 而本机足迹实际上是被
  // **provider 桶顺手挡住的** —— `defaultMaxFanout = min(fanout, providerCap)`, DeepSeek 那格是 64,
  // 于是 agent leaf 的真实并发一直被钳在 64。今天 owner 把 DeepSeek 那格放开 (官方并发 2500),
  // 那道顺风车就没了: 一个 200 项的 map 节点会同时起 200 个 pi session / bwrap 子进程。
  //
  // 两个轴此前压在一个数上, 现在分开写明:
  //   · **网络等待型** (inproc leaf) —— 不设限, 并发与核数无关, 钳它纯冤枉;
  //   · **本机足迹型** (agent 起子进程 / command 起 shell) —— 按核数给默认, env 仍可覆盖。
  // 这不是新加限制, 是把**此前那道搭便车的限制明写出来**并放宽 (64 → 由机器决定)。
  const intEnv = (v: string | undefined): number | undefined => {
    const n = v ? Number.parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const kindFanout = {
    agent: intEnv(env.OMD_AGENT_FANOUT) ?? AGENT_DEFAULT_FANOUT,
    command: intEnv(env.OMD_COMMAND_FANOUT) ?? CPU_FALLBACK_FANOUT,
  };
  // B-2 bandit 选型路由 (2026-07-21 MCP 接线 — 此前只 TUI 有, MCP 路径 dag_run 恒静态):
  // env pool (OMD_ROUTER_POOL_*) / config.multimodalPool ≥2 才真学; 未配 → no-op = 静态 (零回归)。
  // reward = leafCostReward (成本主信号, 质量走 verifier 闸) — 见 model-router ROUTER-5。
  // 注入优先 (测试给 :memory: 的那一个); 缺席才按 env 造 —— 见 AssembleOmdMcpDeps.router 的注。
  const router = deps.router ?? createModelRouterFromEnv(env);
  /**
   * **两只真改文件的手, 按给定的根建一对** —— `buildDefaultConfig` 与 `ExecutorDagConfig.forRoot`
   * 共用这一份 (R5.1, 2026-09-07: 换根重建执行手的参数**只此一处**, 不复制第二套)。
   *
   * @param overrideCwd R2 (2026-07-31): 隔离 worktree 档下**必须重建 leaf runner**。
   *   `agentRunner`/`commandRunner` 在装配期就把 cwd 烤进去了(上面那两行), 而 `runGoal` 的
   *   `cwd` 参数只管 spec 存盘目录 —— live 实测到过这个洞: worktree 建起来了、回话说"隔离成功",
   *   **产物却全落在主树**。声明面动了执行面没跟上, 而读数上看起来是成功的。
   *   宿主显式注入的 runner (`deps.agentRunner`) 不动: 那是调用方自己选的根, 我们不替它改。
   * @param extToolsForRun S4 (D-3): 隔离档下 runner 的 ext 工具, 由 goal.ts:288 按 worktree cwd
   *   `await loadExtTools(worktree.cwd)` 预加载后传入; 未传 = 该 runner 无 ext (调用方职责) ——
   *   不回落到装配期那批 (worktree 是另一棵树, 它自己的 extensions.json 才算数)。
   */
  const buildRunnersForRoot = (
    overrideCwd?: string,
    extToolsForRun?: AnyOmdTool[],
  ): Pick<ExecutorDagConfig, 'agentRunner' | 'commandRunner'> => {
    const root = overrideCwd ?? cwd;
    // R2 第二层 (2026-07-31, live 抓出来的洞): 光换 cwd **拦不住绝对路径**。第三跑实测有一个
    // agent 的产物落在 `/…/<沙箱>/docs/from-faq.md` —— 隔离树之外。
    // `sandboxRoot` 那层 (bwrap: 整个 leaf 进程只见这棵树) 机制早就有、eval oracle 一直在用
    // (`conductor-modelmix.ts` 的注逐字写着"事前 block 写穿 worktree"), **生产从来没接**。
    // 又是"机制在、生产零生效"。
    //
    // 只在**隔离档**接: 你要了隔离就给你真隔离; `head` 档一个字不动 (零回归 —— 给每个 leaf 都套
    // bwrap 是另一个量级的行为改变, 不该搭这趟车)。
    // bwrap 起不来 → 响亮降级: 隔离仍是"相对路径级"的, 但**调用方必须知道**它没拿到进程级隔离。
    //
    // ⚠ 2026-08-21 判据换成 `probeShellSandbox()`, 原先是 `Bun.which('bwrap')` ——
    // 而**本仓自己早就判定过那个判据不够**。`shell-sandbox.ts` 的文件头逐字写着:
    // 「二进制在、内核不给 unprivileged user namespace(部分发行版 / 容器)是常见组合,
    //  而 `which` 在那种机器上照样返回 0。判据是成本:一次 `bwrap … true` 是毫秒级的,
    //  没有任何理由用推的(P-2)。结果缓存,不每条命令探一次。」
    // 对话位那条路 08-13 就照这条改了, 生产 jail 这条**没跟上** —— 同一个判断在仓里有两套判据,
    // 弱的那套还坐在更要紧的位置上。复用隔壁那个**已缓存**的真探针: 延迟仍是零 (整进程一次),
    // 判据严格更强。实测 6ms/次, 且只在首次。
    const sandbox = overrideCwd && !deps.agentRunner ? probeShellSandbox() : { ok: false as const };
    const jailRoot = overrideCwd && !deps.agentRunner && sandbox.ok ? root : undefined;
    if (overrideCwd && !deps.agentRunner && !jailRoot) {
      // 原因原文进日志: 「二进制不在」与「内核不给 userns」的**修法完全不同**, 编成一句
      // "找不到 bwrap" 就把唯一能定方向的证据吞了 (S-12 那一族)。
      logger.warn(
        { root, reason: sandbox.ok ? undefined : ((sandbox as { reason?: string }).reason ?? 'bwrap 探测未通过 (无原文)') },
        '[omd/mcp] 隔离档要求进程级 jail 但 bwrap 起不来 → 降级为相对路径级隔离 (绝对路径写仍能逃出去)',
      );
    }
    const agentRunnerForRun =
      overrideCwd && !deps.agentRunner
        ? withAgyLeaf(createAgentLeafRunner({
            cwd: root,
            hashlineEdit: false, // 同上 (owner 2026-08-18): 两个装配点必须同档, 分叉就是两套工具面
            leafTimeoutMs,
            leanLeaf: true, // 同上: 两个装配点同档 (P3 S4)
            ...(agentAdvisor ? { advisor: agentAdvisor } : {}),
            // 隔离档 = 生产 (branch worktree), 不是 eval —— 这里的 jail 里**要有 git**:
            // worktree 的 `.git` 是指针文件, 不挂就是"隔离叶里 git 全灭" (run 7d50fda2 实测,
            // 叶子空转 12 轮的真实摩擦面)。挂法是 ro 共享 .git + rw 本树 gitdir, 写主 repo
            // 的 refs/objects 仍被拒; eval oracle 那条路 (eval/oracles/*) 不设此位, 行为不变。
            ...(jailRoot ? { sandboxRoot: jailRoot, sandboxGit: true } : {}),
            ...(extToolsForRun && extToolsForRun.length ? { customTools: extToolsForRun } : {}),
            // D2 切片 2 (#266): 隔离档下仓规检查仍走 (写集 = worktree 内文件); 默认空 = 无清单。
            repoChecks,
          }), { cwd: root, leafTimeoutMs })
        : agentRunner;
    const commandRunnerForRun =
      overrideCwd && !deps.commandRunner
        ? createCommandLeafRunner({ allowlist: runAllowlist(root), cwd: root, timeoutMs: 180_000 })
        : commandRunner;
    return { agentRunner: agentRunnerForRun, commandRunner: commandRunnerForRun };
  };
  /**
   * engine config 基座 —— **每个 run 重算** (INV-MODEL-3 无 boot 冻结)。
   *
   * 这一段刻意住在函数里而不是装配期常量: MCP server 是长驻进程 (D-9), 装配期算一次就把座位/池
   * 冻在 boot 那一刻 —— `omd_set_role` / `omd models auto` 改完 config, 下一次 dag_run 仍用旧座,
   * 得杀进程重连才生效 (P0 前的真实症状)。router (bandit, 有状态) 与两个 runner 留在外面复用。
   *
   * 两个参数的语义见 {@link buildRunnersForRoot} (这里原样转发)。
   */
  const buildDefaultConfig = (overrideCwd?: string, extToolsForRun?: AnyOmdTool[]): Partial<ExecutorDagConfig> => {
    const { agentRunner: agentRunnerForRun, commandRunner: commandRunnerForRun } = buildRunnersForRoot(overrideCwd, extToolsForRun);
    // engine config = 座位三件套 (conductor/leaf/agent, 单一 resolver) + 真改文件 runner 对。
    const models = resolveEngineModels(env);
    // ── 跨模型校验闸 (2026-08-01 点亮) ──────────────────────────────────────────
    //
    // **这道闸此前只挂在 TUI 上** (`tui.ts` 调 resolveVerification), MCP 这条从来没接过 ——
    // 于是 `config.verifier` 恒 undefined, executor-dag 那段 verify + conductor 静默升级
    // (executor-dag.ts:2696「config.verifier 给则启用」) 在生产路径上**一次都没跑过**。
    // 证据不用推理: `mcp/tools/dag-tools.ts:119` 那行注释自己写着「MCP 路径无 verifier」,
    // 下游的 ok 判据当年就是照着这个事实改的。
    //
    // 这不是"少了个可选增强"。auto-assign 的 INV-3 把**跨家族独立性押在 verifier 身上**
    // (`auto-assign.ts:10`), 而它从没上过场; 生产里唯一的跨家族对抗是 judge 碰巧坐在 codex 上 ——
    // 那是意外, 不是设计。座位分工本来是: judge 管 synth 阶段的择优, verifier 管**代码 review 级**
    // 的终审。少了后者, 整条链上没有任何一个环节在问"这活到底做没做对"。
    //
    // ⚠ 为什么"座位自检 16/16 ✓"看不出这个洞: 那张表问的是**座位解析得出来吗**, 而 verifier 座位
    // 在 MCP 上确实被解析了 —— 被借去组 `stampPools.strong`。**坐标被人用 ≠ 它代表的机制在跑**。
    // 同理 `empty-knobs` 的「座位即承诺」闸也是绿的 (它只要求座位被解析过)。这两道闸都不为此负责,
    // 别指望它们下次替你抓住同一件事。
    //
    // 关法与 TUI 同一个旋钮: OMD_VERIFY=0。坐标坏了怎么办 (fail-fast vs 优雅降级) 全在
    // resolveVerification 里判, 这里不重复一份。
    const verification = resolveVerification({ enabled: env.OMD_VERIFY !== '0', env });
    // 并发默认接 fleet 层 (此前断路 = 引擎全宽): min(effectiveFanout(env OMD_MAX_FANOUT/CPU 兜底),
    // agent 模型 provider 的并发池 cap)。工具参数 maxFanout 仍最高优先 (dag-tools 内覆盖)。
    const agentProvider = (models.agentLeafModel ?? models.leafModel ?? '').split(':')[0] ?? '';
    const defaultMaxFanout = Math.max(
      1,
      Math.min(effectiveFanout({}, env), agentProvider ? resolveProviderCap(agentProvider) : Number.MAX_SAFE_INTEGER),
    );
    // SDD v2 pass 管线接线 (顺序钉死 prune → dedup → stamp; 日志在接线层 — INV-8 pass 纯函数零 IO)。
    // S3 四池: strong=判/证, mid=执行主力, cheap=探索/机械, multimodal=多模态尺子 — 从 role 配置
    // 组装 (auto-assign 落的 .omd/config.json 经 resolveRoleModelConfigured 读)。裸 provider 坐标
    // (无 ':') 过滤掉 (stamp 要精确坐标); 池空 → stamp 恒等 (INV-9 配置不全零回归)。
    const roleCoord = (n: OmdNode): string => resolveRoleModelConfigured(n, { env }).model;
    const uniqCoords = (xs: string[]): string[] => [...new Set(xs.filter((x) => x.includes(':')))];
    // 显式池 (config.pools) 优先; 每档独立回落座位推导。座位推导下 mid/cheap 会恒等 (六个 worker
    // 座位同一个坐标) —— 想让 tier:'cheap' 真的便宜、想让 sibling 跨家族分散有对象, 就得显式配池。
    // SEAT-1 (owner 裁 2026-08-11):**座位是唯一真源, pools 不再是第三条轴。**
    // 池一律从座位推导 —— 于是池里每一个坐标都是某个座位的坐标, 改座位池自动跟着改。
    // 撤掉的是 `cfgPools.X ??` 那层覆盖: 它让 config.pools 完全不问座位, env / --*-model /
    // config.models 谁都盖不过它 (实测踩过: 12 个 OMD_* + 5 个旗标全设了却一个没生效)。
    // 盘上还留着 pools 段的仓照旧能跑, 只是**它不再生效** —— 这件事必须响亮地说, 不能静默忽略。
    const stampPools = {
      strong: uniqCoords([roleCoord('judge'), roleCoord('reason'), roleCoord('verifier')]),
      mid: uniqCoords([roleCoord('leaf'), roleCoord('agent'), roleCoord('overflow')]),
      cheap: uniqCoords([roleCoord('lens'), roleCoord('expand'), roleCoord('distill')]),
      // 多模态是**能力硬约束**不是档位偏好 (非多模态模型看不见图), 故仍读专用配置而非座位池。
      multimodal: resolveMultimodalPool(),
    };
    const ignoredPools = Object.entries(resolveConfiguredPools())
      .filter(([, v]) => Array.isArray(v) && v.length > 0)
      .map(([k]) => k);
    if (ignoredPools.length) {
      logger.warn(
        { ignored: ignoredPools, effective: stampPools },
        '[omd/mcp] config.pools 已失效并被忽略 (SEAT-1: 座位是唯一真源) — 请改座位 (omd_set_role / config.models), 并把 config.json 的 pools 段删掉',
      );
    }
    logger.info({ coords: stampPools }, '[omd/mcp] stamp 池 = 座位推导 (SEAT-1)');
    const planFilters: Array<(p: ConductorPlan) => ConductorPlan> = [
      (p) => {
        const { plan, pruned } = prunePass(p);
        if (pruned.length) logger.info({ pruned }, '[omd/mcp] prune pass: 剪除死节点 (D-2/4v2)');
        return plan;
      },
      (p) => {
        const { plan, merged } = dedupPass(p);
        if (Object.keys(merged).length) logger.info({ merged }, '[omd/mcp] dedup pass: 语义指纹去重 (D-20)');
        return plan;
      },
      // S2 证据闸 (SDD 2026-07-25 skills-compile-evidence-gate)。**排在 stamp 之前**是刻意的:
      // 本 pass 会新增节点, 排在 stamp 后补挂的 attach_media 审查 leaf 拿不到多模态池模型 = 白补
      // (回流修正 SDD 的「链尾」写法, 理由见 evidence-pass.ts 文件头)。卡按调用时刻读盘 (与执行器同源)。
      (p) => {
        // 本仓怎么渲染自己 (EVD-6, 2026-09-05): 有**显式声明**时组件化的仓也接得出像素证据链;
        // 只探到候选时不接 (猜 outDir 会让 shots-verify 假红), 但把建议带进降级判词。
        const render = detectRenderCommand(cwd);
        const { plan, patched, noCardHits, shape, degraded } = evidencePass(p, {
          templates: loadAgentTemplates({ root: cwd }),
          render,
        });
        if (patched.length) logger.info({ patched }, '[omd/mcp] evidence pass: 补挂 ui-pixels 证据链 (S2/D-2)');
        // 渲染能力是**每仓不同**的一格, 读的人要看得见这次用的是哪条、为什么 (同 toolchain 那条纪律)。
        logger.info({ render: describeRenderProbe(render) }, '[omd/mcp] evidence pass: 本仓渲染能力');
        // EVD-5 降级必须响亮: fail-open 可以吞异常, 不许吞证据。读的人要看得见"这一格没有像素证据",
        // 而不是以为它过了闸 —— 静默降级与"闸压根没跑"在读数上不可分, 那正是本仓坑 #2 的形状。
        if (degraded.length)
          logger.warn(
            { degraded },
            '[omd/mcp] evidence pass: 无可渲染目标 → 这些节点降级为 diff-only 审 (EVD-5; 像素证据链缺席)',
          );
        // D-11 挖矿日志: (goal, 图形状指纹, 无卡命中) —— S4 图形状挖矿与卡自扩的前置数据。
        // 三元组的 oracle 结果那一半在执行完成后由 run 汇总记 (规划期拿不到)。
        logger.info({ goal: plan.name, shape, noCardHits }, '[omd/mcp] evidence pass: 图形状指纹 (D-11 挖矿信号)');
        return plan;
      },
      // 卡触发闸 (SDD 2026-08-11 卡与profile分工 D-9/D-11)。**同样排在 stamp 之前**, 与 evidence-pass
      // 同一条理由: 本 pass 会新增节点, 排在 stamp 后补挂的审核节点拿不到档位模型 = 白补 (C-6 钉的就是这条)。
      // 放在 evidence 之后: 证据链补出来的渲染/校验节点是 command, 不带 output_path 也不该触发设计审核 ——
      // 让它们先落地再算写集, 不会改变结果, 但顺序固定下来读的人不用猜。
      (p) => {
        const { plan, attached, alreadyPresent } = triggerPass(p, { templates: loadAgentTemplates({ root: cwd }) });
        if (attached.length) logger.info({ attached }, '[omd/mcp] trigger pass: 按写集补挂卡审核节点 (D-9, advisory 不上关键路径)');
        // 「命中了但没补」要念出来 —— 与「没命中」在读数上必须分得开, 否则事后看不出闸有没有真跑 (坑 #1)。
        if (alreadyPresent.length)
          logger.info({ alreadyPresent }, '[omd/mcp] trigger pass: 写集命中但图上已有该卡节点 → 不重复补 (TRG-2 幂等)');
        return plan;
      },
      (p) => {
        // templateHasModel: 卡真钉了模型才让 stamp 让路 (卡没钉 → 照常按 tier 选池, 否则 tier 是哑弹)。
        const tpls = loadAgentTemplates({ root: cwd });
        const { plan, stamped } = stampPass(p, {
          pools: stampPools,
          familyOf: modelFamily,
          templateHasModel: (name) => Boolean(tpls.get(name)?.model),
        });
        if (Object.keys(stamped).length) logger.info({ stamped }, '[omd/mcp] stamp pass: node.model 计划期分配 (D-16/17/22)');
        return plan;
      },
    ];
    // D-23 per-channel 并发闸: OMD_CHANNEL_FANOUT="mimo=8,opencode-go=4" (provider 前缀=并发上限)。
    const channelFanout: Record<string, number> = {};
    for (const pair of (env.OMD_CHANNEL_FANOUT ?? '').split(',')) {
      const [k, v] = pair.split('=');
      const n = Number.parseInt(v ?? '', 10);
      if (k?.trim() && Number.isFinite(n) && n > 0) channelFanout[k.trim()] = n;
    }
    // S-P conductor prompt 档位随**座位模型档**分派 (SDD 2026-07-25 S-P; 2026-07-25 A/B eval 裁决:
    // k3 上 full/lean 同分 1.000/1.000 且 firstShot 全过, lean 少 25% leaf token → 强 conductor 撤
    // 教练段 = harness 退役测试, 弱 conductor 保 full)。
    // 此前这里硬编码 `startsWith('kimi-coding:')` —— conductor 座 2026-07-25 已换 gpt-5.6-sol,
    // 那条判据当天就失效了 (SOTA 座位在吃给弱模型写的教练段)。改成按 AA intelligence 查档,
    // 换座位自动跟着走, 不用记得改这一行。
    //
    // maxTokens **不并进这张表** —— 它是另一根轴 (provider 的输出上限能力, 32768 只在 kimi 系实测过;
    // deepseek 系 ~8k 硬顶)。把"prompt 要不要教练段"和"能吐多少 token"混成一个条件是两次埋雷。
    const strongConductor = models.conductorModel ? isStrongCoord(models.conductorModel) : false;
    // #171 (2026-08-18 A/B 裁决, large R=3 @ C6 opus-5): lean-kb (= lean + 知识边界段) 对比 lean ——
    // firstShot 持平 0.988、同深同宽下节点 24→15 (时序性碎步合并)、conductor token 持平、总成本反降
    // → 采纳。读数与塌回条件全文在 issue #171 (质量降则撤回 'lean')。
    const conductorTuning: Partial<ExecutorDagConfig> = {
      ...(strongConductor ? { conductorPromptProfile: 'lean-kb' as const } : {}),
      ...(models.conductorModel?.startsWith('kimi-coding:') ? { conductorMaxTokens: 32768 } : {}),
    };
    // S-T 座位推理档 (坐标 → 档): auto-assign 把「模型 + 推理档」成对写入磁盘, 执行期按节点已钉的坐标反查。
    // 不在此加缓存 —— 底层 fileConfig 已按 mtime 缓存, 自己再存一层会在 `omd models auto` 重写 config
    // 后拿着旧档不放 (daemon 长活)。config 无该段 → 恒 undefined → 执行器回落原默认, 老 config 零变化。
    const seatThinking = (coord: string, seat?: string): ThinkingLevel | undefined => resolveSeatThinking(coord, seat ? { seat } : {});
    const defaultConfig: Partial<ExecutorDagConfig> = {
      ...models,
      seatThinking,
      maxFanout: defaultMaxFanout,
      // P3 S8 (D-25): 进程级 leaf 在飞上限 —— `OMD_MAX_INFLIGHT_LEAVES` 显式, 否则沿用题内缺省 cap (同一个数,
      // 但作用域是整个进程: 嵌套 run 叠加时题内 cap 各看各的, 这一把看总数)。不第二次解析 OMD_MAX_FANOUT。
      maxInflightLeaves: intEnv(env.OMD_MAX_INFLIGHT_LEAVES) ?? defaultMaxFanout,
      // **暖发**: 全局先串行跑 1 个节点(写 prompt-cache)→ 再放开其余(命中共享冻结前缀)。
      //
      // 2026-07-31 打开它的直接原因是并发闸刚被拆掉: cap 64 时同时在飞的最多 64 个,
      // 现在是"有几个跑几个" —— **thundering herd 变大了, 共享前缀全 miss 的代价跟着变大**。
      // 一发串行延迟换掉的是 (N−1) 次前缀 miss, 而 DeepSeek 缓存命中价是 0.07 vs 0.27 /M。
      //
      // ⚠ 这个机制**早就写好了**(executor-dag.ts 的 warmThenFanout 分支 + `LEAF_SYSTEM_PREFIX`
      // 那段"字节稳定"的注释), 但默认 false 且**只有两个 eval oracle 开过** —— 生产从来没吃到。
      // 又一次「机制在、生产零生效」。引擎侧的默认不动(它是中立的), 在生产装配这一层打开。
      // 单/双节点不吃这一发: 引擎内 `idSet.size > 1` 已经守着。
      warmThenFanout: true,
      // g1 leaf 档位闸 (图 #9, 2026-08-04): 大内容进 prompt (单次计费) 不进工具环 (每轮重放,
      // r2 实测 6 倍)。判据/改写建议在 plan/leaf-tier-gate.ts, 拒回环在 executor-dag planAndExecute。
      // 阈值 = 实测之半: deepseek-v4-flash 探针收 3.04MB (56 万 token) 未撞限, 取 1.5MB 留
      // goal/上游注入/输出余量。OMD_LEAF_TIER_GATE=0 关; OMD_LEAF_TIER_THRESHOLD_BYTES 覆盖阈值。
      leafTierGate: env.OMD_LEAF_TIER_GATE !== '0',
      leafTierThresholdBytes: intEnv(env.OMD_LEAF_TIER_THRESHOLD_BYTES) ?? 1_500_000,
      // #247 (2026-08-24, 片 2): plan-critic 静态闸进活环 —— 缺省开; OMD_PLAN_CRITIC_GATE=0 关。
      // 引擎默认关 (零回归); 生产装配层开, 消费方同 (dag_run/dag_goal/goal-worker)。
      planCriticGate: env.OMD_PLAN_CRITIC_GATE !== '0',
      kindFanout,
      // R2: 隔离档下这两个是**为那棵树重建的**; 无 override 时逐字等于装配期那一对 (零回归)。
      agentRunner: agentRunnerForRun,
      commandRunner: commandRunnerForRun,
      // R5.1 (2026-09-07, D-R5.1-2): **运行期换根**时重建这两只手的钩子 —— 上面那一对是这次
      // 装配时那棵树的, 而 R5 扇出会在一次 run 中途把子 run 换到另一棵 worktree 上。
      // 复用同一个 `buildRunnersForRoot` (jail / advisor / repoChecks 同一份参数), 不写第二套。
      forRoot: (r: string) => buildRunnersForRoot(r, extToolsForRun),
      ...(researchRunner ? { researchRunner } : {}),
      router,
      // D2 切片 2 (#266): 仓规检查清单 (DagRunnersSeam.repoChecks) — 默认空数组,
      // 行为与切片前逐字节相同 (INV-D2-4)。宿主可通过 configOverrides.repoChecks 注入
      // 仓库实际清单 (jargon-scan / catch-evidence-net-add 等)。D4 (#271) 配 INV-D4-3 共用
      // 装配期那一份 loadRepoChecksManifest(cwd), configOverrides.repoChecks 仍按原展开序覆盖。
      repoChecks,
      planFilters,
      // D-8v2: judge/parallel/tournament 的 attempts 候选池 = mid 执行主力池 (跨家族轮转)。
      ...(stampPools.mid.length >= 2 ? { primitiveCandidates: stampPools.mid } : {}),
      ...(Object.keys(channelFanout).length ? { channelFanout } : {}),
      ...conductorTuning,
      // 校验闸 (verifier + conductor 静默升级 + maxEscalations)。**排在 configOverrides 之前** ——
      // 调用方显式传 verifier/escalation 时仍然压得过默认装配 (测试注入假 verifier 靠这条)。
      ...(verification.verifier ? { verifier: verification.verifier } : {}),
      ...(verification.conductorEscalationModel
        ? { conductorEscalationModel: verification.conductorEscalationModel }
        : {}),
      ...(verification.maxEscalations !== undefined ? { maxEscalations: verification.maxEscalations } : {}),
      ...deps.configOverrides,
    };
    return defaultConfig;
  };

  // omd-hud 活体镜像: DAG 进度 (dag.json) + pathfinder 迷雾 (fog.json) 原子写 .omd/hud/,
  // statusline (scripts/omd-hud.ts) 数据源。dag + pathfinder 工具共用一个实例 (同 repoRoot)。
  const hudMirror = new HudMirror(cwd);

  // plan-memory Phase A 账本 (SDD 2026-07-21): 每个完成 run 记 family/版本/战绩, 纯记账零行为改变。
  // 证据门 (issue #10, 2026-08-11): omd_plans 显示任一 family runs≥3 ∧ ok率≥0.8 → 开 Phase B 召回闸。
  const ledger = deps.ledger ?? createPlanLedger({ path: join(cwd, '.omd', 'plan-ledger.db') });

  // DAG 运行留痕 (2026-08-02 接线): 每张跑完的图落 {拓扑层, 每节点 kind/status/deps, conductor+leaf
  // token, cacheHit} 进 `.omd/dag-runs.db`。**此前它只挂在 TUI 侧的 /cg /audit /iterate 上** ——
  // MCP 这条从来没接过, 于是生产路径上那个库恒空, 「一次 goal 多少钱」(上线闸 G3) 与「兄弟节点吃到
  // 多少前缀缓存」两个问题都查不到数据源, 而记录器本身早就写好了。
  // ⚠ 位置**不吃 cwd** (2026-08-05 owner 定盘): 见 createDagRecorder / ledgerPath 上面那段 ——
  //   从别的 repo 的 session 发的跑此前落进那个 repo 的库, 于是"被动攒样本"攒的是碎库。
  const recorder = deps.recorder ?? createDagRecorder();

  // S3 owner 收件箱: 与 runs.db **同一个库** —— 同一个 run 的身份、状态、待决岔口分三个文件
  // 早晚对不上 (D-P 把取消把手放进 RunRegistry 是同一条理由)。
  const inbox = deps.inbox ?? createOwnerInbox({ path: join(cwd, '.omd', 'runs.db') });

  // D1 (ext 词表 v2): 节点事件桥进 ext observe 通知 —— **组合**进既有 onNodeEvent 不替换
  // (单回调形状不变, 不引监听者集合)。桥全程 fail-open, 观察者不许扰动被观察者。
  const extSink = extNodeEventSink(cwd);
  // F1 (片 2): owner 推式桥 —— replan → escalation, budget → budget-half。其余静默。
  const notifySink = ownerNotifySink(cwd);
  const onNodeEventComposed = (runId: string, e: DagNodeEvent): void => {
    deps.onNodeEvent?.(runId, e);
    extSink(e);
    notifySink(runId, e);
  };

  // ── #253 (2026-08-25): 写型 run 的档位缺省 —— 生产两个真实入口默认落隔离 worktree ──────
  // 分层照 planCriticGate 先例 (`:652`): 引擎/工厂层缺省不动 (`prepareRunWorktree` 仍是 'head',
  // 直调工厂的测试与外部调用零回归), **只在这一层翻** —— 这里才是 owner 真正点火的那条路。
  //
  // 为什么翻: head 档下的三笔账都是实付的 —— 共享树上多写者 commit 互相覆盖 (#165) ·
  // 脏树起跑没有回滚对象 (rollback-anchor 的 dirty-tracked 态) · 收编闸只能排除 head 档。
  // 当年 head 当默认的三条理由今天都失效了: merge 税有验收环在付 (#165② 判据绿自动收编) ·
  // 磁盘有 #252 GC · 「隔离树看不见未提交的活」从代价变成纪律收益 (逼点火前先 commit)。
  //
  // OMD_RUN_BRANCH_DEFAULT=0 退回老默认。留这个逃生阀是因为**非 git 目录 / 不想要 worktree 的仓**
  // 也在跑 omd —— 那里退回 head 是本来就有的降级路 (prepareRunWorktree 建不起来自己会退, 响亮)。
  const defaultBranchStrategy: BranchStrategy = env.OMD_RUN_BRANCH_DEFAULT === '0' ? 'head' : 'branch';

  // 三层改名 (owner 2026-08-04, t7): 表内工具挂新名 map_*/solve/run, 旧名留 deprecated alias。
  // 真源 = tool-renames.ts 一张表; 文档/徽章两条闸 import 同表, 注册面与闸不可能漂移。
  const assembled = applyToolRenames([
    // continuity 恒开 (D-3): checkpoint 落 <cwd>/.omd/continuity/<runId>/, dag_run_plan resume 可续。
    ...createDagTools({ engine, runRegistry, defaultConfig: buildDefaultConfig, continuity: { manager: new CheckpointManager(cwd), repoRoot: cwd }, hudMirror, ledger, recorder, onNodeEvent: onNodeEventComposed, defaultBranchStrategy }),
    createDagResearchTool(researchFanout, { runRegistry }),
    // 自主 goal 环 (P1 / INV-GOAL-1): buildDefaultConfig 传 thunk = 每次调用重解座位 (INV-MODEL-3)。
    // continuity 同 dag_run 恒开: 内层节点 checkpoint + **外层轮 journal** (INV-P2-6),
    // dag_goal resume=<runId> 才接得回轮次/毒集/复用源。
    createGoalTool({
      runGoal: deps.runGoal ?? runGoal,
      runRegistry,
      cwd,
      buildConfig: buildDefaultConfig,
      continuity: { manager: new CheckpointManager(cwd), repoRoot: cwd },
      // 活体进度/HUD 与 dag_run 同一条线 (2026-07-30 补: goal 这条从 P1 起就漏了)。
      // ⚠ 2026-08-21: 上面这句在补线前**是不成立的** —— dag_run 那条线有三半 (registry ·
      //   hudMirror · 订阅者旁路), 而 goal 只接了前两半, TUI 那半一直空着。补齐见下一行。
      hudMirror,
      // 节点事件旁路 —— **与 dag_run 同一个 composed 实例**, 于是 TUI 活图 / fleet 对
      // solve 与 run 两条路一视同仁。缺了这行, 走 solve 的 run 在 TUI 上全程是黑的。
      onNodeEvent: onNodeEventComposed,
      // 运行留痕与 dag_run 同一个实例 (2026-08-02 补: 与上面那条同一个形态的漏)。
      recorder,
      // S3: owner 指令通道 —— 每轮取一次未消费指令, 逐字渲染, 取完记账 (防每轮重放)。
      inbox,
      // #251 (C-3 INV-9): 点火判据自证的实跑通道 —— 不传则该闸缺席 (接线点缺失, 非 fail-open)。
      // 复用装配期同一个白名单 runner (cwd 已烤死), 与引擎 commandRunner 单一实现。
      commandRunner,
      // #253: 与 run 同一个缺省 —— 两个写型入口不许各有各的默认 (那正是 owner 撞到的
      // 「以为隔离了其实在写主树」的对偶形态)。
      defaultBranchStrategy,
    }),
    // root = 代码锚判陈旧的基准 (evidence[].path 是仓相对的)。与其余工具同一个 cwd。
    ...createMemoryTools({ memory, root: cwd }),
    // pathfinder 六件套 (TUI-less 决策地图: map/add/tickets/rule/deliver/prefetch, pull 式回流)。
    ...createPathfinderTools({
      cwd,
      env,
      models: resolveEngineModels(env),
      agentRunner,
      commandRunner,
      hudMirror,
      // 裁决增益: path_rule 成功后经同款 OmdMemory 写 omd.pattern fact (memory_recall 消费端可召回)。
      memory,
      // 运行留痕与 dag_run / dag_goal 同一个实例 (2026-08-02 补: path_deliver 是四个会真跑图的
      // 入口里最后一个没接的 —— 缺它, 「各入口占比」会系统性看不见慢回路那一块)。
      recorder,
      ...deps.pathfinder,
    }),
    // fleet 四工具: review/slim/deepen/debug 异步子进程。
    // D-4 (SDD C-5): onNodeEvent 也达 fleet —— dag_review 的进度翻成标准 DagNodeEvent 灌 pushDagEvent
    // (此前只达 createDagTools, review 这条观察面是断的)。省略 = 不转 (现状)。
    ...createFleetTools({ runRegistry, cwd, spawn: deps.spawn, ...(deps.onNodeEvent ? { onNodeEvent: deps.onNodeEvent } : {}) }),
    // runs 工具: 内存 registry ∪ 磁盘 continuity 合并列表。
    ...createRunsTools({ runRegistry, cwd }),
    // S3 owner 收件箱: dag_triage (看) + dag_rule (裁)。无人值守的产出必须有去处。
    ...createTriageTools({ inbox, runRegistry }),
    // #160 D-4: dag_intervene —— 人介入记录面 (appendBoard event:'intervened'), 读数板据此算可避免性率。
    ...createInterveneTools({ cwd }),
    // config 工具族: set_key/apply_preset/set_role/config_status/toggle_hud (omd init 的 MCP 面, 即时生效)。
    ...createConfigTools({ cwd, router }),
    // 组合模式入口 (2026-07-26): 原语与图式递到图外, 让外部 SOTA agent 不必先出图就能用引擎能力。
    // runPlan 走同一条 runExecutorDagWithPlan —— 零新执行路径, stamp/闸/checkpoint 全部照旧。
    // omd_distill 不依赖 web provider (吃调用方给的文本) → **无条件挂**。
    ...createDistillTools({
      distill: async (lens, input) =>
        (lens === 'challenger' ? createChallengerDistiller() : createModelSourceDistiller())(input),
    }),
    // omd_web 要 search provider; 无则不挂 (与 TUI 同款优雅跳过, 不崩 boot)。
    ...(() => {
      try {
        const stack = createWebStackFromEnv(env);
        return createWebTools({
          cwd,
          retrieve: (query, o) => retrieveWeb(stack, query, o as Parameters<typeof retrieveWeb>[2]) as never,
        });
      } catch (e) {
        logger.warn({ err: (e as Error).message }, '[omd/mcp] 无 search provider → omd_web 不挂 (设 TAVILY_API_KEY / ANYSEARCH_API_KEY / SEARXNG_URL 启用)');
        return [];
      }
    })(),
    ...createComposeTools({
      runPlan: (plan, config) =>
        engine.runExecutorDagWithPlan(plan, config as unknown as Parameters<typeof runExecutorDagWithPlan>[1]),
      baseConfig: () => buildDefaultConfig() as Record<string, unknown>,
      // T6 (2026-08-03): 第五个入口进账本。S0 当时的理由「它没有 runId」已不成立 ——
      // 入口分布里"从不落账"与"没人用"长得一模一样, 而那正是 entry 轴要分开的两件事。
      recorder,
    }),
    // plan-memory 账本可观测 (Phase A 证据门仪表, issue #10)。
    createPlansTool(ledger),
  ]);
  // S1 conductor_chat (SDD 2026-08-09 远程指挥接缝): 对话位入口。**必须挂在改名之后** ——
  // 它内部的 createConductorChatTools 按新名 (run/solve/map_tickets…) 点名, 挂早了装配期响亮抛。
  assembled.push(
    createConductorChatTool({
      cwd,
      store: deps.chatStore ?? createOmdSessionStore(cwd),
      resolveModel: () => resolveEngineModels(env).conductorModel,
      tools: assembled,
      // §2 周预算闸 (SDD 2026-08-09 ECON): 账本目录与上限都按**装配层的 env** 解 ——
      // 与本文件其余接缝同口径 (测试注入 env, 不必污染进程)。每次调用现读盘 + 现读 env:
      // 改 OMD_WEEKLY_BUDGET_USD 下一句就生效, 不必重连 server (INV-MODEL-3 同款理由)。
      budget: () => checkWeeklyBudget({ dir: usageLedgerDir(cwd, env), env }),
      ...(deps.chatLoopFn ? { loopFn: deps.chatLoopFn } : {}),
    }),
  );
  return assembled;
}
