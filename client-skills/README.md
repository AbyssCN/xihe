# client-skills — omd 的 runtime 客户端技能包

**背景**:omd 已转为 MCP-first —— pi TUI 退役,runtime TUI 由 **Claude Code / Codex** 担任,经 `omd mcp`(stdio MCP server,19 工具)驱动 omd 的引擎。原先长在 pi TUI 扩展里的斜杠命令,在这里重生为 runtime 客户端的**技能**(Claude Code skills 格式):方法论进技能文本,重活经 MCP 工具落到 omd 引擎。

## 安装

**Claude Code**:**无需手动拷贝**。注册 omd MCP 后,`omd mcp` server 首次启动时自动把这 22 个技能
(统一 `omd-` 前缀,避免和你既有 skill 撞名)幂等铺进用户级 `~/.claude/skills/` —— 新会话即得
`/omd-path`、`/omd-deliver` 等。自装幂等、随包升级更新,且**从不覆盖你改过的技能**(按内容 hash 判定,
用户动过即跳过)。关掉自装:环境变量 `OMD_INSTALL_SKILLS=0`。机制在 `src/harness/client-skills-install.ts`。

```bash
cd <目标repo> && claude mcp add omd -- omd mcp        # 全局安装的 omd; 首次起 server 即自装技能
# 或源码: claude mcp add omd -- bun run <omd路径>/src/harness/cli.ts mcp
```

**Codex**:没有 skills 机制——把需要的 SKILL.md 正文并入目标 repo 的 `AGENTS.md`,或作为 prompt 片段引用。

## 技能一览(22 个)

> 这张表**必须与本目录 `ls` 逐个对上** —— 表里有而目录没有 = 用户装了却拿不到,
> 目录有而表里没有 = 出厂了没人知道。两种都是静默失效。
> 复跑判据:`ls client-skills/ | grep -c '^omd-'` 与本表行数相等。

| 技能 | 干什么 | 靠什么 |
|---|---|---|
| `/omd-path` | 开/建/列 pathfinder 决策地图 + 开票 + 预取 | MCP `map_open` `map_add` `map_prefetch` |
| `/omd-ui-reviewer` | 看渲染截图判 UI(层级/间距/可读性/状态/一致性/slop);design-review profile 的可移植兜底审核 skill | 纯方法论,无 MCP 依赖 |
| `/omd-docs-drift` | 文档漂移追踪:按声明表裁「文档↔变更源」对,语义半闸出 suggested 票 | MCP `run`(Sonnet 座逐对判) |
| `/omd-tickets` | 看前沿 + 拉 AFK 研究回流(预算内自续) | MCP `map_tickets` |
| `/omd-rule` | 裁决前沿票 + 终裁判定树(真源三层/灰态三画法/敏感清单) | MCP `map_rule` |
| `/omd-deliver` | **权力闸**:执行已散尽区域 + delivered✅≠东西真在核对 | MCP `map_deliver` |
| `/omd-execute` | SDD → DAG 执行 → 交叉验证 checklist → 验收四选一 | MCP `run`/`dag_status`/`dag_result` |
| `/omd-iterate` | fixpoint 迭代:跑→你评→带失败原因重画,≤3 轮 | MCP `run` 三段式 |
| `/omd-grill` | 对抗式审问(一次一问/外部标杆逼问)+ 宽解岔口开 council | 方法论(纯技能) |
| `/omd-contract` | 审议结晶成 SDD 落盘(承 /omd-grill 决策记录表) | 方法论 + 文件 |
| `/omd-note` | 决策/引用记 NOTES.md 台账(引用不复制/遮敏感/追加) | 方法论 + 文件 |
| `/omd-council` | 多视角议会 + 3-lens 人格 + 领域岔口接地档(反 happy-path) | MCP `dag_research`(council) |
| `/omd-research-deep` | 终极档:种子作者化多角度抓 + council + 多轮缺口补挖 | MCP `dag_research`(`super` + `rounds`) |
| `/omd-audit` | 安全专项审计:信任边界清单(注入/认证/fail-open) | MCP `run`(审计 DAG 模板) |
| `/omd-sast` | 确定性 semgrep 静态扫描 | Bash semgrep |
| `/omd-review` | 对抗式 diff 审查 + 误报裁决程序 + gate ROI 分档 | MCP `dag_review`(三段式) |
| `/omd-slim` | 精益审计:先 debt 台账、再 global-first 两遍法找过度工程 | `scripts/omd-debt.ts` + MCP `dag_slim` |
| `/omd-deepen` | git 热点架构加深 → 浅模块去壳加厚 → leverage 排序 | MCP `dag_deepen`(三段式) |
| `/omd-debug` | 系统化根因调试 8 阶段(无根因不修)+ 修完扫同类;并发多假设派 `dag_debug` | 方法论 + omd `dag_debug` |
| `/omd-recall` | 推理卡住时主动召回既有记忆(语义+词法混合检索) | MCP `memory_recall` |
| `/omd-resume` | 列断掉/失败的 run 让 owner 挑一个从 checkpoint 续跑(跳过已绿节点) | MCP `dag_runs` + `run`(resume) |
| `/omd-video` | 视频→逐段结构化笔记(MiMo-v2.5 原生吃画面+音频),产 ALL-NOTES.md 交 dag 综合 | 自带 `run.py`(yt-dlp+ffmpeg+mimo API) |

### 明确**不**出厂的(别以为漏了)

| 名字 | 为什么不出厂 |
|---|---|
| `omd-investigate` | 与 `/omd-debug` **逐字近乎重复**,且是落后版本(没有 `dag_debug` 并发多假设那一段)。同一条方法论只留一个入口 —— 用 `/omd-debug`。老机器上残留的本地副本可以删。 |

## 原 pi TUI 27 条斜杠命令 → 去向全表

> 左列 = 原 pi TUI 命令(历史裸名);右列 = 现去向(技能统一 `omd-` 前缀)。

| 原 TUI 命令 | 去向 |
|---|---|
| `/path` `/tickets` `/rule` `/deliver` | → `/omd-path` `/omd-tickets` `/omd-rule` `/omd-deliver`(经 `map_*` MCP 工具) |
| `/pathfinder`(shift+tab 模式开关) | **退役** — Claude 没有"模式",`/omd-path` 开图即进入工作流 |
| `/execute` `/iterate` | → `/omd-execute` `/omd-iterate`(经 `dag_*` 三段式) |
| `/grill` `/sdd` `/note` `/council` | → `/omd-grill` `/omd-contract` `/omd-note` `/omd-council` |
| `/crystallize` `/crystals` | **并入 `/omd-contract`**(结晶落盘 + 列结晶文档) |
| `/ref` | **并入 `/omd-note`**(引用与决策同一台账) |
| `/audit` `/sast` | → `/omd-audit` `/omd-sast` |
| `/cg`(codegraph 代码检索) | **退役** — 为弱 runtime 补检索而生;Claude/Codex 原生代码检索更强 |
| `/search` `/web`(搜网/抓页) | **退役** — runtime 原生 web 能力替代;要多源综合研究走 `dag_research` |
| `/config` `/setup`(配置向导) | **退役** — 配置即 `.env`(照 `.env.example`);模型坐标 `OMD_RUNTIME_PROVIDER/MODEL` + 角色覆盖 `OMD_ITER_*` |
| `/mcp`(TUI 内 MCP 路由管理) | **退役** — MCP 管理是 runtime 客户端自己的事(`claude mcp …`) |
| `/cost` | **退役** — 成本随 `dag_result` / research 报告内嵌返回(cost 字段) |
| `/review` `/slim` `/deepen` | → `/omd-review` `/omd-slim` `/omd-deepen`(经 `dag_review`/`dag_slim`/`dag_deepen` 车队,异步三段式,报告落盘) |

## 核心工作流

### ① pathfinder 循环(大而模糊的多 session 工作)

```
/omd-path <目的地>            开图, 和 owner 把目的地拆成票 (map_add: research/omd-grill/prototype/task + blockedBy)
   │
   ├─ research 票 ── map_prefetch → detached AFK 后台自动跑 → /omd-tickets 拉回流
   │                  结果自动裁决母票 + 孵子票 (## children), 预算内自续 (OMD_PATH_RESEARCH_BUDGET, 默认 12)
   │
   ├─ grill 票 ────── /omd-grill 和 owner 审问对齐 → owner 定夺 → /omd-rule 落盘
   │
   └─ task 票 ─────── owner /omd-rule 逐张裁 (ruling = 将来的执行目标)
                          │
                区域散尽 (全部 task 已裁 + 编译通过) → 只报信
                          │
                owner 显式 /omd-deliver → 编译 slice → DAG 真改文件 → 票翻 delivered → 继续裁下一层
```

裁决即进度:地图真相在 `docs/plan/pathfinder/<slug>.md`(git 追踪、人可编辑),跨 session/跨机可续。

### ② SDD 交接(中大型一次性任务)

```
/omd-grill 审议到方案对齐 → (/omd-note 沿途记决策) → /omd-contract 结晶成契约 → owner 说"执行" → /omd-execute
  → DAG 跑完 → 你主动验收 (对照 SDD 逐条判): 接受 / 重画(/omd-execute redraw) / 迭代(/omd-iterate) / 直接修
```

### ③ 研究与审查(随取随用)

- 拿不准选哪个 → `/omd-council`;要多源事实 → `dag_research`(检索版);
- 上线前 → `/omd-sast`(便宜确定)+ `/omd-audit`(语义审查),先 sast 后 audit。

## 关键 env 旋钮

| 变量 | 作用 |
|---|---|
| `OMD_RUNTIME_PROVIDER` / `OMD_RUNTIME_MODEL` | runtime 模型坐标(conductor 默认同款,D-8) |
| `OMD_ITER_CONDUCTOR_MODEL` / `OMD_ITER_LEAF_MODEL` / `OMD_ITER_AGENT_MODEL` | 角色覆盖(任何 provider 坐标都行,harness 不 bake 模型) |
| `OMD_PATH_RESEARCH_BUDGET` | pathfinder 自续研究预算(默认 12,按 `.dispatched` 跨 session 计数;手动 prefetch 不受限) |

## 设计不变量(技能作者须知)

1. **裁决权与执行权属于 owner**:技能可以推荐裁决词、报告区域散尽,但 `/omd-rule` `/omd-deliver` 只在 owner 明确表达后调用;
2. **落图 ≠ 激活**:票落图零成本,深度不设限;成本唯一边界是派发预算;
3. **状态全在磁盘**:MCP server 无状态,地图/结果/预算都在 `docs/plan/` 与 `.omd/`,任何客户端可续;
4. **description ≤120 字符**(MCP 工具,D-11)——说明书住技能文本,客户端每轮为工具 description 付税。
