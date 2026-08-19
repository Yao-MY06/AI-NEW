import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { SETTINGS } from './config.js';
import { truncate } from './util.js';

/** 抓取 HN 条目指向的网页并提取正文，失败返回 null（调用方降级用 RSS 简介） */
export async function fetchArticleText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': SETTINGS.userAgent,
        accept: 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(SETTINGS.pageTimeoutMs),
    });
    if (!res.ok) return null;
    const size = Number(res.headers.get('content-length') ?? '0');
    if (size > SETTINGS.pageMaxBytes) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct && !ct.includes('html')) return null;

    const html = await res.text();
    const { document } = parseHTML(html);
    // linkedom 与 jsdom 的 Document 类型结构兼容，运行时可用；此处做受控断言
    type ReadabilityDoc = NonNullable<ConstructorParameters<typeof Readability>[0]>;
    const parsed = new Readability(document as unknown as ReadabilityDoc).parse();
    const text = parsed?.textContent?.replace(/\s+\n/g, '\n').trim() ?? '';
    return text ? truncate(text, SETTINGS.maxChars) : null;
  } catch {
    return null;
  }
}
