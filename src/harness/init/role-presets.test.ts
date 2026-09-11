/**
 * role-presets 形状守卫: env key 白名单 / 坐标格式 / pool·premium·customApi·keyPrompt 形状。
 * 模型 id 换代只该动 role-presets.ts — 这里锁的是"结构不烂", 不锁具体 id。
 */
import { describe, expect, test } from 'bun:test';
import { MODEL_ROLES } from '../../model/role-models';
import { ROLE_PRESETS, ROLE_ENV_ALLOWLIST, coordProvider } from './role-presets';

/** provider:model 完整坐标 (小写 provider, 冒号后非空)。 */
const COORD_RE = /^[a-z0-9-]+:\S+$/;

describe('ROLE_PRESETS 形状', () => {
  test('恰好五档, id 唯一且非空 label', () => {
    expect(ROLE_PRESETS.length).toBe(5);
    const ids = ROLE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of ROLE_PRESETS) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  test('env key 全部 ∈ 引擎白名单 (无未知 env), 白名单含 OMD_REVIEW_SPEC_MODEL', () => {
    expect(ROLE_ENV_ALLOWLIST).toContain('OMD_REVIEW_SPEC_MODEL');
    for (const p of ROLE_PRESETS) {
      for (const key of Object.keys(p.env)) {
        expect(ROLE_ENV_ALLOWLIST).toContain(key);
      }
    }
  });

  test('每档都写 runtime provider+model 且成对', () => {
    for (const p of ROLE_PRESETS) {
      expect(p.env.OMD_RUNTIME_PROVIDER).toBeTruthy();
      expect(p.env.OMD_RUNTIME_MODEL).toBeTruthy();
      // runtime 是裸 provider / 裸 model, 不是坐标
      expect(p.env.OMD_RUNTIME_PROVIDER).not.toContain(':');
    }
  });

  test('*_MODEL env 值是合法 provider:model 坐标, ROUTER_POOL 是坐标逗号表', () => {
    for (const p of ROLE_PRESETS) {
      for (const [key, value] of Object.entries(p.env)) {
        if (key === 'OMD_RUNTIME_PROVIDER' || key === 'OMD_RUNTIME_MODEL') continue;
        const coords = key.startsWith('OMD_ROUTER_POOL_') ? value.split(',') : [value];
        for (const c of coords) expect(c).toMatch(COORD_RE);
      }
    }
  });

  test('multimodalPool (便宜层+贵层) 坐标合法且 provider 有就绪通道 (keyPrompt 或 pi OAuth)', () => {
    for (const p of ROLE_PRESETS) {
      const gated = [...(p.keyPrompts ?? []).map((k) => k.provider), ...(p.oauthProviders ?? [])];
      for (const c of [...(p.multimodalPool ?? []), ...(p.multimodalPoolPremium ?? [])]) {
        expect(c).toMatch(COORD_RE);
        expect(gated).toContain(coordProvider(c));
      }
    }
  });

  test('三档贵层池符合规格: ① glm 网关贵层 / ② 无贵层 / ③ zhipu+kimi 贵层', () => {
    const [base, standard, ultimate] = ROLE_PRESETS;
    expect(base!.multimodalPoolPremium).toEqual(['opencode-go:glm-5.2']);
    expect(standard!.multimodalPoolPremium ?? []).toEqual([]);
    expect(ultimate!.multimodalPoolPremium).toEqual(['zhipu:glm-5.2', 'kimi-coding:k3-256k']);
  });

  test('customApis 形状: id 非空 / https baseUrl / keyEnv 大写 *_API_KEY', () => {
    for (const p of ROLE_PRESETS) {
      for (const api of p.customApis ?? []) {
        expect(api.id).toMatch(/^[a-z0-9-]+$/);
        expect(api.baseUrl).toMatch(/^https:\/\//);
        expect(api.keyEnv).toMatch(/^[A-Z0-9_]+_API_KEY$/);
      }
    }
  });

  test('env 里引用的 provider 必可解析 (内置 env / customApis 注册 / pi OAuth 通道)', () => {
    // claude-code = Claude 订阅 SDK 通道 (凭证是 claude CLI 登录, 不经 env key 也不经 pi auth.json), 引擎恒认识。
    const builtin = new Set(['deepseek', 'mimo', 'claude-code']);
    for (const p of ROLE_PRESETS) {
      const registered = new Set([...builtin, ...(p.customApis ?? []).map((a) => a.id), ...(p.oauthProviders ?? [])]);
      for (const [key, value] of Object.entries(p.env)) {
        if (key === 'OMD_RUNTIME_PROVIDER') {
          expect(registered).toContain(value);
          continue;
        }
        if (key === 'OMD_RUNTIME_MODEL') continue;
        const coords = key.startsWith('OMD_ROUTER_POOL_') ? value.split(',') : [value];
        for (const c of coords) expect(registered).toContain(coordProvider(c));
      }
      for (const c of [...(p.multimodalPool ?? []), ...(p.multimodalPoolPremium ?? [])]) {
        expect(registered).toContain(coordProvider(c));
      }
      for (const cr of p.configRoles ?? []) expect(registered).toContain(coordProvider(cr.coord));
    }
  });

  test('configRoles 的 role 合法 + 坐标合法 (每档 verifier 跨家族)', () => {
    for (const p of ROLE_PRESETS) {
      const verifiers = (p.configRoles ?? []).filter((cr) => cr.role === 'verifier');
      expect(verifiers.length).toBe(1);
      for (const cr of p.configRoles ?? []) {
        expect(MODEL_ROLES).toContain(cr.role);
        expect(cr.coord).toMatch(COORD_RE);
      }
    }
  });

  test('keyPrompts 形状: env 大写 + label 非空 + 无重复', () => {
    for (const p of ROLE_PRESETS) {
      const envs = (p.keyPrompts ?? []).map((k) => k.env);
      expect(new Set(envs).size).toBe(envs.length);
      for (const kp of p.keyPrompts ?? []) {
        expect(kp.env).toMatch(/^[A-Z0-9_]+$/);
        expect(kp.label.length).toBeGreaterThan(0);
      }
    }
  });

  test('档③ 写 OMD_REVIEW_SPEC_MODEL (review Spec 轴) 且注册 zhipu 端点', () => {
    const ultimate = ROLE_PRESETS.find((p) => p.id === 'cn-ultimate')!;
    expect(ultimate.env.OMD_REVIEW_SPEC_MODEL).toBe('zhipu:glm-5.2');
    expect((ultimate.customApis ?? []).map((a) => a.id)).toContain('zhipu');
  });
});

describe('coordProvider', () => {
  test('取坐标前半, 裸名原样返', () => {
    expect(coordProvider('deepseek:deepseek-v4-flash')).toBe('deepseek');
    expect(coordProvider('mimo')).toBe('mimo');
  });
});
