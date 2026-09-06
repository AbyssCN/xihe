/**
 * MiniMax M3 三档 thinking 映射 (2026-09-06)。
 * 现场: 引擎此前只翻两档 (off→disabled, 其余→adaptive), `OMD_AGENT_EFFORT=high` 对 M3 等于没动,
 * code80-m3-author-effort 臂白跑。证伪: 把 `enabled` 那支去掉 ⇒ ★ 红。
 */
import { describe, expect, test } from 'bun:test';
import { thinkingTypeFor } from './minimax-native';

describe('thinkingTypeFor: MiniMax 三档', () => {
  test('★ high / xhigh → enabled (始终推理)', () => {
    expect(thinkingTypeFor('high')).toBe('enabled');
    expect(thinkingTypeFor('xhigh')).toBe('enabled');
  });
  test('off → disabled', () => {
    expect(thinkingTypeFor('off')).toBe('disabled');
  });
  test('缺席 / low / medium → adaptive (老行为不变)', () => {
    expect(thinkingTypeFor(undefined)).toBe('adaptive');
    expect(thinkingTypeFor('low')).toBe('adaptive');
    expect(thinkingTypeFor('medium')).toBe('adaptive');
  });
});
