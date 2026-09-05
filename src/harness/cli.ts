#!/usr/bin/env bun
/**
 * omd CLI 入口 —— 两个子命令, 零 UI。
 *
 *   omd mcp     # stdio MCP server (**主入口**: Claude Code 等 MCP 客户端 spawn 它)
 *   omd init    # 首次配置向导 (纯 readline, 写 .env)
 *
 * ## 切片 6 (2026-09-05) — registry 接线
 *
 * 注册表驱动的命令 (`status` / `map add` / `doctor` / `call` 等 36 + 1 条) 走
 * `dispatchCli()` 单点编排: 装配 → 找 handler → 调 → 渲染 → 退出码。
 * 既有子命令 (`mcp` / `tui` / `serve` / `init` / `touch` / `touches` / `gc` / `pack`
 * / `config dump` / `config verify-seats` / `plan --dry-run` / `run --fixture` /
 * `solve`) 行为与退出码一字不变,`findCommand` 对含 `--fixture` 的 run 与对 `solve`
 * 返回 undefined,让旧路接管。
 *
 * ⚠ `init` 分支不能删: 没有它, 用户配置 omd 的唯一办法是手改 JSON/.env。
 *   `init/` 是纯 readline 向导, **不依赖 pi-coding-agent** (已核)。
 *
 * ## 名字 (2026-08-02 从 `tui.ts` 改过来)
 *
 * 砍完 TUI 的那一轮我把文件名留作 `tui.ts`, 理由写的是「`bin` 指着它, 改名等于改发布契约」——
 * **那条理由是错的**: 发布契约是 `bin` 的**键**(`omd` / `oh-my-dag`, 用户敲的就是这个),
 * 值只是仓内路径, 换个路径对已安装的用户完全不可见。于是这里没有契约问题, 只有一个
 * 叫 `tui.ts` 却删光了 TUI 的文件 —— 本轮改名 `cli.ts`, 同目录, 相对 import 一个没动。
 */
import '../env-alias';
import { randomUUID } from 'node:crypto';
import { setCoreLogger } from './logger';
import { logger, setLoggerDestination } from '../logger';
import {
  CLI_COMMANDS,
  findCommand,
  parseGenericArgs,
  renderUsage,
  type CliCommand,
} from './cli/registry';
import { invokeTool, parseRunIdFromText, renderContentText, waitForRun, type InvokeToolEntry } from './cli/invoke';
import { defaultSolveSpawn, solveWorkerScriptPath, type SolveSpawn, type SolveSpawnHandle } from './cli-solve';
import {
  collectDoctorInput,
  diagnose,
  renderDoctor,
} from './hooks/doctor';

// 核心引擎 logger 接缝: 把宿主 pino 注入 pi-agent-core 的 console-shell (INV-X3, 结构化日志)。
setCoreLogger(logger);

const userArgs = process.argv.slice(2);

/** 切片 6: dispatchCli 返回值 —— 不在内部 process.exit,把出口给 cli.ts 主进程。 */
export interface DispatchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 切片 6: dispatchCli 注入面 —— 测试密封 Bun.spawn / lazy 装配 / 真起 bwrap。 */
export interface DispatchDeps {
  /** registry-driven 命令走 invokeTool 时的替身 tools(测试用 fixture,生产省略)。 */
  tools?: readonly InvokeToolEntry[];
  /** run --detached 的 spawn 替身。 */
  runSpawn?: SolveSpawn;
  /** doctor 的 input 收集替身。 */
  collectDoctorInput?: typeof collectDoctorInput;
}

/** USAGE 头: 既有手写段保留在前(GWT-5 / INV-5 既有子命令零变化)。 */
const USAGE_HEAD = `omd —— DAG 执行引擎 (纯 MCP + web 控制面 + S1 静态闸)

  omd tui     交互式 conductor 前端 (自建 TUI)
  omd mcp     stdio MCP server (给 Claude Code 等 MCP 客户端 spawn)
  omd serve   web 控制台 daemon —— 引擎 API + conductor 对话 (127.0.0.1:4517; --port N 改端口)
  omd init    首次配置向导 (写 .env)
  omd touch <path> --op read|write [--hash <h>] --session <id>   碰撞台账写面 (SDD S3 只记不拦; 锚 cwd 的 git toplevel/.omd/touch.db)
  omd touches [--pairs|--findings]   碰撞台账查询面 (pairs 与 findings 分开读)
  omd config dump   打印本仓生效配置全叠加结果 (座位/渠道/池/MCP/ext, 每值标来源层 + 结构化 issues)
  omd config verify-seats   座位家族校验闸 (I-14): verifier/judge/review/review-spec 须与被审座位异族; 异族 exit 0, 同族 exit 1 (违规行逐字 stderr)
  omd plan --dry-run [--fixture <plan.json>] [--skill <dir>]   静态闸编译流水 (S1): plan JSON 从 stdin 或 --fixture 收; 诊断按 <code> <name>: <evidence> 逐行写 stderr; 全绿 stdout 单行 JSON exit 0; PP-INV exit 2, PP-INT exit 3
  omd run --fixture <dir>   fixture 装载 + PostLeafGate 三态 (S1, D-C): 只含 command leaf, 零模型调用; 节点终态 VERIFIED/FAILED/UNVERIFIED + run 摘要 (<dir>/run-summary.json); UNVERIFIED 逐行 stdout node=<id> state=UNVERIFIED ...
  omd solve "<goal>" [flags]   headless autonomous run (bench/CI 入口面, E1a);spawn scripts/goal-worker.ts 后台跑,退出码按 resultOut 首部 outcome 机械映射 (delivered=0, 其它=2, 缺失=3)
  omd pack add <本地目录|git URL> | remove <name> | list   数据插件包 (agents/playbooks/skills; 装包过质量闸, 账在 .omd/packs.json)

`;

/** USAGE 尾: 与原文件一致的"裸 omd 不直接进 TUI"声明。 */
const USAGE_TAIL = `终端对话前端: 原 pi TUI 2026-08-01 撤除, 2026-08-07 以自建 TUI 回归。

裸 omd 打印本用法, 不直接进 TUI。
`;

/** USAGE = 既有手写段 + registry 表生成的命名命令段。SDD 切片 6 D-1/USAGE-by-table。 */
const USAGE = `${USAGE_HEAD}${renderUsage(CLI_COMMANDS)}\n\n${USAGE_TAIL}`;

// ─── 切片 6 dispatchCli ───────────────────────────────────────────────────────
//
// 编排函数 = 「registry 优先 → legacy 落空」。返 null = 不归 dispatch 管,
// cli.ts 主进程接着走 mcp/tui/serve/... 既有分支。
//
// 三条铁律:
//   · 内部不 process.exit —— 把出口码返回,由 cli.ts 主进程透传。
//   · 内部不动 process.argv / process.stdout / process.stderr —— 也不读。
//     测试要注入 IO 必须通过 deps。
//
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 切片 6 GWT-5 / GWT-7 / GWT-8 / D-2 / D-6 单点编排。
 *
 * 1. `--help` / `-h` / `help` / 空 → USAGE + exit 0
 * 2. 未知命令 → USAGE 走 stderr + exit 1 (错误路径不污染 stdout)
 * 3. `findCommand` 命中 → 走对应路径(invoke / doctor / call / run --detached)
 * 4. 不命中 → 返回 null(legacy 接管:mcp/tui/serve/init/touch/runs gc/...
 *    /config dump/config verify-seats/plan --dry-run/run --fixture/solve/pack)
 *
 * @returns `DispatchResult` = 命中的出口;`null` = 未命中,让 cli.ts 走 legacy。
 */
export async function dispatchCli(
  args: string[],
  deps: DispatchDeps = {},
): Promise<DispatchResult | null> {
  if (args.length === 0) return { exitCode: 0, stdout: USAGE, stderr: '' };
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    return { exitCode: 0, stdout: USAGE, stderr: '' };
  }

  const matched = findCommand(args);
  if (matched) {
    return await dispatchMatched(matched.cmd, matched.rest, deps);
  }

  // 未命中 (含未知命令与 `solve` / `run --fixture` 等保留给 legacy 的路径) →
  // 返回 null,让 cli.ts 主进程走 legacy else (未知 → stderr USAGE + exit 1)。
  // findCommand 已对 solve 与 run --fixture 返 undefined,见 registry.ts:194。
  return null;
}

/** findCommand 命中后的分派:doctor / call / run --detached 各自一条专用路,余下走 invokeTool。 */
async function dispatchMatched(
  cmd: CliCommand,
  rest: string[],
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const head = cmd.path[0];
  if (head === 'doctor') return dispatchDoctor(rest, deps);
  if (head === 'call') return dispatchCall(rest, deps);
  if (head === 'run' && rest.includes('--detached')) {
    return dispatchRunDetached(cmd, rest, deps);
  }
  return dispatchInvoke(cmd, rest, deps);
}

/** GWT-4 / INV-3 / INV-4:命名命令 → invokeTool。
 *  `--json` 是 CLI 出口信号(控 stdout = JSON 还是人读),不进 handler。 */
async function dispatchInvoke(
  cmd: CliCommand,
  rest: string[],
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const json = rest.includes('--json');
  const restNoJson = rest.filter((a) => a !== '--json');
  let parsed: Record<string, unknown>;
  try {
    parsed = cmd.argv(restNoJson);
  } catch (e) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `omd ${cmd.path.join(' ')}: ${(e as Error).message}\n`,
    };
  }
  if (!cmd.tool) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `omd ${cmd.path.join(' ')}: 命令未注册 tool (与 registry 漂移?)\n`,
    };
  }
  const result = await invokeTool({
    tool: cmd.tool,
    args: parsed,
    json,
    ...(deps.tools ? { tools: deps.tools } : {}),
  });
  // D-4 (Aalto 验收修 2026-09-05): run / run-plan / resume 起跑即返回 runId, 引擎在本进程后台跑,
  // CLI 一退引擎就死 → 非 detached 必须等到终态, 再把终态摘要接在 runId 后面。退出码按终态:
  // done → 0, failed / cancelled → 2 (与 isError 同档: 调用形态对, 活没成)。
  const head = cmd.path[0];
  if (result.exitCode === 0 && (head === 'run' || head === 'run-plan' || head === 'resume')) {
    const runId = parseRunIdFromText(result.stdout);
    if (runId) {
      const final = await waitForRun(runId, deps.tools ? { tools: deps.tools } : {});
      if (final !== undefined) {
        const text = renderContentText(final);
        const st = /^status:\s*(\w+)/m.exec(text)?.[1];
        const exitCode = st === 'done' ? 0 : 2;
        return { exitCode, stdout: `${result.stdout}\n${json ? JSON.stringify(final) : text}`, stderr: result.stderr };
      }
    }
  }
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** D-2:`omd call <tool> [--json "<obj>"] | [--key value …]` 通用逃生口。
 *  第一个位置参是 tool 名,余项走 `parseGenericArgs`(--json 整体 / --key value)。 */
async function dispatchCall(
  rest: string[],
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const toolName = rest[0];
  if (!toolName || toolName.startsWith('--')) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `omd call: 用法: omd call <tool> [--json "<obj>"] | [--key value ...]\n`,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseGenericArgs(rest.slice(1));
  } catch (e) {
    return { exitCode: 1, stdout: '', stderr: `omd call: ${(e as Error).message}\n` };
  }
  const json = rest.slice(1).includes('--json');
  const result = await invokeTool({
    tool: toolName,
    args: parsed,
    json,
    ...(deps.tools ? { tools: deps.tools } : {}),
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** GWT-7:`omd doctor [repo]` —— collectDoctorInput → diagnose → renderDoctor。
 *  repo 缺省 = process.cwd();test 注入 collectDoctorInput 不真起 bwrap。 */
async function dispatchDoctor(
  rest: string[],
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const repoRoot =
    rest[0] && !rest[0].startsWith('--') ? rest[0] : process.cwd();
  const collect = deps.collectDoctorInput ?? collectDoctorInput;
  const input = await collect(repoRoot);
  const problems = diagnose(input);
  const { text, exitCode } = renderDoctor(problems);
  return { exitCode, stdout: text, stderr: '' };
}

/** D-6:`omd run <task> --detached` —— spawn worker(`--tool run --args-json '<...>'`)。
 *  spawn cmd 与 cli-solve 的 detached 路径同形态(`--run-id` 由 worker 自产 / stdio ignore / unref);
 *  worker 拿到 args-json 就调同名 `run` handler,handler 走引擎 fire-and-forget,worker 等终态。
 *  `--detached` 与 `--run-id` 是 CLI 编排信号,不进 args-json(单一路,与 cli-solve 同款)。 */
async function dispatchRunDetached(
  cmd: CliCommand,
  rest: string[],
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const restNoDetached = rest.filter((a) => a !== '--detached');
  let parsed: Record<string, unknown>;
  try {
    parsed = cmd.argv(restNoDetached);
  } catch (e) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `omd run: ${(e as Error).message}\n`,
    };
  }
  const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : process.cwd();
  // --run-id 是 worker 自身产物 (randomUUID),不二次塞进 args-json;`detached` 同理。
  delete parsed.runId;
  delete parsed.detached;
  const runId = randomUUID();
  const spawn = deps.runSpawn ?? defaultSolveSpawn;
  const workerCmd = [
    'bun',
    'run',
    solveWorkerScriptPath(),
    '--run-id', runId,
    '--cwd', cwd,
    // GWT-6: 显式带 --tool (worker 默认 dag_goal,但 spawn 那行明写以便 grep/审计)。
    // 与 cli-solve 的 detached 路径同款 —— 一致性是双 spawn 不漂的底线。
    '--tool', 'run',
    '--args-json', JSON.stringify(parsed),
  ];
  let handle: SolveSpawnHandle;
  try {
    handle = spawn(workerCmd, {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
  } catch (e) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `omd run (--detached) spawn failed: ${(e as Error).message}\n`,
    };
  }
  handle.unref?.();
  return { exitCode: 0, stdout: `runId: ${runId}\n`, stderr: '' };
}

// ─── 切片 6 主流程 ────────────────────────────────────────────────────────────
//
// 顺序:dispatchCli 优先 → 命中返 DispatchResult → 写 stdout/stderr + process.exit;
// 未命中(null)走 legacy 分支。
//
// ⚠ import.meta.main 守护: 测试 (dispatch.test.ts) import 本模块只取 dispatchCli,
// 跑 import 时这段不执行; 只有 `bun src/harness/cli.ts` 真作为入口时跑。
// ──────────────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const dispatchResult = await dispatchCli(userArgs);
  if (dispatchResult !== null) {
    if (dispatchResult.stdout) process.stdout.write(dispatchResult.stdout);
    if (dispatchResult.stderr) process.stderr.write(dispatchResult.stderr);
    process.exit(dispatchResult.exitCode);
  }

// omd mcp: stdio MCP server 入口 (D-1) —— 零 UI, 不进 wizard。
// stdout 是 MCP 协议通道: pino 默认写 stdout 会腐蚀协议帧 → 日志改道 stderr (warn 级, 引擎尸检可见)。
// 常驻, 客户端管 spawn/kill (D-9)。工具面 = assembleOmdMcpTools 全装配。
if (userArgs[0] === 'mcp') {
  setLoggerDestination(2);
  logger.level = 'warn';
  // mcp 入口不走任何 boot → provider 注册需自带引导 (同 dag-* 短命进程), 否则引擎 leaf 因
  // 注册表空而全部静默秒败 (settle(null) 空 output, 客户端只见"节点未完成")。stderr 打点协议安全。
  const { bootstrapModelRuntime } = await import('../model/bootstrap');
  bootstrapModelRuntime();
  // 客户端技能自装 (best-effort, 从不抛): 装了 omd MCP 的用户新会话即得 /omd-* 斜杠命令, 免手 cp。
  // 幂等 + 不覆盖用户改过的; opt-out OMD_INSTALL_SKILLS=0。stderr 记一行 (stdout 是协议通道, 不可污)。
  // ⚠ 装的是 `client-skills/` (Claude Code 侧那套), **不是**已删的 TUI `skills/`。
  try {
    const { installClientSkills, formatInstallSummary } = await import('./client-skills-install');
    const line = formatInstallSummary(installClientSkills());
    if (line) logger.warn(line);
  } catch (e) {
    // fail-open 不吞证据: 客户端技能自装失败不影响 MCP server 启动, 但失败原因要落 stderr。
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, '[omd/mcp] installClientSkills failed (non-fatal)');
  }
  // S1 判据 1 (SDD 2026-08-09 远程指挥接缝): MCP 路的调用也要进账本。emitModelUsage 是观察者
  // 钩子, 无订阅者 = 逐条通知进真空 —— 此前只有 tui 分支订阅, mcp 分支零订阅, 于是这条生产
  // 路径上「账本有本轮 usage」结构性不可能 (「机制在、生产零生效」形态, seat-wiring 同族)。
  // 账本复用 tui 那份 (.omd/tui-usage.jsonl): 一个仓一本账, 两本账才分不清。source 由 emit 侧
  // 第三参带 (2026-08-09): 对话轮 emit 'chat', gateway callModel emit 'engine' —— 订阅侧照抄,
  // 不再自己编一个恒定标签 (那样两类调用在账上分不开)。
  const { createTuiUsageLedger } = await import('../tui/usage/ledger');
  const { observeModelUsage } = await import('../model/accounting');
  const { join: joinPath } = await import('node:path');
  const mcpUsage = createTuiUsageLedger({ dir: process.env.OMD_TUI_USAGE_DIR || joinPath(process.cwd(), '.omd') });
  observeModelUsage((u, model, origin) => mcpUsage.record(u, model, origin));
  const { runOmdMcpServer } = await import('../mcp/server');
  const { assembleOmdMcpTools } = await import('../mcp/assemble');
  const { loadExtTools } = await import('./ext-tools');
  await runOmdMcpServer(assembleOmdMcpTools({ extTools: await loadExtTools(process.cwd()) }));
  process.exit(0);
}

// omd tui: 自建交互前端 (TUI SDD 切片 S2 —— 目前只有 UI 壳, 引擎后端 S10 才接)。
// ⚠ 动态 import: TUI 那一坨 (pi-tui + 组件树) 不进 mcp/serve 两条常驻路径的内存。
if (userArgs[0] === 'tui') {
  const cwd = process.cwd();
  // S3 日志改道 —— **必须在 runOmdTui 之前**。TUI 独占终端, stdout 与 stderr 都会花屏,
  // 所以这里不是 mcp 那样的 setLoggerDestination(2), 而是整程改到文件 (src/tui/logging.ts)。
  const { redirectTuiLogs } = await import('../tui/logging');
  const tuiLog = redirectTuiLogs({ cwd });
  logger.info({ file: tuiLog.path }, '[omd/tui] 日志改道生效, 本程日志不进终端');
  try {
    const { runOmdTui } = await import('../tui/tui');

    // L3 接缝 (SDD §9): PTY lane 要证明 UI 循环通, 但**不能**因此去打真模型。
    // 只有显式设了这个环境变量才装 fixture; 它自报家门 (footer 上写着 fixture://l3-test)。
    let backend: import('../tui/backend').OmdBackend;
    // 扩展加载结果要传给 UI(设置面板), 所以声明在 if/else 之外。
    let extStatus: { name: string; ok: boolean; sandboxed?: boolean; missing?: string[] }[] = [];
    // D3 `/reload`: 重载入口同样跨 if/else —— fixture 那条 lane 没有扩展宿主, 于是**不给**
    // 这个键(TUI 那边就画「这条 backend 没有这个能力」, 不画一个点了没反应的命令)。
    let reloadExtensions: (() => Promise<import('../tui/ext/session').ExtReloadResult>) | undefined;
    // 2026-08-13 owner 裁: 审批闸删了, 默认 yolo。安全 = **围栏 + 黑名单** 两层, 都不打断人。
    // 这里只探一次 bwrap 起不起得来 —— 起不来是**降级裸跑 + 顶栏红字**, 不是静默。
    const { loadSandboxConfig } = await import('./hooks/command-policy');
    const { probeShellSandbox } = await import('./hooks/shell-sandbox');
    const sandboxCfg = loadSandboxConfig(cwd);
    const sandboxStatus = sandboxCfg.enabled ? probeShellSandbox() : { ok: false, reason: 'disabled in .omd/config.json (tui.sandbox.enabled=false)' };
    // 切片②: 调用账本。**两侧统一走 emitModelUsage 钩子** —— gateway 的 callModel 与对话轮
    // (`runChatTurn` 逐条 emit) 都从这一个订阅进账, 来源由 emit 侧第三参带。
    // ⚠ 2026-08-09 修: 此前 chat 轮由 backend 在轮末**再补记一笔合计**, 而 8-07 起 agent.ts
    // 已经逐条 emit —— 同一轮记两遍 (生产账本上留下 10 对 in/out 相同、相差 1-5ms 的孪生行)。
    const { createTuiUsageLedger } = await import('../tui/usage/ledger');
    const { observeModelUsage } = await import('../model/accounting');
    const { join: joinPath } = await import('node:path');
    // OMD_TUI_USAGE_DIR: 测试接缝 —— PTY lane 的 fixture 记账不许污染真仓的 5h 窗口。
    const usage = createTuiUsageLedger({ dir: process.env.OMD_TUI_USAGE_DIR || joinPath(cwd, '.omd') });
    observeModelUsage((u, model, origin) => usage.record(u, model, origin));
    /**
     * `ask_user` 要的 UI(对话框宿主 / 主题 / 记录口)—— **延迟指针**。
     *
     * 声明在**分支之外**:填它的 `runOmdTui` 在分支外调用, 而用它的工具面装在
     * 非 fixture 分支里。⚠ fixture 分支不装对话位工具面, 所以那条路上它恒为 null ——
     * 那是对的:那条 lane 本来就没有 `ask_user`。
     */
    let askUserUi: import('../tui/tools/ask-user').AskUserUi | null = null;
    if (process.env.OMD_TUI_BACKEND === 'fixture') {
      const { createFixtureBackend } = await import('../tui/backend-fixture');
      backend = createFixtureBackend({ usage });
    } else {
      // 与 `omd serve` 同一条路: 同一个 runChatTurn、同一批 chatTools、同一条座位解析。
      const { bootstrapModelRuntime } = await import('../model/bootstrap');
      bootstrapModelRuntime(); // 不引导则注册表空, 一句话都发不出去
      const { assembleOmdMcpTools, resolveEngineModels } = await import('../mcp/assemble');
      const { createChatSeatTools } = await import('../tui/tools/chat-seat');
      // S15a 扩展宿主: 每个扩展一个子进程 (bwrap 在就沙箱)。**加载期硬失败** ——
      // 碰了没实现的 API 就拒绝并逐条列出, 不半残地跑起来。
      // D3 `/reload`(2026-08-11): 持有者住在 `tui/ext/session.ts` —— 重载要动的那份状态
      // (当前活着的子进程)此前长在这个内联块里, 谁都够不着。装配这一段只剩两句。
      const { createExtSession } = await import('../tui/ext/session');
      const extSession = createExtSession(cwd);
      // 加载结果**也要给 UI** —— 被拒的缺什么, 藏在日志里等于加载期硬失败白做了。
      const { tools: extTools, status: st } = await extSession.load();
      const { createOmdSessionStore } = await import('./chat/session-store');
      const { createEmbeddedBackend } = await import('../tui/backend-embedded');
      // ⚠ 先有工具面才有 backend (工具要交给 runChatTurn), 而节点事件要灌回 backend ——
      // 所以这里用一个**延迟指针**接环, 不是循环依赖。装配完成前引擎不可能发事件。
      let sink: { pushDagEvent(runId: string, e: unknown): void } | null = null;
      const { loadExtTools } = await import('./ext-tools');
      const tools = assembleOmdMcpTools({ onNodeEvent: (runId, e) => sink?.pushDagEvent(runId, e), extTools: await loadExtTools(cwd) });
      // ⚠ **不传 memory** (owner 2026-08-18): 传了 = `agent.ts` 挂 `transformContext`,
      // 每一轮请求前自动召回一次。实测读数 (`~/.omd/recall-events.jsonl` 当天 8 次注入,
      // 每次 hits:1, 屏上重复同一条) 与 memory-hub 每-prompt 注入被关掉 (NOTES.md M1,
      // 2026-08-18) 是同一条判据: **召回按需调, 不每轮塞**。对话位的 `memory_recall` 工具
      // 仍在工具面里 (`serve/chat-tools.ts`), 模型想查随时能查; 写记忆照旧不给对话位。
      // 顺带修掉一处不一致: SDK 通道本就不吃 `transformContext` —— 此前同一个 TUI 换个座位
      // 就换一套隐性上下文 (pi 座每轮有召回, claude-code 座一次都没有)。
      // D-8: 工具面与 backend **共用同一个 store 实例** —— 两个实例写同一份会话文件会写出
      // 重复 seq, 而下一次 open() 直接抛 non-consecutive seq (见 session-store 的单写者注)。
      const chatStore = createOmdSessionStore(cwd);
      const embedded = createEmbeddedBackend({
        cwd,
        store: chatStore,
        // S-4: 对话位的工具面(含六只手)。装配在 `tui/tools/chat-seat`, 那里有闸盯着 ——
        // 长在这个内联块里的话, "对话位到底拿到了哪些工具"没有任何测试看得见(坑 #7 同族)。
        // 切片①: 审批闸包住整个工具面; 六只手的内层危险命令闸随之交给 admin 档 (闸永远有一层)。
        // ★ `ask_user`(2026-08-08):UI 走**惰性取** —— 工具面装在 TUI 之前, 那时 dialogs
        //   还不存在(同上面那个"延迟指针接环"的理由)。`runOmdTui` 起来后把它填上。
        tools: createChatSeatTools({ cwd, mcpTools: tools, extTools, sandbox: sandboxCfg, askUser: () => askUserUi, store: chatStore }),
        // 多个扩展**串起来**追加(串接在 session 里, 每轮现取当前扩展)。
        // ⚠ 钩子**无条件挂**: 挂不挂此前按启动那一刻的扩展数决定, 而 `/reload` 能把
        //   0 个变成 N 个 —— 按启动数决定的话, 空仓里装上第一个扩展再重载, 工具进来了
        //   但 `before_agent_start` 永远不跑, 而且没有任何症状。零扩展时它原样返回。
        systemPromptHook: (p0: string) => extSession.systemPromptHook(p0),
        // S14: UI 自己直调 dag_runs / dag_resume (不经模型)。给了才有那两个能力。
        mcpTools: tools,
        // 座位每轮现解 (INV-MODEL-3): omd_set_role / `/seat` 改完, 下一句就换座。
        resolveModel: () => resolveEngineModels(process.env).conductorModel,
        // ⚠ 不传 usage: chat 轮的账走上面那条 observeModelUsage 订阅 (agent.ts 逐条 emit)。
      });
      extStatus = st;
      reloadExtensions = () => extSession.reload();
      sink = embedded;
      backend = embedded;
    }
    await runOmdTui({
      backend,
      cwd,
      sandbox: sandboxStatus,
      usage,
      // 延迟指针的另一端:UI 就绪即填, `ask_user` 从此问得出来。
      onUi: (ui) => {
        askUserUi = ui;
      },
      ...(extStatus.length > 0 ? { extensions: extStatus } : {}),
      ...(reloadExtensions ? { reloadExtensions } : {}),
    });
  } catch (err) {
    // S-4b: 起不来的时候说人话。**实测撞出来的** —— 空仓里跑 `omd tui`, 第一屏是
    // `role-models.ts:433` 的行号和 `^` 指针(座位是逐仓配的, 所以除了 omd 自己这个仓,
    // 任何仓第一次跑都会撞上)。抛得对, 但那不是给人看的第一屏。原话原样带着, 只加一层翻译。
    const { formatBootFailure } = await import('../tui/boot');
    process.stderr.write(formatBootFailure(err, cwd));
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[omd/tui] 启动失败');
    process.exitCode = 1;
  } finally {
    tuiLog.close();
  }
  // ⚠ 不能写死 0:上面的 catch 刚把 exitCode 设成 1, 写死会把它盖掉 ——
  //   症状是"报了错但退出码是成功", 脚本里就再也判不出起没起来。
  process.exit(process.exitCode ?? 0);
}

// omd serve: web 控制台 daemon —— 与 mcp 同一装配面 (一个控制面, 两个传输), 外加读侧磁盘契约 + chat。
// 长驻进程, 不挂 stdio 自杀双保险 (那是 MCP 进程的设计; serve 由用户 Ctrl-C / kill 管生命周期)。
if (userArgs[0] === 'serve') {
  setLoggerDestination(2);
  const { bootstrapModelRuntime } = await import('../model/bootstrap');
  bootstrapModelRuntime(); // 同 mcp 入口: 不引导则 leaf 因注册表空而静默秒败
  const { assembleOmdMcpTools, resolveEngineModels } = await import('../mcp/assemble');
  const { createConductorChatTools } = await import('../serve/chat-tools');
  const { startDaemon } = await import('../serve/daemon');
  const { createOmdSessionStore } = await import('./chat/session-store');
  const { createPlanLedger } = await import('./plan/plan-ledger');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const cwd = process.cwd();
  const { loadExtTools } = await import('./ext-tools');
  const tools = assembleOmdMcpTools({ extTools: await loadExtTools(cwd) });
  const portFlag = userArgs.indexOf('--port');
  const staticDir = join(cwd, 'web', 'dist');
  startDaemon(
    {
      cwd,
      tools,
      chatStore: createOmdSessionStore(cwd),
      ledger: createPlanLedger({ path: join(cwd, '.omd', 'plan-ledger.db') }),
      // conductor 座每请求现解 (INV-MODEL-3): omd_set_role 改完, 下一句 chat 就换座。
      resolveChatModel: () => resolveEngineModels(process.env).conductorModel,
      chatTools: createConductorChatTools(tools),
      ...(existsSync(staticDir) ? { staticDir } : {}),
    },
    { ...(portFlag >= 0 && userArgs[portFlag + 1] ? { port: Number(userArgs[portFlag + 1]) } : {}) },
  );
  // Bun.serve 常驻 —— 不 process.exit; SIGINT 默认行为即优雅退。
} else if (userArgs[0] === 'touch') {
  await runTouch(userArgs.slice(1));
  process.exit(process.exitCode ?? 0);
} else if (userArgs[0] === 'touches') {
  await runTouches(userArgs.slice(1));
  process.exit(process.exitCode ?? 0);
} else if (userArgs[0] === 'runs' && userArgs[1] === 'gc') {
  // #252 run worktree 生命周期回收。**缺省 dry-run** —— 要真删必须显式 --apply。
  // 实装在 scripts/ 而不是 src/: 它只在人手里跑, 且放 src/ 会让 seam 目录的「触及文件数」漂
  // (scanConsumers 扫整个 src/), 白白给每个契约添一笔登记面账。
  const {
    survey,
    realDeps,
    apply: applyGc,
    realSpillDeps,
    sweepSpillFiles,
    formatSpillReport,
  } = await import('../../scripts/runs-gc');
  const root = process.cwd();
  const plan = survey(root, realDeps(root));
  const doApply = userArgs.includes('--apply');
  for (const it of plan) {
    if (!doApply) {
      console.log(`${it.runId.slice(0, 8)} [${it.category}] ${it.action}`);
      continue;
    }
    const r = applyGc(root, it);
    if (it.category !== 'live' && it.category !== 'too-fresh' && it.category !== 'too-young') {
      console.log(`${it.runId.slice(0, 8)} [${it.category}] ${r.ok ? '✓' : '✗'} ${r.note}`);
    }
  }
  // HUD 分片归档 (2026-09-02, src/hud/gc.ts): 与 worktree 回收同一把开关 —— 缺省只报数, --apply 才挪。
  {
    const { readTerminalRunIds, sweepHudSnapshots } = await import('../hud/gc');
    const hud = sweepHudSnapshots(root, Date.now(), { terminalRunIds: readTerminalRunIds(root), dryRun: !doApply });
    const by: Record<string, number> = {};
    for (const a of hud.archived) by[a.reason] = (by[a.reason] ?? 0) + 1;
    console.log(`hud 分片: 扫 ${hud.scanned} · ${doApply ? '已归档' : '待归档'} ${hud.archived.length} ${JSON.stringify(by)}${hud.failed.length ? ` · 失败 ${hud.failed.length}` : ''}`);
  }
  // 溢出文件回收 (2026-09-02, scripts/runs-gc.ts 尾节): `.omd/tool-result-*.txt` 与
  // `.omd/bash-output-*.log` 与 worktree / HUD 分片共用同一把 --apply 开关 —— 缺省只报数。
  // 判据不是「关联 run 是否终态」(文件名里没有 runId), 换成年龄 + 在飞 run 起跑下限, 理由见实装头注。
  {
    const spill = sweepSpillFiles(realSpillDeps(root), { dryRun: !doApply });
    console.log(formatSpillReport(spill, doApply));
    for (const f of spill.failed) console.log(`  ✗ ${f.file}: ${f.note}`);
  }
  if (!doApply) console.log('\n(dry-run。要真干: omd runs gc --apply)');
  process.exit(0);
} else if (userArgs[0] === 'pack') {
  // A3 数据插件包: 装/卸/列。质量闸在 addPack 内 (staging 世界全校验, 拒绝零残留)。
  const { addPack, removePack, listPacks } = await import('./pack/pack');
  const sub = userArgs[1];
  const arg = userArgs[2];
  const r =
    sub === 'add' && arg
      ? await addPack(process.cwd(), arg)
      : sub === 'remove' && arg
        ? removePack(process.cwd(), arg)
        : sub === 'list'
          ? listPacks(process.cwd())
          : { ok: false, message: '用法: omd pack add <本地目录|git URL> | remove <name> | list' };
  (r.ok ? process.stdout : process.stderr).write(`${r.message}\n`);
  process.exit(r.ok ? 0 : 1);
} else if (userArgs[0] === 'config' && userArgs[1] === 'dump') {
  // C3 (dsh --dump-config 的可见性承诺): 打印生效配置全叠加, 每值标来源层。
  // 与 mcp/tui 同款引导: 不 bootstrap 的话 provider 注册表是空的, dump 出来全是假"未配"。
  const { bootstrapModelRuntime } = await import('../model/bootstrap');
  bootstrapModelRuntime();
  const { renderConfigDump } = await import('./config-dump');
  process.stdout.write(`${renderConfigDump({ cwd: process.cwd() })}\n`);
  process.exit(0);
} else if (userArgs[0] === 'config' && userArgs[1] === 'verify-seats') {
  // S1 I-14: 座位家族校验闸 (CLI 端 = 启动期 fail-fast 闸的同款断言)。
  // 异族 → 每对一行 stdout (seat=... generator=... ... match=false) 并 exit 0;
  // 同族 → 同款 stdout + stderr 逐字回显违规行 (match=true) 并 exit 1; PP-INT 异常 exit 3。
  await runVerifySeats();
} else if (userArgs[0] === 'plan' && userArgs[1] === '--dry-run') {
  // stdout 是单行 JSON 协议通道 (INV-21) —— 引擎日志一律改道 stderr, 同 mcp 分支的纪律。
  setLoggerDestination(2);
  // S1 C-5 / INV-21: plan --dry-run。stdin 或 --fixture <path> 收 plan JSON, --skill <dir> 挂 skill。
  // 诊断按 <code> <name>: <evidence> 逐行写 stderr (每行末尾换行); 全绿 stdout 单行 JSON exit 0, 任一 error/escalate exit 1。
  // PP-INV (input_missing) → exit 2; PP-INT (未捕获 harness 异常) → exit 3。
  await runPlanDryRunCLI(userArgs.slice(2));
} else if (userArgs[0] === 'run') {
  // run --fixture 的 stdout 是逐行状态协议 (INV-22) —— 日志同样改道 stderr。
  setLoggerDestination(2);
  // S1 C-5 / INV-22 / D-C: run --fixture <dir>。fixture plan 只含 command leaf (零模型调用),
  // 真跑命令 + PostLeafGate 三态 (VERIFIED/FAILED/UNVERIFIED) 落到节点终态 + run 摘要 (<dir>/run-summary.json),
  // UNVERIFIED 逐行 stdout `node=<id> state=UNVERIFIED ...`; 运行完成 exit 0, 中途 (plan 读不到 / 写盘失败) exit 1。
  await runWithFixture(userArgs.slice(1));
} else if (userArgs[0] === 'init') {
  await runInit();
} else if (userArgs[0] === 'solve') {
  // E1a (bench 容器入口面):headless CLI 子命令,编排在 cli-solve.ts —— 零第二套语义,
  // 唯一执行通路 = spawn scripts/goal-worker.ts。退出码按 resultOut 首部 outcome 机械映射。
  const { runSolveCLI } = await import('./cli-solve');
  process.exit(await runSolveCLI(userArgs.slice(1)));
} else {
  // 显式求助 (--help/-h/help) 是成功路径: usage 走 stdout + exit 0 (CLI 惯例;
  // 2026-08-26 实测 bench adapter 用 `omd --help` 探活, exit 1 会把好挂载判成坏)。
  // 其余未知参照旧: usage 走 stderr + exit 1 (错误路径);裸 `omd` 打用法 exit 0。
  const help = userArgs[0] === '--help' || userArgs[0] === '-h' || userArgs[0] === 'help';
  if (help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  process.stderr.write(USAGE);
  process.exit(userArgs.length === 0 ? 0 : 1);
}

// omd init: 首次配置向导。wizard 写 .env, 配完即退出 (用户再正常起 MCP server)。
async function runInit(): Promise<void> {
  // headless/CI (无 TTY) 进不了交互 wizard (readline 会 hang) → fail-fast 提示, 别挂死。
  if (!process.stdin.isTTY) {
    logger.error('[omd/init] 非交互终端 — 请在终端跑 `omd init`, 或直接照 .env.example 填 .env');
    process.exit(1);
  }
  const { runInitWizard, createReadlineIO } = await import('./init');
  const ok = await runInitWizard({ io: createReadlineIO() });
  process.exit(ok ? 0 : 1);
}

// omd touch / omd touches 的 helper —— SDD S3 碰撞台账写入面 (只记不拦, 第一刀; jcode 总账 §6.1)。
// 锚定 (总账 §3.6 已裁): 台账锚 **cwd 的 git toplevel** (找不到就 cwd) 下的 `.omd/touch.db`;
// ⚠ 不用 omdRepoRoot() 的 worktree→主仓归并 —— 隔离档下两个 worktree 各写各的, 不算撞。
// fail-open 不吞证据: 台账读写失败 → logger.warn 留痕, CLI 不因此崩 (记录失败 ≠ 工具失败)。

/** 台账锚点 = cwd 的 git toplevel, 找不到 → cwd。判据与 project-scope 同一条 git 调用 (不新抄一份)。 */
async function touchLedgerRoot(): Promise<string> {
  const { gitToplevel } = await import('./project-scope');
  return gitToplevel(process.cwd()) ?? process.cwd();
}

/** 取 `--name <v>` 的 v; 缺 flag 或缺值 → undefined。 */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * 写面: `omd touch <path> --op read|write [--hash <h>] --session <id>`。
 * 参数错误 = 用法错误 (exit 1); 台账自身失败 = fail-open (warn 留痕 + exit 0 —— hook 链路上
 * 工具调用已成功, 记录失败不能反过来把工具判失败)。
 */
async function runTouch(args: string[]): Promise<void> {
  const pathArg = args[0];
  const op = flagValue(args, '--op');
  const session = flagValue(args, '--session');
  const hash = flagValue(args, '--hash');
  if (!pathArg || !op || !session) {
    process.stderr.write('用法: omd touch <path> --op read|write [--hash <h>] --session <id>\n');
    process.exitCode = 1;
    return;
  }
  if (op !== 'read' && op !== 'write') {
    process.stderr.write(`--op 必须是 read 或 write, 收到: ${op}\n`);
    process.exitCode = 1;
    return;
  }
  const root = await touchLedgerRoot();
  const { resolve } = await import('node:path');
  const absPath = resolve(process.cwd(), pathArg);
  try {
  const { openTouchLedger } = await import('./writeset/touch-ledger');
  const ledger = openTouchLedger({ root });
  // hash 缺省落 NULL (没算 hash ≠ 空串, NULL≠0 纪律) —— 这里不传 ''。
  // ledger.recordTouch 自带 fail-open (内部 warn 留痕), ts 由 ledger 自己打, 调用方不传。
  ledger.recordTouch({ path: absPath, session, op, hash: hash ?? null, source: 'cli' });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), root, absPath, session, op },
      '[omd/touch] 台账记录失败 (fail-open: 不阻断调用, 证据留 warn)',
    );
  }
}

/**
 * 查询面: `omd touches [--pairs|--findings]`。pairs 与 findings 分开读、分开打印;
 * 无 flag = 两个都打 (长期 0 也是读数, SDD §1-S3)。
 *
 * ⚠ **恒先印一行库级自述** (#253 收尾): 写型 run 默认落隔离 worktree 之后, 主树这本库的
 *   pairs/findings 会长期是 0 —— 而「没撞」与「台账没接上」在 0 上长得一样。那一行给的是
 *   分辨它俩的判据 (库里有没有近期行), 所以它**不受 --pairs/--findings 影响**: 只看碰撞数
 *   而不知道库是不是活的, 正是这个出口此前读不出成因的原因。
 */
async function runTouches(args: string[]): Promise<void> {
  const wantPairs = args.includes('--pairs');
  const wantFindings = args.includes('--findings');
  const showPairs = wantPairs || (!wantPairs && !wantFindings);
  const showFindings = wantFindings || (!wantPairs && !wantFindings);
  const root = await touchLedgerRoot();
  try {
  const { openTouchLedger } = await import('./writeset/touch-ledger');
  const ledger = openTouchLedger({ root });
  const st = ledger.stats();
  // 档位不靠猜: 隔离树恒在 `<主仓>/.omd/runs/<runId>` (runWorktreeDir 的约定), 路径即判据。
  // 判不出来的 (别人手建的 worktree / 跨仓) 就说"主树或未知", 不编一个确定的答案。
  const { sep } = await import('node:path');
  const treeKind = root.includes(`${sep}.omd${sep}runs${sep}`) ? '隔离 worktree' : '主工作树(或未知)';
  process.stdout.write(
    `ledger: root=${root} (${treeKind}) · rows=${st.rows} · sessions=${st.sessions} · ` +
      `write=${st.writeRows}/read=${st.readRows} · source strict=${st.bySource.strict}/inferred=${st.bySource.inferred}/cli=${st.bySource.cli} · ` +
      `last=${st.lastTs === undefined ? '(缺席: 这本库一条都没记)' : new Date(st.lastTs).toISOString()}\n`,
  );
  if (st.rows === 0) {
    process.stdout.write(
      '  ⚠ 库里零行 → 下面的 0 **不是"零碰撞"**, 是"这本库没在记"。先查接线, 别当健康读数。\n',
    );
  }
  if (showPairs) {
    const pairs = ledger.crossSessionPairs();
    process.stdout.write(`pairs (${pairs.length}):\n`);
    for (const p of pairs) process.stdout.write(`  ${JSON.stringify(p)}\n`);
  }
  if (showFindings) {
    const fs = ledger.findings();
    process.stdout.write(`findings (${fs.length}):\n`);
    for (const f of fs) process.stdout.write(`  ${JSON.stringify(f)}\n`);
  }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), root },
      '[omd/touches] 台账读取失败 (fail-open: 不崩, 证据留 warn)',
    );
  }
}

// ─── S1 命令面 (plan --dry-run / run --fixture / config verify-seats) ────────────
//
// 三条分支对应的判据 (S1 接口契约 §1.10 + docs/plan/2026-08-24-conductor-s1-五闸与清单-执行契约.md C-5):
//   · plan --dry-run (INV-21)         — 静态编译, 零运行时, 全绿 exit 0
//   · run --fixture (INV-22 / D-C)    — fixture 真跑 + PostLeafGate 三态落摘要
//   · config verify-seats (INV-23 / I-14) — 同族即 throw, 异族打印并 exit 0
//
// 它们共享的纪律:
//   1. **不改既有子命令一个字节** —— 上面 4 条 if/else-if 都新增, 不动原 if 块体。
//   2. **诊断格式 = INV-21 字面**: `<code> <check>: <evidence>`, 末尾 \n, 全部走 stderr。
//   3. **fail-open 不吞证据**: 读 fixture 失败 / 写 summary 失败都进 stderr + 退码标记,
//      但 stderr 一行错误不阻断其它节点的执行 (一个节点挂不掉整图)。
//   4. **零模型调用**: command leaf 经 Bun.spawn 直跑命令; verify-seats 走 modelFamily
//      比 coord, 不发任何 API; plan dry-run 调既有 runPlanDryRun (它本身零 LLM)。

/**
 * 取 stdin 全文 (用于 plan --dry-run 无 --fixture 时)。readFileSync(0) 在 pipe 关闭时
 * 自然终止; 无 pipe (TTY) → readFileSync 立刻抛, 这里 catch 转用法错误。
 */
async function readStdinText(): Promise<string> {
  const { readFileSync } = await import('node:fs');
  try {
    return readFileSync(0, 'utf8');
  } catch (e) {
    throw new Error(`stdin 读取失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * S1 C-5 / INV-21: `omd plan --dry-run` CLI 入口。
 *
 * 调用形态 (S1 接口契约 §1.10, 验收测试 spawn 照它对):
 *   omd plan --dry-run [--fixture <path>] [--skill <dir>]
 *     · --fixture <path> : plan JSON 从文件读
 *     · --skill <dir>    : 挂 skill 目录 (单数, 可选)
 *     · 都不给           : plan JSON 从 stdin 读
 *
 * 行为契约: 调 runPlanDryRun(opts={emit:true}) → runPlanDryRun 自身在 emit=true 时把单行
 * JSON (schema_version / verdict / diagnostics / resolvedToolRefs / toolPoolByNode / criticRounds)
 * 写 stdout → CLI 不二次包装。stderrLines 逐行透传 stderr (INV-21: `<code> <name>: <evidence>`)。
 *
 * 退出码: 0 = 全绿, 1 = 任一 error/escalate (runPlanDryRun.exitCode 原样透传)。
 * PP-INV input_missing (缺 --fixture 且 stdin 空 / 读不到) → exit 2。
 * PP-INT unhandled (runPlanDryRun 抛未捕获 harness 异常) → exit 3。
 * stderr 与诊断行原样透传, 不二次包装 human-friendly 文本 (诊断行可能被脚本断言)。
 */
async function runPlanDryRunCLI(args: string[]): Promise<void> {
  const fixturePath = flagValue(args, '--fixture');
  const skillDir = flagValue(args, '--skill');
  const { runPlanDryRun } = await import('./plan-dry-run');

  let input: import('./plan-dry-run').RunPlanDryRunInput;
  try {
    if (fixturePath) {
      input = { kind: 'fixture', fixturePath };
    } else {
      const planText = await readStdinText();
      if (!planText.trim()) {
        // PP-INV input_missing — S1 退出码契约: 用法/输入错 = exit 2。诊断行逐字 (不二次包装)。
        process.stderr.write('PP-INV input_missing: --fixture <path> or stdin JSON required\n');
        process.exit(2);
      }
      input = { kind: 'text', planText };
    }
  } catch {
    // stdin 读不到 (无 pipe / 立即 EOF / OS 错) 等价于 input_missing, 同一出口 (不暴露技术细节)。
    process.stderr.write('PP-INV input_missing: --fixture <path> or stdin JSON required\n');
    process.exit(2);
  }

  // emit:true → runPlanDryRun 内部在 emit=true 时写 stdout 单行 JSON (S1 I/O 契约);
  // CLI 不二次包装也不拦截 —— 子过程的 stdout 原样流出。
  const opts: import('./plan-dry-run').RunPlanDryRunOpts = {
    emit: true,
    ...(skillDir ? { skillDir } : {}),
  };
  let r: import('./plan-dry-run').RunPlanDryRunResult;
  try {
    r = await runPlanDryRun(input, opts);
  } catch (e) {
    // PP-INT unhandled — S1 退出码契约: 未捕获 harness 异常 = exit 3。
    process.stderr.write(`PP-INT unhandled: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(3);
  }

  // 诊断逐行写 stderr (INV-21: <code> <name>: <evidence>) —— 透传, 不二次包装。
  for (const line of r.stderrLines) {
    process.stderr.write(`${line}\n`);
  }
  // 退出码透传: 0=全绿, 1=任一 error/escalate。runPlanDryRun 内部已完成 exitCode 决策。
  process.exit(r.exitCode);
}

/**
 * S1 C-5 / INV-23 / I-14: `omd config verify-seats` CLI 入口。
 *
 * 调用形态:
 *   omd config verify-seats
 *
 * 行为契约 (S1 I/O 契约 §1.10 + I-14):
 *   · 调 verifySeats (纯函数版, 不读盘不打印) 拿到 checks 列表
 *   · 每对 (verifier vs generator) stdout 写一行:
 *       seat=<verifierId> generator=<genId> generator.family=<family> verifier.family=<family> match=<true|false>
 *     match=false = 异族 (好); match=true = 同族 (坏, 判与证共享盲点)
 *   · 全部 match=false → exit 0
 *   · 任一 match=true  → exit 1, 同款行 (match=true) 逐字 stderr 回显 (违规可脚本抓)
 *   · PP-INT (未捕获 harness 异常) → exit 3
 *
 * 没配的 tier='verify' 座位由 verify-seats.ts 自身跳过 ("没配" ≠ "配错了"),
 * 与 seat-conformance 同源判据; 此处 tryResolveSeatModel 把未配留 undefined。
 */
async function runVerifySeats(): Promise<void> {
  const { tryResolveSeatModel } = await import('../model/role-models');
  const { ALL_SEAT_IDS } = await import('../model/seats');
  const { verifySeats } = await import('./verify-seats');

  // 用未配座位跳过同源判据: tryResolveSeatModel (未配 → undefined), 不抛 (verify-seats.ts:87-89)。
  const coords: Record<string, string | undefined> = {};
  for (const seat of ALL_SEAT_IDS) {
    const r = tryResolveSeatModel(seat, { env: process.env });
    if (r) coords[seat] = r.model;
  }

  let result: import('./verify-seats').VerifySeatsResult;
  try {
    result = verifySeats(coords);
  } catch (e) {
    process.stderr.write(`PP-INT unhandled: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(3);
  }

  // 每对 stdout 一行 (S1 契约); 行内顺序固定 = seat → generator → gen.family → ver.family → match。
  for (const c of result.checks) {
    const match = c.ok ? 'false' : 'true';
    process.stdout.write(
      `seat=${c.verifier.seatId} generator=${c.generator.seatId} ` +
      `generator.family=${c.generator.family} verifier.family=${c.verifier.family} ` +
      `match=${match}\n`,
    );
  }
  if (!result.ok) {
    // 任一同族: exit 1, stderr 逐字回显违规行 (S1 stderr 原样透传纪律 —— 与 stdout 同款行, 不二次包装)。
    for (const c of result.checks) {
      if (!c.ok) {
        process.stderr.write(
          `seat=${c.verifier.seatId} generator=${c.generator.seatId} ` +
          `generator.family=${c.generator.family} verifier.family=${c.verifier.family} ` +
          `match=true\n`,
        );
      }
    }
    process.exit(1);
  }
  process.exit(0);
}

/**
 * S1 C-5 / INV-22 / D-C: `omd run --fixture <dir>` CLI 入口。
 *
 * 调用形态 (验收测试 spawn 照它):
 *   omd run --fixture <dir>
 *
 * 行为契约 (F19 + I-9, 终态枚举逐字):
 *   · 读 <dir>/plan.json (内含 nodes; 只 executor:'command' 的节点真跑, 零模型)
 *   · 对每个 command leaf:
 *       - 真跑命令 (Bun.spawn, 零 LLM)
 *       - 找对应 gate 脚本: <dir>/checks/<nodeId>.sh (约定), 或 plan 节点上 `gate_script` 字段显式指
 *       - 调 evaluatePostLeaf: 拿到 OK/FAIL/UNVERIFIED + 异常栈 + oracleFaults
 *   · 节点终态 (state 字段, 逐字): VERIFIED | FAILED | UNVERIFIED | SKIPPED
 *       VERIFIED  = commandExitCode === expectExit && gate.verdict === 'OK'
 *       FAILED    = commandExitCode !== expectExit || gate.verdict === 'FAIL'
 *       UNVERIFIED = gate.verdict === 'UNVERIFIED'  (oracle 自己拿不准; F19 钉这条)
 *       SKIPPED   = 非 command executor (D-C: 不在 fixture 范围内, 留记号给外部断言)
 *   · 装成 run-summary.json 落 <dir>/ (审计与断点续跑真源), 同时单行紧凑 JSON 写 stdout
 *   · UNVERIFIED 节点逐行 stdout (S1 契约): `node=<id> state=UNVERIFIED gate=post_leaf reason=<r> evidence=<e>`, 无 stderr
 *   · 退出码: 运行完成 (含 UNVERIFIED, 含 SKIPPED) → exit 0; 中途中止 (plan 读不到 / 写盘失败) → exit 1;
 *     PP-INV (缺 --fixture / 缺 plan.json / plan 坏 JSON) → exit 2; PP-INT (未捕获 harness 异常) → exit 3。
 *     D-K accept: command leaf 的 expect_exit=非 0 是正常的"反向 oracle", 不算节点 FAILED, 整体仍可 exit 0。
 *
 * fail-open 不吞证据: 节点内 spawn 抛 / evaluatePostLeaf 抛都进 oracleStacks (不进 stderr, 全部证据落 summary)。
 */
async function runWithFixture(args: string[]): Promise<void> {
  const dir = flagValue(args, '--fixture');
  if (!dir) {
    process.stderr.write('PP-INV input_missing: --fixture <dir> required\n');
    process.exit(2);
  }
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const planPath = joinPath(dir, 'plan.json');
  const summaryPath = joinPath(dir, 'run-summary.json');

  const { evaluatePostLeaf } = await import('./post-leaf-gate');
  type GateResult = import('./post-leaf-gate').GateResult;
  type GateVerdict = import('./post-leaf-gate').GateVerdict;
  type NodeState = 'VERIFIED' | 'FAILED' | 'UNVERIFIED' | 'SKIPPED';

  let plan: {
    name?: string;
    description?: string;
    nodes: Record<string, {
      executor?: string;
      command?: string;
      expect_exit?: number;
      gate_script?: string;
      output_path?: string;
      [k: string]: unknown;
    }>;
  };
  try {
    const text = await readFile(planPath, 'utf8');
    plan = JSON.parse(text);
  } catch (e) {
    process.stderr.write(`PP-INV input_missing: read ${planPath} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  // 节点摘要形状: 命令层结果 (commandExitCode / commandStdout / 命令级 state) + PostLeafGate 三态
  // (verdict / reason / evidence / oracleFaults) 合一, 验收测试可一次性读到全部字段。
  interface NodeSummary {
    id: string;
    executor: string;
    /** 节点终态 (S1 契约 §逐字): VERIFIED | FAILED | UNVERIFIED | SKIPPED。 */
    state: NodeState;
    command?: string;
    commandExitCode?: number | null;
    commandStdout?: string;
    commandStderr?: string;
    verdict: GateVerdict;
    reason?: string;
    evidence?: string;
    oracleFaults: number;
    evaluatedAt: string;
  }
  const nodesOut: Record<string, NodeSummary> = {};
  let oracleFaultsTotal = 0;
  const oracleStacks: string[] = [];

  // 凭证 env 摘取只借一次 (scrubCredentialEnv 是 sync 函数, 不需 await;
  // require 在 Bun 静态 ESM 模块下也走得通 —— 不过为统一仓内"动态 await import"风格, 这里 lazy 缓存)。
  const scrub = await getScrubber();

  for (const [nodeId, n] of Object.entries(plan.nodes ?? {})) {
    if (n.executor !== 'command') {
      // D-C: 只含 command leaf; 其它 executor (leaf / research / await) 不在 fixture 范围内
      // — 标 'SKIPPED' 进 summary, 留给外部断言看见"这张 fixture 漏了非 command 节点"。
      nodesOut[nodeId] = {
        id: nodeId,
        executor: n.executor ?? '<none>',
        state: 'SKIPPED',
        verdict: 'OK',
        reason: 'skipped_non_command',
        oracleFaults: 0,
        evaluatedAt: new Date().toISOString(),
      };
      continue;
    }

    // 真跑命令 (Bun.spawn 直跑, 零 LLM)。零模型 = 不调任何 provider, 不进 leaf routing。
    const cmdText = String(n.command ?? '');
    const expectExit = typeof n.expect_exit === 'number' ? n.expect_exit : 0;
    let commandExitCode: number | null = null;
    let commandStdout = '';
    let commandStderr = '';
    try {
      const proc = Bun.spawn(['sh', '-c', cmdText], {
        cwd: process.cwd(),
        env: scrub(process.env),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      commandExitCode = await proc.exited;
      commandStdout = out;
      commandStderr = err;
    } catch (e) {
      // spawn 自己抛 = oracle-fault 之外的事 (命令链本身无法起进程); 仍走 PostLeafGate 让它判
      // UNVERIFIED, evidence = spawn 异常栈。
      const stack = e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.error(`[omd/run-fixture] spawn threw: node=${nodeId} ${stack}`);
      oracleFaultsTotal += 1;
      oracleStacks.push(`[${nodeId}] spawn threw: ${stack}`);
    }

    // gate 脚本约定: <dir>/checks/<nodeId>.sh, 或 plan 节点上的 gate_script 字段绝对路径。
    const gateScript =
      typeof n.gate_script === 'string'
        ? n.gate_script
        : joinPath(dir, 'checks', `${nodeId}.sh`);
    const checksRoot = joinPath(dir, 'checks');

    // PostLeafGate 三态。spawn 注入走 command-leaf 的 Bun.spawn + 截 stdout/stderr 同款,
    // 真跑 shell 命令, 跟 command-leaf 跑法分叉但语义同 — 命令本身已跑, 这里再跑 oracle 判它。
    const gate: GateResult = await evaluatePostLeaf({
      artifact: { nodeId, output: commandStdout, toolCalls: [] },
      scriptPath: gateScript,
      checksRoot,
      cwd: process.cwd(),
      timeoutMs: 30_000,
      spawn: async (command, cwd, timeoutMs) => {
        // command 是 evaluatePostLeaf 内部构造的 `sh -c '<script>'`, 这里解出脚本本体跑。
        const inner = command.replace(/^sh -c /, '');
        const proc = Bun.spawn(['sh', '-c', inner], {
          cwd,
          env: scrub(process.env),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        // 超时闸 (Bun 自身有, 这里叠一层 setTimeout 兜底, 与 agent-leaf 那条路的纪律一致)。
        let timedOut = false;
        const killer = setTimeout(() => {
          timedOut = true;
          try { proc.kill(); } catch (e) {
            // kill 失败 (进程已退出 / 权限不够) 不阻断外层: 超时仍按 timedOut=true 走收尾分支。
            logger.warn({ err: e instanceof Error ? e.message : String(e) }, '[omd/run] proc.kill failed during timeout');
          }
        }, timeoutMs ?? 30_000);
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        clearTimeout(killer);
        return { stdout: out, stderr: err, exitCode: code, timedOut };
      },
    });

    oracleFaultsTotal += gate.oracleFaults;
    if (gate.oracleFaults > 0 && gate.evidence) {
      oracleStacks.push(`[${nodeId}] ${gate.reason ?? '?'}: ${gate.evidence}`);
    }

    // 节点终态映射 (S1 契约逐字):
    //   · expect_exit miss (commandExitCode !== expectExit): D-K oracle fail → 节点 FAILED,
    //     gate 不再叠加 (artifact 不可信, oracle 在不可信产物上判什么都白搭)。
    //   · expect_exit hit + gate OK         → VERIFIED
    //   · expect_exit hit + gate FAIL       → FAILED (oracle 拒了)
    //   · expect_exit hit + gate UNVERIFIED → UNVERIFIED (oracle 自己拿不准; F19 钉这条)
    let state: 'VERIFIED' | 'FAILED' | 'UNVERIFIED';
    if (commandExitCode !== expectExit) {
      state = 'FAILED';
    } else if (gate.verdict === 'UNVERIFIED') {
      state = 'UNVERIFIED';
    } else if (gate.verdict === 'FAIL') {
      state = 'FAILED';
    } else {
      state = 'VERIFIED';
    }

    const summary: NodeSummary = {
      id: nodeId,
      executor: 'command',
      command: cmdText,
      commandExitCode,
      commandStdout: commandStdout.slice(0, 4096),
      commandStderr: commandStderr.slice(0, 4096),
      state,
      verdict: gate.verdict,
      oracleFaults: gate.oracleFaults,
      evaluatedAt: gate.evaluatedAt,
    };
    if (gate.reason !== undefined) summary.reason = gate.reason;
    if (gate.evidence !== undefined) summary.evidence = gate.evidence;
    nodesOut[nodeId] = summary;
  }

  // 总体 verdict: 任一 UNVERIFIED → 总体 UNVERIFIED; 否则任一 FAILED → 总体 FAIL; 全 VERIFIED/SKIPPED → OK。
  const stateList = Object.values(nodesOut).map((x) => x.state);
  const overall: 'OK' | 'FAIL' | 'UNVERIFIED' = stateList.includes('UNVERIFIED')
    ? 'UNVERIFIED'
    : stateList.includes('FAILED')
      ? 'FAIL'
      : 'OK';

  const finishedAt = new Date().toISOString();
  const summary = {
    runId: `fixture-${startedAt}`,
    startedAt,
    finishedAt,
    planName: plan.name ?? '<unnamed>',
    planDescription: plan.description,
    fixtureDir: dir,
    overall,
    oracleFaults: oracleFaultsTotal,
    oracleStacks,
    nodes: nodesOut,
  };

  // 摘要写入磁盘 (审计与断点续跑真源)。失败 → PP-INT exit 3。
  try {
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  } catch (e) {
    process.stderr.write(`PP-INT unhandled: write ${summaryPath} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(3);
  }

  // UNVERIFIED 节点逐行 stdout (S1 契约逐字: `node=<id> state=UNVERIFIED gate=post_leaf
  // reason=<reason> evidence=<evidence>`, 无 stderr —— 诊断行已被 summary 写入磁盘, 不二次写 stderr)。
  for (const n of Object.values(nodesOut)) {
    if (n.state === 'UNVERIFIED') {
      process.stdout.write(
        `node=${n.id} state=UNVERIFIED gate=post_leaf ` +
        `reason=${n.reason ?? ''} evidence=${n.evidence ?? ''}\n`,
      );
    }
  }

  // 摘要单行紧凑 JSON 写 stdout (子过程 runWithFixture 自身产生, 不二次包装);
  // 消费方可 JSON.parse 取末行。
  process.stdout.write(`${JSON.stringify(summary)}\n`);

  // 退出码: 运行完成 (含 UNVERIFIED / 含 SKIPPED / 任一 FAILED) → 0 (S1 契约);
  // 中途 (plan 读不到 / 写盘失败) 已在前面 exit(2|3) 早退, 落不到这里。
  process.exit(0);
}

/**
 * 拿 command-leaf 的凭证摘取函数 (sync), 借一次后缓存 — 不与 command-leaf.ts 重复 regex (H5-3)。
 * 模块动态 import 与既有 cli.ts 的"分入口按需装"风格一致; runWithFixture 才用到, 其它入口零开销。
 */
async function getScrubber(): Promise<(env: NodeJS.ProcessEnv) => Record<string, string | undefined>> {
  const mod = await import('./command-leaf');
  return (env) => mod.scrubCredentialEnv(env as Record<string, string | undefined>);
}
// 闭合 import.meta.main 守护 (切片 6: 测试 import 不触发 legacy 分支)
}
