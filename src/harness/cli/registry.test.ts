import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { TOOL_RENAMES } from '../../mcp/tool-renames';
import { assembleOmdMcpTools } from '../../mcp/assemble';
import { RunRegistry } from '../../mcp/run-registry';
import { createOwnerInbox } from '../../mcp/owner-inbox';
import { createOmdMemory } from '../memory';
import { UNIVERSAL_SAFEGUARD } from '../../memory/safeguards/namespaces';
import { createPlanLedger } from '../plan/plan-ledger';
import { createDagRecorder } from '../dag/dag-record';
import { createModelRouterFromEnv } from '../model-router';
import { registerProvider, clearProviders } from '../../model/providers';
import { ALL_SEATS, resetConfigCache, seatEnvKey } from '../../model/role-models';
import {
  CLI_COMMANDS,
  MCP_ONLY,
  findCommand,
  parseGenericArgs,
  renderToolHelp,
  renderUsage,
} from './registry';

describe('CLI registry', () => {
  test('maps named paths to new MCP tool names', () => {
    expect(findCommand(['status', 'run-1'])?.cmd.tool).toBe('dag_status');
    expect(findCommand(['map', 'add', '--title', 'ticket'])?.cmd.tool).toBe('map_add');
    expect(findCommand(['config', 'set-model', '--role', 'leaf'])?.cmd.tool).toBe('omd_set_model');
    expect(findCommand(['history', 'search', '--query', 'needle'])?.cmd.tool).toBe('history_search');
  });

  test('preserves legacy fixture run and solve dispatch', () => {
    expect(findCommand(['run', '--fixture', '/tmp/fixture'])).toBeUndefined();
    expect(findCommand(['solve', 'goal'])).toBeUndefined();
  });

  test('parses JSON and typed flags', () => {
    expect(parseGenericArgs(['--json', '{"runId":"r1","limit":3}'])).toEqual({ runId: 'r1', limit: 3 });
    expect(parseGenericArgs(['--run-id', 'r1', '--limit', '3', '--detached', '--enabled', 'false'])).toEqual({
      runId: 'r1',
      limit: 3,
      detached: true,
      enabled: false,
    });
  });

  test('renders schema help with required and optional fields', () => {
    const help = renderToolHelp({
      name: 'dag_status',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run identifier' },
          limit: { type: 'number' },
        },
        required: ['runId'],
      },
    });
    expect(help).toContain('--run-id <string>');
    expect(help).toContain('必填');
    expect(help).toContain('--limit <number>');
  });

  test('usage comes from registry', () => {
    const usage = renderUsage(CLI_COMMANDS);
    expect(usage).toContain('omd status');
    expect(usage).toContain('omd map add');
  });

  test('every renamed production name has command or explicit exclusion', () => {
    const names = new Set(CLI_COMMANDS.flatMap((command) => (command.tool ? [command.tool] : [])));
    for (const name of Object.values(TOOL_RENAMES)) expect(names.has(name) || name in MCP_ONLY).toBe(true);
    expect(MCP_ONLY.conductor_chat).toContain('多轮');
  });

  test('production assembled names have command or explicit exclusion', () => {
    const root = mkdtempSync('/tmp/omd-cli-registry-');
    const env = {
      ...process.env,
      ...Object.fromEntries(ALL_SEATS.map((seat) => [seatEnvKey(seat), `faux:${seat}`])),
      OMD_CONFIG_PATH: join(root, 'missing-config.json'),
      TAVILY_API_KEY: 'fixture-key',
    };
    registerProvider('faux', { baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-key', api: 'openai-compatible', defaultModel: 'm' });
    try {
      const noopAgent = (async () => ({ text: '', usage: { in: 0, out: 0 } })) as never;
      const noopCommand = (async () => ({ text: '', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 })) as never;
      const tools = assembleOmdMcpTools({
        cwd: root,
        env,
        runRegistry: new RunRegistry(),
        memory: createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD }),
        agentRunner: noopAgent,
        commandRunner: noopCommand,
        ledger: createPlanLedger({ db: new Database(':memory:') }),
        recorder: createDagRecorder({ db: new Database(':memory:') }),
        router: createModelRouterFromEnv(env, { db: new Database(':memory:') }),
        inbox: createOwnerInbox({ db: new Database(':memory:') }),
      });
      const aliases = new Set(Object.keys(TOOL_RENAMES));
      const named = new Set(CLI_COMMANDS.flatMap((command) => (command.tool ? [command.tool] : [])));
      for (const name of tools.map((tool) => tool.name).filter((name) => !aliases.has(name))) {
        expect(named.has(name) || name in MCP_ONLY, name).toBe(true);
      }
    } finally {
      clearProviders();
      resetConfigCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
