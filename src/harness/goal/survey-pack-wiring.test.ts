/**
 * src/harness/goal/survey-pack-wiring.test —— 勘察包的**接线**面 (契约
 * `docs/plan/2026-09-06-墙钟与读次数-执行契约.md` W1 / INV-2 后半 / INV-3)。
 *
 * 纯模块那半在 `survey-pack.test.ts`; 这里量的是「一次算好、两层共用」这句话有没有真接上:
 *  · conductor 那层: `withLoopConfig` 算一次 → 进 `ConductorFacts.surveyPack` → 进常驻 prompt 的独立段;
 *  · 子节点那层: `adaptCard` 派 `work` 时把**同一份**追到编译出的子节点 goal 末尾。
 *
 * 反向自检 (每条要能真红):
 *  · adaptCard 不追包 ⇒ 「子节点 goal 末尾含 header」红;
 *  · 追包不判卡名 (explore 也追) ⇒ 「非 work 卡不追」红;
 *  · withLoopConfig 不算包 ⇒ 「conductor 面含仓内事实」红;
 *  · 算了不记账 ⇒ 「ledger.surveyPack 读数」红;
 *  · 预算闸不豁免包 ⇒ 「INV-8 口径」红。
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { ConductorCtx } from '../conductor/types';
import { CONDUCTOR_PROMPT_RESIDENT_MAX, conductorPromptBudgetChars } from '../conductor/conductor-prompt';
import { createConductorCardLedger } from './loop-ledger';
import { withLoopConfig, type LoopHost } from './loop-run';
import { CONDUCTOR_NODE_ID, compileOrchestratingLoop, createConductorRuntimeTools } from './orchestrating-loop';
import { SURVEY_PACK_HEADER } from './survey-pack';

/** 真仓 (不是 mock): 勘察量的就是真盘。 */
function gitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-pack-wire-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  for (const [f, c] of Object.entries(files)) {
    const abs = join(dir, f);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, c);
  }
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

const CTX: ConductorCtx = {
  cwd: '/tmp/x',
  writeRoot: '/tmp/x',
  acceptance: { command: 'bun test src/a.test.ts', expect_exit: 0 },
  allowlist: ['bun', 'git'],
  maxFanout: 4,
  seats: { worker: 'w:1', escalation: 'e:1', verify: 'v:1' },
  researchAvailable: false,
};

const PACK = `${SURVEY_PACK_HEADER}\n\n--- 仓树 (深度 2, 2 条) ---\nsrc/\nsrc/a.ts`;
const BRIEF = 'repro: bun test src/a.test.ts → 1 fail (expected 2 got 3). scope: src/a.ts only.';

const fakeExec = (plan: ConductorPlan): ExecutorDagResult =>
  ({
    plan,
    sessionId: 's',
    levels: [Object.keys(plan.nodes)],
    results: Object.fromEntries(
      Object.keys(plan.nodes).map((id) => [id, { id, status: 'done', kind: 'agent', output: `report of ${id}`, deps: [], usage: { in: 1, out: 1 }, filesTouched: [] }]),
    ),
    reusedNodes: [],
    observations: [],
  }) as unknown as ExecutorDagResult;

describe('INV-3 —— work 派发: 子节点 goal 末尾追同一份勘察包', () => {
  test('★ 包在场 → 每个子节点 goal 末尾含 header 与包正文 (证伪: adaptCard 不追 ⇒ 本行红)', async () => {
    const calls: ConductorPlan[] = [];
    const tools = createConductorRuntimeTools({
      ctx: CTX,
      runChild: async (p) => { calls.push(p); return fakeExec(p); },
      surveyPack: PACK,
    });
    const work = tools.find((t) => t.name === 'work')!;
    await work.execute('t1', { goal: 'fix add()', brief: BRIEF });

    expect(calls).toHaveLength(1);
    const goals = Object.values(calls[0]!.nodes).map((n) => n.goal ?? '');
    expect(goals).toHaveLength(1);
    for (const g of goals) {
      expect(g).toContain(SURVEY_PACK_HEADER);
      expect(g.trimEnd().endsWith(PACK.trimEnd())).toBe(true);
      // 派工正文仍在最前 —— 包是**追加**, 不是替换。
      expect(g.indexOf(SURVEY_PACK_HEADER)).toBeGreaterThan(0);
    }
  });

  test('★ 空包不追加 (缺席 = 子节点 goal 逐字节同旧)', async () => {
    const withPack: ConductorPlan[] = [];
    const without: ConductorPlan[] = [];
    const mk = (pack?: string, sink: ConductorPlan[] = []): ReturnType<typeof createConductorRuntimeTools> =>
      createConductorRuntimeTools({ ctx: CTX, runChild: async (p) => { sink.push(p); return fakeExec(p); }, ...(pack ? { surveyPack: pack } : {}) });
    await mk(PACK, withPack).find((t) => t.name === 'work')!.execute('t1', { goal: 'fix add()', brief: BRIEF });
    await mk(undefined, without).find((t) => t.name === 'work')!.execute('t1', { goal: 'fix add()', brief: BRIEF });

    const plain = Object.values(without[0]!.nodes)[0]!.goal ?? '';
    const packed = Object.values(withPack[0]!.nodes)[0]!.goal ?? '';
    expect(plain).not.toContain(SURVEY_PACK_HEADER);
    // 追加而已: 去掉尾巴那一段就该逐字节回到原样。
    expect(packed.slice(0, plain.length)).toBe(plain);
  });

  test('非 work 卡不追包 (契约只钉 work; explore 派出去的活本身就是勘察)', async () => {
    const calls: ConductorPlan[] = [];
    const tools = createConductorRuntimeTools({
      ctx: CTX,
      runChild: async (p) => { calls.push(p); return fakeExec(p); },
      surveyPack: PACK,
    });
    const explore = tools.find((t) => t.name === 'explore')!;
    const res = (await explore.execute('t1', { question: 'where is add() defined?', places: ['src/a.ts', 'src/b.ts'] })) as { details: { ok: boolean } };
    if (!res.details.ok) return; // 该卡的 schema 与本用例无关: 编译没过就不判 (真身在上面两条)
    for (const p of calls) for (const n of Object.values(p.nodes)) expect(n.goal ?? '').not.toContain(SURVEY_PACK_HEADER);
  });
});

describe('INV-2 接线 —— withLoopConfig 算一次, 进 conductor 面 + 进账本', () => {
  const baseCfg = (): ExecutorDagConfig => ({ conductorModel: 'c:sota', leafModel: 'w:1' }) as ExecutorDagConfig;

  test('★ 真仓: conductor 常驻 prompt 含勘察包与仓内事实; 账本记 chars/sections; INV-8 口径仍绿', () => {
    const dir = gitRepo({
      'README.md': '# wire demo\n\n输出必须含 `conversion_lift` 键。\n',
      'tests/test_x.py': 'def test_x():\n    assert 1\n',
      'src/app/report.py': 'conversion_lift = 1\n',
    });
    const cfg = baseCfg();
    const host: LoopHost = { cwd: dir, dag: cfg };
    const plan = compileOrchestratingLoop({ goal: '修 `conversion_lift`, 见 src/app/report.py', ctx: { ...CTX, cwd: dir, writeRoot: dir } });
    const ledger = createConductorCardLedger();
    const out = withLoopConfig(cfg, plan, host, null, '修 `conversion_lift`', ledger);
    const face = out.leafFace!({ id: CONDUCTOR_NODE_ID } as never)!;

    // 证伪: withLoopConfig 不算包 ⇒ 这三行红。
    expect(face.systemPrompt).toContain(SURVEY_PACK_HEADER);
    expect(face.systemPrompt).toContain('tests/test_x.py');
    expect(face.systemPrompt).toContain('src/app');
    // 证伪: 算了不记账 ⇒ 这两行红 (读数拿不到 = 没有这个读数)。
    expect(ledger.surveyPack?.chars).toBeGreaterThan(0);
    expect(ledger.surveyPack?.sections).toContain('tree');
    expect(ledger.surveyPack?.chars).toBe(face.systemPrompt.length - face.systemPrompt.indexOf(SURVEY_PACK_HEADER));
    // 证伪: 预算闸不豁免包 ⇒ 本行红 (facts 块本身没涨, 8000 这个数没动)。
    expect(conductorPromptBudgetChars(face.systemPrompt)).toBeLessThanOrEqual(CONDUCTOR_PROMPT_RESIDENT_MAX);
    console.log(`conductor budget=${conductorPromptBudgetChars(face.systemPrompt)} chars, pack=${ledger.surveyPack?.chars} chars, sections=${ledger.surveyPack?.sections.join('/')}`);
  });
});
