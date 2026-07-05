param(
  [int]$Days = 30,
  [string]$From = "",
  [string]$To = "",
  [switch]$NoFetch
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { "" }

if (-not $node) {
  Write-Error "Node.js was not found. Install Node.js 20+ or add node.exe to PATH, then run refresh-regime.ps1 again."
  exit 1
}

Set-Location $root

$argsList = @("scripts/refresh-nifty-regime.js", "--days", "$Days")
if ($From) { $argsList += @("--from", $From) }
if ($To) { $argsList += @("--to", $To) }
if ($NoFetch) { $argsList += "--no-fetch" }

& $node $argsList
exit $LASTEXITCODE
