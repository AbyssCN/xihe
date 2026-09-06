/**
 * MiniMax M3 三档 thinking 映射 (2026-09-06)。
 * 2026-09-06 曾按控制台截图加了 high/xhigh→enabled 一档; 2026-09-07 直打原生端点实测 **API 拒 `enabled`**
 * (`base_resp 2013 … allowed: adaptive, disabled`), 于是撤回: off 之外一律 adaptive。
 * 证伪: 把 high 翻回 'enabled' ⇒ ★ 红。
 */
import { describe, expect, test } from 'bun:test';
import { isMinimaxModel, thinkingTypeFor } from './minimax-native';

describe('isMinimaxModel: 按 provider 或模型 id 认', () => {
  test('★ bench: 坐标也认 (author2-enabled 臂没测到的根因)', () => {
    expect(isMinimaxModel('bench', 'MiniMax-M3')).toBe(true);
    expect(isMinimaxModel('bench', 'claude-opus-5')).toBe(false);
  });
  test('真 provider 照认; 无关 provider + 无关 id 不认', () => {
    expect(isMinimaxModel('minimax-cn', 'MiniMax-M3')).toBe(true);
    expect(isMinimaxModel('openai-codex', 'gpt-5.6-sol')).toBe(false);
    expect(isMinimaxModel(undefined, undefined)).toBe(false);
  });
});

describe('thinkingTypeFor: MiniMax 只有两档 (API 实测拒 enabled)', () => {
  test('★ high / xhigh → adaptive (enabled 在原生端点上不存在, 发了整发被拒)', () => {
    expect(thinkingTypeFor('high')).toBe('adaptive');
    expect(thinkingTypeFor('xhigh')).toBe('adaptive');
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
