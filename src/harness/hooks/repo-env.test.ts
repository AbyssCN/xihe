/**
 * **仓的 env 与凭据怎么进 jail**(2026-09-05)。
 *
 * 治的病见 `repo-env.ts` 模块头:`render-command` 让引擎知道了这个仓怎么渲染自己,但那条命令
 * 到 jail 里常常起不来 —— 它要的 `.env.local` 被 gitignore(worktree 不带),要的
 * `~/.config/<产品>/` 在 jail 外(HOME=/tmp)。
 *
 * ⚠ 本文件里最该钉死的**不是**功能,是**边界**:只认显式声明 · 路径不许逃逸 · 一律 ro。
 * 这三条一旦松掉,这个模块就从"补挂载面"变成"任意读取口 + 自动把密钥递进沙箱"。
 */
import { describe, expect, test } from 'bun:test';
import { describeRepoEnv, resolveRepoEnv } from './repo-env';

/** 合成一个仓 + 一个宿主 HOME:给定哪些路径存在、`.omd/config.json` 是什么。 */
const world = (files: Record<string, string>, present: string[] = []) => ({
  exists: (p: string) => Object.keys(files).some((f) => p.endsWith(f)) || present.some((f) => p.endsWith(f)),
  readText: (p: string) => {
    const hit = Object.keys(files).find((f) => p.endsWith(f));
    if (!hit) throw new Error(`ENOENT ${p}`);
    return files[hit]!;
  },
  home: '/home/u',
  jailHome: '/tmp',
});

const cfg = (env: unknown) => ({ '.omd/config.json': JSON.stringify({ env }) });

describe('只认显式声明 —— 不自动把探到的 env 挂进 jail', () => {
  // 证伪方式: 让 resolveRepoEnv 在没声明时也把探到的 .env.local 填进 files → 本条红。
  // 这是本模块的**安全根**: 自动挂载等于替 owner 决定把密钥递进沙箱。
  test('★ 探到 .env.local 但没声明 → files 空, 只给建议', () => {
    const b = resolveRepoEnv('/r', world({}, ['.env.local']));
    expect(b.files).toEqual([]);
    expect(b.homeBinds).toEqual([]);
    expect(b.suggestion).toContain('.env.local');
    expect(b.suggestion).toContain('.omd/config.json');
  });

  test('什么都没探到 → 建议为 null(不造一句无处下手的话)', () => {
    expect(resolveRepoEnv('/r', world({})).suggestion).toBeNull();
  });

  test('坏 JSON 不炸(fail-open, 同 render-command)', () => {
    expect(() => resolveRepoEnv('/r', world({ '.omd/config.json': '{ not json' }))).not.toThrow();
  });
});

describe('路径边界 —— 声明也不许逃逸', () => {
  // 证伪方式: 把 safeRel 删掉 → 本条红。一个能写 `../../.ssh/id_rsa` 的配置项 = 任意读取口。
  test('★ files 里的 `..` 被拒, 且拒因可见(不静默丢)', () => {
    const b = resolveRepoEnv('/r', world(cfg({ files: ['../../.ssh/id_rsa'] }), ['../../.ssh/id_rsa']));
    expect(b.files).toEqual([]);
    expect(b.missing.join()).toContain('拒绝');
  });

  test('★ homePaths 里的绝对路径被拒', () => {
    const b = resolveRepoEnv('/r', world(cfg({ homePaths: ['/etc/shadow'] }), ['/etc/shadow']));
    expect(b.homeBinds).toEqual([]);
    expect(b.missing.join()).toContain('拒绝');
  });

  test('声明了但盘上没有 → 进 missing, 不静默(缺席 ≠ 没声明)', () => {
    const b = resolveRepoEnv('/r', world(cfg({ files: ['apps/web/.env.local'] })));
    expect(b.files).toEqual([]);
    expect(b.missing.join()).toContain('盘上没有');
  });
});

describe('声明生效时的形状', () => {
  // 证伪方式: 把 homeBinds 的 dest 改成 src → 本条红 (jail 的 HOME 是 /tmp, 挂错位置等于没挂)。
  test('★ files 拷进 worktree 同一相对位置; homePaths 落 jail HOME 下同一相对位置', () => {
    const b = resolveRepoEnv(
      '/r',
      world(cfg({ files: ['apps/web/.env.local'], homePaths: ['.config/plana'] }), ['apps/web/.env.local', '.config/plana']),
    );
    expect(b.files).toEqual(['apps/web/.env.local']);
    expect(b.homeBinds).toEqual([{ src: '/home/u/.config/plana', dest: '/tmp/.config/plana' }]);
    expect(b.suggestion).toBeNull(); // 有声明就不再给建议
  });

  test('判词只报路径不报内容(它描述的就是密钥所在)', () => {
    const b = resolveRepoEnv(
      '/r',
      world(cfg({ files: ['apps/web/.env.local'], homePaths: ['.config/plana'] }), ['apps/web/.env.local', '.config/plana']),
    );
    const d = describeRepoEnv(b);
    expect(d).toContain('apps/web/.env.local');
    expect(d).toContain('/tmp/.config/plana');
    expect(d).not.toContain('SUPABASE'); // 内容从不进判词
  });
});
