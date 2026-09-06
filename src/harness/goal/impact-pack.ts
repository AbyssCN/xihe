/**
 * goal/impact-pack —— **要改的那几个符号长什么样** (2026-09-06, 契约
 * `docs/plan/2026-09-06-影响包-执行契约.md` D-1)。
 *
 * 治的读数: M3 vs deepseek 同镜像按类别 feature 0.34 vs 0.64 · bug_fix 0.40 vs 0.57, 而 testing
 * 那一类 M3 反超 (0.92 vs 0.50) —— 弱的不是理解与写测试, 是**实装新行为**。同一批读数里
 * conductor 读仓的目标 57% 是源码文件, 而勘察包六段 (README / 测试清单 / 标识符命中 / 仓树 /
 * git / 环境) 一段都不是源码本体: 它只给「路径 + 输出头」, 不给函数体整段。
 *
 * 本模块**零 LLM**, 四样全是确定性 grep + 读盘:
 *  1. 词 —— {@link extractGoalTerms} (criterion-survey 单源) ∪ 勘察 grep 命中里那些**定义形状**行的名字;
 *  2. 定义 —— 每个词的定义行, 每处抽**整个定义块** (python 按缩进 / ts·js 按大括号配平, 封顶 120 行);
 *  3. 调用者 —— `<词>(` 的命中行 (排掉定义自己那一行), 每处 1 行 + 路径:行号;
 *  4. import —— 定义文件头 30 行内的 import/from 行, 让 worker 知道依赖在哪。
 *
 * **每段独立 try/catch**: 一段炸只丢那一段, 原因原文进 `why` (§静默坑 2 —— fail-open 可以吞异常,
 * 不许吞证据)。抽不到任何定义 ⇒ `text=''` 且 `why` 缺席: 「没有」不是「失败」(§静默坑 1)。
 *
 * falsify (本模块必须能真红, 见 `impact-pack.test.ts`): 缩进收尾写错 ⇒ INV-1「含体内最后一行」红;
 * 大括号不配平 ⇒ INV-2「末行是配平的 }」红; 空包仍渲染头行 ⇒ INV-3「text === ''」红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger';
import { type CriterionSurveyOpts, extractGoalTerms } from './criterion-survey';

/** 影响包读数 (进 loop ledger)。`defs`/`callers` = 真进了 `text` 的处数, 不是 grep 的总命中。 */
export interface ImpactPackFacts {
  terms: number;
  defs: number;
  callers: number;
  chars: number;
}

export interface ImpactPack {
  text: string;
  facts: ImpactPackFacts;
  /** 有段失败或撞墙钟才在场。缺席 ≠ 抽到了: 一个定义都没找到也缺席 (空不是失败)。 */
  why?: string;
}

/** 与 {@link CriterionSurveyOpts.run} 同一个签名 —— 勘察的进程注入口全仓只此一种形状。 */
export type ImpactRun = NonNullable<CriterionSurveyOpts['run']>;

export interface ImpactPackOpts {
  maxChars?: number;
  maxTerms?: number;
  maxDefsPerTerm?: number;
  maxCallers?: number;
  run?: ImpactRun;
}

/** 头一行固定 —— 与勘察包同一条纪律: 这些是引擎读出来的源码, 别再花一步重读。 */
export const IMPACT_PACK_HEADER = '===== 影响包 (goal 标识符的定义 / 调用者 / import, 引擎机械抽取, 已经读过) =====';

const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_MAX_TERMS = 12;
const DEFAULT_MAX_DEFS_PER_TERM = 3;
const DEFAULT_MAX_CALLERS = 8;
/** 定义块封顶行数 (契约 D-1)。超了截断并留标记, 不静默截半截。 */
const DEF_BLOCK_MAX_LINES = 120;
const TRUNCATED = '… (截断)';
/**
 * 每次 spawn 的上限 3 秒 + 总墙钟 7 秒 —— 两个数加起来兜住 INV-6 的「总墙钟 ≤ 10 s」:
 * 最后一次 spawn 最坏在第 7 秒起跑、3 秒超时, 回来时正好 10 秒。
 */
const SPAWN_TIMEOUT_MS = 3_000;
const WALL_CLOCK_MS = 7_000;
/** 定义文件头多少行里找 import (契约 D-1 第 4 条)。 */
const IMPORT_SCAN_LINES = 30;
const IMPORT_MAX_LINES = 12;
/** 勘察 grep 每个文件最多几行 + 总共读几行 (只用来收标识符, 不进 text)。 */
const RECON_PER_FILE = 3;
const RECON_MAX_LINES = 200;
/** 首行没开大括号时往下再扫几行找 `{` (多行签名), 超过就当单行定义。 */
const SIG_SCAN_LINES = 8;
const CALLER_LINE_CHARS = 200;
/** 目录黑名单 (契约 D-1): 依赖与产物 —— 抽进来只会把别人的代码当本仓事实。 */
const EXCLUDE_DIRS = ['.git', 'node_modules', '.omd', '__pycache__', 'dist', 'build'];
const EXCLUDE_ARGS = EXCLUDE_DIRS.map((d) => `--exclude-dir=${d}`);
/**
 * 定义行的形状 (契约 D-1 逐字): `def` / `class` / `async def` / `function` / `const` / `let` /
 * `export (default )?(function|class|const)`。grep 侧用 GNU ERE, 收词侧用等价的 JS 正则。
 */
const DEF_KINDS = '(def|class|async def|function|const|let|export (default )?(function|class|const))';
const DEF_LINE_RE = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:def|class|function|const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
/** 只有**标识符形状**的词才拿去做定义 grep: 路径 / 引号里的短语不可能是定义名, 且它们进 ERE 要转义。 */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 缺省 IO: 与 criterion-survey 同款 (spawn 带 timeout, 起不来就抛, 由段级 catch 记进 why)。 */
function defaultRun(argv: string[], cwd: string): { exitCode: number | null; stdout: string } {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: SPAWN_TIMEOUT_MS });
  return { exitCode: r.exitCode, stdout: r.stdout.toString() };
}

/** `./src/a.py:12:xxx` → `{ path: 'src/a.py', line: 12, text: 'xxx' }`; 认不出来 ⇒ null。 */
function parseGrepLine(raw: string): { path: string; line: number; text: string } | null {
  const m = /^(.*?):(\d+):(.*)$/.exec(raw);
  if (!m) return null;
  return { path: m[1]!.replace(/^\.\//, ''), line: Number(m[2]), text: m[3]! };
}

function langOf(path: string): 'py' | 'ts' | 'other' {
  if (path.endsWith('.py')) return 'py';
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return 'ts';
  return 'other';
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** python / 未知语言: 从定义行起, 到下一个**同级或更浅**的非空行为止 (空行照收, 收完删尾部空行)。 */
function indentBlock(lines: readonly string[], start: number): string[] {
  const base = indentOf(lines[start]!);
  const out: string[] = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      out.push(line);
      continue;
    }
    if (indentOf(line) <= base) break;
    out.push(line);
  }
  while (out.length > 1 && out.at(-1)!.trim() === '') out.pop();
  return out;
}

/**
 * ts / js: 大括号配平。裸计数, **不认字符串与注释里的括号** —— 那要一个 parser, 而影响包是
 * 尽力而为的证据面; 数歪了最坏是多抽几行 (封顶 120 行兜着), 不会抽不到。
 */
function braceBlock(lines: readonly string[], start: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) return out;
    // 还没等到 `{`: 以分号收尾 = 单行定义 (箭头函数 / const 赋值); 扫够几行还没等到就别再往下吞。
    if (!opened && (line.trimEnd().endsWith(';') || out.length >= SIG_SCAN_LINES)) return out;
  }
  return out;
}

/**
 * 抽一个定义块。纯函数 (只吃行数组, 不碰盘)。
 *
 * @param lines 整个文件的行 (`split('\n')` 的结果)。
 * @param defLine 定义行的**从 0 起的下标** (grep 给的行号是从 1 起的, 调用方减一)。
 * @param lang `py` / `other` 按缩进收尾, `ts` 按大括号配平。
 * @param cap 封顶行数, 超了截断并把 `… (截断)` 作为最后一行。
 */
export function extractDefinitionBlock(
  lines: readonly string[],
  defLine: number,
  lang: 'py' | 'ts' | 'other',
  cap: number = DEF_BLOCK_MAX_LINES,
): string[] {
  if (defLine < 0 || defLine >= lines.length) return [];
  const block = lang === 'ts' ? braceBlock(lines, defLine) : indentBlock(lines, defLine);
  return block.length > cap ? [...block.slice(0, cap), TRUNCATED] : block;
}

/** 定义文件头 30 行里的 import / from 行 —— 「依赖在哪」这一问不必再花一步 cat。 */
function importLines(root: string, rel: string): string[] {
  const head = readFileSync(join(root, rel), 'utf8').split('\n').slice(0, IMPORT_SCAN_LINES);
  return head.filter((l) => /^\s*(import|from)\b/.test(l)).slice(0, IMPORT_MAX_LINES);
}

/**
 * 勘察 grep (一次 spawn, 定长): 拿 goal 里的词做**固定串**搜索, 只从「定义形状」的命中行里收名字。
 *
 * 为什么要这一趟: goal 常只点得出一个片段或一条路径 (`src/app.py`), 而真正要改的符号名写在
 * 命中行上 (`def build_report(rows):`)。收窄到定义形状行 = 不引噪声。
 */
function reconIdents(terms: readonly string[], root: string, run: ImpactRun): string[] {
  const argv = ['grep', '-rn', '-F', '-m', String(RECON_PER_FILE), ...EXCLUDE_ARGS, ...terms.flatMap((t) => ['-e', t]), '--', '.'];
  const r = run(argv, root);
  if (r.exitCode !== 0) return []; // 1 = 没命中, 2 = grep 自己出错 —— 都当没线索, 不是失败
  const out: string[] = [];
  for (const raw of r.stdout.split('\n').filter((l) => l !== '').slice(0, RECON_MAX_LINES)) {
    const hit = parseGrepLine(raw);
    if (!hit) continue;
    const m = DEF_LINE_RE.exec(hit.text);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/**
 * 算一份影响包。纯函数 + 受控 IO: 同一个仓同一个 goal 出同一份 `text`。
 *
 * @param goal 任务原文 (只用来抽标识符, 不进 text)。
 * @param root 仓根。
 */
export function buildImpactPack(goal: string, root: string, opts: ImpactPackOpts = {}): ImpactPack {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxTerms = opts.maxTerms ?? DEFAULT_MAX_TERMS;
  const maxDefsPerTerm = opts.maxDefsPerTerm ?? DEFAULT_MAX_DEFS_PER_TERM;
  const maxCallers = opts.maxCallers ?? DEFAULT_MAX_CALLERS;
  const run = opts.run ?? defaultRun;
  const deadline = Date.now() + WALL_CLOCK_MS;
  const facts: ImpactPackFacts = { terms: 0, defs: 0, callers: 0, chars: 0 };
  const whys: string[] = [];
  const blocks: string[] = [];
  const seenImports = new Set<string>();

  const goalTerms = extractGoalTerms(goal, maxTerms);
  if (goalTerms.length === 0) return { text: '', facts };

  // ① 词: goal 抽的 ∪ 勘察命中里那些定义形状行的名字, 去重后只留标识符形状的, 封顶 maxTerms。
  let terms: string[] = [];
  try {
    terms = [...new Set([...goalTerms, ...reconIdents(goalTerms, root, run)])].filter((t) => IDENT_RE.test(t)).slice(0, maxTerms);
  } catch (e) {
    whys.push(`勘察收词段失败: ${String(e)}`);
    logger.warn({ root, err: String(e) }, '[impact-pack] 勘察收词段失败 → 只用 goal 里的词 (其余照常)');
    terms = goalTerms.filter((t) => IDENT_RE.test(t)).slice(0, maxTerms);
  }
  facts.terms = terms.length;

  let deadlineHit = false;
  for (const term of terms) {
    if (deadlineHit) break;
    // ② 定义 + ④ 同文件 import。定义抽不到 ⇒ 这个词直接跳过调用者 (省一次 spawn)。
    const defHits: { path: string; line: number }[] = [];
    try {
      if (Date.now() > deadline) {
        deadlineHit = true;
        break;
      }
      const pattern = `^\\s*${DEF_KINDS}\\s+${term}\\b`;
      const r = run(['grep', '-rn', '-E', ...EXCLUDE_ARGS, '-e', pattern, '--', '.'], root);
      if (r.exitCode === 0) {
        for (const raw of r.stdout.split('\n').filter((l) => l !== '').slice(0, maxDefsPerTerm)) {
          const hit = parseGrepLine(raw);
          if (!hit) continue;
          const lines = readFileSync(join(root, hit.path), 'utf8').split('\n');
          const block = extractDefinitionBlock(lines, hit.line - 1, langOf(hit.path));
          if (block.length === 0) continue;
          defHits.push({ path: hit.path, line: hit.line });
          facts.defs++;
          blocks.push(`--- ${term} 的定义 (${hit.path}:${hit.line}) ---\n${block.join('\n')}`);
          if (!seenImports.has(hit.path)) {
            seenImports.add(hit.path);
            const imports = importLines(root, hit.path);
            if (imports.length > 0) blocks.push(`--- ${hit.path} 的 import (前 ${IMPORT_SCAN_LINES} 行) ---\n${imports.join('\n')}`);
          }
        }
      }
    } catch (e) {
      whys.push(`定义段 (${term}) 失败: ${String(e)}`);
      logger.warn({ root, term, err: String(e) }, '[impact-pack] 定义段失败 → 丢这个词 (其余照常)');
    }
    if (defHits.length === 0) continue;

    // ③ 调用者: `<词>(` 的命中行, 排掉定义自己那一行 (定义不是调用)。
    try {
      if (Date.now() > deadline) {
        deadlineHit = true;
        break;
      }
      const r = run(['grep', '-rn', '-F', ...EXCLUDE_ARGS, '-e', `${term}(`, '--', '.'], root);
      if (r.exitCode === 0) {
        const lines: string[] = [];
        for (const raw of r.stdout.split('\n').filter((l) => l !== '')) {
          if (lines.length >= maxCallers) break;
          const hit = parseGrepLine(raw);
          if (!hit) continue;
          if (defHits.some((d) => d.path === hit.path && d.line === hit.line)) continue;
          const one = `${hit.path}:${hit.line}:${hit.text}`;
          lines.push(one.length > CALLER_LINE_CHARS ? `${one.slice(0, CALLER_LINE_CHARS)}…` : one);
        }
        if (lines.length > 0) {
          facts.callers += lines.length;
          blocks.push(`--- ${term} 的调用者 (${lines.length} 处) ---\n${lines.join('\n')}`);
        }
      }
    } catch (e) {
      whys.push(`调用者段 (${term}) 失败: ${String(e)}`);
      logger.warn({ root, term, err: String(e) }, '[impact-pack] 调用者段失败 → 丢这一段 (定义段照常)');
    }
  }
  if (deadlineHit) whys.push(`影响包撞墙钟 (${WALL_CLOCK_MS} ms), 只抽完一部分词`);

  const why = whys.length > 0 ? whys.join('; ') : undefined;
  // 一个定义都没抽到 ⇒ 空串 (契约 D-1: 不是失败)。只有头行的空壳等于凭空多一段噪声。
  if (blocks.length === 0) return { text: '', facts, ...(why ? { why } : {}) };

  const body = blocks.join('\n\n');
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n… (超过影响包上限 ${maxChars} 字符, 已截断)` : body;
  const text = `${IMPACT_PACK_HEADER}\n\n${clipped}`;
  facts.chars = text.length;
  return { text, facts, ...(why ? { why } : {}) };
}
