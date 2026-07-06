param(
  [string]$RepoRoot = "D:\Claude\scalper",
  [string]$EnvPath = "D:\DHAN_LOGIN\.env"
)

$ErrorActionPreference = "Stop"

function Write-LaunchLog {
  param([string]$Message)
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $script:LogPath -Value "[$stamp] $Message"
}

$logDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$script:LogPath = Join-Path $logDir ("dhan-paper-s2-launch-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

Write-LaunchLog "Starting S2 Dhan live-data paper launch."
Write-LaunchLog "RepoRoot=$RepoRoot"
Write-LaunchLog "EnvPath=$EnvPath"

if (-not (Test-Path -LiteralPath $RepoRoot)) {
  throw "Repo root not found: $RepoRoot"
}

if (-not (Test-Path -LiteralPath $EnvPath)) {
  throw "Dhan env file not found: $EnvPath"
}

$envText = Get-Content -Raw -LiteralPath $EnvPath
foreach ($key in @("DHAN_CLIENT_ID", "DHAN_ACCESS_TOKEN", "DHAN_SCRIP_MASTER_PATH")) {
  if ($envText -notmatch "(?m)^\s*(export\s+)?$key\s*=\s*\S+") {
    throw "$key is missing or blank in $EnvPath"
  }
}

$env:DHAN_ENV_PATH = $EnvPath
$env:DHAN_STRATEGY_ID = "s2-vwap-fade"
$env:DHAN_AUTO_ARM = "false"
$env:DHAN_GATEWAY_PORT = "8788"
$env:DHAN_JOURNAL_ROOT = "journals\s2-vwap-fade"
$env:DHAN_RECORDER_ROOT = "data\dhan\ticks-s2-vwap-fade"

Write-LaunchLog "Strategy forced to $env:DHAN_STRATEGY_ID."
Write-LaunchLog "Gateway port forced to $env:DHAN_GATEWAY_PORT."
Write-LaunchLog "Journal root forced to $env:DHAN_JOURNAL_ROOT."
Write-LaunchLog "Recorder root forced to $env:DHAN_RECORDER_ROOT."
Write-LaunchLog "Auto-arm forced to $env:DHAN_AUTO_ARM."
Write-LaunchLog "Running npm run paper:live-data:dhan."

Set-Location -LiteralPath $RepoRoot
npm run paper:live-data:dhan *>&1 | Tee-Object -FilePath $script:LogPath -Append
