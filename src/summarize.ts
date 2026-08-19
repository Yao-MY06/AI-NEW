import OpenAI from 'openai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AI, CACHE_FILE, SETTINGS } from './config.js';
import { pool } from './util.js';
import { fetchArticleText } from './fetchPage.js';
import type { Article, SummaryResult } from './types.js';

interface CacheEntry {
  summary: string;
  ts: number;
}
type Cache = Record<string, CacheEntry>;

function loadCache(): Cache {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as Cache;
  } catch {
    return {};
  }
}

/** 保存缓存并顺带清理过期条目 */
function saveCache(cache: Cache): void {
  const cutoff = Date.now() - SETTINGS.cacheTtlDays * 24 * 3600 * 1000;
  const pruned: Cache = {};
  for (const [k, v] of Object.entries(cache)) {
    if (v.ts >= cutoff) pruned[k] = v;
  }
  writeFileSync(CACHE_FILE, JSON.stringify(pruned, null, 2), 'utf-8');
}

const SYSTEM_PROMPT = `你是资深科技新闻编辑。根据用户提供的英文 AI 新闻内容，用简体中文输出：
1. 2~4 条核心要点，每条以 "- " 开头，简洁准确，保留关键信息（产品名、公司、数字）；
2. 空一行后，以 "**点评**: " 开头给出一句话点评。
直接输出内容，不要任何前言、标题或解释。`;

async function summarizeOne(client: OpenAI, article: Article, cache: Cache): Promise<SummaryResult> {
  const cached = cache[article.link];
  if (cached) return { summary: cached.summary, fromCache: true, usedFallbackText: false };

  // HN 条目优先抓目标网页正文；自述帖（指向 HN 页面本身）与抓取失败均降级用 RSS 简介
  let text = article.text;
  let usedFallbackText = false;
  if (article.kind === 'hn' && !/news\.ycombinator\.com\//i.test(article.link)) {
    const pageText = await fetchArticleText(article.link);
    if (pageText) text = pageText;
    else usedFallbackText = true;
  }

  try {
    const res = await client.chat.completions.create({
      model: AI.model,
      temperature: 0.3,
      max_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `标题: ${article.title}\n来源: ${article.source}\n\n内容:\n${text || '（无正文，请根据标题合理概括）'}`,
        },
      ],
    });
    const summary = res.choices[0]?.message?.content?.trim();
    if (!summary) throw new Error('模型返回空内容');
    cache[article.link] = { summary, ts: Date.now() };
    return { summary, fromCache: false, usedFallbackText };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { summary: null, fromCache: false, usedFallbackText, error: msg };
  }
}

export interface SummarizeStats {
  total: number;
  ok: number;
  cached: number;
  failed: number;
}

export async function summarizeAll(
  articles: Article[],
): Promise<{ results: SummaryResult[]; stats: SummarizeStats }> {
  if (!AI.apiKey) {
    console.warn('[ai] 未配置 OPENAI_API_KEY，跳过 AI 总结（文章仍会以标题列表形式输出）');
    return {
      results: articles.map(() => ({
        summary: null,
        fromCache: false,
        usedFallbackText: false,
        error: '未配置 API Key',
      })),
      stats: { total: articles.length, ok: 0, cached: 0, failed: articles.length },
    };
  }

  const client = new OpenAI({
    apiKey: AI.apiKey,
    baseURL: AI.baseURL,
    timeout: SETTINGS.apiTimeoutMs,
    maxRetries: 2, // SDK 内置重试：429 / 5xx / 网络错误
  });

  const cache = loadCache();
  let done = 0;
  const results = await pool(articles, SETTINGS.summaryConcurrency, async (a) => {
    const r = await summarizeOne(client, a, cache);
    done++;
    const flag = r.summary ? (r.fromCache ? '缓存' : '完成') : `失败(${r.error})`;
    console.log(`[ai] ${done}/${articles.length} ${flag} - ${a.title.slice(0, 50)}`);
    saveCache(cache); // 写穿保存，中途崩溃不丢已完成的总结
    return r;
  });
  saveCache(cache);

  const stats: SummarizeStats = {
    total: articles.length,
    ok: results.filter((r) => r.summary).length,
    cached: results.filter((r) => r.fromCache).length,
    failed: results.filter((r) => !r.summary).length,
  };
  return { results, stats };
}
