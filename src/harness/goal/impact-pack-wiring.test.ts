/**
 * src/harness/goal/impact-pack-wiring.test —— 影响包的**接线**面 (契约
 * `docs/plan/2026-09-06-影响包-执行契约.md` 切片 2 / INV-7)。
 *
 * 纯模块那半在 `impact-pack.test.ts`, 进勘察包那半在 `survey-pack.test.ts`; 这里量的是
 * 「不新造第二条注入路」有没有成立: 影响包是勘察包的第七段, 所以它**天然**跟着 `surveyPack`
 * 那一跳走到两处 —— conductor 常驻 prompt 与每个 `work` 子节点 goal。
 *
 * 反向自检 (每条要能真红):
 *  · survey-pack 不加 impact 段 ⇒ 「conductor 面含影响包头行」红;
 *  · 读数没从 pack 提到 ledger ⇒ 「ledger.surveyPack.impact 在场」红;
 *  · adaptCard 那一跳被绕开 (另造一条注入路) ⇒ 「子节点 goal 含影响包头行」红;
 *  · 影响包没被 INV-8 豁免 ⇒ 「conductor 预算口径仍绿」红。
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONDUCTOR_PROMPT_RESIDENT_MAX, conductorPromptBudgetChars } from '../conductor/conductor-prompt';
import type { ConductorCtx } from '../conductor/types';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import { IMPACT_PACK_HEADER } from './impact-pack';
import { createConductorCardLedger } from './loop-ledger';
import { type LoopHost, withLoopConfig } from './loop-run';
import { CONDUCTOR_NODE_ID, compileOrchestratingLoop, createConductorRuntimeTools } from './orchestrating-loop';
import { buildSurveyPack } from './survey-pack';

/** 真仓 (不是 mock): 抽取量的就是真盘。 */
function gitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-impact-wire-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  for (const [f, c] of Object.entries(files)) {
    const abs = join(dir, f);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, c);
  }
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init impact'], { cwd: dir });
  return dir;
}

const FILES = {
  'README.md': '# impact wire\n\n输出必须含 `build_report` 的表头。\n',
  'tests/test_x.py': 'def test_x():\n    assert 1\n',
  'src/app.py': 'import json\n\n\ndef build_report(rows):\n    total = sum(rows)\n    return json.dumps({"total": total})\n',
  'src/cli.py': 'from app import build_report\n\n\ndef main(rows):\n    print(build_report(rows))\n',
};
const GOAL = '修 `build_report` 的表头, 见 src/app.py';

const CTX: ConductorCtx = {
  cwd: '/tmp/x',
  writeRoot: '/tmp/x',
  acceptance: { command: 'bun test src/a.test.ts', expect_exit: 0 },
  allowlist: ['bun', 'git'],
  maxFanout: 4,
  seats: { worker: 'w:1', escalation: 'e:1', verify: 'v:1' },
  researchAvailable: false,
};

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

describe('INV-7 —— 影响包跟着 surveyPack 那一跳走到两层', () => {
  test('★ conductor 常驻 prompt 含影响包 (定义整段); 账本记 impact 读数; INV-8 口径仍绿', () => {
    const dir = gitRepo(FILES);
    const cfg = { conductorModel: 'c:sota', leafModel: 'w:1' } as ExecutorDagConfig;
    const host: LoopHost = { cwd: dir, dag: cfg };
    const plan = compileOrchestratingLoop({ goal: GOAL, ctx: { ...CTX, cwd: dir, writeRoot: dir } });
    const ledger = createConductorCardLedger();
    const out = withLoopConfig(cfg, plan, host, null, GOAL, ledger);
    const face = out.leafFace!({ id: CONDUCTOR_NODE_ID } as never)!;

    // 证伪: survey-pack 不加第七段 ⇒ 这两行红。
    expect(face.systemPrompt).toContain(IMPACT_PACK_HEADER);
    expect(face.systemPrompt).toContain('def build_report(rows):');
    // 证伪: 读数没从 pack 提到 ledger ⇒ 这三行红 (读数拿不到 = 没有这个读数)。
    expect(ledger.surveyPack?.sections).toContain('impact');
    expect(ledger.surveyPack?.impact?.defs).toBe(1);
    expect(ledger.surveyPack?.impact?.callers).toBeGreaterThanOrEqual(1);
    // 证伪: 影响包没被 INV-8 豁免 (它在 SURVEY_PACK_HEADER 之后, 整段不进预算) ⇒ 本行红。
    expect(conductorPromptBudgetChars(face.systemPrompt)).toBeLessThanOrEqual(CONDUCTOR_PROMPT_RESIDENT_MAX);
    console.log(
      `impact wiring: budget=${conductorPromptBudgetChars(face.systemPrompt)} chars, pack=${ledger.surveyPack?.chars} chars, ` +
        `sections=${ledger.surveyPack?.sections.join('/')}, impact=${JSON.stringify(ledger.surveyPack?.impact)}`,
    );
  });

  test('★ work 子节点 goal 含影响包头行 (走既有 surveyPack 那一跳, 不新造第二条注入路)', async () => {
    const dir = gitRepo(FILES);
    const pack = buildSurveyPack(GOAL, dir);
    expect(pack.text).toContain(IMPACT_PACK_HEADER); // 前提: 这个仓真抽得到定义

    const calls: ConductorPlan[] = [];
    const tools = createConductorRuntimeTools({
      ctx: CTX,
      runChild: async (p) => {
        calls.push(p);
        return fakeExec(p);
      },
      surveyPack: pack.text,
    });
    await tools.find((t) => t.name === 'work')!.execute('t1', { goal: 'fix build_report()', brief: BRIEF });

    expect(calls).toHaveLength(1);
    for (const node of Object.values(calls[0]!.nodes)) {
      const g = node.goal ?? '';
      // 证伪: adaptCard 那一跳被绕开 ⇒ 这两行红。
      expect(g).toContain(IMPACT_PACK_HEADER);
      expect(g).toContain('def build_report(rows):');
    }
  });
});
