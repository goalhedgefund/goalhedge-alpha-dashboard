param(
  [switch]$UseBundledRuntime = $true
)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Write-Host "If you want to install fresh dependencies, run npm install in $root."
Write-Host "This package is configured to work with the bundled runtime modules as-is."
