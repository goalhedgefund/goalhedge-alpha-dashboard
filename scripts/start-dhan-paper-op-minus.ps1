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
  $now = Get-Date
  $target = Get-Date -Hour 9 -Minute 20 -Second 0
  if ($now -ge $target) { return }
  $delay = [int][Math]::Ceiling(($target - $now).TotalSeconds)
  if ($delay -gt 0) { Start-Sleep -Seconds $delay }
}

$logDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$script:LogPath = Join-Path $logDir ("dhan-paper-op-minus-launch-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

Write-LaunchLog "Starting OP(-) Dhan live-data paper launch."
if (-not (Test-Path -LiteralPath $RepoRoot)) { throw "Repo root not found: $RepoRoot" }
if (-not (Test-Path -LiteralPath $EnvPath)) { throw "Dhan env file not found: $EnvPath" }

$envText = Get-Content -Raw -LiteralPath $EnvPath
foreach ($key in @("DHAN_CLIENT_ID", "DHAN_ACCESS_TOKEN", "DHAN_SCRIP_MASTER_PATH")) {
  if ($envText -notmatch "(?m)^\s*(export\s+)?$key\s*=\s*\S+") { throw "$key is missing or blank in $EnvPath" }
}

$env:DHAN_ENV_PATH = $EnvPath
$env:DHAN_STRATEGY_ID = "op-minus-atm-short"
$env:DHAN_GATEWAY_PORT = "8790"
$env:DHAN_JOURNAL_ROOT = "journals\op-minus-atm-short"
$env:DHAN_RECORDER_ROOT = "data\dhan\ticks-op-minus-atm-short"
$env:DHAN_AUTO_ARM = "true"
$env:DHAN_FEED_STALE_MS = "20000"

Write-LaunchLog "Strategy=$env:DHAN_STRATEGY_ID; port=$env:DHAN_GATEWAY_PORT; paper auto-arm=$env:DHAN_AUTO_ARM."
if (-not $SkipLaunchWindow) { Wait-UntilLaunchTime }

Set-Location -LiteralPath $RepoRoot
$ErrorActionPreference = "Continue"
if ($SkipBuild) {
  node core\dist\host\op-minus-live-data-paper.js *>&1 | Tee-Object -FilePath $script:LogPath -Append
} else {
  npm run paper:live-data:op-minus *>&1 | Tee-Object -FilePath $script:LogPath -Append
}
