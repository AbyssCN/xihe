/**
 * src/harness/dream/validate.test —— dream SDD §S2 拒入阀闸(零 LLM,fixture 全闸)。
 *
 * 闸清单:
 * 1. 判据 2 那对样本**逐字**(SDD 原文:「这一对是整条闸的存在理由」):
 *    「family X 造过 3 次假绿」→ rejected(statistical-assertion);
 *    「family X 的 synthesis 节点用 quorum=any 会把空产物读成冠军(runId+nodeId)」→ written。
 * 2. 判据 1 P-拒:假 seq / 假 sessionId / 假 runId → rejected 且 reason 含 `provenance`;
 *    反向:真 seq / 真 runId → written。
 * 3. 判据 3 密钥:payload 含 `sk-ant-…` 形 → rejected,reason 以 `secret:` 开头
 *    (证明 scanSecrets:true 真接上了)。
 * 4. floor 五拒透传抽样:malformed / schema / no-source-anchor / confidence 错。
 * 5. namespace 硬边界:`continuity`(sink.ts:111 活样本)→ schema 拒。
 *
 * ## 逐条证伪方式(全部实跑过:改坏 → 亲眼看红 → 记录 → 改回;记录见下方「证伪实测」)
 *
 * a. scanSecrets 置 false(validate.ts floor 调用第三实参)→ 密钥用例放行变 written → 红
 *    ⇒ 闸没接(SDD 判据 3 原文证伪方式)。
 * b. 从 STATISTICAL_PATTERNS 去掉 `/\d+\s*次/` → 「family X 造过 3 次假绿」变 written → 红。
 * c. 跳过 session store 查实(provenanceRejection 的 sessionRef 分支提前 return null)
 *    → 伪造 seq 用例变 written → 红。
 *
 * ## 证伪实测(2026-08-10,worktree /tmp/omd-s2-dag-worktree)
 * ## 证伪实测(2026-08-10,worktree /tmp/omd-s2-dag-worktree;行号为证伪当时,本段回填后有平移)
 * a. 改动:validate.ts:186 `{ scanSecrets: true }` → `{ scanSecrets: false }`。
 *    红:本文件 :214「判据 3 密钥 > payload 含 sk-ant- 形密钥 → rejected,reason 以 secret: 开头」。
 *    报错原文:`expect(received).toBe(expected)` / `Expected: "rejected"` / `Received: "written"`
 *    (validate.test.ts:214:23)。1 fail / 11 pass。已改回 true。
 * b. 改动:从 STATISTICAL_PATTERNS 删去 `/\d+\s*次/` 一条(剩三条)。
 *    红:本文件 :112「判据 2 S-拒对(逐字样本) > 「family X 造过 3 次假绿」→ rejected…」。
 *    报错原文:`Expected: "rejected"` / `Received: "written"`(validate.test.ts:112:23)。
 *    1 fail / 11 pass。已补回该正则。
 * c. 改动:provenanceRejection 的 sessionRef 分支首行插 `return null;`(跳过 session 查实)。
 *    红两条:本文件 :150「假 seq → rejected,reason 含 provenance」与
 *    :172「不存在的 sessionId → rejected,reason 含 provenance」。
 *    报错原文均为 `Expected: "rejected"` / `Received: "written"`
 *    (validate.test.ts:150:23 / :172:23)。2 fail / 10 pass。已删掉该插入行。
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createOmdSessionStore, resetSessionCacheForTest } from '../chat/session-store';
import { identityKeyOf } from '../../memory/safeguards/namespaces';
import { createRunStore, type RunStore } from '../../mcp/run-store';
import {
  validateDreamCandidate,
  type DreamCandidate,
  type ValidateDreamOpts,
} from './validate';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const msg = (role: 'user' | 'assistant', text: string): AgentMessage =>
  ({ role, content: [{ type: 'text', text }] }) as unknown as AgentMessage;

const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'omd-dream-validate-'));

/** 造一个当真能指回的 session provenance:建会话、写两条、回读真 seq。 */
async function realSessionRef(cwd: string): Promise<{ sessionId: string; seq: number }> {
  const store = createOmdSessionStore(cwd);
  const s = await store.create('s1');
  await s.append(msg('user', 'quorum=any 把空产物读成冠军'));
  await s.append(msg('assistant', '收到,空产物判败'));
  const entries = await s.entries();
  return { sessionId: 's1', seq: entries[entries.length - 1]!.seq };
}

/** 内存 runStore,预置一条 done run。 */
function runStoreWith(runId: string): RunStore {
  const rs = createRunStore({ db: new Database(':memory:') });
  rs.put({
    runId,
    status: 'done',
    goal: 'test',
    meta: {},
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ownerPid: null,
  });
  return rs;
}

const patternPayload = (situation: string): Record<string, unknown> => ({
  situation,
  approach: '空产物判败不入账',
  outcome: 'failed',
  scope: 'oracle',
  subject: 'acceptance-command', // 2026-09-11 T-H: identity 第二槽, dream 侧必带
});

const makeCandidate = (
  payload: Record<string, unknown>,
  refs: Pick<DreamCandidate, 'sessionRef' | 'runRef'>,
): DreamCandidate => ({
  namespace: 'omd.pattern',
  payload,
  ...refs,
  confidence: { level: 'agent_tentative', source_event_ids: ['e1'] },
});

// ---------------------------------------------------------------------------
// 判据 2:S-拒那对样本(逐字)
// ---------------------------------------------------------------------------

describe('判据 2 S-拒对(逐字样本)', () => {
  let cwd: string;
  let opts: ValidateDreamOpts;

  beforeEach(async () => {
    resetSessionCacheForTest();
    cwd = tmpDir();
    opts = { cwd, runStore: runStoreWith('r1') };
  });

  test('「family X 造过 3 次假绿」→ rejected(statistical-assertion,指回 §8.2-2)', async () => {
    const r = await validateDreamCandidate(
      makeCandidate(patternPayload('family X 造过 3 次假绿'), {
        sessionRef: await realSessionRef(cwd),
      }),
      opts,
    );
    expect(r.verdict).toBe('rejected');
    if (r.verdict !== 'rejected') return;
    expect(r.reason).toContain('statistical-assertion');
    expect(r.reason).toContain('§8.2-2');
  });

  test('「family X 的 synthesis 节点用 quorum=any 会把空产物读成冠军(runId+nodeId)」→ written', async () => {
    const r = await validateDreamCandidate(
      makeCandidate(
        patternPayload('family X 的 synthesis 节点用 quorum=any 会把空产物读成冠军(runId+nodeId)'),
        { runRef: { runId: 'r1', nodeId: 'synthesis' } },
      ),
      opts,
    );
    expect(r.verdict).toBe('written');
  });
});

// ---------------------------------------------------------------------------
// 判据 1:P-拒(provenance 可指回)
// ---------------------------------------------------------------------------

describe('判据 1 P-拒', () => {
  let cwd: string;

  beforeEach(() => {
    resetSessionCacheForTest();
    cwd = tmpDir();
  });

  test('假 seq → rejected,reason 含 provenance', async () => {
    const ref = await realSessionRef(cwd);
    const r = await validateDreamCandidate(
      makeCandidate(patternPayload('family X 的 synthesis 空产物判败'), {
        sessionRef: { sessionId: ref.sessionId, seq: ref.seq + 999 },
      }),
      { cwd },
    );
    expect(r.verdict).toBe('rejected');
    if (r.verdict !== 'rejected') return;
    expect(r.reason).toContain('provenance');
  });

  test('反向自检:真 seq → written(判据 1 原文)', async () => {
    const r = await validateDreamCandidate(
      makeCandidate(patternPayload('family X 的 synthesis 空产物判败'), {
        sessionRef: await realSessionRef(cwd),
      }),
      { cwd },
    );
    expect(r.verdict).toBe('written');
  });

  test('不存在的 sessionId → rejected,reason 含 provenance', async () => {
    const r = await validateDreamCandidate(
      makeCandidate(patternPayload('family X 的 synthesis 空产物判败'), {
        sessionRef: { sessionId: 'ghost', seq: 1 },
      }),
      { cwd },
    );
    expect(r.verdict).toBe('rejected');
    if (r.verdict !== 'rejected') return;
    expect(r.reason).toContain('provenance');
  });

  test('假 runId → rejected,reason 含 provenance;真 runId → written', async () => {
    const payload = patternPayload('family X 的 synthesis 空产物判败');
    const bad = await validateDreamCandidate(
      makeCandidate(payload, { runRef: { runId: 'ghost-run' } }),
      { cwd, runStore: runStoreWith('r1') },
    );
    expect(bad.verdict).toBe('rejected');
    if (bad.verdict === 'rejected') expect(bad.reason).toContain('provenance');

    const good = await validateDreamCandidate(
      makeCandidate(payload, { runRef: { runId: 'r1' } }),
      { cwd, runStore: runStoreWith('r1') },
    );
    expect(good.verdict).toBe('written');
  });
});

// ---------------------------------------------------------------------------
// 判据 3:密钥(scanSecrets:true 接线证明)
// ---------------------------------------------------------------------------

describe('判据 3 密钥', () => {
  test('payload 含 sk-ant- 形密钥 → rejected,reason 以 secret: 开头', async () => {
    resetSessionCacheForTest();
    const cwd = tmpDir();
    // 候选其余部分完全合法:证伪 a(scanSecrets 置 false)时此例必须放行变 written,
    // 红的就是这条 —— 它是 scanSecrets 闸真接上的唯一证据。
    const r = await validateDreamCandidate(
      makeCandidate(
        {
          ...patternPayload('family X 的 synthesis 空产物判败'),
          note: '顺便捡到的 key: sk-ant-abcdefghijklmnop1',
        },
        { sessionRef: await realSessionRef(cwd) },
      ),
      { cwd },
    );
    expect(r.verdict).toBe('rejected');
    if (r.verdict !== 'rejected') return;
    expect(r.reason.startsWith('secret:')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// floor 五拒透传抽样 + namespace 硬边界
// ---------------------------------------------------------------------------

describe('floor 五拒透传(不新造,判词原样)', () => {
  let cwd: string;

  beforeEach(() => {
    resetSessionCacheForTest();
    cwd = tmpDir();
  });

  test('malformed:非对象候选 → malformed', async () => {
    const r = await validateDreamCandidate({} as DreamCandidate, { cwd });
    expect(r.verdict).toBe('rejected');
    if (r.verdict !== 'rejected') return;
    expect(r.reason).toBe('malformed');
  });

  test('schema:omd.pattern 缺 outcome → schema:* 透传', async () => {
    const r = await validateDreamCandidate(
      makeCandidate({ situation: 's', approach: 'a' }, { sessionRef: await realSessionRef(cwd) }),
      { cwd },
    );
    expect(r.verdict).toBe('rejected');
    if (r.verdict !== 'rejected') return;
    expect(r.reason.startsWith('schema:')).toBe(true);
  });

  test('no-source-anchor:两 ref 都缺 → no-source-anchor', async () => {
    const noRefs = { sessionRef: undefined, runRef: undefined };
    const r = await validateDreamCandidate(
      makeCandidate(patternPayload('family X 的 synthesis 空产物判败'), noRefs),
      { cwd },
    );
    expect(r.verdict).toBe('rejected');
    if (r.verdict !== 'rejected') return;
    expect(r.reason).toBe('no-source-anchor');
  });

  test('confidence 错:伪造 agent_confident(2 ids)→ floor 拒', async () => {
    // ⚠ confidence-invalid 分支(validator.ts:185)与 namespace schema 共用同一张
    // ConfidenceSchema → 坏 confidence 必然先在第 4 步以 schema:* 透出;
    // :185 是防「未来 schema 编辑丢字段」的 assert,经本阀不可达。断言透传前缀 schema:。
    const c = makeCandidate(patternPayload('family X 的 synthesis 空产物判败'), {
      sessionRef: await realSessionRef(cwd),
    });
    const forged = {
      ...c,
      confidence: { level: 'agent_confident', source_event_ids: ['e1', 'e2'] },
    } as unknown as DreamCandidate;
    const r = await validateDreamCandidate(forged, { cwd });
    expect(r.verdict).toBe('rejected');
    if (r.verdict !== 'rejected') return;
    expect(r.reason.startsWith('schema:')).toBe(true);
  });

  // banned:* 在 DEFAULT_SAFEGUARD 下不可达:universal pack 无 banGlobs
  // (universal-namespaces.ts —— ban 是辖区/domain pack 的事)。不抽样。
});

describe('namespace 硬边界(9 facet,不另写白名单 —— floor allowlist 兑现)', () => {
  test('continuity(sink.ts:111 活样本)→ schema 拒', async () => {
    resetSessionCacheForTest();
    const cwd = tmpDir();
    const c = makeCandidate(patternPayload('family X 的 synthesis 空产物判败'), {
      sessionRef: await realSessionRef(cwd),
    });
    const forged = { ...c, namespace: 'continuity' } as unknown as DreamCandidate;
    const r = await validateDreamCandidate(forged, { cwd });
    expect(r.verdict).toBe('rejected');
    if (r.verdict !== 'rejected') return;
    expect(r.reason.startsWith('schema:')).toBe(true);
  });
});

describe('scope-拒(裁决 5:omd.pattern 必带受控 scope)', () => {
  // 证伪方式 (当场验过): 注释掉 validate.ts 的 1b scope-拒块 → 第一条测试红
  // (缺 scope 的候选 floor 全过、S/P 拒都不命中 → written); 恢复后绿。
  test('缺 scope → rejected,判词含 scope-invalid', async () => {
    resetSessionCacheForTest();
    const cwd = tmpDir();
    const { scope: _drop, ...noScope } = patternPayload('family X 的 synthesis 空产物判败');
    const r = await validateDreamCandidate(
      makeCandidate(noScope, { sessionRef: await realSessionRef(cwd) }),
      { cwd },
    );
    expect(r.verdict).toBe('rejected');
    if (r.verdict !== 'rejected') return;
    expect(r.reason).toContain('scope-invalid');
  });

  test('枚举外 scope → rejected;合法 scope → written(反向自检)', async () => {
    resetSessionCacheForTest();
    const cwd = tmpDir();
    const ref = { sessionRef: await realSessionRef(cwd) };
    const bad = await validateDreamCandidate(
      makeCandidate({ ...patternPayload('family X 的 synthesis 空产物判败'), scope: 'vibes' }, ref),
      { cwd },
    );
    expect(bad.verdict).toBe('rejected');
    const good = await validateDreamCandidate(
      makeCandidate(patternPayload('family X 的 synthesis 空产物判败'), ref),
      { cwd },
    );
    expect(good.verdict).toBe('written');
  });

  test('scope 入 identityKey:同文异 scope 不同键,缺 scope 老行落 null 槽不撞新行', () => {
    const base = {
      namespace: 'omd.pattern',
      situation: 's',
      approach: 'a',
      outcome: 'failed',
    };
    const kOracle = identityKeyOf({ ...base, scope: 'oracle' } as never);
    const kPlan = identityKeyOf({ ...base, scope: 'plan-family' } as never);
    const kLegacy = identityKeyOf(base as never);
    expect(kOracle).not.toBe(kPlan);
    expect(kLegacy).not.toBe(kOracle);
    expect(kLegacy).toContain('null');
  });

  /**
   * 2026-09-11 (T-H): subject 入键, situation/approach/outcome 出键。
   * 反向自检: 把 OMD_NAMESPACE_IDENTITY_FIELDS['omd.pattern'] 改回 ['situation','approach','scope'] → 第一条红;
   * 删掉 kernel 的 legacy 回落 → 第三条红 (无 subject 的两条 pattern 塌成同键)。
   */
  test('subject 入 identityKey:同 scope+subject 异 situation/approach/outcome 同键; 无 subject 走旧键', () => {
    const a = { namespace: 'omd.pattern', scope: 'oracle', subject: 'verifier', situation: 's1', approach: 'a1', outcome: 'failed' };
    const b = { namespace: 'omd.pattern', scope: 'oracle', subject: 'verifier', situation: 's2', approach: 'a2', outcome: 'worked' };
    expect(identityKeyOf(a as never)).toBe(identityKeyOf(b as never));
    expect(identityKeyOf({ ...a, subject: 'judge' } as never)).not.toBe(identityKeyOf(a as never));
    const legacy1 = { namespace: 'omd.pattern', scope: 'oracle', situation: 's1', approach: 'a1', outcome: 'failed' };
    const legacy2 = { namespace: 'omd.pattern', scope: 'oracle', situation: 's2', approach: 'a1', outcome: 'failed' };
    expect(identityKeyOf(legacy1 as never)).not.toBe(identityKeyOf(legacy2 as never));
  });

  test('subject-拒: dream 侧 omd.pattern 缺 subject → rejected; oracle 给闭集外 subject → rejected', async () => {
    resetSessionCacheForTest();
    const cwd = tmpDir();
    const ref = { sessionRef: await realSessionRef(cwd) };
    const { subject: _drop, ...noSubject } = patternPayload('family X 的 synthesis 空产物判败');
    const r1 = await validateDreamCandidate(makeCandidate(noSubject, ref), { cwd });
    expect(r1.verdict).toBe('rejected');
    if (r1.verdict === 'rejected') expect(r1.reason).toContain('subject');
    const r2 = await validateDreamCandidate(makeCandidate({ ...patternPayload('family X 的 synthesis 空产物判败'), subject: 'vibes' }, ref), { cwd });
    expect(r2.verdict).toBe('rejected');
    if (r2.verdict === 'rejected') expect(r2.reason).toContain('subject-invalid');
  });
});
