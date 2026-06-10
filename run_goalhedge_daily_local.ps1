param(
    [string]$Date = "",
    [string]$SheetId = "1-8pJRIEiKZpaJyXoeK9sjQC9EIgcuyVhtAUp8xEBylA"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $RepoRoot ".venv\Scripts\python.exe"
$LogDir = Join-Path $RepoRoot "logs"
$RunStamp = Get-Date -Format "yyyyMMdd_HHmmss"
$LogFile = Join-Path $LogDir "goalhedge_daily_$RunStamp.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Step {
    param([string]$Message)
    $line = "$(Get-Date -Format s) $Message"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

function Invoke-Step {
    param(
        [string]$Name,
        [string[]]$Arguments
    )

    Write-Step "Starting: $Name"
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $Python @Arguments 2>&1 | Tee-Object -FilePath $LogFile -Append
    $pythonExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($pythonExitCode -ne 0) {
        throw "$Name failed with exit code $pythonExitCode"
    }
    Write-Step "Completed: $Name"
}

if (-not (Test-Path $Python)) {
    throw "Python virtual environment not found at $Python. Create it with: python -m venv .venv; .\.venv\Scripts\python.exe -m pip install -r requirements.txt"
}

Set-Location $RepoRoot
$env:GOOGLE_SHEET_ID = $SheetId

$DateArgs = @()
if ($Date.Trim() -ne "") {
    $DateArgs = @("--date", $Date.Trim())
}

Write-Step "GoalHedge local daily run started"
Write-Step "Repo: $RepoRoot"
Write-Step "Log: $LogFile"

Invoke-Step "Download and process NSE EOD data" (@("nse_downloader.py") + $DateArgs + @("--lookback-days", "0"))
Invoke-Step "Build Alpha rankings" (@("ranking_engine.py") + $DateArgs)
Invoke-Step "Update Google Sheets dashboard" (@("google_sheets_updater.py") + $DateArgs)

Write-Step "GoalHedge local daily run completed"
