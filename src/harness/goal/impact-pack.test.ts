/**
 * src/harness/goal/impact-pack.test —— 影响包纯模块的不变量 (契约
 * `docs/plan/2026-09-06-影响包-执行契约.md` 切片 1 / INV-1 · INV-2 · INV-3 · INV-5 · INV-6)。
 *
 * 为什么有这个模块: R2 读数里 conductor 读仓的目标 57% 是**源码文件**, 而勘察包六段一段都不覆盖
 * 源码; M3 弱在实装新行为, 不弱在理解 —— 缺的是「要改的那几个符号的定义 / 调用者 / import」。
 *
 * 测试走真文件系统 (`mkdtemp` + 真 .py / .ts 文件) 与真 grep 进程, 不 mock fs ——
 * 抽取量的就是真盘与真 grep 的输出形状。
 *
 * **反向自检** (每条都要能真红):
 *  · `extractDefinitionBlock` 不按缩进收尾 ⇒ INV-1「含体内最后一行」红 (会把下一个 def 也吞进来);
 *  · ts 分支不做大括号配平 ⇒ INV-2「末行是配平的 }」红;
 *  · 超 cap 不截断 ⇒ INV-2「… (截断)」红;
 *  · 一个定义都没抽到还渲染头行 ⇒ INV-3「text === ''」红;
 *  · 调用者段没有自己的 try/catch ⇒ INV-5「定义段照常」红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMPACT_PACK_HEADER, buildImpactPack, extractDefinitionBlock } from './impact-pack';

/** 真仓 (不是 mock): 落真文件, grep 读的就是这些字节。 */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-impact-'));
  for (const [f, c] of Object.entries(files)) {
    const abs = join(dir, f);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, c);
  }
  return dir;
}

/** 真进程注入口 (与 criterion-survey / survey-pack 同签名), 除非某条用例要故意造故障。 */
function realRun(argv: string[], cwd: string): { exitCode: number | null; stdout: string } {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 3_000 });
  return { exitCode: r.exitCode, stdout: r.stdout.toString() };
}

const PY_APP = `import json

CONST = 1


def build_report(rows):
    """报表: 把行拼成 JSON。"""
    total = 0
    for r in rows:
        total += r
    header = ["name", "value"]
    body = []
    for r in rows:
        body.append(r)
    result = {"header": header, "body": body, "total": total}
    return json.dumps(result)


def other():
    return 2
`;

const PY_CLI = `from app import build_report


def main(rows):
    print(build_report(rows))
`;

/** INV-2 的 ts 定义: 大括号跨 20 行 (含嵌套块), 末行是配平的 }。 */
const TS_WARN = `import { z } from 'zod';

export function parseWarningFilter(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (t === '') {
      continue;
    }
    if (t.startsWith('-')) {
      out.push(t.slice(1));
    } else {
      out.push(t);
    }
  }
  if (out.length === 0) {
    return ['*'];
  }
  return out;
}

export const OTHER = 1;
`;

describe('INV-1 —— python: 定义整段 + 调用者 + import 进 text', () => {
  test('★ header + def 整段 (含体内最后一行) + 调用者行 + import; facts.defs===1, callers>=1', () => {
    const dir = repo({ 'src/app.py': PY_APP, 'src/cli.py': PY_CLI });
    const pack = buildImpactPack('修 `build_report` 的表头, 见 src/app.py', dir, { run: realRun });

    expect(pack.text.startsWith(IMPACT_PACK_HEADER)).toBe(true);
    // 证伪: 定义段不抽 ⇒ 本行红。
    expect(pack.text).toContain('def build_report(rows):');
    // 证伪: 缩进收尾写错 (提前停) ⇒ 本行红 —— 体内最后一行必须在。
    expect(pack.text).toContain('return json.dumps(result)');
    // 证伪: 缩进收尾写错 (吞过头) ⇒ 本行红 —— 下一个同级 def 不许进来。
    expect(pack.text).not.toContain('def other():');
    // 证伪: 调用者段不跑 ⇒ 本行红 (路径:行号 + 那一行原文)。
    expect(pack.text).toContain('src/cli.py:5');
    // 证伪: import 段不抽 ⇒ 本行红。
    expect(pack.text).toContain('import json');

    expect(pack.facts.defs).toBe(1);
    expect(pack.facts.callers).toBeGreaterThanOrEqual(1);
    expect(pack.facts.chars).toBe(pack.text.length);
    expect(pack.why).toBeUndefined(); // 全段成功 ⇒ why 缺席
  });

  test('★ 调用者段排掉定义自己那一行 (def build_report( 不算调用)', () => {
    const dir = repo({ 'src/app.py': PY_APP, 'src/cli.py': PY_CLI });
    const pack = buildImpactPack('修 `build_report`', dir, { run: realRun });
    const callerBlock = pack.text.slice(pack.text.indexOf('的调用者'));
    expect(callerBlock).not.toContain('src/app.py:6');
    expect(callerBlock).toContain('src/cli.py:5');
  });
});

describe('INV-2 —— ts: 大括号配平; 超 cap 截断', () => {
  test('★ parseWarningFilter 抽到配平的收尾 } (证伪: 不配平 ⇒ 本行红)', () => {
    const dir = repo({ 'src/warn.ts': TS_WARN });
    const pack = buildImpactPack('给 parseWarningFilter 加一条规则', dir, { run: realRun });

    expect(pack.text).toContain('export function parseWarningFilter(');
    expect(pack.text).toContain("return ['*'];"); // 嵌套块里的行也在
    expect(pack.text).toContain('return out;'); // 体内最后一行
    expect(pack.text).not.toContain('export const OTHER'); // 配平即止, 不吞下一个定义
    expect(pack.facts.defs).toBe(1);
  });

  test('★ extractDefinitionBlock: 超 cap ⇒ 截断并在末尾加「… (截断)」', () => {
    const lines = TS_WARN.split('\n');
    const defLine = lines.findIndex((l) => l.startsWith('export function parseWarningFilter'));
    const full = extractDefinitionBlock(lines, defLine, 'ts');
    expect(full.at(-1)).toBe('}'); // 配平收尾
    expect(full.length).toBeGreaterThan(5);

    const capped = extractDefinitionBlock(lines, defLine, 'ts', 5);
    expect(capped).toHaveLength(6); // 5 行正文 + 截断标记
    expect(capped.at(-1)).toBe('… (截断)');
    expect(capped[0]).toBe(lines[defLine]);
  });

  test('★ extractDefinitionBlock: python 按缩进收尾 (下一个同级行不进)', () => {
    const lines = PY_APP.split('\n');
    const defLine = lines.findIndex((l) => l.startsWith('def build_report'));
    const block = extractDefinitionBlock(lines, defLine, 'py');
    expect(block[0]).toBe('def build_report(rows):');
    expect(block.at(-1)).toBe('    return json.dumps(result)');
    expect(block.join('\n')).not.toContain('def other');
  });

  test('★ extractDefinitionBlock: 单行定义 (无大括号体) 只出一行', () => {
    const lines = ['export const add = (a: number, b: number) => a + b;', 'export const sub = 1;'];
    expect(extractDefinitionBlock(lines, 0, 'ts')).toEqual([lines[0]!]);
  });

  test("★ extractDefinitionBlock: lang='other' 退回缩进规则 (不认大括号也能收尾)", () => {
    const lines = ['def f():', '  body', 'next'];
    expect(extractDefinitionBlock(lines, 0, 'other')).toEqual(['def f():', '  body']);
  });
});

describe('INV-3 —— 抽不到任何定义 ⇒ 空包, 不是失败', () => {
  test('★ goal 无任何标识符 ⇒ text==="" 且 facts 全 0 且 why 缺席', () => {
    const dir = repo({ 'src/app.py': PY_APP });
    const pack = buildImpactPack('把那个东西修一下', dir, { run: realRun });
    expect(pack.text).toBe('');
    expect(pack.facts).toEqual({ terms: 0, defs: 0, callers: 0, chars: 0 });
    expect(pack.why).toBeUndefined(); // 「没有」不是「失败」(§静默坑 1)
  });

  test('★ 有词但仓里没有这些定义 ⇒ text==="" 且 defs===0, why 仍缺席', () => {
    const dir = repo({ 'src/app.py': PY_APP });
    const pack = buildImpactPack('给 `noSuchSymbolHere` 加一条规则', dir, { run: realRun });
    expect(pack.text).toBe('');
    expect(pack.facts.defs).toBe(0);
    expect(pack.why).toBeUndefined();
  });
});

describe('INV-5 —— fail-open: 一段炸只丢那一段, 原因原文进 why', () => {
  test('★ 调用者 grep 抛错 ⇒ 定义段照常, why 带原文', () => {
    const dir = repo({ 'src/app.py': PY_APP, 'src/cli.py': PY_CLI });
    const boom = (argv: string[], cwd: string): { exitCode: number | null; stdout: string } => {
      if (argv.some((a) => a === 'build_report(')) throw new Error('调用者段故意炸: EACCES');
      return realRun(argv, cwd);
    };
    const pack = buildImpactPack('修 `build_report`', dir, { run: boom });

    expect(pack.text).toContain('def build_report(rows):'); // 定义段照常
    expect(pack.facts.callers).toBe(0);
    expect(pack.why ?? '').toContain('调用者段故意炸: EACCES');
  });

  test('★ 定义 grep 抛错 ⇒ 空包 + why 带原文 (不是静默的空)', () => {
    const dir = repo({ 'src/app.py': PY_APP });
    const boom = (): { exitCode: number | null; stdout: string } => {
      throw new Error('定义段故意炸: ENOENT grep');
    };
    const pack = buildImpactPack('修 `build_report`', dir, { run: boom });
    expect(pack.text).toBe('');
    expect(pack.why ?? '').toContain('定义段故意炸: ENOENT grep');
  });
});

describe('INV-6 —— spawn 总墙钟有界', () => {
  test('★ 12 个词也在 10 s 内回来 (证伪: 去掉 deadline ⇒ 大仓上本行会超)', () => {
    const dir = repo({ 'src/app.py': PY_APP, 'src/cli.py': PY_CLI, 'src/warn.ts': TS_WARN });
    const goal = '改 `build_report` `parseWarningFilter` `a_one` `b_two` `c_three` `d_four` `e_five` `f_six` `g_seven` `h_eight` `i_nine` `j_ten` `k_eleven`';
    const t0 = Date.now();
    const pack = buildImpactPack(goal, dir, { run: realRun });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThanOrEqual(10_000);
    expect(pack.facts.terms).toBeLessThanOrEqual(12);
    console.log(`impact pack: ${ms} ms, terms=${pack.facts.terms}, defs=${pack.facts.defs}, callers=${pack.facts.callers}, chars=${pack.facts.chars}`);
  });

  test('★ maxChars 封顶 (证伪: 去掉总量截断 ⇒ 本行红)', () => {
    const dir = repo({ 'src/app.py': PY_APP, 'src/cli.py': PY_CLI });
    const pack = buildImpactPack('修 `build_report`', dir, { run: realRun, maxChars: 200 });
    expect(pack.text.length).toBeLessThanOrEqual(200 + 200);
    expect(pack.facts.chars).toBe(pack.text.length);
  });
});
