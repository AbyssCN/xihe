/**
 * profile 库自检:G-1 字段级 merge (项目层胜)、内置加载、未知名 → undefined、确定性隔离。
 * 影子测试用**真实内置档案** design-review (P4 首个条目, 测试只读不写内置目录):
 * 项目层 .omd/profiles/design-review.json 覆盖其中部分字段 → 断言覆盖字段项目值胜、
 * 未写字段保留内置值 (字段级 merge, 不是整体覆盖)。隔离纪律:每个测试独立临时 cwd,
 * afterEach 清掉 → 测试间零共享状态、不污染仓库。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setCoreLogger, type CoreLogger } from '../logger';
import { loadProfiles, resolveProfile, type ProfileSpec } from './profile';

const BUILTIN_DIR = join(import.meta.dir, 'builtin');
const BUILTIN_FILE = 'design-review.json';

const consoleLogger: CoreLogger = {
  debug: () => {},
  info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : ''),
  warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : ''),
  error: (o, m) => console.error(m ?? '', o),
};

let cwd: string;
const warns: Array<{ file: string; err: string; msg: string }> = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'profiles-'));
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

/** 读真实内置档案 (只读, 不造夹具) —— 影子测试的"被覆盖方"。 */
const readBuiltin = (): ProfileSpec =>
  JSON.parse(readFileSync(join(BUILTIN_DIR, BUILTIN_FILE), 'utf8')) as ProfileSpec;

const writeProject = (file: string, spec: Partial<ProfileSpec>): void => {
  mkdirSync(join(cwd, '.omd', 'profiles'), { recursive: true });
  writeFileSync(join(cwd, '.omd', 'profiles', file), JSON.stringify(spec));
};

describe('profiles', () => {
  test('G-1: 项目层影子覆盖真实内置 → 项目字段胜、未写字段保留内置值', () => {
    const builtin = readBuiltin();
    // 项目层只写 persona + seat, 其余字段不写 → 应保留内置值。
    writeProject(BUILTIN_FILE, { name: builtin.name, persona: 'project-persona', seat: 'project-seat' });

    const p = loadProfiles(cwd).get(builtin.name);
    expect(p).toBeDefined();
    expect(p?.persona).toBe('project-persona'); // 覆盖字段 → 项目值胜
    expect(p?.seat).toBe('project-seat');
    // 未写字段保留内置值 → 字段级 merge, 不是整体覆盖。
    expect(p?.outputSchema).toBe(builtin.outputSchema);
    expect(p?.ledgerPath).toBe(builtin.ledgerPath);
    expect(p?.skills).toEqual(builtin.skills);
    expect(p?.tools).toEqual(builtin.tools);
    expect(p?.frontendGlob).toBe(builtin.frontendGlob);
  });

  test('内置加载:无项目层时 design-review 以完整内置值出现', () => {
    const builtin = readBuiltin();
    const all = loadProfiles(cwd);
    expect(all.size).toBe(1); // 全新临时 cwd 无项目档案 → 只有内置, 隔离干净
    expect(all.get(builtin.name)).toEqual(builtin);
  });

  test('未知名 → undefined, 不抛', () => {
    expect(resolveProfile('no-such-profile', cwd)).toBeUndefined();
    expect(loadProfiles(cwd).has('no-such-profile')).toBe(false);
  });

  test('确定性隔离:项目层只影响自身 cwd, 同 cwd 重复加载结果一致', () => {
    writeProject('local-only.json', { name: 'local-only', persona: 'p' });
    const withProject = [...loadProfiles(cwd)];

    const other = mkdtempSync(join(tmpdir(), 'profiles-'));
    try {
      expect([...loadProfiles(other)]).toEqual([...loadProfiles(other)]); // 重复加载无状态变异
      expect(loadProfiles(other).has('local-only')).toBe(false); // 不跨 cwd 泄漏
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    expect([...loadProfiles(cwd)]).toEqual(withProject);
  });

  test('损坏 json 单文件跳过不炸整表, 且留证据 (文件名 + 错误原文)', () => {
    writeProject('broken.json', '{ not json !!!' as unknown as ProfileSpec);
    writeProject('good.json', { name: 'zz-good', persona: 'p' });

    const all = loadProfiles(cwd);
    expect(all.get('zz-good')?.persona).toBe('p'); // 好文件照常加载
    expect(all.has('broken')).toBe(false); // 坏文件不产生条目
    const ev = warns.find((w) => w.file.endsWith('broken.json'));
    expect(ev).toBeDefined(); // 证据:文件名…
    expect(ev?.err.length).toBeGreaterThan(0); // …与错误原文
  });

  /**
   * T3 (D-3): `persona` 降级为**可选**。缺 persona 从"非法档案"变成"合法形态" ——
   * 判据只剩 `name`。这条闸盯的是那个**静默**方向:旧判据会把缺 persona 的合法档案跳过,
   * 而跳过是 warn 级的,调用方拿到的只是"这个 profile 不存在"。
   */
  test('T3/D-3 缺 persona 的档案是合法的 —— 照常加载, 且不产生 warn', () => {
    writeProject('seat-only.json', { name: 'zz-seat-only', seat: 'deepseek:deepseek-v4-flash' } as ProfileSpec);

    const spec = resolveProfile('zz-seat-only', cwd);
    // 反向自检 (2026-08-12 实跑): 把 readDirProfiles 的判据改回
    //   `|| typeof raw.persona !== 'string'` → `Received: undefined` → 红。
    expect(spec).toBeDefined();
    expect(spec!.seat).toBe('deepseek:deepseek-v4-flash');
    expect(spec!.persona).toBeUndefined();
    // 缺 persona 不是"坏文件", 所以不该留跳过证据 —— 有 warn 说明旧判据还在。
    expect(warns.find((w) => w.file.endsWith('seat-only.json'))).toBeUndefined();
  });
});

/**
 * C-7 判据只有一份 (SDD 2026-08-11 卡与profile分工 D-12)。
 *
 * 迁移前 `design-review` 的判据表**同时**活在两处:profile 的 persona (2741 字符) 与
 * `frontend-impl` 卡 body —— 同一批知识的两面、两份独立文本, 已在漂。漂了之后两边各自自洽,
 * 症状静默。本闸盯的就是"判据又漂回 persona"这一个方向。
 *
 * 量的是**内置档案真身**, 不是临时目录里的影子 —— 影子测得再绿也拦不住内置文件回胖。
 */
describe('C-7 判据只有一份 (design-review 档案不再承载判据表)', () => {
  test('内置 design-review 的 persona ≤200 字符, 且不含 p0/p1/p2 判据词', () => {
    const spec = JSON.parse(readFileSync(join(BUILTIN_DIR, BUILTIN_FILE), 'utf8')) as ProfileSpec;
    const persona = spec.persona ?? '';
    // 反向自检 (2026-08-12 实跑): 把旧的 2741 字符判据表贴回 persona →
    //   长度断言 `Expected: <= 200  Received: 2741` → 红。
    expect(persona.length).toBeLessThanOrEqual(200);
    const 判据词 = ['p0', 'p1', 'p2', '硬闸', '命中即报'].filter((w) => persona.includes(w));
    expect(判据词).toEqual([]);
    // 装配位字段一个都不许在瘦身里丢 (D-14: 它们是卡没有的东西, 且都不进 prompt)。
    // ⚠ seat 例外 (2026-09-11 实账 run 1c6b8a69): 内置档案曾钉死 `mimo-platform:mimo-v2.5`, 该座
    // 余额 402, conductor 给 spawn 节点挑 design-review 后四节点全落死座, 重试 36 次零产出 ——
    // profile.seat 优先级高于 run 参数与座位表 (engine TPL-3), 内置层不许钉具体 provider 坐标。
    // 反向自检: 把 "seat": "x:y" 写回 json → 本断言与下方「内置档案不钉座」用例同时红。
    expect(spec.seat).toBeUndefined();
    expect(spec.outputSchema).toBeTruthy();
    expect(spec.ledgerPath).toBeTruthy();
    expect(spec.frontendGlob).toBeTruthy();
  });
});

/**
 * 内置档案不钉具体 provider 坐标 (2026-09-11)。座位由座位表 / run 参数 / 项目层 .omd/profiles 决定;
 * 内置层是随包发布的, 钉一个坐标 = 把作者机器上的账户写进产品。
 * 反向自检: 给任一内置 json 加 "seat": "mimo-platform:mimo-v2.5" → 红。
 */
describe('内置档案不钉座', () => {
  test('src/harness/profiles/builtin/*.json 一律无 seat', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const pinned: string[] = [];
    for (const f of readdirSync(BUILTIN_DIR).filter((x) => x.endsWith('.json'))) {
      const spec = JSON.parse(readFileSync(join(BUILTIN_DIR, f), 'utf8')) as ProfileSpec;
      if (spec.seat !== undefined) pinned.push(`${f}: ${spec.seat}`);
    }
    expect(pinned).toEqual([]);
  });
});
