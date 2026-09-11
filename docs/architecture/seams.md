# 引擎 Seam 目录 —— ExecutorDagConfig 的能力接缝

<!-- 生成文件, 勿手改。真源 = src/harness/dag/types.ts 的 Dag*Seam 接口。
     重新生成: bun scripts/gen-seam-catalog.ts ; 校验: bun scripts/gen-seam-catalog.ts --check -->

每个 seam = 一组可替换能力。字段全文文档在类型定义里 (点进去看), 本目录回答三件事:
**有哪些接缝 · 每个字段谁在消费 · 换实现该去哪换**。消费方是 token 级扫描的上界
(只扫代码 —— 注释与字符串字面量里提到字段名不算消费), 列出命中最多的前 3 个文件。

> 8 个 seam · 50 个字段 · 扫描范围 src/**/*.ts (排除测试)

## DagSeatsSeam

模型座位 seam: 引擎各角色绑哪个模型坐标。

| 字段 | 必填 | 类型 | 一句话 | 消费方 (前3) |
|---|---|---|---|---|
| `conductorModel` | **是** | `string` | conductor 模型 'provider:modelId' (规划用, 我们=mimo:mimo-v2.5-pro)。 | `src/mcp/tools/dag-tools.ts`<br>`src/harness/dag/engine.ts`<br>`src/harness/goal/loop-run.ts` (19 文件) |
| `leafModel` | **是** | `string` | inproc leaf 模型 'provider:modelId' (生成/判断单发)。 | `src/mcp/tools/dag-tools.ts`<br>`src/harness/dag/engine.ts`<br>`src/eval/oracles/fullstack-dag.ts` (13 文件) |
| `agentLeafModel` |  | `string` | agent leaf 模型 (带工具改文件)。 | `src/mcp/tools/dag-tools.ts`<br>`src/mcp/tools/pathfinder.ts`<br>`src/harness/dag/engine.ts` (10 文件) |
| `conductorEscalationModel` |  | `string` | conductor 升级模型 'provider:modelId' (verifier fail 时用更强模型重规划重跑)。 | `src/harness/dag/engine.ts`<br>`src/harness/execute-slice.ts`<br>`src/mcp/assemble.ts` (6 文件) |

## DagThinkingSeam

推理档 seam: 各角色的 thinking 档与输出预算 (S-T: 座位档由接线层注入, 显式永远赢)。

| 字段 | 必填 | 类型 | 一句话 | 消费方 (前3) |
|---|---|---|---|---|
| `conductorMaxTokens` |  | `number` | conductor 输出 token 预算 (plan JSON 随任务规模涨; thinking conductor 的推理可计入 completion)。 | `src/mcp/assemble.ts` (1 文件) |
| `inprocThinkingLevel` |  | `'off' \| 'low' \| 'medium' \| 'high' \| 'xhigh'` | inproc leaf 推理档 (默认 high; mass fan-out 省成本, 不走 max — 那是 omd 设计 / best-of-N 的档)。 | `src/harness/dag/engine.ts` (1 文件) |
| `seatThinking` |  | `(coord: string, seat?: string) => 'off' \| 'low' \| 'medium…` | S-T 座位推理档查询 (坐标 → 档): auto-assign 把「模型 + 推理档」成对下发, 执行期按节点已钉的 坐标反查该座位的档。 | `src/harness/dag/engine.ts`<br>`src/mcp/assemble.ts`<br>`src/harness/execute-slice.ts` (3 文件) |

## DagRunnersSeam

执行器 seam: 各 kind leaf 的可替换执行体与模型调用注入点 (引擎不直连 transport)。

| 字段 | 必填 | 类型 | 一句话 | 消费方 (前3) |
|---|---|---|---|---|
| `generate` |  | `GenerateFn` | 注入式模型调用 (inproc leaf, 默认 callModel)。 | `src/harness/dag/engine.ts`<br>`src/harness/goal/run-goal.ts`<br>`src/harness/goal/classify-acceptance.ts` (10 文件) |
| `agentRunner` |  | `AgentLeafRunner` | agent-kind leaf 的执行器 (带工具子 agent, 能改文件)。 | `src/mcp/assemble.ts`<br>`src/harness/dag/engine.ts`<br>`src/harness/goal/run-goal.ts` (7 文件) |
| `commandRunner` |  | `CommandLeafRunner` | command-kind leaf 的执行器 (确定性 CLI, 零 LLM, 方案 A)。 | `src/harness/goal/run-goal.ts`<br>`src/mcp/assemble.ts`<br>`src/harness/dag/engine.ts` (8 文件) |
| `forRoot` |  | `(root: string) => Pick<ExecutorDagConfig, 'agentRunner' \|…` | **换根时重建这两只手** (R5.1, 2026-09-07, 契约 `docs/plan/2026-09-06-并行实装扇出-执行契约.md` D-R5.1-2)。 | `src/mcp/assemble.ts`<br>`src/harness/goal/loop-run.ts` (2 文件) |
| `researchRunner` |  | `ResearchLeafRunner` | research-kind leaf 的执行器 (真 web 检索 + 有界内环, D-6)。 | `src/mcp/assemble.ts`<br>`src/harness/dag/engine.ts`<br>`src/harness/goal/loop-run.ts` (3 文件) |
| `router` |  | `LeafModelRouter` | executor leaf 模型选型路由器 (B-2 bandit, 见 model-router.ts)。 | `src/mcp/assemble.ts`<br>`src/mcp/tools/config-tools.ts`<br>`src/harness/dag/engine.ts` (5 文件) |
| `repoChecks` |  | `RepoCheck[]` | **leaf 级仓规检查清单** (D2 切片 2, #266 修补节点): 引擎对每个 agent leaf 跑完 之后、终态写入之前, 对该 leaf 的写集跑清单里每条 check。 | `src/harness/agent-leaf.ts`<br>`src/mcp/assemble.ts` (2 文件) |
| `spinRung2` |  | `{ threshold?: number; pools?: SpinRung2StampPools; }` | **节点级空转档 2 阶梯配置** (SDD S2, 2026-08-25, 片 3 engine 接线)。 | `src/harness/dag/engine.ts` (1 文件) |

## DagPlanningSeam

规划管线 seam: conductor 的输入约束 (roster/模板) 与 plan 的确定性变换/过滤。

| 字段 | 必填 | 类型 | 一句话 | 消费方 (前3) |
|---|---|---|---|---|
| `agents` |  | `string[]` | 限定 conductor 可派的 agent roster (进规划 system prompt)。 | `src/harness/pack/pack.ts`<br>`src/harness/inspect-tool.ts` (2 文件) |
| `agentTemplates` |  | `ReadonlyMap<string, AgentTemplate>` | Agent 模板注册表 (name → 角色卡, 见 agent-templates.ts)。 | `src/harness/dag/engine.ts` (1 文件) |
| `conductorPromptProfile` |  | `'full' \| 'lean' \| 'full-kb' \| 'lean-kb' \| 'bare'` | conductor system prompt 档位 (SDD v2, 2026-07-25): 'full' (默认, 弱 conductor 教练全量) \| 'lean' (只留环境事实, 顶级 conductor 如 k3 用 … | `src/mcp/assemble.ts` (1 文件) |
| `oracleCmd` |  | `string` | oracle 命令 (如 "bun run typecheck && bun test"): plan 中 command 与之等价的节点 在执行前被确定性过滤 (空白规范化后精确匹配, 最小无害边重连)。 | `src/mcp/tools/fleet.ts`<br>`src/eval/oracles/agent-leaf-prompt.ts`<br>`src/eval/oracles/fullstack-dag.ts` (7 文件) |
| `planFilters` |  | `Array<(plan: ConductorPlan) => ConductorPlan>` | SDD v2 pass 管线 (plan-passes/): oracle 过滤之后、执行之前依序应用的确定性 plan 变换 (接线层组装 prune → dedup → stamp; INV-8 pass 纯函数, 配置由接线层闭… | `src/mcp/assemble.ts`<br>`src/harness/dag/engine.ts` (2 文件) |
| `primitiveCandidates` |  | `string[]` | primitive 候选模型池 (SDD v2 D-8v2, INV-7): judge/parallel/tournament 原语的 N 路 attempts 按此池轮转分配 (跨家族多样性; 接线层从 stamp pools 注入)。 | `src/mcp/assemble.ts`<br>`src/harness/dag/engine.ts` (2 文件) |

## DagSchedulingSeam

调度与并发 seam: fan-out 上限、per-kind/per-channel 闸、暖发调度与协作式取消。

| 字段 | 必填 | 类型 | 一句话 | 消费方 (前3) |
|---|---|---|---|---|
| `maxFanout` |  | `number` | 内层 fan-out 并发上限 (传给 primitives.parallel)。 | `src/mcp/tools/dag-tools.ts`<br>`src/harness/dag/engine.ts`<br>`src/harness/goal/loop-run.ts` (15 文件) |
| `maxInflightLeaves` |  | `number` | **进程级** leaf 在飞上限 (P3 S8 / D-25 / INV-14, 2026-09-02): 一个进程里同时在飞的模型型 leaf (agent + inproc) 总数。 | `src/harness/dag/engine.ts`<br>`src/mcp/assemble.ts` (2 文件) |
| `warmThenFanout` |  | `boolean` | 暖发调度 (契约 §10.2): 全局先串行暖 1 发(写 cache)→ 再并行轰其余(命中共享冻结前缀)。 | `src/mcp/assemble.ts`<br>`src/eval/oracles/fullstack-dag.ts`<br>`src/harness/dag/engine.ts` (3 文件) |
| `warmGraceMs` |  | `number` | 暖发**宽限窗口上界** (ms, t-initial-pump 2026-09-02): 暖发那一发起跑后, 最多按住 pool 这么久不派新节点; 暖发提前 settle 则立刻放开 (上界, 不是定长延迟)。 | `src/harness/dag/engine.ts` (1 文件) |
| `kindFanout` |  | `{ agent?: number; command?: number; inproc?: number }` | per-kind 并发闸 (fanout 最大化设计, 2026-07-21): inproc 叶纯 API 等待、无本地足迹 → 默认不限 (只受 maxFanout/图宽/provider 池); agent 叶 (本地工具调用)… | `src/harness/dag/dag-scheduler.ts`<br>`src/mcp/assemble.ts`<br>`src/harness/dag/engine.ts` (3 文件) |
| `channelFanout` |  | `Record<string, number>` | per-channel 并发闸 (SDD v2 D-23, TFFInfer 多 Stream 同构): key = provider 前缀 (调度期由 node.model ?? kind 静态模型推出), value = 该渠道并… | `src/mcp/assemble.ts`<br>`src/harness/dag/engine.ts`<br>`src/harness/dag/dag-scheduler.ts` (3 文件) |
| `cancelSignal` |  | `AbortSignal` | **协作式取消** (D-P): 叫停这次 run。 | `src/harness/dag/engine.ts`<br>`src/mcp/tools/dag-tools.ts`<br>`src/mcp/tools/goal.ts` (3 文件) |

## DagLeafShapingSeam

leaf prompt 整形 seam: 注入 leaf 上下文/前缀/压缩级与档位闸 (省 token 与护 cache 的旋钮)。

| 字段 | 必填 | 类型 | 一句话 | 消费方 (前3) |
|---|---|---|---|---|
| `cavemanLevel` |  | `CavemanLevel` | 干活 leaf 的 caveman 压缩级 (省 output token)。 | `src/harness/dag/engine.ts` (1 文件) |
| `leafSystemPrefix` |  | `string` | inproc leaf 的共享冻结 system 前缀 (字节稳定 → 暖发后跨 leaf 命中 prompt-cache)。 | `src/harness/dag/engine.ts`<br>`src/eval/oracles/agent-leaf-prompt.ts`<br>`src/eval/oracles/fullstack-dag.ts` (3 文件) |
| `leafPonytail` |  | `boolean` | 给 leaf (构建相位) 注入 ponytail 反过度工程倾向 — 降生成代码量, 维二红线 (不变量/法定值/防丢错误处理/安全) 不在砍范围。 | `src/harness/dag/engine.ts` (1 文件) |
| `leafTaskContext` |  | `boolean` | 每个 leaf 的 prompt 是否携带**原始任务全文** (默认 true, 见 buildLeafPrompt 的注)。 | `src/harness/dag/engine.ts` (1 文件) |
| `leafTierGate` |  | `boolean` | g1 leaf 档位闸 (图「引擎墙钟与 leaf 档位」#9, 2026-08-04): 计划落地前拒 「executor:'agent' 读确定路径 + 无写意图 + 结构化产出」的节点/map 模板, 带改写建议重问 condu… | `src/mcp/assemble.ts` (1 文件) |
| `leafTierThresholdBytes` |  | `number` | g1「塞得下单 leaf prompt」阈值 (字节), 决定改写建议走「单 cat+leaf」还是「conductor 展开 per-item 对」。 | `src/mcp/assemble.ts` (1 文件) |
| `planCriticGate` |  | `boolean` | **plan-critic 静态闸进活规划环** (#247, 2026-08-24, 片 2): parsePlan 成功后跑一次 `critique()`, 只 enforce 无外部输入子集 `{PP-I01, PP-I02, … | `src/mcp/assemble.ts` (1 文件) |
| `faninSummary` |  | `FaninSummaryConfig` | fan-in **定向摘要** (引擎接缝, 2026-07-21): 一个 producer 的输出被 ≥2 个下游 consumer 消费时, 不再把全文复制 ≥2 份灌进各 consumer, 而是跑 1 发定向摘要 (按下游目… | `src/harness/dag/engine.ts` (1 文件) |
| `leafFace` |  | `(node: { id: string; executor?: string }) => LeafFace \| u…` | **按节点下发整副工具面 + system prompt** 的钩子 (P3 S6b, 2026-09-02; 编排循环的 conductor 节点用)。 | `src/harness/dag/engine.ts`<br>`src/harness/goal/loop-run.ts` (2 文件) |

## DagLoopControlSeam

内环控制 seam: 判据进环/judge 视图/预算/熔断/升级 —— 环的四条停止轴与跨模型校验。

| 字段 | 必填 | 类型 | 一句话 | 消费方 (前3) |
|---|---|---|---|---|
| `freezeCriterion` |  | `{ command: string; expectExit?: number; /** 期望输出子串。与 expe…` | 冻结判据 + (S-37 下沉 2026-08-17): 基线赦免谓词。 | `src/harness/goal/loop-run.ts`<br>`src/harness/goal/run-goal.ts`<br>`src/harness/dag/engine.ts` (3 文件) |
| `judgeArtifacts` |  | `boolean \| ArtifactBudget` | **产物内容进 judge 视图** (S1, 2026-08-03)。 | `src/harness/dag/engine.ts` (1 文件) |
| `ownerDirectives` |  | `(round: number, nonce: string) => string` | **owner 指令通道** (S3, 2026-07-31 / D-S)。 | `src/mcp/tools/goal.ts` (1 文件) |
| `loopBudget` |  | `{ /** 累计 leaf+conductor token(in+out)上限。 */ tokens?: numb…` | **环的预算上限**(2026-07-31)—— Loop Engineering 四条停止轴里我们唯一缺的那条。 | `src/harness/dag/engine.ts`<br>`src/harness/goal/loop-run.ts`<br>`src/mcp/tools/goal.ts` (3 文件) |
| `_budgetAnchor` |  | `number` | #158 预算时间轴的**锚时刻** (epoch ms)。 | `src/harness/dag/engine.ts`<br>`src/mcp/tools/goal.ts` (2 文件) |
| `verifier` |  | `VerifierFn` | 跨模型校验器 (model-agnostic skeptic, 见 verifier.ts)。 | `src/harness/verify-seats.ts`<br>`src/harness/goal/run-goal.ts`<br>`src/harness/goal/loop-run.ts` (17 文件) |
| `maxEscalations` |  | `number` | verifier-fail → 升级重规划的最大次数 (默认 1)。 | `src/harness/verifier.ts`<br>`src/mcp/assemble.ts`<br>`src/harness/dag/engine.ts` (5 文件) |
| `frozenNodes` |  | `readonly string[]` | **冻结判据节点**(SDD 2026-08-22 「冻结判据在重规划轮里并不冻结」)。 | `src/harness/dag/engine.ts`<br>`src/harness/dag/replan-spin.ts`<br>`src/harness/goal/loop-run.ts` (4 文件) |
| `deterministicReplan` |  | `() => ConductorPlan \| undefined` | **平铺图确定性重规划** (SDD 2026-08-22 「升级重规划成事件」续 / 平铺图 v2)。 | `src/harness/dag/engine.ts`<br>`src/harness/goal/loop-run.ts`<br>`src/harness/goal/run-goal.ts` (3 文件) |

## DagObservabilitySeam

观察与留痕 seam: 事件/回执/trace 分组/checkpoint —— 观察者不许扰动被观察者 (fail-open)。

| 字段 | 必填 | 类型 | 一句话 | 消费方 (前3) |
|---|---|---|---|---|
| `sessionId` |  | `string` | 本次 run 的 Langfuse trace 分组 session id (conductor+leaf 全部经 send 归此 session)。 | `src/tui/tui.ts`<br>`src/tui/backend-embedded.ts`<br>`src/harness/chat/agent.ts` (34 文件) |
| `onComplete` |  | `(result: ExecutorDagResult) => void \| Promise<void>` | 运行完成钩子 (留痕层接口)。 | `src/mcp/tools/dag-tools.ts`<br>`src/harness/dag/engine.ts`<br>`src/mcp/tools/compose.ts` (5 文件) |
| `onNodeEvent` |  | `(e: DagNodeEvent) => void` | 节点级进度事件 (2026-07-20, MCP 派发简报/活体 status 的数据源): planned = 图定型 (全部节点 id+kind, 每轮 plan/escalation 重规划各发一次) start = 节点起跑 … | `src/mcp/tools/dag-tools.ts`<br>`src/mcp/tools/fleet.ts`<br>`src/mcp/assemble.ts` (6 文件) |
| `continuity` |  | `{ manager: CheckpointManager; runId: string; resume?: boo…` | W2 continuity (SDD C4): 节点级 checkpoint 写入磁盘 + 崩溃恢复跳过。 | `src/harness/dag/engine.ts`<br>`src/mcp/tools/dag-tools.ts`<br>`src/mcp/tools/goal.ts` (7 文件) |
