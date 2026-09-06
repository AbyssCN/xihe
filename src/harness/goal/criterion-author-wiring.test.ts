/**
 * goal/criterion-author-wiring.test —— 异族先写判据的**接线面**
 * (契约 `docs/plan/2026-09-06-异族先写判据-执行契约.md` INV-3 / INV-4 / INV-6 / INV-7)。
 *
 * 纯模块 (出题 → 两道门 → 采纳/删回去) 在 `./criterion-author.test.ts`; 这里只问接线的四件事:
 *  · 采纳之后判据**从首发起**就受路径禁令保护 (`frozenAtDispatch: 0` 这条路真通);
 *  · 开关缺席时 conductor 面**逐字节同旧** (单变量臂的前提: 关着的那一侧不许有任何变化);
 *  · 判官卷面看得出「这份判据不是执行侧写的」;
 *  · 异族判据被终审否决时, INV-4 重建照走, 且留下 `rebuiltAfterCross`。
 *
 * ## 反向自检
 *  · `initFreezeState` 不从 `ledger.criterionFreeze.hashes` 恢复 ⇒ INV-3 红 (guarded 为空);
 *  · run-goal 不读 `OMD_CRITERION_AUTHOR` ⇒ INV-4 红 (关着也出现 criterionAuthor);
 *  · `renderCriterionFreezeTruth` 不收作者附注 ⇒ INV-6 红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withProtectedPaths } from '../agent-tools';
import type { ConductorPlan } from '../conductor-plan';
import type { ConductorCtx } from '../conductor/types';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { VerifierVerdict } from '../verifier';
import { renderJudgingTruths } from '../verifier';
import { authorCriterionCrossFamily, type CriterionAuthorResult } from './criterion-author';
import type { GoalClassification } from './classify-acceptance';
import { createConductorCardLedger } from './loop-ledger';
import { buildConductorFace, renderCriterionFreezeTruth } from './orchestrating-loop';
import { runGoal, type RunGoalConfig } from './run-goal';

const CRITERION = 'tests/a.test.ts';
const AUTHORED = "import { expect, test } from 'bun:test';\ntest('add', () => { expect(1).toBe(2); });\n";

// ── INV-3: frozenAtDispatch 0 —— 首发就在禁令里 ──────────────────────────────

const CTX: ConductorCtx = {
  cwd: '/tmp/x',
  writeRoot: '/tmp/x',
  acceptance: { command: `bun test ${CRITERION}`, expect_exit: 0 },
  allowlist: ['bun', 'git'],
  maxFanout: 4,
  seats: { worker: 'w:1', escalation: 'e:1', verify: 'v:1' },
  researchAvailable: false,
};

const fakeExec = (plan: ConductorPlan): ExecutorDagResult =>
  ({
    plan,
    sessionId: 's',
    levels: [Object.keys(plan.nodes)],
    results: Object.fromEntries(
      Object.keys(plan.nodes).map((id) => [id, { id, status: 'done', kind: 'agent', output: `report of ${id}`, deps: [], usage: { in: 1, out: 1 }, filesTouched: [] }]),
    ),
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 },
    reusedNodes: [],
    observations: [],
  }) as unknown as ExecutorDagResult;

describe('INV-3 接线: 异族座写的判据 frozenAtDispatch:0 ⇒ 第 1 发就被 withProtected 包住', () => {
  test('★ ledger 里已有 hashes ⇒ 首发进禁令 (不必等某一发把文件写出来)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-author-inv3-'));
    const ledger = createConductorCardLedger();
    // 异族座在**任何派发之前**就写好并冻上了 —— 这正是 0 的含义 (§静默坑 1: 0 ≠ 缺席)。
    ledger.criterionFreeze = { files: [CRITERION], frozenAtDispatch: 0, hashes: { [CRITERION]: 'deadbeefdeadbeef' } };
    const guarded: (readonly string[])[] = [];
    const face = buildConductorFace(
      { goal: 'g', writeRoot: root, acceptance: CTX.acceptance, minutesLeft: 30, tokensLeft: null, maxFanout: 4, researchAvailable: false, criterionAuthored: [CRITERION] },
      {
        ctx: { ...CTX, cwd: root, writeRoot: root },
        ledger,
        criterionFreeze: { files: [CRITERION], root },
        withProtected: ((paths, fn) => {
          guarded.push(paths ?? []);
          return fn();
        }) as typeof withProtectedPaths,
        runChild: async (p) => fakeExec(p),
      },
    );
    const work = face.customTools!.find((t) => t.name === 'work')!;
    await work.execute('t', { goal: 'implement add', brief: 'make the pinned test pass; touch only the module that owns add.' });
    // 证伪: `initFreezeState` 不从 `prior.hashes` 恢复 protectedFiles ⇒ guarded 为空, 本条红。
    expect(guarded).toEqual([[CRITERION]]);
    // 冻结块不该再跑一遍 (已经冻住了) ⇒ frozenAtDispatch 仍是 0, 不被改写成 1。
    expect(ledger.criterionFreeze.frozenAtDispatch).toBe(0);
  });
});

// ── INV-6 纯核: 判官真值带作者附注 ────────────────────────────────────────────

describe('INV-6 纯核: 判卷真值在异族作者时多一格「作者=异族座」', () => {
  const freeze = { files: [CRITERION], frozenAtDispatch: 0, hashes: { [CRITERION]: 'deadbeefdeadbeef' } };
  test('★ 给了作者 ⇒ 卷面含「作者=异族座 <model>」', () => {
    const truth = renderCriterionFreezeTruth(freeze, '/nowhere', 'bench:sol-1')!;
    expect(truth).toContain('作者=异族座 bench:sol-1');
    expect(renderJudgingTruths({ criterionFreeze: truth })).toContain('作者=异族座 bench:sol-1');
  });
  test('★ 没给作者 ⇒ 卷面不含那一格 (证伪: 无条件印 ⇒ 本条红)', () => {
    expect(renderCriterionFreezeTruth(freeze, '/nowhere')).not.toContain('作者=异族座');
  });
});

// ── run-goal 接线面 ─────────────────────────────────────────────────────────

const AUTHOR_ENV = 'OMD_CRITERION_AUTHOR';
const priorEnv = process.env[AUTHOR_ENV];
afterEach(() => {
  if (priorEnv === undefined) delete process.env[AUTHOR_ENV];
  else process.env[AUTHOR_ENV] = priorEnv;
});

function seedRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-author-wiring-'));
  writeFileSync(join(cwd, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(cwd, 'src.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['add', '-A'], { cwd });
  return cwd;
}

const leaf = (over: Record<string, unknown>): Record<string, unknown> => ({ id: 'x', status: 'done', kind: 'agent', output: '', deps: [], usage: { in: 1, out: 1 }, ...over });

/**
 * 一次编排循环 run。`_authorCriterion` 走**真模块**, 只把模型与探针换成注入件 ——
 * 接线要证的是「run-goal 把真东西接上了」, 不是「假东西返了个对象」。
 */
async function authorRun(
  cwd: string,
  over: { verdict?: VerifierVerdict; author?: RunGoalConfig['_authorCriterion']; captured?: { prompt?: string; truth?: string } } = {},
): Promise<Awaited<ReturnType<typeof runGoal>>> {
  const cap = over.captured ?? {};
  const verifier = (async (req: { truths?: { criterionFreeze?: string } }): Promise<VerifierVerdict> => {
    cap.truth = req.truths?.criterionFreeze;
    return over.verdict ?? { pass: true, reason: 'ok', usage: { in: 0, out: 0 } };
  }) as ExecutorDagConfig['verifier'];
  return runGoal('make add() handle negatives', {
    cwd,
    dag: {
      conductorModel: 'bench:MiniMax-M3',
      leafModel: 'bench:MiniMax-M3',
      verifier,
      commandRunner: (async () => ({ exitCode: 1, text: '' })) as never,
    } as ExecutorDagConfig,
    _today: () => '2026-09-06',
    _classify: (async (): Promise<GoalClassification> => ({
      tier: 'simple',
      acceptance: { kind: 'executable', command: `bun test ${CRITERION}`, expectExit: 0 },
    })) as RunGoalConfig['_classify'],
    ...(over.author ? { _authorCriterion: over.author } : {}),
    _runDag: (async (plan: ConductorPlan, dagCfg: ExecutorDagConfig): Promise<ExecutorDagResult> => {
      cap.prompt = dagCfg.leafFace?.({ id: 'conductor' } as never)?.systemPrompt;
      const results = { conductor: leaf({ id: 'conductor', artifactRoot: cwd }), accept: leaf({ id: 'accept', kind: 'command', status: 'failed', exitCode: 1 }) };
      if (dagCfg.verifier) await dagCfg.verifier({ task: '', plan, results: results as never });
      return { plan, results, reusedNodes: [] } as unknown as ExecutorDagResult;
    }) as never,
  });
}

/** 采纳路的注入件: 异族座返一份合法测试, 方向探针判 red-before。 */
const acceptingAuthor: RunGoalConfig['_authorCriterion'] = (input) =>
  authorCriterionCrossFamily({
    ...input,
    crossFamily: () => 'bench:sol-1',
    generate: async () => JSON.stringify({ files: [{ path: CRITERION, content: AUTHORED }] }),
    probeDirection: (async () => ({ status: 'red-before', why: '改动前红' })) as never,
  });

describe('INV-4 开关缺席 ⇒ 一个字节都不变 (单变量臂的前提)', () => {
  test('★ 开关缺席与 =0 两跑的 conductor 面逐字节相同, 且 criterionAuthor 缺席', async () => {
    delete process.env[AUTHOR_ENV];
    const off = { prompt: undefined as string | undefined };
    const rOff = await authorRun(seedRepo(), { author: acceptingAuthor, captured: off });
    process.env[AUTHOR_ENV] = '0';
    const zero = { prompt: undefined as string | undefined };
    const rZero = await authorRun(seedRepo(), { author: acceptingAuthor, captured: zero });
    // 证伪: run-goal 不读开关 (无条件调异族座) ⇒ 两条 criterionAuthor 断言红。
    expect(rOff.loop!.criterionAuthor).toBeUndefined();
    expect(rZero.loop!.criterionAuthor).toBeUndefined();
    // 判据文件仍是"缺的" ⇒ conductor 面上仍是今天那句 `Missing now:`。
    expect(off.prompt).toContain('Missing now:');
    expect(off.prompt).not.toContain('cross-family');
    // 两跑仓根不同 (mkdtemp), 把它抹平后**逐字节**比 —— 面上其余部分不许有任何差别。
    const norm = (s: string | undefined): string => (s ?? '').replace(/[^\s,.]*omd-author-wiring-\w+/g, '<ROOT>');
    expect(norm(off.prompt)).toBe(norm(zero.prompt));
    // 开关关着时判据文件不许被写出来 (异族座压根没被调)。
    expect(rOff.loop!.criterionFreeze?.frozenAtDispatch).toBeUndefined();
  });
});

describe('D-5 / INV-6 接线: 开关开 + 异族座采纳 ⇒ 首发前冻结 + 面文案换 + 卷面带作者', () => {
  test('★ criterionFreeze.frozenAtDispatch===0 + hashes 齐, 文件真在盘上', async () => {
    process.env[AUTHOR_ENV] = 'cross';
    const cwd = seedRepo();
    const cap: { prompt?: string; truth?: string } = {};
    const r = await authorRun(cwd, { author: acceptingAuthor, captured: cap });
    expect(r.loop!.criterionAuthor).toMatchObject({ attempted: true, accepted: true, model: 'bench:sol-1', direction: 'red-before', files: [CRITERION] });
    // 证伪: 采纳后不写 hashes ⇒ 本条红, 且 INV-3 那条保护也跟着断。
    expect(r.loop!.criterionFreeze!.frozenAtDispatch).toBe(0);
    expect(r.loop!.criterionFreeze!.hashes![CRITERION]).toMatch(/^[0-9a-f]{16}$/);
    expect(existsSync(join(cwd, CRITERION))).toBe(true);
  });

  test('★ conductor 面换成「已由异族座写出并冻结」, 不再说 Missing now', async () => {
    process.env[AUTHOR_ENV] = 'cross';
    const cap: { prompt?: string } = {};
    await authorRun(seedRepo(), { author: acceptingAuthor, captured: cap });
    expect(cap.prompt).toContain(CRITERION);
    expect(cap.prompt).toContain('cross-family');
    // 证伪: 面文案不换 ⇒ 这一条红 (conductor 会以为判据还等着它写)。
    expect(cap.prompt).not.toContain('Missing now:');
  });

  test('★ INV-6: 判官拿到的 criterionFreeze 真值含「作者=异族座 bench:sol-1」', async () => {
    process.env[AUTHOR_ENV] = 'cross';
    const cap: { truth?: string } = {};
    await authorRun(seedRepo(), { author: acceptingAuthor, captured: cap });
    expect(cap.truth).toContain('作者=异族座 bench:sol-1');
  });

  test('★ 判别力: 异族座没采纳 (方向探针 green-before) ⇒ 退回今天的路径, 面上仍是 Missing now, 卷面无作者格', async () => {
    process.env[AUTHOR_ENV] = 'cross';
    const cwd = seedRepo();
    const cap: { prompt?: string; truth?: string } = {};
    const r = await authorRun(cwd, {
      captured: cap,
      author: (input) =>
        authorCriterionCrossFamily({
          ...input,
          crossFamily: () => 'bench:sol-1',
          generate: async () => JSON.stringify({ files: [{ path: CRITERION, content: AUTHORED }] }),
          probeDirection: (async () => ({ status: 'green-before', why: '改动前就绿' })) as never,
        }),
    });
    expect(r.loop!.criterionAuthor).toMatchObject({ attempted: true, accepted: false, direction: 'green-before' });
    expect(r.loop!.criterionFreeze?.frozenAtDispatch).toBeUndefined();
    expect(existsSync(join(cwd, CRITERION))).toBe(false);
    expect(cap.prompt).toContain('Missing now:');
    expect(cap.truth ?? '').not.toContain('作者=异族座');
  });

  test('★ INV-5 接线: 没有异族座 ⇒ 记 no-cross-family-seat, 判据仍由执行侧自写', async () => {
    process.env[AUTHOR_ENV] = 'cross';
    const cap: { prompt?: string } = {};
    const r = await authorRun(seedRepo(), {
      captured: cap,
      author: (input) => authorCriterionCrossFamily({ ...input, crossFamily: () => undefined, generate: async () => '', probeDirection: (async () => ({ status: 'red-before', why: 'x' })) as never }),
    });
    expect(r.loop!.criterionAuthor).toEqual({ attempted: false, accepted: false, why: 'no-cross-family-seat' } as CriterionAuthorResult);
    expect(cap.prompt).toContain('Missing now:');
  });
});

describe('INV-7 D-7: 终审 target=criterion 否决异族判据 ⇒ INV-4 重建照走 + rebuiltAfterCross', () => {
  test('★ 重建触发, 且异族读数上留下 rebuiltAfterCross', async () => {
    process.env[AUTHOR_ENV] = 'cross';
    const r = await authorRun(seedRepo(), {
      author: acceptingAuthor,
      verdict: { pass: false, reason: '判据 grep 错了目录', target: 'criterion', usage: { in: 0, out: 0 } },
    });
    expect(r.criterionRebuild).toBeDefined();
    expect(r.criterionRebuild!.trigger).toContain('criterion');
    // 证伪: 不记 rebuiltAfterCross ⇒ 本条红 (读侧就分不出"异族出的题也被判死了"这一格)。
    expect(r.loop!.criterionAuthor!.rebuiltAfterCross).toBe(true);
  });

  test('★ 判别力: 终审通过 ⇒ 不重建, rebuiltAfterCross 缺席 (不编 false)', async () => {
    process.env[AUTHOR_ENV] = 'cross';
    const r = await authorRun(seedRepo(), { author: acceptingAuthor });
    expect(r.loop!.criterionAuthor!.rebuiltAfterCross).toBeUndefined();
  });
});
