/**
 * map 子节点落账五位回归闸 (C-1 / INV-2, 2026-09-04)。
 *
 * 钉住的缺陷: runMapNode 内层泵把子节点结果直接写 `results[child.id]`, 绕过 settle() ——
 * 而 `durationMs / turns / injectedTokens / dagRound` 只在 settle 段里写, 于是账本里
 * 每个 `父::子` 节点 durationMs 恒 null (255 跑实测: 嵌套节点 49% 缺, 平铺 6%),
 * 读数板 >0.20 整图剔除, 主尺 O3a 分母被吃掉。
 *
 * 反向自检: 把 engine.ts runMapNode 里 `stampSettled(child.id)` 那行删掉 → 本测试红。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';

const N = 4;
const LIST_JSON = JSON.stringify({ items: Array.from({ length: N }, (_, i) => ({ k: `p${i}` })) });

const generate: GenerateFn = async (req) => {
  const user = req.messages.find((m) => m.role === 'user');
  const text = typeof user?.content === 'string' ? user.content : '';
  if (text.includes('只回一个 JSON 对象')) return { text: LIST_JSON, usage: { in: 1, out: 1 } };
  await new Promise((r) => setTimeout(r, 5));
  return { text: 'ok', usage: { in: 1, out: 1 } };
};

const mapPlan = (): ConductorPlan =>
  ({
    name: 'map-child-settle',
    nodes: {
      fan: {
        executor: 'map',
        map: { lister: { goal: '枚举 items' }, over: 'items', itemVar: 'it', keyBy: 'k', template: { goal: '处理 {{it.k}}' }, maxItems: 16 },
      },
    },
  }) as unknown as ConductorPlan;

const cfg: ExecutorDagConfig = { conductorModel: 'c:m', leafModel: 'l:m', generate, agentTemplates: new Map(), maxFanout: 4 };

describe('map 子节点落账五位 (C-1 / INV-2)', () => {
  test('每个 fan::p* 子节点的 durationMs 是 number, dagRound 是 number —— 不是 null 也不是缺席', async () => {
    const res = await runExecutorDagWithPlan(mapPlan(), cfg);
    const children = Object.keys(res.results).filter((id) => id.startsWith('fan::'));
    expect(children.length).toBe(N);
    for (const id of children) {
      const r = res.results[id]!;
      expect(r.status).toBe('done');
      expect(typeof r.durationMs).toBe('number');
      expect((r.durationMs as number) >= 0).toBe(true);
      expect(typeof r.dagRound).toBe('number');
    }
    // map 节点本身走外层 settle, 五位照旧 —— 抽函数不许把平铺节点修没了。
    expect(typeof res.results.fan!.durationMs).toBe('number');
  });
});
