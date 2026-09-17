@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 node。请先安装 Node.js 并确保在 PATH 里。
  pause
  exit /b 1
)
echo 启动本机 Grok Bot 助手。保持这个窗口开着，再打开网关后台点「从本机 Grok Bot 导入」。
echo.
node scripts\import-local-grok-bot.mjs %*
if errorlevel 1 pause
