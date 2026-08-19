import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR } from './config.js';
import { todayStr } from './util.js';
import type { Article, SummaryResult } from './types.js';
import type { SummarizeStats } from './summarize.js';

const ARCHIVE_FILE = path.join(OUTPUT_DIR, 'archive.json');

interface ArchiveItem {
  t: string; // 原始标题
  zh?: string; // 中文标题
  cat: string;
  src: string;
  link: string;
}

interface DayEntry {
  date: string;
  total: number;
  ok: number;
  failed: number;
  bySource: Record<string, number>;
  byCategory: Record<string, number>;
  items: ArchiveItem[];
  ts: number;
}

type Archive = Record<string, DayEntry>;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadArchive(): Archive {
  try {
    if (!existsSync(ARCHIVE_FILE)) return {};
    return JSON.parse(readFileSync(ARCHIVE_FILE, 'utf-8')) as Archive;
  } catch {
    return {};
  }
}

/** 更新 manifest 并生成存档首页（index.html），返回写入的文件 */
export function updateArchive(
  articles: Article[],
  results: SummaryResult[],
  stats: SummarizeStats,
): { manifest: string; index: string } {
  const archive = loadArchive();
  const date = todayStr();
  const bySource: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const items: ArchiveItem[] = [];
  articles.forEach((a, i) => {
    bySource[a.source] = (bySource[a.source] ?? 0) + 1;
    const cat = a.category ?? '其他';
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    items.push({ t: a.title, zh: a.titleZh, cat, src: a.source, link: a.link });
    void results[i];
  });
  archive[date] = {
    date,
    total: articles.length,
    ok: stats.ok,
    failed: stats.failed,
    bySource,
    byCategory,
    items,
    ts: Date.now(),
  };
  writeFileSync(ARCHIVE_FILE, JSON.stringify(archive, null, 1), 'utf-8');
  const index = path.join(OUTPUT_DIR, 'index.html');
  writeFileSync(index, renderIndex(archive), 'utf-8');
  return { manifest: ARCHIVE_FILE, index };
}

/** 存档首页：按月分组的日期列表 + 全文检索 + 跨天事件时间线（客户端标题聚类） */
function renderIndex(archive: Archive): string {
  const days = Object.values(archive).sort((a, b) => b.date.localeCompare(a.date));
  const data = JSON.stringify(days);

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 新闻日报 · 历史存档</title>
<style>
  :root {
    --paper: #faf8f3; --paper-raise: #ffffff; --ink: #1c1a17; --ink-soft: #5c564d;
    --ink-faint: #8f887c; --rule: #e6e1d6; --accent: #b42318;
    --accent-soft: rgba(180, 35, 24, 0.08);
    --serif: Georgia, "Times New Roman", "Songti SC", SimSun, serif;
    --sans: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  html[data-theme="dark"] {
    --paper: #161513; --paper-raise: #1e1c19; --ink: #e9e5dc; --ink-soft: #a8a196;
    --ink-faint: #6e675c; --rule: #2c2a26; --accent: #ef6a5e;
    --accent-soft: rgba(239, 106, 94, 0.1);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--sans); background: var(--paper); color: var(--ink); line-height: 1.7; font-size: 15px; }
  .sheet { max-width: 880px; margin: 0 auto; padding: 0 24px 80px; }
  header.masthead { padding: 44px 0 0; border-top: 4px solid var(--accent); }
  .masthead-inner { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 20px 0 14px; border-bottom: 1px solid var(--ink); }
  h1 { font-family: var(--serif); font-weight: 700; font-size: clamp(28px, 5vw, 40px); }
  h1 .ai { color: var(--accent); font-style: italic; }
  .back { font-size: 13px; color: var(--ink-soft); }
  .back a { color: var(--accent); text-decoration: none; }
  .toolbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--rule); background: color-mix(in srgb, var(--paper) 88%, transparent); backdrop-filter: blur(8px); flex-wrap: wrap; }
  .search { flex: 1; min-width: 160px; max-width: 320px; padding: 6px 12px; font-size: 13px; border: 1px solid var(--rule); border-radius: 999px; background: var(--paper-raise); color: var(--ink); outline: none; }
  .search:focus { border-color: var(--accent); }
  .tool-btn { font-size: 12.5px; cursor: pointer; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--rule); background: var(--paper-raise); color: var(--ink-soft); }
  .tool-btn:hover { color: var(--ink); border-color: var(--ink-faint); }
  h2.sec { font-family: var(--serif); font-size: 20px; margin: 34px 0 6px; }
  .day {
    display: flex; gap: 16px; align-items: baseline; padding: 16px 0;
    border-bottom: 1px solid var(--rule); flex-wrap: wrap;
  }
  .day-date { font-family: var(--serif); font-size: 20px; font-weight: 700; min-width: 108px; }
  .day-date a { color: var(--ink); text-decoration: none; }
  .day-date a:hover { color: var(--accent); }
  .day-meta { color: var(--ink-soft); font-size: 12.5px; }
  .day-meta b { color: var(--ink); }
  .day-cats { display: flex; gap: 6px; flex-wrap: wrap; }
  .day-cats span { font-size: 11px; color: var(--ink-soft); border: 1px solid var(--rule); border-radius: 999px; padding: 1px 8px; }
  .day-titles { flex-basis: 100%; color: var(--ink-faint); font-size: 12px; display: none; }
  .day.open .day-titles { display: block; }
  .day-titles li { margin: 2px 0; list-style: none; }
  .day-titles a { color: var(--ink-soft); text-decoration: none; }
  .day-titles a:hover { color: var(--accent); }
  .day { cursor: pointer; }
  .evt { border: 1px solid var(--rule); border-left: 3px solid var(--accent); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; background: var(--paper-raise); }
  .evt h3 { font-family: var(--serif); font-size: 16px; margin-bottom: 6px; }
  .evt li { list-style: none; font-size: 13px; color: var(--ink-soft); margin: 3px 0; }
  .evt li b { color: var(--accent); font-family: var(--serif); margin-right: 8px; }
  .evt li a { color: var(--ink); text-decoration: none; }
  .evt li a:hover { color: var(--accent); }
  .empty { text-align: center; padding: 60px 0; color: var(--ink-faint); font-style: italic; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--rule); color: var(--ink-faint); font-size: 12px; display: flex; justify-content: space-between; }
</style>
</head>
<body>
<div class="sheet">
  <header class="masthead">
    <div class="masthead-inner">
      <h1><span class="ai">AI</span> 新闻日报 · 历史存档</h1>
      <div class="back"><a href="./${todayStr()}.html">→ 今日日报</a></div>
    </div>
  </header>
  <div class="toolbar">
    <input class="search" type="search" id="q" placeholder="检索全部历史标题…">
    <button class="tool-btn" id="theme" type="button">🌙 深色</button>
  </div>

  <h2 class="sec">事件时间线 <small style="font-size:12px;color:var(--ink-faint)">（跨天同题自动聚类）</small></h2>
  <div id="events"><div class="empty">暂无跨天事件（需要至少两天的存档）</div></div>

  <h2 class="sec">按日期回溯</h2>
  <div id="days"></div>
  <div class="empty" id="empty" style="display:none">没有匹配的日期</div>
  <footer>
    <span>AI 新闻聚合器 · 存档</span>
    <span>${days.length} 天</span>
  </footer>
</div>
<script>
  var DATA = ${data};

  // ── 日期列表 ──
  var daysEl = document.getElementById('days');
  function renderDays(list) {
    daysEl.innerHTML = list.length ? list.map(function (d) {
      var cats = Object.entries(d.byCategory).sort(function (a, b) { return b[1] - a[1]; })
        .map(function (c) { return '<span>' + esc(c[0]) + ' ' + c[1] + '</span>'; }).join('');
      var titles = d.items.slice(0, 30).map(function (it) {
        return '<li><a href="' + esc(it.link) + '" target="_blank" rel="noopener">' + esc(it.zh || it.t) + '</a> <i style="opacity:.6">[' + esc(it.src) + ']</i></li>';
      }).join('');
      return '<div class="day" data-text="' + esc((d.items.map(function (i) { return (i.zh || '') + ' ' + i.t; }).join(' ') || '').toLowerCase()) + '">' +
        '<div class="day-date"><a href="./' + d.date + '.html">' + d.date + '</a></div>' +
        '<div class="day-meta"><b>' + d.total + '</b> 篇 · 总结 ' + d.ok + '</div>' +
        '<div class="day-cats">' + cats + '</div>' +
        '<ul class="day-titles">' + titles + '</ul></div>';
    }).join('') : '';
    document.querySelectorAll('.day').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        el.classList.toggle('open');
      });
    });
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  renderDays(DATA);
  // 检索：在原始数据上匹配标题与日期
  document.getElementById('q').addEventListener('input', function () {
    var kw = this.value.trim().toLowerCase();
    var list = kw ? DATA.filter(function (d) {
      return d.items.some(function (it) { return ((it.zh || '') + ' ' + it.t).toLowerCase().indexOf(kw) !== -1; })
        || d.date.indexOf(kw) !== -1;
    }) : DATA;
    renderDays(list);
    document.getElementById('empty').style.display = list.length ? 'none' : 'block';
  });

  // ── 事件时间线：跨天标题词集聚类 ──
  var STOP = new Set(['the','a','an','of','to','in','on','for','with','and','or','its','is','are','as','at','by','from','how','why','what','when','new','vs','using','after','before','your','you','their','this','that','about']);
  function tokens(t) {
    return new Set(t.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').split(' ').filter(function (w) { return w.length > 1 && !STOP.has(w); }));
  }
  function jac(a, b) {
    if (!a.size || !b.size) return 0;
    var n = 0; a.forEach(function (w) { if (b.has(w)) n++; });
    return n / (a.size + b.size - n);
  }
  (function buildEvents() {
    var flat = [];
    DATA.forEach(function (d) {
      d.items.forEach(function (it) { flat.push({ date: d.date, t: it.t, zh: it.zh, link: it.link, src: it.src, tk: tokens(it.t) }); });
    });
    if (flat.length < 2) return;
    var parent = flat.map(function (_, i) { return i; });
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (var i = 0; i < flat.length; i++) {
      for (var j = i + 1; j < flat.length; j++) {
        if (flat[i].date === flat[j].date) continue; // 只跨天聚类
        if (jac(flat[i].tk, flat[j].tk) >= 0.45) {
          var a = find(i), b = find(j);
          if (a !== b) parent[a] = b;
        }
      }
    }
    var groups = {};
    flat.forEach(function (_, i) {
      var r = find(i);
      (groups[r] = groups[r] || []).push(flat[i]);
    });
    var evts = Object.values(groups)
      .filter(function (g) { return new Set(g.map(function (x) { return x.date; })).size >= 2; })
      .sort(function (a, b) { return b.length - a.length; })
      .slice(0, 12);
    if (!evts.length) return;
    document.getElementById('events').innerHTML = evts.map(function (g) {
      g.sort(function (a, b) { return a.date.localeCompare(b.date); });
      var title = g[g.length - 1].zh || g[g.length - 1].t;
      var lis = g.map(function (x) {
        return '<li><b>' + x.date + '</b><a href="' + esc(x.link) + '" target="_blank" rel="noopener">' + esc(x.zh || x.t) + '</a> <i style="opacity:.6">[' + esc(x.src) + ']</i></li>';
      }).join('');
      return '<div class="evt"><h3>' + esc(title) + ' <small style="color:var(--ink-faint);font-size:12px">' + g.length + ' 篇报道</small></h3><ul>' + lis + '</ul></div>';
    }).join('');
  })();

  // ── 主题 ──
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
</script>
</body>
</html>
`;
}
