/**
 * SQLite 持久层（better-sqlite3，WAL 模式）。
 * 表：articles（原始文章）/ summaries（摘要缓存，替代 .cache.json）/ runs（运行日志）/
 *     model_calls（模型调用明细，含 token 用量与延迟）/ judge_scores（质量评分，M5 使用）。
 * 首次打开自动建表迁移；检测到旧 .cache.json 与 output/archive.json 时一次性导入（幂等）。
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CACHE_FILE, DB_FILE, OUTPUT_DIR, SETTINGS } from './config.js';
import { normalizeUrl } from './util.js';
import type { Article } from './types.js';

let db: Database.Database | undefined;

/** 迁移脚本：按序执行，meta.schema_version 记录已应用步数（历史条目只增不改） */
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS articles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    link_raw      TEXT NOT NULL,
    link_norm     TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL DEFAULT '',
    pub_date      TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT 'feed',
    text_excerpt  TEXT NOT NULL DEFAULT '',
    first_seen_at INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    UNIQUE(link_norm)
  )`,
  `CREATE TABLE IF NOT EXISTS summaries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    ver         TEXT NOT NULL,
    category    TEXT,
    title_zh    TEXT,
    body        TEXT,
    points_json TEXT,
    verdict     TEXT,
    ok          INTEGER NOT NULL DEFAULT 1,
    degraded    INTEGER NOT NULL DEFAULT 0,
    served_by   TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE(article_id, ver)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at         INTEGER NOT NULL,
    finished_at        INTEGER,
    ok                 INTEGER NOT NULL DEFAULT 0,
    days               INTEGER NOT NULL DEFAULT 1,
    exit_error         TEXT,
    articles_raw       INTEGER NOT NULL DEFAULT 0,
    articles_kept      INTEGER NOT NULL DEFAULT 0,
    summarized_ok      INTEGER NOT NULL DEFAULT 0,
    summarized_cached  INTEGER NOT NULL DEFAULT 0,
    summarized_failed  INTEGER NOT NULL DEFAULT 0,
    judge_ok           INTEGER NOT NULL DEFAULT 0,
    prompt_tokens      INTEGER NOT NULL DEFAULT 0,
    completion_tokens  INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS model_calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id            INTEGER REFERENCES runs(id),
    purpose           TEXT NOT NULL,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    article_id        INTEGER,
    attempt           INTEGER NOT NULL DEFAULT 1,
    ok                INTEGER NOT NULL,
    http_status       INTEGER,
    error             TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    latency_ms        INTEGER,
    called_at         INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_model_calls_time ON model_calls(called_at)`,
  `CREATE INDEX IF NOT EXISTS idx_model_calls_run ON model_calls(run_id)`,
  `CREATE TABLE IF NOT EXISTS judge_scores (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    summary_id   INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
    article_id   INTEGER NOT NULL REFERENCES articles(id),
    run_id       INTEGER REFERENCES runs(id),
    provider     TEXT,
    model        TEXT,
    factual      INTEGER,
    completeness INTEGER,
    fluency      INTEGER,
    overall      REAL,
    comment      TEXT,
    ver          TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    UNIQUE(summary_id, ver)
  )`,
];

/** 打开（并切换）当前数据库实例：建表迁移 + 旧数据导入；:memory: 供测试 */
export function openDb(file = DB_FILE): Database.Database {
  db?.close();
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = d.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    { value: string } | undefined;
  const applied = row ? Number(row.value) || 0 : 0;
  for (let i = applied; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i];
    if (sql) d.exec(sql);
  }
  d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
    String(MIGRATIONS.length),
  );
  db = d;
  if (file !== ':memory:') importLegacy(d);
  return d;
}

/** 模块级单例：未打开时按 DB_FILE 懒加载 */
export function getDb(): Database.Database {
  return db ?? openDb();
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}

// ===== 旧数据一次性导入（.cache.json + output/archive.json） =====

interface LegacyCacheEntry {
  summary: string;
  category?: string;
  titleZh?: string;
  ts: number;
  ver: string;
}

interface LegacyArchive {
  [date: string]: {
    items: { t: string; zh?: string; cat: string; src: string; link: string }[];
  };
}

/** 导入顺序固定 archive → cache：链接重叠时 cache 的正文后写覆盖 archive 的空行 */
function importLegacy(d: Database.Database): void {
  const flag = d.prepare(`SELECT value FROM meta WHERE key = 'legacy_imported'`).get() as
    { value: string } | undefined;
  if (flag) return;

  const archiveFile = path.join(OUTPUT_DIR, 'archive.json');
  if (existsSync(archiveFile)) {
    try {
      const archive = JSON.parse(readFileSync(archiveFile, 'utf-8')) as LegacyArchive;
      for (const [date, entry] of Object.entries(archive)) {
        for (const it of entry.items ?? []) {
          if (!it.link) continue;
          const artId = upsertArticle(
            {
              title: it.t || '(历史存档)',
              link: it.link,
              pubDate: new Date(`${date}T12:00:00`),
              source: it.src || 'archive',
              text: '',
              kind: 'feed',
            },
            d,
          );
          saveSummary(artId, 'legacy:archive', { body: '', category: it.cat, titleZh: it.zh }, d);
        }
      }
      console.log(`[db] 已导入历史存档 ${archiveFile}`);
    } catch (err) {
      console.warn(`[db] archive.json 导入失败（跳过）: ${errText(err)}`);
    }
  }

  if (existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as Record<
        string,
        LegacyCacheEntry
      >;
      let n = 0;
      for (const [link, e] of Object.entries(cache)) {
        if (!e?.summary || !e.ver) continue;
        const artId = upsertArticle(
          {
            title: '(历史缓存)',
            link,
            pubDate: new Date(e.ts),
            source: 'legacy',
            text: '',
            kind: 'feed',
          },
          d,
        );
        saveSummary(artId, e.ver, { body: e.summary, category: e.category, titleZh: e.titleZh }, d);
        n++;
      }
      console.log(`[db] 已导入旧摘要缓存 ${n} 条（原文件保留备份，不再读写）`);
    } catch (err) {
      console.warn(`[db] .cache.json 导入失败（跳过）: ${errText(err)}`);
    }
  }

  d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_imported', '1')`).run();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ===== 数据访问 API =====

/**
 * 写入/更新一篇文章（按归一化链接幂等），返回 articles.id。
 * 历史 stub（'legacy' 来源）不覆盖已入库的真实标题/来源。
 */
export function upsertArticle(a: Article, d: Database.Database = getDb()): number {
  const now = Date.now();
  const norm = normalizeUrl(a.link);
  d.prepare(
    `INSERT INTO articles (link_raw, link_norm, title, source, pub_date, kind, text_excerpt, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(link_norm) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       title        = CASE WHEN excluded.source IN ('legacy','archive') AND articles.source NOT IN ('legacy','archive')
                          THEN articles.title ELSE excluded.title END,
       source       = CASE WHEN excluded.source IN ('legacy','archive') AND articles.source NOT IN ('legacy','archive')
                          THEN articles.source ELSE excluded.source END,
       pub_date     = excluded.pub_date,
       kind         = excluded.kind`,
  ).run(
    a.link,
    norm,
    a.title,
    a.source,
    a.pubDate.toISOString(),
    a.kind,
    a.text.slice(0, 500),
    now,
    now,
  );
  const row = d.prepare(`SELECT id FROM articles WHERE link_norm = ?`).get(norm) as
    { id: number } | undefined;
  if (!row) throw new Error(`upsertArticle 后仍未找到 ${norm}`);
  return row.id;
}

export interface CachedSummary {
  category?: string;
  titleZh?: string;
  body: string | null;
  points?: string[];
  verdict?: string;
  summaryId: number;
  ts: number;
}

/** 读取摘要缓存：(article_id, ver) 命中且未超 TTL 才返回，否则 null */
export function getCachedSummary(
  articleId: number,
  ver: string,
  d: Database.Database = getDb(),
): CachedSummary | null {
  const row = d
    .prepare(
      `SELECT id, category, title_zh, body, points_json, verdict, created_at FROM summaries WHERE article_id = ? AND ver = ? AND ok = 1`,
    )
    .get(articleId, ver) as
    | {
        id: number;
        category: string | null;
        title_zh: string | null;
        body: string | null;
        points_json: string | null;
        verdict: string | null;
        created_at: number;
      }
    | undefined;
  if (!row) return null;
  const cutoff = Date.now() - SETTINGS.cacheTtlDays * 24 * 3600 * 1000;
  if (row.created_at < cutoff) return null; // 超过保留期视为未命中，重新总结
  let points: string[] | undefined;
  if (row.points_json) {
    try {
      const parsed = JSON.parse(row.points_json) as unknown;
      if (Array.isArray(parsed)) points = parsed.map(String);
    } catch {
      /* 兼容脏数据：忽略 */
    }
  }
  return {
    category: row.category ?? undefined,
    titleZh: row.title_zh ?? undefined,
    body: row.body,
    points,
    verdict: row.verdict ?? undefined,
    summaryId: row.id,
    ts: row.created_at,
  };
}

export interface SummaryData {
  category?: string;
  titleZh?: string;
  body: string;
  points?: string[];
  verdict?: string;
  degraded?: boolean;
  servedBy?: string;
}

/** 保存摘要（同 (article_id, ver) 整行替换），返回 summaries.id */
export function saveSummary(
  articleId: number,
  ver: string,
  data: SummaryData,
  d: Database.Database = getDb(),
): number {
  const info = d
    .prepare(
      `INSERT OR REPLACE INTO summaries (article_id, ver, category, title_zh, body, points_json, verdict, ok, degraded, served_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      articleId,
      ver,
      data.category ?? null,
      data.titleZh ?? null,
      data.body,
      data.points ? JSON.stringify(data.points) : null,
      data.verdict ?? null,
      data.degraded ? 1 : 0,
      data.servedBy ?? null,
      Date.now(),
    );
  return Number(info.lastInsertRowid);
}

/** 记录一次运行开始，返回 runs.id */
export function startRun(days: number, d: Database.Database = getDb()): number {
  const info = d.prepare(`INSERT INTO runs (started_at, days) VALUES (?, ?)`).run(Date.now(), days);
  return Number(info.lastInsertRowid);
}

/** 过滤阶段完成后回填计数（崩溃时也保留进度） */
export function updateRunCounts(
  runId: number,
  articlesRaw: number,
  articlesKept: number,
  d: Database.Database = getDb(),
): void {
  d.prepare(`UPDATE runs SET articles_raw = ?, articles_kept = ? WHERE id = ?`).run(
    articlesRaw,
    articlesKept,
    runId,
  );
}

export interface RunPatch {
  ok: boolean;
  exitError?: string;
  summarizedOk?: number;
  summarizedCached?: number;
  summarizedFailed?: number;
  judgeOk?: number;
}

/** 结束一次运行：token 用量按 run_id 从 model_calls 聚合 */
export function finishRun(runId: number, patch: RunPatch, d: Database.Database = getDb()): void {
  const agg = d
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS p, COALESCE(SUM(completion_tokens), 0) AS c
       FROM model_calls WHERE run_id = ?`,
    )
    .get(runId) as { p: number; c: number };
  d.prepare(
    `UPDATE runs SET finished_at = ?, ok = ?, exit_error = ?,
       summarized_ok = ?, summarized_cached = ?, summarized_failed = ?, judge_ok = ?,
       prompt_tokens = ?, completion_tokens = ? WHERE id = ?`,
  ).run(
    Date.now(),
    patch.ok ? 1 : 0,
    patch.exitError ?? null,
    patch.summarizedOk ?? 0,
    patch.summarizedCached ?? 0,
    patch.summarizedFailed ?? 0,
    patch.judgeOk ?? 0,
    agg.p,
    agg.c,
    runId,
  );
}

export interface ModelCallRow {
  runId: number;
  purpose: 'summary' | 'judge';
  provider: string;
  model: string;
  articleId?: number;
  attempt: number;
  ok: boolean;
  httpStatus?: number;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
}

/** 记录一次模型调用（成功与失败都记，含 token 与延迟） */
export function logModelCall(row: ModelCallRow, d: Database.Database = getDb()): void {
  d.prepare(
    `INSERT INTO model_calls (run_id, purpose, provider, model, article_id, attempt, ok, http_status, error, prompt_tokens, completion_tokens, latency_ms, called_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.runId,
    row.purpose,
    row.provider,
    row.model,
    row.articleId ?? null,
    row.attempt,
    row.ok ? 1 : 0,
    row.httpStatus ?? null,
    row.error ? row.error.slice(0, 500) : null,
    row.promptTokens ?? null,
    row.completionTokens ?? null,
    row.latencyMs,
    Date.now(),
  );
}
