/**
 * src/mcp/tools/goal-ignition-dryrun.test —— D3 sddPath 点火空跑闸接线 (切片 3)。
 *
 * SDD: docs/plan/2026-08-25-d3-sdd-ignition-dryrun.md (修订 #267)。
 *
 * 钉的是 goal.ts 的**接线点**, 不是 dryRunSddIgnition 的判定本身 (切片 1 已绿):
 *   · detached spawn 之前过同一道闸
 *   · 非 detached 走 ignitionPreflight 之前过同一道闸
 *   · fatal / fallback / force / ok 四出口语义按 INV-D3-2
 *
 * 反向自检统一形状 (照 goal-detached / goal-first-ignition.test 惯例):
 *  ① 命中分支 + 关键文本 (D3 fatal / D3 fallback / 缺的文件名 / force 越闸 reason);
 *  ② 真源 = `sddIgnitionDryRunGate` (goal.ts 内单一函数, 不在每处抄一份);
 *  ③ 证伪方式写在每条 test 注释 —— 「摘掉任一调用点 / 改 fatal 出口 / 把 force 短路」 → 由绿转红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createGoalTool, sddFallbackRouteHint } from './goal';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { RunGoalResult } from '../../harness/goal/run-goal';
import type { CommandLeafRunner } from '../../harness/leaf-runners';

// ── fixture 表壳 (照 sdd-ignition-check.test 同样形状, 本测试不复述 parseBreakdown 的反向自检) ──
const tableShell = (rows: string[]): string =>
  [
    '# t',
    '## 契约 (Contracts)',
    '- G-1',
    '## 分解 (Breakdown)',
    '',
    '| 切片 | 写集 | 依赖 | verify |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## 非目标 (Non-goals)',
    '- 无',
  ].join('\n');

// fatal: 分解段无表 (parseBreakdown 抛) —— 触发 fatal 闸
const SDD_FATAL = '# t\n## 契约 (Contracts)\n- G-1\n## 分解 (Breakdown)\n散文没有表\n## 非目标\n- 无';
// fallback: 两片写集相交 —— compileBreakdown 抛 → fallback。
// 2026-09-04 换过一次样本: 原样本是「写集含 dag/types.ts 缺 seams.md」, 而 #243 登记面
// 由**拒**改**扩**之后那份 SDD 变成 ok, 不再能钉这一支 (它会往下走到 #251 判据自证闸,
// 测的就不是 D3 了)。写集相交同样走 compileBreakdown 抛这条路, INV-D3-1 逐字不变。
const SDD_FALLBACK_MISSING_SEAM = tableShell([
  '| 1 a | src/foo.ts | — | bun test src/foo.test.ts |',
  '| 2 b | src/foo.ts | 1 | bun test src/bar.test.ts |',
]);
// ok: 行内最小合法 (verify 是命令串, 写集无绊线)
const SDD_OK = tableShell([
  '| 1 a | src/foo.ts + test | — | bun test src/foo.test.ts |',
  '| 2 b | src/bar.ts + test | 1 | bun test src/bar.test.ts |',
]);

// ── 临时仓 + 装配 ──────────────────────────────────────────────────────────
const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-dryrun-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmpSdd = (root: string, text: string): string => {
  const p = join(root, 'docs', 'plan', 'sdd.md');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
};

const emptyResult = (goal: string): RunGoalResult => ({
  goal,
  tier: 'simple',
  acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
  stages: [],
  sources: [],
  repoContext: '',
  converged: true,
  outcome: 'success' as const,
  rounds: 1,
  reusedNodes: [],
});

const call = (tool: ReturnType<typeof createGoalTool>, args: Record<string, unknown>) =>
  tool.handler(args as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;

const passingRunner: CommandLeafRunner = async () => ({
  text: '',
  usage: { in: 0, out: 0 },
  timedOut: false,
  signal: null,
  exitCode: 0,
});

// ═══════════════════════════════════════════════════════════════════════════
// detached × 接线点 1: spawn 之前过同一道闸
// ═══════════════════════════════════════════════════════════════════════════

describe('D3 sddPath 点火空跑闸 (detached 接线点 · spawn 之前)', () => {
  test('GWT★: fatal SDD + detached=true → 同步错误回执, 零 spawn, registry 无此 run', async () => {
    // SDD S3 测试细则点名: 无表 SDD + detached=true → 同步错误回执, 断言零 spawn (替身注入),
    // registry 无此 run。证伪: 摘掉 detached 接线点的 sddIgnitionDryRunGate 调用 → 本 test 红
    // (workder 起来后才会因 parseBreakdown 抛, 但那时 spawn 已发生, registry 也已在 worker 侧
    // —— 而本 test 关键就是 **spawn 之前** 同步拒)。
    const seenSpawns: string[][] = [];
    const root = freshRoot();
    const registry = new RunRegistry();
    const tool = createGoalTool({
      runGoal: async () => {
        throw new Error('detached 路径不该在母进程里跑 runGoal');
      },
      runRegistry: registry,
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: passingRunner,
      spawnDetached: (cmd) => {
        seenSpawns.push(cmd);
        return 4242;
      },
    });
    const out = await call(tool, { goal: '长活的活', detached: true, sddPath: tmpSdd(root, SDD_FATAL) });

    expect(out.isError).toBe(true);
    // ★ 错误原文进回执 —— 调用方拿它直接改 SDD (INV-D3-1 「err 原文带出」)
    expect(out.content[0]!.text).toContain('D3 fatal');
    expect(out.content[0]!.text).toContain('没有切片行'); // parseBreakdown 原 message
    // ★ 零 spawn (改 SDD 的成本不附带一个 worker)
    expect(seenSpawns).toHaveLength(0);
    // ★ 零 registry 记录 (run 都没出生)
    expect(registry.listRuns()).toHaveLength(0);
  });

  test('GWT★: fallback SDD + detached=true → 同步拒, 文本含 reason 原文', async () => {
    // 写集含 types.ts 缺 seams.md 是真源绊线 (sdd-compile.ts:156 assertSeamWriteSet) —— 错误文本
    // 进回执, 调用方拿它直接改 SDD (加 docs/architecture/seams.md 到写集并集)。证伪: 在 helper
    // 里给 reason 加前缀 → 本 test 红 (那破坏「原文带出」)。
    const seenSpawns: string[][] = [];
    const root = freshRoot();
    const registry = new RunRegistry();
    const tool = createGoalTool({
      runGoal: async () => {
        throw new Error('detached 路径不该在母进程里跑 runGoal');
      },
      runRegistry: registry,
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: passingRunner,
      spawnDetached: (cmd) => {
        seenSpawns.push(cmd);
        return 1;
      },
    });
    const out = await call(tool, { goal: '干', detached: true, sddPath: tmpSdd(root, SDD_FALLBACK_MISSING_SEAM) });

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('D3 fallback');
    // reason 原文带出 (INV-D3-1): assertDisjointWriteSets 的 message 逐字进回执,
    // 调用方拿它直接改 SDD (拆开写集或把两片并成一片)。
    expect(out.content[0]!.text).toContain('写集相交');
    expect(out.content[0]!.text).toContain('src/foo.ts');
    expect(seenSpawns).toHaveLength(0);
    expect(registry.listRuns()).toHaveLength(0);
  });

  test('GWT★: 同一份 fallback SDD + detached=true + force=true → 放行, spawn 真发生', async () => {
    // INV-D3-2: force=true 是 owner 显式越闸, 放行并在日志留账 (沿 INV-5 force 旧惯例, 不另造
    // 第二本账)。证伪: 把 force 分支改成 return sync reject → 本 test 红 (那条是 owner 越闸的
    // 合法人工路径, 不能掐死)。
    const seenSpawns: string[][] = [];
    const root = freshRoot();
    const registry = new RunRegistry();
    const tool = createGoalTool({
      runGoal: async () => {
        throw new Error('detached 路径不该在母进程里跑 runGoal');
      },
      runRegistry: registry,
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: passingRunner,
      spawnDetached: (cmd) => {
        seenSpawns.push(cmd);
        return 7;
      },
    });
    const out = await call(tool, {
      goal: '强越闸',
      detached: true,
      force: true,
      sddPath: tmpSdd(root, SDD_FALLBACK_MISSING_SEAM),
    });

    expect(out.isError).toBeUndefined();
    // spawn 真发生 (force 越闸后 fallback 不再阻, 路径走完整)
    expect(seenSpawns).toHaveLength(1);
    expect(out.content[0]!.text).toContain('pid 7');
  });

  test('★: 合法 SDD + detached=true → 行为与今天一致 (闸放行, spawn 发生, 回执含 runId)', async () => {
    // SDD S3 测试细则点名: 合法 SDD → 行为与今天一致。证伪: 把 dryrun 闸无条件 return isError →
    // 本 test 红 (合法 SDD 被误拒, 等于把整条 sddPath 直通路径掐死)。
    const seenSpawns: string[][] = [];
    const root = freshRoot();
    const registry = new RunRegistry();
    const tool = createGoalTool({
      runGoal: async () => {
        throw new Error('detached 路径不该在母进程里跑 runGoal');
      },
      runRegistry: registry,
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: passingRunner,
      spawnDetached: (cmd) => {
        seenSpawns.push(cmd);
        return 9;
      },
    });
    const out = await call(tool, { goal: 'g', detached: true, sddPath: tmpSdd(root, SDD_OK) });

    expect(out.isError).toBeUndefined();
    expect(seenSpawns).toHaveLength(1);
    expect(out.content[0]!.text).toContain('runId:');
    expect(out.content[0]!.text).toContain('pid 9');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 非 detached × 接线点 2: ignitionPreflight 之前过同一道闸 (单一函数, 不另造)
// ═══════════════════════════════════════════════════════════════════════════

describe('D3 sddPath 点火空跑闸 (非 detached 接线点 · ignitionPreflight 之前)', () => {
  test('GWT★: fatal SDD + 非 detached → 同步错误, 文本含 err 原文, runGoal 不跑', async () => {
    // 拒了的 run 不进 registry、不进 runGoal、不建 worktree (与 ignitionPreflight blocked 同档)。
    // 证伪: 在非 detached 接线点漏调 sddIgnitionDryRunGate → 本 test 红 (因为 ignitionPreflight
    // 只查写集相交, 看不到 parseBreakdown 抛)。
    let runGoalCalls = 0;
    const root = freshRoot();
    const registry = new RunRegistry();
    const tool = createGoalTool({
      runGoal: async (goal) => {
        runGoalCalls++;
        return emptyResult(goal);
      },
      runRegistry: registry,
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: passingRunner,
    });
    const out = await call(tool, { goal: 'sddPath', sddPath: tmpSdd(root, SDD_FATAL) });

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('D3 fatal');
    expect(out.content[0]!.text).toContain('没有切片行');
    // 闸拒 → runGoal / registry 都不该被打扰
    expect(runGoalCalls).toBe(0);
    expect(registry.listRuns()).toHaveLength(0);
  });

  test('GWT★: fallback SDD + 非 detached → 同步拒, 文本含 reason 原文', async () => {
    const root = freshRoot();
    const registry = new RunRegistry();
    const tool = createGoalTool({
      runGoal: async (goal) => emptyResult(goal),
      runRegistry: registry,
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: passingRunner,
    });
    const out = await call(tool, { goal: 'sddPath', sddPath: tmpSdd(root, SDD_FALLBACK_MISSING_SEAM) });

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('D3 fallback');
    expect(out.content[0]!.text).toContain('写集相交');
    expect(out.content[0]!.text).toContain('src/foo.ts');
    expect(registry.listRuns()).toHaveLength(0);
  });

  test('GWT★: fallback SDD + 非 detached + force=true → 越闸放行 (下道闸拒不算 dryrun 拒)', async () => {
    // force 是 owner 越闸 —— 与 detached 接线点同款逻辑, 同函数 (sddIgnitionDryRunGate)。
    // 证伪: 把 force 分支短路 → 本 test 红 (owner 越闸的合法路径被掐)。
    // 注: 下游 checkIgnitionCriteria 会因 verify 列路径不在写集/盘上 → 拒 (missing-path
    // finding)。本测试**焦点在 dryrun 闸** —— 闸**没**拒 (文本无 D3 fallback/fatal 字样),
    // 即便下游拒; owner 看日志可知「dryrun 越闸了, 下一道闸拒了」两件事分开读, 不混。
    const root = freshRoot();
    const registry = new RunRegistry();
    const tool = createGoalTool({
      runGoal: async (goal) => emptyResult(goal),
      runRegistry: registry,
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: async () => ({
        text: '',
        usage: { in: 0, out: 0 },
        timedOut: false,
        signal: null,
        exitCode: 1,
      }),
    });
    const out = await call(tool, {
      goal: '强越闸',
      force: true,
      sddPath: tmpSdd(root, SDD_FALLBACK_MISSING_SEAM),
    });

    // ★ dryrun 闸**没**拒: 文本不含「D3 fatal」「D3 fallback」字样 (那是 dryrun 闸的出口)
    const text = out.content[0]!.text;
    expect(text).not.toContain('D3 fatal');
    expect(text).not.toContain('D3 fallback');
  });

  test('★: 合法 SDD + 非 detached → 闸放行, runGoal 真跑 (行为与今天一致)', async () => {
    // runner exit 1 让 checkIgnitionCriteria 不拒 (同上, 见 goal-first-ignition.test.ts 同款用法)。
    let runGoalCalls = 0;
    const root = freshRoot();
    const registry = new RunRegistry();
    const tool = createGoalTool({
      runGoal: async (goal) => {
        runGoalCalls++;
        return emptyResult(goal);
      },
      runRegistry: registry,
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: async () => ({
        text: '',
        usage: { in: 0, out: 0 },
        timedOut: false,
        signal: null,
        exitCode: 1,
      }),
    });
    const out = await call(tool, { goal: 'g', sddPath: tmpSdd(root, SDD_OK) });

    expect(out.isError).toBeUndefined();
    await Bun.sleep(5);
    expect(runGoalCalls).toBe(1);
    const runId = /runId: (\S+)/.exec(out.content[0]!.text)?.[1];
    expect(runId).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INV-D3-3 零涟漪: 非 sddPath 与真 resume 行为逐字节照旧
// ═══════════════════════════════════════════════════════════════════════════

describe('INV-D3-3 零涟漪 (非 sddPath / 真 resume 路径)', () => {
  test('★: 无 sddPath 的非 detached run → 闸缺席, 行为照旧', async () => {
    // 锁 INV-D3-3: 非 sddPath 点火, 闸缺席。证伪: 在 sddIgnitionDryRunGate 调用点无 sddPath 保护
    // → 本 test 仍跑得过 (它根本没 sddPath, loadSddContract 不会被调到)。
    let runGoalCalls = 0;
    const root = freshRoot();
    const tool = createGoalTool({
      runGoal: async (goal) => {
        runGoalCalls++;
        return emptyResult(goal);
      },
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: passingRunner,
    });
    const out = await call(tool, { goal: '普通' });
    expect(out.isError).toBeUndefined();
    await Bun.sleep(5);
    expect(runGoalCalls).toBe(1);
  });

  test('★: sddPath + 真 resume (registry failed) → 闸缺席, runGoal 真跑, 不拒', async () => {
    // 锁 INV-D3-3 + 真 resume 路径: resume 续跑不走 sddPath 点火闸 (它首跑已过)。证伪: 把 dryrun
    // 闸放在 `if (sddPath)` 而非 `if (sddPath && !trueResume)` → 真 resume 上本 test 红 (合法
    // 续跑被拒)。
    const root = freshRoot();
    const registry = new RunRegistry();
    registry.register('resume-real', { goal: '上轮' });
    registry.start('resume-real');
    registry.fail('resume-real', '挂了');
    let runGoalCalls = 0;
    const tool = createGoalTool({
      runGoal: async (goal) => {
        runGoalCalls++;
        return emptyResult(goal);
      },
      runRegistry: registry,
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: passingRunner,
    });
    // 故意用 fatal SDD —— 真 resume 路径不该被它挡住
    const out = await call(tool, {
      goal: '续跑',
      resume: 'resume-real',
      sddPath: tmpSdd(root, SDD_FATAL),
    });
    expect(out.isError).toBeUndefined();
    await Bun.sleep(5);
    expect(runGoalCalls).toBe(1);
  });

  test('★: 真 resume (journal 在场, runs.db 丢失) → 闸缺席, runGoal 真跑', async () => {
    // 第二证据: journal 在场 = 真 resume (D-1) —— 同等豁免。证伪: 把 journal 那条 evidence 短路
    // 只看 registry → 本 test 红 (两证据是 ∨ 不是 ∧, D-1 末段钉过)。
    const root = freshRoot();
    const cm = new CheckpointManager(root);
    cm.writeFixpointJournal('fix-j', {
      runId: 'fix-j',
      completedRounds: 1,
      poisoned: [],
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    let runGoalCalls = 0;
    const tool = createGoalTool({
      runGoal: async (goal) => {
        runGoalCalls++;
        return emptyResult(goal);
      },
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: cm, repoRoot: root },
      commandRunner: passingRunner,
    });
    const out = await call(tool, {
      goal: '续跑',
      resume: 'fix-j',
      sddPath: tmpSdd(root, SDD_FATAL),
    });
    expect(out.isError).toBeUndefined();
    await Bun.sleep(5);
    expect(runGoalCalls).toBe(1);
  });

  test('★: 借道首跑 (resume 字段非空但无 record ∧ 无 journal) → 闸跑, fatal 拒', async () => {
    // D-1: resume 字段非空但无 record ∧ 无 journal = 借道首跑 —— 走首跑路径, 闸跑, fatal 真拒。
    // 锁住这个边界: 「!trueResume」 必须按**真续跑证据**判, 不是按**参数面 resume 字段**。
    const root = freshRoot();
    const tool = createGoalTool({
      runGoal: async (goal) => emptyResult(goal),
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: passingRunner,
    });
    const out = await call(tool, {
      goal: 'sddPath',
      resume: 'ghost-id',
      sddPath: tmpSdd(root, SDD_FATAL),
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('D3 fatal');
  });
});
// ── D3 fallback 的路径建议行 (2026-09-04) ────────────────────────────────────
// 「分解表 verify 列全空」这句拒因逐字正确, 但读起来像「你切得不够细, 再切」——
// 收到它的人于是去把切片切得更碎, 而更碎的切片一样写不出 verify 列。真成因通常是
// **这活不该走 sddPath** (定位/调查类在动手前不知道根因)。建议只追加, 不改写拒因原文
// (INV-D3-1)。

describe('D3 fallback 路径建议 (sddFallbackRouteHint)', () => {
  test('verify 列全空 → 出建议, 点名换哪条路', () => {
    // 证伪: 把 sddFallbackRouteHint 改成恒返空串 → 本 test 由绿转红。
    const hint = sddFallbackRouteHint('分解表 verify 列全空, 推不出终局验收命令 (见 sdd-compile.acceptCommandFromBreakdown)');
    expect(hint).toContain('定位/调查');
    expect(hint).toContain('dag_debug');
    expect(hint).toContain('不给 sddPath');
  });

  test('契约本身写坏的那几种 (写集相交 / 依赖悬空) → 不出建议 (换路径解决不了)', () => {
    // 阴性对照: 建议只认「verify 列全空」这一种可机械分辨的成因; 分辨不了就不猜。
    // 证伪: 把 `includes('verify 列全空')` 判断删掉 (无条件出建议) → 本 test 转红。
    expect(sddFallbackRouteHint('切片 1 与切片 2 写集相交: src/a.ts — 并发跑会互相覆盖')).toBe('');
    expect(sddFallbackRouteHint('切片 2 依赖不存在的切片 9')).toBe('');
    expect(sddFallbackRouteHint('')).toBe('');
  });
});
