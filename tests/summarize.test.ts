/** 摘要头部解析（结构化输出改造后仍作为文本兜底路径保留） */
import { describe, expect, it } from 'vitest';
import { parseSummaryBlock } from '../src/summarize.js';

describe('parseSummaryBlock', () => {
  it('解析 分类/标题 头部并保留正文', () => {
    const parsed = parseSummaryBlock(
      '分类: 安全风险\n标题: 某厂商修复高危漏洞\n- 要点一\n- 要点二\n\n**点评**: 值得关注',
    );
    expect(parsed.category).toBe('安全风险');
    expect(parsed.titleZh).toBe('某厂商修复高危漏洞');
    expect(parsed.body.startsWith('- 要点一')).toBe(true);
    expect(parsed.body).toContain('**点评**: 值得关注');
  });

  it('支持「类别」写法与全角冒号', () => {
    const parsed = parseSummaryBlock('类别：大模型\n标题：新模型发布\n- 要点');
    expect(parsed.category).toBe('大模型');
    expect(parsed.titleZh).toBe('新模型发布');
  });

  it('无法识别的分类归入「其他」', () => {
    const parsed = parseSummaryBlock('分类: 财经体育\n- 要点');
    expect(parsed.category).toBe('其他');
  });

  it('无头部时正文原样返回', () => {
    const parsed = parseSummaryBlock('- 直接就是正文');
    expect(parsed.category).toBeUndefined();
    expect(parsed.titleZh).toBeUndefined();
    expect(parsed.body).toBe('- 直接就是正文');
  });
});
