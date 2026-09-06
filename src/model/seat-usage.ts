/**
 * src/model/seat-usage —— **per-seat 调用台账**(2026-08-14 排的薄片)。
 *
 * ## 为什么不是往 tui-usage.jsonl 上加两列
 *
 * `tui-usage.jsonl` 记在 `callModel` 出口(`emitModelUsage`),那一层**看不见角色**——
 * 它只知道坐标与 token。角色标签(`GenerateFn.traceName` → `GatewayMeta.role`)只活到
 * `gateway.send`,再往下就被剥掉了。于是「这一发是谁烧的」在既有账本里**结构上答不出来**,
 * 不是没记而是记不了。这本账挂在 `send` 上,补的正是那一列。
 *
 * 两本账各答各的,别互相当对方的校验:
 * - `tui-usage.jsonl` = 钱(计价/通道/5h 窗口),覆盖面 = 全部 `callModel`;
 * - `seat-usage.jsonl` = 归属(座位/角色/runId),覆盖面 = **只有经 `send` 的那些**。
 *
 * ## 覆盖面诚实(先写在这,免得有人拿它当全量)
 *
 * `send` **不是**模型调用的唯一物理出口:
 * - agent leaf 走 pi-agent-core 自己的循环(`agent-leaf.ts`),不经 `send`;
 * - `dream/extract-*` 直调 `callModel`,同样不经 `send`。
 *
 * 前者 2026-08-16 补上了(issue #144),但**补的方式与经 send 的那些不同**,读账的人必须知道:
 * agent leaf 由 `dag/engine.ts` 的 `settle()` 记**节点级**一条(`entry:'node'`),
 * 数据源与 `result.usage.leavesIn/Out/CacheHit` 是**同一个** `LeafResult.usage` ——
 * 于是两本账在 agent 这一列**按构造对得上**,不会再出现「A 有 110.9M、B 只有寥寥数发」
 * 那种差三个数量级的对不上(#144 评论 §「补账前必须先决定哪一套是真理源」)。
 * 经 send 的那些仍是**发级**(`entry:'call'`)。两种粒度靠 `entry` 列分辨 ——
 * 别把两种行的条数相加当发数;`in`/`out` 相加是对的(物理上不重叠,agent 那条路不经网关)。
 *
 * `dream/extract-*` 仍缺席。所以按座位求和出来的仍是**下界**。缺席 ≠ 0(本仓 §3 第 1 条),
 * 消费面别把它读成"这个座没花钱"。
 *
 * ## seat 这一列是**派生**的,traceName 才是原始观测
 *
 * 网关手上没有座位 id —— 座位在调用点就被解析成坐标了(`resolveSeatModel`),传到网关的只剩
 * 一个人可读的角色标签。所以 `seat` 由 {@link seatOfTrace} 从 `traceName` 反查,而
 * `traceName` **原样写入磁盘**:映射表将来发现是错的,历史行还能重算。认不出的写 `null`,
 * 不编一个 `'unknown'` 座位(§3 第 1 条:`NULL` ≠ 0 ≠ 不适用,抹平了事后就分不开)。
 *
 * 同理,调用抛错时 `in`/`out` 落 `null` 而不是 0 —— 那是「没读到」不是「没烧」,靠 `error` 列分辨。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../logger';
import { omdRepoRoot } from '../harness/repo-root';
import { resolveProject } from '../harness/project-scope';

/** 账本文件名(相对 `.omd/`)。 */
export const SEAT_USAGE_FILE = 'seat-usage.jsonl';

export interface SeatUsageEntry {
  ts: number;
  /** 座位 id。`null` = 这个 traceName 反查不到座位(见 {@link seatOfTrace}),不是「没有座位」。 */
  seat: string | null;
  /** 网关看见的原始角色标签(`GatewayMeta.role`)。调用方没给则 `null`。 */
  traceName: string | null;
  /** provider:modelId —— 响应回报的坐标优先(溢出/回退后可能与请求的不是一个)。 */
  model: string;
  /** `null` = 这一发没读到 usage(抛错 / provider 不报),不是 0。 */
  in: number | null;
  out: number | null;
  /** `null` = provider 不报缓存命中,不是「零命中」。 */
  cacheHit: number | null;
  /** 归组键(engine 里 = `config.sessionId ?? continuity.runId`)。孤立调用为 `null`。 */
  runId: string | null;
  /**
   * 这一行的**粒度**。`'call'` = 一次 `gateway.send`(默认,缺席按 `'call'` 读);
   * `'node'` = 一整个 leaf 节点的模型消耗合计(agent leaf 不经网关,只能在节点出口记)。
   * 两者的 `calls` 不可相加当发数;`in`/`out` 可以相加(物理上不重叠)。
   *
   * ⚠ 这一列存在的理由与本仓 §3 第 1 条同源:两种粒度混在一本账里而不留分辨列,
   * 事后就再也分不开「84 次工具调用的 agent 节点」和「一发」。
   */
  entry?: 'call' | 'node';
  /** 节点作用域调用才有(`GatewayMeta.nodeId` / settle 的节点 id);run 级调用 `null`。 */
  nodeId?: string | null;
  /**
   * 这一发烧在哪一段。取**图名原文**(`goal-contract` / `goal-execute` / `goal-execute-flat` / …),
   * 不在这里归成 contract/execute 两类 —— 同 `traceName`:原始观测写入磁盘,归类留给消费面,
   * 映射错了历史行还能重算。调用点没给 → 缺席。
   */
  phase?: string | null;
  /**
   * 规划座专用:这一发是**第几次被闸拒回后的重问**。`0` = 首问;`1`/`2` = 拒回重问。
   * 缺席 = 不适用(不是规划发)。#144 洞 3 想问的「一张坏图烧了几发在拒回上」就读这一列:
   * `sum(in) where rejectRound > 0` = 空转的规划量。
   */
  rejectRound?: number;
  /**
   * 这一跑在**哪个仓**上干活(git toplevel basename)。#144 洞 2 问的「单仓成本」由这一列答。
   *
   * 刻意**不**把账本按 cwd 拆到各仓 —— `repo-root.ts:38-48` 明写了为什么引擎自己的读数留痕库
   * 必须锚在引擎仓:按 cwd 写入磁盘会碎成一堆互相看不见的库,而那种缺数**长得像「引擎没记」**。
   * 一列 `repo` 既留住了跨仓可比性,又答得出单仓账;拆库两样都丢一样。
   */
  repo?: string | null;
  /** 只在调用抛错时有:错误原文(fail-open 不吞证据,§3 第 2 条)。 */
  error?: string;
}

/**
 * traceName → 座位 id。**这张表是派生视图,真源是各调用点解析的那个座**;
 * 每一条都是读代码核出来的(不是按名字猜的),核的位置写在行尾。
 *
 * ⚠ 反查不到就返 `null`。宁可缺一列,不许把两个座位的量并进一个编出来的桶。
 */
const TRACE_SEAT_RULES: readonly [RegExp, string][] = [
  [/^conductor:/, 'conductor'], // engine.ts:278/422/1182 → conductorModel
  // escalation 座**此前在账上不存在**, 且不是缺数是**错归**(比缺数难发现得多): 升级重规划时
  // engine.ts:3879 把 conductorModel 换成 conductorEscalationModel, 但 traceName 仍打
  // `conductor:*` → escalation 的钱结构上算在 conductor 头上。2026-08-16 (#144 洞 1) 分标签。
  [/^escalation:/, 'escalation'], // engine.ts:278/1182 在 escalated 轮改打这个前缀
  // Thinker 批评步 (2026-08-31, 契约 D-2/D-3 两档): 归到**烧钱的那个座**, 与 escalation
  // 分标签同一课 —— 一个标签配两种模型必有一半错归。默认档在 dag/thinker.ts
  // resolveCritiqueModel 走 conductorModel; 升档走 seats 表 verifier 座 preferredCoord。
  [/^thinker:critique$/, 'conductor'], // dag/thinker.ts buildCritiquePrompt (默认档 → opts.conductorModel)
  [/^thinker:critique-escalated$/, 'verifier'], // dag/thinker.ts runCritiqueStep 升档改打此标签 → SEAT_PREFERRED_COORD['verifier']
  [/^judge:/, 'judge'], // engine.ts:1018
  [/^leaf:/, 'leaf'], // engine.ts:3018 → config.leafModel
  [/^primitive-leaf:/, 'leaf'], // engine.ts:2380 → 同 leaf 档
  [/^map-lister:/, 'leaf'], // engine.ts:2257 → config.leafModel
  [/^fanin-summary:/, 'leaf'], // engine.ts:3186 → faninCfg.model ?? config.leafModel(显式覆盖时会错归, model 列可查)
  [/^verifier$/, 'verifier'], // verifier.ts:302 → opts.verifierModel(verifier 座)
  // 证伪测试那一发 (2026-09-05, goal/run-goal.ts 的 D-7 段): 坐的是同一个 verifier 座
  // (resolveRoleModel('verifier')), 所以座位归 verifier; **标签另起**是为了在 byTrace 上
  // 数得出「证伪这一步烧了多少」—— 并进 'verifier' 桶就再也分不开 (与 escalation 分标签同一课)。
  [/^verifier-falsify$/, 'verifier'],
  [/^review:spec$/, 'review-spec'], // review/run.ts:250 → specModel ⚠ 必须排在 /^review:/ 前面
  [/^review:/, 'review'], // review/run.ts:264 维度召回 + verify.ts:60/148 证伪两发, 都吃 review 座
  // engine.ts settle() 的节点级行。**只有 agent 一种** —— 别的 kind 都经网关, 已有发级行,
  // 再记一条会把同一份 in/out 计两遍 (判据写在 settle 里那段注)。
  [/^agent-leaf$/, 'agent'],
  [/^omd-leaf$/, 'leaf'], // dag/defaults.ts:31 缺 traceName 时的兜底标签
  // research fanout 的分 stage 标签 (2026-08-14 加, 见 research/fanout.ts 的 CallFn.stage)。
  // **stage 才是原始观测**, 座位只是往上归一层 —— 想问「那 8M 花在哪」要看 byTrace 不是 bySeat。
  [/^fanout:gen$/, 'lens'], // lensModel / divergePool —— 池里换的是模型, 角色仍是 lens 座
  [/^fanout:reduce$/, 'reduce'], // resolveRoleModelConfigured('reduce')
  [/^fanout:judge$/, 'judge'], // resolveRoleModelConfigured('judge')
  [/^fanout:(gap|synth|fusion|graft)$/, 'reason'], // 四个都默认 cfg.reasonModel (可被 synthPool/fusionModel/graftModel 覆盖 → 那时 model 列可查)
  // web 检索层 (2026-08-14 补标签)。此前这三处 send **不带 role**, 于是落进 traceName=null
  // 与别家无名调用混一桶 —— 而「distill 输入截断」正是 research 降耗的候选之一, 量不出来就选不了。
  [/^web:expand$/, 'expand'], // web/query-expand.ts → resolveSeatModel('expand')
  [/^web:distill-/, 'distill'], // web/distill-source.ts 与 distill-challenger.ts → resolveSeatModel('distill')
  // autoresearch 进化内环的 live 变异 (P2b, 2026-09-02): eval/replay/mutate.ts 走 conductor
  // 座真联机 (契约「变异算子 = M3 生产同款」)。分标签不借 conductor:* —— 变异的钱要能与
  // 规划的钱分开看 (byTrace), 归座才并到 conductor。
  [/^mutate:live$/, 'conductor'], // eval/replay/mutate.ts defaultMutationProvider
];
/** 归座规则覆盖到的座位集合(由 TRACE_SEAT_RULES 第二列机器去重) —— 与 seats.ts 的 ALL_SEAT_IDS 是两套独立真源, 覆盖闸判的是二者的差集。 */
export const SEAT_USAGE_RULE_SEATS: ReadonlySet<string> = new Set(TRACE_SEAT_RULES.map(([, seat]) => seat));

/**
 * 明知归不了座的标签 —— 列在这里是为了把「还没核」与「核过, 归不了」分开
 * (前者该去核,后者不必再核)。
 */
export const KNOWN_UNATTRIBUTABLE: ReadonlySet<string> = new Set([
  // research fanout 的 gen/reduce/synth/judge/graft **五个阶段共用这一个标签**
  // (fanout.ts:315 是所有阶段的单一漏斗)。它同时也是契约段 90.8% 量的所在地
  // (2026-08-14 读数)—— 想按阶段分账得先在 fanout 侧分标签, 那是另一片的活。
  'fanout-leaf',
  'seed-author', // web-fanout.ts:186, 种子 query 作者; 模型由调用方传, 座位不确定
  'classify:acceptance', // goal/classify-acceptance.ts:264, 模型由 run-goal 注入
  // best-of-n 的两发 (plan/best-of-n.ts:139 生成 / :165 judge)。**核过, 归不了**:
  // 模型是 `opts.model ?? resolveSeatModel('reason')`, 而唯一的生产调用方 (:281) 另给一份
  // lensModel —— 同一个标签底下坐着哪个座取决于调用方, 编一个座位归进去就是错归。
  // 想分开先在调用方把座位定死, 那是另一片的活。
  'best-of-n:gen',
  'best-of-n:judge',
  'research:author-spec', // research/author-spec.ts:111, 模型 = conductorModel 但可被 input 覆盖
  // R4 (2026-09-06) 异族座出题 (goal/criterion-author.ts)。**核过, 归不了**: 坐标是
  // `crossFamilyModel(conductorModel)` —— 与 conductor 异族的**第一个**可解析座位, 可能是
  // verifier 座也可能是 escalation 座, 逐 run 逐配置不同。编一个座位归进去就是错归。
  'goal:criterion-author',
  'model-call', // gateway 的兜底标签(调用方没给 role)
  // ⚠ 'model-call' 在本账本里**永远不会出现**: gateway.ts:95 那个兜底名只喂 Langfuse,
  // seat-usage 走的是 `role ?? null`。留着是为了「核过」这层语义, 别当它是活标签。
]);

/** traceName 反查座位;认不出返 `null`(含 `undefined` 入参)。 */
export function seatOfTrace(traceName: string | undefined | null): string | null {
  if (!traceName) return null;
  if (KNOWN_UNATTRIBUTABLE.has(traceName)) return null;
  for (const [re, seat] of TRACE_SEAT_RULES) if (re.test(traceName)) return seat;
  return null;
}

/**
 * 这个 traceName **核过没有** —— 归得了座 ∨ 明知归不了。
 * 与 {@link seatOfTrace} 分开是因为两者的 `null` 不是一回事:新加一个标签没人管它,和
 * 核过确认归不了座,在 `seatOfTrace` 的返回值上长得一模一样。覆盖率闸判的是这一个。
 */
export function traceIsClassified(traceName: string): boolean {
  return KNOWN_UNATTRIBUTABLE.has(traceName) || seatOfTrace(traceName) !== null;
}

/** 账本路径。`OMD_SEAT_USAGE_PATH` 显式覆盖(测试/隔离档用),否则 `<omdRepoRoot>/.omd/`。 */
export function seatUsagePath(): string {
  return process.env.OMD_SEAT_USAGE_PATH || join(omdRepoRoot(), '.omd', SEAT_USAGE_FILE);
}

// 解析结果按**中央路径**做键缓存, 不做进程级单例: `OMD_SEAT_USAGE_PATH` 是逐测试改的
// (seat-usage.test.ts:35), 进程级 memo 会让第二个用例读到第一个的解析。键变了就重解析。
let _writableFor: string | undefined;
let _writableTo: string | undefined;

/**
 * 账本路径,**带只读回退**(2026-08-30, bench 容器实测)。
 *
 * omd 以只读挂载分发时 (workbuddy-bench split-mount → `/opt/omd/pkg`), `mkdir <仓根>/.omd`
 * 抛 EROFS。兄弟账本 `dag-record` 早就有回退 (`dag-record.ts:684` `ledgerPathWritable`),
 * 这一本没有 —— 只 warn 一句就把整发丢掉。实测后果: `2026-08-29__21-54-51` 批
 * **75/77 trial 的 seat-usage 每一发都写失败**, 于是「协调税」的分子
 * (verifier / judge / classify / map lister —— 这些都**不是 DAG 节点**, token 只落这一本)
 * 在容器里结构上取不到数, 而 `tui-usage.jsonl` 那一本按它自己的注 (本文件 §6) 「看不见角色」,
 * 补不上。偏差是**单向的**: 分子少算 ⇒ 协调税被系统性低估。
 *
 * 回退序与 `ledgerPathWritable` 逐字同款: `OMD_DATA_HOME` → `cwd/.omd`。
 * 代价同款 = 该跑不进中央账本, 所以证据行必打。
 *
 * ⚠ 证据行**每个解析键只打一次**, 不是每发一行 —— 本函数在每一次模型调用上被调,
 * 而 `ledgerPathWritable` 是每个留痕器构造时调一次。照抄那边的写法会让容器里刷出
 * 几百行同样的话, 把日志淹掉(那批日志里 `[omd/seat-usage] 台账写入失败` 已经是这个形态)。
 *
 * 反向自检 (当场验过, 见 seat-usage-fallback.test.ts):
 *   · 把 `catch` 整段删掉、改成直接 `return central` → 「中央不可写时仍写得进」那条红;
 *   · 把 `OMD_DATA_HOME` 那一项删掉 → 「显式数据根优先于 cwd」那条红;
 *   · 把键缓存改成进程级单例 → 「换一个中央路径要重解析」那条红。
 */
export function seatUsagePathWritable(): string {
  const central = seatUsagePath();
  if (_writableFor === central && _writableTo !== undefined) return _writableTo;
  _writableFor = central;
  try {
    mkdirSync(dirname(central), { recursive: true });
    _writableTo = central;
  } catch (e) {
    const fallbackRoot = process.env.OMD_DATA_HOME?.trim() || join(process.cwd(), '.omd');
    // fail-open 但留证据 (§3 第 2 条): 这一行是"为什么中央账本缺了这跑"唯一的解释。
    process.stderr.write(
      `[omd/seat-usage] 中央台账不可写 (${(e as Error).message}) → 回退 ${fallbackRoot}/${SEAT_USAGE_FILE} (该跑不进中央读数板)\n`,
    );
    _writableTo = join(fallbackRoot, SEAT_USAGE_FILE);
  }
  return _writableTo;
}

/**
 * 真 provider 前缀。**判「这条是不是真调用」的一半**(另一半是 usage 量级, 见下)。
 *
 * 与 `.omd/config.json` 的 `subscriptionProviders` **不是**一回事 —— 那张表分的是"烧哪本账",
 * 这张分的是"是不是真发出去过"。夹具坐标(`fixture:none` / `l:l` / `fake:leaf` / `c:m` / `test:leaf`)
 * 一个都不在这里。
 */
const REAL_PROVIDER_PREFIXES = [
  'deepseek:', 'minimax-cn:', 'minimax:', 'claude-code:', 'openai-codex:', 'openai:',
  'anthropic:', 'kimi-coding:', 'opencode-go:', 'mimo-platform:', 'mimo:', 'google:',
] as const;

/**
 * 这一条是**测试夹具写的合成记录**吗?返回原因串,`null` = 真调用。
 *
 * ## 为什么需要它
 *
 * 2026-08-21 实测:`.omd/seat-usage.jsonl` 里 **21,028 / 23,392 条是合成的**(≈90%)——
 * 全仓测试跑在真仓根目录, `emitSeatUsage` 于是把夹具的每一发都写进**生产账本**。
 * 后果不是"文件大了": **任何直接读这个账本的读数, 不过滤就是九成噪声**。
 * 实际踩过 —— 报「verifier 占全部调用 0.23%」时分母用的是被污染的 21,674,
 * 真实分母是 2,183(真占比 2.4%)。结论方向没变, 但那个数是错的。
 *
 * ## 两条判据(都要过才算真)
 *
 * ① **provider 前缀是真的** —— 夹具爱用 `fixture:none` / `l:l` / `fake:leaf` 这种;
 * ② **`in > 10`** —— 真 LLM 调用光系统提示就几百 token。实测分布有干净断崖:
 *    `in ≤ 10` 有 20,698 条, `in > 10` 只有 2,185 条, 中间近乎空。
 *    ⚠ 阈值取 10 不取 0: 夹具里有一批用**真坐标**(如 `claude-code:claude-sonnet-5`)
 *    配 `in=1 out=1`, 只看前缀漏得掉。
 *
 * ⚠ **`in === null` 不算合成** —— 那是"这一发没读到 usage"(抛错 / provider 不报),
 * 是真调用的一种失败形态。`NULL ≠ 0 ≠ 不适用`, 压成合成就把真失败抹掉了。
 */
export function syntheticSeatUsageReason(entry: Pick<SeatUsageEntry, 'model' | 'in'>): string | null {
  const model = String(entry.model ?? '');
  if (!REAL_PROVIDER_PREFIXES.some((p) => model.startsWith(p))) return 'fake-model';
  // null 显式放行: 没读到 usage ≠ 合成。
  if (typeof entry.in === 'number' && entry.in <= 10) return 'toy-usage';
  return null;
}

/**
 * 当前工作仓名(`repo` 列)。`resolveProject` 要 spawn 一次 git,而本函数在**每一发**上被调用 ——
 * 进程级记一次即可(一个进程的 cwd 不会中途换仓;换了也是隔离档,那时 runId 也不同)。
 * 解不出来 → `null`(§3 第 1 条:不编一个 `'unknown'` 仓)。
 */
let _repoSlug: string | null | undefined;
function currentRepo(): string | null {
  if (_repoSlug === undefined) {
    try {
      _repoSlug = resolveProject().slug;
    } catch {
      _repoSlug = null; // 非 git 且无 OMD_PROJECT → fail-closed 抛, 这里当"不知道"处理
    }
  }
  return _repoSlug;
}

/**
 * 记一发。**fail-open**:账本写不进去绝不能把模型调用带塌 —— 但失败要留一行证据
 * (§3 第 2 条:可以吞异常,不许吞证据)。`OMD_SEAT_USAGE=off` 显式关。
 *
 * `repo` 由本函数补(调用点全都不知道自己在哪个仓,而且知道了也会各算一份必漂)。
 */
export function recordSeatUsage(entry: SeatUsageEntry): void {
  if (process.env.OMD_SEAT_USAGE === 'off') return;
  // 只读挂载下回退到可写根 (见 seatUsagePathWritable 的注): 此前这里用 `seatUsagePath()`,
  // 容器里每一发都 EROFS, 整本账在 bench 上恒空。
  const path = seatUsagePathWritable();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ...entry, repo: entry.repo ?? currentRepo() })}\n`);
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, '[omd/seat-usage] 台账写入失败 (调用本身不受影响)');
  }
}

/** 读回全本。坏行跳过(账本是读数不是闸);读不到返空数组。 */
export function readSeatUsage(path: string = seatUsagePath()): SeatUsageEntry[] {
  if (!existsSync(path)) return [];
  const out: SeatUsageEntry[] = [];
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as SeatUsageEntry;
        if (typeof r.ts === 'number' && typeof r.model === 'string') out.push(r);
      } catch {
        // 坏行跳过
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, '[omd/seat-usage] 台账读回失败');
  }
  return out;
}

export interface SeatUsageBucket {
  calls: number;
  in: number;
  out: number;
  cacheHit: number;
  /** 有几发**没读到** token(抛错/provider 不报)—— 上面三个和是下界,差多少看这个数。 */
  unmeasured: number;
}

export interface SeatUsageSummary {
  /** 桶键 = 座位 id;归不了座的行进 `'(unattributed)'` 桶,与真座位分开摆。 */
  bySeat: Record<string, SeatUsageBucket>;
  /** 同一批行按原始 traceName 分。座位归不了的时候,这一层仍然分得开。 */
  byTrace: Record<string, SeatUsageBucket>;
  total: SeatUsageBucket;
}

/** 归不了座的桶键。刻意不叫 `unknown` —— 它是一类**已知**的行,只是没有座位。 */
export const UNATTRIBUTED = '(unattributed)';

const emptyBucket = (): SeatUsageBucket => ({ calls: 0, in: 0, out: 0, cacheHit: 0, unmeasured: 0 });

function addTo(buckets: Record<string, SeatUsageBucket>, key: string, e: SeatUsageEntry): void {
  const b = (buckets[key] ??= emptyBucket());
  b.calls += 1;
  if (e.in === null && e.out === null) b.unmeasured += 1;
  b.in += e.in ?? 0;
  b.out += e.out ?? 0;
  b.cacheHit += e.cacheHit ?? 0;
}

/**
 * 「规划层」座位 —— 决定**做什么**的那些发。
 * 分层是消费面的归类,不是账本的原始观测:改这两张表不用重跑任何 run,历史行照样重算。
 */
export const PLANNING_SEATS: ReadonlySet<string> = new Set([
  'conductor',
  'escalation',
  'verifier',
  'judge',
  'review',
  'review-spec',
]);

/** 「执行层」座位 —— 真去干活的那些发。 */
export const EXECUTION_SEATS: ReadonlySet<string> = new Set(['leaf', 'agent']);

/**
 * #144 验收判据的**直接答案**:任取一个 run,规划层 vs 执行层各烧了多少、其中多少是拒回重问。
 *
 * 三个桶互斥且穷尽(`other` 收两张表都不认的座位与 `(unattributed)`)—— 别把 `other` 读成 0,
 * 它是「还没归层的量」,和"没花钱"是两回事。
 */
export interface RunCostBreakdown {
  planning: SeatUsageBucket;
  execution: SeatUsageBucket;
  other: SeatUsageBucket;
  /**
   * 规划层里 `rejectRound > 0` 的那部分 = **闸拒回后重问烧掉的量**(#144 洞 3 的空转)。
   * ⚠ 它是 `planning` 的**子集**,不是第四个桶,别把四个数加起来当总量。
   */
  planningRejects: SeatUsageBucket;
  /** 按图名分(`goal-contract` / `goal-execute` / …)。没给 phase 的行进 `(unattributed)`。 */
  byPhase: Record<string, SeatUsageBucket>;
}

/** 按层 + 拒回轮 + 图名拆一次 run 的账。`runId` 省略 = 拆全本。 */
export function breakdownRun(entries: SeatUsageEntry[], runId?: string): RunCostBreakdown {
  const planning = emptyBucket();
  const execution = emptyBucket();
  const other = emptyBucket();
  const planningRejects = emptyBucket();
  const byPhase: Record<string, SeatUsageBucket> = {};
  for (const e of entries) {
    if (runId !== undefined && e.runId !== runId) continue;
    const seat = e.seat;
    const isPlanning = seat !== null && PLANNING_SEATS.has(seat);
    const target = isPlanning ? planning : seat !== null && EXECUTION_SEATS.has(seat) ? execution : other;
    addTo({ t: target }, 't', e);
    if (isPlanning && (e.rejectRound ?? 0) > 0) addTo({ t: planningRejects }, 't', e);
    addTo(byPhase, e.phase ?? UNATTRIBUTED, e);
  }
  return { planning, execution, other, planningRejects, byPhase };
}

/** 按座位 / 按 traceName 聚合。`runId` 给则只算那一次 run 的行。 */
export function aggregateSeatUsage(entries: SeatUsageEntry[], runId?: string): SeatUsageSummary {
  const bySeat: Record<string, SeatUsageBucket> = {};
  const byTrace: Record<string, SeatUsageBucket> = {};
  const total = emptyBucket();
  for (const e of entries) {
    if (runId !== undefined && e.runId !== runId) continue;
    addTo(bySeat, e.seat ?? UNATTRIBUTED, e);
    addTo(byTrace, e.traceName ?? UNATTRIBUTED, e);
    addTo({ t: total }, 't', e);
  }
  return { bySeat, byTrace, total };
}
