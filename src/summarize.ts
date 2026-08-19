import { createHash } from 'node:crypto';
import { CATEGORIES, GLOSSARY, SETTINGS, SUMMARY } from './config.js';
import { getCachedSummary, saveSummary, upsertArticle } from './db.js';
import { callChat, initProviders } from './llm.js';
import type { RuntimeProvider, UsageMap } from './llm.js';
import { SUMMARY_SCHEMA_ID, parseSummaryJson } from './schema.js';
import type { SummaryJson } from './schema.js';
import { pool } from './util.js';
import { fetchArticleText } from './fetchPage.js';
import type { Article, SummaryResult } from './types.js';

/** 缓存版本 v3：结构化 JSON schema + 人设/采样参数哈希，任一变化整体失效 */
const CACHE_VER = `v3:${SUMMARY.templateId}:${SUMMARY.style}:${SUMMARY.verdict ? 'v' : 'nv'}:${createHash(
  'sha1',
)
  .update(
    JSON.stringify({
      persona: SUMMARY.personaOverride ?? SUMMARY.persona,
      temperature: SUMMARY.temperature,
      maxTokensBrief: SUMMARY.maxTokensBrief,
      maxTokensDetailed: SUMMARY.maxTokensDetailed,
      schema: SUMMARY_SCHEMA_ID,
    }),
  )
  .digest('hex')
  .slice(0, 8)}`;

/** 解析模型输出的头部字段（分类/标题），正文原样返回 —— 仅作结构化失败的最终兜底 */
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
  const persona = SUMMARY.personaOverride ?? SUMMARY.persona;
  const reqs = [
    `category：从【${CATEGORIES.join('、')}】中选一个最贴切的`,
    `titleZh：中文标题，简洁准确，保留产品/公司英文名`,
    SUMMARY.style === 'detailed'
      ? `points：4~6 条核心要点的字符串数组，每条一句话，包含关键细节、数字与影响面`
      : `points：2~3 条核心要点的字符串数组，每条一句话，保留产品名、公司、数字`,
  ];
  if (SUMMARY.verdict) reqs.push(`verdict：一句话编辑点评`);
  else reqs.push(`不要输出 verdict 字段`);
  return [
    `${persona}。根据用户提供的英文 AI 新闻内容生成中文摘要，只输出一个 JSON 对象（不要 markdown 代码块，不要任何解释文字）。`,
    `输出示例（仅供格式参考，数组元素个数按下方要求，内容必须基于实际新闻重写，不得照抄示例）：`,
    `{"category":"大模型","titleZh":"OpenAI 发布新一代推理模型","points":["性能较上代提升两倍，推理成本下降一半","面向开发者 API 同步开放"],"verdict":"对应用层是明显利好"}`,
    `字段要求：`,
    ...reqs.map((r) => `- ${r}`),
    `术语统一：${glossary}。产品/公司名保留英文（OpenAI、GPT、Claude 等）。所有字符串值用简体中文。`,
  ].join('\n');
}

/** 由结构化字段重建渲染正文（与旧版格式一致，渲染器零改动） */
function rebuildBody(s: SummaryJson): string {
  return s.points.map((p) => `- ${p}`).join('\n') + (s.verdict ? `\n\n**点评**: ${s.verdict}` : '');
}

/** 兜底：旧版头部文本解析的结果（category/titleZh 可缺省，正文原样交给渲染器） */
interface FallbackSummary {
  category?: string;
  titleZh?: string;
  body: string;
}

async function summarizeOne(
  providers: RuntimeProvider[],
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
      points: cached.points,
      verdict: cached.verdict,
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
  const maxTokens =
    SUMMARY.style === 'detailed' ? SUMMARY.maxTokensDetailed : SUMMARY.maxTokensBrief;

  // 第一次：结构化 JSON（json 模式 + 供应商故障转移）；校验失败带错误反馈重试一次
  let structured: SummaryJson | undefined;
  let fb: FallbackSummary | undefined;
  let servedBy = '';
  let degraded = false;
  let lastErr = '';
  try {
    const r1 = await callChat({
      providers,
      runId,
      purpose: 'summary',
      articleId: artId,
      system,
      user,
      temperature: SUMMARY.temperature,
      maxTokens,
      jsonMode: true,
      usage,
    });
    servedBy = r1.provider.name;
    const res1 = parseSummaryJson(r1.text);
    if (res1.ok) {
      structured = res1.data;
    } else {
      console.warn(
        `[ai] 结构化校验失败(${res1.error})，带反馈重试 - ${article.title.slice(0, 40)}`,
      );
      try {
        const r2 = await callChat({
          providers,
          runId,
          purpose: 'summary',
          articleId: artId,
          system,
          user: `${user}\n\n你上次的输出不合法：${res1.error}。请重新只输出符合要求的 JSON 对象。`,
          temperature: SUMMARY.temperature,
          maxTokens,
          jsonMode: true,
          usage,
        });
        servedBy = r2.provider.name;
        const res2 = parseSummaryJson(r2.text);
        if (res2.ok) structured = res2.data;
        else fb = textFallback(r2.text);
      } catch (err) {
        fb = textFallback(r1.text); // 重试请求本身失败：退回首次文本兜底
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
  } catch (err) {
    // 所有供应商硬失败（网络/鉴权/内容审核等）
    lastErr = err instanceof Error ? err.message : String(err);
  }

  if (structured) {
    const body = rebuildBody(structured);
    const dbSummaryId = saveSummary(artId, CACHE_VER, {
      body,
      category: structured.category,
      titleZh: structured.titleZh,
      points: structured.points,
      verdict: structured.verdict,
      servedBy,
    });
    return {
      summary: body,
      category: structured.category,
      titleZh: structured.titleZh,
      points: structured.points,
      verdict: structured.verdict,
      fromCache: false,
      usedFallbackText,
      servedBy,
      dbSummaryId,
    };
  }
  if (fb?.body) {
    // 降级：JSON 链路失败但拿到了可用文本，按旧格式解析正文
    degraded = true;
    const dbSummaryId = saveSummary(artId, CACHE_VER, {
      body: fb.body,
      category: fb.category,
      titleZh: fb.titleZh,
      degraded: true,
      servedBy,
    });
    return {
      summary: fb.body,
      category: fb.category,
      titleZh: fb.titleZh,
      fromCache: false,
      usedFallbackText,
      servedBy,
      degraded,
      dbSummaryId,
    };
  }
  return { summary: null, fromCache: false, usedFallbackText, error: lastErr || '生成失败' };
}

/** 旧版头部文本解析兜底：提取 category/titleZh/正文（正文原样，渲染器自行解析要点） */
function textFallback(raw: string): FallbackSummary | undefined {
  const fb = parseSummaryBlock(raw);
  return fb.body ? fb : undefined;
}

export interface SummarizeStats {
  total: number;
  ok: number;
  cached: number;
  failed: number;
  degraded: number;
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
      stats: {
        total: articles.length,
        ok: 0,
        cached: 0,
        failed: articles.length,
        degraded: 0,
        usage: {},
      },
    };
  }
  console.log(`[ai] 模型候选: ${providers.map((p) => `${p.name}(${p.model})`).join(' → ')}`);

  const system = buildSystemPrompt();
  const usage: UsageMap = {};
  let done = 0;
  const results = await pool(articles, SETTINGS.summaryConcurrency, async (a) => {
    const r = await summarizeOne(providers, a, system, usage, runId);
    done++;
    const flag = r.summary
      ? r.fromCache
        ? '缓存'
        : `${r.servedBy ?? '完成'}${r.degraded ? '(降级)' : ''}`
      : `失败(${r.error})`;
    console.log(`[ai] ${done}/${articles.length} ${flag} - ${a.title.slice(0, 50)}`);
    return r; // 摘要已随篇入库，中途崩溃不丢已完成的总结
  });

  const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
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
    degraded: results.filter((r) => r.degraded).length,
    usage,
  };
  return { results, stats };
}
