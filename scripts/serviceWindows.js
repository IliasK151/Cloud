// npm run service on Windows: the floor runs non-stop in the background, hidden, started at
// every login by a small file in your Startup folder (no administrator rights needed), and
// kept running by scripts/supervisor.js. MetaTrader 5 is started at login too.
//
//   npm run service -- install     start now, start again at every login, restart by itself
//   npm run service -- status      is it running, and is the floor answering?
//   npm run service -- restart     restart it (after an update)
//   npm run service -- logs        the floor's latest output
//   npm run service -- uninstall   stop it and remove it from the Startup folder

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { servicePaths, supervisorAlive, requestService, spawnDetached } from './supervisor.js';
import { health, port, ensureDeps, depsCurrent, stale, tail, vaultLines } from './service.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STARTUP_NAME = 'Meridian Trading Floor.cmd';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startupDir(env = process.env, home = os.homedir()) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
export const startupFile = (env = process.env, home = os.homedir()) => path.join(startupDir(env, home), STARTUP_NAME);

// MetaTrader 5 (terminal64.exe) in Program Files, the FTMO one first.
export function findMt5(env = process.env, { readdir = (d) => fs.readdirSync(d, { withFileTypes: true }), exists = fs.existsSync } = {}) {
  const found = [];
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
    let entries = [];
    try {
      entries = readdir(base);
    } catch { /* not there */ }
    for (const e of entries) {
      if (!e.isDirectory() || !/metatrader|mt5|ftmo/i.test(e.name)) continue;
      const exe = path.join(base, e.name, 'terminal64.exe');
      if (exists(exe)) found.push(exe);
    }
  }
  return found.sort((a, b) => Number(/ftmo/i.test(b)) - Number(/ftmo/i.test(a)))[0] || null;
}

// A path for a batch file: %USERPROFILE% / %ProgramFiles% instead of the folder itself (so a
// name with accents or Greek letters can't trip cmd.exe up), and a literal % doubled.
export function batchPath(p, env = process.env) {
  for (const key of ['USERPROFILE', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'APPDATA']) {
    const base = env[key];
    if (base && (p === base || p.toLowerCase().startsWith(`${base.toLowerCase()}\\`))) return `%${key}%${p.slice(base.length).replace(/%/g, '%%')}`;
  }
  return p.replace(/%/g, '%%');
}

// The file in the Startup folder: start the floor's supervisor hidden, and MT5 unless it's
// already open.
export function startupScript({ root = ROOT, node = process.execPath, mt5 = findMt5(), env = process.env } = {}) {
  const lines = [
    '@echo off',
    'rem Meridian trading floor: starts the floor in the background at login, and MetaTrader 5.',
    'rem Put here by "npm run service -- install"; "npm run service -- uninstall" removes it.',
    'chcp 65001 >nul',
    `cd /d "${batchPath(root, env)}"`,
    `"${batchPath(node, env)}" "${batchPath(path.win32.join(root, 'scripts', 'supervisor.js'), env)}" --detach`,
  ];
  if (mt5) lines.push(`tasklist /FI "IMAGENAME eq terminal64.exe" 2>nul | find /I "terminal64.exe" >nul || start "" "${batchPath(mt5, env)}"`);
  return `${lines.join('\r\n')}\r\n`;
}

async function waitForFloor(p, { until = (h) => h?.service, seconds = 60 } = {}) {
  let h = null;
  for (let i = 0; i < seconds && !until(h); i++) {
    await sleep(1000);
    h = await health(p);
  }
  return until(h) ? h : null;
}

async function waitGone(paths, seconds = 60) {
  for (let i = 0; i < seconds && supervisorAlive(paths.pidFile); i++) await sleep(1000);
  return !supervisorAlive(paths.pidFile);
}

async function install() {
  const p = await port();
  const paths = servicePaths(ROOT);
  const before = await health(p);
  const sup = supervisorAlive(paths.pidFile);
  if (before && !before.service && !sup) {
    console.log(`\n  The floor is already running in a window (port ${p}), so the service couldn't start.`);
    console.log('  Close that window (or press Ctrl+C in it; it closes the floor\'s FTMO positions), then run this again:');
    console.log('    npm run service -- install\n');
    process.exitCode = 1;
    return;
  }
  if (!sup) ensureDeps(ROOT); // a running floor holds its files: restart installs them
  const mt5 = findMt5();
  fs.mkdirSync(startupDir(), { recursive: true });
  fs.writeFileSync(startupFile(), startupScript({ mt5 }));

  if (sup && before?.service) {
    // Started before an update: restart onto the new code.
    if (stale(ROOT, before) || !depsCurrent(ROOT)) return restart();
    console.log(`\n  ✓ Already installed and running the latest code: the floor is on at http://localhost:${p} (up ${Math.round((before.uptime || 0) / 60)} min).\n`);
    return;
  }
  if (sup) requestService('restart', paths);
  else spawnDetached({ root: ROOT });
  const h = await waitForFloor(p);
  console.log('');
  if (!h) {
    console.log('  ▲ Installed, but the floor isn\'t answering yet. In a minute, check with: npm run service -- status');
    console.log('    (it shows why if it doesn\'t start).\n');
    return;
  }
  console.log(`  ✓ The floor now runs non-stop in the background at http://localhost:${p}`);
  console.log('    It starts at every login, restarts by itself if it stops, and keeps the PC from going to sleep.');
  console.log(mt5 ? `    MetaTrader 5 opens at login too (${mt5}).` : '    MetaTrader 5 wasn\'t found in Program Files: to have it open at login, press Win+R, type shell:startup and put a shortcut to MT5 there.');
  for (const l of await vaultLines()) console.log(`    ${l}`);
  console.log('');
  console.log('  Also, once:');
  console.log('    • FTMO tab: switch on "Stay armed after a restart".');
  console.log('    • Settings → System → Power: "When plugged in, put my device to sleep after" → Never.');
  console.log('    • Settings → Accounts → Sign-in options: "Use my sign-in info to automatically finish setting up after an update" on,');
  console.log('      so the floor comes back after a Windows Update restart. Set your active hours in Windows Update too.');
  console.log('    • Don\'t start the floor in a window any more while the service is on (the port is taken). Just open the address above.');
  console.log('    • Logs: npm run service -- logs · stop for good: npm run service -- uninstall\n');
}

async function uninstall() {
  const paths = servicePaths(ROOT);
  const file = startupFile();
  const had = fs.existsSync(file);
  const sup = supervisorAlive(paths.pidFile);
  if (sup) {
    console.log('\n  Stopping the floor (it closes its FTMO positions first)…');
    requestService('stop', paths);
    if (!(await waitGone(paths))) console.log('  ▲ The service didn\'t confirm it stopped. Check Task Manager for node.exe.');
  }
  if (had) fs.unlinkSync(file);
  console.log(sup || had ? '\n  ✓ Stopped and removed from the Startup folder. Start the floor again with start (or npm start).\n' : '\n  The service wasn\'t installed.\n');
}

async function status() {
  const paths = servicePaths(ROOT);
  const installed = fs.existsSync(startupFile());
  const sup = supervisorAlive(paths.pidFile);
  const p = await port();
  const h = await health(p);
  console.log('');
  if (!installed) console.log('  The service isn\'t installed (npm run service -- install).');
  else if (!sup) console.log('  Installed (starts at login), but it isn\'t running now. Start it: npm run service -- restart');
  else console.log(`  Service: running (pid ${sup.pid}, since ${new Date(sup.startedAt).toLocaleString()})`);
  if (h) console.log(`  Floor: answering at http://localhost:${p} (${h.mode} mode, up ${Math.round(h.uptime / 60)} min${h.service === false ? ', in a window, not the service' : ''})`);
  else console.log(`  Floor: not answering on port ${p}, so MT5 can't connect to it.`);
  if (h && stale(ROOT, h)) console.log('  ▲ It\'s still running the code from before your last update. Load the new code: npm run service -- restart');
  for (const l of await vaultLines()) console.log(`  ${l}`);
  if (installed && !h) {
    const err = tail(path.join(paths.logs, 'floor-error.log'), 8).trim();
    if (err && err !== '(no log yet)') console.log(`\n  Its last errors:\n${err.split('\n').map((l) => `    ${l}`).join('\n')}`);
    console.log('\n  Try: npm run service -- install   (it sets the service up again)');
  }
  console.log('');
}

async function restart() {
  const paths = servicePaths(ROOT);
  if (!fs.existsSync(startupFile()) || !supervisorAlive(paths.pidFile)) return install();
  const p = await port();
  const before = await health(p);
  console.log('\n  Restarting the floor (open FTMO positions are closed and, with "Stay armed" on, trading re-arms once MT5 is back)…');
  if (depsCurrent(ROOT)) requestService('restart', paths);
  else {
    // New packages: Windows locks the files a running floor has loaded, so stop it first.
    requestService('stop', paths);
    await waitGone(paths);
    ensureDeps(ROOT);
    spawnDetached({ root: ROOT });
  }
  const h = await waitForFloor(p, { until: (x) => x?.service && (!before || x.uptime < (before.uptime ?? Infinity)), seconds: 90 });
  console.log(h ? `  ✓ Back up at http://localhost:${p}. Reload the floor's page.\n` : '  ▲ Not answering yet. In a minute: npm run service -- status\n');
}

function logs() {
  const { logs: dir } = servicePaths(ROOT);
  const f = path.join(dir, 'floor.log');
  const e = path.join(dir, 'floor-error.log');
  console.log(`\n  ${f}\n${tail(f, 60)}`);
  const err = tail(e, 20).trim();
  if (err && err !== '(no log yet)') console.log(`\n  ${e}\n${err}`);
  console.log('');
}

export const installed = () => fs.existsSync(startupFile());

export async function main(cmd) {
  const cmds = { install, uninstall, status, restart, logs };
  if (!Object.hasOwn(cmds, cmd)) {
    console.log('\n  npm run service -- install | status | restart | logs | uninstall\n');
    return;
  }
  await cmds[cmd]();
}
