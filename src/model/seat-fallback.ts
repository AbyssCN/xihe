/**
 * src/model/seat-fallback —— 座位撞限时按池顺延一次 (2026-09-11, owner 裁「verifier 降级座」)。
 *
 * 治的洞: verifier 只有一个坐标, opus / codex 撞 session limit 整批判官缺席
 * (`runs/2026-09-06-e0-e1-e2/readout.md`: consensus 批 verifier 缺席 80/80, 读数作废);
 * 既有 `withGoFallback` 只管 opencode-go 端点抖动那一格。这里把「provider 故障 → 池里下一个
 * 可用坐标」做成通用件: 只对**后端此刻不健康**那类错 (402/403/429/5xx / quota) 顺延, 其它错原样抛
 * (与 `isProviderFault` 同一把尺, 别吞真错误)。
 *
 * 纯函数 + 注入判据, 零 I/O; 生产默认 `usable = coordUsable` (凭证 ∧ 不在冷却)。
 * 反向自检见 seat-fallback.test.ts: 把 `faulty` 判据改成恒 true → 「配置错不顺延」用例红。
 */
import { ModelError, isProviderFault } from './index';
import { coordUsable } from './role-fallback';
import { logger } from '../harness/logger';

export interface PoolFallbackDeps {
  /** 坐标此刻可用 (凭证 + 未冷却)。默认 coordUsable。 */
  usable?: (coord: string) => boolean;
  /** 这个错该不该顺延。默认: ModelError 且 isProviderFault; 非 ModelError 按消息里的 usage limit / 状态码判。 */
  faulty?: (err: unknown) => boolean;
  /** 日志归因 (verifier / judge …)。 */
  role?: string;
}

/** 默认故障判据: 后端此刻不健康。字符串路只认 codex 那句 usage limit 与显式状态码 (pi 传上来不带 status)。 */
export function defaultFaulty(err: unknown): boolean {
  if (err instanceof ModelError) return isProviderFault(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (/usage limit has been reached|session limit|Insufficient account balance|Token Plan 用量上限/i.test(msg)) return true;
  const m = /(?:^|[^0-9])(402|403|429|5[0-9]{2})(?=\s*:|\s*[{(]|\s*$)/.exec(msg.slice(0, 120));
  return !!m;
}

/** 池里第一个 ≠ 当前坐标且可用的; 没有 → undefined (调用方原错照抛)。 */
export function pickFallbackCoord(current: string, pool: readonly string[], usable: (c: string) => boolean): string | undefined {
  for (const c of pool) {
    const coord = c.trim();
    if (!coord || coord === current) continue;
    if (usable(coord)) return coord;
  }
  return undefined;
}

/**
 * 跑 run(model); 撞 provider 故障 → 池里下一个可用坐标再跑**一次**。顺延也失败 → 抛顺延那次的错
 * (第一次的错进日志, 不丢证据)。
 */
export async function withPoolFallback<T>(
  model: string,
  pool: readonly string[],
  run: (m: string) => Promise<T>,
  deps: PoolFallbackDeps = {},
): Promise<T> {
  const usable = deps.usable ?? ((c: string) => coordUsable(c));
  const faulty = deps.faulty ?? defaultFaulty;
  try {
    return await run(model);
  } catch (e) {
    if (!faulty(e)) throw e;
    const next = pickFallbackCoord(model, pool, usable);
    if (!next) {
      logger.warn(
        { role: deps.role, model, pool, err: e instanceof Error ? e.message.slice(0, 200) : String(e) },
        '[seat-fallback] 座位撞后端故障, 池里没有可用的顺延坐标 → 原错照抛',
      );
      throw e;
    }
    logger.warn(
      { role: deps.role, from: model, to: next, err: e instanceof Error ? e.message.slice(0, 200) : String(e) },
      '[seat-fallback] 座位撞后端故障 → 池内顺延一次 (2026-09-11 verifier 降级座)',
    );
    return run(next);
  }
}
