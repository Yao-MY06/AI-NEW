/**
 * 结构化输出的 Zod schema 与宽松 JSON 提取。
 * 摘要与质量评分共用；schema id 并入缓存版本，字段变化自动失效。
 */
import { z } from 'zod';
import { CATEGORIES } from './config.js';

export const SUMMARY_SCHEMA_ID = 'summary-json-v2';

/** 摘要结构化输出契约：分类枚举 + 中文标题 + 要点数组 + 可选点评（要点数下限 1，宽松校验结构而非编辑策略） */
export const SummaryJsonSchema = z.object({
  category: z.enum(CATEGORIES),
  titleZh: z.string().trim().min(2).max(80),
  points: z.array(z.string().trim().min(2)).min(1).max(6),
  verdict: z.string().trim().max(200).optional(),
});
export type SummaryJson = z.infer<typeof SummaryJsonSchema>;

export const JUDGE_SCHEMA_ID = 'judge-v1'; // M5 质量评分使用

/** 宽松提取 JSON：剥 ```json 围栏，截取首个 { 到末个 }；失败返回 null */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export type ParseSummaryResult = { ok: true; data: SummaryJson } | { ok: false; error: string };

/** 提取 + 解析 + 校验一步到位；错误信息用于反馈给模型重试 */
export function parseSummaryJson(raw: string): ParseSummaryResult {
  const v = extractJson(raw);
  if (v === null) return { ok: false, error: '输出中未找到 JSON 对象' };
  const r = SummaryJsonSchema.safeParse(v);
  if (r.success) return { ok: true, data: r.data };
  const issues = r.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(根对象)'} ${i.message}`)
    .join('；');
  return { ok: false, error: issues };
}
