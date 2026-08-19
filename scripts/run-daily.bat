@echo off
rem AI 新闻日报定时运行脚本：切到项目根目录执行，日志追加到 logs\run.log
cd /d "%~dp0.."
if not exist logs mkdir logs
echo ===== %date% %time% ===== >> logs\run.log
call npx tsx src/main.ts >> logs\run.log 2>&1
