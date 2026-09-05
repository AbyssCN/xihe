/**
 * src/harness/cli-solve-detached.test.ts —— 切片 2 (2026-09-05): `omd solve --detached` 转发矩阵。
 *
 * 它要成立的那件事 (GWT-6, GWT-6b):
 *  · `omd solve "<g>" --detached --branch-strategy branch --sdd x.md`
 *    → spawn argv 含 `--tool dag_goal` `--branch-strategy branch` `--sdd-path x.md`
 *    (worker 端默认 --tool=dag_goal,但 spawn 那行明写,以便 grep/审计直接抓到)
 *  · `omd solve --sdd x.md` (无位置参 goal) → spawn argv 含 `--goal` 且值非空
 *    (worker 强制 --goal 必填,cli-solve 负责从 SDD 首部抽标题补齐;GWT-6b 修两路用法不一致)
 *  · worker 侧:`--tool <name>` (默认 dag_goal) + `--args-json '<obj>'` 直通 handler
 *    (给 `omd run --detached` / `omd call` 用,不可能为每个工具都列一份 flag 翻译)
 *  · cli-solve --detached: spawn 时 stdio 三件套 `ignore` + `unref()` + 不 await + 立刻 print runId + 退 0
 *    (与 MCP `detached:true` 同语义;母进程死带不走 worker)
 *
 * 反向自检 (O-6:本片得有一条实装前天然红的 verify):
 *  · 删 cli-solve 转发矩阵里 `--tool dag_goal` → GWT-6「spawn 含 --tool dag_goal」红
 *  · 删 worker `resolveToolAndArgs` 的 args-json 直通 → GWT-6 worker 侧红
 *  · 删 cli-solve 的 `deriveGoalFromSdd` → GWT-6b 红
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  deriveGoalFromSdd,
  parseSolveArgs,
  runSolveCLI,
  solveWorkerScriptPath,
  type SolveSpawn,
  type SolveSpawnHandle,
  type SolveSpawnOpts,
} from './cli-solve';
import { resolveToolAndArgs } from '../../scripts/goal-worker';

let dirs: string[] = [];
let stderrSnap: string[] = [];
let stdoutSnap: string[] = [];
let origStderrWrite: typeof process.stderr.write;
let origStdoutWrite: typeof process.stdout.write;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-det-csolve-'));
  dirs.push(d);
  return d;
}
function snapStderr(): string {
  return stderrSnap.join('');
}
function snapStdout(): string {
  return stdoutSnap.join('');
}

beforeEach(() => {
  stderrSnap = [];
  stdoutSnap = [];
  origStderrWrite = process.stderr.write.bind(process.stderr);
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderrSnap.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return (origStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stdoutSnap.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return (origStdoutWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
});
afterEach(() => {
  process.stderr.write = origStderrWrite;
  process.stdout.write = origStdoutWrite;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** 通用 fake spawn 工厂:记 cmd+opts;detached 路径模拟 unref 调用。 */
interface DetachedFakeSpawn {
  fn: SolveSpawn;
  capture: { cmd: string[]; opts: SolveSpawnOpts; unrefCalls: number; calls: number };
}
function makeDetachedFake(): DetachedFakeSpawn {
  const capture: { cmd: string[]; opts: SolveSpawnOpts; unrefCalls: number; calls: number } = {
    cmd: [],
    opts: { cwd: '', stdio: ['ignore', 'ignore', 'ignore'] },
    unrefCalls: 0,
    calls: 0,
  };
  const fn = ((cmd: string[], opts: SolveSpawnOpts): SolveSpawnHandle => {
    capture.cmd = cmd;
    capture.opts = opts;
    capture.calls += 1;
    return {
      exited: new Promise(() => { /* detached: 永不 resolve,模拟 worker 在飞 */ }),
      unref: () => {
        capture.unrefCalls += 1;
      },
      pid: 4242,
    };
  }) as SolveSpawn;
  return { fn, capture };
}

describe('GWT-6 cli-solve --detached 转发矩阵', () => {
  test('solve "<g>" --detached --branch-strategy branch --sdd x.md → spawn 含 --tool dag_goal + --branch-strategy + --sdd-path', async () => {
    const cwd = tmp();
    const sddPath = join(cwd, 'plan.md');
    writeFileSync(sddPath, '# Title\nbody\n');
    const resultOut = join(cwd, '.omd', 'solve-results', 't.md');
    const { fn, capture } = makeDetachedFake();

    const code = await runSolveCLI(
      ['probe-goal', '--cwd', cwd, '--detached', '--branch-strategy', 'branch', '--sdd', sddPath, '--result-out', resultOut],
      { spawn: fn },
    );

    expect(code).toBe(0);
    expect(capture.calls).toBe(1);
    expect(capture.opts.detached).toBe(true);
    // stdio ignore (三件套,与 MCP detached 同语义)
    expect(capture.opts.stdio).toEqual(['ignore', 'ignore', 'ignore']);
    expect(capture.opts.cwd).toBe(cwd);
    expect(capture.unrefCalls).toBe(1);

    // cmd 形参: bun run <worker> --run-id ... --cwd ... --goal ... --branch-strategy branch --sdd-path ... --result-out ...
    expect(capture.cmd[0]).toBe('bun');
    expect(capture.cmd[1]).toBe('run');
    expect(capture.cmd[2]).toBe(solveWorkerScriptPath());

    const pairs: [string, string][] = [];
    for (let i = 0; i < capture.cmd.length; i += 1) {
      if (capture.cmd[i]!.startsWith('--')) pairs.push([capture.cmd[i]!, capture.cmd[i + 1] ?? '']);
    }
    const map = new Map(pairs);
    expect(map.get('--tool')).toBe('dag_goal');          // 显式带(默认即此值,但 spawn 那行明写)
    expect(map.get('--branch-strategy')).toBe('branch');  // P0 (2026-08-10) 不再静默丢
    expect(map.get('--sdd-path')).toBe(sddPath);         // CLI --sdd,worker --sdd-path
    expect(map.get('--goal')).toBe('probe-goal');        // 位置参原样
    expect(map.get('--cwd')).toBe(cwd);
    expect(map.get('--run-id')).toBeDefined();
  });

  test('detached: stdout 含 runId 行, stderr 静默 (与 MCP detached 同语义)', async () => {
    const cwd = tmp();
    const { fn, capture } = makeDetachedFake();
    const code = await runSolveCLI(['p', '--cwd', cwd, '--detached'], { spawn: fn });

    expect(code).toBe(0);
    const runId = capture.cmd[capture.cmd.indexOf('--run-id') + 1]!;
    expect(snapStdout()).toContain(`runId: ${runId}`);
    // stdout 只有一个 runId 行 + 末尾换行 (不夹日志/不夹 outcome/不夹 resultOut 路径)
    expect(snapStdout().trim()).toBe(`runId: ${runId}`);
  });

  test('detached: 不读 resultOut,缺文件也不退 3', async () => {
    const cwd = tmp();
    // resultOut 不存在;非 detached 路径会退 3,detached 路径不该去看它
    const { fn } = makeDetachedFake();
    const code = await runSolveCLI(['p', '--cwd', cwd, '--detached', '--result-out', '/no/such/result.md'], { spawn: fn });
    expect(code).toBe(0);
  });

  test('detached: 不带 --branch-strategy → spawn 不含 --branch-strategy (缺省 head 逐字节不展开,INV-1)', async () => {
    const cwd = tmp();
    const { fn, capture } = makeDetachedFake();
    await runSolveCLI(['p', '--cwd', cwd, '--detached'], { spawn: fn });
    expect(capture.cmd).not.toContain('--branch-strategy');
  });
});

describe('GWT-6b cli-solve --sdd 单独在场 → --goal 从 SDD 首部抽', () => {
  test('--sdd 无位置参 goal → spawn 含 --goal 且值 = SDD 顶行标题', async () => {
    const cwd = tmp();
    const sddPath = join(cwd, 'plan.md');
    writeFileSync(sddPath, '# CLI 主入口 —— 执行契约\nbody body\n');
    const { fn, capture } = makeDetachedFake();
    const code = await runSolveCLI(['--cwd', cwd, '--detached', '--sdd', sddPath], { spawn: fn });

    expect(code).toBe(0);
    const goalIdx = capture.cmd.indexOf('--goal');
    expect(goalIdx).toBeGreaterThanOrEqual(0);
    const goalVal = capture.cmd[goalIdx + 1]!;
    expect(goalVal.length).toBeGreaterThan(0);
    expect(goalVal).toBe('CLI 主入口 —— 执行契约');
  });

  test('--sdd 给文件但顶行不是 # 标题 → usage 退 1, 零 spawn', async () => {
    const cwd = tmp();
    const sddPath = join(cwd, 'plan.md');
    writeFileSync(sddPath, 'plain text without heading\nbody\n');
    const { fn, capture } = makeDetachedFake();
    const code = await runSolveCLI(['--cwd', cwd, '--detached', '--sdd', sddPath], { spawn: fn });
    expect(code).toBe(1);
    expect(capture.calls).toBe(0);
    expect(snapStderr()).toContain("'# …' 标题");
  });

  test('--sdd 路径不存在 → usage 退 1, 零 spawn (不动 spawn,留证据)', async () => {
    const cwd = tmp();
    const { fn, capture } = makeDetachedFake();
    const code = await runSolveCLI(['--cwd', cwd, '--detached', '--sdd', '/no/such/sdd.md'], { spawn: fn });
    expect(code).toBe(1);
    expect(capture.calls).toBe(0);
    expect(snapStderr()).toContain('--sdd 文件读取失败');
  });

  test('deriveGoalFromSdd 纯函数:首行 # 后到行尾,空白剥除', () => {
    const d = tmp();
    const p = join(d, 's.md');
    writeFileSync(p, '#   标题 with 空白  \n## not used\nbody\n');
    expect(deriveGoalFromSdd(p)).toBe('标题 with 空白');
  });
});

describe('worker --tool + --args-json 直通 (GWT-6 run --detached 的对应面)', () => {
  test('--tool run --args-json "{...}" → (run, args) 二元组直传 handler', () => {
    const argv = [
      '--run-id', 'r1',
      '--cwd', '/w',
      '--tool', 'run',
      '--args-json', '{"task":"把 README 第一行原样打印","maxFanout":4,"branchStrategy":"branch"}',
    ];
    const r = resolveToolAndArgs(argv);
    expect(r.tool).toBe('run');
    expect(r.args).toEqual({
      task: '把 README 第一行原样打印',
      maxFanout: 4,
      branchStrategy: 'branch',
    });
  });

  test('不传 --tool → 默认 dag_goal + 走 buildHandlerArgs 矩阵 (向后兼容旧 spawn)', () => {
    const argv = ['--run-id', 'r1', '--cwd', '/w', '--goal', 'g', '--tier', 'simple', '--max-rounds', '3'];
    const r = resolveToolAndArgs(argv);
    expect(r.tool).toBe('dag_goal');
    expect(r.args).toMatchObject({
      goal: 'g',
      resume: 'r1',
      tier: 'simple',
      maxRounds: 3,
    });
  });

  test('非 dag_goal 不带 --args-json → 抛 (主流程 exit 2)', () => {
    expect(() => resolveToolAndArgs(['--run-id', 'r1', '--cwd', '/w', '--tool', 'run'])).toThrow(
      /--tool run 必须配 --args-json/,
    );
  });

  test('--args-json 不是对象 (数组 / 字符串 / null) → 抛', () => {
    expect(() => resolveToolAndArgs(['--run-id', 'r1', '--tool', 'run', '--args-json', '[1,2,3]'])).toThrow(/JSON 对象/);
    expect(() => resolveToolAndArgs(['--run-id', 'r1', '--tool', 'run', '--args-json', '"x"'])).toThrow(/JSON 对象/);
    expect(() => resolveToolAndArgs(['--run-id', 'r1', '--tool', 'run', '--args-json', 'null'])).toThrow(/JSON 对象/);
  });

  test('--args-json 解析失败 → 抛 (JSON.parse 错误原文透传)', () => {
    expect(() => resolveToolAndArgs(['--run-id', 'r1', '--tool', 'run', '--args-json', '{not-json'])).toThrow(
      /--args-json 解析失败/,
    );
  });

  test('--args-json 配上 --goal/--sdd-path 之类老 flag 时,以 args-json 为准 (单一路,不混两路)', () => {
    // 旧 spawn 形态的 flag 在 --args-json 模式下**不**被读 —— 双路并存会出第三种行为。
    const argv = [
      '--run-id', 'r1', '--tool', 'run',
      '--args-json', '{"task":"t"}',
      '--goal', 'should-be-ignored',
      '--sdd-path', '/also/ignored.md',
    ];
    const r = resolveToolAndArgs(argv);
    expect(r.args).toEqual({ task: 't' });
  });
});

describe('parseSolveArgs: --detached 字段透传', () => {
  test('--detached → parsed.detached === true', () => {
    const r = parseSolveArgs(['g', '--detached'], '/w');
    expect(r.detached).toBe(true);
  });
  test('无 --detached → parsed.detached 不存在 (老调用方逐字节不变)', () => {
    const r = parseSolveArgs(['g'], '/w');
    expect(r.detached).toBeUndefined();
    expect('detached' in r).toBe(false);
  });
});
