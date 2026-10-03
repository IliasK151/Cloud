import os from 'node:os';
import path from 'node:path';

// macOS privacy protection keeps background services out of Desktop, Documents, Downloads
// and iCloud Drive: a service started from there can't read its own files, so the floor
// never comes up and MT5 has nothing to connect to, and a vault kept there stops updating
// once the floor runs as a service.
const PROTECTED = ['Desktop', 'Documents', 'Downloads', path.join('Library', 'Mobile Documents')];

export function protectedFolder(dir, home = os.homedir()) {
  for (const p of PROTECTED) {
    const base = path.join(home, p);
    if (dir === base || dir.startsWith(base + path.sep)) return p.split(path.sep).at(-1);
  }
  return null;
}

export const folderName = (f) => (f === 'Mobile Documents' ? 'iCloud Drive' : f);
