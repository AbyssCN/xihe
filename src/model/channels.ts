/**
 * src/model/channels.ts — Channel economics model (V2-ECON channel layer).
 *
 * Discovers provider billing channels from declared plans, deduplicates by
 * provider+kind, and orders by amortization priority. All functions are pure;
 * no side effects, no I/O.
 *
 * Contract: $FUSANG_HOME/docs/plan/mimo-leaf-execution-contract.md (候选 D65, 未入本仓) §channel.
 * Invariants:
 *  - CH-1 · discovery output is deduplicated by (provider, kind) — last-write-wins.
 *  - CH-2 · orderByAmortization is immutable — returns new array, never mutates input.
 *  - CH-3 · BILLING_PRIORITY defines amortization order: lower index = amortize first.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** Billing dimension — what the provider actually charges for. */
export type BillingKind = "token" | "request" | "session" | "flat";
/** 配额窗类型 (切片1/G-4): rolling = 自首次故障起算的滑动窗; calendar/billing-cycle = 按边界重置。 */
export type WindowKind = "rolling" | "calendar" | "billing-cycle";

/**
 * 渠道配额窗 (可选, 切片1)。INV-3: 每条登记必须携带官方出处 (sourceUrl + 原文引句),
 * 查不到官方原文的渠道一律不登记 —— 出处缺失时该字段不出现, 运行时落回保守兜底。
 */
export interface QuotaWindow {
	/** 窗类型 */
	readonly windowKind: WindowKind;
	/** rolling: 窗长 ms (从首次故障起算)。calendar/billing-cycle 不用。 */
	readonly windowMs?: number;
	/** calendar/billing-cycle 边界规则 (自由文本; 实现按规则算边界, 未实现 → 不可算 → 兜底)。 */
	readonly boundaryRule?: string;
	/** 必填。官方文档 URL。INV-3 守卫: 测试断言每条登记 sourceUrl 为非空 https URL。 */
	readonly sourceUrl: string;
	/** 必填。官方原文引句, 逐字摘录, 禁止改写。 */
	readonly officialQuote: string;
}

/** 配额窗登记条目 (channelId 对齐 discoverChannels 的 `${provider}:${kind}`)。 */
export interface ChannelQuotaEntry {
	readonly channelId: string;
	readonly windows: readonly QuotaWindow[];
}

/** 聚合渠道 (一个 provider 托管多家族模型) 的 provider 基名。家族须从 modelId 品牌头解析。 */
// agy-cli (Google 订阅 CLI, 2026-09-11) 也是聚合渠道: 一个 provider 托管 gemini / claude / gpt-oss 三家族,
// 家族必须从 modelId 品牌头解析 —— 否则 `agy-cli:claude-opus-4-6-thinking` 坐 verifier 时会被判成
// 与 conductor 的 M3 「同族/异族」都不对 (它既不是 minimax 也不该自成 "agy-cli" 一族)。
const AGGREGATOR_PROVIDERS = new Set(["opencode", "agy-cli"]);
/** 品牌归一: 渠道别名 → 家族名 (INV-3/INV-7 跨家族判定用 zhipu 与 glm 同族等; openai-codex = ChatGPT 订阅渠道 → gpt 家族)。 */
const BRAND_ALIAS: Record<string, string> = {
	zhipu: "glm",
	xiaomi: "mimo",
	// 小米 token-plan 订阅三区 (pi-ai 原生 provider, 端点 token-plan-{ams,cn,sgp}.xiaomimimo.com) = mimo 族。
	// cn 的 -cn 会被 suffix strip 成 'xiaomi-token-plan'; ams/sgp 不被 strip, 故三个基名都列。
	"xiaomi-token-plan-ams": "mimo",
	"xiaomi-token-plan-sgp": "mimo",
	"xiaomi-token-plan": "mimo",
	"openai-codex": "gpt",
	openai: "gpt",
	// agy 托管的 Claude 与 Claude 订阅 SDK 通道同族 (品牌头 claude → claude-code)。
	claude: "claude-code",
};

/**
 * 坐标 → 模型家族 (INV-7 跨家族分散 / INV-3 verifier≠主力族 的判定单元)。
 * 规则: provider 剥渠道后缀 (-coding/-platform/-go/-cn/-us) 得基名; 基名是聚合渠道
 * (opencode) → 取 modelId 品牌头 (首段字母串: glm-5.2→glm, qwen3.7-max→qwen);
 * 否则家族 = 基名 (kimi-coding:k3→kimi, mimo-platform:*→mimo)。经 BRAND_ALIAS 归一。
 * 对齐 model-ratings lookupRating 的品牌桥接 (D-8 剥后缀) — 改一处核两处。
 */
export function modelFamily(coord: string): string {
	const sep = coord.indexOf(":");
	const provider = (sep >= 0 ? coord.slice(0, sep) : coord).toLowerCase();
	const modelId = sep >= 0 ? coord.slice(sep + 1).toLowerCase() : "";
	const base = provider.replace(/-(coding|platform|go|cn|us)$/i, "");
	if (AGGREGATOR_PROVIDERS.has(base) && modelId) {
		const brand = /^[a-z]+/.exec(modelId)?.[0] ?? base;
		return BRAND_ALIAS[brand] ?? brand;
	}
	return BRAND_ALIAS[base] ?? base;
}

/** A discovered billing channel: one (provider, kind) pair with its effective rate. */
export interface Channel {
	readonly id: string;
	readonly provider: string;
	readonly kind: BillingKind;
	/** Cost per unit (USD). Semantic meaning depends on `kind`:
	 *  token   → per-1M-token
	 *  request → per-request
	 *  session → per-session
	 *  flat    → per-month (or fixed period) */
	readonly rateUsd: number;
	/** Quota ceiling for this channel (requests/tokens/sessions, kind-dependent). 0 = unlimited. */
	readonly quota: number;
	/** Provider-declared plan name (e.g. 'free', 'pro', 'enterprise'). */
	readonly plan: string;
	/** 配额窗 (可选; 无官方出处/无算得清的边界 → 缺省, 运行时用保守兜底)。 */
	readonly quotaWindow?: QuotaWindow;
}

/** A provider-declared pricing plan, raw from config or discovery. */
export interface DeclaredPlan {
	readonly provider: string;
	readonly kind: BillingKind;
	readonly rateUsd: number;
	readonly quota?: number;
	readonly plan?: string;
}

/** Input to the channel discovery pipeline. */
export interface ChannelDiscoveryInput {
	/** Raw declarations from all providers (may contain duplicates). */
	readonly declared: readonly DeclaredPlan[];
	/** Optional allowlist — if set, only include these providers. */
	readonly providers?: readonly string[];
}

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Amortization priority: lower index = pay down first.
 * Rationale: sessions burn fastest (per-call), tokens are continuous,
 * requests are bounded, flat is background fixed cost.
 */
export const BILLING_PRIORITY: Readonly<Record<BillingKind, number>> = {
	session: 0,
	token: 1,
	request: 2,
	flat: 3,
} as const;

/**
 * 配额窗登记表 (切片1/INV-3): 只登记有官方出处 (sourceUrl + 原文引句) 且边界可算的渠道。
 * 裁定表 (2026-08 官方原文核验后, 查不到数的渠道一律不登记):
 *  · claude-code:session —— 官方确认存在 5 小时会话限额, 但 "rolling" 一词官方原文查不到
 *    (不得断言 rolling); 绝对上限数值与边界规则官方未给 → windowMs/boundaryRule 无可登记。
 *  · claude-code 周限额 (Opus) —— 存在性已确认, 绝对上限/窗边界官方原文查不到 → 不登记。
 *  · kimi 会员月配额 —— 仅 "连续包月/包年", 月起止规则官方未定义 → 不登记。
 *  · kimi-code 7 天刷新 —— 另一产品机制, 不得混入 Kimi 会员条目 (不挪用) → 不登记。
 *  · deepseek/minimax API —— 按量计费, 无配额窗 → 不适用。
 *  → 当前无渠道满足 INV-3, registry 为空合法 (fail-safe): 未命中 → PERIOD_COOLDOWN_MS 兜底。
 *    数据待官方原文补齐后再登记。
 */
export const CHANNEL_QUOTA_REGISTRY: readonly ChannelQuotaEntry[] = [];

// ── Functions ──────────────────────────────────────────────────────────────

/**
 * INV-3 校验单条配额窗登记: sourceUrl 必填且为 https 官方 URL, officialQuote 必填
 * (官方原文逐字摘录), channelId 必填。任一违规 → throw (闸变红, 不静默兜底)。
 * 纯函数、可注入任意条目 —— 与 registry 是否为空无关, 测试可拿违规样本证伪 (G-6):
 * 即使真 CHANNEL_QUOTA_REGISTRY 为空 (空表合法), 闸也仍可变红。
 */
export function validateQuotaEntry(entry: ChannelQuotaEntry): void {
	if (!entry.channelId || entry.channelId.length === 0) {
		throw new Error(`[INV-3] 配额窗登记缺少 channelId`);
	}
	for (const w of entry.windows) {
		if (!w) {
			throw new Error(`[INV-3] 配额窗登记 ${entry.channelId} 含空窗条目`);
		}
		if (!w.sourceUrl || w.sourceUrl.length === 0) {
			throw new Error(`[INV-3] 配额窗登记 ${entry.channelId} 缺少 sourceUrl (官方文档 URL 必填)`);
		}
		if (!/^https:\/\//.test(w.sourceUrl)) {
			throw new Error(`[INV-3] 配额窗登记 ${entry.channelId} 的 sourceUrl 非 https 官方 URL: ${w.sourceUrl}`);
		}
		if (!w.officialQuote || w.officialQuote.length === 0) {
			throw new Error(`[INV-3] 配额窗登记 ${entry.channelId} 缺少 officialQuote (官方原文引句必填)`);
		}
	}
}

/**
 * INV-3 校验整张登记表: 逐条 validateQuotaEntry, 任一违规 → throw。
 * 空表合法 (fail-safe): 查不到官方原文的渠道一律不登记, 运行时落回 PERIOD_COOLDOWN_MS。
 */
export function validateQuotaRegistry(registry: readonly ChannelQuotaEntry[]): void {
	for (const e of registry) validateQuotaEntry(e);
}

/** Deterministic channel ID from (provider, kind). */
const channelId = (provider: string, kind: BillingKind): string =>
	`${provider}:${kind}`;

/**
 * Discover billing channels from declared plans.
 *
 * CH-1: deduplicates by (provider, kind) — last declaration wins.
 * Optionally filters to an allowlist of providers.
 */
export function discoverChannels(input: ChannelDiscoveryInput): Channel[] {
	const { declared, providers: allowlist } = input;

	// Dedup by (provider, kind) — last-write-wins via Map insertion order.
	const byKey = new Map<string, Channel>();

	for (const d of declared) {
		// Filter: skip if allowlist set and provider not in it.
		if (allowlist && !allowlist.includes(d.provider)) continue;

		const key = channelId(d.provider, d.kind);
		byKey.set(key, {
			id: key,
			provider: d.provider,
			kind: d.kind,
			rateUsd: d.rateUsd,
			quota: d.quota ?? 0,
			plan: d.plan ?? "default",
		});
	}

	return [...byKey.values()];
}

/**
 * Order channels by amortization priority (BILLING_PRIORITY), then by id
 * for deterministic tie-breaking. Immutable — returns new array.
 *
 * CH-2: never mutates input.
 * CH-3: lower BILLING_PRIORITY index = earlier in output.
 */
export function orderByAmortization(channels: readonly Channel[]): Channel[] {
	return [...channels].sort((a, b) => {
		const pa = BILLING_PRIORITY[a.kind];
		const pb = BILLING_PRIORITY[b.kind];
		if (pa !== pb) return pa - pb;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}
