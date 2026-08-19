import type { Article } from './types.js';

/** 归一化链接用于去重：去锚点/追踪参数，统一主机大小写与末尾斜杠 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|source$|mc_)/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    u.host = u.host.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return url;
  }
}

/** 过滤时间窗口内的文章，去重并按时间倒序 */
export function filterArticles(articles: Article[], sinceMs: number): Article[] {
  const now = Date.now();
  const seen = new Set<string>();
  const out: Article[] = [];
  for (const a of articles) {
    const ts = a.pubDate.getTime();
    if (Number.isNaN(ts)) continue; // 无有效发布时间，无法判断窗口
    if (ts < sinceMs) continue;
    if (ts > now + 60 * 60 * 1000) continue; // 发布时间在未来 1 小时以外，视为时区异常
    const key = normalizeUrl(a.link);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out.sort((x, y) => y.pubDate.getTime() - x.pubDate.getTime());
}
