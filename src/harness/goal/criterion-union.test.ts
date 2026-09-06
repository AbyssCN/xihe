/**
 * 共识候选取并集 —— 纯模块的契约测试 (契约
 * `docs/plan/2026-09-06-共识并集验收-执行契约.md` 切片 1, INV-1..INV-4)。零 IO 零 LLM。
 *
 * 反向自检 (证伪方式, 契约 §证伪):
 *  · 去掉去重 (`add` 里不查 `basePaths.includes`) ⇒ INV-1 的 `paths === 2` 红;
 *  · 不看 runner (`runnerHead` 比较那一行删掉) ⇒ INV-2 红 (两条不同 runner 会被拼成一条跑不起来的命令);
 *  · `blocked` 的返回值不看 (照收被闸拒的那份) ⇒ INV-4 红。
 */
import { describe, expect, test } from 'bun:test';
import { pathArgs, runnerHead, unionCriterionCommands } from './criterion-union';

describe('runnerHead —— 归一后的首词组', () => {
  test('裸 runner / 带开关 ⇒ 首词', () => {
    expect(runnerHead('pytest')).toBe('pytest');
    expect(runnerHead('pytest -q tests/a.py')).toBe('pytest');
  });

  test('子命令是 runner 身份的一部分 (`bun test` ≠ `bun run`)', () => {
    expect(runnerHead('bun test src/a.test.ts')).toBe('bun test');
    expect(runnerHead('bun run build')).toBe('bun run');
    expect(runnerHead('cargo test --no-run')).toBe('cargo test');
    expect(runnerHead('go test ./...')).toBe('go test');
  });

  test('壳只说"用哪个环境跑", 不说"跑的是什么" ⇒ 剥掉', () => {
    // 归一是并集能不能拼的**唯一**判据 —— 这三条写法指的是同一个 runner, 不归一就永远拼不上。
    expect(runnerHead('python -m pytest -q tests/a.py')).toBe('pytest');
    expect(runnerHead('python3 -m pytest tests/a.py')).toBe('pytest');
    expect(runnerHead('uv run pytest tests/a.py')).toBe('pytest');
    expect(runnerHead('bunx tsc --noEmit')).toBe('tsc');
  });

  test('空命令 ⇒ 空串 (不编一个首词出来)', () => {
    expect(runnerHead('   ')).toBe('');
  });
});

describe('pathArgs —— 路径形参数 (含 :: test id)', () => {
  test('`::` test id 整条留着 —— 并集要拼的是 token 本身, 不是拆开的文件 + id', () => {
    expect(pathArgs('pytest -q tests/a.py tests/b.py::test_x')).toEqual(['tests/a.py', 'tests/b.py::test_x']);
  });

  test('开关 / 子命令 / 断言词不是路径', () => {
    expect(pathArgs('bun test -t 名字 src/a.test.ts')).toEqual(['src/a.test.ts']);
    expect(pathArgs('go test ./...')).toEqual(['./...']);
  });

  test('裸整跑 ⇒ 空 (它已经是最宽的那条)', () => {
    expect(pathArgs('bun test')).toEqual([]);
    expect(pathArgs('pytest -q')).toEqual([]);
  });

  test('重复 token 去重保序', () => {
    expect(pathArgs('pytest tests/a.py tests/a.py')).toEqual(['tests/a.py']);
  });
});

describe('unionCriterionCommands', () => {
  test('INV-1: 同 runner ⇒ 去重后拼成一条, paths 数的是结果里的路径参数', () => {
    const r = unionCriterionCommands('pytest -q tests/a.py', ['pytest -q tests/b.py::t1', 'pytest -q tests/a.py']);
    expect(r.command).toBe('pytest -q tests/a.py tests/b.py::t1');
    expect(r.applied).toBe(true);
    expect(r.paths).toBe(2);
    expect(r.dropped).toBe(0);
  });

  test('INV-2: runner 首词不同 ⇒ 不拼, 命令原样, why 说明', () => {
    const r = unionCriterionCommands('bun test src/a.test.ts', ['pytest -q tests/b.py']);
    expect(r.applied).toBe(false);
    expect(r.command).toBe('bun test src/a.test.ts');
    expect(r.why).toContain('runner');
  });

  test('INV-2 反面: 写法不同但归一后同 runner ⇒ 照拼 (归一不生效则本条红)', () => {
    const r = unionCriterionCommands('pytest -q tests/a.py', ['python -m pytest tests/b.py']);
    expect(r.applied).toBe(true);
    expect(r.command).toBe('pytest -q tests/a.py tests/b.py');
  });

  test('INV-3: 基底是裸整跑 ⇒ 不拼 (它已最宽), paths 为 0', () => {
    const r = unionCriterionCommands('bun test', ['bun test src/b.test.ts']);
    expect(r.applied).toBe(false);
    expect(r.command).toBe('bun test');
    expect(r.paths).toBe(0);
    expect(r.why).toContain('裸整跑');
  });

  test('INV-4: 被闸拒的那份不进并集, dropped 计数', () => {
    const r = unionCriterionCommands('pytest -q tests/a.py', ['pytest -q tests/bad.py', 'pytest -q tests/c.py'], {
      blocked: (cmd) => (cmd.includes('bad') ? '[blocked missing-path-arg: 假的]' : null),
    });
    expect(r.dropped).toBe(1);
    expect(r.command).toBe('pytest -q tests/a.py tests/c.py');
    expect(r.paths).toBe(2);
  });

  test('INV-4 边界: 被闸拒的那份 runner 不同也不算"runner 冲突" —— 它压根没进并集', () => {
    const r = unionCriterionCommands('pytest -q tests/a.py', ['bun test src/b.test.ts'], {
      blocked: () => '[blocked lang-mismatch: 假的]',
    });
    expect(r.dropped).toBe(1);
    expect(r.applied).toBe(false);
    expect(r.command).toBe('pytest -q tests/a.py');
  });

  test('其余候选没带来新路径 ⇒ applied=false 而不是"拼了个一样的" (命令零改动)', () => {
    const r = unionCriterionCommands('pytest -q tests/a.py', ['pytest tests/a.py']);
    expect(r.applied).toBe(false);
    expect(r.command).toBe('pytest -q tests/a.py');
    expect(r.paths).toBe(1);
  });

  test('`&&` 链 ⇒ 不拼 (追加位置说不清, 拼上去改的是最后一环的语义)', () => {
    const r = unionCriterionCommands('pytest tests/a.py && pytest tests/z.py', ['pytest tests/b.py']);
    expect(r.applied).toBe(false);
    expect(r.command).toBe('pytest tests/a.py && pytest tests/z.py');
    expect(r.why).toContain('&&');
  });

  test('基底为空 ⇒ 不拼且不抛 (空基底拼出来的是一条没有 runner 的命令)', () => {
    const r = unionCriterionCommands('  ', ['pytest tests/b.py']);
    expect(r.applied).toBe(false);
    expect(r.paths).toBe(0);
  });

  test('候选为空 ⇒ 不拼, 命令原样 (共识只拿到一份时的常态)', () => {
    const r = unionCriterionCommands('pytest -q tests/a.py', []);
    expect(r.applied).toBe(false);
    expect(r.command).toBe('pytest -q tests/a.py');
  });

  test('不变式: paths 恒等于结果命令里的路径参数个数 (两个数分开算就会漂)', () => {
    const cases: [string, string[]][] = [
      ['pytest -q tests/a.py', ['pytest tests/b.py::t1', 'pytest tests/c.py']],
      ['bun test', ['bun test src/b.test.ts']],
      ['bun test src/a.test.ts', ['pytest tests/b.py']],
      ['pytest -q tests/a.py', []],
    ];
    for (const [chosen, others] of cases) {
      const r = unionCriterionCommands(chosen, others);
      expect(pathArgs(r.command).length).toBe(r.paths);
    }
  });
});
