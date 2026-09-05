/**
 * **run 级 branch strategy** (2026-07-31, R2 · 承 D-Y① sandcastle + D-AB 可逆性分级 + §7.2)。
 *
 * ## 它填的是哪个洞
 *
 * D-AB 把自主度按「做错了的代价和可逆性」分了四级, 其中「范围内写」那一级的理由是
 * **git 就是 rollback**。但那句话今天在 omd 里是**假的**: agent leaf 直接写 cwd, detached worker
 * 也直接写 cwd —— `scope` 有声明面, **执行面没有对应物**。写坏了没有"这次跑的东西"这个对象,
 * 也就无从回滚。Automation Readiness 第 6 条记的 🟡 说的就是它。
 *
 * §7.2 的形状是现成的: git worktree 让每个执行体有自己的工作目录, **同时共享同一份提交历史**。
 * 本仓也已经有一处实现(pathfinder 的 prototype 票, `dispatch.ts`)—— 所以这里不造第二套机制,
 * 造的是**把它抬到 run 级**的那一层。
 *
 * ## 三态里我们只做两态, 第三态刻意不做
 *
 * sandcastle 的 branch strategy 是 `head` / `merge-to-head` / `branch`。
 *
 * | 态 | 语义 | 我们 |
 * |---|---|---|
 * | `head` | 直接写当前工作树 | ✅ 缺省(**零回归**: 不传就是今天的行为) |
 * | `branch` | 隔离 worktree + 独立分支, 产出留在那儿 | ✅ 本次做 |
 * | `merge-to-head` | 跑完自动合回主树 | ❌ **刻意不做** |
 *
 * **为什么不做 `merge-to-head`**: 自动合回主树是一次**写主干**, 按 D-AB 的可逆性分级那是
 * "需批准"那一档, 不是"范围内写"。而且它与本仓已定的一条纪律同形 —— `path_deliver` 把
 * "裁决"与"重跑"拆成两个决定, 回话给命令由 owner 扣扳机。自动合回等于替 owner 扣了扳机,
 * 而这正是隔离想避免的那件事。合不合、什么时候合, 留给 owner 一条 `git merge`。
 *
 * ## 诚实边界
 *
 * - **不在 git 仓里 → 退回 `head` 并响亮说明**, 不抛。goal 引擎跑在别人的目录里是正常用法,
 *   为了隔离而拒绝跑起来是本末倒置。
 * - **worktree 默认不自动清理**。试验的意义是可弃, 但"可弃"≠"替你弃了" —— 跑完那棵树里就是
 *   这次的全部产出, 自动删掉等于把交付物一起删了。回话里给出目录与分支, 弃用走 `dispose()`。
 * - **未提交的改动不会被带进 worktree**。`git worktree add` 出来的是**该 ref 的干净 checkout**;
 *   主树上没提交的东西在那边看不见。这是隔离的定义, 但用的人容易惊讶, 所以写在这里。
 */
import type { Dirent } from 'node:fs';
import { existsSync, readdirSync, symlinkSync, mkdirSync, readlinkSync, copyFileSync} from 'node:fs';
import { join, isAbsolute, dirname} from 'node:path';
import { logger } from './logger';
import { resolveRepoEnv } from './hooks/repo-env';
import { captureRollbackAnchor, type RollbackAnchor } from './writeset/rollback-anchor';
import { isDeliveredOutcome } from './run-outcome';

export type BranchStrategy = 'head' | 'branch';

export interface RunWorktree {
  /** 执行体该用的工作目录(`head` 档 = 原 cwd)。 */
  cwd: string;
  /** 隔离档才有: 分支名。 */
  branch?: string;
  /** 实际生效的策略 —— **可能与请求的不同**(不在 git 仓里会退回 `head`)。 */
  strategy: BranchStrategy;
  /** 退回 `head` 的原因(生效即请求时为 undefined)。 */
  degradedReason?: string;
  /**
   * **起跑时主树上有未提交的东西**(2026-08-06)—— 隔离档才有,且**必须念进回话**。
   *
   * `git worktree add` 出来的是**该 ref 的干净 checkout**:主树上没提交的改动在那边**看不见**。
   * 头注早就写了这条边界,可它只写在头注里 —— **调用它的 owner 在回话里一个字都看不到**。
   * 于是「带着未提交的活起一次隔离跑」会**静默**地从 HEAD 开始:agent 看不见你刚写的东西,
   * 可能把它重做一遍、或者基于旧版本给出结论,而回话只说"隔离成功"。
   *
   * ⚠ **fail-open,不拒**:隔离是加固不是前置条件(同 `degradedReason` 那条)。这一位只保证
   *   下次看得见 —— 但它必须进 `describeRunWorktree`,否则和写在头注里没有区别。
   */
  uncommittedWarning?: string;
  /**
   * **resume 复用时 run 分支落后主仓 HEAD**(#168 候选①, 2026-08-18)—— 只读检测, 只警告。
   * 现场 (run 20984d68): 首攻根因在主树修掉后 resume, 复用路原样接旧树, 修补不在树里,
   * 冻结判据带全量环仍撞同一条已修的红 —— 而这件事此前盘上无痕、回执不报。
   * `undefined` = 不落后 / 分叉 / 检测失败 —— **任何不确定都不说话, 更不代合**
   * (候选②自动 cherry-pick 刻意不做: 可能冲掉树内未提交产物, 且替 owner 扣扳机)。
   */
  behindWarning?: string;
  /** 弃用这棵树(`head` 档 = 空操作)。**不自动调**,见头注。 */
  dispose: () => void;
}

export interface RunWorktreeDeps {
  /** 跑一条 git 命令; 非零退出即抛。默认 `Bun.spawnSync('git', …)`。 */
  git?: (args: string[], opts: { cwd: string }) => void;
  /** 判断某目录是不是 git 工作树。默认查 `.git` 是否存在。 */
  isGitRepo?: (cwd: string) => boolean;
  /** 查主树上有没有未提交的东西(见 `RunWorktree.uncommittedWarning`)。默认 `captureRollbackAnchor`。 */
  checkTree?: (cwd: string) => RollbackAnchor;
  /** #166/#174: worktree 内链入主树 node_modules(仓根 + 一级子包)。默认 `ensureNodeModulesLinks`(测试注入面)。 */
  ensureLink?: typeof ensureNodeModulesLinks;
  /**
   * #168: **读类** git 查询(返回 stdout; 非零退出抛错)。与 `git` 分开: 那个管"建/删"等
   * 写语义命令, 这个管 `merge-base --is-ancestor` / `rev-list --count` 这类要读输出的查询
   * (`--is-ancestor` 退 1 = 分叉, 以抛错表达, `detectBehind` 收成 speak-not)。默认 `defaultGitOut`。
   */
  gitOut?: (args: string[], opts: { cwd: string }) => string;
}

/** 默认 git: 非零退出即抛(建/删 worktree 失败必须显性, 悄悄退回 head 会让隔离静默失效)。 */
function defaultGit(args: string[], opts: { cwd: string }): void {
  const r = Bun.spawnSync(['git', ...args], { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败 (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
  }
}

// ── #202 (2026-08-19, 承 #200 裁决): 产物到主树了吗 ────────────────────────────

/**
 * 一次 run 的产物**落地状态**。**三值不是布尔** —— NULL≠0 那条铁律压在这里:
 *  · `landed`         分支已是主干的祖先 = 这些字节真在 main 里;
 *  · `awaiting-merge` 分支在, 但没合 = 活做完了、产物已收编, **等人合**;
 *  · `no-branch`      分支不存在 = head 档(产物本就写在主树)或分支已被删。
 *    **这一格既不是"已合入"也不是"没合"**, 编成任一个都是拿猜当事实; 由调用方按它知道的
 *    策略决定怎么读 (settleRunTicket 知道 strategy, reflow 不知道 —— 两处各自表态, 见各自注)。
 */
export type RunLanded = 'landed' | 'awaiting-merge' | 'no-branch';

/**
 * 这次 run 的分支合进主干了没有 (#200 D1: `delivered` 锚在**已合入**, 不锚 run 自称 success)。
 *
 * **判据就是退出码**: `git merge-base --is-ancestor <branch> <main>` 退 0 = 是祖先。不解析 stdout ——
 * 它没有 stdout, 而拿 `git branch --merged` 的文本去匹配分支名会被同名前缀坑 (`omd/run/abc` 与
 * `omd/run/abcd`)。
 *
 * **为什么这条判得准**: 2026-08-19 实测四个分支全对 —— 当天合进 main 的 `3e5f7e94` / `06f0e996` /
 * `657f6804` 报 landed, 而 checkpoint 明写「留档不并」的 `dbfe0c66` 报 awaiting-merge。#200 票面
 * 原本假设「合主树是人做的, 引擎无从知道」, 这条实测把那个前提证伪了。
 *
 * ★ 反向自检 (已实测会红): 把 `=== 0` 改成恒 true → `run-landed.test.ts` 的 awaiting-merge 那条红。
 */
export function runBranchLanded(
  runId: string,
  opts: { cwd: string; mainRef?: string },
  deps: { gitExit?: (args: string[], cwd: string) => number } = {},
): RunLanded {
  const gitExit =
    deps.gitExit ??
    ((args: string[], cwd: string): number =>
      Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' }).exitCode);
  const branch = runWorktreeBranch(runId);
  // 先问分支在不在: 不在时 `merge-base` 也会非零退出, 而那与"在但没合"是两件事 (NULL≠0)。
  if (gitExit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], opts.cwd) !== 0) return 'no-branch';
  return gitExit(['merge-base', '--is-ancestor', branch, opts.mainRef ?? 'main'], opts.cwd) === 0
    ? 'landed'
    : 'awaiting-merge';
}

/**
 * `.git` 存在即当 git 工作树。**不用 `git rev-parse`** —— 那要起一个进程, 而这个判断在
 * 每次 goal 起跑时都要做一遍; 而且 worktree 里的 `.git` 是个文件不是目录, `existsSync` 两者都认。
 */
const defaultIsGitRepo = (cwd: string): boolean => existsSync(join(cwd, '.git'));

/** 这次 run 的隔离目录 —— 与 pathfinder 的 `proto/` 平行, 各占各的前缀。 */
export const runWorktreeDir = (cwd: string, runId: string): string => join(cwd, '.omd', 'runs', safe(runId));
/** 这次 run 的分支名。`omd/run/` 前缀让它在 `git branch` 里一眼可辨、也好批量清。 */
export const runWorktreeBranch = (runId: string): string => `omd/run/${safe(runId)}`;

const safe = (s: string): string => s.replace(/[^\w.-]/g, '_');

/** 默认读类 git: 非零退出抛错, 返回 stdout(与 `commitRunArtifacts` 的内置 gitOut 同形)。 */
function defaultGitOut(args: string[], opts: { cwd: string }): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败 (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
  }
  return new TextDecoder().decode(r.stdout).trim();
}

/**
 * #168 候选① — resume 复用路的**只读**落后检测。
 *
 * 两步: `merge-base --is-ancestor <branch> HEAD`(退 1 = 分叉 → speak-not)→
 * `rev-list --count <branch>..HEAD`(≤0 / 解析失败 → speak-not)。任何不确定都返回
 * `undefined`, **绝不据此起任何写语义命令**(候选②红线)。
 *
 * cherry-pick 建议在**隔离树里**挑(`git -C <dir>`), 不在主仓 —— 方向反了会把补丁
 * 挑到 main 上(run 87e43ded 的 M3 产出犯的就是这个错, 人工收尾时修正)。
 */
function detectBehind(
  cwd: string,
  dir: string,
  branch: string,
  gitOut: (args: string[], opts: { cwd: string }) => string,
): string | undefined {
  try {
    gitOut(['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd });
    const n = Number.parseInt(gitOut(['rev-list', '--count', `${branch}..HEAD`], { cwd }), 10);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    const head = gitOut(['rev-parse', '--short', 'HEAD'], { cwd });
    return (
      `⚠ run 分支 ${branch} 落后主仓 HEAD ${n} 个 commit —— 主树后来的修补在这棵树里**看不见** (#168)。` +
      `要带上它们: \`git -C ${dir} cherry-pick ${branch}..${head}\`(在隔离树里挑, 冲突即停, 引擎不代合)。`
    );
  } catch {
    // 分叉 / 命令失败 → speak-not: 不确定就不说话(说错方向的警告比沉默更坏)。
    return undefined;
  }
}

/**
 * #166 (2026-08-17): worktree 内链入主树 node_modules。
 *
 * `git worktree add` 出来的是干净 checkout —— 没有 node_modules。bun 的模块解析能沿父目录
 * 走到主树那份 (worktree 在主仓 `.omd/runs/` 之内), 但**显式路径读包文件的测试走不了解析**
 * (实测 run 5fd13a78: pi-event-coverage 用 `readFileSync(join(REPO_ROOT, 'node_modules/…'))`
 * → ENOENT 3 红, 冻结判据带全量环在 branch 档结构性永不可绿)。symlink 是 monorepo 惯例解:
 * 零安装成本, `worktree remove --force` 时随树删 (删的是链接不是真身)。
 * fail-open: 主树没有 node_modules / 树内已有 / 链接失败 → 各自跳过, 隔离照常成立 ——
 * 链接是加固不是前置条件, 但每格都留证据 (返回值进日志)。
 */
export function ensureNodeModulesLink(
  mainRoot: string,
  worktreeDir: string,
  link: (target: string, path: string) => void = (t, p) => symlinkSync(t, p, 'dir'),
): 'linked' | 'no-source' | 'already-present' | `link-failed: ${string}` {
  const source = join(mainRoot, 'node_modules');
  const dest = join(worktreeDir, 'node_modules');
  if (!existsSync(source)) return 'no-source';
  if (existsSync(dest)) return 'already-present';
  try {
    mirrorNodeModules(source, dest, link);
    return 'linked';
  } catch (e) {
    return `link-failed: ${(e as Error).message.slice(0, 200)}`;
  }
}

/**
 * 逐条镜像一份 node_modules(#205-ter, 2026-09-04 plana 实账 · 第四个 bug)。
 *
 * ## 为什么不能整目录 symlink
 *
 * `<wt>/node_modules` 若是指向主树那份的整目录软链, 则
 * `<wt>/node_modules/@plana/domain` → 主树的 `@plana/domain` → `../../packages/domain`
 * (相对**主树**) → `/主repo/packages/domain` —— **jail 里按设计不可见**(反 oracle 作弊那条),
 * tsc 报 `Cannot find module '@plana/domain'`。
 * **workspace 内部包的解析经过的是指向主树源码的软链, 而主树源码正是 jail 要藏起来的东西。**
 * 叶子跑 `npm install` 自救是**对的** —— 那次 install 正是把这些链改写成指向 worktree。
 *
 * ## 办法: 相对目标**逐字照抄**, 它自己会重定基
 *
 * · 条目是软链且目标是**相对**路径 → 照抄目标串。`../../packages/domain` 在新位置自然解析到
 *   `<wt>/packages/domain` —— workspace 内部包**自动**指回本树, 不需要认识"哪些是内部包"。
 * · 条目是软链且目标是绝对路径 → 照抄(它指的是真身, 与在哪棵树无关)。
 * · 条目是真目录/文件 → 软链到**主树的绝对路径**(真依赖的真身在那儿; 主树 node_modules
 *   由 `collectNodeModules` 一并绑进 jail)。
 *
 * scope 目录(`@…`)只在**含相对软链时**才下钻一层 —— 实测 plana 主树 733 个顶层条目里
 * 相对软链**零条**, 只有 `@plana` 一个 scope 目录里有 6 条。不含就整目录照链, 省掉几千次 IO。
 *
 * 实测成本: 733 条软链 0,86 秒。
 */
function mirrorNodeModules(source: string, dest: string, link: (target: string, path: string) => void): void {
  // 刻意**不** recursive: 父目录缺席(子包未进 checkout)要保持原来的 link-failed 记账,
  // 而不是凭空造一个没人会 import 的空 node_modules —— 那会把"这个子包不在树里"这条信息吞掉。
  mkdirSync(dest);
  for (const e of readdirSync(source, { withFileTypes: true, encoding: 'utf8' })) {
    const src = join(source, e.name);
    const dst = join(dest, e.name);
    if (e.isSymbolicLink()) {
      link(readlinkSync(src), dst); // 相对目标照抄 = 自动重定基; 绝对目标原样有效
      continue;
    }
    if (e.isDirectory() && e.name.startsWith('@') && scopeHasRelativeLink(src).hasRelative) {
      mirrorNodeModules(src, dst, link); // 只有这一层需要下钻
      continue;
    }
    link(src, dst);
  }
}

/**
 * scope 目录里有没有**相对**软链 —— 有才值得下钻(见 {@link mirrorNodeModules})。
 * 读不动时 `err` 经返回值交出去且判 true(宁可多做一层, 也好过把 workspace 链漏成指向主树)。
 */
function scopeHasRelativeLink(scopeDir: string): { hasRelative: boolean; err?: string } {
  let entries: Dirent[];
  try {
    entries = readdirSync(scopeDir, { withFileTypes: true, encoding: 'utf8' });
  } catch (e) {
    return { hasRelative: true, err: (e as Error).message };
  }
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue;
    if (!isAbsolute(readlinkSync(join(scopeDir, e.name)))) return { hasRelative: true };
  }
  return { hasRelative: false };
}

/**
 * 找出 mainRoot 下**自己带 node_modules** 的子包目录 (相对路径), 深度上限 maxDepth。
 *
 * ⚠ 为什么不能只扫一级 (#205-bis, 2026-09-04 plana 实账): `apps/*` + `packages/*` 是最常见的
 * npm workspaces 约定, 子包在**第二级**。一级扫描只看 `apps/node_modules` (不存在) 就跳过,
 * worktree 里 `apps/web/node_modules` 整个缺席。#174 的原注说"更深的路径由模块解析沿父目录兜底"
 * —— 对提升进子包的依赖**兜不到**: `apps/web/src/**` 解析 `@hookform/resolvers` 时沿父目录走到
 * 仓根那份, 而 npm 恰恰把它提升进了 `apps/web/node_modules`。
 *
 * 自带 node_modules 的目录**不再下钻** (它的子包会在它自己那份里解析)。
 */
function findPackageDirsWithNodeModules(
  mainRoot: string,
  maxDepth = 2,
): { dirs: string[]; scanErrors: Array<{ rel: string; err: string }> } {
  const out: string[] = [];
  const scanErrors: Array<{ rel: string; err: string }> = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(rel ? join(mainRoot, rel) : mainRoot, { withFileTypes: true, encoding: 'utf8' });
    } catch (e) {
      // fail-open 但不吞证据: 这一支扫不动, 别的支照旧, 原因经返回值交给调用方记账。
      scanErrors.push({ rel: rel || '.', err: (e as Error).message });
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (existsSync(join(mainRoot, childRel, 'node_modules'))) {
        out.push(childRel);
        continue; // 自带一份 → 不下钻
      }
      walk(childRel, depth + 1);
    }
  };
  walk('', 1);
  return { dirs: out, scanErrors };
}

/**
 * #174 (2026-08-18): #166 只链了仓根, 而子包 (本仓 web/) 有**自己的** node_modules ——
 * 隔离 run 里 `web/src/**.tsx` 解析 `react/jsx-dev-runtime` 走的是 `web/node_modules`,
 * 缺了就每个 branch 档 accept 确定性红 ×4 (run a828a672 / 60f58f3f 连撞)。
 *
 * #205-bis (2026-09-04): 扫描深度从一级放到两级 —— 理由见 {@link findPackageDirsWithNodeModules}。
 * 子目录在 worktree 里缺席 (未跟踪目录不进 checkout) → symlink ENOENT → 记 link-failed,
 * 不抛 (fail-open, 证据在返回值里)。
 */
export function ensureNodeModulesLinks(
  mainRoot: string,
  worktreeDir: string,
  link?: (target: string, path: string) => void,
): Array<{ rel: string; result: ReturnType<typeof ensureNodeModulesLink> }> {
  const out: Array<{ rel: string; result: ReturnType<typeof ensureNodeModulesLink> }> = [
    { rel: '.', result: ensureNodeModulesLink(mainRoot, worktreeDir, link) },
  ];
  try {
    const { dirs, scanErrors } = findPackageDirsWithNodeModules(mainRoot);
    for (const rel of dirs) {
      out.push({ rel, result: ensureNodeModulesLink(join(mainRoot, rel), join(worktreeDir, rel), link) });
    }
    // 中途扫不动的支也要留痕 —— 此前它是完全不可见的 (少链一份子包而没人知道为什么)。
    for (const se of scanErrors) {
      out.push({ rel: `(scan ${se.rel})`, result: `link-failed: 子包扫描失败: ${se.err.slice(0, 200)}` });
    }
  } catch (e) {
    // fail-open 吞异常不吞证据: 扫不了主树目录 → 仓根那条照样生效, 失败原文进结果。
    out.push({ rel: '(scan)', result: `link-failed: 子包扫描失败: ${(e as Error).message.slice(0, 200)}` });
  }
  return out;
}

/**
 * 把本仓**显式声明**的 env 文件(`.omd/config.json` 的 `env.files`)拷进隔离 worktree。
 *
 * 为什么必须拷:那些文件按定义是 gitignore 的,而 `git worktree add` 出来的树**只有 git 认识的
 * 文件** —— 于是需要它们的命令(起 dev server、连数据库、跑驱动式审查)在隔离树里直接起不来,
 * 症状看起来像"这仓本来就跑不通"。同 `ensureNodeModulesLinks` 的位置与理由。
 *
 * ⚠ **拷不是链**:link 会让隔离树里的写穿回主树(env 文件常被工具改写)。
 * ⚠ 路径边界由 {@link resolveRepoEnv} 判死(相对 + 不许 `..`),这里不再二次开口。
 */
export function ensureDeclaredEnvFiles(
  mainRoot: string,
  worktreeDir: string,
  deps: { copy?: (src: string, dest: string) => void; mkdir?: (p: string) => void } = {},
): Array<{ rel: string; result: 'copied' | string }> {
  const copy = deps.copy ?? ((src: string, dest: string) => copyFileSync(src, dest));
  const mkdir = deps.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const spec = resolveRepoEnv(mainRoot);
  const out: Array<{ rel: string; result: 'copied' | string }> = [];
  for (const rel of spec.files) {
    const dest = join(worktreeDir, rel);
    try {
      mkdir(dirname(dest));
      copy(join(mainRoot, rel), dest);
      out.push({ rel, result: 'copied' });
    } catch (e) {
      // fail-open 吞异常不吞证据: 一个文件拷不动不该掀掉整次 run, 但失败原文必须出得来。
      out.push({ rel, result: `copy-failed: ${(e as Error).message.slice(0, 200)}` });
    }
  }
  // 声明了却没生效的(路径被拒 / 盘上没有)必须可见 —— 静默少一个 env 文件正是本函数要治的病。
  for (const m of spec.missing) out.push({ rel: '(declared)', result: `skipped: ${m}` });
  return out;
}

/**
 * 按策略给这次 run 准备工作目录。
 *
 * @param strategy 缺省 `head` —— **不传就是今天的行为**, 零回归。
 */
export function prepareRunWorktree(
  opts: { cwd: string; runId: string; strategy?: BranchStrategy },
  deps: RunWorktreeDeps = {},
): RunWorktree {
  const { cwd, runId } = opts;
  const noop = { cwd, strategy: 'head' as const, dispose: () => {} };
  // ⚠ **续跑不许换树** (2026-08-23, owner 现场报): 盘上已有该 runId 的隔离树 ⇒ 首跑是隔离档,
  // 这次调用没传 `branchStrategy` 只说明**调用方漏传了**, 不说明该写主树。落回 head 会把
  // 半成品与 checkpoint 留在那棵树上、却把这一轮的写打进主工作树 —— **静默换树, 比不隔离更坏**。
  //
  // ⚠ 判据必须在 `strategy === 'head'` 短路**之前** —— 下面那条 `existsSync(dir)` 复用路
  // (2026-08-14 写的) 注释里早就描述了这个危险, 但它在短路之后, 于是**在它要防的那个场景里
  // 恰好不可达**: resume 不传 strategy ⇒ 默认 head ⇒ 函数第三行就返回了。
  //
  // ⚠ 为什么收在这里而不是各调用方: `dag-tools.ts` 的 `resolveRunWorktree` 已经算过同一件事,
  // 而 `goal.ts:670` 没有 —— **一处写了一处漏了, 漏的那处是夜批默认路径 `solve`**。
  // 同一条判据两处各写一份就是本仓反复付账的形态; 收一处, 两个入口都漏不掉。
  //
  // runId 是 UUID ⇒ 那个目录存在只可能因为**同一个 run 之前隔离跑过**, 不存在误判。
  const resumedIsolated = opts.strategy !== 'branch' && existsSync(runWorktreeDir(cwd, runId));
  if (resumedIsolated) {
    logger.warn(
      { runId, dir: runWorktreeDir(cwd, runId), requested: opts.strategy ?? '(缺席)' },
      '[omd/run-worktree] 续跑不许换树: 盘上已有该 runId 的隔离树, 但本次调用没要 branch → **强制 branch** (落回 head 会静默把这一轮的写打进主工作树)',
    );
  }
  const strategy: BranchStrategy = resumedIsolated ? 'branch' : (opts.strategy ?? 'head');
  if (strategy === 'head') return noop;

  const isGitRepo = deps.isGitRepo ?? defaultIsGitRepo;
  if (!isGitRepo(cwd)) {
    const why = `${cwd} 不是 git 工作树 → branch 策略退回 head (隔离不成立, 但活照跑)`;
    logger.warn({ cwd, runId }, `[omd/run-worktree] ${why}`);
    return { ...noop, degradedReason: why };
  }

  const git = deps.git ?? defaultGit;
  const dir = runWorktreeDir(cwd, runId);
  const branch = runWorktreeBranch(runId);
  // resume 复用 (2026-08-14, dag_run 接隔离档时补): 同 runId 的树已在 → 原样接着用。
  // 不复用的话 `worktree add` 会失败 → 走下面的退回 head —— 那是**静默换树**: 首跑写在
  // 隔离树里, resume 却写主树, 比不隔离更坏 (checkpoint 与半成品全在那棵树上)。
  if (existsSync(dir)) {
    logger.info({ runId, dir, branch }, '[omd/run-worktree] 隔离 worktree 已存在 → 复用 (resume)');
    // #166: 老树 (本修复前建的) 可能缺链 —— resume 路也补, 幂等 (already-present 即跳过)。
    for (const { rel, result } of (deps.ensureLink ?? ensureNodeModulesLinks)(cwd, dir)) {
      if (result !== 'already-present') logger.info({ runId, dir, rel, result }, '[omd/run-worktree] #166/#174 node_modules 链入 (resume 复用路)');
    }
    for (const { rel, result } of ensureDeclaredEnvFiles(cwd, dir)) {
      logger.info({ runId, dir, rel, result }, '[omd/run-worktree] 声明的 env 文件拷入 (resume 复用路)');
    }
    // #168 候选①: 只在复用路检测 (新建路刚从 HEAD 建出, 不可能落后)。只警告, 不代合。
    const behindWarning = detectBehind(cwd, dir, branch, deps.gitOut ?? defaultGitOut);
    if (behindWarning) logger.warn({ runId, dir, branch }, `[omd/run-worktree] ${behindWarning}`);
    return {
      cwd: dir,
      branch,
      strategy: 'branch',
      ...(behindWarning ? { behindWarning } : {}),
      dispose: () => {
        try {
          git(['worktree', 'remove', '--force', dir], { cwd });
        } catch (e) {
          logger.warn({ dir, err: String(e) }, '[omd/run-worktree] 弃用 worktree 失败 (fail-open)');
        }
      },
    };
  }
  try {
    git(['worktree', 'add', dir, '-b', branch], { cwd });
  } catch (e) {
    // **建不起来就退回 head 并说清楚**, 不抛: 隔离是加固不是前置条件, 为它把一次跑整个拒掉
    // 是拿可用性换一个本来就是"更好"而非"必须"的性质。⚠ 但必须响亮 —— 静默退回 head 会让
    // 调用方以为写在隔离树里, 而实际上写的是主树, 那比不隔离坏得多。
    const why = `建 worktree 失败 → 退回 head: ${(e as Error).message}`;
    logger.warn({ cwd, runId, dir, branch }, `[omd/run-worktree] ${why}`);
    return { ...noop, degradedReason: why };
  }
  // **未提交的活在隔离树里看不见** —— 头注写了这条边界, 但只写在头注里。这里把它变成
  // 回话里的一句话 (2026-08-06): 带着未提交改动起隔离跑, agent 看到的是 HEAD 那一版,
  // 而回话此前只说"隔离成功"。fail-open, 不拒。
  // #166: 干净 checkout 缺 node_modules → 显式路径读包的测试结构性红 (run 5fd13a78)。链入主树那份
  // (#174: 含一级子包, 如 web/node_modules)。
  for (const { rel, result } of (deps.ensureLink ?? ensureNodeModulesLinks)(cwd, dir)) {
    if (result.startsWith('link-failed')) logger.warn({ runId, dir, rel, result }, '[omd/run-worktree] #166/#174 node_modules 链入失败 (fail-open, 树内测试可能环境性红)');
    else logger.info({ runId, dir, rel, result }, '[omd/run-worktree] #166/#174 node_modules 链入');
  }
  // 本仓声明的 env 文件 (gitignore ⇒ 新树里不会有, 见 ensureDeclaredEnvFiles 的注)。
  for (const { rel, result } of ensureDeclaredEnvFiles(cwd, dir)) {
    if (result === 'copied') logger.info({ runId, dir, rel }, '[omd/run-worktree] 声明的 env 文件拷入');
    else logger.warn({ runId, dir, rel, result }, '[omd/run-worktree] 声明的 env 文件未生效 (fail-open, 需要它的命令在树内会起不来)');
  }
  const anchor = (deps.checkTree ?? ((c: string) => captureRollbackAnchor({ cwd: c })))(cwd);
  const dirty = (anchor.dirtyTracked ?? 0) + (anchor.untracked ?? 0);
  const uncommittedWarning =
    anchor.kind === 'dirty-tracked' || anchor.kind === 'dirty-untracked'
      ? `⚠ 主树上有 ${dirty} 处未提交的东西, 而隔离 worktree 是 **HEAD 那一版的干净 checkout** —— ` +
        '它们在这次跑里**看不见**。agent 可能把你刚写的活重做一遍, 或基于旧版本下结论。' +
        '要让它看见: 先 `git commit` (或 `git stash` 后在隔离树里 `git stash apply`)。'
      : undefined;
  if (uncommittedWarning) logger.warn({ runId, dir, branch, dirty }, `[omd/run-worktree] ${uncommittedWarning}`);

  logger.info({ runId, dir, branch }, '[omd/run-worktree] 本次 run 落在隔离 worktree (R2 · D-Y①)');
  return {
    cwd: dir,
    branch,
    strategy: 'branch',
    ...(uncommittedWarning ? { uncommittedWarning } : {}),
    dispose: () => {
      try {
        git(['worktree', 'remove', '--force', dir], { cwd });
      } catch (e) {
        logger.warn({ dir, err: String(e) }, '[omd/run-worktree] 弃用 worktree 失败 (fail-open)');
      }
    },
  };
}

// ── #165② (2026-08-17): 冻结判据绿 → worktree 内自动收编 commit ──────────────────

/**
 * **要不要自动 commit** 的唯一判据 (#165②, 纯函数)。
 * 三条全真才放行: 隔离档 (head 档写的是主树, 自动 commit 主树是替 owner 扣扳机, 不做) ∧
 * 判据可执行 (非可执行的 oracle 恒 true, 那不是机器绿) ∧ 终态说交付达标 (`isDeliveredOutcome`)。
 * **判据红时不许 commit** —— 反向自检见 run-worktree.test。
 *
 * #201 (2026-08-19): 第三个条件原先是手写的 `outcome === 'success' || outcome === 'delivered-with-red'`。
 * 这里接对了, 另外两处消费者没接对 —— 改成共用 `isDeliveredOutcome` 一份实现, 语义只有一个出处。
 */
export function shouldAutoCommit(
  run: { acceptanceKind: string; outcome: string },
  strategy: BranchStrategy,
): boolean {
  return (
    strategy === 'branch' && run.acceptanceKind === 'executable' && isDeliveredOutcome(run.outcome)
  );
}

export interface CommitRunArtifactsResult {
  committed: boolean;
  /** commit 成功时的短 sha。 */
  sha?: string;
  /** 人话: 干净树 / 失败原因 / 成功摘要。**永不抛** —— 收编是增益, 不许把已终态的 run 带塌。 */
  detail: string;
}

/**
 * 在隔离 worktree 内把本次 run 的改动收进一个 commit (留 run 锚, 人只审不搬)。
 *
 * **`git add -A` 而不是按声明写集挑拣**: 隔离树单跑独占, 树内一切改动就是本 run 的写集真身;
 * 按 write_set 声明面挑会静默丢产物 (声明缺席的 plan 不在少数, D-2 那条只是对账不是全集)。
 * 垃圾临时件跟着进 commit 是**可见的** (git show 即审), 丢产物是不可见的 —— 两害取可见的。
 */
export function commitRunArtifacts(
  opts: { cwd: string; runId: string; message: string },
  deps: { gitOut?: (args: string[], opts: { cwd: string }) => string } = {},
): CommitRunArtifactsResult {
  const gitOut =
    deps.gitOut ??
    ((args: string[], o: { cwd: string }): string => {
      const r = Bun.spawnSync(['git', ...args], { cwd: o.cwd, stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} 失败 (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
      }
      return new TextDecoder().decode(r.stdout).trim();
    });
  try {
    if (gitOut(['status', '--porcelain'], { cwd: opts.cwd }) === '') {
      return { committed: false, detail: '工作树干净, 无可收编改动 (产物可能已在既有 commit 里)' };
    }
    gitOut(['add', '-A'], { cwd: opts.cwd });
    gitOut(['commit', '-m', opts.message], { cwd: opts.cwd });
    const sha = gitOut(['rev-parse', '--short', 'HEAD'], { cwd: opts.cwd });
    return { committed: true, sha, detail: `已收编 commit ${sha} (run ${opts.runId})` };
  } catch (err) {
    // fail-open 吞异常不吞证据: run 已终态, 收编失败只能响亮说, 不能抛。
    return { committed: false, detail: `自动收编失败: ${String(err).slice(0, 300)}` };
  }
}

/**
 * 给回话用的一段人话。**隔离档必须把目录与分支念出来** —— 否则 owner 拿不到那次产出的把手,
 * "隔离"就退化成"东西不见了"。
 */
export function describeRunWorktree(w: RunWorktree): string {
  if (w.strategy === 'head') {
    return w.degradedReason ? `工作目录: 当前工作树 (${w.degradedReason})` : '工作目录: 当前工作树 (head)';
  }
  return [
    `工作目录: **隔离 worktree** ${w.cwd}`,
    `分支: ${w.branch}`,
    // 这一行**必须在合回/弃用之前**: 它说的是"这次跑看见的世界不是你以为的那个",
    // 排在操作命令后面等于让人先动手再发现前提不对。
    ...(w.uncommittedWarning ? [w.uncommittedWarning] : []),
    // #168: 落后警告与 uncommittedWarning 同一条理由 —— 只写在返回值里 owner 看不见, 必须念进回话。
    ...(w.behindWarning ? [w.behindWarning] : []),
    `合回主树由你扣扳机(引擎刻意不自动合): \`git merge ${w.branch}\``,
    `不要了: \`git worktree remove --force ${w.cwd} && git branch -D ${w.branch}\``,
  ].join('\n');
}
