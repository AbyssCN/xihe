/**
 * src/harness/cli/commands —— 命名命令按工具分组的导出 + run/status 文本渲染 (切片 5, SDD 2026-09-05)。
 *
 * ## 这是什么
 *
 * 把 registry.ts 的命令表**按工具分组**导出,供消费方按域查 (例如 cli.ts 接线可以
 * 单独引用 `MAP_COMMANDS`;文档对账测试可单独引用 `MEMORY_COMMANDS`)。同时承载
 * `renderRunResult` / `renderStatus` 两个**人读渲染**函数 —— registry 的 `CliCommand.render`
 * 字段正是为它们留的注入点 (见 invoke.ts 的 render 覆盖路径)。
 *
 * ## 这不是什么
 *
 * **零第二套语义 (INV-1)** —— 不 import 任何 engine / goal / hooks 内部件
 * (`dag/engine` / `goal/run-goal` / `goal/loop-run` / `hooks/bwrap`),路径字面量见 GWT-1。
 * 命令执行唯一通路 = 装配 `assembleOmdMcpTools()` → 按名找 handler → 调 (invoke.ts)。
 *
 * ## 与 registry.ts 的关系
 *
 * registry.ts 是**组合视图** (`CLI_COMMANDS` 扁平一表 + `findCommand` + `parseGenericArgs` +
 * `renderToolHelp` + `renderUsage`);本文件是**分组视图**。两组表是各自维护的同名拷贝 —
 * — 切片边界 (`{1} → {5} → {6}`) 决定本片不写 registry.ts,后续切片 6 (cli.ts 接线) 会
 * 决定是否需要再合表。当前只要保持 `path / tool / summary / argv` 形态一致 → findCommand
 * 与 cli.ts 分派不会漂。
 */

import type { CliCommand } from './registry';
import { logger } from '../../logger';

// ---------------------------------------------------------------------------
// argv 解析 helpers —— 与 registry.ts 的 `command()` 闭包形态对齐,小幅度独立实现。
//
// 理由:registry.ts 的 `command()` / `positionalArg()` 是模块内私有 helper (slice 1 没导出);
// 本文件作为分组视图,需要一份独立的"位置参 + flag"小解析器(只为 argv 映射,不带 USAGE/help
// 那部分重型设施)。flag 自动转 camelCase、数字、布尔 false/true,与 `parseGenericArgs` 一致。
// ---------------------------------------------------------------------------

type ArgValue = string | number | boolean;

function camelCase(key: string): string {
  return key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function valueOf(raw: string): ArgValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    const number = Number(raw);
    if (Number.isFinite(number)) return number;
  }
  return raw;
}

function splitFlags(args: readonly string[]): { flags: Record<string, unknown>; positionals: string[] } {
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--') || token === '--') {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const rawKey = equals === -1 ? token.slice(2) : token.slice(2, equals);
    if (!rawKey) throw new Error('CLI flag cannot be empty');
    const key = camelCase(rawKey);
    if (equals !== -1) {
      flags[key] = valueOf(token.slice(equals + 1));
      continue;
    }
    const next = args[index + 1];
    const nextIsValue = next !== undefined && (!next.startsWith('--') || /^-\d/.test(next));
    if (nextIsValue) {
      flags[key] = valueOf(next);
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positionals };
}

function positionalArg(names: readonly string[], args: readonly string[]): Record<string, unknown> {
  const { flags, positionals } = splitFlags(args);
  const result: Record<string, unknown> = { ...flags };
  for (let index = 0; index < names.length && index < positionals.length; index += 1) {
    result[names[index]!] = valueOf(positionals[index]!);
  }
  if (positionals.length > names.length) {
    throw new Error(`unexpected positional argument: ${positionals[names.length]}`);
  }
  return result;
}

function build(
  path: readonly string[],
  tool: string,
  summary: string,
  positions: readonly string[] = [],
  render?: (content: unknown) => string,
): CliCommand {
  const cmd: CliCommand = {
    path,
    tool,
    argv: (args) => positionalArg(positions, args),
    summary,
  };
  return render ? { ...cmd, render } : cmd;
}

// ---------------------------------------------------------------------------
// DAG_COMMANDS —— run · run-plan · status · result · runs · resume · cancel ·
//                intervene · node-output · research · review · debug ·
//                deepen · slim · triage · rule (16 条, 与 SDD §命名命令表 对齐)
//
// `run` 走新注册面 (`run` 工具 = 原 dag_run 经 TOOL_RENAMES 改名),`--fixture` 路径由
// cli.ts 的 findCommand 早期返回 undefined 让旧路接管 (与 registry.ts 同形,不重写)。
// `solve` 不在本表 —— 它由 cli-solve.ts 单独接管 (SDD §命名命令表 末段「solve 已有专门
// 适配器,表里登记为已覆盖,不再走通用路」),不放进通用 argv 映射。
// ---------------------------------------------------------------------------

const DAG_COMMANDS: readonly CliCommand[] = [
  build(['run'], 'run', 'run task; --fixture keeps legacy fixture path', ['task']),
  build(['run-plan'], 'dag_run_plan', 'run JSON plan', ['plan']),
  build(['status'], 'dag_status', 'show run status', ['runId']),
  build(['result'], 'dag_result', 'show completed run result', ['runId']),
  build(['runs'], 'dag_runs', 'list runs'),
  build(['resume'], 'dag_resume', 'resume failed or interrupted run', ['runId']),
  build(['cancel'], 'dag_cancel', 'cancel running run', ['runId']),
  build(['intervene'], 'dag_intervene', 'record owner intervention', ['runId', 'directive']),
  build(['node-output'], 'dag_node_output', 'show node output', ['runId', 'nodeId']),
  build(['research'], 'dag_research', 'research question'),
  build(['review'], 'dag_review', 'review current diff'),
  build(['debug'], 'dag_debug', 'debug failure', ['symptom']),
  build(['deepen'], 'dag_deepen', 'deepen architecture review'),
  build(['slim'], 'dag_slim', 'find over-engineering'),
  build(['triage'], 'dag_triage', 'show owner triage inbox', ['runId']),
  build(['rule'], 'dag_rule', 'rule on owner decision', ['runId', 'ruling']),
];

// ---------------------------------------------------------------------------
// MAP_COMMANDS —— map init/open/add/tickets/rule/confirm/deliver/prefetch (8 条)
// ---------------------------------------------------------------------------

const MAP_COMMANDS: readonly CliCommand[] = [
  build(['map', 'init'], 'map_init', 'initialize decision map'),
  build(['map', 'open'], 'map_open', 'open decision map'),
  build(['map', 'add'], 'map_add', 'add map ticket'),
  build(['map', 'tickets'], 'map_tickets', 'list map tickets'),
  build(['map', 'rule'], 'map_rule', 'rule on map ticket'),
  build(['map', 'confirm'], 'map_confirm', 'confirm or reject suggested ticket'),
  build(['map', 'deliver'], 'map_deliver', 'deliver ruled map region'),
  build(['map', 'prefetch'], 'map_prefetch', 'prefetch map context'),
];

// ---------------------------------------------------------------------------
// MEMORY_COMMANDS —— memory recall/fact/remember (3 条)
// ---------------------------------------------------------------------------

const MEMORY_COMMANDS: readonly CliCommand[] = [
  build(['memory', 'recall'], 'memory_recall', 'recall memory'),
  build(['memory', 'fact'], 'memory_fact', 'read memory fact'),
  build(['memory', 'remember'], 'memory_remember', 'remember verified fact'),
];

// ---------------------------------------------------------------------------
// CONFIG_COMMANDS —— env · config status/set-key/set-model/set-role/preset/
//                    register-provider/models-auto/hud · shapes · primitive ·
//                    web · distill · plans · history read/search (16 条)
//
// SDD §命名命令表 把这一段 (config + misc) 写在一个 block,contract 也只列 CONFIG_COMMANDS
// 一个出口 —— 本片不分 MISC_COMMANDS (与 registry.ts 的五分组不同;这里对齐 contract 字面)。
// ---------------------------------------------------------------------------

const CONFIG_COMMANDS: readonly CliCommand[] = [
  build(['env'], 'omd_env', 'show environment'),
  build(['config', 'status'], 'omd_config_status', 'show effective config'),
  build(['config', 'set-key'], 'omd_set_key', 'set provider key'),
  build(['config', 'set-model'], 'omd_set_model', 'set model coordinate'),
  build(['config', 'set-role'], 'omd_set_role', 'set role model'),
  build(['config', 'preset'], 'omd_apply_preset', 'apply model preset'),
  build(['config', 'register-provider'], 'omd_register_provider', 'register provider'),
  build(['config', 'models-auto'], 'omd_models_auto', 'discover provider models'),
  build(['config', 'hud'], 'omd_toggle_hud', 'toggle HUD'),
  build(['shapes'], 'omd_shapes', 'show plan shapes'),
  build(['primitive'], 'omd_primitive', 'run primitive plan'),
  build(['web'], 'omd_web', 'search and retrieve web content'),
  build(['distill'], 'omd_distill', 'distill supplied text'),
  build(['plans'], 'omd_plans', 'show plan ledger'),
  build(['history', 'read'], 'history_read', 'read conversation history'),
  build(['history', 'search'], 'history_search', 'search conversation history'),
];

// ---------------------------------------------------------------------------
// renderStatus —— dag_status 的人读文本渲染
//
// dag_status handler (`src/mcp/tools/dag-tools.ts` makeDagStatus) 返回的 content 形态:
//   { content: [{ type: 'text', text: '<multi-line summary>' }] }
// 文本由 `runRegistry.getSummary` 组装 (runId/status/goal/elapsed/nodes/.../running)。
//
// 这里与 invoke.ts 默认渲染(`content[].text` 拼接 + resource 丢弃)对齐 ——
// 只是写成一个独立函数,供 `CliCommand.render` 注入。这样 `omd status x` 这条命令
// 可以挂 `render: renderStatus`;同时保持纯函数形态,handler 改了文本结构也能继续
// 透传给 invoke 默认渲染 (不强制接这个函数)。
//
// **故意不做解析**:dag_status 文本已经可读,再拆 JSON 重新排版只会增加耦合且收益小
// (status 文段格式由 runRegistry.ts 决定,迁就它反而把这里绑死在 runRegistry 的私有
// 字段上)。需要结构化输出走 `--json`。
// ---------------------------------------------------------------------------

export function renderStatus(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const segments = (content as { content?: unknown }).content;
  if (!Array.isArray(segments)) return '';
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const piece = seg as { type?: unknown; text?: unknown };
    if (piece.type === 'text' && typeof piece.text === 'string') {
      out.push(piece.text);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// renderRunResult —— dag_result / run 终态产出的人读渲染
//
// dag_result handler 返回 `JSON.stringify(rec.result, null, 2)` —— rec.result 有两种形态:
//   1. dag_run 路 (`src/mcp/tools/dag-tools.ts` summarizeResult):对象
//      { sessionId, nodeCount, done, failed, artifactPaths?, verification?, usage, outputs? }
//   2. goal 路 (`src/mcp/tools/goal.ts` summarizeGoal):**纯字符串**(多行摘要)
//
// 渲染策略:
//   · 第一段是合法 JSON 对象 → 按 SDD 「outcome 首行 + 节点表 + 写集」渲染;
//     剩余 text 段 (handler 偶尔追加 ASCII 进度图 / 提示) 紧随其后原样拼回。
//   · 第一段不是合法 JSON → 全部 text 段按序拼回 (goal 路 summary 直接印出,
//     用户能读到 `outcome: <kind>` / `tier: <tier>` 等关键字段)。
//   · 任何一段解析失败都不抛 —— handler 偶发非 JSON 内容(如 ASCII 进度图片段)不应
//     让 CLI 进程崩。
// ---------------------------------------------------------------------------

export function renderRunResult(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const segments = (content as { content?: unknown }).content;
  if (!Array.isArray(segments)) return '';
  const texts: string[] = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const piece = seg as { type?: unknown; text?: unknown };
    if (piece.type === 'text' && typeof piece.text === 'string') {
      texts.push(piece.text);
    }
  }
  if (texts.length === 0) return '';
  const head = texts[0]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(head);
  } catch (e) {
    // 不是 JSON (例如 goal 路 summarizeGoal 的多行字符串) → 原样拼回。这不是错误路径,
    // 但证据照留 (仓规: catch 不许吞证据; 仓内 catch 棘轮 scripts/catch-evidence-scan 盯着这条)。
    logger.debug({ err: e instanceof Error ? e.message : String(e) }, '[cli/commands] result 首段非 JSON → 按文本渲染');
    return texts.join('\n');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // JSON 但不是对象 → 同样按文本走 (handler 偶发数组/字面量不该让 CLI 崩)。
    return texts.join('\n');
  }
  const tail = texts.length > 1 ? '\n' + texts.slice(1).join('\n') : '';
  return renderStructuredResult(parsed as Record<string, unknown>) + tail;
}

function renderStructuredResult(result: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof result.sessionId === 'string') lines.push(`sessionId: ${result.sessionId}`);
  const nodeCount = typeof result.nodeCount === 'number' ? result.nodeCount : undefined;
  const done = typeof result.done === 'number' ? result.done : undefined;
  const failed = typeof result.failed === 'number' ? result.failed : undefined;
  if (nodeCount !== undefined && done !== undefined && failed !== undefined) {
    lines.push(`nodes: ${done} done / ${failed} failed (共 ${nodeCount})`);
  }
  if (Array.isArray(result.artifactPaths)) {
    for (const path of result.artifactPaths) {
      if (typeof path === 'string') lines.push(`writeset: ${path}`);
    }
  }
  const verification = result.verification;
  if (verification && typeof verification === 'object') {
    const v = verification as { pass?: unknown; reason?: unknown };
    if (typeof v.pass === 'boolean') {
      const verdict = v.pass ? 'passed' : 'failed';
      const reason = typeof v.reason === 'string' && v.reason.length > 0 ? ` — ${v.reason}` : '';
      lines.push(`verification: ${verdict}${reason}`);
    }
  }
  return lines.join('\n');
}

export { CONFIG_COMMANDS, DAG_COMMANDS, MAP_COMMANDS, MEMORY_COMMANDS };