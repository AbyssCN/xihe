/**
 * src/harness/agent-leaf —— 双模 leaf 的 **agent 模式** runner(executor-dag 的 `executor:'agent'` 节点用)。
 *
 * inproc leaf = 单发 callModel(无工具,生成/研究/判断)。
 * agent  leaf = 这里 —— 起一个**带工具的子 agent**(read / write / edit / ls / grep / bash),**能真改文件**。
 * 二者经 primitives 的 LeafFn 统一(mimo-leaf 契约 INV-5: 同一原语既驱动 callModel 也驱动 spawn_agent)。
 *
 * scope 原子化(契约 §granularity): 每个 agent leaf 应锁定**一个原子产物**(如一个文件),并行 leaf 改
 * 不重叠文件 = 天然原子;冲突走 DAG 依赖串行。cwd = 工作根,工具直接写盘。
 *
 * ## 2026-08-01: 从 `pi-coding-agent` 搬到 `pi-agent-core` 的 `runAgentLoop`
 *
 * 此前这里靠 `createAgentSession` —— 那是 **CLI 包**的高层门面 (steering 队列 / 可变会话状态 /
 * extension 运行时 / 资源加载器), 而 leaf 要的只是「给一段 prompt, 带工具跑到底, 返消息」。
 * 为了那一个循环, headless 的 MCP 路径整个挂在一个交互式前端上, 并且被迫用它的形状表达纪律:
 *
 *   · **有界性靠外面的秒表**: 高层 `prompt()` 没有 maxTurns 也不收 signal, 跑飞了只能 SIGKILL,
 *     于是有了 `runScopedSession` 那套 timeout+heartbeat+abort 的疤。低层循环原生收 `AbortSignal`
 *     且有 `shouldStopAfterTurn`(「turn 之间优雅停」)—— 有界性现在长在循环里, **不是外挂**。
 *   · **闸靠 extension 从外面贴**: 危险命令 / 凭证 basename 拒此前是 `tool-gate` 贴在通用工具上的,
 *     贴漏了就是 `cat .env` 那个洞。现在工具是我们自己的 (`agent-tools.ts`), **闸长在工具里**。
 *   · **静默吞错**: `createAgentSession` 失败返 0-token 空文本、不上抛 HTTP 状态 (C-5b 那道 loud-error
 *     闸就是为它加的)。低层循环把 `stopReason:'error'` 连同 `errorMessage` 原样交回 → 直接抛得出真因。
 *
 * 换来的代价是系统提示与工具集要自己拼 —— 而那恰恰是想要的: 见 `buildLeafSystemPrompt`。
 *
 * ## 2026-08-11: 摘要消息改用 pi 构造器 `createCompactionSummaryMessage`(台账 §1.4)
 *
 * 此前两处手拼 `role:'user'` + `COMPACTION_SUMMARY_PREFIX/SUFFIX` —— 那正是那个构造器的
 * 等价物。换过来顺带把两条压缩路的摘要消息**形状统一**了:轮前那条本来就来自 pi 的投影
 * (`buildSessionContext`,`dist/harness/session/context.js:47`),轮内那条此前是手拼的 user。
 * 同一件东西两个形状,`chat/compaction.ts` 要认出"本会话已有摘要"就只能按前缀串猜;
 * 统一之后认它靠 `role === 'compactionSummary'`,不靠字符串匹配。
 * 线上字节不变:`convertToLlm` 发出去时贴的还是同一对前后缀。
 *
 * ⚠ 下面这个 import 列表里**不要写注释** —— 台账 §5② 数 import 符号的那条命令按花括号整块
 * 匹配再逐行切词,列表里的注释会被切成假符号、注释里的花括号会让整块从读数里消失。
 * 两种都不报错,只是读数悄悄变了(2026-08-11 实测,两种都撞过)。
 */
import {
  runAgentLoop,
  convertToLlm,
  estimateContextTokens,
  estimateTokens,
  findTurnStartIndex,
  formatSize,
  serializeConversation,
  truncateTail,
  DEFAULT_MAX_LINES,
  createCompactionSummaryMessage,
  type AgentContext,
  type AgentLoopTurnUpdate,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type Entry,
} from '@earendil-works/pi-agent-core';
// 0.84 起 `runAgentLoop` 第 6 参 streamFn **必填** (0.81.0 breaking: "made low-level loop stream
// functions required")。0.80 省略时的内部默认就是这个 `streamSimple` —— 显式传 = 行为等价。
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { repoRelativePath } from './repo-path';
import { homedir } from 'node:os';
import { parseModelRef } from './fleet';
/**
 * D-7 leaf 侧 MCP 策略真源: 授权清单非空 → {allow}, 否则 deny —— 执行叶子不声明不授权
 * (chat 座位的 'allow' 缺省不传染叶子)。装配闭包与接线测试共用这一个函数, 禁复刻。
 */
export function leafMcpPolicy(mcpAllow?: string[]): { sideEffects: { allow: string[] } | 'deny' } {
  return mcpAllow && mcpAllow.length > 0 ? { sideEffects: { allow: mcpAllow } } : { sideEffects: 'deny' };
}

import { SHARED_ENGINEERING_CORE, LEAF_EXECUTION_CORE, LEAF_TOOL_ROUTING } from './harness-prompts';
import type { SelfCheckSpec } from './conductor-plan';
import { createOmdAgentTools, type AnyOmdTool, type OmdAgentToolsOpts, sha256Hex } from './agent-tools';
import type { ReadEvent } from './read-ledger';
import type { FileObservation } from './writeset/write-version';
import { createInspectTool } from './inspect-tool';
import { createSkillTools, type SkillToolDeps } from './skills/skill-tool';
import type { LeafProfile } from './profiles/profile';
import { defaultSkillRoots } from './skills/skills';
import { createMcpClientTools, type McpClientToolsOpts } from '../mcp/client/meta-tools';
import type { McpPoolDeps } from '../mcp/client/pool';
import type { McpCallLedger } from '../mcp/client/call-ledger';
import { createHashlineCustomTools, hashlinePatchPaths } from './hashline';
import { createDriftTracker, type DriftDetectorConfig } from './hooks/drift-detector';
import {
  RUNG_1,
  SPIN_ROUTE_OBSERVATION_KIND,
  SPIN_ROUTE_SDK_SKIP_LOG,
  buildSpinEvidencePack,
  judgeRungOutcome,
  samePack,
  spinRouteEnvEnabled,
  type AdvisorLines,
  type SpinEvidenceInput,
  type SpinEvidencePack,
  type SpinRouteEventOutcome,
} from './spin-route';
import { createParseFeedback } from './writeset/write-parse-gate';
import { extractFailSet } from './goal/accept-delta';
import {
  buildCriteriaDiff,
  buildRepairFollowUp,
  strategyForRound,
  type CriteriaDiff as RepairCriteriaDiff,
} from './self-repair-round';
import { createSandboxedLeafRunner } from './hooks/sandboxed-leaf';
import { loadSandboxConfig } from './hooks/command-policy';
import { allowlistForRoot, createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } from './command-leaf';
import { renderAcceptanceOutcome, runAcceptance, type AcceptanceOutcome } from './acceptance-run';
import { wrapReadOnlyShell } from './conductor/readonly-shell';
import { buildLeafSystemPromptV2, LEAN_LEAF_TOOLS } from './leaf-prompt-v2';
import { runtimeAllowlistForRoot } from './env-facts';
import { formatRepoChecksFailure, runRepoChecks } from './repo-checks';
import type { RepoCheck } from './repo-checks';
import type { GateSpawn } from './post-leaf-gate';
import { logger } from '../logger';
import { callModel } from '../model';
import { piModelFromProviderConfig, resolvePiApiKey, resolvePiModel, type PiModel } from '../model/pi-transport';
import { getProvider } from '../model/providers';
import { CLAUDE_SDK_PROVIDER, effortOf } from '../model/claude-sdk-complete';
import { officialAdvisorModelId, runSdkAgentLoop } from './claude-sdk-loop';
import { withToolCallSalvage, type SalvageEvent } from './leaf-salvage-stream';
import { createAdvisorTool, createTranscriptRecorder } from './advisor-tool';
import { promptVersionOfText } from '../model/langfuse';
import type { ContentPart, ModelUsage } from '../model/types';
import { emitModelUsage } from '../model/accounting';
import { cooldownMsFor, reportProviderFailure } from '../model/provider-health';

/**
 * pi 循环的 errorMessage 头部状态码 (`402: {...}` / `pi: 429: ...` / `HTTP 503`)。取不到 → undefined
 * (不猜: 没有状态码就不冷却, 与 callModel 的 401 不熔断同一口径)。测试见 agent-leaf-provider-status.test.ts。
 */
export function providerErrorStatus(msg: string | undefined): number | undefined {
  if (!msg) return undefined;
  const m = /(?:^|[^0-9])([1-5][0-9]{2})(?=\s*:|\s*[{(]|\s*$)/.exec(msg.slice(0, 80));
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 100 && n <= 599 ? n : undefined;
}
import { resolveRoleModelConfigured, type ThinkingLevel } from '../model/role-models';
import { isStrongCoord } from '../model/model-ratings';




/**
 * **本次调用拼在节点 prompt 之前的那一段**(节点无关的脚手架)。抽成纯函数有两个用处:
 * ① runner 拿它拼 prompt;② 观测面拿它的哈希当 `promptVersion`。
 *
 * 为什么 promptVersion 只能是**这一段**:版本要能分组比较,而整条 prompt 里含本节点的 goal
 * 与上游材料,逐节点都不同 —— 哈希整条会得到"每个节点一个版本",等于没有版本。
 *
 * 档位判据原样保留(TR-INV-5 / 强模型档):强模型只吃 house-rules,弱模型吃全量脚手架,
 * 两个开关仍是硬关(纯命令叶可全关)。**拼法保持字节稳定**——改这里 = 全 leaf cache 失效。
 */
/**
 * leaf 模型解析 —— 与 `callModel` 同两级序 (src/model/index.ts:129 同款): **自有 registry 先、
 * pi 目录后**。registry 命中时端点/凭证以 registry 为准 (baseUrl 意图不许被目录覆盖),
 * 目录命中时凭证走既有 `resolvePiApiKey` 链 (apiKey 缺席)。两级皆 miss → undefined。
 *
 * 为什么要有它 (2026-08-26 bench 终局根因): 此前 leaf 只查 pi 目录, models.json /
 * registerProvider 注册的自定 provider (bench 等) 在 leaf 通道恒解析失败 —— 同一坐标
 * callModel 一路通、agent leaf 一路断, 所有写文件节点 infra-error 零产出。
 * 反向自检: 删掉 registry 分支 → agent-leaf-registry-resolve.test.ts 前两条当场红。
 */
export function resolveLeafModel(
  provider: string,
  modelId: string,
): { piModel: PiModel; apiKey?: string } | undefined {
  const cfg = getProvider(provider);
  if (cfg) {
    return { piModel: piModelFromProviderConfig(provider, modelId, cfg), apiKey: cfg.apiKey };
  }
  const catalog = resolvePiModel(provider, modelId);
  return catalog ? { piModel: catalog } : undefined;
}

export function agentScaffold(opts: {
  profile: 'auto' | 'weak' | 'strong' | 'off';
  model: string;
  toolRouting: boolean;
  disciplineCore: boolean;
}): string {
  const { profile, model, toolRouting, disciplineCore } = opts;
  if (profile === 'off') return '';
  const strong =
    profile === 'strong' || (profile === 'auto' && isStrongCoord(model) && (toolRouting || disciplineCore));
  return [
    SHARED_ENGINEERING_CORE,
    disciplineCore ? LEAF_EXECUTION_CORE : '',
    !strong && toolRouting ? LEAF_TOOL_ROUTING : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// 类型单一真理源 = leaf-runners.ts (executor-dag 只认接口形状, 不 import 实现) — 这里 re-export 保旧调用面。
export type { AgentLeafInput, AgentLeafResult, AgentLeafRunner, FileWriteEffect, LeafGatePosture, LeafGateStates, ShellRun, ToolStep } from './leaf-runners';
import type { AgentLeafInput, AgentLeafResult, AgentLeafRunner, FileWriteEffect, LeafGateStates, ShellRun, ToolStep } from './leaf-runners';
import { TOOL_STEPS_CAP, TOOL_STEPS_HEAD, SHELL_OUTPUT_TAIL_CAP } from './leaf-runners';

/**
 * P3 S7 (D-18, 2026-09-02): 一次 agent 调用的 thinking 档, 纯函数。优先序 (显式永远赢):
 *   `explicit` (opts.thinkingLevel, A/B 钉档) > `env` (OMD_AGENT_EFFORT) > `seat` (引擎按座位表逐调用传) > `channelDefault`。
 * 座位表没给档 (`seat` 缺席) 时落回通道缺省 —— **不是** 'high' 兜底: 两个通道的缺省不同 (pi xhigh / SDK medium),
 * 引擎侧不许替 runner 选一个 (D-18「S7 不顺手降 worker 档」)。
 * 证伪方式 (leaf-thinking-seat.test.ts): 把 `seat ??` 那一跳去掉 → 座位档永不生效即红; 把 channelDefault 换成常量 'high' → SDK 那条红。
 */
export function resolveLeafThinking(input: {
  explicit?: ThinkingLevel;
  env?: ThinkingLevel;
  seat?: ThinkingLevel;
  channelDefault: ThinkingLevel;
}): ThinkingLevel {
  return input.explicit ?? input.env ?? input.seat ?? input.channelDefault;
}

export interface AgentLeafRunnerOpts {
  /** 工具写盘的工作根。默认 process.cwd()。每个 agent leaf 应被 scope 到此根下的原子产物。 */
  cwd?: string;
  /** thinking 档位。默认 xhigh (agent leaf 改文件/工具循环, 质量优先; 见下方赋值处注)。 */
  thinkingLevel?: ThinkingLevel;
  /**
   * 工具白名单(CC frontmatter 风格)。**省略 = 全套自有工具(read/write/edit/ls/grep/bash, 能改文件)。**
   * 给则限定(如只读 ['read','grep','bash'] 用于研究型 agent leaf)。
   */
  tools?: string[];
  /**
   * 自定义工具 (与内置工具并存)。如 hashline_read/hashline_edit (行锚定 patch, 治弱模型 edit 腐烂)。
   * 经 createHashlineCustomTools() 造。省略 = 仅内置工具。
   */
  customTools?: AnyOmdTool[];
  /**
   * 注入 tool-routing guideline (TR-INV-5, 弱模型 matching 治理: 查代码/改文件重叠区路由 + 两步法)。
   * 默认 true。纯研究型只读 leaf 或纯命令执行 leaf 可关 (省那几行 token)。
   */
  toolRouting?: boolean;
  /**
   * 注入 leaf 执行核 (`LEAF_EXECUTION_CORE`: 写集边界 / 仓规检查 / 运行期证据 / 测试值导入 /
   * 判据冻结 / 空转 / 手术刀 / think-in-code / 卡住自检)。默认 true。纯命令执行 leaf 可关。
   * ⚠ 共享层 (`SHARED_ENGINEERING_CORE`) **不受此开关控制** —— 承重纪律要全关走 profile 'off'。
   */
  disciplineCore?: boolean;
  /**
   * prompt 档强制覆盖 (eval 用)。缺省 `'auto'` = 按本次 leaf 的模型档自选。
   * **A/B 必须能把档位固定住**, 否则换模型时档位跟着变, 量到的差是"模型 × 档位"的混合效应。
   *   'weak'   = 共享层 + 执行核 + 工具路由
   *   'strong' = 共享层 + 执行核 (强模型自己会选工具, 不发路由表)
   *   'off'    = 一个字节都不发 (裸 prompt 基线)
   */
  promptProfile?: 'auto' | 'weak' | 'strong' | 'off';
  /**
   * 总墙钟**兜底**上限 (ms)。默认 3_600_000 (1h)。0 = 不设。
   *
   * ⚠ 这不是"叶子该跑多久"的策略, 是**跑飞了的最后一道刹车**。「这个叶子还活着吗」由
   * {@link idleTimeoutMs} 回答 —— 那条按**有没有在动**判, 不按跑了多久判。
   *
   * 2026-08-01 从 240s 提到 1h (owner): 4 分钟是一条**伪装成安全网的策略** —— 它真正在执行的是
   * "不许一个叶子干超过 4 分钟的活", 而那不是超时该表达的东西。生产 MCP 路径本来就传 1h
   * (`assemble.ts` 的 `OMD_LEAF_TIMEOUT_MS ?? 3_600_000`), 只有 TUI / sec-audit / review 这几个
   * 不传的调用点在吃 240s —— 同一个叶子在两条路上两个寿命, 也是一种"配了不生效"。
   *
   * 实现仍是两级: `shouldStopAfterTurn` 轮间优雅停 (产物完整保留) + `AbortSignal` 单轮硬兜底。
   */
  leafTimeoutMs?: number;
  /**
   * **进展看门狗** (ms): 连续这么久**一个循环事件都没有**、且**没有工具在跑** → 判 provider 挂起,
   * abort 并标 `stalled`。默认 180_000 (3min)。0 = 关。
   *
   * ## 为什么换掉原来那条 (2026-08-01)
   *
   * 老判据是「启动后 45s 内**累积文本**不足 32 字节 → 判死」。两个毛病, 第二个是致命的:
   *   ① 只在**启动那一次**看一眼 —— 中途才挂起的 provider 它抓不到;
   *   ② **只数 `text_delta`**。模型在推理时发的是 `thinking_delta`, 对这条判据完全隐形。
   *      worker 档提到 xhigh (deepseek 上 = `reasoning_effort: max`) 之后, 一个正常思考 50 秒的
   *      叶子会被当成挂死杀掉 —— 判据把"在想"读成了"没反应"。
   *
   * 新判据只问一件事: **它还在动吗**。任何循环事件都算动 (文本增量 / **推理增量** / 工具开始或结束 /
   * 轮边界), 来一个就重置窗口。**工具在飞时不计时** —— 一条跑 10 分钟的 `bun test` 期间本来就没有
   * 事件, 那是正当工作不是挂起。
   *
   * 于是「没跑起来」与「跑得久」第一次分得开: 前者是**零事件**, 后者是**事件一直来**。
   * 真死的 provider 仍在 3 分钟内被抓到, 真在干活的叶子想跑多久跑多久。
   */
  idleTimeoutMs?: number;
  /**
   * 角色 persona 前缀 (P1 三层角色): **设计型/推理型** leaf 传 TASTE_CORE 或
   * composeTastePersona(role) 拔高品味判断; 纯执行型 leaf 省略 = 最小思考忠实执行。
   * 字节稳定 (prepend, cache 友好)。
   */
  persona?: string;

  /**
   * 已解析的岗位档案 (LeafProfile)。设则通过现有扩展点自动应用:
   * persona 前置 (与 opts.persona 合并)、skills 注入 skill-tool roots、
   * tools 做 allowlist、seat 当节点无显式模型时的回退。
   * profile 内容不进 promptVersion (与 opts.persona 同一条边界)。
   */
  profile?: LeafProfile;
  /**
   * 开 hashline 编辑模式 (治弱模型改文件错位/腐烂): 自动注入 hashline_read/hashline_edit
   * (scope 到 cwd) **并排除内置 `edit`** —— 强制走行锚定 patch。read/write/bash 保留 (新建文件仍用 write)。
   * 与显式 `customTools` 合并。默认 false (现存审计型 leaf 不需, 不平白加 token)。
   * 编辑型 leaf (DeepSeek/MiMo 改代码) 应开。
   */
  hashlineEdit?: boolean;
  /**
   * 拿极简工具面的座位名单(按 `modelId` 匹配)。省略 = `DEFAULT_MINIMAL_TOOLFACE_SEATS`。
   * 传 `[]` = 谁都不极简。**测试接缝**:闸要在真装配路上观察工具面缩没缩,而生产名单里那个
   * 座位走 pi 通道(测试里看不见 `allowedTools`),所以名单必须可注入。
   */
  minimalToolFaceSeats?: readonly string[];
  /**
   * **精益 worker leaf**(P3 S4 / D-10, owner 2026-09-02 裁): 工具面永久 = read/write/edit/bash(+ 有冻结判据时
   * 的 run_acceptance), system prompt 走 `leaf-prompt-v2`(冻结前缀 + RUN FACTS 后缀)。作用域 = 无 `input.profile`
   * ∧ 无 `opts.tools` ∧ `input.mcpAllow` 为空;mcp 授权非空时退回全面(mcp 工具必须仍在面上, INV-4)。
   * 不挂首轮后放开(与座位极简机制不是一回事, 那套原样保留)。缺省 **关**: 生产 DAG 装配点开(assemble.ts),
   * 对话位 / 零配置叶子逐字节不变(agent-tools.test.ts I-1 基线)。
   */
  leanLeaf?: boolean;
  /**
   * advisor 坐标(resolveSeatAdvisor('agent') 的产物,省略 = 无)。按座位通道分派:
   * claude-code 座 → 官方 server tool(settings.advisorModel,配对由 CLI/API 校验);
   * pi 座 → 内部升档 tool(advisor-tool.ts,本次运行注入工具面)。NOTES 2026-08-10。
   */
  advisor?: string;
  /**
   * 测试接缝:claude-code 订阅通道的 SDK query 替身(真 SDK 要真订阅 + claude CLI)。生产不传。
   */
  sdkQueryFn?: import('./claude-sdk-loop').SdkQueryFn;
  /**
   * 测试接缝:pi 通道循环替身(真循环要真模型)。生产不传。沿用 chat/agent.ts 的 loopFn 模式,
   * 让 agent-leaf-tui-usage.test.ts 不发真模型请求就能验证 D5 切片 2 的 emit 闸。
   */
  loopFn?: typeof runAgentLoop;
  /**
   * 碰撞台账写入面 (SDD S3, 只记不拦)。给了才记; **缺省零行为变化**。
   * `session` 是 runner 级兜底; 引擎侧 runId 只在调用期可知 (runner 跨 run 复用) →
   * 运行时以 `AgentLeafInput.touchSession` 覆盖 (经 AsyncLocalStorage 按调用落, 见装配处注)。
   * 隔离档 (bwrap) 下 worker 进程同样收到 (leaf-worker 桥接)。
   */
  touch?: { session: string };
  /**
   * 外部 MCP 工具授权兜底 (SDD D-7): runner 级缺省 allow 清单; 运行时以
   * `AgentLeafInput.mcpAllow` 覆盖 (经 AsyncLocalStorage 按调用落, 同 touchSession)。
   * 省略 = deny 全部副作用类 MCP 工具 (leaf 不声明不授权)。
   */
  mcpAllow?: string[];
  /**
   * **runner 级**写域缺省 (节点没给时用它)。缺省 undefined = 闸缺席。
   * 逐调用的那份走 `AgentLeafInput.writeAllow` —— 同 mcpAllow 的两层。
   */
  writeAllow?: string[];
  /**
   * 测试注入 (同 sdkQueryFn 纪律): 外部 MCP pool 的 transport / 台账 —— 进程内测试换
   * InMemory linked pair + ':memory:' ledger; 生产省略 (stdio 子进程 + cwd 懒落库)。
   */
  mcpDeps?: { poolDeps?: McpPoolDeps; ledger?: McpCallLedger };
  /**
   * 测试注入 (同 mcpDeps 纪律): read_skill 工具的依赖注入通道 —— 进程内测试换空 roots
   * (零 skill 仓基线逐字节对比) 或 tmp 根; 生产省略 (defaultSkillRoots(cwd) 自动扫三源)。
   * D-S3-5: roots 显式注入且包含该 cwd 的项目根 <cwd>/.omd/skills。
   */
  skillDeps?: SkillToolDeps;
  /**
   * S3 grind 软看门狗依赖注入 (测试缝, 同 sdkQueryFn 纪律): 注入时钟与 advisor 替身,
   * 全程不发真实模型请求。生产省略 → now = Date.now, askAdvisor = 解析 config 的
   * escalation 座位经 callModel 发一次指导 (一句话诊断 + 下一步)。
   */
  deps?: { now?: () => number; askAdvisor?: (ctx: GrindAdvisorContext) => Promise<string> };
  /**
   * S3 硬截停配置位 (预留): 默认 **false** —— 默认路径软介入照发、零中止。
   * 硬截停行为本步不接 (只留位), 后续硬截停步 (双条件持续到硬阈值才截停 + blame 记账) 接这个位。
   */
  grindAdvisorHardStop?: boolean;
  /**
   * **节点级 self_check 自修环上限** (P1 C-3 INV-3-1, 2026-08-21)。默认 **2**——
   * 自修 0 轮就是「判据一次就绿」(节点正常结束), 2 轮 = 「首轮判红 + 一次自修」是常规态,
   * 留余量给偶发 (不靠无限轮换取收敛)。被闸拒 (`vetSelfCheck` 恒真 = 退回旁路) 与缺席
   * (INV-1-2) 的节点**与本旋钮无关**, 永远不进自修环。
   *
   * **0 也合法** = 判据**仍跑一次**(用于判定 done/failed), 但**绝不注入任何 follow-up**;
   * 与默认路径行为差仅在「节点级判据是否被听见」(INV-3-1)。开关 env `OMD_SELF_CHECK=0`
   * 与本旋钮**并列**生效 (INV-3-3) —— 任一关掉都退回旁路。
   */
  maxSelfRepair?: number;
  /**
   * drift 检测 (代码级 spinning 防护): agent-leaf 是 headless 工具循环 = spin 高发面,
   * 默认开 (low-invasive: 仅同调用同参重复 ≥阈值才经 transformContext 注 stuck-checklist)。
   * false 关; 对象调阈值。
   */
  driftDetector?: DriftDetectorConfig | false;
  /**
   * S1 spin-route 档 1 (2026-08-25 空转路由, 片 2 接线): 命中空转口径时注入一次**证据包**。
   * 沿用现尺不新造 — 触发 = drift 的 `onSpinning` 边沿事件 (现 drift 检测在用同一把尺)。
   *
   * - `false` ⇒ 关掉整条路由 (与 `OMD_SPIN_ROUTE=0` 任一关都旁路, INV-3-3 同款);
   * - 缺省 (undefined) ⇒ 走 env `OMD_SPIN_ROUTE=0` 的默认值 (= 开)。
   *
   * **仅 pi 通道注入**: SDK 通道没有 `transformContext` 钩子, 命中时打 `SPIN_ROUTE_SDK_SKIP_LOG`
   * 一次 + 记账 `sdk-bypass` (I-6, 与 self_check 在 SDK 的纪律同款)。
   *
   * **每叶至多 1 次** (D-1): 二次命中在 S1 里记 `exhausted-s1`, 不重派 (档 2 是 S2 的活)。
   */
  spinRoute?: false | {
    enabled?: boolean;
    /**
     * 测试观察面 —— 生产 opts.spinRoute 缺省无该字段, 走 drift 的 onSpinning 真边沿。
     * 同步触发后**仍**走 handleSpinRouteTrigger 真逻辑(同 observer 而非 override);
     * 用途: 测试在不调 drift.note() 的前提下, 捕获 spin-route 触发瞬间。
     */
    trigger?: (info: { sig: string; sameCount: number }) => void;
  };
  /**
   * 上下文预算线 (GP-8): 估算上下文占到模型窗口的这个比例时触发**压缩**。默认 0.85。
   * 压缩不成才优雅停。设 1 以上 = 既不压也不停 (不建议 —— 撞窗口是整轮硬失败)。
   */
  contextBudgetRatio?: number;
  /**
   * 上下文压缩 (auto-compaction)。默认 **开**。
   *
   * 老的 `createAgentSession` 自带这个能力 (pi `compaction.enabled ?? true`), 搬到低层循环时
   * 一度只留了"到线就优雅停" —— 那保住了产物却**没保住活**: 叶子会在没干完的时候交卷,
   * 而且不报错、下游看不出来。这正是 §8.5「静默失败」那一族的形状, 所以补回来。
   *
   * 与 pi 的两处**刻意不同**:
   *   ① 摘要走本仓 `callModel` 而不是 pi 的 `models.completeSimple` —— 压缩也是一次真调用,
   *      得上成本账本、吃熔断与重试预算。走 pi 那条会让它在账上**完全隐形**。
   *   ② **第一条消息逐字保留**。对一个 DAG 叶子来说那不是"对话开头", 是**契约**;
   *      把它摘要掉等于让叶子忘了自己被要求做什么。pi 不知道这件事, 我们知道。
   *
   * false = 关 (回到"到线就停")。
   */
  compaction?: boolean;
  /** 压缩后保留的近期上下文 token 预算。默认 20000 (同 pi `keepRecentTokens`)。 */
  compactionKeepRecentTokens?: number;
  /**
   * 写沙箱根 (2026-07-23): 设则挂 sandbox-guard hook —— 任何结构化写 (write/edit/hashline_edit) 解析到
   * 此根子树外 **事前 block** (治 leaf 用绝对路径写穿隔离; eval worktree 必设 = fx.root)。省略 = 不沙箱
   * (真 DAG 跑默认信任 cwd; 需要硬隔离的场景显式设)。不拦 bash 写逃逸 (需容器级)。
   */
  sandboxRoot?: string;
  /**
   * bwrap 隔离档下**把 git 元数据挂进 jail** (2026-08-11, run 7d50fda2 修)。默认 false。
   *
   * `git worktree add` 出来的树里 `.git` 是指向主 repo 的**指针文件**, jail 里那个路径不存在 →
   * 隔离叶里 git 全灭 (实测叶子反复试探 git 后放弃, 12 轮空转)。设 true 则 ro-bind 共享
   * `.git` + rw-bind 本树自己的 gitdir: log/show/diff/blame/status 可跑, 写主 repo 的 refs 与
   * objects 仍被文件系统拒 (实测: tag/commit 均 `Read-only file system`)。
   *
   * **eval 档必须留 false**: 那里的隔离正是为了挡 `git show <commit>:file` 当 oracle 作弊
   * (见 bwrap.ts 头注)。生产隔离档没有 oracle 可作弊, 而叶子确实需要 git —— 两档要求相反,
   * 所以是显式开关, 不按"是不是 worktree"自动猜。
   */
  sandboxGit?: boolean;
  /**
   * **leaf 级仓规检查清单** (D2 切片 2, #266 修补节点): 模型返回成功后, 对该 leaf
   * 的写集跑清单里每条 check (jargon-scan / catch-evidence-net-add 等)。
   *
   * 引擎侧**只认这个形状**, 一个仓库规则都不硬编码 (INV-D2-1); 实际清单由装配层
   * (`src/mcp/assemble.ts`) 注入。省略 / 空数组 = 与今天行为逐字节相同 (零回归)。
   *
   * 失败处理: FAIL → 抛带 evidence 的 Error (engine L0 重试接住, 进 causeNote);
   * UNVERIFIED → log warn + 继续 (INV-D2-4 fail-open, 不让 oracle 自己崩了挡主流程)。
   *
   * 接线点: 见 `runOnce` 末段, 在 stalled/timedOut/spinFused 警告之后、return 之前 ——
   * 那些路径已经是 leaf 自身失败 (非「leaf 干完但仓规红」), 不再跑检查。
   */
  repoChecks?: RepoCheck[];
  /**
   * 检查命令的子进程跑法 (同 `GateSpawn`)。**测试注入** —— 生产默认走
   * `defaultRepoChecksSpawn` (Bun.spawn + 超时闸), 仓库侧无需自配。空 `repoChecks`
   * 时**不会**被调用 (INV-D2-4: 无清单 = 不拦主流程)。
   */
  repoChecksSpawn?: GateSpawn;
  /**
   * 单条仓规 check 的超时 ms。默认 30_000 (同 `post-leaf-gate.ts` 的 DEFAULT_TIMEOUT_MS)。
   * 0 = 不超时 (不建议 —— 一个挂死的 oracle 会让 leaf 整条线跟着卡)。
   */
  repoChecksTimeoutMs?: number;
  /**
   * debug 事件汇 (2026-07-23): 设则把循环**全部**事件转发给它 (tool_call 参数 / 工具结果 / 消息),
   * 用于捕获 leaf transcript 挖 empty-done 根因。省略 = 不转发 (零开销)。仅排障用, 非生产热路径。
   */
  onEvent?: (event: { type: string; [k: string]: unknown }) => void;
}

/**
 * S3 grind 软看门狗 (#124, 2026-08-17)。双条件闸: 墙钟 > T **且** 停滞窗口 W 内 touched
 * 零新增才算研磨 —— 纯墙钟单条件会一刀切掉跑得久但仍高产的叶子 (历史回测误杀 25:1),
 * 所以它被禁写进判据。CPU 占用 / 产物数量 / 文本字节同样禁入 (都不是「还活着」信号)。
 */
export const GRIND_WALL_MS = 600_000;
export const GRIND_STALL_MS = 300_000;
/**
 * grind 二档阶梯 (2026-08-17, #146): advisor 触发后再停滞这些毫秒 → 注入强制收尾指令;
 * 同条纪律 —— 只问「还活着吗」, CPU / 字节数依然禁入。
 */
export const GRIND_WRAPUP_MS = 300_000;
export const GRIND_ABORT_MS = 600_000;
/**
 * D2 切片 2 (#266): 仓规检查子进程的默认跑法 — `bun -e '<cmd>'` + 超时闸。
 *
 * 与 `post-leaf-gate.ts` 的 GateSpawn 形态一致 (返 stdout/stderr/exitCode/timedOut);
 * 这里走 Bun.spawn 真起进程, 因为仓规命令形如 `bun run scripts/jargon-scan.ts --files ...`
 * —— 需要 shell 解析 + 进程隔离 + 真退出码。
 *
 * 仓库侧无需自配; 测试用例注入 `repoChecksSpawn` 替身 (见 repo-checks.test.ts)。
 * 空 `repoChecks` 时**不**被调用 (INV-D2-4: 无清单 = 不拦主流程)。
 */
export const REPO_CHECKS_DEFAULT_TIMEOUT_MS = 30_000;
export const defaultRepoChecksSpawn: GateSpawn = (cmd, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const effectiveTimeoutMs = timeoutMs ?? REPO_CHECKS_DEFAULT_TIMEOUT_MS;
    const child = Bun.spawn(['sh', '-c', cmd], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch (e) {
        logger.warn({ cmd, err: String(e) }, '[agent-leaf] repo-check 超时 kill 失败 (进程可能已退出)');
      }
    }, effectiveTimeoutMs);
    void Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
      async ([stdout, stderr]) => {
        const exitCode = await child.exited;
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: timedOut ? null : exitCode,
          timedOut,
        });
      },
      (err) => {
        clearTimeout(timer);
        resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false });
        void err;
      },
    );
  });

/** shouldFireGrindAdvisor / nextGrindAction 的输入快照 (纯数据; 同形于 runOnce 里同作用域的状态)。 */
export interface GrindAdvisorSnapshot {
  startedAtMs: number;
  nowMs: number;
  lastTouchGrowthAtMs: number;
  advisorFiredAt: number | null;
  /**
   * wrap-up 触发时刻 (距 startedAtMs 的相对毫秒数, 与 advisorFiredAt 同口径)。
   * 缺席 = 老调用方/老谓词, nextGrindAction 仍按未触发处理。INV-5: null = 未触发。
   */
  wrapupFiredAt?: number | null;
}

/** askAdvisor 收到的一次性诊断上下文 (测试钉的就是这个形状)。 */
export interface GrindAdvisorContext {
  startedAtMs: number;
  nowMs: number;
  lastTouchGrowthAtMs: number;
  cwd: string;
  goal: string;
}

/**
 * 纯谓词: 双条件齐备才 true (wall>W **且** stall>=T, 缺一不触发);
 * advisorFiredAt 非空短路 = 每叶至多 1 次。
 */
export function shouldFireGrindAdvisor(s: GrindAdvisorSnapshot): boolean {
  if (s.advisorFiredAt !== null) return false;
  return s.nowMs - s.startedAtMs > GRIND_WALL_MS && s.nowMs - s.lastTouchGrowthAtMs >= GRIND_STALL_MS;
}

/**
 * grind 三档阶梯纯谓词 (2026-08-17, #146): advisor → wrapup → abort, 严格次序, 各至多一次。
 * stall 仍读 lastTouchGrowthAtMs —— 模型收到建议/收尾指令后真动了 (touched 有新增), 钟随
 * touch 重置, 高档不再触发 (INV-2)。返回值 = 当前该走的下一步; null = 不动。
 */
export function nextGrindAction(s: GrindAdvisorSnapshot): 'advisor' | 'wrapup' | 'abort' | null {
  const wall = s.nowMs - s.startedAtMs;
  const stall = s.nowMs - s.lastTouchGrowthAtMs;
  // 一档 advisor: 双条件齐备 + 尚未触发
  if (s.advisorFiredAt === null) {
    if (wall > GRIND_WALL_MS && stall >= GRIND_STALL_MS) return 'advisor';
    return null;
  }
  // 二档 wrapup: advisor 已触发 + 距 advisor 触发 ≥ GRIND_WRAPUP_MS + 仍停滞
  const sinceAdvisor = s.nowMs - s.advisorFiredAt;
  if (s.wrapupFiredAt === null || s.wrapupFiredAt === undefined) {
    if (sinceAdvisor >= GRIND_WRAPUP_MS && stall >= GRIND_STALL_MS) return 'wrapup';
    return null;
  }
  // 三档 abort: wrapup 已触发 + 距 wrapup 触发 ≥ GRIND_ABORT_MS + 仍停滞
  const sinceWrapup = s.nowMs - s.wrapupFiredAt;
  if (sinceWrapup >= GRIND_ABORT_MS && stall >= GRIND_STALL_MS) return 'abort';
  return null;
}

/**
 * #178 produce-by 软推 (2026-08-19): 与 grind 三档**正交**的触发轴 —— grind 读 stall (touched
 * 停止增长), 抓的是"卡住"; 这条读"从未写过" (filesTouchedCount === 0), 抓的是**勘探耗尽空手终止**
 * (账本实测 16/66: 只读工具连发几分钟、零写、output 空、静默收场 —— 忙着读, grind 的 idle 轴恒不触发)。
 * 墙钟阈值取 180s: 16 例死亡区间 25-280s 的上沿之下、留出注入后收尾余量 (30min 硬顶的 1/10)。
 */
export const PRODUCE_BY_WALL_MS = 180_000;

/** produce-by 注入指令 (pi 通道经 pendingGrindAdvice 缓冲下发; SDK 通道同 grind 边界只记不注)。 */
export const produceByInstruction = (path: string): string =>
  `[produce-by] 你已勘探较久但**还没有写任何文件**。停止继续勘探 —— 以现有理解**现在就写**产物到 ${path}。` +
  `先写第一版到磁盘, 再用剩余预算补勘探/修正。零产物结束 = 本节点作废 (empty-artifact), 勘探成果全部白费。`;

/**
 * produce-by 纯谓词 (可测缝, 同 nextGrindAction 纪律)。触发条件四与: 产物叶 ∧ 尚未触发过 ∧
 * 一个文件都没写过 ∧ 墙钟超阈值。非产物叶 (expectsArtifact=false) 恒 false —— #178 硬约束
 * "非 produces-files 节点零行为变化" 的判据落点。
 */
export function shouldFireProduceBy(s: {
  expectsArtifact: boolean;
  nowMs: number;
  startedAtMs: number;
  filesTouchedCount: number;
  produceByFiredAt: number | null;
}): boolean {
  if (!s.expectsArtifact || s.produceByFiredAt !== null) return false;
  return s.filesTouchedCount === 0 && s.nowMs - s.startedAtMs > PRODUCE_BY_WALL_MS;
}

// ── W4 勘察步预算 (2026-09-06, 契约 `docs/plan/2026-09-06-墙钟与读次数-执行契约.md`) ─────
//
// 与 produce-by 正交的**第三根轴**: produce-by 数墙钟 (勘探久了还没写), 这条数**步**
// (读了 N 步还没派活), 且只对**持卡的节点** (conductor) 生效。
//
// 为什么要它: code80-boundary 80 题实测 conductor 均 24.8 个工具步, 66% 是 bash、bash 里
// 61% 是只读勘察, 真正派活的只有 1 到 3 步。引擎已经把仓内事实机械算好塞进它的面 (W1 勘察包),
// 但拦不住它再读一遍。
//
// **这是边界不是做法**: 只注一次、**不拒任何调用** —— 读什么、怎么读、要不要接着读, 仍然全由
// 模型定 (§引擎理念 ②)。它只是把「勘察包已经给过你」这件事在它读到第 N 步时说一次。

/** 连续只读步数到这个数就提醒一次。`OMD_SURVEY_STEPS` 可改 (见 {@link surveyBudgetSteps})。 */
export const SURVEY_STEPS_BEFORE_DISPATCH = 10;

/**
 * 算进"只读勘察步"的工具名 —— conductor 那副只读手 (D-20: read / ls / grep / bash) 加单文件读。
 * 不在这张表里的一步 (七张派工卡 / write / edit) 把连读计数**清零**: 判据是「**连续**读了 N 步」。
 */
export const SURVEY_READONLY_TOOLS: ReadonlySet<string> = new Set(['read', 'ls', 'grep', 'bash', 'hashline_read']);

/** 阈值解析: 正整数才认, 其余 (含 0 / 负数 / 非数字 / 缺席) 一律默认 —— 关掉要显式改代码, 不靠一个歧义值。 */
export function surveyBudgetSteps(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OMD_SURVEY_STEPS);
  return Number.isInteger(raw) && raw > 0 ? raw : SURVEY_STEPS_BEFORE_DISPATCH;
}

/** 提醒文案 (pi 通道经 pendingGrindAdvice 缓冲下发; SDK 通道同 grind 边界只记不注)。 */
export const surveyBudgetInstruction = (steps: number): string =>
  `[survey-budget] 勘察包已给你, 你又读了 ${steps} 步还没派活。现在派 work(), ` +
  `或用一句话写明还缺哪一条事实再读。`;

/**
 * 勘察步预算纯谓词 (可测缝, 同 shouldFireProduceBy 纪律)。五条件与: 持卡节点 ∧ 连读 ≥ 阈值 ∧
 * 一次都没派活 ∧ 一个文件都没写过 ∧ 尚未提醒过。不持卡 (work 子节点) 恒 false —— 它该读多久读多久。
 *
 * 阈值走第二参而不是读全局: 谓词保持纯的, 环境变量由调用方解析一次 ({@link surveyBudgetSteps})。
 */
export function surveyBudgetHit(
  s: { hasCards: boolean; readonlySteps: number; dispatches: number; filesTouchedCount: number; fired: boolean },
  steps: number = surveyBudgetSteps(),
): boolean {
  if (!s.hasCards || s.fired) return false;
  return s.readonlySteps >= steps && s.dispatches === 0 && s.filesTouchedCount === 0;
}

/**
 * grind advisor 的唯一 system prompt —— 与 advisor-tool 的 ADVISOR_SYSTEM_PROMPT 分家:
 * 那条吃 transcript, 这条只吃状态摘要 (grind 判据本身已是确定性结论, advisor 只需诊断 + 下一步)。
 */
const GRIND_ADVISOR_SYSTEM_PROMPT =
  'You are the escalation advisor for a worker agent that appears to be grinding: long wall ' +
  'time while no new files have been touched for a while. You receive a short status summary, ' +
  'not a transcript. Reply with exactly two lines. Line 1: one-line diagnosis of the most likely ' +
  'reason the worker is stuck. Line 2: the single best next action for the worker to take. ' +
  'No preamble, no hedging, no other text.';

// ── P1 self_check 自修环 (C-2/C-3, 2026-08-21) ──────────────────────────────────────
//
// pi 的 `getFollowUpMessages` 钩子是**交互式 steering 通道** (D-6, 借用的诚实边界 ——
// 设计为人中途插话, headless 当自动喂料通道没验过)。本切片用它当节点级判据的反馈环:
// 内环将停 → 跑 self_check.command → 退出码 === expect_exit 收敛; 不等 → 造一条 follow-up
// 让同一节点再转一轮。**只在 pi 通道** (SDK 通道没有这个钩子, 不许静默降级, INV-2-1)。
//
// 闸接 command-leaf 的 `commandBlockReason` (fail-closed: 危险命令 / 元字符 / 凭证路径 /
// git 写子命令 全拒) — 与 command 节点同一道闸, 不新造第二道 (INV-2-2)。
//
// 有界 (C-3): `maxSelfRepair` 默认 2; 第 n+1 轮开轮的必要条件是第 n 轮 touched **有新增**
// (复用 grind 已有口径 `lastTouchGrowthAtMs` 同款, 不新造第二把尺子 —— 仓内回测明写纯墙钟
// / CPU / 字节数当空转判据**误杀 25:1**)。
//
// 关闭方式: env `OMD_SELF_CHECK=0` 或 opts.maxSelfRepair = 0 —— 任一关掉退回旁路
// (INV-3-3, 实验的对照臂, 不是可选)。

/** self_check 的输出截断上限 (字节)。同 command-leaf 的 `MIN_TOOL_RESULT_BYTES` 上界。 */
export const SELF_CHECK_OUTPUT_MAX_BYTES = 8_000;

/** self_check 在 SDK 通道 + self_check 在场时打一次的告警文案 (INV-2-1 必须有日志)。 */
export const SELF_CHECK_SDK_SKIP_LOG =
  '[agent-leaf] self_check 在 SDK 通道不启用 (INV-2-1: claude-sdk-loop 无 getFollowUpMessages 钩子) —— ' +
  '本节点按旁路走, 判据**不被听见**。重写为 command 节点或换 pi 通道方可自修。';

/** D2 (attach_media agent 注入, SDK 腿响亮旁路): 图片数 + 节点 id 一次性打在日志里,
 *  与 SELF_CHECK_SDK_SKIP_LOG 同形 —— 旁路但响亮, 让 SDK 通道 + 有图这条形态在读数上分得开。 */
export const AGENT_MEDIA_SDK_BYPASS_LOG =
  '[agent-leaf] attach_media 在 SDK 通道走旁路 (claude-sdk-loop prompt:string 不吃 image) —— ' +
  'agent 仍可经 view_image 工具读像素, 路径清单附 prompt 文本末尾';

/** D2: attach_media 的 ContentPart(image_url.data URI) → pi-agent-core ImageContent。
 *  只接 `data:<mime>;base64,<...>` 这一形 —— `collectDepMedia` 本地文件就编成这样;
 *  http(s) URL 在 pi 这层需要先 fetch → 不在本层职责内, 落到 input.promptImages 里的 http URL
 *  解析不动, 一律当缺图 (返回空, 上一节 attach_media fail-closed 那条会接住)。
 *
 *  返回 `{ parts, refs }`: parts 给循环拼首条 user 消息用; refs 是原始引用清单, 给 SDK 腿
 *  旁路日志 + prompt 文本附路径清单用。文本 part 不进 parts (拼首条消息时由调用方自己接 text)。 */
export function splitContentPartsForPi(
  parts: ContentPart[] | undefined,
): { parts: Array<{ type: 'image'; data: string; mimeType: string }>; refs: string[] } {
  const out: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  const refs: string[] = [];
  if (!parts) return { parts: out, refs };
  for (const p of parts) {
    if (p.type !== 'image_url') continue;
    const url = p.image_url.url;
    const m = /^data:([^;,]+);base64,(.+)$/.exec(url);
    if (!m) {
      // http(s) URL 在 pi 层解不了 (这层没有 fetcher) → refs 仍记, parts 不收。
      // SDK 腿旁路日志 + prompt 附路径清单会带它, agent 经 view_image 真读盘/真看图。
      refs.push(url);
      continue;
    }
    out.push({ type: 'image', mimeType: m[1]!, data: m[2]! });
    refs.push(url);
  }
  return { parts: out, refs };
}

/** env `OMD_SELF_CHECK=0` ⇒ 整条自修环关掉 (INV-3-3 开关)。其他值(含未设)= 默认开。 */
export function selfCheckEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMD_SELF_CHECK !== '0';
}

/**
 * self_check 自修环的可观察状态 (C-4 落账)。在 result 上**有 self_check 时恒写**,
 * `null` = 该节点无 self_check (不是「判据一次就绿」)。
 *
 * ⚠ **2026-09-02 修正 —— 只改注释, 实装一个字没动**: INV-4-2 此前写「长度 = rounds + 1」、
 * INV-4-3 此前写「⟺」, 两条都比实装严, 且两条都有生产可达的反例 (下面各自的注释里给了实测)。
 * 实装是对的, 错的是注释。修正的由来值得记一笔: **「只有注释在守」的坏处不止是没人守,
 * 还包括注释本身没人对过账** —— 这两条在三个文件里措辞一致地错了一年多, 因为没有任何东西
 * 会因为它们错而红。本文件是这三处的**真源**, 另两处 (`dag/types.ts` · `dag/dag-record.ts`)
 * 指回这里。
 */
export interface SelfRepairLedger {
  /** 实际自修轮数 (0 = 判据一次就绿, 没注 follow-up)。INV-4-1: 与 null 严格分开。 */
  rounds: number;
  /**
   * 每一轮 self_check 的实际退出码, 按序。
   *
   * **INV-4-2**: `oracleExit.length ∈ {rounds, rounds + 1}`。这个差值不是噪声, 是**判别位** ——
   * 它回答「环停下来的时候, 收尾那一次 probe 到底跑没跑」:
   *   - **差 1** = 跑了。环是被 probe 的**结果**停下的 (收敛 / 闸拒), 由 `convergedAt` 再二分;
   *   - **差 0** = **没跑**。环在 probe **之前**就返了: 轮数上限 (`rounds >= maxSelfRepair`)、
   *     零进展 (工作区一个字节没变 —— 那条判据刻意放在 probe 前, 为的就是连子进程都不 spawn)、
   *     或路径根本没启用 (`{rounds: 0, oracleExit: []}`)。
   *     ⚠ 这一格的语义是「**那一次 probe 不存在**」, 不是「跑了没记上」—— 静默坑 1
   *     (`NULL` ≠ 0 ≠ 不适用) 说的正是别把这两件事抹平。
   *
   * 实测指纹 (2026-09-02, 逐条走过四条终止路径 + 未启用):
   *   收敛 diff=1 · 闸拒 diff=1 · 轮数上限 diff=0 · 零进展 diff=0 · 未启用 diff=0。
   */
  oracleExit: number[];
  /**
   * 第几轮转绿 (0 = 首轮就绿); 始终没绿 = null。
   *
   * **INV-4-3 是单向蕴含, 不是充要**: `convergedAt !== null` ⟹ `oracleExit` 末项 `=== expect_exit`。
   * **反向不成立**, 而且反例是生产可达的: 配了 `expect_output` 时, 退出码对上但输出串没匹配上,
   * 实装**本来就不该**算收敛 (`outputOk` 为假) —— 于是末项 `=== expect_exit` 而 `convergedAt` 仍是 `null`。
   * 实测反例 (2026-09-02): `expect_exit: 0` + `expect_output: 'NEVER'`, probe 返 exitCode 0 / stdout `'ok'`
   * → `convergedAt = null`, 末项 `= 0`。
   *
   * 在 INV-4-2 「差 1」那一格里, 本字段兼作二分: 非 `null` = 收敛收的尾;
   * `null` = **闸拒**收的尾 (命令被 `commandBlockReason` 拒, 末项折成 `-1`)。
   * ⚠ 所以「`convergedAt === null`」**单独**分不出「差 0」和「差 1」—— 闸拒两样都占。要判
   * 收尾 probe 跑没跑, 看的是长度差, 不是这一位。
   */
  convergedAt: number | null;
  /**
   * S1 spin-route 档 1 路由入账 (D-5 additive, INV-6): 路径启用但未触发 = 空数组; 缺席 = 路径未启用
   * (opts.spinRoute === false 或 env 关)。既有消费者读 `rounds/oracleExit/convergedAt` 不受影响。
   */
  spinRoute?: { rung: 1; packHash: string; outcome: SpinRouteEventOutcome; at: number }[];
  /**
   * S3 自修环 follow-up 哈希入账 (D-6 additive, INV-7): 缺席 = 该节点无 self_check; 空数组 = 启用但零轮;
   * 有值 = 每轮一条。I-2 「第 n+1 轮必须含第 n 轮没有的信息」由此变成可机械判 —— 两轮哈希相等即违约。
   * 复用 `agent-tools.sha256Hex`, 不新造第二个。
   */
  followUpHashes?: string[];
}

/**
 * 单次 self_check 探测的产出 (buildSelfCheckFollowUp 内部状态机用)。
 *
 * - `blocked` = 命令被 `commandBlockReason` 闸拒 (危险命令 / 元字符 / 凭证路径 / git 写子命令);
 *   exitCode 是 -1, **不注入 follow-up** (再跑也是同样结果, 不属于「还可以转一轮」)。
 * - `exited`  = 命令真跑了 (或超时被杀), exitCode 是真值; 与 expect_exit 不等时构造 follow-up。
 */
export type SelfCheckOutcome =
  | { kind: 'blocked'; reason: string }
  | { kind: 'exited'; exitCode: number | null; stdout: string; stderr: string };

/**
 * 跑一次 self_check 命令 (闸拒与超时由调用面决定如何落账)。本函数**只负责**:
 *   ① 经 `commandBlockReason` 过安全闸;
 *   ② 通过则 spawn 一次并取 stdout/stderr + 退出码;
 *   ③ **不**做截断 (留给调用方按 pi 的 `truncateTail` 口径走);
 *   ④ **不**写入 selfRepair 账本 (调用方决定)。
 *
 * `allowlist` 由调用方提供 —— 测试可注入, 生产经 agent-leaf-runner 闭包从同源 config 取
 * (与 `commandRunner` 共享白名单, INV-2-2)。
 */
export async function runSelfCheckProbe(opts: {
  command: string;
  cwd: string;
  allowlist: readonly string[];
  timeoutMs?: number;
  spawn?: (c: string, d: string, t?: number) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    timedOut?: boolean;
  }>;
}): Promise<SelfCheckOutcome> {
  const { commandBlockReason } = await import('./command-leaf');
  const blocked = commandBlockReason(opts.command, opts.allowlist);
  if (blocked) return { kind: 'blocked', reason: blocked };
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const spawn = opts.spawn ?? ((c: string, d: string, t?: number) => defaultSpawn(c, d, opts.allowlist, t));
  const { stdout, stderr, exitCode, signal } = await spawn(opts.command, opts.cwd, timeoutMs);
  // 信号死 (signal !== null) 一律折成 exitCode = null —— 与 commandRunner 同款口径 (H5-1
  // 「三字段互不推断」)。命令超时被杀 = 已 timedOut, exitCode 可能是 124 (bash 内建) 也可能
  // 是 null (signal); 不论哪种, 都是「没拿到主动退出码」。
  if (signal !== null) return { kind: 'exited', exitCode: null, stdout, stderr };
  return { kind: 'exited', exitCode, stdout, stderr };
}

/** runSelfCheckProbe 的默认 spawn —— 与 commandRunner 共享 defaultSpawn 的派生口径。 */
async function defaultSpawn(
  command: string,
  cwd: string,
  allowlist: readonly string[],
  timeoutMs?: number,
  spawnRaw?: (cmd: string, cwd: string, timeoutMs: number) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    signal: string | null;
  }>,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut?: boolean;
}> {
  // 走 command-leaf 的真 runner (createCommandLeafRunner 返回一次性 runner 函数)。
  // 单次 inline 创建: runner 闭包持有 allowlist/timeoutMs, 与 command 节点共用同一套闸
  // (commandBlockReason + 白名单 + 超时, INV-2-2)。allowlist 直接透传调用方给的表 ——
  // 之前这里硬编码一份 11 项影子表, 外层闸放行的命令 (如 grep) 到这里被二次拒绝且不报错
  // (P2c)。
  const runner = createCommandLeafRunner({
    allowlist: [...allowlist],
    timeoutMs: timeoutMs ?? 60_000,
    cwd,
  });
  const r = await runner({ command });
  return {
    stdout: r.text,
    stderr: '',
    exitCode: r.exitCode,
    signal: r.signal,
    timedOut: r.timedOut,
  };
}

/**
 * **getFollowUpMessages 闭包工厂** (C-2/C-3 主件)。
 *
 * 把每次被 pi 循环在收尾调到的 `getFollowUpMessages` 闭包**单实例化**, 内部维护:
 *   - `roundsSoFar` —— 已注 follow-up 的次数 (与 `selfRepair.rounds` 一致);
 *   - `oracleExit` —— 每次跑的退出码, **含首次**(INV-4-2: 长度 ≥ 1);
 *   - `lastTouchedCount` —— 上次自修前的 touched 大小, 用作「有新增才开下一轮」的判据;
 *   - `converged` —— 收敛后短路, 后续调用一律 [] (防御性, 不该再被调)。
 *
 * 返回 [] 的几条路径:
 *   ① OMD_SELF_CHECK 关闭 / opts 关 / maxSelfRepair = 0 → 永不启动;
 *   ② 已收敛 → 短路;
 *   ③ rounds >= maxSelfRepair → 边界 (INV-3-1);
 *   ④ 自修轮 touched 零新增 → 停 (INV-3-2);
 *   ⑤ 闸拒 (dangerous command) → 不注 follow-up, 节点按旁路收尾 (INV-2-2 配套, 见 runOnce);
 *   ⑥ 退出码 === expect_exit → 收敛。
 */
export function buildSelfCheckFollowUp(opts: {
  spec: SelfCheckSpec;
  cwd: string;
  allowlist: readonly string[];
  /** 该闭包**每次**被调时取的「本节点当前 touched 大小」。{@link getWorkspaceDigest} 缺席时的兜底判据。 */
  getTouchedSize: () => number;
  /**
   * 「工作区自上次尝试以来变没变」的**内容级**判据 (2026-08-26)。返回当前写集的内容指纹。
   *
   * ## 为什么要它 —— `getTouchedSize` 是一把会漏的尺子
   *
   * `touched` 是**路径集合**, `size` 是路径**个数**。于是最常见的那种自修 —— 同一个文件再改一刀
   * —— 计数一个字都不动, 判据当场判「零新增 → 停」。后果不是少跑一轮, 是**自修环在第 1 轮就
   * 被静默截断**, 而账本上它长得和"改不动了主动停"一模一样。
   *
   * 反方向同样漏: 模型写了个与判据无关的新文件, 计数涨了, 于是判据判「有进展」, 白跑一次探测。
   *
   * 内容指纹两个方向都对: 同文件二次编辑 → 指纹变 → 继续; 什么都没改 → 指纹不变 → 停。
   * 这是 iceCoder 那条「工作区自上次尝试以来没变就不重复跑同一个失败 gate」的同一条判据,
   * 而且比它更早一步生效 —— 我们连探测的子进程都不 spawn。
   *
   * 缺席 (测试注入 / 取不到) → 退回 `getTouchedSize` 的计数判据, 与本改动前逐字同行为。
   */
  getWorkspaceDigest?: () => string | null;
  /** 是否启用 (env / opts.maxSelfRepair / 全局旁路 三路取与)。 */
  enabled: boolean;
  /** 自修轮数上限。<= 0 = 不注任何 follow-up。 */
  maxSelfRepair: number;
  /** truncator: 给定 stdout/stderr, 返回 trunc 后文本。测试可注入, 生产走 pi `truncateTail`。 */
  truncate?: (s: string, maxBytes: number) => string;
  /**
   * S3 (D-2/D-5) 接线: 读 outer 闭包持有的当前轮 (fail) 集, 用于本轮 follow-up 的判据 diff 槽。
   * observe 回调负责写入 (走 `currentFailSet = ...`), 接线层持 getter 以让本闭包在构造 body 时读到。
   * 缺席 (测试未注入) ⇒ 视为恒 null (即每轮都是 first-round, 不影响其他闸)。
   */
  getCurrentFailSet?: () => readonly string[] | null;
  /** 探测跑法 (默认 = `runSelfCheckProbe`)。测试可注入。 */
  probe?: (input: { command: string; cwd: string; allowlist: readonly string[] }) => Promise<SelfCheckOutcome>;
  /** 注入观测 (按 outcome 记一笔账本)。测试可观察, 生产 = console logger。
   * `stdout`/`stderr` 仅在 `kind === 'exited'` 时存在 —— 自修环外不再多花成本解析,
   * 也避免空跑被误读成"看了一通";`spin-route` 档 1 用它取 self_check 输出的 (fail) 名字集。 */
  observe?: (info: {
    kind: 'blocked' | 'exited' | 'no-progress' | 'round-cap' | 'converged' | 'disabled';
    exitCode?: number | null;
    rounds: number;
    stdout?: string;
    stderr?: string;
  }) => void;
}): { followUp: () => Promise<AgentMessage[]>; ledger: SelfRepairLedger } {
  const ledger: SelfRepairLedger = { rounds: 0, oracleExit: [], convergedAt: null, followUpHashes: [] };
  let lastTouched = opts.getTouchedSize();
  let lastWorkspace = opts.getWorkspaceDigest?.() ?? null;
  let converged = false;
  // S3 (D-2/D-6): 上一轮滚动保存的 (fail) 集, 用于构造本轮 follow-up 的判据 diff 三态。
  // 首轮为 null ⇒ buildCriteriaDiff 返 first-round; 判红 + 提取空数组 ⇒ unparsable (不冒充稳定)。
  let prevFailSet: readonly string[] | null = null;
  // 「有没有上一轮」必须与「上一轮的红集是不是 null」分开记 (静默坑 1): 判据是 tsc 这类
  // 从不产 (fail) 行的命令时, 每轮红集都是 null —— 只看 prevFailSet 的话第 2 轮会谎称首轮。
  let sawPreviousRound = false;
  const probe = opts.probe ?? ((p) => runSelfCheckProbe({ ...p, timeoutMs: 60_000 }));
  const truncate = opts.truncate ?? ((s, n) => (s.length <= n ? s : truncateTail(s, { maxBytes: n }).content));
  let lastOutputDigest: string | null = null;
  const followUp = async (): Promise<AgentMessage[]> => {
    if (!opts.enabled || opts.maxSelfRepair <= 0) {
      opts.observe?.({ kind: 'disabled', rounds: ledger.rounds });
      return [];
    }
    if (converged) return [];
    if (ledger.rounds >= opts.maxSelfRepair) {
      opts.observe?.({ kind: 'round-cap', rounds: ledger.rounds });
      return [];
    }
    const curTouched = opts.getTouchedSize();
    const curWorkspace = opts.getWorkspaceDigest?.() ?? null;
    // INV-3-2: 自修一轮后**工作区一个字节都没变** → 不再开下一轮。
    // 判据优先级: 内容指纹 > 路径计数。两者都取不到指纹时才退回计数 (见 getWorkspaceDigest 的注)。
    // ⚠ 判据在 probe 之前 —— 这一条的全部价值就是连子进程都不 spawn: 工作区没变时,
    //   同一条命令的退出码按定义与上一轮相同, 跑它是纯粹的墙钟浪费。
    const stalled =
      curWorkspace !== null && lastWorkspace !== null ? curWorkspace === lastWorkspace : curTouched === lastTouched;
    if (ledger.rounds > 0 && stalled) {
      opts.observe?.({ kind: 'no-progress', rounds: ledger.rounds });
      return [];
    }
    lastTouched = curTouched;
    lastWorkspace = curWorkspace;
    const out = await probe({ command: opts.spec.command, cwd: opts.cwd, allowlist: opts.allowlist });
    if (out.kind === 'blocked') {
      // 闸拒: 退出码折成 -1 落账, 不注 follow-up (再跑一样被拒, 不是收敛机会)。
      ledger.oracleExit.push(-1);
      opts.observe?.({ kind: 'blocked', exitCode: -1, rounds: ledger.rounds });
      converged = true; // 不再被调 (节点收尾由闸拒结果决定, 见 runOnce 注释)
      return [];
    }
    // exitCode 可能是 null (信号死) —— 落账时折成 -1, 与 commandRunner 的闸拒/被信号杀
    // 同款 (H5-1: 三字段互不推断, 异常路径统一进 -1 槽, 不留 null 让下游类型失稳)。
    ledger.oracleExit.push(out.exitCode ?? -1);
    opts.observe?.({
      kind: 'exited',
      exitCode: out.exitCode,
      rounds: ledger.rounds,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    const outputOk =
      opts.spec.expect_output === undefined || `${out.stdout}${out.stderr}`.includes(opts.spec.expect_output);
    if (out.exitCode === opts.spec.expect_exit && outputOk) {
      ledger.convergedAt = ledger.rounds; // 首轮就绿 ⇒ 0; 后续 ⇒ 对应轮次
      converged = true;
      opts.observe?.({ kind: 'converged', exitCode: out.exitCode, rounds: ledger.rounds });
      return [];
    }
    // 不等: 构造 follow-up。轮数 +1。
    ledger.rounds += 1;
    // 判据输出的内容指纹: 与上一轮逐字节相同 = 这一轮的改动**没有触及判据看得见的任何东西**。
    // 光看退出码分不出「改了但还没改对」与「什么都没改到」, 而后者再来一轮也只是重烧同一局。
    const digest = sha256Hex(`${out.exitCode ?? 'sig'}\u0000${out.stdout}\u0000${out.stderr}`);
    const unchanged = digest === lastOutputDigest;
    lastOutputDigest = digest;
    // S3 (D-2/D-5/D-6): 判据现场 = 原 formatSelfCheckFollowUp 输出; 三个新槽追加其后。
    // 判据 diff 槽走三态, 上一轮红集 = 本轮开探针前的 prevFailSet, 本轮红集 = currentFailSet
    // (observe 已在上面更新)。当前轮 follow-up 注入完后, prevFailSet 滚动到 currentFailSet,
    // 下一轮的 diff 才看得到本轮的 (fail) 集。
    const criteriaScene =
      formatSelfCheckFollowUp(opts.spec, out, truncate) +
      (unchanged
        ? '\n\n[判据输出与上一轮逐字节相同 —— 你这一轮改的东西判据看不见。' +
          '换一处改, 或先确认判据跑的到底是不是你改的那份产物。]'
        : '');
    const diff: RepairCriteriaDiff = buildCriteriaDiff(
      prevFailSet,
      opts.getCurrentFailSet?.() ?? null,
      sawPreviousRound,
    );
    const slots = {
      criteriaScene,
      criteriaDiff: diff,
      previousAttempt: !sawPreviousRound
        ? '(无 —— 首轮)'
        : prevFailSet === null
          ? '(上一轮跑过, 但它的输出里没有可解析的 (fail) 行)'
          : `(上一轮 (fail) 集: [${[...prevFailSet].join(', ')}])`,
      strategy: strategyForRound(ledger.rounds),
    };
    const body = buildRepairFollowUp(slots);
    ledger.followUpHashes!.push(sha256Hex(body));
    prevFailSet = opts.getCurrentFailSet?.() ?? null;
    sawPreviousRound = true;
    const userMsg: AgentMessage = {
      role: 'user',
      content: body,
      timestamp: Date.now(),
    } as AgentMessage;
    return [userMsg];
  };
  return { followUp, ledger };
}

/** 把一次 self_check 失败的输出格式化成 follow-up user 消息。 */
function formatSelfCheckFollowUp(
  spec: SelfCheckSpec,
  out: { exitCode: number | null; stdout: string; stderr: string },
  truncate: (s: string, maxBytes: number) => string,
): string {
  const stdoutT = truncate(out.stdout, SELF_CHECK_OUTPUT_MAX_BYTES);
  const stderrT = truncate(out.stderr, SELF_CHECK_OUTPUT_MAX_BYTES);
  return (
    `[self_check 未通过 (退出码 ${out.exitCode ?? '(信号死)'} ≠ 期望 ${spec.expect_exit})]\n` +
    `命令: ${spec.command}\n` +
    `---\nstdout:\n${stdoutT || '(空)'}\nstderr:\n${stderrT || '(空)'}\n---\n` +
    `请基于上述失败原因继续修复你的产物。再次结束时不要重复上次同样的做法。`
  );
}

/**
 * 造一个真 agent-leaf runner: 每次调用起一个一次性带工具子 session, 跑完 dispose。
 * 这是 omd 本体「真能干活(改文件)」的执行底座 —— 不再只是单发文本。
 */
/**
 * pi session token 口径 → ModelUsage 口径 (2026-07-28 修, 纯函数便于单测)。
 *
 * pi 的 `tokens.input` 是**不含缓存命中**的增量; 而 ModelUsage 契约要求 `in` = 总 prompt token 且
 * **cacheHit ⊆ in** (见 model/types.ts)。直接照搬两字段会让 cacheHit 远大于 in —— 工具循环里缓存前缀
 * 被复用几十轮, 实测 cacheHit/in 到过 **2082%**。后果不止读数难看: 成本账按
 * `(in − cacheHit)×全价 + cacheHit×10%` 折算, in 偏小会算出**负成本**。故这里把 cacheRead 补回 in。
 */
export function mapSessionUsage(tokens?: { input?: number; output?: number; cacheRead?: number }): ModelUsage {
  if (!tokens) return { in: 0, out: 0 };
  const cacheHit = tokens.cacheRead ?? 0;
  return { in: (tokens.input ?? 0) + cacheHit, out: tokens.output ?? 0, cacheHit };
}

/**
 * **座位级极简工具面**(owner 2026-08-18 裁)。按 `modelId` 匹配,不看 provider ——
 * 同一个模型经哪个 provider 进来都该拿同一副工具面。
 *
 * 读数(`scripts/probes/readings/2026-08-18-leaf-toolface-ab.md`,同题同座位只动工具面):
 * `deepseek-v4-pro` 上全面臂 2,800,492 in vs 极简臂 1,098,391 in(**−61%**,两臂都判 pass);
 * 而 M3 上六个配对里四个反过来 —— 极简臂更贵(工具调用中位 17.5 → 21:工具少了它就用更多轮
 * bash 兜,而每轮都重发上下文)。所以极简是**这一个座位的**结论,不是通用结论。
 *
 * ⚠ 诚实标注:v4-pro 那一侧 **n=1**,且单臂方差实测到过 1.8×(同题同臂两跑 707,417 vs 398,464)。
 * owner 明示按现有读数落,加密测量没做。哪天要推翻它,先补 n 再说。
 */
export const DEFAULT_MINIMAL_TOOLFACE_SEATS: readonly string[] = ['deepseek-v4-pro'];

/**
 * 极简面的工具名 = pi 那套最小集(read / write / edit / bash)。
 *
 * **为什么不是只给 bash + edit**(owner 2026-08-18 追加):碰撞台账只在 `write`(strict)、
 * `edit`(strict)、`bash`(inferred,hash 为 NULL)三处写行 —— `read` 不写行,`hashline_edit`
 * **一行都不写**。所以极简面若只留 bash 与 hashline 对,这个座位改的每一个文件在台账上
 * 要么缺席、要么只剩一条没有 hash 的 inferred 行,并发多 run 时就没有交叉证据了。
 * 给回 `write` / `edit` 是为了把它记回 strict 档。`read` 一并给,是因为不给它模型只能用
 * `bash cat`,而那条路连 inferred 行都不写。
 *
 * ⚠ 极简面**刻意绕开 `hashlineEdit` 的排除**:那个开关把 `edit` 换成 hashline 对,而 hashline
 * 侧没有台账接线。这条例外只对极简座位成立,其余座位照旧。
 */
export const MINIMAL_TOOLFACE_TOOLS: readonly string[] = ['read', 'write', 'edit', 'bash'];

/**
 * **首轮之后放开工具面**(owner 2026-08-18)—— 把这件事包在既有 `prepareNextTurn` 外面。
 *
 * 为什么是包一层而不是并排挂两个:pi 的循环只认**一个** `prepareNextTurn`,两处各挂各的
 * 就是后设的胜、前一个一声不吭地失效。包起来之后顺序是明确的:先换工具面,再把**换好的**
 * context 交给内层(压缩),于是内层 `{ ...ctx, messages }` 自然带着新工具面。
 *
 * `face` 为 `null` = 这一发不做升级(非极简座位),此时退化成内层本身。
 * 只升一次:`escalated` 置位后就一直走内层。
 */
export function withToolFaceEscalation(
  face: { tools: readonly AnyOmdTool[]; systemPrompt: string; onEscalate?: () => void } | null,
  inner?: (c: { context: AgentContext }) => Promise<AgentLoopTurnUpdate | undefined>,
): (c: { context: AgentContext }) => Promise<AgentLoopTurnUpdate | undefined> {
  let escalated = false;
  return async ({ context }) => {
    let ctx = context;
    let changed = false;
    if (face && !escalated) {
      escalated = true;
      changed = true;
      ctx = { ...context, tools: [...face.tools], systemPrompt: face.systemPrompt };
      face.onEscalate?.();
    }
    const innerUpdate = await inner?.({ context: ctx });
    if (innerUpdate) return innerUpdate; // 内层从升级后的 ctx 派生, 工具面已在里面
    return changed ? { context: ctx } : undefined;
  };
}

/**
 * 项目上下文文件 (AGENTS.md / CLAUDE.md) —— 从 cwd 逐级往上收, **外层在前**。
 *
 * 此前这一段是 pi `DefaultResourceLoader` 顺手做的, 搬家后要自己做。刻意保留而不是省掉:
 * agent leaf 干的是在**别人的仓库里改代码**, 而那些文件正是那个仓库对"该怎么改"的说明书;
 * 省掉它等于让每个 leaf 从零猜项目约定。每级只取第一个命中 (AGENTS 优先于 CLAUDE, 同 pi)。
 */
const CONTEXT_FILE_NAMES = ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD', '.claude/CLAUDE.md'];
// (chat conductor 复用同一条向上走的加载路 → export;两处各读一份会漂)。

/**
 * `.claude/CLAUDE.md` 2026-08-18 加入(owner 裁)。加之前实测:本仓根目录**一份都没命中** ——
 * 仓根没有 `AGENTS.md`/`CLAUDE.md`,说明书住在 `.claude/CLAUDE.md` 里,而它不在名单上。
 * 于是"给叶子喂项目说明书"这个机制在本仓从来没生效过,且没有任何症状(机制在、生产零生效)。
 *
 * ⚠ 走到 `$HOME` 就停:`~/.claude/CLAUDE.md` 是**人的**全局 harness(身份/派遣/安全底线),
 * 不是任何仓库的说明书。把它喂给叶子 = 把 conductor 那边刚拆掉的东西从后门放回来
 * (`a426e09`)。`home` 参数是为了让这条能被测 —— 不注入的话闸只能在真 home 上跑。
 */
export function loadProjectContext(
  cwd: string,
  maxDepth = 8,
  home: string = homedir(),
): { path: string; content: string }[] {
  const found: { path: string; content: string }[] = [];
  let dir = isAbsolute(cwd) ? cwd : join(process.cwd(), cwd);
  for (let i = 0; i < maxDepth; i++) {
    if (dir === home) break;
    for (const name of CONTEXT_FILE_NAMES) {
      const full = join(dir, name);
      try {
        found.unshift({ path: full, content: readFileSync(full, 'utf-8') });
        break; // 每级只取第一个命中
      } catch {
        /* 没有就没有 —— 上下文缺席不是错误 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/**
 * leaf 的**系统提示**。搬家前这一段由 pi CLI 的 `buildSystemPrompt` 拼, 里面有大半页
 * 「你在 pi 里面工作 / pi 的文档在这些路径 / 被问到 extension 时去读 docs/extensions.md」——
 * 对一个只负责写一个文件的 DAG 叶子来说, 那是纯噪声还占着最贵的那段缓存前缀。
 *
 * 现在只留三样**模型自己推不出来**的: ① 它是什么(一个有界的执行叶子, 不是聊天助手);
 * ② 有哪些工具、各自干什么(工具自带 `promptSnippet`, 加一个工具不必再改这里);
 * ③ 工作根在哪 + 这个仓库自己的说明书。
 *
 * ⚠ **字节稳定**: 这段是每个 leaf 请求的最前缀, 改它 = 全 leaf prompt-cache 失效
 * (实测宽扇出命中 84~98%, 那是真钱)。cwd 与项目上下文随环境变是没办法的事, 排在后面;
 * 前面那两段对同一批 leaf 逐字相同。
 */
export function buildLeafSystemPrompt(opts: {
  cwd: string;
  tools: readonly AnyOmdTool[];
  contextFiles?: readonly { path: string; content: string }[];
}): string {
  const snippets = opts.tools
    .filter((t) => t.promptSnippet)
    .map((t) => `- ${t.promptSnippet}`)
    .join('\n');
  const guidelines = [...new Set(opts.tools.flatMap((t) => t.promptGuidelines ?? []))]
    .map((g) => `- ${g}`)
    .join('\n');
  const parts = [
    '你是 omd 的一个**执行叶子**: 拿到一个有界目标, 用下面的工具把它做完, 然后停。' +
      '不寒暄、不复述任务、不问"要不要我继续" —— 没有人在对面等着回话。' +
      '做完把**关键结论与改了哪些文件**写在最后一条消息里 (下游节点只看得到那条)。',
    `可用工具:\n${snippets || '(无)'}`,
  ];
  if (guidelines) parts.push(`工具守则:\n${guidelines}`);
  parts.push(`工作根: ${opts.cwd.replace(/\\/g, '/')} (相对路径都对它解析)`);
  for (const f of opts.contextFiles ?? []) {
    parts.push(`<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`);
  }
  return parts.join('\n\n');
}

/**
 * 压缩摘要的 system 段。**不接着干活、不回答记录里的问题** —— 这两条是摘要器最容易跑偏的地方
 * (给它一段"干到一半"的记录, 模型的默认反应是继续干)。pi 的同款提示词没从包入口导出, 这里自己写,
 * 顺便按叶子的场景写具体了。
 */
const LEAF_SUMMARY_SYSTEM =
  '你是上下文压缩器。读下面这段执行记录, 按要求产出一份结构化摘要。' +
  '**不要继续这段工作、不要回答记录里出现的任何问题、不要调用工具** —— 只输出摘要本身。';

/**
 * 压缩的**切点计算** (纯函数, 与那一次模型调用分开 —— 会静默出错的是这一半)。
 * 返回保留段的起始下标; 压不动返 null。
 *
 * ## 切点为什么必须落在 assistant 上
 *
 * 叶子的 transcript 形状是 `user(契约) → assistant(toolCall) → toolResult → assistant(toolCall) → …`。
 * 从中间随便切一刀, 保留段很可能以一条 **toolResult 开头** —— 那条 toolResult 的 toolCall 已经被
 * 摘要掉了, provider 会因为"孤儿工具结果"直接拒。所以按 token 预算算出候选切点后, 要落到一条
 * **assistant** 上: assistant 是一轮的开始, 它后面跟着的 toolResult 都在保留段里, 不会成孤儿。
 *
 * ⚠ 方向是**往回找**不是往后找 (2026-08-01 实测撞出来的): 往后找在"最后一条 toolResult 单独就
 * 超预算"时会一路推出末尾 → 永远压不动。实测形态就是这个 —— 读一个 200 行文件的结果比 keep 预算
 * 还大, 于是每一轮都判"压不下去"然后优雅停, 活干不完。往回找则宁可**多留一点**:
 * 保留段只会 ≥ 预算, 而"多留"的代价是少省一点 token, "少留"的代价是请求直接被拒 —— 不对称。
 *
 * 往回找不到 assistant (第一轮就撞线, 前面只有契约) → 不压, 返 null。
 *
 * 摘要以一条 **`compactionSummary` 消息**插在保留段之前(`createCompactionSummaryMessage`,
 * 2026-08-11 从手拼 user 消息换成 pi 构造器)—— 发给 provider 前由 `convertToLlm` 转成
 * 带 `COMPACTION_SUMMARY_PREFIX/SUFFIX` 的 user 消息,线上字节与手拼那份一致。
 */
export function planLeafCompaction(messages: AgentMessage[], keepRecentTokens: number): number | null {
  if (messages.length < 4) return null; // 短到没什么可压的
  // 从末尾往回攒够 keepRecentTokens → 候选切点。
  let acc = 0;
  let cut = messages.length;
  while (cut > 1 && acc < keepRecentTokens) {
    cut--;
    acc += estimateTokens(messages[cut]!);
  }
  // 往回退到最近一条 assistant (见上方切点注: 方向不能反)。
  while (cut > 1 && (messages[cut] as { role?: string }).role !== 'assistant') cut--;
  if (cut <= 1 || (messages[cut] as { role?: string }).role !== 'assistant') return null; // 没东西可摘要
  return cut;
}

/**
 * 切点落在**轮内**时,这一轮是从哪条消息开始的 —— pi 的 **split-turn 检测**
 * (`findTurnStartIndex`,原样引用不手搓)。返回轮首下标;轮首就是首条或找不到 → `null`。
 *
 * ## 为什么只借这一半,而不是把整个 `findCutPoint` 换过来
 *
 * 实测(2026-08-09,六种超预算形状 · 同一 `keepRecentTokens=20000` 下逐形状对比):
 *
 * | 形状 | omd `planLeafCompaction` 保留 | pi `findCutPoint` 保留 |
 * |---|---|---|
 * | 单轮 30 次串行工具调用 | 21064 tok | 18954 tok(split=true) |
 * | **每条结果都比预算大** | **20107 tok** | **120637 tok = 全量** |
 * | 单轮 一批 20 个并发结果 | null(压不动) | 全量(split=false) |
 *
 * pi 的切点是**往后**找的,于是"末尾一条工具结果单独就超预算"时它退回 `cutPoints[0]`、
 * 保留段等于全量 —— 正是 2026-08-01 实测把 omd 的搜索方向定成**往回找**的那条形态。
 * 换过去会让 `leaf-compaction.test.ts` 的「最后一条 toolResult 单独就超预算」当场红。
 * 同一批形状里 pi 也**没有**救回 omd 判 null 的两种(并发工具批 / 每条结果都比预算大):
 * 两边都只能保留全量 ⇒ **「压不动」不是切点能修的**,那两种的解法是截断工具结果本身。
 *
 * 真正 pi 有而 omd 没有的是 **split-turn 判定**:omd 的切点恒落在 assistant 上,于是它
 * **从不**切在轮边界 —— 每一刀都切在轮内,而"这一轮问的是什么"就此只活在通用历史摘要里。
 * 「首条逐字保留」对**叶子**是对的(叶子只有一轮,首条就是契约),对**多轮 chat** 是错的:
 * 首条是最老那一问。实测 S4(三轮闲聊 + 最后一轮 20 次工具调用):切点 30,而轮首在 9,
 * 逐字留下的却是下标 0 那条。`findTurnStartIndex` 补的就是这一句。
 */
function findTurnHeadIndex(messages: AgentMessage[], cut: number): number | null {
  // pi 的切点族吃 `Entry[]`,而**轮内**压缩那条路手上只有 `AgentMessage[]`(条目还没写进会话)⇒
  // 现造一层只读投影。`findTurnStartIndex` 只读 `type` 与 `message.role`,其余字段填得能过型即可。
  const entries: Entry[] = messages.map((message, i) => ({
    type: 'message' as const,
    id: `m${i}`,
    parentId: i === 0 ? null : `m${i - 1}`,
    seq: i,
    timestamp: 0,
    message,
  }));
  const idx = findTurnStartIndex(entries, cut, 0);
  return idx > 0 ? idx : null; // -1 = 没找到; 0 = 轮首就是首条, 已经逐字留着了
}

/**
 * 保留段里**单条工具结果**被截断时贴的标记。给人读、也给测试断言 ——
 * 保留段中出现"看着完整、其实缺了开头"的结果是**静默**的,必须自带痕迹。
 */
export const TOOL_RESULT_TRUNCATION_MARK = '[omd 压缩截断]';

/**
 * 全文**存盘成功**时贴的标记(2026-09-02)。与 `TOOL_RESULT_TRUNCATION_MARK` 分成**两个常量**,
 * 因为它们说的是两件事:截断 = 开头**没了**;溢出 = 开头**在盘上, 路径在这**。
 * 合成一个标记 + 一句「可能存了盘」会让读它的人(和模型)分不清该不该去取 —— 仓规 NULL≠0≠不适用。
 */
export const TOOL_RESULT_SPILL_MARK = '[omd 溢出存盘]';

/**
 * 溢出**失败**退回截断时,判词里必然出现的这一句。
 *
 * 三态里最容易被抹平的正是这一格:
 *   · 没配溢出(`spill` 缺席, chat 那条路)→ 逐字节走老截断判词, **不提**写盘;
 *   · 配了且存盘成功                      → `TOOL_RESULT_SPILL_MARK` + 路径;
 *   · 配了但存盘失败                      → 老截断判词 + 本句 + 错误原文。
 * 缺席与失败若都退化成同一句「全文不可取」,事后就再也分不出「这条路没装闸」和
 * 「装了闸但盘写不动」——而两者的修法完全不同(前者接线, 后者查磁盘/权限)。
 */
export const TOOL_RESULT_SPILL_FAILED_MARK = '全文写盘失败';

/**
 * 溢出落点与写盘实现。
 *
 * ## 落点为什么是 `<cwd>/.omd`(三条闸各查过一遍, 不是随手选的)
 *
 * 1. **leaf 读得到** —— 隔离档下 leaf 的 cwd 就是那棵 worktree(`run-worktree.ts`),
 *    `.omd` 在 cwd 之下 ⇒ 落在任何以 cwd 为根的沙箱边界**之内**, leaf 的 `read` 工具
 *    直接吃绝对路径就能分页读。落 `/tmp` 或主仓会在隔离档下变成「路径给了但读不到」。
 * 2. **不撞写域闸** —— `write-allow` / `write-version` 只判**工具通道**的 `write`/`edit`
 *    (`agent-tools.ts` 的 `requireWritable`);压缩是引擎侧自己写盘, 根本不过那两道。
 *    而 `.omd/` 在 `.gitignore` 里 ⇒ 跑后对账那一侧(`write-set.ts` 取的是
 *    `git status --porcelain`, 尊重 ignore)也看不见它, 不会把溢出文件读成「越界写」。
 * 3. **不新发明目录** —— `agent-tools.ts` 的 bash 截断全文早就落在同一处
 *    (`resolve(cwd, '.omd', 'bash-output-*.log')`)。同一件事两个目录才是坑。
 */
export interface ToolResultSpill {
  /** 落点目录。生产 = `<cwd>/.omd`(见上方三条)。 */
  dir: string;
  /**
   * 写盘实现。省略 = 真 `mkdirSync` + `writeFileSync`。
   * **只有测试该传** —— 造「盘写不动」那一格(fail-open 分支)没有别的办法可控地触发。
   */
  write?: (path: string, text: string) => void;
}

/**
 * 一条结果的溢出结局。三态各自带**自己的证据**,不共用一个 `ok: boolean`。
 * `off` 与 `failed` 都"取不回全文",但那是两个原因、两种修法(见
 * `TOOL_RESULT_SPILL_FAILED_MARK` 注)。
 */
type SpillOutcome =
  | { kind: 'off' }
  | { kind: 'stored'; path: string }
  | { kind: 'failed'; reason: string };

/**
 * 把一条超长工具结果的**全文**写盘,返回可取回的绝对路径。
 *
 * **fail-open, 但不吞证据**(仓规静默坑 2):写不动就退回老截断行为、主流程照跑,
 * 而那个 `catch` 必须留下 runId 之外拿得到的全部三样 —— 路径 / 字节数 / 错误原文。
 * 只 `catch {}` 的话,现场表现是「模型说取不到全文」而日志里一片干净。
 */
function spillToolResultText(text: string, spill: ToolResultSpill | undefined): SpillOutcome {
  if (!spill) return { kind: 'off' }; // 闸缺席 ≠ 写盘失败
  // 文件名带 uuid: 同一棵 worktree 里并发兄弟共用一个 `.omd`(`write-version.ts` 文件注:
  // 隔离粒度是 per-run 不是 per-leaf), 只按时间戳命名会互相盖。
  const path = join(spill.dir, `tool-result-${Date.now()}-${randomUUID()}.txt`);
  try {
    if (spill.write) spill.write(path, text);
    else {
      mkdirSync(spill.dir, { recursive: true });
      writeFileSync(path, text, 'utf8');
    }
    return { kind: 'stored', path };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { path, bytes: Buffer.byteLength(text, 'utf8'), err: reason },
      '[agent-leaf] 超大工具结果全文写盘失败 (fail-open, 回落截断)',
    );
    return { kind: 'failed', reason };
  }
}

/**
 * 触发截断的比值:保留段 > `keepRecentTokens × 这个数` 才动手。
 *
 * 取 **1.5** 是因为它是既有判据里**已经写死**的那条上界(`chat/compaction.test.ts`
 * 「压缩后落在 [keep, keep×1.5)」)—— 用同一个数意味着:**只有既有判据已经判红的形状才会被截断**,
 * 判据判绿的一律一个字不动。换个新数就等于新增一批"以前合格、现在被动了"的场景。
 */
export const COMPACTION_RETAINED_TOLERANCE = 1.5;

/**
 * 单条结果截完之后的**字节下限**。预算被 N 条并发结果均分,N 大时每份会摊到几十字节 ——
 * 那种长度的尾巴读不出任何结论,不如宁可超一点预算。2000 字节 ≈ 500 token ≈ 一屏。
 */
export const MIN_TOOL_RESULT_BYTES = 2_000;

/**
 * token 预算 → 字节上界的换算。pi 的 `estimateTokens` 口径是 **chars/4**,而 `truncateTail`
 * 卡的是 **utf8 字节**。ASCII 下二者相等(字节 = 字符),CJK 下 1 字符 = 3 字节 ⇒ 同样的字节上限
 * 换来的 token **更少**。所以用 4 换算恒是**上界**,不会算漏。
 */
const BYTES_PER_TOKEN = 4;

/**
 * 一条被动过的 text 块的**抬头**。三态各写各的判词 —— 这是模型唯一能看见的差别,
 * 也是「溢出了」与「溢出失败退回截断」在结果里可分辨的那一格。
 *
 * ⚠ `off` 那一支必须与本函数出现之前**逐字节相同**:没配溢出的调用方(chat 那条路、
 * 全部既有测试)一个字都不该变(仓规 INV-6 那一类零回归)。改它就是行为翻转,不是措辞。
 */
function spillHeadline(
  outcome: SpillOutcome,
  t: { totalBytes: number; totalLines: number; outputBytes: number },
): string {
  const scale = `原 ${formatSize(t.totalBytes)} / ${t.totalLines} 行, 只留末尾 ${formatSize(t.outputBytes)}`;
  if (outcome.kind === 'stored') {
    return (
      `${TOOL_RESULT_SPILL_MARK} ${scale}; 全文已存盘: ${outcome.path} —— ` +
      '有 read 工具就按需分页读它, 不用重跑这条工具。'
    );
  }
  if (outcome.kind === 'failed') {
    return (
      `${TOOL_RESULT_TRUNCATION_MARK} ${scale} —— ${TOOL_RESULT_SPILL_FAILED_MARK} ` +
      `(${outcome.reason}), 开头已丢弃, 需要的话重新跑一次工具取那一段。`
    );
  }
  return `${TOOL_RESULT_TRUNCATION_MARK} ${scale} —— 开头已丢弃, 需要的话重新跑一次工具取那一段。`;
}

/**
 * 把一条工具结果的 text 块截成尾部;没有一块需要截 → null(调用方据此判"没动过")。
 *
 * `spill` 给了就**先把全文写盘**再截:截掉的那一段从此取得回来(见 `ToolResultSpill` 的落点注)。
 * 省略 = 老行为(纯截断)。
 */
function truncateToolResultTail(
  msg: AgentMessage,
  maxBytes: number,
  spill?: ToolResultSpill,
): AgentMessage | null {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  let changed = false;
  const next = content.map((block) => {
    const b = block as { type?: string; text?: string };
    if (b.type !== 'text' || typeof b.text !== 'string') return block; // 图片块原样带过
    if (Buffer.byteLength(b.text, 'utf8') <= maxBytes) return block;
    // 留**尾**不留头: 工具结果的结论在尾 (bash 的报错/退出行、测试的汇总行、grep 的最后一批命中)。
    const t = truncateTail(b.text, { maxBytes, maxLines: DEFAULT_MAX_LINES });
    if (!t.truncated) return block;
    changed = true;
    // ⚠ 次序: **确认真要截了才写盘**。放到 `truncated` 判定之前会给每一条没超线的结果
    // 白写一个文件 —— 那是一整棵 worktree 的垃圾, 而且违反"没触发就零副作用"。
    const outcome = spillToolResultText(b.text, spill);
    return { ...b, text: `${spillHeadline(outcome, t)}\n${t.content}` };
  });
  return changed ? ({ ...(msg as object), content: next } as AgentMessage) : null;
}

/**
 * **保留段里的巨型工具结果截断**(2026-08-09)—— 「压不动」的真解。
 *
 * ## 为什么切点修不了「压不动」
 *
 * 两边(omd 往回找 / pi 往后找)的合法切点都**排除 toolResult**:切在它上面就是孤儿结果、
 * provider 直接 400。于是「一批并发结果」或「单条结果比预算还大」时,任何切法都得把那一整批
 * 整个保留 —— 保留段的下限就是那一批的大小,与切点无关(实测表在 `findTurnHeadIndex` 注里:
 * 单轮 20 个并发结果, omd 返 null、pi 保留全量)。**能动的只剩结果内容本身。**
 *
 * ## 三条边界(都是"别把零行为变化搞成有行为变化"的那一类)
 *
 * 1. **只在压缩里调用** —— 正常轮走不到这里,一条消息都不动。
 * 2. **保留段没超太多就一个字不动**(`COMPACTION_RETAINED_TOLERANCE`):既有形状全部落在这条线下,
 *    所以既有测试一行不用改。撑爆预算的**不是**工具结果时(纯对话)也返 null —— 截了也没用。
 * 3. **预算按条均分**:单条上限 = 结果那部分预算 ÷ 结果条数。定值上限(如 pi 的 `DEFAULT_MAX_BYTES`
 *    = 50KB)挡不住这个形状 —— 20 条各 24KB 每条都在 50KB 之下,合起来 120k token 照样撑爆。
 *
 * @param retained 保留段(含逐字留下的首条)。
 * @param opts.tolerance 覆盖触发比值;`opts.minBytes` 覆盖单条下限。默认见上方两个常量。
 * @param opts.spill 给了 → 截之前先把**全文**写盘, 判词里给取回路径(见 `ToolResultSpill`);
 *                   省略 → **闸缺席**, 逐字节走老截断行为(chat 那条路 / 全部既有调用方)。
 * @returns 截过的新数组;没触发/没得截 → `null`(调用方原样用旧的,**不是**返回一份"看着一样"的拷贝)。
 */
export function truncateOversizedToolResults(
  retained: AgentMessage[],
  keepRecentTokens: number,
  opts: { tolerance?: number; minBytes?: number; spill?: ToolResultSpill } = {},
): AgentMessage[] | null {
  const tolerance = opts.tolerance ?? COMPACTION_RETAINED_TOLERANCE;
  const total = retained.reduce((n, m) => n + estimateTokens(m), 0);
  if (total <= keepRecentTokens * tolerance) return null;
  const targets = retained.flatMap((m, i) => ((m as { role?: string }).role === 'toolResult' ? [i] : []));
  if (targets.length === 0) return null;
  const resultTokens = targets.reduce((n, i) => n + estimateTokens(retained[i]!), 0);
  // 结果之外的部分(契约/轮首/assistant)是**不能截**的 ⇒ 先扣掉, 剩下的才是结果能吃的预算。
  const budgetTokens = Math.max(0, keepRecentTokens - (total - resultTokens));
  const maxBytes = Math.max(
    opts.minBytes ?? MIN_TOOL_RESULT_BYTES,
    Math.floor((budgetTokens * BYTES_PER_TOKEN) / targets.length),
  );
  const out = [...retained];
  let changed = false;
  for (const i of targets) {
    const t = truncateToolResultTail(retained[i]!, maxBytes, opts.spill);
    if (t) {
      out[i] = t;
      changed = true;
    }
  }
  return changed ? out : null;
}

/**
 * 切不出点、但**截断本身**就把上下文压下来了时用的摘要文本。
 *
 * 为什么不返 `null` 了事:这条路上「没东西可摘要」是真的(契约之后只有一轮),但
 * 「压不动」不再是真的 —— 结果截完就在预算内。返 null 会让调用方去优雅停,活干不完,
 * 而那正是这次要修的病。摘要位上写清楚"这次省的是哪来的",别让读的人以为摘要器出了空。
 */
export const TRUNCATION_ONLY_SUMMARY =
  '(这次压缩没有可摘要的历史 —— 切不出摘要点。省下来的空间全部来自把超大工具结果截成尾部, ' +
  `被动过的每一条自己带 ${TOOL_RESULT_SPILL_MARK}(全文在盘上, 判词里有路径)` +
  `或 ${TOOL_RESULT_TRUNCATION_MARK}(开头真丢了)标记。)`;

/**
 * 摘要器的两段提示词。**默认是叶子口径**;chat conductor 走同一条压缩路但换措辞
 * (它压的是一段对话,不是"干到一半的执行记录")—— 见 `opts.prompt`。
 *
 * ⚠ 为什么是**换措辞**而不是各写一套压缩:会静默出错的是**切点**那一半
 * (切出孤儿 toolResult → provider 直接 400),而切点逻辑两边一模一样。
 * 复制一份出去,`planLeafCompaction` 的每次修正都要记得改两处 —— 本仓已经吃过那个形状。
 */
export interface CompactionPrompt {
  system: string;
  instruction: string;
}

const LEAF_COMPACTION_PROMPT: CompactionPrompt = {
  system: LEAF_SUMMARY_SYSTEM,
  instruction:
    '上面是一个执行叶子干到一半的记录, 上下文快满了要压缩。请写一份**接手用**的摘要, 覆盖:\n' +
    '① 已经改/建了哪些文件, 各自改成了什么样 (路径逐字);\n' +
    '② 跑过哪些验证命令、结论是什么 (通过/失败, 失败的错在哪);\n' +
    '③ 已经排除掉的做法与原因 (防止接手的人重走一遍);\n' +
    '④ **还没做完的部分**, 以及下一步该做什么。\n' +
    '只输出摘要本身, 不要复述任务、不要寒暄、不要接着干活。',
};

/**
 * 压缩的结构化结果(2026-08-09)。
 *
 * `messages` 是**拼好的新上下文**(与本函数此前的返回值逐字相同,叶子那条路只用它);
 * `summary` / `retainedTail` 是给**存储层**的:pi 的 `compaction` 条目存的正是这两件,
 * 投影时自己拼回 `[摘要, ...retainedTail]`(`harness/session/context.js`)。
 *
 * ⚠ 两种拼法有一处**次序差**:这里的 `messages` 是 `[首条, 摘要, ...尾]`(首条逐字在前),
 * 而 pi 的投影是 `[摘要, 首条, ...尾]` —— 内容一条不少,首条与摘要谁先谁后不同。
 * 之所以不去改 pi:那是它的条目语义(摘要即截断点),而首条在不在才是 omd 在意的那件事。
 */
export interface LeafCompaction {
  messages: AgentMessage[];
  summary: string;
  /** 摘要之后原样留着的消息 —— **含逐字保留的首条**(见上方次序差那条)。 */
  retainedTail: AgentMessage[];
}

export async function compactLeafContext(opts: {
  messages: AgentMessage[];
  model: string;
  keepRecentTokens: number;
  signal?: AbortSignal;
  /** 省略 → 叶子口径。chat conductor 传自己那一套(切点逻辑不变)。 */
  prompt?: CompactionPrompt;
  /**
   * 超大工具结果的**溢出落点**(2026-09-02)。给了 → 截之前先把全文写盘, 判词里给取回路径。
   *
   * 这里只做**穿透**, 切点/摘要一行没动:`truncateOversizedToolResults` 是压缩路上唯一的
   * 入口, 落点又必须按 leaf 的 cwd 定(隔离档下每棵 worktree 各写各的 `.omd`), 所以它只能
   * 从调用方一路递进来 —— 烤成模块级常量会让并发 leaf 共用一个别人的 cwd。
   * 省略 = 闸缺席, 逐字节走老截断行为(`chat/compaction.ts` 那条路)。
   */
  spill?: ToolResultSpill;
  /**
   * 摘要那一次模型调用。省略 → 真 `callModel`(**账本挂在它出口上**,换掉默认值
   * 等于把这次花的钱从账上抹掉)。只有测试该传:全局 provider 注册表是跨测试文件
   * 共享的可变状态,靠它做隔离单文件绿、全量红(2026-08-07 实测)。
   */
  callModelFn?: typeof callModel;
}): Promise<LeafCompaction | null> {
  const { messages, model, keepRecentTokens, signal } = opts;
  const prompt = opts.prompt ?? LEAF_COMPACTION_PROMPT;
  const call = opts.callModelFn ?? callModel;
  const cut = planLeafCompaction(messages, keepRecentTokens);
  if (cut === null) {
    /**
     * 切不出点(契约之后只有一轮 / 短到没得摘要),而这一轮的**工具结果本身**撑爆了预算 ——
     * 此前这里直接返 null = 调用方优雅停,活干不完。截断是这个形状唯一动得了的东西,
     * 而且**不花一次模型调用**:没有历史要摘要,也就没有要付钱的地方。
     */
    const truncated = truncateOversizedToolResults(messages, keepRecentTokens, {
      ...(opts.spill ? { spill: opts.spill } : {}),
    });
    if (!truncated) return null; // 真的压不动: 没超太多, 或撑爆预算的不是工具结果
    const truncTokensBefore = messages.reduce((n, m) => n + estimateTokens(m), 0);
    logger.info(
      { model, msgs: truncated.length, before: truncTokensBefore,
        after: truncated.reduce((n, m) => n + estimateTokens(m), 0) },
      '[agent-leaf] 切不出摘要点 → 只截断超大工具结果 (零模型调用)',
    );
    return {
      messages: [
        truncated[0]!,
        createCompactionSummaryMessage(TRUNCATION_ONLY_SUMMARY, truncTokensBefore, Date.now()),
        ...truncated.slice(1),
      ],
      summary: TRUNCATION_ONLY_SUMMARY,
      retainedTail: truncated,
    };
  }

  const toSummarize = messages.slice(1, cut);
  if (toSummarize.length === 0) return null;
  const transcript = serializeConversation(convertToLlm(toSummarize));

  let summary: string;
  try {
    const res = await call({
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: `<conversation>\n${transcript}\n</conversation>\n\n${prompt.instruction}` },
      ],
      model,
      // 压缩是记账内的一次真调用, 但它是**辅助工序**: 关思考、限输出, 别让它比正活还贵。
      thinkingLevel: 'off',
      maxTokens: 4096,
      ...(signal ? { signal } : {}),
    });
    summary = res.text.trim();
  } catch (err) {
    // 压不动不是致命错: 调用方回落"优雅停", 已写盘的产物照样交。
    logger.warn({ model, err: (err as Error).message }, '[agent-leaf] 上下文压缩失败 → 回落优雅停');
    return null;
  }
  if (!summary) return null;
  const head = messages[0]!; // 契约逐字留着 (见 opts.compaction 注)
  const tail = messages.slice(cut);
  /**
   * **split-turn**(2026-08-09):切点落在轮内时,这一轮**自己的请求**也被摘要吃掉了,
   * 而逐字保留的首条是最老那一问 —— 于是保留段读起来是"干到一半的活",却没有"要干什么"。
   * 把轮首逐字接在摘要后面补上这一句。
   *
   * 与 pi 的做法差在哪:pi 是**再花一次模型调用**把轮前缀压成 `## Original Request /
   * ## Early Progress / ## Context for Suffix` 三段(`TURN_PREFIX_SUMMARIZATION_PROMPT`,
   * **没从包入口导出**,`dist/index.d.ts` 里查不到 ⇒ 想"配它的摘要段"只能自己再写一份措辞)。
   * 逐字留一条比摘要它更省(零额外调用)也更准 —— 请求是要被**照着执行**的东西,不该转述。
   * 叶子那边轮首恒为下标 0 ⇒ 这一段对叶子是 no-op(实测 S1/S3/S6 轮首均为 0)。
   */
  const turnHead = findTurnHeadIndex(messages, cut);
  const kept = turnHead === null ? tail : [messages[turnHead]!, ...tail];
  /**
   * **保留段的工具结果截断**(2026-08-09):切点排除 toolResult ⇒ 一批巨型结果只能整批保留,
   * 保留段可以比预算大好几倍而切点无能为力。超得太多才动手(见 `truncateOversizedToolResults`
   * 的三条边界),所以既有形状全部走 `?? retained` 这条、一个字不变。
   *
   * ⚠ 只截**保留段**,不截送去摘要的那一段:摘要那次调用收到什么原文,压缩前后必须一样,
   * 否则这次改动就顺手改了摘要质量,而读数上分不出是哪一半带来的。
   */
  const retained = [head, ...kept];
  const finalRetained =
    truncateOversizedToolResults(retained, keepRecentTokens, {
      ...(opts.spill ? { spill: opts.spill } : {}),
    }) ?? retained;
  return {
    messages: [
      finalRetained[0]!,
      createCompactionSummaryMessage(summary, messages.reduce((n, m) => n + estimateTokens(m), 0), Date.now()),
      ...finalRetained.slice(1),
    ],
    summary,
    retainedTail: finalRetained,
  };
}

/** 一条 AgentMessage 里的 assistant 文本 (thinking / toolCall 块不算)。chat agent 复用 → export。 */
export function assistantText(msg: AgentMessage): string {
  if ((msg as { role?: string }).role !== 'assistant') return '';
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string })?.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * 一次调用的 per-call 作用域 (ALS 里那一格)。装配期闭包只挂 getter, 值由 wrapper 的 `run()` 写入。
 * 抽成具名类型是为了让下面的**装配期 commit 检查**能拿到同一个 store 做探针 (类型必须对得上)。
 */
export interface LeafCallScope {
  session?: string;
  mcpAllow?: string[];
  writeAllow?: string[];
  writeDenials?: Map<string, number>;
  /**
   * 版本守卫的观察台 (2026-09-01, 判据面 = `writeset/write-version.ts`)。
   * **必须按调用新建** —— 跨调用复用等于拿上一个节点看过的版本放行这一个。
   */
  fileObservations?: Map<string, FileObservation>;
  /**
   * 本次调用的冻结判据 + `run_acceptance` 台账(P3 S2, 2026-09-02)。按调用新建: 判据是节点的, 台账是这一发的。
   * 缺席 = 本次没派判据 → `run_acceptance` 不在工具面上。
   */
  acceptance?: { spec: SelfCheckSpec; rounds: number; last: AcceptanceOutcome | null };
  /**
   * W2 读账观察口 (2026-09-06): 来自**本次调用**的 `input.face.onToolObserved` (编排循环的 conductor 面)。
   * 按调用落而不是烤进装配期 —— 工具跨 run 复用, 烤进去就会把上一趟 conductor 的勘察交接给这一趟
   * (同 `writeAllow` / `fileObservations` 那条纪律)。缺席 = 本次不记。
   */
  toolObserver?: (ev: ReadEvent) => void;
}

/**
 * 装配期 commit 检查用的哨兵值。取一个**不可能是真值**的串: 真的 session 是 `<runId>:<nodeId>`,
 * 真的写集是路径 —— 哨兵串在两边都不会自然出现, 于是"getter 读到了哨兵"只可能是真读了 ALS。
 */
const GATE_COMMIT_PROBE = 'omd-gate-commit-probe/哨兵';

/**
 * 交给工具工厂的那两个 opts 对象 (**原物, 不是复制**) —— commit 检查的判据面。
 * 类型刻意宽 (`unknown`): 检查要能对"这个键压根不在"下判断, 收窄的类型会让 tsc 先把它挡掉,
 * 而历史上出事的正是**运行期条件 spread 把键丢了**这一路 (tsc 一个字都不报)。
 */
export interface LeafGateWiring {
  /** `createOmdAgentTools({...})` 收到的那个对象。 */
  agentTools: { writeAllow?: unknown; touch?: { session?: unknown } | undefined; fileObservations?: unknown };
  /** `createMcpClientTools({...})` 收到的那个对象。 */
  mcpTools: { policy?: unknown };
}

/**
 * **装配期事务 (commit)**: 四道闸的接线**当场验一次**, 有一条没接上就抛 —— `createAgentLeafRunner`
 * 不返回 runner, 这个节点根本不发布 (形状借 DeepSeek Harness 的 `AgentSetup`: setup/commit 抛错则
 * 两个 id 都不发布; 只借语义, 不引依赖)。
 *
 * ## 为什么非要有它
 *
 * 2026-08-25 本仓主树实测 (`writeset/touch-ledger.ts:27` 记着原文): 台账 `rows=2924` 而
 * `strict=0 / inferred=0` —— **agent 工具面一条都没记进来**。成因是 `assemble.ts` 的两处装配
 * 没传 `opts.touch`, 而当时的接线写成 `...(touchOpt ? { touch: … } : {})`, 于是引擎按调用发的
 * session **无处可落**。leaf 照跑不误, tsc 干净, 测试全绿, **没有任何东西红** ——
 * 它被发现纯属另一档 (cli) 的数把它衬托出来。这道 commit 就是把"没红"这件事本身变红。
 *
 * ## 判据是两条, 不是一条
 *
 * ① **键在不在** —— 条件 spread 丢键 (上面那次的真实形态);
 * ② **getter 真读 ALS 没有** —— 把 per-call 的东西烤进装配期闭包 (`writeAllow: opts.writeAllow`
 *    这种写法), 类型一样过, 后果是**拿上一个节点的写集去判这一个**。探针塞哨兵进 ALS, 读不回来
 *    就是烤死了。
 *
 * 两条都是 `tsc` 与既有测试**结构上抓不到**的形态, 所以这道闸不冗余。
 *
 * ⚠ 本函数**不判缺省策略**: 四道闸缺省是放行还是拒绝, 由各自的判据面决定 (见
 * {@link LeafGatePosture})。这里只判"接线在不在", 不动任何判据。
 *
 * 反向自检 (leaf-gate-commit.test.ts): 摘掉 `agentTools.touch` / 把 `writeAllow` 换成烤死的常量
 * thunk / 摘掉 `mcpTools.policy` / 把 `fileObservations` 换成每次新建 Map 的 thunk ——
 * 四条用例分别当场红。
 */
export function commitLeafGates(store: AsyncLocalStorage<LeafCallScope | undefined>, handed: LeafGateWiring): void {
  const missing: string[] = [];
  /**
   * 观察台的哨兵**用对象身份判, 不用值判** (2026-09-01, 第四道闸)。
   * 版本守卫的观察台是个 Map, 「烤死在装配期」的写法 (`fileObservations: () => new Map()` /
   * 指向某个常量 Map) 返回的**也是一个 Map** —— 只比"是不是 Map"根本分不出来。
   * 身份判则一击命中: 只有真读了本次 ALS 的 getter 才会回到**这一个**对象。
   */
  const probeObservations = new Map<string, FileObservation>();
  store.run(
    {
      session: GATE_COMMIT_PROBE,
      mcpAllow: [GATE_COMMIT_PROBE],
      writeAllow: [GATE_COMMIT_PROBE],
      writeDenials: new Map(),
      fileObservations: probeObservations,
    },
    () => {
      const sessionGetter = handed.agentTools.touch?.session;
      if (typeof sessionGetter !== 'function' || (sessionGetter as () => unknown)() !== GATE_COMMIT_PROBE) {
        missing.push('touchSession (碰撞台账 session 落不进工具面)');
      }
      const writeGetter = handed.agentTools.writeAllow;
      const seen = typeof writeGetter === 'function' ? (writeGetter as () => unknown)() : undefined;
      if (!Array.isArray(seen) || seen[0] !== GATE_COMMIT_PROBE) {
        missing.push('writeAllow (写域闸的按调用写集读不到)');
      }
      const policyGetter = handed.mcpTools.policy;
      const policy = typeof policyGetter === 'function' ? (policyGetter as () => unknown)() : undefined;
      const allow = (policy as { sideEffects?: { allow?: unknown } } | undefined)?.sideEffects;
      if (typeof allow !== 'object' || allow === null || !Array.isArray(allow.allow) || allow.allow[0] !== GATE_COMMIT_PROBE) {
        missing.push('mcpAllow (外部 MCP 授权清单读不到)');
      }
      const obsGetter = handed.agentTools.fileObservations;
      const obs = typeof obsGetter === 'function' ? (obsGetter as () => unknown)() : undefined;
      if (obs !== probeObservations) {
        missing.push('fileObservations (版本守卫的按调用观察台读不到)');
      }
    },
  );
  if (missing.length > 0) {
    throw new Error(
      `[agent-leaf] 闸装配失败, 本 runner 不发布 (装配期事务): ${missing.join(' · ')}。` +
        '声明了要装却没真正装上 —— leaf 照跑会让这些闸静默缺席 (touch-ledger.ts:27 记着这个形态的实测)。',
    );
  }
}

/**
 * 本次调用三道闸的在场态 (缺席即具名, 见 {@link LeafGateStates})。
 *
 * 判据 = **判据面在不在**, 不是"有没有判出问题": `writeAllow: []` 是"声明了什么都不许写" →
 * `enforced`; `undefined` 才是缺席。per-call 缺席时回落 runner 级兜底 (与三个 getter 的
 * `store?.x ?? opts.x` 同一条优先序 —— 这里若只看 `input`, 会把 runner 级配好的闸误报成缺席)。
 */
export function leafGateStates(
  input: Pick<AgentLeafInput, 'writeAllow' | 'mcpAllow' | 'touchSession'>,
  opts: Pick<AgentLeafRunnerOpts, 'writeAllow' | 'mcpAllow' | 'touch'>,
): LeafGateStates {
  const mcp = input.mcpAllow ?? opts.mcpAllow;
  return {
    writeAllow: (input.writeAllow ?? opts.writeAllow) !== undefined ? 'enforced' : 'unavailable',
    // mcpAllow 的判据面与 leafMcpPolicy 同源: 空清单在那里就等于没声明 (deny 全部), 这里同判。
    mcpAllow: mcp && mcp.length > 0 ? 'enforced' : 'unavailable',
    touchSession: (input.touchSession ?? opts.touch?.session) !== undefined ? 'enforced' : 'unavailable',
  };
}

export function createAgentLeafRunner(opts: AgentLeafRunnerOpts = {}): AgentLeafRunner {
  // sandboxRoot 设 → subprocess-per-leaf under bwrap: 整个 leaf 进程关进只见 worktree 的文件系统视图
  // (cwd=worktree, 主 repo 物理不可见) → 所有命令通道 (bash / 模型幻觉的 shell / 未来工具) + git-show
  // oracle 泄漏一次性全封, 不逐工具打地鼠。前置委托: 下面 in-process 装配 (工具/hook/循环) 全不需要。
  if (opts.sandboxRoot) return createSandboxedLeafRunner(opts);
  const cwd = opts.cwd ?? process.cwd();
  // self_check 的真探测白名单只依赖 cwd (与具体某次 leaf 调用无关), 但它此前算在
  // runOnce 内部 —— 同一个 runner 每次调用都重扫一遍盘 (review 抓到: ~190ms 同步
  // readdirSync, 每次 fan-out 里每条 leaf 都白付一次)。这里按 runner 生命周期惰性算
  // 一次并缓存, 只有真用到 self_check 时才付第一次扫描的成本 (P2c review-fix)。
  let selfCheckAllowlistCache: string[] | undefined;
  const selfCheckAllowlist = (): string[] => {
    if (!selfCheckAllowlistCache) {
      selfCheckAllowlistCache = runtimeAllowlistForRoot(cwd);
      const base = allowlistForRoot(cwd);
      const extra = selfCheckAllowlistCache.filter((b) => !base.includes(b));
      if (extra.length > 0) logger.info({ cwd, extra }, '[agent-leaf] self_check 白名单按仓环境真探测扩充');
    }
    return selfCheckAllowlistCache;
  };
  // 缺省档按**通道**分 (2026-08-10 owner): 同一个默认值在两种计价下经济学相反, 不能共用。
  //   pi 通道 → xhigh (owner 锁, 定价前提 = deepseek flash per-token 便宜档, xhigh 几乎白送;
  //     agent leaf 改文件/工具循环质量优先, 数量少于 inproc fan-out)。inproc leaf 才走 high。
  //   claude-code 订阅通道 → medium (owner 裁: effort 花的是与交互同池的窗口额度, xhigh 默认
  //     会把 flash 时代的定价惯性带进订阅池 —— 与 dream 座位那次「pro 惯性」同族)。
  // 显式 opts.thinkingLevel 恒覆盖两者 (A/B 必须能钉档位)。
  //
  // OMD_AGENT_EFFORT (2026-08-11): 给 A/B 用的**外部旋钮** —— 在此之前两个缺省值写死在代码里,
  // 想量「medium vs high 值不值」就必须改代码再跑, 而「改了代码的两臂」不是同一条件下的两臂
  // (单一变量守不住)。优先级: opts > env > 通道缺省; 词表外的值忽略并 warn (不静默吞掉打错的档,
  // 否则实验会安静地跑成基线臂 —— 那正是最坏的结果: 两臂读数一样而你以为变量动过)。
  const envEffort = process.env.OMD_AGENT_EFFORT?.trim();
  const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'] as const;
  type Effort = (typeof EFFORTS)[number];
  const envLevel = EFFORTS.includes(envEffort as Effort) ? (envEffort as Effort) : undefined;
  if (envEffort && !envLevel) {
    logger.warn({ OMD_AGENT_EFFORT: envEffort, allowed: EFFORTS }, '[omd/agent-leaf] OMD_AGENT_EFFORT 值不在词表内 → 忽略, 走通道缺省');
  }
  // P3 S7 (D-18): 通道缺省只在这里定; 逐调用的档在 runOnce 里经 `resolveLeafThinking` 算 (座位档按调用到达)。
  const CHANNEL_DEFAULT_PI: ThinkingLevel = 'xhigh';
  const CHANNEL_DEFAULT_SDK: ThinkingLevel = 'medium';

  // 工具集: 自有六件 + hashline (开则注入并**排除内置 edit**, 强制行锚定 patch) + 调用方自定。
  // 建一次复用整 runner: hashline 的快照 store 要跨 read/edit 共享, 而 runner 的 cwd 是固定的。
  //
  // SDD S3 碰撞台账会话 (只记不拦): 同一 runner 跨 run/跨节点复用 (MCP 长驻进程), runId 只在调用期
  // 可知 → session 不能烤进工具闭包, 得按调用落。AsyncLocalStorage: 每次调用一个独立 async 上下文
  // (下方 wrapper 用 run() 开, 不用 enterWith —— enterWith 会改到调用方的共享上下文, 并发节点互踩)。
  // per-call 状态 (碰撞台账 session + MCP 授权清单) 落**同一个** ALS: 装配期闭包只挂 getter,
  // 调用期由下方 wrapper 的 run() 写入 —— 并发调用各一个上下文互不串 (enterWith 会串, 见下)。
  const touchSessionStore = new AsyncLocalStorage<LeafCallScope | undefined>();
  const touchOpt = opts.touch; // const 让闭包里的收窄成立 (getter 里引用 touchOpt.session)
  // 装配期事务 (2026-09-01): 下面两个 opts 对象**先具名再交出去** —— commit 检查判的就是
  // "真正交到工具工厂手里的那一份" (见 commitLeafGates)。直接内联字面量的话, 条件 spread
  // 丢了哪个键在外面一点痕迹都没有, 而那正是 2026-08-25 台账缺口的形态。
  const agentToolsOpts: OmdAgentToolsOpts = {
    cwd,
    // 读域闸 (P2d 子修 1, 2026-09-02): DAG leaf 只准读自己被分派到的这份 cwd, 不许绝对路径
    // 逃出去读引擎自身安装目录之类的邻居 (审计信号: 读命中落在 /opt/omd/pkg 而非任务仓)。
    // chat.ts / chat-seat.ts 两条对话位路径**不传这个 opt** —— 那两条路"读半区零摩擦"
    // 是 chat-seat.test.ts:186 钉死的既有行为, 不在本修范围内。
    confineReadsTo: cwd,
    // 逃生口接到 leaf 这条路 (2026-08-14, 夜跑读数第二层问题): 此前 `.omd/config.json` 的
    // `tui.sandbox.allow/deny` 只对 TUI 生效, DAG leaf 吃 DEFAULT_SANDBOX_CONFIG (allow 恒空) ——
    // 误报没有任何赦免出口, leaf 只能撞墙重试 (S-36 同形: 护栏装在一侧, 同名通道绕过全部)。
    // loadSandboxConfig 在 runner 装配期读一次 (cwd 固定); 改 config 后新 run 生效 (thunk 每 run 重建)。
    commandPolicy: loadSandboxConfig(cwd),
    // 写域闸的判据面 (2026-08-21): **thunk 不是值** —— runner 跨 run 复用, 写集只能按调用取,
    // 烤进装配期就会拿上一个节点的写集去判这一个 (同 mcpAllow / touchSession 那条纪律)。
    // 返回 undefined = 闸缺席放行 (没声明 write_set 的 plan); [] = 声明了"什么都不许写"。
    writeAllow: () => touchSessionStore.getStore()?.writeAllow ?? opts.writeAllow,
    // 刀② 撞墙计数 (2026-08-30 闸门三角结): 按调用落进 ALS 的 Map (wrapper 每次调用建一份) ——
    // 与 writeAllow 同一条「thunk 不是值」纪律, 计数烤进装配期会跨节点串账。
    onWriteDenied: (target) => {
      const m = touchSessionStore.getStore()?.writeDenials;
      if (m) m.set(target, (m.get(target) ?? 0) + 1);
    },
    // #262: 这里**无条件**装 getter, 不再按 `opts.touch` 在不在开门。
    // 原来写的是 `...(touchOpt ? { touch: … } : {})` —— 把一个**按调用**的特性锁在了**装配期**
    // 选项后面。而生产装配 (src/mcp/assemble.ts 两处 createAgentLeafRunner) 从不传 opts.touch,
    // 于是引擎按调用发的 `<runId>:<nodeId>` (dag/engine.ts:3777, lister 在 :3031) 无处可落 ——
    // 实测主树库 rows=2924 而 **strict=0 / inferred=0**, agent 工具面一条没进来。
    // getter 返 undefined 时 touchWrite 本来就早返回, 且库是**懒开**的 (agent-tools.ts),
    // 所以无条件装 getter 对「没有 session」那条路零行为变化、零文件产生。
    touch: { session: () => touchSessionStore.getStore()?.session ?? touchOpt?.session },
    // 版本守卫 (2026-09-01): **DAG leaf 这条路默认开**, 不给开关。
    // 理由: #253 之后隔离粒度是 per-run 不是 per-leaf (run-worktree.ts:154 只以 runId 作键),
    // 而 agent 叶默认并发 36 (fleet.ts:40) —— 同一棵 worktree 里的并发兄弟盲盖同一个文件是
    // 常态。想按「这次有没有并发」开关闸是行不通的: 图可以在运行期长节点, **写的那一刻
    // 拿不到「后面还会不会起兄弟」这个事实**, 把判据建在拿不到的事实上等于没有判据。
    // 缺席那一路 (getter 返 undefined) 留给对话位 —— 它们压根不传这个 opt。
    fileObservations: () => touchSessionStore.getStore()?.fileObservations,
    // W2 读账 (2026-09-06): **无条件**装 getter, 按调用从 ALS 取观察者 —— 与 `touch` 同一条 #262 教训
    // (把一个按调用的特性锁在装配期选项后面, 生产那条路就永远取不到值)。
    // 没有观察者时 `observeSafely` 早返回, 四个工具的返回字节逐字不变。
    onToolObserved: (ev) => touchSessionStore.getStore()?.toolObserver?.(ev),
    // P3 S2: `run_acceptance` 的执行体按调用从 ALS 取判据 —— 同一条「thunk 不是值」纪律。
    // 白名单与 self_check 探针同源 (runtimeAllowlistForRoot, P2c);DAG-leaf 这条路 agentToolsOpts 不设
    // `sandbox`(真隔离在进程级 bwrap), 所以这里也不包 —— 与同一叶子的交互 bash 逐字同一条边界 (INV-17)。
    acceptance: () => {
      const sc = touchSessionStore.getStore()?.acceptance;
      if (!sc) return undefined;
      return async () => {
        const baseline = sc.last && sc.last.kind === 'exited' ? sc.last.failSet : null;
        const outcome = await runAcceptance(sc.spec, { cwd, allowlist: selfCheckAllowlist(), baseline });
        sc.rounds += 1;
        sc.last = outcome;
        return { text: renderAcceptanceOutcome(outcome), outcome };
      };
    },
  };
  const baseToolsAll = createOmdAgentTools(agentToolsOpts);
  // P3 S2: `run_acceptance` **不进装配期工具面** —— 零配置叶子 (无 self_check) 的 tools 数组与 system prompt
  // 必须与接线前逐字节相同 (agent-tools.test.ts I-1 基线);它只在本次派了冻结判据时按调用追加 (INV-4)。
  const acceptanceTool = baseToolsAll.find((t) => t.name === 'run_acceptance');
  const baseTools = baseToolsAll.filter((t) => t.name !== 'run_acceptance');
  const hashlineTools = opts.hashlineEdit ? createHashlineCustomTools({ cwd }) : [];
  // 外部 MCP 双 meta-tool (SDD D-8): 零注册 → [] (meta-tools.ts:72-73) → 工具面与 prompt 前缀
  // 与接线前字节零变化 (I-1)。策略按调用求值 (getter 读 ALS): per-run 授权清单非空 → {allow},
  // 否则 deny —— leaf 是执行叶子, 不声明即不授权 (chat 座位的 'allow' 缺省不传染叶子)。
  const mcpToolsOpts: McpClientToolsOpts = {
    cwd,
    session: () => touchSessionStore.getStore()?.session ?? touchOpt?.session,
    policy: () => leafMcpPolicy(touchSessionStore.getStore()?.mcpAllow ?? opts.mcpAllow),
    ...(opts.mcpDeps?.poolDeps ? { poolDeps: opts.mcpDeps.poolDeps } : {}),
    ...(opts.mcpDeps?.ledger ? { ledger: opts.mcpDeps.ledger } : {}),
  };
  const mcpTools = createMcpClientTools(mcpToolsOpts);
  // ── 装配期事务的 commit 点 (2026-09-01) ──────────────────────────────────────
  // 四道闸的接线在这里**当场验一次**: 有一条没接上就抛, runner 不返回 = 这个节点不发布。
  // 位置必须在这儿 —— 两个 opts 对象已交出去、runner 还没造出来, 正是"发布前"那一刻。
  commitLeafGates(touchSessionStore, { agentTools: agentToolsOpts, mcpTools: mcpToolsOpts });

  // S3 read_skill umbrella (D-S3-5): 同一组装段挂 createSkillTools, roots 显式注入含 cwd 项目根, 与 mcpTools 并列进拼装点。
  // 零 skill 不挂 (skill-tool.ts:52 短路), 保证 I-1 零 skill 仓 tools 数组与 S2 基线字节相同。
  // profile.skills: 已解析的岗位档案声明的 skill 名, 仍读取供 agent 按需 read_skill 定位, 不再预载正文进 prompt
  // (O-1 2026-08-11: 撤 skill 正文预载, createSkillTools 不动, 不建并行渲染路径)。
  const skillRoots = opts.skillDeps?.roots ?? defaultSkillRoots(cwd);
  const skillTools = createSkillTools({ roots: skillRoots, ...(opts.skillDeps?.cwd ? { cwd: opts.skillDeps.cwd } : {}) });
  // A2 能力目录 (omd_inspect): leaf 同权纪律 (open-ecosystem §7 —— mcp/skills/ext 不做
  // chat-seat 专属)。恒定单工具, 动态清单全走返回值, 跨 leaf 字节稳定 (不破共享冻结前缀)。
  const inspectTools = createInspectTool({ cwd });
  // 极简工具面按**座位**挑 (owner 2026-08-18 裁), 名单与工具名见文件尾部常量。
  const excluded = new Set(opts.hashlineEdit ? ['edit'] : []);
  const availableTools = [...baseTools, ...hashlineTools, ...mcpTools, ...skillTools, ...inspectTools, ...(opts.customTools ?? [])];
  // profile 按调用到达, tools 也必须按调用求值。undefined = 普通全工具策略; [] = 明确无工具;
  // 非空 = 与 opts.tools 的并集再和真实可用工具取交集。
  const toolsForProfile = (profile: LeafProfile | undefined): AnyOmdTool[] => {
    const profileTools = profile?.tools;
    const allowlist = (opts.tools || profileTools)
      ? new Set([...(opts.tools ?? []), ...(profileTools ?? [])])
      : null;
    return availableTools.filter((t) => !excluded.has(t.name) && (!allowlist || allowlist.has(t.name)));
  };

  // 项目说明书读一次复用整 runner (cwd 固定; 一次 fan-out 里几十个 leaf 不该各读一遍盘)。
  const contextFiles = loadProjectContext(cwd);
  const defaultTools = toolsForProfile(opts.profile);
  const defaultSystemPrompt = buildLeafSystemPrompt({ cwd, tools: defaultTools, contextFiles });

  const runOnce = async (input: AgentLeafInput): Promise<AgentLeafResult> => {
    const { prompt, model: inputModel } = input;
    // profile 按调用传 (input.profile) 优先于构造期 opts.profile (runner 跨节点复用, SDD
    // 2026-08-11-leaf-profile库 D-3): 引擎侧每节点各自 resolveProfile, 不能烤进 runner 装配期。
    // opts.profile 仍是兼容回退 (未经 input 传时的旧调用形状)。
    const leafProfile = input.profile ?? opts.profile;
    // S2 (2026-08-25, 片 2): rung 2 seat-upgrade 派发 —— 引擎侧 `targetSeatCoord` 优先级最高
    // (D-3), 它表示"本调用换脑到这一档"; profile.seat 仍当节点无显式模型时的回退。无 targetSeatCoord
    // 时 → 普通 retry 形状不变 (INV-8)。
    const model = input.targetSeatCoord ?? (inputModel || leafProfile?.seat || '');
    if (!model) {
      throw new Error('[agent-leaf] 无模型: input.model 空且 profile.seat 未设');
    }
    // S2 rung 2 fresh-context 派发审计标记 (D-6): production runner 现状每次调用起新会话
    // (943 行注), 本标记让它在日志里可观测 — 真复用旧消息的 runner 必须在实现侧挡死。
    if (input.freshContext) {
      logger.info(
        { cwd, model, packHash: input.rung2Evidence?.packHash ?? '(no evidence)' },
        '[omd/agent-leaf] rung 2 fresh-context dispatch (同模型 + 新会话 + 证据带全, D-6)',
      );
    }
    const { provider, modelId } = parseModelRef(model);
    // P3 S7 (D-18): 本次调用的 thinking 档, 两个通道分开算 (缺省不同, 不能共用一个数)。
    const thinkingLevel = resolveLeafThinking({ explicit: opts.thinkingLevel, env: envLevel, seat: input.thinkingLevel, channelDefault: CHANNEL_DEFAULT_PI });
    const sdkThinkingLevel = resolveLeafThinking({ explicit: opts.thinkingLevel, env: envLevel, seat: input.thinkingLevel, channelDefault: CHANNEL_DEFAULT_SDK });
    // 座位级极简工具面 (owner 2026-08-18)。显式的 profile.tools / opts.tools 永远胜过它 ——
    // 这只是"没人指定时按座位挑"的缺省。
    // P3 S4 精益面 (D-10 / INV-4): 作用域三条件齐 → 四只手 (+ 条件件 run_acceptance), prompt 走 v2。
    // mcpAllow 非空 → 不进精益 (退回全面, mcp 工具照挂); 座位极简机制排在它后面 (精益优先)。
    // P3 S6b: 按调用下发的整副面 (conductor 节点)。在场 → 三条缺省策略 (精益 / 座位极简 / profile) 全不进,
    // 工具面与 system prompt 都由它定; 缺席 → 下面逐字节老路径。
    const face = input.face;
    const leanScope = !face && opts.leanLeaf === true && !input.profile && !opts.tools && !(input.mcpAllow && input.mcpAllow.length > 0);
    const leanTools = availableTools.filter((t) => LEAN_LEAF_TOOLS.includes(t.name));
    const wantLeanFace = leanScope && leanTools.length > 0;
    if (leanScope && leanTools.length === 0) logger.warn({ model, want: LEAN_LEAF_TOOLS }, '[agent-leaf] 精益工具面一个都没匹配上 → 退回全工具面');
    const seatWantsMinimal =
      !face && !wantLeanFace && !input.profile && !opts.tools && (opts.minimalToolFaceSeats ?? DEFAULT_MINIMAL_TOOLFACE_SEATS).includes(modelId);
    // 全工具面 = 这一发**升级后**要用的那副 (也是其它座位从头到尾用的那副)。
    const fullTools = input.profile ? toolsForProfile(leafProfile) : defaultTools;
    // 极简面**不过 `excluded`**: hashlineEdit 把 `edit` 排掉, 而台账只认 write/edit —— 见
    // MINIMAL_TOOLFACE_TOOLS 的注释。空集 (工具名全对不上) → 退回全工具面并留一行, 不静默跑一个没有手的叶子。
    const minimalTools = availableTools.filter((t) => MINIMAL_TOOLFACE_TOOLS.includes(t.name));
    const wantMinimalFace = seatWantsMinimal && minimalTools.length > 0;
    if (seatWantsMinimal && minimalTools.length === 0) {
      logger.warn({ model, want: MINIMAL_TOOLFACE_TOOLS }, '[agent-leaf] 极简工具面一个都没匹配上 → 退回全工具面');
    }
    // P3 S2 (INV-4): `run_acceptance` 只在本次派了冻结判据时追加到面上 —— 没判据的节点连这个名字都看不到,
    // 不给模型一个「调了就拒」的假手;有判据时极简面与全面都带它 (它就是验收那只手)。
    const withAcceptance = Boolean(input.self_check) && acceptanceTool !== undefined;
    // P3 S6b: face 在场 → 名单 ∩ 内置 ∪ 追加卡。名单里一个都没匹配上不静默: 留一行, 仍按 face 走
    // (conductor 没有手比 conductor 拿到一副别人的手更容易被发现)。
    const faceTools = face
      ? [
          // P3 D-20 (2026-09-03): face.readOnlyShell → 名单里的 bash 包成只读闸 (conductor/readonly-shell.ts), 其它手原样。
          ...availableTools.filter((t) => face.toolNames.includes(t.name)).map((t) => (face.readOnlyShell && t.name === 'bash' ? wrapReadOnlyShell(t, face.onReadOnlyBlocked) : t)),
          ...(face.customTools ?? []),
        ]
      : null;
    if (face && faceTools!.length === 0) logger.warn({ model, want: face.toolNames }, '[agent-leaf] 按调用 face 的工具名单一个都没匹配上 (工具面为空)');
    const perCallToolsBase = faceTools ?? (wantLeanFace ? leanTools : wantMinimalFace ? minimalTools : fullTools);
    const perCallTools = withAcceptance ? [...perCallToolsBase, acceptanceTool!] : perCallToolsBase;
    const perCallSystemPrompt = face
      ? face.systemPrompt
      : wantLeanFace
      ? buildLeafSystemPromptV2({
          writeRoot: cwd,
          ...(input.writeAllow ?? opts.writeAllow ? { writeSet: input.writeAllow ?? opts.writeAllow } : {}),
          ...(input.self_check ? { acceptance: input.self_check } : {}),
          allowlist: selfCheckAllowlist(),
          minutesLeft: input.leafTimeoutMs !== undefined ? Math.max(0, Math.floor(input.leafTimeoutMs / 60_000)) : null,
          contextFiles,
        })
      : input.profile || wantMinimalFace || withAcceptance
        ? buildLeafSystemPrompt({ cwd, tools: perCallTools, contextFiles })
        : defaultSystemPrompt;
    // Claude 订阅通道 (NOTES 2026-08-10): claude-code:* 不在两栈, 循环走 SDK (下方调用点分派)。
    // ⚠ sandboxRoot 模式下 claude CLI 的凭证目录 (~/.claude) 不在 bwrap 视图里 —— 订阅座位
    // 暂不支持沙箱叶, 要用得先把凭证挂载进视图 (二期, 见 NOTES)。
    const isSdkChannel = provider === CLAUDE_SDK_PROVIDER;
    // 坐标解析与单发通道 (`callModel`) 同两级序: **自有 registry 先、pi 目录后** (index.ts:129 同款)。
    // 2026-08-26 bench 终局根因: 此前这里只查 pi 目录, models.json/registerProvider 注册的自定
    // provider (如 bench) 在 leaf 通道恒解析失败 → 所有写文件节点 infra-error 零产出, 四批 patch 全 0。
    const leafResolved = isSdkChannel ? undefined : resolveLeafModel(provider, modelId);
    const piModel = leafResolved?.piModel ?? null;
    if (!piModel && !isSdkChannel) {
      throw new Error(
        `[agent-leaf] 坐标 '${model}' 解析不出模型: provider '${provider}' 既不在自有 registry 也不在 pi-ai 目录。`,
      );
    }
    // prompt 档随**本次 leaf 的模型档**分派 (同 conductor S-P): 强模型只吃 house-rules,
    // 弱模型吃全量脚手架。opts 的两个开关仍是硬关 (纯命令叶可全关)。
    const wantRouting = opts.toolRouting ?? true;
    const wantDiscipline = opts.disciplineCore ?? true;
    const profile = opts.promptProfile ?? 'auto';
    // P3 S6b: face 在场 → 不挂 leaf 脚手架 (conductor 常驻 prompt 自成一体, INV-8 ≤8k 常驻不许被 scaffold 撑破)。
    const scaffold = face
      ? ''
      : agentScaffold({
          profile,
          model,
          toolRouting: wantRouting,
          disciplineCore: wantDiscipline,
        });
    const disciplined = scaffold ? `${scaffold}\n\n${prompt}` : prompt;
    // S2 (2026-08-25, 片 2) rung 2 证据注入 (D-4): fresh-context 丢消息历史不得丢这些显式证据,
    // seat-upgrade 也带一份 (高一档模型没看过档 1 上下文, 缺它就只能凭空白 prompt 干)。缺省 = 普通
    // 调用, 零变化 (INV-8)。
    const withRung2Evidence = input.rung2Evidence
      ? (() => {
          const ev = input.rung2Evidence;
          const diff =
            ev.criterionDiff.kind === 'no-history'
              ? ev.criterionDiff.literal
              : `added=[${ev.criterionDiff.added.join(',')}] removed=[${ev.criterionDiff.removed.join(',')}]`;
          return `${disciplined}\n\n` +
            `[rung 2 证据包 (S2)]\n` +
            `packHash: ${ev.packHash}\n` +
            `failureReason: ${ev.failureReason}\n` +
            `criterionDiff: ${diff}\n` +
            `blockerSignature: ${ev.blockerSignature}\n` +
            `---\n` +
            `请基于上述败因继续修复你的产物。再次结束时不要重复上次同样的做法。`;
        })()
      : disciplined;
    // persona 刻意**不进** promptVersion: 它是每个节点自己的角色设定, 属于"这一发在干什么"
    // 而不是"引擎这一版怎么包装" —— 混进来会让版本逐节点漂, 也就分不了组。
    // profile.persona 与 profile skills 同此边界: 不进 promptVersion, 不建并行 prompt 构建路径。
    const promptVersion = promptVersionOfText(scaffold);
    const combinedPersona = [opts.persona, leafProfile?.persona].filter(Boolean).join('\n\n');
    const routedPrompt = combinedPersona ? `<persona>\n${combinedPersona}\n</persona>\n\n${withRung2Evidence}` : withRung2Evidence;

    // advisor(NOTES 2026-08-10):pi 座内部升档 —— 本次运行注入无参 advisor 工具,prompt 面按
    // 本次工具面重建(创建期缓存的 systemPrompt 不含它)。claude-code 座走官方(settings.advisorModel
    // 在下方 SDK 分支下发),不注内部工具。recorder 挂 emit 链 —— 与 filesTouched 同一条事件流。
    const advisorRecorder = opts.advisor && !isSdkChannel ? createTranscriptRecorder() : null;
    const runTools = advisorRecorder
      ? [...perCallTools, createAdvisorTool({ advisor: opts.advisor!, seatCoord: model, transcript: () => advisorRecorder.serialize() })]
      : perCallTools;
    const runSystemPrompt = advisorRecorder
      ? buildLeafSystemPrompt({ cwd, tools: runTools, contextFiles })
      : perCallSystemPrompt;

    /**
     * 第一轮之后把工具面放开(owner 2026-08-18)。极简面只管**第一轮**:那一轮最贵
     * (整副 schema 都是新的),而后续轮里模型已经知道自己在干什么,少一把 grep 就要多跑几轮 bash。
     *
     * ⚠ 只在 **pi 通道**生效:SDK 通道的工具面写在 `query` 的 options 里,一发定死,中途换不了。
     * 生产名单里的座位(deepseek-*)全走 pi,所以这条限制目前不影响谁 —— 但要是哪天把一个
     * claude-code 座放进名单,它就只有极简面、没有第二轮升级,`escalated` 会一直是 false。
     * ⚠ 换工具面同时要换 systemPrompt(工具清单在里面),两者不同步 = 模型照着 prompt 调不存在的工具。
     *   代价是这一发的前缀在第二轮变一次(多一次 cache 写),之后稳定。
     */
    // P3 S2: 极简面首轮后放开时, 验收那只手不许掉 —— 与 perCallTools 同一条件追加。
    const escalatedBase = withAcceptance ? [...fullTools, acceptanceTool!] : fullTools;
    const escalatedTools = advisorRecorder
      ? [...escalatedBase, createAdvisorTool({ advisor: opts.advisor!, seatCoord: model, transcript: () => advisorRecorder.serialize() })]
      : escalatedBase;
    const escalatedSystemPrompt = buildLeafSystemPrompt({ cwd, tools: escalatedTools, contextFiles });

    // filesTouched 采集 (2026-07-20 修产物闸冤杀): start 记 toolCallId→path 候选,
    // end 且 !isError 才计入 (失败的写不算产物)。
    // 此前 runner 从不填 filesTouched → executor-dag 产物闸把真交付的文件节点全判 failed (恒空 = "谎报完工")。
    const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'hashline_edit']);
    // D-12 读采集: **与写监听同一形状** (start 记候选 → end 且 !isError 才计入)。
    // 词表与 `agent-tools.ts` 的工具集对齐: 单文件读的入口只有 read 与 hashline_read 两个。
    // `grep`/`ls` 刻意不收: 它们是**检索**不是消费 (一次 grep 命中十个文件不等于依赖那十个),
    // 收进来会把 artifact-lint 淹在噪声里。`bash` 里的 cat 收不到 —— 与写侧漏 bash 重定向同一条边界。
    const FILE_READ_TOOLS = new Set(['read', 'hashline_read']);
    const touched = new Set<string>();
    const readPaths = new Set<string>();
    // watchdog 时间线采集 (SDD S1): 相对 startedAt 的毫秒偏移, 升序。touchTimelineMs 只在
    // filesTouched **新增路径**时追加一条 (重复路径不追加); toolTimelineMs 每次 tool_execution_start
    // 都追加一条。startedAt 声明在下方, 但此处只是采集函数体 (运行时才引用), 无 TDZ 问题。
    const touchTimelineMs: number[] = [];
    const toolTimelineMs: number[] = [];
    // bash 痕迹采集 (2026-08-05)。配对逻辑抽成纯件 (见 createShellRunCollector) —— 它是这条链上
    // 唯一有判断的地方 (缺退出码不许编 0 · 闸拒的命令也要记), 留在闭包里就只能"接上了"而验不了。
    const shell = createShellRunCollector();
    // §8.5 效果指标: 写**之前**先按住内容, 写完再比 —— 「写完了」和「写变了」是两个数。
    // 快照只在 start 时取一次: end 时原文已经没了, 事后补不出来 (这是为什么它必须挂在这条链上,
    // 而不能做成一个跑完之后扫一遍盘的脚本)。
    const writeEffects: FileWriteEffect[] = [];
    // 工具调用序列 (2026-08-16)。**顺序本身就是判据** —— 见 ToolStep 的注:
    // 「stale 被拒之后有没有重新接地」这句话只有在有序的序列上才判得了。
    // 无界追加, 出口处再截头尾 (截断口径与 failureExcerpt 一致, 截了多少显式报)。
    const toolSteps: ToolStep[] = [];
    const stepByCall = new Map<string, ToolStep>();
    const snapByCall = new Map<string, Map<string, FileSnapshot>>();
    let toolCalls = 0; // 工具调用计数 (prompt 档的路由效率读数, 见 AgentLeafResult.toolCalls)。
    let llmCalls = 0; // LLM 调用计数 (R-1): pi 腿数 turn_end (一轮 = 一次模型响应); SDK 腿由 runSdkAgentLoop 去重后给。
    let pendingTools = 0; // 在飞工具数 —— >0 时看门狗不计时 (跑 10 分钟的 bun test 是正当工作)
    let streamedChars = 0; // 已流出的正文字节数 (只作读数, 不再当判据)
    // toolCallId → 候选写路径 (可多: hashline_edit 一个 patch 多 section 多文件)。end 且 !isError 才计入。
    const pathByCall = new Map<string, string[]>();
    const readByCall = new Map<string, string>();

    // drift 检测 (默认开): **每个 leaf 一份** ring/flag —— 跨 leaf 复用会把别人的工具序列算进自己的环。
    const drift =
      opts.driftDetector === false
        ? null
        : createDriftTracker(
            typeof opts.driftDetector === 'object'
              ? opts.driftDetector
              : {
                  // S1 spin-route 档 1 触发点: drift 的 onSpinning 边沿事件 (与现 drift 注入的
                  // spin-checklist 同一把尺 —— 沿用现尺不新造)。handler 内: 构证据包 →
                  // 同包拒注 (I-2) / SDK 旁路 (I-6) / pi 注入。opts.spinRoute.trigger 是
                  // 测试观察面 —— 同步触发后**仍**走 handleSpinRouteTrigger 真逻辑;生产不传。
                  onSpinning: (info: { sig: string; sameCount: number }) => {
                    if (!spinRouteEnabled) return;
                    if (opts.spinRoute !== false) {
                      opts.spinRoute?.trigger?.(info);
                    }
                    handleSpinRouteTrigger(info);
                  },
                },
          );
    // L0 写后即验 (2026-08-16): **每个 leaf 一份**, 理由同 drift —— 跨 leaf 复用会把别人写坏的
    // 文件算到自己头上。只提醒不判定, 节点末那道硬闸一个字没动 (见 write-parse-gate 文件头)。
    //
    // ⚠ **只在 pi 通道**: 注入的出口是 `transformContext`, 而 SDK 通道没有那个钩子
    // (同一段注里"上下文压缩/轮间停不做 (SDK 自管)"那条边界)。这里显式判 null 而不是
    // 让它在 SDK 路上白攒一堆永远取不走的待注项 —— 那样 `parseNudges` 会恒为 0,
    // 而"这个通道没接"与"接了但没触发"在读数上就分不开了 (缺席 ≠ 0)。
    // 两个通道**共用节点末那道硬闸** (判在引擎侧 filesTouched 上), 所以 SDK 路没有变弱, 只是没变快。
    const parseFeedback = isSdkChannel ? null : createParseFeedback();
    // 空转熔断 (2026-08-14): 非 null = 已熔断, 值是理由原文。controller/startedAt 声明在下方,
    // 但此处只是采集函数体 (运行时才引用), 无 TDZ 问题 —— 同 touchTimelineMs 那条注。
    let spinFused: string | null = null;

    const emit = (e: AgentEvent): void => {
      // **进展信号**: 任何事件都算"它还在动" —— 包括 `thinking_delta` (模型在推理)。
      // 老判据只数 text_delta, 于是"在想"被读成"没反应"; effort 提到 max 之后那是必然误杀。
      noteProgress();
      advisorRecorder?.note(e);
      if (e.type === 'turn_end') llmCalls++; // SDK 腿不发 turn_end (只发 message_end), 不会双计。
      if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
        streamedChars += e.assistantMessageEvent.delta.length;
      } else if (e.type === 'tool_execution_start') {
        toolCalls++;
        pendingTools++;
        toolTimelineMs.push(now() - startedAt);
        drift?.note(e.toolName, e.args);
        // 熔断闸: 软注入 (takeInjection) 之后还在加深的空转 → 硬停, 走与超时同一条优雅停路
        // (SDK 通道 tolerateAbort 返已累积; pi 通道 signal 停轮)。已写盘产物保留, 节点判 spin-fused。
        if (drift && spinFused === null) {
          const trip = drift.fuseTripped();
          if (trip) {
            spinFused = trip;
            logger.warn({ toolCalls, trip }, '[agent-leaf] 空转熔断 → 硬停循环 (fuse)');
            controller.abort();
          }
        }
        const args = (e.args ?? {}) as { path?: unknown; patch?: unknown };
        // 序列采集: **每一次**工具调用都记一步 (不只读写工具) —— 中间夹着的 bash/grep 正是
        // 「stale 被拒之后到底干了什么」的一部分, 只记读写会把序列剪出一个假的因果。
        {
          const step: ToolStep = { tool: e.toolName };
          const p =
            e.toolName === 'hashline_edit' && typeof args.patch === 'string'
              ? hashlinePatchPaths(args.patch)[0]
              : typeof args.path === 'string' && args.path.trim()
                ? args.path
                : undefined;
          // 路径归一 (2026-09-06): 模型给的绝对路径落在 cwd 之内就记成相对路径, 与写集声明 / output_path /
          // diff 证据同一套写法 —— 否则写集对账逐字比不上, 判官卷面出现「产物不存在」的假事实 (见 repo-path.ts)。
          if (p) step.path = repoRelativePath(cwd, p);
          toolSteps.push(step);
          stepByCall.set(e.toolCallId, step);
        }
        if (FILE_WRITE_TOOLS.has(e.toolName)) {
          // hashline_edit 路径嵌在 patch 头 (`¶PATH#TAG`), 不是顶层 path —— 必须解析 patch, 否则漏记 → 假 empty-done。
          const paths = (
            e.toolName === 'hashline_edit' && typeof args.patch === 'string'
              ? hashlinePatchPaths(args.patch)
              : typeof args.path === 'string' && args.path.trim()
                ? [args.path]
                : []
          ).map((x) => repoRelativePath(cwd, x));
          if (paths.length) {
            pathByCall.set(e.toolCallId, paths);
            // 写前快照。读盘失败 (权限 / 目录 / 竞态) 一律当"此前不存在" —— 本采集 fail-open,
            // 它是读数不是闸, 绝不能因为量不出来就把一次真的写判没了。
            const snaps = new Map<string, FileSnapshot>();
            for (const p of paths) snaps.set(p, snapshotFile(cwd, p));
            snapByCall.set(e.toolCallId, snaps);
          }
        } else if (FILE_READ_TOOLS.has(e.toolName)) {
          if (typeof args.path === 'string' && args.path.trim()) readByCall.set(e.toolCallId, repoRelativePath(cwd, args.path));
        }
        // W4 勘察步预算 (2026-09-06): 只对**持卡节点** (customTools 非空 = conductor) 生效。
        // 连读到预算还没派活 → 经 pendingGrindAdvice 注入一次派活提醒; **不拒任何调用**, 只注一次。
        // 缓冲被 wrapup/advisor 占着时不抢 (高档语义优先, 同 produce-by 那条)。
        if (SURVEY_READONLY_TOOLS.has(e.toolName)) readonlySurveySteps++;
        else readonlySurveySteps = 0;
        if (
          surveyBudgetHit(
            {
              hasCards: (face?.customTools?.length ?? 0) > 0,
              readonlySteps: readonlySurveySteps,
              dispatches: face?.progress ? face.progress() : 0,
              filesTouchedCount: touched.size,
              fired: surveyNudgeFiredAtStep !== null,
            },
            surveyStepBudget,
          )
        ) {
          surveyNudgeFiredAtStep = readonlySurveySteps;
          if (!pendingGrindAdvice) pendingGrindAdvice = surveyBudgetInstruction(readonlySurveySteps);
          logger.warn(
            { cwd, steps: readonlySurveySteps, budget: surveyStepBudget, toolCalls },
            '[agent-leaf] W4 勘察步预算命中 → 注入一次派活提醒 (不拒调用, 整个节点只注一次)',
          );
        }
        shell.note(e);
      } else if (e.type === 'tool_execution_end') {
        pendingTools = Math.max(0, pendingTools - 1);
        shell.note(e); // ⚠ 在 `!isError` 之外记 —— 理由见 createShellRunCollector 的注
        // 序列回填也在 `!isError` 之外 —— 报错的那一步同样是序列的一部分 (而且往往是最要紧的那步)。
        const step = stepByCall.get(e.toolCallId);
        if (step && e.isError) step.error = true;
        if (!e.isError) {
          const ps = pathByCall.get(e.toolCallId);
          if (ps) {
            const snaps = snapByCall.get(e.toolCallId);
            // L0 写后即验: 只判**真改变了内容**的那些 (noop 写盘上逐字没动 → 不会有新损坏,
            // 而它恰恰是 hashline stale 的指纹, 那是另一条链的活)。逐条判据在下面的循环里攒。
            const changed: string[] = [];
            for (const p of ps) {
              if (!touched.has(p)) {
                const t = now();
                lastTouchGrowthAtMs = t;
                touchTimelineMs.push(t - startedAt);
              }
              touched.add(p);
              const before = snaps?.get(p);
              if (!before) continue; // 没取到快照 (理论上不会) → 不编一个效果数出来
              const effect = diffWriteEffect(p, before, snapshotFile(cwd, p));
              writeEffects.push(effect);
              if (!effect.noop) changed.push(p);
              // 把 noop 回填到序列那一步。**这一位就是 hashline stale 被拒的指纹**:
              // 工具返回成功 (fail-soft 返文本), 而盘上逐字没动。多路径 patch 只要有一条真变了
              // 就不算 noop —— 判据是"这次调用有没有改变任何东西"。
              if (step) step.noop = (step.noop ?? true) && effect.noop;
            }
            // fail-open 不吞证据: 这是提醒面, 绝不能因为解析器抛了个没想到的错就把一次真的写带塌。
            try {
              if (changed.length) parseFeedback?.note(changed, cwd);
            } catch (err) {
              logger.warn({ err: (err as Error).message }, '[agent-leaf] 写后即验 (L0 提醒) 抛错 (已吞, 只丢这一次提醒)');
            }
          }
          // 读失败 (文件不存在等) 不算读过 —— 同"失败的写不算产物"。
          const rp = readByCall.get(e.toolCallId);
          if (rp) readPaths.add(rp);
        }
      }
      // debug 事件汇 (opt-in): 转发全部事件抓 transcript。回调抛错不许打断循环。
      if (opts.onEvent) {
        try {
          opts.onEvent(e as unknown as { type: string; [k: string]: unknown });
        } catch (err) {
          logger.warn({ err: (err as Error).message }, '[agent-leaf] onEvent 回调抛错 (已吞, 不打断循环)');
        }
      }
      // 调用期事件汇 (SDD D-8, 2026-08-11): 转发**内部工具事件**给本次调用的 input.onEvent ——
      // 引擎侧据此转成 DAG 的 progress 事件。刻意只转发工具事件: text_delta 是正文流, 不进
      // DAG 事件 (D-10); 转发面与采集面同一条 emit 链, 不另开旁路 (两处各写一份必漂)。
      if (input.onEvent && (e.type === 'tool_execution_start' || e.type === 'tool_execution_end')) {
        try {
          input.onEvent(e);
        } catch (err) {
          logger.warn({ err: (err as Error).message }, '[agent-leaf] input.onEvent 回调抛错 (已吞, 不打断循环)');
        }
      }
    };

    // ── 有界性 (两级) ────────────────────────────────────────────────────────────
    // ① shouldStopAfterTurn: 超时/上下文预算到了 → 在**轮之间**优雅停, 已写盘的产物完整保留。
    // ② AbortSignal: 单轮自己跑过头 (provider 挂着不返) 的硬兜底。
    // 此前这两件事都只能靠外部秒表 + SIGKILL —— 高层 prompt() 既没有 maxTurns 也不收 signal。
    // P2e (2026-09-02): 有效超时 = 两个数取紧的那个 —— `input.leafTimeoutMs`(引擎按目标
    // 剩余预算算的每次调用值) 与 `opts.leafTimeoutMs ?? 3_600_000`(构造期固定兜底)。
    // 只在这里 (唯一同时看得到两个数的地方) 收紧, 不放宽: 调用方就算给一个很大的
    // `input.leafTimeoutMs`, 也升不过 opts 那道构造期上限。
    const timeoutMs = Math.min(input.leafTimeoutMs ?? Number.POSITIVE_INFINITY, opts.leafTimeoutMs ?? 3_600_000);
    const idleTimeoutMs = opts.idleTimeoutMs ?? 180_000;
    const budgetRatio = opts.contextBudgetRatio && opts.contextBudgetRatio > 0 ? opts.contextBudgetRatio : 0.85;
    const wantCompaction = opts.compaction !== false;
    const keepRecentTokens = opts.compactionKeepRecentTokens ?? 20_000;
    let compactions = 0;
    /**
     * **压缩当轮, provider 用量这个锚是失效的** (2026-08-01 实测抓到, 差点让整个压缩变成空转)。
     *
     * `estimateContextTokens` 优先拿**最后一条 assistant 自报的 usage** 当基数 —— 那是最准的,
     * 因为它是 provider 真数出来的。但压缩删掉的是它**前面**的消息, 而那条 assistant 对象没变、
     * 它自报的 usage 仍然是压缩前那个大数。于是压完再问一次"还超不超", 答案永远是"超" ——
     * 压缩照跑、照付钱, 然后照样停。实测就是这样: `before 3112 → after 3112`, msgs 5→4。
     *
     * 锚只失效**一轮**: 下一次 provider 应答会带来新的 usage。所以这里用"置位-消费"而不是长期开关。
     */
    let usageAnchorStale = false;
    const pureEstimate = (msgs: AgentMessage[]): number =>
      msgs.reduce((n, msg) => n + estimateTokens(msg), 0);
    const controller = new AbortController();
    // S3 grind 软看门狗时钟 (#124): 看门狗家族 (startedAt / 两条时间线 / 轮间超时判据) 共读
    // 这一个钟; deps.now 是测试注入缝 (生产 = Date.now)。startedAt 改读注入钟后, 下方
    // 仍用 Date.now() 的地方必须一起换 —— 各读各的钟会让注入时钟的测试读到两个「现在」。
    const now = opts.deps?.now ?? Date.now;
    const startedAt = now();
    let timedOut = false;
    let stalled = false;
    let contextExhausted = false;
    // S3 grind advisor 软看门狗状态: advisorFiredAt 恒写 (null = 没触发), 触发后保持非空不重试。
    let advisorFiredAt: number | null = null;
    let advisorAdvice: string | undefined;
    // S3 grind 软看门狗状态: touched 新增的最近时刻 (无新增 = startedAt) —— 停滞判据读它;
    // pendingGrindAdvice 是一次性注入缓冲 (takeGrindAdvice 消费, pi transformContext 出口 ——
    // SDK 通道无该钩子, 建议只落 watchdog 记录, 同 parseFeedback 那条通道边界)。
    let lastTouchGrowthAtMs = startedAt;
    /** face 上一次自报的进展读数 (见 LeafFace.progress);单调不减, 增长即推进停滞钟。 */
    let lastFaceProgress = face?.progress ? face.progress() : 0;
    let pendingGrindAdvice: string | undefined;
    // #178 produce-by 状态: null = 没触发 (量过且没发生, 恒写口径同 advisorFiredAt); 至多 1 次。
    let produceByFiredAt: number | null = null;
    // W4 勘察步预算状态 (2026-09-06): 连续只读步数 (非只读工具清零) + 提醒过没有 (null = 没提醒, 至多 1 次)。
    // 阈值解析一次 —— 谓词保持纯的, 不在事件流里反复读环境变量。
    let readonlySurveySteps = 0;
    let surveyNudgeFiredAtStep: number | null = null;
    const surveyStepBudget = surveyBudgetSteps();
    // S1 spin-route 档 1 (2026-08-25, 片 2): 命中空转口径 → 注入一次证据包
    // (D-1: 每叶至多一次; D-2/3: 四件套叠加 + 具名判据; D-5: 入账 additive 数组)。
    //
    // 触发 = drift 的 `onSpinning` 边沿事件 (与现 drift 注入的 spin-checklist 同一把尺, **不新造**)。
    // 关停: `opts.spinRoute === false` 或 env `OMD_SPIN_ROUTE=0` 任一关即旁路 (INV-3-3 同款)。
    // 注入面: pi 通道走 `pendingGrindAdvice` 同款缓冲 (一次性, takeGrindAdvice 消费);
    //         SDK 通道无 transformContext → 命中时打 `SPIN_ROUTE_SDK_SKIP_LOG` 一次, 不注入, 现状行为不变。
    const spinRouteEnabled =
      opts.spinRoute !== false &&
      spinRouteEnvEnabled() &&
      (opts.spinRoute === undefined || opts.spinRoute.enabled !== false);
    let spinRouteInjected = false; // 是否真注了一次 (与「记了 sdk-bypass」严格分开)
    let spinRouteFiredAt: number | null = null; // 注入瞬间 (now() 时刻)
    let lastSpinPackHash: string | null = null; // 拒注判据: 同包再触 = 不注 (I-2)
    let spinRouteTouchedAtTrigger = 0; // 注入瞬间的 touched 大小 (供 judgeRungOutcome 判增长)
    let spinRouteFailSetAtTrigger: readonly string[] | null = null; // 注入瞬间的 (fail) 集
    let currentFailSet: readonly string[] | null = null; // 滚动 (fail) 集, self_check 退出时填充
    const spinRouteEntries: { rung: 1; packHash: string; outcome: SpinRouteEventOutcome; at: number }[] = [];
    let spinRouteBypassLogged = false; // SDK 通道每叶只打一次 skip log (不打 N 次)
    // 注入面: pi 通道走一次性缓冲 (takeSpinRouteAdvice 消费, transformContext 出口)。与
    // pendingGrindAdvice 同款形态 —— 都是"检出 → 注一次", 都不写回 context。
    let pendingSpinRouteAdvice: string | undefined;
    const takeSpinRouteAdvice = (): string | undefined => {
      const advice = pendingSpinRouteAdvice;
      pendingSpinRouteAdvice = undefined;
      return advice;
    };
    /** 把档 1 证据包格式化成 follow-up user 消息 (与 formatSelfCheckFollowUp 同形: 不写回 context, 仅这一发)。 */
    function formatSpinEvidencePackMessage(pack: SpinEvidencePack): string {
      const diff =
        pack.criteriaDiff.kind === 'no-history'
          ? pack.criteriaDiff.literal
          : `added=[${pack.criteriaDiff.added.join(',')}] removed=[${pack.criteriaDiff.removed.join(',')}]`;
      return (
        `[spin-route 档 1 证据包 (注入面, pi 通道)]\n` +
        `packHash: ${pack.packHash}\n` +
        `failSig: ${pack.failSig}\n` +
        `sameCount: ${pack.sameCount ?? '(未提供)'}\n` +
        `criteriaDiff: ${diff}\n` +
        `watchdogFinding: ${pack.watchdogFinding}\n` +
        `---\n` +
        `诊断: ${pack.advisorLines[0]}\n` +
        `下一步: ${pack.advisorLines[1]}\n` +
        `---\n` +
        `请基于上述败因继续修复你的产物。再次结束时不要重复上次同样的做法。`
      );
    }
    /** 路由事件入账 + observation 出 (D-5): opts.onEvent 开放类型 `{type:string; ...}` 与 grind/produce-by logger.warn 同路,
     * 引擎按 `type` 字段分发; 测试可直接 observe 注入面。nodeId 取自 input.touchSession (AgentLeafInput
     * 唯一的 runId+节点维度稳定 id, leaf-runners.ts:19 注释: 引擎侧传 `${runId}:${nodeId}`)。*/
    const recordSpinRouteEvent = (
      outcome: SpinRouteEventOutcome,
      packHash: string,
    ): void => {
      const atMs = now() - startedAt;
      spinRouteEntries.push({ rung: 1, packHash, outcome, at: atMs });
      try {
        opts.onEvent?.({
          type: SPIN_ROUTE_OBSERVATION_KIND,
          rung: 1,
          outcome,
          packHash,
          at: atMs,
          nodeId: input.touchSession ?? 'unknown',
        });
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          '[agent-leaf] spin-route observation 回调抛错 (已吞, 不打断循环)',
        );
      }
    };
    /**
     * S1 spin-route 档 1 触发处理器 (D-1/D-2/D-3/D-5 一站式):
     *   ① 已注过一次 → judgeRungOutcome 判成/败 + 记录 + observation, 不二次注入 (D-1);
     *   ② 未注 + 与上包逐字同 → 拒注 + 记 fail + observation, 字节不进 buffer (I-2);
     *   ③ 未注 + SDK 通道 → 打 SPIN_ROUTE_SDK_SKIP_LOG 一次 + 记 sdk-bypass + observation, 零注入 (I-6);
     *   ④ 未注 + pi 通道 → 构包 → pendingSpinRouteAdvice 一次性缓冲 + 记 injected + observation, leaf 原地继续。
     * advisor 两行诊断: 由调用面提供 (caller = agent-leaf 内同闭包, builder 不调模型); 若 advisorAdvice
     * 尚未到位 (drift 触发在 tool_execution_start, advisor 一般在 end-of-turn) → 占位两行 (I-7 字面从严)。
     */
    const handleSpinRouteTrigger = (info: { sig: string; sameCount: number }): void => {
      // advisor 两行诊断: 若现成 advisorAdvice 已分两行, 透传; 否则占位字面 (advisor 待发)。
      const advisorLines: AdvisorLines = advisorAdvice
        ? (() => {
            const parts = advisorAdvice.split('\n').map((s) => s.trim()).filter(Boolean);
            if (parts.length >= 2) return [parts[0]!, parts[1]!] as AdvisorLines;
            if (parts.length === 1) return [parts[0]!, '(无下一步)'] as AdvisorLines;
            return ['(advisor 待发)', '(待发)'] as AdvisorLines;
          })()
        : (['(advisor 待发)', '(参见 grind 看门狗记录)'] as AdvisorLines);
      const watchdogFinding = `[omd/drift] spinning detected sig=${info.sig} sameCount=${info.sameCount}`;
      const pack = buildSpinEvidencePack({
        failSig: info.sig,
        sameCount: info.sameCount,
        failSetBefore: spinRouteInjected ? spinRouteFailSetAtTrigger : currentFailSet,
        failSetNow: currentFailSet,
        watchdogFinding,
        advisorLines,
      });
      // ① 已注过一次 → 判成/败, 不再注入 (D-1: 每叶至多一次)
      if (spinRouteInjected) {
        const verdict = judgeRungOutcome({
          touchedBefore: spinRouteTouchedAtTrigger,
          touchedNow: touched.size,
          failSetBefore: spinRouteFailSetAtTrigger,
          failSetNow: currentFailSet,
        });
        recordSpinRouteEvent(verdict, pack.packHash);
        logger.info(
          {
            cwd,
            verdict,
            touchedDelta: touched.size - spinRouteTouchedAtTrigger,
            packHash: pack.packHash,
          },
          '[agent-leaf] spin-route 档 1 二次命中 → 判成/判败, 不二次注入 (S1 边界, 后续走现状熔断 / S2 档 2)',
        );
        return;
      }
      // ② 与上包逐字同 → 拒注 (I-2), 字节不进 buffer
      if (lastSpinPackHash !== null && samePack({ packHash: lastSpinPackHash }, pack)) {
        recordSpinRouteEvent('fail', pack.packHash);
        logger.warn(
          { cwd, packHash: pack.packHash },
          '[agent-leaf] spin-route 档 1 拒注: 与上次证据包逐字相同 (I-2 重复注入 = 白烧)',
        );
        return;
      }
      // ③ SDK 通道 → 响亮旁路, 不注入
      if (isSdkChannel) {
        if (!spinRouteBypassLogged) {
          logger.warn({ cwd, sig: info.sig, sameCount: info.sameCount }, SPIN_ROUTE_SDK_SKIP_LOG);
          spinRouteBypassLogged = true;
        }
        recordSpinRouteEvent('sdk-bypass', '');
        return;
      }
      // ④ pi 通道 → 真注入一次 (D-1 至多一次)
      spinRouteInjected = true;
      spinRouteFiredAt = now();
      spinRouteTouchedAtTrigger = touched.size;
      spinRouteFailSetAtTrigger = currentFailSet;
      lastSpinPackHash = pack.packHash;
      pendingSpinRouteAdvice = formatSpinEvidencePackMessage(pack);
      recordSpinRouteEvent('injected', pack.packHash);
      logger.info(
        {
          cwd,
          sig: info.sig,
          sameCount: info.sameCount,
          packHash: pack.packHash,
        },
        '[agent-leaf] spin-route 档 1 触发 → 证据包注入 (transformContext 出口消费)',
      );
    };
    /** opts.spinRoute.trigger 测试注入面 —— 生产 opts.spinRoute 缺省无该字段, 走真 drift.onSpinning 边沿。 */
    const spinRouteTrigger = (info: { sig: string; sameCount: number }): void => handleSpinRouteTrigger(info);
    // grind 三档阶梯状态 (2026-08-17, #146): wrapupFiredAt 恒写 (null = 没触发, 同
    // advisorFiredAt 那条「量过且没发生」口径); abortedByGrind 恒写 boolean (false = 量过且没发生,
    // 同 stalled/timedOut 口径 —— INV-5)。
    let wrapupFiredAt: number | null = null;
    let abortedByGrind = false;
    const hardTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : null;
    // 进展看门狗: **滚动**窗口 (每来一个事件就重置), 不是启动时看一眼。
    // 工具在飞 → 不判死, 只把窗口往后推 (工具执行期间本来就没有事件)。
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = (): void => {
      if (idleTimeoutMs <= 0) return;
      // **先清后设**: `idleTimer` 只存得下一个句柄, 少这一行, 任何重复 arm 都会留下一个
      // 无人持有、永不 clear 的孤儿 timer —— 它在 startedAt + idleTimeoutMs 处无条件开刀,
      // 与"上次活动在什么时候"完全无关 (run 14b49f79 四节点全灭的根因, 见
      // leaf-watchdog-rolling.test.ts 的读数)。clear 放在这里而不是各调用点: 调用点会被人加。
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (pendingTools > 0) {
          armIdle(); // 有工具在跑 = 在干活, 续窗口
          return;
        }
        stalled = true;
        controller.abort();
      }, idleTimeoutMs);
    };
    // S3 grind 三档阶梯 (2026-08-17, #124 + #146): 与 armIdle/hardTimer 同一处挂闸 ——
    // nextGrindAction 纯谓词判档 (advisor→wrapup→abort), 各至多一次, 不开新轮询。advisor 档
    // 双条件 (墙钟 > GRIND_WALL_MS 且 GRIND_STALL_MS 内 touched 零新增) → 异步发指导注下一回合;
    // wrapup 档 = advisor 后再停滞 GRIND_WRAPUP_MS → 注入强制收尾指令 (与 advisor 同通道
    // pendingGrindAdvice); abort 档 = wrapup 后再停滞 GRIND_ABORT_MS → controller.abort() +
    // spinFused 写三档时间线 (failureKind 'spin-fused', 同 drift 熔断那条优雅停路)。
    // 失败只吞不截停的纪律仅适用 advisor 档 (软介入语义); wrapup/abort 是硬动作。
    //
    // wrap-up 注入文本 (与 advisor 走同一条 transformContext user-msg 通道):「立即停止继续尝试,
    // 用 ≤2 个工具调用收尾: 把当前已完成部分写盘/汇报, 说明未完成项与原因, 然后结束」。
    const GRIND_WRAPUP_INSTRUCTION =
      '「强制收尾指令」: 你已研磨超过一级 advisor + 二级 wrap-up 阈值仍未推进。立即停止继续尝试, ' +
      '用 ≤2 个工具调用收尾: 把当前已完成部分写盘/汇报, 说明未完成项与原因, 然后结束。' +
      '不要继续尝试新的修改路径 —— 直接交还不完整结果。';
    const askAdvisor = opts.deps?.askAdvisor ?? (async (ctx: GrindAdvisorContext): Promise<string> => {
      const seat = resolveRoleModelConfigured('escalation');
      const res = await callModel({
        model: seat.model,
        messages: [
          { role: 'system', content: GRIND_ADVISOR_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `worker goal: ${ctx.goal}\ncwd: ${ctx.cwd}\n` +
              `wall: ${ctx.nowMs - ctx.startedAtMs}ms, stall: ${ctx.nowMs - ctx.lastTouchGrowthAtMs}ms`,
          },
        ],
        thinkingLevel: 'high',
      });
      return res.text;
    });
    const takeGrindAdvice = (): string | undefined => {
      const advice = pendingGrindAdvice;
      pendingGrindAdvice = undefined;
      return advice;
    };
    // 三档统一闸: nextGrindAction 判档 → 各档就地处理。advisor 档异步发指导, wrapup 档同步
    // 塞 user-msg 进下回合, abort 档同步 controller.abort() + spinFused 写时间线 (节点判
    // spin-fused, 失败正文带 advisor/wrapup/abort 三档各自的时刻 + stall)。
    const maybeFireGrindEscalation = (): void => {
      const nowMs = now();
      // 按调用 face 自报的进展 (LeafFace.progress) —— 缺席 = 叶子口径, 停滞钟只认写入新文件路径。
      // conductor 手里没有写文件的工具 (readOnlyShell + 派工卡), 那口钟对它恒不走 → 三档退化成
      // 无条件的 25 分钟铡刀。换尺子不换闸: 谁的进展谁报, 熔断照常有牙。判据见 LeafFace.progress。
      if (face?.progress) {
        const p = face.progress();
        if (p > lastFaceProgress) {
          lastFaceProgress = p;
          lastTouchGrowthAtMs = nowMs;
        }
      }
      // #178 produce-by: 与 grind 阶梯正交, 先判 (它抓"忙着读从没写", grind 抓"卡住不动")。
      // 不清 pendingGrindAdvice 里已有的 wrapup/advisor 指令 —— 高档语义优先, 缓冲空才占用。
      if (
        shouldFireProduceBy({
          expectsArtifact: !!input.expectsArtifactPath,
          nowMs,
          startedAtMs: startedAt,
          filesTouchedCount: touched.size,
          produceByFiredAt,
        })
      ) {
        produceByFiredAt = nowMs;
        if (!pendingGrindAdvice) pendingGrindAdvice = produceByInstruction(input.expectsArtifactPath!);
        logger.warn(
          { cwd, wallMs: nowMs - startedAt, artifactPath: input.expectsArtifactPath },
          '[agent-leaf] #178 produce-by 命中 → 注入催产指令 (勘探超预算仍零写)',
        );
      }
      const action = nextGrindAction({
        startedAtMs: startedAt,
        nowMs,
        lastTouchGrowthAtMs,
        advisorFiredAt,
        wrapupFiredAt,
      });
      if (action === null) return;
      if (action === 'advisor') {
        advisorFiredAt = nowMs;
        logger.warn(
          { cwd, goal: prompt, wallMs: nowMs - startedAt, stallMs: nowMs - lastTouchGrowthAtMs },
          '[agent-leaf] grind 一档命中 → escalation advisor 软介入 (不截停)',
        );
        askAdvisor({ startedAtMs: startedAt, nowMs, lastTouchGrowthAtMs, cwd, goal: prompt })
          .then((advice) => {
            const trimmed = typeof advice === 'string' ? advice.trim() : '';
            if (!trimmed) return;
            advisorAdvice = trimmed;
            pendingGrindAdvice = trimmed;
          })
          .catch((err: unknown) => {
            logger.warn(
              { err: (err as Error)?.message ?? String(err) },
              '[agent-leaf] grind advisor 调用失败 (已吞, 软介入不截停)',
            );
          });
        return;
      }
      if (action === 'wrapup') {
        wrapupFiredAt = nowMs;
        pendingGrindAdvice = GRIND_WRAPUP_INSTRUCTION;
        logger.warn(
          { cwd, goal: prompt, sinceAdvisorMs: nowMs - (advisorFiredAt ?? nowMs), stallMs: nowMs - lastTouchGrowthAtMs },
          '[agent-leaf] grind 二档命中 → 注入强制收尾指令 (不截停, 留给模型两轮收尾机会)',
        );
        return;
      }
      // action === 'abort': 三档全过且仍停滞 → 硬截停 + spin-fused 标记。失败正文含三级时间线,
      // 供 escalation 的定向重派辨别这是 advisor/wrapup 都没救回来的真研磨 (而非 drift 熔断
      // 那条同样判 spin-fused 但原因不同的路)。
      abortedByGrind = true;
      const sinceStart = nowMs - startedAt;
      const stallAtAbort = nowMs - lastTouchGrowthAtMs;
      const advisorAt = advisorFiredAt !== null ? advisorFiredAt - startedAt : null;
      const wrapupAt = wrapupFiredAt !== null ? wrapupFiredAt - startedAt : null;
      const timeline =
        `grind 三档阶梯命中 abort: ` +
        `advisor=${advisorAt}ms wrapup=${wrapupAt}ms abort=${sinceStart}ms ` +
        `stallAtAbort=${stallAtAbort}ms`;
      spinFused = timeline;
      logger.warn(
        { cwd, goal: prompt, timeline },
        '[agent-leaf] grind 三档阶梯命中 abort → controller.abort() (spin-fused)',
      );
      controller.abort();
    };
    function noteProgress(): void {
      armIdle(); // armIdle 自己先清 —— 这里不再重复 clear
      maybeFireGrindEscalation();
    }
    armIdle();

    /**
     * 本次 leaf 的抢救读数 (2026-08-26)。**空数组 ≠ 没接** —— 接线恒在 (pi 腿), 空 = 这一次
     * 模型全程走的原生 tool_calls 通道, 那正是期望态。SDK 腿走不到这里 (它自己的循环核不经
     * streamFn), 所以 SDK 腿上这个数组恒空, 不代表 SDK 腿没有这个问题。
     */
    const salvageEvents: SalvageEvent[] = [];

    // P1 self_check 自修环 (C-2/C-3): 在闭包里把状态机装好, 让上面的 config 块直接拿现成的
    // getFollowUpMessages 句柄 (这样 config 块本身只关心接线, 不读懂状态机)。
    //
    // 三道闸, 任一关掉都退回旁路 (INV-3-3):
    //   ① `input.self_check` 缺席 (INV-1-2) → 根本没这条 cfg;
    //   ② `OMD_SELF_CHECK=0` env 关 → selfCheckEnabled = false;
    //   ③ `opts.maxSelfRepair <= 0` → 自修轮上限 0 (判据仍跑一次用于判定, 不注 follow-up)。
    const inputSelfCheck = input.self_check;
    const selfCheckEnabled = selfCheckEnvEnabled();
    const maxSelfRepair = opts.maxSelfRepair ?? 2;
    const selfCheck: SelfCheckSpec | undefined =
      inputSelfCheck && selfCheckEnabled && maxSelfRepair > 0 ? inputSelfCheck : undefined;
    // 自修环的 follow-up 闭包 (pi 通道专属, SDK 走不到这里)。getTouchedSize 读最新值
    // (闭包里再 getSize, 不是快照, 否则 INV-3-2「无新增停」的判据全是过期的)。
    // 工厂返 `{followUp, ledger}`: followUp 接 AgentLoopConfig 的 getFollowUpMessages,
    // ledger 在 leaf 跑完后落到 AgentLeafResult.selfRepair (C-4 落账)。
    const selfCheckBundle = selfCheck
      ? buildSelfCheckFollowUp({
          spec: selfCheck,
          cwd,
          // 与 command 节点同款真探测: base 表之外再并上本仓探到的语言 bin (python3/pytest 等),
          // 否则 self_check 的外层闸永远看不到这些 (runtimeAllowlistForRoot 单一来源, P2c)。
          allowlist: selfCheckAllowlist(),
          getTouchedSize: () => touched.size,
          // 内容级判据 (2026-08-26): 同一文件二次编辑时计数不动而指纹动 —— 计数那把尺子
          // 会把它误判成"零新增"并当场停掉自修环。两个方向的证伪都在 leaf-self-check.test.ts。
          getWorkspaceDigest: () => workspaceDigest(cwd, touched),
          enabled: true,
          maxSelfRepair,
          // S3 (D-5) 接线: 把 outer 的 currentFailSet 喂给闭包, 闭包用它构判据 diff 三态。
          getCurrentFailSet: () => currentFailSet,
          observe: (info) => {
            // S1 spin-route 档 1 (D-2 判据 diff 槽): self_check 退出时滚动 (fail) 集, 供
            // judgeRungOutcome 比对 before/now 严格缩小。失败 (kind='blocked' 或 'exited' 非空
            // but failed) 同样按 (fail) 字面提取, 不用 cmd 退出码做判据 —— 「没拿到主动退出码」与
            // 「拿到但不等」在用户语义上是同一类信号。
            // S3 (D-2 接线): `extractFailSet` 永不返 null, 旧代码恒真判别导致空数组冒充稳定。
            // 改为: 判红且提取空数组 ⇒ 传 null (unparsable 字面); 判绿不动 currentFailSet
            // (绿了那轮无 follow-up, 不污染下一轮 diff 的 prevFailSet)。
            if (info.kind === 'exited' && typeof info.stdout === 'string') {
              const red = info.exitCode !== selfCheck.expect_exit;
              if (red) {
                const parsed = extractFailSet(info.stdout);
                currentFailSet = parsed.length === 0 ? null : parsed;
              }
            }
            logger.info(
              { cwd, command: selfCheck.command, expect_exit: selfCheck.expect_exit, ...info },
              '[agent-leaf] self_check 自修环观察点 (C-3 落账)',
            );
          },
        })
      : null;
    const selfCheckFollowUp = selfCheckBundle?.followUp ?? null;
    const selfRepairLedger = selfCheckBundle?.ledger ?? { rounds: 0, oracleExit: [], convergedAt: null };
    // INV-2-1 「不许静默降级」的那条 WARN —— **真 emit** (S-1, 2026-08-30)。
    // 此前 `SELF_CHECK_SDK_SKIP_LOG` 全仓零 emit 点: 常量在、注释说"SDK 分支会说一句"、
    // 而那一句从来没被打出来过, 守它的测试拿常量自己的子串断言常量自己 (恒绿)。
    // 同形的 `AGENT_MEDIA_SDK_BYPASS_LOG` (:2422) / `SPIN_ROUTE_SDK_SKIP_LOG` (:2063) 都是真
    // emit 的 —— 三条同形纪律里断的恰好是这一条, 这里补齐。
    // 触发面 = 判据在场 (已过 env / maxSelfRepair 两道闸) ∧ SDK 通道: 那两道闸关掉是"实验对照臂"
    // 而不是"通道听不见", 下一步不同, 所以不共用这一句。
    if (selfCheck && isSdkChannel) {
      logger.warn(
        { model, command: selfCheck.command, expect_exit: selfCheck.expect_exit, sdkSelfCheckSkipped: true },
        SELF_CHECK_SDK_SKIP_LOG,
      );
    }

    const context: AgentContext = {
      systemPrompt: runSystemPrompt,
      messages: [],
      tools: runTools,
    };
    const config: AgentLoopConfig = {
      // SDK 通道不消费本 config (调用点分派), 空断言只为类型 —— pi 路上方已保证非空。
      model: piModel!,
      convertToLlm,
      // thinking: 'off' = 不发该字段 (与 pi-transport 同语义); 其余直映 pi 的 reasoning 档,
      // 由 pi 按模型 thinkingLevelMap 再夹一次 (它比我们更清楚自家目录里哪档存在)。
      ...(thinkingLevel !== 'off' ? { reasoning: thinkingLevel } : {}),
      // 凭证**每轮现取** (auth.json → env, 与单发通道同一条解析): OAuth token 会在长工具阶段中途过期,
      // 起跑时取一次的写法到那时就是 401。registry 解析出的 provider (bench 等) 凭证在 registry
      // 条目里, auth.json/env 链查不到 —— 先取 registry 的 key (与 callModel 传 cfg.apiKey 同源)。
      getApiKey: async (p: string) => leafResolved?.apiKey ?? (await resolvePiApiKey(p)),
      // drift 注入走 transformContext: 它只改**这一次请求**看到的消息, 不写回 context ——
      // 于是"检出 spin → 注一次"是天然的边沿行为, 不会在 transcript 里堆成 N 份 checklist。
      transformContext: async (messages: AgentMessage[]) => {
        // 四条注入共用这一个边沿出口 (都是"检出 → 注一次", 都不写回 context)。
        // 分开取、合并发: 同一轮里多件事都触发时发多条 user 消息, 模型更容易只回应最后一条。
        const parts = [
          drift?.takeInjection(),
          parseFeedback?.takeInjection(),
          takeGrindAdvice(),
          takeSpinRouteAdvice(),
        ].filter((t): t is string => typeof t === 'string' && t.length > 0);
        if (parts.length === 0) return messages;
        logger.debug({ parts: parts.length }, '[omd/agent-leaf] 软注入 via transformContext (drift / 写后即验 / grind advisor)');
        return [...messages, { role: 'user' as const, content: parts.join('\n\n'), timestamp: Date.now() }];
      },
      // ── P1 self_check 自修环 (C-2/C-3, INV-2-1: 只在 pi 通道) ────────────────────────
      // SDK 通道没有 `getFollowUpMessages` 钩子 —— 上面 provider === CLAUDE_SDK_PROVIDER 时整段
      // config (含 prepareNextTurn/shouldStopAfterTurn) 不被 SDK 消费, 这条 getFollowUpMessages
      // 也就自然不走; SDK 分支在本 runOnce 末尾的 `isSdkChannel` log 显式说一句。结构上靠
      // `isSdkChannel` 短路, 不靠 env 关 —— env 关走 `selfCheckEnabled === false` 那条路 (旁路)。
      ...(selfCheck && !isSdkChannel && selfCheckEnabled && maxSelfRepair > 0
        ? {
            // `selfCheck` truthy ⇒ `selfCheckBundle` 是 buildSelfCheckFollowUp 真值 ⇒ followUp 非空
            // (上面三行已定), TS 跨变量不自动 narrow —— `!` 是给编译器的真相, 不是运行时假设。
            getFollowUpMessages: selfCheckFollowUp!,
          }
        : {}),
      // ── 上下文压缩 (GP-8) ──────────────────────────────────────────────────
      // 顺序是**先压再判停**: 循环先调 prepareNextTurn 换上下文, 再拿换好的问 shouldStopAfterTurn。
      // 于是压缩成功 → 下一句判据自然就在线下, 不停; 压不动 (返 null / 压完还超) → 下一句接住停。
      // 不需要额外的"压过了没"标志位, 也就没有那个标志位漂掉的可能。
      // ⚠ 工具面升级与压缩**共用这一个钩子**: pi 只认一个 prepareNextTurn, 各挂各的会互相覆盖
      //   (后设的胜, 前一个静默失效)。所以外层包一层 (withToolFaceEscalation), 压缩仍是原样的内层。
      ...(wantCompaction || wantMinimalFace
        ? {
            prepareNextTurn: withToolFaceEscalation(
              wantMinimalFace
                ? {
                    tools: escalatedTools,
                    systemPrompt: escalatedSystemPrompt,
                    onEscalate: () =>
                      logger.info(
                        { model, from: perCallTools.length, to: escalatedTools.length },
                        '[agent-leaf] 第一轮跑完 → 工具面放开 (极简座位只在首轮省 schema)',
                      ),
                  }
                : null,
              !wantCompaction
                ? undefined
                : async ({ context: ctx }) => {
              const window = piModel?.contextWindow ?? 0;
              if (window <= 0) return undefined;
              const before = estimateContextTokens(ctx.messages).tokens;
              if (before < window * budgetRatio) return undefined;
              const compacted = await compactLeafContext({
                messages: ctx.messages,
                model,
                keepRecentTokens: keepRecentTokens,
                // 超大工具结果**存盘而非丢弃**: 落点与 bash 截断全文同一处 (`<cwd>/.omd`),
                // 隔离档下 cwd 就是那棵 worktree ⇒ 路径给出去 leaf 真读得到。见 `ToolResultSpill`。
                spill: { dir: join(cwd, '.omd') },
                ...(controller.signal ? { signal: controller.signal } : {}),
              });
              if (!compacted) return undefined; // 压不动 → 交给 shouldStopAfterTurn 优雅停
              usageAnchorStale = true; // 见上方注: 这一轮不能再拿 provider 用量当基数
              const after = pureEstimate(compacted.messages);
              compactions++;
              logger.info(
                { model, window, before, after, msgs: `${ctx.messages.length}→${compacted.messages.length}` },
                '[agent-leaf] 上下文压缩 (auto-compaction) —— 接着干, 不是交卷',
              );
              // 从 `ctx` 派生: 外层已经把升级后的 ctx 传进来了, 所以这里 spread 出去的工具面就是新的。
              return { context: { ...ctx, messages: compacted.messages } };
                  },
            ),
          }
        : {}),
      shouldStopAfterTurn: ({ context: ctx }) => {
        if (timeoutMs > 0 && now() - startedAt >= timeoutMs) {
          timedOut = true;
          return true;
        }
        // 压缩之后仍在线上 (或压根没开压缩) → 优雅停: 撞窗口是整轮硬失败, 而停下来还能交已有产物。
        // 刚压过的那一轮改用逐条估算 —— provider 自报的用量描述的是压缩**前**的上下文 (见 usageAnchorStale)。
        const window = piModel?.contextWindow ?? 0;
        const tokens = usageAnchorStale ? pureEstimate(ctx.messages) : estimateContextTokens(ctx.messages).tokens;
        usageAnchorStale = false;
        if (window > 0 && tokens >= window * budgetRatio) {
          contextExhausted = true;
          logger.warn({ model, window, compactions }, '[agent-leaf] 上下文预算到顶且压不下去 → 轮间优雅停 (GP-8)');
          return true;
        }
        return false;
      },
    };

    // D2 (attach_media agent 注入): 把 ContentPart[] 拆成 pi-native ImageContent[] + 引用清单,
    // 两腿共用 refs(SDK 旁路日志 / prompt 文本附路径清单)。**只在 input.promptImages 真给时工作**:
    // 缺省 = 整段旁路, 两条腿的 prompt 与首条 user 消息构造与现状逐字节相同 (INV-6 零回归)。
    const { parts: piImageParts, refs: imageRefs } = splitContentPartsForPi(input.promptImages);
    let sdkPrompt = routedPrompt;
    if (imageRefs.length > 0) {
      // SDK 腿响亮旁路 (INV-4): 具名常量日志一次, prompt 文本附图片路径清单 + view_image 指令,
      // agent 仍能经工具面看到像素 (claude-sdk-loop.ts:40 prompt:string 不吃 image, 本侧 SDD 不放宽)。
      logger.warn(
        { node: model, imageCount: imageRefs.length, paths: imageRefs },
        AGENT_MEDIA_SDK_BYPASS_LOG,
      );
      sdkPrompt = `${routedPrompt}\n\n[Attached images (${imageRefs.length})] ${imageRefs.join(', ')}\n` +
        'Each image is on disk. Use view_image(path) to see its pixels.';
    }

    let messages: AgentMessage[];
    let sdkUsage: ModelUsage | null = null;
    try {
      if (isSdkChannel) {
        // Claude 订阅通道: 循环换 SDK, 其余机械原样 —— filesTouched/writeEffects/shellRuns/drift
        // 全挂在 emit 的 tool_execution_* 事件上, 桥发同形事件, 采集不知道循环换了。
        // 看门狗: onActivity 每条 SDK 流消息续窗 + includePartialMessages 让长思考轮也有增量
        // (否则 3min idle 会把「在想」判成「挂死」—— 2026-08-01 修过的同族错)。
        // 上下文压缩/轮间停不做 (SDK 自管); tolerateAbort: 超时/停摆 abort → 返已累积, 优雅停语义保留。
        const effort = effortOf(sdkThinkingLevel);
        const advisorModel = officialAdvisorModelId(opts.advisor, model);
        const out = await runSdkAgentLoop({
          prompt: sdkPrompt,
          systemPrompt: perCallSystemPrompt,
          tools: perCallTools,
          modelId,
          modelCoord: model,
          ...(effort ? { effort } : {}),
          ...(advisorModel ? { advisorModel } : {}),
          cwd,
          onEvent: emit,
          onActivity: noteProgress,
          includePartialMessages: true,
          signal: controller.signal,
          tolerateAbort: true,
          ...(opts.sdkQueryFn ? { sdkQueryFn: opts.sdkQueryFn } : {}),
          // P1 (owner 验收): leaf 的账在循环核 emit, 成败都记 (pi leaf 不 emit 是因为引擎侧
          // 有 usage 回传链; SDK 失败路直接 throw, 不在这记就是订阅额度账外)。
          ledger: { model, origin: 'engine' },
        });
        messages = [{ role: 'user', content: sdkPrompt, timestamp: Date.now() } as AgentMessage, ...out.generated];
        // D2 (owner 验收): 逐消息 usage 折算 out 严重低估 —— totalUsage 取自 result.modelUsage 真源。
        sdkUsage = out.totalUsage;
        llmCalls = out.llmCalls;
      } else {
        // pi 腿: 有图时首条 user 消息 content 升格 parts (text + ImageContent, 照 chat/agent.ts:378-379
        // 同构 —— 文本逐字保留, 图块追加)。零图时 content 仍是 string, 与现状逐字相同。
        // 类型不显式标: AgentMessage 的 content 是 string | (TextContent | ImageContent)[] 的 union,
        // 两路分别赋值时 TS 自动从字面量 narrow。ImageContent/TextContent 类型字面取自 @earendil-works/pi-ai,
        // 与 chat/agent.ts 同源 (那条不在本仓 import 列表内, 不引坐标)。
        const firstUserContent =
          piImageParts.length > 0 ? [{ type: 'text' as const, text: routedPrompt }, ...piImageParts] : routedPrompt;
        const loop = opts.loopFn ?? runAgentLoop;
        // 正文内嵌工具调用的抢救层 (2026-08-26)。`known` 取**两副工具面的并集** —— 工具面升级
        // (withToolFaceEscalation) 会在第二轮把 runTools 换成 escalatedTools, 只登记首轮那副
        // 就会在升级之后把合法调用判成"工具名未注册"。装配一次、跨轮不变, 与 streamFn 的生命周期一致。
        messages = await loop(
          [{ role: 'user', content: firstUserContent, timestamp: Date.now() }] as AgentMessage[],
          context,
          config,
          emit,
          controller.signal,
          withToolCallSalvage(streamSimple, {
            known: new Set([...runTools, ...escalatedTools].map((t) => t.name)),
            onSalvage: (e) => {
              salvageEvents.push(e);
              // 抢救成功 = 这一轮本来会零产出 —— 算"有动静", 看门狗该续窗。
              if (e.calls > 0) noteProgress();
            },
          }),
        );
      }
    } finally {
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
    }

    const text = messages.map(assistantText).join('');
    // usage: 循环把每一轮的 assistant 消息连同 usage 一并交回 → 逐轮累加即整个 leaf 的账
    // (此前只能问 session 要一个汇总数)。口径换算见 mapSessionUsage。
    const totals = { input: 0, output: 0, cacheRead: 0 };
    for (const m of messages) {
      const u = (m as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
      if (!u) continue;
      // cacheWrite 并进 input: 本仓价表无写价字段, 按全价计 (诚实近似, 不虚构字段; 同 pi-transport)。
      totals.input += (u.input ?? 0) + (u.cacheWrite ?? 0);
      totals.output += u.output ?? 0;
      totals.cacheRead += u.cacheRead ?? 0;
    }
    const usage = sdkUsage ?? mapSessionUsage(totals);
    // D5 切片 2 (#268): pi 通道的用量此前一个字都没进 tui 账 —— SDK 通道在 runSdkAgentLoop 内
    // 已经按行 emit 过 (claude-sdk-loop.ts:347-355, ledger: { model, origin: 'engine' }), 这里
    // 再 emit 一次就双记。gate `!isSdkChannel` 守的是 INV-D5-2 「同一 leaf 的量在 tui 账里只出现一次」。
    if (!isSdkChannel) {
      emitModelUsage(usage, model, 'engine');
    }

    // **响亮失败** (承 C-5b): 低层循环对 provider 错误不抛 —— 它把 `stopReason:'error'` 连同
    // errorMessage 放进最后一条 assistant 消息就返回了 (agent-loop.js 的 error 分支)。
    // 那正是 empty-done 伪装成功的入口, 所以这里**主动查**: 有真错就带着 provider 的原话抛,
    // 而不是像从前那样只能猜"疑 401/404/空响应"。
    const last = messages[messages.length - 1] as
      | { role?: string; stopReason?: string; errorMessage?: string }
      | undefined;
    if (last?.role === 'assistant' && last.stopReason === 'error') {
      // 冷却轴 (2026-09-11, run 1c6b8a69): pi 循环把 provider 错误放在消息里返回, 不经 callModel 的
      // 熔断路 (index.ts:401) —— 于是 402/429/5xx 从不冷却该坐标, 上层 L0 重试与兄弟节点照打同一个
      // 死座 (实账 36 次 402)。这里按 callModel 同一把尺 (isProviderFault 的状态码集) 报一次。
      const status = providerErrorStatus(last.errorMessage);
      if (status !== undefined && (status === 402 || status === 403 || status === 429 || status >= 500)) {
        reportProviderFailure(model, cooldownMsFor(status, { channel: provider, period: status === 402 }));
        logger.warn({ model, status }, '[agent-leaf] provider 故障 → 坐标进冷却 (兄弟/重试改走座位链)');
      }
      throw new Error(
        `[agent-leaf] provider 报错 (model=${model}): ${last.errorMessage ?? '(无 errorMessage)'}`,
      );
    }
    // 零产出兜底: 没错误、没正文、没写盘、也不是被我们停下来的 → 仍然响亮失败
    // (executor-dag failedFromThrow 接住, 保留败因入 heal 回路), 不把 empty-done 当成功。
    // stalled / 超时 / 上下文到顶都**不在此列**: 它们有各自的语义, 由下游按语义判。
    if (!text.trim() && touched.size === 0 && !stalled && !timedOut && !contextExhausted && spinFused === null) {
      throw new Error(
        `[agent-leaf] 0-token empty-done (model=${model}): 循环返回空文本、无文件写入、非停摆非超时 — ` +
          '疑 provider 静默失败 (空响应, 或 reasoning 截断吞了正文)。',
      );
    }
    if (stalled) {
      logger.warn(
        { idleTimeoutMs, outLen: streamedChars, toolCalls },
        '[agent-leaf] leaf 停摆 (看门狗: 连续无任何循环事件且无工具在跑 → 疑 provider 挂起)',
      );
    } else if (timedOut) {
      logger.warn({ timeoutMs, outLen: streamedChars }, '[agent-leaf] leaf 超时中止 (有界停, 返已累积输出)');
    } else if (spinFused !== null) {
      logger.warn({ toolCalls, outLen: streamedChars, spinFused }, '[agent-leaf] leaf 空转熔断中止 (返已累积输出)');
    }
    // **D2 切片 2 (#266) 仓规检查接线点** (INV-D2-5 scope): 只在 leaf 正常完成时跑 ——
    // stalled / timedOut / spinFused / contextExhausted 都是 leaf 自身失败 (非「leaf 干完但仓规
    // 红」), 引擎会按各自语义判 failed, 检查无意义。零清单 (opts.repoChecks 缺席或空) → 整段
    // 跳过, 行为与切片前逐字节相同 (INV-D2-4 fail-open)。
    //
    // FAIL → 抛带 evidence 的 Error, engine.ts 的 L0 重试 (`causeOf` 把 `err.message` 拼进
    // prompt) 接住, leaf 上下文还热, 当场自修。UNVERIFIED → runRepoChecks 内部已 log warn,
    // 这里不抛, 不拦主流程 (oracle 自己崩了不是代码的错)。
    const repoChecks = opts.repoChecks;
    if (
      repoChecks &&
      repoChecks.length > 0 &&
      !stalled &&
      !timedOut &&
      spinFused === null &&
      !contextExhausted
    ) {
      const checksResult = await runRepoChecks({
        checks: repoChecks,
        files: [...touched],
        cwd,
        spawn: opts.repoChecksSpawn ?? defaultRepoChecksSpawn,
        ...(opts.repoChecksTimeoutMs !== undefined ? { timeoutMs: opts.repoChecksTimeoutMs } : {}),
        runId: input.touchSession?.split(':')[0],
        nodeId: input.touchSession?.split(':')[1],
      });
      if (checksResult.verdict === 'FAIL') {
        // 抛出的 message 经 engine.ts:4296 `causeOf` 拼进 causeNote (截 600 字),
        // 因此保留仓规 evidence 原文 (file:line + 命中内容) 比压成短码更重要。
        // ⚠ 只有 severity:'blocking' 的检查会把整体 verdict 变成 FAIL 走到这里 ——
        // advisory 的红在下面记 warn, 不杀节点 (见 repo-checks.ts 的 RepoCheck.severity 长注释)。
        throw new Error(
          `[agent-leaf] ${formatRepoChecksFailure(checksResult)}`,
        );
      }
      // advisory 红: 不杀节点, 但**必须留证据** —— fail-open 可以吞异常, 不许吞证据 (§静默坑 2)。
      // 不留的话就成了「闸悄悄不响」, 比闸误杀更坏: 误杀至少看得见。
      const advisoryFails = checksResult.perCheck.filter((c) => c.verdict === 'FAIL');
      if (advisoryFails.length > 0) {
        logger.warn(
          {
            checks: advisoryFails.map((c) => ({ id: c.id, reason: c.reason, evidence: c.evidence })),
            files: [...touched],
          },
          '[agent-leaf] 仓规检查红 (advisory) —— 不杀节点; 真问题由 accept 的全量兜住, 误报不再级联',
        );
      }
    }
    // 抢救读数收尾 (2026-08-26)。**触发过才打** —— 没触发是期望态, 每个 leaf 打一行 "0 次"
    // 只会把日志冲淡。触发过就必须看得见: 它意味着这个座位在**不走原生 tool_calls 通道**,
    // 那是要进座位登记表的模型行为, 不是一次性事故。
    if (salvageEvents.length > 0) {
      const salvagedCalls = salvageEvents.reduce((n, e) => n + e.calls, 0);
      logger.warn(
        {
          model,
          rounds: salvageEvents.length,
          salvagedCalls,
          names: [...new Set(salvageEvents.flatMap((e) => e.names))],
          unknown: [...new Set(salvageEvents.flatMap((e) => e.unknownNames))],
          truncated: salvageEvents.some((e) => e.truncated),
        },
        '[agent-leaf] 本次 leaf 用到了正文抢救 —— 该座位没走原生 tool_calls 通道',
      );
    }
    // spin 只在真卡过时带出去 —— 全 0 的字段进 JSON 只是噪声 (同 observations「缺席 ≠ 0」的口径)。
    const spinSummary = drift?.summary();
    // 刀② (2026-08-30): 撞墙计数随结果出 leaf (数据不是回调, 同 spinFused 那条边界纪律)。
    // 只在真撞过时出现 —— 全 0 的字段进 JSON 只是噪声 (缺席 ≠ 0 的口径同上)。
    const denials = touchSessionStore.getStore()?.writeDenials;
    return {
      text, usage, promptVersion, filesTouched: [...touched], filesRead: [...readPaths], cwd, toolCalls, llmCalls, stalled, writeEffects,
      // R-1 第 3 步: 回报实际用的档与通道 (两个通道的缺省不同, 引擎下发值 ≠ 实际值时读侧能看见)。
      thinking: isSdkChannel ? { level: sdkThinkingLevel, channel: 'sdk' as const } : { level: thinkingLevel, channel: 'pi' as const },
      ...(denials && denials.size > 0 ? { writeDenials: Object.fromEntries(denials) } : {}),
      // #178 produce-by: 仅触发时出现 (同 spin 惯例); 恒 ≤1 (谓词 firedAt 非空短路)。
      ...(produceByFiredAt !== null ? { produceByNudges: 1 } : {}),
      // 工具序列 (2026-08-16)。截头尾而不是截尾: 开头是它怎么起手, 结尾是它卡在哪, 中段最不值钱。
      // 截了多少显式带走 —— 静默截断会让"它只干了 400 步"和"它干了 4000 步"长得一样。
      ...(toolSteps.length > TOOL_STEPS_CAP
        ? {
            toolSteps: [...toolSteps.slice(0, TOOL_STEPS_HEAD), ...toolSteps.slice(toolSteps.length - (TOOL_STEPS_CAP - TOOL_STEPS_HEAD))],
            toolStepsDropped: toolSteps.length - TOOL_STEPS_CAP,
          }
        : { toolSteps }),
      // 熔断理由 (非 null = 熔断过)。数据不是回调 —— 隔离档 bwrap 子进程只有 JSON 过得了边界
      // (同 DriftTracker.summary 那条注), 信号要出 leaf 只能随结果回来。
      ...(spinFused !== null ? { spinFused } : {}),
      ...(spinSummary && spinSummary.spinEvents > 0 ? { spin: spinSummary } : {}),
      // 一条都没注 → 缺席而不是 0 (同上一条口径)。有值时才是"这一层真的动过"。
      ...(parseFeedback && parseFeedback.nudges() > 0 ? { parseNudges: parseFeedback.nudges() } : {}),
      // 一条都没跑 → **缺席**而不是 `[]`: 「这个 leaf 没用过 bash」与「这条采集没接」在读数上
      // 必须分得开 (同 spin / observations 那条口径)。
      // ⚠ 2026-08-12 补回: S1 埋点 (run 360405a5) 把这一行**删掉换成了下面的 watchdog 块**。
      // tsc 不报 (shellRuns 是可选字段), 测试也不报 —— honest-self-verification.test.ts 用的是
      // 注入的 agentRunner 自己喂 shellRuns, 碰不到这个真发射点。而下游 claimed-actions.ts:200
      // 的 `r.shellRuns ?? []` 会恒为空 → 谎报完成闸(S-30) 还在跑但什么都看不见。
      // 两者不冲突, 并列写。删这一行前先看 agent-leaf-shellruns-wiring.test.ts。
      ...(shell.runs().length ? { shellRuns: shell.runs() } : {}),
      // watchdog: S1 埋点 —— stalled/timedOut 恒写 boolean (false = 量过了且没发生, 不用缺席表示),
      // advisorFiredAt 恒写 (null = 没触发, 同"量过且没发生"口径); advisorAdvice 缺席 = 没触发。
      // spin 子字段沿用同一份 spinSummary、同一条「仅 spinEvents>0 才出现」惯例。
      // 口径统一 (2026-08-17, INV-5): 本结构里所有时刻一律**相对 startedAt 的毫秒数**
      // (touchTimelineMs/toolTimelineMs 一直如此)。advisorFiredAt 旧版曾写绝对纪元 ——
      // 存量 checkpoint 里 >1e12 的值即旧口径, 读旧语料时按此辨别。
      watchdog: {
        stalled,
        timedOut,
        touchTimelineMs,
        toolTimelineMs,
        advisorFiredAt: advisorFiredAt !== null ? advisorFiredAt - startedAt : null,
        advisorAdvice,
        // grind 三档阶梯收尾 (INV-5, 2026-08-17): wrapupFiredAt 同 advisorFiredAt 口径
        // (null = 没触发, 相对毫秒); abortedByGrind 同 stalled/timedOut 口径 (boolean)。
        wrapupFiredAt: wrapupFiredAt !== null ? wrapupFiredAt - startedAt : null,
        abortedByGrind,
        ...(spinSummary && spinSummary.spinEvents > 0
          ? { spin: { spinEvents: spinSummary.spinEvents, maxSameCount: spinSummary.maxSameCount } }
          : {}),
      },
      // P1 self_check 自修环落账 (C-4): self_check 缺席 = null (INV-1-2 / INV-4-1 严格区分);
      // SDK 通道 (Claude 订阅) 同样落 null (INV-2-1) —— 无 followUp 钩子, 判据不被听见。
      // 其他通道落闭包内累计的 ledger —— 即使闭包没被调过 (maxSelfRepair=0 / env 关),
      // selfRepairState 仍保有初始 `{rounds:0, oracleExit:[], convergedAt:null}`, 与 null 严格分得开。
      selfRepair: inputSelfCheck
        ? isSdkChannel
          ? null
          : (selfCheckFollowUp ? selfRepairLedger : { rounds: 0, oracleExit: [], convergedAt: null })
        : null,
      // P3 S2 台账 (三态): 没派判据 → 键缺席; 派了 → {ran, rounds, last}; 派了但 ALS 里没有作用域 (不该发生,
      // 只在 wrapper 被绕过时) → null 留证据。`ran` 只认 run_acceptance 的调用, 模型自己 bash 敲的不算。
      ...(inputSelfCheck
        ? { acceptance: (() => { const sc = touchSessionStore.getStore()?.acceptance; return sc ? { ran: sc.rounds > 0, rounds: sc.rounds, last: sc.last } : null; })() }
        : {}),
      // S1 spin-route 档 1 落账 (D-5 additive, INV-6): 路径启用但未触发 = []; 路径未启用 = 字段缺席
      // (opts.spinRoute === false 或 env OMD_SPIN_ROUTE=0 关)。既有消费者读 selfRepair 不受影响。
      ...(spinRouteEnabled && spinRouteEntries.length > 0
        ? { spinRoute: spinRouteEntries }
        : {}),
    };
  };
  // 上下文** —— 并发调用各一个上下文互不串。⚠ 不用 enterWith: 它在同步前缀里改的是**调用方
  // (引擎) 的共享上下文**, 并发节点会互相覆盖 (withScope 文档明说的坑); run() 的上下文随调用
  // 结束自动回收, 无需 exit。
  return async (input) => {
    // 缺席即具名 (2026-09-01): 三道闸的在场态先算出来 —— 「闸缺席」与「闸判过且合规」此前在
    // 结果里长得一模一样 (见 LeafGateStates 的注)。**只报不判**: 缺省仍是缺省, 一个字节的
    // 判据都没动, 变的只是它可分辨。日志与结果两处都留: 日志给现场 (结果不一定落盘),
    // 结果给引擎 (日志不一定还在)。
    const gates = leafGateStates(input, opts);
    logger.info({ cwd, gates }, '[agent-leaf] 本次调用三道闸的在场态 (unavailable = 没配这道闸, 不是"没越界")');
    // 刀② (2026-08-30): 恒入 ALS —— 撞墙计数的 Map 要按调用新建, 而写域闸可能只由装配期
    // opts.writeAllow 启用 (那条路此前不进 store)。getter 都是 `store?.x ?? opts.x` 形,
    // 恒入对「没 session / 没 per-call 清单」的调用零行为变化。
    return touchSessionStore.run(
      {
        session: input.touchSession,
        mcpAllow: input.mcpAllow,
        writeAllow: input.writeAllow,
        writeDenials: new Map(),
        // 版本守卫的观察台按调用新建 (与 writeDenials 同一格): 上一个节点看过什么,
        // 与这一个节点能不能覆写, 是两件事。
        fileObservations: new Map(),
        // P3 S2: 冻结判据随调用入 ALS, run_acceptance 的执行体只认这一份。
        ...(input.self_check ? { acceptance: { spec: input.self_check, rounds: 0, last: null } } : {}),
        // W2: 本次调用这副面要不要记读账 (只有编排循环的 conductor 面挂它)。缺席 = 不记。
        ...(input.face?.onToolObserved ? { toolObserver: input.face.onToolObserved } : {}),
      },
      async () => ({ ...(await runOnce(input)), gates }),
    );
  };
}

/** 一次写之前/之后的文件状态 —— §8.5 效果指标的原料。 */
export interface FileSnapshot {
  exists: boolean;
  /** 行数 (末尾无换行的最后一行也算一行; 不存在 = 0)。 */
  lines: number;
  /** 内容指纹。不存在 = null,于是"不存在 → 空文件"也判得出是变化。 */
  hash: string | null;
}

/**
 * 按住一个文件此刻的样子。**fail-open**: 读不到 (不存在 / 权限 / 是目录 / 竞态) 一律当"不存在",
 * 绝不抛 —— 本函数服务的是读数, 让它把一次真的写弄成异常, 是拿正确性换观测性。
 *
 * 二进制文件按字节读: 行数对 PNG 之类没有意义(会是个大数), 但 `noop` 仍然准, 而 noop 才是这条
 * 指标要抓的东西。这与 S1 语料里 `binary-claim` 那一段同一个取舍: 量不准的那一格明说, 别装准。
 */
/**
 * **bash 痕迹采集器** (2026-08-05) —— 把工具事件流配对成 {@link ShellRun}。
 *
 * 补的是「诚实自验在引擎记录里不存在」这个洞: agent 手里有 bash,「我跑了 `bun test`, 全过」
 * 是合法自验的主要形状, 而引擎此前只记 `toolCalls` 的**次数** —— 数不出跑的是什么、过没过。
 *
 * 抽成纯件是因为这里有**三个会静默错的判断**, 留在 runner 闭包里就只验得了"接上了":
 *   ① **命令与退出码分属两个事件** (start 带 args.command, end 带 result.details.exitCode),
 *      必须按 toolCallId 配对 —— 配错就是把 A 的退出码安到 B 头上。
 *   ② **退出码拿不到时不许编 0**。闸拒 (工具抛错, 压根没有 details) / 平台没给, 都是**缺席**;
 *      编个 0 出来就是把"没记"伪装成"跑通了", 而这条通道存在的意义正是分开这两者。
 *   ③ **闸拒的命令也要记**。写/读那两条采集只记成功是对的 (失败的写不是产物), 而这里记的是
 *      **动作发生过** —— 「跑了但被拒」与「压根没跑」是两件事, 只记成功就把它们抹平了。
 */

/**
 * 从 bash 工具的 end 事件 `result` 里取出**输出尾巴**(片 3m)。**纯函数**, 与
 * {@link createShellRunCollector} 的配对逻辑分开 —— 那两跳容易静默错
 * (见 D-2/D-3/D-4), 单独钉比塞进闭包里强。
 *
 * 行为 (INV-1/2/3/4):
 * - `content` 缺席 / 不是数组 / 首项非 text / text 不是 string ⇒ `undefined` (D-4 字段缺席);
 * - text 经 `\s+` 压平 + trim 后为空 ⇒ `undefined`;
 * - 否则取**末尾** `SHELL_OUTPUT_TAIL_CAP` 个字符, 无换行 (单行事实, 与 `执行命令:` 行同口径)。
 */
export function extractShellOutputTail(result: unknown): string | undefined {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (!first || typeof first !== 'object' || (first as { type?: unknown }).type !== 'text') return undefined;
  const raw = (first as { text?: unknown }).text;
  if (typeof raw !== 'string') return undefined;
  // 压平连续空白 + 去首尾空白:多行会被 `renderShellRunFact` 那条「事实是单行」的注释误读成
  // 独立事实 (verifier.ts:195 把每条事实渲染成 `- ${f}`), 单换行也得消掉。
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > SHELL_OUTPUT_TAIL_CAP ? flat.slice(-SHELL_OUTPUT_TAIL_CAP) : flat;
}

export function createShellRunCollector(): {
  note(e: { type: string; toolCallId?: string; toolName?: string; args?: unknown; result?: unknown; isError?: boolean }): void;
  runs(): ShellRun[];
} {
  const out: ShellRun[] = [];
  const byCall = new Map<string, string>();
  return {
    note(e) {
      if (e.toolName !== 'bash' || !e.toolCallId) return;
      if (e.type === 'tool_execution_start') {
        const cmd = (e.args as { command?: unknown } | undefined)?.command;
        if (typeof cmd === 'string' && cmd.trim()) byCall.set(e.toolCallId, cmd.trim());
        return;
      }
      if (e.type !== 'tool_execution_end') return;
      const command = byCall.get(e.toolCallId);
      if (command === undefined) return; // 没见过 start (事件丢了) → 不编一条出来
      byCall.delete(e.toolCallId);
      const details = e.isError ? undefined : (e.result as { details?: { exitCode?: unknown } } | undefined)?.details;
      const exitCode = typeof details?.exitCode === 'number' ? details.exitCode : undefined;
      // 输出尾 (片 3m): 采集器此前路过 `e.result.content[0].text` —— 那段里有 `bun test` 摘要
      // 与编译错误汇总, verifier 反复要原样, 而引擎手里从来没有过。压平 + 取末尾 + 单行
      // 上限 `SHELL_OUTPUT_TAIL_CAP`(D-2/D-3/D-6)。**没输出 ⇒ 字段缺席**(D-4, 仓规 §静默坑 1)。
      const outputTail = extractShellOutputTail(e.result);
      out.push({
        command,
        ...(exitCode === undefined ? {} : { exitCode }),
        ok: exitCode === 0,
        ...(outputTail === undefined ? {} : { outputTail }),
      });
    },
    runs: () => out,
  };
}

/**
 * 两张快照 → 一条效果指标 (§8.5)。**纯函数**, 与读盘分开, 于是 noop 的判据本身可以被单独钉住 ——
 * 而它正是这条指标唯一容易搞错的地方: 直觉会写成 `lineDelta === 0`, 那是错的。
 */
export function diffWriteEffect(path: string, before: FileSnapshot, after: FileSnapshot): FileWriteEffect {
  return {
    path,
    lineDelta: after.lines - before.lines,
    // 判据是「内容变没变」而不是「delta 是不是 0」: 换掉同样多的行 delta=0 但不是 noop;
    // 新建空文件 lines 都是 0 但 exists 从 false 变 true, 也不是 noop。
    noop: before.exists === after.exists && before.hash === after.hash,
  };
}

/**
 * 写集的**内容级**指纹 —— `buildSelfCheckFollowUp` 的 `getWorkspaceDigest` 实装 (2026-08-26)。
 *
 * 逐文件取 {@link snapshotFile} 的 hash, 按路径排序后拼一串再 sha1。三件事刻意这么做:
 *
 * ① **路径进指纹**, 不只是内容 —— 否则「把 a.ts 的内容整体挪进 b.ts」会被判成没变。
 * ② **文件不存在写成 `∅` 而不是跳过** (§NULL ≠ 0 ≠ 不适用): 「这一轮把文件删了」与
 *    「这一轮压根没碰它」必须给出不同的指纹, 否则一次删除会被判成"零进展"而停掉自修环。
 * ③ **空写集有确定值** (`sha1("")` 的那个常量), 不是 null —— 「一个文件都没写」是一个
 *    合法且稳定的状态, 两轮都没写就该判停。返 null 会让判据退回计数, 那是另一把尺子。
 */
export function workspaceDigest(cwd: string, paths: Iterable<string>): string {
  const h = createHash('sha1');
  for (const p of [...paths].sort()) {
    const snap = snapshotFile(cwd, p);
    h.update(p).update('\u0000').update(snap.hash ?? '∅').update('\u0000');
  }
  return h.digest('hex');
}

export function snapshotFile(cwd: string, path: string): FileSnapshot {
  try {
    const full = isAbsolute(path) ? path : join(cwd, path);
    const buf = readFileSync(full);
    const text = buf.toString('utf-8');
    return {
      exists: true,
      lines: text === '' ? 0 : text.split('\n').length,
      hash: createHash('sha1').update(buf).digest('hex'),
    };
  } catch {
    return { exists: false, lines: 0, hash: null };
  }
}
