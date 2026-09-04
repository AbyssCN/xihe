/**
 * src/eval/replay/miners —— 夜链「挖题」的五个**纯函数** (契约切片 2, D-2)。
 *
 * 承 `docs/plan/2026-09-02-夜间自迭代链-执行契约.md`:
 *  - D-2 挖题 = 确定性矿源 + 一次提案调用。矿源这一半**零 LLM**: 输入 = 已读进内存的原始数据,
 *    输出 = `CandidateItem[]`。取原料 (sqlite / fs) 全在薄 CLI `scripts/autoresearch-mine.ts`,
 *    于是这里可以被真样本直接注入验判别力, 不起任何进程。
 *  - D-2 后半 (fail-open 留证据): 某个矿源读不到 → CLI 记进 `errors[]` 不中断。**判定在这里的
 *    函数里, 处置在 CLI 里** —— 纯函数不认识「读不到」这件事, 它只认识「没有数据」。
 *
 * ## 为什么 `null` 入参与 `[]` 返回不是一回事
 *
 * `mineReadout(null)` / `mineTestHealth(null)` 返回 `[]`, 但那**不表示这一类是零**;
 * 表示这一类今天没读到。两者的分辨靠 CLI 写进 `errors[]` 的那一行, 不靠 items 的长度
 * (仓规 §静默坑 1: NULL ≠ 0 ≠ 不适用)。
 *
 * ## 反向自检
 *
 * `miners.test.ts` 每个 miner 各配一份「该出题」与一份「不该出题」的样本 —— 只测前者会把
 * 「恒出题」读成通过。证伪方式逐条写在 test 注释里。
 */

// ── 冻结接口 (契约 §冻结接口; CLI 侧 re-export, 那边是契约点名的公开面) ────────

/** 矿源词表。加一类要同时加一个 miner —— 词表与实现同生同灭, 不留占位。 */
export type CandidateSource =
  | 'failed-runs'
  | 'sessions'
  | 'readout'
  | 'tickets'
  | 'test-health';

/** 一条待挖的题。`id` = `<source>:<stable-key>` —— 卡的 evidenceRefs 逐字引用它。 */
export interface CandidateItem {
  id: string;
  source: CandidateSource;
  summary: string;
  /** 人能顺着去看的原文/坐标 (≤3 条, 不堆全量)。 */
  evidence: string[];
  /** 机械读数。值可为 null —— 「量了是 null」与「没有这一维」由键的有无区分。 */
  metrics?: Record<string, number | null>;
}

/** `candidates.json` 整档。 */
export interface Candidates {
  version: 1;
  generatedAt: string;
  sinceIso: string;
  items: CandidateItem[];
  errors: { source: string; error: string }[];
}

export const CANDIDATES_VERSION = 1;

/** 每簇最多带几个样本坐标 (契约 GWT-3: evidence 各 ≤ 3)。 */
const MAX_SAMPLES = 3;

/** 取前 N 条, 保序。 */
function sample<T>(xs: readonly T[]): T[] {
  return xs.slice(0, MAX_SAMPLES);
}

// ── ① 失败 run 台账 ────────────────────────────────────────────────────────

/** `.omd/runs.db` 的 `omd_runs` 行 (只取判题要用的四列)。 */
export interface FailedRunRow {
  runId: string;
  status: string;
  error: string | null;
  updatedAt: string;
}

/** 判词首行的「终止原因: X」—— 引擎的机械分类。取到 `(STALLED)` 之前那个词。 */
const REASON_RE = /终止原因:\s*([^\s(·]+)/;

/**
 * 簇名。有「终止原因」取它; 没有的那些**单列一簇**而不是塞进某个既有簇 ——
 * 「这跑以 X 结束」与「这跑的判词不是引擎写的」是两件事, 抹平了事后分不开 (§静默坑 1)。
 */
const CLUSTER_UNRECORDED = '未记终止原因';

function clusterKeyOf(error: string | null): string {
  if (!error) return CLUSTER_UNRECORDED;
  const m = REASON_RE.exec(error.split('\n')[0] ?? '');
  return m ? m[1]! : CLUSTER_UNRECORDED;
}

/**
 * 失败 run 按终止原因聚类, 每簇一条题。按簇大小降序 (同大小按簇名字典序, 输出可重放)。
 *
 * 过滤: `updatedAt >= sinceIso` ∧ 有判词 ∧ 状态不是 completed。
 * 「状态不是 completed」这一条挡的是「跑成了但历史 error 列没清」的行 —— 那不是今天的失败。
 */
export function mineFailedRuns(
  rows: readonly FailedRunRow[],
  sinceIso: string,
): CandidateItem[] {
  const inWindow = rows.filter(
    (r) => r.updatedAt >= sinceIso && (r.error ?? '').trim() !== '' && r.status !== 'completed',
  );
  const byCluster = new Map<string, FailedRunRow[]>();
  for (const r of inWindow) {
    const k = clusterKeyOf(r.error);
    const arr = byCluster.get(k) ?? [];
    arr.push(r);
    byCluster.set(k, arr);
  }
  return [...byCluster.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([key, group]) => ({
      id: `failed-runs:${key}`,
      source: 'failed-runs' as const,
      summary: `${sinceIso} 以来 ${group.length} 条 run 以「${key}」终止`,
      evidence: sample(group.map((g) => g.runId)),
      metrics: { count: group.length },
    }));
}

// ── ② 进化 session 台账 ────────────────────────────────────────────────────



// ── ③ 引擎读数 ────────────────────────────────────────────────────────────

/** 读数摘要 (由 CLI 从 readout 产物读来; 读不到 → null, 不编)。 */
export interface ReadoutSummary {
  /** 理论加速比中位; null = 主尺缺席 (**不是** 0)。 */
  speedupMedian: number | null;
  /** 可量样本数。 */
  measurable: number;
  /** 因缺 duration 被剔掉的样本数。 */
  excludedMissing: number;
  /** shape_id 声明率 (0..1)。 */
  shapeDeclRate: number;
  /** O3a run 桶可量行数 (objective.md 2026-09-04 修订)。 */
  runMeasurable: number;
  /** O3a 主统计量: run 桶 speedup>1 占比; 桶空 → null (NULL ≠ 0)。 */
  runShareGt1: number | null;
  /** O3a 副统计量: run 桶 speedup 中位; 桶空 → null。 */
  runMedian: number | null;
}

/** 剔除率超这个比例就算尺子有毛病 (objective O3a 的坏尺形态: 133/133 全剔)。 */
export const EXCLUDED_RATIO_THRESHOLD = 0.5;
/** shape 声明率低于这个值出题 (objective O3b 基线 0.0%)。 */
export const SHAPE_DECL_THRESHOLD = 0.1;

export function mineReadout(readout: ReadoutSummary | null): CandidateItem[] {
  if (readout === null) return [];
  const items: CandidateItem[] = [];
  const seen = readout.measurable + readout.excludedMissing;

  if (readout.speedupMedian === null) {
    items.push({
      id: 'readout:speedup-null',
      source: 'readout',
      summary: '主目标维 speedupTheoreticalMedian 读作 null —— 选择在主尺缺席下运行',
      evidence: [`measurable=${readout.measurable} · excludedMissing=${readout.excludedMissing}`],
      metrics: { speedupMedian: null, measurable: readout.measurable },
    });
  }
  if (seen > 0 && readout.excludedMissing / seen > EXCLUDED_RATIO_THRESHOLD) {
    items.push({
      id: 'readout:duration-excluded',
      source: 'readout',
      summary: `${readout.excludedMissing}/${seen} 个样本因缺 duration 被剔 —— 剔除规则在吃掉自己的分母`,
      evidence: [`excludedMissing/${seen} = ${(readout.excludedMissing / seen).toFixed(3)}`],
      metrics: { excludedMissing: readout.excludedMissing, seen },
    });
  }
  if (readout.shapeDeclRate < SHAPE_DECL_THRESHOLD) {
    items.push({
      id: 'readout:shape-decl-low',
      source: 'readout',
      summary: `shape_id 声明率 ${(readout.shapeDeclRate * 100).toFixed(1)}% —— 图式这一维近乎无信号 (objective O3b)`,
      evidence: [`shapeDeclRate=${readout.shapeDeclRate}`],
      metrics: { shapeDeclRate: readout.shapeDeclRate },
    });
  }
  return items;
}

// ── ④ pathfinder 前沿票 ────────────────────────────────────────────────────

/**
 * 判题要用的地图最小面 (`src/harness/pathfinder/types.ts` 的 `PathMap` 天然可赋)。
 *
 * ✎ 契约把参数名写作 `PathfinderMap`; 仓里的真名是 `PathMap`。这里用结构最小面而不是
 * 直接收 `PathMap`, 理由同 (2026-09-04 前的 `SessionRecord` 也这样) —— 判题只用三列, 收全量会把票 schema 的
 * 每次演进都变成本文件的编译错。
 */
export interface TicketMapLike {
  slug: string;
  tickets: readonly { id: string; title: string; status: string; executorKind?: string }[];
}

/**
 * open ∧ executorKind='goal' ∧ 无在途 dispatch 的票 → 每票一条题。
 *
 * ✎ 契约签名只有 `maps` 一个参数。「无 in-flight dispatch」这一条要读磁盘标记
 * (`.omd/pathfinder/results/<slug>/<id>.goal-dispatched`), 读盘不能进纯函数 —— 于是在途集合
 * 由 CLI 探好后传进来。第二参可省, 单参调用与契约逐字一致。
 */
export function mineTickets(
  maps: readonly TicketMapLike[],
  inFlight: ReadonlySet<string> = new Set(),
): CandidateItem[] {
  const items: CandidateItem[] = [];
  for (const map of maps) {
    for (const t of map.tickets) {
      if (t.status !== 'open') continue;
      if (t.executorKind !== 'goal') continue;
      const key = `${map.slug}:${t.id}`;
      if (inFlight.has(key)) continue;
      items.push({
        id: `tickets:${key}`,
        source: 'tickets',
        summary: `前沿 goal 票待收敛: ${t.title}`,
        evidence: [`docs/plan/pathfinder/${map.slug}.md · 票 ${t.id}`],
      });
    }
  }
  return items;
}

// ── ⑤ 测试健康度 ──────────────────────────────────────────────────────────

/**
 * `scripts/test-run-triage.ts` 的 `Triage` 最小面。
 *
 * ✎ 契约写的类型名是 `TriageSummary`; 仓里的真名是 `Triage` (test-run-triage.ts:51)。
 * 收结构最小面, `Triage` 天然可赋。
 */
export interface TriageSummary {
  failures: readonly { kind: string; test: string; evidence: string }[];
  totals: { pass: number | null; fail: number | null; skip: number | null };
}

/** 每一类失败一条题 (三类判词不合并 —— 超时/记账/断言的下一步完全不同)。 */
export function mineTestHealth(triage: TriageSummary | null): CandidateItem[] {
  if (triage === null) return [];
  const byKind = new Map<string, { test: string; evidence: string }[]>();
  for (const f of triage.failures) {
    const arr = byKind.get(f.kind) ?? [];
    arr.push({ test: f.test, evidence: f.evidence });
    byKind.set(f.kind, arr);
  }
  return [...byKind.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([kind, group]) => ({
      id: `test-health:${kind}`,
      source: 'test-health' as const,
      summary: `全量测试有 ${group.length} 条「${kind}」失败 (总计 ${triage.totals.fail ?? '读不到'} fail)`,
      evidence: sample(group.map((g) => `${g.test} —— ${g.evidence}`)),
      metrics: { count: group.length, totalFail: triage.totals.fail },
    }));
}
