/**
 * goal/survey-pack —— **勘察一次, 两层共用** (2026-09-06, 契约
 * `docs/plan/2026-09-06-墙钟与读次数-执行契约.md` W1)。
 *
 * 要砍的是**轮数**, 不是 token: code80-boundary 80 题实测每题 36–44 次 LLM 调用, 其中 conductor
 * 约 23 步在读仓 (bash 步的 61% 是 grep/ls/cat/sed/find/git 这类只读勘察), 只有 1 到 3 步在派活;
 * 子节点拿到的 work 卡只有一段自由文本 brief, 于是把 conductor 读过的东西再读一遍。
 * 这些事实引擎自己一次就能机械算完 —— 算完之后 conductor 与每个 work 子节点共用同一份。
 *
 * 本模块**零 LLM**, 六段全是确定性读盘 / 读进程输出:
 *  1–3. README · 既有测试清单 · goal 标识符命中 —— 直接复用 {@link surveyForCriterion} 那三段
 *       (同一个 `run` 注入口, 不另造第二份实现; 它的段级 try/catch 与墙钟一并继承);
 *  4. 仓树 (深度 2) —— 「这仓长什么样」是 ls 步最常问的那一个;
 *  5. git 状态 + 最近三条 commit —— 「现在盘上是干净的吗 / 上一步做了什么」;
 *  6. 环境事实 —— 语言 / runner 在不在 PATH / 验收命令候选 (复用 {@link renderEnvFacts})。
 *
 * **每一段独立 try/catch**: 一段炸只丢那一段, 原因原文进 `why` (§静默坑 2 —— fail-open 可以吞
 * 异常, 不许吞证据)。段缺席 ≠ 段失败: 不是 git 仓时 git 段缺席而 `why` 缺席 (§静默坑 1)。
 *
 * falsify (本模块必须能真红, 见 `survey-pack.test.ts`): 仓树不下钻第二层 ⇒ 「二层目录进 text」红;
 * git 段不跑 `git log` ⇒ 「commit sha 进 text」红; 去掉总量截断 ⇒ 「≤ maxChars + 200」红。
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type EnvFacts, probeEnvFacts, renderEnvFacts } from '../env-facts';
import { logger } from '../logger';
import { type CriterionSurveyOpts, surveyForCriterion } from './criterion-survey';

/** 勘察包读数 (进 loop ledger)。`sections` = 真进了 text 的段名, 缺名 = 那段空或那段炸 (看 `why` 分辨)。 */
export interface SurveyPack {
  text: string;
  facts: { chars: number; sections: string[] };
  /** 有段失败才在场。缺席 ≠ 全成功: 段空也缺席 (空不是失败)。 */
  why?: string;
}

/** 与 {@link CriterionSurveyOpts.run} 同一个签名 —— 勘察的进程注入口全仓只此一种形状。 */
export type SurveyRun = NonNullable<CriterionSurveyOpts['run']>;

export interface SurveyPackOpts {
  maxChars?: number;
  /** 已探过就传进来 (run-goal 那条路上 `probeEnvFacts` 早跑过一次), 省一次全仓扫描。 */
  envFacts?: EnvFacts;
  run?: SurveyRun;
}

/** 头一行固定 —— 这一句是给模型的边界: 这些事实**已经读过**, 别再花一步重读。 */
export const SURVEY_PACK_HEADER = '===== 仓内事实 (引擎机械勘察, 已经读过, 不要再重读这些) =====';

/** 契约钉死的总量上限 (conductor 面与子节点 goal 共用同一份, 两处都按这个数算)。 */
const DEFAULT_MAX_CHARS = 8000;
/** 仓树深度: 1 = 根下一层, 2 = 再下一层。再深就是在替模型读代码了, 那是它的自由。 */
const TREE_DEPTH = 2;
const TREE_MAX_ENTRIES = 120;
const TREE_MAX_CHARS = 2500;
const GIT_STATUS_LINES = 20;
const GIT_MAX_CHARS = 800;
const ENV_MAX_CHARS = 800;
/** 目录黑名单: 依赖与产物 —— 列进来只会把别人的文件当本仓事实。 */
const TREE_SKIP_DIRS = new Set(['.git', 'node_modules', '.omd', 'dist', 'build']);

/** 缺省 IO: 与 criterion-survey 同款 (5 秒 timeout, 起不来就抛, 由段级 catch 记进 why)。 */
function defaultRun(argv: string[], cwd: string): { exitCode: number | null; stdout: string } {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 5_000 });
  return { exitCode: r.exitCode, stdout: r.stdout.toString() };
}

/** 深度 2 的仓树, 目录带尾斜杠, 按名排序; 到 `maxEntries` 即停 (截断照实说在段头)。 */
function repoTree(root: string, maxEntries: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > TREE_DEPTH || out.length >= maxEntries) return;
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= maxEntries) return;
      if (TREE_SKIP_DIRS.has(ent.name)) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        out.push(`${childRel}/`);
        walk(join(dir, ent.name), childRel, depth + 1);
      } else {
        out.push(childRel);
      }
    }
  };
  walk(root, '', 1);
  return out;
}

/** 段级截断: 每段自己有上限, 免得一段 (常是仓树) 把总预算吃光, 别的段一条都进不去。 */
function clip(body: string, max: number): string {
  return body.length > max ? `${body.slice(0, max)}\n… (本段超 ${max} 字符, 已截断)` : body;
}

/**
 * 算一份勘察包。纯函数 + 受控 IO: 同一个仓同一个 goal 出同一份 `text`。
 *
 * @param goal 任务原文 (只用来抽标识符去 grep, 不进 text)。
 * @param root 仓根。
 */
export function buildSurveyPack(goal: string, root: string, opts: SurveyPackOpts = {}): SurveyPack {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const run = opts.run ?? defaultRun;
  const sections: string[] = [];
  const blocks: string[] = [];
  const whys: string[] = [];

  // ① 环境事实 —— 语言 / runner 在不在 PATH / 验收命令候选。一句人话, 最便宜也最常被重问。
  try {
    const facts = opts.envFacts ?? probeEnvFacts(root);
    blocks.push(`--- 仓环境 ---\n${clip(renderEnvFacts(facts), ENV_MAX_CHARS)}`);
    sections.push('env');
  } catch (e) {
    whys.push(`环境段失败: ${String(e)}`);
    logger.warn({ root, err: String(e) }, '[survey-pack] 环境段失败 → 丢这一段 (其余照常)');
  }

  // ② 仓树 (深度 2) —— 「这仓长什么样」, 顶掉一串 ls。
  try {
    const entries = repoTree(root, TREE_MAX_ENTRIES);
    if (entries.length > 0) {
      const head = `--- 仓树 (深度 ${TREE_DEPTH}, ${entries.length} 条${entries.length >= TREE_MAX_ENTRIES ? ', 已到条数上限' : ''}) ---`;
      blocks.push(`${head}\n${clip(entries.join('\n'), TREE_MAX_CHARS)}`);
      sections.push('tree');
    }
  } catch (e) {
    whys.push(`仓树段失败: ${String(e)}`);
    logger.warn({ root, err: String(e) }, '[survey-pack] 仓树段失败 → 丢这一段 (其余照常)');
  }

  // ③ git 状态 + 最近三条 commit —— 「盘上干净吗 / 上一步做了什么」。
  // 不是 git 仓 ⇒ 两条命令都非 0 ⇒ 段缺席且 **why 缺席**: 「没有」不是「失败」(§静默坑 1)。
  try {
    const status = run(['git', 'status', '--short'], root);
    const log = run(['git', 'log', '--oneline', '-3'], root);
    const lines: string[] = [];
    if (status.exitCode === 0) {
      const st = status.stdout.split('\n').filter((l) => l !== '').slice(0, GIT_STATUS_LINES);
      lines.push(`git status --short (前 ${GIT_STATUS_LINES} 行):`, ...(st.length > 0 ? st : ['(干净)']));
    }
    if (log.exitCode === 0) {
      lines.push('git log --oneline -3:', ...log.stdout.split('\n').filter((l) => l !== ''));
    }
    if (lines.length > 0) {
      blocks.push(`--- git ---\n${clip(lines.join('\n'), GIT_MAX_CHARS)}`);
      sections.push('git');
    }
  } catch (e) {
    whys.push(`git 段失败: ${String(e)}`);
    logger.warn({ root, err: String(e) }, '[survey-pack] git 段失败 → 丢这一段 (其余照常)');
  }

  // ④⑤⑥ README · 既有测试清单 · goal 标识符命中 —— 复用分类期那三段 (同一个 run 注入口)。
  // 它自己已经是段级 fail-open 的, why 原文往上并; 段名从它的读数派生 (readme/testFiles/termHits)。
  try {
    const criterionShare = Math.max(1000, maxChars - TREE_MAX_CHARS - GIT_MAX_CHARS - ENV_MAX_CHARS);
    const survey = surveyForCriterion(goal, root, { run, maxChars: criterionShare });
    if (survey.why) whys.push(survey.why);
    if (survey.text !== '') {
      blocks.push(survey.text.slice(survey.text.indexOf('\n') + 1).trimStart());
      if (survey.facts.readme) sections.push('readme');
      if (survey.facts.testFiles > 0) sections.push('tests');
      if (survey.facts.termHits > 0) sections.push('terms');
    }
  } catch (e) {
    whys.push(`契约线索三段失败: ${String(e)}`);
    logger.warn({ root, err: String(e) }, '[survey-pack] 契约线索三段失败 → 丢这三段 (其余照常)');
  }

  const why = whys.length > 0 ? whys.join('; ') : undefined;
  // 一段都没有 ⇒ 空串。只有头行的空壳等于凭空多一段噪声 (与 criterion-survey 同一条纪律)。
  if (blocks.length === 0) return { text: '', facts: { chars: 0, sections }, ...(why ? { why } : {}) };

  const body = blocks.join('\n\n');
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n… (超过勘察包上限 ${maxChars} 字符, 已截断)` : body;
  const text = `${SURVEY_PACK_HEADER}\n\n${clipped}`;
  return { text, facts: { chars: text.length, sections }, ...(why ? { why } : {}) };
}
