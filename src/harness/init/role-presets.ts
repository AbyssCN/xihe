/**
 * init/role-presets —— 角色模型矩阵预设 (wizard 步骤⑥的数据源)。
 *
 * 模型 id 字符串只住这里 (provider 换代改这一个文件); wizard 泛化消费:
 * env 合并进 updates → keyPrompt 补缺 key → upsertProvider (自定 provider → models.json) /
 * persistMultimodalPool / persistMultimodalPoolPremium / persistRoleModel 写盘 → 汇总表。
 *
 * 三档哲学:
 *   ① 基础档 base-opencode-go —— 一把 OPENCODE_API_KEY 走 opencode go 网关, 多家族混编:
 *     deepseek-v4 掌舵/铺量, qwen3.7-plus agent+多模态, glm-5.2 合成+verifier (跨家族一把 key 实现)。
 *   ② 中间档 cn-standard —— deepseek v4 直连: pro 关键角色, flash 铺量;
 *     MiniMax M3 管多模态池 + verifier 跨家族。
 *   ③ 顶配档 cn-ultimate —— kimi k3 掌舵, deepseek pro 评判/合成, qwen 干活+verifier,
 *     zhipu glm-5.2 审查 Spec 轴 + premium 多模态, MiniMax M3 多模态。
 *   ⓪ 生产档 m3-codex —— 本仓 2026-09 生产配置: M3 全高频座 + 两条订阅通道 (codex sol 终审 / opus 升级)。
 */
import type { ModelRole } from '../../model/role-models';

/** opencode go 网关默认 base URL (常量易改)。 */
export const OPENCODE_GO_BASE_URL = 'https://api.opencode.ai/v1';
/** Qwen (DashScope) OpenAI 兼容端点。 */
export const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
/** Zhipu (bigmodel) OpenAI 兼容端点。 */
export const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

// —— 模型坐标 (provider:model) · 换代只改这里 ——
const DS_FLASH = 'deepseek:deepseek-v4-flash';
const DS_PRO = 'deepseek:deepseek-v4-pro';
// MiniMax M3 (minimax-cn 直连, OpenAI 兼容, 原生多模态, 1M 上下文): 2026-09-11 起取代 mimo 坐标 ——
// mimo 两个账户早已打光 (.env 注 2026-07-27), 预设里钉着它 = 新用户一装就落死座。同一坐标同时管
// 多模态池与合成座 (M3 原生吃图, 不再需要 ultraspeed 那一档)。
const MINIMAX_M3 = 'minimax-cn:MiniMax-M3';
export const MINIMAX_BASE_URL = 'https://api.minimaxi.com/v1';
// Claude 订阅通道 (Agent SDK, 凭证 = claude CLI 登录) 与 ChatGPT 订阅通道 (pi OAuth): 都免 env key。
const CLAUDE_OPUS = 'claude-code:claude-opus-5';
const CODEX_SOL = 'openai-codex:gpt-5.6-sol';
// kimi-coding = pi OAuth 通道 (baf1295 统一模型层): 免 API key, 凭证走 ~/.pi/agent/auth.json。
// owner 裁 (2026-08-10): 一律 256k 档 (k3-256k) —— 同模型小上下文档, 降订阅配额消耗。
const KIMI_CODING_K3 = 'kimi-coding:k3-256k';
const QWEN_PLUS = 'qwen:qwen3.7-plus';
const QWEN_MAX = 'qwen:qwen3.7-max';
const ZHIPU_GLM = 'zhipu:glm-5.2';
// opencode go 网关坐标 (同一把 key, 网关侧多家族)
const OC_DS_PRO = 'opencode-go:deepseek-v4-pro';
const OC_DS_FLASH = 'opencode-go:deepseek-v4-flash';
const OC_QWEN_PLUS = 'opencode-go:qwen3.7-plus';
const OC_GLM = 'opencode-go:glm-5.2';

/** 引擎认识的角色矩阵 env 全集 (role-presets.test.ts 白名单校验用)。 */
export const ROLE_ENV_ALLOWLIST: readonly string[] = [
  'OMD_RUNTIME_PROVIDER',
  'OMD_RUNTIME_MODEL',
  'OMD_CG_CONDUCTOR_MODEL',
  'OMD_CG_LEAF_MODEL',
  'OMD_CG_AGENT_MODEL',
  'OMD_ITER_CONDUCTOR_MODEL',
  'OMD_ITER_LEAF_MODEL',
  'OMD_ITER_AGENT_MODEL',
  'OMD_CONDUCTOR_ESCALATION_MODEL',
  'OMD_PLAN_MODEL',
  'OMD_LENS_MODEL',
  'OMD_REASON_MODEL',
  'OMD_REDUCE_MODEL',
  'OMD_JUDGE_MODEL',
  'OMD_REVIEW_SPEC_MODEL',
  'OMD_LEAF_OVERFLOW_MODEL',
  'OMD_ROUTER_POOL_INPROC',
  'OMD_ROUTER_POOL_AGENT',
];

export interface RolePresetKeyPrompt {
  /** API key 的 env 变量名。 */
  env: string;
  /** 提示语 (人话说明这 key 干嘛的)。 */
  label: string;
  /** 该 key 对应的 provider id — key 跳过时, 该 provider 的 pool/configRoles 写入随之跳过。 */
  provider?: string;
}

export interface RolePresetCustomApi {
  /** provider 名 (坐标前半)。 */
  id: string;
  /** OpenAI 兼容 base URL。 */
  baseUrl: string;
  /** 读 key 的 env 变量名。 */
  keyEnv: string;
}

export interface RolePresetConfigRole {
  /** config.json models 段的角色 (persistRoleModel)。 */
  role: ModelRole;
  coord: string;
}

export interface RolePreset {
  id: string;
  label: string;
  /** 写进 .env 的角色矩阵 (key 必须 ∈ ROLE_ENV_ALLOWLIST)。 */
  env: Record<string, string>;
  /** 多模态便宜层池 (persistMultimodalPool 整体替换; provider key 跳过则剔除该坐标)。 */
  multimodalPool?: string[];
  /** 多模态贵层池 (persistMultimodalPoolPremium; 置信不足/显式深读时升级)。 */
  multimodalPoolPremium?: string[];
  /** 需注册的自定 OpenAI 兼容 provider (upsertProvider 按 id merge 写 ~/.pi/agent/models.json)。 */
  customApis?: RolePresetCustomApi[];
  /** 缺则提示粘贴的 key (回车跳过)。 */
  keyPrompts?: RolePresetKeyPrompt[];
  /**
   * 依赖 pi OAuth 的 provider (如 kimi-coding): 免 API key, 就绪判定走 auth.json (piReady)。
   * 未登录 → wizard 出 /login 指引 + 该 provider 坐标从池/config 写入剔除 (同 key 跳过语义)。
   */
  oauthProviders?: string[];
  /** config.json 角色写入 (如 verifier 跨家族)。 */
  configRoles?: RolePresetConfigRole[];
}

const MINIMAX_API: RolePresetCustomApi = { id: 'minimax-cn', baseUrl: MINIMAX_BASE_URL, keyEnv: 'MINIMAX_API_KEY' };
const MINIMAX_KEY_PROMPT: RolePresetKeyPrompt = { env: 'MINIMAX_API_KEY', label: 'MiniMax API key (M3: 多模态池 + 合成)', provider: 'minimax-cn' };

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    id: 'base-opencode-go',
    label: '基础档 (opencode go 网关) — 一把 OPENCODE_API_KEY 走多家族 (deepseek/qwen/glm)',
    env: {
      // deepseek-v4-pro 掌关键角色 (runtime/规划/评判/终审/升级)
      OMD_RUNTIME_PROVIDER: 'opencode-go',
      OMD_RUNTIME_MODEL: 'deepseek-v4-pro',
      OMD_PLAN_MODEL: OC_DS_PRO,
      OMD_JUDGE_MODEL: OC_DS_PRO,
      OMD_REASON_MODEL: OC_DS_PRO,
      OMD_CONDUCTOR_ESCALATION_MODEL: OC_DS_PRO,
      // deepseek-v4-flash 铺量 (分解/inproc leaf/镜头)
      OMD_CG_CONDUCTOR_MODEL: OC_DS_FLASH,
      OMD_ITER_CONDUCTOR_MODEL: OC_DS_FLASH,
      OMD_CG_LEAF_MODEL: OC_DS_FLASH,
      OMD_ITER_LEAF_MODEL: OC_DS_FLASH,
      OMD_LENS_MODEL: OC_DS_FLASH,
      // qwen3.7-plus agent 干活 (own-loop leaf)
      OMD_CG_AGENT_MODEL: OC_QWEN_PLUS,
      OMD_ITER_AGENT_MODEL: OC_QWEN_PLUS,
      // glm-5.2 合成 (synth reduce)
      OMD_REDUCE_MODEL: OC_GLM,
    },
    multimodalPool: [OC_QWEN_PLUS],
    multimodalPoolPremium: [OC_GLM],
    // verifier 跨家族 (glm ≠ deepseek 主力) — 一把网关 key 即可实现。
    configRoles: [{ role: 'verifier', coord: OC_GLM }],
    customApis: [{ id: 'opencode-go', baseUrl: OPENCODE_GO_BASE_URL, keyEnv: 'OPENCODE_API_KEY' }],
    keyPrompts: [
      { env: 'OPENCODE_API_KEY', label: 'opencode go 网关 API key (一把 key 全家族)', provider: 'opencode-go' },
    ],
  },
  {
    id: 'cn-standard',
    label: '中间档 (deepseek v4 + MiniMax M3) — pro 关键角色, flash 铺量, M3 多模态 + verifier',
    env: {
      // pro 掌关键角色 (runtime/规划/评判/终审/升级)
      OMD_RUNTIME_PROVIDER: 'deepseek',
      OMD_RUNTIME_MODEL: 'deepseek-v4-pro',
      OMD_PLAN_MODEL: DS_PRO,
      OMD_JUDGE_MODEL: DS_PRO,
      OMD_REASON_MODEL: DS_PRO,
      OMD_CONDUCTOR_ESCALATION_MODEL: DS_PRO,
      // flash 铺量 (分解/执行/镜头/合成)
      OMD_CG_CONDUCTOR_MODEL: DS_FLASH,
      OMD_ITER_CONDUCTOR_MODEL: DS_FLASH,
      OMD_CG_LEAF_MODEL: DS_FLASH,
      OMD_ITER_LEAF_MODEL: DS_FLASH,
      OMD_CG_AGENT_MODEL: DS_FLASH,
      OMD_ITER_AGENT_MODEL: DS_FLASH,
      OMD_LENS_MODEL: DS_FLASH,
      OMD_REDUCE_MODEL: DS_FLASH,
    },
    multimodalPool: [MINIMAX_M3],
    // verifier 跨家族 (minimax ≠ deepseek 主力, 避同源盲点)。
    configRoles: [{ role: 'verifier', coord: MINIMAX_M3 }],
    customApis: [MINIMAX_API],
    keyPrompts: [
      { env: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key (主力)', provider: 'deepseek' },
      MINIMAX_KEY_PROMPT,
    ],
  },
  {
    id: 'cn-ultimate',
    label: '顶配档 (kimi k3 掌舵[pi OAuth 免 key] + deepseek 评判 + qwen 干活 + zhipu 审查 + MiniMax M3 多模态)',
    env: {
      // kimi-coding k3 掌舵 (pi OAuth, 免 key): runtime + 规划 + 分解 + 升级
      OMD_RUNTIME_PROVIDER: 'kimi-coding',
      OMD_RUNTIME_MODEL: 'k3',
      OMD_PLAN_MODEL: KIMI_CODING_K3,
      OMD_CG_CONDUCTOR_MODEL: KIMI_CODING_K3,
      OMD_ITER_CONDUCTOR_MODEL: KIMI_CODING_K3,
      OMD_CONDUCTOR_ESCALATION_MODEL: KIMI_CODING_K3,
      // deepseek pro 评判/终审/合成
      OMD_JUDGE_MODEL: DS_PRO,
      OMD_REASON_MODEL: DS_PRO,
      OMD_REDUCE_MODEL: DS_PRO,
      // zhipu glm-5.2 审 review 的 Spec 轴 (review 管线另行消费)
      OMD_REVIEW_SPEC_MODEL: ZHIPU_GLM,
      // qwen plus 干活 (inproc leaf/lens/agent leaf)
      OMD_CG_LEAF_MODEL: QWEN_PLUS,
      OMD_ITER_LEAF_MODEL: QWEN_PLUS,
      OMD_LENS_MODEL: QWEN_PLUS,
      OMD_CG_AGENT_MODEL: QWEN_PLUS,
      OMD_ITER_AGENT_MODEL: QWEN_PLUS,
      // router bandit 候选池 (pool[0] = 静态默认)
      OMD_ROUTER_POOL_INPROC: `${QWEN_PLUS},${MINIMAX_M3}`,
      OMD_ROUTER_POOL_AGENT: `${QWEN_PLUS},${QWEN_MAX}`,
    },
    multimodalPool: [QWEN_PLUS, MINIMAX_M3],
    multimodalPoolPremium: [ZHIPU_GLM, KIMI_CODING_K3],
    // verifier 跨家族 → qwen max (≠ kimi 掌舵 / deepseek 评判)
    configRoles: [{ role: 'verifier', coord: QWEN_MAX }],
    // 掌舵走 pi OAuth (免 key; 未登录 → wizard 出 /login 指引并剔除 kimi-coding 坐标)。
    oauthProviders: ['kimi-coding'],
    customApis: [MINIMAX_API, 
      { id: 'qwen', baseUrl: QWEN_BASE_URL, keyEnv: 'QWEN_API_KEY' },
      { id: 'zhipu', baseUrl: ZHIPU_BASE_URL, keyEnv: 'ZHIPU_API_KEY' },
    ],
    keyPrompts: [
      { env: 'QWEN_API_KEY', label: 'Qwen (DashScope) API key (干活 + verifier + 多模态)', provider: 'qwen' },
      { env: 'ZHIPU_API_KEY', label: 'Zhipu API key (review Spec 轴 + premium 多模态)', provider: 'zhipu' },
      { env: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key (评判 + 合成)', provider: 'deepseek' },
      MINIMAX_KEY_PROMPT,
    ],
  },
  {
    // ④ 三家档 cn-trio —— Opus 座舱下的 MCP 引擎配置 (掌舵实为 Claude, 引擎内部角色分三家):
    //   kimi k3 掌 conductor/judge, ds-flash 铺 fleet, MiniMax M3 管 synth + 多模态。
    //   无 OMD_PLAN_MODEL/plan 角色 —— 审议座舱由 Opus 4.8 顶替, plan 在 MCP 模式冗余 (仅独立 TUI 消费)。
    //   kimi-coding 认证走 ~/.pi/agent/auth.json (api_key 或 pi OAuth), 免 env key。
    id: 'cn-trio',
    label: '三家档 (kimi k3 掌舵/评判 + ds-flash 铺量/做梦 + MiniMax M3 合成/多模态) — Opus 座舱下的引擎配置',
    env: {
      // OMD_RUNTIME 保留作 conductor 兜底坐标 (掌舵实为 Opus; runtime 非独立大脑)。
      OMD_RUNTIME_PROVIDER: 'kimi-coding',
      OMD_RUNTIME_MODEL: 'k3',
      // conductor 掌舵 = kimi k3 (拆 DAG · 卡点升级)
      OMD_CG_CONDUCTOR_MODEL: KIMI_CODING_K3,
      OMD_ITER_CONDUCTOR_MODEL: KIMI_CODING_K3,
      OMD_CONDUCTOR_ESCALATION_MODEL: KIMI_CODING_K3,
      // judge 择优 = kimi k3
      OMD_JUDGE_MODEL: KIMI_CODING_K3,
      // synth 归约/综合 = MiniMax M3
      OMD_REDUCE_MODEL: MINIMAX_M3,
      OMD_REASON_MODEL: MINIMAX_M3,
      // fleet(leaf) 铺量执行 = ds-flash (inproc leaf / own-loop agent / 镜头)
      OMD_CG_LEAF_MODEL: DS_FLASH,
      OMD_ITER_LEAF_MODEL: DS_FLASH,
      OMD_CG_AGENT_MODEL: DS_FLASH,
      OMD_ITER_AGENT_MODEL: DS_FLASH,
      OMD_LENS_MODEL: DS_FLASH,
      // inproc bandit 池 (ROUTER-5 成本 reward): pool[0]=ds-flash 保静态默认, M3 竞争者 —
      // 学"过闸最省"。agent (改文件) 不开池, 保 ds-flash 确定性。
      OMD_ROUTER_POOL_INPROC: `${DS_FLASH},${MINIMAX_M3}`,
    },
    multimodalPool: [MINIMAX_M3],
    // canonical config 角色 (role-models.ts MODEL_ROLES): conductor/leaf/verifier。
    // verifier 默认 k3 (Nick: k3 或 codex; k3 与掌舵同源, codex 为跨家族避盲点备选)。
    configRoles: [
      { role: 'conductor', coord: KIMI_CODING_K3 },
      { role: 'leaf', coord: DS_FLASH },
      { role: 'verifier', coord: KIMI_CODING_K3 },
    ],
    // kimi-coding 走 pi 通道 (auth.json api_key 或 OAuth) — 免 env key, 就绪判定走 auth.json。
    oauthProviders: ['kimi-coding'],
    customApis: [MINIMAX_API],
    keyPrompts: [
      { env: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key (fleet 执行)', provider: 'deepseek' },
      MINIMAX_KEY_PROMPT,
      // kimi-coding 走 auth.json (api_key/OAuth), 免 env key → 不入 keyPrompts。
    ],
  },
  {
    // ⓪ 生产档 m3-codex (2026-09-11, 与本仓 .omd/config.json 同款): M3 坐 conductor / worker / 合成
    //   全部高频座 (便宜、原生多模态、1M 上下文); 终审 verifier / review 坐 ChatGPT 订阅的 gpt-5.6-sol
    //   (与 M3 异族, 判与证不共享盲点); escalation 坐 Claude 订阅的 opus-5 (owner 2026-09-11 裁)。
    //   两条订阅通道都免 env key: codex 走 pi OAuth (omd /login), claude-code 走 claude CLI 登录。
    id: 'm3-codex',
    label: '生产档 (MiniMax M3 掌舵/干活 + ChatGPT 订阅 sol 终审 + Claude 订阅 opus 升级) — 一把 MINIMAX_API_KEY + 两个订阅登录',
    env: {
      OMD_RUNTIME_PROVIDER: 'minimax-cn',
      OMD_RUNTIME_MODEL: 'MiniMax-M3',
      OMD_CG_CONDUCTOR_MODEL: MINIMAX_M3,
      OMD_ITER_CONDUCTOR_MODEL: MINIMAX_M3,
      OMD_CG_LEAF_MODEL: MINIMAX_M3,
      OMD_ITER_LEAF_MODEL: MINIMAX_M3,
      OMD_CG_AGENT_MODEL: MINIMAX_M3,
      OMD_ITER_AGENT_MODEL: MINIMAX_M3,
      OMD_LENS_MODEL: MINIMAX_M3,
      OMD_REDUCE_MODEL: MINIMAX_M3,
      OMD_REASON_MODEL: MINIMAX_M3,
      OMD_JUDGE_MODEL: CODEX_SOL,
      OMD_REVIEW_SPEC_MODEL: CODEX_SOL,
      OMD_CONDUCTOR_ESCALATION_MODEL: CLAUDE_OPUS,
    },
    multimodalPool: [MINIMAX_M3],
    configRoles: [
      { role: 'conductor', coord: MINIMAX_M3 },
      { role: 'leaf', coord: MINIMAX_M3 },
      { role: 'verifier', coord: CODEX_SOL },
    ],
    customApis: [MINIMAX_API],
    oauthProviders: ['openai-codex'],
    keyPrompts: [MINIMAX_KEY_PROMPT],
  },
];

/** 取坐标的 provider 前半 ('deepseek:xx' → 'deepseek'; 裸名原样返)。 */
export function coordProvider(coord: string): string {
  const sep = coord.indexOf(':');
  return sep === -1 ? coord : coord.slice(0, sep);
}
