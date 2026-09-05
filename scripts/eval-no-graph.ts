#!/usr/bin/env bun
/**
 * scripts/eval-no-graph —— r2 no-graph 对照实验运行器(设计
 * docs/plan/2026-08-04-r2-no-graph-baseline-design.md 片2)。
 *
 * 两臂,同任务文本、同座位、同预算面:
 *   **B 臂 (no-graph)** = 单个 agent-leaf 一杆到底(自带工具环 = "Claude Code 式单 agent 长上下文")。
 *   **A 臂 (omd)**     = 默认 f1/f2 走 `dag_run`(conductor 扇出),g1/g2 走 `dag_goal`(solve)——
 *                        经 assembleOmdMcpTools 生产装配,零第二套语义。
 *                        `--engine run|solve` 可脱离这个默认(拆 "档位 × 题型" 混淆,见下)。
 *
 * 作业面:f1 在 `git archive` 导出的快照目录(防翻史抄答案,GWT-R2-4);f2/g1/g2 在本仓只读 +
 * 答案写 out 文件。产物头部记座位行(GWT-R2-1 的 --verify-seats 读它)。
 *
 * 用法:
 *   bun --env-file=.env run scripts/eval-no-graph.ts --task f1 --arm b --pair 1
 *   bun --env-file=.env run scripts/eval-no-graph.ts --verify-seats --task f1 --pair 1
 *   bun --env-file=.env run scripts/eval-no-graph.ts --score --task f1 --pair 1
 *   bun --env-file=.env run scripts/eval-no-graph.ts --task f2 --arm a --engine solve --pair 1   # 补充实验
 *   bun --env-file=.env run scripts/eval-no-graph.ts --score --task f2 --arm a --engine solve --pair 1
 */
import { execSync } from 'node:child_process';
import { readArmVisibleTask } from '../src/eval/tasks/no-graph-baseline/task-text';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT_DIR = '.omd/eval/no-graph-baseline';
const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const task = (opt('task') ?? '') as 'f1' | 'f2' | 'g1' | 'g2';
const arm = (opt('arm') ?? '') as 'a' | 'b';
const pair = Number(opt('pair') ?? '1');
const cwd = process.cwd();
const TASK_DIR = 'src/eval/tasks/no-graph-baseline';

/**
 * A 臂的引擎档位。**原设计把它和任务格绑死了**(F 格→run,G 格→solve)——于是
 * "solve vs run" 与 "封闭题 vs 开放题" 两个变量捆在一起,读数分不清是谁的功劳。
 * `--engine` 就是拆这个混淆用的:同一道题跑两个档位。
 *
 * 非默认档位的产物落**另一套文件名**(`f2-a-solve-1.md`),不覆盖原对照的产物。
 */
type Engine = 'run' | 'solve';
const defaultEngine = (t: string): Engine => (t === 'g1' || t === 'g2' ? 'solve' : 'run');
const engine: Engine = (opt('engine') as Engine | undefined) ?? defaultEngine(task);
/** 文件名里的臂标识: 默认档位保持 `a`/`b` 不变(旧产物不失效), 非默认档位加后缀。 */
const armKey = (a: string): string => (engine === defaultEngine(task) ? a : `${a}-${engine}`);

function outPath(t: string, a: string, p: number): string {
  return join(cwd, OUT_DIR, `${t}-${a}-${p}.md`);
}
function workDirPath(t: string, a: string, p: number): string {
  return join(cwd, OUT_DIR, `${t}-${a}-${p}-work`);
}

/**
 * 答案文件落**仓树之外的每对独立目录**(2026-08-04,查 inputPaths 查出来的真污染)。
 *
 * 老跑 `b3817112`(f2-a-**2**)的 `write_answer` 节点读了 `f2-a-1-answer.md` ——
 * **上一对的答案**。三对本应是独立重复,而至少一对在写自己的答案前看过另一对的。
 * 同一个目录里躺着所有对的答案,一次 `ls` 就全见,这是「上轮产出的载体通道」的教科书形态。
 * 起跑前删本对残留(已有)只堵了自己那条,跨对那条没堵 —— 只堵一条等于没堵。
 *
 * 现在:每对一个 `/tmp` 目录,仓树里不再有任何答案文件。**诚实边界**:这是"不再撞见",
 * 不是"不可能读到"(臂拿得到自己的绝对路径,理论上能猜邻居的)。真隔离要沙箱,那是另一件事。
 * 产物头记 `answerFile:`,评分按它取;老产物回落旧路径(不破既有读数)。
 */
function answerPath(t: string, a: string, p: number): string {
  // 用 $HOME 不用 `tmpdir()`: 后者跟着 TMPDIR 走, 环境一变**历史答案就找不着**,
  // 而找不着会被下游读成 0/8 (实测踩过, 见下面那条缺席判词)。实验归档要住在稳定的地方。
  return join(homedir(), '.omd-eval-answers', `${t}-${a}-${p}`, 'answer.md');
}
/** 评分侧解析: 优先产物头记的路径, 其次新默认, 最后旧的仓内路径 (老产物兼容)。 */
function resolveAnswerPath(head: string, t: string, a: string, p: number): string {
  const declared = /answerFile: (.+)/.exec(head)?.[1]?.trim();
  if (declared && existsSync(declared)) return declared;
  for (const c of [
    answerPath(t, a, p),
    join(tmpdir(), 'omd-eval-answers', `${t}-${a}-${p}`, 'answer.md'), // 2026-08-04 迁移中转位置
    outPath(t, a, p).replace(/\.md$/, '-answer.md'), // 仓内旧位置 (老产物)
  ]) {
    if (existsSync(c)) return c;
  }
  return ''; // 一个都没有 —— 调用方必须把"缺席"和"0 分"分开报 (仓规: NULL ≠ 0 ≠ 不适用)
}

/** f1 作业面: 快照导出 (无 .git)。其余任务: 本仓只读。 */
async function materialize(t: string, a: string, p: number): Promise<{ workCwd: string; taskText: string }> {
  // ⚠ **切掉夹具注记再喂臂** (2026-08-05): 题面里混着给人看的防泄题登记 (答案清单在哪个文件 /
  //   参考答案的 commit hash), 此前整份读进 prompt —— 也就是把答案位置逐字告诉了臂。
  //   切法与闸共用 `armVisibleTaskText`, 各写一份就会出现"闸查切过的、臂拿到没切的"。
  const taskText = readArmVisibleTask(join(cwd, TASK_DIR, `${t}-task.md`));
  if (t === 'f1') {
    const { F1_SNAPSHOT_BEFORE } = await import('../src/eval/tasks/no-graph-baseline/f1-check');
    const d = workDirPath(t, a, p);
    if (!existsSync(join(d, 'client-skills'))) {
      mkdirSync(d, { recursive: true });
      execSync(`git archive ${F1_SNAPSHOT_BEFORE} client-skills | tar -x -C ${d}`, { cwd });
    }
    return { workCwd: d, taskText };
  }
  return { workCwd: cwd, taskText };
}

/** 任务定制的臂内指令 (两臂同文 — 只在这里拼一次)。 */
function armPrompt(t: string, taskText: string, answerFile: string): string {
  if (t === 'f1') return `${taskText}\n\n作业目录就是当前目录 (client-skills/ 在其下)。直接编辑文件完成迁移。`;
  return `${taskText}\n\n把最终回答完整写入文件 ${answerFile} (用文件写入工具创建/覆盖)。仓库文件只读参考。`;
}

async function runArmB(t: string, p: number): Promise<void> {
  const { createAgentLeafRunner } = await import('../src/harness/agent-leaf');
  const { resolveEngineModels } = await import('../src/mcp/assemble');
  const { bootstrapModelRuntime } = await import('../src/model/bootstrap');
  bootstrapModelRuntime();
  const seats = resolveEngineModels(process.env);
  const model = seats.agentLeafModel ?? seats.leafModel;
  const { workCwd, taskText } = await materialize(t, 'b', p);
  const answerFile = answerPath(t, 'b', p);
  mkdirSync(join(answerFile, '..'), { recursive: true });
  rmSync(answerFile, { force: true });
  // **全工具痕迹**(2026-08-04 补): `filesRead` 只认 read/hashline_read 工具 —— agent-leaf 自己的
  // 注就写着「bash 里的 cat 收不到」。而 B 臂实测主要用 bash 读语料, 于是它的 filesRead 是空的,
  // 看起来像"没读文件却答对了"。留痕不全 = 审计是假的, 所以这里挂 onEvent 把**每次工具调用**
  // 的名字与首段参数记下来, 让 B 臂和 A 臂的 inputPaths 对称可查。
  const toolTrace: string[] = [];
  const runner = createAgentLeafRunner({
    cwd: workCwd,
    hashlineEdit: true,
    leafTimeoutMs: 3_600_000,
    onEvent: (e) => {
      // 事件名是 `tool_execution_start` (agent-leaf.ts:540)。第一版我按猜的名字过滤, 结果
      // toolCalls=24 而 trace 空, 判词还印着"零工具调用 = 纯记忆作答" —— **尺子自己在撒谎**。
      // 所以下面那行判词现在拿 r.toolCalls 交叉验: 采集不到与真没调用是两件事。
      if (e.type !== 'tool_execution_start') return;
      const name = String((e as { toolName?: unknown }).toolName ?? '?');
      const args = JSON.stringify((e as { args?: unknown }).args ?? '').slice(0, 140);
      toolTrace.push(`${name}:${args}`);
    },
  });
  const started = Date.now();
  const r = await runner({ prompt: armPrompt(t, taskText, answerFile), model });
  mkdirSync(join(cwd, OUT_DIR), { recursive: true });
  writeFileSync(
    outPath(t, 'b', p),
    `arm: b (no-graph 单 agent)\nseat: ${model}\ntask: ${t} pair: ${p}\nwallMs: ${Date.now() - started}\n` +
      `answerFile: ${answerFile}\n` +
      // **B 臂留痕**(2026-08-04 补的证据链空洞): A 臂每个节点的 checkpoint 记 `inputPaths`,
      // 所以「它读没读过别的跑的答案」查得出来; 而 B 臂是单 agent-leaf 直发、不落 checkpoint ——
      // 此前它读了什么**无从查证**。于是出现过一句很难看的话:「看起来更好的那一臂,
      // 恰好是查不了的那一臂」。runner 本来就返 filesRead, 只是没人记 —— 记下来即可对称审计。
      `filesRead: ${(r.filesRead ?? []).join(' | ') || '(无)'}\n` +
      `filesTouched: ${(r.filesTouched ?? []).join(' | ') || '(无)'}\n` +
      `toolCalls: ${r.toolCalls ?? '?'}\n` +
      // 三态分清 (仓规 NULL ≠ 0 ≠ 不适用): 有痕迹 / 真的零调用 / **调了但没采到**。
      // 最后一种是采集器自己坏了, 绝不能印成"纯记忆作答"。
      `toolTrace: ${
        toolTrace.length
          ? toolTrace.join(' ;; ')
          : (r.toolCalls ?? 0) === 0
            ? '(真零工具调用 = 纯记忆作答)'
            : `(采集失效: toolCalls=${r.toolCalls} 却一条没采到 — 事件名可能又变了, 别把这行读成"没读文件")`
      }\n` +
      `usage: in=${r.usage.in} out=${r.usage.out}\nworkDir: ${workCwd}\n\n---\n\n${r.text.slice(0, 4000)}`,
  );
  console.log(`b 臂完成: ${outPath(t, 'b', p)}`);
}

async function runArmA(t: string, p: number): Promise<void> {
  const { assembleOmdMcpTools } = await import('../src/mcp/assemble');
  const { RunRegistry } = await import('../src/mcp/run-registry');
  const { createRunStore } = await import('../src/mcp/run-store');
  const { resolveEngineModels } = await import('../src/mcp/assemble');
  const { bootstrapModelRuntime } = await import('../src/model/bootstrap');
  bootstrapModelRuntime();
  const seats = resolveEngineModels(process.env);
  const { workCwd, taskText } = await materialize(t, armKey('a'), p);
  const answerFile = answerPath(t, armKey('a'), p);
  mkdirSync(join(answerFile, '..'), { recursive: true });
  // 陈旧产物清场 (2026-08-04 实测污染): pair3 复测的 write 节点发现上一跑的答案文件"已验证"
  // 便不再写, 评分评到了旧引擎的答案 (Langfuse ed4dbe39: "Existing … prior run, 16:50")。
  // 重跑必须从空白开始, 否则"分数"量的是磁盘残留不是本跑。
  rmSync(answerFile, { force: true });
  // 2026-09-05 修: S2 执行进程化 (08-10) 之后 dag_run 在**子进程**里跑, 终态写进 <workCwd>/.omd/runs.db;
  // 一个没有 store 的内存 registry 永远看不到它 —— 实测 f1-a-4 子进程 9 分钟 done, 本脚本等了 3.5 小时。
  // 修法 = 与 assemble.ts:435 同一份构造 (带 store), 轮询走 getRecord ?? ensureFromDisk (与 dag_status 同一条读路)。
  const registry = new RunRegistry(undefined, { store: createRunStore({ path: join(workCwd, '.omd', 'runs.db') }) });
  const tools = assembleOmdMcpTools({ cwd: workCwd, runRegistry: registry });
  const toolName = engine === 'solve' ? 'dag_goal' : 'dag_run';
  const tool = tools.find((x) => x.name === toolName)!;
  const started = Date.now();
  const args = toolName === 'dag_goal'
    ? { goal: armPrompt(t, taskText, answerFile), maxRounds: 2 }
    : { task: armPrompt(t, taskText, answerFile) };
  const res = (await tool.handler(args as never, {} as never)) as { content: { text: string }[]; isError?: boolean };
  const runId = /runId: (\S+)/.exec(res.content[0]?.text ?? '')?.[1];
  if (!runId || res.isError) throw new Error(`A 臂起跑失败: ${res.content[0]?.text}`);
  const TERMINAL = new Set(['done', 'failed', 'cancelled']);
  const statusOf = (): string | null => (registry.getRecord(runId) ?? registry.ensureFromDisk(runId))?.status ?? null;
  for (;;) {
    const st = statusOf();
    if (st && TERMINAL.has(st)) break;
    await Bun.sleep(3000);
  }
  const finalStatus = statusOf();
  mkdirSync(join(cwd, OUT_DIR), { recursive: true });
  writeFileSync(
    outPath(t, armKey('a'), p),
    `arm: ${armKey('a')} (omd ${toolName})\nseat: ${(seats.agentLeafModel ?? seats.leafModel)}\n` +
      `task: ${t} pair: ${p} engine: ${engine}\n` +
      `wallMs: ${Date.now() - started}\nrunId: ${runId}\nstatus: ${finalStatus}\nworkDir: ${workCwd}\n` +
      `answerFile: ${answerFile}\n`,
  );
  console.log(`a 臂完成: ${outPath(t, armKey('a'), p)} (${finalStatus})`);
}

/**
 * 节点健康一行 (2026-08-04 加的第二把尺)。
 *
 * 为什么需要: 产物头里的 `status` 是 **run 生命周期**状态 ("图跑完了"), 不是交付成败 ——
 * 实测 run 6adb28ab 报 `done`, 而它的终端 write 节点 `failed`、交付物是一份 REJECT 判词。
 * 再叠上"磁盘残留旧答案"(已修), 就成了「评分评到上一跑的产物, 而一切读数看起来正常」。
 * 于是分数旁边必须有一列**图自己的健康**, 让「图跑干净但事实答错」与「图塌了」当场分得开。
 *
 * 读 continuity checkpoint (跳过 `__r<K>` 归档 —— 那是旧轮留证, 见 t1)。读不到 → 空串, 不猜。
 */
function nodeHealth(artifactHead: string): string {
  const runId = /runId: (\S+)/.exec(artifactHead)?.[1];
  if (!runId) return '';
  const dir = join(cwd, '.omd', 'continuity', runId);
  if (!existsSync(dir)) return '';
  const tally: Record<string, number> = {};
  try {
    for (const f of readdirSync(dir)) {
      // `_` 前缀 = 引擎日志不是节点 (`_dag` / `_goal` / `_loop-*`); `__r<K>` = 旧轮归档 (t1)。
      // 两者都**不适用**于节点健康 —— 把它们数成 `?` 就是拿"这条不适用"冒充"状态未知",
      // 而 `?` 要留给**真节点 checkpoint 却没有 status** 这一种真异常 (仓规: NULL ≠ 0 ≠ 不适用)。
      if (!f.endsWith('.json') || f.startsWith('_') || /\.__r\d+\.json$/.test(f)) continue;
      const st = (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { status?: string }).status ?? '?';
      tally[st] = (tally[st] ?? 0) + 1;
    }
  } catch {
    return '';
  }
  const parts = Object.entries(tally).sort().map(([k, v]) => `${k} ${v}`);
  return parts.length ? ` · 节点 ${parts.join('/')}` : '';
}

async function score(t: string, p: number): Promise<void> {
  // 显式 --arm = 只评这一个 (补充实验的非默认档位是单臂产物, 没有配对的另一臂)。
  const arms = arm ? [armKey(arm)] : ['a', 'b'];
  for (const a of arms) {
    const head = existsSync(outPath(t, a, p)) ? readFileSync(outPath(t, a, p), 'utf8') : '';
    if (!head) {
      console.log(`${t}-${a}-${p}: 产物缺席`);
      continue;
    }
    if (t === 'f1') {
      const { scoreF1 } = await import('../src/eval/tasks/no-graph-baseline/f1-check');
      const s = scoreF1(workDirPath(t, a, p));
      console.log(`${t}-${a}-${p}: ${s.hit}/${s.total}${s.misses.length ? ` · 首漏 ${s.misses[0]}` : ''}`);
    } else {
      const ansFile = resolveAnswerPath(head, t, a, p);
      if (!ansFile) {
        // **缺席 ≠ 0 分**。此前这里回落去解析产物头, 解析出 0 题 → 报 0/8, 与"答案全错"
        // 读起来一模一样 (本程实测踩过: 归档换了个目录, 三跑齐刷刷 0/8, 差点当成引擎塌了)。
        console.log(`${t}-${a}-${p}: 答案文件缺席 (不是 0 分 — 查过归档/中转/仓内三处)`);
        continue;
      }
      const ans = readFileSync(ansFile, 'utf8');
      const mod = t === 'f2' ? await import('../src/eval/tasks/no-graph-baseline/f2-checklist')
        : t === 'g1' ? await import('../src/eval/tasks/no-graph-baseline/g1-rubric')
        : await import('../src/eval/tasks/no-graph-baseline/g2-registry');
      const s = t === 'f2'
        ? (mod as { scoreF2: (x: Record<string, string>) => { hit: number; total: number; kwHit?: number; srcHit?: number } }).scoreF2(
            Object.fromEntries([...ans.matchAll(/^(q\d+):\s*(.+)$/gm)].map((m) => [m[1]!, m[2]!])),
          )
        : t === 'g1'
          ? (() => { const r = (mod as { scoreG1: (x: string) => { hits: string[]; total: number } }).scoreG1(ans); return { hit: r.hits.length, total: r.total }; })()
          : (() => { const r = (mod as { scoreG2: (x: string) => { hits: string[]; total: number } }).scoreG2(ans); return { hit: r.hits.length, total: r.total }; })();
      // **诊断第二读数** (2026-08-04): 官方分保持严格 —— 任务文本明写 `qN: …`, 违约就是违约,
      // 不因为难看就放宽。但只留一个数会把**两种不同的失败**读成同一种: 一次实测 (pair2,
      // run c042df95) 内容 6/8 正确却因行首用全角 `｜` 官方 0/8。那是"没遵守输出契约",
      // 不是"没找到事实", 而报告要按这两件事分别归因 (格式违约 → 契约/闸问题;
      // 事实缺失 → 检索/综合问题)。故: 宽分隔符只在**严格解析不足 8 题**时作为诊断印出,
      // 明标 `诊断` 二字, 永不替代官方分。
      let diag = '';
      if (t === 'f2') {
        const strictLines = [...ans.matchAll(/^(q\d+):\s*(.+)$/gm)].length;
        if (strictLines < 8) {
          const tolerant = Object.fromEntries(
            [...ans.matchAll(/^(q\d+)\s*[:：｜|]\s*(.+)$/gm)].map((m) => [m[1]!, m[2]!]),
          );
          const st = (mod as { scoreF2: (x: Record<string, string>) => { hit: number; total: number } }).scoreF2(tolerant);
          diag = ` · 诊断(宽分隔符, 非官方): 解析 ${Object.keys(tolerant).length} 题 → 内容 ${st.hit}/${st.total}`;
        }
      }
      // **分项与总分并排印**(2026-08-04): 总分在 n=3 上全在噪声里(同一对同配置两跑差 3 分),
      // 而分项给得出定向信号(出处 0/8→24/24)。判"某次改动有没有效"看分项, 别看总分。
      // 第三维「引文可逐字定位」(2026-08-04 新增尺): 直接查答案里引的那句话在不在它声明的原文里。
      // **老两维读数照旧单独印**, 不合并 —— 新尺必然让数难看, 合并会把"第一次量到旧盲点"
      // 读成"引擎变差了"(仓规: 新增探针后按老段+新增段分开写)。
      let grounded = '';
      if (t === 'f2' && 'scoreF2Grounding' in mod) {
        const g = (mod as { scoreF2Grounding: (a: Record<string, string>, r: (f: string) => string | null) => { hit: number; total: number; noQuote: string[]; notFound: string[]; unreadable: string[] } }).scoreF2Grounding(
          Object.fromEntries([...ans.matchAll(/^(q\d+):\s*(.+)$/gm)].map((m) => [m[1]!, m[2]!])),
          (f) => {
            try {
              return readFileSync(join(cwd, 'docs/reference/agentic-graph-2026-08/raw', f), 'utf8');
            } catch {
              return null; // 读不到 → 该题记 unreadable, 不算命中也不算失败
            }
          },
        );
        grounded = ` · 新尺[逐字可定位 ${g.hit}/${g.total}${g.noQuote.length ? ` · 无引文 ${g.noQuote.length}` : ''}${g.notFound.length ? ` · 引文对不上原文 ${g.notFound.length}` : ''}${g.unreadable.length ? ` · 原文读不到 ${g.unreadable.length}` : ''}]`;
      }
      const d = s as { kwHit?: number; srcHit?: number };
      const dims =
        d.kwHit !== undefined && d.srcHit !== undefined
          ? ` · 分项[出处 ${d.srcHit}/${s.total} · 关键词 ${d.kwHit}/${s.total}]`
          : '';
      console.log(`${t}-${a}-${p}: ${s.hit}/${s.total}${dims}${grounded}${diag}${nodeHealth(head)}`);
    }
  }
}

function verifySeats(t: string, p: number): void {
  const seat = (a: string): string => {
    const m = /seat: (.+)/.exec(readFileSync(outPath(t, a, p), 'utf8'));
    return m?.[1] ?? '(缺)';
  };
  const [sa, sb] = [seat('a'), seat('b')];
  if (sa !== sb) {
    console.error(`✗ 座位不一致 (GWT-R2-1): a=${sa} b=${sb} — 该对作废重跑`);
    process.exit(1);
  }
  console.log(`✓ 座位一致: ${sa}`);
}

if (import.meta.main) {
  if (argv.includes('--verify-seats')) {
    verifySeats(task, pair);
  } else if (argv.includes('--score')) {
    await score(task, pair);
  } else if (arm === 'a') {
    await runArmA(task, pair);
  } else if (arm === 'b') {
    await runArmB(task, pair);
  } else {
    console.error('用法: --task f1|f2|g1|g2 --arm a|b [--pair N] | --verify-seats | --score');
    process.exit(2);
  }
}
