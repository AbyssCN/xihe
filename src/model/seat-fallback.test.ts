/**
 * withPoolFallback —— 座位撞后端故障按池顺延一次。
 * 反向自检 (2026-09-11 写时实跑): 把 defaultFaulty 改成恒 true → 「配置错不顺延」红;
 * 把 pickFallbackCoord 的 `coord === current` 跳过删掉 → 「不会顺延到自己」红。
 */
import { describe, expect, test } from 'bun:test';
import { ModelError } from './index';
import { defaultFaulty, pickFallbackCoord, withPoolFallback } from './seat-fallback';

const POOL = ['agy-cli:claude-opus-4-6-thinking', 'opencode-go:qwen3.8-max', 'opencode-go:glm-5.2'];

describe('defaultFaulty', () => {
  test('ModelError http 429/402/503 = 故障; 401/400 = 不是', () => {
    expect(defaultFaulty(new ModelError('http', 'x', { status: 429 }))).toBe(true);
    expect(defaultFaulty(new ModelError('http', 'x', { status: 402 }))).toBe(true);
    expect(defaultFaulty(new ModelError('http', 'x', { status: 503 }))).toBe(true);
    expect(defaultFaulty(new ModelError('http', 'x', { status: 401 }))).toBe(false);
    expect(defaultFaulty(new ModelError('config', 'bad coord'))).toBe(false);
  });
  test('裸 Error: codex usage limit / claude session limit / 402 原文 = 故障; 普通错不是', () => {
    expect(defaultFaulty(new Error('pi: Codex error: The usage limit has been reached'))).toBe(true);
    expect(defaultFaulty(new Error("Claude Code returned an error result: You've hit your session limit"))).toBe(true);
    expect(defaultFaulty(new Error('402: {"code":"402","message":"Insufficient account balance"}'))).toBe(true);
    expect(defaultFaulty(new Error('verifier: verifierModel 必填'))).toBe(false);
  });
});

describe('pickFallbackCoord', () => {
  test('跳过自己与不可用的, 取第一个可用', () => {
    const usable = (c: string) => c !== 'agy-cli:claude-opus-4-6-thinking';
    expect(pickFallbackCoord('openai-codex:gpt-5.6-sol', POOL, usable)).toBe('opencode-go:qwen3.8-max');
  });
  test('不会顺延到自己', () => {
    expect(pickFallbackCoord('opencode-go:glm-5.2', ['opencode-go:glm-5.2'], () => true)).toBeUndefined();
  });
});

describe('withPoolFallback', () => {
  test('主座成功 → 不碰池', async () => {
    const calls: string[] = [];
    const r = await withPoolFallback('a:b', POOL, async (m) => { calls.push(m); return 'ok'; }, { usable: () => true });
    expect(r).toBe('ok');
    expect(calls).toEqual(['a:b']);
  });
  test('主座撞 429 → 顺延到池里第一个可用坐标, 只顺延一次', async () => {
    const calls: string[] = [];
    const r = await withPoolFallback(
      'openai-codex:gpt-5.6-sol',
      POOL,
      async (m) => {
        calls.push(m);
        if (m === 'openai-codex:gpt-5.6-sol') throw new ModelError('http', 'rate', { status: 429 });
        return `verdict@${m}`;
      },
      { usable: () => true },
    );
    expect(r).toBe('verdict@agy-cli:claude-opus-4-6-thinking');
    expect(calls).toEqual(['openai-codex:gpt-5.6-sol', 'agy-cli:claude-opus-4-6-thinking']);
  });
  test('配置错不顺延 (别吞真错误)', async () => {
    const calls: string[] = [];
    await expect(
      withPoolFallback('a:b', POOL, async (m) => { calls.push(m); throw new ModelError('config', 'typo'); }, { usable: () => true }),
    ).rejects.toThrow('typo');
    expect(calls).toEqual(['a:b']);
  });
  test('池里全不可用 → 原错照抛', async () => {
    await expect(
      withPoolFallback('a:b', POOL, async () => { throw new ModelError('http', 'x', { status: 429 }); }, { usable: () => false }),
    ).rejects.toThrow('x');
  });
});
