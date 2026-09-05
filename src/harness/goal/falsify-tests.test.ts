/**
 * src/harness/goal/falsify-tests.test —— 切片 1 的契约测试
 * (契约 `docs/plan/2026-09-05-verifier写证伪测试-执行契约-草案.md` §不变量 INV-1 / INV-2 / INV-3)。
 *
 * 三条不变量各占一段:
 *  · INV-1 `validateFalsifyPlan` 的拒收面 —— 路径不以 `falsify_` 起头 / 含 `..` / 超过 3 条;
 *  · INV-2 注入 runner 的三态 —— 非零 ⇒ red 且 `failing` 非空; 0 ⇒ green; 超时 ⇒ inconclusive;
 *  · INV-3 跑完仓的 `git status --porcelain` 逐字不变, 临时目录已删。
 *
 * **不 mock fs**: 每条用例用 `mkdtemp` 造一个真 git 仓, 只把 runner 注入掉 (那是唯一一处
 * "跑得起来跑不起来" 与本机环境绑死的地方)。
 *
 * **反向自检** (这些测试必须能真红):
 *  · 把 `PATH_RE` 放宽成 `/./` ⇒ INV-1 那四条红;
 *  · 把 `status` 的超时分支删掉 (超时也按退出码念) ⇒ 「超时 ⇒ inconclusive」红;
 *  · 把 `red` 分支的 `failing` 兜底 (一条都认不出时退回全量) 删掉 ⇒ 「failing 非空」红;
 *  · 把 `rmSync(tmp)` 删掉 ⇒ 「临时目录跑完被删」红;
 *  · 把写文件的目标从 `mkdtemp` 改成仓根 ⇒ INV-3 那条红。
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pickRunner, runFalsifyTests, validateFalsifyPlan, type FalsifyPlan, type SpawnLike } from './falsify-tests';

/** 真 git 仓 + 一个**未跟踪**文件 —— porcelain 非空, INV-3 的对比才有判别力 (空 == 空 谁都过)。 */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-falsify-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'main.py'), 'def f():\n    return 1\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  writeFileSync(join(dir, 'scratch.txt'), 'wip\n'); // 未跟踪 → porcelain 有一行
  return dir;
}

function porcelain(root: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf-8' });
}

const PY_PLAN: FalsifyPlan = { tests: [{ path: 'falsify_a.py', content: 'def test_a():\n    assert False\n' }] };

/** 注入 runner: 记下 argv/cwd, 按给定读数回。 */
function stub(ret: Partial<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>): {
  run: SpawnLike;
  calls: { argv: string[]; cwd: string; timeoutMs: number }[];
} {
  const calls: { argv: string[]; cwd: string; timeoutMs: number }[] = [];
  const run: SpawnLike = (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    return { exitCode: ret.exitCode ?? 0, stdout: ret.stdout ?? '', stderr: ret.stderr ?? '', timedOut: ret.timedOut ?? false };
  };
  return { run, calls };
}

describe('INV-1 —— validateFalsifyPlan 的拒收面', () => {
  test('★ 合法计划 (1 条 py) 原样通过', () => {
    const r = validateFalsifyPlan({ tests: [{ path: 'falsify_a.py', content: 'x' }] });
    expect('error' in r).toBe(false);
    expect((r as FalsifyPlan).tests).toHaveLength(1);
  });

  test('★ 合法计划 (3 条 test.ts) 通过 —— 上限是 3 不是 2', () => {
    const r = validateFalsifyPlan({
      tests: [
        { path: 'falsify_a.test.ts', content: 'x' },
        { path: 'falsify_b.test.ts', content: 'y' },
        { path: 'falsify_c.test.ts', content: 'z' },
      ],
    });
    expect('error' in r).toBe(false);
  });

  test('★ 不以 falsify_ 起头 ⇒ 拒, 判词点名那条路径', () => {
    const r = validateFalsifyPlan({ tests: [{ path: 'test_a.py', content: 'x' }] });
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('test_a.py');
  });

  test('★ 含 `..` ⇒ 拒', () => {
    const r = validateFalsifyPlan({ tests: [{ path: 'falsify_..a.py', content: 'x' }] });
    expect('error' in r).toBe(true);
  });

  test('★ 含路径分隔符 ⇒ 拒 (临时目录里只放平铺文件名)', () => {
    const r = validateFalsifyPlan({ tests: [{ path: 'falsify_sub/a.py', content: 'x' }] });
    expect('error' in r).toBe(true);
  });

  test('★ 扩展名不在 (py|test.ts) 里 ⇒ 拒', () => {
    const r = validateFalsifyPlan({ tests: [{ path: 'falsify_a.txt', content: 'x' }] });
    expect('error' in r).toBe(true);
  });

  test('★ 超过 3 条 ⇒ 拒, 判词带条数', () => {
    const tests = ['a', 'b', 'c', 'd'].map((n) => ({ path: `falsify_${n}.py`, content: 'x' }));
    const r = validateFalsifyPlan({ tests });
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('4');
  });

  test('★ 空 tests / 非数组 / 非对象 / 空 content ⇒ 各自拒 (写不出 ≠ 写出来是空的)', () => {
    expect('error' in validateFalsifyPlan({ tests: [] })).toBe(true);
    expect('error' in validateFalsifyPlan({ tests: 'x' })).toBe(true);
    expect('error' in validateFalsifyPlan(null)).toBe(true);
    expect('error' in validateFalsifyPlan('{"tests":[]}')).toBe(true);
    expect('error' in validateFalsifyPlan({ tests: [{ path: 'falsify_a.py', content: '  ' }] })).toBe(true);
    expect('error' in validateFalsifyPlan({ tests: [{ path: 'falsify_a.py' }] })).toBe(true);
  });

  test('★ 同名两条 ⇒ 拒 (后写的会盖掉前一条, 静默少跑一条测试)', () => {
    const r = validateFalsifyPlan({
      tests: [
        { path: 'falsify_a.py', content: 'x' },
        { path: 'falsify_a.py', content: 'y' },
      ],
    });
    expect('error' in r).toBe(true);
  });
});

describe('INV-2 —— 注入 runner 的三态', () => {
  test('★ 退出码非零 ⇒ red, failing 非空且点名挂掉的文件', () => {
    const { run } = stub({ exitCode: 1, stdout: '1 failed\nFAILED falsify_a.py::test_a\n' });
    const r = runFalsifyTests(PY_PLAN, repo(), 'pytest -q', { run });
    expect(r.status).toBe('red');
    expect(r.failing).toEqual(['falsify_a.py']);
  });

  test('★ 退出码非零但输出里认不出文件名 ⇒ 仍 red, failing 退回全量 (非空)', () => {
    const { run } = stub({ exitCode: 1, stdout: 'boom\n' });
    const r = runFalsifyTests(PY_PLAN, repo(), 'pytest -q', { run });
    expect(r.status).toBe('red');
    expect(r.failing).toEqual(['falsify_a.py']);
  });

  test('★ 退出码 0 ⇒ green, failing 空', () => {
    const { run } = stub({ exitCode: 0, stdout: '1 passed\n' });
    const r = runFalsifyTests(PY_PLAN, repo(), 'pytest -q', { run });
    expect(r.status).toBe('green');
    expect(r.failing).toEqual([]);
  });

  test('★ 超时 ⇒ inconclusive (不是 red), why 说得出是超时', () => {
    const { run } = stub({ exitCode: null, timedOut: true });
    const r = runFalsifyTests(PY_PLAN, repo(), 'pytest -q', { run });
    expect(r.status).toBe('inconclusive');
    expect(r.why ?? '').toContain('超时');
  });

  test('★ collection error (pytest 退 2) ⇒ inconclusive —— 跑不起来 ≠ 判红', () => {
    const { run } = stub({ exitCode: 2, stdout: 'ERROR collecting falsify_a.py\n' });
    const r = runFalsifyTests(PY_PLAN, repo(), 'pytest -q', { run });
    expect(r.status).toBe('inconclusive');
    expect(r.why ?? '').toContain('2');
  });

  test('★ 退 1 但输出是 collection error ⇒ inconclusive (bun 的 Cannot find module 走这条)', () => {
    const plan: FalsifyPlan = { tests: [{ path: 'falsify_a.test.ts', content: 'x' }] };
    const { run } = stub({ exitCode: 1, stderr: 'error: Cannot find module "./nope"\n' });
    const r = runFalsifyTests(plan, repo(), 'bun test', { run });
    expect(r.status).toBe('inconclusive');
  });

  test('★ runner 抛错 ⇒ inconclusive, 错误原文进 why (fail-open 不吞证据)', () => {
    const run: SpawnLike = () => {
      throw new Error('spawn ENOENT');
    };
    const r = runFalsifyTests(PY_PLAN, repo(), 'pytest -q', { run });
    expect(r.status).toBe('inconclusive');
    expect(r.why ?? '').toContain('spawn ENOENT');
  });

  test('★ 认不出的 runner ⇒ inconclusive, 一次都不 spawn', () => {
    const { run, calls } = stub({ exitCode: 0 });
    const r = runFalsifyTests(PY_PLAN, repo(), 'make check', { run });
    expect(r.status).toBe('inconclusive');
    expect(calls).toHaveLength(0);
  });

  test('★ runner 与文件类型不匹配 ⇒ inconclusive, 一次都不 spawn', () => {
    const plan: FalsifyPlan = { tests: [{ path: 'falsify_a.test.ts', content: 'x' }] };
    const { run, calls } = stub({ exitCode: 0 });
    const r = runFalsifyTests(plan, repo(), 'pytest -q', { run });
    expect(r.status).toBe('inconclusive');
    expect(calls).toHaveLength(0);
  });
});

describe('argv / cwd —— 契约「未决」里 pytest 的两个旗标首版就带上', () => {
  test('★ pytest: argv 带 --rootdir=<repo> 与 -p no:cacheprovider, cwd = 仓根, timeout 默认 120 秒', () => {
    const root = repo();
    const { run, calls } = stub({ exitCode: 0 });
    runFalsifyTests(PY_PLAN, root, 'pytest -q', { run });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv.slice(0, 2)).toEqual(['pytest', '-q']);
    expect(calls[0]!.argv).toContain(`--rootdir=${root}`);
    expect(calls[0]!.argv.join(' ')).toContain('-p no:cacheprovider');
    expect(calls[0]!.cwd).toBe(root);
    expect(calls[0]!.timeoutMs).toBe(120_000);
  });

  test('★ bun test: 不带 pytest 那两个旗标 (给错 runner 的旗标 = 当场跑不起来)', () => {
    const plan: FalsifyPlan = { tests: [{ path: 'falsify_a.test.ts', content: 'x' }] };
    const { run, calls } = stub({ exitCode: 0 });
    runFalsifyTests(plan, repo(), 'bun test', { run });
    expect(calls[0]!.argv.slice(0, 2)).toEqual(['bun', 'test']);
    expect(calls[0]!.argv.join(' ')).not.toContain('no:cacheprovider');
    expect(calls[0]!.argv.join(' ')).not.toContain('--rootdir');
  });

  test('★ 测试正文真写到盘上, 且落在仓外 —— 传给 runner 的是绝对路径', () => {
    const root = repo();
    let seen: { abs: string; body: string } | undefined;
    const run: SpawnLike = (argv, _opts) => {
      const abs = argv[argv.length - 1]!;
      seen = { abs, body: readFileSync(abs, 'utf8') };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    runFalsifyTests(PY_PLAN, root, 'pytest -q', { run });
    expect(seen?.body).toBe(PY_PLAN.tests[0]!.content);
    expect(seen!.abs.startsWith(root)).toBe(false);
  });
});

describe('pickRunner / ran —— 接线层要的两格 (切片 2 的入参与读数)', () => {
  test('★ 候选里挑与文件类型匹配的那条; 没有匹配的 ⇒ undefined', () => {
    const py: FalsifyPlan = { tests: [{ path: 'falsify_a.py', content: 'x' }] };
    const ts: FalsifyPlan = { tests: [{ path: 'falsify_a.test.ts', content: 'x' }] };
    expect(pickRunner(['bun test', 'pytest -q'], py)).toBe('pytest -q');
    expect(pickRunner(['bun test', 'pytest -q'], ts)).toBe('bun test');
    expect(pickRunner(['go test ./...'], py)).toBeUndefined();
    expect(pickRunner([], py)).toBeUndefined();
    // 混类型: 一条 runner 跑不了两种文件 ⇒ 谁都不挑 (别偷偷只跑一半)。
    expect(pickRunner(['bun test', 'pytest -q'], { tests: [...py.tests, ...ts.tests] })).toBeUndefined();
  });

  test('★ `ran` = 真交给 runner 的文件数; 一次都没 spawn ⇒ 0 (跑了 0 条 ≠ 没跑)', () => {
    const { run } = stub({ exitCode: 0 });
    expect(runFalsifyTests(PY_PLAN, repo(), 'pytest -q', { run }).ran).toBe(1);
    expect(runFalsifyTests(PY_PLAN, repo(), 'make check', { run }).ran).toBe(0);
  });
});

describe('INV-3 —— 跑完仓一个字节都没动, 临时目录已删', () => {
  test('★ 跑前跑后 git status --porcelain 逐字相同 (red 那条路)', () => {
    const root = repo();
    const before = porcelain(root);
    expect(before.trim().length).toBeGreaterThan(0); // 判别力: 别拿空串对空串
    const { run } = stub({ exitCode: 1, stdout: 'FAILED falsify_a.py::test_a\n' });
    runFalsifyTests(PY_PLAN, root, 'pytest -q', { run });
    expect(porcelain(root)).toBe(before);
  });

  test('★ 临时目录跑完被删 (证伪测试永不留痕)', () => {
    let tmpFile = '';
    const run: SpawnLike = (argv) => {
      tmpFile = argv[argv.length - 1]!;
      expect(existsSync(tmpFile)).toBe(true); // 跑的那一刻文件在
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    runFalsifyTests(PY_PLAN, repo(), 'pytest -q', { run });
    expect(existsSync(tmpFile)).toBe(false);
    expect(existsSync(dirname(tmpFile))).toBe(false);
  });

  test('★ runner 抛错时临时目录同样被删 (异常路径不留垃圾)', () => {
    let tmpDir = '';
    const run: SpawnLike = (argv) => {
      tmpDir = dirname(argv[argv.length - 1]!);
      throw new Error('boom');
    };
    runFalsifyTests(PY_PLAN, repo(), 'pytest -q', { run });
    expect(existsSync(tmpDir)).toBe(false);
  });
});
