/**
 * agy-cli-complete —— Google 订阅 CLI 完成位的形状钉。
 * 反向自检 (2026-09-11 写时实跑): 把 agyCompleteArgv 的 `-p=${prompt}` 改成两个 argv (`-p`, prompt)
 * → 「-p 连写」用例红 (本机实测那样写 agy 会把下一个 flag 当 prompt)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  agyCompleteArgv,
  agyCompleteRaw,
  agyUsageToModelUsage,
  parseAgyJson,
  serializeForAgy,
  setAgySpawnForTest,
} from './agy-cli-complete';

const RESULT = '{"conversation_id":"f7","status":"SUCCESS","response":"OK\\n","duration_seconds":1.1,"num_turns":1,"usage":{"input_tokens":6878,"output_tokens":1,"thinking_tokens":5,"cache_read_tokens":8135,"total_tokens":6879}}';

afterEach(() => setAgySpawnForTest(null));

describe('agyCompleteArgv', () => {
  test('-p 连写 + 只读 plan 模式 + json 输出, 无 --add-dir', () => {
    const argv = agyCompleteArgv('gemini-3.8-flash-low', 'hello world');
    expect(argv[0]).toBe('agy');
    expect(argv).toContain('-p=hello world');
    expect(argv.indexOf('-p')).toBe(-1);
    expect(argv.slice(argv.indexOf('--mode'), argv.indexOf('--mode') + 2)).toEqual(['--mode', 'plan']);
    expect(argv).toContain('json');
    expect(argv).not.toContain('--add-dir');
  });
});

describe('parseAgyJson / usage', () => {
  test('取最后一个 JSON 对象行, 提示行被跳过', () => {
    const r = parseAgyJson(`some login notice\n${RESULT}\n`);
    expect(r?.status).toBe('SUCCESS');
    expect(r?.response).toBe('OK\n');
  });
  test('usage 换算: cache_read 并进 in, thinking 计入 out', () => {
    const u = agyUsageToModelUsage(parseAgyJson(RESULT)!.usage);
    expect(u).toEqual({ in: 6878 + 8135, out: 1 + 5, cacheHit: 8135 });
  });
  test('没有 JSON 行 → null', () => {
    expect(parseAgyJson('Error: not logged in')).toBeNull();
  });
});

describe('serializeForAgy', () => {
  test('system 前置, 单 user 原样', () => {
    expect(serializeForAgy([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }])).toBe('S\n\nU');
  });
  test('多轮带角色标注', () => {
    const s = serializeForAgy([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
    expect(s).toBe('[user]\na\n\n[assistant]\nb\n\n[user]\nc');
  });
});

describe('agyCompleteRaw', () => {
  test('SUCCESS → text + usage; argv 带模型 id', async () => {
    let seen: string[] = [];
    setAgySpawnForTest(async (argv) => {
      seen = argv;
      return { code: 0, stdout: RESULT, stderr: '' };
    });
    const r = await agyCompleteRaw('gemini-3.8-flash-high', [{ role: 'user', content: 'hi' }], { model: 'agy-cli:gemini-3.8-flash-high', messages: [] } as never);
    expect(r.text).toBe('OK\n');
    expect(r.usage.out).toBe(6);
    expect(seen).toContain('gemini-3.8-flash-high');
  });
  test('非 SUCCESS → 抛, 带 stderr 尾', async () => {
    setAgySpawnForTest(async () => ({ code: 1, stdout: '', stderr: 'quota exhausted for Gemini Models' }));
    await expect(
      agyCompleteRaw('gemini-3.8-flash-high', [{ role: 'user', content: 'hi' }], { model: 'x', messages: [] } as never),
    ).rejects.toThrow(/quota exhausted/);
  });
});
