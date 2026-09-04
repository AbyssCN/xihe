/**
 * conductor 派发面的 #241 坐标机械校验 —— **三个坐标缺口里的最后一个** (2026-09-04)。
 *
 * ## 补的是哪个漏
 *
 * `checkCoords` 改前的生产端只有 `goal.ts` 一处 (`solve` 的 goal 文本 + SDD 全文)。
 * 同一天先补了 `run` 的 `task` (#241 实账 `0f67293b` 本身就发生在那条路上), 剩下这一处:
 * **conductor 自己画的图**。它的 `plan.nodes[*].goal` 就是派给 leaf 的派工文本, 与前两处同性质,
 * 而 conductor 只有 read/ls/grep, 编造坐标的机会不比人少。
 *
 * ## 这一处与前两处的差别: 拒因回给模型, 不回给人
 *
 * 前两处拒在点火期, 那时只有人能改, 所以要留 `force` / `gate-allow` 出口。**这一处不同** ——
 * 拒因走 tool result 回给 conductor, 它当场改坐标再派一次。所以这里不需要 force,
 * 也**不该**有: 「拒了不许重试, 换一条合法的」正是本仓对执行体的纪律。
 *
 * 反向自检: 把 `orchestrating-loop.ts` 里那个 `#241 坐标机械校验` 块删掉 →
 * 「编造坐标 → 拒」与「零派发」两组断言当场由绿转红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagResult } from '../dag/types';
import type { ConductorCtx } from '../conductor/types';
import { createConductorCardLedger } from './loop-ledger';
import { buildConductorFace } from './orchestrating-loop';

/** 真临时仓 —— 坐标闸要读真盘, 替身读不出「文件不存在」这条判据。 */
function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-loop-coord-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/real.ts'), 'export const saveReasonFull = 1;\n');
  return root;
}

const fakeExec = (plan: ConductorPlan): ExecutorDagResult =>
  ({
    plan,
    sessionId: 's',
    levels: [Object.keys(plan.nodes)],
    results: Object.fromEntries(Object.keys(plan.nodes).map((id) => [id, { status: 'done', text: 'ok' }])),
  }) as unknown as ExecutorDagResult;

/** 装一个 conductor 面 + 收集它真派出去的图。 */
function face(root: string) {
  const ctx: ConductorCtx = {
    cwd: root,
    writeRoot: root,
    acceptance: { command: 'bun test src/real.test.ts', expect_exit: 0 },
    allowlist: ['bun', 'git'],
    maxFanout: 4,
    seats: { worker: 'w:1', escalation: 'e:1', verify: 'v:1' },
    researchAvailable: false,
  };
  const plans: ConductorPlan[] = [];
  const ledger = createConductorCardLedger();
  const built = buildConductorFace(
    {
      goal: 'fix the thing',
      writeRoot: root,
      acceptance: ctx.acceptance,
      minutesLeft: 30,
      tokensLeft: null,
      maxFanout: 4,
      researchAvailable: false,
    },
    {
      ctx,
      ledger,
      runChild: async (p) => {
        plans.push(p);
        return fakeExec(p);
      },
    },
  );
  return { work: built.customTools!.find((t) => t.name === 'work')!, plans, ledger };
}

const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text;

const BRIEF = 'repro: bun test src/real.test.ts → 1 fail exit 1. scope: 一个文件。';

describe('conductor 派发 — #241 坐标机械校验', () => {
  test('★ 派工文本提到不存在的 `path:line` → 拒, 零派发, 判词点名', async () => {
    // 证伪: 删掉 orchestrating-loop.ts 的坐标校验块 → 本 test 由绿转红。
    const root = freshRepo();
    const { work, plans, ledger } = face(root);
    const r = await work.execute('t', {
      goal: '修 `src/checkpoint-manager.ts:312` 那处映射',
      brief: BRIEF,
      write_set: ['src/real.ts'],
    });
    expect(textOf(r)).toContain('[#241 坐标机械校验]');
    expect(textOf(r)).toContain('src/checkpoint-manager.ts');
    // 拒了就不许派出去 —— 与 solve/run 侧「零 worker 进程」同一条纪律。
    expect(plans).toHaveLength(0);
    // 拒计进 rejectedCompile (与 1-A 闸同一格: 两者都是「编译产物被引擎拒」)。
    expect(ledger.rejectedCompile).toBe(1);
  });

  test('★ 同句标识符不在该文件里 (0f67293b 的原形状) → 拒', async () => {
    const root = freshRepo();
    const { work, plans } = face(root);
    const r = await work.execute('t', {
      goal: '改 `saveVerdictReasonFull`, 它在 `src/real.ts:1`',
      brief: BRIEF,
      write_set: ['src/real.ts'],
    });
    expect(textOf(r)).toContain('saveVerdictReasonFull');
    expect(plans).toHaveLength(0);
  });

  test('坐标真实 → 照常派发 (闸不是恒红)', async () => {
    const root = freshRepo();
    const { work, plans } = face(root);
    const r = await work.execute('t', {
      goal: '改 `saveReasonFull`, 它在 `src/real.ts:1`',
      brief: BRIEF,
      write_set: ['src/real.ts'],
    });
    expect(textOf(r)).not.toContain('[#241 坐标机械校验]');
    expect(plans).toHaveLength(1);
  });

  test('判不了的散文碎片不误报 (#265 那 8/8 的教训)', async () => {
    const root = freshRepo();
    const { work, plans } = face(root);
    const r = await work.execute('t', {
      goal: '把 `、` 和 `26 + 30` 这类写法在 `src/real.ts` 里统一一下',
      brief: BRIEF,
      write_set: ['src/real.ts'],
    });
    expect(textOf(r)).not.toContain('[#241 坐标机械校验]');
    expect(plans).toHaveLength(1);
  });

  test('出口一: 同句写「新建」→ 放行', async () => {
    const root = freshRepo();
    const { work, plans } = face(root);
    const r = await work.execute('t', {
      goal: '新建 `src/brand-new.ts:1` 放新逻辑',
      brief: BRIEF,
      write_set: ['src/brand-new.ts'],
    });
    expect(textOf(r)).not.toContain('[#241 坐标机械校验]');
    expect(plans).toHaveLength(1);
  });

  test('出口二: 同行 `gate-allow(coord-check): <理由>` → 放行', async () => {
    const root = freshRepo();
    const { work, plans } = face(root);
    const r = await work.execute('t', {
      goal: '照 `src/gone.ts:9` 的老写法重做 gate-allow(coord-check): 已删文件的历史引用, 不是要去改它',
      brief: BRIEF,
      write_set: ['src/real.ts'],
    });
    expect(textOf(r)).not.toContain('[#241 坐标机械校验]');
    expect(plans).toHaveLength(1);
  });

  test('判词把两条出口都写给 conductor (它得自己改, 没有 force 可用)', async () => {
    // 这一处**刻意没有** force —— 拒因回给模型, 它当场改坐标重派。判词说不清出口,
    // conductor 就只会原样重试, 而重试不会让闸放行。
    const root = freshRepo();
    const { work } = face(root);
    const r = await work.execute('t', {
      goal: '修 `src/nope.ts:5`',
      brief: BRIEF,
      write_set: ['src/real.ts'],
    });
    const t = textOf(r);
    expect(t).toContain('新建');
    expect(t).toContain('gate-allow(coord-check)');
    expect(t).toContain('改正坐标后重派');
  });
});
