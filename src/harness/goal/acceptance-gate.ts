/**
 * goal/acceptance-gate —— **判据自证**:一条验收命令自己得先过闸(2026-08-07 从 `acceptance.ts` 拆出)。
 *
 * ## 为什么与"分型"分家
 *
 * 原来的 `acceptance.ts` 里塞着两件事:**这个目标该用哪种验收**(分型)与**这条判据本身立不立得住**
 * (自证)。`acceptance` 这个词因此什么都指不准 —— 它同时是"验收标准""验收分型""判据的自证"。
 * 拆开之后依赖是**单向的**:分型 → 本文件;本文件不认识分型。
 *
 * ## 它拦的两类
 *
 * D-I 把判卷标准冻在环外, 防的是**执行体移动球门**。本文件防的是另一半 —— **球门生下来就是虚的**:
 *
 * 1. **空世界自检**({@link acceptanceVacuityReason})—— 活还没干之前跑一遍,**这时候就过 = 它跟这次要做的事无关**。
 * 2. **判别力探针**({@link acceptanceDiscriminationReason})—— 拿分类器给的一份**明显错**的产物跑一遍,
 *    **照样通过 = 对的答案和错的答案都满足它**。
 *
 * 两道都是 **fail-open**:跑不起来就不拦。它们是加固,不是前置条件。
 *
 * ⚠ 诚实边界:确定性检查够不到"断言的词是不是执行体自己能选的"那一类,那一半走 prompt(在 `classify-acceptance.ts`)。
 * **两层各管一半,谁也别声称管全了。**
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  DEFAULT_COMMAND_ALLOWLIST,
  allowlistForRoot,
  commandBlockReason,
  createCommandLeafRunner,
  languageConsistencyBlockReason,
  missingBinaryBlockReason,
} from '../command-leaf';
import { logger } from '../logger';
import { languageConsistencyFromFacts } from '../env-facts';
import { ensureNodeModulesLink } from '../run-worktree';

/**
 * 分类器给的**反面样本**:一份**明显错**的产物长什么样(G4, 2026-07-31)。
 *
 * 只在开跑前的判别力探针({@link acceptanceDiscriminationReason})里用,**不进冻结文本** ——
 * 它是拿来验判据的,不是拿给执行体看的(给了就等于告诉它"照这个的反面写"就能过闸)。
 */
export interface NegativeSample {
  /** 相对路径(探针在临时目录里按它写文件;绝对路径 / `..` 一律拒)。 */
  path: string;
  /** 两三行就够 —— 探针只问"这条命令会不会被它满足"。 */
  content: string;
}

/**
 * 探针裁决 —— 判执行型时两道探针 (空世界自检 / 反面样本) 的结果, 原样落进这一格。
 * 缺席 = 没探 / 没记录; `'unknown'` 永不写入。`why` 一律**原样带走**, 不再措辞。
 *
 * 五终局 (冻结契约):
 * - `passed-both`  —— 空世界自检与判别力探针都真跑且都过, 执行型原样收下。
 *   `why` (#204): **零判别力的判据段**清单 —— 整条分得出, 但其中某几段在反面世界里照样过。
 *   收下不代表每一段都在证事; 缺席 = 没有弱段 (或没跑逐段判)。
 * - `vacuity-only` —— 执行型经 fail-open 路径收下 (没给 runner / 探针跑不起来 / 没样本):
 *   只过了空世界一道闸 (或一道都没真跑)。判别探针的原话进 `why`; 没有就省略。
 * - `demoted`      —— 执行型被闸拒 / 探针判虚 → 降级探索型, 原话进 `why`。
 * - `skipped`      —— 分类调用/解析失败 → 全保守档 (complex + 探索型), 失败原文进 `why`。
 * - `exploratory`  —— 模型自己选的探索型 (无探针、无降级)。
 */
export type AcceptanceProbe =
  | { kind: 'passed-both'; why?: string }
  /**
   * #205 (2026-09-04): 两道都跑了、反面世界里也确实红了, **但红的理由是判据点名的文件在那边
   * 不存在**, 不是断言不成立 —— 判别力未被证明。
   *
   * **与 `passed-both` 分开是这一格存在的全部理由**: 合并进去就是把「证明过」与「没证明过」
   * 记成同一件事, 而 code80-p5 的「绿的那边有 reward 0.0」正是从这条缝漏出去的
   * (68 题里 67 题我们的判据文件与 bench 隐藏测试文件零交集)。
   * fail-open: 本版**不降级**, 只让它可数。
   */
  | { kind: 'unproven-missing'; why: string; missing: readonly string[] }
  | { kind: 'vacuity-only'; why?: string }
  | { kind: 'demoted'; why: string }
  | { kind: 'skipped'; why: string }
  | { kind: 'exploratory' };

/**
 * acceptance 闸的 root-aware 选项 (片 2, D-3, 2026-08-26)。
 *
 * 给 `root` → 启用 per-root 包 + 语言一致闸 (与运行期 `commandBlockReason` 走的
 * `allowlistForRoot` / `languageConsistencyBlockReason` 同一份); 不给 → 与改前字节相同
 * (既有单参调用零改动即绿, INV-6)。
 *
 * 设计要点:
 *  · **不挂到运行期 `commandBlockReason`** (单源纪律, 不抄第二份闸; 见 D-2 / command-leaf.ts
 *    18-20 行的诚实边界说明) —— 这里只是组装「per-root 词表 + 一致闸」给分类期用。
 *  · 语言一致闸**先**于 allowlist 闸: 一致闸的拒因更具体 (含所需 marker 名 + 实检出 marker),
 *    而 allowlist 闸对「证据与词不一致」这条病说不出那么细 —— 直接放行 js 仓的 `pytest` 不行,
 *    但拒因若只剩 `'pytest' ∉ allowlist` 就丢了"为什么"那条链。
 *  · 空字符串 root 视为无 root (fail-open) —— 区分"未给"和"显式给空"在 TS 里要再加一个 union,
 *    而那个 union 没有任何真消费者。
 */
export interface AcceptanceCommandBlockOpts {
  /** 仓根 —— 给则 per-root 白名单 + 语言一致闸; 缺省 = 今天行为 (byte-compatible)。 */
  root?: string;
  /**
   * PATH 探测用的环境 (2026-08-29)。缺省 = `process.env` —— 必须与 `createCommandLeafRunner`
   * spawn 时看到的那一份同源。**只为可测性存在**: 「这台机器装没装 pytest」不注入就写不出
   * 确定性测试, 而不确定的测试正是本仓 §加尺子那条要避的 (量的会变成尺子)。
   */
  env?: Record<string, string | undefined>;
  /**
   * 仓环境真探测结果 (2026-08-29)。给了则白名单 = base ∪ **实测启用**的语言 bin,
   * 语言一致闸也改问它 —— 而不是只问"根下有没有那个打包文件"。
   *
   * 为什么必须能走这条: 实测 80 个真实 python 仓, marker 表 (含补的 4 个) 只认出 50 个,
   * 真探测认出 79 个。差的那 29 个根下什么打包文件都没有, 只有 `.py` 和 `tests/` ——
   * 表填不到它们, 于是引擎对模型说"这仓没测试基建", 然后照着这句谎话规划。
   *
   * 缺省 = 不给 → 逐字退回 marker 表那条路 (既有调用零改动即绿)。
   */
  envFacts?: import('../env-facts').EnvFacts;
  /**
   * **计划声明的产物集** (2026-08-29, INV-6 第四道)。判据命令里指向"还不存在的路径"的 token,
   * 只要它在这个集合里 (将由某个节点产出) 就放行。
   *
   * ⚠ **缺席 ≠ 空集** (本仓坑①: NULL ≠ 0 ≠ 不适用): 不给 = 拿不到"谁会产出什么"这份事实,
   * 于是「不在产物集里」这个条件**判不了** → 整道门不跑 (既有调用零改动即绿)。
   * 给 `[]` = 显式声明"这次没有任何节点产出新文件", 那时不存在的路径就是恒红判据。
   */
  declaredArtifacts?: readonly string[] | ReadonlySet<string>;
}

/**
 * 判据命令里的**路径参数**形状 (2026-08-29, INV-6)。只认这一套字符 —— 引号、`=`、`:`、`*`、`?`、
 * `$`、`~` 等一律出局, 于是 URL / glob / grep pattern / `--cov=x` 全部自动落在门外。
 * 这不是"识别路径的正确办法", 是**最保守的那个**: 认漏一堆真路径, 但几乎不会把非路径认成路径。
 */
const PATH_ARG_SHAPE = /^[A-Za-z0-9_./-]+$/;

/** "带扩展名就够像路径了"的那一档 —— 源码/测试文件。文档与数据 (.md/.json/.txt) 刻意不在表内:
 * 它们常常正是**本次要产出**的东西, 而产物集未必列全, 拦下去就是误拦。含 `/` 的 token 另有一条路。 */
const SOURCE_LIKE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|kt|swift|scala|c|h|cc|cpp|hpp|sh|sql)$/i;

/**
 * 这个 token 值不值得判"存不存在"。看不准一律 false —— 门的家族纪律是只拒恒红判据。
 *
 * 三条就够, 不是三条最全。第一版还写了「纯数字跳过 / 绝对路径跳过 / 含 `..` 跳过」,
 * 逐条拿掉跑测试**一条都不会红** —— 前者被下面的 path-like 那行盖住 (纯数字既无 `/` 也无源码
 * 扩展名), 后两者被调用处的「解析后仍在 root 内」那行盖住。三条留着就是三条永远绿的闸。
 */
function looksLikePathArg(token: string): boolean {
  // flag 先跳: `-Isrc/include` 这种**粘着路径**的 flag 形状上完全像路径, 只有这一行拦得住
  // (实测: 拿掉它, 「flag 跳过」那条用例当场红)。
  if (!token || token.startsWith('-')) return false;
  // 引号 / glob (`*` `?`) / URL (`:`) / `--cov=x` (`=`) / 任何 shell 元字符 —— 全不在字符集里。
  if (!PATH_ARG_SHAPE.test(token)) return false;
  // 不像路径就不判: 子命令 (`test` / `run`)、断言词、纯数字 (超时值 / 端口) 全落在这里。
  return token.includes('/') || SOURCE_LIKE_EXT.test(token);
}

/**
 * **判据里的路径参数在仓里真的存在吗** (2026-08-29, INV-6 / GWT-6, 契约
 * `docs/plan/2026-08-29-veto-feedback-revision-edges.md` D-6)。
 *
 * ## 它补的是判据自证的第三个盲区
 *
 * 前三道各问一件事: 空世界自检问「它会不会误绿」, 判别力探针问「错答案骗不骗得过它」,
 * missing-bin 问「这台机器上有没有这个命令」。**没有一道问「它指的那个文件在不在」** ——
 * 而路径写错的判据与 bin 缺席的判据是同一种病: **恒红**, 活干对了也过不了。
 *
 * ## 为什么是它而不是昨天那道
 *
 * 昨天加的 bin-in-PATH 闸打偏了: 12 例 executable 真红逐例归因里**无一例**是 bin 缺失,
 * 而 A 桶 5 例红在路径参数上 —— 判据命令指向仓里根本不存在的测试文件或错目录:
 *   · `pytest -q tests/test_tz.py`, 真身在 `dateutil/test/` 下
 *   · `grep -q "ERROR_REASONS" tokens.py`, 真身在 `itsdangerous_like/tokens.py`
 * leaf 多数把活干对了, 判据却没人能改, 只能烧满修复轮挂掉。
 *
 * ## 保守判定: 宁放勿误拦
 *
 * 只拒「明确像文件路径 + 解析后仍在 root 内 + 确定不存在 + 没被声明产出」四条全中的 token。
 * 模糊一律放行 (见 {@link looksLikePathArg} 与下面的 root 外跳过) —— 误拦一条好判据会把整个 run
 * 停在冻结前, 而漏掉一条坏判据后面还有修复轮。这道门的强度上限也因此不高, 它是筛子不是证明。
 *
 * ## 边界
 *
 * · **每一环的首词不判** —— 那是 bin, 归 `missingBinaryBlockReason` 管 (单源纪律, 不抄第二份)。
 * · `&&` 链逐环判 (与 `commandBlockReason` 同款: 全链先过闸)。
 * · root 为空 → 不判 (fail-open): 没有仓根就没有"解析到 root 内"这回事。
 * · 判的是**存在性**, 不判"内容对不对" —— 后者正是判据该回答的问题, 这里不抢。
 *
 * @param declaredArtifacts 计划声明的产物集 —— 在集内 = 将由某节点产出, 现在不存在是正常的。
 *   调用方拿不到这份事实时**别调本函数** (缺席 ≠ 空集, 见 {@link AcceptanceCommandBlockOpts.declaredArtifacts})。
 * @returns null = 没有恒红的路径参数; 否则一行拒因 (含「路径参数不存在」)。
 */
export function missingPathArgBlockReason(
  command: string,
  root: string,
  declaredArtifacts: readonly string[] | ReadonlySet<string>,
): string | null {
  if (!root) return null;
  // 产物集两侧都归一到「相对 root 的路径」再比 —— 计划里写 `./x.ts` / 绝对路径 / `x.ts` 是同一个东西,
  // 而字面比会把它们读成三个, 于是声明了也照拒 (那就是一次误拦)。
  const declared = new Set<string>();
  for (const a of declaredArtifacts) {
    const t = a.trim();
    if (!t) continue;
    declared.add(t);
    declared.add(relative(root, resolve(root, t)));
  }
  for (const link of command.split('&&').map((s) => s.trim())) {
    // slice(1): 首词是 bin。
    for (const token of link.split(/\s+/).slice(1)) {
      if (!looksLikePathArg(token)) continue;
      const abs = resolve(root, token);
      const rel = relative(root, abs);
      // 解析后跑出 root (或就是 root 自己) → 不判。前者管不着, 后者恒存在。
      // **绝对路径与含 `..` 的 token 也是在这一行落地的** —— 它们 resolve 完必然落在 root 外,
      // 不需要在 looksLikePathArg 里另写两条 (写了就是两条永远绿的闸)。
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      if (existsSync(abs)) continue;
      if (declared.has(rel) || declared.has(token)) continue;
      return (
        `[blocked missing-path-arg: 验收命令里的路径参数不存在 —— '${token}' 在仓根 ${root} 下找不到, ` +
        `也不在计划声明的产物集里 (没有节点会产出它)。这条判据恒红, 活干对了也过不了。` +
        `先在仓里核实真身在哪 (常见成因: 测试文件在别的目录下), 换成真实路径; ` +
        `或让某个节点显式声明产出这个文件。]`
      );
    }
  }
  return null;
}

/**
 * 1-A (2026-09-03): 判据命令里**现在还不存在**的路径参数 (相对 root, 去重保序)。
 * 形状判定与 root 内判定跟 {@link missingPathArgBlockReason} 同一套 (looksLikePathArg / 解析后仍在 root 内),
 * 但它**不拒**: 它回答的是「判据在等谁产出」—— 编排循环用它冻结判据文件 (这些文件一旦被写出就冻结,
 * hash 记账, 之后任何派发改它们都会被工具闸拒; 先勘察还是先写判据由 conductor 定)。
 * root 为空 → [] (没有仓根就没有"存不存在"这回事)。
 */
export function missingPathArgs(command: string, root: string): string[] {
  if (!root) return [];
  const out: string[] = [];
  for (const link of command.split('&&').map((s) => s.trim())) {
    for (const token of link.split(/\s+/).slice(1)) {
      if (!looksLikePathArg(token)) continue;
      const abs = resolve(root, token);
      const rel = relative(root, abs);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      if (existsSync(abs)) continue;
      const norm = rel.split('\\').join('/');
      if (!out.includes(norm)) out.push(norm);
    }
  }
  return out;
}

/**
 * 一条验收命令是否**真跑得起来** = 过 command-leaf 的 fail-closed 闸 (白名单 / 元字符 / git 只读 /
 * 危险命令)。判据借的是执行期那一份 (`commandBlockReason`), 不是这里另抄一份 —— 抄一份早晚先漂,
 * 而漂的后果恰是「假红」。
 *
 * 给了 `opts.root` → 闸走 `allowlistForRoot(root)` + 语言一致闸 (`D-2`)。Python 仓写 `bun test`
 * 在此拒, JS 仓写 `pytest` 在此拒; 证据与词一致 → null。给空 / 不给 → 与改前逐字相同 (INV-6)。
 *
 * @returns null = 可跑; 否则一行拒因。
 */
export function acceptanceCommandBlockReason(command: string, opts: AcceptanceCommandBlockOpts = {}): string | null {
  const c = command.trim();
  if (!c) return '[blocked empty: 验收命令为空]';
  const root = opts.root;
  if (!root) return commandBlockReason(c, DEFAULT_COMMAND_ALLOWLIST);
  // 给了真探测结果 → 三道全走, 只是**语言一致那道换了证据源**: 从"根下有没有那个打包文件"
  // 换成"实测哪门语言启用"。marker 版会把「有 137 个 .py 但没有 pyproject.toml」的仓判成
  // 没有 python —— 那正是这次要修的病。
  //
  // ⚠ 第一版在这里**把语言一致整道省掉**了, 被既有测试当场抓住: python 仓写 `bun test` 一路放行,
  // 因为 `bun` 本来就在 base 白名单里, allowlist 那道拦不住它。换证据可以, 拿掉不行。
  if (opts.envFacts) {
    // 顺序与 marker 版同款: 语言一致先 (拒因信息量大), allowlist 后, bin 可达性最后。
    const langBlock = languageConsistencyFromFacts(c, opts.envFacts);
    if (langBlock) return langBlock;
    const allow = [...DEFAULT_COMMAND_ALLOWLIST, ...opts.envFacts.enabledBins.filter((b) => !DEFAULT_COMMAND_ALLOWLIST.includes(b))];
    const blocked = commandBlockReason(c, allow);
    if (blocked) return blocked;
    const missingBin = opts.env ? missingBinaryBlockReason(c, opts.env) : missingBinaryBlockReason(c);
    if (missingBin) return missingBin;
    return pathArgBlock(c, root, opts);
  }
  // 顺序: 语言一致闸先, allowlist 闸后。一致闸拒因带「所需 marker」, 信息量大于 allowlist 的
  // `'pytest' ∉ allowlist` —— 后者也能拒, 但纠错环读到 "lang-mismatch" 才知道要去补 marker。
  const langBlock = languageConsistencyBlockReason(c, root);
  if (langBlock) return langBlock;
  const allowBlock = commandBlockReason(c, allowlistForRoot(root));
  if (allowBlock) return allowBlock;
  // 第三道: bin 在不在 PATH 上 (2026-08-29)。**只挂 root-aware 这条路** —— 无 root 那支是纯语法闸
  // (INV-6 逐字兼容), 而"装没装这个命令"是环境事实, 属于 root-aware 这一层。
  // 顺序放它俩之后: 前两道的拒因信息量更大 (缺哪个 marker / 不在白名单), 别被"找不到 bin"盖掉。
  const missingBin = opts.env ? missingBinaryBlockReason(c, opts.env) : missingBinaryBlockReason(c);
  if (missingBin) return missingBin;
  return pathArgBlock(c, root, opts);
}

/**
 * 第四道 (INV-6): 路径参数自证。同样只挂 root-aware 这条路 —— "文件在不在仓里"是仓事实, 无 root 判不了。
 *
 * 排在 missing-bin 之后: bin 缺席比路径写错更根上 (连命令都起不来时先说那个)。
 * **拿不到产物集就整道不跑** —— 见 {@link AcceptanceCommandBlockOpts.declaredArtifacts} 的 NULL ≠ 空集。
 */
function pathArgBlock(c: string, root: string, opts: AcceptanceCommandBlockOpts): string | null {
  return opts.declaredArtifacts === undefined ? null : missingPathArgBlockReason(c, root, opts.declaredArtifacts);
}

/** 便捷谓词。 */
export const isRunnableAcceptanceCommand = (command: string): boolean =>
  acceptanceCommandBlockReason(command) === null;

/** 探针裁决的 why 原文 (与对应 logger 行逐字相同 —— 冻结文本, 不再措辞)。 */
const VACUITY_CANT_RUN = '[omd/goal] 空世界自检跑不起来 → 不拦 (fail-open)';
const SAMPLE_PATH_BAD = '[omd/goal] 反面样本路径不合法 → 跳过判别力探针 (fail-open)';
const DISCRIM_CANT_RUN = '[omd/goal] 判别力探针跑不起来 → 不拦 (fail-open)';
/**
 * 上面那句原本**同时**盖住两件事:命令被闸拒(负码)与探针自己炸了(catch)。
 * 两者的下一步完全不同(前者去看白名单,后者是运行时缺陷该重跑),压成一个标签就再也分不开
 * —— 本仓坑①(`NULL` ≠ 0 ≠ 不适用)的同一形状。2026-08-14 晚拆开。
 *
 * ⚠ **catch 那条把错误原文带进 `why`**,不是只留在 logger 的字段里:那次真实事故
 * (26 次全量里 1 次,`v4-5.log`)现场就只剩一句光秃秃的 msg —— 日志格式把 binding 全丢了,
 * 只能靠"绿的日志各 1 条、红的那份 2 条"这种计数才认出来。
 * **留了证据不等于证据看得见**(本仓 §3 的第二层)。
 */
const DISCRIM_BLOCKED = '[omd/goal] 判别力探针的命令被闸拒 → 不拦 (fail-open, 那件事由命令闸管)';
export const NO_NEGATIVE_SAMPLE = '[omd/goal] 分类器没给反面样本 → 判别力探针跳过 (这条判据只过了空世界自检)';

/**
 * **空世界自检** (2026-07-31, G4 反面用例的可实现版)。
 *
 * ## 它要杀的是什么
 *
 * D-I 把判卷标准冻在环外, 防的是**执行体移动球门**。2026-07-31 live 抓到它防不住的另一半:
 * **球门生下来就是虚的**。那次冻结的命令是 `grep -q "相同" docs/from-api.md` —— 而它匹配得上
 * 「不相同」, 对的答案和错的答案都满足。命令跑了、退出码 0、G4 那格看上去是绿的, 而它什么都没验。
 *
 * **虚判据比没判据坏**: 没判据时任务文本会明说"本目标没有机器判据, 别伪造一个", judge 因此
 * 会去看别的证据; 有个虚的则让整条链**看起来已被验证**。
 *
 * ## 判据: 活还没干之前, 它就该是红的
 *
 * 一条真在判事的验收命令, 必须能区分"做完了"与"还没做"。所以在**执行之前**跑一遍它:
 * **这时候就过 = 它跟这次要做的事无关。**
 *
 * 抓得到的真实一类:
 *   - `bun test` 而测试本来就是绿的 (D-I 的 verify-green 恰恰要求它一开始是红的)
 *   - `cat README.md` / `test -d docs` 这种"文件在不在"而文件本来就在
 *   - 断言的内容源材料里本来就有
 *
 * ## ⚠ 抓不到什么 (诚实边界, 别把它当万能)
 *
 * **抓不到上面那条 live 缺陷本身。** `grep -q "相同" docs/from-api.md` 在空世界里文件还不存在
 * → grep 失败 → 自检认为它"能区分" —— 而它事后仍被「不相同」满足。
 * 那一类需要的是**语义知识**(断言的词是不是执行体自己能选的), 确定性检查够不到。
 * 那一半走 prompt(见 `classifyPrompt` 里"断言要落在**输入里的值**上"那条), 是 inferential 侧。
 * 两层各管一半, 谁也别声称管全了。
 *
 * fail-open: 没有 runner / 跑不起来 → 返 null (不拦)。自检是加固不是前置条件。
 */
export async function acceptanceVacuityReason(
  command: string,
  runCommand: (input: { command: string }) => Promise<{ exitCode: number | null }>,
  expectExit = 0,
): Promise<string | null> {
  const v = await probeVacuity(command, runCommand, expectExit);
  return v.status === 'ring' || v.status === 'invalid' ? v.why : null;
}

/**
 * 空世界自检的**裁决** (给 vet 记 acceptanceProbe 用)。判定与 fail-open 语义与 `string | null`
 * 版逐字相同 —— 只是把"为什么"一起带出来, 不加不减任何决策。
 *
 * `invalid` (P2b, 2026-09-02): 与 `ring`(判据恒真)是**不同的病** —— 命令根本没给出「活干没干」
 * 的判词(harness 自己没跑起来), 不是「活还没干就已经满足」。目前只有一种narrow形状会判它:
 * 见 `isBareWholeSuitePytest`。
 */
export type ProbeVacuityVerdict =
  | { status: 'ok' }
  | { status: 'ring'; why: string }
  | { status: 'invalid'; why: string }
  | { status: 'fail_open' };

/**
 * 一条命令是不是 **bare 整仓 pytest** —— `pytest ...` 或 `python[3] -m pytest ...`, 且首词/
 * `-m pytest` 之后**每一个剩余 token 都是 flag** (`-q` / `-x` / `--maxfail=1` 这类)。
 * 只要出现一个非 flag token (路径 / `::node-id`) 就判 false —— 那是文件级判据, 它的 4/5
 * 是**想要的**「空世界红」, 这道闸不许碰它 (见本函数调用点的 P0 回归说明)。
 */
export function isBareWholeSuitePytest(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  let rest: string[];
  if (tokens[0] === 'pytest') {
    rest = tokens.slice(1);
  } else if ((tokens[0] === 'python' || tokens[0] === 'python3') && tokens[1] === '-m' && tokens[2] === 'pytest') {
    rest = tokens.slice(3);
  } else {
    return false;
  }
  return rest.every((t) => t.startsWith('-'));
}

/** bare 整仓 pytest 命中这几个退出码 = 「harness 自己没跑起来」, 不是「代码被判红」。 */
export const PYTEST_HARNESS_INCONCLUSIVE_EXITS = new Set([2, 4, 5]);

/**
 * P2b-runtime review fix (2026-09-02, P1): 退出码 2 (pytest `EXIT_INTERRUPTED`) 有两种成因,
 * 分类时 (probeVacuity, 跑在任何改动**之前**) 分不清也不需要分——但**运行期**跑的是 agent
 * 已经改过的真代码, 这时 2 绝大多数就是 `!!! Interrupted: N errors during collection !!!`,
 * 即 collect 阶段的 ImportError/SyntaxError —— 那是被测代码这次真被判红了, 不是 harness
 * 没跑起来。命中这个签名就不许读成 inconclusive, 必须落回 `classifyCommandExit` 的真红判词。
 * (4/5 不受影响: 4 是用法错误、5 是没收集到测试, 两者都与"这次改动是不是把代码写坏了"无关。)
 */
export function pytestCollectionError(text: string): boolean {
  return /errors? during collection|ERROR collecting/i.test(text);
}

/**
 * 运行期共用判据 (P2b-runtime + review fix, 2026-09-02): 一条 command 是不是 bare 整仓
 * pytest 且命中 harness-自伤退出码, **减去**「exit 2 但其实是 collection 阶段真被判红」那一格。
 * `src/harness/dag/engine.ts` 与 `src/harness/goal/run-goal.ts` 的三个运行期调用点共用这一份,
 * 避免 exit-2 例外只在其中一处补, 另外两处继续误判 (同一件事分三处各写一遍最容易漂)。
 */
export function isPytestHarnessInconclusive(command: string | undefined, exitCode: number | null, text: string): boolean {
  if (exitCode === null || !command || !isBareWholeSuitePytest(command)) return false;
  if (!PYTEST_HARNESS_INCONCLUSIVE_EXITS.has(exitCode)) return false;
  if (exitCode === 2 && pytestCollectionError(text)) return false;
  return true;
}

export async function probeVacuity(
  command: string,
  runCommand: (input: { command: string }) => Promise<{ exitCode: number | null }>,
  expectExit = 0,
): Promise<ProbeVacuityVerdict> {
  let exitCode: number | null;
  try {
    ({ exitCode } = await runCommand({ command }));
  } catch (err) {
    logger.warn({ command, err: String(err) }, VACUITY_CANT_RUN);
    return { status: 'fail_open' };
  }
  // 负退出码 = command-leaf 的闸拒返回值, 不是被执行命令的退出码 —— 那说明命令根本没跑,
  // 自检对它无话可说 (而"跑不起来"这件事已经由 acceptanceCommandBlockReason 管了)。
  // null = 死于信号: 跑了但没跑完, 没有判词 ⇒ 与闸拒同样无话可说, 不许读成「空世界里是红的」。
  if (exitCode === null || exitCode < 0) return { status: 'fail_open' };
  if (isBareWholeSuitePytest(command) && PYTEST_HARNESS_INCONCLUSIVE_EXITS.has(exitCode)) {
    return {
      status: 'invalid',
      why:
        `[invalid] 退出码 ${exitCode} — 不带路径的整仓 pytest 调用命中 2/4/5 (中断/collection 错误/用法错误/` +
        '没收集到测试), 这是「测试框架本身没跑起来」, 不是「这次要改的代码被判红」。给一条指到具体测试文件的 ' +
        'pytest 命令 (如 `pytest -q tests/x.py::y`)。',
    };
  }
  if (exitCode !== expectExit) return { status: 'ok' }; // 空世界里是红的 —— 通过自检
  return {
    status: 'ring',
    why:
      `[vacuous] 这条验收命令在**活还没干之前**就已经满足 (退出码 ${exitCode} = 期望值) —— ` +
      `它区分不了"做完了"与"还没做", 因此它不是一条判据。`,
  };
}

/**
 * **反面样本探针** —— G4 那句「判据必须在**错的答案**上失败」的可执行版(2026-07-31)。
 *
 * ## 它补的正是上面那段「⚠ 抓不到什么」
 *
 * 空世界自检问的是「活还没干之前它红不红」,而 2026-07-31 live 那条缺陷从这道闸底下走过去了:
 * `grep -q "相同" docs/from-api.md` 在空世界里文件不存在 → 命令失败 → 自检放行;
 * 而它事后**照样被「两处不相同」满足**。两道闸问的是**两个不同的问题**:
 *
 * | 探针 | 问 | 抓的病 |
 * |---|---|---|
 * | 空世界自检 | 什么都没做时它绿不绿 | 判据**恒真**(`cat README.md` 而 README 本来就在) |
 * | 反面样本(本函数) | 一份**错的**产物能不能骗过它 | 判据**不判别**(对的答案和错的答案都满足) |
 *
 * 一条判据要有意义, 这两问都得答对。此前只答了第一问, 而 live 抓到的恰是第二问那一类。
 *
 * ## 做法:在一个临时世界里把错答案摆出来
 *
 * 分类器除了命令还给一份**明显错**的产物(路径 + 两三行内容)。探针建一个临时目录、把它写进去、
 * 在那里跑同一条命令 —— **过了就是虚判据**。临时目录是引擎自己建的, 命令仍走同一份白名单闸,
 * 所以这道探针比空世界自检**更安全**(那一道是在真 cwd 上跑的)。
 *
 * ## 诚实边界
 *
 * 反面样本是**模型给的**, 所以这道闸的强度上限是"模型能不能想出一个像样的错答案"。
 * 它给了个和正确答案八竿子打不着的样本 → 探针照样放行一条虚判据。**它不是证明, 是筛子** ——
 * 筛掉的是那类"连一个显然的错答案都拦不住"的判据, 而 live 抓到的那条正是这一类。
 *
 * fail-open: 没样本 / 路径不合法 / 跑不起来 → 返 null(不拦)。同空世界自检:探针是加固不是前置条件。
 *
 * @returns null = 判据在这份错答案上失败了(通过探针);否则一行拒因。
 */
export async function acceptanceDiscriminationReason(
  command: string,
  sample: NegativeSample | undefined,
  expectExit = 0,
  deps: {
    runIn?: (input: { command: string; cwd: string }) => Promise<{ exitCode: number | null }>;
    repoRoot?: string;
  } = {},
): Promise<string | null> {
  const d = await probeDiscrimination(command, sample, expectExit, deps);
  return d.status === 'ring' ? d.why : null;
}

/**
 * 逐条判的**中性**入参 (F2 片 2)。一条判得出 yes/no 的东西, 加它的 id。
 *
 * ⚠ 中性是硬约束: 本文件不认识分型 (见文件头「分型 → 本文件; 本文件不认识分型」),
 * 所以这里**不 import 任何分型侧的类型**, 也不出现分型的 kind 字面量。
 * 把一份 checklist 拆成这个形状是**调用方**的活。
 */
export interface ProbeItemOutcome {
  readonly id: string;
  readonly pass: boolean;
}

/** 逐条判版判别力探针的裁决。三态与命令版同族 (`ok` / `ring` / `fail_open`)。 */
export type ProbeChecklistVerdict =
  | { status: 'ok' }
  | { status: 'ring'; why: string }
  | { status: 'fail_open'; why: string };

/**
 * **逐条判版的判别力探针** (F2 片 2, INV-4)。与上面命令版的判别力探针**同一件事**:
 * 拿一份明显劣化的产物过一遍判据, 照样全过 = 对的答案和错的答案都满足它。
 * 差别只在「跑一条命令」换成「逐条判 yes/no」—— 语义、fail-open 口径、裁决三态全部照抄。
 *
 * 判据: 劣化产物上**一条都没被打红** → `ring` (这份 checklist 是虚的)。
 * 有任意一条被打红 → `ok`。⚠ **全红也算 ok** —— 探针只问「分不分得出」, 不问「分得多准」。
 *
 * fail-open (与命令版同): 拿不到劣化样本 / 一条都没判成 → `fail_open`, **不拦**。
 * 探针是加固不是前置条件; 但按仓规「fail-open 可以吞异常, 不许吞证据」, `why` 必留。
 *
 * 反向自检: 改成恒返 `{status:'ok'}` → `rubric-discrimination.test.ts` 的
 * 「一条都没打红 → ring」当场红; 把 fail-open 那一支改成 `ring` → 「样本缺席不拦」当场红。
 */
export function checklistDiscriminationVerdict(
  outcomes: readonly ProbeItemOutcome[] | undefined,
): ProbeChecklistVerdict {
  if (outcomes === undefined) {
    return { status: 'fail_open', why: '拿不到劣化样本的逐条判定结果 — 探针跳过, 不拦' };
  }
  if (outcomes.length === 0) {
    return { status: 'fail_open', why: '劣化样本上一条都没判成 (零条目) — 探针跳过, 不拦' };
  }
  if (outcomes.some((x) => !x.pass)) return { status: 'ok' };
  return {
    status: 'ring',
    why:
      `劣化样本上 ${outcomes.length} 条判据**一条都没被打红** — ` +
      '这份 checklist 对与错都满足, 拿它判卷等于没判。',
  };
}

/**
 * {@link checklistDiscriminationVerdict} 的 `string | null` 包装 —— 与
 * {@link acceptanceDiscriminationReason} 同形, 方便调用方两种判据走同一套处置。
 *
 * @returns null = 过了探针 (含 fail-open 不拦那一支); 否则一行拒因。
 */
export function checklistDiscriminationReason(
  outcomes: readonly ProbeItemOutcome[] | undefined,
): string | null {
  const v = checklistDiscriminationVerdict(outcomes);
  return v.status === 'ring' ? v.why : null;
}

/**
 * 反面样本探针的**裁决** (给 vet 记 acceptanceProbe 用)。判定与 fail-open 语义与 `string | null`
 * 版逐字相同 —— 只是把"为什么"一起带出来, 不加不减任何决策。
 */
export type ProbeDiscriminationVerdict =
  | { status: 'ok'; weak?: string[]; why?: string }
  /**
   * #205 (2026-09-04, code80-p5 读数): 反面世界里命令**红了, 但红的理由是判据点名的文件在那边
   * 根本不存在** —— 不是断言不成立。判别力**未被证明**, 与 `ok` 分开一格。
   *
   * 这是 `sdd-compile.ts` 头注 2026-08-22 已经认下的那条同源根因 (它为此删掉了 RED 节点:
   * 「红的理由是「文件不存在」, 不是「断言不成立」…… 判别力为零」), 当时只堵了 SDD 那条路,
   * 探针这条路没堵。1-A 的设计**本来就要求**判据可以指向尚不存在的文件 (criterionFiles),
   * 于是这一格在生产上不是边角, 是常态。
   *
   * ⚠ fail-open: 它**不降级**判据 (与 `fail_open` / `skipped` 同待遇) —— 这一版只让"没被证明过"
   * 可见并可数, 不改收不收。要把它升成闸, 先量它的频率 (加尺子先当尺子)。
   */
  | { status: 'unproven-missing'; why: string; missing: string[]; weak?: string[] }
  | { status: 'ring'; why: string; weak?: string[] }
  | { status: 'skipped'; why: string }
  | { status: 'fail_open'; why: string };

/**
 * **零判别力的判据段** (#204, 承 #199 D2)。判据是 `A && B && C` 时, 只要有一段强 (`bun test`),
 * 整条就"分得出" —— 弱段被强段背书。#165 的 `grep -q "反向自检" <本次要产出的测试文件>` 正是
 * 这样溜过去的: 整条里的 `bun test` 在错答案上红了, 于是探针给整条放行, 而那条 grep 段
 * **在任何代码下都退 0**。
 *
 * 逐段跑之后, 在反面世界里**仍然通过**的段就是零判别力的段, 原样点名。
 *
 * ⚠ **逐段结果只加信息, 永不翻裁决**: 切分是按裸 `&&` 做的朴素切分 (引号里的 `&&` 会切错),
 * 所以它不许决定收不收 —— 切错了最多多报一段, 不会误拒一条好判据。裁决仍只看整条。
 */
export function splitCriterionSegments(command: string): string[] {
  return command
    .split('&&')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function probeDiscrimination(
  command: string,
  sample: NegativeSample | undefined,
  expectExit = 0,
  deps: {
    runIn?: (input: { command: string; cwd: string }) => Promise<{ exitCode: number | null }>;
    /** #204: 真仓根 —— 给了才建 HEAD 真副本当反面世界; 省略 = 今天的空目录形态 (fail-open)。 */
    repoRoot?: string;
  } = {},
): Promise<ProbeDiscriminationVerdict> {
  if (!sample?.path || !sample.content) return { status: 'skipped', why: NO_NEGATIVE_SAMPLE };
  // 相对路径且不许 `..` —— 探针要写盘, 而"分类器给的路径"是**模型产的字符串**, 按不可信处理。
  // (临时目录本身是隔离的, 这一层是防它把宿主别处的文件覆盖掉。)
  const rel = sample.path.trim();
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    logger.warn({ path: sample.path }, SAMPLE_PATH_BAD);
    return { status: 'fail_open', why: SAMPLE_PATH_BAD };
  }
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'omd-negative-'));
    // ── #204 (承 #199 D1): 反面世界要是**真仓副本**, 不是空目录 ──────────────────
    //
    // 读数是这么逼出来的: 账本 348 跑里真跑过探针的 69 跑, 这道闸**红过 0 次** (3 次 demoted
    // 全是空世界自检打的)。66/66 零方差 —— 而本仓自己的话是「一个在任何干预下都不动的数,
    // 通常量的是尺子, 不是被测物」。
    //
    // 尺子错在哪: 原来的世界是 `mkdtemp` 一个**空目录** + 只写进去那一个样本文件。任何仓内判据
    // (`bun test` / `bunx tsc` / 相对路径 grep) 在空目录里**必然失败**, 于是探针恒判「分得出」——
    // 它量的其实是「这条命令在仓外会不会挂」, 而答案恒为「会」。
    //
    // 用 `git archive` 而不是 `git worktree add`: 探针每条执行型判据都要跑一次, 不该往真仓的
    // worktree 登记表里留状态 —— archive 零仓内副作用, 清理就是 rm -rf。node_modules 走
    // `ensureNodeModulesLink` 软链 (没有它 `bun test` 在副本里必然缺依赖而挂, 那就又回到
    // 「恒失败 = 恒判分得出」的老毛病)。
    const world = buildNegativeWorld(dir, deps.repoRoot);
    const file = join(world.cwd, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, sample.content.endsWith('\n') ? sample.content : `${sample.content}\n`, 'utf-8');
    const run = deps.runIn ?? defaultProbeRunner;
    const { exitCode } = await run({ command, cwd: world.cwd });
    // null = 死于信号(跑了但没跑完, 没有判词)→ 与闸拒同样"探针无话可说", 但成因不同, 判词分开写。
    if (exitCode === null) return { status: 'fail_open', why: '判据自证: 探针命令死于信号(没拿到判词)—— 本次自检无效, 不据此降级' };
    // 负码 = 闸拒(命令没跑)→ 探针无话可说, 那件事由 acceptanceCommandBlockReason 管。
    if (exitCode < 0) return { status: 'fail_open', why: DISCRIM_BLOCKED };
    // #204 (D2): 逐段跑一遍 —— 整条的裁决不受它影响, 它只回答「哪几段其实什么都没证明」。
    const weak = await weakSegments(command, world.cwd, expectExit, run);
    if (exitCode !== expectExit) {
      // ── #205: 「红」之前先问一句「红在哪」 ────────────────────────────────────
      //
      // 判据点名的路径在**反面世界**里不存在时, 这条命令必然非零 (pytest 退 4 / bun test 退非零),
      // 而那与断言成不成立无关。旧实现只看退出码, 于是这类判据恒判「分得出」——
      // code80-p5 实测: 我们的判据文件与 bench 隐藏测试文件 **68 题里 67 题零交集**,
      // 而其中「绿的那边有 reward 0.0」正是从这里漏出去的。
      //
      // 用 `missingPathArgs` 而不是解析退出码: 退出码语义逐工具不同 (pytest 4/5 · bun · tsc),
      // 解析它是又一份会漂的表; 文件在不在是确定性事实, 且与 1-A 的 criterionFiles 同一个函数
      // (同源, 不会两处判定不一致)。
      const missing = missingPathArgs(command, world.cwd);
      if (missing.length > 0) {
        return {
          status: 'unproven-missing',
          missing,
          why:
            `[unproven] 这条验收命令在反面世界里确实非零 (${exitCode}), 但它点名的 ${missing.length} 个路径` +
            `在那边**根本不存在**: ${missing.join(', ')} —— 红的理由是文件缺席, 不是断言不成立。` +
            `判别力未被证明 (本版不据此降级, 只记账)。`,
          ...(weak.length > 0 ? { weak } : {}),
        };
      }
      // 错答案上整条命令失败 —— 通过探针。
      //
      // 但「通过」值多少钱取决于**在哪个世界里通过的**: 退回空目录时任何仓内判据都必然失败,
      // 那次通过什么都没证明 (#199 量到的正是这个: 69 跑 0 红)。所以世界的原话进这里, 而**不进
      // ring 那条判词** —— ring 无论在哪个世界都成立 (空目录里都能过, 那更 damning), 且那句是
      // 冻结文本, 不许为附注改它一个字。
      const notes = [world.why, weak.length > 0 ? `零判别力的段 (${weak.length}): ${weak.map((w) => `\`${w}\``).join(' · ')}` : undefined].filter(
        (x): x is string => Boolean(x),
      );
      return {
        status: 'ok',
        ...(weak.length > 0 ? { weak } : {}),
        ...(notes.length > 0 ? { why: notes.join('; ') } : {}),
      };
    }
    return {
      status: 'ring',
      why:
        `[undiscriminating] 这条验收命令在一份**明显错**的产物上**照样通过**(退出码 ${exitCode} = 期望值) —— ` +
        `对的答案和错的答案都满足它, 因此它判不了成败。反面样本: \`${rel}\` = ${JSON.stringify(sample.content.slice(0, 120))}`,
      ...(weak.length > 0 ? { weak } : {}),
    };
  } catch (err) {
    const why = `${DISCRIM_CANT_RUN}: ${String(err).slice(0, 200)}`;
    logger.warn({ command, err: String(err) }, why);
    return { status: 'fail_open', why };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * #205 方向性探针 (2026-09-04, code80-p5 读数)。**这是判据"测没测对方向"的唯一机械检查。**
 *
 * ## 它回答的问题
 *
 * 判别力探针 (`probeDiscrimination`) 问的是「判据能不能区分对错样本」;它答得了「判据是不是虚的」,
 * 答不了「判据量的是不是这次要改的那件事」—— 一个测错东西的测试, 只要在自己的合成错样本上红,
 * 照样过那道闸。code80-p5 实测:我们的判据文件与 bench 隐藏测试文件 **68 题里 67 题零交集**。
 *
 * 这道探针问的是另一件事:把 1-A 刚写好的判据文件**放回改动前的代码**里跑一遍。
 *  · **红** —— 好。这条判据确实在量本次要做的改动 (改动前不成立, 改完才成立)。
 *  · **绿** —— 坏。改动前它就已经成立了 ⇒ **它测的是别的东西**, 与本次目标无关。
 *              「conductor 写了个自己能过的测试」在机械上长的就是这个样子。
 *
 * ## 为什么必须等到 1-A 写完才能跑
 *
 * `sdd-compile.ts` 头注 2026-08-22 删掉 RED 节点的根因是「实装前跑 verify 必然是
 * `bun test <还不存在的文件>` 的 exit 1 —— 红的理由是文件不存在, 不是断言不成立」。
 * 那条根因在**这里不成立**:本函数在 1-A 冻结之后调用, 判据文件已经真的写出来了,
 * 我们把它从真仓复制进 HEAD 副本, 于是「文件存在 + 实装未做」—— 那正是 O-6 当年想要而拿不到的世界。
 *
 * ## fail-open
 *
 * 本版**只记账不拦**。「改动前绿 ⇒ 方向错」这条判断目前零真实样本支撑, 直接升成闸会重复
 * 窄复审那次 3/8 假阳性的错误 (同批实测)。先量一批频率, 再定要不要拦。
 */
export type CriterionDirectionVerdict =
  /** 判据在改动前的代码上红 —— 它确实在量本次改动。 */
  | { status: 'red-before'; why: string }
  /** 判据在改动前就绿 —— **它测的不是本次要改的东西**。 */
  | { status: 'green-before'; why: string }
  /** 跑不起来 / 建不出世界 / 文件复制失败 —— 什么都没量到, 与上面两格分开记 (§静默坑 1)。 */
  | { status: 'inconclusive'; why: string };

export async function probeCriterionDirection(
  command: string,
  criterionFiles: readonly string[],
  repoRoot: string,
  expectExit = 0,
  deps: { runIn?: (input: { command: string; cwd: string }) => Promise<{ exitCode: number | null }> } = {},
): Promise<CriterionDirectionVerdict> {
  if (!criterionFiles.length) return { status: 'inconclusive', why: '没有 1-A 判据文件 (判据不引用新文件, 这道探针不适用)' };
  if (!repoRoot) return { status: 'inconclusive', why: '没有 repoRoot' };
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'omd-direction-'));
    const world = buildNegativeWorld(dir, repoRoot);
    // ⚠ 靠 `cwd` 判有没有建成真副本, **不靠 `why`**: 副本建成了但 node_modules 是软链/缺源时
    // 它同样带 `why` (那只是附注)。用 `why` 判会把一批真副本误判成没建成 —— 本文件第一版
    // 就是这么错的, 被 criterion-direction.test.ts 当场抓住。
    if (world.cwd === dir) return { status: 'inconclusive', why: `反面世界没建成真副本: ${world.why ?? '未知'}` };
    // 把判据文件从**真仓**(1-A 刚写好的那一份)复制进 HEAD 副本 —— 这是本探针与判别力探针
    // 唯一的结构差别, 也是它能问出"方向"的原因。
    for (const f of criterionFiles) {
      const src = join(repoRoot, f);
      if (!existsSync(src)) return { status: 'inconclusive', why: `判据文件 ${f} 在真仓里也不存在 (1-A 没写出来)` };
      const dst = join(world.cwd, f);
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, readFileSync(src));
    }
    const run = deps.runIn ?? defaultProbeRunner;
    const { exitCode } = await run({ command, cwd: world.cwd });
    if (exitCode === null) return { status: 'inconclusive', why: '判据在改动前的世界里死于信号 (没拿到判词)' };
    if (exitCode < 0) return { status: 'inconclusive', why: '判据在改动前的世界里被闸拒 (命令没跑)' };
    if (exitCode === expectExit) {
      return {
        status: 'green-before',
        why:
          `[direction] 判据把**改动前的代码**也判成通过 (退出码 ${exitCode} = 期望值) —— ` +
          `本次改动还没发生它就已经绿了, 所以它量的不是本次目标。判据文件: ${criterionFiles.join(', ')}`,
      };
    }
    return { status: 'red-before', why: `判据在改动前的代码上红 (退出码 ${exitCode}) —— 它确实在量本次改动` };
  } catch (err) {
    return { status: 'inconclusive', why: `方向性探针跑不起来: ${String(err).slice(0, 160)}` };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 造反面世界 (#204, 承 #199 D1)。给了 `repoRoot` 且它是 git 仓 → **HEAD 的真副本**;
 * 否则退回今天的空目录形态。
 *
 * **fail-open 且留证据**: 任何一步没成都退回空目录并把原因带进 `why` —— NULL≠0,
 * 「没建成真副本」与「建了真副本」是两件事, 事后要分得开 (不然又出现一个"恒过"的探针
 * 而没人知道它其实一直在空目录里跑)。
 */
function buildNegativeWorld(dir: string, repoRoot?: string): { cwd: string; why?: string } {
  // 没接线 ≠ 降级: `why` 只记**真降级**(给了 repoRoot 却没建成真副本), 那是读数; 「压根没给」
  // 是接线问题, 走日志。两者混在一格里, `passed-both.why` 就会常驻一句废话, 而常驻的附注等于没有附注。
  // ⚠ 空旋钮风险: 生产的那根线在 `run-goal.ts` 的 `repoRoot: config.cwd` —— 拆了它这里不会红,
  //   只会安静地退回空目录。真要拆先看 #204 的裁决。
  if (!repoRoot) {
    logger.info({ dir }, '[omd/goal] 判别力探针: 没给 repoRoot → 反面世界=空目录 (仓内判据在那里必然失败, 这次探针几乎必然放行)');
    return { cwd: dir };
  }
  if (!existsSync(join(repoRoot, '.git'))) return { cwd: dir, why: `反面世界=空目录 (${repoRoot} 不是 git 仓)` };
  const wt = join(dir, 'repo');
  try {
    mkdirSync(wt, { recursive: true });
    const tar = join(dir, 'head.tar');
    // 两步 spawn 而不是管道: 管道的退出码要另判, 而这里每一步失败都必须**看得见**。
    const ar = Bun.spawnSync(['git', 'archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
    if (ar.exitCode !== 0) throw new Error(`git archive 退 ${ar.exitCode}: ${new TextDecoder().decode(ar.stderr).trim().slice(0, 160)}`);
    const ex = Bun.spawnSync(['tar', '-xf', tar, '-C', wt], { stdout: 'pipe', stderr: 'pipe' });
    if (ex.exitCode !== 0) throw new Error(`tar -xf 退 ${ex.exitCode}: ${new TextDecoder().decode(ex.stderr).trim().slice(0, 160)}`);
    // 没有 node_modules, `bun test` 在副本里必然缺依赖而挂 —— 那就又回到「恒失败 = 恒判分得出」。
    const link = ensureNodeModulesLink(repoRoot, wt);
    return { cwd: wt, why: link === 'linked' || link === 'already-present' ? undefined : `反面世界=真仓副本, 但 node_modules ${link}` };
  } catch (err) {
    return { cwd: dir, why: `反面世界退回空目录 (真副本没建起来: ${String(err).slice(0, 160)})` };
  }
}

/**
 * 逐段判判别力 (#204, 承 #199 D2): 在反面世界里把 `A && B && C` 逐段跑, 收集**仍然通过**的段。
 *
 * 只在有两段以上时跑 —— 单段判据的逐段结果就是整条结果, 再跑一遍是白花一次命令的钱。
 * 任何一段跑不起来 (信号 / 闸拒 / 抛) 一律**不算弱段**: 这道逐段判只加信息不翻裁决,
 * 把"没跑成"读成"没判别力"就是拿猜当事实。
 */
async function weakSegments(
  command: string,
  cwd: string,
  expectExit: number,
  run: (input: { command: string; cwd: string }) => Promise<{ exitCode: number | null }>,
): Promise<string[]> {
  const segs = splitCriterionSegments(command);
  if (segs.length < 2) return [];
  const weak: string[] = [];
  for (const seg of segs) {
    try {
      const { exitCode } = await run({ command: seg, cwd });
      if (exitCode === expectExit) weak.push(seg);
    } catch {
      // 跑不起来 ≠ 没判别力 —— 跳过, 不记 (fail-open 可以吞异常, 但这里没有证据可留: 段原文已在判词里)。
    }
  }
  return weak;
}

/**
 * 探针默认 runner:**per-root 白名单**(D-3, 片 2) + **根在临时目录**。
 *
 * · 白名单走 `allowlistForRoot(cwd)` —— 反面世界 = 真仓副本 (有 marker) 时, python 仓的探针
 *   跑 `pytest` 不再被闸拒 (`DISCRIM_BLOCKED`), 见 INV-7。无 marker 的空目录退回 base,
 *   与改前一致 (默认词表不变, 探针真仓副本才变)。
 * · 刻意**不复用**调用方注入的那个 runner:那一个的 cwd 在装配期就烤进去了(= 真工作树),
 *   而探针的全部意义就是换一个世界跑。也刻意不为此给 `CommandLeafInput` 加一个 `cwd` 口 ——
 *   那是给节点执行面开一个由模型填的根路径,为一道自检开这种口子不划算。
 *
 * `allowlistForRoot` 每次新造一份数组 (与 `commandBlockReason` 那条「无 memo 缓存」同源),
 * 探针每条执行型判据都要跑一次, 缓存跨 run 是危险源, 这里不替它埋。
 */
const defaultProbeRunner = async ({ command, cwd }: { command: string; cwd: string }): Promise<{ exitCode: number | null }> =>
  createCommandLeafRunner({ allowlist: allowlistForRoot(cwd), cwd, timeoutMs: 30_000 })({ command });
