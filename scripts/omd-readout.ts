#!/usr/bin/env bun
/**
 * omd-readout —— **确定性读数板** (2026-07-31, 承 LangChain 四层栈第 4 层的 report-only 版)。
 *
 * ## 它是什么, 更要紧的是它**不是**什么
 *
 * LangChain 的第 4 层 (hill-climbing) 是「分析 agent 读 trace → 改 harness 配置」。本脚本
 * **刻意只做前半句的确定性版本**: 读 `.omd/dag-runs.db`, 出一组算得出来的数, 零模型调用、
 * 零建议、零改动。
 *
 * 两条理由, 后一条比前一条硬:
 *
 * ① Loop Engineering §7.5 的三重嵌套 (agent 编码循环 / **开发者反馈循环** / 外部反馈循环):
 *    「越往外层, 验证越依赖人的判断」。L4 要自动化的正是中间那一层, 而那一层是内层唯一的方向
 *    校正源。自动化它 = 校正器与被校正者合成同一台机器 —— §4.1「运动员不能当自己的裁判」在更大
 *    尺度上的同一条错误, 只是它自证的不是"我做完了", 是"我该往哪改"。
 *
 * ② §10.1「复杂度是挣来的: 每多加一层机制, 都应该对应一个**已经真实发生**的问题」。
 *    L4 解决的是「从 trace 提炼建议」的**吞吐**。我们的手工版一直在跑 (detector prompt v2→v3→v4、
 *    judgeArtifacts on/off、S1 语料 4→9 段), 而它上一程的结论是**饱和**: 8%→50%→60%→60%,
 *    后两步在噪声内。瓶颈是 prompt 在这个座位上的天花板, **不是分析吞吐**。几十次 live + 9 段语料
 *    一个人读得完, 自动分析在这个数据量上买不到东西, 只会引进第三个没人审的判断者 (D-13)。
 *
 * **什么时候回来重开 L4**: 读数多到一个人读不完 —— 具体化 = live 跑次数过 100 或语料过 30 段。
 * 在那之前, 分析 agent 是在解一个还没发生的问题。
 *
 * ## 它同时兑现了什么
 *
 * S0 把留痕接回生产路径之后, `.omd/dag-runs.db` 至今**零消费者** —— 按七态词表那是 `Wired`
 * 而非 `Exercised`, 与 A1 抓出的空预算轴同一个形状。本脚本就是那个消费者。
 *
 * ## 统一契约 (2026-08-02): readout() 是唯一读数实现, CLI 是薄壳
 *
 * 导出纯函数 `readout(opts)` → `ReadoutResult` (src/harness/omd-readout.test.ts 钉死的契约):
 * 所有统计**先按 entry 隔离、再按 run_id 归并** (一次 goal 两段图合成一笔账); NULL 与 0
 * 严格分开 (没记 ≠ 记了 0); criteria 出四格 + 两个风险格 (每级一行 executed/not_executed,
 * 只统计带 command 的节点; agent/inproc 只进四格)。所有消费者 import 本导出, 禁止另起
 * 读数实现。
 *
 * ⚠ 读取语义: CLI 打开真库用 `new Database(path, { readonly: true })` + `PRAGMA query_only = ON`,
 * 绝不经过 recorder / migrate / schema-bump 路径; `readout()` 自己只 SELECT (不建表/不迁移/
 * 不写 pragma), 表不存在 = 空世界 (合法, exit 0)。
 * 退出码: 0 成功 (空库合法) · 2 参数错 · 3 DB 不可读 · 1 内部错。
 * `import.meta.main` 守卫 (先例 scripts/omd-path.ts): import 本模块只拿 readout/ReadoutResult,
 * 不执行 CLI 顶层 (那会去读真库)。
 *
 * ## 跑法
 *
 *   bun run scripts/omd-readout.ts                      # 默认 .omd/dag-runs.db, 最近 20 次运行
 *   bun run scripts/omd-readout.ts --db <path> --limit 50
 *   bun run scripts/omd-readout.ts --json               # 机器可读 (给以后的 A/B 用)
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commandRiskTier, RISK_TIER_ORDER, type CommandRiskTier } from '../src/harness/command-leaf';
import { TOOL_RENAMES } from '../src/mcp/tool-renames';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { parseMapMarkdown } from '../src/harness/pathfinder/map-store';
import { computeCost } from '../src/model/cost-ledger';
import { shellWriteTargets } from '../src/harness/writeset/shell-writes';
import { isSpecWrite, type SpecWrite } from '../src/harness/goal/spec-write';
import type { LoopLedger } from '../src/harness/goal/loop-ledger';
import type { RollbackAnchorKind } from '../src/harness/writeset/rollback-anchor';
import { detectRuntimeWriteRace, overlapPairsFromWindows, type NodeWindow } from '../src/harness/plan/observers';
import { capsFor } from '../src/model/model-caps';
import { CheckpointManager } from '../src/harness/continuity/checkpoint-manager';
import { readBoard } from '../src/harness/board/run-board';
import type { NodeLoopJournal } from '../src/harness/continuity/types';
import type { DagRunNode } from '../src/harness/dag/dag-record';
import type { AcceptanceProbe } from '../src/harness/goal/acceptance-gate';
import { FAILURE_KIND_INFO, FAILURE_KIND_ORDER, type NodeFailureKind } from '../src/harness/node-failure';
import { RUN_OUTCOME_INFO, RUN_OUTCOME_ORDER, type RunOutcomeKind, type SpendBucket } from '../src/harness/run-outcome';
import { resolveRoleModel } from '../src/model/role-models';
import type { McpCallStatus } from '../src/mcp/client/call-ledger';

// ══════════════════════════════════════════════════════════════════════════════
// 统一契约 (src/harness/omd-readout.test.ts 钉死): readout() 是**唯一读数实现**, CLI 只做
// 参数解析 + 打印。所有统计先按 entry 隔离、再按 run_id 归并; NULL(没记) 与 0(记了且为零)
// 严格分开; criteria 出四格 + 两个风险格 (每级一行 executed/not_executed)。消费者一律
// import 本导出, 禁止复制逻辑或另起实现。
// ══════════════════════════════════════════════════════════════════════════════

/** 归并后一次 run 的读数 (同 runId 的全部记录合成一笔账; 没记 run_id 的老行按主键自成一组)。 */
export interface RunReadout {
  run_id: string;
  /** 该 run 的记录条数 (一次 goal 两段图 = 2)。 */
  attempts: number;
  first_at: number;
  last_at: number;
  /** run 级终止原因 (词表 = run-outcome.ts 全量, 不塌成 success/failure); 整组都没记 → `未记`。 */
  status: RunOutcomeKind | '未记';
  /** 五字段独立求和; 整组记录都没记 usage → null (不是 0)。 */
  usage: {
    conductorIn: number;
    conductorOut: number;
    leavesIn: number;
    leavesOut: number;
    leavesCacheHit: number;
  } | null;
  /** 该 run 里 usage 为 NULL 的记录条数 (没记的, 不是 0)。 */
  usage_unmeasured_attempts: number;
  /** 复用计数求和; 整组都没记 → null (没记 ≠ 0; 记了 0 仍是 0)。 */
  reused: number | null;
  /** 入口 (2026-08-02 入口轴); 没记 → `未记` (不编 'unknown')。 */
  entry: string;
  /** 冻结判据两位 (goal 级回填, 同 runId 各记录同份); 缺席 → null (不编 false/false)。 */
  criteria: { judge: boolean; oracle: boolean } | null;
  /** 冻结契约的验收探针结局 (仅 dag_goal 记); 解析失败/词表外 → null = 没记, 不编桶。 */
  acceptanceProbe: AcceptanceProbe | null;
  /** #209 spec 写入磁盘裁决 (仅 solve 记); 解析失败/词表外 → null = 没记, **不是**「没写入磁盘」。 */
  specWrite: SpecWrite | null;
}

/** 统一契约的完整读数 (测试钉死的形状)。 */
export interface ReadoutResult {
  meta: { db: string; limit: number; readonly: true };
  /**
   * S-1 片d (2026-08-04): 建议接受率 — 扫 docs/plan/pathfinder/*.md 的 suggestionsLog 聚合。
   * rate = (accepted+edited)/decided, decided = accepted+edited+rejected (人的处置);
   * deduped 单列 (机器去重不是人的决定, 混进分母会虚高接受率)。
   * null = 没给 mapsCwd 或没有任何处置史 (「没数据」≠ 0%)。
   */
  suggestion_acceptance: {
    decided: number;
    accepted: number;
    edited: number;
    rejected: number;
    deduped: number;
    /** t3: 图上当前待确认的 suggested 票数 (雾中带存量)。 */
    pending: number;
    rate: number | null;
    /** t3 重跑重复率: deduped / (deduped + decided + pending) — 建议管线的去重扣住了多少比例的车轱辘话。
     *  高 = 上游在重复发现 (或阈值太紧); 一直 0 = 没有重跑压力或去重失效 — 两头都值得看。 */
    dedupe_rate: number | null;
  } | null;
  runs: RunReadout[];
  /** 按 run 去重 (一个 run 多 attempt 只计一次); total = 本窗口 distinct run 数 (含 `未记`)。 */
  outcome_distribution: Record<RunOutcomeKind, number> & { 未记: number; total: number };
  /** 按 entry 分组 (每个 run 只算一次), 顺序 = 首次出现 (first_at)。 */
  entry_distribution: { entry: string; runs: number; attempts: number }[];
  /**
   * cost-per-success, 按 entry 分层 (原任务 ①): usage 先按 runId 归并 (mergeRun 已做),
   * 组内对**已记 usage** 的 run 求和, ÷ 该组 status='success' 的 run 数 (按 run 去重数, 不按行数)。
   * NULL 纪律同上: usage 没记的 run 进 unmeasured_runs 而不是被当 0 加进 tokens;
   * success_runs=0 → tokens_per_success=null (算不出 ≠ 0)。顺序与 entry_distribution 一致。
   */
  /**
   * **注意力轴** (LoopX 对照, 2026-08-05) —— 引擎花掉的**owner 的时间**。
   *
   * 来源是 LoopX 的 `project_reward = f(quantity, quality, token_cost, user_attention_cost)`。
   * 本仓此前四轴(判据/效率/诚实/停止)量的全是**引擎侧**;owner 这一侧的消耗一格没量,
   * 而它恰恰是「这个 loop 值不值得继续开着」的主要成本 —— token 便宜, 人的注意力不便宜。
   *
   * ⚠ **只放今天真有数据源的格**。LoopX 那份模型里的 `avoidable_reasks`(到达 owner 的重复
   * 提问)在本仓**没有数据源**:`deduped` 量的是**被机器挡下的**重复建议, 挡不住而真的问到
   * owner 面前的那些, 账本里一条都没有。所以这里不给它留一个恒 null 的字段 —— 那是空旋钮,
   * 本仓专门有闸在猎它。要量它得先有产生它的记录, 那是另一件事。
   */
  attention_axis: {
    /** 环把球踢回给 owner 的次数(outcome=blocked 的 run 数)。 */
    blocked_runs: number;
    /** 分母 = 本窗口 distinct run 数(含「未记」)。 */
    total_runs: number;
    /** blocked_runs ÷ total_runs。**多大比例的跑最后要 owner 出手。** total=0 → null。 */
    handback_rate: number | null;
    /**
     * 图上待 owner 确认的建议票(存量)。
     *
     * ⚠ null 有**三种**成因(继承自 {@link suggestion_acceptance},此处不另立口径):没给
     * `mapsCwd` · 没有 `docs/plan/pathfinder` 目录 · 有图但既无处置史也无 suggested 存量。
     * 三者今天在同一个 null 里 —— 这一格**分不出来**,别把它读成「图上没有票」。
     */
    pending_tickets: number | null;
    /** owner 真处置过的建议数(accepted+edited+rejected)。null 的三种成因同上。 */
    decided_tickets: number | null;
    /** 其中被拒的 —— **看了、花了时间、没换来东西**的那部分。 */
    rejected_tickets: number | null;
    /**
     * rejected ÷ decided:owner 的处置里有多大比例是白看的。
     * 高 = 建议管线在拿 owner 当过滤器。decided=0 → null。
     */
    wasted_review_share: number | null;
  };
  /**
   * **消耗口径** (LoopX 对照, 2026-08-05): 把 token 按 {@link SpendBucket} 分桶,
   * 于是「每次成功要花多少」这个数问的是**引擎效率**, 而不是引擎效率 + 环境噪声的混合。
   *
   * 移植自 LoopX 的 quota 纪律 (`spend-slot` 只在验证 + 写回之后调用, 静默 skip /
   * preflight 失败 / dry-run 不消耗额度)。omd 没有额度制, 对应物就是这里的分母口径。
   *
   * ⚠ **两个口径并排给, 老的一个字不动**。仓规「加尺子必然让数难看」的记法: 新口径会让
   * `tokens_per_success` 变小 (分子剔掉了 overhead), 只留新数会读成"引擎突然变便宜了"。
   * 差额本身才是读数 —— 它等于 {@link overhead_share} 那部分钱。
   *
   * ⚠ 口径与 {@link cost_per_success} 一样取**展示窗口** (`shown`) 而非全量: 两个数要能
   * 直接相减, grain 不同就没法比。这不是闸的判据, 所以不适用「闸的数一律全量」那条。
   */
  spend_discipline: {
    /** 每桶: run 数 / token 求和 / usage 没记的 run 数 (不进求和, 不当 0)。 */
    buckets: Record<SpendBucket | '未记', { runs: number; tokens: number; unmeasured_runs: number }>;
    /** 四桶 + 未记的 token 总和 (= 老口径的分子)。 */
    total_tokens: number;
    /** success run 数 (两个口径共用的分母)。 */
    success_runs: number;
    /** **老口径**: 全部 token ÷ success。改动前 `cost_per_success` 用的就是这个算法。 */
    tokens_per_success_all: number | null;
    /** **新口径**: 只有 delivery 桶 ÷ success。success=0 → null (算不出 ≠ 0)。 */
    tokens_per_success_delivery: number | null;
    /** overhead ÷ total。**多少钱花在了根本没在试图达成目标的跑上**。total=0 → null。 */
    overhead_share: number | null;
    /** blocked ÷ total。高 = 环经常被外部挡住 —— 那是 owner 注意力的账, 不是引擎的账。 */
    blocked_share: number | null;
  };
  cost_per_success: {
    entry: string;
    runs: number;
    success_runs: number;
    /** usage 为 null 的 run 数 (没记, 不是 0) —— 它们不进 tokens 求和。 */
    unmeasured_runs: number;
    tokens: { conductorIn: number; conductorOut: number; leavesIn: number; leavesOut: number; leavesCacheHit: number };
    /** (conductorIn+conductorOut+leavesIn+leavesOut) ÷ success_runs; cacheHit 是折扣标记不是开销, 不进分子。 */
    tokens_per_success: number | null;
  }[];
  criteria_grid: {
    /** 四格互相独立、标签不合并; 和 = DAG 节点全集 (同 id 跨记录并集, 不按记录求和)。 */
    four_grid: { executed_success: number; executed_failure: number; reused_success: number; 未记: number };
    /**
     * 风险维度自成一个执行/未执行二分, **独立**于四格 (不并入四格、不折叠风险级), 每级一行。
     * ⚠ 只统计带 command 的节点 (agent/inproc 不入格, 但四格里照数, 不许静默丢);
     *   not_executed 只含记录为 reused 的节点; 缺席一律归四格「未记」, 不混进 not_executed。
     */
    two_grid_risk: { risk_level: CommandRiskTier; executed: number; not_executed: number }[];
  };
  /**
   * **全量口径**的判据轴(2026-08-06 补)—— 与下面 `criteria_consistency` **同形但口径不同**。
   *
   * ⚠ 两个都留着, 是因为它们答的**不是同一个问题**:
   *   · `criteria_consistency` 走**展示窗口**(最早 `limit` 个 run)—— ⑫ 那一段整体是窗口口径,
   *     它得跟着那一段走, 否则同一段里混两种口径;
   *   · `criteria_axis` 走**全量** —— 「judge 太紧过几次」是"有没有发生过、发生过几次",
   *     那不是一个窗口问题。⑩ 段与 ⓪ 导航都读这一个。
   *
   * ⚠ 2026-08-06 实测两者相差 **2/7 vs 4/13** —— 不标口径就是同一页两个数(⑨/⑫ 那个形状的
   *   第三次)。而 ⑩ 那张表此前**根本不在契约里**(算在渲染层, 没人闸得着), 那同时是个 S-21。
   */
  criteria_axis: { agree: number; oracleFailed: number; wastedRounds: number; agreeFail: number; recorded: number; unrecorded: number };
  /** 判据轴 {judge, oracle} 四格, **展示窗口内**, 按 runId 去重数; 缺席单列 unrecorded (不编 false/false)。 */
  criteria_consistency: {
    agree: number;
    oracleFailed: number;
    wastedRounds: number;
    agreeFail: number;
    unrecorded: number;
    recorded: number;
  };
  /** 分子 = 记录为 reused 的节点 (并集); 分母 = DAG 全量节点 (含 `未记`); total_nodes=0 → rate null。 */
  /**
   * G4 采样 (冻结契约 §5): 分母 = **全量** entry='solve' (旧 'dag_goal' 归一后同) 且 acceptance_probe 非 NULL 的 run
   * (2026-08-03 起不再受展示窗口截断 —— 闸的判据不搭展示的车, 理由见计算处的注)。
   * 老行/未接探针的 run (NULL) 不进分母, 不编 'unknown'; exploratory 是派生数
   * (= demoted + skipped + exploratory 三条 kind 之和)。
   */
  g4_sampling: {
    denominator: number;
    passedBoth: number;
    vacuityOnly: number;
    demoted: number;
    skipped: number;
    exploratory: number;
  };
  /**
   * #209 spec 写入磁盘频率 —— 「契约段跑了却没产出 spec 文件」有多常见。
   *
   * 分母 `denominator` = entry='solve' 且 `spec_write` 非 NULL 的 run (老行 / 没记的不进)。
   * `missRate` 的分母**只算真跑了契约段的那部分** (`wrote + missing`) —— `notNeeded`
   * (simple 档 / 缺 agentRunner) 压根没有契约段, 混进去会把这个数稀释成没意义的小数。
   * 真跑过契约段的 run 为零 → `missRate: null` (**不知道**, 不编 0)。
   */
  spec_write_sampling: {
    denominator: number;
    wrote: number;
    missing: number;
    notNeeded: number;
    contractRuns: number;
    missRate: number | null;
  };
  /**
   * **闸的分母** (2026-08-03) —— 全量, **不受展示窗口截断**。
   *
   * 为什么单列一格: 上线闸里 G3 要「20 次 live」、G4 要「采样 ≥10 次」, 而这块板的 run 表
   * 按冻结契约只显示**最早 limit 个**。两者搭在一起的后果是: 历史 run 一超过 limit,
   * **以后每跑一次都落在窗口外**, 闸的分母永远停在同一个数 —— 而板上看不出它停了。
   * 2026-08-03 连跑三次 live, `--limit 20` 下 entry 分布一动不动, `--limit 40` 才看得见。
   *
   * `ledgerGap` = **跑了但没记上**的条数: 在 run 注册表 (`runs.db`) 里有、而在留痕库
   * (`dag-runs.db`) 里没有的 run。S-12 的写穿失败就长这样 —— 那次跑烧了钱、交付了正确产物,
   * 却在留痕库里零行, 于是它在板上**和"没跑"长得一模一样**。分母的缺口不等于"少跑了几次"。
   * ⚠ 读不到注册表 (路径不在 / 打不开) → `null` = **不知道**, 不编 0 (编 0 就是把"没查"
   * 说成"没有")。
   */
  gate_denominators: {
    /** G3: 带 `entry` 的 distinct run (全量)。 */
    g3LiveRuns: number;
    /** G4: entry='solve' (含归一的旧 'dag_goal') 且探针非空的 distinct run (全量, = g4_sampling.denominator)。 */
    g4Samples: number;
    /**
     * 跑了但留痕库里没有的条数; null = 注册表读不到, **不知道**。
     *
     * ⚠ **`total` 里混着合法缺席**, 别直接当缺陷数读: 一次在跑到 DAG 之前就失败的 run
     * 本来就没有留痕可记, 一个 `running` 的孤儿也还没有终态。**可行动的是 `done`** ——
     * 注册表说它跑完了, 留痕库里却一行都没有, 那是量具真漏了一次 (S-12 那条的形状)。
     * 2026-08-03 首测: total 5 / done 3 (t3a · t5a · t9b), 也就是说这个缺口**不是偶发**。
     */
    ledgerGap: { total: number; done: number } | null;
  };
  /**
   * 复用率 —— 分母**只认记了节点级复用的跑**(2026-08-06 改)。
   *
   * ⚠ 此前它是"推"出来的,而推的前提是假的(复用节点其实**在**执行结果里),于是恒为
   * **0.0%** —— 一个读起来像"复用根本没在工作"的假零。改成读 `DagRunNode.reused`。
   * ⚠ `unknownRuns` = 声明了复用而节点面没标的跑(老行)——**它们算不出,不进分母**,
   *   与"记了而没复用"是两件事。
   */
  reuse_rate: { reused_nodes: number; total_nodes: number; rate: number | null; unknownRuns: number };
  /**
   * 「声称 vs 引擎记录」检出器的活体读数(2026-08-05)。report-only 那条判据要不要升成硬拦,
   * 就看这一段:① 活体基率 ② 活体误伤(靠 `samples` 里的原句逐条人工核对)。
   *
   * ⚠ **分母只算 `claim_check` 非空的跑**。这个口径错过一次:那条判据原本只活在 conductor 内环,
   * 而 `dag_run` 那条路整张图可以一个 conductor 都没有 —— 判据结构上够不着,而当时账本记出来的
   * `observations: []` 与"查过零检出"逐字相同,于是约一半流量进错分母,基率被算低近一倍。
   * ⚠ 两面**宽度不同,不许相加**:conductor 含产物内容读盘,flat 只有 output+facts。
   * ⚠ 样本不够时**不许下结论** —— 见 `CLAIM_CHECK_MIN_NODES`。这一位是 2026-08-05 在**数据到达
   *   之前**钉的:那之前这段在 N=2 个节点时也照样印「检出 0 条 [0.0%]」,而那个 0% 没有信息量。
   */
  claim_check: {
    /** 记了这一位的跑数(判据够得着 → 进分母)。 */
    recordedRuns: number;
    /** 没记这一位的跑数(早于该列 → **不进分母**,不是零检出)。 */
    unrecordedRuns: number;
    conductor: { rounds: number; nodes: number; findings: number; rate: number | null };
    flat: { nodes: number; findings: number; rate: number | null };
    /** 检出原句样本(拨闸靠逐条读它判是不是误伤)。 */
    samples: { runId: string | null; message: string }[];
    /** 两面各自「够不够下结论」。**分开算** —— 一面够了不代表另一面够了。 */
    sufficiency: { conductor: FaceSufficiency; flat: FaceSufficiency };
  };
  /**
   * ⑧「产物没变」判据(`loop-no-artifact-change`)的**分母**(2026-08-06)。
   *
   * 为什么单开一段而不是接着数 `observations` 里的次数:那一栏只有分子。⑧ 段此前把
   * 「53 跑 0 次命中」读成活体基率 ≈ 0,而**运行次数根本不是这条判据的机会单位** ——
   * 它住在 conductor 内环,一次比较要同时满足①内环真转到第二圈②两轮都有产物信号③两侧都读得到。
   * 单轮档的 `dag_run`(`max_rounds` 缺省 1)与首轮即绿的 goal **一次机会都没有**。
   *
   * 同表其他 kind 有数**不能反证这条够得着**:`undeclared-artifact-dep` / `write-race` 是
   * 跑之前的静态判死,`leaf-spin` 住在 leaf 自己的工具循环里 —— 三条**没有一条**经过
   * conductor 的跨轮路径。拿它们当"仪器是活的"的证据,证的是别的仪器。
   *
   * ⚠ 三个数别相加、别互相替代:`comparable = transitions - unobserved` 才是基率分母。
   */
  artifact_move: {
    /** 记了这一位的跑数(2026-08-06 起)。 */
    recordedRuns: number;
    /** 没记这一位的跑数(老行)—— **不进任何分母**,不是 transitions:0。 */
    unrecordedRuns: number;
    /** 有上一轮可比的轮转次数(首轮不算)。 */
    transitions: number;
    /** 其中判不了的(population 空 / 有读不到的文件)。 */
    unobserved: number;
    /** 真判过的次数 = `transitions - unobserved`。**活体基率的分母就是它**。 */
    comparable: number;
    /** 其中判成"盘上没位移"的次数。 */
    findings: number;
    /** `findings / comparable`;分母 0 → null(**算不出 ≠ 0%**)。 */
    rate: number | null;
    /** 同一个门槛(`LOOP_NO_MOVE_MIN_N`)读三个槽 —— 三个 0 的下一步相反,见该常量。 */
    sufficiency: { runs: FaceSufficiency; transitions: FaceSufficiency; comparable: FaceSufficiency };
  };
  /**
   * **运行时**写竞争(2026-08-06)—— 这条通道此前**根本不存在**。
   *
   * 台账把「leaf 级写竞争频率」标成「等读数」,而 ⑧ 段那 4 次 `write-race` 出自
   * `static-lint`(跑之前按 `output_path` 声明判死的坏 plan),**不是运行时并发撞车**。
   * 同名不同义,而两者的下一步相反:前者改图,后者要问这两个 leaf 为什么碰同一个文件。
   * 交接 30 §五 第 2 条说的就是这一格 —— 再等也不会有数,因为没有一行代码写它。
   *
   * ⚠ 三个数别互相替代:`pairs`(两侧都报过写的重叠对)才是"撞得上"的机会;
   *   `overlaps - pairs` 是**看不见的那部分**(一侧没报写:真没写 or 写了而 `filesTouched`
   *   够不着),两者今天分不开,所以不进机会分母。
   */
  write_race: {
    recordedRuns: number;
    unrecordedRuns: number;
    /** 执行窗口真重叠过的节点对数(有没有并发本身)。 */
    overlaps: number;
    /** 其中两侧都报过**受控写**的对数 —— **严格**机会分母。 */
    pairs: number;
    findings: number;
    /** `findings / pairs`;分母 0 → null(**算不出 ≠ 0%**)。 */
    rate: number | null;
    /**
     * **推断口径**(2026-08-06 补):把「命令原文点名要写、且那个文件在本节点执行窗口内变过」
     * 的候选并进来之后的机会 / 命中数。它补的是 `filesTouched` 只认受控写工具留下的两个盲点:
     * `command` 节点那一路从不填、agent 既用受控工具又用 bash 写时 bash 那部分隐形。
     *
     * ⚠ 与严格那两个**不许相加也不许互相替代**:这一档含推断(`a && b > x` 里 `a` 失败时
     *   `x` 并没有被写)。`pairsInferred - pairs` = 只有推断才看得见的那一块,
     *   `overlaps - pairsInferred` = 两条判据都够不着的那部分。**要升闸的人必须先看见这个分野。**
     * ⚠ 缺席(null)= 早于本次改动的行,不是 0。
     */
    pairsInferred: number | null;
    findingsInferred: number | null;
    /** `findingsInferred / pairsInferred`;分母 0 或缺席 → null。 */
    rateInferred: number | null;
    /** 同 ⑧ 用 `LOOP_NO_MOVE_MIN_N`:三个槽的 0 下一步各不相同。 */
    sufficiency: { overlaps: FaceSufficiency; pairs: FaceSufficiency; pairsInferred: FaceSufficiency };
    /**
     * **command 节点这一侧到底写不写文件**(2026-08-06)—— 「推断口径为什么不涨」的先行答案。
     *
     * ⑧.6 的推断口径靠 `shellWriteTargets` 从**命令原文**认写目标。那条判据认不出东西时,
     * 有两种完全不同的成因:① 判据太窄(该收窄盲点)② **这些命令本来就不写文件**。
     * 两者的下一步相反,而只看 `pairsInferred` 分不开 —— 于是这一格直接数命令原文。
     *
     * 实测(2026-08-06,56 跑 / 258 个 command 节点 / 113 条不重复命令):
     * **认得出写目标的 0 条**,而拆开看 85 条是纯读(grep/rg/cat/wc)、18 条是
     * `bun test`/`tsc` 验收、5 条脚本也全是验收 —— 也就是说这台引擎上的 command leaf
     * **就是拿来读和断言的,它不写**。那个 0 是**正确的零**,不是判据漏认。
     *
     * ⚠ 于是 ⑧.6 推断口径的输入几乎全来自 **agent leaf 的 bash 写**,不来自 command 节点。
     *   想靠收窄 `SHELL_WRITE_BLIND_SPOTS` 抬这个分母,**先看这一格有没有变**。
     */
    commandWrites: { commands: number; distinct: number; withTargets: number };
  };
  /**
   * ⑧.1 **内环的形状**(2026-08-06)—— 「⑧ 那个 0 为什么是 0」的分母。
   *
   * ## 为什么它得单开一段
   *
   * ⑧ 段补上分母之后,判词变成「记了的跑 ≥ N 而**轮转次数**仍 ≈ 0 → 瓶颈是环只转一圈」。
   * 可「轮转次数 = 0」本身**至少压着四件下一步不同的事**:
   *   ① 图里根本没有 conductor 节点 → 判据**不适用**(与检测器好不好无关);
   *   ② 有 conductor 而 `max_rounds` 缺省 1 → 环存在但**结构上**不可能转第二圈;
   *   ③ `max_rounds > 1` 而首轮就收敛 → 环正常工作,这条检测器**确实没有付费对象**;
   *   ④ 进了第二圈却在比较点之前退环(§8.4 熔断 / D-Q blocked / 预算轴)。
   * ② 的下一步是「改缺省或收掉检测器」,③ 是「收掉检测器」的**正面证据**,
   * ④ 则根本不该记在这条检测器头上。判词此前把 ②③ 并成一个括号、①④ 一字未提。
   *
   * **这是 S-19 的同一形状再走一层**:分母有了,而「分母为什么是 0」仍然没有分母。
   *
   * ⚠ ① 靠 `kind` 就分得出,**回溯既有记录也成立**;②③④ 要 `rounds`/`maxRounds` 两位,
   *   只有 2026-08-06 之后的跑才有 → 老行进 `unrecordedNodes`,**不进任何一格**。
   */
  /**
   * ⑬ **跑坏了回得去吗**(D1,2026-08-06)—— 起跑那一刻 git 状态的分布。
   *
   * D-AB 说「范围内写」那一级可以放手,理由是**git 就是 rollback**。而 R2 给的隔离档
   * (独立 worktree + 分支)**默认关着、只挂在 `dag_goal` 一个入口上**,2026-08-06 实测
   * `git branch --list 'omd/run/*'` **0 条 —— 从来没被用过一次**(S-3 那一族,这次有读数)。
   *
   * 于是绝大多数跑落在 `head` 档直接写当前工作树,而在那一档上「git 就是 rollback」
   * **不是恒假的,是有条件的**:条件就是起跑时那棵树干不干净。这一段量的就是那个条件。
   *
   * ⚠ 五态下一步互不相同,**别合并成"有/没有"两格**:
   *   `clean` = 真能整还原 · `dirty-tracked` = **没有回滚对象** · `dirty-untracked` = 半个
   *   (`git clean -fd` 会删掉原有的未跟踪文件)· `not-a-repo` = git 这条路不存在 ·
   *   `unknown` = **查不了,不是干净**。
   * ⚠ `unrecordedRuns`(老行没记)**不进任何分母** —— 它与 `unknown` 也是两件事:
   *   前者是"这条链当时还没接",后者是"接了但那一次查失败了"。
   */
  rollback: {
    recordedRuns: number;
    unrecordedRuns: number;
    byKind: Record<RollbackAnchorKind, number>;
    /** 「起跑时有完整回滚对象」的比例 = `clean / recordedRuns`;分母 0 → null。 */
    cleanRate: number | null;
  };
  /**
   * ⑤.1 **检查者只读吗**(D4 / §7.3,2026-08-06)—— 以及它的机会分母。
   *
   * §7.3 说检查者应当只读。而 D-Q 检测者是**图内节点**:它和被它检查的兄弟共享同一棵
   * worktree,并且 conductor 把它排成 `executor:'agent'` 时它手里**就是有写工具的**。
   * 实测(54 跑):23 个 detector 里 **7 个是 agent**(记了 `writeCounts` 的 4 个),而那 4 个一次都没写 ——
   * 这条纪律今天成立,但成立的方式是**运气不是不变量**。
   *
   * ⚠ **分子与分母来自两个不同的列**,读的时候要知道:
   *   分母(`agentDetectors`)来自**节点面**(`nodes[].detector` + `kind` + `writeCounts`);
   *   分子(`findings`)来自**观察面**(`observations` 里的 `detector-wrote`)。
   *   于是「老行没记 observations」与「老行没记 writeCounts」是两个独立的缺口,各自单列。
   * ⚠ `inproc` 检测者**不进分母** —— 它没有写工具,那是"不可能"不是"没发生"(S-19 那一族)。
   */
  detector_writes: {
    /** 标了 `detector: true` 的节点总数(所有 kind)。 */
    detectors: number;
    /** 其中 `kind === 'agent'` 的 —— **手里真有写工具**,这才是机会分母。 */
    agentDetectors: number;
    /** 其中**记了** `writeCounts` 的(缺席 = 这条链没人报,不算"没写")。 */
    observed: number;
    /** 其中 `writeCounts[0] > 0` 的 —— 受控写工具真动过手。 */
    wroteControlled: number;
    /** 观察面上的 `detector-wrote` 条数(含推断口径;与上一位来自不同的列)。 */
    findings: number;
    /** `wroteControlled / observed`;分母 0 → null(**算不出 ≠ 0%**)。 */
    rate: number | null;
  };
  /**
   * ⑥ **§8.4 熔断的键该不该改** —— 以及它的机会分母(2026-08-06 修正)。
   *
   * ## 此前这一段把结论读反了
   *
   * 熔断的键是「命令 + 逐字相同的失败」,而 conductor 每轮会把同一个断言重写一遍
   * (单引号换双引号)→ 「同一条命令」凑不齐第二次。要不要改键,取决于**改了能多抓到多少**。
   *
   * 旧算法只分两格:`nearMiss`(同输出不同命令)与 `exactRepeat`(同输出同命令)。
   * 可后者对一个**只出现过一次**的指纹同样成立 —— 而熔断按构造要「≥2 次」,
   * 单次失败**两种键都抓不到**。于是 singleton 被算进了"现行键抓得到的那一格"。
   *
   * 实测(2026-08-06,54 跑):指纹 25 种 · singleton **22** · 真有机会 **3** ·
   * near-miss **3** · 真重复 **0**。旧读法给出"现行键覆盖 88% → 够用",
   * 而在真机会分母上现行键**一组都没抓到**。**方向相反,而没有任何一层报错。**
   *
   * ⚠ 三格互斥且穷尽:`singletons + opportunities === fingerprints`,
   *   `nearMiss + exactRepeat === opportunities`。合并任意两格都会重演上面那次误读。
   */
  breaker_key: {
    /** 失败输出指纹种数(**不含空输出那一格**;也**不是**机会分母 —— 那正是旧版拿错的数)。 */
    fingerprints: number;
    /**
     * **空输出**那个桶里有多少条不同命令 —— 它是**反例不是机会**。
     *
     * 留痕按 `sha1(output.trim())` 指纹,于是所有没有输出的失败(`grep -q` 那族)全落进
     * 同一个桶。把它算进 near-miss 等于说"改成更宽的键能多抓到它们",而事实相反:
     * 那正是设计注里警告过的**误熔断** —— 两个不同断言各失败一次会被判成同一条在空转。
     * **这个数越大,「只看输出」那条改法越危险。**
     */
    emptyOutputCommands: number;
    /** 其中只出现过 1 次的 —— 两种键都抓不到,**不是机会**。 */
    singletons: number;
    /** 出现 ≥2 次的指纹 = **熔断的机会分母**。 */
    opportunities: number;
    /** 其中同输出**不同**命令(现行键漏掉的那些)。 */
    nearMiss: number;
    /** 其中同输出**同**命令(现行键真抓得到的那些)。 */
    exactRepeat: number;
    /** near-miss 里跨多个 run 凑出来的 —— §8.4 是环内累计,**不是真熔断机会**。 */
    nearMissCrossRun: number;
    /** near-miss 里落在同一个 run 内的 —— **只有它是真机会**。 */
    nearMissSameRun: number;
    /** `nearMiss / opportunities`;分母 0 → null(**算不出 ≠ 0%**)。 */
    rate: number | null;
    /** 前 3 组 near-miss 的原料(人工核对用:改键之前得先看清漏掉的到底长什么样)。 */
    samples: { outputHash: string; commands: string[]; sameRun: boolean }[];
  };
  loop_shape: {
    /** 图里一个 conductor 节点都没有的跑 —— ⑧ 那条判据在这些跑上**不适用**(可回溯)。 */
    runsWithoutConductor: number;
    /** 至少有一个 conductor 节点的跑(可回溯)。 */
    runsWithConductor: number;
    /** conductor 节点总数(可回溯)。下面四格之和 = 它。 */
    conductorNodes: number;
    /** 其中**没记**这两位的(老行 / conductor 异常退出没跑到 settle)。缺席 ≠ 0。 */
    unrecordedNodes: number;
    /** `maxRounds === 1`:单轮档,**结构上**没有跨轮比较的机会。 */
    singleRound: number;
    /** `maxRounds > 1 && rounds <= 1`:有机会而首轮就收敛。 */
    firstRoundConverged: number;
    /** `rounds >= 2`:真转了第二圈 —— ⑧ 的机会**只可能出自这一格**。 */
    turned: number;
  };
  /**
   * ⑭ 管线税 (2026-08-10): solve 路 goal-contract 图与 goal-execute 图按 run 归并后的两段对照账。
   * 全量口径 (闸的判据不搭展示窗口, 同 g4_sampling 那条纪律)。分母只算**两段都记了 usage** 的 run;
   * verifier 打回三态分列 (列缺 / 记了读不出 / pass:false); 重规划 = 前一条 execute 被 verifier
   * 打回后, 下一次 execute 的 usage 逐字段增量 (任一侧没记 → null, 不编 0)。
   */
  pipeline_tax: {
    solveRuns: number;
    bothMeasuredRuns: number;
    unmeasuredRuns: number;
    /** 段归属词表 ('goal-contract'/'goal-execute') 外的 plan_name —— 直通 merge 改图名会照在这里。 */
    unknownPlans: { plan: string; rows: number }[];
    contractTokens: number;
    totalTokens: number;
    /** 分母 0 → null (算不出 ≠ 0%)。 */
    contractShare: number | null;
    verifUnrecorded: number;
    verifUnparsed: number;
    rejections: number;
    replans: { runId: string; deltas: { conductorIn: number | null; conductorOut: number | null; leavesIn: number | null; leavesOut: number | null; leavesCacheHit: number | null } }[];
  };
  /**
   * ⑮ 座位健康 (2026-08-10): per-node model vs **读数时刻**座位配置 (CLI 经 resolveRoleModel 解析后
   * 注入, readout 不自读 env/config)。偏离 = model ≠ 座位期望; kimi-coding 兜底是 issue #6 复发哨;
   * usage 只在整 run 单模型时聚合 (混合座位不摊账 —— 硬摊 = 编账)。
   * deviations/kimiFallbackEvents 在没给座位参照时是 null (**算不出 ≠ 0**)。
   */
  seat_health: {
    badNodesRows: number;
    noModelNodes: number;
    /** 无座位映射的 kind (command/inproc/research/map…) —— 不编期望不算偏离。 */
    unmappedKinds: Record<string, number>;
    deviations: { runId: string; nodeId: string; kind: string; model: string; expected: string }[] | null;
    kimiFallbackEvents: number | null;
    byModel: { model: string; nodes: number }[];
    usageByModel: { model: string; runs: number; tokens: number }[];
    mixedRuns: number;
    /** 渲染头注要印参照表, 让「偏离」可核对。 */
    seatsRef: Record<string, string>;
  };
  /**
   * ⑯ MCP policy (2026-08-10): 第二库 mcp-calls.db 的 calls 表, 七态分列不合并 (词表 =
   * call-ledger.ts 的 McpCallStatus)。null = **无账** (库或表不在), 不是七格零。
   */
  mcp_policy: {
    byStatus: Record<McpCallStatus, number>;
    /** 词表外字面量 —— schema 漂移, 不发明新桶。 */
    unknownStatus: { status: string; n: number }[];
    byServer: { server: string; byStatus: Record<string, number>; total: number }[];
    total: number;
  } | null;
  /**
   * ⑰ cache 趋势 (2026-08-10): 记录级时序, created_at 升序取**最近** 20 行 —— 方向与 ⑫ 的
   * 展示窗口 (最早 limit 个) 相反, 头注已标, 两处数不可比。leavesIn=0 → rate null (zeroIn 单列,
   * 没跑过 leaf ≠ 0%); usage 没记 → leavesIn/leavesCacheHit null (unmeasured 单列), 不编 0。
   */
  cache_trend: {
    rows: { createdAt: number; runId: string | null; leavesIn: number | null; leavesCacheHit: number | null; rate: number | null }[];
    zeroIn: number;
    unmeasured: number;
  };
  /**
   * ⑱ **可避免性率** (#160 发射片 · D-5): 板上「被人工介入过的完结 run」占「完结 run」的比例。
   *
   * 数据源 = `readBoard(boardRoot)` —— 与 ⑨/⑫ 那个 outcome 分布**不同源**: 那是留痕库
   * (永久), 这里是公告板 (24h 保留期 compact, 见 run-board.ts)。两边的窗口**不同**——
   * 留痕库是全史, 板是窗口内; 这一段量的是**窗口**可避免性率, 头注里如实标。
   *
   * ⚠ **分子 ⊆ 分母** (GWT 5): 介入条目 (intervened) 属于无 terminal 的 runId
   * (在跑的孤儿/还没收尾) → **不进分子**。「在跑的 run」不算「介入过的完结 run」。
   *
   * ⚠ **NULL ≠ 0** (D-5 同款纪律): `boardMissing=true` = **板文件不存在**, 不是零介入 —
   * 两者在输出里**可分辨**。`null` (整段缺席) 仅在**没给 boardRoot** 时发生 (注入夹具)。
   */
  avoidability: {
    /** 板上有 terminal 条目的 distinct runId 数 (= 完结 run 数, 窗口内)。 */
    denominator: number;
    /** 上面那些里, 同时有 intervened 条目的 runId 数 (⊆ denominator)。 */
    numerator: number;
    /** `numerator/denominator`; `denominator=0` → null (算不出 ≠ 0%)。 */
    rate: number | null;
    /** `true` = 板文件缺席 (这条数是 NULL 不是 0, 与「板存在但零介入」分得开)。 */
    boardMissing: boolean;
  } | null;
  /**
   * ⑲ 编排循环 (R-1 第 4 步, 2026-09-03; 设计 docs/plan/2026-09-03-r1-ledger-columns.md §5)。
   * 分母 = `loop` 列非 NULL 的父行 (plan_name goal-orchestrating-loop); 子行 = 同 run_id 且 plan_name 以 `conductor-` 开头
   * (conductor 每派一次一行)。全部三态: 算不出 = null (不是 0); 「因某格缺席不可算」的 run / 节点数单列印出, 不省。
   * ⚠ 设计稿把它编成 ⑱, 但 ⑱ 已是可避免性率 —— 这里顺延成 ⑲, 段名以本文件为准。
   */
  loop_readout: {
    parents: number;
    childRows: number;
    /** 逐子行: 并行宽度 = 各层最大节点数, 关键路径深度 = 层数。原值保留 (读数板印原列表), 三分位空 → null。 */
    width: number[];
    depth: number[];
    widthStats: { min: number; median: number; max: number } | null;
    depthStats: { min: number; median: number; max: number } | null;
    /**
     * 加速比 = Σ 子行节点 durationMs / conductor 节点 durationMs。⚠ 分母用 **conductor 节点墙钟**代父 run 墙钟 —— 父行 `duration_ms`
     * 列是 schema 占位恒 NULL (dag-record.ts INSERT 段), conductor 节点从第一次派发到收尾一直在跑, 它的墙钟就是循环墙钟。
     * 任一侧缺席 → 该 run 进 unmeasurable, 不进 ratios。
     */
    speedup: { ratios: number[]; median: number | null; unmeasurable: number };
    /**
     * `perRun` 判词 2026-09-04 起是 **≤ 2** (D-14 窄复审上线前是 ≤ 1): 全量终审 1 + 窄复审 1。
     * `recheck` 四格来自 `LoopLedger.verifier.recheck`, **'error' 与 'skipped' 分开数** —— 判官坏了
     * 与没跑复审的下一步不同 (前者查判官池, 后者本就不该跑)。老记录 (无此字段) 进 `unknown`。
     */
    verifier: {
      calls: number; perRun: number | null; firstFail: number; reinjected: number;
      recheck: { pass: number; unproven: number; fail: number; error: number; skipped: number; unknown: number };
    };
    /** #205 判据方向性 (1-A 文件放回改动前的代码里跑): greenBefore = 判据量的不是本次目标。 */
    direction: { redBefore: number; greenBefore: number; inconclusive: number; absent: number };
    /**
     * 回灌蒸发 = reinjected ∧ afterReinject 'green' ∧ 回灌后零新派发 (dispatches.length === dispatchesBeforeReinject)。
     * 分母 = reinjected 的父 run (设计 §5 的公式); 回灌了但没记 dispatchesBeforeReinject 的老记录 → unknown 单列, 两边都不进。
     */
    evaporation: { numerator: number; denominator: number; rate: number | null; unknown: number };
    cards: {
      calls: number; ok: number; rejectedSchema: number; help: number; rejectedCompile: number; childRunError: number;
      /** 工具首次直达率 = ok / calls; calls=0 → null。 */
      firstPassRate: number | null;
      byCard: Record<string, number>;
      readOnlyShellBlocked: number;
    };
    dispatches: { total: number; perRun: number | null; briefTrue: number; briefFalse: number; briefNull: number; briefReproRate: number | null };
    /**
     * LLM 调用 (M3 调用/题按 conductor / worker 分解): conductor = 父行 `conductor` 节点 llmCalls; worker = 子行全部节点 llmCalls 之和。
     * 节点 llmCalls 为 null (老 runner / 老行) → 不进和, 计入 unmeasured*; perRun 分母只数量到了的那部分。
     */
    llmCalls: { conductor: number; worker: number; conductorPerRun: number | null; workerPerRun: number | null; unmeasuredConductorRuns: number; unmeasuredWorkerNodes: number };
    /** 尾块缺席率: 子行 agent 节点里 selfReport.self_report === 'missing' / 记了 selfReport 的 agent 节点; 没记的单列。 */
    trailer: { agentNodes: number; missing: number; unrecorded: number; missingRate: number | null };
    /** 尾块 acceptance_ran 与节点 acceptance.ran 都在场且不等的节点数 (父行 + 子行)。 */
    acceptanceRanMismatch: number;
    /** 节点 acceptance.last 为 exited+inconclusive 的次数; bare = 没有 why (整仓 pytest 那种)。 */
    inconclusive: { bare: number; nonBare: number };
    residentPromptChars: { max: number | null; over8000: number; unrecorded: number };
    preActionLlmCalls: { sum: number; over1: number; unrecorded: number };
    /** leaf thinking 档分布 (R-1 第 3 步): agent 节点按通道分两列, 各列按档计数; null (派了没报) 单列。 */
    thinking: { pi: Record<string, number>; sdk: Record<string, number>; unreported: number };
  };
}

/** 单面的样本充分性(`enough=false` 时这一面的比例**不许当结论读**)。 */
export interface FaceSufficiency {
  nodes: number;
  /** 还差多少个节点(已够 → 0)。读数板直接印它,免得靠人心算。 */
  short: number;
  enough: boolean;
}

/**
 * 一面要多少节点才谈得上读「基率」—— **在数据到达之前钉死**(2026-08-05)。
 *
 * 依据是 rule of three:0 检出 / N 节点时,真实基率的 95% 上界 ≈ 3/N。60 → **5%**。
 *
 * 为什么门槛取 5% 而不是 1%:按 ⑧ 段同一套比价(误拦一次掐死一个本可收敛的 run,漏报一次
 * 只赔一两轮),**1% 的基率本来就不值得上硬拦** —— 所以要分辨的是「0% 还是 5%」,不是
 * 「0% 还是 1%」。1% 需要 N≥300,按 flat 面每跑 2~5 个节点算是 60~150 跑,被动攒够不着;
 * 那是拿一个够不着的门槛换一份用不上的精度。
 *
 * ⚠ 这个数**先于数据**写下来才有意义。等数攒起来再定"多少算够" = 事后编判据,
 *   本仓 §五 第 1 条治的就是这个。要改它,改前先说清为什么,别改完再补理由。
 */
export const CLAIM_CHECK_MIN_NODES = 60;

/**
 * ⑧「产物没变」判据的样本门槛 —— **同样在数据到达之前钉死**(2026-08-06)。
 *
 * 与 `CLAIM_CHECK_MIN_NODES` 同数同理由(rule of three:0/60 → 95% 上界 5%;⑧ 段那笔账
 * 「误拦一次掐死一个本可收敛的 run,漏报一次只赔一两轮」与 ⑧.5 逐字相同,所以要分辨的
 * 同样是「0% 还是 5%」)。**同数不是巧合,是同一套比价** —— 但两处刻意各写一个常量:
 * 它们量的是不同的东西,以后其中一个该改时不该顺手拖着另一个。
 *
 * ⚠ 这一个数要**读三个槽**,因为 ⑧ 的 0 可以出自三个完全不同的地方,而它们的下一步相反:
 *   ① `recordedRuns` —— 机会**存不存在**。长期 < 5% 的跑产生过跨轮比较 → 这条判据在生产形状
 *      上够不着(内环 `max_rounds` 缺省 1 / 首轮就收敛),该收掉,不是再等;
 *   ② `transitions`  —— 轮转发生了,但 population 闸吃掉了多少(环里没有产物信号);
 *   ③ `comparable`   —— 真判过多少次。**只有它才是活体基率的分母**。
 * 旧版拿「运行次数」当分母,而运行次数与这三个都不是一回事 —— 那是 ⑧.5 已经付过学费的形状。
 */
export const LOOP_NO_MOVE_MIN_N = 60;

/**
 * ⑧.7 **回溯重建的写竞争**(2026-08-06)—— 拿 checkpoint 把历史上的并发撞车算出来。
 *
 * ## 为什么值得单开
 *
 * ⑧.6 那两档(严格 / 推断)都要等新跑攒够。而 `.omd/continuity/<runId>/<nodeId>.json` 里
 * 一直有 **`createdAt` + `durationMs`**(还原得出执行窗口)与 **`outputPaths`**
 * (= `filesTouched` 相对化到该 run 的根)—— **历史上的重叠/机会/撞车是可以重建的**。
 *
 * ⚠ **它与 ⑧.6 那两档不是同一个仪器,数不许相加**:
 *   · 窗口来源不同:这里是 `结束 - 时长`(整个节点的执行时长),⑧.6 是调度器实时记的;
 *   · 路径基准不同:这里相对**该 run 的根** —— **同一 runId 内可比,跨 run 不可比**;
 *   · 覆盖不同:只覆盖**开了 continuity 的跑**,目录被清掉就没了(与留痕库的寿命不一样长)。
 *
 * ⚠ 判据**一个字都不重写**:窗口配对之后喂给 `detectRuntimeWriteRace` 那同一个函数
 *   (父子守卫、机会分母、撞车判定全在那儿)。两处各算一份必漂,而漂了之后
 *   「回溯说 1 条、实时说 0 条」就没人分得清是引擎变了还是数法变了。
 */
export interface RetroWriteRace {
  /** 扫过的 continuity 目录数。 */
  dirs: number;
  /** 其中有 ≥2 份节点 checkpoint 的(**只有它们可能产生重叠对**)。 */
  dirsUsable: number;
  /** 读到的节点 checkpoint 份数。 */
  checkpoints: number;
  /** 其中报了 `outputPaths` 的份数(没报的那些进不了机会分母)。 */
  checkpointsWithPaths: number;
  /**
   * **单轮跑**那一面 —— 这一面**没有跨轮歧义,数是可信的**。
   *
   * ⚠ 为什么必须与多轮跑分开(2026-08-06,核第一条 finding 时撞到的):
   * `NodeCheckpoint` **不记轮次**,而 checkpoint 按 nodeId **覆写**。于是在多轮跑里,
   * 两份 checkpoint 可能来自**不同的轮**,把它们的窗口配成一对就是**跨轮伪影** ——
   * 而"两个节点在不同轮里各跑一次"根本不是并发。
   * 单轮跑没有这个问题:所有 checkpoint 都来自同一轮。
   */
  clean: { overlaps: number; pairs: number; findings: number; rate: number | null };
  /**
   * **认不出轮次的多轮跑**那一面 —— 数**不可信**(可能是跨轮伪影),单独摆,不许并进上面。
   *
   * ⚠ 2026-08-06 之后的记录里 `NodeCheckpoint.round` 有值,于是**多轮跑也能进可信面** ——
   * 判据从「是不是多轮」改成「**认不认得出轮次**」:两侧都有轮次时不同轮的对被直接排除,
   * 那一跑就没有跨轮伪影可言了。这一格于是会随着老记录被清掉而自然缩小。
   */
  ambiguous: { overlaps: number; pairs: number; findings: number; runs: number };
  /** 两面合计的重叠对数(只用来算"看不见的那部分",**不当基率分母**)。 */
  overlaps: number;
  /** 两面合计的机会对数。 */
  pairs: number;
  /** 两面合计的撞车对数。 */
  findings: number;
  /** 前 3 条撞车的原料(人工核对用;`multiRound` 标出它落在哪一面)。 */
  samples: { runId: string; a: string; b: string; shared: string[]; multiRound: boolean }[];
}

/**
 * ⓪ **今天哪几格能下结论** —— 从契约派生的导航(2026-08-06)。
 *
 * 这块板已经 400+ 行,而一大半是**在等数据**的段:读的人 5 秒内看不出今天哪一格能用。
 * **一份没人读得完的读数板等于没有** —— 加这一段的理由与本仓治的那些静默失效同源。
 *
 * ⚠ **纯函数,只吃 `ReadoutResult`** —— 一行原始数据都不碰。否则就是又造一个 S-21
 *   (数在渲染层、没人闸得着),而这一程刚为那条形状立过条目。
 * ⚠ 它**只做导航,不替任何一段下结论**:每一格具体是「在等」还是「不适用」,
 *   由它自己那一段的判词说了算。
 */
export function summarizeFaces(c: ReadoutResult): { ready: string[]; waiting: string[] } {
  const ready: string[] = [];
  const waiting: string[] = [];
  const need = (n: number, min = LOOP_NO_MOVE_MIN_N) => `${n}/${min}`;

  // ⑧.1 ①: 只看 kind, **可回溯** —— 这一格从第一天就有答案
  const ls = c.loop_shape;
  const lsRuns = ls.runsWithoutConductor + ls.runsWithConductor;
  if (lsRuns > 0) {
    const pct = ((ls.runsWithoutConductor / lsRuns) * 100).toFixed(0);
    ready.push(`⑧.1 ①  图里没有 conductor 的跑 ${ls.runsWithoutConductor}/${lsRuns} (${pct}%) → ⑧ 那条判据在这些跑上**不适用**`);
  }
  // ⑥: 真机会分母 —— 小 n 也已经把方向定了 (旧判词是反的)
  const bk = c.breaker_key;
  if (bk.opportunities > 0) {
    ready.push(`⑥      真机会 ${bk.opportunities} 组 · 现行键抓得到 ${bk.exactRepeat} · 漏掉 ${bk.nearMiss} → **方向已定** (n 小, 别当基率读)`);
  }
  // 判据轴: **非零检出本身就是证据, 不用等大 N** (2026-08-06 补 —— 建 ⓪ 时漏了这一格)。
  //
  // ⚠ 这一格与门槛型的那几个**读法相反**, 而这正是当初漏掉它的原因:
  //   `LOOP_NO_MOVE_MIN_N = 60` 那个门槛管的是**把 0 读成基率**要多少样本 (rule of three);
  //   而「judge 太紧 4 次」是**非零检出** —— 它已经发生了 4 次, 不需要再攒到 60 才算数。
  //   把两种混着用, 一条真实存在的浪费就会被"样本不足"挡在导航之外, 埋在 430 行板子的中段。
  const cc2 = c.criteria_axis; // **全量口径** —— 见该字段的注(窗口那个答的是另一个问题)
  if (cc2.wastedRounds > 0 || cc2.oracleFailed > 0) {
    const n = cc2.recorded;
    const bits: string[] = [];
    // ⚠ **不是"白转了几轮"** (2026-08-06 核代码改的, 此前那句是错的): `acceptance.command`
    //   作为 `freezeCriterion` 传进内环, 而内环**判据绿就直接收敛, judge 的票只记录**
    //   (`executor-dag`: 「冻结判据绿 → 环提前收敛」)。所以这几次**一轮都没白转**。
    //   它真正的含义是**judge 的校准**: judge 与确定性判据分歧, 且方向恒为"更严"。
    //   而它的价值在反面 —— **要是只有 judge 没有判据, 这几次就会一直转到轮数耗尽**。
    if (cc2.wastedRounds > 0) {
      bits.push(
        `**judge 比确定性判据严** ${cc2.wastedRounds}/${n} (判据绿而 judge 说没成) ——` +
          ' 环已按判据收敛, **没白转**; 它量的是 judge 的校准, 也是"判据救了几次"',
      );
    }
    if (cc2.oracleFailed > 0) bits.push(`**judge 太松** ${cc2.oracleFailed}/${n} (judge 说成了而判据没过)`);
    ready.push(`判据轴  ${bits.join(' · ')} → **非零检出, 不用等大 N**`);
  }
  // ⑬: 有数就报 —— 「有没有退路」不需要攒到 60 才有意义, 它每一跑都是一次真判断
  if (c.rollback.recordedRuns > 0) {
    const clean = c.rollback.byKind.clean;
    ready.push(
      `⑬      起跑时有完整回滚对象 ${clean}/${c.rollback.recordedRuns}` +
        `${clean === 0 ? ' → **一次都没有**: D-AB 那句「git 就是 rollback」在这些跑上不成立' : ''}`,
    );
  }

  if (!c.artifact_move.sufficiency.comparable.enough) waiting.push(`⑧      可比较的跨轮次数 ${need(c.artifact_move.comparable)}`);
  if (!c.claim_check.sufficiency.conductor.enough || !c.claim_check.sufficiency.flat.enough) {
    waiting.push(`⑧.5    conductor ${need(c.claim_check.conductor.nodes, CLAIM_CHECK_MIN_NODES)} · flat ${need(c.claim_check.flat.nodes, CLAIM_CHECK_MIN_NODES)}`);
  }
  if (!c.write_race.sufficiency.pairs.enough) waiting.push(`⑧.6    严格机会对 ${need(c.write_race.pairs)} (推断口径 ${c.write_race.pairsInferred ?? '没记'})`);
  if (c.detector_writes.observed < LOOP_NO_MOVE_MIN_N) {
    waiting.push(`⑤.1    记了 writeCounts 的 agent 检测者 ${need(c.detector_writes.observed)} (其中写过 ${c.detector_writes.wroteControlled})`);
  }
  if (c.rollback.recordedRuns === 0) waiting.push('⑬      起跑时的 git 状态: **一跑都没记**(改过引擎要重连 MCP, 否则 daemon 跑旧代码)');
  if (ls.conductorNodes > 0 && ls.conductorNodes === ls.unrecordedNodes) waiting.push(`⑧.1 ②③ conductor 的 rounds/maxRounds: ${ls.conductorNodes} 个**都没记**`);
  return { ready, waiting };
}

/**
 * 内环 journal 的**轮数分布**(2026-08-06)—— ⑧.1 那四格里**可回溯**的第二格。
 *
 * ## 为什么它值得单独抽出来
 *
 * ⑧.1 首版把 ②③④ 整段标成「要跑一次新的才有数」,而那是**错的**:
 * `.omd/continuity/<runId>/_loop-*.json` 里的 `completedRounds` 一直就记着内环跑了几轮,
 * 读数板甚至**早就在读它**(算 `roundsTotal`)—— 只是从没接到「环到底转没转第二圈」这个问题上。
 * 那是 S-21 的同一形状(数在渲染层、没接到它能回答的问题上),而这一次**是我自己刚立完
 * 「可回溯的那一格要先算」这条纪律之后又犯的**(交接 32 §五 第 2 条)。
 *
 * ## 两格的证据强度不同,别合并
 *
 * · `turned`(`completedRounds ≥ 2`)= **内环真转了第二圈**,无歧义;
 * · `oneRound`(`= 1`)**压着三种情况分不开**:`max_rounds=1` 撞上熔断/blocked/预算而写了
 *   journal · `max_rounds=1` 配了 `judge_final`/冻结判据跑完一轮 · `max_rounds>1` 首轮就收敛。
 *   拆开它要的正是账本新加的 `maxRounds` 那一位。
 *
 * ⚠ **`turned` ≠ 跨轮比较真发生过**:退出路径决定它有没有走到比较点
 *   (`success` 与 `blocked` 的 return 在比较之前;`not-converged` / `budget-exhausted` 之后)。
 *   所以这里**只记原料**(按 `stop.kind` 分组),判词在渲染层解释 —— 那一层的知识绑在具体
 *   代码路径上,存进派生值会在退出路径改动时静默过期。
 */
export interface LoopRoundSummary {
  journals: number;
  turned: number;
  oneRound: number;
  /** `turned` 按 `stop.kind` 分组;缺席的 stop 归 `'(没记)'`(早于 N6 的记录)。 */
  turnedByStop: Record<string, number>;
}

/**
 * 一批 run 的节点窗口 → 回溯写竞争读数(**纯函数**,IO 在调用方)。
 *
 * ⚠ 输入**必须按 runId 分好组**:`outputPaths` 相对该 run 的根,跨 run 的同名路径不是同一个
 *   文件(见 {@link RetroWriteRace} 那段)。这个约束在类型上表达不出来,所以写在这里 ——
 *   把两个 run 的节点混进一个数组会凭空造出撞车。
 */
export function reconstructWriteRace(
  runs: readonly { runId: string; nodes: readonly NodeWindow[]; multiRound?: boolean; roundsKnown?: boolean }[],
  stats: { dirs: number; checkpoints: number; checkpointsWithPaths: number },
): RetroWriteRace {
  const clean = { overlaps: 0, pairs: 0, findings: 0 };
  const ambiguous = { overlaps: 0, pairs: 0, findings: 0, runs: 0 };
  let dirsUsable = 0;
  const samples: RetroWriteRace['samples'] = [];
  for (const r of runs) {
    if (r.nodes.length < 2) continue;
    dirsUsable++;
    // 判据是「**认不认得出轮次**」不是「是不是多轮」: 多轮 + 每个节点都有 round →
    // 不同轮的对已在 overlapPairsFromWindows 里排掉, 那一跑就没有跨轮伪影可言。
    const risky = r.multiRound === true && r.roundsKnown !== true;
    const acc = risky ? ambiguous : clean;
    if (risky) ambiguous.runs++;
    // **判据一个字都不重写**: 配对之后喂给实时那条用的同一个函数 (父子守卫也在那儿)。
    const probe = detectRuntimeWriteRace(overlapPairsFromWindows(r.nodes));
    acc.overlaps += probe.overlaps;
    acc.pairs += probe.pairs;
    acc.findings += probe.findings;
    if (probe.findings > 0 && samples.length < 3) {
      // 从观察条目里取回是哪两个节点 —— 判词由那边生成, 这里只拆节点名与共享路径。
      const o = probe.observations[0]!;
      const byId = new Map(r.nodes.map((n) => [n.id, new Set(n.paths)]));
      const [a, b] = o.nodes as [string, string];
      const shared = [...(byId.get(a) ?? [])].filter((p) => byId.get(b)?.has(p)).sort();
      samples.push({ runId: r.runId, a, b, shared: shared.slice(0, 3), multiRound: r.multiRound === true });
    }
  }
  return {
    dirs: stats.dirs,
    dirsUsable,
    checkpoints: stats.checkpoints,
    checkpointsWithPaths: stats.checkpointsWithPaths,
    clean: { ...clean, rate: clean.pairs > 0 ? clean.findings / clean.pairs : null },
    ambiguous,
    overlaps: clean.overlaps + ambiguous.overlaps,
    pairs: clean.pairs + ambiguous.pairs,
    findings: clean.findings + ambiguous.findings,
    samples,
  };
}

/**
 * 一份 checkpoint 文件 → 它是**第几轮**的(2026-08-06)。
 *
 * 两个来源, 缺一不可:
 *   · 文件名 `<nodeId>.__r<K>.json` —— 覆写前归档的**旧轮**(这条**回溯也成立**, 老记录也有);
 *   · 字段 `round` —— 2026-08-06 起写的**最新那一轮**(纯 `<nodeId>.json` 的文件名说不出轮次)。
 * 两者都没有 = 认不出(顶层节点 / 老的最新份)→ 调用方据此判这一跑进不进可信面。
 */
function roundOf(file: string, field: number | undefined): number | undefined {
  const m = /\.__r(\d+)\.json$/.exec(file);
  if (m) return Number(m[1]);
  return typeof field === 'number' ? field : undefined;
}

/** 纯函数(IO 在调用方)—— 见 {@link LoopRoundSummary}。 */
export function summarizeLoopRounds(
  js: readonly { completedRounds?: number; stop?: { kind: string } }[],
): LoopRoundSummary {
  const turnedByStop: Record<string, number> = {};
  let turned = 0;
  let oneRound = 0;
  for (const j of js) {
    const r = j.completedRounds ?? 0;
    if (r >= 2) {
      turned++;
      const k = j.stop?.kind ?? '(没记)';
      turnedByStop[k] = (turnedByStop[k] ?? 0) + 1;
    } else if (r === 1) {
      oneRound++;
    }
    // r <= 0 = 没记 / 坏值: 一格都不进 (缺席 ≠ 0 轮)
  }
  return { journals: js.length, turned, oneRound, turnedByStop };
}

/**
 * 单面充分性判定(纯函数 —— 读数板与闸共用同一处,两处各算一份必漂)。
 *
 * `min` 留了参数是因为 ⑧ 与 ⑧.5 两段共用这一份算法而门槛各有各的常量;**别在调用处写字面量**,
 * 传常量 —— 门槛的理由写在常量头上,字面量把理由甩掉了。
 */
export function faceSufficiency(nodes: number, min: number = CLAIM_CHECK_MIN_NODES): FaceSufficiency {
  return { nodes, short: Math.max(0, min - nodes), enough: nodes >= min };
}

interface ReadoutRow {
  id: string;
  created_at: number;
  run_id: string | null;
  entry: string | null;
  levels: string;
  nodes: string;
  usage: string;
  outcome: string | null;
  reused: number | null;
  criteria: string | null;
  claim_check: string | null;
  artifact_move: string | null;
  write_race: string | null;
  rollback: string | null;
  observations: string | null;
  acceptance_probe: string | null;
  spec_write: string | null;
  plan_name: string | null;
  verification: string | null;
  /** R-1 loop 列原始 JSON (父行才有; 老库无列 → NULL AS loop)。 */
  loop: string | null;
}

interface ParsedRow {
  id: string;
  createdAt: number;
  runId: string | null;
  planName: string | null;
  /** verification 原始 JSON (execute 段 verifier 打回判据; 老行 NULL = 没记)。 */
  verification: string | null;
  entry: string | null;
  levelIds: string[];
  /** R-1 ⑲: 分层原样 (宽度 = 每层长度, 深度 = 层数); levelIds 是它的扁平版, 两者同源。 */
  levels: string[][];
  nodes: DagRunNode[];
  usage: Usage | null;
  outcome: string | null;
  reused: number | null;
  criteria: { judge: boolean; oracle: boolean } | null;
  acceptanceProbe: AcceptanceProbe | null;
  specWrite: SpecWrite | null;
  /** R-1: 编排循环父行的读数; null = 没走循环 / 子行 / 老记录 / 坏 JSON。 */
  loop: LoopLedger | null;
}

/** 词表校验 (老库可能有词表之外的字面量 → 归 unclassified, 同 ⑦ 段的三态纪律)。 */
const OUTCOME_KINDS = new Set<string>(RUN_OUTCOME_ORDER);

function zeroOutcomeDistribution(): ReadoutResult['outcome_distribution'] {
  const d = Object.fromEntries(RUN_OUTCOME_ORDER.map((k) => [k, 0])) as ReadoutResult['outcome_distribution'];
  d['未记'] = 0;
  d.total = 0;
  return d;
}

function zeroTwoGridRisk(): ReadoutResult['criteria_grid']['two_grid_risk'] {
  return (Object.keys(RISK_TIER_ORDER) as CommandRiskTier[])
    .sort((a, b) => RISK_TIER_ORDER[a] - RISK_TIER_ORDER[b])
    .map((risk_level) => ({ risk_level, executed: 0, not_executed: 0 }));
}

/** 空世界 (表不存在或零记录): 合法, 各分布全零, 不是错误。 */
function emptyWorld(meta: ReadoutResult['meta'], seats?: Record<string, string>, mcpPolicy?: ReadoutResult['mcp_policy'], avoidability?: ReadoutResult['avoidability']): ReadoutResult {
  return {
    meta,
    runs: [],
    outcome_distribution: zeroOutcomeDistribution(),
    entry_distribution: [],
    // 空世界: 没有跑也没有图 —— 五个"不知道"全是 null, **不编 0**(0 次踢回 ≠ 没量过)。
    attention_axis: { blocked_runs: 0, total_runs: 0, handback_rate: null, pending_tickets: null, decided_tickets: null, rejected_tickets: null, wasted_review_share: null },
    // 空世界: 五桶全 0, 三个比率全 null —— **算不出 ≠ 0%**(同 tokens_per_success 那条纪律)。
    spend_discipline: computeSpendDiscipline([]),
    cost_per_success: [],
    criteria_grid: { four_grid: { executed_success: 0, executed_failure: 0, reused_success: 0, 未记: 0 }, two_grid_risk: zeroTwoGridRisk() },
    criteria_axis: { agree: 0, oracleFailed: 0, wastedRounds: 0, agreeFail: 0, recorded: 0, unrecorded: 0 },
    criteria_consistency: { agree: 0, oracleFailed: 0, wastedRounds: 0, agreeFail: 0, unrecorded: 0, recorded: 0 },
    g4_sampling: { denominator: 0, passedBoth: 0, vacuityOnly: 0, demoted: 0, skipped: 0, exploratory: 0 },
    spec_write_sampling: { denominator: 0, wrote: 0, missing: 0, notNeeded: 0, contractRuns: 0, missRate: null },
    suggestion_acceptance: null,
    reuse_rate: { reused_nodes: 0, total_nodes: 0, rate: null, unknownRuns: 0 },
    claim_check: {
      recordedRuns: 0, unrecordedRuns: 0,
      conductor: { rounds: 0, nodes: 0, findings: 0, rate: null },
      flat: { nodes: 0, findings: 0, rate: null },
      samples: [],
      sufficiency: { conductor: faceSufficiency(0), flat: faceSufficiency(0) },
    },
    // 空世界: 三个槽全 0, rate 记 null = **算不出**(0 次比较不等于 0% 基率)。
    artifact_move: {
      recordedRuns: 0, unrecordedRuns: 0, transitions: 0, unobserved: 0, comparable: 0, findings: 0, rate: null,
      sufficiency: {
        runs: faceSufficiency(0, LOOP_NO_MOVE_MIN_N),
        transitions: faceSufficiency(0, LOOP_NO_MOVE_MIN_N),
        comparable: faceSufficiency(0, LOOP_NO_MOVE_MIN_N),
      },
    },
    // 同上: 没并发过 ≠ 并发过但没撞上, 两个 0 分开印。
    write_race: {
      recordedRuns: 0, unrecordedRuns: 0, overlaps: 0, pairs: 0, findings: 0, rate: null,
      // 空世界: 推断口径记 null = **没记**(一跑都没有),与"记了而推断口径为 0"分得开。
      pairsInferred: null, findingsInferred: null, rateInferred: null,
      commandWrites: { commands: 0, distinct: 0, withTargets: 0 },
      sufficiency: {
        overlaps: faceSufficiency(0, LOOP_NO_MOVE_MIN_N),
        pairs: faceSufficiency(0, LOOP_NO_MOVE_MIN_N),
        pairsInferred: faceSufficiency(0, LOOP_NO_MOVE_MIN_N),
      },
    },
    // 空世界: 五格全 0, cleanRate=null (**算不出 ≠ 0%**)。
    rollback: {
      recordedRuns: 0, unrecordedRuns: 0, cleanRate: null,
      byKind: { clean: 0, 'dirty-tracked': 0, 'dirty-untracked': 0, 'not-a-repo': 0, unknown: 0 },
    },
    // 空世界: 分母 0 → rate=null (**算不出 ≠ 0%**)。
    detector_writes: { detectors: 0, agentDetectors: 0, observed: 0, wroteControlled: 0, findings: 0, rate: null },
    // 空世界: 三格全 0, rate=null (**算不出 ≠ 0%**)。
    breaker_key: {
      fingerprints: 0, singletons: 0, opportunities: 0, nearMiss: 0, exactRepeat: 0,
      nearMissCrossRun: 0, nearMissSameRun: 0, rate: null, samples: [], emptyOutputCommands: 0,
    },
    // 空世界: 七格全 0。⚠ 别把 `runsWithoutConductor: 0` 读成"每张图都有 conductor" ——
    // 空库里它与"一跑都没有"是同一个 0, 那是 meta.limit 那一层的事, 不是这一段的。
    loop_shape: {
      runsWithoutConductor: 0, runsWithConductor: 0, conductorNodes: 0,
      unrecordedNodes: 0, singleRound: 0, firstRoundConverged: 0, turned: 0,
    },
    // 空世界: 闸分母全 0, ledgerGap 记 null = **不知道** (空留痕库不代表没跑过, 只代表这里没有)。
    gate_denominators: { g3LiveRuns: 0, g4Samples: 0, ledgerGap: null },
    // ⑭-⑰ 四新段的空态: 全零 + 比率 null; 没给座位参照 → 偏离/兜底哨 null (算不出 ≠ 0);
    // mcp 无账 (库/表不在) → null 不是七格零; cache 零行是空序列不是 0 命中。
    pipeline_tax: { solveRuns: 0, bothMeasuredRuns: 0, unmeasuredRuns: 0, unknownPlans: [], contractTokens: 0, totalTokens: 0, contractShare: null, verifUnrecorded: 0, verifUnparsed: 0, rejections: 0, replans: [] },
    seat_health: {
      badNodesRows: 0, noModelNodes: 0, unmappedKinds: {},
      deviations: seats === undefined ? null : [], kimiFallbackEvents: seats === undefined ? null : 0,
      byModel: [], usageByModel: [], mixedRuns: 0, seatsRef: seats ?? {},
    },
    mcp_policy: mcpPolicy ?? null,
    cache_trend: { rows: [], zeroIn: 0, unmeasured: 0 },
    // ⑱ 空世界: 没给 boardRoot → null; 给了但板缺席 → {0,0,null,true} (在 computeAvoidability 里算好, 这里只搬运)。
    avoidability: avoidability ?? null,
    loop_readout: emptyLoopReadout(),
  };
}

interface NodeInfo {
  executed: boolean;
  everDone: boolean;
  firstExecAt: number;
  command: string | null;
}
const freshNodeInfo = (): NodeInfo => ({ executed: false, everDone: false, firstExecAt: Number.POSITIVE_INFINITY, command: null });
/** criteria 两位布尔按形状校验 (同 usage 的五字段 every 校验): 缺位/坏值 → null —— 归 unrecorded,
 * 不编 false/false, 坏行也不炸整块板 (审查 F2/F5)。 */
function parseCriteria(raw: string | null): { judge: boolean; oracle: boolean } | null {
  if (raw === null) return null;
  try {
    const c = JSON.parse(raw) as Partial<{ judge: boolean; oracle: boolean }>;
    if (c && typeof c === 'object' && typeof c.judge === 'boolean' && typeof c.oracle === 'boolean') {
      return { judge: c.judge, oracle: c.oracle };
    }
  } catch {
    /* 解析失败 = 没记 */
  }
  return null;
}


/** spec_write 只认 `SpecWrite` 的确切形状 (`isSpecWrite`): 解析失败 / JSON null / 词表外 kind
 * → null (= **没记**, 不是「没写入磁盘」—— 把这两件事混为一谈正是 #209 要修的)。 */
function parseSpecWrite(raw: string | null): SpecWrite | null {
  if (!raw) return null;
  try {
    const p: unknown = JSON.parse(raw);
    return isSpecWrite(p) ? p : null;
  } catch {
    return null;
  }
}

/** acceptance_probe 只认五条终局的**确切形状** (见 src/harness/goal/acceptance.ts 的 AcceptanceProbe):
 * 解析失败 / JSON null / 词表外 kind / 多余键 / why 非字符串 → null (= 没记, 不编桶, 不炸整块板)。
 * 同 dag-record 的读取纪律: 坏值不是 'unknown', 也不是某个新桶。 */
function parseAcceptanceProbe(raw: string | null): AcceptanceProbe | null {
  if (raw === null) return null;
  let p: unknown;
  try {
    p = JSON.parse(raw);
  } catch {
    return null; // 解析失败 = 没记
  }
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const keys = Object.keys(o);
  switch (o.kind) {
    case 'passed-both':
      return keys.length === 1 ? { kind: 'passed-both' } : null;
    case 'exploratory':
      return keys.length === 1 ? { kind: 'exploratory' } : null;
    case 'vacuity-only':
      // why 缺席合法 (探针没原话); 在就必须是字符串, 不许是 null。
      if (keys.length === 1) return { kind: 'vacuity-only' };
      return keys.length === 2 && typeof o.why === 'string' ? { kind: 'vacuity-only', why: o.why } : null;
    case 'demoted':
      return keys.length === 2 && typeof o.why === 'string' ? { kind: 'demoted', why: o.why } : null;
    case 'skipped':
      return keys.length === 2 && typeof o.why === 'string' ? { kind: 'skipped', why: o.why } : null;
    default:
      return null; // 词表外的 kind = 没记 (schema 漂移, 不发明新桶)
  }
}

/**
 * 读数板**唯一实现** (纯函数)。只读: 只 SELECT, 不建表、不迁移、不写 pragma —— 注入的 db
 * 可以是留痕器正活着的连接 (测试夹具), 读后行数与 schema 原样。CLI 打开真库用
 * `{ readonly: true }` + query_only (见 main)。
 */
/**
 * 「跑了但没记上」—— 在 run 注册表 (`runs.db`) 里有、而留痕库 (`dag-runs.db`) 里没有的条数。
 *
 * S-12 的写穿失败就长这样: 那次跑烧了钱、交付了正确产物, 却在留痕库里**零行** ——
 * 于是它在读数板上**和"没跑"长得一模一样**, 而两者对 G3 的含义完全不同
 * (一个是"还差几次", 一个是"量具漏了几次")。
 *
 * ⚠ 全程 fail-open 且**不编 0**: 注册表不在 / 打不开 / 表结构不认 → 返回 `null` = **不知道**。
 * 返回 0 会把"没查成"说成"没有", 那正是本仓 S-12 那条纪律禁止的。
 */
function countLedgerGap(
  dagDbPath: string | null,
  knownRunIds: Set<string>,
): { total: number; done: number } | null {
  if (!dagDbPath || dagDbPath === '(injected)') return null; // 注入夹具没有盘上的兄弟库
  try {
    const regPath = join(dirname(dagDbPath), 'runs.db');
    if (!existsSync(regPath)) return null;
    const reg = new Database(regPath, { readonly: true });
    try {
      const rows = reg.query('SELECT run_id, status FROM omd_runs').all() as { run_id: string; status: string }[];
      const missing = rows.filter((r) => r.run_id && !knownRunIds.has(r.run_id));
      return { total: missing.length, done: missing.filter((r) => r.status === 'done').length };
    } finally {
      try { reg.close(); } catch { /* 关不上不值得抛 */ }
    }
  } catch {
    return null; // 表不在 / 库坏 / 权限 —— 一律"不知道"
  }
}

/** entry 词表归一 (t7): 旧词折新词, 表外原样, NULL 原样 (「没记」≠ 任何入口)。 */
function normalizeEntry(e: string | null): string | null {
  return e === null ? null : (TOOL_RENAMES[e] ?? e);
}

/** S-1 片d: 扫图聚合建议处置台账 (纯读; 图目录缺失/空 → null)。 */
export function aggregateSuggestionAcceptance(mapsCwd: string): ReadoutResult['suggestion_acceptance'] {
  const dir = `${mapsCwd}/docs/plan/pathfinder`;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  const acc = { decided: 0, accepted: 0, edited: 0, rejected: 0, deduped: 0, pending: 0, rate: null as number | null, dedupe_rate: null as number | null };
  let any = false;
  for (const f of files) {
    let parsed;
    try {
      parsed = parseMapMarkdown(readFileSync(`${dir}/${f}`, 'utf8'));
    } catch {
      continue; // 单图损坏不拖垮读数板 (与账本行解析同款容错)
    }
    // t3: pending = 图上仍待确认的 suggested 票 (有存量也算有建议史)。
    const pendingHere = parsed.tickets.filter((t) => t.status === 'suggested').length;
    if (pendingHere > 0) any = true;
    acc.pending += pendingHere;
    for (const e of parsed.suggestionsLog ?? []) {
      any = true;
      if (e.outcome === 'deduped' || e.outcome === 'deduped-semantic') acc.deduped++;
      else {
        acc.decided++;
        if (e.outcome === 'accepted') acc.accepted++;
        else if (e.outcome === 'edited') acc.edited++;
        else acc.rejected++;
      }
    }
  }
  if (!any) return null;
  acc.rate = acc.decided > 0 ? (acc.accepted + acc.edited) / acc.decided : null;
  const denom = acc.deduped + acc.decided + acc.pending;
  acc.dedupe_rate = denom > 0 ? acc.deduped / denom : null;
  return acc;
}
/**
 * ⑯ 第二库 (mcp-calls.db) 的七态分布。**纯函数**: 库/表不在 → null (「无账」, 不是七格零)。
 * 七态词表 = call-ledger.ts 的 McpCallStatus, 分列不合并; 词表外字面量 → unknownStatus 单列
 * (schema 漂移, 不发明新桶, 不并进 error)。server NULL → `(没解析到)` (= unknown-tool 那一族)。
 */
function computeMcpPolicy(mcpDb: Database | undefined): ReadoutResult['mcp_policy'] {
  if (!mcpDb) return null;
  let hasCalls = false;
  try {
    hasCalls = mcpDb.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'calls'`).get() != null;
  } catch {
    return null; // 表查不出 = 读不到, 归无账 (读不到 ≠ 零行)
  }
  if (!hasCalls) return null;
  const MCP_STATUSES: readonly McpCallStatus[] = ['ok', 'error', 'rejected-unfetched', 'rejected-args', 'rejected-policy', 'unknown-tool', 'connect-error'];
  const byStatus = Object.fromEntries(MCP_STATUSES.map((s) => [s, 0])) as Record<McpCallStatus, number>;
  const unknownStatus = new Map<string, number>();
  for (const row of mcpDb.query(`SELECT status, COUNT(*) AS n FROM calls GROUP BY status`).all() as { status: string | null; n: number }[]) {
    if (row.status !== null && row.status in byStatus) byStatus[row.status as McpCallStatus] = row.n;
    else unknownStatus.set(row.status ?? '(null)', (unknownStatus.get(row.status ?? '(null)') ?? 0) + row.n);
  }
  const byServerMap = new Map<string, Record<string, number>>();
  for (const row of mcpDb.query(`SELECT COALESCE(server, '(没解析到)') AS srv, status, COUNT(*) AS n FROM calls GROUP BY srv, status`).all() as { srv: string; status: string | null; n: number }[]) {
    const m = byServerMap.get(row.srv) ?? {};
    const k = row.status ?? '(null)';
    m[k] = (m[k] ?? 0) + row.n;
    byServerMap.set(row.srv, m);
  }
  const byServer = [...byServerMap.entries()]
    .map(([server, st]) => ({ server, byStatus: st, total: Object.values(st).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || a.server.localeCompare(b.server));
  return { byStatus, unknownStatus: [...unknownStatus.entries()].map(([status, n]) => ({ status, n })), byServer, total: byServer.reduce((a, b) => a + b.total, 0) };
}


/**
 * ⑱ 可避免性率 (D-5): 「窗口内被人工介入过的完结 run」/「完结 run」 = 分子/分母。
 * 数据源 = `readBoard(boardRoot)` —— 与 ⑨/⑫ outcome 分布**不同源** (留痕库永久, 板 24h compact)。
 *
 * 三态 (NULL ≠ 0 纪律, 同 ⑱ 头注):
 *   - `null`                : 没给 boardRoot (注入夹具), 整段缺席;
 *   - `{0,0,null,true}`     : 给了 boardRoot 但板文件不存在 (与「零介入」分得开);
 *   - 其它 `{n,m,r,false}`  : 板存在, 算出来 (含 numerator=0, denominator>0)。
 *
 * 分子 ⊆ 分母 (GWT 5): intervened 属于无 terminal 的 runId → 不进分子, 由 `terminal` 集合守门。
 */
function computeAvoidability(boardRoot: string | null): ReadoutResult['avoidability'] {
  if (boardRoot === null) return null;
  const path = join(boardRoot, '.omd', 'run-board.jsonl');
  if (!existsSync(path)) return { denominator: 0, numerator: 0, rate: null, boardMissing: true };
  const entries = readBoard(boardRoot);
  const terminal = new Set<string>();
  const intervened = new Set<string>();
  for (const e of entries) {
    if (e.event === 'terminal') terminal.add(e.runId);
    else if (e.event === 'intervened') intervened.add(e.runId);
  }
  let numerator = 0;
  for (const id of terminal) if (intervened.has(id)) numerator++;
  const denominator = terminal.size;
  return {
    denominator,
    numerator,
    rate: denominator > 0 ? numerator / denominator : null,
    boardMissing: false,
  };
}


// ── ⑲ 编排循环 (R-1 第 4 步) ─────────────────────────────────────────────────────────
function parseLoop(raw: string | null): LoopLedger | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as LoopLedger | null;
    return v && typeof v === 'object' && v.path === 'orchestrating-loop' ? v : null;
  } catch {
    return null; // 坏 JSON = 没记 (同 dag-record.loopOf 的读法)
  }
}

function loopStats(xs: number[]): { min: number; median: number; max: number } | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return { min: s[0]!, median, max: s[s.length - 1]! };
}

function emptyLoopReadout(): ReadoutResult['loop_readout'] {
  return {
    parents: 0, childRows: 0, width: [], depth: [], widthStats: null, depthStats: null,
    speedup: { ratios: [], median: null, unmeasurable: 0 },
    verifier: { calls: 0, perRun: null, firstFail: 0, reinjected: 0, recheck: { pass: 0, unproven: 0, fail: 0, error: 0, skipped: 0, unknown: 0 } },
    direction: { redBefore: 0, greenBefore: 0, inconclusive: 0, absent: 0 },
    evaporation: { numerator: 0, denominator: 0, rate: null, unknown: 0 },
    cards: { calls: 0, ok: 0, rejectedSchema: 0, help: 0, rejectedCompile: 0, childRunError: 0, firstPassRate: null, byCard: {}, readOnlyShellBlocked: 0 },
    dispatches: { total: 0, perRun: null, briefTrue: 0, briefFalse: 0, briefNull: 0, briefReproRate: null },
    llmCalls: { conductor: 0, worker: 0, conductorPerRun: null, workerPerRun: null, unmeasuredConductorRuns: 0, unmeasuredWorkerNodes: 0 },
    trailer: { agentNodes: 0, missing: 0, unrecorded: 0, missingRate: null },
    acceptanceRanMismatch: 0,
    inconclusive: { bare: 0, nonBare: 0 },
    residentPromptChars: { max: null, over8000: 0, unrecorded: 0 },
    preActionLlmCalls: { sum: 0, over1: 0, unrecorded: 0 },
    thinking: { pi: {}, sdk: {}, unreported: 0 },
  };
}

/** 父行 = loop 非 NULL; 子行 = 同 run_id 且 plan_name 以 `conductor-` 开头。父行没 run_id 的 (不该发生) 只算自己, 子行归不到它。 */
function computeLoopReadout(parsed: ParsedRow[]): ReadoutResult['loop_readout'] {
  const out = emptyLoopReadout();
  const parents = parsed.filter((r) => r.loop !== null);
  if (parents.length === 0) return out;
  out.parents = parents.length;
  const childrenByRun = new Map<string, ParsedRow[]>();
  for (const r of parsed) {
    if (r.runId === null || r.loop !== null || !(r.planName ?? '').startsWith('conductor-')) continue;
    const g = childrenByRun.get(r.runId);
    if (g) g.push(r);
    else childrenByRun.set(r.runId, [r]);
  }
  const nodeAcc = (n: DagRunNode): void => {
    // 尾块 / 验收对账 / inconclusive: 节点级三态原样数, 父行 conductor 节点也算 (它也是 agent 叶)。
    if (n.kind === 'agent') {
      // thinking 档 (R-1 第 3 步): 缺席 (老行) 与 null (派了没报) 都进 unreported —— 都是"这一格没值", 读侧不猜档。
      if (n.thinking && (n.thinking.channel === 'pi' || n.thinking.channel === 'sdk')) {
        const col = out.thinking[n.thinking.channel];
        col[n.thinking.level] = (col[n.thinking.level] ?? 0) + 1;
      } else out.thinking.unreported++;
      if (n.selfReport === undefined) out.trailer.unrecorded++;
      else {
        out.trailer.agentNodes++;
        if (n.selfReport?.self_report === 'missing') out.trailer.missing++;
      }
    }
    const sr = n.selfReport as { acceptance_ran?: unknown } | null | undefined;
    if (sr && typeof sr.acceptance_ran === 'boolean' && n.acceptance && typeof n.acceptance.ran === 'boolean' && sr.acceptance_ran !== n.acceptance.ran) {
      out.acceptanceRanMismatch++;
    }
    const last = n.acceptance?.last;
    if (last && last.kind === 'exited' && last.verdict === 'inconclusive') {
      if (last.why) out.inconclusive.nonBare++;
      else out.inconclusive.bare++;
    }
  };
  let conductorRunsMeasured = 0;
  let workerNodesMeasured = 0;
  for (const p of parents) {
    const loop = p.loop!;
    const children = p.runId === null ? [] : (childrenByRun.get(p.runId) ?? []);
    out.childRows += children.length;
    // verifier / 回灌
    out.verifier.calls += loop.verifier.calls;
    if (loop.verifier.firstVerdict === 'fail') out.verifier.firstFail++;
    // 老记录没有 recheck 字段 → 'unknown', **不并进 'skipped'**: 「这条 run 跑在窄复审上线前」
    // 与「跑了但没触发复审」是两件事 (§静默坑 1)。
    // #205 方向性探针 (2026-09-04): 'green-before' = 判据在改动前就绿 ⇒ 它量的不是本次目标。
    // 'inconclusive' 与缺席分开数 —— 跑了没量到 ≠ 压根没跑 (§静默坑 1)。
    const cd = loop.criterionDirection;
    if (cd === undefined) out.direction.absent++;
    else out.direction[cd === 'red-before' ? 'redBefore' : cd === 'green-before' ? 'greenBefore' : 'inconclusive']++;
    const rc = loop.verifier.recheck;
    if (rc === undefined) out.verifier.recheck.unknown++;
    else out.verifier.recheck[rc]++;
    if (loop.verifier.reinjected) {
      out.verifier.reinjected++;
      if (loop.dispatchesBeforeReinject === undefined) out.evaporation.unknown++;
      else {
        out.evaporation.denominator++;
        if (loop.verifier.afterReinject === 'green' && loop.dispatches.length === loop.dispatchesBeforeReinject) out.evaporation.numerator++;
      }
    }
    // 卡
    out.cards.calls += loop.cards.calls;
    out.cards.ok += loop.cards.ok;
    out.cards.rejectedSchema += loop.cards.rejectedSchema;
    out.cards.help += loop.cards.help;
    out.cards.rejectedCompile += loop.cards.rejectedCompile;
    out.cards.childRunError += loop.cards.childRunError;
    out.cards.readOnlyShellBlocked += loop.cards.readOnlyShellBlocked ?? 0;
    for (const [card, n] of Object.entries(loop.cards.byCard ?? {})) out.cards.byCard[card] = (out.cards.byCard[card] ?? 0) + (n ?? 0);
    // 派发 / brief
    out.dispatches.total += loop.dispatches.length;
    for (const d of loop.dispatches) {
      if (d.briefHasRepro === true) out.dispatches.briefTrue++;
      else if (d.briefHasRepro === false) out.dispatches.briefFalse++;
      else out.dispatches.briefNull++;
    }
    // 常驻 prompt / 动手前调用
    if (loop.residentPromptChars === null || loop.residentPromptChars === undefined) out.residentPromptChars.unrecorded++;
    else {
      out.residentPromptChars.max = Math.max(out.residentPromptChars.max ?? 0, loop.residentPromptChars);
      if (loop.residentPromptChars > 8000) out.residentPromptChars.over8000++;
    }
    if (loop.preActionLlmCalls === null || loop.preActionLlmCalls === undefined) out.preActionLlmCalls.unrecorded++;
    else {
      out.preActionLlmCalls.sum += loop.preActionLlmCalls;
      if (loop.preActionLlmCalls > 1) out.preActionLlmCalls.over1++;
    }
    // conductor 节点: LLM 调用 + 墙钟分母
    const conductor = p.nodes.find((n) => n.id === 'conductor');
    if (typeof conductor?.llmCalls === 'number') {
      out.llmCalls.conductor += conductor.llmCalls;
      conductorRunsMeasured++;
    } else out.llmCalls.unmeasuredConductorRuns++;
    for (const n of p.nodes) nodeAcc(n);
    // 子行: 宽度 / 深度 / 节点墙钟 / worker LLM 调用
    let childMs = 0;
    let childMsComplete = children.length > 0;
    for (const c of children) {
      const levels = c.levels;
      out.width.push(levels.length === 0 ? 0 : Math.max(...levels.map((l) => l.length)));
      out.depth.push(levels.length);
      for (const n of c.nodes) {
        nodeAcc(n);
        if (typeof n.durationMs === 'number') childMs += n.durationMs;
        else childMsComplete = false;
        if (typeof n.llmCalls === 'number') {
          out.llmCalls.worker += n.llmCalls;
          workerNodesMeasured++;
        } else out.llmCalls.unmeasuredWorkerNodes++;
      }
    }
    if (childMsComplete && typeof conductor?.durationMs === 'number' && conductor.durationMs > 0) out.speedup.ratios.push(childMs / conductor.durationMs);
    else out.speedup.unmeasurable++;
  }
  out.widthStats = loopStats(out.width);
  out.depthStats = loopStats(out.depth);
  out.speedup.median = loopStats(out.speedup.ratios)?.median ?? null;
  out.verifier.perRun = out.verifier.calls / out.parents;
  out.evaporation.rate = out.evaporation.denominator > 0 ? out.evaporation.numerator / out.evaporation.denominator : null;
  out.cards.firstPassRate = out.cards.calls > 0 ? out.cards.ok / out.cards.calls : null;
  out.dispatches.perRun = out.dispatches.total / out.parents;
  const judged = out.dispatches.briefTrue + out.dispatches.briefFalse;
  out.dispatches.briefReproRate = judged > 0 ? out.dispatches.briefTrue / judged : null;
  out.llmCalls.conductorPerRun = conductorRunsMeasured > 0 ? out.llmCalls.conductor / conductorRunsMeasured : null;
  // worker 按**父 run** 摊 (读数问的是「每题 worker 烧了几次」), 只摊给量到了至少一个节点的 run 数不好定义 → 摊给全部父 run, 缺席节点数在旁边印。
  out.llmCalls.workerPerRun = workerNodesMeasured > 0 ? out.llmCalls.worker / out.parents : null;
  out.trailer.missingRate = out.trailer.agentNodes > 0 ? out.trailer.missing / out.trailer.agentNodes : null;
  return out;
}

export function readout(opts: { db: Database; limit?: number; dbPath?: string; mapsCwd?: string; mcpDb?: Database; seats?: Record<string, string>; boardRoot?: string | null }): ReadoutResult {
  const limit = opts.limit ?? 20;
  const meta: ReadoutResult['meta'] = { db: opts.dbPath ?? '(injected)', limit, readonly: true };
  const mcpPolicy = computeMcpPolicy(opts.mcpDb);
  // ⑱ 可避免性率 (D-5): 数据源独立于 db —— 算一次, 空世界也照出, 不混进两源。
  const avoidability = computeAvoidability(opts.boardRoot ?? null);
  const db = opts.db;
  const hasTable = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'omd_dag_runs'`).get() != null;
  if (!hasTable) return emptyWorld(meta, opts.seats, mcpPolicy, avoidability);

  // 老库可能缺后加的列 → 查一次 pragma 再拼, 缺的列补 NULL (正是"这批记录没记"那一格,
  // 与"记了但为空"分开数; 同 CLI ⑦ 段的做法, 不另起一套)。
  //
  // ⚠ **`run_id` 也在这条里** (2026-08-06 修): 它同样是后加的列, 而此前它躺在**必选**那一半 ——
  //   于是一个 `createDagRecorder` 认得、会自动迁移的老库, 在**只读**的读数板上直接崩
  //   (`dag-record.test.ts` 里就有一个正是这种 schema 的夹具)。读侧不迁移, 所以读侧必须容忍。
  //   只有建表那一刻就有的列 (id/created_at/levels/nodes/usage) 才留在必选那一半。
  const haveCols = (db.query(`PRAGMA table_info(omd_dag_runs)`).all() as { name: string }[]).map((c) => c.name);
  const optionalCol = (name: string) => (haveCols.includes(name) ? `, ${name}` : `, NULL AS ${name}`);
  const rows = db
    .query(
      `SELECT id, created_at, levels, nodes, usage${optionalCol('run_id')}${optionalCol('observations')}${optionalCol('entry')}${optionalCol('outcome')}${optionalCol('reused')}${optionalCol('criteria')}${optionalCol('claim_check')}${optionalCol('artifact_move')}${optionalCol('write_race')}${optionalCol('rollback')}${optionalCol('acceptance_probe')}${optionalCol('spec_write')}${optionalCol('plan_name')}${optionalCol('verification')}${optionalCol('loop')}` +
        ` FROM omd_dag_runs ORDER BY created_at ASC`,
    )
    .all() as ReadoutRow[];
  if (rows.length === 0) return emptyWorld(meta, opts.seats, mcpPolicy);

  // ⑮ 的坏行计数: nodes 解析失败/形状不对的行**单列不吞** —— 它们在下面任何数里都看不见,
  // 不数出来就是静默丢 (同四格「未记」那一格的分寸)。
  let badNodesRows = 0;
  const parsed: ParsedRow[] = rows.map((r) => {
    // usage 列恒 NOT NULL, 但防御: 记坏了按没记处理 (不编 0 —— 那会把"没记"读成"零用量")。
    let usage: Usage | null = null;
    try {
      const u = JSON.parse(r.usage) as Partial<Usage>;
      if (
        u &&
        typeof u === 'object' &&
        [u.conductorIn, u.conductorOut, u.leavesIn, u.leavesOut, u.leavesCacheHit].every((v) => typeof v === 'number')
      ) {
        usage = u as Usage;
      }
    } catch {
      /* 解析失败 = 没记 */
    }
    // levels/nodes 同 usage 的防御: 坏行不炸整块板, 按"这批节点没记"处理 (归四格「未记」, 审查 F2)。
    let levelIds: string[] = [];
    let levels: string[][] = [];
    try {
      const l = JSON.parse(r.levels) as unknown;
      if (Array.isArray(l)) {
        levels = (l as unknown[]).map((lv) => (Array.isArray(lv) ? (lv as string[]) : []));
        levelIds = levels.flat();
      }
    } catch {
      /* 解析失败 = 没记 */
    }
    let nodes: DagRunNode[] = [];
    try {
      const n = JSON.parse(r.nodes) as unknown;
      if (Array.isArray(n)) nodes = n as DagRunNode[];
      else badNodesRows++; // 记了但形状不是数组 —— 坏行, 单列不吞
    } catch {
      badNodesRows++; // 坏 JSON —— 坏行, 单列不吞
    }
    return {
      id: r.id,
      createdAt: r.created_at,
      runId: r.run_id,
      // entry 词表归一 (t7, 2026-08-04): 历史行的旧词 (dag_run/dag_goal/path_deliver) 折进新词
      // (run/solve/map_deliver) —— 同一入口不因改名在分布里裂成两行。真源 = TOOL_RENAMES 同一张表。
      entry: normalizeEntry(r.entry),
      levelIds,
      levels,
      nodes,
      usage,
      outcome: r.outcome,
      reused: r.reused,
      criteria: parseCriteria(r.criteria),
      acceptanceProbe: parseAcceptanceProbe(r.acceptance_probe),
      specWrite: parseSpecWrite(r.spec_write),
      planName: r.plan_name,
      verification: r.verification,
      loop: parseLoop(r.loop),
    };
  });

  // ── ① run_id 归并 (账本主体) ────────────────────────────────────────────────
  const byRun = new Map<string, ParsedRow[]>();
  for (const r of parsed) {
    // 没记 run_id 的老行/图外调用各自成组 (用主键当键) —— 并进同一个 "null" 组会把无关的
    // 运行加在一起, 那是**编出来的**一笔账 (同 CLI ① 段)。
    const key = r.runId ?? `(no-runid):${r.id}`;
    const group = byRun.get(key);
    if (group) group.push(r);
    else byRun.set(key, [r]);
  }
  const allRuns: RunReadout[] = [...byRun.entries()]
    .map(([runId, recs]) => mergeRun(runId, recs))
    .sort((a, b) => a.first_at - b.first_at || (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));
  const shown = allRuns.slice(0, limit);

  // ── ② DAG 节点全集 + 复用推断 (四格 / 风险格 / 复用率的数据前提) ───────────────
  // 节点全集 = 各记录 `levels` 的并集 (topoLevels 的全 plan 节点 id; :memory: 夹具没有 repo
  // 可扫, levels 是留痕层唯一全量拓扑)。
  //
  // ⚠ 「**哪些**节点被复用」留痕层只存了计数 (reused 列), 节点 id 按可证语义推:
  //   记录 R 声明了复用 (reused > 0) ∧ 节点在 R 的 plan 里但不在 R 的执行结果里 ∧ 该节点在
  //   更早的记录里执行过 → 那才是跨轮复用 (复用 = 零 LLM 拿上轮结果接住, 不可能接一个
  //   没跑过的节点; z 那样在 plan 里但从未执行的 = 缺席, 不是复用)。
  const universe = new Map<string, NodeInfo>();
  for (const r of parsed) {
    for (const id of r.levelIds) {
      if (!universe.has(id)) universe.set(id, freshNodeInfo());
    }
    for (const n of r.nodes) {
      const info = universe.get(n.id) ?? freshNodeInfo();
      if (!info.executed || r.createdAt < info.firstExecAt) {
        info.executed = true;
        info.firstExecAt = r.createdAt;
        // command 只在**首次实际执行**分支记 (审查 F4): 后写覆盖会把早跑过 X、后来换 Y 重跑的
        // 节点按 Y 分级, 而 Y 可能从没跑过 —— 风险级按真跑过的那个算。
        if (n.command) info.command = n.command;
      }
      if (n.status === 'done') info.everDone = true;
      universe.set(n.id, info);
    }
  }
  // ⚠ **2026-08-06 修:此前这里是"按可证语义推",而那个前提是假的。**
  //
  //   旧判据:「节点在 plan 里、**不在执行结果里**、且更早跑过 → 那是复用」。
  //   而复用节点**就在结果里** —— 引擎给它 `skipped: true` 并照常写进 `results`。
  //   于是那条推断**恒返空集**,读数板印出「复用率 0.0%」与四格 `reused_success 0`,
  //   而同一批记录里 32 条声明过复用、共 ~123 个节点。**那是个假零**,
  //   而且它与 ⑩ 段按 run 级计数算的 21.9% 直接打架(同一页两个数,S-19 那一族)。
  //
  //   现在改成读节点面那一位(`DagRunNode.reused`,2026-08-06 起记)。
  //   ⚠ 老行没有那一位 → **它们的复用面算不出**,而"算不出"不许写成 0:
  //     `reusedUnknownRuns` 单独数,下面 `reuse_rate` 的分母只认**记了这一位的跑**。
  const reused = new Set<string>();
  let reusedKnownRuns = 0;
  let reusedUnknownRuns = 0;
  const reusedBase = new Set<string>();
  for (const r of parsed) {
    // 「这一跑记没记节点级复用」= 它的 nodes 里有没有可能带这一位。老行整批没有 →
    // 用 run 级 `reused` 计数当旁证:声明了复用却一个节点都没标 = 这一跑是老格式。
    const marked = r.nodes.filter((n) => n.reused === true);
    const declares = (r.reused ?? 0) > 0;
    if (declares && marked.length === 0) {
      reusedUnknownRuns++; // 老行:声明了复用而节点面没标 —— **算不出**,不进分母
      continue;
    }
    reusedKnownRuns++;
    for (const n of r.nodes) {
      reusedBase.add(n.id);
      if (n.reused === true) reused.add(n.id);
    }
  }

  // ── ③ 四格 + 两个风险格 ──────────────────────────────────────────────────────
  // 四格: reused 优先于 executed 归类 (x 在 run-B 第一段执行过、第二段被复用 → 只算 reused 一格)。
  const four_grid: ReadoutResult['criteria_grid']['four_grid'] = { executed_success: 0, executed_failure: 0, reused_success: 0, 未记: 0 };
  const riskCount = new Map<CommandRiskTier, { executed: number; not_executed: number }>(
    (Object.keys(RISK_TIER_ORDER) as CommandRiskTier[]).map((t) => [t, { executed: 0, not_executed: 0 }]),
  );
  for (const [id, info] of universe) {
    if (reused.has(id)) {
      four_grid.reused_success++;
      if (info.command) riskCount.get(commandRiskTier(info.command))!.not_executed++;
    } else if (info.executed) {
      if (info.everDone) four_grid.executed_success++;
      else four_grid.executed_failure++;
      if (info.command) riskCount.get(commandRiskTier(info.command))!.executed++;
    } else {
      four_grid['未记']++;
    }
  }
  const two_grid_risk: ReadoutResult['criteria_grid']['two_grid_risk'] = (Object.keys(RISK_TIER_ORDER) as CommandRiskTier[])
    .sort((a, b) => RISK_TIER_ORDER[a] - RISK_TIER_ORDER[b])
    .map((risk_level) => ({ risk_level, ...riskCount.get(risk_level)! }));

  // ── ④ 分布 / 判据轴 / 复用率 ─────────────────────────────────────────────────
  const outcome_distribution = zeroOutcomeDistribution();
  for (const run of shown) outcome_distribution[run.status]++;
  outcome_distribution.total = shown.length;

  const byEntry = new Map<string, { runs: number; attempts: number; firstAt: number }>();
  for (const run of shown) {
    const e = byEntry.get(run.entry) ?? { runs: 0, attempts: 0, firstAt: run.first_at };
    e.runs++;
    e.attempts += run.attempts;
    byEntry.set(run.entry, e);
  }
  const entry_distribution = [...byEntry.entries()]
    .sort((a, b) => a[1].firstAt - b[1].firstAt)
    .map(([entry, v]) => ({ entry, runs: v.runs, attempts: v.attempts }));

  // cost-per-success (原任务 ①): 分子只加已记 usage 的 run (缺席 ≠ 0), 分母 = 该组 success run 数。
  const cost_per_success = entry_distribution.map(({ entry }) => {
    const group = shown.filter((run) => run.entry === entry);
    const tokens = { conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 };
    let unmeasured_runs = 0;
    for (const run of group) {
      if (run.usage === null) {
        unmeasured_runs++;
        continue;
      }
      tokens.conductorIn += run.usage.conductorIn;
      tokens.conductorOut += run.usage.conductorOut;
      tokens.leavesIn += run.usage.leavesIn;
      tokens.leavesOut += run.usage.leavesOut;
      tokens.leavesCacheHit += run.usage.leavesCacheHit;
    }
    const success_runs = group.filter((run) => run.status === 'success').length;
    const spent = tokens.conductorIn + tokens.conductorOut + tokens.leavesIn + tokens.leavesOut;
    return {
      entry,
      runs: group.length,
      success_runs,
      unmeasured_runs,
      tokens,
      tokens_per_success: success_runs > 0 ? spent / success_runs : null,
    };
  });

  const spend_discipline = computeSpendDiscipline(shown);

  const criteria_consistency: ReadoutResult['criteria_consistency'] = { agree: 0, oracleFailed: 0, wastedRounds: 0, agreeFail: 0, unrecorded: 0, recorded: 0 };
  for (const run of shown) {
    const c = run.criteria;
    if (!c) continue;
    criteria_consistency.recorded++;
    if (c.judge && c.oracle) criteria_consistency.agree++;
    else if (c.judge && !c.oracle) criteria_consistency.oracleFailed++;
    else if (!c.judge && c.oracle) criteria_consistency.wastedRounds++;
    else criteria_consistency.agreeFail++;
  }
  criteria_consistency.unrecorded = shown.length - criteria_consistency.recorded;

  // 全量口径 (⑩ 与 ⓪ 用): 按 runId 去重, 不截窗口 —— 「judge 太紧过几次」不是窗口问题。
  const criteria_axis: ReadoutResult['criteria_axis'] = { agree: 0, oracleFailed: 0, wastedRounds: 0, agreeFail: 0, recorded: 0, unrecorded: 0 };
  {
    const seen = new Map<string, { judge: boolean; oracle: boolean }>();
    for (const p of parsed) if (p.criteria && p.runId) seen.set(p.runId, p.criteria);
    for (const c of seen.values()) {
      criteria_axis.recorded++;
      if (c.judge && c.oracle) criteria_axis.agree++;
      else if (c.judge && !c.oracle) criteria_axis.oracleFailed++;
      else if (!c.judge && c.oracle) criteria_axis.wastedRounds++;
      else criteria_axis.agreeFail++;
    }
    criteria_axis.unrecorded = new Set(parsed.map((p) => p.runId).filter((x): x is string => !!x)).size - criteria_axis.recorded;
  }

  // ── G4 采样 (冻结契约 §5): 分母 = entry 为 solve (旧 dag_goal 已归一) 且 acceptance_probe 非 NULL 的 run ──
  // NULL (老行 / 非 dag_goal / 解析失败) 一律不进分母 —— 没记 ≠ 失败, 不编 'unknown'。
  //
  // ⚠ **走 `allRuns` 不走 `shown`** (2026-08-03 修): 展示窗口取的是**最早 limit 个**
  // (冻结契约刻意钉死的截断端), 而这是**闸的判据** —— G4 收尾判据要「采样 ≥10 次」。
  // 搭窗口的车会让历史 run 一超 limit 之后, **以后每跑一次都落在窗口外**, 分母永远停在同一个数,
  // 而板上看不出它停了。同一个坑当天先咬了 G3 的分母一次 (见 gate_denominators 的注)。
  // **展示归展示, 判据归判据**: 窗口只管那张 run 表, 闸的数一律全量。
  const g4_sampling: ReadoutResult['g4_sampling'] = { denominator: 0, passedBoth: 0, vacuityOnly: 0, demoted: 0, skipped: 0, exploratory: 0 };
  for (const run of allRuns) {
    if (run.entry !== 'solve' || run.acceptanceProbe === null) continue;
    g4_sampling.denominator++;
    switch (run.acceptanceProbe.kind) {
      case 'passed-both':
        g4_sampling.passedBoth++;
        break;
      case 'vacuity-only':
        g4_sampling.vacuityOnly++;
        break;
      case 'demoted':
        g4_sampling.demoted++;
        g4_sampling.exploratory++;
        break;
      case 'skipped':
        g4_sampling.skipped++;
        g4_sampling.exploratory++;
        break;
      case 'exploratory':
        g4_sampling.exploratory++;
        break;
    }
  }

  // ── #209 spec 写入磁盘频率: 同 G4 的口径, 走 `allRuns` 不走 `shown` (判据不搭展示窗口的车) ──
  // NULL 不进分母 —— 「没记」与「没写入磁盘」是两件事, 而把它们混为一谈正是这一列存在的理由。
  const spec_write_sampling: ReadoutResult['spec_write_sampling'] = { denominator: 0, wrote: 0, missing: 0, notNeeded: 0, contractRuns: 0, missRate: null };
  for (const run of allRuns) {
    if (run.entry !== 'solve' || run.specWrite === null) continue;
    spec_write_sampling.denominator++;
    if (run.specWrite.kind === 'wrote') spec_write_sampling.wrote++;
    else if (run.specWrite.kind === 'missing') spec_write_sampling.missing++;
    else spec_write_sampling.notNeeded++;
  }
  spec_write_sampling.contractRuns = spec_write_sampling.wrote + spec_write_sampling.missing;
  spec_write_sampling.missRate = spec_write_sampling.contractRuns
    ? spec_write_sampling.missing / spec_write_sampling.contractRuns
    : null;

  // ── 闸的分母 (2026-08-03): 全量, 不搭展示窗口的车 —— 见 gate_denominators 的注 ──
  const g3LiveRuns = allRuns.filter((r) => r.entry !== null && r.entry !== '未记').length;
  const gate_denominators: ReadoutResult['gate_denominators'] = {
    g3LiveRuns,
    g4Samples: g4_sampling.denominator,
    // 「跑了但没记上」: 注册表里有、留痕库里没有。读不到 → null (不知道), **不编 0**。
    ledgerGap: countLedgerGap(opts.dbPath ?? null, new Set(allRuns.map((r) => r.run_id))),
  };

  // 分母**只认记了节点级复用的跑** —— 拿全集当分母会把老行的"算不出"稀释成"没复用"。
  const total_nodes = reusedBase.size;
  const reused_nodes = reused.size;

  // ⑧.5 检出器活体读数 —— **只有这一处算**, CLI 从这里渲染 (两处各算一份必漂)。
  let ccRecorded = 0;
  let ccUnrecorded = 0;
  const ccAcc = { condRounds: 0, condNodes: 0, condFindings: 0, flatNodes: 0, flatFindings: 0 };
  const ccSamples: { runId: string | null; message: string }[] = [];
  // ⑧ 的分母 (2026-08-06)。与 ccAcc 同一趟扫: 两段量的是两条判据, 但"缺席≠0"的数法一模一样。
  let amRecorded = 0;
  let amUnrecorded = 0;
  const amAcc = { transitions: 0, unobserved: 0, findings: 0 };
  // ⑧.6 运行时写竞争的分母 (2026-08-06)。同上: overlaps 是有没有并发, pairs 才是撞得上的机会。
  let wrRecorded = 0;
  let wrUnrecorded = 0;
  // ⚠ 推断口径两位单独数 **记了这一位的跑**: 老行缺席不是 0, 混进来会把基率往低了报。
  const wrAcc = { overlaps: 0, pairs: 0, findings: 0, pairsInferred: 0, findingsInferred: 0, inferredRuns: 0 };
  // ⑧.1 内环形状 (2026-08-06) —— 「⑧ 那个 0 为什么是 0」的分母, 见 ReadoutResult.loop_shape。
  //
  // ⚠ 这一段扫 **parsed** 而不是 rows: 它读的是节点面 (kind / rounds / maxRounds), 不是 run 级那三个
  //   JSON 列。① 那一格 (图里没有 conductor) 只用 kind, 所以**老行也算得出** —— 这是它与 ⑧/⑧.6
  //   的关键差别: 那两段得等新跑, 这一格今天就有答案。
  const ls = {
    runsWithoutConductor: 0,
    runsWithConductor: 0,
    conductorNodes: 0,
    unrecordedNodes: 0,
    singleRound: 0,
    firstRoundConverged: 0,
    turned: 0,
  };
  // ── ⑥ §8.4 熔断的键该不该改 —— 连同它的**机会分母**(2026-08-06 修正) ──────────
  //
  // ⚠ 此前这一段(住在 CLI 渲染里)把结论读反了: 只分 `nearMiss`(同输出不同命令)与
  //   `exactRepeat`(同输出同命令)两格, 而后者对一个**只出现过一次**的指纹同样成立 ——
  //   熔断按构造要「≥2 次」, 单次失败两种键都抓不到。于是 singleton 被算进了
  //   "现行键抓得到的那一格"。实测 54 跑: 指纹 25 · singleton 22 · 真机会 3 ·
  //   near-miss 3 · 真重复 **0** —— 旧读法给出"覆盖 88% → 够用", 真相是现行键**一组没抓到**。
  // ⚠ 计算挪进这里(而不是留在渲染层)也是这次的教训之一: 那一段独立数了一遍, 谁都没闸它。
  // ── ⑬ 跑坏了回得去吗 (D1, 2026-08-06) ────────────────────────────────────────
  // 老行没记 → **不进任何分母** (它与 `unknown` 是两件事: 前者这条链当时还没接,
  // 后者接了但那一次查失败了 —— 后者是缺陷线索, 前者只是历史)。
  const rbKind: Record<RollbackAnchorKind, number> =
    { clean: 0, 'dirty-tracked': 0, 'dirty-untracked': 0, 'not-a-repo': 0, unknown: 0 };
  let rbRecorded = 0;
  let rbUnrecorded = 0;
  for (const r of rows) {
    if (!r.rollback) {
      rbUnrecorded++;
      continue;
    }
    rbRecorded++;
    try {
      const v = JSON.parse(r.rollback) as { kind?: string };
      if (v.kind && v.kind in rbKind) rbKind[v.kind as RollbackAnchorKind]++;
      else rbKind.unknown++; // 词表外的字面量 (老库) → 归 unknown, 同 ⑦ 段的三态纪律
    } catch {
      rbKind.unknown++; // 坏 JSON: 记了但读不出 —— 那是 unknown 不是 clean
    }
  }
  const rollback: ReadoutResult['rollback'] = {
    recordedRuns: rbRecorded,
    unrecordedRuns: rbUnrecorded,
    byKind: rbKind,
    cleanRate: rbRecorded > 0 ? rbKind.clean / rbRecorded : null,
  };

  // ── ⑤.1 检查者只读吗 (D4 / §7.3) —— 分母在节点面, 分子在观察面 ────────────────
  // inproc 检测者**不进分母**: 它没有写工具, 那是"不可能"不是"没发生" (S-19 那一族)。
  const dw = { detectors: 0, agentDetectors: 0, observed: 0, wroteControlled: 0 };
  for (const p of parsed) {
    for (const n of p.nodes) {
      if (n.detector !== true) continue;
      dw.detectors++;
      if (n.kind !== 'agent') continue;
      dw.agentDetectors++;
      if (!n.writeCounts) continue; // 缺席 ≠ 0: 这条链没人报
      dw.observed++;
      if (n.writeCounts[0] > 0) dw.wroteControlled++;
    }
  }
  // 分子来自**观察面**那一列 (与上面的分母不同源, 见 detector_writes 的注)。
  let dwFindings = 0;
  for (const r of rows) {
    if (!r.observations) continue;
    try {
      for (const o of JSON.parse(r.observations) as { kind?: string }[]) if (o.kind === 'detector-wrote') dwFindings++;
    } catch {
      // 坏 JSON 不该让整块读数崩 (同上面几处)。
    }
  }
  const detector_writes: ReadoutResult['detector_writes'] = {
    ...dw,
    findings: dwFindings,
    rate: dw.observed > 0 ? dw.wroteControlled / dw.observed : null,
  };

  // command 节点这一侧写不写文件 —— 见 write_race.commandWrites 的注(「正确的零」那段)。
  const cwAll: string[] = [];
  for (const p of parsed) for (const n of p.nodes) if (n.command?.trim()) cwAll.push(n.command);
  const cwDistinct = [...new Set(cwAll)];
  const commandWrites = {
    commands: cwAll.length,
    distinct: cwDistinct.length,
    withTargets: cwDistinct.filter((c) => shellWriteTargets(c).length > 0).length,
  };

  const bkBy = new Map<string, { cmds: Set<string>; hits: number; runs: Set<string> }>();
  for (const p of parsed) {
    for (const n of p.nodes) {
      if (!n.outputHash || !n.command) continue;
      let e = bkBy.get(n.outputHash);
      if (!e) bkBy.set(n.outputHash, (e = { cmds: new Set(), hits: 0, runs: new Set() }));
      e.cmds.add(n.command.trim());
      e.hits++;
      e.runs.add(p.id);
    }
  }
  // **空输出那一格是反例, 不是机会**(2026-08-06 第二层修正, 渲染出来当场照出的)。
  // `dag-record` 按 `sha1(output.trim())` 指纹, 于是所有**没有输出**的失败(`grep -q` 那族)
  // 全落在同一个桶里 —— 实测这个桶里有两条毫不相干的命令。把它算进 near-miss 等于说
  // "改成更宽的键能多抓到它们", 而事实恰恰相反: 那正是设计注里警告过的**误熔断**
  // (两个不同断言各失败一次 → 被判成同一条在空转)。算出来不写死, 免得哪天改了 hash 算法。
  const EMPTY_OUTPUT_FP = new Bun.CryptoHasher('sha1').update('').digest('hex').slice(0, 12);
  const bkEmpty = bkBy.get(EMPTY_OUTPUT_FP);
  const bkAll = [...bkBy.entries()].filter(([h]) => h !== EMPTY_OUTPUT_FP);
  // 三格**互斥且穷尽**: singleton(没机会)/ 真重复(现行键抓得到)/ near-miss(现行键漏掉)。
  const bkNearMiss = bkAll.filter(([, e]) => e.cmds.size > 1);
  const bkExactRepeat = bkAll.filter(([, e]) => e.hits >= 2 && e.cmds.size === 1).length;
  const bkSingletons = bkAll.filter(([, e]) => e.hits < 2).length;
  // §8.4 熔断是**同一次 run 的环内**累计 —— 跨 run 凑出来的那组不是真机会, 单独报。
  const bkCrossRun = bkNearMiss.filter(([, e]) => e.runs.size > 1).length;
  const bkOpp = bkNearMiss.length + bkExactRepeat;
  const breaker_key: ReadoutResult['breaker_key'] = {
    fingerprints: bkAll.length,
    emptyOutputCommands: bkEmpty ? bkEmpty.cmds.size : 0,
    singletons: bkSingletons,
    opportunities: bkOpp,
    nearMiss: bkNearMiss.length,
    exactRepeat: bkExactRepeat,
    nearMissCrossRun: bkCrossRun,
    nearMissSameRun: bkNearMiss.length - bkCrossRun,
    rate: bkOpp > 0 ? bkNearMiss.length / bkOpp : null,
    samples: bkNearMiss.slice(0, 3).map(([h, e]) => ({
      outputHash: h,
      commands: [...e.cmds].slice(0, 2).map((c) => c.slice(0, 64)),
      sameRun: e.runs.size === 1,
    })),
  };

  for (const p of parsed) {
    const conds = p.nodes.filter((n) => n.kind === 'conductor');
    if (conds.length === 0) {
      ls.runsWithoutConductor++;
      continue;
    }
    ls.runsWithConductor++;
    for (const c of conds) {
      ls.conductorNodes++;
      // 缺席 ≠ 0 ≠ 不适用: 两位**任一**缺席就归"没记" —— 少一位就判不出是 ② 还是 ③,
      // 拿 `?? 1` 顶上去等于把"没记"洗成"单轮档", 而那正是这一段要拆开的东西。
      if (typeof c.rounds !== 'number' || typeof c.maxRounds !== 'number') {
        ls.unrecordedNodes++;
      } else if (c.maxRounds <= 1) {
        ls.singleRound++;
      } else if (c.rounds <= 1) {
        ls.firstRoundConverged++;
      } else {
        ls.turned++;
      }
    }
  }
  for (const r of rows) {
    if (!r.write_race) {
      wrUnrecorded++;
    } else {
      wrRecorded++;
      try {
        const v = JSON.parse(r.write_race) as {
          overlaps?: number; pairs?: number; findings?: number; pairsInferred?: number; findingsInferred?: number;
        };
        wrAcc.overlaps += v.overlaps ?? 0;
        wrAcc.pairs += v.pairs ?? 0;
        wrAcc.findings += v.findings ?? 0;
        // 缺席 = 这一跑早于推断口径 → **整跑不进推断那两个数**(不是当 0 加进去)。
        if (typeof v.pairsInferred === 'number') {
          wrAcc.inferredRuns++;
          wrAcc.pairsInferred += v.pairsInferred;
          wrAcc.findingsInferred += v.findingsInferred ?? 0;
        }
      } catch {
        // 同下: 坏 JSON 不该让整块读数崩。
      }
    }
    if (!r.artifact_move) {
      amUnrecorded++;
    } else {
      amRecorded++;
      try {
        const v = JSON.parse(r.artifact_move) as { transitions?: number; unobserved?: number; findings?: number };
        amAcc.transitions += v.transitions ?? 0;
        amAcc.unobserved += v.unobserved ?? 0;
        amAcc.findings += v.findings ?? 0;
      } catch {
        // 坏 JSON 不该让整块读数崩; 已计进 recordedRuns, 差额自然显示为算不出 (同下面那条)。
      }
    }
    if (!r.claim_check) {
      ccUnrecorded++;
    } else {
      ccRecorded++;
      try {
        const v = JSON.parse(r.claim_check) as {
          conductor?: { rounds?: number; nodes?: number; findings?: number };
          flat?: { nodes?: number; findings?: number };
        };
        ccAcc.condRounds += v.conductor?.rounds ?? 0;
        ccAcc.condNodes += v.conductor?.nodes ?? 0;
        ccAcc.condFindings += v.conductor?.findings ?? 0;
        ccAcc.flatNodes += v.flat?.nodes ?? 0;
        ccAcc.flatFindings += v.flat?.findings ?? 0;
      } catch {
        // 坏 JSON 不该让整块读数崩; 它已计进 recordedRuns, 差额自然显示为算不出。
      }
    }
    if (!r.observations) continue;
    try {
      for (const o of JSON.parse(r.observations) as { kind: string; message?: string }[]) {
        if (o.kind === 'unsupported-claim' && o.message && ccSamples.length < 20) {
          ccSamples.push({ runId: r.run_id, message: o.message });
        }
      }
    } catch {
      /* 同上 */
    }
  }
  /** 每节点检出率。分母 0 → null(**算不出 ≠ 0**,同 tokens_per_success 那条纪律)。 */
  const ccRate = (findings: number, nodes: number): number | null => (nodes > 0 ? findings / nodes : null);

  // 注意力轴 (LoopX 对照): blocked 来自 outcome 分布 (引擎侧记录), 票的三个数来自 suggestionsLog
  // (owner 侧记录) —— 两个来源不重叠, 各自的缺席各自报 null, 不互相填。
  const sa = opts.mapsCwd !== undefined ? aggregateSuggestionAcceptance(opts.mapsCwd) : null;
  const attention_axis: ReadoutResult['attention_axis'] = {
    blocked_runs: outcome_distribution.blocked,
    total_runs: outcome_distribution.total,
    handback_rate: outcome_distribution.total > 0 ? outcome_distribution.blocked / outcome_distribution.total : null,
    pending_tickets: sa?.pending ?? null,
    decided_tickets: sa?.decided ?? null,
    rejected_tickets: sa?.rejected ?? null,
    wasted_review_share: sa && sa.decided > 0 ? sa.rejected / sa.decided : null,
  };

  // ── ⑭ 管线税 (solve 路 contract vs execute 两段对照, 全量口径) ───────────────
  // 先按 entry 隔离 (solve, 旧 dag_goal 已归一) 再按 run_id 归并 (复用 byRun 分组);
  // 段归属按 plan_name **精确**匹配 —— 直通 merge 若改了图名, unknownPlans 会照出来而不是静默归零。
  const PLAN_CONTRACT = 'goal-contract';
  const PLAN_EXECUTE = 'goal-execute';
  const solveByRun = new Map<string, ParsedRow[]>();
  for (const [runId, recs] of byRun) {
    const solve = recs.filter((r) => r.entry === 'solve');
    if (solve.length > 0) solveByRun.set(runId, solve);
  }
  // verification 三态: 列缺 (老行 NULL) / 记了读不出 (含 pass 非布尔) / pass:false。分列不合并。
  const parseVerif = (raw: string | null): { pass: boolean } | 'unrecorded' | 'unparsed' => {
    if (raw === null) return 'unrecorded';
    try {
      const v = JSON.parse(raw) as Partial<{ pass: unknown }>;
      if (v && typeof v === 'object' && typeof v.pass === 'boolean') return { pass: v.pass };
    } catch {
      /* 记了但读不出 = unparsed */
    }
    return 'unparsed';
  };
  let contractTokens = 0;
  let totalTokens = 0;
  let bothMeasuredRuns = 0;
  let unmeasuredRuns = 0;
  let verifUnrecorded = 0;
  let verifUnparsed = 0;
  let rejections = 0;
  const unknownPlans = new Map<string, number>();
  const replans: ReadoutResult['pipeline_tax']['replans'] = [];
  for (const [runId, recs] of solveByRun) {
    const contractRecs = recs.filter((r) => r.planName === PLAN_CONTRACT);
    const executeRecs = recs.filter((r) => r.planName === PLAN_EXECUTE);
    for (const r of recs) {
      if (r.planName !== PLAN_CONTRACT && r.planName !== PLAN_EXECUTE) {
        const p = r.planName ?? '(null)';
        unknownPlans.set(p, (unknownPlans.get(p) ?? 0) + 1);
      }
    }
    // verifier 打回只数 execute 段行 (被 verifier 审的是执行段); 三态分列, 不合并。
    for (const r of executeRecs) {
      const v = parseVerif(r.verification);
      if (v === 'unrecorded') verifUnrecorded++;
      else if (v === 'unparsed') verifUnparsed++;
      else if (!v.pass) rejections++;
    }
    // 重规划: execute 段 attempt 按 created_at 升序, 前一条被 verifier 打回 → 记一事件;
    // 增量逐字段 usage[i] − usage[i-1], 任一侧没记 → 该字段 null (算不出, 不编 0)。
    const execAsc = [...executeRecs].sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 1; i < execAsc.length; i++) {
      const prev = execAsc[i - 1]!;
      const cur = execAsc[i]!;
      const prevV = parseVerif(prev.verification);
      if (prevV === 'unrecorded' || prevV === 'unparsed' || prevV.pass) continue;
      const delta = (f: 'conductorIn' | 'conductorOut' | 'leavesIn' | 'leavesOut' | 'leavesCacheHit'): number | null =>
        prev.usage === null || cur.usage === null ? null : cur.usage[f] - prev.usage[f];
      replans.push({
        runId,
        deltas: { conductorIn: delta('conductorIn'), conductorOut: delta('conductorOut'), leavesIn: delta('leavesIn'), leavesOut: delta('leavesOut'), leavesCacheHit: delta('leavesCacheHit') },
      });
    }
    // 占比分母只算**两段都记了 usage** 的 run; 缺任一段 → unmeasuredRuns (不在分母里)。
    const cMeasured = contractRecs.some((r) => r.usage !== null);
    const eMeasured = executeRecs.some((r) => r.usage !== null);
    if (cMeasured && eMeasured) {
      bothMeasuredRuns++;
      for (const r of [...contractRecs, ...executeRecs]) {
        if (r.usage === null) continue;
        const four = r.usage.conductorIn + r.usage.conductorOut + r.usage.leavesIn + r.usage.leavesOut;
        totalTokens += four;
        if (r.planName === PLAN_CONTRACT) contractTokens += four; // cacheHit 是折扣标记, 不进分子
      }
    } else {
      unmeasuredRuns++;
    }
  }
  const pipeline_tax: ReadoutResult['pipeline_tax'] = {
    solveRuns: solveByRun.size,
    bothMeasuredRuns,
    unmeasuredRuns,
    unknownPlans: [...unknownPlans.entries()].map(([plan, rows]) => ({ plan, rows })).sort((a, b) => a.plan.localeCompare(b.plan)),
    contractTokens,
    totalTokens,
    contractShare: bothMeasuredRuns > 0 ? contractTokens / totalTokens : null,
    verifUnrecorded,
    verifUnparsed,
    rejections,
    replans,
  };

  // ── ⑮ 座位健康 (per-node model vs 读数时刻座位配置) ──────────────────────────
  // kind→seat 映射: conductor→'conductor' 座位, agent→'leaf' 座位; 其余 kind (command/inproc/
  // research/map…) → unmappedKinds, **不编期望不算偏离**。nodes 是 JSON 文本列, 防御性解析;
  // 坏行已计进 badNodesRows, 单列不吞。
  // ⚠ 座位参照是**读数时刻**的解析结果 (CLI 注入, readout 不自读 env) —— 座位配置没有按 run 时点
  //   落账, run 时点 ≠ 读数时点时这段会把"后来改过配置"读成"当时偏离" (诚实边界同款, 不是缺陷)。
  const seatForKind: Record<string, string | undefined> = { conductor: 'conductor', agent: 'leaf' };
  const unmappedKinds: Record<string, number> = {};
  const deviations: NonNullable<ReadoutResult['seat_health']['deviations']> = [];
  let noModelNodes = 0;
  let kimiFallbackEvents = 0;
  const byModelMap = new Map<string, number>();
  const usageByModelMap = new Map<string, { runs: number; tokens: number }>();
  let mixedRuns = 0;
  for (const r of parsed) {
    const models = new Set<string>();
    for (const n of r.nodes) {
      if (typeof n.model !== 'string') { noModelNodes++; continue; }
      models.add(n.model);
      byModelMap.set(n.model, (byModelMap.get(n.model) ?? 0) + 1);
      const seat = seatForKind[n.kind];
      if (seat === undefined) {
        unmappedKinds[n.kind] = (unmappedKinds[n.kind] ?? 0) + 1;
        continue;
      }
      const expected = opts.seats?.[seat];
      if (expected === undefined) continue; // 该座位没解析出参照 → 判不了偏离 (整表缺席时两格为 null)
      if (n.model !== expected) {
        deviations.push({ runId: r.runId ?? `(no-runid):${r.id}`, nodeId: n.id, kind: n.kind, model: n.model, expected });
        // issue #6 复发哨: 节点用 kimi-coding 而期望座位不是 kimi-coding → 兜底事件
        if (n.model.split(':')[0] === 'kimi-coding' && expected.split(':')[0] !== 'kimi-coding') kimiFallbackEvents++;
      }
    }
    // usage 只在整 run 单模型时聚合 (混合座位硬摊 = 编账, 照 ⑩ 段那条纪律); usage 没记的 run 不进。
    if (models.size === 1) {
      const [m] = [...models];
      if (r.usage !== null) {
        const e = usageByModelMap.get(m!) ?? { runs: 0, tokens: 0 };
        e.runs++;
        e.tokens += r.usage.conductorIn + r.usage.conductorOut + r.usage.leavesIn + r.usage.leavesOut;
        usageByModelMap.set(m!, e);
      }
    } else if (models.size > 1) {
      mixedRuns++;
    }
  }
  const seat_health: ReadoutResult['seat_health'] = {
    badNodesRows,
    noModelNodes,
    unmappedKinds,
    deviations: opts.seats === undefined ? null : deviations,
    kimiFallbackEvents: opts.seats === undefined ? null : kimiFallbackEvents,
    byModel: [...byModelMap.entries()].map(([model, nodes]) => ({ model, nodes })).sort((a, b) => b.nodes - a.nodes || a.model.localeCompare(b.model)),
    usageByModel: [...usageByModelMap.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => a.model.localeCompare(b.model)),
    mixedRuns,
    seatsRef: opts.seats ?? {},
  };

  // ── ⑲ 编排循环 (R-1 第 4 步): 父行 loop 列 + conductor-* 子行 ─────────────────────────
  const loop_readout = computeLoopReadout(parsed);

  // ── ⑰ cache 趋势 (记录级时序, 取**最近** 20 行) ──────────────────────────────
  // ⚠ 与 ⑫ 的展示窗口方向相反: 那边取**最早** limit 个 run, 这里取 created_at 升序的**末尾**
  //   20 条记录 (不归并)。两处切片不同, 数不可比 —— 头注标出, 别读成同一窗口。
  // leavesIn=0 → rate null (没跑过 leaf ≠ 0%); usage 没记 → leavesIn/leavesCacheHit null (标 —)。
  const CACHE_TREND_WINDOW = 20;
  let zeroIn = 0;
  let unmeasuredTrend = 0;
  const trendRows: ReadoutResult['cache_trend']['rows'] = [];
  for (const r of parsed.slice(-CACHE_TREND_WINDOW)) {
    if (r.usage === null) {
      unmeasuredTrend++;
      trendRows.push({ createdAt: r.createdAt, runId: r.runId, leavesIn: null, leavesCacheHit: null, rate: null });
      continue;
    }
    trendRows.push({
      createdAt: r.createdAt,
      runId: r.runId,
      leavesIn: r.usage.leavesIn,
      leavesCacheHit: r.usage.leavesCacheHit,
      rate: r.usage.leavesIn > 0 ? r.usage.leavesCacheHit / r.usage.leavesIn : null,
    });
    if (r.usage.leavesIn === 0) zeroIn++;
  }
  const cache_trend: ReadoutResult['cache_trend'] = { rows: trendRows, zeroIn, unmeasured: unmeasuredTrend };

  return {
    meta,
    runs: shown,
    claim_check: {
      recordedRuns: ccRecorded,
      unrecordedRuns: ccUnrecorded,
      conductor: { rounds: ccAcc.condRounds, nodes: ccAcc.condNodes, findings: ccAcc.condFindings, rate: ccRate(ccAcc.condFindings, ccAcc.condNodes) },
      flat: { nodes: ccAcc.flatNodes, findings: ccAcc.flatFindings, rate: ccRate(ccAcc.flatFindings, ccAcc.flatNodes) },
      samples: ccSamples,
      sufficiency: { conductor: faceSufficiency(ccAcc.condNodes), flat: faceSufficiency(ccAcc.flatNodes) },
    },
    artifact_move: {
      recordedRuns: amRecorded,
      unrecordedRuns: amUnrecorded,
      transitions: amAcc.transitions,
      unobserved: amAcc.unobserved,
      // ⚠ 夹到 ≥0: 坏 JSON 让两个数各自缺一半时, 差可能是负的 —— 负分母比算不出更坏。
      comparable: Math.max(0, amAcc.transitions - amAcc.unobserved),
      findings: amAcc.findings,
      rate: amAcc.transitions - amAcc.unobserved > 0 ? amAcc.findings / (amAcc.transitions - amAcc.unobserved) : null,
      sufficiency: {
        runs: faceSufficiency(amRecorded, LOOP_NO_MOVE_MIN_N),
        transitions: faceSufficiency(amAcc.transitions, LOOP_NO_MOVE_MIN_N),
        comparable: faceSufficiency(Math.max(0, amAcc.transitions - amAcc.unobserved), LOOP_NO_MOVE_MIN_N),
      },
    },
    write_race: {
      recordedRuns: wrRecorded,
      unrecordedRuns: wrUnrecorded,
      overlaps: wrAcc.overlaps,
      pairs: wrAcc.pairs,
      findings: wrAcc.findings,
      rate: wrAcc.pairs > 0 ? wrAcc.findings / wrAcc.pairs : null,
      // 一跑都没记这一位 → null(**没记 ≠ 0 对**),不是 0。
      pairsInferred: wrAcc.inferredRuns > 0 ? wrAcc.pairsInferred : null,
      findingsInferred: wrAcc.inferredRuns > 0 ? wrAcc.findingsInferred : null,
      rateInferred: wrAcc.inferredRuns > 0 && wrAcc.pairsInferred > 0 ? wrAcc.findingsInferred / wrAcc.pairsInferred : null,
      sufficiency: {
        overlaps: faceSufficiency(wrAcc.overlaps, LOOP_NO_MOVE_MIN_N),
        pairs: faceSufficiency(wrAcc.pairs, LOOP_NO_MOVE_MIN_N),
        pairsInferred: faceSufficiency(wrAcc.pairsInferred, LOOP_NO_MOVE_MIN_N),
      },
      commandWrites,
    },
    rollback,
    detector_writes,
    breaker_key,
    loop_shape: { ...ls },
    outcome_distribution,
    entry_distribution,
    attention_axis,
    spend_discipline,
    cost_per_success,
    criteria_grid: { four_grid, two_grid_risk },
    criteria_axis,
    criteria_consistency,
    g4_sampling,
    spec_write_sampling,
    suggestion_acceptance: sa,
    gate_denominators,
    reuse_rate: { reused_nodes, total_nodes, rate: total_nodes > 0 ? reused_nodes / total_nodes : null, unknownRuns: reusedUnknownRuns },
    pipeline_tax,
    seat_health,
    mcp_policy: mcpPolicy,
    cache_trend,
    avoidability,
    loop_readout,
  };
}

/**
 * 消耗分桶 (LoopX 对照)。桶的归属**只从 {@link RUN_OUTCOME_INFO} 读**, 这里不另写一份映射 ——
 * 词表加新格时忘了同步的那种漂移, 是本仓 S-1/S-15 的同一族。
 *
 * `未记` (outcome 列 NULL, 早于 2026-07-31 的老行) 单列第五桶: 它不是 `unclassified`
 * (那格是「引擎跑完了但没交代」), 是「这条记录压根没有这个字段」。两者的下一步不同 ——
 * 前者去补引擎的标注, 后者只能等新数据。**编成同一桶就再也分不开。**
 */
function computeSpendDiscipline(shown: RunReadout[]): ReadoutResult['spend_discipline'] {
  const zero = () => ({ runs: 0, tokens: 0, unmeasured_runs: 0 });
  const buckets: ReadoutResult['spend_discipline']['buckets'] = {
    delivery: zero(),
    blocked: zero(),
    overhead: zero(),
    unclassified: zero(),
    未记: zero(),
  };
  for (const run of shown) {
    const key: SpendBucket | '未记' = run.status === '未记' ? '未记' : RUN_OUTCOME_INFO[run.status].spendBucket;
    const b = buckets[key];
    b.runs++;
    if (run.usage === null) {
      // 缺席 ≠ 0: 不加进 tokens, 单独计数。同 cost_per_success 的 unmeasured_runs。
      b.unmeasured_runs++;
      continue;
    }
    b.tokens += run.usage.conductorIn + run.usage.conductorOut + run.usage.leavesIn + run.usage.leavesOut;
  }
  const total_tokens = Object.values(buckets).reduce((a, b) => a + b.tokens, 0);
  const success_runs = shown.filter((run) => run.status === 'success').length;
  const share = (n: number): number | null => (total_tokens > 0 ? n / total_tokens : null);
  return {
    buckets,
    total_tokens,
    success_runs,
    tokens_per_success_all: success_runs > 0 ? total_tokens / success_runs : null,
    tokens_per_success_delivery: success_runs > 0 ? buckets.delivery.tokens / success_runs : null,
    overhead_share: share(buckets.overhead.tokens),
    blocked_share: share(buckets.blocked.tokens),
  };
}

/** 同 runId 的全部记录合成一笔账 (goal 一次两段图 = 一笔)。 */
function mergeRun(runId: string, recs: ParsedRow[]): RunReadout {
  const attempts = recs.length;
  const first_at = Math.min(...recs.map((r) => r.createdAt));
  const last_at = Math.max(...recs.map((r) => r.createdAt));

  // 状态: 任一条记了 success → success (一段成了就是成了); 一条都没记 → 未记 (没记 ≠ failure);
  // 否则取最后一条记录的终止原因 (那是这跑最终怎么结束的)。
  const withOutcome = recs.filter((r) => r.outcome !== null);
  let status: RunOutcomeKind | '未记' = '未记';
  if (withOutcome.length > 0) {
    if (withOutcome.some((r) => r.outcome === 'success')) status = 'success';
    else {
      const last = withOutcome[withOutcome.length - 1]!.outcome!;
      status = (OUTCOME_KINDS.has(last) ? last : 'unclassified') as RunOutcomeKind;
    }
  }

  // usage: 五字段各自独立求和; 整组都没记 → null (有 ≥1 条记了 0 → 求和可为 0, 不转 null)。
  let usage_unmeasured_attempts = 0;
  let anyMeasured = false;
  const usage = { conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 };
  for (const r of recs) {
    if (r.usage === null) {
      usage_unmeasured_attempts++;
      continue;
    }
    anyMeasured = true;
    usage.conductorIn += r.usage.conductorIn;
    usage.conductorOut += r.usage.conductorOut;
    usage.leavesIn += r.usage.leavesIn;
    usage.leavesOut += r.usage.leavesOut;
    usage.leavesCacheHit += r.usage.leavesCacheHit;
  }

  // reused: 记了的值求和 (0 保持 0, 两段 0+1=1); 整组都没记 → null。
  let reused: number | null = null;
  for (const r of recs) if (r.reused !== null) reused = (reused ?? 0) + r.reused;

  return {
    run_id: runId,
    attempts,
    first_at,
    last_at,
    status,
    usage: anyMeasured ? usage : null,
    usage_unmeasured_attempts,
    reused,
    entry: recs.find((r) => r.entry !== null)?.entry ?? '未记',
    criteria: recs.find((r) => r.criteria !== null)?.criteria ?? null,
    acceptanceProbe: recs.find((r) => r.acceptanceProbe !== null)?.acceptanceProbe ?? null,
    // #209: 一次 solve 两条记录同值 (契约段靠回填, 执行段靠 meta); 都没记 → null。
    specWrite: recs.find((r) => r.specWrite !== null)?.specWrite ?? null,
  };
}

/** 契约读数的人类可读版 (CLI 用; 测试只认 JSON 形状)。 */
function printReadoutHuman(r: ReadoutResult, dbPath: string): void {
  console.log(`\n⑫ 统一契约读数 (${dbPath} · runId 归并 · NULL≠0 · criteria 四格 + 两风险格)`);
  if (r.runs.length === 0) {
    console.log('   空世界: 一条记录都没有 —— 合法空态, 不是错误。');
    return;
  }
  // 统计口径标注 (审查 F3): 一份报告两个宇宙, 不标读者会以为同一窗口 —— 节点统计是全量,
  // run 统计是窗口 (最早 limit 个, 按 first_at; 冻结契约钉死的截断端, 不许两头都读成"最近")。
  console.log(`   统计口径: 节点统计 (四格/风险格/复用率) = 全量记录; **本段**的 run 统计 (分布/判据/entry) = 窗口 (最早 ${r.meta.limit} 个 run, 按 first_at) 且按 runId 归并。`);
  // ⚠ 「**本段**」这两个字是 2026-08-06 补的, 补的是一次真误导: 这句话原本读起来像是在替
  //   整份报告作口径声明, 而 ⑨ 段同样是 run 级分布、同样带判据, 却**既不归并也不截窗**
  //   (全量留痕记录)。于是同一页上两个 `outcome` 数差了 2.8 倍而没有一处说明白。
  console.log('   ⚠ ⑨ 段的 outcome 分布**口径不同**(全量留痕记录, 不归并)—— 两处的数**不可比**, 各自标了口径。');
  console.log('   run                 attempts   first_at→last_at        status           entry         reused');
  for (const run of r.runs) {
    console.log(
      `   ${run.run_id.padEnd(19)} ${String(run.attempts).padStart(4)}   ${String(run.first_at).padStart(8)} → ${String(run.last_at).padStart(8)}   ${run.status.padEnd(15)} ${run.entry.padEnd(9)} ${run.reused === null ? '未记' : String(run.reused)}`,
    );
  }
  const oc = r.outcome_distribution;
  const recordedKinds = RUN_OUTCOME_ORDER.filter((k) => oc[k] > 0).map((k) => `${k}=${oc[k]}`);
  console.log(`   outcome: ${recordedKinds.join(' · ')}${recordedKinds.length ? ' · ' : ''}未记=${oc['未记']}  (total ${oc.total})`);
  console.log(`   entry:   ${r.entry_distribution.map((e) => `${e.entry} ${e.runs}run/${e.attempts}attempts`).join(' · ')}`);
  for (const cs of r.cost_per_success) {
    const spent = cs.tokens.conductorIn + cs.tokens.conductorOut + cs.tokens.leavesIn + cs.tokens.leavesOut;
    console.log(
      `   cost/success[${cs.entry}]: ${cs.success_runs}/${cs.runs} success · 已记 tokens ${spent}` +
        `${cs.unmeasured_runs > 0 ? ` (另 ${cs.unmeasured_runs} run 没记 usage, 不在和里)` : ''}` +
        ` · 每 success ${cs.tokens_per_success === null ? '算不出 (0 success)' : Math.round(cs.tokens_per_success).toString()}`,
    );
  }
  const aa = r.attention_axis;
  const n = (x: number | null): string => (x === null ? '没数据' : String(x)); // 三种成因合一, 见 attention_axis 注
  console.log(
    `   注意力轴: 踢回 owner ${aa.blocked_runs}/${aa.total_runs} 跑 (${aa.handback_rate === null ? '算不出' : `${(aa.handback_rate * 100).toFixed(1)}%`})` +
      ` · 票: 待确认 ${n(aa.pending_tickets)} / 已处置 ${n(aa.decided_tickets)} / 其中拒 ${n(aa.rejected_tickets)}` +
      ` (白看 ${aa.wasted_review_share === null ? '算不出' : `${(aa.wasted_review_share * 100).toFixed(1)}%`})`,
  );
  console.log('             ⚠ 「到达 owner 的重复提问」这一格**没有数据源** —— deduped 量的是被机器挡下的那些。');
  const sd = r.spend_discipline;
  const pct = (x: number | null): string => (x === null ? '算不出' : `${(x * 100).toFixed(1)}%`);
  const per = (x: number | null): string => (x === null ? '算不出 (0 success)' : Math.round(x).toString());
  console.log(
    `   消耗口径: ${(['delivery', 'blocked', 'overhead', 'unclassified', '未记'] as const)
      .map((k) => `${k} ${sd.buckets[k].runs}run/${sd.buckets[k].tokens}tok${sd.buckets[k].unmeasured_runs > 0 ? `(+${sd.buckets[k].unmeasured_runs}没记)` : ''}`)
      .join(' · ')}`,
  );
  console.log(
    `             每 success: 老口径(全部) ${per(sd.tokens_per_success_all)} → 新口径(只 delivery) ${per(sd.tokens_per_success_delivery)}` +
      ` · overhead 占 ${pct(sd.overhead_share)} · blocked 占 ${pct(sd.blocked_share)}`,
  );
  const g = r.criteria_grid.four_grid;
  console.log(`   四格:   executed_success ${g.executed_success} · executed_failure ${g.executed_failure} · reused_success ${g.reused_success} · 未记 ${g['未记']} (= ${g.executed_success + g.executed_failure + g.reused_success + g['未记']})`);
  // ⚠ 与 ⑦ 段那个"没过的节点数"**不是同一个数**(2026-08-06 对账时发现, 此前谁都没说):
  //   ⑦ 按**节点实例**数 —— 同一个节点在两条记录里各失败一次 = 2;
  //   这里按**去重的节点 id** 数, 且判据是「**有没有成功过**」—— 先失败后成功的算 success。
  //   两个都对, 答的不是同一个问题, 而只看数字会以为哪边算漏了 (⑨/⑫ 那个形状的第五次)。
  console.log('   ⚠ `executed_failure` 与 ⑦ 段那个"没过的节点"**不可比**: 这里是**去重 id** 且判「有没有成功过」,');
  console.log('     ⑦ 是**节点实例**计数(同一节点失败两次算两次)。先失败后成功的节点在这里进 success、在 ⑦ 里仍留一笔。')
  console.log(`   风险格: ${r.criteria_grid.two_grid_risk.map((t) => `${t.risk_level} ${t.executed}/${t.not_executed}`).join(' · ')}`);
  const c = r.criteria_consistency;
  console.log(`   criteria: agree ${c.agree} · oracleFailed ${c.oracleFailed} · wastedRounds ${c.wastedRounds} · agreeFail ${c.agreeFail} · recorded ${c.recorded} · unrecorded ${c.unrecorded}`);
  const gd = r.gate_denominators;
  console.log(
    `   闸分母 (全量, **不受上面那张表的窗口截断**): G3 live run ${gd.g3LiveRuns}/20 · G4 采样 ${gd.g4Samples}/10 · ` +
      `跑了但没记上 ${
        gd.ledgerGap === null
          ? '不知道 (注册表读不到)'
          : `${gd.ledgerGap.done} 条 done 无留痕 (另有 ${gd.ledgerGap.total - gd.ledgerGap.done} 条未跑到留痕就终止, 属合法缺席)`
      }`,
  );
  const g4 = r.g4_sampling;
  console.log(
    `   G4 采样 (分母 = entry 为 solve 且 acceptance_probe 非 NULL 的 run, 共 ${g4.denominator} 个): ` +
      `passed-both ${g4.passedBoth} · vacuity-only ${g4.vacuityOnly} · demoted ${g4.demoted} · skipped ${g4.skipped} · exploratory ${g4.exploratory}` +
      (g4.denominator === 0 ? '  (这批没有探针记录 —— 老数据或还没接 acceptance_probe)' : '  (exploratory = demoted + skipped + exploratory)'),
  );
  const sa = r.suggestion_acceptance;
  if (sa !== null) {
    // S-1 片d: 接受率是「要不要全自动」的判据 (交接 18 S-1 立项理由); deduped 单列不进分母。
    console.log(
      `   建议接受率: ${sa.accepted + sa.edited}/${sa.decided} (accepted ${sa.accepted} · edited ${sa.edited} · rejected ${sa.rejected})` +
        `${sa.rate === null ? '' : ` = ${(sa.rate * 100).toFixed(0)}%`} · 待确认 ${sa.pending}` +
        ` · 重复率 ${sa.deduped}/${sa.deduped + sa.decided + sa.pending}${sa.dedupe_rate === null ? '' : ` = ${(sa.dedupe_rate * 100).toFixed(0)}%`} (机器去重扣住的车轱辘话)`,
    );
  }
  const rr = r.reuse_rate;
  console.log(
    `   复用率: ${rr.reused_nodes}/${rr.total_nodes} 节点${rr.rate === null ? ' (分母 0, **算不出**)' : ` = ${(rr.rate * 100).toFixed(1)}%`}` +
      `${rr.unknownRuns > 0 ? `  ⚠ 另有 ${rr.unknownRuns} 跑**算不出**(声明了复用而节点面没记, 老行)—— **不进分母**` : ''}`,
  );
  if (rr.unknownRuns > 0) {
    // ⚠ 2026-08-06 之前这一格是**假零**: 旧实现按"节点在 plan 里但不在结果里"推复用,
    //   而复用节点**就在结果里** → 推断恒返空集 → 印出 0.0%, 读起来像"复用根本没在工作",
    //   而 ⑩ 段按 run 级计数算的是 21.9%。同一页两个数, 且 0 那个是错的。
    console.log('     ⚠ 与 ⑩ 段那个「复用率」**不是同一个数**: 那边按 run 自报的 `reused` 计数算(口径粗但覆盖老行),');
    console.log('       这边按**节点面**算(准, 但只覆盖 2026-08-06 之后的记录)。老行在这边算不出, 别读成 0。');
  }
}
/** ⑭-⑰ 四新段的渲染 (CLI main 尾部调用; 计算全在 readout(), 这里只印 —— 两处各算一份必漂)。 */
function printNewSegments(r: ReadoutResult, dbPath: string): void {
  const pt = r.pipeline_tax;
  console.log(`\n⑭ 管线税 (solve 路 contract 段 vs execute 段 —— G-3 直通判卷的 before/after 对照板)`);
  console.log(`   ## 为什么单开一段: 直通入口 merge 的判卷 (SDD G-3: 直通侧 pre-execute ≤ 全程侧 10%) 要一张**只按 entry 隔离、再按 run_id 归并**的两段对照账。①/⑩ 的账把两段图加成一笔, 恰好把要量的东西抹掉了 —— 那是"全程多少钱", 这里要的是"contract 那一段占多少"。`);
  console.log(`   全量口径 (不受展示窗口截断) · solve run ${pt.solveRuns} · 两段都记了 usage ${pt.bothMeasuredRuns} · 缺账 ${pt.unmeasuredRuns} (不在分母里)`);
  console.log(`   contract 占已记 token: ${pt.contractShare === null ? '算不出 (分母 0)' : `${(pt.contractShare * 100).toFixed(1)}%`} (${pt.contractTokens}/${pt.totalTokens}, cacheHit 不进分子)`);
  console.log(`   verifier 打回 ${pt.rejections} · 记了读不出 ${pt.verifUnparsed} · 老行没记 ${pt.verifUnrecorded} (没记 ≠ 没打回)`);
  if (pt.unknownPlans.length > 0) console.log(`   ⚠ 段归属词表外的 plan_name: ${pt.unknownPlans.map((u) => `${u.plan}×${u.rows}`).join(' · ')} (直通 merge 改图名会照在这里)`);
  if (pt.replans.length === 0) console.log(`   重规划 0 次`);
  else {
    console.log(`   重规划 ${pt.replans.length} 次 (usage 增量, 任一侧没记 → —):`);
    for (const rp of pt.replans) {
      const d = rp.deltas;
      console.log(`     ${rp.runId}: +${d.conductorIn ?? '—'}cIn / +${d.conductorOut ?? '—'}cOut / +${d.leavesIn ?? '—'}lIn / +${d.leavesOut ?? '—'}lOut / +${d.leavesCacheHit ?? '—'}lHit`);
    }
  }

  const sh = r.seat_health;
  console.log(`\n⑮ 座位健康 (per-node model vs 座位配置 —— kimi-coding 兜底是 issue #6 复发哨)`);
  console.log(`   ## 为什么单开一段: ⑩ 的效率轴只拿 model 去**定价**, 从不问"这个节点坐的座位对不对"。座位修复 (2026-08-10) 落地后, 复发哨必须长在读数板上而不是日志里 —— 日志没人盯, 板有人看。`);
  if (Object.keys(sh.seatsRef).length > 0) console.log(`   座位参照 (读数时刻): ${Object.entries(sh.seatsRef).map(([s, m]) => `${s}=${m}`).join(' · ')}`);
  else console.log(`   ⚠ 未给座位参照 → 偏离/兜底哨算不出 (null, 不编 0)`);
  console.log(`   ⚠ 参照是**读数时刻**的解析结果 —— 座位配置没有按 run 时点落账, run 时点 ≠ 读数时点时这段会把"后来改过配置"读成"当时偏离" (诚实边界同款)。`);
  console.log(`   偏离 ${sh.deviations === null ? '算不出' : String(sh.deviations.length)} · kimi-coding 兜底 ${sh.kimiFallbackEvents === null ? '算不出' : String(sh.kimiFallbackEvents)} (issue #6 复发哨 · 修后应为 0) · 无 model 老节点 ${sh.noModelNodes} · 坏 JSON 行 ${sh.badNodesRows} (不在下面任何数里)`);
  const um = Object.entries(sh.unmappedKinds);
  console.log(`   无座位映射 kind: ${um.length === 0 ? '—' : um.map(([k, v]) => `${k}×${v}`).join(' · ')} (不编期望不算偏离)`);
  if (sh.deviations !== null && sh.deviations.length > 0) {
    for (const d of sh.deviations.slice(0, 10)) console.log(`     ${d.runId} ${d.nodeId} [${d.kind}] ${d.model} ≠ 期望 ${d.expected}`);
    if (sh.deviations.length > 10) console.log(`     …另 ${sh.deviations.length - 10} 条`);
  }
  console.log(`   按 model: ${sh.byModel.map((m) => `${m.model}×${m.nodes}节点`).join(' · ') || '—'} · usage 只按单模型 run 聚合: ${sh.usageByModel.map((m) => `${m.model} ${m.runs}run/${m.tokens}tok`).join(' · ') || '—'} · 混合座位 run ${sh.mixedRuns} (不摊账)`);

  const mp = r.mcp_policy;
  console.log(`\n⑯ MCP policy (.omd/mcp-calls.db · 七态分列不合并)`);
  console.log(`   ## 为什么单开一段: 它在**另一个库**里 (mcp-calls.db, 与 dag-runs.db 不同文件不同寿命)。七态里 ok 与三种 rejected 的下一步互不相同 (policy 闸太紧 / 调用方没 find / 名字解析坏), 合并成一个 "非 ok" 正是本仓反复付账的那个动作。`);
  if (mp === null) {
    console.log(`   无账 (${join(dirname(dbPath), 'mcp-calls.db')} 不存在或没有 calls 表 —— 一次 MCP 调用都没记过, 不是零行)`);
  } else {
    console.log(`   七态: ${(['ok', 'error', 'rejected-unfetched', 'rejected-args', 'rejected-policy', 'unknown-tool', 'connect-error'] as const).map((s) => `${s}=${mp.byStatus[s]}`).join(' · ')} (total ${mp.total})`);
    if (mp.unknownStatus.length > 0) console.log(`   ⚠ 词表外 status: ${mp.unknownStatus.map((u) => `${u.status}×${u.n}`).join(' · ')} (schema 漂移, 不并入任何一格)`);
    if (mp.byServer.length > 0) console.log(`   按 server: ${mp.byServer.map((s) => `${s.server} ${s.total} (${Object.entries(s.byStatus).map(([st, v]) => `${st}=${v}`).join(' ')})`).join(' · ')}`);
  }

  const ct = r.cache_trend;
  console.log(`\n⑰ cache 趋势 (leavesCacheHit/leavesIn · 记录级时序 · 最近 20 行)`);
  console.log(`   ## 为什么单开一段: ①/⑩ 的 cacheRate 是**窗口均值**, 趋势 (在涨还是在塌) 在均值里不可见。这一段是**记录级时序** —— 口径与 ① 段 run 级不同, 头注标出, 两处的数不可比。`);
  console.log(`   ⚠ 窗口取 created_at 升序的**最近** 20 行, 与 ⑫ 的展示窗口 (最早 limit 个) 方向相反 —— 不是同一切片。`);
  console.log(`   created_at       run_id                   leavesIn   hit   rate`);
  for (const row of ct.rows) {
    console.log(`   ${String(row.createdAt).padEnd(16)} ${String(row.runId ?? '—').padEnd(21)} ${row.leavesIn === null ? '—'.padEnd(9) : String(row.leavesIn).padEnd(9)} ${row.leavesCacheHit === null ? '—'.padEnd(5) : String(row.leavesCacheHit).padEnd(5)} ${row.rate === null ? '—' : `${(row.rate * 100).toFixed(1)}%`}`);
  }
  if (ct.rows.length === 0) console.log(`   (无记录)`);
  console.log(`   leavesIn=0 的行 ${ct.zeroIn} (没跑过 leaf ≠ 0%) · usage 没记的行 ${ct.unmeasured} (标 —)`);

  const lp = r.loop_readout;
  const pct = (x: number | null): string => (x === null ? '算不出' : `${(x * 100).toFixed(1)}%`);
  const f2 = (x: number | null): string => (x === null ? '算不出' : x.toFixed(2));
  console.log(`\n⑲ 编排循环 (R-1 · loop 列非 NULL 的父行 + 同 run_id 的 conductor-* 子行)`);
  console.log(`   ## 为什么单开一段: P3 的判词 (M3 调用/题 < 50 · 终审 ≤ 1 次 · 回灌不该蒸发) 全长在循环路径上, 而 ①-⑱ 把父 run 与派发出的子 run 加成一笔账。这里按父行归并、按 conductor / worker 分开数; 每一格「缺席不可算」的数都印出来, 不省。`);
  if (lp.parents === 0) {
    console.log(`   无循环父行 (loop 列全 NULL —— 没走过编排循环, 或记录早于本列)`);
  } else {
    console.log(`   父 run ${lp.parents} · 子行 ${lp.childRows} · 派发/run ${f2(lp.dispatches.perRun)}`);
    console.log(`   LLM 调用: conductor ${lp.llmCalls.conductor} (${f2(lp.llmCalls.conductorPerRun)}/run, ${lp.llmCalls.unmeasuredConductorRuns} run 没记) · worker ${lp.llmCalls.worker} (${f2(lp.llmCalls.workerPerRun)}/run, ${lp.llmCalls.unmeasuredWorkerNodes} 节点没记)`);
    console.log(`   并行宽度 [${lp.width.join(',')}]${lp.widthStats ? ` min/中位/max ${lp.widthStats.min}/${lp.widthStats.median}/${lp.widthStats.max}` : ''} · 关键路径深度 [${lp.depth.join(',')}]${lp.depthStats ? ` min/中位/max ${lp.depthStats.min}/${lp.depthStats.median}/${lp.depthStats.max}` : ''}`);
    console.log(`   加速比: 中位 ${f2(lp.speedup.median)} (Σ子节点墙钟 / conductor 墙钟; 判词 > 1) · ${lp.speedup.unmeasurable} 个 run 因 durationMs 缺席不可算`);
    console.log(`   终审: 调用 ${lp.verifier.calls} (${f2(lp.verifier.perRun)}/run, 判词 ≤ 2) · 首判红 ${lp.verifier.firstFail} · 回灌 ${lp.verifier.reinjected}`);
    // 'unproven' 单列: 它是「放行但这次什么都没量到」, 并进 pass 会把闸的有效触发率读虚高。
    console.log(`   #205 判据方向性: 改动前红(量对了) ${lp.direction.redBefore} · **改动前就绿(量的不是本次目标)** ${lp.direction.greenBefore} · 没量到 ${lp.direction.inconclusive} · 没跑 ${lp.direction.absent}`);
    console.log(`   D-14 窄复审: 确认修好 ${lp.verifier.recheck.pass} · 未能确认(放行) ${lp.verifier.recheck.unproven} · 拿到反证判没修 ${lp.verifier.recheck.fail} · 判官调不通 ${lp.verifier.recheck.error} · 没触发 ${lp.verifier.recheck.skipped} · 上线前老记录 ${lp.verifier.recheck.unknown}`);
    console.log(`   回灌蒸发率: ${lp.evaporation.numerator}/${lp.evaporation.denominator} = ${pct(lp.evaporation.rate)} (回灌后零新派发且 oracle 绿; 老记录没分界线 ${lp.evaporation.unknown} 个不进分母)`);
    console.log(`   工具首次直达率: ${lp.cards.ok}/${lp.cards.calls} = ${pct(lp.cards.firstPassRate)} · zod 拒 ${lp.cards.rejectedSchema} · help ${lp.cards.help} · 编译拒 ${lp.cards.rejectedCompile} · 子 run 抛错 ${lp.cards.childRunError} · 只读 bash 拒 ${lp.cards.readOnlyShellBlocked} · 按卡 ${Object.entries(lp.cards.byCard).map(([k, v]) => `${k}×${v}`).join(' ') || '—'}`);
    console.log(`   brief 含复现输出 (启发式): ${lp.dispatches.briefTrue}/${lp.dispatches.briefTrue + lp.dispatches.briefFalse} = ${pct(lp.dispatches.briefReproRate)} · 无 brief 槽 ${lp.dispatches.briefNull}`);
    console.log(`   尾块缺席率: ${lp.trailer.missing}/${lp.trailer.agentNodes} = ${pct(lp.trailer.missingRate)} (agent 节点; 没记 selfReport ${lp.trailer.unrecorded}) · acceptance_ran 不一致 ${lp.acceptanceRanMismatch} · inconclusive bare ${lp.inconclusive.bare} / 非 bare ${lp.inconclusive.nonBare}`);
    console.log(`   conductor 常驻 prompt: max ${lp.residentPromptChars.max ?? '没记'} 字符 · >8000 ${lp.residentPromptChars.over8000} · 没记 ${lp.residentPromptChars.unrecorded} · 动手前 LLM 调用 Σ${lp.preActionLlmCalls.sum} (>1 的 run ${lp.preActionLlmCalls.over1}, 没记 ${lp.preActionLlmCalls.unrecorded})`);
    const dist = (m: Record<string, number>): string => Object.entries(m).map(([k, v]) => `${k}×${v}`).join(' ') || '—';
    console.log(`   leaf thinking (实际用的档, 按通道): pi ${dist(lp.thinking.pi)} · sdk ${dist(lp.thinking.sdk)} · 没报 ${lp.thinking.unreported} (agent 节点)`);
  }
}



interface Row {
  id: string;
  created_at: number;
  plan_name: string;
  node_count: number;
  run_id: string | null;
  nodes: string;
  usage: string;
  observations: string | null;
  outcome: string | null;
  /** 入口 (2026-08-06 起 ⑨ 段用它拆「blocked 了然后呢」)。老行 NULL = 没记。 */
  entry: string | null;
  verification: string | null;
  reused: number | null;
  criteria: string | null;
  claim_check: string | null;
}
interface Usage {
  conductorIn: number;
  conductorOut: number;
  leavesIn: number;
  leavesOut: number;
  leavesCacheHit: number;
}

/** 一次 goal 的账 = 同 runId 的全部记录求和 (goal 一次跑两段图, 各落一条)。 */
interface RunTotals {
  runId: string;
  createdAt: number;
  plans: string[];
  nodes: number;
  leavesIn: number;
  leavesOut: number;
  cacheHit: number;
  /** 缓存命中率 = leavesCacheHit / leavesIn。leavesIn=0 → null (没跑过 leaf, 不是 0%)。 */
  cacheRate: number | null;
  failed: number;
  /** 本次跑里出现过的模型坐标 (N9 定价的前提)。空集 = 这批记录没记坐标 (老数据)。 */
  models: Set<string>;
  /** 跨轮复用的节点数。null = 没记 (**不是** 0)。 */
  reused: number | null;
}

if (import.meta.main) {
  const flags = parseFlags(Bun.argv.slice(2));
  const dbPath = String(flags.db ?? '.omd/dag-runs.db');
  const limit = Number(flags.limit ?? 20);
  // 参数错 → exit 2 (契约 §2): 老 CLI 会把 NaN limit 直接喂给 SQLite 崩掉; 裸 --limit (无值) 会被
  // parseFlags 记成 true → Number(true)=1, 静默只读 1 个 run —— 同样是参数错, 拒掉 (审查 F6)。
  if (typeof flags.limit === 'boolean' || !Number.isInteger(limit) || limit <= 0) {
    console.error(`--limit 需正整数, 收到 ${String(flags.limit)}`);
    process.exit(2);
  }

  // --factor 同 --limit: 裸 --factor (无值) → parseFlags 记成 true → Number(true)=1, 静默把异常
  // 阈值压到中位数 1 倍 —— 参数错, exit 2 (审查 F6)。提前到开库前校验: 空表早退 (exit 0) 不能把它掩掉。
  const ANOMALY_FACTOR = Number(flags.factor ?? 3);
  if (typeof flags.factor === 'boolean' || !Number.isFinite(ANOMALY_FACTOR) || ANOMALY_FACTOR <= 0) {
    console.error(`--factor 需正数, 收到 ${String(flags.factor)}`);
    process.exit(2);
  }

  let db: Database;
  let hasTable = false;
  try {
    db = new Database(dbPath, { readonly: true });
    // 只读会话加固 (契约 §1): 打开即 readonly, 再钉 query_only —— 不经过任何建表/迁移/写 pragma 的路径。
    db.run('PRAGMA query_only = ON');
    // bun:sqlite 是懒打开: 文件在但**不是 sqlite** (截断/文本文件) 时 open 不报, 首个查询才炸。
    // 契约 §退出码: DB 不可读 = 3 —— 不许未捕获异常把退出码砸成 1 (审查 F2)。
    hasTable = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'omd_dag_runs'`).get() != null;
  } catch (e) {
    console.error(`读不到留痕库 ${dbPath} — ${(e as Error).message}`);
    console.error('（还没跑过带 runId 的 dag_run / dag_goal 就是空的，这不是错误。）');
    process.exit(3);
  }
  // ⑯ 第二库 + ⑮ 座位参照: 注入 readout (保持纯函数, readout 不自读 env/文件)。
  // mcp-calls.db 不存在/打不开 → 不注入 → 段⑯ 印「无账」(读不到 ≠ 零行, 同 countLedgerGap 那条纪律)。
  // 座位解析失败 (未配) → 不注入 → 段⑮ 的偏离/兜底哨按「算不出」报 (null, 不编 0)。
  const mcpDbPath = join(dirname(dbPath), 'mcp-calls.db');
  let mcpDb: Database | undefined;
  if (existsSync(mcpDbPath)) {
    try {
      mcpDb = new Database(mcpDbPath, { readonly: true });
      mcpDb.run('PRAGMA query_only = ON');
    } catch {
      mcpDb = undefined; // 打不开 = 无账
    }
  }
  let seats: Record<string, string> | undefined;
  try {
    seats = { conductor: resolveRoleModel('conductor'), leaf: resolveRoleModel('leaf') };
  } catch {
    seats = undefined; // 座位没配全 → 参照整表缺席
  }

  // 表不存在 = 一笔记录都没有 (合法空态, 契约要求 exit 0; 老 CLI 会在这里 SELECT 崩掉)。
  if (!hasTable) {
    const contract = readout({ db, limit, dbPath, mapsCwd: process.cwd(), mcpDb, seats });
    if (flags.json) console.log(JSON.stringify({ dbPath, readout: contract }, null, 2));
    else {
      console.log(`留痕库 ${dbPath} 里还没有 omd_dag_runs 表 —— 一次记录都没有 (合法空态, exit 0)。`);
      printReadoutHuman(contract, dbPath);
      printNewSegments(contract, dbPath);
    }
    db.close();
    process.exit(0);
  }
  const contract = readout({ db, limit, dbPath, mapsCwd: process.cwd(), mcpDb, seats });

  // 老库没有 observations / outcome 列 → 整条 SELECT 会崩。列在不在是**运行期事实**, 查一次 pragma
  // 再拼 (缺的那列补 NULL —— 正是"这批记录没记"那一格, 与"记了但是空的"分开数)。
  // ⚠ **`run_id` 同理** (2026-08-06 修, 与 readout() 里那条同源): 它也是后加的列,
  //   而此前躺在必选那一半 —— 于是一个 recorder 认得、会自动迁移的老库在只读的读数板上直接崩。
  const haveCols = (db.query(`PRAGMA table_info(omd_dag_runs)`).all() as { name: string }[]).map((c) => c.name);
  const optionalCol = (name: string) => (haveCols.includes(name) ? `, ${name}` : `, NULL AS ${name}`);
  const rows = db
    .query(
      `SELECT id, created_at, plan_name, node_count, nodes, usage${optionalCol('run_id')}${optionalCol('observations')}${optionalCol('outcome')}${optionalCol('entry')}${optionalCol('verification')}${optionalCol('reused')}${optionalCol('criteria')}` +
        ` FROM omd_dag_runs ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit * 3) as Row[]; // ×3: 一次 goal 最多两条, 留余量再按 runId 截

  if (rows.length === 0 && !flags.json) {
    console.log(`留痕库 ${dbPath} 里一条记录都没有。`);
    printReadoutHuman(contract, dbPath);
    printNewSegments(contract, dbPath);
    process.exit(0);
  }

  // ── ① 每次运行的账 (按 runId 归组) ───────────────────────────────────────────
  const byRun = new Map<string, RunTotals>();
  // runId 为 null 的老行 / 图外调用: 各自成组, 用主键当键 —— 归到同一个 "null" 组会把无关的运行
  // 加在一起, 那是**编出来的**一笔账, 比缺这笔账坏。
  for (const r of rows) {
    const key = r.run_id ?? `(no-runid):${r.id}`;
    const u = JSON.parse(r.usage) as Usage;
    const nodes = JSON.parse(r.nodes) as DagRunNode[];
    const cur = byRun.get(key) ?? {
      runId: key,
      createdAt: r.created_at,
      plans: [],
      nodes: 0,
      leavesIn: 0,
      leavesOut: 0,
      cacheHit: 0,
      cacheRate: null,
      failed: 0,
      models: new Set<string>(),
      reused: null,
    };
    cur.plans.push(r.plan_name);
    cur.nodes += r.node_count;
    cur.leavesIn += u.leavesIn;
    cur.leavesOut += u.leavesOut;
    cur.cacheHit += u.leavesCacheHit;
    cur.failed += nodes.filter((n) => n.status === 'failed').length;
    for (const n of nodes) if (n.model) cur.models.add(n.model);
    // goal 一次两段图各落一条 → 两条的复用数相加; 全都没记才是 null。
    if (r.reused !== null) cur.reused = (cur.reused ?? 0) + r.reused;
    cur.createdAt = Math.max(cur.createdAt, r.created_at);
    byRun.set(key, cur);
  }
  const runs = [...byRun.values()]
    .map((r) => ({ ...r, cacheRate: r.leavesIn > 0 ? r.cacheHit / r.leavesIn : null }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  // ── ② 命令风险级分布 (R1 · 只报不拦) ──────────────────────────────────────────
  const tierCount: Record<CommandRiskTier, number> = { read_only: 0, scoped_write: 0, approval_required: 0, never: 0 };
  const tierSamples = new Map<CommandRiskTier, Set<string>>();
  let commandNodes = 0;
  /** `never` 里**被闸正确拒掉**的那部分(节点非 done)—— 它不是缺陷, 是闸在干活。 */
  let neverButBlocked = 0;
  /** **闸拒次数** (G5 建议 A 的最小实现): 书 §4.4 里这才是 BLOCKED 的教科书触发条件, 而我们今天
   *  把它降格成"节点 failed"。先把它数出来 —— 「连续几轮找不到合法命令」那个 K 才有依据可定。 */
  let gateRejections = 0;
  let neverAndRan = 0;
  let neverUnknown = 0;
  for (const r of rows) {
    for (const n of JSON.parse(r.nodes) as DagRunNode[]) {
      if (!n.command) continue;
      commandNodes++;
      const tier = commandRiskTier(n.command);
      tierCount[tier]++;
      // ⚠ `never` 有**两种成因, 后果完全相反**(2026-07-31 第二次 live 撞出来的):
      //   ① 闸正确拒了它 (bin 不在白名单 → 节点 failed) —— 系统工作正常, **不该报警**
      //   ② bin 登记漏了却真跑成了 (节点 done) —— 分级表与白名单不同步, **该报警**
      // 第一版把两者合成一条"不同步"告警, 于是第一次真读数就报了一条假警, 会把人支去修一个
      // 不存在的问题。这正是 A5「sensor 措辞普查」要治的那类 —— 发现对不对之外, 还得问
      // "它的读者拿它做得了什么"。
      // ⚠ 2026-07-31 第四跑修: 「节点非 done」有**两种**成因, 后续动作相反 ——
      //   闸拒 (exitCode < 0): Harness 拒了这个操作, 再试也没用 (书 §4.4 的 BLOCKED 定义)
      //   普通失败 (exit ≠ want): 断言没成立, 再试一轮可能就好了 (STALLED)
      // 第一版拿 `status !== 'done'` 当"闸已拒"的判据, 于是把 `grep -qx "3000"` (无任何元字符,
      // 只是没匹配上) 标成了闸拒 —— **这是本轮第四次把两种成因合成一条**。判据换成 exitCode。
      const gateRejected = typeof n.exitCode === 'number' && n.exitCode < 0;
      // **三态直接数, 不用补集** —— 补集会把"不知道"算进某一侧, 而本文件已经为这条栽过两次
      // (第一次 writeCounts 缺席 vs [0,0]; 第二次这里)。三个计数器互不相减。
      if (tier === 'never') {
        if (n.status === 'done') neverAndRan++;        // 未登记的 bin **真跑成了** → 分级表与白名单不同步, 该修
        else if (gateRejected) neverButBlocked++;      // 闸正确拒了 → 系统在干活
        else neverUnknown++;                           // 老记录无 exitCode → **不知道**, 明说
      }
      // 三态标记, 缺 exitCode 的老记录用 `[未通过]` —— 不知道就说不知道, 别猜成闸拒。
      const mark = n.status === 'done' ? '' : gateRejected ? '[闸已拒] ' : typeof n.exitCode === 'number' ? `[失败 exit=${n.exitCode}] ` : '[未通过] ';
      const s = tierSamples.get(tier) ?? new Set<string>();
      if (s.size < 5) s.add(`${mark}${n.command.length > 60 ? `${n.command.slice(0, 57)}…` : n.command}`);
      tierSamples.set(tier, s);
      if (gateRejected) gateRejections++;
    }
  }

  // ── ④ 效果指标 (§8.5): 写调用里有多少是 no-op ────────────────────────────────
  // 这一段回答的是"要不要把它从**报**升成**判**": 若 no-op 写常年 0%, 那把它做成闸就是给一个
  // 不存在的问题加关卡; 若成规模, 那产物闸今天正放过一整类静默失败。
  // **缺席 ≠ [0,0]** —— 分开数, 否则"没记"会被读成"跑了但没写"。
  let writeNodes = 0; // 报了 writeCounts 的节点数
  let unreported = 0; // 该报而没报的 (agent 节点但无 writeCounts = 早于本次改动的记录)
  let totalWrites = 0;
  let totalNoop = 0;
  const noopNodes: { id: string; total: number; noop: number }[] = [];
  for (const r of rows) {
    for (const n of JSON.parse(r.nodes) as DagRunNode[]) {
      if (!n.writeCounts) {
        if (n.kind === 'agent') unreported++;
        continue;
      }
      writeNodes++;
      const [total, noop] = n.writeCounts;
      totalWrites += total;
      totalNoop += noop;
      if (total > 0 && noop === total) noopNodes.push({ id: n.id, total, noop });
    }
  }

  // ── ⑤ detector 标注率 (D-Q): conductor 在**真跑**上标了几个 ────────────────────
  // 此前这个数只有 `eval-detector-usage.ts` 量得到, 而它量的是**规划期 prompt 上标没标**。
  // "60% 天花板在生产上兑现成 0/N" 这句话此前每次都要人去读日志重数一遍。
  let conductorChildren = 0; // 内容寻址子节点 (id 含 '::') = conductor 展开出来的
  let detectorNodes = 0;
  for (const r of rows) {
    for (const n of JSON.parse(r.nodes) as DagRunNode[]) {
      if (!n.id.includes('::')) continue; // 只看子图里的点; 顶层节点不是 conductor 画的
      conductorChildren++;
      if (n.detector) detectorNodes++;
    }
  }

  // ── ⑥ 熔断 near-miss (§8.4 的键该不该改) ─────────────────────────────────────
  // 熔断的键是「命令 + 逐字相同的失败」。2026-07-31 live 显示 conductor 会把同一个断言重写一遍
  // (单引号换双引号) → 「同一条命令」凑不齐第二次。
  // 直觉改法「只看输出」是**错的**: `grep -q` 失败无输出, 所有静默失败会指纹成同一条。
  // 所以先量: **输出逐字相同、命令文本不同** 有多少组 —— 那才是改键能多抓到的population。
  // ⑥ 熔断 near-miss 的计算已挪进 readout() (契约 `breaker_key`) —— 两处各算一份必漂,
  // 而这一段恰恰是靠一次误算把结论读反了三个月的那一段。渲染只读契约, 不再自己数。

  // ── ⑦ 没过的成因分布 (P1 词表细化的**唯一证据面**) ───────────────────────────
  // 这一段回答的就是"细化值不值": 若所有失败常年只落在一两格里, 那这个词表是镀金;
  // 若它照出「闸拒 / 心跳停摆 / 产物闸判空」各占一块, 那此前那个 `failed` 一直在把
  // **三种后续动作相反**的东西混着报给同一个读者。
  //
  // **三态直接数, 不用补集** (本仓为这条纪律付过五次账):
  //   · 归了类的 → 各自计数
  //   · `unclassified` → 引擎里还有一条没交代自己的失败路径 (**缺陷**, 该去补标注)
  //   · 字段整个缺席 → 早于 2026-07-31 的记录 (**老数据**, 不是缺陷)
  // 后两者读上去都像"不知道", 但结论相反, 所以是两个计数器不是一个。
  const failureKindCount: Record<NodeFailureKind, number> = Object.fromEntries(
    FAILURE_KIND_ORDER.map((k) => [k, 0]),
  ) as Record<NodeFailureKind, number>;
  let notDoneNodes = 0;
  /** status≠done 但字段缺席 = 这批记录早于本次改动。**不是** unclassified。 */
  let failureKindUnrecorded = 0;
  const kindSamples = new Map<NodeFailureKind, Set<string>>();
  for (const r of rows) {
    for (const n of JSON.parse(r.nodes) as DagRunNode[]) {
      if (n.status === 'done') continue;
      notDoneNodes++;
      if (!n.failureKind) {
        failureKindUnrecorded++;
        continue;
      }
      // 老库里可能有本词表之外的字面量 (schema 会漂) → 不静默丢, 归 unclassified 并留样本。
      const kind = (n.failureKind in failureKindCount ? n.failureKind : 'unclassified') as NodeFailureKind;
      failureKindCount[kind]++;
      const s = kindSamples.get(kind) ?? new Set<string>();
      if (s.size < 3) s.add(n.id);
      kindSamples.set(kind, s);
    }
  }

  // ── ⑧ 图外观察者命中分布 (G5 正解「产物没变」定 K 用) ─────────────────────────
  // 这一段的用处是**具体的**: 「产物没变」检测器今天只报不拦, 要不要升成 BLOCKED、K 取几,
  // 取决于它在真跑上多久命中一次。不记就又要靠人去读日志重数一遍。
  // ⚠ 「这批记录没有 observations 列/字段」与「跑了但一条观察都没有」是两件事, 分开数。
  const obsCount = new Map<string, number>();
  let runsWithObs = 0; // 记了 observations 的记录数 (哪怕是空数组)
  let runsUnrecordedObs = 0; // 早于 2026-07-31 的记录: 这一位压根没记
  for (const r of rows) {
    if (r.observations === null) {
      runsUnrecordedObs++;
      continue;
    }
    runsWithObs++;
    for (const o of JSON.parse(r.observations) as { kind: string }[]) {
      obsCount.set(o.kind, (obsCount.get(o.kind) ?? 0) + 1);
    }
  }

  // ⑧.5 的聚合**在 readout() 里**(纯函数那一份), 这里只渲染 —— 两处各算一份必漂,
  // 而"读数板说 A、执行期说 B"比没有读数板更坏。
  const cc = contract.claim_check;

  // ── ⑨ run 级终止原因分布 (N5 · 五态在上层的证据面) ───────────────────────────
  // ⑦ 数的是**节点**为什么没过, 这一段数的是**整跑**怎么结束的 —— 两张表回答的不是同一个问题:
  // 一跑里九个节点全灭而成因各异, 在 ⑦ 里是九笔账, 在这里只有一笔 (`infra-error`), 而那一笔
  // 才是"这次 run 该怎么办"的答案。
  // 同 ⑦ 的三态数法: 归了类的各自计数 · `unclassified` 是缺陷 · 字段缺席是老数据 (两个计数器)。
  const outcomeCount: Record<RunOutcomeKind, number> = Object.fromEntries(
    RUN_OUTCOME_ORDER.map((k) => [k, 0]),
  ) as Record<RunOutcomeKind, number>;
  let runsUnrecordedOutcome = 0;
  const outcomeSamples = new Map<RunOutcomeKind, Set<string>>();
  for (const r of rows) {
    if (!r.outcome) {
      runsUnrecordedOutcome++;
      continue;
    }
    // 老库里可能有本词表之外的字面量 → 不静默丢, 归 unclassified 并留样本 (同 ⑦)。
    const kind = (r.outcome in outcomeCount ? r.outcome : 'unclassified') as RunOutcomeKind;
    outcomeCount[kind]++;
    const set = outcomeSamples.get(kind) ?? new Set<string>();
    if (set.size < 3) set.add(r.plan_name);
    outcomeSamples.set(kind, set);
  }
  const outcomeRecorded = rows.length - runsUnrecordedOutcome;

  // ── ⑩ 四轴试算 (N9 · score 维度在**便宜的板子上**先试) ────────────────────────
  // 为什么先在这儿试而不是直接往 Langfuse 推 score: 维度定错, 后面所有对比都建在错的坐标上,
  // 而这块板是确定性的、重跑不花钱。这一段的产出**不只是四个数**, 更是"哪条轴今天根本没有
  // 数据源" —— 那件事在推 score 之前知道, 比之后知道便宜得多。
  //
  // 四轴逐条的覆盖度各自报, 不合并成一个总分: 合并会让"这条轴没数据"被另一条轴的数掩盖。

  // 判据轴 —— 收敛判据(judge) 与 冻结判据(验收命令) **不一致**的那两格才是它的全部意义。
  //
  // ⚠ 这条轴**不能用 `outcome` 算** (2026-07-31 起飞前检查抓到的):
  //   ① `oracle-failed` 只活在 goal 级 (`RunGoalResult.outcome`), 而本表的 `outcome` 列是
  //      `deriveRunOutcome` 按**每张图**算的 —— `NODE_TO_RUN` 里没有任何成因映射到那一格,
  //      它在这张表里**永远不会出现**;
  //   ② 更要命的是反方向那格在**词表上就不存在**: goal 的 outcome 算式里 judge 为假就一律落
  //      `not-converged`, **不管冻结判据过没过**。两个布尔算完就被扔了。
  //   所以改用 `criteria` 两位布尔。它是 goal 级的 → **按 runId 去重再数**, 按行数会把一次 goal 数成两次。
  const critSeen = new Map<string, { judge: boolean; oracle: boolean }>();
  let critNoVerif = 0;
  for (const r of rows) {
    if (!r.run_id) continue;
    if (r.criteria === null) continue;
    critSeen.set(r.run_id, JSON.parse(r.criteria) as { judge: boolean; oracle: boolean });
  }
  // 分母 = 有 criteria 的 goal 次数; 没有的那些单独报 (不是 0, 是没记)。
  const critRuns = [...new Set(rows.map((r) => r.run_id).filter((x): x is string => !!x))];
  critNoVerif = critRuns.length - critSeen.size;
  let critAgree = 0;          // 两条判据都说成了
  let critOracleFailed = 0;   // judge 说成了, 冻结判据没过 —— 判据说了不算 (judge 太松)
  let critWastedRounds = 0;   // judge 说没成, 冻结判据却过了 —— 白转了几轮 (judge 太紧)
  let critAgreeFail = 0;      // 两条都说没成 (一致, 只是没成)
  for (const c of critSeen.values()) {
    if (c.judge && c.oracle) critAgree++;
    else if (c.judge && !c.oracle) critOracleFailed++;
    else if (!c.judge && c.oracle) critWastedRounds++;
    else critAgreeFail++;
  }
  const critRecorded = critSeen.size;

  // 效率轴 —— $ / cacheHit / 复用率 / 轮数。四格里今天只有前三格有数据源。
  // 定价口径诚实说明: 节点坐标记的是**叶子**的; conductor 自己不是节点, 它的坐标没记 ——
  // 所以这里算的是「叶子那部分的钱」, 不是整跑的钱。混合座位 (一次跑里多个坐标) 不定价,
  // 因为 usage 是聚合的、分不到各坐标头上 —— 硬按其中一个算等于**编一笔账**。
  let pricedRuns = 0;
  let mixedSeatRuns = 0;
  let noCoordRuns = 0;
  let leafUsd = 0;
  let unpricedCoordRuns = 0;
  for (const r of runs) {
    if (r.models.size === 0) { noCoordRuns++; continue; }
    if (r.models.size > 1) { mixedSeatRuns++; continue; }
    const coord = [...r.models][0]!;
    const c = computeCost({ in: r.leavesIn, out: r.leavesOut, cacheHit: r.cacheHit }, coord);
    if (c.unpriced) { unpricedCoordRuns++; continue; }
    pricedRuns++;
    leafUsd += c.costUsd ?? 0; // 订阅通道 → 0 USD 计入合计
  }
  const reuseRuns = runs.filter((r) => r.reused !== null);
  const reusedTotal = reuseRuns.reduce((a, r) => a + (r.reused ?? 0), 0);
  const reuseNodeBase = reuseRuns.reduce((a, r) => a + r.nodes, 0);

  // 诚实轴 —— 引擎有没有在**报告自己做砸了/不知道**。两个率都是"越低越好"但成因不同:
  // empty-artifact 高 = 节点谎报完工被产物闸抓住; unclassified 高 = 归因面自己有洞。
  const emptyArtifact = failureKindCount['empty-artifact'] ?? 0;
  const nodeUnclassified = failureKindCount.unclassified ?? 0;
  const runUnclassified = outcomeCount.unclassified;

  // 停止轴 —— 「blocked 与 not-converged 分不分得开」就是 G5 的后半句。
  // 分得开的判据不是"两个数都非零"那么松: 只要有一格恒为 0, 这个区分在生产上就没兑现。
  const stopBlocked = outcomeCount.blocked;
  const stopNotConverged = outcomeCount['not-converged'];
  const stopSeparable = stopBlocked > 0 && stopNotConverged > 0;

  // ── ⑪ 内环 journal (N9 第二处数据源) ─────────────────────────────────────────
  // 轮数与「凭什么停的」**只活在 continuity 的 journal 里** —— 留痕库存的是每张图跑完的结果,
  // 环转了几轮、停在哪一格, 那张表一个字都没有。所以这块板从"读一张表"变成"读两处"。
  //
  // ⚠ 两处的生命周期**不一样长**: 留痕库是永久的, journal 跟着 `.omd/continuity/<runId>/` 走,
  //   清理掉就没了。于是「这一跑没有内环数据」有三种成因, 后续动作不同, 分开数:
  //     ① 这次跑压根没有带内环的节点 (最常见, 不是缺陷)
  //     ② 有 journal 但没有 `stop` 字段 —— 早于 N6 的记录 (老数据)
  //     ③ journal 目录被清了 / 换了机器 —— 观测边界够不着 (Unobserved, 不是 Missing)
  //   ②③ 从这块板上分不开 (都表现为"读不到"), 所以合成一格并**如实说它是合的**, 不假装分得清。
  const cm = new CheckpointManager(String(flags.repo ?? process.cwd()));
  const loopStopCount = new Map<string, number>();
  const loopStopSamples = new Map<string, { evidence: string; atRound: number }>();
  let loopJournals = 0;
  let loopJournalsNoStop = 0;
  let runsWithLoop = 0;
  let runsNoLoopData = 0;
  let roundsTotal = 0;
  /** ⑧.1 那格**可回溯**的原料 —— 见 summarizeLoopRounds。 */
  const allJournals: NodeLoopJournal[] = [];
  for (const r of runs) {
    if (r.runId.startsWith('(no-runid):')) { runsNoLoopData++; continue; }
    const js: NodeLoopJournal[] = cm.listNodeLoopJournals(r.runId);
    if (js.length === 0) { runsNoLoopData++; continue; }
    runsWithLoop++;
    for (const j of js) {
      loopJournals++;
      roundsTotal += j.completedRounds ?? 0;
      allJournals.push(j);
      if (!j.stop) { loopJournalsNoStop++; continue; }
      loopStopCount.set(j.stop.kind, (loopStopCount.get(j.stop.kind) ?? 0) + 1);
      if (!loopStopSamples.has(j.stop.kind)) {
        loopStopSamples.set(j.stop.kind, { evidence: j.stop.evidence, atRound: j.stop.atRound });
      }
    }
  }
  const loopStopRecorded = loopJournals - loopJournalsNoStop;

  // ── ③ 单轮成本异常 (§8.6): 偏离历史中位数 N 倍 ────────────────────────────────
  // 用中位数而非均值: 一次异常本身会把均值抬起来, 于是"异常"检测不出下一次异常。
  // ANOMALY_FACTOR 的解析与参数校验在 main 开头 (与 --limit 同处, exit 2 契约) —— 空表早退不能把它掩掉。
  const leafIns = runs.map((r) => r.leavesIn).filter((n) => n > 0).sort((a, b) => a - b);
  const median = leafIns.length ? leafIns[Math.floor(leafIns.length / 2)]! : 0;
  const anomalies = median > 0 ? runs.filter((r) => r.leavesIn > median * ANOMALY_FACTOR) : [];

  if (flags.json) {
    console.log(
      JSON.stringify(
        { dbPath, readout: contract,
          statWindows: '节点统计 (four_grid/风险格/复用率) = 全量记录; run 统计 (分布/判据/entry) = 窗口 (最早 limit 个 run, 按 first_at)',
          runs, tierCount, neverButBlocked, neverAndRan, neverUnknown, gateRejections, commandNodes, conductorChildren, detectorNodes,
          breakerKey: contract.breaker_key, writeNodes, unreported, totalWrites, totalNoop, noopNodes, median, anomalyFactor: ANOMALY_FACTOR, anomalies,
          notDoneNodes, failureKindCount, failureKindUnrecorded,
          observations: Object.fromEntries(obsCount), runsWithObs, runsUnrecordedObs,
          claimCheck: cc, artifactMove: contract.artifact_move, writeRace: contract.write_race,
          outcomeCount, runsUnrecordedOutcome, outcomeRecorded,
          axes: {
            criteria: { agree: critAgree, oracleFailed: critOracleFailed, wastedRounds: critWastedRounds, agreeFail: critAgreeFail, unrecorded: critNoVerif, recorded: critRecorded },
            efficiency: { pricedRuns, mixedSeatRuns, noCoordRuns, unpricedCoordRuns, leafUsd, reusedTotal, reuseNodeBase, reuseRuns: reuseRuns.length },
            honesty: { emptyArtifact, nodeUnclassified, runUnclassified, notDoneNodes },
            stop: { blocked: stopBlocked, notConverged: stopNotConverged, separable: stopSeparable,
              innerLoop: { journals: loopJournals, withoutStop: loopJournalsNoStop, byKind: Object.fromEntries(loopStopCount), runsWithLoop, runsNoLoopData, roundsTotal } },
          } },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  // ── 输出 ──────────────────────────────────────────────────────────────────────
  const pct = (n: number | null) => (n === null ? '  —  ' : `${(n * 100).toFixed(1)}%`);
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  console.log(`\n═══ omd 读数板 · ${dbPath} · 最近 ${runs.length} 次运行 ═══\n`);

  // ── ⓪ 先看这里 (2026-08-06) ──────────────────────────────────────────────────
  // 分桶判据抽在 `summarizeFaces` 上 (纯函数, 有闸) —— 渲染只负责印。
  {
    const { ready, waiting } = summarizeFaces(contract);
    console.log('⓪ 先看这里 —— 今天哪几格能下结论 (其余的在等数据, 不必逐段翻)');
    console.log(`   ✅ **能下结论** (${ready.length})`);
    for (const l of ready) console.log(`      ${l}`);
    if (ready.length === 0) console.log('      (一格都没有 —— 那本身是读数: 这块板还没攒到能说话的地步)');
    console.log(`   ⏳ **在等数据** (${waiting.length}) —— 门槛的理由见 LOOP_NO_MOVE_MIN_N / CLAIM_CHECK_MIN_NODES`);
    for (const l of waiting) console.log(`      ${l}`);
    console.log('   ⚠ **有数但不可信**: ⑧.7 的「认不出轮次的多轮跑」那一面 —— 排除不掉跨轮伪影,');
    console.log('     在能分辨轮次之前不作数 (2026-08-06 起新跑自动进可信面)。');
    console.log('   ⚠ 「在等」与「不适用」**不是一回事**: 前者继续用就会涨, 后者再等也不会有数。');
    console.log('     每一格具体属于哪种, 看它自己那一段的判词 —— 这里只给导航, 不替它下结论。\n');
  }

  console.log('① 每次运行的账 (按 runId 归组; goal 一次两段图算一次)');
  console.log('   时间              节点  leafIn   leafOut  cacheHit  失败  plan');
  for (const r of runs) {
    const t = new Date(r.createdAt).toISOString().slice(5, 16).replace('T', ' ');
    const plans = [...new Set(r.plans)].join('+');
    console.log(
      `   ${t}  ${String(r.nodes).padStart(4)}  ${k(r.leavesIn).padStart(7)}  ${k(r.leavesOut).padStart(7)}  ${pct(r.cacheRate).padStart(8)}  ${String(r.failed).padStart(4)}  ${plans}`,
    );
  }

  console.log(`\n② 命令风险级分布 (R1 · 只报不拦; 共 ${commandNodes} 次 command 节点执行)`);
  if (commandNodes === 0) {
    console.log('   留痕里没有 command 节点。⚠ 也可能是这批记录早于「记录命令」那次改动 —— ');
    console.log('     两种情况读上去一模一样, 别把「没记」读成「没跑过」。');
  } else {
    for (const tier of (Object.keys(tierCount) as CommandRiskTier[]).sort((a, b) => RISK_TIER_ORDER[a] - RISK_TIER_ORDER[b])) {
      const n = tierCount[tier];
      const bar = '█'.repeat(Math.round((n / commandNodes) * 30));
      console.log(`   ${tier.padEnd(18)} ${String(n).padStart(4)}  ${pct(n / commandNodes)}  ${bar}`);
      for (const s of tierSamples.get(tier) ?? []) console.log(`       · ${s}`);
    }
    if (neverButBlocked > 0) {
      console.log(`   ℹ never 里有 ${neverButBlocked} 条是**闸正确拒掉**的 —— 系统在干活, 不是缺陷。`);
    }
    if (neverUnknown > 0) {
      console.log(`   ? never 里有 ${neverUnknown} 条**判不出成因**(老记录无 exitCode)—— 不知道就是不知道, 别当缺陷也别当正常。`);
    }
    console.log(`   **闸拒 ${gateRejections} 次** (G5: 书 §4.4 里"Harness 拒绝了某个操作"正是 BLOCKED 的定义,`);
    console.log(`     而我们今天把它降格成节点 failed。攒 K 值用的就是这个数。)`);
    if (neverAndRan > 0) {
      console.log(`   ⚠ never 里有 ${neverAndRan} 条**跑成了**(节点 done)—— 那才是分级表与白名单不同步, 该修。`);
    }
  }

  console.log(`\n③ 单轮成本异常 (§8.6 · leafIn > 中位数 ${k(median)} × ${ANOMALY_FACTOR})`);
  if (median === 0) {
    console.log('   还没有非零的 leafIn, 算不出中位数。');
  } else if (anomalies.length === 0) {
    console.log('   无。');
  } else {
    for (const a of anomalies) {
      console.log(`   ${new Date(a.createdAt).toISOString().slice(5, 16).replace('T', ' ')}  leafIn=${k(a.leavesIn)}  (${(a.leavesIn / median).toFixed(1)}× 中位数)  ${[...new Set(a.plans)].join('+')}`);
    }
  }

  console.log(`\n④ 效果指标 (§8.5 · 写调用成功 ≠ 真的改了)`);
  if (writeNodes === 0) {
    console.log(`   没有节点报过 writeCounts。${unreported > 0 ? `⚠ 其中 ${unreported} 个 agent 节点**该报而没报** — 那是早于 2026-07-31 的记录, 不是"它们没写文件"。` : ''}`);
  } else {
    const rate = totalWrites > 0 ? totalNoop / totalWrites : null;
    console.log(`   报了的节点 ${writeNodes} 个${unreported > 0 ? ` (另有 ${unreported} 个 agent 节点该报未报 — 旧记录)` : ''}`);
    console.log(`   写调用 ${totalWrites} 次, 其中 no-op ${totalNoop} 次 = ${pct(rate)}`);
    if (noopNodes.length > 0) {
      console.log(`   ⚠ **全部写都是 no-op** 的节点 ${noopNodes.length} 个 —— 「看起来做了」, 而产物闸看不见:`);
      for (const n of noopNodes.slice(0, 8)) console.log(`       · ${n.id}  (${n.noop}/${n.total})`);
    }
    console.log(`   判据: no-op 率长期贴近 0 → 别为它建闸; 成规模 → 产物闸正放过一整类静默失败。`);
  }

  console.log(`\n⑤ detector 标注率 (D-Q · conductor 在真跑上标了几个)`);
  if (conductorChildren === 0) {
    console.log('   留痕里没有 conductor 子节点 (这批 run 没走内环, 或早于「记 detector」那次改动)。');
  } else {
    console.log(`   子节点 ${conductorChildren} 个, 标了 detector 的 ${detectorNodes} 个 = ${pct(detectorNodes / conductorChildren)}`);
    console.log(`   对照: eval 上的**规划期**使用率天花板是 60% (v3/v4 同分, 噪声内)。`);
    // ⚠ 第三次踩同一个坑了 (前两次: writeCounts 缺席 vs [0,0]; never 闸拒 vs 未登记)。
    // `detector` 在**早于 2026-07-31 的记录**里恒缺席 —— 那个 0 是"没记"不是"没标"。
    // 用 unreported (agent 节点没报 writeCounts) 当同批老记录的判据: 两个字段同一次改动加的。
    if (unreported > 0) {
      console.log(`   ⚠ 这批里有 ${unreported} 个 agent 节点是**旧格式**记录 —— 它们的 detector 恒缺席,`);
      console.log(`     所以上面这个比率**只在新记录上可信**。别把「没记」读成「没标」。`);
    } else if (detectorNodes === 0) {
      console.log('   ⚠ 0 个 (记录是新格式, 这个 0 可信) —— 「60% 天花板在生产上兑现成 0」再加一次读数。');
    }
  }

  // ── ⑬ 跑坏了回得去吗 (D1, 2026-08-06) ────────────────────────────────────────
  const rb = contract.rollback;
  console.log(`\n⑬ 跑坏了回得去吗 (D1 —— D-AB 那句「git 就是 rollback」的真实条件)`);
  console.log('   ⚠ R2 给的隔离档 (独立 worktree + 分支) **默认关着, 且只挂在 dag_goal 一个入口上**。');
  console.log("     2026-08-06 实测 `git branch --list 'omd/run/*'` **0 条 —— 从来没被用过一次**");
  console.log('     (S-3「机制写好了但默认关着 / 只挂在一条路上」那一族, 这次有读数)。');
  console.log('     于是绝大多数跑直接写当前工作树, 而那一档的回滚**有条件**: 起跑时树干不干净。');
  if (rb.recordedRuns === 0) {
    console.log(`   这批 ${rb.unrecordedRuns} 条记录**都没记** (早于 2026-08-06)。跑一次新的才有这段读数。`);
  } else {
    console.log(`   记了的运行 ${rb.recordedRuns} 次${rb.unrecordedRuns > 0 ? ` (另有 ${rb.unrecordedRuns} 次没记, **不进分母**)` : ''}`);
    const rows: [RollbackAnchorKind, string][] = [
      ['clean', '**有**完整回滚: `git checkout -- . && git clean -fd`'],
      ['dirty-tracked', '**没有**回滚对象 —— 这次的写与你的改动混在同一片 diff 里'],
      ['dirty-untracked', '**半个** —— `git clean -fd` 会删掉你原有的未跟踪文件'],
      ['not-a-repo', 'git 这条路不存在 (branchStrategy 在这里也退回 head)'],
      ['unknown', '**查不了** —— 既不是干净也不是脏, 别据它下判断'],
    ];
    for (const [k, meaning] of rows) {
      const n = rb.byKind[k];
      if (n === 0) continue;
      console.log(`     ${k.padEnd(16)} ${String(n).padStart(4)}  ${pct(n / rb.recordedRuns).padStart(6)}  ${meaning}`);
    }
    console.log(`   ▸ **起跑时有完整回滚对象的比例: ${rb.cleanRate === null ? '算不出' : pct(rb.cleanRate)}**`);
  }
  console.log('   判据 (在数据到达之前钉的):');
  console.log('     · clean 占绝大多数 → D-AB 那句「git 就是 rollback」在生产上**站得住**, D1 可收尾;');
  console.log('     · dirty-tracked 成规模 → 那句话在生产上**不成立**, 而下一步不是"加个闸拦住脏树"');
  console.log('       (那会把最常见的用法整个挡掉), 是**把隔离档变成够用的缺省** —— 而它今天连一次都没被用过,');
  console.log('       所以先要问的是"为什么没人用", 不是"为什么不默认开";');
  console.log('     · unknown 成规模 → 先修观测, 别读上面任何一格 (查不了不是一种状态, 是没查到)。');
  console.log('   ⚠ **只报不拦**: 它不阻断任何一次跑, 只让 owner 在动手之前知道有没有退路。');

  // ── ⑤.1 检查者只读吗 (D4 / §7.3, 2026-08-06) ──────────────────────────────
  const dwr = contract.detector_writes;
  console.log(`\n⑤.1 检查者只读吗 (D4 / §7.3 —— 这条纪律今天靠运气成立, 不是不变量)`);
  if (dwr.detectors === 0) {
    console.log('   留痕里一个 detector 节点都没有 —— 见上面 ⑤ 段的标注率。');
  } else {
    console.log(`   detector 节点 ${dwr.detectors} 个, 其中 **kind=agent 的 ${dwr.agentDetectors} 个** ← 手里真有写工具`);
    console.log(`     (其余是 inproc/command: 一个写工具都没有, **不进机会分母** —— 那是"不可能"不是"没发生")`);
    if (dwr.observed === 0) {
      console.log(`     ⚠ 这 ${dwr.agentDetectors} 个**都没记** writeCounts —— 那是「没记」不是「没写」, 跑一次新的才有。`);
    } else {
      console.log(`     记了 writeCounts 的 ${dwr.observed} 个 → 其中**受控写工具动过手的 ${dwr.wroteControlled} 个**` +
        `  [${dwr.rate === null ? '算不出 (分母 0)' : `${(dwr.rate * 100).toFixed(1)}%`}]`);
      if (dwr.agentDetectors > dwr.observed) {
        console.log(`     (另有 ${dwr.agentDetectors - dwr.observed} 个没记这一位, **不进分母**)`);
      }
    }
    console.log(`   观察面上的 detector-wrote 条数: ${dwr.findings}`);
    console.log('     ⚠ 它与上面那个数**不同源**: 分母来自节点面 (writeCounts), 这一个来自观察面');
    console.log('       (含**推断**口径 —— 检测者走 bash 写的那部分只有这一路看得见)。');
  }
  console.log('   判据 (在数据到达之前钉的):');
  // ⚠ **上界现算, 不写死** (2026-08-06 修): 这一行原本硬编码 "0/7 → 43%", 而真正的分母是
  //   `observed` (记了 writeCounts 的那些), 早先从 7 改到 4 时**只改了契约注释、漏了这一行**。
  //   rule of three: 0 检出 / N → 真实基率 95% 上界 ≈ 3/N。让它跟着数据走就再也过不了期。
  const dwN = dwr.observed;
  const dwBound = dwN > 0 ? `${((3 / dwN) * 100).toFixed(0)}%` : '算不出 (分母 0)';
  console.log(
    `     · agent 检测者 < ${LOOP_NO_MOVE_MIN_N} 个 → **还不到判的时候**。` +
      `今天 n 太小 (rule of three: ${dwr.wroteControlled}/${dwN} 的 95% 上界是 ${dwBound});`,
  );
  console.log(`     · ≥ ${LOOP_NO_MOVE_MIN_N} 且检出 0 → 检查者事实上就是只读的, **维持现状是合法结论**, 不必去收它的写工具;`);
  console.log('     · 检出 > 0 → 逐条读: 它写的是**自己的草稿**(那只是没归位的临时文件, 改法是给检查者一个 scratch 目录),');
  console.log('       还是**被它检查的那个产物**(那才是 §7.3 说的问题 —— 裁决不再是对兄弟产出的观察)。两者的改法不一样。');
  console.log('   ⚠ **只报不拦**: 真把检测者的写工具收掉是单独的拨闸决定。今天先把这件事变成看得见的。');

  console.log(`\n⑥ 熔断 near-miss (§8.4 的键该不该从「命令+输出」改成别的)`);
  const bk = contract.breaker_key;
  if (bk.fingerprints === 0) {
    console.log('   留痕里没有失败的 command 节点 (或早于「记 outputHash」那次改动)。');
  } else {
    console.log(`   失败输出指纹 ${bk.fingerprints} 种 (不含空输出那一格) —— ⚠ **这不是机会分母** (2026-08-06 修正):`);
    console.log(`     · 只失败过 1 次 (singleton)  ${String(bk.singletons).padStart(4)} 种  → 熔断按构造要「≥2 次」, **两种键都抓不到**`);
    console.log(`     · **真有机会的**             ${String(bk.opportunities).padStart(4)} 种  ← 下面两格的分母`);
    console.log(`        ├ 同输出**同**命令 (现行键抓得到)   ${String(bk.exactRepeat).padStart(4)}`);
    console.log(`        └ 同输出**不同**命令 (现行键漏掉)   ${String(bk.nearMiss).padStart(4)}` +
      `  [${bk.rate === null ? '算不出 (分母 0)' : `${(bk.rate * 100).toFixed(1)}%`}]`);
    if (bk.nearMissCrossRun > 0) {
      console.log(`     ⚠ 上面那 ${bk.nearMiss} 组里有 ${bk.nearMissCrossRun} 组是**跨 run 凑出来的** —— §8.4 熔断是`);
      console.log(`       同一次 run 的环内累计, 跨 run 的两次失败根本碰不到一起。**真机会只有 ${bk.nearMissSameRun} 组。**`);
    }
    for (const s of bk.samples) {
      console.log(`     · ${s.outputHash}: ${s.commands.length} 条不同命令${s.sameRun ? '' : ' (跨 run, 不是真机会)'}`);
      for (const c of s.commands) console.log(`         ${c}`);
    }
    if (bk.emptyOutputCommands > 1) {
      console.log(`     ⚠ 另有一个**空输出**桶, 里面有 ${bk.emptyOutputCommands} 条互不相干的命令 (\`grep -q\` 那族失败没有输出,`);
      console.log('       全指纹成同一条)。它**不进上面任何一格** —— 那是"只看输出"这条改法的**反例不是机会**:');
      console.log('       按输出合并会把两个不同断言各失败一次判成同一条在空转, 当场误熔断。');
    }
    console.log('   ⚠ **旧版这一段把结论读反了**: 它只印"指纹 N 种 / near-miss M 组", 而 N 里绝大多数是');
    console.log('     singleton。读的人据此算出"现行键覆盖 (N-M)/N" —— 而在真机会分母上现行键的覆盖是');
    console.log(`     ${bk.opportunities > 0 ? `${bk.exactRepeat}/${bk.opportunities}` : '0/0'}。**方向相反, 而没有任何一层报错**(同 S-19/S-20 那一族)。`);
  }
  console.log('   判据 (按**真机会分母**读, 不是按指纹种数):');
  console.log('     · 真机会 = 0 → 还不到判的时候。今天缺的不是 near-miss, 是**重复失败本身**;');
  console.log('     · 真机会 > 0 而 near-miss 占其中一小半以下 → 现行「命令+输出」键就够, 别动它;');
  console.log('     · near-miss 占**大多数**(尤其真重复 = 0)→ 现行键在真跑上基本抓不到东西,');
  console.log('       那才值得为它设计一个更宽的键(⚠ 但不是"只看输出" —— `grep -q` 失败无输出,');
  console.log('       所有静默失败会指纹成同一条, 两个不同断言各失败一次就误熔断, 比漏报坏得多)。');

  console.log(`\n⑦ 没过的成因分布 (P1 · 此前这 ${notDoneNodes} 个节点在读数上全叫 "failed")`);
  if (notDoneNodes === 0) {
    console.log('   这批记录里没有 status≠done 的节点。');
  } else {
    const classified = notDoneNodes - failureKindUnrecorded;
    if (classified === 0) {
      console.log(`   ${notDoneNodes} 个没过的节点**全部是旧格式记录**(无 failureKind) —— 那是「没记」,`);
      console.log('     不是「归不了类」。跑一次新的 dag_run / dag_goal 才有这段读数。');
    } else {
      for (const kind of FAILURE_KIND_ORDER) {
        const n = failureKindCount[kind];
        if (n === 0) continue;
        const info = FAILURE_KIND_INFO[kind];
        const bar = '█'.repeat(Math.round((n / classified) * 24));
        const state = info.loopState ?? '—';
        const retry = info.retryable === null ? '重试?' : info.retryable ? '可重试' : '**别重试**';
        console.log(`   ${kind.padEnd(19)} ${String(n).padStart(4)}  ${pct(n / classified).padStart(6)}  ${state.padEnd(8)} ${retry.padEnd(10)} ${bar}`);
        console.log(`       判据: ${info.evidence}`);
        console.log(`       下一步: ${info.nextAction}`);
        const s = kindSamples.get(kind);
        if (s?.size) console.log(`       节点: ${[...s].join(', ')}`);
      }
      if (failureKindCount.unclassified > 0) {
        console.log(`   ⚠ **${failureKindCount.unclassified} 个归不了类** —— 引擎里还有一条失败路径没交代自己是怎么回事,`);
        console.log('     那正是该去补标注的地方。(这个数该趋近 0; 它不为 0 就是缺陷本身。)');
      }
    }
    if (failureKindUnrecorded > 0) {
      console.log(`   ? 另有 ${failureKindUnrecorded} 个没过的节点**没记**成因(早于 2026-07-31 的记录)——`);
      console.log('     与上面的 unclassified 不是一回事: 那个是缺陷, 这个是老数据。别并起来数。');
    }
    console.log('   判据: 若失败常年只落一两格 → 这个词表是镀金, 该收回去;');
    console.log('         若 gate-rejected / stall / empty-artifact 各占一块 → 此前那个 `failed`');
    console.log('         一直在把三种**后续动作相反**的东西报给同一个读者。');
  }

  console.log(`\n⑧ 图外观察者命中 (G5 正解「产物没变」的定 K 依据)`);
  if (runsWithObs === 0) {
    console.log(`   这批 ${runsUnrecordedObs} 条记录**都没记** observations (早于 2026-07-31)。`);
    console.log('     ⚠ 那是「没记」不是「一条都没命中」—— 跑一次新的才有这段读数。');
  } else {
    console.log(`   记了的运行 ${runsWithObs} 次${runsUnrecordedObs > 0 ? ` (另有 ${runsUnrecordedObs} 次是旧格式, 不计入)` : ''}`);
    if (obsCount.size === 0) {
      console.log('   一条观察都没有 —— 这个 0 可信 (记了, 只是没命中)。');
    } else {
      for (const [kind, n] of [...obsCount].sort((a, b) => b[1] - a[1])) {
        console.log(`   ${kind.padEnd(26)} ${String(n).padStart(4)} 次  (${(n / runsWithObs).toFixed(2)} 次/运行)`);
      }
    }
    const noMoveObs = obsCount.get('loop-no-artifact-change') ?? 0;
    console.log(`   ▸ **loop-no-artifact-change ${noMoveObs} 次** —— 它是 D-AD 那条死路的绕法:`);
    console.log('     旧的三个"卡住"检测器全键在「agent 重复自己」上, 而 LLM conductor 每轮重画,');
    console.log('     从不逐字重复 → 在 live 上恒 0。这一条改键在「盘上有没有位移」, 才可能真命中。');
  }
  // ── 这个 0 除以什么 (2026-08-06) ────────────────────────────────────────────
  // 到这一版之前, 上面那个次数一直是**只有分子**: 判词说"长期 0 次 → 别再加检测器", 而"长期"
  // 被默读成了运行次数。可这条判据住在 conductor 内环, 一次比较要同时有上一轮 + 两轮都有产物信号
  // —— 单轮档的 dag_run 与首轮即绿的 goal 一次机会都没有。同表其他 kind 有数也证不了它够得着:
  // undeclared-artifact-dep / write-race 是跑前静态判死, leaf-spin 在 leaf 自己的工具循环里,
  // 三条没有一条经过跨轮那条路。所以分母单独记、单独印。
  const am = contract.artifact_move;
  if (am.recordedRuns === 0) {
    console.log(`   分母: 这批 ${am.unrecordedRuns} 条记录**都没记** 机会计数 (早于 2026-08-06)。`);
    console.log('     ⚠ 于是上面那个次数**只有分子** —— 在补上之前, 它既不能读成"活体基率 0",');
    console.log('       也不能读成"判据够不着"。跑一次新的才有这段读数 (改过引擎记得先重连 MCP)。');
  } else {
    console.log(`   分母 (机会计数, ${am.recordedRuns} 跑记了${am.unrecordedRuns > 0 ? ` · 另有 ${am.unrecordedRuns} 跑没记, **不进分母**` : ''}):`);
    console.log(`     跨轮比较机会 ${am.transitions} 次 → 判不了 ${am.unobserved} 次 (产物信号为空/有读不到的)`);
    console.log(`     → **真判过 ${am.comparable} 次**, 其中判成"没位移" ${am.findings} 次` +
      `  [${am.rate === null ? '算不出 (分母 0)' : `${(am.rate * 100).toFixed(1)}%`}]`);
    // 三个槽各自够不够 —— 三个 0 的下一步相反, 所以分开印, 不合成一句"样本不足"。
    const slot = (name: string, s: FaceSufficiency, meaning: string) =>
      console.log(
        s.enough
          ? `     ${name.padEnd(10)} 够了 (${s.nodes} ≥ ${LOOP_NO_MOVE_MIN_N}) → ${meaning}`
          : `     ${name.padEnd(10)} **不足**, 还差 ${s.short} (${s.nodes}/${LOOP_NO_MOVE_MIN_N}) → 这一槽还判不了`,
      );
    slot('记了的跑', am.sufficiency.runs, '"机会存不存在"这一问可以判了');
    slot('轮转次数', am.sufficiency.transitions, 'population 闸吃掉多少可以判了');
    slot('可比较数', am.sufficiency.comparable, '**活体基率**可以当结论读了');
  }
  console.log('   判据 (2026-08-06 改写 —— 旧版把上面那个次数除以运行次数, 那是错的单位):');
  console.log(`     · 可比较数 < ${LOOP_NO_MOVE_MIN_N} → **还不到判的时候**。今天缺的不是命中, 是**机会**;`);
  console.log(`     · 可比较数 ≥ ${LOOP_NO_MOVE_MIN_N} 且检出 0 → 连"盘上位移"这个信号也够不着,`);
  console.log('       那 G5 的问题不在判据在别处, 别再加同类检测器 (这才是原判词那一条的兑现);');
  console.log('     · 检出 > 0 → 照原来两条读: 那些 run 后来**自己收敛了** → "没位移"不蕴含"卡死", 维持只报;');
  console.log('       一直没位移直到轮数耗尽 → 才谈升 BLOCKED, K 取"连续几轮"的众数。');
  console.log('   ▸ 两个"卡在半路"的读法 (它们的下一步不一样):');
  console.log(`     · 记了的跑 ≥ ${LOOP_NO_MOVE_MIN_N} 而轮转次数仍 ≈ 0 → 瓶颈是**环只转一圈**`);
  console.log('       —— 到底是哪一种"只转一圈", 看下面 ⑧.1 (那句话此前把四件事并成了一个括号);');
  console.log('     · 轮转在涨而可比较数不涨 → 瓶颈是 population 闸: 环里根本没有产物信号。');
  // ⚠ 两个数看着打架, 而它们**本来就不是同一个数** (2026-08-06 读真实输出时撞到的):
  //   这一段的「轮转次数」= `artifactMove.transitions` = **走到跨轮比较点**的次数;
  //   ⑧.1 的 ④ = `rounds >= 2` = **环真转了第二圈**。第二轮若 judge 判收敛, 退出点在
  //   比较点**之前** → ④ 涨而轮转次数不涨。不写出来的话, 读的人只会以为两个仪器互相矛盾
  //   (⑨/⑫ 那次同形: 同一页两个数、口径不同、谁都没说)。
  console.log('   ⚠ **本段的「轮转次数」与 ⑧.1 的 ④「真转了第二圈」不是同一个数**, 可以合法地不相等:');
  console.log('     · 这里数的是**走到跨轮比较点**的次数; ⑧.1 ④ 数的是**环转到第二圈**的次数;');
  console.log('     · 第二轮若 judge 判收敛 (或 §8.4 熔断 / D-Q blocked), 退出点在比较点**之前**');
  console.log('       → ⑧.1 ④ 涨, 而这里不涨。**看到两边对不上时先想这条, 别当成仪器坏了。**');
  console.log('   ⚠ 现在**只报不拦**: max_rounds ≤ 4, 误拦一次掐死一个本可收敛的 run,');
  console.log('     漏报一次只赔一两轮。这个比价下, 0 读数就上硬闸是拿大风险换小收益。');

  // ── ⑧.1 内环的形状 (2026-08-06) ────────────────────────────────────────────
  // 上面那句「瓶颈是环只转一圈」把四件下一步不同的事并成了一个括号。这一段把它们拆开 ——
  // 而 ① 那一格只用 `kind`, 所以**老记录也算得出**: 不必等新跑就有第一个答案。
  const lsr = contract.loop_shape;
  const lsRuns = lsr.runsWithoutConductor + lsr.runsWithConductor;
  console.log(`\n⑧.1 内环的形状 (⑧ 那个 0 出自哪一格 —— 四格的下一步互不相同)`);
  if (lsRuns === 0) {
    console.log('   这批记录一条都没有 —— 没什么可拆的。');
  } else {
    const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : '—');
    console.log(
      `   ① 图里**没有 conductor 节点**   ${String(lsr.runsWithoutConductor).padStart(4)} 跑 / ${lsRuns}  (${pct(lsr.runsWithoutConductor, lsRuns)})` +
        '  → ⑧ 这条判据**不适用**',
    );
    console.log('      这一格与检测器好不好无关 —— 它说的是"跑的是什么图"。它**可回溯**(只看 kind),');
    console.log('      所以是四格里唯一今天就有答案的。占比高 = G5 的着力点根本不在内环上。');
    console.log(`   有 conductor 的跑 ${lsr.runsWithConductor} 次, 共 ${lsr.conductorNodes} 个 conductor 节点:`);
    if (lsr.conductorNodes === lsr.unrecordedNodes) {
      console.log(`      这 ${lsr.conductorNodes} 个**都没记** rounds/maxRounds (早于 2026-08-06)。`);
      console.log('      ⚠ 那是「没记」不是「单轮档」—— ②③ 要跑一次新的才分得开。');
    } else {
      const d = lsr.conductorNodes - lsr.unrecordedNodes;
      console.log(
        `      ② max_rounds = 1 (缺省)      ${String(lsr.singleRound).padStart(4)} / ${d}  (${pct(lsr.singleRound, d)})` +
          '  → **结构上**没有跨轮比较的机会',
      );
      console.log(
        `      ③ 多轮档而首轮就收敛        ${String(lsr.firstRoundConverged).padStart(4)} / ${d}  (${pct(lsr.firstRoundConverged, d)})` +
          '  → 环正常, 检测器没有付费对象',
      );
      console.log(
        `      ④ **真转了第二圈**          ${String(lsr.turned).padStart(4)} / ${d}  (${pct(lsr.turned, d)})` +
          '  → ⑧ 的机会**只可能出自这一格**',
      );
      if (lsr.unrecordedNodes > 0) {
        console.log(`      (另有 ${lsr.unrecordedNodes} 个没记这两位, **不进上面三格的分母** —— 老行 / conductor 异常退出)`);
      }
    }
  }
  // ── ⑧.1 的**第二个可回溯面**: 内环 journal (2026-08-06) ────────────────────
  //
  // ⚠ 首版把 ②③④ 整段标成「要跑一次新的」, 而那是**错的**: `_loop-*.json` 里的
  //   `completedRounds` 一直就记着内环跑了几轮, 这块板甚至早就在读它 (算 roundsTotal),
  //   只是从没接到「环到底转没转第二圈」这个问题上。**这一次是刚立完「可回溯的那一格要先算」
  //   之后又犯的同一个错**(交接 32 §五 第 2 条), 所以判词里把它写明白。
  const lr = summarizeLoopRounds(allJournals);
  if (lr.journals > 0) {
    console.log(
      `   ▸ **可回溯的第二个面**: 内环 journal ${lr.journals} 份 (\`.omd/continuity/<runId>/_loop-*.json\`)` +
        `\n     ⚠ 口径: **只覆盖上面那 ${runs.length} 个窗口内的 run** —— 盘上 continuity 目录通常比窗口多,` +
        '\n       所以这个数是**下界**。要看全量请直接数 `.omd/continuity/*/_loop-*.json`。',
    );
    console.log(`      **真转了第二圈 ${lr.turned} 份** ← ④ 那一格**不用等新跑**, 历史里就有`);
    console.log(`      只跑完 1 轮      ${lr.oneRound} 份  —— **压着三种情况分不开** (max_rounds=1 撞熔断/blocked/预算 ·`);
    console.log('                        max_rounds=1 配了 judge_final/冻结判据 · max_rounds>1 首轮就收敛),');
    console.log('                        拆开它要的正是账本新加的 maxRounds 那一位;');
    if (lr.turned > 0) {
      const by = Object.entries(lr.turnedByStop).sort((a, b) => b[1] - a[1]);
      console.log(`      转了第二圈的按停止原因分: ${by.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
      // 这一句的知识**绑在具体退出路径上** —— 所以它写在判词里而不是存成派生值 (会静默过期)。
      const pass = (lr.turnedByStop['not-converged'] ?? 0) + (lr.turnedByStop['budget-exhausted'] ?? 0);
      console.log(`      ⚠ **转了第二圈 ≠ 跨轮比较真发生过**: \`success\` 与 \`blocked\` 的 return 在比较点**之前**,`);
      console.log(`        \`not-converged\` / \`budget-exhausted\` 在**之后** → 真走到比较点的约 **${pass} 份**。`);
      console.log('        (这条对应关系绑在 executor-dag 的退出路径上, 改那几处时要一起看。)');
    }
    console.log(`   ▸ **于是 ⑧ 的机会不是结构性为零** —— 环确实会转第二圈 (历史 ${lr.turned} 次)。`);
    console.log('     那条判据长期 0 检出, 该读成"够得着但没命中"还是"够不着", 由 ⑧ 段的可比较数说了算。');
  }
  console.log('   判据 (在数据到达之前钉的 —— 它判的是「⑧ 这条检测器值不值得留」):');
  console.log('     · ① 占多数 → 内环根本不是主流形状, **别在检测器上再投**, 去看 ⑧.5/⑧.6 那两条平铺面的;');
  console.log('     · ② 占多数 → 是**缺省值**掐死了这条判据, 不是判据不行。要么改缺省 (那是独立的');
  console.log('       设计决定, 有它自己的代价), 要么承认这条检测器在今天的缺省下够不着而收掉;');
  console.log('     · ③ 占多数 → 环给了机会而首轮就收敛 —— 这是"没有付费对象"的**正面证据**, 收掉;');
  console.log('     · ④ > 0 而 ⑧ 的可比较数仍 ≈ 0 → 转是转了, 卡在 population 闸或提前退环');
  console.log('       (§8.4 熔断 / D-Q blocked / 预算轴), 该去查的是那三条, 不是这条检测器。');
  console.log('   ⚠ 四格**不许合并**: 它们的下一步分别是"别投/改缺省/收掉/查别处"。');
  console.log('     合成一句"环只转一圈"正是这一段要拆的那个动作 (S-19 的同一形状再走一层)。');

  // ── ⑧.7 回溯重建的写竞争 (2026-08-06) ────────────────────────────────────────
  // IO 在这里 (扫 `.omd/continuity/*/`), 判据全在 reconstructWriteRace → detectRuntimeWriteRace。
  // ⚠ **不按 run 窗口截**: 这一面的全部价值就是"历史里已经有答案", 截了就白截。
  const retro = (() => {
    const base = join(String(flags.repo ?? process.cwd()), '.omd', 'continuity');
    const stats = { dirs: 0, checkpoints: 0, checkpointsWithPaths: 0 };
    const runsIn: { runId: string; nodes: NodeWindow[]; multiRound: boolean; roundsKnown: boolean }[] = [];
    let dirNames: string[] = [];
    try {
      dirNames = readdirSync(base);
    } catch {
      return null; // 没有 continuity 目录 = 这一面不适用 (不是 0)
    }
    for (const d of dirNames) {
      let all: string[];
      try {
        all = readdirSync(join(base, d));
      } catch {
        continue; // 不是目录 / 读不了 —— 跳过, 不计进 dirs
      }
      const files = all.filter((f) => f.endsWith('.json') && !f.startsWith('_'));
      stats.dirs++;
      // 这一跑转过第二圈没有 —— 决定它落"可信"还是"不可信"那一面 (见 RetroWriteRace.clean)。
      let multiRound = false;
      for (const f of all.filter((x) => x.startsWith('_loop-'))) {
        try {
          const j = JSON.parse(readFileSync(join(base, d, f), 'utf8')) as { completedRounds?: number };
          if ((j.completedRounds ?? 1) >= 2) multiRound = true;
        } catch {
          // 读不出轮数 → 保守当**多轮**处理 (宁可把它摆进"不可信"那一面, 也不许混进可信面)
          multiRound = true;
        }
      }

      const nodes: NodeWindow[] = [];
      for (const f of files) {
        try {
          const j = JSON.parse(readFileSync(join(base, d, f), 'utf8')) as {
            nodeId?: string; createdAt?: string; durationMs?: number; outputPaths?: string[]; round?: number;
          };
          const end = Date.parse(j.createdAt ?? '');
          if (!Number.isFinite(end) || !j.nodeId) continue;
          const paths = Array.isArray(j.outputPaths) ? j.outputPaths : [];
          stats.checkpoints++;
          if (paths.length) stats.checkpointsWithPaths++;
          nodes.push({ id: j.nodeId, startMs: end - (j.durationMs ?? 0), endMs: end, paths, ...(roundOf(f, j.round) !== undefined ? { round: roundOf(f, j.round) } : {}) });
        } catch {
          // 坏 JSON 不该让整块读数崩 (同上面几处); 它不计进 checkpoints, 于是也不假装看过。
        }
      }
      // 子图节点 (`::`) 全都带 round → 跨轮的对已被排掉, 这一跑没有伪影可言 (见 RetroWriteRace.ambiguous)。
      const roundsKnown = nodes.every((n) => !n.id.includes('::') || n.round !== undefined);
      if (nodes.length) runsIn.push({ runId: d, nodes, multiRound, roundsKnown });
    }
    return reconstructWriteRace(runsIn, stats);
  })();
  console.log(`\n⑧.7 回溯重建的写竞争 (拿 checkpoint 把历史算出来 —— 不用等新跑)`);
  if (!retro || retro.dirs === 0) {
    console.log('   没有 `.omd/continuity/` 目录 —— 这一面**不适用**(不是 0)。');
  } else {
    console.log(`   扫了 ${retro.dirs} 个 continuity 目录 · ${retro.checkpoints} 份节点 checkpoint`);
    console.log(`     其中报了 outputPaths 的 ${retro.checkpointsWithPaths} 份;有 ≥2 个节点的目录 ${retro.dirsUsable} 个`);
    const c = retro.clean;
    const am = retro.ambiguous;
    console.log(`   ▸ **单轮跑那一面 (数可信)**: 重叠 ${c.overlaps} → 机会 ${c.pairs} → **真撞车 ${c.findings}**` +
      `  [${c.rate === null ? '算不出 (分母 0)' : `${(c.rate * 100).toFixed(1)}%`}]`);
    const suf = faceSufficiency(c.pairs, LOOP_NO_MOVE_MIN_N);
    console.log(
      suf.enough
        ? `     机会对 够了 (${suf.nodes} ≥ ${LOOP_NO_MOVE_MIN_N}) → **这一面的撞车基率可以当结论读了**`
        : `     机会对 **不足**, 还差 ${suf.short} (${suf.nodes}/${LOOP_NO_MOVE_MIN_N}) → 基率还不许当结论`,
    );
    console.log(`   ▸ **认不出轮次的多轮跑 (数不可信)**: ${am.runs} 跑 · 重叠 ${am.overlaps} → 机会 ${am.pairs} → 撞车 ${am.findings}`);
    console.log('     ⚠ **不许并进上面** —— checkpoint 按 nodeId **覆写**, 而这些记录**没记轮次**:');
    console.log('       两份 checkpoint 可能来自**不同的轮**, 把窗口配成一对就是**跨轮伪影**,');
    console.log('       而"两个节点在不同轮里各跑一次"根本不是并发。');
    console.log('     → **2026-08-06 起 `NodeCheckpoint.round` 有值了**: 两侧都有轮次时不同轮的对被直接排除,');
    console.log('       于是**多轮跑也进可信面**。判据是「认不认得出轮次」不是「是不是多轮」——');
    console.log('       这一格会随着老记录被清掉自然缩小到 0。');
    for (const s of retro.samples) {
      console.log(`     · ${s.runId.slice(0, 8)} ${s.a} × ${s.b}: ${s.shared.join(', ')}` +
        `${s.multiRound ? '   ⚠ **落在多轮跑那一面 —— 无法排除是跨轮伪影**' : ''}`);
    }
  }
  console.log('   ⚠ **它与 ⑧.6 那两档不是同一个仪器, 数不许相加**:');
  console.log('     · 窗口来源不同 —— 这里是 `结束 - 时长` (整个节点的执行时长), ⑧.6 是调度器实时记的;');
  console.log('     · 路径基准不同 —— 这里相对**该 run 的根**, 所以**同一 runId 内可比、跨 run 不可比**;');
  console.log('     · 覆盖不同 —— 只覆盖开了 continuity 的跑, 目录被清掉就没了 (与留痕库寿命不一样长)。');
  console.log('   ⚠ 判据**一个字都没重写**: 窗口配对后喂给 `detectRuntimeWriteRace` 那同一个函数');
  console.log('     (父子守卫 / 机会分母 / 撞车判定全在那儿) —— 两处各算一份必漂。');
  console.log('   判据 (按**单轮跑**那一面读 —— 多轮跑那一面在能分辨轮次之前不作数):');
  console.log('     · 单轮面撞车 > 0 → **并发写竞争在生产上确实发生**, 不是理论风险;');
  console.log(`     · 单轮面机会 ≥ ${LOOP_NO_MOVE_MIN_N} 且撞车 0 → 并发写在真跑上不发生, 这条可以收尾;`);
  console.log('     · 撞车逐条读: 撞的是"共享目录型文件"(图的形状问题) 还是"产物恰好同名"(命名问题)。');

  console.log(`\n⑧.5 「声称 vs 引擎记录」检出器 (report-only —— 拨不拨闸就看这段)`);
  if (cc.recordedRuns === 0) {
    console.log(`   这批 ${cc.unrecordedRuns} 条记录**都没记** claim_check (早于 2026-08-05)。`);
    console.log('     ⚠ 那是「没记」不是「零检出」, 也不是「判据够不着」—— 跑一次新的才有这段读数。');
    console.log('     ⚠ 若刚改过引擎却仍然没记: **先怀疑 MCP daemon 跑的是旧代码**, 别先怀疑代码。');
  } else {
    console.log(`   判据够得着的运行 ${cc.recordedRuns} 次${cc.unrecordedRuns > 0 ? ` (另有 ${cc.unrecordedRuns} 次没记这一位, **不进分母**)` : ''}`);
    const fmt = (r: number | null): string => (r === null ? '算不出 (分母 0)' : `${(r * 100).toFixed(1)}%`);
    console.log(`   conductor 面 (output+facts+产物内容): ${cc.conductor.nodes} 节点 / ${cc.conductor.rounds} 轮 → 检出 ${cc.conductor.findings} 条  [${fmt(cc.conductor.rate)}]`);
    console.log(`   flat 面      (output+facts, 不读产物): ${cc.flat.nodes} 节点            → 检出 ${cc.flat.findings} 条  [${fmt(cc.flat.rate)}]`);
    console.log('   ⚠ 两面**不许相加**: 宽度不同 (一个读盘一个不读), 加起来的比例没有意义。');
    // 样本够不够 —— 门槛先于数据钉死 (CLAIM_CHECK_MIN_NODES 上面那段写了为什么是 60)。
    for (const [face, s] of [['conductor', cc.sufficiency.conductor], ['flat', cc.sufficiency.flat]] as const) {
      console.log(
        s.enough
          ? `   ${face.padEnd(9)} 样本**够了** (${s.nodes} ≥ ${CLAIM_CHECK_MIN_NODES} 节点) → 上面那个比例可以当结论读`
          : `   ${face.padEnd(9)} 样本**不足**, 还差 ${s.short} 个节点 (${s.nodes}/${CLAIM_CHECK_MIN_NODES}) → 上面那个比例**不是结论**`,
      );
    }
    if (!cc.sufficiency.conductor.enough && !cc.sufficiency.flat.enough) {
      console.log('     两面都不足 = 现在**还不到拨闸的时候**, 继续被动攒 (正常使用即可, 不必专门发跑)。');
    }
  }
  if (cc.samples.length > 0) {
    console.log(`   检出原句 (前 ${cc.samples.length} 条 —— **拨闸靠逐条读它判是不是误伤**):`);
    for (const smp of cc.samples) console.log(`     · [${smp.runId ?? '无 runId'}] ${smp.message.slice(0, 150)}`);
  }
  console.log('   判据 (写死在这儿, 免得事后编):');
  console.log(`     · **先过样本关**: 该面 ≥ ${CLAIM_CHECK_MIN_NODES} 节点才谈得上读基率 (rule of three:`);
  console.log('       0 检出 / 60 节点 → 真实基率 95% 上界 5%)。不够就是不够, 不许"看着差不多";');
  console.log('     · 活体误伤 = 0 (逐条人工核对) **且** 扩语料全绿 → 才谈得上拨成硬拦;');
  console.log('     · 活体基率 ≈ 0 (真跑里几乎没有伪造声称) → **维持 report-only 是合法结论**,');
  console.log('       那是"这条闸没有值得付的对象", 记下来收尾, 不是拖延。');
  console.log('     ⚠ report-only ≠ 零影响: 三条出口里只有账本是真零影响, judge 视图那一路仍会改判词。');

  console.log(`\n⑧.6 运行时写竞争 (2026-08-06 新通道 —— 此前这条路上一行代码都没有)`);
  console.log('   ⚠ 上面那张表里的 `write-race` 是**跑之前**按 output_path 声明判死的坏 plan (static-lint),');
  console.log('     **不是**运行时并发撞车。同名不同义, 而两者的下一步相反: 前者改图, 后者要问');
  console.log('     这两个 leaf 为什么碰同一个文件。台账此前拿前者的数当后者的证据。');
  const wr = contract.write_race;
  if (wr.recordedRuns === 0) {
    console.log(`   这批 ${wr.unrecordedRuns} 条记录**都没记** (早于 2026-08-06)。跑一次新的才有这段读数。`);
  } else {
    console.log(`   记了的运行 ${wr.recordedRuns} 次${wr.unrecordedRuns > 0 ? ` (另有 ${wr.unrecordedRuns} 次没记, **不进分母**)` : ''}`);
    console.log(`     执行窗口重叠的节点对 ${wr.overlaps} 对 → 其中**两侧都报过写** ${wr.pairs} 对 (= 撞得上的机会)`);
    console.log(`     → 真撞了 ${wr.findings} 对  [${wr.rate === null ? '算不出 (分母 0)' : `${(wr.rate * 100).toFixed(1)}%`}]`);
    // ── 推断口径 (2026-08-06 补: 写的可见性) ──────────────────────────────────
    // 上面那两个数只认**受控写工具**。command 节点那一路从不填 filesTouched, agent 既用受控
    // 工具又用 bash 写时 bash 那部分也隐形 —— 于是「看不见的那部分」里混着一大块**其实认得出**
    // 的写。这一档把它挖出来, 但**单独记**: 它的证据比受控写弱, 而升不升闸恰恰要看这个分野。
    if (wr.pairsInferred === null) {
      console.log(`     ⚠ ${wr.overlaps - wr.pairs} 对是**看不见的**: 一侧没报写 —— 可能真没写, 也可能写了而 filesTouched`);
      console.log('       够不着 (command 节点走 shell 就是这样)。这批记录都没记推断口径 (早于 2026-08-06),');
      console.log('       所以这一块今天还分不开。跑一次新的就有下面那一档。');
    } else {
      console.log(`     ─ 推断口径 (并进"命令点名要写 + 盘上核实过"的候选, 证据比受控写**弱**):`);
      console.log(`       机会 ${wr.pairsInferred} 对 → 真撞 ${wr.findingsInferred} 对` +
        `  [${wr.rateInferred === null ? '算不出 (分母 0)' : `${(wr.rateInferred * 100).toFixed(1)}%`}]`);
      console.log(`       其中 ${wr.pairsInferred - wr.pairs} 对**只有推断才看得见** (command 节点 / agent 的 bash 写)。`);
      console.log(`     ⚠ 还剩 ${wr.overlaps - wr.pairsInferred} 对是**一侧没有可见的写**。这一格压着**两件下一步相反的事**:`);
      console.log('       ① **真的没写** —— 那一侧本来就是只读的 (实测: command 节点 113/113 条命令都不写,');
      console.log('          它们是拿来读和断言的)。这种"看不见"是**正确的**, 不该去补什么;');
      console.log('       ② **写了但看不见** —— 命令原文里认不出写目标 (`git apply` / `> "$OUT"` /');
      console.log('          目录级 rsync, 见 SHELL_WRITE_BLIND_SPOTS)。这种才该补判据。');
      console.log('       ⚠ 今天**分不开这两件** (引擎不记"这个节点有没有打算写")。所以这一格');
      console.log('         **不进任何机会分母** —— 但也别读成"有一大块写看不见", 那是只念了 ②。');
      console.log('     ⚠ 严格与推断两档**不许相加也不许互相替代**: 前者是受控写工具的事实, 后者含推断');
      console.log('       (`a && b > x` 里 a 失败时 x 并没有被写)。要升闸先看 findingsInferred - findings 有多大。');
    }
    for (const [name, s, meaning] of [
      ['重叠对数', wr.sufficiency.overlaps, '"这台引擎到底并不并发"可以判了'],
      ['机会对数', wr.sufficiency.pairs, '**严格口径**的撞车基率可以当结论读了'],
      ['推断机会', wr.sufficiency.pairsInferred, '**推断口径**的撞车基率可以当结论读了'],
    ] as const) {
      console.log(
        s.enough
          ? `     ${name} 够了 (${s.nodes} ≥ ${LOOP_NO_MOVE_MIN_N}) → ${meaning}`
          : `     ${name} **不足**, 还差 ${s.short} (${s.nodes}/${LOOP_NO_MOVE_MIN_N}) → 这一槽还判不了`,
      );
    }
  }
  // ── command 节点那一侧到底写不写 (2026-08-06) ─────────────────────────────
  // 「推断口径不涨」有两种成因, 下一步相反: 判据太窄 vs 这些命令本来就不写文件。
  // 这一格直接数命令原文, 于是不必等 ⑧.6 攒够就答得出来。
  const cw = contract.write_race.commandWrites;
  if (cw.distinct > 0) {
    console.log(`   ▸ command 节点这一侧: ${cw.commands} 次执行 / ${cw.distinct} 条不重复命令,`);
    console.log(`     其中**认得出写目标的 ${cw.withTargets} 条**` +
      `${cw.withTargets === 0 ? '  ← 这台引擎的 command leaf 是拿来读和断言的, **它不写**' : ''}`);
    if (cw.withTargets === 0) {
      console.log('     ⚠ 这个 0 是**正确的零, 不是判据漏认** (实测拆开: 纯读 grep/rg/cat/wc 占大头,');
      console.log('       其余是 bun test / tsc 验收)。→ **想靠收窄 SHELL_WRITE_BLIND_SPOTS 抬推断分母,');
      console.log('       先看这一格有没有变** —— 今天推断口径的输入几乎全来自 agent leaf 的 bash 写。');
    }
  }
  // ── 2026-08-06 回溯验过一次 (不是这块板算的, 是拿 checkpoint 重建的) ──────────────
  console.log('   ▸ **历史回溯的一次实测** (2026-08-06, 拿 `.omd/continuity/*/` 的 checkpoint 重建):');
  console.log('     checkpoint 里有 `createdAt` + `durationMs`(可还原执行窗口)与 `outputPaths`');
  console.log('     (= `filesTouched` 相对化到该 run 的根)→ **历史上的重叠/机会/撞车可以重建**。');
  console.log('     69 个 continuity 目录 · 730 份节点 checkpoint → **重叠 1648 · 机会 30 · 真撞车 1**');
  console.log('     (`execute::repair_acceptance_probe_contract` 与另一个兄弟都碰了 `goal/acceptance.ts`)。');
  console.log('     ⚠ **必须带父子守卫**: 不带的话"撞车"是 46 条, 其中 45 条是 `execute × execute::<hash>`');
  console.log('       这种父子对 —— 父节点的 outputPaths 是子树并集, 它自己一个字都没写。');
  console.log('     → **并发写竞争在生产上确实发生**, 不是理论风险。上面那两档口径攒够之前,');
  console.log('       这条历史读数是目前唯一的活体证据; 把它接成一个常驻读数面是下一步该做的事');
  console.log('       (⚠ 接的时候要像 ⑨/⑫ 那样**标口径**: 它与上面两档的窗口来源和路径基准都不同)。');
  console.log('   判据 (在数据到达之前钉的):');
  console.log(`     · 重叠对数 ≥ ${LOOP_NO_MOVE_MIN_N} 而**推断**机会仍 ≈ 0 → 并发是有的, 而两条判据都看不见谁写了什么`);
  console.log('       → 该补的是**认得出的写法**(SHELL_WRITE_BLIND_SPOTS 那四条), 不是这条判据;');
  console.log('     · 推断机会在涨而**严格**机会不涨 → 写全在 command/bash 那一侧。那本身是一条读数:');
  console.log('       它说的是"这台引擎上的写主要不经受控工具", 而受控工具正是产物闸的视野所在;');
  console.log(`     · 机会对数 ≥ ${LOOP_NO_MOVE_MIN_N} 且真撞 0 → 并发写在真跑上不发生, 这条收尾, 别升成闸;`);
  console.log('     · 真撞 > 0 → 逐条读: 撞的是不是同一个"共享目录"型文件 (那是图的形状问题),');
  console.log('       还是两个 leaf 各自的产物恰好同名 (那是命名问题)。两者的改法不一样。');
  console.log('   ⚠ **只报不拦**: 出口是账本 + 观察条目。窗口取 [起跑, leaf 返回], 比真正的写窗口宽 ——');
  console.log('     方向是宁可多算一对重叠 (多算落在**分母**上, 把基率往低了报, 不会凭空造出命中)。');

  console.log(`\n⑨ run 级终止原因 (N5 · 此前这一层只有 plan_name + 一堆节点状态, 没有"这跑怎么结束的")`);
  // ⚠ **口径警示 (2026-08-06 补)**: 这一段与 ⑫ 那行 `outcome:` 数的**不是同一批东西**, 而它们
  //   印在同一页上、用同一个词。差在两处:
  //     ① 单位 —— 这里数**留痕记录**, ⑫ 按 **runId 归并** (`dag_goal` 一次跑落两条记录);
  //     ② 窗口 —— 这里是**全量**, ⑫ 只取最早 `limit` 个 run。
  //   ⑫ 上面那句「run 统计 (分布/判据/entry) = 窗口」描述的是它自己那一段, 而本段同样是
  //   run 级分布、同样带判据, 却既不归并也不截窗 —— 于是那句话反过来会让人以为这里也是窗口。
  //   实测 (2026-08-06): 56 条记录 / 53 个 runId (3 个 runId 各落 2 条), 而 ⑫ 那行只有 20。
  //   **归并的失真很小, 窗口的差是 2.8 倍** —— 后者才是会让人读错的那一个。
  {
    const runIds = new Set(rows.map((r) => r.run_id ?? r.id));
    console.log(
      `   口径: **全量留痕记录** ${rows.length} 条 / ${runIds.size} 个 runId` +
        `${rows.length !== runIds.size ? ` (${rows.length - runIds.size} 条是 dag_goal 的第二段)` : ''}` +
        ` —— ⚠ 与 ⑫ 那行 \`outcome:\` **不可比**: 那一行按 runId 归并且只取最早 ${limit} 个 run。`,
    );
  }
  if (outcomeRecorded === 0) {
    console.log(`   这批 ${rows.length} 条记录**都没记** outcome (早于 2026-07-31) —— 那是「没记」,`);
    console.log('     不是「归不了类」。跑一次新的 dag_run / dag_goal 才有这段读数。');
  } else {
    for (const kind of RUN_OUTCOME_ORDER) {
      const n = outcomeCount[kind];
      if (n === 0) continue;
      const info = RUN_OUTCOME_INFO[kind];
      const bar = '█'.repeat(Math.round((n / outcomeRecorded) * 24));
      const resume = info.resumable === null ? 'resume?' : info.resumable ? '可原样 resume' : '**别原样 resume**';
      console.log(`   ${kind.padEnd(19)} ${String(n).padStart(4)}  ${pct(n / outcomeRecorded).padStart(6)}  ${(info.loopState ?? '—').padEnd(9)} ${resume.padEnd(16)} ${bar}`);
      console.log(`       判据: ${info.evidence}`);
      console.log(`       下一步: ${info.nextAction}`);
      const set = outcomeSamples.get(kind);
      if (set?.size) console.log(`       图: ${[...set].join(', ')}`);
    }
    if (outcomeCount.unclassified > 0) {
      console.log(`   ⚠ **${outcomeCount.unclassified} 条记录归不了类** —— 收尾路径里还有一条没交代自己是怎么回事。`);
    }
    if (runsUnrecordedOutcome > 0) {
      console.log(`   ? 另有 ${runsUnrecordedOutcome} 条**没记**终止原因(早于 2026-07-31)—— 老数据, 不是缺陷。`);
    }
    // ── blocked 了, 然后呢 (S3 收件箱的分母, 2026-08-06) ──────────────────────
    // S3 建收件箱的理由是「无人值守的产出必须有去处」。而唯一的铸票点在 `goal.ts`:
    // **goal 跑以 blocked 收场**才铸 fork。于是 `dag_run` 那条路上的 blocked 没有去处 ——
    // 那不一定是缺陷 (dag_run 是同步的, 调用方就在跟前), 但**它决定了收件箱的分母**。
    // 实测 2026-08-06: blocked 4 次**全部来自 dag_run**, 于是收件箱 0 forks / 0 directives。
    // ⚠ 那是「**没机会**」不是「路断了」—— 两者的下一步相反 (前者继续等, 后者去修链路)。
    if (outcomeCount.blocked > 0) {
      const byEntry = rows.filter((r) => r.outcome === 'blocked').map((r) => normalizeEntry(r.entry) ?? '(没记)');
      const goalish = byEntry.filter((e) => e === 'solve' || e === 'dag_goal').length;
      console.log(`   ▸ **blocked 了, 然后呢** (S3 收件箱的分母): ${outcomeCount.blocked} 次 blocked,`);
      console.log(`     其中来自 goal 路径的 **${goalish} 次** ← **只有它们会铸 fork 进 owner 收件箱**`);
      console.log(`     (其余 ${outcomeCount.blocked - goalish} 次来自 ${[...new Set(byEntry.filter((e) => e !== 'solve' && e !== 'dag_goal'))].join('/')} —— 同步入口, 调用方就在跟前, 不铸票)`);
      if (goalish === 0) {
        console.log('     ⚠ 于是收件箱至今**一行都没有过**。那是「**没机会**」不是「路断了」——');
        console.log('       两者的下一步相反: 前者继续等, 后者去修链路。别把这个 0 读成后者。');
      }
    }
    console.log('   判据 (与 ⑦ 分开看, 两段各答各的):');
    console.log('     · blocked 与 not-converged 长期分得开 → G5「触发并被正确读」那半格才算真站住;');
    console.log('     · infra-error 常年占一块 → 该修的是引擎, 不是 prompt (那是五态里此前上层空着的格);');
    console.log('     · 若 99% 都落 not-converged → 这张表在上层是镀金, 该收回去。');
  }

  // ── ⑩ 四轴 ──────────────────────────────────────────────────────────────────
  console.log('\n⑩ score 四轴试算 (N9 · 先在这块板上试, 别急着推 Langfuse)');
  console.log('   四条轴各报各的覆盖度, **不合成总分** —— 合了以后"这条轴没数据"会被别条的数盖住。\n');

  console.log('   判据轴 —— 收敛判据(judge) 与 冻结判据(验收命令) 说的是不是一回事');
  if (critRecorded === 0) {
    console.log(`     ${critRuns.length} 次运行里**没有一次**记了两条判据。`);
    console.log('     成因有两种, 后续动作不同: ① 这些是 dag_run —— 它没有 judge / 冻结判据这两条判据,');
    console.log('     这条轴对它本来就不适用; ② 是 goal 但早于 2026-07-31。跑一次 dag_goal 才有这段读数。');
  } else {
    console.log(`     两条都说成了                  ${String(critAgree).padStart(4)}  ${pct(critAgree / critRecorded)}`);
    console.log(`     judge 说成了·判据没过         ${String(critOracleFailed).padStart(4)}  ${pct(critOracleFailed / critRecorded)}   ← judge 太**松**`);
    console.log(`     judge 说没成·判据却过了       ${String(critWastedRounds).padStart(4)}  ${pct(critWastedRounds / critRecorded)}   ← judge 太**紧**, 白转了几轮`);
    console.log(`     两条都说没成                  ${String(critAgreeFail).padStart(4)}  ${pct(critAgreeFail / critRecorded)}`);
    if (critNoVerif > 0) console.log(`     ? 另有 ${critNoVerif} 次没记两条判据 (dag_run 不适用 / 老数据) —— 不进分母。`);
    console.log('     读法: 中间两格是**对称的两种病**, 而此前只有上面那格有名字 (`oracle-failed`) ——');
    console.log('           于是"judge 太紧"这一侧一直看不见。两格都长期接近 0, judge 才当得起准绳。');
  }
  console.log('\n   效率轴 —— $ / cacheHit / 复用率 / 轮数');
  const allCache = runs.map((r) => r.cacheRate).filter((x): x is number => x !== null);
  const cacheAvg = allCache.length ? allCache.reduce((a, b) => a + b, 0) / allCache.length : null;
  console.log(`     cacheHit (${allCache.length} 跑均值)        ${pct(cacheAvg)}`);
  // 有座位属于**已知不报缓存**的家族时, 这个均值是**系统性偏低**的: `leavesCacheHit` 把"没报"
  // 与"零命中"加在了同一个分子上。不说的话读的人会以为命中率真的这么低, 去优化一个不存在的问题。
  const mutedRuns = runs.filter((r) => [...r.models].some((m) => capsFor(m.split(':').pop() ?? m)?.reportsCacheHit === false));
  if (mutedRuns.length) {
    const coords = [...new Set(mutedRuns.flatMap((r) => [...r.models]).filter((m) => capsFor(m.split(':').pop() ?? m)?.reportsCacheHit === false))];
    console.log(`     ⚠ 其中 ${mutedRuns.length} 跑含**已知不报缓存**的座位 (${coords.join(' · ')}) —— 上面那个均值偏低,`);
    console.log('       它把"这家不报"和"零命中"加进了同一个分子。这半边算不出来是**已知**, 不是引擎漏记。');
  }
  if (pricedRuns > 0) {
    console.log(`     $ 叶子部分 (${pricedRuns} 跑合计)      $${leafUsd.toFixed(4)}   均 $${(leafUsd / pricedRuns).toFixed(4)}/跑`);
  } else {
    console.log('     $ 叶子部分                    —— 没有一跑定得出价');
  }
  const skipped = [
    mixedSeatRuns ? `${mixedSeatRuns} 跑混合座位(usage 是聚合的, 分不到各坐标头上, 硬算等于编账)` : '',
    noCoordRuns ? `${noCoordRuns} 跑没记模型坐标(老数据)` : '',
    unpricedCoordRuns ? `${unpricedCoordRuns} 跑坐标不在价表里` : '',
  ].filter(Boolean);
  if (skipped.length) console.log(`     ? 未计价: ${skipped.join(' · ')}`);
  console.log('     ⚠ 这是**叶子那部分**的钱, 不是整跑的钱 —— conductor 自己不是节点, 它的坐标没记。');
  if (reuseRuns.length > 0) {
    console.log(`     复用率 (${reuseRuns.length} 跑)            ${reusedTotal}/${reuseNodeBase} 节点  ${pct(reuseNodeBase ? reusedTotal / reuseNodeBase : null)}`);
  } else {
    console.log('     复用率                        整批都没记 (2026-07-31 才加的位)');
  }
  if (runsWithLoop > 0) {
    console.log(`     轮数 (${runsWithLoop} 跑 · ${loopJournals} 个内环)  合计 ${roundsTotal} 轮  均 ${(roundsTotal / loopJournals).toFixed(1)} 轮/内环`);
  } else {
    console.log('     轮数                          这批里没有一跑读得到内环 journal (见停止轴末尾的三态)');
  }

  console.log('\n   诚实轴 —— 引擎有没有在报告自己做砸了 / 不知道');
  if (notDoneNodes === 0) {
    console.log('     这批记录里没有一个没过的节点 —— 分母是 0, 这两个率**算不出来**(不是 0%)。');
  } else {
    console.log(`     empty-artifact                ${String(emptyArtifact).padStart(4)}/${notDoneNodes}  ${pct(emptyArtifact / notDoneNodes)}   谎报完工被产物闸抓住`);
    console.log(`     节点级 unclassified           ${String(nodeUnclassified).padStart(4)}/${notDoneNodes}  ${pct(nodeUnclassified / notDoneNodes)}   归因面自己的洞`);
  }
  console.log(`     run 级 unclassified           ${String(runUnclassified).padStart(4)}${outcomeRecorded ? `/${outcomeRecorded}  ${pct(runUnclassified / outcomeRecorded)}` : ''}`);
  console.log('     读法: 两个 unclassified 是**缺陷计数**不是分布 —— 它们该趋近 0, 不该"稳定在某个比例"。');

  console.log('\n   停止轴 —— blocked 与 not-converged 分不分得开 (= G5 的后半句)');
  console.log(`     blocked        ${String(stopBlocked).padStart(4)}`);
  console.log(`     not-converged  ${String(stopNotConverged).padStart(4)}`);
  if (outcomeRecorded === 0) {
    console.log('     整批都没记终止原因 —— 这条轴今天读不出来。');
  } else if (stopSeparable) {
    console.log('     → 两格都有量: 这个区分在生产上**兑现了**。');
  } else {
    console.log('     → 有一格恒为 0: 区分**还没在生产上兑现**。判据不是"两个数都非零"那么松 ——');
    console.log('       只要一格空着, 「blocked 被念成 not-converged」这条就还没被证伪。');
  }
  console.log('');
  console.log('     内环那一层 (NodeLoopJournal.stop) —— 从 continuity journal 读:');
  if (loopStopRecorded === 0) {
    console.log(`       ${loopJournals} 个内环里没有一个记了 stop` + (loopJournalsNoStop ? ` (${loopJournalsNoStop} 个是早于 N6 的老 journal)` : ''));
  } else {
    for (const [kind, n] of [...loopStopCount].sort((a, b) => b[1] - a[1])) {
      const sample = loopStopSamples.get(kind)!;
      console.log(`       ${kind.padEnd(18)} ${String(n).padStart(3)}  ${pct(n / loopStopRecorded)}  停在第 ${sample.atRound} 轮`);
      console.log(`         判词原文: ${sample.evidence.slice(0, 96)}${sample.evidence.length > 96 ? '…' : ''}`);
    }
    if (loopJournalsNoStop > 0) console.log(`       ? 另有 ${loopJournalsNoStop} 个内环没记 stop (早于 N6) —— 不算进分母。`);
    console.log('       ★ 这一层与 run 级的 blocked/not-converged **是同一套词表** (N6 刻意借的 N5 词表) ——');
    console.log('         两层若长期说不同的话, 那本身就是读数: 环里判 blocked 而整跑报 not-converged,');
    console.log('         正是 N5 治的那个病在下一层复发。');
  }
  console.log(`       覆盖: ${runsWithLoop} 跑读到了内环 · ${runsNoLoopData} 跑读不到`);
  console.log('       ⚠ "读不到"是**合并格**: 这次没有带内环的节点(最常见, 不是缺陷) / journal 目录被清了');
  console.log('         两者在这块板上分不开 —— 留痕库永久而 journal 跟着 .omd/continuity 走。不假装分得清。');

  printReadoutHuman(contract, dbPath);
  printNewSegments(contract, dbPath);
  console.log(`\n诚实边界: 本板读**两处** —— 留痕库 (永久) + continuity journal (跟着 .omd/continuity 走,`);
  console.log(`清掉就没了)。**它算不出的**: 单节点耗时 (没记)、judge 判词原文 (只存了停止那一条)、`);
  console.log(`conductor 那部分的 $ (它不是节点, 坐标没记 —— ⑩ 里算的是叶子那部分)。`);
  console.log(`不要因为这里没有就当它不存在 —— 那是 \`Unobserved\` 不是 \`Missing\`。\n`);

  db.close();
  mcpDb?.close();
}


function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}
