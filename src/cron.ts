/**
 * 常驻调度入口（Docker 部署用，`npm run cron`）：
 * - CRON_EXPR 设置时按表达式定时运行日报（node-cron，时区跟随 TZ）；不设置则不做调度
 * - RUN_ON_START=true 启动时先跑一次
 * - ADMIN_ENABLED!=false 时同进程启动管理后台（host 由 ADMIN_HOST 控制）
 * Windows 本机部署无需本入口（用 scripts/install-task.bat 的计划任务即可）。
 */
import cron from 'node-cron';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { startAdmin } from './admin.js';

const EXPR = process.env.CRON_EXPR ?? '';

function runOnce(trigger: string): void {
  mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  const logFile = path.join(ROOT, 'logs', 'run.log');
  const fd = openSync(logFile, 'a');
  console.log(`[cron] ${trigger} 触发运行日报 → 追加日志 ${path.relative(ROOT, logFile)}`);
  const child = spawn('npx', ['tsx', 'src/main.ts'], {
    cwd: ROOT,
    shell: true,
    stdio: ['ignore', fd, fd],
  });
  child.on('spawn', () => closeSync(fd)); // 子进程已继承句柄
  child.on('error', (err) => {
    console.error(`[cron] 运行失败: ${err.message}`);
    closeSync(fd);
  });
}

if (process.env.ADMIN_ENABLED !== 'false') startAdmin();

if (!EXPR) {
  console.log('[cron] 未设置 CRON_EXPR，不做定时调度（常驻场景请配置，如 "30 8 * * *"）');
  if (process.env.ADMIN_ENABLED === 'false') process.exit(0);
} else {
  if (!cron.validate(EXPR)) {
    console.error(`[cron] CRON_EXPR 不合法: ${EXPR}`);
    process.exit(1);
  }
  if (process.env.RUN_ON_START === 'true') runOnce('启动');
  cron.schedule(EXPR, () => runOnce('定时'), { timezone: process.env.TZ });
  console.log(`[cron] 调度已启动: "${EXPR}"（TZ=${process.env.TZ || 'system'}）`);
}
