/**
 * goal/criterion-survey —— **分类之前的机械勘察** (2026-09-05, 契约
 * `docs/plan/2026-09-05-勘察先于分类-执行契约.md`)。
 *
 * 要修的是**输入缺失**, 不是模型能力: 分类器此前只拿得到 goal 文本 + 语言探测,
 * 读不到 README 写死的输出键名、读不到仓里已经在测这些键的用例。于是它闭着眼写判据 ——
 * 实测样本 (`product_analytics-hard-ab_test_analysis`): 指令 71 字, 仓内 README 第 5-6 行
 * 逐字写着输出键名, run 输出里 README 零出现, 判成 rubric 型 8/8 过、零写入, 隐藏测试 13 挂 12。
 *
 * 本模块**零 LLM**: 三段内容全是确定性读盘 / 读进程输出。
 *  1. README —— 契约最常写在这里 (输出格式 / 键名 / 命令行参数);
 *  2. 既有测试文件清单 —— 判据该优先指向它们, 而不是另写一个自己能过的新文件;
 *  3. goal 里点名的标识符在仓里的位置 —— 让判据锚到真实存在的路径, 不是幻觉路径。
 *
 * IO 全走 {@link CriterionSurveyOpts.run} 这一个注入口 (缺省 `Bun.spawnSync` + 5 秒 timeout),
 * 测试拿它造故障; 读文件走 fs, 不另开第二个注入口 (读盘没有"起不来"这一态)。
 *
 * **每一段独立 try/catch**: 一段炸只丢那一段, 其余照常, 原因原文进 `why`
 * (仓规静默坑 2 —— fail-open 可以吞异常, 不许吞证据)。三段都空 ⇒ `text=''` 且 `why` 缺席:
 * 「什么都没勘察到」与「勘察失败」是两件事 (仓规静默坑 1)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 勘察读数 (进 loop ledger; `chars` = 最终 `text` 的长度, 0 = 三段全空)。 */
export interface CriterionSurveyFacts {
  readme: boolean;
  testFiles: number;
  terms: number;
  /** grep 真正收进 `text` 的**命中行数** (不是命中的词数) —— 0 = 一行没搜到 / 该段炸了。 */
  termHits: number;
  chars: number;
}

export interface CriterionSurvey {
  text: string;
  facts: CriterionSurveyFacts;
  /** 有段失败 / 撞墙钟才在场。缺席 ≠ 成功: 三段全空也缺席 (空不是失败)。 */
  why?: string;
}

export interface CriterionSurveyOpts {
  maxChars?: number;
  readmeLines?: number;
  maxTestFiles?: number;
  maxTerms?: number;
  /** 注入口(测试用);缺省 Bun.spawnSync + 5s timeout。 */
  run?: (argv: string[], cwd: string) => { exitCode: number | null; stdout: string };
}

/** 头一行固定 —— 让模型分得清这是引擎读出来的事实, 不是它自己的复述。 */
export const SURVEY_HEADER = '===== 仓内契约线索 (引擎机械勘察, 不是模型自述) =====';

const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_README_LINES = 60;
const README_MAX_CHARS = 2500;
const DEFAULT_MAX_TEST_FILES = 40;
const DEFAULT_MAX_TERMS = 12;
/** 每次 spawn 的上限; 整体墙钟另有 {@link WALL_CLOCK_MS} 兜 (13 次 spawn × 5 秒会超)。 */
const SPAWN_TIMEOUT_MS = 5_000;
const WALL_CLOCK_MS = 15_000;
const GREP_LINES_PER_TERM = 5;
const GREP_TOTAL_LINES = 60;
const GREP_LINE_CHARS = 200;
/** 目录扫描兜底的深度上限 (不是 git 仓时才走)。 */
const SCAN_MAX_DEPTH = 6;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.omd', 'dist', 'build']);

/**
 * 从 goal 里抽出**仓里搜得到的词**: 反引号内 · CamelCase · 含下划线的 snake_case ·
 * 带点或斜杠的路径 · `--flag` · 引号 (含『』「」) 内 ≥3 字的串。
 *
 * 单字不进 —— 拿一个字母去 grep 整个仓, 出来的全是噪声, 而噪声会挤掉真线索的配额。
 * 中文散句也不进: 它们不是标识符, 且上面每条模式都是 ASCII 面的 (引号内那条例外, 那是显式引用)。
 */
export function extractGoalTerms(goal: string, max: number = DEFAULT_MAX_TERMS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const t = raw.trim();
    if (t.length < 2) return;
    if (!/[A-Za-z0-9]/.test(t)) return; // 纯符号 (`__`) 不是标识符
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  const patterns: RegExp[] = [
    /`([^`\n]+)`/g, // 反引号内
    /\b[A-Za-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g, // CamelCase
    /[A-Za-z0-9]*_[A-Za-z0-9_]*/g, // snake_case (含 __dunder__)
    /[A-Za-z0-9_-]+(?:[/.][A-Za-z0-9_-]+)+/g, // 带点或斜杠的路径
    /--[A-Za-z][A-Za-z0-9-]*/g, // --flag
    /["']([^"'\n]{3,})["']/g, // 引号内 ≥3 字
    /[『「]([^』」\n]{3,})[』」]/g, // 中文书名号 / 引号内 ≥3 字
  ];
  for (const re of patterns) {
    for (const m of goal.matchAll(re)) {
      push(m[1] ?? m[0]);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** 缺省 IO: 每次 spawn 带 5 秒 timeout, 起不来就让异常往上抛 (由段级 catch 记进 why)。 */
function defaultRun(argv: string[], cwd: string): { exitCode: number | null; stdout: string } {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: SPAWN_TIMEOUT_MS });
  return { exitCode: r.exitCode, stdout: r.stdout.toString() };
}

/** README.md (大小写不敏感, 取第一个命中); 前 `lines` 行或 2500 字符, 先到为准。空文件 ⇒ null。 */
function readReadme(root: string, lines: number): string | null {
  const hit = readdirSync(root)
    .sort()
    .find((n) => /^readme\.md$/i.test(n));
  if (!hit) return null;
  const head = readFileSync(join(root, hit), 'utf8').split('\n').slice(0, lines).join('\n');
  const body = head.length > README_MAX_CHARS ? head.slice(0, README_MAX_CHARS) : head;
  return body.trim() === '' ? null : body;
}

/**
 * 是不是一个既有测试文件。目录前缀按契约字面 (`tests/**` / `test/**`);
 * 嵌套更深的测试文件由文件名那几条认出来 (`test_*.py` / `*_test.py` / `*.test.ts` /
 * `*.spec.ts` / `*_test.go`), 两条路合起来覆盖常见形态。
 */
function isTestPath(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  if (p.startsWith('tests/') || p.startsWith('test/')) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  return /^test_.+\.py$/.test(base) || /_test\.py$/.test(base) || /\.test\.ts$/.test(base) || /\.spec\.ts$/.test(base) || /_test\.go$/.test(base);
}

/** 不是 git 仓时的兜底: 目录扫描, 跳过 SKIP_DIRS, 深度 ≤ 6。 */
function scanTestFiles(root: string, max: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > SCAN_MAX_DEPTH || out.length >= max) return;
    // withFileTypes: 目录判定直接来自 readdir 那一次系统调用 —— 不另起 statSync,
    // 也就不需要一个吞掉断链/权限错误的 catch (仓规静默坑 2: 别写留不下证据的 catch)。
    // 代价: 指向目录的软链算文件, 不下钻。勘察是尽力而为的证据面, 这个取舍可以接受。
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= max) return;
      if (SKIP_DIRS.has(ent.name)) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(join(dir, ent.name), childRel, depth + 1);
      else if (isTestPath(childRel)) out.push(childRel);
    }
  };
  walk(root, '', 1);
  return out;
}

/** 既有测试文件清单: 优先 `git ls-files` (它天然排掉 ignore 的东西), 非 git 仓退回目录扫描。 */
function listTestFiles(root: string, run: NonNullable<CriterionSurveyOpts['run']>, max: number): string[] {
  const r = run(['git', 'ls-files'], root);
  if (r.exitCode !== 0) return scanTestFiles(root, max);
  return r.stdout.split('\n').filter((l) => l !== '' && isTestPath(l)).slice(0, max);
}

/** 每个词 grep 前 5 行, 总计 ≤ 60 行, 每行截 200 字符。撞墙钟就停, 并让调用方记进 why。 */
function grepTerms(
  terms: string[],
  root: string,
  run: NonNullable<CriterionSurveyOpts['run']>,
  deadline: number,
): { lines: string[]; deadlineHit: boolean } {
  const lines: string[] = [];
  for (const t of terms) {
    if (lines.length >= GREP_TOTAL_LINES) break;
    if (Date.now() > deadline) return { lines, deadlineHit: true };
    const r = run(
      ['grep', '-rn', '-F', '-m', '3', '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=.omd', '--', t, '.'],
      root,
    );
    // 退出码 1 = 没命中, 2 = grep 自己出错 —— 两者都当这个词没线索, 不是整段失败。
    if (r.exitCode !== 0) continue;
    for (const line of r.stdout.split('\n').filter((l) => l !== '').slice(0, GREP_LINES_PER_TERM)) {
      if (lines.length >= GREP_TOTAL_LINES) break;
      lines.push(line.length > GREP_LINE_CHARS ? `${line.slice(0, GREP_LINE_CHARS)}…` : line);
    }
  }
  return { lines, deadlineHit: false };
}

/**
 * 跑一次勘察。纯函数 + 受控 IO: 同一个仓同一个 goal 出同一份 `text`。
 *
 * falsify (本模块必须能真红): 去掉 README 那一段 ⇒ `criterion-survey.test.ts` 的 INV-2 红;
 * 去掉标识符段的 catch (让异常上抛) ⇒ INV-4 红 —— 那时一段炸会把 README / 测试清单一起丢。
 */
export function surveyForCriterion(goal: string, root: string, opts: CriterionSurveyOpts = {}): CriterionSurvey {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const readmeLines = opts.readmeLines ?? DEFAULT_README_LINES;
  const maxTestFiles = opts.maxTestFiles ?? DEFAULT_MAX_TEST_FILES;
  const maxTerms = opts.maxTerms ?? DEFAULT_MAX_TERMS;
  const run = opts.run ?? defaultRun;
  const deadline = Date.now() + WALL_CLOCK_MS;

  const facts: CriterionSurveyFacts = { readme: false, testFiles: 0, terms: 0, termHits: 0, chars: 0 };
  const sections: string[] = [];
  const whys: string[] = [];

  // ① README —— 输出格式 / 键名 / 命令行参数的契约最常写在这儿。
  try {
    const body = readReadme(root, readmeLines);
    if (body) {
      facts.readme = true;
      sections.push(`--- README (前 ${readmeLines} 行 / ${README_MAX_CHARS} 字符, 先到为准) ---\n${body}`);
    }
  } catch (e) {
    whys.push(`README 段失败: ${String(e)}`);
  }

  // ② 既有测试文件 —— 判据该先在这里找锚, 而不是另写一个自己能过的新文件。
  try {
    const files = listTestFiles(root, run, maxTestFiles);
    if (files.length > 0) {
      facts.testFiles = files.length;
      sections.push(`--- 仓内既有测试文件 (${files.length} 条) ---\n${files.join('\n')}`);
    }
  } catch (e) {
    whys.push(`测试清单段失败: ${String(e)}`);
  }

  // ③ 标识符命中 —— 让判据锚到真实存在的路径 (幻觉路径是判据轴最贵的一种红)。
  try {
    const terms = extractGoalTerms(goal, maxTerms);
    facts.terms = terms.length;
    const { lines, deadlineHit } = grepTerms(terms, root, run, deadline);
    if (deadlineHit) whys.push(`标识符段撞墙钟 (${WALL_CLOCK_MS} ms), 只搜完一部分词`);
    if (lines.length > 0) {
      facts.termHits = lines.length;
      sections.push(`--- 目标标识符在仓里的位置 (${terms.length} 个词 / ${lines.length} 行命中) ---\n${lines.join('\n')}`);
    }
  } catch (e) {
    whys.push(`标识符段失败: ${String(e)}`);
  }

  const why = whys.length > 0 ? whys.join('; ') : undefined;
  // 三段全空 ⇒ 空串。给 prompt 一个只有头行的空壳等于凭空多一段噪声, 而 D-2 要的是"缺席即字节不变"。
  if (sections.length === 0) return { text: '', facts, ...(why ? { why } : {}) };

  const body = sections.join('\n\n');
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n… (超过勘察上限 ${maxChars} 字符, 已截断)` : body;
  const text = `${SURVEY_HEADER}\n\n${clipped}`;
  facts.chars = text.length;
  return { text, facts, ...(why ? { why } : {}) };
}
