/**
 * src/mcp/tools/goal —— `dag_goal` 异步工具 (自主 goal 引擎 P1 / INV-GOAL-1)。
 *
 * 一个大 goal 进来 → research → spec → execute → verify → 1 轮修复, 阶段间零人工介入,
 * 返回 runId (三段式同 dag_run: runId → dag_status 轮询 → dag_result 取产物, D-3)。
 *
 * 纯处理器 + 注入 {runGoal, runRegistry, cwd, buildConfig} —— 与 dag-tools 同一注入范式,
 * 测试传 fake 即可端到端跑。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectAnchorMismatch, gitToplevelOf } from '../../harness/goal/anchor-precheck';
import { z } from 'zod';
import type { OmdMcpTool } from '../server';
import type { RunGoalConfig, RunGoalResult, GoalTier, GoalClassification } from '../../harness/goal/run-goal';
import { ignitionPreflight } from '../../harness/goal/ignition-preflight';
import { readIgnitionBandwidth, renderIgnitionForecast } from '../../harness/goal/ignition-forecast';
import { renderNumericClaimNotice } from '../../harness/goal/numeric-claims';
import { loadSddContract, parseBreakdown, ticketFieldsFromSdd } from '../../harness/goal/sdd-direct';
// T-3 契约入库闸与 O-6 切片交付判定共用同一份 git 执行面 —— 造第二个就会漂 (点火闸放行而
// 判定层照样取不到证据, 正是这道闸要消灭的那种「两处判定不同源」)。
import { defaultGitExec } from '../../harness/goal/slice-delivery';
import { checkIgnitionCriteria, type IgnitionRunCommand } from '../../harness/goal/ignition-criteria-check';
import { dryRunSddIgnition } from '../../harness/goal/sdd-ignition-check';
import { checkCoords } from '../../harness/goal/coord-check';
import type { CommandLeafRunner } from '../../harness/leaf-runners';
import { resolveBackend as realResolveBackend, type PathBackend } from '../../harness/pathfinder/backend';
import type { DagNodeEvent, ExecutorDagConfig } from '../../harness/dag/types';
import type { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { RunRegistry } from '../run-registry';
import type { HudRunRecordLike } from '../../hud/mirror';
import { recordDagRun, type DagRecorder, type DagRunRecord } from '../../harness/dag/dag-record';
import { ORCHESTRATING_LOOP_PLAN_NAME } from '../../harness/goal/orchestrating-loop';
import type { AcceptanceProbe } from '../../harness/goal/acceptance-gate';
import type { SpecWrite } from '../../harness/goal/spec-write';
import { isDeliveredOutcome, RUN_OUTCOME_INFO } from '../../harness/run-outcome';
import { summarizeGoalFailure } from '../../harness/goal/summarize-goal-failure';
import { commitRunArtifacts, describeRunWorktree, prepareRunWorktree, runWorktreeBranch, shouldAutoCommit, type BranchStrategy } from '../../harness/run-worktree';
import { captureRollbackAnchor, describeRollback } from '../../harness/writeset/rollback-anchor';
import { readSeatSelfReport, renderSeatLine } from '../seat-self-report';
import { renderOwnerDirectives, type OwnerInbox } from '../owner-inbox';
import { logger } from '../../harness/logger';
import { loadIgnitionArgs, RECOVERABLE, resolveResumeArgs, saveIgnitionArgs } from '../../harness/run-ignition';

export interface GoalToolDeps {
  /** 自主环实现 (默认注入真 runGoal)。 */
  runGoal: (
    goal: string,
    config: {
      cwd: string;
      dag: ExecutorDagConfig;
      maxRounds?: number;
      researchRounds?: number;
      tier?: GoalTier;
      onClassified?: (classified: GoalClassification) => void;
      /** #209 spec 存盘记账钩子: 契约段收尾恰好一次 (worktree 还在的时候), 见 RunGoalConfig.onContract。 */
      onContract?: (specWrite: SpecWrite) => void;
      /** D-2 散雾出口的注入面 (切片 6 接线; 无 map 的仓不传 = 闸缺席, 行为逐字节照旧)。 */
      tickets?: RunGoalConfig['tickets'];
      /** D-2 写集对账的注入面 (盘点表 #3 接线; 无 SDD 写集不传 = 闸缺席)。见 `sddWriteSetFace`。 */
      writeSet?: RunGoalConfig['writeSet'];
      /** P4 设计审核的注入面 (盘点表 #4 接线; 恒注入, 由前端 glob 自闸)。 */
      designReview?: RunGoalConfig['designReview'];
    },
  ) => Promise<RunGoalResult>;
  runRegistry: RunRegistry;
  cwd: string;
  /**
   * **写型 run 的档位缺省** (#253, 2026-08-25) —— 调用方没给 `branchStrategy` 时用它。
   * 与 `DagToolDeps.defaultBranchStrategy` 同一条判据、同一层 (装配层注入 'branch',
   * 纯函数层 `prepareRunWorktree` 的缺省仍是 'head' → 工厂直调零回归)。理由见彼处。
   */
  defaultBranchStrategy?: BranchStrategy;
  /**
   * 决策地图后端解析器 (D-6①③ 的注入接缝; 省略 = `resolveBackend(cwd)` —— env OMD_PATH_BACKEND >
   * 仓库配置 > md)。测试注入替身。**解析抛错 = 挂票缺席不是 run 失败**: gh 探测失败不该让
   * 一次 solve 起不来 (票是控制面, run 是执行面 —— 控制面缺件时执行面照跑, 只是这趟对图不可见)。
   */
  resolveBackend?: (cwd: string) => PathBackend;
  /**
   * engine config 基座 —— **thunk, 每次调用重解** (INV-MODEL-3 无 boot 冻结: 长驻 server 里
   * 装配期算死的座位会让 omd_set_role 改完不生效)。
   */
  buildConfig: (cwd?: string) => Partial<ExecutorDagConfig>;
  /**
   * W2 continuity + **节点级环 journal** (INV-P2-6, D-F 后降级到节点级)。给则:节点落 checkpoint,
   * 两个 conductor 节点 (契约段/执行段) 各自的轮次/毒集/上轮原因落 `_loop-<nodeId>.json` ——
   * `resume=<runId>` 才接得回来。省略 = 不落不续 (自主环仍能跑,但崩了从第 1 轮起且**毒集清零**,
   * 被拒产出会复活)。
   */
  continuity?: { manager: CheckpointManager; repoRoot: string };
  /**
   * omd-hud 活体镜像 (同 dag_run)。省略 = 不写 (HUD 空闲), 不影响执行。
   */
  hudMirror?: { write: (runId: string, record: HudRunRecordLike | null, levels?: string[][]) => void };
  /**
   * 节点事件旁路订阅者 (TUI 活图 / fleet)。**与 `dag_run` 同一个接缝**, 见 `dag-tools.ts:415-425`。
   *
   * ⚠ 2026-08-21 补的正是「同一个洞补了一半」: `:704` 那条注释记着 2026-07-30 撞出的事故 ——
   * 「`dag_goal` 此前一个事件都不发」。当时补了 `runRegistry` 与 `hudMirror` 两半, **这一半没补**。
   * 后果是两个观测面看同一次 run 各说各话: statusline 吃 `.omd/hud/dag.json` 所以是亮的,
   * TUI 吃进程内订阅所以全程是黑的 —— 而「一个面有一个面没有」比「两个面都没有」更难撞见,
   * 这就是它活到今天的原因。
   *
   * 省略 = 不转发 (与补线前逐字节一致)。
   */
  onNodeEvent?: (runId: string, e: DagNodeEvent) => void;
  /**
   * DAG 运行留痕器 (同 dag_run 那一个实例)。
   *
   * goal 这条**一次落两条**: 契约段 `goal-contract` 与执行段 `goal-execute` 各是一张图, `onComplete`
   * 各响一次, 靠同一个 `runId` 归组 —— 「这次 goal 花了多少 token / 吃到多少缓存」就是这两条相加。
   * 挂在 `runGoal` 的 `.then()` 上拿不到这个: 那里只剩 `RunGoalResult`, 两张图的用量已经不在了。
   */
  recorder?: DagRecorder;
  /**
   * 脱离会话子进程的起法 (S2 后半)。默认 = `Bun.spawn` detached + stdout/stderr → 日志 + unref,
   * 与 pathfinder `dispatch.ts` 的 AFK research 同一个 idiom。测试注入替身, **永不起真进程**。
   */
  spawnDetached?: (cmd: string[], opts: { cwd: string; logPath: string }) => number | undefined;
  /**
   * 命令跑手 (S3 / C-3 / #251 接线) —— 给点火判据自证 (`checkIgnitionCriteria`) 适配成
   * `IgnitionRunCommand` 后实跑每片 verify。**预绑 cwd=deps.cwd 主树**:
   * 同装配层 commandRunner (assemble.ts 调 createGoalTool 时一并传入);测试注入替身,
   * **永不起真进程**。省略 = `checkIgnitionCriteria` 不跑 (预检闸退化为写集相交那一道,
   * 仍能拒预绿之外的真相交, 但预绿那一类拒不到 —— 这是接线点缺席, 不是 fail-open)。
   */
  commandRunner?: CommandLeafRunner;
  /**
   * S3 owner 收件箱。给了则每轮把**未消费**的 owner 指令逐字注入下一轮 conductor prompt,
   * 并记账消费轮次 (防同一条指令每轮重放 —— 重放会让 conductor 以为 owner 在反复强调)。
   */
  inbox?: OwnerInbox;
}

/**
 * worker 脚本路径按**本包安装位置**解析 (goal.ts 在 src/mcp/tools/ → 包根/scripts/)。
 *
 * 相对 cwd 拼 'scripts/goal-worker.ts' 在别的 repo 里必然 Script not found, 而错误只进 .log ——
 * run 会静默卡在"起了但永远不出现"。dispatch.ts 的 dag-research 路径解析踩过同一个坑, 同款修法。
 */
function workerScriptPath(): string {
  return join(import.meta.dir, '..', '..', '..', 'scripts', 'goal-worker.ts');
}

/**
 * 默认 spawnDetached: Bun.spawn **detached** + stdout/stderr → 日志文件 + unref (母进程不等)。
 *
 * ⚠ `detached: true` 与 `unref()` 是**两件事**, 少哪个都不叫脱离 (2026-08-21 实测补上):
 *   · `unref()` 只让母进程的事件循环不等它 —— 母进程正常退出时子进程能活;
 *   · `detached: true` 才让子进程**自成会话与进程组**(实测 pid=pgid=sid)。
 * 不给 detached 时子进程的 pgid **就是母进程的 pid**、sid 是母进程的会话, 于是一条
 * 组信号 (`kill -- -PGID`) 或会话拆除时的 SIGHUP 会把它一起带走。
 *
 * 单变量实测 (第三方观察者发信号, 两个方向都量了):
 *   A 只 unref            → 组信号之后子进程**被连坐杀掉**
 *   B 加 detached:true    → 组信号之后子进程**存活**
 *
 * 这条原先只写在注释里 ("Bun.spawn detached"), 而实装没传 —— 声明面与实装面差一个字段,
 * 症状是"后台 run 偶尔莫名其妙没了"且**不留任何痕迹**。仓里 `dag-tools.ts` /
 * `session/final-spawn.ts` / `scripts/session-continuity-hook.ts` 三处一直是对的,
 * 漏的是这里与 `pathfinder/dispatch.ts` 的两处。
 */
export function defaultSpawnDetached(cmd: string[], opts: { cwd: string; logPath: string }): number | undefined {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const fd = openSync(opts.logPath, 'a');
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    detached: true,
    stdin: 'ignore',
    stdout: fd as unknown as number,
    stderr: fd as unknown as number,
  });
  proc.unref();
  return proc.pid;
}

/** 阶段结论压成宽出摘要 (D-8: 客户端上下文只拿结论, 全文自己 Read spec/report)。 */
export function summarizeGoal(r: RunGoalResult): string {
  const lines = [
    `goal: ${r.goal}`,
    `tier: ${r.tier} · ${r.converged ? '收敛' : '未收敛'} · ${r.rounds} 轮`,
    // D-I: 判卷标准进摘要 —— 调用方第一眼就该看见"这次是拿什么判的", 尤其是探索型
    // (它明说没有机器判据, 于是"收敛"这两个字该被读作 judge 的意见而不是 oracle 的结论)。
    // F2: 第三格 rubric —— 它既不是「机器判据」也不是「没有判据」, 摘要上必须分得出来,
    // 否则读的人会把一次逐条判读成探索型的自说自话。
    r.acceptance.kind === 'executable'
      ? `验收: 执行型 · \`${r.acceptance.command}\` (期望退出码 ${r.acceptance.expectExit})`
      : r.acceptance.kind === 'rubric'
        ? `验收: rubric 逐条判 · ${r.acceptance.checklist.items.length} 条 (结晶期冻结, 验收期改一个字即拒)`
        : `验收: 探索型 (无机器判据) · 学习目标: ${r.acceptance.learningGoal}`,
    // ── N5 (2026-07-31): 这一行印的是 **outcome 而不是 status** ────────────────────
    //
    // 上一跑 live 里它印的是 `[failed] execute — 2 轮阻塞: …` —— 一次**判定正确**的 BLOCKED
    // 被念成 failed, 而同一份摘要底下第 106 行那句"阻塞(需外部输入)"读对了。同一份输出两行打架,
    // 而读的人 (和上线闸 G5「触发**并被正确读**」那半格) 只看得见第一行。
    //
    // status 仍在括号里跟着印: 它是全仓 `=== 'done'` 那些消费者判的同一位, 摘要上把两位并排放,
    // 就能一眼看出"没成"与"为什么没成"是两个问题 —— 这正是 P1 在节点级立的那条规矩。
    ...r.stages.map((s) => `  [${s.outcome}${s.status === 'done' ? '' : `/${s.status}`}] ${s.stage} — ${s.summary}`),
  ];
  // D-Q/D-P: "没跑完"的两种收尾要第一眼看得见 —— 它们各自对应完全不同的下一步
  // (阻塞 = owner 去看; 取消 = 直接 resume), 混在 stages 里读不出来。
  // ⚠ N5 之后这三行只报**原因文本**, 不再各自附一句下一步 —— 下一步统一由词表出 (见下),
  //   否则同一件事有两处措辞, 改了词表这里不跟着改就开始漂。
  if (r.blocked) lines.push(`阻塞 (需外部输入): ${r.blocked}`);
  if (r.budgetStopped) lines.push(`预算停: ${r.budgetStopped}`);
  if (r.cancelled) lines.push(`已叫停: ${r.cancelled}`);
  // N5: 终止原因的**下一步**从词表出, 且只在没成的时候印 (成了就没有"下一步"这回事)。
  if (r.outcome !== 'success') {
    const info = RUN_OUTCOME_INFO[r.outcome];
    lines.push(`终止原因: ${r.outcome} (${info.loopState ?? '—'}) · 下一步: ${info.nextAction}`);
  }
  if (r.repoContext) lines.push(`仓内事实: ${r.repoContext.split('\n').length} 行`);
  if (r.specPath) lines.push(`spec: ${r.specPath}`);
  if (r.sources.length) lines.push(`来源 (${r.sources.length}): ${r.sources.slice(0, 5).join(', ')}`);
  if (r.reusedNodes.length) lines.push(`修复轮复用: ${r.reusedNodes.length} 节点`);
  // R-1 第 4 步 (2026-09-03): 循环路径一行人话。机器读 resultOut 头部的 `loop:` 行 (整份 JSON), 这一行给人第一眼:
  // 终审调了几次、首判什么、回灌后有没有新派发 (= 1-A/1-B 的判据面「回灌蒸发」)、卡的直达率、常驻 prompt 大小。
  if (r.loop) {
    const v = r.loop.verifier;
    const after =
      r.loop.dispatchesBeforeReinject !== undefined ? ` · 回灌后新派发 ${r.loop.dispatches.length - r.loop.dispatchesBeforeReinject}` : '';
    let writeAgg = '';
    if (r.loop.dispatches.length > 0) {
      let nFiles = 0;
      let nOrphan = 0;
      let nMissing = 0;
      for (const d of r.loop.dispatches) {
        nFiles += d.filesTouched?.length ?? 0;
        nOrphan += d.writeSet?.orphan.length ?? 0;
        nMissing += d.writeSet?.missing.length ?? 0;
      }
      writeAgg = ` · 触碰 ${nFiles} 文件 / orphan ${nOrphan} / missing ${nMissing}`;
    }
    lines.push(
      `循环: 终审 ${v.calls} 次${v.firstVerdict ? ` (首判 ${v.firstVerdict}${v.target ? ` · 对象 ${v.target}` : ''})` : ' (未调)'}` +
        ` · 回灌 ${v.reinjected ? `是 → ${v.afterReinject}${after}` : '否'}` +
        // D-14 窄复审 (2026-09-04): 只在真跑过时占字符。'skipped' 不印 —— 没触发是常态,
        // 印出来只会稀释这一行里真正要读的那几个数。
        `${v.recheck && v.recheck !== 'skipped' ? ` · 窄复审 ${v.recheck}` : ''}` +
        ` · 派发 ${r.loop.dispatches.length} 次 (卡 ok ${r.loop.cards.ok}/${r.loop.cards.calls})` +
        ` · conductor 常驻 prompt ${r.loop.residentPromptChars ?? '未记'} 字符` +
        `${r.loop.conductorInfraFailure ? ` · ${r.loop.conductorInfraFailure.slice(0, 80)}` : ''}` +
        writeAgg,
    );
    // 判词原文进人读面 (2026-09-04 冒烟 smoke8-p5 抓到): 终态文案一直写着「读 verifierDissent」, 而
    // resultOut 从没印过它 —— 那句指引指向一个人手上不存在的东西。`recheckDissent` 同理: 没有它,
    // `窄复审 pass` 就是无据的一个字 (该字段自己的注释写了这句, 冒烟照出来没兑现)。
    // 截断 600 字符: 判词是散文, 全文进 md 会把这份给人扫的回执压垮; 全文仍在 RunGoalResult 上。
    const cut = (t: string): string => (t.length > 600 ? `${t.slice(0, 600)}…(截断, 全文在 RunGoalResult)` : t);
    if (r.verifierDissent) lines.push(`终审判词 (首判): ${cut(r.verifierDissent)}`);
    if (r.recheckDissent) lines.push(`窄复审判词 (D-14 第二只眼): ${cut(r.recheckDissent)}`);
  }
  return lines.join('\n');
}

// ── R-1 第 4 步 (2026-09-03): resultOut 头部的 `ledger:` 行 ──────────────────────────
//
// bench 容器里 `dag-runs.db` 不出容器 (omd-state.tgz 只扫 <cwd>/.omd, 账本在 omd home), 于是父 run 与 conductor 派发的
// 子 run (同 run_id, plan_name `conductor-*`) 的**节点用量**只有这条路能出去。形状刻意扁: 每条账本行一项, `levels` 只留
// 每层节点数 (宽度 = max, 深度 = length), 节点只留读侧要的计数格。三态照搬账本: 节点上没记的格是 null, 不编 0。
/** `ledger:` 头行里的一条账本行。 */
export interface LedgerHeaderRow {
  plan: string;
  /** 每层节点数 (= levels[i].length)。 */
  levels: number[];
  nodes: Array<{
    id: string;
    kind: string;
    status: string;
    model?: string;
    tokensIn: number | null;
    tokensOut: number | null;
    cacheHitTokens: number | null;
    durationMs: number | null;
    toolCalls: number | null;
    llmCalls: number | null;
  }>;
}

/** 账本行 → 头行形状 (纯函数, 测试直接打)。 */
export function ledgerHeaderRows(records: DagRunRecord[]): LedgerHeaderRow[] {
  return records.map((rec) => ({
    plan: rec.planName,
    levels: rec.levels.map((l) => l.length),
    nodes: rec.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      status: n.status,
      ...(n.model ? { model: n.model } : {}),
      tokensIn: n.tokensIn ?? null,
      tokensOut: n.tokensOut ?? null,
      cacheHitTokens: n.cacheHitTokens ?? null,
      durationMs: n.durationMs ?? null,
      toolCalls: n.toolCalls ?? null,
      llmCalls: n.llmCalls ?? null,
    })),
  }));
}

/**
 * 渲染 `ledger:` 头行 (含换行)。recorder 缺席 / 该 runId 零行 → 空串 (头部无此行 = 没记, 读侧不许当零);
 * 读账本抛错 → 空串 + 一行 warn (fail-open 不吞证据, §静默坑 2)。
 */
export function renderLedgerLine(recorder: DagRecorder | undefined, runId: string): string {
  if (!recorder) return '';
  try {
    const rows = ledgerHeaderRows(recorder.listByRun(runId));
    return rows.length > 0 ? `ledger: ${JSON.stringify(rows)}\n` : '';
  } catch (err) {
    logger.warn({ runId, err: (err as Error).message }, '[dag_goal] resultOut 的 ledger 头行读账本失败 (头部缺该行)');
    return '';
  }
}

// ── D-6①③ (SDD 2026-08-11 控制面统一, 切片 6): 一切 run 挂票 · 一切散雾成票 ──────────
//
// 切片 1 把散雾出口的**纯核**与 run-goal 的注入面都建好了, 却**没有任何生产调用方传它** ——
// 按本仓纪律那就是一个空旋钮 (`loopBudget` 那条踩过同一形态: Present 而非 Wired)。这一段就是那条 wire。
//
// ⚠ 边界 (owner 定向: 票是唯一入口是**方向**, 不是强迫每个仓开图):
//   **仓里没有 map = 行为逐字节照旧** —— 不建图、不改 run、只 log 一行留痕 (INV-1)。
//   多张开放地图且没显式指定 = **不猜** (同 pathfinder `resolveSlug` 的判据: 零/多张都要人说话);
//   猜错图比不挂票坏 —— 票会长在一张与这趟活无关的图上, 而那张图的 owner 不知道它从哪来。

/** run 挂票的落点 (map 句柄 + slug)。undefined = 这趟不挂票, **理由已 log** (不静默)。 */
interface RunTicketTarget {
  backend: PathBackend;
  slug: string;
}

/** 挑这趟 run 挂哪张图。全程 fail-open: 任何一步不成 = 挂票缺席, run 照跑 (控制面缺件不掀执行面)。 */
function resolveRunTicketTarget(deps: GoalToolDeps, wanted: string | undefined): RunTicketTarget | undefined {
  let backend: PathBackend;
  try {
    backend = (deps.resolveBackend ?? ((cwd: string) => realResolveBackend(cwd)))(deps.cwd);
  } catch (e) {
    // gh 后端探测失败会 fail-loud throw (D-E) —— 那是 path_* 工具该炸的地方, 不是 solve 该炸的地方。
    logger.warn({ err: (e as Error).message }, '[dag_goal] D-6 挂票: 后端解析失败 → 这趟不挂票 (run 照跑)');
    return undefined;
  }
  try {
    if (wanted) {
      if (!backend.readMap(deps.cwd, wanted)) {
        logger.warn({ slug: wanted }, '[dag_goal] D-6 挂票: 指定的 slug 在本仓找不到 → 这趟不挂票 (不代建图)');
        return undefined;
      }
      return { backend, slug: wanted };
    }
    const maps = backend.listMaps(deps.cwd);
    if (maps.length === 0) {
      logger.info({ cwd: deps.cwd }, '[dag_goal] D-6 挂票: 本仓无决策地图 → 行为照旧 (path_map 开一张才挂票)');
      return undefined;
    }
    if (maps.length > 1) {
      logger.info({ slugs: maps.map((m) => m.slug) }, '[dag_goal] D-6 挂票: 多张开放地图, 未指定 slug → 不猜, 这趟不挂票');
      return undefined;
    }
    return { backend, slug: maps[0]!.slug };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '[dag_goal] D-6 挂票: 读图失败 → 这趟不挂票 (run 照跑)');
    return undefined;
  }
}

/** 票题上限 (同 run-tickets 的理由: 票是给人一眼判的, 且 map markdown 一票一行)。 */
function ticketTitle(goal: string): string {
  const one = `[run] ${goal.replace(/\s+/g, ' ').trim()}`;
  return one.length <= 160 ? one : `${one.slice(0, 159)}…`;
}

/**
 * ③ 起跑开票 (D-6③「run 天然挂票」)。开的是**任务票** (`ticketClass:'task'`): 这趟 run 要的是施工。
 *
 * 幂等锚 = `suggestedBy === runId`: `resume=<runId>` 走的是同一个 runId, 复用同一张票而不是
 * 每续一次长一张 (票量级噪声化正是 O-3 盯的那件事)。
 * 出生状态 `open` 而非 `ruled` —— **ruled 的 task 票会被 `readyRegion` 收进待交付区域**,
 * 于是 path_deliver 会把一趟正在飞的 run 再编译执行一遍 (双跑双烧)。开票只是让它在图上看得见。
 */
function openRunTicket(
  target: RunTicketTarget,
  cwd: string,
  runId: string,
  goal: string,
  sddPath: string | undefined,
): string | undefined {
  try {
    const existing = target.backend.readMap(cwd, target.slug)?.tickets.find((t) => t.suggestedBy === runId);
    if (existing) return existing.id;
    // 已结晶 SDD 直通档 (sddPath 给了): 把分解表里**整张 SDD 的写集并集 + sddPath 本体**一并带上
    // —— gh 后端走 `Write-set:` / `Sdd-path:` 锚往返 (切片 6 后置, ticket-writeset-anchor.test 是证);
    // md 后端走 StoredTicket 写入磁盘 (同 map-store 写面)。同一份合同, 两条存盘路径, 此处只管 NewTicket。
    const sddFields = sddPath ? ticketFieldsFromSdd(sddPath) : undefined;
    const t = target.backend.addTicket(cwd, target.slug, {
      type: 'task',
      title: ticketTitle(goal),
      blockedBy: [],
      ticketClass: 'task',
      suggestedBy: runId, // G-2: 票 → runId → 回执双向可达
      executorKind: 'goal', // 这张票的执行档位就是"收敛一个开放目标" (D-1: solve 降级为票的一种档位)
      body: `runId: ${runId}\n\n${goal}`, // gh 后端的 issue 正文; md 忽略
      // D-3「#ticket 写集」契约: 缺席 = 不承诺, 显式 `[]` = 承诺但本轮空改 (NULL≠0)。
      ...(sddFields ? { writeSet: sddFields.writeSet, sddPath: sddFields.sddPath } : {}),
    });
    logger.info({ slug: target.slug, ticketId: t.id, runId }, '[dag_goal] D-6③ run 挂票: 已在图上开任务票');
    return t.id;
  } catch (e) {
    logger.warn({ slug: target.slug, runId, err: (e as Error).message }, '[dag_goal] D-6③ 开票失败 → 这趟对图不可见 (run 照跑)');
    return undefined;
  }
}

/**
 * **D-2 写集对账的生产注入面** (盘点表 `docs/plan/2026-08-30-unwired-inventory.md` 主表 #3)。
 *
 * 闸体与纯核早就建成 (`run-goal.ts:1946-1983` + `harness/writeset/write-set.ts`), 缺的只是这一跳:
 * 唯一生产 `runGoal` 调用点从不给 `writeSet` → `if (config.writeSet)` 恒假 → 归属阶梯 +
 * `writeScope` + `sliceCoverage` **三个读数一起缺席**, 而项目 CLAUDE.md §③ 把写集对账列为
 * 第 1 层机械 oracle。
 *
 * 声明面的来源 = **SDD 分解表写集并集**, 与开票那条 (`ticketFieldsFromSdd`) 同一个函数同一份合同 ——
 * 两处若各解析各的, 板上写集与对账写集能不一致而没人看得出来。
 *
 * ## 两条不许错的边
 *
 * ① **没 SDD 就不注入** (返 undefined ⇒ 调用点整个字段不传)。`goal` 无 SDD 时没有任何声明面,
 *    硬造一个等于凭空发明判据。闸缺席是合法态 (`write-set.ts` 的 `verdict:'undeclared'` 讲的
 *    正是「声明缺席 ≠ 违规」), 且与接线前逐字节相同。
 *
 * ② **永远显式给 `declared`, 一次都不落到缺省常量上**。`run-goal.ts:1958` 对 `declared` 缺席的
 *    兜底是 `SDD_DECLARED_WRITE_SET` —— 那是 2026-08-10 那一趟 SDD run **自己**的写面
 *    (allowed `src/harness/**`, forbidden `src/model/**`)。拿它当任意一趟 solve 的声明面, 会让
 *    每个动 `src/model/**` 的活凭空判「撞禁写面」红, 而理由指向一个跟本次运行毫无关系的常量。
 *
 * `forbidden` 留空: 分解表只有「写集」一列 (该写哪儿), 没有「禁写哪儿」—— 没有的东西不硬造。
 * 面外文件由 `classifyWriteScope` 判 `outside` (INV-3 读数, 不红), 这正是它存在的那一格。
 */
function sddWriteSetFace(sddPath: string | undefined, runId: string): RunGoalConfig['writeSet'] | undefined {
  if (!sddPath) return undefined; // ① 无 SDD = 无声明面 = 闸缺席
  try {
    return { declared: { allowed: ticketFieldsFromSdd(sddPath).writeSet, forbidden: [] } };
  } catch (e) {
    // fail-open 可以吞异常, 不许吞证据 (仓规静默坑 2): 记 runId + sddPath + 错误原文。
    logger.warn(
      { runId, sddPath, err: (e as Error).message },
      '[dag_goal] #3 写集对账: SDD 分解表读不出写集 → 声明面缺席 (fail-open, run 照跑)',
    );
    return undefined;
  }
}

/**
 * ③ 终态如实翻票。**只翻读得出的那两格**, 其余留 open 并留痕 (NULL≠0: 不把"没结论"翻成结论):
 *  - **交付达标** (`isDeliveredOutcome`) → ruled(判词=收敛回执) + delivered。两步是因为
 *                           `markDelivered` 只认 ruled 票 (它的语义是"已裁且已交付"), 与 afk-hook
 *                           折入 research 时先 rule 再走同一条路一致 —— 不发明第三个状态翻转口。
 *                           #201 (2026-08-19): 这一格原先判的是 `loopState === 'SUCCESS'`, 于是
 *                           `delivered-with-red` (loopState 恒 null) 掉进最后那个 else, 被念成
 *                           「下一步是接着跑」—— 而 run-outcome 表对它写的是「**别整轮重跑**」。
 *                           判**交付达标**要问 outcome, 不是问环走完没有: 那是两个问题。
 *                           红节点不靠"把票留在重跑队列里"提醒人, 靠判词里写着 (见下)。
 *  - `STALLED` / `BLOCKED` → escalated (G-2: 停在这里, 等人)。顺带打上 D-5 的等人进入戳
 *                           (在 backend.escalate 里, 于是超时升级对这张票也成立)。
 *  - 其余 (EXHAUSTED 加预算 resume / cancelled 原样 resume / ERROR 看栈) → 票留 open:
 *    它们的下一步都是"接着跑", 翻成终态会把一件没完的事记成完了。
 */
function settleRunTicket(
  target: RunTicketTarget,
  cwd: string,
  ticketId: string,
  r: RunGoalResult,
  landing: { runId: string; strategy: BranchStrategy; committed: boolean },
): void {
  const { backend, slug } = target;
  const state = RUN_OUTCOME_INFO[r.outcome].loopState;
  try {
    // ── #202 (承 #200 D1/D6): 交付达标 ≠ 可以翻 delivered ───────────────────────
    //
    // `delivered` 锚在**已合入 main**, 不锚「run 自称成了」。head 档没有待合的东西 (产物直接
    // 写在主树上), 照旧翻; branch 档**此刻必然还没合** —— 合主树是人做的, 而这一行代码跑在
    // run 刚结束的那一刻。
    //
    // ⚠ 所以这里**不问「合了吗」**: 一个零 commit 的分支是 main 的祖先, `merge-base` 会把它
    // 判成 landed —— 那恰好是今晚 #197 的现场 (票 delivered 时分支零 commit)。settle 这一刻
    // 该问的是「有没有东西等着合」, 而那个答案 `commitRunArtifacts` 刚给过 (landing.committed)。
    // 真正的翻票交给之后的 `runBranchLanded` 复查 (afk-hook / 人合完再回流)。
    //
    // 实测现场 (2026-08-19): #196 的票 22:31:58 标 delivered, 而它的收编 commit 22:37:49 才落 ——
    // 票比产物早 6 分钟。这就是本闸要关的窗口。
    if (isDeliveredOutcome(r.outcome) && landing.strategy === 'branch') {
      // 票留 ruled —— 但**留一条可见记录**, 否则它与「裁了还没跑」在盘上长得一模一样。
      // 用评论注记而不是新字段: escalated 票的 `waiting-human` 已是同款先例, 两个后端都通。
      const what = landing.committed
        ? `产物已在 \`${runWorktreeBranch(landing.runId)}\` 收编, 等人合进 main`
        : `但**这一跑没有可收编的改动** (工作树干净) —— 判据绿而写集为空, 值得看一眼是不是白跑了`;
      backend.rule(
        cwd,
        slug,
        ticketId,
        `**awaiting-merge**: run \`${landing.runId}\` 判据绿 (${r.outcome}), ${what}。` +
          `**合主树是人扣扳机** (#200 D1: delivered 锚在已合入 main); 合了之后下一次回流会自动翻 delivered。`,
      );
      logger.info(
        { slug, ticketId, runId: landing.runId, committed: landing.committed },
        '[dag_goal] D-6③ 终态: 判据绿但未合入主树 → 票留 ruled, 等合 (#202)',
      );
      return;
    }
    if (isDeliveredOutcome(r.outcome)) {
      // #201: 有红节点时判词里点名 —— 票翻 delivered 之后没人会再回来看图, 这行字是红节点
      // 唯一的存盘提醒 (run-outcome 表的 nextAction 逐字: 「人审**红节点**, 别整轮重跑」)。
      const red = r.outcome === 'delivered-with-red' ? ' · **图内有节点红, 待人审** (交付达标, 别整轮重跑)' : '';
      backend.rule(cwd, slug, ticketId, `[run 收敛] ${r.rounds} 轮 · 验收 ${r.acceptance.kind}${r.specPath ? ` · spec ${r.specPath}` : ''}${red}`);
      backend.markDelivered(cwd, slug, [ticketId]);
      logger.info({ slug, ticketId, outcome: r.outcome }, '[dag_goal] D-6③ 终态: 票翻 delivered');
    } else if (state === 'STALLED' || state === 'BLOCKED') {
      if (!backend.escalate) {
        logger.warn({ slug, ticketId, outcome: r.outcome }, `[dag_goal] D-6③ 终态: 后端 ${backend.kind} 未实装 escalate → 票留 open (闸缺席)`);
        return;
      }
      backend.escalate(cwd, slug, ticketId);
      logger.info({ slug, ticketId, outcome: r.outcome }, '[dag_goal] D-6③ 终态: 票翻 escalated (等人)');
    } else {
      logger.info({ slug, ticketId, outcome: r.outcome, loopState: state }, '[dag_goal] D-6③ 终态: 票留 open (下一步是接着跑, 不是终态)');
    }
  } catch (e) {
    logger.warn({ slug, ticketId, err: (e as Error).message }, '[dag_goal] D-6③ 翻票失败 → 票停在原状态 (run 已终态落库)');
  }
}

/**
 * 点火消耗预告(owner 2026-08-14):把「烧多少 · 烧不烧契约段 · 烧哪本账」机械印进回执。
 * 坐标取自**这趟真正会用的** dag config,不另解析一遍座位表(第二处解析必漂)。
 * 整段 fail-open:预告算不出来不许把点火挡下来,留一行日志。
 */
/**
 * 规格里的数量声明有没有可跑的出处(2026-08-23,派 #238 时写错「7 条」实为 6 条,
 * 烧掉一趟 23 分钟的现场)。**告知层:只报不拦**,判别靠启发式,误报率还没量过 ——
 * 没量过的启发式不许做成硬闸(仓规 §④)。
 */
function numericClaimLine(goalText: string): string {
  try {
    const notice = renderNumericClaimNotice(goalText);
    return notice ? `${notice}\n` : '';
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '[dag_goal] 数量声明自查失败 (点火照常)');
    return '';
  }
}

/**
 * sddPath 点火空跑闸 (D3 / INV-D3-1 · INV-D3-2) —— 单一函数, detached 与非 detached 两个接线点
 * 共用。判定走 `dryRunSddIgnition` (与 run-goal 的平铺图编译块同源 —— 抄一份必漂, 漂的后果
 * 是「点火闸放行、worker 里照样回落」恰是本契约要消灭的病)。
 *
 * 出口语义 (INV-D3-2):
 *   · fatal    → 同步拒, 错误原文进回执 (强制跑 = 让 worker 死也不知道为什么, **不允许 force 越闸**)
 *   · fallback + force → 越闸放行, logger.warn 留账 (沿 INV-5 force 旧惯例, 不另造第二本账)
 *   · fallback + !force → 同步拒, 原因原文进回执
 *   · ok       → 返回 undefined (调用方继续)
 *
 * 拒了的 run: 零 worker 进程、零 worktree、零 registry 记录 (与 ignitionPreflight blocked 同档)。
 */
function sddIgnitionDryRunGate(
  sddPath: string,
  force: boolean | undefined,
  runId: string,
): { content: { type: 'text'; text: string }[]; isError: true } | undefined {
  const sddText = loadSddContract(sddPath).text;
  const dry = dryRunSddIgnition(sddText);
  if (dry.kind === 'ok') return undefined;
  if (dry.kind === 'fatal') {
    return {
      content: [{
        type: 'text' as const,
        text: `dag_goal sddPath 点火拒绝 (D3 fatal · parseBreakdown 抛): ${dry.err}`,
      }],
      isError: true,
    };
  }
  // fallback —— force=true 是 owner 显式越闸 (沿 INV-5), 留账不另造账本
  if (force) {
    logger.warn(
      { sddPath, runId, reason: dry.reason },
      '[dag_goal] INV-D3-2: sddPath 点火 fallback 越闸 (owner force=true · 沿 INV-5 旧惯例)',
    );
    return undefined;
  }
  return {
    content: [{
      type: 'text' as const,
      text:
        `dag_goal sddPath 点火拒绝 (D3 fallback · compileBreakdown/verify 列问题): ${dry.reason}\n` +
        `改 SDD 收窄判据 / 补写集 / 改 verify 列为命令串, 或 force=true 越闸 (留账)。`,
    }],
    isError: true,
  };
}

/**
 * T-3 契约入库闸 (owner 2026-08-28 裁) —— sddPath 点火前, 契约本身必须已经在 git 里。
 *
 * ## 它治的病
 *
 * O-6 的切片交付判定要回答「这一片的活是不是已经干完了」, 证据是「契约入库之后本片写集
 * 被动过没有」。契约还没提交时**查不到入库点**, 于是没有起点, 剩下唯一能问的是
 * 「写集脏不脏」—— 而脏不脏答不了**是谁弄脏的**: 同一棵树上另一个窗口在同名文件上的
 * 在途改动同样让它脏。而 `already-delivered` 是 O-6 里**唯一放行**的那一格, 假阳性的
 * 后果是整片被跳过、契约修订一行代码都不进 (S-51 同族)。
 *
 * 2026-08-28 那棵树上同时有三个窗口在写, 所以这不是理论风险。
 *
 * ## 为什么做成点火前的闸, 不做成判定里的降级路径
 *
 * 仓规: 能做成会红的闸就别写成散文。判定层那半 (`slice-delivery.ts` 查不到入库点即
 * `available:false`) 是纵深, 它只会让整跑更晚才死; 这道闸让它**在点火那一刻**死,
 * 回执直接说该敲哪条命令。代价明写: 「刚写完契约就开工」要先 `git commit` 契约 ——
 * 而执行契约本来就是写给没有对话上下文的执行器看的真源, 入库是它的正常归宿。
 *
 * 出口语义 (照 D3 空跑闸与 #241 坐标闸同一形状, 不另造第二本账):
 *   · 不是 git 仓 / `git log` 答不了 / 契约在仓外 → **闸缺席** (fail-open, 留一行证据)。
 *     ⚠ 这里必须 fail-open: O-6 只在「切片 verify 已绿」时才问那一问, 而 verify 全红
 *     的图完全健康 —— 拿 git 取不到证据去挡它们是误伤一整类本来能跑的图。
 *   · 查得到入库点 → 放行。
 *   · 查不到入库点 + force → 越闸放行, logger.warn 留账 (沿 INV-5 惯例)。
 *   · 查不到入库点 + !force → 同步拒, 回执带该敲的命令。
 */
function contractCommittedGate(
  sddPath: string,
  cwd: string,
  force: boolean | undefined,
  runId: string,
): { content: { type: 'text'; text: string }[]; isError: true } | undefined {
  const exec = defaultGitExec(cwd);
  const birth = exec(['log', '--diff-filter=A', '--format=%H', '--', sddPath]);
  if (birth.exitCode !== 0) {
    // fail-open 可以吞异常, 不许吞证据: 记下是哪条路径、在哪个 cwd 上问不出来。
    logger.info(
      { sddPath, cwd, runId, exitCode: birth.exitCode },
      '[dag_goal] T-3 契约入库闸缺席 (非 git 仓 / 契约在仓外 / git 答不了) — 点火照常',
    );
    return undefined;
  }
  if (birth.stdout.split('\n').some((x: string) => x.trim().length > 0)) return undefined;
  if (force) {
    logger.warn(
      { sddPath, runId },
      '[dag_goal] T-3: 契约未入库越闸 (owner force=true · 沿 INV-5 旧惯例) — O-6 切片交付判定将恒判 undetermined',
    );
    return undefined;
  }
  return {
    content: [{
      type: 'text' as const,
      text:
        `dag_goal sddPath 点火拒绝 (T-3 · 契约还没提交): ${sddPath} 在 git 里查不到入库点。\n` +
        `O-6 的切片交付判定要拿「契约入库之后写集被动过没有」当证据; 没有入库点就没有起点, ` +
        `同树另一个窗口的在途改动会被读成「本片已交付」而整片被跳过。\n` +
        `先 \`git add ${sddPath} && git commit\` 再点火, 或 force=true 越闸 (留账, 越闸后 O-6 恒判 undetermined)。`,
    }],
    isError: true,
  };
}

/**
 * #241 坐标机械校验闸 (W2-241 S2) —— 与 D3 空跑闸同门, detached 与非 detached 两接线点同一函数。
 * 校验对象 = solve 的 goal 文本 + (有 sddPath 时) SDD 全文; 判定走 `checkCoords` 白名单三形状
 * (INV-W241-1, 判不了的散文碎片一律不验)。实账 0f67293b: 派工文本编造符号名 → 执行体照抄进
 * `rg -e ...` → 无匹配退 1 → 下游 7 节点全 skipped, 一整跑白烧 —— 这道闸把死亡提前到点火同步回执。
 *
 *   · 零命中     → undefined (INV-W241-4 零涟漪)
 *   · 有违规     → 同步拒, 逐条列「原文 · 判据 · 缺在哪」
 *   · force=true → 越闸放行, logger.warn 留账 (沿 INV-5 惯例, 不另造账本)
 */
function coordIgnitionGate(
  texts: readonly { label: string; text: string }[],
  root: string,
  force: boolean | undefined,
  runId: string,
): { content: { type: 'text'; text: string }[]; isError: true } | undefined {
  const findings = texts.flatMap(({ label, text }) =>
    checkCoords(text, { root }).map((f) => `[${label}] ${f.message}`),
  );
  if (findings.length === 0) return undefined;
  if (force) {
    logger.warn(
      { runId, findings },
      '[dag_goal] #241: 坐标校验违规越闸 (owner force=true · 沿 INV-5 旧惯例)',
    );
    return undefined;
  }
  return {
    content: [{
      type: 'text' as const,
      text:
        `dag_goal 点火拒绝 (#241 坐标机械校验): 派工文本里的坐标与仓不符 —— 编造的符号/路径会被执行体照抄进命令 (实账 0f67293b 烧掉整跑)。\n` +
        findings.map((m) => `- ${m}`).join('\n') +
        `\n改正坐标 (确属新建物时在同句写明「新建」), 或 force=true 越闸 (留账)。`,
    }],
    isError: true,
  };
}

function ignitionForecastLine(dag: Partial<ExecutorDagConfig>, sddPath: string | undefined): string {
  try {
    const coords: { label: string; coord: string }[] = [];
    for (const [label, coord] of [
      ['conductor', dag.conductorModel],
      ['leaf', dag.leafModel],
      ['agent', dag.agentLeafModel],
    ] as [string, string | undefined][]) {
      if (coord) coords.push({ label, coord });
    }
    return `${renderIgnitionForecast({ sddPath, coords, bandwidth: readIgnitionBandwidth() })}\n`;
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '[dag_goal] 消耗预告渲染失败 (点火照常)');
    return '';
  }
}

export function createGoalTool(deps: GoalToolDeps): OmdMcpTool {
  return {
    name: 'dag_goal',
    description: 'Autonomous goal: research → spec → execute → verify → 1 repair round. Returns runId.',
    inputSchema: {
      goal: z.string().describe('The goal to pursue autonomously (required). 可选分区: 「## 提示」区 = 建议不构成验收判据; 「## 硬约束」区 = 逐条硬判 (verifier 按此裁)'),
      tier: z.enum(['simple', 'complex']).optional().describe('Force routing; omit = auto-classify'),
      // 上界 4 = PlanNode.max_rounds 的 schema 上界 (环封在 conductor 节点内, D-F) —— 两处必须同数,
      // 不然这里放进来的 5 会在下游被静默钳掉, 又是一个"配了但不生效"的旋钮。
      maxRounds: z.number().int().min(1).max(4).optional().describe('Execute-phase inner-loop round cap (default 2 = 1 repair)'),
      researchRounds: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe(
          'Research inner-loop cap (default 1). ⚠ S6a (2026-09-02) 起该参数暂无消费点 —— ' +
            '契约段自动展开撤销后, 唯一的读点 (旧 auto-generate 分支) 随之删除; 留待 S6b/S7 的' +
            '循环内环接回。',
        ),
      resume: z
        .string()
        .optional()
        .describe('runId of an interrupted dag_goal — resume its inner loop rounds (keeps poison set + green nodes)'),
      detached: z
        .boolean()
        .optional()
        .describe('Run in a background process that survives this MCP session ending (returns immediately)'),
      resultOut: z
        .string()
        .optional()
        .describe("D-G1.3: on terminal state, write 'outcome: <kind>' header + summarizeGoal to this path (pathfinder reflow source)"),
      sddPath: z
        .string()
        .optional()
        .describe('Direct entry: path to a crystallized SDD (docs/plan/*.md). Skips research + contract transcription — the file IS the contract. Rejects files missing 契约/Contracts or 分解/Breakdown sections.'),
      playbook: z
        .string()
        .optional()
        .describe('Direct entry: playbook name from .omd/playbooks/<name>/ or templates/playbooks/<name>/. Mutually exclusive with sddPath.'),
      force: z
        .boolean()
        .optional()
        .describe('S2/INV-5: bypass the ignition preflight hard gate (write-set overlaps a live run). The bypass is recorded on the run board (authoritative force note). Omit = gate enforced.'),
      budgetTokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Stop opening new inner-loop rounds after this many cumulative tokens (soft stop; resume with a bigger budget)'),
      budgetMinutes: z
        .number()
        .positive()
        .optional()
        .describe('Stop opening new inner-loop rounds after this many minutes (soft stop; resume to continue)'),
      slug: z
        .string()
        .optional()
        .describe('Pathfinder map slug this run hangs its ticket on (omit = the single open map; no map = no ticket, behavior unchanged)'),
      branchStrategy: z
        .enum(['head', 'branch'])
        .optional()
        .describe(
          "Where this run's writes land. 'branch' (DEFAULT) = isolated git worktree on branch " +
            'omd/run/<runId>; the engine never merges back — you do (a green acceptance auto-commits inside that tree). ' +
            "'head' = the current working tree; opt in only when you want the writes in front of you and nothing " +
            'else writes this tree. NOTE: an isolated tree is a clean checkout of HEAD — commit first or the run cannot see your uncommitted work.',
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          '#147: Anchor repo for this run. Paths inside the goal text do NOT change the execution anchor — ' +
            'this parameter does. Same repo as the server = explicit anchor confirmation (skips the foreign-path ' +
            'precheck). A different repo requires detached:true — state/logs/continuity land in the target repo via goal-worker.',
        ),
    },
    handler: async (args) => {
      const raw = args as {
        goal?: string;
        tier?: GoalTier;
        maxRounds?: number;
        researchRounds?: number;
        resume?: string;
        detached?: boolean;
        resultOut?: string;
        budgetTokens?: number;
        budgetMinutes?: number;
        branchStrategy?: BranchStrategy;
        sddPath?: string;
        playbook?: string;
        force?: boolean;
        slug?: string;
        cwd?: string;
      };
      // ── 续跑恢复入参 (2026-08-23, owner 现场报) ────────────────────────────────
      // `resume` 只带 runId, 其余入参由**本次调用**给 —— 漏传一个就按缺省跑, 而缺省未必是
      // 首跑那次的值。判据不是「能不能恢复」, 是「**改了它还是不是同一个 run**」:
      // sddPath/tier/researchRounds/cwd 属前者(恢复); maxRounds/budget* 属后者
      //(**不恢复** —— schema 自己写着「resume with a bigger budget」, 那正是 resume 的用法)。
      // branchStrategy 不在这套里: 它由 prepareRunWorktree 按**盘上有没有那棵树**判, 比读档案准。
      const savedIgnition = raw.resume ? loadIgnitionArgs(deps.cwd, raw.resume) : null;
      const { merged: resolvedArgs, recovered: recoveredKeys } = raw.resume
        ? resolveResumeArgs('dag_goal', raw as Record<string, unknown>, savedIgnition)
        : { merged: raw as Record<string, unknown>, recovered: [] as string[] };
      if (raw.resume && recoveredKeys.length > 0) {
        logger.info(
          { runId: raw.resume, recovered: recoveredKeys },
          '[omd/goal] 续跑从点火档案恢复入参 (本次调用没给这几位; 本次给了的一律以本次为准)',
        );
      } else if (raw.resume && !savedIgnition && RECOVERABLE.dag_goal.every((k) => (raw as Record<string, unknown>)[k] === undefined)) {
        // ⚠ 只在**真丢了东西**时警告: 没档案 **且** 本次也一位没给。
        //   若本次自己给了(或这是 detached 首跑, 下面就会把它留档), 那什么都没丢, 别嚷。
        //   「没档案」与「档案里首跑就没传」是两件事 (仓规 §静默坑 1)。
        logger.warn(
          { runId: raw.resume },
          '[omd/goal] 续跑没找到点火档案且本次也没给这几位 → 按缺省跑 (本模块之前的老 run 会这样)',
        );
      }
      const { goal, tier, maxRounds, researchRounds, resume, detached, budgetTokens, budgetMinutes, branchStrategy, resultOut, sddPath, playbook, force, slug, cwd } =
        resolvedArgs as typeof raw;

      // 互斥闸 (handler 层): sddPath 与 playbook 同给 → MCP 错误直接返, 不烧 token。
      // run-goal 入口 (defense in depth) 也有一道相同的闸, 这里先挡掉常规调用路径。
      if (sddPath && playbook) {
        return { content: [{ type: 'text' as const, text: 'dag_goal: sddPath 与 playbook 互斥 — 一次只能走一条' }], isError: true };
      }

      if (!goal?.trim()) {
        return { content: [{ type: 'text' as const, text: 'dag_goal: goal 必填' }], isError: true };
      }
      // #253 (2026-08-25): 档位缺省来自装配层 —— 生产 solve 默认落隔离 worktree, head 变显式 opt-in。
      // **在这里定死一次**, 三处消费者 (detached 转发 · 回执 · prepareRunWorktree) 读同一个值:
      // detached 那条路把它显式写进 `--branch-strategy`, worker 侧不再自己解析一次 (两处各解析
      // 一次会漂 —— 母进程回执说 branch 而 worker 落 head 是最坏的那种漂)。
      //
      // ⚠ **缺省只对首跑生效**: 续跑不套 (dag-tools.ts `resolveRunWorktree` 写了同一条判据的全文 ——
      // 首跑 head 的半成品在主工作树里未提交, 续跑按新缺省建隔离树就看不见它们)。续跑时交回
      // `prepareRunWorktree` 按盘上有没有那棵树判。
      const effectiveStrategy = branchStrategy ?? (resume ? undefined : deps.defaultBranchStrategy);
      // ── #147 点火锚预检: goal 文本里的别仓路径**不改执行锚** ─────────────────────
      // B0 实测 (f5984f2b): 锚错的 solve 烧完 1.11M in 才看得见, 症状与"活没干成"同形。
      // resume 是续跑不是点火, 首跑已裁过锚 (worker 面走 resume 语义, 其 --cwd 即锚决定) → 不再过。
      // 显式 cwd = owner 的锚声明: 同仓 → 确认锚, 跳文本预检; 他仓 → 必须 detached
      // (状态/日志/continuity 全要落目标仓, 进程内路径的 registry 烤死在本锚, 半落半不落比拒绝更坏)。
      let runAnchor = deps.cwd;
      if (cwd !== undefined) {
        let target: string;
        try {
          target = realpathSync(cwd);
          if (!statSync(target).isDirectory()) throw new Error('不是目录');
        } catch (e) {
          return { content: [{ type: 'text' as const, text: `dag_goal: cwd 无效 (${cwd}): ${(e as Error).message}` }], isError: true };
        }
        const anchorRoot = gitToplevelOf(deps.cwd);
        const sameRepo = anchorRoot !== null && gitToplevelOf(target) === anchorRoot;
        if (!sameRepo) {
          if (!detached) {
            return {
              content: [{
                type: 'text' as const,
                text:
                  `dag_goal 拒绝 (#147): cwd 指向别仓 (${target}), 而本 server 锚在 ${deps.cwd}。` +
                  `跨仓点火要 detached:true —— 状态/日志/continuity 由 goal-worker 落在目标仓; ` +
                  `进程内路径的 registry 烤死在本锚, 跨仓会写出半边状态。`,
              }],
              isError: true,
            };
          }
          runAnchor = target;
        }
      } else if (!resume) {
        const mismatch = detectAnchorMismatch(goal, deps.cwd);
        if (mismatch) {
          return {
            content: [{
              type: 'text' as const,
              text:
                `dag_goal 点火锚预检拒绝 (#147): goal 文本提到别仓 [${mismatch.foreign.join(', ')}], ` +
                `而执行锚 = ${mismatch.anchorRoot} (本 server 的 cwd) —— goal 里的路径**不改执行锚**, ` +
                `上一次这样点火 (B0 f5984f2b) 烧完 1.11M in 才看得见。\n` +
                `要在那个仓跑 → 重发带 cwd: "${mismatch.foreign[0]}" + detached: true;\n` +
                `确要在本锚仓跑 (别仓路径只是引用) → 重发带 cwd: "${mismatch.anchorRoot}" 作显式确认。`,
            }],
            isError: true,
          };
        }
      }
      let dag: Partial<ExecutorDagConfig>;
      try {
        dag = deps.buildConfig();
      } catch (e) {
        // 起跑自检 / 座位未配 (INV-MODEL-5): 响亮但不崩 server。
        return { content: [{ type: 'text' as const, text: `dag_goal 拒绝: ${(e as Error).message}` }], isError: true };
      }
      // ── 脱离会话 (S2 后半 / D-W): 把活交给一个不随本 session 死的进程 ──────────────
      //
      // MCP server 是 stdio + 客户端消失即自杀 —— 于是 Claude 会话一结束, 在飞的 goal 就死在半路,
      // 「无人值守」在这条路上物理上不成立。detached 起一个 `scripts/goal-worker.ts` 子进程,
      // 它装同一份 assembleOmdMcpTools 调同一个 dag_goal, **零新执行路径**。
      //
      // 注意这里**不登记** run: 登记由 worker 做 (它才是属主, pid 判活要认它)。母进程抢先登记会
      // 让盘上留下一个属主是母进程的记录, 而母进程随时会走 —— 下一个 session hydrate 就把一个
      // 正在跑的 run 判成"被打断"。代价是有个**毫秒级窗口**: worker 起来之前 dag_status 查无此 run。
      if (detached) {
        const spawn = deps.spawnDetached ?? defaultSpawnDetached;
        const runId = resume || randomUUID();
        // #147: 跨仓点火时锚 = 显式 cwd (runAnchor), 状态/日志随锚走 —— worker 对 --cwd 的语义
        // 本就是"一切 .omd 状态落在这" (B0 第二跑手动验证过的那条路), 这里只是把它接上 MCP 面。
        const logPath = join(runAnchor, '.omd', 'goal-logs', `${runId}.log`);
        const cmd = [
          'bun',
          'run',
          workerScriptPath(),
          '--run-id', runId,
          '--cwd', runAnchor,
          '--goal', goal,
          ...(tier ? ['--tier', tier] : []),
          ...(maxRounds ? ['--max-rounds', String(maxRounds)] : []),
          ...(researchRounds ? ['--research-rounds', String(researchRounds)] : []),
          ...(budgetTokens ? ['--budget-tokens', String(budgetTokens)] : []),
          ...(budgetMinutes ? ['--budget-minutes', String(budgetMinutes)] : []),
          ...(resultOut ? ['--result-out', resultOut] : []),
          // P0 (2026-08-10): detached × branch 曾是参数矩阵空格 —— schema 收参、这里静默丢弃,
          // 三个并发 branch run 全落主树。worker 内是同一个 dag_goal handler, 转发即隔离
          // (prepareRunWorktree 全仓唯一实现; 状态锚随 --cwd 留主仓, 执行锚由 handler 内
          // buildConfig(worktree.cwd) 转向 —— 双 cwd 分离在既有进程内路径上本就成立)。
          ...(effectiveStrategy ? ['--branch-strategy', effectiveStrategy] : []),
          ...(sddPath ? ['--sdd-path', sddPath] : []),
          // 双端转发 (SDD goal-worker --slug, 2026-08-11): 显式 slug 直通 worker —— 与 --sdd-path
          // 同款条件转发; 不带 slug 时逐字节不展开 (INV-1), 无死参数。
          ...(slug ? ['--slug', slug] : []),
        ];
        // D-6①③ (切片 6): detached 路径的挂票**在 worker 里生效**, 不在这里 —— worker 起来后调的是
        // 同一个 dag_goal handler (进程内路径, --cwd 是主仓 → 同一张图), 挂票与散雾出口在那边一次性
        // 接上; 母进程抢先开票会开出两张 (幂等锚 suggestedBy=runId 能救回来, 但那是靠运气不是靠设计)。
        // 留账已清 (cb4a129 → 2026-08-11): slug 随 spawn 参数直通 worker, 隔离后台 run 与前台同等挂票。
        if (force) {
          // 与 slug 同款纪律 (不预留死参数): worker 不认 `--force`, 转发了就是死参数 —— 不转发, 但要念出来,
          // 否则 owner 以为越闸已生效, 而 worker 侧会在写集相交时硬闸拒绝。
          logger.info({ force, runId }, '[dag_goal] INV-5: detached 路径不转发 force (worker 无 --force 参数) — 写集与活 run 相交时 worker 侧将硬闸拒绝');
        }
        // ── D3 sddPath 点火空跑闸 (INV-D3-2 · detached 接线点): spawn 之前过 ─────
        // 与非 detached 同一函数 (sddIgnitionDryRunGate), 判定同源 dryRunSddIgnition。借道首跑
        // 语义 (worker --run-id 路径): resume 字段非空但实质首跑 → trueResume=false → 走闸。
        {
          const rec = resume ? deps.runRegistry.getRecord(runId) : undefined;
          const journalPresent = !!resume && !!deps.continuity && deps.continuity.manager.loadFixpointJournal(runId) !== null;
          const isTrueResume = !!rec || journalPresent;
          if (sddPath && !isTrueResume) {
            const blocked = sddIgnitionDryRunGate(sddPath, force, runId);
            if (blocked) return blocked;
            // ── T-3 契约入库闸 (detached 接线点): 空跑闸之后、spawn 之前 ──────────
            // 排在空跑闸之后是刻意的: 「这份契约根本编译不了」比「它还没提交」更值得先说。
            const uncommitted = contractCommittedGate(sddPath, runAnchor, force, runId);
            if (uncommitted) return uncommitted;
          }
          // ── #241 坐标机械校验 (detached 接线点): goal 文本 + SDD 全文, spawn 之前过 ──
          if (!isTrueResume) {
            const texts: { label: string; text: string }[] = [{ label: 'goal', text: goal }];
            if (sddPath) texts.push({ label: 'sdd', text: loadSddContract(sddPath).text });
            const coordBlocked = coordIgnitionGate(texts, runAnchor, force, runId);
            if (coordBlocked) return coordBlocked;
          }
        }
        let pid: number | undefined;
        try {
          pid = spawn(cmd, { cwd: runAnchor, logPath });
        } catch (e) {
          // 起不来要**当场响亮失败**, 不能回一个永远不会出现的 runId —— 那比不支持 detached 更坏。
          return {
            content: [{ type: 'text' as const, text: `dag_goal detached 起跑失败: ${(e as Error).message}` }],
            isError: true,
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text:
              `runId: ${runId}\nstatus: detached${pid ? ` (pid ${pid})` : ''}\n` +
              // 隔离模式要念出来 —— 调用方以为隔离而实际主树, 比不隔离更坏 (worker 内建树失败
              // 退 head 的 degradedReason 落回执与日志, 这里先把"申请了什么"说清)。
              (effectiveStrategy === 'branch'
                ? `branchStrategy: branch${branchStrategy ? '' : ' (缺省)'} — worker 将建隔离 worktree (omd/run/${runId}); 建树失败会退回 head 并在日志/回执标注 degraded。\n`
                : effectiveStrategy === 'head'
                  ? 'branchStrategy: head (显式) — 写落在当前工作树, 与你未提交的改动混在同一片 diff 里。\n'
                  : '') +
              `日志: ${logPath}\n` +
              ignitionForecastLine(dag, sddPath) +
              numericClaimLine(goal) +
              // #179: 上面 forecast 里的「烧哪本账」座位行是**本 server 内存态** —— 与 detached
              // worker (新进程读盘上 config) 漂移时它撒谎 (实证 run 5382bd05: 回执 mimo, 真身 M3)。
              // 点火时 worker 尚未起跑, 自报恒缺席 → 恒印 UNCONFIRMED 提示; 真身自报落
              // continuity/<runId>/seat-self-report.json, 终审/dag_status 读那份。
              `${renderSeatLine({
                readSelfReport: () => readSeatSelfReport(join(runAnchor, '.omd', 'continuity', runId), runId),
                getServerSeatMemory: () => 'unused (本模块契约: 永不读内存态)',
              })} (自报盘: .omd/continuity/${runId}/seat-self-report.json)\n` +
              // #147: 跨仓锚要念出来 —— run 登记在目标仓的 runs.db, 本 server 的 dag_status 查不到它。
              (runAnchor !== deps.cwd
                ? `锚仓: ${runAnchor} — run 状态落在该仓 .omd/, 本 server 的 dag_status 查不到; 看日志或在该仓起 omd server 查。`
                : `它不随本会话结束而死。查进度 dag_status runId=${runId} (新会话也查得到; 若刚起跑查无此 run, 等几秒)。`),
          }],
        };
      }

      // resume 复用**同一个 runId** —— journal 与 checkpoint 都按 runId 存, 换 id 就等于从零开始。
      if (resume && !deps.continuity) {
        return {
          content: [{ type: 'text' as const, text: 'dag_goal: resume 需要 continuity (未配置 → 无 journal 可续)' }],
          isError: true,
        };
      }
      const runId = resume || randomUUID();

      // ── 真 resume 判定 (D-1 / C-3 INV-8) ─────────────────────────────────
      // 工具面上 `--run-id` 把"调用方给的 runId 起一个 run"做成 `resume` 参数,
      // 而 worker 首跑也走它 (goal-worker.ts 的 buildHandlerArgs: `resume: opt('run-id') ?? ''`)。
      // 于是**`resume` 字段本身**分不出真续跑与借道首跑 —— 判真续跑要看**盘上证据**:
      //   ① registry 已有该 runId 记录 (failed/cancelled 可续, 与 resume 分支同判);
      //   ② 环 journal 已落 (`_fixpoint.json`, owner 续跑一个 runs.db 丢失的老 run 的合法路径)。
      // 两证据是 ∨ 不是 ∧ (D-1 末段): runs.db 丢失后只剩 journal 也要判真 resume。
      // 两者都缺 = 借道首跑: 预检 + criteria-check 照走 (worker 路径不再是静默跳过),
      // 而 `continuity.resume=true` **不**注入 (D-1: 这正是 #242 降级在首跑上误触的根因)。
      let trueResume = false;
      if (resume) {
        const rec = deps.runRegistry.getRecord(runId);
        const journalPresent =
          !!deps.continuity && deps.continuity.manager.loadFixpointJournal(runId) !== null;
        trueResume = !!rec || journalPresent;
      }

      // ── S2 点火预检 (INV-5): 已结晶 SDD 点火前查板上活 run 写集相交 ─────────────
      // 只对 sddPath 直通 (点火路径) 生效 —— 非 sddPath run 点火时没有写集可查, 闸缺席,
      // 行为逐字节照旧 (INV-1)。resume 是续跑不是点火, 不再过闸 (它首跑已过) —— 但
      // `!resume` 是**参数面的语义**, 借道首跑 (worker `--run-id` 路径) 那里恒为 `false`
      // 而**实质是首跑**; 真续跑判定看 `trueResume` (D-1)。预检放在 register/start 之前:
      // 被拒的 run 不许进 registry, 也不建 worktree (无 debris)。
      // detached 路径由 worker 内同一个 handler 走同一段代码 (--sdd-path 已转发), 不在这里重复。
      // force=true 是 owner 的显式越闸声明: **账由预检自己记** (ignitionPreflight 内部把越闸行落
      // board note, INV-5 后半) —— 这里只把声明传过去, 不另造第二本账, 越闸与留账不脱钩。
      // advisories (D-1/D-10: 已结晶未点火 SDD 相交) 只进报告、永不阻塞 —— 预检 verdict 不受其影响,
      // 这里把整份 advisory 列表留到回执里念出来 (blocked 分支也念, 让调用方一次看全)。
      // ── #241 坐标机械校验 (非 detached 接线点): goal 文本 + SDD 全文, ignitionPreflight 之前过 ──
      // 与 detached 同函数 (coordIgnitionGate)。非 sddPath 调用也过 (INV-W241-3: solve goal 文本
      // 同样会被执行体照抄进命令); 零命中零涟漪 (INV-W241-4)。
      if (!trueResume) {
        const coordTexts: { label: string; text: string }[] = [{ label: 'goal', text: goal }];
        if (sddPath) coordTexts.push({ label: 'sdd', text: loadSddContract(sddPath).text });
        const coordBlocked = coordIgnitionGate(coordTexts, deps.cwd, force, runId);
        if (coordBlocked) return coordBlocked;
      }
      let preflightAdvisories: string[] = [];
      if (sddPath && !trueResume) {
        // ── D3 sddPath 点火空跑闸 (INV-D3-2 · 非 detached 接线点): ignitionPreflight 之前过 ─
        // 与 detached 同函数 (sddIgnitionDryRunGate), 判定同源 dryRunSddIgnition。拒了零 registry
        // 记录、零 worktree (IGNITION 拒后 ignitionPreflight 不会跑, 不造第二份 debris)。
        const dryBlocked = sddIgnitionDryRunGate(sddPath, force, runId);
        if (dryBlocked) return dryBlocked;
        // ── T-3 契约入库闸 (非 detached 接线点): 与 detached 同一函数, ignitionPreflight 之前过 ─
        // 拒了零 registry 记录、零 worktree (与 D3 空跑闸同档)。
        const uncommittedBlocked = contractCommittedGate(sddPath, deps.cwd, force, runId);
        if (uncommittedBlocked) return uncommittedBlocked;
        const preflight = ignitionPreflight(
          deps.cwd,
          [...new Set(parseBreakdown(loadSddContract(sddPath).text).slices.flatMap((s) => s.writeSet))],
          { force },
        );
        preflightAdvisories = preflight.advisories;
        if (preflight.verdict === 'blocked') {
          return {
            content: [{
              type: 'text' as const,
              text:
                `dag_goal 点火预检拒绝 (INV-5): 写集与板上活 run 相交 — ` +
                preflight.conflicts.map((c) => `${c.runId} (${c.overlap.join('、')})`).join('; ') +
                `。等对方终态, 或 force 越闸 (留账)。` +
                (preflight.advisories.length ? `\n注意 (不阻塞): ${preflight.advisories.join('; ')}` : ''),
            }],
            isError: true,
          };
        }
      }

      // ── S3 / C-3 / #251 点火判据自证 (INV-9): 预检过 → 逐片 lint+实跑 ──────────
      // sddPath ∧ !trueResume 才是点火, 预检过只是**板上没冲突** —— 预绿 (判据虚) 那一类
      // 预检查不到, 只有 `checkIgnitionCriteria` 真跑 verify 才能抓 (run 85a18995: 零改动 4 分钟
      // 假 done; run bca0a0c7: bun test 多 filter 静默忽略缺失)。commandRunner 注入面缺席
      // (= 接线点无 runner) ⇒ 这一闸缺席, 行为退化为老预检, 这是**接线点缺失不是 fail-open**:
      // 测试注入替身、生产注入同装配层 runner, 两条路都没有 noop 兜底。
      if (sddPath && !trueResume && deps.commandRunner) {
        const slices = parseBreakdown(loadSddContract(sddPath).text).slices;
        const ignRunner: IgnitionRunCommand = async ({ command, cwd }) => {
          const r = await deps.commandRunner!({ command });
          void cwd; // cwd 已在装配层烤死, runner 自管 cwd
          return { exitCode: r.exitCode };
        };
        const criteria = await checkIgnitionCriteria(deps.cwd, slices, ignRunner);
        if (criteria.verdict === 'rejected') {
          const detail = criteria.findings
            .map((f) => `  · slice ${f.sliceId} [${f.kind}]: ${f.detail}`)
            .join('\n');
          return {
            content: [{
              type: 'text' as const,
              text:
                `dag_goal 点火判据自证拒绝 (#251): SDD 写集上 verify 列预绿或判据虚 ——\n${detail}\n` +
                `判据虚或活已干完 (run 85a18995 / bca0a0c7 同形), 改 SDD 收窄判据 / 换 verify, 不要再点火。`,
            }],
            isError: true,
          };
        }
      }
      if (resume) {
        // 同一个 runId 重开: `register` 会因重复 id 抛 (server 还记得这个 run 时), 于是续跑一个
        // **本进程里跑失败/被叫停过**的 goal 原本会当场炸 —— 走 reopenForResume (failed/cancelled/未知
        // 三种都接得住), 与 dag_run/dag_run_plan 的 resume 同一条路。
        // **注意**: 这里仍按**参数面** `resume` 判 —— `trueResume` 是预检/降级的语义,
        // 而 register 的去重与拒收是工具面契约 (resume 分支语义逐字节照旧, INV-12)。
        const rec = deps.runRegistry.getRecord(runId);
        if (rec && rec.status !== 'failed' && rec.status !== 'cancelled') {
          return {
            content: [{ type: 'text' as const, text: `dag_goal resume 拒绝: run ${runId} 当前 ${rec.status} (仅 failed/cancelled/未知可续)` }],
            isError: true,
          };
        }
        deps.runRegistry.reopenForResume(runId, { goal: goal.slice(0, 200), meta: { tool: 'dag_goal', resumed: true } });
      } else {
        deps.runRegistry.register(runId, { goal: goal.slice(0, 200), meta: { tool: 'dag_goal' } });
        deps.runRegistry.start(runId);
      }

      // ── R2 branch strategy (D-Y① / D-AB): 这次跑的写落在哪 ──────────────────────
      // #253 起缺省 `branch` (装配层给, 见 GoalToolDeps.defaultBranchStrategy); `head` 显式 opt-in。
      // `branch` 建隔离 worktree, 而且**引擎永不自动合回** (那是写主干, 按 D-AB 属"需批准"那一档;
      // 同 `path_deliver`, 扳机归 owner)。
      // ⚠ 建不起来会**退回 head 并带 degradedReason** —— 那一格必须念进回话, 否则调用方以为
      // 写在隔离树里而实际写的是主树, 比不隔离坏得多。
      const worktree = prepareRunWorktree({
        cwd: deps.cwd,
        runId,
        ...(effectiveStrategy ? { strategy: effectiveStrategy } : {}),
      });
      // ⚠ **隔离档必须重建 leaf runner** (2026-07-31 live 实测揪出): 上面那次 `buildConfig()` 是
      // 起跑自检, 拿到的 runner 把**装配期**的 cwd 烤死了; 而 `runGoal` 的 `cwd` 参数只管 spec
      // 存盘目录。第一版就漏了这一步 —— worktree 建起来了、回话说"隔离成功"、**产物全落在主树**。
      // 声明面动了执行面没跟上, 而读数上看起来是成功的。
      if (worktree.strategy === 'branch') dag = deps.buildConfig(worktree.cwd);


      // ── D-6①③ (切片 6): 这趟 run 在决策地图上的落点 ────────────────────────────
      // 无图 / 多图未指定 / 后端解析失败 → undefined, 下面两处全部跳过 = 行为逐字节照旧 (INV-1)。
      const ticketTarget = resolveRunTicketTarget(deps, slug);
      const runTicketId = ticketTarget ? openRunTicket(ticketTarget, deps.cwd, runId, goal, sddPath) : undefined;

      // INV-P2-6: continuity 给了才落环 journal; resume 时才读它 (与 per-node resume 同一开关)。
      // D-P: 取消把手一并挂上 —— 自主环是最长活的那条路 (research + 多轮执行), 也是最需要能叫停的。

      // goal 验收探针 (冻结契约 §4): 探针分支在**分类期**就定了, 而 recordDagRun 的 closure 到
      // record 时才读 meta.acceptanceProbe —— 所以这里持同一个可变对象, 分类回调 (onClassified)
      // 里填进去, 两段图的记录就都带上; 非 dag_goal 入口不传 → 列 NULL (见 DagRunRecord 取值矩阵)。
      // entry 词表 (t7, 2026-08-04): 'solve' (旧 'dag_goal' 只在历史行里, 读侧归一合并)。
      const goalMeta: { runId: string; entry: 'solve'; question: string; acceptanceProbe?: AcceptanceProbe; specWrite?: SpecWrite } = {
        runId,
        entry: 'solve',
        question: goal,
      };
      const dagWithContinuity: ExecutorDagConfig = {
        ...dag,
        cancelSignal: deps.runRegistry.attachCancel(runId),
        // **预算轴接线** (2026-07-31): 上一轮实装了 `loopBudget` 却没有任何调用方传它 —— 按本仓纪律
        // 那就是空旋钮, 而三态状态表 (✅/🟡/❌) 里它长得像"做完了"。证据七态词表当场把它抓出来:
        // 它是 `Present` 而不是 `Wired`。这里就是那条 wire。
        ...(budgetTokens || budgetMinutes
          ? {
              loopBudget: {
                ...(budgetTokens ? { tokens: budgetTokens } : {}),
                ...(budgetMinutes ? { ms: Math.round(budgetMinutes * 60_000) } : {}),
              },
              // #158: 整个 solve 一只钟 —— contract 与 execute 两相位共享同一个锚。
              // 不注入的话每次 runExecutorDagWithPlan 自锚, 90min 预算实际是"每相位 90min"
              // (d39b559e 164min 未停的第三半根因)。
              _budgetAnchor: Date.now(),
            }
          : {}),
        // **活体进度** (2026-07-30 取消冒烟撞出来的): `dag_goal` 此前**一个事件都不发** ——
        // 于是最长活的那条路 (research + 多轮执行, 动辄几分钟) 在 `dag_status` 上全程是
        // `planned 0 · started 0 · settled 0`, HUD 也是黑的。dag_run/dag_run_plan 一直有这条线,
        // goal 这条从 P1 起就漏了, 一直没人撞见是因为大家都在看最终结果。
        onNodeEvent: (e) => {
          deps.runRegistry.applyNodeEvent(runId, e);
          deps.hudMirror?.write(runId, deps.runRegistry.getRecord(runId));
          // 旁路在镜像写盘**之后** —— 顺序与 `dag-tools.ts:418-425` 逐字同, 且理由也同:
          // 订阅者再慢也不许让 statusline 的数据源等它; 反过来 statusline 写盘失败 (fail-open)
          // 也不该吃掉这一份转发。订阅者抛错吞掉不打断执行。
          if (deps.onNodeEvent) {
            try {
              deps.onNodeEvent(runId, e);
            } catch (err) {
              logger.warn({ runId, err: (err as Error).message }, '[omd/goal] onNodeEvent 订阅者抛错 (已吞, 不打断执行)');
            }
          }
        },
        ...(deps.continuity
          ? {
              continuity: {
                manager: deps.continuity.manager,
                runId,
                repoRoot: deps.continuity.repoRoot,
                // 执行锚与回滚基线 (2026-08-21, run 58df6b9e 复盘)。上面那行 repoRoot 是**状态锚**
                // (checkpoint 落主仓, 双 cwd 分离是有意的); 而毒集回滚是对**文件**动手, 必须对着
                // leaf 真写的那棵树。此前两者共用 repoRoot, 隔离档下整个回滚打在主仓上 —— 9 条
                // 声明产物逐条判"盘上没有/是跟踪文件", 全部"没撤"。
                //
                // `rollbackBaseline: 'HEAD'` **只给隔离档**: worktree 里的未提交改动只可能来自
                // 这个 runId 自己, 所以"还原到 HEAD"按构造不会误伤 owner 的活。head 档那棵树上
                // 有 owner 自己的未提交改动 —— 一律不给, 保持老行为。
                ...(worktree.strategy === 'branch' ? { execRoot: worktree.cwd, rollbackBaseline: 'HEAD' } : {}),
                // 真续跑才注入 (D-1): 借道首跑 (worker `--run-id` 路径) `resume` 字段非空但
                // **实质是首跑** —— 注入 `continuity.resume=true` 会让 run-goal.ts:912 的
                // `resuming=true` 路径 (=#242 已绿切片降级) 在首跑上误触, 预绿切片被判
                // 「活已干完」降为 command 重验, O-6 vacuous 探针被绕过 → 零改动假 done
                // (站票 run 85a18995)。**只 `trueResume` 时注入**, 借道首跑走的是首跑路径。
                ...(trueResume ? { resume: true } : {}),
              },
            }
          : {}),
        // S3 (D-S): owner 指令逐字进下一轮。**取完即记账** —— 不记账的话同一条指令每轮重放,
        // conductor 会读成"owner 在反复强调这件事"。
        ...(deps.inbox
          ? {
              ownerDirectives: (round: number, nonce: string) => {
                const pending = deps.inbox!.pendingDirectives(runId);
                if (!pending.length) return '';
                deps.inbox!.markConsumed(pending.map((d) => d.id), round);
                return renderOwnerDirectives(pending, nonce);
              },
            }
          : {}),
        // 运行留痕: 两段图各落一条, 同 runId 归组。链上基座自带的 onComplete (今天没有, 但别让
        // 以后加的那个被这里悄悄吃掉 —— 这正是 dag_goal 事件面从 P1 漏到 07-30 的那类洞)。
        ...(deps.recorder
          ? {
              // 两段图 (goal-contract / goal-execute) 都记 'dag_goal' —— 入口是**一次调用**,
              // 不是一张图; 读数板按 runId 去重, 与 criteria 那条同口径。探针走 goalMeta
              // (closure 在 record 时才读它的 acceptanceProbe —— 见 goalMeta 的注)。
              onComplete: recordDagRun(deps.recorder, goalMeta, dag.onComplete),
            }
          : {}),
      } as ExecutorDagConfig;

      // 盘点表 #3: 这趟的 run 级声明写集面 (无 SDD → undefined ⇒ 下面整个字段不传, 闸缺席)。
      const writeSetFace = sddWriteSetFace(sddPath, runId);

      // fire-and-forget: 自主环是长活 (research + spec + 多轮执行), 三段式取结果。
      deps
        .runGoal(goal, {
          // R2: 隔离档下这里就是那棵 worktree; head 档下它逐字等于 deps.cwd (零回归)。
          cwd: worktree.cwd,
          dag: dagWithContinuity,
          // 分类裁决早于第一张图存盘 → 探针从这里进 goalMeta (recordDagRun 的 closure 在 record
          // 时才读 meta.acceptanceProbe, 于是两段图的记录都带上同一份)。
          onClassified: (classified) => {
            goalMeta.acceptanceProbe = classified.acceptanceProbe;
          },
          // #209: 契约段收尾那一刻记 spec 存没存盘 —— **worktree 还在的时候**, 不是事后扫盘。
          // 两处写: ① goalMeta 供执行段那张图存盘时带上; ② 回填契约段那张图 (它已经存盘了,
          // 只走 ① 会让那一行恒 NULL, 而这张表里 NULL = 没记)。
          onContract: (specWrite) => {
            goalMeta.specWrite = specWrite;
            deps.recorder?.updateSpecWrite(runId, specWrite);
          },
          ...(maxRounds ? { maxRounds } : {}),
          ...(researchRounds ? { researchRounds } : {}),
          ...(tier ? { tier } : {}),
          ...(sddPath ? { sddPath } : {}),
          ...(playbook ? { playbook } : {}),
          // ── 盘点表 #3: D-2 写集对账的生产注入面 ─────────────────────────────────
          // 判据全在 `sddWriteSetFace` 的注里 (为什么只在有 SDD 时注、为什么必须显式给 declared)。
          // 注入这一个字段同时点亮三个读数: 归属阶梯 (谁写的) · writeScope (该不该写) ·
          // sliceCoverage (声明了没改)。diff 面不注入 `_collectChangedFiles` ⇒ 走 run-goal 缺省
          // `git status --porcelain`, 且它取的是 `config.cwd` = 隔离档下那棵 worktree (对的那棵)。
          ...(writeSetFace ? { writeSet: writeSetFace } : {}),
          // ── 盘点表 #4: P4 设计审核的生产注入面 (advisory, 不上关键路径) ──────────
          // **恒注入**, 因为这道闸自己会关: `maybeRunDesignReview` 先拿改动文件与前端 glob 求交,
          // 不相交 → `scheduled:false` 当场返回, 零模型调用 (INV-6/G-4)。写型 run 该不该审,
          // 判据是"这趟碰没碰前端", 不是"点火时有没有人记得开开关"。
          //
          // 空对象是**有意的保守缺省**, 逐字段说明:
          //  · `screenshotCommand` 不给 —— 本仓/任意目标仓都没有截图命令的约定面 (全仓仅
          //    run-goal/design-review 两处提到它, 零配置来源)。不给 ⇒ 生产 runner
          //    (`productionDesignReviewRunner`) 返 undefined ⇒ 走 D-10 diff-only 文本审。
          //    ⚠ 反过来更糟: 给了截图命令却没有 runner, design-review.ts:176 会**响亮抛**
          //    (它拒绝拿 diff-only 冒充"看过截图")。宁可审得浅, 不许审得假。
          //  · `escalationSeat` 不给 ⇒ 回落 `dag.conductorEscalationModel` (类型定义写明的缺省)。
          //  · `repairAttempted` 不给 ⇒ 首轮语义。这个调用点没有"修复后再审"那一跳 (D-7 的
          //    熔断/转票要外层驱动), 传 `false` 会假装我们判过"这是第几轮"。
          //  · `profile` 不给 ⇒ 'design-review' (profiles/builtin/design-review.json)。
          designReview: {},
          // ① D-2 散雾出口 (切片 1 的纯核 + 注入面, 到这里才有生产调用方): 这趟的未决/发现物/终态
          // → 图上的 suggested 票。**sink 把 cwd 钉死在主仓** —— run-goal 用 `config.cwd` 调 suggest,
          // 而隔离档 (branchStrategy=branch) 下那是 worktree; 不钉的话票会落进一棵随时会被删的树里
          // (状态锚留主仓, 与 detached 的 --cwd 同一条纪律)。
          ...(ticketTarget && ticketTarget.backend.suggest
            ? {
                tickets: {
                  slug: ticketTarget.slug,
                  runId,
                  sink: {
                    suggest: (_cwd: string, s: string, drafts: Parameters<NonNullable<PathBackend['suggest']>>[2], opts: Parameters<NonNullable<PathBackend['suggest']>>[3]) =>
                      ticketTarget.backend.suggest!(deps.cwd, s, drafts, opts),
                  },
                },
              }
            : {}),
        })
        .then((r) => {
          // N9 判据轴: 两条判据回填到这个 runId 的全部记录。**在这里而不是随 record 一起写** ——
          // 冻结判据的结论要整趟收尾才有, 而 record 是每张图跑完就落的 (执行段存盘时验收还没判)。
          if (r.criteria) deps.recorder?.updateCriteria(runId, r.criteria);
          // R-1 (2026-09-03): 循环路径的读数回填父行 (plan_name 点名, 子 run 行不碰)。
          if (r.loop) deps.recorder?.updateLoop(runId, ORCHESTRATING_LOOP_PLAN_NAME, r.loop);
          // #165② 收编闸: 隔离档 ∧ 机器判据绿 (success / delivered-with-red) → worktree 内自动
          // commit (留 run 锚)。判据红不 commit (shouldAutoCommit 单点判, 反向自检在 run-worktree
          // 测试)。detached 同 handler 同路。合回主树仍由 owner 扣扳机 —— 收编 ≠ 合入。
          let autoCommitLine = '';
          // #202: 「这一跑有没有产物」是 settleRunTicket 判「等不等合」的依据 —— 此刻拿得到, 别让它掉。
          let autoCommitted = false;
          if (shouldAutoCommit({ acceptanceKind: r.acceptance.kind, outcome: r.outcome }, worktree.strategy)) {
            const c = commitRunArtifacts({
              cwd: worktree.cwd,
              runId,
              message: `omd run ${runId}: 冻结判据绿自动收编 (${r.outcome})\n\n${r.acceptance.kind === 'executable' ? `判据: ${r.acceptance.command}` : ''}`,
            });
            autoCommitLine = `autoCommit: ${c.committed ? (c.sha ?? 'ok') : 'no'} — ${c.detail}\n`;
            autoCommitted = c.committed;
            logger.info({ runId, ...c }, '[dag_goal] #165② 自动收编');
          }
          // 未收敛 = 自主环没达成 goal → 记 failed (**不算完成**): 谎报成功比失败更贵,
          // 调用方据此决定要不要人接手。
          // D-P 例外: 被叫停的记 cancelled —— 它没失败, 只是没跑完, 而这两者的下一步不一样
          // (查为什么挂了 vs 直接 resume)。blocked 仍记 failed: 它确实没达成, 只是原因是"要人"。
          // S3 / C-3 / #250 (INV-10): converged 必带 doneKind —— executable 验收 = `verified`
          // (机器判过), exploratory = `exploratory-unverified` (机器没判; 含 #242 vacuous→G4
          // 降级那条路)。三值纪律: 非 goal 入口 (dag_run 等无验收轴) 不传 → meta 无该键。
          if (r.converged) {
            const doneKind: 'verified' | 'exploratory-unverified' | undefined =
              r.acceptance.kind === 'executable' ? 'verified' : 'exploratory-unverified';
            deps.runRegistry.succeed(runId, summarizeGoal(r), doneKind ? { doneKind } : {});
          }
          else if (r.cancelled) deps.runRegistry.cancel(runId, r.cancelled, summarizeGoal(r));
          else deps.runRegistry.fail(runId, summarizeGoalFailure(r));
          // 终态落盘到 HUD 分片 (2026-09-02): 上面 onNodeEvent 只在节点事件时写, 而 succeed/cancel/fail
          // 之后再无节点事件 —— 于是 solve 的分片永远停在 `running`, TUI run 列表把它们当「waiting」
          // 挂一辈子 (实测 96 份, runs.db 全是终态)。dag-tools.ts:486 那条线早就补了, 这里是漏的另一半。
          deps.hudMirror?.write(runId, deps.runRegistry.getRecord(runId));
          // ③ 终态如实翻票 (D-6③)。开票失败过 (runTicketId 缺席) 就没有可翻的 —— 不重开一张:
          // 一张只在终态出现的票读不出"这活跑过多久", 而那正是挂票要给人的信息。
          if (ticketTarget && runTicketId)
            settleRunTicket(ticketTarget, deps.cwd, runTicketId, r, { runId, strategy: worktree.strategy, committed: autoCommitted });
          // t4 (S-3): BLOCKED = 需外部输入 = **红线岔口进收件箱** —— openFork 的第一个生产喂入点
          // (S3 建好收件箱后引擎从没铸过 fork; 无人值守的 BLOCKED 此前只活在 run 摘要里)。
          // blocking=true 语义成立: goal 环判 blocked 时已真停 (证据链 = R3 验证过的采集件, 见
          // invocation-facts 进观察者通道), 不是"带着假设跑"那一档。铸失败只警告 (收件箱是出口不是链路)。
          if (r.blocked && deps.inbox) {
            try {
              deps.inbox.openFork({
                id: `${runId}-blocked`,
                runId,
                // goal 级岔口: 不属于单个节点/轮 —— nodeId 用 goal 语义位, round 用总轮数。
                nodeId: 'goal',
                round: r.rounds,
                question: `[BLOCKED] ${r.blocked}`,
                recommendation: RUN_OUTCOME_INFO.blocked.nextAction,
                assumption: '图已停在这里 (无假设继续跑)',
                blocking: true,
              });
            } catch (e) {
              logger.warn({ runId, err: (e as Error).message }, '[dag_goal] BLOCKED fork 铸造失败 (run 已终态, 岔口丢给了日志)');
            }
          }
          // D-G1.3: 结果存盘 (pathfinder goal 票回流源)。首行 outcome 头 = RUN_OUTCOME_INFO 键,
          // afk-hook 按它三态映射。写失败只警告 —— 结果文件是回流增益, run 本身已终态落库。
          if (resultOut) {
            try {
              mkdirSync(dirname(resultOut), { recursive: true });
              // acceptance 头是回流侧闸 B 的信号线: 探索型 (无机器判据) 的 not-converged 永远
              // 判不出机器收敛, 自动续跑期望收益为零 —— reflow 读到它直接升人, 不写续跑锚。
              // criterion / expectExit 两行 (2026-09-03, 夜链 Q1②): 冻结判据原文给下游机械闸
              // (autoresearch-promote 的「只贴测试文件也绿 = 判据虚」探针) —— 从散文里 grep 判据是
              // 在猜, 头部键值不是。只在 executable 分型下出现, 缺席 = 没有可跑的判据。
              const criterionLines =
                r.acceptance.kind === 'executable'
                  ? `criterion: ${r.acceptance.command}\nexpectExit: ${r.acceptance.expectExit}\n`
                  : '';
              // R-1 第 4 步 (2026-09-03): `loop:` (RunGoalResult.loop 整份 JSON, 只在循环路径出现) + `ledger:` (本 run 全部
              // 账本行的节点用量, 见 renderLedgerLine)。下游键值头读者 (cli-solve 首行 / afk-hook 前三行 / autoresearch
              // criterion 两键) 都按键取, 多两键不碍。缺席 = 没记 (非循环路径 / recorder 缺席), 读侧不许当零。
              const loopLine = r.loop ? `loop: ${JSON.stringify(r.loop)}\n` : '';
              const ledgerLine = renderLedgerLine(deps.recorder, runId);
              writeFileSync(resultOut, `outcome: ${r.outcome}\nrunId: ${runId}\nacceptance: ${r.acceptance.kind}\n${criterionLines}${loopLine}${ledgerLine}${autoCommitLine}\n${summarizeGoal(r)}`);
            } catch (e) {
              logger.warn({ err: (e as Error).message, resultOut }, '[dag_goal] resultOut 写失败 (回流将看不到这跑)');
            }
          }
        })
        .catch((err) => {
          deps.runRegistry.fail(runId, err instanceof Error ? err.message : String(err));
          deps.hudMirror?.write(runId, deps.runRegistry.getRecord(runId)); // 同上: 异常终态也要落分片
          if (resultOut) {
            try {
              mkdirSync(dirname(resultOut), { recursive: true });
              writeFileSync(resultOut, `outcome: error\nrunId: ${runId}\n\n${err instanceof Error ? err.message : String(err)}`);
            } catch { /* 同上: 增益通道, 不掩主失败 */ }
          }
        });

      // ⚠ 回滚锚**必须在点火留档之前**拍照: 留档写 `.omd/continuity/<runId>/ignition.json`,
      //   排在它之后就多一个未跟踪文件 ⇒ 回执从「有完整回滚」退化成「半个」
      //   (2026-08-23 实测 `goal-blocked-fork.test.ts` 的「干净树起跑」当场红; 真实仓
      //   `.gitignore` 有 `.omd/` 所以不受影响, 但**不靠 gitignore 保正确性**)。
      //   ⇒ **留档不许改变回滚读数**, 两句的先后是判据不是风格。
      const rollbackLine = describeRollback(captureRollbackAnchor({ cwd: worktree.cwd }));
      // ── 点火留档 (2026-08-23, owner 报「resume 不继承入参」) ──────────────────────
      // 续跑要恢复入参, 先得有档案。**首写者赢, 不按「是不是 resume」判**: detached 的首跑
      // 在 worker 里也以 resume 身份回调 handler (`goal-worker.ts:51` 的
      // `resume: opt('run-id') ?? ''`, 那注释写着「首次跑也走 resume 这个参数名」) ——
      // 按 resume 判会在 detached 这条路上**永不触发**, 而 detached 正是要治的那条。
      // 已有档案 ⇒ 不覆盖 (真续跑不许改掉首跑的值)。fail-open (helper 内部留证据)。
      saveIgnitionArgs(deps.cwd, runId, 'dag_goal', { tier, researchRounds, sddPath, cwd }, { ifAbsent: true });
      return {
        content: [
          {
            type: 'text' as const,
            // 隔离档必须把目录/分支/合回命令念出来 —— 否则"隔离"退化成"东西不见了"。
            // ⚠ **回滚状态要在起跑这一刻说, 不是跑完在读数板上说**(2026-08-06, D1 / ⑬)。
            //   引擎起跑时已经照过一张同样的快照并落进账本, 但那是**给读数板看的** ——
            //   而需要知道"这次跑坏了回不回得去"的人是**此刻正在按下去的 owner**。
            //   同 `uncommittedWarning` 那条(`run-worktree`): 知识存在, 拿不到它的人正是要用它的人。
            //   ⚠ 多算一次 git(实测仓内 3.4ms), 值 —— 一次 goal 跑动辄几分钟。
            //   ⚠ **只报不拦**: 脏树照跑, 只是把"没有回滚对象"这件事摆在扣扳机之前。
            //   实测 (2026-08-06 首批 4 跑): **4/4 都是 dirty-tracked** —— D-AB 那句
            //   「范围内写可以放手, 因为 git 就是 rollback」在生产上一次都没成立过。
            text:
              `runId: ${runId}\nstatus: running\n` +
              // D-6③: 挂在哪张图上要在**起跑这一刻**说 —— 否则票的存在只有翻日志才知道。
              (ticketTarget && runTicketId ? `ticket: ${runTicketId} (map ${ticketTarget.slug}) — 终态自动翻 delivered/escalated\n` : '') +
              (preflightAdvisories.length ? `注意 (点火预检 advisory, 不阻塞): ${preflightAdvisories.join('; ')}\n` : '') +
              // 同 describeRollback 那条纪律: 要用这个数的人正是此刻扣扳机的人, 跑完再说没用。
              ignitionForecastLine(dag, sddPath) +
              numericClaimLine(goal) +
              `${describeRunWorktree(worktree)}\n` +
              // ⚠ 回滚锚在**这一行**拍照。点火留档写 `.omd/continuity/<runId>/ignition.json`,
              //   排在它之前 ⇒ 拍照时树上多一个未跟踪文件 ⇒ 回执从「有完整回滚」退化成「半个」。
              //   2026-08-23 实测: `goal-blocked-fork.test.ts` 的「干净树起跑」当场红
              //   (真实仓 `.gitignore` 有 `.omd/` 所以不受影响, 但**不靠 gitignore 保正确性**)。
              //   ⇒ 留档挪到锚之后 (下一句), **留档不许改变回滚读数**。
              rollbackLine,
          },
        ],
      };
    },
  };
}
