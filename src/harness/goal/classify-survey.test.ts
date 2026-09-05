/**
 * src/harness/goal/classify-survey.test —— 勘察先于分类, 切片 2 的契约测试
 * (契约 `docs/plan/2026-09-05-勘察先于分类-执行契约.md` §不变量 INV-6 / INV-7)。
 *
 * 要钉的两件事:
 *  · **缺席即字节不变** —— 勘察没跑 / 跑出空手时, 分类 prompt 与加这一段之前**逐字相同**。
 *    这是加尺子不许动老读数的底线: 不这样, 勘察臂与对照臂的差就分不清是勘察带来的还是文案漂移。
 *  · **在场即透传** —— 勘察文本原样进 prompt, 并带三句教学 (判据往仓里既有的契约上指)。
 *
 * **反向自检**:
 *  · 去掉 `classifyPrompt` 的 survey 追加段 ⇒ INV-6 「非空 survey」那条红 (契约 §证伪 第 1 条);
 *  · `classifyGoal` 不把 `deps.survey` 传进 probe ⇒ INV-7 红;
 *  · 把「缺席」那支写成"追加一个空壳头行" ⇒ INV-6 字节相同那条红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGoal, classifyPrompt } from './classify-acceptance';
import { SURVEY_HEADER } from './criterion-survey';
import type { GenerateFn } from '../dag/types';

const SURVEY = `${SURVEY_HEADER}\n\n--- README (前 60 行 / 2500 字符, 先到为准) ---\n输出必须含 conversion_lift。`;

function jsGoalRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-classify-survey-'));
  writeFileSync(join(root, 'package.json'), '{}');
  return root;
}

describe('INV-6 —— 勘察缺席 ⇒ prompt 字节相同; 在场 ⇒ 原文 + 三句教学', () => {
  test('★ 缺席与空串两条路都与"没有这个参数"逐字相同', () => {
    const repoRoot = jsGoalRoot();
    const base = classifyPrompt('随便一个目标', { repoRoot });

    // 证伪: 把「缺席」那支改成恒追加一段 (哪怕只是头行) ⇒ 这两行红。
    expect(classifyPrompt('随便一个目标', { repoRoot, survey: '' })).toBe(base);
    expect(classifyPrompt('随便一个目标', { repoRoot, survey: '   ' })).toBe(base);
  });

  test('★ 非空 survey ⇒ 原文进 prompt, 三句教学的关键短语都在 (证伪: 去掉追加段 ⇒ 本用例红)', () => {
    const repoRoot = jsGoalRoot();
    const p = classifyPrompt('让输出带上 conversion_lift', { repoRoot, survey: SURVEY });

    expect(p).toContain(SURVEY);
    // 教学一: 有既有测试就往它上面指, 别另写一个自己能过的新文件。
    expect(p).toContain('优先指向既有测试');
    // 教学二: README / docs 写明的键名是判据必须核的契约。
    expect(p).toContain('README');
    // 教学三: 都没覆盖时才新写。
    expect(p).toContain('才新写测试文件');
    // 勘察段排在既有的仓语言证据段**之后** —— 证据面按"从环境到契约"的顺序读。
    expect(p.indexOf('仓语言证据') < p.indexOf(SURVEY_HEADER) || p.indexOf('语言证据') < p.indexOf(SURVEY_HEADER)).toBe(true);
  });
});

describe('INV-7 —— classifyGoal 透传 survey 到那一发的 messages', () => {
  const ok = '{"tier":"simple","acceptance_kind":"executable","command":"bun test"}';

  test('★ 给了 survey ⇒ 分类那一发看得见 SURVEY_HEADER (证伪: 不把 deps.survey 传进 probe ⇒ 本行红)', async () => {
    const seen: string[] = [];
    const generate: GenerateFn = async (req) => {
      seen.push(String(req.messages[0]?.content ?? ''));
      return { text: ok, usage: { in: 1, out: 1 } };
    };

    await classifyGoal('让输出带上 conversion_lift', { generate, model: 'x:y', survey: SURVEY });

    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toContain(SURVEY_HEADER);
  });

  test('对照: 不给 survey ⇒ 同一发里一个字都不多 (缺席 = 老行为)', async () => {
    const seen: string[] = [];
    const generate: GenerateFn = async (req) => {
      seen.push(String(req.messages[0]?.content ?? ''));
      return { text: ok, usage: { in: 1, out: 1 } };
    };

    await classifyGoal('让输出带上 conversion_lift', { generate, model: 'x:y' });

    expect(seen[0]).not.toContain(SURVEY_HEADER);
    expect(seen[0]).not.toContain('优先指向既有测试');
  });
});
