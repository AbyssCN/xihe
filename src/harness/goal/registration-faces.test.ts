/**
 * src/harness/goal/registration-faces.test —— 登记面泛化 (#243) 反向自检。
 *
 * SDD: docs/plan/2026-08-25-243-245-编译与交接保真-执行契约.md 切片 1。
 * 真源: src/harness/goal/sdd-compile.ts `REGISTRATION_FACES` + `expandRegistrationFaces`。
 *
 * ## 2026-09-04: 断言方向整体翻转 (拒 → 扩)
 *
 * 这条闸的语义从第一天起就是**授权**不是强制。而 `REGISTRATION_FACES` 是硬编码表, 表永远
 * 落后于仓 —— 表外长出新绊线时它只会**误缩边界** (实账 #254: run 8888b93b 的新闸
 * `[fuse-paralysis]` 因表外无权改 gate-registry 而 accept 红, owner 手补表 13→14)。
 * 所以点火期改成「缺 face → 自动扩进写集 + 记账」, 结晶期的 `contract-lint` C-2 继续抛。
 *
 * 反向自检形状随之翻转: 每条 trigger 配一份**缺 face 的样本**, 断言编译**不抛**、且该片
 * `write_set` 扩出了那些 face、派工文本把它们标成「授权非要求」。证伪方式逐条写在注释 ——
 * 「把 `host.writeSet.push` 删掉 / 把 trigger 行注释掉 → 此 test 由绿转红」。
 * 一条永远绿的闸不是闸 (CLAUDE.md §1 加闸纪律)。
 */
import { describe, expect, test } from 'bun:test';
import { type SddBreakdown } from './sdd-direct';
import { compileBreakdown } from './sdd-compile';

const FULL_REGRESSION = 'bunx tsc --noEmit && bun test';

/** 直接造结构 (绕开表文本), 用于给编译器喂精确的样本。 */
const bd = (slices: SddBreakdown['slices'], waves?: SddBreakdown['waves']): SddBreakdown =>
  waves ? { slices, waves } : { slices };

const slice = (
  id: number,
  over: string[],
  deps: number[],
  verify = `bun test src/s${id}.test.ts`,
): SddBreakdown['slices'][number] => ({ id, name: `切片 ${id}`, writeSet: over, deps, verify });

const compile = (b: SddBreakdown) => compileBreakdown(b, { acceptCommand: FULL_REGRESSION });

/** 编译后某片实施节点的 write_set (扩容的可见出口之一)。 */
const writeSetOf = (b: SddBreakdown, id: number): string[] =>
  ((compile(b).nodes as Record<string, Record<string, unknown>>)[`s${id}`]!.write_set as string[]);

/** 编译后某片实施节点的派工文本 (扩容的另一个出口: 授权 ≠ 要求 这句话必须在)。 */
const goalOf = (b: SddBreakdown, id: number): string =>
  ((compile(b).nodes as Record<string, Record<string, unknown>>)[`s${id}`]!.goal as string);

/** 授权句的固定片段 —— 派工文本里说不清「授权 ≠ 要求」, 本次改动就等于没做。 */
const GRANT_PHRASE = '是登记面: 已授权你改, 但**不要求**改';

// ── INV-2: types.ts 行 ────────────────────────────────────────────────────────

describe('登记面扩容 — types.ts 行', () => {
  test('写集含 types.ts 缺两面 → 不拒, 两面被扩进该片写集', () => {
    // GWT G: 写集只有 types.ts W: compileBreakdown T: 不抛, write_set 扩出 seam 两面。
    // 证伪: 把 `host.writeSet.push(f.file)` 那行删掉 → 本 test 由绿转红。
    const bad = bd([slice(1, ['src/harness/dag/types.ts'], [])]);
    expect(() => compile(bad)).not.toThrow();
    const ws = writeSetOf(bad, 1);
    expect(ws).toContain('docs/architecture/seams.md');
    expect(ws).toContain('src/harness/dag/seam-catalog.test.ts');
    // 原写集项一个都不许丢 —— 扩容是并集, 不是替换。
    expect(ws).toContain('src/harness/dag/types.ts');
  });

  test('扩出来的面在派工文本里标成「授权非要求」, 与本片写集分开写', () => {
    // 证伪: 把 goal 里 grantedBySlice 那个三元删掉 → 本 test 转红。执行体读不到这句
    // 就会把登记面读成「这些都得改」, 于是去改一个它本不必碰的文件。
    const bad = bd([slice(1, ['src/harness/dag/types.ts'], [])]);
    const g = goalOf(bad, 1);
    expect(g).toContain(GRANT_PHRASE);
    expect(g).toContain('docs/architecture/seams.md');
    expect(g).toContain('只有本片确实动了对应真源时才同步它们');
  });

  test('并集已含两面 → 零扩容, 派工文本不出现授权句 (不无中生有)', () => {
    // GWT 阴性对照: 作者自己写全了 face → 扩容不该发生。
    // 证伪: 把 `if (union.has(f.file)) continue;` 删掉 → 本 test 转红 (授权句会冒出来)。
    const ok = bd([
      slice(1, ['src/harness/dag/types.ts', 'docs/architecture/seams.md', 'src/harness/dag/seam-catalog.test.ts'], []),
    ]);
    expect(() => compile(ok)).not.toThrow();
    expect(goalOf(ok, 1)).not.toContain(GRANT_PHRASE);
  });

  test('只缺一面 (留 seams.md) → 只扩那一个, 不重复加在场的', () => {
    // 单缺验证: 扩容必须精确到缺的那个。
    // 证伪: 把 union 判断改成无条件 push → seams.md 会出现两次, 本 test 转红。
    const bad = bd([slice(1, ['src/harness/dag/types.ts', 'docs/architecture/seams.md'], [])]);
    const ws = writeSetOf(bad, 1);
    expect(ws).toContain('src/harness/dag/seam-catalog.test.ts');
    expect(ws.filter((f) => f === 'docs/architecture/seams.md')).toHaveLength(1);
    expect(goalOf(bad, 1)).not.toContain('docs/architecture/seams.md 是登记面');
  });
});

// ── conductor-plan.ts 行 (#243 新 trigger) ────────────────────────────────────

describe('登记面扩容 — conductor-plan.ts 行 (#243)', () => {
  const FACES = [
    'src/harness/schema-field-registry.ts',
    'src/harness/schema-field-registry.test.ts',
    'docs/plan/2026-07-30-schema-field-registry.md',
  ];

  test('★ 缺三面中任一 → 不拒, 缺的那个被扩进写集', () => {
    // 证伪: 把 REGISTRATION_FACES 第二行 trigger 改成别的 → 本 test 红 (整个 describe 红)。
    //       把第一行注释掉但保留第二行 → 第一组 describe 红, 本组保持绿, 证明是泛化而非特化。
    for (const missingFile of FACES) {
      const faceOnly = ['src/harness/conductor-plan.ts', ...FACES].filter((f) => f !== missingFile);
      const bad = bd([slice(1, faceOnly, [])]);
      expect(() => compile(bad)).not.toThrow();
      expect(writeSetOf(bad, 1)).toContain(missingFile);
      expect(goalOf(bad, 1)).toContain(missingFile);
    }
  });

  test('并集含三面 → 零扩容 (闸不是恒扩)', () => {
    const ok = bd([slice(1, ['src/harness/conductor-plan.ts', ...FACES], [])]);
    expect(() => compile(ok)).not.toThrow();
    expect(goalOf(ok, 1)).not.toContain(GRANT_PHRASE);
  });

  test('同时含 types.ts 与 conductor-plan.ts, 两边都缺 → 两组面各自扩全', () => {
    // 多 trigger 同时命中: 各行独立扩, 互不吞并。
    // 证伪: 把 for 循环改成命中第一个就 break → 本 test 转红。
    const bad = bd([slice(1, ['src/harness/dag/types.ts', 'src/harness/conductor-plan.ts'], [])]);
    const ws = writeSetOf(bad, 1);
    for (const f of ['docs/architecture/seams.md', 'src/harness/dag/seam-catalog.test.ts', ...FACES])
      expect(ws).toContain(f);
  });
});

// ── schema-field-registry.ts 行 (#243 新 trigger) ─────────────────────────────

describe('登记面扩容 — schema-field-registry.ts 行 (#243)', () => {
  test('缺 docs 人读表 → 扩进去, 不拒', () => {
    // 证伪: 把 REGISTRATION_FACES 第三行 trigger 注释掉 → 本 test 红。
    const bad = bd([
      slice(1, ['src/harness/schema-field-registry.ts', 'src/harness/schema-field-registry.test.ts'], []),
    ]);
    expect(() => compile(bad)).not.toThrow();
    expect(writeSetOf(bad, 1)).toContain('docs/plan/2026-07-30-schema-field-registry.md');
  });

  test('并集含两 face → 零扩容', () => {
    const ok = bd([
      slice(
        1,
        [
          'src/harness/schema-field-registry.ts',
          'docs/plan/2026-07-30-schema-field-registry.md',
          'src/harness/schema-field-registry.test.ts',
        ],
        [],
      ),
    ]);
    expect(() => compile(ok)).not.toThrow();
    expect(goalOf(ok, 1)).not.toContain(GRANT_PHRASE);
  });
});

// ── INV-3: 不含任何 trigger 的契约走原路 (零行为差) ───────────────────────────

describe('登记面扩容 — 无 trigger 命中 (INV-3 零行为差)', () => {
  test('写集不含任何 trigger → 编译过且写集逐字不变', () => {
    // 证伪: 把 `if (!host) continue;` 删掉 → 本 test 转红 (无 trigger 的片会被塞面)。
    const ok = bd([slice(1, ['src/a.ts'], []), slice(2, ['src/b.ts'], [1])], [[1], [2]]);
    expect(() => compile(ok)).not.toThrow();
    expect(writeSetOf(ok, 1)).toEqual(['src/a.ts']);
    expect(writeSetOf(ok, 2)).toEqual(['src/b.ts']);
  });
});

// ── #254: engine.ts / run-goal.ts ↔ gate-registry 两件套 ──────────────────────
// 现场: B1 run 8888b93b 新闸 [fuse-paralysis] 长在 engine.ts, 写集无权改 gate-registry →
// accept 红, owner 手补 (13→14)。本次改动让这一整类跑不再需要人手补表。

describe('登记面扩容 — engine.ts / run-goal.ts 的 gate-registry 面 (#254)', () => {
  const GATE_FACES = ['src/harness/gates/gate-registry.ts', 'src/harness/gates/gate-registry.test.ts'];

  test('写集含 engine.ts 缺两件套 → 扩进去 (#254 那一跑不再红)', () => {
    // 证伪: 把 REGISTRATION_FACES 的 engine.ts 行注释掉 → 本 test 由绿转红。
    const bad = bd([slice(1, ['src/harness/dag/engine.ts'], [])]);
    expect(() => compile(bad)).not.toThrow();
    const ws = writeSetOf(bad, 1);
    for (const f of GATE_FACES) expect(ws).toContain(f);
  });

  test('写集含 run-goal.ts 缺两件套 → 扩进去; 已补齐 → 零扩容', () => {
    // 证伪: 把 run-goal.ts 行注释掉 → 前半由绿转红。
    const bad = bd([slice(1, ['src/harness/goal/run-goal.ts'], [])]);
    for (const f of GATE_FACES) expect(writeSetOf(bad, 1)).toContain(f);
    const ok = bd([slice(1, ['src/harness/goal/run-goal.ts', ...GATE_FACES], [])]);
    expect(goalOf(ok, 1)).not.toContain(GRANT_PHRASE);
  });
});

// ── 扩容不许造写集相交 (本次改动最大的风险面) ─────────────────────────────────

const GATE_FACES_SHARED = ['src/harness/gates/gate-registry.ts', 'src/harness/gates/gate-registry.test.ts'];

describe('登记面扩容 — 不造写集相交', () => {
  test('两片各含一个 trigger 而共享同一 face → face 只落一片, 编译过', () => {
    // engine.ts 与 run-goal.ts 的 faces 完全相同。分散到两片各扩一份 = 写集相交 =
    // 并发跑互相覆盖。扩容只扩进**第一个**含 trigger 的片, 且扩完立刻进 union。
    // 证伪: 把 `union.add(f.file)` 那行删掉 → 两片都会被扩, 本 test 由绿转红
    //       (assertDisjointWriteSets 在扩容之前跑, 抓不到, 所以只能靠本 test 抓)。
    const two = bd([
      slice(1, ['src/harness/dag/engine.ts'], []),
      slice(2, ['src/harness/goal/run-goal.ts'], [1]),
    ]);
    expect(() => compile(two)).not.toThrow();
    const ws1 = writeSetOf(two, 1);
    const ws2 = writeSetOf(two, 2);
    for (const f of GATE_FACES_SHARED) {
      const inBoth = ws1.includes(f) && ws2.includes(f);
      expect(inBoth).toBe(false);
      expect(ws1.includes(f) || ws2.includes(f)).toBe(true);
    }
  });
});
