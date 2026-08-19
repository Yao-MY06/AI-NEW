/** 设置校验：validateSettings 的合法/非法分支 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, validateSettings } from '../src/settings.js';

describe('validateSettings', () => {
  it('合法对象通过并保留字段', () => {
    const r = validateSettings({
      summary: {
        templateId: 'security',
        style: 'detailed',
        verdict: false,
        personaOverride: '  你是测试编辑  ',
        pinKeywords: ['芯片', ' FPGA ', ''],
        blockKeywords: ['招聘'],
        temperature: 0.7,
        maxTokensBrief: 500,
        maxTokensDetailed: 1000,
      },
      judge: { enabled: false },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summary.templateId).toBe('security');
    expect(r.value.summary.style).toBe('detailed');
    expect(r.value.summary.verdict).toBe(false);
    expect(r.value.summary.personaOverride).toBe('你是测试编辑'); // trim
    expect(r.value.summary.pinKeywords).toEqual(['芯片', 'FPGA']); // 去空白项
    expect(r.value.judge.enabled).toBe(false);
  });

  it('temperature 越界被拒（中文错误）', () => {
    const r = validateSettings({
      ...DEFAULT_SETTINGS,
      summary: { ...DEFAULT_SETTINGS.summary, temperature: 9 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join()).toContain('temperature');
  });

  it('非法 templateId / style / verdict 逐项报错', () => {
    const r = validateSettings({ summary: { templateId: 'x', style: 'y', verdict: 1 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('max_tokens 超范围被拒', () => {
    const r = validateSettings({
      summary: { ...DEFAULT_SETTINGS.summary, maxTokensBrief: 10 },
    });
    expect(r.ok).toBe(false);
  });

  it('非对象输入直接拒绝', () => {
    expect(validateSettings('oops').ok).toBe(false);
    expect(validateSettings(null).ok).toBe(false);
  });

  it('judge.enabled 缺省视为开启', () => {
    const r = validateSettings({ summary: { ...DEFAULT_SETTINGS.summary } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.judge.enabled).toBe(true);
  });
});
