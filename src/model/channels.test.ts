/**
 * channels.test.ts — discoverChannels / orderByAmortization 测试。
 * 覆盖: 基础发现 · last-write-wins 去重 · allowlist 过滤 ·
 * orderByAmortization 混合排序 (session→token→request→flat) · 不可变性 · 空输入。
 */
import { describe, expect, test } from "bun:test";
import {
	type Channel,
	type DeclaredPlan,
	BILLING_PRIORITY,
	discoverChannels,
	modelFamily,
	orderByAmortization,
} from "./channels";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Shorthand to build a DeclaredPlan with sensible defaults. */
const plan = (
	p: Partial<DeclaredPlan> & Pick<DeclaredPlan, "provider" | "kind">,
): DeclaredPlan => ({
	rateUsd: 1,
	...p,
});

describe("discoverChannels", () => {
	test("单条 declared → 一个 channel, id = provider:kind, quota 默认 0, plan 默认 default", () => {
		const out = discoverChannels({
			declared: [plan({ provider: "openai", kind: "token", rateUsd: 2.5 })],
		});
		expect(out).toHaveLength(1);
		expect(out[0]!).toEqual({
			id: "openai:token",
			provider: "openai",
			kind: "token",
			rateUsd: 2.5,
			quota: 0,
			plan: "default",
		});
	});

	test("quota / plan 可选字段正确透传", () => {
		const out = discoverChannels({
			declared: [
				plan({
					provider: "anthropic",
					kind: "session",
					rateUsd: 10,
					quota: 500,
					plan: "pro",
				}),
			],
		});
		expect(out[0]!.quota).toBe(500);
		expect(out[0]!.plan).toBe("pro");
	});

	test("CH-1 去重: 同 (provider, kind) 两条 → last-write-wins", () => {
		const out = discoverChannels({
			declared: [
				plan({ provider: "x", kind: "token", rateUsd: 1 }),
				plan({ provider: "x", kind: "token", rateUsd: 99 }),
			],
		});
		expect(out).toHaveLength(1);
		expect(out[0]!.rateUsd).toBe(99);
	});

	test("不同 provider 同 kind → 不去重", () => {
		const out = discoverChannels({
			declared: [
				plan({ provider: "a", kind: "token" }),
				plan({ provider: "b", kind: "token" }),
			],
		});
		expect(out).toHaveLength(2);
	});

	test("同 provider 不同 kind → 不去重", () => {
		const out = discoverChannels({
			declared: [
				plan({ provider: "x", kind: "token" }),
				plan({ provider: "x", kind: "flat" }),
			],
		});
		expect(out).toHaveLength(2);
	});

	test("allowlist 过滤: 只保留白名单内 provider", () => {
		const out = discoverChannels({
			declared: [
				plan({ provider: "a", kind: "token" }),
				plan({ provider: "b", kind: "token" }),
				plan({ provider: "c", kind: "token" }),
			],
			providers: ["a", "c"],
		});
		expect(out.map((c) => c.provider).sort()).toEqual(["a", "c"]);
	});

	test("空 allowlist → 全部过滤掉", () => {
		const out = discoverChannels({
			declared: [plan({ provider: "a", kind: "token" })],
			providers: [],
		});
		expect(out).toHaveLength(0);
	});
});

describe("orderByAmortization", () => {
	test("CH-3: session(0) → token(1) → request(2) → flat(3)", () => {
		const input: Channel[] = [
			{
				id: "f",
				provider: "p",
				kind: "flat",
				rateUsd: 1,
				quota: 0,
				plan: "default",
			},
			{
				id: "a",
				provider: "p",
				kind: "token",
				rateUsd: 1,
				quota: 0,
				plan: "default",
			},
			{
				id: "d",
				provider: "p",
				kind: "session",
				rateUsd: 1,
				quota: 0,
				plan: "default",
			},
			{
				id: "e",
				provider: "p",
				kind: "request",
				rateUsd: 1,
				quota: 0,
				plan: "default",
			},
		];
		const sorted = orderByAmortization(input);
		expect(sorted.map((c) => c.kind)).toEqual([
			"session",
			"token",
			"request",
			"flat",
		]);
	});

	test("同 kind 内按 id 字典序 tie-break", () => {
		const input: Channel[] = [
			{
				id: "z:token",
				provider: "z",
				kind: "token",
				rateUsd: 1,
				quota: 0,
				plan: "default",
			},
			{
				id: "a:token",
				provider: "a",
				kind: "token",
				rateUsd: 1,
				quota: 0,
				plan: "default",
			},
		];
		const sorted = orderByAmortization(input);
		expect(sorted[0]!.id).toBe("a:token");
		expect(sorted[1]!.id).toBe("z:token");
	});

	test("CH-2: 不可变 — 返回新数组,不修改输入", () => {
		const input: Channel[] = [
			{
				id: "b",
				provider: "p",
				kind: "flat",
				rateUsd: 1,
				quota: 0,
				plan: "default",
			},
			{
				id: "a",
				provider: "p",
				kind: "session",
				rateUsd: 1,
				quota: 0,
				plan: "default",
			},
		];
		const copy = [...input];
		const sorted = orderByAmortization(input);
		// 原数组不动
		expect(input[0]!.kind).toBe("flat");
		expect(input[1]!.kind).toBe("session");
		// 新数组排好了
		expect(sorted[0]!.kind).toBe("session");
		expect(sorted[1]!.kind).toBe("flat");
		// 引用不同
		expect(sorted).not.toBe(input);
	});

	test("空数组 → 空数组", () => {
		expect(orderByAmortization([])).toEqual([]);
	});

	test("单元素 → 原样返回", () => {
		const ch: Channel = {
			id: "x",
			provider: "p",
			kind: "request",
			rateUsd: 1,
			quota: 0,
			plan: "default",
		};
		const sorted = orderByAmortization([ch]);
		expect(sorted).toHaveLength(1);
		expect(sorted[0]!.kind).toBe("request");
	});
});

describe("modelFamily (INV-7/INV-3 家族判定)", () => {
	test("渠道后缀剥离: kimi-coding→kimi, mimo-platform→mimo", () => {
		expect(modelFamily("kimi-coding:k3")).toBe("kimi");
		// agy-cli 是聚合渠道 (2026-09-11): 家族从 modelId 品牌头解析, agy 托管的 Claude 与 claude-code SDK 通道同族。
		expect(modelFamily("agy-cli:gemini-3.8-flash-high")).toBe("gemini");
		expect(modelFamily("agy-cli:claude-opus-4-6-thinking")).toBe("claude-code");
		expect(modelFamily("agy-cli:claude-opus-4-6-thinking")).toBe(modelFamily("claude-code:claude-opus-5"));
		expect(modelFamily("mimo-platform:mimo-v2.5-pro-ultraspeed")).toBe("mimo");
		expect(modelFamily("mimo:mimo-v2.5")).toBe("mimo");
	});

	test("聚合渠道按 modelId 品牌头: opencode-go 托管多家族", () => {
		expect(modelFamily("opencode-go:glm-5.2")).toBe("glm");
		expect(modelFamily("opencode-go:qwen3.7-max")).toBe("qwen");
		expect(modelFamily("opencode-go:minimax-m3")).toBe("minimax");
		expect(modelFamily("opencode-go:deepseek-v4-flash")).toBe("deepseek");
	});

	test("品牌归一: zhipu 与 opencode-go 的 glm 同族 (INV-3 判同才有意义)", () => {
		expect(modelFamily("zhipu:glm-4.7")).toBe(modelFamily("opencode-go:glm-5.2"));
		expect(modelFamily("minimax-cn:minimax-m3")).toBe(modelFamily("opencode-go:minimax-m3"));
	});

	test("openai-codex (ChatGPT 订阅渠道) → gpt 家族 (INV-3: verifier glm ≠ gpt 大脑)", () => {
		expect(modelFamily("openai-codex:gpt-5.6-sol")).toBe("gpt");
		expect(modelFamily("openai:gpt-5.4")).toBe("gpt");
	});

	test("裸 provider 坐标不炸", () => {
		expect(modelFamily("deepseek")).toBe("deepseek");
	});
});

describe("BILLING_PRIORITY", () => {
	test("四种 kind 全覆盖,值严格递增", () => {
		const kinds = ["session", "token", "request", "flat"] as const;
		const vals = kinds.map((k) => BILLING_PRIORITY[k]!);
		// 全覆盖
		expect(vals).toHaveLength(4);
		// 严格递增
		for (let i = 1; i < vals.length; i++) {
			expect(vals[i]!).toBeGreaterThan(vals[i - 1]!);
		}
	});
});
