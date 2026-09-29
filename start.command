#!/bin/bash
# Double-click this file in Finder to open the trading floor with LIVE market data.
# It installs what it needs the first time, starts the local server and opens your browser.
# Close this window (or press Ctrl+C) to stop the floor.

cd "$(dirname "$0")" || exit 1

# Finder doesn't load your shell profile, so look for Node where installers put it.
for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME"/.nvm/versions/node/*/bin; do
  [ -x "$dir/node" ] && PATH="$dir:$PATH"
done

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js isn't installed yet."
  echo "  Your browser will open the download page: install the LTS version,"
  echo "  then double-click 'Start Trading Floor' again."
  echo ""
  open "https://nodejs.org/en/download"
  read -n 1 -s -r -p "  Press any key to close this window."
  exit 1
fi

major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 18 ]; then
  echo "  Node.js $(node -v) is too old; version 18 or newer is needed. Opening the download page…"
  open "https://nodejs.org/en/download"
  read -n 1 -s -r -p "  Press any key to close this window."
  exit 1
fi

if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  echo "  Installing (first run only, about a minute)…"
  if ! npm install --no-audit --no-fund; then
    echo ""
    echo "  The install failed. Check your internet connection and try again."
    read -n 1 -s -r -p "  Press any key to close this window."
    exit 1
  fi
  touch node_modules
fi

npm start
