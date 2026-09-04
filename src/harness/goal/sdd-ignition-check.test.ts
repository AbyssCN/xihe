/**
 * src/harness/goal/sdd-ignition-check.test —— sddPath 点火空跑闸 (D3 · 切片 1)。
 *
 * SDD: docs/plan/2026-08-25-d3-sdd-ignition-dryrun.md
 *
 * 反向自检统一形状 (同 sdd-direct / sdd-compile / registration-faces.test):
 *  ① 每条分支配**已知违规样本**, 断言它返对终局 + 关键判词;
 *  ② 真源 = `dryRunSddIgnition`, 不在 goal.ts / run-goal.ts 另抄一份;
 *  ③ 证伪方式写在每条 test 注释 —— 「把 fatal 误判成 fallback / 把 fallback reason 改写 /
 *     把 ok 提前放过 → 此 test 由绿转红」, 一条永远绿的闸不是闸 (CLAUDE.md §1)。
 *
 * 实装前天然红: 写测试时 dryRunSddIgnition 还没实装 (上一片写集不含本测试) —— 抄不进。
 * slice 1 的真功能 = 把闸修出来, 让这些断言变绿。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadSddContract } from './sdd-direct';
import { dryRunSddIgnition, type SddIgnitionCheck } from './sdd-ignition-check';

// ── 最小表壳 (照 /omd-contract 钉死的四列: 切片 | 写集 | 依赖 | verify) ────────────────────
//
// 仅用于把**关注的那一格**钉死。表壳之外的契约/非目标段落, 不是 sdd-ignition-check 的判据
// 范围 (契约段是 loadSddContract 那侧的事 —— 见 sdd-direct.ts 的 REQUIRED_SECTIONS)。

const tableShell = (rows: string[]): string =>
  ['# t', '## 契约 (Contracts)', '- G-1', '## 分解 (Breakdown)', '', '| 切片 | 写集 | 依赖 | verify |', '|---|---|---|---|', ...rows, '', '## 非目标 (Non-goals)', '- 无'].join(
    '\n',
  );

describe('dryRunSddIgnition — fatal 分支 (parseBreakdown 抛)', () => {
  test('★ 分解段无表 (有标题但行都是散文) → fatal, err 含「没有切片行」原文', () => {
    // 钉 parseBreakdown 「」里没有切片行 —— 整份 SDD 缺结构, 让 worker 去推 = 静默让活体反例
    // (run 31cd3103, SDD 分解段无表) 重演。证伪: 把 dryRunSddIgnition 的 try-catch 去掉 → 本
    // test 由绿转红 (parseBreakdown 直接抛上来, 那条 fatal 分支没接住)。
    const sdd = '# t\n## 契约 (Contracts)\n- G-1\n## 分解 (Breakdown)\n散文没有表\n## 非目标\n- 无';
    const r = dryRunSddIgnition(sdd);
    expect(r.kind).toBe('fatal');
    if (r.kind !== 'fatal') throw new Error('unreachable');
    expect(r.err).toContain('没有切片行');
    // 致命错: err 是**原文**进回执, 不被改写 —— caller 要拿它直接改 SDD。
    expect(r.err).not.toMatch(/^$/);
  });

  test('★ 整份无分解段标题 → fatal, err 含「分解 (Breakdown) 段缺失」原文', () => {
    // 第二档 fatal: 连段标题都没有。证伪: 若实现改成「缺标题 fallback」 → 本 test 转红
    // (这条边界写在 SDD S1 细则「分解段无表 → fatal」里, 没标题没表 = 同级别缺口, 也 fatal)。
    const sdd = '# t\n## 契约 (Contracts)\n- G-1';
    const r = dryRunSddIgnition(sdd);
    expect(r.kind).toBe('fatal');
    if (r.kind !== 'fatal') throw new Error('unreachable');
    expect(r.err).toContain('分解 (Breakdown) 段缺失');
  });

  test('★ fatal.err 是 parseBreakdown 的原 message —— 调用方拿它直接改 SDD', () => {
    // 锁 SDD INV-D3-1 「`parseBreakdown` 抛 = fatal」 + 「err 原文进回执」: 不许改写成通用模板
    // (那正是「抄一份」的入口)。证伪: 把 err 改成「fatal: ${前缀}」之类 → 本 test 转红。
    const sdd = '# t\n## 契约 (Contracts)\n- G-1\n## 分解 (Breakdown)\n## 非目标\n- 无';
    const r = dryRunSddIgnition(sdd);
    if (r.kind !== 'fatal') throw new Error(`want fatal, got ${r.kind}`);
    expect(r.err.length).toBeGreaterThan(5);
    // 不许含「fallback」字样 (这分支注定是 fatal, 不许套娃)。
    expect(r.err).not.toMatch(/fallback/i);
  });
});

describe('dryRunSddIgnition — fallback 分支 (verify 列空 / compileBreakdown 抛)', () => {
  test('★ verify 列全空 → fallback, reason 钉「推不出终局验收命令」', () => {
    // 真源: acceptCommandFromBreakdown 在 verify 全空时返 undefined。SDD S1 测试细则显式点名
    // 这一档 = fallback, 而非 fatal (parseBreakdown 过了, 编译过不了是降级条件)。
    // 证伪: 把这一档归到 fatal → 本 test 转红 (那等于是把 fail-fast 误触, 把合法
    // "没验收命令 = 走分类器" 路径掐死)。
    const sdd = tableShell([
      '| 1 a | src/a.ts | — |  |',
      '| 2 b | src/b.ts | 1 |  |',
    ]);
    const r = dryRunSddIgnition(sdd);
    expect(r.kind).toBe('fallback');
    if (r.kind !== 'fallback') throw new Error('unreachable');
    expect(r.reason).toMatch(/verify.*全空|推不出终局验收命令/);
  });

  test('★ 2026-09-04 翻转: 写集含 types.ts 缺登记面 → ok (登记面由拒改扩, 不再阻断点火)', () => {
    // 改前这条是 fallback。#243 的登记面语义本来就是**授权**不是强制, 而那张表永远落后于仓,
    // 所以点火期改成自动扩容 (sdd-compile.expandRegistrationFaces), 不再拒。
    // 证伪: 把 expandRegistrationFaces 改回抛错 → 本 test 由绿转红。
    const sdd = tableShell(['| 1 types 改动 | src/harness/dag/types.ts | — | bun test src/dag/types.test.ts |']);
    expect(dryRunSddIgnition(sdd).kind).toBe('ok');
  });

  test('★ fallback.reason 是 compileBreakdown 原 message —— 调用方拿它直接改 SDD', () => {
    // 锁 INV-D3-1「fallback reason 原文带出」: 不许改写, 不许套前缀。证伪: 在 dryRunSddIgnition 里
    // 给 reason 加一行 `[sdd-ignition]` 前缀 → 本 test 转红。
    // 样本换成**写集相交** (原 types.ts 样本已随登记面翻转变成 ok) —— 它同样走
    // compileBreakdown 抛 → fallback 那条路, 测的不变量逐字不变。
    const sdd = tableShell([
      '| 1 a | src/a.ts | — | bun test src/a.test.ts |',
      '| 2 b | src/a.ts | 1 | bun test src/b.test.ts |',
    ]);
    const r = dryRunSddIgnition(sdd);
    if (r.kind !== 'fallback') throw new Error(`want fallback, got ${r.kind}`);
    expect(r.reason).toContain('写集相交');
    expect(r.reason.length).toBeGreaterThan(20);
    // 不许含「dryRunSddIgnition」/「sdd-ignition-check」这类模块名自指 (那是改写的典型形态)。
    expect(r.reason).not.toMatch(/dryRunSddIgnition|sdd-ignition-check/);
  });
});

describe('dryRunSddIgnition — ok 分支 (合法 SDD, 平铺图可编)', () => {
  test('★ 合法 SDD → ok (行内最小四列表)', () => {
    // 行内最小合法样本 —— 与 sdd-compile.test.ts 的 TWO fixture 同款结构 (1, 2 切片, 波形
    // {1} → {2}, verify = 命令串)。证伪: 若实现不接 compileBreakdown 的成功路径 → 本 test 转红。
    const sdd = tableShell([
      '| 1 a | src/a.ts + test | — | bun test src/a.test.ts |',
      '| 2 b | src/b.ts + test | 1 | bun test src/b.test.ts |',
    ]);
    const r = dryRunSddIgnition(sdd);
    const expected: SddIgnitionCheck = { kind: 'ok' };
    expect(r).toEqual(expected);
  });

  test('★ 真实 SDD: docs/plan/2026-08-21-p3-session-层-执行契约.md → ok', () => {
    // 用真 SDD 做正例 (同 sdd-direct.test.ts:165 的做法), 跑真实形状: 五列四列 · 命令串
    // verify (而不是 GWT 引用) · 波形与依赖列自洽 · 写集不相交。这条 SDD 的 verify 列写的
    // 是可执行命令 (与本仓先期 /omd-contract 兼容), 不是「G-1 前半、G-6」这种判定点引用
    // (后者在 acceptCommandFromBreakdown 眼里是空 verify, 落 fallback —— 见 structural boundary
    // test 那条)。
    //
    // 证伪: 把 assertSeamWriteSet 提前跑 (而非等到 compileBreakdown 内部) → 本 test 转红
    // (在 OK 路径上不触发, 但写错顺序会改变调用形态)。
    //
    // 注: 内环 v2 那份 (2026-08-11-inner-loop-v2-control-inversion.md) **故意**不是正例 ——
    // 它写在 /omd-contract 改 verify 必须为命令串**之前**, 列里是 GWT 引用, acceptCommandFromBreakdown
    // 推不出命令, 落 fallback 是**对**的结果。把它列为 ok 等于把"verify 列空"那条 fallback
    // 的闸给静默吃了。
    const c = loadSddContract(join(import.meta.dir, '../../../docs/plan/2026-08-21-p3-session-层-执行契约.md'));
    const r = dryRunSddIgnition(c.text);
    expect(r.kind).toBe('ok');
  });

  test('★ 真实 SDD (GWT 引用期): 2026-08-11-inner-loop-v2-control-inversion.md 落 fallback 是对的结果', () => {
    // 锁 SDD S1 「verify 列推不出验收命令 → fallback」在真实输入上的形状: 这份 SDD 是 /omd-contract
    // 改之前的产物 (verify 列写 GWT 引用「G-1 前半、G-6」, 不是命令串)。两条 fallback 入口任一
    // 命中都行 —— 这条 SDD 的 verify 列非空 (有「G-1 前半、G-6」这种文字), 所以走的是
    // compileBreakdown → assertRunnable 那一档 (它被命令白名单拒), 不是「verify 列推不出」。
    // 证伪: 把这一档归到 fatal (或 ok) → 本 test 转红 (那会把「判定点引用该走 fallback」
    // 的制度静默杀掉, 抄一份判据的入口)。
    //
    // 注: 这条是**两种 fallback 入口**的合并证据 —— 「verify 列空」那条 mini-test 已证明
    // verify == '' 时落 fallback, 本条则证明 verify ≠ '' 但又不是命令时同样落 fallback。
    const c = loadSddContract(join(import.meta.dir, '../../../docs/plan/2026-08-11-inner-loop-v2-control-inversion.md'));
    const r = dryRunSddIgnition(c.text);
    expect(r.kind).toBe('fallback');
    if (r.kind !== 'fallback') throw new Error('unreachable');
    // reason 进回执, 名字都发自底层闸 —— 原作者拿它直接改 SDD (改 verify 列为命令串)
    expect(r.reason.length).toBeGreaterThan(20);
  });
});

describe('dryRunSddIgnition — 三终局的相互边界 (这条闸会红的反例群)', () => {
  test('闸互斥: fatal 与 fallback 不重叠 —— 同一条输入不会同时命中两条分支', () => {
    // 三条 SDD 各钉一种分支, 不许错位 (证伪: 若 fatal / fallback 漏接一条 → 那条 SDD 的
    // 分支断言 转红; 若 fatal 里走 fallback → 这条测试的结构也转红)。
    const fatalSdd = '# t\n## 契约 (Contracts)\n- G-1\n## 分解 (Breakdown)\n散文\n## 非目标\n- 无';
    const fallbackVerifySdd = tableShell([
      '| 1 a | src/a.ts | — |  |',
      '| 2 b | src/b.ts | 1 |  |',
    ]);
    // 「compileBreakdown 抛」这一支的样本 = 写集相交。原 types.ts 登记面样本随 #243 由拒改扩
    // 变成了 ok, 不再能钉这一支。
    const fallbackCompileSdd = tableShell([
      '| 1 x | src/x.ts | — | bun test src/x.test.ts |',
      '| 2 y | src/x.ts | 1 | bun test src/y.test.ts |',
    ]);
    const okSdd = tableShell([
      '| 1 a | src/a.ts + test | — | bun test src/a.test.ts |',
      '| 2 b | src/b.ts + test | 1 | bun test src/b.test.ts |',
    ]);
    expect(dryRunSddIgnition(fatalSdd).kind).toBe('fatal');
    expect(dryRunSddIgnition(fallbackVerifySdd).kind).toBe('fallback');
    expect(dryRunSddIgnition(fallbackCompileSdd).kind).toBe('fallback');
    expect(dryRunSddIgnition(okSdd).kind).toBe('ok');
  });

  test('结构绊线: parseBreakdown 抛过的 SDD 不许绕过它被认成 ok (这条闸不恒绿)', () => {
    // 钉 SDD S1 细则「分解段无表 → fatal」 —— 即便 verify 列里写了合法命令, 整份契约缺结构
    // 还是 fatal (parseBreakdown 先抛, 没机会进 acceptCommandFromBreakdown)。
    // 证伪: 把 fatal 误改成「return { kind: 'ok' }」 → 本 test 红。
    const sdd =
      '# t\n## 契约 (Contracts)\n- G-1\n## 分解 (Breakdown)\n散文无表\n并行波形:{1} → {2}\n## 非目标\n- 无';
    expect(dryRunSddIgnition(sdd).kind).toBe('fatal');
  });
});
