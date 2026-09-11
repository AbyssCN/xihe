/**
 * src/harness/dream/extract-run.ts —— dream SDD §S5 extract-run 叶 (第二个 LLM 叶)。
 *
 * 输入: 完结 run 的 transcript · redraw feedback 块 · invalid 分类 · plan-ledger family/版本/战绩行。
 * 输出: ExtractRunReport (DreamCandidate[] + 时态边操作 + 成本报告)。
 *
 * 四类候选 (SDD §S5 表):
 *   1. plan-family 教训 → omd.pattern (situation/approach/outcome, 必带 runId+nodeId)
 *   2. oracle 教训     → omd.pattern (situation/approach/outcome, 必带 runId+nodeId)
 *   3. 座位教训       → omd.limit   (kind=boundary, statement 带 runId+nodeId)
 *   4. 时态边         → EdgeStore (不是 facts): (family)-[best_plan]->(vN), invalidate
 *
 * 四条红线:
 *   §8.2-2 统计红线 — 数字(成本/时长/次数)不得蒸成统计事实, S2 S-拒兜底
 *   时态边唯一合法改法 = edges.invalidate(identity, at, successor), 不许 put 覆盖
 *   provenance 唯一构造点 = validate.ts dreamFactInput, 模型不得作者化 sessionRef/confidence
 *   K_leaf = 8 (复用 merge.ts), 机械+LLM 合并后超限整叶 fail
 *
 * 模型解析与 extract-chat 同型:
 *   opts.model 优先 → OMD_DREAM_MODEL 次之 → 缺失响亮抛 (禁静默兜底, S6 N4 裁)
 * LLM maxRetries 严格 0; 入账由注入的 callModel 出口保证, 叶内不重复 emit (双计)。
 */
import { z } from 'zod';
import type { ModelRequest, ModelResponse, ModelUsage } from '../../model/types';
import { computeCost } from '../../model/cost-ledger';
import { type DreamCandidate, type DreamNamespace } from './validate';
import { K_leaf } from './merge';
import { ALLOWED_NAMESPACES } from '../../memory/safeguards/namespaces';
import { OMD_ORACLE_SUBJECTS, subjectSlugOf } from '../../memory/safeguards/universal-namespaces';
import type { EdgeStore, TemporalEdge } from '../memory/types';
import { rejectIfProbe, PROBE_SOURCE } from '../dag/credit';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单个完结 run 的输入数据 (gather 组装, 本叶消费)。 */
export interface ExtractRunInput {
  /** run 唯一标识 (R-拒在 runs.db 查)。 */
  runId: string;
  /** run 状态: done / failed / cancelled / interrupted。 */
  status: string;
  /** 用户任务原文 (goal)。 */
  goal: string;
  /** 错误信息 (failed 时有值)。 */
  error?: string;
  /** run 执行 transcript (对话/工具调用 trace)。 */
  transcript?: string;
  /** redraw feedback 块 (dag_goal 结果审查反馈)。 */
  redrawFeedback?: string[];
  /** invalid 分类 (bench 判分作废原因)。 */
  invalidClassification?: string;
  /** plan-ledger 的 family/版本/战绩行 (本 run 所属)。 */
  planLedger?: {
    familyId: string;
    familyCanonicalTask: string;
    planVersion: number;
    planOk: boolean;
    planVerified: boolean;
    costUsd?: number;
    generation?: string;
  };
}

export interface ExtractRunOpts {
  /**
   * 注入 callModel (依赖注入, 测试走 fake)。
   * 省略 → 不调 LLM, 只走机械时态边。
   */
  callModel?: (req: ModelRequest) => Promise<ModelResponse>;
  /** provider:modelId 坐标。省略 → OMD_DREAM_MODEL;两者皆缺 → 抛错。 */
  model?: string;
  /**
   * 注入 EdgeStore (依赖注入, 测试走 fake/memory)。
   * 省略 → 不写时态边 (机械候选仍产出, 但边操作 noop)。
   */
  edges?: EdgeStore;
}

export interface ExtractRunReport {
  ok: boolean;
  /** 全部候选 (机械时态边不在此列 — 它们是边操作, 不是 fact 候选)。 */
  candidates: DreamCandidate[];
  /** 本次叶 LLM 调用次数。 */
  llmCallCount: number;
  /** 本次叶 LLM 成本 USD。 */
  costUsd: number;
  /** 时态边操作数 (invalidate 调用次数)。 */
  edgeOps: number;
  /** 失败判词 (ok=false 时有值)。 */
  failReason?: string;
}

// ---------------------------------------------------------------------------
// 模型响应 schema — 只允许 { namespace, payload }
// 模型不得作者化 sessionRef / confidence / source_event_ids / runRef
// ---------------------------------------------------------------------------

const extractRunCandidateSchema = z.object({
  namespace: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

const extractRunResponseSchema = z.object({
  candidates: z.array(extractRunCandidateSchema),
});

// ---------------------------------------------------------------------------
// 机械: plan-ledger → 时态边 (零 LLM)
// ---------------------------------------------------------------------------

/**
 * 从 plan-ledger 数据构造时态边操作描述。
 * 边: (family:<familyId>)-[best_plan]->(current)
 *
 * object 固定为 "current" — invalidate 要求 identity 一致才能找到前任 open edge。
 * 版本信息在 payload 中, asOf 查当前返回最新 payload。
 *
 * 不是 fact —— 直接通过 EdgeStore.invalidate 写入。
 * 返回 null = planLedger 数据不全, 跳过。
 */
export interface PlanEdgeOp {
  /** 边 identity。 */
  identity: { subject: string; predicate: string; object: string };
  /** invalidate 的时刻 (now)。 */
  at: Date;
  /** 后继边 (新版本)。validFrom 由 invalidate 设为 at。 */
  successor: Omit<TemporalEdge, 'validFrom'>;
}

export function planEdgeOp(input: ExtractRunInput): PlanEdgeOp | null {
  const pl = input.planLedger;
  if (!pl?.familyId) return null;

  const subject = `family:${pl.familyId}`;
  const predicate = 'best_plan';
  const object = 'current';

  return {
    identity: { subject, predicate, object },
    at: new Date(),
    successor: {
      subject,
      predicate,
      object,
      validTo: null, // open-ended current edge
      payload: {
        runId: input.runId,
        familyTask: pl.familyCanonicalTask,
        version: pl.planVersion,
        ok: pl.planOk,
        verified: pl.planVerified,
        ...(pl.costUsd !== undefined ? { costUsd: pl.costUsd } : {}),
        ...(pl.generation ? { generation: pl.generation } : {}),
      },
    },
  };
}

/**
 * 执行时态边操作: 优先 invalidate (有前任 open edge 时),
 * 若 "no open edge" 则退化为 put (首次写入该 identity)。
 * 其他错误透传。
 */
async function applyEdgeOp(edges: EdgeStore, op: PlanEdgeOp): Promise<void> {
  try {
    await edges.invalidate(op.identity, op.at, op.successor);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('no open edge')) {
      // 首次写入: 没有前任可 invalidate, 用 put
      await edges.put({
        ...op.successor,
        validFrom: op.at,
      });
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// 可信输入构造 (弱边界, 同 extract-chat §S4)
// ---------------------------------------------------------------------------

/**
 * 构造 extract-run 的可信输入文本。
 * 候选来源仅限: transcript (用户/助手对话) · redraw feedback (审查反馈) · invalid classification。
 * 不可信: 工具原始输出 / 网页内容 (transcript 中 tool 角色内容不进)。
 */
export function renderTrustedRunInput(input: ExtractRunInput): string {
  const lines: string[] = [];

  lines.push(`## Run 信息`);
  lines.push(`- runId: ${input.runId}`);
  lines.push(`- status: ${input.status}`);
  lines.push(`- goal: ${input.goal}`);
  if (input.error) lines.push(`- error: ${input.error}`);

  if (input.invalidClassification) {
    lines.push('');
    lines.push(`## Invalid 分类`);
    lines.push(input.invalidClassification);
  }

  if (input.redrawFeedback && input.redrawFeedback.length > 0) {
    lines.push('');
    lines.push(`## Redraw Feedback`);
    for (const fb of input.redrawFeedback) {
      lines.push(`- ${fb}`);
    }
  }

  if (input.transcript) {
    lines.push('');
    lines.push(`## Transcript`);
    lines.push(input.transcript);
  }

  if (input.planLedger) {
    lines.push('');
    lines.push(`## Plan 战绩`);
    lines.push(`- family: ${input.planLedger.familyCanonicalTask}`);
    lines.push(`- version: v${input.planLedger.planVersion}`);
    lines.push(`- ok: ${input.planLedger.planOk}`);
    lines.push(`- verified: ${input.planLedger.planVerified}`);
    if (input.planLedger.costUsd !== undefined) {
      lines.push(`- costUsd: ${input.planLedger.costUsd}`);
    }
    if (input.planLedger.generation) {
      lines.push(`- generation: ${input.planLedger.generation}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 预算闸
// ---------------------------------------------------------------------------

/**
 * 检查总候选数是否超过 K_leaf。
 * 机械候选 (planEdgeOp 不计入 — 它是边不是 fact) + LLM 候选 > K_leaf → 整叶 fail。
 */
export function checkExtractRunBudget(llmCount: number): { ok: true } | { ok: false; reason: string } {
  if (llmCount > K_leaf) {
    return {
      ok: false,
      reason: `K_leaf exceeded: leaf produced ${llmCount} candidates > limit ${K_leaf}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// extractRunRecord
// ---------------------------------------------------------------------------

/**
 * 对单个完结 run 执行 extract-run。
 *
 * 流程:
 *   1. 机械: plan-ledger → planEdgeOp (零 LLM)
 *   2. 构造可信输入, 调 LLM 结构化提取
 *   3. 校验 LLM 响应: namespace 必须在允许表中
 *   4. 附加 runRef + agent_tentative confidence (代码统一, 模型不得作者化)
 *   5. 预算闸: LLM 候选 ≤ K_leaf, 超限整叶 fail 零产出
 *   6. 执行时态边操作: edges.invalidate (若有 edges 且有 planLedger)
 *   7. 返回报告
 */
export async function extractRunRecord(
  input: ExtractRunInput,
  opts: ExtractRunOpts = {},
): Promise<ExtractRunReport> {
  // S2 后半 (C-2 / INV-10, I-11): dream extract 不读 probe usage —— 探测消耗独立计量,
  // 不得固化进 dream memory (否则 omd.pattern 会拿 probe 段的 0-cost 探针调用学成
  // 「便宜模式」)。`rejectIfProbe` 在源头拒收, fail-open 之外的硬拒 (probe 不能进
  // dream 升档路径)。opts 与 input 均不应携带 source='probe' 的子字段。
  rejectIfProbe(opts as unknown as { source?: string });
  rejectIfProbe(input as unknown as { source?: string });
  if ((opts as unknown as { usage?: { probe?: unknown } }).usage?.probe !== undefined) {
    throw new Error(`I-11: ${PROBE_SOURCE} 记录禁止进入 dream extract (extractRunRecord)`);
  }

  const report: ExtractRunReport = {
    ok: true,
    candidates: [],
    llmCallCount: 0,
    costUsd: 0,
    edgeOps: 0,
  };

  // ── 1. 机械: 时态边 ──

  const edgeOp = planEdgeOp(input);

  // ── 2. 构造可信输入 ──

  const trustedInput = renderTrustedRunInput(input);

  // ── 3. 调 LLM (若提供了 callModel 且有可信输入) ──

  let llmRawCandidates: Array<{
    namespace: string;
    payload: Record<string, unknown>;
  }> = [];

  if (opts.callModel && trustedInput.trim()) {
    const callModel = opts.callModel;
    // 模型必须显式解析: opts.model 优先, OMD_DREAM_MODEL 次之, 缺失则抛错 (禁静默兜底)。
    const model = opts.model ?? process.env.OMD_DREAM_MODEL;
    if (!model) throw new Error('extract-run: model required — pass opts.model or set OMD_DREAM_MODEL; no silent fallback');

    const systemPrompt = [
      '你是一个 run 记忆提取器。从以下 run 的执行记录中提取**可固化的事实**。',
      '',
      '**四类可提取的候选**:',
      '',
      '1. **plan-family 教训** (omd.pattern):',
      '   - situation: plan family 的哪个节点/阶段出了问题',
      '   - approach: 当时用了什么策略/配置',
      '   - outcome: failed 或 worked',
      '   - scope: "plan-family"',
      '   - 必须能指回 runId+nodeId (具体节点)',
      '',
      '2. **oracle 教训** (omd.pattern):',
      '   - situation: 哪类任务的验收命令/判据',
      '   - approach: 那条被 acceptance 拒过的虚判据',
      '   - outcome: failed',
      '   - scope: "oracle"',
      '',
      '3. **座位教训** (omd.limit):',
      '   - kind: "boundary"',
      '   - statement: 描述座位在什么条件下超限 (如 "seat Y 在 leaf 位 >8k prompt 时超时"), 必带 runId+nodeId',
      '',
      '4. **时态边** — 不由你输出, 由机械逻辑处理。',
      '',
      '**可信来源 (仅限)**:',
      '- transcript 中的用户/助手对话',
      '- redraw feedback (审查反馈)',
      '- invalid classification',
      '',
      '**不可信来源 (不要提取)**:',
      '- 工具原始输出',
      '- 网页内容',
      '',
      '**不要**提取统计数字 (次数、金额、百分比、平均值等) —— 那些是会过期的账。',
      '',
      '**输出格式**: 一个 JSON 对象, 包含 candidates 数组。每个 candidate:',
      '- namespace: 必须是以下之一: ' + ALLOWED_NAMESPACES.join(', '),
      '- payload: namespace 对应的字段',
      '  - omd.pattern: { situation, approach, outcome, scope, subject } —— scope 必填, 只能是 "plan-family" / "oracle" / "seat" (座位形教训成 pattern 时用 "seat")',
      '    subject 必填 = 这条教训的**主题槽** (小写 slug, 2-48 字符): scope=oracle 只能是 ' + OMD_ORACLE_SUBJECTS.join(' / ') + ';',
      '    scope=seat 写座位坐标 slug (如 minimax-cn-minimax-m3); scope=plan-family 可留空 (代码按 plan-ledger 的 familyId 附加)。',
      '    同一主题同一结局的新教训会取代旧教训, 所以 subject 要选「下次还会再碰到的那个东西」, 不要写本次任务的专名。',
      '  - omd.limit: { kind: "boundary", statement }',
      '',
      '**重要**:',
      '- 只输出 JSON, 不要任何解释',
      '- 没有可提取的事实时返回 { "candidates": [] }',
      '- 每条 candidate 的 payload 中不要包含 runId/nodeId/sessionRef/confidence — 代码统一附加',
    ].join('\n');

    const userPrompt = '以下是 run 执行记录:\n\n' + trustedInput + '\n\n请提取可固化的事实。';

    let response: ModelResponse;
    try {
      response = await callModel({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model,
        responseSchema: extractRunResponseSchema,
        maxRetries: 0,
      });
    } catch (err) {
      report.ok = false;
      report.failReason =
        `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
      // 机械候选 (时态边) 仍可执行
      if (opts.edges && edgeOp) {
        try {
          await applyEdgeOp(opts.edges, edgeOp);
          report.edgeOps = 1;
        } catch (edgeErr) {
          report.failReason +=
            `; edge op also failed: ${edgeErr instanceof Error ? edgeErr.message : String(edgeErr)}`;
        }
      }
      return report;
    }

    report.llmCallCount = 1;
    const usage: ModelUsage = response.usage;
    const resolvedModel = response.model || model;
    report.costUsd = computeCost(usage, resolvedModel).costUsd ?? 0; // 订阅通道 → 0 USD (dream 座恒 API, 防御性)
    // 入账不在此处: 注入的 callModel (model/index.ts:305/329/352) 出口已 emitModelUsage,
    // 叶内再 emit 即双计 (S5 终审实测: live rawCalls 两笔逐字同值, ledger 成本 ×2)。

    if (response.parsed) {
      const parsed = response.parsed as {
        candidates?: Array<{ namespace: string; payload: Record<string, unknown> }>;
      };
      llmRawCandidates = parsed.candidates ?? [];
    }
  }

  // ── 4. 校验 LLM 响应 ──

  for (const raw of llmRawCandidates) {
    if (!ALLOWED_NAMESPACES.includes(raw.namespace)) {
      report.ok = false;
      report.failReason =
        `LLM produced invalid namespace "${raw.namespace}" — not in allowed namespaces: ${ALLOWED_NAMESPACES.join(', ')}`;
      return report;
    }
  }

  // ── 5. 附加 runRef 与 confidence (代码统一, 模型不得作者化) ──

  const familySubject = input.planLedger?.familyId ? `family:${subjectSlugOf(input.planLedger.familyId)}` : undefined;
  const llmCandidates: DreamCandidate[] = llmRawCandidates.map((raw) => ({
    namespace: raw.namespace as DreamNamespace,
    // subject (2026-09-11, T-H): plan-family 由代码按 familyId 机械附加 (模型不作者化); 其余 scope 取模型给的 slug 化;
    // 缺席 → 由 situation 机械 slug 兜底, validate 仍会按 scope 闭集拒 oracle 的乱写。
    payload:
      raw.namespace === 'omd.pattern'
        ? {
            ...raw.payload,
            subject:
              raw.payload.scope === 'plan-family' && familySubject
                ? familySubject
                : subjectSlugOf(String(raw.payload.subject ?? raw.payload.situation ?? '')),
          }
        : raw.payload,
    runRef: { runId: input.runId, nodeId: undefined },
    confidence: {
      level: 'agent_tentative' as const,
      source_event_ids: [
        `run:${input.runId}`,
      ] as [string, ...string[]],
    },
  }));

  // ── 6. 预算闸 ──

  const budget = checkExtractRunBudget(llmCandidates.length);
  if (!budget.ok) {
    report.ok = false;
    report.failReason = budget.reason;
    report.candidates = []; // 整叶 fail, 零产出
    return report;
  }

  report.candidates = llmCandidates;

  // ── 7. 执行时态边操作 ──

  if (opts.edges && edgeOp) {
    try {
      await applyEdgeOp(opts.edges, edgeOp);
      report.edgeOps = 1;
    } catch (edgeErr) {
      report.ok = false;
      report.failReason =
        `Edge op failed: ${edgeErr instanceof Error ? edgeErr.message : String(edgeErr)}`;
    }
  }

  return report;
}
