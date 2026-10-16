@echo off
rem Double-click this file to update the trading floor: it gets the newest version (git pull),
rem installs any new packages, and restarts the floor if it runs as the background service.
cd /d "%~dp0"
title Update the trading floor
rem Node.js installed a moment ago isn't on this window's PATH yet: look where it installs.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul || goto nonode
if not exist ".git" (
  echo.
  echo   This folder wasn't downloaded with git, so it can't update itself.
  echo   Run the one-line setup from the README again: it puts an updatable copy in
  echo   %USERPROFILE%\trading-floor and keeps your data.
  echo.
  pause
  exit /b 1
)
where git >nul 2>nul || (
  echo.
  echo   Git isn't installed. Install it from https://git-scm.com/download/win and try again.
  echo.
  start "" "https://git-scm.com/download/win"
  pause
  exit /b 1
)
echo.
echo   Getting the newest version...
rem npm rewrites package-lock.json when it installs; that copy is npm's own, not a change to keep.
git checkout -- package-lock.json >nul 2>nul
git pull --ff-only
if errorlevel 1 (
  echo.
  echo   The update didn't download: see the message above. Check your internet connection.
  echo   If git says your local changes would be overwritten, run: git stash  then try again.
  echo.
  pause
  exit /b 1
)
node scripts\launch.js --update
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
