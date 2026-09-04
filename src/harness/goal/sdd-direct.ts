/**
 * src/harness/goal/sdd-direct —— solve 直通入口的 SDD 装载件 (SDD 2026-08-10-solve-sdd-direct-entry)。
 *
 * 已结晶的 SDD 即契约: `sddPath` 给了就跳过 research 轮与契约段子图 (specPath/evidence 直接
 * 取自文件, 与闸 C「契约段产物复用」同一条消费通路)。实测背景: 对一份 8KB 的已结晶 SDD,
 * 契约段转录税 ~224.5k tokens / ~15 分钟 (run b4989a06), 产出自述「GWT 逐条收录, 语义未改」。
 *
 * **fail-loud 是这里的全部性格** (D-3): 缺契约段的文档不是 SDD —— 拒起跑, 不静默降级回全程
 * goal (静默降级 = 调用方以为省了税, 实际付了全价, 比不支持更坏)。
 */
import { readFileSync } from 'node:fs';

/** 直通契约的最小结构要求: 六段式里这两段是执行与验收的地基, 缺任一 = 不是可执行契约。 */
const REQUIRED_SECTIONS: readonly { key: string; pattern: RegExp }[] = [
  { key: '契约 (Contracts)', pattern: /^##\s*契约|^##\s*Contracts/m },
  { key: '分解 (Breakdown)', pattern: /^##\s*分解|^##\s*Breakdown/m },
];

export interface SddContract {
  /** SDD 原文 (原样进 execute 任务文本, 含并行波形)。 */
  readonly text: string;
  /** 装载路径 (= specPath, 契约已写入磁盘的那份就是它)。 */
  readonly path: string;
}

/**
 * 装载并校验直通 SDD。读不到 / 缺必备段 → throw (错误信息指名缺什么, G-2)。
 * 校验是结构级不是语义级: 段在就行, GWT 写没写好由 execute 的验收面兜 —— 这里挡的是
 * 「拿一篇散文冒充契约」那一档。
 */
export function loadSddContract(path: string): SddContract {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`sddPath 读不到: ${path} — ${(e as Error).message}`);
  }
  const missing = REQUIRED_SECTIONS.filter((s) => !s.pattern.test(text)).map((s) => s.key);
  if (missing.length) {
    throw new Error(
      `sddPath 不是可执行契约 (缺段: ${missing.join('、')}): ${path} — ` +
        '缺契约段的文档回 /omd-contract 补齐, 不静默降级回全程 goal。',
    );
  }
  return { text, path };
}

// ── Breakdown 表解析 (内环 v2 切片 1 · SDD 2026-08-11-inner-loop-v2, D-1) ─────────────
//
// D-1 说的「编译器机械、零 LLM」从这里开始: 已结晶 SDD 的分解段本来就是结构化的
// (/omd-contract 规范钉死四列 + 一行波形), 把它读成结构是**纯字符串工作**, 不需要请一次
// conductor。解析器只管形状, 跨列的引用完整性 (依赖/波形指向的 id 存不存在、写集相不相交)
// 归编译器 —— 那是画图时才需要成立的事 (见 ./sdd-compile)。

/** 反向自检的一行 (sN-falsify · SDD 2026-08-22)。一组 `{file, oldText, newText}` 编译成图上的一个
 * `sN-falsify-i` 节点: 跑同一条 verify, 但 apply 这一行替换于文件 → 期望非零。
 *
 * 表头固定 (`# | 文件 | oldText | newText`), 列表头不在表内时按 0 个处理 —— D-7:
 * 不写 = 零列表, 不报错, 但意味着「这一片承重的那一跳没有判别力检查」。
 */
export interface SddFalsify {
  /** 表里的 `#` 列 (1-based), 编译时据其生成 `sN-falsify-<i>`。 */
  readonly index: number;
  /** 即将被替换那一行所在的文件 (相对仓根, 必须在该片写集内 — 见 sdd-compile INV-2)。 */
  readonly file: string;
  /** 唯一匹配必须命中的原文 (sdd-compile INV-9 与 EDIT_SCHEMA 同源: 零/多匹配 ⇒ 节点 failed)。 */
  readonly oldText: string;
  /** 替换后写入的新文本。允许多行, 但不许含 markdown 表里的列分隔 (代码上下文里通常没有)。 */
  readonly newText: string;
}

/** 分解表的一行 = 平铺图上的一个执行节点 (编译在 ./sdd-compile)。 */
export interface SddSlice {
  /** 切片编号 (表里的前导数字, 也是波形/依赖列引用它的方式)。 */
  readonly id: number;
  /** 切片名 (去掉编号与 ✅/** 等进度装饰后的那句话)。 */
  readonly name: string;
  /** 写集: 本片预期写入的路径清单。**并行安全的机器判据** (/omd-contract: 写集两两不相交)。 */
  readonly writeSet: readonly string[];
  /** 依赖的切片 id。「带理由」的括号是给人读的, 结构里只留 id。 */
  readonly deps: readonly number[];
  /** verify 列原文 (D-4 定向 TDD 的 RED/GREEN 命令串; 是否可跑由编译器判)。 */
  readonly verify: string;
}

export interface SddBreakdown {
  readonly slices: readonly SddSlice[];
  /**
   * 并行波形 = 作者**声明**的层序 (`并行波形:{1,3,4} → {2} → {5}`)。没写 → undefined,
   * **刻意不从依赖列反推**: 反推出来的层序与依赖列同源, 而它唯一的消费者 (sdd-compile 的
   * 乱序闸) 正是拿它去校对依赖列的 —— 自己推自己, 闸恒绿。
   * NULL ≠ 0 ≠ 不适用: undefined 在这里明确是「作者没声明」, 不是「只有一层」。
   */
  readonly waves?: readonly (readonly number[])[];
  /**
   * 每片反向自检 (可选; 缺 key = 该片没写反向自检表, 编译成零节点 — D-7)。
   * 放在 `SddBreakdown` 上而不是 `SddSlice` 上, 是为了让 `SddSlice` 的形状零变化 ——
   * 现有 parseBreakdown 用户 (slice-coverage / ignition-preflight / plan-doc-gaps …)
   * 解构 SddSlice 的写法不需要任何补丁。
   */
  readonly falsify?: Readonly<Record<number, readonly SddFalsify[]>>;
}

/**
 * 表行 → 单元格:**认引号的 `|` 切分**(t-verify-quoting 根因修, 2026-09-02)。
 *
 * 实测(run 32d16141 s5-green):verify 列 `jq -e '.generations | length >= 3' …` 里
 * 单引号内的 `|` 被裸 `split('|')` 当成列分隔 → verify 截到 19 字 → command 闸对着
 * 半截命令报「引号未闭合」。**闸判得对,是本函数上游把命令截了** —— 与 command-leaf
 * 掩码路径的教训同构:切分器不认引号,引号内内容就会被当结构。
 *
 * 规则:`'` / `"` / 反引号三种引号内的 `|` 是内容;引号态不嵌套(先开先闭)。
 * 未闭合引号(散文撇号等)会吞掉该行余下分隔 → 行的列数变少 → 走既有 fail-loud
 * 「不足四列」报错,不静默(比裸切分的静默截断严一档)。
 *
 * 证伪方式:退回 `trimmed.split('|')` → sdd-direct.test.ts 的「引号内管道不切列」用例红。
 */
function splitTableRow(trimmed: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quote: "'" | '"' | '`' | null = null;
  for (const ch of trimmed) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** 分解段起点 (与 REQUIRED_SECTIONS 同一族匹配; 段止于下一个 `## `)。 */
const BREAKDOWN_HEADING = /^##\s*(?:分解|Breakdown)/m;

/**
 * 这份文档**打算不打算**走 sddPath 直通 (有没有分解段)。
 *
 * 存在的理由是 NULL≠0≠不适用: 没有分解段的计划文档跑 `parseBreakdown` 会抛, 而那是
 * 「本文档不走直通」——**不适用**, 不是「契约写坏了」。调用方 (scripts/plan-doc-check 的
 * 点火预演段) 拿它把两者分开; 抹平成一个 fatal 会让 149 份文档里的绝大多数被判 blocker。
 *
 * 只判标题在不在, 不判表好不好 —— 后者是 `parseBreakdown` 自己的领地, 别在这里抄第二份。
 */
export function hasBreakdownSection(text: string): boolean {
  return BREAKDOWN_HEADING.test(text);
}
/** 波形行: `并行波形:{1,3} → {2}` (允许 backtick / 引用前缀 / 全半角冒号)。 */
const WAVE_LINE = /^[>\s*-]*(?:并行波形|波形|Waves?)\s*[:：]\s*(.+)$/m;
/**
 * 反向自检小节标题 (sN-falsify): `### 反向自检 (切片 N)` 或 `（切片 N）` —— 半全角括号皆收,
 * 与本仓契约里习惯中文标点一致。「切片」前后空格都收, 因为不同作者写法不同。
 * 仅 `### ` 起头, 不匹配 `#### ` (避免误吞嵌套注释) 也不匹配 `## ` 整段大标题。
 */
const FALSIFY_HEADING = /^###\s+反向自检\s*[（(]\s*切[片片]?\s*(\d+)\s*[）)]/m;
/** 表格分隔行 `|---|:--:|`。 */
const SEPARATOR_CELL = /^:?-{2,}:?$/;
/** 表头行 (列名由 /omd-contract 规范钉死)。 */
const HEADER_CELL = /^(切片|slice)$/i;
/**
 * 写集/依赖列的项分隔 (半角与全角并列 —— 中文表里两种都会出现)。
 *
 * `·` 是 2026-08-21 补的, 而它缺席的代价是**两晚的铺图税**: P2/P3 两份契约的写集列
 * 全用 `·` 分隔 (本仓写契约的实际习惯), 于是整格解析成**一个**条目 ——
 * 那一条恰好含 `/` 所以过了下面的"不像路径"闸, 一路静默到直通编译的下一段才炸,
 * 回落 conductor 铺图。`parseBreakdown` 自己**不报错**, `plan-doc-check` 也判 PASS,
 * 只有直通 v2 吃不下 —— 又一个 S-45(同一段文字多套解析器, 判据各不相同)。
 */
const ITEM_SEP = /[+,，、;；·]/;

/**
 * 括号内是给人读的理由/注解 (`—(消费 blame.ts)` · `sdd-compile.ts(新)`), 解析前剥掉。
 *
 * `**新建**` 这类 markdown 加粗标注同样是给人读的 (同上, 两份契约里逐格都有)。
 * 内容里排掉 `/` 与 `*` 是为了**不误伤 glob**: `src/**\/*.ts` 的 `**` 紧跟 `/`,
 * 配不上这条规则; 而 `**新建**` 的内容 `新建` 两者都不含, 整段剥掉。
 */
const stripAnnotations = (cell: string): string =>
  cell
    .replace(/`/g, '')
    .replace(/[(（][^)）]*[)）]/g, ' ')
    .replace(/\*\*([^*/]*?)\*\*/g, ' ');

/**
 * 写集列 → 路径清单。「+ test」是 /omd-contract 表的惯例简写「连同它的测试」, 展开成同名
 * `.test.ts` 兄弟 —— 不展开等于把「这片也写测试」这条事实丢掉, 而写集相交闸靠的正是这份清单。
 */
function parseWriteSet(cell: string, id: number): string[] {
  const out: string[] = [];
  for (const raw of stripAnnotations(cell).split(ITEM_SEP)) {
    const t = raw.trim();
    if (!t || t === '—' || t === '-') continue;
    if (/^tests?$/i.test(t)) {
      const last = out[out.length - 1];
      if (!last)
        throw new Error(`分解表切片 ${id}: 写集里的 "test" 简写前面没有它所属的路径`);
      const sibling = last.replace(/\.(tsx?)$/, '.test.$1');
      if (sibling !== last && !out.includes(sibling)) out.push(sibling);
      continue;
    }
    if (!t.includes('/'))
      throw new Error(`分解表切片 ${id}: 写集有不像路径的项 "${t}" (写集只收相对路径)`);
    if (!out.includes(t)) out.push(t);
  }
  if (!out.length)
    throw new Error(`分解表切片 ${id}: 写集为空 —— 写集是并行安全的机器判据, 不许留白`);
  return out;
}

/** 依赖列 → id 清单 (括号理由已剥, 剩下的数字就是 id; `—` → 空)。 */
function parseDeps(cell: string, id: number): number[] {
  const out: number[] = [];
  for (const n of stripAnnotations(cell).match(/\d+/g) ?? []) {
    const dep = Number(n);
    if (dep === id) throw new Error(`分解表切片 ${id}: 自依赖 (自己等自己, 永远跑不起来)`);
    if (!out.includes(dep)) out.push(dep);
  }
  return out;
}

/**
 * 反向自检一行 (`# | 文件 | oldText | newText`) → 列表。**留给那一片写一个表头** 而不是
 * 借分解段的 HEADER_CELL: 切片列头是 `切片|slice`, 这里列头是 `#` —— 不能复用。
 *
 * 收多遍宽松的 markdown 惯例: 表头一行 / 分隔一行 / 数据若干行; 数据行 first line 出现即起,
 * 第一个非 `|` 行即止 (节点文档里写散文时这一节可能插一句例示, 不让它乱入)。
 *
 * **oldText / newText 的转义规则 (INV-3)**: 数据单元格的内容是 markdown cell, 表格惯例会
 * 把列间塞一格 (`| ... | ... |`). 这一格在源码上下文里往往**有语义** (前导缩进) —— `.trim()`
 * 把它无声吞掉, **引擎 mutation 寻找 unique-match 时找不到, 判 failed, 报一个与根因 (契约
 * 层把缩进丢了) 离得远的错**。所以:
 *
 *   · 列内 trim 仅剥 markdown 列表格自身的单格边距 (一格的 ` | ` 填充);
 *   · 源码里的前导空格**用反引号括起来** —— markdown 的标准转义。`\`  const x; \`` 即「这段
 *     字面内容首尾各有一格, 不要当作表格填充剥掉」, 与现有分解表对路径/backtick 的处理同款。
 *   · 全列纯文本 (无反引号) 时 trim 一轮: 与本仓其它列一致 ——
 *     `oldText/newText` 不带反引号时作者写的就是"清洁源码片段", 表格填充不属于它。
 */
function parseFalsifyTable(section: string, sliceId: number): SddFalsify[] {
  const out: SddFalsify[] = [];
  let passedSeparator = false;
  for (const rawLine of section.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('|')) {
      if (passedSeparator) break;
      continue;
    }
    // 不在每 cell 上 .trim() —— 用首尾 split 后剥空字符串, 把 markdown 表格的 outer padding
    // 剥掉, 但**保留**内部的源代码缩进 (见上方 INV-3 转义规则的注解)。
    const rawCells = trimmed.split('|');
    if (rawCells[0] === '') rawCells.shift();
    if (rawCells[rawCells.length - 1] === '') rawCells.pop();
    if (rawCells.every((c) => SEPARATOR_CELL.test(c.trim()))) {
      passedSeparator = true;
      continue;
    }
    if (!passedSeparator) continue; // header 行, 跳过
    if (rawCells.length < 4)
      throw new Error(
        `反向自检 (切片 ${sliceId}) 的一行不足四列 (#|文件|oldText|newText): ${rawLine}`,
      );
    if (rawCells.length > 4)
      throw new Error(
        `反向自检 (切片 ${sliceId}) 的一行超过四列 (#|文件|oldText|newText): ${rawLine} — ` +
          '单元格里不许出现 `|`，否则 markdown 表格会把它静默拆成多列。',
      );
    const idx = Number(rawCells[0]!.trim());
    if (!Number.isInteger(idx) || idx < 1)
      throw new Error(
        `反向自检 (切片 ${sliceId}) 的 "#" 列必须是正整数 (按行计序号, 是 sN-falsify-<i> 的 i 来源): ${rawLine}`,
      );
    const file = extractCell(rawCells[1]!);
    if (!file || !file.includes('/'))
      throw new Error(
        `反向自检 (切片 ${sliceId}) 的文件列不是相对路径 (mutation file 必须在该片写集内): ${rawLine}`,
      );
    out.push({
      index: idx,
      file,
      // 源码列 — 见 INV-3: 反引号 = 字面保留 (含缩进 / 末空格), 否则 trim
      oldText: extractCodeCell(rawCells[2]!),
      newText: extractCodeCell(rawCells[3]!),
    });
  }
  return out;
}

/** `\`foo\`` → `foo`; 否则原样返回。markdown cell 转义 — 见 parseFalsifyTable 顶上的 INV-3 注释。 */
function extractCell(raw: string): string {
  const t = raw.trim();
  const m = /^`([^`]+)`$/.exec(t);
  return m ? m[1]! : t;
}

/**
 * 源码专用 cell 提取 (INV-3):
 *  · 反引号 = 字面保留 (含源缩进 / 末格) —— 与 `\`  const x = 1;\`` 形态对齐;
 *  · 无反引号 = 一轮 trim, 允许 `    const x = 1;    ` 写成 `    const x = 1;` 而**不丢**起末空格 —
 *    等等, trim 还是会丢。所以无反引号路真的就是「作者该自己负责前后空格」。
 *    真要保留缩进, 加反引号。
 */
function extractCodeCell(raw: string): string {
  const t = raw.trim();
  const m = /^`([^`]+)`$/.exec(t);
  return m ? m[1]! : t;
}

/**
 * 把 ``` 围栏块的内容换成等长空格 (行数与每行长度都不变 → 偏移语义不变)。
 *
 * 反向自检的解析要用它 —— 契约必须能在文档里举例说明自己的格式, 而围栏正是 markdown 里
 * 「这是示例不是内容」的表达方式。**证伪方式**: 去掉这一跳 → `falsify-compile.test.ts`
 * 的「围栏里的示例表不被当成真表」用例当场红 (示例指向片外文件 → 编译期 INV-2 拒)。
 */
function stripFencedBlocks(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return ' '.repeat(line.length);
      }
      return inFence ? ' '.repeat(line.length) : line;
    })
    .join('\n');
}

/**
 * 整份 SDD 文本里扫所有 `### 反向自检 (切片 N)` H3 小节, 合成一个 `sliceId → SddFalsify[]` 表。
 *
 * 只在表头命中且其后真跟着一个表时才计入 (`parseFalsifyTable` 返空数组 = 等价于该片没写,
 * 仍计入空数组, 由 D-7「缺表 = 零列表」承接)。**不命中任何小节 → 返 undefined**,
 * `parseBreakdown` 据此把 `falsify` 字段从 breakdown 里抽掉 —— 这样无反向自检的 SDD 与改造前
 * 的 breakdown 字面一致 (承 sdd-compile 的零回归闸)。
 */
function parseAllFalsify(
  text: string,
  slices: readonly SddSlice[],
): Record<number, SddFalsify[]> | undefined {
  // ``` 围栏里的示例不是真表 (2026-08-22 实测): 本片自己的契约在 C-1 里用围栏举了一张
  // 示例表说明格式, 而解析器把它当真表 —— 编译期 INV-2 当场拒「mutation 伸到片外」。
  // 闸判得对, 错在解析面: **一份契约必须能在文档里举例说明自己的格式**。
  // 剔除用等长空格替换 (不删行不缩短行), 保持 `h.index` / `text.slice` 的偏移语义不变。
  // ⚠ 只改 falsify 这一路; `parseBreakdown` 的四列表解析**一个字不动** —— 它是既有行为,
  //   没有读数说它被这条坑过 (Surgical: 不顺手改没坏的东西)。
  text = stripFencedBlocks(text);
  const headings = [...text.matchAll(/^###\s+反向自检\s*[（(]\s*切[片片]?\s*(\d+)\s*[）)][^\n]*$/gm)];
  if (headings.length === 0) return undefined;
  const out: Record<number, SddFalsify[]> = {};
  const validIds = new Set(slices.map((s) => s.id));
  for (const h of headings) {
    const sliceId = Number(h[1]);
    if (!validIds.has(sliceId))
      throw new Error(
        `反向自检小节 (切片 ${sliceId}) 在分解表里没有对应切片 —— 表头编号必须先在切片列出现`,
      );
    const start = (h.index ?? 0) + h[0].length;
    const rest = text.slice(start);
    // 小节止于下一个 H3 或下一个 H2 (后者更宽 — 同 parseBreakdown 的 section 切法)。
    // 注意别用 H1: 文档顶部 # 标题在 markdown 里出现一次, 它不是 section 边界。
    const next = /^#{2,3}\s/m.exec(rest);
    const sub = next ? rest.slice(0, next.index) : rest;
    out[sliceId] = parseFalsifyTable(sub, sliceId);
  }
  return out;
}

// ── 结晶器四列表的兼容折叠 (t-spec-format · S-45 族, 2026-09-02) ─────────────────
//
// 引擎自己结晶的 spec 自己吃不下: `spec-author` 卡 (agent-templates-builtin.ts) 只说
// 「Breakdown = construction slices + dependencies」, **没钉列名**, 而它的 TDD SHAPE 段
// 要求 TEST/RED/IMPL/GREEN 四片同写集。于是结晶出来的是「切片|波形|写集|验证」四列 +
// RED/GREEN 行写集写「同上」—— 直通 v2 要的「切片|写集|依赖|verify」+ 写集两两不相交,
// 两条判据全不满足 (run bd81b660 实测, 当晚靠人工折叠绕过)。
//
// 修在读侧不修在写侧: prompt 保证不了格式 (卡上写什么列名都不是机械闸), 而**盘上已经有的**
// 那些结晶产物也只有读侧能救。折叠是确定性的, 规则只有三条 (下面 foldLegacyRows 的注释)。

/** 旧格式的判据: 表头第 2 列是「波形」而不是「写集」。列名不匹配 = 不是旧格式, 不折叠。 */
const LEGACY_WAVE_HEADER = /^(波形|并行波形|waves?)$/i;
/** 写集列的回指写法 (RED/GREEN 行惯用) —— 折叠成并集时它不贡献新路径, 整格丢掉。 */
const LEGACY_SAME_AS_ABOVE = /^(同上|同前|同上文|same(\s+as\s+above)?)$/i;

/** 表的一行: 单元格 + 原文 (原文只为报错时逐字还原作者写的那一行)。 */
interface RawRow {
  readonly cells: string[];
  readonly raw: string;
}

/** 旧格式写集格 → 直通格 (回指/占位归零; 其余原样交给 parseWriteSet, 剥注解是它的活)。 */
function legacyWriteCell(cell: string): string {
  const t = cell.replace(/`/g, '').replace(/\*\*/g, '').trim();
  if (!t || t === '—' || t === '-' || LEGACY_SAME_AS_ABOVE.test(t)) return '';
  return cell.trim();
}

/**
 * 旧格式验证格 → 直通 verify。剥两样东西:
 *  · 尾巴上的 `, expect_exit 1` / `，期望退出码 1` —— 红/绿由 sdd-compile 生成的 `sN-green` 节点管,
 *    退出码不属于 verify 命令串 (留着会被 command 闸当命令的一部分)。
 *  · `同命令 …` / `同上` 这类**回指** —— 它不是命令。GREEN 行整格归零后, 那一波的
 *    verify 由 RED 行那条真命令提供 (两行本来就要求同一条命令)。
 */
function legacyVerifyCell(cell: string): string {
  const v = cell
    .replace(/`/g, '')
    .trim()
    .replace(/[,，;；、]?\s*(?:expect[_ ]?exit|期望退出码)\s*[:：]?\s*\d+\s*$/i, '')
    .trim();
  if (!v || v === '—' || v === '-') return '';
  if (/^(同上|同命令|同一命令|同条命令|same)/.test(v)) return '';
  return v;
}

/**
 * 四列旧表 → 直通 v2 四列表。三条规则, 全确定性:
 *  1. **按波形分组** —— 同一波形值的行折成一片 (TEST/RED/IMPL/GREEN 本来就是同一件事的四步,
 *     写集必然相交; 折成一片后写集变并集, 相交闸才有意义)。片号按波形值升序重编为 1..N。
 *  2. **波形变依赖** —— 第 k 波依赖第 k-1 波 (波形列就是作者声明的层序)。首波无依赖。
 *  3. **无波形又无写集的行丢掉** —— 盘上两份结晶产物里这只有两种行: 「全量验收」行
 *     (accept 节点由 sdd-compile 自己生成, 不占切片位) 与分组标题行 (`| 波形 1 · … | | | |`)。
 *     **有写集却没波形**则 throw: 放不进任何一层 = 静默少跑一片, 不许。
 */
function foldLegacyRows(rows: readonly RawRow[]): RawRow[] {
  const groups = new Map<number, { names: string[]; writes: string[]; verify: string }>();
  for (const { cells, raw } of rows) {
    if (cells.length < 4)
      throw new Error(`分解表这一行不足四列 (切片|波形|写集|验证): ${raw}`);
    const write = legacyWriteCell(cells[2]!);
    const waveDigits = /\d+/.exec(stripAnnotations(cells[1]!));
    if (!waveDigits) {
      if (!write) continue; // 全量验收行
      throw new Error(`分解表这一行有写集却没有波形, 放不进任何一层: ${raw}`);
    }
    const wave = Number(waveDigits[0]);
    const g = groups.get(wave) ?? { names: [], writes: [], verify: '' };
    g.names.push(cells[0]!.replace(/^\s*\d+\s*[·.、:：-]*\s*/, '').trim());
    if (write) g.writes.push(write);
    const verify = legacyVerifyCell(cells[3]!);
    if (verify) g.verify = verify;
    groups.set(wave, g);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, g], i) => {
      const cells = [
        `${i + 1} ${g.names.join(' + ')}`,
        g.writes.join(' · '),
        i === 0 ? '—' : String(i),
        g.verify,
      ];
      return { cells, raw: `| ${cells.join(' | ')} |` };
    });
}

/**
 * 解析「## 分解 (Breakdown)」段: 四列表 + 可选波形行 + 每片可选反向自检小节 → 结构 (G-1 前半)。
 *
 * fail-loud 承 loadSddContract 的性格 (G-6): 解析不了的行**不跳过**——跳过 = 整片切片凭空
 * 消失, 图少一个节点而台账上什么都看不出来 (silent-failures 图鉴那一族)。
 */
export function parseBreakdown(text: string): SddBreakdown {
  // ``` 围栏里的表是**示例不是内容** —— 与 parseAllFalsify 同一条理由 (2026-08-22)。
  // 实测: 分解段里放一张围栏内的示例四列表, 解析出 2 片 (应为 1) —— 示例被当成真切片,
  // 图上凭空多一个节点, 而台账上看不出来 (正是本函数注释下面那条 fail-loud 要防的病, 只是
  // 从"少一片"换成了"多一片")。
  // ⚠ 安全性查过: 扫 `docs/plan/*.md`, **没有任何契约把分解表写在围栏内** ⇒ 零历史影响。
  // 证伪方式: 去掉这一跳 → `sdd-direct.test.ts` 的「围栏内的示例四列表不被当成切片」当场红。
  text = stripFencedBlocks(text);
  const head = BREAKDOWN_HEADING.exec(text);
  if (!head) throw new Error('分解 (Breakdown) 段缺失 —— 无表可解析');
  const after = text.slice(head.index + head[0].length);
  const nextHeading = /^##\s/m.exec(after);
  const section = nextHeading ? after.slice(0, nextHeading.index) : after;

  // 先把表行收齐再判形状: 旧格式 (切片|波形|写集|验证) 的识别只能靠表头, 而表头在数据行之前。
  const rows: RawRow[] = [];
  let legacy = false;
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = splitTableRow(trimmed);
    if (cells[0] === '') cells.shift();
    if (cells[cells.length - 1] === '') cells.pop();
    if (cells.every((c) => SEPARATOR_CELL.test(c))) continue;
    if (HEADER_CELL.test(cells[0] ?? '')) {
      if (LEGACY_WAVE_HEADER.test(stripAnnotations(cells[1] ?? '').trim())) legacy = true;
      continue;
    }
    rows.push({ cells, raw: trimmed });
  }

  const slices: SddSlice[] = [];
  const seen = new Set<number>();
  for (const { cells, raw: trimmed } of legacy ? foldLegacyRows(rows) : rows) {
    if (cells.length < 4)
      throw new Error(`分解表这一行不足四列 (切片|写集|依赖|verify): ${trimmed}`);
    const idMatch = /^(\d+)/.exec(cells[0]!);
    if (!idMatch)
      throw new Error(`分解表这一行的切片列不以编号开头 (编号是波形/依赖引用它的唯一方式): ${trimmed}`);
    const id = Number(idMatch[1]);
    if (seen.has(id)) throw new Error(`分解表切片编号重复: ${id} (两片会被并成一片, 少跑的那片没人发现)`);
    seen.add(id);
    slices.push({
      id,
      name: cells[0]!
        .slice(idMatch[0].length)
        .replace(/✅/g, '')
        .replace(/\*\*/g, '')
        .replace(/^[\s:：.、]+/, '')
        .trim(),
      writeSet: parseWriteSet(cells[1]!, id),
      deps: parseDeps(cells[2]!, id),
      verify: cells[3]!.replace(/`/g, '').trim(),
    });
  }
  if (!slices.length)
    throw new Error('分解段里没有切片行 —— 空表会编译成一张只有 accept 的图 ("什么都没干" 被读成 "跑完了")');

  const waveLine = WAVE_LINE.exec(section);
  const waves = waveLine
    ? [...waveLine[1]!.matchAll(/[{｛]([^}｝]*)[}｝]/g)].map((g) =>
        (g[1]!.match(/\d+/g) ?? []).map(Number),
      )
    : undefined;

  // 反向自检小节 (sN-falsify · SDD 2026-08-22, C-1) —— 整份 SDD 里 `### 反向自检 (切片 N)`
  // 风格的 H3, 每片一张四列表 (# | 文件 | oldText | newText)。**缺表 = 零列表, 不报错** (D-7):
  // 把所有反向自检关掉是契约作者的真合法选项 (那片就没写), 把它搞成硬闸会逼出一堆空表占位节点。
  // 解析失败 → throw (同 parseBreakdown 的性格, 走过头的行不悄悄丢)。
  const falsify = parseAllFalsify(text, slices);

  return {
    slices,
    ...(waves?.length ? { waves } : {}),
    ...(falsify ? { falsify } : {}),
  };
}
/**
 * 从 SDD 写入磁盘路径机械提取挂票要带的两样: 各切片写集的并集 + sddPath 本体。
 *
 * 复用 parseBreakdown —— 不重写第二遍, 不抄一遍表解析; 写集并集用 Set 保首次出现序
 * (slice 编号是稳定的, 哈希去重后顺序仍可复演)。**解析失败 → throw** (fail-loud 与
 * loadSddContract / parseBreakdown 同款, 缺段或表坏时宁可不挂票也不静默塞空)。
 *
 * 闸 C「契约段产物复用」的同一条消费通路在 runGoal 那侧复用 contract.text —— 这里只取
 * 挂票要的两样, 不返合同全文 (那是 SddContract 的事)。
 */
export function ticketFieldsFromSdd(sddPath: string): { writeSet: string[]; sddPath: string } {
  const { text } = loadSddContract(sddPath);
  const writeSet = [...new Set(parseBreakdown(text).slices.flatMap((s) => s.writeSet))];
  return { writeSet, sddPath };
}
