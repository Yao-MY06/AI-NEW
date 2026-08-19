import OpenAI from 'openai';
import { CATEGORIES, GLOSSARY, SETTINGS, SUMMARY, buildProviders } from './config.js';
import { getCachedSummary, logModelCall, saveSummary, upsertArticle } from './db.js';
import { pool } from './util.js';
import { fetchArticleText } from './fetchPage.js';
import type { Article, SummaryResult } from './types.js';

/** 摘要缓存版本（模板/风格/点评/格式任一变化即整体失效），随 articles.ver 入库 */
const CACHE_VER = `${SUMMARY.templateId}:${SUMMARY.style}:${SUMMARY.verdict ? 'v' : 'nv'}:v2`;

/** 解析模型输出的头部字段（分类/标题），正文原样返回 */
export interface ParsedSummary {
  category?: string;
  titleZh?: string;
  body: string;
}

function normalizeCategory(s: string): string {
  const hit = (CATEGORIES as readonly string[]).find((c) => s.includes(c));
  return hit ?? '其他';
}

export function parseSummaryBlock(raw: string): ParsedSummary {
  const lines = raw.split('\n');
  let category: string | undefined;
  let titleZh: string | undefined;
  while (lines.length) {
    const head = lines[0]?.trim() ?? '';
    const c = head.match(/^(?:分类|类别)\s*[:：]\s*(.+)$/);
    if (c) {
      const v = c[1]?.trim();
      if (v) category = normalizeCategory(v);
      lines.shift();
      continue;
    }
    const t = head.match(/^标题\s*[:：]\s*(.+)$/);
    if (t) {
      const v = t[1]?.trim();
      if (v) titleZh = v;
      lines.shift();
      continue;
    }
    break;
  }
  return { category, titleZh, body: lines.join('\n').trim() };
}

function buildSystemPrompt(): string {
  const glossary = GLOSSARY.map(([en, zh]) => `${en}→${zh}`).join('；');
  const lines = [
    `${SUMMARY.persona}。根据用户提供的英文 AI 新闻内容，用简体中文严格按以下格式输出：`,
    `分类: <从【${CATEGORIES.join('、')}】中选一个最贴切的>`,
    `标题: <该新闻的中文标题，简洁准确，保留产品/公司英文名>`,
    SUMMARY.style === 'detailed'
      ? '然后输出 4~6 条核心要点，每条以 "- " 开头，包含关键细节、数字与影响面，保留产品名、公司等信息；'
      : '然后输出 2~3 条核心要点，每条以 "- " 开头，一句话概括，保留产品名、公司、数字；',
  ];
  if (SUMMARY.verdict) lines.push('最后空一行，以 "**点评**: " 开头给出一句话点评。');
  lines.push(
    `术语统一：${glossary}。产品/公司名保留英文（OpenAI、GPT、Claude 等）。直接输出，不要任何前言或解释。`,
  );
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

interface ProviderReply {
  text: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

async function callProvider(p: Provider, system: string, user: string): Promise<ProviderReply> {
  const t0 = Date.now();
  const res = await p.client.chat.completions.create({
    model: p.model,
    temperature: 0.3,
    max_tokens: SUMMARY.style === 'detailed' ? 900 : 600,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const text = res.choices[0]?.message?.content?.trim();
  if (!text) throw new Error('模型返回空内容');
  return {
    text,
    promptTokens: res.usage?.prompt_tokens ?? 0,
    completionTokens: res.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
  };
}

/** 每个供应商的用量累计：调用数 + token 明细（落库 model_calls，此处用于控制台汇总） */
export interface UsageCount {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}
export type UsageMap = Record<string, UsageCount>;

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

async function summarizeOne(
  providers: Provider[],
  article: Article,
  system: string,
  usage: UsageMap,
  runId: number,
): Promise<SummaryResult> {
  const artId = upsertArticle(article);
  const cached = getCachedSummary(artId, CACHE_VER);
  if (cached?.body) {
    return {
      summary: cached.body,
      category: cached.category,
      titleZh: cached.titleZh,
      fromCache: true,
      usedFallbackText: false,
      dbSummaryId: cached.summaryId,
    };
  }

  // HN 条目优先抓目标网页正文；自述帖（指向 HN 页面本身）与抓取失败均降级用 RSS 简介
  let text = article.text;
  let usedFallbackText = false;
  if (article.kind === 'hn' && !/news\.ycombinator\.com\//i.test(article.link)) {
    const pageText = await fetchArticleText(article.link);
    if (pageText) {
      text = pageText;
      article.previewText = pageText.slice(0, 1500); // 供前端预览弹窗使用
    } else {
      usedFallbackText = true;
    }
  }

  const user = `标题: ${article.title}\n来源: ${article.source}${article.alsoReportedBy?.length ? `（另有 ${article.alsoReportedBy.join('、')} 报道）` : ''}\n\n内容:\n${text || '（无正文，请根据标题合理概括）'}`;

  // 按候选顺序尝试，失败自动切换下一模型；每次尝试（成败均）记入 model_calls
  let lastErr = '';
  let attempt = 0;
  for (const p of providers) {
    if (p.disabled) continue;
    const t0 = Date.now();
    const attemptNo = ++attempt;
    try {
      const reply = await callProvider(p, system, user);
      const parsed = parseSummaryBlock(reply.text);
      logModelCall({
        runId,
        purpose: 'summary',
        provider: p.name,
        model: p.model,
        articleId: artId,
        attempt: attemptNo,
        ok: true,
        promptTokens: reply.promptTokens,
        completionTokens: reply.completionTokens,
        latencyMs: reply.latencyMs,
      });
      p.consecutiveFails = 0;
      const u = (usage[p.name] ??= { calls: 0, promptTokens: 0, completionTokens: 0 });
      u.calls++;
      u.promptTokens += reply.promptTokens;
      u.completionTokens += reply.completionTokens;
      const dbSummaryId = saveSummary(artId, CACHE_VER, {
        body: parsed.body,
        category: parsed.category,
        titleZh: parsed.titleZh,
        servedBy: p.name,
      });
      return {
        summary: parsed.body,
        category: parsed.category,
        titleZh: parsed.titleZh,
        fromCache: false,
        usedFallbackText,
        servedBy: p.name,
        dbSummaryId,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      logModelCall({
        runId,
        purpose: 'summary',
        provider: p.name,
        model: p.model,
        articleId: artId,
        attempt: attemptNo,
        ok: false,
        error: lastErr,
        latencyMs: Date.now() - t0,
      });
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
  usage: UsageMap;
}

export async function summarizeAll(
  articles: Article[],
  runId: number,
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
  console.log(`[ai] 模型候选: ${providers.map((p) => `${p.name}(${p.model})`).join(' → ')}`);

  const system = buildSystemPrompt();
  const usage: UsageMap = {};
  let done = 0;
  const results = await pool(articles, SETTINGS.summaryConcurrency, async (a) => {
    const r = await summarizeOne(providers, a, system, usage, runId);
    done++;
    const flag = r.summary ? (r.fromCache ? '缓存' : (r.servedBy ?? '完成')) : `失败(${r.error})`;
    console.log(`[ai] ${done}/${articles.length} ${flag} - ${a.title.slice(0, 50)}`);
    return r; // 摘要已随篇入库（SQLite 事务），中途崩溃不丢已完成的总结
  });

  const usageStr = Object.entries(usage)
    .map(
      ([k, v]) =>
        `${k}=${v.calls}次(输入${fmtK(v.promptTokens)}/输出${fmtK(v.completionTokens)} tokens)`,
    )
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
