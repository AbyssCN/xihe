/**
 * goal-recall —— 按 goal 召回一次的形状钉。
 * 反向自检 (2026-09-11 写时实跑): goalRecallEnabled 改成恒 true → 「默认关」红; 删掉 namespace 过滤 → 「只收 omd.*」红;
 * 删掉 maxChars 预算 → 「预算截断」红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdMemory } from '../memory';
import { UNIVERSAL_SAFEGUARD } from '../../memory/safeguards/namespaces';
import { GOAL_RECALL_HEADER, buildGoalRecall, goalRecallEnabled, renderRecallLine } from './goal-recall';

const conf = (ev: string) => ({ level: 'agent_tentative' as const, source_event_ids: [ev], created_at: new Date() });

async function seeded() {
  const mem = createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD });
  await mem.writeFact({
    namespace: 'omd.pattern', scope: 'oracle', subject: 'verifier',
    situation: 'verifier 判 web 页面判据时只 grep 字符串', approach: '改用 web oracle 跑真浏览器断言 DOM', outcome: 'worked',
    source_event_id: 'run:r1', confidence: conf('run:r1'),
  });
  await mem.writeFact({
    namespace: 'omd.limit', kind: 'boundary', statement: 'minimax-cn:MiniMax-M3 在 1M 上下文时 prefill 超时',
    source_event_id: 'run:r2', confidence: conf('run:r2'),
  });
  await mem.writeFact({
    namespace: 'user.preference', category: 'lang', value: '中文回答',
    source_event_id: 'ev-3', confidence: conf('ev-3'),
  });
  return mem;
}

describe('goalRecallEnabled', () => {
  test('默认关; 只有 "1" 开', () => {
    expect(goalRecallEnabled({})).toBe(false);
    expect(goalRecallEnabled({ OMD_GOAL_RECALL: 'true' })).toBe(false);
    expect(goalRecallEnabled({ OMD_GOAL_RECALL: '1' })).toBe(true);
  });
});

describe('buildGoalRecall', () => {
  test('命中 → header + 每条一行; 只收 omd.pattern / omd.limit, user.* 不进', async () => {
    const mem = await seeded();
    const r = await buildGoalRecall('web 页面 verifier 判据 grep', '/nonexistent', { memory: mem, k: 10 });
    expect(r.text.startsWith(GOAL_RECALL_HEADER)).toBe(true);
    expect(r.text).toContain('[pattern oracle/verifier]');
    expect(r.text).toContain('(有效)');
    expect(r.text).not.toContain('中文回答');
    expect(r.facts.admitted).toBeGreaterThan(0);
    expect(r.facts.admitted).toBeLessThanOrEqual(r.facts.hits);
    expect(r.facts.chars).toBe(r.text.length);
    expect(r.facts.why).toBeUndefined();
  });
  test('预算截断: maxChars 很小 → admitted 0 且 why 说明', async () => {
    const mem = await seeded();
    const r = await buildGoalRecall('verifier', '/nonexistent', { memory: mem, maxChars: GOAL_RECALL_HEADER.length + 10 });
    expect(r.text).toBe('');
    expect(r.facts.admitted).toBe(0);
    expect(r.facts.why).toBeTruthy();
  });
  test('仓里没有 memory.db → 零命中, why 带路径 (fail-open 不吞证据)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-recall-'));
    try {
      const r = await buildGoalRecall('anything', root);
      expect(r.text).toBe('');
      expect(r.facts).toEqual({ k: 5, hits: 0, admitted: 0, chars: 0, why: `no-db: ${join(root, '.omd', 'memory.db')}` });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('renderRecallLine', () => {
  test('pattern 行带 scope/subject 与结局; limit 行带 kind; 其它 namespace → null', () => {
    const base = { id: 'x', text: '', rrf: 1 };
    expect(renderRecallLine({ ...base, fact: { namespace: 'omd.pattern', scope: 'seat', subject: 'm3', situation: 's', approach: 'a', outcome: 'failed', confidence: conf('e') } })).toBe('· [pattern seat/m3] s → a (失败)');
    expect(renderRecallLine({ ...base, fact: { namespace: 'omd.limit', kind: 'budget', statement: 'x', confidence: conf('e') } })).toBe('· [limit budget] x');
    expect(renderRecallLine({ ...base, fact: { namespace: 'user.goal', goal: 'g', confidence: conf('e') } })).toBeNull();
  });
});
