@echo off
rem Double-click this file while the floor runs: it checks every connection (the floor, the
rem dashboard, MT5, TradingView) and says in plain words what's wrong and how to fix it.
cd /d "%~dp0"
title Trading floor doctor
rem Node.js installed a moment ago isn't on this window's PATH yet: look where it installs.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul || goto nonode
node scripts\doctor.js
echo.
pause
exit /b
:nonode
echo.
echo   Node.js isn't installed yet. Your browser opens the download page:
echo   install the LTS version (Windows Installer), then double-click this file again.
echo   (Or run the one-line setup from the README, which installs everything.)
echo.
start "" "https://nodejs.org/en/download"
pause
exit /b 1
