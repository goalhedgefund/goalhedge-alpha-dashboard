param(
    [string]$TaskName = "GoalHedge Alpha Dashboard Daily",
    [string]$RunTime = "22:45"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $RepoRoot "run_goalhedge_daily_local.ps1"

if (-not (Test-Path $Runner)) {
    throw "Runner script not found: $Runner"
}

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`""

$Trigger = New-ScheduledTaskTrigger `
    -Weekly `
    -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday `
    -At $RunTime

$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Runs GoalHedge NSE pipeline and updates Google Sheets locally." `
    -Force | Out-Null

Write-Host "Registered scheduled task: $TaskName"
Write-Host "Schedule: Monday-Friday at $RunTime local time"
Write-Host "Runner: $Runner"
