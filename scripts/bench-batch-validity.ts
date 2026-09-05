#!/usr/bin/env bun
/**
 * scripts/bench-batch-validity —— **批级有效性闸** (D-4, 契约
 * `docs/plan/2026-09-05-假success三闸-执行契约.md`)。
 *
 * 为什么存在: `omd-bridge-code80-oc` 那批 80 题里 39 题的分类调用回 `502 session limit`,
 * 全部退到探索型 —— 该批的任何结论都无效, 而当时没有任何机械件说得出这句话, 于是一批
 * 坏读数被当成读数读了。**基线条件不成立时整批作废**是本仓的既有立场 (仓规: 条件不同,
 * 整个对比作废), 这个脚本只是把它做成一条会红的闸。
 *
 * 用法:
 *   bun run scripts/bench-batch-validity.ts <results-batch-dir>
 *
 * 退出码: 0 = VALID; 1 = INVALID (分类失败占比 > 5%, 或一题都没扫到); 2 = 用法错。
 * 零 LLM、零网络, 纯文件读 —— 判据纯函数 (`countBatchFailures`) 与 IO 壳分开, 测试只打前者。
 */
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

/** 分类失败占比超过这条线, 整批作废。偶发抖动不该让一批作废, 半数退保守档必须。 */
const CLASSIFY_FAIL_THRESHOLD = 0.05;

/** 各计数对应的标记原文 (引擎侧真源: classify-acceptance.ts:711 与 :114)。 */
const MARKERS = {
  /** 分类调用没回来或解析不了 → 全保守档 (complex + 探索型)。 */
  classify: ['分类调用/解析失败', '分类调用或解析失败', '验收分型未成立'],
  sessionLimit: ['session limit'],
  http502: ['502'],
  acceptance: ['验收分型未成立'],
} as const;

export interface BatchValidity {
  total: number;
  classifyFailed: number;
  sessionLimit: number;
  http502: number;
  acceptanceNotEstablished: number;
  valid: boolean;
}

/**
 * 数每种标记命中的**题数** (不是出现次数): 一题里 502 出现 20 次仍只算一题坏了。
 *
 * 四个计数各数各的, **不合并成一个"坏了"** —— 「分类没回来」「座位到上限」「网关 502」
 * 「验收分型没立住」是四件事, 压成一格事后再也分不开是哪种 (仓规坑 ①)。
 * 裁决只看 `classifyFailed`: 它是「这批题的判据轴到底成没成立」的那一列。
 */
export function countBatchFailures(files: readonly { name: string; text: string }[]): BatchValidity {
  const hit = (text: string, pats: readonly string[]): boolean => pats.some((p) => text.includes(p));
  let classifyFailed = 0;
  let sessionLimit = 0;
  let http502 = 0;
  let acceptanceNotEstablished = 0;
  for (const f of files) {
    if (hit(f.text, MARKERS.classify)) classifyFailed++;
    if (hit(f.text, MARKERS.sessionLimit)) sessionLimit++;
    if (hit(f.text, MARKERS.http502)) http502++;
    if (hit(f.text, MARKERS.acceptance)) acceptanceNotEstablished++;
  }
  // 空集不算有效: 一题都没扫到 ≠ 这批没问题 (多半是目录给错了, 那时"VALID"是最坏的答案)。
  const valid = files.length > 0 && classifyFailed / files.length <= CLASSIFY_FAIL_THRESHOLD;
  return { total: files.length, classifyFailed, sessionLimit, http502, acceptanceNotEstablished, valid };
}

/** IO 壳: 扫 `<batchDir>/**\/agent/omd-output.txt`, 读不出的题当空文本 (它自己就是一种坏)。 */
function readBatch(batchDir: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const rel of new Glob('**/agent/omd-output.txt').scanSync({ cwd: batchDir })) {
    let text: string;
    try {
      text = readFileSync(`${batchDir}/${rel}`, 'utf8');
    } catch (e) {
      // fail-open 可以吞异常, 不许吞证据 (仓规静默坑 ②)。
      text = '';
      process.stderr.write(`[bench-batch-validity] 读不出 ${rel}: ${(e as Error).message}\n`);
    }
    out.push({ name: rel, text });
  }
  return out;
}

function pct(n: number, total: number): string {
  return total === 0 ? 'n/a' : `${((n / total) * 100).toFixed(1)}%`;
}

function main(argv: readonly string[]): number {
  const batchDir = argv[2];
  if (!batchDir) {
    process.stderr.write('用法: bun run scripts/bench-batch-validity.ts <results-batch-dir>\n');
    return 2;
  }
  const r = countBatchFailures(readBatch(batchDir));
  process.stdout.write(
    `题数 ${r.total}\n` +
      `分类调用/解析失败 ${r.classifyFailed} (${pct(r.classifyFailed, r.total)})\n` +
      `session limit ${r.sessionLimit} (${pct(r.sessionLimit, r.total)})\n` +
      `502 ${r.http502} (${pct(r.http502, r.total)})\n` +
      `验收分型未成立 ${r.acceptanceNotEstablished} (${pct(r.acceptanceNotEstablished, r.total)})\n` +
      `${r.valid ? 'VALID' : 'INVALID'}\n`,
  );
  return r.valid ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv));
