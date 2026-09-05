/**
 * src/harness/cli/dispatch.test.ts —— 切片 6 (SDD 2026-09-05): cli.ts 接线验收。
 *
 * 写集只 src/harness/cli.ts 与本文件。`dispatchCli(args, deps?)` 是 cli.ts 导出的
 * 纯编排函数 —— 不在内部 process.exit,把出口(exitCode / stdout / stderr)返回出来,
 * 测试只盯返回值。生产 cli.ts 在 import.meta.main 块调 dispatchCli,按返回值落 fd 退码。
 *
 * 验收范围(每条都对得上 SDD 切片 6 的契约):
 *   · GWT-5: `--help` / `-h` / `help` / 空 → USAGE 走 stdout + exit 0;未知 → stderr + exit 1;
 *     `omd run --fixture <dir>` 与 `omd solve ...` 走 legacy (dispatchCli 返回 null)。
 *   · GWT-7: `omd doctor [repo]` 走 collectDoctorInput → renderDoctor;默认 cwd;fatal → exit 1。
 *   · GWT-8: 命名命令 argv 解析后透传给 handler;`--json` 控 invokeTool json 出口。
 *   · D-6: `omd run <task> --detached` → spawn worker (`--tool run` + `--args-json`),打印 runId + 退 0。
 *   · D-2: `omd call <tool> [--json ...]` 通用逃生口;位置参 tool + parseGenericArgs 余项。
 *   · 对账闸: USAGE 文本里既有 legacy 段,也有 registry 段 (renderUsage)。
 *
 * 测试要点:
 *   · `deps.tools` 注入替身 → invokeTool 不触发 lazy 装配(model runtime + sqlite)。
 *   · `deps.runSpawn` 注入替身 → detached run 不真起 Bun.spawn。
 *   · `deps.collectDoctorInput` 注入替身 → doctor 不真起 bwrap。
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  dispatchCli,
  type DispatchDeps,
  type DispatchResult,
} from '../cli';
import type { InvokeToolEntry } from './invoke';
import type {
  SolveSpawn,
  SolveSpawnHandle,
  SolveSpawnOpts,
} from '../cli-solve';
import type { DoctorInput } from '../hooks/doctor';

/** 模拟 handler:记 args + 返回受控 content。 */
function makeTool(
  name: string,
  response: { content: { type: 'text'; text: string }[]; isError?: boolean } | ((args: unknown) => Promise<unknown>),
): InvokeToolEntry {
  if (typeof response === 'function') {
    return { name, handler: response as InvokeToolEntry['handler'] };
  }
  return {
    name,
    handler: async () => response,
  };
}

/** 默认 deps:空 tool 表 + 不变 spawn + 静态 doctor 输入。 */
function depsWith(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    tools: [],
    ...over,
  };
}

/** 全绿 doctor 输入。 */
function greenDoctor(repo: string): DoctorInput {
  return {
    sandbox: { ok: true },
    ecosystems: [{ id: 'node', executables: ['node'] }],
    preflight: [],
    smoke: [{ exe: 'node', host: { code: 0, out: 'v20' }, jail: { code: 0, out: 'v20' } }],
  };
}

describe('GWT-5 dispatch: --help / 空 / 未知 / legacy 落空', () => {
  test('空 args → USAGE 走 stdout + exit 0 (CLI 惯例探活出口,Aalto bench adapter 同款)', async () => {
    const r = await dispatchCli([], depsWith());
    expect(r?.exitCode).toBe(0);
    expect(r?.stdout).toContain('omd —— DAG 执行引擎');
    expect(r?.stderr).toBe('');
  });

  test('--help → stdout + exit 0', async () => {
    const r = await dispatchCli(['--help'], depsWith());
    expect(r?.exitCode).toBe(0);
    expect(r?.stdout).toContain('omd —— DAG 执行引擎');
  });

  test('-h → stdout + exit 0', async () => {
    const r = await dispatchCli(['-h'], depsWith());
    expect(r?.exitCode).toBe(0);
    expect(r?.stdout).toContain('omd —— DAG 执行引擎');
  });

  test('help → stdout + exit 0', async () => {
    const r = await dispatchCli(['help'], depsWith());
    expect(r?.exitCode).toBe(0);
    expect(r?.stdout).toContain('omd —— DAG 执行引擎');
  });

  test('未知命令 → dispatch 返回 null (legacy else 分支在 cli.ts 内打 USAGE + exit 1)', async () => {
    // dispatchCli 不替 legacy 做未知判断 —— 那是 cli.ts 主进程 else 分支的职责。
    // 这里只盯 dispatch 的边界: 命中返 DispatchResult,未命中(含未知)返 null。
    const r = await dispatchCli(['not-a-real-cmd'], depsWith());
    expect(r).toBeNull();
  });

  test('omd run --fixture <dir> → dispatch 返回 null (legacy 接管, findCommand 排除)', async () => {
    // GWT-5 末: `omd run --fixture <dir>` 仍走 runWithFixture。findCommand 对含 --fixture 的 run 返回 undefined。
    const r = await dispatchCli(['run', '--fixture', '/tmp/fixture'], depsWith());
    expect(r).toBeNull();
  });

  test('omd solve "<g>" → dispatch 返回 null (cli-solve.ts 单独接管,findCommand 排除)', async () => {
    const r = await dispatchCli(['solve', 'some-goal'], depsWith());
    expect(r).toBeNull();
  });
});

describe('GWT-5 USAGE 由表生成 + 既有手写段保留在前', () => {
  test('USAGE 含 legacy 段 (mcp/tui/serve/init/touch/...)', async () => {
    const r = await dispatchCli(['--help'], depsWith());
    expect(r?.stdout).toContain('omd mcp');
    expect(r?.stdout).toContain('omd tui');
    expect(r?.stdout).toContain('omd serve');
    expect(r?.stdout).toContain('omd init');
    expect(r?.stdout).toContain('omd pack');
  });

  test('USAGE 含 registry 段 (status / map add / doctor / call)', async () => {
    const r = await dispatchCli(['--help'], depsWith());
    expect(r?.stdout).toContain('omd status');
    expect(r?.stdout).toContain('omd map add');
    expect(r?.stdout).toContain('omd doctor');
    expect(r?.stdout).toContain('omd call');
  });
});

describe('命名命令 → invokeTool (GWT-8 / INV-1)', () => {
  test('omd status <runId> → 调 dag_status handler,args 透传 runId', async () => {
    let captured: unknown;
    const tools = [
      makeTool('dag_status', async (args) => {
        captured = args;
        return { content: [{ type: 'text', text: 'runId: r1\nstatus: done' }] };
      }),
    ];
    const r = await dispatchCli(['status', 'r1'], depsWith({ tools }));
    expect(r?.exitCode).toBe(0);
    expect(r?.stdout).toBe('runId: r1\nstatus: done');
    expect(captured).toEqual({ runId: 'r1' });
  });

  test('omd status <runId> --json → stdout = JSON.stringify(content),handler 不收 json 字段', async () => {
    let captured: unknown;
    const tools = [
      makeTool('dag_status', async (args) => {
        captured = args;
        return { content: [{ type: 'text', text: 'raw' }] };
      }),
    ];
    const r = await dispatchCli(['status', 'r1', '--json'], depsWith({ tools }));
    expect(r?.exitCode).toBe(0);
    expect(JSON.parse(r!.stdout)).toEqual({ content: [{ type: 'text', text: 'raw' }] });
    // --json 是 CLI 出口信号,不进 handler (handler 不该看到 json 字段)
    expect(captured).toEqual({ runId: 'r1' });
  });

  test('omd map add --title "fix" --blocked-by a,b → 调 map_add,key 自动转 camelCase', async () => {
    let captured: unknown;
    const tools = [
      makeTool('map_add', async (args) => {
        captured = args;
        return { content: [{ type: 'text', text: 'ticket created' }] };
      }),
    ];
    const r = await dispatchCli(['map', 'add', '--title', 'fix', '--blocked-by', 'a,b'], depsWith({ tools }));
    expect(r?.exitCode).toBe(0);
    expect(captured).toEqual({ title: 'fix', blockedBy: 'a,b' });
  });

  test('handler isError:true → dispatch exitCode 2 (INV-3 单点, exitCodeFor 路径)', async () => {
    const tools = [
      makeTool('dag_status', async () => ({
        content: [{ type: 'text', text: 'run r1 是 running,不能 cancel' }],
        isError: true,
      })),
    ];
    const r = await dispatchCli(['status', 'r1'], depsWith({ tools }));
    expect(r?.exitCode).toBe(2);
    expect(r?.stdout).toContain('不能 cancel');
  });

  test('handler 抛 → dispatch exitCode 1 (INV-3 单点)', async () => {
    const tools = [makeTool('dag_status', async () => { throw new Error('kaboom'); })];
    const r = await dispatchCli(['status', 'r1'], depsWith({ tools }));
    expect(r?.exitCode).toBe(1);
    expect(r?.stdout).toBe('');
  });

  test('argv 解析错误 (多余位置参) → dispatch exitCode 1,stderr 含原因,handler 不调', async () => {
    let called = 0;
    const tools = [
      makeTool('dag_status', async () => {
        called += 1;
        return { content: [{ type: 'text', text: 'ok' }] };
      }),
    ];
    const r = await dispatchCli(['status', 'r1', 'extra'], depsWith({ tools }));
    expect(r?.exitCode).toBe(1);
    expect(r?.stderr).toContain('status');
    expect(called).toBe(0);
  });

  test('tools 注入里找不到 tool → dispatch exitCode 1 (registry 与装配面漂移的响应)', async () => {
    const r = await dispatchCli(['status', 'r1'], depsWith({ tools: [] }));
    expect(r?.exitCode).toBe(1);
    expect(r?.stdout).toBe('');
  });
});

describe('D-2 omd call <tool> 通用逃生口', () => {
  test('omd call my_tool --key value → 调 my_tool handler,args 透传 key', async () => {
    let captured: unknown;
    const tools = [
      makeTool('my_tool', async (args) => {
        captured = args;
        return { content: [{ type: 'text', text: 'done' }] };
      }),
    ];
    const r = await dispatchCli(['call', 'my_tool', '--key', 'value'], depsWith({ tools }));
    expect(r?.exitCode).toBe(0);
    expect(captured).toEqual({ key: 'value' });
  });

  test('omd call my_tool --json "{\\"k\\":1}" → 调 my_tool,args = parsed object', async () => {
    let captured: unknown;
    const tools = [
      makeTool('my_tool', async (args) => {
        captured = args;
        return { content: [{ type: 'text', text: 'done' }] };
      }),
    ];
    const r = await dispatchCli(['call', 'my_tool', '--json', '{"k":1}'], depsWith({ tools }));
    expect(r?.exitCode).toBe(0);
    expect(captured).toEqual({ k: 1 });
  });

  test('omd call my_tool --json ... → stdout JSON (CLI --json 控 invokeTool 出口)', async () => {
    const tools = [
      makeTool('my_tool', async () => ({ content: [{ type: 'text', text: 'hello' }] })),
    ];
    const r = await dispatchCli(['call', 'my_tool', '--json', '{}'], depsWith({ tools }));
    expect(r?.exitCode).toBe(0);
    expect(JSON.parse(r!.stdout)).toEqual({ content: [{ type: 'text', text: 'hello' }] });
  });

  test('omd call 无 tool 位置参 → exitCode 1,stderr 含用法', async () => {
    const r = await dispatchCli(['call'], depsWith({ tools: [] }));
    expect(r?.exitCode).toBe(1);
    expect(r?.stderr).toContain('call');
  });

  test('omd call <tool> 多余位置参 → exitCode 1', async () => {
    const r = await dispatchCli(['call', 't', 'extra'], depsWith({ tools: [] }));
    expect(r?.exitCode).toBe(1);
  });

  test('omd call my_tool --json 不是合法 JSON → exitCode 1,stderr 含原因', async () => {
    const r = await dispatchCli(['call', 'my_tool', '--json', '{not-json'], depsWith({ tools: [] }));
    expect(r?.exitCode).toBe(1);
    expect(r?.stderr).toContain('JSON');
  });
});

describe('GWT-7 omd doctor', () => {
  test('doctor [repo] → 调 collectDoctorInput(repo), diagnose, renderDoctor;末行 fatal/warn 计数', async () => {
    let capturedRepo: string | undefined;
    const deps = depsWith({
      collectDoctorInput: async (repoRoot: string) => {
        capturedRepo = repoRoot;
        return greenDoctor(repoRoot);
      },
    });
    const r = await dispatchCli(['doctor', '/repo/root'], deps);
    expect(r?.exitCode).toBe(0);
    expect(r?.stdout).toContain('doctor: 0 fatal / 0 warn');
    expect(capturedRepo).toBe('/repo/root');
  });

  test('doctor 无位置参 → repoRoot = process.cwd() (缺省 cwd)', async () => {
    let capturedRepo: string | undefined;
    const deps = depsWith({
      collectDoctorInput: async (repoRoot: string) => {
        capturedRepo = repoRoot;
        return greenDoctor(repoRoot);
      },
    });
    const r = await dispatchCli(['doctor'], deps);
    expect(r?.exitCode).toBe(0);
    expect(capturedRepo).toBe(process.cwd());
  });

  test('doctor 命中 fatal → exitCode 1,渲染 `level | what | fix` 行 + 末行 fatal 计数', async () => {
    const deps = depsWith({
      collectDoctorInput: async () => ({
        sandbox: { ok: false, reason: 'unprivileged user namespace disabled' },
        ecosystems: [],
        preflight: [],
        smoke: [],
      }),
    });
    const r = await dispatchCli(['doctor', '/repo'], deps);
    expect(r?.exitCode).toBe(1);
    expect(r?.stdout).toContain('fatal | bwrap 在这台机器上起不来');
    expect(r?.stdout).toContain('unprivileged user namespace disabled');
    expect(r?.stdout).toContain('doctor: 1 fatal / 0 warn');
  });

  test('doctor 多条 fatal+warn → 逐行 `level | what | fix`,末行各算各 (GWT-7)', async () => {
    const deps = depsWith({
      collectDoctorInput: async () => ({
        sandbox: { ok: true },
        ecosystems: [{ id: 'node', executables: ['node'] }],
        preflight: [{ level: 'warn', what: 'no git bind', fix: 'add gitBinds' }],
        smoke: [{ exe: 'node', host: { code: 0, out: '' }, jail: { code: 127, out: '' } }],
      }),
    });
    const r = await dispatchCli(['doctor', '/repo'], deps);
    expect(r?.exitCode).toBe(1);
    expect(r?.stdout).toContain('warn | no git bind | add gitBinds');
    expect(r?.stdout).toContain('fatal |');
    expect(r?.stdout).toContain('doctor: 1 fatal / 1 warn');
  });

  test('doctor 仅 warn → exitCode 0 (warn 不抬高退码;GWT-7c 反向自检)', async () => {
    const deps = depsWith({
      collectDoctorInput: async () => ({
        sandbox: { ok: true },
        ecosystems: [],
        preflight: [{ level: 'warn', what: 'no git bind', fix: 'add gitBinds' }],
        smoke: [],
      }),
    });
    const r = await dispatchCli(['doctor', '/repo'], deps);
    expect(r?.exitCode).toBe(0);
    expect(r?.stdout).toContain('doctor: 0 fatal / 1 warn');
  });
});

describe('D-6 omd run <task> --detached (D-6 转发矩阵)', () => {
  test('--detached → spawn worker (--tool run + --args-json),stdout 仅 runId,退 0', async () => {
    let captured: { cmd: string[]; opts: SolveSpawnOpts } | undefined;
    const runSpawn: SolveSpawn = ((cmd: string[], opts: SolveSpawnOpts): SolveSpawnHandle => {
      captured = { cmd, opts };
      return {
        exited: new Promise(() => {}),
        unref: () => {},
        pid: 9999,
      };
    }) as SolveSpawn;
    const r = await dispatchCli(['run', '把 README 第一行原样打印', '--detached'], depsWith({ runSpawn }));
    expect(r?.exitCode).toBe(0);
    expect(captured).toBeDefined();
    expect(captured!.opts.detached).toBe(true);
    expect(captured!.opts.stdio).toEqual(['ignore', 'ignore', 'ignore']);
    expect(captured!.opts.cwd).toBe(process.cwd());
    // spawn cmd = ['bun','run',<worker>,'--run-id',<id>,'--cwd',<cwd>,'--tool','run','--args-json',<json>]
    expect(captured!.cmd[0]).toBe('bun');
    expect(captured!.cmd[1]).toBe('run');
    expect(captured!.cmd[2]!.endsWith('scripts/goal-worker.ts')).toBe(true);
    const argsIdx = captured!.cmd.indexOf('--args-json');
    expect(argsIdx).toBeGreaterThan(0);
    const parsed = JSON.parse(captured!.cmd[argsIdx + 1]!);
    expect(parsed.task).toBe('把 README 第一行原样打印');
    // --tool run 显式带(GWT-6 同款)
    expect(captured!.cmd).toContain('--tool');
    expect(captured!.cmd[captured!.cmd.indexOf('--tool') + 1]).toBe('run');
    // stdout = runId 行(且只有这行)
    expect(r?.stdout.trim()).toMatch(/^runId: [0-9a-f-]{36}$/);
  });

  test('--detached spawn 抛 → exitCode 1,stderr 含原因', async () => {
    const runSpawn: SolveSpawn = (() => {
      throw new Error('bun not found');
    }) as SolveSpawn;
    const r = await dispatchCli(['run', 'task', '--detached'], depsWith({ runSpawn }));
    expect(r?.exitCode).toBe(1);
    expect(r?.stderr).toContain('bun not found');
    expect(r?.stdout).toBe('');
  });

  test('--detached 与 --max-fanout 共存 → args-json 含 maxFanout (P0 2026-08-10 同形:不静默丢)', async () => {
    let captured: { cmd: string[] } | undefined;
    const runSpawn: SolveSpawn = ((cmd: string[]) => {
      captured = { cmd };
      return { exited: new Promise(() => {}), unref: () => {}, pid: 1 };
    }) as SolveSpawn;
    const r = await dispatchCli(['run', 'task', '--detached', '--max-fanout', '4'], depsWith({ runSpawn }));
    expect(r?.exitCode).toBe(0);
    const argsIdx = captured!.cmd.indexOf('--args-json');
    const parsed = JSON.parse(captured!.cmd[argsIdx + 1]!);
    expect(parsed.maxFanout).toBe(4);
    // --detached 是 CLI 编排信号(与 cli-solve.ts detached 路径同款:不二次塞进 args-json)
    expect(parsed.detached).toBeUndefined();
  });

  test('omd run <task> 无 --detached → 走 invokeTool 路径,不 spawn (D-4 真跑)', async () => {
    let called = 0;
    const tools = [
      makeTool('run', async (args) => {
        called += 1;
        return { content: [{ type: 'text', text: 'runId: r1' }] };
      }),
    ];
    const r = await dispatchCli(['run', 'task', '--max-fanout', '4'], depsWith({ tools }));
    expect(r?.exitCode).toBe(0);
    expect(called).toBe(1);
    expect(r?.stdout).toBe('runId: r1');
  });

  test('--detached 与 --run-id (冲突字段) 共存 → --run-id 不进 args-json (单一路)', async () => {
    let captured: { cmd: string[] } | undefined;
    const runSpawn: SolveSpawn = ((cmd: string[]) => {
      captured = { cmd };
      return { exited: new Promise(() => {}), unref: () => {}, pid: 1 };
    }) as SolveSpawn;
    await dispatchCli(['run', 'task', '--detached', '--run-id', 'r1'], depsWith({ runSpawn }));
    const argsIdx = captured!.cmd.indexOf('--args-json');
    const parsed = JSON.parse(captured!.cmd[argsIdx + 1]!);
    // --run-id 由 worker 自己产 (randomUUID),不在 args-json 里二次传
    expect(parsed.runId).toBeUndefined();
  });
});

describe('INV-4 stdout 纪律 (GWT-4 已在 invoke.test.ts 覆盖, 这里端到端再钉)', () => {
  test('handler 抛 → stdout 空 (异常不污染 stdout)', async () => {
    const tools = [makeTool('dag_status', async () => { throw new Error('x'); })];
    const r = await dispatchCli(['status', 'r1'], depsWith({ tools }));
    expect(r?.exitCode).toBe(1);
    expect(r?.stdout).toBe('');
  });
});

describe('GWT-1 / INV-1 cli.ts 源码不 import engine / goal / hooks 内部件', () => {
  test('cli.ts 源码里 import 行不引用 dag/engine / goal/run-goal / goal/loop-run / hooks/bwrap', () => {
    // 反向自检: 实装改坏了 → 该行 import 重新出现 → 本条红。
    // 与 invoke.test.ts / commands.test.ts 同款。
    const src = require('node:fs').readFileSync(
      require('node:path').join(import.meta.dir, '..', 'cli.ts'),
      'utf8',
    );
    const importLines = src
      .split('\n')
      .filter((line: string) => /^\s*(import|export)\b/.test(line) || /\bfrom\s+['"]/.test(line));
    const joined = importLines.join('\n');
    for (const banned of ['dag/engine', 'goal/run-goal', 'goal/loop-run', 'hooks/bwrap']) {
      expect(joined, `banned import in cli.ts: ${banned}`).not.toContain(banned);
    }
    // 唯一例外是 ./hooks/doctor (切片 3 已在 doctor.ts 闸过 bwrap import)。
    // 这里只盯 cli.ts 的 import 行,doctor.ts 内部不查。
  });
});

describe('regression: dispatchCli 同一调用不会修改 process.argv (副作用隔离)', () => {
  test('dispatchCli 不读 process.argv 也不改它', async () => {
    const before = [...process.argv];
    await dispatchCli(['status', 'r1'], depsWith({ tools: [] }));
    expect(process.argv).toEqual(before);
  });
});