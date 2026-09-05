/**
 * **仓怎么渲染自己** + EVD-6(2026-09-05)。
 *
 * 治的病见 `render-command.ts` 模块头:`evidence-pass` 的 ui-pixels 链只在交付物是静态 HTML 时
 * 补得出渲染步,而真实前端仓交付的是 `.tsx`/`.vue`/`.svelte` 组件 —— 一律走 EVD-5 降级,
 * 于是**品味审查在看 diff 不是在看像素**,而这一格是静默的。
 *
 * 实账(plana):`design-review-triggered` 节点自己挂上来了,然后 `attach_media 无可用媒体`
 * fail-closed。链是通的,缺的只有一步渲染 —— 而那个仓本来就有 `npm run test:design` 在产截图。
 *
 * ⚠ 两档的分界是本文件最该钉住的判据:**只有带 `outDir` 的显式声明才接链**。
 * 探测到的候选不带落点,猜错会让 `omd-shots-verify` 假红 —— 一条必然失败的命令比没有命令更坏。
 */
import { describe, expect, test } from 'bun:test';
import type { AgentTemplate } from '../agent-templates';
import type { ConductorPlan } from '../conductor-plan';
import { evidencePass } from './evidence-pass';
import { describeRenderProbe, detectRenderCommand, type RenderProbe } from './render-command';

/** 合成一个仓:给定哪些文件存在、各自内容。 */
const repo = (files: Record<string, string>) => ({
  exists: (p: string) => Object.keys(files).some((f) => p.endsWith(f)),
  readText: (p: string) => {
    const hit = Object.keys(files).find((f) => p.endsWith(f));
    if (!hit) throw new Error(`ENOENT ${p}`);
    return files[hit]!;
  },
});

describe('detectRenderCommand —— 显式声明 vs 只探到', () => {
  // 证伪方式: 把 detectRenderCommand 的 ① 分支删掉 → 本条红。
  test('★ .omd/config.json 的 render 声明(带 outDir)→ 可接链', () => {
    const p = detectRenderCommand(
      '/r',
      repo({ '.omd/config.json': JSON.stringify({ render: { command: 'npm run shots', outDir: '.shots' } }) }),
    );
    expect(p.command).toEqual({
      command: 'npm run shots',
      outDir: '.shots',
      provenance: '.omd/config.json 的 render 声明',
    });
    expect(p.suggestion).toBeNull();
  });

  test('声明缺 outDir → **不当成可接链**(猜落点会让 shots-verify 假红)', () => {
    const p = detectRenderCommand('/r', repo({ '.omd/config.json': JSON.stringify({ render: { command: 'x' } }) }));
    expect(p.command).toBeNull();
  });

  // 证伪方式: 把 SCRIPT_CANDIDATES 里的 /^test:design$/ 删掉 → 本条红。
  test('★ package.json 有 test:design → 只给建议, 不接链', () => {
    const p = detectRenderCommand('/r', repo({ 'package.json': JSON.stringify({ scripts: { 'test:design': 'node x' } }) }));
    expect(p.command).toBeNull();
    expect(p.suggestion?.candidate).toBe('npm run test:design');
    expect(p.suggestion?.howToDeclare).toContain('outDir');
  });

  test('playwright.config.ts → 只给建议(结构 marker 是最弱的一档)', () => {
    const p = detectRenderCommand('/r', repo({ 'playwright.config.ts': '' }));
    expect(p.command).toBeNull();
    expect(p.suggestion?.candidate).toBe('npx playwright test');
  });

  test('什么都没有 → 两个都是 null, 判词仍告诉你怎么声明', () => {
    const p = detectRenderCommand('/r', repo({}));
    expect(p.command).toBeNull();
    expect(p.suggestion).toBeNull();
    expect(describeRenderProbe(p)).toContain('render');
  });

  test('坏 JSON 不炸(fail-open, 一个坏文件不该崩掉整次规划)', () => {
    expect(() => detectRenderCommand('/r', repo({ '.omd/config.json': '{ not json' }))).not.toThrow();
  });
});

const templates = new Map<string, AgentTemplate>([
  ['frontend-impl', { name: 'frontend-impl', description: 'UI 实装', evidence: 'ui-pixels', body: '…' } as AgentTemplate],
]);
const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 't', nodes }) as ConductorPlan;
/** 组件化交付物 —— 取不到 .html 目标, 正是 EVD-5 此前 100% 命中的形态。 */
const tsxPlan = () =>
  plan({ ui: { goal: '迁移周网格', template: 'frontend-impl', output_path: 'src/Grid.tsx', executor: 'agent' } });

describe('EVD-6 —— 组件化的仓也接得出像素证据链', () => {
  const declared: RenderProbe = {
    command: { command: 'npm run test:design', outDir: '.shots', provenance: '.omd/config.json 的 render 声明' },
    suggestion: null,
  };

  // 证伪方式: 把 patchChain 里 `if (render?.command)` 那一支删掉 → 本条红(退回 EVD-5 降级)。
  test('★ 有显式声明 → 补 [仓的渲染命令 → omd-shots-verify], 不再降级', () => {
    const r = evidencePass(tsxPlan(), { templates, render: declared });
    expect(r.degraded).toEqual([]);
    expect(r.patched).toEqual(['ui-render', 'ui-shots-verify']);
    expect(r.plan.nodes['ui-render']!.command).toBe('npm run test:design');
    const verify = r.plan.nodes['ui-shots-verify']!;
    expect(verify.command).toContain('omd-shots-verify');
    expect(verify.command).toContain('.shots'); // 落点用仓声明的, 不是猜的
    expect(verify.depends_on).toEqual(['ui-render']);
  });

  test('只有建议(没 outDir)→ 仍降级, 但判词带上「照着做就能修」的那句', () => {
    const onlySuggestion: RenderProbe = {
      command: null,
      suggestion: { candidate: 'npm run test:design', provenance: 'package.json 的 scripts.test:design', howToDeclare: '在 `.omd/config.json` 里加 render' },
    };
    const r = evidencePass(tsxPlan(), { templates, render: onlySuggestion });
    expect(r.patched).toEqual([]);
    expect(r.degraded[0]!.reason).toContain('npm run test:design');
    expect(r.degraded[0]!.reason).toContain('.omd/config.json');
  });

  test('不传 render → 与改前逐字一致(零回归)', () => {
    const r = evidencePass(tsxPlan(), { templates });
    expect(r.patched).toEqual([]);
    expect(r.degraded[0]!.reason).toContain('无可渲染目标');
  });

  test('HTML 交付物仍走原路(EVD-6 不越界)', () => {
    const p = plan({ ui: { goal: '落地页', template: 'frontend-impl', output_path: 'dist/index.html', executor: 'agent' } });
    const r = evidencePass(p, { templates, render: declared });
    expect(r.plan.nodes['ui-render']!.command).toContain('omd-render'); // 不是仓的命令
  });

  test('幂等: 补挂后再过一次本 pass = 恒等(EVD-2 对 EVD-6 同样成立)', () => {
    const once = evidencePass(tsxPlan(), { templates, render: declared });
    const twice = evidencePass(once.plan, { templates, render: declared });
    expect(twice.patched).toEqual([]);
    expect(Object.keys(twice.plan.nodes).sort()).toEqual(Object.keys(once.plan.nodes).sort());
  });
});
