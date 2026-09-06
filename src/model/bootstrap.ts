/**
 * src/model/bootstrap.ts — 短命进程 (dag-* 脚本) 的统一模型运行时引导。
 *
 * 背景: TUI (tui.ts) 启动时 registerProvidersFromEnv() + registerProvidersFromModelsJson(),
 * 但 dag-* 脚本是独立短命进程, 需要同一套引导。本模块把这两件事收成一个调用
 * bootstrapModelRuntime(), 每个脚本一行完成:
 *   ① registerProvidersFromEnv()            — 内置 provider 注册 (deepseek/mimo/… from .env)
 *   ② registerProvidersFromModelsJson()     — 自定 provider (~/.pi/agent/models.json, 统一-registry 单一真源) 叠加
 *
 * 返回值 = 全部注册成功的 provider 名数组。
 *
 * env 可见性那一行 **2026-08-12 起只在异常时出声**(片 C):此前无条件每进程一行,
 * 一天六个 exec.log 里出现六次、一次没被读。摘要没删,是**移位**到 `dag_run` 起跑回执
 * (`envSummaryLine`,与告警共用同一份,不许各拼各的)。判嗓门的判据见 `shouldWarnEnv` 的注。
 */
import '../env-alias';
import { loadDiscoveredEnv } from './env-discovery';
import { registerProvidersFromEnv, registerProvidersFromModelsJson } from './providers';
import { warnUnregisteredRoles } from './role-fallback';
import { readConfigPath } from './role-models';

/**
 * 生产入口的 env 缺省 (2026-09-06)。**只补缺席的键, 不覆盖**; `bun test` (NODE_ENV=test) 下不动 ——
 * 测试与注入调用要的是显式、可数的行为, 缺省在那里会让所有走真 classifyGoal 的假 generate 用例多发两次。
 *
 * · `OMD_CRITERION_CONSENSUS=1`: 三候选共识进基础配置。两次单变量读数 (code80-m3, 1σ=0.035):
 *   consensus2 − survey +0.051 (7 升 1 降) · pathfix-cons − pathfix +0.054 (6 升 2 降)。
 *   引擎函数 `consensusEnabled` 仍只认字面 `1`; 显式 `=0` 是逃生口。
 *
 * 证伪: 去掉这里的 `??=` ⇒ bootstrap-env-defaults.test.ts「缺席 ⇒ 置 1」红。
 */
export function applyProductionEnvDefaults(env: NodeJS.ProcessEnv = process.env, nodeEnv: string | undefined = env.NODE_ENV): string[] {
  if (nodeEnv === 'test') return [];
  const applied: string[] = [];
  if (env.OMD_CRITERION_CONSENSUS === undefined) {
    env.OMD_CRITERION_CONSENSUS = '1';
    applied.push('OMD_CRITERION_CONSENSUS=1');
  }
  return applied;
}

/**
 * 引导短命进程的模型运行时: 内置 provider 注册 + models.json 自定 provider 叠加。
 * @returns 注册的 provider 名数组。
 */
export function bootstrapModelRuntime(): string[] {
  applyProductionEnvDefaults();
  // ⓪ 先把**能找到的** .env 灌进 process.env (2026-09-05)。Bun 只自动加载 cwd 那份, 于是
  //    `cd` 到任何别的仓跑 omd 就 `providers=[⚠空]` —— 整个 run 烧完才失败 (实账 3e572428,
  //    26m16s 零产出)。发现链与优先序见 model/env-discovery 模块头; 不覆盖已存在的键,
  //    所以仓内那份永远赢。必须排在 registerProvidersFromEnv() 之前 —— 它读的就是 process.env。
  loadDiscoveredEnv();
  const registered = registerProvidersFromEnv();
  // ~/.pi/agent/models.json 自定 provider (统一-registry D-2): 于 env 之后 → 单一真源, 同名覆盖。
  const fromModelsJson = registerProvidersFromModelsJson();
  const seen = new Set(registered);
  const all = [...registered];
  for (const id of fromModelsJson) {
    if (!seen.has(id)) {
      seen.add(id);
      all.push(id);
    }
  }
  // 起跑坐席检查 (issue #6): provider 注册完后, 无凭证的角色启动即 WARN (不再跑到一半才炸)。
  warnUnregisteredRoles();
  // ⚠ 2026-08-12 起**只在异常时出声** (片 C)。此前是无条件一行, 每个 dag-exec 子进程、
  // 每个脚本各印一次 —— 一天六个 exec.log 里出现六次, 一次都没被读。摘要没有删掉, 是**移位**:
  // 折进 `dag_run` 起跑回执 (envSummaryLine), 那是有人读的地方。信息不许因为改嗓门而消失。
  if (shouldWarnEnv(all)) process.stderr.write(`[omd env] ${envSummaryLine(all)}\n`);
  return all;
}

/**
 * 这一行该不该出声。**判据刻意只有一条**: provider 一个都没注册上 = `.env` 没配 / 没 propagate,
 * 那是必须立刻看见的事。其余情形它是心跳不是信息。
 *
 * ⚠ 与「四格计数 0 也印」**方向相反**, 是刻意的。判别法:
 * - **分格**回答「这一格是多少」→ 缺席与 0 必须分开, 所以 0 也印 (NULL ≠ 0);
 * - **告警**回答「有没有出事」→ 没出事就该安静, 无条件印只会训练人忽略它。
 * 两者混用的代价各自相反: 分格漏印 → 读的人拿手边最像的数当分母; 告警滥印 → 没人再看。
 */
export function shouldWarnEnv(providers: readonly string[]): boolean {
  return providers.length === 0;
}

/**
 * env 摘要**单一真源** —— 告警与起跑回执共用这一份, 不许各拼各的 (本仓 S-7: 同一条规则
 * 散在多处, 漏掉第三处)。
 *
 * `config=` 那一位是片 C 的全部理由: 2026-08-12 我据 `~/.omd/config.json` 判了一次
 * 「座位 429 会挡住 resume」, 而在仓内跑时生效的是**仓内**那份 —— `role-models.ts:79-88`
 * 向上找、撞到仓根就停, 刻意不越仓边界 (注释原话: 否则一份游离的 `~/.omd/config.json`
 * 会静默劫持)。那次误判的下游是撤了两个健康的 run。把生效路径印出来, 它不可能再发生。
 */
export function envSummaryLine(providers: readonly string[]): string {
  const web = process.env.TAVILY_API_KEY || process.env.ANYSEARCH_API_KEY ? '✓' : '–';
  // 空时要写出**怎么办**, 不能只报「空」—— 一个不带下一步的告警等于噪声。
  const list = providers.length ? providers.join(',') : '⚠空-检查 .env/--env-file';
  let cfg: string;
  try {
    // ⚠ 必须是**读**路径 (readConfigPath): 2026-08-25 加了"本仓无 config 就读家目录"的回落之后,
    //   印写路径会重演上面那段误判 —— 打印的文件与座位实际生效的文件是两个。
    cfg = readConfigPath();
  } catch (e) {
    // 解析不出来本身就是要说的事; 编一个默认路径会让人去看错的文件。
    cfg = `⚠解析失败(${e instanceof Error ? e.message : String(e)})`;
  }
  return `providers=[${list}] · web=${web} · config=${cfg}`;
}
