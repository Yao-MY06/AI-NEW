/** 结构化输出：extractJson 宽松提取与 SummaryJsonSchema 校验 */
import { describe, expect, it } from 'vitest';
import { SummaryJsonSchema, extractJson, parseSummaryJson } from '../src/schema.js';

const VALID = {
  category: '大模型',
  titleZh: 'OpenAI 发布新一代模型',
  points: ['性能提升两倍', '价格下降一半'],
  verdict: '值得关注',
};

describe('extractJson', () => {
  it('裸 JSON 直接解析', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('剥 ```json 围栏', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('前后有杂文时截取花括号内容', () => {
    expect(extractJson('好的，结果如下：{"a":1} 以上。')).toEqual({ a: 1 });
  });

  it('无 JSON 时返回 null', () => {
    expect(extractJson('没有任何对象')).toBeNull();
    expect(extractJson('{ 不完整')).toBeNull();
  });
});

describe('SummaryJsonSchema', () => {
  it('合法对象通过', () => {
    expect(SummaryJsonSchema.safeParse(VALID).success).toBe(true);
  });

  it('分类不在 8 类枚举内被拒', () => {
    expect(SummaryJsonSchema.safeParse({ ...VALID, category: '财经' }).success).toBe(false);
  });

  it('要点为空数组被拒（单条要点合法）', () => {
    expect(SummaryJsonSchema.safeParse({ ...VALID, points: [] }).success).toBe(false);
    expect(SummaryJsonSchema.safeParse({ ...VALID, points: ['只有一条'] }).success).toBe(true);
  });

  it('verdict 可省略', () => {
    const noVerdict: Record<string, unknown> = { ...VALID };
    delete noVerdict.verdict;
    expect(SummaryJsonSchema.safeParse(noVerdict).success).toBe(true);
  });
});

describe('parseSummaryJson', () => {
  it('围栏包裹的合法摘要解析成功', () => {
    const r = parseSummaryJson('```json\n' + JSON.stringify(VALID) + '\n```');
    expect(r.ok).toBe(true);
  });

  it('非法输出返回可读错误（用于反馈重试）', () => {
    const r = parseSummaryJson('抱歉我不能输出 JSON');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeTruthy();
    const r2 = parseSummaryJson(JSON.stringify({ ...VALID, category: '不存在的分类' }));
    expect(r2.ok).toBe(false);
  });
});
