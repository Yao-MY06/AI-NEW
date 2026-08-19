@echo off
chcp 65001 >nul
rem 注册 Windows 计划任务：每日 08:30 自动生成日报（当前用户权限即可）
schtasks /create /f /tn "AI-NEW Daily Report" /tr "\"%~dp0run-daily.bat\"" /sc daily /st 08:30
if %errorlevel%==0 (
  echo.
  echo 已注册：每日 08:30 运行，日志见 logs\run.log
  echo 修改时间: schtasks /change /tn "AI-NEW Daily Report" /st 09:00
  echo 手动试跑: schtasks /run /tn "AI-NEW Daily Report"
  echo 删除任务: schtasks /delete /tn "AI-NEW Daily Report"
) else (
  echo 注册失败，请检查 schtasks 输出
)
pause
