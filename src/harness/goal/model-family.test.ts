/**
 * `familyOf` —— 模型家族按模型 id 认, 不按 provider 前缀 (2026-09-06)。
 *
 * 为什么有这个文件: code80-m3-consensus 批 79/79 题 `crossFamily=false`, 三候选里的异族座一份都没采到。
 * bench 把所有模型挂在同一个 `bench:` provider 下, 按前缀比 `bench:MiniMax-M3` 与 `bench:claude-opus-5` 就是"同族"。
 * 证伪: 把 `familyOf` 改回 `coord.split(':')[0]`, 下面 bench 那组全红。
 */
import { describe, expect, test } from 'bun:test';
import { familyOf } from './classify-acceptance';

describe('familyOf: 模型家族按 id 认', () => {
  test('bench 前缀下四个不同家族各自认得出', () => {
    expect(familyOf('bench:MiniMax-M3')).toBe('minimax');
    expect(familyOf('bench:claude-opus-5')).toBe('anthropic');
    expect(familyOf('bench:deepseek-v4-flash')).toBe('deepseek');
    expect(familyOf('bench:gpt-5.6-sol')).toBe('openai');
    expect(familyOf('bench:MiniMax-M3')).not.toBe(familyOf('bench:claude-opus-5'));
  });

  test('真 provider 坐标与 bench 坐标同一模型 ⇒ 同族', () => {
    expect(familyOf('claude-code:claude-opus-5')).toBe(familyOf('bench:claude-opus-5'));
    expect(familyOf('minimax-cn:MiniMax-M3')).toBe(familyOf('bench:MiniMax-M3'));
    expect(familyOf('openai-codex:gpt-5.6-sol')).toBe(familyOf('bench:gpt-5.6-sol'));
  });

  test('id 认不出 ⇒ 退回 provider 前缀 (faux 测试座位仍按前缀分族)', () => {
    expect(familyOf('faux:conductor')).toBe('faux');
    expect(familyOf('faux:verifier')).toBe('faux');
    expect(familyOf('nocolon')).toBe('nocolon');
  });

  test('mimo 与 MiniMax 不是一家 (小米 vs MiniMax), 既有共识用例的同族夹具 (mimo-air / mimo-pro) 仍同族', () => {
    expect(familyOf('minimax-cn:mimo-v2.5-pro')).toBe('xiaomi');
    expect(familyOf('minimax-cn:mimo-v2.5-air')).toBe('xiaomi');
    expect(familyOf('minimax-cn:MiniMax-M2.7')).toBe('minimax');
  });
});
