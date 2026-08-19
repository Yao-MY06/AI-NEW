# AI-NEW · AI 新闻聚合器

从 RSS 源抓取最新 AI 资讯，用大模型总结中文要点，输出排版精美的 HTML 日报（Markdown 备用）。

## 数据源

- [TechCrunch AI](https://techcrunch.com/category/artificial-intelligence/feed/)
- [The Verge AI](https://www.theverge.com/rss/ai-artificial-intelligence/index.xml)
- [Hacker News](https://hnrss.org/newest?q=AI&count=30)（自动抓取条目指向的网页正文）

## 快速开始

```bash
npm install
cp .env.example .env   # 填入你的 API Key（任意 OpenAI 兼容服务）
npx tsx src/main.ts
```

输出：`output/YYYY-MM-DD.html`（主）+ `output/YYYY-MM-DD.md`（备用）。

## 配置（.env）

| 变量 | 说明 |
|---|---|
| `OPENAI_API_KEY` | 主模型 API Key（不填则跳过总结，仅出标题列表） |
| `OPENAI_BASE_URL` | OpenAI 兼容接口地址，如智谱 `https://open.bigmodel.cn/api/paas/v4` |
| `OPENAI_MODEL` | 模型名，如 `glm-4-flash`（免费）/ `deepseek-chat` / `gpt-4o-mini` |
| `FALLBACK_1_*` / `FALLBACK_2_*` | 备用模型（同前三项），主模型失败自动按序切换，连续失败 3 次本轮停用；本地 Ollama 也可作为候选 |
| `SUMMARY_TEMPLATE` | `tech` 技术简报（默认）/ `security` 风险安全专刊（安全视角 + 安全类关键词自动置顶） |
| `SUMMARY_STYLE` | `brief` 精简 2~3 条（默认）/ `detailed` 详细 4~6 条 |
| `SUMMARY_VERDICT` | `false` 则不生成点评 |
| `PIN_KEYWORDS` | 关注关键词（逗号分隔），命中文章置顶 + ★ 标记；中英文需分别列出 |
| `BLOCK_KEYWORDS` | 黑名单关键词，命中文章直接过滤 |
| `HTTPS_PROXY` | 可选网络代理 |

> 摘要缓存按模板/风格/点评配置自动失效，切换模板后会重新总结。

## 定时自动运行（Windows）

双击 `scripts/install-task.bat` 注册计划任务（每日 08:30），日志追加到 `logs/run.log`：

```bat
schtasks /run /tn "AI-NEW Daily Report"      :: 手动试跑
schtasks /change /tn "AI-NEW Daily Report" /st 09:00   :: 改时间
schtasks /delete /tn "AI-NEW Daily Report"   :: 删除
```

## 用法

```bash
npx tsx src/main.ts           # 最近 24 小时
npx tsx src/main.ts --days=3  # 最近 3 天
```

## 特性

- 43 篇/天实测约 90s（glm-4-flash，免费），每日 08:30 计划任务自动生成
- 多模型候选 + 自动故障转移（含本地 Ollama），日志记录每次切换原因
- 摘要模板：精简/详细、点评开关、关注关键词置顶、黑名单过滤、中英术语表统一翻译
- AI 自动分类（大模型/安全风险/硬件芯片/行业融资/政策监管/开源项目/产品应用）+ 中文标题
- 去重两层：链接归一化去重 + 跨源同题合并（标题相似度，标注「多源报道」）
- HTML 日报：分类分栏、统计看板（来源/分类分布 + 标题热词云）、分类/来源/关键词三维筛选、原文预览弹窗、深浅色主题切换、可打印
- 历史存档页 `output/index.html`：按日期回溯、全文检索、跨天事件时间线（同题自动聚类）
- 导出：HTML / Markdown（Notion 可直接导入）/ TXT / PDF（Edge 无头打印）
- Web 管理后台（`npm run admin` → http://127.0.0.1:5666）：可视化增删/启停订阅源、试抓、一键运行
- 摘要本地缓存（`.cache.json`，按配置版本失效），重跑不重复计费
