// Copies the MeridianBridge Expert Advisor into every MetaTrader 5 "MQL5/Experts" folder
// found on this computer. On a Mac, MT5 keeps them inside a hidden Windows-style folder that
// Finder drag-and-drop can't reach; on Windows, in the hidden AppData folder (or, for a
// portable install, next to MT5 itself).   Usage:  npm run install-ea
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../server/util/isMain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EA = path.join(ROOT, 'mt5', 'MeridianBridge.mq5');
const HOME = process.env.HOME || os.homedir();
const MT5_NAME = /metaquotes|metatrader|mt5|ftmo|wine|crossover/i;

// Where MT5 installs live: on Windows %APPDATA%\MetaQuotes\Terminal\<id>\MQL5 (one per
// installed terminal) and Program Files for portable installs; on macOS the MetaQuotes app,
// CrossOver bottles and plain Wine.
export function searchRoots(platform = process.platform, env = process.env, home = HOME) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [
      { dir: path.join(appData, 'MetaQuotes', 'Terminal') },
      ...[env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((dir) => ({ dir, filter: MT5_NAME })),
    ];
  }
  return [
    { dir: path.join(home, 'Library', 'Application Support'), filter: MT5_NAME },
    { dir: path.join(home, '.wine') },
    { dir: path.join(home, '.mt5') },
  ];
}
const SKIP = new Set(['windows', 'Windows', 'ProgramData', 'Temp', 'Cache', 'Caches', 'Logs', 'Bases', 'Tester', 'history']);
const MAX_DEPTH = 12;

function findExperts(dir, depth, found, filter) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    if (depth === 0 && filter && !filter.test(e.name)) continue;
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.name === 'Experts' && path.basename(dir) === 'MQL5') {
      found.push(full);
      continue;
    }
    if (depth < MAX_DEPTH) findExperts(full, depth + 1, found, filter);
  }
}

export function locateExpertsFolders(roots = searchRoots()) {
  const found = [];
  for (const r of roots) findExperts(r.dir, 0, found, r.filter);
  return [...new Set(found)];
}

if (isMain(import.meta.url)) {
  const folders = locateExpertsFolders();
  if (!folders.length) {
    console.log(`\n  Could not find a MetaTrader 5 "MQL5/Experts" folder on this ${process.platform === 'win32' ? 'PC' : 'Mac'}.`);
    console.log('  Open MT5 once (and log in) so it creates its folders, then run this again.');
    console.log('  Or use the MetaEditor method: MetaEditor → New → Expert Advisor → paste the code');
    console.log('  from the floor\'s FTMO tab ("Copy EA code").\n');
    process.exit(1);
  }
  for (const f of folders) {
    fs.copyFileSync(EA, path.join(f, 'MeridianBridge.mq5'));
    console.log(`  ✓ Copied MeridianBridge.mq5 to ${f}`);
  }
  console.log('\n  Next, in MetaTrader 5:');
  console.log('   1. Navigator panel → right-click "Expert Advisors" → Refresh');
  console.log('   2. Right-click MeridianBridge → Modify (opens MetaEditor) → press Compile');
  console.log('   3. Drag MeridianBridge onto a chart and paste the bridge token from the FTMO tab\n');
}
