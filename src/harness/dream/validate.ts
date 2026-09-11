/**
 * src/harness/dream/validate —— dream SDD §S2 候选拒入阀(零 LLM,fixture 全闸)。
 *
 * 三层闸,顺序固定(测试依赖确定性判词):
 *
 *   1. **既有 floor 原样复用** `validateFactWrite(input, DEFAULT_SAFEGUARD, { scanSecrets: true })`
 *      (src/memory/safeguards/validator.ts)—— 五拒 malformed / banned:* / secret:* /
 *      schema:* / no-source-anchor / confidence-invalid **不新造**,判词原样透传。
 *      `scanSecrets` 必须 true:validator 头注 :21 点名的就是 dream 路(「仅自动学习路径」);
 *      memory.ts:70 与 pathfinder.ts:274 置 false 是**用户主权**,dream 不是用户。
 *      反向自检:置 false → 密钥用例放行变 written → validate.test.ts 当场红 ⇒ 闸没接
 *      (SDD 判据 3 原文证伪方式,实测记录见测试文件头)。
 *
 *   2. **S-拒(统计断言拒,纯函数零 IO)**:payload 全部字符串叶子(递归遍历同 scanForSecret
 *      形状)命中四条正则之一 → rejected,判词含 `statistical-assertion` 并指回 §8.2-2:
 *      「把统计数写成事实 = 抄一份会过期的账」。
 *
 *   3. **P-拒(provenance 可指回)**:sessionRef → `createOmdSessionStore(opts.cwd)` 开会话
 *      查 seq 真存在;runRef → RunStore 查 runId(默认路径 `join(opts.cwd, '.omd', 'runs.db')`,
 *      与 gather.ts 同锚法,可注入 runStore)。查不到 → rejected,判词含 `provenance`。
 *
 * **namespace 硬边界**:只允许 9 个 facet —— user.{preference,interest,focus,expertise,trait,goal}
 * + omd.{capability,pattern,limit}(DEFAULT_SAFEGUARD === UNIVERSAL_SAFEGUARD,namespaces.ts:37)。
 * 边界由 floor 的 allowlist schema 兑现,这里**不另写白名单**(写了就是第二份真源)。
 * identity 字段(supersession 键,merge 用;逐条核过 universal-namespaces.ts:115-128):
 *   user.preference ['category'] · user.interest ['topic'] · user.focus ['focus'] ·
 *   user.expertise ['domain'] · user.trait ['category'] · user.goal ['goal'] ·
 *   omd.capability ['area'] · omd.pattern ['scope','subject'] (2026-09-11 T-H 收窄; 无 subject 走旧键) · omd.limit ['kind','statement']
 * 反例活样本:sink.ts:111 的 `continuity` 不在允许表,生产装配恒被拒、fail-open 静默死 —— 别重蹈。
 *
 * ⚠ 一切盘路径锚 `opts.cwd`(S1 改判③:裸相对路径在临时 cwd 下静默读到主仓生产库)。
 */
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { validateFactWrite } from '../../memory/safeguards/validator';
import { DEFAULT_SAFEGUARD } from '../../memory/safeguards/namespaces';
import { OMD_ORACLE_SUBJECTS, OMD_PATTERN_SCOPES, OMD_PATTERN_SUBJECT_RE } from '../../memory/safeguards/universal-namespaces';
import { createOmdSessionStore, OMD_SESSION_ID_RE } from '../chat/session-store';
import { createRunStore, type RunStore } from '../../mcp/run-store';

// ---------------------------------------------------------------------------
// 类型(D-1:validate/merge 两节点共用,不得各自发明)
// ---------------------------------------------------------------------------

/** 硬边界:9 facet 之一(universal-namespaces.ts,SDD §S2 映射表)。 */
export type DreamNamespace =
  | 'user.preference'
  | 'user.interest'
  | 'user.focus'
  | 'user.expertise'
  | 'user.trait'
  | 'user.goal'
  | 'omd.capability'
  | 'omd.pattern'
  | 'omd.limit';

export interface DreamCandidate {
  /** 硬边界:9 facet 之一。 */
  namespace: DreamNamespace;
  /** facet 对应的 payload 字段(omd.pattern: situation/approach/outcome;omd.limit: kind/statement;omd.capability: area/...;user.* 按 schema)。 */
  payload: Record<string, unknown>;
  /** provenance 二选一,至少其一(都没有 → floor 的 no-source-anchor 拒掉)。 */
  sessionRef?: { sessionId: string; seq: number };
  runRef?: { runId: string; nodeId?: string };
  /** 编译期闸(裁决 10):字面量类型,dream 写不进别档。created_at 由本阀落 floor 前补。 */
  confidence: { level: 'agent_tentative'; source_event_ids: [string, ...string[]] };
}

export interface ValidateDreamOpts {
  /** 工作目录(仓根)—— 一切盘路径的锚。 */
  cwd: string;
  /** memory db(merge 写路径用;validate 本阀不碰 memory.db)。 */
  db?: Database;
  /** run 持久器。省略 = 默认 `join(cwd, '.omd', 'runs.db')`。 */
  runStore?: RunStore;
}

export type ValidateDreamResult =
  | { verdict: 'written' } // 通过全部闸,可进 merge(SD 判据措辞)
  | { verdict: 'rejected'; reason: string };

// ---------------------------------------------------------------------------
// S-拒:统计断言拒(SDD §S2,四条正则逐字冻结 —— 不许增删)
// ---------------------------------------------------------------------------

const STATISTICAL_PATTERNS: ReadonlyArray<RegExp> = [
  /\d+\s*次/,
  /\$\d+(\.\d+)?/,
  /\d+(\.\d+)?%/,
  /平均|总计|合计/,
];

/** 递归扫 payload 的所有字符串叶子(形状同 validator.ts scanForSecret),命中返回该正则。 */
function findStatisticalAssertion(value: unknown): RegExp | null {
  if (typeof value === 'string') {
    for (const re of STATISTICAL_PATTERNS) {
      if (re.test(value)) return re;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findStatisticalAssertion(item);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) {
      const hit = findStatisticalAssertion(v);
      if (hit !== null) return hit;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// P-拒:provenance 必须可指回(§8 verify(repro) 格的可执行版)
// ---------------------------------------------------------------------------

/** 查不到返回判词(含 `provenance` 子串,判据 1 机检点);全部指得回返回 null。 */
async function provenanceRejection(
  candidate: DreamCandidate,
  opts: ValidateDreamOpts,
): Promise<string | null> {
  if (candidate.sessionRef) {
    const { sessionId, seq } = candidate.sessionRef;
    // open() 对非法 id 直接抛(assertId)—— 非法 id 是「指不回」的一种,判拒不判炸。
    if (!OMD_SESSION_ID_RE.test(sessionId)) {
      return `provenance: illegal session id ${JSON.stringify(sessionId)}`;
    }
    // ⚠ 锚 opts.cwd:裸相对路径会读到主仓生产库(gather.ts 同源教训)。
    const sess = await createOmdSessionStore(opts.cwd).open(sessionId);
    if (!sess) {
      return `provenance: session ${JSON.stringify(sessionId)} not found under opts.cwd`;
    }
    const entries = await sess.entries();
    if (!entries.some((e) => e.seq === seq)) {
      return `provenance: session ${JSON.stringify(sessionId)} has no entry seq ${seq}`;
    }
  }
  if (candidate.runRef) {
    const { runId } = candidate.runRef;
    const ownStore = !opts.runStore;
    const runStore: RunStore =
      opts.runStore ?? createRunStore({ path: join(opts.cwd, '.omd', 'runs.db') });
    try {
      if (!runStore.all().some((r) => r.runId === runId)) {
        return `provenance: run ${JSON.stringify(runId)} not found`;
      }
    } finally {
      if (ownStore) runStore.close();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/**
 * 候选 → fact 输入的**唯一**构造点(validate 的 floor 校验与 merge 的 writeFact 必须
 * 消费同一个形状 —— 校验的和写入的不是同一个 fact,闸就白过了)。
 * anchor 格式:sessionRef → source_event_id `session:<id>:seq:<n>`;
 * runRef → source_doc_id `run:<id>[:node:<x>]`。两 ref 都没有 → floor no-source-anchor 拒。
 */
export function dreamFactInput(candidate: DreamCandidate): Record<string, unknown> {
  const fact: Record<string, unknown> = {
    namespace: candidate.namespace,
    ...candidate.payload,
    confidence: { ...candidate.confidence, created_at: new Date() },
  };
  if (candidate.sessionRef) {
    fact.source_event_id = `session:${candidate.sessionRef.sessionId}:seq:${candidate.sessionRef.seq}`;
  }
  if (candidate.runRef) {
    fact.source_doc_id = `run:${candidate.runRef.runId}${candidate.runRef.nodeId ? `:node:${candidate.runRef.nodeId}` : ''}`;
  }
  return fact;
}

export async function validateDreamCandidate(
  candidate: DreamCandidate,
  opts: ValidateDreamOpts,
): Promise<ValidateDreamResult> {
  // ── 1. 既有 floor,原样复用;scanSecrets 恒 true(dream 是自动学习路径,非用户主权)──
  // ⚠ 校验对象 = dreamFactInput(candidate),与 merge 写入的是同一个构造(D-1)。
  const floor = validateFactWrite(dreamFactInput(candidate), DEFAULT_SAFEGUARD, {
    scanSecrets: true,
  });
  if (!floor.ok) return { verdict: 'rejected', reason: floor.reason };

  // ── 1b. scope-拒(裁决 5,dream 侧硬闸;pathfinder 等既有写手不走本阀所以 schema 里 optional)──
  // 证伪方式 (validate.test.ts): omd.pattern 候选去掉 payload.scope → rejected 含 'scope';补回 → written。
  if (candidate.namespace === 'omd.pattern') {
    const scope = candidate.payload.scope;
    if (typeof scope !== 'string' || !(OMD_PATTERN_SCOPES as readonly string[]).includes(scope)) {
      return {
        verdict: 'rejected',
        reason:
          `scope-invalid: omd.pattern 候选必带受控 scope (${OMD_PATTERN_SCOPES.join('/')}) —— ` +
          `裁决 5: identityKey 依赖自由文本 = 复现机制结构性失效`,
      };
    }
    // ── 1c. subject-拒 (2026-09-11, T-H): identity 第二槽必带且合法; oracle 只认闭集。
    // 证伪方式 (validate.test.ts): 去掉 payload.subject → rejected 含 'subject'; oracle 给闭集外的词 → rejected。
    const subject = candidate.payload.subject;
    if (typeof subject !== 'string' || !OMD_PATTERN_SUBJECT_RE.test(subject)) {
      return { verdict: 'rejected', reason: `subject-invalid: omd.pattern 候选必带 subject slug (${OMD_PATTERN_SUBJECT_RE}) —— T-H: 自由文本身份让晋升永不触发` };
    }
    if (scope === 'oracle' && !(OMD_ORACLE_SUBJECTS as readonly string[]).includes(subject)) {
      return { verdict: 'rejected', reason: `subject-invalid: scope=oracle 的 subject 只认 ${OMD_ORACLE_SUBJECTS.join('/')}, 收到 '${subject}'` };
    }
  }

  // ── 2. S-拒(纯函数零 IO,先于有 IO 的 P-拒)──
  const stat = findStatisticalAssertion(candidate.payload);
  if (stat !== null) {
    return {
      verdict: 'rejected',
      reason: `statistical-assertion:${stat.source} —— §8.2-2:把统计数写成事实 = 抄一份会过期的账`,
    };
  }

  // ── 3. P-拒(provenance 可指回)──
  const prov = await provenanceRejection(candidate, opts);
  if (prov !== null) return { verdict: 'rejected', reason: prov };

  return { verdict: 'written' };
}
