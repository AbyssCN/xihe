/**
 * goal/criterion-author.test —— 异族座**先写判据** 纯模块
 * (契约 `docs/plan/2026-09-06-异族先写判据-执行契约.md` INV-1 / INV-2 / INV-5)。
 *
 * ## 它治的那个病 (R2 逐题现场)
 *
 * M3 三臂 feature+bug_fix 20 题 0.37/0.37/0.32, 而恒定低分题各臂逐字相同 (`matching_absolute` 0.25 …)。
 * 现场: gold 改 2 个文件, M3 只改 1 个, 自写的判据把断言放进 `test_util.py` 去测辅助函数 —— 引擎判它成。
 * **判据断言内容由执行侧自己写 = 让考生自己出题**, 任何检查判据文本的机械闸都抓不到「断言写错」。
 * 治法不是再加一道闸, 是换出题人: 判据文件由**异族座**在看不到实装时写出, 执行侧只能让它过。
 *
 * ## 反向自检 (证伪句逐条写在各 test 注释里)
 *  · 去掉 D-4 的方向探针 (直接采纳异族座的产出) ⇒ 「green-before ⇒ 弃用」当场红;
 *  · `parseAuthoredFiles` 不比 `allowed` ⇒ 「越界路径判 error」当场红;
 *  · 弃用时不删已写入的文件 ⇒ 「root 上没有该文件」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorCriterionCrossFamily, parseAuthoredFiles } from './criterion-author';
import type { CriterionDirectionVerdict } from './acceptance-gate';

const CRITERION = 'tests/test_add.py';
const AUTHORED = 'from pkg.add import add\n\ndef test_add():\n    assert add(1, 2) == 3\n';

/** 异族座的合法产出:一个 JSON 对象, path 落在 `missingFiles` 里。 */
const okRaw = JSON.stringify({ files: [{ path: CRITERION, content: AUTHORED }] });

/** 真仓 —— 探针与写入都在盘上发生, 替身喂不出「文件真在不在」这一位。 */
function seedRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-criterion-author-'));
  execFileSync('git', ['init', '-q'], { cwd });
  return cwd;
}

/** 每次调用都返回同一份产出的注入式 generate (记下它收到的 prompt, 供 D-3 断言)。 */
function fakeGenerate(raw: string): { fn: (req: { model: string; prompt: string }) => Promise<string>; seen: { model: string; prompt: string }[] } {
  const seen: { model: string; prompt: string }[] = [];
  return {
    seen,
    fn: async (req) => {
      seen.push(req);
      return raw;
    },
  };
}

const probeReturning = (v: CriterionDirectionVerdict) => (async () => v) as never;

/** 契约里 `authorCriterionCrossFamily` 的定参 —— 各 test 只覆盖自己关心的那一格。 */
function baseInput(root: string) {
  return {
    goal: 'make add() handle negative numbers',
    command: `pytest -q ${CRITERION}`,
    expectExit: 0,
    missingFiles: [CRITERION],
    root,
    surveyText: '===== 仓内事实 =====\npkg/add.py: def add(a, b)',
    conductorModel: 'bench:MiniMax-M3',
    crossFamily: () => 'bench:sol-1',
  };
}

describe('INV-1 parseAuthoredFiles: 越界 / `..` / 坏 JSON 一律 error, 合法才出 files', () => {
  test('★ 合法 ⇒ files (path 归一成相对 posix 路径)', () => {
    const r = parseAuthoredFiles(okRaw, [CRITERION]);
    expect(r).toEqual({ files: [{ path: CRITERION, content: AUTHORED }] });
  });

  test('★ path 不在 allowed ⇒ error (证伪: 不比 allowed → 本条红)', () => {
    const raw = JSON.stringify({ files: [{ path: 'src/add.py', content: 'x' }] });
    const r = parseAuthoredFiles(raw, [CRITERION]) as { error: string };
    expect(r.error).toContain('src/add.py');
    expect(r.error).toContain(CRITERION);
  });

  test('★ path 含 `..` ⇒ error (哪怕它归一后落在 allowed 里也拒 —— 拒的是形状)', () => {
    const raw = JSON.stringify({ files: [{ path: `tests/../${CRITERION}`, content: 'x' }] });
    expect(parseAuthoredFiles(raw, [CRITERION])).toHaveProperty('error');
  });

  test('★ 绝对路径 ⇒ error', () => {
    const raw = JSON.stringify({ files: [{ path: `/etc/${CRITERION}`, content: 'x' }] });
    expect(parseAuthoredFiles(raw, [CRITERION])).toHaveProperty('error');
  });

  test('★ JSON 坏 ⇒ error, 且原文前缀进 error (§静默坑 2: 不吞证据)', () => {
    const r = parseAuthoredFiles('这不是 JSON', [CRITERION]) as { error: string };
    expect(r.error).toContain('这不是 JSON');
  });

  test('★ files 空 / 形状不对 ⇒ error (不许把"什么都没写"读成成功)', () => {
    expect(parseAuthoredFiles(JSON.stringify({ files: [] }), [CRITERION])).toHaveProperty('error');
    expect(parseAuthoredFiles(JSON.stringify({ files: [{ path: CRITERION }] }), [CRITERION])).toHaveProperty('error');
    expect(parseAuthoredFiles(JSON.stringify({ notFiles: 1 }), [CRITERION])).toHaveProperty('error');
  });

  test('★ 包在 ```json 围栏里也认 (模型常这么回, 拒它等于白烧一发)', () => {
    const r = parseAuthoredFiles(`好的:\n\`\`\`json\n${okRaw}\n\`\`\`\n`, [CRITERION]);
    expect(r).toEqual({ files: [{ path: CRITERION, content: AUTHORED }] });
  });

  test('★ `./` 前缀归一后与 allowed 比 (写法差别不算越界)', () => {
    const raw = JSON.stringify({ files: [{ path: `./${CRITERION}`, content: AUTHORED }] });
    expect(parseAuthoredFiles(raw, [CRITERION])).toEqual({ files: [{ path: CRITERION, content: AUTHORED }] });
  });
});

describe('INV-2 authorCriterionCrossFamily: 探针 red-before 才采纳, 其余一律弃用并删回去', () => {
  test('★ red-before ⇒ accepted, 文件真写到 root, direction 记上', async () => {
    const root = seedRepo();
    const g = fakeGenerate(okRaw);
    const r = await authorCriterionCrossFamily({
      ...baseInput(root),
      generate: g.fn,
      probeDirection: probeReturning({ status: 'red-before', why: '改动前红' }),
    });
    expect(r).toEqual({ attempted: true, model: 'bench:sol-1', files: [CRITERION], direction: 'red-before', accepted: true });
    // 证伪: 采纳路不写盘 → 本条红。
    expect(readFileSync(join(root, CRITERION), 'utf8')).toBe(AUTHORED);
    // D-3: 出题人只拿到指令 + 勘察包 + 判据命令, **没有实装**。
    expect(g.seen).toHaveLength(1);
    expect(g.seen[0]!.model).toBe('bench:sol-1');
    expect(g.seen[0]!.prompt).toContain('make add() handle negative numbers');
    expect(g.seen[0]!.prompt).toContain('pkg/add.py');
    expect(g.seen[0]!.prompt).toContain(CRITERION);
  });

  test('★ green-before ⇒ 不采纳, root 上没有该文件, why 含 green-before', async () => {
    const root = seedRepo();
    const r = await authorCriterionCrossFamily({
      ...baseInput(root),
      generate: fakeGenerate(okRaw).fn,
      probeDirection: probeReturning({ status: 'green-before', why: '改动前就绿' }),
    });
    expect(r.accepted).toBe(false);
    expect(r.direction).toBe('green-before');
    expect(r.why).toContain('green-before');
    // 证伪: 去掉 D-4 的方向探针 (或弃用时不删文件) → 本条红。
    expect(existsSync(join(root, CRITERION))).toBe(false);
  });

  test('★ inconclusive ⇒ 同样不采纳 (什么都没量到 ≠ 量到了红; §静默坑 1)', async () => {
    const root = seedRepo();
    const r = await authorCriterionCrossFamily({
      ...baseInput(root),
      generate: fakeGenerate(okRaw).fn,
      probeDirection: probeReturning({ status: 'inconclusive', why: '反面世界没建成' }),
    });
    expect(r.accepted).toBe(false);
    expect(r.direction).toBe('inconclusive');
    expect(existsSync(join(root, CRITERION))).toBe(false);
  });

  test('★ 空世界自检判红 (判据恒真) ⇒ 不采纳, 文件删回去, why 带自检原文', async () => {
    const root = seedRepo();
    const r = await authorCriterionCrossFamily({
      ...baseInput(root),
      generate: fakeGenerate(okRaw).fn,
      probeDirection: probeReturning({ status: 'red-before', why: '改动前红' }),
      // 活还没干就已经满足 ⇒ probeVacuity 判 ring ⇒ acceptanceVacuityReason 出一行拒因。
      runCommand: async () => ({ exitCode: 0 }),
    });
    expect(r.accepted).toBe(false);
    expect(r.why).toContain('vacuous');
    expect(existsSync(join(root, CRITERION))).toBe(false);
  });

  test('★ 空世界自检判绿 (空世界里红) ⇒ 照常采纳', async () => {
    const root = seedRepo();
    const r = await authorCriterionCrossFamily({
      ...baseInput(root),
      generate: fakeGenerate(okRaw).fn,
      probeDirection: probeReturning({ status: 'red-before', why: '改动前红' }),
      runCommand: async () => ({ exitCode: 1 }),
    });
    expect(r.accepted).toBe(true);
    expect(existsSync(join(root, CRITERION))).toBe(true);
  });

  test('★ 产出越界 (写实装文件) ⇒ 不采纳, 一个字节都不写进磁盘', async () => {
    const root = seedRepo();
    const r = await authorCriterionCrossFamily({
      ...baseInput(root),
      generate: fakeGenerate(JSON.stringify({ files: [{ path: 'pkg/add.py', content: 'def add(a,b): return a+b' }] })).fn,
      probeDirection: probeReturning({ status: 'red-before', why: '改动前红' }),
    });
    expect(r.attempted).toBe(true);
    expect(r.accepted).toBe(false);
    expect(r.why).toContain('pkg/add.py');
    expect(existsSync(join(root, 'pkg/add.py'))).toBe(false);
  });

  test('★ generate 抛错 ⇒ attempted 记上, accepted false, why 带原文 (§静默坑 2)', async () => {
    const root = seedRepo();
    const r = await authorCriterionCrossFamily({
      ...baseInput(root),
      generate: async () => {
        throw new Error('429 上游限流');
      },
      probeDirection: probeReturning({ status: 'red-before', why: '改动前红' }),
    });
    expect(r).toEqual({ attempted: true, model: 'bench:sol-1', accepted: false, why: expect.stringContaining('429 上游限流') as unknown as string });
  });
});

describe('INV-5 没有异族座 ⇒ 不写, 退回执行侧自写', () => {
  test('★ crossFamily 返 undefined ⇒ attempted:false + why:no-cross-family-seat, 一发模型都不打', async () => {
    const root = seedRepo();
    const g = fakeGenerate(okRaw);
    const r = await authorCriterionCrossFamily({
      ...baseInput(root),
      crossFamily: () => undefined,
      generate: g.fn,
      probeDirection: probeReturning({ status: 'red-before', why: '改动前红' }),
    });
    expect(r).toEqual({ attempted: false, accepted: false, why: 'no-cross-family-seat' });
    // 证伪: 没座也照打一发 → 本条红 (那是白烧钱, 而且打给的是同族座)。
    expect(g.seen).toHaveLength(0);
  });

  test('★ missingFiles 空 ⇒ 不适用 (判据指向既有文件, 那一类 reward 最高, 不动它)', async () => {
    const root = seedRepo();
    const g = fakeGenerate(okRaw);
    const r = await authorCriterionCrossFamily({ ...baseInput(root), missingFiles: [], generate: g.fn, probeDirection: probeReturning({ status: 'red-before', why: 'x' }) });
    expect(r.attempted).toBe(false);
    expect(g.seen).toHaveLength(0);
  });
});
