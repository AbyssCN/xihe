/**
 * goal/web-oracle —— **Web 任务的机械 oracle**(2026-09-11,契约 `docs/plan/2026-09-11-web-oracle-执行契约.md`)。
 *
 * ## 它补的洞
 * Web 子集首臂(09-07)0.361:执行型判据 17 条里 14 条是 `grep`,自证只能证「字符串在」,证不了「点了会动」。
 * 这里给一种**声明式**判据:entry + 一串 goto/click/fill/press/expect 步,由引擎自己的 runner 用 playwright-core
 * 跑真浏览器断言 DOM。不是自由 JS(D-1):自由脚本能 `process.exit(0)`,判据自己就能作弊。
 *
 * ## 分层
 *  - `parseWebOracleSpec`:形状闸(INV-1:至少一条 expect;wait ≤ 10 s;entry 不许 `..`)。
 *  - `runWebOracle(spec, page)`:纯执行器,吃一个最小 `PageLike`(测试注入假页面;生产由 scripts/web-oracle.ts 用 playwright 造)。
 *  - 静态服务 / 浏览器启动只在 CLI 脚本里,本模块零 I/O。
 *
 * ## 反向自检(web-oracle.test.ts)
 *  把 `expect` 分支改成恒 ok → 「空壳页面 expect 必红」用例红;去掉 parse 的 expect 检查 → 「无断言拒」红。
 */
import { z } from 'zod';

const MAX_WAIT_MS = 10_000;
const DEFAULT_STEP_TIMEOUT_MS = 5_000;

const ExpectSchema = z.object({
  selector: z.string().min(1),
  visible: z.boolean().optional(),
  text: z.string().optional(),
  textContains: z.string().optional(),
  count: z.number().int().min(0).optional(),
});

const StepSchema = z.union([
  z.object({ goto: z.string().min(1) }).strict(),
  z.object({ click: z.string().min(1) }).strict(),
  z.object({ fill: z.object({ selector: z.string().min(1), value: z.string() }) }).strict(),
  z.object({ press: z.string().min(1) }).strict(),
  z.object({ wait: z.number().int().min(0).max(MAX_WAIT_MS) }).strict(),
  z.object({ expect: ExpectSchema }).strict(),
  z.object({ expectUrl: z.string().min(1) }).strict(),
  z.object({ expectNoConsoleErrors: z.literal(true) }).strict(),
]);

const SpecSchema = z.object({
  entry: z.string().min(1),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
  steps: z.array(StepSchema).min(1),
});

export type WebOracleStep = z.infer<typeof StepSchema>;
export type WebOracleSpec = z.infer<typeof SpecSchema>;

export function isExpectStep(s: WebOracleStep): boolean {
  return 'expect' in s || 'expectUrl' in s || 'expectNoConsoleErrors' in s;
}

/** 形状闸。拒因是人话 + 落点,分类器输出被拒时原样进 learningGoal(INV-6)。 */
export function parseWebOracleSpec(raw: unknown): { ok: true; spec: WebOracleSpec } | { ok: false; reason: string } {
  const r = SpecSchema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    return { ok: false, reason: `webOracle 形状不合法: ${first ? `${first.path.join('.') || '(root)'} ${first.message}` : r.error.message}` };
  }
  const spec = r.data;
  if (!/^https?:\/\//.test(spec.entry) && (spec.entry.split(/[\\/]/).includes('..') || spec.entry.startsWith('/'))) {
    return { ok: false, reason: `webOracle.entry 必须是仓内相对路径或 http(s) 地址, 收到 '${spec.entry}'` };
  }
  if (!spec.steps.some(isExpectStep)) {
    return { ok: false, reason: 'webOracle.steps 没有任何 expect / expectUrl / expectNoConsoleErrors —— 一条不断言的判据不是判据' };
  }
  const e = spec.steps.find((s) => 'expect' in s && s.expect.visible === undefined && s.expect.text === undefined && s.expect.textContains === undefined && s.expect.count === undefined);
  if (e) return { ok: false, reason: `webOracle expect 步只有 selector 没有断言 (visible/text/textContains/count 至少一个): ${JSON.stringify(e)}` };
  return { ok: true, spec };
}

/** 最小页面面 —— 生产是 playwright Page 的薄封装,测试注入假页面。全部方法可抛(抛 = 该步失败)。 */
export interface PageLike {
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  press(key: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  count(selector: string): Promise<number>;
  isVisible(selector: string): Promise<boolean>;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  /** 自 goto 起累计的 console error / pageerror 文本。 */
  consoleErrors(): string[];
}

export interface WebOracleStepResult {
  step: string;
  ok: boolean;
  why?: string;
  ms: number;
}
export interface WebOracleResult {
  pass: boolean;
  steps: WebOracleStepResult[];
}

function describe(s: WebOracleStep): string {
  return JSON.stringify(s);
}

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

/**
 * 逐步执行;第一条失败即停(INV-2),失败步的 why 带实际值。
 * `opts.baseUrl` = 静态服务根(或 entry 的 http 根);`goto` 的相对路径拼在它后面。
 */
export async function runWebOracle(spec: WebOracleSpec, page: PageLike, opts: { baseUrl: string; entryPath?: string }): Promise<WebOracleResult> {
  const steps: WebOracleStepResult[] = [];
  const entryUrl = /^https?:\/\//.test(spec.entry) ? spec.entry : joinUrl(opts.baseUrl, opts.entryPath ?? spec.entry);
  const record = (s: string, ok: boolean, t0: number, why?: string): boolean => {
    steps.push({ step: s, ok, ms: Date.now() - t0, ...(why ? { why } : {}) });
    return ok;
  };
  // 隐式首步:打开 entry。
  {
    const t0 = Date.now();
    try {
      await page.goto(entryUrl);
      record(`open ${entryUrl}`, true, t0);
    } catch (err) {
      record(`open ${entryUrl}`, false, t0, `打不开 entry: ${err instanceof Error ? err.message : String(err)}`);
      return { pass: false, steps };
    }
  }
  for (const s of spec.steps) {
    const t0 = Date.now();
    const label = describe(s);
    try {
      if ('goto' in s) {
        await page.goto(joinUrl(opts.baseUrl, s.goto));
      } else if ('click' in s) {
        await page.click(s.click);
      } else if ('fill' in s) {
        await page.fill(s.fill.selector, s.fill.value);
      } else if ('press' in s) {
        await page.press(s.press);
      } else if ('wait' in s) {
        await page.waitForTimeout(s.wait);
      } else if ('expectUrl' in s) {
        const u = page.url();
        if (!u.includes(s.expectUrl)) {
          if (!record(label, false, t0, `url 不含 '${s.expectUrl}', 实际 '${u}'`)) return { pass: false, steps };
          continue;
        }
      } else if ('expectNoConsoleErrors' in s) {
        const errs = page.consoleErrors();
        if (errs.length) {
          record(label, false, t0, `console 有 ${errs.length} 条错误, 首条: ${errs[0]!.slice(0, 200)}`);
          return { pass: false, steps };
        }
      } else if ('expect' in s) {
        const e = s.expect;
        if (e.count !== undefined) {
          const n = await page.count(e.selector);
          if (n !== e.count) {
            record(label, false, t0, `'${e.selector}' 数量 ${n} ≠ ${e.count}`);
            return { pass: false, steps };
          }
        }
        if (e.visible !== undefined) {
          const v = await page.isVisible(e.selector);
          if (v !== e.visible) {
            record(label, false, t0, `'${e.selector}' visible=${v}, 期望 ${e.visible}`);
            return { pass: false, steps };
          }
        }
        if (e.text !== undefined || e.textContains !== undefined) {
          const actual = (await page.textContent(e.selector)) ?? null;
          if (actual === null) {
            record(label, false, t0, `'${e.selector}' 不存在 (textContent null)`);
            return { pass: false, steps };
          }
          const norm = actual.replace(/\s+/g, ' ').trim();
          if (e.text !== undefined && norm !== e.text.replace(/\s+/g, ' ').trim()) {
            record(label, false, t0, `'${e.selector}' 文本 '${norm.slice(0, 120)}' ≠ '${e.text}'`);
            return { pass: false, steps };
          }
          if (e.textContains !== undefined && !norm.includes(e.textContains)) {
            record(label, false, t0, `'${e.selector}' 文本 '${norm.slice(0, 120)}' 不含 '${e.textContains}'`);
            return { pass: false, steps };
          }
        }
      }
      record(label, true, t0);
    } catch (err) {
      record(label, false, t0, err instanceof Error ? err.message.split('\n')[0]!.slice(0, 300) : String(err));
      return { pass: false, steps };
    }
  }
  return { pass: true, steps };
}

/** 人读渲染(runner stdout;verifier 读它当证据)。 */
export function renderWebOracleResult(r: WebOracleResult): string {
  const lines = r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.step} (${s.ms} ms)${s.why ? ` — ${s.why}` : ''}`);
  return `${r.pass ? 'WEB-ORACLE PASS' : 'WEB-ORACLE FAIL'} (${r.steps.filter((s) => s.ok).length}/${r.steps.length} steps)\n${lines.join('\n')}`;
}

export { DEFAULT_STEP_TIMEOUT_MS, MAX_WAIT_MS };
