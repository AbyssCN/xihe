/**
 * scripts/autoresearch-night.test.ts —— 夜链拓扑 (契约 INV-1 / INV-6 / INV-7)
 * + t-gate-inmigrate 切片 3 的 night.sh 变薄守恒闸 (NIGHT_DRYRUN_KEPT, 一字不动地保留)。
 *
 * NIGHT_DRYRUN_KEPT —— C-5:闸 0/1/2 的 bash 实现删除后,--dry-run 仍报告点火闸判定
 * (语义不回归,位置从 bash 挪进引擎 ignitionPreflight)。
 *
 * 反向自检(判据力):
 *  · 把 night.sh 里的探针段删掉 → 「dry-run 报告闸判定」用例红(输出不含探针行);
 *  · 把 bash 旧闸加回去(if grep -q '草案…)→ 「零 bash 闸实现」用例红。
 *
 * 夜链拓扑那几节的反向自检 —— **真跑读数** (改一处, 跑本文件 22 条):
 *  · 删 sessions 的 timeoutMs 装饰    → 2 fail (GWT-1 那条 + CLI dry-run 输出那条)
 *  · timeoutMs 改成写死常数           → 1 fail (换夜帽读数不跟着动)
 *  · 删 verify 的 gate:false 装饰     → 1 fail (D-6)
 *  · 删 write_set 装饰                → 1 fail (GWT-1)
 *  · 附录里的 null 印成 0             → 1 fail (NULL ≠ 0)
 *  · 预登记的夜帽写死成 8.0h          → 1 fail
 *  · night.sh 里加回一行 `PHASE=`     → 1 fail (INV-7)
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as gateway from '../src/model/gateway';
import { compileChain } from '../src/harness/goal/stage-chain';
import {
  APPENDIX_PRECEDENCE_LINE,
  NIGHT_STAGE_IDS,
  buildNightChain,
  buildNightPlan,
  decorateNightPlan,
  nightDir,
  parseNightArgs,
  renderDryRun,
  renderMechanicalAppendix,
  renderPrereg,
  type NightOpts,
} from './autoresearch-night';

const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'autoresearch-night.sh');

const OPTS: NightOpts = {
  date: '2026-09-02',
  maxCards: 3,
  nightBudgetMinutes: 480,
  sessionBudgetMinutes: 120,
  cwd: ROOT,
};

describe('autoresearch-night 变薄守恒 (NIGHT_DRYRUN_KEPT)', () => {
  test('bash 语法有效', () => {
    const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  test('零 bash 闸实现:旧闸 0/1/2 的判定代码已删', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    // 闸 1 的 bash 判定(grep 草案标记后 die)不在了 —— 标记串只许出现在声明 JSON 里
    expect(text).not.toMatch(/if grep -q '草案/);
    // 闸 2 的 bash 判定(config dump 逐座位比对 + verify-seats 调用)不在了
    expect(text).not.toContain('verify-seats');
    expect(text).not.toContain('conductor 座位不对');
    // 闸 0 的锁判定(kill -0 后 die 5)不在了
    expect(text).not.toContain('已有夜跑在进行');
  });

  test('引擎闸声明与探针在场:preflight.json 生成段 + ignitionPreflight 调用', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('.omd/preflight.json');
    expect(text).toContain('ignitionPreflight');
    expect(text).toContain('seatExpectations');
  });

  test('dry-run 报告点火闸判定(语义不回归;不点火)', () => {
    // 真跑 --dry-run:探针走真引擎件。断言两件事:
    //  ① 输出报告了闸判定(绿或红都算「报告了」—— 语义在场);
    //  ② 退出码 ∈ {0, 2, 4}(0 全绿 / 2 闸红 / 4 阶梯待人),绝不点火(无「已点火」行)。
    const r = spawnSync('bash', [SCRIPT, '--dry-run'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/点火闸探针绿|点火闸红/);
    expect([0, 2, 4]).toContain(r.status ?? -1);
    expect(out).not.toContain('已点火 pid');
  });
});

// ── INV-7: night.sh 变薄 (D-8) ──────────────────────────────────────────────

describe('night.sh 变薄 (契约 D-8 / INV-7)', () => {
  test('阶梯段已删: 脚本文本不再含 PHASE=', () => {
    // 反向自检: 把 `PHASE="P2(…)"` 那几行加回去 → 本条红。
    expect(readFileSync(SCRIPT, 'utf8')).not.toContain('PHASE=');
  });

  test('拓扑不再由 bash 定: 点火交给 driver, 不再直接 solve --sdd', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('bun scripts/autoresearch-night.ts');
    // 旧壳直接起 `cli.ts solve "$GOAL" --sdd "$SDD"` —— 那条路把拓扑的真源留在了 bash 里
    expect(text).not.toContain('--sdd "$SDD"');
  });
});

// ── INV-1: 拓扑固定 ────────────────────────────────────────────────────────

describe('buildNightChain / decorateNightPlan (INV-1 · GWT-1)', () => {
  test('GWT-1: 节点 id 集合 = 契约那 7 个, 顺序与链一致', () => {
    const plan = buildNightPlan(OPTS);
    expect(Object.keys(plan.nodes)).toEqual([...NIGHT_STAGE_IDS]);
  });

  test('GWT-1: sessions.timeoutMs = 夜帽分钟 × 60000', () => {
    const plan = buildNightPlan(OPTS);
    expect((plan.nodes.sessions as Record<string, unknown>).timeoutMs).toBe(480 * 60_000);
    // 另一侧: 换个夜帽读数要跟着动 (不是写死的常数)
    const plan2 = buildNightPlan({ ...OPTS, nightBudgetMinutes: 60 });
    expect((plan2.nodes.sessions as Record<string, unknown>).timeoutMs).toBe(60 * 60_000);
  });

  test('GWT-1: propose.write_set 只含 <night>/cards.raw.json', () => {
    const plan = buildNightPlan(OPTS);
    expect((plan.nodes.propose as Record<string, unknown>).write_set).toEqual([
      `${nightDir('2026-09-02')}/cards.raw.json`,
    ]);
    expect((plan.nodes.report as Record<string, unknown>).write_set).toEqual([
      `${nightDir('2026-09-02')}/morning.md`,
    ]);
    // 命令节点不加写集 (它们的写集由被调 CLI 自己负责)
    expect((plan.nodes.mine as Record<string, unknown>).write_set).toBeUndefined();
  });

  test('GWT-1: 编译产物与装饰产物两次 parsePlan 都通过', () => {
    // compileChain 自身走 PlanSchema.parse (不通过会抛); decorateNightPlan 内部再 parsePlan 一次。
    const compiled = compileChain(buildNightChain(OPTS));
    expect(() => decorateNightPlan(compiled, OPTS)).not.toThrow();
  });

  test('INV-1: 同一 opts 两次 buildNightChain 逐字节相同', () => {
    expect(JSON.stringify(buildNightChain(OPTS))).toBe(JSON.stringify(buildNightChain(OPTS)));
  });

  test('线性依赖: 每段只接前一段, 首段无依赖', () => {
    const plan = buildNightPlan(OPTS);
    const deps = (id: string): string[] =>
      ((plan.nodes[id] as Record<string, unknown>).depends_on as string[]) ?? [];
    expect(deps('mine')).toEqual([]);
    for (let i = 1; i < NIGHT_STAGE_IDS.length; i++) {
      expect(deps(NIGHT_STAGE_IDS[i]!)).toEqual([NIGHT_STAGE_IDS[i - 1]!]);
    }
  });

  test('D-6: verify 节点 gate 落成 false (夜链末段必须无条件产报告)', () => {
    // compileChain 把 verify 词硬编成 gate:true; 装饰这一步把它按 D-6 改成 false。
    const compiled = compileChain(buildNightChain(OPTS));
    expect(((compiled.nodes.verify as Record<string, unknown>).params as Record<string, unknown>).gate)
      .toBe(true);
    const plan = buildNightPlan(OPTS);
    expect(((plan.nodes.verify as Record<string, unknown>).params as Record<string, unknown>).gate)
      .toBe(false);
  });

  test('D-2 防作弊: 提案 goal 不提评估器代码路径, 且分硬约束/提示两区', () => {
    const goal = (buildNightPlan(OPTS).nodes.propose as Record<string, unknown>).goal as string;
    expect(goal).toContain('## 硬约束');
    expect(goal).toContain('## 提示');
    expect(goal).toContain('candidates.json');
    // 评估器实现不进提案席的视野 (它只该看读数, 不该看打分怎么算的)
    expect(goal).not.toContain('src/eval/replay/fitness.ts');
    expect(goal).not.toContain('src/eval/replay/session-card.ts');
    // 但排除表要告诉它 (不然它会提出改尺子的卡)
    expect(goal).toContain('src/eval/replay/**');
  });
});

// ── INV-6: dry-run 零 LLM ──────────────────────────────────────────────────

describe('dry-run 零 LLM (INV-6 · GWT-6)', () => {
  test('GWT-6: 走完整条 dry-run 路径, gateway.send 调用计数 0', () => {
    // 反向自检: 把 buildNightPlan 换成任何会去调模型的实现 → 本条红。
    const sendSpy = spyOn(gateway, 'send');
    try {
      const out = renderDryRun(buildNightPlan(OPTS), OPTS);
      expect(out).toContain('mine');
      expect(sendSpy).toHaveBeenCalledTimes(0);
    } finally {
      sendSpy.mockRestore();
    }
  });

  test('GWT-6: 真跑 CLI --dry-run —— 7 个节点 id 与 depends_on 链都在, 退出 0', () => {
    const r = spawnSync(
      'bun',
      [join(ROOT, 'scripts', 'autoresearch-night.ts'), '--dry-run', '--date', '2026-09-02'],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    expect(r.status).toBe(0);
    for (const id of NIGHT_STAGE_IDS) expect(r.stdout).toContain(id);
    expect(r.stdout).toContain('depends_on=[card-gate]'); // sessions 那条边
    expect(r.stdout).toContain('timeoutMs=28800000');
  });

  test('参数: --gate-cards 必须配齐 --candidates 与 --out', () => {
    expect(() => parseNightArgs(['--gate-cards', 'r.json'])).toThrow('--candidates');
    expect(() => parseNightArgs(['--gate-cards', 'r.json', '--candidates', 'c.json'])).toThrow('--out');
    expect(parseNightArgs(['--dry-run']).mode).toBe('dry-run');
    expect(parseNightArgs([]).mode).toBe('ignite');
  });
});

// ── D-7: 晨报两半 ──────────────────────────────────────────────────────────

describe('机械附录 (D-7)', () => {
  test('两半不一致以附录为准这条规则由 driver 写, 不靠人记', () => {
    expect(APPENDIX_PRECEDENCE_LINE).toContain('以附录为准');
  });

  test('曲线里的 null 原样印 null, 不印 0 (NULL ≠ 0)', () => {
    const md = renderMechanicalAppendix(
      {
        cards: [
          {
            cardId: 'c1',
            substrate: 'S3',
            stopReason: 'plateau',
            wallMs: 3000,
            curve: [
              { gen: 0, main: null, validity: 0.8 },
              { gen: 1, main: 1.9, validity: null },
            ],
          },
        ],
      },
      { verdicts: [{ cardId: 'c1', verdict: 'held', reason: 'heldout 段下降' }] },
    );
    expect(md).toContain('g0 · null · 0.8');
    expect(md).toContain('g1 · 1.9 · null');
    expect(md).toContain('**held**');
  });

  test('零卡也产附录 (被拦下这件事本身要有记录, D-6 同理)', () => {
    const md = renderMechanicalAppendix({ cards: [], reason: 'no-cards' }, { verdicts: [] });
    expect(md).toContain('no-cards');
    expect(md).toContain('无判词');
  });

  test('results/promotion 都读不到也不炸', () => {
    expect(renderMechanicalAppendix(null, null)).toContain('机械附录');
  });

  test('O3a 段: 有读数印占比/中位/n; 桶空印 null 不印 0; 读数缺席印「无读数」', () => {
    const md = renderMechanicalAppendix(null, null, { date: '2026-09-04', runMeasurable: 58, runShareGt1: 19 / 58, runMedian: 1 });
    expect(md).toContain('speedup>1 占比 32.8% · 中位 1.000 · n=58');
    const empty = renderMechanicalAppendix(null, null, { date: '2026-09-04', runMeasurable: 0, runShareGt1: null, runMedian: null });
    expect(empty).toContain('占比 null · 中位 null · n=0'); // 反向: 把 null 印成 0 → 红
    expect(renderMechanicalAppendix(null, null, null)).toContain('无读数');
  });
});

describe('预登记 (四要素)', () => {
  test('四要素逐条在场, 且预算数取自 opts 不是写死', () => {
    const md = renderPrereg(OPTS);
    expect(md).toContain('单一变量');
    expect(md).toContain('预先声明的成败信号');
    expect(md).toContain('对照基线');
    expect(md).toContain('塌与不塌都记');
    expect(md).toContain('8.0h');
    expect(renderPrereg({ ...OPTS, nightBudgetMinutes: 120 })).toContain('2.0h');
  });
});
