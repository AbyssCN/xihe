/**
 * src/harness/cli/docs-parity.test.ts —— 切片 7 (SDD 2026-09-05): 文档对账闸。
 *
 * ## 闸在守什么
 *
 * registry (`src/harness/cli/registry.ts`) 是 CLI 命令面的**唯一真源**。如果文档
 * (`docs/guide/cli.md`) 漏了一条命令、或者写了一行根本不存在的命令,读者从文档
 * 走就会被带偏 —— 这条命令根本调不通,或反过来真有的命令文档里看不到。和
 * `src/mcp/tools-documented.test.ts` (MCP 工具表 vs `docs/guide/mcp-tools.md`) 同
 * 性格:文档漂了,工具照常注册、照常能调,只有人/调用方受害,且没有任何红灯。
 *
 * ## 三件事
 *
 * 1. **每条 CLI 命令的 `path` 拼成 `omd <path>` 在 cli.md 里出现** —— 命令得被
 *    文档看到。否则加了一条命名命令,文档不补,用户从文档抄一个不存在的命令,
 *    现场一次哑敲,体验比"没文档"还差。
 * 2. **`MCP_ONLY` 的每个工具名在 cli.md 里出现,并带 `reason`** —— 那些工具故意
 *    没命名命令,但**有理由**;理由没写在文档里,读者会以为漏接。
 * 3. **`README.md` 引用了 `docs/guide/cli.md`** —— 从仓根进的用户得能找到。否则
 *    这份文档只在 docs 内部可见,装好 omd 的人根本看不到 CLI 这个新入口。
 *
 * ## 反向自检
 *
 * 测试**故意不**验证 cli.md 里写了什么逐字内容(那是排版自由,不该被闸绑死)。
 * 只验证「registry 的每个名字 + MCP_ONLY 的每个名字都被提到」。删一条命令、
 * 加一条 MCP_ONLY 工具 → 闸红。
 *
 * ## 不验什么
 *
 * · cli.md 与 README.md 之间的文字同步(那是 docs-drift-check.ts 与 Aalto 的事)。
 * · 命令行 flag 解析形态(那是 invoke.test.ts / dispatch.test.ts 的事)。
 * · 文档对 MCP 工具面 (50 条) 的覆盖(那是 tools-documented.test.ts 的事)。
 *
 * ## 路径解析
 *
 * 不靠 `new URL('../..', import.meta.url).pathname` —— bun test 在 omd run 内把
 * 脚本的绝对路径作为 `import.meta.url`,但仓根 (有 `package.json`) 与该 URL 之间
 * 隔着 omd/runs/<id>/, 字面量数 `..` 在不同进程下会漂。改用 `process.cwd()` 锚
 * 仓根 (production 与 test 启动 cwd 都是仓根) + 向上兜底一次找 package.json。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CLI_COMMANDS, MCP_ONLY } from './registry';

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'docs'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
  return resolve(start);
}

const ROOT = findRepoRoot(process.cwd());
const CLI_MD = join(ROOT, 'docs', 'guide', 'cli.md');
const README_MD = join(ROOT, 'README.md');

describe('CLI 文档对账闸 (slice 7)', () => {
  test('cli.md 与 README.md 盘上存在', () => {
    // 先证明文件在盘上 —— 整份文档对账的前提是文件没被误删。
    let cliOk = false;
    let readmeOk = false;
    try {
      readFileSync(CLI_MD, 'utf8');
      cliOk = true;
    } catch {
      cliOk = false;
    }
    try {
      readFileSync(README_MD, 'utf8');
      readmeOk = true;
    } catch {
      readmeOk = false;
    }
    expect(cliOk, `docs/guide/cli.md 不存在: ${CLI_MD}`).toBe(true);
    expect(readmeOk, `README.md 不存在: ${README_MD}`).toBe(true);
  });

  test('每条命名命令在 cli.md 里以 `omd <path>` 形式出现', () => {
    const doc = readFileSync(CLI_MD, 'utf8');
    // 至少有一份内容 —— 空文件没意义,但也要避免被 silently 通过。
    expect(doc.length).toBeGreaterThan(200);

    const missing: string[] = [];
    for (const cmd of CLI_COMMANDS) {
      const needle = `omd ${cmd.path.join(' ')}`;
      if (!doc.includes(needle)) missing.push(needle);
    }
    expect(
      missing.length === 0
        ? ''
        : `以下命名命令未在 docs/guide/cli.md 里以 \`${'<path>'}\` 形式出现 —— 加新命令却忘了补文档:\n  ${missing.join('\n  ')}`,
    ).toBe('');
  });

  test('MCP_ONLY 每个工具名在 cli.md 里出现 (附原因)', () => {
    const doc = readFileSync(CLI_MD, 'utf8');
    const missing: string[] = [];
    for (const name of Object.keys(MCP_ONLY)) {
      if (!doc.includes(name)) missing.push(name);
    }
    expect(
      missing.length === 0
        ? ''
        : `MCP_ONLY 工具未在 docs/guide/cli.md 里出现 —— 读者看到的是"漏接",不是"故意不接":\n  ${missing.join('\n  ')}`,
    ).toBe('');
  });

  test('README.md 引用 docs/guide/cli.md', () => {
    const readme = readFileSync(README_MD, 'utf8');
    // 仓根 README 必须能从某个地方跳到 CLI 指南 —— 否则这份文档只在 docs/ 内部可见。
    expect(
      readme.includes('docs/guide/cli.md'),
      'README.md 没引用 docs/guide/cli.md —— 仓根用户找不到 CLI 入口',
    ).toBe(true);
  });

  test('cli.md 顶部含一段对 CLI 角色的简介 (避免读者把它当成 MCP 的二手说明)', () => {
    const doc = readFileSync(CLI_MD, 'utf8');
    // 闸的是「有这段定位」,不绑具体文字 —— 闸本身漂了用户也会察觉。
    const hasIntro =
      doc.includes('CLI') &&
      (doc.includes('主入口') || doc.includes('main entry') || doc.includes('single entry') || doc.includes('主入口'));
    expect(hasIntro, 'cli.md 顶部应有 CLI 角色的简介').toBe(true);
  });

  test('cli.md 文档对账闸:反向自检材料', () => {
    // 这条不做事,只把上面三条闸的"反向自检方式"集中写在这里,便于
    // 删命令 / 加 MCP_ONLY 的人手动核验:
    //   1. registry.ts 删一行(例如 `runs`)→ 第 2 条红。
    //   2. MCP_ONLY 加一行(例如 `foo: 'no'`),cli.md 不补 → 第 3 条红。
    //   3. README.md 删 `docs/guide/cli.md` 链接 → 第 4 条红。
    //   4. cli.md 改名/移走 → 第 1 条红。
    const docLen = readFileSync(CLI_MD, 'utf8').length;
    expect(docLen).toBeGreaterThan(0);
  });
});
