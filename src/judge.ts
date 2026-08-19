/**
 * LLM-as-Judge 质量评审：对每篇摘要按 事实一致性/完整度/流畅度 打 1~5 分。
 * 评分落 judge_scores（(summary_id, ver) 唯一）——缓存命中的摘要已有评分不重复评；
 * 单篇失败仅告警，不影响主流程。
 */
import { SETTINGS } from './config.js';
import { getJudgeScore, saveJudgeScore, upsertArticle } from './db.js';
import { callChat, initProviders } from './llm.js';
import type { UsageMap } from './llm.js';
import { JUDGE_SCHEMA_ID, parseJudgeJson } from './schema.js';
import { pool, truncate } from './util.js';
import type { Article, SummaryResult } from './types.js';

const SYSTEM_PROMPT = `你是严格的新闻摘要质量评审员。用户给你【原文】（英文新闻标题与正文片段）和【AI 摘要】（中文）。按三个维度打 1~5 整数分：
- factual 事实一致性：5=完全忠实原文；3=有小瑕疵；1=严重幻觉或曲解
- completeness 完整性：5=覆盖全部核心信息；3=遗漏次要要点；1=漏掉关键事实
- fluency 流畅度：5=中文通顺、术语规范；1=生硬难读
只输出一个 JSON 对象（不要 markdown 代码块，不要解释），示例：{"factual":4,"completeness":5,"fluency":4,"overall":4.3,"comment":"要点覆盖全面，但第二处数字与原文不符"}
overall 为三维度综合（可带一位小数）；comment 是不超过 40 字的中文短评，指出最主要的问题或优点。`;

export interface JudgeOutcome {
  /** 新评分成功数 */
  ok: number;
  /** 评分失败数（仅告警） */
  failed: number;
  /** 已有当版评分而跳过的数量（含缓存命中） */
  skipped: number;
  /** summaryId → 评分（含本轮新评与历史评分），供渲染徽章 */
  bySummaryId: Map<number, { overall: number; comment: string }>;
}

export async function judgeAll(
  articles: Article[],
  results: SummaryResult[],
  runId: number,
): Promise<JudgeOutcome> {
  const pairs = articles
    .map((a, i) => ({ a, r: results[i] }))
    .filter(
      (p): p is { a: Article; r: SummaryResult & { summary: string; dbSummaryId: number } } =>
        !!p.r?.summary && p.r.dbSummaryId !== undefined,
    );

  const bySummaryId = new Map<number, { overall: number; comment: string }>();
  const todo: typeof pairs = [];
  for (const p of pairs) {
    const existed = getJudgeScore(p.r.dbSummaryId, JUDGE_SCHEMA_ID);
    if (existed) {
      bySummaryId.set(p.r.dbSummaryId, existed);
    } else {
      todo.push(p);
    }
  }
  const skipped = pairs.length - todo.length;
  if (!todo.length) {
    console.log(`[judge] ${pairs.length} 篇均已有评分，跳过`);
    return { ok: 0, failed: 0, skipped, bySummaryId };
  }

  const providers = initProviders();
  if (!providers.length) {
    console.warn('[judge] 未配置模型 API Key，跳过质量评审');
    return { ok: 0, failed: 0, skipped, bySummaryId };
  }

  const usage: UsageMap = {};
  let ok = 0;
  let failed = 0;
  let done = 0;
  await pool(todo, SETTINGS.summaryConcurrency, async ({ a, r }) => {
    const summaryId = r.dbSummaryId;
    const artId = upsertArticle(a);
    done++;
    try {
      const user = `【原文】\n标题: ${a.title}\n正文:\n${truncate(a.previewText || a.text, 2500)}\n\n【AI 摘要】\n${JSON.stringify(
        {
          category: r.category,
          titleZh: r.titleZh,
          points: r.points,
          verdict: r.verdict,
          summary: r.points?.length ? undefined : r.summary, // 结构化字段缺失时给正文供评审
        },
      )}`;
      const call = (u: string) =>
        callChat({
          providers,
          runId,
          purpose: 'judge',
          articleId: artId,
          system: SYSTEM_PROMPT,
          user: u,
          temperature: 0.2,
          maxTokens: 300,
          jsonMode: true,
          usage,
        });
      const first = await call(user);
      let res = parseJudgeJson(first.text);
      let served = first.provider;
      if (!res.ok) {
        // 校验失败带反馈重试一次
        const second = await call(
          `${user}\n\n你上次的输出不合法：${res.error}。请重新只输出符合要求的 JSON 对象。`,
        );
        served = second.provider;
        res = parseJudgeJson(second.text);
      }
      if (!res.ok) throw new Error(res.error);
      saveJudgeScore({
        summaryId,
        articleId: artId,
        runId,
        provider: served.name,
        model: served.model,
        factual: res.data.factual,
        completeness: res.data.completeness,
        fluency: res.data.fluency,
        overall: res.data.overall,
        comment: res.data.comment,
        ver: JUDGE_SCHEMA_ID,
      });
      ok++;
      bySummaryId.set(summaryId, { overall: res.data.overall, comment: res.data.comment });
      console.log(
        `[judge] ${done}/${todo.length} ★${res.data.overall.toFixed(1)} - ${a.title.slice(0, 40)}`,
      );
    } catch (err) {
      failed++;
      console.warn(
        `[judge] ${done}/${todo.length} 评分失败(${err instanceof Error ? err.message : String(err)}) - ${a.title.slice(0, 40)}`,
      );
    }
  });

  const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const usageStr = Object.entries(usage)
    .map(([k, v]) => `${k}=${v.calls}次(${fmtK(v.promptTokens)}/${fmtK(v.completionTokens)})`)
    .join(', ');
  if (usageStr) console.log(`[judge] 评审用量: ${usageStr}`);

  return { ok, failed, skipped, bySummaryId };
}
