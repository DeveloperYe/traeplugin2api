# 运行时自举：把 VSIX 放进 <Root>\vsix（或 <Root>\extensions、或 <Root> 根）后，
# 本脚本在网关启动时自动检测、自动解包部署、自动接管为生产运行时。
#
# 用法：
#   pwsh -NoProfile -File deploy\bootstrap-runtime.ps1                # 自动检测（幂等，已部署则秒退）
#   pwsh -NoProfile -File deploy\bootstrap-runtime.ps1 -Force         # 强制重装
#   pwsh -NoProfile -File deploy\bootstrap-runtime.ps1 -VsixDir D:\x  # 指定 vsix 目录
#   pwsh -NoProfile -File deploy\bootstrap-runtime.ps1 -NoBrowser     # 不下载自带浏览器内核
#
# 部署产物：<Dest>\aiserver、<Dest>\profile\.trae-runtime、<Dest>\run-aiserver.cmd、<Dest>\supervise.ps1
# 状态文件：<Dest>\.deployed.json（记录 vsix 的 sha256 / 大小 / 版本，用于跳过重复部署）

param(
  [string]$Root = '',
  [string]$VsixDir = '',
  [string]$Dest = '',
  [switch]$Force,
  [switch]$Quiet,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$node = 'C:\Program Files\nodejs\node.exe'
$repo = Split-Path -Parent $PSScriptRoot        # deploy 的上级 = 网关目录

# 运行时根自适应：不传 -Root 时自己找（与 start-trae2api.ps1 同一套规则）
function Test-Root([string]$p) {
  if (-not $p) { return $false }
  return (Test-Path (Join-Path $p 'run-aiserver.cmd')) -or (Test-Path (Join-Path $p 'supervise.ps1')) -or (Test-Path (Join-Path $p 'aha'))
}
if (-not $Root) {
  foreach ($cand in @((Join-Path $repo 'runtime'), (Join-Path $repo 'runtime-root'), (Join-Path $repo '.runtime'))) {
    if (Test-Root $cand) { $Root = $cand; break }
  }
  if (-not $Root) { $Root = Join-Path $repo 'runtime' }
}
$installer = Join-Path $repo 'deploy\install-from-vsix.cjs'
if (-not $Dest) { $Dest = Join-Path $Root 'runtime' }
$stateFile = Join-Path $Dest '.deployed.json'
$logDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'bootstrap.log'

function Say([string]$msg, [string]$color = 'Gray') {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  if (-not $Quiet) { Write-Host $line -ForegroundColor $color }
  $line | Out-File -Append -FilePath $logFile -Encoding utf8
}

# ---------- 1) 找 vsix ----------
$candidates = @()
if ($VsixDir) { $candidates += $VsixDir }
$candidates += @(
  (Join-Path $repo 'vsix'),
  (Join-Path $repo 'extensions'),
  $repo,
  (Join-Path $Root 'vsix'),
  (Join-Path $Root 'extensions'),
  $Root
) | Select-Object -Unique

$vsix = $null
foreach ($d in $candidates) {
  if (-not (Test-Path $d)) { continue }
  $f = Get-ChildItem $d -Filter *.vsix -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) { $vsix = $f; break }
}

if (-not $vsix) {
  Say "未发现 VSIX（已查：$($candidates -join ' | ')），跳过自举" 'DarkGray'
  exit 0
}

$sha = (Get-FileHash $vsix.FullName -Algorithm SHA256).Hash.ToLower()
$sizeMB = [math]::Round($vsix.Length / 1MB, 1)
Say "发现 VSIX：$($vsix.Name)（$sizeMB MB，sha256 ${sha}）" 'Cyan'

# ---------- 2) 已部署就秒退 ----------
if (-not $Force -and (Test-Path $stateFile) -and (Test-Path (Join-Path $Dest 'run-aiserver.cmd'))) {
  try {
    $st = Get-Content $stateFile -Raw -Encoding utf8 | ConvertFrom-Json
    if ($st.sha256 -eq $sha -and $st.dest -eq $Dest) {
      Say "已是该 VSIX 部署的运行时（version=$($st.version)），跳过" 'DarkGray'
      exit 0
    }
    Say "VSIX 有变化（旧 sha256=$($st.sha256.Substring(0,12))…），准备重新部署" 'Yellow'
  } catch { Say "状态文件损坏，重新部署" 'Yellow' }
}

# ---------- 3) 停旧运行时（先停看护器，避免边部署边拉起） ----------
function Stop-Runtime {
  $sups = Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*supervise.ps1*' -and $_.CommandLine -like "*$Root*" }
  foreach ($p in $sups) { try { Invoke-CimMethod -InputObject $p -MethodName Terminate | Out-Null; Say "已停看护器 pid=$($p.ProcessId)" } catch {} }
  $srvs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*aiServerMainV2.js*' -and ($_.CommandLine -like "*$Root*" -or $_.CommandLine -like "*$Dest*") -and $_.CommandLine -notlike '*NonInteractive*' }
  foreach ($p in $srvs) { try { Invoke-CimMethod -InputObject $p -MethodName Terminate | Out-Null; Say "已停 aiserver pid=$($p.ProcessId)" } catch {} }
  Start-Sleep -Seconds 2
}

Say "停止旧运行时…" 'Yellow'
Stop-Runtime

# ---------- 4) 解包部署 ----------
Say "开始部署到 $Dest（这一步会解 7z，几分钟）…" 'Cyan'
$t0 = Get-Date
$deployOk = $false
try {
  & $node $installer --vsix $vsix.FullName --dest $Dest 2>&1 | ForEach-Object {
    $line = "$_"
    if ($line.Trim()) { $line | Out-File -Append -FilePath $logFile -Encoding utf8; if (-not $Quiet) { Write-Host "  $line" } }
  }
  $deployOk = ($LASTEXITCODE -eq 0)
} catch {
  Say "部署异常：$($_.Exception.Message)" 'Red'
  $deployOk = $false
}

# 无论成败，都要把生产运行时拉回来（否则一次坏 vsix 会让网关彻底没通道）
function Restore-Runtime {
  foreach ($n in @('run-aiserver.cmd', 'supervise.ps1')) {
    $bak = Join-Path $Root "$n.bak-bootstrap"
    if ((-not $deployOk) -and (Test-Path $bak)) {
      Copy-Item $bak (Join-Path $Root $n) -Force
      Say "已回滚 $n（用备份）" 'Yellow'
    }
  }
  $sup = Join-Path $Root 'supervise.ps1'
  $running = Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*supervise.ps1*' -and $_.CommandLine -like "*$Root*" }
  if (-not $running -and (Test-Path $sup)) {
    Start-Process pwsh -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $sup -WindowStyle Hidden
    Say "已重新启动看护器：$sup" 'Green'
  }
}

if (-not $deployOk) {
  Say "❌ 部署失败（installer 退出码非 0），恢复原运行时" 'Red'
  Restore-Runtime
  exit 1
}
$span = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
Say "✅ 解包完成，用时 ${span}s" 'Green'

# ---------- 5) 凭据接力：把现有可用的 jwt/expire 复制进新 profile ----------
$profSrc = Join-Path $env:USERPROFILE '.marscode'
$profDst = Join-Path $Dest 'profile\.trae-runtime'
if ((Test-Path (Join-Path $profSrc 'jwt.txt')) -and (Test-Path $profDst)) {
  foreach ($n in @('jwt.txt', 'expire.txt')) {
    $s = Join-Path $profSrc $n; $t = Join-Path $profDst $n
    if (Test-Path $s) {
      $srcNewer = (-not (Test-Path $t)) -or ((Get-Item $s).LastWriteTime -gt (Get-Item $t).LastWriteTime)
      if ($srcNewer) { Copy-Item $s $t -Force; Say "凭据接力：$n ← $profSrc" }
    }
  }
}

# ---------- 6) 让生产壳指向新部署 ----------
foreach ($n in @('run-aiserver.cmd', 'supervise.ps1')) {
  $src = Join-Path $Dest $n
  $dst = Join-Path $Root $n
  if (Test-Path $src) {
    if (Test-Path $dst) { Copy-Item $dst "$dst.bak-bootstrap" -Force }
    Copy-Item $src $dst -Force
    Say "已更新 $dst（来自新部署）"
  } else { Say "⚠ 新部署里缺 $n" 'Yellow' }
}

# ---------- 6.5) 自带浏览器内核（面板登录用；只装一次，失败不阻塞网关） ----------
if (-not $NoBrowser) {
  $browserRoot = Join-Path $Dest 'browser'
  $found = $null
  try { $found = Get-ChildItem -Path $browserRoot -Recurse -Depth 3 -Filter 'chrome-headless-shell*' -ErrorAction SilentlyContinue | Select-Object -First 1 } catch {}
  if ($found) {
    Say "浏览器内核已存在，跳过：$($found.FullName)" 'DarkGray'
  } else {
    $fetcher = Join-Path $PSScriptRoot 'fetch-browser.cjs'
    if (Test-Path $fetcher) {
      Say '首次自举：下载自带浏览器内核（chrome-headless-shell，约 120 MB；面板登录用，失败自动回退系统浏览器）' 'Cyan'
      try {
        & $node $fetcher --dir $browserRoot 2>&1 | ForEach-Object { Say "  $_" 'DarkGray' }
        if ($LASTEXITCODE -eq 0) { Say '  内核就绪' 'Green' }
        else { Say '  ⚠ 内核未就绪（登录时会回退系统 Edge/Chrome；可稍后手动跑 deploy\fetch-browser.cjs）' 'Yellow' }
      } catch {
        Say "  ⚠ 下载失败（不影响网关运行）：$($_.Exception.Message)" 'Yellow'
      }
    }
  }
}

# ---------- 7) 写状态 + 起看护器 ----------
$ver = ''
try {
  $pkgTmp = Join-Path $Dest '.tmp-package.json'
  if (Test-Path $pkgTmp) { $ver = (Get-Content $pkgTmp -Raw | ConvertFrom-Json).version }
} catch {}
if (-not $ver) { $ver = 'unknown' }
@{ vsix = $vsix.FullName; sha256 = $sha; sizeMB = $sizeMB; version = $ver; dest = $Dest; deployedAt = (Get-Date).ToString('o') } |
  ConvertTo-Json | Out-File -FilePath $stateFile -Encoding utf8
Say "已写状态文件 $stateFile" 'DarkGray'

$sup = Join-Path $Root 'supervise.ps1'
if (Test-Path $sup) {
  Start-Process pwsh -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $sup -WindowStyle Hidden
  Say "已启动看护器：$sup" 'Green'
}

Say "✅ 自举完成。网关请使用 TRAE2API_AHA_DIR=$(Join-Path $Dest 'aha\aha')" 'Green'
Say "浏览器内核目录：$(Join-Path $Dest 'browser')（没有就用系统 Edge/Chrome 登录）" 'DarkGray'
exit 0
