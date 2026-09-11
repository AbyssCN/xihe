/**
 * agy-leaf —— Google 订阅 CLI 带工具 leaf 的形状钉。
 * 反向自检 (2026-09-11 写时实跑):
 *   · 从 agyLeafArgv 拿掉 `--add-dir` → 「argv 必带 --add-dir」红 (实测不传时 agy 写到 ~/.gemini 的 scratch 目录);
 *   · 删掉 createAgyLeafRunner 里的越界检查 → 「写集越界事后拒」红。
 */
import { describe, expect, test } from 'bun:test';
import { agyLeafArgv, agyWriteViolations, createAgyLeafRunner, diskDeltaPaths, parseAgyStream, withAgyLeaf } from './agy-leaf';

const ROOT = '/w/repo';
// 本机 agy 1.1.28 实测流 (2026-09-11 探针), 字段裁剪到本仓消费面。
const STREAM = [
  '{"event":"init","conversation_id":"c1","init":{"model":"gemini-3.8-flash-low","cwd":"/w/repo","tools":["write_to_file","run_command"]}}',
  '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":1.1,"usage":{"input_tokens":100,"output_tokens":10,"thinking_tokens":3,"cache_read_tokens":50}}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/w/repo/src/a.ts"}}}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/w/repo/src/a.ts"}}}}',
  '{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"bun test"}}}}',
  '{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"agent_response","text_delta":"done","usage":{"input_tokens":120,"output_tokens":5,"thinking_tokens":0,"cache_read_tokens":80}}}',
  '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"DONE","duration_seconds":9.9,"num_turns":1,"usage":{"input_tokens":220,"output_tokens":15,"thinking_tokens":3,"cache_read_tokens":130,"total_tokens":238}}}',
];

describe('parseAgyStream', () => {
  test('写文件步 → written; agent_response DONE 计 llmCalls; result 给 text/usage', () => {
    const p = parseAgyStream(STREAM);
    expect(p.status).toBe('SUCCESS');
    expect(p.text).toBe('DONE');
    expect(p.written).toEqual(['/w/repo/src/a.ts']);
    expect(p.toolCalls).toBe(2);
    expect(p.shellRuns).toBe(1);
    expect(p.llmCalls).toBe(2);
    expect(p.usage?.input_tokens).toBe(220);
  });
  test('非 JSON 行跳过, 无 result → status null', () => {
    const p = parseAgyStream(['Loading…', STREAM[3]!]);
    expect(p.status).toBeNull();
    expect(p.toolCalls).toBe(0); // ACTIVE 不计, 只计 DONE
  });
});

describe('agyLeafArgv', () => {
  test('argv 必带 --add-dir <root>、--dangerously-skip-permissions、-p 连写、stream-json', () => {
    const argv = agyLeafArgv('gemini-3.8-flash-high', 'do it', ROOT);
    const i = argv.indexOf('--add-dir');
    expect(i).toBeGreaterThan(0);
    expect(argv[i + 1]).toBe(ROOT);
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(argv).toContain('-p=do it');
    expect(argv).toContain('stream-json');
  });
});

describe('agyWriteViolations', () => {
  test('无写集声明 → 不对账', () => {
    expect(agyWriteViolations(['/w/repo/x.ts'], undefined, ROOT)).toEqual([]);
    expect(agyWriteViolations(['/w/repo/x.ts'], [], ROOT)).toEqual([]);
  });
  test('集内放行, 集外列出 (root 相对路径)', () => {
    expect(agyWriteViolations(['/w/repo/src/a.ts', '/w/repo/docs/b.md'], ['src/**'], ROOT)).toEqual(['docs/b.md']);
  });
});

describe('createAgyLeafRunner / withAgyLeaf', () => {
  const spawnWith = (lines: string[], code = 0) => async (_argv: string[], o: { onLine: (l: string) => void }) => {
    for (const l of lines) o.onLine(l);
    return { code, stderr: '' };
  };
  const noDisk = () => new Map<string, string>();
  test('SUCCESS → 结果带 filesTouched (root 相对) / usage / 计数', async () => {
    const run = createAgyLeafRunner({ cwd: ROOT }, { spawn: spawnWith(STREAM), snapshot: noDisk });
    const r = await run({ prompt: 'p', model: 'agy-cli:gemini-3.8-flash-high', writeAllow: ['src/**'] });
    expect(r.text).toBe('DONE');
    expect(r.filesTouched).toEqual(['src/a.ts']);
    expect(r.usage).toEqual({ in: 350, out: 18, cacheHit: 130 });
    expect(r.toolCalls).toBe(2);
    expect(r.llmCalls).toBe(2);
  });
  test('写集越界事后拒: 文件已写但节点响亮失败, 败因列出越界文件', async () => {
    const run = createAgyLeafRunner({ cwd: ROOT }, { spawn: spawnWith(STREAM), snapshot: noDisk });
    await expect(run({ prompt: 'p', model: 'agy-cli:gemini-3.8-flash-high', writeAllow: ['docs/**'] })).rejects.toThrow(/src\/a\.ts/);
  });
  test('非 SUCCESS → 抛', async () => {
    const run = createAgyLeafRunner({ cwd: ROOT }, { spawn: spawnWith([STREAM[0]!], 1), snapshot: noDisk });
    await expect(run({ prompt: 'p', model: 'agy-cli:gemini-3.8-flash-high' })).rejects.toThrow(/未返回 SUCCESS/);
  });
  test('withAgyLeaf: 非 agy 坐标原样交给内层', async () => {
    let innerCalls = 0;
    const wrapped = withAgyLeaf(async () => { innerCalls++; return { text: 'inner', usage: { in: 1, out: 1 } }; }, { cwd: ROOT }, { spawn: spawnWith(STREAM), snapshot: noDisk });
    expect((await wrapped({ prompt: 'p', model: 'minimax-cn:MiniMax-M3' })).text).toBe('inner');
    expect((await wrapped({ prompt: 'p', model: 'agy-cli:gemini-3.8-flash-high' })).text).toBe('DONE');
    expect(innerCalls).toBe(1);
  });
});

describe('盘面对账 (shell 重定向写的文件)', () => {
  test('diskDeltaPaths: 新增 / 变更 / 删除 都算 touched', () => {
    const before = new Map([['a.txt', ' M:10@1'], ['gone.txt', '??:3@1']]);
    const after = new Map([['a.txt', ' M:12@2'], ['runs/new.txt', '??:12@3']]);
    expect(diskDeltaPaths(before, after)).toEqual(['a.txt', 'gone.txt', 'runs/new.txt']);
  });
  test('流里零 write 步、盘面多了文件 → filesTouched 仍记到 (run e85f2715 那一格)', async () => {
    let n = 0;
    const snapshot = () => (n++ === 0 ? new Map<string, string>() : new Map([['runs/agy-probe.txt', '??:12@9']]));
    const streamNoWrite = STREAM.filter((l) => !l.includes('write_to_file'));
    const run = createAgyLeafRunner({ cwd: ROOT }, { spawn: async (_a, o) => { for (const l of streamNoWrite) o.onLine(l); return { code: 0, stderr: '' }; }, snapshot });
    const r = await run({ prompt: 'p', model: 'agy-cli:gemini-3.8-flash-high', writeAllow: ['runs/**'] });
    expect(r.filesTouched).toEqual(['runs/agy-probe.txt']);
  });
});
