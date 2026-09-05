/**
 * src/harness/cli/commands.test.ts —— 切片 5 验收 (SDD 2026-09-05, 写集只这两个文件)。
 *
 * 验收范围:
 *   · DAG_COMMANDS / MAP_COMMANDS / MEMORY_COMMANDS / CONFIG_COMMANDS 四张表导出且非空,
 *     path / tool / summary 字段格式与注册面 (TOOL_RENAMES) 对得上。
 *   · 命令 argv 映射:位置参 → camelCase handler key;flag 解析与 registry.ts 的 parseGenericArgs 一致。
 *   · renderStatus / renderRunResult 是纯函数;能识别 handler content 形态 (单 text 段 / JSON 串 / 字符串结果)。
 *
 * GWT-2 (对账闸) 走的是 assembleOmdMcpTools 注册名 vs CLI 表;那条断言在 registry.test.ts 已经验过,
 * 本文件只盯命令表的**自身形态**与渲染函数,不在这里重复组装。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  CONFIG_COMMANDS,
  DAG_COMMANDS,
  MAP_COMMANDS,
  MEMORY_COMMANDS,
  renderRunResult,
  renderStatus,
} from './commands';

describe('命令表导出与最小形态', () => {
  test('四张表都非空且类型是 readonly CliCommand[]', () => {
    for (const list of [DAG_COMMANDS, MAP_COMMANDS, MEMORY_COMMANDS, CONFIG_COMMANDS]) {
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      for (const cmd of list) {
        expect(cmd.path.length).toBeGreaterThan(0);
        expect(typeof cmd.summary).toBe('string');
        expect(cmd.summary.length).toBeGreaterThan(0);
        expect(typeof cmd.argv).toBe('function');
      }
    }
  });

  test('DAG_COMMANDS 含切片表约定的 16 个 path', () => {
    const paths = new Set(DAG_COMMANDS.map((c) => c.path.join(' ')));
    for (const want of [
      'run',
      'run-plan',
      'status',
      'result',
      'runs',
      'resume',
      'cancel',
      'intervene',
      'node-output',
      'research',
      'review',
      'debug',
      'deepen',
      'slim',
      'triage',
      'rule',
    ]) {
      expect(paths.has(want), `missing DAG path: ${want}`).toBe(true);
    }
  });

  test('MAP_COMMANDS 含切片表约定的 8 个 path', () => {
    const paths = new Set(MAP_COMMANDS.map((c) => c.path.join(' ')));
    for (const want of ['map init', 'map open', 'map add', 'map tickets', 'map rule', 'map confirm', 'map deliver', 'map prefetch']) {
      expect(paths.has(want), `missing MAP path: ${want}`).toBe(true);
    }
  });

  test('MEMORY_COMMANDS 含切片表约定的 3 个 path', () => {
    const paths = new Set(MEMORY_COMMANDS.map((c) => c.path.join(' ')));
    for (const want of ['memory recall', 'memory fact', 'memory remember']) {
      expect(paths.has(want), `missing MEMORY path: ${want}`).toBe(true);
    }
  });

  test('CONFIG_COMMANDS 含切片表约定的 env/config/* + shapes/primitive/web/distill/plans/history', () => {
    const paths = new Set(CONFIG_COMMANDS.map((c) => c.path.join(' ')));
    for (const want of [
      'env',
      'config status',
      'config set-key',
      'config set-model',
      'config set-role',
      'config preset',
      'config register-provider',
      'config models-auto',
      'config hud',
      'shapes',
      'primitive',
      'web',
      'distill',
      'plans',
      'history read',
      'history search',
    ]) {
      expect(paths.has(want), `missing CONFIG path: ${want}`).toBe(true);
    }
  });

  test('tool 字段与注册面新名一致 (TOOL_RENAMES 映射 + alias 不算)', () => {
    const allowed = new Set([
      'run', 'dag_run_plan', 'dag_status', 'dag_result', 'dag_runs', 'dag_resume', 'dag_cancel',
      'dag_intervene', 'dag_node_output', 'dag_research', 'dag_review', 'dag_debug', 'dag_deepen',
      'dag_slim', 'dag_triage', 'dag_rule',
      'map_init', 'map_open', 'map_add', 'map_tickets', 'map_rule', 'map_confirm', 'map_deliver', 'map_prefetch',
      'memory_recall', 'memory_fact', 'memory_remember',
      'omd_env', 'omd_config_status', 'omd_set_key', 'omd_set_model', 'omd_set_role',
      'omd_apply_preset', 'omd_register_provider', 'omd_models_auto', 'omd_toggle_hud',
      'omd_shapes', 'omd_primitive', 'omd_web', 'omd_distill', 'omd_plans',
      'history_read', 'history_search',
    ]);
    for (const list of [DAG_COMMANDS, MAP_COMMANDS, MEMORY_COMMANDS, CONFIG_COMMANDS]) {
      for (const cmd of list) {
        expect(allowed.has(cmd.tool ?? ''), `unexpected tool: ${cmd.tool}`).toBe(true);
      }
    }
  });

  test('路径没有重复 (跨表也不重)', () => {
    const seen = new Set<string>();
    for (const list of [DAG_COMMANDS, MAP_COMMANDS, MEMORY_COMMANDS, CONFIG_COMMANDS]) {
      for (const cmd of list) {
        const key = cmd.path.join(' ');
        expect(seen.has(key), `duplicate path: ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe('命令表 argv 映射', () => {
  test('位置参 → camelCase handler key', () => {
    const status = DAG_COMMANDS.find((c) => c.path.join(' ') === 'status')!;
    expect(status.argv(['run-1'])).toEqual({ runId: 'run-1' });

    const nodeOutput = DAG_COMMANDS.find((c) => c.path.join(' ') === 'node-output')!;
    expect(nodeOutput.argv(['run-1', 'node-7'])).toEqual({ runId: 'run-1', nodeId: 'node-7' });

    const intervene = DAG_COMMANDS.find((c) => c.path.join(' ') === 'intervene')!;
    expect(intervene.argv(['r1', 'plz fix'])).toEqual({ runId: 'r1', directive: 'plz fix' });
  });

  test('flag → camelCase key + 数字/布尔自动转', () => {
    const runs = DAG_COMMANDS.find((c) => c.path.join(' ') === 'runs')!;
    expect(runs.argv(['--limit', '5'])).toEqual({ limit: 5 });
    expect(runs.argv(['--limit', '5', '--verbose'])).toEqual({ limit: 5, verbose: true });

    const mapAdd = MAP_COMMANDS.find((c) => c.path.join(' ') === 'map add')!;
    expect(mapAdd.argv(['--title', 'fix bug', '--blocked-by', 'a,b'])).toEqual({
      title: 'fix bug',
      blockedBy: 'a,b',
    });
  });

  test('--detached 是 boolean (run 真跑要求逐字识别,D-4/D-6 联用)', () => {
    const runCmd = DAG_COMMANDS.find((c) => c.path.join(' ') === 'run')!;
    expect(runCmd.argv(['a task', '--detached', '--max-fanout', '4'])).toEqual({
      task: 'a task',
      detached: true,
      maxFanout: 4,
    });
  });

  test('多余位置参抛错 (与 registry.parseGenericArgs 同形,argv 调用形态)', () => {
    const status = DAG_COMMANDS.find((c) => c.path.join(' ') === 'status')!;
    expect(() => status.argv(['run-1', 'extra'])).toThrow(/unexpected positional/);
  });
});

describe('renderStatus 文本渲染', () => {
  test('标准 content (单 text 段) → 段内文本原样返回', () => {
    const text = 'runId: r1\nstatus: done\ngoal: hello\nnodes: 3 done / 0 failed / 0 skipped / 0 running / 0 pending (共 3)';
    expect(renderStatus({ content: [{ type: 'text', text }] })).toBe(text);
  });

  test('多 text 段 → 按出现顺序,段间换行 (与 invoke 默认渲染对齐)', () => {
    const content = {
      content: [
        { type: 'text', text: 'runId: r1' },
        { type: 'text', text: 'status: running' },
      ],
    };
    expect(renderStatus(content)).toBe('runId: r1\nstatus: running');
  });

  test('resource 段被丢弃 (不污染 stdout, INV-4 同形)', () => {
    const content = {
      content: [
        { type: 'text', text: '前面' },
        { type: 'resource', resource: { uri: 'x' } },
        { type: 'text', text: '后面' },
      ],
    };
    expect(renderStatus(content)).toBe('前面\n后面');
  });

  test('空 content / 无 content 数组 → 空串 (handler 真没产出时不编 placeholder)', () => {
    expect(renderStatus({ content: [] })).toBe('');
    expect(renderStatus({})).toBe('');
    expect(renderStatus(null)).toBe('');
  });
});

describe('renderRunResult 文本渲染', () => {
  test('JSON 编码结果 → 解析后渲染 (outcome 首行 + 节点表 + 写集)', () => {
    const result = {
      sessionId: 's1',
      nodeCount: 3,
      done: 2,
      failed: 1,
      artifactPaths: ['src/foo.ts', 'src/bar.ts'],
      verification: { pass: false, reason: 'one verifier failed' },
      usage: { conductor: { in: 100, out: 50 } },
    };
    const text = JSON.stringify(result);
    const rendered = renderRunResult({ content: [{ type: 'text', text }] });

    expect(rendered).toContain('sessionId: s1');
    expect(rendered).toContain('nodes: 2 done / 1 failed (共 3)');
    expect(rendered).toContain('writeset: src/foo.ts');
    expect(rendered).toContain('writeset: src/bar.ts');
    expect(rendered).toContain('verification: failed');
    expect(rendered).toContain('one verifier failed');
  });

  test('goal 路结果 (纯字符串,如 summarizeGoal) → 原样打印', () => {
    const summary = 'goal: hello\ntier: T2 · 收敛 · 3 轮\noutcome: delivered';
    const out = renderRunResult({ content: [{ type: 'text', text: summary }] });
    expect(out).toContain('outcome: delivered');
    expect(out).toContain('tier: T2');
  });

  test('JSON 解析失败 → 退回原文本 (handler 返回非 JSON 不应崩 CLI)', () => {
    const text = 'run completed (no structured result)';
    expect(renderRunResult({ content: [{ type: 'text', text }] })).toBe(text);
  });

  test('空 content → 空串', () => {
    expect(renderRunResult({ content: [] })).toBe('');
    expect(renderRunResult({})).toBe('');
    expect(renderRunResult(null)).toBe('');
  });

  test('多 text 段 → 拼接后解析 (handler 偶尔追加 ASCII 进度图等段)', () => {
    const result = { sessionId: 's1', nodeCount: 1, done: 1, failed: 0 };
    const text = JSON.stringify(result);
    const rendered = renderRunResult({
      content: [
        { type: 'text', text },
        { type: 'text', text: '(extra notes)' },
      ],
    });
    expect(rendered).toContain('sessionId: s1');
    expect(rendered).toContain('(extra notes)');
  });
});

describe('INV-1 零第二套语义 (commands.ts 不引入 engine/goal/hooks/bwrap)', () => {
  test('命令表文件本身不引用任一被禁路径', () => {
    const src = readFileSync(join(import.meta.dir, 'commands.ts'), 'utf8');
    const importLines = src
      .split('\n')
      .filter((line) => /^\s*(import|export)\b/.test(line) || /\bfrom\s+['"]/.test(line));
    const joined = importLines.join('\n');
    for (const banned of ['dag/engine', 'goal/run-goal', 'goal/loop-run', 'hooks/bwrap']) {
      expect(joined, `banned import: ${banned}`).not.toContain(banned);
    }
  });
});