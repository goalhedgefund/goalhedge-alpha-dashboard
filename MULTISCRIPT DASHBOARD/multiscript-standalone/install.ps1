param(
  [string]$Port = "3001"
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $root ".env"
$envExample = Join-Path $root ".env.example"

Write-Host ""
Write-Host "================================================"
Write-Host "  Multiscript Dashboard — First-Time Install"
Write-Host "================================================"
Write-Host ""

# 1. Check Node.js
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error "Node.js not found. Install Node.js 20+ from https://nodejs.org and re-run."
  exit 1
}
$nodeVersion = (& node --version 2>&1)
Write-Host "Node.js found: $nodeVersion"

# 2. Check node_modules
$nodeModules = Join-Path $root "node_modules"
if (Test-Path $nodeModules) {
  Write-Host "node_modules: present (bundled)"
} else {
  Write-Host "node_modules not found - running npm install..."
  Set-Location $root
  npm install --prefer-offline 2>&1 | Write-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed. Check your internet connection and try again."
    exit 1
  }
}

# 3. Set up .env if missing
if (-not (Test-Path $envFile)) {
  if (Test-Path $envExample) {
    Copy-Item $envExample $envFile
    Write-Host ""
    Write-Host "Created .env from .env.example"
    Write-Host "ACTION REQUIRED: Open .env and set your values:"
    Write-Host "  - DHAN_CLIENT_ID"
    Write-Host "  - DHAN_ACCESS_TOKEN"
    Write-Host "  - MULTISCRIPT_REPLAY_SOURCE_DIR"
    Write-Host ""
  } else {
    Write-Warning ".env.example not found. Please create .env manually."
  }
} else {
  Write-Host ".env: present"
}

# 4. Create required data directories
$dataDirs = @(
  (Join-Path $root "data\trade-logs\replay"),
  (Join-Path $root "data\replay-cache"),
  (Join-Path $root "data\optimized")
)
foreach ($dir in $dataDirs) {
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Write-Host "Created directory: $dir"
  }
}

# 5. Create START.bat for easy double-click launching
$batContent = "@echo off`r`ntitle Multiscript Dashboard`r`npowershell -ExecutionPolicy Bypass -File `"$root\start.ps1`" -NoInstall`r`npause"
$batFile = Join-Path $root "START.bat"
Set-Content -Path $batFile -Value $batContent -Encoding ASCII
Write-Host "Created: START.bat"

Write-Host ""
Write-Host "================================================"
Write-Host "  Install complete!"
Write-Host "  Run:  .\start.ps1 -NoInstall"
Write-Host "  Or double-click START.bat"
Write-Host "  Then open: http://127.0.0.1:$Port"
Write-Host "================================================"
Write-Host ""
