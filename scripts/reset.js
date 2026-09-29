// Wipes the saved track record (P&L, trades, stats) for both live and sim modes.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';

for (const mode of ['live', 'sim']) {
  const file = path.join(config.dataDir, `state-${mode}.json`);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log(`Removed ${file}`);
  }
}
console.log('Track record reset. Your webhook secret was kept.');
