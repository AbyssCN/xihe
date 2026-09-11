/**
 * src/harness/dream/assembly.test.ts —— S6 批级闸/装配层的仓内反向自检。
 *
 * 背景: S6 交付图 (run b6a2edf9) 的批级闸证伪跑在 worktree 的 e2e 驱动里,
 * 该驱动被排除在 patch 外 —— 落进主仓的闸没有会红的测试。本文件按
 * 「一条永远绿的闸不是闸」惯例补上仓内最小承重面 (终审补, 2026-08-10)。
 *
 * ⚠ watermark 路径锚: gather 内部 createWatermark() 默认走
 * `process.env.OMD_MEMORY_PATH ?? '.omd/memory.db'` (进程 cwd), 与 assembly 的
 * `opts.cwd` 不是同一条锚 —— 测试必须显式设 OMD_MEMORY_PATH 指向临时库,
 * 否则会写真仓 memory.db 的 dream_watermark 表 (裂缝已入 NOTES 2026-08-10)。
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDreamAssembly } from './assembly';
import { buildDreamReport, formatDreamReport, groupRejectedByReason } from './report';
import { createRunStore } from '../../mcp/run-store';
import { emitModelUsage } from '../../model/accounting';
import type { ModelRequest, ModelResponse } from '../../model/types';
import type { DreamCandidate } from './validate';

// ---------------------------------------------------------------------------
// fixture: 临时仓 + 一条终态 run (gather 首见完结 → dirty → 1 个 extract-run 叶)
// ---------------------------------------------------------------------------

let tmp: string;
let savedMemoryPath: string | undefined;
let savedDreamModel: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'omd-dream-assembly-'));
  mkdirSync(join(tmp, '.omd'), { recursive: true });
  savedMemoryPath = process.env.OMD_MEMORY_PATH;
  savedDreamModel = process.env.OMD_DREAM_MODEL;
  // watermark 锚进临时库 (见文件头注) —— 不设这行, 测试会污染真仓 memory.db。
  process.env.OMD_MEMORY_PATH = join(tmp, '.omd', 'memory.db');
});

afterEach(() => {
  if (savedMemoryPath === undefined) delete process.env.OMD_MEMORY_PATH;
  else process.env.OMD_MEMORY_PATH = savedMemoryPath;
  if (savedDreamModel === undefined) delete process.env.OMD_DREAM_MODEL;
  else process.env.OMD_DREAM_MODEL = savedDreamModel;
  rmSync(tmp, { recursive: true, force: true });
});

function seedTerminalRun(runId = 'run-fixture-1'): void {
  const store = createRunStore({ path: join(tmp, '.omd', 'runs.db') });
  store.put({
    runId,
    status: 'done',
    goal: '修 reachability 断言并让全量测试通过',
    meta: {},
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:10:00.000Z',
    ownerPid: null,
  });
  store.close();
}

/**
 * fake callModel: 返回 1 条干净 omd.pattern 候选, usage 用价表内座位定价 (成本 > 0)。
 * ⚠ 按 gateway 契约手动 emitModelUsage —— assembly 的账本/成本闸**只**观察 gateway
 * 出口的 emit (账唯一出口纪律), 不 emit 的 fake 会让 $_max 闸与 llmCalls 恒 0 不可测。
 */
function fakeCallModel(): (req: ModelRequest) => Promise<ModelResponse> {
  return async () => {
    const usage = { in: 1000, out: 100 };
    emitModelUsage(usage, 'deepseek:deepseek-v4-pro');
    return {
      parsed: {
        candidates: [
          {
            namespace: 'omd.pattern',
            payload: {
              situation: 'worktree 派单的 oracle 措辞',
              approach: '写「对照主仓基线全量绿」',
              outcome: 'failed',
              scope: 'oracle',
              subject: 'acceptance-command',
            },
          },
        ],
      },
      usage,
      raw: {},
      model: 'deepseek:deepseek-v4-pro',
      attempts: 1,
    } as unknown as ModelResponse;
  };
}

// ---------------------------------------------------------------------------
// 批级闸 (SDD §S6 判据 2) —— 两侧都写
// ---------------------------------------------------------------------------

describe('S6 批级闸', () => {
  // 证伪方式 (当场验过): 把 assembly.ts 的 `totalLLMLeaves > maxLLM` 改成 >=999
  // → 本测试红 (`expect(r.ok).toBe(false)` 收到 true); 恢复后绿。
  test('L_max 反向自检: 上限 0 + 1 个 dirty run 叶 → 整跑 fail, 判词带实际值与上限', async () => {
    seedTerminalRun();
    const r = await runDreamAssembly({
      cwd: tmp,
      runId: 'gate-lmax',
      callModel: fakeCallModel(),
      model: 'test:fake',
      maxLLMLeaves: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.failReason ?? '').toContain('L_max exceeded');
    expect(r.failReason ?? '').toContain('limit 0');
    expect(r.llmCalls).toBe(0); // 前置闸: 一个叶都不许起跑
  });

  // 证伪方式 (当场验过): 把 fake usage 改成 { in: 0, out: 0 } (零成本)
  // → `$_max exceeded` 不触发, 本测试红; 恢复后绿。
  test('$_max 反向自检: 上限 0 + 有价成本 → 整跑 fail, 判词带实际值与上限', async () => {
    seedTerminalRun();
    const r = await runDreamAssembly({
      cwd: tmp,
      runId: 'gate-cost',
      callModel: fakeCallModel(), // usage 按 deepseek-v4-pro 定价, 成本 > 0
      model: 'deepseek:deepseek-v4-pro',
      maxCostUsd: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.failReason ?? '').toContain('$_max exceeded');
    expect(r.failReason ?? '').toContain('limit');
  });

  test('放行侧: 默认上限内正常整跑, ok=true 且 llmCalls 与叶数一致', async () => {
    seedTerminalRun();
    const r = await runDreamAssembly({
      cwd: tmp,
      runId: 'gate-pass',
      callModel: fakeCallModel(),
      model: 'test:fake',
    });
    expect(r.ok).toBe(true);
    expect(r.phases.extractRun).toBe(1);
    expect(r.llmCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// model 显式解析 (S6 N4 #3 裁: 禁静默兜底)
// ---------------------------------------------------------------------------

describe('model 显式解析', () => {
  // 证伪方式 (当场验过): 把 assembly.ts 的 `if (callModel && !resolvedModel) throw`
  // 注释掉 → 本测试红 (resolves 而非 rejects); 恢复后绿。
  test('opts.model 与 OMD_DREAM_MODEL 均缺 → 响亮抛, 不落任何兜底坐标', async () => {
    seedTerminalRun();
    delete process.env.OMD_DREAM_MODEL;
    await expect(
      runDreamAssembly({ cwd: tmp, runId: 'no-model', callModel: fakeCallModel() }),
    ).rejects.toThrow(/model required/);
  });
});

// ---------------------------------------------------------------------------
// 幂等 (SDD §S6 判据 3 的可测半边: 二跑不重写、不重烧)
// ---------------------------------------------------------------------------

describe('幂等', () => {
  test('同数据二跑: 首跑 added=1, 二跑水位转 clean → 零叶零新增', async () => {
    seedTerminalRun();
    const mk = () => ({
      cwd: tmp,
      runId: 'idem',
      callModel: fakeCallModel(),
      model: 'test:fake',
    });
    const r1 = await runDreamAssembly(mk());
    expect(r1.ok).toBe(true);
    expect(r1.added).toBe(1); // 首跑真写入 (恒真防线: 若 0, 说明 fixture 没喂进叶)
    const r2 = await runDreamAssembly(mk());
    expect(r2.ok).toBe(true);
    expect(r2.added).toBe(0);
    expect(r2.llmCalls).toBe(0); // 水位 clean → 叶不重烧
  });
});

// ---------------------------------------------------------------------------
// report 三态列 (S6 N4 #4 裁: NULL ≠ 0, 不补零)
// ---------------------------------------------------------------------------

describe('report 三态列', () => {
  // 证伪方式 (当场验过): 把 report.ts 的 `opts.neverExtracted ?? null` 改回 `?? 0`
  // → 本测试红 (null !== 0); 恢复后绿。
  test('未传三态列 → null (不是 0), format 打印 NULL', () => {
    const r = buildDreamReport({
      runId: 'r',
      gather: { dirtyTotal: 0, sources: [], skippedClean: true },
      merge: { ok: true, added: 0, evolved: 0, replaced: 0, rejected: [], conflictsRaised: 0 },
      promote: { ok: true, promoted: 0, pruned: 0 },
      llmCalls: 0,
      costUsd: 0,
    });
    expect(r.neverExtracted).toBeNull();
    expect(r.extractedThenPruned).toBeNull();
    expect(r.notApplicable).toBeNull();
    expect(formatDreamReport(r)).toContain('NULL');
  });

  test('rejected 按 reason 前缀分组(全串分组会让每条判词自成一组)', () => {
    const stub = {} as DreamCandidate;
    const groups = groupRejectedByReason([
      { candidate: stub, reason: 'statistical-assertion: 平均值' },
      { candidate: stub, reason: 'statistical-assertion: 次数' },
      { candidate: stub, reason: 'provenance: run x not found' },
    ]);
    expect(groups['statistical-assertion:']).toBe(2);
    expect(groups['provenance:']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 分批 + 水位推进 (裁决 12 / 缺陷① 修法, 2026-08-10)
// ---------------------------------------------------------------------------

describe('分批消费与水位推进', () => {
  test('★ batchLeaves=1 + 2 个 dirty run: 三跑吃完 —— 每跑一叶, 水位逐段推进, 末跑 noop', async () => {
    seedTerminalRun('run-a');
    seedTerminalRun('run-b');
    const mk = () => ({ cwd: tmp, runId: 'batch', callModel: fakeCallModel(), model: 'test:fake', batchLeaves: 1 });
    const r1 = await runDreamAssembly(mk());
    expect(r1.ok).toBe(true);
    expect(r1.phases.extractRun).toBe(1); // 只吃一个
    const r2 = await runDreamAssembly(mk());
    expect(r2.ok).toBe(true);
    expect(r2.phases.extractRun).toBe(1); // 吃第二个 (第一个已固化转 clean)
    const r3 = await runDreamAssembly(mk());
    expect(r3.phases.extractRun).toBe(0); // 全固化 → noop
    expect(r3.llmCalls).toBe(0);
  });

  test('★ 失败路径不推进水位: L_max fail 后重跑, 同批源原样 dirty (kill 不沉批)', async () => {
    // 证伪方式 (当场验过): assembly.ts 的 setClean 块去掉 mergeReport.ok 守卫并挪到闸前
    // → 本测试红 (第二跑 extractRun=0); 恢复后绿。
    seedTerminalRun('run-a');
    const failed = await runDreamAssembly({
      cwd: tmp, runId: 'f1', callModel: fakeCallModel(), model: 'test:fake', maxLLMLeaves: 0,
    });
    expect(failed.ok).toBe(false); // 整跑 fail, 零叶起跑
    const retry = await runDreamAssembly({
      cwd: tmp, runId: 'f2', callModel: fakeCallModel(), model: 'test:fake',
    });
    expect(retry.ok).toBe(true);
    expect(retry.phases.extractRun).toBe(1); // 数据没沉, 重跑吃到
  });

  test('无 callModel (机械跑) 不推进水位 —— 叶没真跑, 数据不许被跳过', async () => {
    seedTerminalRun('run-a');
    const dry = await runDreamAssembly({ cwd: tmp, runId: 'd1', model: 'test:fake' });
    expect(dry.ok).toBe(true);
    const real = await runDreamAssembly({ cwd: tmp, runId: 'd2', callModel: fakeCallModel(), model: 'test:fake' });
    expect(real.phases.extractRun).toBe(1); // dry 跑没吃掉它
  });
});
