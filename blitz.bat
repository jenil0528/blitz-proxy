@echo off
:: BlitzProxy — universal entry point (Windows)
:: All commands route to cli.js. No arguments = start proxy + launch Claude Code.
node "%~dp0cli.js" %*
