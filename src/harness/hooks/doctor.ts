/**
 * hooks/doctor —— **`omd doctor` 的判别器**(CLI 主入口切片 3, 2026-09-05)。
 *
 * ## 它治的病:jail 内**少东西**伪装成"模型不行"
 *
 * 整个仓的历史 (S-34 / 86e6cdb / 3f8e366 / plana 四个 run 零产出) 有一个共同的判词失败形状:
 * **jail 内缺了外面有的东西** —— worker / git / node_modules / node 安装根 —— 而每一次
 * 不完整都伪装成「模型不干活」「读数被写成假的」「仓本来就是脏的」。真代价是:
 * 下一步变成了"加时间/换池/重跑", 而不是"补一条 bind" —— 把账记到了错的地方。
 *
 * 这一片不修任何挂载(那是 hooks/bwrap 与 hooks/toolchain 的活); 它只**认** —— 把
 * `bwrap 探针 + 生态探测 + preflight + 真 jail smoke` 四路结果收齐, 出 `JailProblem[]`。
 * 出口是 CLI: `level | what | fix` 逐行 + 末行 `doctor: N fatal / M warn`; 任一 fatal → exit 1。
 *
 * ## 形状:**判别 = 纯函数, IO = 壳**
 *
 * | 函数 | 职责 | IO |
 * |---|---|---|
 * | `diagnose(input)` | 把四路结果合成 `JailProblem[]`。**零 IO**。 | 无 |
 * | `renderDoctor(problems)` | 文本 + exitCode。 | 无 |
 * | `collectDoctorInput(repoRoot, deps?)` | 真探针 + 真 smoke → `DoctorInput`。 | spawn / fs |
 *
 * 这条分工不是审美 —— `diagnose` 没有 IO 才能在测试里造**任意世界**(宿主有/无 node,
 * jail 通/不通, sandbox 通/不通)而不真起 bwrap; D-7 末句裁「不得内联一份」也是为同一件事。
 *
 * ## 不变量
 *
 * · `diagnose` **不 import** `hooks/bwrap` / `hooks/toolchain` / `hooks/jail-preflight` /
 *   `hooks/shell-sandbox` —— 它吃的是**别人算好的**结果, 自己不再算一次。
 * · 宿主 127 但 jail 127 → **不报**; 这条排掉"宿主就没装"的假阳性 (S-45 同款)。
 * · preflight 问题**原样透传** —— diagnose 不二次包装, 那一份的判词已被 verifier 看过。
 *
 * @module
 */
import type { JailProblem } from './jail-preflight';
import { checkJailArgv } from './jail-preflight';
import { bwrapArgs, defaultRoBinds } from './bwrap';
import { probeShellSandbox } from './shell-sandbox';
import { detectEcosystems } from './toolchain';

export type { JailProblem } from './jail-preflight';

/** bwrap 在这台机器上能不能起 —— 与 `probeShellSandbox` 的形态逐字一致。 */
export type DoctorSandbox = { ok: true } | { ok: false; reason: string };

/** 命中的生态(diagnose 不重新探测, IO 壳注入)。 */
export interface DoctorEcosystem {
  id: string;
  executables: readonly string[];
}

/** 一条 smoke 结果:同一个 exe, 宿主与 jail 各跑一次 `--version`。 */
export interface DoctorSmokeRow {
  exe: string;
  host: { code: number; out: string };
  jail: { code: number; out: string };
}

/** `diagnose` 的全部输入(D-7:四路结果全部注入, 自己不算)。 */
export interface DoctorInput {
  sandbox: DoctorSandbox;
  ecosystems: readonly DoctorEcosystem[];
  preflight: readonly JailProblem[];
  smoke: readonly DoctorSmokeRow[];
}

/**
 * 判别。四路结果 → 问题列表。
 *
 * 顺序:① sandbox 起没起来 → ② preflight 原样透传 → ③ smoke 宿主通/不通。
 *
 * @returns 问题列表;空数组 = 全绿。**exitCode 由 renderDoctor 决定**, 不在这里算。
 */
export function diagnose(input: DoctorInput): JailProblem[] {
  const problems: JailProblem[] = [];

  // ① sandbox 起没起来。起不来是**底座**问题 —— 后面所有 jail 内探测都不可信。
  //    fix 必须把 reason 原文带回去: 同一条 reason 字符串是用户拿去排错的唯一抓手。
  if (!input.sandbox.ok) {
    problems.push({
      level: 'fatal',
      what: `bwrap 在这台机器上起不来: ${input.sandbox.reason}`,
      fix: `修复 sandbox 探测本身 —— ${input.sandbox.reason}。这是 jail 的底座, 起不来后续所有挂载面问题都看不到`,
    });
  }

  // ② preflight 透传。`checkJailArgv` 自己已是纯函数, 判词已被 GWT-7 之外的闸看过,
  //    diagnose 不二次包装, 也不合并同义项 (合并会把"哪条 argv 触发的"这一证据抹掉)。
  for (const p of input.preflight) problems.push(p);

  // ③ smoke: 宿主通 / jail 不通 → fatal, fix 指名"挂宿主安装根"。
  //    ⚠ 宿主都不通 (code !== 0) → **不报**: 那是宿主没装, 不是 jail 的锅 (S-45 同款)。
  //    写反这条等于给"宿主缺工具"报"jail 缺 bind", 下一步去补挂载面, 修不到点子上。
  for (const row of input.smoke) {
    if (row.host.code === 0 && row.jail.code !== 0) {
      problems.push({
        level: 'fatal',
        what: `宿主上 ${row.exe} --version 退 0; jail 内同命令退 ${row.jail.code} —— ${row.exe} 在 jail 里跑不起来`,
        fix: `把 ${row.exe} 的宿主安装根加进 bwrap 的 --ro-bind (见 hooks/toolchain.ts 的 resolveToolchainBinds)。⚠ 真代价是**读数被写成假的**: 叶子会用手边的运行时顶替, 假报一批测试失败 → 基线不可复现 (plana 2026-09-04 实账)`,
      });
    }
  }

  return problems;
}

/** 渲染一行。`level | what | fix`。 */
export interface DoctorRender {
  text: string;
  exitCode: 0 | 1;
}

/**
 * 把问题列表渲成 CLI 文本。**末行一定是 `doctor: N fatal / M warn`** —— Aalto 验收脚本抓这行
 * (verifier 2026-09-04 同款: 末行字面量要稳, 不能在中间塞个换行)。
 *
 * @returns `text` 末尾带 `\n`(终端友好); `exitCode` = 任一 fatal → 1, 否则 0。
 *   warn **不**抬高 exitCode: warn 是"读数会失真但跑得动", 不是"跑不起来", 不该阻塞 doctor 退出。
 */
export function renderDoctor(problems: readonly JailProblem[]): DoctorRender {
  const lines: string[] = [];
  let fatal = 0;
  let warn = 0;
  for (const p of problems) {
    lines.push(`${p.level} | ${p.what} | ${p.fix}`);
    if (p.level === 'fatal') fatal += 1;
    else warn += 1;
  }
  lines.push(`doctor: ${fatal} fatal / ${warn} warn`);
  return { text: `${lines.join('\n')}\n`, exitCode: fatal > 0 ? 1 : 0 };
}

/** 一次 spawn 的结果 —— IO 壳的最小返回。 */
export interface DoctorRunResult {
  code: number;
  out: string;
}

/** `collectDoctorInput` 的注入点 —— 测试用来造"任意世界", 不真起 bwrap。 */
export interface DoctorCollectDeps {
  /** spawn argv 拿 code+out。默认走 `Bun.spawnSync`, 抓 throw 当 127。 */
  run?: (argv: readonly string[]) => DoctorRunResult;
  /** 注入 sandbox 探针结果(默认 `probeShellSandbox()`)。 */
  sandbox?: DoctorSandbox;
  /** 注入生态探测结果(默认 `detectEcosystems(repoRoot)`)。 */
  ecosystems?: readonly DoctorEcosystem[];
}

/**
 * 真跑一组探针, 组 `DoctorInput`。
 *
 * · **sandbox** 走 `probeShellSandbox()` 的缓存 —— 测试用 `deps.sandbox` 注入。
 * · **argv** = 同一份生产 `bwrapArgs(root, defaultRoBinds(root))`(D-7 末: "用生产同一份 bwrap argv")。
 *   用同一份才能保证 doctor 报的就是引擎实际组出来的。
 * · **preflight** 喂 `checkJailArgv`; worker 字段传空字符串(doctor 不跑 worker, 不该让 ② 那条
 *   误报"worker 不在挂载覆盖下"); roBinds 喂与 argv 同源的一份, 让 ④ (symlink) 与 ⑥ (生态 PATH) 真起作用。
 * · **smoke** 对每个生态的每个 executable 跑 `exe --version`, 宿主与 jail 各一次。**不**真起 bwrap
 *   当 sandbox 探测已说 bwrap 不通 —— 那种情况下 bwrap 自己就 127, smoke 全 127 是噪音;
 *   此时 `smoke` 返空, 真正的 fatal 由 ① 那条带回去 (reason 原文, 一行说清)。
 */
export async function collectDoctorInput(
  repoRoot: string,
  deps: DoctorCollectDeps = {},
): Promise<DoctorInput> {
  const run = deps.run ?? defaultRun;
  const sandbox = deps.sandbox ?? adaptSandbox(probeShellSandbox());
  const ecosystems =
    deps.ecosystems ??
    detectEcosystems(repoRoot).map((e) => ({ id: e.id, executables: e.executables }));

  // 与生产同款的 argv(用于 preflight + smoke 的 jail 那一臂)。
  // 默认 defaultRoBinds: root 不存在 → 抛。catch 后 preflight 给一条 fatal 替代表达。
  let argv: string[];
  let preflight: readonly JailProblem[];
  try {
    const roBinds = defaultRoBinds(repoRoot);
    argv = bwrapArgs(repoRoot, roBinds);
    preflight = checkJailArgv({
      argv,
      root: repoRoot,
      workerPath: '', // doctor 不跑 worker, 不该触发 ② 那条
      wantGit: false,
      roBinds,
    });
  } catch (e) {
    argv = [];
    preflight = [
      {
        level: 'fatal',
        what: `bwrapArgs 组装失败: ${e instanceof Error ? e.message : String(e)}`,
        fix: '检查 hooks/bwrap.ts / hooks/toolchain.ts 是否被改坏 —— 这是 doctor 自己都组不出 argv',
      },
    ];
  }

  // smoke: sandbox 不通 → 全是 127 噪音, 跳过(① 的 fatal 已经带 reason 原文)。
  const smoke: DoctorSmokeRow[] = [];
  if (sandbox.ok && argv.length > 0) {
    const exes = new Set<string>();
    for (const eco of ecosystems) for (const e of eco.executables) exes.add(e);
    for (const exe of exes) {
      const host = run([exe, '--version']);
      const jail = run(['bwrap', ...argv, exe, '--version']);
      smoke.push({ exe, host, jail });
    }
  }

  return { sandbox, ecosystems, preflight, smoke };
}

/** 默认 spawn 包装。**抓 throw 当 127** —— 二进制不存在 / 权限不够 / OS 错统一走这条,
 *  否则 doctor 自己会在"宿主上没装 bwrap"这条路上抛出去, 把"宿主 vs jail"的对照判据崩了。 */
function defaultRun(argv: readonly string[]): DoctorRunResult {
  try {
    const p = Bun.spawnSync([...argv], { stdout: 'pipe', stderr: 'pipe' });
    const dec = new TextDecoder();
    return { code: p.exitCode ?? -1, out: `${dec.decode(p.stdout)}${dec.decode(p.stderr)}` };
  } catch (e) {
    return { code: 127, out: e instanceof Error ? e.message : String(e) };
  }
}

/** `probeShellSandbox` 的形态是 `{ok:boolean, reason?}` —— 比 doctor 想要的判别联合松一格
 *  (`reason` 在 `ok:false` 那一支是可选的)。在边界处收紧, 让 diagnose 始终拿到一个
 *  reason 必现的失败形态。reason 缺席 → 用兜底串, 不让 doctor 判词变成"bwrap 起不来: undefined"。 */
function adaptSandbox(s: { ok: boolean; reason?: string }): DoctorSandbox {
  if (s.ok) return { ok: true };
  return { ok: false, reason: s.reason ?? '(bwrap 起不来但 probeShellSandbox 未给出 reason)' };
}
