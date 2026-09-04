/**
 * src/harness/goal/criterion-direction.test —— #205 三刀的闸 (2026-09-04)。
 *
 * 来历 (code80-p5 实测, runs/2026-09-04-recheck-distribution-result.md):
 * 我们的判据文件与 bench 隐藏测试文件 **68 题里 67 题零交集**, 而「绿的那边有 reward 0.0」
 * 就是从这条缝漏出去的。三刀各堵一段:
 *  ① 探针分清「红是因为断言不成立」和「红是因为文件不存在」(`unproven-missing`);
 *  ② 1-A 判据文件写好后放回**改动前的代码**里跑 —— 绿 = 它量的不是本次目标 (`probeCriterionDirection`);
 *  ③ 数「执行体改了几个仓库自带的测试」—— 唯一不来自执行体的信号 (`countExistingTestsTouched`)。
 *
 * 三刀本版**全部只记账不拦** (见各自实现的 fail-open 注)。这些用例钉的是「读数分得开」,
 * 不是「终态被翻」—— 升成闸是下一批用数据定的事。
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCriterionDirection, probeDiscrimination } from './acceptance-gate';
import { countExistingTestsTouched } from './loop-ledger';

function gitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-dirprobe-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  for (const [f, c] of Object.entries(files)) {
    const abs = join(dir, f);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, c);
  }
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

describe('① 探针: 红是因为文件不存在 ⇒ unproven-missing, 不是 ok', () => {
  test('★ 判据点名 HEAD 里不存在的文件 → unproven-missing (旧实现记 ok, 那正是漏洞)', async () => {
    const repo = gitRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const v = await probeDiscrimination(
      'bun test tests/brand_new.test.ts',
      { path: 'src/wrong.ts', content: 'export const a = 2;\n' },
      0,
      { repoRoot: repo, runIn: async () => ({ exitCode: 1 }) }, // 非 0: 旧实现到此就判 ok
    );
    // 证伪: 去掉 probeDiscrimination 里的 missingPathArgs 分支 → status 变 'ok', 这条红。
    expect(v.status).toBe('unproven-missing');
    if (v.status === 'unproven-missing') expect(v.missing).toContain('tests/brand_new.test.ts');
  });

  test('判别力: 判据点名的文件在 HEAD 里**存在**时, 非 0 仍照旧判 ok (不误伤既有判据)', async () => {
    const repo = gitRepo({ 'tests/existing.test.ts': 'test("x", () => {});\n' });
    const v = await probeDiscrimination(
      'bun test tests/existing.test.ts',
      { path: 'src/wrong.ts', content: 'bad\n' },
      0,
      { repoRoot: repo, runIn: async () => ({ exitCode: 1 }) },
    );
    expect(v.status).toBe('ok');
  });
});

describe('② 方向性探针: 判据放回改动前的代码里跑', () => {
  test('★ 改动前就绿 → green-before (它量的不是本次目标 —— conductor 写了个自己能过的测试)', async () => {
    const repo = gitRepo({ 'src/a.ts': 'export const a = 1;\n' });
    mkdirSync(join(repo, 'tests'), { recursive: true });
    writeFileSync(join(repo, 'tests', 'new.test.ts'), 'ok\n'); // 1-A 刚写好的判据文件
    const v = await probeCriterionDirection('bun test tests/new.test.ts', ['tests/new.test.ts'], repo, 0, {
      runIn: async () => ({ exitCode: 0 }), // 改动前就通过
    });
    expect(v.status).toBe('green-before');
    expect(v.why).toContain('量的不是本次目标');
  });

  test('★ 改动前红 → red-before (判据确实在量本次改动)', async () => {
    const repo = gitRepo({ 'src/a.ts': 'export const a = 1;\n' });
    mkdirSync(join(repo, 'tests'), { recursive: true });
    writeFileSync(join(repo, 'tests', 'new.test.ts'), 'ok\n');
    const v = await probeCriterionDirection('bun test tests/new.test.ts', ['tests/new.test.ts'], repo, 0, {
      runIn: async () => ({ exitCode: 1 }),
    });
    expect(v.status).toBe('red-before');
  });

  test('1-A 没写出文件 → inconclusive (与 green/red 分开: 什么都没量到 ≠ 量到了)', async () => {
    const repo = gitRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const v = await probeCriterionDirection('bun test tests/never.test.ts', ['tests/never.test.ts'], repo, 0, {
      runIn: async () => ({ exitCode: 0 }),
    });
    // 证伪: 去掉真仓 existsSync 那一跳 → 会拿一个不存在的文件去跑并判 green-before, 这条红。
    expect(v.status).toBe('inconclusive');
    expect(v.why).toContain('1-A 没写出来');
  });

  test('没有 criterionFiles → inconclusive (这道探针不适用, 不是"通过")', async () => {
    const v = await probeCriterionDirection('bun test x', [], '/tmp', 0, { runIn: async () => ({ exitCode: 0 }) });
    expect(v.status).toBe('inconclusive');
  });
});

describe('③ 环外信号: 执行体改了几个仓库自带的测试', () => {
  const head = (present: string[]) => ({ existsInHead: (p: string) => present.includes(p) });

  test('★ 改了既有测试 → 计数; 新写的判据文件不算; 非测试文件不算', () => {
    const n = countExistingTestsTouched(
      ['src/impl.ts', 'tests/existing.test.ts', 'tests/frozen.test.ts', 'tests/brand_new.test.ts'],
      ['tests/frozen.test.ts'], // 1-A 判据文件 —— 写它是被要求的
      head(['tests/existing.test.ts', 'tests/frozen.test.ts']),
    );
    // 只有 existing 命中: impl 不像测试 · frozen 是判据文件 · brand_new 在 HEAD 里不存在。
    // 证伪: 去掉 frozen 那一层过滤 → 2, 这条红。
    expect(n).toBe(1);
  });

  test('段级匹配: src/latest.ts / src/contest/x.ts 不算测试 (裸 includes("test") 会误报)', () => {
    const n = countExistingTestsTouched(
      ['src/latest.ts', 'src/contest/x.ts', 'src/protester.ts'],
      [],
      head(['src/latest.ts', 'src/contest/x.ts', 'src/protester.ts']),
    );
    expect(n).toBe(0);
  });

  test('git 说不出话 → null, **不是 0** (算不出来 ≠ 一条没改)', () => {
    const n = countExistingTestsTouched(['tests/a.test.ts'], [], { existsInHead: () => null });
    // 证伪: 把 `return null` 改成 `continue` → 变 0, 这条红 —— 而 0 会被读成「干净」。
    expect(n).toBeNull();
  });
});
