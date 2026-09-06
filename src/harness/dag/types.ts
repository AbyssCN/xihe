import type { ContentPart, ModelUsage } from '../../model/gateway';
import type { Trailer } from '../report/trailer';
import type { AcceptanceOutcome } from '../acceptance-run';
import type * as Gateway from '../../model/gateway';
import type { AgentTemplate } from '../agent-templates';
import type { ConductorPlan } from '../conductor-plan';
import type { CavemanLevel } from '../caveman';
import type { AgentLeafRunner, CommandLeafRunner, LeafFace, LeafGateStates, LeafModelRouter, LeafWatchdog, ResearchLeafRunner, ShellRun, ToolStep } from '../leaf-runners';
import type { CheckpointManager } from '../continuity/checkpoint-manager';
import type { VerifierFn } from '../verifier';
import type { FaninSummaryConfig } from '../fanin-summary';
import type { ArtifactBudget } from '../plan/judge-artifacts';
import type { NodeFailureKind } from '../node-failure';
import type { RollbackAnchor } from '../writeset/rollback-anchor';
import type { BlameEntry, BlameResolution } from './blame';
import type { SpinRung2StampPools, SpinLadderReport } from './spin-rung2';

/**
 * Falsify 节点 mutation 规约 (SDD `sN-falsify` 2026-08-22, C-3 / INV-8)。
 *
 * 命令执行前在 `file` 上 apply 一行替换, 期望非零退出 (见 {@link FalsifyNodeExtras.expects_nonzero})。
 * 引擎层 (`runCommandNode` in engine.ts) 在执行 command 节点时:
 *   1) 读 `file` 全文存内存
 *   2) `oldText` 必须**唯一匹配** —— 0 次或 ≥2 次直接 `failed` (不跑命令, 不改文件)
 *   3) 应用 `newText` 替换并写盘
 *   4) `finally` 把内存里的原文写回 (任何出口都还原, INV-10)
 *
 * ⚠ `mutate` 与 `expects_nonzero` 是 passthrough 进 PlanNode 的字段
 * (`PlanSchema` 在 conductor-plan.ts 走 `.passthrough()`, 不进字段表), 编译面 (sdd-compile.ts)
 * 把它附在编译产物上, 运行期 engine / 读面用此类型断言取 —— 见 (s1) Slice 1 INV-4 / (s2) Slice 2 INV-8。
 * 不用 schema 字段是因为「判别力是否真的存在」是**执行期**事实, 规划期表达不出来
 * (期望非零是个语义, 不在 0..255 的 POSIX 码域里 —— 见 sdd-compile.ts INV-4 那段注)。
 */
export interface FalsifyMutate {
  /** 目标文件路径, 相对写集根 (`continuity.repoRoot ?? process.cwd()`) 解析; 绝对路径直用。 */
  file: string;
  /** 必须唯一匹配, 否则节点 `failed` 并点名匹配数 (INV-9)。 */
  oldText: string;
  /** 替换文本。允许包含 `|` 以外的任意字符, 不做模板/插值。 */
  newText: string;
}

/** Falsify 节点附带的执行语义 (挂在 passthrough 字段上, 与 `mutate` 同源)。 */
export interface FalsifyNodeExtras {
  mutate?: FalsifyMutate;
  /**
   * `true` = 退出码 ≠ 0 判 done, = 0 判 failed (INV-11)。
   * `undefined`/缺省 = 老语义 (退出码 `=== expect_exit` 才算 done, 0..255 POSIX 域)。
   */
  expects_nonzero?: boolean;
}

/** omd 本体编排的注入式模型调用 (单一注入点; 默认 callModel, 测试传 fake)。 */
export type GenerateFn = (req: {
  /**
   * content 常态 string; D-14v2 attach_media 媒体注入时为 ContentPart[] (与 gateway ModelMessage
   * 同构 — 媒体走标准消息形状而非旁路字段, 不认 parts 的 transport 大声失败, 不静默丢图)。
   */
  messages: { role: 'system' | 'user'; content: string | ContentPart[] }[];
  model: string;
  /** 推理档 (conductor=分解器 high / inproc leaf=high; → deepseek reasoning_effort)。省略=模型默认。 */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /** 输出 token 预算 (→ send maxTokens)。省略 = transport 默认 (4096)。conductor plan 输出随任务规模涨, 必须给足。 */
  maxTokens?: number;
  /**
   * **这一发是谁打的** (2026-07-31): 进可观测面的观测名, 形如 `conductor:execute` / `leaf:write-a`。
   *
   * 加它的原因是第一条真 trace 就暴露了问题: 默认 generate 把 `role` 写死成 `'omd-leaf'`,
   * 于是 Langfuse 上 conductor 的那一发和干活 leaf 的那一发**同名**, 分不出谁是谁、更看不出
   * 是哪个节点 —— 而"每个节点的 prompt 可审查"正是接观测的全部目的。
   *
   * 省略 = 回落调用方的默认名 (零回归)。**只进观测, 不进 prompt** —— 它不该改变模型看见的东西。
   */
  traceName?: string;
  /**
   * **这一发属于哪个 DAG 节点** (2026-07-31)。给了 → 观测面上挂到那个节点的 span 下;
   * 省略 → 挂 trace 根。
   *
   * 与 {@link traceName} 分开是因为**名字里切不出这件事**: `conductor:<nodeId>` (子图展开,
   * 后缀是节点) 与 `conductor:plan` (规划整张图, 后缀不是节点) 形状一模一样。此前靠切名字倒推,
   * 于是 `conductor:plan` 在 live trace 上挂了个叫 `plan` 的父 —— 而那个 span 从未存在过。
   *
   * 所以: **run 级调用(规划/修补/分类/halt-judge)一律不给**, 节点作用域的调用点才给。
   */
  traceNodeId?: string;
  /**
   * **这一发是第几次被闸拒回后的重问** (0 = 首问)。只进 per-seat 台账 (`seat-usage.jsonl`),
   * 不进 prompt、不进 Langfuse 名字。
   *
   * 加它的原因是 #144 洞 3: 一张坏图能烧掉 6+ 发规划 (leaf 档位闸 2 次 + escalation 补丁 3 次
   * + D-21 复用闸 1 次), 而这些发在账上与首问**长得一模一样** —— 「空转烧了多少」结构上答不出。
   * 省略 = 不适用 (不是规划发)。⚠ 别给非规划发写 0: 那会让"首问"与"不适用"混成一格。
   */
  traceRejectRound?: number;
}) => Promise<{ text: string; usage: ModelUsage }>;

/**
 * Seam 分组 (A1, 2026-08-17): ExecutorDagConfig 按能力拆成 8 个具名 seam 接口。
 * 结构类型不变 —— extends 的并 = 原扁平字段集, 对全部消费方零可见变化 (纯类型重排)。
 * 每个接口 = 一个可替换接缝; "字段/消费方" 目录由 scripts/gen-seam-catalog.ts 生成
 * docs/architecture/seams.md, `--check` 进测试闸 (seam-catalog.test.ts) 防漂移。
 * 新字段必须落进某个 seam 且在 src 里有真实消费方 —— 目录生成器对零消费方字段直接红。
 */
/** 模型座位 seam: 引擎各角色绑哪个模型坐标。装配层由座位表 (src/model/seats.ts) 解析注入。 */
export interface DagSeatsSeam {
  /** conductor 模型 'provider:modelId' (规划用, 我们=mimo:mimo-v2.5-pro)。**必填, 无硬默认。** */
  conductorModel: string;
  /** inproc leaf 模型 'provider:modelId' (生成/判断单发)。**必填, 无硬默认** —— 装配层由 'leaf' 座位解析。 */
  leafModel: string;
  /**
   * agent leaf 模型 (带工具改文件)。省略 = 同 leafModel; 装配层由 'agent' 座位解析。
   * (MiMo agentic flaky + 无 cache, 不适合工具循环 → agent leaf 走 DeepSeek; inproc 才用 MiMo 烧额度)。
   */
  agentLeafModel?: string;
  /**
   * conductor 升级模型 'provider:modelId' (verifier fail 时用更强模型重规划重跑)。
   * **provider 未注册 (没配对应 API key) → 自动不升级, 维持弱模型** (Nick: 没配 SOTA API 就维持弱)。
   * 省略 = 永不升级。
   *
   * 三个消费方: ① executor-dag 内部 verifier-fail 升级; ② 外层 fixpoint 的轮级升级
   * (`plan/iterate`); ③ **conductor 节点内环的轮级升级** (D-F 之后 —— 撤外层不该顺手把
   * "多轮不收敛就换更强的脑子"这个能力一起撤掉)。
   */
  conductorEscalationModel?: string;
}

/** 推理档 seam: 各角色的 thinking 档与输出预算 (S-T: 座位档由接线层注入, 显式永远赢)。 */
export interface DagThinkingSeam {
  /**
   * conductor 输出 token 预算 (plan JSON 随任务规模涨; thinking conductor 的推理可计入 completion)。
   * 省略 → env OMD_CONDUCTOR_MAX_TOKENS → 8192 (deepseek 系安全顶)。k3 大 plan 建议 32768。
   */
  conductorMaxTokens?: number;
  /** inproc leaf 推理档 (默认 high; mass fan-out 省成本, 不走 max — 那是 omd 设计 / best-of-N 的档)。 */
  inprocThinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * S-T 座位推理档查询 (坐标 → 档): auto-assign 把「模型 + 推理档」成对下发, 执行期按节点已钉的
   * 坐标反查该座位的档。接线层注入 (读 .omd/config.json 是接线层的活, 执行器不碰 IO);
   * 省略 / 返 undefined → 回落原有默认, 老 config 行为不变 (向后兼容)。
   * 优先序 (同 TPL-3 哲学: 显式永远赢): node.thinking > 本 config 的显式档 > 座位档 > 硬默认。
   * `seat` (P3 S7 跟进, 2026-09-02) = 引擎按派发桶给的座位提示 (conductor / agent / leaf): 让共用一个模型的
   * worker 与 lens 各拿各的档, 不被「共坐标取最高档」抬到 xhigh。省略 = 纯坐标反查 (老行为)。
   */
  seatThinking?: (coord: string, seat?: string) => 'off' | 'low' | 'medium' | 'high' | 'xhigh' | undefined;
}

/** 执行器 seam: 各 kind leaf 的可替换执行体与模型调用注入点 (引擎不直连 transport)。 */
export interface DagRunnersSeam {
  /** 注入式模型调用 (inproc leaf, 默认 callModel)。 */
  generate?: GenerateFn;
  /**
   * agent-kind leaf 的执行器 (带工具子 agent, 能改文件)。给则 `executor:'agent'` 节点经此跑;
   * 省略 → agent 节点降级为 inproc 单发 (无工具, 只生成文本) + warn。默认 createAgentLeafRunner。
   */
  agentRunner?: AgentLeafRunner;
  /**
   * command-kind leaf 的执行器 (确定性 CLI, 零 LLM, 方案 A)。给则 `executor:'command'` 节点经此跑
   * node.command (经 fail-closed 闸 + 白名单)。省略 → command 节点失败 (无 runner)。
   * codegraph / piolium 等"方法论+CLI工具"型能力的并行检索底座。
   */
  commandRunner?: CommandLeafRunner;
  /**
   * **换根时重建这两只手** (R5.1, 2026-09-07, 契约 `docs/plan/2026-09-06-并行实装扇出-执行契约.md`
   * D-R5.1-2)。
   *
   * 根因: 上面两只 runner 在**装配期**就把 cwd 烤死了, 而换树的调用方 (R5 扇出 / 隔离档) 只换得动
   * 状态锚 (`continuity.execRoot`)。bench 臂 code80-m3-fanout3 实测的代价: 三份并行尝试全部写进
   * **主工作区**, 各自 worktree 相对基线零改动 (30/30 份 diff 空)。
   *
   * 给了 ⇒ 换根方拿它重建两只手; **缺席 ⇒ 换根只换状态锚, 逐字节同旧** (INV-R5.1-3)。
   * 实现方 (`src/mcp/assemble.ts` 的 `buildDefaultConfig`) 复用同一个 overrideCwd 分支, 不写第二套参数。
   */
  forRoot?: (root: string) => Pick<ExecutorDagConfig, 'agentRunner' | 'commandRunner'>;
  /**
   * research-kind leaf 的执行器 (真 web 检索 + 有界内环, D-6)。给则 `executor:'research'` 节点经此跑。
   * 省略 → research 节点失败 —— **刻意不降级成 inproc**: 无 web 的 leaf 只会拿模型记忆编引用,
   * 那是假 grounded (与"写文件节点无 agentRunner → 失败"同一条纪律: 拒绝静默假成功)。
   */
  researchRunner?: ResearchLeafRunner;
  /**
   * executor leaf 模型选型路由器 (B-2 bandit, 见 model-router.ts)。省略 = 静态 (leafModel/agentLeafModel)。
   * 给则 inproc/agent leaf 经 router.select(bucket, 静态) 选模型, DAG 校验后按 reward 回更新。
   * pool 未配 → router no-op = 静态 (ship 安全)。node.model 显式给时仍最高优先 (绕过 router)。
   */
  router?: LeafModelRouter;
  /**
   * **leaf 级仓规检查清单** (D2 切片 2, #266 修补节点): 引擎对每个 agent leaf 跑完
   * 之后、终态写入之前, 对该 leaf 的写集跑清单里每条 check。引擎侧**只认这个形状**,
   * 一个仓库规则都不许硬编码 (INV-D2-1); 禁词表 / catch 证据纪律由仓库侧提供。
   * 省略 / 空数组 = 无清单, 行为与切片前逐字节相同 (零回归)。
   *
   * 接线点: `agent-leaf.ts` 的 `runOnce` 末段, 模型返回成功后。FAIL → 抛带 evidence
   * 的 Error, 引擎 L0 重试机制接住, 输出进 causeNote (leaf 上下文还热, 当场自修)。
   * UNVERIFIED → log warn + 继续 (INV-D2-4 fail-open)。三态语义沿用 `GateVerdict`。
   */
  repoChecks?: RepoCheck[];
  /**
   * **节点级空转档 2 阶梯配置** (SDD S2, 2026-08-25, 片 3 engine 接线)。
   *
   * - `threshold`: 档 2 选择 fresh-context 的累积 input token 阈值 (SDD 待决 #a, owner 数值未声明,
   *   仓内不宣称; 接线层注入)。`undefined` = ladder 不启用, 节点走既有 max_retry 路径
   *   (INV-8 存量语义不变)。
   * - `pools`: 装配层派生的 cheap/mid/strong 座位池, 升档选择器 (`pickHigherTierSeat`) 的入参。
   *   `undefined` = ladder 启用但换脑维度无候选 (试尽如实, 不会回退原模型并伪称换脑, INV-3)。
   *
   * 缺省 = 整条 ladder 不启用, 行为与切片前逐字节相同。
   */
  spinRung2?: {
    threshold?: number;
    pools?: SpinRung2StampPools;
  };
}

/**
 * 一条仓规检查 (D2 切片 2, #266)。引擎侧只认这个形状; 实际命令内容由仓库侧
 * 装配 (本仓在 `src/mcp/assemble.ts` 通过 env / config 注入)。
 *
 * - `id`: 仓规侧负责取唯一 (跨 run 可比, 账本可加)。
 * - `command`: shell 命令串, 可含 `{files}` 占位符 (替换为 shell-quoted 写集列表)。
 *   引擎**不**校验 / 不**修改**命令内容 — 那是仓库自己的事, 引擎只跑 + 判三态。
 */
export interface RepoCheck {
  id: string;
  command: string;
}

/** 规划管线 seam: conductor 的输入约束 (roster/模板) 与 plan 的确定性变换/过滤。 */
export interface DagPlanningSeam {
  /** 限定 conductor 可派的 agent roster (进规划 system prompt)。 */
  agents?: string[];
  /**
   * Agent 模板注册表 (name → 角色卡, 见 agent-templates.ts)。省略 = loadAgentTemplates()
   * (内置卡全量 BUILTIN_AGENT_TEMPLATES + cwd/.omd/agents/*.md 项目卡覆盖 —— 张数别背, 数字必漂,
   * 2026-08-17 实核已 9 张而此处写 5)。传 Map 注入 (测试 fake / 宿主定制);
   * 传空 Map = 关闭模板机制 (conductor prompt 无注册表段, 行为回退纯 persona)。
   */
  agentTemplates?: ReadonlyMap<string, AgentTemplate>;
  /**
   * conductor system prompt 档位 (SDD v2, 2026-07-25): 'full' (默认, 弱 conductor 教练全量) |
   * 'lean' (只留环境事实, 顶级 conductor 如 k3 用 — 教练是保守偏置疑压平分解)。
   * '-kb' 两档 (#171, 2026-08-18) = 基档 + 知识边界段, 仅供 conductor-modelmix A/B, 裁决前无默认消费者。
   * 'bare' (#182, 2026-08-19) = 零附加内容基线 (只留身份 + 分解指令 + 输出 schema), 供跑分对照, 无默认消费者。
   * 省略 → env OMD_CONDUCTOR_PROMPT ('full'/'lean'/'full-kb'/'lean-kb'/'bare', 非法/未设落 'full') → 'full'。
   * 档位由 A/B eval 定, 见 conductor-plan。
   */
  conductorPromptProfile?: 'full' | 'lean' | 'full-kb' | 'lean-kb' | 'bare';
  /**
   * oracle 命令 (如 "bun run typecheck && bun test"): plan 中 command 与之等价的节点
   * 在执行前被确定性过滤 (空白规范化后精确匹配, 最小无害边重连)。
   * 选型理由: oracle 已跑过该命令, conductor 重规划出等价节点 = 浪费 token + 时间。
   * 省略 = 不过滤 (向后兼容)。
   */
  oracleCmd?: string;
  /**
   * SDD v2 pass 管线 (plan-passes/): oracle 过滤之后、执行之前依序应用的确定性 plan 变换
   * (接线层组装 prune → dedup → stamp; INV-8 pass 纯函数, 配置由接线层闭包注入)。
   * 每轮 plan (conductor 首轮 + escalation 重规划轮) 都过同一管线。省略 = 不变换 (零回归)。
   * 抛错上抛 fail-closed — 坏 pass 不静默跳过 (与 parsePlan 校验同哲学)。
   */
  planFilters?: Array<(plan: ConductorPlan) => ConductorPlan>;
  /**
   * primitive 候选模型池 (SDD v2 D-8v2, INV-7): judge/parallel/tournament 原语的 N 路
   * attempts 按此池轮转分配 (跨家族多样性; 接线层从 stamp pools 注入)。省略 = 全部
   * attempts 用 leafModel (旧行为, 零回归)。
   */
  primitiveCandidates?: string[];
}

/** 调度与并发 seam: fan-out 上限、per-kind/per-channel 闸、暖发调度与协作式取消。 */
export interface DagSchedulingSeam {
  /** 内层 fan-out 并发上限 (传给 primitives.parallel)。省略 → primitives 的 OMD_MAX_FANOUT/CPU 兜底。 */
  maxFanout?: number;
  /**
   * **进程级** leaf 在飞上限 (P3 S8 / D-25 / INV-14, 2026-09-02): 一个进程里同时在飞的模型型 leaf (agent + inproc) 总数。
   * 与 `maxFanout` 的分工: 那个是**一张图**内的并发 (嵌套 run 各自一份, 互相看不见); 这个是整个进程的总数
   * (`dag/fanout-semaphore.ts`, 引擎起跑时 `configureLeafSlots` 一次)。省略 = 不动既有 cap (MCP 长驻进程里
   * 别的 run 可能已配); 装配层缺省 = `OMD_MAX_INFLIGHT_LEAVES` ?? 题内缺省 cap (不第二次解析 OMD_MAX_FANOUT)。
   */
  maxInflightLeaves?: number;
  /**
   * 暖发调度 (契约 §10.2): 全局先串行暖 1 发(写 cache)→ 再并行轰其余(命中共享冻结前缀)。
   * 关 = 同时轰(thundering herd, 共享前缀全 miss)。默认 false(单/双节点不值那一发串行延迟)。
   * ⚠ 2026-07-06 修正: agent leaf **同样受益** —— pi system + 工具 schema + DISCIPLINE_CORE +
   * TOOL_ROUTING 是跨 leaf 字节稳定共享前奏(数 k tokens), [omd leaf: id] 之后才分叉;
   * 旧注释"仅对 inproc 有意义"系误判(mimo 控制台实测 41% hit, thundering herd 成分可治)。
   */
  warmThenFanout?: boolean;
  /**
   * 暖发**宽限窗口上界** (ms, t-initial-pump 2026-09-02): 暖发那一发起跑后, 最多按住 pool
   * 这么久不派新节点; 暖发提前 settle 则立刻放开 (上界, 不是定长延迟)。`warmThenFanout`
   * 关时无意义。缺省 20_000。
   *
   * ⚠ 为什么需要它: 暖发买的是「共享冻结前缀写进 prompt-cache」, 这件事在**首个模型往返
   * 返回**时就已到手 —— 而旧实装是 `await` 到整个 leaf **settle** 才放 pool。生产读数
   * (run 32d16141, 三片零依赖) 里那一发跑了 925s, 于是另外两片白等了 15 分钟。缓存写成
   * 这件事今天没有信号面 (leaf runner 不上报首个往返), 所以只能给上界。
   */
  warmGraceMs?: number;
  /**
   * per-kind 并发闸 (fanout 最大化设计, 2026-07-21): inproc 叶纯 API 等待、无本地足迹 →
   * 默认不限 (只受 maxFanout/图宽/provider 池); agent 叶 (本地工具调用) 与 command 叶
   * (本地 CLI) 物理共享本机 CPU/磁盘 → 各自独立小闸。省略的 kind = 不限。
   * 调度期按节点声明的 executor 记账 (运行期 leaf→agent 提升不改变记账桶 — 提升是罕见纠错路径)。
   */
  kindFanout?: { agent?: number; command?: number; inproc?: number };
  /**
   * per-channel 并发闸 (SDD v2 D-23, TFFInfer 多 Stream 同构): key = provider 前缀
   * (调度期由 node.model ?? kind 静态模型推出), value = 该渠道并发上限。多模型 stamp 后
   * 争用单元从 kind 变渠道 (Allegretto/Lite/Go 各有额度限速) — 一个渠道饱和不阻塞其它
   * 渠道就绪节点 (非严格 FIFO 让位逻辑原样适用)。省略/未列渠道 = 不限。channels 熔断是
   * 事后, 此闸是事前限流, 互补。
   */
  channelFanout?: Record<string, number>;
  /**
   * **协作式取消** (D-P): 叫停这次 run。给了就在每个**调度接缝**上查一次。
   *
   * "协作式"是字面意思 —— **不杀在飞的节点**: 已经起跑的 leaf 跑到它自己结束 (它的产物、
   * checkpoint、账本一样不少), 引擎只是**不再派新活**。理由是杀进程救不回半个产物, 却会
   * 把一个正在写文件的 agent 留在半路上; 而"停止派新活"这件事在 ready-set 调度器里是免费的。
   *
   * 查的四个接缝: ① 外层 pump 派新节点前 ② conductor 内环 pump 派新子节点前 ③ 内环开新一轮前
   * ④ verifier-fail 升级重规划前。接缝之外一律不查 —— 中途插一刀等于回到"杀"。
   *
   * 收尾语义: `ExecutorDagResult.cancelled` 留痕 + `notRun` 列出一个都没起跑过的节点。
   * **同一个 runId 可以直接 resume** (已绿节点全跳过) —— 这才是"已跑完的节点全保留"的兑现处。
   */
  cancelSignal?: AbortSignal;
}

/** leaf prompt 整形 seam: 注入 leaf 上下文/前缀/压缩级与档位闸 (省 token 与护 cache 的旋钮)。 */
export interface DagLeafShapingSeam {
  /**
   * 干活 leaf 的 caveman 压缩级 (省 output token)。默认 'full' (2026-07-21: 从 ultra 降 —— ultra 的边际
   * 压缩是弱模型削 substance 的风险位且无 per-node 出口, 省 token 大头改由 fan-in 定向摘要接管)。
   * 设 'ultra' opt-in (已知纯叙述且省 token 吃紧时压到底)。创意节点 (node.creative) 恒 'off' (护交付物)。
   */
  cavemanLevel?: CavemanLevel;
  /**
   * inproc leaf 的共享冻结 system 前缀 (字节稳定 → 暖发后跨 leaf 命中 prompt-cache)。
   * 省略 = 内置精简指令 (~80 token, 对 DeepSeek cache 粒度偏短, 命中≈0)。要真省 input, 设成
   * 大前缀 (~800+ token, 现役调用方传共享 spec/契约上下文, 如 eval oracle 的 fx.spec 与
   * dag-build 的 context) —— 内容承重之余也过 cache 阈值。
   */
  leafSystemPrefix?: string;
  /**
   * 给 leaf (构建相位) 注入 ponytail 反过度工程倾向 — 降生成代码量, 维二红线 (不变量/法定值/防丢错误处理/安全) 不在砍范围。
   * 默认 off (opt-in): 正确性敏感 build 由 caller 决定开关, 质量靠现有闸 (tsc/test/GroundingVerifier) 兜底。
   * 只挂 leaf 不挂 conductor — 规划相位要发散 (拆得对), 构建相位才收敛 (建得少)。见 ponytail plan/build 相位分离。
   */
  leafPonytail?: boolean;
  /**
   * 每个 leaf 的 prompt 是否携带**原始任务全文** (默认 true, 见 buildLeafPrompt 的注)。
   *
   * 补的是图的一条结构缺口而不是加上下文: 节点的世界原本只有「自己的 goal + 上游输出」,
   * 而 conductor 看着任务写 goal, 会写出「从可信任务上下文复制题目」这种节点根本做不到的话。
   * agent 档靠工具自己去翻任务文件把这个洞盖住了 (实测老跑 5-6 个节点真去读了任务文件),
   * g1 换成 command+leaf 后洞就露出来: 33 节点全绿而交付物是「未提供题义」。
   * 设 false = 回到旧行为 (逃生口, 不建议)。
   */
  leafTaskContext?: boolean;
  /**
   * g1 leaf 档位闸 (图「引擎墙钟与 leaf 档位」#9, 2026-08-04): 计划落地前拒
   * 「executor:'agent' 读确定路径 + 无写意图 + 结构化产出」的节点/map 模板, 带改写建议重问
   * conductor (有界), 用尽 fail-open 放行并响亮留证。判据本体 plan/leaf-tier-gate.ts。
   * 缺省关 (引擎中立); 生产装配层 (mcp/assemble) 开, OMD_LEAF_TIER_GATE=0 关。
   */
  leafTierGate?: boolean;
  /**
   * g1「塞得下单 leaf prompt」阈值 (字节), 决定改写建议走「单 cat+leaf」还是「conductor 展开
   * per-item 对」。按座位实测定 (2026-08-04 探针: deepseek-v4-flash 收 3.04MB=56 万 token 未撞限),
   * 装配层给实测值之半; 缺省不做体量分支 (建议文案给两条路)。
   */
  leafTierThresholdBytes?: number;
  /**
   * **plan-critic 静态闸进活规划环** (#247, 2026-08-24, 片 2): parsePlan 成功后跑一次 `critique()`,
   * 只 enforce 无外部输入子集 `{PP-I01, PP-I02, PP-O01, PP-V01, INV-12}` (字段存在性/枚举/形状
   * —— 零外部状态); tool/skill 码 (PP-T01..T03 · PP-S01..S03) 不 enforce (inventory/skill 装配进活环是 S2 债)。
   * 有界拒回 ≤2 → 拒回计数 + 诊断带 remediation 重问;预算尽 → fail-open 放行 + `logger.warn` 留证。
   * 缺省关 (引擎中立); 生产装配层 (mcp/assemble) 开。
   */
  planCriticGate?: boolean;
  /**
   * fan-in **定向摘要** (引擎接缝, 2026-07-21): 一个 producer 的输出被 ≥2 个下游 consumer 消费时,
   * 不再把全文复制 ≥2 份灌进各 consumer, 而是跑 1 发定向摘要 (按下游目标提炼) + 全文写入磁盘留指针,
   * 各 consumer 的 fan-in 上下文注入摘要而非全文 (省 token + 护 prompt-cache; 强制 conductor-plan
   * "Fan-in carries SUMMARIES" 纪律)。省略 = 引擎内默认 ON (minChars=1800, minFanout=2; 同 caveman
   * 的行为旋钮惯例——默认档由引擎给); `{ enabled: false }` 关闭。fail-open: 摘要失败 → 回退全文注入。
   */
  faninSummary?: FaninSummaryConfig;
  /**
   * **按节点下发整副工具面 + system prompt** 的钩子 (P3 S6b, 2026-09-02; 编排循环的 conductor 节点用)。
   * 引擎在每次 agent 派发前调一次; 返回值在场 → 原样进 `AgentLeafInput.face`, 该叶的工具面与
   * system prompt 由它定 (精益面 / 座位极简面 / profile / scaffold 全不进); 返回 undefined → 老路径逐字节不变。
   * 不进 plan (闭包不可序列化); 装配点 = run-goal 的编排循环路径, 只对 `conductor` 这一个 id 返回值。
   */
  leafFace?: (node: { id: string; executor?: string }) => LeafFace | undefined;
}

/** 内环控制 seam: 判据进环/judge 视图/预算/熔断/升级 —— 环的四条停止轴与跨模型校验。 */
export interface DagLoopControlSeam {
  /**
   * **冻结判据进环**(2026-08-01)。给了 → conductor 内环**每轮**跑一次这条确定性命令;
   * 退出码对上 = 这一轮定为最后一轮。省略 = 旧行为(判据只在环外跑一次)。
   *
   * ## 为什么要进环
   *
   * 此前它是环外节点 (`accept`, depends_on: ['execute']) —— 也就是说**必须先把轮数烧完**,
   * 那道 30 秒就能判出来的确定性闸才第一次被问到。实测撞过更坏的一档: judge 因为配置错
   * 恒抛错, 环永远拿不到裁决, 于是判据一次都没跑成, 而它本可以在第 1 轮就判绿。
   * **确定性判据不该排在不确定的东西下游。**
   *
   * ## 三条护栏(缺一条这个改动就会造出更难发现的问题)
   *
   * ① **它不进 judge 的视野。** 在环里直接跑, 不作为子节点 —— `renderRoundForJudge` 渲染的是
   *    children, 而 command 子节点通过时 facts 会写「命令退出码符合预期」。judge 一旦看得见
   *    判据结论就会**抄答案**: 两条判据永远一致, 而"判据轴"量的恰恰是它们的不一致。
   *    独立性此前是**结构白给的**(环外够不着), 现在改成**构造上钉住的**(压根不当 child)。
   * ② **绿了仍然问一次 judge**, 只记录、不改变停止决定。不问的话「judge 太紧」那一格
   *    (judge 说没成而判据过了) 永远观测不到 —— 从另一头把同一条轴杀掉。
   *    代价是每**跑**多一发 judge, 不是每轮。
   * ③ **只有可执行判据配这个字段。** 非可执行判据的 `oracleOk` 恒 true, 给了它就等于第一轮必停。
   */
  /**
   * 冻结判据 + (S-37 下沉 2026-08-17): 基线赦免谓词。
   *
   * 引擎判红点 (D-K 节点命令红 `engine.ts:2739` / 环内冻结判据红 `engine.ts:2228`) 先过此闭包:
   *   - 返 null = 不赦免, 维持 failed
   *   - 返字符串 = 赦免证据原文 (含被赦免的失败名清单), 按 done 落 + 节点输出/loop journal 带赦免注记
   *
   * 由 run-goal 用 baselineSide.failSet 构造 (D-1/D-3), 引擎 (dag 层) 不 import goal —— 依赖方向
   * 不倒灌。缺席 → 两点行为逐字节不变 (INV-1)。
   */
  freezeCriterion?: {
    command: string;
    expectExit?: number;
    /** 期望输出子串。与 expectExit 取交 —— 语义同节点级 `expect_output`:退出码分不开「跑了且过了」与「根本没跑」。 */
    expectOutput?: string;
    waiveRed?: (outputText: string) => string | null;
  };
  /**
   * **产物内容进 judge 视图** (S1, 2026-08-03)。省略/`true` = 默认预算 (**缺省开**);
   * 给对象 = 自定预算; `false` = 关。
   *
   * 补的洞: `[引擎实测]` 只给存在性 (`写入文件: X`), 而验收在**内容**上的目标要的是"文件里
   * 写了什么" —— judge 被要求裁决它看不见的东西 → fail-closed → **交付物全对也判未收敛**
   * (2026-07-30 两次带种 live 都是这个形状)。产物内容由引擎**读盘**补进来, 不让 leaf 自述
   * (自述就是自证, 而自证正是反捏造判词要杀的)。
   *
   * ⚠ **为什么是预算不是布尔**: 它进的是**每一次** judge 调用, 无界即无界成本。
   *
   * **读数** (`scripts/eval-judge-artifacts.ts`, deepseek-v4-pro, 4 段 × 16 次 × 2 臂):
   * 假阴性 16/16 → **0/16** · 假阳性 0/48 → **0/48** · prompt token **+11%**。
   * ⚠ 单座位读数, 换 judge 座位必须重跑。⚠ 点名召回 87.5% → 77% (方向一致但 p≈0.29, 在噪声内, 待观察)。
   */
  judgeArtifacts?: boolean | ArtifactBudget;
  /**
   * **owner 指令通道** (S3, 2026-07-31 / D-S)。每开一轮调一次, 返回**已渲染**的一段;
   * 空串 = 本轮没有 owner 指令。消费记账 (哪条被哪一轮吃掉了) 由实现方做, 引擎不认识收件箱。
   *
   * ⚠ 它与失败原因、图外观察**共用同一条运输管道** (环唯一的信息通道), 但**渲染成独立的块**:
   * 观察者说"我算出一个事实", owner 说"照我说的做" —— 可错性完全不同, 合成一段之后下一轮的
   * conductor 就分不清哪句必须服从。
   *
   * ⚠ 引擎**逐字**把它拼进 prompt, 一个字都不加工 (有测试钉住)。
   *
   * `nonce` = 本次运行的**信任 token** (A8, 2026-07-31)。owner 块是 prompt 里**唯一带 token 的块**,
   * 因为它是唯一真可信的那条通道 —— 抓回来的网页正文可以逐字复制这个块的文案 (探针实证过),
   * 但复制不了一个它写那张网页时还不存在的值。渲染方须用它, 见 `renderOwnerDirectives`。
   */
  ownerDirectives?: (round: number, nonce: string) => string;
  /**
   * **环的预算上限**(2026-07-31)—— Loop Engineering 四条停止轴里我们唯一缺的那条。
   *
   * 另外三条早就有:轮数上限(`max_rounds`)· 空转(D-Q 确定性判据)· 完成检查(judge ∧ 环外
   * `accept`)。缺预算轴的后果很具体:judge 每轮说"还不行",环就一路烧到轮数上限,**全程没有
   * 任何一处问过"这已经花了多少"**。而实测一次 goal 的执行段 leafIn 是 43 万 token 量级。
   *
   * 在**轮边界**上查(与 D-P 取消同一个接缝):不打断在飞的一轮 —— 半轮的钱已经花了,
   * 打断只是把产出也扔掉。省略 = 不设限(老语义,零回归)。
   *
   * ⚠ 这是**软停不是硬杀**:超了就不开下一轮,已跑完的全保留,`resume` 时给个更大的预算就能接着跑。
   */
  loopBudget?: {
    /** 累计 leaf+conductor token(in+out)上限。 */
    tokens?: number;
    /** 该节点内环的墙钟毫秒上限。 */
    ms?: number;
  };
  /**
   * #158 预算时间轴的**锚时刻** (epoch ms)。缺省 = 每次 `runExecutorDagWithPlan` 自锚 ——
   * 于是升级重规划轮 (同一次调用内) 与调用方多相位 (goal 的 contract→execute, 由 goal 层
   * 注入同一个锚) 共享同一只时钟。它存在的理由: d39b559e 带 90min 预算实跑 164min ——
   * 预算此前只在内环轮边界、且锚在环起点, 单轮超跑 / 环收敛后的重规划 / 前相位烧穿
   * 三条路都量不到。下划线 = 内部接缝 (goal 层与测试注入), 不进公开文档。
   */
  _budgetAnchor?: number;
  /**
   * 跨模型校验器 (model-agnostic skeptic, 见 verifier.ts)。省略 = 不校验 (back-compat 老行为)。
   * 给则 DAG 跑完用它审结果 → fail 且配了可用升级模型时触发 conductor 静默升级重规划。
   */
  verifier?: VerifierFn;
  /** verifier-fail → 升级重规划的最大次数 (默认 1)。每次升级 = 一整轮重规划 + 重跑 leaves。 */
  maxEscalations?: number;
  /**
   * **冻结判据节点**(SDD 2026-08-22 「冻结判据在重规划轮里并不冻结」)。由调用方在铺图时
   * 钉下的节点 id 清单 — 每次升级重规划之后, 引擎把点名节点按**调用方铺图时**(round-1
   * post-filter)的定义逐字复原 (changed → 整定义覆盖 + 一行 warn; absent → 补回 + warn;
   * 逐字相同 → 零噪声, INV-3)。
   *
   * **设计意图**: 判卷标准必须是执行体动不了的东西。环每轮重画子图, 判据进环就跟着能变
   * (run `9f5bed0c` 现场: 重规划把 `accept.command` 换成四条护栏 + tsc, 跑过一轮, 而原
   * 第 1 轮的「全量 bun test」那条被静默摘掉)。`frozenNodes` 是把这条纪律从「环外 + 调用方
   * 自构造」拓宽到「环外 + 调用方点名 + 引擎每轮复原」 — 后者兼容了平铺图 (flatPlan) 那种
   * `accept` 与其他切片并列摆的形态。
   *
   * **零回归**: 缺省 / 空数组 → 引擎对升级重规划轮的所有图改动照单全收 (旧行为, D-5)。
   *
   * ⚠ **与 `freezeCriterion` 的边界**: `freezeCriterion` 是把判据**命令**灌进内环每轮
   * 短停路径 (D-37 那条); `frozenNodes` 是把判据**节点定义**钉在升级重规划之后。两者
   * 在平铺图上协同: 前者保证环内早停 / 后者保证环外不被改。v1 (环外自带 `accept` 节点)
   * 路径不传 frozenNodes (那条路今天就是对的, 无需补救)。
   */
  frozenNodes?: readonly string[];
  /**
   * **平铺图确定性重规划** (SDD 2026-08-22 「升级重规划成事件」续 / 平铺图 v2)。
   *
   * 调用方给个函数 = 引擎在升级重规划轮**不**调 conductor (跳过 `tryPatchReplan` 也跳过
   * `planAndExecute`), 直接 `executePlan` 这个函数当轮返回的图; 返回 `undefined` =
   * 这一轮回落今天的补丁 → 整图路径 (fail-open, 不因重编译失败就整跑崩)。
   *
   * **为什么是个 seam 而不是引擎内嵌**: 引擎不认 SDD (它只吃 plan), 知道怎么重编译的是
   * `run-goal` (它有 `compileBreakdown`)。seam 把"图从哪来"与"图怎么跑"切开 —— 别的 caller
   * (v1 conductor 铺图、`iterate` 之类) 不传这条, 走今天路径逐字不变 (INV-4)。
   *
   * **它与 `frozenNodes` 互补**: `frozenNodes` 假定图会变、钉住名字里那几位; 这一条假定图
   * **不该变** (平铺图是 `compileBreakdown(SDD)` 的确定产物), 从根上不让它变。两者各自防
   * 的不是同一条风险。
   *
   * **零回归**: 缺省 / 不给 → 升级重规划轮照旧走 `tryPatchReplan` (INV-4)。
   */
  deterministicReplan?: () => ConductorPlan | undefined;
}

/** 观察与留痕 seam: 事件/回执/trace 分组/checkpoint —— 观察者不许扰动被观察者 (fail-open)。 */
export interface DagObservabilitySeam {
  /**
   * 本次 run 的 Langfuse trace 分组 session id (conductor+leaf 全部经 send 归此 session)。
   * 省略 → 内部生成 randomUUID (current behavior)。给则**调用方可拿同一 id 做跨平面关联** (如派活
   * 飞轮把 dispatch_outcome ↔ Langfuse session 用此 id join → 按 pattern-class 归因成本/调试 mined skill)。
   */
  sessionId?: string;
  /**
   * 运行完成钩子 (留痕层接口)。每次 runExecutorDag 结束前调用一次, 传完整 result (含升级后的最终态)。
   * 传 createDagRecorder().record 的闭包 → 自动落 SQLite 运行记录 (node 图谱可回溯)。抛错不阻断返回。
   */
  onComplete?: (result: ExecutorDagResult) => void | Promise<void>;
  /**
   * 节点级进度事件 (2026-07-20, MCP 派发简报/活体 status 的数据源):
   *   planned = 图定型 (全部节点 id+kind, 每轮 plan/escalation 重规划各发一次)
   *   start   = 节点起跑 (含 map 展开出的子节点)
   *   settle  = 节点定局 (done/failed + 实际模型)
   * fail-open: 回调抛错被吞, 永不影响执行 (观察者不许扰动被观察者)。
   */
  onNodeEvent?: (e: DagNodeEvent) => void;
  /**
   * W2 continuity (SDD C4): 节点级 checkpoint 写入磁盘 + 崩溃恢复跳过。
   * manager+runId 给则启用: done 节点写 `.omd/continuity/<runId>/<nodeId>.json` (fail-open, 写挂不阻断);
   * resume=true 时, checkpoint 存在 ∧ 产物 hash 匹配的节点跳过执行 (LeafResult.skipped=true)。
   * repoRoot 供 noun-gate 注释 + 产物路径相对化 (省略 = process.cwd())。
   */
  continuity?: {
    manager: CheckpointManager;
    runId: string;
    resume?: boolean;
    /** **状态锚** —— checkpoint 落在哪。隔离档下它**仍是主仓** (双 cwd 分离, 见 mcp/tools/goal.ts)。 */
    repoRoot?: string;
    /**
     * **执行锚** —— leaf 真写文件的那棵树 (隔离档 = `.omd/runs/<runId>`)。省略 = `repoRoot`。
     *
     * ⚠ 2026-08-21 立此字段的现场 (run 58df6b9e): 毒集回滚一直拿 `repoRoot` 当回滚根,
     * 而隔离档下那是**主仓**, 活写在 worktree 里 —— 于是回滚对着一棵**没有那些产物的树**
     * 逐条判"盘上已经没有这个文件/是 git 跟踪的既有文件", 9 条全"没撤", 一个字都没真回滚。
     * **一个字段同时当两个锚**用是本仓的常见错法; 分开写死在这里。
     */
    execRoot?: string;
    /**
     * 毒集回滚时**跟踪文件还原到哪个 commit**。给了才动跟踪文件, 省略 = 老行为(一律不动)。
     *
     * 给它的人要能保证:**执行树自该 commit 以来的改动全是本次跑写的**。今天只有隔离档
     * (`branchStrategy:'branch'`) 满足 —— worktree 从 HEAD 建出/复用, 树里的未提交改动
     * 只可能来自这个 runId 自己。**head 档一律不给**: 那棵树上有 owner 自己的活。
     */
    rollbackBaseline?: string;
  };
}

/** DAG 执行引擎总配置 = 上述八个 seam 的并 (分组即目录, 见文件头 Seam 分组注)。 */
export interface ExecutorDagConfig
  extends DagSeatsSeam, DagThinkingSeam, DagRunnersSeam, DagPlanningSeam,
    DagSchedulingSeam, DagLeafShapingSeam, DagLoopControlSeam, DagObservabilitySeam {}

/**
 * 节点进度事件 (onNodeEvent 载荷)。kind 与 LeafResult.kind 同词表 + 'map'/'primitive'。
 *
 * `expanded` (2026-07-30): map/conductor 节点**运行时**把子节点挂进图的那一刻发一次。此前观察面
 * 到此为止就窄了一截 —— 子节点逐个发 start/settle, 但没有任何事件说过"图上多了这些点",
 * 于是 `dag_status` 的静态图上执行段永远只有一个点 (见 DagMetadata.runtimeNodes 的同款修补)。
 */
export type DagNodeEvent =
  | { type: 'planned'; nodes: Array<{ id: string; kind: string }> }
  | { type: 'expanded'; parent: string; nodes: Array<{ id: string; kind: string; deps: string[] }> }
  | { type: 'start'; id: string; kind: string }
  // `failureKind` (2026-08-21 补, additive): **闸的分类信息此前在事件面上是丢失的**。
  // 七个闸里只有三类发 `verdict` (judge / gate 谎报完成 / verifier); 心跳闸 `stall`、
  // 空转熔断 `spin-fused`、产物闸 `empty-artifact`/`broken-artifact`、`expect_exit` oracle、
  // 轮数耗尽 —— 全部只以 settle{failed} 露面, 而观测面只拿得到 `failReason` 那 160 字符首行。
  // 于是 TUI/HUD **画不出「是哪个闸拦的」**, 只能画一句被截断的错误原文。
  // `LeafResult.failureKind` 一直都在 (:640), 之前只是没往事件里放; 词表见 `node-failure.ts:49`。
  // ⚠ **缺席 ≠ 'unclassified'**: 缺席 = 早于本次改动的发射点, unclassified = 记了但归不了类。
  | { type: 'settle'; id: string; status: 'done' | 'failed' | 'skipped'; kind: string; model?: string;
      durationMs?: number; failReason?: string; failureKind?: NodeFailureKind; usage?: { in: number; out: number } }
  // 新增三型 (SDD 2026-08-11-dag-观察面与审核跟踪升级, additive)。id 均为节点 id;
  // 未知 type 消费者必须静默忽略 (C-1)。verdict 的 pass/fail 指**被审对象** (D-9)。
  | { type: 'progress'; id: string; tool?: string; note?: string; calls: number; elapsedMs: number }
  | { type: 'verdict'; id: string; gate: 'judge' | 'verifier' | 'gate' | 'acceptance' | 'review';
      verdict: 'pass' | 'fail'; round: number; reason?: string }
  | { type: 'replan'; parent: string; round: number; poisoned: string[] }
  // 新增 (SDD F1 片 2, additive): 预算过半通知的引擎事件轴。`budget` 走的是引擎事件桥
  // (assemble.ts:728 的 onNodeEventComposed) → ownerNotifySink 翻成 budget-half payload。
  // 轮边界读数; 每轴每内环实例至多一发 (per-axis 幂等, 不跨进程去重 —— 见 emitBudgetHalfIfHalf)。
  // 未知 type 消费者必须静默忽略 (C-1); 既有 DagNodeEvent 消费者零回归 (INV-10)。
  | { type: 'budget'; axis: 'tokens' | 'ms'; spent: number; cap: number }
  // SDD §7 use_event (S2 后半, 2026-08-25, C-2 / INV-5, INV-6): 完成 leaf 带真 tool_id
  // 时由 settle 闭包发出一次, 字段来源全部钉位 (tool_id / leaf_id / success / cost /
  // oracle_pass / ts)。无 tool_id 时不写占位; 同一 (tool_id, leaf_id) 至多一条
  // (dedupe 在 credit.dedupeUseEvents 兜底, 发射点不重复触发)。
  // 未知 type 消费者必须静默忽略 (C-1); 既有 DagNodeEvent 消费者零回归。
  | { type: 'use_event'; tool_id: string; leaf_id: string; success: boolean;
      cost: number; oracle_pass: boolean; ts: string };

/**
 * **图外只读观察者**的一条产出 (P3 D-Q)。
 *
 * DAG 里的节点只看得见自己的 `depends_on` —— 谁写了什么、谁读了什么、这一轮和上一轮是不是在
 * 原地打转, 没有节点站得到那个视角。观察者住在图外, 拿引擎手上现成的事实确定性地算 (零模型调用),
 * 产出这个。producer 见 `plan/observers.ts`。
 *
 * 出口有两个, 都是**前馈**: ① 进 `ExecutorDagResult.observations` 给调用方 ② 进下一轮重展开的
 * prompt (环的信息通道)。观察者**不铸毒票、不改路由、不改结果** —— 唯一的例外是确定性的
 * `loop-no-progress` 会让环提前 BLOCKED 退出 (再转一圈按构造不可能有新东西)。
 */
export interface DagObservation {
  /**
   * `undeclared-artifact-dep` = B 读了 A 写的文件但图上无边 (D-12/INV-P2-4);
   * `loop-no-progress` = 内环重展开得到同一张子图且 judge 拒的还是同一批 (D-Q BLOCKED 判据);
   * `write-race` / `missing-input` / `missing-command-target` = **跑之前**就能确定性判死的坏 plan
   * (A4, 2026-07-31, 补 Fowler 2×2 里最空的那格 computational feedforward; 后者是 command 节点
   * 引用 cwd 内不存在的脚本或未定义的 package script)。前两个是事后传感, 这些是事前拦。
   *
   * `dangling-dependency` / `truncated-dependency` / `impossible-quorum` (issue #25, 2026-08-14)
   * = 同一格 (跑前确定性判死) 的引用完整性三条。**只报不拦**, 且这一条的 report-only 有个比
   * "怕误伤"更硬的理由: 悬空引用在仓内**有 intentional 消费方** (子图被 maxNodes 截断时,
   * 留下的引用刻意退化成未知 dep 靠执行器的宽容语义不炸), typo 与刻意悬空在图上形状完全相同。
   * 两者由生产者自报的 `truncatedNames` 分成两个 kind —— 混进同一个计数, 升闸判据就会被污染
   * (owner 判据③)。升成拦截的前置 = 先拿到分来源的活体基率。
   */
  /**
   * `loop-no-artifact-change` (2026-07-31, G5 正解) = 两轮下来**盘上的产物逐字节没变**。
   * 与 `loop-no-progress` 的区别是**判据键在哪**: 后者键在「agent 有没有重复自己」(而 LLM
   * conductor 每轮重画, 从不逐字重复 → D-AD 诊断的死路), 前者键在「盘上有没有位移」——
   * 产物是 agent 不重新生成的东西, 是这个环里唯一稳定的信号。**只报不拦**, 见 detectNoArtifactChange。
   */
  /**
   * `leaf-spin` (2026-08-03, G5 频率读数) = 一个 agent leaf 在自己的工具循环里**反复发同一个动作**
   * (drift-detector 的 spinning 判据: 同一签名在环里 ≥threshold 次)。
   *
   * ⚠ **它与 `loop-no-progress` 键在不同的层上, 这正是它的价值**: 后者键在**外环** ——
   * conductor 每轮重画, 从不逐字重复, 所以那条判据在 live 上恒 0 (D-AD 诊断的死路, 也是 G5
   * 三跑 0 样本的原因)。而 `leaf-spin` 键在**内环**, 同样的键在那一层**工作得很好**:
   * 2026-08-03 单次 live 命中 16 个回合, 最高同签名重复 39 次。
   * 也就是说 G5 的 0 未必是"这类检测器天然失效", 更可能是**信号在错的层上被观察**。
   *
   * `novelty-collapse` (r1 片3, 2026-08-04) = 修复轮发现文本的**簇数连续 K 轮不增** —— 环在原地打转。
   * 只报不拦 (INV-R1-3: 判据是第三票, 终止权归轮数/预算/冻结判据); 警告行经 prevReason 进下一轮 prompt。
   *
   * **只报不拦**(与 `loop-no-artifact-change` 同档): 要不要把它升成 BLOCKED、K 取几,
   * 取决于它在真跑上多久命中一次 —— 先有读数再谈判据, 别反过来。
   */
  /**
   * `scheduled-artifact` (2026-08-03, R3 前置) = 这张图要改的某个文件**会被自动执行**
   * (package script / CI workflow / cron / owner 声明的外部调度器)。
   *
   * 为什么值一条观察: 三臂 eval 实测, 模型判「这个岔口的后果可不可逆」时缺的正是这条事实 ——
   * 它停在"改动落在工作树里"就下结论, 漏标 25–33%; 补上这条结构事实后 **0%**,
   * 且**只要结构关系那一环就够**(不需要因果链)。**只报不拦**, 出口是下一轮的 prompt。
   */
  /**
   * `verbatim-drop` (#13, 2026-08-04, r2 逐跳取证) = **汇总节点把上游的逐字引文转述没了**。
   *
   * 出处: F2 三对复测里 11 个失分**无一例外**是「关键词✗ 出处✓」—— 而关键词是从英文原文
   * 逐字核过的锚点。沿链查(run 02971fc7): `answer_q5` 产出含 `budget` 原句 ✓,
   * 紧邻的 `assemble_draft`(8→1 汇总)✗,之后三跳皆无。**图在第 2 跳已经拿到带锚点的
   * 正确答案,又用汇总跳把它丢了** —— 对逐字接地类任务,每次 fan-in 都是一次有损重编码。
   *
   * 判据刻意保守(拿不准不报,同 static-lint):只在**上游确有引文、而本节点一条都不剩**时报。
   * **只报不拦** —— 转述在多数任务上是正当的(摘要就是要转述),它只在"下游要逐字定位"时才是错。
   * 引擎判不了任务性不性质,所以这条只把事实说出来,让下一轮 conductor 自己权衡。
   */
  /**
   * `unsupported-claim` (2026-08-05) = 某个子节点的产出**声称引擎已校验通过**
   * (「已由引擎实测通过」/「测试全部通过」/「已过 verifier 复核」),而引擎记录里
   * **没有对应事实** —— 求的是差集,不是判断题。判据在 `plan/claimed-actions.ts`。
   *
   * 为什么要一条确定性判据: 生产座实测 judge 在这条失效模式上召回 **0/64**,而矛盾就在
   * 相邻两行(`[引擎实测] 写入文件…` vs 产物里「已由引擎实测通过」)。往 judge prompt 加规则
   * 已被排除过两次(「讲道理拦不住」)。
   *
   * **只报不拦(report-only)**,三条出口都不进控制流: judge 视图 / 本账本 / 下一轮 prompt。
   * ⚠ 升成硬拦是**单独的拨闸决定**,前置条件是良性语域误伤面先被量掉 ——
   * 当前判据靠词形,已知会误伤指令句(「确保测试通过」)与整改回执(「已按 verifier 意见修改」)。
   * 本条的记数就是那次决定的依据: 活体基率(命中频次)与活体误伤率(逐条人工核对原句)。
   */
  /**
   * `detector-wrote` (D4 / §7.3, 2026-08-06) = **图内检测者自己动手改了盘**。
   *
   * D-Q 检测者是图内节点, 与被它检查的兄弟共享同一棵 worktree; conductor 把它排成
   * `executor:'agent'` 时它手里**就是有写工具的**。实测 54 跑: 23 个 detector 里 7 个是 agent (记了 writeCounts 的 4 个),
   * 而那 4 个一次都没写 —— 也就是说这条纪律今天成立, 但成立的方式是**运气不是不变量**,
   * 而且一旦有一个真写了, 此前**没有任何一处会知道**。
   *
   * **只报不拦** (同上面几条): 要不要真把检测者的写工具收掉是单独的拨闸决定, 而今天 n=4,
   * 离读得出基率还差得远。判据与分母见 `plan/observers.detectDetectorWrites`。
   */
  kind: 'undeclared-artifact-dep' | 'loop-no-progress' | 'write-race' | 'missing-input' | 'missing-command-target' | 'dangling-dependency' | 'truncated-dependency' | 'impossible-quorum' | 'loop-no-artifact-change' | 'leaf-spin' | 'scheduled-artifact' | 'novelty-collapse' | 'verbatim-drop' | 'unsupported-claim' | 'detector-wrote' | 'contract-misaligned' | 'owner-question'
    /**
     * `claim-anchor` (2026-08-16, #145 附录 §9.5) = **产出里的「file:line + 字面量」声称与盘上对不上**。
     * 现场: 代码早换成 token 了, 而同一个文件头的简报仍写着裸 hex —— 终审验了代码干净,
     * 没交叉核声称。**简报是给下一个人做决定用的**, 失真的简报让后续判断建立在错误前提上。
     * **只报不判**, 三级判据与结案条件见 `harness/writeset/claim-anchor.ts`。
     */
    | 'claim-anchor'
    /**
     * `blame-attribution` (2026-08-17, #145 提议 5 Phase B1) = **闸红的诊断有多少行归得到本跑写者头上**。
     *
     * 它是一把**尺子**,量的是「定向返修」(B2) 这个形状成不成立:诊断行分三桶
     * (写者认领 / 本跑外文件 / 无路径),而后两桶说明的事**相反** ——
     * 前者说"够不着",后者说"本来就不用归因"。
     *
     * **只观测,一行都不路由。** 存在的理由是 `failure-trace.ts` 记着一条对该方向不利的旧实测
     * (`assert-failed` 只有 1/7 认得出路径),而那个数量在 800 字 summary 上、n=7 ——
     * 口径存疑的旧数既不能用来支持一个方向,也不能用来否掉它。判据见 `dag/blame-attribution.ts`。
     */
    | 'blame-attribution'
    /**
     * `empty-write-set` (2026-08-22, run c4edb14f 现场, 片 3g 后续网) = **节点判 done 且声明了
     * `write_set`, 而写集里**一个文件都不在盘上** = 绿节点配空盘。
     *
     * 判据刻意窄到「**一个都不在**」(D-2): 少一个文件的形态太常见(切片只改了写集里的一部分),
     * 报它等于制造噪声;「一个都不在」在正常交付里不可能发生。**只报不判**(D-1): 判死会误伤
     * 「产物在别处 / 被引擎合并 / 路径根不同」的形态, 今天没那类读数。
     *
     * ⚠ **升成拦要先有基率读数**: 这条闸真跑起来一年报几次、几次是真的, 今天答不上来。
     */
    | 'empty-write-set'
    /**
     * `partial-quorum-failure` (2026-08-27, S3 片 5 / D-7 / INV-9) = 节点因 `requires: 'any'` 或
     * 整数 K 显式放行, 但跑时仍有部分依赖未 done —— 跑前/跑中判不出, 跑后才看到的
     * 「达标但部分失败」这一格。
     *
     * 与 `impossible-quorum` (跑前确定性判死, plan/static-lint.ts:467) **互斥**: 那一格节点**没**跑,
     * 这一格节点**跑了** —— 显式 `requires: any/K` 是合法配置, 它的失败兄弟与本节点同框也是合法形状。
     * 把两者合成一个 kind 必漂: 一次跑前判死的误伤会让活体基率读数永远看不出「达标路径」的真命中频次。
     *
     * `nodes` = [本节点 id, ... 未 done 依赖 id 列表]; `message` 逐条点名未 done 依赖及其状态。
     *
     * **只报不拦**(同 `loop-no-artifact-change` 那几条): 升成拦截要先拿到活体基率
     * —— 与 `dangling-dependency` 那条引用的教训同源 (`types.ts:670` 那段注)。
     */
    | 'partial-quorum-failure'
    /**
     * `write-wall` (2026-08-30, 闸门三角结刀②) = **leaf 对同一路径撞写域闸 ≥2 次** —— 写集疑似
     * 写漏那条路径。一次可能是手滑, 两次是执行体坚持认为该写那里; 而它拿到的判词已经说了
     * 「那是契约的问题, 不要绕开它」(write-allow.ts) —— 能修契约的只有外环重画。此前这个信号
     * 只活在 spin 签名里, 外环读不到 (write-allow.ts 自承)。阈值 ≥2 防噪: 不同路径各撞一次不出。
     */
    | 'write-wall';
  /** 涉及的节点 id (lint = [reader, writer]; 空转 = 被反复拒绝的那批)。 */
  nodes: string[];
  /** 人与模型都读的一句话 (进 prompt 的就是它)。 */
  message: string;
}

export interface LeafResult {
  id: string;
  /**
   * 'skipped' (D-7v2 quorum) = 依赖失败未达 requires 判据 → 级联跳过, 零 LLM 零 worker 槽。
   * 与 resume 的 `skipped?: boolean` (已绿跳过, status 仍 'done') 是两个正交概念, 不混用。
   */
  status: 'done' | 'failed' | 'skipped';
  /**
   * **没过的成因** (P1, 2026-07-31)。词表与每格的直接判据见 `node-failure.ts`。
   *
   * 为什么是**加一位**而不是把 `status` 拆宽: 现有读 `status === 'done'` 的地方有二十多处,
   * 而它们问的都是同一个粗问题("这个节点算成了吗")—— 那个问题的答案没变。粗态由细态推出
   * (任何 failureKind 都伴随 `status` 为 `'failed'` 或 `'skipped'`), 反过来不成立, 这才是
   * 细化该走的方向。把 `failed` 拆成五个字面量会让每一处消费者都得改, 且改的是它们**不关心**的那一层。
   *
   * ⚠ 恒非空当且仅当 `status !== 'done'` —— settle 出口过 `withFailureKind` 归一化, 没人标的
   * 显式记 `'unclassified'`。**整个字段缺席 = 早于本次改动的记录**, 与 `'unclassified'`
   * (记了但归不了类) 是两件事, 读数板必须分开念。
   */
  failureKind?: NodeFailureKind;
  /**
   * 实际执行模式: inproc 单发 / agent 带工具 / command CLI / map 动态扇出 (U1) /
   * primitive 约束选择 (SDD 0013) / research 真 web (D-6) / conductor 运行时异构展开 (P3 D-B/C/D)。
   */
  kind: 'inproc' | 'agent' | 'command' | 'map' | 'primitive' | 'research' | 'conductor' | 'await';
  /** 实际所用模型坐标 (inproc/agent leaf; command 无模型 → undefined)。bandit reward 归因 + 审计用。 */
  model?: string;
  /**
   * **真工具引用** (S2 后半, C-2 / INV-5, INV-6): 节点 toolRefs[0] (解析后) 或
   * bootstrap.test_gate.tool_id。引擎 settle 时若有值 → 沿 `use_event` 事件面发出
   * 一条六字段记录; 无值不写占位。**与 `verification.pass` 解耦** —— oracle_pass
   * 来自工具契约 (bootstrap-gate 三态) 而非 verifier。
   */
  tool_id?: string;
  output: string;
  deps: string[];
  usage: ModelUsage;
  /** W2 continuity: resume 命中 checkpoint 跳过执行 (output=checkpoint.summary)。 */
  skipped?: boolean;
  /** agent leaf 触碰的文件 (来自 AgentLeafResult.filesTouched, checkpoint 产物锚)。 */
  filesTouched?: string[];
  /**
   * `filesTouched` 里**相对路径的解析根** (2026-07-31)。
   *
   * 为什么它必须跟着路径一起走: 一组相对路径**离开它的根就没有意义**了。产物闸在节点里用的是
   * `r.cwd ?? repoRoot ?? process.cwd()` —— 而 R2 隔离档下 leaf 跑在一棵 worktree 里,
   * 那个 cwd 与引擎进程的 cwd **不是同一个**。此前这一位没往外传, 于是任何在节点之外
   * 重新解析 `filesTouched` 的人都在拿错的根去找文件。
   *
   * 抓住这条的是「产物没变」检测器的端到端用例: 单元测试全绿, 而真跑一遍**恒命中不了** ——
   * 因为每个文件都 hash 成 null (在错的根下当然找不到)。fail-open 的方向救了它不误报,
   * 但它也就此**在最该用它的那个配置里静默失效**。缺席 = 非 agent 节点 / leaf 没报 cwd。
   */
  artifactRoot?: string;
  /**
   * **§8.5 效果指标的压缩形** (2026-07-31): `[总写次数, 其中 no-op 的次数]`。
   *
   * 为什么压成两个数而不是把 `FileWriteEffect[]` 原样带上来: 这条链的下游是**留痕库**,
   * 而留痕库该存的是能长期归组统计的东西。逐条效果里的 `lineDelta` 对单次排障有用, 对
   * "no-op 写占多少" 这个真问题没用 —— 而后者才是决定"要不要从**报**升成**判**"的那个数。
   * 逐条仍在日志里(`executor-dag` 的 warn/info), 排障够得着。
   *
   * ⚠ **两个数都是 0 与整个字段缺席不是一回事**: 前者 = 这个节点跑了但一次文件都没写;
   * 后者 = 这条链上没人报(inproc/command 节点, 或早于本次改动的 checkpoint)。
   * 读数板必须把这两种分开念, 否则"没记"会被读成"没跑过"。
   */
  writeCounts?: [total: number, noop: number];
  /**
   * 本节点三道闸的**在场态**(2026-09-02)。形状与语义的真源 = {@link LeafGateStates}。
   *
   * 为什么要它上到 LeafResult: `AgentLeafResult.gates` 此前只活在内存与一行日志里 ——
   * 于是「这个节点根本没配写闸」与「配了且一次都没越界」在**任何可查的账**上都长得一样,
   * 只能靠人翻日志。碰撞台账那次 `rows=2924 / strict=0` 的缺口是靠 `stats()` **查账**发现的,
   * 散在日志里的行复制不出那种发现。本字段是把它送进 `DagRunNode.gates` 的那一跳。
   *
   * ⚠ **缺席 ≠ 三道闸都没配**(仓规 §静默坑 1 NULL≠0≠不适用):缺席 = **这条链上没人报**
   * (command / inproc 节点、注入的 fake runner、早于本次改动的记录);`'unavailable'` 才是
   * 「报了,而这道闸没配」。统计"没配写闸的节点占比"时,分母只能取**报了的**那些。
   */
  gates?: LeafGateStates;
  /**
   * **fan-in 产物锚账**(2026-08-07):`[全文里的路径锚总数, LLM 摘要没保住的个数]`。
   *
   * 只有**真跑了 fan-in 定向摘要**的 producer 节点才有(扇出 ≥2 ∧ 输出够长)。
   *
   * 为什么存这两个原始数, 不存"保留率": 同 `command` 存原文、`model` 存坐标的那条理由 ——
   * 比率是派生值, 而分母的定义(锚怎么抽)以后会改, 两个计数不会。
   * 也**不存"补回后还缺几个"**: 那是 `FANIN_ANCHOR_CAP` 的函数, 而那个常数正是要靠这批读数去调的,
   * 把它烘进历史记录, 调完常数之后旧行就再也读不了了。
   *
   * ⚠ **三态,读的时候别互相替代**:
   *   · 字段缺席   = 这个节点**没做过** fan-in 摘要(绝大多数节点), 不是"没丢";
   *   · `[0, 0]`   = 摘要做了, 但全文里**一个路径锚都没有** —— 这把尺子**不适用**, 也不是"满分";
   *   · `[N, k]`   = 摘要做了, N 个锚里 LLM 丢了 k 个(k 个已由程序逐字补回视图, 见 composeAnchorBlock)。
   *
   * 这批读数要回答的问题只有一个:**`FANIN_ANCHOR_CAP=50` 该不该调** ——
   * 看 `k` 的分布有多少落在 50 以上。
   */
  faninAnchors?: [anchors: number, lostByLlm: number];
  /**
   * `executor:'command'` 节点的退出码。**负数 = command-leaf 的闸拒**(白名单/元字符/git 写/
   * 危险命令),不是被执行命令的退出码。
   *
   * 为什么值得单记一位(2026-07-31,第四跑逼出来的):「节点没过」有**两种成因,后续动作相反** ——
   *   · 普通失败(exit ≠ want):断言没成立 → 再试一轮可能就好了(`STALLED`)
   *   · **闸拒**(exit < 0):Harness 拒绝了这个操作 → **再试也没用**,白名单不会因为重试而放行
   * 书 §4.4 的五态表里,后者正是 `BLOCKED` 的教科书定义(「触碰范围禁区或权限边界 ·
   * Harness 层拒绝了某个操作 · 停止自动重试,直接升级给人」),而我们今天把它降格成"节点 failed",
   * 与普通失败混成一堆 —— 连"这一跑被闸拒了几次"都要去读日志。
   *
   * ⚠ **本字段只记不判**:是否该据它走 BLOCKED 出口, 取决于「连续几轮找不到一条合法命令」这个数,
   * 而那个数今天是 0 读数(第三跑实测 conductor 会从闸拒里自愈:拒→拒→过)。先记,再定 K。
   */
  // 三态 (H5-1, 2026-08-19): 缺席 = 非 command 节点 / 老记录; `null` = **死于信号**(没有主动退出码);
  // 数字 = 真退出码 (负数 = 闸拒)。别把 null 折成 undefined —— 那会把"被杀了"读成"没记"。
  exitCode?: number | null;
  /**
   * agent leaf **读过**的文件 (D-12, 来自 AgentLeafResult.filesRead)。图外数据流的观察面 ——
   * `plan/observers.lintArtifactEdges` 据它报「未声明的制品依赖」, 复用滤镜据它拦「读过被拒制品的
   * 消费方」(INV-P2-4/5)。resume 跳过的节点从 checkpoint 的 `inputPaths` 还原, 观察面不因续跑变窄。
   */
  filesRead?: string[];
  /**
   * research leaf 真抓到正文的 URL (INV-GOAL-2 证据面)。零来源的 research 节点在引擎里已判 failed,
   * 故 done 的 research 结果这里恒非空 —— 下游 gate/审计据此判"这份研究是否真落地过网页"。
   */
  sources?: string[];
  /** agent leaf 的工具调用次数 (来自 AgentLeafResult.toolCalls; prompt 档的路由效率读数)。 */
  toolCalls?: number;
  /** agent leaf 的 LLM 调用次数 (来自 AgentLeafResult.llmCalls, R-1 2026-09-03)。缺席 = runner 没报, 不编 0。 */
  llmCalls?: number;
  /** agent leaf 实际用的 thinking 档与通道 (来自 AgentLeafResult.thinking, R-1 第 3 步)。缺席 = runner 没报。 */
  thinking?: { level: 'off' | 'low' | 'medium' | 'high' | 'xhigh'; channel: 'pi' | 'sdk' };
  /**
   * agent leaf 经 **bash 工具**跑过的命令 + 退出码 (2026-08-05, 来自 AgentLeafResult.shellRuns)。
   *
   * 它补的是**「诚实自验」这条记录通道**: agent 手里有 bash,「我跑了 `bun test`,3/3 通过」
   * 是合法自验的主要形状 —— 而引擎此前只记 `toolCalls` 的**次数**, 数不出跑的是什么、过没过。
   * 于是 `plan/claimed-actions` 那个谓词 (「声称的引擎校验动作 ⊆ 引擎记录的动作」) 的**记录集
   * 缺了主要合法元素**, 真跑过测试的节点与顺手编一句的节点在 facts 上分不开。
   *
   * ⚠ 缺席 = 这条链上没人报 (inproc leaf / 旧 runner), 与 `[]` (跑了但一次没用 bash) 是两件事。
   */
  shellRuns?: ShellRun[];
  /**
   * agent leaf 的**工具调用序列** (2026-08-16, 来自 `AgentLeafResult.toolSteps`)。
   * 缺席 = 非 agent 叶 / runner 未报, **不是**"一步都没调"(那是 `[]`)。
   * 它答的是既有三本账都答不了的那个问题: **它按什么顺序做了什么** —— 判据见 `ToolStep` 的注。
   */
  toolSteps?: ToolStep[];
  /** 序列被截掉的步数 (头尾保留法)。缺席/0 = 没截。 */
  toolStepsDropped?: number;
  /** 早期心跳闸判停摆 (issue #5): provider 挂起, 未等满硬超时即中止 → settle 记 failureKind='stall'。 */
  stalled?: boolean;
  /**
   * agent leaf watchdog 采集 (2026-08-12, S1 埋点)。engine 从 AgentLeafResult.watchdog 原样透传
   * (done/failed 两条出口都带), 供 checkpoint 写入磁盘。形状/缺席语义真源 = {@link LeafWatchdog}
   * (2026-08-18 收敛: 此前这里手抄 S1 五字段, b87196e 加 grind 字段后与生产侧漂移了 6 天,
   * 注释还写着「形状一致」—— 引用同一类型后这类漂移直接 tsc 红)。
   */
  watchdog?: LeafWatchdog;
  /**
   * **引擎推断的写目标**(2026-08-06):命令原文点名要写、且那个文件在本节点执行窗口内变过。
   * 与 `filesTouched` 同一个 `artifactRoot` 根。
   *
   * ## 为什么它与 `filesTouched` 刻意是两位
   *
   * `filesTouched` 是**事实**(受控写工具 write/edit/hashline 的记录);这一位含**推断** ——
   * `a && b > x` 里 `a` 失败时 `x` 并没有被写,而同窗口另一个节点写了它就会被认领。
   * 证据强度不同的两类压成一个字段之后,「这条 finding 是真的还是推出来的」就永久分不开了。
   *
   * ## 它补的是哪个盲点
   *
   * `filesTouched` 只认受控写工具,于是 ① `command` 节点那一路**从不填这一位**
   * ② agent leaf 既用受控工具又用 bash 写时,bash 那部分隐形(产物闸的救援② 只在
   * `filesTouched` **空**时才跑)。⑧.6 运行时写竞争的机会分母因此长期够不着。
   *
   * ⚠ **它只进可见性,不参与任何判定** —— 产物闸、节点成败、judge 一律不看它。
   *   放宽产物闸是另一件事(那条闸的安全性质是「没有盘上证据就不救」,挡的是 empty-done);
   *   这一位要的是**看见**,不是**放行**。两者刻意不共用一条通道。
   *
   * ⚠ 缺席 = 这条链上没人报(inproc leaf / 没跑过 shell / 旧记录),与 `[]`(跑了 shell 但
   *   一个写目标都没核实过)是两件事。
   *
   * ⚠ **command 节点的根是仓根**:`CommandLeafResult` 不报 cwd,所以相对目标一律按
   *   `repoRoot ?? process.cwd()` 解析。一条 `cd 别处 && > x.md` 的相对目标会解析到仓根、
   *   核不过、于是**不产候选** —— 漏认不误认,方向与整条通道一致(agent leaf 有 `cwd`,
   *   走 `artifactRoot`,没有这个问题)。
   */
  writeCandidates?: string[];
  /** conductor 节点实跑的内环轮数 (D-A)。其它 kind 缺席。 */
  rounds?: number;
  /**
   * **节点墙钟耗时** (2026-08-19, C-1):由 settle 在节点落账点写一次, 喂 dag-record 的节点级列
   * `duration_ms`。真源 = `nodeStartedAt` (引擎侧起跑时刻), 而**不是**事件到达间隔 (D-5)。
   *
   * ⚠ 三态 (INV-1): 数字 = 真值 · `null` = `nodeStartedAt` 没记到 (runNode 早退分支 / 引擎异常) ·
   *   整个字段缺席 = 早于本次改动的行 (dag-record 读侧已按 `typeof === 'number'` 处理,
   *   undefined 与 null 都得 null 入 DB —— 这里统一写 null 不留缺席)。
   * ⚠ **0 与 NULL 严禁互换** (INV-1): 一条真实耗时 0ms 的节点是合法观察, 而缺失把它写成
   *   `0` 会把"没记"读成"瞬时跑完", 与「真零」分不开。
   */
  durationMs?: number | null;
  /**
   * **leaf 内环轮数** (2026-08-19, C-1):与 DAG 表列 `turns` 对齐。仅 conductor 节点有内环
   * (`rounds`), 其它 kind (inproc/agent/command/map/primitive/research/await) 没有这个概念
   * —— 写 null 而不是 1, 因为「单发没有 turn 数」与「跑了 1 圈」是两种事实, 后者只见于
   * conductor 内环 (cross-off check: `settled.rounds === 1` 是真"只跑了一圈")。
   *
   * 拿不到 (`rounds` 缺席) 也写 null —— 同 (INV-1):「不知几圈」≠「一圈」。
   */
  turns?: number | null;
  /**
   * conductor 节点内环 judge 的最终裁决 (D-F)。
   *
   * ⚠ **缺席 ≠ 未收敛**: 缺席意思是**没人判过** —— 最后一轮默认不请 judge (省一次贵座调用),
   * 要裁决得在节点上显式写 `judge_final: true`。调用方拿它当"整体目标成了吗"的答案时,
   * `converged ?? false` 是对的读法 (没人判过就不许算成), 但别把它读成"judge 说没成"。
   */
  converged?: boolean;
  /**
   * **BLOCKED 异步出口** (D-Q): 环停在这里不是因为失败, 是因为**没有外部输入就推不动**。
   *
   * 与 `converged=false` 的区别在于该怎么办: 未收敛 = 再来一轮可能就好了; blocked = 再来多少轮
   * 都一样 (判据是确定性的, 见 `plan/observers.detectLoopNoProgress` 与 detector 节点的
   * `BLOCKED:` 协议), 该由 owner 看一眼。**blocked 恒不算收敛** —— 两个字段一起出现时,
   * `converged` 必为 false (fail-closed: 阻塞更不该被读成成功)。
   */
  blocked?: string;
  /**
   * **环因预算停的**(2026-07-31, 承 Loop Engineering 的第四条停止轴)。
   *
   * 四条停止轴里我们本来只有三条:轮数上限 · 空转 · 完成检查。缺的是**预算与时间** ——
   * 于是一个目标只要 judge 每轮都说"还不行",就会一路烧到 `max_rounds` 才停,而没有任何一处
   * 问过"这已经花了多少"。
   *
   * ⚠ 它与 `blocked` 的下一步**不一样**,所以是两个字段不是一个:
   *   - `blocked` = 判据是确定性的,**再多轮/再多钱都一样**,该 owner 去看;
   *   - `budgetStopped` = 只是钱/时间用完了,**加预算 resume 很可能就成**。
   * 混成一个词会让两个完全不同的下一步读同一句话(D-P 给 `cancelled` 单独立词的同一条理由)。
   * 恒与 `converged: false` 同时出现(fail-closed:没跑完就不是成)。
   */
  budgetStopped?: string;
  /**
   * **引擎外层轮号**(2026-08-21, C-0): 该节点落在引擎外层的第几轮 (跨轮身份)。
   *
   * ⚠ 三态 (INV-0-3): 数字 = 真轮号 (跨轮身份) · `null` = 没记 / 来源链没接 · 整个字段
   *   缺席 = 早于本次改动的节点。读数板按 `typeof === 'number'` 取, `null` 与 `undefined`
   *   都得 null 入 DB。
   */
  dagRound?: number | null;
  /**
   * **早轮同 id 节点被本轮覆盖时被落上的轮号**(2026-08-21, C-0): 末轮那条不设 (INV-0-1)。
   *
   * 语义 = 「这一轮的工作被后一轮重做, 这部分的 token 算浪费」。引擎在 settle 落账时给早轮
   * 那条 LeafResult 上写 `overriddenBy = currentEngineRound`; 末轮那条 LeafResult 此位为
   * `null` —— 「最后一轮不算被覆盖」。
   *
   * ⚠ 三态 (INV-0-3): 数字 = 真轮号 (被覆盖的证据) · `null` = 末轮 / 没记 · 整个字段
   *   缺席 = 早于本次改动的节点。
   */
  overriddenBy?: number | null;
  /**
   * **注入文本的 token 数**(2026-08-21, C-0): 本节点 prompt 里由上游注入的那部分 (fan-in 视图)
   * 折成的 token。语义 ⊆ `tokensIn`, 与 `fanin-summary` 实际注入进 prompt 的那段一致
   * (摘要就数摘要, 全文就数全文, INV-0-2)。
   *
   * 来源: inproc 路径可观察, 引擎按 `(deps 文本) fencedUpstream → chars/4` 真值写;
   * agent 路径 SDK 自管 prompt, 这里数不到 → **null** (INV-1: 「拿不到」≠「零」)。
   *
   * ⚠ 三态 (INV-0-3): 数字 = 真值 (含 0 = 已知无上游, **不是**没记) · `null` = 没记 /
   *   agent 路径 · 整个字段缺席 = 早于本次改动的节点。
   */
  injectedTokens?: number | null;
  /**
   * **节点级 self_check 自修环的落账** (P1 C-4, 2026-08-21)。
   *
   * 严格三态 (INV-4-1, 不许压平):
   *   - **整个字段缺席** (`undefined`) = 该节点**没有** self_check (旁路, INV-1-2) — 「这条路不适用」;
   *   - `null` = self_check 存在但**没有**被听见 (SDK 通道, INV-2-1: 无 followUp 钩子) —「路在但被截断」;
   *   - `{rounds, oracleExit, convergedAt}` = self_check 真的跑了。
   *     **INV-4-2**: `oracleExit.length ∈ {rounds, rounds + 1}` —— 差 1 = 跑了收尾 probe (收敛/闸拒);
   *     差 0 = 环被轮数上限/零进展在 probe **之前**停掉,「那一次 probe 不存在」不是「跑了没记上」。
   *     **INV-4-3** 是**单向**蕴含: `convergedAt !== null` ⟹ 末项 `=== expect_exit`; 反向不成立
   *     (配了 `expect_output` 时退出码对而输出没匹配上, 末项 `=== expect_exit` 但 convergedAt 仍 `null`)。
   *     ⚠ 这两条 2026-09-02 按探针实测修正过 (此前写成「= rounds + 1」与「⟺」, 都比实装严);
   *     **实装未动, 只改了注释**。措辞真源 = `agent-leaf.ts` 的 `SelfRepairLedger`。
   *
   * `null` 与 `{rounds: 0, …}` **绝对不互换**: 前者是「路在但截断」, 后者是「判据一次就绿」——
   * 读数板要的是这一格的下一步不同。分辨靠 **字段在不在**, 不靠猜值。
   *
   * 来源: `agent-leaf.ts` 的 `AgentLeafResult.selfRepair` (`leaf-runners.ts:259`); 引擎在
   * settle 时透传 (本字段当前**未**在 `dag/engine.ts` 接线, 测试通过构造 `LeafResult.selfRepair`
   * 直接落库验证 — 同 slice 1 round-fields 的写法)。
   *
   * ⚠ **缺席 / null / 对象三态纪律** (INV-4-1 与切片 1 的 INV-0-3 同一条根): 缺席是「不适用」,
   *   null 是「截断」, 对象是「真跑了」。三者对应的下一步完全不同, 任何一处把它折成一个都会
   *   让读数板误诊。「`null` ⟺ 跑过但首轮没过」这种**直觉翻译**正是这一位要挡的错。
   */
  selfRepair?: { rounds: number; oracleExit: number[]; convergedAt: number | null } | null;
  /**
   * **`run_acceptance` 台账**(P3 S2, 2026-09-02)。真源 = `AgentLeafResult.acceptance`, 引擎在 settle 透传。
   * 三态与 `selfRepair` 同款守法: 整个字段缺席 = 没派冻结判据;`null` = 派了但 leaf 侧没有作用域;
   * 对象 = 派了 —— `ran` 只认 `run_acceptance` 调用, 报告闸 (S3) 拿它与尾块 `acceptance_ran` 对账。
   */
  acceptance?: { ran: boolean; rounds: number; last: AcceptanceOutcome | null } | null;
  /**
   * **leaf 末条消息的机器尾块**(P3 S3 / D-12)。三态: 整个字段缺席 = 本节点没过尾块审计(conductor 节点 /
   * 早于本次改动);`null` = 有 fence 但解析失败(原文在日志);对象 = 引擎采用的尾块, `self_report` 标明
   * 来源: `'leaf'` 真值 / `'missing'` 缺席时按记录合成。差集判词见 `report/trailer-audit.ts`。
   */
  selfReport?: (Trailer & { self_report: 'leaf' | 'missing' }) | null;
  /**
   * **引擎自己出事导致环提前退出**的原因(2026-07-31)。今天唯一的来源: judge 调不通
   * (`ModelError` —— 传输/配置层的确定性故障, 如 codex 拒 temperature)。
   *
   * 与 {@link blocked} 分开的理由是**下一步相反**(同 N5 词表): blocked = 要人给外部输入,
   * 再多轮都一样; infraStopped = **引擎该修**, 而它此前被念成 `not-converged` ——
   * 于是读的人会去加轮数, 而加轮数恰恰是最没用的那个动作。实测: 一个改配置一分钟能修的事,
   * 烧掉了全部轮数, 症状看起来像"任务太难"。
   */
  infraStopped?: string;
  /**
   * **judge 自己那一票**(2026-08-01),与 {@link LeafResult.converged} 分开带。
   *
   * 冻结判据进环之后 `converged` 是**判据**说的(D-I 以判据为准),不再等于 judge 说的。
   * 两者混在一起, 判据轴就会把「判据绿」误记成「judge 也说绿」—— 而那正是它要量的那一格
   * (judge 太紧: 判据过了而 judge 说没成)。
   *
   * 缺席 = 这一跑没走环内判据那条路, 或 judge 调不通(**没投过票, 不是投了反对票**)。
   */
  judgeConverged?: boolean;
  /**
   * **这个节点是靠冻结判据绿停的**(C,2026-08-21,run `58df6b9e` 复盘)。
   *
   * 立它的理由只有一个:外层 verifier 要否决一轮时,得知道这一轮**有没有拿到过机器绿**。
   * P2 那跑的形状是 —— 内环 `stop:{kind:'success', evidence:'冻结判据绿'}`、`poisoned:[]`,
   * 然后外层 verifier 照样推翻它触发重规划;而重规划之后 verifier 的判词抱怨
   * 「5/7 成功、2 个失败」,**那两个失败正是它自己那次否决造成的**。判词在给自己制造的残骸打分。
   *
   * 缺席 = 没走环内冻结判据那条路(**不是**"判据红")。判据红的节点 `status` 自己会说。
   */
  freezeGreen?: boolean;
  /**
   * **判据的时效锚** (S-44, 2026-08-24) —— `freezeGreen` 为真那一刻的工作树快照。
   *
   * 立它的理由: `freezeGreen` 不只是记录位, 它在外层**拦着 verifier 的否决**。而判据跑完之后
   * 引擎还有写权 (实账 run 83d9dfb6: 判据 21:29 真绿 `5927 pass / 0 fail`, 21:55 收编,
   * 中间 26 分钟第二批节点继续改盘; 在收编那棵树上复跑同一条判据 `exit 1 / 4 fail`)。
   * 没有这个锚, 那道闸就在**用 T1 的绿保护 T2 的树**。
   *
   * 缺席 = 没拿到锚 (非 git 仓 / git 不可用)。**`null` 与"没变"是两件事** ——
   * 下游按 `unknown` 处理, 不许当成 `same` (仓规坑①: 三态不压平)。
   */
  freezeAnchor?: import('../goal/criterion-anchor').TreeAnchor;
  /**
   * **节点级空转档 2 阶梯报告** (SDD S2, 2026-08-25, 片 3 / 片 4 持久化):
   * 档 1 + 档 2 两条 reading 的结构化字段 (INV-7: 四字段齐备, 缺档/缺字段均判失败)。
   *
   * 缺席 = 节点未走 ladder (无 spin 史 / ladder 未启用) —— **不是**"走完且两档齐绿"。
   * (NULL≠0: 「没走」与「走完都失败」分得开, 读数板必须按字面念。)
   *
   * 落地三处: 失败 LeafResult / NodeCheckpoint / RunNodeView.checkpoint; 报告形状在
   * `./spin-rung2.ts` 冻结 (片 1), 写读面在片 4, 引擎接线在本片。
   */
  spinLadderReport?: SpinLadderReport;
}

/**
 * D-4 打回共享契约 (SDD 2026-08-10-blame-scoped-node-retry)。本文件是跨消费方 (engine / dag-record /
 * readout) 的冻结接缝: 责备集 schema **复用** blame.ts 的导出, 此处只 re-export + 命名, 不重定义
 * (重定义即漂移源)。语义指纹的铸造与 D-21 复用匹配逻辑在 plan 层, 不在本文件 (SDD Non-goal)。
 */

/** 责备集条目 (点名节点 / 点名产物) 与产物→节点解析结果 — 直接复用 blame.ts, 本文件不重定义。 */
export type { BlameEntry, BlameResolution };

/** 解析后的责备集 (parseBlameVerdict 返回形)。undefined = 无围栏 / JSON 坏 / 空数组 → fail-open 整轮 (INV-1)。 */
export type ParsedBlame = BlameEntry[] | undefined;

/** 失效闭包 = blamed ∪ downstream(blamed) (D-2; invalidationClosure 返回形)。 */
export type InvalidationClosure = ReadonlySet<string>;

/** D-4 跨轮毒集 (传播载体): 上一轮被点名/闭包内节点的语义指纹。命中者不进 D-21 复用池。 */
export type PoisonedNodes = ReadonlySet<string>;
/**
 * 上一轮执行的 {plan, results} —— D-21 跨轮语义复用的输入。
 * 轮内 escalation 与外层 fixpoint (iterateExecutorDag) 共用同一形状。
 */
export interface PriorExec {
  plan: ConductorPlan;
  results: Record<string, LeafResult>;
  /**
   * D-4b 指纹毒集: 被 review/judge 点名拒绝过的节点**语义指纹**。命中者不进复用池。
   *
   * 为什么锚在指纹而非节点 id: 外层每轮把 plan 扔掉让 conductor 重画, id 跨轮无意义 (且指纹刻意
   * 不含 id)。票在**铸它的那一轮的 id 空间**里生成, 当场翻成指纹再往下一轮带 —— 见 plan/iterate。
   *
   * 没有它, 被拒节点 (status 仍是 'done' —— 拒的是质量不是状态) 会被指纹匹配原样复用进修复轮,
   * 修复轮能否修对就全看 conductor 从散文里猜没猜中该改哪个节点。
   */
  poisoned?: PoisonedNodes;
}

/** D-4 打回读数 (SDD 2026-08-10-blame-scoped-node-retry 契约 f; 字段名冻结, 消费方在 dag-record/readout)。 */
export type BlameRetryLedger = {
  /** 解析出的点名节点数 (fail-open 走整轮 = 0)。 */
  blameSize: number;
  /** invalidationClosure 结果大小 (blame ∪ downstream)。 */
  closureSize: number;
  /** 闭包外且 D-21 指纹命中而复用的节点数。 */
  reuseHits: number;
  /** 本轮重跑墙钟 (ms)。 */
  rerunWallMs: number;
  /**
   * 本轮重跑用的是哪张图 (2026-09-03 v1 规划式 conductor 退役后只剩两档, 都不请模型画图):
   *   'deterministic' = 调用方给了 `deterministicReplan` (sdd-direct 平铺图复用编译产物, 可能被空转修补节点替换);
   *   'reinject'      = 原图 + verifier finding 锚定到被点名节点重跑 (dag_run_plan / map_deliver 等预置图)。
   * 历史行里的 'patch' / 'full' (补丁差量 / 整图重画) 是退役前的记录, 读侧照原样展示即可。
   * 未发生重跑的轮次不应出现该字段 (NULL≠0: 用字段是否存在区分"没走这条路"与"走了记 0")。
   */
  replanMode: 'deterministic' | 'reinject';
  /**
   * 本轮重规划请求的 token 用量。回落到整图时两段都算总账 (补丁尝试 + 整图重灌之和), 不因
   * 回落就丢掉补丁那段的花费。
   */
  replanTokens: { in: number; out: number };
};
export interface ExecutorDagResult {
  plan: ConductorPlan;
  /**
   * 本次 run 的**跨平面关联键** (= config.sessionId 或内部生成的)。
   *
   * 2026-07-31 起它同时是 **Langfuse 的 traceId + sessionId** —— 一次 run 的全部模型调用
   * (conductor / leaf / judge / verifier / research) 都经 `gateway.send()` 归到这一条 trace 上。
   * ⚠ 在此之前这句话写的是"Langfuse session id"而实际没有任何导出器, 那是**声明面与执行面
   * 对不上**; 现在为真, 但**仅当配了 LANGFUSE_* 三个 env** (不配 = 这一位仍只是个关联键)。
   */
  sessionId: string;
  /** 拓扑层级 (level 0 = 无依赖根; 每 level 内并行)。 */
  levels: string[][];
  results: Record<string, LeafResult>;
  usage: {
    /** conductor 规划用量 (升级时跨所有尝试累加)。 */
    conductor: ModelUsage;
    /** 所有 leaf 的 input/output token 合计 (output 永远全价, cache 只省 input — 见 contract §10.2)。升级时累加。 */
    leavesIn: number;
    leavesOut: number;
    /** 所有 inproc leaf 命中 prompt-cache 的 input token 合计 (⊆ leavesIn, 按 ~10% 价)。 */
    leavesCacheHit: number;
    /** 校验器用量 (跨所有 verify 轮累加)。仅 config.verifier 存在时有值。 */
    verifier?: ModelUsage;
    /**
     * **探测消耗** (S2 后半, I-11, 2026-08-25, C-2 / INV-9): 装配期探针 (probeShellSandbox
     * 等) 的独立 usage 段, 与 conductor/leaves 并列。**`computeCost` / `leafCostReward` /
     * `DreamCandidate` / `dreamFactInput` 一律不读** (I-11 隔离) ——
     * `recordReward(bucket, model, reward)` / dream extract·merge 路径在源头以 `rejectIfProbe`
     * 拒收。三态不可压平: 字段缺席 = 未采集, `calls:0` = 探了但无外部调用, `costUsd:null`
     * = 有调用但价格未知 (unpriced 模型)。
     */
    probe?: {
      calls: number;
      tokensIn: number;
      tokensOut: number;
      cacheHitTokens: number;
      costUsd: number | null;
    };
  };
  /**
   * D-21 跨轮语义复用命中的节点 id (本轮零 LLM 直接注入上轮输出)。空 = 无复用 (首轮 / 全变了)。
   * INV-GOAL-3 的"可证"面: 修复轮跑完看这个数, 而不是猜"应该复用了吧"。
   */
  reusedNodes?: string[];
  /**
   * resume 时**因规格变了而不许复用**的绿节点 id(T-1a/T-1b 规格守卫的读数,S-51 抓法 ③)。
   *
   * ⚠ **三格分明**(仓规坑 ①:`NULL` ≠ 0 ≠ 不适用):
   *   · 字段**缺席** = 这一跑不是 resume,「有几片因契约变更失效」这一问不适用;
   *   · 空数组 = 是 resume,而**一个都没失效**(契约与上一跑一致);
   *   · 非空 = 这些节点的绿被丢弃、本轮真重跑。
   * 把「不适用」与「0」压成同一个 `undefined`,事后就再也分不开「没 resume」和「resume 了但没变」。
   *
   * 为什么要抬到结果面而不是只留一行日志:S-51 那次的 run 摘要只说「复用 6 节点」,
   * 而「改的那件事有没有做」一个字都没有 —— 人第一眼看的正是摘要。
   */
  specChangedNodes?: string[];
  /**
   * **图外只读观察者**本次 run 的全部产出 (D-Q)。空/缺席 = 没观察到异常。
   * 它们已经在引擎内被前馈进下一轮的重展开 prompt; 这里是给调用方 (与事后审计) 的同一份。
   */
  observations?: DagObservation[];
  /**
   * 「声称 vs 引擎记录」检出器这一跑查了多少、检出多少 —— **两道分开记**(2026-08-05)。
   *
   * ⚠ 两道的**面宽度不同,合并即错**:
   *   - `conductor` = 内环那道,面 = output + facts + **产物内容**(judge 视图读盘的那份);
   *   - `flat`      = 整图那道,面 = output + facts,**不读产物内容**(读盘是 judge 视图专有预算)。
   * 两个分母**不重叠**:内环检过的子节点被平铺那道跳过。
   *
   * 加 `flat` 的理由是一次真跑撞出来的:那条判据原本只活在 conductor 内环,而 `dag_run` 那条路
   * 整张图可以一个 conductor 节点都没有 —— 检出器结构上够不着,账本却记成"零检出"。
   * 按 entry 数约一半流量走那条路 → 活体基率会被算低近一倍。
   * `flat` 那道**只进账本、不进任何 prompt**(纯测量,零行为风险);要不要让它也喂 DAG 级
   * verifier 是**单独的拨闸决定**,不在这里顺手做。
   *
   * ⚠ 缺席 = 早于本次改动的记录(不是"零检出")。
   */
  claimCheck?: {
    conductor: { rounds: number; nodes: number; findings: number };
    flat: { nodes: number; findings: number };
    /**
     * P3 S3: 尾块差集闸的三态 (与上面两道**分开记**, 尺子不同): 缺席 = 这一跑没有一个节点进过尾块审计;
     * `findings:0` = 审过零检出; `findings>0` = 检出 (判红)。散文正则那两道原样保留 (只报)。
     */
    trailer?: { nodes: number; findings: number };
  };
  /**
   * 「产物没变」判据(`loop-no-artifact-change`)这一跑**有过多少次判得了的机会**(2026-08-06)。
   *
   * 加它是因为读数板 ⑧ 段一直在拿**错的分母**读那个 0:53 跑 0 次命中被当成"活体基率 ≈ 0",
   * 而这条判据的机会单位不是"一次运行" —— 它住在 conductor 内环, 一次比较要同时满足
   * ① 内环真转到了第二圈(`max_rounds > 1` 且首轮没收敛)② 两轮都有产物信号 ③ 两侧都读得到。
   * 单轮档的 `dag_run` 与首轮即绿的 goal **一次机会都没有**, 于是那个 0 是「够不着」。
   *
   * 三个数的关系(读的时候别相加):
   *   `transitions` = 有上一轮可比的轮转次数(首轮不算 —— 那不是一次跨轮);
   *   `unobserved`  = 其中**判不了**的(population 空 / 有读不到的文件)—— 不进基率分母;
   *   `findings`    = 其中判成"没位移"的。
   *   → 基率分母 = `transitions - unobserved`;分子 = `findings`。
   *
   * ⚠ 缺席 = 早于本次改动的记录(**不是** transitions:0)。`transitions: 0` 是"这一跑确实
   *   一次跨轮比较都没发生", 与"没记"的下一步不同: 前者要问环为什么只转一圈, 后者只是老数据。
   */
  artifactMove?: { transitions: number; unobserved: number; findings: number };
  /**
   * **运行时**写竞争这一跑撞得上几次、真撞了几次(2026-08-06;判据见 `detectRuntimeWriteRace`)。
   *
   * ⚠ 与 `static-lint` 那条 `write-race` **同名不同义**,而两者的下一步相反:那一条是**跑之前**
   * 按 `output_path` 声明判死的坏 plan(改法是改图),这一条是**真跑时**两个并发 leaf 撞在同一条
   * (谁都没声明过的)路径上。台账此前拿前者的 4 次读数当后者的证据 —— 而后者的通道当时根本不存在。
   *
   * 三个数别互相替代:
   *   `overlaps` = 执行窗口真重叠过的节点**对**数(有没有并发本身);
   *   `pairs`    = 其中**两侧都报过写**的对数 —— **只有它是"撞得上"的机会**;
   *   `findings` = 其中路径真相交的对数。
   * `overlaps - pairs` 是看不见的那部分(一侧没报写:可能真没写,也可能写了而 `filesTouched`
   * 够不着,如 command 节点走 shell)。两者今天分不开,所以**不进机会分母**。
   *
   * ⚠ 缺席 = 早于本次改动的记录;`overlaps: 0` = 这一跑压根没有并发(常见:窄图/链式图)。
   */
  /**
   * **这次跑坏了回得去吗**(D1, 2026-08-06)—— 起跑那一刻的 git 状态快照。
   *
   * D-AB 说「范围内写」可以放手, 理由是 git 就是 rollback。而 R2 的隔离档默认关着、
   * 只挂在 `dag_goal` 一个入口上, 实测**从来没被用过一次** —— 所以绝大多数跑直接写当前
   * 工作树, 而那一档上「git 就是 rollback」是**有条件的**: 条件是起跑时树干不干净。
   *
   * ⚠ 四态下一步互不相同, 别压平(判词见 `describeRollback`):
   *   `clean` = 真能整还原 · `dirty-tracked` = **没有回滚对象**(写混在同一片 diff 里) ·
   *   `dirty-untracked` = 半个(`git clean -fd` 会删掉你原有的未跟踪文件) ·
   *   `not-a-repo` = git 这条路不存在 · `unknown` = **查不了, 什么都别断言**。
   * ⚠ 缺席 = 早于本次改动的记录。**只报不拦**。
   */
  rollback?: RollbackAnchor;
  writeRace?: {
    overlaps: number;
    pairs: number;
    findings: number;
    /**
     * 把**推断**的写目标(`DagNodeResult.writeCandidates`)并进来之后的机会 / 命中数
     * (2026-08-06 补)。缺席 = 早于本次改动的记录。
     *
     * ⚠ 与严格那两个**不许相加也不许互相替代**:严格口径是受控写工具的事实,这两个含推断
     *   (`a && b > x` 里 a 失败时 x 并没有被写)。`pairsInferred - pairs` 是**只有推断才看得见**
     *   的那一块 —— 要把这条升成闸的人必须先知道那一块有多大。
     *   而 `overlaps - pairsInferred` 才是今天两条判据都够不着的那部分。
     */
    pairsInferred?: number;
    findingsInferred?: number;
  };
  /**
   * **协作式取消** (D-P) 的留痕: 给了就说明本次 run 是被叫停的, 不是自然跑完的。
   *
   * ⚠ 调用方**不许把它读成失败, 也不许读成成功**: 已跑完的节点全在 `results` 里、checkpoint 全在盘上,
   * 该 run 用同一个 runId `resume` 就接着跑。`notRun` 是"一个都没起跑过"的节点 (no-silent-caps:
   * 少跑了什么必须说出来, 否则调用方会把一份残图当全图读)。
   */
  cancelled?: { reason: string; at: string; notRun: string[] };
  /** 校验结果 (仅 config.verifier 存在时有值)。escalated=是否触发过 conductor 升级。 */
  verification?: {
    pass: boolean;
    reason: string;
    /** plan+exec 尝试次数 (1 = 未升级 / 首轮即过 / 无可用升级模型)。 */
    attempts: number;
    escalated: boolean;
    /** 最终采用的 conductor 模型 (升级后 = 升级模型)。 */
    conductorModel: string;
    /** D-6 同因熔断 (SDD 2026-08-11-inner-loop-v2, O-2): 连续两轮同一根因 → 停止重试标 STALLED。缺席/false = 未熔断。 */
    circuitBroken?: boolean;
    /**
     * S3 片 5 (D-5, INV-5/6): verdict 账本里出现过 infra 记录 (verifier 调不通等)
     * —— 与 `pass` 解耦, 仅作观测面。**缺席 = 未观察到** (≠ false)。原因 (仓规坑 1):
     * 「账本里没记」与「记了 false」是两件事, 合并会让 infra 触发时自动伪造一次失败。
     */
    infraObserved?: boolean;
  };
  /** D-4 打回读数 (SDD 2026-08-10-blame-scoped-node-retry, 契约 f 单对象): 最近一次 verifier 打回。缺席 = 没打回。 */
  blameRetry?: BlameRetryLedger;
}
