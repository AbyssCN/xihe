/**
 * goal/criterion-union —— **共识候选取并集** 的纯函数层 (2026-09-06, 契约
 * `docs/plan/2026-09-06-共识并集验收-执行契约.md`)。
 *
 * 三候选共识 (`./criterion-consensus`) 只取一份, 另两份指向的测试目标就丢了 —— 实测
 * `criterionConsensus.agreement` 均值 0.21–0.37, 三份**大多指不同文件**。这里把它们的路径参数
 * 并进同一条命令: 只加宽判据, 不换出题人 (异族出题在 R4 已判负, 采纳题 0.42 vs 其余 0.70)。
 *
 * 本模块**零 IO 零 LLM**: 命令闸由调用方以 `opts.blocked` 注入 (生产是
 * `acceptanceCommandBlockReason`), 路径识别复用 `directionSignature` 那一份 —— 不抄第二份,
 * 抄一份早晚先漂, 而漂的后果是并集里混进一条恒红的路径。
 */
import type { AcceptanceSpec } from './classify-acceptance';
import { directionSignature, type CriterionConsensus } from './criterion-consensus';

/** 并集的结果 (D-3)。`command` 是拼好的那条; 不拼时它与传进来的 `chosen` 逐字相同。 */
export interface UnionResult {
  command: string;
  /** 命令真被加宽了才是 true。同 runner 但没带来新路径 ⇒ false (命令零改动)。 */
  applied: boolean;
  /** 结果命令里的路径参数个数 —— 恒等于 `pathArgs(command).length` (两个数分开算就会漂)。 */
  paths: number;
  /** 被 `opts.blocked` 拒掉、因而没进并集的候选份数 (D-2)。 */
  dropped: number;
  why?: string;
}

/** 进 loop ledger 的并集读数 (D-3) —— 结果里除命令本身之外的那几格。 */
export type CriterionUnionLedger = Omit<UnionResult, 'command'>;

/**
 * 挂上并集读数的共识账本格 (D-3)。
 *
 * ⚠ 三态别压平 (§静默坑 1): `union` 整格缺席 = **开关没开** (`OMD_CRITERION_UNION` 不是 `1`,
 * 或择优选中的那份不是执行型); `applied: false` = 开了但这次拼不成 (为什么在 `why`)。
 */
export type ConsensusWithUnion = CriterionConsensus & { union?: CriterionUnionLedger };

/** `python -m pytest` 这类**模块宿主**: 真正的 runner 是 `-m` 后面那个名字。 */
const MODULE_HOSTS = new Set(['python', 'python3']);
/** `uv run pytest` / `poetry run pytest` 这类**环境壳**: `run` 后面那个才是 runner。 */
const RUN_WRAPPERS = new Set(['uv', 'poetry']);
/** `npx jest` / `bunx tsc` 这类**取件壳**: 下一个词就是 runner, 没有中间的 `run`。 */
const BARE_WRAPPERS = new Set(['npx', 'bunx']);
/** 子命令是 runner 身份的一部分 —— `bun test` 与 `bun run x` 不是同一个 runner, 并进一条会跑错东西。 */
const SUBCOMMAND_RUNNERS = new Set(['bun', 'cargo', 'go', 'npm', 'pnpm', 'yarn', 'deno', 'dotnet']);

/** 命令切词: 去引号、丢空串。与 `directionSignature` 里那份切法同款。 */
function commandTokens(command: string): string[] {
  return command
    .split(/\s+/)
    .map((raw) => raw.replace(/^["']|["']$/g, ''))
    .filter((t) => t !== '');
}

/**
 * 归一后的 runner 首词组 (D-1) —— 并集能不能拼的**唯一**判据。
 *
 * 归一是必须的: `pytest` / `python -m pytest` / `uv run pytest` 指的是同一个 runner,
 * 不归一就永远拼不上, 而它们恰是同一个 python 仓里三份候选最常见的三种写法。
 *
 * @returns 归一后的首词组 (`'pytest'` / `'bun test'` / …); 空命令 ⇒ 空串 (不编一个首词出来)。
 */
export function runnerHead(command: string): string {
  let toks = commandTokens(command);
  // 剥壳有界 (最多三层): 壳只说"用哪个环境跑", 不说"跑的是什么"。
  for (let layer = 0; layer < 3 && toks.length > 1; layer++) {
    const head = toks[0]!;
    const next = toks[1]!;
    if (MODULE_HOSTS.has(head) && next === '-m') toks = toks.slice(2);
    else if (RUN_WRAPPERS.has(head) && next === 'run') toks = toks.slice(2);
    else if (BARE_WRAPPERS.has(head)) toks = toks.slice(1);
    else break;
  }
  const head = toks[0] ?? '';
  if (!head) return '';
  const sub = toks[1];
  return sub && !sub.startsWith('-') && SUBCOMMAND_RUNNERS.has(head) ? `${head} ${sub}` : head;
}

/** 路径识别的单源: 借 `directionSignature` 认路径那一套, 这里只负责把 token 原样捞回来。 */
const NO_EXISTING_FILES: ReadonlySet<string> = new Set<string>();

/**
 * 命令里的路径形参数 (含 `::` test id), 去重保序。
 *
 * ⚠ 与 `directionSignature.files` 的差别: 那边把 `tests/b.py::t1` 拆成文件 + id 两格 (它比的是
 * 方向), 这里要的是 **token 本身** —— 并集拼回命令行时拆开的两半没法用。
 * 认不认得出路径这件事仍由 `directionSignature` 说了算, 本函数只按它认出的文件名把 token 捞回来。
 */
export function pathArgs(command: string): string[] {
  const spec: AcceptanceSpec = { kind: 'executable', command, expectExit: 0 };
  const files = new Set(directionSignature(spec, NO_EXISTING_FILES).files);
  const out: string[] = [];
  for (const token of commandTokens(command)) {
    if (token.startsWith('-')) continue;
    const head = token.split('::')[0]!;
    if (!files.has(head)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * 把其余候选的路径参数并进被择优选中的那条命令 (D-1)。
 *
 * 规则:
 *  ① 基底 = `chosen` 原样, 其余候选只贡献**路径参数**, 不贡献开关 (开关是那份候选的写法, 不是它的方向);
 *  ② runner 首词不同 ⇒ 整体不拼 —— 两条不同 runner 拼一起是一条跑不起来的命令, 加宽不能以恒红为代价;
 *  ③ 基底是裸整跑 (没有路径参数) ⇒ 不拼, 它已经是最宽的那条;
 *  ④ `blocked` 判某份被拒 ⇒ 那份不进并集并计 `dropped` (D-2), **不算 runner 冲突** (它压根没参与)。
 *
 * `chosen` 本身不过 `blocked`: 它是择优选中的那份, 上游 `normalizeClassification` 已经替它过过闸了。
 */
export function unionCriterionCommands(
  chosen: string,
  others: readonly string[],
  opts?: { blocked?: (cmd: string) => string | null },
): UnionResult {
  const base = chosen.trim();
  const basePaths = pathArgs(base);
  const keep = (why: string, dropped = 0): UnionResult => ({ command: chosen, applied: false, paths: basePaths.length, dropped, why });

  if (base === '') return { command: chosen, applied: false, paths: 0, dropped: 0, why: '基底命令为空 → 不拼' };
  // `&&` 链没有"同一条命令"的末尾: 追加上去改的是最后一环的语义, 而不是整条判据的覆盖面。
  if (base.includes('&&')) return keep('基底是 `&&` 链 (追加位置说不清) → 不拼');
  if (basePaths.length === 0) return keep('基底是裸整跑 (已最宽) → 不拼');

  const head = runnerHead(base);
  const add: string[] = [];
  let dropped = 0;
  for (const other of others) {
    const cmd = other.trim();
    // 空候选是**缺席**不是被拒 —— 不计 dropped (§静默坑 1: 两种 NULL 别压平)。
    if (cmd === '') continue;
    if (opts?.blocked?.(cmd)) {
      dropped++;
      continue;
    }
    const otherHead = runnerHead(cmd);
    if (otherHead !== head) return keep(`runner 首词不同 (${head} vs ${otherHead}) → 不拼`, dropped);
    for (const p of pathArgs(cmd)) {
      if (!basePaths.includes(p) && !add.includes(p)) add.push(p);
    }
  }
  if (add.length === 0) return keep('其余候选没带来新路径 → 命令不动', dropped);

  return {
    command: `${base} ${add.join(' ')}`,
    applied: true,
    paths: basePaths.length + add.length,
    dropped,
    why: `并集: 基底 ${basePaths.length} 条 + 新增 ${add.length} 条 (runner ${head})`,
  };
}
