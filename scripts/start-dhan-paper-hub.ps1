param(
  [string]$RepoRoot = "D:\Claude\workstation\services\scalper",
  [string]$EnvPath = "D:\Claude\workstation\secrets\dhan\.env",
  [switch]$SkipBuild,
  [switch]$SkipLaunchWindow
)

$ErrorActionPreference = "Stop"

function Write-LaunchLog {
  param([string]$Message)
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $script:LogPath -Value "[$stamp] $Message"
}

function Wait-UntilLaunchTime {
  param(
    [int]$TargetHour,
    [int]$TargetMinute
  )

  $now = Get-Date
  $target = Get-Date -Hour $TargetHour -Minute $TargetMinute -Second 0
  if ($now -ge $target) {
    Write-LaunchLog "Launch window already reached ($($target.ToString('HH:mm')) IST)."
    return
  }

  $delay = [int][Math]::Ceiling(($target - $now).TotalSeconds)
  if ($delay -gt 0) {
    Write-LaunchLog "Waiting $delay seconds until $($target.ToString('HH:mm')) IST."
    Start-Sleep -Seconds $delay
  }
}

$logDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$script:LogPath = Join-Path $logDir ("dhan-paper-hub-launch-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

Write-LaunchLog "Starting Dhan Market Data Tick Hub launch."
Write-LaunchLog "RepoRoot=$RepoRoot"
Write-LaunchLog "EnvPath=$EnvPath"

if (-not (Test-Path -LiteralPath $RepoRoot)) {
  throw "Repo root not found: $RepoRoot"
}

if (-not (Test-Path -LiteralPath $EnvPath)) {
  throw "Dhan env file not found: $EnvPath"
}

$envText = Get-Content -Raw -LiteralPath $EnvPath
$totpMode = ($env:DHAN_CLIENT_ID -and $env:DHAN_PIN -and $env:DHAN_TOTP_SECRET)
$requiredKeys = if ($totpMode) { @("DHAN_CLIENT_ID", "DHAN_SCRIP_MASTER_PATH") } else { @("DHAN_CLIENT_ID", "DHAN_ACCESS_TOKEN", "DHAN_SCRIP_MASTER_PATH") }
foreach ($key in $requiredKeys) {
  if ($envText -notmatch "(?m)^\s*(export\s+)?$key\s*=\s*\S+") {
    throw "$key is missing or blank in $EnvPath"
  }
}

if ($totpMode) {
  $tokenDeadline = (Get-Date).AddMinutes(3)
  while ($envText -notmatch "(?m)^\s*(export\s+)?DHAN_ACCESS_TOKEN\s*=\s*\S+") {
    if ((Get-Date) -ge $tokenDeadline) {
      throw "DHAN_ACCESS_TOKEN still not written to $EnvPath after 3 minutes - check TOTP config or restart the dashboard."
    }
    Write-LaunchLog "DHAN_ACCESS_TOKEN not yet in $EnvPath; waiting 10s for dashboard TOTP mint..."
    Start-Sleep -Seconds 10
    $envText = Get-Content -Raw -LiteralPath $EnvPath
  }
}

$env:DHAN_ENV_PATH = $EnvPath
$env:HUB_PORT = "8795"

# Refuse overlapping Hub launches on port 8795
$existingHub = @(Get-NetTCPConnection -LocalPort 8795 -State Listen -ErrorAction SilentlyContinue)
if ($existingHub.Count -gt 0) {
  $owners = ($existingHub | Select-Object -ExpandProperty OwningProcess -Unique) -join ","
  Write-LaunchLog "Feed Hub port 8795 is already listening (PID $owners); refusing overlapping launch."
  throw "Feed Hub port 8795 is already in use by PID $owners. Stop the existing Hub runner before launching another."
}

if ($SkipLaunchWindow) {
  Write-LaunchLog "Skipping launch-window wait."
} else {
  Wait-UntilLaunchTime -TargetHour 8 -TargetMinute 55
}

Write-LaunchLog "Archiving scrip master snapshot..."
try {
  $archiveOut = & node (Join-Path $RepoRoot "scripts\archive-scrip-master.mjs") 2>&1
  foreach ($line in $archiveOut) { Write-LaunchLog $line }
} catch {
  Write-LaunchLog "WARN: scrip-master archive failed: $_"
}

Write-LaunchLog "Starting compiled Feed Hub runner (SkipBuild=$SkipBuild)."

Set-Location -LiteralPath $RepoRoot
$ErrorActionPreference = "Continue"

$restartCount = 0
while ($true) {
  $nowIst = (Get-Date).ToUniversalTime().AddMinutes(330)
  $cutoffToday = (Get-Date -Year $nowIst.Year -Month $nowIst.Month -Day $nowIst.Day -Hour 15 -Minute 40 -Second 0).ToUniversalTime().AddMinutes(-330)
  if ((Get-Date) -ge $cutoffToday) {
    Write-LaunchLog "Past 15:40 IST — not restarting Hub."
    break
  }
  if ($restartCount -gt 0) {
    Write-LaunchLog "Restart #$restartCount — Hub process exited before 15:40 IST. Waiting 10s before relaunch."
    Start-Sleep -Seconds 10
    $envText = Get-Content -Raw -LiteralPath $EnvPath
  }
  $restartCount++
  Write-LaunchLog "Launching Hub node process (attempt $restartCount)."
  if ($SkipBuild) {
    node core\dist\hub\server.js *>&1 | Tee-Object -FilePath $script:LogPath -Append
  } else {
    npm run build -w @scalper/core *>&1 | Tee-Object -FilePath $script:LogPath -Append
    $SkipBuild = $true
    node core\dist\hub\server.js *>&1 | Tee-Object -FilePath $script:LogPath -Append
  }
  $nowIst = (Get-Date).ToUniversalTime().AddMinutes(330)
  Write-LaunchLog "Hub node process exited at $($nowIst.ToString('HH:mm')) IST."
}
