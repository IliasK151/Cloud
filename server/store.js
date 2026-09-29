import fs from 'node:fs';
import path from 'node:path';

// Persists the fund's track record (P&L, trades, stats) between restarts.
// One file per mode so simulated results never mix with live paper trading.
export class Store {
  constructor(dir, mode) {
    this.file = path.join(dir, `state-${mode}.json`);
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  save(data) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
  }

  reset() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* nothing to remove */
    }
  }
}
