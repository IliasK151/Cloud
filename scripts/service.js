#!/usr/bin/env node
// Run the floor non-stop on this Mac, as a background service (a macOS LaunchAgent):
//
//   npm run service -- install     start now, start again at every login, and restart by
//                                  itself if it ever stops (the floor keeps the Mac awake)
//   npm run service -- status      is it running, and is the floor answering?
//   npm run service -- restart     restart it (after a git pull, say)
//   npm run service -- logs        the floor's latest output
//   npm run service -- uninstall   stop it and remove the service
//
// With the service installed you don't use npm start any more: the floor is always on at
// http://localhost:3000. Stopping it (uninstall, logout, shutdown) closes the floor's FTMO
// positions like Ctrl+C does; "Stay armed after a restart" in the FTMO tab arms it again
// after a restart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { protectedFolder, folderName } from '../server/util/macFolders.js';

export const LABEL = 'com.meridiancapital.floor';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MT5_APP = '/Applications/MetaTrader 5.app';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// macOS keeps background services out of Desktop, Documents, Downloads and iCloud Drive
// (server/util/macFolders.js).
export { protectedFolder };

// Moves the floor to your home folder (~/trading-floor) and leaves a link with the same name
// where it was, so the Desktop folder, Start Trading Floor and `cd ~/Desktop/trading-floor`
// all work as before.
export function moveOut(root, home = os.homedir()) {
  const dest = path.join(home, path.basename(root));
  if (fs.existsSync(dest)) throw new Error(`The floor has to move out of your ${protectedFolder(root, home)} to run as a service, but ${dest} already exists. Move or rename that folder, then run this again.`);
  try {
    fs.renameSync(root, dest);
  } catch (err) {
    throw new Error(`Couldn't move the floor to ${dest} (${err.code || err.message}). Quit everything running from the folder, or drag the folder to your home folder in Finder, then run this again from there.`);
  }
  fs.symlinkSync(dest, root);
  return dest;
}

// /opt/homebrew/bin/node stays put when Homebrew updates Node; the versioned path behind it
// (…/Cellar/node/24.x/bin/node) disappears, and with it a service that points there.
export function stableNode(exec = process.execPath, candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
  for (const p of candidates) {
    try {
      if (fs.realpathSync(p) === fs.realpathSync(exec)) return p;
    } catch { /* not there */ }
  }
  return exec;
}

// The LaunchAgent: node runs the floor directly (so a stop reaches it and it closes its FTMO
// positions cleanly), the floor keeps the Mac awake itself while it runs, and KeepAlive
// restarts it whenever it stops, at most every 30 seconds.
export function plistFor({ root = ROOT, node = process.execPath, logDir = path.join(root, 'data', 'logs'), label = LABEL } = {}) {
  const pathEnv = [path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const args = [node, path.join(root, 'server', 'index.js')];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(pathEnv)}</string>
    <key>OPEN_BROWSER</key>
    <string>0</string>
    <key>FLOOR_SERVICE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ExitTimeOutSecs</key>
  <integer>20</integer>
  <key>StandardOutPath</key>
  <string>${esc(path.join(logDir, 'floor.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(path.join(logDir, 'floor-error.log'))}</string>
</dict>
</plist>
`;
}

export const plistPath = (home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);

function launchctl(args, { quiet = false } = {}) {
  try {
    return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'] });
  } catch (err) {
    if (quiet) return null;
    throw new Error((err.stderr || err.message || '').toString().trim());
  }
}

const domain = () => `gui/${process.getuid()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// launchd keeps a stopped service loaded until the floor has exited (it takes a few seconds
// to close its FTMO positions), and until then refuses to load it again with "Bootstrap
// failed: 5: Input/output error". So stop it and wait until it's gone…
export async function unload({ run = launchctl, isLoaded = () => !!running(), wait = sleep } = {}) {
  if (!isLoaded()) return true;
  run(['bootout', `${domain()}/${LABEL}`], { quiet: true });
  for (let i = 0; i < 30 && isLoaded(); i++) await wait(1000);
  return !isLoaded();
}

// …then load it, trying again while launchd is still letting go of the old one. A service
// switched off in System Settings can't be loaded either, so it's switched on first.
export async function load(file, { run = launchctl, isLoaded = () => !!running(), wait = sleep, tries = 6 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    await unload({ run, isLoaded, wait });
    run(['enable', `${domain()}/${LABEL}`], { quiet: true });
    try {
      run(['bootstrap', domain(), file]);
      return;
    } catch (err) {
      last = err;
      await wait(3000);
    }
  }
  throw new Error([
    `macOS wouldn't start the floor's service (${last?.message || 'launchctl bootstrap failed'}). The floor isn't running now.`,
    '',
    '  Try, in this order:',
    '    1. System Settings → General → Login Items (& Extensions) → "Allow in the Background": switch "node" on,',
    '       then: npm run service -- install',
    '    2. Wait a minute, then: npm run service -- install',
    '    3. Log out and back in (or restart the Mac), then: npm run service -- install',
    '',
    '  Meanwhile the floor can run in a Terminal window: npm start',
  ].join('\n'));
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: `127.0.0.1:${port}` }, timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function port() {
  const { config } = await import('../server/config.js');
  return config.port;
}

// The Obsidian vault has to be outside the folders macOS keeps services out of, or it stops
// updating once the floor runs as a service.
async function vaultLines() {
  const { config } = await import('../server/config.js');
  if (!config.vault) return [];
  const f = protectedFolder(config.vaultDir);
  if (!f) return [`Obsidian vault: ${config.vaultDir} (written live while the floor runs)`];
  return [
    `▲ Obsidian vault: ${config.vaultDir} is in your ${folderName(f)}, and macOS doesn't let`,
    '  background services write there, so the vault won\'t update. Set VAULT_DIR in .env to a folder',
    '  outside it (for example VAULT_DIR=~/Meridian Vault), then: npm run service -- restart',
  ];
}

function running() {
  const out = launchctl(['print', `${domain()}/${LABEL}`], { quiet: true });
  if (!out) return null;
  return {
    state: out.match(/\bstate = (\S+)/)?.[1] || 'unknown',
    pid: Number(out.match(/\bpid = (\d+)/)?.[1]) || null,
    runs: Number(out.match(/\bruns = (\d+)/)?.[1]) || null,
    lastExit: out.match(/\blast exit code = ([^\n]+)/)?.[1]?.trim() || null,
  };
}

const tail = (file, n) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(-n).join('\n') : '(no log yet)');

// MetaTrader 5 opens at login too, so the EA is back on its chart after a restart.
function addMt5LoginItem() {
  if (!fs.existsSync(MT5_APP)) return 'MetaTrader 5 isn\'t in /Applications: add it yourself in System Settings → General → Login Items.';
  try {
    const list = execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to get the name of every login item'], { encoding: 'utf8' });
    if (/MetaTrader 5/.test(list)) return 'MetaTrader 5 already opens at login.';
    execFileSync('/usr/bin/osascript', ['-e', `tell application "System Events" to make login item at end with properties {path:"${MT5_APP}", hidden:false}`]);
    return 'MetaTrader 5 now opens at login as well.';
  } catch {
    return 'Couldn\'t add MetaTrader 5 to Login Items (macOS asked for permission?): add it in System Settings → General → Login Items.';
  }
}

// After a `git pull` that added a dependency (e.g. the entry-chart renderer), install it
// before the service restarts: the service runs the code as it is on disk.
function ensureDeps(root = ROOT) {
  const pkg = path.join(root, 'package.json');
  const marker = path.join(root, 'node_modules', '.package-lock.json');
  try {
    if (fs.existsSync(marker) && fs.statSync(marker).mtimeMs >= fs.statSync(pkg).mtimeMs) return;
  } catch { /* install below */ }
  console.log('\n  New packages for the floor: installing them first (about a minute)…');
  const npm = process.env.npm_execpath;
  try {
    if (npm) execFileSync(process.execPath, [npm, 'install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
    else execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
  } catch {
    console.log('  The install didn\'t finish (no internet?). The floor still runs; run npm install later.');
  }
}

// What install writes for the floor at `root` with this Node.
const plistAt = (root) => plistFor({ root, node: stableNode(), logDir: path.join(root, 'data', 'logs') });

async function install() {
  const file = plistPath();
  const p = await port();
  // A floor already running in a Terminal window holds the port: the service couldn't start.
  const before = await health(p);
  const svc = running();
  if (before && !before.service && !svc?.pid) {
    console.log(`\n  The floor is already running in a Terminal window (port ${p}), so the service couldn't start.`);
    console.log('  Close that window (or press Ctrl+C in it; it closes the floor\'s FTMO positions), then run this again:');
    console.log('    npm run service -- install\n');
    process.exitCode = 1;
    return;
  }
  let root = ROOT;
  const from = protectedFolder(root);
  // Already installed, up to date and answering: nothing to set up, so don't stop it (a stop
  // closes the floor's FTMO positions).
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!from && svc?.pid && before?.service && current === plistAt(root)) {
    ensureDeps(root);
    console.log(`\n  ✓ Already installed and running: the floor is on at http://localhost:${p} (up ${Math.round((before.uptime || 0) / 60)} min).`);
    console.log('    After a git pull, use: npm run service -- restart');
    for (const l of await vaultLines()) console.log(`    ${l}`);
    console.log('');
    return;
  }
  if (from) {
    if (svc) await unload();
    root = moveOut(root);
    console.log(`\n  Moved the floor from your ${from} to ${root}: macOS doesn't let background services`);
    console.log(`  read the ${from}, so the service couldn't start the floor there. A link with the same name`);
    console.log(`  stays in your ${from}, so it opens and works exactly as before.`);
  }
  ensureDeps(root);
  const logDir = path.join(root, 'data', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (running()) console.log('\n  Stopping the floor to set the service up again (it closes its FTMO positions first)…');
  await unload();
  fs.writeFileSync(file, plistAt(root));
  await load(file);
  let h = null;
  for (let i = 0; i < 40 && !h?.service; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    h = await health(p);
  }
  console.log('');
  if (!h) {
    console.log('  ▲ Installed, but the floor isn\'t answering yet. In a minute, check with: npm run service -- status');
    console.log('    (it shows why if it doesn\'t start).\n');
    return;
  }
  console.log(`  ✓ The floor now runs non-stop at http://localhost:${p}`);
  console.log('    It starts at every login, restarts by itself if it stops, and keeps the Mac awake.');
  console.log(`    ${addMt5LoginItem()}`);
  for (const l of await vaultLines()) console.log(`    ${l}`);
  console.log('');
  console.log('  Also, once:');
  console.log('    • FTMO tab: switch on "Stay armed after a restart".');
  console.log('    • System Settings → Battery (or Energy) → Options: "Prevent automatic sleeping on power adapter when the display is off" ON.');
  console.log('      On a MacBook keep it plugged in and the lid open (a closed lid sleeps the Mac anyway).');
  console.log('    • Don\'t run npm start any more while the service is on (the port is taken). Just open the address above.');
  console.log(`    • Logs: npm run service -- logs · stop for good: npm run service -- uninstall\n`);
}

async function uninstall() {
  const file = plistPath();
  const was = running();
  if (was) await unload();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  console.log(was || fs.existsSync(file) ? '\n  ✓ Stopped and removed. The floor\'s FTMO positions were closed on the way out; start it again with npm start.\n' : '\n  The service wasn\'t installed.\n');
}

async function status() {
  const installed = fs.existsSync(plistPath());
  const r = running();
  const p = await port();
  const h = await health(p);
  console.log('');
  if (!installed) console.log('  The service isn\'t installed (npm run service -- install).');
  else if (!r) console.log('  Installed, but launchd isn\'t running it. Try: npm run service -- restart');
  else console.log(`  Service: ${r.state}${r.pid ? ` (pid ${r.pid})` : ''}${r.runs > 1 ? ` · started ${r.runs} times since login` : ''}${!r.pid && r.lastExit ? ` · last exit: ${r.lastExit}` : ''}`);
  if (h) console.log(`  Floor: answering at http://localhost:${p} (${h.mode} mode, up ${Math.round(h.uptime / 60)} min${h.service === false ? ', in a Terminal window, not the service' : ''})`);
  else console.log(`  Floor: not answering on port ${p}, so MT5 can't connect to it.`);
  for (const l of await vaultLines()) console.log(`  ${l}`);
  if (installed && !h) {
    const from = protectedFolder(ROOT);
    if (from) {
      console.log(`\n  Why: the floor is in your ${from}, and macOS doesn't let background services read it.`);
      console.log('  Fix (moves it to your home folder and leaves a link in its place): npm run service -- install');
    } else {
      const err = tail(path.join(ROOT, 'data', 'logs', 'floor-error.log'), 8).trim();
      if (err && err !== '(no log yet)') console.log(`\n  Its last errors:\n${err.split('\n').map((l) => `    ${l}`).join('\n')}`);
      console.log('\n  Try: npm run service -- install   (it sets the service up again)');
    }
  }
  console.log('');
}

async function restart() {
  // Not running, or set up by an older version (e.g. still pointing at the Desktop): set it up again.
  const file = plistPath();
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!running() || protectedFolder(ROOT) || current !== plistAt(ROOT)) return install();
  ensureDeps();
  launchctl(['kickstart', '-k', `${domain()}/${LABEL}`]);
  console.log('\n  ✓ Restarting the floor (open FTMO positions are closed and, with "Stay armed" on, trading re-arms once MT5 is back).\n');
}

function logs() {
  const f = path.join(ROOT, 'data', 'logs', 'floor.log');
  const e = path.join(ROOT, 'data', 'logs', 'floor-error.log');
  console.log(`\n  ${f}\n${tail(f, 60)}`);
  const err = tail(e, 20).trim();
  if (err && err !== '(no log yet)') console.log(`\n  ${e}\n${err}`);
  console.log('');
}

async function main() {
  const cmd = process.argv[2] || 'status';
  if (process.platform !== 'darwin') {
    console.log('\n  The background service is for macOS. On a Windows VPS, run the floor with Task Scheduler ("At startup", restart on failure) or NSSM; on Linux, with a systemd service.\n');
    return;
  }
  const cmds = { install, uninstall, status, restart, logs };
  if (!Object.hasOwn(cmds, cmd)) {
    console.log('\n  npm run service -- install | status | restart | logs | uninstall\n');
    return;
  }
  await cmds[cmd]();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n  ${err.message}\n`);
    process.exitCode = 1;
  });
}
