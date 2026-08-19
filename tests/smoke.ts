/** 冒烟测试：processArticles 的同题合并 / 黑名单 / 关注置顶（纯函数，无副作用）*/
import { processArticles } from '../src/filter.js';
import type { Article } from '../src/types.js';

const A = (title: string, link: string, source: string, text = ''): Article => ({
  title,
  link,
  pubDate: new Date(Date.now() - 3600_000),
  source,
  text,
  kind: 'feed',
});

const list = [
  A('OpenAI launches new GPT-5 model', 'https://a.com/1', 'TechCrunch AI'),
  A('OpenAI Launches New GPT-5 Model!', 'https://b.com/1', 'The Verge AI'), // 跨源同题
  A('Unrelated story about chips', 'https://a.com/1?utm_source=x', 'Hacker News', 'FPGA 加速卡发布'), // URL 归一化后同链接
  A('We are hiring AI engineers', 'https://a.com/3', 'Hacker News'), // 黑名单命中
  A('Cerebras ships new chip', 'https://a.com/4', 'TechCrunch AI', 'wafer-scale FPGA chipset'), // 关注命中（正文）
];

const { articles, stats } = processArticles(list, {
  sinceMs: Date.now() - 86_400_000,
  pinKeywords: ['FPGA', '芯片'],
  blockKeywords: ['hiring', '招聘'],
});

console.log('stats:', stats);
for (const a of articles) {
  console.log(
    ` - ${a.pinned ? '[置顶] ' : ''}${a.title} | ${a.source}` +
      (a.alsoReportedBy?.length ? ` | 多源: ${a.alsoReportedBy.join('、')}` : ''),
  );
}

const pass =
  stats.titleMerged === 1 &&
  stats.urlDup === 1 &&
  stats.blocked === 1 &&
  stats.pinned === 1 &&
  articles.length === 2 &&
  articles[0].pinned === true &&
  articles.some((a) => a.alsoReportedBy?.includes('The Verge AI'));

console.log(pass ? '\n冒烟测试通过 ✓' : '\n冒烟测试失败 ✗');
process.exit(pass ? 0 : 1);
