/**
 * bwrap —— bubblewrap 隔离的**绑定组装**共享助手 (2026-07-23, eval worktree 真隔离)。
 *
 * 治终局根因 (记忆 dag-engine-write-reliability): eval leaf 在同一文件系统命名空间跑, 会 `cd /主repo`
 * 出 worktree、`git show <commit>:file > file` 从共享 .git 捞被清空的实现写回主树 (oracle 作弊 + 污染)。
 * pi 暴露多条命令通道 (bash + 模型幻觉的 shell + 未来工具), 逐工具沙箱是打地鼠 → 用 bwrap 把**整个 leaf
 * 进程**关进只见 worktree 的文件系统视图 (subprocess-per-leaf, 见 sandboxed-leaf.ts)。
 *
 * 绑定策略 (已隔离单元验证): `--bind <root> <root>` 同路径挂 worktree (rw); 中间目录 (含主 repo 前缀)
 * 被 bwrap 建成**空目录** → `cd /主repo && ls src` 见空、`git show` 无 .git → 逃逸与 oracle 作弊双断。
 * ro-bind: bunDir + **node 安装根** + root 子树下**全部** node_modules → bun/node/npx/tsc 可跑且解析依赖。
 * 系统只读 + /tmp + /proc + /dev。后两项各有一笔实账 (2026-09-04 plana, 四个 run 零产出),
 * 见 {@link findNodeToolchain} 与 {@link collectNodeModules} 的注 —— 共同点是
 * **挂载面不完整不会安静失败, 它会伪装成「模型不行」**。
 * **不 --clearenv**: 继承父进程 env (provider API key 等要流进 worker); 只 --setenv HOME/PATH。
 */
import type { Dirent } from 'node:fs';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { findExecToolchain, resolveToolchainBinds, type ExecToolchain } from './toolchain';

/**
 * DNS 解析所需的额外绑定 (WSL2: /etc/resolv.conf 是指向 /mnt/wsl/resolv.conf 的符号链接, ro-bind /etc 时
 * 链接目标不在 jail 内 → 无 DNS → leaf 连不上 model API)。把真身按**自己的绝对路径**绑进去, /etc 里的
 * 符号链接自然解析。真身在 /etc 内 (常规文件) → 已被 /etc 覆盖, 返 []。
 */
function dnsBinds(): string[] {
  try {
    const real = realpathSync('/etc/resolv.conf');
    return real.startsWith('/etc/') ? [] : [real];
  } catch {
    return [];
  }
}

/**
 * realpath,**把失败原因经返回值交出去**(仓规 §静默坑 2:fail-open 可以,吞证据不行)。
 *
 * 三个调用点都是**有意 fail-open** 的 —— 一个解析不了的路径 bind 进 jail 也没用,
 * 少绑一份好过整个 argv 组装崩掉。但「为什么少绑了这一份」必须能被问出来,
 * 所以失败走 `{ err }` 而不是静默 null。
 */
function tryRealpath(p: string): { path: string; err?: undefined } | { path?: undefined; err: string } {
  try {
    return { path: realpathSync(p) };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

/** readdir,**把失败原因经返回值交出去**(同 {@link tryRealpath} 的理由)。 */
function tryReaddir(dir: string): { entries: Dirent[]; err?: undefined } | { entries?: undefined; err: string } {
  try {
    return { entries: readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

/** 自 start 向上找最近含 node_modules 的祖先目录, 返 node_modules **真身**绝对路径 (无则 null)。
 * ⚠ realpath 是承重的 (#166 后, run 68cfb43f 实测): 隔离 worktree 的 node_modules 是指向
 * 主树的 symlink —— ro-bind 链接路径本身, jail 里链接的**目标**不可见 → typebox 悬空 ENOENT,
 * agent 子进程整个起不来。bind 真身路径, jail 内链接解析即达; 非链接时 realpath 恒等, 零行为差。 */
export function findNodeModules(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const nm = join(dir, 'node_modules');
    // existsSync 跟随链接: 悬空链接在这里本来就是 false, 继续向上。realpath 抛错只剩竞态一格,
    // 那格照旧向上找真身 (fail-open, 一个解析不了依赖的路径 bind 进去也没用)。
    if (existsSync(nm)) {
      const r = tryRealpath(nm);
      if (r.path) return r.path;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 收集 node_modules 时不下钻的目录名 (下钻进去只会放大挂载面, 拿不到有用的依赖)。 */
const NM_SKIP_DIRS = new Set(['.git', '.omd', '.next', '.turbo', 'dist', 'build', 'coverage']);

/**
 * 收集 root 子树下**全部** node_modules 真身 + 向上最近的那份 (worktree 场景)。
 *
 * ⚠ 为什么不能只要"最近的一个" (2026-09-04 plana 实账, 四个 run 零产出):
 * npm/pnpm/yarn **workspaces** 的依赖是**分散在嵌套 node_modules 里**的 —— plana 有三个
 * (根 + `apps/web` + `apps/mobile`), 只绑根那份时 jail 里 `@hookform/resolvers` 一类解析不到。
 * 叶子看到残缺依赖树后会做任何工程师都会做的事: 跑 `npm install` 自救 —— 那次 install 又把
 * worktree 的 workspace 软链改写成绝对路径, 造出一棵混合坏树, 报出一堆与本次改动无关的错。
 * **一个不完整的挂载面不会安静地失败, 它会伪装成「模型不行」或「仓本来就是脏的」。**
 *
 * 深度上限存在的理由: 深层 node_modules 一定嵌在浅层里 (npm 的解析规则), 绑外层即可;
 * 而无上限的 walk 在大 monorepo 上是每个 leaf 都要付一次的 IO。
 */
export function collectNodeModules(root: string, maxDepth = 4): string[] {
  const out = new Set<string>();
  const ancestor = findNodeModules(root);
  if (ancestor) out.add(ancestor);
  // (#205-ter) worktree 的 node_modules 现在是**逐条镜像的真目录**, 条目软链到主树那份里的包
  // (见 run-worktree 的 mirrorNodeModules) —— 主树那份不绑, 每个真依赖在 jail 里都悬空。
  // ⚠ 刻意**不**靠"worktree 在主仓之内"去向上找: 那正是本轮一路在修的那种布局假设。
  // 改成从镜像**自己的指向**推 —— 条目指到哪个 node_modules, 就绑哪个。
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    const r = tryReaddir(dir);
    if (!r.entries) return; // r.err = 权限/竞态; 少绑一份好过整个组装崩掉
    for (const e of r.entries) {
      // symlink 也要认: worktree 的 node_modules 常常是指向主树的链接 (86e6cdb 同款)
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (NM_SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.name === 'node_modules') {
        const r = tryRealpath(p);
        if (r.path) out.add(r.path); // r.err = 悬空链接; 绑不了也没用, 少这一份
        continue; // 不下钻进 node_modules 内部 —— 里面的嵌套份已被外层覆盖
      }
      walk(p, depth + 1);
    }
  };
  walk(resolve(root), 0);
  for (const nm of [...out]) for (const t of mirrorTargets(nm)) out.add(t);
  return [...out];
}

/**
 * 一份逐条镜像的 node_modules 指向了**别的哪些** node_modules(见 {@link collectNodeModules} 的 ⚠)。
 *
 * 只认「绝对目标 且 其父目录就叫 node_modules」这一种形态 —— 那正是 mirrorNodeModules 为真依赖
 * 建的链。相对目标是 workspace 内部包, 它们按设计解析回本树, 不需要额外绑。
 */
function mirrorTargets(nm: string): string[] {
  const out = new Set<string>();
  const r = tryReaddir(nm);
  if (!r.entries) return []; // r.err = 读不动; 它自己已在绑定表里, 少一层间接目标好过组装崩掉
  for (const e of r.entries) {
    if (!e.isSymbolicLink()) continue;
    const r = tryRealpath(join(nm, e.name));
    if (!r.path) continue; // r.err = 悬空链接
    const parent = dirname(r.path);
    if (basename(parent) === 'node_modules' && parent !== nm) out.add(parent);
  }
  return [...out];
}

/** node 工具链在宿主上的位置。@deprecated 用 {@link findExecToolchain}('node');保留是因为已有调用点与测试。 */
export type NodeToolchain = ExecToolchain;

let nodeToolchainCache: { v: NodeToolchain | null } | null = null;

/**
 * 宿主上的 node 安装位置。逻辑已搬进 `hooks/toolchain.ts`(那里按**生态表**统一处理,
 * node 只是表里的一行)—— 本函数是薄壳,理由与两条 ⚠ 见 {@link findExecToolchain}。
 */
export function findNodeToolchain(): NodeToolchain | null {
  if (!nodeToolchainCache) nodeToolchainCache = { v: findExecToolchain('node') };
  return nodeToolchainCache.v;
}

/**
 * leaf 隔离默认只读绑定: bun 可执行目录 + node 安装根 + root 子树下全部 node_modules
 * (供 bun/node/tsc 解析依赖)。两条 ⚠ 分别见 {@link findNodeToolchain} 与 {@link collectNodeModules}。
 */
export function defaultRoBinds(root: string): string[] {
  const bunDir = dirname(process.execPath);
  const tc = resolveToolchainBinds(root);
  return [...new Set([bunDir, ...tc.roBinds, ...collectNodeModules(root)])];
}

/** pi agent dir 里的大只读件 (rw 副本排除、jail 内 ro 叠挂): 依赖/扩展机器 + 宿主私有 sessions。 */
const PI_AGENT_BIG_DIRS = ['npm', 'node_modules', 'pi-rogue'] as const;
const PI_AGENT_COPY_EXCLUDE = new Set<string>([...PI_AGENT_BIG_DIRS, 'sessions']);

/** bwrapArgs 可选件。 */
export interface BwrapOpts {
  /** makePiAgentCopy() 产的即弃 rw 副本目录 — 挂 jail /tmp/.pi/agent (见 bwrapArgs 内注释)。 */
  piAgentCopy?: string;
  /** {@link resolveGitBinds} 的产物 — 给了才把 git 元数据挂进视图 (见那里的取舍)。 */
  gitBinds?: GitBinds;
}

/** worktree 的 git 元数据位置: 本树自己的 gitdir (rw) + 共享的 common dir (ro)。 */
export interface GitBinds {
  /** `git rev-parse --absolute-git-dir` — worktree 是 `<主repo>/.git/worktrees/<名>`。 */
  gitDir: string;
  /** `git rev-parse --git-common-dir` (绝对化) — 主 repo 的 `.git` (objects/refs 都在这)。 */
  commonDir: string;
}

/**
 * 解析 root 这棵树的 git 元数据位置; **只在它落在 root 之外时**返值 (落在里面的话
 * `--bind root root` 已经带上了, 不必也不该再挂一次)。不是 git 树 / git 不可用 → null。
 *
 * 为什么需要这个: `git worktree add` 出来的树里 `.git` 是一个**指针文件**, 指向
 * `<主repo>/.git/worktrees/<名>` —— 那个路径在 jail 里不存在, 于是隔离叶里 git 全灭
 * (2026-08-11 run 7d50fda2 实测: 叶子反复试探 git 后放弃, 12 轮空转的真实摩擦面;
 * jail 内 `git status` → `fatal: not a git repository: …/.git/worktrees/…`)。
 */
export function resolveGitBinds(root: string): GitBinds | null {
  const p = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--absolute-git-dir', '--git-common-dir'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (p.exitCode !== 0) return null;
  const [gitDir, common] = new TextDecoder().decode(p.stdout).trim().split('\n');
  if (!gitDir || !common) return null;
  // `--git-common-dir` 在主 repo 里返的是相对路径 (`.git`) —— 按 root 绝对化 (实测: 主 repo 返
  // `.git`, worktree 返绝对路径; 只认一种写法就会在另一种上悄悄挂错地方)。
  const commonDir = resolve(root, common);
  // 都在 root 里面 = 普通 repo, `--bind root root` 已覆盖 → 无事可做。
  if (gitDir.startsWith(`${resolve(root)}/`) && commonDir.startsWith(`${resolve(root)}/`)) return null;
  return { gitDir, commonDir };
}

/**
 * 造 ~/.pi/agent 的**即弃 rw 副本** (每 leaf 一份, 用完调用方 rmSync): 小状态文件全拷
 * (models.json/auth.json/extensions/fiale-plus/… ≈3MB), 大只读件与宿主 sessions 排除
 * (jail 内 sessions 用全新空目录 — 不暴露宿主会话史)。~/.pi/agent 不存在 → null (worker
 * 退回 env 内建 provider, 07-23 基线行为)。
 * ⚠ OAuth 刷新落在副本里即弃 — 会轮换 refresh-token 的 OAuth provider 别做 leaf 模型
 * (leaf 走 env-key provider: mimo/Go); 记忆 kimi-oauth 恒挂重放同源约束。
 */
export function makePiAgentCopy(): string | null {
  const real = join(homedir(), '.pi', 'agent');
  if (!existsSync(real)) return null;
  const dir = mkdtempSync(join(tmpdir(), 'omd-pi-agent-'));
  cpSync(real, dir, {
    recursive: true,
    filter: (src) => !(dirname(src) === real && PI_AGENT_COPY_EXCLUDE.has(basename(src))),
  });
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  return dir;
}

/**
 * 组 bwrap argv (不含末尾要跑的程序)。root 同路径 rw 挂载; roBinds 只读; 系统只读; 只挂真存在的目录。
 * chdir 到 root → 子进程 process.cwd() = worktree, 主 repo 物理不可见。
 */
export function bwrapArgs(root: string, roBinds: string[], opts: BwrapOpts = {}): string[] {
  const args: string[] = [
    '--unshare-user',
    '--unshare-pid',
    '--die-with-parent',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];
  for (const p of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']) {
    if (existsSync(p)) args.push('--ro-bind', p, p);
  }
  // DNS (WSL2 resolv.conf 符号链接真身) + 调用方 roBinds (node_modules/bunDir), 去重、只挂存在的。
  for (const p of [...new Set([...dnsBinds(), ...roBinds])]) {
    if (p && existsSync(p)) args.push('--ro-bind', p, p);
  }
  args.push('--bind', root, root);
  // git 元数据 (只在调用方显式要 —— 见 sandboxed-leaf 的 `sandboxGit`):
  //   · commonDir **只读**: objects/refs 全在这, 读得到就够 log/show/diff/blame 跑;
  //     给写权等于让一个 jail 里的叶子能改主 repo 的 refs, 那是隔离要挡的第一件事。
  //   · gitDir **可写**: `git status` 要刷新 index。它是本 worktree 私有的那份, 写坏也只坏这棵树。
  // 顺序不能反: bwrap 按给定顺序叠挂, 子路径要在父路径之后才盖得住。
  // ⚠ eval 档**不给**这两个绑定 —— 那里的隔离正是为了挡 `git show <commit>:file` 当 oracle
  // (见本文件头注); 生产隔离档没有 oracle 可作弊, 而叶子确实需要 git。两档的要求相反,
  // 所以是调用方显式选, 不在这里按"是不是 worktree"自动猜。
  if (opts.gitBinds) {
    args.push('--ro-bind', opts.gitBinds.commonDir, opts.gitBinds.commonDir);
    if (opts.gitBinds.gitDir !== opts.gitBinds.commonDir) args.push('--bind', opts.gitBinds.gitDir, opts.gitBinds.gitDir);
  }
  // 生态的 HOME 缓存/配置 (Playwright 浏览器、pnpm store、~/.npmrc 的 registry token、~/.gitconfig 的
  // 提交身份 …): jail 的 HOME 是 /tmp, 所以 dest 落在 /tmp 下的**同一相对位置**。
  // ⚠ 必须排在 `--tmpfs /tmp` 之后 —— bwrap 按给定顺序叠挂, 反了就被 tmpfs 整个盖掉。
  const toolchain = resolveToolchainBinds(root);
  for (const h of toolchain.homeBinds) args.push('--ro-bind', h.src, h.dest);
  args.push('--chdir', root);
  // pi agent dir 分层挂载 (2026-07-25 三轮实证): HOME=/tmp 后 worker 缺 /tmp/.pi/agent →
  // 注册制 provider (mimo-platform/opencode-go/…) 全消失, leaf 全军覆没 leafTokens=0。
  // 但直接 ro-bind 真身也不行 —— pi session 栈要在 agent dir 里**写** (EROFS 被静默吞成
  // 0-token empty-done); 全量 rw 副本又 713MB 不可行。分层: opts.piAgentCopy (小状态文件
  // 的即弃 rw 副本, makePiAgentCopy 产) 挂 /tmp/.pi/agent, 大只读件 (npm/node_modules/
  // pi-rogue, extension 机器启动链必需 — 缺 node_modules 时 pi 会试跑 npm install) ro 叠上。
  if (opts.piAgentCopy) {
    const real = join(homedir(), '.pi', 'agent');
    args.push('--bind', opts.piAgentCopy, '/tmp/.pi/agent');
    for (const big of PI_AGENT_BIG_DIRS) {
      const p = join(real, big);
      if (existsSync(p)) args.push('--ro-bind', p, `/tmp/.pi/agent/${big}`);
    }
  }
  args.push('--setenv', 'HOME', '/tmp');
  // TMPDIR 必须洗 (2026-07-25 实证): 宿主 shell 的 TMPDIR (如 ~/.cache/tmp) 泄进 jail 后,
  // pi bash 工具往 os.tmpdir() 写日志 → 未挂载路径 ENOENT → worker 停摆 → 超时 SIGKILL 137。
  // jail 内 tmp 一律指向 tmpfs /tmp (hermetic, 不 bind 宿主 cache)。
  for (const k of ['TMPDIR', 'TEMP', 'TMP']) args.push('--setenv', k, '/tmp');
  // PATH: bun (omd 自己的运行时) + **仓用到的每个生态**的可执行目录 + 系统。
  // ⚠ 缺 node 那一段的代价见 hooks/toolchain 的模块头 —— 四个 run 零产出, 症状伪装成「模型不行」。
  // 一个都找不到 → 退回原行为 (纯 bun 仓照旧能跑), 不因为找不到就拦。
  const pathDirs = [...new Set([dirname(process.execPath), ...toolchain.pathDirs, '/usr/bin', '/bin'])];
  args.push('--setenv', 'PATH', pathDirs.join(':'));
  return args;
}
