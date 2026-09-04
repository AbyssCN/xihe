/**
 * **R2 branch strategy 闸** (2026-07-31)。
 *
 * 本文件盯三件, 每一件都对应一种"隔离静默失效"的形态:
 *   ① 缺省 `head` **零回归** —— 不传策略 = 今天的行为, 一个 git 命令都不该跑
 *   ② 退回 head 时**必须留下原因** —— 静默退回会让调用方以为写在隔离树里而实际写的是主树,
 *      那比不隔离坏得多
 *   ③ `dispose` **不自动调**, 且回话里念得出目录与分支 —— 否则"隔离"退化成"东西不见了"
 *
 * 全部经注入的假 git,**不起真 worktree**。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  commitRunArtifacts,
  describeRunWorktree,
  ensureNodeModulesLink,
  ensureNodeModulesLinks,
  prepareRunWorktree,
  runWorktreeBranch,
  runWorktreeDir,
  shouldAutoCommit,
  type RunWorktreeDeps,
} from './run-worktree';
import type { RollbackAnchor } from './writeset/rollback-anchor';

/**
 * 假 git: 记下每条命令; `fail` 给了就抛(模拟 worktree 已存在 / 分支重名之类)。
 *
 * ⚠ `checkTree` **必须也是假的**: 不给它的话默认实现会真起一个 git 子进程去查
 * `/repo` —— 用例既不 hermetic 也白慢一截。缺省给 `clean`(= 不产警告, 老用例行为不变)。
 */
function fakeGit(fail?: string, tree: RollbackAnchor = { kind: 'clean', head: 'abc', dirtyTracked: 0, untracked: 0 }): {
  deps: RunWorktreeDeps;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      isGitRepo: () => true,
      checkTree: () => tree,
      git: (args) => {
        calls.push(args);
        if (fail) throw new Error(fail);
      },
    },
  };
}

describe('① 缺省 head — 零回归', () => {
  test('不传策略 → 原样返 cwd, 一个 git 命令都不跑', () => {
    const { deps, calls } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1' }, deps);
    expect(w.cwd).toBe('/repo');
    expect(w.strategy).toBe('head');
    expect(w.branch).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('显式 head 同上; dispose 是空操作(调了也不该碰 git)', () => {
    const { deps, calls } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'head' }, deps);
    w.dispose();
    expect(calls).toEqual([]);
    expect(w.degradedReason).toBeUndefined(); // head 是**请求的**策略, 不是降级
  });
});

describe('② branch — 建得起来就用它, 建不起来必须留下原因', () => {
  test('建 worktree: 目录/分支按约定, git 命令逐字对', () => {
    const { deps, calls } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'run-abc' }, deps);
    expect(w.strategy).toBe('head'); // 没传就是 head —— 下面才是隔离档
    const w2 = prepareRunWorktree({ cwd: '/repo', runId: 'run-abc', strategy: 'branch' }, deps);
    expect(w2.strategy).toBe('branch');
    expect(w2.cwd).toBe(runWorktreeDir('/repo', 'run-abc'));
    expect(w2.branch).toBe(runWorktreeBranch('run-abc'));
    expect(calls).toEqual([['worktree', 'add', w2.cwd, '-b', w2.branch!]]);
    void w;
  });

  test('**不在 git 仓里 → 退回 head, 且带原因**(不抛 —— 跑在别人目录里是正常用法)', () => {
    const calls: string[][] = [];
    const w = prepareRunWorktree(
      { cwd: '/tmp/notarepo', runId: 'r1', strategy: 'branch' },
      { isGitRepo: () => false, git: (a) => calls.push(a) },
    );
    expect(w.strategy).toBe('head');
    expect(w.cwd).toBe('/tmp/notarepo');
    expect(w.degradedReason).toContain('不是 git 工作树');
    expect(calls).toEqual([]); // 连试都不该试
  });

  test('**git 建失败 → 退回 head, 且带原因**(静默退回比不隔离坏得多)', () => {
    const { deps } = fakeGit('fatal: 目录已存在');
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    expect(w.strategy).toBe('head');
    expect(w.cwd).toBe('/repo'); // 退回主树 —— 所以调用方**必须**看得见这一格
    expect(w.degradedReason).toContain('建 worktree 失败');
    expect(w.degradedReason).toContain('目录已存在');
  });

  test('runId 里的怪字符被安全化(分支名/路径都不许被它撑破)', () => {
    const { deps } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'a/b c:d', strategy: 'branch' }, deps);
    expect(w.branch).toBe('omd/run/a_b_c_d');
    expect(w.cwd).toContain('a_b_c_d');
  });
});

describe('③ dispose 不自动调, 且把手念得出来', () => {
  test('准备完毕时**没有**任何 remove —— 跑完那棵树里就是全部产出', () => {
    const { deps, calls } = fakeGit();
    prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    expect(calls.some((c) => c.includes('remove'))).toBe(false);
  });

  test('显式 dispose 才 remove', () => {
    const { deps, calls } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    w.dispose();
    expect(calls[1]).toEqual(['worktree', 'remove', '--force', w.cwd]);
  });

  test('dispose 失败不抛(fail-open —— 清理失败不该把一次成功的跑变成错误)', () => {
    const { deps } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    // 换一个会抛的 git 再 dispose: 借第二次 prepare 拿一个必抛的实例。
    const bad = prepareRunWorktree({ cwd: '/repo', runId: 'r2', strategy: 'branch' }, fakeGit().deps);
    expect(() => bad.dispose()).not.toThrow();
    void w;
  });

  test('回话里必须念出目录与分支, 并给出合回/弃用两条命令', () => {
    const { deps } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    const s = describeRunWorktree(w);
    expect(s).toContain(w.cwd);
    expect(s).toContain(w.branch!);
    expect(s).toContain('git merge');
    expect(s).toContain('worktree remove');
    // **刻意不自动合** —— 这句话要在回话里, 否则 owner 会以为引擎替他合了。
    expect(s).toContain('由你扣扳机');
  });

  test('降级时回话把原因念出来(否则 owner 以为写在隔离树里)', () => {
    const w = prepareRunWorktree(
      { cwd: '/tmp/x', runId: 'r1', strategy: 'branch' },
      { isGitRepo: () => false },
    );
    expect(describeRunWorktree(w)).toContain('不是 git 工作树');
  });
});

describe('非目标: merge-to-head 明确不做', () => {
  test('策略词表只有两态 —— 加第三态要经过一次改测试', () => {
    // sandcastle 的三态里 `merge-to-head` 是**写主干**, 按 D-AB 的可逆性分级属"需批准"那一档,
    // 不是"范围内写"。与 `path_deliver` 同一条纪律: 裁决与执行是两个决定, 扳机归 owner。
    // 这条断言不是锁死设计, 是让"我们加了自动合回"必须显式发生。
    const strategies = ['head', 'branch'];
    expect(strategies).not.toContain('merge-to-head');
  });
});

/**
 * **未提交的活在隔离树里看不见**(2026-08-06)。
 *
 * `git worktree add` 出来的是该 ref 的**干净 checkout** —— 主树上没提交的改动在那边看不见。
 * 这条边界在本模块头注里写了很久,可它**只写在头注里**:调用它的 owner 在回话里一个字都看不到。
 * 于是「带着未提交的活起一次隔离跑」会**静默**从 HEAD 开始,而回话只说"隔离成功"。
 *
 * 这一格与 `degradedReason` 同一条纪律:**声明面与执行面对不上时,必须念进回话**。
 */
describe('⑤ 未提交的活在隔离树里看不见 — 必须念进回话', () => {
  test('★ 主树有已跟踪的未提交改动 → 带警告, 且**回话里念得出来**', () => {
    const { deps } = fakeGit(undefined, { kind: 'dirty-tracked', head: 'abc', dirtyTracked: 3, untracked: 0 });
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    expect(w.strategy).toBe('branch'); // fail-open: 不拒, 隔离照建
    expect(w.uncommittedWarning).toContain('3 处未提交');
    expect(w.uncommittedWarning).toContain('看不见');
    // 这一行是本用例的全部意义: 写在头注里等于没写, 得进 owner 真会读的那段
    expect(describeRunWorktree(w)).toContain('看不见');
  });

  test('★ 只有未跟踪文件也要警告 —— 它们同样进不了隔离树', () => {
    const { deps } = fakeGit(undefined, { kind: 'dirty-untracked', head: 'abc', dirtyTracked: 0, untracked: 2 });
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    expect(w.uncommittedWarning).toContain('2 处未提交');
  });

  test('★ 干净树 → **没有**这条警告 (证明它不是恒响的)', () => {
    const { deps } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    expect(w.uncommittedWarning).toBeUndefined();
    expect(describeRunWorktree(w)).not.toContain('看不见');
  });

  test('★ 查不了 (unknown) → **不警告也不谎报干净** —— 那一格什么都不说', () => {
    // 与上一条的区别: 上面是"查过, 干净"; 这里是"没查成"。两者都不出警告, 但成因不同 ——
    // 若哪天要把这条升成闸, unknown 必须与 clean 分得开 (今天先不编一个假警告出来)。
    const { deps } = fakeGit(undefined, { kind: 'unknown', why: 'git 起不来' });
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    expect(w.uncommittedWarning).toBeUndefined();
  });

  test('head 档不查树 —— 它本来就写在主树上, 没有"看不见"这回事', () => {
    let checked = 0;
    const w = prepareRunWorktree(
      { cwd: '/repo', runId: 'r1', strategy: 'head' },
      { isGitRepo: () => true, git: () => {}, checkTree: () => { checked++; return { kind: 'dirty-tracked' }; } },
    );
    expect(w.uncommittedWarning).toBeUndefined();
    expect(checked).toBe(0);
  });
});

// ── #165② 自动收编闸 ─────────────────────────────────────────────────────────────
describe('shouldAutoCommit (#165②: 冻结判据绿才收编)', () => {
  // 证伪方式 (当场验过): 把 shouldAutoCommit 改成恒 true → 「判据红不许 commit」两条红; 恢复后绿。
  test('隔离档 ∧ 判据可执行 ∧ success / delivered-with-red → 收编', () => {
    expect(shouldAutoCommit({ acceptanceKind: 'executable', outcome: 'success' }, 'branch')).toBe(true);
    expect(shouldAutoCommit({ acceptanceKind: 'executable', outcome: 'delivered-with-red' }, 'branch')).toBe(true);
  });

  test('★ 反向自检: 判据红 (not-converged / oracle-failed / blocked) 不许 commit', () => {
    for (const outcome of ['not-converged', 'oracle-failed', 'blocked', 'infra-error', 'cancelled']) {
      expect(shouldAutoCommit({ acceptanceKind: 'executable', outcome }, 'branch')).toBe(false);
    }
  });

  test('head 档不收编 (自动 commit 主树 = 替 owner 扣扳机)', () => {
    expect(shouldAutoCommit({ acceptanceKind: 'executable', outcome: 'success' }, 'head')).toBe(false);
  });

  test('非可执行判据不收编 (oracle 恒 true 不是机器绿)', () => {
    expect(shouldAutoCommit({ acceptanceKind: 'descriptive', outcome: 'success' }, 'branch')).toBe(false);
  });
});

describe('commitRunArtifacts (#165②: worktree 内收编, 永不抛)', () => {
  const fakeGitOut = (statusOut: string, failOn?: string) => {
    const calls: string[][] = [];
    const gitOut = (args: string[]): string => {
      calls.push(args);
      if (failOn && args[0] === failOn) throw new Error(`${failOn} 炸了`);
      if (args[0] === 'status') return statusOut;
      if (args[0] === 'rev-parse') return 'abc1234';
      return '';
    };
    return { calls, gitOut };
  };

  test('脏树 → add -A + commit + 短 sha 回执', () => {
    const { calls, gitOut } = fakeGitOut(' M src/x.ts\n?? tmp.txt');
    const r = commitRunArtifacts({ cwd: '/wt', runId: 'r1', message: 'omd run r1: 收编' }, { gitOut });
    expect(r).toEqual({ committed: true, sha: 'abc1234', detail: '已收编 commit abc1234 (run r1)' });
    expect(calls.map((c) => c[0])).toEqual(['status', 'add', 'commit', 'rev-parse']);
  });

  test('干净树 → 不 commit, 说明原因', () => {
    const { calls, gitOut } = fakeGitOut('');
    const r = commitRunArtifacts({ cwd: '/wt', runId: 'r1', message: 'm' }, { gitOut });
    expect(r.committed).toBe(false);
    expect(r.detail).toContain('干净');
    expect(calls.map((c) => c[0])).toEqual(['status']);
  });

  test('commit 炸了 → 不抛, 失败原因进 detail (吞异常不吞证据)', () => {
    const { gitOut } = fakeGitOut(' M x', 'commit');
    const r = commitRunArtifacts({ cwd: '/wt', runId: 'r1', message: 'm' }, { gitOut });
    expect(r.committed).toBe(false);
    expect(r.detail).toContain('commit 炸了');
  });
});

// ── #166 node_modules 链入 ───────────────────────────────────────────────────────
describe('ensureNodeModulesLink (#166: worktree 缺 node_modules → 显式路径读包结构性红)', () => {
  const { mkdtempSync: mkTmp, mkdirSync: mkDir, existsSync: exists, realpathSync, writeFileSync: writeF } =
    require('node:fs') as typeof import('node:fs');
  const { tmpdir: osTmp } = require('node:os') as typeof import('node:os');

  const twoDirs = (withSource: boolean) => {
    const root = mkTmp(join(osTmp(), 'omd-nml-'));
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    mkDir(main, { recursive: true });
    mkDir(wt, { recursive: true });
    if (withSource) {
      mkDir(join(main, 'node_modules', 'somepkg'), { recursive: true });
      writeF(join(main, 'node_modules', 'somepkg', 'index.js'), 'x');
    }
    return { main, wt };
  };

  // 证伪方式 (当场验过): 把 ensureNodeModulesLink 的 link(source, dest) 行注释掉 → 本条红; 恢复后绿。
  test('主树有 node_modules ∧ 树内缺 → 真建 symlink, 显式路径可读', () => {
    const { main, wt } = twoDirs(true);
    const r = ensureNodeModulesLink(main, wt);
    expect(r).toBe('linked');
    // run 5fd13a78 的失败面就是这一格: 显式 join 路径读包文件。
    expect(exists(join(wt, 'node_modules', 'somepkg', 'index.js'))).toBe(true);
    // #205-ter 后 <wt>/node_modules 是**逐条镜像的真目录**(理由见 mirrorNodeModules 的注),
    // 所以这里钉的不再是"整目录是同一个 inode", 而是原意: **包的真身仍在主树那份里**。
    expect(realpathSync(join(wt, 'node_modules', 'somepkg'))).toBe(realpathSync(join(main, 'node_modules', 'somepkg')));
  });

  test('主树没有 node_modules → no-source (不编一个空目录出来)', () => {
    const { main, wt } = twoDirs(false);
    expect(ensureNodeModulesLink(main, wt)).toBe('no-source');
    expect(exists(join(wt, 'node_modules'))).toBe(false);
  });

  test('树内已有 → already-present (幂等; resume 复用路每次都会来一遍)', () => {
    const { main, wt } = twoDirs(true);
    ensureNodeModulesLink(main, wt);
    expect(ensureNodeModulesLink(main, wt)).toBe('already-present');
  });

  test('link 抛错 → link-failed 带原文, 不抛 (fail-open 吞异常不吞证据)', () => {
    const { main, wt } = twoDirs(true);
    const r = ensureNodeModulesLink(main, wt, () => {
      throw new Error('EPERM 假装不许');
    });
    expect(r).toContain('link-failed');
    expect(r).toContain('EPERM 假装不许');
  });

  test('接线: branch 建树成功后调用链入 (注入计数), head 档不调', () => {
    let calls: Array<[string, string]> = [];
    const ensureLink = ((m: string, w: string) =>
      (calls.push([m, w]), [{ rel: '.', result: 'linked' as const }])) as RunWorktreeDeps['ensureLink'];
    const { deps } = fakeGit();
    prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, { ...deps, ensureLink });
    expect(calls).toEqual([['/repo', runWorktreeDir('/repo', 'r1')]]);
    calls = [];
    prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'head' }, { ...deps, ensureLink });
    expect(calls).toEqual([]);
  });
});

// ── #174 一级子包 node_modules 链入 ──────────────────────────────────────────────
describe('ensureNodeModulesLinks (#174: web/ 等一级子包自己的 node_modules, #166 只链了仓根)', () => {
  const {
    mkdtempSync: mkTmp,
    mkdirSync: mkDir,
    existsSync: exists,
    writeFileSync: writeF,
    readFileSync: readF,
    symlinkSync,
  } = require('node:fs') as typeof import('node:fs');
  const { tmpdir: osTmp } = require('node:os') as typeof import('node:os');

  const monorepo = () => {
    const root = mkTmp(join(osTmp(), 'omd-nmls-'));
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    // 主树: 仓根 node_modules + web/node_modules (run a828a672 的失败面) + 无包子目录 + 点目录
    mkDir(join(main, 'node_modules'), { recursive: true });
    mkDir(join(main, 'web', 'node_modules', 'react'), { recursive: true });
    writeF(join(main, 'web', 'node_modules', 'react', 'jsx-dev-runtime.js'), 'x');
    mkDir(join(main, 'docs'), { recursive: true });
    mkDir(join(main, '.omd', 'node_modules'), { recursive: true });
    // worktree checkout: web/ 是跟踪目录所以存在, node_modules 不在
    mkDir(join(wt, 'web'), { recursive: true });
    return { main, wt };
  };

  // 证伪方式 (当场验过): 把 ensureNodeModulesLinks 的一级扫描循环注释掉 → 本条红 (只剩仓根); 恢复后绿。
  test('仓根 + web/ 都链上; 无 node_modules 的子目录与点目录不碰', () => {
    const { main, wt } = monorepo();
    const r = ensureNodeModulesLinks(main, wt);
    expect(r).toEqual([
      { rel: '.', result: 'linked' },
      { rel: 'web', result: 'linked' },
    ]);
    // #174 的失败面就是这一格: web/ 下按子包解析读 react。
    expect(exists(join(wt, 'web', 'node_modules', 'react', 'jsx-dev-runtime.js'))).toBe(true);
    expect(exists(join(wt, 'docs'))).toBe(false);
    expect(exists(join(wt, '.omd'))).toBe(false);
  });

  test('子目录在 worktree 里缺席 → link-failed 记账不抛 (fail-open 吞异常不吞证据)', () => {
    const { main, wt } = monorepo();
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(join(wt, 'web'), { recursive: true });
    const r = ensureNodeModulesLinks(main, wt);
    expect(r[0]).toEqual({ rel: '.', result: 'linked' });
    expect(r[1]!.rel).toBe('web');
    expect(r[1]!.result).toContain('link-failed');
  });

  /**
   * #205-bis (2026-09-04, plana 实账): `apps/*` + `packages/*` 是最常见的 npm workspaces 约定,
   * 子包在**第二级**。一级扫描只看 `apps/node_modules`(不存在)就跳过 —— worktree 里
   * `apps/web/node_modules` 整个缺席。
   *
   * 后果不是"缺个包"这么干净: `apps/web/src/**` 解析 `@hookform/resolvers` 时沿父目录兜底
   * 走到仓根那份, 而 npm 把它提升进了 `apps/web/node_modules` —— 兜不到。叶子看到残缺依赖树后
   * 跑 `npm install` 自救, 那次 install 又把 worktree 的 workspace 软链改写成绝对路径,
   * 造出混合坏树, 报出一堆与本次改动无关的错(plana: 4 个 tsc 错, 查了八个假设才定位)。
   *
   * 证伪方式: 把 findPackageDirsWithNodeModules 的 maxDepth 改回 1 → 本条红; 恢复后绿。
   */
  test('apps/* + packages/* 布局: 二级子包的 node_modules 也要链上', () => {
    const root = mkTmp(join(osTmp(), 'omd-nmls2-'));
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    mkDir(join(main, 'node_modules'), { recursive: true });
    mkDir(join(main, 'apps', 'web', 'node_modules', '@hookform'), { recursive: true });
    mkDir(join(main, 'packages', 'engine', 'node_modules'), { recursive: true });
    mkDir(join(main, 'apps', 'docs'), { recursive: true }); // 无 node_modules 的二级目录不该被碰
    mkDir(join(wt, 'apps', 'web'), { recursive: true });
    mkDir(join(wt, 'packages', 'engine'), { recursive: true });
    mkDir(join(wt, 'apps', 'docs'), { recursive: true });

    const r = ensureNodeModulesLinks(main, wt);
    const linked = r.filter((x) => x.result === 'linked').map((x) => x.rel).sort();
    expect(linked).toEqual(['.', 'apps/web', 'packages/engine']);
    // 真正的失败面就是这一格: apps/web/src/** 解析被提升进子包的依赖
    expect(exists(join(wt, 'apps', 'web', 'node_modules', '@hookform'))).toBe(true);
    expect(exists(join(wt, 'apps', 'docs', 'node_modules'))).toBe(false);
  });

  /**
   * #205-ter (2026-09-04, plana 实账 · 第四个 bug): **workspace 内部包的解析经过指向主树源码的软链,
   * 而主树源码正是 jail 要藏起来的东西。**
   *
   * 此前 `<wt>/node_modules` 是指向主树那份的**整目录**软链, 于是
   * `<wt>/node_modules/@plana/domain` → 主树的 `@plana/domain` → `../../packages/domain`
   * (相对**主树**) → `/主repo/packages/domain` —— jail 里按设计不可见, tsc 报
   * `Cannot find module '@plana/domain'`。叶子跑 `npm install` 自救是**对的**:
   * 那次 install 正是把这些链改写成指向 worktree。我们来做, 做得干净且幂等。
   *
   * 实测形态 (plana 主树): 顶层 733 个条目**零条**相对软链, 只有 `@plana` 这一个 scope 目录里有
   * 6 条 —— 所以逐条镜像时**相对目标逐字照抄**就够: 它自己会重定基到 worktree。
   *
   * 证伪方式: 把 mirrorNodeModules 换回整目录 symlink → 本条红。
   */
  test('workspace 内部包重定基到 worktree, 不再指向主树源码', () => {
    const root = mkTmp(join(osTmp(), 'omd-ws-redirect-'));
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    // 主树: node_modules 里一个真依赖 + 一个指向自家 packages 的相对软链 (workspace 内部包)
    mkDir(join(main, 'node_modules', 'lodash'), { recursive: true });
    writeF(join(main, 'node_modules', 'lodash', 'index.js'), 'real-dep');
    mkDir(join(main, 'node_modules', '@plana'), { recursive: true });
    mkDir(join(main, 'packages', 'domain'), { recursive: true });
    writeF(join(main, 'packages', 'domain', 'index.ts'), 'MAIN');
    symlinkSync('../../packages/domain', join(main, 'node_modules', '@plana', 'domain'), 'dir');
    // worktree: 自己的 packages/domain(内容不同 —— 用来分辨解析到了哪一棵树)
    mkDir(join(wt, 'packages', 'domain'), { recursive: true });
    writeF(join(wt, 'packages', 'domain', 'index.ts'), 'WORKTREE');

    ensureNodeModulesLinks(main, wt);

    // ★ 这一格就是第四个 bug 的失败面
    expect(readF(join(wt, 'node_modules', '@plana', 'domain', 'index.ts'), 'utf8')).toBe('WORKTREE');
    // 真依赖仍要够得到 (指向主树是对的 —— 那才是它的真身)
    expect(readF(join(wt, 'node_modules', 'lodash', 'index.js'), 'utf8')).toBe('real-dep');
  });

  test('幂等: 第二遍全 already-present (resume 复用路每次都来一遍)', () => {
    const { main, wt } = monorepo();
    ensureNodeModulesLinks(main, wt);
    const r = ensureNodeModulesLinks(main, wt);
    expect(r.map((x) => x.result)).toEqual(['already-present', 'already-present']);
  });
});

// ── 续跑不许换树 (2026-08-23, owner 现场报) ──────────────────────────────────
//
// 现场: 首跑传了 branchStrategy:'branch', resume 只传 resume/sddPath/detached/maxRounds
// ⇒ strategy 落回 head ⇒ 这一轮的写打进**主工作树**, 而另一个 session 正在同一棵树上提交。
// 没造成损失, 但那是运气不是设计。
//
// 根因不是「resume 不继承参数」, 是**同一条判据两处各写一份而漏了一处**:
// `dag-tools.ts` 的 run 工具早就算过「resume ∧ 盘上有树 → 强制 branch」, 而 `goal.ts` 的
// solve 没有 —— 漏的那处恰好是夜批默认路径。判据已收进 prepareRunWorktree 一处。
describe('续跑不许换树: 盘上已有该 runId 的隔离树 ⇒ 强制 branch (不论本次传没传)', () => {
  const { mkdtempSync: mkTmp, mkdirSync: mkDir } = require('node:fs') as typeof import('node:fs');
  const { tmpdir: osTmp } = require('node:os') as typeof import('node:os');

  const worldWithTree = () => {
    const cwd = mkTmp(join(osTmp(), 'omd-resume-strategy-'));
    mkDir(runWorktreeDir(cwd, 'r1'), { recursive: true });
    return { cwd, noLink: (() => []) as unknown as RunWorktreeDeps['ensureLink'] };
  };

  test('★ 修前必红: strategy **缺席** + 盘上有树 ⇒ 仍是 branch, cwd 指隔离树', () => {
    const { cwd, noLink } = worldWithTree();
    const { deps } = fakeGit();
    // 逐字复现现场: resume 那次调用**没传** branchStrategy。
    const w = prepareRunWorktree({ cwd, runId: 'r1' }, { ...deps, ensureLink: noLink });
    expect(w.strategy).toBe('branch');
    expect(w.cwd).toBe(runWorktreeDir(cwd, 'r1'));
  });

  test("★ 修前必红: 显式传 'head' + 盘上有树 ⇒ 仍是 branch (写主树比不隔离更坏)", () => {
    const { cwd, noLink } = worldWithTree();
    const { deps } = fakeGit();
    const w = prepareRunWorktree({ cwd, runId: 'r1', strategy: 'head' }, { ...deps, ensureLink: noLink });
    expect(w.strategy).toBe('branch');
    expect(w.cwd).toBe(runWorktreeDir(cwd, 'r1'));
  });

  test('★ 判别力: 盘上**没有**树 + strategy 缺席 ⇒ 老老实实 head (这条不许被上面两条带跑)', () => {
    const cwd = mkTmp(join(osTmp(), 'omd-resume-strategy-none-'));
    const { deps } = fakeGit();
    const w = prepareRunWorktree({ cwd, runId: 'r2' }, deps);
    expect(w.strategy).toBe('head');
    expect(w.cwd).toBe(cwd);
  });

  test('★ 判别力: 盘上没有树 + 显式 head ⇒ head (零回归)', () => {
    const cwd = mkTmp(join(osTmp(), 'omd-resume-strategy-none2-'));
    const { deps } = fakeGit();
    const w = prepareRunWorktree({ cwd, runId: 'r3', strategy: 'head' }, deps);
    expect(w.strategy).toBe('head');
  });
});

// ── #168 候选① resume 落后检测 (run 20984d68 现场: 主树修补对续跑不可见) ────────
describe('behindWarning (#168): resume 复用且分支落后 HEAD → 响亮报, 其余一律沉默', () => {
  const { mkdtempSync: mkTmp, mkdirSync: mkDir } = require('node:fs') as typeof import('node:fs');
  const { tmpdir: osTmp } = require('node:os') as typeof import('node:os');

  /** 真临时 cwd + 预建 runWorktreeDir → 打中 resume 复用路 (existsSync 真判)。 */
  const resumeWorld = () => {
    const cwd = mkTmp(join(osTmp(), 'omd-behind-'));
    mkDir(runWorktreeDir(cwd, 'r1'), { recursive: true });
    const noLink = (() => []) as unknown as RunWorktreeDeps['ensureLink'];
    return { cwd, noLink };
  };

  // 证伪方式 (当场验过): 注释掉 prepareRunWorktree 复用路的 detectBehind 调用行 → 本条红。
  test('落后 3 → behindWarning 含条数与隔离树内 cherry-pick 命令, 且进 describeRunWorktree', () => {
    const { cwd, noLink } = resumeWorld();
    const { deps } = fakeGit();
    const gitOut = (args: string[]): string =>
      args[0] === 'rev-list' ? '3' : args[0] === 'rev-parse' ? 'abc1234' : '';
    const w = prepareRunWorktree({ cwd, runId: 'r1', strategy: 'branch' }, { ...deps, ensureLink: noLink, gitOut });
    expect(w.behindWarning).toContain('落后主仓 HEAD 3 个 commit');
    // 方向必须是隔离树 (-C <dir>), 不是主仓 —— run 87e43ded 的 M3 产出把方向写反, 此断言钉死。
    expect(w.behindWarning).toContain(`git -C ${runWorktreeDir(cwd, 'r1')} cherry-pick`);
    expect(w.behindWarning).toContain('abc1234');
    expect(describeRunWorktree(w)).toContain('落后主仓 HEAD 3 个 commit');
  });

  test('不落后 (count=0) → 一字不提 (反向自检, 票内判据)', () => {
    const { cwd, noLink } = resumeWorld();
    const { deps } = fakeGit();
    const gitOut = (args: string[]): string => (args[0] === 'rev-list' ? '0' : '');
    const w = prepareRunWorktree({ cwd, runId: 'r1', strategy: 'branch' }, { ...deps, ensureLink: noLink, gitOut });
    expect(w.behindWarning).toBeUndefined();
    expect(describeRunWorktree(w)).not.toContain('落后');
  });

  test('分叉 (--is-ancestor 抛) → speak-not, 不据此说任何话', () => {
    const { cwd, noLink } = resumeWorld();
    const { deps } = fakeGit();
    const gitOut = (args: string[]): string => {
      if (args[0] === 'merge-base') throw new Error('exit 1');
      return '99';
    };
    const w = prepareRunWorktree({ cwd, runId: 'r1', strategy: 'branch' }, { ...deps, ensureLink: noLink, gitOut });
    expect(w.behindWarning).toBeUndefined();
  });

  test('新建路 (树不存在) → gitOut 一次都不调 (落后检测只属复用路)', () => {
    const { deps } = fakeGit();
    const calls: string[][] = [];
    const gitOut = (args: string[]): string => (calls.push(args), '3');
    const noLink = (() => []) as unknown as RunWorktreeDeps['ensureLink'];
    prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, { ...deps, ensureLink: noLink, gitOut });
    expect(calls).toEqual([]);
  });
});
