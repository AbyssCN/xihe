/**
 * src/harness/goal/fanout-impl —— R5 并行实装扇出的纯模块
 * (契约 `docs/plan/2026-09-06-并行实装扇出-执行契约.md`, D-2 / D-3 / D-4)。
 *
 * ## 它填的是哪个洞
 *
 * 读数: 同一题在各臂间既拿过 ≥0.9 又拿过 ≤0.3 的有 34/80 —— 同一座位同一题, 有时做对有时做错。
 * 方差本身就是收益来源: 同一 brief 采 N 份实装, 用**执行侧改不了的判据**择优, 期望值从
 * 「一次掷硬币」变成「N 次里最好的一次」。判据层已经这么做了 (三候选共识 +0.05), 实装层没做过。
 *
 * ## 这里只有四件事, 一次模型调用都不打
 *
 * 1. `planFanoutWorktrees` —— N 棵隔离树, 从**当前未提交改动的快照**建 (D-2);
 * 2. `scoreAttempts` —— 判据绿的那几号 + 按失败用例数排的名次;
 * 3. `chooseAttempt` —— 三条出口 only-green / verifier / least-failures (D-3);
 * 4. `applyWinner` —— 赢家 diff 打回主工作区, 打不上去就说打不上去 (D-4)。
 *
 * 派发本身、并发上限、账本、比较卷的判词, 全在接线层 (`orchestrating-loop.ts` / `verifier.ts`) ——
 * 这个文件不认识 conductor, 也不认识模型。
 *
 * ## 快照为什么走**临时索引**, 而不是 `HEAD` 也不是 `git stash create`
 *
 * `git worktree add` 出来的是**该 ref 的干净 checkout** (`run-worktree.ts` 头注的第三条诚实边界)。
 * 扇出跑在一次 run 的**中途** —— 此前的派发已经往主工作区写了东西, 从 HEAD 建树等于让 N 份尝试
 * 全部看不见前面的活, 各自从头重做一遍。
 *
 * 第一版用的是 `git stash create`, 它**只含已跟踪文件的改动**。这在 bench 上是致命的:
 * R4 异族座先写的判据文件是**写进了仓但没 `git add`** 的新文件, 而 conductor 首发派 `work` 时
 * 它正是判据所在。判据文件不进快照 ⇒ N 棵树里每棵跑判据都红在「文件不存在」⇒ 全员 noGreen ⇒
 * 择优退化成随机, 整个扇出的收益归零, **而且账本上看起来一切正常**。
 *
 * 现在的做法: 在 `mkdtemp` 里开一个**临时索引** (`GIT_INDEX_FILE`), `read-tree HEAD` 打底,
 * `git add` 把工作区 (含未跟踪文件) 收进去, `write-tree` + `commit-tree -p HEAD` 得到基线 commit。
 * **主工作区的索引一个字节不动** —— 所有写都落在那个临时文件上。
 *
 * 排除名单复用 `writeset/disk-delta` 的 `DERIVED_DIRS` (`.omd` / `__pycache__` / `node_modules` …):
 * 派生物进快照 = 每棵树各带一份垃圾。名单只有一个出处, 两处不各写一份。
 *
 * ⚠ 仍在名单外的边界: `.gitignore` 挡掉的文件不进快照 (`git add` 按设计不收), 与 head 档下
 * 那些文件本来就不该被当作产物一致。
 *
 * 证伪方式 (fanout-impl.test.ts): 快照改回 `git stash create` ⇒「未跟踪的新文件也进快照」当场红;
 * 去掉 `GIT_INDEX_FILE` 让 `git add` 打进主索引 ⇒「主工作区的索引一个字节不动」当场红;
 * 改成从 `HEAD` 建树 ⇒「树里看得见未提交改动」当场红;
 * 去掉 `captureAttemptDiff` 里的 `git add -A` ⇒「新建文件进 diff」当场红;
 * 把 `git apply` 的退出码当恒 0 ⇒「冲突时主工作区不变」当场红。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger';
import { ensureDeclaredEnvFiles, ensureNodeModulesLinks } from '../run-worktree';
import { DERIVED_DIRS } from '../writeset/disk-delta';
import type { ModelUsage } from '../../model/types';

/**
 * 起一条子进程的注入面 (测试要能换掉真 git)。`stdin` 只有 `git apply` 用得上;
 * `env` 只有快照那几条用得上 (`GIT_INDEX_FILE` 指向临时索引 —— 主索引一个字节不动)。
 */
export type SpawnLike = (
  args: readonly string[],
  opts: { cwd: string; stdin?: string; env?: Record<string, string> },
) => { exitCode: number; stdout: string; stderr: string };

const defaultRun: SpawnLike = (args, opts) => {
  const r = Bun.spawnSync(args as string[], {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    ...(opts.stdin !== undefined ? { stdin: Buffer.from(opts.stdin) } : {}),
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
  const dec = new TextDecoder();
  return { exitCode: r.exitCode ?? -1, stdout: dec.decode(r.stdout), stderr: dec.decode(r.stderr) };
};

/** 一份实装尝试的全部事实。`exitCode: null` = 判据死于信号 (跑了但没判词), 与 0 / 非 0 是三件事。 */
export interface FanoutAttempt {
  index: number;
  worktree: string;
  exitCode: number | null;
  failing: number;
  diff: string;
  usage?: ModelUsage;
}

/** 择优结论。`by` 说的是**谁选的**, `noGreen` 说的是**有没有人过判据** —— 两位分开读。 */
export interface FanoutChoice {
  chosen: number;
  by: 'only-green' | 'verifier' | 'least-failures';
  reason?: string;
  noGreen: boolean;
}

/** D-1 的档位: 只认 2..4, 其余 (含缺席 / 空 / 非数 / 1 / 5) 一律不扇出。 */
export const FANOUT_MIN = 2;
export const FANOUT_MAX = 4;

/**
 * `OMD_WORK_FANOUT` 的解析。**缺席 = 关**, 不是 0 —— 返回 `undefined` 而不是数字,
 * 调用方据此走「一个字节都不变」的老路径 (INV-1)。
 */
export function parseFanoutN(raw: string | undefined): number | undefined {
  const t = raw?.trim();
  if (!t || !/^\d+$/.test(t)) return undefined;
  const n = Number.parseInt(t, 10);
  return n >= FANOUT_MIN && n <= FANOUT_MAX ? n : undefined;
}

/** 扇出树的落点 —— 与 `run-worktree.ts` 的 `.omd/runs/` 平行, 各占各的前缀。 */
export const fanoutWorktreeDir = (root: string, stamp: string, index: number): string =>
  join(root, '.omd', 'fanout', `${stamp}-${index}`);

/**
 * 排除名单 → git pathspec。`:(exclude,glob)` 的双星跨目录匹配, 所以每个名字来两条形态:
 * 一条钉顶层的那份, 一条钉任意深度的那份 (只写顶层那条会漏掉 `apps/web` 里的同名目录)。
 * `.pyc` / `.pyo` / `.egg-info` 单列 —— 它们是文件后缀, 不是目录名。
 */
function snapshotExcludes(): string[] {
  const out: string[] = [];
  for (const d of DERIVED_DIRS) {
    out.push(`:(exclude,glob)${d}/**`, `:(exclude,glob)**/${d}/**`);
  }
  out.push(':(exclude,glob)**/*.pyc', ':(exclude,glob)**/*.pyo', ':(exclude,glob)**/*.egg-info/**');
  return out;
}

/**
 * 扇出基线 = **当前工作区** (含未跟踪的新文件) 的一个 commit 对象。见头注「快照为什么走临时索引」。
 *
 * 四步全在临时索引上做, 主索引一个字节不动:
 *   `read-tree HEAD` → `add .` (带排除 pathspec) → `write-tree` → `commit-tree -p HEAD`。
 *
 * 快照树与 HEAD 的树相同 (干净仓) ⇒ 直接返回 HEAD, 不白造一个悬空 commit 对象。
 */
function snapshotBase(root: string, git: (args: string[], env?: Record<string, string>) => string): string {
  const head = git(['rev-parse', 'HEAD']);
  const dir = mkdtempSync(join(tmpdir(), 'omd-fanout-idx-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    git(['read-tree', 'HEAD'], env);
    // `add .` 而不是 `add -A`: 两者在带路径 pathspec 时等价 (git ≥ 2.0 都收新增/修改/删除),
    // 而本仓的 git 守卫按字面拦 `add -A` —— 用等价的写法省掉一条永远要解释的例外。
    git(['add', '.', ...snapshotExcludes()], env);
    const tree = git(['write-tree'], env);
    if (tree === git(['rev-parse', 'HEAD^{tree}'])) return head;
    return git(['commit-tree', tree, '-p', head, '-m', 'omd fanout snapshot (临时索引, 主索引未动)'], env);
  } finally {
    // 临时索引是本函数自己造的垃圾, 不论成不成都得删 (它在 tmpdir 里, 与仓无关)。
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 建 N 棵隔离树 (D-2)。返回它们的目录与**共同基线** —— 后面的 diff 与合回都相对这个基线算。
 *
 * **建不起来就抛**, 不退回主树: 退回等于把 N 份尝试全写进同一个工作区, 那比不扇出坏得多
 * (互相覆盖, 且事后分不清哪个字节是谁写的)。调用方接住这一抛, 退回单份派发并记账。
 */
export function planFanoutWorktrees(
  root: string,
  n: number,
  opts: { run?: SpawnLike; stamp?: string } = {},
): { worktrees: string[]; base: string } {
  const run = opts.run ?? defaultRun;
  const git = (args: string[], env?: Record<string, string>): string => {
    const r = run(['git', ...args], { cwd: root, ...(env ? { env } : {}) });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} 失败 (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
  };
  const base = snapshotBase(root, git);
  const stamp = opts.stamp ?? `${Date.now().toString(36)}`;
  mkdirSync(join(root, '.omd', 'fanout'), { recursive: true });
  const worktrees: string[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const dir = fanoutWorktreeDir(root, stamp, i);
      git(['worktree', 'add', '--detach', dir, base]);
      worktrees.push(dir);
      // 干净 checkout 缺 node_modules / gitignore 的 env 文件 —— 判据在树里跑不起来就全员恒红,
      // 择优退化成随机。两条都 fail-open 且经返回值留证据 (与 run-worktree.ts 同款)。
      for (const { rel, result } of ensureNodeModulesLinks(root, dir)) {
        if (String(result).startsWith('link-failed')) logger.warn({ dir, rel, result }, '[fanout] node_modules 链入失败 (树内判据可能环境性红)');
      }
      for (const { rel, result } of ensureDeclaredEnvFiles(root, dir)) {
        if (result !== 'copied') logger.warn({ dir, rel, result }, '[fanout] 声明的 env 文件未生效 (树内需要它的命令会起不来)');
      }
    }
  } catch (err) {
    // 半途失败: 已建的先拆干净再把原文抛出去 —— 留一堆半成品 worktree 比失败本身更难查。
    logger.warn({ root, built: worktrees.length, err: String(err).slice(0, 300) }, '[fanout] 建隔离树中途失败 → 拆掉已建的, 退回单份路径');
    disposeFanoutWorktrees(root, worktrees, { run });
    throw err;
  }
  logger.info({ root, n, base, worktrees }, '[fanout] N 棵隔离树已建 (基线 = 当前已跟踪改动的快照)');
  return { worktrees, base };
}

/**
 * 拆掉扇出树。**永不抛** —— 它跑在 `finally` 里, 拆不掉不该盖住真正的失败;
 * 但每条失败都留原文, 且退到 `rmSync` 再试一次 (盘上残留会让下一次 `worktree add` 撞名)。
 */
export function disposeFanoutWorktrees(root: string, worktrees: readonly string[], opts: { run?: SpawnLike } = {}): void {
  const run = opts.run ?? defaultRun;
  for (const dir of worktrees) {
    const r = run(['git', 'worktree', 'remove', '--force', dir], { cwd: root });
    if (r.exitCode === 0) continue;
    logger.warn({ dir, exitCode: r.exitCode, err: (r.stderr || r.stdout).trim().slice(0, 300) }, '[fanout] git worktree remove 失败 → 退到 rmSync');
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ dir, err: String(err).slice(0, 300) }, '[fanout] rmSync 也没删掉 (盘上会有残留树)');
    }
  }
  if (worktrees.length > 0) {
    const p = run(['git', 'worktree', 'prune'], { cwd: root });
    if (p.exitCode !== 0) logger.warn({ root, err: (p.stderr || p.stdout).trim().slice(0, 200) }, '[fanout] git worktree prune 失败 (元数据残留)');
  }
}

/**
 * 一棵树相对基线的 diff (D-4 合回的那份字节)。
 *
 * **先 `git add -A` 再 `diff --cached`**: 未跟踪的新文件不进 `git diff <base>`, 而实装尝试
 * 新建文件是常态 —— 少了这一跳, 赢家里"新写的那个文件"会在合回时凭空消失。
 * 扇出树跑完即弃, 在里面动索引没有代价。
 *
 * fail-open 且留证据: 取不到返回空串, 调用方按「这份不可用」处理 (空 diff 在 `applyWinner` 里被拒)。
 */
export function captureAttemptDiff(worktree: string, base: string, opts: { run?: SpawnLike } = {}): string {
  const run = opts.run ?? defaultRun;
  const add = run(['git', 'add', '-A'], { cwd: worktree });
  if (add.exitCode !== 0) {
    logger.warn({ worktree, err: (add.stderr || add.stdout).trim().slice(0, 300) }, '[fanout] git add -A 失败 → 新建文件可能不进 diff');
  }
  const d = run(['git', 'diff', '--binary', '--cached', base], { cwd: worktree });
  if (d.exitCode !== 0) {
    logger.warn({ worktree, base, err: (d.stderr || d.stdout).trim().slice(0, 300) }, '[fanout] git diff 取不到 → 这份尝试没有可合回的字节');
    return '';
  }
  return d.stdout;
}

/**
 * 判词里的**失败用例数** (D-3 ① 的第二个数)。
 *
 * 数得出来就用数出来的 (`2 fail` / `4 failed` 这类各家 runner 的摘要行);
 * 数不出来时**不编中间值**: 绿 = 0, 红 = 1。`exitCode === null` (死于信号) 与红同档 ——
 * 没跑完不是"零个失败"。
 */
export function countFailingCases(text: string, exitCode: number | null, expectExit = 0): number {
  const m = /(\d+)\s+(?:fail(?:ed|ing|ures?)?)\b/i.exec(text ?? '');
  if (m) {
    const n = Number.parseInt(m[1]!, 10);
    if (Number.isFinite(n)) return n;
  }
  return exitCode === expectExit ? 0 : 1;
}

/**
 * 打分 (D-3 ①②)。两列各自独立:
 *  · `green` = 判据退出码等于期望值的号 (只有它们够格进比较卷);
 *  · `ranked` = **全部**尝试按 (失败用例数升序, 同数按号) 排的名次 —— 零份绿时的兜底与
 *    合回冲突时的次优都从这一列取。
 *
 * `expectExit` 是可选第二参 (契约签名只写了 attempts): 判据可以约定非零期望
 * (`accept` 节点的 `expect_exit`), 把它写死成 0 会把那一族判据全读成红。
 */
export function scoreAttempts(attempts: readonly FanoutAttempt[], expectExit = 0): { green: number[]; ranked: number[] } {
  const green = attempts.filter((a) => a.exitCode !== null && a.exitCode === expectExit).map((a) => a.index);
  const ranked = [...attempts].sort((a, b) => a.failing - b.failing || a.index - b.index).map((a) => a.index);
  return { green, ranked };
}

/**
 * 择优 (D-3)。三条出口, 每条都说得出**是谁选的**:
 *  · 恰 1 份绿 → `only-green` (**不调判官** —— 没有可比的第二份, 那一次调用买不到信息);
 *  · ≥2 份绿 → 交比较卷一次 → `verifier`;
 *  · 0 份绿 / 没有判官 / 判官抛错 / 判官点了绿名单外的号 → `least-failures`。
 *
 * 判官**只在绿的里面选**: 让它有权选一份没过判据的, 等于把「执行侧改不了的判据」这条前提
 * 交回给一个模型 —— 那正是整个扇出的收益来源。点名越界即作废, 退机械档。
 */
export async function chooseAttempt(
  attempts: readonly FanoutAttempt[],
  compare?: (green: FanoutAttempt[]) => Promise<{ index: number; reason: string }>,
  expectExit = 0,
): Promise<FanoutChoice> {
  const { green, ranked } = scoreAttempts(attempts, expectExit);
  const leastOf = (pool: readonly number[]): number => ranked.find((i) => pool.includes(i)) ?? ranked[0] ?? 0;
  if (green.length === 0) return { chosen: leastOf(ranked), by: 'least-failures', noGreen: true };
  if (green.length === 1) return { chosen: green[0]!, by: 'only-green', noGreen: false };
  if (compare) {
    const pool = attempts.filter((a) => green.includes(a.index));
    try {
      const picked = await compare(pool);
      if (green.includes(picked.index)) return { chosen: picked.index, by: 'verifier', reason: picked.reason, noGreen: false };
      logger.warn({ picked: picked.index, green }, '[fanout] 比较卷点了绿名单外的号 → 作废, 退 least-failures');
    } catch (err) {
      // fail-open 吞异常不吞证据: 判官坏了不该把整次扇出带塌, 但原文要出得来。
      logger.warn({ green, err: String(err).slice(0, 300) }, '[fanout] 比较卷抛错 → 退 least-failures');
    }
  }
  return { chosen: leastOf(green), by: 'least-failures', noGreen: false };
}

/**
 * 合回 (D-4): 把赢家相对基线的 diff `git apply` 到主工作区。
 *
 * **打不上去不是错误, 是这份尝试不可用** —— 返回 `applied:false` + git 原文, 调用方退次优。
 * `git apply` 默认全有全无 (任一 hunk 冲突即整份不落), 所以失败时主工作区一个字节不变。
 * 空 diff 单独一条判词: 「什么都没改」不许被读成「合回成功」。
 */
export function applyWinner(
  root: string,
  attempt: FanoutAttempt,
  opts: { run?: SpawnLike } = {},
): { applied: boolean; why?: string } {
  if (!attempt.diff) return { applied: false, why: `尝试 #${attempt.index} 的 diff 是空的 (它相对基线一个字节都没改)` };
  const run = opts.run ?? defaultRun;
  const r = run(['git', 'apply', '--whitespace=nowarn', '-'], { cwd: root, stdin: attempt.diff });
  if (r.exitCode === 0) {
    logger.info({ root, index: attempt.index, bytes: attempt.diff.length }, '[fanout] 赢家 diff 已合回主工作区');
    return { applied: true };
  }
  const why = `git apply 打不上去 (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
  logger.warn({ root, index: attempt.index, why }, '[fanout] 赢家 diff 与主工作区冲突 → 退次优');
  return { applied: false, why };
}
