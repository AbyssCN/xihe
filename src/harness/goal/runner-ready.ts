/**
 * goal/runner-ready —— **runner 就绪预检**: 一次, 点火前 (契约
 * `docs/plan/2026-09-06-墙钟与读次数-执行契约.md` W3)。
 *
 * ## 治的读数
 *
 * code80 批实测: `env-install` 步与「`No module named pytest`」在多题各自出现 —— 每一题都在
 * 自己那一轮里发现 pytest 没装、自己去装一遍。那是**环境事实**, 不是这道题的一部分:
 * 属于点火前的一次性预检, 不该由每个执行体各花几轮去摸。
 *
 * ## 两条边界
 *
 *  · **默认只记不装。** 装别人的依赖是改环境, 产品路径上不能默认干这事 ——
 *    只有 `OMD_ENSURE_TEST_RUNNER=1`(bench 的 version yaml 会开) 才真装。开关判在**调用方**,
 *    本模块只认 `opts.install` 这个布尔, 不自己读 env (读 env 的纯函数没法测)。
 *  · **只管 pytest。** 别的语言的 runner 缺席时该做什么各不相同 (bun 缺席 = 这台机器没装 bun,
 *    装它不是一条 pip 命令的事), 硬凑一个统一入口只会写出一条永远不走的分支。
 *
 * ## 三态别压平 (§静默坑 1)
 *
 * `installed` 缺席 = **没试过装** (已经在 PATH 上 / `install:false` / 不适用);
 * `false` = 试了没成 (原文在 `why`); `true` = 装上了且装完再探得到。
 * 「装上了」与「跑得起来」是两件事 —— 所以装完还要再探一次, 探不到就是 `present:false`。
 */
import { logger } from '../logger';
import type { EnvFacts } from '../env-facts';
import type { SpawnLike } from './falsify-tests';

export interface RunnerReady {
  /** 这个仓的主语言 (探不出 = null)。 */
  language: string | null;
  /** 本预检管的 runner; 非 python 仓 = null (不适用, 与「没装」是两件事)。 */
  runner: string | null;
  present: boolean;
  /** 缺席 = 没试过装; false = 试了没成; true = 装上了且装完探得到。 */
  installed?: boolean;
  /** 一句人话。缺席 = 没有额外要说的。 */
  why?: string;
}

/** pip 那一跳的墙钟上限 (契约 W3 逐字 120 s)。装依赖会拉网, 没有上限就是一条能把整场按住的路。 */
export const PIP_TIMEOUT_MS = 120_000;
/** 装完再探那一跳的上限 —— 只是问一句版本号, 不该跟装包一个量级。 */
const PROBE_TIMEOUT_MS = 30_000;

const PIP_ARGV = ['python3', '-m', 'pip', 'install', '-q', 'pytest'];
const PROBE_ARGV = ['python3', '-m', 'pytest', '--version'];

/** 缺省 IO: 与 `falsify-tests` 同款 `Bun.spawnSync`(超时由 Bun 杀进程, 那时 `exitCode` 为 null)。 */
function defaultRun(argv: string[], opts: { cwd: string; timeoutMs: number }): ReturnType<SpawnLike> {
  const r = Bun.spawnSync(argv, { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe', timeout: opts.timeoutMs });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    timedOut: r.signalCode === 'SIGTERM' || r.signalCode === 'SIGKILL',
  };
}

/** 一次 spawn 的判词: 成了返 null, 没成返一行原文 (超时 / 抛错 / 非零退出各说各的)。 */
function failureOf(r: ReturnType<SpawnLike>, timeoutMs: number): string | null {
  if (r.timedOut) return `超时 (${timeoutMs} ms 未跑完, 进程已被杀)`;
  if (r.exitCode === null) return '没有退出码 (被信号打断)';
  if (r.exitCode !== 0) return `exit ${r.exitCode}: ${(r.stderr || r.stdout || '').trim().slice(0, 240)}`;
  return null;
}

/**
 * 探一次「这个仓的测试 runner 到位了没」, 需要且被允许时装一次。
 *
 * falsify (本函数必须能真红): 把 `if (!opts.install)` 那一支删掉 ⇒
 * runner-ready.test.ts 的「install:false 一次 pip 都不调」当场红。
 */
export function ensureTestRunner(
  facts: EnvFacts,
  root: string,
  opts: { install: boolean; run?: SpawnLike },
): RunnerReady {
  const primary = facts.languages[0]?.language ?? null;
  const py = facts.languages.find((l) => l.language === 'python');
  if (!py) {
    return { language: primary, runner: null, present: false, why: '不适用: 这个仓没有 python 证据 (本预检只管 pytest)' };
  }
  if (py.runnersOnPath.includes('pytest')) {
    return { language: 'python', runner: 'pytest', present: true, why: 'pytest 在 PATH 上' };
  }
  if (!opts.install) {
    return {
      language: 'python',
      runner: 'pytest',
      present: false,
      why: 'pytest 不在 PATH; OMD_ENSURE_TEST_RUNNER 没开 → 只记事实 (产品路径不默认装别人的依赖)',
    };
  }
  const run = opts.run ?? defaultRun;
  const notReady = (why: string): RunnerReady => ({ language: 'python', runner: 'pytest', present: false, installed: false, why });
  let installed: ReturnType<SpawnLike>;
  try {
    installed = run(PIP_ARGV, { cwd: root, timeoutMs: PIP_TIMEOUT_MS });
  } catch (err) {
    // fail-open 可以吞异常, 不许吞证据 (§静默坑 2): 装不上照跑, 但原文既进 why 也进日志。
    const why = `pip 抛错: ${String(err instanceof Error ? err.message : err).slice(0, 240)}`;
    logger.warn({ root, argv: PIP_ARGV, err: String(err) }, '[omd/runner-ready] pytest 安装抛错 → 只记事实 (不拦 run)');
    return notReady(why);
  }
  const installFailure = failureOf(installed, PIP_TIMEOUT_MS);
  if (installFailure) {
    logger.warn({ root, why: installFailure }, '[omd/runner-ready] pytest 装不上 → 只记事实 (不拦 run)');
    return notReady(`pip 装 pytest 没成: ${installFailure}`);
  }
  // 「装上了」≠「跑得起来」: 装完再探一次, 探不到就照实说是第二步没过, 别把两件事并成一句。
  let probe: ReturnType<SpawnLike>;
  try {
    probe = run(PROBE_ARGV, { cwd: root, timeoutMs: PROBE_TIMEOUT_MS });
  } catch (err) {
    const why = `装完复探抛错: ${String(err instanceof Error ? err.message : err).slice(0, 240)}`;
    logger.warn({ root, argv: PROBE_ARGV, err: String(err) }, '[omd/runner-ready] pytest 装完复探抛错 → 按未就绪记');
    return notReady(why);
  }
  const probeFailure = failureOf(probe, PROBE_TIMEOUT_MS);
  if (probeFailure) {
    logger.warn({ root, why: probeFailure }, '[omd/runner-ready] pytest 装完仍探不到 → 按未就绪记');
    return notReady(`pip 说装好了, 但 \`python3 -m pytest --version\` 仍不通: ${probeFailure}`);
  }
  logger.info({ root }, '[omd/runner-ready] pytest 预检: 本次安装并复探通过');
  return { language: 'python', runner: 'pytest', present: true, installed: true, why: '本次由预检装上 (python3 -m pip install -q pytest), 装完复探通过' };
}

/** 给 conductor / stage 摘要用的一行人话。缺席那一格照实说"不适用", 不编。 */
export function renderRunnerReady(r: RunnerReady): string {
  if (!r.runner) return `测试 runner: 不适用 (${r.why ?? '这个仓不是 python'})`;
  if (r.present) return `测试 runner: ${r.runner} ${r.installed ? '未装 (已安装)' : '在 PATH'}`;
  return `测试 runner: ${r.runner} 未装${r.installed === false ? ` (安装失败: ${r.why ?? '原因未记'})` : ` (${r.why ?? '未尝试安装'})`}`;
}
