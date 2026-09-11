/**
 * wizard preset 流测试: 脚本化 WizardIO 驱动 "基础档" (档① base-opencode-go),
 * 断言写入的 env key 矩阵 + persistMultimodalPool(Premium) / persistRoleModel 落 config 调用。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WizardIO, PresetPersistDeps } from './wizard';
import { runInitWizard, applyRolePreset, upsertEnv, listPiAuthReady, runPiOAuthStep, runRoleTuneStep, runProviderOverviewStep, runGrillChannelStep, GRILL_TOKEN_ENV } from './wizard';
import { ROLE_PRESETS } from './role-presets';

/** 隔离真实 ~/.pi/agent/auth.json (本机可能已登录) 的空 piAuth 注入。 */
const NO_PI_AUTH = { authPath: '/nonexistent/auth.json' };
/** 隔离真实 pi 目录/env key 的空目录注入 (总览步确定性)。 */
const NO_CATALOG = { getProviders: () => [] as string[] };

/** 脚本化 IO: select/ask/confirm 按队列出答案, note 收集。 */
function scriptedIO(script: {
  selects: Array<string | undefined>;
  asks: string[];
  confirms: boolean[];
}): { io: WizardIO; notes: string[]; askLog: string[] } {
  const notes: string[] = [];
  const askLog: string[] = [];
  const io: WizardIO = {
    select: async () => script.selects.shift(),
    ask: async (question, opts) => {
      askLog.push(question);
      const v = script.asks.shift() ?? '';
      return v || opts?.defaultValue || '';
    },
    confirm: async () => script.confirms.shift() ?? false,
    note: (m) => {
      notes.push(m);
    },
  };
  return { io, notes, askLog };
}

function fakePersist(): {
  persist: PresetPersistDeps;
  calls: {
    apis: string[];
    pools: string[][];
    premiums: string[][];
    roles: Array<[string, string]>;
  };
} {
  const calls = {
    apis: [] as string[],
    pools: [] as string[][],
    premiums: [] as string[][],
    roles: [] as Array<[string, string]>,
  };
  return {
    calls,
    persist: {
      upsertProvider: (input: { id: string; baseUrl: string; keyEnv: string }) => calls.apis.push(input.id),
      persistMultimodalPool: (coords) => calls.pools.push(coords),
      persistMultimodalPoolPremium: (coords) => calls.premiums.push(coords),
      persistRoleModel: (role, coord) => calls.roles.push([role, coord]),
    },
  };
}

const okFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

describe('runInitWizard · preset-first 主流程', () => {
  test('档① (base-opencode-go): 首问即选档 → 角色矩阵 env + 双层池 + verifier config', async () => {
    const base = ROLE_PRESETS[0]!;
    expect(base.id).toBe('base-opencode-go');
    const { io, notes } = scriptedIO({
      // ② 配置方案 = 档① (preset-first: 第一个 select 就是选档)
      selects: [base.id],
      // 档① keyPrompt: OPENCODE_API_KEY
      asks: ['oc-key'],
      confirms: [false, false, false], // ① OAuth 登录跳过 → ③ web 跳过 → ④ 角色微调跳过
    });
    const { persist, calls } = fakePersist();
    let written = '';
    const env: Record<string, string | undefined> = {};

    const result = await runInitWizard({
      io,
      env,
      cwd: '/tmp/fake',
      writeEnv: (_p, c) => {
        written = c;
      },
      fetchImpl: okFetch,
      persist,
      piAuth: NO_PI_AUTH,
      providerCatalog: NO_CATALOG,
    });

    expect(result).not.toBeNull();
    // runtime 坐标来自 preset env
    expect(result!.provider).toBe('opencode-go');
    expect(result!.model).toBe('deepseek-v4-pro');
    // cwd 无 .env → 写全局 ~/.omd/env
    expect(result!.envPath.endsWith('/.omd/env')).toBe(true);
    // 角色矩阵 env 全写入
    for (const key of Object.keys(base.env)) expect(result!.writtenKeys).toContain(key);
    expect(result!.writtenKeys).toContain('OPENCODE_API_KEY');
    // env 内容含 preset 值 (一把网关 key, 多家族坐标)
    expect(written).toContain('OMD_CG_CONDUCTOR_MODEL=opencode-go:deepseek-v4-flash');
    expect(written).toContain('OMD_PLAN_MODEL=opencode-go:deepseek-v4-pro');
    expect(written).toContain('OMD_CG_AGENT_MODEL=opencode-go:qwen3.7-plus');
    expect(written).toContain('OMD_REDUCE_MODEL=opencode-go:glm-5.2');
    expect(written).toContain('OPENCODE_API_KEY=oc-key');
    // config.json 写入口: 双层多模态池 + verifier 跨家族 + opencode-go 端点注册
    expect(calls.pools).toEqual([['opencode-go:qwen3.7-plus']]);
    expect(calls.premiums).toEqual([['opencode-go:glm-5.2']]);
    expect(calls.roles).toEqual([['verifier', 'opencode-go:glm-5.2']]);
    expect(calls.apis).toEqual(['opencode-go']);
    // 汇总表出现
    expect(notes.some((n) => n.includes('角色矩阵'))).toBe(true);
    expect(notes.some((n) => n.includes('multimodalPoolPremium'))).toBe(true);
  });

  test('极简档: provider 四问 + 探针, 角色走默认', async () => {
    const { io } = scriptedIO({
      selects: ['single', 'deepseek', 'deepseek-v4-pro'],
      asks: ['ds-key', ''], // key → base 回车默认
      confirms: [false, false, false],
    });
    const { persist, calls } = fakePersist();
    let written = '';
    const result = await runInitWizard({
      io,
      env: {},
      cwd: '/tmp/fake',
      writeEnv: (_p, c) => {
        written = c;
      },
      fetchImpl: okFetch,
      persist,
      piAuth: NO_PI_AUTH,
      providerCatalog: NO_CATALOG,
    });
    expect(result!.provider).toBe('deepseek');
    expect(result!.model).toBe('deepseek-v4-pro');
    expect(result!.probe).toEqual({ ok: true, detail: 'HTTP 200' });
    expect(written).toContain('OMD_RUNTIME_PROVIDER=deepseek');
    expect(written).toContain('DEEPSEEK_API_KEY=ds-key');
    expect(calls.roles).toEqual([]); // 极简不动角色 config
  });

  test('④ 逐角色微调: select 循环选角色→填坐标; env 角色进 updates, config 角色走 persistRoleModel', async () => {
    const { io, notes } = scriptedIO({
      selects: ['OMD_ITER_CONDUCTOR_MODEL', 'config:verifier', 'done'],
      asks: ['deepseek:deepseek-v4-pro', 'kimi-coding:k3'],
      confirms: [true],
    });
    const { persist, calls } = fakePersist();
    const updates: Record<string, string> = { OMD_PLAN_MODEL: 'opencode-go:deepseek-v4-pro' };
    await runRoleTuneStep(io, updates, persist, ['kimi-coding']);
    expect(updates.OMD_ITER_CONDUCTOR_MODEL).toBe('deepseek:deepseek-v4-pro'); // env 角色 → updates
    expect(calls.roles).toEqual([['verifier', 'kimi-coding:k3']]); // config 角色 → persist
    // 坐标提示含已配坐标 + pi 就绪 provider
    expect(notes.some((n) => n.includes('opencode-go:deepseek-v4-pro') && n.includes('kimi-coding:<model>'))).toBe(true);
  });

  test('④ 坐标格式校验: "kimi-k3" 缺 provider 前缀 → 拒 + 提示, 不写入', async () => {
    const { io, notes } = scriptedIO({
      selects: ['OMD_ITER_CONDUCTOR_MODEL', 'done'],
      asks: ['kimi-k3'],
      confirms: [true],
    });
    const { persist, calls } = fakePersist();
    const updates: Record<string, string> = {};
    await runRoleTuneStep(io, updates, persist);
    expect(updates.OMD_ITER_CONDUCTOR_MODEL).toBeUndefined();
    expect(calls.roles).toEqual([]);
    expect(notes.some((n) => n.includes('provider:model') && n.includes('kimi-k3'))).toBe(true);
  });

  test('⓪ provider 总览: 全目录列出 + ✓oauth/✓key 就绪标记', () => {
    const { io, notes } = scriptedIO({ selects: [], asks: [], confirms: [] });
    runProviderOverviewStep(io, ['kimi-coding'], {
      getProviders: () => ['anthropic', 'deepseek', 'kimi-coding', 'groq'],
      getEnvApiKey: (p) => (p === 'deepseek' ? 'sk-x' : undefined),
    });
    const overview = notes.find((n) => n.includes('pi 目录 provider'))!;
    expect(overview).toContain('(4 家)');
    expect(overview).toContain('kimi-coding ✓oauth');
    expect(overview).toContain('deepseek ✓key');
    expect(overview).toContain('anthropic'); // 未就绪 → 可配区
    expect(overview).toContain('groq');
  });
});

describe('applyRolePreset · key 跳过闸', () => {
  test('档① OPENCODE key 回车跳过 → 双层池 / verifier config 均不写', async () => {
    const base = ROLE_PRESETS[0]!;
    const { io } = scriptedIO({ selects: [], asks: [''], confirms: [] }); // OPENCODE 提示回车跳过
    const { persist, calls } = fakePersist();
    const updates: Record<string, string> = {};

    await applyRolePreset(base, updates, io, {}, persist);

    for (const [k, v] of Object.entries(base.env)) expect(updates[k]).toBe(v);
    expect(updates.OPENCODE_API_KEY).toBeUndefined();
    expect(calls.pools).toEqual([]);
    expect(calls.premiums).toEqual([]);
    expect(calls.roles).toEqual([]);
  });

  test('pi OAuth 就绪 provider 免 key: keyPrompt 跳过且不计 missing (池/config 照写)', async () => {
    const base = ROLE_PRESETS[0]!;
    const { io, notes, askLog } = scriptedIO({ selects: [], asks: [], confirms: [] });
    const { persist, calls } = fakePersist();
    const updates: Record<string, string> = {};

    await applyRolePreset(base, updates, io, {}, persist, ['opencode-go']);

    expect(askLog).toEqual([]); // 不问 key
    expect(updates.OPENCODE_API_KEY).toBeUndefined();
    expect(notes.some((n) => n.includes('opencode-go') && n.includes('免 key'))).toBe(true);
    // 不算 missing → 池与 verifier config 照写
    expect(calls.pools).toEqual([['opencode-go:qwen3.7-plus']]);
    expect(calls.premiums).toEqual([['opencode-go:glm-5.2']]);
    expect(calls.roles).toEqual([['verifier', 'opencode-go:glm-5.2']]);
  });

  test('档② (cn-standard) 无贵层池 → premium 不调用, mimo 池 + verifier 写入', async () => {
    const standard = ROLE_PRESETS[1]!;
    expect(standard.id).toBe('cn-standard');
    const { io } = scriptedIO({ selects: [], asks: ['mimo-key'], confirms: [] });
    const { persist, calls } = fakePersist();
    const updates: Record<string, string> = { DEEPSEEK_API_KEY: 'ds' };

    await applyRolePreset(standard, updates, io, {}, persist);

    expect(updates.OMD_PLAN_MODEL).toBe('deepseek:deepseek-v4-pro');
    expect(updates.OMD_LENS_MODEL).toBe('deepseek:deepseek-v4-flash');
    expect(calls.apis).toEqual(['minimax-cn']); // 档② 自定 API 只有 minimax-cn (M3 多模态 + verifier, 2026-09-11 换下 mimo)
    expect(calls.pools).toEqual([['minimax-cn:MiniMax-M3']]);
    expect(calls.premiums).toEqual([]); // premium 空 → 不写
    expect(calls.roles).toEqual([['verifier', 'minimax-cn:MiniMax-M3']]);
  });

  test('档③ (cn-ultimate) 掌舵走 pi OAuth: kimi-coding 就绪免 key + ZHIPU 跳过 → premium 剩 kimi-coding', async () => {
    const ultimate = ROLE_PRESETS[2]!;
    expect(ultimate.id).toBe('cn-ultimate');
    // keyPrompts 顺序: QWEN / ZHIPU / DEEPSEEK / MIMO — ZHIPU 回车跳过; kimi-coding 走 piReady 免 key
    const { io, notes } = scriptedIO({
      selects: [],
      asks: ['qwen-key', '', 'ds-key', 'mimo-key'],
      confirms: [],
    });
    const { persist, calls } = fakePersist();
    const updates: Record<string, string> = {};

    await applyRolePreset(ultimate, updates, io, {}, persist, ['kimi-coding']);

    // 掌舵坐标 = pi OAuth 通道
    expect(updates.OMD_RUNTIME_PROVIDER).toBe('kimi-coding');
    expect(updates.OMD_ITER_CONDUCTOR_MODEL).toBe('kimi-coding:k3-256k');
    expect(notes.some((n) => n.includes('kimi-coding') && n.includes('免 key'))).toBe(true);
    expect(calls.apis).toEqual(['minimax-cn', 'qwen', 'zhipu']); // kimi 开放平台 API 不再注册; minimax-cn 管多模态 (2026-09-11)
    // env 不受 key 闸影响: review Spec 轴坐标 + router 池照写
    expect(updates.OMD_REVIEW_SPEC_MODEL).toBe('zhipu:glm-5.2');
    expect(updates.OMD_ROUTER_POOL_INPROC).toBe('qwen:qwen3.7-plus,minimax-cn:MiniMax-M3');
    expect(updates.OMD_ROUTER_POOL_AGENT).toBe('qwen:qwen3.7-plus,qwen:qwen3.7-max');
    // 便宜层全保留; 贵层剔除 zhipu (key 跳过) 剩 kimi-coding
    expect(calls.pools).toEqual([['qwen:qwen3.7-plus', 'minimax-cn:MiniMax-M3']]);
    expect(calls.premiums).toEqual([['kimi-coding:k3-256k']]);
    expect(calls.roles).toEqual([['verifier', 'qwen:qwen3.7-max']]);
  });

  test('档③ kimi-coding 未登录 → /login 指引 (不指向外部 CLI) + 掌舵坐标剔除出 premium', async () => {
    const ultimate = ROLE_PRESETS[2]!;
    const { io, notes } = scriptedIO({ selects: [], asks: ['qwen-key', 'zhipu-key', 'ds-key', 'mimo-key'], confirms: [] });
    const { persist, calls } = fakePersist();
    await applyRolePreset(ultimate, {}, io, {}, persist, []); // piReady 空 = 未登录
    const guide = notes.find((n) => n.includes('kimi-coding') && n.includes('/login'))!;
    expect(guide).toContain('omd'); // 指引指向 omd 内置 pi, 非外部 CLI
    expect(guide).not.toContain('bunx');
    expect(calls.premiums).toEqual([['zhipu:glm-5.2']]); // kimi-coding 剔除
  });
});

describe('pi OAuth 步骤 (⑤′)', () => {
  function fakeAuthJson(content: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'wizard-pi-auth-'));
    const p = join(dir, 'auth.json');
    writeFileSync(p, JSON.stringify(content));
    return p;
  }

  test('listPiAuthReady: api_key 有 key / oauth 有 access 算就绪; 空值/坏文件过滤', () => {
    const p = fakeAuthJson({
      'kimi-coding': { type: 'oauth', access: 'tok', refresh: 'r', expires: 9 },
      openai: { type: 'api_key', key: 'sk-x' },
      empty: { type: 'oauth', access: '' },
    });
    expect(listPiAuthReady(p).sort()).toEqual(['kimi-coding', 'openai']);
    expect(listPiAuthReady('/nonexistent/auth.json')).toEqual([]);
  });

  test('检测: 就绪条目 note 列出; confirm 否 → 不进登录流', async () => {
    const p = fakeAuthJson({ 'kimi-coding': { type: 'oauth', access: 'tok', expires: 9 } });
    const { io, notes } = scriptedIO({ selects: [], asks: [], confirms: [false] });
    await runPiOAuthStep(io, { authPath: p, oauthProviders: () => [] });
    expect(notes.some((n) => n.includes('pi OAuth 已就绪') && n.includes('kimi-coding'))).toBe(true);
  });

  test('内联登录: device code 经 note 展示, 凭证经 saveCredential 写盘', async () => {
    const saved: Array<[string, Record<string, unknown>]> = [];
    const { io, notes } = scriptedIO({ selects: ['github-copilot'], asks: [], confirms: [true] });
    await runPiOAuthStep(io, {
      authPath: '/nonexistent/auth.json',
      oauthProviders: () => [
        {
          id: 'github-copilot',
          name: 'GitHub Copilot',
          login: async (cb) => {
            cb.onDeviceCode({ userCode: 'AB-12', verificationUri: 'https://github.com/login/device' });
            return { access: 'gh-tok', refresh: 'gh-r', expires: 99 };
          },
        },
      ],
      saveCredential: (prov, creds) => saved.push([prov, creds]),
    });
    expect(notes.some((n) => n.includes('github.com/login/device') && n.includes('AB-12'))).toBe(true);
    expect(saved).toEqual([['github-copilot', { access: 'gh-tok', refresh: 'gh-r', expires: 99 }]]);
    expect(notes.some((n) => n.includes('登录成功'))).toBe(true);
  });

  test('kimi-coding (无内置登录件) → omd 内置 /login 指引 (非外部 CLI), 不调 saveCredential', async () => {
    const saved: string[] = [];
    const { io, notes } = scriptedIO({ selects: ['kimi-coding'], asks: [], confirms: [true] });
    await runPiOAuthStep(io, {
      authPath: '/nonexistent/auth.json',
      oauthProviders: () => [],
      saveCredential: (prov) => saved.push(prov),
    });
    const guide = notes.find((n) => n.includes('/login'))!;
    expect(guide).toContain('omd'); // omd 即 pi runtime
    expect(guide).not.toContain('bunx'); // 不再指向外部 CLI
    expect(saved).toEqual([]);
  });

  test('已就绪 provider 不进登录菜单; 全就绪 → 直接返回', async () => {
    // 全就绪 = 内联件 (kimi-coding) + KNOWN_TUI_LOGIN 三家 (anthropic/copilot/codex) 都在 auth.json
    const p = fakeAuthJson({
      'kimi-coding': { type: 'oauth', access: 'tok' },
      anthropic: { type: 'oauth', access: 't2' },
      'github-copilot': { type: 'oauth', access: 't3' },
      'openai-codex': { type: 'oauth', access: 't4' },
    });
    const { io, notes } = scriptedIO({ selects: [], asks: [], confirms: [true] }); // 确认要登录, 但无可登项
    const ready = await runPiOAuthStep(io, {
      authPath: p,
      oauthProviders: () => [{ id: 'anthropic', name: 'Anthropic', login: async () => ({ access: 'x', refresh: 'r', expires: 1 }) }],
    });
    expect(ready.sort()).toEqual(['anthropic', 'github-copilot', 'kimi-coding', 'openai-codex']);
    expect(notes.some((n) => n.includes('全部 OAuth provider 已就绪'))).toBe(true);
  });

  test('登录抛错 → note 失败不抛出 (wizard 不砖)', async () => {
    const { io, notes } = scriptedIO({ selects: ['anthropic'], asks: [], confirms: [true] });
    await runPiOAuthStep(io, {
      authPath: '/nonexistent/auth.json',
      oauthProviders: () => [
        { id: 'anthropic', name: 'Anthropic', login: async () => { throw new Error('boom'); } },
      ],
    });
    expect(notes.some((n) => n.includes('登录失败') && n.includes('boom'))).toBe(true);
  });
});

describe('grill 评论区通道步 (②′)', () => {
  // 合法 oat01 token: 前缀 + 44 字符尾段 (过 ^sk-ant-oat01-[A-Za-z0-9_-]{40,}$)。
  const VALID_TOKEN = `sk-ant-oat01-${'A'.repeat(44)}`;

  test('env 已配 token → 打码显示 + 跳过 (不消费 select, 不写 updates)', async () => {
    const { io, notes } = scriptedIO({ selects: [], asks: [], confirms: [] });
    const updates: Record<string, string> = {};
    await runGrillChannelStep(io, updates, { [GRILL_TOKEN_ENV]: VALID_TOKEN }, '/tmp/fake/.env');
    expect(updates[GRILL_TOKEN_ENV]).toBeUndefined(); // 已配不重写
    const hit = notes.find((n) => n.includes('已配置'))!;
    expect(hit).toContain('sk-ant-oat01-'); // 打码含前缀
    expect(hit).not.toContain(VALID_TOKEN); // 不明文全展示
  });

  test('paste 合法 → 形状闸过 → 写 updates', async () => {
    const { io, notes } = scriptedIO({ selects: ['paste'], asks: [VALID_TOKEN], confirms: [] });
    const updates: Record<string, string> = {};
    await runGrillChannelStep(io, updates, {}, '/tmp/fake/.env');
    expect(updates[GRILL_TOKEN_ENV]).toBe(VALID_TOKEN);
    expect(notes.some((n) => n.includes('token 已收'))).toBe(true);
  });

  test('paste 形状不符 → 重问一次; 第二次仍不符 → 跳过不写', async () => {
    const { io, notes } = scriptedIO({ selects: ['paste'], asks: ['sk-bad', 'still-bad'], confirms: [] });
    const updates: Record<string, string> = {};
    await runGrillChannelStep(io, updates, {}, '/tmp/fake/.env');
    expect(updates[GRILL_TOKEN_ENV]).toBeUndefined();
    expect(notes.filter((n) => n.includes('形状不符')).length).toBe(2); // 重问一次 = 两次提示
  });

  test('skip → 不写 updates, 一行说明研究主链不受影响', async () => {
    const { io, notes } = scriptedIO({ selects: ['skip'], asks: [], confirms: [] });
    const updates: Record<string, string> = {};
    await runGrillChannelStep(io, updates, {}, '/tmp/fake/.env');
    expect(updates[GRILL_TOKEN_ENV]).toBeUndefined();
    expect(notes.some((n) => n.includes('研究主链不受影响'))).toBe(true);
  });

  test('auto (注入替身不真跑 python): runAuto 成功 + 回读 → 写 env, 不写 updates', async () => {
    const { io, notes } = scriptedIO({ selects: ['auto'], asks: [], confirms: [] });
    const updates: Record<string, string> = {};
    const env: Record<string, string | undefined> = {};
    let ranWith = '';
    await runGrillChannelStep(io, updates, env, '/tmp/fake/.env', {
      hasPython3: () => true,
      runAuto: (p) => {
        ranWith = p;
        return true;
      },
      readTokenFromEnv: () => VALID_TOKEN,
    });
    expect(ranWith).toBe('/tmp/fake/.env'); // envPath 透传给配方
    expect(env[GRILL_TOKEN_ENV]).toBe(VALID_TOKEN); // 同步进 env 供本次 boot
    expect(updates[GRILL_TOKEN_ENV]).toBeUndefined(); // auto 由 python 直写 envPath, 不进 updates
    expect(notes.some((n) => n.includes('自动配方写入'))).toBe(true);
  });

  test('auto python3 缺失 → 回落 paste (替身 hasPython3=false, 不真跑)', async () => {
    const { io, notes } = scriptedIO({ selects: ['auto'], asks: [VALID_TOKEN], confirms: [] });
    const updates: Record<string, string> = {};
    let autoCalled = false;
    await runGrillChannelStep(io, updates, {}, '/tmp/fake/.env', {
      hasPython3: () => false,
      runAuto: () => {
        autoCalled = true;
        return true;
      },
    });
    expect(autoCalled).toBe(false); // python 缺失不跑配方
    expect(notes.some((n) => n.includes('python3 未找到'))).toBe(true);
    expect(updates[GRILL_TOKEN_ENV]).toBe(VALID_TOKEN); // 回落 paste 收 token
  });

  test('auto 脚本失败 → 回落 paste (runAuto 返回 false)', async () => {
    const { io, notes } = scriptedIO({ selects: ['auto'], asks: [VALID_TOKEN], confirms: [] });
    const updates: Record<string, string> = {};
    await runGrillChannelStep(io, updates, {}, '/tmp/fake/.env', {
      hasPython3: () => true,
      runAuto: () => false,
      readTokenFromEnv: () => undefined,
    });
    expect(notes.some((n) => n.includes('自动配方未写入'))).toBe(true);
    expect(updates[GRILL_TOKEN_ENV]).toBe(VALID_TOKEN);
  });
});

describe('upsertEnv 与 preset 值', () => {
  test('preset 值 upsert 进已有 .env 不破坏其余行', () => {
    const before = '# comment\nDEEPSEEK_API_KEY=old\nOMD_PLAN_MODEL=x:y\n';
    const after = upsertEnv(before, { OMD_PLAN_MODEL: 'deepseek:deepseek-v4-pro', OMD_JUDGE_MODEL: 'deepseek:deepseek-v4-pro' });
    expect(after).toContain('# comment');
    expect(after).toContain('DEEPSEEK_API_KEY=old');
    expect(after).toContain('OMD_PLAN_MODEL=deepseek:deepseek-v4-pro');
    expect(after).toContain('OMD_JUDGE_MODEL=deepseek:deepseek-v4-pro');
  });
});
