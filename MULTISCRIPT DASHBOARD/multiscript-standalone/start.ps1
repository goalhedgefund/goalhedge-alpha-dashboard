param(
  [switch]$NoInstall
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { "" }

if (-not $node) {
  Write-Error "Node.js was not found. Install Node.js 20+ or add node.exe to PATH, then run start.ps1 again."
  exit 1
}

if (-not $NoInstall) {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $root "setup.ps1")
}

Set-Location $root
$env:SCALPER_ENGINE = '1'
& $node "server/index.js"
