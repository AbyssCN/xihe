/**
 * 契约编译期闸的三类必挂样本（C-1 / C-2 / C-3）。
 *
 * 反向自检：
 *  · 将 sdd-direct.ts 的 `if (rawCells.length > 4)` 临时改成 `if (false)` →
 *    「falsify 单元格含竖线时抛错」用例红：非法 oldText 被静默解析。
 *  · 将 sdd-compile.ts 的 `if (first === 'npx')` 临时改成 `if (false)` →
 *    「verify/accept 首词 npx 抛错」用例红：npx 被白名单放行后在沙箱退出 127。
 */
import { describe, expect, test } from 'bun:test';
import { compileBreakdown } from './sdd-compile';
import { parseBreakdown, type SddBreakdown, type SddSlice } from './sdd-direct';

const FULL_REGRESSION = 'bunx tsc --noEmit && bun test';
const TYPES = 'src/harness/dag/types.ts';
const SEAMS = 'docs/architecture/seams.md';
const SEAM_TEST = 'src/harness/dag/seam-catalog.test.ts';

const breakdown = (slices: SddSlice[]): SddBreakdown => ({ slices });

const table = (rows: string[]): string =>
  [
    '# 契约编译期闸测试',
    '## 契约 (Contracts)',
    '- C-1 falsify 行超过四列必须拒。',
    '## 分解 (Breakdown)',
    '| 切片 | 写集 | 依赖 | verify |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');

const falsify = (text: string, row: string): string =>
  `${text}\n\n## 验收 (Acceptance)\n\n### 反向自检 (切片 1)\n| # | 文件 | oldText | newText |\n|---|---|---|---|\n${row}`;

const slice = (
  id: number,
  writeSet: readonly string[],
  verify = 'bun test src/a.test.ts',
): SddSlice => ({
  id,
  name: `切片 ${id}`,
  writeSet,
  deps: [],
  verify,
});

const errorText = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('预期调用失败, 但没有抛出错误');
};

const compile = (slices: SddSlice[]): unknown =>
  compileBreakdown(breakdown(slices), { acceptCommand: FULL_REGRESSION });

describe('契约编译期闸', () => {
  test('C-1: falsify 行含竖线 → 抛错, 判词含行原文与出口说明', () => {
    const row = '| 1 | src/a.ts | old || expression | replacement | n |';
    const text = falsify(
      table(['| 1 a | src/a.ts | — | bun test src/a.test.ts |']),
      row,
    );
    const message = errorText(() => parseBreakdown(text));
    expect(message).toContain(row);
    expect(message).toContain('单元格里不许出现 `|`');
  });

  test('C-1: 恰好四列的 falsify 行 → 行为保持', () => {
    const text = falsify(
      table(['| 1 a | src/a.ts | — | bun test src/a.test.ts |']),
      '| 1 | src/a.ts | old expression | new expression |',
    );
    const result = parseBreakdown(text);
    expect(result.falsify?.[1]?.[0]).toEqual({
      index: 1,
      file: 'src/a.ts',
      oldText: 'old expression',
      newText: 'new expression',
    });
  });

  // ── C-2 2026-09-04 翻转: 登记面由**拒**改**扩** ────────────────────────────
  // 这三条原本断言 compileBreakdown 抛。#243 的语义一直是「face 在并集里 = 修的权限」,
  // 而 REGISTRATION_FACES 是硬编码表, 表永远落后于仓 —— 一道只会误缩边界的闸不该 fail-closed
  // (实账 #254: run 8888b93b 的新闸因表外无权改 gate-registry 而 accept 红)。
  // 现在缺 face → 自动扩进该片写集 + 记账。真源与详注在 sdd-compile.expandRegistrationFaces。
  // ⚠ 本仓**没有**结晶期的独立 lint 模块 —— 这个 describe 名里的「编译期闸」就是全部,
  //   `contract-lint.ts` 不存在。作者今天靠 logger 的 expansions 记录与派工文本知道扩了什么。

  /** 编译后某片实施节点的 write_set —— 扩容的可见出口。 */
  const writeSetOf = (slices: SddSlice[], id: number): string[] =>
    (((compile(slices) as { nodes: Record<string, Record<string, unknown>> }).nodes[`s${id}`]!
      .write_set) as string[]);

  test('C-2: types.ts 缺 seams.md → 不拒, seams.md 被扩进写集', () => {
    // 证伪: 把 expandRegistrationFaces 的 push 删掉 → 本 test 由绿转红。
    expect(() => compile([slice(1, [TYPES, SEAM_TEST])])).not.toThrow();
    expect(writeSetOf([slice(1, [TYPES, SEAM_TEST])], 1)).toContain(SEAMS);
  });

  test('C-2: types.ts 缺 seam-catalog.test.ts → 不拒, 结构绊线被扩进写集', () => {
    expect(() => compile([slice(1, [TYPES, SEAMS])])).not.toThrow();
    expect(writeSetOf([slice(1, [TYPES, SEAMS])], 1)).toContain(SEAM_TEST);
  });

  test('C-2: types.ts 缺两个伙伴 → 两者都被扩进写集', () => {
    const ws = writeSetOf([slice(1, [TYPES])], 1);
    expect(ws).toContain(SEAMS);
    expect(ws).toContain(SEAM_TEST);
  });

  test('C-2: types.ts 带两个伙伴 → 正常编译', () => {
    expect(() => compile([slice(1, [TYPES, SEAMS, SEAM_TEST])])).not.toThrow();
  });

  test('C-2: 两个伙伴可在另一切片写集 → 并集仍满足闸', () => {
    expect(() => compile([slice(1, [TYPES]), slice(2, [SEAMS, SEAM_TEST])])).not.toThrow();
  });

  test('C-2: 不含 types.ts 的契约 → 正常编译', () => {
    expect(() => compile([slice(1, ['src/ordinary.ts'])])).not.toThrow();
  });

  test('C-3: verify 首词 npx → 抛错并给本地 bin 出口', () => {
    const message = errorText(() =>
      compileBreakdown(
        parseBreakdown(table(['| 1 a | src/a.ts | — | npx tsc --noEmit |'])),
        { acceptCommand: FULL_REGRESSION },
      ),
    );
    expect(message).toContain('npx');
    expect(message).toContain('./node_modules/.bin/<bin>');
  });

  test('C-3: accept 首词 npx → 抛错并给本地 bin 出口', () => {
    const message = errorText(() =>
      compileBreakdown(breakdown([slice(1, ['src/a.ts'], 'bun test src/a.test.ts')]), {
        acceptCommand: 'npx tsc --noEmit',
      }),
    );
    expect(message).toContain('npx');
    expect(message).toContain('./node_modules/.bin/<bin>');
  });

  test('C-3: bun test verify → 正常编译且命令逐字保留', () => {
    const verify = 'bun test src/a.test.ts';
    const plan = compileBreakdown(breakdown([slice(1, ['src/a.ts'], verify)]), {
      acceptCommand: FULL_REGRESSION,
    });
    expect(plan.nodes['s1-green']!.command).toBe(verify);
  });
});
