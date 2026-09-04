#!/usr/bin/env bun
/**
 * scripts/plan-doc-check —— 计划文档 (SDD) 的质量闸。**零 LLM, 零成本, 确定性**。
 *
 *   bun run plan-doc-check docs/plan/2026-07-28-omd-goal-engine.md
 *   bun run plan-doc-check docs/plan/*.md
 *   bun run plan-doc-check --strict docs/plan/x.md      # major 也算不过
 *   bun run plan-doc-check --json docs/plan/x.md        # 机器读
 *   bun run plan-doc-check --ignite docs/plan/x.md      # 加跑点火预演 (实跑 verify, 慢)
 *
 * ## 点火预演 (2026-09-04)
 *
 * 有分解段的 SDD 会走 `solve + sddPath` 直通, 那条路上有六道 fail-closed 闸, 而它们
 * **只在点火那一刻才响** —— 夜批撞上去就是一次空跑。本脚本把其中三道能提前跑的搬到结晶期:
 *   · D3 干跑 (`dryRunSddIgnition`)      —— 零 IO 纯函数, 恒跑
 *   · 坐标校验 (`checkCoords`)           —— 读盘, 恒跑
 *   · #251 判据自证 (`checkIgnitionCriteria`) —— **实跑 verify 命令**, 只在 `--ignite` 下跑
 *
 * 判定全部复用点火期那几个函数的**同一份实现** —— 抄一份必漂, 而漂的后果正是本段要消灭的病
 * 「结晶期说过了, 点火期照样拒」。没有分解段的文档整段跳过 (不适用 ≠ 通过 ≠ 失败)。
 *
 * ## 为什么默认关 (读数, 2026-09-04 实测)
 *
 * 仓里 293 份计划文档、149 份有分解段, 打开点火预演后 **116/149 判红**。这些绝大多数是
 * **历史文档** —— 写在这些闸建立之前, 活早干完了, 永远不会再点火。默认开 = 把这条本来
 * 干净的闸变成噪声, 而假 blocker 的代价是有人把整条闸关掉 (S-45 买过一次的教训)。
 *
 * 所以整段挂在 `--ignite` 后面: **不带开关时本脚本的行为与改前逐字相同**。
 * 该带开关的场合只有一个 —— 刚结晶完、马上要点火的那份 SDD (`/omd-contract` 的收尾步)。
 *
 * 打分表 + 缺口表; **不过则 exit 1** —— 于是它能直接当 DAG `executor:'command'` 节点的 oracle
 * (承本仓那条纪律: 判据要"真的会跑", 不是写在 prompt 里请模型自己判)。
 *
 * 判据与阈值的真理源在 `src/harness/plan/plan-doc-score.ts` (纯函数, 有测试),
 * 缺口规则在 `src/harness/plan/plan-doc-gaps.ts`。本脚本只负责读盘 + 排版 + 定退出码。
 *
 * 退出码: 0 = 全过 · 1 = 有文档不过 · 2 = 用法错 / 文件读不到。
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  DEFAULT_PLAN_DOC_THRESHOLDS,
  MIN_SAMPLE,
  scorePlanDoc,
  type MetricKey,
  type PlanDocScore,
} from '../src/harness/plan/plan-doc-score';
import { countGaps, findPlanDocGaps, type PlanDocGap } from '../src/harness/plan/plan-doc-gaps';
import { hasBreakdownSection, parseBreakdown } from '../src/harness/goal/sdd-direct';
import { dryRunSddIgnition } from '../src/harness/goal/sdd-ignition-check';
import { checkCoords } from '../src/harness/goal/coord-check';
import { checkIgnitionCriteria } from '../src/harness/goal/ignition-criteria-check';
import { sddFallbackRouteHint } from '../src/mcp/tools/goal';
import { allowlistForRoot, createCommandLeafRunner } from '../src/harness/command-leaf';

const USAGE = [
  'usage: bun run scripts/plan-doc-check.ts [--strict] [--json] <md 路径…>',
  '  计划文档 (SDD) 质量闸: 打分 + 找缺口, 纯静态解析零 LLM。',
  '  --strict  major 缺口也算不过 (默认只有 blocker 与分数不达标才拦)',
  '  --json    输出机器可读 JSON, 不排版',
  '  --ignite  加跑点火预演 (D3 干跑 + 坐标校验 + #251 判据自证, 末项实跑 verify 命令)',
  '            默认关: 存量历史 SDD 116/149 会红, 开着会把这条闸变成噪声。刚结晶的那份才带。',
  `  阈值默认: ${JSON.stringify(DEFAULT_PLAN_DOC_THRESHOLDS)}`,
  '  exit 0 = 全过 · 1 = 有文档不过 · 2 = 用法错/读不到文件',
].join('\n');

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(argv.length === 0 ? 2 : 0);
}
const strict = argv.includes('--strict');
const asJson = argv.includes('--json');
const ignite = argv.includes('--ignite');
const files = argv.filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

const repoRoot = resolve(import.meta.dir, '..');
/** 注入给 `findPlanDocGaps` 的存在性判定 —— 读盘的权力留在脚本, 库保持纯函数。 */
const fileExists = (p: string) => existsSync(resolve(repoRoot, p));

const SEV_MARK: Record<PlanDocGap['severity'], string> = {
  blocker: '⛔ blocker',
  major: '▲ major ',
  minor: '· minor  ',
};

function pct(v: number | null): string {
  return v === null ? '  n/a' : `${(v * 100).toFixed(0).padStart(4)}%`;
}

function renderScore(s: PlanDocScore): string[] {
  const out: string[] = ['  判据                当前      样本    阈值   判定'];
  for (const key of Object.keys(s.metrics) as MetricKey[]) {
    const r = s.metrics[key];
    const verdict =
      r.value === null
        ? '不适用'
        : !r.gated
          ? `样本 <${MIN_SAMPLE}, 只展示不判`
          : r.value + 1e-9 < s.thresholds[key]
            ? '✗ 未达标'
            : '✓';
    out.push(
      `  ${s.labels[key].padEnd(16)} ${pct(r.value)}   ${`${r.hit}/${r.total}`.padEnd(7)} ${pct(s.thresholds[key])}   ${verdict}`,
    );
  }
  for (const f of s.failures) {
    out.push(
      `    ✗ ${f.label}: ${(f.value * 100).toFixed(0)}% < ${(f.threshold * 100).toFixed(0)}%` +
        (f.offenders.length > 0 ? ` —— 拖后腿的: ${f.offenders.join('、')}` : ''),
    );
  }
  for (const flag of s.softFlags) out.push(`    ⚑ ${flag.message}`);
  return out;
}

function renderGaps(gaps: PlanDocGap[]): string[] {
  if (gaps.length === 0) return ['  缺口: 无'];
  const out: string[] = ['  缺口:'];
  for (const g of gaps) {
    out.push(`  ${SEV_MARK[g.severity]}  ${g.title}`);
    out.push(`             影响面: ${g.impact}`);
    out.push(`             修法:   ${g.fix}`);
    if (g.evidence.length > 0) out.push(`             点名:   ${g.evidence.join('、')}`);
  }
  return out;
}

// ── 点火预演: 把 solve+sddPath 点火期的闸提前跑 (详见文件头) ──────────────────

/**
 * 三道闸的结晶期形态。全部 `blocker` —— 判据是**点火时会不会被同一道闸拒**, 而这三道都会,
 * 所以在这里降级成 major 等于说谎 (它拦不住夜批空跑)。
 *
 * 没有分解段 → 返空数组: 这份文档不走直通, 三道闸对它**不适用**。
 * 抹平成 fatal 会把仓里绝大多数计划文档判红 (skill 记的读数: 149 份里只有 52 份有分解段)。
 */
async function ignitionPreview(md: string, docPath: string): Promise<PlanDocGap[]> {
  if (!ignite || !hasBreakdownSection(md)) return [];
  const gaps: PlanDocGap[] = [];

  // ① D3 干跑 —— 平铺图编译得出来吗。fatal 不可 force, fallback 可 force, 都会拦点火。
  const dry = dryRunSddIgnition(md);
  if (dry.kind === 'fatal') {
    gaps.push({
      id: 'ignition-d3-fatal',
      severity: 'blocker',
      title: `点火预演 · D3 fatal: 分解表解析不了 —— ${dry.err}`,
      impact: '`solve --sddPath` 点火当场同步拒, 且**不可 force 越闸** (整份契约缺段或表坏)。',
      fix: '照拒因原文改分解表 (拒因就是 parseBreakdown 的原 message, 直接可操作)。',
      evidence: [docPath],
    });
  } else if (dry.kind === 'fallback') {
    const hint = sddFallbackRouteHint(dry.reason);
    gaps.push({
      id: 'ignition-d3-fallback',
      severity: 'blocker',
      title: `点火预演 · D3 fallback: 编译不出平铺图 —— ${dry.reason}`,
      impact: '`solve --sddPath` 点火同步拒 (可 force 越闸, 但越了就是让 worker 带着已知缺陷跑)。',
      fix: `照拒因原文改 SDD (拆开相交写集 / 补 verify 列 / 修依赖)。${hint ? ` ${hint}` : ''}`,
      evidence: [docPath],
    });
  }

  // ② 坐标校验 —— 编造的路径/行号/符号会被执行体照抄进命令 (实账 0f67293b 烧掉整跑)。
  //    校验对象是 SDD 全文, 与点火期 `coordIgnitionGate` 传的第二份文本同一份。
  const coord = checkCoords(md, { root: repoRoot });
  if (coord.length > 0) {
    gaps.push({
      id: 'ignition-coord',
      severity: 'blocker',
      title: `点火预演 · #241 坐标机械校验: ${coord.length} 处坐标与仓不符`,
      impact: '点火同步拒; 越闸放行则执行体照抄编造的符号/路径进命令, 首败带塌下游整条链。',
      fix: '改正坐标; 确属新建物时在同句写明「新建」; 闸看错了就在同行写 `gate-allow(coord-check): <理由>`。',
      evidence: coord.slice(0, 8).map((f) => f.message),
    });
  }

  // ③ #251 判据自证 —— **唯一没有 force 出口的一道**, 所以最值得提前跑。
  //    它真跑每片的 verify (整段最慢的一步); 跑手用生产同款白名单跑手, 读数才可比。
  //    D3 没过时不跑: 表都编译不出来, parseBreakdown 的 slices 不可信 (且 D3 那条已经是 blocker)。
  if (dry.kind === 'ok') {
    const runner = createCommandLeafRunner({ allowlist: allowlistForRoot(repoRoot), cwd: repoRoot, timeoutMs: 180_000 });
    const report = await checkIgnitionCriteria(repoRoot, parseBreakdown(md).slices, async ({ command }) => ({
      exitCode: (await runner({ command })).exitCode,
    }));
    if (report.verdict === 'rejected') {
      gaps.push({
        id: 'ignition-criteria-251',
        severity: 'blocker',
        title: `点火预演 · #251 判据自证: ${report.findings.length} 条 verify 列虚或预绿`,
        impact:
          '点火同步拒, 而这道闸**没有 force 出口** —— 给了出口就等于放虚判据进图, 整跑判不出真假 ' +
          '(实账 run 85a18995 零改动 4 分钟假 done)。',
        fix:
          'missing-path: verify 引用的路径要么盘上有, 要么写进本片写集。 ' +
          'mixed-first-segment: 本片有新建文件时, verify 首段 (第一个 `&&` 之前) 只许引用本片写集内的 token。 ' +
          'pre-green: 本片有新建文件时, verify 在实装前必须是红的 —— 拿既有绿测试当 verify 必被拒。',
        evidence: report.findings.slice(0, 8).map((f) => `slice ${f.sliceId} [${f.kind}]: ${f.detail}`),
      });
    }
  }
  return gaps;
}

interface Row {
  file: string;
  score: PlanDocScore;
  gaps: PlanDocGap[];
  ok: boolean;
}

const rows: Row[] = [];
for (const f of files) {
  let md: string;
  try {
    md = readFileSync(f, 'utf8');
  } catch (e) {
    console.error(`[plan-doc-check] 读不到 ${f}: ${(e as Error).message}`);
    process.exit(2);
  }
  const score = scorePlanDoc(md);
  const rel = relative(repoRoot, resolve(f)) || f;
  const gaps = [...findPlanDocGaps(md, { fileExists }), ...(await ignitionPreview(md, rel))];
  const n = countGaps(gaps);
  const ok = score.pass && n.blocker === 0 && (!strict || n.major === 0);
  rows.push({ file: rel, score, gaps, ok });
}

if (asJson) {
  console.log(
    JSON.stringify(
      rows.map((r) => ({
        file: r.file,
        ok: r.ok,
        pass: r.score.pass,
        metrics: r.score.metrics,
        thresholds: r.score.thresholds,
        failures: r.score.failures,
        softFlags: r.score.softFlags,
        gaps: r.gaps,
      })),
      null,
      2,
    ),
  );
} else {
  for (const r of rows) {
    console.log(`\n${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.file}`);
    console.log(renderScore(r.score).join('\n'));
    console.log(renderGaps(r.gaps).join('\n'));
  }
  const bad = rows.filter((r) => !r.ok).length;
  console.log(
    `\n—— ${rows.length} 份文档: ${rows.length - bad} 过 / ${bad} 不过` +
      (strict ? ' (--strict: major 也拦)' : ' (只有 blocker 与分数不达标会拦, major 用 --strict 拦)'),
  );
}

process.exit(rows.some((r) => !r.ok) ? 1 : 0);
