/**
 * goal/criterion-author —— **异族座先写判据** (R4, 契约 `docs/plan/2026-09-06-异族先写判据-执行契约.md`)。
 *
 * ## 它治的病
 *
 * 1-A 只留边界之后, 判据文件**由执行侧首次写出**。在会「局部修」的座位上这等于让考生自己出题:
 * R2 逐题现场 —— gold 改 2 个文件, M3 只改 1 个, 自写的判据把断言放进 `test_util.py` 去测辅助函数,
 * 引擎判它成 (`runs/2026-09-06-e0-e1-e2/readout.md`)。判据是否点名指令符号与 reward 只有弱相关
 * (点名 0.334 / 未点名 0.223, n=8/6; 点名了仍 0.25 的有 3 题) ⇒ 病在**断言内容**, 不在指向,
 * 而任何检查判据文本的机械闸都够不到断言内容。
 *
 * 治法不是再加一道闸, 是**换出题人**: 判据文件由与执行侧**不同家族**的座位, 只看指令 + 勘察包
 * (看不到任何实装) 写出, 过方向探针后冻结; 执行侧只能让它过, 不能改它。
 *
 * ## 边界 (诚实标注)
 *
 * · 异族座**只出题不判卷** —— 判卷仍是 verifier 的活 (非目标)。
 * · 异族写不出 / 写出的过不了探针 ⇒ **记账后退回今天的路径** (执行侧自写)。这一整条是 fail-open 的:
 *   它是一次换出题人的尝试, 不是前置条件。
 * · 家族判定单源在 `./classify-acceptance` 的 `familyOf` / `crossFamilyModel` —— 这里不抄第二份。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { logger } from '../logger';
import { acceptanceVacuityReason, probeCriterionDirection } from './acceptance-gate';
import { crossFamilyModel } from './classify-acceptance';

/** D-8 读数。三态别压平: 整格缺席 = 开关没开 (走的是今天那条路); `attempted:false` = 没打模型 (见 `why`)。 */
export interface CriterionAuthorResult {
  attempted: boolean;
  model?: string;
  files?: string[];
  direction?: 'red-before' | 'green-before' | 'inconclusive';
  accepted: boolean;
  why?: string;
  /** D-7: 冻结的异族判据后来仍被 INV-4 重建边重建过 (重建者是执行体家族, 那是今天的行为)。缺席 = 没走那条路。 */
  rebuiltAfterCross?: boolean;
}

export interface AuthoredFile {
  path: string;
  content: string;
}

export interface CriterionAuthorInput {
  goal: string;
  command: string;
  expectExit: number;
  /** 判据引用、此刻不存在的文件 (相对 root 的 posix 路径; `missingPathArgs` 的产出)。 */
  missingFiles: string[];
  root: string;
  surveyText: string;
  conductorModel: string;
  /** 注入口: 一发纯文本生成 (无工具 —— 出题人不许碰仓)。 */
  generate: (req: { model: string; prompt: string }) => Promise<string>;
  probeDirection?: typeof probeCriterionDirection;
  vacuity?: typeof acceptanceVacuityReason;
  /**
   * 空世界自检的命令 runner (生产给 `config.dag.commandRunner`)。缺席 ⇒ **这道门不跑**
   * (不是"跑了没过"): 没有 runner 就没有"空世界里红不红"这回事, 留一行日志, 不改判 (§静默坑 1)。
   */
  runCommand?: (input: { command: string }) => Promise<{ exitCode: number | null }>;
  /** 异族座解析的注入口 (缺省 = 座位表真读盘)。测试注入才能把「有没有异族座」变成单变量。 */
  crossFamily?: (coord: string) => string | undefined;
}

/** D-3 结构化要求 —— 出题人只拿到这些, 一行实装都看不到。 */
function authorPrompt(input: CriterionAuthorInput): string {
  return [
    '你是**出题人**, 不是做题人。这次运行的验收判据引用了一个**还不存在**的测试文件, 由你把它写出来。',
    '写完之后, 另一个座位 (与你不同家族) 才开始改实装, 而它**改不动你写的这个文件** —— 它只能让它过。',
    '',
    `## 指令原文 (要被实现的那件事)\n${input.goal}`,
    `## 验收命令 (别人来跑的那一条; 期望退出码 ${input.expectExit})\n\`${input.command}\``,
    `## 你要写出的文件 (只能是这些路径, 一个都不能多)\n${input.missingFiles.join('\n')}`,
    '',
    input.surveyText,
    '',
    '## 硬要求',
    '1. **只写测试, 不写实现**。实现是另一个座位的活, 你写了它就白写。',
    '2. 测试必须**调用指令点名的入口** (函数 / 类 / 命令行), 不许绕到辅助函数上去断言。',
    '3. 每个断言要能**在改动前红、改动后绿** —— 改动前就已经成立的断言等于没写。',
    '4. **不得 import 不存在的符号**。上面的仓内事实列了仓里真有的东西, 只用那些。',
    '',
    '## 输出格式 (只输出这一个 JSON 对象, 不要解释、不要围栏之外的字)',
    '{"files": [{"path": "<上面列出的路径之一>", "content": "<文件全文>"}]}',
  ].join('\n');
}

/** 从模型回文里抠出那个 JSON 对象 (常被围栏 / 前后语包着)。抠不出 → 原文回给调用方判 error。 */
function extractJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}

/** 归一成「相对 root 的 posix 路径」—— `./x` 与 `x` 是同一个东西, 字面比会把它们读成两个。 */
function normalizePath(p: string): string {
  const posix = p.trim().split('\\').join('/');
  return posix.startsWith('./') ? posix.slice(2) : posix;
}

/**
 * INV-1: 解析异族座的产出。**fail-closed** —— 出身是环外座位, 但产物要落进仓里,
 * 所以形状不对 / 越界一律拒, 不做任何"猜他想写哪个文件"的补救。
 *
 * @param allowed 只准写这些路径 (`missingPathArgs` 的产出, 已是相对 posix)。
 */
export function parseAuthoredFiles(raw: string, allowed: readonly string[]): { files: AuthoredFile[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch (err) {
    // §静默坑 2: 原文前缀进 error, 读侧才分得出「模型回了散文」与「回了半截 JSON」。
    return { error: `JSON 解析失败 (${String(err).slice(0, 120)}); 原文前 200 字: ${raw.slice(0, 200)}` };
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(files) || files.length === 0) return { error: `产出里没有非空的 files 数组; 原文前 200 字: ${raw.slice(0, 200)}` };
  const out: AuthoredFile[] = [];
  const allow = new Set(allowed.map(normalizePath));
  for (const f of files) {
    const path = (f as { path?: unknown })?.path;
    const content = (f as { content?: unknown })?.content;
    if (typeof path !== 'string' || typeof content !== 'string' || !content) {
      return { error: `files 里有一项形状不对 (path / content 缺失或为空): ${JSON.stringify(f).slice(0, 160)}` };
    }
    const norm = normalizePath(path);
    // `..` 与绝对路径按**形状**拒 —— 不先 resolve 再看落点: 那样"归一后恰好落在 allowed 里"的
    // 越界写法会被放行, 而边界的意义正是不许拿运气过闸。
    if (norm.split('/').includes('..') || isAbsolute(norm)) return { error: `path 形状越界 (含 '..' 或绝对路径): ${path}` };
    if (!allow.has(norm)) return { error: `path 不在判据引用的文件里: ${path} (只准写 ${allowed.join(', ')})` };
    out.push({ path: norm, content });
  }
  return { files: out };
}

/**
 * D-2 / D-4: 找异族座 → 出题 → 写入磁盘 → 两道现成的门 → 采纳或删回去。
 *
 * 两道门都是**已有的**件, 这里一个都不新造:
 *  ① `probeCriterionDirection` —— 把刚写出的判据放回**改动前的代码**上跑, 必须红 (`red-before`);
 *  ② `acceptanceVacuityReason` —— 空世界自检, 判据不许恒真。
 * 任一不过 ⇒ 删掉已写入的文件, 退回执行侧自写 (今天的行为), `why` 留原文。
 */
export async function authorCriterionCrossFamily(input: CriterionAuthorInput): Promise<CriterionAuthorResult> {
  if (input.missingFiles.length === 0) {
    return { attempted: false, accepted: false, why: 'no-missing-criterion-file' };
  }
  const model = (input.crossFamily ?? crossFamilyModel)(input.conductorModel);
  if (!model) {
    logger.info({ conductorModel: input.conductorModel }, '[criterion-author] 没有异族座 → 判据仍由执行侧自写 (退回今天的路径)');
    return { attempted: false, accepted: false, why: 'no-cross-family-seat' };
  }
  let raw: string;
  // ⚠ 先取成局部变量再调, 不写 `input.generate({`: 观测面那道结构性守卫
  // (`test/core/langfuse-export.test.ts` ⑥) 按 `generate({` 这个字面形状认「打到观测面的那一发」,
  // 而这里的 `generate` 是**契约钉的窄注入口** (只收 model + prompt), 真正打出去的那一发在
  // run-goal 的 `productionCriterionAuthor` 适配器里, `traceName: 'goal:criterion-author'` 记在那儿。
  const ask = input.generate;
  try {
    raw = await ask({ model, prompt: authorPrompt(input) });
  } catch (err) {
    const why = `异族座出题抛错: ${String(err).slice(0, 240)}`;
    logger.warn({ model, err: String(err) }, '[criterion-author] 异族座出题抛错 → 退回执行侧自写 (不吞证据)');
    return { attempted: true, model, accepted: false, why };
  }
  const parsed = parseAuthoredFiles(raw, input.missingFiles);
  if ('error' in parsed) {
    logger.warn({ model, error: parsed.error.slice(0, 300) }, '[criterion-author] 异族座产出不合形状 → 退回执行侧自写');
    return { attempted: true, model, accepted: false, why: `产出不合形状: ${parsed.error}` };
  }
  const written: string[] = [];
  /** 弃用时删回去 —— 留一份过不了探针的判据在仓里, 比没写更坏 (它会被冻结, 然后恒红)。 */
  const undo = (): void => {
    for (const f of written) {
      try {
        rmSync(join(input.root, f), { force: true });
      } catch (err) {
        logger.warn({ file: f, err: String(err) }, '[criterion-author] 弃用的判据文件删不掉 (它留在仓里了, 会被后面的闸看见)');
      }
    }
  };
  try {
    for (const f of parsed.files) {
      const abs = join(input.root, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
      written.push(f.path);
    }
  } catch (err) {
    undo();
    const why = `写入失败: ${String(err).slice(0, 240)}`;
    logger.warn({ model, err: String(err) }, '[criterion-author] 异族座判据写不进仓 → 退回执行侧自写');
    return { attempted: true, model, accepted: false, why };
  }
  // ① 方向探针: 这是**唯一能问出「判据测没测对方向」的时刻** —— 判据已在盘上, 而实装还没做。
  const probe = input.probeDirection ?? probeCriterionDirection;
  const direction = await probe(input.command, written, input.root, input.expectExit);
  if (direction.status !== 'red-before') {
    undo();
    logger.warn(
      { model, status: direction.status, why: direction.why.slice(0, 300) },
      '[criterion-author] 异族座判据过不了方向探针 → 删回去, 退回执行侧自写',
    );
    return { attempted: true, model, files: written, direction: direction.status, accepted: false, why: `方向探针 ${direction.status}: ${direction.why}` };
  }
  // ② 空世界自检: 没 runner ⇒ 这道门不跑 (缺席 ≠ 不过)。
  if (input.runCommand) {
    const vacuity = (input.vacuity ?? acceptanceVacuityReason)(input.command, input.runCommand, input.expectExit);
    const reason = await vacuity;
    if (reason) {
      undo();
      logger.warn({ model, reason: reason.slice(0, 300) }, '[criterion-author] 异族座判据没过空世界自检 → 删回去, 退回执行侧自写');
      return { attempted: true, model, files: written, direction: direction.status, accepted: false, why: `空世界自检: ${reason}` };
    }
  } else {
    logger.info({ model }, '[criterion-author] 没有 commandRunner → 空世界自检这道门没跑 (方向探针照跑)');
  }
  logger.info({ model, files: written }, '[criterion-author] 异族座判据已采纳 (过方向探针) → 冻结后执行侧只能让它过');
  return { attempted: true, model, files: written, direction: direction.status, accepted: true };
}
