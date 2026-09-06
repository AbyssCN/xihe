/**
 * Seam 目录闸 (A1)。两道闸的正反两面都在这里钉死:
 *  - 漂移闸: 盘上 docs/architecture/seams.md 必须与类型真源重新生成的结果逐字节相等
 *    (改了 Dag*Seam 接口没重跑生成器 → 本文件红; 手改生成文档 → 本文件红)。
 *  - 死旋钮闸: 字段在 src/ (非测试) 零消费 → 生成器拒 (用注入的假字段证明它真的会拒)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog, deadFields, extractSeams, renderCatalog, scanConsumers } from '../../../scripts/gen-seam-catalog';

const ROOT = join(import.meta.dir, '../../..');

describe('seam 目录 (gen-seam-catalog)', () => {
  const built = buildCatalog();

  test('漂移闸: 盘上目录与类型真源重新生成结果逐字节相等', () => {
    const onDisk = readFileSync(join(ROOT, 'docs/architecture/seams.md'), 'utf8');
    expect(onDisk).toBe(built.markdown);
  });

  test('漂移闸反向: 内容差一个字节即不等 (闸不是恒真式)', () => {
    const onDisk = readFileSync(join(ROOT, 'docs/architecture/seams.md'), 'utf8');
    expect(`${onDisk} `).not.toBe(built.markdown);
  });

  test('死旋钮闸: 当前 50 个字段全部有非测试消费方', () => {
    expect(built.dead).toEqual([]);
  });

  test('死旋钮闸反向: 注入一个仓里不存在的字段名, 闸必须点名拒它', () => {
    const fixture = `
      /** 假 seam */
      export interface DagZzzSeam {
        /** 没人消费的旋钮 */
        zzzUnusedKnob9?: boolean;
      }
    `;
    const seams = extractSeams(fixture);
    expect(seams).toHaveLength(1);
    scanConsumers(seams);
    expect(deadFields(seams)).toEqual(['DagZzzSeam.zzzUnusedKnob9']);
  });

  test('结构绊线: 8 seam / 50 字段 (改了分组或增删字段 → 抬这两个数并重跑生成器; 2026-09-04 v1 退役删 6 个死旋钮 56→50, 再删 judgeModel 随 gate 座 → 49)', () => {
    // 刻意保留字面量 —— 派生成 length 就成恒真式, 绊线就没了 (同 seat-check 16→18 的先例)
    // +1 来自 #247 片 2: planCriticGate (DagLeafShapingSeam)
    // +1 来自 D2 切片 2 (#266): repoChecks (DagRunnersSeam) + 新类型 RepoCheck
    // +1 来自 S2 片 3 (2026-08-25): spinRung2 (DagRunnersSeam) 节点级空转档 2 阶梯配置
    // +1 来自 t-initial-pump (2026-09-02): warmGraceMs (DagSchedulingSeam) 暖发宽限窗口上界
    // 注: 新增 `RepoCheck` 类型不在 Dag*Seam 接口字段数内, 故 seam 字段数只 +1。
    // +1 来自 R5.1 (2026-09-07): forRoot (DagRunnersSeam) 换根重建两只 leaf runner 的钩子 → 50。
    const seams = extractSeams(readFileSync(join(ROOT, 'src/harness/dag/types.ts'), 'utf8'));
    expect(seams).toHaveLength(8);
    expect(seams.reduce((n, s) => n + s.fields.length, 0)).toBe(50);
  });

  // 2026-09-02 实测踩到的病: `src/harness/plan/map-expand.ts` 的注释里写了某个 Dag*Seam 字段名,
  // token 级扫描把它算成"本文件消费了那个接缝", 漂移闸当场红 (56 vs 55 文件)。下面两条把
  // "只认代码" 的正反两面钉死 —— 摘掉 gen-seam-catalog 里的 stripNonCode, 反向那条当场红。
  const SCAN_FIXTURE = `
    /** 假 seam */
    export interface DagFixtureSeam {
      zzzFixtureKnob9?: boolean;
    }
  `;
  const scanIn = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'seam-scan-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const seams = extractSeams(SCAN_FIXTURE);
    scanConsumers(seams, dir);
    return seams[0]!.fields[0]!;
  };

  test('消费方扫描反向: 只在注释/字符串字面量里出现的字段名不算消费方', () => {
    const field = scanIn({
      'commented.ts': '// zzzFixtureKnob9 只在这条注释里出现\n/* 以及 zzzFixtureKnob9 这条块注释 */\nexport const x = 1;\n',
      'stringy.ts': "export const msg = '旋钮 zzzFixtureKnob9 的说明文字';\nexport const t = `模板里的 zzzFixtureKnob9`;\n",
    });
    expect(field.consumerCount).toBe(0);
    expect(field.consumers).toEqual([]);
  });

  test('消费方扫描正控: 真代码里的引用照样算 (闸不是永远不报)', () => {
    const field = scanIn({
      'commented.ts': '// zzzFixtureKnob9 只在这条注释里出现\nexport const x = 1;\n',
      'real.ts': 'export function f(cfg: { zzzFixtureKnob9?: boolean }) {\n  const { zzzFixtureKnob9 } = cfg;\n  return zzzFixtureKnob9 === true;\n}\n',
    });
    expect(field.consumerCount).toBe(1);
    expect(field.consumers[0]).toEndWith('real.ts');
  });

  test('抽取保真: 必填/可选与 JSDoc 首句都进目录', () => {
    const fixture = `
      /** 组说明。 */
      export interface DagAaaSeam {
        /** 首句到此。第二句不进目录。 */
        alpha: string;
        beta?: number;
      }
    `;
    const [seam] = extractSeams(fixture);
    expect(seam!.fields).toEqual([
      expect.objectContaining({ name: 'alpha', optional: false, doc: '首句到此。' }),
      expect.objectContaining({ name: 'beta', optional: true, doc: '' }),
    ]);
    const md = renderCatalog([seam!]);
    expect(md).toContain('`alpha` | **是**');
  });
});
