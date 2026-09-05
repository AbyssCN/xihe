/**
 * W4 勘察步预算 —— 纯谓词两侧钉死 (契约 `docs/plan/2026-09-06-墙钟与读次数-执行契约.md` INV-6)。
 *
 * 背景 (code80-boundary 80 题读数): conductor 节点中位 14 次 LLM 调用 / 均 24.8 个工具步,
 * 其中 66% 是 bash、bash 里 61% 是只读勘察 (grep/ls/cat/sed/find/git), 而真正派活的只有 1 到 3 步。
 * 引擎已经把仓内事实机械算好塞进它的面 (W1 勘察包), 却拦不住它再读一遍 —— 这一条是**边界**
 * (读了 N 步还没派活就提醒一次), 不是做法 (读什么、怎么读仍然全由模型定, 且**不拒任何调用**)。
 *
 * **实测局限 (诚实)**: 注入点 `pendingGrindAdvice` 在 `agent-leaf.ts` 的闭包里, 真走完要
 * 真实 `tool_execution_start` 事件流驱动。同 `agent-leaf-watchdog-s3.test.ts` /
 * `agent-leaf-spin-route.test.ts` 的先例: 本文件只钉谓词层 + 文案, 不强驱真循环。
 *
 * 证伪 (每条要能真红): 把 `s.dispatches === 0` 删掉 ⇒ 「已派过活不再提醒」红;
 * 把 `!s.fired` 删掉 ⇒ 「只注一次」红; 把 `s.hasCards` 删掉 ⇒ 「不持卡的节点恒不触发」红;
 * 把 `>=` 写成 `>` ⇒ 「恰好到阈值即触发」红; 环境变量不解析 ⇒ 「OMD_SURVEY_STEPS 改阈值」红。
 */
import { describe, expect, test } from 'bun:test';
import { SURVEY_STEPS_BEFORE_DISPATCH, surveyBudgetInstruction, surveyBudgetSteps, surveyBudgetHit } from './agent-leaf';

const base = {
  hasCards: true,
  readonlySteps: SURVEY_STEPS_BEFORE_DISPATCH,
  dispatches: 0,
  filesTouchedCount: 0,
  fired: false,
};

describe('surveyBudgetHit (W4): 持卡节点连读 N 步零派活 → 提醒一次', () => {
  test('★ 五条件齐备 → 触发 (恰好等于阈值即算, 与 produce-by 的严格大于不同: 这里数的是步不是墙钟)', () => {
    expect(surveyBudgetHit(base)).toBe(true);
    expect(surveyBudgetHit({ ...base, readonlySteps: SURVEY_STEPS_BEFORE_DISPATCH + 5 })).toBe(true);
  });

  test('不持卡的节点恒不触发 (work 子节点该读多久读多久, 这条只管 conductor)', () => {
    expect(surveyBudgetHit({ ...base, hasCards: false })).toBe(false);
  });

  test('还没读够步数不触发 (勘察本身是正当工作)', () => {
    expect(surveyBudgetHit({ ...base, readonlySteps: SURVEY_STEPS_BEFORE_DISPATCH - 1 })).toBe(false);
  });

  test('已派过活不触发 (它已经在派活了, 提醒是噪声)', () => {
    expect(surveyBudgetHit({ ...base, dispatches: 1 })).toBe(false);
  });

  test('已写过文件不触发 (它在产出, 不是空手勘察)', () => {
    expect(surveyBudgetHit({ ...base, filesTouchedCount: 1 })).toBe(false);
  });

  test('★ 已触发过不再触发 (整个节点只注一次)', () => {
    expect(surveyBudgetHit({ ...base, fired: true })).toBe(false);
  });

  test('阈值可用第二参覆盖 (调用方自己解析环境变量, 谓词不读全局)', () => {
    expect(surveyBudgetHit({ ...base, readonlySteps: 3 }, 3)).toBe(true);
    expect(surveyBudgetHit({ ...base, readonlySteps: 3 }, 4)).toBe(false);
  });
});

describe('surveyBudgetSteps: 阈值解析', () => {
  test('缺席 → 默认 10', () => {
    expect(surveyBudgetSteps({})).toBe(SURVEY_STEPS_BEFORE_DISPATCH);
    expect(SURVEY_STEPS_BEFORE_DISPATCH).toBe(10);
  });

  test('OMD_SURVEY_STEPS 改阈值 (正整数才认)', () => {
    expect(surveyBudgetSteps({ OMD_SURVEY_STEPS: '3' })).toBe(3);
  });

  test('非法值退回默认 (0 / 负数 / 非数字都不是"关掉", 关掉要显式改代码)', () => {
    for (const v of ['0', '-1', 'abc', '']) expect(surveyBudgetSteps({ OMD_SURVEY_STEPS: v })).toBe(SURVEY_STEPS_BEFORE_DISPATCH);
  });
});

describe('surveyBudgetInstruction: 提醒文案', () => {
  test('★ 带前缀 [survey-budget] + 步数 + 两条出路 (派活 / 说清还缺哪条事实)', () => {
    const msg = surveyBudgetInstruction(12);
    expect(msg).toContain('[survey-budget]');
    expect(msg).toContain('12');
    expect(msg).toContain('work()');
    expect(msg).toContain('还缺哪一条事实');
  });
});
