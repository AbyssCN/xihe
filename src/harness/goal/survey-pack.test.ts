/**
 * src/harness/goal/survey-pack.test —— 墙钟与读次数契约切片 1 的不变量
 * (契约 `docs/plan/2026-09-06-墙钟与读次数-执行契约.md` W1 / INV-1)。
 *
 * 为什么有这个模块: 80 题读数里 conductor 61% 的 bash 步是只读勘察 (grep/ls/cat/sed/find/git),
 * 而这些事实引擎自己一次就能算完。算一次、两层共用, 砍的是**轮数**, 不是 token。
 *
 * 测试走真文件系统 (`mkdtemp` + `git init`), 不 mock fs —— 勘察量的就是真盘。
 *
 * **反向自检** (每条都要能真红):
 *  · 仓树段不下钻第二层 ⇒ 「二层目录进 text」红;
 *  · git 段不跑 `git log` ⇒ 「commit sha 进 text」红;
 *  · 去掉某段的 try/catch (让异常上抛) ⇒ 「一段炸只丢那一段」红;
 *  · 去掉总量截断 ⇒ 「≤ maxChars + 200」红;
 *  · 段名不记进 facts.sections ⇒ 「六段名」红。
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SURVEY_PACK_HEADER, buildSurveyPack } from './survey-pack';

/** 真仓 (不是 mock): git init + 落文件 + 提交, 让 `git ls-files` / `git log` 有真输出。 */
function gitRepo(files: Record<string, string>): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'omd-pack-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  for (const [f, c] of Object.entries(files)) {
    const abs = join(dir, f);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, c);
  }
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init pack'], { cwd: dir });
  const sha = execFileSync('git', ['log', '--oneline', '-1'], { cwd: dir }).toString().split(' ')[0]!;
  return { dir, sha };
}

/** 真进程注入口 (与 criterion-survey 同签名) —— 除非某条用例要故意造故障。 */
function realRun(argv: string[], cwd: string): { exitCode: number | null; stdout: string } {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: r.exitCode, stdout: r.stdout.toString() };
}

const REPO_FILES = {
  'README.md': '# pack demo\n\n输出必须含 `conversion_lift` 键。\n',
  'tests/test_x.py': 'def test_x():\n    assert 1\n',
  'src/app/report.py': 'conversion_lift = 1\n',
};

describe('INV-1 —— buildSurveyPack: 六段齐全, 总量有界', () => {
  test('★ header + README 行 + tests/ 路径 + 二层目录 + git log 那一行都在 text 里', () => {
    const { dir, sha } = gitRepo(REPO_FILES);
    const pack = buildSurveyPack('修 `conversion_lift` 的计算, 见 src/app/report.py', dir, { run: realRun });

    expect(pack.text.startsWith(SURVEY_PACK_HEADER)).toBe(true);
    // 证伪: README 段不读 ⇒ 本行红。
    expect(pack.text).toContain('conversion_lift');
    // 证伪: 既有测试清单段不进 ⇒ 本行红。
    expect(pack.text).toContain('tests/test_x.py');
    // 证伪: 仓树只列一层 ⇒ 本行红 (二层目录看不见)。
    expect(pack.text).toContain('src/app');
    // 证伪: git 段不跑 `git log` ⇒ 本行红。
    expect(pack.text).toContain(sha);
    // 证伪: env 段不进 ⇒ 本行红 (renderEnvFacts 的固定首词)。
    expect(pack.text).toContain('仓环境探测');
  });

  test('★ facts.sections 六段名齐 (缺一段就少一个名, 读侧据此分辨"没勘察到"与"勘察失败")', () => {
    const { dir } = gitRepo(REPO_FILES);
    const pack = buildSurveyPack('修 `conversion_lift` 的计算, 见 src/app/report.py', dir, { run: realRun });
    for (const name of ['env', 'tree', 'git', 'readme', 'tests', 'terms']) {
      expect(pack.facts.sections).toContain(name);
    }
    expect(pack.facts.sections.length).toBe(6);
    expect(pack.facts.chars).toBe(pack.text.length);
    expect(pack.why).toBeUndefined(); // 全段成功 ⇒ why 缺席 (缺席 ≠ 空段)
  });

  test('★ 总量封顶: 巨大 README 也不撑破 maxChars + 200 (证伪: 去掉截断 ⇒ 本行红)', () => {
    const { dir } = gitRepo({ ...REPO_FILES, 'README.md': `# big\n${'x'.repeat(200)}\n`.repeat(400) });
    const pack = buildSurveyPack('修 `conversion_lift`', dir, { run: realRun, maxChars: 1500 });
    expect(pack.text.length).toBeLessThanOrEqual(1500 + 200);
    expect(pack.facts.chars).toBe(pack.text.length);
  });
});

describe('INV-1 fail-open —— 一段炸只丢那一段, 原因原文进 why', () => {
  test('★ git 命令抛错 ⇒ git 段缺席, 其余五段照常, why 带原文', () => {
    const { dir } = gitRepo(REPO_FILES);
    const boom = (argv: string[], cwd: string): { exitCode: number | null; stdout: string } => {
      if (argv[0] === 'git' && (argv[1] === 'status' || argv[1] === 'log')) throw new Error('git 段故意炸: EACCES');
      return realRun(argv, cwd);
    };
    const pack = buildSurveyPack('修 `conversion_lift`, 见 src/app/report.py', dir, { run: boom });

    expect(pack.facts.sections).not.toContain('git');
    expect(pack.facts.sections).toContain('readme');
    expect(pack.facts.sections).toContain('tree');
    expect(pack.why ?? '').toContain('git 段故意炸: EACCES');
  });

  test('不是 git 仓 ⇒ git 段缺席但 why 也缺席 ("没有"不是"失败", §静默坑 1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-pack-nogit-'));
    writeFileSync(join(dir, 'README.md'), '# nogit\n');
    const pack = buildSurveyPack('随便什么 goal', dir, { run: realRun });
    expect(pack.facts.sections).not.toContain('git');
    expect(pack.why).toBeUndefined();
    expect(pack.text).toContain('nogit');
  });
});
