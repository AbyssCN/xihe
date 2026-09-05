/**
 * goal/falsify-tests —— **异族座写的证伪测试** (2026-09-05, 契约
 * `docs/plan/2026-09-05-verifier写证伪测试-执行契约-草案.md` 切片 1)。
 *
 * ## 为什么
 *
 * 终审 verifier 换了家族, 但**没换证据来源**: 它判的仍是我们自己写的那条判据, 产出是一段散文。
 * 盘上读数 (契约 §0): 判据文件与 bench 隐藏测试零交集 67/68 题; 执行型 success 的 run 里
 * reward < 0.5 有 42/171。把怀疑写成**可跑的测试**、由引擎机械跑, 判词就变成退出码 ——
 * 这相当于对「隐藏测试会查什么」做第二次独立采样。
 *
 * ## 这个模块管什么
 *
 * 只管**校验计划**与**跑计划**两件确定性的事, 零 LLM (座位那一发在 `run-goal.ts`, 切片 2)。
 *  · {@link validateFalsifyPlan} —— 座位输出的结构化 JSON 过闸 (INV-1);
 *  · {@link runFalsifyTests} —— 写到 `mkdtemp` 的仓外临时目录, 在仓根 cwd 下跑, 跑完删干净 (INV-2/INV-3)。
 *
 * ## 三态不许压平 (仓规静默坑 1)
 *
 * `red` (至少一条挂) / `green` (全过) / `inconclusive` (写不出、跑不起来、超时、collection error)。
 * **「跑不起来」不是「没挂」也不是「挂了」** —— 把它并进 red 会给一轮无谓的修复轮,
 * 并进 green 会把「什么都没量到」读成「查过了没问题」。预注册要的正是 inconclusive 的占比与成因分布,
 * 所以成因原文一律进 `why`。
 *
 * ## 边界 (契约 D-8 越界红线)
 *
 * 证伪测试**永不写进仓**、永不进 write set: 文件只落在 `mkdtemp` 目录, `finally` 里删。
 * 唯一的机械保证由 INV-3 量 —— 跑前跑后仓的 `git status --porcelain` 逐字相同。
 *
 * ⚠ 契约 D-3 写的「整仓 `withProtectedPaths` 保护」**没有实装**: 那道闸是 agent 工具调用
 * (`agent-tools.ts` 的 AsyncLocalStorage) 上的**精确相对路径**禁单, 而这里跑的是一个子进程 ——
 * 子进程的写盘一次都不经过那道闸, 包一层只是摆设 (仓规: 一条永远绿的闸不是闸)。真正的
 * 保证是 INV-3 那条对账。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { logger } from '../logger';

/** 座位输出的证伪计划。`path` 是**平铺文件名** (不含目录), 落在仓外临时目录里。 */
export interface FalsifyPlan {
  tests: { path: string; content: string }[];
}

/** 跑测试的注入口 (测试用); 缺省 `Bun.spawnSync`。`timedOut` 为真时 `exitCode` 不作数。 */
export type SpawnLike = (
  argv: string[],
  opts: { cwd: string; timeoutMs: number },
) => { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean };

export interface FalsifyResult {
  status: 'red' | 'green' | 'inconclusive';
  /** 真交给 runner 的测试文件数。`0` = 一次都没 spawn (计划没过闸 / 没有能跑它的 runner) —— 「跑了 0 条」与「没跑」是两件事 (仓规静默坑 1)。 */
  ran: number;
  /** red 时**必非空**: 输出里认出的文件名; 一条都认不出就退回全量 (「挂了但说不清哪条」仍是挂了)。 */
  failing: string[];
  /** inconclusive 的成因原文 / 跑得起来时的补充说明。缺席 = 没有额外要说的。 */
  why?: string;
  /** 合并输出的尾 800 字 —— D-5 的 finding 正文靠它。空 = runner 一个字都没输出。 */
  outputTail?: string;
}

/** 契约 D-3 的路径面: `^falsify_.*\.(py|test\.ts)$`, 另拒路径分隔符与 `..`。 */
const PATH_RE = /^falsify_.*\.(py|test\.ts)$/;
const MAX_TESTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 800;

/**
 * 「跑不起来」的输出特征。命中即 inconclusive, **哪怕退出码是 1** ——
 * bun 找不到模块也退 1, 与「一条测试真的挂了」在退出码上分不开, 只能靠输出分。
 * 宁可把一条真红读成 inconclusive (丢一个信号), 也不要把跑不起来读成红 (凭空一轮修复轮)。
 */
const CANNOT_RUN_RE =
  /ERROR collecting|INTERNALERROR|no tests ran|Cannot find module|ImportError while loading conftest|usage: pytest|unrecognized arguments/i;

type RunnerKind = 'py' | 'ts';

/** runner 字符串 → 语言。认不出 ⇒ undefined (调用方判 inconclusive, 不瞎猜)。 */
export function runnerKind(runner: string): RunnerKind | undefined {
  if (/(^|[/\s])pytest(\s|$)/.test(runner)) return 'py';
  if (/(^|[/\s])bun\s+test(\s|$)/.test(runner)) return 'ts';
  return undefined;
}

function pathKind(path: string): RunnerKind | undefined {
  if (path.endsWith('.test.ts')) return 'ts';
  if (path.endsWith('.py')) return 'py';
  return undefined;
}

/**
 * 从 `probeEnvFacts(...).testCommandCandidates` 里挑一条**跑得了这份计划**的 runner。
 *
 * 全部测试文件必须是同一种语言且与 runner 匹配 —— 混类型时返回 undefined 而不是只跑一半:
 * 「只跑了一半」的绿与「全跑了」的绿在读数上长得一样, 而它们不是一回事。
 */
export function pickRunner(candidates: readonly string[], plan: FalsifyPlan): string | undefined {
  return candidates.find((c) => {
    const k = runnerKind(c);
    return k !== undefined && plan.tests.every((t) => pathKind(t.path) === k);
  });
}

/**
 * INV-1: 校验座位输出。**拒绝**路径不匹配 `^falsify_` 的 / 含 `..` 的 / 超过 3 条的,
 * 另拒空计划、空正文、重名 (后写的会盖掉前一条 = 静默少跑一条测试)。
 *
 * 判词点名那条路径 —— 调用方要把它原样记进 ledger 的 `why`, 「写不出」的成因分布靠它。
 *
 * falsify (本函数必须能真红): 把 {@link PATH_RE} 放宽成 `/./` ⇒ `falsify-tests.test.ts`
 * INV-1 那四条拒收当场变通过。
 */
export function validateFalsifyPlan(raw: unknown): FalsifyPlan | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: `证伪计划不是对象 (拿到 ${typeof raw})` };
  const tests = (raw as { tests?: unknown }).tests;
  if (!Array.isArray(tests)) return { error: '证伪计划缺 `tests` 数组' };
  if (tests.length === 0) return { error: '证伪计划为空: 一条测试都没写出来' };
  if (tests.length > MAX_TESTS) return { error: `证伪测试 ${tests.length} 条, 超过上限 ${MAX_TESTS} 条` };
  const out: FalsifyPlan['tests'] = [];
  const seen = new Set<string>();
  for (const t of tests) {
    if (typeof t !== 'object' || t === null) return { error: `证伪测试条目不是对象 (拿到 ${typeof t})` };
    const { path, content } = t as { path?: unknown; content?: unknown };
    if (typeof path !== 'string' || path === '') return { error: '证伪测试条目缺 `path` 字符串' };
    if (typeof content !== 'string' || content.trim() === '') return { error: `证伪测试 ${path} 的 \`content\` 为空` };
    if (path.includes('/') || path.includes('\\')) return { error: `证伪测试路径含分隔符: ${path} (只收平铺文件名)` };
    if (path.includes('..')) return { error: `证伪测试路径含 \`..\`: ${path}` };
    if (!PATH_RE.test(path)) return { error: `证伪测试路径不合形: ${path} (要 falsify_*.py 或 falsify_*.test.ts)` };
    if (seen.has(path)) return { error: `证伪测试路径重名: ${path}` };
    seen.add(path);
    out.push({ path, content });
  }
  return { tests: out };
}

/** 缺省 IO: 一次 spawnSync, 超时由 Bun 杀进程 (那时 `exitCode` 为 null / 带 signal)。 */
function defaultRun(argv: string[], opts: { cwd: string; timeoutMs: number }): ReturnType<SpawnLike> {
  const r = Bun.spawnSync(argv, { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe', timeout: opts.timeoutMs });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    timedOut: r.signalCode === 'SIGTERM' || r.signalCode === 'SIGKILL',
  };
}

/**
 * INV-2 / INV-3: 把计划写进 `mkdtemp` 的**仓外**临时目录, 在 `repoRoot` 下跑一次, 跑完删干净。
 *
 * 三态见 {@link FalsifyResult}。`red` 的 `failing` 从输出里认文件名, 一条都认不出 ⇒ 退回全量
 * (契约 INV-2 要求 red 时 `failing` 非空: 「挂了但说不清哪条」仍然是挂了)。
 *
 * pytest 的 `--rootdir=<repo>` 与 `-p no:cacheprovider` 首版就带上 (契约 §未决):
 * cwd 在仓根而文件在临时目录, rootdir 推断会失配; cacheprovider 会往仓里写 `.pytest_cache` ——
 * 后者正是 INV-3 会红的那一条。
 *
 * falsify (本函数必须能真红): 删掉 `finally` 的 `rmSync` ⇒ 「临时目录跑完被删」红;
 * 把写文件的目标从 `tmp` 改成 `repoRoot` ⇒ INV-3 那条 porcelain 对账红。
 */
export function runFalsifyTests(
  plan: FalsifyPlan,
  repoRoot: string,
  runner: string,
  opts?: { run?: SpawnLike; timeoutMs?: number },
): FalsifyResult {
  const kind = runnerKind(runner);
  if (kind === undefined) {
    return { status: 'inconclusive', ran: 0, failing: [], why: `跑不起来: 认不出 runner \`${runner}\` (只认 pytest / bun test)` };
  }
  const mismatched = plan.tests.filter((t) => pathKind(t.path) !== kind);
  if (mismatched.length > 0) {
    return {
      status: 'inconclusive',
      ran: 0,
      failing: [],
      why: `跑不起来: runner \`${runner}\` 与测试文件类型不匹配 (${mismatched.map((t) => t.path).join(', ')})`,
    };
  }

  const run = opts?.run ?? defaultRun;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tmp = mkdtempSync(join(tmpdir(), 'omd-falsify-'));
  try {
    const files = plan.tests.map((t) => {
      const abs = join(tmp, t.path);
      writeFileSync(abs, t.content, 'utf8');
      return abs;
    });
    const argv = [
      ...runner.trim().split(/\s+/),
      ...(kind === 'py' ? [`--rootdir=${repoRoot}`, '-p', 'no:cacheprovider'] : []),
      ...files,
    ];
    let r: ReturnType<SpawnLike>;
    try {
      r = run(argv, { cwd: repoRoot, timeoutMs });
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据 (仓规静默坑 2): 原文既进 why 也进日志。
      const why = `跑不起来: runner 抛错 ${String(err).slice(0, 240)}`;
      logger.warn({ argv, cwd: repoRoot, err: String(err) }, '[falsify] 证伪测试 runner 抛错 → inconclusive');
      return { status: 'inconclusive', ran: 0, failing: [], why };
    }
    const output = `${r.stdout}${r.stderr}`;
    const outputTail = output.length > OUTPUT_TAIL_CHARS ? output.slice(-OUTPUT_TAIL_CHARS) : output;
    const base = { ran: files.length, failing: [] as string[], ...(outputTail ? { outputTail } : {}) };
    if (r.timedOut) {
      return { status: 'inconclusive', ...base, why: `跑不起来: 超时 (${timeoutMs} ms 未跑完, 进程已被杀)` };
    }
    if (r.exitCode === null) {
      return { status: 'inconclusive', ...base, why: '跑不起来: runner 没有退出码 (被信号打断)' };
    }
    if (r.exitCode === 0) return { status: 'green', ...base };
    if (r.exitCode !== 1) {
      return { status: 'inconclusive', ...base, why: `跑不起来: runner 退出码 ${r.exitCode} (不是「有测试挂了」那一格)` };
    }
    if (CANNOT_RUN_RE.test(output)) {
      return { status: 'inconclusive', ...base, why: `跑不起来: 输出是 collection / import 错, 不是测试判红 — ${outputTail.slice(-200)}` };
    }
    const named = plan.tests.map((t) => t.path).filter((p) => output.includes(p));
    return { status: 'red', ran: files.length, failing: named.length > 0 ? named : plan.tests.map((t) => t.path), ...(outputTail ? { outputTail } : {}) };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch (err) {
      // 删不掉只丢一个临时目录, 不掀桌 —— 但要留下是哪一个 (仓规静默坑 2)。
      logger.warn({ tmp, err: String(err) }, '[falsify] 证伪测试临时目录删不掉 (仓未受影响, 只是 /tmp 里留了一份)');
    }
  }
}

/** 座位输出的结构化面 (与 `verifier.ts` 的 `VERIFIER_VERDICT_SCHEMA` 同款: 宽收, 硬闸在 validate)。 */
export const FALSIFY_PLAN_SCHEMA = z.object({
  tests: z.array(z.object({ path: z.coerce.string(), content: z.coerce.string() })),
});

/**
 * 座位的卷面 (D-2): 原指令 + 勘察段 + 盘上 diff。
 *
 * **不给**我们自己的判据命令与判据文件 —— 给了就等于让第二次采样复用第一次的盲点,
 * 而这一整条设计要买的正是「独立的第二次采样」。
 */
export function buildFalsifyPrompt(input: { task: string; survey?: string; diff?: string }): string {
  return [
    '你是一个**怀疑者**。下面是一条开发任务, 以及一个执行体刚刚在仓库里做出的改动。',
    '你的职责不是盖章放行, 而是**写测试把这份改动打红**: 找出它自称做到、实际没做到的地方。',
    '',
    '## 原指令',
    input.task,
    ...(input.survey ? ['', '## 仓内契约线索 (引擎机械勘察)', input.survey] : []),
    ...(input.diff ? ['', '## 盘上改动 (引擎自己跑 git 取的, 不是执行体自述)', input.diff] : []),
    '',
    '## 你要产出什么',
    `- 最多 ${MAX_TESTS} 条测试文件, 输出 JSON: \`{"tests":[{"path":"...","content":"..."}]}\`。`,
    '- `path` 只能是**平铺文件名**, 形如 `falsify_<描述>.py` 或 `falsify_<描述>.test.ts`; 不含目录, 不含 `..`。',
    '- 文件会被写到仓库**外面**的临时目录, 但以**仓根**为工作目录运行 —— 所以 import / 读文件请用相对仓根的路径。',
    '- `content` 是完整可跑的测试正文, 不要伪代码、不要 TODO、不要 `pytest.skip`。',
    '- 只测**指令真正要求的行为**。测不到的地方就少写一条, 别为了凑数写一条恒过的测试 —— 恒过的测试对这道闸是负价值。',
    '- 一条都写不出来时输出 `{"tests":[]}`, 不要编。',
  ].join('\n');
}

/**
 * D-5 的 finding 正文: 挂掉的测试**全文** + runner 输出尾。
 *
 * 为什么给全文而不是只给文件名: 这些文件不在仓里 (也不该在), conductor 打开不了它们 ——
 * 只报个名字等于让它对着一个看不见的判据去改。
 *
 * 明写「改实装不是改测试」: 证伪测试落在仓外临时目录, 本来就改不到; 说清楚是为了让
 * conductor 不去浪费一轮找那个文件。
 */
export function renderFalsifyFinding(plan: FalsifyPlan, result: FalsifyResult, runner: string): string {
  const bodies = result.failing.map((p) => {
    const t = plan.tests.find((x) => x.path === p);
    return `#### ${p}\n\`\`\`\n${t ? t.content : '(正文找不回来了 — 计划里没有这条路径)'}\n\`\`\``;
  });
  return [
    '## 证伪测试判红 (异族座写的, 它没看过我们的判据)',
    '下面这些测试由一个独立座位只读**原指令 + 盘上改动**写成, 在仓根跑, 挂了。',
    '它们量的是指令要求的行为, 不是我们自己那条验收命令 —— 所以「我们的判据是绿的」不构成反驳。',
    '把它们跑绿: **改实装**。这些文件在仓外的临时目录里, 你改不到它们, 也不必去找。',
    '',
    ...bodies,
    '',
    `#### runner 输出尾 (\`${runner}\`)`,
    '```',
    result.outputTail ?? '(runner 一个字都没输出)',
    '```',
  ].join('\n');
}
