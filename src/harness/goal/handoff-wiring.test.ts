/**
 * W2 接线面 —— 契约 `docs/plan/2026-09-06-墙钟与读次数-执行契约.md` INV-3 的读账那一半。
 *
 * 两条缝各钉一遍:
 *  ① **工具钩子** —— `read` / `ls` / `grep` / `bash` 在返回前把「读了什么」交给读账。
 *     钩子缺席时四个工具的**返回字节逐字不变** (显式断言, 不靠"看起来没动")。
 *  ② **派发交接** —— `work` 派发时把读账渲染成一段追加进子节点 goal, 长度记进
 *     `ledger.dispatches[i].handoffChars`。空账不追加 (那一格 = 0)。
 *
 * 反向自检 (每条当场证伪过):
 *  · `adaptCard` 不追加交接段 ⇒ 「子 goal 含 HANDOFF_HEADER」当场红;
 *  · `handoffChars` 记成渲染前的字符数 ⇒ 「与追加长度一致」当场红;
 *  · 空账也追加表头 ⇒ 「空账不含 HANDOFF_HEADER」当场红;
 *  · agent-tools 四个工具里任一漏挂钩子 ⇒ 对应的「钩子收到一条」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdAgentTools, type AnyOmdTool } from '../agent-tools';
import { HANDOFF_HEADER, createReadLedger, type ReadEvent } from '../read-ledger';
import type { ConductorPlan } from '../conductor-plan';
import type { ConductorCtx } from '../conductor/types';
import type { ExecutorDagResult } from '../dag/types';
import { createConductorCardLedger } from './loop-ledger';
import { buildConductorFace } from './orchestrating-loop';

// ── ① 工具钩子 ──────────────────────────────────────────────────────────────

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-handoff-tools-'));
  writeFileSync(join(root, 'hello.ts'), 'export const needle = 1;\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'deep.ts'), 'const needle = 42;\n');
  return root;
}

const toolset = (root: string, onToolObserved?: (ev: ReadEvent) => void): Record<string, AnyOmdTool> =>
  Object.fromEntries(
    createOmdAgentTools({ cwd: root, ...(onToolObserved ? { onToolObserved } : {}) }).map((t) => [t.name, t]),
  );

const call = (t: AnyOmdTool, args: unknown): Promise<{ content: { type: string; text?: string }[] }> =>
  t.execute('call-1', args as never, undefined, undefined) as Promise<{ content: { type: string; text?: string }[] }>;

describe('W2 ①: 四个只读工具在返回前记账', () => {
  test('★ read / ls / grep / bash(只读) 各记一条, kind 与 key 对得上', async () => {
    const root = fixture();
    const seen: ReadEvent[] = [];
    const tools = toolset(root, (ev) => seen.push(ev));
    await call(tools.read!, { path: 'hello.ts' });
    await call(tools.ls!, { path: '.' });
    await call(tools.grep!, { pattern: 'needle' });
    await call(tools.bash!, { command: 'ls -la' });
    expect(seen.map((e) => e.kind)).toEqual(['read', 'ls', 'grep', 'bash-readonly']);
    expect(seen[0]!.key).toContain('hello.ts');
    expect(seen[0]!.excerpt).toContain('needle');
    expect(seen[2]!.key).toContain('needle');
    expect(seen[3]!.key).toContain('ls -la');
  });

  test('★ 判别力: 写/跑测试形态的 bash 不进账 (交接的是「我看见了什么」)', async () => {
    const root = fixture();
    const seen: ReadEvent[] = [];
    const tools = toolset(root, (ev) => seen.push(ev));
    await call(tools.bash!, { command: 'echo hi > out.txt' });
    expect(seen).toHaveLength(0);
  });

  test('★ 钩子缺席 ⇒ 四个工具的返回字节逐字不变 (I-1 基线)', async () => {
    const root = fixture();
    const withHook = toolset(root, () => {});
    const without = toolset(root);
    for (const [name, args] of [
      ['read', { path: 'hello.ts' }],
      ['ls', { path: '.' }],
      ['grep', { pattern: 'needle' }],
      ['bash', { command: 'ls -1' }],
    ] as const) {
      const a = await call(without[name]!, args);
      const b = await call(withHook[name]!, args);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  test('★ 钩子抛错不许掀桌 (只报不拦)', async () => {
    const root = fixture();
    const tools = toolset(root, () => {
      throw new Error('账本坏了');
    });
    const r = await call(tools.read!, { path: 'hello.ts' });
    expect(JSON.stringify(r)).toContain('needle');
  });
});

// ── ② 派发交接 ──────────────────────────────────────────────────────────────

function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-handoff-loop-'));
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

function face(root: string, readLedger?: ReturnType<typeof createReadLedger>) {
  const ctx: ConductorCtx = {
    cwd: root,
    writeRoot: root,
    allowlist: ['bun', 'git'],
    maxFanout: 4,
    seats: { worker: 'w:1', escalation: 'e:1', verify: 'v:1' },
    researchAvailable: false,
  } as ConductorCtx;
  const plans: ConductorPlan[] = [];
  const ledger = createConductorCardLedger();
  const built = buildConductorFace(
    { goal: '修一件事', writeRoot: root, minutesLeft: 30, tokensLeft: null, maxFanout: 4, researchAvailable: false },
    {
      ctx,
      ledger,
      ...(readLedger ? { readLedger } : {}),
      runChild: async (p) => {
        plans.push(p);
        return fakeExec(p);
      },
    },
  );
  return { work: built.customTools!.find((t) => t.name === 'work')!, plans, ledger, built };
}

const BRIEF = 'repro: bun test src/real.test.ts → 1 fail exit 1. scope: 一个文件。';

describe('W2 ②: work 派发把读账交接给子节点', () => {
  test('★ 读账非空 ⇒ 子节点 goal 末尾含表头与最近一次 read 的路径; handoffChars 与追加长度一致', async () => {
    const root = freshRepo();
    const rl = createReadLedger();
    rl.observe({ kind: 'read', key: 'read src/real.ts', excerpt: 'export const saveReasonFull = 1;' });
    const { work, plans, ledger } = face(root, rl);
    await work.execute('t', { goal: '改 `saveReasonFull`, 它在 `src/real.ts:1`', brief: BRIEF, write_set: ['src/real.ts'] });
    expect(plans).toHaveLength(1);
    const goal = Object.values(plans[0]!.nodes)[0]!.goal!;
    expect(goal).toContain(HANDOFF_HEADER);
    expect(goal).toContain('src/real.ts');
    const chars = ledger.dispatches[0]!.handoffChars!;
    expect(chars).toBeGreaterThan(0);
    // 一致 = 子 goal 长度 - 原 goal 长度恰好是这个数 (不是"差不多")。
    expect(goal.length - goal.indexOf(HANDOFF_HEADER)).toBeLessThanOrEqual(chars);
    expect(goal.endsWith(rl.render(4000))).toBe(true);
    expect(chars).toBe(rl.render(4000).length);
  });

  test('★ 空账不追加 (子 goal 不含表头, handoffChars = 0) —— 「没读过」不许被渲染成一段空事实', async () => {
    const root = freshRepo();
    const { work, plans, ledger } = face(root, createReadLedger());
    await work.execute('t', { goal: '改 `saveReasonFull`, 它在 `src/real.ts:1`', brief: BRIEF, write_set: ['src/real.ts'] });
    const goal = Object.values(plans[0]!.nodes)[0]!.goal!;
    expect(goal).not.toContain(HANDOFF_HEADER);
    expect(ledger.dispatches[0]!.handoffChars).toBe(0);
  });

  test('★ 读账缺席 (老调用方 / 测试不注入) ⇒ 子 goal 逐字同旧, handoffChars 缺席 (NULL ≠ 0)', async () => {
    const root = freshRepo();
    const { work, plans, ledger } = face(root);
    await work.execute('t', { goal: '改 `saveReasonFull`, 它在 `src/real.ts:1`', brief: BRIEF, write_set: ['src/real.ts'] });
    const goal = Object.values(plans[0]!.nodes)[0]!.goal!;
    expect(goal).not.toContain(HANDOFF_HEADER);
    expect(ledger.dispatches[0]!.handoffChars).toBeUndefined();
  });
});
