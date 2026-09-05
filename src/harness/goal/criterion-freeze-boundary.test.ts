/**
 * src/harness/goal/criterion-freeze-boundary.test —— 1-A 只剩边界那一半
 * (契约 `docs/plan/2026-09-05-判据冻结只留边界-执行契约.md` INV-1 / INV-2 / INV-3)。
 *
 * ## 为什么砍掉两半
 *
 * 单变量对照 (同座位 deepseek/deepseek/opus, 同题集 80 题, 同并发): `code80-dsc` (1-A 开) reward
 * 0.6592 vs `code80-nofreeze` (1-A 关) 0.7189 —— 差 0.060, 1.7σ (sd 0.0346)。`5458fd4a` 的 1-A
 * 做了三件事, 前两件**规定怎么做**, 与 `.claude/CLAUDE.md` §引擎理念 ② 相悖:
 *   ① 冻住前非单节点 `work()` 一律拒 (计 `rejectedCompile`) —— 去掉;
 *   ② 第一发 `write_set` 强制成判据文件 —— 去掉;
 *   ③ 冻住后判据文件不许改 (`withProtectedPaths`, hash 进 ledger, 判卷重算) —— **保留**, 它钉的是
 *      边界 (防执行体改判据让自己过), 不是做法。
 *
 * conductor 可以先勘察再动手; 判据文件一旦写出即冻结, 之后谁都不许改。
 *
 * ## 反向自检 (每条的证伪方式写在各 test 注释里)
 *  · 把 D-1 的拒绝块加回去 ⇒ INV-1 红;
 *  · 冻结块只在第 1 发查 (旧行为) ⇒ INV-2 红 (`frozenAtDispatch` 缺席);
 *  · 去掉写集强制的移除 (即把强制加回来) ⇒ INV-1 / INV-3 的 `write_set` 断言红。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withProtectedPaths } from '../agent-tools';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagResult } from '../dag/types';
import type { ConductorCtx } from '../conductor/types';
import { createConductorCardLedger } from './loop-ledger';
import { buildConductorFace } from './orchestrating-loop';

const CRITERION = 'tests/a.test.ts';

const CTX: ConductorCtx = {
  cwd: '/tmp/x',
  writeRoot: '/tmp/x',
  acceptance: { command: `bun test ${CRITERION}`, expect_exit: 0 },
  allowlist: ['bun', 'git'],
  maxFanout: 4,
  seats: { worker: 'w:1', escalation: 'e:1', verify: 'v:1' },
  researchAvailable: false,
};

const FACTS = {
  goal: 'fix the thing',
  writeRoot: '/tmp/x',
  acceptance: CTX.acceptance,
  minutesLeft: 30,
  tokensLeft: null,
  maxFanout: 4,
  researchAvailable: false,
};

/** 一个"已收敛"的假子 run 结果 (agent 节点 done + 报告)。 */
const fakeExec = (plan: ConductorPlan): ExecutorDagResult =>
  ({
    plan,
    sessionId: 's',
    levels: [Object.keys(plan.nodes)],
    results: Object.fromEntries(
      Object.keys(plan.nodes).map((id) => [
        id,
        { id, status: 'done', kind: 'agent', output: `report of ${id}`, deps: [], usage: { in: 1, out: 1 }, filesTouched: ['src/a.ts'] },
      ]),
    ),
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 },
    reusedNodes: [],
    observations: [],
  }) as unknown as ExecutorDagResult;

/**
 * 一副装好 1-A 的 conductor 面 + 三个观测口。
 * `writeCriterion()` 让调用方自己决定判据文件在**哪一发之后**才出现 —— 冻结点是本组的被测量。
 */
function makeFace(root: string) {
  const ledger = createConductorCardLedger();
  const plans: ConductorPlan[] = [];
  const guarded: (readonly string[])[] = [];
  let writeNext = false;
  const ctx = { ...CTX, cwd: root, writeRoot: root, acceptance: { command: `bun test ${CRITERION}`, expect_exit: 0 } };
  const face = buildConductorFace(
    { ...FACTS, writeRoot: root, criterionFiles: [CRITERION] },
    {
      ctx,
      ledger,
      criterionFreeze: { files: [CRITERION], root },
      withProtected: ((paths, fn) => {
        guarded.push(paths ?? []);
        return fn();
      }) as typeof withProtectedPaths,
      runChild: async (p) => {
        plans.push(p);
        if (writeNext && !existsSync(join(root, CRITERION))) {
          mkdirSync(join(root, 'tests'), { recursive: true });
          writeFileSync(join(root, CRITERION), 'expect(1).toBe(1)');
        }
        return fakeExec(p);
      },
    },
  );
  const tool = (name: string) => face.customTools!.find((t) => t.name === name)!;
  return { ledger, plans, guarded, tool, writeCriterionOnNextDispatch: () => { writeNext = true; } };
}

/** 派发回执的正文 (卡的 tool result 第一段文本)。 */
const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text;

describe('1-A 只剩边界 (2026-09-05): 冻住前不规定做法, 冻住后不许改', () => {
  test('★ INV-1: 冻住前派两节点 spawn → 接受; rejectedCompile 0; 子 run 的 write_set 与 conductor 所派逐字相同', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-1a-bnd-inv1-'));
    const { ledger, plans, tool } = makeFace(root);
    // 契约 INV-1 原文写的是「派 work() 两节点」, 而 work 卡按定义只编译出一个节点 (tools/work.ts);
    // 取它的可实现读法 —— 旧闸 `card.name !== 'work' || ids.length !== 1` 的**两个**拒因各测一次:
    // 这里是多节点 (spawn × 2), 下面一条是非 work 卡 (explore)。
    const r = await tool('spawn').execute('t', {
      tasks: [
        { goal: 'write the acceptance test', brief: 'create the test that pins add(); touch nothing else.', write_set: ['tests/a.test.ts'] },
        { goal: 'survey the module layout', brief: 'read the module and report where add lives.', write_set: ['docs/notes.md'] },
      ],
    });
    // 证伪: 把 D-1 的拒绝块加回去 → details.ok===false 且 rejectedCompile===1, 下面三条全红。
    expect((r as { details: { ok: boolean } }).details.ok).toBe(true);
    expect(ledger.rejectedCompile).toBe(0);
    expect(plans).toHaveLength(1);
    const writeSets = Object.values(plans[0]!.nodes).map((n) => n.write_set);
    // 证伪: 把 ② 的写集强制加回去 → 两个写集都被改成 ['tests/a.test.ts'], 本条红。
    expect(writeSets).toEqual([['tests/a.test.ts'], ['docs/notes.md']]);
  });

  test('★ INV-1 另一半: 冻住前派 explore (非 work 卡) → 接受, 不计 rejectedCompile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-1a-bnd-inv1b-'));
    const { ledger, plans, tool } = makeFace(root);
    const r = await tool('explore').execute('t', { questions: ['where does add live?'] });
    // 证伪: 把 D-1 的拒绝块加回去 → 回执含 '[1-A 判据先落盘]' 且 plans 为空, 本条红。
    expect((r as { details: { ok: boolean } }).details.ok).toBe(true);
    expect(ledger.rejectedCompile).toBe(0);
    expect(plans).toHaveLength(1);
  });

  test('★ INV-2: 判据文件第 2 发才出现 → frozenAtDispatch===2 + hash 非 null; 第 3 发被 withProtected 包住', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-1a-bnd-inv2-'));
    const { ledger, guarded, tool, writeCriterionOnNextDispatch } = makeFace(root);
    // 第 1 发: 先勘察 —— 判据文件还没写出来, 不冻。
    const d1 = await tool('explore').execute('t', { questions: ['where does add live?'] });
    expect(textOf(d1)).toContain('仍未写出');
    expect(ledger.criterionFreeze).toEqual({ files: [CRITERION] });
    // 第 2 发: worker 真把判据文件写出来 → 这一发回来冻住。
    writeCriterionOnNextDispatch();
    const d2 = await tool('work').execute('t', { goal: 'write the acceptance test', brief: 'create the test that pins add(); do not touch anything else.' });
    // 证伪: 冻结块只在第 1 发查 (旧行为) → frozenAtDispatch 缺席, 本条与下一条红。
    expect(ledger.criterionFreeze!.frozenAtDispatch).toBe(2);
    expect(ledger.criterionFreeze!.hashes![CRITERION]).toMatch(/^[0-9a-f]{16}$/);
    expect(textOf(d2)).toContain('[1-A 判据文件已冻结');
    expect(guarded).toHaveLength(0); // 冻住的那一发自己不在禁令里跑 (它就是来写判据的)
    // 第 3 发: 冻住之后, 子 run 在路径禁令里跑。
    await tool('work').execute('t', { goal: 'implement add', brief: 'make the pinned test pass; scope the module that owns add only.' });
    // 证伪: 不包 withProtected → [], 本条红。
    expect(guarded).toEqual([[CRITERION]]);
  });

  test('★ INV-3: 判据文件始终不写出 → frozenAtDispatch / hashes 缺席, 每发都说"仍未写出", 派发照样不被拒', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-1a-bnd-inv3-'));
    const { ledger, plans, guarded, tool } = makeFace(root);
    const d1 = await tool('explore').execute('t', { questions: ['where does add live?'] });
    const d2 = await tool('work').execute('t', { goal: 'implement add', brief: 'make the change in the module that owns add; leave the tests alone.', write_set: ['src/x.ts'] });
    for (const d of [d1, d2]) {
      expect(textOf(d)).toContain('仍未写出');
      expect((d as { details: { ok: boolean } }).details.ok).toBe(true);
    }
    // 没冻住 = frozenAtDispatch / hashes 缺席 (仓规坑 ①: 不编 0 也不编空表)。
    expect(ledger.criterionFreeze).toEqual({ files: [CRITERION] });
    expect(ledger.rejectedCompile).toBe(0);
    expect(guarded).toHaveLength(0);
    // 证伪: 把 ② 的写集强制加回去 → 第 2 发的写集被改成 ['tests/a.test.ts'], 本条红。
    expect(Object.values(plans[1]!.nodes)[0]!.write_set).toEqual(['src/x.ts']);
  });
});
