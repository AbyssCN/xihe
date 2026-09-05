/**
 * W3 runner 就绪预检 —— 契约 `docs/plan/2026-09-06-墙钟与读次数-执行契约.md` INV-5。
 *
 * 治的病 (契约 §0 末段): `env-install` 步与「`No module named pytest`」在多题出现 ——
 * 每一题都在自己那一轮里发现 pytest 没装、自己去装一遍。那是**环境事实**, 属于点火前的
 * 一次性预检, 不该由每个执行体各花几轮去摸。
 *
 * **不真装** (本文件): pip 那一跳全走注入的 `run`, 测试进程一个包都不下载。
 *
 * 反向自检 (每条当场证伪过):
 *  · `install:true` 那支不调 pip ⇒ 「调了 pip 且再探一次」当场红;
 *  · `install:false` 也调 pip ⇒ 「不调 pip」当场红 (默认不装别人的依赖是承重条);
 *  · 非 python 仓也返 runner ⇒ 「runner === null」当场红;
 *  · pip 失败时把 `installed` 写成缺席 ⇒ 「装了但没成 = false, 不是缺席」当场红 (NULL ≠ false)。
 */
import { describe, expect, test } from 'bun:test';
import type { EnvFacts, LanguageEvidence } from '../env-facts';
import type { SpawnLike } from './falsify-tests';
import { ensureTestRunner, PIP_TIMEOUT_MS } from './runner-ready';

const lang = (over: Partial<LanguageEvidence> & { language: LanguageEvidence['language'] }): LanguageEvidence => ({
  markers: [],
  sourceFiles: 10,
  testFiles: 2,
  runnersOnPath: [],
  runnersMissing: [],
  enabled: true,
  why: 'fixture',
  ...over,
});

const facts = (languages: LanguageEvidence[]): EnvFacts => ({
  root: '/w',
  languages,
  enabledBins: [...new Set(languages.flatMap((l) => l.runnersOnPath))],
  testCommandCandidates: [],
  scanned: { files: 1, dirs: 1, truncated: false, unreadable: [] },
});

/** 记下每一次 spawn 的 argv; 退出码按队列给 (给完了取最后一个)。 */
function runStub(exitCodes: number[]): { run: SpawnLike; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const run: SpawnLike = (argv) => {
    calls.push(argv);
    const code = exitCodes[Math.min(i++, exitCodes.length - 1)] ?? 0;
    return { exitCode: code, stdout: code === 0 ? 'pytest 8.0.0' : '', stderr: code === 0 ? '' : 'No matching distribution' };
  };
  return { run, calls };
}

describe('INV-5: ensureTestRunner', () => {
  test('★ pytest 已在 PATH ⇒ present, 一次 spawn 都不起', () => {
    const { run, calls } = runStub([0]);
    const r = ensureTestRunner(facts([lang({ language: 'python', runnersOnPath: ['pytest', 'python3'] })]), '/w', { install: true, run });
    expect(r).toMatchObject({ language: 'python', runner: 'pytest', present: true });
    expect(r.installed).toBeUndefined(); // 没装 ≠ 装失败 (NULL ≠ false)
    expect(calls).toHaveLength(0);
  });

  test('★ pytest 不在 + install:true ⇒ 调了 pip 且再探一次, installed === true', () => {
    const { run, calls } = runStub([0, 0]);
    const r = ensureTestRunner(facts([lang({ language: 'python', runnersOnPath: ['python3'] })]), '/w', { install: true, run });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['python3', '-m', 'pip', 'install', '-q', 'pytest']);
    expect(calls[1]!.join(' ')).toContain('pytest');
    expect(r.present).toBe(true);
    expect(r.installed).toBe(true);
  });

  test('★ install:false ⇒ 一次 pip 都不调, present === false (只记事实)', () => {
    const { run, calls } = runStub([0]);
    const r = ensureTestRunner(facts([lang({ language: 'python', runnersOnPath: ['python3'] })]), '/w', { install: false, run });
    expect(calls).toHaveLength(0);
    expect(r.present).toBe(false);
    expect(r.installed).toBeUndefined();
    expect(r.why).toContain('OMD_ENSURE_TEST_RUNNER');
  });

  test('★ 非 python 仓 ⇒ runner === null (本预检只管 pytest, 不替别的语言硬凑)', () => {
    const { run, calls } = runStub([0]);
    const r = ensureTestRunner(facts([lang({ language: 'js', runnersOnPath: ['bun'] })]), '/w', { install: true, run });
    expect(r.runner).toBeNull();
    expect(r.present).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('★ pip 失败 ⇒ installed === false 且 why 带原文 (装了没成 ≠ 没装)', () => {
    const { run } = runStub([1]);
    const r = ensureTestRunner(facts([lang({ language: 'python', runnersOnPath: ['python3'] })]), '/w', { install: true, run });
    expect(r.present).toBe(false);
    expect(r.installed).toBe(false);
    expect(r.why).toContain('No matching distribution');
  });

  test('★ pip 抛错 ⇒ 不掀桌, installed === false, 原文进 why (fail-open 不吞证据)', () => {
    const run: SpawnLike = () => {
      throw new Error('spawn ENOENT');
    };
    const r = ensureTestRunner(facts([lang({ language: 'python', runnersOnPath: ['python3'] })]), '/w', { install: true, run });
    expect(r.installed).toBe(false);
    expect(r.why).toContain('spawn ENOENT');
  });

  test('★ pip 超时按失败记 (120 s 上限就是为它设的)', () => {
    const run: SpawnLike = (argv) => {
      expect(argv[0]).toBe('python3');
      return { exitCode: null, stdout: '', stderr: '', timedOut: true };
    };
    const r = ensureTestRunner(facts([lang({ language: 'python', runnersOnPath: ['python3'] })]), '/w', { install: true, run });
    expect(r.installed).toBe(false);
    expect(r.why).toContain('超时');
    expect(PIP_TIMEOUT_MS).toBe(120_000);
  });

  test('★ 装完再探仍探不到 ⇒ present false 且说得出是哪一步没成 (别把「装了」读成「能跑」)', () => {
    const { run, calls } = runStub([0, 1]);
    const r = ensureTestRunner(facts([lang({ language: 'python', runnersOnPath: ['python3'] })]), '/w', { install: true, run });
    expect(calls).toHaveLength(2);
    expect(r.installed).toBe(false);
    expect(r.present).toBe(false);
  });

  test('空仓 (一门语言都没探出来) ⇒ language 与 runner 都是 null', () => {
    const { run } = runStub([0]);
    const r = ensureTestRunner(facts([]), '/w', { install: true, run });
    expect(r.language).toBeNull();
    expect(r.runner).toBeNull();
  });
});
