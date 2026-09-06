/**
 * R5.1 `forRoot` —— 换树时**重建执行手** (契约 `docs/plan/2026-09-06-并行实装扇出-执行契约.md`
 * R5.1 修订, D-R5.1-2 / INV-R5.1-2 / INV-R5.1-3)。
 *
 * ## 它量的是哪个洞
 *
 * 根因 G-2 (bench 臂 code80-m3-fanout3 实测): `loop-run.ts` 的 `runChild` 只把 `over.cwd` 写进
 * `continuity.execRoot` —— 那是**状态锚**; 而 `agentRunner` / `commandRunner` 是装配期按
 * `cwd=/workspace` 建的, 换树一个字节都没换。三份尝试于是并发写**主工作区**, 各自 worktree
 * 相对基线零改动: 账本上的原话是 `chosen: -1`, `applyConflicts: 3`, 30/30 份 diff 全空。
 *
 * 所以这里不测 `fanout-impl` 的四件事 (那在 fanout-impl.test.ts), 只测**一件**:
 * `runChild` 拿到 `over.cwd` 时, 它跑起来的那只手到底写在哪棵树上。
 *
 * ## 反向自检 (实装前红过)
 *
 *  · `runChild` 里去掉 `...base.forRoot?.(over.cwd)` 这一跳 ⇒ INV-R5.1-2 当场红
 *    (三份尝试全写主工作区、树里零改动 ⇒ 判据在树里不绿、diff 空 ⇒ `chosen: -1`);
 *  · `forRoot` 无条件展开 (不看 `over?.cwd`) ⇒ INV-R5.1-3 当场红 (缺席时 config 就不再逐字节同旧)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import { compileOrchestratingLoop, conductorNodeIdOf } from './orchestrating-loop';
import { createConductorCardLedger, type ConductorCardLedger } from './loop-ledger';
import { conductorCtxOf, withLoopConfig, type LoopHost } from './loop-run';

// ── 夹具 ────────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr)}`);
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-fanout-root-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 't@t'], root);
  git(['config', 'user.name', 't'], root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/real.ts'), 'export const x = 0;\n');
  // 触发闸是 root-aware 的 (D-R5.1-1): `grep` 是 base-only 词, 语言一致闸不判它,
  // 但仓里仍要有真身让 diff 有东西可比。
  writeFileSync(join(root, 'package.json'), '{"name":"fanout-root-fixture"}\n');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'init'], root);
  return root;
}

/** 扇出树的号 = 目录名末段 (`<stamp>-<i>`); 主工作区没有这个形状 → -1。 */
const idxOf = (dir: string): number => {
  const m = /-(\d+)$/.exec(basename(dir));
  return m ? Number.parseInt(m[1]!, 10) : -1;
};

const fakeExec = (plan: ConductorPlan): ExecutorDagResult =>
  ({
    plan,
    sessionId: 's',
    levels: [Object.keys(plan.nodes)],
    results: Object.fromEntries(
      Object.keys(plan.nodes).map((id) => [id, { id, status: 'done', output: 'ok', deps: [], usage: { in: 0, out: 0 } }]),
    ),
  }) as unknown as ExecutorDagResult;

/** 往 `root` 写一行的假 agent 手 —— 它写在哪, 就证明这一份尝试的执行面在哪棵树上。 */
const runnerWriting = (root: string, line: string, seen: string[]): ExecutorDagConfig['agentRunner'] =>
  (async () => {
    seen.push(root);
    writeFileSync(join(root, 'src/real.ts'), `export const x = 0; // ${line}\n`);
    return { text: 'ok', usage: { in: 0, out: 0 } };
  }) as unknown as ExecutorDagConfig['agentRunner'];

interface Wired {
  work: { execute: (id: string, params: unknown) => Promise<unknown> };
  ledger: ConductorCardLedger;
  /** 每次子 run 拿到的 config (INV-R5.1-3 的比较对象)。 */
  seen: ExecutorDagConfig[];
  /** 每只真跑起来的手写在了哪个根上。 */
  wroteTo: string[];
}

/**
 * 把一副 conductor 面装出来 —— 走的是**生产那条装配** (`withLoopConfig`), 不是手搓 `runChild`:
 * 这一条不变量的全部意义就在那一跳上, 绕过它测出来的绿是假的。
 */
function wire(root: string, opts: { forRoot?: boolean } = {}): Wired {
  const seen: ExecutorDagConfig[] = [];
  const wroteTo: string[] = [];
  const base = {
    conductorModel: 'c:1',
    leafModel: 'l:1',
    maxFanout: 4,
    // 装配期烤死的那只手 —— 它恒写**主工作区** (正是 G-2 的现场)。
    agentRunner: runnerWriting(root, 'main', wroteTo),
    ...(opts.forRoot
      ? {
          forRoot: (r: string) => ({ agentRunner: runnerWriting(r, `tree-${idxOf(r)}`, wroteTo) }),
        }
      : {}),
  } as unknown as ExecutorDagConfig;
  const host: LoopHost = {
    cwd: root,
    dag: base,
    runDag: async (plan, cfg) => {
      seen.push(cfg);
      await (cfg.agentRunner as unknown as (i: unknown) => Promise<unknown>)({});
      return fakeExec(plan);
    },
  };
  // 判据只在 1 号树里绿 ⇒ 择优走 only-green, 一次判官都不调 (座位表在测试机上未必空)。
  const runnable = { command: 'grep -q tree-1 src/real.ts', expectExit: 0 };
  const plan = compileOrchestratingLoop({ goal: '改 src/real.ts', ctx: conductorCtxOf(host, runnable), conductorModel: 'c:1' });
  const ledger = createConductorCardLedger();
  const cfg = withLoopConfig(base, plan, host, runnable, '改 src/real.ts', ledger);
  const face = cfg.leafFace!({ id: conductorNodeIdOf(plan) } as never)!;
  return { work: face.customTools!.find((t) => t.name === 'work')! as unknown as Wired['work'], ledger, seen, wroteTo };
}

const PARAMS = { goal: '改 `x`, 它在 `src/real.ts:1`', brief: 'repro: grep -q tree-1 src/real.ts → exit 1。scope: 一个文件。', write_set: ['src/real.ts'] };

const roots: string[] = [];
const fresh = (): string => {
  const r = repo();
  roots.push(r);
  return r;
};

afterEach(() => {
  delete process.env.OMD_WORK_FANOUT;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// ── INV-R5.1-2 换树真换执行手 ───────────────────────────────────────────────

describe('INV-R5.1-2: forRoot 给了 ⇒ 三份尝试各写各的树, 主工作区在扇出期间没被写', () => {
  test('★ 三只手写的是三棵 worktree (不是主树); 赢家 diff 非空 ⇒ chosen=1 且零冲突 (证伪: 去掉 runChild 里的 forRoot 展开 ⇒ 本条红)', async () => {
    process.env.OMD_WORK_FANOUT = '3';
    const root = fresh();
    const w = wire(root, { forRoot: true });
    await w.work.execute('t', PARAMS);

    // ① 三只手都写在扇出树里, 一只都没落在主工作区 —— 这就是 G-2 那句「产物却全落在主树」的反面。
    expect(w.wroteTo).toHaveLength(3);
    expect(w.wroteTo.map(idxOf).sort()).toEqual([0, 1, 2]);
    expect(w.wroteTo).not.toContain(root);
    for (const d of w.wroteTo) expect(d.startsWith(join(root, '.omd', 'fanout'))).toBe(true);

    // ② 每份 diff 非空的**可观测形态**: 空 diff 会被 applyWinner 一律拒 (「一个字节都没改」),
    //    于是账本长成 bench 那副样子 —— chosen:-1 + applyConflicts:3。这里两位都在反面。
    expect(w.ledger.fanout).toMatchObject({ n: 3, ran: 3, green: 1, chosen: 1, chosenBy: 'only-green', applyConflicts: 0 });

    // ③ 赢家那棵树的字节真进了主工作区 (合回搬的是 1 号树写的那行, 不是主树自己写的 'main')。
    expect(readFileSync(join(root, 'src/real.ts'), 'utf8')).toContain('tree-1');
  });
});

// ── INV-R5.1-3 钩子缺席 = 逐字节同旧 ────────────────────────────────────────

describe('INV-R5.1-3: forRoot 缺席 ⇒ runChild 的 config 与改前逐字相同', () => {
  test('★ 带 over.cwd 的那份与不带 over 的那份逐键同一个引用 (证伪: 写成 `agentRunner: base.forRoot?.(cwd)?.agentRunner` —— 键恒在值可 undefined ⇒ 本条红)', async () => {
    process.env.OMD_WORK_FANOUT = '2';
    const root = fresh();
    // **同一副面同一个 base**: 两份尝试带 over.cwd, 全合不回之后退回的那一发不带 over ——
    // 两种 config 在同一次执行里都出现了, 不用第二个 base 去比 (那比的是两个对象, 不是那一跳)。
    const w = wire(root);
    await w.work.execute('t', PARAMS);
    expect(w.seen).toHaveLength(3); // 2 份尝试 + 退回单份派发的那一发

    const withOver = w.seen[0]!;
    const baseline = w.seen[2]!;
    expect(Object.keys(withOver).sort()).toEqual(Object.keys(baseline).sort());
    for (const k of Object.keys(baseline)) {
      // 引用相等: 钩子缺席时 `runChild` 不许换掉任何一只手, 也不许多塞一个键 (哪怕值是 undefined)。
      expect((withOver as unknown as Record<string, unknown>)[k]).toBe((baseline as unknown as Record<string, unknown>)[k]);
    }
    // 三发全跑在没换手的那只上 ⇒ 写的全是主工作区 (这正是修之前的生产行为)。
    expect(w.wroteTo.every((d) => d === root)).toBe(true);
    expect(existsSync(join(root, '.omd', 'fanout'))).toBe(true); // 树建过 (拆干净了, 目录壳留着)
  });
});
