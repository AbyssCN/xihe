/**
 * src/harness/cli/invoke —— CLI 命令 → MCP 工具面 的统一接缝 (切片 4, SDD 2026-09-05)。
 *
 * ## 是什么
 *
 * 编排 = 装配 → 按名找 handler → 调 → 渲染 → 退出码。CLI 与 MCP 共用同一份工具表
 * (`assembleOmdMcpTools`),名字解析按**新名**走 (见 `src/mcp/tool-renames.ts`)；命名
 * 命令 / 通用 `omd call <tool>` 都走这条路,零第二套语义 (INV-1)。
 *
 * ## 不做什么 (INV-1 零第二套语义)
 *
 * 不 import 任何 engine / goal / hooks 内部件 (`dag/engine`、`goal/run-goal`、
 * `goal/loop-run`、`hooks/bwrap`)。生产路径只动 MCP 工具面表与 logger。GWT-1 用
 * `ugrep` 在源码内查这些路径字面量,任何命中 = 闸红。
 *
 * ## 退出码 (INV-3, 单点机械映射)
 *
 *  - `handler` 抛异常                   → 1 (用法/装配/实现错)
 *  - `handler` 返回 `{isError: true}`   → 2 (业务拒: 命令本身没走通,但调用形态对)
 *  - 其它                              → 0 (成功,文本或 JSON 走 stdout)
 *
 * 退出码只由 `exitCodeFor` 决定 (GWT-3);`invokeTool` 不在内部抛/退。
 *
 * ## stdout 纪律 (INV-4)
 *
 *  - `json:false` → handler `content[].text` 逐段拼接,缺段(含 resource)原样不进。
 *  - `json:true`  → handler content 原样 `JSON.stringify`,管道 `| jq` 可用。
 *  - 日志一律走 stderr (`setLoggerDestination(2)` 由 cli.ts 在分派前改道;本文件不动 logger)。
 *
 * ## 默认 tools 来源
 *
 * 不传 `opts.tools` → 走 `assembleOmdMcpTools()` 装配同一份生产表。
 * 测试用例注入 fixture tools (与 `MCP_ONLY` 对账闸同源):每个测试 case 自带替身,本文件
 * 不为测试另写一份工具面 (D-7 同族教训)。
 */

export interface InvokeResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  /** 抛异常时的证据 (工具名 + 错误原文), 调用方写 stderr。吞异常不许吞证据 (仓规静默坑 2)。 */
  stderr: string;
}

/** Minimum tool shape invokeTool needs from each entry. Production tools conform via `assembleOmdMcpTools`. */
export interface InvokeToolEntry {
  name: string;
  handler: (args: unknown) => Promise<unknown>;
}

export interface InvokeToolOpts {
  tool: string;
  args: Record<string, unknown>;
  /** `json:true` → stdout = `JSON.stringify(content)`;`json:false` → text segments 拼接。 */
  json: boolean;
  /** Override default text rendering. 通常由 `CliCommand.render` 注入,见 registry.ts。 */
  render?: (content: unknown) => string;
  /** Tests inject fixtures;生产省略 → lazy `assembleOmdMcpTools()`。 */
  tools?: readonly InvokeToolEntry[];
}

/**
 * 装配 → 按名找 handler → 调 → 渲染 → 退出码 (INV-1/INV-3/INV-4)。
 *
 * 找不到 tool → exitCode 1,stdout 空 (生产 cli.ts 会先把 `--help` 兜底判掉,
 * 走到这里说明 registry 与装配面漂移了,响应要响)。**
 */
export async function invokeTool(opts: InvokeToolOpts): Promise<InvokeResult> {
  const tools = opts.tools ?? (await loadDefaultTools());
  const entry = tools.find((t) => t.name === opts.tool);
  if (!entry) {
    return { exitCode: 1, stdout: '', stderr: `omd: 装配面里没有工具 ${opts.tool} (registry 与 assemble 漂移?)\n` };
  }
  let content: unknown;
  let isError: boolean | undefined;
  let threw = false;
  let stderr = '';
  try {
    content = await entry.handler(opts.args);
    const r = content as { isError?: unknown } | null | undefined;
    isError = r?.isError === true;
  } catch (e) {
    // 装配/实现错 (McpError 等同族)。response isError 缺省 = 抛前未生成。
    // 错误原文进 stderr —— 没有它, `omd call x` 抛了只剩一个 exit 1, 排错无从下手 (Aalto 验收修 2026-09-05)。
    threw = true;
    content = undefined;
    isError = undefined;
    stderr = `omd ${opts.tool}: ${e instanceof Error ? e.message : String(e)}\n`;
  }
  const exitCode = exitCodeFor({ isError }, threw);
  // 异常时 stdout 必为空 —— `JSON.stringify(undefined)` 是 undefined 不是 ""(GWT-4 反向自检)。
  // 编排函数不"拼一半再截断"那种把人搞糊涂的语义:异常由 exitCode 1 表达,stdout 一律 ""。
  const stdout = threw ? '' : renderStdout({ json: opts.json, render: opts.render, content });
  return { exitCode, stdout, stderr };
}

/** 图类工具 (run / run-plan / resume) 起跑即返回 runId; 引擎在**本进程**后台跑 (dag-tools.ts 文件头)。
 *  CLI 进程一退引擎就死, 所以非 detached 的 run 必须在这里等到终态 (契约 D-4)。 */
export const RUN_TERMINAL = new Set(['done', 'failed', 'cancelled']);

/** 从 run 工具的 stdout (文本或 JSON 串都行) 里取 runId (`runId: <id>`)。取不到 → undefined (调用方不等)。 */
export function parseRunIdFromText(text: string): string | undefined {
  const m = /runId:\s*([0-9a-zA-Z-]{2,})/.exec(text);
  return m?.[1];
}

/** 终态 content 的文本视图 (与默认渲染同一份, 供 cli.ts 拼接终态摘要)。 */
export function renderContentText(content: unknown): string {
  return defaultTextRender(content);
}

/**
 * 轮询 `dag_status` 直到终态, 返回最后一次 status 的 content。
 * tools 里没有 dag_status (测试 fixture) → 立即返回 undefined, 不等。
 * 反向自检: 把 RUN_TERMINAL 清空 → 本函数对真 run 永不返回 (dispatch 测试用 fixture 不受影响, 所以
 * 这条要靠 Aalto 验收 ③ 那次真跑来证伪)。
 */
export async function waitForRun(
  runId: string,
  opts: { tools?: readonly InvokeToolEntry[]; intervalMs?: number; graceMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<unknown> {
  const tools = opts.tools ?? (await loadDefaultTools());
  const status = tools.find((t) => t.name === 'dag_status');
  if (!status) return undefined;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = opts.intervalMs ?? 2000;
  // run 工具起的是**子进程** (dag-tools.ts S2 进程化), 它把自己登记到 runs.db 要几秒 —— 刚起跑时
  // dag_status 会答 `unknown run`。实测 (Aalto 验收 ③, 2026-09-05): 0 秒就问, 必答 unknown。
  // 所以「认不出 status 行」在宽限期内继续等, 过了宽限期才当终态交回 (那时的 unknown 是真的)。
  const graceMs = opts.graceMs ?? 60_000;
  let waited = 0;
  for (;;) {
    const content = await status.handler({ runId });
    const text = defaultTextRender(content);
    const m = /^status:\s*(\w+)/m.exec(text);
    if (m && RUN_TERMINAL.has(m[1]!)) return content;
    if (!m && waited >= graceMs) return content;
    await sleep(intervalMs);
    waited += intervalMs;
  }
}

/**
 * 退出码单点 (INV-3, GWT-3)。
 *
 *  - isError:true          → 2  (业务拒)
 *  - 正常                  → 0
 *  - threw === true        → 1  (调用形态/装配错)
 *
 * 反向自检 (GWT-3):把 isError 分支改成恒 0 →「handler 拒 → exitCode === 2」测试当场红;
 * 删 threw 分支 →「抛 → exitCode === 1」红。
 */
export function exitCodeFor(
  res: { isError?: boolean } | undefined,
  threw: boolean,
): 0 | 1 | 2 {
  if (threw) return 1;
  if (res?.isError === true) return 2;
  return 0;
}

function renderStdout(opts: {
  json: boolean;
  render?: (c: unknown) => string;
  content: unknown;
}): string {
  if (opts.json) {
    // 整段 content (handler 原生返回) → stdout,可被 `| jq` 解析。
    // handler 内部其它段 (annotations / structuredContent 等) 原样透传,不裁剪 (与 docs/cli §0 一致)。
    return JSON.stringify(opts.content);
  }
  if (opts.render) return opts.render(opts.content);
  return defaultTextRender(opts.content);
}

/**
 * 默认文本渲染:GWT-4 — `content[].type === 'text'` 段按出现顺序拼接,段间换行。
 *
 * 故意只吃 text 段:handler 偶尔会塞 resource / image 段(2026-08-13 fleet 工具族就出过),
 * 那些走 stdout 二进制流污染管道 (INV-4: `omd status x --json | jq` 必须可用)。resource
 * 段不拼接,留作 `--json` 直出 —— 与 SDD §未决第二条「含 resource 时原样输出」对齐。
 */
function defaultTextRender(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const segments = (content as { content?: unknown }).content;
  if (!Array.isArray(segments)) return '';
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const piece = seg as { type?: unknown; text?: unknown };
    if (piece.type === 'text' && typeof piece.text === 'string') {
      out.push(piece.text);
    }
  }
  return out.join('\n');
}

/**
 * Lazy production assembly. 不传 `opts.tools` 时调一次,缓存到模块级 closure 内,
 * 同进程后续 `invokeTool` 调用零开销。
 *
 * 为什么 lazy:`assembleOmdMcpTools()` 拉起 model runtime 与 sqlite —— slice 4 的单测
 * 永远走 `opts.tools` 注入,这条路径不该被 import 副作用被动点亮 (test 启动快、对账闸
 * 干净)。
 */
let cachedTools: readonly InvokeToolEntry[] | undefined;
async function loadDefaultTools(): Promise<readonly InvokeToolEntry[]> {
  if (cachedTools) return cachedTools;
  // D-9: 引导序与 `omd mcp` / goal-worker 逐字一致 —— 不引导则 provider 注册表是空的, 进程内
  // 跑的工具 (research / review / memory / models-auto) 会静默秒败 (实测 ③ 回执 `providers=[⚠空]`)。
  const { bootstrapModelRuntime } = await import('../../model/bootstrap');
  bootstrapModelRuntime();
  const mod = await import('../../mcp/assemble');
  const tools = mod.assembleOmdMcpTools();
  cachedTools = tools.map((t) => ({ name: t.name, handler: t.handler as InvokeToolEntry['handler'] }));
  return cachedTools;
}
