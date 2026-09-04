#!/usr/bin/env bun
/**
 * scripts/autoresearch-mine —— 夜链「挖题」的**薄 CLI** (契约切片 2, D-2)。
 *
 *   bun scripts/autoresearch-mine.ts --out runs/autoresearch/night-2026-09-02/candidates.json --since 7d
 *
 * ## 薄在哪
 *
 * 全部判断力在 `src/eval/replay/miners.ts` 的五个纯函数里。本文件只做三件事:
 * 取原料 (sqlite / fs) → 喂纯函数 → 拼 `candidates.json`。取原料那五件全部走 `MineIO` 注入,
 * 于是测试能在**零外部依赖**下跑完整条挖题。
 *
 * ## fail-open 留证据 (仓规 §静默坑 2 · 契约 D-2)
 *
 * 任一矿源读不到 → 进 `errors[]` 并带错误原文, 该类 items 停在空, 挖题**照常退出 0**。
 * 「这一类今天真是零题」与「这一类没读到」靠 `errors[]` 分辨, 不靠 items 长度猜。
 * 五个矿源全塌也退 0 —— 夜链的下一段 (提案) 会看见一个空 candidates 并据此写零卡,
 * 而零卡不是失败 (D-3)。
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CANDIDATES_VERSION,
  mineFailedRuns,
  mineReadout,
  mineTestHealth,
  mineTickets,
  type CandidateItem,
  type Candidates,
  type FailedRunRow,
  type ReadoutSummary,
  type TicketMapLike,
} from '../src/eval/replay/miners';
import { goalDispatchedPath } from '../src/harness/pathfinder/dispatch';
import { summarizeReadout, type ReadoutRow } from './speedup-readout';
import { loadMap } from '../src/harness/pathfinder/map-store';
import { summarizeOpenMaps } from '../src/harness/pathfinder/maps';
import { triageTestLog } from './test-run-triage';

// 契约把 Candidates / CandidateItem 的公开面记在本文件名下; 真身在 miners.ts (依赖方向:
// src/ 不许反向依赖 scripts/)。这里 re-export 让契约点名的进口生效。
export type { CandidateItem, Candidates } from '../src/eval/replay/miners';

/** 五个矿源的取料口 —— 测试注入替身, 零进程零磁盘。 */
export interface MineIO {
  failedRuns(): { ok: true; rows: FailedRunRow[] } | { ok: false; error: string };
  readout(): { ok: true; summary: ReadoutSummary } | { ok: false; error: string };
  tickets():
    | { ok: true; maps: TicketMapLike[]; inFlight: Set<string> }
    | { ok: false; error: string };
  testLog(): { ok: true; log: string } | { ok: false; error: string };
}

/**
 * 加速比读数的真源 —— DAG run 账本本身 (与 `scripts/speedup-readout.ts` CLI 同一个库同一张表)。
 *
 * ✎ 原先这一源期待一份 `runs/autoresearch/readout.json`, 而全仓没有任何东西产它: 于是这一格
 * **恒进 errors[]**, 主目标那条 O3a 的题一条都挖不出来 —— fail-open 保住了退出码, 却让整类
 * 题静默消失。改成进程内直接从账本算摘要, 摘要的定义仍在 speedup-readout.ts 那一把尺子上,
 * 不在这里另抄一份。
 */
export const READOUT_DB_PATH = '.omd/dag-runs.db';
/** 进化 session 根目录 (与 autoresearch-session.ts 的默认值同)。 */

/** `--since` 支持 `<N>d` 相对写法与 ISO 绝对写法。返回 ISO 串 (与 omd_runs.updated_at 同域)。 */
export function parseSince(spec: string, now: Date): string {
  const rel = /^(\d+)d$/.exec(spec.trim());
  if (rel) return new Date(now.getTime() - Number(rel[1]) * 86_400_000).toISOString();
  const t = Date.parse(spec);
  if (Number.isNaN(t)) throw new Error(`--since 认不出: "${spec}" (要 <N>d 或 ISO 时刻)`);
  return new Date(t).toISOString();
}

/** 真机取料。每一件自己 try/catch —— 一个矿源塌不许带走另外四个。 */
export function defaultMineIO(cwd: string): MineIO {
  return {
    failedRuns: () => {
      const p = join(cwd, '.omd', 'runs.db');
      if (!existsSync(p)) return { ok: false, error: `runs.db 不在: ${p}` };
      try {
        const db = new Database(p, { readonly: true });
        const rows = db
          .query(
            "select run_id, status, error, updated_at from omd_runs where status != 'completed'",
          )
          .all() as { run_id: string; status: string; error: string | null; updated_at: string }[];
        db.close();
        return {
          ok: true,
          rows: rows.map((r) => ({
            runId: r.run_id,
            status: r.status,
            error: r.error,
            updatedAt: r.updated_at,
          })),
        };
      } catch (e) {
        return { ok: false, error: `runs.db 读取失败: ${(e as Error).message}` };
      }
    },


    readout: () => {
      const p = join(cwd, READOUT_DB_PATH);
      if (!existsSync(p)) return { ok: false, error: `dag-runs.db 不在: ${p}` };
      try {
        const db = new Database(p, { readonly: true });
        const rows = db
          .query('select nodes, shape_id, created_at, entry from omd_dag_runs')
          .all() as ReadoutRow[];
        db.close();
        const summary = summarizeReadout(rows);
        // 一行都没有 → 摘要读作 null。「账本是空的」不是「加速比是 0」(仓规 §静默坑 1)。
        if (summary === null) return { ok: false, error: `omd_dag_runs 无记录: ${p}` };
        return { ok: true, summary };
      } catch (e) {
        return { ok: false, error: `dag-runs.db 读取失败: ${(e as Error).message}` };
      }
    },

    tickets: () => {
      try {
        const maps: TicketMapLike[] = [];
        const inFlight = new Set<string>();
        for (const s of summarizeOpenMaps(cwd)) {
          const map = loadMap(cwd, s.slug);
          if (!map) continue;
          maps.push(map);
          for (const t of map.tickets) {
            if (existsSync(goalDispatchedPath(cwd, map.slug, t.id))) {
              inFlight.add(`${map.slug}:${t.id}`);
            }
          }
        }
        return { ok: true, maps, inFlight };
      } catch (e) {
        return { ok: false, error: `pathfinder 地图读取失败: ${(e as Error).message}` };
      }
    },

    testLog: () => {
      // 与 hygiene-scan 同一约定: `test-run-triage --run` 把全文写在 /tmp/omd-test-run-<ts>.txt。
      try {
        const files = readdirSync('/tmp')
          .filter((f) => f.startsWith('omd-test-run-') && f.endsWith('.txt'))
          .map((f) => ({ f, m: statSync(join('/tmp', f)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        if (files.length === 0) {
          return { ok: false, error: '没有 /tmp/omd-test-run-*.txt —— 先跑一次全量测试' };
        }
        return { ok: true, log: readFileSync(join('/tmp', files[0]!.f), 'utf8') };
      } catch (e) {
        return { ok: false, error: `测试日志读取失败: ${(e as Error).message}` };
      }
    },
  };
}

/** 拼 `candidates.json`。五段各自判 ok, 塌的进 errors —— **永不抛**。 */
export function collectCandidates(io: MineIO, sinceIso: string, generatedAt: string): Candidates {
  const items: CandidateItem[] = [];
  const errors: { source: string; error: string }[] = [];

  const runs = io.failedRuns();
  if (runs.ok) items.push(...mineFailedRuns(runs.rows, sinceIso));
  else errors.push({ source: 'failed-runs', error: runs.error });


  const ro = io.readout();
  if (ro.ok) items.push(...mineReadout(ro.summary));
  else errors.push({ source: 'readout', error: ro.error });

  const tk = io.tickets();
  if (tk.ok) items.push(...mineTickets(tk.maps, tk.inFlight));
  else errors.push({ source: 'tickets', error: tk.error });

  const log = io.testLog();
  if (log.ok) items.push(...mineTestHealth(triageTestLog(log.log)));
  else errors.push({ source: 'test-health', error: log.error });

  return { version: CANDIDATES_VERSION, generatedAt, sinceIso, items, errors };
}

// ── CLI ───────────────────────────────────────────────────────────────────

export interface MineArgs {
  out: string;
  since: string;
  cwd: string;
}

const USAGE =
  'usage: bun scripts/autoresearch-mine.ts --out <candidates.json> [--since 7d|<ISO>] [--cwd <dir>]';

export function parseMineArgs(argv: readonly string[]): MineArgs {
  let out = '';
  let since = '7d';
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺值`);
      return v;
    };
    if (a === '--out') out = next();
    else if (a === '--since') since = next();
    else if (a === '--cwd') cwd = next();
    else throw new Error(`认不出的参数: ${a}`);
  }
  if (out === '') throw new Error('--out 必填');
  return { out, since, cwd };
}

if (import.meta.main) {
  let args: MineArgs;
  try {
    args = parseMineArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
    process.exit(2);
  }
  const now = new Date();
  const candidates = collectCandidates(
    defaultMineIO(args.cwd),
    parseSince(args.since, now),
    now.toISOString(),
  );
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(candidates, null, 2)}\n`);
  process.stdout.write(
    `[autoresearch-mine] ${candidates.items.length} 题 · ${candidates.errors.length} 个矿源没读到 → ${args.out}\n`,
  );
  for (const e of candidates.errors) process.stdout.write(`  ⚠ ${e.source}: ${e.error}\n`);
  process.exit(0);
}
