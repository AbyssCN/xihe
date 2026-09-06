/**
 * bench 桥的上游限流器 —— 令牌桶, 按 RPM 放行 (2026-09-06, owner: 「控制 rpm 在 120, 拉高容器并发」)。
 *
 * 为什么: MiniMax 透传没有任何限流, `fleet.ts` 实测 8 路零 429、16 路 3 分钟撞限 (2062)。要把并发从 8 提到 16
 * 又不撞限, 得在桥这一侧把出口速率钉住, 让 16 个容器排队等令牌, 而不是各自撞上游再退避。
 *
 * 纯逻辑, 零 IO: `acquire()` 返回一个在拿到令牌时 resolve 的 promise; 桶容量 = rpm (允许一分钟内的突发),
 * 补充速率 = rpm/60 每秒。`now` 与 `sleep` 可注入, 测试不真等。
 *
 * 证伪: 把 `refill` 那一行去掉 ⇒ bench-bridge-limiter.test.ts「耗尽后按速率补充」红。
 */
export interface RateLimiter {
  /** 拿一个令牌; 没有就等到有。返回等了多少毫秒 (读数)。 */
  acquire(): Promise<number>;
  /** 当前桶里的令牌数 (读数)。 */
  tokens(): number;
}

export function createRateLimiter(opts: {
  rpm: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): RateLimiter {
  const rpm = Math.max(1, Math.floor(opts.rpm));
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const perMs = rpm / 60_000;
  let bucket = rpm;
  let last = now();
  const refill = (): void => {
    const t = now();
    bucket = Math.min(rpm, bucket + (t - last) * perMs);
    last = t;
  };
  // 排队: 先来先得 —— 没有队列时并发 acquire 会一起看见同一个桶而超发。
  let chain: Promise<void> = Promise.resolve();
  return {
    tokens: () => {
      refill();
      return bucket;
    },
    acquire: () => {
      const start = now();
      const mine = chain.then(async () => {
        refill();
        if (bucket < 1) {
          const wait = Math.ceil((1 - bucket) / perMs);
          await sleep(wait);
          refill();
        }
        bucket -= 1;
      });
      chain = mine.catch(() => undefined);
      return mine.then(() => now() - start);
    },
  };
}
