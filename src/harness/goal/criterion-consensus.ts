/**
 * goal/criterion-consensus —— **判据三候选共识** 的纯函数层 (2026-09-05, 契约
 * `docs/plan/2026-09-05-判据三候选共识-执行契约-草案.md`)。
 *
 * 要修的是**一次采样就是一次掷硬币**: 一个 run 花 26 发 conductor 派发, 而定方向那一发只采样一次。
 * 实测读数 (`runs/2026-09-05-direction-readout/`): 同一题的验收分型在五个臂间不一致 57/80,
 * 同一题既拿过 ≥0.9 又拿过 ≤0.3 的 34/80。
 *
 * 于是采 3 份候选, 抽「方向签名」(判据到底指向仓里哪些文件 / 哪些标识符) 比一致性, 按规则择一。
 * **本版不拦不升级, 只量** —— 一致性读数进 loop ledger, 阈值等一批读数再校准。
 *
 * 本模块**零 IO 零 LLM**: 采样、git ls-files、座位解析全在 `./classify-acceptance` 那一层,
 * 这里只吃已经归一好的 {@link AcceptanceSpec} 与一份「仓里有哪些文件」的集合。
 */
import type { AcceptanceSpec } from './classify-acceptance';
import { extractGoalTerms } from './criterion-survey';

/**
 * 一份判据的**方向签名** (D-2) —— 它指向仓里的哪些文件、哪些标识符。
 *
 * 比的是方向而不是字面: 两条命令写法不同但指同一个测试文件, 该算一致; 两条命令长得像
 * 但一个指幻觉路径, 该算不一致。
 */
export interface DirectionSignature {
  /** 命令里认得出的文件路径 (排序去重)。rubric / 探索型恒空。 */
  files: string[];
  /** 执行型 = `::` 后的测试 id; rubric = 逐条抽出的标识符 / 键名 / 文件名。排序去重。 */
  ids: string[];
  /** 「指向既有文件」——`files` 非空**且每一条都在仓里**。空签名不算指向 (D-4 ② 的择优依据)。 */
  existing: boolean;
  kind: AcceptanceSpec['kind'];
}

/** 进 loop ledger 的一致性读数 (D-5)。整格缺席 = 没开共识, 不是"开了但一致性为 0"。 */
export interface CriterionConsensus {
  /** 真正拿到的候选份数 (调用失败的那份缺席, 不重试)。 */
  n: number;
  /** 这批候选里有没有一份来自异族座。false = verifier / escalation 两个座都与 conductor 同 provider。 */
  crossFamily: boolean;
  /** 三份的验收分型是否全同。 */
  kindAgreement: boolean;
  /** 两两 Jaccard (文件 ∪ 标识符) 的均值。`n < 2` 时无对可比, 记 1 —— 读侧靠 `n` 分辨。 */
  agreement: number;
  /** 分型没有多数派 (含三份互异)。本版只记账, 不升 owner。 */
  ambiguous: boolean;
  chosenIndex: number;
  /** 逐份的分型, 顺序同采样顺序 (conductor 两发在前, 异族座在后)。 */
  kinds: string[];
}

/** rubric 一份签名最多收多少个标识符 —— 上限只是防一份超长 checklist 把签名撑成噪声。 */
const RUBRIC_MAX_IDS = 40;

/** 择优的分型优先序 (D-4 ④): 没有多数派时按它取。执行型最强 —— 它是唯一机器可判的那一型。 */
const KIND_PRIORITY: readonly AcceptanceSpec['kind'][] = ['executable', 'rubric', 'exploratory'];

/** 像不像一条路径: 带斜杠, 或带扩展名。两条都不像 ⇒ 它是命令名 / 开关, 不进签名。 */
function pathLike(token: string): boolean {
  return token.includes('/') || /\.[A-Za-z0-9]{1,5}$/.test(token);
}

/**
 * 抽方向签名 (D-2)。
 *
 * `existingFiles` 由调用方给 (生产是 `git ls-files` 的输出) —— 本模块不碰 IO,
 * 于是这条判据在测试里是确定性的, 不依赖跑测试时仓里恰好有什么。
 */
export function directionSignature(spec: AcceptanceSpec, existingFiles: ReadonlySet<string>): DirectionSignature {
  if (spec.kind === 'exploratory') return { kind: 'exploratory', files: [], ids: [], existing: false };

  if (spec.kind === 'rubric') {
    const text = spec.checklist.items.map((it) => it.requirement).join('\n');
    return {
      kind: 'rubric',
      files: [],
      // 与勘察段用的是**同一个抽词器** (单源纪律): 反引号 / 引号 / 路径 / snake_case / CamelCase。
      ids: [...new Set(extractGoalTerms(text, RUBRIC_MAX_IDS))].sort(),
      existing: false,
    };
  }

  const files = new Set<string>();
  const ids = new Set<string>();
  for (const raw of spec.command.split(/\s+/)) {
    // 开关不是方向 (`-q` / `--noEmit`); 引号在这里剥掉, 闸那边扫的是整串, 与本处无关。
    const token = raw.replace(/^["']|["']$/g, '');
    if (token === '' || token.startsWith('-')) continue;
    if (token.includes('::')) {
      const [head, ...rest] = token.split('::');
      if (head && pathLike(head)) files.add(head);
      for (const id of rest) if (id) ids.add(id);
      continue;
    }
    if (pathLike(token)) files.add(token);
  }
  const fileList = [...files].sort();
  return {
    kind: 'executable',
    files: fileList,
    ids: [...ids].sort(),
    // **每一条都得在仓里**: 一条真路径 + 一条幻觉路径仍然是一份指错方向的判据。
    existing: fileList.length > 0 && fileList.every((f) => existingFiles.has(f)),
  };
}

/** 签名的可比 token 集 = 文件 ∪ 标识符。 */
function tokensOf(sig: DirectionSignature): Set<string> {
  return new Set([...sig.files, ...sig.ids]);
}

/** 两个集合都空 ⇒ 1 (它们一样地什么都没指), 不是 0/0。 */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 一致性 (D-3): 两两 Jaccard 的均值 + 分型是否全同。
 *
 * ⚠ `agreement` 与 `kindAgreement` 是**两个读数**, 别并成一个: 三份都判成 rubric 但各指各的键
 * (kindAgreement 真, agreement 低) 与 两份执行型指同一文件 + 一份 rubric (反过来) 是两种不同的歧义。
 */
export function agreement(sigs: readonly DirectionSignature[]): { agreement: number; kindAgreement: boolean } {
  const first = sigs[0];
  const kindAgreement = sigs.every((s) => s.kind === first?.kind);
  if (sigs.length < 2) return { agreement: 1, kindAgreement };
  const toks = sigs.map(tokensOf);
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < toks.length; i++) {
    for (let j = i + 1; j < toks.length; j++) {
      sum += jaccard(toks[i]!, toks[j]!);
      pairs++;
    }
  }
  return { agreement: sum / pairs, kindAgreement };
}

/** 签名里的 token 有几个真在勘察段里出现过 —— 数的是 token 数, 不是出现次数。 */
export function surveyHits(sig: DirectionSignature, survey: string): number {
  if (!survey) return 0;
  let n = 0;
  for (const t of tokensOf(sig)) if (survey.includes(t)) n++;
  return n;
}

/**
 * 择优 (D-4 首版, 阈值待一批读数校准):
 *  ① 分型多数派 (过半) 内选; 没有多数派 ⇒ `ambiguous`, 按 执行型 > rubric > 探索型 取;
 *  ② 池内优先「指向既有文件」的执行型 (幻觉路径不该赢);
 *  ③ 仍并列 ⇒ 取勘察段命中最多的那份; 全并列 ⇒ 取先采到的那份 (确定性, 不掷第二次骰子)。
 *
 * 候选为空**响亮失败**: 静默返 0 会让「一份都没拿到」冒充「选了第一份」。
 */
export function chooseCandidate(
  cands: readonly { spec: AcceptanceSpec; sig: DirectionSignature; surveyHits: number }[],
): { index: number; ambiguous: boolean; why: string } {
  if (cands.length === 0) throw new Error('[omd/goal] chooseCandidate: 候选为空 (调用方该先判空, 别在这里兜)');

  const tally = new Map<AcceptanceSpec['kind'], number>();
  for (const c of cands) tally.set(c.sig.kind, (tally.get(c.sig.kind) ?? 0) + 1);
  const majority = [...tally].find(([, n]) => n * 2 > cands.length)?.[0];
  const ambiguous = majority === undefined;
  const picked = majority ?? KIND_PRIORITY.find((k) => tally.has(k))!;

  const pool = cands.map((_, i) => i).filter((i) => cands[i]!.sig.kind === picked);
  const anchored = pool.filter((i) => cands[i]!.sig.kind === 'executable' && cands[i]!.sig.existing);
  const narrowed = anchored.length > 0 ? anchored : pool;

  let index = narrowed[0]!;
  for (const i of narrowed) if (cands[i]!.surveyHits > cands[index]!.surveyHits) index = i;

  const why =
    (ambiguous
      ? `分型无多数派 (${cands.map((c) => c.sig.kind).join('/')}) → 按 执行型>rubric>探索型 取 ${picked}`
      : `分型多数派 ${picked} (${tally.get(picked)}/${cands.length})`) +
    (anchored.length > 0 ? ' · 指向既有文件' : '') +
    ` · 勘察命中 ${cands[index]!.surveyHits}`;
  return { index, ambiguous, why };
}
