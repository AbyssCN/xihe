/**
 * 共识候选取并集 —— 接线层的契约测试 (契约
 * `docs/plan/2026-09-06-共识并集验收-执行契约.md` 切片 2)。零 live 模型 (generate 全注入)。
 *
 * 这一层盯的不是「怎么拼」(那是 `criterion-union.test.ts` 的活), 是**开关与出口**:
 *  · INV-5 开关缺席 ⇒ 验收命令与共识择优选中的那份**逐字节相同**, 账本上没有 `union` 这一格;
 *  · 开着时并集真进了 `acceptance.command` (拼了却没用出去 = 白拼), 读数真进了账本;
 *  · 拼不成也留读数 (`applied: false` + `why`) —— 缺席与"拼不成"是两件事 (§静默坑 1)。
 *
 * 反向自检 (证伪方式):
 *  · `unionEnabled()` 那一行删掉 (恒真) ⇒ INV-5 两条红;
 *  · 并集算完不回写 `acceptance.command` ⇒ 「命令真被加宽」那条红;
 *  · 择优选中的那份不是执行型时也拼 ⇒ 「rubric 胜出 ⇒ 无 union 格」那条红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { classifyGoal } from './classify-acceptance';
import { clearRoleModel, setRoleModel } from '../../model/role-models';
import type { GenerateFn } from '../dag/types';

const CONSENSUS = 'OMD_CRITERION_CONSENSUS';
const UNION = 'OMD_CRITERION_UNION';
const CONDUCTOR = 'minimax-cn:mimo-v2.5-pro';

const execJson = (command: string): string => JSON.stringify({ tier: 'simple', acceptance_kind: 'executable', command });
const rubricJson = (id: string): string =>
  JSON.stringify({ tier: 'simple', acceptance_kind: 'rubric', checklist: [{ id, requirement: `产物里要有 \`${id}\`` }] });

/** 按调用顺序发不同的答卷 (与 `classify-consensus.test.ts` 同款, 那边的脚本不共享出来避免两边耦合)。 */
function scripted(answers: readonly string[]): GenerateFn {
  let i = 0;
  return async () => {
    const a = answers[Math.min(i, answers.length - 1)]!;
    i++;
    return { text: a, usage: { in: 1, out: 1 } };
  };
}

function setEnv(key: string, v: string | undefined): void {
  if (v === undefined) delete process.env[key];
  else process.env[key] = v;
}

afterEach(() => {
  setEnv(CONSENSUS, undefined);
  setEnv(UNION, undefined);
  clearRoleModel('verifier');
  clearRoleModel('escalation');
});

/** 三份候选: 前两份同一条命令 (多数派 ⇒ chosenIndex 0), 第三份指别的文件。 */
const THREE = (third: string): GenerateFn =>
  scripted([execJson('bun test src/a.test.ts'), execJson('bun test src/a.test.ts'), execJson(third)]);

describe('INV-5 开关缺席 ⇒ 验收命令与改前逐字节相同', () => {
  test('共识开、并集开关缺席 ⇒ 命令 = 择优那份原文, 账本无 union 格', async () => {
    setEnv(CONSENSUS, '1');
    setRoleModel('verifier', 'openai-codex:gpt-5.6-sol');
    const c = await classifyGoal('给 foo 加校验', { generate: THREE('bun test src/b.test.ts'), model: CONDUCTOR });

    expect(c.acceptance).toEqual({ kind: 'executable', command: 'bun test src/a.test.ts', expectExit: 0 });
    expect(c.criterionConsensus?.union).toBeUndefined();
  });

  test('并集开关是别的值 (0 / 空 / 拼错) 也一样不拼 —— 只认字面 "1"', async () => {
    setEnv(CONSENSUS, '1');
    setRoleModel('verifier', 'openai-codex:gpt-5.6-sol');
    for (const v of ['0', '', 'true', 'yes']) {
      setEnv(UNION, v);
      const c = await classifyGoal('给 foo 加校验', { generate: THREE('bun test src/b.test.ts'), model: CONDUCTOR });
      expect(c.acceptance).toEqual({ kind: 'executable', command: 'bun test src/a.test.ts', expectExit: 0 });
      expect(c.criterionConsensus?.union).toBeUndefined();
    }
  });

  test('并集开着但共识没开 ⇒ 单发那条路原样 (并集只活在共识里, 没有第二个入口)', async () => {
    setEnv(UNION, '1');
    const c = await classifyGoal('给 foo 加校验', { generate: THREE('bun test src/b.test.ts'), model: CONDUCTOR });
    expect(c.acceptance).toEqual({ kind: 'executable', command: 'bun test src/a.test.ts', expectExit: 0 });
    expect(c.criterionConsensus).toBeUndefined();
    expect(c.llmCalls).toBe(1);
  });
});

describe('D-1 并集真进了验收命令', () => {
  test('三份同 runner ⇒ 命令被加宽, 读数进账本', async () => {
    setEnv(CONSENSUS, '1');
    setEnv(UNION, '1');
    setRoleModel('verifier', 'openai-codex:gpt-5.6-sol');
    const c = await classifyGoal('给 foo 加校验', { generate: THREE('bun test src/b.test.ts'), model: CONDUCTOR });

    // 拼了却没用出去 = 白拼: 这里断的是 `acceptance.command` 本身, 不是账本里的字符串。
    expect(c.acceptance).toEqual({ kind: 'executable', command: 'bun test src/a.test.ts src/b.test.ts', expectExit: 0 });
    expect(c.criterionConsensus?.union).toEqual({ applied: true, paths: 2, dropped: 0, why: expect.stringContaining('并集') });
    // 并集不动共识自己那几格 —— 择优仍是择优 (D-5: 不改择优规则)。
    expect(c.criterionConsensus?.chosenIndex).toBe(0);
    expect(c.criterionConsensus?.n).toBe(3);
  });

  test('runner 不同 ⇒ 命令不动, 但读数留下 (applied:false + why, 不是整格缺席)', async () => {
    setEnv(CONSENSUS, '1');
    setEnv(UNION, '1');
    setRoleModel('verifier', 'openai-codex:gpt-5.6-sol');
    const c = await classifyGoal('给 foo 加校验', { generate: THREE('bunx tsc --noEmit -p tsconfig.json'), model: CONDUCTOR });

    expect(c.acceptance).toEqual({ kind: 'executable', command: 'bun test src/a.test.ts', expectExit: 0 });
    expect(c.criterionConsensus?.union?.applied).toBe(false);
    expect(c.criterionConsensus?.union?.why).toContain('runner');
  });

  test('rubric 胜出 ⇒ 无 union 格 (并集只对执行型有意义, 不是"拼了个空的")', async () => {
    setEnv(CONSENSUS, '1');
    setEnv(UNION, '1');
    setRoleModel('verifier', 'openai-codex:gpt-5.6-sol');
    const generate = scripted([rubricJson('mean_diff'), rubricJson('mean_diff'), execJson('bun test src/b.test.ts')]);
    const c = await classifyGoal('给 foo 加校验', { generate, model: CONDUCTOR });

    expect(c.acceptance.kind).toBe('rubric');
    expect(c.criterionConsensus?.union).toBeUndefined();
  });

  test('只拿到一份候选 (另两发挂) ⇒ 无别的候选可并, applied:false 且命令不动', async () => {
    setEnv(CONSENSUS, '1');
    setEnv(UNION, '1');
    setRoleModel('verifier', 'openai-codex:gpt-5.6-sol');
    let i = 0;
    const generate: GenerateFn = async () => {
      // 第一发成, 后两发挂 —— 缺席的候选不重试 (共识那一层的既有语义, 这里只是借它造单份场景)。
      if (i++ > 0) throw new Error('注入的分类调用失败');
      return { text: execJson('bun test src/a.test.ts'), usage: { in: 1, out: 1 } };
    };
    const c = await classifyGoal('给 foo 加校验', { generate, model: CONDUCTOR });

    expect(c.criterionConsensus?.n).toBe(1);
    expect(c.acceptance).toEqual({ kind: 'executable', command: 'bun test src/a.test.ts', expectExit: 0 });
    expect(c.criterionConsensus?.union?.applied).toBe(false);
  });
});
