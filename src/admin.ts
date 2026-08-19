/**
 * RSS 源可视化管理后台（仅本机访问）。
 * 启动：npm run admin  →  http://127.0.0.1:5666
 * 功能：增删/启停订阅源（写入 feeds.json）、试抓某个源、一键运行日报、浏览历史报告。
 */
import http from 'node:http';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FEEDS, FEEDS_FILE, OUTPUT_DIR, ROOT, SETTINGS, buildProviders } from './config.js';
import { loadEditableSettings, saveEditableSettings, validateSettings } from './settings.js';
import { queryStats } from './db.js';

const PORT = Number(process.env.ADMIN_PORT || 5666);

interface FeedRow {
  name: string;
  url: string;
  kind: 'feed' | 'hn';
  enabled: boolean;
}

function readFeeds(): FeedRow[] {
  try {
    if (existsSync(FEEDS_FILE)) {
      const raw = JSON.parse(readFileSync(FEEDS_FILE, 'utf-8')) as FeedRow[];
      if (Array.isArray(raw) && raw.length) {
        return raw.map((f) => ({
          name: String(f.name ?? ''),
          url: String(f.url ?? ''),
          kind: f.kind === 'hn' ? 'hn' : 'feed',
          enabled: f.enabled !== false,
        }));
      }
    }
  } catch {
    /* 回退默认 */
  }
  return FEEDS.map((f) => ({ ...f, enabled: true }));
}

function json(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/** 试抓一个源，返回条数或错误 */
async function testFeed(url: string): Promise<{ ok: boolean; count?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': SETTINGS.userAgent,
        accept: 'application/rss+xml, application/xml, */*',
      },
      signal: AbortSignal.timeout(SETTINGS.fetchTimeoutMs),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const xml = await res.text();
    const count = (xml.match(/<(item|entry)[\s>]/gi) ?? []).length;
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  try {
    // 历史报告静态文件
    if (url.pathname.startsWith('/reports/')) {
      const file = path.join(OUTPUT_DIR, path.basename(url.pathname));
      if (!existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      const ext = path.extname(file);
      const ct =
        ext === '.html'
          ? 'text/html; charset=utf-8'
          : ext === '.json'
            ? 'application/json'
            : 'text/plain; charset=utf-8';
      res.writeHead(200, { 'content-type': ct });
      res.end(readFileSync(file));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(adminPage());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/feeds') {
      json(res, 200, readFeeds());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/feeds') {
      const body = JSON.parse(await readBody(req)) as FeedRow[];
      const valid = (Array.isArray(body) ? body : [])
        .filter((f) => f && f.name && f.url)
        .map((f) => ({
          name: String(f.name).slice(0, 50),
          url: String(f.url).slice(0, 500),
          kind: f.kind === 'hn' ? 'hn' : 'feed',
          enabled: f.enabled !== false,
        }));
      if (!valid.length) {
        json(res, 400, { ok: false, error: '至少保留一个有效订阅源' });
        return;
      }
      writeFileSync(FEEDS_FILE, JSON.stringify(valid, null, 2), 'utf-8');
      json(res, 200, { ok: true, count: valid.length });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      // 生效设置 + 只读的环境层信息（Key 永不回传，只回是否已配置）
      json(res, 200, {
        settings: loadEditableSettings(),
        envOnly: {
          providers: buildProviders().map((p) => ({
            name: p.name,
            model: p.model,
            baseURL: p.baseURL,
            hasKey: true,
          })),
          adminPort: PORT,
        },
      });
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      const body: unknown = JSON.parse(await readBody(req));
      const result = validateSettings(body);
      if (!result.ok) {
        json(res, 400, { ok: false, errors: result.errors });
        return;
      }
      saveEditableSettings(result.value);
      console.log('[admin] 已保存摘要设置 → data/settings.json');
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 14, 1), 90);
      json(res, 200, queryStats(days));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/test') {
      json(res, 200, await testFeed(url.searchParams.get('url') ?? ''));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      // 输出写入独立日志文件（logs/run-<ts>.log），失败可回看
      mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
      const logFile = path.join(ROOT, 'logs', `run-${Date.now()}.log`);
      const fd = openSync(logFile, 'a');
      const child = spawn('npx', ['tsx', 'src/main.ts'], {
        cwd: ROOT,
        shell: true,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      child.on('spawn', () => closeSync(fd)); // 子进程已继承句柄，父进程关闭自己的副本
      child.on('error', () => closeSync(fd));
      child.unref();
      json(res, 200, { ok: true, pid: child.pid, log: path.relative(ROOT, logFile) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/run/last') {
      // 最近一次运行的日志尾部（2KB），便于排查「立即运行」失败
      const logsDir = path.join(ROOT, 'logs');
      const logs = existsSync(logsDir)
        ? readdirSync(logsDir)
            .filter((f) => /^run-\d+\.log$/.test(f))
            .sort()
        : [];
      const last = logs.at(-1);
      if (!last) {
        json(res, 200, { ok: true, log: null, tail: '' });
        return;
      }
      const buf = readFileSync(path.join(logsDir, last));
      const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString('utf-8');
      json(res, 200, { ok: true, log: `logs/${last}`, tail });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/reports') {
      const list = existsSync(OUTPUT_DIR)
        ? readdirSync(OUTPUT_DIR)
            .filter((f) => /^\d{4}-\d{2}-\d{2}\.(html|md|txt|pdf)$/.test(f) || f === 'index.html')
            .sort()
            .reverse()
        : [];
      json(res, 200, list);
      return;
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[admin] 管理后台已启动: http://127.0.0.1:${PORT}  （Ctrl+C 退出）`);
});

function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI-NEW 管理后台</title>
<style>
  :root { --paper:#faf8f3; --card:#fff; --ink:#1c1a17; --soft:#5c564d; --faint:#8f887c; --rule:#e6e1d6; --accent:#b42318; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif; background:var(--paper); color:var(--ink); line-height:1.7; font-size:14px; }
  .wrap { max-width:860px; margin:0 auto; padding:32px 24px 80px; }
  h1 { font-family:Georgia,serif; border-top:4px solid var(--accent); padding-top:18px; margin-bottom:6px; }
  .sub { color:var(--faint); font-size:12.5px; margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--rule); border-radius:10px; padding:18px 20px; margin-bottom:18px; }
  .card h2 { font-size:15px; margin-bottom:12px; letter-spacing:.05em; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:11.5px; color:var(--faint); letter-spacing:.08em; padding:4px 8px; border-bottom:1px solid var(--rule); }
  td { padding:6px 8px; border-bottom:1px solid var(--rule); vertical-align:middle; }
  input[type=text], select { width:100%; padding:5px 8px; border:1px solid var(--rule); border-radius:6px; font-size:13px; font-family:inherit; background:var(--paper); color:var(--ink); }
  input[type=text]:focus { outline:none; border-color:var(--accent); }
  td.name { width:150px; } td.kind { width:90px; } td.ops { width:200px; white-space:nowrap; }
  button { cursor:pointer; border:1px solid var(--rule); background:var(--paper); color:var(--soft); border-radius:999px; padding:3px 12px; font-size:12px; }
  button:hover { border-color:var(--faint); color:var(--ink); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; padding:6px 18px; }
  button:disabled { opacity:.5; cursor:default; }
  .row-actions { display:flex; gap:10px; align-items:center; margin-top:14px; flex-wrap:wrap; }
  #msg { font-size:12.5px; margin-left:auto; color:var(--soft); }
  pre#runlog { display:none; margin-top:12px; padding:10px 12px; background:var(--paper); border:1px solid var(--rule); border-radius:8px; font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-all; max-height:260px; overflow:auto; color:var(--soft); }
  .reports a { color:var(--accent); text-decoration:none; margin-right:14px; font-size:13px; }
  .reports a:hover { text-decoration:underline; }
  .ok { color:#0a7d38; } .err { color:var(--accent); }
  .tabbar { display:flex; gap:8px; margin-bottom:18px; }
  .tabbtn { padding:6px 18px; font-size:13.5px; border-radius:999px; border:1px solid var(--rule); background:var(--card); color:var(--soft); cursor:pointer; }
  .tabbtn.active { background:var(--ink); border-color:var(--ink); color:var(--paper); }
  table.form th { width:150px; vertical-align:middle; }
  table.form td { padding:6px 8px; }
  input[type=number] { width:110px; padding:5px 8px; border:1px solid var(--rule); border-radius:6px; font-size:13px; font-family:inherit; background:var(--paper); color:var(--ink); }
  .hint { color:var(--faint); font-size:12px; font-weight:400; }
</style>
</head>
<body>
<div class="wrap">
  <h1>AI-NEW · 管理后台</h1>
  <div class="sub">订阅源维护 / 摘要设置 / 一键运行 / 历史报告（仅本机访问）</div>

  <div class="tabbar">
    <button class="tabbtn active" data-tab="feeds" onclick="showTab('feeds')">订阅源</button>
    <button class="tabbtn" data-tab="settings" onclick="showTab('settings')">摘要设置</button>
    <button class="tabbtn" data-tab="stats" onclick="showTab('stats')">统计</button>
  </div>

  <div id="tab-feeds">
  <div class="card">
    <h2>RSS 订阅源</h2>
    <table id="t">
      <thead><tr><th></th><th>名称</th><th>地址</th><th>类型</th><th>操作</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
    <div class="row-actions">
      <button onclick="addRow()">＋ 添加源</button>
      <button class="primary" onclick="save()">保存配置</button>
      <button onclick="runNow()">▶ 立即运行日报</button>
      <button onclick="showLastLog()">上次运行日志</button>
      <span id="msg"></span>
    </div>
    <pre id="runlog"></pre>
  </div>

  <div class="card">
    <h2>历史报告</h2>
    <div class="reports" id="reports">加载中…</div>
  </div>
  </div>

  <div id="tab-settings" style="display:none">
  <div class="card">
    <h2>摘要与模型参数</h2>
    <table class="form">
      <tr><th>模板</th><td><select id="s-template"><option value="tech">技术简报</option><option value="security">风险安全专刊</option></select></td></tr>
      <tr><th>风格</th><td><select id="s-style"><option value="brief">精简（2~3 条要点）</option><option value="detailed">详细（4~6 条要点）</option></select></td></tr>
      <tr><th>一句话点评</th><td><input type="checkbox" id="s-verdict"> <span class="hint">每篇摘要末尾附编辑点评</span></td></tr>
      <tr><th>自定义人设</th><td><input type="text" id="s-persona" placeholder="留空使用模板默认人设"></td></tr>
      <tr><th>关注关键词</th><td><input type="text" id="s-pin" placeholder="逗号分隔；命中的文章置顶并加 ★"></td></tr>
      <tr><th>黑名单关键词</th><td><input type="text" id="s-block" placeholder="逗号分隔；命中的文章不进日报"></td></tr>
      <tr><th>temperature</th><td><input type="number" id="s-temp" step="0.1" min="0" max="2"> <span class="hint">采样温度 0~2，默认 0.3</span></td></tr>
      <tr><th>max_tokens（精简）</th><td><input type="number" id="s-mtb" min="100" max="8000"></td></tr>
      <tr><th>max_tokens（详细）</th><td><input type="number" id="s-mtd" min="100" max="8000"></td></tr>
      <tr><th>质量评审</th><td><input type="checkbox" id="s-judge"> <span class="hint">LLM-as-Judge：总结后自动为每篇摘要打质量分</span></td></tr>
    </table>
    <div class="row-actions">
      <button class="primary" onclick="saveSettings()">保存设置</button>
      <span id="smsg"></span>
    </div>
    <div style="color:var(--soft);font-size:12.5px;margin-top:10px">
      · 保存写入 <code>data/settings.json</code>，下次运行日报生效；改模板/风格会使相关文章摘要缓存失效并重新总结。<br>
      · 保存后同项环境变量（SUMMARY_* / PIN_KEYWORDS / BLOCK_KEYWORDS）不再生效。<br>
      · API Key、模型、BaseURL、代理仍需在 <code>.env</code> 配置，此处不可编辑。
    </div>
  </div>
  </div>

  <div id="tab-stats" style="display:none">
  <div class="card">
    <h2>每日概览（近 14 天）</h2>
    <table>
      <thead><tr><th>日期</th><th>运行</th><th>文章</th><th>总结成功</th><th>失败</th><th>质量</th><th>tokens 入/出</th></tr></thead>
      <tbody id="stats-days"><tr><td colspan="7">加载中…</td></tr></tbody>
    </table>
  </div>
  <div class="card">
    <h2>模型用量（近 14 天）</h2>
    <table>
      <thead><tr><th>供应商</th><th>模型</th><th>调用</th><th>成功</th><th>tokens 入/出</th><th>均延迟</th></tr></thead>
      <tbody id="stats-providers"><tr><td colspan="6">加载中…</td></tr></tbody>
    </table>
  </div>
  <div class="card">
    <h2>最近运行</h2>
    <div id="stats-runs" style="font-size:12.5px;color:var(--soft)">加载中…</div>
  </div>
  </div>

  <div class="card">
    <h2>说明</h2>
    <div style="color:var(--soft);font-size:13px">
      · 保存写入 <code>feeds.json</code>，取消勾选即停用（不删除）；「试抓」验证源是否可用。<br>
      · 立即运行会在后台执行完整流程（抓取→总结→HTML/MD/TXT/PDF→存档），完成后刷新报告列表。<br>
      · 每日 08:30 由 Windows 计划任务自动运行，无需保持本页面开启。
    </div>
  </div>
</div>
<script>
  var tbody = document.getElementById('tbody');
  var msg = document.getElementById('msg');
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function rowHtml(f) {
    return '<tr>' +
      '<td style="width:28px"><input type="checkbox" ' + (f.enabled ? 'checked' : '') + ' onchange="msg.textContent=\\'\\'"></td>' +
      '<td class="name"><input type="text" value="' + esc(f.name) + '" data-k="name"></td>' +
      '<td><input type="text" value="' + esc(f.url) + '" data-k="url"></td>' +
      '<td class="kind"><select data-k="kind"><option value="feed"' + (f.kind !== 'hn' ? ' selected' : '') + '>普通</option><option value="hn"' + (f.kind === 'hn' ? ' selected' : '') + '>HN(抓正文)</option></select></td>' +
      '<td class="ops"><button onclick="testRow(this)">试抓</button> <button onclick="this.closest(\\'tr\\').remove()">删除</button></td>' +
      '</tr>';
  }
  function addRow(f) {
    tbody.insertAdjacentHTML('beforeend', rowHtml(f || { name: '', url: '', kind: 'feed', enabled: true }));
  }
  function collect() {
    return Array.from(tbody.querySelectorAll('tr')).map(function (tr) {
      return {
        name: tr.querySelector('[data-k=name]').value.trim(),
        url: tr.querySelector('[data-k=url]').value.trim(),
        kind: tr.querySelector('[data-k=kind]').value,
        enabled: tr.querySelector('input[type=checkbox]').checked,
      };
    });
  }
  function say(t, ok) { msg.innerHTML = '<span class="' + (ok ? 'ok' : 'err') + '">' + t + '</span>'; }
  function save() {
    fetch('/api/feeds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(collect()) })
      .then(function (r) { return r.json(); })
      .then(function (d) { say(d.ok ? '已保存 ' + d.count + ' 个源 ✓' : '保存失败: ' + d.error, d.ok); });
  }
  function testRow(btn) {
    var tr = btn.closest('tr');
    var url = tr.querySelector('[data-k=url]').value.trim();
    btn.disabled = true; btn.textContent = '抓取中…';
    fetch('/api/test?url=' + encodeURIComponent(url))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btn.disabled = false; btn.textContent = '试抓';
        say(url + ' → ' + (d.ok ? '可用，' + d.count + ' 条' : '失败: ' + d.error), d.ok);
      });
  }
  function runNow() {
    say('已启动，后台运行中…', true);
    fetch('/api/run', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.log) say('已启动（日志 ' + d.log + '），后台运行中…', true);
        setTimeout(loadReports, 90000);
      });
  }
  function showLastLog() {
    fetch('/api/run/last')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var el = document.getElementById('runlog');
        el.style.display = 'block';
        el.textContent = d.log ? '[' + d.log + ']\n' + d.tail : '（暂无运行日志）';
      });
  }
  function loadReports() {
    fetch('/api/reports').then(function (r) { return r.json(); }).then(function (list) {
      document.getElementById('reports').innerHTML = list.length
        ? list.map(function (f) { return '<a href="/reports/' + f + '" target="_blank">' + f + '</a>'; }).join('')
        : '（暂无，先运行一次）';
    });
  }
  // ── 摘要设置 ──
  function showTab(name) {
    document.querySelectorAll('.tabbtn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.getElementById('tab-feeds').style.display = name === 'feeds' ? '' : 'none';
    document.getElementById('tab-settings').style.display = name === 'settings' ? '' : 'none';
    document.getElementById('tab-stats').style.display = name === 'stats' ? '' : 'none';
    if (name === 'stats') loadStats();
  }
  function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
  function loadStats() {
    fetch('/api/stats?days=14').then(function (r) { return r.json(); }).then(function (s) {
      document.getElementById('stats-days').innerHTML = s.days.length
        ? s.days.map(function (d) {
            return '<tr><td>' + esc(d.date) + '</td><td>' + d.runs + '</td><td>' + d.articles +
              '</td><td>' + d.ok + '</td><td>' + d.failed + '</td><td>' +
              (d.avgQuality == null ? '—' : '★' + Number(d.avgQuality).toFixed(1)) +
              '</td><td>' + fmtK(d.promptTokens) + ' / ' + fmtK(d.completionTokens) + '</td></tr>';
          }).join('')
        : '<tr><td colspan="7">（暂无数据）</td></tr>';
      document.getElementById('stats-providers').innerHTML = s.providers.length
        ? s.providers.map(function (p) {
            return '<tr><td>' + esc(p.provider) + '</td><td>' + esc(p.model) + '</td><td>' + p.calls +
              '</td><td>' + p.ok + '</td><td>' + fmtK(p.promptTokens) + ' / ' + fmtK(p.completionTokens) +
              '</td><td>' + p.avgLatencyMs + 'ms</td></tr>';
          }).join('')
        : '<tr><td colspan="6">（暂无调用记录）</td></tr>';
      document.getElementById('stats-runs').innerHTML = s.recentRuns.map(function (r) {
        return '<div style="padding:5px 0;border-bottom:1px solid var(--rule)">' +
          '#' + r.id + ' · ' + new Date(r.startedAt).toLocaleString() + ' · ' +
          (r.ok ? '<span class="ok">成功</span>' : '<span class="err">失败' + (r.exitError ? '：' + esc(String(r.exitError).slice(0, 80)) : '') + '</span>') +
          ' · 文章 ' + r.articlesKept + ' · 总结 ' + r.summarizedOk + ' · 评审 ' + r.judgeOk +
          ' · ' + fmtK(r.promptTokens) + '/' + fmtK(r.completionTokens) + ' tokens</div>';
      }).join('') || '（暂无运行记录）';
    });
  }
  var $ = function (id) { return document.getElementById(id); };
  function loadSettings() {
    fetch('/api/settings').then(function (r) { return r.json(); }).then(function (d) {
      var s = d.settings.summary;
      $('s-template').value = s.templateId;
      $('s-style').value = s.style;
      $('s-verdict').checked = s.verdict;
      $('s-persona').value = s.personaOverride || '';
      $('s-pin').value = s.pinKeywords.join(',');
      $('s-block').value = s.blockKeywords.join(',');
      $('s-temp').value = s.temperature;
      $('s-mtb').value = s.maxTokensBrief;
      $('s-mtd').value = s.maxTokensDetailed;
      $('s-judge').checked = d.settings.judge.enabled;
    });
  }
  function saveSettings() {
    var splitKw = function (v) {
      return v.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean);
    };
    var body = {
      summary: {
        templateId: $('s-template').value,
        style: $('s-style').value,
        verdict: $('s-verdict').checked,
        personaOverride: $('s-persona').value,
        pinKeywords: splitKw($('s-pin').value),
        blockKeywords: splitKw($('s-block').value),
        temperature: Number($('s-temp').value),
        maxTokensBrief: Number($('s-mtb').value),
        maxTokensDetailed: Number($('s-mtd').value),
      },
      judge: { enabled: $('s-judge').checked },
    };
    fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        $('smsg').innerHTML = d.ok
          ? '<span class="ok">已保存 ✓</span>'
          : '<span class="err">' + d.errors.join('；') + '</span>';
      });
  }

  fetch('/api/feeds').then(function (r) { return r.json(); }).then(function (feeds) {
    tbody.innerHTML = '';
    feeds.forEach(addRow);
  });
  loadReports();
  loadSettings();
</script>
</body>
</html>
`;
}
