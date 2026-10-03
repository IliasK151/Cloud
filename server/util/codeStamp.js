import fs from 'node:fs';
import path from 'node:path';

// When the floor's code last changed on disk: the newest server file (or package.json). A
// `git pull` rewrites the files it changes, so a running floor older than this is running the
// old code (the page, served from disk, is already the new one).
export function codeStamp(root) {
  let newest = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|json)$/.test(e.name)) {
        try {
          newest = Math.max(newest, fs.statSync(p).mtimeMs);
        } catch { /* gone meanwhile */ }
      }
    }
  };
  walk(path.join(root, 'server'));
  try {
    newest = Math.max(newest, fs.statSync(path.join(root, 'package.json')).mtimeMs);
  } catch { /* none */ }
  return newest;
}

// Is a floor that started at `startedAt` (ms) older than the code on disk? A little slack for
// files written while it was starting.
export const codeIsNewer = (root, startedAt) => codeStamp(root) > startedAt + 5_000;
