/**
 * grind 三档阶梯 (D-1/D-2) —— nextGrindAction 纯谓词 + runOnce 三档接线 + watchdog 记账位。
 * 验收 GWT 1-3 (SDD 2026-08-17)。
 *
 * 形状同 agent-leaf-watchdog-s3.test.ts: 纯函数直钉 + 注入 deps.now + 假 advisor 的跑圈层。
 * 覆盖范围: 本文件**只**测二/三档 (wrapup / abort); advisor 单档的契约由 S3 测试守, 不动。
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createAgentLeafRunner,
  GRIND_ABORT_MS,
  GRIND_STALL_MS,
  GRIND_WALL_MS,
  GRIND_WRAPUP_MS,
  nextGrindAction,
  type GrindAdvisorSnapshot,
} from './agent-leaf';
import type { AgentLeafResult } from './agent-leaf';

const MODEL = 'claude-code:claude-sonnet-5';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omd-grind-escalation-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

// ── 谓词层契约 (纯函数) ──────────────────────────────────────────────
describe('nextGrindAction 谓词契约 (纯函数, 三档阶梯)', () => {
  it('常量 GRIND_WRAPUP_MS=300_000 / GRIND_ABORT_MS=600_000 (改值会级联跑偏)', () => {
    expect(GRIND_WRAPUP_MS).toBe(300_000);
    expect(GRIND_ABORT_MS).toBe(600_000);
  });

  it('★ GWT-1.a: 双条件齐备 (wall>W && stall>=T && advisorFiredAt===null) → advisor', () => {
    const t = 1_000_000;
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs: t + GRIND_WALL_MS + GRIND_STALL_MS + 1,
      lastTouchGrowthAtMs: t,
      advisorFiredAt: null,
    };
    expect(nextGrindAction(s)).toBe('advisor');
  });

  it('★ GWT-1.b: advisor 已触发 + 距 advisor ≥ GRIND_WRAPUP_MS + 仍停滞 → wrapup', () => {
    const t = 1_000_000;
    const advisorAt = t + GRIND_WALL_MS + GRIND_STALL_MS + 1;
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs: advisorAt + GRIND_WRAPUP_MS + 1,
      lastTouchGrowthAtMs: t, // 仍停滞 (stall > T)
      advisorFiredAt: advisorAt,
      wrapupFiredAt: null,
    };
    expect(nextGrindAction(s)).toBe('wrapup');
  });

  it('★ GWT-1.c: wrapup 已触发 + 距 wrapup ≥ GRIND_ABORT_MS + 仍停滞 → abort', () => {
    const t = 1_000_000;
    const advisorAt = t + GRIND_WALL_MS + GRIND_STALL_MS + 1;
    const wrapupAt = advisorAt + GRIND_WRAPUP_MS + 1;
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs: wrapupAt + GRIND_ABORT_MS + 1,
      lastTouchGrowthAtMs: t, // 仍停滞
      advisorFiredAt: advisorAt,
      wrapupFiredAt: wrapupAt,
    };
    expect(nextGrindAction(s)).toBe('abort');
  });

  it('★ GWT-2: wrap-up 注入后 touched 有新增 → abort 不触发 (stall 钟随 touch 重置)', () => {
    const t = 1_000_000;
    const advisorAt = t + GRIND_WALL_MS + GRIND_STALL_MS + 1;
    const wrapupAt = advisorAt + GRIND_WRAPUP_MS + 1;
    // 模型响应 wrap-up, 改了一个文件: lastTouchGrowthAtMs 推到「nowMs - GRIND_STALL_MS + 1」之内,
    // stall 落回阈值以下 → wrapup 已触发但 abort 不该触发 (收尾成功的叶正常 done)。
    const nowMs = wrapupAt + GRIND_ABORT_MS + 10; // 距 wrapup 远超阈值
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs,
      lastTouchGrowthAtMs: nowMs - GRIND_STALL_MS + 1,
      advisorFiredAt: advisorAt,
      wrapupFiredAt: wrapupAt,
    };
    expect(nextGrindAction(s)).toBe(null);
  });

  it('次序固定 advisor→wrapup→abort, 不跳档: advisor 已触发但距 advisor 不足 GRIND_WRAPUP_MS → null', () => {
    const t = 1_000_000;
    const advisorAt = t + GRIND_WALL_MS + GRIND_STALL_MS + 1;
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs: advisorAt + GRIND_WRAPUP_MS - 1,
      lastTouchGrowthAtMs: t,
      advisorFiredAt: advisorAt,
      wrapupFiredAt: null,
    };
    expect(nextGrindAction(s)).toBe(null);
  });

  it('wrapup 已触发但距 wrapup 不足 GRIND_ABORT_MS → null', () => {
    const t = 1_000_000;
    const advisorAt = t + GRIND_WALL_MS + GRIND_STALL_MS + 1;
    const wrapupAt = advisorAt + GRIND_WRAPUP_MS + 1;
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs: wrapupAt + GRIND_ABORT_MS - 1,
      lastTouchGrowthAtMs: t,
      advisorFiredAt: advisorAt,
      wrapupFiredAt: wrapupAt,
    };
    expect(nextGrindAction(s)).toBe(null);
  });

  it('INV-2 三档各至多一次: advisor/wrapup/abort 全部已触发 → 仅在 stall 仍 ≥ T 时才返 abort', () => {
    const t = 1_000_000;
    const advisorAt = t + GRIND_WALL_MS + GRIND_STALL_MS + 1;
    const wrapupAt = advisorAt + GRIND_WRAPUP_MS + 1;
    // stall 已落回阈值以下 (touched 新增) → 即便距 wrapup 远超阈值, 也不返 abort
    const nowMs = wrapupAt + GRIND_ABORT_MS + 10;
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs,
      lastTouchGrowthAtMs: nowMs - GRIND_STALL_MS + 1,
      advisorFiredAt: advisorAt,
      wrapupFiredAt: wrapupAt,
    };
    expect(nextGrindAction(s)).toBe(null);
  });
});

// ── 跑圈层 (注入 deps.now + deps.askAdvisor, sdkQueryFn 替身 SDK) ──────
const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: { content: [{ type: 'text', text }], usage: {}, stop_reason: 'end_turn' },
  }) as unknown as SDKMessage;

const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;

const fakeQuery = (script: SDKMessage[]) =>
  (_props: { prompt: string; options: Options }) =>
    (async function* () {
      for (const m of script) yield m;
    })();

describe('agent leaf grind 三档阶梯 (注入时钟 + 假 advisor, GWT-3 abort 路径)', () => {
  it('★ GWT-3: 三档全过仍停滞 → abort 触发, spin-fused 写三级时间线, filesTouched 保留', async () => {
    const startedAtMs = 1_700_000_000_000;
    const tAdvisor = startedAtMs + GRIND_WALL_MS + GRIND_STALL_MS + 1000;
    const tWrapup = tAdvisor + GRIND_WRAPUP_MS + 1000;
    const tAbort = tWrapup + GRIND_ABORT_MS + 1000;
    // 推进钟: 第 1 次 = startedAt (供 `const startedAt = now()`); 之后逐步拨到三档阈值。
    // 每个 script item = 一次 emit → 一次 noteProgress → 一次 maybeFireGrindEscalation.now()。
    // 第 1 个 asst → tAdvisor (advisor 触发); 第 2 个 asst → tWrapup (wrapup 触发);
    // 第 3 个 asst → tAbort (abort 触发 → controller.abort()); 第 4 个 success → tAbort (predicate
    // 仍 null, 因 sinceWrapup=0 < GRIND_ABORT_MS, 不重入)。后续 now() 兜底回 tAbort。
    const fakeNowSequence = [
      startedAtMs, // call 1: startedAt
      tAdvisor, // call 2: 1st event's escalation check
      tWrapup, // call 3: 2nd event
      tAbort, tAbort, tAbort, tAbort, tAbort, tAbort, tAbort, // calls 4-10: 3rd event + padding
    ];
    let n = 0;
    const fakeNow = (): number => fakeNowSequence[n++] ?? tAbort;
    let askAdvisorCalls = 0;
    const fakeAdvice = '建议: 重新框问题。';

    const run = createAgentLeafRunner({
      cwd,
      sdkQueryFn: fakeQuery([asst('第一轮'), asst('第二轮'), asst('第三轮 (被 abort)'), success()]),
      deps: {
        now: fakeNow,
        askAdvisor: async () => {
          askAdvisorCalls++;
          return fakeAdvice;
        },
      },
    });

    const r: AgentLeafResult = await run({ prompt: '改 a.ts 的 bug', model: MODEL });

    // advisor 档: 仅 1 次 (谓词短路 + state short-circuit 共同保证)
    expect(askAdvisorCalls).toBe(1);
    expect(r.watchdog?.advisorFiredAt).toBe(tAdvisor - startedAtMs);
    // wrapup + abort 档: 各触发 1 次, 时刻以「距 startedAt 的相对毫秒数」计 (INV-5)
    expect(r.watchdog?.wrapupFiredAt).toBe(tWrapup - startedAtMs);
    expect(r.watchdog?.abortedByGrind).toBe(true);
    // spin-fused 路径: spinFused 字段非空, 含三级时间线 (INV-3)
    expect(r.spinFused).toBeDefined();
    expect(r.spinFused).toContain('grind 三档阶梯命中 abort');
    expect(r.spinFused).toContain(`advisor=${tAdvisor - startedAtMs}ms`);
    expect(r.spinFused).toContain(`wrapup=${tWrapup - startedAtMs}ms`);
    expect(r.spinFused).toContain(`abort=${tAbort - startedAtMs}ms`);
    // INV-3: filesTouched 保留 (本 leaf 没真动文件, 但字段应可读, 类型 = string[])
    expect(Array.isArray(r.filesTouched)).toBe(true);
    // INV-3: stalled 是 idle watchdog 的事, grind abort 不该把它弄成 true
    expect(r.watchdog?.stalled).toBe(false);
  });
});
// ── face 自报进展 (2026-09-05, R0/R1 实账) ────────────────────────────
/**
 * 治的病: grind 停滞钟只认「写入新文件路径」, 而 conductor 的手是 `['read','ls','grep','bash']`
 * + 派工卡且 `readOnlyShell: true` —— **结构上不可能写文件**。于是 `stall ≡ wall`, 三档退化成
 * 600s 必 advisor / 900s 必 wrapup / **1500s 必 abort**, 派得再好照砍。
 * 实账: R0 的 `stallAtAbort=1536108ms` ≈ 节点全寿命 = 那口钟一次没走过。
 *
 * 正解是**换尺子不换闸**: 每种面报自己的进展 (LeafFace.progress), 一套熔断照常有牙。
 */
describe('LeafFace.progress —— 不写文件的面(conductor)也量得出活着', () => {
  const startedAtMs = 1_700_000_000_000;
  /** 与 GWT-3 同一条时钟脚本: 不干预的话三档必然走完到 abort。 */
  const clock = () => {
    const tAdvisor = startedAtMs + GRIND_WALL_MS + GRIND_STALL_MS + 1000;
    const tWrapup = tAdvisor + GRIND_WRAPUP_MS + 1000;
    const tAbort = tWrapup + GRIND_ABORT_MS + 1000;
    // ⚠ 第 1 次 = `const startedAt = now()`; 第 2 次 = **首条消息之前**的那记 onActivity ping
    // (此时 conductor 还没派出任何东西, 进展理应是 0) —— 拨到 startedAt, 否则脚本在第一发就把
    // 预算烧光, 量的就不是 progress 了。之后三次逐档拨到阈值。
    const seq = [startedAtMs, startedAtMs, tAdvisor, tWrapup, tAbort, tAbort, tAbort, tAbort, tAbort, tAbort];
    let n = 0;
    return { startedAtMs, tAdvisor, tWrapup, tAbort, now: (): number => seq[n++] ?? tAbort };
  };
  const readOnlyFace = (progress?: () => number) => ({
    toolNames: ['read'],
    systemPrompt: '你是 conductor, 不写文件, 只派工。',
    readOnlyShell: true,
    ...(progress ? { progress } : {}),
  });

  // 证伪方式: 把 maybeFireGrindEscalation 里 face.progress 那一段删掉 → 本条由绿转红 (退回 abort)。
  it('★ 进展在涨 → 停滞钟随之推进, 墙钟远超 abort 阈值也一档不触发 (conductor 派得好不该被砍)', async () => {
    let dispatched = 0;
    let askAdvisorCalls = 0;
    // ⚠ 时钟**由派工驱动**, 不用固定脚本: 每派成一发就走 GRIND_WALL_MS。这样墙钟一路涨到
    // 4×600s = 40min (远过三档的 25min 铡刀), 而每次 poll 的 stall 恒 0 —— 正是要判的那件事:
    // **活着与否由进展说了算, 不由墙钟说了算**。固定脚本会让时钟跑在假消息流前面, 量的就不是 progress 了。
    const now = (): number => startedAtMs + dispatched * GRIND_WALL_MS;
    const run = createAgentLeafRunner({
      cwd,
      // 每一轮都真派出去一发并拿回结果 —— 这就是 conductor 的"有进展", 它一个文件都没写。
      sdkQueryFn: () =>
        (async function* () {
          for (const m of [asst('派一发'), asst('再派一发'), asst('第三发'), success()]) {
            dispatched++;
            yield m;
          }
        })(),
      deps: {
        now,
        askAdvisor: async () => {
          askAdvisorCalls++;
          return '不该被问到';
        },
      },
    });

    const r: AgentLeafResult = await run({ prompt: '编排子图', model: MODEL, face: readOnlyFace(() => dispatched) });

    // 前提自检: 墙钟真的越过了 abort 阈值 —— 否则本条会因"根本没跑到闸前"而假绿。
    expect(now() - startedAtMs).toBeGreaterThan(GRIND_WALL_MS + GRIND_WRAPUP_MS + GRIND_ABORT_MS);
    expect(askAdvisorCalls).toBe(0);
    expect(r.watchdog?.advisorFiredAt).toBeFalsy();
    expect(r.watchdog?.abortedByGrind).toBeFalsy();
    expect(r.spinFused).toBeUndefined();
  });

  // 这一条钉的是**病本身**: 同一副不写文件的面, 不报进展就必然被砍。它是上一条的对照基线 ——
  // 两条一起才说明"没被砍"是 progress 的功劳, 不是脚本恰好没走到阈值。
  it('对照: 同一副面不报进展 → 停滞钟恒不走, 仍旧 abort (这就是 R0 撞的那堵墙)', async () => {
    const c = clock();
    const run = createAgentLeafRunner({
      cwd,
      sdkQueryFn: fakeQuery([asst('派一发'), asst('再派一发'), asst('第三发'), success()]),
      deps: { now: c.now, askAdvisor: async () => '建议' },
    });

    const r: AgentLeafResult = await run({ prompt: '编排子图', model: MODEL, face: readOnlyFace() });

    expect(r.watchdog?.abortedByGrind).toBe(true);
    expect(r.spinFused).toContain('grind 三档阶梯命中 abort');
  });
});
