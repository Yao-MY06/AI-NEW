import Parser from 'rss-parser';
import { FEEDS, SETTINGS } from './config.js';
import { sleep, stripHtml, truncate } from './util.js';
import type { Article, FeedResult } from './types.js';

/** 只取我们关心的 RSS 字段（含 content:encoded 全文） */
interface RawItem {
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  description?: string;
  contentSnippet?: string;
  content?: string;
  'content:encoded'?: string;
}

const parser = new Parser({
  customFields: { item: ['content:encoded'] },
});

async function fetchXml(url: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= SETTINGS.fetchRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': SETTINGS.userAgent,
          accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
        signal: AbortSignal.timeout(SETTINGS.fetchTimeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < SETTINGS.fetchRetries) await sleep(attempt * 1000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function toArticles(source: string, kind: 'feed' | 'hn', items: RawItem[]): Article[] {
  const out: Article[] = [];
  for (const it of items) {
    const link = (it.link ?? '').trim();
    const title = stripHtml(it.title ?? '');
    if (!link || !title) continue;
    const raw = it['content:encoded'] || it.content || it.description || it.contentSnippet || '';
    out.push({
      title,
      link,
      pubDate: new Date(it.isoDate ?? it.pubDate ?? ''),
      source,
      text: truncate(stripHtml(raw), SETTINGS.maxChars),
      kind,
    });
  }
  return out;
}

export async function fetchAllFeeds(): Promise<FeedResult[]> {
  return Promise.all(
    FEEDS.map(async (feed): Promise<FeedResult> => {
      try {
        const xml = await fetchXml(feed.url);
        const parsed = await parser.parseString(xml);
        const articles = toArticles(feed.name, feed.kind, (parsed.items ?? []) as RawItem[]);
        console.log(`[feed] ${feed.name}: 获取 ${articles.length} 条`);
        return { source: feed.name, ok: true, articles };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[feed] ${feed.name}: 抓取失败 - ${msg}`);
        return { source: feed.name, ok: false, error: msg, articles: [] };
      }
    }),
  );
}
