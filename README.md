# AI-NEW · AI 新闻聚合器

从 RSS 源抓取最新 AI 资讯，用大模型总结中文要点（Zod 结构化输出 + 多模型故障转移），
LLM-as-Judge 自动评审摘要质量，输出排版精美的 HTML 日报（Markdown 备用）。

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

| 变量                            | 说明                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                | 主模型 API Key（不填则跳过总结，仅出标题列表）                                                |
| `OPENAI_BASE_URL`               | OpenAI 兼容接口地址，如智谱 `https://open.bigmodel.cn/api/paas/v4`                            |
| `OPENAI_MODEL`                  | 模型名，如 `glm-4-flash`（免费）/ `deepseek-chat` / `gpt-4o-mini`                             |
| `FALLBACK_1_*` / `FALLBACK_2_*` | 备用模型（同前三项），主模型失败自动按序切换，连续失败 3 次本轮停用；本地 Ollama 也可作为候选 |
| `SUMMARY_TEMPLATE`              | `tech` 技术简报（默认）/ `security` 风险安全专刊（安全视角 + 安全类关键词自动置顶）           |
| `SUMMARY_STYLE`                 | `brief` 精简 2~~3 条（默认）/ `detailed` 详细 4~~6 条                                         |
| `SUMMARY_VERDICT`               | `false` 则不生成点评                                                                          |
| `PIN_KEYWORDS`                  | 关注关键词（逗号分隔），命中文章置顶 + ★ 标记；中英文需分别列出                               |
| `BLOCK_KEYWORDS`                | 黑名单关键词，命中文章直接过滤                                                                |
| `HTTPS_PROXY`                   | 可选网络代理                                                                                  |

> 摘要配置（模板/风格/点评/关键词/采样参数）优先在管理后台「摘要设置」中修改（写入 `data/settings.json`），
> 保存后同项环境变量不再生效。摘要缓存按配置版本自动失效，切换配置后重新总结。

## 定时自动运行（Windows）

双击 `scripts/install-task.bat` 注册计划任务（每日 08:30），日志追加到 `logs/run.log`：

```bat
schtasks /run /tn "AI-NEW Daily Report"      :: 手动试跑
schtasks /change /tn "AI-NEW Daily Report" /st 09:00   :: 改时间
schtasks /delete /tn "AI-NEW Daily Report"   :: 删除
```

## Docker 部署（常驻调度 + 管理后台）

```bash
docker compose up -d --build
```

- 每日北京时间 08:30 自动运行（`CRON_EXPR=30 8 * * *`，`TZ=Asia/Shanghai`，可用 `RUN_ON_START=true` 启动先跑一次）
- 管理后台 `http://127.0.0.1:5666`（仅本机可访问）；数据卷：`./data`（SQLite + 设置）、`./output`（日报）、`./logs`
- 镜像 `ghcr.io/yao-my06/ai-new`（推 main 自动构建）；容器内无 Edge，PDF 导出自动跳过

## 用法

```bash
npm start                # 最近 24 小时
npm start -- --days=3    # 最近 3 天
npm run admin            # 管理后台（127.0.0.1:5666）
npm run cron             # 常驻调度入口（Docker 用，见 docker-compose.yml）
npm run db:check         # 查看 SQLite 库内统计（文章/摘要/运行/模型调用）
npm run typecheck && npm run lint && npm test   # CI 同款检查（46 个单测）
```

## 架构

```
RSS 抓取(feeds.ts) → 过滤/去重(filter.ts) → AI 总结(summarize.ts → llm.ts → schema.ts)
  → 质量评审(judge.ts, LLM-as-Judge) → 渲染(report-html.ts / report.ts / pdf.ts) → 存档(archive.ts)
  持久化(db.ts, SQLite)：articles / summaries(缓存) / runs / model_calls(token 明细) / judge_scores
```

## 特性

- 43 篇/天实测约 90s（glm-4-flash，免费），每日 08:30 自动生成
- 多模型候选 + 自动故障转移（含本地 Ollama）+ 连续失败熔断；每次调用（成败）含 token 用量与延迟落库
- **结构化输出**：Zod schema 校验（分类枚举/标题/要点/点评），`response_format: json_object` 运行时探测
  降级 + 校验失败带反馈重试 + 旧版文本解析三层兜底，实测 100% 结构化成功率
- **LLM-as-Judge 质量评审**：每篇摘要按事实一致性/完整度/流畅度打分，日报内 ★ 徽章（hover 短评）+
  报头当日均值；评分缓存，不重复消耗
- 摘要模板：精简/详细、点评开关、自定义人设、关注关键词置顶、黑名单过滤、中英术语表统一翻译
- AI 自动分类（大模型/安全风险/硬件芯片/行业融资/政策监管/开源项目/产品应用）+ 中文标题
- 去重两层：链接归一化去重 + 跨源同题合并（标题相似度，标注「多源报道」）
- HTML 日报：分类分栏、统计看板（来源/分类分布 + 标题热词云）、三维筛选、原文预览弹窗、深浅色主题、可打印
- 历史存档页 `output/index.html`：按日期回溯、全文检索、跨天事件时间线（同题自动聚类）、质量评分
- 导出：HTML / Markdown（Notion 可直接导入）/ TXT / PDF（Edge 无头打印）
- **Web 管理后台**（`npm run admin` → http://127.0.0.1:5666）：订阅源增删启停、摘要设置（模板/关键词/
  采样参数）、统计看板（每日概览/模型用量/最近运行）、一键运行 + 运行日志回看
- **SQLite 持久化**（`data/ainew.db`，WAL）：文章、摘要缓存（版本化失效 + TTL）、运行日志、模型调用明细；
  旧 `.cache.json`/`archive.json` 首次运行自动导入
- CI（GitHub Actions）：typecheck + eslint + vitest；镜像推 GHCR
