import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/** 项目根目录（不受运行时 cwd 影响） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_DIR = path.join(ROOT, 'output');
export const CACHE_FILE = path.join(ROOT, '.cache.json');

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

// ===== 摘要模板 =====

export interface SummaryTemplateConf {
  id: string;
  label: string;
  persona: string;
  pinKeywords: string[];
  blockKeywords: string[];
}

const TEMPLATES: Record<string, SummaryTemplateConf> = {
  tech: {
    id: 'tech',
    label: '技术简报',
    persona: '你是资深科技新闻编辑',
    pinKeywords: [],
    blockKeywords: [],
  },
  security: {
    id: 'security',
    label: '风险安全专刊',
    persona: '你是资深安全研究员，评估新闻时突出威胁面、影响范围与处置建议',
    pinKeywords: [
      '漏洞', '攻击', '泄露', '安全', '入侵',
      'breach', 'vulnerability', 'cve', 'exploit', 'malware', 'ransomware', 'phishing', 'backdoor',
    ],
    blockKeywords: [],
  },
};

/** 读逗号分隔的环境变量，未设置或为空返回 undefined */
function csvEnv(name: string): string[] | undefined {
  const v = process.env[name];
  if (!v || !v.trim()) return undefined;
  return v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

export interface SummaryConf {
  templateId: string;
  label: string;
  persona: string;
  style: 'brief' | 'detailed';
  verdict: boolean;
  pinKeywords: string[];
  blockKeywords: string[];
}

export const SUMMARY: SummaryConf = (() => {
  const id = (process.env.SUMMARY_TEMPLATE || 'tech').toLowerCase();
  const base = TEMPLATES[id] ?? TEMPLATES.tech;
  return {
    templateId: base.id,
    label: base.label,
    persona: base.persona,
    style: process.env.SUMMARY_STYLE === 'detailed' ? 'detailed' : 'brief',
    verdict: (process.env.SUMMARY_VERDICT ?? 'true') !== 'false',
    pinKeywords: csvEnv('PIN_KEYWORDS') ?? base.pinKeywords,
    blockKeywords: csvEnv('BLOCK_KEYWORDS') ?? base.blockKeywords,
  };
})();

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
