/**
 * 判据三候选共识 —— 纯函数层的契约测试 (契约
 * `docs/plan/2026-09-05-判据三候选共识-执行契约-草案.md` 切片 1)。
 *
 * 这一层零 IO 零 LLM: 拿三份已经归一好的 {@link AcceptanceSpec}, 抽方向签名、量一致性、择一。
 * 盯的是契约的 INV-1 / INV-2 / INV-3 三条, 外加"签名抽得对不对"这一组 ——
 * 签名抽错的话, 上面那三条会在错的输入上全绿。
 */
import { describe, expect, test } from 'bun:test';
import {
  agreement,
  chooseCandidate,
  directionSignature,
  surveyHits,
  type DirectionSignature,
} from './criterion-consensus';
import type { AcceptanceSpec } from './classify-acceptance';

const EXISTING = new Set(['src/a.test.ts', 'tests/test_foo.py']);

const exec = (command: string): AcceptanceSpec => ({ kind: 'executable', command, expectExit: 0 });
const rubric = (...requirements: string[]): AcceptanceSpec => ({
  kind: 'rubric',
  checklist: {
    items: requirements.map((requirement, i) => ({ id: `r${i + 1}`, requirement })),
    contentHash: 'test-hash',
  },
});
const explore = (): AcceptanceSpec => ({ kind: 'exploratory', learningGoal: '学点东西', affordableLoss: '一轮' });

const cand = (spec: AcceptanceSpec, hits = 0, existing = EXISTING) => ({
  spec,
  sig: directionSignature(spec, existing),
  surveyHits: hits,
});

describe('方向签名 —— 判据到底指向哪儿 (D-2)', () => {
  test('执行型: 抽命令里的文件路径 + `::` 后的测试 id; 路径在仓里 ⇒ existing', () => {
    const sig = directionSignature(exec('bun test src/a.test.ts'), EXISTING);
    expect(sig.kind).toBe('executable');
    expect(sig.files).toEqual(['src/a.test.ts']);
    expect(sig.ids).toEqual([]);
    expect(sig.existing).toBe(true);

    const py = directionSignature(exec('pytest -q tests/test_foo.py::test_bar'), EXISTING);
    expect(py.files).toEqual(['tests/test_foo.py']);
    expect(py.ids).toEqual(['test_bar']);
    expect(py.existing).toBe(true);
  });

  test('执行型指幻觉路径 ⇒ existing=false (旗标本身就是 D-4 ② 的择优依据)', () => {
    const sig = directionSignature(exec('bun test src/nope.test.ts'), EXISTING);
    expect(sig.files).toEqual(['src/nope.test.ts']);
    expect(sig.existing).toBe(false);
  });

  test('执行型无路径 (整仓命令) ⇒ files 空且 existing=false —— 空不算"指向既有文件"', () => {
    const sig = directionSignature(exec('bun test'), EXISTING);
    expect(sig.files).toEqual([]);
    expect(sig.existing).toBe(false);
  });

  test('rubric: 逐条抽反引号标识符 / 引号键名 / 文件名, 全进 ids; files 空', () => {
    const sig = directionSignature(rubric('输出必须含 `mean_diff` 键', '结果写进 report.json'), EXISTING);
    expect(sig.kind).toBe('rubric');
    expect(sig.files).toEqual([]);
    expect(sig.ids).toContain('mean_diff');
    expect(sig.ids).toContain('report.json');
    expect(sig.existing).toBe(false);
  });

  test('探索型 ⇒ 空签名 (它本来就没有方向可比)', () => {
    const sig = directionSignature(explore(), EXISTING);
    expect(sig).toEqual({ kind: 'exploratory', files: [], ids: [], existing: false });
  });
});

describe('一致性 (D-3) —— 两两 Jaccard 的均值', () => {
  test('INV-1: 三份同执行型同文件 ⇒ agreement===1 且 ambiguous===false', () => {
    const cs = [cand(exec('bun test src/a.test.ts')), cand(exec('bun test src/a.test.ts')), cand(exec('bun test src/a.test.ts'))];
    const a = agreement(cs.map((c) => c.sig));
    expect(a.agreement).toBe(1);
    expect(a.kindAgreement).toBe(true);
    expect(chooseCandidate(cs).ambiguous).toBe(false);
  });

  test('部分重叠 ⇒ 严格落在 0 与 1 之间 (一个动不了的数量的是尺子)', () => {
    const sigs = [
      directionSignature(exec('bun test src/a.test.ts'), EXISTING),
      directionSignature(exec('bun test src/b.test.ts'), EXISTING),
    ];
    const a = agreement(sigs);
    expect(a.agreement).toBe(0); // 两个单元素集合无交集
    expect(a.kindAgreement).toBe(true);

    const half = agreement([
      { kind: 'executable', files: ['x', 'y'], ids: [], existing: false },
      { kind: 'executable', files: ['x'], ids: [], existing: false },
    ] satisfies DirectionSignature[]);
    expect(half.agreement).toBeCloseTo(0.5, 6);
  });

  test('分型不同 ⇒ kindAgreement=false; 候选不足两份 ⇒ 无对可比 (读侧靠 n 分辨)', () => {
    expect(agreement([directionSignature(exec('bun test'), EXISTING), directionSignature(explore(), EXISTING)]).kindAgreement).toBe(false);
    expect(agreement([directionSignature(explore(), EXISTING)])).toEqual({ agreement: 1, kindAgreement: true });
  });
});

describe('择优 (D-4 首版)', () => {
  test('INV-2: 两份执行型指同一既有文件 + 一份 rubric ⇒ 选执行型, kindAgreement=false, ambiguous=false', () => {
    const cs = [
      cand(exec('bun test src/a.test.ts')),
      cand(exec('bun test src/a.test.ts')),
      cand(rubric('要有 `foo`')),
    ];
    const r = chooseCandidate(cs);
    expect(cs[r.index]!.spec.kind).toBe('executable');
    expect(r.ambiguous).toBe(false);
    expect(agreement(cs.map((c) => c.sig)).kindAgreement).toBe(false);
  });

  test('INV-3: 三份分型互异 ⇒ ambiguous=true, 取执行型 (执行型 > rubric > 探索型)', () => {
    const cs = [cand(rubric('要有 `foo`')), cand(explore()), cand(exec('bun test src/a.test.ts'))];
    const r = chooseCandidate(cs);
    expect(r.ambiguous).toBe(true);
    expect(cs[r.index]!.spec.kind).toBe('executable');
  });

  test('② 多数派内优先"指向既有文件"的那份 (幻觉路径不该赢)', () => {
    const cs = [cand(exec('bun test src/nope.test.ts')), cand(exec('bun test src/a.test.ts')), cand(exec('bun test src/also-nope.test.ts'))];
    expect(chooseCandidate(cs).index).toBe(1);
  });

  test('③ 仍并列 ⇒ 取勘察命中最多的那份', () => {
    const cs = [cand(exec('bun test tests/test_foo.py'), 0), cand(exec('bun test tests/test_foo.py'), 3), cand(rubric('随便'))];
    expect(chooseCandidate(cs).index).toBe(1);
    expect(chooseCandidate(cs).why).toContain('勘察命中');
  });

  test('候选为空 ⇒ 响亮失败 (静默返 0 会让"没候选"冒充"选了第一份")', () => {
    expect(() => chooseCandidate([])).toThrow(/候选为空/);
  });
});

describe('勘察命中 —— 签名里的词有几个真在勘察段里出现过', () => {
  test('命中按签名 token 数, 不是出现次数; 勘察段为空 ⇒ 0', () => {
    const sig = directionSignature(exec('pytest -q tests/test_foo.py::test_bar'), EXISTING);
    expect(surveyHits(sig, 'tests/test_foo.py 里有 test_bar, test_bar 出现两次')).toBe(2);
    expect(surveyHits(sig, '')).toBe(0);
  });
});
