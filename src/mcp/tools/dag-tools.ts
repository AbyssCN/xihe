/**
 * src/mcp/tools/dag-tools — dag_run / dag_run_plan / dag_status / dag_result MCP tools (D-8 宽出).
 *
 * Pure-fn factory: createDagTools({engine, runRegistry}) → OmdMcpTool[].
 * Handlers inject engine seam (runExecutorDag / runExecutorDagWithPlan) + RunRegistry.
 * runExecutorDag is fire-and-forget: register → start → execute → succeed/fail (in background).
 * dag_status / dag_result query RunRegistry; unknown runId → isError (never crash).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { NodeDetail, RunRegistry } from '../run-registry.js';
import type { OmdMcpTool } from '../server.js';
import type { DagNodeEvent, ExecutorDagConfig, ExecutorDagResult } from '../../harness/dag/types.js';
import { logger } from '../../logger';
import type { CheckpointManager } from '../../harness/continuity/checkpoint-manager.js';
import type { ConductorPlan } from '../../harness/conductor-plan.js';
import { parsePlan } from '../../harness/conductor-plan.js';
import { knownMcpServerNames } from '../client/config.js';
import { topoLevels } from '../../harness/dag/engine.js';
import { renderProgressAscii } from './dag-ascii.js';
import type { HudMirror } from '../../hud/mirror.js';
import type { PlanLedger } from '../../harness/plan/plan-ledger.js';
import { recordDagRun, type DagRecorder } from '../../harness/dag/dag-record.js';
import { computeCost } from '../../model/cost-ledger.js';
import { liveRunsNotice } from '../../harness/board/dag-run-board.js';
import { envSummaryLine } from '../../model/bootstrap.js';
import { listProviders } from '../../model/providers.js';
import { defaultIsAlive } from '../run-store.js';
import { checkCoords } from '../../harness/goal/coord-check.js';
import { cancelDetachedRun } from '../../harness/run-control.js';
import { loadIgnitionArgs, RECOVERABLE, resolveResumeArgs, saveIgnitionArgs } from '../../harness/run-ignition.js';
import {
  describeRunWorktree,
  prepareRunWorktree,
  type BranchStrategy,
} from '../../harness/run-worktree.js';

// renderProgressAscii 已抽到 ./dag-ascii (纯函数, statusline 复用); 此处保留 re-export 兼容既有 importer。
export { renderProgressAscii };

// ---------------------------------------------------------------------------
// S2 执行进程化 (SDD 2026-08-10 §2) —— dag_run / dag_research 的 detached 子进程基建。
//
// 形状逐字仿 `scripts/goal-worker.ts` (已扛真载的 solve detached 路): 子进程照 `omd mcp`
// 引导序 (bootstrapModelRuntime + assembleOmdMcpTools + 同一份 runs.db) 起来, 经
// `resume: runId` 接手属主 (未知 runId → register+start, 属主 pid = 子进程), 轮询终态,
// 退出前 `verifyTerminalPersisted` 写穿核验, 退出码 2=参数错 / 1=失败 / 3=写穿不可修 / 0=done。
//
// **为什么仿而不复用 goal-worker**: goal-worker 绑死 dag_goal 工具面 (硬编码找 `dag_goal`,
// goal 走 argv), 与 S2 契约冲突 —— 本片要从 spec 读工具名 (dag_run|dag_research)、参数走
// 临时文件 (argv 不携带 goal 原文: 元字符/长度/进程表泄露三害全避)。骨架逐段照抄, 差异只有这两处。
//
// 母进程 (server) 只做: 校验 → 写 spec → spawn detached → 立即返回 runId。**不登记 run**:
// 登记由子进程做, 它才是属主 (pid 判活要认它) —— goal.ts 那段注释逐字适用, 母进程抢先登记
// 会让下一个 session hydrate 把一个正在跑的 run 判成"被打断"。代价是毫秒级窗口
// (子进程起来之前 dag_status 查无此 run)。
// ---------------------------------------------------------------------------

/** 传给子进程的 spec (落 .omd/continuity/<runId>/spec.json, mode 0600)。 */
export interface DagExecSpec {
  /** 要调的工具面 —— 子进程从 spec 读, 不硬编码 (goal-worker 的不适配点之一)。 */
  tool: 'dag_run' | 'dag_research';
  runId: string;
  cwd: string;
  /** 用户参数原样 (task/plan/question/leafModel/…); resume 由子进程按 runId 补。 */
  args: Record<string, unknown>;
}

/** spawn 接缝 —— 测试注入替身, 永不起真进程 (同 goal.ts spawnDetached 纪律)。 */
export type SpawnDagExecFn = (
  spec: DagExecSpec,
) => { ok: true; pid?: number; logPath: string } | { ok: false; error: string };

/** 子进程自证旗标: dag-exec 的 env 带它, handler 看到即走进程内执行体, 不再二次 spawn。 */
export const OMD_DAG_EXEC_CHILD = 'OMD_DAG_EXEC_CHILD';

/** worker 脚本路径按**本包安装位置**解析 (同 goal.ts workerScriptPath —— 相对 cwd 拼在别的 repo 必 Script not found)。 */
function dagExecScriptPath(): string {
  return join(import.meta.dir, '..', '..', '..', 'scripts', 'dag-exec.ts');
}

/**
 * 默认 spawn: Bun.spawn detached + stdout/stderr → exec.log (append) + unref。
 * SDD §5: detached + stdio 重定向文件 = 脱离父进程组 —— server 收到进程组信号
 * (客户端断开自杀) 时子进程不陪葬; G2 在真机直接验这一条。
 */
export function defaultSpawnDagExec(
  spec: DagExecSpec,
): { ok: true; pid?: number; logPath: string } | { ok: false; error: string } {
  const runDir = join(spec.cwd, '.omd', 'continuity', spec.runId);
  const specPath = join(runDir, 'spec.json');
  const logPath = join(runDir, 'exec.log');
  try {
    mkdirSync(runDir, { recursive: true });
    // 参数 (含 goal 原文) 经临时文件, 不进 argv (SDD §2)。mode 0600: 不给同机其他用户读。
    writeFileSync(specPath, JSON.stringify(spec, null, 2), { mode: 0o600 });
    const fd = openSync(logPath, 'a');
    // env 全透传 + 子进程自证旗标。OMD_CONFIG_PATH 显式钉死 (SDD §2):
    // 已设 → 解析成绝对路径 (相对路径对 cwd 解析, cwd 漂移也不读串);
    // 未设 → 不设 —— 子进程 cwd 与母进程相同, configPath() 走同一条向上发现路径,
    // 不发明第二套解析 (role-models.ts 的 configPath 是唯一真源)。
    const env: Record<string, string | undefined> = { ...process.env, [OMD_DAG_EXEC_CHILD]: '1' };
    const cfg = process.env.OMD_CONFIG_PATH;
    if (cfg?.trim()) env.OMD_CONFIG_PATH = isAbsolute(cfg.trim()) ? cfg.trim() : resolve(spec.cwd, cfg.trim());
    const proc = Bun.spawn(['bun', 'run', dagExecScriptPath(), '--run', spec.runId, '--spec', specPath], {
      cwd: spec.cwd,
      env,
      detached: true,
      stdin: 'ignore',
      stdout: fd as unknown as number,
      stderr: fd as unknown as number,
    });
    proc.unref();
    return { ok: true, pid: proc.pid, logPath };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 孤儿检测 (SDD §2 T2 另一半) 的时限: 属主 pid 死 ∧ 5min 无 checkpoint 写入 → stalled。
 * 5min 是 SDD 定的消费端档 (进程死后给写穿/pid 复用留的宽限), 不是新判据。
 * 反向自检: 改成 0 → 任何 kill(pid,0) 判活抖动都会误标 stalled (测试红);
 * 删掉 pid 判活 → 活着的子进程 run 也被标 stalled (测试红)。
 */
export const STALLED_AFTER_MS = 5 * 60_000;

/** continuity/<runId>/ 目录龄 (ms) —— 目录 mtime 随 checkpoint 增删文件更新; 目录不在 → 视为超龄。 */
export function continuityAgeMs(runId: string, cwd: string): number {
  try {
    return Date.now() - statSync(join(cwd, '.omd', 'continuity', runId)).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 派发简报 (D-8 宽出): 图结构 + 模型坐标一屏可读 — 客户端派发瞬间就知道开了多少节点/
 * 几层/什么模型, 不必等 dag_status。levels 经 topoLevels; 环图不该出现 —— 2026-08-14 起 parsePlan
 * **查环** (PlanSchema superRefine, issue #25), 所以这里的 try/catch 是防御性兜底而不是主闸。
 */
export function dispatchBriefing(plan: ConductorPlan, config: ExecutorDagConfig): string {
  const entries = Object.entries(plan.nodes);
  const byKind: Record<string, number> = {};
  for (const [, n] of entries) {
    const kind = n.executor ?? 'leaf';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  let levelsLine: string;
  let workersLine = '';
  let topo: string[][] | undefined;
  try {
    topo = topoLevels(plan);
    const widest = Math.max(...topo.map((l) => l.length));
    levelsLine = `levels: ${topo.length} (widest ${widest})`;
    const cap = config.maxFanout && config.maxFanout > 0 ? config.maxFanout : undefined;
    workersLine = `workers: up to ${cap ? Math.min(widest, cap) : widest}${cap ? ` (cap ${cap})` : ' (cap ∞)'}`;
  } catch {
    levelsLine = 'levels: ? (graph not topo-sortable)';
  }
  const kinds = Object.entries(byKind)
    .map(([k, c]) => `${k}:${c}`)
    .join(' ');
  const models = [
    config.conductorModel ? `conductor=${config.conductorModel}` : '',
    `leaf=${config.leafModel}`,
    config.agentLeafModel ? `agent=${config.agentLeafModel}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const summary = [`nodes: ${entries.length} (${kinds})`, levelsLine, workersLine, `models: ${models}`].filter(Boolean).join('\n');
  // ASCII 层级图: dispatch 瞬间全部 pending
  const progress = { planned: entries.map(([id, n]) => ({ id, kind: n.executor ?? 'leaf' })), started: [], settled: [] };
  const ascii = renderProgressAscii(topo, progress);
  return `${summary}\n${ascii}`;
}

/**
 * Engine seam — callers inject real implementations, tests inject fakes.
 * `runExecutorDag` = 任务入口 (生产绑定 = loop-run.ts 的编排循环: conductor 节点 + 七张卡, 2026-09-03 起);
 * `runExecutorDagWithPlan` = 预构造图入口 (dag_run_plan / solve 的 sdd-direct 平铺图)。
 */
export interface DagEngine {
  runExecutorDag(task: string, config: ExecutorDagConfig): Promise<ExecutorDagResult>;
  runExecutorDagWithPlan(plan: ConductorPlan, config: ExecutorDagConfig): Promise<ExecutorDagResult>;
}

/** Dependencies injected into dag tool handlers. */
export interface DagToolDeps {
  engine: DagEngine;
  runRegistry: RunRegistry;
  /**
   * Default ExecutorDagConfig base (leafModel, conductorModel, etc.) — spread with per-call overrides.
   *
   * **给 thunk 则每个 run 重算** (INV-MODEL-3 无 boot 冻结): MCP server 是长驻进程, 装配期算一次
   * 就把座位/池冻在 boot 那一刻 —— `omd_set_role` 改了配置也要重连才生效。给值 = 老语义 (测试用)。
   */
  /** thunk 可收 cwd (隔离档用 worktree cwd 重建 leaf runner — assemble 的 buildDefaultConfig 天然匹配)。 */
  defaultConfig?: Partial<ExecutorDagConfig> | ((cwd?: string) => Partial<ExecutorDagConfig>);
  /**
   * W2 continuity (D-3 断点续跑): 给则每个 run 落节点 checkpoint (.omd/continuity/<runId>/),
   * dag_run_plan 的 resume 参数命中已绿节点即跳过 (429 打断后不再整图重跑)。省略 = 不落不续。
   */
  continuity?: { manager: CheckpointManager; repoRoot: string };
  /**
   * omd-hud 活体镜像 (给则每个 onNodeEvent + 完成态把 DAG 进度原子写 .omd/hud/dag.json,
   * statusline 数据源)。fail-open 不影响执行; 省略 = 不写 (HUD 空闲)。
   */
  hudMirror?: HudMirror;
  /**
   * **进程内节点事件旁路**(TUI SDD §6,切片 S11):给了就在 hud 镜像写盘**之后**原样转一份。
   *
   * 为什么不让 TUI 去读 `.omd/hud/dag.json`:owner 已拍板进程内直订阅 —— 零文件 IO、零延迟。
   * 为什么仍然写那个文件:它是 statusline 的数据源,**加 TUI 不许把 statusline 断掉**。
   * 两条路各有各的消费者,不是重复。
   *
   * fail-open 且不吞证据:订阅者抛错记一行、不打断执行(HUD 画不出来不该拖垮 DAG)。
   */
  onNodeEvent?: (runId: string, e: DagNodeEvent) => void;
  /**
   * plan-memory Phase A 账本 (给则每个完成 run 记一笔: family 聚类 + 版本去重 + 战绩)。
   * 纯记账零行为改变; record 自身 fail-open。省略 = 不记。
   */
  ledger?: PlanLedger;
  /**
   * DAG 运行留痕器 (`.omd/dag-runs.db`)。给则每张图跑完落一条 {拓扑层, 每节点 kind/status/deps,
   * conductor+leaf token, **cacheHit**}。
   *
   * **为什么接在这里而不是 `.then()`**: 留痕器此前只挂在 TUI 侧的 `/cg` `/audit` `/iterate` 上,
   * MCP 这条 (dag_run / dag_run_plan / dag_goal) 从来没接过 —— 于是 `.omd/dag-runs.db` 在生产路径上
   * 恒空, 「一次 goal 花了多少」与「兄弟节点吃到多少缓存」两个问题都没有数据源。而 `onComplete`
   * 是**引擎内**的钩子, `dag_goal` 一次跑两段图时它各响一次; 挂在 `runGoal` 的 `.then()` 上只拿得到
   * `RunGoalResult`, 两张图的用量在那里已经不见了。
   */
  recorder?: DagRecorder;
  /**
   * S2 进程化 spawn 接缝 (dag_run / dag_research 起子进程)。测试注入替身, **永不起真进程**
   * (同 goal.ts spawnDetached 纪律)。省略 = 真 defaultSpawnDagExec。
   */
  spawnDagExec?: SpawnDagExecFn;
  /** 孤儿检测的 pid 判活接缝 (默认 process.kill(pid,0); 测试注入假死 pid)。 */
  isAlive?: (pid: number) => boolean;
  /** dag_cancel 的 SIGTERM 接缝 (默认 process.kill(pid,'SIGTERM'); 测试注入 spy —— 真 kill 会杀测试进程)。 */
  killPid?: (pid: number) => void;
  /**
   * **写型 run 的档位缺省** (#253, 2026-08-25) —— 调用方没给 `branchStrategy` 时用它。
   *
   * 分层照 plan-critic 静态闸的先例 (引擎默认关 · 装配层开): 纯函数层 (`prepareRunWorktree`)
   * 的缺省仍是 `head`, 直接调
   * 引擎/工厂的测试与外部调用零回归; **翻默认只发生在装配层** (`assemble.ts` 注入 `'branch'`),
   * 那才是 owner 真正点火的那条路。省略 = 保持 `head` 缺省。
   *
   * 当年 head 当默认的三条理由今天都已失效: merge 税有验收环在付 (#165② 判据绿自动收编) ·
   * 磁盘有 #252 GC · 「隔离树看不见未提交的活」从代价变成纪律收益 (逼点火前先 commit)。
   * 留下的是三笔实付账: 共享树上多写者 commit 互相覆盖 · 脏树起跑没有回滚对象 (rollback-anchor
   * 的 `dirty-tracked` 态) · 收编只能排除 head 档。
   */
  defaultBranchStrategy?: BranchStrategy;
}

/**
 * plan-memory 记账 (dag_run/dag_run_plan 完成钩子共用)。
 * ok = verifier pass ∨ (无 verifier ∧ 全叶 done) — A3 修复: MCP 路径无 verifier, "pass 才记"=账本永空。
 * cost = Σ leaf computeCost + conductor (fail-open: unpriced 计 0)。
 */
function recordPlanRun(
  ledger: PlanLedger,
  taskText: string,
  result: ExecutorDagResult,
  conductorModel: string | undefined,
): void {
  const leaves = Object.values(result.results);
  const allDone = leaves.length > 0 && leaves.every((l) => l.status === 'done');
  const ok = result.verification ? result.verification.pass : allDone;
  let costUsd = 0;
  for (const leaf of leaves) {
    if (leaf.model && leaf.usage) costUsd += computeCost(leaf.usage, leaf.model).costUsd ?? 0; // 订阅通道 → 0 USD 计入合计
  }
  if (conductorModel) costUsd += computeCost(result.usage.conductor, conductorModel).costUsd ?? 0;
  ledger.record({
    taskText,
    plan: {
      name: result.plan.name,
      ...(result.plan.description ? { description: result.plan.description } : {}),
      nodes: result.plan.nodes as unknown as Record<string, unknown>,
    },
    ok,
    verified: !!result.verification,
    costUsd,
  });
}

/**
 * 交付物存在性闸 (2026-08-14, plana 夜报回流第 2 条「done 但零交付」)。
 *
 * 实测背景: kaupan-ala 首跑爆窗后大面积级联 skip, runs.db 却记 `done` —— 此前只要引擎不抛错
 * 不被叫停, 一律 `succeed`。「跑完了」和「交付了」是两个判断, 终态只判了前者。
 *
 * 判据 (确定性, 不猜):
 *   · plan 声明了 `outputs` (交付物节点 id) → 它们必须全部 done。done 的 output 节点其
 *     声明产物已被**节点级产物闸**验过在盘上, 这里不重查一遍磁盘 (一份判据两处写必漂)。
 *   · 未声明 outputs → 至少一个节点 done (不给「没做任何事」发成功票, 同 empty-done 的语义)。
 *
 * 返回 null = 可发 done; 非 null = 拦下的理由 (进 fail 的 error, 结果照记 —— 证据不陪葬)。
 */
export function zeroDeliveryReason(result: ExecutorDagResult): string | null {
  const outputIds = result.plan.outputs ?? [];
  if (outputIds.length) {
    const missing = outputIds.filter((id) => result.results[id]?.status !== 'done');
    return missing.length
      ? `交付物闸: 声明的 outputs 节点未全部 done (缺: ${missing.join(', ')}) — 跑完 ≠ 交付了; 已完成节点与产物见 result`
      : null;
  }
  const done = Object.values(result.results).filter((l) => l.status === 'done').length;
  return done === 0
    ? `交付物闸: ${Object.keys(result.results).length} 个节点无一 done — 不给"没做任何事"发成功票`
    : null;
}

/** Map ExecutorDagResult.results → per-node NodeDetail {status, output} for registry storage. */
function extractNodeDetails(result: ExecutorDagResult): Record<string, NodeDetail> {
  const details: Record<string, NodeDetail> = {};
  for (const [id, leaf] of Object.entries(result.results)) {
    details[id] = { status: leaf.status, output: leaf.output };
  }
  return details;
}

/** Summarize a completed ExecutorDagResult for D-8 wide output (no full dump). */
function summarizeResult(result: ExecutorDagResult): Record<string, unknown> {
  const nodeIds = Object.keys(result.results);
  const done = nodeIds.filter((id) => result.results[id]!.status === 'done').length;
  const failed = nodeIds.filter((id) => result.results[id]!.status === 'failed').length;
  const artifactPaths: string[] = [];
  for (const leaf of Object.values(result.results)) {
    if (leaf.filesTouched) artifactPaths.push(...leaf.filesTouched);
  }
  // Sink outputs: leaf id absent from every other leaf's deps → terminal node.
  // Per-node cap 2000 chars; total cap 8000 chars — drop trailing whole nodes, flag _truncated.
  const dependedOn = new Set<string>();
  for (const leaf of Object.values(result.results)) {
    for (const dep of leaf.deps) dependedOn.add(dep);
  }
  const outputs: Record<string, string | boolean> = {};
  let outputsChars = 0;
  let truncated = false;
  for (const id of nodeIds) {
    if (dependedOn.has(id)) continue;
    const text = result.results[id]!.output;
    if (!text) continue;
    const clipped = text.slice(0, 2000);
    if (outputsChars + clipped.length > 8000) {
      truncated = true;
      break;
    }
    outputs[id] = clipped;
    outputsChars += clipped.length;
  }
  if (truncated) outputs['_truncated'] = true;
  return {
    sessionId: result.sessionId,
    nodeCount: nodeIds.length,
    done,
    failed,
    artifactPaths: artifactPaths.length > 0 ? artifactPaths : undefined,
    verification: result.verification
      ? { pass: result.verification.pass, reason: result.verification.reason }
      : undefined,
    // 用量可见性 (TUI /cost parity): 调用方能看到本 run 烧了多少 token/命中多少 cache。
    usage: {
      conductor: result.usage.conductor,
      leavesIn: result.usage.leavesIn,
      leavesOut: result.usage.leavesOut,
      leavesCacheHit: result.usage.leavesCacheHit,
      ...(result.usage.verifier ? { verifier: result.usage.verifier } : {}),
      // S2 后半 (C-2 / INV-9): 探测消耗段独立持久化, 普通 leaf cost 不读 (I-11 隔离)。
      // ⚠ 缺席 = 未采集 (I-11 三态第一态), 与 calls:0 ≠ costUsd:null (后两态) 不混。
      ...(result.usage.probe ? { probe: result.usage.probe } : {}),
    },
    outputs: Object.keys(outputs).length > 0 ? outputs : undefined,
  };
}

/**
 * Build 5 dag tools: dag_run, dag_run_plan, dag_status, dag_result, dag_node_output.
 * Each handler is a pure fn closed over {engine, runRegistry}.
 */
/**
 * Shared plan-launch: register/reopen the run, wire live progress + continuity, fire the engine
 * (fire-and-forget), return the running-status tool result. Reused by dag_run_plan and dag_resume.
 */
function launchPlanRun(
  parsedPlan: ConductorPlan,
  opts: { resume?: string; leafModel?: string; maxFanout?: number; task?: string; toolName: string; branchStrategy?: BranchStrategy },
  deps: DagToolDeps,
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const { engine, runRegistry, continuity, hudMirror, ledger, recorder, onNodeEvent } = deps;
  const { resume, leafModel, maxFanout, task, toolName } = opts;
  const runId = resume ?? randomUUID();
  const goal = task?.slice(0, 200) ?? parsedPlan.name ?? 'prebuilt plan';
  if (resume) {
    // resume 语义: failed/cancelled run 重开 / server 重启后未知 runId 重登记; 在飞或已 done 的拒绝。
    const rec = runRegistry.getRecord(resume) ?? runRegistry.ensureFromDisk(resume);
    if (rec && rec.status !== 'failed' && rec.status !== 'cancelled') {
      return { content: [{ type: 'text', text: `resume 拒绝: run ${resume} 当前 ${rec.status} (仅 failed/cancelled/未知可续)` }], isError: true };
    }
    runRegistry.reopenForResume(runId, { goal, meta: { tool: toolName, resumed: true } });
  } else {
    runRegistry.register(runId, { goal, meta: { tool: toolName } });
    runRegistry.start(runId);
  }
  // 隔离档 (方案 A, 2026-08-14): 'branch' → 本 run 落隔离 worktree。缺省由装配层给 (#253: 生产 =
  // 'branch'); 工厂直调不注入时仍是 'head', 零回归。
  // 必须在 resolveDefaults 之前 —— 隔离档要用 worktree cwd 重建 leaf runner。
  const worktree = resolveRunWorktree(runId, opts.branchStrategy, resume, deps);
  let defaultConfig: Partial<ExecutorDagConfig> | undefined;
  try {
    defaultConfig = resolveDefaults(deps.defaultConfig, worktree.strategy === 'branch' ? worktree.cwd : undefined);
  } catch (e) {
    // 起跑自检 / 座位未配 (INV-MODEL-5): 响亮但不崩 server —— 记败因并把座位名带出去。
    runRegistry.fail(runId, (e as Error).message);
    return { content: [{ type: 'text' as const, text: `${opts.toolName} 拒绝: ${(e as Error).message}` }], isError: true };
  }
  let hudLevels: string[][] | undefined;
  try {
    hudLevels = topoLevels(parsedPlan);
  } catch {
    hudLevels = undefined;
  }
  const config: ExecutorDagConfig = {
    ...defaultConfig,
    leafModel: leafModel ?? defaultConfig?.leafModel ?? '',
    // D-P: 取消把手 (dag_cancel 拉它; 引擎在调度接缝上自己停, 不杀在飞节点)。
    cancelSignal: runRegistry.attachCancel(runId),
    onNodeEvent: (e) => {
      runRegistry.applyNodeEvent(runId, e);
      hudMirror?.write(runId, runRegistry.getRecord(runId), hudLevels);
      // 旁路在镜像写盘**之后** —— 顺序是判据不是口味: 订阅者再慢也不许让 statusline 的
      // 数据源等它, 而反过来 statusline 写盘失败 (fail-open) 也不该吃掉这一份转发。
      if (onNodeEvent) {
        try {
          onNodeEvent(runId, e);
        } catch (err) {
          logger.warn({ runId, err: (err as Error).message }, '[omd/dag-tools] onNodeEvent 订阅者抛错 (已吞, 不打断执行)');
        }
      }
    },
    ...(maxFanout ? { maxFanout } : {}),
    ...(continuity
      ? {
          continuity: {
            manager: continuity.manager,
            runId,
            resume: !!resume,
            // 隔离档: 产物根钉到 worktree —— 不钉的话产物闸/artifactRoot 会拿主仓根去查
            // 隔离树里的文件 (goal.ts 同款注: 票会落进一棵随时会被删的树里)。
            repoRoot: worktree.strategy === 'branch' ? worktree.cwd : continuity.repoRoot,
          },
        }
      : {}),
    // 运行留痕 (给了 recorder 才记)。链上 defaultConfig 自带的 onComplete —— 留痕不许吃掉别人的钩子。
    // `entry` 复用**已有的** toolName ('dag_run_plan' / 'dag_resume') —— 这个函数本来就为
    // runRegistry.meta.tool 算过一次入口身份, 不另造一套分类法 (两份会漂)。
    ...(recorder
      ? {
          onComplete: recordDagRun(
            recorder,
            { runId, entry: toolName, ...(task ? { question: task } : {}) },
            defaultConfig?.onComplete,
          ),
        }
      : {}),
  } as ExecutorDagConfig;
  if (!config.leafModel) {
    runRegistry.fail(runId, `${toolName}: leafModel required (param or defaultConfig)`);
    return { content: [{ type: 'text', text: `runId: ${runId}\nerror: leafModel required` }], isError: true };
  }
  engine
    .runExecutorDagWithPlan(parsedPlan, config)
    .then((result) => {
      runRegistry.setNodeDetails(runId, extractNodeDetails(result));
      // D-P: 被叫停的 run **不记 done** —— 它没跑完。手上的结果照样记进去 (已跑完的节点值钱),
      // 状态用 cancelled 与"跑完了"分开, 调用方据此走 dag_resume 而不是去查为什么挂了。
      const zd = result.cancelled ? null : zeroDeliveryReason(result);
      if (result.cancelled) runRegistry.cancel(runId, result.cancelled.reason, summarizeResult(result));
      else if (zd) runRegistry.fail(runId, zd, summarizeResult(result));
      else runRegistry.succeed(runId, summarizeResult(result));
      hudMirror?.write(runId, runRegistry.getRecord(runId), hudLevels);
      if (ledger && task) recordPlanRun(ledger, task, result, config.conductorModel);
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      runRegistry.fail(runId, msg);
      hudMirror?.write(runId, runRegistry.getRecord(runId), hudLevels);
    });
  return {
    content: [{
      type: 'text',
      text:
        `runId: ${runId}\nstatus: running\n--- dispatch ---\n${dispatchBriefing(parsedPlan, config)}` +
        // 隔离档必须把目录/分支/降级原因念出来 (run-worktree 的纪律: 不念 = "东西不见了")。
        (worktree.strategy === 'branch' || worktree.degradedReason ? `\n${describeRunWorktree(worktree)}` : ''),
    }],
  };
}

/**
 * dag_resume — one-step resume: reload a run's plan from its on-disk checkpoint (`_dag.json`) and
 * re-run, skipping still-green nodes. Closes the manual "read _dag.json → dag_run_plan resume" loop.
 */
function makeDagResume(deps: DagToolDeps): OmdMcpTool {
  return {
    name: 'dag_resume',
    description: 'Resume a failed/interrupted run by runId — reload its plan from checkpoint, re-run skipping green nodes.',
    inputSchema: {
      runId: z.string().describe('runId of a failed/interrupted run (see dag_runs)'),
      leafModel: z.string().optional().describe('Leaf model override (provider:modelId)'),
      maxFanout: z.number().int().positive().optional().describe('Concurrency cap for node fan-out'),
    },
    handler: async (args) => {
      const { runId, leafModel, maxFanout } = args as { runId?: string; leafModel?: string; maxFanout?: number };
      if (!runId) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_resume: missing required param "runId"');
      }
      if (!deps.continuity) {
        return { content: [{ type: 'text' as const, text: 'dag_resume: continuity not configured — no checkpoints to resume from' }], isError: true };
      }
      const meta = deps.continuity.manager.loadDagMetadata(runId);
      if (!meta) {
        return { content: [{ type: 'text' as const, text: `dag_resume: no checkpoint for run ${runId} (see dag_runs)` }], isError: true };
      }
      if (!meta.plan) {
        return { content: [{ type: 'text' as const, text: `dag_resume: run ${runId} stored only a skeleton (pre-plan-memory) — can't auto-replay; re-supply the plan via dag_run_plan resume=${runId}` }], isError: true };
      }
      const parsed = parsePlan(JSON.stringify(meta.plan), { knownServers: knownMcpServerNames(deps.continuity?.repoRoot ?? process.cwd()) });
      if (!parsed.ok) {
        return { content: [{ type: 'text' as const, text: `dag_resume: stored plan for ${runId} is invalid — ${parsed.error}` }], isError: true };
      }
      return launchPlanRun(parsed.plan, { resume: runId, leafModel, maxFanout, task: meta.goal, toolName: 'dag_resume' }, deps);
    },
  };
}

/**
 * dag_cancel — **协作式**叫停一个在飞的 run (D-P)。
 *
 * 它不杀任何东西: 拉一下取消把手, 引擎在下一个**调度接缝**上停止派新活, 在飞的节点跑到自己
 * 结束 (产物、checkpoint、账本一样不少), 然后 run 以 `cancelled` 终态收尾。
 * 因此**这个工具返回时活还没停** —— 回的是"已请求", 不是"已停止"; 真停没停看 `dag_status`。
 * 停下来之后 `dag_resume runId=<同一个>` 接着跑, 已绿节点全跳过。
 */
function makeDagCancel(deps: DagToolDeps): OmdMcpTool {
  const { runRegistry } = deps;
  return {
    name: 'dag_cancel',
    description: 'Cooperatively stop a run: no new nodes dispatched, in-flight ones finish, ends as cancelled (resumable).',
    inputSchema: {
      runId: z.string().describe('runId of a running run (see dag_runs)'),
      reason: z.string().optional().describe('Why — shown in dag_status and recorded on the run'),
    },
    handler: async (args) => {
      const { runId, reason } = args as { runId?: string; reason?: string };
      if (!runId) throw new McpError(ErrorCode.InvalidParams, 'dag_cancel: missing required param "runId"');
      // S2: 子进程 run 不在本进程内存 —— 先读盘 (ensureFromDisk), 否则 cancel 一个
      // dag-exec 跑着的 run 会报"unknown", 而那正是它最需要被叫停的时候。
      const rec = runRegistry.getRecord(runId) ?? runRegistry.ensureFromDisk(runId);
      if (!rec) {
        return { content: [{ type: 'text' as const, text: `dag_cancel: unknown run ${runId} (see dag_runs)` }], isError: true };
      }
      if (rec.status !== 'running') {
        return { content: [{ type: 'text' as const, text: `dag_cancel: run ${runId} 当前 ${rec.status} — 不在飞, 无可取消` }], isError: true };
      }
      const why = reason?.trim() || '调用方叫停 (dag_cancel)';
      // 内存把手 = 本进程 in-proc run (dag_goal / dag_run_plan / dag_resume) → 协作式 (D-P 原语义)。
      if (runRegistry.requestCancel(runId, why)) {
        return {
          content: [{
            type: 'text' as const,
            text:
              `dag_cancel: 已请求取消 ${runId} (${why})\n` +
              '协作式: 不派新节点, 在飞的跑完才收尾 → 现在还没停, 看 dag_status 等它转 cancelled。\n' +
              `续跑: dag_resume runId=${runId} (已跑完的节点会被跳过)`,
          }],
        };
      }
      // 子进程 run (S2): 写 cancel 标记 + 对属主 pid 发 SIGTERM (SDD §2 生命周期)。
      // 子进程 (dag-exec) 轮询标记 → requestCancel 自己 → 引擎协作式停 (既有优雅停语义接住);
      // SIGTERM 是兜底 (子进程卡死, 或无取消把手的 dag_research 直接死; checkpoint 保底可 resume)。
      //
      // ⚠ **写侧不在这里** —— 它是 `harness/run-control.cancelDetachedRun`, 与 TUI 收件箱的
      // `s` 同一份 (INV-RC-1)。这里只做两件事: 喂 deps, 把 `CancelOutcome` 翻译成回执。
      // 2026-08-23 之前这里自己抄了一份 (还把标记 writeFileSync 了两遍), 而 parity 闸只钉
      // 了 intervene —— 两份 cancel 可以静默漂开而没有任何东西会红。
      // 闸: `run-control-parity.test.ts` 的 GWT-PARITY-C1..C4。
      const cwd = deps.continuity?.repoRoot ?? process.cwd();
      const outcome = cancelDetachedRun(cwd, runId, why, {
        readOwnerPid: (id) => runRegistry.diskRecord(id)?.ownerPid ?? null,
        ...(deps.isAlive ? { isAlive: deps.isAlive } : {}),
        ...(deps.killPid ? { killPid: deps.killPid } : {}),
      });
      // INV-RC-4: 四种结局各画各的 —— 全吞成"已取消"就是画一个按了不发生的东西。
      switch (outcome.kind) {
        case 'signalled':
          return {
            content: [{
              type: 'text' as const,
              text:
                `dag_cancel: 已请求取消 ${runId} (${why})\n` +
                `子进程 pid ${outcome.pid}: cancel 标记 + SIGTERM 已发 — 协作式停, 看 dag_status 等它转 cancelled;\n` +
                '若它无视标记 (卡死), 重启 session 后 hydrate 会按打断落 failed, 然后 dag_resume 接着跑。',
            }],
          };
        case 'signal-failed':
          return {
            content: [{ type: 'text' as const, text: `dag_cancel: 标记已写但 SIGTERM 失败: ${outcome.error} — 子进程可能还在跑, 稍后重试` }],
            isError: true,
          };
        case 'pid-dead':
          // 属主 pid 已死 → 孤儿 (stalled): 没有活进程可停, 如实说没停到 (比回"已取消"诚实)。
          return {
            content: [{
              type: 'text' as const,
              text:
                `dag_cancel: run ${runId} 的属主进程 (pid ${outcome.pid}) 已不在 — **没有活进程可停**。` +
                '它是孤儿 (dag_status 会标 stalled); 重连 session 后 hydrate 按打断落 failed, 然后 dag_resume 接着跑。',
            }],
            isError: true,
          };
        case 'no-owner-pid':
          // 与 pid-dead 分开说: "盘上没记 ownerPid" 是**账本缺一列**, 不是"进程死了"。
          // 合并两者会让一条记账缺陷长年伪装成孤儿 run (CLAUDE.md 坑①: NULL ≠ 0 ≠ 不适用)。
          return {
            content: [{
              type: 'text' as const,
              text:
                `dag_cancel: run ${runId} 盘上**没记 ownerPid** — 够不着属主进程, 一个字节都没写。\n` +
                '这不是"进程已死", 是账本缺这一列 (老记录 / 非 spawn 路起的 run)。' +
                '若它其实还在飞, 只能等它自己收尾或按 pid 手动处理。',
            }],
            isError: true,
          };
      }
    },
  };
}

export function createDagTools(deps: DagToolDeps): OmdMcpTool[] {
  return [
    makeDagRun(deps),
    makeDagRunPlan(deps),
    makeDagResume(deps),
    makeDagCancel(deps),
    makeDagStatus(deps),
    makeDagResult(deps),
    makeDagNodeOutput(deps),
  ];
}

// ---------------------------------------------------------------------------
// dag_run — task → conductor plan → fan-out → {runId, summary}.
// ---------------------------------------------------------------------------

/** thunk 则调用 (每 run 新鲜), 值则原样 — 见 DagToolDeps.defaultConfig。
 *  `cwd` 只对 thunk 生效 (assemble 的 buildDefaultConfig 收 overrideCwd): 隔离档必须用
 *  worktree cwd 重建 leaf runner —— goal.ts 2026-07-31 live 实测: 不重建则 agent 写的是主树。 */
function resolveDefaults(
  d: Partial<ExecutorDagConfig> | ((cwd?: string) => Partial<ExecutorDagConfig>) | undefined,
  cwd?: string,
): Partial<ExecutorDagConfig> | undefined {
  return typeof d === 'function' ? d(cwd) : d;
}

/**
 * 隔离档解析 (2026-08-14, owner 裁方案 A: dag_run/dag_run_plan 接 worktree 档)。
 *
 * 背景: 2026-08-13 夜 plana 9 个 run 全在同一棵主树上跑 (dag_run 此前没有隔离参数),
 * 零事故靠的是文件集恰好不相交; 次日 oh-my-dag 主树被并行 session 的 stash 实测竞走一次。
 * 语义与 solve 的 branchStrategy 逐字一致 ('branch' 隔离 worktree, 引擎永不自动合回; 'head' 写主树)。
 * #253 (2026-08-25) 起**缺省由装配层给** —— 生产两个入口都默认 'branch', head 变显式 opt-in;
 * 这里与 `prepareRunWorktree` 的纯函数缺省仍是 'head' (工厂直调零回归)。
 * resume 时盘上已有该 runId 的隔离树 → **强制 branch** —— 首跑在隔离树、
 * resume 却写主树是静默换树, 比不隔离更坏 (checkpoint 与半成品全在那棵树上)。
 */
function resolveRunWorktree(
  runId: string,
  requested: BranchStrategy | undefined,
  resume: string | undefined,
  deps: DagToolDeps,
): ReturnType<typeof prepareRunWorktree> {
  const root = deps.continuity?.repoRoot ?? process.cwd();
  // ⚠ 2026-08-23: 「resume 时盘上已有隔离树 → 强制 branch」这条判据**已收进
  // `prepareRunWorktree` 一处** —— 此前只有这里算过, 而 `goal.ts` 的 `solve` 没有,
  // 于是 solve 的 resume 会静默换树写主工作树(owner 现场撞到)。同一条判据两处各写一份
  // 就是那个洞的成因, 所以这里**不再自己算**, 原样把调用方要的传下去。
  // #253: 调用方没给档位 → 用装配层的缺省 (生产 = `branch`)。两者都缺席才落到纯函数层的 `head`。
  //
  // ⚠ **缺省只对首跑生效, 续跑不套** —— 反过来会造出「静默换树」的**对偶形态**: 首跑落 head
  // (老 run, 或显式 head), 半成品就在主工作树里未提交; 续跑若按新缺省建隔离树, 那棵树是 HEAD 的
  // 干净 checkout, **看不见那些半成品**, 于是 agent 从零重做一遍。既有的反向保护 (盘上已有该
  // runId 的隔离树 → 强制 branch) 只挡了 branch→head 那个方向, 挡不住这个方向。
  // 续跑时把档位交回 `prepareRunWorktree` 按**盘上有没有那棵树**判 —— 那才是这个 run 首跑的真身。
  const strategy = requested ?? (resume ? undefined : deps.defaultBranchStrategy);
  return prepareRunWorktree({ cwd: root, runId, ...(strategy ? { strategy } : {}) });
}

/**
 * dag_run 的**进程内执行体** (S2) —— 旧 dag_run handler 的整段身体, 零语义改动。
 *
 * 只在两种进程里跑: ① dag-exec 子进程 (env 带 OMD_DAG_EXEC_CHILD=1, handler 把控制权交给它);
 * ② 测试 (同旗标)。生产 server 的 dag_run handler 永远走 spawn, 不碰这里。
 *
 * 接手语义 (goal-worker 逐字照抄): 子进程以 `resume: runId` 调进来 —— 未知 runId →
 * reopenForResume = register + start, 属主 pid 记成**本进程** (判活认它); failed/cancelled →
 * 重开; running/done → 拒绝 (母进程 spawn 前已查过盘, 这里是第二道闸)。
 */
function executeDagRunInProc(
  runId: string,
  args: { task: string; conductorModel?: string; leafModel?: string; resume?: string; maxFanout?: number; branchStrategy?: BranchStrategy },
  deps: DagToolDeps,
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const { engine, runRegistry, continuity, hudMirror, ledger, recorder, onNodeEvent } = deps;
  const { task, conductorModel, leafModel, resume, maxFanout } = args;
  const goal = task.slice(0, 200);
  if (resume) {
    // resume 语义: failed/cancelled run 重开 / 未知 runId 重登记; 在飞或已 done 的拒绝。
    const rec = runRegistry.getRecord(resume);
    if (rec && rec.status !== 'failed' && rec.status !== 'cancelled') {
      return {
        content: [{ type: 'text' as const, text: `resume 拒绝: run ${resume} 当前 ${rec.status} (仅 failed/cancelled/未知可续)` }],
        isError: true,
      };
    }
    runRegistry.reopenForResume(runId, { goal, meta: { tool: 'dag_run', resumed: true } });
  } else {
    runRegistry.register(runId, { goal, meta: { tool: 'dag_run' } });
    runRegistry.start(runId);
  }

  // 隔离档 (方案 A, 2026-08-14): 与 launchPlanRun 同一条 resolveRunWorktree —— 语义见彼处注。
  const worktree = resolveRunWorktree(runId, args.branchStrategy, resume, deps);
  // Fire-and-forget: execute in background, update registry on completion.
  // 座位/池**每 run 重解** (INV-MODEL-3): thunk 在这里调用, 故 omd_set_role 改完下一次 dag_run 就用新座。
  let defaultConfig: Partial<ExecutorDagConfig> | undefined;
  try {
    defaultConfig = resolveDefaults(deps.defaultConfig, worktree.strategy === 'branch' ? worktree.cwd : undefined);
  } catch (e) {
    const msg = (e as Error).message;
    runRegistry.fail(runId, msg);
    return { content: [{ type: 'text' as const, text: `runId: ${runId}\nerror: ${msg}` }], isError: true };
  }
  const config: ExecutorDagConfig = {
    ...defaultConfig,
    conductorModel: conductorModel ?? defaultConfig?.conductorModel ?? '',
    leafModel: leafModel ?? defaultConfig?.leafModel ?? '',
    // D-P: 取消把手 (dag_cancel 拉它)。
    cancelSignal: runRegistry.attachCancel(runId),
    // 活体进度: conductor 出图后引擎发 planned → start/settle 流进 registry (dag_status 实时) +
    // hudMirror 原子写 .omd/hud/dag.json (omd-hud statusline 数据源; conductor 路径无 topo → levels=null 平铺)。
    onNodeEvent: (e) => {
      runRegistry.applyNodeEvent(runId, e);
      hudMirror?.write(runId, runRegistry.getRecord(runId));
      if (onNodeEvent) {
        try {
          onNodeEvent(runId, e);
        } catch (err) {
          logger.warn({ runId, err: (err as Error).message }, '[omd/dag-tools] onNodeEvent 订阅者抛错 (已吞, 不打断执行)');
        }
      }
    },
    // 并发手闸: 参数 > defaultConfig (装配层 provider 池) > 引擎全宽。
    ...(maxFanout ? { maxFanout } : {}),
    // D-3 断点续跑: checkpoint 恒写入磁盘; resume 时命中已绿节点跳过 (429 打断不再整图重跑)。
    ...(continuity
      ? {
          continuity: {
            manager: continuity.manager,
            runId,
            resume: !!resume,
            // 隔离档: 产物根钉到 worktree —— 不钉的话产物闸/artifactRoot 会拿主仓根去查
            // 隔离树里的文件 (goal.ts 同款注: 票会落进一棵随时会被删的树里)。
            repoRoot: worktree.strategy === 'branch' ? worktree.cwd : continuity.repoRoot,
          },
        }
      : {}),
    // 运行留痕 (与 launchPlanRun 同款; dag_run 是 conductor 路径, 它自己组 config)。
    ...(recorder
      ? {
          onComplete: recordDagRun(
            recorder,
            // entry 词表 (t7, 2026-08-04): 与工具新名同词 —— 'run' (旧 'dag_run' 只在历史行里,
            // 读侧经 TOOL_RENAMES 归一合并)。
            { runId, entry: 'run', question: task },
            defaultConfig?.onComplete,
          ),
        }
      : {}),
  } as ExecutorDagConfig;

  // Validate required config fields (engine will throw if missing, but we catch early).
  if (!config.conductorModel) {
    runRegistry.fail(runId, 'dag_run: conductorModel required (param or defaultConfig)');
    return {
      content: [{ type: 'text' as const, text: `runId: ${runId}\nerror: conductorModel required` }],
      isError: true,
    };
  }
  if (!config.leafModel) {
    runRegistry.fail(runId, 'dag_run: leafModel required (param or defaultConfig)');
    return {
      content: [{ type: 'text' as const, text: `runId: ${runId}\nerror: leafModel required` }],
      isError: true,
    };
  }

  // Async execution — don't await (fire-and-forget). Registry tracks status.
  engine
    .runExecutorDag(task, config)
    .then((result) => {
      runRegistry.setNodeDetails(runId, extractNodeDetails(result));
      // D-P: 叫停的不记 done (见 launchPlanRun 同款注); 零交付同样不记 done (交付物闸)。
      const zd = result.cancelled ? null : zeroDeliveryReason(result);
      if (result.cancelled) runRegistry.cancel(runId, result.cancelled.reason, summarizeResult(result));
      else if (zd) runRegistry.fail(runId, zd, summarizeResult(result));
      else runRegistry.succeed(runId, summarizeResult(result));
      hudMirror?.write(runId, runRegistry.getRecord(runId)); // 终态 done → statusline grace 后收起
      // plan-memory Phase A: 记一笔 (family 聚类 + 版本 + 战绩)。record 自身 fail-open。
      if (ledger) recordPlanRun(ledger, task, result, config.conductorModel);
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      runRegistry.fail(runId, msg);
      hudMirror?.write(runId, runRegistry.getRecord(runId)); // 终态 failed
    });

  return {
    content: [{
      type: 'text' as const,
      text:
        `runId: ${runId}\nstatus: running` +
        (worktree.strategy === 'branch' || worktree.degradedReason ? `\n${describeRunWorktree(worktree)}` : ''),
    }],
  };
}

function makeDagRun(deps: DagToolDeps): OmdMcpTool {
  const { runRegistry, ...rest } = deps;
  return {
    name: 'dag_run',
     description: 'Run a task via the orchestrating loop (conductor + dispatch cards; no acceptance). resume=<runId> skips green nodes.',
    inputSchema: {
      task: z.string().describe('Task description for the conductor to plan and execute. 可选分区: 「## 提示」区 = 建议不构成验收判据; 「## 硬约束」区 = 逐条硬判 (verifier 按此裁)'),
      conductorModel: z.string().optional().describe('Conductor model (provider:modelId)'),
      leafModel: z.string().optional().describe('Leaf model (provider:modelId)'),
      resume: z.string().optional().describe('Prior runId to resume — done nodes with valid checkpoints are skipped'),
      maxFanout: z.number().int().positive().optional().describe('Concurrency cap for node fan-out (default: provider pool)'),
      branchStrategy: z
        .enum(['head', 'branch'])
        .optional()
        .describe(
          "Where this run's writes land. 'branch' (DEFAULT) = isolated git worktree on branch " +
            'omd/run/<runId>; the engine never merges back — you do. ' +
            "'head' = write the current working tree; opt in only when you want the writes in front of you " +
            'and no other session/run touches this tree.',
        ),
    },
    handler: async (args) => {
      const { task, conductorModel, leafModel, resume, maxFanout, branchStrategy } = args as {
        task?: string;
        conductorModel?: string;
        leafModel?: string;
        resume?: string;
        maxFanout?: number;
        branchStrategy?: BranchStrategy;
      };
      if (!task) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_run: missing required param "task"');
      }
      // ── #241 坐标机械校验 (2026-09-04 从 solve 补到 run) ────────────────────
      // 那条实账**就发生在这条路上**: run 0f67293b 的 `task` 写「`saveVerdictReasonFull` 在
      // `checkpoint-manager.ts:312`」, 符号是编的 (真名 `saveReasonFull`), 执行体照抄进
      // `rg -e ...`, 无匹配退 1, `&&` 链首败, 下游 7 节点全 skipped, 一整跑白烧。
      // 闸当初却只加在了 `solve` 的 goal 文本上 (checkCoords 生产端一处, goal.ts) —— run 漏接。
      //
      // 判定与 solve 同一份实现 (`checkCoords` 白名单三形状, 判不了的散文碎片一律不验)。
      // `run` 没有 `force` 参数, 所以出口走**文本内**的两条 (都不改 schema, 见 coord-check
      // §isCoordExempt): 同句写「新建」, 或同行写 `gate-allow(coord-check): <理由>`。
      // 反向自检: `run-coord-gate.test.ts` —— 把本块删掉, 那些 test 当场由绿转红。
      {
        const root = deps.continuity?.repoRoot ?? process.cwd();
        const findings = checkCoords(task, { root }).map((f) => f.message);
        if (findings.length > 0)
          return {
            content: [{
              type: 'text' as const,
              text:
                'dag_run 拒绝 (#241 坐标机械校验): 派工文本里的坐标与仓不符 —— 编造的符号/路径会被执行体照抄进命令 (实账 0f67293b 烧掉整跑)。\n' +
                findings.map((m) => `- ${m}`).join('\n') +
                '\n改正坐标; 确属新建物时在同句写明「新建」; 闸看错了就在同行写 `gate-allow(coord-check): <理由>`。',
            }],
            isError: true as const,
          };
      }
      const runId = resume ?? randomUUID();
      // ── S2 执行进程化 (SDD 2026-08-10 §2) ──────────────────────────────────
      // 母进程 (server) 只做: 校验 → 写 spec → spawn detached 子进程 → 立即返回 runId。
      // 引擎/模型/harness 的代码在子进程里从盘上现码执行 —— 改完 commit, 下一个 run
      // 就吃新代码, 零重启 (T1, 本 SDD 的存在理由)。
      //
      // 子进程怎么识别自己: dag-exec 的 env 带 OMD_DAG_EXEC_CHILD=1 (spawn 时钉死),
      // handler 看到即走进程内执行体 (executeDagRunInProc = 旧 handler 整段身体, 零语义
      // 改动), 不再二次 spawn。这是 dag_goal 的 `detached` 旗标的对偶: dag_goal 用参数
      // 当开关 (生产默认 in-proc), dag_run 生产面**恒 detached**, 开关只能放 env,
      // 不进工具 schema (schema 里出现 detached:false 就是一句谎话)。
      if (process.env[OMD_DAG_EXEC_CHILD] === '1') {
        return executeDagRunInProc(runId, { task, conductorModel, leafModel, resume, maxFanout, branchStrategy }, deps);
      }
      // resume 冲突检查要含**盘上** (子进程 run 不在本进程内存 —— 例如另一个 dag-exec
      // 正在跑同一个 runId): 漏了它, 第二个子进程会 reopenForResume 一个 running 的 run,
      // 当场把第一个的活顶掉。
      if (resume) {
        const rec = runRegistry.getRecord(resume) ?? runRegistry.ensureFromDisk(resume);
        if (rec && rec.status !== 'failed' && rec.status !== 'cancelled') {
          return {
            content: [{ type: 'text' as const, text: `resume 拒绝: run ${resume} 当前 ${rec.status} (仅 failed/cancelled/未知可续)` }],
            isError: true,
          };
        }
      }
      // ── 续跑恢复入参 (2026-08-23, 接 `goal.ts` 同款; 恢复集见 run-ignition.ts) ──────
      // `resume` 只带 runId, 其余入参由**本次调用**给 —— 漏传一个就按缺省跑, 而缺省未必是
      // 首跑那次的值。dag_run 的恢复集是 conductorModel/leafModel/maxFanout: 换掉执行它的
      // 那两个模型, 续的就不是同一个 run 了。
      // **只在母进程做**: 子进程 (OMD_DAG_EXEC_CHILD) 照 spec 跑, 而 spec 里已是解析后的值 ——
      // 两处各解析一次会漂 (run-ignition.ts 对 branchStrategy 写的是同一条判据)。
      // branchStrategy 不在这套里: 它由 prepareRunWorktree 按**盘上有没有那棵树**判。
      // #253: 档位在**母进程**定死后随 spec 过河 —— 子进程照 spec 跑, 不再自己解析一次
      //   (上面那条「两处各解析一次会漂」逐字适用)。生产缺省来自装配层 = `branch`。
      //   **续跑不套缺省** (理由见 resolveRunWorktree: 首跑 head 的半成品在主树里, 续跑建隔离树
      //   等于让 agent 从零重做) —— 不转发, 子进程按盘上有没有那棵树判。
      const effectiveStrategy = branchStrategy ?? (resume ? undefined : deps.defaultBranchStrategy);
      const cwd = deps.continuity?.repoRoot ?? process.cwd();
      const savedIgnition = resume ? loadIgnitionArgs(cwd, resume) : null;
      const { merged, recovered } = resolveResumeArgs('dag_run', { conductorModel, leafModel, maxFanout }, savedIgnition);
      const runArgs = merged as { conductorModel?: string; leafModel?: string; maxFanout?: number };
      if (resume && recovered.length > 0) {
        logger.info(
          { runId, recovered },
          '[omd/dag-tools] 续跑从点火档案恢复入参 (本次调用没给这几位; 本次给了的一律以本次为准)',
        );
      } else if (resume && !savedIgnition && RECOVERABLE.dag_run.every((k) => runArgs[k as keyof typeof runArgs] === undefined)) {
        // ⚠ 只在**真丢了东西**时警告: 没档案 **且** 本次也一位没给 (仓规 §静默坑 1: 「没档案」
        //   与「档案里首跑就没传」是两件事)。本模块之前的老 run 盘上没有档案, 会走到这里。
        logger.warn(
          { runId: resume },
          '[omd/dag-tools] 续跑没找到点火档案且本次也没给这几位 → 按缺省跑 (本模块之前的老 run 会这样)',
        );
      }
      // 座位自检 (INV-MODEL-5) 在母进程做: 缺座不 spawn, 当场亮错 —— 省一个注定失败的
      // 进程 + 一个注定 failed 的 run 记录。判据与执行体完全同源 (required 检查同一对字段)。
      let defaultConfig: Partial<ExecutorDagConfig> | undefined;
      try {
        defaultConfig = resolveDefaults(rest.defaultConfig);
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `runId: ${runId}\nerror: ${(e as Error).message}` }], isError: true };
      }
      if (!(runArgs.conductorModel ?? defaultConfig?.conductorModel)) {
        return { content: [{ type: 'text' as const, text: `runId: ${runId}\nerror: conductorModel required` }], isError: true };
      }
      if (!(runArgs.leafModel ?? defaultConfig?.leafModel)) {
        return { content: [{ type: 'text' as const, text: `runId: ${runId}\nerror: leafModel required` }], isError: true };
      }
      // 母进程**不登记 run** (goal-worker 同款, goal.ts 注释逐字适用): 登记由子进程做,
      // 它才是属主 (pid 判活要认它)。母进程抢先登记会让盘上留下一个属主是母进程的
      // running 记录, 而母进程随时会走 —— 下一个 session hydrate 就把一个正在跑的
      // run 判成"被打断"。代价是毫秒级窗口: 子进程起来之前 dag_status 查无此 run。
      const spawned = (deps.spawnDagExec ?? defaultSpawnDagExec)({
        tool: 'dag_run',
        runId,
        cwd,
        args: {
          task,
          ...(runArgs.conductorModel ? { conductorModel: runArgs.conductorModel } : {}),
          ...(runArgs.leafModel ? { leafModel: runArgs.leafModel } : {}),
          ...(runArgs.maxFanout ? { maxFanout: runArgs.maxFanout } : {}),
          ...(resume ? { resume } : {}),
          // 隔离档随 spec 过河 —— worktree 由**子进程**建 (它才是属主, 也是要在那棵树里跑的人)。
          ...(effectiveStrategy ? { branchStrategy: effectiveStrategy } : {}),
        },
      });
      if (!spawned.ok) {
        // 起不来要**当场响亮失败**, 不能回一个永远不会出现的 runId (同 goal.ts detached)。
        return {
          content: [{ type: 'text' as const, text: `dag_run 起跑失败: ${spawned.error}` }],
          isError: true,
        };
      }
      // ── 点火留档 (排在 spawn **之后**: 起不来的 run 不留档, 免得盘上攒一堆没人会续的 uuid) ──
      // **首写者赢** (`ifAbsent`): 真续跑不许把首跑的值改掉 —— 本次给了什么由上面的解析决定,
      // 档案只管「首跑那次是什么」。写在 spec.json 隔壁 (同一个 continuity/<runId>/ 目录,
      // 那个目录本来就每次 dag_run 都会多这些未跟踪文件, 本行不新增暴露面)。
      // fail-open: 写不进去不挡这次跑 (helper 内部留一行证据)。
      saveIgnitionArgs(cwd, runId, 'dag_run', runArgs, { ifAbsent: true });
      // 板上还有谁在跑 (2026-08-12)。读面在母进程、写面在子进程 —— 于是这里天然只报**别人**,
      // 不必排除自己。为什么值得占回执两行: 2026-08-12 一天里两次重复派工都跑到实施期才被
      // 人眼发现, 而「在跑的是什么」这一条信息当时就在盘上, 没有任何出口把它印出来。
      const liveNotice = liveRunsNotice(cwd, runId);
      // env 摘要 (片 C, 2026-08-12): 它此前每进程往 stderr 印一行, 没人开那些日志。
      // 移到这里 —— 一个 run 印一次, 印在派工的人正在读的字里。`config=` 那一位尤其:
      // 2026-08-12 我据 `~/.omd/config.json` 判了一次资源不可用并撤了两个健康的 run,
      // 而仓内那份才生效 (role-models.ts:79-88 不越仓边界)。
      const envLine = envSummaryLine(listProviders());
      return {
        content: [{
          type: 'text' as const,
          text:
            `runId: ${runId}\nstatus: running\n` +
            `(子进程 pid ${spawned.pid ?? '?'}, 日志 ${spawned.logPath})\n` +
            // #253: 写落在哪必须**在派工的人正在读的字里**。默认翻成 branch 之后尤其 ——
            // 以为写主树而实际写隔离树, 与反过来一样坏 (人回主树看不到活, 判成"白跑了")。
            (effectiveStrategy
              ? effectiveStrategy === 'branch'
                ? `写入落点: 隔离 worktree (分支 omd/run/${runId}) — 引擎永不自动合回; 判据绿会在树内自动收编成 commit, 合进 main 由你扣扳机。建树失败会退回 head 并在子进程日志标注 degraded。\n`
                : `写入落点: 当前工作树 (head 档, 显式指定) — 这次跑的写与你未提交的改动混在同一片 diff 里。\n`
              : '') +
            // 恢复了必须**在派工的人正在读的字里**说 —— 只写进 logger 就是又一处
            // 「机制在、生产读不出来」(本仓反复付账的形态)。
            (recovered.length > 0 ? `续跑恢复自点火档案: ${recovered.join(', ')} (本次给了的以本次为准)\n` : '') +
            `env: ${envLine}\n` +
            `它不随本会话结束而死。查进度 dag_status runId=${runId} (若刚起跑查无此 run, 等几秒)。` +
            (liveNotice.length ? `\n\n${liveNotice.join('\n')}` : ''),
        }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// dag_run_plan — pre-built plan JSON → execute (skip conductor) → {runId, summary}.
// ---------------------------------------------------------------------------

function makeDagRunPlan(deps: DagToolDeps): OmdMcpTool {
  return {
    name: 'dag_run_plan',
    description: 'Execute a pre-built ConductorPlan JSON (skips conductor). resume=<runId> skips checkpointed nodes.',
    inputSchema: {
      plan: z.string().describe('ConductorPlan JSON string (validated by parsePlan)'),
      task: z.string().optional().describe('Task description (for escalation re-planning seed)'),
      leafModel: z.string().optional().describe('Leaf model (provider:modelId)'),
      resume: z.string().optional().describe('Prior runId to resume — done nodes with valid checkpoints are skipped'),
      maxFanout: z.number().int().positive().optional().describe('Concurrency cap for node fan-out (default: provider pool)'),
      branchStrategy: z
        .enum(['head', 'branch'])
        .optional()
        .describe("'branch' (DEFAULT) = isolated git worktree omd/run/<runId>, never auto-merged back; 'head' = write the current tree (explicit opt-in)"),
    },
    handler: async (args) => {
      const { plan: planJson, task, leafModel, resume, maxFanout, branchStrategy } = args as {
        plan?: string;
        task?: string;
        leafModel?: string;
        resume?: string;
        maxFanout?: number;
        branchStrategy?: BranchStrategy;
      };
      if (!planJson) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_run_plan: missing required param "plan"');
      }

      // Validate plan via parsePlan (rejects invalid ConductorPlan + 未注册 mcp server, D-3 必传注册表)。
      const parsed = parsePlan(planJson, { knownServers: knownMcpServerNames(deps.continuity?.repoRoot ?? process.cwd()) });
      if (!parsed.ok) {
        throw new McpError(ErrorCode.InvalidParams, `dag_run_plan: invalid plan — ${parsed.error}`);
      }

      return launchPlanRun(parsed.plan, { resume, leafModel, maxFanout, task, toolName: 'dag_run_plan', ...(branchStrategy ? { branchStrategy } : {}) }, deps);
    },
  };
}

// ---------------------------------------------------------------------------
// dag_status — runId → status summary (unknown → isError).
// ---------------------------------------------------------------------------

function makeDagStatus(deps: DagToolDeps): OmdMcpTool {
  const { runRegistry } = deps;
  return {
    name: 'dag_status',
    description: 'Get status of a DAG run by runId. Unknown runId → error.',
    inputSchema: {
      runId: z.string().describe('Run ID returned by dag_run or dag_run_plan'),
    },
    handler: async (args) => {
      const { runId } = args as { runId?: string };
      if (!runId) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_status: missing required param "runId"');
      }
      const rec = runRegistry.getRecord(runId) ?? runRegistry.ensureFromDisk(runId);
      if (!rec) {
        return { content: [{ type: 'text' as const, text: `unknown run ${runId}` }], isError: true };
      }
      const summary = runRegistry.getSummary(runId, rec);
      // S3 / C-3 / #250 / INV-11 终态分词 —— done 且 meta.doneKind 在时**追加**一行。
      // 走消费面补一行而不是改 `getSummary` (run-registry.ts 不在本节点写集; 写集契约
      // 不破 = 那是另一节点的活)。三值纪律: meta.doneKind 缺席 = 不适用, 不编 'unknown'。
      if (rec.status === 'done' && rec.meta.doneKind) {
        summary.content.push({
          type: 'text' as const,
          text: `doneKind: ${rec.meta.doneKind}`,
        });
      }
      // S2 孤儿检测 (SDD §2 T2 另一半): running 而属主 pid 不活 ∧ 5min 无 checkpoint 写入
      // → 标 stalled 并写明判定依据。**只标不写**: server 从此不写子进程 run 的状态
      // (写者唯一 = 子进程); 重启后 hydrate 会按打断落 failed, 那才是写侧的事。
      // 反向自检: 把 STALLED_AFTER_MS 改成 0 → kill(pid,0) 判活的瞬间抖动即误标 (测试红);
      // 删掉 isAlive 判据 → 活着的子进程 run 也被标 stalled (测试红)。
      const cwd = deps.continuity?.repoRoot ?? process.cwd();
      const disk = runRegistry.diskRecord(runId);
      const isAlive = deps.isAlive ?? defaultIsAlive;
      if (
        rec.status === 'running' &&
        disk &&
        disk.ownerPid !== null &&
        !isAlive(disk.ownerPid) &&
        continuityAgeMs(runId, cwd) > STALLED_AFTER_MS
      ) {
        const mins = Math.max(5, Math.round(continuityAgeMs(runId, cwd) / 60_000));
        summary.content.push({
          type: 'text' as const,
          text:
            `stalled: 属主进程 pid ${disk.ownerPid} 已不在, 且 ${runId} 无 checkpoint 写入已 ${mins} 分钟 (>5min) — ` +
            `判定依据: SDD §2 孤儿检测 (pid 死 ∧ continuity mtime 龄 > 5min)。它不会自己好了; ` +
            'resume 前先重连 session (hydrate 会按打断落 failed)。',
        });
      }
      // running 态追加 ASCII 层级图 (进度实时渲染)
      if (rec.status === 'running' && rec.progress) {
        const p = rec.progress;
        const ascii = renderProgressAscii(undefined, p);
        summary.content[0] = { type: 'text' as const, text: `${summary.content[0]!.text}\n${ascii}` };
      }
      return { content: summary.content, isError: summary.isError };
    },
  };
}

// ---------------------------------------------------------------------------
// dag_result — runId → full result summary (only if done; unknown/pending/running/failed → error).
// ---------------------------------------------------------------------------

function makeDagResult({ runRegistry }: DagToolDeps): OmdMcpTool {
  return {
    name: 'dag_result',
    description: 'Get full result of a completed DAG run. Non-done status → error.',
    inputSchema: {
      runId: z.string().describe('Run ID returned by dag_run or dag_run_plan'),
    },
    handler: async (args) => {
      const { runId } = args as { runId?: string };
      if (!runId) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_result: missing required param "runId"');
      }
      const rec = runRegistry.getRecord(runId) ?? runRegistry.ensureFromDisk(runId);
      if (!rec) {
        return { content: [{ type: 'text' as const, text: `unknown run ${runId}` }], isError: true };
      }
      if (rec.status !== 'done') {
        return {
          content: [{ type: 'text' as const, text: `run ${runId} is ${rec.status}, not done — result unavailable` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rec.result, null, 2) }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// dag_node_output — runId+nodeId → full node output, paged 4000 chars per call.
// ---------------------------------------------------------------------------

/** Page size (chars) for dag_node_output slices. */
const NODE_OUTPUT_PAGE_SIZE = 4000;

function makeDagNodeOutput({ runRegistry }: DagToolDeps): OmdMcpTool {
  return {
    name: 'dag_node_output',
    description:
      "Get one node's full output from a DAG run, paged in 4000-char chunks via offset. Unknown run/node → error.",
    inputSchema: {
      runId: z.string().describe('Run ID returned by dag_run or dag_run_plan'),
      nodeId: z.string().describe('Node (leaf) ID within the run'),
      offset: z.number().int().min(0).optional().describe('Char offset to start from (default 0); use nextOffset to continue'),
    },
    handler: async (args) => {
      const { runId, nodeId, offset } = args as { runId?: string; nodeId?: string; offset?: number };
      if (!runId) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_node_output: missing required param "runId"');
      }
      if (!nodeId) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_node_output: missing required param "nodeId"');
      }
      if (!runRegistry.getRecord(runId) && !runRegistry.ensureFromDisk(runId)) {
        return { content: [{ type: 'text' as const, text: `unknown run ${runId}` }], isError: true };
      }
      const detail = runRegistry.getNodeDetail(runId, nodeId);
      if (!detail) {
        return {
          content: [{ type: 'text' as const, text: `unknown node ${nodeId} in run ${runId}` }],
          isError: true,
        };
      }
      const start = Math.max(0, offset ?? 0);
      const end = Math.min(start + NODE_OUTPUT_PAGE_SIZE, detail.output.length);
      const page = detail.output.slice(start, end);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              text: page,
              status: detail.status,
              totalChars: detail.output.length,
              nextOffset: end < detail.output.length ? end : null,
            }),
          },
        ],
      };
    },
  };
}
