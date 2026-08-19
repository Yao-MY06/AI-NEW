import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CATEGORIES, OUTPUT_DIR, SUMMARY } from './config.js';
import { fmtDateTime, todayStr } from './util.js';
import { computeStats } from './stats.js';
import type { Article, FeedResult, SummaryResult } from './types.js';
import type { SummarizeStats } from './summarize.js';
import type { ReportStats } from './stats.js';

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

/** 把摘要正文（"- " 列表 + **点评**: ...）解析为安全的 HTML 片段 */
function parseSummary(raw: string): string {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const bullets: string[] = [];
  const paras: string[] = [];
  for (const line of lines) {
    if (line.startsWith('- ') || line.startsWith('• ')) {
      bullets.push(`<li><span>${esc(line.slice(2))}</span></li>`);
    } else {
      const m = line.match(/^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/);
      paras.push(
        m
          ? `<p class="verdict"><span class="verdict-label">${esc(m[1] ?? '')}</span>${esc(
              m[2] ?? '',
            )}</p>`
          : `<p class="plain">${esc(line)}</p>`,
      );
    }
  }
  return (bullets.length ? `<ul>${bullets.join('')}</ul>` : '') + paras.join('');
}

function articleHtml(a: Article, r: SummaryResult | undefined, i: number): string {
  const badgeColor = SOURCE_COLORS[a.source] ?? 'hsl(210 12% 45%)';
  const cat = a.category ?? '其他';
  const tags = [
    a.pinned ? '<span class="tag tag-pin">★ 关注</span>' : '',
    a.alsoReportedBy?.length
      ? `<span class="tag tag-multi" title="另有 ${esc(a.alsoReportedBy.join('、'))} 报道同一事件">多源报道</span>`
      : '',
    r?.usedFallbackText
      ? '<span class="tag tag-warn" title="目标网页抓取失败，摘要基于 RSS 简介">基于简介</span>'
      : '',
  ].join('');
  const body = r?.summary
    ? parseSummary(r.summary)
    : '<p class="failed">AI 总结失败' +
      (r?.error ? `<span class="failed-reason">${esc(r.error)}</span>` : '') +
      '</p>';
  const zhTitle = a.titleZh ?? a.title;
  const orig = a.titleZh && a.titleZh !== a.title ? `<div class="orig">${esc(a.title)}</div>` : '';
  const preview = (a.previewText || a.text).slice(0, 1500);
  return `<article class="entry" data-source="${esc(a.source)}" data-cat="${esc(
    cat,
  )}" data-link="${esc(a.link)}" data-zh="${esc(zhTitle)}" data-text="${esc(
    (a.title + ' ' + zhTitle + ' ' + (r?.summary ?? '')).toLowerCase(),
  )}" style="animation-delay:${Math.min(i * 35, 560)}ms">
  <div class="no">${i + 1}</div>
  <div class="body">
    <h2><a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">${esc(zhTitle)}</a></h2>
    ${orig}
    <div class="meta">
      <span class="badge"><i style="background:${badgeColor}"></i>${esc(a.source)}</span>
      <span class="badge badge-cat">${esc(cat)}</span>
      <time>${fmtDateTime(a.pubDate)}</time>
      ${tags}
      <button class="pv-btn" type="button" title="预览已抓取的正文片段">预览</button>
    </div>
    ${body}
  </div>
  <template class="pv">${esc(preview)}</template>
</article>`;
}

function dashboardHtml(rs: ReportStats): string {
  const bar = (items: { name: string; n: number }[], color?: (n: string) => string) => {
    const max = Math.max(...items.map((x) => x.n), 1);
    return items
      .map(
        (x) =>
          `<div class="bar"><span class="bar-label">${esc(x.name)}</span><span class="bar-track"><i style="width:${Math.round(
            (x.n / max) * 100,
          )}%;${color ? `background:${color(x.name)}` : ''}"></i></span><b>${x.n}</b></div>`,
      )
      .join('');
  };
  const maxW = Math.max(...rs.topWords.map((x) => x.n), 1);
  const words = rs.topWords
    .map(
      (x) =>
        `<span class="wcloud" style="font-size:${12 + Math.round((x.n / maxW) * 10)}px">${esc(
          x.name,
        )}<i>${x.n}</i></span>`,
    )
    .join('');
  return `<div class="dash">
    <div class="dash-card"><h4>来源分布</h4>${bar(rs.bySource, (n) => SOURCE_COLORS[n] ?? 'var(--accent)')}</div>
    <div class="dash-card"><h4>分类分布</h4>${bar(rs.byCategory)}</div>
    <div class="dash-card"><h4>标题热词</h4><div class="wcloud-wrap">${words || '—'}</div></div>
  </div>`;
}

export function renderHtmlReport(
  articles: Article[],
  results: SummaryResult[],
  feeds: FeedResult[],
  stats: SummarizeStats,
  since: Date,
): string {
  const sources = [...new Set(articles.map((a) => a.source))];
  const pinCount = articles.filter((a) => a.pinned).length;
  const cats = CATEGORIES.filter((c) => articles.some((a) => (a.category ?? '其他') === c));
  const rs = computeStats(articles);
  const failedFeeds = feeds.filter((f) => !f.ok);

  // 分组：关注置顶 → 按分类（固定顺序），组内时间倒序，序号全局连续
  const flatten: Article[] = [];
  const sections: { key: string; label: string; list: Article[] }[] = [];
  const pinned = articles.filter((a) => a.pinned);
  if (pinned.length) sections.push({ key: '__pin', label: '★ 关注', list: pinned });
  for (const c of cats) {
    sections.push({
      key: c,
      label: c,
      list: articles.filter((a) => (a.category ?? '其他') === c && !a.pinned),
    });
  }
  for (const s of sections) flatten.push(...s.list);

  const sectionsHtml = sections
    .map((s) => {
      // 预建 文章→结果 映射，避免 O(N²) 的 indexOf 且类型上显式容忍 undefined
      const rOf = new Map(articles.map((a, i) => [a, results[i]] as const));
      const inner = s.list.map((a) => articleHtml(a, rOf.get(a), flatten.indexOf(a))).join('\n');
      return `<section class="cat" data-cat="${esc(s.key)}">
    <h3 class="cat-h"><span>${esc(s.label)}</span><em>${s.list.length} 篇</em></h3>
${inner}
  </section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
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
  html[data-theme="dark"] {
    --paper: #161513;
    --paper-raise: #1e1c19;
    --ink: #e9e5dc;
    --ink-soft: #a8a196;
    --ink-faint: #6e675c;
    --rule: #2c2a26;
    --accent: #ef6a5e;
    --accent-soft: rgba(239, 106, 94, 0.1);
    --warn: #d9a448;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body { font-family: var(--sans); background: var(--paper); color: var(--ink); line-height: 1.7; font-size: 15px; }
  .sheet { max-width: 880px; margin: 0 auto; padding: 0 24px 80px; }

  /* ── 报头 ─────────────────────────── */
  header.masthead { padding: 44px 0 0; border-top: 4px solid var(--accent); }
  .masthead-inner {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 16px; flex-wrap: wrap; padding: 20px 0 14px; border-bottom: 1px solid var(--ink);
  }
  h1 { font-family: var(--serif); font-weight: 700; font-size: clamp(30px, 5.5vw, 44px); letter-spacing: 0.02em; }
  h1 .ai { color: var(--accent); font-style: italic; }
  .dateline { font-family: var(--serif); text-align: right; color: var(--ink-soft); font-size: 14px; line-height: 1.5; white-space: nowrap; }
  .dateline .d { font-size: 26px; font-weight: 700; color: var(--ink); letter-spacing: 0.04em; }
  .stats {
    display: flex; flex-wrap: wrap; gap: 6px 18px; padding: 10px 0;
    border-bottom: 1px solid var(--rule); color: var(--ink-soft); font-size: 12.5px; letter-spacing: 0.03em;
  }
  .stats b { color: var(--ink); font-weight: 600; }
  .feed-fail {
    padding: 10px 14px; margin-top: 14px; border-left: 3px solid var(--warn);
    background: var(--accent-soft); color: var(--ink-soft); font-size: 13px;
  }

  /* ── 统计看板 ─────────────────────── */
  .dash { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }
  .dash-card {
    background: var(--paper-raise); border: 1px solid var(--rule); border-radius: 8px;
    padding: 12px 14px; animation: rise 0.5s cubic-bezier(0.2, 0.7, 0.3, 1) both;
  }
  .dash-card h4 {
    font-size: 11px; letter-spacing: 0.12em; color: var(--ink-faint);
    font-weight: 600; margin-bottom: 8px; text-transform: uppercase;
  }
  .bar { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; font-size: 12px; }
  .bar-label { width: 76px; flex-shrink: 0; color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; height: 8px; background: var(--rule); border-radius: 4px; overflow: hidden; }
  .bar-track i { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
  .bar b { width: 20px; text-align: right; color: var(--ink); font-weight: 600; }
  .wcloud-wrap { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; padding-top: 4px; }
  .wcloud { color: var(--ink-soft); line-height: 1.5; }
  .wcloud i { font-style: normal; font-size: 10px; color: var(--accent); vertical-align: super; }

  /* ── 工具栏 ────────────────────────── */
  .toolbar {
    position: sticky; top: 0; z-index: 10; padding: 12px 0; margin: 8px 0 0;
    background: color-mix(in srgb, var(--paper) 88%, transparent);
    backdrop-filter: blur(8px); border-bottom: 1px solid var(--rule);
  }
  .toolbar-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .toolbar-row + .toolbar-row { margin-top: 8px; }
  .tab, .chip {
    font-family: var(--sans); font-size: 12.5px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 12px; border-radius: 999px; border: 1px solid var(--rule);
    background: var(--paper-raise); color: var(--ink-soft); transition: all 0.18s ease;
  }
  .tab i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .tab .count, .chip .count { font-size: 11px; color: var(--ink-faint); }
  .tab:hover, .chip:hover { border-color: var(--ink-faint); color: var(--ink); }
  .tab.active, .chip.active { background: var(--ink); border-color: var(--ink); color: var(--paper); }
  .tab.active .count, .chip.active .count { color: var(--paper); opacity: 0.65; }
  .search {
    margin-left: auto; min-width: 140px; flex: 0 1 190px; padding: 6px 12px; font-size: 13px;
    font-family: var(--sans); border: 1px solid var(--rule); border-radius: 999px;
    background: var(--paper-raise); color: var(--ink); outline: none; transition: border-color 0.18s ease;
  }
  .search:focus { border-color: var(--accent); }
  .search::placeholder { color: var(--ink-faint); }
  .tool-btn {
    font-size: 12.5px; cursor: pointer; padding: 5px 12px; border-radius: 999px;
    border: 1px solid var(--rule); background: var(--paper-raise); color: var(--ink-soft);
    text-decoration: none; transition: all 0.18s ease; white-space: nowrap;
  }
  .tool-btn:hover { border-color: var(--ink-faint); color: var(--ink); }

  /* ── 分栏与条目 ───────────────────── */
  .cat-h {
    display: flex; align-items: baseline; gap: 10px; margin: 30px 0 4px;
    font-family: var(--serif); font-size: 17px; font-weight: 700;
  }
  .cat-h::after { content: ""; flex: 1; height: 1px; background: var(--rule); }
  .cat-h em { font-style: normal; font-size: 11.5px; color: var(--ink-faint); font-family: var(--sans); letter-spacing: 0.06em; }
  .entry {
    display: flex; gap: 20px; padding: 26px 0; border-bottom: 1px solid var(--rule);
    animation: rise 0.5s cubic-bezier(0.2, 0.7, 0.3, 1) both;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } }
  .no {
    font-family: var(--serif); font-style: italic; font-size: 22px; color: var(--accent);
    opacity: 0.75; min-width: 34px; text-align: right; flex-shrink: 0;
    font-variant-numeric: tabular-nums; line-height: 1.4;
  }
  .body { min-width: 0; flex: 1; }
  h2 { font-family: var(--serif); font-size: 19.5px; line-height: 1.45; font-weight: 700; margin-bottom: 4px; }
  h2 a { color: var(--ink); text-decoration: none; }
  h2 a:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
  h2 a::after { content: " ↗"; font-size: 13px; color: var(--ink-faint); }
  .orig { font-size: 12.5px; color: var(--ink-faint); font-style: italic; margin-bottom: 6px; }
  .meta {
    display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px;
    font-size: 12px; color: var(--ink-soft); margin-bottom: 12px;
  }
  .badge { display: inline-flex; align-items: center; gap: 6px; letter-spacing: 0.04em; }
  .badge i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .badge-cat { color: var(--ink-faint); }
  .tag-warn { padding: 1px 8px; border-radius: 999px; font-size: 11px; color: var(--warn); border: 1px solid var(--warn); opacity: 0.85; }
  .tag-pin { padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; color: var(--accent); border: 1px solid var(--accent); background: var(--accent-soft); }
  .tag-multi { padding: 1px 8px; border-radius: 999px; font-size: 11px; color: var(--ink-soft); border: 1px solid var(--rule); }
  .pv-btn {
    font-size: 11px; cursor: pointer; padding: 1px 9px; border-radius: 999px;
    border: 1px dashed var(--ink-faint); background: transparent; color: var(--ink-faint);
    transition: all 0.15s ease;
  }
  .pv-btn:hover { color: var(--accent); border-color: var(--accent); }
  .body ul { list-style: none; margin: 0 0 4px; }
  .body li { position: relative; padding-left: 16px; margin-bottom: 6px; color: var(--ink); font-size: 14.5px; }
  .body li::before {
    content: ""; position: absolute; left: 2px; top: 0.72em;
    width: 5px; height: 5px; background: var(--accent); border-radius: 50%;
  }
  .verdict {
    margin-top: 12px; padding: 2px 0 2px 12px; border-left: 2px solid var(--accent);
    color: var(--ink-soft); font-size: 13.5px; font-style: italic;
  }
  .verdict-label { font-style: normal; font-weight: 600; color: var(--accent); margin-right: 8px; font-size: 12.5px; letter-spacing: 0.06em; }
  .p-plain, .plain { font-size: 14.5px; margin-bottom: 6px; }
  .failed { color: var(--ink-faint); font-style: italic; font-size: 13.5px; }
  .failed-reason { display: block; font-size: 11.5px; opacity: 0.8; margin-top: 2px; }
  .empty { display: none; text-align: center; padding: 70px 0; color: var(--ink-faint); font-family: var(--serif); font-style: italic; font-size: 16px; }

  /* ── 预览弹窗 ─────────────────────── */
  dialog#pv {
    max-width: 640px; width: calc(100vw - 48px); max-height: 76vh;
    border: 1px solid var(--rule); border-radius: 12px; background: var(--paper-raise);
    color: var(--ink); padding: 24px 26px; box-shadow: 0 24px 64px rgba(0,0,0,0.25);
  }
  dialog#pv::backdrop { background: rgba(20, 18, 14, 0.55); backdrop-filter: blur(3px); }
  #pv-title { font-family: var(--serif); font-size: 18px; line-height: 1.45; margin-bottom: 10px; }
  #pv-text { font-size: 13.5px; color: var(--ink-soft); white-space: pre-wrap; max-height: 48vh; overflow-y: auto; padding-right: 6px; }
  .pv-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; gap: 10px; }
  .pv-foot a { color: var(--accent); font-size: 13px; text-decoration: none; }
  .pv-foot a:hover { text-decoration: underline; }

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
    .toolbar, .pv-btn { display: none !important; }
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
      <span>模板 <b>${SUMMARY.label}</b></span>
      <span>共 <b>${articles.length}</b> 篇</span>
      <span>AI 总结 <b>${stats.ok}</b> / 失败 <b>${stats.failed}</b></span>
      <span>缓存命中 <b>${stats.cached}</b> 篇</span>
      <span>来源 ${sources.length} 个</span>
      ${pinCount ? `<span>★ 关注 <b>${pinCount}</b> 篇</span>` : ''}
    </div>
  </header>
  ${
    failedFeeds.length
      ? `<div class="feed-fail">⚠ 抓取失败：${failedFeeds
          .map((f) => `${esc(f.source)}（${esc(f.error ?? '')}）`)
          .join('、')}</div>`
      : ''
  }
  ${dashboardHtml(rs)}
  <nav class="toolbar">
    <div class="toolbar-row">
      <button class="tab active" data-source=""><i style="background:var(--accent)"></i>全部<span class="count">${articles.length}</span></button>
      ${sources
        .map(
          (s) =>
            `<button class="tab" data-source="${esc(s)}"><i style="background:${
              SOURCE_COLORS[s] ?? 'hsl(210 12% 45%)'
            }"></i>${esc(s)}<span class="count">${articles.filter((a) => a.source === s).length}</span></button>`,
        )
        .join('\n      ')}
      <a class="tool-btn" href="./index.html">📄 历史存档</a>
      <button class="tool-btn" id="theme" type="button">🌙 深色</button>
    </div>
    <div class="toolbar-row">
      ${
        cats
          .map(
            (c) =>
              `<button class="chip" data-cat="${esc(c)}">${esc(c)}<span class="count">${
                articles.filter((a) => (a.category ?? '其他') === c).length
              }</span></button>`,
          )
          .join('\n      ') || '<span></span>'
      }
      <input class="search" type="search" placeholder="搜索标题或摘要…" id="q">
    </div>
  </nav>
  <main id="entries">
${sectionsHtml}
  </main>
  <div class="empty" id="empty">没有匹配的文章</div>
  <footer>
    <span>AI 新闻聚合器 · 自动生成</span>
    <span>${fmtDateTime(new Date())}</span>
  </footer>
</div>

<dialog id="pv">
  <h3 id="pv-title"></h3>
  <div id="pv-text"></div>
  <div class="pv-foot">
    <a id="pv-link" href="#" target="_blank" rel="noopener noreferrer">查看原文 ↗</a>
    <button class="tool-btn" id="pv-close" type="button">关闭 Esc</button>
  </div>
</dialog>

<script>
  // ── 筛选（来源 × 分类 × 关键词） ──
  var activeSource = '', activeCat = '', kw = '';
  var q = document.getElementById('q');
  var empty = document.getElementById('empty');
  function apply() {
    var keyword = q.value.trim().toLowerCase(), any = false;
    document.querySelectorAll('.entry').forEach(function (el) {
      var ok = (!activeSource || el.dataset.source === activeSource)
        && (!activeCat || (el.dataset.cat === activeCat))
        && (!keyword || el.dataset.text.indexOf(keyword) !== -1);
      el.style.display = ok ? '' : 'none';
      if (ok) any = true;
    });
    document.querySelectorAll('section.cat').forEach(function (s) {
      var hasVisible = !!s.querySelector('.entry:not([style*="none"])');
      var catOk = !activeCat || s.dataset.cat === activeCat;
      s.style.display = hasVisible && catOk ? '' : 'none';
    });
    empty.style.display = any ? 'none' : 'block';
  }
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      activeSource = t.dataset.source;
      apply();
    });
  });
  document.querySelectorAll('.chip').forEach(function (c) {
    c.addEventListener('click', function () {
      var on = c.classList.toggle('active');
      document.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('active'); });
      if (on) c.classList.add('active');
      activeCat = on ? c.dataset.cat : '';
      apply();
    });
  });
  q.addEventListener('input', apply);

  // ── 主题切换（默认浅色，记住选择） ──
  var themeBtn = document.getElementById('theme');
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('ainew-theme', t); } catch (e) {}
    themeBtn.textContent = t === 'dark' ? '☀ 浅色' : '🌙 深色';
  }
  themeBtn.addEventListener('click', function () {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  var saved = null;
  try { saved = localStorage.getItem('ainew-theme'); } catch (e) {}
  if (saved) setTheme(saved);

  // ── 原文预览弹窗 ──
  var dlg = document.getElementById('pv');
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.pv-btn');
    if (!b) return;
    var entry = b.closest('.entry');
    var tpl = entry.querySelector('template.pv');
    document.getElementById('pv-title').textContent = entry.dataset.zh || '';
    document.getElementById('pv-text').textContent = tpl && tpl.content.textContent.trim()
      ? tpl.content.textContent.trim() : '（无已抓取的正文片段）';
    document.getElementById('pv-link').href = entry.dataset.link || '#';
    dlg.showModal();
  });
  document.getElementById('pv-close').addEventListener('click', function () { dlg.close(); });
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
