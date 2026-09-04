/**
 * `dag_run` 的 #241 坐标机械校验**接线闸** (2026-09-04)。
 *
 * ## 补的是哪个漏
 *
 * #241 立闸时的实账 run `0f67293b` **就发生在 `run` 这条路上**: `task` 写
 * 「`saveVerdictReasonFull` 在 `checkpoint-manager.ts:312`」, 符号是编的 (真名
 * `saveReasonFull`), 执行体照抄进 `rg -e ...`, 无匹配退 1, `&&` 链首败, 下游 7 节点
 * 全 skipped, 一整跑白烧。而闸当初只加在了 `solve` 的 goal 文本上 —— `checkCoords`
 * 生产端唯一一处 import 在 `goal.ts`, `run` 漏接。本文件钉那根补上的线。
 *
 * ## 判据形状
 *
 * 判定复用 `checkCoords` 同一份实现 (白名单三形状), 所以这里**不重测判定本身**
 * (那是 `coord-check` 自己的 test 的领地), 只测三件接线事:
 *   ① 违规 → 同步拒, 零 spawn (拒了的 run 不许留下子进程);
 *   ② 合法坐标 → 照常 spawn (闸不是恒红);
 *   ③ 两条文本内出口 (「新建」/ `gate-allow`) 在这条路上真的通 —— `run` 没有
 *      `force` 参数, 它们是唯一的出口, 不通就等于把 run 锁死。
 *
 * 反向自检: 把 `dag-tools.ts` 里那个 `#241 坐标机械校验` 块删掉 → ①③ 的拒断言与
 * 零 spawn 断言当场由绿转红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDagTools, type DagEngine } from './dag-tools';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { OmdMcpTool } from '../server';

const neverEngine: DagEngine = {
  runExecutorDag: async () => {
    throw new Error('spawn 路径不该调引擎');
  },
  runExecutorDagWithPlan: async () => {
    throw new Error('spawn 路径不该调引擎');
  },
};

type Spec = { tool: string; runId: string; cwd: string; args: Record<string, unknown> };

function makeRunTool(root: string, specs: Spec[]): OmdMcpTool {
  return createDagTools({
    engine: neverEngine,
    runRegistry: new RunRegistry(),
    defaultConfig: { conductorModel: 'seat:default-c', leafModel: 'seat:default-l' },
    continuity: { manager: new CheckpointManager(root), repoRoot: root },
    spawnDagExec: (spec) => {
      specs.push(spec as Spec);
      return { ok: true as const, pid: 4242, logPath: '/tmp/fake-exec.log' };
    },
  }).find((t) => t.name === 'dag_run')!;
}

const call = (tool: OmdMcpTool, args: Record<string, unknown>) =>
  (tool.handler as (a: Record<string, unknown>, e?: unknown) => unknown)(args, {}) as Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;

/** 每个 test 一个真临时仓 (坐标闸要读真盘, 替身读不出「文件不存在」这条判据)。 */
function withRepo(fn: (root: string, specs: Spec[], tool: OmdMcpTool) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-run-coord-'));
    try {
      writeFileSync(join(root, 'real.ts'), 'export const saveReasonFull = 1;\n');
      const specs: Spec[] = [];
      await fn(root, specs, makeRunTool(root, specs));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('dag_run — #241 坐标机械校验接线', () => {
  test(
    '① task 提到不存在的 `path:line` → 同步拒, 零 spawn',
    withRepo(async (_root, specs, tool) => {
      const r = await call(tool, { task: '修 `src/checkpoint-manager.ts:312` 那处映射', leafModel: 'p:m' });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('#241 坐标机械校验');
      expect(r.content[0]!.text).toContain('src/checkpoint-manager.ts');
      // 拒了的 run 不许留下子进程 —— 与 solve 侧「零 worker 进程」同一条纪律。
      expect(specs).toHaveLength(0);
    }),
  );

  test(
    '① 同句标识符不在该文件里 (0f67293b 的原形状) → 拒',
    withRepo(async (_root, specs, tool) => {
      const r = await call(tool, { task: '`saveVerdictReasonFull` 在 `real.ts:1`', leafModel: 'p:m' });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('saveVerdictReasonFull');
      expect(specs).toHaveLength(0);
    }),
  );

  test(
    '② 坐标真实 → 照常 spawn (闸不是恒红)',
    withRepo(async (_root, specs, tool) => {
      const r = await call(tool, { task: '`saveReasonFull` 在 `real.ts:1`, 改它', leafModel: 'p:m' });
      expect(r.isError).toBeFalsy();
      expect(specs).toHaveLength(1);
    }),
  );

  test(
    '② 判不了的散文碎片不误报 (#265 那 8/8 的教训)',
    withRepo(async (_root, specs, tool) => {
      const r = await call(tool, { task: '把 `、` 和 `26 + 30` 这类写法统一一下', leafModel: 'p:m' });
      expect(r.isError).toBeFalsy();
      expect(specs).toHaveLength(1);
    }),
  );

  test(
    '③ 出口一: 同句写「新建」→ 放行 (run 没有 force, 文本内出口是唯一的)',
    withRepo(async (_root, specs, tool) => {
      const r = await call(tool, { task: '新建 `src/brand-new.ts:1` 放新逻辑', leafModel: 'p:m' });
      expect(r.isError).toBeFalsy();
      expect(specs).toHaveLength(1);
    }),
  );

  test(
    '③ 出口二: 同行 `gate-allow(coord-check): <理由>` → 放行',
    withRepo(async (_root, specs, tool) => {
      const r = await call(tool, {
        task: '照 `src/nowhere.ts:9` 的老写法重做 gate-allow(coord-check): 这是已删文件的历史引用, 不是要去改它',
        leafModel: 'p:m',
      });
      expect(r.isError).toBeFalsy();
      expect(specs).toHaveLength(1);
    }),
  );

  test(
    '③ 空理由的 gate-allow 不生效 (豁免要留证据, 不是消音开关)',
    withRepo(async (_root, specs, tool) => {
      const r = await call(tool, { task: '改 `src/nowhere.ts:9` gate-allow(coord-check):', leafModel: 'p:m' });
      expect(r.isError).toBe(true);
      expect(specs).toHaveLength(0);
    }),
  );
});
