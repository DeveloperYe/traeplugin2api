# trae2api 保活启动脚本 —— 目录全自适应：不管整个文件夹放到哪里都能自己找对路径
#
# 自适应规则（无需改任何配置）：
#   网关目录   = 本脚本所在目录
#   运行时根   = ① 环境变量 TRAE2API_ROOT
#                ② 本目录 deploy.json 的 root（存在就用，兼容手工配置）
#                ③ 本目录 runtime\          （自举部署的默认位置）
#                ④ 本目录 runtime-root\
#                ⑤ 本目录 .runtime\
#                ⑥ 都没有 → 用 本目录\runtime\ 并自动创建
#   VSIX 搜索  = 本目录\vsix → 本目录\extensions → 本目录 → <root>\vsix → <root>\extensions → <root>
#   端口       = 环境变量 PORT → deploy.json.port → 18790
#
# 诊断：pwsh -File start-trae2api.ps1 -ResolveOnly   # 只打印解析结果，不启动

param([switch]$ResolveOnly, [switch]$NoRuntime)

$here = Split-Path -Parent $PSCommandPath

function Test-RuntimeRoot([string]$p) {
  if (-not $p) { return $false }
  return (Test-Path (Join-Path $p 'run-aiserver.cmd')) -or (Test-Path (Join-Path $p 'supervise.ps1')) -or (Test-Path (Join-Path $p 'aha'))
}

$cfgPath = Join-Path $here 'deploy.json'
$cfg = $null
if (Test-Path $cfgPath) { try { $cfg = Get-Content $cfgPath -Raw -Encoding utf8 | ConvertFrom-Json } catch {} }

# ---------- 运行时根：自适应 ----------
$root = ''
$rootFrom = ''
if ($env:TRAE2API_ROOT -and (Test-RuntimeRoot $env:TRAE2API_ROOT)) {
  $root = $env:TRAE2API_ROOT; $rootFrom = '环境变量 TRAE2API_ROOT'
} elseif ($cfg -and $cfg.root -and (Test-RuntimeRoot $cfg.root)) {
  $root = $cfg.root; $rootFrom = 'deploy.json'
} else {
  foreach ($cand in @(
      (Join-Path $here 'runtime'),
      (Join-Path $here 'runtime-root'),
      (Join-Path $here '.runtime')
    )) {
    if (Test-RuntimeRoot $cand) { $root = $cand; $rootFrom = '自动探测（已有部署）'; break }
  }
}
if (-not $root) {
  $root = Join-Path $here 'runtime'
  $rootFrom = '默认（首次部署，将自动创建）'
}

$port = if ($env:PORT) { $env:PORT } elseif ($cfg -and $cfg.port) { "$($cfg.port)" } else { '18790' }
$stateFile = Join-Path $root 'runtime\.deployed.json'
if (-not (Test-Path $stateFile)) { $stateFile = Join-Path $root '.deployed.json' }
$ahaDir = if (Test-Path $stateFile) { Join-Path $root 'runtime\aha\aha' } else { Join-Path $root 'aha\aha' }
if (-not (Test-Path $ahaDir) -and (Test-Path (Join-Path $root 'aha\aha'))) { $ahaDir = Join-Path $root 'aha\aha' }

if ($ResolveOnly) {
  Write-Host "网关目录   : $here"
  Write-Host "运行时根   : $root   （来源：$rootFrom）"
  Write-Host "端口       : $port"
  Write-Host "aha 目录   : $ahaDir  （存在：$(Test-Path $ahaDir)）"
  $vsixDirs = @((Join-Path $here 'vsix'), (Join-Path $here 'extensions'), $here, (Join-Path $root 'vsix'), (Join-Path $root 'extensions'), $root) | Select-Object -Unique
  $found = $null
  foreach ($d in $vsixDirs) { if (Test-Path $d) { $f = Get-ChildItem $d -Filter *.vsix -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($f) { $found = $f; break } } }
  Write-Host "VSIX       : $(if ($found) { $found.FullName } else { '(未发现)' })"
  exit 0
}

# ---------- 首跑时把解析结果落盘（只写一次，方便排查；以后自动跟随目录） ----------
if (-not (Test-Path $cfgPath)) {
  @{ root = $root; port = [int]$port; auto = $true; resolvedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Out-File -FilePath $cfgPath -Encoding utf8
}

$exe = 'C:\Program Files\nodejs\node.exe'
$app = Join-Path $here 'server.cjs'
$log = Join-Path $here 'data\trae2api.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
$env:PORT = $port
$env:HOST = if ($env:HOST) { $env:HOST } else { '0.0.0.0' }

# ---------- 运行时自举：VSIX 放进来就自动解包 ----------
$bootstrap = Join-Path $here 'deploy\bootstrap-runtime.ps1'
if (Test-Path $bootstrap) {
  try {
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $bootstrap -Root $root *>> $log
  } catch {
    "$(Get-Date -Format o) bootstrap error: $_" | Out-File -Append -FilePath $log -Encoding utf8
  }
}

# ---------- 运行时若没在跑就拉起来（自定义布局最常见：只起了网关，运行时根在别处） ----------
if (-not $NoRuntime) {
  $starter = Join-Path $here 'start-runtime.ps1'
  if (Test-Path $starter) {
    try {
      $live = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'aiServerMainV2' -and $_.CommandLine -like "*$root*" })
      if ($live.Count -eq 0) {
        "$(Get-Date -Format o) 运行时未运行，自动启动（root=$root）" | Out-File -Append -FilePath $log -Encoding utf8
        & pwsh -NoProfile -ExecutionPolicy Bypass -File $starter -Root $root -Port ([int]$port) -Wait 45 *>> $log
      } else {
        "$(Get-Date -Format o) 运行时已在跑（pid $($live[0].ProcessId)），不重复启动" | Out-File -Append -FilePath $log -Encoding utf8
      }
    } catch {
      "$(Get-Date -Format o) 自动启动运行时失败（不影响网关，稍后可在面板重试）: $_" | Out-File -Append -FilePath $log -Encoding utf8
    }
  }
}

$env:TRAE2API_AHA_DIR = $ahaDir
$env:TRAE2API_AHA_PREFIX = 'vscode_ai_agent_'
$env:TRAE2API_AGENT_PREF = 'extension'

while ($true) {
  try {
    & $exe $app *>> $log
    $code = $LASTEXITCODE
  } catch {
    "$(Get-Date -Format o) launch error: $_" | Out-File -Append -FilePath $log -Encoding utf8
    $code = -1
  }
  # 退出码 2 = 配置错误（没设口令），重试没意义，直接停下并说清楚
  if ($code -eq 2) {
    "$(Get-Date -Format o) 启动中止：未设置面板口令，已停止重试。请按 data/trae2api.log 里的提示填好 data/config.json 后重启计划任务。" |
      Out-File -Append -FilePath $log -Encoding utf8
    break
  }
  Start-Sleep -Seconds 5
}
