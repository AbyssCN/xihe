/**
 * R5 并行实装扇出的纯模块 —— 契约 `docs/plan/2026-09-06-并行实装扇出-执行契约.md` 切片 1。
 *
 * 这里只钉「规划 / 打分 / 择优 / 合回」四件事, 一次真派发都不打:
 *  · `planFanoutWorktrees` 建出 N 棵隔离树, 且树里**看得见主树未提交的改动** (D-2 的 stash-create 快照);
 *  · `scoreAttempts` 分「判据绿的」与「按失败用例数排的」两列;
 *  · `chooseAttempt` 三条出口 (only-green / verifier / least-failures) 各走一遍, 判官抛错退到机械档;
 *  · `applyWinner` 把赢家 diff 打回主工作区, 冲突时**主工作区一个字节不动**。
 *
 * 反向自检 (每条都在实装前红过, 证伪方式写在各 test 上):
 *  · `planFanoutWorktrees` 改成从 `HEAD` 建树 (不走 stash create) ⇒ 「树里看得见未提交改动」当场红;
 *  · `chooseAttempt` 去掉 compare 的 try/catch ⇒ 「判官抛错退 least-failures」当场红;
 *  · `applyWinner` 把 `git apply` 的退出码当成恒 0 ⇒ 「冲突时主工作区不变」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyWinner,
  captureAttemptDiff,
  chooseAttempt,
  countFailingCases,
  disposeFanoutWorktrees,
  parseFanoutN,
  planFanoutWorktrees,
  scoreAttempts,
  type FanoutAttempt,
} from './fanout-impl';

// ── 真仓夹具 (mkdtemp + git init, 不 mock git) ───────────────────────────────

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} 失败: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

/** 一个有一次提交的真仓; `dirty` 为真时再改一个**已跟踪**文件但不提交。 */
function repo(dirty = false): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-fanout-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 't@t'], root);
  git(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'a.txt'), 'base\n');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'init'], root);
  if (dirty) writeFileSync(join(root, 'a.txt'), 'base\nuncommitted\n');
  return root;
}

const attempt = (index: number, exitCode: number | null, failing: number, diff = 'D'): FanoutAttempt => ({
  index,
  worktree: `/wt/${index}`,
  exitCode,
  failing,
  diff,
});

// ── D-1 触发档位 ─────────────────────────────────────────────────────────────

describe('parseFanoutN —— 2..4 之外一律不扇出', () => {
  test('★ 2/3/4 认, 1/5/空/非数一律 undefined (缺席 = 关, 不是 0)', () => {
    expect(parseFanoutN('2')).toBe(2);
    expect(parseFanoutN('3')).toBe(3);
    expect(parseFanoutN('4')).toBe(4);
    for (const raw of ['1', '5', '0', '', ' ', 'abc', undefined]) expect(parseFanoutN(raw)).toBeUndefined();
  });
});

// ── D-2 隔离 ────────────────────────────────────────────────────────────────

describe('planFanoutWorktrees —— N 棵隔离树, 带上主树未提交的改动', () => {
  test('★ 未提交改动在每棵树里都看得见 (证伪: 改成从 HEAD 建树 ⇒ 本条红)', () => {
    const root = repo(true);
    try {
      const { worktrees, base } = planFanoutWorktrees(root, 3);
      expect(worktrees).toHaveLength(3);
      expect(base).not.toBe(git(['rev-parse', 'HEAD'], root)); // stash create 造了一个新 commit 对象
      for (const wt of worktrees) expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toContain('uncommitted');
      disposeFanoutWorktrees(root, worktrees);
      for (const wt of worktrees) expect(Bun.spawnSync(['test', '-d', wt]).exitCode).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ 干净树 ⇒ base 退回 HEAD (stash create 无输出不是失败)', () => {
    const root = repo(false);
    try {
      const { worktrees, base } = planFanoutWorktrees(root, 2);
      expect(base).toBe(git(['rev-parse', 'HEAD'], root));
      expect(worktrees).toHaveLength(2);
      disposeFanoutWorktrees(root, worktrees);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ 不是 git 仓 ⇒ 抛 (调用方据此退回单份路径, 不许静默把 N 份都写进主树)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-fanout-nogit-'));
    try {
      expect(() => planFanoutWorktrees(root, 2)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('captureAttemptDiff —— 新建文件也要进 diff', () => {
  test('★ worktree 里新建的未跟踪文件出现在 diff 里 (证伪: 去掉 `git add -A` ⇒ 本条红)', () => {
    const root = repo(false);
    try {
      const { worktrees, base } = planFanoutWorktrees(root, 2);
      writeFileSync(join(worktrees[0]!, 'new.txt'), 'hello\n');
      const diff = captureAttemptDiff(worktrees[0]!, base);
      expect(diff).toContain('new.txt');
      expect(diff).toContain('hello');
      disposeFanoutWorktrees(root, worktrees);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── D-3 打分与择优 ───────────────────────────────────────────────────────────

describe('countFailingCases —— 数出来的失败用例数; 数不出来时 0/1 兜底', () => {
  test('★ 常见判词各取一次; 绿 = 0, 数不出的红 = 1 (不编)', () => {
    expect(countFailingCases('3 pass\n2 fail\n', 1)).toBe(2);
    expect(countFailingCases('Tests:  4 failed, 9 passed', 1)).toBe(4);
    expect(countFailingCases('everything ok', 0)).toBe(0);
    expect(countFailingCases('boom', 1)).toBe(1);
    expect(countFailingCases('', null)).toBe(1); // 死于信号 = 没跑完, 不是 0 个失败
  });
});

describe('scoreAttempts —— green 列与 ranked 列', () => {
  test('★ green = 退出码等于期望值的; ranked 按失败用例数升序 (同数按 index)', () => {
    const r = scoreAttempts([attempt(0, 1, 3), attempt(1, 0, 0), attempt(2, 1, 1)]);
    expect(r.green).toEqual([1]);
    expect(r.ranked).toEqual([1, 2, 0]);
  });

  test('★ expectExit 非 0 时按它判绿 (判据可以约定非零期望)', () => {
    const r = scoreAttempts([attempt(0, 0, 0), attempt(1, 3, 0)], 3);
    expect(r.green).toEqual([1]);
  });

  test('★ exitCode null (死于信号) 不算绿', () => {
    expect(scoreAttempts([attempt(0, null, 0)]).green).toEqual([]);
  });
});

describe('chooseAttempt —— 三条出口', () => {
  test('★ 恰一份绿 ⇒ only-green, 不调判官 (INV-2)', async () => {
    let calls = 0;
    const c = await chooseAttempt([attempt(0, 1, 2), attempt(1, 0, 0), attempt(2, 1, 5)], async () => {
      calls++;
      return { index: 0, reason: '不该被调到' };
    });
    expect(c).toEqual({ chosen: 1, by: 'only-green', noGreen: false });
    expect(calls).toBe(0);
  });

  test('★ 两份绿 ⇒ 调一次比较卷, by = verifier (INV-3)', async () => {
    const seen: number[][] = [];
    const c = await chooseAttempt([attempt(0, 0, 0), attempt(1, 0, 0), attempt(2, 1, 4)], async (green) => {
      seen.push(green.map((a) => a.index));
      return { index: 1, reason: '第 1 份改得更完整' };
    });
    expect(seen).toEqual([[0, 1]]); // 只把绿的交给判官
    expect(c.chosen).toBe(1);
    expect(c.by).toBe('verifier');
    expect(c.reason).toContain('更完整');
    expect(c.noGreen).toBe(false);
  });

  test('★ 判官抛错 ⇒ 退到 least-failures (证伪: 去掉 try/catch ⇒ 本条红)', async () => {
    const c = await chooseAttempt([attempt(0, 0, 0), attempt(1, 0, 0)], async () => {
      throw new Error('判官坏了');
    });
    expect(c.by).toBe('least-failures');
    expect(c.chosen).toBe(0);
    expect(c.noGreen).toBe(false);
  });

  test('★ 判官点了一个不在绿名单里的号 ⇒ 同样退 least-failures (不许它选一份红的)', async () => {
    const c = await chooseAttempt([attempt(0, 0, 0), attempt(1, 0, 0), attempt(2, 1, 0)], async () => ({
      index: 2,
      reason: '我要那份红的',
    }));
    expect(c.by).toBe('least-failures');
    expect(c.chosen).toBe(0);
  });

  test('★ 零份绿 ⇒ noGreen, 选失败用例最少的一份 (INV-4)', async () => {
    const c = await chooseAttempt([attempt(0, 1, 7), attempt(1, 1, 2), attempt(2, 1, 9)]);
    expect(c).toEqual({ chosen: 1, by: 'least-failures', noGreen: true });
  });

  test('★ 两份绿而没有判官 ⇒ least-failures (不假装调过)', async () => {
    const c = await chooseAttempt([attempt(0, 0, 1), attempt(1, 0, 0)]);
    expect(c.by).toBe('least-failures');
    expect(c.chosen).toBe(1);
  });
});

// ── D-4 合回 ────────────────────────────────────────────────────────────────

describe('applyWinner —— 赢家 diff 打回主工作区', () => {
  test('★ 干净应用 ⇒ 主工作区拿到那份改动', () => {
    const root = repo(false);
    try {
      const { worktrees, base } = planFanoutWorktrees(root, 2);
      writeFileSync(join(worktrees[0]!, 'a.txt'), 'base\nwinner\n');
      const diff = captureAttemptDiff(worktrees[0]!, base);
      const r = applyWinner(root, { ...attempt(0, 0, 0), worktree: worktrees[0]!, diff });
      expect(r.applied).toBe(true);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toContain('winner');
      disposeFanoutWorktrees(root, worktrees);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ 冲突 ⇒ applied:false + why 带 git 原文, 主工作区一个字节不变 (INV-5)', () => {
    const root = repo(false);
    try {
      const { worktrees, base } = planFanoutWorktrees(root, 2);
      writeFileSync(join(worktrees[0]!, 'a.txt'), 'base\nwinner\n');
      const diff = captureAttemptDiff(worktrees[0]!, base);
      // 主工作区在这份 diff 的基线之后自己动过 → 打不上去。
      writeFileSync(join(root, 'a.txt'), 'totally different\n');
      const before = readFileSync(join(root, 'a.txt'), 'utf8');
      const r = applyWinner(root, { ...attempt(0, 0, 0), worktree: worktrees[0]!, diff });
      expect(r.applied).toBe(false);
      expect(r.why ?? '').not.toBe('');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(before);
      disposeFanoutWorktrees(root, worktrees);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ 空 diff ⇒ applied:false 且说明是空的 (「什么都没改」不许被读成合回成功)', () => {
    const root = repo(false);
    try {
      const r = applyWinner(root, attempt(0, 0, 0, ''));
      expect(r.applied).toBe(false);
      expect(r.why ?? '').toContain('空');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
