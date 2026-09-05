/**
 * 叶执行注入接缝(INV-X1/X3):executor-dag 只认这些**接口形状**,不 import 任何执行实现。
 * 形状 = 私有上游 agent-leaf.ts / command-leaf.ts / model-router.ts 的公开契约原样
 * (provenance: 私有上游 worktree 时点)。
 * 实现方:宿主注入 pi-agent runner;或生产侧注入
 * omd-pi provider runner(随 provider slice)。测试注入 fake。
 */
import type { ContentPart, ModelUsage } from '../model/gateway';
import type { AcceptanceOutcome } from './acceptance-run';
import type { SelfCheckSpec } from './conductor-plan';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { LeafProfile } from './profiles/profile';
import type { AnyOmdTool } from './agent-tools';
import type { ReadEvent } from './read-ledger';
import type { CriteriaDiff } from './dag/spin-rung2';

// ── agent leaf(带工具的 pi session,能改文件)────────────────────────
export interface AgentLeafInput {
  /** 完整执行 prompt(已含 node 目标 + fan-in 上下文)。 */
  prompt: string;
  /** 'provider:modelId'。 */
  model: string;
  /**
   * 碰撞台账会话标识 (SDD S3, 只记不拦): 引擎侧 runId+节点维度稳定 id (如 `${runId}:${nodeId}`)。
   * runner 跨 run 复用 (MCP 长驻进程) → 会话只能**按调用**传, 不能烤进 runner 装配期。
   * 省略 = 本次调用不记 (runner 级 `AgentLeafRunnerOpts.touch` 仍在时回落其 session)。
   */
  touchSession?: string;
  /**
   * 本次调用允许调用的外部 MCP 工具 (SDD D-7): 引擎侧 `node.mcp ∪ 模板卡 mcp` 的去重并集
   * (元素 = server 名或 "server:tool", 同 C-5 闸判据)。缺省/空 = deny 全部副作用类 MCP 工具 ——
   * leaf 是执行叶子, 不声明不授权 (chat 座位的 'allow' 缺省不传染叶子)。runner 跨 run 复用 →
   * 只能**按调用**传, 不能烤进 runner 装配期 (同 touchSession 那条)。
   */
  mcpAllow?: string[];
  /**
   * **本次调用允许写的路径**(引擎侧取自 `node.write_set`)—— 写域闸的判据面,
   * `write` / `edit` 在**写的那一刻**判,越界当场拒。
   *
   * 缺省 = **闸缺席, 放行**(conductor 铺图路径 / plan 没写 `write_set`)——
   * 那是「没配这道闸」不是「这个节点没越界」(NULL≠0≠不适用)。
   * ⚠ 只管工具通道: leaf 的 bash 绕得过去, 那一侧的边界是 jail 的 worktree。
   */
  writeAllow?: string[];
  /**
   * 内部事件汇 (SDD D-8, 2026-08-11): runner 把本次调用的**内部工具事件** (tool_execution_start/end)
   * 转发给它 —— 引擎在节点调 runner 时挂节流转发器, 转成 DAG 的 `progress` 事件 (节流在引擎侧,
   * 与 chat 通道同形: 回调抛错被吞, 永不影响执行)。省略 = 不转发 (零开销, 老 runner 行为不变)。
   */
  onEvent?: (e: AgentEvent) => void;
  /**
   * 已解析的岗位档案 (SDD 2026-08-11-leaf-profile库 D-3): 引擎侧 `node.profile` 经 `resolveProfile`
   * 解出 → **按调用**传 (runner 跨节点复用, 不能烤进构造期 opts, 同 touchSession 那条)。
   * 省略 = 本次调用无 profile, 与 opts 级 `AgentLeafRunnerOpts.profile`(构造期兼容回退)二选一由
   * runner 实现决定优先序。profile 内容不进 promptVersion (INV-2, 与 persona 同边界)。
   */
  profile?: LeafProfile;
  /**
   * #178: 产物意图 —— 引擎侧 producesFiles 路由为真时**按调用**传 (值 = node.output_path;
   * 无显式路径传 '(路径见 goal)')。在场 = 本叶必须写入产物, agent-leaf 据此启用 produce-by
   * 软推 (勘探超预算仍零写 → 注入一次催产指令, pi 通道; SDK 通道同 grind 边界只记不注)。
   * 缺席 = 非产物叶, produce-by 恒不触发 —— 非 produces-files 节点零行为变化 (#178 硬约束)。
   */
  expectsArtifactPath?: string;
  /**
   * D2: attach_media:true 的 agent 节点把直接前驱输出里解析出的图片附到本轮 prompt。
   * 元素形状 = mimo-leaf 的 ContentPart(image_url 形 data URI / http URL,引擎侧
   * `collectDepMedia` 的产物,逐字透传,runner 不再做二次解析)。
   *
   * 缺省 = 无图,首条 user 消息照旧纯文本,**逐字节等同现状**(INV-6)。
   * pi 通道: runner 把 image_url parts 转 pi `ImageContent` 后拼到首条 user 消息 parts。
   * SDK 通道: SDK 的 `prompt: string` 字段不接受 image — 走响亮旁路 (具名常量日志 + 在
   * prompt 文本里附图片路径清单与「用 view_image 查看」指令,工具面兜底让 agent 真看到像素)。
   */
  promptImages?: ContentPart[];
  /**
   * S2 (2026-08-25, 片 2) — rung 2 fresh-context 派发标记 (D-6): 显式、可审计。
   * 出现 = 本次调用是 rung 2 fresh-context 重派, 同模型 + 丢消息历史。
   * 缺省 (undefined) = 普通调用, 行为与切片前逐字节相同。
   * production runner 现状每次调用起新会话 (943), 本字段为可审计标记。
   */
  freshContext?: boolean;
  /**
   * S2 (2026-08-25, 片 2) — rung 2 seat-upgrade 目标座位 (D-3): 覆盖本调用的 model。
   * 出现 = 引擎决定升 leaf 座位, runner 应使用本字段而非 input.model。
   * 缺省 = 不升级, 沿用 input.model (普通调用形状不变)。
   */
  targetSeatCoord?: string;
  /**
   * S2 (2026-08-25, 片 2) — rung 2 证据携带 (D-4): 档 1 注入包的摘要 + 失败原因 + 判据 diff +
   * 卡点签名。fresh-context 丢消息历史不得丢这些显式证据。
   *
   * 缺省 = 普通调用, runner 不注入证据。`criterionDiff` 类型 = `CriteriaDiff`
   * (与 `SpinLadderReading.criterionDiff` 同源, 片 1 冻结)。
   */
  rung2Evidence?: {
    packHash: string;
    failureReason: string;
    criterionDiff: CriteriaDiff;
    blockerSignature: string;
  };
  /**
   * **节点级确定性判据** (P1 C-2, 2026-08-21): agent leaf 在内环将停时跑这条命令, 退出码
   * `=== expect_exit` → 该节点收敛; 不等 → 引擎**借 pi 的 `getFollowUpMessages` 钩子**把
   * (命令 + 实际退出码 + 截断输出) 作为 follow-up 注入, 同节点再转一轮 —— 而非新建节点、
   * 改图、进毒集 (INV-2-3)。
   *
   * 缺席 = 旁路 (INV-1-2): 执行路径与无 self_check 逐字节相同。SDK 通道 (Claude 订阅) 显式
   * 不启用 (INV-2-1): 该通道无 `getFollowUpMessages` 钩子, 不许静默降级 —— agent-leaf 在
   * self_check 存在且走 SDK 时 WARN 日志一条说明。**借用的诚实边界**: pi 的 followUp 原设计是
   * 交互式 steering, headless 当自动喂料通道是借用 (D-6), 借完要明写。
   */
  self_check?: SelfCheckSpec;
  /**
   * P2e (2026-09-02): **本次调用**的超时上限 (ms), 由引擎侧 `remainingBudgetMs()` 按目标
   * 剩余预算算出 —— 与 `AgentLeafRunnerOpts.leafTimeoutMs`(构造期固定兜底, 默认 1h)是两件事。
   * 有效超时 = `Math.min(本字段, opts.leafTimeoutMs)`(只收紧不放宽, 收紧闸单一真源在
   * agent-leaf.ts 里算, 因为只有那里同时看得到两个数)。
   * 缺席 = 本次调用不受目标预算约束, 沿用 opts 级兜底 (老调用方逐字节零回归)。
   */
  leafTimeoutMs?: number;
  /**
   * P3 S6b (2026-09-02): **按调用指定的工具面 + system prompt**(编排循环的 conductor 节点用)。
   * 在场 = 本次调用的工具面恒等于 `toolNames` ∩ runner 内置工具 ∪ `customTools`, system prompt 恒等于
   * `systemPrompt`; 精益面 / 座位极简面 / profile 三条缺省策略与 scaffold 前缀**全部不进**。
   * 缺席 = 老路径逐字节不变。只由引擎按 `ExecutorDagConfig.leafFace` 钩子按节点下发,
   * 不进 plan (闭包不可序列化)。
   */
  face?: LeafFace;
  /**
   * P3 S7 (D-18, 2026-09-02): **本次调用**的 thinking 档 —— 引擎侧按 `node.thinking ?? seatThinking(model)` 算出后
   * 按调用传; 座位表没给档时**缺席** (不是 'high' 兜底), 让 runner 各通道保持自己的缺省 (pi xhigh / SDK medium)。
   * 优先序在 agent-leaf `resolveLeafThinking`: opts.thinkingLevel (A/B 钉档) > OMD_AGENT_EFFORT > 本字段 > 通道缺省。
   */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
}

/**
 * P3 S6b: 一次 agent 调用的完整面 —— 工具名单 + 追加工具 + 整份 system prompt。
 * `customTools` 是**按调用**的闭包 (conductor 的七张派工卡要拿当次 run 的引擎 config 派子图),
 * 所以不能烤进 runner 装配期的 `AgentLeafRunnerOpts.customTools`。
 */
export interface LeafFace {
  /** runner 内置工具里要保留的名字 (如 read / ls / grep / bash)。 */
  toolNames: readonly string[];
  /** 按调用追加的工具 (conductor 的七张派工卡)。 */
  customTools?: readonly AnyOmdTool[];
  systemPrompt: string;
  /**
   * 名单里的 `bash` 包成只读 (P3 D-20 机械面, 2026-09-03): 写文件 / 改仓 / 改环境的命令走 tool result 拒,
   * 见 `conductor/readonly-shell.ts`。缺省 false = bash 原样。
   */
  readOnlyShell?: boolean;
  /** R-1: 只读闸每拒一次调一次 (计数进 loop 账本)。缺席 = 不计。 */
  onReadOnlyBlocked?: () => void;
  /**
   * W2 读账观察口 (2026-09-06, 契约 `docs/plan/2026-09-06-墙钟与读次数-执行契约.md`):
   * 名单里的 `read` / `ls` / `grep` / 只读形态的 `bash` 在**返回之前**各调一次。
   *
   * **必须走这条按调用的路** —— 工具是 runner 装配期建一次、跨 run 复用的, 把某一趟的账烤进
   * 装配期就会把上一个 conductor 读过的东西交接给这一个 (同 `writeAllow` / `touch` 那条纪律)。
   * 缺席 = 不记, 四个工具的返回字节与本字段出现之前逐字相同。只报不拦: 抛错吞掉留证据。
   */
  onToolObserved?: (ev: ReadEvent) => void;
  /**
   * **这副面的"有进展"读数** —— grind 停滞钟的进度信号,单调不减。缺席 = 叶子口径
   * (写入一个新文件路径才算进展, 见 agent-leaf 的 `lastTouchGrowthAtMs`)。
   *
   * ## 为什么必须可换 (2026-09-05, R0/R1 实账)
   *
   * grind 三档读的是 `lastTouchGrowthAtMs`, 而它**只在写入新文件路径时推进**。conductor 的
   * 手是 `['read','ls','grep','bash']` + 派工卡, `readOnlyShell: true` —— 它**结构上不可能写文件**,
   * 它派 `work()`。于是那口钟永远停在 `startedAt`, `stall ≡ wall`, 三档谓词退化成:
   * 600s 必 advisor · 900s 必 wrapup · **1500s 必 abort**, 派得再好照砍。
   * 实账对得上: R0 的 `stallAtAbort=1536108ms` ≈ 节点全寿命 = 钟一次没走过。
   *
   * 所以这不是"conductor 拿了 worker 的预算", 是**拿了一把量不了它的尺子**。调大常数只是把
   * 必然的 abort 推后; 豁免又会让真卡住的 conductor 无人管。正解是**换尺子不换闸**:
   * 每种角色报自己的进展,一套熔断照常有牙。
   *
   * ⚠ 与 `#178 produce-by` 同构 —— 那条轴早就用 `expectsArtifact` 把非产物叶摘了出去
   * (所以 conductor 天然豁免 produce-by); grind 三档从没拿到同样的待遇, 这里补上。
   *
   * ⚠ 报什么算进展由**面自己定**, 别在 runner 里按工具名猜: conductor 的 `help` 与被拒的派工
   * 走同一个工具名, 按名字认会让它靠刷被拒的派工把熔断钟按住。
   */
  progress?: () => number;
}

/**
 * leaf watchdog 采集的**单一真源形状** (2026-08-18 收敛; 此前 AgentLeafResult / LeafResult /
 * NodeCheckpoint 三处手抄同形, b87196e 加 grind 字段时只改了生产侧 —— 类型静默漂移的实证)。
 * 生产/透传/写盘三处都引用本接口: 加字段改这里, 漏改任何一处直接 tsc 红。
 *
 * 缺席语义 (NULL ≠ 0 ≠ 不适用, 全仓同一条纪律):
 * - 整个 `watchdog` 缺席 = 非 agent 叶 / 该 runner 不统计 / 老记录, **不代表**"量过了且没触发"。
 * - 存在时 `stalled`/`timedOut` 恒写 boolean —— `false` = 量过了且没发生, 不许用缺席表示 false。
 * - grind 三字段 (`advisorFiredAt`/`wrapupFiredAt`/`abortedByGrind`) 在**写入的真相**里是可选的:
 *   缺席 = S1 时代老记录 / 该 runner 不统计新档 (盘上真实存在这批 checkpoint, required 会让
 *   类型对旧数据撒谎); 现役生产侧的恒写纪律由 {@link LiveLeafWatchdog} 收紧到类型层。
 * - `touchTimelineMs`/`toolTimelineMs` 是距叶启动的相对毫秒数 (升序), 不是绝对时间戳。
 * - `spin` 仅在 `spinEvents > 0` 时出现, 同 drift-detector 惯例。
 */
export interface LeafWatchdog {
  stalled: boolean;
  timedOut: boolean;
  touchTimelineMs: number[];
  toolTimelineMs: number[];
  /**
   * grind advisor 软看门狗触发时刻 (S3), 距叶启动的相对毫秒数, 与 `touchTimelineMs` 同口径。
   * 现役生产恒写: `null` = 量过了且没触发 (LiveLeafWatchdog 收紧); 缺席 = 老记录/不统计。
   * 触发后保持非空 —— 每叶至多 1 次, 不重试不硬停。
   */
  advisorFiredAt?: number | null;
  /** grind advisor 诊断原文 (S3)。缺席/undefined = 没触发; 触发时非空, 与 `advisorFiredAt` 成对。 */
  advisorAdvice?: string;
  /**
   * grind 二档 wrap-up 触发时刻 (2026-08-17, #146), 距叶启动的相对毫秒数, 同 `advisorFiredAt` 口径。
   * 现役生产恒写 `null` = 量过了且没触发 (INV-5); 缺席 = 老记录/不统计。触发后保持非空,
   * 严格次于 advisor, 各至多 1 次。
   */
  wrapupFiredAt?: number | null;
  /**
   * grind 三档 abort 是否触发 (2026-08-17, #146)。`false` = 量过且没发生, `true` = 三档全过
   * 仍停滞, 节点判 failed + failureKind 'spin-fused' (INV-5)。缺席 = 老记录/不统计。
   */
  abortedByGrind?: boolean;
  spin?: { spinEvents: number; maxSameCount: number };
}

/**
 * 现役 agent-leaf **生产侧**形状: grind 三字段恒写 (INV-5 —— 忘写任何一个 = tsc 红, 这正是
 * b87196e 那次漂移的类型层闸)。写盘/透传侧 (LeafResult / NodeCheckpoint) 用宽的 LeafWatchdog。
 */
export type LiveLeafWatchdog = LeafWatchdog & Required<Pick<LeafWatchdog, 'advisorFiredAt' | 'wrapupFiredAt' | 'abortedByGrind'>>;

/**
 * 一道闸在**本次调用**里的在场态 (2026-09-01)。**缺席是一个有名字的值, 不是空。**
 *
 * - `enforced` = 本次调用**声明了**这道闸的判据面 (清单/会话 id 在场), 闸真在判;
 * - `unavailable` = **没配这道闸**。⚠ 这**不等于**"这个节点没越界 / 没碰文件 / 没调 MCP"
 *   —— 那是三件事 (仓规 §静默坑 1 NULL≠0≠不适用)。
 *
 * ⚠ `unavailable` 之后的**回落方向逐闸不同**, 这个词只说"没配", 不说"因此拒":
 *   · `writeAllow` → **fail-open 放行** (conductor 铺图路径 / plan 没写 `write_set`);
 *   · `mcpAllow`   → **fail-closed deny 全部副作用类工具** (leaf 不声明即不授权);
 *   · `touchSession` → 碰撞台账**这次不记** (只记不拦, 本来就不影响执行)。
 */
export type LeafGatePosture = 'enforced' | 'unavailable';

/**
 * 本次调用三道闸的在场态 (2026-09-01)。
 *
 * 为什么要它: 在此之前「闸缺席」与「闸判过且合规」在结果里**长得一模一样** ——
 * `writeDenials` 缺席既可能是"没配写闸", 也可能是"配了且一次都没越界", 事后分不开
 * (`AgentLeafInput.writeAllow` 的注写着"闸缺席, 放行", 而那句话没留在任何一条读数里)。
 * 本字段把缺席变成显式态: 三道闸各报各的, 读结果的人不必反推。
 *
 * **只报不判**: 本字段不改变任何一道闸的判据与回落方向 (缺省仍是缺省), 只让它可分辨。
 */
export interface LeafGateStates {
  /** 写域闸 (`AgentLeafInput.writeAllow`)。`[]` = 声明了"什么都不许写" → 仍是 `enforced`。 */
  writeAllow: LeafGatePosture;
  /** 外部 MCP 授权闸 (`AgentLeafInput.mcpAllow`)。空清单 = 没声明 → `unavailable` (deny 全部)。 */
  mcpAllow: LeafGatePosture;
  /** 碰撞台账会话 (`AgentLeafInput.touchSession`)。`unavailable` = 本次触碰一条都不进台账。 */
  touchSession: LeafGatePosture;
}

export interface AgentLeafResult {
  text: string;
  usage: ModelUsage;
  /**
   * **`run_acceptance` 台账**(P3 S2, 2026-09-02)。三态: 整个字段缺席 = 本次没派冻结判据(旁路);
   * `null` = 派了但没有 acceptance 作用域(wrapper 被绕过, 留证据);对象 = 派了 —— `ran` 只认
   * `run_acceptance` 的调用次数 > 0, 模型自己 bash 敲的一律不算;`last` 是最后一次的结构化结果。
   */
  acceptance?: { ran: boolean; rounds: number; last: AcceptanceOutcome | null } | null;
  /**
   * 本次调用**脚手架**的版本哈希(2026-07-31)—— 进 Langfuse 的 `promptVersion`。
   *
   * 为什么由 runner 报而不是让 executor 从 prompt 反算:runner 按本次模型档在三套脚手架里挑
   * (strong-core / discipline+tool-routing / off),挑了哪套只有它自己知道;而整条 prompt 里
   * 含本节点的 goal 与上游材料,**逐节点都不同** —— 拿它算出来的"版本"每个节点一个值,
   * 分不了组,等于没有版本。省略 = 不登记版本(inproc leaf 那条路由 system 段算,见 promptVersionOf)。
   */
  promptVersion?: string;
  /** 本次 leaf 经 write/edit 族工具触碰的文件(continuity 接缝;去重)。**相对路径的根见 cwd。** */
  filesTouched?: string[];
  /**
   * 写域闸撞墙计数 (刀②, 2026-08-30 闸门三角结): 被拒目标路径 → 本次调用内被拒次数。
   * 只在**有过撞闸**时出现 —— 缺席 = 没撞过 (闸缺席的调用也缺席, 与「撞 0 次」在引擎侧
   * 同处置, 不必分)。引擎按「同路径 ≥2」上抛 write-wall observation 进外环重画输入面。
   */
  writeDenials?: Record<string, number>;
  /**
   * 本次调用三道闸的**在场态** (2026-09-01)。形状与语义的真源 = {@link LeafGateStates}。
   *
   * 缺席语义 (NULL ≠ 0 ≠ 不适用): **整个字段缺席 = 该 runner 不报在场态** (注入的 fake runner /
   * 老记录), **不代表**三道闸都没配。生产 agent-leaf 恒写 —— 缺席与 `'unavailable'` 分得开。
   */
  gates?: LeafGateStates;
  /**
   * 本次 leaf 经 **read 族工具**读过的文件(D-12,与 filesTouched 同形、同一个 cwd 根)。
   *
   * 为什么要它: `filesTouched` 只记**写**,于是"B 读了 A 写的文件但图上没有 A→B 这条边"这类
   * **图外数据流**在引擎眼里完全不存在 —— 制品级毒因此只抓得到写方(而写方本来就已被指纹票抓到),
   * 真正抓不到的消费方 B 恰恰是唯一的增量(SDD D-12)。有了它,`plan/artifact-lint` 才报得出
   * 「未声明的制品依赖」,复用滤镜才拦得住「读过被拒制品的节点」(INV-P2-4/5)。
   *
   * ⚠ **诚实边界**: 只收单文件读工具(`read` / `hashline_read`)。`grep`/`ls`/`glob` 是**检索**不是
   * 消费,把它们记进来会让 lint 淹在噪声里(一次 grep 命中十个文件不等于依赖那十个文件)。
   * bash 里的 `cat` 同样收不到 —— 与 filesTouched 漏 bash 重定向是同一条已知边界。
   */
  filesRead?: string[];
  /**
   * filesTouched 里相对路径的**解析根** = 本 runner 的 cwd。
   *
   * 为什么必须由结果自己带: 产物校验闸原本拿 `continuity?.repoRoot ?? process.cwd()` 当根 ——
   * 而 agent runner 的 cwd 可以是任意目录 (worktree / 子项目)。两者不一致时, 闸拿错根去查存在性,
   * **把写对了文件的节点判成 empty-done**, 下游整片级联 skip。2026-07-26 实测复现:
   * filesTouched=["eval-app/src/board.ts"] 文件真在 worktree 里, 闸却按 omd 仓根查 → 误杀。
   * 省略 = 调用方回落老行为。
   */
  cwd?: string;
  /**
   * 本次 leaf 的工具调用次数 (按 tool_execution_start 计)。**prompt 档的路由效率读数** ——
   * 工具路由那一段教的就是"该用 codegraph 时别拿 grep 凑", 而档位改动的效果只有在这个量上
   * 才看得见 (同样过闸, 调了 8 次工具还是 30 次, 差的是钱和墙钟)。省略 = 该 runner 不统计。
   */
  toolCalls?: number;
  /**
   * 本次 leaf 的 **LLM 调用次数** (R-1, 2026-09-03)。pi 通道 = `turn_end` 事件计数 (一轮 = 一次模型响应);
   * SDK 通道 = 按 API message id 去重的 assistant 消息数 (同一次调用按 content 块拆成多条, id 相同)。
   * **与 toolCalls 两回事**: 一轮可发多个工具调用, 也可零工具直接收尾。省略 = 该 runner 不统计 (老 runner / 替身)。
   * 它是「M3 调用/题」按 conductor / worker 分解的引擎侧唯一来源 —— 桥日志一文件一请求只能按批算, 分不到题。
   */
  llmCalls?: number;
  /**
   * R-1 第 3 步 (2026-09-03, D-18 读数面): 本次 leaf **实际用的** thinking 档 (resolveLeafThinking 之后的值) 与通道。
   * 引擎下发的档与 runner 用的档可以不同 (OMD_AGENT_EFFORT 钉档 / 通道缺省不同), 读侧靠这一格看见。省略 = 老 runner / 替身没报。
   */
  thinking?: { level: 'off' | 'low' | 'medium' | 'high' | 'xhigh'; channel: 'pi' | 'sdk' };
  /** 早期心跳闸判定的停摆(issue #5): provider 挂起/排队, 未等满硬超时即中止。executor 据此标 failed +
   *  留 stall 败因(而非把近零输出当 done)。省略/false = 正常完成或硬超时。 */
  stalled?: boolean;
  /**
   * 空转熔断理由(2026-08-14, drift fuse)。非空 = 循环被熔断闸硬停(软注入没拉回来的深度空转),
   * executor 据此标 failed + `spin-fused` 败因。省略 = 没熔断。与 `stalled` 分开:那是 provider
   * 没反应,这是模型有反应地原地打转 —— 下一步相反(见 node-failure 的 spin-fused 注)。
   */
  spinFused?: string;
  /**
   * #178 produce-by 软推触发次数 (恒 ≤1, 每叶至多一次)。仅触发时出现 (同 `spin` 仅在
   * spinEvents>0 时出现的惯例) —— 缺席 = 没触发或非产物叶; 分母 (产物叶总数) 由引擎侧
   * expectsArtifactPath 的传参面提供, 不在本字段上编码。
   */
  produceByNudges?: number;
  /**
   * agent leaf watchdog 采集 (2026-08-12, S1 埋点)。形状与缺席语义的真源 = {@link LeafWatchdog};
   * 生产侧取恒写收紧版 {@link LiveLeafWatchdog} (grind 三字段 required, INV-5)。
   */
  watchdog?: LiveLeafWatchdog;
  /**
   * 本次 leaf 的空转累计 (2026-08-03, G5)。缺席 = 没跑 drift 检测 (关掉了 / 非 agent leaf)。
   *
   * **以数据回传而不是回调**: drift 的 `onSpinning`/`onRecovered` 是函数, 而隔离档的 leaf
   * 跑在 bwrap 子进程里, 只有 JSON 安全的东西过得了那道边界 —— 那两个回调在隔离档上
   * 结构性接不了, 这就是它们至今零消费者的原因。本字段是频率读数; 停机语义在 `spinFused`
   * (2026-08-14 起, 读数收够后由熔断闸接)。
   */
  spin?: { spinEvents: number; maxSameCount: number; stuckSigs: string[] };
  /**
   * **效果指标** (2026-07-31, 承 Loop Engineering §8.5「静默失败」)。省略 = 该 runner 不统计。
   *
   * `filesTouched` 回答的是「碰过哪些文件」, 而 §8.5 指出那还不够:
   *
   * > 工具调用确确实实发生了, 返回码也是成功的, **但产出物没有任何实质变化** …… 比如 agent
   * > "修改"了一个文件, 但写入的内容和原文件完全一致。这类失败连"报错"这个最基本的警报信号都没有。
   *
   * 我们已经为这条链付过两次账, 每次都只补深一级:
   *   2026-07-29 —— 补「文件**真在盘上**」(反捏造判词打在真做完的活上)
   *   2026-08-03 S1 —— 补「文件**里写了什么**」(judge 看不见内容 → 内容验收类目标倾向永不收敛)
   * 第三级就是这一条: **写进去的和原来一样, 等于没写**。前两级都拦不住它 —— 文件在、内容也在,
   * 只是这次调用什么都没改变。
   *
   * 只报不判: 本字段不参与产物闸的通过与否 (一次 no-op 写完全可能是正当的 —— 上一轮已经写对了、
   * 这一轮复核了一遍)。它的用途是**让"看起来做了"和"真的做了"在读数上分得开**, 判要不要因此
   * 判失败, 得先有分布。
   */
  writeEffects?: FileWriteEffect[];
  /**
   * 本次 leaf 的**工具调用序列**(按发生顺序,2026-08-16)。省略 = 该 runner 不统计。
   *
   * 有界:超过 {@link TOOL_STEPS_CAP} 时保**头 + 尾**(同 `failureExcerpt` 的截断口径 ——
   * 中间截掉是因为两头才是诊断要看的:开头是它怎么起手,结尾是它卡在哪)。
   * 截了多少写在 {@link AgentLeafResult.toolStepsDropped},**不许静默截断**。
   */
  toolSteps?: ToolStep[];
  /** 被截掉的步数。缺席/0 = 没截。有值时 `toolSteps` 是头尾拼的,中间不连续。 */
  toolStepsDropped?: number;
  /**
   * 本次 leaf 经 **bash 工具**跑过的命令 + 退出码(2026-08-05)。省略 = 该 runner 不统计。
   *
   * 为什么补这条: agent leaf 手里有 bash,「我跑了 `bun test`,3/3 通过」是**诚实自验**的
   * 主要形状 —— 而引擎此前对它零记录(`toolCalls` 只有次数)。于是「产物声称的引擎校验动作 ⊆
   * 引擎记录的动作」这个谓词的**记录集缺了主要合法元素**,子集检查的误报是结构性的:
   * 真跑过测试的诚实节点与顺手编一句的节点,在引擎眼里长得一模一样。
   *
   * ⚠ `exitCode` 缺席 ≠ 0:命令被闸拒 / 起不来 / 平台没给退出码都是缺席,
   * 编一个 0 出来就是把"没记"伪装成"跑通了"。`ok` 由 exitCode===0 判,缺席即 false。
   */
  shellRuns?: ShellRun[];
  /**
   * **L0 写后即验注入了几条**(2026-08-16)。缺席/0 = 一条都没注(该 runner 不统计,
   * 或这个 leaf 从头到尾写的文件都解析得过)。
   *
   * 为什么要这个读数:这一层的收益是**避免掉的东西**(一次整节点冷重跑),
   * 而避免掉的东西不留痕 —— 不记它的话,"它起没起作用"事后无从判断。
   * 判法是把它与本节点的终态配起来看:
   *
   * | `parseNudges` | 节点终态 | 读法 |
   * |---|---|---|
   * | > 0 | done | **自愈成功**:一次冷重跑被省掉了(或者它本来就在分刀改 —— 见下方混淆项) |
   * | > 0 | `broken-artifact` | 注了但没修好 —— 硬闸照常接住,只多花了几十 token |
   * | 0 | `broken-artifact` | **这一层漏了** —— 损坏不是经受控写工具造成的(bash 重定向?),去看 `shellRuns` |
   *
   * ⚠ **混淆项要写在这**:「注了 + done」里分不出「它是被提醒才修的」与「它本来就要
   * 分两刀改、下一刀自然修好」。分开这两者需要节点内的因果,而那是 `toolSteps` 的活。
   * 所以这一格**不许**被读成"省下了 N 次重跑" —— 它是上界不是点估计。
   */
  parseNudges?: number;
  /**
   * **节点级 self_check 自修环的落账** (P1 C-4, 2026-08-21)。
   *
   * `null` 严格区分于 `{rounds: 0, …}`:
   *   - `null` = 该节点**没有** self_check (旁路, INV-1-2) — 「这条路不适用」;
   *   - `{rounds: 0, …}` = 有 self_check, **判据一次就绿**, 没注 follow-up (INV-4-1)。
   * 分辨靠 `AgentLeafInput.self_check` 字段在不在, **不靠猜**。
   *
   * 字段形状 (INV-4-2/INV-4-3):
   *   - `rounds` = 实际自修轮数 (注了几次 follow-up);
   *   - `oracleExit` = 每一轮 self_check 的实际退出码, **含首轮** (长度 = rounds + 1);
   *   - `convergedAt` = 第几轮转绿 (首轮 = 0; 始终没绿 = null) — `null` ⟺ `oracleExit` 末项 `!== expect_exit`。
   *
   * SDK 通道 (Claude 订阅) 永远 = null (INV-2-1: 无 followUp 钩子, 节点级判据不被听见)。
   */
  selfRepair?: { rounds: number; oracleExit: number[]; convergedAt: number | null } | null;
}
/** 一次 bash 工具调用的确定性痕迹(命令原文 + 退出码)。 */
export interface ShellRun {
  /** 命令原文(截断防爆;截断标注见 executor 的 facts 渲染)。 */
  command: string;
  /** 内核给的退出码。**缺席 = 没拿到**(闸拒 / 起不来 / 被中止),不是 0。 */
  exitCode?: number;
  /** `exitCode === 0`。缺席的退出码一律 false —— 不许把"没记"读成"跑通了"。 */
  ok: boolean;
  /**
   * 该命令的**输出尾**(片 3m, 2026-08-23) —— 单行(连续空白已压平、无换行)、
   * 有上限(`{@link SHELL_OUTPUT_TAIL_CAP}`)、取末尾。verifier 要的是
   * 「这条命令打印了什么」(判词常驻尾部:`6694 pass / 0 fail`、编译错误汇总、
   * 栈尾),而引擎此前只记了命令与退出码 —— 通道是通的, 没接的只是输出那一位。
   *
   * 缺席语义 (NULL ≠ 0 ≠ 不适用):
   * - **整个 `outputTail` 缺席** = 该命令没产生输出 (内容缺席 / 空串 / 压平后为空) ——
   *   「这条路不适用」,不是"采到了空串"(仓规 §静默坑 1)。
   * - 字段在 ⇒ 长度 ≤ 上限、不含 `\n`, 取的是**末尾**那段。
   */
  outputTail?: string;
}
/** `outputTail` 单条上限(字节 / 字符数 = JS `.length`)。契约 D-6 钉「有上限且是常量」;
 *  实测量级: 单条 `bun test` 摘要 + 几行错误栈尾通常 < 800, 取 2000 留余量又不至于
 *  一次跑飞的节点把 `shellRuns` 撑爆。 */
export const SHELL_OUTPUT_TAIL_CAP = 2000;
/** 一次成功的写调用**实际改变了什么**(§8.5 效果指标)。 */
export interface FileWriteEffect {
  /** 写的目标路径(与 filesTouched 同一个 cwd 根)。 */
  path: string;
  /** 写后行数 − 写前行数。文件此前不存在 → 写前按 0 行算(于是新建文件的 delta = 全文行数)。 */
  lineDelta: number;
  /**
   * 写完之后内容与写之前**逐字相同** = 这次调用什么都没做。
   *
   * ⚠ 新建一个**空文件**也是 `noop: false`(此前不存在 → 现在存在, 那是真变化)。
   * 判据是「内容变没变」, 不是「delta 是不是 0」—— 换掉同样多的行, delta = 0 而 noop = false。
   */
  noop: boolean;
}
/**
 * 一步工具调用的**确定性痕迹**(2026-08-16,#145 提议 2 复盘补的那一位)。
 *
 * ## 为什么这一位非补不可
 *
 * 已有的三本账各答各的,**没有一本答得了"它按什么顺序做了什么"**:
 * `toolCalls` 只有次数 · `watchdog.toolTimelineMs` 只有时间戳没有名字 ·
 * `drift.stuckSigs` 只在**空转时**才有签名。于是下面这些问题今天结构上答不出来:
 *
 * - **hashline stale 之后有没有重新接地**。`hashline.ts:16` 是 **fail-soft** 的:
 *   stale 标签被拒只返一段文本,靠 `hashline.ts:66` 那条 prompt 规则叫模型
 *   「STOP,重 hashline_read 接地,别在没重读的输出上继续叠行号编辑(会复合腐烂)」——
 *   而本仓已有**五个** "prompt 规则按不住" 的实例。判据的可执行版就是一句序列判断:
 *   *「这个节点里出现了 `hashline_edit` 的 noop,而此后没有一次 `hashline_read` 就又发了 edit」*
 *   —— 零启发式、零模型判断,但它**要求知道顺序**,而顺序今天没人记。
 * - **§8.5 那条攒了一年的分布**(`leaf-runners.ts` 的 `writeEffects` 注:「要不要因此判失败,
 *   得先有分布」)。今天只有 `[写调用数, noop 数]` 两个标量,分不出"复核了一遍"(正当)
 *   与"被 stale 连拒三次"(病)—— 而这两者的下一步正相反。
 *
 * ## 只记**看得见**的,不记推断
 *
 * 工具名与路径都取自 pi 的 `tool_execution_start/end` 事件原文;`noop` 取自同一次调用的
 * `diffWriteEffect`。**不猜**:非读写工具没有 `path`(bash 的写目标是另一条链的活)。
 */
/**
 * 工具序列上限(头 300 + 尾 100)。实测量级:run C 单节点最多 125 步、空转熔断那次 84 步 ——
 * 400 足够装下正常与病态两类,而不至于让一次跑飞的节点把 checkpoint 撑爆。
 */
export const TOOL_STEPS_CAP = 400;
/** 截断时保留的头部步数(尾部 = `TOOL_STEPS_CAP - TOOL_STEPS_HEAD`)。 */
export const TOOL_STEPS_HEAD = 300;

export interface ToolStep {
  /** 工具名原文(`bash` / `read` / `hashline_read` / `hashline_edit` / `write` / `edit` / …)。 */
  tool: string;
  /** 目标路径。读写工具才有;`hashline_edit` 一个 patch 多文件时取第一个(全集在 filesTouched)。 */
  path?: string;
  /** 这次调用报错了(pi 的 `isError`)。**缺席 = 没报错**,不是"不知道"。 */
  error?: boolean;
  /**
   * 写工具专用:写完之后内容与写前**逐字相同**。
   * ⚠ 这正是 hashline stale 被拒的指纹 —— 工具返回"成功"(fail-soft 返文本),而盘上没动。
   */
  noop?: boolean;
}

/** 注入点:executor-dag 的 agent-kind 节点经此跑。 */
export type AgentLeafRunner = (input: AgentLeafInput) => Promise<AgentLeafResult>;

// ── command leaf(确定性 CLI,零 LLM)────────────────────────────────
export interface CommandLeafInput {
  /** 要跑的 CLI 命令串(conductor 产出,经闸+白名单校验)。 */
  command: string;
  /**
   * 节点声明的写集 (刀④, 2026-08-30 闸门三角结): `>` 重定向目标的判据面。
   * 缺席 = 没立写集合同 → 重定向一律拒 (fail-closed), 与「空数组 = 什么都不许写」同判。
   */
  writeSet?: readonly string[];
}
export interface CommandLeafResult {
  text: string;
  usage: ModelUsage;
  /**
   * 子进程退出码。**`null` ≠ 0**:`null` = 死于信号(没有主动退出码),0 = 自己正常退 0。
   *
   * 三字段**互不推断**(H5, 2026-08-19):`timedOut` 由超时闸上报、`exitCode` 与 {@link signal}
   * 从运行时的内核观测直读。禁止「`exitCode !== 0` ⇒ 超时」、禁止用 124 哨兵覆写真实退出码、
   * 禁止把信号折成 `128+n` 当退出码。于是 `{ timedOut: true, exitCode: 0, signal: null }`
   * 这个合法组合(超时被杀、进程自己优雅退 0)必须分辨得出来。
   */
  exitCode: number | null;
  /** 超时闸响了没有。`false` = 量过且没超时(不是"不知道")。 */
  timedOut: boolean;
  /** 杀死子进程的**实际**信号。`null` = 正常 exit,不是"不知道";不许拿「我发了什么」冒充「它怎么死的」。 */
  signal: string | null;
}
/**
 * 注入点:executor-dag 的 command-kind 节点经此跑。
 *
 * ⚠ **实现方不许在这后面加缓存**(2026-08-01,量过之后删掉了原来那个):同一命令串必须每次真跑。
 * 判据与实测读数见 `command-leaf.ts` 里 `CommandLeafRunnerOpts` 下方那段注 + 图鉴 S-9。
 */
export type CommandLeafRunner = (input: CommandLeafInput) => Promise<CommandLeafResult>;

// ── research leaf(真 web 检索 + 有界内环的研究节点)──────────────────
export interface ResearchLeafInput {
  /** 研究问题 (= 节点 goal, 已含 fan-in 上下文)。 */
  question: string;
  /** 上游节点输出当事实锚 (防幻觉); 省略 = 只有问题本身。 */
  groundTruth?: string;
  /** 检索召回条数上限 (k, 候选 URL 池大小)。 */
  k?: number;
  /**
   * 镜头数 (广度旋钮, A1): 1..6。透传给 `researchWebFanout` 的 `opts.lensCount` → `authorFanoutSpec`。
   * 与 `k` 分开: k = 召回面, lensCount = 综合面 (council 拆多少个视角)。
   * 省略 = conductor 自定 (现行为, 零回归)。
   */
  lensCount?: number;
  /** second-pass 轮数上限 (**有界内环** — INV-GOAL-4: 节点内环必须有界)。 */
  rounds?: number;
  /** 镜头分解: 缺省/true = conductor 按问题自适应出镜头; false = 固定档 (省一次分解调用)。 */
  council?: boolean;
  /** 深档: 种子 query 作者化 (3-4 个互补角度各自检索) + provider 池全并行去重。默认关。 */
  deep?: boolean;
  /**
   * S2 (2026-08-10): 报告文件名基准 —— dag_research 进程化后 runId 由调用方 (母进程) 生成,
   * 透传下来让报告与 registry runId 同源 (一 run 两 id 必漂)。省略 = 内部自造 (executor
   * research 节点原语义, 零变化)。
   */
  runId?: string;
}
export interface ResearchLeafResult {
  /** 研究终稿正文 (进下游节点的 fan-in)。 */
  text: string;
  usage: ModelUsage;
  /**
   * **真抓到正文的 URL** (INV-GOAL-2 的证据面)。空数组 = 没有任何真检索痕迹 →
   * executor 判 failed, 拒绝"引用来自模型记忆"的假 grounded 通过。
   */
  sources: string[];
  /** 报告全文写盘路径 (宽出: 节点输出只带终稿, 细节自己 Read)。 */
  reportPath?: string;
}
/** 注入点:executor-dag 的 research-kind 节点经此跑。未注入 = research 节点判 failed (不静默降级)。 */
export type ResearchLeafRunner = (input: ResearchLeafInput) => Promise<ResearchLeafResult>;

// ── leaf 模型路由(ε-greedy bandit;静态 fallback = no-op)──────────────
export interface LeafModelRouter {
  /** 给 bucket 选模型坐标;pool 空/单 → 返 fallback(no-op = 静态)。 */
  select(bucket: string, fallback: string, category?: string): string;
  /** 记一次 reward(∈[0,1])给 (bucket, model);pool ≤1 或 model ∉ pool → no-op。 */
  recordReward(bucket: string, model: string, reward: number): void;
}
// ── leaf telemetry 投影器(INV-2: 平铺,无嵌套 telemetry 层)───────────
// 7 个遥测字段的单一真源形状。AgentLeafResult (生产侧) / LeafResult (透传侧) /
// NodeCheckpoint (写盘侧) 都经 Pick 引用本类型 — 此前三处手抄同形,b87196e 加 grind
// 字段时只改了生产侧,类型漂移 6 天没人发现。引用同一类型后这类漂移直接 tsc 红。
// 字段形状对齐 AgentLeafResult: watchdog 取宽的 LeafWatchdog (写盘侧可松),
// spin/writeEffects 同 AgentLeafResult; pickLeafTelemetry 用 keep-undefined 策略
// (缺键不省略键),spin/writeEffects 缺席时补默认 {0,0,[]} / {[],[]},其余缺席 = undefined。
export type LeafTelemetry = {
  watchdog?: LeafWatchdog;
  spin?: { spinEvents: number; maxSameCount: number; stuckSigs: string[] };
  writeEffects?: FileWriteEffect[];
  toolSteps?: ToolStep[];
  toolStepsDropped?: number;
  shellRuns?: ShellRun[];
  parseNudges?: number;
};

// 7 键的字面元组 —— 顺序冻结,加/删/改字面顺序都算违约。`satisfies` 只挡多写,
// 真正的穷尽闸在 _KeysEq: 双向 extends 相等 ⇒ 漏写任何一个直接 tsc 红。
export const LEAF_TELEMETRY_KEYS = [
  'watchdog',
  'spin',
  'writeEffects',
  'toolSteps',
  'toolStepsDropped',
  'shellRuns',
  'parseNudges',
] as const satisfies readonly (keyof LeafTelemetry)[];

// 双向相等闸(注释掉 KEYS 里任一键 → _KeysEq = false → tsc 红)。
// 用 union extends 而非 array extends tuple: tuple 与同元素 union 不等价,
// 反向 extends 恒 false。第一项挡多写, 第二项挡漏写, length 闸钉死 7。
type _KeysEq = typeof LEAF_TELEMETRY_KEYS[number] extends keyof LeafTelemetry
  ? keyof LeafTelemetry extends typeof LEAF_TELEMETRY_KEYS[number]
    ? typeof LEAF_TELEMETRY_KEYS['length'] extends 7
      ? true
      : false
    : false
  : false;
const _leafTelemetryGate: _KeysEq = true;

// 纯投影器 (INV-2: 7 键平铺, 无嵌套包裹层)。**缺席保缺席** —— 「没记」「量了为 0」「不适用」
// 是三件事 (仓纪律 NULL≠0), 这里绝不给 spin/writeEffects 编默认值; engine 侧同款判例:
// 「runner 没报 writeEffects → 保持 undefined, 不编一个 [0,0] 出来」。
// 加字段流程: LeafTelemetry 加键 → _KeysEq 逼 KEYS 同步 → 本函数经 KEYS 循环自动覆盖。
export function pickLeafTelemetry(r: Partial<LeafTelemetry>): LeafTelemetry {
  const out: Record<string, unknown> = {};
  for (const k of LEAF_TELEMETRY_KEYS) {
    const v = r[k];
    if (v !== undefined) out[k] = v;
  }
  return out as LeafTelemetry;
}
