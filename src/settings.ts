/**
 * 运行时可编辑设置（data/settings.json，Web 后台读写，原子写入）。
 * 优先级：settings.json > 环境变量 > 内置默认；保存过 settings.json 后同项 env 不再生效。
 * API Key / 模型 / 代理等敏感项只存 .env，绝不进入本文件。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SETTINGS_FILE = path.join(ROOT, 'data', 'settings.json');

export interface EditableSettings {
  summary: {
    templateId: 'tech' | 'security';
    style: 'brief' | 'detailed';
    verdict: boolean;
    /** 自定义人设；空字符串 = 用模板默认人设 */
    personaOverride: string;
    pinKeywords: string[];
    blockKeywords: string[];
    temperature: number;
    maxTokensBrief: number;
    maxTokensDetailed: number;
  };
  judge: {
    enabled: boolean;
  };
}

export const DEFAULT_SETTINGS: EditableSettings = {
  summary: {
    templateId: 'tech',
    style: 'brief',
    verdict: true,
    personaOverride: '',
    pinKeywords: [],
    blockKeywords: [],
    temperature: 0.3,
    maxTokensBrief: 600,
    maxTokensDetailed: 900,
  },
  judge: { enabled: true },
};

export type ValidateResult =
  { ok: true; value: EditableSettings } | { ok: false; errors: string[] };

/** 校验并规范化外部传入的设置对象（admin PUT / 单测复用），错误信息为中文 */
export function validateSettings(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['请求体必须是 JSON 对象'] };
  const r = raw as Record<string, unknown>;
  const s = (r.summary ?? {}) as Record<string, unknown>;
  const j = (r.judge ?? {}) as Record<string, unknown>;
  const errors: string[] = [];

  let templateId: 'tech' | 'security' | undefined;
  if (s.templateId === 'tech' || s.templateId === 'security') templateId = s.templateId;
  else errors.push('summary.templateId 只能是 tech 或 security');

  let style: 'brief' | 'detailed' | undefined;
  if (s.style === 'brief' || s.style === 'detailed') style = s.style;
  else errors.push('summary.style 只能是 brief 或 detailed');

  let verdict: boolean | undefined;
  if (typeof s.verdict === 'boolean') verdict = s.verdict;
  else errors.push('summary.verdict 必须是布尔值');

  const personaOverride =
    typeof s.personaOverride === 'string' ? s.personaOverride.trim().slice(0, 200) : '';

  const toList = (v: unknown, label: string): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      errors.push(`${label} 必须是字符串数组`);
      return [];
    }
    return v
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 100);
  };
  const pinKeywords = toList(s.pinKeywords, 'summary.pinKeywords');
  const blockKeywords = toList(s.blockKeywords, 'summary.blockKeywords');

  let temperature: number | undefined;
  if (typeof s.temperature === 'number' && s.temperature >= 0 && s.temperature <= 2) {
    temperature = s.temperature;
  } else {
    errors.push('summary.temperature 必须是 0~2 之间的数字');
  }

  const maxTokens = (v: unknown, label: string): number | undefined => {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 8000) return v;
    errors.push(`${label} 必须是 100~8000 的整数`);
    return undefined;
  };
  const maxTokensBrief = maxTokens(s.maxTokensBrief, 'summary.maxTokensBrief');
  const maxTokensDetailed = maxTokens(s.maxTokensDetailed, 'summary.maxTokensDetailed');

  let judgeEnabled = true;
  if (typeof j.enabled === 'boolean') judgeEnabled = j.enabled;
  else if (j.enabled !== undefined) errors.push('judge.enabled 必须是布尔值');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      summary: {
        templateId: templateId ?? 'tech',
        style: style ?? 'brief',
        verdict: verdict ?? true,
        personaOverride,
        pinKeywords,
        blockKeywords,
        temperature: temperature ?? 0.3,
        maxTokensBrief: maxTokensBrief ?? 600,
        maxTokensDetailed: maxTokensDetailed ?? 900,
      },
      judge: { enabled: judgeEnabled },
    },
  };
}

/** 读取 settings.json；文件不存在或损坏返回 null（损坏时告警，由上层回退默认/env） */
export function readSettingsFile(): EditableSettings | null {
  try {
    if (!existsSync(SETTINGS_FILE)) return null;
    const raw: unknown = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    const result = validateSettings(raw);
    if (result.ok) return result.value;
    console.warn(`[settings] settings.json 内容不合法，已忽略: ${result.errors.join('；')}`);
    return null;
  } catch (err) {
    console.warn(
      `[settings] settings.json 读取失败，已忽略: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** 读取生效设置：settings.json 存在则用之，否则内置默认 */
export function loadEditableSettings(): EditableSettings {
  return readSettingsFile() ?? DEFAULT_SETTINGS;
}

/** 校验通过后调用；先写 .tmp 再原子替换，避免写一半损坏 */
export function saveEditableSettings(s: EditableSettings): void {
  mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
  renameSync(tmp, SETTINGS_FILE);
}
