/**
 * 桥限流器 (令牌桶) —— 注入时钟, 不真等。证伪: 去掉 refill ⇒ ★ 红。
 */
import { describe, expect, test } from 'bun:test';
import { createRateLimiter } from './bench-bridge-limiter';

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}

describe('createRateLimiter', () => {
  test('桶满时前 rpm 次不等', async () => {
    const c = clock(); const l = createRateLimiter({ rpm: 5, now: c.now, sleep: c.sleep });
    const waits = [];
    for (let i = 0; i < 5; i++) waits.push(await l.acquire());
    expect(waits).toEqual([0, 0, 0, 0, 0]);
    expect(l.tokens()).toBeCloseTo(0, 5);
  });
  test('★ 耗尽后按速率补充: rpm=60 ⇒ 第 61 次等 ~1000ms', async () => {
    const c = clock(); const l = createRateLimiter({ rpm: 60, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 60; i++) await l.acquire();
    const w = await l.acquire();
    expect(w).toBeGreaterThanOrEqual(999);
    expect(w).toBeLessThanOrEqual(1001);
  });
  test('时间流逝会回填, 不超过容量', async () => {
    const c = clock(); const l = createRateLimiter({ rpm: 120, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 120; i++) await l.acquire();
    c.advance(30_000);
    expect(l.tokens()).toBeCloseTo(60, 3);
    c.advance(600_000);
    expect(l.tokens()).toBe(120);
  });
  test('并发 acquire 串行排队, 不超发', async () => {
    const c = clock(); const l = createRateLimiter({ rpm: 2, now: c.now, sleep: c.sleep });
    const ws = await Promise.all([l.acquire(), l.acquire(), l.acquire(), l.acquire()]);
    // 前两个 0 等, 第 3 个等 30s, 第 4 个再等 30s (累计 60s)
    expect(ws[0]).toBe(0); expect(ws[1]).toBe(0);
    expect(ws[2]).toBeGreaterThanOrEqual(29_000);
    expect(ws[3]).toBeGreaterThanOrEqual(59_000);
  });
});
