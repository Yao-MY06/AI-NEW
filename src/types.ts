/** 单篇文章（已提取字段，待总结） */
export interface Article {
  title: string;
  link: string;
  pubDate: Date;
  source: string;
  /** 来自 RSS 描述 / content:encoded 的正文文本（已去 HTML、截断） */
  text: string;
  kind: 'feed' | 'hn';
  /** 跨源同题报道的其他来源 */
  alsoReportedBy?: string[];
  /** 命中关注关键词，置顶展示 */
  pinned?: boolean;
}

/** 单篇总结结果 */
export interface SummaryResult {
  summary: string | null; // null = 失败
  fromCache: boolean;
  /** HN 目标网页抓取失败，降级用了 RSS 简介 */
  usedFallbackText: boolean;
  /** 实际生成摘要的模型名称（缓存命中时为空） */
  servedBy?: string;
  error?: string;
}

/** 单个 RSS 源的抓取结果 */
export interface FeedResult {
  source: string;
  ok: boolean;
  error?: string;
  articles: Article[];
}
