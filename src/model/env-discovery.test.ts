/**
 * **凭据从哪来**(2026-09-05)。
 *
 * 治的病见 `env-discovery.ts` 模块头:Bun 只从 cwd 自动加载 `.env`,于是 `cd` 到任何别的仓跑
 * `omd run` 就 `providers=[⚠空]`,**整个 run 烧完才失败**(实账 3e572428,26m16s 零产出)。
 * 用户侧的"解法"是每个仓拷一份 `.env` —— 把密钥散到每个仓,既麻烦又是外泄面。
 *
 * ⚠ 本组要钉的是**优先序**与**不泄值**。优先序错了会出现最难查的一类故障:
 * 跑起来了,但用的是另一份配置。
 */
import { describe, expect, test } from 'bun:test';
import { describeEnvLoads, discoverEnvFiles, loadDiscoveredEnv, parseEnvText } from './env-discovery';

const world = (present: string[]) => ({
  exists: (p: string) => present.includes(p),
  cwd: '/repo',
  home: '/home/u',
  installDir: '/opt/omd',
});

describe('发现链的优先序', () => {
  // 证伪方式: 把 discoverEnvFiles 的 explicit 早返删掉 → 本条红。
  test('★ OMD_ENV_FILE 显式即权威 —— 只返它, 不回落(同 OMD_CONFIG_PATH 语义)', () => {
    const c = discoverEnvFiles({
      ...world(['/repo/.env', '/home/u/.omd/.env', '/opt/omd/.env', '/x/my.env']),
      env: { OMD_ENV_FILE: '/x/my.env' },
    });
    expect(c).toEqual([{ path: '/x/my.env', source: 'explicit' }]);
  });

  test('显式指向不存在的文件也不悄悄换一个(不然"我明明指了这份"永远查不清)', () => {
    const c = discoverEnvFiles({ ...world(['/repo/.env']), env: { OMD_ENV_FILE: '/x/nope.env' } });
    expect(c).toEqual([{ path: '/x/nope.env', source: 'explicit' }]);
  });

  // 证伪方式: 把 push 的顺序换成 home 在 cwd 之前 → 本条红。
  test('★ 顺序 = cwd → home → install(仓内那份不许被家目录劫持)', () => {
    const c = discoverEnvFiles({ ...world(['/repo/.env', '/home/u/.omd/.env', '/opt/omd/.env']), env: {} });
    expect(c.map((x) => x.source)).toEqual(['cwd', 'home', 'install']);
  });

  // 这一条就是「换个仓要重配」的正解所在。
  test('★ 本仓没有 .env → 落到家目录 ~/.omd/.env', () => {
    const c = discoverEnvFiles({ ...world(['/home/u/.omd/.env']), env: {} });
    expect(c).toEqual([{ path: '/home/u/.omd/.env', source: 'home' }]);
  });

  test('OMD_DATA_HOME 改锚点(与 ~/.omd/config.json 同一个锚)', () => {
    const c = discoverEnvFiles({ ...world(['/data/.env']), env: { OMD_DATA_HOME: '/data' } });
    expect(c).toEqual([{ path: '/data/.env', source: 'home' }]);
  });

  test('cwd 恰好是安装目录 → 同一份文件只算一次', () => {
    const c = discoverEnvFiles({ exists: (p) => p === '/opt/omd/.env', cwd: '/opt/omd', home: '/h', installDir: '/opt/omd', env: {} });
    expect(c).toHaveLength(1);
  });

  test('一份都没有 → 空数组(不编一个不存在的路径出来)', () => {
    expect(discoverEnvFiles({ ...world([]), env: {} })).toEqual([]);
  });
});

describe('parseEnvText —— 引擎自己解析, 永不经 shell', () => {
  // 证伪方式: 把"按第一个 = 切"改成 split('=') 取 [1] → 本条红。
  // 这一条是真事故的回归: 那行 cookie 值含 `;` `:` `=`, shell source 会把它当命令逐段执行。
  test('★ 含 ; : = 的 cookie 串原样保留(按第一个 = 切)', () => {
    const m = parseEnvText('COOKIE=a=1; b:2; c=3\nK=v');
    expect(m.get('COOKIE')).toBe('a=1; b:2; c=3');
    expect(m.get('K')).toBe('v');
  });

  test('注释 / 空行 / export 前缀 / 配对引号', () => {
    const m = parseEnvText('# c\n\nexport A=1\nB="two"\nC=\'three\'');
    expect([...m]).toEqual([['A', '1'], ['B', 'two'], ['C', 'three']]);
  });

  test('非法键名与无 = 的行跳过(不炸)', () => {
    const m = parseEnvText('1BAD=x\n=noKey\njust text\nOK=1');
    expect([...m.keys()]).toEqual(['OK']);
  });
});

describe('灌入语义', () => {
  // 证伪方式: 去掉 `if (env[k] !== undefined) continue` → 本条红。
  // Bun 已把 cwd/.env 灌进 process.env, 靠"不覆盖"才得出"仓内那份永远赢"。
  test('★ 不覆盖已存在的键, 且把跳过数报出来(优先序生效的证据)', () => {
    const env: NodeJS.ProcessEnv = { A: '仓内的值' };
    const loads = loadDiscoveredEnv({
      env,
      exists: (p) => p === '/home/u/.omd/.env',
      cwd: '/repo',
      home: '/home/u',
      installDir: null,
      readText: () => 'A=家目录的值\nB=新键',
    });
    expect(env.A).toBe('仓内的值');
    expect(env.B).toBe('新键');
    expect(loads[0]).toMatchObject({ source: 'home', applied: 1, skipped: 1 });
  });

  test('读不动的一份跳过, 不让引擎起不来(fail-open)', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() =>
      loadDiscoveredEnv({
        env,
        exists: (p) => p === '/home/u/.omd/.env',
        cwd: '/repo',
        home: '/home/u',
        installDir: null,
        readText: () => { throw new Error('EACCES'); },
      }),
    ).not.toThrow();
  });
});

describe('判词', () => {
  // 证伪方式: 让 describeEnvLoads 拼上值 → 本条红。这个模块碰的每一行都是密钥。
  test('★ 只报路径与键数, 永不报值', () => {
    const d = describeEnvLoads([{ path: '/home/u/.omd/.env', source: 'home', applied: 2, skipped: 1 }]);
    expect(d).toContain('/home/u/.omd/.env');
    expect(d).toContain('+2');
    expect(d).not.toMatch(/sk-|key=|=[A-Za-z0-9]{16}/);
  });

  test('一份都没有时, 判词要给出**下一步**而不只报"空"', () => {
    expect(describeEnvLoads([])).toContain('~/.omd/.env');
  });
});
