/**
 * D-3 verifier 卷面加 diff (契约 `docs/plan/2026-09-05-假success三闸-执行契约.md` 切片 3) —— INV-6。
 *
 * 它治的是一条**盘上判例**: 卷面 = `task + summarizeResults + truths`, 没有一行 diff, 判官也
 * 读不了文件。于是一个自述「已完成」而 `agent.patch` 零行的 leaf 能同时过跨模型终审与 rubric
 * 判官两道 —— 两道吃的都是同一份自述。加了这一节, 「零改动」这件事第一次进得了判官的眼睛。
 *
 * ## 证伪 (每条真跑过一次)
 * · 去掉 `renderDiffSection` 里那句「盘上零改动」⇒ ★干净仓那条红。
 * · 把 `artifactRoot ? … : ''` 改成无条件渲染 ⇒ 「没给 artifactRoot 卷面同旧」那条红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultVerifier, renderDiffSection } from './verifier';
import type { ConductorPlan } from './conductor-plan';
import type { LeafResult } from './dag/engine';

const plan: ConductorPlan = { name: 'p', nodes: { impl: { goal: '把功能实装出来', executor: 'leaf' } } };
const results: Record<string, LeafResult> = {
  impl: {
    id: 'impl',
    status: 'done',
    kind: 'inproc',
    // 假 success 的典型自述: 说完成了, 而盘上一个字节都没动。
    output: '已完成: 功能已实装并自测通过。',
    deps: [],
    usage: { in: 0, out: 0 },
  } as unknown as LeafResult,
};

/** 造一个只捕获 prompt 的 verifier (照抄 verifier-truths.test.ts 的惯例)。 */
function capturing() {
  let seen = '';
  const verifier = createDefaultVerifier({
    verifierModel: 'fake:m',
    callModelFn: (async (req: { messages: Array<{ content: string }> }) => {
      seen = req.messages.map((m) => m.content).join('\n');
      return { text: '', parsed: { pass: true, reason: 'ok' }, usage: { in: 1, out: 1 } };
    }) as never,
  });
  return [verifier, () => seen] as const;
}

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-verifier-diff-'));
  const run = (args: string[]): void => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} 失败: ${new TextDecoder().decode(r.stderr)}`);
  };
  run(['init', '-q']);
  run(['config', 'user.email', 't@t']);
  run(['config', 'user.name', 't']);
  run(['commit', '--allow-empty', '-q', '-m', 'base']);
  return dir;
}

describe('createDefaultVerifier × 盘上改动段 — INV-6', () => {
  test('★ 给了 artifactRoot 且仓干净 ⇒ 卷面含「盘上零改动」(自述说完成也没有产物支撑)', async () => {
    const [verifier, seenPrompt] = capturing();
    await verifier({ task: '实装一个功能', plan, results, artifactRoot: tmpRepo() });
    const paper = seenPrompt();
    expect(paper).toContain('===== 盘上改动 (引擎 git diff 取, 不是自述) =====');
    expect(paper).toContain('盘上零改动');
    expect(paper).toContain('没有产物支撑');
    // 判卷指引句只在这一节在场时出现。
    expect(paper).toContain('「盘上改动」一节是引擎取的事实');
  });

  test('有改动 ⇒ 卷面含 diff 片段与文件名', async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, 'feature.ts'), 'export const feature = 1;\n');
    const [verifier, seenPrompt] = capturing();
    await verifier({ task: '实装一个功能', plan, results, artifactRoot: dir });
    const paper = seenPrompt();
    expect(paper).toContain('===== 盘上改动 (引擎 git diff 取, 不是自述) =====');
    expect(paper).toContain('feature.ts');
    expect(paper).not.toContain('盘上零改动');
  });

  test('对照臂: 没给 artifactRoot ⇒ 卷面里既没有这一节也没有那句指引 (老调用方零回归)', async () => {
    const [verifier, seenPrompt] = capturing();
    await verifier({ task: '实装一个功能', plan, results });
    const paper = seenPrompt();
    expect(paper).not.toContain('盘上改动');
    expect(paper).not.toContain('盘上零改动');
  });

  test('取不到证据 ⇒ 卷面明说取不到, 不许念成零改动 (仓规坑 ①)', () => {
    const s = renderDiffSection({ text: '', files: [], empty: true, truncated: false, why: '不是 git 仓' });
    expect(s).toContain('盘上改动取不到');
    expect(s).toContain('不是 git 仓');
    expect(s).not.toContain('盘上零改动');
  });
});
