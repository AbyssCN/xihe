/**
 * web oracle 接线 (契约切片 2/3): EnvFacts.web 探测 · 命令闸豁免 · 分类器 web_oracle 臂 · prompt 字节稳定 (INV-5)。
 * 反向自检 (2026-09-11 写时实跑):
 *   · acceptance-gate 去掉 isWebOracleCommand 分支 → 「web oracle 命令过闸」红 (纯 html 仓 `bun` 撞 lang-mismatch);
 *   · normalize 去掉 web_oracle 臂 → 「分类器给 web_oracle → 命令由引擎生成」红;
 *   · classifyPrompt 的 web 教学条件改成恒 true → INV-5 字节稳定用例红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeEnvFacts, probeWebFacts, renderEnvFacts, type EnvFacts } from '../env-facts';
import { acceptanceCommandBlockReason } from './acceptance-gate';
import { classifyGoal, classifyPrompt, normalizeClassification } from './classify-acceptance';
import { WEB_ORACLE_SPEC_REL, isWebOracleCommand, webOracleCommand, webOracleSpecPathOf, writeWebOracleSpec } from './web-oracle';
import type { GenerateFn } from '../dag/types';

let tmp = '';
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});
function fresh(): string {
  tmp = mkdtempSync(join(tmpdir(), 'web-oracle-wiring-'));
  return tmp;
}
const SPEC = { entry: 'index.html', steps: [{ click: '#b' }, { expect: { selector: '#t', text: 'Clicked' } }] };

describe('EnvFacts.web (D-4)', () => {
  test('有 index.html → entry; 浏览器目录空 → playwright=false, browsersDir 报出来', () => {
    const root = fresh();
    writeFileSync(join(root, 'index.html'), '<html></html>');
    const noBrowsers = join(root, 'no-browsers');
    mkdirSync(noBrowsers);
    const w = probeWebFacts(root, { PLAYWRIGHT_BROWSERS_PATH: noBrowsers });
    expect(w.entry).toBe('index.html');
    expect(w.playwright).toBe(false);
    expect(w.browsersDir).toBe(noBrowsers);
  });
  test('public/index.html 也认; 没有任何入口 → null', () => {
    const root = fresh();
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'public', 'index.html'), '<html></html>');
    expect(probeWebFacts(root).entry).toBe('public/index.html');
    expect(probeWebFacts(join(root, 'public')).entry).toBe('index.html');
    rmSync(join(root, 'public'), { recursive: true });
    expect(probeWebFacts(root).entry).toBeNull();
  });
  test('假 chromium 目录 → playwright=true (引擎自带 playwright-core); probeEnvFacts 带 web 并渲染一行', () => {
    const root = fresh();
    writeFileSync(join(root, 'index.html'), '<html></html>');
    const browsers = join(root, 'browsers');
    mkdirSync(join(browsers, 'chromium-1234'), { recursive: true });
    const f = probeEnvFacts(root, { PATH: '', PLAYWRIGHT_BROWSERS_PATH: browsers });
    expect(f.web?.playwright).toBe(true);
    expect(renderEnvFacts(f)).toContain('web: 入口 `index.html`');
  });
});

describe('命令面 (D-2)', () => {
  test('webOracleCommand 首词 bun, 含引擎脚本路径与 spec 相对路径; 识别与取路径成对', () => {
    const c = webOracleCommand();
    expect(c.startsWith('bun run ')).toBe(true);
    expect(c).toContain('/scripts/web-oracle.ts ');
    expect(isWebOracleCommand(c)).toBe(true);
    expect(webOracleSpecPathOf(c)).toBe(WEB_ORACLE_SPEC_REL);
    expect(isWebOracleCommand('bun test')).toBe(false);
  });
  test('纯 html 仓 (零 js 语言证据): web oracle 命令过闸, 普通 `bun test` 被 lang-mismatch 拒', () => {
    const root = fresh();
    writeFileSync(join(root, 'index.html'), '<html></html>');
    const envFacts: EnvFacts = probeEnvFacts(root, { PATH: '' });
    writeWebOracleSpec(root, SPEC);
    expect(acceptanceCommandBlockReason(webOracleCommand(), { root, envFacts })).toBeNull();
    expect(acceptanceCommandBlockReason('bun test', { root, envFacts })).toMatch(/lang-mismatch|allowlist/);
  });
  test('spec 未物化 → 拒, 拒因带路径', () => {
    const root = fresh();
    const r = acceptanceCommandBlockReason(webOracleCommand(), { root });
    expect(r).toContain('spec 未物化');
    expect(r).toContain(WEB_ORACLE_SPEC_REL);
  });
});

describe('分类器 web_oracle 臂 (D-1 / D-3 / INV-6)', () => {
  test('分类器给 web_oracle → 物化 + 命令由引擎生成 + webOracle.path 回带', () => {
    const root = fresh();
    writeFileSync(join(root, 'index.html'), '<html></html>');
    const written: unknown[] = [];
    const r = normalizeClassification(
      { tier: 'simple', acceptance_kind: 'executable', web_oracle: SPEC, negative_sample_path: 'index.html', negative_sample_content: '<html><body></body></html>' },
      { root, materializeWebOracle: (spec) => { written.push(spec); return writeWebOracleSpec(root, spec); } },
    );
    expect(r.acceptance.kind).toBe('executable');
    expect(r.acceptance.kind === 'executable' && isWebOracleCommand(r.acceptance.command)).toBe(true);
    expect(r.webOracle?.path).toBe(WEB_ORACLE_SPEC_REL);
    expect(r.negativeSample?.path).toBe('index.html');
    expect(written.length).toBe(1);
    expect(JSON.parse(readFileSync(join(root, WEB_ORACLE_SPEC_REL), 'utf8')).entry).toBe('index.html');
  });
  test('spec 形状不合法 (无断言) → 降级探索型, 拒因原样进 learningGoal', () => {
    const root = fresh();
    const r = normalizeClassification(
      { tier: 'simple', acceptance_kind: 'executable', web_oracle: { entry: 'index.html', steps: [{ click: '#b' }] } },
      { root, materializeWebOracle: () => WEB_ORACLE_SPEC_REL },
    );
    expect(r.acceptance.kind).toBe('exploratory');
    expect(r.acceptance.kind === 'exploratory' && r.acceptance.learningGoal).toContain('不断言');
    expect(r.acceptanceProbe?.kind).toBe('demoted');
  });
  test('无物化器 → 降级探索型 (不留判不了的执行型)', () => {
    const r = normalizeClassification({ tier: 'simple', acceptance_kind: 'executable', web_oracle: SPEC }, {});
    expect(r.acceptance.kind).toBe('exploratory');
    expect(r.acceptance.kind === 'exploratory' && r.acceptance.learningGoal).toContain('无物化器');
  });
  test('classifyGoal 端到端: 假 generate 回 web_oracle → 执行型命令 + spec 落盘', async () => {
    const root = fresh();
    writeFileSync(join(root, 'index.html'), '<html></html>');
    const gen: GenerateFn = async () => ({
      text: JSON.stringify({ tier: 'simple', acceptance_kind: 'executable', web_oracle: SPEC }),
      usage: { in: 1, out: 1 },
    });
    const r = await classifyGoal('make the button change the title', {
      generate: gen,
      model: 'fake:model',
      repoRoot: root,
      materializeWebOracle: (spec) => writeWebOracleSpec(root, spec),
    });
    expect(r.acceptance.kind).toBe('executable');
    expect(existsSync(join(root, WEB_ORACLE_SPEC_REL))).toBe(true);
    expect(r.webOracle?.path).toBe(WEB_ORACLE_SPEC_REL);
  });
});

describe('classifyPrompt 教学 (D-4 / INV-5)', () => {
  const base = (): EnvFacts => ({ root: '/r', languages: [], enabledBins: [], testCommandCandidates: [], scanned: { files: 1, dirs: 1, truncated: false, unreadable: [] } });
  test('Web 仓 ∧ 浏览器可用 → 教 web_oracle; 任一不成立 → prompt 与无 web 字节相同', () => {
    const without = classifyPrompt('g', { repoRoot: '/r', envFacts: base() });
    const noBrowser = classifyPrompt('g', { repoRoot: '/r', envFacts: { ...base(), web: { entry: 'index.html', playwright: false, browsersDir: '/x' } } });
    const noEntry = classifyPrompt('g', { repoRoot: '/r', envFacts: { ...base(), web: { entry: null, playwright: true, browsersDir: '/x' } } });
    const both = classifyPrompt('g', { repoRoot: '/r', envFacts: { ...base(), web: { entry: 'index.html', playwright: true, browsersDir: '/x' } } });
    expect(without).not.toContain('web_oracle');
    // renderEnvFacts 那一行会随 web.entry 变 (它如实报事实); 教学段不许出现。
    expect(noBrowser).not.toContain('"web_oracle"');
    expect(noEntry).not.toContain('"web_oracle"');
    expect(both).toContain('"web_oracle"');
    expect(both).toContain('"expectNoConsoleErrors":true');
    expect(both).toContain('不要 grep');
  });
});
