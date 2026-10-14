@echo off
:: BlitzProxy - universal entry point (Windows)
:: All commands route to cli.js. No arguments = start proxy + launch Claude Code.
:: UTF-8 codepage: the CLI uses glyphs (checkmarks, bullets, arrows) that turn
:: into legacy-codepage mojibake (TCo / [Co) without this.
chcp 65001 >nul
node "%~dp0cli.js" %*
