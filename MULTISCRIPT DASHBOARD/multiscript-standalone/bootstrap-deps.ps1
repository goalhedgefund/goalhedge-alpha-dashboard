param(
  [string]$SourceRoot = "",
  [switch]$CopyLocalDeps
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeModules = Join-Path $root "node_modules"

if (Test-Path $nodeModules) {
  Write-Host "Dependencies already present."
  exit 0
}

if ($CopyLocalDeps -and $SourceRoot) {
  $src = Join-Path $SourceRoot "node_modules"
  if (Test-Path $src) {
    Copy-Item -Path (Join-Path $src "*") -Destination $nodeModules -Recurse -Force
    Write-Host "Copied local dependencies from $src"
    exit 0
  }
}

Write-Host "No copied dependencies were requested. The app will use bundled runtime modules when available."
