/**
 * sandboxed-leaf —— **subprocess-per-leaf under bwrap** 的父侧 runner (2026-07-23, eval 真隔离)。
 *
 * agent-leaf 的 sandboxRoot 路径委托到这里: 每次 leaf 调用 spawn 一个 `bwrap [binds] bun run leaf-worker.ts`
 * 子进程 (cwd=worktree, 主 repo 物理不可见)。worker 在 jail 内跑 in-process agent-leaf, 结果经 worktree 内
 * 文件回传。这样 pi 的**所有**命令通道 (bash / 模型幻觉的 shell / 未来工具) + `git show` oracle 泄漏被一次性
 * 封死 —— 不逐工具打地鼠 (记忆 dag-engine-write-reliability: 模型用 `shell` 绕过单工具沙箱)。
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { logger } from '../../logger';
import type { AgentLeafInput, AgentLeafResult, AgentLeafRunner } from '../leaf-runners';
import type { AgentLeafRunnerOpts } from '../agent-leaf';
import { CLAUDE_SDK_PROVIDER } from '../../model/claude-sdk-complete';
import type { LeafWorkerPayload } from '../leaf-worker';
import type { AnyOmdTool } from '../agent-tools';
import { bwrapArgs, defaultRoBinds, makePiAgentCopy, resolveGitBinds, type GitBinds } from './bwrap';
// jail 自检层③: leaf 挂了之后认「挂载面缺东西」还是「模型不行」(只在失败路径跑)。
import { describeJailDiagnosis, diagnoseJailFailure } from './jail-diagnosis';
// jail 自检层①: 构造期把 argv 上能判的挂载面问题一次判掉 (纯函数, 不跑任何东西)。
import { checkJailArgv, describeJailProblems } from './jail-preflight';

/** worker 在 worktree 内的相对路径 (eval 档: worktree = omd 自己的 HEAD checkout, 含此文件)。 */
const WORKER_REL = 'src/harness/leaf-worker.ts';

/**
 * 外层 bwrap 杀进程计时器的取紧算法 (P2e review-fix, 2026-09-02) —— 单独导出成纯函数只为了
 * 不用起真 bwrap worker 就能钉住 (起真 worker 要真跑一次 agent SDK, 不是这条闸该测的范围)。
 *
 * ⚠ 首版用 `??` (input 有值就整个覆盖 opts) 而不是 `Math.min` —— 与 agent-leaf.ts `runOnce`
 * 的 in-process 计时器**不是同一条闸**, 尽管上面 (调用处) 的注释这么声称: 运维配了较小的
 * `opts.leafTimeoutMs` (硬崩溃兜底) 时, 引擎按剩余预算算出的较大 `input.leafTimeoutMs` 会把
 * 外层杀进程时机反而**放宽**, 而 worker 内部的 agent-leaf 计时器仍正确收紧 —— 同一次调用两个
 * 天花板, 且方向与「按调用取紧的那个」相反。改成 `Math.min`, 与 agent-leaf.ts:2224 逐字同源。
 */
export function sandboxedLeafKillTimeoutMs(
  input: Pick<AgentLeafInput, 'leafTimeoutMs'>,
  opts: Pick<AgentLeafRunnerOpts, 'leafTimeoutMs'>,
): number {
  return Math.min(input.leafTimeoutMs ?? Number.POSITIVE_INFINITY, opts.leafTimeoutMs ?? 3_600_000);
}

/**
 * **worker 到底从哪儿取** (2026-07-31, 一次 live 撞出来的 P0)。
 *
 * 原设计只有 {@link WORKER_REL} 一条路, 注释写着「worktree = HEAD checkout, 含此文件」——
 * 那句话对 **eval** 成立 (那里的 worktree 就是 omd 自己的 checkout), 但 R2 (D-Y①) 把这个 jail
 * 接到了 `dag_goal` 上, 而那里的 worktree 是**用户仓**的 checkout, 里面根本没有 omd 的源码。
 *
 * 后果不是"少了点隔离", 是**隔离档下 agent leaf 一个都起不来**:
 * `error: Module not found "src/harness/leaf-worker.ts"` × 每个 leaf。
 * 2026-07-31 的 live 上 9 个节点全灭, 产物一份没写 —— 而单元测试与 bwrap 容器性探针**全绿**,
 * 因为它们测的是 jail 关不关得住, 不是 worker 找不找得到。
 * (这是本轮第三次撞见同一形态: **隔离动了, 消费面没跟上**。)
 *
 * 两档分开选, 而不是一律绑 omd 源码进 jail —— 后者会**破坏 eval 的隔离**:
 * eval 要的正是"主 repo 物理不可见"(防 `git show` 当 oracle), 无条件绑回去等于把它拆了。
 *   · worktree 里有 worker → 用它 (eval 档, 零额外挂载, 隔离性质不变)
 *   · 没有 → 把 omd 安装目录**只读**挂进 jail 并用绝对路径 (goal 档: 被隔离的是用户仓,
 *     omd 自己的源码本来就不是被保护的对象)
 */
function resolveWorker(root: string): { argvPath: string; extraRoBinds: string[] } {
  if (existsSync(join(root, WORKER_REL))) return { argvPath: WORKER_REL, extraRoBinds: [] };
  // 从本文件往上找 package.json = omd 安装根 (src/harness/hooks → …/oh-my-dag)。
  let dir = import.meta.dir;
  for (let i = 0; i < 6 && !existsSync(join(dir, 'package.json')); i++) dir = dirname(dir);
  const abs = join(dir, WORKER_REL);
  if (!existsSync(abs)) {
    // fail-closed 且**在造 runner 的时候就响**: 让它到第一个 leaf 才炸, 代价是先烧掉一整轮
    // conductor 规划 (live 上就是这么烧的)。
    throw new Error(
      `[sandboxed-leaf] 找不到 leaf-worker: worktree (${join(root, WORKER_REL)}) 与 omd 安装目录 (${abs}) 都没有。` +
        '隔离档起不来 —— 与其在第一个 leaf 上失败, 不如现在就说。',
    );
  }
  // node_modules 一并挂: goal 档下 worktree 里的是**用户仓的**依赖, worker 要的是 omd 的。
  return { argvPath: abs, extraRoBinds: [dir] };
}

let seq = 0;

/** JSON 安全的 opts 子集 (剔除函数/cwd/sandboxRoot —— worker 侧自定或不需)。customTools 走 D-6 risk-tier 闸:
 *  `sandboxSafe === true` 的 decl 过线 (execute 是函数, JSON.stringify 过线时剥落 → worker 侧重水化成
 *  文件桥代理, 真执行在父进程, 见 serveToolBridge); 未声明/false → 剥除 + warn 列名 (不再静默一刀剥)。
 *  零保留 → 不落 customTools 键 (与零 ext 基线逐字节一致)。 */
export function serializableOpts(opts: AgentLeafRunnerOpts): Record<string, unknown> {
  const { onEvent: _o, cwd: _cwd, sandboxRoot: _s, driftDetector, customTools, ...rest } = opts;
  // driftDetector 可为对象 (JSON 安全) 或 false; 函数无 → 只在是对象/false 时透传。
  const dd = typeof driftDetector === 'object' || driftDetector === false ? { driftDetector } : {};
  const kept = (customTools ?? []).filter((t) => t.sandboxSafe === true);
  const dropped = (customTools ?? []).filter((t) => t.sandboxSafe !== true);
  if (dropped.length > 0) {
    const names = dropped.map((t) => t.name);
    logger.warn({ tools: names }, `[omd/sandboxed-leaf] 非 sandboxSafe 扩展工具不进隔离叶 (已剥除): ${names.join(', ')}`);
  }
  return { ...rest, ...dd, ...(kept.length > 0 ? { customTools: kept } : {}) };
}

/**
 * 本次调用父侧要伺候的桥工具 = 构造期 sandboxSafe 扩展工具 ∪ 本次 `input.face.customTools`。
 * face 那份按调用变 (卡闭包捕获当次 run 的 config), 所以不能在造 runner 时算死; 同名时 face 胜 (它是这一发显式给的面)。
 * 证伪方式 (sandboxed-leaf-face-bridge.test.ts): 删掉 face 那一半 → 「face 卡进桥」那条红。
 */
export function bridgeToolsForCall(bridgeTools: ReadonlyMap<string, AnyOmdTool>, input: AgentLeafInput): Map<string, AnyOmdTool> {
  const out = new Map(bridgeTools);
  for (const t of input.face?.customTools ?? []) out.set(t.name, t);
  return out;
}

/** 单次调用的 JSON 边界形状。input 原样保留, profile 等调用期字段不得迁入构造期 opts。 */
export function leafWorkerPayload(
  opts: Record<string, unknown>,
  input: AgentLeafInput,
  bridgePrefix?: string,
): LeafWorkerPayload {
  return { opts, input, ...(bridgePrefix ? { toolBridge: { prefix: bridgePrefix } } : {}) };
}

/**
 * D-9 工具桥父侧: 轮询 worktree 里的 `${prefix}-req-N.json` (worker 写 tmp+rename, 文件出现即完整),
 * 用**本进程原有 customTools 实例**执行 —— ext 工具的 execute 闭包走的是宿主既有的 host IPC 代理
 * (ext-tools.ts), host 仍按 cwd 跨 run/跨叶共享, 这里与 worker 都不 loadExtension、不新起 host。
 * 结果写 `${prefix}-res-N.json` (同样 tmp+rename)。返回停止函数; 残留桥文件由调用方 finally 清。
 * 轮询而非 fs.watch: 与 payload/result 同一文件通道形态, 50ms 对一次工具调用的延迟预算无感,
 * 也不赌 bwrap jail 内外 inotify 的跨命名空间语义。
 */
function serveToolBridge(root: string, prefix: string, tools: ReadonlyMap<string, AnyOmdTool>): () => void {
  const reqHead = `${prefix}-req-`;
  const timer = setInterval(() => {
    let pending: string[];
    try {
      pending = readdirSync(root).filter((f) => f.startsWith(reqHead) && f.endsWith('.json'));
    } catch {
      return; // root 读不到 → 本 tick 跳过 (下一个 tick 再试; 子进程退出后由 finally 停表)
    }
    for (const f of pending) {
      let req: { name: string; id: string; params: unknown };
      try {
        req = JSON.parse(readFileSync(join(root, f), 'utf8'));
        rmSync(join(root, f), { force: true }); // 先取走: 下一个 tick 不再重复拾取同一请求
      } catch {
        continue; // 已被上一 tick 取走 / 读不到 → 跳过
      }
      void (async () => {
        const n = f.slice(reqHead.length, -'.json'.length);
        const resTmp = join(root, `${prefix}-res-${n}.json.tmp`);
        const resAbs = join(root, `${prefix}-res-${n}.json`);
        let body: string;
        try {
          const tool = tools.get(req.name);
          if (!tool) throw new Error(`父进程没有名为 "${req.name}" 的保留工具 (D-9 闸两侧不一致)`);
          const result = await tool.execute(req.id, req.params);
          body = JSON.stringify({ ok: true, result });
        } catch (err) {
          body = JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        writeFileSync(resTmp, body);
        renameSync(resTmp, resAbs);
      })().catch((err) => logger.warn({ err: (err as Error).message, prefix }, '[omd/sandboxed-leaf] 工具桥写响应失败'));
    }
  }, 50);
  return () => clearInterval(timer);
}

/**
 * 造 subprocess-bwrap 隔离 leaf runner。opts.sandboxRoot 必设 (= worktree 绝对根)。
 * 每次调用 spawn 一次性 bwrap 子进程; leafTimeoutMs 超时杀进程。
 */
export function createSandboxedLeafRunner(opts: AgentLeafRunnerOpts): AgentLeafRunner {
  const root = resolve(opts.sandboxRoot!);
  // 造 runner 的时候就把 worker 找定 —— 找不到当场响, 不留到第一个 leaf (见 resolveWorker)。
  const { argvPath: workerPath, extraRoBinds } = resolveWorker(root);
  const roBinds = [...defaultRoBinds(root), ...extraRoBinds];
  // git 元数据 (opts.sandboxGit 显式要才挂; 见该字段的注 —— eval 档不要, 生产隔离档要)。
  // 解析在**造 runner 的时候**做一次: 每 leaf 一次 `git rev-parse` 是白花的钱, 而这棵树的
  // gitdir 在一个 run 里不会变。要了却解析不出 (root 不是 git 树 / 没有 git) → 响亮说一次:
  // 静默无 git 正是这次要修的那个症状 (叶子自己撞上去, 撞完还不知道为什么)。
  let gitBinds: GitBinds | null = null;
  if (opts.sandboxGit) {
    gitBinds = resolveGitBinds(root);
    if (!gitBinds) logger.warn({ root }, '[omd/sandboxed-leaf] 要求挂 git 元数据但解析不出 (不是 git 树?) — jail 里仍无 git');
  }
  const optsJson = serializableOpts(opts);
  // D-9 执行端: 保留的 sandboxSafe 工具在 worker 侧只是 decl (execute 过不了 JSON 边界),
  // 真调用经文件桥回到**这里的原有实例** (与 serializableOpts 同一张 `sandboxSafe === true` 判据)。
  // 零保留工具 → 不开桥、payload 不落 toolBridge 键 —— 与零 ext 基线逐字节一致。
  const bridgeTools = new Map((opts.customTools ?? []).filter((t) => t.sandboxSafe === true).map((t) => [t.name, t] as const));

  // ── jail 自检层① (2026-08-21): 构造期把挂载面对一遍 ──────────────────────────────
  //
  // **一次, 不是每个 leaf 一次** —— jail 是 per-leaf 构造的, 任何"每次起跑探一下"都会乘以叶子数。
  // 这里判的全是 argv 上的纯数据 (微秒级), 而下面那些输入 (root / roBinds / gitBinds / workerPath)
  // 在一个 run 里不会变, 所以对一次就够。piAgentCopy 是唯一每 leaf 变的, 它不参与这几条判据。
  //
  // fatal 当场抛, 与 resolveWorker 同一条理由: 让它到第一个 leaf 才炸, 代价是先烧掉一整轮
  // conductor 规划 (3f8e366 就是这么烧的 —— 9 节点全灭, 而单测与容器性探针全绿)。
  {
    const problems = checkJailArgv({
      argv: bwrapArgs(root, roBinds, { ...(gitBinds ? { gitBinds } : {}) }),
      root,
      workerPath,
      wantGit: opts.sandboxGit === true,
      roBinds,
    });
    const fatal = problems.filter((p) => p.level === 'fatal');
    const warns = problems.filter((p) => p.level === 'warn');
    if (warns.length) {
      logger.warn({ root, problems: warns }, `[omd/sandboxed-leaf] jail 起跑自检: ${describeJailProblems(warns)}`);
    }
    if (fatal.length) {
      throw new Error(`[sandboxed-leaf] jail 挂载面对不上, 每个 leaf 都会挂 —— 与其烧一轮规划再炸, 不如现在就说: ${describeJailProblems(fatal)}`);
    }
  }

  return async (input: AgentLeafInput): Promise<AgentLeafResult> => {
    // P2e (2026-09-02): 与 agent-leaf 的默认同源 (2026-08-01 一起从 240s 提到 1h) ——
    // 这里若只认 opts.leafTimeoutMs, 引擎按剩余预算收紧的 `input.leafTimeoutMs` 只会传进
    // worker 内部的 agent-leaf 调用, jail 这层外部杀进程计时器却仍按老的固定 1h 走,
    // 同一次调用两个天花板。按调用取紧的那个, 与 in-process 档 (agent-leaf.ts) 同一条闸。
    const timeoutMs = sandboxedLeafKillTimeoutMs(input, opts);
    const id = `${process.pid}-${++seq}`;
    const payloadRel = `.omd-leaf-payload-${id}.json`;
    const resultRel = `.omd-leaf-result-${id}.json`;
    const payloadAbs = join(root, payloadRel);
    const resultAbs = join(root, resultRel);
    // P3 S6b × D-9 (2026-09-04): 按调用的 `input.face.customTools` (conductor 的七张派工卡) 与 opts 的 sandboxSafe
    // 工具走**同一座桥**。卡的 execute 是父进程引擎 config 上的闭包 (派子图), 过不了 JSON 边界; 此前不桥接 →
    // worker 里只剩 decl, pi 按名找到工具却 `prepared.tool.execute is not a function` —— run 4795bed7 实账:
    // 隔离档 conductor 71 次工具调用, work/spawn/explore/best_of 四张卡全拒, 派发 0 次, 而 head 档 (不进 jail) 同图正常。
    const callTools = bridgeToolsForCall(bridgeTools, input);
    const bridgePrefix = callTools.size > 0 ? `.omd-leaf-tool-${id}` : null;
    writeFileSync(payloadAbs, JSON.stringify(leafWorkerPayload(optsJson, input, bridgePrefix ?? undefined)));

    // pi agent dir 即弃 rw 副本 (每 leaf 一份, 防并发写共享态; 见 makePiAgentCopy ⚠ OAuth 注)。
    const piAgentCopy = makePiAgentCopy();
    // bwrap [binds] bun run <worker> <payloadRel> <resultRel> —— 相对路径, cwd=worktree (bwrap --chdir)。
    const argv = [
      'bwrap',
      ...bwrapArgs(root, roBinds, {
        ...(piAgentCopy ? { piAgentCopy } : {}),
        ...(gitBinds ? { gitBinds } : {}),
        // 订阅座位进 jail 要带凭据 —— 隔离档下 jailRoot 不看座位, conductor 也是沙箱叶
        // (实账 run 8976c8be: `Not logged in · Please run /login` 直接把节点打成 failed)。
        ...(input.model.startsWith(`${CLAUDE_SDK_PROVIDER}:`) ? { claudeCredentials: true } : {}),
      }),
      'bun',
      'run',
      workerPath,
      payloadRel,
      resultRel,
    ];
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    // 桥与进程同寿: spawn 之后才开表 (早开空转), finally 里停 (worker 死了不再喂响应)。
    const stopBridge = bridgePrefix ? serveToolBridge(root, bridgePrefix, callTools) : null;
    // 超时 = leaf 硬上界 + 30s buffer (worker 内部还有自己的 leafTimeoutMs / 进展看门狗兜底)。
    // ⚠ 判据必须是**我们自己那把刀砍没砍**, 不是 `proc.killed` (2026-07-31 live 抓出来的):
    // worker 因 `Module not found` 秒级自己死掉时, 那条错误消息照样播报「子进程超时被杀 (3600s)」——
    // 而两种成因的下一步**相反**: 真超时 → 加时间/换池; 起不来 → 修部署, 加多少时间都没用。
    // 这与本轮 A5 普查治的是同一种病, 只是它藏在一个 fail-open 的错误分支里。
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeoutMs + 30_000);
    try {
      const [, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(killer);
      let parsed: { ok: boolean; result?: AgentLeafResult; error?: string } | null = null;
      try {
        parsed = JSON.parse(readFileSync(resultAbs, 'utf8'));
      } catch {
        parsed = null;
      }
      if (parsed?.ok && parsed.result) return parsed.result;
      // worker 没产出结果 (崩溃/超时被杀/bwrap 起不来) → 响亮抛 (executor-dag failedFromThrow 接住,
      // 别静默降级成 empty-done 假成功)。
      const why =
        parsed?.error ??
        (timedOut
          ? `子进程跑满 ${timeoutMs / 1000}s 被我们杀掉 (真超时 → 加时间/换池)`
          : `子进程自己退了 (exit ${code}, 没跑满超时) — 多半是起不来而不是跑得慢; 加时间没用, 看下面的 stderr`);
      // `why` 必须进日志 (2026-08-11): 此前只记 code/stderr, 于是 worker 侧**自己报的**错误
      // (leaf-worker 恒 `process.exit(0)`, 失败经结果文件的 `{ok:false,error}` 回传) 在日志上
      // 长成一句无解的「worker 失败 code:0」—— 退出码 0 与"判失败"看着矛盾, 其实成因就写在
      // 那个字段里, 只是没被记下来。吞异常不吞证据。
      // jail 自检层③ (owner 裁 2026-08-21): 认一认这是不是**挂载面缺东西**, 而不是模型不行。
      // 只在这条失败路径上跑 —— jail 是 per-leaf 构造的, 任何起跑探针都会乘以叶子数。
      // 认不出来返回 null, 原判词原样出去 (不许瞎猜)。
      const jail = diagnoseJailFailure(stderr, root);
      const why2 = jail ? `${describeJailDiagnosis(jail)} — 原始判词: ${why}` : why;
      // **组装出来的 bwrap argv 一次都没打过** (2026-08-21 查全部 logger.* 调用点确认)。
      // 打出来你就能把它复制走、手工进同一个 jail 坐着调 —— 这正是"调试空间", 且不用动隔离。
      // 只在失败时打: 正常路径上它是每个 leaf 一行的噪音。
      logger.error(
        { root, code, timedOut, why: why2, ...(jail ? { jailMissing: jail.missing } : {}), bwrapArgv: argv, stderr: stderr.slice(-600) },
        '[omd/sandboxed-leaf] worker 失败',
      );
      throw new Error(`[sandboxed-leaf] ${why2} — stderr 尾: ${stderr.slice(-400)}`);
    } finally {
      stopBridge?.();
      rmSync(payloadAbs, { force: true });
      rmSync(resultAbs, { force: true });
      if (bridgePrefix) {
        for (const f of readdirSync(root).filter((f) => f.startsWith(bridgePrefix))) rmSync(join(root, f), { force: true });
      }
      if (piAgentCopy) rmSync(piAgentCopy, { recursive: true, force: true });
    }
  };
}
