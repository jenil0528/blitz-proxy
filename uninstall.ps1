# ============================================================================
# BlitzProxy — Windows Uninstaller (uninstall.ps1)
# Removes ONLY BlitzProxy components:
#   - the blitz.cmd shim directory (%LOCALAPPDATA%\BlitzProxy)
#   - the BlitzProxy entry in your USER Path
# Your project files, config, and other applications are never touched.
# Optional: -Purge also removes ~/.blitzproxy (stored keys, stats) after confirm.
# Usage:  powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Purge]
# ============================================================================

param(
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$InstallDir = Join-Path $env:LOCALAPPDATA 'BlitzProxy'

Write-Host ''
Write-Host '  BlitzProxy — Uninstaller' -ForegroundColor Cyan
Write-Host '  =========================' -ForegroundColor Cyan
Write-Host ''

# ── 1. Remove shim directory ─────────────────────────────────────────────────
if (Test-Path $InstallDir) {
    Remove-Item -Path $InstallDir -Recurse -Force
    Write-Host '  [OK] Removed shim: $InstallDir' -ForegroundColor Green
} else {
    Write-Host '  [INFO] No shim found (already removed).' -ForegroundColor Yellow
}

# ── 2. Remove BlitzProxy entry from USER Path ────────────────────────────────
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
    $parts = $userPath -split ';' | Where-Object { $_ -ne '' -and $_ -ne $InstallDir }
    $newPath = ($parts -join ';')
    if ($newPath -ne $userPath) {
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host '  [OK] Removed BlitzProxy from your USER Path' -ForegroundColor Green
    } else {
        Write-Host '  [INFO] USER Path had no BlitzProxy entry.' -ForegroundColor Yellow
    }
}

# ── 3. Optional: purge stored keys / stats ────────────────────────────────────
if ($Purge) {
    $blitzHome = Join-Path $env:USERPROFILE '.blitzproxy'
    if (Test-Path $blitzHome) {
        $answer = Read-Host "  Remove ALL stored API keys and stats ($blitzHome)? [y/N]"
        if ($answer -match '^[Yy]') {
            Remove-Item -Path $blitzHome -Recurse -Force
            Write-Host '  [OK] Removed ~/.blitzproxy (keys + stats)' -ForegroundColor Green
        } else {
            Write-Host '  [INFO] Kept ~/.blitzproxy' -ForegroundColor Yellow
        }
    }
}

# ── 4. Optional: remove opt-in global env vars set by -ConfigureGlobalEnv ─────
$baseUrl = [Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL', 'User')
if ($baseUrl -and $baseUrl -match 'localhost:4819|127\.0\.0\.1:4819') {
    [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $null, 'User')
    Write-Host '  [OK] Removed ANTHROPIC_BASE_URL (was pointing at BlitzProxy)' -ForegroundColor Green
}

Write-Host ''
Write-Host '  Uninstalled. Your project files in the BlitzProxy folder were NOT deleted.' -ForegroundColor Cyan
Write-Host '  Close and reopen terminals for PATH changes to apply.'
Write-Host ''
