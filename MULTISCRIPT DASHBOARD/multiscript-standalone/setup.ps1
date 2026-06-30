param(
  [switch]$SkipCopy
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $SkipCopy) {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $root "bootstrap-deps.ps1")
}

Write-Host "Setup complete."
