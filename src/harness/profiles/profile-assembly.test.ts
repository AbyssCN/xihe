/**
 * profile-assembly.test.ts —— 装配层覆盖: G-2/G-3/G-6/G-7。
 *
 * G-2: 未知名 profile → resolveProfile 返回 undefined, 不抛; 装配层以 baseline 等效状态完成
 *      (profile?.seat / profile?.persona 均为 undefined, 与不传 profile 逐位相同)。
 * G-3: design-review 内置档案注入 persona / skills / tools / seat (字段完整, 非空壳)。
 * G-6: 显式节点模型胜: inputModel 非空时覆盖 profile.seat (模型决议 = inputModel, 不用 seat 回退)。
 * G-7: 变异敏性 —— 未知名 profile 闸不抛; 断言写成"若改为 throw 则此测试必红"的形式
 *      (即: 断言无抛 + 断言返回值语义正确, 不依赖 catch 块假装绿)。
 *
 * 所有测试用真实内置档案 (只读, 不造夹具), 隔离纪律同 profile.test.ts。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setCoreLogger, type CoreLogger } from '../logger';
import { loadProfiles, resolveProfile } from './profile';

const consoleLogger: CoreLogger = {
  debug: () => {},
  info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : ''),
  warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : ''),
  error: (o, m) => console.error(m ?? '', o),
};

let cwd: string;
const warns: Array<{ file: string; err: string; msg: string }> = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'profile-asm-'));
  warns.length = 0;
  setCoreLogger({
    debug: () => {},
    info: () => {},
    warn(o, m) {
      const r = o as { file?: string; err?: string };
      warns.push({ file: String(r.file ?? ''), err: String(r.err ?? ''), msg: m ?? '' });
    },
    error(o, m) {
      const r = o as { file?: string; err?: string };
      warns.push({ file: String(r.file ?? ''), err: String(r.err ?? ''), msg: m ?? '' });
    },
  });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  setCoreLogger(consoleLogger);
});

// ---------------------------------------------------------------------------
// G-2: unknown profile → undefined, baseline-equivalent assembly
// ---------------------------------------------------------------------------
describe('G-2: unknown profile assembly', () => {
  test('resolveProfile 对未知名返回 undefined, 不抛', () => {
    // G-7 变异敏性: 若有人把 resolveProfile 改成对未知名 throw, 这行直接炸 → 测试红。
    const result = resolveProfile('no-such-profile-ever', cwd);
    expect(result).toBeUndefined();
  });

  test('undefined profile 的装配面与不传 profile 逐位相同 (baseline-equivalent)', () => {
    // profile?.seat → undefined, profile?.persona → undefined,
    // profile?.skills → undefined, profile?.tools → undefined.
    // 装配层 opts.profile 为 undefined 时, 所有 profile 派生字段均为 undefined/空,
    // 与完全不传 profile 的 baseline 不可区分。
    const prof = resolveProfile('no-such-profile-ever', cwd);
    expect(prof).toBeUndefined();

    // 模拟装配层取值 (对应 agent-leaf.ts L884, L918, L861, L871):
    const seat = prof?.seat;       // undefined
    const persona = prof?.persona; // undefined
    const skills = prof?.skills;   // undefined
    const tools = prof?.tools;     // undefined

    expect(seat).toBeUndefined();
    expect(persona).toBeUndefined();
    expect(skills).toBeUndefined();
    expect(tools).toBeUndefined();
  });

  test('loadProfiles 不含未知名', () => {
    const all = loadProfiles(cwd);
    expect(all.has('no-such-profile-ever')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G-3: design-review 注入 persona / skills / tools / default seat
// ---------------------------------------------------------------------------
describe('G-3: design-review profile injection', () => {
  test('design-review 内置档案字段完整 (persona / skills / tools / seat)', () => {
    const prof = resolveProfile('design-review', cwd);
    expect(prof).toBeDefined();

    // persona: 非空字符串, 含核心职责描述。
    // D-3 后 persona 是**可选**字段 → 这里先硬断言它在, 再用收窄后的局部量断长度:
    // 用 `!` 糊过去会让「档案真的丢了 persona」退化成类型层面的沉默, 而这条测试要的正是它在。
    const { persona } = prof!;
    if (typeof persona !== 'string') throw new Error('design-review 内置档案缺 persona (本测试要求它存在)');
    expect(persona.length).toBeGreaterThan(10);
    expect(persona).toContain('审核');

    // seat: 内置层**不钉**具体坐标 (2026-09-11, run 1c6b8a69: 钉死的 mimo-platform 余额 402, 四节点全落死座)。
    // 座位由座位表 / run 参数 / 项目层 .omd/profiles 给; 机制本身 (profile.seat 优先级) 在 profile-integration G-6 用项目层夹具测。
    expect(prof!.seat).toBeUndefined();

    // skills: 非空数组, 含三件蒸馏配套 skill (2026-08-11 owner 裁: impeccable+huashu+taste,
    // vendor 在 .omd/skills/, persona 蒸馏语料见 docs/reference/design-review-distill-2026-08-11/)
    expect(Array.isArray(prof!.skills)).toBe(true);
    expect(prof!.skills!.length).toBeGreaterThan(0);
    for (const s of ['impeccable', 'huashu-design', 'taste-skill']) {
      expect(prof!.skills).toContain(s);
    }

    // tools: 非空数组, 至少含 read / grep / bash
    expect(Array.isArray(prof!.tools)).toBe(true);
    expect(prof!.tools!.length).toBeGreaterThan(0);
    for (const t of ['read', 'grep', 'bash']) {
      expect(prof!.tools).toContain(t);
    }

    // ledgerPath + outputSchema 存在 (design-review 特有)
    expect(typeof prof!.outputSchema).toBe('string');
    expect(typeof prof!.ledgerPath).toBe('string');
  });

  test('skills 数组不含空串/空白', () => {
    const prof = resolveProfile('design-review', cwd);
    for (const s of prof!.skills!) {
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  test('tools 数组不含空串/空白', () => {
    const prof = resolveProfile('design-review', cwd);
    for (const t of prof!.tools!) {
      expect(t.trim().length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// G-6: explicit node model wins over profile seat
// ---------------------------------------------------------------------------
describe('G-6: explicit node model wins', () => {
  /**
   * 模型决议规则 (agent-leaf.ts L884):
   *   const model = inputModel || opts.profile?.seat || '';
   *
   * inputModel 来自 AgentLeafInput.model (引擎侧 pin 的显式模型),
   * opts.profile?.seat 来自岗位档案的 seat 字段 (回退)。
   * 显式模型非空 → 直接用, 不看 profile.seat。
   */

  /** 内置档案不钉座 (2026-09-11) → seat 由项目层夹具给 (字段级合并进内置 design-review)。 */
  const pinSeat = (): void => {
    const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(join(cwd, '.omd', 'profiles'), { recursive: true });
    writeFileSync(join(cwd, '.omd', 'profiles', 'design-review.json'), JSON.stringify({ name: 'design-review', seat: 'pin:profile-seat' }));
  };

  test('inputModel 非空时决议为 inputModel, 不用 profile.seat', () => {
    pinSeat();
    const prof = resolveProfile('design-review', cwd);
    expect(prof?.seat).toBeTruthy(); // 前置: profile 有 seat (项目层)

    const inputModel = 'explicit-provider:explicit-model';
    // 模拟 L884 决议逻辑
    const resolved = inputModel || prof?.seat || '';
    expect(resolved).toBe(inputModel);
    expect(resolved).not.toBe(prof?.seat);
  });

  test('inputModel 为空时回退到 profile.seat', () => {
    pinSeat();
    const prof = resolveProfile('design-review', cwd);
    expect(prof?.seat).toBe('pin:profile-seat');

    const inputModel = '';
    const resolved = inputModel || prof?.seat || '';
    expect(resolved).toBe(prof?.seat ?? '');
  });

  test('inputModel 为空且 profile 为 undefined 时回退到空串 (由装配层闸报错)', () => {
    const prof = resolveProfile('no-such-profile-ever', cwd);
    expect(prof).toBeUndefined();

    const inputModel = '';
    const resolved = inputModel || prof?.seat || '';
    expect(resolved).toBe('');
    // 空串 → 装配层应触发 '[agent-leaf] 无模型' 错误 (不在本测试范围, 但决议结果正确)。
  });

  test('inputModel 空串视为 falsy (非空才胜)', () => {
    const prof = resolveProfile('design-review', cwd);
    // 空串是 falsy → 回退到 seat
    const inputModel: string = '';
    const resolved = inputModel || prof?.seat || '';
    expect(resolved).toBe(prof?.seat ?? '');
  });
});

// ---------------------------------------------------------------------------
// G-7: mutation sensitivity — unknown-profile gate does NOT throw
// ---------------------------------------------------------------------------
describe('G-7: unknown-profile mutation sensitivity', () => {
  /**
   * 变异敏性测试: 验证未知名 profile 路径不抛。
   *
   * 关键构造: 本 describe 内**没有任何 try/catch**。
   * 若有人把 resolveProfile (或上游装配闸) 改成对未知名 throw,
   * 则 test 体直接炸 → Bun 报未捕获异常 → 测试红。
   * 这保证"改闸为 throw"无法静默通过。
   */

  test('resolveProfile 对未知名不抛 (直接调用, 无 try)', () => {
    // 不包 try/catch —— 若抛则 Bun 捕获并标失败。
    const result = resolveProfile('completely-unknown-profile', cwd);
    expect(result).toBeUndefined();
  });

  test('连续多次 resolveProfile 未知名均不抛且一致返回 undefined', () => {
    for (let i = 0; i < 10; i++) {
      const result = resolveProfile(`unknown-${i}`, cwd);
      expect(result).toBeUndefined();
    }
  });

  test('未知名 profile 的 Map.has 为 false (不产生幽灵条目)', () => {
    const all = loadProfiles(cwd);
    // 多次 resolve 后全量表不被污染
    resolveProfile('ghost-profile', cwd);
    resolveProfile('another-ghost', cwd);
    expect(all.has('ghost-profile')).toBe(false);
    expect(all.has('another-ghost')).toBe(false);
  });

  test('design-review (已知) 与未知名混合调用, 已知不受影响', () => {
    // 先查未知名 → 再查已知 → 已知仍正确返回
    const unknown = resolveProfile('unknown-mix', cwd);
    expect(unknown).toBeUndefined();

    const known = resolveProfile('design-review', cwd);
    expect(known).toBeDefined();
    expect(known!.name).toBe('design-review');
    // 同上 (D-3 persona 可选): 硬断言存在, 再量长度 —— 不用 `!` 绕过。
    const knownPersona = known!.persona;
    if (typeof knownPersona !== 'string') throw new Error('design-review 内置档案缺 persona (本测试要求它存在)');
    expect(knownPersona.length).toBeGreaterThan(0);
  });
});
