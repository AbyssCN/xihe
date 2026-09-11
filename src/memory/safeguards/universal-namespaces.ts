/**
 * src/memory/safeguards/universal-namespaces —— omd **通用默认记忆 pack** (P1#1, 面向所有人)。
 *
 * 跟 a sibling project domain pack (会计) 平行, 但这套**任何 omd instance 都自带** (开源打开即有):
 *   - `user.*` (6 facet): 记住**用户**的方方面面 (喜欢/在意/关注/会什么/是谁/要什么)。克制的 facet
 *     类型 + category/value 半结构字段 → 覆盖广而不堆 namespace ("太多数据"是失败模式, the owner 锁)。
 *   - `omd.*` (3 facet): omd 记住**自己** (擅长什么/什么做法管用/受什么限) —— 自我进化的底座。
 *     刻意**不**镜像 live 工具/skill 注册表 (那能自省, memorize 冗余); 只记靠经验才知道的自评胜任度。
 *
 * 每条 fact 仍走 kernel 机制 (source anchor + 3 级 confidence + supersede + dream curate)。
 * 无 banGlobs (ban 是辖区/domain 的事, 见 a sibling project pack)。
 */
import { z } from 'zod';
import {
  sourceAnchor,
  confidenceField,
  assembleSafeguard,
  type NamespacePack,
  type AssembledSafeguard,
} from './namespace-kernel';

// ---------------------------------------------------------------------------
// 代码锚 —— 一条 omd.* 主张挂在哪几个文件的哪个版本上 (L2, 2026-08-28)。
// ---------------------------------------------------------------------------

/**
 * 一条主张的**物理证据**:仓相对路径 + 该文件当时的内容指纹。
 *
 * ## 为什么是内容指纹, 不是 git commit
 *
 * OpenWiki 用 commit hash 是因为它要 diff 行区间; omd 只需要回答"变了没有"。内容 sha 严格更强:
 * 未提交的改动也算 (commit hash 看不见), 不依赖 git (worktree / 非 git 目录也能判)。
 * 口径与 `continuity/checkpoint-manager.ts:610` 的 `hashArtifact` 一致 —— sha256 前 16 hex。
 *
 * ## 为什么路径必须是仓相对
 *
 * 绝对路径把事实钉死在一台机器的一个目录上。omd 的记忆库要能跟着仓走 (worktree / 换机 / 换 checkout),
 * 存 `/home/nick/repos/...` 等于第一次换目录就全体变成 `missing`。**闸在这里, 不在读侧**:
 * 读侧只能猜, 写侧知道自己在哪。
 *
 * ## 上限 5
 *
 * 一条主张挂 20 个文件等于没挂 —— 那种"证据"里总有一个会变, 于是它永远 stale, 读侧只好无视这一列。
 * 挂不到 5 个以内说明这条主张太大, 该拆。
 */
export const EvidenceAnchorSchema = z.object({
  /** 仓相对路径 (绝对路径拒收 —— 见上注)。 */
  path: z
    .string()
    .min(1)
    .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p), {
      message: 'evidence.path 必须是仓相对路径 (绝对路径不可移植)',
    }),
  /** 写入当时该文件的 sha256 前 16 hex。 */
  sha: z.string().regex(/^[0-9a-f]{16}$/, 'evidence.sha 必须是 sha256 前 16 hex'),
});
export type EvidenceAnchor = z.infer<typeof EvidenceAnchorSchema>;

/**
 * 可选的代码锚列表。**optional 而不是必填**:81 条既有 omd.pattern 一条锚都没有,
 * 必填会把它们全部变成不可重写的历史包袱。缺席 = `unanchored`,读侧当第四种状态处理,
 * **不折成 fresh** (见 `harness/memory/staleness.ts`)。
 */
export const evidenceField = {
  evidence: z.array(EvidenceAnchorSchema).min(1).max(5).optional(),
} as const;

// ---------------------------------------------------------------------------
// user.* —— 记住用户 (6 facet)。第一级 facet 类型克制, 第二级 category/value 内容开放。
// ---------------------------------------------------------------------------

const USER_BRANCHES = [
  // 他喜欢东西怎么做 (沟通/格式/语气/工具/作息 …)。
  z.object({
    namespace: z.literal('user.preference'),
    category: z.string().min(1),
    value: z.string().min(1),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 他在意/关注的领域话题。
  z.object({
    namespace: z.literal('user.interest'),
    topic: z.string().min(1),
    note: z.string().min(1).optional(),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 他当前的关注点 (转瞬, 新写覆盖同 focus)。
  z.object({
    namespace: z.literal('user.focus'),
    focus: z.string().min(1),
    started_at: z.coerce.date(),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 他的技能/专长。
  z.object({
    namespace: z.literal('user.expertise'),
    domain: z.string().min(1),
    level: z.enum(['expert', 'proficient', 'familiar']),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 他是谁: 价值观/工作风格/身份/性格。
  z.object({
    namespace: z.literal('user.trait'),
    category: z.string().min(1),
    statement: z.string().min(1),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 他要达成什么。
  z.object({
    namespace: z.literal('user.goal'),
    goal: z.string().min(1),
    status: z.enum(['active', 'paused', 'done']),
    horizon: z.enum(['now', 'quarter', 'year']),
    ...sourceAnchor,
    ...confidenceField,
  }),
];

// ---------------------------------------------------------------------------
// omd.* —— omd 记住自己 (3 facet)。自评 learned 自我认知, 非工具清单镜像。
// ---------------------------------------------------------------------------

/** omd.pattern 的受控 scope 枚举 (dream SDD 终审裁决 5, 逐字冻结)。dream 写入侧必带 (validate 硬拒); pathfinder 等既有写手可缺省。 */
export const OMD_PATTERN_SCOPES = ['chat-correction', 'plan-family', 'oracle', 'seat'] as const;

/**
 * omd.pattern 的 **subject** (2026-09-11, T-H 修): identity 的第二个受控槽。
 * 实测 384 条 pattern = 384 个 identity —— situation/approach 是自由文本, 同一教训换措辞就是新身份,
 * 晋升 (3 证据 ∧ 2 来源) 一次都没触发过 (agent_confident = 0)。identity 改成 [scope, subject]:
 * situation/approach/outcome 降为 value, 同一主题的新教训**取代**旧的 (旧行 tombstone, 演化日志留痕),
 * 证据在 identity 上累积, 晋升才有可能触发。
 * 形状: 小写 slug, 2–48 字符。按 scope 的取法:
 *   plan-family → `family:<familyId>` (代码从 plan-ledger 机械附加, 模型不作者化);
 *   oracle      → {@link OMD_ORACLE_SUBJECTS} 之一 (闭集);
 *   seat        → 座位坐标 slug (如 `minimax-cn-minimax-m3`);
 *   chat-correction → situation 的机械 slug (`subjectSlugOf`)。
 */
export const OMD_PATTERN_SUBJECT_RE = /^[a-z0-9][a-z0-9._:-]{1,47}$/;
export const OMD_ORACLE_SUBJECTS = ['verifier', 'acceptance-command', 'self-check', 'frozen-criterion', 'write-set', 'judge', 'env', 'other'] as const;

/** 自由文本 → subject slug (机械, 确定性): 小写, 非字母数字折成 `-`, 截 48。空 → 'other'。 */
export function subjectSlugOf(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  // 中文字符不在 RE 里 (RE 只认 ascii): 有中文的先转成长度稳定的短哈希前缀, 保证可比又合法。
  if (!s) return 'other';
  if (/[\u4e00-\u9fff]/.test(s)) {
    let h = 0;
    for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `zh-${h.toString(36)}`;
  }
  return s.length < 2 ? `${s}-x` : s;
}

const OMD_BRANCHES = [
  // 我擅长什么 (领域 + 自评熟练度 spectrum: expert→weak)。
  z.object({
    namespace: z.literal('omd.capability'),
    area: z.string().min(1),
    level: z.enum(['expert', 'proficient', 'weak']),
    note: z.string().min(1).optional(),
    ...sourceAnchor,
    ...confidenceField,
  }),
  // 什么做法在什么情况管用/失败 (程序性学习, 自我进化核心燃料)。
  // scope = 受控判别字段 (dream SDD 终审裁决 5): situation/approach 是自由文本,
  // 同一教训换措辞就是新 identity, 复现永远攒不够 3 —— 受控枚举把 identity 空间切回可比。
  // optional: pathfinder 裁决写入 (pathfinder.ts) 等既有写手不带它; Zod 剥未声明键,
  // 不声明的话 dream 写的 scope 会被静默剥掉 (writeFact 落库的是 parsed.data)。
  z.object({
    namespace: z.literal('omd.pattern'),
    situation: z.string().min(1),
    approach: z.string().min(1),
    outcome: z.enum(['worked', 'failed']),
    scope: z.enum(OMD_PATTERN_SCOPES).optional(),
    // subject (2026-09-11): identity 第二槽, 见 OMD_PATTERN_SUBJECT_RE 注。optional 同 scope 的理由 (既有写手不带)。
    subject: z.string().regex(OMD_PATTERN_SUBJECT_RE).optional(),
    ...sourceAnchor,
    ...evidenceField,
    ...confidenceField,
  }),
  // 我的硬约束/边界/盲区 (预算/不可做/已知弱点)。
  z.object({
    namespace: z.literal('omd.limit'),
    kind: z.enum(['budget', 'boundary', 'blindspot']),
    statement: z.string().min(1),
    ...sourceAnchor,
    ...evidenceField,
    ...confidenceField,
  }),
];

// ---------------------------------------------------------------------------
// identity fields (supersession) + pack 装配。
// ---------------------------------------------------------------------------

export const USER_NAMESPACE_IDENTITY_FIELDS: Record<string, readonly string[]> = {
  'user.preference': ['category'],
  'user.interest': ['topic'],
  'user.focus': ['focus'],
  'user.expertise': ['domain'],
  'user.trait': ['category'],
  'user.goal': ['goal'],
};

export const OMD_NAMESPACE_IDENTITY_FIELDS: Record<string, readonly string[]> = {
  'omd.capability': ['area'],
  // 2026-09-11 (T-H): identity 从 [situation, approach, scope] 收窄到 [scope, subject]。
  // situation/approach 是自由文本 → 384 条 384 身份, 晋升永不触发。approach/outcome 降为 value:
  // 同一主题的新教训取代旧教训 (旧行 tombstone + 演化日志), 证据在 identity 上累积。
  // 不带 subject 的写手/旧行走 OMD_NAMESPACE_LEGACY_IDENTITY_FIELDS 的旧键 (kernel 回落), 不迁移。
  'omd.pattern': ['scope', 'subject'],
  'omd.limit': ['kind', 'statement'],
};

/** 旧键 (2026-09-11 前的 omd.pattern identity): subject 缺席的 fact 按它分身, 见 kernel makeIdentityKeyOf。 */
export const OMD_NAMESPACE_LEGACY_IDENTITY_FIELDS: Record<string, readonly string[]> = {
  'omd.pattern': ['situation', 'approach', 'scope'],
};

const namespaceLiterals = (branches: readonly z.ZodObject<z.ZodRawShape>[]): string[] =>
  branches.map((b) => (b.shape.namespace as z.ZodLiteral<string>).value);

/** 通用 user.* pack (记住用户)。无 banGlobs。 */
export const USER_NAMESPACE_PACK: NamespacePack = {
  branches: USER_BRANCHES,
  allowedNamespaces: namespaceLiterals(USER_BRANCHES),
  identityFields: USER_NAMESPACE_IDENTITY_FIELDS,
  banGlobs: [],
};

/** 通用 omd.* pack (omd 记住自己)。无 banGlobs。 */
export const OMD_NAMESPACE_PACK: NamespacePack = {
  branches: OMD_BRANCHES,
  allowedNamespaces: namespaceLiterals(OMD_BRANCHES),
  identityFields: OMD_NAMESPACE_IDENTITY_FIELDS,
  legacyIdentityFields: OMD_NAMESPACE_LEGACY_IDENTITY_FIELDS,
  banGlobs: [],
};

// 精确 per-namespace 类型不导出 (消费者只用共享字段; 单一 loose ValidatedFact 在 facade 定义)。

/**
 * 纯通用装配 (user.* + omd.*, **零 domain**)。任何 omd instance 都自带; domain-free 的前端
 * (TUI omd 自我记忆) 注入它 → 只收用户/自身 fact, 拒一切 domain (会计 client.* 等) namespace。
 * 无 banGlobs (GDPR 等 ban 属辖区/domain pack, 见 a sibling project)。
 */
export const UNIVERSAL_SAFEGUARD: AssembledSafeguard = assembleSafeguard([
  USER_NAMESPACE_PACK,
  OMD_NAMESPACE_PACK,
]);
