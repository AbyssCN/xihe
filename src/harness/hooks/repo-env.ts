/**
 * hooks/repo-env —— **这个仓的 env 与凭据怎么进 jail**(2026-09-05)。
 *
 * ## 它治的病:能跑的命令,在 jail 里跑不起来,而且看不出为什么
 *
 * `render-command` 让引擎知道了「这个仓怎么把自己渲染成像素」,但那条命令真到 jail 里执行时
 * 常常**起不来**,因为它要的东西按定义不在 worktree 里:
 *
 * | 要的 | 为什么 jail 里没有 |
 * |---|---|
 * | `apps/web/.env.local` 一类 | 被 gitignore ⇒ `git worktree add` 出来的树**不带它** |
 * | `~/.config/<产品>/` 下的凭据 | jail 的 `HOME=/tmp`,宿主 HOME 没挂 |
 *
 * 症状与 `hooks/toolchain` 治的那两条同形:**挂载面不完整会伪装成「模型不行」或「这仓本来就跑不通」**。
 * 实账(plana):浏览器驱动审查在宿主上全绿,进 jail 直接起不来 —— 缺的是两个文件,不是能力。
 *
 * ## 只认显式声明,不自动发现
 *
 * `.omd/config.json`:
 * ```json
 * { "env": { "files": ["apps/web/.env.local"], "homePaths": [".config/plana"] } }
 * ```
 * · `files` —— 仓内被 gitignore 的文件,**拷进 worktree** 同一相对位置。
 * · `homePaths` —— 宿主 HOME 下的相对路径,**ro-bind 进 jail 的 HOME** 同一相对位置。
 *
 * ⚠ **绝不自动把探到的 `.env*` 挂进去**。jail 存在的一半理由就是限制外泄面,而"帮你自动挂上
 * 所有像密钥的东西"是把这半个理由拆掉,还没人按过同意。探到了只产**一句能照做的建议**,
 * 与 `render-command` 的两档分界同一条纪律:宁可少挂一次,也不替 owner 决定把密钥递进沙箱。
 *
 * ⚠ 三条边界在 {@link resolveRepoEnv} 里硬判:路径必须相对、不许 `..` 逃逸、**一律 ro**。
 * 一个能写 `"files": ["../../.ssh/id_rsa"]` 的配置项等于给自己开了个任意读取口。
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';

/** 一次 HOME 相对项的绑定:宿主真身 → jail 内 HOME 下同一相对位置。 */
export interface HomeBind {
  src: string;
  dest: string;
}

export interface RepoEnvBinds {
  /** 仓内要拷进 worktree 的文件(相对仓根,已过边界判)。 */
  files: string[];
  /** HOME 下 ro-bind 的项(已过边界判 + 存在性判)。 */
  homeBinds: HomeBind[];
  /** 声明了但盘上不存在的项 —— 留证,不静默(缺席 ≠ 没声明)。 */
  missing: string[];
  /** 没有声明时的一句建议;有声明则为 null。 */
  suggestion: string | null;
}

export interface RepoEnvDeps {
  home?: string;
  /** jail 里的 HOME —— bwrapArgs 设的是 `/tmp`。 */
  jailHome?: string;
  exists?: (p: string) => boolean;
  readText?: (p: string) => string;
}

/** 常见的、被 gitignore 之后 worktree 就没有的 env 文件名(只用于**产建议**,不用于自动挂载)。 */
const ENV_HINTS = ['.env.local', '.env', 'apps/web/.env.local', '.env.development.local'];

const HOW_TO_DECLARE =
  '在 `.omd/config.json` 里加 `"env": { "files": ["<仓内被 gitignore 的相对路径>"], "homePaths": ["<宿主 HOME 下的相对路径>"] }`' +
  ' —— files 会拷进隔离 worktree, homePaths 会**只读**挂进 jail 的 HOME。' +
  '⚠ 这等于把这些内容递进沙箱, 由你决定, 引擎不替你自动挂。';

/**
 * 相对且不逃逸 —— 绝对路径与 `..` 一律拒。
 * 一个能写 `"../../.ssh/id_rsa"` 的配置项等于任意读取口(见模块头 ⚠)。
 */
function safeRel(rel: string): boolean {
  if (typeof rel !== 'string' || !rel.trim()) return false;
  if (isAbsolute(rel)) return false;
  const n = normalize(rel);
  return n !== '..' && !n.startsWith(`..${sep}`);
}

/**
 * 读这个仓声明了什么 env / 凭据要进 jail。**零副作用**, 只读文件。
 *
 * 没声明 → `files`/`homeBinds` 空 + 一句建议(如果探到像 env 的文件)。
 */
export function resolveRepoEnv(root: string, deps: RepoEnvDeps = {}): RepoEnvBinds {
  const exists = deps.exists ?? existsSync;
  const readText = deps.readText ?? ((p: string) => readFileSync(p, 'utf8'));
  const home = deps.home ?? homedir();
  const jailHome = deps.jailHome ?? '/tmp';

  const out: RepoEnvBinds = { files: [], homeBinds: [], missing: [], suggestion: null };

  let cfg: Record<string, unknown> | null = null;
  const p = join(root, '.omd', 'config.json');
  if (exists(p)) {
    try {
      const v: unknown = JSON.parse(readText(p));
      if (typeof v === 'object' && v !== null) cfg = v as Record<string, unknown>;
    } catch {
      cfg = null; // 坏 JSON 不该崩掉整次装配 (fail-open, 同 render-command)
    }
  }
  const env = cfg?.env;
  const decl = typeof env === 'object' && env !== null ? (env as { files?: unknown; homePaths?: unknown }) : null;

  const files = Array.isArray(decl?.files) ? decl.files : [];
  const homePaths = Array.isArray(decl?.homePaths) ? decl.homePaths : [];

  if (files.length === 0 && homePaths.length === 0) {
    const hint = ENV_HINTS.find((h) => exists(join(root, h)));
    out.suggestion = hint
      ? `探到 \`${hint}\` —— 它被 gitignore 时**隔离 worktree 里不会有**, 需要它的命令在 jail 里会起不来。${HOW_TO_DECLARE}`
      : null;
    return out;
  }

  for (const f of files as unknown[]) {
    if (typeof f !== 'string' || !safeRel(f)) {
      out.missing.push(`拒绝(路径必须相对且不含 ..): ${String(f)}`);
      continue;
    }
    if (!exists(join(root, f))) {
      out.missing.push(`声明了但盘上没有: ${f}`);
      continue;
    }
    out.files.push(f);
  }

  for (const h of homePaths as unknown[]) {
    if (typeof h !== 'string' || !safeRel(h)) {
      out.missing.push(`拒绝(路径必须相对且不含 ..): ${String(h)}`);
      continue;
    }
    const src = join(home, h);
    if (!exists(src)) {
      out.missing.push(`声明了但宿主 HOME 下没有: ~/${h}`);
      continue;
    }
    out.homeBinds.push({ src, dest: join(jailHome, h) });
  }

  return out;
}

/** 压成一句进日志/降级理由的话。**只报路径不报内容**。 */
export function describeRepoEnv(b: RepoEnvBinds): string {
  if (b.suggestion) return b.suggestion;
  const parts: string[] = [];
  if (b.files.length) parts.push(`拷进 worktree ${b.files.length} 个: ${b.files.join(', ')}`);
  if (b.homeBinds.length) parts.push(`ro-bind 进 jail HOME ${b.homeBinds.length} 个: ${b.homeBinds.map((h) => h.dest).join(', ')}`);
  if (b.missing.length) parts.push(`未生效 ${b.missing.length} 条: ${b.missing.join(' · ')}`);
  return parts.length ? parts.join(' · ') : '本仓没声明 env/凭据直通。';
}
