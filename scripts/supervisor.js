#!/usr/bin/env node
// The floor's background service on Windows (npm run service -- install). It runs the floor
// hidden, starts it again if it ever stops (at most every 30 seconds), and stops or restarts
// it cleanly when npm run service asks, through data/service-control.json. Windows has no
// signal that lets a program finish up, so the floor is asked over its own channel: it closes
// its FTMO positions and saves its track record first, as Ctrl+C does.
//
// The Startup-folder file that npm run service -- install writes starts it at every login:
//   node scripts/supervisor.js --detach    (starts it hidden, then returns at once)

import fs from 'node:fs';
import path from 'node:path';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../server/util/env.js';
import { isMain } from '../server/util/isMain.js';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const RESTART_THROTTLE_MS = 30_000;
const STOP_TIMEOUT_MS = 45_000; // closing FTMO positions waits for MT5
const BEAT_MS = 10_000;
const DEAD_AFTER_MS = 45_000; // no heartbeat for this long: the supervisor is gone

export function servicePaths(root = ROOT, env = process.env) {
  const data = path.resolve(root, env.DATA_DIR || 'data');
  return {
    data,
    pidFile: path.join(data, 'service.json'),
    control: path.join(data, 'service-control.json'),
    logs: path.join(data, 'logs'),
  };
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// The running supervisor ({ pid, startedAt, beat, root }), or null if none is alive.
export function supervisorAlive(pidFile, { now = Date.now(), exists = processExists } = {}) {
  const s = readJson(pidFile);
  if (!s?.pid || now - (s.beat || 0) > DEAD_AFTER_MS) return null;
  return exists(s.pid) ? s : null;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Ask the running supervisor to 'restart' or 'stop' the floor.
export function requestService(cmd, paths = servicePaths()) {
  fs.mkdirSync(paths.data, { recursive: true });
  fs.writeFileSync(paths.control, JSON.stringify({ cmd, at: Date.now() }));
}

// Start the supervisor hidden, detached from this window, and return at once.
export function spawnDetached({ node = process.execPath, root = ROOT } = {}) {
  const child = spawn(node, [path.join(root, 'scripts', 'supervisor.js')], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

export async function run({ root = ROOT, serverFile = path.join(root, 'server', 'index.js') } = {}) {
  loadEnv(path.join(root, '.env'));
  const paths = servicePaths(root);
  fs.mkdirSync(paths.logs, { recursive: true });
  const out = fs.createWriteStream(path.join(paths.logs, 'floor.log'), { flags: 'a' });
  const err = fs.createWriteStream(path.join(paths.logs, 'floor-error.log'), { flags: 'a' });
  const note = (t) => out.write(`[service] ${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${t}\n`);

  const other = supervisorAlive(paths.pidFile);
  if (other && other.pid !== process.pid) {
    note(`already running (pid ${other.pid}); this one stops`);
    return;
  }
  const startedAt = Date.now();
  const myCode = fs.statSync(SELF).mtimeMs;
  const beat = () => fs.writeFileSync(paths.pidFile, JSON.stringify({ pid: process.pid, startedAt, beat: Date.now(), root }));
  beat();
  setInterval(beat, BEAT_MS).unref?.();
  fs.rmSync(paths.control, { force: true });

  let child = null;
  let childStarted = 0;
  let onStopped = null;
  let restartTimer = null;

  const start = () => {
    childStarted = Date.now();
    child = fork(serverFile, [], {
      cwd: root,
      execArgv: [], // not the supervisor's own Node options
      env: { ...process.env, OPEN_BROWSER: '0', FLOOR_SERVICE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(err, { end: false });
    note(`floor started (pid ${child.pid})`);
    child.on('exit', (code, signal) => {
      child = null;
      note(`floor stopped (${signal || `exit code ${code}`})`);
      if (onStopped) return onStopped();
      // Stopped by itself: start it again, but not more than every 30 seconds.
      const wait = Math.max(0, RESTART_THROTTLE_MS - (Date.now() - childStarted));
      restartTimer = setTimeout(start, wait);
    });
  };

  const stopFloor = () => new Promise((resolve) => {
    clearTimeout(restartTimer);
    if (!child) return resolve();
    const c = child;
    const force = setTimeout(() => {
      note('the floor didn\'t stop in time; ending it');
      try { c.kill(); } catch { /* gone */ }
    }, STOP_TIMEOUT_MS);
    onStopped = () => {
      clearTimeout(force);
      onStopped = null;
      resolve();
    };
    try {
      c.send({ type: 'shutdown' });
    } catch {
      c.kill();
    }
  });

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    const req = readJson(paths.control);
    if (!req) return;
    fs.rmSync(paths.control, { force: true });
    if (!['stop', 'restart'].includes(req.cmd)) return;
    busy = true;
    note(`${req.cmd} asked`);
    await stopFloor();
    // Stopping, or this supervisor's own code changed (git pull): end here. For a restart a
    // fresh supervisor takes over, running the new code.
    const newer = fs.statSync(SELF).mtimeMs > myCode;
    if (req.cmd === 'stop' || newer) {
      fs.rmSync(paths.pidFile, { force: true });
      if (req.cmd === 'restart') spawnDetached({ root });
      note(req.cmd === 'stop' ? 'service stopped' : 'handing over to the updated service');
      out.end(() => process.exit(0));
      return;
    }
    start();
    busy = false;
  }, 1000);

  start();
}

if (isMain(import.meta.url)) {
  if (process.argv.includes('--detach')) spawnDetached();
  else run().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
