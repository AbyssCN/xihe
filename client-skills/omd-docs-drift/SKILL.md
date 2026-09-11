---
name: omd-docs-drift
description: 文档漂移追踪:确定性死路径/死锚闸(bun test 常驻)之外的语义半——按 docs/docs-map.md 声明表裁出「文档 ↔ 变更源」对, 经 run (旧名 dag_run) 派 Sonnet 座逐对判"文档原句是否还站得住", 出口恒为 suggested 票, 人 confirm。Trigger:/omd-docs-drift、查文档漂移、文档跟没跟上代码、docs drift。
---

# /omd-docs-drift — 语义文档漂移审计

结晶自 `docs/plan/2026-08-11-docs-drift.md`(docs-drift SDD)。**确定性那半**(锚存在 / 死路径 /
工具面反向)已经是 `src/harness/docs/drift-gates.test.ts` 里 `bun test` 常驻的闸,本 skill 不重做那半
——它跑不进闸的**语义半**:文档那句话此刻是不是还对。

## 何时跑

- 收尾时人拉(当天 diff),或按 D-5 的 cron 档(未开,见 SDD 未决 O-3);
- 不是每次改代码都跑——只在**改了 docs-map.md 覆盖源里的文件**之后跑才有意义(下面 plan 步会自己判空)。

## 三步

### 1. plan —— 裁出待审对

```
bun run scripts/docs-drift.ts plan
```

读 `.dev/docs-drift-stamp`(上次审计 commit,盘上记)到 `HEAD` 的 `git diff --name-only`,
乘 `docs/docs-map.md`(`parseDocsMap`)算出「文档 ↔ 命中的变更文件」对(`buildDriftAuditPlan`)。
覆盖源没变的文档不产生任务——省 Sonnet 调用,也是判据能跑得动的原因(上下文裁到 KB 级)。
首次跑没有 stamp 文件 → 先 `bun run scripts/docs-drift.ts init` 打一个基线(见下),这一轮零任务
(不是漏审,是"没有可比较的过去" —— NULL≠0)。

零任务 → 打印「无待审对」, 到此为止, 不必往下走。

### 2. run —— 每对一个便宜叶

对 plan 打印的每一条 task(`{doc, sourceGlobs, anchors, changedFiles}`)派**一个平铺 run 节点**(`run` 工具, 旧名 `dag_run` 仍是别名)
(Sonnet 座, 便宜档), task 按下面模板填:

```
读文档 <doc> 里与以下锚点相关的段落: <anchors>。
读它声明覆盖的变更文件: <changedFiles>(diff, 不是全量——只看这次变了什么)。

判据(窄, 不许放松):
- 若文档原句与代码矛盾, 必须给出: docQuote(逐字引用文档原句, 不许转述)+ file:line(矛盾代码锚)+ claim
  (为什么矛盾)。
- 若看不出矛盾, 明确回 driftFound=false, findings=[] —— 「未见漂移」是一个合法结论, 不许为了
  有产出硬凑一条泛泛建议。
- 转述文档原句 = 凭印象, 不算数; docQuote 必须是文档里真实存在的一句。

按 DriftAuditLeafResult 形状回:{ task: <原样带回>, driftFound: boolean, findings: DriftAuditFinding[] }
(结构见 `src/harness/docs/drift-audit.ts`)。
```

`dag_status` 轮询取全部叶结果, 拼成 `DriftAuditLeafResult[]` 数组, 写一份临时 JSON(如
`/tmp/docs-drift-results.json`)。

### 3. apply —— 过反幻觉闸, 落 suggested 票, 挪 stamp

```
bun run scripts/docs-drift.ts apply --results /tmp/docs-drift-results.json --run-id <runId> [--slug <slug>]
```

内部: `buildSuggestionDrafts` 过 D-3 反幻觉闸(复用 `checkFindingAnchors`)——幻觉锚 / 无锚 finding
被降级记账、不落票(打印出来但不算失败);合法锚点的 finding 各落一张 `suggested` 票
(`suggestedBy=<runId>`)。跑完把 stamp 挪到当前 `HEAD`——**只在 apply 成功后挪**, plan 阶段绝不挪
(挪早了会漏审 plan 和 apply 之间落地的改动)。

## 出口

落的是 **suggested 票**,不是既成事实。人 `map_confirm` 之后才进前沿;若确认的是「文档该改」,
直接改文档走直通 v2(改动本身不归本 skill 管——D-4:出口恒为票,改文件恒经人)。

## 与既有 skill 的边界

- `/omd-docs-drift` = 语义半(死路径/死锚是 `bun test` 常驻闸, 不进本 skill);
- 通用正确性/契约审查 → `/omd-review`;安全专项 → `/omd-audit`;
- 确定性闸红了 → 直接看 `bun test` 输出定位, 不需要跑本 skill。
