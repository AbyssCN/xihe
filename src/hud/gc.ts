/**
 * src/hud/gc —— HUD 分片归档 (2026-09-02)。
 *
 * ## 为什么要有它
 *
 * `readDagShards` 把 `running/pending` 且超 30s 没更新的分片判成 `stalled` (屏上的「waiting」),
 * 而这个档**永不过期**: 写侧一旦没写终态, 那份分片就在 run 列表里挂一辈子。实测 2026-09-02:
 * `.omd/hud/` 2044 份分片, 96 份 `running`, 而 runs.db 里这 96 个 run **全部已终态**
 * (failed 55 / done 40 / cancelled 1) —— 都是 solve 路径漏写终态 (goal.ts 只在节点事件时写分片)。
 * 写侧已补, 但盘上的存量以及未来任何一次进程被杀都还会留下同款残影, 所以读侧要有归档。
 *
 * ## 判据 (三条, 各自独立, 命中任一即归档)
 *
 *   1. 终态分片 (done/failed/cancelled) 且 age > DONE_GRACE_MS —— 与 `gradeSnapshot` 的收起窗同一个数,
 *      屏上早已不画它, 文件只是没挪。
 *   2. `running/pending` 分片, 但 runs.db 说这个 run 已终态 —— 写侧漏写终态的残影 (上面那 96 份)。
 *   3. `running/pending` 分片, 不在 runs.db 终态表里, 但 age > staleRunningMs (默认 24h) ——
 *      进程被杀 / 没进 runs.db 的探针 run。24h 是「一个 run 静默一整天还在跑」在本仓不存在为据。
 *
 * 归档 = **移动**到 `<hud>/archive/`, 不删 (可逆; `omd runs gc` 那边的纪律同款: 永不静默删)。
 * `readDagShards` 只扫 hud 顶层, archive/ 里的自动落选。
 *
 * ## 不做什么
 *
 *   - 不读 runs.db 自己 —— 终态 run 集合由调用方给 (`readTerminalRunIds`), 让本函数对存储零依赖,
 *     单测用一个 Set 就能证伪三条判据。
 *   - 不判 `dag.json` (statusline 数据源, INV-HUD-1) 与 `fog.json`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { DONE_GRACE_MS, candidateHudDirs } from './load';
import { HUD_SCHEMA, type HudDagSnapshot } from './types';
import { logger } from '../harness/logger';

export const STALE_RUNNING_ARCHIVE_MS = 24 * 3600_000;
export const HUD_ARCHIVE_DIR = 'archive';

export type HudGcReason = 'finished-expired' | 'running-but-run-terminal' | 'running-stale';

export interface HudGcItem {
  file: string;
  runId: string;
  status: string;
  reason: HudGcReason;
}

export interface HudGcResult {
  scanned: number;
  archived: HudGcItem[];
  /** 判了要归档但 rename 失败的 (fail-open, 证据在 note)。 */
  failed: Array<HudGcItem & { note: string }>;
}

export interface HudGcOpts {
  /** runs.db 里已终态 (done/failed/cancelled) 的 runId 全集。 */
  terminalRunIds: ReadonlySet<string>;
  /** 判据 3 的阈值; 默认 24h。 */
  staleRunningMs?: number;
  /** 只判不挪 (dry-run)。 */
  dryRun?: boolean;
}

/** 单份分片的判据 —— 纯函数, 三条各自独立; 不命中 → null。 */
export function decideHudArchive(
  snap: Pick<HudDagSnapshot, 'runId' | 'status' | 'updatedAt'>,
  nowMs: number,
  opts: HudGcOpts,
): HudGcReason | null {
  const parsed = Date.parse(snap.updatedAt);
  const ageMs = Number.isFinite(parsed) ? nowMs - parsed : Infinity; // 坏时戳 → 当极旧 (与 gradeSnapshot 同)
  if (snap.status === 'running' || snap.status === 'pending') {
    if (opts.terminalRunIds.has(snap.runId)) return 'running-but-run-terminal';
    if (ageMs > (opts.staleRunningMs ?? STALE_RUNNING_ARCHIVE_MS)) return 'running-stale';
    return null;
  }
  return ageMs > DONE_GRACE_MS ? 'finished-expired' : null;
}

/** 扫两处候选 home 的顶层 `dag-*.json`, 按判据挪进 `archive/`。读侧永不崩: 坏 JSON / 未知 schema 跳过。 */
export function sweepHudSnapshots(cwd: string, nowMs: number, opts: HudGcOpts): HudGcResult {
  const out: HudGcResult = { scanned: 0, archived: [], failed: [] };
  for (const dir of candidateHudDirs(cwd)) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch (err) {
      // fail-open 吞异常不吞证据 (仓规静默坑 2): 候选目录不存在是常态, 但读不动要留原文。
      logger.debug({ dir, err: err instanceof Error ? err.message : String(err) }, '[hud/gc] 候选目录读不动 → 跳过');
      continue;
    }
    for (const file of files) {
      if (!/^dag-.+\.json$/.test(file)) continue;
      const full = join(dir, file);
      let snap: Partial<HudDagSnapshot>;
      try {
        snap = JSON.parse(readFileSync(full, 'utf-8')) as Partial<HudDagSnapshot>;
      } catch (err) {
        logger.debug({ file: full, err: err instanceof Error ? err.message : String(err) }, '[hud/gc] 快照坏 JSON → 跳过');
        continue;
      }
      if (!snap || snap.schema !== HUD_SCHEMA || typeof snap.runId !== 'string' || typeof snap.updatedAt !== 'string') continue;
      out.scanned += 1;
      const reason = decideHudArchive(snap as HudDagSnapshot, nowMs, opts);
      if (!reason) continue;
      const item: HudGcItem = { file: full, runId: snap.runId, status: String(snap.status), reason };
      if (opts.dryRun) {
        out.archived.push(item);
        continue;
      }
      try {
        const archiveDir = join(dir, HUD_ARCHIVE_DIR);
        if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
        renameSync(full, join(archiveDir, file));
        out.archived.push(item);
      } catch (err) {
        out.failed.push({ ...item, note: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
}

/** runs.db 里已终态的 runId 全集。库缺席 / 表缺席 → 空集 (那时只有判据 1 与 3 生效, 不猜)。 */
export function readTerminalRunIds(cwd: string): Set<string> {
  const path = join(cwd, '.omd', 'runs.db');
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const rows = db.query(`SELECT run_id FROM omd_runs WHERE status IN ('done', 'failed', 'cancelled')`).all() as Array<{ run_id: string }>;
    for (const r of rows) out.add(r.run_id);
  } catch {
    /* 表还没建 / 库被锁 → 空集; 调用方按「没有终态信息」处理, 不是「没有终态 run」 */
  } finally {
    db?.close();
  }
  return out;
}
