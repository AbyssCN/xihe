/**
 * **生态表 → jail 挂载面**(2026-09-04)。
 *
 * 这一层存在的理由写在 `toolchain.ts` 的模块头:`omd_env` 早就会探测仓的生态,而那份探测
 * **从来没喂给 bwrap 的绑定组装** —— 于是 jail 的挂载面是按 omd 自己仓的样子写死的,
 * 换个技术栈就少东西,而少东西会伪装成「模型不行」。
 *
 * 本文件用**合成 HOME**测机制(表里每一行都能这么测),真机验证只对 node 那一行做过 ——
 * 「没测」与「测过且通过」必须分得开。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ECOSYSTEMS,
  UNIVERSAL_HOME_PATHS,
  detectEcosystems,
  findExecToolchain,
  resolveToolchainBinds,
} from './toolchain';

/** 造一个合成世界: 仓根放 marker, 假 HOME 放缓存目录。 */
function world(opts: { markers?: string[]; homePaths?: string[] } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'omd-tc-')));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const m of opts.markers ?? []) writeFileSync(join(root, m), '{}');
  for (const h of opts.homePaths ?? []) {
    const p = join(home, h);
    mkdirSync(join(p, '..'), { recursive: true });
    if (h.endsWith('rc') || h.endsWith('config')) writeFileSync(p, 'x');
    else mkdirSync(p, { recursive: true });
  }
  return { base, root, home };
}

const noExec = { PATH: '' };

describe('detectEcosystems —— marker 命中才算', () => {
  test('package.json → node; 没有 Cargo.toml 就不认 rust', () => {
    const { base, root } = world({ markers: ['package.json'] });
    try {
      const ids = detectEcosystems(root).map((s) => s.id);
      expect(ids).toContain('node');
      expect(ids).not.toContain('rust');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('一个仓可以同时命中多个生态 (monorepo 里 JS + Python 很常见)', () => {
    const { base, root } = world({ markers: ['package.json', 'pyproject.toml'] });
    try {
      expect(detectEcosystems(root).map((s) => s.id).sort()).toEqual(['node', 'python']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('空仓 → 零生态 (挂载面保持最小)', () => {
    const { base, root } = world();
    try {
      expect(detectEcosystems(root)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('resolveToolchainBinds —— HOME 下的缓存/配置', () => {
  // 证伪方式: 把 ECOSYSTEMS 里 node 那行的 '.cache/ms-playwright' 删掉 → 本条红。
  test('★ Playwright 的浏览器目录被绑进 jail 的 HOME (这条挡在 plana test:design 的路上)', () => {
    const { base, root, home } = world({ markers: ['package.json'], homePaths: ['.cache/ms-playwright'] });
    try {
      const r = resolveToolchainBinds(root, { home, jailHome: '/tmp', env: noExec });
      expect(r.homeBinds).toContainEqual({
        src: join(home, '.cache/ms-playwright'),
        dest: '/tmp/.cache/ms-playwright',
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // 证伪方式: 把 pnpm 那行的 '.local/share/pnpm/store' 删掉 → 本条红。
  test('★ pnpm 的 store 被绑 (pnpm 的 node_modules 全是指向 store 的软链, 绑 node_modules 没用)', () => {
    const { base, root, home } = world({
      markers: ['pnpm-lock.yaml'],
      homePaths: ['.local/share/pnpm/store'],
    });
    try {
      const r = resolveToolchainBinds(root, { home, jailHome: '/tmp', env: noExec });
      expect(r.homeBinds.map((h) => h.src)).toContain(join(home, '.local/share/pnpm/store'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('不存在的 HOME 项不绑 (bwrap 挂不存在的路径会直接失败)', () => {
    const { base, root, home } = world({ markers: ['package.json'] }); // 一个 homePath 都没造
    try {
      const r = resolveToolchainBinds(root, { home, jailHome: '/tmp', env: noExec });
      expect(r.homeBinds).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('没命中的生态不绑它的缓存 (JS 仓不该被挂上 ~/.cargo —— 挂载面每宽一格隔离就松一格)', () => {
    const { base, root, home } = world({ markers: ['package.json'], homePaths: ['.cargo', '.rustup'] });
    try {
      const r = resolveToolchainBinds(root, { home, jailHome: '/tmp', env: noExec });
      expect(r.homeBinds.some((h) => h.src.includes('.cargo'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // 证伪方式: 把 UNIVERSAL_HOME_PATHS 清空 → 本条红。
  test('★ .gitconfig 无条件绑 (jail 里 git commit 缺 user.name 直接 "Please tell me who you are")', () => {
    const { base, root, home } = world({ markers: ['package.json'], homePaths: ['.gitconfig'] });
    try {
      const r = resolveToolchainBinds(root, { home, jailHome: '/tmp', env: noExec });
      expect(r.homeBinds.map((h) => h.dest)).toContain('/tmp/.gitconfig');
      expect(UNIVERSAL_HOME_PATHS).toContain('.gitconfig');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('探到生态但可执行一个都找不到 → 记进 missingExecutables (给 preflight 报 warn)', () => {
    const { base, root, home } = world({ markers: ['Cargo.toml'] });
    try {
      const r = resolveToolchainBinds(root, { home, jailHome: '/tmp', env: noExec });
      expect(r.missingExecutables).toEqual([{ ecosystem: 'rust', wanted: ['cargo'] }]);
      expect(r.pathDirs).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('findExecToolchain —— 绑安装根不是 bin', () => {
  test('宿主上找得到 node 时, rootDir 是 binDir 的父 (npm/npx 的相对软链要靠它)', () => {
    const tc = findExecToolchain('node');
    if (!tc) {
      console.warn('[skip] 宿主 PATH 上没有 node —— 本条跳过, 不是通过');
      return;
    }
    expect(tc.rootDir).toBe(join(tc.binDir, '..'));
  });

  test('PATH 为空 → null (不抛)', () => {
    expect(findExecToolchain('node', { PATH: '' })).toBeNull();
  });
});

describe('生态表本身', () => {
  test('每行都声明了 id / markers / executables (漏一格就是一条永不命中的死行)', () => {
    for (const s of ECOSYSTEMS) {
      expect(s.id.length, `${s.id}: id`).toBeGreaterThan(0);
      expect(s.markers.length, `${s.id}: markers`).toBeGreaterThan(0);
      expect(s.executables.length, `${s.id}: executables`).toBeGreaterThan(0);
    }
  });

  test('id 不重复 (重复会让 ecosystems 数组出现两遍, 日志与 preflight 判词都会乱)', () => {
    const ids = ECOSYSTEMS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
