import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMain } from '../server/util/isMain.js';
import { keepAwakeWindowsArgs } from '../server/util/platform.js';
import { protectedFolder } from '../server/util/macFolders.js';
import { searchRoots, locateExpertsFolders } from '../scripts/install-ea.js';
import { startupScript, batchPath, findMt5, startupFile } from '../scripts/serviceWindows.js';
import { servicePaths, supervisorAlive, requestService } from '../scripts/supervisor.js';
import { inOneDrive } from '../scripts/launch.js';
import { entriesToMove, safeEntry, findMoveFile, tarBin, FILE_RE } from '../scripts/move.js';
import { health } from '../scripts/service.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN_ENV = {
  USERPROFILE: 'C:\\Users\\Ilias',
  APPDATA: 'C:\\Users\\Ilias\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\Ilias\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
};

test('scripts know they were started directly, whatever the path looks like', () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(isMain(import.meta.url, self), true);
  assert.equal(isMain(import.meta.url, path.join(ROOT, 'scripts', 'doctor.js')), false);
  assert.equal(isMain(import.meta.url, null), false);
  // Every script that runs on its own uses the check that also holds on Windows.
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts')).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
    assert.doesNotMatch(src, /file:\/\/\$\{process\.argv\[1\]\}|new URL\(import\.meta\.url\)\.pathname/, `${f}: a check that fails on Windows`);
  }
});

test('npm scripts and double-click files work on Windows', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts)) assert.doesNotMatch(cmd, /^[A-Z_]+=/, `${name}: an environment assignment cmd.exe can't run`);
  assert.equal(pkg.scripts.demo, 'node server/index.js --demo');
  assert.equal(pkg.scripts.move, 'node scripts/move.js');
  for (const f of ['start.bat', 'start-demo.bat', 'update.bat', 'doctor.bat', 'setup-windows.ps1']) {
    const raw = fs.readFileSync(path.join(ROOT, f), 'latin1');
    assert.ok(!/[^\x00-\x7f]/.test(raw), `${f}: plain ASCII (Windows PowerShell 5.1 and cmd.exe misread anything else)`);
  }
  const attrs = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attrs, /^\*\.bat text eol=crlf$/m, 'batch files get Windows line endings in a clone and in the ZIP');
  assert.match(attrs, /^\*\.ps1 text eol=crlf$/m);
  const start = fs.readFileSync(path.join(ROOT, 'start.bat'), 'utf8');
  assert.match(start, /cd \/d "%~dp0"/, 'runs from its own folder');
  assert.match(start, /node scripts\\launch\.js --live/);
  assert.match(fs.readFileSync(path.join(ROOT, 'start-demo.bat'), 'utf8'), /launch\.js --demo/);
  assert.match(fs.readFileSync(path.join(ROOT, 'update.bat'), 'utf8'), /git pull --ff-only[\s\S]*launch\.js --update/);
});

test('the floor knows --demo and --live on the command line', () => {
  const run = (args, env = {}) => execFileSync(process.execPath, ['--input-type=module', '-e', "const { config } = await import('./server/config.js'); console.log(config.feed);", ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATA_DIR: tmp('floor-cfg-'), FEED: '', ...env },
  }).trim();
  assert.equal(run(['--', '--demo']), 'sim');
  assert.equal(run(['--', '--live'], { FEED: 'sim' }), 'live', 'the command line wins over FEED');
  assert.equal(run([], { FEED: 'sim' }), 'sim');
  assert.equal(run([]), 'live');
});

test('Windows stays awake while the floor runs, display free to turn off', () => {
  const args = keepAwakeWindowsArgs(4321);
  const script = args.at(-1);
  assert.deepEqual(args.slice(0, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden']);
  assert.match(script, /SetThreadExecutionState\(2147483649\)/, 'ES_CONTINUOUS | ES_SYSTEM_REQUIRED, not the display');
  assert.match(script, /Wait-Process -Id 4321\b/, 'and only for as long as the floor runs');
  // Windows has no folders that keep a background service out, unlike macOS.
  assert.equal(protectedFolder('C:\\Users\\Ilias\\Desktop\\trading-floor', 'C:\\Users\\Ilias', 'win32'), null);
});

test('the EA installer finds MT5 on Windows: AppData for every terminal, Program Files for portable ones', () => {
  const roots = searchRoots('win32', WIN_ENV, 'C:\\Users\\Ilias');
  assert.equal(roots[0].dir, path.join(WIN_ENV.APPDATA, 'MetaQuotes', 'Terminal'));
  assert.equal(roots[0].filter, undefined);
  assert.deepEqual(roots.slice(1).map((r) => r.dir), [WIN_ENV.ProgramFiles, WIN_ENV['ProgramFiles(x86)']]);
  assert.ok(roots[1].filter.test('FTMO MetaTrader 5') && !roots[1].filter.test('Microsoft Office'));
  // The layout MT5 makes: Terminal\<id>\MQL5\Experts, one per installed terminal.
  const appData = tmp('mt5-');
  for (const id of ['D0E8209F77C8CF37AD8BF550E51FF075', '2C68BEDDD4D2FCA2A7DB1A2B4D6E6AD8']) fs.mkdirSync(path.join(appData, 'MetaQuotes', 'Terminal', id, 'MQL5', 'Experts'), { recursive: true });
  fs.mkdirSync(path.join(appData, 'MetaQuotes', 'Terminal', 'Common', 'Files'), { recursive: true });
  const found = locateExpertsFolders(searchRoots('win32', { APPDATA: appData }, 'C:\\nowhere'));
  assert.equal(found.length, 2);
  assert.ok(found.every((f) => f.endsWith(path.join('MQL5', 'Experts'))));
  assert.deepEqual(searchRoots('darwin', {}, '/Users/x').map((r) => r.dir), ['/Users/x/Library/Application Support', '/Users/x/.wine', '/Users/x/.mt5']);
});

test('the Windows service starts at login from the Startup folder, hidden, with MT5', () => {
  assert.equal(startupFile(WIN_ENV, 'C:\\Users\\Ilias'), path.join(WIN_ENV.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Meridian Trading Floor.cmd'));
  // Paths go in as %USERPROFILE% / %ProgramFiles% (a Greek or accented user name can't trip
  // cmd.exe up), and a literal % is doubled.
  assert.equal(batchPath('C:\\Users\\Ilias\\trading-floor', WIN_ENV), '%USERPROFILE%\\trading-floor');
  assert.equal(batchPath('C:\\Program Files\\nodejs\\node.exe', WIN_ENV), '%ProgramFiles%\\nodejs\\node.exe');
  assert.equal(batchPath('D:\\100% floor', WIN_ENV), 'D:\\100%% floor');
  const s = startupScript({ root: 'C:\\Users\\Ilias\\trading-floor', node: 'C:\\Program Files\\nodejs\\node.exe', mt5: 'C:\\Program Files\\FTMO MetaTrader 5\\terminal64.exe', env: WIN_ENV });
  assert.ok(s.endsWith('\r\n') && !/[^\r]\n/.test(s), 'Windows line endings');
  assert.match(s, /^@echo off\r\n/);
  assert.match(s, /cd \/d "%USERPROFILE%\\trading-floor"/);
  assert.match(s, /"%ProgramFiles%\\nodejs\\node\.exe" "%USERPROFILE%\\trading-floor\\scripts\\supervisor\.js" --detach/);
  assert.match(s, /tasklist \/FI "IMAGENAME eq terminal64\.exe" 2>nul \| find \/I "terminal64\.exe" >nul \|\| start "" "%ProgramFiles%\\FTMO MetaTrader 5\\terminal64\.exe"/, 'MT5 too, unless it is open already');
  assert.doesNotMatch(startupScript({ root: 'C:\\f', node: 'C:\\n.exe', mt5: null, env: WIN_ENV }), /terminal64/);
  // MT5 in Program Files, the FTMO one first.
  const dirs = { 'C:\\Program Files': ['MetaTrader 5', 'FTMO MetaTrader 5', 'Microsoft Office'], 'C:\\Program Files (x86)': [] };
  const readdir = (d) => (dirs[d] || []).map((name) => ({ name, isDirectory: () => true }));
  const exists = (f) => !/Office/.test(f);
  assert.equal(findMt5(WIN_ENV, { readdir, exists }), path.join('C:\\Program Files', 'FTMO MetaTrader 5', 'terminal64.exe'));
  assert.equal(findMt5(WIN_ENV, { readdir: () => [], exists }), null);
});

test('the supervisor is alive only while its heartbeat is', () => {
  const dir = tmp('sup-');
  const paths = servicePaths(dir, {});
  assert.equal(paths.pidFile, path.join(dir, 'data', 'service.json'));
  assert.equal(servicePaths(dir, { DATA_DIR: 'elsewhere' }).data, path.join(dir, 'elsewhere'));
  assert.equal(supervisorAlive(paths.pidFile), null, 'no file');
  fs.mkdirSync(paths.data, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(paths.pidFile, JSON.stringify({ pid: 123, beat: now - 5000 }));
  assert.equal(supervisorAlive(paths.pidFile, { now, exists: () => true }).pid, 123);
  assert.equal(supervisorAlive(paths.pidFile, { now, exists: () => false }), null, 'the process is gone');
  assert.equal(supervisorAlive(paths.pidFile, { now: now + 60_000, exists: () => true }), null, 'no heartbeat for a minute');
  requestService('restart', paths);
  assert.equal(JSON.parse(fs.readFileSync(paths.control, 'utf8')).cmd, 'restart');
});

test('the background service keeps the floor running and stops or restarts it cleanly', { timeout: 120_000 }, async () => {
  const dataDir = tmp('floor-svc-');
  const base = 46_000 + Math.floor(Math.random() * 1000) * 3;
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(base), WEBHOOK_PORT: String(base + 1), WIDGET_PORT: String(base + 2), CI: '1', FEED: 'sim', KEEP_AWAKE: '0', VAULT: '0' };
  const sup = spawn(process.execPath, ['--input-type=module', '-e', "const m = await import('./scripts/supervisor.js'); await m.run();"], { cwd: ROOT, env, stdio: 'ignore' });
  const paths = servicePaths(ROOT, { DATA_DIR: dataDir });
  const until = async (f, ms = 60_000) => {
    const end = Date.now() + ms;
    let v = null;
    while (!(v = await f()) && Date.now() < end) await sleep(250);
    return v;
  };
  try {
    const h1 = await until(() => health(base));
    assert.ok(h1, 'the floor answers');
    assert.equal(h1.service, true, 'and knows it runs as the service');
    const s = supervisorAlive(paths.pidFile);
    assert.equal(s?.pid, sup.pid);
    // Restart: the floor is asked to stop (it saves and flattens), then started again.
    requestService('restart', paths);
    await until(async () => !(await health(base)), 30_000);
    const h2 = await until(() => health(base));
    assert.ok(h2 && h2.uptime < h1.uptime + 5, 'a fresh floor');
    const log = fs.readFileSync(path.join(dataDir, 'logs', 'floor.log'), 'utf8');
    assert.match(log, /\[service\] .* floor started[\s\S]*restart asked[\s\S]*floor stopped \(exit code 0\)[\s\S]*floor started/, log.slice(-2000));
    assert.match(log, /Flattening all desks and saving the track record/, 'it shut down the way Ctrl+C does');
    assert.ok(fs.existsSync(path.join(dataDir, 'state-sim.json')), 'and saved the track record');
    // Stop: the floor stops, and so does the supervisor.
    requestService('stop', paths);
    const code = await new Promise((resolve) => sup.on('exit', resolve));
    assert.equal(code, 0);
    assert.equal(await health(base), null);
    assert.equal(fs.existsSync(paths.pidFile), false);
  } finally {
    if (sup.exitCode == null) sup.kill();
  }
});

test('a floor in its own window stops cleanly when the window closes (SIGHUP)', { timeout: 90_000 }, async () => {
  const dataDir = tmp('floor-hup-');
  const base = 49_000 + Math.floor(Math.random() * 1000) * 3;
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(base), WEBHOOK_PORT: String(base + 1), WIDGET_PORT: String(base + 2), OPEN_BROWSER: '0', CI: '1', FEED: 'sim', KEEP_AWAKE: '0', VAULT: '0' };
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const end = Date.now() + 60_000;
    while (!/Floor & dashboard/.test(out) && Date.now() < end) await sleep(200);
    child.kill('SIGHUP');
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, out.slice(-1500));
    assert.match(out, /Flattening all desks and saving the track record/);
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
  }
});

test('the double-click start warns about a OneDrive folder', () => {
  assert.equal(inOneDrive('C:\\Users\\Ilias\\OneDrive\\Desktop\\trading-floor', {}), true);
  assert.equal(inOneDrive('C:\\Users\\Ilias\\OneDrive - Contoso\\Documents\\trading-floor', {}), true);
  assert.equal(inOneDrive('D:\\Sync\\trading-floor', { OneDrive: 'D:\\Sync' }), true);
  assert.equal(inOneDrive('C:\\Users\\Ilias\\trading-floor', { OneDrive: 'C:\\Users\\Ilias\\OneDrive' }), false);
});

test('moving the floor: everything it saved goes, what only works on one computer stays', async () => {
  const data = tmp('floor-data-');
  for (const d of ['history', 'logs', 'bin', 'voice-engine', 'neural', 'reports']) fs.mkdirSync(path.join(data, d));
  for (const f of ['live.json', 'state-live.json', 'telegram.json', 'bridge-token.txt', 'service.json', '.gitkeep', '.DS_Store', 'x.part']) fs.writeFileSync(path.join(data, f), '{}');
  fs.writeFileSync(path.join(data, 'history', 'NAS100.json'), '[]');
  assert.deepEqual(entriesToMove(data), ['bridge-token.txt', 'history', 'live.json', 'neural', 'reports', 'state-live.json', 'telegram.json']);
  // Nothing in the file may land outside data/.
  assert.equal(safeEntry('history/NAS100.json'), true);
  assert.equal(safeEntry('./live.json'), true);
  for (const bad of ['/etc/passwd', '../x', 'history/../../x', 'C:\\Windows\\x', 'c:/x', '..\\x', '']) assert.equal(safeEntry(bad), false, bad);
  assert.ok(FILE_RE.test('trading-floor-data-2026-10-16.tgz') && !FILE_RE.test('trading-floor-data-2026-10-16.tgz.exe'));
  // The newest move file, wherever it is.
  const a = tmp('dl-');
  const b = tmp('desk-');
  fs.writeFileSync(path.join(a, 'trading-floor-data-2026-10-01.tgz'), 'x');
  fs.writeFileSync(path.join(b, 'trading-floor-data-2026-10-16.tgz'), 'x');
  fs.utimesSync(path.join(a, 'trading-floor-data-2026-10-01.tgz'), new Date(2026, 9, 1), new Date(2026, 9, 1));
  assert.equal(findMoveFile([a, b, path.join(a, 'missing')]), path.join(b, 'trading-floor-data-2026-10-16.tgz'));
  assert.equal(findMoveFile([path.join(a, 'missing')]), null);
  // Windows' own tar, not one on the PATH that reads C:\ as a host name.
  assert.equal(tarBin('win32', { SystemRoot: 'C:\\Windows' }, () => true), path.join('C:\\Windows', 'System32', 'tar.exe'));
  assert.equal(tarBin('darwin'), 'tar');
});

test('npm run move: export on the old computer, import on the new one, keys and all', { timeout: 60_000 }, () => {
  const run = (args, dataDir, extraEnv = {}) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'move.js'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir, PORT: '3330', HOME: extraEnv.HOME || process.env.HOME, ...extraEnv } }) };
    } catch (err) {
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };
  const mac = tmp('mac-data-');
  fs.mkdirSync(path.join(mac, 'history'));
  fs.mkdirSync(path.join(mac, 'logs'));
  fs.writeFileSync(path.join(mac, 'history', 'XAUUSD.json'), JSON.stringify({ level: 'mt5', bars: [[1, 2, 3, 1, 2, 1]] }));
  fs.writeFileSync(path.join(mac, 'live.json'), JSON.stringify({ profiles: { 1: { size: 100000 } } }));
  fs.writeFileSync(path.join(mac, 'bridge-token.txt'), 'mac-token\n');
  fs.writeFileSync(path.join(mac, 'logs', 'floor.log'), 'old log');
  const out = path.join(tmp('move-'), 'trading-floor-data-test.tgz');
  const ex = run(['export', out], mac);
  assert.equal(ex.code, 0, ex.out);
  assert.match(ex.out, /Saved everything the floor has/);
  assert.match(ex.out, /don't email or share it/);
  const names = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' });
  assert.match(names, /history\/XAUUSD\.json/);
  assert.doesNotMatch(names, /logs/, 'logs stay behind');
  // The new computer: a fresh floor made its own keys already; they're kept aside, not lost.
  const pc = tmp('pc-data-');
  fs.writeFileSync(path.join(pc, 'bridge-token.txt'), 'new-token\n');
  const im = run(['import', out], pc);
  assert.equal(im.code, 0, im.out);
  assert.equal(fs.readFileSync(path.join(pc, 'bridge-token.txt'), 'utf8'), 'mac-token\n', 'the same token: the EA keeps working with it');
  assert.ok(fs.existsSync(path.join(pc, 'history', 'XAUUSD.json')));
  assert.match(im.out, /price history for 1 market/);
  assert.match(im.out, /the FTMO account setup/);
  assert.match(im.out, /Delete .* now: it holds your keys/);
  const aside = fs.readdirSync(path.dirname(pc)).find((n) => n.startsWith(`${path.basename(pc)}-before-import-`));
  assert.ok(aside, 'what was there before is kept aside');
  assert.equal(fs.readFileSync(path.join(path.dirname(pc), aside, 'bridge-token.txt'), 'utf8'), 'new-token\n');
  // A file that would write outside data/ is refused.
  const evil = tmp('evil-');
  fs.writeFileSync(path.join(evil, 'x.json'), '{}');
  const evilTgz = path.join(evil, 'trading-floor-data-evil.tgz');
  execFileSync('tar', ['-czf', evilTgz, '-C', evil, '-P', `${evil}/x.json`]);
  const bad = run(['import', evilTgz], tmp('pc2-'));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /isn't a move file from the floor/);
});
