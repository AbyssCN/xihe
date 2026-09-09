/**
 * scripts/path-code-sync —— 「代码落地了, 票没收尾」的对账跑者(CI + 本地共用入口)。
 *
 * 判据核在 `src/harness/pathfinder/code-sync.ts`(纯函数, 有常驻 bun test + 反向自检);
 * 本脚本只做两件 IO: 从 git 抓 main 的主题行、从 gh 抓票现状, 然后把核的判词打出来。
 *
 * 退出码:
 *   - 0 = 无硬漂移(可能仍打了若干条提示 —— 提示不判红, 见核文件的「两类漂移强度不同」);
 *   - 1 = 有 `closed-not-delivered` 硬漂移(CLOSED 的 task/prototype 票缺 `path:delivered`,
 *         后果是它会被 `readyRegion` 重新编进下一次 `map_deliver` 的 slice 再跑一遍)。
 *
 * 用法:
 *   bun scripts/path-code-sync.ts              # 扫 main 最近 200 笔
 *   bun scripts/path-code-sync.ts --since=60   # 扫最近 60 笔
 */
import { spawnSync } from 'node:child_process';
import {
  type CommitClaim,
  type IssueState,
  formatDrift,
  parseSubjectClaims,
  reconcileCodeAndTickets,
} from '../src/harness/pathfinder/code-sync';

const cwd = process.cwd();
const sinceArg = process.argv.find((a) => a.startsWith('--since='));
const limit = sinceArg ? Number(sinceArg.slice('--since='.length)) : 200;

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}: ${r.stderr?.trim()}`);
  return r.stdout;
}

// ── main 的提交主题行 → 认领的票号 ─────────────────────────────────────────────
// 只读主题行(`%s`), 不读正文 —— 正文里的 `#N` 是"相关"不是"这一笔做了它"(核文件有实证)。
const log = run('git', ['log', `-${limit}`, '--format=%h%x09%s', 'main']);
const commits: CommitClaim[] = [];
for (const line of log.split('\n')) {
  if (!line.trim()) continue;
  const [sha, ...rest] = line.split('\t');
  const subject = rest.join('\t');
  const issues = parseSubjectClaims(subject);
  if (issues.length > 0) commits.push({ sha: sha!, subject, issues });
}

// ── gh 上所有票的现状 ─────────────────────────────────────────────────────────
const raw = run('gh', ['issue', 'list', '--limit', '500', '--state', 'all', '--json', 'number,state,labels']);
const rawIssues = JSON.parse(raw) as { number: number; state: string; labels: { name: string }[] }[];

// 每张票所属地图的开闭态: 退役图上的票没有重跑风险(listMaps 用 --state open), 不该硬报。
// 一次 GraphQL 抓所有 map 的子票号 —— map 数是个位数, 这里不做分页。
const mapNumbers = rawIssues.filter((i) => i.labels.some((l) => l.name === 'path:map')).map((i) => i.number);
const mapStateOfTicket = new Map<number, 'OPEN' | 'CLOSED'>();
for (const m of mapNumbers) {
  const q = `query { repository(owner:"${process.env.OMD_GH_OWNER ?? 'AbyssCN'}", name:"${process.env.OMD_GH_REPO ?? 'oh-my-dag-dev'}") { issue(number:${m}) { state subIssues(first:100){nodes{number}} } } }`;
  try {
    const res = JSON.parse(run('gh', ['api', 'graphql', '-f', `query=${q}`])) as {
      data: { repository: { issue: { state: string; subIssues: { nodes: { number: number }[] } } | null } };
    };
    const iss = res.data.repository.issue;
    if (!iss) continue;
    const state = iss.state === 'CLOSED' ? 'CLOSED' : 'OPEN';
    for (const n of iss.subIssues.nodes) mapStateOfTicket.set(n.number, state);
  } catch (err) {
    // fail-open 不吞证据: 抓不到就让这批票的 mapState 留 undefined(= 按 OPEN 处理, 宁可多报)。
    console.error(`[path-code-sync] ⚠ 图 #${m} 的子票抓取失败, 其票按图态未知处理: ${String(err)}`);
  }
}

const issues: IssueState[] = rawIssues.map((i) => {
  const mapState = mapStateOfTicket.get(i.number);
  return {
    number: i.number,
    state: i.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    labels: i.labels.map((l) => l.name),
    ...(mapState ? { mapState } : {}),
  };
});

console.log(`[path-code-sync] main 最近 ${limit} 笔里 ${commits.length} 笔认领了票; gh 上 ${issues.length} 张 issue`);

const drift = reconcileCodeAndTickets(commits, issues);
const errors = drift.filter((d) => d.severity === 'error');
const warns = drift.filter((d) => d.severity === 'warn');

for (const d of errors) console.error(`[path-code-sync] ✗ ${formatDrift(d)}`);
for (const d of warns) console.log(`[path-code-sync] ⚠ ${formatDrift(d)}`);

if (errors.length > 0) {
  console.error(`[path-code-sync] ${errors.length} 条硬漂移 —— 这些票会被重跑, 先补 path:delivered。`);
  process.exit(1);
}
console.log(`[path-code-sync] 无硬漂移${warns.length > 0 ? ` (${warns.length} 条提示待人扫)` : ''}`);
