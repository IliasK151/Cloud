#!/usr/bin/env node
// Move the floor to another computer (from a Mac to a Windows PC, say) with everything it has
// saved: months of your broker's prices, the FTMO account setup, the desks' track record and
// memory, the nightly reviews, the Obsidian vault, your TradingView and Telegram settings and
// the bridge token.
//
//   npm run move -- export          on the old computer, with the floor stopped: everything in
//                                   one file on your Desktop (trading-floor-data-<date>.tgz)
//   npm run move -- import [file]   on the new one, before the floor starts there: that file
//                                   (found by itself in Downloads, on the Desktop or in the
//                                   floor's folder) back into data/
//
// The file holds your keys (bridge token, webhook secret, Telegram bot): move it yourself, on
// a USB stick or your own cloud drive, never by sharing it, and delete it once imported.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from '../server/util/isMain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const say = (t = '') => console.log(t ? `  ${t}` : '');
// Made for one computer only (programs for its system, logs, the service's own files).
export const SKIP = new Set(['logs', 'bin', 'voice-engine', 'charts', 'service.json', 'service-control.json', '.DS_Store', '.gitkeep']);
export const FILE_RE = /^trading-floor-data-[\w.-]*\.tgz$/;

// Windows 10 and 11 come with tar (System32\tar.exe); prefer it to any other tar on the PATH,
// which may read C:\ as a remote host.
export function tarBin(platform = process.platform, env = process.env, exists = fs.existsSync) {
  if (platform !== 'win32') return 'tar';
  const sys = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return exists(sys) ? sys : 'tar';
}
const tar = (args, opts = {}) => execFileSync(tarBin(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

// What goes in the file: everything in data/ but what only works on this computer.
export const entriesToMove = (dataDir) => fs.readdirSync(dataDir).filter((f) => !SKIP.has(f) && !f.endsWith('.part') && !f.endsWith('.tmp')).sort();

// Every name in the file must stay inside data/: no absolute paths, no drive letters, no "..".
export function safeEntry(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-z]:/i.test(n)) return false;
  return !n.split('/').some((part) => part === '..');
}

const home = () => os.homedir();
function desktop() {
  const d = path.join(home(), 'Desktop');
  return fs.existsSync(d) ? d : home();
}

// The newest move file in the places it's likely to be.
export function findMoveFile(dirs = [ROOT, path.join(home(), 'Downloads'), path.join(home(), 'Desktop'), process.env.OneDrive && path.join(process.env.OneDrive, 'Desktop'), home()]) {
  const found = [];
  for (const dir of dirs.filter(Boolean)) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch { /* not there */ }
    for (const n of names) {
      if (!FILE_RE.test(n)) continue;
      const f = path.join(dir, n);
      try {
        found.push({ f, at: fs.statSync(f).mtimeMs });
      } catch { /* gone */ }
    }
  }
  return found.sort((a, b) => b.at - a.at)[0]?.f || null;
}

async function floorRunning() {
  const { config } = await import('../server/config.js');
  const { health } = await import('./service.js');
  return { port: config.port, dataDir: config.dataDir, vaultDir: config.vaultDir, up: await health(config.port) };
}

async function serviceInstalled() {
  if (process.platform === 'win32') return (await import('./serviceWindows.js')).installed();
  if (process.platform === 'darwin') return fs.existsSync((await import('./service.js')).plistPath());
  return false;
}

export async function exportData({ out = null, anyway = false } = {}) {
  const f = await floorRunning();
  // One floor per account: the old one stays off, or both would trade the same FTMO account.
  if (!anyway && (f.up || await serviceInstalled())) {
    say();
    say(f.up ? `The floor is still running here (port ${f.port}).` : 'The floor\'s background service is still installed here, so it starts again at the next login.');
    say('Stop it for good first, so the two computers never both trade your FTMO account:');
    say('  npm run service -- uninstall      (or, without the service: Ctrl+C in the floor\'s window)');
    say('It closes the floor\'s FTMO positions on the way out. Then run this again: npm run move -- export');
    say();
    process.exitCode = 1;
    return null;
  }
  const items = entriesToMove(f.dataDir);
  if (!items.length) {
    say(`Nothing to move: ${f.dataDir} is empty.`);
    process.exitCode = 1;
    return null;
  }
  const day = new Date().toISOString().slice(0, 10);
  const dest = out || path.join(desktop(), `trading-floor-data-${day}.tgz`);
  tar(['-czf', dest, '-C', f.dataDir, ...items]);
  const mb = (fs.statSync(dest).size / 1e6).toFixed(1);
  say();
  say(`✓ Saved everything the floor has to ${dest} (${mb} MB):`);
  say(`  ${items.join(', ')}`);
  if (!f.vaultDir.startsWith(f.dataDir)) say(`  (Your Obsidian vault is in ${f.vaultDir}, outside the floor's data: copy that folder yourself if you want it.)`);
  say();
  say('Next:');
  say('  1. Copy that file to the new computer: a USB stick or your own cloud drive (it holds your');
  say('     keys and the Telegram bot token, so don\'t email or share it).');
  say('  2. On the new computer, put it in Downloads and run the setup (it finds the file), or in the');
  say('     floor\'s folder: npm run move -- import');
  say('  3. Delete the file from both computers once it\'s imported.');
  say('  Keep the floor here switched off from now on: one floor per FTMO account. You can close MT5 here too.');
  say();
  return dest;
}

export async function importData({ file = null, anyway = false } = {}) {
  const f = await floorRunning();
  if (!anyway && f.up) {
    say();
    say(`The floor is running here (port ${f.port}). Stop it first, then import:`);
    say('  close its window (or npm run service -- uninstall), then: npm run move -- import');
    say();
    process.exitCode = 1;
    return null;
  }
  const src = file ? path.resolve(file) : findMoveFile();
  if (!src || !fs.existsSync(src)) {
    say();
    say(file ? `Couldn't find ${file}.` : 'No trading-floor-data-….tgz file found in Downloads, on the Desktop or in the floor\'s folder.');
    say('On the old computer run: npm run move -- export   then copy the file here and run this again');
    say('(or give its place: npm run move -- import "C:\\path\\to\\trading-floor-data-….tgz").');
    say();
    process.exitCode = 1;
    return null;
  }
  const names = tar(['-tzf', src]).split(/\r?\n/).filter(Boolean);
  if (!names.length || !names.every(safeEntry)) {
    say(`${src} isn't a move file from the floor (or it's damaged): nothing was changed.`);
    process.exitCode = 1;
    return null;
  }
  // What's there now (a fresh floor's new keys, or an earlier run) is kept aside, not lost.
  const existing = fs.existsSync(f.dataDir) ? entriesToMove(f.dataDir) : [];
  let aside = null;
  if (existing.length) {
    aside = `${f.dataDir}-before-import-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    fs.mkdirSync(aside, { recursive: true });
    for (const n of existing) fs.renameSync(path.join(f.dataDir, n), path.join(aside, n));
  }
  fs.mkdirSync(f.dataDir, { recursive: true });
  tar(['-xzf', src, '-C', f.dataDir]);
  const has = (n) => fs.existsSync(path.join(f.dataDir, n));
  const markets = has('history') ? fs.readdirSync(path.join(f.dataDir, 'history')).filter((n) => n.endsWith('.json')).length : 0;
  say();
  say(`✓ Imported from ${src}:`);
  if (markets) say(`  • price history for ${markets} market${markets === 1 ? '' : 's'}`);
  if (has('live.json')) say('  • the FTMO account setup, desks and switches');
  if (has('state-live.json')) say('  • the desks\' track record');
  if (has('neural') || fs.readdirSync(f.dataDir).some((n) => /^memory/.test(n))) say('  • the floor\'s memory and neural brain');
  if (has('telegram.json')) say('  • Telegram alerts');
  if (has('bridge-token.txt')) say('  • the bridge token (paste the same token into the EA in MT5 on this computer: the FTMO tab shows it)');
  if (aside) say(`  What was in data/ before is kept in ${aside}.`);
  say();
  say(`Delete ${src} now: it holds your keys. And keep the floor on the old computer switched off.`);
  say();
  return { src, aside };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const anyway = rest.includes('--anyway');
  const arg = rest.find((x) => !x.startsWith('--')) || null;
  if (cmd === 'export') await exportData({ out: arg, anyway });
  else if (cmd === 'import') await importData({ file: arg, anyway });
  else {
    say();
    say('Move the floor to another computer, with everything it has saved:');
    say('  npm run move -- export          on the old computer (the floor stopped)');
    say('  npm run move -- import [file]   on the new one (before the floor starts)');
    say();
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n  The move didn't work: ${err.message}\n`);
    process.exitCode = 1;
  });
}
