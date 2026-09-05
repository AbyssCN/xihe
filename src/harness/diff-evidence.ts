/**
 * **判卷卷面的盘上改动段** (D-3, 契约 `docs/plan/2026-09-05-假success三闸-执行契约.md`)。
 *
 * 盘上事实: verifier 收到的卷面 = `task + summarizeResults + truths`, 没有一行 diff, 也不能读
 * 文件。于是一个自述「已完成」的 leaf 能同时过跨模型终审与 rubric 判官两道 —— 两道判官吃的
 * 都是同一份自述。`verifier.ts:141` 那段注释记过同一类教训 (退出码在引擎手里却没递给判官)。
 *
 * 这里取的是**引擎自己跑 git 拿到的事实**, 不是执行体的自述。取不到 (非 git 仓 / git 起不来)
 * 时返回空文本 + 一行 `why` —— 「取不到」与「零改动」靠 `why` 这一列分辨, 不许压成同一格
 * (仓规坑 ①)。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 引擎取到的盘上改动证据。`empty` 为真而 `why` 在场 = 取不到, **不是**零改动。 */
export interface DiffEvidence {
  text: string;
  files: string[];
  empty: boolean;
  truncated: boolean;
  why?: string;
}

/** 总量封顶: 卷面还要装任务与结果正文, diff 不能把它们挤掉。 */
const DEFAULT_MAX_CHARS = 16_000;
/** 单个未跟踪文件进卷面的字符数上限 (跟踪文件走 git diff, 只有增删行)。 */
const DEFAULT_MAX_PER_FILE = 4_000;

function git(root: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const dec = new TextDecoder();
  return { ok: r.exitCode === 0, out: dec.decode(r.stdout), err: dec.decode(r.stderr).trim() };
}

/** porcelain v1 一行 → 相对路径 (重命名取新路径)。 */
function pathOf(line: string): string {
  return line.includes(' -> ') ? line.slice(line.indexOf(' -> ') + 4) : line.slice(3);
}

/**
 * 取 `root` 相对 HEAD 的工作树改动, 渲染成判卷可读的一段文本。
 *
 * `.omd/` 下的改动不进卷面 —— 那是引擎自己的留痕库, 不是交付物, 让它进卷面等于给
 * 「什么都没做」发一份产物证明。
 */
export function renderDiffEvidence(
  root: string,
  opts?: { maxChars?: number; maxPerFile?: number },
): DiffEvidence {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  const maxPerFile = opts?.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  const empty = (why: string): DiffEvidence => ({ text: '', files: [], empty: true, truncated: false, why });

  let status: { ok: boolean; out: string; err: string };
  try {
    status = git(root, ['status', '--porcelain']);
  } catch (err) {
    return empty(`git 起不来: ${String(err).slice(0, 200)}`);
  }
  if (!status.ok) return empty(`git status 失败: ${status.err.slice(0, 200) || '(无 stderr)'}`);

  const lines = status.out.split('\n').filter((l) => l.trim().length > 0);
  const untracked: string[] = [];
  const tracked: string[] = [];
  for (const l of lines) {
    const p = pathOf(l);
    if (!p || p.split(/[\\/]/)[0] === '.omd') continue;
    (l.startsWith('??') ? untracked : tracked).push(p);
  }
  const files = [...tracked, ...untracked];
  if (files.length === 0) return { text: '', files: [], empty: true, truncated: false };

  const parts: string[] = [];
  if (tracked.length > 0) {
    // 无 HEAD (一次提交都没有) 时这条会失败 —— 不掀桌, 跟踪面留一行原因, 未跟踪面照进。
    const d = git(root, ['diff', 'HEAD', '--', ...tracked]);
    if (d.ok && d.out.trim().length > 0) parts.push(d.out);
    else if (!d.ok) parts.push(`(跟踪文件 diff 取不到: ${d.err.slice(0, 200) || '(无 stderr)'})`);
  }
  for (const f of untracked) {
    let body: string;
    try {
      const raw = readFileSync(join(root, f));
      // 二进制不进卷面 (判官读不了一坨字节, 只会把它当噪声或幻觉出内容)。
      body = raw.includes(0) ? '(二进制, 不进卷面)' : raw.toString('utf8').slice(0, maxPerFile);
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据 (仓规静默坑 ②)。
      body = `(读不到: ${String(err).slice(0, 120)})`;
    }
    parts.push(`新文件 ${f}:\n${body}`);
  }

  let text = '';
  let truncated = false;
  for (const p of parts) {
    if (text.length >= maxChars) { truncated = true; break; }
    const room = maxChars - text.length;
    if (p.length + 1 > room) {
      text += `${p.slice(0, room)}`;
      truncated = true;
      break;
    }
    text += text.length === 0 ? p : `\n${p}`;
  }
  // 截断要**说出来**: 判官不知道自己没看全, 就会把"没看见"读成"没有"。
  if (truncated) text += `\n… (证据截断: 总量超过 ${maxChars} 字符, 这一节没看全)`;
  return { text, files, empty: false, truncated };
}
