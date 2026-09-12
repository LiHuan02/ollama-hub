# UTF-8 PowerShell configuration script. Called by the ASCII-only enable_extension_cors.bat.
$ErrorActionPreference = 'Stop'

function Pause-And-Exit([int] $Code) {
    Write-Host ''
    Read-Host '按 Enter 关闭窗口' | Out-Null
    exit $Code
}

try {
    Write-Host ''
    Write-Host '  Ollama Hub 浏览器扩展连接配置' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  将为当前 Windows 用户写入：'
    Write-Host '    OLLAMA_ORIGINS=chrome-extension://*' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  作用：允许 Chrome / Edge 扩展直接访问本机 Ollama，修复 HTTP 403。'
    Write-Host '  设置会在电脑重启后长期保留。'
    Write-Host ''
    $answer = Read-Host '确认写入吗？输入 Y 继续，其他任意输入取消'
    if ($answer -notmatch '^[Yy]$') {
        Write-Host '  已取消，未修改任何设置。' -ForegroundColor DarkYellow
        Pause-And-Exit 0
    }

    [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', 'chrome-extension://*', 'User')
    $saved = [Environment]::GetEnvironmentVariable('OLLAMA_ORIGINS', 'User')
    if ($saved -ne 'chrome-extension://*') { throw "写入后验证失败，当前值：$saved" }

    Write-Host ''
    Write-Host '  [完成] 已写入 OLLAMA_ORIGINS。' -ForegroundColor Green
    Write-Host ''
    Write-Host '  接下来必须做两步：' -ForegroundColor Yellow
    Write-Host '  1. 在系统托盘右键 Ollama，选择“退出”；'
    Write-Host '  2. 重新打开 Ollama，或重启电脑。'
    Write-Host ''
    Write-Host '  然后到 chrome://extensions 或 edge://extensions 刷新 Ollama Hub 扩展。'
    Pause-And-Exit 0
}
catch {
    Write-Host ''
    Write-Host '  [配置失败] ' -ForegroundColor Red -NoNewline
    Write-Host $_.Exception.Message -ForegroundColor Red
    Pause-And-Exit 1
}
