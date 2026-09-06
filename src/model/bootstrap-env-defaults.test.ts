/**
 * applyProductionEnvDefaults —— 生产入口的 env 缺省 (2026-09-06)。
 * 证伪: bootstrap.ts 去掉 `env.OMD_CRITERION_CONSENSUS = '1'` ⇒ ★ 红。
 */
import { describe, expect, test } from 'bun:test';
import { applyProductionEnvDefaults } from './bootstrap';

describe('applyProductionEnvDefaults', () => {
  test('★ 缺席 ⇒ 置 OMD_CRITERION_CONSENSUS=1 并报告', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyProductionEnvDefaults(env, 'production')).toEqual(['OMD_CRITERION_CONSENSUS=1']);
    expect(env.OMD_CRITERION_CONSENSUS).toBe('1');
  });
  test('显式 =0 (逃生口) 不覆盖', () => {
    const env: NodeJS.ProcessEnv = { OMD_CRITERION_CONSENSUS: '0' };
    expect(applyProductionEnvDefaults(env, undefined)).toEqual([]);
    expect(env.OMD_CRITERION_CONSENSUS).toBe('0');
  });
  test('NODE_ENV=test 下一个键都不动 (bun test 的确定性)', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyProductionEnvDefaults(env, 'test')).toEqual([]);
    expect(env.OMD_CRITERION_CONSENSUS).toBeUndefined();
  });
  test('本进程 (bun test) 的 process.env 不被真调用改动', () => {
    const before = process.env.OMD_CRITERION_CONSENSUS;
    applyProductionEnvDefaults();
    expect(process.env.OMD_CRITERION_CONSENSUS).toBe(before);
  });
});
