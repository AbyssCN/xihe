/**
 * 仓内路径归一 —— 把「根之内的绝对路径」转成相对路径, 其余原样。
 *
 * 为什么要有它 (2026-09-06, code80-m3 五臂实测): leaf 上报 `filesTouched` 时照抄模型给的绝对路径
 * (`/workspace/src/x.py`), 而写集声明、`output_path`、diff 证据全是相对路径 (`src/x.py`)。两套写法
 * 逐字比对不上 → 写集对账把每个触碰文件记成 orphan、每个声明文件记成 missing (ctl 批 63/80 题
 * missing>0), 这条假事实进判官卷面 → 判官「声明产物均不存在」→ 首判 fail 75/80, 其中 24 题隐藏
 * 测试 reward ≥ 0.9。根因是路径形态, 不是判官。
 *
 * 规则 (纯函数, 零 IO):
 *  · 相对路径原样 (只去掉开头的 `./`)。
 *  · 绝对路径且落在 `root` 之内 → 相对于 root 的路径。
 *  · 绝对路径且在 root 之外 (或 root 缺席) → 原样 —— 越界是另一道闸的事, 这里不吞信息。
 *
 * 证伪: 把 `isAbsolute(p) && inside` 那支改成恒 return p → repo-path.test.ts 「根内绝对路径转相对」红。
 */
import { isAbsolute, relative, sep } from 'node:path';

export function repoRelativePath(root: string | undefined, p: string): string {
  if (!p) return p;
  if (!isAbsolute(p)) return p.startsWith('./') ? p.slice(2) : p;
  if (!root) return p;
  const rel = relative(root, p);
  if (!rel || rel === '.') return p;
  if (rel.startsWith('..') || isAbsolute(rel)) return p;
  return rel.split(sep).join('/');
}
