/**
 * R5 并行实装扇出的**接线面** —— 契约 `docs/plan/2026-09-06-并行实装扇出-执行契约.md` 切片 2
 * (INV-1 … INV-6)。
 *
 * 派发本身走注入的 `runChild` (它按 `over.cwd` 往各自那棵树里写不同的内容), 判据 runner 与
 * 比较卷也全走注入 —— 这里量的是**接线**: 开关认不认、N 份是不是各写各的树、择优选没选对、
 * 赢家有没有真进主工作区、树有没有拆干净、账本三态对不对。
 *
 * 反向自检 (每条实装前红过):
 *  · `adaptCard` 不看 `OMD_WORK_FANOUT` ⇒ INV-1「缺席时只派一次且不带覆盖参数」当场红;
 *  · 不跑判据直接选第 0 份 ⇒ INV-2「chosen===1 / only-green」当场红;
 *  · 合回失败不退次优 ⇒ INV-5「退次优」当场红;
 *  · 修复轮也扇出 ⇒ INV-6「第二次 work 不带覆盖参数」当场红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ConductorPlan } from '../conductor-plan';
import type { ConductorCtx } from '../conductor/types';
import type { ExecutorDagResult } from '../dag/types';
import { createConductorCardLedger, type ConductorCardLedger } from './loop-ledger';
import { buildConductorFace } from './orchestrating-loop';
import type { FanoutAttempt } from './fanout-impl';

// ── 夹具 ────────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr)}`);
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-fanout-wire-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 't@t'], root);
  git(['config', 'user.name', 't'], root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/real.ts'), 'export const saveReasonFull = -1;\n');
  // R5.1 (2026-09-07): 触发闸改 root-aware 之后, `bun test` 这条判据要仓里**有 js 证据**才放行
  // (语言一致闸认 package.json / tsconfig.json / bun.lock 任一)。夹具补上 marker —— 否则本文件
  // 所有「扇出触发」的用例都会因为"这仓没有 js 证据"而不触发, 量的就不是接线了。
  writeFileSync(join(root, 'package.json'), '{"name":"fanout-fixture"}\n');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'init'], root);
  return root;
}

/**
 * PATH 上放一个假 bin —— root-aware 闸的第三道 (`missingBinaryBlockReason`) 问的是
 * 「这台机器上装没装这个命令」, 而 CI/本机不一定有 pytest。假 bin 只为过那一道, 不会被执行
 * (判据 runner 在本文件里是注入的)。
 */
const pathBackup: string[] = [];
function withFakeBin(root: string, name: string): void {
  const bin = join(root, '.fakebin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  pathBackup.push(process.env.PATH ?? '');
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
}

/** 扇出树的号 = 目录名末段 (`<stamp>-<i>`); 主工作区没有这个形状 → -1。 */
const idxOf = (cwd: string): number => {
  const m = /-(\d+)$/.exec(basename(cwd));
  return m ? Number.parseInt(m[1]!, 10) : -1;
};

const fakeExec = (plan: ConductorPlan): ExecutorDagResult =>
  ({
    plan,
    sessionId: 's',
    levels: [Object.keys(plan.nodes)],
    results: Object.fromEntries(Object.keys(plan.nodes).map((id) => [id, { id, status: 'done', output: 'ok', deps: [], usage: { in: 0, out: 0 } }])),
  }) as unknown as ExecutorDagResult;

interface Harness {
  work: { execute: (id: string, params: unknown) => Promise<unknown> };
  ledger: ConductorCardLedger;
  /** 每次 `runChild` 拿到的覆盖参数 (缺席 = 派在主工作区)。 */
  overs: Array<{ cwd: string } | undefined>;
  comparePools: number[][];
  applyTried: number[];
}

function harness(
  root: string,
  opts: {
    green?: number[];
    compare?: (green: FanoutAttempt[]) => Promise<{ index: number; reason: string }>;
    applyOk?: (index: number) => boolean;
    /** 冻结判据原文 (缺省 = 本仓夹具的 js 判据); INV-R5.1-1 用它换成 pytest 那条。 */
    acceptance?: string;
  } = {},
): Harness {
  const ctx: ConductorCtx = {
    cwd: root,
    writeRoot: root,
    acceptance: { command: opts.acceptance ?? 'bun test src/real.test.ts', expect_exit: 0 },
    allowlist: ['bun', 'git'],
    maxFanout: 4,
    seats: { worker: 'w:1', escalation: 'e:1', verify: '' },
    researchAvailable: false,
  } as ConductorCtx;
  const ledger = createConductorCardLedger();
  const overs: Array<{ cwd: string } | undefined> = [];
  const comparePools: number[][] = [];
  const applyTried: number[] = [];
  const built = buildConductorFace(
    { goal: '修一件事', writeRoot: root, minutesLeft: 30, tokensLeft: null, maxFanout: 4, researchAvailable: false },
    {
      ctx,
      ledger,
      runChild: async (p, _seq, over) => {
        overs.push(over);
        const cwd = over?.cwd ?? root;
        // 每棵树写不同的内容 —— 择优选错了, 主工作区里的那个数就对不上。
        writeFileSync(join(cwd, 'src/real.ts'), `export const saveReasonFull = ${idxOf(cwd)};\n`);
        return fakeExec(p);
      },
      fanoutRunCriterion: async ({ cwd }) => {
        const i = idxOf(cwd);
        return (opts.green ?? []).includes(i)
          ? { exitCode: 0, text: '3 pass, 0 fail' }
          : { exitCode: 1, text: `${i + 1} fail` };
      },
      ...(opts.compare
        ? {
            compareFanout: async (green: FanoutAttempt[]) => {
              comparePools.push(green.map((a) => a.index));
              return opts.compare!(green);
            },
          }
        : {}),
      ...(opts.applyOk
        ? {
            fanoutApply: (_root: string, a: FanoutAttempt) => {
              applyTried.push(a.index);
              if (!opts.applyOk!(a.index)) return { applied: false, why: `注入的冲突 (#${a.index})` };
              writeFileSync(join(root, 'src/real.ts'), readFileSync(join(a.worktree, 'src/real.ts'), 'utf8'));
              return { applied: true };
            },
          }
        : {}),
    },
  );
  return { work: built.customTools!.find((t) => t.name === 'work')! as unknown as Harness['work'], ledger, overs, comparePools, applyTried };
}

const BRIEF = 'repro: bun test src/real.test.ts → 1 fail exit 1. scope: 一个文件。';
const PARAMS = { goal: '改 `saveReasonFull`, 它在 `src/real.ts:1`', brief: BRIEF, write_set: ['src/real.ts'] };

const roots: string[] = [];
const fresh = (): string => {
  const r = repo();
  roots.push(r);
  return r;
};
const value = (root: string): string => readFileSync(join(root, 'src/real.ts'), 'utf8').trim();
const fanoutDirsLeft = (root: string): boolean => existsSync(join(root, '.omd', 'fanout')) && Bun.spawnSync(['ls', join(root, '.omd', 'fanout')], { stdout: 'pipe' }).stdout.length > 0;

afterEach(() => {
  delete process.env.OMD_WORK_FANOUT;
  // PATH 改过就还回去 (第一次备份的那份 = 本文件动手之前的原值)。
  if (pathBackup.length) process.env.PATH = pathBackup.splice(0)[0]!;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// ── INV-1 开关缺席 ⇒ 派发路径字节不变 ────────────────────────────────────────

describe('INV-1: OMD_WORK_FANOUT 缺席 ⇒ 派发路径字节不变', () => {
  test('★ 缺席 ⇒ 只派一次、不带覆盖参数、账本没有 fanout 那一格 (缺席 = 没扇出, 不是 0)', async () => {
    const root = fresh();
    const h = harness(root);
    await h.work.execute('t', PARAMS);
    expect(h.overs).toEqual([undefined]);
    expect(h.ledger.fanout).toBeUndefined();
    expect(fanoutDirsLeft(root)).toBe(false);
  });

  test('★ 越界档位 (=1) 与缺席**逐字节**同一个返回 (不许从别的路径漏出去)', async () => {
    const a = fresh();
    const ra = await harness(a).work.execute('t', PARAMS);
    process.env.OMD_WORK_FANOUT = '1';
    const b = fresh();
    const hb = harness(b);
    const rb = await hb.work.execute('t', PARAMS);
    expect(JSON.stringify(rb)).toBe(JSON.stringify(ra));
    expect(hb.overs).toEqual([undefined]);
    expect(hb.ledger.fanout).toBeUndefined();
  });
});

// ── INV-2 恰一份绿 ──────────────────────────────────────────────────────────

describe('INV-2: 3 份各写各的树, 第 2 份绿 ⇒ only-green 并合回', () => {
  test('★ chosen===1 · by only-green · 主工作区拿到第 1 份 · 树已拆干净', async () => {
    process.env.OMD_WORK_FANOUT = '3';
    const root = fresh();
    const h = harness(root, { green: [1] });
    await h.work.execute('t', PARAMS);
    // 三份各自跑在自己的树里 (号互不相同), 没有一份派在主工作区。
    expect(h.overs).toHaveLength(3);
    expect(h.overs.map((o) => idxOf(o!.cwd)).sort()).toEqual([0, 1, 2]);
    expect(h.ledger.fanout).toMatchObject({ n: 3, ran: 3, green: 1, chosen: 1, chosenBy: 'only-green', noGreen: false, applyConflicts: 0 });
    expect(h.ledger.fanout!.wallMs).toBeGreaterThanOrEqual(0);
    expect(value(root)).toBe('export const saveReasonFull = 1;');
    expect(fanoutDirsLeft(root)).toBe(false);
  });
});

// ── INV-3 两份绿 ⇒ 比较卷 ───────────────────────────────────────────────────

describe('INV-3: ≥2 份绿 ⇒ 一次比较卷; 判官抛错退 least-failures', () => {
  test('★ 只把绿的交给判官, by=verifier, 赢家按判官点的号合回', async () => {
    process.env.OMD_WORK_FANOUT = '3';
    const root = fresh();
    const h = harness(root, { green: [0, 2], compare: async () => ({ index: 2, reason: '第 2 份连边界一起改了' }) });
    await h.work.execute('t', PARAMS);
    expect(h.comparePools).toEqual([[0, 2]]);
    expect(h.ledger.fanout).toMatchObject({ green: 2, chosen: 2, chosenBy: 'verifier', noGreen: false });
    expect(value(root)).toBe('export const saveReasonFull = 2;');
  });

  test('★ 判官抛错 ⇒ by=least-failures (证伪: 去掉 try/catch ⇒ 整次派发抛错, 本条红)', async () => {
    process.env.OMD_WORK_FANOUT = '2';
    const root = fresh();
    const h = harness(root, {
      green: [0, 1],
      compare: async () => {
        throw new Error('判官坏了');
      },
    });
    await h.work.execute('t', PARAMS);
    expect(h.comparePools).toEqual([[0, 1]]);
    expect(h.ledger.fanout).toMatchObject({ chosenBy: 'least-failures', noGreen: false });
  });
});

// ── INV-4 零份绿 ────────────────────────────────────────────────────────────

describe('INV-4: 零份绿 ⇒ noGreen, 选失败用例最少的一份', () => {
  test('★ noGreen=true · chosen=0 (它的判词是 1 fail, 另两份 2/3 fail) · 照样合回给修复轮接手', async () => {
    process.env.OMD_WORK_FANOUT = '3';
    const root = fresh();
    const h = harness(root, { green: [] });
    await h.work.execute('t', PARAMS);
    expect(h.ledger.fanout).toMatchObject({ green: 0, noGreen: true, chosen: 0, chosenBy: 'least-failures' });
    expect(value(root)).toBe('export const saveReasonFull = 0;');
  });
});

// ── INV-5 合回冲突 ──────────────────────────────────────────────────────────

describe('INV-5: 赢家合不回 ⇒ 退次优; 全合不回 ⇒ 退单份路径并记账', () => {
  test('★ 赢家冲突一次 ⇒ 试次优并成功, applyConflicts=1', async () => {
    process.env.OMD_WORK_FANOUT = '3';
    const root = fresh();
    const h = harness(root, { green: [], applyOk: (i) => i !== 0 });
    await h.work.execute('t', PARAMS);
    expect(h.applyTried[0]).toBe(0); // 先试机械档选出来的那一份
    expect(h.ledger.fanout).toMatchObject({ applyConflicts: 1, chosen: 1, chosenBy: 'least-failures' });
    expect(value(root)).toBe('export const saveReasonFull = 1;');
  });

  test('★ 三份全合不回 ⇒ fanout.why 有原文, 并退回单份派发 (最后一发不带覆盖参数)', async () => {
    process.env.OMD_WORK_FANOUT = '3';
    const root = fresh();
    const h = harness(root, { green: [], applyOk: () => false });
    await h.work.execute('t', PARAMS);
    expect(h.ledger.fanout!.applyConflicts).toBe(3);
    expect(h.ledger.fanout!.why ?? '').not.toBe('');
    expect(h.overs).toHaveLength(4);
    expect(h.overs[3]).toBeUndefined(); // 退回单份 = 派在主工作区
    expect(value(root)).toBe('export const saveReasonFull = -1;'); // 主工作区那一发的号
  });
});

// ── INV-6 修复轮不再扇出 ────────────────────────────────────────────────────

describe('INV-6: 第二次 work (修复轮) 不再扇出', () => {
  test('★ 第二发不带覆盖参数, fanout 那一格只记一次 (n 仍是第一发的)', async () => {
    process.env.OMD_WORK_FANOUT = '2';
    const root = fresh();
    const h = harness(root, { green: [1] });
    await h.work.execute('t', PARAMS);
    await h.work.execute('t', PARAMS);
    expect(h.overs).toHaveLength(3);
    expect(h.overs[2]).toBeUndefined();
    expect(h.ledger.fanout).toMatchObject({ n: 2, ran: 2 });
    expect(h.ledger.dispatches).toHaveLength(2);
  });
});

// ── INV-R5.1-1 触发判定走 root-aware 闸 (2026-09-07) ─────────────────────────
//
// 根因 (G-1, bench 臂 code80-m3-fanout3 实测 80 题只触发 10 题): `initFanoutState` 调的是
// **无根版** `isRunnableAcceptanceCommand`, 它只看 `DEFAULT_COMMAND_ALLOWLIST` —— 表里没有
// pytest, 于是 75 次「开关开着但没有可跑的执行型判据」全落在 python 仓的 `pytest …` 上。

describe('INV-R5.1-1: 触发判定用 root-aware 闸 (allowlistForRoot), 不是无根白名单', () => {
  test('★ pytest 判据 + python 仓 (pyproject.toml) ⇒ 触发扇出 (证伪: 换回 isRunnableAcceptanceCommand ⇒ 本条红)', async () => {
    process.env.OMD_WORK_FANOUT = '2';
    const root = fresh();
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "x"\n');
    withFakeBin(root, 'pytest');
    // 判据点名的文件此刻**不存在** —— D-R5.1-1 不传 declaredArtifacts, 路径自证那道不在这里跑
    // (那个文件由树里的尝试写出, D-3 ① 在树里跑判据时它才该在)。传了这条就会被拒。
    expect(existsSync(join(root, 'tests/test_x.py'))).toBe(false);
    const h = harness(root, { green: [1], acceptance: 'pytest -q tests/test_x.py' });
    await h.work.execute('t', PARAMS);
    expect(h.overs).toHaveLength(2);
    expect(h.ledger.fanout).toMatchObject({ n: 2, ran: 2, chosen: 1, chosenBy: 'only-green' });
  });

  test('★ 同一条 pytest 判据, 仓里没有 python marker ⇒ 仍不触发 (root-aware ≠ 一律放行)', async () => {
    process.env.OMD_WORK_FANOUT = '2';
    const root = fresh(); // 只有 package.json (js marker), 没有 pyproject.toml
    withFakeBin(root, 'pytest');
    const h = harness(root, { acceptance: 'pytest -q tests/test_x.py' });
    await h.work.execute('t', PARAMS);
    expect(h.overs).toEqual([undefined]);
    expect(h.ledger.fanout).toBeUndefined();
  });
});
