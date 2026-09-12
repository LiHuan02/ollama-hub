@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Ollama Hub - 浏览器扩展连接配置

echo.
echo  Ollama Hub 浏览器扩展连接配置

echo  此操作会为当前 Windows 用户写入：
echo    OLLAMA_ORIGINS=chrome-extension://*
echo.
echo  作用：允许 Chrome / Edge 扩展直接访问本机 Ollama，修复详情和拉取时的 HTTP 403。
echo  该设置会在电脑重启后继续保留。
echo.
choice /C YN /N /M "确认写入环境变量吗? [Y/N]"
if errorlevel 2 goto :cancel

setx OLLAMA_ORIGINS "chrome-extension://*" >nul
if errorlevel 1 (
  echo.
  echo [错误] 无法写入环境变量。请以当前用户权限重新运行此脚本。
  pause
  exit /b 1
)

echo.
echo [完成] 已写入 OLLAMA_ORIGINS。
echo.
echo 接下来必须做两步：
echo  1. 在系统托盘右键 Ollama，选择“退出”；
echo  2. 重新打开 Ollama（或重启电脑）。
echo.
echo 然后到 chrome://extensions 或 edge://extensions 刷新 Ollama Hub 扩展。
pause
exit /b 0

:cancel
echo.
echo 已取消，未修改任何设置。
pause
exit /b 0
