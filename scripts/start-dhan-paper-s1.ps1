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
$script:LogPath = Join-Path $logDir ("dhan-paper-s1-launch-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

Write-LaunchLog "Starting S1 Dhan live-data paper launch."
Write-LaunchLog "RepoRoot=$RepoRoot"
Write-LaunchLog "EnvPath=$EnvPath"

if (-not (Test-Path -LiteralPath $RepoRoot)) {
  throw "Repo root not found: $RepoRoot"
}

if (-not (Test-Path -LiteralPath $EnvPath)) {
  throw "Dhan env file not found: $EnvPath"
}

$envText = Get-Content -Raw -LiteralPath $EnvPath
# When TOTP is configured the dashboard mints DHAN_ACCESS_TOKEN and writes it
# to this file. Skip that check if the three TOTP vars are already in process
# env (launcher inherits them via launch-dashboard.ps1 hydration).
$totpMode = ($env:DHAN_CLIENT_ID -and $env:DHAN_PIN -and $env:DHAN_TOTP_SECRET)
$requiredKeys = if ($totpMode) { @("DHAN_CLIENT_ID", "DHAN_SCRIP_MASTER_PATH") } else { @("DHAN_CLIENT_ID", "DHAN_ACCESS_TOKEN", "DHAN_SCRIP_MASTER_PATH") }
foreach ($key in $requiredKeys) {
  if ($envText -notmatch "(?m)^\s*(export\s+)?$key\s*=\s*\S+") {
    throw "$key is missing or blank in $EnvPath"
  }
}
# In TOTP mode wait up to 3 minutes for the dashboard to materialise the
# minted DHAN_ACCESS_TOKEN into the env file. Previous behaviour was an
# immediate throw (exit 1) that triggered a supervisor restart after 30s;
# on 2026-09-01 a transient file lock caused 180 consecutive failures over 3h.
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
$env:DHAN_STRATEGY_ID = "s1-momentum-burst"
$env:DHAN_GATEWAY_PORT = "8787"
$env:DHAN_JOURNAL_ROOT = "journals\s1-momentum-burst"
$env:DHAN_RECORDER_ROOT = "data\dhan\ticks-s1-momentum-burst"
$env:DHAN_AUTO_ARM = "true"

# Snapshot the scrip master before trading. Dhan purges expired contracts from
# the live file, so without a dated copy today's recording stops being
# replayable one expiry cycle from now. Idempotent; never fatal to the launch.
try {
  $archiveOut = & node (Join-Path $RepoRoot "scripts\archive-scrip-master.mjs") 2>&1
  foreach ($line in $archiveOut) { Write-LaunchLog $line }
} catch {
  Write-LaunchLog "WARN: scrip-master archive failed: $_"
}

Write-LaunchLog "Strategy forced to $env:DHAN_STRATEGY_ID."
Write-LaunchLog "Gateway port forced to $env:DHAN_GATEWAY_PORT."
Write-LaunchLog "Journal root forced to $env:DHAN_JOURNAL_ROOT."
Write-LaunchLog "Recorder root forced to $env:DHAN_RECORDER_ROOT."
Write-LaunchLog "Auto-arm forced to $env:DHAN_AUTO_ARM."

# Refuse overlapping S1 launches before touching the day's journal. The
# gateway's EADDRINUSE failure happens too late and can otherwise leave a
# second process holding the same journal/trade artifacts open.
$existingGateway = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
if ($existingGateway.Count -gt 0) {
  $owners = ($existingGateway | Select-Object -ExpandProperty OwningProcess -Unique) -join ","
  Write-LaunchLog "S1 gateway port 8787 is already listening (PID $owners); refusing overlapping launch."
  throw "S1 gateway port 8787 is already in use by PID $owners. Stop the existing S1 runner before launching another."
}

# A paper-only runner cannot safely re-adopt a simulated position after a
# crashed launch. Preserve the failed session for audit, then start clean.
$today = Get-Date -Format "yyyy-MM-dd"
$sessionDir = Join-Path $RepoRoot "journals\s1-momentum-burst\$today\dhan-live-data-paper"
$eventsPath = Join-Path $sessionDir "events.jsonl"
if (Test-Path -LiteralPath $eventsPath) {
  $recoveryHalt = Select-String -LiteralPath $eventsPath -SimpleMatch 'RECOVERED_OPEN_POSITION' | Select-Object -Last 1
  $sessionStop = Select-String -LiteralPath $eventsPath -SimpleMatch '"type":"risk.sessionStop"' | Select-Object -Last 1
  $positions = @{}
  Get-Content -LiteralPath $eventsPath | ForEach-Object {
    try {
      $event = $_ | ConvertFrom-Json
      if ($event.type -eq "position.updated") {
        $positions[$event.payload.position.positionId] = $event.payload.position
      }
    } catch {
      # Keep a recoverable journal readable even if a crash left a partial line.
    }
  }
  $hasOpenPaperPosition = @($positions.Values | Where-Object { $_.state -ne "CLOSED" -and $_.qty -gt 0 }).Count -gt 0
  if ($recoveryHalt -or $sessionStop -or $hasOpenPaperPosition) {
    $archiveDir = "$sessionDir-recovery-$(Get-Date -Format 'HHmmss')"
    Copy-Item -LiteralPath $sessionDir -Destination $archiveDir -Recurse
    Write-LaunchLog "Copied prior paper session to $archiveDir for audit; active journal retained for recovery (recoveryHalt=$($null -ne $recoveryHalt), sessionStop=$($null -ne $sessionStop), openPosition=$hasOpenPaperPosition)."
  }
}

if ($SkipLaunchWindow) {
  Write-LaunchLog "Skipping launch-window wait."
} else {
  Wait-UntilLaunchTime -TargetHour 9 -TargetMinute 20
}
Write-LaunchLog "Starting compiled paper runner (SkipBuild=$SkipBuild)."

Set-Location -LiteralPath $RepoRoot
# Allow node's stderr (console.warn/error) without killing the PS1 process.
$ErrorActionPreference = "Continue"
if ($SkipBuild) {
  node core\dist\host\dhan-live-data-paper.js *>&1 | Tee-Object -FilePath $script:LogPath -Append
} else {
  npm run paper:live-data:dhan *>&1 | Tee-Object -FilePath $script:LogPath -Append
}
