/**
 * P3 S5 / INV-8 —— conductor 常驻 prompt ≤ 8k, manual 一行都不进, 渲染不调 manual()。
 * 证伪: 把任一 `tool.manual()` 拼进 renderConductorPrefix → ②③红;工具行不用 `short` → ④红;
 * 往前缀里加 20k 画图说明 → ①红。
 */
import { describe, expect, test } from 'bun:test';
import { buildConductorSystemPrompt, conductorPromptBudgetChars, CONDUCTOR_PROMPT_BOUNDARY, CONDUCTOR_PROMPT_PREFIX_MAX, CONDUCTOR_PROMPT_RESIDENT_MAX, renderConductorPrefix } from './conductor-prompt';
import { SURVEY_PACK_HEADER } from '../goal/survey-pack';
import { createConductorTools, CONDUCTOR_TOOL_NAMES } from './tools/index';
import { renderManual } from './render-manual';
import type { ConductorCtx, ConductorTool } from './types';

const ctx: ConductorCtx = { cwd: '/w', writeRoot: '/w', acceptance: { command: 'bun test', expect_exit: 0 }, allowlist: ['bun'], maxFanout: 6, seats: { worker: 'a', escalation: 'b', verify: 'c' }, researchAvailable: false };
const FULL_FACTS = {
  // 2026-09-03: goal 按 bench 真题面的长度给 (实测 800–900 字符) —— 2026-09-02 首批 INV-8 超限 (8217/8299)
  // 就是因为这里此前只放了一句 100 字符的 goal, 满槽不满。
  goal: ('Fix the flaky retry in src/harness/agent-leaf.ts so that a timed-out leaf reports budgetStopped instead of done. ' +
    'Context: the leaf loop in agent-leaf.ts wraps the provider call with a deadline; when the deadline fires the loop returns the partial ' +
    'assistant message and the caller currently maps it to done because filesTouched is non-empty. Reproduce with ' +
    'OMD_LEAF_TIMEOUT_MS=10 bun test src/harness/dag/budget-leaf-timeout.test.ts and observe the status column. The fix must keep the ' +
    'partial output (do not drop it), set budgetStopped with the elapsed time, and leave the checkpoint untouched so a resume can reuse it. ' +
    'Do not touch run-goal.ts; the terminal-state mapping there is owned by another change. Add one red test first, then make it green. ' +
    'Report the before/after failure set of the acceptance command and the exit codes verbatim. ' +
    'Keep the change under fifty lines and do not reformat untouched code.').slice(0, 900),
  writeRoot: '/home/nick/repos/oh-my-dag',
  protectedPaths: ['docs/plan/NOTES.md', 'src/model/seats.ts'],
  acceptance: { command: 'bun test src/harness/dag/budget-leaf-timeout.test.ts', expect_exit: 0 },
  minutesLeft: 38,
  tokensLeft: 250_000,
  maxFanout: 6,
  objective: 'finish in the least wall time within the token budget',
  researchAvailable: true,
  upstream: 'Prior round: worker w1 returned red twice on the same assertion; verifier not yet called.',
};

describe('conductor prompt', () => {
  test('★ ① 常驻字符 ≤ 8000 (满槽 facts)', () => {
    const tools = createConductorTools(ctx);
    const p = buildConductorSystemPrompt(FULL_FACTS, tools);
    console.log(`conductor resident=${p.length} chars`);
    expect(FULL_FACTS.goal.length).toBeGreaterThanOrEqual(850); // 满槽是真满: 题面按 bench 实测长度
    expect(p.length).toBeLessThanOrEqual(CONDUCTOR_PROMPT_RESIDENT_MAX);
    // 前缀自己的上限: 给事实留 ≥ 1400 字符 (2026-09-03)。删掉任一节的精简 → 这条先红。
    expect(renderConductorPrefix(tools).length).toBeLessThanOrEqual(CONDUCTOR_PROMPT_PREFIX_MAX);
  });

  test('★ ② 七张 manual 的首行一条都不出现在常驻 prompt 里', () => {
    const p = buildConductorSystemPrompt(FULL_FACTS, createConductorTools(ctx));
    for (const name of CONDUCTOR_TOOL_NAMES) {
      const head = renderManual(name).split('\n')[0]!;
      expect(head.length).toBeGreaterThan(5);
      expect(p).not.toContain(head);
    }
  });

  test('★ ③ 渲染过程一次都不调 manual()', () => {
    let calls = 0;
    const spied: ConductorTool[] = createConductorTools(ctx).map((t) => ({ ...t, manual: () => { calls++; return t.manual(); } }));
    buildConductorSystemPrompt(FULL_FACTS, spied);
    renderConductorPrefix(spied);
    expect(calls).toBe(0);
  });

  test('★ ④ §1 工具行逐字来自注册表 short', () => {
    const tools = createConductorTools(ctx);
    const prefix = renderConductorPrefix(tools);
    for (const t of tools) expect(prefix).toContain(`- ${t.name}: ${t.short}`);
    const swapped = tools.map((t) => (t.name === 'work' ? { ...t, short: 'CHANGED SHORT' } : t));
    expect(renderConductorPrefix(swapped)).toContain('- work: CHANGED SHORT');
  });

  test('★ ⑤ 全部槽被填, 渲染后无残留 {{, 事实全在边界之后', () => {
    const p = buildConductorSystemPrompt(FULL_FACTS, createConductorTools(ctx));
    expect(p).not.toContain('{{');
    const [prefix, facts] = p.split(CONDUCTOR_PROMPT_BOUNDARY);
    for (const s of [FULL_FACTS.goal, 'bun test src/harness/dag/budget-leaf-timeout.test.ts', '38 minutes', '250000 tokens', '6 workers at once', FULL_FACTS.objective, 'docs/plan/NOTES.md', 'Prior round']) {
      expect(facts).toContain(s);
      expect(prefix).not.toContain(s);
    }
    const other = buildConductorSystemPrompt({ ...FULL_FACTS, goal: 'other', minutesLeft: null, tokensLeft: null, objective: undefined, researchAvailable: false, upstream: undefined }, createConductorTools(ctx));
    expect(other.split(CONDUCTOR_PROMPT_BOUNDARY)[0]).toBe(prefix);
    expect(other).toContain('no minute budget');
  });

  test('★ ⑥ 工具清单不含 write / edit (conductor 不写文件, owner 9/2 裁)', () => {
    const prefix = renderConductorPrefix(createConductorTools(ctx));
    const toolSection = prefix.slice(prefix.indexOf('## 1. Tools'), prefix.indexOf('## 2.'));
    expect(toolSection).not.toMatch(/\b(write|edit)\(/);
    expect(toolSection).toContain('read(path');
    expect(toolSection).toContain('bash(command)');
  });
});

describe('1-A (2026-09-03): 判据文件先落盘的事实行', () => {
  test('criterionFiles 非空 → 判据行尾接 "Missing now: …" (≤ 140 字符; 满槽夹具 7967 已贴着 8000, 真 bench 事实约 7780); 缺席 / 空 → 无', () => {
    const tools = createConductorTools(ctx);
    const base = buildConductorSystemPrompt(FULL_FACTS, tools);
    const withFiles = buildConductorSystemPrompt({ ...FULL_FACTS, criterionFiles: ['tests/test_tz.py'] }, tools);
    // 2026-09-05 (只留边界): 措辞从「dispatch #1 must be ONE work()」翻成只说边界 —— 引擎不再规定第一发做什么。
    expect(withFiles).toContain('Missing now: tests/test_tz.py — frozen (hashed) once written');
    console.log(`conductor resident with criterionFiles=${withFiles.length} chars (+${withFiles.length - base.length})`);
    // 满槽夹具 (900 字 goal + protectedPaths + upstream) 本就贴着 8000; 真 bench 事实没有 upstream / protectedPaths, 约 7780 + 这段。
    expect(withFiles.length - base.length).toBeLessThanOrEqual(140);
    expect(base).not.toContain('Missing now:');
    expect(buildConductorSystemPrompt({ ...FULL_FACTS, criterionFiles: [] }, tools)).not.toContain('Missing now:');
  });
});

/**
 * W1 勘察包 (2026-09-06, 契约 `docs/plan/2026-09-06-墙钟与读次数-执行契约.md` INV-2)。
 *
 * 勘察包是**独立一段**, 不进 facts 块: facts 块的 8000 字符预算 (INV-8) 一个字都不改,
 * 预算口径改成「勘察包之前的那一段」—— 包本身在闸里显式豁免。
 *
 * 证伪: 把包拼进 `renderConductorFacts` (而不是独立段) ⇒ 「facts 块逐字节不变」红;
 * `conductorPromptBudgetChars` 不切段 (直接返 `prompt.length`) ⇒ 「预算口径」红;
 * 缺席时仍拼一个空段 ⇒ 「不给包字节不变」红。
 */
describe('W1: 勘察包独立段 + INV-8 预算豁免', () => {
  const tools = createConductorTools(ctx);
  const PACK = `${SURVEY_PACK_HEADER}\n\n--- 仓树 (深度 2, 3 条) ---\nsrc/\nsrc/harness/\nREADME.md`;

  test('★ 不给 surveyPack ⇒ prompt 逐字节不变 (缺席 = 零影响)', () => {
    const base = buildConductorSystemPrompt(FULL_FACTS, tools);
    expect(buildConductorSystemPrompt({ ...FULL_FACTS, surveyPack: undefined }, tools)).toBe(base);
    // 空串也当缺席 —— 只有头行的空壳等于凭空多一段噪声。
    expect(buildConductorSystemPrompt({ ...FULL_FACTS, surveyPack: '' }, tools)).toBe(base);
    expect(base).not.toContain(SURVEY_PACK_HEADER);
  });

  test('★ 给 surveyPack ⇒ 头行在 facts 块之后, facts 块本身逐字节不变', () => {
    const base = buildConductorSystemPrompt(FULL_FACTS, tools);
    const withPack = buildConductorSystemPrompt({ ...FULL_FACTS, surveyPack: PACK }, tools);
    // 证伪: 包拼进 facts 块 (而不是追在末尾) ⇒ 本行红。
    expect(withPack.startsWith(base)).toBe(true);
    expect(withPack.endsWith(PACK)).toBe(true);
    expect(withPack.indexOf(SURVEY_PACK_HEADER)).toBeGreaterThan(withPack.indexOf(CONDUCTOR_PROMPT_BOUNDARY));
  });

  test('★ INV-8: 8000 这个数不动 —— 8k 的包不撑破预算口径 (包在闸里显式豁免)', () => {
    const big = `${SURVEY_PACK_HEADER}\n\n${'x'.repeat(8000)}`;
    const p = buildConductorSystemPrompt({ ...FULL_FACTS, surveyPack: big }, tools);
    // 总长确实超 8000 —— 所以预算口径必须切段, 否则这条闸对着一个不归它管的数字报警。
    expect(p.length).toBeGreaterThan(CONDUCTOR_PROMPT_RESIDENT_MAX);
    expect(conductorPromptBudgetChars(p)).toBeLessThanOrEqual(CONDUCTOR_PROMPT_RESIDENT_MAX);
    console.log(`conductor budget(含 8k 包)=${conductorPromptBudgetChars(p)} chars, 总长=${p.length}`);
  });

  test('没有包 ⇒ 预算口径 = 全长 (豁免只对真有包的那一段生效)', () => {
    const p = buildConductorSystemPrompt(FULL_FACTS, tools);
    expect(conductorPromptBudgetChars(p)).toBe(p.length);
    expect(p.length).toBeLessThanOrEqual(CONDUCTOR_PROMPT_RESIDENT_MAX);
  });
});
