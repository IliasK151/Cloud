// Market clock and New York session helpers (DST-aware, no dependencies).
//
// Live mode:  the trading day rolls at 18:00 New York (futures/FX reopen), and every
//             desk goes flat between 16:50 and 18:00 NY like an intraday book should.
// Sim mode:   a virtual clock runs the cash session 09:30–16:00 NY at SIM_SPEED and
//             jumps to the next morning after the close.

const nyFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short',
});

const partsCache = new Map();

export function nyParts(ms) {
  const key = Math.floor(ms / 1000);
  const hit = partsCache.get(key);
  if (hit) return hit;
  const p = {};
  for (const part of nyFormatter.formatToParts(new Date(key * 1000))) p[part.type] = part.value;
  const out = {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour % 24, minute: +p.minute, second: +p.second,
    weekday: p.weekday,
  };
  if (partsCache.size > 2000) partsCache.clear();
  partsCache.set(key, out);
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

export function nyMinuteOfDay(ms) {
  const p = nyParts(ms);
  return p.hour * 60 + p.minute;
}

export function nyDateKey(ms) {
  const p = nyParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function nyOffsetMs(ms) {
  const p = nyParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Epoch ms of a New York wall-clock time.
export function nyWallToMs(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - nyOffsetMs(guess);
  const corrected = guess - nyOffsetMs(ms);
  if (corrected !== ms) ms = corrected;
  return ms;
}

export function nyTimeOnSameDay(ms, hour, minute) {
  const p = nyParts(ms);
  return nyWallToMs(p.year, p.month, p.day, hour, minute);
}

export function fmtNyTime(ms) {
  const p = nyParts(ms);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export class MarketClock {
  constructor(mode, speed = 1) {
    this.mode = mode;
    this.speed = mode === 'sim' ? speed : 1;
    if (mode === 'sim') {
      // Start the virtual session at today's 09:30 New York open (weekday).
      let open = nyTimeOnSameDay(Date.now(), 9, 30);
      while (isWeekend(open)) open += 86_400_000;
      this.t = open;
    }
  }

  now() {
    return this.mode === 'sim' ? this.t : Date.now();
  }

  advance(realMs) {
    if (this.mode === 'sim') this.t += realMs * this.speed;
  }

  // Sim only: after the 16:00 close jump to the next weekday's 09:30 open.
  sessionOver() {
    return this.mode === 'sim' && nyMinuteOfDay(this.t) >= 16 * 60;
  }

  jumpToNextOpen() {
    let next = nyTimeOnSameDay(this.t + 86_400_000, 9, 30);
    while (isWeekend(next)) next = nyTimeOnSameDay(next + 86_400_000, 9, 30);
    const from = this.t;
    this.t = next;
    return { from, to: next };
  }
}

function isWeekend(ms) {
  const wd = nyParts(ms).weekday;
  return wd === 'Sat' || wd === 'Sun';
}

export class Session {
  constructor(clock) {
    this.clock = clock;
    this.mode = clock.mode;
  }

  // Key identifying the trading day that `ms` belongs to.
  tradingDay(ms = this.clock.now()) {
    if (this.mode === 'sim') return nyDateKey(ms);
    // Live: 18:00 NY rolls into the next trading day.
    return nyDateKey(ms + 6 * 3_600_000);
  }

  // No new risk and positions are flattened inside this window.
  isFlattenWindow(ms = this.clock.now()) {
    const m = nyMinuteOfDay(ms);
    if (this.mode === 'sim') return m >= 15 * 60 + 55;
    return m >= 16 * 60 + 50 && m < 18 * 60;
  }

  // Epoch ms when the current trading day began.
  dayStart(ms = this.clock.now()) {
    if (this.mode === 'sim') return nyTimeOnSameDay(ms, 9, 30);
    const m = nyMinuteOfDay(ms);
    const sixPm = nyTimeOnSameDay(ms, 18, 0);
    return m >= 18 * 60 ? sixPm : nyTimeOnSameDay(ms - 86_400_000, 18, 0);
  }

  nyOpen(ms = this.clock.now()) {
    return nyTimeOnSameDay(ms, 9, 30);
  }

  londonOpen(ms = this.clock.now()) {
    return nyTimeOnSameDay(ms, 3, 0);
  }

  // Anchor for session VWAP: the NY cash open once it has happened, otherwise the day start.
  vwapAnchor(ms = this.clock.now()) {
    const open = this.nyOpen(ms);
    const start = this.dayStart(ms);
    return ms >= open && open >= start ? open : start;
  }

  label(ms = this.clock.now()) {
    const m = nyMinuteOfDay(ms);
    if (this.isFlattenWindow(ms)) return 'Close';
    if (m >= 9 * 60 + 30 && m < 16 * 60) return 'New York';
    if (m >= 3 * 60 && m < 9 * 60 + 30) return 'London';
    return 'Asia';
  }
}
