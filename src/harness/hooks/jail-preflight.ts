/**
 * hooks/jail-preflight —— **构造期就把 jail 的挂载面对一遍**(jail 自检层①,2026-08-21)。
 *
 * ## 为什么是纯函数,不是探针
 *
 * jail 是 **per-leaf** 构造的(`sandboxed-leaf.ts` 每次 leaf 调用 spawn 一个 bwrap),所以任何
 * "起跑前跑一组探针"都会**乘以叶子数**。而那几笔事故里的大部分,**在 argv 上就看得出来** ——
 * argv 是数据,判它是微秒级的,而且这里只在**造 runner 的时候**跑一次(不是每个 leaf 一次)。
 *
 * 三层里这是第一层:
 *   ① 构造期纯函数断言(本模块)—— argv 上能判的,不跑任何东西
 *   ② 复用已缓存的真探针(`probeShellSandbox`,`mcp/assemble.ts` 接)—— 内核给不给 userns
 *   ③ 失败分类器(`jail-diagnosis.ts`)—— 跑挂之后认「挂载面缺 X」而不是「模型不行」
 *
 * ## 它治的病:jail 内缺了外面有的东西,而每次不完整都伪装成"模型不行"
 *
 * | 事故 | 本模块能不能在起跑前判 |
 * |---|---|
 * | `3f8e366` 隔离档下 agent leaf 一个都起不来(9 节点全灭,产物零) | 能 —— worker 路径在不在任何挂载覆盖下 |
 * | **S-34** 沙箱拿走 git → 尺子同场失真,读数被写成「叶子空转」 | 能 —— 要了 git 而 gitBinds 缺席 |
 * | `86e6cdb` `findNodeModules` 未返 realpath → jail 内依赖解析悬空 | 能 —— bind 源是不是 realpath |
 * | 挂载顺序反了(子路径被父路径盖住) | 能 —— `--bind root` 必须排在覆盖它的 `--ro-bind` 之后 |
 *
 * ⚠ 最后一笔(路径长度撞 `computeSig`)**不在这里判**:那条已经在 `drift-detector.ts` 的
 * `pathSig` 取尾修掉了(注释逐字:「取尾不取头」)。在这里再判一次就是第二份会漂的判据。
 *
 * ## 分级
 *
 * · `fatal` —— 必然导致**所有** leaf 全灭。当场抛,与 `resolveWorker` 同一条理由:
 *   让它到第一个 leaf 才炸,代价是先烧掉一整轮 conductor 规划(`3f8e366` 就是这么烧的)。
 * · `warn` —— 会让读数失真但不一定跑不动。响亮留证,不拦。
 *   **刻意不抛**:假 fatal 的代价是有人把整条闸关掉(S-45 收窄时买过一次)。
 *
 * @module
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export type JailProblemLevel = 'fatal' | 'warn';

export interface JailProblem {
  level: JailProblemLevel;
  /** 缺什么 / 哪里不对(判词主语)。 */
  what: string;
  /** 下一步 —— 与"模型不行/加时间/换池"明确区分开。 */
  fix: string;
}

export interface JailPreflightInput {
  /** 组好的 bwrap argv(不含末尾要跑的程序)。 */
  argv: readonly string[];
  /** jail 根 = 隔离 worktree 绝对路径。 */
  root: string;
  /** worker 脚本路径(相对 root 或绝对)。 */
  workerPath: string;
  /** 调用方**显式要了** git 元数据(`sandboxGit`)。false = 本档不要 git,缺席不算问题。 */
  wantGit: boolean;
  /**
   * **调用方给的** ro-bind 源(`node_modules` / omd 安装目录 …)—— realpath 那条只查这些。
   *
   * ⚠ 刻意**不查** argv 里全部的 bind 源(2026-08-21 实测收窄):`bwrapArgs` 自己会挂
   * `/usr /bin /sbin /lib /lib64 /etc`,而这台机器上 `/bin /sbin /lib /lib64` **四个都是 symlink**
   * (→ `/usr/*`,现代发行版的 usrmerge 布局)。查它们等于每次跑打 4 条噪音,
   * 而**假阳性的代价是有人把整条闸关掉**(S-45 收窄时买过一次)。
   * 86e6cdb 那笔的现场也正是调用方给的那半(`findNodeModules` 未返 realpath)。
   */
  roBinds: readonly string[];
}

export interface JailPreflightDeps {
  /** 解析 realpath;抛错 = 路径不存在/解析不了。注入是为了在测试里造 symlink 世界。 */
  realpath?: (p: string) => string;
  /** 路径是否存在。注入是为了在测试里造「PATH 上有没有 node」的两臂。 */
  exists?: (p: string) => boolean;
  /** 读文本;抛错 = 读不到。只用来看 `<root>/package.json` 有没有声明 workspaces。 */
  readText?: (p: string) => string;
}

/** argv 里所有 `--ro-bind SRC DST` / `--bind SRC DST` 的 **SRC**(挂载源)。 */
export function bindSources(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === '--ro-bind' || argv[i] === '--bind') out.push(argv[i + 1]!);
  }
  return out;
}

/** `p` 是否落在 `dir` 之内(或就是它)。纯字符串判断 —— 两边都该是绝对路径。 */
function under(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

/**
 * 对一遍。**零 IO 除了 realpath**(而 realpath 只对 bind 源跑,数量是个位数)。
 *
 * @returns 问题列表;空数组 = 挂载面对得上。
 */
export function checkJailArgv(input: JailPreflightInput, deps: JailPreflightDeps = {}): JailProblem[] {
  const { argv, root, workerPath, wantGit, roBinds } = input;
  const realpath = deps.realpath ?? realpathSync;
  const exists = deps.exists ?? existsSync;
  const readText = deps.readText ?? ((p: string) => readFileSync(p, 'utf8'));
  const problems: JailProblem[] = [];
  const sources = bindSources(argv);

  // ① 工作根必须有**可写**绑定 —— 没有它 leaf 一个字都写不出来, 而症状是"产物为空"。
  const rootRw = argv.some((a, i) => a === '--bind' && argv[i + 1] === root);
  if (!rootRw) {
    problems.push({
      level: 'fatal',
      what: `jail 里工作根 ${root} 没有可写绑定`,
      fix: '在 bwrapArgs 里补 `--bind <root> <root>`。没有它每个 leaf 都会被产物闸判空转, 而那看起来像"模型不干活"',
    });
  }

  // ② worker 必须落在**某个挂载覆盖**之下 —— 否则 jail 里 `bun run <worker>` 直接
  //    `Module not found`, 而这正是 3f8e366 那笔: 9 节点全灭、产物零, 单测与容器性探针全绿
  //    (它们测的是 jail 关不关得住, 不是 worker 找不找得到)。
  if (workerPath.startsWith('/')) {
    const covered = sources.some((s) => under(workerPath, s));
    if (!covered) {
      problems.push({
        level: 'fatal',
        what: `worker 脚本 ${workerPath} 不在任何挂载覆盖之下`,
        fix: '把它所在的安装目录加进 roBinds。jail 里找不到 worker = 每个 agent leaf 都起不来 (3f8e366: 9 节点全灭)',
      });
    }
  }

  // ③ 显式要了 git 却没挂 —— **S-34 那笔**。代价不是跑挂, 是**尺子同场失真**:
  //    拿不到 git 的叶子会被记成"空转", 读数被写成假的。所以判词必须点名这一层。
  if (wantGit) {
    const hasGit = sources.some((s) => s.endsWith('/.git') || s.includes('/.git/') || /\.git$/.test(s));
    if (!hasGit) {
      problems.push({
        level: 'warn',
        what: '调用方要了 git 元数据, 而 argv 里没有任何 git 目录绑定',
        fix: '看 resolveGitBinds 为什么返 null (root 不是 git 树?)。⚠ 这一笔的真代价是**读数被写成假的** (S-34), 不是跑挂 —— 拿不到 git 的叶子会被记成"空转"',
      });
    }
  }

  // ④ bind 源必须是 realpath —— symlink 让 jail 内解析悬空 (86e6cdb: findNodeModules 未返 realpath)。
  //    ⚠ 判 `warn` 不判 `fatal`: 有些 symlink 是良性的 (挂进去照样读得到), 只有依赖解析那类才炸。
  //    宁可少拦一次也不造假 fatal —— 假 fatal 的代价是有人把整条闸关掉。
  //    ⚠ 只查**调用方给的** roBinds, 不查 argv 里全部的源 —— 理由见 JailPreflightInput.roBinds 的注
  //    (系统目录本身就是 symlink, 查它们每次跑打 4 条噪音)。
  for (const s of [...new Set(roBinds)]) {
    let real: string;
    try {
      real = realpath(s);
    } catch {
      problems.push({
        level: 'warn',
        what: `挂载源 ${s} 解析不了 (不存在?)`,
        fix: 'bwrapArgs 只挂 existsSync 为真的路径, 这条能出现说明它在组 argv 之后没了 —— 查竞态',
      });
      continue;
    }
    if (real !== s) {
      problems.push({
        level: 'warn',
        what: `挂载源 ${s} 是 symlink (真身 ${real})`,
        fix: '挂 realpath 而不是 symlink。jail 内没有那条链的另一端时依赖解析会悬空 (86e6cdb)',
      });
    }
  }

  // ⑤ 叠挂顺序: `--bind root root` 必须排在**任何覆盖 root 的 ro-bind** 之后, 否则可写那层被盖住,
  //    组出来的 argv 长得完全正常而跑起来是个只读沙箱 (与对话位围栏那条同一个坑)。
  const rootIdx = argv.findIndex((a, i) => a === '--bind' && argv[i + 1] === root);
  if (rootIdx >= 0) {
    for (let i = rootIdx + 1; i < argv.length - 2; i++) {
      if (argv[i] === '--ro-bind' && under(root, argv[i + 1]!)) {
        problems.push({
          level: 'fatal',
          what: `只读绑定 ${argv[i + 1]} 排在工作根的可写绑定之后, 会把它盖成只读`,
          fix: 'bwrap 按给定顺序叠挂 —— 子路径要在父路径**之后**。顺序反了就是一个看起来装了、其实全只读的沙箱',
        });
        break;
      }
    }
  }

  // ⑥ 仓的验收命令基本都是 npx/npm 时, jail 的 PATH 里必须有 node —— **2026-09-04 plana 实账**。
  //    omd 自己跑在 bun 上, 而 jail 的 PATH 原本只有 `dirname(process.execPath)`, 于是 jail 里只有 bun。
  //    ⚠ 判 `warn` 不判 `fatal`, 按本模块的分级定义: leaf 起得来、跑得动, **坏的是读数** ——
  //    叶子退而用 bun 顶替, bun 的 subpath 解析与 node 不一致, 假报一批测试失败, 于是基线不可复现,
  //    硬约束一条都判不了。这正是 warn 那一栏写的「会让读数失真但不一定跑不动」。
  //    (真代价: 四个 run 零产出, 而四份报告都把它描述成环境问题 —— 它们是对的, 只是没人在起跑前看。)
  if (exists(join(root, 'package.json'))) {
    const jailPath = setenvValue(argv, 'PATH') ?? '';
    const hasNode = jailPath
      .split(':')
      .filter(Boolean)
      .some((d) => exists(join(d, 'node')));
    if (!hasNode) {
      problems.push({
        level: 'warn',
        what: `仓有 package.json, 而 jail 的 PATH 里没有 node (PATH=${jailPath || '(空)'})`,
        fix: '看 findNodeToolchain 为什么返 null (宿主 PATH 上没有 node?)。⚠ 真代价是**读数被写成假的**: 叶子会用 bun 顶替 npx, 而 bun 的 subpath 解析与 node 不一致 → 假报测试失败 → 基线不可复现',
      });
    }
  }

  // ⑦ workspaces monorepo 的依赖分散在**嵌套** node_modules 里 —— 只绑一份等于给叶子一棵残缺依赖树。
  //    症状不是"缺个包"这么干净: 叶子会跑 `npm install` 自救, 那次 install 会改写 workspace 软链,
  //    造出一棵混合坏树, 然后报出一堆与本次改动无关的错 (plana: 4 个 tsc 错, 查了八个假设才定位)。
  if (declaresWorkspaces(join(root, 'package.json'), readText)) {
    const nmBinds = sources.filter((s2) => s2.endsWith('/node_modules'));
    if (nmBinds.length < 2) {
      problems.push({
        level: 'warn',
        what: `仓声明了 workspaces, 而 argv 里只绑了 ${nmBinds.length} 份 node_modules`,
        fix: 'defaultRoBinds 应走 collectNodeModules (收全子树), 不是 findNodeModules (只收最近一份)。⚠ 残缺依赖树不会安静失败 —— 叶子会 npm install 自救并把 workspace 软链改写坏',
      });
    }
  }

  return problems;
}

/** argv 里 `--setenv <名> <值>` 的值;没有则 null。 */
function setenvValue(argv: readonly string[], name: string): string | null {
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === '--setenv' && argv[i + 1] === name) return argv[i + 2]!;
  }
  return null;
}

/** `<root>/package.json` 是否声明了 workspaces(npm/yarn 数组 或 pnpm 对象皆认)。读不到 → false。 */
function declaresWorkspaces(pkgPath: string, readText: (p: string) => string): boolean {
  try {
    const w = (JSON.parse(readText(pkgPath)) as { workspaces?: unknown }).workspaces;
    return Array.isArray(w) ? w.length > 0 : typeof w === 'object' && w !== null;
  } catch {
    return false;
  }
}

/** 判词渲染 —— 一行,进日志与抛出的错误消息。 */
export function describeJailProblems(ps: readonly JailProblem[]): string {
  return ps.map((p) => `[${p.level}] ${p.what} → ${p.fix}`).join(' | ');
}
