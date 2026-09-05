/**
 * **零写入闸** (D-1, 契约 `docs/plan/2026-09-05-假success三闸-执行契约.md`)。
 *
 * 盘上事实: 五批 400 个 run 里 18 个 `agent.patch` 零行, 其中 11 个终态 `success` ——
 * 引擎日志里「图外观察者」已经写过「声明了 write_set 却没有产物写入磁盘」, 终态仍是 success。
 * 收敛判定成立而工作树一个字节都没动, 那不是交付, 是一份没有产物支撑的自述。
 *
 * 判定纯逻辑摆在这里, run-goal.ts 那一端只负责喂参数与执行结论 —— 终态区是单文件热区,
 * 判据混进去就再也单测不着 (与 `rubricAcceptanceUnwired` 同一条惯例)。
 *
 * ⚠ 三态 (仓规坑 ①: NULL ≠ 0 ≠ 不适用): 「没查」「查了非零」「查了为零」是三件事。
 * resume 与「git 取不到」都落「没查」, 靠 `why` 分辨, **不许**编一个 `zero: false` 把它们抹平。
 */

export interface ZeroWriteInput {
  converged: boolean;
  isResume: boolean;
  changed: { files: string[] } | { error: string };
}

export interface ZeroWriteVerdict {
  /** 查过盘没有。resume / 取不到 ⇒ false。 */
  checked: boolean;
  /** checked 为真时:盘上是否零改动。 */
  zero?: boolean;
  /** 没查或查到零改动时的一句原因。 */
  why?: string;
  /** 闸的裁决:为真 ⇒ 调用方把 converged 压成 false。 */
  block: boolean;
}

/** D-1 零写入的终态字面, 与 `TERMINAL_RUBRIC_UNWIRED` 同款 (不新开 `RunOutcomeKind`)。 */
export const TERMINAL_ZERO_WRITE = 'zero-write';

/**
 * 收敛判定成立且首跑且盘上零改动 ⇒ `block`。其余一律不拦。
 *
 * **resume 豁免的理由**: 续跑前那一段工作可能已被 `#165②` 自动收编进 commit, 此时工作树
 * 干净而目标已达成 —— 拿它当零写入是误伤。
 *
 * **取不到证据不等于零写入**: `changed` 是 `error` 时 fail-open 放行, 但错误原文进 `why`
 * (仓规静默坑 ②: 可以吞异常, 不许吞证据)。
 */
export function zeroWriteVerdict(input: ZeroWriteInput): ZeroWriteVerdict {
  if (!input.converged) return { checked: false, block: false, why: '未收敛 (闸只问收敛判定成立的跑)' };
  if (input.isResume) return { checked: false, block: false, why: 'resume' };
  if ('error' in input.changed) {
    return { checked: false, block: false, why: `盘上改动取不到, 不拦: ${input.changed.error}` };
  }
  const delivered = input.changed.files.filter((f) => !isEngineTrace(f));
  if (delivered.length > 0) return { checked: true, zero: false, block: false };
  // 两种零写入**分两句念** (仓规坑 ①): 「git status 本来就空」与「只剩引擎自己的留痕」是
  // 不同的现场, 压成同一句话事后再也分不开是哪一种。
  return {
    checked: true,
    zero: true,
    block: true,
    why:
      input.changed.files.length > 0
        ? '收敛判定成立但盘上只有引擎自己的 `.omd/` 留痕, 没有任何交付产物'
        : '收敛判定成立但盘上没有任何改动 (git status 空)',
  };
}

/**
 * `.omd/` 下的一律不算产物 —— 与 `run-goal.ts` 的 `collectTouchedPaths`
 * (「越出 cwd 的、以及 `.omd/` 下的 (引擎自己的留痕库) 一律不收」) 同一条纪律。
 *
 * **为什么闸这一侧必须自己剔**: 上游 `collectChangedFiles` 只滤 `!!` (被忽略的), 而 bench
 * 容器里 `.omd/` **不在 .gitignore 里**, 于是 `git status --porcelain` 恒有一行 `?? .omd/`
 * (实测原文: `code80-nofreeze/2026-09-05__14-14-11/product_analytics-hard-ab_test_a__e2zgULK/`
 * 那题 `agent/omd-output.txt` 末尾的「post-solve git state」只有这一行, 而同题
 * `verifier/agent.patch` 0 字节、终态 `outcome: success`)。
 * 不剔 = 这道闸在生产里恒 `zero:false` = 一条永远绿的闸。
 *
 * ⚠ 剔在**闸这一侧**, 不去动 `collectChangedFiles` 本身: 那个函数还给 rubric 判官的产物
 * 证据面用, 那边要不要看 `.omd/` 是另一件事, 顺手改会把两处判据绑死。
 *
 * 判据 = **首段**是 `.omd` (`.omd/` · `.omd/x` · `./.omd/x` 都算), 不是"路径里含 .omd" ——
 * 后者会连 `src/.omdrc` 这种真文件一起剔掉。
 */
function isEngineTrace(file: string): boolean {
  const rel = file.startsWith('./') ? file.slice(2) : file;
  return rel.split(/[\\/]/)[0] === '.omd';
}
