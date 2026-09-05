/**
 * D-3 盘上改动证据 (契约 `docs/plan/2026-09-05-假success三闸-执行契约.md` 切片 3) —— INV-5。
 *
 * 用**真临时 git 仓**打, 不用替身: 这个模块存在的全部理由就是"引擎自己去问 git",
 * 拿一个假的 spawn 去测它等于测我自己写的那份假答案。
 *
 * ## 证伪 (每条真跑过一次)
 * · 把 `.omd/` 过滤删掉 ⇒ 「引擎留痕不进卷面」那条红 (卷面会拿 `.omd/x` 冒充产物)。
 * · 把 `!status.ok` 那一路改成返回零改动而不带 why ⇒ 「非 git 目录」那条红 (取不到被念成零改动)。
 * · 把 `truncated` 那一段删掉 ⇒ 「超上限」那条红 (判官看不全却不知道自己没看全)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDiffEvidence } from './diff-evidence';

/** 造一个有一次提交的临时 git 仓 (提交里含 `a.ts`)。 */
function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-diff-evi-'));
  const run = (args: string[]): void => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} 失败: ${new TextDecoder().decode(r.stderr)}`);
  };
  run(['init', '-q']);
  run(['config', 'user.email', 't@t']);
  run(['config', 'user.name', 't']);
  run(['commit', '--allow-empty', '-q', '-m', 'base']);
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  run(['add', 'a.ts']);
  run(['commit', '-q', '-m', 'a']);
  return dir;
}

describe('renderDiffEvidence — INV-5', () => {
  test('★ 有改动 ⇒ text 含 diff --git 与文件名, empty=false', () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    const e = renderDiffEvidence(dir);
    expect(e.empty).toBe(false);
    expect(e.files).toContain('a.ts');
    expect(e.text).toContain('diff --git');
    expect(e.text).toContain('a.ts');
    expect(e.truncated).toBe(false);
  });

  test('新建的未跟踪文件也算改动 (git diff 看不见它, 而它正是"新写了产物"最常见的形状)', () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, 'b.md'), '# 新产物\n正文\n');
    const e = renderDiffEvidence(dir);
    expect(e.empty).toBe(false);
    expect(e.files).toContain('b.md');
    expect(e.text).toContain('新文件 b.md');
    expect(e.text).toContain('# 新产物');
  });

  test('干净仓 ⇒ empty=true, text 空, why 缺席 (这是"查过了, 真没有")', () => {
    const e = renderDiffEvidence(tmpRepo());
    expect(e.empty).toBe(true);
    expect(e.text).toBe('');
    expect(e.files).toEqual([]);
    expect(e.why).toBeUndefined();
  });

  test('非 git 目录 ⇒ empty=true 但 why 非空 —— 「取不到」靠这一列与「零改动」分开 (仓规坑 ①)', () => {
    const e = renderDiffEvidence(mkdtempSync(join(tmpdir(), 'omd-diff-nogit-')));
    expect(e.empty).toBe(true);
    expect(e.text).toBe('');
    expect(e.why).toBeTruthy();
  });

  test('`.omd/` 下的改动不进卷面 (引擎自己的留痕库不是交付物)', () => {
    const dir = tmpRepo();
    mkdirSync(join(dir, '.omd', 'continuity'), { recursive: true });
    writeFileSync(join(dir, '.omd', 'continuity', 'x.json'), '{"a":1}');
    const e = renderDiffEvidence(dir);
    expect(e.files).toEqual([]);
    expect(e.empty).toBe(true);
  });

  test('超过 maxChars ⇒ truncated=true 且总长 ≤ maxChars + 200 (判官得知道自己没看全)', () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(50_000));
    const e = renderDiffEvidence(dir, { maxChars: 2_000, maxPerFile: 50_000 });
    expect(e.truncated).toBe(true);
    expect(e.text.length).toBeLessThanOrEqual(2_000 + 200);
    expect(e.text).toContain('证据截断');
  });
});
