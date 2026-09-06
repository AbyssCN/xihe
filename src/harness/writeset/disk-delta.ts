/**
 * 盘上改动快照与差集 —— 写集对账的第二条真源 (2026-09-06)。
 *
 * 为什么: `filesTouched` 只记**写工具**报的路径。worker 经 shell 改文件 (`sed -i` / `cat >` / `python - <<EOF`)
 * 一个字都不进 `filesTouched`, 写集对账就把声明文件全记成 missing (code80-m3-pathfix 实测: 路径归一后仍有
 * 17/80 题 missing>0, 全部是 `orphan=[]` + `filesTouched=[]` 这一型), 假事实进判官卷面。
 *
 * 做法: 派发前后各拍一次「git status 列出的文件 → 内容 hash」, 差集 = 这次派发真动过的文件 (改/新建/删)。
 * 与 `filesTouched` 取并集再对账。零 LLM; fail-open 且留 `why` (仓规: 吞异常不吞证据)。
 * `.omd/` 下的一律不收 (引擎自己的留痕库, 与 collectTouchedPaths 同一条纪律)。
 *
 * 证伪: 把 `diskDelta` 里「hash 不同 ⇒ 收」那支去掉 ⇒ disk-delta.test.ts「shell 改文件被收进差集」红。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface DiskSnapshot {
  /** 相对仓根路径 → 内容 sha1 (`deleted` = 文件在 status 里但盘上不在)。 */
  files: Map<string, string>;
  /** 没拍成的原因 (非 git 仓 / git 起不来)。缺席 = 拍成了。 */
  why?: string;
}

export type SpawnLike = (argv: string[], cwd: string) => { exitCode: number | null; stdout: string; stderr: string };

const defaultRun: SpawnLike = (argv, cwd) => {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  return { exitCode: r.exitCode, stdout: new TextDecoder().decode(r.stdout), stderr: new TextDecoder().decode(r.stderr) };
};

function isEngineOwned(rel: string): boolean {
  return rel.split(/[\\/]/)[0] === '.omd';
}

/** 拍一次盘上状态。非 git 仓 / git 失败 ⇒ 空 map + why (fail-open)。 */
export function snapshotDisk(root: string, run: SpawnLike = defaultRun): DiskSnapshot {
  const files = new Map<string, string>();
  let r: ReturnType<SpawnLike>;
  try {
    r = run(['git', 'status', '--porcelain', '--untracked-files=all'], root);
  } catch (err) {
    return { files, why: `git 起不来: ${String(err).slice(0, 160)}` };
  }
  if (r.exitCode !== 0) return { files, why: `git status 退 ${r.exitCode}: ${r.stderr.trim().slice(0, 160) || '(无 stderr)'}` };
  for (const line of r.stdout.split('\n')) {
    if (line.trim().length < 4) continue;
    if (line.startsWith('!!')) continue;
    let rel = line.slice(3);
    if (rel.includes(' -> ')) rel = rel.slice(rel.indexOf(' -> ') + 4);
    rel = rel.replace(/^"|"$/g, '');
    if (!rel || isEngineOwned(rel)) continue;
    const abs = join(root, rel);
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        files.set(rel, 'deleted');
        continue;
      }
      files.set(rel, createHash('sha1').update(readFileSync(abs)).digest('hex'));
    } catch (err) {
      files.set(rel, `unreadable:${String(err).slice(0, 40)}`);
    }
  }
  return { files };
}

/** 两次快照的差集: 新出现 / hash 变了 / 消失了 的路径 (按 after 的顺序, 消失的排最后)。 */
export function diskDelta(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [p, h] of after) if (before.get(p) !== h) out.push(p);
  for (const p of before.keys()) if (!after.has(p)) out.push(p);
  return out;
}
