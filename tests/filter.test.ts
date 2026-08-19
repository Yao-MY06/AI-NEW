/** processArticles 冒烟：跨源同题合并 / URL 归一化去重 / 黑名单 / 关注置顶 */
import { describe, expect, it } from 'vitest';
import { processArticles } from '../src/filter.js';
import type { Article } from '../src/types.js';

const A = (title: string, link: string, source: string, text = ''): Article => ({
  title,
  link,
  pubDate: new Date(Date.now() - 3600_000),
  source,
  text,
  kind: 'feed',
});

const list = [
  A('OpenAI launches new GPT-5 model', 'https://a.com/1', 'TechCrunch AI'),
  A('OpenAI Launches New GPT-5 Model!', 'https://b.com/1', 'The Verge AI'), // 跨源同题
  A(
    'Unrelated story about chips',
    'https://a.com/1?utm_source=x',
    'Hacker News',
    'FPGA 加速卡发布',
  ), // URL 归一化后同链接
  A('We are hiring AI engineers', 'https://a.com/3', 'Hacker News'), // 黑名单命中
  A('Cerebras ships new chip', 'https://a.com/4', 'TechCrunch AI', 'wafer-scale FPGA chipset'), // 关注命中（正文）
];

describe('processArticles', () => {
  const { articles, stats } = processArticles(list, {
    sinceMs: Date.now() - 86_400_000,
    pinKeywords: ['FPGA', '芯片'],
    blockKeywords: ['hiring', '招聘'],
  });

  it('跨源同题合并 + URL 归一化去重后剩 2 篇', () => {
    expect(stats.titleMerged).toBe(1);
    expect(stats.urlDup).toBe(1);
    expect(articles.length).toBe(2);
  });

  it('黑名单过滤生效', () => {
    expect(stats.blocked).toBe(1);
    expect(articles.some((a) => a.title.includes('hiring'))).toBe(false);
  });

  it('关注关键词命中并置顶', () => {
    expect(stats.pinned).toBe(1);
    expect(articles[0]?.pinned).toBe(true);
    expect(articles[0]?.source).toBe('TechCrunch AI');
  });

  it('被合并文章记录多源报道来源', () => {
    expect(articles.some((a) => a.alsoReportedBy?.includes('The Verge AI'))).toBe(true);
  });
});
