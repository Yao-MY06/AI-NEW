import { SETTINGS } from './config.js';
import { normalizeUrl } from './util.js';
import type { Article } from './types.js';

// 兼容旧引用：normalizeUrl 已上移到 util.ts（供 db 层复用）
export { normalizeUrl };

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'and',
  'or',
  'its',
  'is',
  'are',
  'as',
  'at',
  'by',
  'from',
  'how',
  'why',
  'what',
  'when',
  'new',
  'vs',
  'using',
  'after',
  'before',
  'your',
  'you',
  'their',
  'this',
  'that',
  'about',
]);

/** 标题分词（小写、去标点、去停用词），用于同题相似度判断 */
function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface ProcessOptions {
  sinceMs: number;
  pinKeywords: string[];
  blockKeywords: string[];
}

export interface ProcessStats {
  raw: number; // 原始条数
  inWindow: number; // 时间窗口内（去重前）
  urlDup: number; // 同链接去重数
  titleMerged: number; // 跨源同题合并数
  blocked: number; // 黑名单过滤数
  pinned: number; // 关注关键词命中数
}

/**
 * 处理流水线：时间窗口过滤 → URL 去重 → 跨源同题合并 → 黑名单过滤 → 关注置顶 → 排序。
 * 返回顺序：关注置顶在前，组内按时间倒序。
 */
export function processArticles(
  articles: Article[],
  opts: ProcessOptions,
): { articles: Article[]; stats: ProcessStats } {
  const now = Date.now();

  // 1) 时间窗口 + 链接去重
  const seenUrl = new Set<string>();
  const windowed: Article[] = [];
  let urlDup = 0;
  for (const a of articles) {
    const ts = a.pubDate.getTime();
    if (Number.isNaN(ts) || ts < opts.sinceMs) continue;
    if (ts > now + 60 * 60 * 1000) continue; // 发布时间在未来 1 小时以外，视为时区异常
    const key = normalizeUrl(a.link);
    if (seenUrl.has(key)) {
      urlDup++;
      continue;
    }
    seenUrl.add(key);
    windowed.push(a);
  }
  windowed.sort((x, y) => y.pubDate.getTime() - x.pubDate.getTime());

  // 2) 跨源同题合并：与已保留文章标题相似度超阈值时并入，不重复展示/总结
  const accepted: Article[] = [];
  const acceptedTokens: Set<string>[] = [];
  let titleMerged = 0;
  for (const a of windowed) {
    const tokens = titleTokens(a.title);
    let merged = false;
    for (let i = 0; i < accepted.length; i++) {
      const kept = accepted[i];
      const keptTokens = acceptedTokens[i];
      if (!kept || !keptTokens) continue;
      if (jaccard(tokens, keptTokens) >= SETTINGS.titleMergeThreshold) {
        if (a.source !== kept.source) {
          const list = (kept.alsoReportedBy ??= []);
          if (!list.includes(a.source)) list.push(a.source);
        }
        titleMerged++;
        merged = true;
        break;
      }
    }
    if (!merged) {
      accepted.push(a);
      acceptedTokens.push(tokens);
    }
  }

  // 3) 黑名单关键词过滤（标题 + 正文，中英文关键词均支持）
  const block = opts.blockKeywords.map((k) => k.toLowerCase());
  let blocked = 0;
  const kept = accepted.filter((a) => {
    if (!block.length) return true;
    const hay = (a.title + ' ' + a.text).toLowerCase();
    if (block.some((k) => hay.includes(k))) {
      blocked++;
      return false;
    }
    return true;
  });

  // 4) 关注关键词标记
  const pin = opts.pinKeywords.map((k) => k.toLowerCase());
  let pinnedCount = 0;
  for (const a of kept) {
    if (!pin.length) continue;
    const hay = (a.title + ' ' + a.text).toLowerCase();
    if (pin.some((k) => hay.includes(k))) {
      a.pinned = true;
      pinnedCount++;
    }
  }

  // 5) 排序：关注置顶在前，组内时间倒序
  kept.sort(
    (x, y) =>
      Number(y.pinned ?? false) - Number(x.pinned ?? false) ||
      y.pubDate.getTime() - x.pubDate.getTime(),
  );

  return {
    articles: kept,
    stats: {
      raw: articles.length,
      inWindow: windowed.length + urlDup,
      urlDup,
      titleMerged,
      blocked,
      pinned: pinnedCount,
    },
  };
}
