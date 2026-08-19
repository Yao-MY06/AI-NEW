import { setupProxy } from './proxy.js';
import { OUTPUT_DIR, SUMMARY } from './config.js';
import { fetchAllFeeds } from './feeds.js';
import { processArticles } from './filter.js';
import { summarizeAll } from './summarize.js';
import { renderReport, renderTextReport, writeReport, writeTextReport } from './report.js';
import { renderHtmlReport, writeHtmlReport } from './report-html.js';
import { tryPrintPdf } from './pdf.js';
import { updateArchive } from './archive.js';

/** 解析 --days=N 参数，默认最近 1 天 */
function parseDays(): number {
  const arg = process.argv.find((a) => a.startsWith('--days='));
  if (!arg) return 1;
  const n = Number(arg.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30) : 1;
}

async function main(): Promise<void> {
  const started = Date.now();
  setupProxy();

  const days = parseDays();
  const sinceMs = Date.now() - days * 24 * 3600 * 1000;
  console.log(
    `== AI 新闻聚合器 == 模板: ${SUMMARY.label}（${SUMMARY.style === 'detailed' ? '详细' : '精简'}）· 时间窗口: 最近 ${days} 天\n`,
  );

  console.log('1/4 抓取 RSS 源...');
  const feeds = await fetchAllFeeds();
  const all = feeds.flatMap((f) => f.articles);
  if (!all.length) {
    console.error('所有 RSS 源均抓取失败，退出（可尝试在 .env 配置 HTTPS_PROXY）');
    process.exit(1);
  }

  console.log('\n2/4 过滤与排序...');
  const { articles, stats: ps } = processArticles(all, {
    sinceMs,
    pinKeywords: SUMMARY.pinKeywords,
    blockKeywords: SUMMARY.blockKeywords,
  });
  console.log(
    `窗口内 ${ps.inWindow} 篇（合并同题 ${ps.titleMerged}，关键词过滤 ${ps.blocked}，关注置顶 ${ps.pinned}）→ 最终 ${articles.length} 篇`,
  );
  if (!articles.length) {
    console.log('时间窗口内没有文章，结束');
    return;
  }

  console.log('\n3/4 AI 总结...');
  const { results, stats } = await summarizeAll(articles);

  console.log('\n4/4 生成报告...');
  const since = new Date(sinceMs);
  // 分类/中文标题回填到文章对象，供各渲染器使用
  results.forEach((r, i) => {
    if (r.category) articles[i].category = r.category;
    if (r.titleZh) articles[i].titleZh = r.titleZh;
  });

  const htmlFile = writeHtmlReport(renderHtmlReport(articles, results, feeds, stats, since));
  const mdFile = writeReport(renderReport(articles, results, feeds, stats, since)); // Notion 可直接导入
  const txtFile = writeTextReport(renderTextReport(articles, results, stats));
  tryPrintPdf(htmlFile);
  const archive = updateArchive(articles, results, stats);

  console.log(
    `\n完成: ${articles.length} 篇（总结成功 ${stats.ok}，缓存命中 ${stats.cached}，失败 ${stats.failed}）`,
  );
  console.log(`报告(HTML): ${htmlFile}`);
  console.log(`备用(MD/Notion): ${mdFile}`);
  console.log(`纯文本: ${txtFile}`);
  console.log(`存档首页: ${archive.index}`);
  console.log(`耗时: ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('运行出错:', err);
  process.exit(1);
});
