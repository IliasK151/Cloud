import { ema, atr, rsi, resample, swings, anchoredVwap } from '../market/indicators.js';
import { classifyRegime } from '../research/context.js';
import { eventLabel } from '../market/calendar.js';
import { SYMBOLS } from '../market/symbols.js';

// The market brain: one shared, multi-timeframe read of every market that all the agents
// reason from. Each factor is a number from -1 (bearish) to +1 (bullish) with a sentence
// explaining it, plus the levels that matter (session high/low, prior day, swing points,
// VWAP). `assess` turns a read into the case for and against a specific trade.

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const fin = Number.isFinite;

function trendOf(bars, label) {
  if (bars.length < 55) return null;
  const c = bars.map((b) => b.close);
  const e20 = ema(c, 20);
  const e50 = ema(c, 50);
  const a = atr(bars, 14);
  const n = bars.length - 1;
  const at = a[n];
  if (!(at > 0)) return null;
  const sep = (e20[n] - e50[n]) / at;
  const slope = (e50[n] - e50[n - 5]) / at;
  const value = clamp(0.55 * Math.tanh(sep / 1.5) + 0.45 * Math.tanh(slope / 0.6));
  const word = value > 0.35 ? 'up' : value < -0.35 ? 'down' : 'flat';
  return { value, word, text: word === 'flat' ? `${label} trend is flat` : `${label} trend is ${word} (EMA 20 ${sep > 0 ? 'above' : 'below'} EMA 50)` };
}

function structureOf(bars) {
  const { highs, lows } = swings(bars, 2, 90);
  if (highs.length < 2 || lows.length < 2) return { value: 0, text: 'no clear swing structure yet', word: 'unclear' };
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const hh = h2.price > h1.price;
  const hl = l2.price > l1.price;
  if (hh && hl) return { value: 1, word: 'higher highs and higher lows', text: 'structure is making higher highs and higher lows' };
  if (!hh && !hl) return { value: -1, word: 'lower highs and lower lows', text: 'structure is making lower highs and lower lows' };
  return { value: hh ? 0.3 : -0.3, word: 'mixed', text: `structure is mixed (${hh ? 'higher highs, lower lows' : 'lower highs, higher lows'})` };
}

function uniqLevels(levels, price, tol) {
  const out = [];
  for (const l of levels.filter((x) => fin(x.price)).sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))) {
    if (!out.some((o) => Math.abs(o.price - l.price) < tol)) out.push(l);
  }
  return out;
}

export class MarketBrain {
  constructor({ md, session, clock, news = null, history = null }) {
    this.md = md;
    this.session = session;
    this.clock = clock;
    this.news = news;
    this.history = history;
    this.cache = new Map();
  }

  #bars(symbol) {
    const live = this.md.bars(symbol);
    const h = this.history?.ready ? this.history.recent(symbol, 5000) : null;
    return h && h.length > live.length ? h : live;
  }

  // The current read of a market (cached until the next 1-minute bar closes).
  read(symbol) {
    // Cheap cache check first: the feed's last closed bar.
    const liveBars = this.md.bars(symbol);
    const liveT = liveBars.length ? liveBars[liveBars.length - 1].time : null;
    const hit = this.cache.get(symbol);
    if (hit && liveT != null && hit.feedTime === liveT) return hit;
    const bars = this.#bars(symbol);
    if (bars.length < 120) return null;
    const lastT = bars[bars.length - 1].time;

    const price = this.md.price(symbol) || bars[bars.length - 1].close;
    const b5 = resample(bars.slice(-1800), 5);
    const b15 = resample(bars.slice(-3600), 15);
    const b60 = resample(bars, 60);
    const htf = trendOf(b60, 'the hourly') || trendOf(b15, 'the 15-minute') || { value: 0, word: 'flat', text: 'not enough history for the higher-timeframe trend' };
    const mid = trendOf(b15, 'the 15-minute') || trendOf(b5, 'the 5-minute') || { value: 0, word: 'flat', text: 'the intraday trend is unclear' };
    const structure = structureOf(b5);
    const r = rsi(b5.map((b) => b.close), 14);
    const rNow = r[r.length - 1];
    const momentum = fin(rNow) ? { value: clamp((rNow - 50) / 22), rsi: Math.round(rNow), text: `momentum ${rNow >= 55 ? 'is strong' : rNow <= 45 ? 'is weak' : 'is neutral'} (5-minute RSI ${Math.round(rNow)})` } : { value: 0, rsi: null, text: 'momentum unclear' };

    // Session VWAP and how stretched price is from it.
    const now = this.clock.now();
    const anchorSec = Math.floor(this.session.vwapAnchor(now) / 1000);
    let from = bars.findIndex((b) => b.time >= anchorSec);
    if (from < 0 || bars.length - from < 5) from = Math.max(0, bars.length - 120);
    const { vwap, sd } = anchoredVwap(bars, from);
    const a1 = atr(bars.slice(-200), 14);
    const atr1 = a1[a1.length - 1];
    const vw = vwap[vwap.length - 1];
    const vsd = Math.max(sd[sd.length - 1] || 0, (atr1 || 0) * 1.5);
    const z = vsd > 0 ? (price - vw) / vsd : 0;

    // Volatility regime: where 5-minute ATR sits in its own recent range.
    const a5 = atr(b5, 14).filter(fin);
    const cur5 = a5[a5.length - 1];
    const sorted = a5.slice(-200).sort((x, y) => x - y);
    const volPct = sorted.length > 20 ? sorted.filter((x) => x < cur5).length / sorted.length : 0.5;

    // Levels that matter.
    const dayStartSec = Math.floor(this.session.dayStart(now) / 1000);
    const today = bars.filter((b) => b.time >= dayStartSec);
    const prevStartSec = dayStartSec - 86_400;
    const prev = bars.filter((b) => b.time >= prevStartSec && b.time < dayStartSec);
    const levels = [];
    if (today.length > 5) {
      levels.push({ label: 'session high', price: Math.max(...today.map((b) => b.high)) });
      levels.push({ label: 'session low', price: Math.min(...today.map((b) => b.low)) });
    }
    if (prev.length > 30) {
      levels.push({ label: 'prior day high', price: Math.max(...prev.map((b) => b.high)) });
      levels.push({ label: 'prior day low', price: Math.min(...prev.map((b) => b.low)) });
    }
    const sw15 = swings(b15, 2, 120);
    for (const s of sw15.highs.slice(-4)) levels.push({ label: '15m swing high', price: s.price });
    for (const s of sw15.lows.slice(-4)) levels.push({ label: '15m swing low', price: s.price });
    const sw5 = swings(b5, 3, 90);
    for (const s of sw5.highs.slice(-3)) levels.push({ label: '5m swing high', price: s.price });
    for (const s of sw5.lows.slice(-3)) levels.push({ label: '5m swing low', price: s.price });
    if (fin(vw)) levels.push({ label: 'VWAP', price: vw });
    const tol = (cur5 || atr1 || price * 0.001) * 0.25;
    const lv = uniqLevels(levels, price, tol);
    const support = lv.filter((l) => l.price < price).sort((x, y) => y.price - x.price);
    const resistance = lv.filter((l) => l.price > price).sort((x, y) => x.price - y.price);

    const next = this.news?.next?.(symbol, now, 3 * 3_600_000) || null;
    const regime = classifyRegime(bars.slice(-2400));
    const bias = clamp(0.3 * htf.value + 0.25 * mid.value + 0.2 * structure.value + 0.15 * momentum.value + 0.1 * clamp(z / 1.5));

    const out = {
      symbol, time: lastT, feedTime: liveT, price, atr1, atr5: cur5, z, vwap: vw, volPct, regime,
      htf, mid, structure, momentum, support: support.slice(0, 4), resistance: resistance.slice(0, 4),
      news: next ? { label: eventLabel(next.event), impact: next.impact, minutes: Math.round((next.event.time - now) / 60_000) } : null,
      bias,
    };
    this.cache.set(symbol, out);
    return out;
  }

  // The case for and against one trade. Factors are signed in the trade's favour
  // (+ helps, - hurts), each with a sentence.
  assess(symbol, side, { entry = null, stop = null, target = null } = {}) {
    const r = this.read(symbol);
    if (!r) return null;
    const dir = side === 'LONG' ? 1 : -1;
    const px = entry ?? r.price;
    const dec = SYMBOLS[symbol]?.decimals ?? 2;
    const fmt = (x) => Number(x).toFixed(dec);
    const risk = stop != null ? Math.abs(px - stop) : (r.atr5 || r.atr1 || px * 0.002) * 1.5;
    const f = {};
    const say = (k, value, text) => { f[k] = { value: clamp(value), text }; };

    const trendText = (t, name) => (dir * t.value > 0.25 ? `${name} trend is ${t.word}, with the trade` : dir * t.value < -0.25 ? `it fights ${name} ${t.word}trend` : `${name} trend is flat`);
    say('htf', dir * r.htf.value, trendText(r.htf, 'the higher-timeframe'));
    say('trend', dir * r.mid.value, trendText(r.mid, 'the 15-minute'));
    say('structure', dir * r.structure.value, r.structure.text);
    say('momentum', dir * r.momentum.value, r.momentum.text);

    // Chasing: entering far from VWAP in the trade's direction.
    const zd = dir * r.z;
    if (zd >= 1.5) say('stretch', -Math.min(1, (zd - 1.2) / 1.5), `price is ${Math.abs(r.z).toFixed(1)}σ ${r.z > 0 ? 'above' : 'below'} VWAP, which is chasing`);
    else if (zd <= -1.2) say('stretch', 0.4, `price is ${Math.abs(r.z).toFixed(1)}σ ${r.z > 0 ? 'above' : 'below'} VWAP, a stretched level to fade from`);
    else say('stretch', 0.2, `price is close to VWAP (${r.z >= 0 ? '+' : ''}${r.z.toFixed(1)}σ), a fair location`);

    // Something to lean on: support under a long (resistance over a short).
    const behind = dir > 0 ? r.support.find((l) => l.price < px) : r.resistance.find((l) => l.price > px);
    const atr5 = r.atr5 || risk;
    if (behind) {
      const d = Math.abs(px - behind.price) / atr5;
      say('location', d <= 1 ? 0.6 : d <= 2.5 ? 0.2 : -0.2, d <= 1 ? `entering right off the ${behind.label} at ${fmt(behind.price)}` : `the nearest ${behind.label} is ${d.toFixed(1)} ATR away at ${fmt(behind.price)}`);
    } else {
      say('location', -0.3, `no ${dir > 0 ? 'support below' : 'resistance above'} to lean on`);
    }

    // Room to run: the nearest opposing level, in R.
    const ahead = dir > 0 ? r.resistance.find((l) => l.price > px + risk * 0.15) : r.support.find((l) => l.price < px - risk * 0.15);
    const roomR = ahead ? Math.abs(ahead.price - px) / risk : null;
    if (roomR == null) say('room', 0.5, `clear air ${dir > 0 ? 'above' : 'below'}: no level in the way`);
    else if (roomR >= 2) say('room', 0.6, `${roomR.toFixed(1)}R of room to the ${ahead.label} at ${fmt(ahead.price)}`);
    else if (roomR >= 1.2) say('room', 0.1, `${roomR.toFixed(1)}R of room to the ${ahead.label} at ${fmt(ahead.price)}`);
    else say('room', roomR >= 0.8 ? -0.5 : -1, `the ${ahead.label} at ${fmt(ahead.price)} is only ${roomR.toFixed(1)}R away`);

    if (r.volPct >= 0.93) say('volatility', -Math.min(1, (r.volPct - 0.85) * 6), `volatility is extreme (${Math.round(r.volPct * 100)}th percentile)`);
    else if (r.volPct <= 0.07) say('volatility', -0.3, 'the market is unusually quiet, moves may not follow through');
    else say('volatility', 0.1, `volatility is normal (${Math.round(r.volPct * 100)}th percentile)`);

    if (r.news && r.news.minutes <= (r.news.impact === 'high' ? 45 : 20)) say('news', r.news.impact === 'high' ? -0.8 : -0.35, `${r.news.label} is due in ${r.news.minutes} minutes`);
    else say('news', 0.05, 'no big news due soon');

    const rr = target != null ? Math.abs(target - px) / risk : null;
    return { read: r, symbol, side, dir, entry: px, stop, target, risk, rr, roomR, ahead, behind, f };
  }
}
