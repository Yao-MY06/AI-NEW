import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR } from './config.js';
import { fmtDateTime, todayStr } from './util.js';
import type { Article, FeedResult, SummaryResult } from './types.js';
import type { SummarizeStats } from './summarize.js';

export function renderReport(
  articles: Article[],
  results: SummaryResult[],
  feeds: FeedResult[],
  stats: SummarizeStats,
  since: Date,
): string {
  const lines: string[] = [];
  const failedFeeds = feeds.filter((f) => !f.ok);

  lines.push(`# AI 新闻日报 · ${todayStr()}`, '');
  lines.push(
    `> 时间范围: ${fmtDateTime(since)} ~ ${fmtDateTime(new Date())} · 共 ${articles.length} 篇（AI 总结成功 ${stats.ok} / 失败 ${stats.failed}）`,
  );
  if (failedFeeds.length) {
    lines.push('>', `> ⚠ 抓取失败: ${failedFeeds.map((f) => `${f.source}（${f.error}）`).join('、')}`);
  }
  lines.push('', '---', '');

  articles.forEach((a, i) => {
    const r = results[i];
    lines.push(`## ${i + 1}. [${a.title}](${a.link})`, '');
    lines.push(
      `\`${a.source}\` · ${fmtDateTime(a.pubDate)}${r?.usedFallbackText ? ' · *正文抓取失败，摘要基于简介*' : ''}`,
      '',
    );
    lines.push(r?.summary ?? '*（AI 总结失败）*');
    lines.push('');
  });

  lines.push('---', `*生成于 ${fmtDateTime(new Date())} · 缓存命中 ${stats.cached} 篇*`, '');
  return lines.join('\n');
}

export function writeReport(content: string): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `${todayStr()}.md`);
  writeFileSync(file, content, 'utf-8');
  return file;
}
