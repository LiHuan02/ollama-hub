# UTF-8 PowerShell launcher for Ollama Hub. Called by the ASCII-only start.bat.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

function Pause-And-Exit([int] $Code) {
    Write-Host ''
    Read-Host '按 Enter 关闭窗口' | Out-Null
    exit $Code
}

try {
    $node = Get-Command node -ErrorAction Stop
    $versionText = (& node --version 2>&1 | Out-String).Trim()
    if ($versionText -notmatch '^v?(\d+)') { throw "无法读取 Node.js 版本：$versionText" }
    if ([int]$Matches[1] -lt 18) { throw "需要 Node.js 18 或更高版本，当前版本：$versionText" }

    Write-Host ''
    Write-Host '  Ollama Hub 正在启动...' -ForegroundColor Cyan
    Write-Host '  浏览器将自动打开；若没有打开，请查看下方显示的网址。' -ForegroundColor DarkGray
    Write-Host ''

    # Do not hide this process: it is the server log and makes startup failures visible.
    & node .\ollama_hub.mjs @args
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "Ollama Hub 已退出，退出码：$code" }
}
catch {
    Write-Host ''
    Write-Host '  [启动失败] ' -ForegroundColor Red -NoNewline
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host '  请确认 Ollama Hub 文件完整、Node.js 18+ 已安装。' -ForegroundColor Yellow
    Pause-And-Exit 1
}
