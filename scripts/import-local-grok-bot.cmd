@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 node。请先安装 Node.js 并确保在 PATH 里。
  pause
  exit /b 1
)
echo 正在从本机 Grok Bot 读取 token...
node "%~dp0import-local-grok-bot.mjs"
echo.
pause
