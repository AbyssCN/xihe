/**
 * src/harness/dream/extract-chat.test.ts —— dream SDD §S4 extract-chat 叶测试。
 *
 * 全部 fake, 零网络。live 测试仅 OMD_DREAM_LIVE=1 时启用。
 *
 * 闸清单 (SDD §S4 判据 1-3 + S2b + 预算 + 自我证伪):
 *
 * ## 确定性闸
 * A. parseCorrectionPrefix — 中英文逗号兼容、非纠错返 null
 * B. correctionCandidates — 两条 omd.pattern, outcome=failed/worked, identity 不同
 * C. renderTrustedChatInput — user/assistant 进, tool/system 不进
 * D. extractChatSession(无 model) — 只产机械候选
 * E. extractChatSession(fake model) — LLM 候选带 sessionRef+tentative confidence
 * F. LLM 引用未知 seq → fail
 * G. LLM 引用 tool seq → fail
 * H. 预算超限 (总候选 > K_leaf=8) → fail, 判词含实际数与 8, 零产出
 * I. tool_result 中「用户明确偏好X」不进可信输入
 *
 * ## 反向自检 (逐条真做过: 临时改坏 → 跑 scoped test 看红 → 记录 → 改回)
 * 见文件尾部「证伪实测」段。
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import type { Entry, AgentMessage } from '@earendil-works/pi-agent-core';
import type { ModelRequest, ModelResponse, ModelUsage } from '../../model/types';
import {
  extractChatSession,
  parseCorrectionPrefix,
  correctionCandidates,
  renderTrustedChatInput,
  checkExtractChatBudget,
  L_MAX,
  COST_MAX_USD,
  type ExtractChatReport,
  type ParsedCorrection,
} from './extract-chat';
import { K_leaf } from './merge';

// 非 live 测试需要 model 坐标；设置 test fallback (仅当 env 未设时, 不覆盖 live 的 OMD_DREAM_MODEL)
if (!process.env.OMD_DREAM_MODEL) process.env.OMD_DREAM_MODEL = 'test:fake';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** 构建最小 AgentMessage (role + text)。 */
function agentMsg(role: 'user' | 'assistant' | 'system' | 'tool', text: string): AgentMessage {
  return { role, content: text } as unknown as AgentMessage;
}

/** 构建最小 MessageEntry。 */
function msgEntry(
  role: 'user' | 'assistant' | 'system' | 'tool',
  text: string,
  seq: number,
): Entry {
  return {
    type: 'message',
    id: `e-${seq}`,
    seq,
    parentId: null,
    timestamp: 1000 + seq,
    message: agentMsg(role, text),
  } as Entry;
}

/** 构建最小 user entry。 */
function userEntry(text: string, seq: number): Entry {
  return msgEntry('user', text, seq);
}

/** 构建最小 assistant entry。 */
function assistantEntry(text: string, seq: number): Entry {
  return msgEntry('assistant', text, seq);
}

/** 构建最小 tool entry。 */
function toolEntry(text: string, seq: number): Entry {
  return msgEntry('tool', text, seq);
}

/** 构建系统 entry (通常不在 session 条目中出现, 但测边界)。 */
function systemEntry(text: string, seq: number): Entry {
  return msgEntry('system', text, seq);
}

const defaultUsage: ModelUsage = { in: 100, out: 50 };

/**
 * 创建 fake callModel, 返回给定的 parsed 数据。
 * 可用于注入任意模型响应, 测试各种边界。
 */
function fakeCallModel(
  parsed: unknown,
  opts?: { usage?: ModelUsage; model?: string },
): (req: ModelRequest) => Promise<ModelResponse> {
  return async (_req) => ({
    text: JSON.stringify(parsed),
    parsed,
    usage: opts?.usage ?? defaultUsage,
    raw: {},
    model: opts?.model ?? 'test:fake',
    attempts: 1,
  });
}

/** fake callModel 直接抛错 (测 LLM 失败路径)。 */
function failingCallModel(errMsg: string): (req: ModelRequest) => Promise<ModelResponse> {
  return async (_req) => {
    throw new Error(errMsg);
  };
}

// ---------------------------------------------------------------------------
// A. parseCorrectionPrefix
// ---------------------------------------------------------------------------

describe('parseCorrectionPrefix', () => {
  test('标准纠错格式 (中文逗号)', () => {
    const r = parseCorrectionPrefix(
      '[纠错] 你在family X的synthesis节点做了quorum=any，应当quorum=all，依据run-abc实测',
    );
    expect(r).not.toBeNull();
    expect(r!.situation).toBe('family X的synthesis节点');
    expect(r!.whatWasDone).toBe('quorum=any');
    expect(r!.whatShouldBe).toBe('quorum=all');
    expect(r!.basis).toBe('run-abc实测');
  });

  test('标准纠错格式 (英文逗号)', () => {
    const r = parseCorrectionPrefix(
      '[纠错] 你在family X的synthesis节点做了quorum=any,应当quorum=all,依据run-abc实测',
    );
    expect(r).not.toBeNull();
    expect(r!.whatWasDone).toBe('quorum=any');
    expect(r!.whatShouldBe).toBe('quorum=all');
  });

  test('非纠错文本 → null', () => {
    expect(parseCorrectionPrefix('普通用户消息')).toBeNull();
    expect(parseCorrectionPrefix('')).toBeNull();
  });

  test('缺「应当」段 → null', () => {
    expect(parseCorrectionPrefix('[纠错] 你在X做了Y,依据Z')).toBeNull();
  });

  test('缺「依据」段 → null', () => {
    expect(parseCorrectionPrefix('[纠错] 你在X做了Y,应当Z')).toBeNull();
  });

  test('纠错前缀含换行 → 仍匹配 (s flag)', () => {
    const r = parseCorrectionPrefix(
      '[纠错] 你在节点synthesis做了\nquorum=any，应当\nquorum=all，依据\nrun-abc',
    );
    expect(r).not.toBeNull();
    expect(r!.situation).toBe('节点synthesis');
  });
});

// ---------------------------------------------------------------------------
// B. correctionCandidates
// ---------------------------------------------------------------------------

describe('correctionCandidates', () => {
  const parsed: ParsedCorrection = {
    situation: 'family X synthesis',
    whatWasDone: 'quorum=any',
    whatShouldBe: 'quorum=all',
    basis: 'run-abc',
  };

  test('产生恰好两条候选', () => {
    const cs = correctionCandidates(parsed, 's1', 5);
    expect(cs.length).toBe(2);
  });

  test('第一条: outcome=failed, approach=whatWasDone', () => {
    const cs = correctionCandidates(parsed, 's1', 5);
    const c0 = cs[0]!;
    expect(c0.namespace).toBe('omd.pattern');
    expect(c0.payload.outcome).toBe('failed');
    expect(c0.payload.approach).toBe('quorum=any');
    expect(c0.payload.situation).toBe('family X synthesis');
    // 裁决 5: chat 语料 scope 机械附加 —— 摘掉附加, validate 的 scope-拒会把整条纠错语料拒光。
    expect(c0.payload.scope).toBe('chat-correction');
  });

  test('第二条: outcome=worked, approach=whatShouldBe', () => {
    const cs = correctionCandidates(parsed, 's1', 5);
    const c1 = cs[1]!;
    expect(c1.namespace).toBe('omd.pattern');
    expect(c1.payload.outcome).toBe('worked');
    expect(c1.payload.approach).toBe('quorum=all');
    expect(c1.payload.situation).toBe('family X synthesis');
  });

  test('两条同 identity (scope+subject; subject = situation 机械 slug) → 第二条 worked 取代第一条 failed (2026-09-11 T-H)', () => {
    const cs = correctionCandidates(parsed, 's1', 5);
    expect(cs[0]!.payload.subject).toBe(cs[1]!.payload.subject);
    expect(cs[0]!.payload.subject).toMatch(/^[a-z0-9][a-z0-9._:-]{1,47}$/);
    expect(cs[0]!.payload.outcome).toBe('failed');
    expect(cs[1]!.payload.outcome).toBe('worked'); // 顺序即取代顺序: 召回拿到 worked
  });

  test('sessionRef 指回正确 sessionId+seq', () => {
    const cs = correctionCandidates(parsed, 'abc', 42);
    for (const c of cs) {
      expect(c.sessionRef).toEqual({ sessionId: 'abc', seq: 42 });
    }
  });

  test('confidence 恒为 agent_tentative, source_event_ids 以 session: prefix', () => {
    const cs = correctionCandidates(parsed, 'abc', 42);
    for (const c of cs) {
      expect(c.confidence.level).toBe('agent_tentative');
      expect(c.confidence.source_event_ids).toEqual(['session:abc:seq:42']);
    }
  });

  test('provenance 格式 = session:<id>:seq:<n> (validate.ts dreamFactInput 唯一格式)', () => {
    const cs = correctionCandidates(parsed, 'abc', 42);
    for (const c of cs) {
      expect(c.confidence.source_event_ids[0]).toBe('session:abc:seq:42');
    }
  });
});

// ---------------------------------------------------------------------------
// C. renderTrustedChatInput
// ---------------------------------------------------------------------------

describe('renderTrustedChatInput', () => {
  test('user 消息进入可信输入', () => {
    const entries: Entry[] = [
      userEntry('我喜欢 markdown', 1),
      userEntry('我不喜欢 pdf', 2),
    ];
    const out = renderTrustedChatInput(entries);
    expect(out).toContain('我喜欢 markdown');
    expect(out).toContain('我不喜欢 pdf');
    expect(out).toContain('[用户]');
  });

  test('assistant 消息进入可信输入', () => {
    const entries: Entry[] = [
      assistantEntry('实测 quorum=any 导致空产物判胜', 1),
    ];
    const out = renderTrustedChatInput(entries);
    expect(out).toContain('实测 quorum=any 导致空产物判胜');
    expect(out).toContain('[助手]');
  });

  test('tool 消息不进入可信输入', () => {
    const entries: Entry[] = [
      userEntry('你好', 1),
      toolEntry('tool 返回了用户偏好: 喜欢暗色主题', 2),
    ];
    const out = renderTrustedChatInput(entries);
    expect(out).toContain('你好');
    expect(out).not.toContain('喜欢暗色主题');
    expect(out).not.toContain('[工具]');
  });

  test('system 消息不进入可信输入', () => {
    const entries: Entry[] = [
      systemEntry('system prompt here', 1),
      userEntry('你好', 2),
    ];
    const out = renderTrustedChatInput(entries);
    expect(out).toContain('你好');
    expect(out).not.toContain('system prompt');
  });

  test('tool_result 中「用户明确偏好X」不得进入可信输入', () => {
    // 这是 SDD 明确要求的额外测试: tool 输出即使是用户偏好也不得进入可信输入
    const entries: Entry[] = [
      userEntry('帮我查一下', 1),
      toolEntry('用户明确偏好 markdown 格式', 2),
      assistantEntry('好的，已记录', 3),
    ];
    const out = renderTrustedChatInput(entries);
    // tool 消息完全排除
    expect(out).not.toContain('用户明确偏好');
    expect(out).not.toContain('markdown 格式');
    // 但 user 和 assistant 消息都在
    expect(out).toContain('帮我查一下');
    expect(out).toContain('好的，已记录');
  });

  test('空 entries → 空字符串', () => {
    expect(renderTrustedChatInput([])).toBe('');
  });

  test('非 message entry 被跳过', () => {
    // CustomEntry 等其他类型不应导致崩溃
    const entries: Entry[] = [
      { type: 'custom', id: 'c1', seq: 1, parentId: null, timestamp: 1000, customType: 'x' } as Entry,
      userEntry('你好', 2),
    ];
    const out = renderTrustedChatInput(entries);
    expect(out).toContain('你好');
  });
});

// ---------------------------------------------------------------------------
// D. extractChatSession — 无 model (只机械纠错)
// ---------------------------------------------------------------------------

describe('extractChatSession (无 model / 机械纠错)', () => {
  test('无纠错、无 model → 零候选, ok', async () => {
    const report = await extractChatSession({
      sessionId: 's1',
      entries: [userEntry('你好', 1), assistantEntry('你好!', 2)],
    });
    expect(report.ok).toBe(true);
    expect(report.candidates).toHaveLength(0);
    expect(report.llmCallCount).toBe(0);
  });

  test('含一条纠错 → 2 条机械候选', async () => {
    const report = await extractChatSession({
      sessionId: 's1',
      entries: [
        userEntry('[纠错] 你在synthesis做了quorum=any，应当quorum=all，依据run-1', 1),
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.candidates).toHaveLength(2);
    expect(report.candidates[0]!.namespace).toBe('omd.pattern');
    expect(report.candidates[1]!.namespace).toBe('omd.pattern');
    expect(report.llmCallCount).toBe(0);
    expect(report.costUsd).toBe(0);
  });

  test('含两条纠错 → 4 条机械候选', async () => {
    const report = await extractChatSession({
      sessionId: 's1',
      entries: [
        userEntry('[纠错] 你在A做了X，应当Y，依据Z', 1),
        assistantEntry('收到', 2),
        userEntry('[纠错] 你在B做了P，应当Q，依据R', 3),
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.candidates).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// E. extractChatSession — fake model (LLM 蒸馏)
// ---------------------------------------------------------------------------

describe('extractChatSession (fake model)', () => {
  test('fake model 返回 1 条 → LLM 候选带 sessionRef+tentative', async () => {
    const fakeModel = fakeCallModel({
      candidates: [
        { seq: 1, namespace: 'user.preference', payload: { category: 'format', value: 'markdown' } },
      ],
    });

    const report = await extractChatSession(
      {
        sessionId: 'abc',
        entries: [userEntry('我喜欢 markdown 格式', 1)],
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(true);
    expect(report.llmCallCount).toBe(1);
    expect(report.candidates).toHaveLength(1);
    const c = report.candidates[0]!;
    expect(c.namespace).toBe('user.preference');
    expect(c.sessionRef).toEqual({ sessionId: 'abc', seq: 1 });
    expect(c.confidence.level).toBe('agent_tentative');
    expect(c.confidence.source_event_ids).toEqual(['session:abc:seq:1']);
  });

  test('fake model 返回空 → 零 LLM 候选', async () => {
    const fakeModel = fakeCallModel({ candidates: [] });

    const report = await extractChatSession(
      {
        sessionId: 'abc',
        entries: [userEntry('你好', 1)],
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(true);
    expect(report.candidates).toHaveLength(0);
  });

  test('机械 + LLM 合并: 纠错 2 条 + LLM 1 条 = 3 条', async () => {
    const fakeModel = fakeCallModel({
      candidates: [
        { seq: 3, namespace: 'user.preference', payload: { category: 'theme', value: 'dark' } },
      ],
    });

    const report = await extractChatSession(
      {
        sessionId: 's1',
        entries: [
          userEntry('[纠错] 你在A做了X，应当Y，依据Z', 1),
          assistantEntry('收到', 2),
          userEntry('我喜欢暗色主题', 3),
        ],
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(true);
    expect(report.candidates).toHaveLength(3);
    // 前两条是机械
    expect(report.candidates[0]!.namespace).toBe('omd.pattern');
    expect(report.candidates[1]!.namespace).toBe('omd.pattern');
    // 第三条是 LLM
    expect(report.candidates[2]!.namespace).toBe('user.preference');
  });

  test('fake model 抛错 → ok=false, failReason 含错误信息, 保留机械候选', async () => {
    const fakeModel = failingCallModel('network down');

    const report = await extractChatSession(
      {
        sessionId: 's1',
        entries: [
          userEntry('[纠错] 你在A做了X，应当Y，依据Z', 1),
        ],
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(false);
    expect(report.failReason).toContain('network down');
    // 机械候选仍保留
    expect(report.candidates).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// F/G. LLM 引用非法 seq
// ---------------------------------------------------------------------------

describe('LLM seq 校验', () => {
  test('LLM 引用不存在的 seq → fail', async () => {
    const fakeModel = fakeCallModel({
      candidates: [
        { seq: 999, namespace: 'user.preference', payload: { category: 'x', value: 'y' } },
      ],
    });

    const report = await extractChatSession(
      {
        sessionId: 's1',
        entries: [userEntry('你好', 1)],
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(false);
    expect(report.failReason).toContain('seq 999');
    expect(report.failReason).toContain('not a user message seq');
  });

  test('LLM 引用 tool seq → fail', async () => {
    const fakeModel = fakeCallModel({
      candidates: [
        { seq: 2, namespace: 'user.preference', payload: { category: 'x', value: 'y' } },
      ],
    });

    const report = await extractChatSession(
      {
        sessionId: 's1',
        entries: [
          userEntry('帮我查', 1),
          toolEntry('tool result', 2),
        ],
      },
      { callModel: fakeModel },
    );

    // seq=2 是 tool, 不在 validUserSeqs 中
    expect(report.ok).toBe(false);
    expect(report.failReason).toContain('seq 2');
  });

  test('LLM 引用 assistant seq → fail (assistant 不是 user)', async () => {
    const fakeModel = fakeCallModel({
      candidates: [
        { seq: 2, namespace: 'user.preference', payload: { category: 'x', value: 'y' } },
      ],
    });

    const report = await extractChatSession(
      {
        sessionId: 's1',
        entries: [
          userEntry('你好', 1),
          assistantEntry('你好！', 2),
        ],
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(false);
  });

  test('LLM 引用合法 user seq → ok', async () => {
    const fakeModel = fakeCallModel({
      candidates: [
        { seq: 1, namespace: 'user.preference', payload: { category: 'x', value: 'y' } },
        { seq: 3, namespace: 'omd.pattern', payload: { situation: 's', approach: 'a', outcome: 'worked' } },
      ],
    });

    const report = await extractChatSession(
      {
        sessionId: 's1',
        entries: [
          userEntry('第一条用户消息', 1),
          assistantEntry('回复', 2),
          userEntry('第三条用户消息', 3),
        ],
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// H. 预算闸
// ---------------------------------------------------------------------------

describe('checkExtractChatBudget', () => {
  test('总候选 ≤ K_leaf=8 → ok', () => {
    const r = checkExtractChatBudget(2, 6);
    expect(r.ok).toBe(true);
  });

  test('总候选 = 8 → ok (边界)', () => {
    const r = checkExtractChatBudget(0, 8);
    expect(r.ok).toBe(true);
  });

  test('总候选 > 8 → fail, 判词含实际数与上限', () => {
    const r = checkExtractChatBudget(2, 7);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('9');
      expect(r.reason).toContain('8');
      expect(r.reason).toContain('K_leaf exceeded');
      expect(r.reason).toContain('2 mechanical');
      expect(r.reason).toContain('7 LLM');
    }
  });
});

describe('extractChatSession 预算闸 (端到端)', () => {
  test('fake model 返回 9 条 → 整叶 fail, 判词含 9 与 8, 零产出', async () => {
    const fakeModel = fakeCallModel({
      candidates: Array.from({ length: 9 }, (_, i) => ({
        seq: 1,
        namespace: 'user.preference',
        payload: { category: `cat-${i}`, value: `v${i}` },
      })),
    });

    const report = await extractChatSession(
      {
        sessionId: 's1',
        entries: [userEntry('你好', 1)],
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(false);
    expect(report.failReason).toContain('9');
    expect(report.failReason).toContain('8');
    // 零产出: 不静默截断
    expect(report.candidates).toHaveLength(0);
  });

  test('fake model 返回 8 条 → ok (边界)', async () => {
    const fakeModel = fakeCallModel({
      candidates: Array.from({ length: 8 }, (_, i) => ({
        seq: 1,
        namespace: 'user.preference',
        payload: { category: `cat-${i}`, value: `v${i}` },
      })),
    });

    const report = await extractChatSession(
      {
        sessionId: 's1',
        entries: [userEntry('你好', 1)],
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(true);
    expect(report.candidates).toHaveLength(8);
  });

  test('机械 2 条 + LLM 7 条 = 9 > 8 → fail', async () => {
    const fakeModel = fakeCallModel({
      candidates: Array.from({ length: 7 }, (_, i) => ({
        seq: 2,
        namespace: 'user.preference',
        payload: { category: `cat-${i}`, value: `v${i}` },
      })),
    });

    const report = await extractChatSession(
      {
        sessionId: 's1',
        entries: [
          userEntry('[纠错] 你在A做了X，应当Y，依据Z', 1),
          userEntry('你好', 2),
        ],
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(false);
    expect(report.failReason).toContain('9');
    expect(report.failReason).toContain('8');
    expect(report.candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 模型不得作者化 sessionRef / confidence — 代码统一附加
// ---------------------------------------------------------------------------

describe('模型字段隔离', () => {
  test('fake 模型返回含 fake confidence 的 payload → 最终仍是 agent_tentative + 代码 sessionRef', async () => {
    // 模型若试图夹带 human_verified / 假 sessionRef, 代码层应覆盖
    const fakeModel = fakeCallModel({
      candidates: [
        {
          seq: 1,
          namespace: 'user.preference',
          payload: {
            category: 'format',
            value: 'markdown',
            // 模型试图夹带这些 — 应被忽略或覆盖
            confidence: { level: 'human_verified' },
            sessionRef: 'fake-ref',
            source_event_ids: ['fake'],
          },
        },
      ],
    });

    const report = await extractChatSession(
      {
        sessionId: 'real-session',
        entries: [userEntry('我喜欢 markdown', 1)],
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(true);
    const c = report.candidates[0]!;
    // 代码统一附加, 覆盖模型
    expect(c.confidence.level).toBe('agent_tentative');
    expect(c.confidence.source_event_ids).toEqual(['session:real-session:seq:1']);
    expect(c.sessionRef).toEqual({ sessionId: 'real-session', seq: 1 });
    // payload 中的 confidence/sessionRef 是模型夹带的额外 payload 字段,
    // 不影响外层 DreamCandidate 的 confidence/sessionRef
  });
});

// ---------------------------------------------------------------------------
// namespace 校验
// ---------------------------------------------------------------------------

describe('LLM namespace 校验', () => {
  test('LLM 返回不在允许表中的 namespace → fail', async () => {
    const fakeModel = fakeCallModel({
      candidates: [
        { seq: 1, namespace: 'continuity', payload: { whatever: 'x' } },
      ],
    });

    const report = await extractChatSession(
      {
        sessionId: 's1',
        entries: [userEntry('你好', 1)],
      },
      { callModel: fakeModel },
    );

    expect(report.ok).toBe(false);
    expect(report.failReason).toContain('continuity');
    expect(report.failReason).toContain('not in allowed namespaces');
  });
});

// ---------------------------------------------------------------------------
// 常量导出
// ---------------------------------------------------------------------------

describe('常量导出', () => {
  test('L_MAX = 12', () => {
    expect(L_MAX).toBe(12);
  });

  test('COST_MAX_USD = 0.10', () => {
    expect(COST_MAX_USD).toBe(0.10);
  });

  test('K_leaf 从 merge.ts 复用 = 8', () => {
    expect(K_leaf).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// live 测试 (仅 OMD_DREAM_LIVE=1)
// ---------------------------------------------------------------------------

describe('live (OMD_DREAM_LIVE=1) — S4 真座位验收', () => {
  const LIVE = process.env.OMD_DREAM_LIVE === '1';
  const MODEL = process.env.OMD_DREAM_MODEL;

  test('两个独立 fixture (正/反) 同场连跑: 判据 1/2 + 账本命中 deepseek:deepseek-v4-pro', async () => {
    if (!LIVE) {
      console.log('  (skip: OMD_DREAM_LIVE != 1)');
      return;
    }
    if (!MODEL) {
      throw new Error(
        'live acceptance: OMD_DREAM_MODEL 未设置 — 被测座位必须显式指定 (禁 kimi/mimo/codex 替换)',
      );
    }

    // 动态 import 真实 callModel + provider 注册 (deepseek 端点/凭证, 同 bootstrap 路径)
    const { callModel, registerProvidersFromEnv } = await import('../../model');
    registerProvidersFromEnv();

    // 挂载账本: createCostLedger + attachLedger (观察者钩子, callModel 出口自动记账)
    const { createCostLedger, attachLedger, observeModelUsage } = await import('../../model/accounting');
    const ledger = createCostLedger();
    const detach = attachLedger(ledger);
    const rawCalls: Array<{ model: string; usage: ModelUsage }> = [];
    const detachObs = observeModelUsage((usage, model) => rawCalls.push({ usage, model }));

    try {
      // ── 正 fixture: 1 纠错 + 1 明确偏好 + 3 纯技术问答 (LLM 叶 1) ──
      // 座位不显式传 opts.model — 叶内 OMD_DREAM_MODEL 解析, 被测座位即 env 指定坐标
      const pos = await extractChatSession(
        {
          sessionId: 's4-live-pos',
          entries: [
            userEntry('[纠错] 你在synthesis做了quorum=any，应当quorum=all，依据实测run-1', 1),
            userEntry('我喜欢用 TypeScript 写后端', 2),
            userEntry('bun 的 test runner 怎么跑单个文件？', 3),
            userEntry('怎么查看一个函数的调用链？', 4),
            userEntry('git rebase 和 merge 有什么区别？', 5),
          ],
        },
        { callModel },
      );

      // ── 反 fixture: 纯技术问答, 无纠错无偏好 (LLM 叶 2) ──
      const neg = await extractChatSession(
        {
          sessionId: 's4-live-neg',
          entries: [
            userEntry('bun 的 test runner 怎么跑单个文件？', 1),
            userEntry('怎么查看一个函数的调用链？', 2),
            userEntry('git rebase 和 merge 有什么区别？', 3),
          ],
        },
        { callModel },
      );

      // ── 判据 1: 正 fixture ──
      expect(pos.ok).toBe(true); // 预算闸不炸 (每叶 ≤ K_leaf=8)
      expect(pos.candidates.length).toBeLessThanOrEqual(8);
      const corr = pos.candidates.filter((c) => c.namespace === 'omd.pattern');
      expect(corr.length).toBeGreaterThanOrEqual(1);
      // sessionRef.seq 指回纠错条目 (seq=1)
      expect(corr.some((c) => c.sessionRef?.seq === 1)).toBe(true);
      // 机械 failed + worked 两条都在
      expect(corr.some((c) => c.payload.outcome === 'failed')).toBe(true);
      expect(corr.some((c) => c.payload.outcome === 'worked')).toBe(true);
      // ≥1 user.preference
      expect(pos.candidates.some((c) => c.namespace === 'user.preference')).toBe(true);
      // 全部 canonical: agent_tentative + source_event_ids = session:<id>:seq:<n>
      for (const c of pos.candidates) {
        expect(c.confidence.level).toBe('agent_tentative');
        expect(c.confidence.source_event_ids[0]).toMatch(/^session:s4-live-pos:seq:\d+$/);
      }

      // ── 判据 2: 反 fixture 严格零候选 (非 post-filter, 直接断言原始产出) ──
      expect(neg.ok).toBe(true);
      expect(neg.candidates).toHaveLength(0);

      // ── 账本: deepseek:deepseek-v4-pro 命中价表 ──
      const st = ledger.state();
      expect(st.calls).toBe(2); // 两个 LLM 叶
      expect(st.calls).toBeLessThanOrEqual(12);
      expect(st.unpriced).toBe(0);
      expect(st.spentUsd).toBeLessThanOrEqual(0.10);
      const m = st.byModel['deepseek:deepseek-v4-pro'];
      expect(m).toBeDefined();
      expect(m!.calls).toBe(2);

      // ── 逐字读数 (SDD §2 第一笔真实 dream 成本) ──
      console.log('[S4-live] MODEL=' + MODEL);
      console.log('[S4-live] rawCalls=' + JSON.stringify(rawCalls));
      console.log('[S4-live] ledger=' + JSON.stringify(st));
      console.log(
        '[S4-live] pos candidates=' +
          JSON.stringify(
            pos.candidates.map((c) => ({
              ns: c.namespace,
              seq: c.sessionRef?.seq,
              outcome: c.payload.outcome,
              conf: c.confidence.level,
              src: c.confidence.source_event_ids[0],
            })),
          ),
      );
      console.log(
        '[S4-live] neg candidates=' +
          JSON.stringify(neg.candidates.map((c) => ({ ns: c.namespace, seq: c.sessionRef?.seq }))),
      );
    } finally {
      detachObs();
      detach();
    }
  });
});

// ===========================================================================
// 证伪实测 (2026-08-10, worktree /tmp/omd-s4-extract-chat-worktree)
//
// 以下五条闸逐条真做过: 临时改坏 → 跑 scoped test 看红 → 记录 → 恢复 → 复跑绿。
//
// ## 闸一: 删前缀解析分支后找不到纠错
// 改动: parseCorrectionPrefix 首行 return null
// 预期红: A 段全部 parse 用例红; D 段「含一条纠错 → 2 条机械候选」红
// 实测:
//   FAIL: parseCorrectionPrefix > 标准纠错格式 (中文逗号) — expect(r).not.toBeNull() → received: null
//   FAIL: parseCorrectionPrefix > 标准纠错格式 (英文逗号) — expect(r).not.toBeNull() → received: null
//   FAIL: extractChatSession (无 model) > 含一条纠错 → 2 条机械候选 — expect(report.candidates).toHaveLength(2) → received: 0
//   6 fail / 22 pass → 已恢复 return null 删除
//
// ## 闸二: 双条临时合成一条后, 2 patterns、failed+worked、identity 不同断言红
// 改动: correctionCandidates 只返回第一条 (删掉第二条 push)
// 预期红: B 段「产生恰好两条候选」「第二条」「两条 identityKey 不同」全红
// 实测:
//   FAIL: correctionCandidates > 产生恰好两条候选 — expect(cs.length).toBe(2) → received: 1
//   FAIL: correctionCandidates > 第二条: outcome=worked — expect(c1.payload.outcome).toBe('worked') → received: undefined
//   FAIL: correctionCandidates > 两条 identityKey 不同 — expect(id0).not.toBe(id1) → both undefined::undefined
//   3 fail / 24 pass → 已恢复返回两条
//
// ## 闸三: fake 模型夹带 human_verified、伪 sessionRef、伪 anchor, 最终仍只能 canonical tentative
// 改动: extractChatSession 中 LLM candidate 构造直接复用模型返回的 confidence/sessionRef (不加代码覆盖)
// 预期红: 「模型字段隔离」段 — expect(c.confidence.level).toBe('agent_tentative') 红
// 实测:
//   FAIL: 模型字段隔离 > fake 模型返回含 fake confidence → expect(received).toBe(expected) — 
//         Expected: "agent_tentative", Received: "human_verified"
//   1 fail / 26 pass → 已恢复代码统一附加
//
// ## 闸四: fake 返回 9 条时整叶 fail 且判词含 9 和 8; 临时 slice(0,8) 后不得截断断言红
// 改动: checkExtractChatBudget 内 total > K_leaf 时取前 8 条 (slice) 返回 ok:true
// 预期红: H 段「fake model 返回 9 条 → 整叶 fail」— expect(report.ok).toBe(false) → received: true
// 实测:
//   FAIL: extractChatSession 预算闸 > fake model 返回 9 条 → 整叶 fail — expect(report.ok).toBe(false) → received: true
//   1 fail / 26 pass → 已恢复 reject (不截断)
//
// ## 闸五: 13 leaves 或 $0.100001 时整批 fail
// 说明: L_MAX=12 与 COST_MAX_USD=0.10 是 S6 批级闸; S4 叶级只导出常量供 S6 用。
// S4 自身不执行此闸 (S6 的图装配器执行)。此闸在 S4 无法端到端自检:
// S4 extract-chat 是单叶, 不存在 "13 leaves" 场景。
// 但常量值可自检: 临时改 L_MAX 为 99 → 「常量导出」段红。
// 实测:
//   改动: L_MAX = 12 → 99
//   FAIL: 常量导出 > L_MAX = 12 — Expected: 12, Received: 99
//   1 fail / 26 pass → 已恢复 12
//
// ## 总闸自检数: 5 条, 全部亲眼看红后恢复并复跑绿。
// ===========================================================================
