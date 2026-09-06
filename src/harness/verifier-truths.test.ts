/**
 * src/harness/verifier-truths.test —— **D-5 verifier 输入面契约** 的闸
 * (SDD `docs/plan/2026-08-11-inner-loop-v2-control-inversion.md`, 切片 4, 验收点 G-4)。
 *
 * 缺陷是**实证判例**不是推演: 本仓 `.omd/dag-runs.db` run `4a609621` (2026-08-10 probe) 判词逐字 ——
 * 「唯一保留意见: 句中『信任 token 03880693』**在我可见的任务文本里无对应来源, 无法核验**」。
 * 那串 token 是引擎自己注入进 leaf prompt 的 (engine 的 runNonce → prompt-fence 的 trustHeader),
 * 判卷官却只拿到原始 task + 结果摘要 —— **注入面知道真值、判卷面拿不到**, 确定性假阳。
 *
 * G-4 两个 Given 逐条对应:
 *  · Given 注入真值未随卷 → 装配期拒起跑 (错误指名缺哪份真值) —— describe 一;
 *  · Given 随卷 → verifier 判词里逐字符比对可见 (真值进得了模型收到的 prompt) —— describe 二。
 *
 * 反向自检 (G-6, 每条闸都得证明它真会红):
 *  ① 已知违规样本 = 「注入面有一份真值、卷面没它」—— `assertJudgingTruthsCarried` 与
 *     `createDefaultVerifier` 两条路径各拿它证伪一次, 断言抛且点名。
 *  ② 把 verifier.ts 的 `verifierPrompt` 里那行 `${renderJudgingTruths(truths)}` 删掉 (= 真值不随卷),
 *     装配期闸当场抛 (`判卷真值未随卷 — trustToken … → 拒起跑`) → 「随卷」那两条当场红。
 *     (2026-08-11 实跑证伪过: 删掉那行 → 4 pass / 2 fail; 恢复 → 6 pass / 0 fail。)
 *  ③ 阴性对照: 一份真值都不给时卷面**逐字节同旧** —— 闸不许顺手改老行为。
 */
import { describe, expect, test } from 'bun:test';
import {
  assertJudgingTruthsCarried,
  createDefaultVerifier,
  renderJudgingTruths,
  type JudgingTruths,
} from './verifier';
import type { ConductorPlan } from './conductor-plan';
import type { LeafResult } from './dag/engine';

/** engine 那侧 `makeRunNonce()` 的形状: 8 位十六进制 (prompt-fence.ts)。 */
const NONCE = 'ccf7b6bb';

const plan: ConductorPlan = { name: 'p', nodes: { answer: { goal: '一句话回答', executor: 'leaf' } } };
const results: Record<string, LeafResult> = {
  answer: {
    id: 'answer',
    status: 'done',
    kind: 'inproc',
    // 判例里执行体做的正是这件事: 把 prompt 最开头那串 token 复述出来。
    output: `我正在执行 G1 probe (信任 token ${NONCE})。`,
    deps: [],
    usage: { in: 0, out: 0 },
  } as unknown as LeafResult,
};

/** 造一个只捕获 prompt 的 verifier, 返回 [verifier, 读取最近一次 prompt]。 */
function capturing(truths?: JudgingTruths) {
  let seen = '';
  const verifier = createDefaultVerifier({
    verifierModel: 'fake:m',
    ...(truths ? { truths } : {}),
    callModelFn: (async (req: { messages: Array<{ content: string }> }) => {
      seen = req.messages.map((m) => m.content).join('\n');
      return { text: '', parsed: { pass: true, reason: 'ok' }, usage: { in: 1, out: 1 } };
    }) as never,
  });
  return [verifier, () => seen] as const;
}

describe('G-4 前半: 注入真值未随卷 → 装配期拒起跑, 错误指名缺哪份真值', () => {
  test('已知违规样本: 真值在手、卷面没它 → 抛, 且点名 trustToken', () => {
    // 证伪: 闸若不判 (或只记 warn), 这次跑就会带着闭卷考的判卷官起跑 —— 假阳到跑完一整张 DAG 才可见。
    expect(() => assertJudgingTruthsCarried({ trustToken: NONCE }, '卷面里根本没有这串值')).toThrow(
      /判卷真值未随卷/,
    );
    expect(() => assertJudgingTruthsCarried({ trustToken: NONCE }, '卷面里根本没有这串值')).toThrow(
      /trustToken/,
    );
  });

  test('装配路径同闸: 注入面加了一份真值、TRUTH_LINES 没补卷面写法 → createDefaultVerifier 当场抛', () => {
    // 这是真值随卷最可能的漂移形态 (加字段容易, 加卷面写法容易忘)。
    // 证伪: 闸缺失 → 这个 verifier 会被静默造出来, 新真值永远到不了判卷官手上, 而没有任何人会知道。
    expect(() =>
      createDefaultVerifier({
        verifierModel: 'fake:m',
        truths: { trustToken: NONCE, futureTruth: 'deadbeef' } as JudgingTruths,
      }),
    ).toThrow(/futureTruth/);
  });

  test('阴性对照: 真值真在卷面上 → 不抛 (闸不是"见真值就红")', () => {
    expect(() => assertJudgingTruthsCarried({ trustToken: NONCE }, `…[信任 token: ${NONCE}]…`)).not.toThrow();
    // 空真值 / 一份都不给 → 无事发生 (老调用方零回归)。
    expect(() => assertJudgingTruthsCarried({}, '')).not.toThrow();
    expect(() => assertJudgingTruthsCarried({ trustToken: '' }, '')).not.toThrow();
  });
});

describe('G-4 后半: 随卷 → 判词里逐字符比对可见', () => {
  test('真值逐字进了**模型真收到的 prompt** (不是只到辅助函数为止)', async () => {
    const [verifier, seen] = capturing({ trustToken: NONCE });
    await verifier({ task: 'G1 probe: 用一句话回答你正在执行什么', plan, results });
    expect(seen()).toContain(NONCE); // 逐字符比对的前提: 真值本身在卷面上
    expect(seen()).toContain('判卷真值');
    expect(seen()).toContain('逐字符');
  });

  test('卷面同时给出**来源锚** —— 判词里那句"任务文本里无对应来源"被直接答掉', () => {
    // 判例 4a609621 的保留意见逐字是「在我可见的任务文本里无对应来源, 无法核验」:
    // 光给值不够, 还得说清它为什么不在任务文本里 (harness 注入), 否则怀疑者照样可以判它可疑。
    const block = renderJudgingTruths({ trustToken: NONCE });
    expect(block).toContain('不出现在原始任务文本里是设计如此');
    expect(block).toContain('runNonce');
  });

  test('阴性对照 (INV-1): 一份真值都不给 → 卷面逐字节同旧, 无判卷真值段', async () => {
    const [withNone, seenNone] = capturing();
    const [withOne, seenOne] = capturing({ trustToken: NONCE });
    const req = { task: 'G1 probe: 用一句话回答你正在执行什么', plan, results };
    await withNone(req);
    await withOne(req);
    expect(seenNone()).not.toContain('判卷真值');
    // 不随卷时 token 在卷面上**只出现一次** —— 就是执行体那句自述, 判卷官只能信它 (判例的病灶本身);
    // 随卷后出现两次 (自述 + 注入面真值), 逐字符比对才有第二个操作数。
    expect(seenNone().split(NONCE).length - 1).toBe(1);
    expect(seenOne().split(NONCE).length - 1).toBe(2);
    // 两卷之差**只有**判卷真值那一段 (别顺手改了别的行)。
    expect(seenOne().replace(renderJudgingTruths({ trustToken: NONCE }), '')).toBe(seenNone());
  });
});

describe('1-A (2026-09-03): 按调用真值 (req.truths) 随卷', () => {
  test('★ criterionFreeze 逐字进模型真收到的 prompt, 带卷面写法; 装配期 truths 仍在', async () => {
    const [verifier, seen] = capturing({ trustToken: NONCE });
    await verifier({ task: 't', plan, results, truths: { criterionFreeze: '派发 #1 单独产出并冻结: tests/test_a.py (deadbeefdeadbeef, 判卷时未变)' } });
    expect(seen()).toContain('deadbeefdeadbeef');
    expect(seen()).toContain('判据文件冻结 (1-A');
    expect(seen()).toContain(NONCE);
  });
  test('阴性对照: 不传 req.truths → 卷面没有冻结段 (卷面同旧)', async () => {
    const [verifier, seen] = capturing();
    await verifier({ task: 't', plan, results });
    expect(seen()).not.toContain('判据文件冻结');
  });
});

describe('D-2 (2026-09-04): dispatchEvidence 真值随卷', () => {
  test('★ 含字面「这些是引擎记录的事实」 — 这是本节点的契约锚, 漏掉 verifier Prompt 判不出派发层事实', async () => {
    const [verifier, seen] = capturing();
    await verifier({ task: 't', plan, results, truths: { dispatchEvidence: '派发 #1 (work) — done 2/2 · filesTouched: A, B' } });
    expect(seen()).toContain('这些是引擎记录的事实');
    expect(seen()).toContain('派发 #1 (work)');
  });

  test('TRUTH_LINES 装配期闸: dispatchEvidence 没出现在 paper 上 → 抛, 点名 dispatchEvidence', () => {
    // 证伪: 把 TRUTH_LINES 里 dispatchEvidence 那行删掉 → 这条当场红 (闸的真值是「值必须上卷面」)。
    //       用一个**不会**出现在 paper 上的 sentinel 字符串喂进去 (paper 里只有判据冻结 + 老 trustToken)。
    expect(() => assertJudgingTruthsCarried({ dispatchEvidence: 'X-Y-Z-NEVER-IN-PAPER' }, '卷面无 X-Y-Z')).toThrow(/dispatchEvidence/);
  });

  test('阴性对照: 不传 dispatchEvidence → 卷面没有「派发子图引擎记录」段', async () => {
    const [verifier, seen] = capturing();
    await verifier({ task: 't', plan, results });
    expect(seen()).not.toContain('派发子图引擎记录');
    expect(seen()).not.toContain('这些是引擎记录的事实');
  });

  test('★ dispatchEvidence 与 criterionFreeze 共存 — 两份真值都进卷面, 互不吞', async () => {
    const [verifier, seen] = capturing();
    await verifier({
      task: 't',
      plan,
      results,
      truths: {
        criterionFreeze: '派发 #1 单独产出并冻结: tests/test_a.py (deadbeefdeadbeef, 判卷时未变)',
        dispatchEvidence: '派发 #1 (work) — done 2/2 · filesTouched: A, B',
      },
    });
    expect(seen()).toContain('deadbeefdeadbeef');
    expect(seen()).toContain('派发 #1 (work)');
    expect(seen()).toContain('这些是引擎记录的事实');
  });

  test('空串 dispatchEvidence 当作缺席 — renderJudgingTruths 不渲染, assertJudgingTruthsCarried 不判红', () => {
    // 锁住现状: renderJudgingTruths 用 `if (truths[k])` 短路 (空串 falsy), assertJudgingTruthsCarried
    // 过滤 `typeof v === "string" && v.length > 0`, 所以空串 = 没传 (老行为零回归)。
    expect(renderJudgingTruths({ dispatchEvidence: '' })).toBe('');
    expect(() => assertJudgingTruthsCarried({ dispatchEvidence: '' }, '')).not.toThrow();
  });
});
