/**
 * model/env-discovery —— **凭据从哪来**(2026-09-05)。
 *
 * ## 它治的病:换个仓,omd 就一个 provider 都没有
 *
 * Bun 只从 **cwd** 自动加载 `.env`。于是:在 omd 自己仓里跑什么都好,`cd` 到任何别的仓再跑
 * `omd run`,`providers=[⚠空]`,所有 agent 叶子无密钥可用、**整个 run 烧完才失败**。
 *
 * 实账(2026-09-05,plana):run `3e572428` 跑满 **26m16s** 后判「所有 leaf 执行失败 — 计划无产出」。
 * 根因就是这一条。用户侧的"解法"是给每个仓拷一份 `.env` —— 那是把密钥散到每个仓,
 * 既麻烦又是外泄面。
 *
 * 这与 `hooks/toolchain` / `hooks/repo-env` 是同一种病的第三张脸:
 * **引擎知道自己要什么,却只在一个地方找。**
 *
 * ## 发现链(形状照抄 `role-models.readConfigPath`,那是本仓已立的先例)
 *
 * | 序 | 位置 | 语义 |
 * |---|---|---|
 * | ① | `OMD_ENV_FILE` | **显式即权威**,给了就只用它,不回落(同 `OMD_CONFIG_PATH`) |
 * | ② | `<cwd>/.env` | 本仓优先 —— 仓内那份**不许被家目录劫持** |
 * | ③ | `<OMD_DATA_HOME ?? ~/.omd>/.env` | **用户全局**,与 `~/.omd/config.json` 同锚点。这是"配一次到处能跑"的正解 |
 * | ④ | omd 安装目录的 `.env` | 兜底:`bun link` 自仓的装法(装目录 = 源码仓)下,老用户的 `.env` 就在那儿 |
 *
 * **先到先得,后面的不覆盖前面的**。Bun 已把 `<cwd>/.env` 灌进 `process.env`,所以
 * "不覆盖已存在的键"天然给出上面的优先序 —— 仓内的值永远赢。
 *
 * ⚠ 回落必须**出声**(INV-7 不静默降级,同 `readConfigPath` 那行 warn 的理由):
 * 配置从哪来的最难查,所以每次用了非 cwd 的那份都报出绝对路径。
 * ⚠ **只报路径与键数,永不报值**。这个模块碰的每一行都是密钥。
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../harness/logger';

/** 一个候选位置。 */
export interface EnvCandidate {
  path: string;
  /** 给日志与判词用 —— "这份是从哪一档来的"。 */
  source: 'explicit' | 'cwd' | 'home' | 'install';
}

/** 一次真加载的结果。**不含值**。 */
export interface EnvFileLoad {
  path: string;
  source: EnvCandidate['source'];
  /** 本文件里被采纳的键数(已存在的键不覆盖,不计入)。 */
  applied: number;
  /** 文件里解析出来但**已存在**因而跳过的键数 —— 优先序生效的证据。 */
  skipped: number;
}

export interface EnvDiscoveryDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  exists?: (p: string) => boolean;
  readText?: (p: string) => string;
  /** omd 安装目录(测试注入);缺省从本模块位置向上找到含 package.json 的那层。 */
  installDir?: string | null;
}

/** 本模块所在的包根 —— 含 `package.json` 的最近一层。找不到 → null。 */
function defaultInstallDir(exists: (p: string) => boolean): string | null {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return null; // 打包成单文件等场景拿不到 —— 少一档候选, 不是错误
  }
  for (let i = 0; i < 6; i++) {
    if (exists(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * 按优先序列出**存在的**候选。`OMD_ENV_FILE` 在场 → 只返它(显式即权威,不回落;
 * 哪怕指向不存在的文件也不悄悄换一个,同 `readConfigPath` 的 `OMD_CONFIG_PATH` 语义)。
 */
export function discoverEnvFiles(deps: EnvDiscoveryDeps = {}): EnvCandidate[] {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? homedir();
  const exists = deps.exists ?? existsSync;

  const explicit = env.OMD_ENV_FILE?.trim();
  if (explicit) return [{ path: resolve(explicit), source: 'explicit' }];

  const out: EnvCandidate[] = [];
  const push = (path: string, source: EnvCandidate['source']): void => {
    if (!exists(path)) return;
    if (out.some((c) => c.path === path)) return; // 同一份文件不重复加载(cwd 恰好是安装目录时)
    out.push({ path, source });
  };

  push(join(cwd, '.env'), 'cwd');
  const dataHome = env.OMD_DATA_HOME?.trim() || join(home, '.omd');
  push(join(dataHome, '.env'), 'home');
  const install = deps.installDir !== undefined ? deps.installDir : defaultInstallDir(exists);
  if (install) push(join(install, '.env'), 'install');
  return out;
}

/**
 * 解析 `.env` 文本 → 键值对。**按第一个 `=` 切**,右侧原样(只脱一层配对引号)。
 *
 * ⚠ 右侧原样是硬要求:实账里有一行的值是含 `;` `:` 的 cookie 串。
 * 想省事 `source` 一下的人会被 shell 当成命令逐段执行 —— 那不是假想,2026-09-05 真发生过。
 * 所以引擎自己解析,永远不经 shell。
 */
export function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    let t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('export ')) t = t.slice(7).trim();
    const eq = t.indexOf('=');
    if (eq <= 0) continue; // 没有 `=` 或以 `=` 开头 —— 不是赋值行
    const k = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    let v = t.slice(eq + 1).trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out.set(k, v);
  }
  return out;
}

/**
 * 把发现到的 `.env` 灌进 `env`(缺省 `process.env`),**先到先得,不覆盖已存在的键**。
 *
 * 在 `registerProvidersFromEnv()` **之前**调用。返回每份文件的来源与键数(不含值)。
 */
export function loadDiscoveredEnv(deps: EnvDiscoveryDeps = {}): EnvFileLoad[] {
  const env = deps.env ?? process.env;
  const readText = deps.readText ?? ((p: string) => readFileSync(p, 'utf8'));
  const loads: EnvFileLoad[] = [];

  for (const c of discoverEnvFiles(deps)) {
    let parsed: Map<string, string>;
    try {
      parsed = parseEnvText(readText(c.path));
    } catch (e) {
      // fail-open 吞异常不吞证据: 一份读不动的 .env 不该让引擎起不来, 但原文必须出得来。
      logger.warn({ path: c.path, err: (e as Error).message.slice(0, 200) }, '[omd/env] .env 读不动 (跳过这一份)');
      continue;
    }
    let applied = 0;
    let skipped = 0;
    for (const [k, v] of parsed) {
      if (env[k] !== undefined) {
        skipped++; // 已存在 = 更高优先的那一档给过了 (Bun 自动加载的 cwd/.env 也走这条)
        continue;
      }
      env[k] = v;
      applied++;
    }
    loads.push({ path: c.path, source: c.source, applied, skipped });
  }

  // 用了 cwd 之外的那份就必须出声 —— 配置从哪来的最难查 (INV-7, 同 readConfigPath 那行 warn)。
  // ⚠ 判词必须把**三档分开**: 第一版写成 `source === 'home' ? '家目录' : '安装目录'`,
  //   于是 explicit 被印成"安装目录" —— 而我恰好拿安装目录那份文件做实验, 路径也一样,
  //   读日志根本分不出 `--env-file` 到底生没生效。判词把两种情况印成同一句 = 它没有判别力。
  const LABEL: Record<EnvCandidate['source'], string> = {
    explicit: 'OMD_ENV_FILE/--env-file 显式指定',
    cwd: '本仓',
    home: '家目录',
    install: '安装目录',
  };
  for (const l of loads) {
    if (l.source === 'cwd' || l.applied === 0) continue;
    logger.warn(
      { path: l.path, source: l.source, applied: l.applied },
      `[omd/env] 从**${LABEL[l.source]}**取了 ${l.applied} 个键: ${l.path}`,
    );
  }
  return loads;
}

/** 压成一句进日志/回执的话。**只报路径与键数,永不报值**。 */
export function describeEnvLoads(loads: readonly EnvFileLoad[]): string {
  if (loads.length === 0) {
    return (
      '没找到任何 .env —— 依次找过 `<cwd>/.env` · `~/.omd/.env` · 安装目录。' +
      '建议把 provider 密钥放 `~/.omd/.env`(配一次, 任何仓都能跑)。'
    );
  }
  return loads.map((l) => `${l.source}:${l.path} (+${l.applied}${l.skipped ? `, 跳过 ${l.skipped} 个已存在` : ''})`).join(' · ');
}
