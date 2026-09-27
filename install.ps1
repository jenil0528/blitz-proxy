# ============================================================================
# BlitzProxy — Safe Windows Installer (install.ps1)
# - Creates a blitz.cmd shim in %LOCALAPPDATA%\BlitzProxy
# - Adds that directory to the USER Path via the registry API (no setx,
#   no truncation risk, never touches system PATH or other apps)
# - Backs up config.json if present
# - Does NOT permanently set ANTHROPIC_* globally — use `blitz run claude`
#   (opt in with -ConfigureGlobalEnv if you really want it)
# Usage:  powershell -ExecutionPolicy Bypass -File install.ps1
# ============================================================================

param(
    [switch]$ConfigureGlobalEnv,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:LOCALAPPDATA 'BlitzProxy'
$ShimPath = Join-Path $InstallDir 'blitz.cmd'

function Write-Step($msg) {
    if (-not $Quiet) { Write-Host "  [OK] $msg" -ForegroundColor Green }
}

Write-Host ''
Write-Host '  BlitzProxy — Safe Installer' -ForegroundColor Cyan
Write-Host '  ===========================' -ForegroundColor Cyan
Write-Host ''

# ── 1. Node.js check ──────────────────────────────────────────────────────────
try {
    $nodeVersion = (& node -v) 2>$null
    $major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
    if ($major -lt 18) { throw "Node 18+ required, found $nodeVersion" }
    Write-Step "Node.js $nodeVersion"
} catch {
    Write-Host "  [FAIL] Node.js 18+ is required. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# ── 2. Detect existing installation ──────────────────────────────────────────
$existing = Test-Path $ShimPath
if ($existing) {
    Write-Host '  [INFO] Existing BlitzProxy installation detected — updating shim.' -ForegroundColor Yellow
}

# ── 3. Backup configuration ───────────────────────────────────────────────────
$configPath = Join-Path $ProjectDir 'config.json'
if (Test-Path $configPath) {
    $backup = "$configPath.bak.$(Get-Date -Format 'yyyy-MM-dd-HHmmss')"
    Copy-Item $configPath $backup
    Write-Step "Backed up config.json -> $(Split-Path -Leaf $backup)"
}

# ── 4. Create shim ───────────────────────────────────────────────────────────
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$cliJs = Join-Path $ProjectDir 'cli.js'
@"
@echo off
node "$cliJs" %*
"@ | Set-Content -Path $ShimPath -Encoding ASCII
Write-Step "Created $ShimPath"

# ── 5. Add to USER Path (registry API — safe, no truncation) ──────────────────
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$parts = $userPath -split ';' | Where-Object { $_ -ne '' }
if ($parts -notcontains $InstallDir) {
    $newPath = ($parts + $InstallDir) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Step "Added $InstallDir to your USER Path"
} else {
    Write-Step "USER Path already contains $InstallDir"
}

# ── 6. Optional: global env configuration (explicit opt-in only) ──────────────
if ($ConfigureGlobalEnv) {
    $port = 4819
    [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', "http://127.0.0.1:$port", 'User')
    Write-Step "ANTHROPIC_BASE_URL set permanently (opt-in)"
    Write-Host '        This affects every terminal and other Anthropic tools.' -ForegroundColor Yellow
    Write-Host '        Recommended instead: use "blitz run claude" (no global changes).' -ForegroundColor Yellow
} else {
    Write-Host '  [INFO] Global ANTHROPIC_* variables NOT set (by design).' -ForegroundColor DarkGray
    Write-Host '        Use: blitz run claude   (per-process environment)' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '  Installed. Next steps:' -ForegroundColor Cyan
Write-Host '    1. Open a NEW terminal (PATH refresh)'
Write-Host '    2. blitz add <api-key>      # store keys in the secure keyring'
Write-Host '    3. blitz run claude         # Claude Code through BlitzProxy'
Write-Host ''
Write-Host '  Uninstall any time: powershell -File uninstall.ps1' -ForegroundColor DarkGray
Write-Host ''
