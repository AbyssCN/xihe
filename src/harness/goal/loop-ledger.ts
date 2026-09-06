/**
 * src/harness/goal/loop-ledger —— R-1 读数进账本: 编排循环父 run 的 `loop` 列 (设计 `docs/plan/2026-09-03-r1-ledger-columns.md`)。
 *
 * 两样东西:
 *  · {@link LoopLedger}: 写进 `omd_dag_runs.loop` (JSON) 的**最终**形状, 由 run-goal 收尾时组装, goal.ts 经 `recorder.updateLoop` 回填父行。
 *  · {@link ConductorCardLedger}: 运行期**可变**计数器, run-goal 造一个, 经 `buildConductorFace` 交给七张卡的运行期适配层与只读 bash 闸,
 *    D-14 回灌的第二跑**沿用同一个**(两跑合并计数: 读数问的是「这趟 run」, 不是「这一跑」)。
 *
 * 三态纪律 (仓规静默坑 1): 整列 NULL = 没走循环 / 老记录; `verifier.firstVerdict: null` = 没调 (≠ fail);
 * `cards.byCard` 缺键 = 那张卡一次没派成 (调用数在 `calls`); `dispatches[].briefHasRepro: null` = 该卡没有 brief 槽。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRelativePath } from '../repo-path';
import type { RunGit } from '../dag/writeset-evidence';
import type { JudgingTruths } from '../verifier';

export type ConductorCardName = 'work' | 'spawn' | 'map' | 'explore' | 'best_of' | 'research' | 'decompose';

import type { AcceptanceProbe } from './acceptance-gate';
import type { CriterionSurveyFacts } from './criterion-survey';
import type { CriterionConsensus } from './criterion-consensus';
import type { ImpactPackFacts } from './impact-pack';
import type { RunnerReady } from './runner-ready';

export interface LoopDispatch {
  seq: number;
  card: ConductorCardName;
  nodes: number;
  /** brief 里有没有粘运行输出 —— **启发式** (见 {@link briefHasRepro}), 量的不是"复现对不对"。null = 该卡没有 brief 槽。 */
  briefHasRepro: boolean | null;
  resumeOf?: string;
  /** 子 run 里 status !== 'done' 的节点数; 子 run 抛错 (没有结果) 时缺席。 */
  failed?: number;
  /** 子 run 抛错 (引擎侧事故), 原文头 200 字。 */
  error?: string;
  /** 派发产物上 ledger 自己看 (与判卷官无关)。子图每个 leaf.filesTouched 的并集、按出现顺序去重。空 = 子 run 没产出任何文件 (跑挂 / 抛错 / 没人写过)。 */
  filesTouched?: string[];
  /** 子 run 里 status === 'done' 的节点数。空 = 子 run 没产出 (跑挂 / 抛错)。 */
  done?: number;
  /** 写集对账: declared = 该派发 plan 里所有节点的 `write_set` 并集 (按出现顺序去重); orphan = 实际写了但没人声明; missing = 声明了但没人写。null = 该派发 plan 没有任何节点声明写集 (没合同 = 不判)。 */
  writeSet?: { declared: string[]; orphan: string[]; missing: string[] } | null;
  /**
   * W2 (2026-09-06): 这次派发**机械交接**给子节点的读账字符数 (见 `../read-ledger`)。
   *
   * 三态别压平 (§静默坑 1): 缺席 = 这条路没装读账 (非 `work` 卡 / 老记录 / 测试没注入);
   * `0` = 装了但账是空的 (conductor 一步勘察都没做就派活) —— 后者正是要能数出来的形态。
   * 塌了怎么读 (契约预注册): reward 掉 > 1σ 时先看这一列的分布, 交接段有没有把错误的勘察结论
   * 固化进子节点。
   */
  handoffChars?: number;
  /**
   * 盘上差集里**写工具没报**的文件数 (2026-09-06): worker 经 shell 改的那部分。缺席 = 没拍快照 (非 git 仓 / git 失败,
   * 原因在日志); 0 = 拍了, 工具上报与盘上一致。NULL ≠ 0 (仓规坑 ①)。
   */
  diskTouched?: number;
}

/**
 * 写集对账: declared = 合同写的; orphan = 实际动了合同没说; missing = 合同说了没动。
 * 纯函数: 入参按出现顺序决定输出顺序; 重复路径以首次出现为准 (去重)。空 declared 与空 touched
 * 都合法 (空 declared → 全空; 空 touched → orphan 空, missing = declared)。
 *
 * falsify (本函数必须能真红): 把 `seen.has(p)` 改成不维护 → first dispatch 的 filesTouched 顺序里 A 出现两次。
 */
export function reconcileWriteSets(declared: string[], touched: string[]): { declared: string[]; orphan: string[]; missing: string[] } {
  const declaredOut: string[] = [];
  const seenDeclared = new Set<string>();
  for (const p of declared) {
    if (seenDeclared.has(p)) continue;
    seenDeclared.add(p);
    declaredOut.push(p);
  }
  const touchedOut: string[] = [];
  const seenTouched = new Set<string>();
  for (const p of touched) {
    if (seenTouched.has(p)) continue;
    seenTouched.add(p);
    touchedOut.push(p);
  }
  const touchedSet = seenTouched;
  const declaredSet = seenDeclared;
  const orphan = touchedOut.filter((p) => !declaredSet.has(p));
  const missing = declaredOut.filter((p) => !touchedSet.has(p));
  return { declared: declaredOut, orphan, missing };
}

/**
 * 给一个派发 (plan + 子 run exec) 算三层事实: filesTouched 并集 (按出现顺序去重) ·
 * done 数 (status === 'done') · 写集对账。
 *
 * falsify (本函数必须能真红): 把 `if (!node.write_set) continue;` 去掉 → declared 里出现空数组也参与拼接, 测试 (a) 第二组 `{[A] declared [A,B]} → declared = [A,B]` 仍过但 union dedup 那条会因 `seen.has` 在错误层失败而爆。注释把这条不变量写在调用处。
 */
export function computeLoopDispatchFacts(
  plan: { nodes: Record<string, { write_set?: string[] }> },
  exec: { results: Record<string, { filesTouched?: string[]; artifactRoot?: string; status: 'done' | 'failed' | 'skipped' }> },
  /**
   * 仓根 (2026-09-06): 把 leaf 上报的绝对路径按 `leaf.artifactRoot ?? root` 转成相对路径再对账。
   * 缺席 = 不归一 (老调用零改动)。为什么必须归一见 `repo-path.ts` 头注: 两套写法逐字比不上 →
   * 假 orphan / 假 missing → 判官「产物不存在」。
   */
  root?: string,
  /**
   * 盘上真实改动 (2026-09-06, writeset/disk-delta): 派发前后快照差集, 已是相对仓根路径。
   * 并进 touched 再对账 —— worker 经 shell 改的文件不经写工具, 只靠 `filesTouched` 会全记成 missing。
   * 缺席 = 没拍快照 (老调用零改动)。
   */
  diskTouched?: readonly string[],
): { filesTouched: string[]; done: number; writeSet: { declared: string[]; orphan: string[]; missing: string[] } | null } {
  const filesTouched: string[] = [];
  const seenTouched = new Set<string>();
  let done = 0;
  for (const leaf of Object.values(exec.results)) {
    if (leaf.status === 'done') done++;
    const base = leaf.artifactRoot ?? root;
    for (const raw of leaf.filesTouched ?? []) {
      const f = repoRelativePath(base, raw);
      if (seenTouched.has(f)) continue;
      seenTouched.add(f);
      filesTouched.push(f);
    }
  }
  for (const raw of diskTouched ?? []) {
    const f = repoRelativePath(root, raw);
    if (seenTouched.has(f)) continue;
    seenTouched.add(f);
    filesTouched.push(f);
  }
  const declared: string[] = [];
  const seenDeclared = new Set<string>();
  let anyDeclared = false;
  for (const node of Object.values(plan.nodes)) {
    if (!node.write_set) continue;
    anyDeclared = true;
    for (const raw of node.write_set) {
      const f = repoRelativePath(root, raw);
      if (seenDeclared.has(f)) continue;
      seenDeclared.add(f);
      declared.push(f);
    }
  }
  const writeSet = anyDeclared ? reconcileWriteSets(declared, filesTouched) : null;
  return { filesTouched, done, writeSet };
}

/**
 * 1-A (2026-09-03; 2026-09-05 只留边界) 判据冻结的台账。判据命令引用、run 开始时不存在的文件: 它们一旦被写出就冻结
 * (引擎记下 hash), 之后任何派发改它们都会被工具闸拒 (agent-tools withProtectedPaths); 先勘察还是先写判据由 conductor 定。
 * 三态: 整格缺席 = 判据不引用未存在文件 (不适用); `frozenAtDispatch` 缺席 = 还没有哪一发把它们写出来;
 * `hashes[f] === null` = 冻结那一刻该文件仍不存在 (不受保护); `tampered` 缺席 = 没核过, `[]` = 核过全同。
 */
export interface CriterionFreeze {
  files: string[];
  frozenAtDispatch?: number;
  hashes?: Record<string, string | null>;
  tampered?: string[];
}

/** 运行期计数器 (可变)。字段语义与 {@link LoopLedger.cards} 逐字相同。 */
export interface ConductorCardLedger {
  calls: number;
  ok: number;
  rejectedSchema: number;
  help: number;
  rejectedCompile: number;
  childRunError: number;
  byCard: Partial<Record<ConductorCardName, number>>;
  readOnlyShellBlocked: number;
  dispatches: LoopDispatch[];
  /** conductor 常驻 system prompt 真跑的字符数 (含 RUN FACTS); 由 buildConductorFace 写, 回灌第二跑覆盖为同值。 */
  residentPromptChars: number | null;
  /** 1-A 冻结台账 (可变; 回灌第二跑沿用, 那时 hashes 已在 → 直接受保护)。缺席 = 不适用。 */
  criterionFreeze?: CriterionFreeze;
  /** #205 方向性探针结论 (冻结点写入; 语义见 LoopLedger.criterionDirection)。 */
  criterionDirection?: 'red-before' | 'green-before' | 'inconclusive';
  /** W1 勘察包读数 (装配期写一次; 语义见 {@link LoopLedger.surveyPack})。 */
  surveyPack?: SurveyPackFacts;
}

/**
 * W1 勘察包读数 (2026-09-06, 见 `./survey-pack`)。
 *
 * 三态别压平 (§静默坑 1): 整格缺席 = **没算包** (走的不是编排循环 / 老记录);
 * `sections` 空数组 = 算了但一段都没勘察到 (空仓); `why` 在场 = 有段失败或撞墙钟, 原文在里面
 * (段缺席不等于段失败 —— 不是 git 仓时 `git` 段不在 `sections` 里而 `why` 缺席)。
 */
export interface SurveyPackFacts {
  chars: number;
  sections: string[];
  why?: string;
  /**
   * 第七段影响包的读数 (2026-09-06, 见 `./impact-pack`)。
   *
   * 三态别压平 (§静默坑 1): 整格缺席 = **没算影响包** (`OMD_IMPACT_PACK=0` / 那一段炸了 /
   * 老记录); 在场且 `defs: 0` = 算了但仓里没这几个定义 (词抽错或语言不支持)。
   * 塌了归因就看这一格: 命中率低 = 抽取没找到定义, 命中率高而分没动 = 瓶颈不在上下文。
   */
  impact?: ImpactPackFacts;
}

export function createConductorCardLedger(): ConductorCardLedger {
  return { calls: 0, ok: 0, rejectedSchema: 0, help: 0, rejectedCompile: 0, childRunError: 0, byCard: {}, readOnlyShellBlocked: 0, dispatches: [], residentPromptChars: null };
}

/**
 * 证伪测试一趟的读数 (契约 `docs/plan/2026-09-05-verifier写证伪测试-执行契约-草案.md` D-6)。
 *
 * 三态别压平 (§静默坑 1): `red` = 至少一条挂; `green` = 全过 (这一趟什么都没查出来);
 * `inconclusive` = **什么都没量到** (座位写不出 / 计划没过闸 / 没有能跑它的 runner / 超时 /
 * collection error) —— 成因原文在 `why`, 预注册要的正是它的占比与分布。
 *
 * `written` = 过闸后的测试条数 (座位写了但没过闸 ⇒ 0); `ran` = 真交给 runner 的条数
 * (`written > 0` 而 `ran === 0` = 计划合法但这仓跑不了它)。
 * `afterReinject` 缺席 = 没回灌 (首跑不红, 或红了但回灌被别的守卫拦住)。
 */
export interface FalsifyLedger {
  written: number;
  ran: number;
  status: 'red' | 'green' | 'inconclusive';
  /** 首跑挂掉的测试文件名 (回灌后那一跑的结果只落在 `afterReinject` —— finding 的正文来自首跑)。 */
  failing: string[];
  reinjected: boolean;
  afterReinject?: 'red' | 'green' | 'inconclusive';
  /** inconclusive 的成因原文。缺席 = 没有额外要说的 (green / red 的常态)。 */
  why?: string;
}

/** 写进账本的最终形状。 */
export interface LoopLedger {
  path: 'orchestrating-loop';
  /** classify 那一发出的路由决策; `chainHit` 在循环开着时恒 false (D-17 恒截胡), 留着是为了对照臂同一形状。 */
  route: { kind: 'none' | 'chain' | 'shape'; chainHit: boolean };
  /** 动手前 LLM 调用数 (classify 一发 + P2b 重推 / 追问那几发)。INV-12 判词: 默认路径 = 1, 含追问 ≤ 3。null = 分类器没走 LLM (注入式 / 缺 generate)。 */
  preActionLlmCalls: number | null;
  /** conductor 常驻 prompt 真跑字符数。INV-8 判词 ≤ 8000。null = 面没构造 (不该发生, 留给读侧看见)。 */
  residentPromptChars: number | null;
  verifier: {
    /**
     * 真调 verifier 的次数 (闸红短路 / verifier-error 不计)。INV-7 判词 **≤ 2**
     * (2026-09-04 owner 裁「补第二跑的复审」前是 ≤ 1): 全量终审至多 1 次 + D-14 窄复审至多 1 次。
     * 两次是不同卷面 —— 第一次找问题, 第二次只判首判 finding 修没修 (`renderRecheckTask`)。
     */
    calls: number;
    firstVerdict: 'pass' | 'fail' | null;
    target: 'implementation' | 'criterion' | null;
    reinjected: boolean;
    /** 回灌后终局; 没回灌 (含基建守卫拦住) = 'skipped'。 */
    afterReinject: 'green' | 'red' | 'no-oracle' | 'skipped';
    /**
     * D-14 窄复审读数 (2026-09-04)。五格互斥, **别把 'skipped' / 'error' / 'unproven' 并掉** (§静默坑 1):
     *  · 'pass'    复审拿到证据判首判 finding 已修 → 放行;
     *  · 'unproven' 复审拿不出反证、也确认不了修好 → **同样放行**(oracle 绿是 prior, 推翻它要反证),
     *              但与干净 pass 分开记: 这一格是「这道闸这次什么都没量到」, 读侧要能数出它的占比。
     *              合并进 'pass' 就会把「确认修好了」与「没能确认」读成同一件事 (code80-p5 的
     *              3/8 假阳性正是这两者被并在 fail 一侧造成的, 反过来并进 pass 一侧同样有害);
     *  · 'fail'    复审判仍没修 → verifier-rejected (机械 oracle 绿也不算);
     *  · 'error'   复审调不通 (判卷官坏了) → fail-open 按 oracle 念, 不因判官故障改终态;
     *  · 'skipped' 没跑复审 —— 没回灌, 或回灌后 oracle 已经红 (那时终态本来就是 verifier-rejected,
     *              再花一次跨模型调用买不到任何新信息)。
     */
    recheck: 'pass' | 'unproven' | 'fail' | 'error' | 'skipped';
  };
  /** conductor 节点基建类败因 (D-14 守卫); 缺席 = 没发生。 */
  conductorInfraFailure?: string;
  /**
   * #205 方向性探针 (2026-09-04): 1-A 判据文件写好之后, 把它放回**改动前的代码**里跑一遍的结论。
   *
   *  · 'red-before'   判据在改动前红 —— 它确实在量本次改动 (好);
   *  · 'green-before' 判据在改动前就绿 —— **它测的不是本次要改的东西** (坏, 「conductor 写了个
   *                   自己能过的测试」的机械特征);
   *  · 'inconclusive' 什么都没量到 (世界没建成 / 命令跑不起来 / 1-A 没写出文件);
   *  · 缺席          没跑这道探针 (判据不引用新文件, 或本 run 走的不是循环路径)。
   *
   * ⚠ **本版 fail-open, 只记账不拦。** 「改动前绿 ⇒ 方向错」这条判断目前零真实样本支撑,
   * 直接升成闸会重复窄复审那次 3/8 假阳性的错误。先量频率再定。
   * ⚠ 'inconclusive' 与缺席**别并掉** (§静默坑 1): 一个是跑了没量到, 一个是压根没跑。
   */
  criterionDirection?: 'red-before' | 'green-before' | 'inconclusive';
  /**
   * #205 第三刀 (2026-09-04): 执行体**改动了仓库自带的测试文件**的条数。
   *
   * 为什么这是一个**不来自执行体**的信号: 仓里既有的测试是仓库作者写的, 判据由执行体自己写
   * 这个环, 只能从环外打断。执行体去改既有测试, 与「改判据」在效果上无法区分 —— code80-p5
   * 的根因链 (判据由被测对象产出 → 它写个自己能过的测试 → oracle 绿 → bench 0/12) 正是这一族。
   *
   * 判据 (启发式, 故意写在这里而不是散在调用点): 路径像测试 (含 `test`/`spec` 段) ∧ 改动前
   * 在 git 里已存在 ∧ 不在 1-A criterionFiles 里 (那些是本次该写的新文件, 不算既有)。
   * ⚠ **本版只记账不拦**, 与方向性探针同待遇: 先量频率再定要不要升成闸。
   * ⚠ `null` = 算不出来 (仓不是 git / git 调不通), 与 `0` (真的一条没改) **分开** (§静默坑 1)。
   */
  existingTestsTouched?: number | null;
  /**
   * 分类期判据自证的裁决 (#205 ①)。**挂在这里而不是 RunGoalResult 顶层**:
   * `resultOut` 只序列化 `r.loop` 整份 JSON (`mcp/tools/goal.ts` 的 `loop:` 头行),
   * 顶层字段出不了 bench 容器 —— code80-p6 实测挂顶层时 68 题全缺席, 而同批挂在本类型上的
   * `criterionDirection` / `existingTestsTouched` 都读到了。**读不到的读数等于没有这个读数。**
   * (账本 `dag-runs.db` 那条路更早就不通: 库在 omd home, `omd-state.tgz` 只扫 `<cwd>/.omd`。)
   */
  acceptanceProbe?: AcceptanceProbe;
  /**
   * 异族座写的证伪测试读数 (2026-09-05 D-6, 见 `./falsify-tests`)。
   *
   * 挂这里的理由同上面 `acceptanceProbe`: 只有 `r.loop` 整份 JSON 出得了 bench 容器。
   * ⚠ 整格缺席 = **开关没开** (`OMD_VERIFIER_FALSIFY` 不是 `1` / 走的不是编排循环 / 没配终审座),
   * **不是**「跑了什么都没查出来」—— 后者是 `status: 'green'` (§静默坑 1)。
   */
  falsify?: FalsifyLedger;
  /**
   * 分类前机械勘察的读数 (2026-09-05, 见 `./criterion-survey`)。
   *
   * **挂在这里而不是结果顶层**, 与上面 `acceptanceProbe` 同一条理由: `resultOut` 只序列化
   * `r.loop` 整份 JSON, 顶层字段出不了 bench 容器 (`runs/2026-09-04-criterion-direction-result.md` §①)。
   * ⚠ 整格缺席 = **没跑勘察** (注入式分类器 / 闸 C 复用上次分类); 跑了三段全空 = 各项全 0 ——
   * 两者别并掉 (§静默坑 1)。`why` 在场 = 有段失败或撞墙钟, 原文在里面。
   */
  criterionSurvey?: CriterionSurveyFacts & { why?: string };
  /**
   * W1 勘察包读数 (2026-09-06, 见 `./survey-pack`): 算了多大一份、哪几段成了、哪一段炸了。
   *
   * 挂在这里的理由同上面几格: 只有 `r.loop` 整份 JSON 出得了 bench 容器。
   * ⚠ 三态见 {@link SurveyPackFacts}。
   * 运行期那份写在 `ConductorCardLedger.surveyPack` 上, `run-goal.ts` 组装 loop 时提上来
   * (2026-09-06 合并时接的那一跳: `surveyPack: loopLedger.surveyPack`)。
   */
  surveyPack?: SurveyPackFacts;
  /**
   * 判据三候选共识的一致性读数 (2026-09-05, 见 `./criterion-consensus`)。
   *
   * 挂这里的理由同上面两格: 只有 `r.loop` 整份 JSON 出得了 bench 容器。
   * ⚠ 整格缺席 = **没开共识** (`OMD_CRITERION_CONSENSUS` 不是 `1` / 注入式分类器 / 闸 C 复用上次分类
   * / 三发全挂回落了单发那条路), **不是**「开了但一致性为 0」—— 后者是 `agreement: 0` (§静默坑 1)。
   */
  criterionConsensus?: CriterionConsensus;
  /**
   * runner 就绪预检读数 (W3, 2026-09-06, 见 `./runner-ready`)。
   *
   * 挂这里的理由同上面几格: 只有 `r.loop` 整份 JSON 出得了 bench 容器。
   * ⚠ 整格缺席 = **没跑预检** (走的不是编排循环 / 老记录), **不是**「探过且不适用」——
   * 后者是 `runner: null` (§静默坑 1)。`installed` 那一格的三态见 {@link RunnerReady}。
   * 契约预注册要收的正是「`installed` 次数」与「No module named pytest」题数这一对。
   */
  runnerReady?: RunnerReady;

  cards: Omit<ConductorCardLedger, 'dispatches' | 'residentPromptChars' | 'criterionFreeze' | 'criterionDirection'>;
  dispatches: LoopDispatch[];
  /** 1-A 冻结台账 (收尾时 `tampered` 已核)。缺席 = 判据不引用未存在文件。 */
  criterionFreeze?: CriterionFreeze;
  /**
   * D-14 回灌第二跑开始那一刻 `dispatches` 的长度 (两跑合并计数, 这是分界线)。只在 `verifier.reinjected` 时有值;
   * 缺席 = 没回灌 / 老记录。读侧「回灌蒸发率」= 回灌后零新派发 (`dispatches.length === dispatchesBeforeReinject`)
   * 且 oracle 绿 —— 没有这条线, 读侧只能猜哪些派发是回灌后的。
   */
  dispatchesBeforeReinject?: number;
}

/**
 * brief 里有没有粘**运行输出** —— 启发式, 写死在这里, 读侧不再猜。命中任一形态即 true:
 * 退出码 (`exit 1` / `exit code` / `退出码`) · traceback / Traceback · `FAILED` / `failed,` (pytest / bun 摘要) ·
 * 断言差异 (`AssertionError` / `expected` … `got` / `Expected:` `Received:`) · 命令提示符行 (`$ ` 开头) ·
 * 「N passed / N failed」形态。**不**命中: 只写了命令名而没有它的输出。
 */
export function briefHasRepro(brief: string): boolean {
  const b = brief ?? '';
  return (
    /\bexit(?:\s+code)?\s*[:=]?\s*\d+|退出码\s*\d+/i.test(b) ||
    /traceback/i.test(b) ||
    /\bFAILED\b|\bfailed\b\s*[,(]|\d+\s+failed/.test(b) ||
    /AssertionError|\bexpected\b[\s\S]{0,80}\bgot\b|Expected:|Received:/.test(b) ||
    /(^|\n)\s*\$ \S/.test(b) ||
    /\d+\s+pass(?:ed)?\b/.test(b)
  );
}

/**
 * 派发层引擎记录的判卷真值 (D-2): 把 ledger.dispatches 渲染成 verifier 看的一段。
 * 没有 dispatches → null (不编, 老调用方零回归)。
 *
 * 每一行: `派发 #<seq> (<card>) — done <n>/<total> · filesTouched: A, B, +<m>`。
 * `writeSet` 缺席 (没合同) → 不写对账段; 不为 null (有合同但空) → 写 `declared 0 / orphan 0 / missing 0`。
 * `writeSet` 有孤儿 / 缺失 → 单写一行告警, 提示判卷官对照。
 *
 * 「判卷时刻机械事实」段: 当一个派发的 filesTouched 非空时, 调 `runGit` 拿
 * `git status --porcelain -- <paths>` 输出, 每条 `<path> <porcelain>` 进卷面; git 退出非 0
 * → 写一行 `git-failed: <stderr 原文>` (仓规: 起不来时写错误原文而不是省略)。
 * 测试可注入 `runGit`; 生产默认 inline 调 `spawnSync('git', …)` (避免反向 import writeset-evidence 走它内部的 defaultRunGit)。
 *
 * falsify (本函数必须能真红):
 *  · 把 `git-failed:` 那一行整段改成省略 (只写 on-disk 段) → 含 `git-failed: fatal: not a git repo` 的断言红。
 *  · 把 `done <done>/<total>` 改成 `done <total>/<done>` → 测试 (a) 第二条「done count = number of 'done' leaves」红。
 */
const defaultRunGit: RunGit = ({ root, paths }) => {
  const r = spawnSync('git', ['status', '--porcelain', '--', ...paths], {
    cwd: root,
    encoding: 'utf-8',
  });
  return {
    exitCode: r.status ?? -1,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
  };
};

export interface RenderDispatchEvidenceOpts {
  cwd: string;
  runGit?: RunGit;
  /** filesTouched 列表最多印几条 (超出写 +N); 默认 20 (硬约束 2)。 */
  touchedPrintLimit?: number;
  /** 判卷时刻「盘上是否存在」的探针, 测试可注入; 默认 existsSync(join(cwd, path))。 */
  exists?: (abs: string) => boolean;
}

export function renderDispatchEvidenceTruth(
  dispatches: LoopDispatch[],
  opts: RenderDispatchEvidenceOpts,
): string | null {
  if (!dispatches || dispatches.length === 0) return null;
  const runGit = opts.runGit ?? defaultRunGit;
  const limit = opts.touchedPrintLimit ?? 20;
  const exists = opts.exists ?? existsSync;
  const lines: string[] = [];
  for (const d of dispatches) {
    const touched = d.filesTouched ?? [];
    const total = d.nodes ?? 0;
    const done = d.done ?? 0;
    const head = `派发 #${d.seq} (${d.card}) — done ${done}/${total} · filesTouched: ${summarizeTouched(touched, limit)}`;
    lines.push(head);
    if (d.writeSet !== undefined && d.writeSet !== null) {
      const ws = d.writeSet;
      lines.push(`  写集对账: declared ${ws.declared.length} / orphan ${ws.orphan.length} / missing ${ws.missing.length}${ws.orphan.length || ws.missing.length ? ` — ${formatWriteSetFlags(ws)}` : ''}`);
    }
    if (touched.length > 0) {
      // 硬约束 2: 每个 filesTouched 文件**现在**盘上在不在 —— 引擎事实, 与执行体自述无关。
      const missingOnDisk = touched.filter((f) => !exists(join(opts.cwd, f)));
      lines.push(`  判卷时刻盘上: 存在 ${touched.length - missingOnDisk.length}/${touched.length}${missingOnDisk.length ? ` · 缺失 [${missingOnDisk.join(', ')}]` : ''}`);
      const r = runGit({ root: opts.cwd, paths: touched });
      if (r.exitCode === 0) {
        const porcelain = r.stdout.trim();
        if (porcelain.length > 0) lines.push(`  判卷时刻机械事实: ${oneLine(porcelain)}`);
        else lines.push(`  判卷时刻机械事实: (无变更)`);
      } else {
        const errMsg = (r.stderr || r.stdout || `exit ${r.exitCode}`).trim() || `exit ${r.exitCode}`;
        lines.push(`  判卷时刻机械事实: git-failed: ${errMsg}`);
      }
    }
  }
  return lines.join('\n');
}

function summarizeTouched(touched: string[], limit: number): string {
  if (touched.length === 0) return '(无)';
  if (touched.length <= limit) return touched.join(', ');
  const head = touched.slice(0, limit).join(', ');
  return `${head}, +${touched.length - limit}`;
}

function formatWriteSetFlags(ws: { declared: string[]; orphan: string[]; missing: string[] }): string {
  const parts: string[] = [];
  if (ws.orphan.length > 0) parts.push(`orphan [${ws.orphan.join(', ')}]`);
  if (ws.missing.length > 0) parts.push(`missing [${ws.missing.join(', ')}]`);
  return parts.join(' · ');
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 两个注入点 (run-goal `tapVerifier` · loop-run 的 run 路) 共用的一跳: dispatches 非空 → 把渲染好的
 * `dispatchEvidence` 合进 `req.truths` (与 criterionFreeze 等既有真值共存, 同键以这里为准);
 * 为空 → **返回同一个 req 对象** (卷面逐字节同旧, 老调用方零回归)。
 * 证伪方式 (loop-ledger.test.ts): 把空分支改成 `{ ...req }` → 「为空返回同一引用」那条红;
 * 把合并改成 `truths: { dispatchEvidence }` → 「与 criterionFreeze 共存」那条红。
 */
export function withDispatchEvidence<T extends { truths?: JudgingTruths }>(
  req: T,
  dispatches: LoopDispatch[],
  opts: RenderDispatchEvidenceOpts,
): T {
  if (dispatches.length === 0) return req;
  const dispatchEvidence = renderDispatchEvidenceTruth(dispatches, opts);
  if (!dispatchEvidence) return req;
  return { ...req, truths: { ...(req.truths ?? {}), dispatchEvidence } };
}

/**
 * #205 第三刀 (2026-09-04): 数「执行体改了几个**仓库自带的**测试文件」。
 *
 * 这是本 run 里唯一一个**不来自执行体**的信号源: 判据由被测对象自己写这个环, 只能从环外打断。
 * 仓里既有的测试是仓库作者写的 —— 执行体去改它们, 与「改判据」在效果上分不开。
 *
 * 三个条件同时成立才算一条 (缺一都会把正常改动误报成可疑):
 *  ① 路径像测试 —— 含 `test` / `spec` 路径段或文件名前后缀;
 *  ② 改动前在 git 里**已存在** —— `git cat-file -e HEAD:<path>`, 新写的测试不算;
 *  ③ 不在 1-A `criterionFiles` 里 —— 那些正是本次该写的判据文件, 写它们是被要求的。
 *
 * @returns 条数; git 调不通 / 不是 git 仓 → `null` (**算不出来 ≠ 0 条**, §静默坑 1)。
 */
export function countExistingTestsTouched(
  filesTouched: readonly string[],
  criterionFiles: readonly string[],
  deps: { existsInHead: (path: string) => boolean | null },
): number | null {
  const isTestPath = (p: string): boolean => {
    const norm = p.split('\\').join('/').toLowerCase();
    // 段级匹配而不是裸 `includes('test')`: 后者会把 `src/latest.ts` / `src/contest/x.ts` 算进来。
    return norm.split('/').some((seg) => /(^|[._-])(tests?|specs?)([._-]|$)/.test(seg));
  };
  const frozen = new Set(criterionFiles.map((f) => f.split('\\').join('/')));
  let n = 0;
  for (const raw of filesTouched) {
    const f = raw.split('\\').join('/');
    if (!isTestPath(f) || frozen.has(f)) continue;
    const existed = deps.existsInHead(f);
    if (existed === null) return null; // git 说不出话 → 整个读数作废, 不返半个数
    if (existed) n++;
  }
  return n;
}
