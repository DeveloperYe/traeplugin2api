# 重启 trae2api（优雅版）
# 1) 先 POST /api/shutdown，让网关给在途流式响应补 finish + [DONE] 后再退出
# 2) 等端口真正释放；3) 仍被占则强杀；4) 交给计划任务拉起；5) 等健康检查通过
$ErrorActionPreference = 'Continue'
# 端口与任务名优先读同目录 deploy.json（setup.ps1 生成），否则用默认值
$cfgPath = Join-Path (Split-Path -Parent $PSCommandPath) 'deploy.json'
$cfg = $null
if (Test-Path $cfgPath) { try { $cfg = Get-Content $cfgPath -Raw -Encoding utf8 | ConvertFrom-Json } catch {} }
$Port = if ($env:PORT) { [int]$env:PORT } elseif ($cfg -and $cfg.port) { [int]$cfg.port } else { 18790 }
$TaskName = if ($cfg -and $cfg.taskName) { $cfg.taskName } else { 'trae2api' }

function Test-Port {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

if (Test-Port) {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/shutdown" -Method Post -TimeoutSec 5
        Write-Host "[1] 已请求优雅停机（在途流 $($r.draining) 个）"
    } catch {
        Write-Host "[1] 优雅停机接口不可用（$($_.Exception.Message)），将直接强杀"
    }
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 400
        if (-not (Test-Port)) { Write-Host "[2] 端口已释放（$(($i + 1) * 400)ms）"; break }
    }
}

if (Test-Port) {
    $owning = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($op in $owning) {
        $p = Get-Process -Id $op -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'node') {
            Stop-Process -Id $op -Force
            Write-Host "[3] 强制停止 pid=$op"
        } elseif ($p) {
            Write-Host "[!] 端口 $Port 被非 node 进程占用：pid=$op ($($p.ProcessName))，未处理"
        }
    }
    Start-Sleep -Seconds 2
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Start-ScheduledTask -TaskName $TaskName
Write-Host "[4] 已通过计划任务拉起（$TaskName）"

for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 600
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
        if ($h.ok) {
            Write-Host "[5] 健康检查通过: connected=$($h.connected) version=$($h.version)"
            exit 0
        }
    } catch { }
}
Write-Host '[!] 健康检查超时，请查看 data/trae2api.log'
exit 1
