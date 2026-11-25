# 启动/接管运行时（aiserver + ai-agent），并等到网关 connected:true
#
# 适用：自定义布局（网关在 A，运行时根在 B）下，运行时没起来、面板显示「IPC 断开 / 套接字 —」。
#
# 用法：
#   pwsh -NoProfile -File start-runtime.ps1                        # 自动找运行时根并后台起看护
#   pwsh -NoProfile -File start-runtime.ps1 -Root D:\apps\trae2api-runtime
#   pwsh -NoProfile -File start-runtime.ps1 -Foreground            # 前台跑看护（能直接看日志）
#   pwsh -NoProfile -File start-runtime.ps1 -Wait 120              # 等 socket 的最长秒数
#
# 做的事：定位运行时根 → 确认没有第二个实例 → 起 supervise.ps1 → 等 aha socket → 探网关 /healthz
# 安全：只启动一个看护（避免双 aiserver 互抢，这是已知最难排查的故障）
param(
  [string]$Root = '',
  [int]$Port = 0,
  [int]$Wait = 90,
  [switch]$Foreground,
  [switch]$Restart,
  [int]$WatchInterval = 5,
  [switch]$LegacySupervise
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $PSCommandPath

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }

# ---------- 1) 定位运行时根 ----------
function Has-Runtime([string]$p) {
  if (-not $p) { return $false }
  return (Test-Path (Join-Path $p 'run-aiserver.cmd')) -or
         (Test-Path (Join-Path $p 'supervise.ps1')) -or
         (Test-Path (Join-Path $p 'aha'))
}
if (-not $Root) {
  $cfgPath = Join-Path $here 'deploy.json'
  if (Test-Path $cfgPath) {
    try { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { $cfg = $null }
    if ($cfg -and $cfg.root) { $Root = $cfg.root }
    if (-not $Port -and $cfg -and $cfg.port) { $Port = [int]$cfg.port }
  }
}
if (-not $Root -and $env:TRAE2API_ROOT) { $Root = $env:TRAE2API_ROOT }
if (-not $Root) {
  foreach ($cand in @((Join-Path $here 'runtime'), (Join-Path $here 'runtime-root'), (Join-Path $here '.runtime'))) {
    if (Has-Runtime $cand) { $Root = $cand; break }
  }
}
if (-not $Root) { $Root = Join-Path $here 'runtime' }
$Root = [System.IO.Path]::GetFullPath($Root)
if (-not $Port) { $Port = 18790 }

# 安装器把脚本放在 <Root>\runtime\，也允许直接放在 <Root>\
$dest = if (Test-Path (Join-Path $Root 'runtime\run-aiserver.cmd')) { Join-Path $Root 'runtime' } else { $Root }
$ahaDir = Join-Path $dest 'aha\aha'
$super = Join-Path $dest 'supervise.ps1'
$runner = Join-Path $dest 'run-aiserver.cmd'

Say "运行时根 : $Root"
Say "脚本目录 : $dest"
Say "aha 目录 : $ahaDir"
Say "网关端口 : $Port"

if (-not (Test-Path $runner)) {
  Say "❌ 找不到 $runner —— 运行时还没部署。先把 VSIX 放进 <Root>\vsix，再跑 deploy\bootstrap-runtime.ps1（或 setup.ps1）。" 'Red'
  exit 1
}

# ---------- 2) 已有实例就只等，不重复起 ----------
function Get-Running([string]$needle) {
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'aiServerMainV2' -and $_.CommandLine -like "*$needle*" })
  } catch { return @() }
}
# -Restart：先杀掉现存 aiserver（以及残留 ai-agent），再让看护器重建整条链路。
# 用于 AHA 链路挂死（握手成功但 model/model_list 永远超时）。
if ($Restart) {
  $kill = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'aiServerMainV2' -and $_.CommandLine -like "*$dest*" })
  $agents = @(Get-Process -Name 'ai-agent' -ErrorAction SilentlyContinue)
  if ($kill.Count -or $agents.Count) {
    Say ("-Restart：停止 aiserver " + $kill.Count + " 个 / ai-agent " + $agents.Count + " 个") 'Yellow'
    foreach ($p in $kill) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Say ("  已停 aiserver pid " + $p.ProcessId) 'DarkGray' } catch {} }
    foreach ($p in $agents) { try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; Say ("  已停 ai-agent pid " + $p.Id) 'DarkGray' } catch {} }
    Start-Sleep -Seconds 3
  } else { Say "-Restart：没有找到运行中的 aiserver/ai-agent" 'DarkGray' }
}

$running = Get-Running $dest
if ($running.Count -gt 0) {
  Say "已有一个运行时在跑（pid $($running[0].ProcessId)），不会再起第二个" 'Yellow'
} else {
  # 也检查 aha 目录不同但同类实例（双实例是最难查的故障，先拦一下）
  $others = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'aiServerMainV2' })
  if ($others.Count -gt 0) {
    Say "⚠ 检测到 $($others.Count) 个别的 aiserver 实例（可能属于其它部署），继续前请确认没有双跑：" 'Yellow'
    $others | ForEach-Object { Say ("    pid {0}  {1}" -f $_.ProcessId, $_.CommandLine.Substring(0, [Math]::Min(120, $_.CommandLine.Length))) 'DarkGray' }
  }

  if ($Foreground) {
    Say "前台启动 run-aiserver.cmd（Ctrl+C 结束）…" 'Cyan'
    & $runner
    exit $LASTEXITCODE
  }

  $watcher = Join-Path $here 'deploy\watch-runtime.cjs'
  if ((Test-Path $watcher) -and -not $LegacySupervise) {
    # 短周期看护：5s 一轮，崩了立刻拉起并自动预热；进程活着但链路挂死时让网关自愈
    Say "后台启动常驻看护：node watch-runtime.cjs --dest $dest --interval $WatchInterval" 'Cyan'
    Start-Process node -ArgumentList @($watcher, '--dest', $dest, '--interval', "$WatchInterval") -WindowStyle Hidden
  } elseif (Test-Path $super) {
    Say "后台启动看护器（旧版 15s）：$super" 'Cyan'
    Start-Process pwsh -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $super -WindowStyle Hidden
  } else {
    Say "没有 supervise.ps1，改为直接后台起 run-aiserver.cmd" 'Yellow'
    Start-Process cmd.exe -ArgumentList '/c', $runner -WindowStyle Hidden
  }
}

# ---------- 3) 等 socket 出现 ----------
Say "等待 aha socket（最长 $Wait 秒）…" 'Cyan'
$sock = $null
for ($i = 0; $i -lt $Wait; $i++) {
  if (Test-Path $ahaDir) {
    $socks = @(Get-ChildItem $ahaDir -Filter 'vscode_ai_agent_*.sock' -ErrorAction SilentlyContinue)
    foreach ($s in $socks) {
      $ready = "$($s.FullName).ready"
      if (Test-Path $ready) {
        $agentPid = 0
        try { $agentPid = [int](Get-Content $ready -Raw).Trim() } catch {}
        if ($agentPid -and (Get-Process -Id $agentPid -ErrorAction SilentlyContinue)) { $sock = $s; break }
      }
    }
    if ($sock) { break }
  }
  Start-Sleep -Seconds 1
}

if ($sock) {
  Say "✅ socket 已就绪：$($sock.Name)" 'Green'
} else {
  Say "❌ $Wait 秒内没等到 socket。排查：" 'Red'
  Say "   1) 前台跑一次看错误： pwsh -NoProfile -File `"$PSCommandPath`" -Foreground" 'Yellow'
  Say "   2) 看运行时日志： $dest\logs\aiserver.log 与 supervise.log" 'Yellow'
  Say "   3) 看 aha 目录是否被生成： $ahaDir" 'Yellow'
  exit 2
}

# ---------- 4) 探网关 ----------
Say "探测网关 http://127.0.0.1:$Port/healthz …" 'Cyan'
for ($i = 0; $i -lt 60; $i++) {
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
    if ($h.connected) {
      Say "✅ 网关已连上运行时：connected=true version=$($h.version)" 'Green'
      Say "接下来可以在面板「凭据」页登录；没有自带浏览器内核时可用系统 Edge/Chrome。" 'DarkGray'
      exit 0
    }
  } catch {}
  Start-Sleep -Seconds 1
}
Say "⚠ socket 有了，但网关 60 秒内仍 connected:false" 'Yellow'
Say "   多半是网关的 AHA 目录不是 $ahaDir —— 看 data\trae2api.log 里的 [boot] AHA 目录 一行，" 'Yellow'
Say "   或把 deploy.json 的 root 指到 $Root 后重启网关。" 'Yellow'
exit 3
