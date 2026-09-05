/**
 * D-4 批级有效性闸 (契约 `docs/plan/2026-09-05-假success三闸-执行契约.md` 切片 4) —— INV-7。
 *
 * 盘上事实 (2026-09-05 复算过): `~/repos/workbuddy-bench/results/omd-bridge-code80-oc` 那批
 * 80 题里 **39 题** 的 `agent/omd-output.txt` 命中「分类调用/解析失败」, 43 题命中
 * 「session limit」—— 全部退到探索型。该批的任何结论都无效, 而此前没有任何机械件说得出这句话。
 *
 * ## 证伪 (真跑过一次)
 * · 把阈值从 5% 改成 50% ⇒ ★39/80 那条红 (39/80 = 48.75%, 会被念成 VALID)。
 * · 把空集那一格改成 `files.length === 0 ? true : …` ⇒ 「空集不算有效」那条红
 *   (⚠ 单删 `files.length > 0 &&` 不会红: `0/0` 是 NaN, 比较恒 false —— 那条守卫写的是**意图**,
 *   不靠 NaN 的偶然正确性)。
 */
import { describe, expect, test } from 'bun:test';
import { countBatchFailures } from './bench-batch-validity';

const file = (name: string, text: string) => ({ name, text });
/** 造 n 份命中分类失败的题 + m 份干净题。 */
const batch = (failed: number, clean: number) => [
  ...Array.from({ length: failed }, (_, i) => file(`q-fail-${i}`, '[omd/goal] 分类调用/解析失败 → 全保守档 (complex + 探索型)')),
  ...Array.from({ length: clean }, (_, i) => file(`q-ok-${i}`, 'outcome: success\n冻结判据 ✅')),
];

describe('countBatchFailures — INV-7', () => {
  test('★ 39/80 分类失败 (code80-oc 实测) ⇒ INVALID', () => {
    const r = countBatchFailures(batch(39, 41));
    expect(r.total).toBe(80);
    expect(r.classifyFailed).toBe(39);
    expect(r.valid).toBe(false);
  });

  test('4/80 (= 5%, 不超阈值) ⇒ VALID —— 闸不许把偶发抖动整批作废', () => {
    const r = countBatchFailures(batch(4, 76));
    expect(r.classifyFailed).toBe(4);
    expect(r.valid).toBe(true);
  });

  test('0 文件 ⇒ INVALID (空集不算有效: 一题都没跑不等于这批没问题)', () => {
    const r = countBatchFailures([]);
    expect(r.total).toBe(0);
    expect(r.valid).toBe(false);
  });

  test('四个计数各数各的 (同一题命中两种标记时两边都记, 不合并成一个"坏了")', () => {
    const r = countBatchFailures([
      file('a', '分类调用/解析失败 · 502 session limit · 验收分型未成立'),
      file('b', 'HTTP 502 Bad Gateway'),
      file('c', 'outcome: success'),
    ]);
    expect(r.total).toBe(3);
    expect(r.classifyFailed).toBe(1);
    expect(r.sessionLimit).toBe(1);
    expect(r.http502).toBe(2);
    expect(r.acceptanceNotEstablished).toBe(1);
  });

  test('「验收分型未成立」也算分类失败 (它是同一次失败的另一句话)', () => {
    const r = countBatchFailures([
      ...Array.from({ length: 30 }, (_, i) => file(`x${i}`, '(验收分型未成立: 无分类器 (缺 generate/model))')),
      ...Array.from({ length: 50 }, (_, i) => file(`y${i}`, 'outcome: success')),
    ]);
    expect(r.classifyFailed).toBe(30);
    expect(r.valid).toBe(false);
  });
});
