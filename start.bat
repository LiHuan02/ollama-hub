@echo off
chcp 65001 >nul
title Ollama Hub
cd /d "%~dp0"

rem 检查 Node.js 是否可用
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

node ollama_hub.mjs %*
pause
