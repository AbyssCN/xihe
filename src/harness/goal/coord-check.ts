/**
 * src/harness/goal/coord-check —— 派工文本坐标机械校验 (W2-241 · 票 #241)。
 *
 * 病根 (实账 run 0f67293b): task 写「`saveVerdictReasonFull` 在 `checkpoint-manager.ts:312`」,
 * 符号是编的 (真名 `saveReasonFull`), 执行体照抄进 `rg -e ...`, 无匹配退 1, `&&` 链首败,
 * 下游 7 节点全 skipped, 一整跑白烧。文件路径 / file:line / 符号名今天零机械校验 —— 本模块
 * 把这三条做成「反引号 → 形状 → 验证」的纯逻辑闸。
 *
 * ## INV-W241-1 · 三形状白名单
 *
 * 只验**可机械证伪**的三种反引号形状 (白名单制, #265 那 8/8 误报教训在先):
 *   ① **`path:line`** → path 存在 (同句有「新建」则跳过) 且 line ≤ 文件行数;
 *   ② **裸路径** (含 `/` + 已知源码扩展名) → 存在或同句「新建」;
 *   ③ **同句共现的「反引号标识符 (`^[A-Za-z_$][A-Za-z0-9_$]{2,}$`) + 反引号路径 (±行号) 」**
 *      → 标识符在该文件 grep -F 必须命中 (命中行号偏差不管 —— 治的是「编造」, 不是「过时」)。
 *
 * 其余反引号内容 (散文碎片 / 表格单元 / 标点 / 单字符 / 多字符非标识符) 一律**不验**:
 * `#265` 那 8 条 (「、」· ` 新建:` · 测试读数 · 表格单元碎片) 全在这一层被自然放过,
 * 这正是本单不动 L3、另起炉灶的核心理由 —— 两处方向相反 (事后简报核对 vs 事前派工核对),
 * 判据合流留后续票 (#241 末尾)。
 *
 * ## INV-W241-2 · 接线位
 *
 * **不进 `dryRunSddIgnition` 本体** (那是零 IO 纯函数, INV-D3-5; 本检查要读盘, 同样
 * `parseBreakdown` / `compileBreakdown` 也不收此跳)。校验在 `goal.ts` 的
 * `sddIgnitionDryRunGate` 旁与 detached 接线点 (切片 2); 本单只交付**纯逻辑 + 注入接缝**。
 *
 * ## 零 IO 接口
 *
 * `readFile` 走注入式: 测试传 `Record<string,string>` 替身, 生产端由 `goal.ts` 传
 * `(abs) => existsSync(abs) ? readFileSync(abs,'utf8') : null`。**无默认值式读盘**:
 * 一旦函数被无意中调到「生产端没传 readFile」也立刻空集合返, 不会读真盘 (INV-W241-4 零
 * 涟漪: 不传 root = 跳过, 行为逐字节照旧)。
 *
 * @module
 */
import { gateAllowReason } from '../gates/gate-allow';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../logger';

// ── 词法常量 ──────────────────────────────────────────────────────────────────

/**
 * 已知源码扩展名 (与 `ignition-criteria-check.PATH_TOKEN_REGEX` 同源: 本仓生产实践里只
 * 见这五种, 多收 = 误报面; 少收 = 漏掉 `tsconfig.json` / `package.json` 这类真引用)。
 */
const SOURCE_EXT = '(?:ts|tsx|js|json|md)';

/**
 * 标识符形态 (INV-W241-1 ③): JS/TS 标识符规则, 长度 ≥ 3, 首字符不允许数字。
 *
 * 整词匹配, 必须从第一个字符开始 — 这是「标点 / 空格 / 顿号 / 「、」」一关被自然过滤掉的
 * 关键: ` 新建:` (有空格) · `、` (单字符) · `26 + 30` (数字起) 全不命中。
 */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{2,}$/;
/** 形状 ③ 不适用的文件: 文档 / 数据 (标识符不会以原文出现在里面, 见 checkCoords 内注)。 */
const isDocOrDataPath = (path: string): boolean => /\.(?:md|json)$/i.test(path);
/** `game_design_brief` ↔ `game-design-brief.md`: 标签归一后等于文件名 ⇒ 是文件的别名, 不是符号。 */
const isLabelOfFile = (ident: string, path: string): boolean => {
  const norm = (s: string): string => s.toLowerCase().replace(/[_-]/g, '');
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.[A-Za-z0-9]+$/, '');
  return norm(ident) === norm(base);
};

/**
 * `path:line` 形状: 路径 + `:` + 行号。**整词匹配** (`$`), 避免 `path:5-10` 这种范围引用
 * 被当 path:line — 范围引用今天零判据, 落到「不验」那堆。
 */
const PATH_LINE_RE = new RegExp(`^(?<path>[A-Za-z0-9_./-]+\\.${SOURCE_EXT}):(?<line>\\d+)$`);

/**
 * 裸路径形状 (INV-W241-1 ②): 含 `/` **且** 以已知源码扩展名结尾。
 *
 * 这里**不**判 `/` —— 调用点用 `includes('/')` 把 `tsconfig.json` 这类仓根文件挡掉
 * (它的语义是 L1 的「无行号裸路径提及」, #145 那条「无行号路径提及是纯误报」已收敛)。
 */
const BARE_PATH_RE = new RegExp(`^(?<path>[A-Za-z0-9_./-]+\\.${SOURCE_EXT})$`);

// ── 冻结接口 ──────────────────────────────────────────────────────────────────

export type CoordCriterion =
  | 'path-line-missing' // ① path:line 但文件不在仓内
  | 'path-line-oob' // ① path:line 但行号越界
  | 'path-missing' // ② 裸路径但文件不在仓内
  | 'identifier-not-in-file'; // ③ 同句标识符不在路径指向的文件里

export interface CoordFinding {
  /** 触发该 finding 的反引号原文 (含两侧反引号的全文)。便于回执里逐字指认。 */
  raw: string;
  /** 哪条形状没满足 (便于回执里点名判据)。 */
  criterion: CoordCriterion;
  /** 缺在哪: shape ①② = 路径; shape ③ = 路径 (符号另有 identifier 字段)。 */
  where: string;
  /** shape ① 时携带, ②③ 无。 */
  line?: number;
  /** shape ③ 时携带, ①② 无 — 编造出来的符号名。 */
  identifier?: string;
  /** 人话, 给下游 leaf / 重规划轮直接消费 (含原文 · 判据 · 缺在哪)。 */
  message: string;
}

export interface CoordCheckOpts {
  /**
   * 仓根绝对路径。path-shape 反引号都按相对此根解析。
   * 传空串 = 整段文本零三形状命中 → 返 `[]` (INV-W241-4 零涟漪)。
   */
  root: string;
  /**
   * 注入式读文件 (测试用 stub)。返 `null` = 读不到 (不存在 / 权限 / IO 错)。**无默认值**:
   * 不传就当生产端接线缺席, 走内置 `defaultRead`, 行为与既有 `claim-anchor.ts:81` 同源。
   */
  readFile?: (absPath: string) => string | null;
}

const defaultRead = (p: string): string | null => {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  } catch (e) {
    // 读不到按「文件不可及」处理 (调用方判 path-missing 类) —— 但证据要留 (§静默坑 2):
    // exists 过了 read 却抛 = 竞态/权限/IO, 吞掉就再也分不清「真缺席」与「读挂了」。
    logger.warn({ path: p, err: String(e) }, '[coord-check] 读文件失败 → 按不可及处理');
    return null;
  }
};

// ── 内部结构 ──────────────────────────────────────────────────────────────────

/**
 * 一个反引号 span 的最小信息。行号是「新行计数」1-based, 与 `line <= file.split('\n').length`
 * 直接可比。
 */
interface BacktickToken {
  /** 1-based 行号。 */
  line: number;
  /** 反引号内的文本 (不含两侧反引号, 不含跨行 —— 见下)。 */
  content: string;
}

/**
 * 单字符状态机提反引号 span: 单反引号开/闭, 遇到 `\n` 就把「开了没收住」的 span 静默吞掉
 * (markdown 里反引号跨行会被渲染器吃掉, 我们也不该把它当合法 span)。
 *
 * **不做嵌套**: `` `a `b` c` `` 是两个 span (`a `, ` c`) + 一个未闭合。markdown 也没真
 * 嵌套语义, 与既有 `claim-anchor.ts:71` 同款口径。
 */
function extractBackticks(text: string): BacktickToken[] {
  const out: BacktickToken[] = [];
  let inBT = false;
  let line = 1;
  let startLine = 0;
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') {
      line++;
      if (inBT) {
        // 跨行反引号 → 静默吞, 不入验证集
        inBT = false;
        buf = '';
      }
      continue;
    }
    if (ch === '`') {
      if (!inBT) {
        inBT = true;
        startLine = line;
        buf = '';
      } else {
        inBT = false;
        if (buf.length > 0) out.push({ line: startLine, content: buf });
        buf = '';
      }
      continue;
    }
    if (inBT) buf += ch;
  }
  return out;
}

/**
 * 行 N 的全文 (1-based)。给「同句有「新建」则跳过」豁免做原文级判定: 不只 backtick 内, 行内
 * 任何位置出现「新建」都算 —— markdown 表格单元里 `(新建)` 这种括号注释常见, 只看 backtick
 * 会漏判。
 */
function lineText(text: string, lineNo: number): string {
  const lines = text.split('\n');
  return lines[lineNo - 1] ?? '';
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 判一段文本里的三形状坐标, 收集全部 findings (D-3 同款: 全部收集再判 verdict, 不挤牙膏)。
 *
 * @param text 派工文本 (SDD 全文 / solve 的 goal 文本, 调用方负责拼好)。
 * @param opts 仓根 + 可选 readFile 注入。
 * @returns    找到的全部违规;**判不了的一律不返** (散文碎片 / 表格单元 / 标点 / 长度 < 3)。
 *
 * ## 单变量反例 (反向自检)
 *  ① 把 `IDENT_RE` 的 `^[A-Za-z_$]...` 删掉 → ` 新建:` · `26 + 30` 全成标识符, 误报炸开;
 *  ② 把 `BARE_PATH_RE` 的 `+` 改 `?` → 单字符 `a` 也成「路径」, 全炸;
 *  ③ 把 `lineText` 那条豁免删掉 → `\`x.ts\` (新建)` 被误判 path-missing (本片未干);
 *  ④ 把 `extractBackticks` 的「跨行吞」删掉 → 围栏里的整张表当一行 spans 跑, 误报炸。
 */
/**
 * 这一行对 coord-check 豁免吗。
 *
 * 两个出口:
 *   - `新建` —— 既有约定: 「这个路径将要新建」, 盘上不在是正常的。
 *   - `gate-allow(coord-check): <理由>` —— 引用语境: 这一行在**说明**某个坐标/符号,
 *     而不是在用它。本闸只看字面, 不加这条就只能靠改述绕开, 反面教材随之磨掉。
 */
function isCoordExempt(line: string): boolean {
  return line.includes('新建') || gateAllowReason(line, 'coord-check') !== null;
}

export function checkCoords(text: string, opts: CoordCheckOpts): CoordFinding[] {
  const read = opts.readFile ?? defaultRead;
  const tokens = extractBackticks(text);
  const findings: CoordFinding[] = [];
  const seen = new Set<string>();

  // 按 token 走: 每个 token 走完三形状 (①② 互斥 —— 一个 token 只可能落其一)。
  for (const tok of tokens) {
    // ── 形状 ① `path:line` ───────────────────────────────────────────────────
    const m1 = PATH_LINE_RE.exec(tok.content);
    if (m1) {
      const path = m1.groups!.path!;
      const lineNo = Number(m1.groups!.line);
      const key = `path-line:${path}:${lineNo}`;
      if (!seen.has(key) && !isCoordExempt(lineText(text, tok.line))) {
        seen.add(key);
        const content = read(resolve(opts.root, path));
        if (content === null) {
          findings.push({
            raw: tok.content,
            criterion: 'path-line-missing',
            where: path,
            line: lineNo,
            message:
              `反引号 \`${tok.content}\` 指了 \`${path}\`, 但该文件在 \`${opts.root}\` 下读不到 —— ` +
              '编造的路径在点火时该死, 不该溜进 `rg -e ...`。',
          });
        } else {
          const lineCount = content.split('\n').length;
          if (lineNo > lineCount) {
            findings.push({
              raw: tok.content,
              criterion: 'path-line-oob',
              where: path,
              line: lineNo,
              message:
                `反引号 \`${tok.content}\` 指到 \`${path}\` 第 ${lineNo} 行, 而该文件只有 ${lineCount} 行 —— ` +
                '行号在文件之外, 执行体照抄进命令必败。',
            });
          }
        }
      }
      // path:line 形状已处理, 不进 ②③
      continue;
    }

    // ── 形状 ② 裸路径 (含 `/` + 已知扩展名) ───────────────────────────────
    const m2 = BARE_PATH_RE.exec(tok.content);
    if (m2 && tok.content.includes('/')) {
      const path = m2.groups!.path!;
      const key = `path:${path}`;
      if (!seen.has(key) && !isCoordExempt(lineText(text, tok.line))) {
        seen.add(key);
        const content = read(resolve(opts.root, path));
        if (content === null) {
          findings.push({
            raw: tok.content,
            criterion: 'path-missing',
            where: path,
            message:
              `反引号 \`${tok.content}\` 是仓内路径形态, 但盘上不在 —— ` +
              '若是「将要新建」, 同行加「新建」豁免; 否则该路径是编的。',
          });
        }
      }
      continue;
    }

    // ── 形状 ③ 同句「反引号标识符 + 反引号路径」 → grep -F 命中校验 ──────
    if (IDENT_RE.test(tok.content)) {
      // 同行的「另一份」span 里找 path 形状 (±行号); 一对 (id, path) 只产一条 finding。
      for (const other of tokens) {
        if (other.line !== tok.line || other === tok) continue;
        const om1 = PATH_LINE_RE.exec(other.content);
        const om2 = BARE_PATH_RE.exec(other.content);
        let path: string | null = null;
        if (om1) path = om1.groups!.path!;
        else if (om2 && other.content.includes('/')) path = om2.groups!.path!;
        if (path === null) continue;
        // 形状 ③ 只对**代码文件**成立 (2026-09-07, workbuddy Web 子集 64/70 题点火被拒的根因):
        // instruction 把附件写成「`game_design_brief`: `/workspace/…/game-design-brief.md`」——
        // 标签 + 文档路径同句共现, 而「标识符必须在文件里 grep 命中」只对源码有意义, 对 .md/.json
        // 这类文档/数据文件不是可证伪判据 (附件标签、JSON 键都不会以标识符原文出现)。
        // 另一层: 标签归一后 (下划线→连字符, 去扩展名) 等于文件名, 那就是「给这个文件起的名」, 不是符号。
        // 证伪: 去掉这两跳 ⇒ coord-check.test.ts「附件标签 + 文档路径不报」红。
        if (isDocOrDataPath(path) || isLabelOfFile(tok.content, path)) continue;
        const content = read(resolve(opts.root, path));
        // 路径本身不存在 → 由形状 ①② 那边报, 这里跳过避免「两条 finding 同句」
        if (content === null) continue;
        if (content.includes(tok.content)) continue;
        // 引用语境豁免 (2026-08-26): 同行带 `gate-allow(coord-check): <理由>` 即放行。
        // 本闸按「同句符号 × 坐标」笛卡尔配对, 说明「某个符号是编造的 / 已被删掉」这类
        // 更正句必然把它写出来 —— 五次实撞里有三次是这个形态。
        if (isCoordExempt(lineText(text, tok.line))) continue;
        const key = `id:${path}:${tok.content}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          raw: tok.content,
          criterion: 'identifier-not-in-file',
          where: path,
          identifier: tok.content,
          message:
            `反引号 \`${tok.content}\` 与 \`${other.content}\` 同句共现, 但 \`${tok.content}\` ` +
            `在 \`${path}\` 里 grep -F 无命中 —— 编造的符号名在执行体照抄进 \`rg -e ...\` 时必败 ` +
            '(真账 run 0f67293b 同款病灶)。',
        });
      }
    }
  }

  return findings;
}