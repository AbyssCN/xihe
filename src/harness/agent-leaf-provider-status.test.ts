/**
 * providerErrorStatus —— pi 循环错误原文 → HTTP 状态码 (冷却轴的输入)。
 * 反向自检: 让实现恒返 undefined → 「402 余额不足」用例红。
 */
import { describe, expect, test } from 'bun:test';
import { providerErrorStatus } from './agent-leaf';

describe('providerErrorStatus', () => {
  test('402 余额不足 (run 1c6b8a69 原文)', () => {
    expect(providerErrorStatus('402: {"code":"402","message":"Insufficient account balance","type":"insufficient_balance"}')).toBe(402);
  });
  test('pi 前缀 + 429', () => {
    expect(providerErrorStatus('pi: 429: rate limited')).toBe(429);
  });
  test('HTTP 503 形态', () => {
    expect(providerErrorStatus('HTTP 503: upstream unavailable')).toBe(503);
  });
  test('无状态码 → undefined (不猜)', () => {
    expect(providerErrorStatus('Unable to connect')).toBeUndefined();
    expect(providerErrorStatus(undefined)).toBeUndefined();
  });
  test('正文里的数字不算状态码', () => {
    expect(providerErrorStatus('model returned 1234 tokens then died')).toBeUndefined();
  });
});
