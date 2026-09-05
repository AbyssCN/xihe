/**
 * 判据三候选共识 —— 接线层的契约测试 (契约
 * `docs/plan/2026-09-05-判据三候选共识-执行契约-草案.md` 切片 2)。零 live 模型 (generate 全注入)。
 *
 * 这一层盯的不是「选得对不对」(那是 `criterion-consensus.test.ts` 的活), 是**开关与采样面**:
 *  · 开关缺席时这次改动**一个字节都不发生** (INV-4) —— 加尺子不许动老读数的底线;
 *  · 开着时恰好三份候选 (conductor 两发 + 异族座一发), 一发挂了那份缺席且**不重试**;
 *  · 异族座与 conductor 同 provider ⇒ 只采两份并把 `crossFamily=false` 记下来 (不是静默凑数)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { classifyGoal, classifyPrompt } from './classify-acceptance';
import { clearRoleModel, setRoleModel } from '../../model/role-models';
import type { GenerateFn } from '../dag/types';

const SWITCH = 'OMD_CRITERION_CONSENSUS';
const CONDUCTOR = 'minimax-cn:mimo-v2.5-pro';

const execJson = (command: string): string => JSON.stringify({ tier: 'simple', acceptance_kind: 'executable', command });
const rubricJson = (id: string): string =>
  JSON.stringify({ tier: 'simple', acceptance_kind: 'rubric', checklist: [{ id, requirement: `产物里要有 \`${id}\`` }] });

/** 按调用顺序发不同的答卷; `null` = 那一发抛错 (候选缺席)。同时记下每一发的 prompt 与 model。 */
function scripted(answers: readonly (string | null)[]): {
  generate: GenerateFn;
  calls: { prompt: string; model: string }[];
} {
  const calls: { prompt: string; model: string }[] = [];
  const generate: GenerateFn = async (req) => {
    const i = calls.length;
    calls.push({ prompt: String(req.messages[0]?.content ?? ''), model: req.model });
    // ⚠ 这里不许用 `??`: 脚本里的 `null` 是**显式的"这一发挂"**, 被 `??` 兜掉就成了成功那一发。
    const a = i < answers.length ? answers[i] : answers[answers.length - 1];
    if (a === null || a === undefined) throw new Error(`注入的分类调用失败 #${i}`);
    return { text: a, usage: { in: 1, out: 1 } };
  };
  return { generate, calls };
}

function withSwitch(v: string | undefined): void {
  if (v === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = v;
}

afterEach(() => {
  withSwitch(undefined);
  clearRoleModel('verifier');
  clearRoleModel('escalation');
});

describe('INV-4 开关缺席 ⇒ 这次改动一个字节都不发生', () => {
  test('分类恰一发, prompt 与 classifyPrompt 逐字相同, ledger 无 criterionConsensus', async () => {
    const { generate, calls } = scripted([execJson('bun test src/a.test.ts')]);
    const c = await classifyGoal('给 foo 加校验', { generate, model: CONDUCTOR });
    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt).toBe(classifyPrompt('给 foo 加校验'));
    expect(calls[0]!.model).toBe(CONDUCTOR);
    expect(c.criterionConsensus).toBeUndefined();
    expect(c.llmCalls).toBe(1);
  });

  test('开关是别的值 (0 / 空 / 拼错) 也一样只发一发 —— 只认字面 "1"', async () => {
    for (const v of ['0', '', 'true', 'yes']) {
      withSwitch(v);
      const { generate, calls } = scripted([execJson('bun test src/a.test.ts')]);
      await classifyGoal('给 foo 加校验', { generate, model: CONDUCTOR });
      expect(calls.length).toBe(1);
    }
  });
});

describe('D-1 采样面 —— conductor 两发 + 异族座一发', () => {
  test('开关开 ⇒ 三份候选, 第三发换异族座, 一致性读数在场', async () => {
    withSwitch('1');
    setRoleModel('verifier', 'openai-codex:gpt-5.6-sol');
    const { generate, calls } = scripted([
      execJson('bun test src/a.test.ts'),
      execJson('bun test src/a.test.ts'),
      execJson('bun test src/a.test.ts'),
    ]);
    const c = await classifyGoal('给 foo 加校验', { generate, model: CONDUCTOR });

    expect(calls.length).toBe(3);
    expect(calls.map((x) => x.model)).toEqual([CONDUCTOR, CONDUCTOR, 'openai-codex:gpt-5.6-sol']);
    // 三发问的是同一份 prompt (D-1: 采样面变的是座位与温度, 不是题面)。
    expect(new Set(calls.map((x) => x.prompt)).size).toBe(1);
    expect(calls[0]!.prompt).toBe(classifyPrompt('给 foo 加校验'));

    expect(c.criterionConsensus).toEqual({
      n: 3,
      crossFamily: true,
      kindAgreement: true,
      agreement: 1,
      ambiguous: false,
      chosenIndex: 0,
      kinds: ['executable', 'executable', 'executable'],
    });
    expect(c.llmCalls).toBe(3);
  });

  test('异族座两个都与 conductor 同 provider ⇒ 只采两份且 crossFamily=false (不静默凑第三份)', async () => {
    withSwitch('1');
    setRoleModel('verifier', 'minimax-cn:mimo-v2.5-air');
    setRoleModel('escalation', 'minimax-cn:mimo-v2.5-pro');
    const { generate, calls } = scripted([execJson('bun test src/a.test.ts'), execJson('bun test src/b.test.ts')]);
    const c = await classifyGoal('给 foo 加校验', { generate, model: CONDUCTOR });

    expect(calls.length).toBe(2);
    expect(c.criterionConsensus?.n).toBe(2);
    expect(c.criterionConsensus?.crossFamily).toBe(false);
    // 两条命令指不同文件 ⇒ 一致性必须真掉下来 (恒 1 的读数量的是尺子)。
    expect(c.criterionConsensus?.agreement).toBe(0);
  });

  test('verifier 座同族但 escalation 异族 ⇒ 退到 escalation 座, crossFamily=true', async () => {
    withSwitch('1');
    setRoleModel('verifier', 'minimax-cn:mimo-v2.5-air');
    setRoleModel('escalation', 'openai-codex:gpt-5.6-sol');
    const { generate, calls } = scripted([execJson('bun test src/a.test.ts')]);
    const c = await classifyGoal('给 foo 加校验', { generate, model: CONDUCTOR });

    expect(calls.map((x) => x.model)).toEqual([CONDUCTOR, CONDUCTOR, 'openai-codex:gpt-5.6-sol']);
    expect(c.criterionConsensus?.crossFamily).toBe(true);
  });

  test('bench 同 provider 前缀但模型异族 (bench:MiniMax-M3 vs bench:claude-opus-5) ⇒ 异族成立 —— 按前缀判则本用例红 (code80-m3-consensus 实测 79/79 crossFamily=false)', async () => {
    withSwitch('1');
    setRoleModel('verifier', 'bench:claude-opus-5');
    setRoleModel('escalation', 'bench:MiniMax-M3');
    const { generate, calls } = scripted([execJson('bun test src/a.test.ts')]);
    const c = await classifyGoal('给 foo 加校验', { generate, model: 'bench:MiniMax-M3' });

    expect(calls.map((x) => x.model)).toEqual(['bench:MiniMax-M3', 'bench:MiniMax-M3', 'bench:claude-opus-5']);
    expect(c.criterionConsensus?.crossFamily).toBe(true);
  });

  test('一发挂了 ⇒ 该候选缺席且**不重试** (总调用数仍是 3, n=2)', async () => {
    withSwitch('1');
    setRoleModel('verifier', 'openai-codex:gpt-5.6-sol');
    const { generate, calls } = scripted([execJson('bun test src/a.test.ts'), null, execJson('bun test src/a.test.ts')]);
    const c = await classifyGoal('给 foo 加校验', { generate, model: CONDUCTOR });

    expect(calls.length).toBe(3);
    expect(c.criterionConsensus?.n).toBe(2);
    expect(c.criterionConsensus?.kinds).toEqual(['executable', 'executable']);
    expect(c.acceptance.kind).toBe('executable');
  });

  test('三发全挂 ⇒ 回落到关关时的那条路 (保守档), 不留半份共识读数', async () => {
    withSwitch('1');
    setRoleModel('verifier', 'openai-codex:gpt-5.6-sol');
    const { generate } = scripted([null]);
    const c = await classifyGoal('给 foo 加校验', { generate, model: CONDUCTOR });
    expect(c.acceptance.kind).toBe('exploratory');
    expect(c.criterionConsensus).toBeUndefined();
  });

  test('分型分歧 ⇒ 择优结果**真被采用** (多数派执行型胜过第一份 rubric)', async () => {
    withSwitch('1');
    setRoleModel('verifier', 'openai-codex:gpt-5.6-sol');
    const { generate } = scripted([rubricJson('mean_diff'), execJson('bun test src/a.test.ts'), execJson('bun test src/a.test.ts')]);
    const c = await classifyGoal('给 foo 加校验', { generate, model: CONDUCTOR });

    expect(c.acceptance).toEqual({ kind: 'executable', command: 'bun test src/a.test.ts', expectExit: 0 });
    expect(c.criterionConsensus?.chosenIndex).toBe(1);
    expect(c.criterionConsensus?.kindAgreement).toBe(false);
    expect(c.criterionConsensus?.ambiguous).toBe(false);
  });
});
