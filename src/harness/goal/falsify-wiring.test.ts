/**
 * src/harness/goal/falsify-wiring.test —— 切片 2 的契约测试
 * (契约 `docs/plan/2026-09-05-verifier写证伪测试-执行契约-草案.md` D-1 / D-5 / D-6 / D-7, INV-4)。
 *
 * 钉四件事:
 *  · **INV-4 开关关着 = 不存在** —— 座位一次不调、runner 一次不跑、ledger 无 `falsify`,
 *    而且终审收到的卷面与「连钩子都没配」那一跑**逐字节相同** (JSON.stringify 对比);
 *  · **D-5 红 ⇒ 回灌一轮, 不直接判死** —— `_runDag` 跑两次, 第二跑的 conductor goal 里带着
 *    挂掉的测试全文; 回灌后转绿 ⇒ 终态照旧 success;
 *  · **D-5 仍红 ⇒ verifier-rejected** —— 只有第二次也红才判死;
 *  · **D-6 三态进账** —— `green` / `inconclusive` 各自记, 且都不改终态 (NULL ≠ 0)。
 *
 * **反向自检** (这些测试必须能真红):
 *  · 把 `OMD_VERIFIER_FALSIFY` 的判据改成恒真 ⇒ INV-4 那两条红;
 *  · 把 D-14 回灌的触发条件里的证伪那一支去掉 ⇒ 「红 ⇒ 回灌」红;
 *  · 把 `afterReinject === 'red'` 从 `verifierRejected` 里去掉 ⇒ 「仍红 ⇒ verifier-rejected」红;
 *  · 把 `inconclusive` 并进 `red` ⇒ 「不合形计划不回灌」红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal } from './run-goal';
import type { GoalClassification } from './classify-acceptance';
import type { SpawnLike } from './falsify-tests';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { ModelResponse } from '../../model/gateway';
import type { send } from '../../model/gateway';

const SWITCH = 'OMD_VERIFIER_FALSIFY';

afterEach(() => {
  delete process.env[SWITCH];
});

const executeDag = (): ExecutorDagResult =>
  ({
    plan: { name: 'goal-orchestrating-loop', nodes: {} },
    results: {
      accept: { id: 'accept', status: 'done', kind: 'command', output: '', deps: ['conductor'], usage: { in: 0, out: 0 }, timedOut: false, signal: null },
      conductor: { id: 'conductor', status: 'done', kind: 'agent', output: 'ok', deps: [], usage: { in: 1, out: 1 } },
    },
    reusedNodes: [],
  }) as unknown as ExecutorDagResult;

/** 真仓 (不 mock fs)。有 `.test.ts` + bun 在 PATH ⇒ `probeEnvFacts` 探得出 `bun test` 候选。 */
function tsRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-falsify-wiring-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const f = (): number => 1;\n');
  writeFileSync(join(dir, 'src', 'main.test.ts'), 'import { expect, test } from "bun:test";\ntest("t", () => expect(1).toBe(1));\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  // 留一个未跟踪文件: 否则 D-1 零写入闸会把「收敛判定成立而盘上一个字节没动」判成没收敛,
  // 那一格与本文件要测的东西无关, 但会把每条断言 outcome 的用例都染红。
  writeFileSync(join(dir, 'src', 'done.ts'), 'export const g = (): number => 2;\n');
  return dir;
}

/** 一个连一行源码都没有的仓: `testCommandCandidates` 为空 ⇒ 证伪那一步压根没得跑。 */
function bareRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-falsify-bare-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# nothing\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

const classify = async (): Promise<GoalClassification> => ({
  tier: 'simple',
  acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
  route: { kind: 'none' },
});

const FALSIFY_BODY = 'import { expect, test } from "bun:test";\ntest("真要求", () => expect(1).toBe(2));\n';

/** 座位桩: 回一份合法计划 (一条 .test.ts)。 */
function seatStub(parsed: unknown): { seat: typeof send; calls: string[] } {
  const calls: string[] = [];
  const seat = (async (req) => {
    calls.push(String(req.messages[0]?.content ?? ''));
    return { text: JSON.stringify(parsed), parsed, usage: { in: 1, out: 1 } } as unknown as ModelResponse;
  }) as typeof send;
  return { seat, calls };
}

const OK_PLAN = { tests: [{ path: 'falsify_a.test.ts', content: FALSIFY_BODY }] };

/** runner 桩: 按调用序号依次给退出码 (第 1 次 = 首跑, 第 2 次 = 回灌后重跑)。 */
function runStub(exitCodes: number[]): { run: SpawnLike; calls: string[][] } {
  const calls: string[][] = [];
  const run: SpawnLike = (argv) => {
    calls.push(argv);
    const code = exitCodes[calls.length - 1] ?? 0;
    return { exitCode: code, stdout: code === 0 ? '1 pass\n' : '(fail) falsify_a.test.ts > 真要求\n1 fail\n', stderr: '' };
  };
  return { run, calls };
}

/** 走一趟循环路径的 runGoal; 终审在 `_runDag` 里由假引擎手动调一次 (真引擎也是这么调的)。 */
async function goRun(opts: {
  cwd: string;
  seat?: typeof send;
  run?: SpawnLike;
  verifierPass?: boolean;
  onVerifierReq?: (req: unknown) => void;
  plans?: ConductorPlan[];
}): Promise<Awaited<ReturnType<typeof runGoal>>> {
  return runGoal('把 f 改成返回 2', {
    cwd: opts.cwd,
    dag: {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      verifier: async (req: { task: string; plan: ConductorPlan; results: unknown }) => {
        opts.onVerifierReq?.(req);
        return { pass: opts.verifierPass ?? true, reason: 'ok', target: 'implementation' as const };
      },
    } as unknown as ExecutorDagConfig,
    _classify: classify,
    ...(opts.seat ? { _falsifySeat: opts.seat } : {}),
    ...(opts.run ? { _falsifyRun: opts.run } : {}),
    _runDag: async (plan: ConductorPlan, cfg: ExecutorDagConfig) => {
      opts.plans?.push(plan);
      await cfg.verifier?.({ task: 't', plan, results: executeDag().results } as never);
      return executeDag();
    },
  });
}

describe('INV-4 —— 开关关着, 这整条路等于不存在', () => {
  test('★ 开关缺席 ⇒ 座位不调 · runner 不跑 · ledger 无 falsify', async () => {
    const { seat, calls } = seatStub(OK_PLAN);
    const { run, calls: runCalls } = runStub([1]);
    const r = await goRun({ cwd: tsRepo(), seat, run });
    expect(calls).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
    expect(r.loop?.falsify).toBeUndefined();
    expect(r.outcome).toBe('success');
  });

  test('★ 终审卷面逐字节不变 —— 三臂 (没钩子 / 有钩子开关关 / 开关开) 完全相同', async () => {
    const cwd = tsRepo();
    const capture = async (opts: { on?: boolean; hooks?: boolean }): Promise<string[]> => {
      const seen: string[] = [];
      if (opts.on) process.env[SWITCH] = '1';
      else delete process.env[SWITCH];
      const { seat } = seatStub(OK_PLAN);
      const { run } = runStub([1, 0]);
      await goRun({ cwd, ...(opts.hooks ? { seat, run } : {}), onVerifierReq: (req) => seen.push(JSON.stringify(req)) });
      return seen;
    };
    const bare = await capture({});
    expect(bare).toHaveLength(1);
    expect(await capture({ hooks: true })).toEqual(bare);
    // 第三臂是这条断言的**判别力**来源: 证伪那一步一旦往终审卷面里塞任何东西 (哪怕只是一行
    // "证伪测试跑过了"), 这一行当场红。只比前两臂的话它恒绿 —— 恒绿的闸不是闸。
    expect(await capture({ hooks: true, on: true })).toEqual(bare);
  });
});

describe('D-5 —— 红回灌一轮, 不直接判死', () => {
  test('★ 证伪判红 ⇒ 回灌 1 次, 第二跑 conductor goal 带挂掉的测试全文', async () => {
    process.env[SWITCH] = '1';
    const plans: ConductorPlan[] = [];
    const { seat, calls } = seatStub(OK_PLAN);
    const { run, calls: runCalls } = runStub([1, 0]);
    const r = await goRun({ cwd: tsRepo(), seat, run, plans });

    expect(calls).toHaveLength(1); // 座位恰一次 (回灌后重跑的是同一组测试, 不重写)
    expect(runCalls).toHaveLength(2); // 首跑 + 回灌后重跑
    expect(plans).toHaveLength(2);
    const goal2 = String((plans[1]!.nodes as Record<string, { goal?: string }>).conductor?.goal ?? '');
    expect(goal2).toContain('falsify_a.test.ts');
    expect(goal2).toContain(FALSIFY_BODY.trim().split('\n')[1]!); // 测试正文进了 finding

    expect(r.loop?.falsify?.status).toBe('red');
    expect(r.loop?.falsify?.written).toBe(1);
    expect(r.loop?.falsify?.ran).toBe(1);
    expect(r.loop?.falsify?.failing).toEqual(['falsify_a.test.ts']);
    expect(r.loop?.falsify?.reinjected).toBe(true);
    expect(r.loop?.falsify?.afterReinject).toBe('green');
    // 回灌后转绿 ⇒ 不判死 (D-5 「不直接判死」的那一半)。
    expect(r.outcome).toBe('success');
  });

  test('★ 回灌后仍红 ⇒ 终态 verifier-rejected', async () => {
    process.env[SWITCH] = '1';
    const { seat } = seatStub(OK_PLAN);
    const { run, calls } = runStub([1, 1]);
    const r = await goRun({ cwd: tsRepo(), seat, run });
    expect(calls).toHaveLength(2);
    expect(r.loop?.falsify?.afterReinject).toBe('red');
    expect(r.outcome).toBe('verifier-rejected');
  });
});

describe('D-6 —— green / inconclusive 各自记, 都不改终态', () => {
  test('★ 全过 ⇒ green, 零回灌, 终态 success', async () => {
    process.env[SWITCH] = '1';
    const plans: ConductorPlan[] = [];
    const { seat } = seatStub(OK_PLAN);
    const { run, calls } = runStub([0]);
    const r = await goRun({ cwd: tsRepo(), seat, run, plans });
    expect(calls).toHaveLength(1);
    expect(plans).toHaveLength(1);
    expect(r.loop?.falsify?.status).toBe('green');
    expect(r.loop?.falsify?.reinjected).toBe(false);
    expect(r.loop?.falsify?.afterReinject).toBeUndefined();
    expect(r.outcome).toBe('success');
  });

  test('★ 座位写出不合形的计划 ⇒ inconclusive (不是 red), 判词原文进 why, 零回灌', async () => {
    process.env[SWITCH] = '1';
    const plans: ConductorPlan[] = [];
    const { seat } = seatStub({ tests: [{ path: '../etc/passwd', content: 'x' }] });
    const { run, calls } = runStub([1]);
    const r = await goRun({ cwd: tsRepo(), seat, run, plans });
    expect(calls).toHaveLength(0); // 没过闸就不跑
    expect(plans).toHaveLength(1);
    expect(r.loop?.falsify?.status).toBe('inconclusive');
    expect(r.loop?.falsify?.written).toBe(0);
    expect(r.loop?.falsify?.ran).toBe(0);
    expect(r.loop?.falsify?.why ?? '').toContain('passwd');
    expect(r.outcome).toBe('success');
  });

  test('★ 座位一条都写不出 (`{"tests":[]}`) ⇒ inconclusive, 零回灌', async () => {
    process.env[SWITCH] = '1';
    const { seat } = seatStub({ tests: [] });
    const { run, calls } = runStub([1]);
    const r = await goRun({ cwd: tsRepo(), seat, run });
    expect(calls).toHaveLength(0);
    expect(r.loop?.falsify?.status).toBe('inconclusive');
    expect(r.outcome).toBe('success');
  });

  test('★ 仓探不出任何验收命令候选 ⇒ inconclusive, 座位都不调 (D-1 「有可跑 runner 才跑」)', async () => {
    process.env[SWITCH] = '1';
    const { seat, calls } = seatStub(OK_PLAN);
    const { run } = runStub([1]);
    const r = await goRun({ cwd: bareRepo(), seat, run });
    expect(calls).toHaveLength(0);
    expect(r.loop?.falsify?.status).toBe('inconclusive');
    expect(r.loop?.falsify?.why ?? '').toContain('候选');
  });

  test('★ 座位抛错 ⇒ inconclusive, 错误原文进 why (fail-open 不吞证据), 终态不变', async () => {
    process.env[SWITCH] = '1';
    const seat = (async () => {
      throw new Error('座位 429');
    }) as typeof send;
    const { run, calls } = runStub([1]);
    const r = await goRun({ cwd: tsRepo(), seat, run });
    expect(calls).toHaveLength(0);
    expect(r.loop?.falsify?.status).toBe('inconclusive');
    expect(r.loop?.falsify?.why ?? '').toContain('座位 429');
    expect(r.outcome).toBe('success');
  });
});
