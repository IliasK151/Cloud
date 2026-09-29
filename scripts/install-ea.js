// Copies the MeridianBridge Expert Advisor into every MetaTrader 5 "MQL5/Experts" folder
// found on this Mac (MT5 for Mac keeps them inside a hidden Windows-style folder that
// Finder drag-and-drop can't reach).   Usage:  npm run install-ea
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EA = path.join(ROOT, 'mt5', 'MeridianBridge.mq5');
const HOME = process.env.HOME || os.homedir();

// Where MT5 installs live on macOS (MetaQuotes app, CrossOver bottles, plain Wine).
const ROOTS = [
  { dir: path.join(HOME, 'Library', 'Application Support'), filter: /metaquotes|metatrader|mt5|ftmo|wine|crossover/i },
  { dir: path.join(HOME, '.wine') },
  { dir: path.join(HOME, '.mt5') },
];
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

export function locateExpertsFolders() {
  const found = [];
  for (const r of ROOTS) findExperts(r.dir, 0, found, r.filter);
  return [...new Set(found)];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const folders = locateExpertsFolders();
  if (!folders.length) {
    console.log('\n  Could not find a MetaTrader 5 "MQL5/Experts" folder on this Mac.');
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
