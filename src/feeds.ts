import Parser from 'rss-parser';
import { existsSync, readFileSync } from 'node:fs';
import { FEEDS, FEEDS_FILE, SETTINGS } from './config.js';
import type { FeedConfig } from './config.js';
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

/** 读取 RSS 源配置：优先 feeds.json（Web 后台维护），校验失败回退内置 FEEDS */
export function loadFeeds(): FeedConfig[] {
  try {
    if (!existsSync(FEEDS_FILE)) return FEEDS;
    const raw = JSON.parse(readFileSync(FEEDS_FILE, 'utf-8')) as Array<
      FeedConfig & { enabled?: boolean }
    >;
    if (!Array.isArray(raw)) return FEEDS;
    const enabled = raw.filter(
      (f) => f && typeof f.url === 'string' && f.name && f.enabled !== false,
    );
    if (!enabled.length) return FEEDS;
    return enabled.map((f) => ({
      name: String(f.name),
      url: String(f.url),
      kind: f.kind === 'hn' ? ('hn' as const) : ('feed' as const),
    }));
  } catch {
    return FEEDS;
  }
}

export async function fetchAllFeeds(): Promise<FeedResult[]> {
  return Promise.all(
    loadFeeds().map(async (feed): Promise<FeedResult> => {
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
