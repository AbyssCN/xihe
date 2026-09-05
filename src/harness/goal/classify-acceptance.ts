/**
 * goal/classify-acceptance —— **验收分型**:这个目标的成败该怎么判(2026-08-07 从 `acceptance.ts` 拆出)。
 *
 * classify 这一站的问题:从「要不要 research」改成「**这个目标的验收方式是哪一种**」。
 *
 * 为什么这是最该先问的一句:自主环最重要的死法不是"做不出来", 是**作弊达标** —— 执行体把判据本身
 * 改到自己够得着的地方(放宽断言 / skip 掉红的 / mock 掉被测逻辑 / 干脆删测试), 然后诚实地报告"绿了"。
 * 防它的唯一办法是**在动手之前就把判卷标准冻结下来**, 且冻结的东西必须是执行体改不动的:一条**别人来跑**的命令。
 *
 * 于是分两型, 两条完全不同的路:
 *
 * - **执行型 (executable)** —— 成败机器可判。**必须**产出一条可跑的验收命令。它必须**当场就判定跑得起来**
 *   (过 command-leaf 的 fail-closed 闸)—— 规划期说能跑、执行期被闸拒 = 「假红」。
 * - **探索型 (exploratory)** —— 成败机器判不了(选型 / 摸清一个领域)。既然判不了成败, 就**不许假装能判**:
 *   换成**学习目标** + **可承受损失**。后者是探索型唯一的硬边界 —— 判不了对错时, 能定的只有亏损上限。
 *
 * ⚠ 分型 ≠ 轻重路由。`GoalTier` (simple/complex) 问"要不要先查外部事实/先定契约", 是**成本**轴;
 * 验收分型问"怎么判成没成", 是**判据**轴。两条轴此前混在一句 prompt 里。
 *
 * 判据**自己立不立得住**由 `./acceptance-gate` 管(空世界自检 + 判别力探针), 本文件只调它、不实现它。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_COMMAND_ALLOWLIST,
  LANGUAGE_PACKS,
  allowlistForRoot,
} from '../command-leaf';
import { logger } from '../logger';
import { type EnvFacts, probeEnvFacts, renderEnvFacts } from '../env-facts';
import type { GenerateFn } from '../dag/types';
import { parseRouteRaw, type RouteDecision, type RouteRaw } from './chain-router';
import { STAGE_WORDS } from './stage-chain';
import {
  type AcceptanceCommandBlockOpts,
  type AcceptanceProbe,
  type NegativeSample,
  type ProbeVacuityVerdict,
  NO_NEGATIVE_SAMPLE,
  acceptanceCommandBlockReason,
  probeDiscrimination,
  probeVacuity,
} from './acceptance-gate';
import { freezeRubric, type RubricItem, type RubricSpec } from './rubric-spec';
import {
  agreement,
  chooseCandidate,
  directionSignature,
  surveyHits,
  type CriterionConsensus,
} from './criterion-consensus';
import { tryResolveSeatModel } from '../../model/role-models';
import { effectiveSeatSampling } from '../../model/seat-overrides';

/** D-5 轻重路由 (成本轴): simple = 直接 Execute→Verify; complex = 全 research→spec→execute。 */
export type GoalTier = 'simple' | 'complex';

/**
 * D-I 验收分型 (判据轴)。判别联合而非"一堆可选字段" —— 可选字段版会长成又一个空旋钮:
 * 声明面写着 command?, 谁也不保证它在。
 */
export type AcceptanceSpec =
  | {
      kind: 'executable';
      /** 别人来跑的验收命令。已过 {@link isRunnableAcceptanceCommand}。 */
      command: string;
      /** 期望退出码 (D-K)。verify-green 是 0; 冻结判据时一并记, 免得后面被改。 */
      expectExit: number;
    }
  | {
      kind: 'exploratory';
      /** 学到什么才算这次没白跑 (判不了成败, 至少判得了"有没有学到")。 */
      learningGoal: string;
      /** 愿意为它花掉多少 (轮数 / 时间 / token)。探索型唯一的硬边界。 */
      affordableLoss: string;
    }
  | {
      /**
       * 第三格 (F2, 无 oracle 验收阶梯的第 ③ 级):没有可跑命令, 但产物好坏能被人逐条说清。
       *
       * 它填的是执行型与探索型之间那道缝 —— 此前这类目标只能被迫落进探索型
       * (只判「有没有学到」) 或被硬凑成一条虚的命令。
       */
      kind: 'rubric';
      /**
       * 结晶期冻下的 checklist, **必填**。
       *
       * 必填不是可选 —— 可选字段版会长成又一个空旋钮 (同本联合上面那段注释)。
       * 冻结含内容哈希: rubric 唯一的可信来源就是「写它的时候还不知道产物长什么样」,
       * 验收期改一个字即拒 (F2 §INV-3, 判定在 `rubric-spec.verifyFrozen`)。
       */
      checklist: RubricSpec;
    };

export interface GoalClassification {
  tier: GoalTier;
  acceptance: AcceptanceSpec;
  /** 见 {@link NegativeSample}。缺席 = 分类器没给(探针跳过,fail-open)。 */
  negativeSample?: NegativeSample;
  /** 见 {@link AcceptanceProbe}。缺席 = 没探 / 没记录。 */
  acceptanceProbe?: AcceptanceProbe;
  /**
   * D-19 / INV-12: 与 tier/acceptance 同一发出的路由决策 —— 取代 `chain-router.routeChain`
   * 在默认路径上的独立第二次调用。可选是因为**历史续跑状态** (goal-state.json 里存的
   * `classified`) 可能来自本字段加入之前的老 run, 老行没有这一格; 生产 `classifyGoal`
   * 恒填 (见其函数头), 缺席只发生在读老状态或测试没给的场景, 消费侧一律 `?? {kind:'none'}`。
   */
  route?: RouteDecision;
  /** R-1 (2026-09-03): 这次分类打了几发 LLM (含 P2b 重推 / E-T1b 追问)。null = 没走 LLM (缺 generate); 缺席 = 注入式分类器 / 老对象。 */
  llmCalls?: number | null;
  /**
   * 三候选共识读数 (2026-09-05, 见 `./criterion-consensus`)。**缺席 = 没开共识**
   * (`OMD_CRITERION_CONSENSUS` 不是 `1`, 或三发全挂回落了单发那条路), 不是"开了但一致性为 0"。
   */
  criterionConsensus?: CriterionConsensus;
}

/**
 * 探索型兜底 —— 分型失败 / 执行型拿不到可跑命令时用它, **并把原因原样写进学习目标**。
 *
 * 为什么兜到探索型而不是"执行型但命令留空": 执行型的全部意义就是那条命令, 留空的执行型
 * 是个说自己可判、实际无人判的目标 —— 正是本模块要杀的那种。降级到探索型至少诚实:
 * 它明说"这次没有机器判据", 于是 spec 卡会被要求补出一条, 补不出就按探索型的规矩走 (定亏损上限)。
 */
export function fallbackExploratory(why: string): AcceptanceSpec {
  return {
    kind: 'exploratory',
    learningGoal: `(验收分型未成立: ${why}) 先弄清这个目标的成败到底该怎么判 —— 能不能落成一条可跑的命令。`,
    affordableLoss: '一轮执行的开销; 仍判不出判据就停下来交人, 不要靠多跑几轮蒙过去。',
  };
}

/** 分类器的 JSON 形状 (弱模型也吃得下的扁平结构; 深校验在下方 normalize)。 */
interface RawClassification {
  tier?: unknown;
  acceptance_kind?: unknown;
  command?: unknown;
  /** F2 第三格:分类器给的 checklist 原样 —— 形状校验在 normalizeClassification 里做。 */
  checklist?: unknown;
  learning_goal?: unknown;
  affordable_loss?: unknown;
  /** G4 反面样本(扁平两格 —— 弱模型对嵌套对象的成功率明显低于扁平字段)。 */
  negative_sample_path?: unknown;
  negative_sample_content?: unknown;
  /**
   * P3 S7 (D-19 / INV-12, 2026-09-02): 路由槽 —— 与 tier / acceptance **同一发**结构化调用带出。
   * 形状 = chain-router 的 `RouteRaw` (`{kind:'none'}` | `{kind:'chain', chain:{stages:[…]}}`), 钳到封闭枚举
   * 由 `parseRouteRaw` 做 (越界 / 空 stages → none + 一行证据)。缺席 = none (老模型输出零改造照旧)。
   */
  route?: unknown;
}

/**
 * 把模型吐的 JSON 归一成 {@link GoalClassification}。**弱模型不可信原则**: 每一格都自己兜,
 * 兜不住就往保守方向落 —— 但保守的方向在两条轴上**相反**:
 *
 * - tier 落 `complex`: 多做一遍接地, 代价是钱; 误判成 simple 的代价是一份没有证据的契约被执行。
 * - acceptance 落 `exploratory`: 假装机器可判而实际无人判, 比明说"这次判不了"坏得多。
 *
 * 给 `opts.root` → 闸走 `allowlistForRoot(root)` + 语言一致闸(与 acceptance 闸同源),
 * Python 仓写 `bun test` 在此拒; 不给 → 退回 base 白名单(既有调用零改动即绿, INV-6 / INV-11)。
 */
export function normalizeClassification(raw: RawClassification, opts?: AcceptanceCommandBlockOpts): GoalClassification {
  // P3 S7: route 槽与另两条轴同一发出, 归一化在这一层套上 —— 各分支 (执行型 / rubric / 探索型 / 降级) 一个都不漏。
  // 缺席 → none (不留证据行: 缺席是老输出的常态, 不是越界); 在场 → parseRouteRaw 钳 + 越界留证据 (INV-6)。
  const route: RouteDecision =
    raw.route === undefined || raw.route === null
      ? { kind: 'none' }
      : parseRouteRaw(raw.route as RouteRaw, (line) => logger.warn({ line }, '[omd/goal] classify route 槽越界 → 降级 none'));
  return { ...normalizeAxes(raw, opts), route };
}

function normalizeAxes(raw: RawClassification, opts?: AcceptanceCommandBlockOpts): GoalClassification {
  const tier: GoalTier = String(raw.tier ?? '').toLowerCase().includes('simple') ? 'simple' : 'complex';
  const kind = String(raw.acceptance_kind ?? '').toLowerCase();

  if (kind.includes('exec')) {
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    const blocked = acceptanceCommandBlockReason(command, opts);
    if (blocked) {
      logger.warn({ command, blocked }, '[omd/goal] 判执行型但验收命令跑不起来 → 降级探索型 (D-I)');
      return {
        tier,
        acceptance: fallbackExploratory(`执行型但命令不可跑 — ${blocked}`),
        acceptanceProbe: { kind: 'demoted', why: blocked },
      };
    }

    // expectExit 恒 0: 这里定的是**总验收** (绿), 不是 TDD 中途的证红步 (那一步的 expect_exit:1
    // 由 spec 写进图里, 见 spec-author 卡的 TDD 流程段)。
    const nPath = typeof raw.negative_sample_path === 'string' ? raw.negative_sample_path.trim() : '';
    const nBody = typeof raw.negative_sample_content === 'string' ? raw.negative_sample_content : '';
    // 样本缺席**不降级**: 判别力探针是加固不是前置条件 (同空世界自检的 fail-open)。
    // 但要留一行 —— 缺席意味着这条判据只过了一道闸而不是两道, 而那两道问的不是同一个问题。
    if (!nPath || !nBody.trim()) {
      logger.info({ command }, NO_NEGATIVE_SAMPLE);
    }

    return {
      tier,
      acceptance: { kind: 'executable', command, expectExit: 0 },
      ...(nPath && nBody.trim() ? { negativeSample: { path: nPath, content: nBody } } : {}),
    };
  }

  // ── F2 第三格 rubric:结晶期冻下的 checklist,先于产物 ──────────────────────
  //
  // 降级口径与执行型那一支同族:凑不出一份**判得了**的 rubric 就退回探索型并留原话,
  // 不留一个判不了的第三格在那里 —— 那等于既没有机器判据也没有人判据 (仓规坑 ①)。
  if (kind.includes('rubric')) {
    const items = parseChecklist(raw.checklist);
    if (items === null || items.length === 0) {
      const why = 'rubric 型但 checklist 缺席或形状不合法 (每条要有 id 与 requirement)';
      logger.warn({ kind }, `[omd/goal] ${why} → 降级探索型 (F2)`);
      return { tier, acceptance: fallbackExploratory(why), acceptanceProbe: { kind: 'demoted', why } };
    }
    try {
      return { tier, acceptance: { kind: 'rubric', checklist: freezeRubric(items) } };
    } catch (err) {
      // freezeRubric 只在「id 重复 / 空 id / 零条目」时抛 —— 全是冻不出一份可判 rubric 的情形。
      const why = `rubric 冻结失败 — ${String((err as { message?: string }).message ?? err)}`;
      logger.warn({ kind }, `[omd/goal] ${why} → 降级探索型 (F2)`);
      return { tier, acceptance: fallbackExploratory(why), acceptanceProbe: { kind: 'demoted', why } };
    }
  }

  const learningGoal = typeof raw.learning_goal === 'string' ? raw.learning_goal.trim() : '';
  const affordableLoss = typeof raw.affordable_loss === 'string' ? raw.affordable_loss.trim() : '';
  if (!learningGoal || !affordableLoss) {
    // 探索型缺了这两样就退回一个空壳分型 —— 那等于既没有机器判据也没有人判据, 什么都没定。
    // 记 skipped (分类没成立), 原话进 why —— 与 classifyGoal 里分类抛错是同一终局, 只差原话来源。
    return {
      tier,
      acceptance: fallbackExploratory('探索型缺学习目标或可承受损失'),
      acceptanceProbe: { kind: 'skipped', why: '探索型缺学习目标或可承受损失' },
    };
  }
  return {
    tier,
    acceptance: { kind: 'exploratory', learningGoal, affordableLoss },
    acceptanceProbe: { kind: 'exploratory' },
  };

}

/**
 * 教学面的 probe 参数 (D-4, 2026-08-26) —— 给 `classifyPrompt` 用的仓语言证据入口。
 *
 * 给了 `repoRoot` → 派生 prompt 在该根下探 marker / per-root 白名单 / 条件化示例;
 * 不给 → 退 base 白名单, 无仓语言证据段(与改前字节相同, INV-9)。
 *
 * 设计要点:
 *  · 不直接传白名单: prompt 这层只接 "给我仓根", 探仓细节(`existsSync` / marker 名单)
 *    封在 `probeRepo` 里, 教学面不暴露实现面。
 *  · 仓库根上若有 `.git` 之类, 不会被识别为语言 marker —— 只有 `LANGUAGE_PACKS` 里的才是。
 *  · 与 `acceptanceCommandBlockReason` 走的是同一份包表(单源纪律, 不抄第二份)。
 */
export interface ClassifyPromptProbe {
  /** 仓根 —— 给了则在该根下探 marker + per-root 白名单 + 条件化示例。 */
  repoRoot?: string;
  /**
   * 仓环境**真探测**结果 (2026-08-29)。给了就用它,不再只看 marker。
   *
   * 差别不是"多一份数据":marker 表在 80 个真实 python 仓里只认出 50 个,真探测认出 79 个。
   * 差的 29 个根下什么打包文件都没有 —— 对它们,旧路径会走到「拿不准就选 exploratory」
   * 那条**反向**教学句上去。
   */
  envFacts?: EnvFacts;
  /**
   * 仓内契约线索 (2026-09-05, `./criterion-survey` 机械勘察出来的那份原文)。
   *
   * 为什么要它: 分类器此前读不到 README 写死的键名、读不到仓里已经在测这些键的用例 ——
   * 判据写错方向的根因是**输入缺失**。给了这段, 它才有材料把判据指向仓里已有的契约。
   *
   * 缺席 / 空串 / 全空白 ⇒ prompt 与加这一段之前**逐字相同** (加尺子不许动老读数的底线)。
   */
  survey?: string;
}

/**
 * probe 结果 (给 classifyPrompt 与 classifyGoal 共用) —— 检出 marker 列表 + per-root 白名单 +
 * 是否启用 python / js 包(给示例条件化用)。
 */
interface ProbeResult {
  markers: string[];
  allowlist: string[];
  hasPython: boolean;
  hasJs: boolean;
}

/** 在 root 下探语言包 marker, 给 prompt 用。零解析零网络, 与 `allowlistForRoot` 同源。 */
function probeRepo(root: string): ProbeResult {
  const markers: string[] = [];
  let hasPython = false;
  let hasJs = false;
  for (const pack of LANGUAGE_PACKS) {
    if (existsSync(join(root, pack.marker))) {
      markers.push(pack.marker);
      if (pack.bins.includes('pytest')) hasPython = true;
      if (pack.bins.includes('bun')) hasJs = true;
    }
  }
  return { markers, allowlist: allowlistForRoot(root), hasPython, hasJs };
}

/**
 * 三候选共识的开关 (D-6)。**只认字面 `1`** —— 半开的开关 (`true` / `yes` / `0`) 会长成又一个
 * 说不清自己在不在的旋钮; 默认关是因为它要先当单变量臂量一批读数, 不是先上生产。
 */
function consensusEnabled(): boolean {
  return process.env.OMD_CRITERION_CONSENSUS?.trim() === '1';
}

/** 坐标的 provider 前缀 (`claude-code:` / `openai-codex:` / `minimax-cn:` …)。同 provider 视为同族。 */
function providerOf(coord: string): string {
  return coord.split(':')[0] ?? coord;
}

/**
 * 异族座 (D-1): 先取 `verifier` 座; 与 conductor 同 provider 就退 `escalation` 座;
 * 两个都同族 ⇒ **没有异族候选** —— 那时只采两份并记 `crossFamily=false`, 不拿同族凑第三份。
 * (同族自审复用同一个盲点, 凑出来的第三票是一张假票。)
 */
function crossFamilyModel(coord: string): string | undefined {
  const family = providerOf(coord);
  for (const seat of ['verifier', 'escalation'] as const) {
    const m = tryResolveSeatModel(seat)?.model.trim();
    if (m && providerOf(m) !== family) return m;
  }
  return undefined;
}

/**
 * `git ls-files` 的输出集 —— 方向签名里「指向既有文件」那一格的真源 (D-2)。
 * 非 git 仓 / git 调不通 / 没给仓根 ⇒ 空集 (于是那一格一律 false), 且**留一行原文**:
 * 「仓里真没有这个文件」与「我没查成」是两件事 (仓规静默坑 1/2)。
 */
function trackedFiles(root: string | undefined): ReadonlySet<string> {
  if (!root) return new Set();
  try {
    const r = Bun.spawnSync(['git', 'ls-files'], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 5_000 });
    if (r.exitCode !== 0) {
      logger.info(
        { root, exitCode: r.exitCode, err: r.stderr.toString().slice(0, 200) },
        '[omd/goal] 共识: git ls-files 非零退出 → 「指向既有文件」这一格一律 false',
      );
      return new Set();
    }
    return new Set(
      r.stdout
        .toString()
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    );
  } catch (err) {
    logger.info({ root, err: String(err) }, '[omd/goal] 共识: git ls-files 起不来 → 「指向既有文件」这一格一律 false');
    return new Set();
  }
}

/** 分类 prompt。白名单**拼进 prompt** —— 承 conductor prompt 的同一条教训: 不给表就只能猜, 猜错即假红。 */
export function classifyPrompt(goal: string, probe?: ClassifyPromptProbe): string {
  // 真探测优先 (2026-08-29): 有 envFacts 就用实测的语言证据推导教学面, marker 表退居兜底。
  // 两条路产出同一组变量 (allowlist / hasPython / hasJs / 证据段), 下游逐字不变。
  const facts = probe?.envFacts;
  const p = facts
    ? {
        markers: facts.languages.flatMap((l) => l.markers),
        allowlist: [...DEFAULT_COMMAND_ALLOWLIST, ...facts.enabledBins.filter((b) => !DEFAULT_COMMAND_ALLOWLIST.includes(b))],
        hasPython: facts.languages.some((l) => l.language === 'python' && l.enabled),
        hasJs: facts.languages.some((l) => l.language === 'js' && l.enabled),
      }
    : probe?.repoRoot
      ? probeRepo(probe.repoRoot)
      : null;
  // E-T1 强偏段的触发条件 (2026-08-29 起): 真探测下 = **有任何一门语言被实测启用**,
  // 而不是"根下有 marker"。这一改把 29 个只有 .py 和 tests/ 的仓从反向教学里捞出来。
  // ⚠ 兜底那支**逐字保留旧语义** (`hasPython || hasJs`, 不是 `markers.length > 0`):
  // 旧代码对 go/rust 仓不发强偏段。那大概率是个漏, 但改它属于第二个变量 ——
  // 真探测这条路按新规则 (任一语言实测启用), 兜底路一个字不动, 既有调用零改动即绿。
  const hasTestInfra = facts ? facts.languages.some((l) => l.enabled) : Boolean(p && (p.hasPython || p.hasJs));
  const allowlist = p?.allowlist ?? DEFAULT_COMMAND_ALLOWLIST;
  // 例示条件化 (D-4):
  //   · 检出 python 包 → pytest 形状
  //   · 否则检出 js 包 → bun test / tsc --noEmit 形状
  //   · 都无(无 marker, 或 probe 但没检出任何包) → 退回今天形状 (INV-11 「无 marker 仓派生行为与今天一致」)。
  // 注: js bins 全在 base, allowlist 集合与改前相同 (INV-1), 但**示例**按检出条件化,
  // 因为 D-4 钉死的是"教检出证据支持的工具", 不是"教白名单里有什么"。
  // 边界: 无 marker 仓 = 没证据 ≠ 反证据 (INV-11), 不借机改成"删掉示例", 那会变成
  // "看到空仓就什么都别测" 的反例; 今天教什么今天继续教, 不因加了 probe 就收紧教学面。
  const testExampleLine = p?.hasPython
    ? '  · 代码还编不编得过 / 测试绿不绿 → `pytest -q`'
    // `bunx tsc` 不是 `tsc`: 裸 tsc 通常只在 node_modules/.bin 里, 不在 PATH ——
    // 教一条 missingBinaryBlockReason 会拒的形状等于教它踩闸 (2026-08-29)。
    : '  · 代码还编不编得过 / 测试绿不绿 → `bun test` · `bunx tsc --noEmit`';
  // 上面那行「互相独立」教学句的例示 bin —— 也按检出条件化, 让 Python 仓 prompt 不出现
  // `bun test` 字面(否则 INV-8 "示例 0 行" 不能用纯子串断言)。
  const independentAxisExample = p?.hasPython ? 'pytest -q' : 'bun test';
  // 仓语言证据段(只 probe 给时出现)—— 让模型分得清这是事实不是建议, 纠错环也能逐字引回
  // (D-4 单源: 这份事实与运行期 `languageConsistencyBlockReason` 走的同一份 LANGUAGE_PACKS)。
  // 证据段: 有真探测就把**实测事实**原样摆出来 (含每门语言为什么启用/为什么不启用 +
  // 验收命令候选)。模型据此选命令, 而不是猜这个仓长什么样。
  const evidenceSection = facts
    ? [
        '',
        renderEnvFacts(facts),
        '验收命令的首词必须是**上面实测存在**的那些 —— 一条 bin 不在这台机器上的命令是恒红的,',
        '活干对了也过不了 (引擎会当场拒)。拿不准就在白名单里选 base 词 (grep / cat / git …)。',
      ].join('\n')
    : p
      ? [
          '',
          `仓语言证据 (探测自 \`${probe!.repoRoot}\`):`,
          `  · 检出的 marker: ${p.markers.length > 0 ? p.markers.map((m: string) => `\`${m}\``).join(', ') : '(无)'}`,
          `  · 启用的语言包: ${[p.hasPython ? 'python' : null, p.hasJs ? 'js' : null].filter(Boolean).join(' + ') || '(都无)'}`,
          '验收命令首词必须属于「当前白名单 ∩ 该仓启用的语言包」的并集 —— 拿不准就在白名单里选 base 词',
          '(grep / cat / git …), 不要硬造一条不属于该仓语言的判据。',
        ].join('\n')
      : '';
  // 仓内契约线索段 (2026-09-05) —— 排在语言证据段**之后**: 证据面按"从环境到契约"读,
  // 先知道这仓跑什么, 再知道这仓已经写死了什么。
  // ⚠ 缺席 / 空白必须整段不出现 —— 空壳头行也不行 (那会让对照臂的 prompt 字节变了,
  // 于是勘察臂与对照臂的差再也分不清是勘察带来的还是文案漂移)。
  const surveySection =
    probe?.survey && probe.survey.trim() !== ''
      ? [
          '',
          probe.survey,
          '',
          '判据优先指向既有测试文件里已经在测这些标识符的用例 (`pytest -q tests/x.py::test_y` 这种形状),',
          '不要在已有测试覆盖时另写新文件 —— 自己新写的测试, 自己一定过得了。',
          'README / docs 里写明的输出格式、键名、命令行参数、文件名, 是判据必须核的契约:',
          '执行型就指向或新写断言这些键的测试; rubric 就把它们逐条列进 checklist。',
          '既有测试与文档都没覆盖时才新写测试文件, 并在判据命令里写明文件名。',
        ].join('\n')
      : '';
  return [
    '你在给一个自主执行环做**开跑前的两个判断**。只回一个 JSON 对象, 不要别的字。',
    '',
    '判断一 `tier` (成本轴 — 要不要先接地):',
    '  "simple"  = 做法已经确定, 直接动手就行;',
    '  "complex" = 需要先查外部事实或先定契约 (选型 / 新机制 / 跨模块设计)。',
    '',
    '判断二 `acceptance_kind` (判据轴 — **成没成怎么判**):',
    '  "executable"  = 成败机器可判。**必须**同时给 `command`: 一条别人来跑、退出码 0 即算达成的命令。',
    '  "rubric"      = 没有可跑的命令, 但产物好坏**能被人逐条说清** (报告 / 设计 / 文档 / 调研)。',
    '                  给 `checklist`: 一个数组, 每条 {"id":稳定短 id, "requirement":一句可判 yes/no 的要求}。',
    '                  ⚠ 它在你动手之前就冻结, 之后改一个字都会被拒 —— 所以现在就要写得判得动。',
    '                  写不出「可判 yes/no」的条目, 说明这个目标该走 exploratory, 别硬凑。',
    '  "exploratory" = 成败机器判不了, **也逐条说不清** (摸清一个领域 / 选型 / 找出有哪些坑)。',
    '                  给 `learning_goal` (学到什么才算没白跑) 与 `affordable_loss` (愿意为它花掉多少)。',
    '',
    `⚠ 判据轴与成本轴**互相独立**: 一个做法未定的目标, 验收照样可能是机器可判的 (先查清楚怎么做,`,
    `  但做完跑 \`${independentAxisExample}\` 就知道成没成)。别因为 tier=complex 就往 exploratory 上靠。`,
    // E-T1 (2026-08-26, bench 批 7/8 实证): 有语言包 marker = 仓里有测试基建, 「拿不准选
    // exploratory」在这类仓是反向教学 —— 探索型 = 无机器判据 = 引擎不被逼着改代码, 实测
    // 长出 docs-only 病 (24.9KB patch 全是规划文档零源码, reward 0)。证据仓反转教学句;
    // 无 marker 仓保持今天原句 (没证据 ≠ 反证据, INV-11)。
    // 2026-08-29: 触发条件从「有 marker」换成「真探测判**任何一门语言启用**」——
    // marker 版在 80 个真实 python 仓里只认出 50 个, 剩下 29 个只有 .py 和 tests/,
    // 它们此前吃的是下面那条**反向**教学句。
    ...(hasTestInfra
      ? [
          '⚠ 这个仓实测有测试基建 (语言证据见上)。判据轴**强烈偏向 "executable"**:',
          '  改代码的目标几乎总能用「一条会红的测试变绿」来判 —— 拿不准就**先在测试套里找锚**',
          '  (已有的相邻测试文件 / 新建一个最小测试), 而不是退到 exploratory。',
          '  选 "exploratory" 必须在 learning_goal 里说清: 为什么这个仓的测试套锚不住这次改动。',
        ]
      : [
          '⚠ 拿不准就选 "exploratory"。给一条**判不了真假**的命令比承认判不了坏得多 —— 它会让整个环',
          '  以为自己有验收, 而实际上没有。',
        ]),
    '',
    `\`command\` 的首个词必须是这些之一, 否则命令会被安全闸拒绝执行 (看起来像测试失败, 实则没跑):`,
    `  ${allowlist.join(' ')}`,
    '可以用 && 串联 (每环独立过闸); 其它 shell 运算符 **一律拒绝**: 管道 `|` · 重定向 `> <` ·',
    '`;` · `$(...)` · 反引号 · **圆括号 `( )`** · 花括号 `{ }` · 反斜杠 · 换行。**没有 shell**, 只有一串独立的命令。',
    // 2026-07-31 live 冒烟: 分类器写出 `grep -qx "支持格式: CSV, JSON, Excel (.xlsx)" docs/from-api.md`
    // —— 括号在**引号里面**, 它显然以为引号保护得了。闸是对整条命令串做正则扫描的, 引号不参与解析,
    // 所以那条命令被拒 → 降级探索型 → 又一次「本目标没有机器判据」。与 `$` 锚点那次是同一条链,
    // 只是换了个字符。规则讲一遍不够, 得把"引号不豁免"这句明说出来。
    '⚠ **引号保护不了这些字符**: 闸扫的是整条命令串, 不解析引号 —— 写在 `"…"` 里面的 `(` 一样被拒。',
    '  要断言的文本里本身带括号 → 换成不含括号的片段用 `grep -q`, 别硬要整行相等。',
    '',
    // 2026-07-30 live 冒烟: 连着三次判成执行型都因这条降级 (`mkdir` 不在名单 / 用了管道) ——
    // 模型知道规则却仍写出跑不了的命令, 给它两个**照抄就对**的形状比再讲一遍规则有效。
    '写得出来的验收长这样 (照这个形状改, 别自己发明):',
    '  · 文件内容对不对 → `grep -qx "期望的那整行" 路径/文件`  (`-x` = 整行匹配, 匹配不上退出码非 0)',
    '  · 只看包含某段  → `grep -q "期望的片段" 路径/文件`',
    '  · 文件在不在     → `cat 路径/文件`',
    // 第四行按探测到的语言包条件化 (D-4): 见 testExampleLine 的三分支;
    // null = "都无", 该行整段不出现 (只留 grep / cat 形状)。
    ...(testExampleLine ? [testExampleLine] : []),
    // P2b (2026-09-02): bare 整仓 `pytest -q` 若在这个仓里撞上一个跟这次改动无关的既存
    // collection 错误 (2/4/5), 会被空世界自检判定无效 (「测试框架没跑起来」≠「代码被判红」)。
    // 提前说清楚, 比事后重问一次更省一发。
    ...(p?.hasPython ? ['⚠ 若 `pytest -q` 在这仓里撞到一个不相关的既存 collection 错误, 会被判定无效 —— 直接指到具体测试文件更稳 (如 `pytest -q tests/test_foo.py::test_bar`)。'] : []),
    // 2026-07-30 第二次 live 冒烟: 模型照上面的形状写了 `grep -q '^hello omd$' notes/hello.md` ——
    // 形状没错, 锚点里的 `$` 撞了元字符闸。一条 `$` 的连锁是: 命令被拒 → 降级探索型 → 任务文本
    // 写上"没有机器判据·别伪造" → judge 把**真做完**的活读成捏造执行确认 → 整个 goal 报 failed。
    // 所以这一行必须明说, 而不是指望"别用元字符"那条通则被想起来。
    // 2026-07-31 live: 它写的是 `grep -q "相同" docs/from-api.md` —— 而「相同」是**它自己待会儿
    // 要写进文件的结论词**, 执行体两头都握着, 于是这条命令必然满足 (而且「不相同」也含「相同」)。
    // 判据要有意义, 断言的东西就必须是执行体**改不动**的: 源材料里的值、一条命令的退出码。
    '⚠ **断言要落在「输入里的值」上, 别断言你自己待会儿要写的结论词。**',
    '  反例: 让摘要写"两处相同"然后 `grep -q "相同" 摘要` —— 你两头都握着, 这条命令必然过, 什么也没验。',
    '  正例: 断言源材料里那个**具体的数**出现在产物里 (`grep -q "100" docs/from-api.md`)。',
    '⚠ 这条命令**在活还没干之前必须是红的** —— 它这时候就绿, 说明它跟这次要做的事无关 (会被自检拒)。',
    '⚠ **别在 grep 里用正则锚点 `^` `$`** —— `$` 会被安全闸拒 (整条命令因此跑不起来)。',
    '  要"整行严格相等"就用 `-x`, 它就是干这个的。同理别用 `*` 之外的花哨正则。',
    '写不出这种单条命令 (要 mkdir、要管道过滤、要人眼看输出) = 这个目标机器判不了 → 老实选 exploratory。',
    '',
    // G4 (2026-07-31): 上面那条"别断言你自己要写的结论词"是**讲道理**, 而讲道理拦不住 live 里
    // 真发生的事 (它照样写了 `grep -q "相同"`)。这里改成**让它自己举一个反例** —— 举得出来,
    // 引擎就能拿去跑一遍: 命令在这份错答案上照样通过 = 这条判据判不了成败, 当场降级。
    // 顺带的副作用正是想要的: 一条判据要举得出"什么样算错", 它多半本来就想清楚了。
    '',
    '判成 executable 时**再给一份反面样本** (`negative_sample_path` + `negative_sample_content`):',
    '  **一份明显错的产物长什么样** —— 相对路径 + 两三行内容。引擎会把它写进一个临时目录、',
    '  在那里跑一遍你给的 `command`: **命令必须在这份错答案上失败**。它要是照样通过, 说明这条',
    '  命令对的错的都满足、判不了成败 —— 那时整个目标会被降级成 exploratory。',
    '  例: 命令 `grep -q "100" docs/from-api.md` → 反面样本 path=`docs/from-api.md`,',
    '      content=`本文档汇总了接口支持的格式与限制。` (没有那个数 → 命令失败 → 这条判据是判别的)',
    '',
    // P3 S7 (D-19 / INV-12): 路由槽合进同一发 —— 动手前只许一次 LLM 调用, 路由不另起第二发。
    '',
    '判断三 `route` (拓扑轴 — 这件事天然是不是一条线性阶段链):',
    '  缺省 {"kind":"none"}: 交给执行环自己决定形状 (绝大多数目标选这个)。',
    '  只有当目标**天然是 ≥2 个串行阶段、且前一阶段的产物是后一阶段的输入** (先调研再实施再验证 /',
    '  先列清单再逐项处理) 才给 {"kind":"chain","chain":{"stages":[{"id":短id,"word":词表词,"goal"?:一句话,"command"?:确定性命令}]}}。',
    `  \`word\` 只许这 ${STAGE_WORDS.length} 个: ${STAGE_WORDS.join(' / ')}; agent/research/verify/judge/synthesize 必给 goal, command 必给 command。`,
    '  写不出 ≥2 个各自有产物的阶段 → 老实 none, 别硬拆。',
    '',
    '形状: {"tier":"simple"|"complex","acceptance_kind":"executable"|"rubric"|"exploratory",',
    '       "command"?:string,"negative_sample_path"?:string,"negative_sample_content"?:string,',
    '       "checklist"?:[{"id":string,"requirement":string}],',
    '       "learning_goal"?:string,"affordable_loss"?:string,',
    '       "route"?:{"kind":"none"}|{"kind":"chain","chain":{"stages":[{"id":string,"word":string,"goal"?:string,"command"?:string}]}}}',
    '',
    evidenceSection,
    ...(surveySection ? [surveySection] : []),
    '',
    `目标: ${goal}`,
  ].join('\n');
}

/**
 * 跑分类 (一次调用出两条轴)。无 generate/model, 或调用/解析失败 → 全保守档
 * (`complex` + 探索型兜底), **不抛** —— 分类是路由不是闸, 挂了该继续往下走。
 *
 * **命令被闸拒时带因重试一次** (2026-07-30 第二次 live 冒烟逼出来的): 降级探索型的代价远不止
 * "少一条命令" —— 探索型会把「本目标没有机器判据, 不要伪造一个」写进任务文本, 而内环 judge 读到
 * 它之后, 把执行体**真做完**的活 (文件写对了、cat 出来了) 判成了"捏造执行确认", 整个 goal 报
 * failed。一条 `$` 锚点的连锁能走这么远, 就值得为它多花一次分类调用。
 *
 * 重试**必须带上闸的原话**, 不是原样重问 —— 同 L0 重试与内环 prevReason 那条纪律: 原样重放对
 * 确定性失败是纯烧钱 (模型刚才就是照着规则写的, 它不知道自己踩的是哪一条)。只重试一次: 两次还
 * 写不出可跑命令, 那多半是这个目标真的机器判不了, 那时降级探索型是**对的答案**而不是失败。
 */
/**
 * D-19 / INV-12 (2026-09-02): 对外这一个入口出**恰一次**结构化调用, 同时带出 tier / acceptance /
 * route 三条轴。P3 S7 把 route 槽真实装进了 `classifyPrompt` (判断三) 与 `normalizeClassification`
 * (经 `parseRouteRaw` 钳到封闭枚举); S6a 期间这里恒 `{kind:'none'}` 的占位由此撤销。
 * `routeChain` / `configureRouteCaller` 仍导出但**全仓非测试代码零调用** —— 路由不再是第二发。
 * 无分类器 (缺 generate/model) 的回落分支不经 normalize, 这里的 `?? none` 只兜那一条。
 */
export async function classifyGoal(
  goal: string,
  deps: Parameters<typeof classifyGoalCore>[1],
): Promise<GoalClassification> {
  // R-1 (2026-09-03): 动手前 LLM 调用数 —— 在 generate 外面数, 不改 core 的任何返回路径 (它有六条)。
  // 缺 generate = 分类器没走 LLM → null (不是 0: 0 是"走了 LLM 且一发没打", 不存在这种事)。
  let llmCalls = 0;
  const counted: typeof deps = deps.generate
    ? { ...deps, generate: async (req) => { llmCalls++; return deps.generate!(req); } }
    : deps;
  const result = await classifyGoalCore(goal, counted);
  return { ...result, route: result.route ?? { kind: 'none' }, llmCalls: deps.generate ? llmCalls : null };
}

async function classifyGoalCore(
  goal: string,
  deps: {
    generate?: GenerateFn;
    model?: string;
    /**
     * 给了则对判出的执行型命令做一次**空世界自检**(见 `acceptanceVacuityReason`):
     * 活还没干之前它就过 = 它不是判据 → 降级探索型并把原因写进学习目标。
     * 省略 = 不自检(fail-open;自检是加固不是前置条件)。
     */
    runCommand?: (input: { command: string }) => Promise<{ exitCode: number | null }>;
    /**
     * #204 (承 #199 D1): 真仓根。给了则**判别力探针**的反面世界建成 HEAD 的真副本
     * (`git archive` + node_modules 软链), 而不是一个空目录 —— 空目录里 `bun test` / `tsc` /
     * 相对路径 grep 必然失败, 于是探针恒判「分得出」, 量的是尺子不是被测物 (账本: 69 跑 0 红)。
     * 省略 = 退回空目录形态 (fail-open, 原因进 why)。
     */
    repoRoot?: string;
    /**
     * 仓内契约线索原文 (2026-09-05, `./criterion-survey` 的 `text`)。原样进 `classifyPrompt`。
     * 缺席 / 空串 ⇒ 那一发的 prompt 与加这一段之前逐字相同。
     */
    survey?: string;
  },
): Promise<GoalClassification> {
  const { generate, model, runCommand, repoRoot, survey } = deps;
  if (!generate || !model) {
    return {
      tier: 'complex',
      acceptance: fallbackExploratory('无分类器 (缺 generate/model)'),
      acceptanceProbe: { kind: 'skipped', why: '无分类器 (缺 generate/model)' },
    };
  }

  // 教学面 probe (D-4, 2026-08-26) —— 给 `classifyPrompt` 仓根, 让白名单与示例按检出条件化;
  // 闸拒路径 (D-5) 走既有 correction 通道, normalize 同时接 per-root opts, 让 Python 仓写
  // `bun test` 走 lang-mismatch 闸拒并降级。两者都不新增第二问 / 第二拒通道。
  // 真探测**一次**, 两处消费 (prompt 教学面 + 命令闸)。放在这里而不是各自探:
  // 探测走文件系统遍历 (有界, 但不是零成本), 而 `allowlistForRoot` 那种每次调用都重算的位置
  // 受不起它 —— 所以只在每个 goal 的入口探一次, 然后一路传下去。
  const envFacts = repoRoot ? probeEnvFacts(repoRoot) : undefined;
  if (envFacts) {
    logger.info(
      { root: repoRoot, langs: envFacts.languages.filter((l) => l.enabled).map((l) => l.language), candidates: envFacts.testCommandCandidates },
      '[omd/goal] 仓环境真探测 (语言证据 + PATH 上的 runner)',
    );
  }
  // 勘察在场时也要造 probe —— 哪怕没给 repoRoot: 那两件事各自独立 (一个是环境证据, 一个是契约线索),
  // 用 repoRoot 门控 survey 会让它在没有仓根的调用上被静默吞掉。
  const probe: ClassifyPromptProbe | undefined =
    repoRoot || survey
      ? { ...(repoRoot ? { repoRoot } : {}), ...(envFacts ? { envFacts } : {}), ...(survey ? { survey } : {}) }
      : undefined;
  const blockOpts: AcceptanceCommandBlockOpts = repoRoot ? { root: repoRoot, ...(envFacts ? { envFacts } : {}) } : {};

  // `seat` 只在三候选共识那条路上给 (D-1 的异族座那一发); 省略 = conductor 座, 与共识关闭时逐字相同。
  const ask = async (correction: string, seat?: string): Promise<GoalClassification> => {
    const { text } = await generate({
      model: seat ?? model,
      // 判据轴是防作弊的地基, 它那一发尤其该看得见 (D-I / G4 两条闸都压在这个 prompt 上)。
      traceName: 'classify:acceptance',
      messages: [{ role: 'user', content: `${classifyPrompt(goal, probe)}${correction}` }],
      // 400 会被推理族的 reasoning 吃光 → 正文截断 → JSON.parse 抛 → 全保守档 (complex + 探索型)。
      // 2026-07-31 S3 live 实测撞到: `deepseek-v4-pro 输出撞到上限 out=400 cap=400 — 正文被截断`,
      // 后果是**验收分型在这条路上基本判不出执行型**, D-I 又一次形同虚设 —— 与 `$` 锚点链是同一个
      // 后果、不同的成因。llm-judge.ts:89 早就为同一件事付过一次账 (700 → 空裁决), 这里没照做。
      //
      // 为什么是 32_768 而不是"干脆不给": **省略不等于不限**。三条传输路的兜底各不相同 ——
      // openai-兼容路 (`model/index.ts:243`) 省略 = `max_tokens` 字段根本不发 → 吃 provider 自己的
      // 默认 (DeepSeek 官方默认 4K 级); pi 路 (`pi-transport.ts:403`) 省略 = 吃 pi 的默认;
      // 只有 anthropic 路省略才落到该模型官方上限。给显式值反而更稳: 同一处 `Math.min(ceiling)`
      // 会按 `model-caps` 把它收敛到该座位的官方上限, 超发不会 400。
      // 32_768 是仓里"实际等于不设限、且在每个已登记座位上都安全"的那个数 (最小已登记上限是
      // qwen3.7 的 65_536), conductor / plan / synth 用的都是它。输出本身 ~200 字符, 按实发计费,
      // 抬 cap 不花钱。
      maxTokens: 32_768,
    });
    return normalizeClassification(JSON.parse(extractJsonObject(text)) as RawClassification, blockOpts);
  };
  /** 过了闸的执行型再过**两道**探针; 任一响 → 降级探索型(理由原样带走)。 */
  const vet = async (c: GoalClassification, attempt = 1): Promise<GoalClassification> => {
    if (c.acceptance.kind !== 'executable') return c;
    // 先把 command 抽出来再进闭包: 闭包捕获 c 时 TS 不保留对 c.acceptance.kind 的收窄
    // (TS2339: command 在 exploratory 分支上不存在) —— 抽出 = 窄化, 不是断言。
    const command = c.acceptance.command;
    // 两道问的**不是同一个问题**, 所以是串联不是二选一:
    //   ① 空世界自检   —— 活还没干之前它就绿? → 判据**恒真**(需要注入的 runner, 在真 cwd 上跑)
    //   ② 反面样本探针 —— 一份错的产物骗得过它? → 判据**不判别**(自带 runner, 在临时世界里跑)
    // ① 抓不到 live 那条 `grep -q "相同"`(空世界里文件不存在 → 命令失败 → 放行), ② 才抓得到。
    const demoteG4 = (why: string): GoalClassification => {
      logger.warn({ command, why }, '[omd/goal] 验收命令没过判据探针 → 降级探索型 (G4)');
      return {
        tier: c.tier,
        acceptance: fallbackExploratory(`${why} 原命令: \`${command}\``),
        acceptanceProbe: { kind: 'demoted', why },
      };
    };
    const v: ProbeVacuityVerdict = runCommand
      ? await probeVacuity(command, runCommand, c.acceptance.expectExit)
      : { status: 'fail_open' }; // 没给 runner = 不自检 (fail-open, 不降级)
    if (v.status === 'ring') return demoteG4(v.why);
    // P2b: `invalid` (bare 整仓 pytest 命中 2/4/5) 与 `ring` 不同 —— 命令没给出判词, 不是判词恒真,
    // 所以给模型**一次**改口的机会(换成文件级判据), 而不是当场降级。二答仍无效才走 demoteG4
    // (镜像 D-I 闸拒重试: 恰一次, 不无限重试)。
    if (v.status === 'invalid') {
      if (attempt >= 2) return demoteG4(v.why);
      logger.info({ command, why: v.why, attempt }, '[omd/goal] 整仓 pytest 判据判定无效');
      const retried = await ask(
        `\n\n⚠ 你上一次给的验收命令在空世界自检里判定无效, 原话是:\n  ${v.why}\n` +
          '换一条指到具体测试文件的 pytest 命令 (如 `pytest -q tests/test_foo.py::test_bar`); ' +
          '实在写不出就老实选 exploratory —— 别硬凑一条整仓命令。',
      );
      return vet(retried, attempt + 1);
    }
    const d = await probeDiscrimination(command, c.negativeSample, c.acceptance.expectExit, repoRoot ? { repoRoot } : {});
    if (d.status === 'ring') return demoteG4(d.why);
    // 两道都没响 (没有 ring)。**剩下的组合别压成一个 kind** —— 「探针跑不起来」与「分类器没给
    // 反面样本」是两件不同的事, 而账本这一列存在的全部理由就是事后分得开:
    //   - 跑不起来 (`fail_open`) = 环境/实现问题, **该修**;
    //   - 没给样本 (`skipped`)   = 模型行为, **该量** (G4 收尾判据要的正是这个频率)。
    // ⚠ 第一版把两者都记成 `vacuity-only`, 而那个词的意思恰恰是"空世界那道跑了、判别那道没跑" ——
    // 于是 `v.status==='fail_open'` (空世界没跑成) 被贴上"空世界跑了"的标签, **标签是反的**。
    // 抓到它的是本仓的 verifier 而不是 tsc/test (那次跑 2159 pass 全绿), 记一笔: 这是
    // 「oracle 绿 ≠ 语义对」的又一个真样本, 也是 mustNotName / 两种 NULL 那族"别把两件事压成一件"。
    // fail-open 语义不变: 下面任何一支都**不降级**, 执行型照收。
    const failOpenWhy =
      v.status === 'fail_open'
        ? `空世界自检未能运行${d.status === 'fail_open' ? `; ${d.why}` : ''}`
        : d.status === 'fail_open'
          ? d.why
          : null;
    const probe: AcceptanceProbe = failOpenWhy
      ? { kind: 'skipped', why: failOpenWhy }
      // #205: **必须排在 passed-both 之前**。漏了这一支它会静默落进最后那个 `passed-both`,
      // 也就是把「判别力没被证明」记成「证明过了」—— 正是本格要防的那件事本身。
      : d.status === 'unproven-missing'
        ? { kind: 'unproven-missing' as const, why: d.why, missing: d.missing }
      : d.status === 'skipped'
        ? { kind: 'vacuity-only', why: d.why }
        : d.status === 'ok' && d.why
          ? // #204: 探针过了, 但**这次过得值多少钱**要写下来 —— 反面世界退回过空目录 (那次通过
            // 什么都没证明), 或某几段零判别力。记进账本而不是只 log: 本仓的每条纪律都要能被量,
            // 而 log 量不了 —— #199 就是靠账本那一列才量出「69 跑 0 红」的。
            { kind: 'passed-both' as const, why: d.why }
          : { kind: 'passed-both' };
    return { ...c, acceptanceProbe: probe };
  };

  /**
   * 三候选共识 (D-1..D-5): 同一份 prompt 采 n 份 → 抽方向签名 → 量一致性 → 按 D-4 择一。
   * **只量, 不拦不升级** —— 歧义在本版只进账本 (`ambiguous`), 不改任何一条控制流。
   * 一份都没拿到 ⇒ `undefined`, 调用方回落共识关闭时的单发那条路 (失败语义原样不变)。
   */
  const sampleConsensus = async (): Promise<{ chosen: GoalClassification; ledger: CriterionConsensus } | undefined> => {
    // D-1 的温度那一句今天发不出去: `GenerateFn` 这个接缝没有采样通道, 而 conductor 座的采样意图
    // (`model/seats.ts`) 恰好是空的 —— 两发同参, 发散来自 provider 自己的默认温度。
    // 座位真配了温度而这里发不出去时留一行: 一个到不了调用上的旋钮该出声, 不该静默消失。
    const sampling = effectiveSeatSampling('conductor');
    if (sampling.temperature !== undefined || sampling.topP !== undefined) {
      logger.info({ sampling }, '[omd/goal] 共识: conductor 座采样意图发不出去 (GenerateFn 无采样通道) → 两发同参');
    }
    const cross = crossFamilyModel(model);
    const seats = [model, model, ...(cross ? [cross] : [])];
    // 并发采 —— 三发之间没有依赖, 串起来只是把分类那一站的墙钟乘三。
    const settled = await Promise.allSettled(seats.map((m) => ask('', m)));
    const got: GoalClassification[] = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') got.push(s.value);
      // 缺席 ≠ 空, 且**不重试** (D-1): 少一份候选照常比, 但原文要留下 (仓规静默坑 2)。
      else logger.warn({ seat: seats[i], err: String(s.reason) }, '[omd/goal] 共识候选缺席 (不重试)');
    });
    if (got.length === 0) {
      logger.warn({ seats: seats.length }, '[omd/goal] 共识候选全挂 → 回落单发分类那条路');
      return undefined;
    }
    const existing = trackedFiles(repoRoot);
    const cands = got.map((c) => {
      const sig = directionSignature(c.acceptance, existing);
      return { spec: c.acceptance, sig, surveyHits: surveyHits(sig, survey ?? '') };
    });
    const a = agreement(cands.map((c) => c.sig));
    const pick = chooseCandidate(cands);
    const ledger: CriterionConsensus = {
      n: cands.length,
      crossFamily: cross !== undefined,
      kindAgreement: a.kindAgreement,
      agreement: a.agreement,
      ambiguous: pick.ambiguous,
      chosenIndex: pick.index,
      kinds: cands.map((c) => c.sig.kind),
    };
    logger.info({ ...ledger, why: pick.why }, '[omd/goal] 判据三候选共识 (本版只量, 不拦不升级)');
    return { chosen: got[pick.index]!, ledger };
  };

  /** 这次分类的共识读数; 共识没开 / 全挂时恒缺席。下面每条返回路径都经 {@link finish} 挂上它。 */
  let consensus: CriterionConsensus | undefined;
  const finish = (c: GoalClassification): GoalClassification => (consensus ? { ...c, criterionConsensus: consensus } : c);

  try {
    // 共识关闭时这两行逐字等价于原来的 `const first = await ask('')` —— 零多余调用、prompt 零变化 (INV-4)。
    const sampled = consensusEnabled() ? await sampleConsensus() : undefined;
    consensus = sampled?.ledger;
    const first = sampled?.chosen ?? (await ask(''));
    // 重试只有两种情况: ① "想判执行型却因命令跑不起来被降级" (闸拒, 原因串是唯一凭据);
    // ② E-T1b (2026-08-26): **marker 仓老实选探索型** —— bench 批 9 实证散文偏置扳不动分类器
    // (探索型 5/10, 其均值 0.124 vs 执行型 0.457), 按仓规做成机械追问: 有测试基建的仓选探索型
    // 要么自证要么改判, 追问恰一次, 二答照收 (有界, 不锁死模型的最终判断)。
    // 其余情况的探索型不重试 —— 那是它的判断, 不是失误。
    const blockedReason = firstBlockedReason(first);
    if (!blockedReason) {
      // 追问的触发证据 (2026-08-29): 真探测在场就用它 —— 「哪门语言实测启用」比「根下有没有
      // 打包文件」强得多, 而追问只在**首判探索型**时才发, 触发面变宽不会多花任何一发。
      // 实测:marker 版在 code80 上全批只响 2 次, 而 29 个仓压根不在它的视线里。
      const evidence = repoRoot && first.acceptance.kind === 'exploratory'
        ? (envFacts
            ? envFacts.languages.filter((l) => l.enabled).map((l) => `${l.language}(${l.markers[0] ?? `${l.sourceFiles} 个源文件`})`)
            : probeRepo(repoRoot).markers)
        : [];
      if (evidence.length > 0) {
        logger.info({ evidence }, '[omd/goal] 有测试基建的仓首判探索型 → 机械追问一次 (E-T1b: 自证或改判)');
        return finish(await vet(
          await ask(
            `\n\n⚠ 复核: 这个仓实测有测试基建 (${evidence.join(', ')}) —— 改代码的目标几乎总能用` +
              '「一条会红的测试变绿」来判。请二选一:\n' +
              '  a) 改判 "executable": 在测试套里找锚 (相邻测试文件 / 新建最小测试), 给出可跑 command;\n' +
              '  b) 坚持 "exploratory": 但 learning_goal 首句必须写明**为什么这个仓的测试套锚不住这次改动**。',
          ),
        ));
      }
      return finish(await vet(first));
    }
    logger.info({ blockedReason }, '[omd/goal] 验收命令被闸拒 → 带上闸的原话重问一次 (D-I)');
    let second = await ask(
      `\n\n⚠ 你上一次给的验收命令**被安全闸拒了**, 原话是:\n  ${blockedReason}\n` +
        // 2026-07-31 live: 重试拿到的是同一条命令换了全角标点, 括号原样留着 —— 闸的原话里明明
        // 列了 `( )`。也就是说它读到了规则却仍然踩, 唯一说得通的解释是**它以为引号保护得了**。
        // 所以纠正文案必须点破那个假设, 而不是再念一遍名单。
        '⚠ 闸扫的是**整条命令串, 不解析引号** —— 写在 `"…"` 里面的 `( ) { } | ; $ < >` 一样被拒。\n' +
        '换一条能过闸的单条命令: 断言的文本里带括号就**别要整行相等**, 改成不含括号的片段 + `grep -q`。' +
        '(整行相等只在那一行本身干净时用 `grep -qx "整行" 文件`; 别用 `^ $` 锚点。)' +
        '实在写不出能过闸的命令, 就老实选 exploratory —— 别硬凑一条跑不起来的。',
    );
    const stillBlocked = firstBlockedReason(second);
    if (stillBlocked) {
      logger.warn({ stillBlocked }, '[omd/goal] 重试后仍写不出可跑命令 → 降级探索型 (这次多半是真判不了)');
      // 裁决原样带走: 这次降级的凭据是**重试那次**的闸因 (normalize 里那次记的可能是同一串, 这里以重试为准)。
      second = { ...second, acceptanceProbe: { kind: 'demoted', why: stillBlocked } };

    }
    return finish(await vet(second));

  } catch (err) {
    logger.warn({ err: String(err) }, '[omd/goal] 分类调用/解析失败 → 全保守档 (complex + 探索型)');
    return finish({
      tier: 'complex',
      acceptance: fallbackExploratory('分类调用或解析失败'),
      acceptanceProbe: { kind: 'skipped', why: String(err) },
    });
  }
}

/**
 * 把分类器给的 `checklist` 原样解析成条目数组。**弱模型不可信原则**:形状不对就返 `null`,
 * 由调用方降级探索型并留原话 —— 不在这里"尽量凑出几条", 凑出来的 rubric 判不了卷。
 *
 * `null` 与 `[]` 是两件事:前者是形状不合法, 后者是给了个空清单。两者调用方都降级,
 * 但降级原话里分得开(仓规坑 ①)。
 */
function parseChecklist(raw: unknown): RubricItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RubricItem[] = [];
  for (const el of raw) {
    if (typeof el !== 'object' || el === null) return null;
    const { id, requirement } = el as { id?: unknown; requirement?: unknown };
    if (typeof id !== 'string' || typeof requirement !== 'string') return null;
    if (id.trim() === '' || requirement.trim() === '') return null;
    out.push({ id: id.trim(), requirement: requirement.trim() });
  }
  return out;
}

/** 这次分类是不是"想判执行型却被闸拒"→ 返闸的原话; 其它情况 → null (不重试)。 */
function firstBlockedReason(c: GoalClassification): string | null {
  // F2: 加了第三格之后 `!== 'exploratory'` 不再等于「执行型」, 改成正判那一格。
  if (c.acceptance.kind !== 'exploratory') return null;
  const m = /执行型但命令不可跑 — (\[blocked[^\]]*\])/.exec(c.acceptance.learningGoal);
  return m?.[1] ?? null;
}

/** 从模型输出里抠出第一个 JSON 对象 (容忍 ```json 围栏与前后散文)。抠不到 → 原样返 (交给 JSON.parse 抛)。 */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * **冻结的判卷标准** —— 同一份文本进 spec 起草 prompt、进 execute 的任务文本。
 *
 * 一份而不是两份是要点: 判卷标准分两处写, 两处就会漂, 而"判据漂了"正是作弊达标最舒服的入口。
 */
export function renderAcceptance(a: AcceptanceSpec): string {
  if (a.kind === 'executable') {
    return [
      '## 判卷标准 (冻结 — 执行型)',
      '本目标的达成判据是**这一条命令**, 由外部来跑, 退出码即结论:',
      '```',
      a.command,
      '```',
      `期望退出码: ${a.expectExit}。`,
      '',
      '这条命令与它所断言的东西在实施开始前即已冻结。实施过程中**不许**改动它, 也不许改动它所',
      '依赖的断言 —— 需要改判据说明判据错了, 那是要回来重新定的事, 不是实施途中顺手做的事。',
    ].join('\n');
  }
  if (a.kind === 'rubric') {
    return [
      '## 判卷标准 (冻结 — rubric 逐条判)',
      '本目标没有可跑的验收命令, 判据是下面这份 checklist。它在你动手**之前**就已经冻结,',
      '由另一方写下, 验收时逐条判 yes/no 并逐条留下理由:',
      '',
      ...a.checklist.items.map((it, i) => `${i + 1}. [${it.id}] ${it.requirement}`),
      '',
      '这份 checklist 连同它的内容哈希一并冻结。**改动其中任何一个字都会被当场拒**, 并且拒了就不判 ——',
      '判卷标准冻在环外正是为了防「实施途中把球门挪到自己够得着的地方」。',
      '要改判据说明判据错了, 那是回来重新定的事, 不是实施途中顺手做的事。',
    ].join('\n');
  }
  return [
    '## 判卷标准 (冻结 — 探索型)',
    '本目标**没有机器判据** —— 不要伪造一个 (给一条判不了真假的命令比承认判不了坏得多)。',
    `- 学习目标: ${a.learningGoal}`,
    `- 可承受损失: ${a.affordableLoss}`,
    '',
    '判不了成败时能定的只有亏损上限。到了上限还没弄清楚, 就停下来把已知与未知交出去,',
    '不要靠多跑几轮蒙过去。',
  ].join('\n');
}
