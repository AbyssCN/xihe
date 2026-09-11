/**
 * goal/goal-recall —— **动手前按 goal 召回一次引擎记忆** (2026-09-11, owner 令「语料不用等」)。
 *
 * ## 它补的洞
 * dream 固化出来的 `omd.pattern` / `omd.limit` 在生产里**没有任何自动读取方**: memory_recall 只在人调时读,
 * 对话位自动注入 08-18 关掉 (M1 判「维持关闭」, 病因是每轮按最后一句话重查, 3 次注入 1 次相关)。
 * 这里换成 NOTES 里定好的形状: **点火一次、按 goal 冻结** —— 分类前召回 k 条, 渲染成一段线索, 追加到勘察正文末尾,
 * 与勘察包 / 规格包走同一条注入口 (D-1 一次生成一份文本, classify prompt / conductor 面 / work 子节点都读同一段)。
 *
 * ## 边界 (模型外结构)
 *  · 默认关 (`OMD_GOAL_RECALL=1` 才开): 单变量臂, 关着时所有 prompt 逐字节同旧 (INV-1)。
 *  · 只召回 `omd.pattern` / `omd.limit` (引擎自己的教训); user.* 与 continuity 不进 (那是对话位的事)。
 *  · 库 = `<root>/.omd/memory.db` (按仓); 不存在 / 打不开 → 零命中并留原文 (fail-open 不吞证据)。
 *  · 线索是线索不是真理: header 明写「与本次目标无关的忽略」, 不改判据轴。
 *  · 读数进 `LoopLedger.goalRecall` (k / hits / admitted / chars / why), 三态别压平: 缺席 = 没开; hits 0 = 开了没命中。
 *
 * ## 反向自检 (goal-recall.test.ts)
 *  把 `goalRecallEnabled` 改成恒 true → 「关着时 text 为空」红; 把 namespace 过滤删掉 → 「只收 omd.*」红。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger';
import { createOmdMemory, type OmdMemory } from '../memory';
import type { MemoryHit } from '../memory/types';
import { HOST_SAFEGUARD } from '../../memory/safeguards/namespaces';

export const GOAL_RECALL_HEADER = '===== 记忆线索 (引擎按目标召回, 是线索不是真理; 与本次目标无关的忽略) =====';
export const GOAL_RECALL_NAMESPACES = ['omd.pattern', 'omd.limit'] as const;
const DEFAULT_K = 5;
const DEFAULT_MAX_CHARS = 1_500;

export interface GoalRecallFacts {
  k: number;
  /** 检索返回的条数 (过滤前)。 */
  hits: number;
  /** 过 namespace 过滤 + 预算后真进文本的条数。 */
  admitted: number;
  chars: number;
  /** 零命中 / 库缺席 / 抛错的原文; 命中且在场时缺席。 */
  why?: string;
}

export interface GoalRecall {
  text: string;
  facts: GoalRecallFacts;
}

export function goalRecallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMD_GOAL_RECALL?.trim() === '1';
}

/** 一条事实 → 一行线索 (只用结构字段, 不用 fact 全文; 全文可能是几 KB)。 */
export function renderRecallLine(hit: MemoryHit): string | null {
  const f = hit.fact as Record<string, unknown>;
  const clip = (v: unknown, n: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  if (f.namespace === 'omd.pattern') {
    const head = [f.scope, f.subject].filter(Boolean).join('/');
    return `· [pattern${head ? ' ' + head : ''}] ${clip(f.situation, 140)} → ${clip(f.approach, 140)} (${f.outcome === 'worked' ? '有效' : '失败'})`;
  }
  if (f.namespace === 'omd.limit') {
    return `· [limit ${clip(f.kind, 20)}] ${clip(f.statement, 220)}`;
  }
  return null;
}

/**
 * 按 goal 召回并渲染。`memory` 可注入 (测试); 缺省按 `<root>/.omd/memory.db` 开, 不存在 → 零命中。
 */
export async function buildGoalRecall(
  goal: string,
  root: string,
  opts: { k?: number; maxChars?: number; memory?: OmdMemory } = {},
): Promise<GoalRecall> {
  const k = opts.k ?? DEFAULT_K;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const empty = (why: string): GoalRecall => ({ text: '', facts: { k, hits: 0, admitted: 0, chars: 0, why } });
  let memory = opts.memory;
  let opened = false;
  if (!memory) {
    const path = join(root, '.omd', 'memory.db');
    if (!existsSync(path)) return empty(`no-db: ${path}`);
    try {
      memory = createOmdMemory({ path, safeguard: HOST_SAFEGUARD });
      opened = true;
    } catch (err) {
      const why = `open-failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn({ path, why }, '[goal-recall] 记忆库打不开 → 本次不带线索 (fail-open, 证据在此)');
      return empty(why);
    }
  }
  try {
    const hits = await memory.retrieve(goal, k);
    const lines: string[] = [];
    let admitted = 0;
    for (const h of hits) {
      if (!(GOAL_RECALL_NAMESPACES as readonly string[]).includes(h.fact.namespace)) continue;
      const line = renderRecallLine(h);
      if (!line) continue;
      const next = [...lines, line].join('\n');
      if (GOAL_RECALL_HEADER.length + 2 + next.length > maxChars) break;
      lines.push(line);
      admitted++;
    }
    if (admitted === 0) return { text: '', facts: { k, hits: hits.length, admitted: 0, chars: 0, why: hits.length ? 'no-omd-hits' : 'no-hits' } };
    const text = `${GOAL_RECALL_HEADER}\n${lines.join('\n')}`;
    return { text, facts: { k, hits: hits.length, admitted, chars: text.length } };
  } catch (err) {
    const why = `retrieve-failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ root, why }, '[goal-recall] 召回抛错 → 本次不带线索 (fail-open, 证据在此)');
    return empty(why);
  } finally {
    if (opened) {
      try {
        (memory as unknown as { close?: () => void }).close?.();
      } catch (err) {
        logger.debug({ err: err instanceof Error ? err.message : String(err) }, '[goal-recall] 关库失败 (忽略)');
      }
    }
  }
}
