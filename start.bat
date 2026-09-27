@echo off
title BlitzProxy
echo.

:: Check Node.js
node -v >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js is not installed!
    echo  Please install Node.js 18+ from https://nodejs.org
    pause
    exit /b 1
)

echo  Starting BlitzProxy (foreground)...
echo  Press Ctrl+C to stop.
echo.
echo  Tip: use "blitz start" for background mode, or just "blitz" to
echo  start the proxy and launch Claude Code in one command.
echo.

node "%~dp0server.js"
