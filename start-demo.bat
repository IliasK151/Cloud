@echo off
rem Double-click this file in File Explorer to open the trading floor in DEMO mode (simulated
rem markets, works offline). It installs what it needs the first time, starts the floor and
rem opens your browser. Close this window (or press Ctrl+C) to stop the floor.
cd /d "%~dp0"
title Meridian trading floor (demo)
rem Node.js installed a moment ago isn't on this window's PATH yet: look where it installs.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul || goto nonode
node scripts\launch.js --demo
if errorlevel 1 pause
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
