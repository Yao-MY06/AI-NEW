# AI-NEW 日报容器。
# 基础镜像用 debian-slim（glibc）：better-sqlite3@12 有 prebuilt 二进制，无需 python3/make/g++；
# 若改用 alpine（musl）需先安装编译工具链：apk add --no-cache python3 make g++。
# 注意：容器内没有 Microsoft Edge，PDF 导出会自动跳过（html/md/txt 正常生成）。
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

# 默认单次运行；常驻调度（cron + 管理后台）由 docker-compose 的 command: npm run cron 覆写
CMD ["npx", "tsx", "src/main.ts"]
