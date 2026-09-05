/**
 * seat 真源**防回潮闸** (2026-08-10)。
 *
 * ## 它守的那一条
 *
 * seat 的 model 配置是真源 (owner 裁决): 任何座位模型只能经
 * `resolveSeatModel` / 座位链 (env > config.models[seat] > auto-assign > default)
 * 解析, 不许运行路径上有**字面坐标**绕过座位链直接吃 `provider:model`。
 * 本闸扫 `src` 下所有 `.ts` (递归) 里的字面坐标, 命中必须落在下方白名单 (声明面), 否则红。
 *
 * ## 扫描范围与排除面 (与 D-4 冻结一致)
 *
 * - 扫: `src` 下所有 `.ts` (递归)。
 * - 排除 (声明面, 永不进白名单也不扫):
 *   `src/model/seats.ts` (座位登记表本身) · `src/harness/init/role-presets.ts` (预设) ·
 *   `src/model/cost-ledger.ts` (价表) · `src/eval/oracles` 下全部 (实验臂) ·
 *   一切 `.test.ts` (含本文件, 不自咬) · 一切 `fixture` / `fixtures` 目录。
 *
 * ## 命中判定 (双闸 + 噪声滤)
 *
 * 1. 引号字符串字面量形如 `provider:model` (`LITERAL_COORD`)。
 * 2. 过 `COORD_RE` 复验 (与 headless-config 同款, 排除 URL / 逗号列表)。
 * 3. provider 段不在 `NOISE_PROVIDERS` 里 —— 该集合是**非模型命名空间**
 *    (`node:fs` import、`server:tool` MCP 工具 id、`conductor:plan` DAG 节点键、
 *    `off:flag` lint 键、`channel:model` 冷却键格式、`provider:model` 占位文案、
 *    `HH:MM:ss.l` 时间串等), 它们不是模型坐标, 只报真坐标才能让闸可读。
 *    模型 provider 不会叫这些名字; 若真出现, 反倒在 1+2 都过时被白名单兜住。
 *
 * ## 白名单
 *
 * 唯一合法豁免面 = audit-judge 判为**声明面**的存量命中 (b1 修完后的最终字面集)。
 * 每条必须有 reason; 无 reason = 红。违例**不许**进白名单 —— 违例的正解是
 * 改走座位链, 不是豁免。键 = (repo 相对路径, 字面量原文), 与当前命中集合**双向
 * 精确匹配**: 多出一个字面坐标 → 红; 白名单条目从代码里消失 (死条目) → 也红,
 * 逼白名单跟代码同生共死, 不许悄悄攒僵尸。
 *
 * ## ★ 证伪方法 (每次改这个闸必做一次, 做不到 = 闸已哑, 不许合入)
 *
 * 在任一被扫文件 (如 `src/model/providers.ts`) 临时加一行:
 *
 *     const tmp = 'fakeprovider:fake-model';
 *
 * 跑 `bun test src/eval/seat-coordinate-gate.test.ts` → **必须红**, 且红文点名
 * `fakeprovider:fake-model` 与所在文件:行。删掉临时行 → 必须回绿。
 * 本文件已自带两层自动自检 (sample 源码直喂扫描函数), 手工证伪仍须照做一次。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { gateAllowReason } from '../harness/gates/gate-allow';
import { COORD_RE } from '../harness/init/headless-config';

const SRC_ROOT = join(import.meta.dir, '..', '..', 'src');

/** 引号字符串字面量里的 `provider:model` 形状 (粗筛, 双闸第二道在 COORD_RE)。 */
const LITERAL_COORD = /(['"])((?:[a-z0-9._-]+):(?:(?!\/\/)[^\s,'"]+))\1/gi;

/**
 * 非模型命名空间 —— provider 段命中这里 = 不是模型坐标, 不报。
 * 逐条有据 (2026-08-10 全仓扫描观察): node/bun = import 命名空间; server = MCP 工具 id
 * (`server:tool`); provider = 占位文案 (`provider:model[Id]`); conductor = DAG 节点键
 * (`conductor:plan/repair`); channel = provider-health 冷却键 (`channel:model`);
 * path = pathfinder 节点键 (`path:map`) 与 `node:path`; seat = TUI/设置键 (`seat:more`);
 * off = verifier lint 键 (`off:flag`); exec/classify/canary/grill/setSecrets/addTicket/rule/
 * research/contract/W2/file/fixture = 各自领域键; config = 配置段键; urn = OAuth 标识;
 * HH = 时间串 (`HH:MM:ss.l`); SYS = pino-pretty 的**本机时区**前缀 (`SYS:HH:MM:ss.l`,
 * 2026-08-21 加, 见 `src/logger.ts` 那段注释 —— 没它就按 UTC 打且不标时区);
 * suggest/confirmSuggestion/syncFromMap = backend-gh 的
 * GhRunner ctx 键 (`syncFromMap:state` 等, 与 rule/addTicket 同族 —— 2026-08-11 切片 4 新增)。
 */
const NOISE_PROVIDERS: ReadonlySet<string> = new Set([
  'node', 'bun', 'path', 'server', 'provider', 'config', 'exec', 'classify', 'seat',
  'channel', 'rule', 'off', 'grill', 'canary', 'addTicket', 'setSecrets', 'contract',
  'urn', 'W2', 'fixture', 'research', 'file', 'HH', 'SYS', 'package.json', 'conductor',
  'suggest', 'confirmSuggestion', 'syncFromMap',
  // pytest 的插件开关值 `-p no:<plugin>` (2026-09-05, goal/falsify-tests.ts 的
  // `no:cacheprovider`) —— 是 pytest 的命名空间, 不是模型 provider。
  'no',
  // autoresearch 夜链挖题矿源的 CandidateItem.id 命名空间 `<source>:<stable-key>`
  // (2026-09-02, docs/plan/2026-09-02-夜间自迭代链-执行契约.md 冻结接口) —— 非模型坐标。
  'sessions', 'readout',
  // backend-gh 的 run(gh, …, op) 操作标签命名空间 (c2f87e6 新增三步 escalate:stamp/reopen/label,
  // 与上一行 addTicket/syncFromMap 同族) —— 非模型坐标。
  'escalate',
  // 同族再一条 (#203, 2026-08-19): `markDispatch:open` / `markDispatch:settle` ——
  // gh 派发锚的两阶段操作标签, 不是模型坐标。
  'markDispatch',
  // R-2 (2026-08-30): rubric 逐条判官的**角色标签** `judge:rubric`(goal/rubric-judge.ts)——
  // 与上面 `gate:convergence` / `web:distill-*` 同族: 是 seat-usage 台账的 meta.role,
  // 不是模型坐标。真坐标由调用点的 `config.dag.conductorModel` 经座位链给, 一个字没绕过。
  // t-gate-inmigrate (2026-09-01): 闸 B 冲突 runId 命名空间 `seat-check:family` /
  // `seat-check:<seatId>`(goal/ignition-preflight.ts)—— 判词标识, 不是模型坐标;
  // 真坐标全部来自 seatExpectations 声明与 renderConfigDump 实配, 零字面绕过。
  'seat-check',
  // P2b (2026-09-02): live 变异的 seat-usage 角色标签 `mutate:live`(eval/replay/mutate.ts)
  // —— 与 thinker:critique / judge:rubric 同族, 归座在 TRACE_SEAT_RULES, 不是模型坐标。
  'mutate',
  // ⚠ `classify` 早就在上面那行里了 —— 同样是 traceName 前缀, 只是当时没连 `judge` 一起加。
  'judge',
  // per-seat 台账的**角色标签**命名空间 (`web:expand` / `web:distill-source` / `web:distill-challenger`,
  // 2026-08-14) —— 与 `conductor:plan` 同族: 它们是观测面的 meta.role, 不是模型坐标。
  // 真坐标仍由这三处各自的 resolveSeatModel('expand'/'distill') 解析, 一个字都没绕过座位链。
  'web',
  // 同上一族, 2026-08-16 (#144 洞 1) 补的四个**角色标签**命名空间。此前这批调用点根本不带
  // meta.role, 于是它们的量全沉在台账的 `(unattributed)` 桶里 (402 发无归属) —— 补标签才让
  // 「verifier/gate/review/escalation 各烧了多少」问得出来。四个都不是模型坐标:
  // escalation → engine.ts 升级重规划轮 (`escalation:plan` / `escalation:repair`),
  //   真坐标是 `config.conductorEscalationModel`, 由座位链解析;
  // gate → plan/llm-judge.ts 的 `gate:convergence`, 真坐标 opts.judgeModel (gate 座);
  // review → review/run.ts 与 review/verify.ts (`review:spec` / `review:<维度>` /
  //   `review:verify-*`), 真坐标由 resolveReviewModels 的 review 座给;
  // best-of-n → plan/best-of-n.ts 两发, 真坐标 opts.model ?? resolveSeatModel('reason')。
  'escalation', 'gate', 'review', 'best-of-n',
  // 同族再一条 (2026-08-31, Thinker 席): `thinker:critique` / `thinker:critique-escalated` ——
  // 重画前置批评步的**角色标签** (dag/thinker.ts)。真坐标: 默认档 = 调用方 conductorModel,
  // 升档 = SEAT_PREFERRED_COORD['verifier'] (座位链), 一个字面坐标都没写。
  'thinker',
]);

/**
 * ISO-8601 时间戳 —— **不是模型坐标**, 是被冒号骗进来的假阳性 (2026-08-28)。
 *
 * `'2026-01-01T00:00:00Z'` 被 `LITERAL_COORD` 读成 provider=`2026-01-01T00` / model=`00:00Z`,
 * 而 provider 段随日期变, 塞不进 `NOISE_PROVIDERS` 那张固定表 (表里的 `HH` 只挡得住
 * `HH:MM:ss.l` 这种**格式串**, 挡不住真实日期)。所以这一格按**形状**判, 不按 provider 名判。
 *
 * ⚠ 这是**假阳性修复**, 不是放宽: 真坐标的 provider 段不可能长成 `YYYY-MM-DDTHH`。
 * 仓规「假阳性不许升」约束的正是这种 —— 一条恒红且红得没道理的闸, 会让人对红脱敏。
 * ⚠ 走**噪声滤**不走白名单是刻意的: 白名单要求「与当前命中集合双向精确匹配」,
 * 拿它挡一个会随日期变的字面量, 下次改冻结时间就多一条死条目。
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** 扫描排除面 (与 D-4 冻结一致) —— 相对 repo 根的路径判定。 */
function isExcluded(rel: string): boolean {
  if (rel === 'src/model/seats.ts') return true;
  if (rel === 'src/harness/init/role-presets.ts') return true;
  if (rel === 'src/model/cost-ledger.ts') return true;
  if (rel.startsWith('src/eval/oracles/')) return true;
  if (rel.endsWith('.test.ts')) return true;
  if (rel.includes('/fixture/') || rel.includes('/fixtures/')) return true;
  return false;
}

export interface CoordHit {
  file: string;
  line: number;
  coord: string;
}

/** 扫一遍 src 运行路径, 返回全部字面坐标命中 (已过 COORD_RE + 噪声滤)。 */
export function scanLiteralCoords(srcRoot: string): CoordHit[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(srcRoot);

  const hits: CoordHit[] = [];
  for (const f of files.sort()) {
    const rel = relative(process.cwd(), f).replace(/\\/g, '/');
    if (isExcluded(rel)) continue;
    const src = readFileSync(f, 'utf8');
    const srcLines = src.split('\n');
    LITERAL_COORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LITERAL_COORD.exec(src)) !== null) {
    const coord = m[2]!;
    if (!COORD_RE.test(coord)) continue; // 双闸: URL / 逗号列表等不是坐标。
    if (ISO_TIMESTAMP.test(coord)) continue; // 被冒号骗进来的时间戳, 不是坐标。
    if (NOISE_PROVIDERS.has(coord.slice(0, coord.indexOf(':')))) continue; // 非模型命名空间。
    const line = src.slice(0, m.index).split('\n').length;
    // 引用语境豁免 (2026-08-26): 同行带 `gate-allow(seat-coordinate): <理由>` 即放行。
    // 解释「某个坐标写法不该出现」的注释必须把它写出来, 而本闸只看字面 —— 五次实撞,
    // 每次都只能靠改述绕开, 代价是反面教材被磨掉。理由必须非空, 空标记不生效。
    if (gateAllowReason(srcLines[line - 1] ?? '', 'seat-coordinate') !== null) continue;
    hits.push({ file: rel, line, coord });
    }
  }
  return hits;
}

/** 白名单 —— 唯一合法豁免面: audit-judge 判为声明面的存量命中 (2026-08-10 冻结)。 */
const ALLOWLIST: readonly { file: string; coord: string; reason: string }[] = [
  { file: 'src/harness/dag/defaults.ts', coord: 'opencode-go:deepseek-v4-flash', reason: 'leaf 满 cap 溢出目标默认; 独立旋钮 OMD_LEAF_OVERFLOW_MODEL env 可覆盖 — 选择层默认 (pool-defaults 同款哲学), 非座位绑定' },
  { file: 'src/mcp/tools/config-tools.ts', coord: 'kimi-coding:k3', reason: 'omd_set_role 工具 description 的示例文案 (e.g. 引导), 非运行消费点' },
  { file: 'src/mcp/tools/config-tools.ts', coord: 'zhipu:glm-4.6', reason: 'omd_set_model 工具 description 的示例文案, 非运行消费点' },
  { file: 'src/model/auto-assign.ts', coord: 'deepseek:deepseek-v4-flash', reason: 'auto-assign 落类首选兜底 (PREFERRED_COORD ×4 + REDUCE_COORD); resolveSeatModel 链 auto-assign 层的声明, 非绕过' },
  { file: 'src/model/model-ratings.ts', coord: 'kimi-coding:k3', reason: '注释示例 (D-8 provider 品牌+modelId 匹配逻辑说明), 非运行值' },
  { file: 'src/model/pool-defaults.ts', coord: 'opencode-go:deepseek-v4-flash', reason: '池源码默认 (FALLBACK_WORKER); 文件头明示 config/env 是真源, 本文件只是开箱兜底' },
  { file: 'src/model/pool-defaults.ts', coord: 'opencode-go:deepseek-v4-pro', reason: '池源码默认 (LENS_DIVERGENCE), 同上' },
  { file: 'src/model/pool-defaults.ts', coord: 'opencode-go:glm-5.2', reason: '池源码默认 (JUDGE_PANEL + FALLBACK_*), 同上' },
  { file: 'src/model/pool-defaults.ts', coord: 'opencode-go:kimi-k3', reason: '池源码默认 (FALLBACK_DECOMPOSER/JUDGE_SYNTH), 同上' },
  { file: 'src/model/pool-defaults.ts', coord: 'opencode-go:minimax-m3', reason: '池源码默认 (LENS_DIVERGENCE), 同上' },
  { file: 'src/model/pool-defaults.ts', coord: 'opencode-go:qwen3.7-plus', reason: '池源码默认 (LENS_DIVERGENCE), 同上' },
  { file: 'src/model/pool-defaults.ts', coord: 'opencode-go:qwen3.8-max', reason: '池源码默认 (JUDGE_PANEL + FALLBACK_VERIFY), 同上' },
  { file: 'src/model/provider-health.ts', coord: 'allegretto:kimi-k3', reason: 'JSDoc @param 示例 (channel:model 冷却键格式说明), 非运行值' },
  { file: 'src/model/role-fallback.ts', coord: 'deepseek:x', reason: '注释示例 (providerOf 说明), 非运行值' },
  { file: 'src/model/types.ts', coord: 'mimo:deepseek-v4-flash', reason: 'JSDoc 示例 (ModelRequest.model 字段说明), 非运行值' },
  { file: 'src/model/minimax-native.ts', coord: 'minimax-cn:MiniMax-M3', reason: '文件头注释里的实测样例 (展示走 pi 通道时 text 粘着 <think> 的原样输出), 非运行值; 路由判定读的是 piModel.provider 不是这个字面串' },
  { file: 'src/harness/web/url-guard.ts', coord: 'fc00::/7', reason: 'IPv6 CIDR 字面量 (SSRF 闸 PRIVATE_RANGES 网段表, run 960c5107 C1), 坐标正则误匹配, 非模型坐标' },
  { file: 'src/harness/web/url-guard.ts', coord: 'fe80::/10', reason: '同上 — IPv6 link-local CIDR, 非模型坐标' },
];

const allowlistKey = (h: { file: string; coord: string }): string => `${h.file}\t${h.coord}`;
const allowlistKeys = new Set(ALLOWLIST.map(allowlistKey));

describe('seat 真源防回潮闸', () => {
  test('白名单每条都有 reason (无 reason 的条目 = 红)', () => {
    for (const e of ALLOWLIST) {
      expect(e.reason.trim().length, `${e.file} ${e.coord} 缺 reason`).toBeGreaterThan(0);
    }
  });


  test('正则与噪声滤: 真坐标命中, node/server/conductor 不命中', () => {
    const src = [
      "import x from 'node:fs';",
      "const a = 'server:tool';",
      "const b = 'conductor:plan';",
      // 2026-08-28: 时间戳那一格。**真坐标与它同处一份样本**是这条用例的判别力所在 ——
      // 只放时间戳的话, 一个「什么都不报」的坏滤器也能让它绿。
      "const t = '2026-01-01T00:00:00Z';",
      "const t2 = '2026-08-28 14:03';",
      "const c = 'fakeprovider:fake-model';",
    ].join('\n');
    const found: string[] = [];
    LITERAL_COORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LITERAL_COORD.exec(src)) !== null) {
    const coord = m[2]!;
    if (!COORD_RE.test(coord)) continue;
    if (ISO_TIMESTAMP.test(coord)) continue;
    if (NOISE_PROVIDERS.has(coord.slice(0, coord.indexOf(':')))) continue;
    found.push(coord);
    }
    expect(found).toEqual(['fakeprovider:fake-model']);
  });

  test('src 运行路径无未豁免的字面坐标 (新增违例当场红)', () => {
    const hits = scanLiteralCoords(SRC_ROOT);
    const violations = hits.filter((h) => !allowlistKeys.has(allowlistKey(h)));
    const report = violations
      .map((h) => `${h.file}:${h.line}: ${h.coord} — 走 resolveSeatModel/座位链, 或加白名单 (带 reason)`)
      .join('\n');
    expect(report, `未豁免字面坐标 ${violations.length} 条:\n${report}`).toBe('');
  });

  test('白名单无死条目: 每条仍活在代码里 (逼白名单跟代码同生共死)', () => {
    const hits = scanLiteralCoords(SRC_ROOT);
    const liveKeys = new Set(hits.map(allowlistKey));
    const dead = ALLOWLIST.filter((e) => !liveKeys.has(allowlistKey(e)));
    const report = dead.map((e) => `${e.file} ${e.coord} — 已从代码消失, 删白名单条目`).join('\n');
    expect(report, `死白名单条目 ${dead.length} 条:\n${report}`).toBe('');
  });
});
