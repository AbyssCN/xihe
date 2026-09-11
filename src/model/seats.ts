/**
 * src/model/seats —— **座位登记表: 一个文件回答关于座位的全部问题** (2026-08-01)。
 *
 * ## 为什么是代码不是 markdown
 *
 * 这份表此前散在**四处**, 每一处只知道自己那一半:
 *   `role-models.NODE_TIER` (分档) · `auto-assign` 的三张 `Record<NodeClass, …>` (首选/推理档/溢出链)
 *   · `empty-knobs.SEAT_CONSUMERS` (谁在消费) · 各调用点手写的 temperature。
 * 写成 markdown 只会变成第五处 —— 而这个仓一路撞见的都是同一个形态:
 * **声明面往前跑了, 消费面没跟上, 两边都不报错**(图鉴见 `docs/silent-failures.md` S-1/S-4)。
 * 所以真源是这张表, 上面那几处**从它派生**; 人要看的那份由 `scripts/omd-seats.ts` 从它渲染。
 *
 * ## 一个座位到底是什么
 *
 * **座位 = 模型选择轴, 不是角色轴。** 它回答「这一类活派给哪个模型 / 用多大 effort / 多发散」,
 * 不回答「这个角色是谁」。所以四个不同的判别类调用可以共用一个 `judge` 座 —— 它们要的是同一档
 * 的模型, 哪怕干的不是同一件事。反过来, **判"达成没有"的闸**与**判"哪个更好"的择优**要的东西不同
 * (前者要严格抗谎报, 后者要多视角), 所以它们分了两个座 (`gate` / `judge`)。
 *
 * ## 三层旋钮, 各管各的 —— 别混
 *
 * | 层 | 谁 | 表达什么 | 真源 |
 * |---|---|---|---|
 * | **意图** | 本文件 | 这个角色想要多大 effort / 多发散 | `SEATS[].thinking` / `.sampling` |
 * | **能力** | `model-caps.ts` | 这个**模型**收不收得下 (拒 `max`? 拒 `temperature`?) | `MODEL_CAPS` |
 * | **调和** | `pi-transport.piRequest` | 把意图夹进能力 —— 发得出去的那个值 | `reasoningEffortFor` / `samplingFor` |
 *
 * 于是「不同模型有不同旋钮」这件事**不在这里处理**: 这里只写"想要 xhigh", 换到 mimo 上自动降 high,
 * 换到 deepseek 上发 max。**加模型改 `model-caps`, 加角色改这里, 两件事不会互相牵扯。**
 *
 * ⚠ 一条容易混的: `sampling` 是**座位的默认发散度**, 不是 best-of-N 的发散度。后者是
 * **lens/attempt 的属性** (同一个座位跑 N 遍, 每遍一档不同的 temperature, 见 `plan/best-of-n.ts`),
 * 由调用方逐次给, 压过这里的默认。座位只回答"这个角色平时多稳/多野"。
 */

/** 经济学分档 (auto-assign 按这个派模型与溢出链; 与 `NodeClass` 同词表)。 */
export type NodeTier = 'decomposer' | 'judge_synth' | 'worker' | 'verify';

/** 推理档意图 (与 callModel 的 thinkingLevel 同词表 — 不引入第二套词汇)。 */
export type SeatThinking = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

/** 跨家族要求: 这个座位与"大脑簇"同族时对抗是否失效。 */
export type CrossFamily =
  /** 必须异族, 同族即降级告警 (INV-3): 判与证共享盲点 = 证不出对方的错。 */
  | 'required'
  /** 异族更好但不强制 (多视角降系统偏见), 同族不告警。 */
  | 'preferred'
  /** 与家族无关 (执行/蒸馏类)。 */
  | 'no';

/** 座位的默认采样意图。`undefined` 字段 = 不发该参数 (让 provider 用自己的默认)。 */
export interface SeatSampling {
  temperature?: number;
  topP?: number;
}

export interface SeatSpec {
  /** 座位 id (= config.models 的键 / `OMD_<ID>_MODEL` env 名的来源)。 */
  readonly id: string;
  readonly tier: NodeTier;
  /** 这个座位**干什么** —— 一句话说清判什么/产出什么。 */
  readonly what: string;
  /** **消费点** (`文件:符号`)。空 = 这个座位没人读 = 它是个空旋钮, `seats.test.ts` 会红。 */
  readonly where: readonly string[];
  /** 调用频率 —— 决定它的经济学 (高频闸 ≠ 低频终审, 不该用同一档模型)。 */
  readonly frequency: string;
  readonly crossFamily: CrossFamily;
  /** effort 意图。transport 按 `model-caps` 夹到该模型收得下的字面量。 */
  readonly thinking: SeatThinking;
  /** 采样意图 (座位默认; lens/attempt 级发散由调用方逐次覆盖)。 */
  readonly sampling: SeatSampling;
  /** 建议模型 + **为什么**。auto-assign 的 per-node 首选覆盖也读它 (省略 = 走该 tier 的类首选)。 */
  readonly recommend: string;
  /** auto-assign per-node 首选坐标覆盖 (稀疏高价值座位才配; 省略 = 类首选 + 渠道经济学)。 */
  readonly preferredCoord?: string;
  /**
   * advisor 默认坐标 (NOTES 2026-08-10 裁决: advisor 是**座位属性**不是第 15 个座位)。
   * 座位执行中途可求教的更强模型 —— 按座位当前通道分派实现:
   *   claude-code 座 → 官方 server-side advisor tool (SDK settings.advisorModel, 配对表 API 校验);
   *   pi 座 → 内部升档 tool (src/harness/advisor-tool.ts, transcript 经 callModel 打此坐标)。
   * **不自动选** (transcript 会外发给该 provider): 这里全部留空 = 出厂无 advisor;
   * 运行时经 config.advisors[seat] / OMD_<SEAT>_ADVISOR 显式配置才生效 (resolveSeatAdvisor)。
   */
  readonly advisor?: string;
}

/**
 * ★ **全部座位。改角色只改这里。**
 *
 * 顺序 = 展示顺序 = `ALL_SEATS` 顺序 (座位自检、config_status 都按它列)。
 */
export const SEATS: readonly SeatSpec[] = [
  // ── 分解 ────────────────────────────────────────────────────────────────────
  {
    id: 'conductor',
    tier: 'decomposer',
    what: '把任务拆成 DAG (节点/依赖/executor/验证步)。整张图的质量上限由它定 —— 坏计划让一整轮叶子白干。',
    where: ['mcp/assemble:resolveEngineModels', 'harness/execute-slice:resolveConductorDefault', 'harness/fleet:defaultRouting'],
    frequency: '每图 1 发 (稀疏, 风险不对称 → 值得用贵的)',
    crossFamily: 'preferred',
    thinking: 'high',
    sampling: {},
    recommend: 'openai-codex:gpt-5.6-sol —— 稀疏高价值, 放 flat-sub 订阅里不冲配额; 拆解质量的边际收益最高。',
    preferredCoord: 'openai-codex:gpt-5.6-sol',
  },
  {
    id: 'escalation',
    tier: 'decomposer',
    what: 'verifier 判不过时**换它重新规划** (conductor 静默升级)。没配 / provider 不可达 → 不升级, 维持原 conductor。',
    where: ['harness/verifier:resolveVerification'],
    frequency: '仅 verifier 判不过时 (罕见)',
    crossFamily: 'preferred',
    thinking: 'high',
    sampling: {},
    recommend: '同 conductor 或更强 —— 它存在的意义就是"上一个不够好"。本仓生产 (owner 2026-09-11 裁) 坐 claude-code:claude-opus-5 (Claude 订阅 SDK 通道, 与 M3 conductor 异族; 频次低, 撞 session limit 概率小, 撞上按「不升级维持原 conductor」) —— 写在 .omd/config.json; 这里的首选仍是 codex sol, 因为 auto-assign 面向没有 Claude 订阅的用户。',
    preferredCoord: 'openai-codex:gpt-5.6-sol',
  },


  // ── 判别: 择优与合成 (判"哪个更好") ─────────────────────────────────────────
  {
    id: 'judge',
    tier: 'judge_synth',
    what:
      '**K 维度评判 panel**: 对 N 个综合候选逐维度评「谁更好、该嫁接谁的哪段」, 再由 fusion 收敛成 ' +
      '{共识/矛盾/覆盖缺口/独特洞察/盲点}。**择优不是闸** —— 它不回答"做完没有"。',
    where: ['harness/research/fanout:researchFanout', 'harness/research/web-fanout:researchWebFanout'],
    frequency: '每次 research: K 发并行 (K = judgeCriteria 数) + fusion 1 发',
    // 评判的敌人是单模型系统偏见 → 逐维度换族最强; fanout 已有 judgePool/judgeCriteria[].model 两个口。
    crossFamily: 'preferred',
    thinking: 'high',
    // 择优要能看出差别, 不能太保守; 但也不是创作, 不需要野。
    sampling: { temperature: 0.3 },
    recommend:
      'deepseek:deepseek-v4-pro (owner 2026-08-15 裁)。判别吃推理 → 单价低 + K panel 并行的模型。' +
      '**真要多视角就配 `judgePool` 跨族轮转**, 那比换这个座位更对症 (座位只给一个默认值)。' +
      '✅ 「judge 要不要从 codex 下来」这个原先记在这里的**待裁开问题已裁**: 下来。' +
      '它坐在 sol 上是历史原因 —— 内环闸拆出去 (`gate`) 之前它同时背着"高频闸", 放强模型是为了那一半; ' +
      '那一半走了之后 sol 的理由就没了。改坐 v4-pro 另有一个结构收益: 它与 `reason`/synth (M3) **异族**, ' +
      '否则就是「M3 写的综合由 M3 自己评判」。' +
      '⚠ 量: 实测每次 research K 发 / 436K in / 49K out (`.omd/seat-usage.jsonl` byTrace `fanout:judge`)。' +
      'v4-pro 是 flash 的 3.1 倍单价 (官方现价 0.435/0.87 vs 0.14/0.28 per 1M) —— ' +
      '⚠ `auto-assign.ts` 里记的「贵一倍」是**旧数**, 现价是 3.1 倍。' +
      '**判据**: research 周频超过 6 次就该重过一遍渠道经济学 (2026-08-16 起 deepseek 改峰谷计价, ' +
      '谷价仍高于今天的平价)。' +
      '⚠ 改这个座位时**必须同步改 `config.pools.judge`** —— research 路径的 judgePool 非空即完全' +
      '压过本座位 (`fanout.ts:480`), 只改一处等于没改。见 issue #143。',
    preferredCoord: 'deepseek:deepseek-v4-pro',
  },
  {
    id: 'reason',
    tier: 'judge_synth',
    what: 'research 的**综合**: 把各镜头冠军按不同 framing 合成完整方案 (具体到模块/文件/接点)。',
    where: ['harness/research/web-fanout:researchWebFanout', 'harness/research/author-spec:authorFanoutSpec'],
    frequency: '每次 research: 每个 framing 1 发',
    crossFamily: 'preferred',
    thinking: 'high',
    sampling: {},
    recommend: '连贯性优先的强模型 —— 它写的是终稿的骨架。',
  },
  {
    id: 'reduce',
    tier: 'judge_synth',
    what: 'research 每个镜头内 **V→1 冠军合成** (镜头内机械合并, 不发明新东西)。',
    where: ['harness/research/fanout:researchFanout'],
    frequency: '**每 lens 1 发** (×L, 高频)',
    crossFamily: 'no',
    thinking: 'xhigh',
    sampling: {},
    recommend:
      '"够质量的最廉" (D-14)。它是**最大的不可缓存消费** (每 lens 全读 V 个 sub-angle 正文, 永远 unique), ' +
      '且只是机械合并 —— 下沉到廉价档是单刀最大降本。绝不继承 reason 的贵模型 (mimo-pro 实测 24s×L 爆超时)。',
  },
  {
    id: 'fusion',
    tier: 'judge_synth',
    what:
      'research 的**融合分析**: 把 K 维度 judge 的评判收敛成 5-tuple (共识/矛盾/覆盖缺口/独特洞察/**盲点**)。' +
      '它的产出是 graft 的 ground —— graft 据此消解矛盾、补齐盲点。',
    where: ['harness/research/fanout:researchFanout'],
    frequency: '**每次 research 1 发** (收敛终局, 不发散)',
    // 它干的活是**在别人的产出里找盲点**。与被找的对象同族时这一格结构性失效 —— 与 verifier
    // 那条同源 (判与证共享盲点 = 证不出对方的错), 故标 required。
    // ✅ 2026-08-23 已上闸 (#142/#143 收尾): `model/seat-conformance.ts` 的 `reconcileSeats`
    // 按 `AUDITS` 逐座位对账「它审谁的产出」, 同族 ⇒ error; `scripts/seat-check.ts` 在**真**
    // config 上跑。触发它的现场: `review` 掉队两次没人报。
    // ⚠ 仍是**声明**的那一半: `AUDITS` 表外的 `required` 座位不判 (宁可漏不可误报)。
    crossFamily: 'required',
    thinking: 'high',
    // 收敛分析要稳定可复现: 同一批候选不该这一轮找出盲点、下一轮找不出。
    sampling: { temperature: 0.2 },
    recommend:
      'claude-code:claude-opus-5 (owner 2026-08-15 裁)。**理由是异族 + 量小, 不是"更强"**: ' +
      '实测 1 发 / 71K in / 6K out per run (`.omd/seat-usage.jsonl` byTrace `fanout:fusion`, 3 跑), ' +
      '与 graft 合计只占单次 research 输入的 8% —— 换族的成本可以忽略。' +
      '而上游 gen/reduce/synth 现在全在 minimax、judge 在 deepseek, 放 claude 天然异于两者。' +
      '⚠ 代价要写在这: claude-code 通道对 user 消息里的 corpus **零缓存** ' +
      '(`claude-sdk-complete.ts:57-64` 把 messages 压成扁字符串, 没有挂 `cache_control` 的位置; ' +
      '实测 `claude-code:claude-haiku-4-5` 40 发 / 1.89M in / 命中恰好 0), ' +
      '故它拿不到 judge 波暖好的 head+candDigest 缓存, 每次多付一次全额 head。1 发, 认了。',
    preferredCoord: 'claude-code:claude-opus-5',
  },
  {
    id: 'graft',
    tier: 'judge_synth',
    what:
      'research 的**终笔**: 拿 K-judge 评判 + fusion 的 5-tuple + 全部候选, 合成唯一最终方案。' +
      '**整条 research 管线的出口** —— 用户读到的那份就是它写的。',
    where: ['harness/research/fanout:researchFanout'],
    frequency: '**每次 research 1 发** (最稀疏的一发, 也是杠杆最高的一发)',
    // 终笔是**合成**不是判别 —— 要的是连贯性, 不是跨族对抗。
    crossFamily: 'no',
    thinking: 'high',
    sampling: {},
    recommend:
      'claude-code:claude-opus-5 (owner 2026-08-15 裁)。全表**性价比最高的一格**: ' +
      '实测 1 发 / 76K in / 11K out per run (`.omd/seat-usage.jsonl` byTrace `fanout:graft`, 3 跑) —— ' +
      '零缓存的代价在这里最小 (只 miss 一次 head + 约 9.9K 固定前言), 而它决定交付物质量。' +
      '⚠ 此前它默认跟 `judge` 座 (`web-fanout.ts` 覆盖) 或 `reason` 座 (`fanout.ts` 内层), ' +
      '两处默认不同 —— 这正是拆出独立座位的理由: **一个座位背多个用途时, 想单独调其中一个就得改代码**。' +
      '⚠ 未量: M3 vs opus 在这一发上的质量差**没有臂级读数**, 上面是按"1 发 + 交付出口 + 成本可忽略"的' +
      '结构推的。要量的话是现成的单变量对照 (cfg.graftModel 是显式旋钮)。',
    preferredCoord: 'claude-code:claude-opus-5',
  },

  // ── 执行 ────────────────────────────────────────────────────────────────────
  {
    id: 'leaf',
    tier: 'worker',
    what: '**inproc 单发叶**: 无工具, 一问一答 (生成/研究/判断)。DAG 里量最大的那一类。',
    where: ['mcp/assemble:resolveEngineModels', 'harness/fleet:defaultRouting'],
    frequency: '每图 N 发 (量在这里)',
    crossFamily: 'no',
    thinking: 'xhigh',
    sampling: {},
    recommend:
      'minimax-cn:MiniMax-M3 (owner 2026-08-14 裁, 订阅直连 + adaptive thinking)。' +
      '⚠ 必须走原生位 `minimax-native.ts` —— pi 目录那条 anthropic 兼容端点把推理内联进 text, ' +
      '量产座位格式守实测 37% (.omd/eval/m3-inproc-strip), 原生位 100%。' +
      '前任 deepseek-v4-flash: 量产档, 靠缓存命中率而不是靠降 effort 省钱 (200 次对照: v4 忽略 effort 旋钮)。',
  },
  {
    id: 'agent',
    tier: 'worker',
    what: '**带工具的叶**: read/write/edit/ls/grep/bash + hashline, **能真改文件**。omd 干活的底座。',
    where: ['mcp/assemble:resolveEngineModels', 'harness/fleet:defaultRouting'],
    frequency: '每图若干 (比 inproc 少, 但每发更贵更长)',
    crossFamily: 'no',
    // ⚠ agent leaf 的 effort **不走座位档**: runner 自带 xhigh (owner 早前锁的, 改文件质量优先)。
    // 这里写 xhigh 是为了两者一致, 别让人以为改这里能调 agent。
    thinking: 'xhigh',
    sampling: {},
    recommend:
      'minimax-cn:MiniMax-M3 (owner 2026-08-14 裁)。实测依据 `.omd/eval/m3-agent-smoke` / `m3-agent-hard`: ' +
      'smoke 两跑 G0+G1 双过 (工具循环真动手, 与 claude-sonnet-5 平手且墙钟约一半); hard 两跑 G0 过 G1 不过 —— ' +
      '而 sonnet-5 在同题上**同样 G1 不过**, 是平手不是退步。' +
      '⚠ 这条路走 pi-agent-core 自己的栈, **不经** `minimax-native.ts` —— 那边 `<think>` 仍在 text 里, ' +
      '但交付物是文件改动不是被 parse 的正文, 代价小得多。别把量产座位那条结论套过来。' +
      '改文件质量优先。注意它的 effort 由 `agent-leaf.ts` 的 runner 默认给, 不读这一档。',
  },
  { id: 'lens', tier: 'worker',
    what: 'research 的 **sub-angle 广度叶**: 一个镜头下的一个角度, 各写各的。',
    where: ['harness/research/web-fanout:researchWebFanout', 'mcp/assemble:buildDefaultConfig'],
    frequency: '每次 research: L×V 发 (最宽的一层)', crossFamily: 'no', thinking: 'xhigh',
    // 镜头之间要**不一样**才有扇出的意义 —— 但发散度是 lens 逐个给的 (best-of-n.ts 的 0.25/0.4/0.5/0.75),
    // 座位只给个中性默认。
    sampling: {},
    recommend: '广度靠数量不靠单发质量 → 最廉价档。' },
  { id: 'expand', tier: 'worker',
    what: '子图展开类的探索叶。**专属调用点**: `harness/web/query-expand` 的 `createModelQueryExpander` 直接解析本座; 另经 stamp 池 cheap 档轮换。',
    where: ['mcp/assemble:buildDefaultConfig'],
    frequency: '经 stamp 池轮换', crossFamily: 'no', thinking: 'xhigh', sampling: {},
    recommend: '与 lens 同档。⚠ 它是**池成员**而非独立角色 —— 想改探索类模型, 改 `config.pools.cheap` 更直接。' },
  { id: 'distill', tier: 'worker',
    what: '**蒸馏**: 把抓来的网页正文压成要点 (research 的降本层)。',
    // 2026-08-01: 摘掉 `harness/plan/distill` —— 它是 TUI 侧的 plan distill 阶段, 随 TUI 前端一并删除
    // (交接文 13)。蒸馏能力本身没丢: MCP 的 `omd_distill` 走 web/distill-{source,challenger}。
    where: ['harness/web/distill-source:createModelSourceDistiller', 'harness/web/distill-challenger:createChallengerDistiller', 'mcp/assemble:buildDefaultConfig'],
    frequency: '每个来源 1 发 (高频)', crossFamily: 'no', thinking: 'xhigh',
    sampling: { temperature: 0.25 },
    recommend: '机械提取 → 最廉价档。' },
  { id: 'overflow', tier: 'worker',
    what: '溢出档: 主力池打满时的接盘坐标。**目前只作为 stamp 池 mid 档的一个坐标被消费**。',
    where: ['mcp/assemble:buildDefaultConfig'],
    frequency: '经 stamp 池轮换', crossFamily: 'no', thinking: 'xhigh', sampling: {},
    recommend: '与 leaf 同档或略强。⚠ 同 expand: 它是池成员不是独立角色。' },

  // ── 验证 ────────────────────────────────────────────────────────────────────
  {
    id: 'verifier',
    tier: 'verify',
    what:
      '**整图终审**: DAG 全跑完之后, 拿原任务 + 计划 + 各叶产出, 逐条对照任务的明确要求判 pass/fail。' +
      '职责是**攻击结果**而不是盖章放行 —— 默认怀疑, 证据不足即不过。不过 → escalation 重规划。',
    where: ['harness/verifier:resolveVerification', 'mcp/assemble:buildDefaultConfig'],
    frequency: '**每图 1 发** (低频 → 值得用贵的)',
    // INV-3: 与大脑簇同族则对抗失效 (它造的坏计划自己看不出坏)。auto-assign 同族时会降级告警。
    crossFamily: 'required',
    // ⚠ **这一档在 codex 上是没有效果的** (2026-08-01 实测 xhigh vs off 两臂逐字相同,
    // `reasoning=undefined` 时 gpt-5 照样推理 —— 那家关不掉思考)。所以这里填什么都一样。
    // 但**一旦这个座位挪到关得掉思考的模型**, `gate` 那组对照 (关思考 15/15 vs 开思考 8/15,
    // 核对型判词深想反而更差) 就直接适用 —— **到那天重量一次再定, 别照抄这一格**。
    thinking: 'high',
    // 终审要**稳定**: 同一份产出不该这次过下次不过。⚠ 坐在 codex 上时这条**发不出去**
    // (caps: gpt-5 拒收 temperature, 发了 400) —— 意图留着, 换座位即生效。
    sampling: { temperature: 0.2 },
    recommend:
      'openai-codex:gpt-5.6-sol —— **必须与 conductor/judge 异族**, 否则判与证共享盲点。' +
      '低频稀疏, 放 flat-sub 订阅里不冲配额。' +
      '⚠ **本表的出厂默认自己违反这一条**: `conductor.preferredCoord` 也是 sol, 与本座同族。' +
      '而且没有任何闸会报 —— `crossFamily` 字段除自己的测试外零消费点, `auto-assign.ts:344` 那条只查 ' +
      '`autoAssigned`(已停用的死层, 见 issue #142), 从不看 `config.models`。' +
      '生产实配靠人工避开 (owner 2026-08-15: conductor=claude-opus-5 / verifier=sol, 异族成立), ' +
      '**出厂默认这一格待裁** —— 修法是把 conductor 出厂值挪离 sol, 或把 crossFamily 做成会红的闸。',
    preferredCoord: 'openai-codex:gpt-5.6-sol',
  },
  { id: 'review-spec', tier: 'verify',
    what: '`dag_review` 的 **spec 轴**: 做的是不是 SDD 说该做的事 (对照 docs/plan 最新 SDD)。',
    where: ['harness/review/run:runReview'],
    frequency: '人触发 (稀疏)', crossFamily: 'required', thinking: 'high', sampling: { temperature: 0.2 },
    recommend: '同 verifier —— 对照契约要严格。', preferredCoord: 'openai-codex:gpt-5.6-sol' },
  { id: 'review', tier: 'verify',
    what: '`dag_review` 的**主轴**: 对抗式读码找缺陷 (find 层)。',
    where: ['harness/review/run:resolveReviewModels'],
    frequency: '人触发 (稀疏)', crossFamily: 'required', thinking: 'high', sampling: { temperature: 0.2 },
    recommend: '强模型 + 与被审代码的作者异族。', preferredCoord: 'openai-codex:gpt-5.6-sol' },

  // ── 后台 ────────────────────────────────────────────────────────────────────
  // `dream` 座位 2026-08-02 摘除 (ADR-0003): 唯一解析点 `dream/model-live` 随 src/dream/
  // 一起停到 experimental/ —— 留着座位等于给用户一个配了没有任何效果的旋钮。复活见该 ADR。
  { id: 'continuity', tier: 'worker',
    what: 'session **交接蒸馏**: 把一段会话压成下一个 session 接得住的 checkpoint。',
    where: ['harness/session/writer:runWriter'],
    frequency: '每次 checkpoint (低频)', crossFamily: 'no', thinking: 'xhigh',
    sampling: { temperature: 0.2 },
    recommend: '便宜单发 —— 蒸馏不是创作。' },
] as const;

// ── 派生视图 (下面这些**不要手写第二份**) ───────────────────────────────────────

export type OmdSeat = (typeof SEATS)[number]['id'];

const BY_ID = new Map(SEATS.map((s) => [s.id, s]));

/** 取一个座位的规格; 未知 id → undefined。 */
export function seatSpec(id: string): SeatSpec | undefined {
  return BY_ID.get(id as OmdSeat);
}

/** 全部座位 id (遍历序 = 展示序)。 */
export const ALL_SEAT_IDS: readonly OmdSeat[] = SEATS.map((s) => s.id) as readonly OmdSeat[];

/** 座位 → 经济学分档 (auto-assign 的 NodeClass 同表)。 */
export const SEAT_TIER: Record<string, NodeTier> = Object.fromEntries(SEATS.map((s) => [s.id, s.tier]));

/** 座位 → effort 意图。 */
export const SEAT_THINKING: Record<string, SeatThinking> = Object.fromEntries(
  SEATS.map((s) => [s.id, s.thinking]),
);

/** 座位 → per-node 首选坐标覆盖 (只含显式配了的)。 */
export const SEAT_PREFERRED_COORD: Record<string, string> = Object.fromEntries(
  SEATS.filter((s) => s.preferredCoord).map((s) => [s.id, s.preferredCoord!]),
);

/**
 * 座位的默认采样意图。**调用方显式给的压过它**; 它再被 `model-caps.samplingFor` 按模型能力夹
 * (codex 拒 temperature / kimi-k3 拒两者 → 丢弃并出声)。
 */
export function seatSampling(id: string): SeatSampling {
  return BY_ID.get(id as OmdSeat)?.sampling ?? {};
}
