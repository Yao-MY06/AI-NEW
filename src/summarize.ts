import OpenAI from 'openai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CACHE_FILE, SETTINGS, SUMMARY, buildProviders } from './config.js';
import { pool } from './util.js';
import { fetchArticleText } from './fetchPage.js';
import type { Article, SummaryResult } from './types.js';

interface CacheEntry {
  summary: string;
  ts: number;
  /** 摘要配置版本（模板/风格/点评），不一致则重新总结 */
  ver: string;
}
type Cache = Record<string, CacheEntry>;

const CACHE_VER = `${SUMMARY.templateId}:${SUMMARY.style}:${SUMMARY.verdict ? 'v' : 'nv'}`;

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

function buildSystemPrompt(): string {
  const lines = [
    `${SUMMARY.persona}。根据用户提供的英文 AI 新闻内容，用简体中文输出：`,
    SUMMARY.style === 'detailed'
      ? '1. 4~6 条核心要点，每条以 "- " 开头，包含关键细节、数字与影响面，保留产品名、公司等信息；'
      : '1. 2~3 条核心要点，每条以 "- " 开头，一句话概括，保留产品名、公司、数字等关键信息；',
  ];
  if (SUMMARY.verdict) lines.push('2. 空一行后，以 "**点评**: " 开头给出一句话点评。');
  lines.push('直接输出内容，不要任何前言、标题或解释。');
  return lines.join('\n');
}

/** 一个模型候选（含本轮运行的健康状态） */
interface Provider {
  name: string;
  model: string;
  client: OpenAI;
  consecutiveFails: number;
  disabled: boolean;
}

function initProviders(): Provider[] {
  return buildProviders().map((p) => ({
    name: p.name,
    model: p.model,
    client: new OpenAI({
      apiKey: p.apiKey,
      baseURL: p.baseURL,
      timeout: SETTINGS.apiTimeoutMs,
      maxRetries: 2, // SDK 内置重试：429 / 5xx / 网络错误
    }),
    consecutiveFails: 0,
    disabled: false,
  }));
}

async function callProvider(p: Provider, system: string, user: string): Promise<string> {
  const res = await p.client.chat.completions.create({
    model: p.model,
    temperature: 0.3,
    max_tokens: SUMMARY.style === 'detailed' ? 900 : 600,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const summary = res.choices[0]?.message?.content?.trim();
  if (!summary) throw new Error('模型返回空内容');
  return summary;
}

async function summarizeOne(
  providers: Provider[],
  article: Article,
  cache: Cache,
  system: string,
  usage: Record<string, number>,
): Promise<SummaryResult> {
  const c = cache[article.link];
  if (c && c.ver === CACHE_VER) {
    return { summary: c.summary, fromCache: true, usedFallbackText: false };
  }

  // HN 条目优先抓目标网页正文；自述帖（指向 HN 页面本身）与抓取失败均降级用 RSS 简介
  let text = article.text;
  let usedFallbackText = false;
  if (article.kind === 'hn' && !/news\.ycombinator\.com\//i.test(article.link)) {
    const pageText = await fetchArticleText(article.link);
    if (pageText) text = pageText;
    else usedFallbackText = true;
  }

  const user = `标题: ${article.title}\n来源: ${article.source}${article.alsoReportedBy?.length ? `（另有 ${article.alsoReportedBy.join('、')} 报道）` : ''}\n\n内容:\n${text || '（无正文，请根据标题合理概括）'}`;

  // 按候选顺序尝试，失败自动切换下一模型
  let lastErr = '';
  for (const p of providers) {
    if (p.disabled) continue;
    try {
      const summary = await callProvider(p, system, user);
      p.consecutiveFails = 0;
      usage[p.name] = (usage[p.name] ?? 0) + 1;
      cache[article.link] = { summary, ts: Date.now(), ver: CACHE_VER };
      return { summary, fromCache: false, usedFallbackText, servedBy: p.name };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      p.consecutiveFails++;
      console.warn(`[ai] ${p.name} 调用失败(${lastErr})，尝试下一候选`);
      if (p.consecutiveFails >= SETTINGS.providerFailsLimit && !p.disabled) {
        p.disabled = true;
        console.warn(`[ai] ${p.name} 连续失败 ${SETTINGS.providerFailsLimit} 次，本轮停用`);
      }
    }
  }
  return { summary: null, fromCache: false, usedFallbackText, error: lastErr || '无可用模型' };
}

export interface SummarizeStats {
  total: number;
  ok: number;
  cached: number;
  failed: number;
  usage: Record<string, number>;
}

export async function summarizeAll(
  articles: Article[],
): Promise<{ results: SummaryResult[]; stats: SummarizeStats }> {
  const providers = initProviders();
  if (!providers.length) {
    console.warn('[ai] 未配置任何模型 API Key（OPENAI_API_KEY / FALLBACK_*），跳过 AI 总结');
    return {
      results: articles.map(() => ({
        summary: null,
        fromCache: false,
        usedFallbackText: false,
        error: '未配置 API Key',
      })),
      stats: { total: articles.length, ok: 0, cached: 0, failed: articles.length, usage: {} },
    };
  }
  console.log(
    `[ai] 模型候选: ${providers.map((p) => `${p.name}(${p.model})`).join(' → ')}`,
  );

  const system = buildSystemPrompt();
  const cache = loadCache();
  const usage: Record<string, number> = {};
  let done = 0;
  const results = await pool(articles, SETTINGS.summaryConcurrency, async (a) => {
    const r = await summarizeOne(providers, a, cache, system, usage);
    done++;
    const flag = r.summary ? (r.fromCache ? '缓存' : r.servedBy ?? '完成') : `失败(${r.error})`;
    console.log(`[ai] ${done}/${articles.length} ${flag} - ${a.title.slice(0, 50)}`);
    saveCache(cache); // 写穿保存，中途崩溃不丢已完成的总结
    return r;
  });
  saveCache(cache);

  const usageStr = Object.entries(usage)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  if (usageStr) console.log(`[ai] 模型用量: ${usageStr}`);

  const stats: SummarizeStats = {
    total: articles.length,
    ok: results.filter((r) => r.summary).length,
    cached: results.filter((r) => r.fromCache).length,
    failed: results.filter((r) => !r.summary).length,
    usage,
  };
  return { results, stats };
}
