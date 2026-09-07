/**
 * src/mcp/tools/goal-coord-gate.test —— #241 坐标机械校验闸接线 (W2-241 切片 2)。
 *
 * SDD: docs/plan/2026-08-25-w2-241-coord-validation.md。
 * 钉的是 goal.ts 的**接线点** (判定本身在 coord-check.test.ts 已绿, 切片 1):
 *   · detached spawn 之前过 coordIgnitionGate (goal 文本 + SDD 全文)
 *   · 非 detached ignitionPreflight 之前过同一函数
 *   · 违规同步拒 (逐条原文) / force 越闸留账 / 零命中零涟漪 (INV-W241-2/-4)
 *
 * 证伪方式 (逐条写在 test 注释): 摘掉任一接线点的 coordIgnitionGate 调用 → 对应 test 由绿转红。
 * 夹具惯例照 goal-ignition-dryrun.test.ts (同门 D3 闸的接线测试)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createGoalTool } from './goal';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { RunGoalResult } from '../../harness/goal/run-goal';
import type { CommandLeafRunner } from '../../harness/leaf-runners';

// ── fixture: 表壳合法 (先过 D3 空跑闸), 坐标缺陷放在细则散文里 ─────────────────
const tableShell = (extraProse: string): string =>
  [
    '# t',
    '## 契约 (Contracts)',
    '- G-1',
    '## 分解 (Breakdown)',
    '',
    '| 切片 | 写集 | 依赖 | verify |',
    '|---|---|---|---|',
    '| 1 a | src/foo.ts + test | — | bun test src/foo.test.ts |',
    '',
    extraProse,
    '',
    '## 非目标 (Non-goals)',
    '- 无',
  ].join('\n');

// 0f67293b 原案同形: 标识符锚定到真实存在的文件, 但符号是编的 (shape ③)。
const SDD_FAKE_SYMBOL = tableShell('细则: `zzzFabricatedSymbolQ` 在 `src/real.ts` 里, 照它改。');
// 干净: 零反引号坐标 → coordIgnitionGate 零命中 (INV-W241-4 零涟漪)。
const SDD_CLEAN = tableShell('细则: 按表实施即可。');
// 「新建」豁免: 路径不存在但同句写明新建 (shape ② 豁免)。
const SDD_NEW_FILE = tableShell('细则: 新建 `src/brand-new-thing.ts` 放置 loader。');

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-coordgate-'));
  dirs.push(d);
  // shape ③ 的锚定文件: 真实存在, 但不含编造的符号
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'real.ts'), 'export const realThing = 1;\n');
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

const makeTool = (root: string, seenSpawns: string[][], ranGoals: string[]) =>
  createGoalTool({
    runGoal: async (goal: string) => {
      ranGoals.push(goal);
      return emptyResult(goal);
    },
    runRegistry: new RunRegistry(),
    cwd: root,
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    continuity: { manager: new CheckpointManager(root), repoRoot: root },
    commandRunner: passingRunner,
    spawnDetached: (cmd) => {
      seenSpawns.push(cmd as string[]);
      return 4242;
    },
  });

describe('#241 坐标机械校验闸 — detached 接线点 (spawn 之前)', () => {
  test('GWT★: 编造符号 SDD + detached=true → 同步拒, 零 spawn, 回执逐字含原文与文件', async () => {
    // 证伪: 摘掉 detached 块里的 coordIgnitionGate 调用 → 本 test 红 (worker 起来后才炸,
    // 而本 test 关键是 spawn 之前同步拒 —— 与 D3 fatal 同款语义)。
    const seenSpawns: string[][] = [];
    const root = freshRoot();
    const tool = makeTool(root, seenSpawns, []);
    const out = await call(tool, { goal: '按 SDD 干', detached: true, sddPath: tmpSdd(root, SDD_FAKE_SYMBOL) });

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('#241 坐标机械校验');
    expect(out.content[0]!.text).toContain('zzzFabricatedSymbolQ'); // 编造符号原文进回执
    expect(out.content[0]!.text).toContain('src/real.ts'); // 锚定文件点名
    expect(seenSpawns).toHaveLength(0); // spawn 之前拒
  });

  test('force=true → 越闸放行, spawn 照发 (留账走 logger, 本 test 只验放行)', async () => {
    // 证伪: 把 coordIgnitionGate 里 force 短路删掉 → 本 test 红 (放行变成拒)。
    const seenSpawns: string[][] = [];
    const root = freshRoot();
    const tool = makeTool(root, seenSpawns, []);
    const out = await call(tool, { goal: '按 SDD 干', detached: true, force: true, sddPath: tmpSdd(root, SDD_FAKE_SYMBOL) });
    expect(out.isError).not.toBe(true);
    expect(seenSpawns).toHaveLength(1);
  });

  test('干净 SDD → 行为与今天逐字节一致 (零涟漪, spawn 照发)', async () => {
    const seenSpawns: string[][] = [];
    const root = freshRoot();
    const tool = makeTool(root, seenSpawns, []);
    const out = await call(tool, { goal: '按 SDD 干', detached: true, sddPath: tmpSdd(root, SDD_CLEAN) });
    expect(out.isError).not.toBe(true);
    expect(seenSpawns).toHaveLength(1);
  });

  test('「新建」豁免: 路径不存在但同句写明新建 → 不拦 (shape ② 豁免正例)', async () => {
    const seenSpawns: string[][] = [];
    const root = freshRoot();
    const tool = makeTool(root, seenSpawns, []);
    const out = await call(tool, { goal: '按 SDD 干', detached: true, sddPath: tmpSdd(root, SDD_NEW_FILE) });
    expect(out.isError).not.toBe(true);
    expect(seenSpawns).toHaveLength(1);
  });
});

describe('#241 坐标机械校验闸 — 非 detached 接线点 (goal 文本, 无 sddPath)', () => {
  test('GWT★: goal 文本引用不存在的 path:line → 同步拒, runGoal 不被调', async () => {
    // 证伪: 摘掉非 detached 块的 coordIgnitionGate 调用 → 本 test 红 (runGoal 会真跑)。
    const ranGoals: string[] = [];
    const root = freshRoot();
    const tool = makeTool(root, [], ranGoals);
    const out = await call(tool, { goal: '修 `src/definitely-missing.ts:12` 那个函数' });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('#241 坐标机械校验');
    expect(out.content[0]!.text).toContain('src/definitely-missing.ts');
    expect(ranGoals).toHaveLength(0);
  });

  test('goal 文本零坐标 → runGoal 照跑 (零涟漪)', async () => {
    const ranGoals: string[] = [];
    const root = freshRoot();
    const tool = makeTool(root, [], ranGoals);
    const out = await call(tool, { goal: '做一件与坐标无关的活' });
    expect(out.isError).not.toBe(true);
    expect(ranGoals).toHaveLength(1);
  });
});

// ── 2026-09-07 Web 子集: 用户 goal 里的未存在路径只告警不拒 ──────────────────────
describe('#241 — goal 文本形状 ② 降级为告警', () => {
  test('★ goal 提到将要产出的 `www/fix-report.json` (盘上不在) → 照常点火 (证伪: 去掉 goal+path-missing 分流 ⇒ 红)', async () => {
    const ranGoals: string[] = [];
    const root = freshRoot();
    const tool = makeTool(root, [], ranGoals);
    const out = await call(tool, { goal: 'Write the build results into `www/fix-report.json`.' });
    expect(out.isError).not.toBe(true);
    expect(ranGoals).toHaveLength(1);
  });
  test('goal 里编造的符号 (形状 ③) 仍拒 (降级没扩到别的形状)', async () => {
    const ranGoals: string[] = [];
    const root = freshRoot();
    const tool = makeTool(root, [], ranGoals);
    const out = await call(tool, { goal: 'call `zzzFabricatedSymbolQ` in `src/real.ts`' });
    expect(out.isError).toBe(true);
    expect(ranGoals).toHaveLength(0);
  });
});
