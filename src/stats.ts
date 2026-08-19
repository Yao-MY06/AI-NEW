import type { Article } from './types.js';

const STOP = new Set([
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
  'into',
  'over',
  'will',
  'can',
  'may',
  'not',
  'but',
  'has',
  'have',
  'was',
  'were',
  'more',
  'than',
  'them',
  'they',
  'all',
  'her',
  'his',
  'our',
  'who',
  'now',
  'get',
  'out',
  'up',
  'off',
  'amid',
  'among',
  'between',
]);

export interface CountItem {
  name: string;
  n: number;
}

export interface ReportStats {
  bySource: CountItem[];
  byCategory: CountItem[];
  /** 标题高频词（英文，去停用词），按频次降序 */
  topWords: CountItem[];
}

/** 统计各来源/分类分布与标题热词，供日报看板渲染 */
export function computeStats(articles: Article[]): ReportStats {
  const sourceMap = new Map<string, number>();
  const catMap = new Map<string, number>();
  const wordMap = new Map<string, number>();

  for (const a of articles) {
    sourceMap.set(a.source, (sourceMap.get(a.source) ?? 0) + 1);
    const cat = a.category ?? '其他';
    catMap.set(cat, (catMap.get(cat) ?? 0) + 1);
    for (const w of a.title.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []) {
      if (!STOP.has(w)) wordMap.set(w, (wordMap.get(w) ?? 0) + 1);
    }
  }

  const toItems = (m: Map<string, number>): CountItem[] =>
    [...m.entries()].map(([name, n]) => ({ name, n })).sort((x, y) => y.n - x.n);

  return {
    bySource: toItems(sourceMap),
    byCategory: toItems(catMap),
    topWords: toItems(wordMap).slice(0, 14),
  };
}
