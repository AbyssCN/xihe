/**
 * goal/spec-pack-wiring.test —— 规格包的**接线面** (R7, 契约
 * `docs/plan/2026-09-07-规格包-上游对齐与需求枚举-执行契约.md` INV-4 / INV-5 + D-5 三态)。
 *
 * 纯模块 (并集 / 多数投票 / fail-open / 截断) 在 `./spec-pack.test.ts`; 这里只问接线的三件事:
 *  · **一处注入两边可见** —— 同一段 `## 规格包` 既进 conductor 面, 又进判据共识那一发的 prompt;
 *  · **开关缺席逐字节同旧** —— 关着的那一侧不许有任何变化 (单变量臂 `code80-m3-spec` 的前提);
 *  · **三态分得开** —— 开关缺席 ⇒ ledger 无 `specPack` 格; 开关开但采样全挂 ⇒ 有格、facts 全 0、`why` 非空。
 *
 * ⚠ 接线走**真模块** (`buildSpecPack` / `classifyGoal` 都是真的), 只把 `config.dag.generate`
 * 换成 fake —— 要证的是「run-goal 把真东西接上了」, 不是「假东西返了个对象」。
 * 用 `dag.generate` 而不是 `_classify`: 后者会把整条真分类路径 (规格包 → 共识 prompt) 短路掉。
 *
 * ## 反向自检 (2026-09-07 逐条真跑过, 还原复绿)
 *  · run-goal 不读 `specPackEnabled()` (无条件算) ⇒ INV-4 红 (关着也出现 `## 规格包` 与 ledger 格);
 *  · run-goal 只把规格包接到 `loopSurveyPack` 而不接进 `surveyForClassify` ⇒ INV-5 的共识那半红;
 *  · run-goal 只接 `surveyForClassify` 而不追加到 `loopSurveyPack.text` ⇒ INV-5 的 conductor 那半红;
 *  · classify-acceptance 的 D-6 那一句改成无条件加 ⇒「开关缺席时 prompt 不含那一句」红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import { SPEC_PACK_HEADER } from './spec-pack';
import { runGoal } from './run-goal';

const SPEC_ENV = 'OMD_SPEC_PACK';
const CONSENSUS_ENV = 'OMD_CRITERION_CONSENSUS';
const priorSpec = process.env[SPEC_ENV];
const priorConsensus = process.env[CONSENSUS_ENV];
afterEach(() => {
  if (priorSpec === undefined) delete process.env[SPEC_ENV];
  else process.env[SPEC_ENV] = priorSpec;
  if (priorConsensus === undefined) delete process.env[CONSENSUS_ENV];
  else process.env[CONSENSUS_ENV] = priorConsensus;
});

/** 规格包那一发的回文 (真 `parseSpecSample` 解析得动的最小形状)。 */
const SPEC_JSON = JSON.stringify({
  project: 'demo 0.1',
  interfaces: [{ name: 'Validator.check_validity_of', signature: 'check_validity_of(self, v)', returns: 'bool', raises: 'ValueError', source: 'upstream' }],
  conventions: [{ file: 'tests/test_validator.py', note: '用 pytest.raises 断言' }],
  requirements: [{ text: '空 payload 要返回 False', source: 'instruction', edge: '空值' }],
});
/** 分类那一发的回文 (走真 `normalizeClassification`; `cat` 在白名单里, 首词过闸)。 */
const CLASSIFY_JSON = JSON.stringify({ tier: 'simple', acceptance_kind: 'executable', command: 'cat src.ts' });

/**
 * ⚠ README + 既有测试文件是**必需**的, 不是装饰: 没有它们 `surveyForCriterion` 出空串,
 * 分类 prompt 里整个「仓内契约线索」段 (D-6 那句话的宿主) 压根不渲染 —— 于是「关着时不含
 * 那一句」会因为**段不存在**而恒绿, 量的是尺子不是被测物。2026-09-07 第一版 fixture 就是
 * 这样, 把 D-6 改成无条件加之后本文件仍 3 pass, 才发现这一格。
 */
function seedRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-spec-wiring-'));
  writeFileSync(join(cwd, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(cwd, 'README.md'), '# fixture\n\nValidator 拒绝空 payload。\n');
  writeFileSync(join(cwd, 'src.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  writeFileSync(join(cwd, 'src.test.ts'), "import { test } from 'bun:test';\ntest('add', () => {});\n");
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['add', '-A'], { cwd });
  return cwd;
}

const leaf = (over: Record<string, unknown>): Record<string, unknown> => ({ id: 'x', status: 'done', kind: 'agent', output: '', deps: [], usage: { in: 1, out: 1 }, ...over });

interface Captured {
  /** 判据分类/共识那几发真发出去的 prompt 全文 (共识开着时 ≥ 2 发)。 */
  classifyPrompts: string[];
  /** 规格包那几发真发出去的 prompt 全文。 */
  specPrompts: string[];
  /** conductor 常驻 system prompt。 */
  conductorPrompt?: string;
}

/** 一次编排循环 run。真分类 + 真规格包, 只把模型换成 fake。 */
async function specRun(cwd: string, cap: Captured, specReply: string = SPEC_JSON): Promise<Awaited<ReturnType<typeof runGoal>>> {
  const generate = (async (req: { traceName?: string; messages: { content: string }[] }) => {
    const prompt = req.messages.map((m) => m.content).join('\n');
    if (req.traceName === 'goal:spec-pack') {
      cap.specPrompts.push(prompt);
      return { text: specReply, usage: { in: 1, out: 1 } };
    }
    if (req.traceName === 'classify:acceptance') cap.classifyPrompts.push(prompt);
    return { text: CLASSIFY_JSON, usage: { in: 1, out: 1 } };
  }) as ExecutorDagConfig['generate'];
  return runGoal('make Validator reject empty payloads', {
    cwd,
    dag: {
      conductorModel: 'bench:MiniMax-M3',
      leafModel: 'bench:MiniMax-M3',
      generate,
      verifier: (async () => ({ pass: true, reason: 'ok', usage: { in: 0, out: 0 } })) as ExecutorDagConfig['verifier'],
    } as ExecutorDagConfig,
    _today: () => '2026-09-07',
    _runDag: (async (plan: ConductorPlan, dagCfg: ExecutorDagConfig): Promise<ExecutorDagResult> => {
      cap.conductorPrompt = dagCfg.leafFace?.({ id: 'conductor' } as never)?.systemPrompt;
      const results = { conductor: leaf({ id: 'conductor', artifactRoot: cwd }), accept: leaf({ id: 'accept', kind: 'command', status: 'done', exitCode: 0 }) };
      return { plan, results, reusedNodes: [] } as unknown as ExecutorDagResult;
    }) as never,
  });
}

const fresh = (): Captured => ({ classifyPrompts: [], specPrompts: [] });

// ── INV-5: 一处注入, 两边可见 ────────────────────────────────────────────────

describe('INV-5 开关开 ⇒ conductor 面与共识 prompt 都拿到同一段 `## 规格包`', () => {
  test('★ conductor 常驻 prompt 含规格包, 且共识那几发的 prompt 也含它', async () => {
    process.env[SPEC_ENV] = '1';
    process.env[CONSENSUS_ENV] = '1';
    const cap = fresh();
    const r = await specRun(seedRepo(), cap);
    // 规格包那一发真发出去了 (走的是生产回落 generate, 不是只读注入口)。
    expect(cap.specPrompts.length).toBeGreaterThan(0);
    expect(cap.specPrompts[0]).toContain('## 你要回答的四个问题');
    // ① 共识那一侧: 每一发分类 prompt 都带规格包 (证伪: 不接 surveyForClassify ⇒ 本条红)。
    expect(cap.classifyPrompts.length).toBeGreaterThan(0);
    for (const p of cap.classifyPrompts) expect(p).toContain(SPEC_PACK_HEADER);
    // D-6: 规格包在场才加的那一句措辞。
    for (const p of cap.classifyPrompts) expect(p).toContain('以那一节为准');
    // ② conductor 那一侧 (证伪: 不追加到 loopSurveyPack.text ⇒ 本条红)。
    expect(cap.conductorPrompt ?? '').toContain(SPEC_PACK_HEADER);
    // 两边是**同一段文本**: 接口那一行逐字出现在两处。
    expect(cap.conductorPrompt ?? '').toContain('Validator.check_validity_of');
    expect(cap.classifyPrompts[0]).toContain('Validator.check_validity_of');
    // ③ 读数进 loop 账本。
    expect(r.loop?.specPack).toMatchObject({ interfaces: 1, upstreamNamed: 1, guessed: 0, requirements: 1, fromInstruction: 1 });
    expect(r.loop?.specPack?.chars).toBeGreaterThan(0);
    expect(r.loop?.specPack?.why).toBeUndefined();
  }, 60_000);
});

// ── INV-4: 开关缺席 ⇒ 一个字节都不变 ─────────────────────────────────────────

describe('INV-4 开关缺席 ⇒ 勘察包与分类 prompt 逐字节同旧, ledger 无 specPack 格', () => {
  test('★ 缺席与 =0 两跑: 无规格包段、无 D-6 那句、无 ledger 格、零规格包调用', async () => {
    process.env[CONSENSUS_ENV] = '1';
    delete process.env[SPEC_ENV];
    const off = fresh();
    const cwdOff = seedRepo();
    const rOff = await specRun(cwdOff, off);
    process.env[SPEC_ENV] = '0';
    const zero = fresh();
    const cwdZero = seedRepo();
    const rZero = await specRun(cwdZero, zero);

    for (const cap of [off, zero]) {
      // 证伪: run-goal 不读 specPackEnabled() ⇒ 这三条红。
      expect(cap.specPrompts).toEqual([]);
      expect(cap.classifyPrompts[0]).not.toContain(SPEC_PACK_HEADER);
      expect(cap.classifyPrompts[0]).not.toContain('以那一节为准');
      expect(cap.conductorPrompt ?? '').not.toContain(SPEC_PACK_HEADER);
    }
    // 三态: 缺席 = **没有这一格**, 不是空对象、不是全 0 (§静默坑 1)。
    expect(rOff.loop?.specPack).toBeUndefined();
    expect(rZero.loop?.specPack).toBeUndefined();
    // 两跑的分类 prompt 逐字节相同 —— 半开的开关会让对照臂无声漂。
    // 两跑各自建了自己的临时仓, 所以先把**仓根路径**归一 (prompt 里印了它); 归一的只有这一个串,
    // 别的差异一个字节都不许有。
    const norm = (p: string, root: string): string => p.split(root).join('<ROOT>');
    expect(norm(zero.classifyPrompts[0]!, cwdZero)).toBe(norm(off.classifyPrompts[0]!, cwdOff));
  }, 60_000);
});

// ── D-5 三态: 开关开但生成失败 ───────────────────────────────────────────────

describe('D-5 三态: 开关开但采样全挂 ⇒ 有格、facts 全 0、why 非空 (与「没开」分得开)', () => {
  test('★ 模型回散文 ⇒ 主流程照跑, ledger 留证据, prompt 不含空壳段', async () => {
    process.env[SPEC_ENV] = '1';
    delete process.env[CONSENSUS_ENV];
    const cap = fresh();
    const r = await specRun(seedRepo(), cap, '模型今天想聊天, 不想输出 JSON');
    // 采了 (两发一份, 重试一次), 但一份都没成。
    expect(cap.specPrompts.length).toBeGreaterThanOrEqual(2);
    // 证伪: 去掉 fail-open ⇒ runGoal 抛, 本条红。
    expect(r.loop?.specPack).toMatchObject({ samples: 0, requirements: 0, interfaces: 0, upstreamNamed: 0, guessed: 0, chars: 0 });
    expect(r.loop?.specPack?.why ?? '').not.toBe('');
    // 空包不进 prompt: 空壳段头行也不许出现 (那会让对照臂的字节数变了)。
    expect(cap.classifyPrompts[0]).not.toContain(SPEC_PACK_HEADER);
    expect(cap.conductorPrompt ?? '').not.toContain(SPEC_PACK_HEADER);
  }, 60_000);
});
