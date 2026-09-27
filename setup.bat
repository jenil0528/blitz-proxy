@echo off
title BlitzProxy — Setup (deprecated shim)
echo.
echo  BlitzProxy setup is now the safe PowerShell installer.
echo  It will NOT permanently overwrite your global environment.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
