/**
 * src/harness/plan-passes/evidence-pass —— pass 管线 ③ evidence: 证据链结构闸 (SDD 2026-07-25 S2)。
 * 契约来源: docs/plan/2026-07-25-skills-compile-evidence-gate.md D-2/D-3 + S2 契约段。
 *
 * 语义: 节点引用的 agent 模板卡声明 evidence:'ui-pixels' ⇒ 该节点必须存在一个跑
 *   `omd-shots-verify` 的后代 command 节点 (它内部要求截图真存在、非空、不是白板)。
 * 缺链 → 程序化补挂 [渲染 command → 校验 command]; 补不出来 (无可渲染目标) → 抛错拒 plan。
 *
 * **地板为什么是确定性的, 不是多模态审查** (2026-07-26 owner 裁决, 有实测支撑):
 * 原本地板是"派一个多模态模型去看一眼"。全栈 eval 实测: 6 次跑只有 1 次真产出截图, 唯一产出的
 * 那次种下的四个崩坏一个都没被提到 —— 而主指标 pass 依然 1.000。**模型判断那一环不仅贵,
 * 失败还是静默的**: 证据链断了, 读数上完全看不出来。
 * 改成零模型可计算之后: 没跑就是没跑, 白板就是红的。
 *
 * 看得懂设计好不好是**品味**, 交给 HITL 或图外 —— 不该由一个便宜模型在图里假装做完。
 * attach_media 审查仍然允许接在后面 (omd-shots-verify 的 stdout 就是图片路径), 只是**不再强制**。
 *
 * **管线位置 (对 SDD「planFilters 链尾」的回流修正)**: 实装在 dedup 之后、**stamp 之前**。
 * SDD 写「链尾」时没考虑本 pass 会**新增节点** —— 排在 stamp 后, 补挂的 attach_media 审查 leaf
 * 拿不到 stamp 分配的多模态池模型 (D-14v2 的「非多模态模型看不见图」正是它要防的事), 证据链会
 * 补了等于没补。故: 改图形状的 pass 必须在 stamp 之前。
 *
 * 纯函数: 零 IO / 零 logger / 不变异输入 (日志在接线层, 同 INV-8)。
 *
 * Invariants:
 *  EVD-1 零回归恒等: 无 evidence 卡命中 → 返回原 plan 引用 (同 INV-9)。
 *  EVD-2 幂等: 补挂后的 plan 再过一次本 pass = 恒等 (链已存在 → 不重复补)。
 *  EVD-3 补挂即满足: 补完自检一次, 仍不满足 → 抛错 (拒 plan), 不放行「补了个假的」。
 *  EVD-4 不越界: 无 evidence 卡的节点一个字段都不碰。
 */
import type { AgentTemplate } from "../agent-templates";
import type { ConductorPlan } from "../conductor-plan";
import { describeRenderProbe, type RenderProbe } from "./render-command";

type PlanNode = ConductorPlan["nodes"][string];

/** 本 pass 认识的证据类 (v1 唯一; 词表真源在 agent-templates.KNOWN_EVIDENCE_CLASSES)。 */
const UI_PIXELS = "ui-pixels";

/** 确定性截图闸的 CLI (结构闸按名认它 —— 认的是我们自己的工具, 不是猜命令语义)。 */
const SHOTS_VERIFY_CLI = "omd-shots-verify";

/** 可直接喂给 omd-render 的产物后缀 (静态页); 其余后缀无法当渲染目标。 */
const RENDERABLE_EXT = /\.(html?|htm)$/i;

export interface EvidencePassResult {
	plan: ConductorPlan;
	/** 补挂的节点 id (字典序; 空 = 未改图)。 */
	patched: string[];
	/**
	 * D-11 挖矿信号「无卡命中」: goal 看着是 UI 活、却没引用任何模板卡的节点 id。
	 * 纯日志用 (不改行为) —— S4 卡自扩的前置数据: 哪些活反复出现却没人给它卡。
	 */
	noCardHits: string[];
	/** D-11 图形状指纹 (确定性): 节点数/边数/executor 多重集。与 goal + oracle 结果凑三元组。 */
	shape: string;
	/**
	 * EVD-5 (2026-08-11):**降级为 diff-only 审**的命中节点 id + 理由 (无可渲染目标)。
	 *
	 * 为什么从"拒 plan"改成"降级留痕":原判据要求命中节点有 `.html/.htm` 的 `output_path` 才补得出
	 * 渲染步,取不到就抛错拒**整张** plan。而本仓前端全是 Vite 应用里的 `.tsx` 组件 ——
	 * **永远不会有独立 HTML 产物**,于是 `frontend-impl` 这张卡在本仓等于不可用:conductor 一挑中它,
	 * 规划期整图当场被拒,一个节点都不跑 (实测两次:run `ea124f36` / `02a5e3bb`)。
	 * 「采集是地板」这条在**有渲染目标的项目里**成立,在没有的项目里它不是地板是墙。
	 *
	 * 降级取 `leaf-profile` SDD D-10 的同款出口:**无截图能力的项目退化为 diff-only 审**。
	 * 代价明写:这些节点的像素证据链**确实没有**,所以 fail-open 但**不吞证据** ——
	 * 逐个记 id 与理由,由接线层 warn 出来,读的人看得见"这一格降级了"而不是以为它过了闸。
	 */
	degraded: Array<{ id: string; reason: string }>;
}

/**
 * S2 证据闸。templates = 注册表 (name → 卡), 由接线层注入 (本 pass 不读盘)。
 * @throws 补挂后仍缺链 (EVD-3 自检: 补挂逻辑有洞) —— 那是引擎 bug, 仍 fail-closed。
 *         无可渲染目标**不再抛** (EVD-5 降级, 见 {@link EvidencePassResult.degraded})。
 */
export function evidencePass(
	plan: ConductorPlan,
	opts: {
		templates: Map<string, AgentTemplate>;
		/**
		 * 本仓怎么渲染自己 (2026-09-05, `plan-passes/render-command` 探)。
		 * 有**显式声明**时, 非 HTML 交付物也接得出像素证据链 —— 组件化的仓 (`.tsx`/`.vue`/`.svelte`)
		 * 此前一律走 EVD-5 降级, 品味审查只看得到 diff 看不到像素。
		 * 缺省 undefined = 保持原行为 (纯函数, 探测在接线层做, 同 INV-8)。
		 */
		render?: RenderProbe;
	},
): EvidencePassResult {
	const ids = Object.keys(plan.nodes);
	const shape = shapeOf(plan);
	const noCardHits = ids.filter((id) => !plan.nodes[id]!.template && looksLikeUiWork(plan.nodes[id]!)).sort();

	// ① 命中: 引用的卡声明 evidence:'ui-pixels' 的节点 (EVD-4 其余节点不碰)。
	// attach_media 节点排除: 它是**看**像素的一端 (审查 leaf), 不是产 UI 的一端 —— 若也算命中,
	// 补挂的审查节点自己又要一条链, 递归自噬 (卡词表哪天给 ui-reviewer 加 evidence 就会踩到)。
	const hits = ids.filter((id) => {
		const n = plan.nodes[id]!;
		if (n.attach_media === true) return false;
		return n.template !== undefined && opts.templates.get(n.template)?.evidence === UI_PIXELS;
	});
	if (hits.length === 0) return { plan, patched: [], noCardHits, shape, degraded: [] }; // EVD-1

	// ② 逐个命中节点验链; 缺链的攒补丁 (EVD-2: 已有链的原样跳过)。
	const nodes: ConductorPlan["nodes"] = { ...plan.nodes };
	const patched: string[] = [];
	const degraded: EvidencePassResult['degraded'] = [];
	for (const id of hits) {
		if (hasEvidenceChain(nodes, id)) continue;
		const r = patchChain(nodes, id, opts.render);
		if (r.degradedReason) degraded.push({ id, reason: r.degradedReason });
		else patched.push(...r.ids);
	}
	if (patched.length === 0) return { plan, patched: [], noCardHits, shape, degraded }; // EVD-1 恒等

	// ③ EVD-3 补挂即满足自检: 补完仍缺链 = 补挂逻辑有洞, 宁可拒 plan 也不放行假证据链。
	const next: ConductorPlan = { ...plan, nodes };
	// 降级节点本来就没链 (EVD-5), 不算"补挂逻辑有洞" —— 排除它们, 否则自检会把降级误判成引擎 bug。
	const degradedIds = new Set(degraded.map((d) => d.id));
	const stillMissing = hits.filter((id) => !degradedIds.has(id) && !hasEvidenceChain(nodes, id));
	if (stillMissing.length > 0) {
		throw new Error(
			`evidence-pass: 补挂后仍缺 ui-pixels 证据链: ${stillMissing.join(", ")} (闸不可绕, 见 SDD S2/D-2)`,
		);
	}
	patched.sort();
	return { plan: next, patched, noCardHits, shape, degraded };
}

/**
 * 节点 id 是否已有确定性截图闸后代 —— 一个跑 omd-shots-verify 的 command 节点。
 * 渲染步不必单独结构校验: 没渲染 → 没图 → 这道闸运行时自己会红。**判据收敛成一条, 更强也更简单。**
 */
function hasEvidenceChain(nodes: ConductorPlan["nodes"], id: string): boolean {
	return descendantsOf(nodes, id).some(
		(d) => nodes[d]!.executor === "command" && (nodes[d]!.command ?? "").includes(SHOTS_VERIFY_CLI),
	);
}

/** 传递闭包: 所有 (直接/间接) 依赖 id 的节点。幻象 dep 自然被忽略 (只走 nodes 内的边)。 */
function descendantsOf(nodes: ConductorPlan["nodes"], id: string): string[] {
	const out = new Set<string>();
	const queue = [id];
	while (queue.length > 0) {
		const cur = queue.pop()!;
		for (const [nid, n] of Object.entries(nodes)) {
			if (out.has(nid) || nid === id) continue;
			if ((n.depends_on ?? []).includes(cur)) {
				out.add(nid);
				queue.push(nid);
			}
		}
	}
	return [...out];
}

/**
 * 给节点 id 补 [渲染 command → omd-shots-verify 确定性闸] 两个 command 节点, 就地写进 nodes, 返回新 id。
 * 不补 attach_media 审查 leaf: 品味审查是闸后可选挂载, 不属于地板 (见文件头)。
 * 渲染目标取该节点声明的 output_path (须是可渲染后缀) —— 取不到就没有可截图的东西,
 * 抛错拒 plan (D-2: 采集是地板; 与其挂一个必然失败的命令假装有证据链, 不如让 owner/conductor 补 output_path)。
 */
function patchChain(
	nodes: ConductorPlan["nodes"],
	id: string,
	render?: RenderProbe,
): { ids: string[]; degradedReason?: string } {
	const node = nodes[id]!;
	const target = node.output_path;
	if (!target || !RENDERABLE_EXT.test(target)) {
		// EVD-6 (2026-09-05): 无 HTML 目标但**仓显式声明了渲染命令** → 用它接链, 不再降级。
		// 组件化的仓 (.tsx/.vue/.svelte) 此前 100% 走 EVD-5, 于是品味审查只看得到 diff ——
		// 那一格是静默的 (实账 plana: design-review 节点挂上来了却 attach_media 无可用媒体)。
		// ⚠ 只认**显式声明**: 探测到的候选不带 outDir, 猜错落点会让 omd-shots-verify 假红,
		//   而一条必然失败的命令比没有命令更坏 —— 它把"没证据"伪装成"证据是红的"。
		if (render?.command) return patchWithRepoRender(nodes, id, render.command);
		// EVD-5: 无可渲染目标 → **降级为 diff-only 审**, 不再拒整张 plan (理由见 EvidencePassResult.degraded)。
		// 判词带上探测结果 —— 让"为什么没有像素"变成一句照着做就能修的话, 而不是一句现象描述。
		return {
			ids: [],
			degradedReason:
				`无可渲染目标 (output_path=${target ?? "(未声明)"}) —— 像素证据链缺席, 本节点退化为 diff-only 审。` +
				(render ? ` ${describeRenderProbe(render)}` : ""),
		};
	}
	const renderId = freshId(nodes, `${id}-render`);
	const verifyId = freshId(nodes, `${id}-shots-verify`);
	const renderNode: PlanNode = {
		goal: `渲染 ${target} 截图, 打印产物图片路径 (证据采集步, 由 evidence-pass 补挂)`,
		executor: "command",
		command: `bun run scripts/omd-render.ts ${target} --out .omd/render/${renderId}`,
		depends_on: [id],
	};
	const verifyNode: PlanNode = {
		goal: `校验 ${target} 的截图真存在、非空、不是白板 (确定性证据闸, 零模型, 由 evidence-pass 补挂)`,
		executor: "command",
		command: `bun run scripts/${SHOTS_VERIFY_CLI}.ts .omd/render/${renderId}`,
		depends_on: [renderId],
		requires: "all",
	};
	nodes[renderId] = renderNode;
	nodes[verifyId] = verifyNode;
	return { ids: [renderId, verifyId] };
}

/**
 * 用**仓自己声明的**渲染命令接链 (EVD-6)。与 patchChain 的 HTML 分支同形状, 只是渲染那步换成仓的命令、
 * 截图落点换成仓声明的 outDir —— omd-shots-verify 仍是同一道零模型闸 (它才是地板)。
 */
function patchWithRepoRender(
	nodes: ConductorPlan["nodes"],
	id: string,
	render: { command: string; outDir: string; provenance: string },
): { ids: string[] } {
	const renderId = freshId(nodes, `${id}-render`);
	const verifyId = freshId(nodes, `${id}-shots-verify`);
	nodes[renderId] = {
		goal: `跑本仓声明的渲染命令产截图 (来源 ${render.provenance}; 证据采集步, 由 evidence-pass 补挂)`,
		executor: "command",
		command: render.command,
		depends_on: [id],
	};
	nodes[verifyId] = {
		goal: `校验 ${render.outDir} 下的截图真存在、非空、不是白板 (确定性证据闸, 零模型, 由 evidence-pass 补挂)`,
		executor: "command",
		command: `bun run scripts/${SHOTS_VERIFY_CLI}.ts ${render.outDir}`,
		depends_on: [renderId],
		requires: "all",
	};
	return { ids: [renderId, verifyId] };
}

/** id 去重 (补挂 id 与既有 id 撞车时加数字后缀)。 */
function freshId(nodes: ConductorPlan["nodes"], base: string): string {
	if (!(base in nodes)) return base;
	for (let i = 2; ; i++) {
		const cand = `${base}-${i}`;
		if (!(cand in nodes)) return cand;
	}
}

/** D-11 挖矿信号: goal/id 看着是 UI 活 (纯启发式, 只进日志不改行为)。 */
function looksLikeUiWork(node: PlanNode): boolean {
	const text = `${node.goal ?? ""} ${node.output_path ?? ""}`;
	return /\b(ui|ux|html|css|component|page|frontend|screenshot|视觉|界面|页面|组件|前端)\b/i.test(text);
}

/** D-11 图形状指纹 (确定性, 与 goal + oracle 结果凑三元组喂 S4 挖矿)。 */
function shapeOf(plan: ConductorPlan): string {
	const ids = Object.keys(plan.nodes);
	const edges = ids.reduce((n, id) => n + (plan.nodes[id]!.depends_on ?? []).length, 0);
	const kinds = new Map<string, number>();
	for (const id of ids) {
		const n = plan.nodes[id]!;
		const k = n.kind === "primitive" ? `primitive:${n.primitive ?? "?"}` : (n.executor ?? "leaf");
		kinds.set(k, (kinds.get(k) ?? 0) + 1);
	}
	const kindStr = [...kinds.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, c]) => `${k}=${c}`).join(",");
	return `n${ids.length}/e${edges}/${kindStr}`;
}
