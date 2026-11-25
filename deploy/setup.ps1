# 一键部署/迁移到自定义目录
#
# 用法：
#   # 就地部署（把当前仓库当部署目录，运行时根目录用默认 <Dir>\runtime-root）
#   pwsh -NoProfile -File deploy\setup.ps1
#
#   # 部署到自定义目录
#   pwsh -NoProfile -File deploy\setup.ps1 -Dir D:\apps\trae2api -Root D:\apps\trae2api-runtime -Port 18791
#
#   # 顺带把已下载的 VSIX 一并放进去并完成自举解包
#   pwsh -NoProfile -File deploy\setup.ps1 -Dir D:\apps\trae2api -VsixPath D:\downloads\marscode.vsix
#
#   # 只看计划，不动手
#   pwsh -NoProfile -File deploy\setup.ps1 -Dir D:\apps\trae2api -DryRun
#
# 做的事：复制网关 → 写 deploy.json（端口/运行时根）→ 放 VSIX 到 <Root>\vsix →
#        跑 bootstrap-runtime.ps1 解包部署 → 注册计划任务（开机+登录触发）→ 启动并健康检查

param(
  [string]$Dir = '',
  [string]$Root = '',
  [int]$Port = 18790,
  [string]$VsixPath = '',
  [string]$TaskName = 'trae2api',
  [switch]$DryRun,
  [switch]$NoTask,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Dir) { $Dir = $repo }
$Dir = [System.IO.Path]::GetFullPath($Dir)
if (-not $Root) { $Root = Join-Path $Dir 'runtime-root' }
$Root = [System.IO.Path]::GetFullPath($Root)

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }

Say "部署目录（网关）: $Dir"
Say "运行时根目录   : $Root"
Say "端口           : $Port"
Say "计划任务       : $TaskName"
if ($VsixPath) { Say "VSIX           : $VsixPath" }
if ($DryRun) { Say "（DryRun：只打印计划，不做任何改动）" 'Yellow'; exit 0 }

# ---------- 1) 复制网关文件到目标目录（同目录则跳过） ----------
$sameDir = ($Dir.TrimEnd('\') -ieq $repo.TrimEnd('\'))
if (-not $sameDir) {
  Say "复制网关文件到 $Dir …" 'Cyan'
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $excludeDirs = @('node_modules', '.git', 'data\trae-web', 'data\attachments')
  $excludeFiles = @('*.log', '*.bak*', '.tmp-*')
  & robocopy $repo $Dir /E /XD $excludeDirs /XF $excludeFiles /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（退出码 $LASTEXITCODE）" }
  Say "  已复制" 'Green'
} else {
  Say "网关已在目标目录，跳过复制" 'DarkGray'
}

# ---------- 2) 写 deploy.json ----------
$cfg = @{ root = $Root; port = $Port; taskName = $TaskName; deployedAt = (Get-Date).ToString('o') }
$cfg | ConvertTo-Json | Out-File -FilePath (Join-Path $Dir 'deploy.json') -Encoding utf8
Say "已写 $(Join-Path $Dir 'deploy.json')" 'Green'

# ---------- 3) 运行时目录与 VSIX ----------
$vsixDir = Join-Path $Root 'vsix'
New-Item -ItemType Directory -Force -Path $vsixDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
if ($VsixPath -and (Test-Path $VsixPath)) {
  Copy-Item $VsixPath $vsixDir -Force
  Say "已放入 VSIX → $vsixDir" 'Green'
} else {
  Say "未指定 VSIX；之后把 .vsix 放进 $vsixDir 再重启即可自动部署" 'DarkGray'
}

# ---------- 4) 自举（解包运行时） ----------
$bootstrap = Join-Path $Dir 'deploy\bootstrap-runtime.ps1'
if (Test-Path $bootstrap) {
  Say "运行自举（无 vsix 时会秒退）…" 'Cyan'
  & pwsh -NoProfile -ExecutionPolicy Bypass -File $bootstrap -Root $Root
  Say "  自举退出码: $LASTEXITCODE" 'DarkGray'
} else {
  Say "⚠ 找不到 bootstrap-runtime.ps1" 'Yellow'
}

# ---------- 5) 计划任务 ----------
if (-not $NoTask) {
  $startScript = Join-Path $Dir 'start-trae2api.ps1'
  Say "注册计划任务 $TaskName → $startScript" 'Cyan'
  $action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
  $trigger1 = New-ScheduledTaskTrigger -AtStartup
  # 身份用「当前用户 + S4U」而不是 SYSTEM：凭据来自该用户的
  # %APPDATA%\Code\User\globalStorage\state.vscdb 与 ~\.marscode，
  # SYSTEM 身份的 homedir / APPDATA 指向 systemprofile，读不到凭据。
  $currentUser = $null
  try { $currentUser = (Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).UserName } catch { }
  if (-not $currentUser) { $currentUser = $env:USERNAME }
  $isSystem = ($currentUser -match '\\SYSTEM$') -or ($currentUser -eq 'SYSTEM') -or (-not $currentUser)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  if ($isSystem) {
    Say "  ⚠ 当前身份是 SYSTEM，无法确定要使用哪个用户的凭据；退化为「仅开机触发 + SYSTEM」" 'Yellow'
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger1 -Principal $principal -Settings $settings -Force | Out-Null
  } else {
    $trigger2 = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType S4U -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigger1, $trigger2) -Principal $principal -Settings $settings -Force | Out-Null
    Say "  身份：$currentUser（S4U，开机 + 登录双触发）" 'DarkGray'
  }
  Start-ScheduledTask -TaskName $TaskName
  Say "  已注册并启动" 'Green'
}

# ---------- 5.5) 可选：自带浏览器内核（登录用；失败不阻塞，自动回退系统浏览器） ----------
if (-not $NoBrowser) {
  $fetcher = Join-Path $Dir 'deploy\fetch-browser.cjs'
  if (Test-Path $fetcher) {
    Say "准备自带浏览器内核（chrome-headless-shell，面板登录用；约 120 MB，可 -NoBrowser 跳过）…" 'Cyan'
    try {
      & node $fetcher --dir (Join-Path $Dir 'runtime\browser') 2>&1 | ForEach-Object { Say "  $_" 'DarkGray' }
      if ($LASTEXITCODE -eq 0) { Say '  内核就绪' 'Green' }
      else { Say '  ⚠ 内核未就绪（会自动回退系统 Edge/Chrome；也可稍后手动跑 deploy\fetch-browser.cjs）' 'Yellow' }
    } catch {
      Say "  ⚠ 下载失败（不影响使用，会自动回退系统浏览器）：$($_.Exception.Message)" 'Yellow'
    }
  }
}

# ---------- 6) 健康检查 ----------
if ($NoTask) {
  Say "已按 -NoTask 跳过计划任务；手动启动：pwsh -NoProfile -File `"$(Join-Path $Dir 'start-trae2api.ps1')`"" 'Yellow'
  exit 0
}
Say "等待健康检查 http://127.0.0.1:$Port/healthz …" 'Cyan'
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 800
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
    if ($h.ok) { Say "✅ 就绪: connected=$($h.connected) version=$($h.version)" 'Green'; exit 0 }
  } catch {}
}
Say "⚠ 健康检查超时，请查看 $(Join-Path $Dir 'data\trae2api.log')" 'Yellow'
exit 1
