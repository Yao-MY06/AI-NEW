import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { readSettingsFile } from './settings.js';

/** 项目根目录（不受运行时 cwd 影响） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_DIR = path.join(ROOT, 'output');
export const CACHE_FILE = path.join(ROOT, '.cache.json');
/** 持久化数据目录（SQLite 库 + 可编辑设置），Docker 部署时挂载为卷 */
export const DATA_DIR = path.join(ROOT, 'data');
export const DB_FILE = process.env.AINEW_DB || path.join(DATA_DIR, 'ainew.db');
/** RSS 源的持久化配置（Web 后台可改），不存在时回退到内置 FEEDS */
export const FEEDS_FILE = path.join(ROOT, 'feeds.json');

// 在读取任何环境变量之前加载 .env
loadDotenv({ path: path.join(ROOT, '.env') });

export interface FeedConfig {
  name: string;
  url: string;
  kind: 'feed' | 'hn';
}

export const FEEDS: FeedConfig[] = [
  {
    name: 'TechCrunch AI',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/',
    kind: 'feed',
  },
  {
    name: 'The Verge AI',
    url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    kind: 'feed',
  },
  {
    name: 'Hacker News',
    url: 'https://hnrss.org/newest?q=AI&count=30',
    kind: 'hn',
  },
];

export const SETTINGS = {
  fetchTimeoutMs: 15_000, // RSS 抓取超时
  fetchRetries: 3, // RSS 抓取尝试次数
  pageTimeoutMs: 8_000, // HN 目标网页抓取超时
  pageMaxBytes: 5_000_000, // 网页体积上限，超过视为异常
  maxChars: 4_000, // 送入 AI 的正文截断长度
  summaryConcurrency: 4, // AI 总结并发数
  apiTimeoutMs: 60_000, // 单次 AI 请求超时
  providerFailsLimit: 3, // 模型连续失败此次数后本轮停用
  cacheTtlDays: 14, // 摘要缓存保留天数
  titleMergeThreshold: 0.6, // 标题词集 Jaccard 相似度 ≥ 此值视为同题
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

/** 文章分类固定列表（模型总结时从中选择，日报按此分栏） */
export const CATEGORIES = [
  '大模型',
  '安全风险',
  '硬件芯片',
  '行业融资',
  '政策监管',
  '开源项目',
  '产品应用',
  '其他',
] as const;

/** 中英术语对照，写入提示词保证翻译一致性 */
export const GLOSSARY: [string, string][] = [
  ['LLM', '大模型'],
  ['inference', '推理'],
  ['token', '词元'],
  ['fine-tuning', '微调'],
  ['AI agent', '智能体'],
  ['benchmark', '基准测试'],
  ['open source', '开源'],
  ['multimodal', '多模态'],
  ['alignment', '对齐'],
  ['guardrail', '护栏'],
  ['context window', '上下文窗口'],
  ['hallucination', '幻觉'],
  ['quantization', '量化'],
  ['distillation', '蒸馏'],
  ['open weights', '开放权重'],
  ['reasoning model', '推理模型'],
];

// ===== 摘要模板 =====

export interface SummaryTemplateConf {
  id: string;
  label: string;
  persona: string;
  pinKeywords: string[];
  blockKeywords: string[];
}

const TECH_TEMPLATE: SummaryTemplateConf = {
  id: 'tech',
  label: '技术简报',
  persona: '你是资深科技新闻编辑',
  pinKeywords: [],
  blockKeywords: [],
};

export const TEMPLATES: Record<string, SummaryTemplateConf> = {
  tech: TECH_TEMPLATE,
  security: {
    id: 'security',
    label: '风险安全专刊',
    persona: '你是资深安全研究员，评估新闻时突出威胁面、影响范围与处置建议',
    pinKeywords: [
      '漏洞',
      '攻击',
      '泄露',
      '安全',
      '入侵',
      'breach',
      'vulnerability',
      'cve',
      'exploit',
      'malware',
      'ransomware',
      'phishing',
      'backdoor',
    ],
    blockKeywords: [],
  },
};

/** 读逗号分隔的环境变量，未设置或为空返回 undefined */
function csvEnv(name: string): string[] | undefined {
  const v = process.env[name];
  if (!v || !v.trim()) return undefined;
  return v
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface SummaryConf {
  templateId: string;
  label: string;
  persona: string;
  /** admin 设置的自定义人设（覆盖模板默认），未设置为 undefined */
  personaOverride?: string;
  style: 'brief' | 'detailed';
  verdict: boolean;
  pinKeywords: string[];
  blockKeywords: string[];
  /** 采样参数（admin 可调，并入摘要缓存版本） */
  temperature: number;
  maxTokensBrief: number;
  maxTokensDetailed: number;
}

/**
 * 生效摘要配置，三层合并：data/settings.json（admin 写）> 环境变量 > 内置默认。
 * 保存过 settings.json 后，其中已保存的项不再读环境变量。
 */
export const SUMMARY: SummaryConf = (() => {
  const st = readSettingsFile(); // null = 文件不存在（或损坏已告警），env 层生效
  const id = (st?.summary.templateId ?? process.env.SUMMARY_TEMPLATE ?? 'tech').toLowerCase();
  const base = TEMPLATES[id] ?? TECH_TEMPLATE;
  return {
    templateId: base.id,
    label: base.label,
    persona: base.persona,
    personaOverride: st?.summary.personaOverride || undefined,
    style: st?.summary.style ?? (process.env.SUMMARY_STYLE === 'detailed' ? 'detailed' : 'brief'),
    verdict: st ? st.summary.verdict : (process.env.SUMMARY_VERDICT ?? 'true') !== 'false',
    pinKeywords: st ? st.summary.pinKeywords : (csvEnv('PIN_KEYWORDS') ?? base.pinKeywords),
    blockKeywords: st ? st.summary.blockKeywords : (csvEnv('BLOCK_KEYWORDS') ?? base.blockKeywords),
    temperature: st?.summary.temperature ?? 0.3,
    maxTokensBrief: st?.summary.maxTokensBrief ?? 600,
    maxTokensDetailed: st?.summary.maxTokensDetailed ?? 900,
  };
})();

/** 质量评审（LLM-as-Judge）开关：settings.json 的 judge.enabled，默认开 */
export const JUDGE = { enabled: readSettingsFile()?.judge.enabled ?? true };

// ===== 模型候选（主模型 + 备用，按序故障转移）=====

export interface ProviderConf {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

/** 从环境变量构建候选列表：OPENAI_* 为主，FALLBACK_1_/FALLBACK_2_ 为备（配了 Key 才生效） */
export function buildProviders(): ProviderConf[] {
  const out: ProviderConf[] = [];
  const push = (name: string, pfx: string) => {
    const apiKey = process.env[`${pfx}API_KEY`] ?? '';
    if (!apiKey) return;
    out.push({
      name,
      baseURL: process.env[`${pfx}BASE_URL`] || 'https://api.openai.com/v1',
      apiKey,
      model: process.env[`${pfx}MODEL`] || 'gpt-4o-mini',
    });
  };
  push(process.env.PROVIDER_NAME || '主模型', 'OPENAI_');
  push('备用1', 'FALLBACK_1_');
  push('备用2', 'FALLBACK_2_');
  return out;
}
