/**
 * harness/env-facts —— **这个仓到底是什么**:一次真探测,喂给所有需要知道环境的消费者。
 *
 * ## 为什么不能继续靠文件名表
 *
 * `LANGUAGE_PACKS` 是「根下有没有 `pyproject.toml`」这种**穷举式**判断。2026-08-29 实测:
 * 80 个真实 python 仓里只有 26 个命中前三种 marker;补了 setup.py/setup.cfg/tox.ini/pytest.ini
 * 之后到 51 个;**剩下 29 个根下什么打包文件都没有** —— 它们只有 `.py` 和一个 `tests/`。
 * 再往表里加名字,加到明年也补不完。
 *
 * 更要命的是漏检的后果不是"少一个 bin":分型教学以 marker 为条件,检不出就对模型说
 * 「这仓没测试基建,拿不准选探索型」—— **引擎在对自己撒谎,然后照着谎话规划**。
 *
 * ## 三档证据,刻意不压平
 *
 * | 档 | 是什么 | 例 |
 * |---|---|---|
 * | 强 | 打包/配置 marker | `pyproject.toml` · `go.mod` · `Cargo.toml` |
 * | 中 | 源文件与测试文件的实际分布 | 137 个 `.py` + 12 个 `test_*.py` |
 * | **必要条件** | 这个 runner 在 PATH 上真的存在 | `which pytest` |
 *
 * **启用一门语言 = (强证据 ∨ 中证据) ∧ runner 真在 PATH。**
 * 第三档单列不是啰嗦:它回答的是完全不同的问题。仓里有 137 个 `.py` 说明"该用 python 判据",
 * 而 `pytest` 装没装决定"这条判据跑不跑得起来" —— 前者判方向,后者判可行。
 * 把两者压成一个 bool,就会重演今天早上那件事:给 21 个没装 pytest 的仓冻了 21 条恒红判据。
 *
 * ## 边界
 *
 * · **零 LLM、零网络、有界**:扫描深度与文件数都有上限,截断照实记(`scanned.truncated`)。
 * · 只答"这仓有什么",**不答"该怎么做"** —— 消费者拿事实自己决定。
 * · marker 表仍是 `command-leaf.LANGUAGE_PACKS` 那一份(单源),本模块**不抄第二份**。
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LANGUAGE_PACKS, allowlistForRoot } from './command-leaf';
import { logger } from './logger';

export type LanguageId = 'python' | 'js' | 'go' | 'rust';

/** 一门语言的探测证据。三档分开存 —— 压平就分不清"该用它"与"用得起来"。 */
export interface LanguageEvidence {
  language: LanguageId;
  /** 强证据: 根下检出的打包/配置 marker。 */
  markers: string[];
  /** 中证据: 该语言的源文件数 (不含测试文件)。 */
  sourceFiles: number;
  /** 中证据: 该语言的测试文件数 (按各语言的命名惯例)。 */
  testFiles: number;
  /** 必要条件: 这门语言的 runner 里, **PATH 上真的存在**的那些。 */
  runnersOnPath: string[];
  /** 声明过但 PATH 上没有的 runner —— 单列, 因为"没装"和"不该用"是两件事。 */
  runnersMissing: string[];
  /** (强 ∨ 中) ∧ runner 非空。 */
  enabled: boolean;
  /** 一句人话: 为什么启用 / 为什么没启用。给纠错环逐字引用。 */
  why: string;
}

/** Web 页面仓事实 (2026-09-11, web oracle 契约 D-4)。 */
export interface WebFacts {
  /** 入口 html 相对仓根 (按 index.html / public/index.html / src/index.html / dist/index.html 顺序取第一个在的); 没有 = null。 */
  entry: string | null;
  /** 引擎自带的 playwright-core 可解析 ∧ chromium 目录在 (PLAYWRIGHT_BROWSERS_PATH 或 ~/.cache/ms-playwright)。 */
  playwright: boolean;
  /** 判定用的浏览器目录 (playwright=false 时也给, 便于报「装到哪」)。 */
  browsersDir: string;
}

export interface EnvFacts {
  root: string;
  languages: LanguageEvidence[];
  /** Web 页面仓事实; 缺席只发生在老快照 / 测试夹具, 消费侧一律 `?.`。 */
  web?: WebFacts;
  /** 已启用语言的验证 bin 并集 (只含 PATH 上真有的)。 */
  enabledBins: string[];
  /** 按证据推的验收命令候选, 强证据在前。空 = 探不出, 消费者别硬凑。 */
  testCommandCandidates: string[];
  /**
   * 扫描统计 —— 截断/读不动了要照实说, 否则"没扫到"会被读成"没有"。
   * `unreadable` = 打不开的目录 (权限/竞态), 每条带原文: 少扫一个目录会让语言证据偏低,
   * 而"偏低"和"这仓真没有"在读数上长得一样。
   */
  scanned: { files: number; dirs: number; truncated: boolean; unreadable: string[] };
}

interface LangSpec {
  id: LanguageId;
  /** 源文件扩展名 (小写, 带点)。 */
  exts: string[];
  /** 判定一个文件是不是测试文件 (只在扩展名已匹配时调用)。 */
  isTest: (base: string, relDir: string) => boolean;
  /** 该语言的验证/构建 bin, 与 LANGUAGE_PACKS 的 bins 同源语义。 */
  runners: string[];
  /** 验收命令候选生成 (拿到已在 PATH 上的 runner)。 */
  testCommands: (onPath: string[]) => string[];
}

/** 目录名黑名单: 依赖与产物目录 —— 扫进去只会把别人的代码算成本仓证据。 */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'env', '__pycache__', 'dist', 'build',
  'target', '.next', '.nuxt', 'vendor', '.tox', '.mypy_cache', '.pytest_cache',
  'coverage', '.cache', '.omd', 'site-packages', '.idea', '.gradle',
]);

const MAX_FILES = 5_000;
const MAX_DEPTH = 5;

const LANG_SPECS: readonly LangSpec[] = [
  {
    id: 'python',
    exts: ['.py'],
    isTest: (b, d) => b.startsWith('test_') || b.endsWith('_test.py') || d.split('/').includes('tests') || d.split('/').includes('test'),
    runners: ['pytest', 'python3', 'python', 'uv'],
    testCommands: (p) => {
      const out: string[] = [];
      if (p.includes('pytest')) out.push('pytest -q');
      // pytest 没装但有解释器: `-m pytest` 也许还在, 也许不在 —— 给出来但排在后面,
      // 由消费者的判据自证去判死活 (本模块不替它判"跑得成不成")。
      if (!p.includes('pytest') && (p.includes('python3') || p.includes('python'))) {
        out.push(`${p.includes('python3') ? 'python3' : 'python'} -m pytest -q`);
      }
      return out;
    },
  },
  {
    id: 'js',
    exts: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'],
    isTest: (b, d) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(b) || d.split('/').includes('__tests__') || d.split('/').includes('tests'),
    runners: ['bun', 'node', 'npx', 'bunx', 'tsc'],
    testCommands: (p) => {
      const out: string[] = [];
      if (p.includes('bun')) out.push('bun test');
      // 裸 tsc 通常只在 node_modules/.bin —— 教 `bunx tsc` / `npx tsc` 才跑得起来。
      if (p.includes('bunx')) out.push('bunx tsc --noEmit');
      else if (p.includes('npx')) out.push('npx tsc --noEmit');
      return out;
    },
  },
  {
    id: 'go',
    exts: ['.go'],
    isTest: (b) => b.endsWith('_test.go'),
    runners: ['go', 'gofmt'],
    testCommands: (p) => (p.includes('go') ? ['go test ./...'] : []),
  },
  {
    id: 'rust',
    exts: ['.rs'],
    isTest: (b, d) => d.split('/').includes('tests') || b === 'lib.rs',
    runners: ['cargo'],
    testCommands: (p) => (p.includes('cargo') ? ['cargo test'] : []),
  },
];

/** LANGUAGE_PACKS 的 marker → 语言归属 (单源: bins 交集判定, 不抄第二份表)。 */
function markersFor(root: string, spec: LangSpec): string[] {
  const out: string[] = [];
  for (const pack of LANGUAGE_PACKS) {
    if (!pack.bins.some((b) => spec.runners.includes(b))) continue;
    if (existsSync(join(root, pack.marker))) out.push(pack.marker);
  }
  return out;
}

/** PATH 上找不找得到一个 bin。与 `missingBinaryBlockReason` 同款判定 (存在即算)。 */
function onPath(bin: string, env: Record<string, string | undefined>): boolean {
  const p = env.PATH;
  if (!p) return false;
  return p.split(':').filter(Boolean).some((d) => existsSync(join(d, bin)));
}

/** 有界扫描: 返回 ext → 计数 与 测试文件计数。深度/文件数任一到顶即停并标 truncated。 */
function scanTree(root: string): { byExt: Map<string, number>; testsByExt: Map<string, number>; files: number; dirs: number; truncated: boolean; unreadable: string[] } {
  const byExt = new Map<string, number>();
  const testsByExt = new Map<string, number>();
  let files = 0;
  let dirs = 0;
  let truncated = false;
  const unreadable: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // fail-open 可以吞异常, **不许吞证据** (仓规坑 ②): 读不了的目录跳过, 但留下是哪一个、
      // 为什么 —— 少扫一个目录会让语言证据偏低, 而"偏低"和"这仓真没有"在读数上长得一样。
      // 两处都留: 结构化那份进 `scanned.unreadable` (omd_env 会印出来给用户看),
      // 日志那份让排障的人不必先去读返回值。
      unreadable.push(`${dir}: ${(err as Error).message}`);
      logger.debug({ dir, err: (err as Error).message }, '[env-facts] 目录读不了 → 跳过 (证据已记进 scanned.unreadable)');
      return;
    }
    dirs += 1;
    for (const e of entries) {
      if (files >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (e.name.startsWith('.') && e.name !== '.github') {
        if (SKIP_DIRS.has(e.name)) continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      files += 1;
      const lower = e.name.toLowerCase();
      const dot = lower.lastIndexOf('.');
      if (dot <= 0) continue;
      const ext = lower.slice(dot);
      const spec = LANG_SPECS.find((s) => s.exts.includes(ext));
      if (!spec) continue;
      const isTest = spec.isTest(lower, rel);
      const m = isTest ? testsByExt : byExt;
      m.set(ext, (m.get(ext) ?? 0) + 1);
    }
  };
  walk(root, '', 0);
  return { byExt, testsByExt, files, dirs, truncated, unreadable };
}

/**
 * 探一次仓环境。**纯读**:不写盘、不起子进程、不调模型。
 *
 * @param root 仓根。
 * @param env  PATH 探测用 (默认 `process.env`) —— 必须与真正跑命令时是同一份。
 */
export function probeEnvFacts(root: string, env: Record<string, string | undefined> = process.env): EnvFacts {
  const scan = scanTree(root);
  const languages: LanguageEvidence[] = [];
  for (const spec of LANG_SPECS) {
    const sourceFiles = spec.exts.reduce((a, e) => a + (scan.byExt.get(e) ?? 0), 0);
    const testFiles = spec.exts.reduce((a, e) => a + (scan.testsByExt.get(e) ?? 0), 0);
    const markers = markersFor(root, spec);
    const runnersOnPath = spec.runners.filter((b) => onPath(b, env));
    const runnersMissing = spec.runners.filter((b) => !runnersOnPath.includes(b));
    if (sourceFiles === 0 && testFiles === 0 && markers.length === 0) continue; // 这门语言在这仓根本不存在
    const hasStrong = markers.length > 0;
    const hasMedium = sourceFiles + testFiles > 0;
    const enabled = (hasStrong || hasMedium) && runnersOnPath.length > 0;
    const why = enabled
      ? `启用: ${hasStrong ? `marker ${markers.join('/')}` : `${sourceFiles} 个源文件 + ${testFiles} 个测试文件`}; PATH 上有 ${runnersOnPath.join('/')}`
      : runnersOnPath.length === 0
        ? `不启用: 有证据 (${hasStrong ? markers.join('/') : `${sourceFiles} 源 / ${testFiles} 测试`}) 但 ${spec.runners.join('/')} 一个都不在 PATH 上 —— 判据写了也跑不起来`
        : '不启用: 仓里没有这门语言的证据';
    languages.push({ language: spec.id, markers, sourceFiles, testFiles, runnersOnPath, runnersMissing, enabled, why });
  }
  // 强证据的语言排前面, 其次按源文件数 —— 候选命令的顺序即"该先试哪条"。
  languages.sort((a, b) => (b.markers.length - a.markers.length) || (b.sourceFiles - a.sourceFiles));
  const enabledBins = [...new Set(languages.filter((l) => l.enabled).flatMap((l) => l.runnersOnPath))];
  const testCommandCandidates = languages
    .filter((l) => l.enabled)
    .flatMap((l) => LANG_SPECS.find((s) => s.id === l.language)!.testCommands(l.runnersOnPath));
  return {
    root,
    languages,
    web: probeWebFacts(root, env),
    enabledBins,
    testCommandCandidates: [...new Set(testCommandCandidates)],
    scanned: { files: scan.files, dirs: scan.dirs, truncated: scan.truncated, unreadable: scan.unreadable },
  };
}

const WEB_ENTRY_CANDIDATES = ['index.html', 'public/index.html', 'src/index.html', 'dist/index.html', 'www/index.html'];

/** playwright-core 从**引擎**的依赖解析 (目标仓不必装); 缺 → false, 不抛。 */
function enginePlaywrightResolvable(): boolean {
  try {
    return typeof import.meta.resolve('playwright-core') === 'string';
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, '[env-facts] playwright-core 解析不到 → web oracle 不可用');
    return false;
  }
}

/** Web 页面仓事实 (契约 D-4)。零 LLM; 只看盘。 */
export function probeWebFacts(root: string, env: Record<string, string | undefined> = process.env): WebFacts {
  const entry = WEB_ENTRY_CANDIDATES.find((rel) => existsSync(join(root, rel))) ?? null;
  const browsersDir = env.PLAYWRIGHT_BROWSERS_PATH?.trim() || join(env.HOME || homedir(), '.cache', 'ms-playwright');
  let hasChromium = false;
  try {
    hasChromium = existsSync(browsersDir) && readdirSync(browsersDir).some((d) => d.startsWith('chromium'));
  } catch (err) {
    // 目录读不动 = 没浏览器 (fail-closed: 判据写了也跑不起来); 原文留一行 (§静默坑 2)。
    logger.debug({ browsersDir, err: err instanceof Error ? err.message : String(err) }, '[env-facts] 浏览器目录读不动 → web oracle 不可用');
    hasChromium = false;
  }
  return { entry, playwright: hasChromium && enginePlaywrightResolvable(), browsersDir };
}

/**
 * **单一来源** (review 抓到的 P2c 缺口, 2026-09-02): 运行期白名单 = marker 表
 * (`allowlistForRoot`) ∪ 真探测启用的 bin (`probeEnvFacts(...).enabledBins`)。
 * 之前 `src/mcp/assemble.ts`(command 节点)与 `src/harness/agent-leaf.ts`(self_check)
 * 各自 inline 一份同样的 union —— 两处独立算同一件事, 改一处漏另一处就是「假红」。
 * 调用方仍各自决定要不要在 extra 非空时打日志 (口径不同: assemble.ts 打 `[omd/mcp]`,
 * self_check 打 `[agent-leaf]`), 所以日志不放进这个纯函数里。
 */
export function runtimeAllowlistForRoot(root: string, env: Record<string, string | undefined> = process.env): string[] {
  const base = allowlistForRoot(root);
  const extra = probeEnvFacts(root, env).enabledBins.filter((b) => !base.includes(b));
  return [...base, ...extra];
}

/**
 * **语言一致判定的真探测版** —— 与 `command-leaf.languageConsistencyBlockReason` 同一条纪律
 * (「别用这个仓没有的语言写判据」), 只是把证据从"根下有没有那个打包文件"换成了实测。
 *
 * ⚠ 这道**不能**在接真探测时省掉。第一版就是省掉它然后被既有测试当场抓住:
 * python 仓写 `bun test` 会一路放行 —— 因为 `bun` 本来就在 base 白名单里, allowlist 那道拦不住它。
 * 拦得住的一直是语言一致这一道, 换证据可以, 拿掉不行。
 *
 * @returns null = 一致 (或该词不属于任何语言); 否则一行拒因。
 */
export function languageConsistencyFromFacts(command: string, facts: EnvFacts): string | null {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const bin = first.includes('/') ? first.slice(first.lastIndexOf('/') + 1) : first;
  if (!bin) return null;
  const owning = LANG_SPECS.filter((s) => s.runners.includes(bin));
  if (owning.length === 0) return null; // base-only 词 (grep / cat / git …) 不判
  const enabled = new Set(facts.languages.filter((l) => l.enabled).map((l) => l.language));
  if (owning.some((s) => enabled.has(s.id))) return null;
  const want = owning.map((s) => s.id).join('/');
  const got = [...enabled].join('/') || '(一门都没启用)';
  return (
    `[blocked lang-mismatch: 命令首词 '${bin}' 属 ${want}, 但这个仓实测启用的是 ${got} ` +
    `(证据: ${facts.languages.map((l) => `${l.language} ${l.sourceFiles}源/${l.testFiles}测试${l.enabled ? '·启用' : '·未启用'}`).join(', ') || '无'})]`
  );
}

/** 给 prompt 用的一段人话事实。空仓 → 明说"探不出", 不编。 */
export function renderEnvFacts(f: EnvFacts): string {
  if (f.languages.length === 0) {
    const head = `仓环境探测 (${f.root}): 没有检出任何已知语言的证据${f.scanned.truncated ? ' (扫描被上限截断, 结论可能不全)' : ''}。`;
    // 纯 html 仓正是这一格 (零 js 语言证据): web 事实照报, 否则分类器读到「没有任何证据」就往 exploratory 靠。
    return f.web?.entry
      ? `${head}\n  · web: 入口 \`${f.web.entry}\`; 浏览器 ${f.web.playwright ? '可用 (chromium 在)' : `不可用 (${f.web.browsersDir} 无 chromium)`}`
      : head;
  }
  const lines = [`仓环境探测 (${f.root}, 扫了 ${f.scanned.files} 个文件${f.scanned.truncated ? ', **被上限截断**' : ''}):`];
  for (const l of f.languages) {
    lines.push(`  · ${l.language}: ${l.why}`);
  }
  lines.push(
    f.testCommandCandidates.length > 0
      ? `  验收命令候选 (按证据强弱): ${f.testCommandCandidates.map((c) => `\`${c}\``).join(' · ')}`
      : '  验收命令候选: (探不出 —— 别硬凑一条跑不起来的)',
  );
  if (f.web?.entry) {
    lines.push(`  · web: 入口 \`${f.web.entry}\`; 浏览器 ${f.web.playwright ? '可用 (chromium 在)' : `不可用 (${f.web.browsersDir} 无 chromium)`}`);
  }
  return lines.join('\n');
}
