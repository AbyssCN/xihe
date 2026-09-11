#!/usr/bin/env bun
/**
 * scripts/web-oracle —— Web 判据 runner(契约 `docs/plan/2026-09-11-web-oracle-执行契约.md` D-2/D-5)。
 *
 * 用法: bun run scripts/web-oracle.ts <spec.json> [--root <dir>]
 *   · spec 形状见 src/harness/goal/web-oracle.ts;`--root` 缺省 = spec 文件所在仓根(spec 在 `.omd/acceptance/` 下时取其上两级),
 *     再缺省 = cwd。
 *   · entry 是相对路径 → 起 Bun.serve 静态服务(端口 0)服务 root;entry 是 http(s) → 直接用。
 *   · 退出码: 0 全部断言过 · 1 有断言不过(逐步原因在 stdout)· 2 spec 缺/坏、entry 不在、浏览器起不来(原因在 stderr)。
 *
 * INV-3 空世界: entry 文件不存在 → exit 2,自证闸「空世界必须非 0」成立。
 * 浏览器: playwright-core(引擎依赖)+ ~/.cache/ms-playwright 的 chromium(PLAYWRIGHT_BROWSERS_PATH 可改)。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { parseWebOracleSpec, renderWebOracleResult, runWebOracle, type PageLike, DEFAULT_STEP_TIMEOUT_MS } from '../src/harness/goal/web-oracle';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain', '.map': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

function fail(code: 1 | 2, msg: string): never {
  (code === 2 ? process.stderr : process.stdout).write(`${msg}\n`);
  process.exit(code);
}

function serveStatic(root: string): { baseUrl: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const abs = resolve(root, `.${rel}`);
      if (!abs.startsWith(resolve(root))) return new Response('forbidden', { status: 403 });
      if (!existsSync(abs)) return new Response('not found', { status: 404 });
      const st = statSync(abs);
      const file = st.isDirectory() ? join(abs, 'index.html') : abs;
      if (!existsSync(file)) return new Response('not found', { status: 404 });
      return new Response(Bun.file(file), { headers: { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' } });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const specPath = argv.find((a) => !a.startsWith('--'));
  if (!specPath) fail(2, 'usage: web-oracle <spec.json> [--root <dir>]');
  const rootFlag = argv.indexOf('--root');
  const specAbs = resolve(specPath!);
  if (!existsSync(specAbs)) fail(2, `spec 不存在: ${specAbs}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(specAbs, 'utf8'));
  } catch (err) {
    fail(2, `spec 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parseWebOracleSpec(raw);
  if (!parsed.ok) fail(2, parsed.reason);
  const spec = parsed.spec;
  const root = rootFlag >= 0 && argv[rootFlag + 1]
    ? resolve(argv[rootFlag + 1]!)
    : specAbs.includes(`${'/.omd/acceptance/'}`) ? resolve(dirname(specAbs), '..', '..') : process.cwd();
  const isHttp = /^https?:\/\//.test(spec.entry);
  if (!isHttp && !existsSync(resolve(root, spec.entry))) fail(2, `entry 不存在: ${resolve(root, spec.entry)} (root=${root})`);

  let pw: typeof import('playwright-core');
  try {
    pw = await import('playwright-core');
  } catch (err) {
    fail(2, `playwright-core 不可用: ${err instanceof Error ? err.message : String(err)}`);
  }
  const served = isHttp ? null : serveStatic(root);
  let browser: import('playwright-core').Browser | null = null;
  try {
    browser = await pw!.chromium.launch({ headless: true });
  } catch (err) {
    served?.stop();
    fail(2, `chromium 起不来 (装: bunx playwright-core install chromium): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  try {
    const ctx = await browser!.newContext(spec.viewport ? { viewport: spec.viewport } : {});
    const page = await ctx.newPage();
    const timeout = spec.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    page.setDefaultTimeout(timeout);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    const like: PageLike = {
      goto: async (u) => { errors.length = 0; await page.goto(u, { waitUntil: 'load' }); },
      click: (s) => page.click(s),
      fill: (s, v) => page.fill(s, v),
      press: (k) => page.keyboard.press(k),
      textContent: (s) => page.textContent(s),
      count: (s) => page.locator(s).count(),
      isVisible: (s) => page.locator(s).first().isVisible(),
      url: () => page.url(),
      waitForTimeout: (ms) => page.waitForTimeout(ms),
      consoleErrors: () => [...errors],
    };
    const r = await runWebOracle(spec, like, { baseUrl: served?.baseUrl ?? '', entryPath: spec.entry });
    process.stdout.write(`${renderWebOracleResult(r)}\n`);
    return r.pass ? 0 : 1;
  } finally {
    await browser?.close().catch(() => {});
    served?.stop();
  }
}

process.exit(await main());
