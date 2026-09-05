/**
 * doctor 判别力(GWT-7)。
 *
 * ## 反向自检(实跑, 删了就红)
 *
 * · 删掉 `diagnose` 里 `row.host.code === 0 &&` 那半 → GWT-7a 红(127 也被判 fatal)。
 * · 删掉 sandbox.ok 那条 → GWT-7b 红。
 * · 改 `renderDoctor` 让 warn 也涨 exitCode → GWT-7c 红(warn 阻塞合法 doctor 退出)。
 *
 * ## D-7 末句裁
 *
 * 不在本文件内**定义**任何与 `diagnose` / `renderDoctor` 同名或同形的函数 —— 全部 import。
 * 2026-09-04 run 3749c26b 被 verifier 以「重复实现骗绿」否决, 原因正是内联了一份,
 * 测与实装一起写一起错、互相背书。这一片按 D-7 末句**全部 import 生产模块**。
 */
import { describe, expect, test } from 'bun:test';

import { diagnose, renderDoctor, type DoctorInput } from './doctor';

/** 一份"全绿"输入的最小模板 —— 各用例只动一处。 */
const green = (over: Partial<DoctorInput> = {}): DoctorInput => ({
  sandbox: { ok: true },
  ecosystems: [{ id: 'node', executables: ['node'] }],
  preflight: [],
  smoke: [{ exe: 'node', host: { code: 0, out: 'v20' }, jail: { code: 0, out: 'v20' } }],
  ...over,
});

describe('diagnose —— doctor 的判别力(GWT-7)', () => {
  test('★ 全绿输入 → 空问题列表(正控, 闸不是恒红)', () => {
    expect(diagnose(green())).toEqual([]);
  });

  test('★★ GWT-7a 宿主通 jail 不通 (code 127) → fatal, what 含 exe 名, fix 含 bind', () => {
    // 这一形状就是 plana 2026-09-04 四个 run 零产出的现场: 宿主有 node, jail 里没有。
    // 怎么让它红: 把 `row.host.code === 0 &&` 删掉 → 宿主 127 也会被判 fatal (S-45 同款假阳性)。
    const ps = diagnose(
      green({
        smoke: [{ exe: 'node', host: { code: 0, out: 'v20' }, jail: { code: 127, out: '' } }],
      }),
    );
    expect(ps).toHaveLength(1);
    expect(ps[0]?.level).toBe('fatal');
    expect(ps[0]?.what).toContain('node');
    expect(ps[0]?.fix).toContain('bind');
  });

  test('★ 反面锚: 宿主都不通 (127) → **不报**(宿主没装 ≠ jail 缺 bind)', () => {
    // 同一行 127 必须区分"宿主缺"与"jail 缺" —— 写反等于把"装环境"的方向指到"补挂载面"。
    const ps = diagnose(
      green({
        smoke: [{ exe: 'totally-missing', host: { code: 127, out: '' }, jail: { code: 127, out: '' } }],
      }),
    );
    expect(ps).toEqual([]);
  });

  test('★★ GWT-7b sandbox 起不来 → fatal 且 fix 含 reason 原文', () => {
    // 内核不给 unprivileged user namespace 是 bwrap 在容器/老内核里最常见的失败模式。
    // 判词必须把 reason 字面带回去 —— 用户拿去排错只有那一条字符串, 改一个字就找不到原报。
    // 怎么让它红: 删掉 `if (!input.sandbox.ok)` 那条 → 本条返空。
    const ps = diagnose(green({ sandbox: { ok: false, reason: 'unprivileged user namespace disabled' } }));
    expect(ps).toHaveLength(1);
    expect(ps[0]?.level).toBe('fatal');
    expect(ps[0]?.fix).toContain('unprivileged user namespace disabled');
  });

  test('★ preflight 问题原样透传 —— diagnose 不二次包装', () => {
    // 二次包装会丢"哪条 argv 触发的"那条证据; GWT-7 之外已经有 verifier 看过 preflight 的判词。
    const pre = [{ level: 'warn', what: 'no git bind (S-34)', fix: 'add gitBinds' }] as const;
    const ps = diagnose(green({ preflight: pre }));
    expect(ps).toContainEqual({ level: 'warn', what: 'no git bind (S-34)', fix: 'add gitBinds' });
  });

  test('★ 多条 smoke (jail 多 exe 缺) → 逐条 fatal', () => {
    // 一个仓用到多生态时, 一个 bind 漏掉不该把别的也吞掉。
    const ps = diagnose(
      green({
        ecosystems: [
          { id: 'node', executables: ['node'] },
          { id: 'python', executables: ['python3'] },
        ],
        smoke: [
          { exe: 'node', host: { code: 0, out: '' }, jail: { code: 127, out: '' } },
          { exe: 'python3', host: { code: 0, out: '' }, jail: { code: 0, out: '' } },
        ],
      }),
    );
    const fatals = ps.filter((p) => p.level === 'fatal');
    expect(fatals).toHaveLength(1);
    expect(fatals[0]?.what).toContain('node');
  });

  test('★ sandbox 不通 + smoke 全 127 噪音的对照 —— 由 IO 壳负责不让 smoke 跑', () => {
    // 这条不直接测 diagnose (它接受的是已收好的输入); 但**正向**说清契约:
    // 当 sandbox.ok=false 时, IO 壳应该跳过 smoke (smoke=[]), 否则会出现
    // "bwrap 不通" + "node 在 jail 跑不起来" 两条 fatal, 第二条把第一条盖住。
    // 本条守住: 只 sandbox 一条 fatal。
    const ps = diagnose(green({ sandbox: { ok: false, reason: 'bwrap: nosuid' }, smoke: [] }));
    expect(ps).toHaveLength(1);
    expect(ps[0]?.level).toBe('fatal');
    expect(ps[0]?.fix).toContain('bwrap: nosuid');
  });
});

describe('renderDoctor —— 文本与退出码', () => {
  test('★ 空问题 → 末行 `doctor: 0 fatal / 0 warn`, exitCode 0 (GWT-7c)', () => {
    const r = renderDoctor([]);
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain('doctor: 0 fatal / 0 warn');
    // 末行字面量稳 —— 验收脚本抓这行, 不能在中间塞空行。
    const lastLine = r.text.trimEnd().split('\n').pop();
    expect(lastLine).toBe('doctor: 0 fatal / 0 warn');
  });

  test('★ 任一 fatal → exitCode 1', () => {
    const r = renderDoctor([{ level: 'fatal', what: 'x', fix: 'y' }]);
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain('fatal | x | y');
  });

  test('★★ 只有 warn → exitCode 0 (warn 不抬高退码, doctor 仍要能干净退出)', () => {
    // 怎么让它红: 把 renderDoctor 里 `exitCode: fatal > 0 ? 1 : 0` 改成 `>= 1 ? 1 : 0` → 本条红。
    const r = renderDoctor([{ level: 'warn', what: 'no git bind', fix: 'add gitBinds' }]);
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain('doctor: 0 fatal / 1 warn');
  });

  test('★ 混合 fatal+warn → 计数各算各', () => {
    const r = renderDoctor([
      { level: 'fatal', what: 'a', fix: 'b' },
      { level: 'warn', what: 'c', fix: 'd' },
      { level: 'fatal', what: 'e', fix: 'f' },
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain('doctor: 2 fatal / 1 warn');
  });

  test('每行问题 = `level | what | fix`(三段, `|` 分隔)', () => {
    const r = renderDoctor([{ level: 'fatal', what: 'w', fix: 'f' }]);
    const lines = r.text.trimEnd().split('\n');
    expect(lines[0]).toBe('fatal | w | f');
  });
});
