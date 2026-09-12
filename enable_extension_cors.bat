@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0enable_extension_cors.ps1"
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
