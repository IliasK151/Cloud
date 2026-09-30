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

export const LABEL = 'com.meridiancapital.floor';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MT5_APP = '/Applications/MetaTrader 5.app';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

function running() {
  const out = launchctl(['print', `${domain()}/${LABEL}`], { quiet: true });
  if (!out) return null;
  return { state: out.match(/\bstate = (\S+)/)?.[1] || 'unknown', pid: Number(out.match(/\bpid = (\d+)/)?.[1]) || null, runs: Number(out.match(/\bruns = (\d+)/)?.[1]) || null };
}

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

async function install() {
  const file = plistPath();
  const logDir = path.join(ROOT, 'data', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (running()) launchctl(['bootout', `${domain()}/${LABEL}`], { quiet: true });
  fs.writeFileSync(file, plistFor({ logDir }));
  launchctl(['bootstrap', domain(), file]);
  launchctl(['enable', `${domain()}/${LABEL}`], { quiet: true });
  const p = await port();
  let h = null;
  for (let i = 0; i < 30 && !h; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    h = await health(p);
  }
  console.log('');
  console.log(h ? `  ✓ The floor now runs non-stop at http://localhost:${p}` : '  ✓ Installed. The floor is starting (it can take a minute the first time).');
  console.log('    It starts at every login, restarts by itself if it stops, and keeps the Mac awake.');
  console.log(`    ${addMt5LoginItem()}`);
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
  if (was) launchctl(['bootout', `${domain()}/${LABEL}`], { quiet: true });
  if (fs.existsSync(file)) fs.unlinkSync(file);
  console.log(was || fs.existsSync(file) ? '\n  ✓ Stopped and removed. The floor\'s FTMO positions were closed on the way out; start it again with npm start.\n' : '\n  The service wasn\'t installed.\n');
}

async function status() {
  const r = running();
  const p = await port();
  const h = await health(p);
  console.log('');
  if (!fs.existsSync(plistPath())) console.log('  The service isn\'t installed (npm run service -- install).');
  else if (!r) console.log('  Installed, but launchd isn\'t running it. Try: npm run service -- restart');
  else console.log(`  Service: ${r.state}${r.pid ? ` (pid ${r.pid})` : ''}${r.runs > 1 ? ` · restarted ${r.runs - 1} time(s) since login` : ''}`);
  console.log(h ? `  Floor: answering at http://localhost:${p} (${h.mode} mode, up ${Math.round(h.uptime / 60)} min)` : `  Floor: not answering on port ${p} yet.`);
  console.log('');
}

async function restart() {
  if (!running()) return install();
  launchctl(['kickstart', '-k', `${domain()}/${LABEL}`]);
  console.log('\n  ✓ Restarting the floor (open FTMO positions are closed and, with "Stay armed" on, trading re-arms once MT5 is back).\n');
}

function logs() {
  const f = path.join(ROOT, 'data', 'logs', 'floor.log');
  const e = path.join(ROOT, 'data', 'logs', 'floor-error.log');
  const tail = (file, n) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(-n).join('\n') : '(no log yet)');
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
