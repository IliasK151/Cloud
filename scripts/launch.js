#!/usr/bin/env node
// What the double-click files run on Windows (start.bat, start-demo.bat, update.bat):
//
//   node scripts/launch.js --live      check Node, install the floor's packages the first time
//   node scripts/launch.js --demo      (and after an update that added one), then run the floor
//                                      in this window. With the background service on, just
//                                      open the floor in the browser.
//   node scripts/launch.js --update    after git pull: new packages, and a service restart
//
// It only uses Node's own modules until the packages are installed.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from '../server/util/isMain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE = 18;
const onWindows = process.platform === 'win32';
const say = (t = '') => console.log(t ? `  ${t}` : '');

function openUrl(url) {
  const [cmd, args] = onWindows ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch { /* no browser */ }
}

// A folder that OneDrive syncs (Desktop and Documents often are): the floor's data, keys
// included, would be uploaded, and OneDrive locks files the floor writes every few seconds.
export const inOneDrive = (dir, env = process.env) => /[\\/]OneDrive( - [^\\/]+)?([\\/]|$)/i.test(dir)
  || [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].some((d) => d && dir.toLowerCase().startsWith(d.toLowerCase()));

export function npmInstall(root = ROOT) {
  say('Installing the floor\'s packages (the first time, about a minute)…');
  const npmCli = process.env.npm_execpath;
  const r = npmCli
    ? spawnSync(process.execPath, [npmCli, 'install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' })
    : spawnSync(onWindows ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', shell: onWindows });
  return r.status === 0;
}

async function main() {
  const args = process.argv.slice(2);
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE) {
    say(`Node.js ${process.version} is too old: version ${MIN_NODE} or newer is needed (the LTS from nodejs.org).`);
    say('Opening the download page. Install it, then start the floor again.');
    openUrl('https://nodejs.org/en/download');
    process.exitCode = 1;
    return;
  }
  if (onWindows && inOneDrive(ROOT)) {
    say(`▲ The floor is in a OneDrive folder (${ROOT}).`);
    say('  OneDrive uploads its data (your keys too) and locks the files it writes. Move the folder');
    say('  to your user folder (C:\\Users\\<you>\\trading-floor) and start it from there.');
    say();
  }

  const service = await import('./service.js');
  const win = onWindows ? await import('./serviceWindows.js') : null;
  const serviceInstalled = win ? win.installed() : fs.existsSync(service.plistPath());

  if (args.includes('--update')) {
    // The service restarts onto the new code, installing new packages first.
    if (win && serviceInstalled) return win.main('restart');
    if (!service.depsCurrent(ROOT) && !npmInstall()) {
      say('The install didn\'t finish. Check your internet connection and run update again.');
      process.exitCode = 1;
      return;
    }
    const { config } = await import('../server/config.js');
    const h = await service.health(config.port);
    if (!h) say('✓ Updated. Start the floor as usual.');
    else if (serviceInstalled) say('✓ Updated. Load the new code: npm run service -- restart');
    else say('✓ Updated. The floor is open in its own window: close that window and start it again to load the new code.');
    return;
  }

  const { config } = await import('../server/config.js');
  const url = `http://localhost:${config.port}`;
  // Running non-stop in the background already? Just open it.
  if (serviceInstalled) {
    let h = await service.health(config.port);
    for (let i = 0; i < 20 && !h; i++) {
      if (i === 0) say('The background service is installed; waiting for the floor to answer…');
      await new Promise((r) => setTimeout(r, 1000));
      h = await service.health(config.port);
    }
    if (h) {
      say(`The floor already runs in the background: opening ${url}`);
      openUrl(url);
      return;
    }
    say('The background service is installed but the floor isn\'t answering, so it runs in this window for now.');
    say('To see why and fix the service: npm run service -- status');
    say();
  }

  if (!service.depsCurrent(ROOT) && !npmInstall()) {
    say();
    say('The install failed. Check your internet connection and try again.');
    process.exitCode = 1;
    return;
  }
  // Run the floor right here: Ctrl+C or closing the window stops it (it flattens and saves).
  await import('../server/index.js');
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n  The floor couldn't start: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
