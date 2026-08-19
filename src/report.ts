import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CATEGORIES, OUTPUT_DIR, SUMMARY } from './config.js';
import { fmtDateTime, todayStr } from './util.js';
import type { Article, FeedResult, SummaryResult } from './types.js';
import type { SummarizeStats } from './summarize.js';

function entryMd(a: Article, r: SummaryResult | undefined, no: number): string {
  const marks: string[] = [];
  if (a.pinned) marks.push('**★ 关注**');
  if (a.alsoReportedBy?.length) marks.push(`多源报道（${a.alsoReportedBy.join('、')}）`);
  if (a.quality !== undefined) marks.push(`★ 质量评分 ${a.quality.toFixed(1)}`);
  if (r?.usedFallbackText) marks.push('*摘要基于简介*');
  const zhTitle = a.titleZh ?? a.title;
  const orig = a.titleZh && a.titleZh !== a.title ? `\n\n*原题: ${a.title}*` : '';
  return `### ${no}. [${zhTitle}](${a.link})${orig}

\`${a.source}\` · \`${a.category ?? '其他'}\` · ${fmtDateTime(a.pubDate)}${
    marks.length ? ` · ${marks.join(' · ')}` : ''
  }

${r?.summary ?? '*（AI 总结失败）*'}
`;
}

/** 分组：★ 关注 → 各分类（固定顺序） */
function groupArticles(articles: Article[]): { label: string; list: Article[] }[] {
  const groups: { label: string; list: Article[] }[] = [];
  const pinned = articles.filter((a) => a.pinned);
  if (pinned.length) groups.push({ label: '★ 关注', list: pinned });
  for (const c of CATEGORIES) {
    const list = articles.filter((a) => (a.category ?? '其他') === c && !a.pinned);
    if (list.length) groups.push({ label: c, list });
  }
  return groups;
}

export function renderReport(
  articles: Article[],
  results: SummaryResult[],
  feeds: FeedResult[],
  stats: SummarizeStats,
  since: Date,
): string {
  const lines: string[] = [];
  const failedFeeds = feeds.filter((f) => !f.ok);
  const pinCount = articles.filter((a) => a.pinned).length;

  lines.push(`# AI 新闻日报 · ${todayStr()}`, '');
  lines.push(
    `> 时间范围: ${fmtDateTime(since)} ~ ${fmtDateTime(new Date())} · 模板: ${SUMMARY.label} · 共 ${articles.length} 篇（AI 总结成功 ${stats.ok} / 失败 ${stats.failed}${
      pinCount ? ` · ★ 关注 ${pinCount}` : ''
    }）`,
  );
  if (failedFeeds.length) {
    lines.push(
      '>',
      `> ⚠ 抓取失败: ${failedFeeds.map((f) => `${f.source}（${f.error}）`).join('、')}`,
    );
  }
  lines.push('', '---', '');

  // 预建 文章→结果 映射，避免 O(N²) 的 indexOf 且类型上显式容忍 undefined
  const rOf = new Map(articles.map((a, i) => [a, results[i]] as const));
  let no = 0;
  for (const g of groupArticles(articles)) {
    lines.push(`## ${g.label}（${g.list.length} 篇）`, '');
    for (const a of g.list) {
      lines.push(entryMd(a, rOf.get(a), ++no), '');
    }
  }

  lines.push('---', `*生成于 ${fmtDateTime(new Date())} · 缓存命中 ${stats.cached} 篇*`, '');
  return lines.join('\n');
}

/** 纯文本版（适合邮件/剪贴板） */
export function renderTextReport(
  articles: Article[],
  results: SummaryResult[],
  stats: SummarizeStats,
): string {
  const lines: string[] = [];
  lines.push(
    `AI 新闻日报 ${todayStr()}（模板: ${SUMMARY.label}，共 ${articles.length} 篇，总结 ${stats.ok}）`,
    '',
  );
  const rOf = new Map(articles.map((a, i) => [a, results[i]] as const));
  let no = 0;
  for (const g of groupArticles(articles)) {
    lines.push(`━━ ${g.label}（${g.list.length}）━━`, '');
    for (const a of g.list) {
      const r = rOf.get(a);
      const zh = a.titleZh ?? a.title;
      lines.push(`${++no}. ${zh}${a.titleZh ? `（${a.title}）` : ''}`);
      lines.push(`   [${a.source}/${a.category ?? '其他'}] ${a.link}`);
      if (r?.summary) lines.push(r.summary.replace(/^/gm, '   '));
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function writeReport(content: string): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `${todayStr()}.md`);
  writeFileSync(file, content, 'utf-8');
  return file;
}

export function writeTextReport(content: string): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `${todayStr()}.txt`);
  writeFileSync(file, content, 'utf-8');
  return file;
}
