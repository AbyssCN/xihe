/**
 * src/harness/agent-tools —— agent leaf 的**自有工具集** (read / write / edit / ls / grep / bash)。
 *
 * 为什么自己长一套, 而不是继续借 `pi-coding-agent` 的:
 *   ① 那是 **CLI 包**的工具 —— 每个都拖着 TUI 渲染 (`renderCall`/`renderResult`/主题/高亮), 而 headless
 *      leaf 一行都用不上; 为了拿工具循环去依赖一个交互式前端, 是整个错配的源头。
 *   ② 闸的位置不对。此前命令白名单 / `dangerous-cmd` / 凭证 basename 拒是靠 `tool-gate` extension
 *      **从外面贴**在通用工具上的 —— 贴上去的闸可以忘了贴 (`cat .env` 那个洞正是这么漏的:
 *      闸落在 command-leaf 的白名单上, agent leaf 的 bash 不经它)。
 *      **工具自己就是闸**的形态下, 拿到工具就拿到闸, 没有"忘了挂"这个状态。
 *
 * 底料取自 `pi-agent-core` 的 primitives (`NodeExecutionEnv` 执行环境 · `executeShellWithCapture`
 * 输出截断 · `truncateHead`/`truncateLine` 上限), 不是从零写 IO。
 *
 * 边界诚实 (同 command-leaf 头): 凭证拒是**护栏不是沙箱** —— `grep -r KEY .` 递归扫到 `.env` 仍会
 * 打印内容, `bun -e` 等价任意代码执行。它挡的是"模型顺手 cat 一下配置"这类手滑, 不是对抗性外泄。
 * 真隔离在 agent leaf 的 bwrap jail (hooks/sandboxed-leaf.ts)。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  executeShellWithCapture,
  sanitizeBinaryOutput,
  truncateHead,
  truncateLine,
} from '@earendil-works/pi-agent-core';
import { type Static, type TSchema, Type } from 'typebox';
import { classifyCommand } from './hooks/dangerous-cmd';
// 写域闸 (写前, 与沙箱边界正交): 节点只准写自己声明的写集。
import { checkWriteAllowed, describeWriteDenied } from './writeset/write-allow';
import { checkWriteVersion, describeVersionDenied, observePath, type FileObservation } from './writeset/write-version';
import { type CommandPolicy, DEFAULT_SANDBOX_CONFIG, judgeCommand } from './hooks/command-policy';
import { sandboxCommand } from './hooks/shell-sandbox';
import type { AcceptanceOutcome } from './acceptance-run';
import { gitWriteBlockReason, secretPathInCommand, SECRET_BASENAMES, SECRET_BASENAME_EXEMPT } from './command-leaf';
import { logger } from '../logger';
import { openTouchLedger, type TouchLedger, type TouchOp, type TouchSource } from './writeset/touch-ledger';
import { verifiedShellWriteTargets } from './writeset/shell-writes';
import { classifyShellReadonly, observeSafely, type ReadEvent } from './read-ledger';
import { HAND_TOOL_RENDERERS } from './tool-render';

/**
 * SDD D4.2 (2026-09-01): goal 文本里的「不许改动 `path`」路径禁令 ——
 * 修复轮无防作弊闸, 把它做成 L1 工具闸 (fail-closed)。
 *
 * 提取层 = `./goal/goal-protections.ts` 的纯函数 `extractProtectedPaths`;
 * 这里只负责把提取结果在**工具调用那一刻**判拒, 拒绝词带路径原文 + 禁单出处。
 *
 * 接线 = AsyncLocalStorage, 与 agent-leaf 的 touchSession 同形态:
 * 装配期不持有, 调用期由 `withProtectedPaths(paths, fn)` 喂入; 并发 leaf 各自一份
 * 上下文互不串 (enterWith 会串到调用方, 这里与 agent-leaf 同样用 `run` 隔离)。
 *
 * 闸缺席 (= ALS 上下文里没设) = 零行为变化, 与今日逐字节同 (INV-3)。
 */
const protectedPathsStore = new AsyncLocalStorage<readonly string[] | undefined>();

/**
 * 把当前调用上下文标成「本次 leaf 写不得触碰这些路径」(SDD D4.2 / INV-2)。
 *
 * 调用方 = `run-goal.ts`: 在 `agentRunner` 入口包一层, 提取自 `goal` 文本。
 * **thunk 不是值**: 提取结果是配置期一锤定音的常量 (一次 run 一份 goal 文本),
 * 但 runner 跨 run 复用 → 不能烤进装配期, 必须按调用落 (与 writeAllow 同条纪律)。
 */
export function withProtectedPaths<T>(paths: readonly string[] | undefined, fn: () => T): T {
  if (paths === undefined || paths.length === 0) return fn();
  return protectedPathsStore.run(paths, fn);
}

/**
 * omd 工具 = `AgentTool` + 两个**给系统提示用**的可选字段。
 *
 * 这两个字段本是 pi CLI 的 `ToolDefinition` 才有的 (它拿去拼默认系统提示)。搬家后系统提示由
 * 我们自己拼 (`buildLeafSystemPrompt`), 于是字段也留在自己这边 —— 工具与"怎么跟模型介绍它"
 * 长在一起, 加一个工具不必再改第二处。
 */
export interface OmdTool<TDetails = unknown> extends AgentTool<TSchema, TDetails> {
  /** 系统提示「可用工具」段的一行说明。省略 = 不进那一段 (工具仍可调用)。 */
  promptSnippet?: string;
  /** 系统提示「守则」段追加的条目 (如 hashline 的用法铁律)。 */
  promptGuidelines?: string[];
  /** 声明 true = 扩展作者确认工具沙箱叶内安全。未声明/非 true → sandboxed-leaf 剥除 + warn。 */
  sandboxSafe?: boolean;
  /**
   * H6 (#187, owner 2026-08-20 裁 A 案): **规范值 → 展示串**的纯函数投影。
   *
   * `execute` 返回的 `details` 是规范值; `render` 把它投成人看的那半句。**纯函数, 不重跑工具**
   * —— 回放一条历史调用、eval 采 fixture、给人/给模型投两种详略, 都不必再跑一次工具。
   * 省略 = 这个工具没有可投的那半句 (调用方就不画, **不编一个占位**)。
   *
   * 实现体在 `tool-render.ts` (单一真源, 覆盖闸读同一份)。搬来之前它是 UI 里按工具名派发的
   * switch —— 改名即静默失效 (名字对不上就落 null, 屏上那半句无声消失)。
   */
  render?: (details: TDetails) => string | null;
}

/** 工具执行体的松类型面 —— 各工具 schema 各不同, 装进同一个数组时统一按这个形状看。 */
export type AnyOmdTool = OmdTool<any>;

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: 'text', text }], details };
}

/** sha256 hex —— strict 档的 hash 列 (NULL≠0 纪律: 算过就是算过, 空内容也有 hash)。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * SDD S3 碰撞台账写入 (只记不拦): 开了 touch 才记。**fail-open 不吞证据** ——
 * recordTouch 自身 warn 留痕 (touch-ledger.ts), 这里只负责别让工具出口失败。
 * session 支持 getter: 同一 runner 跨 run 复用 (MCP 长驻进程) 时 runId 只在调用期可知,
 * 由 agent-leaf 的 AsyncLocalStorage 按调用喂 (getter 返 undefined = 本次不记)。
 */
function touchWrite(
  openLedger: () => TouchLedger | null,
  touch: OmdAgentToolsOpts['touch'],
  input: { path: string; op: TouchOp; hash?: string | null; source?: TouchSource },
): void {
  if (!touch) return;
  const session = typeof touch.session === 'function' ? touch.session() : touch.session;
  // ⚠ #262: **先判 session 再开库** —— 顺序反了懒开就白做 (每个 cwd 照样长一个空 touch.db)。
  if (!session) return;
  const ledger = openLedger();
  if (!ledger) return;
  ledger.recordTouch({ path: input.path, session, op: input.op, hash: input.hash, source: input.source });
}

/** 相对路径对 cwd 解析; 绝对路径原样 (沙箱由 bwrap jail 管, 不在这里拦)。 */
function abs(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** 展示用: 尽量给 cwd 相对路径 (逃出 cwd 的给绝对), 让模型看到的路径可直接回填。 */
function display(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absolute;
}

/**
 * **凭证文件拒** —— 判据是 basename, 与 command-leaf 同一张表 (`SECRET_BASENAMES`)。
 * 两处各写一份早晚一份先漂, 而漂掉的那份就是下一个 `cat .env`。
 * (export 给 TUI 审批层的 `read_sensitive` 分类用 —— 同一个判据, 不抄第二份。)
 */
export function secretBasenameOf(path: string): string | null {
  const norm = path.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (SECRET_BASENAME_EXEMPT.test(base)) return null;
  return SECRET_BASENAMES.some((re: RegExp) => re.test(base)) ? base : null;
}

/**
 * 凭证文件**只告警不拦**(owner 2026-08-07 裁决:「去掉这个」)。
 *
 * ## 原来是硬抛, 代价是真的
 *
 * `read` 按 basename 拒、`bash` 把命令按 `;&|` 拆段逐段拒 —— 于是"看一眼 .env 里那一项
 * 是不是配错了"这种**正当排查**也被一并挡死。而它挡的从来只是"模型顺手 cat 一下配置"
 * 这类手滑:同一张表按**文件名**判、不按**内容**判,`grep -r SECRET .` 照样打印命中行,
 * `node -e` 一旦成立读什么都不过这张表。**挡不住对抗,只挡得住手滑** —— 代价却是常规能力。
 *
 * ## 但不许吞证据
 *
 * 告警行原样留着:读过哪个凭证文件必须在日志里看得见。fail-open 可以吞异常, 不许吞证据。
 *
 * ## 它该去哪
 *
 * 正确的形态是审批层的 `read_sensitive` 档(先给预览、要继续才审批)——
 * 见 `docs/design/2026-08-07-omd-agent-架构与-tui-设计稿.html` 第八节。
 * 那一档做出来之后, 这里改成"报给审批层"而不是"直接放行"。
 * ⚠ **command-leaf 那一层的同名闸没有动**:它管的是 DAG 验收命令, 与对话位的手是两回事。
 */
function warnSecret(path: string): void {
  const base = secretBasenameOf(path);
  logger.warn({ path, base }, '[omd/agent-tools] 读了凭证文件 (只告警不拦; 审批层做出来后改走 read_sensitive)');
}

// ── 目录遍历 (grep / 隐式扫描共用) ─────────────────────────────────────────────

/**
 * 遍历默认跳过的目录名 —— 扫进去只会把真命中淹掉 (且 node_modules 动辄十万文件)。
 *
 * export 是给 `scripts/probes/repo-file-count.ts` 用的:「这个仓离遍历上限还有多远」
 * 必须按**实装的同一张表**算, 探针里抄一份就会与 agent 真正走的树漂开。
 */
export const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache', '.venv',
  // Python 缓存。⚠ 这两个**留在精确匹配里**是有理由的:真实世界里就叫这两个名字, 没有
  //   `.venv-xxx` 那样的变体, 所以不该塞进 `shouldSkipDir` 的正则去 ——
  //   正则收得越宽, 误跳正常源码目录(`mypy_cache_utils/`)的面就越大。
  '.mypy_cache', '.pytest_cache',
  '__pycache__', 'target', 'vendor',
]);

/**
 * 跳不跳这个目录。**不是纯精确匹配** —— 精确匹配漏掉了 Python 虚拟环境的全部变体。
 *
 * ## 实测(2026-08-08,本机四个仓)
 *
 * `SKIP_DIRS` 里只有 `.venv`,而真实世界的名字是 `.venv-crawl4ai` / `.venv-seuranta` /
 * `.venv-pg` —— **精确匹配一个都没拦住**,三个仓各有 1–2 个逃出去:
 *
 * | 仓 | 逃出去的 |
 * |---|---|
 * | talous-v2 | `.venv-seuranta` · `.venv-crawl4ai` |
 * | fusang | `.venv-pg` |
 * | bluebell | `.venv-seuranta` |
 *
 * 代价是可量的:`talous-v2` 的 `.venv-crawl4ai` 一个目录就占该仓 SKIP_DIRS 口径文件数的
 * **58%**(11,150 / 19,177)—— 遍历预算全烧在 `site-packages` 上,而那里面**没有一行**
 * 是这个仓的代码。
 *
 * ⚠ 收敛处**要求分隔符**(`venv` 后面必须是结尾或 `-._`),所以 `venvironment/` 这类
 * 正常源码目录不会被误跳。反测钉了这一条。
 */
export function shouldSkipDir(name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  return /^\.?venv($|[-._])/.test(name);
}

/** 简易 glob → RegExp (`*` 不跨 `/`, `**` 跨, `?` 单字符)。够 `*.ts` / `src/**\/*.test.ts` 用。 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` 也匹配零层目录
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${re}$`);
}

/**
 * **远端 / 慢挂载的文件系统类型**(2026-08-13,WSL 卡死事故的修法)。
 *
 * ## 这张表是拿一次真事故换来的
 *
 * 2026-08-13:`omd tui` 的 conductor 让 `grep` 走进 `/mnt/d` —— 那是 WSL 的 **9p drvfs**
 * 挂载。后果不是慢,是**整台机器的 WSL 停摆**:9P 桥被递归遍历打爆之后,任何碰 Windows
 * 文件的操作无限期挂起,连新开一个 shell 都卡在解析 PATH(PATH 里有 `/mnt/c` 下的路径),
 * 于是终端一片全黑、不报错。`omd tui` 进程本身占满一个核 **3 小时 48 分**。
 *
 * ⚠ **占核的是 TUI 主进程,不是子进程** —— 因为 `walkFiles` 是**进程内** JS:
 * 它不进 bwrap 围栏(围栏只包 bash)、`bashTimeoutSec` 管不着它、Esc 也打断不了。
 * 这就是为什么闸必须加在这里,而不只是加在沙箱那一侧。
 *
 * 判据是 **fstype 不是路径** —— 写死 `/mnt` 只挡得住 WSL 一种形态,而 NAS(`/mnt/nas*`)、
 * sshfs、rclone 挂在哪儿是用户定的。本机实测 `/proc/mounts`:
 * `/mnt/c` `/mnt/d` = `9p`,另有 `/mnt/nas` `/mnt/nas-backups` `/mnt/nas-marketing`。
 */
export const REMOTE_FS_TYPES: ReadonlySet<string> = new Set([
  '9p', 'drvfs', 'cifs', 'smbfs', 'smb3', 'nfs', 'nfs4', 'afs', 'ceph', 'glusterfs', 'davfs', 'afpfs',
]);

/** `fuse.` 开头的一族按前缀判(`fuse.sshfs` / `fuse.rclone` / `fuse.s3fs` …)—— 逐个登记必漏新成员。 */
const REMOTE_FUSE_PREFIX = 'fuse.';

/** 一条 fstype 算不算远端。`fuse.` 前缀 + 上面那张表。 */
export function isRemoteFsType(fstype: string): boolean {
  return REMOTE_FS_TYPES.has(fstype) || fstype.startsWith(REMOTE_FUSE_PREFIX);
}

/**
 * 读 `/proc/mounts` 挑出远端挂载点(绝对路径,去重)。
 *
 * 读不到(非 Linux / 权限)→ **空表 + 不抛**:遍历闸是护栏不是承重件,
 * 拿不到挂载表时退回"没有远端挂载"的旧行为,而不是让 `grep` 整个失败。
 * ⚠ 但这条 fail-open 不吞证据 —— 调用方拿到的 `skippedMounts` 是空,
 * 与"读到了且确实没有远端挂载"同形。两者都不该发生在正常 Linux 上,不值得再分一列。
 */
export function readRemoteMounts(procMounts = '/proc/mounts'): string[] {
  let raw: string;
  try {
    raw = readFileSync(procMounts, 'utf8');
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const line of raw.split('\n')) {
    // 格式: `device mountpoint fstype options dump pass`;挂载点里的空格转义成 `\040`。
    const [, mountpoint, fstype] = line.split(' ');
    if (!mountpoint || !fstype) continue;
    if (isRemoteFsType(fstype)) out.add(mountpoint.replace(/\\040/g, ' '));
  }
  return [...out];
}

/**
 * 遍历结果。**`capped` 必须往上报** —— 见下面那段。
 */
export interface WalkResult {
  files: string[];
  /** 走到上限/预算就停了 = **命中可能不全**。`false` 才代表"整棵树都走过了"。 */
  capped: boolean;
  /**
   * 因为是**远端挂载**而整棵剪掉的路径。
   *
   * ⚠ **必须往上报**,与 `capped` 同一条纪律:静默剪掉之后,`grep` 在
   * `/mnt/d` 上返回 `(无命中)` —— 而那句话读起来是"那儿没有",实际是"我没去看"。
   * 空数组 = 一棵都没剪(不是"不知道")。
   */
  skippedMounts: string[];
}

/** {@link walkFiles} 的可选件。全部有默认值 —— 调用方只给它在意的那一项。 */
export interface WalkOpts {
  /** 候选文件过滤(glob)。**在走的过程中就用**,不是走完再筛。 */
  filter?: (path: string) => boolean;
  /** 墙钟预算(ms)。超了停下并 `capped: true`。默认 {@link WALK_BUDGET_MS}。 */
  budgetMs?: number;
  /** 远端挂载点表。**注入以便可测** —— 省略 = 现读 `/proc/mounts`。 */
  remoteMounts?: readonly string[];
  /** 时钟注入(预算判定要可测,不能靠在测试里 sleep 出一个不确定的读数)。 */
  now?: () => number;
}

/**
 * 遍历的**墙钟预算**(ms)。
 *
 * ⚠ 这个数与 `GREP_WALK_LIMIT` 是**两条不同的闸**,不是一条的两种写法:
 * 条目上限管的是"走了多少",预算管的是"走了多久"。9P 上一个条目可能要几百毫秒,
 * 于是条目数远没到上限、时间已经过去几小时 —— 2026-08-13 那次正是这一种。
 */
export const WALK_BUDGET_MS = 10_000;

/**
 * 走一棵树,最多 `limit` 个文件。
 *
 * ## ★ 2026-08-08:这里原来**吞证据**
 *
 * 老版签名是 `Promise<string[]>`,走到 20_000 就 `return out`,**没有任何回报**。
 * 于是 `grep` 在大仓里会报 `(无命中)`,而真相是"needle 在盘上,只是没走到那儿" ——
 * 而 agent 收到"无命中"的合理反应就是**认定这个符号不存在**。
 *
 * 实测(单一变量 = 文件数,`/tmp/omd-scale/probe2.ts`):
 *
 * | 盘上文件数 | grep 走到并命中 | 漏 | 输出提到上限了吗 |
 * |---|---|---|---|
 * | 5,000 | 5,000 | 0 | — |
 * | 25,000 | **20,000** | **5,000** | **一个字都没说** |
 *
 * 而且不是假想:本机 `repos/talous-v2` 去掉 SKIP_DIRS 之后 **19,177** 个文件 = 上限的 96%。
 *
 * ⇒ 本仓 §3.2「**fail-open 可以吞异常,不许吞证据**」的一条实例。修法不是把上限调大
 * (那只是把同一个静默失效推远一点),是**让它说出来**。
 *
 * ## `filter` 在**走的时候**就用上,不是走完再筛
 *
 * 老版是 `walkFiles(...)` 之后再 `files.filter(globRe)` —— 于是 `grep(x, glob:'*.ts')`
 * 在大仓里先走 20_000 个**任意**文件(哈希序,不是你想要的那 20_000 个)再筛,
 * **glob 一点都帮不上逃出上限**。现在 filter 进了走的过程。
 *
 * ## ★ 2026-08-13:上限数的是**走过的条目**,不再是命中的文件
 *
 * 上一版把 filter 挪进遍历时,顺手把上限也改成只数**候选**文件 —— 那一步是错的,
 * 而且错得静默:带 `glob` 时不匹配的文件**一个都不计数**,于是
 * `grep(x, path:'/mnt/d', glob:'*.ts')` 在一整块盘上走穿都到不了 20,000,
 * **上限形同虚设,遍历实际无界**。2026-08-13 的 WSL 卡死就是这么来的。
 *
 * 现在:`limit` 数的是 **readdir 返回的条目总数**(目录 + 文件,不管过没过 filter)——
 * 也就是"干了多少活"。glob 仍然只影响**结果**,不再影响**代价**。
 * 两件事本来就该分开:一个是你想要什么,一个是允许花多少。
 *
 * ⚠ **export 是给闸用的**(同 `SKIP_DIRS` 那条):远端挂载剪枝与墙钟预算都要能被
 * 注入着量 —— 去读真机的 `/proc/mounts`,这条闸在没有网络盘的机器上就恒绿,
 * 量的是那台机器不是这段代码。
 */
export async function walkFiles(root: string, limit: number, opts: WalkOpts = {}): Promise<WalkResult> {
  const { filter, budgetMs = WALK_BUDGET_MS, now = Date.now } = opts;
  const remote = opts.remoteMounts ?? readRemoteMounts();
  const deadline = now() + budgetMs;
  const out: string[] = [];
  const skippedMounts: string[] = [];
  const stack = [root];
  /** 走过的条目数(目录+文件)。上限数它 —— 见上面那段。 */
  let visited = 0;
  let capped = false;
  /** 这个目录是不是一个远端挂载点(整棵剪掉)。前缀比较 —— 挂载点之下全部算。 */
  const isRemote = (dir: string): boolean =>
    remote.some((m) => dir === m || dir.startsWith(m.endsWith(sep) ? m : m + sep));
  /**
   * ★ **root 自己就在远端挂载上时不剪**(2026-08-13)。
   *
   * 剪的目的是挡**误入** —— 从 `/` 或 `~` 走着走着掉进 `/mnt/d`。而
   * `grep(path:'/mnt/d')` 是**明说要去那儿**,把它剪成"一层都不进"等于让这个工具
   * 在那条路径上永远返回 `(无命中)`,而那是本仓最怕的那种谎。
   * 那一支的护栏是另外两条:条目上限 + 墙钟预算 —— 它们对本地远端一视同仁。
   */
  const rootIsRemote = isRemote(root);
  outer: while (stack.length > 0) {
    // 预算先判 —— 9P 上一个 readdir 就可能几百毫秒, 判在 readdir **之前**才拦得住。
    if (now() > deadline) {
      capped = true;
      break;
    }
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 读不动的目录跳过 (权限/竞态) —— 检索 fail-open
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      visited += 1;
      if (visited > limit) {
        capped = true;
        break outer;
      }
      if (e.isDirectory()) {
        if (shouldSkipDir(e.name)) continue;
        // ★ 远端挂载整棵剪掉, 并**记下来往上报** —— 静默剪 = `(无命中)` 骗人。
        if (!rootIsRemote && isRemote(full)) {
          if (!skippedMounts.includes(full)) skippedMounts.push(full);
          continue;
        }
        stack.push(full);
      } else if (e.isFile()) {
        if (filter && !filter(full)) continue;
        out.push(full);
      }
    }
  }
  return { files: out, capped, skippedMounts };
}

// ── 工具 schema ────────────────────────────────────────────────────────────────

const READ_SCHEMA = Type.Object({
  path: Type.String({ description: 'File path to read (relative to the working root, or absolute).' }),
  offset: Type.Optional(Type.Number({ description: 'First line to read (1-indexed). Default 1.' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read.' })),
});
const WRITE_SCHEMA = Type.Object({
  path: Type.String({ description: 'File path to write (relative or absolute). Parent dirs are created.' }),
  content: Type.String({ description: 'Full file content.' }),
});
const EDIT_SCHEMA = Type.Object({
  path: Type.String({ description: 'File path to edit (relative or absolute).' }),
  oldText: Type.String({ description: 'Exact text to replace. Must occur exactly once in the file.' }),
  newText: Type.String({ description: 'Replacement text.' }),
});
const LS_SCHEMA = Type.Object({
  path: Type.Optional(Type.String({ description: 'Directory to list. Default: working root.' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum entries to return. Default 500.' })),
});
const GREP_SCHEMA = Type.Object({
  pattern: Type.String({ description: 'Regular expression (JS syntax) to search for.' }),
  path: Type.Optional(Type.String({ description: 'File or directory to search. Default: working root.' })),
  glob: Type.Optional(Type.String({ description: "Only search files matching this glob, e.g. '*.ts'." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive match. Default false.' })),
  literal: Type.Optional(Type.Boolean({ description: 'Treat pattern as a literal string. Default false.' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum matches to return. Default 100.' })),
});
const BASH_SCHEMA = Type.Object({
  command: Type.String({ description: 'Shell command to run in the working root.' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds. Default 120.' })),
});
/** `run_acceptance` 的参数面: **没有 command**(D-6)。`round` 只是给模型自己计数用的可选注记。 */
const RUN_ACCEPTANCE_SCHEMA = Type.Object({
  round: Type.Optional(Type.Number({ description: 'Optional: your own attempt counter, for your notes only.' })),
});
const VIEW_IMAGE_SCHEMA = Type.Object({
  path: Type.String({ description: 'Image file path (relative to the working root, or absolute).' }),
});

/**
 * 图片扩展名 → mime (D-1 单源真相从 `src/harness/leaf-media.ts` 借词表,
 * 改一边另一边会静默漂, 这里挂注释作交叉钉; 验收时双向核)。
 */
const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 单图字节上限 —— 与 `leaf-media.ts` 的 `DEFAULT_MAX_BYTES` 同口径 (D-1, 2026-08-25)。 */
const VIEW_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** 命中图片扩展名 → 返回 mime; 否则 null (供 read 用以早拒、view_image 用以早报)。 */
function imageMimeFor(path: string): string | null {
  return IMAGE_EXT_MIME[extname(path).toLowerCase()] ?? null;
}

/**
 * bash 截断全文的旁路累积硬顶。10 MiB 约为当前 50 KiB 正文窗的 200 倍，足够分页检索
 * 常见 build/test transcript，同时把每条失控命令额外占用的内存和磁盘写入量锁在单个数量级内。
 */
const BASH_SPILL_MAX_BYTES = 10 * 1024 * 1024;

export interface OmdAgentToolsOpts {
  /**
   * **本次调用允许写的路径**(节点 `write_set`)—— 写域闸的判据面,`write` / `edit` 写前判。
   *
   * 是 **thunk 不是值**: runner 跨 run 复用 (MCP 长驻进程), 写集只能**按调用**取,
   * 烤进装配期就会拿上一个节点的写集去判这一个 —— 同 `mcpAllow` / `touchSession` 那条纪律。
   *
   * 返回 `undefined` = **闸缺席, 放行**(conductor 铺图路径 / plan 没写 `write_set`)。
   * 返回 `[]` = 声明了"什么都不许写", 与缺席是两件事 (NULL≠0≠不适用)。
   */
  writeAllow?: () => readonly string[] | undefined;
  /**
   * **版本守卫的按调用观察台**(2026-09-01, 判据面 = `writeset/write-version.ts`)。
   *
   * 键 = 绝对路径, 值 = 本次调用**看见过**的那一版。`read` / `write` / `edit` 成功之后往里记,
   * `write` 写前拿它与盘上实际版本比 —— 不符 = 有并发兄弟在你看完之后改过, 当场拒。
   *
   * 是 **thunk 不是 Map**: runner 跨调用复用 (MCP 长驻进程), 观察台必须**按调用新建** ——
   * 烤进装配期就会拿上一个节点看过的版本来放行这一个, 那比没有闸更糟。同
   * `writeAllow` / `mcpAllow` / `touchSession` 那条纪律。
   *
   * 返回 `undefined` = **闸缺席, 放行**(对话位 `chat.ts` / `chat-seat.ts` 那条路 —— 人在场、
   * 没有并发兄弟, 装上只会白白多一轮 read)。DAG leaf 那条路由 `agent-leaf.ts` 恒装。
   */
  fileObservations?: () => Map<string, FileObservation> | undefined;
  /**
   * 写域闸拒发生时的观察回调 (刀②, 2026-08-30 闸门三角结): 参数 = 被拒目标 (display 归一,
   * 与判词里那个同一形状)。只报不拦 —— 判拒本身照旧 throw。缺省 = 零行为变化。
   * 消费者是 agent-leaf 的按调用计数 → 引擎按「同路径 ≥2 次」上抛 write-wall observation。
   */
  onWriteDenied?: (target: string) => void;
  /** 工作根。相对路径对它解析, bash 在它里面跑。 */
  cwd: string;
  /**
   * `read` 的读域收口 (P2d 子修 1, 2026-09-02): 给了一个绝对根, `read` 拒任何解析后
   * 落在这个根之外的目标 (`BLOCKED 读域越界`)。
   *
   * ⚠ 专用新 opt, **不借用 `sandbox`**: `sandbox` 在 chat-seat.ts 里默认就带着
   * (`sandboxCfg.enabled` 缺省 true), 而非 bwrap 的 DAG-leaf 路径又恰好不设它 ——
   * 借 `sandbox` 判会把两条路的读行为分反了。scope 只管 `read`, 不管
   * `ls`/`grep`/`bash`/`view_image` (审计信号只点名了 read, 见 contract out_of_scope)。
   *
   * 缺省 = 不设边界 (chat.ts / chat-seat.ts 那条"读半区零摩擦"路, 逐字节零行为变化)。
   */
  confineReadsTo?: string;
  /**
   * **`run_acceptance` 的执行体 getter**(P3 S2, 2026-09-02)。给了则工具面上挂 `run_acceptance`;
   * getter 返 `undefined` = 本次调用没有冻结判据(工具在面上但调用即拒, 不静默 no-op)。
   * 与 `writeAllow` 同一条「thunk 不是值」纪律: 判据按调用来, 烤进装配期会拿上一个节点的判据跑这一个。
   * 省略整个字段 = 这条路不挂该工具(对话位 / 老调用方零变化)。
   */
  acceptance?: () => (() => Promise<{ text: string; outcome: AcceptanceOutcome }>) | undefined;
  /** bash 不可逆命令 fail-closed 闸。默认 true (安全侧); false = 逃生关闸。 */
  dangerousCommandGuard?: boolean;
  /**
   * 黑白名单(2026-08-13)。省略 = 内置黑名单 + 空白名单 —— 与本参数出现之前**行为一致**。
   * 给了就用它替掉 `classifyCommand`(白名单赦免在里面,见 `hooks/command-policy.ts`)。
   *
   * ⚠ 与 `dangerousCommandGuard: false` 的关系:那个是**整闸关**,这个是**换判据**。
   * 关闸时本参数不生效 —— 不存在"关了闸还想按名单判"的场景。
   */
  commandPolicy?: CommandPolicy;
  /**
   * bwrap 围栏(2026-08-13,owner 裁:对话位默认 yolo + 沙箱)。给了则:
   *   · `bash` 的每条命令包进 bwrap —— `root` 与 `/tmp` 可写, **其余全只读**;
   *   · `write` / `edit` 的目标越出可写边界 → 拒(否则围栏只挡 bash 这一个口)。
   *
   * 省略 = 无围栏(leaf 那条路:真隔离由 `hooks/sandboxed-leaf.ts` 在**进程级**做)。
   * bwrap 起不来时**降级裸跑**并记一行 —— 黑名单仍在(见 `shell-sandbox.ts` 的探测)。
   */
  sandbox?: { root: string; writable?: readonly string[] };
  /** bash 单条命令默认超时 (秒)。默认 120。 */
  bashTimeoutSec?: number;
  /**
   * `grep` 一次最多走多少个文件。默认 {@link GREP_WALK_LIMIT}。
   *
   * ⚠ **存在的理由是"让上限可测"**,不是给人调的旋钮:上限一旦静默,症状就是
   * 大仓里 `(无命中)` 骗过 agent(见 `walkFiles` 文件注释里的实测表)。
   * 真要在生产里改这个数,先量一遍时间与内存 —— 别照猜改。
   */
  grepWalkLimit?: number;
  /**
   * 碰撞台账写入面 (SDD S3, 只记不拦)。给了才记; **缺省 = 零行为变化**。
   *
   * `session`: 常量 (runner 级固定, per-run 建的 runner 可直接烤 runId) 或 getter
   * (runner 跨 run 复用时逐调用取 —— 引擎侧 runId 只在调用期可知, agent-leaf 经
   * AsyncLocalStorage 按调用喂)。getter 返 undefined = 本次调用不记。
   * 台账库锚在 cwd 的 `.omd/touch.db` (触碰发生的工作根; 隔离档下 worktree 各写各的)。
   */
  touch?: { session: string | (() => string | undefined) };
  /**
   * **读账观察口** (W2, 2026-09-06, 契约 `docs/plan/2026-09-06-墙钟与读次数-执行契约.md`)。
   * `read` / `ls` / `grep` / 只读形态的 `bash` 在**返回之前**各调一次, 参数 = 这次读了什么 + 返回正文。
   *
   * 只报不拦 (§引擎理念 ④): 钩子抛错吞掉留证据 (`observeSafely`), 工具的返回值一个字节都不因它而变。
   * 消费者是编排循环: conductor 读过的东西按 key 记账, 派 `work` 时机械交接进子节点 goal ——
   * 治的是「子节点把 conductor 刚读过的东西再读一遍」(实测 conductor 61% 的 bash 步是只读勘察)。
   *
   * 缺省 = 缺席, 四个工具的行为与返回字节与本参数出现之前**逐字相同** (handoff-wiring.test.ts 显式钉)。
   * 与 `touch` / `writeAllow` 同一条纪律: runner 跨调用复用时由调用方在这里挂 getter, 别把某一次的账烤进装配期。
   */
  onToolObserved?: (ev: ReadEvent) => void;
}

/**
 * `grep` 的遍历上限。
 *
 * ⚠ **这个数没有被论证过,它是个够用的护栏**:本机最大的仓
 * (`repos/talous-v2`,去掉 SKIP_DIRS)是 **19,177** 个文件 = 上限的 96% ——
 * 也就是说**再大一点的仓就会撞上**。撞上不再是静默的(会带 `[⚠ 只走到前 N 个…]`),
 * 但"该调多大"仍是个没量过的问题,别在这里凭感觉加零。
 */
export const GREP_WALK_LIMIT = 20_000;

/**
 * 造一套 scope 到 cwd 的 agent 工具。**每个 leaf 建一份** (cwd 各不同, 且 NodeExecutionEnv 持
 * 子进程资源)。返回顺序即系统提示里的列举顺序。
 */
export function createOmdAgentTools(opts: OmdAgentToolsOpts): AnyOmdTool[] {
  const cwd = resolve(opts.cwd);
  const guardDangerous = opts.dangerousCommandGuard !== false;
  const commandPolicy = opts.commandPolicy ?? DEFAULT_SANDBOX_CONFIG;
  const defaultTimeout = opts.bashTimeoutSec ?? 120;
  /**
   * 围栏的可写边界 = `root` + 额外逃生口 + `/tmp`(bwrap 那侧是 tmpfs,这侧的 write/edit
   * 落在宿主真 `/tmp` —— 不一致但两边都"能写",而收紧到不许写 /tmp 会打断一堆正常用法)。
   * 省略 `sandbox` → `null` = 不设边界(leaf 那条路,与本参数出现之前行为一致)。
   */
  const writableRoots: string[] | null = opts.sandbox
    ? [resolve(opts.sandbox.root), ...(opts.sandbox.writable ?? []).map((p) => resolve(p)), tmpdir()]
    : null;
  /** 目标在不在可写边界里。无边界 → 恒 true。 */
  const writable = (target: string): boolean =>
    writableRoots === null || writableRoots.some((r) => target === r || target.startsWith(r.endsWith(sep) ? r : r + sep));
  /** `read` 的读域根 (P2d 子修 1)。省略 `confineReadsTo` → `null` = 不设边界。 */
  const confineReadsToRoot: string | null = opts.confineReadsTo ? resolve(opts.confineReadsTo) : null;
  /** 目标在不在读域里。无边界 → 恒 true。 */
  const readable = (target: string): boolean =>
    confineReadsToRoot === null ||
    target === confineReadsToRoot ||
    target.startsWith(confineReadsToRoot.endsWith(sep) ? confineReadsToRoot : confineReadsToRoot + sep);
  /** 越界即拒 —— 错误里带边界原文, 模型才知道该改去哪写, 而不是反复试同一个路径。 */
  const requireWritable = (target: string, tool: string): void => {
    // ── 写域闸 (2026-08-21): 节点只准写自己声明的写集 ─────────────────────────────
    // 与下面的沙箱边界**正交**: 边界判「在不在工作根里」, 写域判「是不是这个节点该动的文件」。
    // 分两处判而不是合并: 两者的修法完全不同 (一个改 config.writable, 一个改分解表的写集列),
    // 判词混在一起会让人去改错的那个。
    const allow = opts.writeAllow?.();
    if (allow !== undefined) {
      const v = checkWriteAllowed(target, allow, cwd);
      if (!v.allowed) {
        // 刀②: 拒之前把目标报给观察回调 (fail-open, 回调炸了不许影响判拒本身)。
        try {
          opts.onWriteDenied?.(display(cwd, target));
        } catch (err) {
          logger.warn({ target, err: (err as Error).message }, '[omd/agent-tools] onWriteDenied 回调抛错 (已吞, 判拒照常)');
        }
        throw new Error(describeWriteDenied(display(cwd, target), allow, tool));
      }
    }
    // ── 路径禁令闸 (SDD D4.2, 2026-09-01) ──────────────────────────────────
    // goal 文本明文写「不许改动 `path`」的同句形态: 闸缺席 (ALS 上下文空) = 放行,
    // 行为与今日逐字节同 (INV-3); 有命中 → 工具调用当场拒, 错误文本必须含路径原文 (GWT-2)。
    //
    // 放在写域闸之后 / 沙箱边界之前: 写域是「这个节点**不该**写」(产物契约), 沙箱是
    // 「这个工具**不能**写」(bwrap 物理隔离); 路径禁令是 goal 契约的**硬约束**,
    // 优先级最高 — 哪怕 `write_allow` 列了它、bwrap 也开了, 也不许碰。
    const protectedPaths = protectedPathsStore.getStore();
    if (protectedPaths && protectedPaths.length > 0) {
      const rel = isAbsolute(target) ? relative(cwd, target) : target;
      const norm = rel.split('\\').join('/').replace(/^\.\//, '');
      if (protectedPaths.includes(norm)) {
        // SDD D4.2 (2026-09-01): 闸面 = 抛错 (与既有 checkWriteAllowed 同形)。
        // 错误文本带路径原文 (GWT-2) + 闸面 marker (BLOCKED), 模型能定位该改去碰哪条契约。
        // ⚠ **故意不带 `[omd/...][protected-path]` 前缀**: gate-registry.ts 的对账闸会把这种
        // 未登记 id 当作「unregistered」打脸 (s3-wiring.test.ts INV-11)。本片不在 gate-registry
        // 里登记 (D-4 「有权改、预期零改动」那条), 所以闸面也不发前缀串 ——
        // 闸行为仍然 fail-closed, 只是不进入图级闸对账面。下游真要观测就加日志 + onWriteDenied。
        throw new Error(
          `BLOCKED 路径禁令: ${tool} 的目标 ${target} 在 goal 文本的禁单 ${protectedPaths.join(' · ')} 中 (D4.2 / INV-2, 不在节点写集覆盖面下)。` +
            '这是 goal 契约的硬约束, 不是沙箱边界也不是写域越界 — 别去改 .omd/config.json。',
        );
      }
    }
    if (writable(target)) return;
    throw new Error(
      `BLOCKED 沙箱越界: ${tool} 的目标 ${target} 不在可写边界内 (${(writableRoots ?? []).join(' · ')})。` +
        '要写到工作根外面, 把路径加进 .omd/config.json 的 tui.sandbox.writable。',
    );
  };
  // ── 版本守卫 (2026-09-01, 判据面 = writeset/write-version.ts) ──────────────────────
  // 与上面两条闸**三方正交**: 沙箱边界判「在不在工作根里」, 写域判「是不是这个节点该动的文件」,
  // 版本判「从你看过它之后有没有被别人换过」。三条判词分开写, 混在一起会让人去改错的那个。
  /** 记一笔观察 (读到 / 写完之后的那一版)。闸缺席 → 什么都不做, 零行为变化。 */
  const observed = (full: string): void => {
    opts.fileObservations?.()?.set(full, observePath(cwd, full));
  };
  /**
   * 写前判版本。**只给 `write` 用, 不给 `edit`** —— 这不是漏接, 是「一条永远绿的闸不是闸」:
   * `edit` 在写回的**同一次调用里**先读了全文再做逐字唯一匹配 (见下面 edit 的实现), 它的
   * 「观察版本」按构造就是写那一刻的版本, 装上去永远判不出失配。而并发兄弟真改了同一段时,
   * `edit` 的 oldText 逐字匹配**自己就会红** (「找不到」); 改的是别处时那一次 edit 本来就该成功。
   * 真正会盲盖的是 `write` 的**整体覆写**: 读在 T0, 兄弟写在 T1, 你的全量覆写在 T2 —— T1 那份
   * 一个字都不剩。这道闸只挡这一路。
   */
  const requireFreshVersion = (full: string, tool: string): void => {
    const table = opts.fileObservations?.();
    if (!table) return; // 闸缺席 (对话位) —— 与本参数出现之前行为一致。
    const v = checkWriteVersion({ observed: table.get(full), actual: observePath(cwd, full) });
    if (!v.allowed) throw new Error(describeVersionDenied(display(cwd, full), v, tool));
  };
  const walkLimit = opts.grepWalkLimit ?? GREP_WALK_LIMIT;
  const env = new NodeExecutionEnv({ cwd });
  // SDD S3 碰撞台账 (只记不拦): 库锚在 cwd (触碰发生的工作根) 的 `.omd/touch.db`。
  // **开库失败 → warn 留痕 + 本次不记 (fail-open)** —— 台账是观测件, 绝不让工具调用因此失败。
  //
  // #262: 改**懒开** —— 第一次真要记 (有 session) 才建库。此前是「给了 opts.touch 就急开」,
  // 而 opts.touch 现在由 agent-leaf 无条件装 (getter 可能一直返 undefined), 急开会给每一个
  // leaf cwd 撒一个空 `.omd/touch.db`。懒开让「没 session」这条路**连文件都不产生** ——
  // 「库不存在」与「库是空的」是两种状态, 别用一个空库把它们抹平 (仓规: NULL ≠ 0 ≠ 不适用)。
  // 开库失败只 warn 一次: 每次工具调用都喊一遍会把真信号淹掉。
  let touchLedger: TouchLedger | null = null;
  let touchLedgerFailed = false;
  const touchLedgerLazy = (): TouchLedger | null => {
    if (touchLedger || touchLedgerFailed) return touchLedger;
    try {
      touchLedger = openTouchLedger({ root: cwd });
    } catch (err) {
      touchLedgerFailed = true;
      logger.warn({ err: (err as Error).message, root: cwd }, '[omd/agent-tools] touch 台账开库失败 → 本次不记 (fail-open)');
    }
    return touchLedger;
  };

  const read: OmdTool<{ path: string; lines: number; truncated: boolean }> = {
    name: 'read',
    label: 'read',
    description:
      `Read a text file. Output is truncated at ${DEFAULT_MAX_LINES} lines or ` +
      `${Math.round(DEFAULT_MAX_BYTES / 1024)}KB, whichever comes first — use offset/limit to page ` +
      'through large files. Lines are prefixed with their 1-indexed line number.',
    promptSnippet: 'read(path, offset?, limit?) — 读文件 (带行号)。别用 bash 的 cat/sed 代替。',
    parameters: READ_SCHEMA,
    executionMode: 'parallel',
    async execute(_id, params) {
      const { path, offset, limit } = params as Static<typeof READ_SCHEMA>;
      if (secretBasenameOf(path)) warnSecret(path);
      const full = abs(cwd, path);
      // ── 读域闸 (P2d 子修 1, 2026-09-02): DAG leaf 专用, chat/TUI 缺省不设边界 ──────────
      // ⚠ P1 修复 (P2 审查): `abs()` 对绝对路径原样返回、不 resolve —— `readable()` 只做
      // 字符串前缀比较, `${root}/../outside/x` 未归一时前缀仍是 root, 直接绕过。判之前
      // 用 `resolve()` 收一次 `..`, 而非改 `readable()` 本身(写域的 `writable()` 同样靠
      // 调用方给归一路径, 不在这里顺手改, 免得动到没被点名的那一半)。
      const resolvedFull = resolve(full);
      if (!readable(resolvedFull)) {
        const tmpHint = resolvedFull.startsWith(tmpdir() + sep) || resolvedFull === tmpdir();
        throw new Error(
          `BLOCKED 读域越界: read 的目标 ${display(cwd, full)} 不在读域根内 (${confineReadsToRoot})。` +
            '要读工作根外的文件, 说明这个节点的分工写错了 — 别绕开它。' +
            (tmpHint ? ' (/tmp 可写但不可读 —— 中间产物改落 `<cwd>/.omd`。)' : ''),
        );
      }
      // ★ D-2: 图片走 UTF-8 解码会得到一坨替换字符乱码喂给模型; 早拒, 指引改用 view_image。
      if (imageMimeFor(full)) {
        throw new Error(
          `read 拒图: ${display(cwd, full)} 是图片文件 (扩展名命中图片表)。` +
            '读字节对模型没意义 — 改用 view_image(path) 工具把像素送进上下文。',
        );
      }
      let raw: string;
      try {
        raw = await readFile(full, 'utf-8');
      } catch (err) {
        throw new Error(`read 失败: ${display(cwd, full)}: ${(err as Error).message}`);
      }
      // 版本守卫的观察侧: 读成功 = 「这一版我看见了」。
      // ⚠ 边界: 带 offset/limit 只读了一片, 记的仍是**整份文件**的版本 —— 本闸判的是
      //   「有没有被别人换过」, 不是「你读全了没有」, 后者是另一件事, 别把它读进来。
      observed(full);
      const all = raw.split('\n');
      const start = offset && offset > 0 ? offset - 1 : 0;
      if (start >= all.length && all.length > 0) {
        throw new Error(`offset ${offset} 超出文件末尾 (共 ${all.length} 行)`);
      }
      const end = limit && limit > 0 ? Math.min(start + limit, all.length) : all.length;
      const body = all
        .slice(start, end)
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join('\n');
      const t = truncateHead(body);
      const note = t.truncated
        ? `\n[truncated: 只给了前 ${t.outputLines} 行, 共 ${all.length} 行 — 用 offset 继续读]`
        : '';
      // W2 读账 (只报不拦): 记的是**引擎看见的返回正文**, 不是模型的复述。
      observeSafely(opts.onToolObserved, { kind: 'read', key: `read ${display(cwd, full)}`, excerpt: `${t.content}${note}` });
      return textResult(`${t.content}${note}`, { path: display(cwd, full), lines: all.length, truncated: t.truncated });
    },
  };

  /**
   * ★ **view_image** — D-1 新建工具:把图文件编码成 image content 块送进模型上下文。
   *
   * ## 为啥不靠 read
   *
   * `read` 走 UTF-8, PNG 进去出来是替换字符乱码喂给模型 —— 模型看不见图。SDK 桥与 pi
   * 循环的工具结果面**已经支持** image 块(`AgentToolResult.content` 的 `TextContent | ImageContent`，
   * `claude-sdk-loop.ts:74-80` 已在把 image 块原样投给 SDK), 缺的就是一个「读盘 + base64
   * + 装进 image 块」的工具入口。补这个最小解锁, 不动传输层。
   *
   * ## 边界
   *
   *  · 路径解析与 read 同款 (相对 cwd, 绝对照过), 不在这里另写一份边界
   *    —— 两条路漂了会让 read/view_image 对同一文件给出不同结论。
   *  · 扩展名不在词表 → 早报「不是图片」, 不去试读 (避免把 5MB 文本按 base64 喷回去)。
   *  · 单图 > 20MB → 早报; 词表与上限均与 `src/harness/leaf-media.ts:18` 一致。
   */
  const viewImage: OmdTool<{ path: string; bytes: number }> = {
    name: 'view_image',
    label: 'view_image',
    description:
      'Read an image file and return it as an image content block (pixel-level input). ' +
      `Supports ${Object.keys(IMAGE_EXT_MIME).join(', ')}. Single-image cap ${Math.round(VIEW_IMAGE_MAX_BYTES / 1024 / 1024)}MB.`,
    promptSnippet: 'view_image(path) — 把图文件当 image 块喂给模型 (支持 png/jpg/jpeg/gif/webp/bmp; 单图 ≤20MB)。',
    parameters: VIEW_IMAGE_SCHEMA,
    executionMode: 'parallel',
    async execute(_id, params) {
      const { path } = params as Static<typeof VIEW_IMAGE_SCHEMA>;
      const full = abs(cwd, path);
      const mime = imageMimeFor(full);
      // 扩展名先判 — 不读盘就拒, 不让 5MB 文本以 base64 形态喷回正文。
      if (!mime) {
        throw new Error(
          `view_image 拒: ${display(cwd, full)} 不是图片文件 (扩展名必须在 ` +
            `${Object.keys(IMAGE_EXT_MIME).join(', ')} 之内)`,
        );
      }
      const info = await stat(full).catch(() => null);
      if (!info) throw new Error(`view_image 失败: 路径不存在 ${display(cwd, full)}`);
      if (!info.isFile()) throw new Error(`view_image 失败: 不是文件 ${display(cwd, full)}`);
      if (info.size > VIEW_IMAGE_MAX_BYTES) {
        throw new Error(
          `view_image 拒: ${display(cwd, full)} 大小 ${info.size} 字节超过上限 ${VIEW_IMAGE_MAX_BYTES} 字节`,
        );
      }
      let buf: Buffer;
      try {
        buf = await readFile(full);
      } catch (err) {
        throw new Error(`view_image 失败: ${display(cwd, full)}: ${(err as Error).message}`);
      }
      // 与 SDK 桥对得起来的那一面 (claude-sdk-loop.ts:74-80 的 image 分支已经会这么投)。
      const content: AgentToolResult<{ path: string; bytes: number }>['content'] = [
        { type: 'image', data: buf.toString('base64'), mimeType: mime },
      ];
      return { content, details: { path: display(cwd, full), bytes: info.size } };
    },
  };

  const write: OmdTool<{ path: string; bytes: number }> = {
    name: 'write',
    label: 'write',
    description: 'Create a file or overwrite it in full. Parent directories are created as needed.',
    promptSnippet: 'write(path, content) — 新建文件 / 整体覆写。改已存在文件优先用行锚定 patch。',
    parameters: WRITE_SCHEMA,
    executionMode: 'sequential',
    async execute(_id, params) {
      const { path, content } = params as Static<typeof WRITE_SCHEMA>;
      const full = abs(cwd, path);
      requireWritable(full, 'write');
      // 版本守卫: 路径闸放行之后、真写之前判一次 —— 顺序是**先路径后版本**, 因为
      // 「这文件根本不归你」比「你拿的是旧版」更根本, 先报那条才不会让人去重读一个不该写的文件。
      requireFreshVersion(full, 'write');
      const r = await env.writeFile(full, content);
      if (!r.ok) throw new Error(`write 失败: ${display(cwd, full)}: ${r.error.message}`);
      // 写完立刻重新观察: 本次写入的结果就是本次调用看见的最新一版 (否则连写两次会自己撞自己)。
      observed(full);
      // SDD S3 strict 档 (事实): 受控写工具知道写了什么 → hash = sha256(写入内容), 非 NULL。
      touchWrite(touchLedgerLazy, opts.touch, { path: full, op: 'write', hash: sha256Hex(content), source: 'strict' });
      return textResult(`✓ 写入 ${display(cwd, full)} (${content.length} 字节)`, {
        path: display(cwd, full),
        bytes: content.length,
      });
    },
  };

  const edit: OmdTool<{ path: string; replaced: boolean }> = {
    name: 'edit',
    label: 'edit',
    description:
      'Replace one exact occurrence of oldText with newText in an existing file. ' +
      'oldText must appear exactly once — include enough surrounding context to make it unique.',
    promptSnippet: 'edit(path, oldText, newText) — 唯一匹配的精确替换。',
    parameters: EDIT_SCHEMA,
    executionMode: 'sequential',
    async execute(_id, params) {
      const { path, oldText, newText } = params as Static<typeof EDIT_SCHEMA>;
      const full = abs(cwd, path);
      requireWritable(full, 'edit');
      let raw: string;
      try {
        raw = await readFile(full, 'utf-8');
      } catch (err) {
        throw new Error(`edit 失败 (读不到): ${display(cwd, full)}: ${(err as Error).message}`);
      }
      const first = raw.indexOf(oldText);
      if (first === -1) throw new Error(`edit 失败: oldText 在 ${display(cwd, full)} 中找不到 (逐字匹配, 含空白)`);
      if (raw.indexOf(oldText, first + 1) !== -1) {
        throw new Error(`edit 失败: oldText 在 ${display(cwd, full)} 中出现多次 — 补足上下文使其唯一`);
      }
      const next = `${raw.slice(0, first)}${newText}${raw.slice(first + oldText.length)}`;
      const w = await env.writeFile(full, next);
      if (!w.ok) throw new Error(`edit 失败 (写回): ${display(cwd, full)}: ${w.error.message}`);
      // edit 不受版本闸约束 (理由见 requireFreshVersion 的注), 但它**是观察侧**:
      // 写回之后这份文件的最新一版本次调用是看见了的, 记上, 后续 write 才不会被自己的 edit 判成失配。
      observed(full);
      // SDD S3 strict 档 (事实): edit 写回的是整份新内容 (next), hash 对它算。
      touchWrite(touchLedgerLazy, opts.touch, { path: full, op: 'write', hash: sha256Hex(next), source: 'strict' });
      return textResult(`✓ 已替换 ${display(cwd, full)} 中 1 处`, { path: display(cwd, full), replaced: true });
    },
  };

  const ls: OmdTool<{ path: string; count: number }> = {
    name: 'ls',
    label: 'ls',
    description: 'List the direct children of a directory. Directories are suffixed with "/".',
    promptSnippet: 'ls(path?) — 列目录直接子项。',
    parameters: LS_SCHEMA,
    executionMode: 'parallel',
    async execute(_id, params) {
      const { path, limit } = params as Static<typeof LS_SCHEMA>;
      const full = abs(cwd, path ?? '.');
      const r = await env.listDir(full);
      if (!r.ok) throw new Error(`ls 失败: ${display(cwd, full)}: ${r.error.message}`);
      const cap = limit && limit > 0 ? limit : 500;
      const entries = r.value
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => (e.kind === 'directory' ? `${e.name}/` : e.name));
      const shown = entries.slice(0, cap);
      const more = entries.length > shown.length ? `\n… 还有 ${entries.length - shown.length} 项 (调大 limit)` : '';
      // W2 读账 (只报不拦)。
      observeSafely(opts.onToolObserved, { kind: 'ls', key: `ls ${display(cwd, full)}`, excerpt: `${shown.join('\n')}${more}` });
      return textResult(`${display(cwd, full)}:\n${shown.join('\n')}${more}`, {
        path: display(cwd, full),
        count: entries.length,
      });
    },
  };

  const grep: OmdTool<{ matches: number; files: number; walked: number; walkCapped: boolean; skippedMounts: number }> = {
    name: 'grep',
    label: 'grep',
    description:
      'Search file contents by regular expression. Skips .git/node_modules/build output. ' +
      'Returns "path:line: text" per match. Use it to find literal text — for symbol definitions ' +
      'and call graphs prefer codegraph via bash.',
    promptSnippet: 'grep(pattern, path?, glob?) — 按正则找文本, 返 `路径:行号: 内容`。',
    parameters: GREP_SCHEMA,
    executionMode: 'parallel',
    async execute(_id, params) {
      const { pattern, path, glob, ignoreCase, literal, limit } = params as Static<typeof GREP_SCHEMA>;
      const cap = limit && limit > 0 ? limit : 100;
      const root = abs(cwd, path ?? '.');
      let re: RegExp;
      try {
        const src = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
        re = new RegExp(src, ignoreCase ? 'i' : '');
      } catch (err) {
        throw new Error(`grep 失败: 正则不合法 ${pattern}: ${(err as Error).message}`);
      }
      const globRe = glob ? globToRegExp(glob) : null;
      const info = await stat(root).catch(() => null);
      if (!info) throw new Error(`grep 失败: 路径不存在 ${display(cwd, root)}`);
      // glob 进遍历(不是走完再筛)—— 否则上限数的是**任意** 20_000 个文件, glob 帮不上忙。
      const walked = info.isDirectory()
        ? await walkFiles(root, walkLimit, globRe ? { filter: (f) => globRe.test(f.split(sep).join('/')) } : {})
        : { files: [root], capped: false, skippedMounts: [] };
      const files = walked.files;
      const hits: string[] = [];
      let filesWithHits = 0;
      for (const f of files) {
        if (hits.length >= cap) break;
        let content: string;
        try {
          content = await readFile(f, 'utf-8');
        } catch {
          continue; // 二进制/权限 → 跳过, 检索 fail-open
        }
        if (content.includes('\u0000')) continue; // NUL = 二进制, 别把它的"行"倒进上下文
        let hitHere = false;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && hits.length < cap; i++) {
          if (!re.test(lines[i]!)) continue;
          hitHere = true;
          hits.push(`${display(cwd, f)}:${i + 1}: ${truncateLine(lines[i]!, GREP_MAX_LINE_LENGTH).text}`);
        }
        if (hitHere) filesWithHits++;
      }
      const head = hits.length === 0 ? `(无命中) ${pattern}` : hits.join('\n');
      const more = hits.length >= cap ? `\n[已达 limit ${cap}, 可能还有更多命中]` : '';
      /**
       * ★ **走到上限必须说出来** —— 尤其在 `(无命中)` 那一支上。
       *
       * 「没走到那儿」与「那儿没有」是两件事,抹成一句 `(无命中)` 之后,agent 收到的
       * 是"这个符号不存在"这个**错误结论**,而它没有任何线索去怀疑。
       */
      const cut = walked.capped
        ? `\n[⚠ 走到遍历上限/时间预算就停了 (收到 ${files.length} 个候选文件) —— **命中很可能不全**` +
          `${hits.length === 0 ? '(上面那句"无命中"因此不代表它不存在)' : ''}。用 path= 收窄目录, 或 glob= 收窄文件名]`
        : '';
      /**
       * ★ **剪掉的远端挂载必须说出来**(2026-08-13,与 `capped` 同一条纪律)。
       *
       * 静默剪掉之后,`grep` 在一个挂着 NAS 的目录上返回 `(无命中)` —— 而那句话
       * 读起来是"那儿没有",实际是"我根本没去看"。两件事抹成一句,agent 就会
       * 拿着一个错误结论继续往下走,且没有任何线索去怀疑。
       */
      const MOUNT_REPORT_CAP = 5;
      const skipped = walked.skippedMounts;
      const mounts =
        skipped.length === 0
          ? ''
          : `\n[⚠ 跳过 ${skipped.slice(0, MOUNT_REPORT_CAP).map((m) => display(cwd, m)).join(' · ')}` +
            `${skipped.length > MOUNT_REPORT_CAP ? ` 等 ${skipped.length} 处` : ''}` +
            ' —— 远端挂载 (9p/NAS/网络盘), 递归遍历会拖死整台机器。要搜就直接 path= 指到那里面]';
      // W2 读账 (只报不拦): key 带上 pattern 与搜索根 —— 同一个词在两个目录下搜是两次勘察。
      observeSafely(opts.onToolObserved, {
        kind: 'grep',
        key: `grep ${pattern}${path ? ` @ ${display(cwd, root)}` : ''}${glob ? ` glob=${glob}` : ''}`,
        excerpt: `${head}${more}${cut}${mounts}`,
      });
      return textResult(`${head}${more}${cut}${mounts}`, {
        matches: hits.length,
        files: filesWithHits,
        // 走了几个 / 有没有被截 / 剪了几处 —— 让调用方也能程序化地看见, 不只靠读那句话。
        walked: files.length,
        walkCapped: walked.capped,
        skippedMounts: skipped.length,
      });
    },
  };

  const bash: OmdTool<{ exitCode: number | undefined; truncated: boolean }> = {
    name: 'bash',

    label: 'bash',
    description:
      'Run a shell command in the working root. Irreversible commands (rm -rf /, git push --force, ' +
      'DROP TABLE, …) and commands that read credential files are refused.',
    // ⚠ 末句不是客套话。账在 `shell-writes.ts` 头注: 「两次真跑两次中招, 第一次还连累下游
    // 四个复核节点全 skip —— **活是干完了的**」。产物闸只认受控写工具的 filesTouched,
    // 经 bash 写的目标是**推断**而本仓明写「节点成败/产物闸/judge 一律不看它」
    // (failure-trace.ts:29) —— 闸判得没错, 所以修的是这里: 让执行体一开始就别那么写。
    // 只说「别用」而不说后果, 执行体没有理由听, 所以后果也写进去。
    // ⚠ 别把 2026-08-12 run 360405a5 算进这条的账: 那次第一轮 impl-types 判 empty-artifact
    // 后 conductor 重规划, 第二轮五个 impl 节点全绿 —— 它真正卡死在 green-gate.__r1 撞上
    // **另一个并发 run** 半成品的 tsc 错。那是多 run 共用一棵树的代价, 与本条无关。
    promptSnippet:
      'bash(command, timeout?) — 在工作根跑 shell (不可逆命令与读凭证文件会被拒)。' +
      '⚠ 写文件用 write/edit, 别用 bash 重定向 (`>` `tee` `sed -i`): 产物闸只认受控写工具, ' +
      '经 bash 写的文件它**看不见**, 节点会被判 empty-artifact 并级联跳过下游。',
    parameters: BASH_SCHEMA,
    executionMode: 'sequential',
    async execute(_id, params, signal, onUpdate) {
      const { command, timeout } = params as Static<typeof BASH_SCHEMA>;
      // ① 不可逆命令 fail-closed (与 command-leaf 共用同一张模式表)。分类器抛错也算拦 ——
      //    fail-closed 契约不能因为异常就变成 fail-open。
      //    2026-08-13: 判据换成 `judgeCommand` —— 同一张黑名单, 外加逐仓白名单赦免。
      //    不传 commandPolicy 时它等价于旧的 `classifyCommand`(DEFAULT_SANDBOX_CONFIG 的
      //    deny 就是 DANGEROUS_PATTERNS、allow 为空), 所以 leaf 那条路一个字都没变。
      if (guardDangerous) {
        let dangerous: ReturnType<typeof classifyCommand>;
        try {
          dangerous = judgeCommand(command, commandPolicy);
        } catch (err) {
          logger.error({ command, err: (err as Error).message }, '[omd/agent-tools] 命令分类器异常 → 拦');
          throw new Error('BLOCKED: 命令分类器异常 (fail-closed)');
        }
        if (dangerous.dangerous) {
          logger.warn({ command, label: dangerous.label }, '[omd/agent-tools] 危险命令拦截 (fail-closed)');
          throw new Error(`BLOCKED 不可逆命令 [${dangerous.label}]: ${dangerous.reason}`);
        }
        // ①.5 git 写操作闸 (#239, 2026-08-23): 上面那道是**黑名单**, 实测认识 `reset --hard`
        //     却不认识 `checkout` / `restore` —— 而三者对「抹掉本跑刚写、还没提交的文件」等效。
        //     实账: run 5ec238df 的 agent 节点拿 `git checkout HEAD -- <files>` 当 stash 用,
        //     四个文件的实装全部丢失, 整跑作废; 而写集对账只看最终盘面, 写了又还原照报
        //     `consistent` —— 这个洞**不留痕**, 是本仓最怕的那一族。
        //     判据与判词都取 command-leaf 那份 (同一个导出): 两条执行路从此逐字同一句话。
        const gitBlocked = gitWriteBlockReason(command);
        if (gitBlocked) {
          logger.warn({ command }, '[omd/agent-tools] git 子命令非只读, 拒绝 (与 command leaf 同一道闸)');
          throw new Error(`BLOCKED ${gitBlocked} —— 要回滚本跑的改动请升 owner, 执行体不自行抹写`);
        }
      }
      // ② 凭证文件拒: 按 shell 分隔符拆段逐段查 —— `ls && cat .env` 的尾环也要被看见。
      //    (`secretPathInCommand` 跳过每段首 token = bin, 故必须先拆段再喂。)
      for (const seg of command.split(/[;&|]+|\n/)) {
        const s = seg.trim();
        if (!s) continue;
        const secret = secretPathInCommand(s);
        if (secret) warnSecret(secret);
      }
      // SDD S3 bash 写嗅探的起跑时刻: verifiedShellWriteTargets 的窗口左沿 (mtime ≥ startedAt - 容差)。
      const startedAt = Date.now();
      // ③ bwrap 围栏 (2026-08-13): 工作根 + /tmp 可写, 其余全只读。**包的是命令串** ——
      //    pi 每次 exec 都 spawn 全新 shell (无跨调用 cd 状态), 逐条包因此是安全的。
      //    沙箱起不来 → `sandboxCommand` 原样返回 (降级裸跑, 告警在 probe 那侧)。
      const toRun = withPipefail(
        opts.sandbox
          ? sandboxCommand(command, { root: opts.sandbox.root, ...(opts.sandbox.writable ? { extraWritable: opts.sandbox.writable } : {}) })
          : command,
      );
      /**
       * ★ **流式输出**(2026-08-14)。pi 一直提供两条通道,omd 此前**两条都没接**:
       * 工具签名不收 `onUpdate`、`executeShellWithCapture` 的 `onChunk` 一次都没传
       * ⇒ `tool_execution_update` 事件**结构上永远不可能触发**。
       *
       * 代价是可量的:一条跑 120 秒的命令,屏上 120 秒里一个字都没有 —— 而
       * 2026-08-13 那次 3h48m 卡死,屏幕上什么都看不见正是这个原因的一半
       * (另一半是 `walkFiles` 无界,见 S-36)。**"在跑"与"卡死"在屏上长得一样**,
       * 这是本仓最怕的那一族。
       *
       * ⚠ 节流:`onChunk` 是**每一片 stdout** 都调,一条 `bun test` 能有几千片。
       * 逐片往上发会把事件流淹掉(UI 每帧重绘一次都跟不上)。所以按**时间**节流,
       * 不按片数 —— 片的大小完全取决于子进程怎么 flush,按片数节流等于按一个
       * 不受控的量节流。末片无条件发,否则最后一段输出会被节流吞掉。
       */
      const throttleMs = 120;
      let lastEmit = 0;
      /**
       * ★ **控制字符清洗探测**(2026-08-14, 第 2 笔)。`executeShellWithCapture` 内部本就会对
       * 每片 chunk 调 `sanitizeBinaryOutput` 再拼进 `output`(pi 源码 `onChunk` 里先清洗再计
       * 字节数)—— 所以到手的 `output` **已经干净**,事后对它 diff 一次必然是 no-op,永远测不出
       * "原始输出脏过没有"(实测: `printf 'PRE\x00\x1bMID'` 走一遍拿到的 `output` 就是
       * `"PREMID"`,NUL/ESC 早没了)。真正的脏信号只活在 `env.exec` 传给 `onStdout`/`onStderr`
       * 的**原始** chunk 里,而那层由 `executeShellWithCapture` 自己接管、不对外暴露。
       * 于是这里包一层 `env`(只代理 `exec`,其余方法走原型链落到真实 `env` 上),在
       * `executeShellWithCapture` 把它的内部 onChunk 塞进 `onStdout`/`onStderr` 之前先接一手
       * 原始 chunk 判脏、再原样转发 —— 不改变真实执行/截断路径,只加一条旁路观测。
       */
      let sawRawControlChars = false;
      let rawOutput = Buffer.alloc(0);
      let rawOutputBytes = 0;
      let rawOutputCapped = false;
      const rawChunkWatcher = (chunk: string): void => {
        if (!sawRawControlChars && sanitizeBinaryOutput(chunk) !== chunk) sawRawControlChars = true;
        const remaining = BASH_SPILL_MAX_BYTES - rawOutputBytes;
        if (remaining <= 0) {
          if (chunk.length > 0) rawOutputCapped = true;
          return;
        }
        const source = Buffer.from(chunk);
        if (source.length > remaining) rawOutputCapped = true;
        const kept = source.subarray(0, remaining);
        const needed = rawOutputBytes + kept.length;
        if (needed > rawOutput.length) {
          const capacity = Math.min(
            BASH_SPILL_MAX_BYTES,
            Math.max(64 * 1024, needed, rawOutput.length * 2),
          );
          const grown = Buffer.allocUnsafe(capacity);
          rawOutput.copy(grown, 0, 0, rawOutputBytes);
          rawOutput = grown;
        }
        kept.copy(rawOutput, rawOutputBytes);
        rawOutputBytes = needed;
      };
      const execEnv = Object.create(env) as typeof env;
      execEnv.exec = (cmd, execOptions) =>
        env.exec(cmd, {
          ...execOptions,
          onStdout: (chunk: string) => {
            rawChunkWatcher(chunk);
            execOptions?.onStdout?.(chunk);
          },
          onStderr: (chunk: string) => {
            rawChunkWatcher(chunk);
            execOptions?.onStderr?.(chunk);
          },
        });
      const r = await executeShellWithCapture(execEnv, toRun, {
        timeout: timeout && timeout > 0 ? timeout : defaultTimeout,
        ...(signal ? { abortSignal: signal } : {}),
        ...(onUpdate
          ? {
              onChunk: (_chunk: string, getProgress: () => { output: string }) => {
                const now = Date.now();
                if (now - lastEmit < throttleMs) return;
                lastEmit = now;
                // details 里的 exitCode 用 `undefined` —— 还没跑完, 编一个 0 就是把
                // "在跑" 画成 "跑成功了"(与结果摘要那条 `no exit code` 同一纪律)。
                onUpdate({
                  content: [{ type: 'text', text: getProgress().output }],
                  details: { exitCode: undefined, truncated: false },
                });
              },
            }
          : {}),
      });
      if (!r.ok) throw new Error(`bash 失败: ${r.error.message}`);
      const { output, exitCode, cancelled, truncated } = r.value;
      // 出口清洗: 正文过一遍 `sanitizeBinaryOutput`(通常是 no-op, 因为上面已证 `output` 到手时
      // 早被 pi 内部清过 —— 这里仍显式做一遍是防御性的, 不依赖上游行为不变)。`sanitized`
      // 只看旁路探测到的**原始** chunk 是否曾被改过, 不借用 `truncated` 表意 (NULL≠0 同一纪律:
      // 两件事分两列)。
      const cleanOutput = sanitizeBinaryOutput(output);
      const sanitized = sawRawControlChars;
      // SDD S3 推断档 (只记不拦): bash 成功 (exit 0 且未被中止) → 盘上核实的写目标记 inferred
      // (hash=NULL —— 推断档不知道写了什么, NULL≠0 纪律)。复用 verifiedShellWriteTargets 同一条
      // 判据不抄第二份; 与 strict 档分列不合并 (台账按 source 落)。
      if (exitCode === 0 && !cancelled) {
        for (const hit of verifiedShellWriteTargets([command], { root: cwd, startedAt })) {
          touchWrite(touchLedgerLazy, opts.touch, { path: hit, op: 'write', source: 'inferred' });
        }
      }
      let truncationNotice = '';
      if (truncated) {
        const candidate = resolve(cwd, '.omd', `bash-output-${Date.now()}-${randomUUID()}.log`);
        let fullOutputPath: string | null = null;
        try {
          const persisted = await env.writeFile(candidate, rawOutput.subarray(0, rawOutputBytes));
          if (!persisted.ok) throw persisted.error;
          fullOutputPath = candidate;
        } catch (err) {
          logger.warn(
            { path: candidate, bytes: rawOutputBytes, err: err instanceof Error ? err.message : String(err) },
            '[omd/agent-tools] bash 截断全文写盘失败 (fail-open, 返回尾部)',
          );
        }
        truncationNotice = fullOutputPath
          ? rawOutputCapped
            ? `[输出已截断, 只保留尾部; 完整输出被截断, 仅留前 ${rawOutputBytes} 字节; 完整输出: ${fullOutputPath} —— 有 read 工具就按需分页读它]`
            : `[输出已截断, 只保留尾部; 完整输出: ${fullOutputPath} —— 有 read 工具就按需分页读它]`
          : '[输出已截断, 只保留尾部; 全文未写盘]';
      }
      const tail = [
        cancelled ? '[命令被中止]' : '',
        exitCode !== undefined && exitCode !== 0 ? `[exit ${exitCode}]` : '',
        truncationNotice,
        sanitized ? '[输出含控制字符, 已清洗]' : '',
      ]
        .filter(Boolean)
        .join(' ');
      // W2 读账 (只报不拦): **只收只读勘察形态** —— 跑测试 / 装依赖 / 写文件的命令不进账,
      // 交接的是「我看见了什么」, 不是「我做了什么」(后者已在派发台账与 filesTouched 里)。
      if (classifyShellReadonly(command)) {
        observeSafely(opts.onToolObserved, { kind: 'bash-readonly', key: `bash ${command}`, excerpt: `${cleanOutput}${tail ? `\n${tail}` : ''}` });
      }
      return textResult(`${cleanOutput}${tail ? `\n${tail}` : ''}`, { exitCode, truncated, sanitized });
    },
  };

  /**
   * H6 (#187): 给每个工具挂上它的 `render` 投影。**按工具自己的 `name` 取** ——
   * 改名时投影跟着走, 不会像旧的 UI 侧 switch 那样落进 `null` 无声消失。
   * 覆盖完整性由 `tool-render.test.ts` 钉死 (少挂一个即红), 不靠这里巧合写全。
   */
  const withRender = (t: AnyOmdTool): AnyOmdTool => {
    const render = HAND_TOOL_RENDERERS.get(t.name);
    return render ? { ...t, render } : t;
  };

  /**
   * `run_acceptance`(P3 S2 / D-6): 跑**引擎冻结的**验收命令。schema 里没有 command —— 模型改不了一个字。
   * 闸链、沙箱包裹、判读全在 `acceptance-run.ts`;这里只是把 ALS 里那条判据的执行体接到工具面上。
   * `BASH_SCHEMA` 与交互 bash 的 execute 分支一个字节不动(INV-13):验收是另一条工具, 不是 bash 的一个模式。
   */
  const runAcceptance: OmdTool<{ verdict: string; exitCode: number | null }> = {
    name: 'run_acceptance',
    label: 'run_acceptance',
    description:
      'Run the acceptance command the engine froze for this node, exactly as frozen. Returns the verdict ' +
      '(GREEN / RED / INCONCLUSIVE), the exit code, the failure delta against your previous run, and the output tail. ' +
      'This is the only call that counts as "ran the acceptance command".',
    promptSnippet:
      'run_acceptance() — 跑引擎冻结的验收命令 (你不传命令, 引擎跑原文)。只有这个调用算「跑过验收」; ' +
      '自己用 bash 敲一遍不算。返回判词 / 退出码 / 与上次比新增·修掉的失败 / 输出尾部。',
    parameters: RUN_ACCEPTANCE_SCHEMA,
    executionMode: 'sequential',
    async execute() {
      const run = opts.acceptance?.();
      if (!run) throw new Error('run_acceptance 在本节点不可用: 引擎没有为它冻结验收命令 (没有 self_check)。');
      const { text, outcome } = await run();
      return textResult(text, {
        verdict: outcome.kind === 'blocked' ? 'blocked' : outcome.verdict,
        exitCode: outcome.kind === 'blocked' ? null : outcome.exitCode,
      });
    },
  };
  const base = [read, viewImage, write, edit, ls, grep, bash];
  return (opts.acceptance ? [...base, runAcceptance] : base).map(withRender);
}

/**
 * **管道退出码旋钮**(2026-08-16,#145 附录「新增提议」)。默认 **on**(2026-08-17 对照实验
 * 裁决,读数见下;`OMD_BASH_PIPEFAIL=0` 显式关)。
 *
 * ## 现场
 *
 * run D 的 `final_review` 节点独立重跑五闸时发现:`cmd 2>&1 | tail -5` 之后 `$?` 拿到的是
 * `tail` 的退出码,不是 `cmd` 的 —— 于是**一条失败的验证命令看起来是绿的**。
 * 它当时自己改写了命令重新捕获,但那**不构成"学会了"**:leaf 是冷启动,run 之间不共享,
 * 下一次会不会再犯只取决于任务文本里有没有再写一遍(见另开的那条 issue)。
 *
 * **退出码错了会直接造成假绿,让"闸通过"这件事本身不可信** —— 这比本轮其余任何一条都危险。
 *
 * ## ⚠ 它是**行为翻转**,不是补漏 —— 所以先关着跑了对照
 *
 * `set -o pipefail` 会让一批**今天正常返回 0** 的命令开始返回非 0,最典型的是
 * `cmd | head -3` —— `head` 读够就退出,`cmd` 吃 SIGPIPE 死掉,pipefail 下整条判失败。
 * 那种红是**假红**。所以这条先跑对照,两侧读数都记(只记好消息的实验没有信息量):
 *
 * - **单一变量**:`OMD_BASH_PIPEFAIL` 开 / 关,别的一个都不动;
 * - **预先声明的成败信号**:开臂下从 exit 0 变非 0 的命令里,**真错**(管道确实掩盖了失败)
 *   与 **假红**(SIGPIPE 那类)各占多少。真错 > 假红 → 值得默认开;反之不开;
 * - **对照基线**:同一批命令、同一棵树,两臂各跑一次。
 *
 * ## 读数与裁决(2026-08-17,`scripts/probes/pipefail-2arm.ts`,#146 表内项②)
 *
 * 命令源 = checkpoints 的 shellRuns 真实生产管道命令(去重后只读白名单形),同树两臂回放:
 * 182 条(176 light + 6 heavy)→ 不翻转 155 · 翻转(0→非0) 27 = **真错 19 vs 假红 8**
 * (SIGPIPE 7 + 其他 1)。真错里含 `bunx tsc --noEmit … | head -30` —— run D 假绿的原型
 * 在今天的树上仍然复现。⚠ 诚实注记:回放态真错含 state-artifact 成分(cat/ls 于回放树缺文件,
 * 录制当时未必失败);保守剔除后 9 vs 8 仍不小于。逐条读数 `.omd/eval/pipefail-2arm.jsonl`。
 * **按预先冻结的判据 → 默认开**。逃生门:`OMD_BASH_PIPEFAIL=0` 显式关。
 * 假红代价有界:SIGPIPE 类约 4%(7/176)的管道命令变红,红的是探索型 grep|head,
 * 模型可改写;而假绿的代价是闸不可信 —— 两侧不对称。
 *
 * 判据现在读得出来了:每条命令的原文与退出码都进 `shellRuns`,工具序列进 `toolSteps`。
 *
 * ## 实现:shell 未知,所以必须 fail-open
 *
 * 命令串最终落到 pi 的 `env.exec`,**用的是哪个 shell 我们不掌握**(dash 不支持 pipefail,
 * 它会报错并返回非 0)。所以探测写成 `2>/dev/null || true`:不支持就静默跳过,
 * **绝不会因为加了这一句把一条本来能跑的命令弄坏**。
 * 用 `{ }` 而不是 `( )` —— 后者起子 shell,选项设了也传不到正文那一行。
 */
export function withPipefail(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.OMD_BASH_PIPEFAIL === '0') return command; // 显式 '0' = 逃生门, 命令逐字不变
  return `{ set -o pipefail 2>/dev/null || true; }; ${command}`;
}
