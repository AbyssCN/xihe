/**
 * headless-config 不变量: key 路由 (auth.json/​.env) + 合并不伤他人 + 活注入 + preset 写盘 +
 * 角色校验 (plan 拒) + HUD 开关 + key 反向删除。凭证 flag 依赖真 ~/.pi/auth.json, 由 dag_run 端到端验, 此处不锁。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearProviders, getProvider } from '../../model/providers';
import { resetConfigCache } from '../../model/role-models';
import { applyPresetHeadless, removeKeyHeadless, setKeyHeadless, setRoleHeadless, toggleHud } from './headless-config';

let dir: string;
let prevConfigPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'headless-cfg-'));
  prevConfigPath = process.env.OMD_CONFIG_PATH;
  process.env.OMD_CONFIG_PATH = join(dir, '.omd', 'config.json');
});

afterEach(() => {
  if (prevConfigPath === undefined) delete process.env.OMD_CONFIG_PATH;
  else process.env.OMD_CONFIG_PATH = prevConfigPath;
  clearProviders();
  resetConfigCache();
});

describe('setKeyHeadless 路由', () => {
  test('auto: kimi-coding → auth.json api_key (合并, 不动他人条目)', () => {
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ deepseek: { type: 'api_key', key: 'keep-me' } }));
    const env: Record<string, string | undefined> = {};
    const r = setKeyHeadless('kimi-coding', 'sk-kimi-x', 'auto', { cwd: dir, env, authPath });
    expect(r.target).toBe('authjson');
    expect(r.immediate).toBe(true);
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    expect(auth['kimi-coding']).toEqual({ type: 'api_key', key: 'sk-kimi-x' });
    expect(auth.deepseek).toEqual({ type: 'api_key', key: 'keep-me' }); // 未被吞
  });

  test('auto: mimo → .env 写盘 + process.env 活注入 + re-register', () => {
    const env: Record<string, string | undefined> = { MIMO_BASE_URL: 'https://x/v1' };
    const r = setKeyHeadless('mimo', 'sk-mimo-x', 'auto', { cwd: dir, env, authPath: join(dir, 'auth.json') });
    expect(r.target).toBe('env');
    expect(env.MIMO_API_KEY).toBe('sk-mimo-x'); // 活注入
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('MIMO_API_KEY'); // 写盘
    expect(getProvider('mimo')).toBeTruthy(); // base 在 → 注册成功
  });

  test('auto: mimo 无 base → warning', () => {
    const env: Record<string, string | undefined> = {};
    const r = setKeyHeadless('mimo', 'sk-mimo-x', 'auto', { cwd: dir, env, authPath: join(dir, 'auth.json') });
    expect(r.warnings.some((w) => w.includes('MIMO_BASE_URL'))).toBe(true);
  });

  test('target 覆盖: deepseek 强制 authjson', () => {
    const authPath = join(dir, 'auth.json');
    const r = setKeyHeadless('deepseek', 'sk-ds', 'authjson', { cwd: dir, env: {}, authPath });
    expect(r.target).toBe('authjson');
    expect(JSON.parse(readFileSync(authPath, 'utf8')).deepseek.key).toBe('sk-ds');
  });

  test('空 provider / 空 key → throw', () => {
    expect(() => setKeyHeadless('', 'k', 'auto', { cwd: dir })).toThrow(/provider required/);
    expect(() => setKeyHeadless('mimo', '  ', 'auto', { cwd: dir })).toThrow(/key required/);
  });
});

describe('removeKeyHeadless 反向删除', () => {
  test('auth.json api_key 条目整条删 + 不动他人条目', () => {
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ 'kimi-coding': { type: 'api_key', key: 'sk-old' }, deepseek: { type: 'api_key', key: 'keep-me' } }));
    const r = removeKeyHeadless('kimi-coding', { cwd: dir, env: {}, authPath });
    expect(r.removed).toEqual([{ file: authPath, key: 'kimi-coding' }]);
    expect(r.warnings).toEqual([]);
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    expect(auth['kimi-coding']).toBeUndefined();
    expect(auth.deepseek).toEqual({ type: 'api_key', key: 'keep-me' }); // 未被吞
  });

  test('auth.json oauth 条目同样整条删 (不挑形)', () => {
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ 'minimax-cn': { type: 'oauth', token: 't' } }));
    const r = removeKeyHeadless('minimax-cn', { cwd: dir, env: {}, authPath });
    expect(r.removed).toEqual([{ file: authPath, key: 'minimax-cn' }]);
    expect(JSON.parse(readFileSync(authPath, 'utf8'))['minimax-cn']).toBeUndefined();
  });

  test('native: .env 剥 MIMO_API_KEY 行 + env 对称清除, 他人键与 auth.json 不动', () => {
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ deepseek: { type: 'api_key', key: 'keep' } }));
    const env: Record<string, string | undefined> = { MIMO_API_KEY: 'sk-mimo-x', MIMO_BASE_URL: 'https://x/v1' };
    writeFileSync(join(dir, '.env'), 'MIMO_API_KEY=sk-mimo-x\nMIMO_BASE_URL=https://x/v1\n');
    const r = removeKeyHeadless('mimo', { cwd: dir, env, authPath });
    expect(r.removed).toEqual([{ file: join(dir, '.env'), key: 'MIMO_API_KEY' }]);
    expect(env.MIMO_API_KEY).toBeUndefined(); // 注入反向: 当前进程不再见这把 key
    expect(env.MIMO_BASE_URL).toBe('https://x/v1');
    const rest = readFileSync(join(dir, '.env'), 'utf8');
    expect(rest).not.toContain('MIMO_API_KEY');
    expect(rest).toContain('MIMO_BASE_URL=https://x/v1');
    expect(JSON.parse(readFileSync(authPath, 'utf8')).deepseek.key).toBe('keep');
  });

  test('无凭证 → removed 空 + warning 真话', () => {
    const r = removeKeyHeadless('kimi-coding', { cwd: dir, env: {}, authPath: join(dir, 'auth.json') });
    expect(r.removed).toEqual([]);
    expect(r.warnings).toEqual(['no stored credential for kimi-coding']);
  });

  test('auth.json 非法 JSON → warning, 文件不改动', () => {
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, '{not json');
    const r = removeKeyHeadless('kimi-coding', { cwd: dir, env: {}, authPath });
    expect(r.removed).toEqual([]);
    expect(r.warnings.some((w) => w.includes('非法 JSON'))).toBe(true);
    expect(readFileSync(authPath, 'utf8')).toBe('{not json');
  });

  test('claude-code → 不删, 指路 claude CLI', () => {
    const r = removeKeyHeadless('claude-code', { cwd: dir, env: {}, authPath: join(dir, 'auth.json') });
    expect(r.removed).toEqual([]);
    expect(r.warnings.some((w) => w.includes('claude logout'))).toBe(true);
  });

  test('空 provider → throw', () => {
    expect(() => removeKeyHeadless('', { cwd: dir })).toThrow(/provider required/);
  });
});
describe('applyPresetHeadless', () => {
  test('cn-trio: env 矩阵写盘+注入 + config 角色落 config.json (无 plan)', () => {
    const env: Record<string, string | undefined> = {};
    const r = applyPresetHeadless('cn-trio', { cwd: dir, env });
    expect(r.presetId).toBe('cn-trio');

    // env 矩阵注入 (精确值)。
    expect(env.OMD_ITER_CONDUCTOR_MODEL).toBe('kimi-coding:k3-256k');
    expect(env.OMD_ITER_LEAF_MODEL).toBe('deepseek:deepseek-v4-flash');
    expect(env.OMD_REDUCE_MODEL).toBe('minimax-cn:MiniMax-M3'); // 2026-09-11: 合成座换 M3
    expect(env.OMD_JUDGE_MODEL).toBe('kimi-coding:k3-256k');
    // 写盘。
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('OMD_ITER_CONDUCTOR_MODEL');

    // config 角色 → config.json (无 plan)。
    const cfg = JSON.parse(readFileSync(process.env.OMD_CONFIG_PATH!, 'utf8'));
    expect(cfg.models.conductor).toBe('kimi-coding:k3-256k');
    expect(cfg.models.leaf).toBe('deepseek:deepseek-v4-flash');
    expect(cfg.models.verifier).toBe('kimi-coding:k3-256k');
    // dream 座 2026-08-02 摘除 (ADR-0003) —— preset 不该再往 config 里写它。
    expect(cfg.models.dream).toBeUndefined();
    expect(cfg.models.plan).toBeUndefined();
    expect(cfg.multimodalPool).toEqual(['minimax-cn:MiniMax-M3']);
  });

  test('未知 preset → throw', () => {
    expect(() => applyPresetHeadless('nope', { cwd: dir, env: {} })).toThrow(/unknown preset/);
  });

  test('customApis preset → 自定 provider 写 models.json (统一-registry 迁移), PI_AGENT_DIR 隔离', () => {
    // base-opencode-go 带 customApis: opencode-go。env 里给 PI_AGENT_DIR (隔离到 temp, 不碰真 ~/.pi)。
    const env: Record<string, string | undefined> = { PI_AGENT_DIR: dir, OPENCODE_API_KEY: 'sk-oc' };
    const r = applyPresetHeadless('base-opencode-go', { cwd: dir, env });
    expect(r.customApis).toContain('opencode-go');
    // 自定 provider 落 models.json (不落 config.json.apis — 该链已废)。
    const mj = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(mj.providers['opencode-go']).toMatchObject({
      baseUrl: expect.any(String),
      apiKey: '$OPENCODE_API_KEY', // 落引用, 非明文
      api: 'openai-completions',
    });
    // config.json 不再有 apis 段。
    const cfg = JSON.parse(readFileSync(process.env.OMD_CONFIG_PATH!, 'utf8'));
    expect(cfg.apis).toBeUndefined();
    // key 在 env → callModel 侧已注册 (registerProvidersFromModelsJson 活注入)。
    expect(getProvider('opencode-go')).toBeTruthy();
  });
});

describe('setRoleHeadless', () => {
  test('conductor 落 config.json', () => {
    const r = setRoleHeadless('conductor', 'kimi-coding:k3');
    expect(r).toEqual({ role: 'conductor', coord: 'kimi-coding:k3' });
    const cfg = JSON.parse(readFileSync(process.env.OMD_CONFIG_PATH!, 'utf8'));
    expect(cfg.models.conductor).toBe('kimi-coding:k3');
  });

  test('不在登记表的座拒 + 全座位可调 + 坏坐标拒', () => {
    expect(() => setRoleHeadless('plan', 'x:y')).toThrow(/不在座位登记表/);
    // 切片 A: 全座位可调 —— judge 在登记表里 (旧清单只有 conductor/leaf/verifier), 现在能落。
    expect(() => setRoleHeadless('judge', 'x:y')).not.toThrow();
    expect(() => setRoleHeadless('conductor', 'not-a-coord')).toThrow(/格式非法/);
  });
});

describe('toggleHud', () => {
  test('on 装 → off 卸 (settings.local.json)', () => {
    const settings = join(dir, '.claude', 'settings.local.json');
    const on = toggleHud(dir, true, { cwd: dir });
    expect(on.status).toBe('installed');
    expect(JSON.parse(readFileSync(settings, 'utf8')).statusLine.command).toContain('omd-hud.ts');

    const off = toggleHud(dir, false, { cwd: dir });
    expect(off.status).toBe('removed');
    expect(JSON.parse(readFileSync(settings, 'utf8')).statusLine).toBeUndefined();
  });

  test('off 空 repo → not-present', () => {
    expect(toggleHud(dir, false, { cwd: dir }).status).toBe('not-present');
  });
});
