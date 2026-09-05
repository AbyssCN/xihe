/**
 * harness/read-ledger —— **conductor 读账**: 引擎按工具调用记的一本账, 派活时机械交接给子节点
 * (契约 `docs/plan/2026-09-06-墙钟与读次数-执行契约.md` W2)。
 *
 * ## 治的是哪个读数
 *
 * code80-boundary 80 题实测: conductor 每题 1986 个工具步, 其中 **61% 是 bash 里的只读勘察**
 * (grep/ls/cat/sed/find/git); work 子节点 2371 步里又有 47% 是同一件事。子节点把 conductor
 * 刚读过的东西**再读一遍** —— 因为 `work` 卡只有一段自由文本 `brief`, 没有结构化交接。
 * 墙钟 = 轮数 × 每轮时延, 这一段是纯粹的重复轮数。
 *
 * ## 边界 (这本账是什么, 不是什么)
 *
 *  · **引擎记的账, 不是模型自述** —— 记录点在工具**返回之前**, 记的是真调过什么、返回了什么头几行。
 *    模型没法往这本账里写它没读过的东西。
 *  · **只收只读勘察**。写工具 (write/edit) 与跑测试/装依赖的 bash 一律不进: 交接的是「我看见了什么」,
 *    不是「我做了什么」(后者已经在派发台账与 filesTouched 里)。
 *  · **只报不拦** (仓规 §引擎理念 ④): 记账失败不许挡住工具调用本身。
 *  · 有界: 按 key 去重, 最多留最近 `maxEntries` 条, 每条正文截到 `maxExcerpt` 字符,
 *    渲染再受 `maxChars` 二次封顶 —— 三道各管各的, 别指望某一道兜住全部。
 */
import { logger } from './logger';

/** 一条读账事件。`key` = 去重键 (同一个文件/同一条命令读两次只留一条); `excerpt` = 工具返回的正文。 */
export interface ReadEvent {
  kind: 'read' | 'ls' | 'grep' | 'bash-readonly';
  key: string;
  excerpt: string;
}

export interface ReadLedger {
  observe(ev: ReadEvent): void;
  /** 渲染成交接段; 空账返 `''`(**不出表头**) —— 「空账不追加」靠的就是这条。 */
  render(maxChars: number): string;
  size(): number;
}

/** 交接段固定首行 —— 让子节点分得清这是引擎记的账, 不是上一个模型的复述。 */
export const HANDOFF_HEADER = '===== conductor 已勘察 (引擎记账, 不是自述) =====';

const DEFAULT_MAX_ENTRIES = 20;
const DEFAULT_MAX_EXCERPT = 1200;

/**
 * 只读勘察的首词集合 (契约 W2 逐字)。
 *
 * ⚠ `sed` / `git` 在表里, 但它们各有写形态 —— 那由下面的写形态排除项管, 不靠这张表。
 * 表本身只回答「这个词有没有可能是勘察」。
 */
const READONLY_FIRST_WORDS: ReadonlySet<string> = new Set([
  'ls', 'find', 'tree', 'wc', 'head', 'tail', 'cat', 'sed', 'grep', 'rg', 'awk', 'stat', 'file', 'which', 'git',
]);

/** 导航前缀: `cd <dir> && <真命令>` 是勘察最常见的写法, 让它不至于因为首词是 cd 就整条不收。 */
const NAVIGATION_WORDS: ReadonlySet<string> = new Set(['cd']);

/** 写形态: 命中任一即不算勘察 (重定向 / 管进写工具 / 原地改)。 */
const WRITE_SHAPES: readonly RegExp[] = [
  />/,                          // `>` `>>` `2>` 一网打尽 —— 重定向就是写
  /\|\s*tee\b/,                 // 管给 tee 也是写
  /\bsed\b[^&|]*\s-i\b/,        // sed 原地改
  /\bsed\b[^&|]*--in-place\b/,
];

/**
 * 一条 shell 命令是不是**只读勘察**。
 *
 * 判据: ① 不含任何写形态; ② 用 `&&` 拆开之后, 每一段的首词都在只读集合或导航词里;
 * ③ 至少有一段的首词真在只读集合里 (光一个 `cd` 什么也没勘察到)。
 *
 * ⚠ 这**不是**安全闸 —— 安全闸是 `hooks/command-policy.ts` 那一套。这里判的是「要不要记进读账」,
 * 判错的代价是交接段多一条或少一条, 不是放行危险命令。别把它当白名单用。
 *
 * falsify (本函数必须能真红): 去掉 {@link WRITE_SHAPES} 的 `>` 那条 ⇒
 * read-ledger.test.ts 的「echo x > f」当场由红转绿 (即断言失效)。
 */
export function classifyShellReadonly(command: string): boolean {
  const c = (command ?? '').trim();
  if (!c) return false;
  if (WRITE_SHAPES.some((re) => re.test(c))) return false;
  const links = c.split('&&').map((s) => s.trim()).filter(Boolean);
  if (links.length === 0) return false;
  let sawReadonly = false;
  for (const link of links) {
    const first = link.split(/\s+/)[0] ?? '';
    const bin = first.includes('/') ? first.slice(first.lastIndexOf('/') + 1) : first;
    if (READONLY_FIRST_WORDS.has(bin)) {
      sawReadonly = true;
      continue;
    }
    if (NAVIGATION_WORDS.has(bin)) continue;
    return false;
  }
  return sawReadonly;
}

/** 每条账的渲染前缀 —— 让 key 与正文在交接段里分得开。 */
function renderEntry(ev: ReadEvent): string {
  const body = ev.excerpt.trim();
  return `--- [${ev.kind}] ${ev.key} ---\n${body}`;
}

/**
 * 建一本读账。**按 run 建一本**: 账是这一趟 conductor 的勘察轨迹, 跨 run 复用等于把上一趟
 * 读到的东西交接给这一趟的子节点 (与 `writeAllow` / `fileObservations` 同一条纪律)。
 */
export function createReadLedger(opts?: { maxEntries?: number; maxExcerpt?: number }): ReadLedger {
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxExcerpt = opts?.maxExcerpt ?? DEFAULT_MAX_EXCERPT;
  // Map 的插入顺序 = 时间顺序; 同 key 先 delete 再 set, 于是「重读一次」会把它挪到最新一端。
  const entries = new Map<string, ReadEvent>();
  return {
    observe(ev: ReadEvent): void {
      const key = (ev.key ?? '').trim();
      if (!key) return;
      const excerpt = (ev.excerpt ?? '').slice(0, maxExcerpt);
      entries.delete(key);
      entries.set(key, { kind: ev.kind, key, excerpt });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    render(maxChars: number): string {
      if (entries.size === 0) return '';
      const all = [...entries.values()];
      // 预算从**最新**一端开始花 —— 紧到只装得下一条时, 该留的是最新鲜的那条勘察。
      // 选完再按时间顺序印: 子节点读到的是一条轨迹, 不是倒着的。
      const budget = maxChars - HANDOFF_HEADER.length - 1;
      const picked: ReadEvent[] = [];
      let used = 0;
      for (let i = all.length - 1; i >= 0; i--) {
        const block = renderEntry(all[i]!);
        const cost = block.length + 1;
        if (used + cost > budget) break;
        used += cost;
        picked.unshift(all[i]!);
      }
      if (picked.length === 0) return '';
      return [HANDOFF_HEADER, ...picked.map(renderEntry)].join('\n');
    },
    size(): number {
      return entries.size;
    },
  };
}

/**
 * 工具侧的记账一跳 (只报不拦, 仓规 §引擎理念 ④): 钩子缺席 = 什么都不做, 抛错 = 吞掉但留证据。
 * 工具的返回值一个字节都不因为这本账而变 —— 这是 `agent-tools.test.ts` 基线的硬要求。
 */
export function observeSafely(observe: ((ev: ReadEvent) => void) | undefined, ev: ReadEvent): void {
  if (!observe) return;
  try {
    observe(ev);
  } catch (err) {
    // fail-open 可以吞异常, 不许吞证据 (仓规静默坑 2): 记不上就记不上, 但要看得见是哪条、为什么。
    logger.warn({ kind: ev.kind, key: ev.key, err: (err as Error).message }, '[omd/read-ledger] 读账记不上 → 跳过 (fail-open, 工具返回不受影响)');
  }
}
