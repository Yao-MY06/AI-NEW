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
  cacheTtlDays: 14, // 摘要缓存保留天数
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

export const AI = {
  apiKey: process.env.OPENAI_API_KEY ?? '',
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
};
