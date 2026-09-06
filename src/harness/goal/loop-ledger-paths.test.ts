/**
 * 写集对账的路径归一 (2026-09-06)。
 *
 * 现场: code80-m3-ctl `feature-easy-add_python_dotenv_d`: declared 相对 (`src/dotenv/main.py`),
 * leaf 上报绝对 (`/workspace/src/dotenv/main.py`) → orphan 3 / missing 3 全假 → 判官「产物均不存在」→ 首判 fail,
 * 而隐藏测试 reward 1.0。ctl 批 63/80 题 missing>0, 75 个判红里 71 个引用它。
 *
 * 证伪: computeLoopDispatchFacts 里去掉 repoRelativePath ⇒ ★ 那条 orphan/missing 各 3 红。
 */
import { describe, expect, test } from 'bun:test';
import { computeLoopDispatchFacts } from './loop-ledger';

const plan = { nodes: { w: { write_set: ['src/dotenv/main.py', 'tests/test_disabled_env.py', 'README.md'] } } };

describe('computeLoopDispatchFacts 路径归一', () => {
  test('★ leaf 报绝对路径 + artifactRoot ⇒ 对账干净 (orphan/missing 皆空)', () => {
    const exec = {
      results: {
        w: {
          status: 'done' as const,
          artifactRoot: '/workspace',
          filesTouched: ['/workspace/src/dotenv/main.py', '/workspace/tests/test_disabled_env.py', '/workspace/README.md'],
        },
      },
    };
    const f = computeLoopDispatchFacts(plan, exec);
    expect(f.writeSet?.orphan).toEqual([]);
    expect(f.writeSet?.missing).toEqual([]);
    expect(f.filesTouched).toEqual(['src/dotenv/main.py', 'tests/test_disabled_env.py', 'README.md']);
  });
  test('leaf 无 artifactRoot 但给了 root ⇒ 同样归一', () => {
    const exec = { results: { w: { status: 'done' as const, filesTouched: ['/workspace/src/dotenv/main.py', '/workspace/tests/test_disabled_env.py', '/workspace/README.md'] } } };
    const f = computeLoopDispatchFacts(plan, exec, '/workspace');
    expect(f.writeSet?.orphan).toEqual([]);
    expect(f.writeSet?.missing).toEqual([]);
  });
  test('无 root 无 artifactRoot ⇒ 老行为 (不猜根, 绝对路径原样 → 对不上照记)', () => {
    const exec = { results: { w: { status: 'done' as const, filesTouched: ['/workspace/src/dotenv/main.py'] } } };
    const f = computeLoopDispatchFacts(plan, exec);
    expect(f.writeSet?.orphan).toEqual(['/workspace/src/dotenv/main.py']);
    expect(f.writeSet?.missing?.length).toBe(3);
  });
  test('根外绝对路径仍是 orphan (真越界不被归一吞掉)', () => {
    const exec = { results: { w: { status: 'done' as const, artifactRoot: '/workspace', filesTouched: ['/tmp/evil.py', '/workspace/src/dotenv/main.py'] } } };
    const f = computeLoopDispatchFacts(plan, exec);
    expect(f.writeSet?.orphan).toEqual(['/tmp/evil.py']);
    expect(f.writeSet?.missing).toEqual(['tests/test_disabled_env.py', 'README.md']);
  });
});
