import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProvider } from '../../model/providers';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { AgentLeafInput, AgentLeafResult } from '../leaf-runners';
import { fingerprintOf } from '../profiles/review-ledger';
import { runGoal, type RunGoalConfig } from './run-goal';

const screenshotCommand = './.omd/screenshot.sh';

function executeResult(): ExecutorDagResult {
  return {
    plan: { name: 'goal-orchestrating-loop', nodes: {} },
    results: {
      conductor: {
        id: 'conductor', status: 'done', kind: 'agent', output: 'done', deps: [],
        usage: { in: 1, out: 1 },  
      },
      accept: {
        id: 'accept', status: 'done', kind: 'command', output: '', deps: ['conductor'], usage: { in: 0, out: 0 },
      },
    },
  } as unknown as ExecutorDagResult;
}

function config(
  agentRunner: ((input: AgentLeafInput) => Promise<AgentLeafResult>) | undefined,
  designReview: NonNullable<RunGoalConfig['designReview']>,
): RunGoalConfig {
  return {
    cwd: mkdtempSync(join(tmpdir(), 'omd-goal-review-wiring-')),
    dag: {
      conductorModel: 'test:conductor',
      leafModel: 'test:leaf',
      agentLeafModel: 'test:agent',
      ...(agentRunner ? { agentRunner } : {}),
    } as ExecutorDagConfig,
    tier: 'simple',
    acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
    _classify: async () => ({ tier: 'simple', acceptance: { kind: 'executable', command: 'true', expectExit: 0 } }),
    _runDag: async () => executeResult(),
    writeSet: { _collectChangedFiles: () => ['src/App.tsx'] },
    designReview,
  };
}

const jsonFinding = (severity: 'p0' | 'p1' | 'p2', evidence: string): string => JSON.stringify({
  findings: [{
    where: 'src/App.tsx#hero',
    severity,
    evidence,
    suggestion: 'align to grid',
    uncertainty: 'screenshot covers desktop only',
  }],
});

describe('runGoal production designReview 装配', () => {
  test('无 screenshotCommand → 严格走 diff-only, 不调用 agentRunner', async () => {
    let calls = 0;
    const result = await runGoal('review ui', config(async () => {
      calls++;
      return { text: jsonFinding('p2', 'should not run'), usage: { in: 1, out: 1 } };
    }, {}));

    expect(calls).toBe(0);
    expect(result.designReview?.scheduled).toBe(true);
    expect(result.designReview?.findings).toHaveLength(1);
    expect(result.designReview?.findings[0]?.evidence).toContain('diff-only 文本审');
    expect(result.designReview?.usage).toEqual({ in: 0, out: 0 });
  });

  test('有 screenshotCommand → profile agent 走截图路径, 命令与 profile 均到调用期输入', async () => {
    const seen: AgentLeafInput[] = [];
    const result = await runGoal('review ui', config(async (input) => {
      seen.push(input);
      return { text: jsonFinding('p2', 'hero pixels are off-grid'), usage: { in: 12, out: 4 } };
    }, { screenshotCommand }));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toContain(`截图命令(逐字执行): ${screenshotCommand}`);
    expect(seen[0]?.prompt).toContain('审查真实截图像素');
    expect(seen[0]?.profile?.name).toBe('design-review');
    // 内置 design-review 不钉座 (2026-09-11) → 模型来自座位链的 agent 座, 不再来自 profile.seat。
    expect(seen[0]?.profile?.seat).toBeUndefined();
    expect(seen[0]?.model).toBe('test:agent');
    expect(result.designReview?.findings[0]?.evidence).toBe('hero pixels are off-grid');
    expect(result.designReview?.usage).toEqual({ in: 12, out: 4 });
  });

  test('初审 P0/P1 + provider 已登记 → 才调用 escalationSeat 复审', async () => {
    registerProvider('dr-escalation', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });
    const models: string[] = [];
    const prompts: string[] = [];
    const result = await runGoal('review ui', config(async (input) => {
      models.push(input.model);
      prompts.push(input.prompt);
      return {
        text: jsonFinding('p1', models.length === 1 ? 'initial contrast failure' : 'confirmed contrast failure'),
        usage: { in: 10, out: 3 },
      };
    }, { screenshotCommand, escalationSeat: 'dr-escalation:strong' }));

    expect(models).toHaveLength(2);
    expect(models[1]).toBe('dr-escalation:strong');
    expect(prompts[1]).toContain('初审 P0/P1');
    expect(result.designReview?.usage).toEqual({ in: 20, out: 6 });
    expect(result.designReview?.escalated).toHaveLength(1);
    expect(result.designReview?.escalated[0]?.severity).toBe('p1');
  });

  test('初审只有 P2 → 即使 escalationSeat 有效也不调用升档座', async () => {
    registerProvider('dr-p2-escalation', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });
    const models: string[] = [];
    const result = await runGoal('review ui', config(async (input) => {
      models.push(input.model);
      return { text: jsonFinding('p2', 'minor spacing'), usage: { in: 5, out: 2 } };
    }, { screenshotCommand, escalationSeat: 'dr-p2-escalation:strong' }));

    expect(models).toHaveLength(1);
    expect(result.designReview?.escalated).toEqual([]);
  });

  test('初审 P1 但 escalationSeat provider 未登记 → 不调用、不冒充 escalated', async () => {
    const models: string[] = [];
    const result = await runGoal('review ui', config(async (input) => {
      models.push(input.model);
      return { text: jsonFinding('p1', 'contrast failure'), usage: { in: 5, out: 2 } };
    }, { screenshotCommand, escalationSeat: 'unregistered-review-provider:strong' }));

    expect(models).toHaveLength(1);
    expect(result.designReview?.escalated).toEqual([]);
  });

  test('有 screenshotCommand 但生产 agentRunner 缺席 → 响亮留证后 advisory 收尾, 不冒充 diff-only', async () => {
    const result = await runGoal('review ui', config(undefined, { screenshotCommand }));

    expect(result.converged).toBe(true);
    expect(result.designReview?.scheduled).toBe(true);
    expect(result.designReview?.findings).toEqual([]);
    expect(result.designReview?.usage).toEqual({ in: 0, out: 0 });
  });

  test('显式 _runReview 压过生产 screenshot runner', async () => {
    let agentCalls = 0;
    let injectedCalls = 0;
    const result = await runGoal('review ui', config(async () => {
      agentCalls++;
      throw new Error('production runner should not run');
    }, {
      screenshotCommand,
      _runReview: async () => {
        injectedCalls++;
        return {
          findings: [{
            where: 'src/App.tsx#injected', severity: 'p2', evidence: 'injected evidence',
            suggestion: 'keep seam injectable', uncertainty: 'none',
            fingerprint: fingerprintOf('src/App.tsx#injected', 'injected evidence'),
          }],
          usage: { in: 2, out: 1 },
        };
      },
    }));

    expect(agentCalls).toBe(0);
    expect(injectedCalls).toBe(1);
    expect(result.designReview?.findings[0]?.evidence).toBe('injected evidence');
  });
});
