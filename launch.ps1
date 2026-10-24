$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$address = 'http://127.0.0.1:4189'
function Test-CareerServer {
    try {
        $reply = Invoke-RestMethod -Uri "$address/health" -TimeoutSec 2
        return $reply.app -eq 'career-agent'
    } catch { return $false }
}
try {
    if (-not (Test-CareerServer)) {
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        $nodePath = if ($nodeCommand) { $nodeCommand.Source } elseif (Test-Path -LiteralPath 'D:\Node\node.exe') { 'D:\Node\node.exe' } else { throw 'Node.js is missing. Install Node.js from nodejs.org.' }
        $logDir = Join-Path $taskRoot '.data'
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        $serverPath = Join-Path $taskRoot 'server.mjs'
        $worker = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $serverPath + '"')) -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server-error.log')
        $worker.Id | Set-Content -LiteralPath (Join-Path $logDir 'server.pid')
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if (Test-CareerServer) { $ready = $true; break }
            if ($worker.HasExited) { break }
            Start-Sleep -Milliseconds 300
        }
        if (-not $ready) { throw ('Server did not start. See ' + (Join-Path $logDir 'server-error.log')) }
    }
    Start-Process $address
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}
