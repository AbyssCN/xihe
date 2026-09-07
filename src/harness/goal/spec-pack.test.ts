/**
 * goal/spec-pack.test —— 规格包纯模块 (R7, 契约
 * `docs/plan/2026-09-07-规格包-上游对齐与需求枚举-执行契约.md` INV-1 / INV-2 / INV-3 / INV-6)。
 *
 * 接线面 (勘察包末尾追加 / 共识 prompt / ledger 三态) 在 `./spec-pack-wiring.test.ts`;
 * 这里只问纯函数的四件事: 并集去重 · 多数投票 · 全挂不抛 · 超上限按尾部截。
 *
 * ## 反向自检 (2026-09-07 逐条真跑过, 还原复绿)
 *  · `mergeSpecSamples` 的 `requirements` 去掉归一化去重 (直接 concat) ⇒ INV-1 红 (4 条 ≠ 3 条);
 *  · `majorityPick` 改成恒取最后一份 ⇒ INV-2 红 (source 变 `guess`, upstreamNamed 变 0);
 *  · `buildSpecPack` 里 `sampleOnce` 的 try/catch 去掉 (让解析错抛出去) ⇒ INV-3 红 (整个调用抛);
 *  · `buildSpecPack` 去掉那个 `while (text.length > maxChars)` 尾部截断循环 ⇒ INV-6 红。
 */
import { describe, expect, test } from 'bun:test';
import {
  SPEC_PACK_HEADER,
  buildSpecPack,
  mergeSpecSamples,
  parseSpecSample,
  renderSpecPack,
  specPackEnabled,
  type SpecSample,
} from './spec-pack';

const req = (text: string, source: 'instruction' | 'inferred' = 'inferred') => ({ text, source });
const sample = (over: Partial<SpecSample> = {}): SpecSample => ({
  project: 'demo 0.1',
  interfaces: [],
  conventions: [],
  requirements: [],
  ...over,
});

// ── INV-1: 需求并集去重 ────────────────────────────────────────────────────────

describe('INV-1 需求取并集, 归一化后去重', () => {
  test('★ [a,b] + [b,c] + [a,c\'] ⇒ 3 条 (c\' 与 c 只差标点大小写)', () => {
    const merged = mergeSpecSamples([
      sample({ requirements: [req('accept an empty payload'), req('reject unknown keys')] }),
      sample({ requirements: [req('reject unknown keys'), req('return a steps key')] }),
      sample({ requirements: [req('accept an empty payload'), req('Return a "steps" key.')] }),
    ]);
    // 证伪: 去掉归一化去重 ⇒ 6 条; 只按原文去重 ⇒ 4 条 (c 与 c' 分家)。
    expect(merged.requirements.map((r) => r.text)).toEqual([
      'accept an empty payload',
      'reject unknown keys',
      'return a steps key',
    ]);
    expect(merged.samples).toBe(3);
  });

  test('★ 一份标 instruction 就算 instruction (「原文写了」一份看见即成立)', () => {
    const merged = mergeSpecSamples([
      sample({ requirements: [req('return a steps key')] }),
      sample({ requirements: [req('Return a steps key!', 'instruction')] }),
    ]);
    expect(merged.requirements).toEqual([{ text: 'return a steps key', source: 'instruction' }]);
  });
});

// ── INV-2: 接口按 name 多数投票 ───────────────────────────────────────────────

describe('INV-2 接口按 name 多数投票, 平票取 source 优先级', () => {
  const iface = (source: 'repo' | 'upstream' | 'guess') => ({
    name: 'Validator.check_validity_of',
    signature: 'check_validity_of(self, value)',
    returns: 'bool',
    raises: 'ValueError',
    source,
  });

  test('★ 两票 upstream 一票 guess ⇒ source=upstream, upstreamNamed 计 1', () => {
    const merged = mergeSpecSamples([
      sample({ interfaces: [iface('upstream')] }),
      sample({ interfaces: [iface('guess')] }),
      sample({ interfaces: [iface('upstream')] }),
    ]);
    // 证伪: 去掉多数投票 (取最后一份) ⇒ source 变 'guess', 本条红。
    expect(merged.interfaces).toHaveLength(1);
    expect(merged.interfaces[0]!.source).toBe('upstream');
    expect(merged.interfaces.filter((i) => i.source === 'upstream')).toHaveLength(1);
  });

  test('★ 一票一票平票 ⇒ 取 source 优先级高的 (repo > upstream > guess)', () => {
    const merged = mergeSpecSamples([sample({ interfaces: [iface('guess')] }), sample({ interfaces: [iface('repo')] })]);
    expect(merged.interfaces[0]!.source).toBe('repo');
  });
});

// ── 解析: 宽进, 但认不出的出处降 guess ───────────────────────────────────────

describe('parseSpecSample', () => {
  test('★ 围栏包着的 JSON 抠得出来; source 认不出降 guess', () => {
    const raw = '```json\n{"project":"p","interfaces":[{"name":"f","source":"我猜的"}]}\n```';
    const r = parseSpecSample(raw);
    expect('sample' in r).toBe(true);
    if (!('sample' in r)) return;
    expect(r.sample.interfaces[0]).toEqual({ name: 'f', signature: '', returns: '', raises: '', source: 'guess' });
  });

  test('★ 散文 ⇒ error 带原文前缀 (§静默坑 2: 不吞证据)', () => {
    const r = parseSpecSample('我觉得这个项目应该叫 demo');
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toContain('我觉得这个项目');
  });

  test('★ 四问一问都没答 ⇒ 判失败 (空壳不算一份样本)', () => {
    expect('error' in parseSpecSample('{"project":"","interfaces":[],"conventions":[],"requirements":[]}')).toBe(true);
  });
});

// ── INV-3: 全挂不抛 ───────────────────────────────────────────────────────────

describe('INV-3 生成返回非 JSON 两次 ⇒ 空包 + why, 调用方不抛', () => {
  test('★ 采 1 份 ⇒ 恰打两发 (重试一次), text 空 · facts 全 0 · why 非空', async () => {
    let calls = 0;
    const pack = await buildSpecPack('g', '', {
      generate: async () => {
        calls += 1;
        return '模型今天想聊天';
      },
      samples: 1,
    });
    // 证伪: 去掉 sampleOnce 的 try/catch 与"解析失败返 undefined"那条路 ⇒ 这里抛, 本条红。
    expect(calls).toBe(2);
    expect(pack.text).toBe('');
    expect(pack.facts).toEqual({ samples: 0, requirements: 0, fromInstruction: 0, interfaces: 0, upstreamNamed: 0, guessed: 0, chars: 0 });
    expect(pack.why ?? '').not.toBe('');
  });

  test('★ 生成函数抛错也一样 (fail-open, 原文进 why)', async () => {
    const pack = await buildSpecPack('g', '', {
      generate: async () => {
        throw new Error('429 rate limited');
      },
      samples: 2,
    });
    expect(pack.text).toBe('');
    expect(pack.why).toContain('429 rate limited');
  });

  test('★ 三份里一份成 ⇒ 照样出包, why 记下另两份的原文 (缺席 ≠ 没发生)', async () => {
    let n = 0;
    const pack = await buildSpecPack('g', '', {
      generate: async () => {
        n += 1;
        return n <= 2 ? '散文' : JSON.stringify({ project: 'p', requirements: [{ text: 'do x', source: 'instruction' }] });
      },
      samples: 3,
    });
    expect(pack.facts.samples).toBeGreaterThanOrEqual(1);
    expect(pack.text).toContain(SPEC_PACK_HEADER);
    expect(pack.facts.fromInstruction).toBe(1);
  });
});

// ── 接口/惯例条数上限 (2026-09-07, spec 首批: 接口段顶满上限, 需求渲染 0 条) ─────────────
describe('接口条数上限: 先丢 guess, 不把需求清单挤成 0', () => {
  test('★ 30 条 guess 接口 + 5 条 repo 接口 + 20 条需求 ⇒ 接口 ≤ 12 且 repo 全留, 需求全留 (证伪: 去掉 MAX_INTERFACES ⇒ 红)', async () => {
    const ifaces = [
      ...Array.from({ length: 5 }, (_, i) => ({ name: `repo_${i}`, signature: 'x'.repeat(120), returns: 'y'.repeat(60), raises: '', source: 'repo' })),
      ...Array.from({ length: 30 }, (_, i) => ({ name: `guess_${i}`, signature: 'x'.repeat(120), returns: 'y'.repeat(60), raises: '', source: 'guess' })),
    ];
    const reqs = Array.from({ length: 20 }, (_, i) => ({ text: `需求 ${i} ` + 'z'.repeat(40), source: 'inferred' }));
    const body = JSON.stringify({ project: 'p', interfaces: ifaces, conventions: [], requirements: reqs });
    const pack = await buildSpecPack('goal', '', { generate: async () => body, samples: 1, maxChars: 6000 });
    expect(pack.facts.interfaces).toBeLessThanOrEqual(12);
    expect(pack.text.match(/`repo_\d+`/g)?.length).toBe(5);
    expect(pack.facts.requirements).toBe(20);
    expect(pack.why).toContain('先丢 guess');
  });
});

// ── INV-6: 超上限按 requirements 尾部截 ──────────────────────────────────────

describe('INV-6 渲染后总长 ≤ maxChars, 超出按需求尾部截并记 why', () => {
  test('★ 20 条长需求 + maxChars=600 ⇒ 长度达标, why 说了截掉几条, 接口段留着', async () => {
    const requirements = Array.from({ length: 20 }, (_, i) => ({ text: `需求 ${i} ${'x'.repeat(80)}`, source: 'inferred' as const }));
    const pack = await buildSpecPack('g', '', {
      generate: async () => JSON.stringify({ project: 'p', interfaces: [{ name: 'f', source: 'upstream' }], requirements }),
      samples: 1,
      maxChars: 600,
    });
    // 证伪: 去掉那个 while 截断循环 ⇒ 长度 ~1900, 本条红。
    expect(pack.text.length).toBeLessThanOrEqual(600);
    expect(pack.facts.chars).toBe(pack.text.length);
    expect(pack.facts.requirements).toBeLessThan(20);
    expect(pack.why).toContain('需求清单尾部截掉');
    // 尾部截, 不是从头截: 接口段 (主产物) 必须还在。
    expect(pack.text).toContain('### 接口对齐');
    expect(pack.facts.upstreamNamed).toBe(1);
  });

  test('★ 不超上限 ⇒ why 缺席 (缺席 ≠ 没截: 没截就是没截)', async () => {
    const pack = await buildSpecPack('g', '', {
      generate: async () => JSON.stringify({ project: 'p', requirements: [{ text: 'do x', source: 'instruction' }] }),
      samples: 1,
    });
    expect(pack.why).toBeUndefined();
  });
});

// ── 渲染 + 开关 ───────────────────────────────────────────────────────────────

describe('renderSpecPack / specPackEnabled', () => {
  test('★ 段头固定, 空节不渲染空壳', () => {
    const text = renderSpecPack({ project: '', interfaces: [], conventions: [], requirements: [req('do x')], samples: 1 });
    expect(text.startsWith(SPEC_PACK_HEADER)).toBe(true);
    expect(text).not.toContain('### 项目');
    expect(text).not.toContain('### 接口对齐');
    expect(text).toContain('- [ ] do x [inferred]');
  });

  test('★ 开关只认字面 1 (证伪: 改成 truthy 判断 ⇒ 下面三条红)', () => {
    const prior = process.env.OMD_SPEC_PACK;
    try {
      process.env.OMD_SPEC_PACK = '1';
      expect(specPackEnabled()).toBe(true);
      process.env.OMD_SPEC_PACK = 'true';
      expect(specPackEnabled()).toBe(false);
      process.env.OMD_SPEC_PACK = '0';
      expect(specPackEnabled()).toBe(false);
      delete process.env.OMD_SPEC_PACK;
      expect(specPackEnabled()).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.OMD_SPEC_PACK;
      else process.env.OMD_SPEC_PACK = prior;
    }
  });
});
