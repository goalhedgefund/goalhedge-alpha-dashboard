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
# In TOTP mode also verify the access token is present (minted by the dashboard
# at boot). If it's missing the dashboard hasn't finished its startup mint yet;
# exiting here triggers a supervisor restart after 30s, by which time it'll be ready.
if ($totpMode -and $envText -notmatch "(?m)^\s*(export\s+)?DHAN_ACCESS_TOKEN\s*=\s*\S+") {
  throw "DHAN_ACCESS_TOKEN not yet written to $EnvPath - dashboard TOTP mint is still in progress. Will retry."
}

$env:DHAN_ENV_PATH = $EnvPath
$env:DHAN_STRATEGY_ID = "s1-momentum-burst"
$env:DHAN_GATEWAY_PORT = "8787"
$env:DHAN_JOURNAL_ROOT = "journals\s1-momentum-burst"
$env:DHAN_RECORDER_ROOT = "data\dhan\ticks-s1-momentum-burst"
$env:DHAN_AUTO_ARM = "true"

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
