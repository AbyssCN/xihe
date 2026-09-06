/**
 * R4 生产端出题者的空旋钮闸 (2026-09-06)。
 *
 * 现场: code80-m3-author-cons 开着 `OMD_CRITERION_AUTHOR=cross`, 80/80 题日志「开关开着但没有出题者 (装配没接 generate)」,
 * 整臂量了个空 —— `productionCriterionAuthor` 只读 `config.dag.generate` (测试注入口, 生产从不设)。
 * 与 classify 那条 2026-07-30 的教训同型。这里钉死: **不注入 generate 也必须有出题者**。
 * 证伪: 把 run-goal.ts 里 `?? makeDefaultGenerate(...)` 去掉 ⇒ ★ 红。
 */
import { describe, expect, test } from 'bun:test';
import { productionCriterionAuthor } from './run-goal';
import type { RunGoalConfig } from './run-goal';

describe('productionCriterionAuthor', () => {
  test('★ 无注入 generate (生产形态) ⇒ 仍返回出题者, 不是 undefined', () => {
    const cfg = { cwd: '/tmp', dag: {} } as unknown as RunGoalConfig;
    expect(typeof productionCriterionAuthor(cfg)).toBe('function');
  });
  test('有注入 generate ⇒ 用注入的 (测试可控)', async () => {
    let seen: string | undefined;
    const cfg = {
      cwd: '/tmp',
      dag: { generate: async (req: { model: string }) => { seen = req.model; return { text: '{}', usage: { in: 1, out: 1 } }; } },
    } as unknown as RunGoalConfig;
    const author = productionCriterionAuthor(cfg)!;
    expect(typeof author).toBe('function');
    expect(seen).toBeUndefined(); // 只装配, 不调用
  });
});
