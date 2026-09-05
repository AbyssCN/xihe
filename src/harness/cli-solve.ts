/**
 * src/harness/cli-solve —— `omd solve "<goal>" [flags]` headless CLI (E1a, bench/CI 入口面)。
 *
 * ## 这是什么
 *
 * `omd solve` 是 MCP `dag_goal` 在**无 MCP 客户端 / 无 TTY 环境**的入口面:bench 容器、CI、
 * cron 全走它。零新执行路径 —— 全部跑法仍由 `scripts/goal-worker.ts` 承担,本文件只做
 * argv 解析、worker spawn、resultOut 终局读、退出码映射。
 *
 * ## 不做什么 (INV-1 零第二套语义)
 *
 * 不 import 任何 engine/goal 执行内部件 (runGoal / runRegistry / buildConfig / ignite 闸 …);
 * 唯一执行通路 = `Bun.spawn(['bun','run', workerScriptPath(), ...flags])` (非 detached,
 * stdio inherit, await exited) —— stamp / 闸 / checkpoint / 留痕 / 毒集全部照 MCP 那条路。
 * 这条铁律是本仓最贵教训之一 ("第二套语义"):任何 "cli 走捷径" 的诱惑都拒。
 *
 * ## 退出码 (D-4, 机械映射, fail-loud)
 *
 *   0  resultOut 首部 `outcome: <kind>` 命中 `isDeliveredOutcome` (success / delivered-with-red)
 *   2  outcome 其它 (blocked / not-converged / cancelled / error / budget-stopped …)
 *   3  worker 退出但 resultOut 缺失 / 无 outcome 行 (响亮,绝不"读不到就 0")
 *   1  参数错误 / spawn 抛 / 非零子进程退出 + resultOut 同样不可读 → 同步早退
 *
 * `isDeliveredOutcome` 是本仓**判交付达标**的单点判 (`src/harness/run-outcome.ts:268`),
 * 不要在本文件再写一份 `outcome === 'success' || outcome === 'delivered-with-red'`。
 *
 * ## 无交互硬约束 (D-5)
 *
 * 全程零 stdin 依赖 / 零 TTY 探测分支 / 零 `process.stdin.isTTY` 分叉。worker 输出经
 * stdio=inherit 直通 stdout/stderr (bench 的 tee 在外面接)。
 *
 * ## 切片 2 detached (D-6, 2026-09-05)
 *
 * `--detached`: 母进程 spawn worker 后立即退 0,与 MCP `detached:true` 同语义。
 * spawn 时 stdio 三件套 `ignore` + `unref()` —— 母进程不死带 worker。
 * 日志与 resultOut 由 worker 自落,CLI 不读不写 (D-6: 与 MCP detach 一致)。
 *
 * ## 切片 2 GWT-6b (2026-09-05, 实测修两路不一致)
 *
 * worker 主流程对 `dag_goal` 强制 `--goal` 必填;但 cli-solve 的 USAGE 写「goal 与 --sdd
 * 至少其一」。当调用方只给 `--sdd`,本片读 SDD 首部标题作为 `--goal` 补齐,让 worker 不再以
 * 「--run-id 与 --goal 必填」退出 3。**职责在 cli-solve**:worker 的强制保留(它没 SDD 上下文,
 * 不该去读)。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeliveredOutcome } from './run-outcome';

/** worker 脚本按**本包安装位置**解析。先例 `src/mcp/tools/goal.ts:135-137` 同款修法:
 *  相对 cwd 拼 'scripts/goal-worker.ts' 在别的 repo 里必然 Script not found,
 *  而错误只进 .log —— run 会静默卡在"起了但永远不出现"。 */
export function solveWorkerScriptPath(): string {
  return join(import.meta.dir, '..', '..', 'scripts', 'goal-worker.ts');
}

/** CLI v1 最小集 (D-3) —— 位置参 <goal> 或 --sdd 二选一至少其一;其它全可选。
 *  切片 2 新增 detached。 */
export interface ParsedSolveArgs {
  /** 第一个非 flag 位置参 (D-3)。 */
  goal?: string;
  /** `--sdd <path>` 直通档 (SDD 已结晶免转录)。 */
  sdd?: string;
  /** `--cwd <dir>`,缺省 process.cwd()。 */
  cwd: string;
  /** `--result-out <path>`,缺省 `<cwd>/.omd/solve-results/<ts>.md`。 */
  resultOut: string;
  /** `--max-rounds N`,worker 既有入参面。 */
  maxRounds?: number;
  /** `--budget-minutes N`,worker 既有入参面。 */
  budgetMinutes?: number;
  /** `--budget-tokens N`,worker 既有入参面。 */
  budgetTokens?: number;
  /** `--tier simple|complex`。 */
  tier?: 'simple' | 'complex';
  /**
   * `--branch-strategy branch|head` (2026-09-03, 夜链 Q1④)。此前 CLI 不认这个 flag: 调用方传了
   * 也被静默丢掉, 写落在主工作树, 而调用方以为在隔离分支上 —— 参数矩阵空格 (与 goal-worker
   * 2026-08-10 那次同形)。词表与 worker / `solve` MCP 一致; 别的值 (如 `worktree`) 响亮拒。
   */
  branchStrategy?: 'branch' | 'head';
  /**
   * 切片 2: `--detached` —— 与 MCP `detached:true` 同语义。
   * 母进程 spawn worker 后立即退 0,不读 resultOut,不走 D-4 退出码映射。
   * (CLI 自己也要拒 `--detached --wait` 组合:wait 对 detached 无意义。)
   */
  detached?: boolean;
  /** usage 错误信息;在场 → INV-4 响亮退出,零 spawn。 */
  usageError?: string;
}

/** 取 `--name <v>` 的 v;缺 flag 或缺值 → undefined。 */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** 取 `--name <v>` 的 v 并按 parseInt 转 number;非数字或 ≤0 → undefined (worker 内会校验)。 */
function intFlag(args: string[], name: string): number | undefined {
  const v = flagValue(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** `--detached` 是布尔 flag (无值);在场 → true。 */
function boolFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** 把"被某个 flag 占用为值的 arg 索引"收集起来,排除掉再做位置参。 */
function isFlagValueIndex(args: string[], i: number): boolean {
  const prev = args[i - 1];
  return prev !== undefined && prev.startsWith('--') && prev !== '--';
}

/**
 * 解析 argv。**故意不**抛:任何解析错误 → 返回 `{usageError}` 让编排函数响亮退出 (INV-4)。
 *
 * 注意:位置参只取第一个**既不是 flag 又不是 flag 值**的 arg (D-3 最小集;
 * 多 position 按未定义行为,显式 usage 拒掉)。
 */
export function parseSolveArgs(args: string[], defaultCwd = process.cwd()): ParsedSolveArgs {
  const positional = args.filter((a, i) => !a.startsWith('-') && !isFlagValueIndex(args, i));
  const goal = positional[0];
  const sdd = flagValue(args, '--sdd');
  const cwd = flagValue(args, '--cwd') ?? defaultCwd;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const resultOut = flagValue(args, '--result-out') ?? join(cwd, '.omd', 'solve-results', `${ts}.md`);
  const tierRaw = flagValue(args, '--tier');
  const tier = tierRaw === 'simple' || tierRaw === 'complex' ? tierRaw : undefined;
  const branchRaw = flagValue(args, '--branch-strategy');
  const branchStrategy = branchRaw === 'branch' || branchRaw === 'head' ? branchRaw : undefined;
  const detached = boolFlag(args, '--detached');

  if (!goal && !sdd) {
    return {
      cwd,
      resultOut,
      ...(tier ? { tier } : {}),
      usageError: 'goal 与 --sdd 至少其一必填',
    };
  }
  if (tierRaw !== undefined && !tier) {
    return {
      goal,
      ...(sdd ? { sdd } : {}),
      cwd,
      resultOut,
      ...(detached ? { detached } : {}),
      usageError: `--tier 必须是 simple 或 complex,收到: ${tierRaw}`,
    };
  }
  if (branchRaw !== undefined && !branchStrategy) {
    return {
      goal,
      ...(sdd ? { sdd } : {}),
      cwd,
      resultOut,
      ...(detached ? { detached } : {}),
      usageError: `--branch-strategy 必须是 branch 或 head,收到: ${branchRaw}`,
    };
  }
  return {
    ...(goal ? { goal } : {}),
    ...(sdd ? { sdd } : {}),
    cwd,
    resultOut,
    ...(intFlag(args, '--max-rounds') !== undefined ? { maxRounds: intFlag(args, '--max-rounds')! } : {}),
    ...(intFlag(args, '--budget-minutes') !== undefined ? { budgetMinutes: intFlag(args, '--budget-minutes')! } : {}),
    ...(intFlag(args, '--budget-tokens') !== undefined ? { budgetTokens: intFlag(args, '--budget-tokens')! } : {}),
    ...(tier ? { tier } : {}),
    ...(branchStrategy ? { branchStrategy } : {}),
    ...(detached ? { detached } : {}),
  };
}

/** spawn 注入面 —— 与 `goal.ts:113` 的 `spawnDetached` 同款 (测试密封,永不起真进程)。
 *  切片 2: detached 路径走另一组 stdio (ignore + unref),所以扩展 spawn 面带 stdio 字段。 */
export interface SolveSpawnHandle {
  /** 进程退出码 (null = 被信号带走,Bun.spawn 原样)。 */
  exited: Promise<number | null>;
  /** 切片 2: 在 detached 路径上由编排函数调用,模拟 worker 进程的 unref。
   *  默认 spawn (Bun.spawn) 上也是 no-op (Bun.spawn 不暴露 unref 同款接口时测试方便)。 */
  unref?: () => void;
  /** 切片 2: 测试可见的 pid (默认 spawn 拿 Bun 真实 pid;fake 自己定)。 */
  pid?: number;
}
export interface SolveSpawnOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 非 detached:三件套 inherit (D-5 零 TTY 探测);detached:三件套 ignore (母进程不等、不接管 IO)。 */
  stdio: ['inherit', 'inherit', 'inherit'] | ['ignore', 'ignore', 'ignore'];
  /** 切片 2: 是否 detached (= stdio ignore + 调用后 unref)。默认 false。 */
  detached?: boolean;
}
export type SolveSpawn = (cmd: string[], opts: SolveSpawnOpts) => SolveSpawnHandle;

/** 默认 spawn = Bun.spawn。非 detached 三件套 inherit;detached 三件套 ignore + unref。 */
export function defaultSolveSpawn(cmd: string[], opts: SolveSpawnOpts): SolveSpawnHandle {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdio[0],
    stdout: opts.stdio[1],
    stderr: opts.stdio[2],
    // 切片 2 (D-6): `detached: true` 才让子进程自成会话/进程组 ——
    // 否则 stdio=ignore + unref 的进程组信号会把它连坐杀掉(实测过)。
    ...(opts.detached ? { detached: true } : {}),
  });
  if (opts.detached) proc.unref();
  return { exited: proc.exited as Promise<number | null>, unref: () => proc.unref(), pid: proc.pid };
}

/**
 * 从 resultOut 读终态字面 (第二行 `terminal: <label>`, D-2)。缺席 → undefined。
 *
 * ⚠ 缺席**不回落 outcome**: 那会让「旧格式 resultOut」与「终态字面恰好等于 outcome」
 * 变成同一格, 事后再也分不开 (仓规坑 ①)。
 */
export function readTerminalLabel(resultOutPath: string): string | undefined {
  if (!existsSync(resultOutPath)) return undefined;
  try {
    return /^terminal:\s*(\S+)/m.exec(readFileSync(resultOutPath, 'utf8'))?.[1];
  } catch (e) {
    // 吞异常不许吞证据 (仓规): 读失败的原文只有这里能留 —— 收尾行会印「缺席」。
    process.stderr.write(`[omd solve] resultOut 读 terminal 行失败 (${resultOutPath}): ${(e as Error).message}\n`);
    return undefined;
  }
}

/** 从 resultOut 读 outcome kind (首行 `outcome: <kind>`)。缺失或无 outcome 行 → undefined。 */
export function readOutcomeKind(resultOutPath: string): string | undefined {
  if (!existsSync(resultOutPath)) return undefined;
  let text: string;
  try {
    text = readFileSync(resultOutPath, 'utf8');
  } catch (e) {
    // 吞异常不许吞证据 (仓规): undefined 会让调用方 exit 3, 但读失败的原文只有这里能留。
    process.stderr.write(`[omd solve] resultOut 读取失败 (${resultOutPath}): ${(e as Error).message}\n`);
    return undefined;
  }
  const firstLine = text.split('\n', 1)[0] ?? '';
  const m = firstLine.match(/^outcome:\s*(\S+)/);
  return m?.[1];
}

/**
 * 切片 2 GWT-6b 修两路不一致:从 SDD 文件首部抽一标题,补作 --goal 的值。
 *
 * 纯文本:`#` 开头的首行视为标题;取 `#` 与首段空白之后、末尾空白之前的文本。
 * 文件读不出 / 无标题行 → 返回 undefined (由调用方决定是否响亮退出)。
 */
export function deriveGoalFromSdd(sddPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(sddPath, 'utf8');
  } catch (e) {
    // 吞异常不许吞证据:文件读不到 → 一行 stderr,调用方按 usageError 退。
    process.stderr.write(`[omd solve] --sdd 文件读取失败 (${sddPath}): ${(e as Error).message}\n`);
    return undefined;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1]!;
  }
  return undefined;
}

/** orchestration 入参面 (测试注入替身)。 */
export interface SolveCliDeps {
  /** 替换 Bun.spawn (GWT-1 / GWT-2 / GWT-5 测试密封)。 */
  spawn?: SolveSpawn;
  /** 替换 wall clock (GWT-5 默认 resultOut 文件名稳定用)。 */
  now?: () => Date;
}

/** `omd solve "<goal>" [flags]` 编排 —— 返回退出码 (供 cli.ts 透传 process.exit)。
 *
 *  本函数**不调 process.exit**,由 cli.ts 决策 (与 cli.ts 内其它分支一致);
 *  编排内一切副作用 (mkdir / spawn) 都可被 deps 替换。 */
export async function runSolveCLI(args: string[], deps: SolveCliDeps = {}): Promise<number> {
  const parsed = parseSolveArgs(args);

  // ── INV-4 缺参响亮:usage 错误 → 打 usage 退 1,零 spawn ─────────────────────
  if (parsed.usageError) {
    process.stderr.write(`omd solve: ${parsed.usageError}\n`);
    process.stderr.write(USAGE);
    return 1;
  }

  // ── 切片 2 GWT-6b: --sdd 单独在场 → 取 SDD 首部标题作 goal(worker 强制 goal 必填) ──
  let goalForSpawn = parsed.goal;
  if (!goalForSpawn && parsed.sdd) {
    const derived = deriveGoalFromSdd(parsed.sdd);
    if (!derived) {
      process.stderr.write(`omd solve: --sdd 未含可读的 '# …' 标题 (${parsed.sdd});显式给 goal 或修正 SDD 顶行。\n`);
      process.stderr.write(USAGE);
      return 1;
    }
    goalForSpawn = derived;
  }

  // ── 切片 2 detached 路径:spawn 后立即退 0,不读 resultOut ──────────────
  if (parsed.detached) {
    const runId = randomUUID();
    const spawn = deps.spawn ?? defaultSolveSpawn;
    const cmd = [
      'bun',
      'run',
      solveWorkerScriptPath(),
      '--run-id', runId,
      '--cwd', parsed.cwd,
      // GWT-6: 显式带 --tool (worker 默认也是 dag_goal, 但 spawn 那行明写以便 grep/审计
      // 直接抓到; 若哪天 worker 默认改,这条 spawn 不变仍走得通)。
      '--tool', 'dag_goal',
      '--goal', goalForSpawn!,
      ...(parsed.tier ? ['--tier', parsed.tier] : []),
      ...(parsed.maxRounds !== undefined ? ['--max-rounds', String(parsed.maxRounds)] : []),
      ...(parsed.budgetTokens !== undefined ? ['--budget-tokens', String(parsed.budgetTokens)] : []),
      ...(parsed.budgetMinutes !== undefined ? ['--budget-minutes', String(parsed.budgetMinutes)] : []),
      '--result-out', parsed.resultOut,
      ...(parsed.sdd ? ['--sdd-path', parsed.sdd] : []),
      ...(parsed.branchStrategy ? ['--branch-strategy', parsed.branchStrategy] : []),
    ];
    let handle: SolveSpawnHandle;
    try {
      handle = spawn(cmd, { cwd: parsed.cwd, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    } catch (e) {
      process.stderr.write(`omd solve (--detached) spawn 失败: ${(e as Error).message}\n`);
      return 1;
    }
    // detached 的副作用在 spawn 那一刻就定了 (worker 自己写 .omd/),CLI 不建 resultOut 父目录
    // —— worker 端 dag_goal handler 会 mkdirSync。但若 worker 在 mkdirSync 之前死,CLI 也不管。
    handle.unref?.();
    // stdout(不放日志;日志走 stderr)— 与 MCP `detached:true` 同语义
    process.stdout.write(`runId: ${runId}\n`);
    return 0;
  }

  // resultOut 目录建好 (worker 不替你建;goal.ts:1136 mkdirSync 在 handler 内,新写穿前要父目录在)
  try {
    mkdirSync(dirname(parsed.resultOut), { recursive: true });
  } catch (e) {
    process.stderr.write(`omd solve: resultOut 父目录创建失败 (${dirname(parsed.resultOut)}): ${(e as Error).message}\n`);
    return 1;
  }

  const runId = randomUUID();
  const spawn = deps.spawn ?? defaultSolveSpawn;
  const cmd = [
    'bun',
    'run',
    solveWorkerScriptPath(),
    '--run-id', runId,
    '--cwd', parsed.cwd,
    '--goal', goalForSpawn!,
    ...(parsed.tier ? ['--tier', parsed.tier] : []),
    ...(parsed.maxRounds !== undefined ? ['--max-rounds', String(parsed.maxRounds)] : []),
    ...(parsed.budgetTokens !== undefined ? ['--budget-tokens', String(parsed.budgetTokens)] : []),
    ...(parsed.budgetMinutes !== undefined ? ['--budget-minutes', String(parsed.budgetMinutes)] : []),
    '--result-out', parsed.resultOut,
    ...(parsed.sdd ? ['--sdd-path', parsed.sdd] : []),
    // 不转发这一格 = 调用方以为在分支上而写落主树 (Q1④ 实例: 夜链 2026-09-02 两卡)。
    ...(parsed.branchStrategy ? ['--branch-strategy', parsed.branchStrategy] : []),
  ];

  let handle: SolveSpawnHandle;
  try {
    handle = spawn(cmd, { cwd: parsed.cwd, stdio: ['inherit', 'inherit', 'inherit'] });
  } catch (e) {
    process.stderr.write(`omd solve: spawn 失败: ${(e as Error).message}\n`);
    return 1;
  }

  try {
    // 等 worker 收尾; 进程退出码**有意不消费** (D-4: 终局判据 = resultOut 的 outcome 行, 不是进程码)。
    await handle.exited;
  } catch (e) {
    // 子进程异常抛出 (极少见,Bun.spawn 不通常这样) → 先读 resultOut 再判。
    process.stderr.write(`omd solve: worker await exited 抛错: ${(e as Error).message}\n`);
  }

  // D-4: 退出码 = 从 resultOut 机械读 outcome (worker 终局会写 `outcome: <kind>` 首部)。
  const outcome = readOutcomeKind(parsed.resultOut);
  // D-2: 终态字面与 outcome **并排印** —— 「机器判过」与「机器没判据可判」此前在这一行上
  // 长得一模一样, 而两者的下一步相反。缺席印「缺席」, 不拿 outcome 顶替。
  const terminal = readTerminalLabel(parsed.resultOut);
  process.stderr.write(
    outcome
      ? `omd solve: outcome=${outcome} terminal=${terminal ?? '(缺席)'} · resultOut=${parsed.resultOut}\n`
      : `omd solve: resultOut 缺失或无 outcome 行 · resultOut=${parsed.resultOut}\n`,
  );

  if (outcome === undefined) {
    return 3; // 响亮,绝不"读不到就 0"
  }
  return isDeliveredOutcome(outcome) ? 0 : 2;
}

/** USAGE 一行 (cli.ts 内 USAGE 多行的 +1)。刻意保持薄,与 cli.ts 现有 USAGE 风格一致。 */
export const USAGE = `  omd solve "<goal>" [--sdd <path>] [--cwd <dir>] [--result-out <path>]
                 [--max-rounds N] [--budget-minutes N] [--budget-tokens N] [--tier simple|complex]
                 [--branch-strategy branch|head] [--detached]
                 headless autonomous run (bench/CI 入口面);<goal> 与 --sdd 至少其一必填
`;
