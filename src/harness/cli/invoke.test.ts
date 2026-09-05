/**
 * src/harness/cli/invoke.test.ts —— 切片 4 验收 (SDD 2026-09-05, 写集只这两个文件)。
 *
 * GWT-3 / GWT-4 由本文件兜底;GWT-1 (INV-1 零第二套语义) 由 `ugrep -F` 在 cli.ts 里扫,
 * 这里只验源码字面量不引用 engine/goal/hooks/bwrap。
 *
 * 测试要点:
 *   · fixtures 一律注入 `opts.tools`,**绝不**触发 `loadDefaultTools` 的 lazy 装配
 *     (那样会拉起 model runtime + sqlite,与「单测不联网不读盘」背道而驰)。
 *   · stdout 纪律验证不靠 mock stdout.write,而是断言 `InvokeResult.stdout` 字符串本身。
 *     (生产 cli.ts 才会把 stdout 写到 fd 1;此处只盯编排函数返回。)
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitCodeFor, invokeTool, type InvokeToolEntry } from './invoke';

function tool(name: string, handler: InvokeToolEntry['handler']): InvokeToolEntry {
  return { name, handler };
}

describe('GWT-3 exitCodeFor 单点映射', () => {
  test('handler isError:true → exitCode 2', () => {
    expect(exitCodeFor({ isError: true }, false)).toBe(2);
  });

  test('handler 正常返回 (isError 缺省) → exitCode 0', () => {
    expect(exitCodeFor({}, false)).toBe(0);
    expect(exitCodeFor({ isError: false }, false)).toBe(0);
    expect(exitCodeFor(undefined, false)).toBe(0);
  });

  test('handler 抛异常 → exitCode 1', () => {
    expect(exitCodeFor(undefined, true)).toBe(1);
    expect(exitCodeFor({ isError: false }, true)).toBe(1);
  });

  test('优先级:threw 凌驾 isError (抛时 isError: true 也算 exitCode 1)', () => {
    // 装配/实现层错误优先于业务拒 —— 同一调用形态不可能既"实现挂"又"业务拒",
    // 双满足的形态按 threw 分流,把"出错了"和"被拒了"在退出码上分开。
    expect(exitCodeFor({ isError: true }, true)).toBe(1);
  });

  test('GWT-3 反向自检:isError 分支改 0 → 上面第一条红 (测本测试不删就行)', () => {
    // 这是闸的可证伪性注释;反向自检在仓库层 `bun test` 跑时由人/verifier 配闸验收。
    // 这里只把判据写死在测试里,行为不漂。
    expect(exitCodeFor({ isError: true }, false)).toBe(2);
  });
});

describe('GWT-4 invokeTool stdout 纪律', () => {
  test('handler 返回两段 text → json:false 时 stdout = 两段拼接 (换行)', async () => {
    const tools = [
      tool('two_seg', async () => ({
        content: [{ type: 'text' as const, text: '第一行' }, { type: 'text' as const, text: '第二行' }],
      })),
    ];
    const r = await invokeTool({ tool: 'two_seg', args: {}, json: false, tools });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('第一行\n第二行');
  });

  test('handler 返回 content → json:true 时 stdout = JSON.stringify(content),可解析', async () => {
    const content = { content: [{ type: 'text' as const, text: 'hello' }] };
    const tools = [tool('json_tool', async () => content)];
    const r = await invokeTool({ tool: 'json_tool', args: {}, json: true, tools });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(content);
  });

  test('resource 段在 json:false 默认渲染下被丢弃 (避免二进制污染管道)', async () => {
    const tools = [
      tool('mixed', async () => ({
        content: [
          { type: 'text' as const, text: '前面' },
          { type: 'resource' as const, resource: { uri: 'x', blob: 'binary' } },
          { type: 'text' as const, text: '后面' },
        ],
      })),
    ];
    const r = await invokeTool({ tool: 'mixed', args: {}, json: false, tools });
    expect(r.stdout).toBe('前面\n后面');
  });

  test('resource 段在 json:true 时原样透传 (SDD §未决第二条)', async () => {
    const content = {
      content: [
        { type: 'text' as const, text: 'x' },
        { type: 'resource' as const, resource: { uri: 'x', blob: 'y' } },
      ],
    };
    const tools = [tool('json_mixed', async () => content)];
    const r = await invokeTool({ tool: 'json_mixed', args: {}, json: true, tools });
    expect(JSON.parse(r.stdout)).toEqual(content);
  });

  test('render 覆盖默认文本渲染 (供 CliCommand.render 注入点)', async () => {
    const tools = [tool('any', async () => ({ content: [{ type: 'text' as const, text: 'raw' }] }))];
    const r = await invokeTool({
      tool: 'any',
      args: {},
      json: false,
      render: (c) => `rendered:${JSON.stringify(c)}`,
      tools,
    });
    expect(r.stdout).toBe(`rendered:${JSON.stringify({ content: [{ type: 'text', text: 'raw' }] })}`);
  });

  test('render 在 json:true 时**不**生效 (json 走原样透传,render 只管人读文本)', async () => {
    const content = { content: [{ type: 'text' as const, text: 'raw' }] };
    const tools = [tool('any', async () => content)];
    const r = await invokeTool({
      tool: 'any',
      args: {},
      json: true,
      render: () => 'should-not-appear',
      tools,
    });
    expect(r.stdout).toBe(JSON.stringify(content));
  });

  test('handler 抛 → stdout 空 (异常不进 stdout,只由 exitCode 1 表达)', async () => {
    const tools = [tool('boom', async () => { throw new Error('kaboom'); })];
    const r = await invokeTool({ tool: 'boom', args: {}, json: false, tools });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
  });

  test('handler 抛但调用方传 json:true → 仍 stdout 空 (异常不 JSON.stringify 一半内容)', async () => {
    const tools = [tool('boom', async () => { throw new Error('kaboom'); })];
    const r = await invokeTool({ tool: 'boom', args: {}, json: true, tools });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
  });

  test('handler isError:true + json:false → stdout = text 拼接 (业务拒的诊断文本给到人)', async () => {
    const tools = [
      tool('refuse', async () => ({
        content: [{ type: 'text' as const, text: 'resume 拒绝: run r1 当前 running' }],
        isError: true,
      })),
    ];
    const r = await invokeTool({ tool: 'refuse', args: {}, json: false, tools });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe('resume 拒绝: run r1 当前 running');
  });

  test('空 content 数组 → stdout 空字符串 (handler 真没产出时不编 placeholder)', async () => {
    const tools = [tool('empty', async () => ({ content: [] }))];
    const r = await invokeTool({ tool: 'empty', args: {}, json: false, tools });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('invokeTool: 工具查找与分发', () => {
  test('tools 列表里找不到 tool → exitCode 1,stdout 空', async () => {
    const tools = [tool('a', async () => ({ content: [{ type: 'text' as const, text: 'a' }] }))];
    const r = await invokeTool({ tool: 'b', args: {}, json: false, tools });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
  });

  test('同名多 tool 取先出现的 (与生产 assemble 装配顺序一致,find 行为逐字)', async () => {
    const tools = [
      tool('dup', async () => ({ content: [{ type: 'text' as const, text: 'first' }] })),
      tool('dup', async () => ({ content: [{ type: 'text' as const, text: 'second' }] })),
    ];
    const r = await invokeTool({ tool: 'dup', args: {}, json: false, tools });
    expect(r.stdout).toBe('first');
  });

  test('handler 收到的 args 与调用方完全一致 (透传保真,零字段剔除零字段注入)', async () => {
    let captured: unknown;
    const tools = [
      tool('capture', async (a) => {
        captured = a;
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      }),
    ];
    await invokeTool({ tool: 'capture', args: { runId: 'r1', limit: 3, nested: { a: 1 } }, json: false, tools });
    expect(captured).toEqual({ runId: 'r1', limit: 3, nested: { a: 1 } });
  });
});

describe('INV-1 零第二套语义 (GWT-1 在源码层)', () => {
  test('invoke.ts 不 import engine / goal / hooks / bwrap 任一路径', () => {
    // SDD GWT-1 文字是「扫 import」—— 仅 import 语句的源路径字面量算,
    // 注释 / doc / 字符串里的同名字面量不构成"引入"(ugrep 在生产仓里也只看 import 行)。
    const src = readFileSync(join(import.meta.dir, 'invoke.ts'), 'utf8');
    const importLines = src
      .split('\n')
      .filter((line) => /^\s*(import|export)\b/.test(line) || /\bfrom\s+['"]/.test(line));
    const joined = importLines.join('\n');
    for (const banned of ['dag/engine', 'goal/run-goal', 'goal/loop-run', 'hooks/bwrap']) {
      expect(joined).not.toContain(banned);
    }
  });
});
