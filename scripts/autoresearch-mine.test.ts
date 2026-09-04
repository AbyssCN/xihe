/**
 * autoresearch-mine.test —— 挖题 CLI 的拼装与 fail-open (契约 INV-3 / GWT-3b)。
 *
 * 这里**不**重测五个 miner 的判别力 (那在 src/eval/replay/miners.test.ts), 只测两件本文件独有的:
 *  ① 五段拼装: 哪一段塌了只带走自己, 另外四段照出题;
 *  ② fail-open 留证据: 塌了的进 errors[] 带原文, 退出码仍是 0, candidates.json 仍写出。
 *
 * 反向自检 —— **真跑读数** (改一处, 跑本文件 + miners.test.ts 共 29 条):
 *  · 删掉 sessions 段的 `else errors.push(...)`  → 3 fail (塌了却不留证据, 三条用例同时看得见)
 *  · CLI 末尾 `process.exit(0)` 改成 `exit(1)`   → 1 fail (GWT-3b)
 * 另一侧 (挡「errors 恒非空」这种假证据): 「全活且都无题」用例要求 errors **必须**为空 ——
 * 把任一段改成无条件 push 就红。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectCandidates,
  defaultMineIO,
  parseMineArgs,
  parseSince,
  type MineIO,
} from './autoresearch-mine';

const ROOT = join(import.meta.dir, '..');

/** 全塌的取料口 (四段各给一句原文)。 */
const DEAD_IO: MineIO = {
  failedRuns: () => ({ ok: false, error: 'runs.db 不在: /nowhere/.omd/runs.db' }),
  readout: () => ({ ok: false, error: 'readout 摘要不在' }),
  tickets: () => ({ ok: false, error: '地图读取失败' }),
  testLog: () => ({ ok: false, error: '没有 /tmp/omd-test-run-*.txt' }),
};

/** 只有 failed-runs 一段活着的取料口。 */
const ONE_ALIVE_IO: MineIO = {
  ...DEAD_IO,
  failedRuns: () => ({
    ok: true,
    rows: [
      {
        runId: 'r1',
        status: 'failed',
        error: '终止原因: not-converged (STALLED) · 下一步: 加 maxRounds',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  }),
};

describe('parseSince', () => {
  const now = new Date('2026-09-02T00:00:00.000Z');

  test('相对写法 <N>d', () => {
    expect(parseSince('7d', now)).toBe('2026-08-26T00:00:00.000Z');
    expect(parseSince('1d', now)).toBe('2026-09-01T00:00:00.000Z');
  });

  test('ISO 绝对写法原样归一', () => {
    expect(parseSince('2026-08-01T12:00:00Z', now)).toBe('2026-08-01T12:00:00.000Z');
  });

  test('认不出就抛 (不静默当成"从头开始")', () => {
    expect(() => parseSince('上周', now)).toThrow('认不出');
  });
});

describe('parseMineArgs', () => {
  test('--out 必填', () => {
    expect(() => parseMineArgs([])).toThrow('--out');
  });

  test('--since 缺省 7d', () => {
    expect(parseMineArgs(['--out', 'x.json']).since).toBe('7d');
  });

  test('认不出的参数当场抛 (手滑的 flag 不静默丢)', () => {
    expect(() => parseMineArgs(['--out', 'x.json', '--depth', '3'])).toThrow('认不出');
  });
});

describe('collectCandidates fail-open', () => {
  test('四源全塌: items 空, errors 四条带原文, 不抛', () => {
    const c = collectCandidates(DEAD_IO, '2026-08-26T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
    expect(c.items).toEqual([]);
    expect(c.errors.map((e) => e.source)).toEqual([
      'failed-runs',
      'readout',
      'tickets',
      'test-health',
    ]);
    // 吞异常可以, 吞证据不行 —— 每条都要带得回原文
    for (const e of c.errors) expect(e.error.length).toBeGreaterThan(0);
    expect(c.version).toBe(1);
    expect(c.sinceIso).toBe('2026-08-26T00:00:00.000Z');
  });

  test('四源塌不带走活着的那一源', () => {
    const c = collectCandidates(
      ONE_ALIVE_IO,
      '2026-08-26T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    );
    expect(c.items.map((i) => i.id)).toEqual(['failed-runs:not-converged']);
    expect(c.errors).toHaveLength(3);
  });

  test('全活且都无题 → items 空 errors 也空 (空 ≠ 塌, 靠 errors 分辨)', () => {
    const quiet: MineIO = {
      failedRuns: () => ({ ok: true, rows: [] }),
      readout: () => ({
        ok: true,
        summary: { speedupMedian: 2.1, measurable: 100, excludedMissing: 3, shapeDeclRate: 0.8 },
      }),
      tickets: () => ({ ok: true, maps: [], inFlight: new Set() }),
      testLog: () => ({ ok: true, log: '9101 pass\n0 fail\n' }),
    };
    const c = collectCandidates(quiet, '2026-08-26T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
    expect(c.items).toEqual([]);
    expect(c.errors).toEqual([]);
  });
});

describe('CLI (GWT-3b: runs.db 不存在仍写出 candidates.json 并退 0)', () => {
  test('空 cwd 真跑一遍', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omd-mine-'));
    const out = join(tmp, 'candidates.json');
    const r = spawnSync(
      'bun',
      [join(ROOT, 'scripts', 'autoresearch-mine.ts'), '--cwd', tmp, '--out', out, '--since', '7d'],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    expect(r.status).toBe(0);
    const c = JSON.parse(readFileSync(out, 'utf8'));
    expect(c.version).toBe(1);
    expect(Array.isArray(c.items)).toBe(true);
    // 该 cwd 下 .omd/runs.db 必然缺席 → errors 里逐字有这一源, 且带得回路径
    const failed = (c.errors as { source: string; error: string }[]).find(
      (e) => e.source === 'failed-runs',
    );
    expect(failed).toBeDefined();
    expect(failed!.error).toContain('runs.db');
    // readout 源在空 cwd 下同样缺席 —— 两条都在, 才说明拼装没有短路 (sessions 源随 S1/S2 于 2026-09-04 删除)
    expect((c.errors as { source: string }[]).map((e) => e.source)).toEqual(
      expect.arrayContaining(['failed-runs', 'readout']),
    );
  });
});


describe('readout 矿源真有源 (缺口 2)', () => {
  /** 造一个只有 omd_dag_runs 的 dag-runs.db, 两行都因缺 duration 被整图剔除、都不声明 shape。 */
  function fixtureCwd(): string {
    const tmp = mkdtempSync(join(tmpdir(), 'omd-mine-readout-'));
    mkdirSync(join(tmp, '.omd'), { recursive: true });
    const db = new Database(join(tmp, '.omd', 'dag-runs.db'));
    // 生产表恒有 created_at (dag-record INSERT 列表); 2026-09-04 修尺后矿源按它剔字段前史,
    // 夹具两行给一个**字段后**的时刻 → 仍按「缺 duration 整图剔除」计数 (§6.7)。
    db.run('CREATE TABLE omd_dag_runs (nodes TEXT, shape_id TEXT, outcome TEXT, created_at INTEGER)');
    const nodes = JSON.stringify([
      { id: 'A', deps: [], durationMs: null },
      { id: 'B', deps: ['A'], durationMs: 100 },
    ]);
    const postField = Date.UTC(2026, 7, 20) / 1000;
    db.run('INSERT INTO omd_dag_runs (nodes, shape_id, outcome, created_at) VALUES (?, NULL, ?, ?)', [
      nodes,
      'success',
      postField,
    ]);
    db.run('INSERT INTO omd_dag_runs (nodes, shape_id, outcome, created_at) VALUES (?, NULL, ?, ?)', [
      nodes,
      'success',
      postField,
    ]);
    db.close();
    return tmp;
  }

  test('矿源接上 dag-runs.db: candidates 里真出现 readout:* 三条', () => {
    // 真值链: 两行缺失比例各 0.5 > 0.20 → 全部 excluded-missing → measurable 0
    //   → speedupMedian null → readout:speedup-null;
    //   excludedMissing/seen = 2/2 = 1 > 0.5 → readout:duration-excluded;
    //   shapeDeclRate 0 < 0.1 → readout:shape-decl-low。
    const c = collectCandidates(
      defaultMineIO(fixtureCwd()),
      '2026-08-26T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    );
    expect(c.errors.map((e) => e.source)).not.toContain('readout');
    expect(c.items.map((i) => i.id)).toEqual(
      expect.arrayContaining([
        'readout:speedup-null',
        'readout:duration-excluded',
        'readout:shape-decl-low',
      ]),
    );
  });

  test('db 缺席仍 fail-open 留证据 (退化成 errors 一条, 不抛)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omd-mine-noro-'));
    const io = defaultMineIO(tmp);
    const r = io.readout();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('dag-runs.db');
  });
});
