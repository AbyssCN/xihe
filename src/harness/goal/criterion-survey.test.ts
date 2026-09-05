/**
 * src/harness/goal/criterion-survey.test —— 勘察先于分类, 切片 1 的契约测试
 * (契约 `docs/plan/2026-09-05-勘察先于分类-执行契约.md` §不变量 INV-1..INV-5)。
 *
 * 为什么有这个模块: 分类器此前只看得见 goal 文本 + 语言探测, 读不到 README / 既有测试 /
 * 被点名的标识符 —— 判据写错方向的根因是**输入缺失**, 不是模型能力。本模块零 LLM,
 * 机械勘察出仓内契约线索, 交给 `classifyPrompt` 当证据。
 *
 * 测试全走真文件系统 (`mkdtemp` + `git init`), 不 mock fs —— 勘察的价值恰恰在于它读的是真盘,
 * 拿假盘测等于测 mock 自己。
 *
 * **反向自检** (每条都要能真红):
 *  · `surveyForCriterion` 不读 README ⇒ INV-2 红 (契约 §证伪 第 2 条);
 *  · `extractGoalTerms` 去掉反引号 / 路径 / flag 任一支 ⇒ INV-1 红;
 *  · 去掉标识符段的 catch (让异常上抛) ⇒ INV-4 红 (一段失败会把其余段一起丢);
 *  · 去掉 `maxChars` 截断 ⇒ INV-5 红。
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SURVEY_HEADER, extractGoalTerms, surveyForCriterion } from './criterion-survey';

/** 真仓 (不是 mock): git init + 落文件 + 提交, 让 `git ls-files` 有真输出。 */
function gitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-survey-'));
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

/** INV-4 用: 非 grep 的命令仍走真进程, 保证「其余段照常」量的是真勘察而不是又一个 mock。 */
function realRun(argv: string[], cwd: string): { exitCode: number | null; stdout: string } {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: r.exitCode, stdout: r.stdout.toString() };
}

describe('INV-1 —— 目标标识符抽取: 抽得出仓里搜得到的词, 不抽中文散句', () => {
  test('★ 反引号 / snake_case / 路径 / --flag 全抽到, 单字与纯中文词不进', () => {
    const terms = extractGoalTerms('把 `Local` 对象的 __del__ 处理稳一点, 见 app/report.py 与 --out');

    // 证伪: 去掉反引号那一支 → `Local` 不在, 本行红。
    expect(terms).toContain('Local');
    // 证伪: 去掉 snake_case 那一支 → `__del__` 不在, 本行红。
    expect(terms).toContain('__del__');
    // 证伪: 去掉路径那一支 → `app/report.py` 不在, 本行红。
    expect(terms).toContain('app/report.py');
    // 证伪: 去掉 --flag 那一支 → `--out` 不在, 本行红。
    expect(terms).toContain('--out');
    // 中文散句不是标识符 —— 拿它去 grep 只会刷屏。
    expect(terms.some((t) => /[一-鿿]/.test(t))).toBe(false);
    // 单字不进 (`x` 这种词 grep 出来全是噪声)。
    expect(terms.every((t) => t.length >= 2)).toBe(true);
  });

  test('去重 + 上限生效', () => {
    const terms = extractGoalTerms('`foo_bar` 又一次 foo_bar, 还有 foo_bar');
    expect(terms.filter((t) => t === 'foo_bar').length).toBe(1);

    const many = extractGoalTerms('a_1 b_2 c_3 d_4 e_5 f_6 g_7 h_8 i_9 j_10 k_11 l_12 m_13 n_14', 12);
    expect(many.length).toBe(12);
  });
});

describe('INV-2 —— 真仓: README + 既有测试清单 + 标识符命中都进 text', () => {
  test('★ 三段齐全 (证伪: 不读 README ⇒ 本用例红)', () => {
    const repo = gitRepo({
      'README.md': '# ab test\n\n输出必须含 `conversion_lift` 与 winner 两个键。\n',
      'tests/test_x.py': 'def test_x():\n    assert 1\n',
    });

    const s = surveyForCriterion('让输出带上 conversion_lift', repo);

    expect(s.text).toContain(SURVEY_HEADER);
    // README 那一行原文进 text —— 这是 D-1 第 1 段。
    expect(s.text).toContain('输出必须含 `conversion_lift` 与 winner 两个键。');
    // 既有测试清单 —— D-1 第 2 段 (git ls-files 认得出 tests/**)。
    expect(s.text).toContain('tests/test_x.py');
    // 标识符 grep 命中行 —— D-1 第 3 段。
    expect(s.text).toContain('conversion_lift');

    expect(s.facts.readme).toBe(true);
    expect(s.facts.testFiles).toBe(1);
    expect(s.facts.termHits).toBeGreaterThanOrEqual(1);
    expect(s.facts.chars).toBe(s.text.length);
    expect(s.why).toBeUndefined();
  });
});

describe('INV-3 —— 空目录: 空不是失败', () => {
  test('★ 三段全空 ⇒ text 为空串, facts 全 0/false, why 缺席', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-survey-empty-'));

    const s = surveyForCriterion('随便一个没有标识符的中文目标', dir);

    expect(s.text).toBe('');
    expect(s.facts).toEqual({ readme: false, testFiles: 0, terms: 0, termHits: 0, chars: 0 });
    // 「什么都没勘察到」与「勘察失败」是两件事 (仓规静默坑 1): 空不许写 why。
    expect(s.why).toBeUndefined();
  });
});

describe('INV-4 —— 一段炸只丢那一段, 原文进 why', () => {
  test('★ 注入的 run 在 grep 上抛 ⇒ 标识符段缺席, README/测试段照常 (证伪: 去掉标识符段的 catch ⇒ 本用例红)', () => {
    const repo = gitRepo({
      'README.md': '# 契约\n\n键名叫 conversion_lift。\n',
      'tests/test_x.py': 'def test_x():\n    assert 1\n',
    });

    const s = surveyForCriterion('让输出带上 conversion_lift', repo, {
      run: (argv, cwd) => {
        if (argv[0] === 'grep') throw new Error('注入故障: grep 起不来');
        return realRun(argv, cwd);
      },
    });

    // 其余两段照常。
    expect(s.text).toContain('键名叫 conversion_lift。');
    expect(s.text).toContain('tests/test_x.py');
    expect(s.facts.readme).toBe(true);
    expect(s.facts.testFiles).toBe(1);
    // 炸掉的那一段: 零命中 + 原文进 why (仓规静默坑 2: fail-open 可以吞异常, 不许吞证据)。
    expect(s.facts.termHits).toBe(0);
    expect(s.why ?? '').toContain('注入故障: grep 起不来');
  });
});

describe('INV-5 —— 总量封顶', () => {
  test('★ 巨大 README ⇒ text 不超过 maxChars + 头行 + 100 (证伪: 去掉截断 ⇒ 本行红)', () => {
    const repo = gitRepo({
      'README.md': '键名 conversion_lift 反复出现。\n'.repeat(2000),
      'tests/test_x.py': 'def test_x():\n    assert 1\n',
    });

    const s = surveyForCriterion('让输出带上 conversion_lift', repo, { maxChars: 800 });

    expect(s.text.length).toBeLessThanOrEqual(800 + SURVEY_HEADER.length + 100);
    expect(s.facts.chars).toBe(s.text.length);
  });
});
