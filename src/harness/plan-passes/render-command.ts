/**
 * plan-passes/render-command —— **这个仓怎么把自己渲染成像素**(2026-09-05)。
 *
 * ## 它治的病:ui-pixels 闸对组件化的仓形同虚设
 *
 * `evidence-pass` 的 ui-pixels 证据链只在交付物是**静态 HTML**(`RENDERABLE_EXT`)时补得出渲染步。
 * 而真实前端仓的交付物是 `.tsx` / `.vue` / `.svelte` 组件 —— 取不到 `.html` 目标,于是 EVD-5
 * **降级成 diff-only 审**。后果:**品味审查在看 diff,不是在看像素**,而这一格是静默的。
 *
 * 实账(2026-09-04,plana):`design-review-triggered` 节点自己挂上来了,然后
 * `attach_media 无可用媒体 → failed (D-14v2 fail-closed)` —— 整条链是通的、fail-closed 也对,
 * **缺的只有一步渲染**。而那个仓本来就有 `npm run test:design` 在产截图。
 *
 * 这与 `hooks/toolchain` 治的是同一种病:**引擎知道自己需要什么, 却没有任何东西去探测这个仓怎么提供**。
 *
 * ## 两档,刻意不合并
 *
 * · **显式声明**(`.omd/config.json` 的 `render`,或 `package.json` 的 `omd:render` 脚本)
 *   → 带着 `outDir`,可以**直接接进证据链**。
 * · **只探测出来的**(`test:design` / `playwright.config.*` / `.storybook/` …)
 *   → **不自动接**。因为我们不知道那个脚本把截图放哪,猜错 `outDir` 会让 `omd-shots-verify`
 *   假红 —— 一条必然失败的命令比没有命令更坏(它把"没证据"伪装成"证据是红的")。
 *   这一档只产**一句能照着做的建议**,进 EVD-5 的降级理由与日志。
 *
 * 「宁可少拦一次也不造假 fatal」是本仓既有纪律(jail-preflight ④ 同款);这里是它的对偶:
 * **宁可少接一次链, 也不造假红**。
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 可直接接进证据链的渲染声明。 */
export interface RenderCommand {
  /** 在仓根跑的命令。 */
  command: string;
  /** 截图落点(相对仓根)—— `omd-shots-verify` 来这里找。 */
  outDir: string;
  /** 来源,进日志与判词(让人知道这条是哪儿来的)。 */
  provenance: string;
}

/** 探到了像是渲染的东西, 但缺 `outDir` —— 只能给建议, 不能接链。 */
export interface RenderSuggestion {
  /** 探到的命令(可能能用, 也可能不产截图 —— 没验过)。 */
  candidate: string;
  provenance: string;
  /** 照着做就能接上链的一句话。 */
  howToDeclare: string;
}

export interface RenderProbe {
  /** 可用即接链; null = 没有显式声明。 */
  command: RenderCommand | null;
  /** 没有显式声明时的建议(也可能为 null —— 什么都没探到)。 */
  suggestion: RenderSuggestion | null;
}

export interface RenderProbeDeps {
  exists?: (p: string) => boolean;
  readText?: (p: string) => string;
}

/** package.json 的 scripts 里, 名字像"产截图"的那些(按证据强弱, 先命中先用)。 */
const SCRIPT_CANDIDATES: readonly RegExp[] = [
  /^omd:render$/, // 约定名 —— 最强, 但仍需 outDir 才算声明
  /^test:design$/,
  /^(screenshots?|snapshots?)$/,
  /^storybook:(shots|screenshots)$/,
  /^(chromatic|percy)$/,
  /screenshot/i,
];

/** 存在即说明这个仓有截图能力的文件/目录(弱证据, 只够给建议)。 */
const MARKER_CANDIDATES: readonly { path: string; candidate: string; why: string }[] = [
  { path: 'playwright.config.ts', candidate: 'npx playwright test', why: 'playwright.config.ts' },
  { path: 'playwright.config.js', candidate: 'npx playwright test', why: 'playwright.config.js' },
  { path: '.storybook', candidate: 'npx storybook build', why: '.storybook/' },
];

const HOW_TO_DECLARE =
  '在 `.omd/config.json` 里加 `"render": { "command": "<跑起来会产截图的命令>", "outDir": "<截图落点, 相对仓根>" }`' +
  ' —— 有了 outDir 才接得进 ui-pixels 证据链 (没有它 omd-shots-verify 不知道去哪儿找图, 猜错就是假红)。';

/**
 * 探这个仓怎么渲染自己。**零副作用**, 只读文件。
 *
 * 顺序即证据强弱: 显式 `.omd/config.json` → `package.json` 的 `omd:render` → 其它像截图的脚本
 * → 结构 marker。前两档带 `outDir` 时才产 `command`; 其余一律只产 `suggestion`。
 */
export function detectRenderCommand(root: string, deps: RenderProbeDeps = {}): RenderProbe {
  const exists = deps.exists ?? existsSync;
  const readText = deps.readText ?? ((p: string) => readFileSync(p, 'utf8'));
  const readJson = (p: string): Record<string, unknown> | null => {
    if (!exists(p)) return null;
    try {
      const v: unknown = JSON.parse(readText(p));
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
    } catch {
      return null; // 坏 JSON: 探测器不该因为一个坏文件就崩掉整次规划 (fail-open, 同 TPL-1)
    }
  };

  // ① 显式声明 —— 唯一能直接接链的一档。
  const cfg = readJson(join(root, '.omd', 'config.json'));
  const decl = cfg?.render;
  if (typeof decl === 'object' && decl !== null) {
    const d = decl as { command?: unknown; outDir?: unknown };
    if (typeof d.command === 'string' && d.command.trim() && typeof d.outDir === 'string' && d.outDir.trim()) {
      return {
        command: { command: d.command.trim(), outDir: d.outDir.trim(), provenance: '.omd/config.json 的 render 声明' },
        suggestion: null,
      };
    }
  }

  const pkg = readJson(join(root, 'package.json'));
  const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  const scriptNames = Object.keys(scripts).filter((k) => typeof scripts[k] === 'string');

  // ② package.json 里像截图的脚本 —— 只够当建议(不知道它把图放哪)。
  for (const re of SCRIPT_CANDIDATES) {
    const hit = scriptNames.find((n) => re.test(n));
    if (!hit) continue;
    return {
      command: null,
      suggestion: {
        candidate: `npm run ${hit}`,
        provenance: `package.json 的 scripts.${hit}`,
        howToDeclare: HOW_TO_DECLARE,
      },
    };
  }

  // ③ 结构 marker —— 最弱, 同样只给建议。
  for (const m of MARKER_CANDIDATES) {
    if (!exists(join(root, m.path))) continue;
    return {
      command: null,
      suggestion: { candidate: m.candidate, provenance: m.why, howToDeclare: HOW_TO_DECLARE },
    };
  }

  return { command: null, suggestion: null };
}

/** 把探测结果压成一句进 EVD-5 降级理由 / 日志的话。无建议时返空串。 */
export function describeRenderProbe(p: RenderProbe): string {
  if (p.command) return `渲染命令来自 ${p.command.provenance}: \`${p.command.command}\` → ${p.command.outDir}`;
  if (p.suggestion) {
    return `探到疑似渲染命令 \`${p.suggestion.candidate}\` (来源 ${p.suggestion.provenance}), 但**没有声明 outDir 所以没接链**。${p.suggestion.howToDeclare}`;
  }
  return `本仓没探到任何渲染命令。${HOW_TO_DECLARE}`;
}
