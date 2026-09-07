/**
 * goal/spec-pack —— **动手前的上游对齐 + 需求枚举** (R7, 契约
 * `docs/plan/2026-09-07-规格包-上游对齐与需求枚举-执行契约.md`)。
 *
 * 治的读数 (`docs/research/2026-09-07-隐藏测试失败分型.md`): code80 低分题 84/240 里约 30 题是
 * **接口形状对不上** (AttributeError / KeyError / TypeError 参数 / ImportError) —— instruction 只有
 * 200 字节, 而隐藏检查来自上游真 PR, 测的是 `Validator.check_validity_of` 这样的**名字**、漏斗输出
 * 要有 `steps` 键、「alias / 缺字段 / 额外字段 / 默认值」各一条边界。执行侧按自己起的名字写实装、
 * 又按自己起的名字写判据, 自己全绿 —— 任何自写判据都抓不到这种错。判据维度四次读数
 * (读仓写判据 −0.02 / 影响包 −0.05 / 异族出题 −0.10 / 并集 −0.03) 一个都没提分, 所以这一发不加闸,
 * 而是**补输入**: 能提分的信息在仓本身与模型对上游的记忆里。
 *
 * 与勘察包 / 影响包的分工: 那两个**零 LLM**, 只搬盘上已有的字节; 本模块是**一发 LLM**,
 * 问的是盘上没有的东西 (上游叫什么名字、instruction 没写全的边界)。所以它自带 `source` 三档
 * (`repo` / `upstream` / `guess`) —— 「仓里已有同类」「对上游的记忆」「没有依据」是三件事,
 * 压成一个「参考」事后再也分不开 (§静默坑 1)。塌了归因就看 `guessed` 占比。
 *
 * **fail-open, 但不吞证据** (④ 告知层): 解析失败重试一次, 再失败 ⇒ `text=''` + `facts` 全 0 +
 * `why` 非空, 主流程照跑 (INV-3)。开关 `OMD_SPEC_PACK=1` 默认关, 缺席时调用方一个字节都不加 (INV-4)。
 *
 * falsify (本模块必须能真红, 见 `spec-pack.test.ts`): 去掉需求去重 ⇒ INV-1 红;
 * 去掉接口多数投票 ⇒ INV-2 红; 去掉 fail-open ⇒ INV-3 红; 去掉尾部截断 ⇒ INV-6 红。
 */
import { logger } from '../logger';

/** 一条接口的出处。三档别压平: `guess` = 模型自己编的, 与「仓里真有」不是一回事。 */
export type SpecSource = 'repo' | 'upstream' | 'guess';
/** 一条需求的出处。`instruction` = instruction 原文写了; `inferred` = 推出来的。 */
export type RequirementSource = 'instruction' | 'inferred';

export interface SpecInterface {
  name: string;
  signature: string;
  returns: string;
  raises: string;
  source: SpecSource;
}

export interface SpecConvention {
  file: string;
  note: string;
}

export interface SpecRequirement {
  text: string;
  source: RequirementSource;
  /** 这条覆盖的边界维度 (空值 / 缺字段 / 额外字段 / 默认值 / 顺序乱 / 重复 / 跨边界)。缺席 = 不是边界条。 */
  edge?: string;
}

/** 一份采样的产物 (`parseSpecSample` 的输出形状)。 */
export interface SpecSample {
  project: string;
  interfaces: SpecInterface[];
  conventions: SpecConvention[];
  requirements: SpecRequirement[];
}

/** 合并后的规格 (`mergeSpecSamples` 的纯函数产物)。`samples` = 真参与合并的份数, 不是要采的份数。 */
export interface MergedSpec extends SpecSample {
  samples: number;
}

/**
 * 规格包读数 (进 loop ledger)。
 *
 * 三态别压平 (§静默坑 1): 整格缺席 = **没算规格包** (开关没开 / 走的不是真分类那条路);
 * 在场且 `samples: 0` = 采了但一份都没解析出来 (那时 `why` 在场); `guessed` 高 = 采到了,
 * 但模型对上游没记忆 —— 后两者是完全不同的塌法, 归因看的正是这一格。
 */
export interface SpecPackFacts {
  samples: number;
  requirements: number;
  fromInstruction: number;
  interfaces: number;
  upstreamNamed: number;
  guessed: number;
  chars: number;
}

export interface SpecPack {
  text: string;
  facts: SpecPackFacts;
  /** 有采样失败 / 解析失败 / 截断才在场。缺席 ≠ 采满了: 三份全成且没截断时缺席。 */
  why?: string;
}

/**
 * 注入口: 一发纯文本生成 (无工具 —— 规格包只回答问题, 不许碰仓)。
 * 与 `criterion-author.ts` 的同名注入口逐字同形状: 勘察类一发调用全仓只此一种缝。
 */
export type SpecGenerateFn = (req: { model: string; prompt: string }) => Promise<string>;

export interface SpecPackOpts {
  generate: SpecGenerateFn;
  /** 采样份数 (D-3: 第 4 问取并集, 第 1–3 问取多数)。默认 3。 */
  samples?: number;
  /** 渲染后的总量上限 (INV-6)。默认 6000。 */
  maxChars?: number;
  /** 座位坐标。**执行座** (`agent`), 不换家族 —— R4 换家族已判负。 */
  model?: string;
}

/** 头一行固定 —— 接线面按它认「规格包在不在场」(INV-5 / D-6 都读这个字面)。 */
export const SPEC_PACK_HEADER = '## 规格包 (开跑前的上游对齐, 执行座自答; source 标出处, guess = 没有依据)';

const DEFAULT_SAMPLES = 3;
const DEFAULT_MAX_CHARS = 6000;
/** 平票时的出处优先级 (D-4): 仓里真有 > 对上游的记忆 > 没依据。 */
const SOURCE_RANK: Record<SpecSource, number> = { repo: 3, upstream: 2, guess: 1 };
/** 归一化去停用词表 —— 只挡「同一句话换个虚词」, 不做语义归并 (那需要模型, 而这里要的是确定性)。 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'or', 'is', 'are', 'be', 'should', 'must',
  'it', 'that', 'this', 'with', 'on', 'as', 'by', 'when', 'if', 'not', 'we',
  '的', '了', '要', '应', '需', '在', '是', '和', '与',
]);

/**
 * 开关 (D-1)。**只认字面 `1`** —— 与 `OMD_CRITERION_CONSENSUS` / `OMD_CRITERION_UNION` 同一条纪律:
 * 半开的开关 (`true` / `yes` / `0`) 会长成又一个说不清自己在不在的旋钮。
 * 默认关 = 它现在是单变量臂 `code80-m3-spec` 的那个变量, 关着的那一侧必须逐字节同旧 (INV-4)。
 */
export function specPackEnabled(): boolean {
  return process.env.OMD_SPEC_PACK?.trim() === '1';
}

/** 归一化: 小写 + 去标点 (含中文标点) + 去停用词 + 折空白。**只用来比对**, 不改 text 的原文。 */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '' && !STOPWORDS.has(w))
    .join(' ');
}

/** 模型回文里抠出那个 JSON 对象 (常被围栏 / 前后语包着)。抠不出 → 原文回去让 JSON.parse 报错。 */
function extractJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asSource(v: unknown): SpecSource {
  // 认不出的出处一律当 `guess` —— 往**保守**那一侧兜: 把编的当真的比把真的当编的坏得多。
  return v === 'repo' || v === 'upstream' ? v : 'guess';
}

/**
 * D-3: 解析一份采样。**宽进** —— 缺字段补空串、出处认不出降 `guess`, 只有「整个 JSON 解析不出来」
 * 或「四问一问都没答」才判失败。理由: 这一层不是闸 (规格包只进 prompt, 不进磁盘, 也不改控制流),
 * 严格拒会把一份「接口写对了但 conventions 漏了」的样本整份丢掉。
 */
export function parseSpecSample(raw: string): { sample: SpecSample } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch (err) {
    // §静默坑 2: 原文前缀进 error, 读侧才分得出「回了散文」与「回了半截 JSON」。
    return { error: `JSON 解析失败 (${String(err).slice(0, 120)}); 原文前 200 字: ${raw.slice(0, 200)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `产出不是 JSON 对象; 原文前 200 字: ${raw.slice(0, 200)}` };
  }
  const o = parsed as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const interfaces: SpecInterface[] = arr(o.interfaces).flatMap((x) => {
    const e = (x ?? {}) as Record<string, unknown>;
    const name = asString(e.name);
    return name === ''
      ? []
      : [{ name, signature: asString(e.signature), returns: asString(e.returns), raises: asString(e.raises), source: asSource(e.source) }];
  });
  const conventions: SpecConvention[] = arr(o.conventions).flatMap((x) => {
    const e = (x ?? {}) as Record<string, unknown>;
    const file = asString(e.file);
    return file === '' ? [] : [{ file, note: asString(e.note) }];
  });
  const requirements: SpecRequirement[] = arr(o.requirements).flatMap((x) => {
    const e = (x ?? {}) as Record<string, unknown>;
    const text = asString(e.text);
    const edge = asString(e.edge);
    return text === ''
      ? []
      : [{ text, source: e.source === 'instruction' ? ('instruction' as const) : ('inferred' as const), ...(edge ? { edge } : {}) }];
  });
  const project = asString(o.project);
  if (project === '' && interfaces.length === 0 && conventions.length === 0 && requirements.length === 0) {
    return { error: `四问一问都没答 (project / interfaces / conventions / requirements 全空); 原文前 200 字: ${raw.slice(0, 200)}` };
  }
  return { sample: { project, interfaces, conventions, requirements } };
}

/**
 * 同一个 key 下按**内容**多数投票, 平票取 `rank` 高的那份, 再平票取先出现的那份
 * (Map 保插入序)。D-4 的「多数投票 + source 优先级」就是这一个函数的两个参数。
 */
function majorityPick<T>(items: readonly T[], variantKey: (t: T) => string, rank: (t: T) => number): T | undefined {
  const counts = new Map<string, { n: number; item: T }>();
  for (const it of items) {
    const k = variantKey(it);
    const hit = counts.get(k);
    if (hit) hit.n += 1;
    else counts.set(k, { n: 1, item: it });
  }
  let best: { n: number; item: T } | undefined;
  for (const c of counts.values()) {
    if (!best || c.n > best.n || (c.n === best.n && rank(c.item) > rank(best.item))) best = c;
  }
  return best?.item;
}

/** 按 key 分组, 保第一次出现的顺序 —— 合并后的清单顺序要稳定, 否则两跑的 prompt 会无端漂。 */
function groupBy<T>(items: readonly T[], keyOf: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    const hit = out.get(k);
    if (hit) hit.push(it);
    else out.set(k, [it]);
  }
  return out;
}

/**
 * D-4 纯函数合并。**第 4 问取并集** (需求驱动实装, 漏一条就少做一件事), **第 1–3 问取多数**
 * (名字只能有一个, 三份各说各的等于没说)。
 *
 * · `requirements`: 按归一化文本去重, 保第一次出现的原文; 任一份标了 `instruction` 就算 `instruction`
 *   (「原文写了」是可证的, 一份看见即成立)。
 * · `interfaces`: 按 `name` 分组, 组内按整条内容多数投票, 平票取 `source` 优先级 repo > upstream > guess。
 * · `conventions`: 同上按 `file` 分组投票 (惯例是"指路", 同一个文件的两种说法只能留一种)。
 * · `project`: 整份多数投票。
 */
export function mergeSpecSamples(samples: readonly SpecSample[]): MergedSpec {
  if (samples.length === 0) return { project: '', interfaces: [], conventions: [], requirements: [], samples: 0 };

  const project =
    majorityPick(
      samples.map((s) => s.project).filter((p) => p !== ''),
      (p) => normalizeText(p),
      () => 0,
    ) ?? '';

  const interfaces = [...groupBy(samples.flatMap((s) => s.interfaces), (i) => i.name).values()].flatMap((group) => {
    const pick = majorityPick(group, (i) => `${i.signature}|${i.returns}|${i.raises}|${i.source}`, (i) => SOURCE_RANK[i.source]);
    return pick ? [pick] : [];
  });

  const conventions = [...groupBy(samples.flatMap((s) => s.conventions), (c) => c.file).values()].flatMap((group) => {
    const pick = majorityPick(group, (c) => normalizeText(c.note), () => 0);
    return pick ? [pick] : [];
  });

  // 并集去重: 归一化文本相同 ⇒ 同一条需求。原文保第一次出现的那份 (标点/大小写差异不影响语义)。
  const requirements: SpecRequirement[] = [];
  const seen = new Map<string, number>();
  for (const r of samples.flatMap((s) => s.requirements)) {
    const key = normalizeText(r.text);
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, requirements.length);
      requirements.push(r);
    } else if (r.source === 'instruction') {
      // 「instruction 原文写了」是可证的: 一份看见就成立, 不因另两份没看见而降级。
      requirements[at] = { ...requirements[at]!, source: 'instruction' };
    }
  }

  return { project, interfaces, conventions, requirements, samples: samples.length };
}

/** `## 规格包` 段正文 (D-1: 追加到勘察包末尾的就是这一段)。 */
export function renderSpecPack(merged: MergedSpec): string {
  const lines: string[] = [SPEC_PACK_HEADER, ''];
  if (merged.project !== '') lines.push(`### 项目\n${merged.project}`, '');
  if (merged.interfaces.length > 0) {
    lines.push('### 接口对齐 (判据与实装引用的符号名以这里为准)');
    for (const i of merged.interfaces) {
      lines.push(
        `- \`${i.name}\`` +
          (i.signature ? ` · 签名 \`${i.signature}\`` : '') +
          (i.returns ? ` · 返回 ${i.returns}` : '') +
          (i.raises ? ` · 抛出 ${i.raises}` : '') +
          ` · [${i.source}]`,
      );
    }
    lines.push('');
  }
  if (merged.conventions.length > 0) {
    lines.push('### 既有惯例 (照这些文件的写法来)');
    for (const c of merged.conventions) lines.push(`- \`${c.file}\`${c.note ? `: ${c.note}` : ''}`);
    lines.push('');
  }
  if (merged.requirements.length > 0) {
    lines.push('### 需求与边界清单 (逐条勾, 一条都不许漏)');
    for (const r of merged.requirements) {
      lines.push(`- [ ] ${r.text} [${r.source}]${r.edge ? ` (边界: ${r.edge})` : ''}`);
    }
  }
  return lines.join('\n').trimEnd();
}

/** D-3 的四问 prompt。规格包**只回答问题**, 一个字都不写进仓。 */
function specPrompt(goal: string, surveyText: string): string {
  return [
    '你在给一个自主执行环做**开跑前的规格对齐**。这次要改的是一个真实的开源仓, 隐藏的验收来自',
    '上游真实 PR —— 它测的是**上游那些名字**: 类名 / 方法名 / 输出字典的键 / 抛什么异常。',
    '名字对不上, 行为写对了也全错。所以现在先把「该叫什么」和「一共要做几件事」写清楚。',
    '',
    `## 指令原文 (要被实现的那件事)\n${goal}`,
    ...(surveyText.trim() !== '' ? ['', surveyText] : []),
    '',
    '## 你要回答的四个问题',
    '1. **项目身份**: 这是哪个项目 —— 名字与版本线索 (pyproject / setup.cfg / README 首行 / 包名)。',
    '2. **接口对齐**: 这次要新增或改动的每个**公开**接口, 在上游或生态里叫什么、签名是什么、',
    '   返回什么形状、抛什么错。每条**必须**标出处: `repo` (仓里已有同类, 照它写) /',
    '   `upstream` (你对上游真实 API 的记忆) / `guess` (没有依据, 你自己起的名)。',
    '   ⚠ 不确定就老实标 `guess` —— 把编的标成 `upstream` 比标 `guess` 坏得多。',
    '3. **既有惯例**: 被改模块对应的**既有测试文件**里, 同类功能怎么命名、怎么断言、用什么 fixture。',
    '   每条引用一个真实文件路径。',
    '4. **需求与边界枚举**: 把指令原文展开成可勾选清单, 每条标 `instruction` (原文写了) 或',
    '   `inferred` (你推出来的)。边界**至少**覆盖: 空值 · 缺字段 · 额外字段 · 默认值 · 顺序乱 ·',
    '   重复 · 跨边界 —— 隐藏检查逐条查的正是这几个维度。边界条在 `edge` 里写清是哪一维。',
    '',
    '## 输出格式 (只输出这一个 JSON 对象, 不要解释、不要围栏之外的字)',
    '{"project":"<一句话>",',
    ' "interfaces":[{"name":"","signature":"","returns":"","raises":"","source":"repo|upstream|guess"}],',
    ' "conventions":[{"file":"","note":""}],',
    ' "requirements":[{"text":"","source":"instruction|inferred","edge":"(可选)"}]}',
  ].join('\n');
}

/** 采一份: 解析失败**重试恰一次** (D-3)。两发都不成 ⇒ 这一份缺席, 原因原文进 `whys`。 */
async function sampleOnce(
  prompt: string,
  model: string,
  generate: SpecGenerateFn,
  seq: number,
  whys: string[],
): Promise<SpecSample | undefined> {
  // ⚠ 先取成局部变量再调 (同 criterion-author): 这个 `generate` 是契约钉的窄注入口 (只收
  // model + prompt), 真正打到观测面的那一发在 run-goal 的适配器里 (`traceName: 'goal:spec-pack'`)。
  const ask = generate;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string;
    try {
      raw = await ask({ model, prompt });
    } catch (err) {
      whys.push(`第 ${seq} 份第 ${attempt} 发抛错: ${String(err).slice(0, 160)}`);
      logger.warn({ seq, attempt, err: String(err) }, '[spec-pack] 采样抛错 (fail-open, 不吞证据)');
      continue;
    }
    const parsed = parseSpecSample(raw);
    if ('sample' in parsed) return parsed.sample;
    whys.push(`第 ${seq} 份第 ${attempt} 发解析失败: ${parsed.error.slice(0, 200)}`);
    logger.warn({ seq, attempt, error: parsed.error.slice(0, 300) }, '[spec-pack] 采样解析失败 → 重试一次');
  }
  return undefined;
}

/**
 * D-3 / D-4: 采 n 份 → 合并 → 渲染。**永不抛** —— 全挂就是一份空包 (`text: ''` + `facts` 全 0 +
 * `why`), 调用方照跑 (INV-3, ④ 告知层 fail-open)。
 *
 * @param goal 指令原文 (进 prompt)。
 * @param surveyText 仓内事实 (勘察包正文; 空串 = 不带这一段, prompt 逐字少那一块)。
 */
export async function buildSpecPack(goal: string, surveyText: string, opts: SpecPackOpts): Promise<SpecPack> {
  const n = Math.max(1, opts.samples ?? DEFAULT_SAMPLES);
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const model = opts.model ?? '';
  const prompt = specPrompt(goal, surveyText);
  const whys: string[] = [];

  // 并发采 —— n 发之间没有依赖, 串起来只是把开跑前那一站的墙钟乘 n (同共识采样那条纪律)。
  const settled = await Promise.all(Array.from({ length: n }, (_, i) => sampleOnce(prompt, model, opts.generate, i + 1, whys)));
  const got = settled.filter((s): s is SpecSample => s !== undefined);
  if (got.length === 0) {
    logger.warn({ n, model }, '[spec-pack] 采样全挂 → 规格包缺席 (主流程照跑)');
    return {
      text: '',
      facts: { samples: 0, requirements: 0, fromInstruction: 0, interfaces: 0, upstreamNamed: 0, guessed: 0, chars: 0 },
      why: whys.length > 0 ? whys.join('; ') : `${n} 份采样全挂 (无原因原文)`,
    };
  }

  const merged = mergeSpecSamples(got);
  // INV-6: 超上限**按 requirements 尾部截** —— 接口名是这一包的主产物, 清单是可再生的那半。
  let kept = merged.requirements.length;
  let text = renderSpecPack(merged);
  while (text.length > maxChars && kept > 0) {
    kept -= 1;
    text = renderSpecPack({ ...merged, requirements: merged.requirements.slice(0, kept) });
  }
  if (kept < merged.requirements.length) {
    whys.push(`超 ${maxChars} 字符: 需求清单尾部截掉 ${merged.requirements.length - kept} 条 (合并 ${merged.requirements.length} 条, 渲染 ${kept} 条)`);
  }
  if (text.length > maxChars) {
    // 需求全截完仍超 = 接口/惯例那两节自己就超了。硬截并说明 —— 静默半截比截断标记坏。
    text = `${text.slice(0, maxChars)}\n… (规格包超上限 ${maxChars} 字符, 已截断)`;
    whys.push(`渲染后仍超 ${maxChars} 字符 (接口/惯例段本身过长), 已硬截`);
  }

  const rendered = merged.requirements.slice(0, kept);
  const facts: SpecPackFacts = {
    samples: merged.samples,
    requirements: rendered.length,
    fromInstruction: rendered.filter((r) => r.source === 'instruction').length,
    interfaces: merged.interfaces.length,
    upstreamNamed: merged.interfaces.filter((i) => i.source === 'upstream').length,
    guessed: merged.interfaces.filter((i) => i.source === 'guess').length,
    chars: text.length,
  };
  logger.info({ ...facts, model }, '[spec-pack] 规格包已算 (guessed 占比高 = 模型对上游没记忆)');
  return { text, facts, ...(whys.length > 0 ? { why: whys.join('; ') } : {}) };
}
