/**
 * src/model/pool-defaults —— **池的源码默认值,全部在这一个文件里**(2026-08-05)。
 *
 * ## 它为什么存在
 *
 * owner 一天之内连撞三次同一堵墙:研究判优池里躺着一个 429 的死座位、溢出兜底在拿 mimo 跑
 * 文本活、review 的 verify 层指着一个欠费座位 —— 三处**都得靠 grep 全仓才翻得出来**,
 * 因为它们分别硬写在 `web-fanout.ts`、`auto-assign.ts`、`.env` 里。原话是:
 * 「为什么一个配置模型给我弄得这么麻烦」。
 *
 * 根因不是哪一处写错了,是**"选择"和"事实表"混住**:
 *   - **事实表**(价表 `cost-ledger`、能力表 `model-caps`、评分 `model-ratings`)是关于世界的事实,
 *     它们**就该**在代码里,改它们本来就该走 review。
 *   - **选择**(这几个池用哪些坐标)是 owner 的决定,改它不该要"改代码 + 跑测试 + 提交"。
 *
 * 所以池的解析序统一成:**`OMD_POOL_*` env > `.omd/config.json` 的 `pools` 段 > 本文件**。
 * 本文件是「还没 init 的仓开箱能跑」的兜底,**不是真源** —— 真源是 config。
 *
 * ⚠ 加新池请同时加 `POOL_TIERS`(`role-models.ts`),否则 config/env 那两层认不出它,
 * 而"配了不生效"正是这条链上最难查的一种。
 */
import type { PoolTier } from './role-models';

/**
 * 研究**判优**池(judge panel:K 个评判维度逐个轮不同族,降单模型系统偏见)。
 *
 * **2026-08-05 owner 定盘:只用 `glm-5.2` 与 `qwen3.8-max`,别的都不许进这个池。**
 * 历史:2026-07-28 把 GPT(openai-codex)移出去过 —— 它在 research 大输入聚合上反复
 * "An error occurred processing your request" / context 溢出。GPT 仍是 dag_run 的 conductor/review。
 *
 * ⚠ 这个池是**白名单不是候选池**:我曾按"找个 1M 上下文的填上"把 minimax-m3 塞进来,
 * 被当场驳回。**能连通 ≠ 该用** —— 探针表只答前者。
 */
const JUDGE_PANEL = ['opencode-go:glm-5.2', 'opencode-go:qwen3.8-max'];

/**
 * 跨家族**发散**池(lens gen + synth framing 逐单元轮不同模型族,治「同族 N 单元共享盲点」)。
 *
 * ⚠ 2026-08-05 撤掉 `xiaomi-token-plan-ams:mimo-v2.5-pro`(原占 50% 权重):该座实测
 * `429 quota exhausted`,且违反路由口径 —— **mimo 只走 opencode-go、且只用于多模态**,
 * 而这里是纯文本活。撤掉后三个 Go 家族均分。
 * 发散本身不是质量瓶颈:07-28 跨家族发散 eval 的结论是「无互补盲点,只有能力排序」
 * (79% vs 81% 在噪声内),少一族不值得再买一份订阅。
 */
const LENS_DIVERGENCE = ['opencode-go:qwen3.7-plus', 'opencode-go:minimax-m3', 'opencode-go:deepseek-v4-pro'];

/**
 * auto-assign 的**溢出兜底**(D-19 溢出列):专属桶烧穿 → 落 Go flat-sub(cost=0,一价多模型)。
 *
 * ⚠ 兜底恰恰是**没人盯着的那条路** —— 只在主桶烧穿时才生效,配错会静默发生。
 * 2026-08-05 两处按 owner 口径改:`worker` 撤掉 mimo(纯文本活);
 * `verify` 从 `qwen3.7-max`+`glm-5.1` 对齐到判优白名单(两个旧版本号,而校验档是拿来证伪别人的,
 * 最不该悄悄用旧模型)。
 */
const FALLBACK_DECOMPOSER = ['opencode-go:kimi-k3', 'opencode-go:glm-5.2'];
const FALLBACK_JUDGE_SYNTH = ['opencode-go:kimi-k3', 'opencode-go:glm-5.2'];
const FALLBACK_WORKER = ['opencode-go:deepseek-v4-flash', 'opencode-go:glm-5.2'];
// 2026-09-11 (owner 裁): verifier 撞限的降级座首选 Google 订阅里的 Claude Opus 4.6 (agy CLI 通道, 与 M3 异族,
// 走独立的 Claude/GPT 配额桶); agy 没登录时 `usable()` 判无凭证, 自然顺延到后两个。
const FALLBACK_VERIFY = ['agy-cli:claude-opus-4-6-thinking', 'opencode-go:qwen3.8-max', 'opencode-go:glm-5.2'];

/**
 * 池 → 源码默认坐标。**只含有静态默认的那些档**。
 *
 * `strong` / `mid` / `cheap` / `multimodal*` 刻意缺席:它们没有静态默认,未配时由**座位推导**
 * (见 `mcp/assemble.ts` 的 `cfgPools.x ?? 座位推导`)。在这里编一份假的默认,读数板就会
 * 报一个根本没生效的值 —— 那比不报更坏。
 */
export const POOL_DEFAULTS: Partial<Record<PoolTier, readonly string[]>> = {
  judge: JUDGE_PANEL,
  lens: LENS_DIVERGENCE,
  fallbackDecomposer: FALLBACK_DECOMPOSER,
  fallbackJudgeSynth: FALLBACK_JUDGE_SYNTH,
  fallbackWorker: FALLBACK_WORKER,
  fallbackVerify: FALLBACK_VERIFY,
};

/** 未配 config/env 时,该档由什么决定。给读数板用(不是所有档都有静态默认)。 */
export const POOL_FALLBACK_NOTE: Partial<Record<PoolTier, string>> = {
  strong: '座位推导',
  mid: '座位推导',
  cheap: '座位推导',
  multimodal: '座位推导 / config.multimodalPool',
  // ⚠ 这一格此前写 '座位推导', **是错的** (2026-08-05 读代码抓到): stamp-pass 见 multimodalStrong
  //   为空是**回落 multimodal 池** (stamp-pass.ts: 判 length>0 不成立就走 pools.multimodal),
  //   根本走不到座位推导那一层。差别不是措辞: 照原话去查会以为改座位能影响强档看图节点, 而实际
  //   得改 multimodal 池 —— 也正因为这条耦合, owner 2026-08-05 把它显式钉进 config.pools。
  multimodalStrong: '回落 multimodal 池',
};
