/**
 * src/memory/safeguards/namespace-kernel —— SAFEGUARD-2 的**通用机制层** (domain-free, P1#1 R5 分离)。
 *
 * 这里只有"如何安全地记 L3 fact"的机制, **零 domain 内容**:
 *   - 信任级 (Confidence) + source anchor + confidence 字段 = 任何 omd instance 的 L3 都要。
 *   - reject-by-default / ban-glob 编译 / identity-key 计算 = 机制, 与"记什么"无关。
 *   - **通用 GDPR 特殊类别 ban** (健康/政治/宗教 = EU Art 9 法, 跨 instance 恒禁) = baseline。
 *
 * 具体 namespace schema (会计 client/compliance/firm/…) 属 **domain pack** (R5), 经 {@link NamespacePack}
 * 注入。kernel 出建材 (ConfidenceSchema/sourceAnchor/confidenceField) 给 domain pack 作者 schema 用。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Confidence — 三级信任 (通用: 任何 agent 自我记忆都要 provenance + trust)。
// ---------------------------------------------------------------------------

/**
 * 每条 fact 的来源 + 信任级。
 *   - human_verified : the owner/agent 确认。self-evolve 不可改。
 *   - agent_confident: ≥3 source events。self-evolve 可改 (带 evolution_log)。
 *   - agent_tentative: 1-2 source events。可替换; 闲置 30 天过期。
 */
export const ConfidenceSchema = z.discriminatedUnion('level', [
  z.object({
    level: z.literal('human_verified'),
    // 验证者身份 (通用 string, 非硬编人名 — universal 层无 PII; instance 填 'human'/user-id/名字均可)。
    by: z.string().min(1),
    verified_at: z.coerce.date(),
    note: z.string().optional(),
  }),
  z.object({
    level: z.literal('agent_confident'),
    source_event_ids: z.array(z.string().min(1)).min(3),
    created_at: z.coerce.date(),
  }),
  z.object({
    level: z.literal('agent_tentative'),
    source_event_ids: z.array(z.string().min(1)).min(1).max(2),
    created_at: z.coerce.date(),
  }),
]);

export type Confidence = z.infer<typeof ConfidenceSchema>;
export type ConfidenceLevel = Confidence['level'];

// ---------------------------------------------------------------------------
// 共享 fragments — domain pack 作者每个 namespace schema 时拼这两段。
// ---------------------------------------------------------------------------

/**
 * Source anchor: source_event_id / source_doc_id 至少一个 (字段级都 optional, "至少一个"
 * 由 validator 强制, 让缺锚的 reason 是显式 'no-source-anchor' 而非埋在 refinement)。
 */
export const sourceAnchor = {
  source_event_id: z.string().min(1).optional(),
  source_doc_id: z.string().min(1).optional(),
} as const;

export const confidenceField = { confidence: ConfidenceSchema } as const;

// ---------------------------------------------------------------------------
// NamespacePack — domain pack 注入的契约 (R5 接缝)。
// ---------------------------------------------------------------------------

/**
 * 一个 domain (如 a sibling project 事务所) 注入的 fact namespace 配置。
 *   - schema:        reject-by-default 的 discriminatedUnion('namespace', [...]) — 由 domain 用
 *                    kernel 建材作者 (字面 branch tuple 保留静态类型)。
 *   - identityFields: 每个 namespace 的 identity 字段 (supersession 用 — "什么算同一条逻辑 fact")。
 *   - banGlobs:      domain 特有的 ban (与 kernel UNIVERSAL_BAN_GLOBS 合并)。
 */
export interface NamespacePack {
  /** 该 pack 的 namespace branch 集 (z.object, 字面声明保静态类型; facade 合并多 pack 成一个 union)。 */
  readonly branches: readonly z.ZodObject<z.ZodRawShape>[];
  /** branch 含的全部 namespace 字面 (pack 从自己 branches .shape 派生 — 在 pack 侧静态类型仍在)。 */
  readonly allowedNamespaces: readonly string[];
  readonly identityFields: Record<string, readonly string[]>;
  /**
   * 身份键收窄时的**旧键回落** (2026-09-11): 主 identity 字段里任一在 fact 上缺席 → 用这组字段算键。
   * 用途: `omd.pattern` 从 [situation, approach, scope] 收窄到 [scope, subject] 后, 不带 subject 的既有写手
   * (pathfinder 裁决) 与库里旧行仍按旧键分身 —— 否则它们会全部塌成一个 identity, 每次写都顶掉上一条。
   */
  readonly legacyIdentityFields?: Record<string, readonly string[]>;
  /** 该 pack 禁记的 namespace glob (无通用 baseline — ban 是辖区/domain 的事, 各 pack 自带; 见 P1#1 the owner 校准)。 */
  readonly banGlobs: readonly string[];
}

/** 多 pack 装配结果 (facade / daemon 边界用)。 */
export interface AssembledSafeguard {
  /** 合并 union (reject-by-default; 未列 namespace 不匹配任何 branch → 拒)。 */
  readonly schema: z.ZodTypeAny;
  readonly allowedNamespaces: readonly string[];
  readonly identityFields: Record<string, readonly string[]>;
  readonly identityKeyOf: (fact: { namespace: string } & Record<string, unknown>) => string;
  readonly banGlobs: readonly string[];
  readonly matchedBanGlob: (namespace: string) => string | null;
}

/**
 * 装配多个 {@link NamespacePack} (通用 user/omd pack + domain pack) 成一套 reject-by-default 闸料。
 * **无通用 ban baseline** (the owner 校准: GDPR 等是辖区/domain 的事, 不入 omd 通用层) —— ban 全来自各
 * pack 的 banGlobs 合并。
 */
export function assembleSafeguard(packs: readonly NamespacePack[]): AssembledSafeguard {
  const branches = packs.flatMap((p) => [...p.branches]);
  const schema = z.discriminatedUnion(
    'namespace',
    branches as [z.ZodObject<z.ZodRawShape>, ...z.ZodObject<z.ZodRawShape>[]],
  );
  const allowedNamespaces = packs.flatMap((p) => [...p.allowedNamespaces]);
  const identityFields: Record<string, readonly string[]> = Object.assign(
    {},
    ...packs.map((p) => p.identityFields),
  );
  const legacyIdentityFields: Record<string, readonly string[]> = Object.assign(
    {},
    ...packs.map((p) => p.legacyIdentityFields ?? {}),
  );
  const banGlobs = packs.flatMap((p) => [...p.banGlobs]);
  return {
    schema,
    allowedNamespaces,
    identityFields,
    identityKeyOf: makeIdentityKeyOf(identityFields, legacyIdentityFields),
    banGlobs,
    matchedBanGlob: makeMatchedBanGlob(banGlobs),
  };
}

/**
 * 编译一个 ban glob → RegExp。segment `*` = 非空 SUBTREE (一或多段), 故 `business.figure.*`
 * 命中深层 `business.figure.q1.revenue`, `*.health.*` 命中 `client.foo.health.status`。
 * 锚定全匹配 (^…$) 防 superstring 误中; 大小写不敏感 (i): GDPR ban 不可由 casing 逃逸。
 */
export function globToRegExp(glob: string): RegExp {
  const SUBTREE = '[^.]+(?:\\.[^.]+)*';
  const body = glob
    .split('.')
    .map((seg) => (seg === '*' ? SUBTREE : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('\\.');
  return new RegExp(`^${body}$`, 'i');
}

/** 造一个 matchedBanGlob(namespace) — 返首个命中的 (原始, 人读) glob, 否则 null。 */
export function makeMatchedBanGlob(globs: readonly string[]): (namespace: string) => string | null {
  const patterns = globs.map(globToRegExp);
  return (namespace: string): string | null => {
    for (let i = 0; i < patterns.length; i++) {
      const re = patterns[i];
      const glob = globs[i];
      if (re !== undefined && glob !== undefined && re.test(namespace)) return glob;
    }
    return null;
  };
}

/**
 * 造一个 identityKeyOf(fact) — fact 的身份 = namespace + 各 identity 字段值 (声明序), 排除可更新
 * value + provenance。两条身份相等 = 同一逻辑 fact 的不同修订, 后写 supersede 前写 (self-evolve 锁)。
 * 空数组 = singleton "当前值" namespace (每写 supersede 前一快照)。未登记 namespace → 退化 defensive key。
 */
export function makeIdentityKeyOf(
  identityFields: Record<string, readonly string[]>,
  legacyIdentityFields: Record<string, readonly string[]> = {},
): (fact: { namespace: string } & Record<string, unknown>) => string {
  return (fact): string => {
    const primary = identityFields[fact.namespace];
    if (primary === undefined) {
      return JSON.stringify([fact.namespace, '__unmapped__']);
    }
    // 旧键回落 (见 NamespacePack.legacyIdentityFields): 主字段缺席一个就整组换旧键 —— 半新半旧的键谁也对不上。
    const legacy = legacyIdentityFields[fact.namespace];
    const fields = legacy && primary.some((f) => fact[f] === undefined) ? legacy : primary;
    const parts = fields.map((f) => {
      const v = fact[f];
      if (v instanceof Date) return v.getTime();
      return v === undefined ? null : v;
    });
    return JSON.stringify([fact.namespace, ...parts]);
  };
}
