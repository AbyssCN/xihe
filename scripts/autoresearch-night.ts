#!/usr/bin/env bun
/**
 * scripts/autoresearch-night —— 夜链的**拓扑 + driver** (契约切片 4, D-1 / D-11)。
 *
 *   bun scripts/autoresearch-night.ts --dry-run          # 零 LLM: 构链 + 编译 + 装饰 + 打印
 *   bun scripts/autoresearch-night.ts                    # 点火
 *   bun scripts/autoresearch-night.ts --gate-cards <raw.json> --candidates <c.json> --out <cards.json>
 *
 * ## D-1 拓扑不出模型
 *
 * 七段链是这里**写死**的, 不是 conductor 画的。理由是实测: 教 conductor 自由画图会塌
 * (dynamic-workflow-design §6 R1)。LLM 只坐 4 个座 —— 提案 (agent) · 变异算子 (session 内) ·
 * 跨模型 verifier · 晨报 (synthesize); 其余五段全部零 LLM。
 *
 * ## D-11 装饰在编译之后、parsePlan 之前
 *
 * `Stage` 接口没有 `write_set` / `timeoutMs` 槽, 而**冻结接口不动** (D-12 红线)。
 * 于是 driver 对编译产物做一次 `decorateNightPlan`, 再把装饰后的 plan 过一遍 `parsePlan` ——
 * 装饰不许把 plan 装成非法的。
 *
 * ## 晨报两半 (D-7)
 *
 * synthesize 节点只写判词与升人票; 数字表由 driver 用**机械附录**追加在文末。
 * 两半不一致以附录为准 —— 这条规则由 driver 写进晨报首行, 不靠人记。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { summarizeReadout, type ReadoutRow } from './speedup-readout';
import { dirname, join } from 'node:path';
import { gateCards, type CardGateCaps } from '../src/eval/replay/session-card';
import { compileChain, type Stage, type StageChain } from '../src/harness/goal/stage-chain';
import { parsePlan, type ConductorPlan } from '../src/harness/conductor-plan';
import type { Candidates } from '../src/eval/replay/miners';

export interface NightOpts {
  date: string;
  maxCards: number;
  nightBudgetMinutes: number;
  sessionBudgetMinutes: number;
  cwd: string;
}

export const NIGHT_STAGE_IDS = [
  'mine',
  'propose',
  'card-gate',
  'sessions',
  'promote',
  'verify',
  'report',
] as const;

/** 本夜目录 (相对仓根)。所有产物挂它下面, 一夜一个目录 = 一次实验一份账。 */
export function nightDir(date: string): string {
  return `runs/autoresearch/night-${date}`;
}

// ── 提案节点的 goal (D-2 防作弊: 只给 candidates 与目标摘要, 不给评估器代码) ─────

/** 卡的 schema 原文, 嵌进提案 goal —— 提案席不读 session-card.ts, 只读这段。 */
const CARD_SCHEMA_TEXT = [
  '{ "cards": [ {',
  '  "version": 1, "id": "<短横线小写 id>",',
  '  "substrate": "S3",',
  '  "mainObjective": "planValidityRate" | "fakeSerialPairsTotal" | "speedupTheoreticalMedian"',
  '                 | "shapeDeclarationRate" | "planningTokensTotal",',
  '  "objectiveRow": "O1" | "O2" | "O3a" | "O3b" | "O3c",',
  '  "hypothesis": "<一句可证伪的假设>",',
  '  "evidenceRefs": ["<candidates.items[].id, 逐字复制>"],',
  '  "successSignal": "<什么读数算成 —— 动手前写死>",',
  '  "voidConditions": ["<什么情况下这条读数作废>"],',
  '  "budgetMinutes": <整数>,',
  '  "goal": "<改什么>", "writeSet": ["<路径>"], "verify": "<命令>"',
  '} ] }',
].join('\n');

function proposeGoal(opts: NightOpts): string {
  const dir = nightDir(opts.date);
  return [
    `读 ${dir}/candidates.json 与 docs/plan/autoresearch-objective.md 的目标/护栏两节,`,
    `提出今晚要跑的研究卡, 写进 ${dir}/cards.raw.json。`,
    '',
    '## 硬约束',
    '',
    `- 至多 ${opts.maxCards} 张卡; ΣbudgetMinutes ≤ ${opts.nightBudgetMinutes}, 单卡 ≤ ${opts.sessionBudgetMinutes}。`,
    '- 一张卡只跑一个基质, 今天只有 S3 (代码改动走 solve); S1/S2 (变异 v1 prompt) 已于 2026-09-04 退役。',
    '- mainObjective 只能取下面 schema 里列出的五个字面量之一。',
    '- evidenceRefs 每一条必须逐字等于 candidates.items[].id 里的某一个; 不许自己编 id。',
    '- S3 卡的 writeSet 不许含: docs/plan/autoresearch-objective.md · src/eval/replay/** ·',
    '  runs/autoresearch/corpus/** · scripts/autoresearch-*.ts (这些是尺子, 改尺子只走人审)。',
    `- 只写 ${dir}/cards.raw.json 这一个文件, 不碰别的。`,
    '- 输出必须是能被 JSON.parse 的整份文档, schema 如下:',
    '',
    '```json',
    CARD_SCHEMA_TEXT,
    '```',
    '',
    '## 提示',
    '',
    '- successSignal 与 voidConditions 是**预声明**: 事后再定判据等于没判据, 晨报会原样回显它们。',
    '- 一张卡只动一个变量 —— 同时动两个, 塌了分不清是谁的。',
    '- candidates 里 metrics.count 大的簇不一定值得跑; 值得跑的是「改得动 ∧ 有主目标可量」的那条。',
    '- 今晚没有值得跑的卡, 就写 `{"cards": []}` —— 无卡不是失败, 硬凑一张才是。',
  ].join('\n');
}

// ── D-1: 七段链 ───────────────────────────────────────────────────────────

/** 同一 opts 两次调用产物逐字节相同 (INV-1): 全部输入都来自 opts, 无时钟无随机。 */
export function buildNightChain(opts: NightOpts): StageChain {
  const d = nightDir(opts.date);
  const stages: Stage[] = [
    {
      id: 'mine',
      word: 'command',
      command: `bun scripts/autoresearch-mine.ts --out ${d}/candidates.json --since 7d`,
      goal: '挖题: 五个确定性矿源 → candidates.json (零 LLM)',
    },
    { id: 'propose', word: 'agent', goal: proposeGoal(opts) },
    {
      id: 'card-gate',
      word: 'command',
      command:
        `bun scripts/autoresearch-night.ts --gate-cards ${d}/cards.raw.json ` +
        `--candidates ${d}/candidates.json --out ${d}/cards.json ` +
        `--max-cards ${opts.maxCards} --night-budget-minutes ${opts.nightBudgetMinutes} ` +
        `--session-budget-minutes ${opts.sessionBudgetMinutes}`,
      goal: '校卡: 六道语义闸机械剔卡; 全剔也退 0 (无卡不是失败)',
    },
    {
      id: 'sessions',
      word: 'command',
      command:
        `bun scripts/autoresearch-night-sessions.ts ${d}/cards.json --out ${d}/results.json ` +
        `--night-budget-minutes ${opts.nightBudgetMinutes}`,
      goal: '按卡序串行跑 session (S3 子进程 solve, worktree 分支)',
    },
    {
      id: 'promote',
      word: 'command',
      command:
        `bun scripts/autoresearch-promote.ts ${d}/results.json --out ${d}/promotion.json ` +
        `--date ${opts.date}`,
      goal: '晋升闸: S3 主目标量不出 → 恒 held + 机械审计 (分支真在 / 禁改路径 / 判据虚探针), 人审后进 main',
    },
    {
      id: 'verify',
      word: 'verify',
      goal:
        `promotion.json 每条 promoted 的产物只触碰其卡声明的基质; S3 分支 diff 不含 ` +
        `docs/plan/autoresearch-objective.md · src/eval/replay/** · runs/autoresearch/corpus/** · ` +
        `scripts/autoresearch-*.ts 任一路径; 判词与 held-out 读数一致。`,
    },
    {
      id: 'report',
      word: 'synthesize',
      goal:
        `读 ${d}/results.json 与 ${d}/promotion.json 以及上游 verify 判词, 写 ${d}/morning.md: ` +
        '① 每张卡的假设 / 预声明成败信号 / 实际读数, 塌与不塌都写; ② 晋升判词逐条; ' +
        '③ 需要人裁的票 (升人票) 单列一节。**不要**自己算数字表 —— 数字由机械附录负责。',
    },
  ];
  return { stages };
}

// ── D-11: 装饰 ────────────────────────────────────────────────────────────

/** 写集只许落在本夜目录内 —— 夜链的自动产物不许溢出到别处。 */
function writeSetOf(stageId: string, date: string): string[] | null {
  const d = nightDir(date);
  if (stageId === 'propose') return [`${d}/cards.raw.json`];
  if (stageId === 'report') return [`${d}/morning.md`];
  return null;
}

/**
 * 编译产物 → 装饰后的 plan, 再过一次 `parsePlan` (装饰不许把 plan 装成非法的)。
 *
 * 三件事:
 *  ① agent / synthesize 节点加 `write_set` (只许写本夜目录);
 *  ② sessions 节点加 `timeoutMs` = 夜帽;
 *  ③ verify 节点 `params.gate` 落成 false (D-6: 夜链最后一段必须无条件产报告)。
 *
 * ✎ ③ 是装饰而不是改编译器: `compileChain` 把 verify 词硬编成 `gate: true`, 而
 *   `src/harness/goal/stage-chain.ts` 在 D-12 越界红线里。装饰是不碰冻结接口的那条路。
 * ✎ ② 今天**只是声明**: 全仓唯一读 `timeoutMs` 的地方是 `engine.ts:2728` 的 await 节点 spec,
 *   command 节点的真超时来自 `createCommandLeafRunner({ timeoutMs })` (默认 60s)。所以 driver
 *   点火时**另外**把夜帽传给 command runner —— 光装饰节点不足以让 sessions 跑满一夜。
 *   这条差异记在报告的 finding 里, 没有静默按「装上就生效」处理。
 */
export function decorateNightPlan(plan: ConductorPlan, opts: NightOpts): ConductorPlan {
  const nodes: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(plan.nodes)) {
    const next: Record<string, unknown> = { ...(node as Record<string, unknown>) };
    const ws = writeSetOf(id, opts.date);
    if (ws) next.write_set = ws;
    if (id === 'sessions') next.timeoutMs = opts.nightBudgetMinutes * 60_000;
    if (id === 'verify') {
      const params = { ...((next.params as Record<string, unknown>) ?? {}), gate: false };
      next.params = params;
    }
    nodes[id] = next;
  }
  const decorated = { ...plan, nodes };
  const reparsed = parsePlan(JSON.stringify(decorated), { knownServers: new Set<string>() });
  if (!reparsed.ok) {
    throw new Error(`decorateNightPlan 装出了非法 plan (D-11 闸): ${reparsed.error}`);
  }
  return reparsed.plan;
}

/** 构链 + 编译 + 装饰, 一步到位 (dry-run 与点火共用同一条路径 —— 两条路会漂移)。 */
export function buildNightPlan(opts: NightOpts): ConductorPlan {
  return decorateNightPlan(compileChain(buildNightChain(opts)), opts);
}

/** dry-run 的 stdout (纯函数, 便于测试逐字断言)。 */
export function renderDryRun(plan: ConductorPlan, opts: NightOpts): string {
  const lines = [
    `[autoresearch-night] dry-run · date=${opts.date} · ${nightDir(opts.date)}`,
    `节点 ${Object.keys(plan.nodes).length} 个 (零 LLM: 本次未调用任何模型)`,
  ];
  for (const id of NIGHT_STAGE_IDS) {
    const node = plan.nodes[id] as Record<string, unknown> | undefined;
    if (!node) {
      lines.push(`  ✗ ${id} — 缺席 (拓扑坏了)`);
      continue;
    }
    const deps = (node.depends_on as string[] | undefined) ?? [];
    const kind = (node.executor as string | undefined) ?? (node.primitive as string) ?? '?';
    const extra = [
      node.write_set ? `write_set=${(node.write_set as string[]).join(',')}` : '',
      node.timeoutMs ? `timeoutMs=${String(node.timeoutMs)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(`  · ${id} [${kind}] depends_on=[${deps.join(', ')}]${extra ? ` · ${extra}` : ''}`);
  }
  return lines.join('\n');
}

// ── 预登记 (四要素; driver 点火时生成) ────────────────────────────────────

export function renderPrereg(opts: NightOpts): string {
  return [
    `# 夜链预登记 ${opts.date}`,
    '',
    '> 动手前写死。事后改这份文件 = 没判据。',
    '',
    '- **单一变量**: 夜链本身 (引擎快照固定, 见下 HEAD)。',
    '- **预先声明的成败信号**:',
    '  1. ≥1 张卡过校卡闸;',
    '  2. ≥1 条 session 曲线的主目标非 null (依赖 t-speedup-null 修尺);',
    '  3. 晋升判词可读 (三格各有明确归属);',
    `  4. 夜墙钟 ≤ ${(opts.nightBudgetMinutes / 60).toFixed(1)}h。`,
    '- **对照基线**: P2b 手动 session `s3-real-1788288836636` (同座位套)。',
    '- **收数**: 逐卡 token / 墙钟 / 代数 / 停机原因 —— **塌与不塌都记**。',
    `- **预算帽**: 每夜 ≤ ${opts.maxCards} 卡 · 单卡 ≤ ${opts.sessionBudgetMinutes}min · 夜 ≤ ${opts.nightBudgetMinutes}min。`,
    '',
  ].join('\n');
}

// ── D-7: 晨报的机械那一半 ────────────────────────────────────────────────

/** 逐卡曲线 / 晋升判词 / 墙钟 —— 全部机械算, 不经 LLM。 */
/** O3a 夜读数 (objective.md 2026-09-04 修订): run 桶 speedup>1 占比 (主) + 中位 (副)。null = 桶空 / 账本读不到, 不是 0。 */
export type O3aReading = { date: string; runMeasurable: number; runShareGt1: number | null; runMedian: number | null };

/**
 * 从 dag-runs.db 读 O3a (只读; 读不到 → null + 一行证据, fail-open —— 层④告知, 不挡晨报)。
 * 这是「三夜基线」的采样点: 同一把尺、同一账本, 每夜一行追加到 o3a-baseline.jsonl, 夜与夜的方差就是 2 (血统) 的噪声底。
 */
export function readO3a(cwd: string, date: string): O3aReading | null {
  const p = join(cwd, '.omd', 'dag-runs.db');
  if (!existsSync(p)) {
    process.stderr.write(`[autoresearch-night] O3a: dag-runs.db 不在 (${p}) → 本夜无读数 (null)\n`);
    return null;
  }
  try {
    const db = new Database(p, { readonly: true });
    const rows = db.query('select nodes, shape_id, created_at, entry from omd_dag_runs').all() as ReadoutRow[];
    db.close();
    const s = summarizeReadout(rows);
    if (s === null) return { date, runMeasurable: 0, runShareGt1: null, runMedian: null };
    return { date, runMeasurable: s.runMeasurable, runShareGt1: s.runShareGt1, runMedian: s.runMedian };
  } catch (e) {
    process.stderr.write(`[autoresearch-night] O3a: dag-runs.db 读取失败 → 本夜无读数 (null): ${(e as Error).message}\n`);
    return null;
  }
}

/** 追加一行到基线序列 (append-only)。 */
export function appendO3aBaseline(path: string, r: O3aReading): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(r) + '\n');
}

export function renderMechanicalAppendix(
  results: { cards?: { cardId: string; substrate: string; stopReason: string; wallMs: number;
    curve?: { gen: number; main: number | null; validity: number | null }[]; error?: string }[];
    reason?: string } | null,
  promotion: { verdicts?: { cardId: string; verdict: string; reason: string }[] } | null,
  o3a: O3aReading | null = null,
): string {
  const lines = ['', '---', '', '## 机械附录 (driver 追加, 零 LLM)', ''];
  // O3a 先于逐卡: 它是夜与夜之间唯一同尺可比的数 (三夜基线)。null 原样印 null (NULL ≠ 0)。
  lines.push('### O3a (run 桶 · 字段后可量行 · 全账本累计)');
  if (o3a === null) lines.push('- 无读数 (账本读不到, 见 stderr 证据行)');
  else {
    const share = o3a.runShareGt1 === null ? 'null' : `${(o3a.runShareGt1 * 100).toFixed(1)}%`;
    const med = o3a.runMedian === null ? 'null' : o3a.runMedian.toFixed(3);
    lines.push(`- speedup>1 占比 ${share} · 中位 ${med} · n=${o3a.runMeasurable}`);
  }
  lines.push('');
  const cards = results?.cards ?? [];
  if (cards.length === 0) {
    lines.push(`- 本夜零卡跑过${results?.reason ? ` (${results.reason})` : ''}。`);
  }
  for (const c of cards) {
    lines.push(`### ${c.cardId} [${c.substrate}]`);
    lines.push(
      `- 停机原因 ${c.stopReason} · 墙钟 ${(c.wallMs / 1000).toFixed(1)}s` +
        `${c.error ? ` · 错误 ${c.error}` : ''}`,
    );
    const curve = c.curve ?? [];
    if (curve.length === 0) lines.push('- 曲线: 无代记录');
    else {
      lines.push('- 曲线 (gen · 主目标 · validity):');
      for (const p of curve) {
        // NULL ≠ 0: 主尺缺席原样印 null, 不印 0 也不空着。
        lines.push(`  - g${p.gen} · ${p.main === null ? 'null' : p.main} · ${p.validity === null ? 'null' : p.validity}`);
      }
    }
    lines.push('');
  }
  const verdicts = promotion?.verdicts ?? [];
  lines.push('### 晋升判词');
  if (verdicts.length === 0) lines.push('- 无判词 (零卡或 promotion.json 缺席)。');
  for (const v of verdicts) lines.push(`- ${v.cardId}: **${v.verdict}** —— ${v.reason}`);
  lines.push('');
  return lines.join('\n');
}

export const APPENDIX_PRECEDENCE_LINE =
  '> 本报告两半: 判词由 synthesize 席写, 数字表由 driver 机械追加。**两半不一致以附录为准。**';

// ── CLI ───────────────────────────────────────────────────────────────────

export interface NightArgs {
  mode: 'dry-run' | 'gate-cards' | 'ignite';
  opts: NightOpts;
  gateCardsPath?: string;
  candidatesPath?: string;
  out?: string;
}

const USAGE =
  'usage: bun scripts/autoresearch-night.ts [--dry-run] [--date YYYY-MM-DD]\n' +
  '       [--max-cards 3] [--night-budget-minutes 480] [--session-budget-minutes 120]\n' +
  '       | --gate-cards <raw.json> --candidates <c.json> --out <cards.json>';

export function parseNightArgs(argv: readonly string[]): NightArgs {
  let mode: NightArgs['mode'] = 'ignite';
  let date = new Date().toISOString().slice(0, 10);
  let maxCards = 3;
  let nightBudgetMinutes = 480;
  let sessionBudgetMinutes = 120;
  let cwd = process.cwd();
  let gateCardsPath: string | undefined;
  let candidatesPath: string | undefined;
  let out: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺值`);
      return v;
    };
    if (a === '--dry-run') mode = 'dry-run';
    else if (a === '--date') date = next();
    else if (a === '--max-cards') maxCards = Number(next());
    else if (a === '--night-budget-minutes') nightBudgetMinutes = Number(next());
    else if (a === '--session-budget-minutes') sessionBudgetMinutes = Number(next());
    else if (a === '--cwd') cwd = next();
    else if (a === '--gate-cards') {
      mode = 'gate-cards';
      gateCardsPath = next();
    } else if (a === '--candidates') candidatesPath = next();
    else if (a === '--out') out = next();
    else throw new Error(`认不出的参数: ${a}`);
  }
  const opts: NightOpts = { date, maxCards, nightBudgetMinutes, sessionBudgetMinutes, cwd };
  if (mode === 'gate-cards') {
    if (!candidatesPath) throw new Error('--gate-cards 要配 --candidates');
    if (!out) throw new Error('--gate-cards 要配 --out');
    return { mode, opts, gateCardsPath: gateCardsPath!, candidatesPath, out };
  }
  return { mode, opts };
}

/** 读一份 JSON, 读不到 / 坏了 → null (夜链的每一段都不许因为上游缺文件而炸)。 */
function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    process.stderr.write(`[autoresearch-night] ${path} 读不动: ${(e as Error).message}\n`);
    return null;
  }
}

/** `--gate-cards` 分支: 校卡 → cards.json。全剔也退 0。 */
export function runGateCards(args: Required<Pick<NightArgs, 'gateCardsPath' | 'candidatesPath' | 'out'>> & { opts: NightOpts }): number {
  const raw = readJson<unknown>(args.gateCardsPath);
  const candidates = readJson<Candidates>(args.candidatesPath) ?? {
    version: 1 as const,
    generatedAt: '',
    sinceIso: '',
    items: [],
    errors: [],
  };
  const caps: CardGateCaps = {
    maxCards: args.opts.maxCards,
    nightBudgetMinutes: args.opts.nightBudgetMinutes,
    sessionBudgetMinutes: args.opts.sessionBudgetMinutes,
  };
  const result = gateCards(raw ?? [], candidates, caps);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `[card-gate] 收 ${result.accepted.length} 张 · 剔 ${result.rejected.length} 张 → ${args.out}\n`,
  );
  for (const r of result.rejected) process.stdout.write(`  ✗ ${r.reason}\n`);
  return 0;
}

if (import.meta.main) {
  let args: NightArgs;
  try {
    args = parseNightArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
    process.exit(2);
  }

  if (args.mode === 'gate-cards') {
    process.exit(
      runGateCards({
        gateCardsPath: args.gateCardsPath!,
        candidatesPath: args.candidatesPath!,
        out: args.out!,
        opts: args.opts,
      }),
    );
  }

  if (args.mode === 'dry-run') {
    // 零 LLM: 本分支不 import 也不触发任何模型件。
    process.stdout.write(`${renderDryRun(buildNightPlan(args.opts), args.opts)}\n`);
    process.exit(0);
  }

  // ── 点火 ──────────────────────────────────────────────────────────────
  //
  // ⚠ 引擎与模型件走**动态 import**, 只在这条分支加载。dry-run 分支于是连
  //   `src/model/gateway` 都不会被求值 —— 「零 LLM」不是靠自觉, 是靠 import 图。
  const d = join(args.opts.cwd, nightDir(args.opts.date));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'prereg.md'), renderPrereg(args.opts));

  const plan = buildNightPlan(args.opts);
  const [{ runExecutorDagWithPlan }, { createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST },
    { createAgentLeafRunner }, { bootstrapModelRuntime }] = await Promise.all([
    import('../src/harness/dag/engine'),
    import('../src/harness/command-leaf'),
    import('../src/harness/agent-leaf'),
    import('../src/model/bootstrap'),
  ]);
  bootstrapModelRuntime();

  // D-10 座位不写字面: 全部取冻结语料 manifest 的 seats。
  const manifest = readJson<{ seats?: Record<string, string> }>(
    join(args.opts.cwd, 'runs/autoresearch/corpus/manifest.json'),
  );
  const seats = manifest?.seats ?? {};
  if (!seats.conductor || !seats.worker) {
    process.stderr.write(
      '[autoresearch-night] manifest.json 没有 seats.conductor / seats.worker —— ' +
        '座位是读数的一部分, 缺席不许拿默认值顶上。\n',
    );
    process.exit(2);
  }

  const res = await runExecutorDagWithPlan(plan, {
    conductorModel: seats.conductor,
    leafModel: seats.worker,
    agentLeafModel: seats.worker,
    maxFanout: 1, // 线性链, 无扇出
    agentRunner: createAgentLeafRunner({ cwd: args.opts.cwd }),
    // sessions 段要跑一整夜: 节点上的 timeoutMs 今天没有消费者 (见 decorateNightPlan ✎②),
    // 真正管用的是这里的 runner 级界。
    commandRunner: createCommandLeafRunner({
      cwd: args.opts.cwd,
      allowlist: [...DEFAULT_COMMAND_ALLOWLIST],
      timeoutMs: args.opts.nightBudgetMinutes * 60_000,
    }),
  });

  // D-7 晨报两半: 判词由 report 节点写, 数字表在这里机械追加。
  const morning = join(d, 'morning.md');
  const written = existsSync(morning) ? readFileSync(morning, 'utf8') : '';
  const head = written === '' ? `# 晨报 ${args.opts.date}\n\n(report 节点未产出判词)\n` : written;
  const o3a = readO3a(args.opts.cwd, args.opts.date);
  if (o3a) appendO3aBaseline(join(args.opts.cwd, 'runs', 'autoresearch', 'o3a-baseline.jsonl'), o3a);
  writeFileSync(
    morning,
    `${APPENDIX_PRECEDENCE_LINE}\n\n${head}${renderMechanicalAppendix(
      readJson(join(d, 'results.json')),
      readJson(join(d, 'promotion.json')),
      o3a,
    )}`,
  );

  const failed = Object.values(res.results).filter((r) => r.status === 'failed');
  process.stdout.write(
    `[autoresearch-night] 图跑完 · ${failed.length} 个节点红 · 晨报 ${morning}\n`,
  );
  // 夜链的出口码只说「图跑没跑完」, 不说「今晚有没有成果」—— 后者在晨报里。
  process.exit(0);
}
