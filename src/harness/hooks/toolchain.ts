/**
 * hooks/toolchain —— **仓的技术栈 → jail 要挂什么**(2026-09-04)。
 *
 * ## 它治的病:引擎已经知道这是什么仓,却不给 jail 绑对应的东西
 *
 * `omd_env` 早就会探测仓的生态(对 plana 报的是「js: PATH 上有 bun/node/npx · python: 21 个源文件
 * + PATH 上有 python3/uv」),但**那份探测结果从来没喂给 bwrap 的绑定组装**。于是 jail 的挂载面
 * 是按 omd 自己仓的样子写死的,换个技术栈就少东西 —— 而少东西不会安静失败:
 *
 * | 实账 | 少了什么 | 症状 |
 * |---|---|---|
 * | 2026-09-04 plana,四个 run 零产出 | jail PATH 只有 bun,没有 node | `npx tsc` command not found → 叶子用 bun 顶替 → 假报 38 个测试失败 → 基线不可复现 |
 * | 同上 | `apps/web/node_modules`(见 run-worktree #205-bis) | 叶子跑 `npm install` 自救,把 workspace 软链改写坏 |
 *
 * 共同点:**挂载面不完整会伪装成「模型不行」或「仓本来就是脏的」**,而那是最贵的一种误诊 ——
 * 它把账记到模型头上,于是下一步是"换池/加时间",而不是"补一条 bind"。
 *
 * ## 形状:一张表,新生态是加一行
 *
 * 每个生态声明三件事 —— 靠什么认出它、要哪些可执行在 PATH 上、HOME 下哪些缓存/配置要绑。
 * 只有 marker 命中的生态才参与,所以一个 JS 仓不会被绑上 `~/.cargo`(挂载面保持最小)。
 *
 * ## 边界:这里只管"给不给得到",不管"够不够用"
 *
 * ⚠ **Playwright 已实测能跑**(2026-09-04,plana 的 `npm run test:design` 五套 Playwright 在真 bwrap
 * jail 里 `ALL SUITES PASSED`)。此前担心 bwrap 的 `--dev /dev` 没有 `/dev/shm` 会让 Chromium 崩 ——
 * **实测没有成真**,不再当成待办。若换个仓真撞上,解法是仓侧的 `--disable-dev-shm-usage`,
 * 不是本模块再多挂一层。
 *
 * @module
 */
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 一个生态要什么。 */
export interface EcosystemSpec {
  id: string;
  /** root 下存在任一即认为用到这个生态(只看一级,marker 都在仓根)。 */
  readonly markers: readonly string[];
  /** 要在 jail PATH 上的可执行。第一个在宿主 PATH 上找得到的,决定绑哪个安装根。 */
  readonly executables: readonly string[];
  /** HOME 下要 ro-bind 的相对路径(缓存/配置)。存在才绑;jail 内落在同样的相对位置。 */
  readonly homePaths: readonly string[];
}

/**
 * 生态表。**加新生态 = 加一行**,不改任何逻辑。
 *
 * ⚠ 分两档,别混:
 * · 本机**实测过**的:`node`(plana 那四个 run 的现场)。
 * · **只是表项、尚未在真仓上跑过**的:`pnpm` / `python` / `rust` / `go` / `jvm` / `ruby`。它们的 `homePaths` 是各生态的公认默认位置,
 *   但"绑了就一定能跑"没有被证过 —— 第一个用到的人会是第一个证它的人。这一格刻意写明,
 *   因为「没测」与「测过且通过」必须分得开(本仓第五次为同一条纪律付账)。
 */
export const ECOSYSTEMS: readonly EcosystemSpec[] = [
  {
    id: 'node',
    markers: ['package.json'],
    executables: ['node'],
    // ms-playwright: 浏览器二进制默认落这儿, 不绑则 `playwright test` 起不来 (见模块头 ⚠)。
    // .npmrc: 私有 registry 的 token 在这儿, 不绑则 jail 里装不了包 (HOME=/tmp 后 ~ 指不到)。
    homePaths: ['.cache/ms-playwright', '.cache/puppeteer', '.npmrc'],
  },
  {
    id: 'pnpm',
    markers: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    executables: ['pnpm'],
    // pnpm 的 node_modules 里全是指向 store 的软链 —— **绑了 node_modules 也没用, store 才是真身**。
    homePaths: ['.local/share/pnpm/store', '.pnpm-store', '.cache/pnpm'],
  },
  {
    id: 'python',
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'],
    executables: ['python3', 'python'],
    homePaths: ['.cache/uv', '.local/share/uv', '.pyenv', '.cache/pip'],
  },
  {
    id: 'rust',
    markers: ['Cargo.toml'],
    executables: ['cargo'],
    homePaths: ['.cargo', '.rustup'],
  },
  {
    id: 'go',
    markers: ['go.mod'],
    executables: ['go'],
    homePaths: ['go/pkg/mod', '.cache/go-build'],
  },
  {
    id: 'jvm',
    markers: ['build.gradle', 'build.gradle.kts', 'pom.xml'],
    executables: ['gradle', 'mvn', 'java'],
    homePaths: ['.gradle', '.m2'],
  },
  {
    id: 'ruby',
    markers: ['Gemfile'],
    executables: ['ruby'],
    homePaths: ['.rbenv', '.gem', '.bundle'],
  },
];

/**
 * 与生态无关、**每个仓都要**的 HOME 项。
 *
 * `.gitconfig`: jail 里 `git commit` 缺 user.name/email 直接 `Please tell me who you are` ——
 * 而 omd 的设计是「判据绿会在树内自动收编成 commit」,少了它那一步在 jail 里做不成。
 */
export const UNIVERSAL_HOME_PATHS: readonly string[] = ['.gitconfig'];

/** 某个可执行在宿主上的位置。 */
export interface ExecToolchain {
  /** 含该可执行的目录(真身)—— 进 jail 的 PATH。 */
  binDir: string;
  /** binDir 的父 —— 含 `bin/` 与 `lib/`,**要绑的是这个**。 */
  rootDir: string;
}

/**
 * 从**宿主** PATH 上找 `name`,返它的 bin 目录与安装根。找不到 → null。
 *
 * ⚠ 绑的是**安装根不是 bin**:`npm`/`npx` 是指向 `../lib/node_modules/npm/bin/*.js` 的**相对**软链,
 * 只绑 bin 目录时那条链在 jail 里断掉(手工绕过这个 bug 时原样踩过一次:node 能跑而 npm 找不到)。
 *
 * ⚠ 取 realpath 再取 dirname,不直接用 PATH 上那一段:fnm/nvm/asdf 在 PATH 上放的是**每 shell
 * 即弃**的目录(`/run/user/…/fnm_multishells/…`),那个路径在别的进程里根本不存在。
 */
export function findExecToolchain(name: string, env: NodeJS.ProcessEnv = process.env): ExecToolchain | null {
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const cand = join(dir, name);
    if (!existsSync(cand)) continue;
    const real = tryRealpath(cand);
    if (!real.path) continue; // real.err = 竞态/权限;继续找 PATH 的下一段
    const binDir = dirname(real.path);
    return { binDir, rootDir: dirname(binDir) };
  }
  return null;
}

/** realpath,**把失败原因经返回值交出去**(仓规 §静默坑 2:fail-open 可以,吞证据不行)。 */
function tryRealpath(p: string): { path: string; err?: undefined } | { path?: undefined; err: string } {
  try {
    return { path: realpathSync(p) };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

/** root 用到哪些生态(marker 命中即算)。 */
export function detectEcosystems(root: string, exists: (p: string) => boolean = existsSync): EcosystemSpec[] {
  return ECOSYSTEMS.filter((s) => s.markers.some((m) => exists(join(root, m))));
}

/** HOME 相对项的一次绑定:宿主真身 → jail 内 HOME 下同一相对位置。 */
export interface HomeBind {
  src: string;
  dest: string;
}

export interface ToolchainBinds {
  /** 进 jail PATH 的目录(宿主绝对路径),按生态表顺序。 */
  pathDirs: string[];
  /** 同路径 ro-bind 的宿主目录(可执行的安装根)。 */
  roBinds: string[];
  /** HOME 下的缓存/配置:`--ro-bind src dest`,dest 落在 jail 的 HOME 里。 */
  homeBinds: HomeBind[];
  /** 探到的生态 id,给 preflight 与日志用。 */
  ecosystems: string[];
  /** 探到生态但它的可执行**一个都没找到** —— preflight 据此报 warn。 */
  missingExecutables: Array<{ ecosystem: string; wanted: readonly string[] }>;
}

export interface ToolchainDeps {
  env?: NodeJS.ProcessEnv;
  /** 宿主 HOME(测试里注入一个假的)。 */
  home?: string;
  /** jail 里的 HOME —— bwrapArgs 设的是 `/tmp`。 */
  jailHome?: string;
  exists?: (p: string) => boolean;
}

/**
 * 把 root 的技术栈翻译成 jail 要加的挂载与 PATH。
 *
 * 只有 marker 命中的生态才参与 —— 一个 JS 仓不会被绑上 `~/.cargo`(挂载面保持最小,
 * 而挂载面每宽一格, 隔离就松一格)。
 */
export function resolveToolchainBinds(root: string, deps: ToolchainDeps = {}): ToolchainBinds {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const jailHome = deps.jailHome ?? '/tmp';
  const exists = deps.exists ?? existsSync;

  const pathDirs: string[] = [];
  const roBinds: string[] = [];
  const homeBinds: HomeBind[] = [];
  const ecosystems: string[] = [];
  const missingExecutables: ToolchainBinds['missingExecutables'] = [];

  const addHome = (rel: string): void => {
    const src = join(home, rel);
    if (!exists(src)) return;
    homeBinds.push({ src, dest: join(jailHome, rel) });
  };

  for (const spec of detectEcosystems(root, exists)) {
    ecosystems.push(spec.id);
    const tc = spec.executables.map((n) => findExecToolchain(n, env)).find((t): t is ExecToolchain => t !== null);
    if (tc) {
      pathDirs.push(tc.binDir);
      roBinds.push(tc.rootDir);
    } else {
      missingExecutables.push({ ecosystem: spec.id, wanted: spec.executables });
    }
    for (const rel of spec.homePaths) addHome(rel);
  }
  for (const rel of UNIVERSAL_HOME_PATHS) addHome(rel);

  return {
    pathDirs: [...new Set(pathDirs)],
    roBinds: [...new Set(roBinds)],
    homeBinds,
    ecosystems,
    missingExecutables,
  };
}
