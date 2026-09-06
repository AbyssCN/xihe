/**
 * repoRelativePath —— 根内绝对路径转相对, 其余原样 (2026-09-06)。
 * 证伪: 把 repo-path.ts 里「根内绝对 → relative」那支改成 return p ⇒ ★ 那条红。
 */
import { describe, expect, test } from 'bun:test';
import { repoRelativePath } from './repo-path';

describe('repoRelativePath', () => {
  test('★ 根内绝对路径转相对 (bench 实测形态: leaf 报 /workspace/src/x.py, 声明是 src/x.py)', () => {
    expect(repoRelativePath('/workspace', '/workspace/src/dotenv/main.py')).toBe('src/dotenv/main.py');
    expect(repoRelativePath('/workspace/', '/workspace/README.md')).toBe('README.md');
  });
  test('相对路径原样, 只去开头 ./', () => {
    expect(repoRelativePath('/workspace', 'src/a.py')).toBe('src/a.py');
    expect(repoRelativePath('/workspace', './src/a.py')).toBe('src/a.py');
  });
  test('根外绝对路径原样 (越界是另一道闸的事, 不吞信息)', () => {
    expect(repoRelativePath('/workspace', '/tmp/x.py')).toBe('/tmp/x.py');
    expect(repoRelativePath('/workspace', '/workspace2/x.py')).toBe('/workspace2/x.py');
  });
  test('root 缺席 ⇒ 绝对路径原样; 根本身 ⇒ 原样', () => {
    expect(repoRelativePath(undefined, '/workspace/x.py')).toBe('/workspace/x.py');
    expect(repoRelativePath('/workspace', '/workspace')).toBe('/workspace');
    expect(repoRelativePath('/workspace', '')).toBe('');
  });
});
