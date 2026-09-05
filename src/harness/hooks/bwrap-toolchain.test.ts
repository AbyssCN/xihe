/**
 * **jail 工具链可见性** (2026-09-04, plana 实账)。
 *
 * ## 这两条各烧掉了什么
 *
 * plana(npm workspaces monorepo)连派四个 run,**四个全部零产出**:
 * `015c887c` `37c06dac` 终态 failed,`015a499c` `496b8431` 终态 done 但写集为空。
 * 四个 conductor 的报告是一致且正确的 —— 它们没假装干活,而是精确诊断后停下。
 * 两条根因都在挂载面上,与模型无关:
 *
 * | # | 根因 | 症状 |
 * |---|---|---|
 * | ① | jail 的 PATH = `dirname(process.execPath):/usr/bin:/bin`。omd 自己跑在 **bun** 上,所以 jail 里**只有 bun**,没有 node/npm/npx | 仓的验收命令是 `npx tsc` / `npx vitest` → 全部 `command not found`。叶子退而用 bun 顶替,bun 的 subpath 解析与 node 不一致,**假报 38 个测试文件失败** → 基线不可复现 → 硬约束一条都判不了 |
 * | ② | `defaultRoBinds` 只绑**向上最近的一个** `node_modules`。npm/pnpm/yarn **workspaces** 的依赖是分散在嵌套 `node_modules` 里的 | plana 有三个(根 + `apps/web` + `apps/mobile`),jail 里只见根那份 → `@hookform/resolvers` 一类解析不到 → 叶子看到一棵残缺依赖树,于是**跑 `npm install` 去自救**,那次 install 又把 worktree 的 `@plana/*` 软链改写成绝对路径,造出一棵混合坏树 |
 *
 * ②的连锁是这两条里更贵的:**缺依赖 → 叶子自救 → 自救把树弄坏 → 报出一堆与本次改动无关的错**。
 * 一个不完整的挂载面不会安静地失败,它会伪装成「模型不行」或「仓本来就是脏的」。
 *
 * ## 判据
 *
 * 两条都在 argv / 返值上判得出来,不需要真起 jail —— 与 `jail-preflight` 同一条理由
 * (argv 是数据,判它是微秒级)。真容器性由 `bwrap-containment.test.ts` 管,不在这里重复。
 *
 * ⚠ 宿主 PATH 上没有 node → ① 这组**跳过并响亮说明**,不静默绿(同 bwrap-containment 的纪律)。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { bwrapArgs, collectNodeModules, defaultRoBinds, findNodeToolchain } from './bwrap';

/** argv 里 `--setenv PATH <值>` 的那个值。没有则 null。 */
function pathEnv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === '--setenv' && argv[i + 1] === 'PATH') return argv[i + 2]!;
  }
  return null;
}

/** argv 里所有 `--ro-bind SRC DST` / `--bind SRC DST` 的 SRC。 */
function bindSources(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === '--ro-bind' || argv[i] === '--bind') out.push(argv[i + 1]!);
  }
  return out;
}

/** 造一棵 workspaces monorepo 的骨架: 根 + 两个子包各带自己的 node_modules。 */
function makeWorkspacesTree(): { root: string; expected: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omd-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', workspaces: ['apps/*', 'packages/*'] }));
  const dirs = ['node_modules', 'apps/web/node_modules', 'packages/engine/node_modules'];
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  // node_modules **内部**的 node_modules 不该被收 (npm 的嵌套解析目录, 绑了没用还放大挂载面)
  mkdirSync(join(root, 'node_modules/foo/node_modules'), { recursive: true });
  // 干扰项: .git 与 .omd 下面的不该被收 (.omd/runs 里是别的 run 的 worktree)
  mkdirSync(join(root, '.omd/runs/other/node_modules'), { recursive: true });
  return { root, expected: dirs.map((d) => join(root, d)) };
}

describe('挂载面最小 —— 非 JS 仓不该被绑上 node', () => {
  // 接生态表之后的新性质 (2026-09-04)。此前 node 是无条件绑的。
  // 证伪方式: 把 defaultRoBinds 改回无条件加 findNodeToolchain()?.rootDir → 本条红。
  test('root 里没有 package.json → node 安装根不进 roBinds', () => {
    const tc = findNodeToolchain();
    if (!tc) {
      console.warn('[skip] 宿主 PATH 上没有 node —— 本条跳过, 不是通过');
      return;
    }
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omd-nojs-')));
    try {
      expect(defaultRoBinds(root)).not.toContain(tc.rootDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('② collectNodeModules —— workspaces monorepo 的嵌套依赖', () => {
  // 证伪方式: 把 collectNodeModules 换回只返 findNodeModules(root) 的单值 → 本条红。
  test('根 + 每个子包的 node_modules 全部收进来', () => {
    const { root, expected } = makeWorkspacesTree();
    try {
      const got = collectNodeModules(root);
      for (const e of expected) expect(got).toContain(e);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('不下钻进 node_modules 内部, 也不收 .git / .omd 下的', () => {
    const { root } = makeWorkspacesTree();
    try {
      const got = collectNodeModules(root);
      expect(got.some((p) => p.includes('/node_modules/foo/'))).toBe(false);
      expect(got.some((p) => p.includes('/.omd/'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('node_modules 是 symlink 时收**真身** (86e6cdb 同款: 绑链接路径本身, jail 内目标不可见)', () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'omd-nm-real-')));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omd-nm-root-')));
    try {
      symlinkSync(real, join(root, 'node_modules'));
      expect(collectNodeModules(root)).toContain(real);
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('defaultRoBinds 把它们都带上 (这才是真正进 argv 的那一份)', () => {
    const { root, expected } = makeWorkspacesTree();
    try {
      const binds = defaultRoBinds(root);
      for (const e of expected) expect(binds).toContain(e);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('① node 工具链进 jail —— PATH 与绑定', () => {
  const tc = findNodeToolchain();

  test('宿主 PATH 上找得到 node 时, 解析出 bin 目录与安装根', () => {
    if (!tc) {
      console.warn('[skip] 宿主 PATH 上没有 node —— 本条跳过, 不是通过');
      return;
    }
    // binDir 必须真含 node 可执行; rootDir 必须是它的父 (含 bin/ 与 lib/, npm 的相对软链要靠它)
    expect(tc.binDir.endsWith('/bin')).toBe(true);
    expect(tc.rootDir).toBe(dirname(tc.binDir));
  });

  // 证伪方式: 把 bwrapArgs 的 PATH 改回 `${dirname(process.execPath)}:/usr/bin:/bin` → 本条红。
  test('jail 的 PATH 里含 node 的 bin 目录', () => {
    if (!tc) {
      console.warn('[skip] 宿主 PATH 上没有 node —— 本条跳过, 不是通过');
      return;
    }
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omd-path-')));
    writeFileSync(join(root, 'package.json'), '{}'); // 生态表按 marker 认仓 —— 没它就不绑 node
    try {
      const p = pathEnv(bwrapArgs(root, defaultRoBinds(root)));
      expect(p).not.toBeNull();
      expect(p!.split(':')).toContain(tc.binDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 证伪方式: 从 defaultRoBinds 里去掉 node.rootDir → 本条红。
  // ⚠ 必须绑**安装根**不是 bin: npm/npx 是指向 `../lib/node_modules/npm/bin/*.js` 的相对软链,
  //   只绑 bin 目录时那条链在 jail 里断掉 —— 2026-09-04 手工绕过这个 bug 时原样踩过一次。
  test('node 的安装根被 ro-bind 进 jail (只绑 bin 会让 npm 的相对软链断掉)', () => {
    if (!tc) {
      console.warn('[skip] 宿主 PATH 上没有 node —— 本条跳过, 不是通过');
      return;
    }
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omd-bind-')));
    writeFileSync(join(root, 'package.json'), '{}');
    try {
      const sources = bindSources(bwrapArgs(root, defaultRoBinds(root)));
      expect(sources.some((s) => s === tc.rootDir || tc.binDir.startsWith(`${s}/`) || s === tc.binDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── 订阅座位的凭据进 jail (2026-09-05, run 8976c8be 实账) ─────────────────
/**
 * 病:隔离档下 `jailRoot` **不看座位** —— 所有叶子(含 conductor)都进 jail,而 jail 的
 * `HOME=/tmp` ⇒ `~/.claude` 不可见 ⇒ 订阅通道 `Not logged in · Please run /login`,节点抛错。
 * `agent-leaf.ts:2055` 早写着「订阅座位暂不支持沙箱叶」,而生产路径照进。
 *
 * ⚠ 本组最该钉的是**挂载面有多窄**:三轮收窄实测(整个 `~/.claude` → 加 `~/.claude.json` →
 * 只要凭据一件,三次 `claude -p` 都回 OK)。挂整个 `~/.claude` 会把 `projects/` 下所有仓
 * 所有会话的完整记录递给一个 LLM 叶子。放宽这一条要重新拿实测说话。
 */
describe('claudeCredentials —— 订阅座位在 jail 里认得出自己', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omd-cred-')));
  const cred = join(homedir(), '.claude', '.credentials.json');

  test('缺席(默认)→ 一个 .claude 的绑定都没有(零回归)', () => {
    const srcs = bindSources(bwrapArgs(root, []));
    expect(srcs.some((s) => s.includes('/.claude'))).toBe(false);
  });

  // 证伪方式: 把 bwrapArgs 里 `opts.claudeCredentials` 那一支删掉 → 本条红。
  test('★ 开启 → 凭据 ro 挂到 jail 的 HOME 下(/tmp/.claude/.credentials.json)', () => {
    if (!existsSync(cred)) {
      console.warn('[skip] 宿主上没有 ~/.claude/.credentials.json —— 本条跳过, 不是通过');
      return;
    }
    const argv = bwrapArgs(root, [], { claudeCredentials: true });
    const i = argv.findIndex(
      (a, k) => a === '--ro-bind' && argv[k + 1] === cred && argv[k + 2] === '/tmp/.claude/.credentials.json',
    );
    expect(i).toBeGreaterThanOrEqual(0);
  });

  // 这一条是**安全断言**, 不是功能断言: 放宽挂载面会让它红。
  test('★ 只挂凭据那一个文件 —— 不挂 ~/.claude 目录(那里有所有仓的会话记录)', () => {
    const srcs = bindSources(bwrapArgs(root, [], { claudeCredentials: true }));
    const claudeish = srcs.filter((s) => s.includes('/.claude'));
    for (const s of claudeish) expect(s.endsWith('.credentials.json')).toBe(true);
  });
});
