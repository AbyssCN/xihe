/**
 * src/harness/verifier —— omd executor-DAG 的**跨模型校验器** (model-agnostic skeptic)。
 *
 * 落地页角色卡 "Verifier" 的实装: 一个**不绑任何 CLI** 的怀疑者, 职责是**攻击结果而非盖章放行**。
 * DAG 跑完 → 把原任务 + 计划 + 各 leaf 输出交给 verifier → 它逐条对照任务的明确要求, 渲染
 * pass/fail + reason。fail 且配了可用升级模型 → executor-dag 用更强 conductor 重规划重跑 (静默升级)。
 *
 * 为什么 cross-model 而非同模型自审: 同模型自审会**复用同一盲点** (它造的坏计划自己看不出坏)。
 * 默认 verifier 模型走 resolveRoleModel('verifier') = deepseek (≠ 默认 mimo conductor/leaf), 形成
 * 真正的跨模型对抗。env OMD_VERIFIER_MODEL / .omd/config.json 可换。
 *
 * 经济学 (见 [[project-omd-dag-executor-seam]] + conductor 模型校准): conductor 每 task 只跑一次,
 * 坏计划让一整轮 leaf 白干 (风险不对称) → verifier 兜底让弱 conductor 可安全降级: 弱模型造图 +
 * verifier 校验 + 失败才升级强模型。**没配 SOTA 升级模型 (provider 未注册) → 维持弱模型** (executor-dag
 * 内的 provider gate 自动判定, 见 escalationProviderReady)。
 *
 * Invariants:
 *  VER-1 verifier 永不阻断: 抛错由调用方 (executor-dag) 兜; 未结构化输出 → 保守判 fail (不静默放行)。
 *  VER-2 全 leaf 失败 → 不调模型直接 fail (省一次调用, 显然无产出)。
 *  VER-2b 零节点产出 (results 空) → 同样直接 fail: **0 有效样本 ≠ 通过**, 且与 VER-2 分开报判词。
 *  VER-3 信 verifier 的 pass 布尔 (任务要求逐条对照已进 prompt); reason 必带 (fail 时点名缺啥)。
 *  VER-4 否决**分型**: fail 时裁决自带打击对象 (`target`) —— 'implementation' 打产出 / 'criterion' 打判据。
 *        缺席或非法值 ⇒ 'implementation' (fail-open, 现行为逐字节不变: 老判卷官只回 pass+reason, 照旧走修实装路)。
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { send, listProviders, assertModelResolvable } from '../model/gateway';
import { resolveRoleModel, listRoleModels } from '../model/gateway';
import { tryResolveSeatModel } from '../model/role-models';
import { seatSpec } from '../model/seats';
import { effectiveSeatSampling } from '../model/seat-overrides';
import { withGoFallback } from '../model/gateway';
import { withPoolFallback } from '../model/seat-fallback';
import { resolveConfiguredPools } from '../model/role-models';
import { POOL_DEFAULTS } from '../model/pool-defaults';

/** verifier 降级池: config.pools.fallbackVerify (env 压过) → 源码默认。每次调用重解 (INV-MODEL-3, 不冻结)。 */
function verifyFallbackPool(): readonly string[] {
  try {
    return resolveConfiguredPools().fallbackVerify ?? POOL_DEFAULTS.fallbackVerify ?? [];
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[omd/verifier] 降级池解析失败 → 用源码默认');
    return POOL_DEFAULTS.fallbackVerify ?? [];
  }
}
import { logger } from './logger';
import { engineFacts } from './plan/claimed-actions';
import { renderDiffEvidence, type DiffEvidence } from './diff-evidence';
import type { ModelUsage } from '../model/gateway';
import type { ConductorPlan } from './conductor-plan';
import type { LeafResult } from './dag/engine';
import type { BlameEntry } from './dag/blame';

/**
 * 引擎记录展示预算 (SDD 2026-08-22 verifier-engine-facts, D-4)。
 * 与 `dag/engine.ts:122` 的 `SHELL_FACT_CAP` 同值, 但**各自持常量**:
 * verifier.ts 与 engine.ts 是两个可以独立调的旋钮 (其中一份可能收紧, 另一份放
 * —— 比如 verifier 想缩到 4 留更多上下文给正文), 绑死是给未来挖坑。
 * ⚠ 反向 import 会成环: engine.ts 已经 import verifier.ts, 这里不许反过来。
 * falsify 节点靠这一行**逐字**存在才能 matches=1, 见 `verifier-engine-facts.test.ts`。
 */
const ENGINE_FACT_SHELL_CAP = 6;

/**
 * VER-4 否决的**打击对象** (INV-3, SDD `docs/plan/2026-08-29-veto-feedback-revision-edges.md`):
 * 同样是判 fail, 「产出没满足判据」与「判据本身量不出」的下一步相反 —— 前者再开一轮修实装,
 * 后者该去重建判据。归因样本里 verifier 否决得对的两例 (leaf 写 shim 骗绿 · leaf 写恒绿测试)
 * 就死在这个区分不存在: 判据是虚的, 却拿修复轮去修实装, 烧满预算也不可能转绿。
 * ⚠ 与 `dag/verdict-ledger.ts` 的 `VerdictKind` ('substantive' | 'infra') 是两回事:
 * 那个分的是「判词算不算数」, 这个分的是「算数的否决打的是谁」。
 */
export type VerdictTarget = 'implementation' | 'criterion';

export interface VerifierVerdict {
  /** 结果是否满足任务的全部明确要求 (true = 放行)。 */
  pass: boolean;
  /** fail 时点名缺哪条要求 / 哪里捏造 + 该怎么改 (机制级)。pass 时可空。 */
  reason: string;
  /**
   * VER-4 打击对象。**可选**是刻意的: 引擎侧还有几处自己合成裁决的出口 (闸红短路 / verifier 调不通),
   * 它们没经过判卷官, 编一个分型出来就是无中生有 —— 缺席 ⇒ 消费侧按 'implementation' 读 (fail-open)。
   * `createDefaultVerifier` 的**每条**返回路径都带值 (含三条 fast-path), 见本文件下方。
   */
  target?: VerdictTarget;
  /** 校验调用的 token 用量 (fast-path 时 {in:0,out:0})。 */
  usage: ModelUsage;
}

/** 校验器: 看 (原任务 + 计划 + leaf 结果) → 渲染裁决。注入式 (executor-dag 的 config.verifier)。 */
export type VerifierFn = (req: {
  task: string;
  plan: ConductorPlan;
  results: Record<string, LeafResult>;
  /** S-33: 产物三态 (registered/unregistered/missing) 的解析根 (相对 output_path 按它解析)。省略 = 不判产物三态, 卷面逐字节同旧。 */
  artifactRoot?: string;
  /** 按调用注入的判卷真值 (D-5): 判卷时刻才有的引擎记录 (1-A 判据文件冻结), 与装配期 truths 合并, 同键以这里为准。省略 = 卷面同旧。 */
  truths?: JudgingTruths;
}) => Promise<VerifierVerdict>;

/** 校验启停状态标 (让"校验已禁用"可见, 防静默丢护栏)。供 boot log / TUI / 状态行读。 */
export type VerifierStatusReason =
  | 'on' // 校验启用
  | 'off:flag' // OMD_VERIFY=0 显式关
  | 'off:unresolved' // 默认 verifier 模型坐标解析不了 → 降级关 (非 explicit)
  | 'off:invalid-explicit'; // 显式配的 verifier 坐标坏 → 响亮警告 + 降级关 (boot 永不砖)
export interface VerifierStatus {
  enabled: boolean;
  reason: VerifierStatusReason;
  /** enabled 时的 verifier 坐标 (off 时 undefined)。 */
  verifierModel?: string;
}

/** verifier / escalation 的配置片段 (wiring 层经 resolveVerification 产, spread 进 dag config)。 */
export interface VerificationConfig {
  verifier?: VerifierFn;
  conductorEscalationModel?: string;
  maxEscalations?: number;
  /** 校验启停状态标 (始终给, 每条返回路径都设 — off 状态可见)。executor-dag 不读, 供状态层展示。 */
  status: VerifierStatus;
}

/**
 * VER-4 (GWT-3): `target` 用 `.catch` 而不是 `.optional()` —— 三件事一次说清:
 *  · 字段缺席 (今天生产上跑着的判卷官全是这样) ⇒ 'implementation', 老输出零改造照旧;
 *  · 字段是乱值 ('判据' / 大小写不符 / null / 数字) ⇒ 同样 'implementation', **且不让整份裁决解析失败**
 *    (拒解析 = 触发模型层纠错重试, 最后落进 VER-1 保守 fail —— 拿一个分型字段掀掉一份本可用的判词, 不划算);
 *  · 显式 'criterion' 原样保留, 否则这个字段就是个恒等于默认值的摆设。
 */
export const VERIFIER_VERDICT_SCHEMA = z.object({
  pass: z.coerce.boolean(),
  reason: z.coerce.string(),
  target: z.enum(['implementation', 'criterion']).catch('implementation'),
});

/**
 * D-1 产出侧助手 (SDD 2026-08-10-blame-scoped-node-retry): 把结构化责备集并进判词散文,
 * 产出 `dag/blame.ts` 的 `parseBlameVerdict` 能解出的 reason。冻结格式同 `BLAME_FENCE`:
 * ```` ```blame\n<BlameEntry[] JSON>\n``` ````, 围栏外散文原样保留 (人读面不变)。
 *
 * **判不出具体节点/产物时别调它** —— 纯散文 reason → 解析 undefined → 下游走现行整轮
 * fail-open (INV-1, 行为逐字节不变)。entries 为空同样原样返回: 空数组会被解析器当不合形拒掉,
 * 与「没附围栏」等价 —— 与其发一个注定作废的围栏, 不如不发。
 * 本函数只做**序列化**, 不做任何解析/校验 —— 责备集语义的唯一实现在 blame.ts (INV-1: 无第二套)。
 */
export function withBlameFence(reason: string, entries: BlameEntry[]): string {
  if (entries.length === 0) return reason;
  return `${reason}\n\`\`\`blame\n${JSON.stringify(entries)}\n\`\`\``;
}

/**
 * 把 DAG 结果汇成给 verifier 看的一段 (失败节点标注, 每节点截断防爆 prompt)。
 *
 * **command 节点必须带上命令串与退出码** (2026-08-01, 校准量出来的)。这道闸的判词是
 * 「默认怀疑, 证据不足时判不通过」, 而此前这里只给 `goal + stdout` —— 于是它看见一个裸的
 * `93`, 既不知道那是哪条命令跑出来的、也不知道退出码, 只能照自己的判据判不过。
 * 六条 fixture 的校准里, **唯一一条它判错的**(真做到了却判不过)判词逐字写着:
 * 「未展示所执行的具体命令与退出码」—— 它要的两样东西**引擎手里都有**
 * (`plan.nodes[id].command` · `LeafResult.exitCode`), 只是没递给它。
 *
 * 这正是 command 节点存在的全部意义: 它是**确定性 oracle** —— 命令串在规划期就定死、退出码
 * 由内核给。把这两样藏起来, 等于请一个怀疑者来审, 却把唯一不需要信任的证据扣下, 逼他去信
 * 一段自述。**假红**由此而来, 而假红的下一步是 escalation 重规划 —— 空转的账就是这么记上的。
 *
 * ⚠ 失败节点的正文仍是 `(failed)` (原样未动 —— 那条没有校准读数支持, 别搭车改);
 * 但退出码照给, 因为 `-1`(闸拒, 命令没跑) 与 `1`(命令跑了、断言没成立) 的下一步相反,
 * 而这个区分此前只能靠下游毒化文案**间接**漏给它。
 *
 * **S-33 产物三态** (2026-08-14): `output_path` 声明了写的节点, 每条都对**盘上真实状态** (`statSync`)
 * 核一次, 分三态入卷 (`artifact: <path> [<state>]`):
 *   - `registered`   盘上有 且 leaf 自报的 `filesTouched` 里也有 —— 正常态。
 *   - `unregistered` 盘上有 但 `filesTouched` 没登记 —— **单独标出并显式告警**: 这不是产物问题,
 *     是**节点上报链的缺陷** (leaf 真写了却没报), 别让判卷官误读成"没写"。
 *   - `missing`      盘上没有 (不论 `filesTouched` 怎么说) —— 声明了却不存在, 该拦。
 * ⚠ `missing` 与失败节点写死的 `(failed)` 正文是**两条独立的线**: 正文不动 (上一条注释的约束),
 * 但缺失的具体路径必须单独出现在 `artifact:` 行上, 不许被 `(failed)` 整体替换吞掉。
 * 只在传了 `artifactRoot` 时判 (省略 = 不判, 卷面逐字节同旧, 老调用方零回归) —— 相对路径按它解析。
 */
export function summarizeResults(
  plan: ConductorPlan,
  results: Record<string, LeafResult>,
  artifactRootOrMaxPerNode?: string | number,
  maxPerNode = 1200,
): string {
  const artifactRoot = typeof artifactRootOrMaxPerNode === 'string' ? artifactRootOrMaxPerNode : undefined;
  const effMaxPerNode = typeof artifactRootOrMaxPerNode === 'number' ? artifactRootOrMaxPerNode : maxPerNode;
  const lines: string[] = [`plan: ${plan.name} · ${Object.keys(results).length} nodes`];
  for (const [id, leaf] of Object.entries(results)) {
    const node = plan.nodes[id];
    const head = `### ${id} [${leaf.status}]${node?.goal ? ` — ${node.goal}` : ''}`;
    // C-2: 合并记录随节点进 verifier 材料 (2026-08-22, #153② 同病二次发作)。
    // 不挂这条 = verifier 读到「少一个节点」, 而少的那条命令其实排在链首、没丢。
    // 只在带 `absorbed_from` 时渲染一行 —— 不带该字段的节点 (绝大多数) 卷面逐字节同旧。
    const meta = [
      node?.command ? `$ ${node.command}` : '',
      leaf.exitCode === undefined
        ? ''
        : leaf.exitCode === null
          ? 'exit —— 死于信号 (没有主动退出码: 跑了但没跑完, 没有判词)'
          : `exit ${leaf.exitCode}${leaf.exitCode < 0 ? ' (command-leaf 闸拒 — 命令未执行)' : ''}`,
      ...(Array.isArray(node?.absorbed_from) && node!.absorbed_from.length > 0
        ? [
            `merged_from: [${node!.absorbed_from.join(', ')}] —— 引擎机械合并 (#153②), 命令一条不少且被吸收者排在链首, 不是执行体省略。`,
          ]
        : []),
    ].filter(Boolean);
    if (artifactRoot && node?.output_path) {
      const resolved = isAbsolute(node.output_path) ? node.output_path : join(artifactRoot, node.output_path);
      let onDisk = false;
      try {
        statSync(resolved);
        onDisk = existsSync(resolved);
      } catch {
        onDisk = false;
      }
      const touched = (leaf.filesTouched ?? []).includes(node.output_path);
      const state = !onDisk ? 'missing' : touched ? 'registered' : 'unregistered';
      meta.push(`artifact: ${node.output_path} [${state}]`);
      if (state === 'unregistered') {
        meta.push(
          `⚠ ${node.output_path} 盘上真有, 但节点未在 filesTouched 里登记 —— 这是节点上报链的缺陷, 不是产物没写。`,
        );
      }
    }
    // SDD 2026-08-22 verifier-engine-facts (切片 1): 引擎记录进卷面, **正文之前**。
    // 事实来源是 `engineFacts()` (plan/claimed-actions.ts:181) —— 它已经把「哪条命令算校验」的取舍
    // 写死过, 这里**不**另造一份渲染, 否则两条记录规则分裂 = S-45 的形状 (D-2)。
    // INV-3 (D-5): 返空 ⇒ 不加这一段, 节点段逐字节同旧。
    // INV-4: 超过预算由 `engineFacts` 自己按校验类优先截, 这里不另发明截断。
    // ⚠ 这一行必须**逐字**长成这样 (含常量名 ENGINE_FACT_SHELL_CAP): falsify 节点用 `edit` 把
    // 这条调用整段换成 `[]` ⇒ GWT-1/2/INV-2 当场红, 验的是「引擎记录到底有没有上卷面」。
    // 多行拆开 → falsify 节点 `matches=0` 一整轮白烧 (2026-08-22 run 75c39d15 实测)。
    const engineFactLines = engineFacts(leaf, { expectExit: node?.expect_exit ?? 0, shellCap: ENGINE_FACT_SHELL_CAP });
    const sectionLines: string[] = [head, ...meta];
    if (engineFactLines.length > 0) {
      sectionLines.push(`引擎记录 (ground truth, 优先于本节点自述):`);
      for (const f of engineFactLines) sectionLines.push(`- ${f}`);
    }
    // C-1 (SDD 2026-08-23 verifier-body-tail): 卷面正文头尾双保 —— 短输出零回归,
    // 超预算取头 + 一行省略标记 + 尾, 头/尾字节和 ≤ 预算 (D-2 一字节不涨)。
    // 头有节点自述 (声称面), 尾有机械判词 (证据面); D-3 尾重于头, 比例 0.3/0.7
    // 是实现侧钉的初值, 待生产读数再调 (SDD 「未决」条); D-4 标记带被省略字节数,
    // D-5 失败节点走 `(failed)` 分支, 不进这里 (verifier.ts:123 那条没有校准读数支持,
    // 别搭车改); D-6 不动 engineFacts / artifact: / meta / ENGINE_FACT_SHELL_CAP。
    const body = leaf.status === 'failed'
      ? '(failed)'
      : truncateBody(leaf.output ?? '', effMaxPerNode);
    sectionLines.push(body);
    lines.push(sectionLines.join('\n'));
  }
  return lines.join('\n\n');
}

/**
 * C-1 (SDD 2026-08-23 verifier-body-tail): 短输出原样返回; 超预算 = 头 + 一行省略标记 + 尾,
 * 头/尾字节和 ≤ `effMaxPerNode`, 标记带被省略字节数 (D-4)。尾段 > 头段 > 0 (D-3,
 * 判词行在尾)。失败节点不进这里 (D-5, 上面写死 `(failed)`)。
 *
 * ⚠ 反向自检 (本片手做): 把下面 `output.slice(-tailLen)` 改成 `''` ⇒ GWT-2 / GWT-4
 * 当场红 (卷面里不再含 `6684 pass / 0 fail` / `HEAD_MARKER`)。
 */
function truncateBody(output: string, effMaxPerNode: number): string {
  if (output.length <= effMaxPerNode) return output;
  const headLen = Math.max(1, Math.floor(effMaxPerNode * 0.3));
  const tailLen = Math.max(0, effMaxPerNode - headLen);
  const head = output.slice(0, headLen);
  const tail = tailLen > 0 ? output.slice(-tailLen) : '';
  const omitted = output.length - head.length - tail.length;
  return `${head}\n... 中间省略 ${omitted} 字节 ...\n${tail}`;
}

/**
 * **判卷真值** (D-5, SDD `docs/plan/2026-08-11-inner-loop-v2-control-inversion.md`) ——
 * harness 在**注入面**知道、而判卷面此前拿不到的那几份值。
 *
 * 实证判例 (本仓 `.omd/dag-runs.db` run `4a609621`, 2026-08-10 probe, 判词逐字):
 * 「唯一保留意见: 句中『信任 token 03880693』**在我可见的任务文本里无对应来源, 无法核验**」。
 * 那个 token 是引擎自己注入进 leaf prompt 最开头的 (engine 的 runNonce → prompt-fence 的
 * `trustHeader`), 而判卷官只拿到原始 task + 结果摘要。**注入面知道真值、判卷面拿不到 = 确定性假阳**:
 * verifier 章程 (默认怀疑) 是对的, 拿闭卷考开卷题是错的。
 *
 * 所以真值随卷 —— 不是放宽判据, 是把「只能信一段自述」换成「能逐字符比对」。
 */
export interface JudgingTruths {
  /** A8 本轮信任 token (engine 的 runNonce, 见 prompt-fence.ts)。 */
  trustToken?: string;
  /** 1-A (2026-09-03): 判据文件冻结的引擎记录 (orchestrating-loop renderCriterionFreezeTruth 的原文), 判卷时刻按调用注入 (req.truths)。 */
  criterionFreeze?: string;
  /** D-2 (2026-09-04): 派发子图机械记录 — filesTouched 并集 · done 数 · 写集对账 (declared/orphan/missing) · 判卷时刻 git 状态。loop-ledger 的 renderDispatchEvidenceTruth 渲染。 */
  dispatchEvidence?: string;
}

/**
 * 每份真值的**卷面写法** (键 → 判卷官读得懂的一行)。
 * 注入面新增一份判卷相关真值 = 在这里加一行; 加漏了, 装配期闸 (`assertJudgingTruthsCarried`)
 * 就会因为「值没出现在卷面上」当场抛 —— 这正是本表不做成通用登记框架也不会静默漂的原因。
 */
const TRUTH_LINES: { [K in keyof Required<JudgingTruths>]: (v: string) => string } = {
  trustToken: (v) =>
    `- **信任 token (A8)** = \`${v}\` —— harness 在任务正文最开头注入的 (prompt-fence 的 runNonce), ` +
    `**它不出现在原始任务文本里是设计如此**, 不是执行体编的。结果里出现的 token 与上面这串**逐字符相同** ` +
    `→ 已核验为真, 不构成"凭空编造"; 不同 / 伪造 / 该带却没带, 才是问题。`,
  criterionFreeze: (v) =>
    `- **判据文件冻结 (1-A, 只留边界)**: ${v} —— 判据引用的测试文件在实施开始时可以不存在; **由实施侧首次写出是设计如此, 不是篡改**。` +
    `引擎在它被写出的那一发回来时记下 hash 并冻结, 之后的派发走路径禁令 (工具写当场拒); 括号里的「判卷时未变/已变」是判卷时刻重算 hash 对照冻结值的结论。` +
    `**「判据文件实施前不存在 / 由执行侧新建」不构成 target=criterion 或 implementation 的理由** —— 这一条覆盖任务正文里「不许改动判据」的字面: 那句管的是冻结之后。` +
    `只有「已变」(冻结后 hash 变了 = 实装篡改判据, 判 implementation) 与「派发后仍不存在」(判据恒红, 判 criterion) 才是问题。` +
    `判据本身量不量得出目标 (grep 式 / shim 可骗绿) 仍按 target=criterion 的通用判据判, 与文件是否新建无关。` +
    `这一行带「作者=异族座 X」时 (R4): 判据文件是由**与执行侧不同家族**的座位 X 在实施开始前写出的, 它看不到任何实装, ` +
    `并且已过「放回改动前的代码上必须红」的方向探针 —— 执行侧只能让它过, 改不动它。**「判据是执行体自己出的题」这一条对它不成立**。`,
  dispatchEvidence: (v) =>
    `- **派发子图引擎记录**: 这些是引擎记录的事实, 不是执行体自述; 判 target=implementation 前先对照它 —— ${v}`,
};

/** 把判卷真值渲染成卷面一段。一份都没有 → 返回空串 (卷面逐字节同旧, 老调用方零回归)。 */
export function renderJudgingTruths(truths: JudgingTruths): string {
  const lines = (Object.keys(TRUTH_LINES) as (keyof JudgingTruths)[])
    .map((k) => (truths[k] ? TRUTH_LINES[k](truths[k]!) : ''))
    .filter(Boolean);
  return lines.length === 0
    ? ''
    : `\n判卷真值 (harness 注入面给的确定性事实, **不是**执行体自述 —— 可逐字符比对):\n${lines.join('\n')}\n`;
}

/**
 * **装配期闸** (D-5 / G-4 前半): 断言「判卷官拿到 = 判卷所需全部真值」——
 * 每份注入的真值都必须**真的出现在卷面上**, 缺一份即抛, 错误指名是哪一份。
 *
 * 为什么是抛而不是记一行 warn: 缺的后果是判卷官闭卷考 → 确定性假阳 → escalation 重规划空转,
 * 而那笔账要跑完整张 DAG 才记上。**拒起跑**是唯一能让它在花钱之前可见的形式 (fail-loud)。
 */
export function assertJudgingTruthsCarried(truths: JudgingTruths, paper: string): void {
  const missing = Object.entries(truths)
    .filter(([, v]) => typeof v === 'string' && v.length > 0 && !paper.includes(v))
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `verifier: 判卷真值未随卷 — ${missing.join(', ')} (harness 注入面已知, 判卷面拿不到) → 拒起跑。` +
        ` 修法: 在 verifier.ts 的 TRUTH_LINES 里给这份真值补一行卷面写法 (D-5)。`,
    );
  }
}

/**
 * D-3 (2026-09-05): 盘上改动段的卷面写法。空串 = 没给 `artifactRoot` (卷面逐字节同旧, INV-6)。
 *
 * `empty` 且带 `why` = **取不到**, 不是零改动 —— 两者念成同一句就是给"什么都没做"发一份
 * 产物证明 (仓规坑 ①: 分辨靠另一列)。
 */
export function renderDiffSection(evidence: DiffEvidence): string {
  const head = '\n\n===== 盘上改动 (引擎 git diff 取, 不是自述) =====\n';
  if (evidence.empty) {
    return evidence.why
      ? `${head}盘上改动取不到: ${evidence.why} —— 这一节没有证据, **不许**当成零改动来判\n`
      : `${head}盘上零改动: 没有任何文件被改或新建 —— 任何"已完成"的自述都没有产物支撑\n`;
  }
  return `${head}${evidence.text}\n`;
}

function verifierPrompt(task: string, summary: string, truths: JudgingTruths = {}, diffSection = ''): string {
  return `你是一个**跨模型校验者**, 审一个多步任务的执行结果是否真正满足任务。你的职责是**攻击结果、找出它没满足任务的地方**, 而不是盖章放行 —— 默认怀疑, 证据不足时判不通过。

判定**必须先做一步**: 从原始任务里抽出所有**明确要求** —— 步数、字数/篇幅、必须覆盖的子部分、必须标注的东西、格式、约束、应产出的体裁 (设计/分析/清单, 而非假装执行)。**逐条**对照结果。

任务分区约定 (写任务的一侧可选使用): 任务里若有「## 提示」或「## 非验收」标题区, 该区内容是给执行侧的建议 (成本/风格/方向), **不构成验收判据** —— 即使措辞像约束 ("控制在 N 个以内"这类), 也不得据其判不通过。若有「## 硬约束」标题区, 其中逐条全是硬判据。没有分区的任务照旧: 全文按上一段抽取明确要求。

不通过 (pass=false) 的判据 (任一命中即不过):
1. 任一明确要求未满足 (即使整体看起来不错) —— reason 点名缺了哪条。
2. **高风险接缝** (契约边界 / 状态机 / 法定数字 / 安全) 即使"看起来对"也要质疑其正确性; 无法确证正确 → 不过。
3. 结果是**捏造的数据 / 假执行确认** (凭空编输入、"已发送/已录入" 这类没真做却声称做了的) → 不过。
4. 计划有节点失败导致结果不完整 → 不过。

证据来源 (SDD 2026-08-22 verifier-engine-facts, C-2): 本卷面里所有「引擎记录」段落的「执行命令」「exit N」「写入文件」「读取文件」行都是引擎观测值, **优于**本节点自述。
- 引擎记录里已有的命令与退出码, **不必**再要求执行体复述 (那是冗余; 真值在卷面上)。
- 执行体自述与引擎记录**冲突** ⇒ **以引擎记录为准, 且判不通过** (那正是谎报完成 —— 看见「执行命令: bun test (exit 1)」而自述写「全量 0 fail」就是这条; ⚠ 只写上一句 = 给假执行确认开了一道门, 必须两句齐下)。
${diffSection ? '- 「盘上改动」一节是引擎取的事实; 结果自述与它冲突时以它为准; 它为零改动而任务要求产出时判不通过。\n' : ''}${renderJudgingTruths(truths)}
原始任务:
---
${task}
---

执行结果:
---
${summary}
---${diffSection}

打击对象 (pass=false 时**必须**声明): 同样是判不过, 「产出没做到」和「判据本身量不出」的下一步是相反的 —— 前者再开一轮修产出, 后者要去重建判据, 判错了就是烧空轮。
- target="criterion" (判据错了 / 判据可被游戏): 判据是**恒绿**的 (不论产出成什么样都过)、能被 shim / 桩 / 空断言这类假实现骗绿、或判据命令指向不存在的路径 / 错的目录。一句话: **实装再对, 这条判据也量不出对错**。
- target="implementation" (实装错了): 判据合理且真能量出差别, 是产出没满足它。
- **拿不准就写 implementation** —— "判据不够好"是最容易被当成万能借口的一句话, 而它一旦被滥用, 真正没做到的产出就被放过去了。

输出 JSON 三字段:
- pass (bool): 结果是否满足任务全部明确要求且无捏造。这是裁决。
- reason (string): pass=false 时**必填** —— 缺哪条要求 / 哪里捏造或不可信 + 重新规划时该怎么修 (机制级, 不是"不够好")。pass=true 时一句话说明已覆盖。
- target (string): "implementation" 或 "criterion", 见上面「打击对象」。pass=true 时写 "implementation" 即可 (不读)。

责备集 (可选输出, 只在你能**确定**失败具体出在哪个节点/产物时用):
- 「执行结果」里每段以 \`### <id> [状态]\` 开头 —— 那个 <id> 就是 DAG 节点 id, 与计划节点一一对应。
- 失败能指认具体节点/产物时, 在 reason 里追加一个 \`\`\`blame 围栏, 围栏内是**一行 JSON 数组** (冻结格式, 见 dag/blame.ts 的 BLAME_FENCE), 每条二选一:
  - {"node": "<节点id>", "reason": "为什么是这个节点"} —— node 逐字照抄 \`### <id>\` 里的 id (写错=点名无效, 不会被定点重跑)。
  - {"artifact": "<产物标识>", "reason": "为什么是这个产物"} —— 产物不对时才用 (如输出文件路径)。
  - 多个节点/产物就并列多条; 每条 reason 都是机制级 (缺什么 / 错在哪 / 下轮怎么修)。
  格式示例 (围栏语言标签 \`blame\` 即协议标记, 不能少):
  \`\`\`blame
  [{"node": "draft", "reason": "草稿验收不合格"}]
  \`\`\`
- **确定不了**具体是哪个节点/产物 → **不要**附围栏, reason 保持纯散文。判不出节点的打回走整轮重跑, 这是设计内的兜底, 不是失职。
- 围栏是硬协议: 解析器只认 \`\`\`blame 围栏 + 合法 JSON 数组; 格式错 / 空数组 → 围栏作废 = 整轮重跑 (fail-open)。`;
}

export interface DefaultVerifierOpts {
  /** 校验模型 'provider:modelId'。falsy → 调用时抛 (fail-closed 配置错, 不静默)。 */
  verifierModel: string | undefined;
  /** 校验推理档 (默认 xhigh=max — 对抗式审查值得最大推理; flash 基座便宜 + max effort = Nick 2026-06-16)。 */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /** 注入式 callModel (测试)。默认真 callModel。 */
  callModelFn?: typeof send;
  /** D-5 判卷真值 (harness 注入面知道的那几份)。省略 = 一份都不随卷, 卷面逐字节同旧。 */
  truths?: JudgingTruths;
}

/** 造默认跨模型校验器。全 leaf 失败 → 不调模型直接 fail (VER-2); 否则 callModel → 信其 pass 布尔。 */
export function createDefaultVerifier(opts: DefaultVerifierOpts): VerifierFn {
  const call = opts.callModelFn ?? send;
  const truths = opts.truths ?? {};
  // D-5 / G-4: **装配期**就把卷面渲染一次并断言真值都在上面 —— 缺即抛 = 拒起跑。
  // 放在这里而不是判卷时: 判卷时才发现, 已经跑完一整张 DAG 了 (那笔账正是这条契约要省的)。
  assertJudgingTruthsCarried(truths, verifierPrompt('', '', truths));
  return async ({ task, plan, results, artifactRoot, truths: callTruths }): Promise<VerifierVerdict> => {
    // 按调用真值 (1-A 冻结记录) 与装配期真值合并; 键在 TRUTH_LINES 里必有卷面写法 (编译期 Required 钉死), 不必再 assert。
    const paperTruths: JudgingTruths = callTruths ? { ...truths, ...callTruths } : truths;
    if (!opts.verifierModel) {
      throw new Error('verifier: verifierModel 必填 (无硬默认, 形如 provider:modelId)');
    }
    const leaves = Object.values(results);
    // VER-2b (2026-08-09 补): **零节点产出的跑永不算通过**。
    // 原判据写的是 `leaves.length > 0 && 全 failed`, 那个 `> 0` 让"一个 leaf 都没跑完"从闸边上溜过去 ——
    // 于是 verifier 拿着一份 `plan: X · 0 nodes` 的空摘要去问模型, 而模型对着空摘要照样可能判 pass。
    // 0 有效样本 ≠ 通过: 什么都没量到的跑不许是绿的 (`run-outcome.ts` 的「空图不编 success」是同一条判据
    // 的另一半, 那边早就这么写了)。与全 failed **分开报** —— 「没跑」和「跑了全挂」是两件事 (NULL ≠ 0)。
    // VER-4: 三条 fast-path 的打击对象一律 'implementation' —— 判卷官没被调到, 没有任何人说过判据有问题;
    // 「没跑 / 全挂」是执行侧的事, 拿它去重建判据是把一次执行事故读成判据事故。
    if (leaves.length === 0) {
      return { pass: false, reason: '零节点产出 — 一个 leaf 都没跑完, 0 有效样本 ≠ 通过', target: 'implementation', usage: { in: 0, out: 0 } };
    }
    // VER-2: 全失败 → 显然无产出, 省一次调用。
    if (leaves.every((l) => l.status === 'failed')) {
      return { pass: false, reason: '所有 leaf 执行失败 — 计划无产出', target: 'implementation', usage: { in: 0, out: 0 } };
    }
    const summary = summarizeResults(plan, results, artifactRoot);
    // D-3 (2026-09-05): 卷面加**引擎自己取的** git diff。此前卷面 = task + 结果自述 + truths,
    // 一个说"已完成"的 leaf 能同时过这道与 rubric 判官两道 —— 两道吃的是同一份自述。
    // 没给 artifactRoot ⇒ 空串 ⇒ 卷面逐字节同旧 (INV-6, 老调用方零回归)。
    const diffSection = artifactRoot ? renderDiffSection(renderDiffEvidence(artifactRoot)) : '';
    // A② GO fallback: verifierModel 走 opencode-go 端点溢出 → 回退 ds-v4-pro 官方 (跨模型校验不能因 GO 抖动整轮失败)。
    // 2026-09-11 降级座 (owner 裁): verifier 撞 session limit / 402 / 429 / 5xx → pools.fallbackVerify 里第一个
    // 可用坐标再判一次 (默认首选 agy-cli:claude-opus-4-6-thinking, 与 M3 异族、独立配额桶)。GO 抖动那格仍由内层管。
    const r = await withPoolFallback(opts.verifierModel, verifyFallbackPool(), (mm) => withGoFallback(mm, (m) =>
      call({
        model: m,
        // #144 洞 1: 这一发此前**不带 role** → 落进 seat-usage 的 `(unattributed)` 桶,
        // 于是"verifier 到底烧了多少"结构上答不出来。标签原文即座位名。
        meta: { role: 'verifier' },
        messages: [{ role: 'user', content: verifierPrompt(task, summary, paperTruths, diffSection) }],
        // 采样意图取自座位登记表 (model/seats.ts): 终审要**稳定** —— 同一份产出不该这次过下次不过。
        // C4: 座位采样经 config.seats 覆盖层 (无覆盖 = 编译期表逐字节同值)。
        ...effectiveSeatSampling('verifier'),
        // xhigh 推理档 + 700 预算 = reasoning 必吃光正文 (这是审查 oracle 闸, 空裁决最伤)。
        maxTokens: 8192,
        // 档由**座位登记表**驱动 (同 gate: 别让 seats.ts 写的东西到不了调用上)。
        // ⚠ 它今天坐在 codex 上, 而那家**关不掉思考** —— 2026-08-01 实测 xhigh 与 off 两臂逐字相同,
        // `reasoning=undefined` 时 gpt-5 照样内部推理。所以这个旋钮此刻是**没有效果**的, 不是没接。
        // 一旦这个座位挪到关得掉思考的模型 (如 deepseek), gate 那组对照就直接适用 —— **重量一次再定档**。
        thinkingLevel: opts.thinkingLevel ?? seatSpec('verifier')?.thinking ?? 'xhigh',
        responseSchema: VERIFIER_VERDICT_SCHEMA,
      }),
    ), { role: 'verifier' });
    const v = r.parsed as { pass: boolean; reason: string; target?: unknown } | undefined;
    // VER-1: 未结构化输出 → 保守 fail (不静默放行)。判卷官没说话, 分型同样只能是默认值。
    if (!v) return { pass: false, reason: 'verifier 未结构化输出 → 保守判不通过', target: 'implementation', usage: r.usage };
    const pass = v.pass === true;
    // VER-4 fail-open 的第二道 (schema 的 `.catch` 是第一道): 这里也归一化, 因为**注入式 callModelFn**
    // (测试 / 别处包一层的调用方) 的 parsed 不过 VERIFIER_VERDICT_SCHEMA —— 只有一道时, 分型会从
    // 那条路径漏成 undefined 或原样乱值, 而消费侧读到的是"判卷官的判定", 那就成了 NULL 冒充读数。
    const target: VerdictTarget = v.target === 'criterion' ? 'criterion' : 'implementation';
    return { pass, reason: pass ? v.reason ?? '已覆盖任务要求' : v.reason ?? '未满足任务要求', target, usage: r.usage };
  };
}

// ── R5 并行实装扇出的**比较卷** (2026-09-06, 契约 D-3 ③) ─────────────────────

/**
 * 一份候选实装在比较卷上的全部事实。判据结果**每份都一样地在场** —— 它们已经全过了同一条
 * 冻结判据 (只有绿的才进这张卷), 所以卷面问的不是"过没过", 而是"哪一份改得更对"。
 */
export interface FanoutCompareCandidate {
  index: number;
  exitCode: number | null;
  failing: number;
  diff: string;
}

/** 比较卷的输出面 —— 二字段, 与 `VERIFIER_VERDICT_SCHEMA` 无关 (D-7: 不动既有判词逻辑)。 */
export const FANOUT_COMPARE_SCHEMA = z.object({
  index: z.number().int(),
  reason: z.string(),
});

/** 单份 diff 进卷面的字符上限 —— 超出截断并写明截了多少 (「卷面被截过」不许静默)。 */
const FANOUT_DIFF_CAP = 12_000;

/**
 * 比较卷的卷面 (D-3 ③)。**与 `verifierPrompt` 完全分开**: 那一份是「攻击结果、默认怀疑」,
 * 这一份是「几份都过了同一条判据, 挑一份」—— 把选优塞进那份卷面会让它默认判 fail, 而这里
 * 没有"全都不选"这个出口 (机械档已经保证候选全绿)。
 *
 * 判据结果照抄进卷面而不是省略: 三份的退出码相同这件事本身就是判词的一部分 ——
 * 「判据分不开优劣」正是预注册里要收的那一格。
 */
export function renderFanoutComparePaper(task: string, candidates: readonly FanoutCompareCandidate[]): string {
  const blocks = candidates.map((c) => {
    const truncated = c.diff.length > FANOUT_DIFF_CAP;
    const body = truncated ? `${c.diff.slice(0, FANOUT_DIFF_CAP)}\n… (已截断, 原文 ${c.diff.length} 字符)` : c.diff;
    return [
      `===== 候选 #${c.index} =====`,
      `冻结判据: 退出码 ${c.exitCode === null ? 'null (死于信号)' : c.exitCode} · 失败用例 ${c.failing}`,
      body || '(这一份相对基线零改动)',
    ].join('\n');
  });
  return [
    '你在给同一个任务的几份**并行实装**挑一份。它们跑的是同一条 brief、同一条冻结判据, 而且**都已经过了那条判据** ——',
    '所以不要再判"过没过", 判的是「哪一份改得更对」。',
    '',
    '挑选顺序 (前面的压后面的):',
    '1. **改到了根上** —— 治的是成因, 不是把症状挡掉 (加特判 / 改测试预期 / 兜异常让它别抛, 都算挡症状);',
    '2. **覆盖完整** —— 同一个成因的其它调用点也一起改了, 不是只让判据点名的那一处过;',
    '3. **越界最少** —— 与任务无关的重构 / 顺手改的格式 / 新加的抽象, 都是减分项;',
    '4. 前三条分不开时, **改动更小的那一份**。',
    '',
    '原始任务:',
    '---',
    task,
    '---',
    '',
    ...blocks,
    '',
    '输出 JSON 两字段:',
    '- index (int): 你选的候选号, **必须**是上面出现过的号之一。',
    '- reason (string): 为什么是它 —— 点名它做到了而别的没做到的那一条 (机制级, 不是"看起来更好")。',
  ].join('\n');
}

export interface FanoutComparatorOpts {
  /** 比较卷坐哪个座 (通常 = verifier 座)。falsy → 调用时抛, 由扇出层退回机械档。 */
  model: string | undefined;
  /** 注入式 callModel (测试)。默认真 callModel。 */
  callModelFn?: typeof send;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
}

/**
 * 造一个比较卷判官 (D-3 ③)。**只在 ≥2 份绿时被调一次** —— 调用点在 `goal/orchestrating-loop.ts`。
 *
 * 拿不到结构化输出 / 点了不存在的号 ⇒ **抛**, 不猜: 扇出层接住这一抛退到 `least-failures`
 * (机械档), 那比让判官的一个坏输出决定合回哪份字节安全。
 */
export function createFanoutComparator(
  opts: FanoutComparatorOpts,
): (task: string, candidates: readonly FanoutCompareCandidate[]) => Promise<{ index: number; reason: string }> {
  const call = opts.callModelFn ?? send;
  return async (task, candidates) => {
    if (!opts.model) throw new Error('fanout compare: model 必填 (形如 provider:modelId)');
    const r = await withGoFallback(opts.model, (m) =>
      call({
        model: m,
        // #144 同款: 这一发带 role, 否则落进 seat-usage 的 `(unattributed)` 桶。
        meta: { role: 'verifier' },
        messages: [{ role: 'user', content: renderFanoutComparePaper(task, candidates) }],
        ...effectiveSeatSampling('verifier'),
        maxTokens: 4096,
        thinkingLevel: opts.thinkingLevel ?? seatSpec('verifier')?.thinking ?? 'xhigh',
        responseSchema: FANOUT_COMPARE_SCHEMA,
      }),
    );
    const v = r.parsed as { index?: unknown; reason?: unknown } | undefined;
    const index = typeof v?.index === 'number' ? v.index : Number.NaN;
    if (!candidates.some((c) => c.index === index)) {
      throw new Error(`fanout compare: 判官点了候选 ${String(v?.index)}, 不在候选名单 [${candidates.map((c) => c.index).join(', ')}] 里`);
    }
    return { index, reason: typeof v?.reason === 'string' ? v.reason : '(判官没写理由)' };
  };
}

export interface ResolveVerificationOpts {
  /** 关掉校验 (返空 config = 无 verifier, executor-dag 退回无校验老行为)。默认开。 */
  enabled?: boolean;
  /** 校验模型坐标。省略 = resolveRoleModel('verifier') (默认 deepseek, 跨 mimo conductor)。 */
  verifierModel?: string;
  /**
   * conductor 升级模型坐标 (verifier fail 时重规划用)。省略 = env OMD_CONDUCTOR_ESCALATION_MODEL。
   * **provider 未注册 (没配 API key) → executor-dag 自动不升级, 维持弱模型** (Nick 指令)。
   */
  escalationModel?: string;
  /** verifier-fail → 升级重规划的最大次数 (默认 executor-dag 的 1)。 */
  maxEscalations?: number;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  callModelFn?: typeof send;
  env?: Record<string, string | undefined>;
}

/**
 * wiring 层助手: 据 role-models + env 产 {verifier, conductorEscalationModel}, spread 进 dag config。
 * executor-dag 保持纯净 (不读 env / role-models, 设计锁); 这层负责"默认走哪个模型 + 升级模型从哪来"。
 */
export function resolveVerification(opts: ResolveVerificationOpts = {}): VerificationConfig {
  if (opts.enabled === false) {
    logger.info('[omd/verifier] 跨模型校验: OFF (OMD_VERIFY=0 显式关)');
    return { status: { enabled: false, reason: 'off:flag' } };
  }
  const env = opts.env ?? process.env;
  // **中间版** (fail-fast vs 优雅降级 的折中): 坐标坏时的行为分两种 ——
  //   · explicit (opts.verifierModel / OMD_VERIFIER_MODEL / file / override 指定过) → 用户明确要 verifier,
  //     坐标坏 = typo, **fail-fast throw** (别让他以为开着其实没开)。
  //   · 仅出厂 default 兜底 (没人显式配) 解析不了 → verifier 是可选增强, **优雅降级关闭**, 不砖 boot。
  // 两路都在 boot 早 detect (非等 leaves 跑完才在 verify 处崩, 那才是原始 footgun)。
  const verifierSource = listRoleModels(env).find((e) => e.role === 'verifier')?.source ?? 'default';
  const explicit = !!opts.verifierModel || verifierSource !== 'default';
  const verifierModel = opts.verifierModel ?? resolveRoleModel('verifier', env);
  try {
    assertModelResolvable(verifierModel, 'verifier');
  } catch (err) {
    // boot 永不砖 (owner 锁 2026-07-19): 配错 ≠ 不能启动 —— 用户必须能进 TUI/`omd init` 修配置。
    // explicit 配错时用 error 级响亮警告 (别让他以为开着) + 状态带 'off:invalid-explicit' 供 /config 展示。
    if (explicit) {
      logger.error(
        { verifierModel, err: (err as Error).message },
        `[omd/verifier] 跨模型校验: OFF — 显式指定的 verifier 模型无法解析 (typo? provider 未注册/缺 key?) ` +
          `— 修正 OMD_VERIFIER_MODEL / config.json 的 verifier 为完整 provider:model, 或跑 omd init 重配。`,
      );
      return { status: { enabled: false, reason: 'off:invalid-explicit' } };
    }
    logger.warn(
      { verifierModel, err: (err as Error).message },
      '[omd/verifier] 跨模型校验: OFF (默认 verifier 模型无法解析 → 降级; 设 OMD_VERIFIER_MODEL 启用)',
    );
    return { status: { enabled: false, reason: 'off:unresolved' } };
  }
  const verifier = createDefaultVerifier({
    verifierModel,
    thinkingLevel: opts.thinkingLevel,
    callModelFn: opts.callModelFn,
  });
  // `escalation` 座位经**单一 resolver** 解析 (INV-MODEL-1): config.models → env(正名 + 老名别名)
  // → auto-assign → defaultModel。此前这里直读 env, 于是 config 配了 escalation 也不生效 ——
  // 那个座位被 auto-assign 派了模型、被起跑自检查了凭证, 却没有任何人读它 (2026-07-28 空旋钮全仓扫)。
  const escalationModel = (opts.escalationModel ?? tryResolveSeatModel('escalation', { env })?.model)?.trim();
  logger.info(
    { verifierModel, escalationModel: escalationModel || undefined },
    '[omd/verifier] 跨模型校验: ON',
  );
  return {
    verifier,
    conductorEscalationModel: escalationModel || undefined,
    maxEscalations: opts.maxEscalations,
    status: { enabled: true, reason: 'on', verifierModel },
  };
}

/** escalation 模型是否可解析 (= 配了 key 或 pi 目录后备可达)。不可达 → 不升级, 维持弱模型。
 *  走完整解析链 (自有注册表 + pi-ai 目录后备) — 仅查 listProviders 会漏掉 kimi-coding 等
 *  OAuth provider (统一模型层后它们只在 pi 后备通道可达), 把 K3 挡在 escalation 位外。 */
export function escalationProviderReady(coord: string | undefined): coord is string {
  if (!coord) return false;
  try {
    assertModelResolvable(coord, 'escalation');
    return true;
  } catch {
    return false;
  }
}
