import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR } from './config.js';
import { fmtDateTime, todayStr } from './util.js';
import type { Article, FeedResult, SummaryResult } from './types.js';
import type { SummarizeStats } from './summarize.js';

/** HTML 转义（所有插值内容必须先经过它） */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 源配色徽章 */
const SOURCE_COLORS: Record<string, string> = {
  'TechCrunch AI': 'hsl(146 64% 32%)',
  'The Verge AI': 'hsl(262 72% 50%)',
  'Hacker News': 'hsl(28 78% 42%)',
};

/** 把 AI 摘要文本（"- " 列表 + **点评**: ...）解析为安全的 HTML 片段 */
function parseSummary(raw: string): string {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets: string[] = [];
  const paras: string[] = [];
  for (const line of lines) {
    if (line.startsWith('- ') || line.startsWith('• ')) {
      bullets.push(`<li><span>${esc(line.slice(2))}</span></li>`);
    } else {
      const m = line.match(/^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/);
      paras.push(
        m
          ? `<p class="verdict"><span class="verdict-label">${esc(m[1])}</span>${esc(m[2])}</p>`
          : `<p class="plain">${esc(line)}</p>`,
      );
    }
  }
  return (bullets.length ? `<ul>${bullets.join('')}</ul>` : '') + paras.join('');
}

function articleHtml(a: Article, r: SummaryResult | undefined, i: number): string {
  const badgeColor = SOURCE_COLORS[a.source] ?? 'hsl(210 12% 45%)';
  const fallbackTag = r?.usedFallbackText
    ? '<span class="tag tag-warn" title="目标网页抓取失败，摘要基于 RSS 简介">基于简介</span>'
    : '';
  const body = r?.summary
    ? parseSummary(r.summary)
    : '<p class="failed">AI 总结失败' +
      (r?.error ? `<span class="failed-reason">${esc(r.error)}</span>` : '') +
      '</p>';
  return `<article class="entry" data-source="${esc(a.source)}" data-text="${esc(
    (a.title + ' ' + (r?.summary ?? '')).toLowerCase(),
  )}" style="animation-delay:${Math.min(i * 35, 560)}ms">
  <div class="no">${i + 1}</div>
  <div class="body">
    <h2><a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a></h2>
    <div class="meta">
      <span class="badge"><i style="background:${badgeColor}"></i>${esc(a.source)}</span>
      <time>${fmtDateTime(a.pubDate)}</time>
      ${fallbackTag}
    </div>
    ${body}
  </div>
</article>`;
}

export function renderHtmlReport(
  articles: Article[],
  results: SummaryResult[],
  feeds: FeedResult[],
  stats: SummarizeStats,
  since: Date,
): string {
  const sources = [...new Set(articles.map((a) => a.source))];
  const perSource = sources.map(
    (s) =>
      `<button class="tab" data-filter="${esc(s)}"><i style="background:${
        SOURCE_COLORS[s] ?? 'hsl(210 12% 45%)'
      }"></i>${esc(s)}<span class="count">${articles.filter((a) => a.source === s).length}</span></button>`,
  );
  const failedFeeds = feeds.filter((f) => !f.ok);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 新闻日报 · ${todayStr()}</title>
<style>
  :root {
    --paper: #faf8f3;
    --paper-raise: #ffffff;
    --ink: #1c1a17;
    --ink-soft: #5c564d;
    --ink-faint: #8f887c;
    --rule: #e6e1d6;
    --accent: #b42318;
    --accent-soft: rgba(180, 35, 24, 0.08);
    --warn: #92620a;
    --serif: Georgia, "Times New Roman", "Songti SC", SimSun, serif;
    --sans: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    font-family: var(--sans);
    background: var(--paper);
    color: var(--ink);
    line-height: 1.7;
    font-size: 15px;
  }
  .sheet { max-width: 880px; margin: 0 auto; padding: 0 24px 80px; }

  /* ── 报头 ─────────────────────────── */
  header.masthead { padding: 44px 0 0; border-top: 4px solid var(--accent); }
  .masthead-inner {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 16px; flex-wrap: wrap; padding: 20px 0 14px;
    border-bottom: 1px solid var(--ink);
  }
  h1 {
    font-family: var(--serif); font-weight: 700;
    font-size: clamp(30px, 5.5vw, 44px); letter-spacing: 0.02em;
  }
  h1 .ai { color: var(--accent); font-style: italic; }
  .dateline {
    font-family: var(--serif); text-align: right; color: var(--ink-soft);
    font-size: 14px; line-height: 1.5; white-space: nowrap;
  }
  .dateline .d { font-size: 26px; font-weight: 700; color: var(--ink); letter-spacing: 0.04em; }
  .stats {
    display: flex; flex-wrap: wrap; gap: 6px 18px;
    padding: 10px 0; border-bottom: 1px solid var(--rule);
    color: var(--ink-soft); font-size: 12.5px; letter-spacing: 0.03em;
  }
  .stats b { color: var(--ink); font-weight: 600; }
  .feed-fail {
    padding: 10px 14px; margin-top: 14px; border-left: 3px solid var(--warn);
    background: var(--accent-soft); color: var(--ink-soft); font-size: 13px;
  }

  /* ── 工具栏 ────────────────────────── */
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    padding: 12px 0; margin-bottom: 8px;
    background: color-mix(in srgb, var(--paper) 88%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
  }
  .tab {
    font-family: var(--sans); font-size: 12.5px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 12px; border-radius: 999px;
    border: 1px solid var(--rule); background: var(--paper-raise); color: var(--ink-soft);
    transition: all 0.18s ease;
  }
  .tab i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .tab .count { font-size: 11px; color: var(--ink-faint); }
  .tab:hover { border-color: var(--ink-faint); color: var(--ink); }
  .tab.active { background: var(--ink); border-color: var(--ink); color: var(--paper); }
  .tab.active .count { color: var(--paper); opacity: 0.65; }
  .search {
    margin-left: auto; min-width: 150px; flex: 0 1 200px;
    padding: 6px 12px; font-size: 13px; font-family: var(--sans);
    border: 1px solid var(--rule); border-radius: 999px;
    background: var(--paper-raise); color: var(--ink); outline: none;
    transition: border-color 0.18s ease;
  }
  .search:focus { border-color: var(--accent); }
  .search::placeholder { color: var(--ink-faint); }

  /* ── 条目 ─────────────────────────── */
  .entries { margin-top: 8px; }
  .entry {
    display: flex; gap: 20px; padding: 26px 0;
    border-bottom: 1px solid var(--rule);
    animation: rise 0.5s cubic-bezier(0.2, 0.7, 0.3, 1) both;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } }
  .no {
    font-family: var(--serif); font-style: italic;
    font-size: 22px; color: var(--accent); opacity: 0.75;
    min-width: 34px; text-align: right; flex-shrink: 0;
    font-variant-numeric: tabular-nums; line-height: 1.4;
  }
  .body { min-width: 0; flex: 1; }
  h2 {
    font-family: var(--serif); font-size: 19.5px; line-height: 1.45;
    font-weight: 700; margin-bottom: 8px;
  }
  h2 a { color: var(--ink); text-decoration: none; }
  h2 a:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
  h2 a::after { content: " ↗"; font-size: 13px; color: var(--ink-faint); }
  .meta {
    display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px;
    font-size: 12px; color: var(--ink-soft); margin-bottom: 12px;
  }
  .badge { display: inline-flex; align-items: center; gap: 6px; letter-spacing: 0.04em; }
  .badge i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .tag-warn {
    padding: 1px 8px; border-radius: 999px; font-size: 11px;
    color: var(--warn); border: 1px solid var(--warn); opacity: 0.85;
  }
  .body ul { list-style: none; margin: 0 0 4px; }
  .body li {
    position: relative; padding-left: 16px; margin-bottom: 6px;
    color: var(--ink); font-size: 14.5px;
  }
  .body li::before {
    content: ""; position: absolute; left: 2px; top: 0.72em;
    width: 5px; height: 5px; background: var(--accent); border-radius: 50%;
  }
  .verdict {
    margin-top: 12px; padding: 2px 0 2px 12px;
    border-left: 2px solid var(--accent);
    color: var(--ink-soft); font-size: 13.5px; font-style: italic;
  }
  .verdict-label {
    font-style: normal; font-weight: 600; color: var(--accent);
    margin-right: 8px; font-size: 12.5px; letter-spacing: 0.06em;
  }
  .p-plain, .plain { font-size: 14.5px; margin-bottom: 6px; }
  .failed { color: var(--ink-faint); font-style: italic; font-size: 13.5px; }
  .failed-reason { display: block; font-size: 11.5px; opacity: 0.8; margin-top: 2px; }
  .empty {
    display: none; text-align: center; padding: 70px 0;
    color: var(--ink-faint); font-family: var(--serif); font-style: italic; font-size: 16px;
  }

  footer {
    margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--rule);
    color: var(--ink-faint); font-size: 12px; letter-spacing: 0.03em;
    display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px;
  }
  @media (max-width: 560px) {
    .entry { gap: 12px; padding: 20px 0; }
    .no { font-size: 16px; min-width: 24px; }
    h2 { font-size: 17.5px; }
  }
  @media print {
    .toolbar { display: none; }
    .entry { animation: none; }
  }
</style>
</head>
<body>
<div class="sheet">
  <header class="masthead">
    <div class="masthead-inner">
      <h1><span class="ai">AI</span> 新闻日报</h1>
      <div class="dateline">
        <span class="d">${todayStr()}</span><br>
        ${fmtDateTime(since)} — ${fmtDateTime(new Date())}
      </div>
    </div>
    <div class="stats">
      <span>共 <b>${articles.length}</b> 篇</span>
      <span>AI 总结 <b>${stats.ok}</b> / 失败 <b>${stats.failed}</b></span>
      <span>缓存命中 <b>${stats.cached}</b> 篇</span>
      <span>来源 ${sources.length} 个</span>
    </div>
  </header>
  ${
    failedFeeds.length
      ? `<div class="feed-fail">⚠ 抓取失败：${failedFeeds
          .map((f) => `${esc(f.source)}（${esc(f.error ?? '')}）`)
          .join('、')}</div>`
      : ''
  }
  <nav class="toolbar">
    <button class="tab active" data-filter=""><i style="background:var(--accent)"></i>全部<span class="count">${articles.length}</span></button>
    ${perSource.join('\n    ')}
    <input class="search" type="search" placeholder="搜索标题或摘要…" id="q">
  </nav>
  <main class="entries" id="entries">
${articles.map((a, i) => articleHtml(a, results[i], i)).join('\n')}
  </main>
  <div class="empty" id="empty">没有匹配的文章</div>
  <footer>
    <span>AI 新闻聚合器 · 自动生成</span>
    <span>${fmtDateTime(new Date())}</span>
  </footer>
</div>
<script>
  var currentSource = '';
  var q = document.getElementById('q');
  var tabs = document.querySelectorAll('.tab');
  var entries = Array.prototype.slice.call(document.querySelectorAll('.entry'));
  var empty = document.getElementById('empty');

  function apply() {
    var keyword = q.value.trim().toLowerCase();
    var shown = 0;
    entries.forEach(function (el) {
      var okSource = !currentSource || el.dataset.source === currentSource;
      var okText = !keyword || el.dataset.text.indexOf(keyword) !== -1;
      var visible = okSource && okText;
      el.style.display = visible ? '' : 'none';
      if (visible) shown++;
    });
    empty.style.display = shown ? 'none' : 'block';
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      tabs.forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      currentSource = t.dataset.filter;
      apply();
    });
  });
  q.addEventListener('input', apply);
</script>
</body>
</html>
`;
}

export function writeHtmlReport(html: string): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `${todayStr()}.html`);
  writeFileSync(file, html, 'utf-8');
  return file;
}
