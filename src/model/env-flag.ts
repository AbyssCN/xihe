/**
 * model/env-flag —— **`--env-file` 必须在任何 import 之前生效**(2026-09-05)。
 *
 * ESM 的 import 体先于模块体执行:把摘 flag 的代码写在 `cli.ts` 的函数里,它跑在
 * `logger` / `bootstrapModelRuntime` 之后 —— 那时 `.env` 早已按发现链加载完,
 * `OMD_ENV_FILE` 设了也没人再读(实测:`--env-file` 给了,来源仍报 `install`)。
 *
 * 所以这份是**纯副作用模块**,必须是 `cli.ts` 的**第一个 import**(同 `bootstrap.ts`
 * 里 `import '../env-alias'` 的位置与理由)。
 *
 * 它同时把参数从 `process.argv` 里拿掉 —— 下游各命令的解析不认识这个 flag。
 *
 * @module
 */

const argv = process.argv;
const kept: string[] = argv.slice(0, 2);
for (let i = 2; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === '--env-file' && i + 1 < argv.length) {
    process.env.OMD_ENV_FILE = argv[++i];
    continue;
  }
  if (a.startsWith('--env-file=')) {
    process.env.OMD_ENV_FILE = a.slice('--env-file='.length);
    continue;
  }
  kept.push(a);
}
process.argv = kept;
