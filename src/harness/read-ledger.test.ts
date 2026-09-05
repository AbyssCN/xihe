/**
 * W2 读账纯核 —— 契约 `docs/plan/2026-09-06-墙钟与读次数-执行契约.md` INV-4。
 *
 * 治的病 (§0 读数): conductor 一题读仓 ~23 步, 子节点把它读过的东西**再读一遍** ——
 * `work` 卡只有一段自由文本 `brief`, 没有结构化交接。读账是**引擎记的账**, 不是模型自述:
 * 谁调了 read/ls/grep/只读 bash, 引擎在工具返回前记一条, 派活时机械交接下去。
 *
 * 反向自检 (每条当场证伪过):
 *  · `createReadLedger` 不按 key 去重 ⇒ 「同 key 两次只留一条」当场红;
 *  · 丢最旧改成丢最新 ⇒ 「超上限丢最旧」当场红;
 *  · `classifyShellReadonly` 不查 `>` ⇒ 「echo x > f」当场红;
 *  · `render` 空账仍印表头 ⇒ 「空账不出表头」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { HANDOFF_HEADER, classifyShellReadonly, createReadLedger } from './read-ledger';

describe('INV-4 前半: classifyShellReadonly —— 只读勘察才进账', () => {
  test('★ cd 前缀 + grep ⇒ 只读', () => {
    expect(classifyShellReadonly('cd /w && grep -rn x .')).toBe(true);
  });

  test('★ 判别力: 重定向写文件 ⇒ 不是只读 (哪怕首词在只读集合里)', () => {
    expect(classifyShellReadonly('cd /w && echo x > f')).toBe(false);
    expect(classifyShellReadonly('cat a.txt > b.txt')).toBe(false);
    expect(classifyShellReadonly('sed -i s/a/b/ f.txt')).toBe(false);
  });

  test('★ 判别力: 跑测试 / 装依赖 ⇒ 不是勘察', () => {
    expect(classifyShellReadonly('python3 -m pytest')).toBe(false);
    expect(classifyShellReadonly('pip install')).toBe(false);
    expect(classifyShellReadonly('bun test')).toBe(false);
  });

  test('只读集合里的其它词照收; 空命令不收', () => {
    expect(classifyShellReadonly('ls -la src')).toBe(true);
    expect(classifyShellReadonly('git log --oneline -3')).toBe(true);
    expect(classifyShellReadonly('   ')).toBe(false);
  });
});

describe('INV-4 后半: createReadLedger —— 去重 + 上限 + 摘要截断', () => {
  test('★ 同 key 两次只留一条 (后一次的正文为准)', () => {
    const l = createReadLedger();
    l.observe({ kind: 'read', key: 'read src/a.ts', excerpt: '旧' });
    l.observe({ kind: 'read', key: 'read src/a.ts', excerpt: '新' });
    expect(l.size()).toBe(1);
    expect(l.render(4000)).toContain('新');
    expect(l.render(4000)).not.toContain('旧');
  });

  test('★ 超 20 条丢最旧', () => {
    const l = createReadLedger();
    for (let i = 0; i < 21; i++) l.observe({ kind: 'read', key: `read src/f${i}.ts`, excerpt: `内容${i}` });
    expect(l.size()).toBe(20);
    const out = l.render(40_000);
    expect(out).not.toContain('src/f0.ts');
    expect(out).toContain('src/f20.ts');
  });

  test('★ maxExcerpt 截正文 (默认 1200)', () => {
    const l = createReadLedger({ maxExcerpt: 10 });
    l.observe({ kind: 'read', key: 'read src/a.ts', excerpt: 'x'.repeat(500) });
    expect(l.render(4000)).not.toContain('x'.repeat(11));
  });

  test('★ 空账 render 返空串 (不出表头) —— 空账不追加靠的是这一条', () => {
    expect(createReadLedger().render(4000)).toBe('');
  });

  test('★ 非空 render 含表头与最近一次 read 的路径, 且不超 maxChars', () => {
    const l = createReadLedger();
    l.observe({ kind: 'ls', key: 'ls src', excerpt: 'a.ts\nb.ts' });
    l.observe({ kind: 'read', key: 'read src/latest.ts', excerpt: '正文' });
    const out = l.render(4000);
    expect(out).toContain(HANDOFF_HEADER);
    expect(out).toContain('src/latest.ts');
    expect(out.length).toBeLessThanOrEqual(4000);
  });

  test('★ maxChars 紧到只装得下一条时: 保最近的那一条 (交接要的是新鲜账)', () => {
    const l = createReadLedger();
    l.observe({ kind: 'read', key: 'read src/old.ts', excerpt: 'o'.repeat(300) });
    l.observe({ kind: 'read', key: 'read src/new.ts', excerpt: 'n'.repeat(300) });
    const out = l.render(HANDOFF_HEADER.length + 400);
    expect(out).toContain('src/new.ts');
    expect(out).not.toContain('src/old.ts');
  });

  test('渲染按时间顺序 (老的在前) —— 人读与模型读的都是一条勘察轨迹', () => {
    const l = createReadLedger();
    l.observe({ kind: 'read', key: 'read src/first.ts', excerpt: '1' });
    l.observe({ kind: 'read', key: 'read src/second.ts', excerpt: '2' });
    const out = l.render(4000);
    expect(out.indexOf('src/first.ts')).toBeLessThan(out.indexOf('src/second.ts'));
  });
});
