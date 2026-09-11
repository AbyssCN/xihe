/**
 * web-oracle —— 声明式 Web 判据的形状闸 + 执行器 + 真浏览器集成。
 * 反向自检 (2026-09-11 写时实跑):
 *   · runWebOracle 的 expect 分支改成恒 ok → 「空壳页面 expect 必红」红;
 *   · parseWebOracleSpec 去掉 expect 检查 → 「无断言拒」红;
 *   · scripts/web-oracle.ts 去掉 entry 存在检查 → 「空世界 exit 2」红。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseWebOracleSpec, renderWebOracleResult, runWebOracle, type PageLike, type WebOracleSpec } from './web-oracle';

const GOOD: WebOracleSpec = {
  entry: 'index.html',
  steps: [{ click: '#b' }, { expect: { selector: '#t', text: 'Clicked' } }, { expectNoConsoleErrors: true }],
};

describe('parseWebOracleSpec (INV-1)', () => {
  test('合法 spec 过', () => {
    expect(parseWebOracleSpec(GOOD).ok).toBe(true);
  });
  test('无断言拒', () => {
    const r = parseWebOracleSpec({ entry: 'index.html', steps: [{ click: '#b' }] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('不断言');
  });
  test('expect 只有 selector 拒', () => {
    const r = parseWebOracleSpec({ entry: 'index.html', steps: [{ expect: { selector: '#t' } }] });
    expect(r.ok).toBe(false);
  });
  test('entry 带 .. 或绝对路径拒; http 地址过', () => {
    expect(parseWebOracleSpec({ entry: '../x.html', steps: GOOD.steps }).ok).toBe(false);
    expect(parseWebOracleSpec({ entry: '/etc/passwd', steps: GOOD.steps }).ok).toBe(false);
    expect(parseWebOracleSpec({ entry: 'http://127.0.0.1:5173/', steps: GOOD.steps }).ok).toBe(true);
  });
  test('wait > 10 s 拒; 未知动词拒', () => {
    expect(parseWebOracleSpec({ entry: 'i.html', steps: [{ wait: 20_000 }, ...GOOD.steps] }).ok).toBe(false);
    expect(parseWebOracleSpec({ entry: 'i.html', steps: [{ evaluate: 'process.exit(0)' }, ...GOOD.steps] }).ok).toBe(false);
  });
});

/** 假页面: 一个内存 DOM 表, 足够测执行器的判定逻辑。 */
function fakePage(dom: Record<string, { text?: string; visible?: boolean; count?: number }>, opts: { errors?: string[]; failClick?: boolean } = {}): PageLike & { log: string[] } {
  const log: string[] = [];
  let url = '';
  return {
    log,
    goto: async (u) => { url = u; log.push(`goto ${u}`); },
    click: async (s) => { log.push(`click ${s}`); if (opts.failClick) throw new Error(`Timeout 5000ms exceeded waiting for selector ${s}`); },
    fill: async (s, v) => { log.push(`fill ${s}=${v}`); },
    press: async (k) => { log.push(`press ${k}`); },
    textContent: async (s) => dom[s]?.text ?? null,
    count: async (s) => dom[s]?.count ?? (dom[s] ? 1 : 0),
    isVisible: async (s) => dom[s]?.visible ?? Boolean(dom[s]),
    url: () => url,
    waitForTimeout: async () => {},
    consoleErrors: () => opts.errors ?? [],
  };
}

describe('runWebOracle (INV-2)', () => {
  test('全过 → pass, 每步有耗时', async () => {
    const page = fakePage({ '#t': { text: 'Clicked' } });
    const r = await runWebOracle(GOOD, page, { baseUrl: 'http://x' });
    expect(r.pass).toBe(true);
    expect(r.steps.map((s) => s.ok)).toEqual([true, true, true, true]);
    expect(page.log[0]).toBe('goto http://x/index.html');
  });
  test('空壳页面 expect 必红, why 带实际值, 后续步不跑', async () => {
    const page = fakePage({});
    const r = await runWebOracle(GOOD, page, { baseUrl: 'http://x' });
    expect(r.pass).toBe(false);
    const bad = r.steps.find((s) => !s.ok)!;
    expect(bad.why).toContain('#t');
    expect(r.steps.length).toBe(3); // open + click + 失败的 expect; expectNoConsoleErrors 没跑
  });
  test('文本不等 → why 带实际文本', async () => {
    const r = await runWebOracle(GOOD, fakePage({ '#t': { text: 'Hello' } }), { baseUrl: 'http://x' });
    expect(r.pass).toBe(false);
    expect(r.steps.at(-1)!.why).toContain("'Hello'");
  });
  test('count / visible / expectUrl / console 错误各自判', async () => {
    const spec: WebOracleSpec = {
      entry: 'index.html',
      steps: [{ expect: { selector: 'li', count: 3 } }, { expect: { selector: '#modal', visible: false } }, { expectUrl: 'index.html' }, { expectNoConsoleErrors: true }],
    };
    const ok = await runWebOracle(spec, fakePage({ li: { count: 3 }, '#modal': { visible: false } }), { baseUrl: 'http://x' });
    expect(ok.pass).toBe(true);
    const badCount = await runWebOracle(spec, fakePage({ li: { count: 2 }, '#modal': { visible: false } }), { baseUrl: 'http://x' });
    expect(badCount.steps.at(-1)!.why).toContain('数量 2');
    const badConsole = await runWebOracle(spec, fakePage({ li: { count: 3 }, '#modal': { visible: false } }, { errors: ['TypeError: x is not a function'] }), { baseUrl: 'http://x' });
    expect(badConsole.pass).toBe(false);
    expect(badConsole.steps.at(-1)!.why).toContain('TypeError');
  });
  test('click 超时 → 该步失败并停', async () => {
    const r = await runWebOracle(GOOD, fakePage({ '#t': { text: 'Clicked' } }, { failClick: true }), { baseUrl: 'http://x' });
    expect(r.pass).toBe(false);
    expect(r.steps[1]!.why).toContain('Timeout');
  });
  test('渲染: 首行 PASS/FAIL + 计数', () => {
    expect(renderWebOracleResult({ pass: false, steps: [{ step: 'a', ok: true, ms: 1 }, { step: 'b', ok: false, ms: 2, why: 'x' }] })).toMatch(/^WEB-ORACLE FAIL \(1\/2 steps\)/);
  });
});

// ── 真浏览器集成 (INV-3 / INV-4): 无 chromium 时 skip 并出声, 不假绿 ─────────────────────────
const chromiumDir = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
const hasChromium = existsSync(chromiumDir) && existsSync(resolve(import.meta.dir, '../../../node_modules/playwright-core'));
const SCRIPT = resolve(import.meta.dir, '../../../scripts/web-oracle.ts');

function runScript(specPath: string, root: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(['bun', 'run', SCRIPT, specPath, '--root', root], { stdout: 'pipe', stderr: 'pipe', timeout: 90_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe.skipIf(!hasChromium)('scripts/web-oracle.ts 真浏览器', () => {
  const html = `<!doctype html><html><body><h1 id="t">Hello</h1><button id="b" onclick="document.getElementById('t').textContent='Clicked'">go</button><ul><li>1</li><li>2</li><li>3</li></ul></body></html>`;
  test('真页面: 点击后文本变 → exit 0; 空壳页面 → exit 1 (INV-4); entry 缺席 → exit 2 (INV-3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-oracle-'));
    try {
      mkdirSync(join(dir, '.omd', 'acceptance'), { recursive: true });
      const spec = { entry: 'index.html', steps: [{ click: '#b' }, { expect: { selector: '#t', text: 'Clicked' } }, { expect: { selector: 'li', count: 3 } }, { expectNoConsoleErrors: true }] };
      const specPath = join(dir, '.omd', 'acceptance', 'web-oracle.json');
      writeFileSync(specPath, JSON.stringify(spec));
      // INV-3 空世界: entry 不在
      const empty = runScript(specPath, dir);
      expect(empty.code).toBe(2);
      expect(empty.err).toContain('entry 不存在');
      // INV-4 反面样本: 空壳 html
      writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body></body></html>');
      const shell = runScript(specPath, dir);
      expect(shell.code).toBe(1);
      expect(shell.out).toContain('WEB-ORACLE FAIL');
      // 真页面
      writeFileSync(join(dir, 'index.html'), html);
      const good = runScript(specPath, dir);
      expect(good.err).toBe('');
      expect(good.code).toBe(0);
      expect(good.out).toContain('WEB-ORACLE PASS (5/5 steps)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

if (!hasChromium) console.warn('[web-oracle.test] 无 chromium / playwright-core → 真浏览器集成用例 skip (不是绿)');
