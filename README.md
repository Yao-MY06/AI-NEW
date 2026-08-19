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
| `OPENAI_API_KEY` | API Key（不填则跳过总结，仅出标题列表） |
| `OPENAI_BASE_URL` | OpenAI 兼容接口地址，如智谱 `https://open.bigmodel.cn/api/paas/v4` |
| `OPENAI_MODEL` | 模型名，如 `glm-4-flash`（免费）/ `deepseek-chat` / `gpt-4o-mini` |
| `HTTPS_PROXY` | 可选网络代理 |

## 用法

```bash
npx tsx src/main.ts           # 最近 24 小时
npx tsx src/main.ts --days=3  # 最近 3 天
```

## 特性

- 43 篇/天实测约 77s（glm-4-flash，免费）
- 摘要本地缓存（`.cache.json`），重跑不重复计费
- 并发总结 + 自动重试；单源/单篇失败不阻塞整体
- HN 条目抓正文（readability 提取），失败降级用 RSS 简介
- HTML 日报：编辑风排版、源筛选、关键词搜索、响应式、可打印
