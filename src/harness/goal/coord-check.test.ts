/**
 * src/harness/goal/coord-check.test —— 派工文本坐标机械校验 (W2-241 · 切片 1)。
 *
 * 实装前天然红: 本测试是 slice 1 的产物, 与 `coord-check.ts` 同片写出。**测试必含**:
 *  ① 0f67293b 原案 (编造符号 → 违规 + 指认原文);
 *  ② 「新建」豁免正例;
 *  ③ 行号越界反例;
 *  ④ #265 那 8 条误报同款散文碎片 (负样本共享语料);
 *  ⑤ 真阳性正向 (干净文本 → 零 finding, 零涟漪 INV-W241-4)。
 *
 * 反向自检统一形状 (同 ignition-criteria-check.test / sdd-ignition-check.test):
 *  · 证伪方式写在每条 test 注释 —— 「把这行删掉 / 改成 X → 本 test 由绿转红」, 一条永远绿
 *    的闸不是闸 (CLAUDE.md §1)。
 */
import { describe, expect, test } from 'bun:test';
import { checkCoords, type CoordFinding } from './coord-check';

// ── 测试夹具 ──────────────────────────────────────────────────────────────────

const ROOT = '/repo';

/**
 * 拟盘文件系统: 测试替身, 路径 → 文件内容。**未登记 = null = 读不到** (同 `claim-anchor.ts`
 * 测试夹具口径, 便于断言「盘上不存在」。
 */
const files: Record<string, string> = {
  // 真账 run 0f67293b 那段: 真名 `saveReasonFull`, 编造名 `saveVerdictReasonFull`。
  '/repo/src/harness/continuity/checkpoint-manager.ts': [
    ...Array.from({ length: 320 }, (_, i) => `// filler line ${i + 1}`),
    'export class CheckpointManager {',
    '  /** 写入 reason 全文到磁盘, 返绝对路径或 null (失败)。 */',
    '  saveReasonFull(runId: string, nodeId: string, round: number, text: string): string | null {',
    '    return this.saveTextArtifact(runId, "reason-", `${nodeId}-r${round}`, text);',
    '  }',
    '}',
  ].join('\n'),
  // GWT 正例: 含 `foo` + `bar` 两个标识符, 测「同句共现命中」零 finding。
  '/repo/src/exists.ts': ['export function foo() {', '  return bar();', '}', ''].join('\n'),
  // 给行号越界那条用的「短文件」。
  '/repo/src/short.ts': ['line1', 'line2', 'line3'].join('\n'),
  // 给「路径存在但不带 /」路径 (`tsconfig.json` 同款) 测「裸路径不含 /」豁免用。
  '/repo/tsconfig.json': '{ "compilerOptions": {} }',
  // 2026-09-07 Web 子集: 附件标签 + 文档路径 (标签在文档里不会以原文出现)。
  '/repo/public-assets/brief/game-design-brief.md': '# Game design brief\n\nA cozy atmosphere game.\n',
  '/repo/public-assets/data/tasks.json': '{"tasks":[{"id":1}]}',
};

/** 注入式 read: 不在 files map → 视为读不到 (= 盘上不存在)。 */
const read = (p: string): string | null => (p in files ? files[p]! : null);

const findBy = (
  all: readonly CoordFinding[],
  pred: (f: CoordFinding) => boolean,
): CoordFinding | undefined => all.find(pred);

// ── 0f67293b 原案 (核心真阳性) ───────────────────────────────────────────────

describe('checkCoords — 0f67293b 原案 (编造符号必报)', () => {
  test('★ 原案: 完整路径 + 编造符号 → identifier-not-in-file, 原文指认 saveVerdictReasonFull', () => {
    // 真账 run 0f67293b 现场: 执行体把 `saveVerdictReasonFull` 照抄进 `rg -e ...`, 真名是
    // `saveReasonFull`。本闸的形状 ③ 必须抓到。
    // 证伪: 删掉 shape ③ 那段 (last `if (IDENT_RE.test...)`) → 本 test 转红。
    const text = 'task 写「`saveVerdictReasonFull` 在 `src/harness/continuity/checkpoint-manager.ts:312`」';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    const f = findBy(r, (x) => x.criterion === 'identifier-not-in-file');
    expect(f).toBeDefined();
    expect(f!.identifier).toBe('saveVerdictReasonFull');
    expect(f!.where).toBe('src/harness/continuity/checkpoint-manager.ts');
    expect(f!.raw).toBe('saveVerdictReasonFull');
    // 同行 path:line 在 312 行 ≤ 文件长度 → 不触发 oob; path 存在 → 不触发 missing
    expect(r.some((x) => x.criterion === 'path-line-missing')).toBe(false);
    expect(r.some((x) => x.criterion === 'path-line-oob')).toBe(false);
  });

  test('★ 原案变体: 路径无前缀 (`checkpoint-manager.ts:312`) → path-line-missing', () => {
    // 原案第二面: task 没写路径前缀, 直接 `checkpoint-manager.ts` — 即使符号名是对的,
    // 路径也是编的。本闸形状 ① 必须抓到。
    // 证伪: 把 shape ① 的 `if (content === null) push path-line-missing` 删掉 → 本 test 转红。
    const text = 'task 写「`saveReasonFull` 在 `checkpoint-manager.ts:312`」';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    const f = findBy(r, (x) => x.criterion === 'path-line-missing');
    expect(f).toBeDefined();
    expect(f!.where).toBe('checkpoint-manager.ts');
    expect(f!.line).toBe(312);
    expect(f!.message).toContain('读不到');
  });
});

// ── 「新建」豁免正例 (INV-W241-1 ① 同句「新建」则跳过) ──────────────────────

describe('checkCoords — 「新建」豁免', () => {
  test('★ 同行有「新建」 → path-missing 跳过 (本片会产出, 不算编造)', () => {
    // 写集列的常见写法: `src/foo.ts` (新建)。原文明确说「会新建」, 本闸不报。
    // 证伪: 把 `lineText(text, tok.line).includes('新建')` 删掉 → 本 test 转红
    // (把真合法的「即将产出」路径当成编造路径拒).
    const text = '写集: `src/new-foo.ts` (新建)';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    expect(r).toEqual([]);
  });

  test('★ 同行有「新建」 → path-line-missing 跳过 (含行号也豁免)', () => {
    // 行号版的「新建」豁免: `src/foo.ts:12` (新建) —— 也会被误报, 同行豁免要覆盖。
    // 证伪: 同上, 删豁免即转红。
    const text = '写 `src/new-bar.ts:12` (新建) 一段';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    expect(r).toEqual([]);
  });

  test('★ 「新建」在不同行 → 不豁免, 仍报 path-missing', () => {
    // 「新建」在另一行 = 不算同句豁免 —— 这是形状 ①/② 那条「同句」字面意义最严的解读。
    // 证伪: 把 `tok.line` 改成 `1` (全文本当一行) → 本 test 转红 (那等于把豁免面扩成
    // 全文, 把真编造路径用跨行「新建」洗掉, 这是 #265 那族误报的反面)。
    const text = ['写集将含新建标记', '具体路径: `src/new-baz.ts`'].join('\n');
    const r = checkCoords(text, { root: ROOT, readFile: read });
    expect(r.some((x) => x.criterion === 'path-missing' && x.where === 'src/new-baz.ts')).toBe(true);
  });
});

// ── 行号越界反例 (INV-W241-1 ①) ──────────────────────────────────────────────

describe('checkCoords — 行号越界 (path-line-oob)', () => {
  test('★ path:line 行号 > 文件行数 → path-line-oob 带 line 与文件实际行数', () => {
    // /repo/src/short.ts 只有 3 行, 指到第 10 行必越界。
    // 证伪: 把 shape ① 的 `if (lineNo > lineCount) push oob` 删掉 → 本 test 转红。
    const text = '见 `src/short.ts:10` 的实现';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    const f = findBy(r, (x) => x.criterion === 'path-line-oob');
    expect(f).toBeDefined();
    expect(f!.where).toBe('src/short.ts');
    expect(f!.line).toBe(10);
    expect(f!.message).toContain('只有 3 行');
  });

  test('★ path:line 行号在范围内 → 不报', () => {
    // 同一文件, 指到第 2 行 (在范围内) → 不应触发任何 finding。
    // 证伪: 把 `lineNo > lineCount` 改成 `>=` → 本 test 转红 (本应是 ≤ 的越界判成「恰好等
    // 也越界」, 把合规的末行指认拒掉)。
    const text = '见 `src/short.ts:2` 那行';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    expect(r).toEqual([]);
  });
});

// ── 形状 ② 裸路径 ────────────────────────────────────────────────────────────

describe('checkCoords — 裸路径 (含 `/` + 已知扩展名)', () => {
  test('★ 含 `/` 的现存路径 → 不报', () => {
    // 干净的形状 ②, 零 finding (INV-W241-4 零涟漪)。
    const text = '写集引用 `src/exists.ts` 文件';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    expect(r).toEqual([]);
  });

  test('★ 含 `/` 的不存在路径 → path-missing', () => {
    // 裸路径但盘上不在 → 必须报。
    // 证伪: 把 shape ② 的 `if (content === null) push path-missing` 删掉 → 本 test 转红。
    const text = '改 `src/ghost.ts` 那段';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    const f = findBy(r, (x) => x.criterion === 'path-missing');
    expect(f).toBeDefined();
    expect(f!.where).toBe('src/ghost.ts');
  });

  test('★ 不含 `/` 的路径提及 (`tsconfig.json`) → 不当 path 验 (无行号提及 = 纯散文)', () => {
    // #145 的「无行号路径提及是纯误报」收敛面: `tsconfig.json` (仓根、无 `/`) 不是裸路径
    // 形状, 不进验证集 —— 因为这种提及在散文里大量出现 (「看 tsconfig.json」), 一律报 = 误报。
    // 证伪: 把 `m2 && tok.content.includes('/')` 改成 `m2` → 本 test 转红 (那等于把所有
    // 无 `/` 路径提及都报, 把 `#145` 那条既有收敛吃回去)。
    const text = '读数: `tsconfig.json` 改了一下';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    expect(r).toEqual([]);
  });
});

// ── 形状 ③ 同句标识符 grep -F ────────────────────────────────────────────────

describe('checkCoords — 同句「标识符 + 路径」共现', () => {
  test('★ 同句标识符真在文件里 → 不报 (正例)', () => {
    // src/exists.ts 里有 `foo` 和 `bar`, 同句引用应零 finding。
    // 证伪: 把 `if (content.includes(tok.content)) continue` 删掉 → 本 test 转红 (即把
    // 真合法的「同句共现」当成「编造符号」报)。
    const text = '调用 `foo` 见 `src/exists.ts` 一文';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    expect(r).toEqual([]);
  });

  test('★ 同句标识符不在文件里 → identifier-not-in-file, identifier 字段指认', () => {
    // 同句有 `nonexistentSymbol` + `src/exists.ts`, 但文件里没 `nonexistentSymbol` → 报。
    // 证伪: 把 shape ③ 的 push 段删掉 → 本 test 转红。
    const text = '调用 `nonexistentSymbol` 见 `src/exists.ts`';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    const f = findBy(r, (x) => x.criterion === 'identifier-not-in-file');
    expect(f).toBeDefined();
    expect(f!.identifier).toBe('nonexistentSymbol');
    expect(f!.where).toBe('src/exists.ts');
  });

  test('★ 跨行同句 → 形状 ③ 不触发 (同句 = 同行的最严解读)', () => {
    // 标识符在 N 行, 路径在 N+1 行 → 不算同句, 不应触发 (这与 #265 的「同一段多套解析器
    // 各自漂」是同款教训: 「同句」放宽 = 误报面扩大, 字面最严 = 行为可复演)。
    // 证伪: 把 `other.line !== tok.line` 删掉 → 本 test 转红 (跨行也算同句, 把
    // markdown 表格里相邻行的两段当成「共现」, 误报炸)。
    const text = ['调用 `anotherGhost`', '见 `src/exists.ts` 一文'].join('\n');
    const r = checkCoords(text, { root: ROOT, readFile: read });
    expect(r).toEqual([]);
  });

  test('★ 同行多标识符 × 多路径 → 全部 pair 各自报 (同句共现 = 任意 pair)', () => {
    // 同句有 `ghostA` + `src/exists.ts` 和 `ghostB` + `src/short.ts`: 规格读「同句共现」
    // 是 yes/no (任意 pair), 2 标识符 × 2 路径 = 4 个 pair, 全部触发 (两个标识符都不在这两
    // 个文件里)。这是「任何同句 pair 都查」的最严读, 与「最近配对」的宽松读相反 —— 选最严
    // 是因为「编造」的判定不应被宽松配对的启发式吃掉。
    // 证伪: 把外层 `for (const other of tokens)` 删掉 → 只剩一条 finding, 本 test 转红。
    const text = '看 `ghostA` 在 `src/exists.ts` 与 `ghostB` 在 `src/short.ts`';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    const ids = r.filter((x) => x.criterion === 'identifier-not-in-file').map((x) => x.identifier).sort();
    expect(ids).toEqual(['ghostA', 'ghostA', 'ghostB', 'ghostB']);
  });

  test('★ 同句标识符 + 路径存在但标识符真在 → 不报 (正例, 不该被 pair 误触)', () => {
    // 同句有 `foo` + `src/exists.ts`, `foo` 真在 exists.ts 里: 不应触发 (任何 pair 都不报)。
    // 证伪: 把 shape ③ 的 `if (content.includes(tok.content)) continue` 删掉 → 本 test 转红。
    const text = '看 `foo` 见 `src/exists.ts`';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    expect(r).toEqual([]);
  });

  test('★ 同行标识符 + 路径不存在 → 只报 path-missing, 不报 identifier-not-in-file', () => {
    // 同句有 `whatever` + `src/ghost.ts` (ghost.ts 不存在): 形状 ② 先报 path-missing,
    // 形状 ③ 看到 content === null 主动跳过 —— 避免「一句里两条 finding 看似同义」。
    // 证伪: 把形状 ③ 里 `if (content === null) continue` 删掉 → 本 test 多出一条
    // identifier-not-in-file 假信号。
    const text = '调用 `whatever` 见 `src/ghost.ts`';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    expect(r.some((x) => x.criterion === 'path-missing')).toBe(true);
    expect(r.some((x) => x.criterion === 'identifier-not-in-file')).toBe(false);
  });
});

// ── #265 那 8 条误报同款散文碎片 (负样本: 必判不验) ─────────────────────────

describe('checkCoords — #265 8 条误报同款散文碎片 (全判不验)', () => {
  /**
   * 8 条样本全部来自 #265 票评论的误报语料, 覆盖「反引号里看起来像但不该验」的所有形态:
   * 短串 / 有空格 / 表格单元 / 标点 / 数字 / 符号混杂 / 单字符顿号 / 空内容。
   *
   * 共同断言: `checkCoords(...).length === 0`。
   * 证伪方式: 任一形状 (①②③) 的正则放宽 (去掉 `^` / `$` / 把 `+` 改 `*` / 去掉 `\\d+`
   * 后缀要求) → 至少一条 test 转红。
   */
  const negatives: { name: string; raw: string }[] = [
    // ① 单个顿号「、」(中文标点, 不进任何形状)
    { name: '单字顿号「、」', raw: '看 `、` 一段' },
    // ② 带前导空格 + 末冒号 (常见表格单元)
    { name: '前导空格 + 「新建:」', raw: '表格: ` 新建:` 一栏' },
    // ③ 测试读数残段 (parens 起, 数字混杂)
    { name: '测试读数 `) green: 26 + 30 = 56 pass / 0 fail.`', raw: '读数 `) green: 26 + 30 = 56 pass / 0 fail.` 进回执' },
    // ④ 带首尾空格 + 括号不配对的散文段
    { name: '括号不配对 `(漏右) `', raw: '一段 `(漏右) ` 散文' },
    // ⑤ 表格单元碎片: ` | **新建** (≈230 行): `
    { name: '表格单元 ` | **新建** (≈230 行): `', raw: '清单 ` | **新建** (≈230 行): ` 一行' },
    // ⑥ 极短 ` | 增 ` (表格单元微碎片)
    { name: '极短 ` | 增 `', raw: '字段 ` | 增 ` 一格' },
    // ⑦ 全是数字 + 空格 + 标点
    { name: '全数字 `26 + 30`', raw: '读数 `26 + 30` 一组' },
    // ⑧ 多字符但不是标识符 (含 `.` 与 `/`)
    { name: '路径前缀 `../src/`', raw: '相对 `../src/` 拼一下' },
  ];

  for (const neg of negatives) {
    test(`★ 负样本 #${negatives.indexOf(neg) + 1}: ${neg.name} → 零 finding`, () => {
      // 共同断言: 不被当 path 验 / 不被当 identifier 验, 全部自然放过。
      const r = checkCoords(neg.raw, { root: ROOT, readFile: read });
      expect(r).toEqual([]);
    });
  }
});

// ── 零涟漪 / 全白名单 ────────────────────────────────────────────────────────

describe('checkCoords — 零涟漪 (INV-W241-4) 与全白名单', () => {
  test('★ 干净散文 (无三形状) → 零 finding', () => {
    // INV-W241-4: 非 sddPath 且 goal 文本无三形状命中时, 行为逐字节照旧 (= 零 finding)。
    const text = '请把这段文案润色一下, 让它更口语化, 注意保留核心论点。';
    expect(checkCoords(text, { root: ROOT, readFile: read })).toEqual([]);
  });

  test('★ 多 backtick 多行, 全部命中白名单 → 零 finding', () => {
    // 干净的多行 markdown 段落: 每行有反引号, 但都是「散文碎片」/「正常短串」/「正常标识符
    // 不带同句路径」。预期零 finding —— 与既有零回归闸对齐。
    const text = [
      '请遵循 `INV-W241-4` 这条原则。',
      '在 `src/exists.ts` 里改 `foo` 与 `bar`。',
      '同时读 `README.md` 的 `Quickstart` 一节。',
    ].join('\n');
    const r = checkCoords(text, { root: ROOT, readFile: read });
    expect(r).toEqual([]);
  });

  test('★ 空文本 → 零 finding (不抛)', () => {
    expect(checkCoords('', { root: ROOT, readFile: read })).toEqual([]);
  });

  test('★ 跨行反引号 → 当未闭合, 静默吞 (不抛不报)', () => {
    // markdown 里反引号跨行 = 渲染器会吃, 本闸也不该把它当合法 span (否则会拿整张表当一行
    // 跑, 误报面炸)。证伪: 把 `extractBackticks` 的「跨行吞」删掉 → 本 test 转红
    // (围栏示例会被当成真 spans, 触发大量 identifier-not-in-file 误报)。
    const text = '行首 `漏了闭合\n下一行没反引号收尾';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    expect(r).toEqual([]);
  });

  test('★ dedup: 同一 path:line 在文本里出现两次 → 只报一次', () => {
    // 一份长 SDD 里同句 / 跨句重复同一句是常态 (「见 x.ts:5 …… 再见 x.ts:5」) —— dedup 避免
    // 回执重复刷屏。
    const text = ['见 `src/ghost.ts:5` 那行', '再看 `src/ghost.ts:5` 一次'].join('\n');
    const r = checkCoords(text, { root: ROOT, readFile: read });
    const missing = r.filter((x) => x.criterion === 'path-line-missing');
    expect(missing).toHaveLength(1);
  });

  test('★ dedup: 同 (identifier, path) 在文本里出现多次 → 只报一次', () => {
    const text = '调用 `ghostId` 见 `src/exists.ts` …… 再调一次 `ghostId` 见 `src/exists.ts`';
    const r = checkCoords(text, { root: ROOT, readFile: read });
    const idf = r.filter((x) => x.criterion === 'identifier-not-in-file');
    expect(idf).toHaveLength(1);
  });
});
// ── 2026-09-07 Web 子集: 附件标签 + 文档/数据路径不是形状 ③ ────────────────────
// 现场: workbuddy Web 64/70 题在点火前被拒, instruction 形如「- `game_design_brief`: `/workspace/…/game-design-brief.md`」。
// 证伪: 去掉 checkCoords 里 `isDocOrDataPath || isLabelOfFile` 那一跳 ⇒ 下面两条红。
describe('形状 ③ 对文档/数据文件与文件标签不适用', () => {
  test('★ 附件标签 + .md 路径同句 ⇒ 不报', () => {
    const text = '- `game_design_brief`: `public-assets/brief/game-design-brief.md` text/markdown';
    expect(checkCoords(text, { root: '/repo', readFile: read })).toEqual([]);
  });
  test('★ 任意标识符 + .json 路径同句 ⇒ 不报 (JSON 键不以标识符原文出现)', () => {
    const text = 'read `board_state` from `public-assets/data/tasks.json`';
    expect(checkCoords(text, { root: '/repo', readFile: read })).toEqual([]);
  });
  test('源码文件上真阳性照报 (豁免没有扩到 .ts)', () => {
    const text = 'call `madeUpSymbol` in `src/exists.ts`';
    const f = findBy(checkCoords(text, { root: '/repo', readFile: read }), (x) => x.criterion === 'identifier-not-in-file');
    expect(f?.identifier).toBe('madeUpSymbol');
  });
});
