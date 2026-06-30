param(
  [string]$SourceRoot = ""
)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $SourceRoot) {
  Write-Host "SourceRoot not supplied. Nothing to copy."
  exit 0
}

$src = Join-Path $SourceRoot "node_modules"
$dst = Join-Path $root "node_modules"
if (Test-Path $src) {
  Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
  Write-Host "Copied dependencies from $src to $dst"
} else {
  Write-Host "No source node_modules found at $src"
}
