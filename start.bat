@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Ollama Hub
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请安装 Node.js 18+：https://nodejs.org/
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node" 2^>nul') do set NODE_MAJOR=%%V
if not defined NODE_MAJOR (
  echo [错误] 无法读取 Node.js 版本。
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 18 (
  echo [错误] 当前 Node.js 版本过低，需要 18+，当前：
  node --version
  pause
  exit /b 1
)

rem 在当前窗口直接运行，双击时会保留可见日志和错误信息，不依赖 start 的窗口行为。
rem 服务会在启动成功后自动打开默认浏览器。
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%~dp0'; node .\ollama_hub.mjs"
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo [错误] Ollama Hub 已退出，退出码：%EXITCODE%
  echo 如果浏览器没有打开，请检查上方服务地址或运行 node ollama_hub.mjs 查看详情。
  pause
)
endlocal
