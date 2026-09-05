/**
 * CLI command registry.
 *
 * This file only adapts argv to MCP handler arguments. Execution stays in the
 * assembled MCP tool surface; legacy subcommands continue through cli.ts.
 */

import { CONFIG_COMMANDS, DAG_COMMANDS, MAP_COMMANDS, MEMORY_COMMANDS } from './commands';

export interface CliCommand {
  /** Command path, for example ['status'] or ['map', 'add']. */
  readonly path: readonly string[];
  /** New MCP tool name. */
  readonly tool?: string;
  /** Convert arguments after path into handler arguments. */
  readonly argv: (args: readonly string[]) => Record<string, unknown>;
  /** Convert handler content into human-readable output. */
  readonly render?: (content: unknown) => string;
  /** One-line usage description. */
  readonly summary: string;
}

/** Tools intentionally without a one-shot named command. */
export const MCP_ONLY: Readonly<Record<string, string>> = {
  conductor_chat: '多轮会话状态只存在 serve/TUI 中, CLI 单发没有会话',
  // 不是"没有命令": `omd solve` 由 cli-solve.ts 单独接管 (goal-worker 通路 + resultOut 退出码映射),
  // 不走通用注册面 (findCommand 对 solve 返 undefined)。登记在这里只为对账闸 (D-3) 不漏它。
  solve: '由 src/harness/cli-solve.ts 单独接管 (omd solve), 不走通用注册面',
};

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

function flagArgs(args: readonly string[]): { flags: Record<string, unknown>; positionals: string[] } {
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

/**
 * Generic `call` argument parser. `--json` is deliberately all-or-nothing so
 * malformed or mixed payloads cannot be silently split into different args.
 */
export function parseGenericArgs(args: readonly string[]): Record<string, unknown> {
  const jsonIndex = args.indexOf('--json');
  if (jsonIndex !== -1) {
    if (jsonIndex !== 0 || args.length !== 2) throw new Error('--json expects one JSON object argument');
    let parsed: unknown;
    try {
      parsed = JSON.parse(args[1]!);
    } catch (error) {
      throw new Error(`invalid --json: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--json expects a JSON object');
    }
    return parsed as Record<string, unknown>;
  }
  const { flags, positionals } = flagArgs(args);
  if (positionals.length > 0) throw new Error(`unexpected positional argument: ${positionals[0]}`);
  return flags;
}

function positionalArg(names: readonly string[], args: readonly string[]): Record<string, unknown> {
  const { flags, positionals } = flagArgs(args);
  const result: Record<string, unknown> = { ...flags };
  for (let index = 0; index < names.length && index < positionals.length; index += 1) {
    result[names[index]!] = valueOf(positionals[index]!);
  }
  if (positionals.length > names.length) {
    throw new Error(`unexpected positional argument: ${positionals[names.length]}`);
  }
  return result;
}

function command(
  path: readonly string[],
  tool: string | undefined,
  summary: string,
  positions: readonly string[] = [],
): CliCommand {
  return {
    path,
    ...(tool ? { tool } : {}),
    argv: (args) => positionalArg(positions, args),
    summary,
  };
}

// 命名命令表的**唯一真源**是 ./commands.ts (按 dag / map / memory / config 分组)。
// 此前这里还有一份同名拷贝 —— 两份表各自维护必漂, 而且 commands.ts 因此成了 import 图上的孤儿
// (reachability 闸红)。Aalto 验收修 2026-09-05: 这里只组合, 不再声明。
/** All named commands. Order is user-facing usage order and longest paths are unique. */
export const CLI_COMMANDS: readonly CliCommand[] = [
  ...DAG_COMMANDS,
  ...MAP_COMMANDS,
  ...MEMORY_COMMANDS,
  ...CONFIG_COMMANDS,
  command(['call'], undefined, 'call any MCP tool; use --json or --key value', ['tool']),
  command(['doctor'], undefined, 'diagnose jail and ecosystem prerequisites', ['repo']),
];

/** Find exact command path and leave remaining argv untouched. */
export function findCommand(argv: readonly string[]): { cmd: CliCommand; rest: string[] } | undefined {
  // Existing adapters own these paths. Returning undefined is intentional: it
  // prevents registry introduction from changing their flags or exit behavior.
  if (argv[0] === 'solve' || (argv[0] === 'run' && argv.includes('--fixture'))) return undefined;
  let found: CliCommand | undefined;
  let length = 0;
  for (const candidate of CLI_COMMANDS) {
    if (candidate.path.length <= length || candidate.path.length > argv.length) continue;
    if (candidate.path.every((part, index) => argv[index] === part)) {
      found = candidate;
      length = candidate.path.length;
    }
  }
  return found ? { cmd: found, rest: [...argv.slice(length)] } : undefined;
}

function schemaShape(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {};
  const value = schema as Record<string, unknown>;
  const jsonProperties = value.properties;
  if (jsonProperties && typeof jsonProperties === 'object') return jsonProperties as Record<string, unknown>;
  const zod = value._zod;
  const zodDef = zod && typeof zod === 'object' ? (zod as Record<string, unknown>).def : undefined;
  const def = value._def && typeof value._def === 'object' ? value._def as Record<string, unknown> : undefined;
  const shape = (zodDef && typeof zodDef === 'object' ? (zodDef as Record<string, unknown>).shape : undefined)
    ?? def?.shape
    ?? value.shape;
  if (typeof shape === 'function') return (shape as () => Record<string, unknown>)();
  return shape && typeof shape === 'object' ? shape as Record<string, unknown> : {};
}

function schemaDef(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {};
  const value = schema as Record<string, unknown>;
  const zod = value._zod;
  if (zod && typeof zod === 'object') {
    const def = (zod as Record<string, unknown>).def;
    if (def && typeof def === 'object') return def as Record<string, unknown>;
  }
  return value._def && typeof value._def === 'object' ? value._def as Record<string, unknown> : {};
}

function unwrapSchema(schema: unknown): { schema: unknown; optional: boolean } {
  let current = schema;
  let optional = false;
  for (;;) {
    const def = schemaDef(current);
    const type = String(def.type ?? def.typeName ?? '');
    if (type === 'optional' || type === 'ZodOptional') optional = true;
    const inner = def.innerType ?? def.schema;
    if (!inner || inner === current || (type !== 'optional' && type !== 'nullable' && type !== 'default' && type !== 'ZodOptional' && type !== 'ZodNullable' && type !== 'ZodDefault')) break;
    current = inner;
  }
  return { schema: current, optional };
}

function schemaType(schema: unknown): string {
  const unwrapped = unwrapSchema(schema).schema;
  if (unwrapped && typeof unwrapped === 'object') {
    const value = unwrapped as Record<string, unknown>;
    if (typeof value.type === 'string') return value.type;
    const type = schemaDef(unwrapped).type ?? schemaDef(unwrapped).typeName;
    if (typeof type === 'string') return type.replace(/^Zod/, '').toLowerCase();
  }
  return 'unknown';
}

function schemaDescription(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const value = schema as Record<string, unknown>;
  if (typeof value.description === 'string') return value.description;
  const def = schemaDef(schema);
  return typeof def.description === 'string' ? def.description : undefined;
}

/** Render one help line per inputSchema field. Supports JSON Schema and Zod objects. */
export function renderToolHelp(tool: { name: string; description?: string; inputSchema: unknown }): string {
  const shape = schemaShape(tool.inputSchema);
  const input = tool.inputSchema as Record<string, unknown>;
  const jsonSchema = !!input && typeof input === 'object' && ('properties' in input || input.type === 'object');
  const required = new Set(Array.isArray(input?.required) ? input.required.filter((x): x is string => typeof x === 'string') : []);
  const lines = [`${tool.name}${tool.description ? ` — ${tool.description}` : ''}`];
  for (const [name, field] of Object.entries(shape)) {
    const unwrapped = unwrapSchema(field);
    const mandatory = jsonSchema ? required.has(name) : !unwrapped.optional;
    const description = schemaDescription(field);
    lines.push(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} <${schemaType(unwrapped.schema)}> ${mandatory ? '必填' : '可选'}${description ? ` — ${description}` : ''}`);
  }
  return lines.join('\n');
}

/** Generate named-command usage; cli.ts may prepend its legacy hand-written section. */
export function renderUsage(commands: readonly CliCommand[]): string {
  return commands
    .map((command) => `  omd ${command.path.join(' ')}  ${command.summary}`)
    .join('\n');
}
