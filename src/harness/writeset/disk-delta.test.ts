/**
 * disk-delta: 盘上改动差集 (2026-09-06)。真临时 git 仓, 不 mock fs。
 * 证伪: diskDelta 去掉「hash 不同 ⇒ 收」⇒ ★ 红; snapshotDisk 不跳 `.omd/` ⇒ 「.omd 不收」红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskDelta, snapshotDisk } from './disk-delta';

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-disk-delta-'));
  const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: d, stdout: 'pipe', stderr: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'a.py'), 'x = 1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return d;
}

describe('disk-delta', () => {
  test('★ shell 改文件 (不经写工具) 被收进差集; 新建未跟踪文件也收', () => {
    const d = repo();
    const before = snapshotDisk(d);
    expect(before.why).toBeUndefined();
    writeFileSync(join(d, 'src', 'a.py'), 'x = 2\n'); // 模拟 sed -i
    writeFileSync(join(d, 'src', 'b.py'), 'y = 1\n'); // 模拟 cat > 新文件
    const after = snapshotDisk(d);
    expect(diskDelta(before.files, after.files).sort()).toEqual(['src/a.py', 'src/b.py']);
    rmSync(d, { recursive: true, force: true });
  });
  test('没动 ⇒ 差集空 (已改但未提交的文件两次快照 hash 相同也不算)', () => {
    const d = repo();
    writeFileSync(join(d, 'src', 'a.py'), 'x = 3\n');
    const before = snapshotDisk(d);
    const after = snapshotDisk(d);
    expect(diskDelta(before.files, after.files)).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });
  test('.omd/ 下的不收 (引擎留痕不是产物)', () => {
    const d = repo();
    const before = snapshotDisk(d);
    mkdirSync(join(d, '.omd'));
    writeFileSync(join(d, '.omd', 'dag-runs.db'), 'x');
    const after = snapshotDisk(d);
    expect(diskDelta(before.files, after.files)).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });
  test('非 git 目录 ⇒ 空 map + why (fail-open 留证据)', () => {
    const d = mkdtempSync(join(tmpdir(), 'omd-disk-delta-nogit-'));
    const s = snapshotDisk(d);
    expect(s.files.size).toBe(0);
    expect(s.why).toBeTruthy();
    rmSync(d, { recursive: true, force: true });
  });
  test('删除的文件也算动过', () => {
    const d = repo();
    const before = snapshotDisk(d);
    rmSync(join(d, 'src', 'a.py'));
    const after = snapshotDisk(d);
    expect(diskDelta(before.files, after.files)).toEqual(['src/a.py']);
    rmSync(d, { recursive: true, force: true });
  });
});
