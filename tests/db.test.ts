/** SQLite 数据层：内存库上验证幂等 upsert / 缓存读写与 TTL / token 聚合 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  finishRun,
  getCachedSummary,
  logModelCall,
  openDb,
  saveSummary,
  startRun,
  updateRunCounts,
  upsertArticle,
} from '../src/db.js';
import type { Article } from '../src/types.js';

afterEach(() => closeDb());

const A = (link: string, title = 'Some AI news'): Article => ({
  title,
  link,
  pubDate: new Date('2026-08-19T10:00:00Z'),
  source: 'TechCrunch AI',
  text: 'body text',
  kind: 'feed',
});

describe('articles upsert', () => {
  it('同归一化链接幂等，返回同一 id', () => {
    const d = openDb(':memory:');
    const id1 = upsertArticle(A('https://a.com/p?utm_source=x'), d);
    const id2 = upsertArticle(A('https://a.com/p', 'Updated title'), d);
    expect(id2).toBe(id1);
    const n = d.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('不同链接各自入库', () => {
    const d = openDb(':memory:');
    const id1 = upsertArticle(A('https://a.com/1'), d);
    const id2 = upsertArticle(A('https://a.com/2'), d);
    expect(id2).not.toBe(id1);
  });
});

describe('summaries 缓存', () => {
  it('saveSummary 后 getCachedSummary 命中，字段回读一致', () => {
    const d = openDb(':memory:');
    const artId = upsertArticle(A('https://a.com/1'), d);
    const sid = saveSummary(
      artId,
      'tech:brief:v:v2',
      { body: '- 要点', category: '大模型', titleZh: '标题', points: ['- 要点'] },
      d,
    );
    const cached = getCachedSummary(artId, 'tech:brief:v:v2', d);
    expect(cached).not.toBeNull();
    expect(cached?.summaryId).toBe(sid);
    expect(cached?.body).toBe('- 要点');
    expect(cached?.category).toBe('大模型');
    expect(cached?.points).toEqual(['- 要点']);
  });

  it('ver 不匹配（配置变化）视为未命中', () => {
    const d = openDb(':memory:');
    const artId = upsertArticle(A('https://a.com/1'), d);
    saveSummary(artId, 'tech:brief:v:v2', { body: '- 要点' }, d);
    expect(getCachedSummary(artId, 'tech:brief:nv:v3', d)).toBeNull();
  });

  it('超过 TTL 的缓存视为未命中', () => {
    const d = openDb(':memory:');
    const artId = upsertArticle(A('https://a.com/1'), d);
    saveSummary(artId, 'tech:brief:v:v2', { body: '- 要点' }, d);
    const old = Date.now() - 15 * 24 * 3600 * 1000; // cacheTtlDays 默认 14
    d.prepare('UPDATE summaries SET created_at = ?').run(old);
    expect(getCachedSummary(artId, 'tech:brief:v:v2', d)).toBeNull();
  });
});

describe('runs 与 model_calls', () => {
  it('finishRun 按 run_id 聚合 token 用量', () => {
    const d = openDb(':memory:');
    const runId = startRun(1, d);
    updateRunCounts(runId, 50, 43, d);
    logModelCall(
      {
        runId,
        purpose: 'summary',
        provider: '主模型',
        model: 'glm-4-flash',
        attempt: 1,
        ok: true,
        promptTokens: 1000,
        completionTokens: 200,
        latencyMs: 800,
      },
      d,
    );
    logModelCall(
      {
        runId,
        purpose: 'judge',
        provider: '主模型',
        model: 'glm-4-flash',
        attempt: 1,
        ok: true,
        promptTokens: 300,
        completionTokens: 50,
        latencyMs: 400,
      },
      d,
    );
    finishRun(runId, { ok: true, summarizedOk: 43 }, d);
    const run = d.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as {
      articles_raw: number;
      articles_kept: number;
      summarized_ok: number;
      prompt_tokens: number;
      completion_tokens: number;
      ok: number;
    };
    expect(run.articles_raw).toBe(50);
    expect(run.articles_kept).toBe(43);
    expect(run.summarized_ok).toBe(43);
    expect(run.prompt_tokens).toBe(1300);
    expect(run.completion_tokens).toBe(250);
    expect(run.ok).toBe(1);
  });
});
