#!/bin/bash
# Double-click this file in Finder to open the trading floor with LIVE market data.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Install the LTS version from https://nodejs.org or run:  brew install node"
  read -r -p "Press Enter to close…"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)…"
  npm install --no-audit --no-fund || { read -r -p "npm install failed. Press Enter to close…"; exit 1; }
fi
npm start
