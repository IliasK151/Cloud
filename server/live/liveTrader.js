import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { ACCOUNT_TYPES, DEFAULTS, PLAN_SWITCHES, PROGRAMS, COST_MAX_R, normalizeProfile, guardMetrics, lotsForRisk, positionRisk, tradeCost, trainingOn, programRules, strictUntilKnown, bestDayCheck } from './rules.js';
import { autoMap, candidatesFor } from './symbolMap.js';
import { SYMBOL_IDS, SYMBOLS } from '../market/symbols.js';
import { AccountBrain } from './accountBrain.js';
import { DailyReports, closedTrades } from './dailyReport.js';
import { ACTION_LIMITS } from './bridge.js';
import { MAX_BROKER_BARS } from '../research/history.js';
import { locateExpertsFolders } from '../../scripts/install-ea.js';
import { fmtUsd } from '../util/format.js';

export const MAGIC_BASE = 771000;

// The EA version this floor ships (mt5/MeridianBridge.mq5), to spot an outdated EA in MT5.
const EA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'mt5', 'MeridianBridge.mq5');
export const LATEST_EA = (() => {
  try {
    return fs.readFileSync(EA_FILE, 'utf8').match(/#define EA_VERSION\s+"([\d.]+)"/)?.[1] || null;
  } catch {
    return null;
  }
})();

// "1.0.0" < "1.1.0"; unknown or non-numeric versions (e.g. the mock) count as current.
export function eaOutdated(version, latest = LATEST_EA) {
  const nums = (v) => String(v).split('.').map((x) => Number(x));
  if (!version || !latest || !/^\d+(\.\d+)*$/.test(version)) return false;
  const a = nums(version);
  const b = nums(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  }
  return false;
}
const ENTRY_WINDOW_MS = 90_000; // never chase a desk's paper entry older than this
const HISTORY_PAGE = 10_000; // 1-minute bars per history page from MT5 (about 600 KB)
const DISCONNECT_ALERT_MS = 60_000; // MT5 silent this long → tell the boss
const MISSING_SYNCS_TO_CLOSE = 3;
const PLAN_KEYS = ['minGrade', 'dailyStopPct', 'maxTradesPerDay', 'streakStop', 'stayArmed', ...PLAN_SWITCHES];
const SWITCH_NOTES = {
  training: [() => 'Training on FTMO switched ON: every trade the desks take goes to the account. FTMO\'s loss guard, real prices and stop-losses still apply', () => 'Training on FTMO switched OFF: the account plan decides which trades go to FTMO again'],
  dailyStopOn: [(p) => `Daily stop switched ON: no new trades on the account after a −${p.dailyStopPct}% day`, (p) => `Daily stop switched OFF by the boss: desks keep trading after a −${p.dailyStopPct}% day. FTMO's daily loss guard (${p.guardPct}% of the ${p.dailyLossPct}% limit) still applies`],
  tradeCapOn: [(p) => `Trade cap switched ON: at most ${p.maxTradesPerDay} trades a day on the account`, () => 'Trade cap switched OFF by the boss: no limit on trades a day'],
  streakStopOn: [(p) => `Losing-streak stop switched ON: done for the day after ${p.streakStop} losses in a row`, () => 'Losing-streak stop switched OFF by the boss (risk still halves after 2 losses in a row)'],
  provenOnly: [() => 'Proven desks only switched ON: only desks with a proven edge on real prices trade the account', () => 'Proven desks only switched OFF by the boss: unproven desks trade the account at half risk'],
  practiceAll: [() => 'Practice switched ON: every desk trades the Free Trial while training, the ones the evidence holds back at a small practice size', () => 'Practice switched OFF: desks the evidence holds back stay on paper again'],
};

// Desks whose trades can't be mirrored 1:1 onto a single prop account.
const INELIGIBLE = {
  kenji: 'Pairs trades need two hedged legs without a single stop-loss — paper only.',
  isabella: 'Market making relies on passive maker fills an FTMO account can’t reproduce — paper only.',
};

// Mirrors the floor's paper desks onto a real MT5 account (e.g. FTMO) through the bridge EA.
// Paper stays the "brain": when an enabled desk opens, scales out, trails or closes a trade,
// the same action is sent to MT5 with lots sized for the prop account's risk rules.
export class LiveTrader extends EventEmitter {
  constructor({ fund, md, bridge, clock, mode, dataDir, token, log = console }) {
    super();
    this.fund = fund;
    this.md = md;
    this.bridge = bridge;
    this.clock = clock;
    this.mode = mode;
    this.token = token;
    this.log = log;
    this.file = path.join(dataDir, 'live.json');
    this.state = this.#load();
    this.sessionId = crypto.randomBytes(3).toString('hex');
    this.armed = false;
    this.armedAt = null;
    this.events = [];
    // Orders from an earlier run that MT5 never confirmed didn't happen.
    this.links = new Map((this.state.links || []).map((l) => [l.key, { ...l, previousSession: true, ...(l.state === 'pending' ? { state: 'failed', reason: 'never confirmed by MT5 before the floor restarted' } : {}) }]));
    this.agentIndex = new Map(fund.agents.map((a, i) => [a.id, i + 1]));
    // Today's order actions survive a restart (FTMO counts them per day, not per run).
    if (this.state.actions?.day && Number.isFinite(this.state.actions.n)) bridge.actions = { day: this.state.actions.day, n: this.state.actions.n };
    this.lastSkipNote = new Map();
    this.brain = new AccountBrain(this);
    // The daily report card, and the moments worth a message on the boss's phone ('alert').
    this.reports = new DailyReports({ dataDir, log });
    this.reports.onFinal = (sum) => this.#alert('daily', dailyAlertText(sum));
    this.lastSnapshot = 0;
    this.linkDown = null; // { since, alerted } while MT5 is silent

    // A problem in one of these must never break MT5's connection or stop the floor.
    const safe = (label, fn) => (...args) => {
      try {
        fn(...args);
      } catch (err) {
        this.log.warn?.(`[live] ${label} failed: ${err.stack || err.message}`);
      }
    };
    bridge.on('account', safe('account', (acc) => this.#onAccount(acc)));
    bridge.on('ack', safe('ack', (ack) => this.#onAck(ack)));
    bridge.on('history', safe('history', (sym, bars, meta) => this.#onHistory(sym, bars, meta)));
    bridge.on('history-missing', safe('history-missing', (sym, meta) => this.#onHistoryPage(sym, [], meta)));
    // The research history (research/history.js), for paging months of the broker's own
    // bars into it; set by the server.
    this.history = null;
    this.backfill = new Map(); // brokerSymbol → { next, lastOldest, pages, done, why }
    bridge.on('sync', safe('sync', () => this.#onSync()));
    fund.broker.on('fill', () => setImmediate(() => this.reconcile()));
    fund.env.liveDescribe = (id) => this.describeFor(id);
    fund.env.liveBook = (id) => (this.profile && this.account ? this.deskBook(id) : null);
    // A data-feed switch shifts the desks' paper levels; keep the live stop mapping aligned.
    md.on('rebase', (symbol, offset) => {
      for (const l of this.links.values()) if (l.floorSymbol === symbol && !l.previousSession && Number.isFinite(l.paperEntry)) l.paperEntry += offset;
    });
    this.equityHistory = [];
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.log.warn?.(`[live] tick failed: ${err.stack || err.message}`);
      }
    }, 1000);
  }

  // ---- persistence ---------------------------------------------------------------------
  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { profiles: {}, links: [], halts: {} };
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const links = [...this.links.values()].slice(-200).map(({ previousSession, ...l }) => l);
      const data = { profiles: this.state.profiles, halts: this.state.halts, armed: this.state.armed || {}, peaks: this.state.peaks || {}, costs: this.state.costs || {}, backfill: this.state.backfill || {}, actions: this.bridge.actions, links };
      try {
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(data, null, 1));
        fs.renameSync(`${this.file}.tmp`, this.file);
      } catch (err) {
        this.log.warn?.(`[live] save failed: ${err.message}`);
      }
    }, 200);
  }

  // ---- accessors --------------------------------------------------------------------------
  get account() {
    return this.bridge.account;
  }

  get login() {
    return this.account ? String(this.account.login) : null;
  }

  // Profiles saved before a plan setting existed get its default.
  get profile() {
    const p = this.login ? this.state.profiles[this.login] || null : null;
    if (p) for (const k of PLAN_KEYS) if (p[k] == null && k in DEFAULTS) p[k] = DEFAULTS[k];
    if (p && p.training == null) p.training = p.type === 'trial';
    if (p && p.practiceAll == null) p.practiceAll = p.type === 'trial';
    return strictUntilKnown(p);
  }

  get halt() {
    return this.login ? this.state.halts?.[this.login] || null : null;
  }

  eligible(agentId) {
    return !INELIGIBLE[agentId];
  }

  ineligibleReason(agentId) {
    return INELIGIBLE[agentId] || null;
  }

  magicFor(agentId) {
    return MAGIC_BASE + (this.agentIndex.get(agentId) || 0);
  }

  agentForMagic(magic) {
    const idx = magic - MAGIC_BASE;
    return this.fund.agents[idx - 1]?.id ?? null;
  }

  #ours(pos) {
    return pos.magic > MAGIC_BASE && pos.magic <= MAGIC_BASE + 99;
  }

  #note(text, kind = 'live', agentId = null) {
    const ev = { time: Date.now(), text, kind, agentId };
    this.events.push(ev);
    if (this.events.length > 120) this.events.shift();
    // The floor tape already prints the trader's name, so drop it from the start of the line.
    const first = agentId ? this.fund.byId.get(agentId)?.profile.name.split(' ')[0] : null;
    const floorText = first && text.startsWith(`${first} `) ? text.slice(first.length + 1) : text;
    this.fund.pushEvent({ agentId, kind: 'live', text: `FTMO · ${floorText}` });
    this.emit('change');
  }

  // Something the boss would want on their phone. kind: trade | guard | connection | arming | daily
  #alert(kind, text, extra = {}) {
    this.emit('alert', { kind, text, at: Date.now(), ...extra });
  }

  // The entry chart was drawn and saved: the FTMO tab links to it.
  setChart(linkKey, url) {
    const link = this.links.get(linkKey);
    if (!link) return;
    link.chart = url;
    this.emit('change');
  }

  // The report's day: the FTMO server day (its daily loss limit resets with it).
  reportDay() {
    return this.bridge.serverDay || this.fund.session.tradingDay();
  }

  #deskInfo(agentId) {
    const a = this.fund.byId.get(agentId);
    return { name: a?.profile.name ?? agentId, desk: a?.profile.desk ?? '' };
  }

  // ---- setup & controls -----------------------------------------------------------------
  #onAccount(acc) {
    this.armed = false;
    this.equityHistory = [];
    const known = !!this.state.profiles[String(acc.login)];
    this.#note(`MT5 connected: account ${acc.login} on ${acc.server}${known ? '' : ' — new account, set it up in the FTMO tab'}`);
    this.bridge.requestSymbols();
  }

  setup(body = {}) {
    if (!this.account) return { ok: false, error: 'No MT5 account connected yet' };
    const prev = this.profile;
    // Switches set on the Brain / FTMO tabs survive saving the setup form.
    const kept = prev ? Object.fromEntries([...PLAN_SWITCHES, 'stayArmed'].map((k) => [k, prev[k]])) : {};
    const profile = normalizeProfile({ ...kept, ...body }, this.account);
    const suggested = autoMap(this.bridge.symbols);
    const symbolMap = {};
    for (const id of SYMBOL_IDS) {
      const wanted = body.symbolMap?.[id];
      if (wanted === '' || wanted === null) symbolMap[id] = null;
      else if (wanted && (this.bridge.symbols.includes(wanted) || !this.bridge.symbols.length)) symbolMap[id] = wanted;
      else symbolMap[id] = prev?.symbolMap?.[id] ?? suggested[id] ?? null;
    }
    // A new Free Trial trains on FTMO: every desk that can trade the account starts switched on.
    const desks = prev?.desks || (trainingOn(profile) ? Object.fromEntries(this.fund.agents.filter((a) => this.eligible(a.id)).map((a) => [a.id, true])) : {});
    this.state.profiles[this.login] = {
      ...profile,
      symbolMap,
      desks,
      server: this.account.server,
      createdAt: prev?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    this.save();
    this.#note(`${prev ? 'Updated' : 'Saved'} setup for ${ACCOUNT_TYPES[profile.type].label} ${this.login} (${fmtUsd(profile.size)})`);
    return { ok: true };
  }

  setDesk(agentId, enabled) {
    const p = this.profile;
    if (!p) return { ok: false, error: 'Set up the account first' };
    if (!this.fund.byId.has(agentId)) return { ok: false, error: 'Unknown desk' };
    if (enabled && !this.eligible(agentId)) return { ok: false, error: INELIGIBLE[agentId] };
    p.desks[agentId] = !!enabled;
    this.save();
    const name = this.fund.byId.get(agentId).profile.name;
    this.#note(`${name} ${enabled ? 'may now trade' : 'no longer trades'} the FTMO account`, 'live', agentId);
    return { ok: true };
  }

  // "Put the update into MT5": copy the EA this floor ships into MT5's Expert Advisors
  // folder(s) on this Mac. Compiling it is one click in MetaEditor.
  installEa({ locate = locateExpertsFolders } = {}) {
    let folders = [];
    try {
      folders = locate();
    } catch {
      folders = [];
    }
    if (!folders.length) return { ok: false, error: 'Couldn\'t find MetaTrader 5\'s Expert Advisors folder on this Mac (for example if MT5 runs in Parallels or on another PC). Use "Copy EA code" instead.' };
    const copied = [];
    let lastErr = null;
    for (const f of folders) {
      try {
        fs.copyFileSync(EA_FILE, path.join(f, 'MeridianBridge.mq5'));
        copied.push(f);
      } catch (err) {
        lastErr = err;
      }
    }
    if (!copied.length) return { ok: false, error: `Could not write into MT5's folder: ${lastErr?.message}. Use "Copy EA code" instead.` };
    this.#note(`New MeridianBridge EA ${LATEST_EA} copied into MT5 (${copied.length} folder${copied.length === 1 ? '' : 's'}): open it in MetaEditor and press Compile`);
    return { ok: true, folders: copied, version: LATEST_EA };
  }

  // Quick switches for the account plan (the Brain and FTMO tabs), without the setup form.
  setPlan(body = {}) {
    const p = this.profile;
    if (!p) return { ok: false, error: 'Set up the account first' };
    const keys = PLAN_SWITCHES.filter((k) => body[k] != null);
    if (!keys.length) return { ok: false, error: 'Nothing to change' };
    const wantsTraining = body.training != null && body.training !== false && body.training !== 'false';
    if (wantsTraining && p.type !== 'trial') return { ok: false, error: 'Training on FTMO is for the Free Trial. A paid challenge or funded account keeps the full account plan.' };
    const wantsPractice = body.practiceAll != null && body.practiceAll !== false && body.practiceAll !== 'false';
    if (wantsPractice && p.type !== 'trial') return { ok: false, error: 'Practice is for the Free Trial. A paid challenge or funded account only trades desks the evidence clears.' };
    for (const k of keys) {
      const on = body[k] !== false && body[k] !== 'false';
      if (p[k] === on) continue;
      p[k] = on;
      this.#note(SWITCH_NOTES[k][on ? 0 : 1](p), 'risk');
      // Training means every desk trains on the account: switch on all that can trade it.
      if (k === 'training' && on) for (const a of this.fund.agents) if (this.eligible(a.id)) p.desks[a.id] = true;
    }
    p.updatedAt = Date.now();
    this.save();
    return { ok: true };
  }

  // Risk per trade, from the nightly review's "use the best risk" button (or anywhere else).
  setRisk(pct) {
    const p = this.profile;
    if (!p) return { ok: false, error: 'Set up the account first' };
    const v = Number(pct);
    if (!Number.isFinite(v) || v < 0.01 || v > 2) return { ok: false, error: 'Risk per trade must be between 0.01% and 2%' };
    const was = p.riskPerTradePct;
    p.riskPerTradePct = Math.round(v * 100) / 100;
    p.updatedAt = Date.now();
    this.save();
    this.#note(`Risk per trade set to ${p.riskPerTradePct}% (was ${was}%)`, 'risk');
    return { ok: true };
  }

  // Which FTMO program the account is on (2-Step or 1-Step): sets its limits. Until it's set,
  // the guard follows the stricter of the two.
  setProgram(program) {
    const p = this.profile;
    if (!p) return { ok: false, error: 'Set up the account first' };
    const prog = PROGRAMS[program];
    if (!prog) return { ok: false, error: 'Choose 2-Step or 1-Step' };
    p.program = program;
    p.dailyLossPct = prog.dailyLossPct;
    p.maxLossPct = prog.maxLossPct;
    if (program === '1-step' && p.type === 'verification') p.type = 'challenge';
    p.updatedAt = Date.now();
    this.pastDaysCache = null;
    this.save();
    this.#note(program === '1-step'
      ? 'FTMO program set to 1-Step: 3% daily loss, 10% max loss that trails the best end-of-day balance, and the Best Day rule (no day over 50% of the profit)'
      : 'FTMO program set to 2-Step: 5% daily loss, 10% max loss from the starting balance', 'risk');
    return { ok: true };
  }

  arm({ confirm, auto = false } = {}) {
    const acc = this.account;
    const p = this.profile;
    if (this.mode !== 'live') return { ok: false, error: 'Live execution needs live market data. Restart with npm start (not npm run demo).' };
    if (!this.bridge.connected || !acc) return { ok: false, error: 'MT5 bridge is not connected' };
    if (!p) return { ok: false, error: 'Set up the account first' };
    if (this.halt) return { ok: false, error: `Trading is halted: ${this.halt.reason}` };
    if (acc.connected === false) return { ok: false, error: 'MT5 is not connected to its trade server. Log in again in MT5 (File → Login to Trade Account).' };
    if (!acc.tradeAllowed || !acc.expertAllowed) return { ok: false, error: 'This MT5 account does not allow (automated) trading right now.' };
    if (!acc.algoAllowed) return { ok: false, error: 'Algo Trading is off in MT5. Turn on the "Algo Trading" button and tick "Allow Algo Trading" in the EA settings.' };
    if (!Object.values(p.desks).some(Boolean)) return { ok: false, error: 'Enable at least one desk first' };
    if (p.type !== 'trial' && String(confirm ?? '').trim() !== this.login) {
      return { ok: false, error: `Type the account number ${this.login} to confirm live trading on a ${ACCOUNT_TYPES[p.type].label}` };
    }
    this.armed = true;
    this.armedAt = Date.now();
    // Remembered, so "Stay armed after a restart" knows the boss left it armed.
    this.state.armed ||= {};
    this.state.armed[this.login] = { at: this.armedAt };
    this.save();
    const label = `${ACCOUNT_TYPES[p.type].label} ${this.login}`;
    this.#note(auto ? `ARMED again automatically after the restart (Stay armed is on) — desks trade ${label}` : `ARMED — desks now trade ${label}`, 'risk');
    this.reports.event(this.reportDay(), 'arm', auto ? 'Re-armed automatically after a restart' : 'Armed: the desks trade the account');
    this.#alert('arming', auto ? `🟢 Re-armed automatically after a restart: the desks trade ${label} again.` : `🟢 Armed: the desks now trade ${label}.`);
    return { ok: true };
  }

  // The boss's choice to be disarmed (or a guard stop) sticks across restarts.
  #forgetArmed() {
    if (this.state.armed?.[this.login]) {
      delete this.state.armed[this.login];
      this.save();
    }
  }

  // "Stay armed after a restart": once MT5 is back and everything arm() checks is fine,
  // arm again, but only if the boss had left this same account armed and opted in.
  #maybeRearm() {
    const p = this.profile;
    if (this.armed || this.mode !== 'live' || !p?.stayArmed || !this.state.armed?.[this.login]) return;
    if (this.rearmRetryAt && Date.now() < this.rearmRetryAt) return;
    const res = this.arm({ confirm: this.login, auto: true });
    if (res.ok) {
      this.rearmIssue = null;
      return;
    }
    this.rearmRetryAt = Date.now() + 30_000;
    if (this.rearmIssue !== res.error) {
      this.rearmIssue = res.error;
      this.#note(`Stay armed: can't arm again yet — ${res.error}`, 'risk');
    }
  }

  setStayArmed(on) {
    const p = this.profile;
    if (!p) return { ok: false, error: 'Set up the account first' };
    p.stayArmed = on === true || on === 'true';
    p.updatedAt = Date.now();
    // Switching it on while armed: this is the state to come back to.
    if (p.stayArmed && this.armed) {
      this.state.armed ||= {};
      this.state.armed[this.login] = { at: this.armedAt || Date.now() };
    }
    this.save();
    this.#note(p.stayArmed
      ? 'Stay armed after a restart switched ON: if the floor or MT5 restarts while armed, it arms again once MT5 is back and every check passes'
      : 'Stay armed after a restart switched OFF: after a restart, arm again yourself', 'risk');
    return { ok: true };
  }

  disarm(reason = 'Disarmed by the boss') {
    this.#forgetArmed();
    if (!this.armed) return { ok: true };
    this.armed = false;
    this.#note(`DISARMED — ${reason}. Open FTMO positions keep their stop-loss.`, 'risk');
    this.reports.event(this.reportDay(), 'disarm', `Disarmed: ${reason}`);
    this.#alert('arming', `⏸ Disarmed: ${reason}. Open positions keep their stop-loss.`);
    return { ok: true };
  }

  kill() {
    this.armed = false;
    this.#forgetArmed();
    if (!this.bridge.connected) return { ok: false, error: 'MT5 bridge is not connected' };
    this.bridge.closeAll({ kind: 'kill' });
    for (const l of this.links.values()) if (l.state === 'open' || l.state === 'pending') l.state = 'closing';
    this.#note('KILL SWITCH — closing every floor position on the FTMO account and disarming', 'risk');
    this.reports.event(this.reportDay(), 'kill', 'Close all & disarm');
    this.#alert('arming', '⛔ Close all & disarm: every floor position on the account is being closed.');
    return { ok: true };
  }

  closeTicket(ticket) {
    if (!this.bridge.connected) return { ok: false, error: 'MT5 bridge is not connected' };
    this.bridge.close(Number(ticket), 1, { manual: true, ticket: Number(ticket) });
    this.#note(`Closing position #${ticket} on request`);
    return { ok: true };
  }

  resetHalt() {
    if (!this.halt) return { ok: true };
    delete this.state.halts[this.login];
    this.save();
    this.#note('Halt cleared by the boss (still disarmed — arm again when ready)', 'risk');
    return { ok: true };
  }

  // ---- bridge events -----------------------------------------------------------------------
  #onAck(ack) {
    const meta = ack.meta || {};
    const link = meta.linkKey ? this.links.get(meta.linkKey) : null;
    if (ack.kind === 'open' && link) {
      if (ack.ok) {
        link.state = 'open';
        link.ticket = ack.ticket;
        link.liveEntry = ack.price || link.liveEntry;
        if (ack.volume) link.volume0 = link.volumeNow = ack.volume;
        this.#note(`${this.#who(link)} filled ${link.side} ${link.volume0} ${link.brokerSymbol}${ack.price > 0 ? ` @ ${ack.price}` : ''}`, 'live', link.agentId);
        this.reports.opened(this.reportDay(), { key: link.key, agentId: link.agentId, ...this.#deskInfo(link.agentId), symbol: link.brokerSymbol, side: link.side, volume: link.volume0, entry: link.liveEntry, risk: link.risk, grade: link.grade });
        // Some brokers report a market order's fill price as 0: then the alert waits for the
        // next sync, which has the position's real open price.
        if (ack.price > 0) this.#fillAlert(link, ack.price);
        else link.fillAlertPending = true;
      } else {
        link.state = 'failed';
        link.reason = ack.msg;
        this.#note(`${this.#who(link)} order rejected by MT5: ${ack.msg}`, 'risk', link.agentId);
        this.reports.event(this.reportDay(), 'reject', `${this.#who(link)} ${link.brokerSymbol} order rejected by MT5: ${ack.msg}`);
        this.#alert('trade', `⚠️ ${this.#who(link)}'s ${link.brokerSymbol} order was rejected by MT5: ${ack.msg}`);
      }
      this.save();
    } else if (ack.kind === 'close' && !ack.ok && link) {
      if (!meta.partial && link.state === 'closing') {
        link.state = 'open'; // try again shortly (e.g. market was closed)
        link.retryAt = Date.now() + 30_000;
      }
      this.#note(`${this.#who(link)} close failed on MT5: ${ack.msg}`, 'risk', link.agentId);
    } else if (ack.kind === 'modify' && link) {
      if (ack.ok) link.sl = ack.price;
      else link.modifyFailures = (link.modifyFailures || 0) + 1;
    } else if (ack.kind === 'closeall') {
      this.#note(`Close-all on MT5: ${ack.msg}`, ack.ok ? 'live' : 'risk');
    }
    this.emit('change');
  }

  #who(link) {
    return this.fund.byId.get(link.agentId)?.profile.name.split(' ')[0] ?? link.agentId;
  }

  #mappedFloorIds(brokerSymbol) {
    const map = this.profile?.symbolMap || {};
    return Object.keys(map).filter((id) => map[id] === brokerSymbol);
  }

  // The broker's own 1-minute history replaces the public feed for that instrument; once MT5
  // prices it, the answers are pages of older history (#backfill).
  #onHistory(brokerSymbol, bars, meta = {}) {
    if (this.mode !== 'live') return;
    const b = this.backfill.get(brokerSymbol);
    if (b?.inFlight === (meta.start ?? 1)) return this.#onHistoryPage(brokerSymbol, bars, meta);
    if (bars.length < 30) return;
    for (const id of this.#mappedFloorIds(brokerSymbol)) {
      if (this.md.ownerOf(id) === 'mt5') continue;
      this.md.claim(id, 'mt5', bars, 'LIVE');
      this.#note(`${id} is now priced from your broker feed (${brokerSymbol})`);
    }
  }

  // Months of the broker's own 1-minute bars for the research lab and the nightly review: two
  // weeks (what the public feeds give) is too little to tell an edge from luck. Page back
  // through MT5's history, HISTORY_PAGE bars at a time, until the store holds MAX_BROKER_BARS,
  // MT5 has nothing older, or the EA can't page (before 1.3 it sends its latest bars again).
  // A restart doesn't download it again: the store saves what it has.
  #backfill(id, brokerSymbol) {
    const h = this.history;
    if (!h?.ready || typeof h.addBrokerHistory !== 'function' || this.md.ownerOf(id) !== 'mt5') return;
    let b = this.backfill.get(brokerSymbol);
    if (!b) {
      b = { next: 1, lastOldest: Infinity, pages: 0, done: false, why: null, inFlight: null };
      this.backfill.set(brokerSymbol, b);
      // Already in data/history from an earlier run: full, or all MT5 held when it last paged
      // (within a week; the store has kept growing bar by bar since).
      const rec = this.state.backfill?.[brokerSymbol];
      const have = h.brokerBars(id);
      if (have >= 0.95 * MAX_BROKER_BARS || (rec && Date.now() - rec.at < 7 * 86_400_000 && have >= 0.9 * rec.have)) Object.assign(b, { done: true, why: 'already saved' });
    }
    if (b.done || b.inFlight != null || this.bridge.historyPending(brokerSymbol)) return;
    b.inFlight = b.next;
    this.bridge.requestHistory(brokerSymbol, HISTORY_PAGE, b.next);
  }

  #onHistoryPage(brokerSymbol, bars, meta = {}) {
    const b = this.backfill.get(brokerSymbol);
    if (!b || b.done || b.inFlight !== (meta.start ?? 1)) return;
    b.inFlight = null;
    b.pages++;
    const ids = this.#mappedFloorIds(brokerSymbol);
    let oldest = Infinity;
    let n = 0;
    for (const id of ids) {
      const r = this.history?.addBrokerHistory(id, bars);
      if (r?.n) {
        n = Math.max(n, r.n);
        oldest = Math.min(oldest, r.oldest);
      }
    }
    if (!n) b.why = b.pages === 1 ? 'MT5 sent no history' : 'MT5 has nothing older';
    else if (!(oldest < b.lastOldest)) b.why = 'the EA sent the same bars again (EA 1.3 or later pages back through months of history)';
    else {
      b.lastOldest = oldest;
      b.next += HISTORY_PAGE;
      if (bars.length < HISTORY_PAGE) b.why = 'all the history MT5 holds';
      else if (b.next > MAX_BROKER_BARS) b.why = 'full';
    }
    if (!b.why) return;
    b.done = true;
    const have = Math.max(0, ...ids.map((id) => this.history?.brokerBars(id) || 0));
    this.state.backfill = { ...(this.state.backfill || {}), [brokerSymbol]: { at: Date.now(), have, why: b.why } };
    this.save();
    const days = have ? Math.round((have / 1440) * 10) / 10 : 0;
    this.log.info?.(`[research] ${brokerSymbol}: ${have.toLocaleString('en-US')} bars of your broker's history (${b.why})`);
    if (have) this.#note(`${ids.join(', ')}: the research lab and the nightly review now have ${have.toLocaleString('en-US')} minutes (about ${days} days of trading) of your broker's own prices`, 'info');
  }

  // Markets added to the floor after the account was set up (GBPUSD, say) are mapped to the
  // broker's symbol automatically, so MT5 prices them like the rest. A market the boss set
  // to "not mapped" stays that way.
  #mapNewMarkets(p) {
    const syms = this.bridge.symbols;
    if (!syms?.length) return;
    p.symbolMap ||= {};
    const missing = SYMBOL_IDS.filter((id) => !(id in p.symbolMap));
    if (!missing.length) return;
    const suggested = autoMap(syms);
    const added = [];
    for (const id of missing) {
      p.symbolMap[id] = suggested[id] ?? null;
      if (p.symbolMap[id]) added.push(`${id} → ${p.symbolMap[id]}`);
    }
    this.save();
    if (added.length) this.#note(`New market${added.length === 1 ? '' : 's'} mapped to your broker: ${added.join(', ')}. MT5 prices ${added.length === 1 ? 'it' : 'them'} now.`);
  }

  #onSync() {
    const p = this.profile;
    if (p) this.#mapNewMarkets(p);
    const map = p?.symbolMap || autoMap(this.bridge.symbols);
    this.bridge.watch(Object.values(map).filter(Boolean));
    // MT5 syncs faster while a desk on the account is about to trade (a setup waiting for its
    // trigger, a pending entry, a paper position to follow); slower otherwise, to save battery.
    this.bridge.urgent = !!p && this.armed && this.fund.agents.some((a) => p.desks?.[a.id] && this.eligible(a.id)
      && (a.setup?.armed || a.pending || a.book.positions.size));
    this.#learnCosts();
    if (!p) return this.emit('change');

    // Market data from MT5
    if (this.mode === 'live') {
      for (const [id, brokerSym] of Object.entries(p.symbolMap)) {
        if (!brokerSym) continue;
        if (this.md.ownerOf(id) !== 'mt5') {
          // Enough of the broker's own bars for the research lab to test on real prices.
          this.bridge.requestHistory(brokerSym, 6000);
          continue;
        }
        this.#backfill(id, brokerSym);
        const q = this.bridge.quotes[brokerSym];
        if (!q?.bars) continue;
        for (const bar of this.bridge.toBars(q.bars)) this.md.applyBar(id, bar, { source: 'mt5' });
        this.md.setStatus(id, 'LIVE', 'ftmo');
      }
    }

    // Track our live positions
    const positions = this.bridge.positions;
    const byTicket = new Map(positions.map((x) => [x.ticket, x]));
    const byComment = new Map(positions.map((x) => [x.comment, x]));
    for (const link of this.links.values()) {
      if (!['open', 'pending', 'closing'].includes(link.state)) continue;
      const pos = byTicket.get(link.ticket) || byComment.get(link.comment);
      if (pos) {
        if (link.state === 'pending') link.state = 'open';
        link.ticket = pos.ticket;
        link.volumeNow = pos.volume;
        link.sl = pos.sl;
        link.tp = pos.tp;
        link.liveEntry = pos.open;
        link.profit = pos.profit;
        link.missing = 0;
        if (link.fillAlertPending && pos.open > 0) this.#fillAlert(link, pos.open);
      } else if (link.state === 'pending') {
        // MT5 never confirmed this order (and it isn't on the account): it didn't happen.
        if (Date.now() - link.createdAt > 120_000 && !this.#busy(link)) {
          link.state = 'failed';
          link.reason = 'MT5 never confirmed the order';
          this.#note(`${this.#who(link)} ${link.brokerSymbol} order was never confirmed by MT5, so it doesn't count`, 'risk', link.agentId);
          this.save();
        }
      } else {
        link.missing = (link.missing || 0) + 1;
        if (link.missing >= MISSING_SYNCS_TO_CLOSE) {
          // Every deal of the position, the entry's commission included, as MT5 adds it up.
          const pnl = Math.round(this.bridge.deals.filter((d) => d.position === link.ticket).reduce((s, d) => s + d.pnl, 0) * 100) / 100;
          link.fillAlertPending = false; // closed before MT5 showed it open: the close alert says it all
          link.state = 'closed';
          link.closedAt = Date.now();
          link.closedDay = this.bridge.serverDay;
          link.pnl = pnl;
          const how = link.closeRequested ? 'closed' : 'closed on MT5 (stop, target or manual)';
          this.#note(`${this.#who(link)} ${link.brokerSymbol} ${how}: ${fmtUsd(pnl, { sign: true })}`, 'live', link.agentId);
          this.reports.closed(this.reportDay(), { key: link.key, agentId: link.agentId, ...this.#deskInfo(link.agentId), symbol: link.brokerSymbol, side: link.side, volume: link.volume0, entry: link.liveEntry, risk: link.risk, grade: link.grade, pnl, openedAt: link.createdAt });
          const r = link.risk > 0 ? ` (${pnl >= 0 ? '+' : '−'}${Math.abs(pnl / link.risk).toFixed(1)}R)` : '';
          this.#alert('trade', `${pnl >= 0 ? '✅' : '❌'} ${this.#who(link)} closed ${link.brokerSymbol} ${fmtUsd(pnl, { sign: true, cents: true })}${r} · ${link.closeRequested ? 'desk exit' : 'stop, target or manual on MT5'}\n\n${this.#todayTradesText()}`);
          this.save();
        }
      }
    }
    this.#trackPeak();
    this.#guard();
    this.#maybeRearm();
    this.#snapshot();
    this.emit('change');
  }

  // The account and the paper desks, for the daily report (twice a minute is plenty).
  #snapshot(force = false) {
    const p = this.profile;
    const acc = this.account;
    if (!p || !acc || this.mode !== 'live') return;
    if (!force && Date.now() - this.lastSnapshot < 30_000) return;
    this.lastSnapshot = Date.now();
    const m = this.#metricsWith(0);
    const paper = {};
    // The paper side of the desks switched on for the account, to compare with FTMO.
    for (const a of this.fund.agents) {
      if (!p.desks?.[a.id] || !this.eligible(a.id)) continue;
      paper[a.id] = { name: a.profile.name, desk: a.profile.desk, trades: a.day.trades, wins: a.day.wins };
    }
    this.reports.snapshot(this.reportDay(), {
      login: this.login, server: acc.server, type: ACCOUNT_TYPES[p.type]?.label ?? p.type, size: p.size,
      startBalance: m.dayStartBalance, balance: acc.balance, equity: acc.equity,
      dailyUsedPct: Math.round(m.dailyUsed * 1000) / 10, maxUsedPct: Math.round(m.maxUsed * 1000) / 10,
    }, paper);
  }

  // ---- FTMO rule guard -----------------------------------------------------------------------
  openRisk() {
    let total = 0;
    for (const pos of this.bridge.positions) {
      if (!this.#ours(pos)) continue;
      total += positionRisk(pos, this.bridge.quotes[pos.symbol]);
    }
    return total;
  }

  metrics() {
    const p = this.profile;
    const acc = this.account;
    if (!p || !acc) return null;
    return this.#metricsWith(this.openRisk());
  }

  #metricsWith(openRisk) {
    return guardMetrics(this.profile, this.account, openRisk, { peakBalance: this.peakBalance() });
  }

  // The account's days as the floor saw them (from the daily reports), before today. Past days
  // don't change, so they're read once a day.
  #pastDays() {
    const today = this.reportDay();
    const key = `${this.login}|${today}`;
    if (this.pastDaysCache?.key !== key) {
      this.pastDaysCache = { key, days: this.reports.balances(this.login).filter((d) => d.day !== today) };
    }
    return this.pastDaysCache.days;
  }

  // The best end-of-day balance so far (1-Step's max loss trails it). Every day's starting
  // balance is the end of the day before; a past day's last balance is its end. Remembered,
  // so it never goes down.
  peakBalance() {
    if (!this.login) return null;
    let peak = this.state.peaks?.[this.login] ?? 0;
    for (const d of this.#pastDays()) peak = Math.max(peak, d.startBalance, d.balance);
    return peak || null;
  }

  #trackPeak() {
    const acc = this.account;
    if (!this.profile || !acc || !Number.isFinite(acc.balance)) return;
    const start = acc.balance - (acc.closedToday || 0);
    this.state.peaks ||= {};
    const prev = this.state.peaks[this.login] ?? 0;
    const peak = Math.max(prev, this.peakBalance() ?? 0, start);
    if (peak > prev + 0.005) {
      this.state.peaks[this.login] = Math.round(peak * 100) / 100;
      this.save();
    }
  }

  // The broker's commission, measured from the account's own fills: MT5 charges it on the
  // entry deal, which has no profit of its own, so that deal's result per lot is the
  // commission per side. Kept per symbol, smoothed, remembered across restarts.
  #learnCosts() {
    this.seenDeals ||= new Set();
    let changed = false;
    for (const d of this.bridge.deals) {
      if (d.entry !== 0 || !(d.volume > 0) || !Number.isFinite(d.pnl) || this.seenDeals.has(d.ticket)) continue;
      this.seenDeals.add(d.ticket);
      const perLot = Math.max(0, -d.pnl) / d.volume;
      this.state.costs ||= {};
      const prev = this.state.costs[d.symbol];
      this.state.costs[d.symbol] = { perLot: Math.round((prev ? prev.perLot * 0.7 + perLot * 0.3 : perLot) * 10000) / 10000, n: (prev?.n || 0) + 1, at: Date.now() };
      changed = true;
    }
    if (changed) this.save();
  }

  // What a trade on this broker symbol would cost, in R, with this stop.
  costOf(brokerSymbol, stopDistance) {
    const spec = this.bridge.quotes[brokerSymbol];
    return tradeCost(spec, stopDistance, this.state.costs?.[brokerSymbol]?.perLot ?? null);
  }

  // FTMO 1-Step's Best Day rule, today included: null when the account's program doesn't have it.
  consistency() {
    const p = this.profile;
    const acc = this.account;
    if (!p || !acc) return null;
    const rules = programRules(p);
    if (!rules.bestDayPct) return null;
    const today = this.reportDay();
    const days = this.#pastDays().map((d) => ({ day: d.day, pnl: Math.round((d.balance - d.startBalance) * 100) / 100 }));
    days.push({ day: today, pnl: Math.round((acc.closedToday || 0) * 100) / 100, today: true });
    const c = bestDayCheck(days, rules.bestDayPct);
    // A day that makes more than half the target's profit could break the rule at the finish
    // line, so the plan calls it a day there (open trades still run to their exits).
    c.dayCap = p.targetPct ? Math.round(p.size * (p.targetPct / 100) * (rules.bestDayPct / 100) * 100) / 100 : null;
    c.known = !!rules.program;
    return c;
  }

  #guard() {
    const p = this.profile;
    const acc = this.account;
    if (!p || !acc) return;
    const h = this.halt;
    if (h?.kind === 'daily' && this.bridge.serverDay && h.day !== this.bridge.serverDay) {
      delete this.state.halts[this.login];
      this.save();
      this.#note('New trading day on the FTMO server — daily loss guard reset (arm again to trade)', 'risk');
    }
    if (this.halt) return;
    const m = this.#metricsWith(0);
    let kind = null;
    let reason = null;
    if (m.maxBreach) {
      kind = 'max';
      reason = `Loss reached ${p.guardPct}% of the ${p.maxLossPct}% max-loss limit (${fmtUsd(-m.totalLoss)}${m.trailing ? ` below the best end-of-day balance, ${fmtUsd(m.maxBase)}` : ''})`;
    } else if (m.dailyBreach) {
      kind = 'daily';
      reason = `Today's loss reached ${p.guardPct}% of the ${p.dailyLossPct}% daily limit (${fmtUsd(-m.dailyLoss)})`;
    } else if (p.stopAtTarget && m.targetHit) {
      // 1-Step: the target only counts once the Best Day rule is met too. Until then the
      // desks keep trading (at half risk, see the account brain) to add winning days.
      const c = this.consistency();
      if (c && !c.ok) {
        const day = this.reportDay();
        if (this.bestDayNoted !== day) {
          this.bestDayNoted = day;
          const text = `Profit target reached, but FTMO's Best Day rule isn't met yet: the best day (${fmtUsd(c.best.pnl, { sign: true })}) is ${Math.round(c.share * 100)}% of the ${fmtUsd(c.total)} made on winning days, over ${c.pct}%. About ${fmtUsd(c.needed)} more on other days passes it. Trading on at half risk`;
          this.#note(text, 'risk');
          this.reports.event(day, 'bestday', text);
          this.#alert('guard', `🏁 ${text}.`);
        }
      } else {
        kind = 'target';
        reason = `Profit target of ${p.targetPct}% reached (${fmtUsd(m.profit, { sign: true })})${c ? ' and the Best Day rule is met' : ''} — locking it in`;
      }
    }
    if (!kind) return;
    this.state.halts[this.login] = { kind, reason, day: this.bridge.serverDay, at: Date.now() };
    this.armed = false;
    this.#forgetArmed(); // a guard stop is never undone by a restart
    this.save();
    if (this.bridge.positions.some((x) => this.#ours(x))) this.bridge.closeAll({ kind: 'guard' });
    this.#note(`${kind === 'target' ? 'TARGET HIT' : 'RISK GUARD'} — ${reason}. Floor positions closed and trading stopped.`, 'risk');
    this.reports.event(this.reportDay(), 'guard', `${kind === 'target' ? 'Target hit' : 'Risk guard'}: ${reason}`);
    this.#alert('guard', `${kind === 'target' ? '🏁 TARGET HIT' : '🛑 RISK GUARD'}: ${reason}. Floor positions closed and trading stopped.`);
  }

  // ---- execution ------------------------------------------------------------------------------
  #busy(link) {
    return this.bridge.hasPending((c) => c.meta?.linkKey === link.key);
  }

  #paperKey(agent, pos) {
    return `${this.sessionId}:${agent.id}:${pos.trade.id}`;
  }

  tick() {
    if (this.profile && !this.bridge.connected) {
      for (const id of SYMBOL_IDS) if (this.md.ownerOf(id) === 'mt5') this.md.setStatus(id, 'STALE', 'ftmo');
    }
    this.#watchConnection();
    // Account equity once a minute, for the floor's equity charts in FTMO view.
    const acc = this.account;
    if (this.profile && acc && this.bridge.connected) {
      const t = Math.floor(Date.now() / 60_000) * 60;
      const last = this.equityHistory[this.equityHistory.length - 1];
      if (!last || t > last.time) this.equityHistory.push({ time: t, value: acc.equity });
      else last.value = acc.equity;
      if (this.equityHistory.length > 1440) this.equityHistory.shift();
    }
    this.reconcile();
  }

  // MT5 going quiet for a minute (Mac asleep, MT5 closed, internet down) is worth a message,
  // and so is it coming back. Only once an account is set up and it had been connected.
  #watchConnection() {
    if (!this.profile || !this.bridge.lastSync) return;
    const up = this.bridge.connected;
    if (!up && !this.linkDown) this.linkDown = { since: this.bridge.lastSync, alerted: false };
    if (!up && this.linkDown && !this.linkDown.alerted && Date.now() - this.linkDown.since >= DISCONNECT_ALERT_MS) {
      this.linkDown.alerted = true;
      const open = this.bridge.positions.filter((x) => this.#ours(x)).length;
      this.reports.event(this.reportDay(), 'disconnect', 'MT5 stopped syncing');
      this.#alert('connection', `🔌 MT5 has stopped talking to the floor for a minute (MT5 closed, the Mac asleep or the internet down).${open ? ` ${open} open position${open === 1 ? '' : 's'} keep${open === 1 ? 's' : ''} ${open === 1 ? 'its' : 'their'} stop-loss on MT5.` : ''}`);
    }
    if (up && this.linkDown) {
      if (this.linkDown.alerted) {
        const mins = Math.round((Date.now() - this.linkDown.since) / 60_000);
        this.reports.event(this.reportDay(), 'reconnect', `MT5 back after ${mins} min`);
        this.#alert('connection', `✅ MT5 is back after ${mins} minute${mins === 1 ? '' : 's'}.${this.armed ? ' Still armed.' : ' Not armed: arm again in the FTMO tab to trade.'}`);
      }
      this.linkDown = null;
    }
  }

  // One desk's results on the connected account (floor trades only).
  deskBook(agentId) {
    const login = this.login;
    const mine = [...this.links.values()].filter((l) => l.agentId === agentId && l.login === login);
    const openLink = mine.find((l) => !l.previousSession && (l.state === 'open' || l.state === 'closing'));
    const closed = mine.filter((l) => l.state === 'closed');
    const isToday = (l) => (l.closedDay ? l.closedDay === this.bridge.serverDay : l.closedAt >= Date.now() - 86_400_000);
    const closedToday = closed.filter(isToday);
    const openProfit = openLink?.profit ?? 0;
    return {
      enabled: !!this.profile?.desks?.[agentId] && this.eligible(agentId),
      day: closedToday.reduce((s, l) => s + (l.pnl || 0), 0) + openProfit,
      total: closed.reduce((s, l) => s + (l.pnl || 0), 0) + openProfit,
      trades: closedToday.length + (openLink ? 1 : 0),
      open: openLink ? { side: openLink.side, volume: openLink.volumeNow, symbol: openLink.brokerSymbol, profit: openProfit, sl: openLink.sl, tp: openLink.tp } : null,
      liveSymbols: mine.filter((l) => !l.previousSession && ['open', 'closing', 'pending'].includes(l.state)).map((l) => l.floorSymbol),
    };
  }

  reconcile() {
    const p = this.profile;
    if (!this.armed || !p || !this.bridge.connected) return;
    if (this.halt) {
      this.armed = false;
      return;
    }
    const now = this.clock.now();
    const liveKeys = new Set();
    for (const agent of this.fund.agents) {
      const enabled = this.eligible(agent.id) && p.desks[agent.id];
      for (const pos of agent.book.positions.values()) {
        const key = this.#paperKey(agent, pos);
        liveKeys.add(key);
        const link = this.links.get(key);
        if (!link) {
          if (enabled && now - pos.trade.openTime <= ENTRY_WINDOW_MS) this.#openLive(agent, pos, key);
          continue;
        }
        if (link.state !== 'open' || this.#busy(link)) continue;
        this.#followScaleOut(link, pos);
        this.#followStop(link, agent.plans.get(pos.symbol));
      }
    }
    // Desk closed its paper trade → close the live one.
    for (const link of this.links.values()) {
      if (link.previousSession || link.state !== 'open' || liveKeys.has(link.key) || this.#busy(link)) continue;
      if (link.retryAt && Date.now() < link.retryAt) continue;
      link.state = 'closing';
      link.closeRequested = true;
      this.bridge.close(link.ticket, 1, { linkKey: link.key });
      this.#note(`${this.#who(link)} closing ${link.side} ${link.volumeNow} ${link.brokerSymbol} — desk exited`, 'live', link.agentId);
    }
  }

  // Today on the account: what went to MT5 and what stayed on paper, and why (the FTMO tab's
  // "Today on the account" card answers "are they trading, and if not, why not?").
  #todayView(links) {
    const day = this.reportDay();
    const r = this.reports.current?.day === day ? this.reports.current : null;
    // Filled orders come from the day's report, which survives a restart of the floor; orders
    // still on their way and refused ones from this session.
    const filled = (r?.trades || []).filter((t) => !t.carried && t.openedAt != null);
    const recorded = new Set(filled.map((t) => t.key));
    const mine = links.filter((l) => !l.previousSession && l.login === this.login && l.openedDay === day && !recorded.has(l.key));
    const inFlight = mine.filter((l) => l.state === 'pending' || (l.ticket && l.state !== 'failed'));
    const failed = mine.filter((l) => l.state === 'failed');
    const byDesk = {};
    const desk = (id) => (byDesk[id] ||= { sent: 0, failed: 0, held: 0 });
    for (const t of [...filled, ...inFlight]) desk(t.agentId).sent++;
    for (const l of failed) desk(l.agentId).failed++;
    for (const [id, d] of Object.entries(r?.desks || {})) desk(id).held = d.skipped || 0;
    return {
      day,
      sent: filled.length + inFlight.length,
      failed: failed.length,
      held: Object.values(r?.skipped || {}).reduce((s, n) => s + n, 0),
      reasons: Object.entries(r?.skipped || {}).sort((a, b) => b[1] - a[1]),
      recent: (r?.skipSamples || []).slice(-6).reverse(),
      byDesk,
      actions: { n: this.bridge.actionsToday(), ...ACTION_LIMITS },
    };
  }

  // The entry on the boss's phone: the setup as a chart, and why the desk took it.
  #fillAlert(link, price) {
    link.fillAlertPending = false;
    const agent = this.fund.byId.get(link.agentId);
    const plan = agent?.plans.get(link.floorSymbol) || null;
    const buy = link.side === 'BUY';
    const dir = buy ? 1 : -1;
    const digits = this.bridge.quotes[link.brokerSymbol]?.digits ?? SYMBOLS[link.floorSymbol]?.decimals ?? 2;
    const fmt = (x) => Number(x).toFixed(digits);
    const stop = price - dir * link.stopDistance;
    const tpDist = plan?.target != null ? Math.abs(plan.target - plan.entry) : null;
    const target = tpDist ? price + dir * tpDist : null;
    const rr = tpDist && link.stopDistance > 0 ? tpDist / link.stopDistance : null;
    const risk = link.risk || 0;
    const who = this.#who(link);
    const lines = [
      `${buy ? '🟩' : '🟥'} ${who} ${buy ? 'bought' : 'sold'} ${link.volume0} ${link.brokerSymbol} @ ${fmt(price)}${link.grade ? ` · grade ${link.grade}` : ''}`,
      `Stop ${fmt(stop)} (−${fmtUsd(risk, { cents: true }).replace('-', '')})${target != null ? ` · target ${fmt(target)} (+${fmtUsd(risk * rr, { cents: true })}, ${rr.toFixed(1)}R)` : ' · trailing exit'}`,
    ];
    const c = this.costOf(link.brokerSymbol, link.stopDistance);
    if (c) lines.push(`Costs ${c.totalR.toFixed(2)}R (spread ${c.spreadR.toFixed(2)}R + commission ${c.commissionKnown ? `${c.commissionR.toFixed(2)}R` : 'not measured yet'})`);
    const why = entryReasons(plan, this.fund.committee, (id) => this.fund.byId.get(id)?.profile.name.split(' ')[0] ?? id);
    if (why.length) lines.push('', ...why);
    const tv = SYMBOLS[link.floorSymbol]?.tv;
    if (tv) lines.push('', `TradingView: https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tv)}`);
    const when = new Date();
    this.#alert('trade', lines.join('\n'), {
      linkKey: link.key,
      chart: {
        symbol: link.floorSymbol, brokerSymbol: link.brokerSymbol, decimals: digits, side: link.side, entry: price, stop, target,
        bars: this.md.bars(link.floorSymbol, { includeCurrent: true }).slice(-120),
        title: `${who} · ${link.side} ${link.volume0} ${link.brokerSymbol} @ ${fmt(price)}`,
        subtitle: `${agent?.profile.desk ?? ''} · 1-minute · ${link.grade ? `grade ${link.grade} · ` : ''}risk ${fmtUsd(risk, { cents: true })}`,
        entryLabel: `${buy ? 'Buy' : 'Sell'} ${fmt(price)}`,
        stopLabel: `Stop ${fmt(stop)} · −${fmtUsd(risk, { cents: true }).replace('-', '')}`,
        targetLabel: target != null ? `Target ${fmt(target)} · +${fmtUsd(risk * rr, { cents: true })} · ${rr.toFixed(1)}R` : null,
        levels: plan?.setupLevels || [],
        context: brainLevels(this.fund.brain?.read?.(link.floorSymbol)),
        when: `${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
        footer: `Drawn by the floor from your MT5 prices, TradingView style${tv ? ` · tradingview.com/chart/?symbol=${tv}` : ''}`,
      },
    });
  }

  // Today's closed trades on the account, one line each, for the phone.
  #todayTradesText() {
    const r = this.reports.current?.day === this.reportDay() ? this.reports.current : null;
    const m = this.metrics();
    const floating = m ? this.account.equity - m.dayStartBalance : null;
    return tradesListText(closedTrades(r), { accountToday: floating });
  }

  #skip(agent, pos, key, reason) {
    this.links.set(key, {
      key, agentId: agent.id, floorSymbol: pos.symbol, brokerSymbol: this.profile.symbolMap[pos.symbol],
      side: pos.qty > 0 ? 'BUY' : 'SELL', state: 'skipped', reason, createdAt: Date.now(), login: this.login,
    });
    this.reports.skipped(this.reportDay(), { agentId: agent.id, ...this.#deskInfo(agent.id), symbol: pos.symbol, reason });
    // Say it on the floor, but not again for the same reason within 20 minutes.
    const last = this.lastSkipNote.get(agent.id);
    if (last && last.reason === reason && Date.now() - last.at < 20 * 60_000) return this.emit('change');
    this.lastSkipNote.set(agent.id, { reason, at: Date.now() });
    this.#note(`${agent.profile.name.split(' ')[0]}'s ${pos.symbol} trade stays on paper, not sent to FTMO: ${reason}`, 'live', agent.id);
    return undefined;
  }

  #openLive(agent, pos, key) {
    const p = this.profile;
    const acc = this.account;
    const plan = agent.plans.get(pos.symbol);
    const brokerSymbol = p.symbolMap[pos.symbol];
    const spec = brokerSymbol ? this.bridge.quotes[brokerSymbol] : null;
    if (!brokerSymbol) return this.#skip(agent, pos, key, `no FTMO symbol mapped for ${pos.symbol}`);
    // Never real money on made-up prices: a market whose live feed is down runs on a
    // simulated stand-in, and a trade decided on it is paper practice only.
    const feed = this.md.get(pos.symbol);
    if (feed?.source === 'sim' || feed?.status === 'SIM') return this.#skip(agent, pos, key, `${pos.symbol} is on simulated prices right now (its live feed is down); only real prices trade real money`);
    if (pos.trade?.simFeed) return this.#skip(agent, pos, key, `the desk decided this ${pos.symbol} trade on simulated prices`);
    if (!plan || !(plan.risk > 0)) return this.#skip(agent, pos, key, 'no stop-loss on the desk trade');
    if (plan.testAlert) return this.#skip(agent, pos, key, 'it was a test alert from the TradingView tab (tests never trade the account)');
    if (!spec) return this.#skip(agent, pos, key, `no MT5 price for ${brokerSymbol} yet`);
    // Transaction costs: a trade that gives most of its edge to the spread and commission
    // before it starts doesn't go (your own TradingView alerts are your call).
    const cost = this.costOf(brokerSymbol, plan.risk);
    if (cost && cost.totalR > COST_MAX_R && plan.tag !== 'TV') {
      return this.#skip(agent, pos, key, `costs would eat ${cost.totalR.toFixed(2)}R before it starts (spread ${cost.spreadR.toFixed(2)}R + commission ${cost.commissionR.toFixed(2)}R), over the ${COST_MAX_R}R limit: the stop is too tight for ${brokerSymbol}'s costs right now`);
    }
    if (!acc.algoAllowed || !acc.tradeAllowed) return this.#skip(agent, pos, key, 'Algo Trading is switched off in MT5');
    const actions = this.bridge.actionsToday();
    if (actions >= ACTION_LIMITS.newTrades) return this.#skip(agent, pos, key, `${actions} order actions sent to MT5 today; new trades stop at ${ACTION_LIMITS.newTrades}, far below FTMO's ${ACTION_LIMITS.ftmo} a day`);
    const ours = this.bridge.positions.filter((x) => this.#ours(x)).length
      + [...this.links.values()].filter((l) => l.state === 'pending').length;
    // Training on FTMO: as many positions as the EA allows (its own cap, 8 unless changed).
    const training = trainingOn(p);
    const maxPositions = training ? Math.max(p.maxPositions, this.bridge.caps?.maxPositions || 8) : p.maxPositions;
    if (ours >= maxPositions) return this.#skip(agent, pos, key, `already ${ours} live positions (max ${maxPositions})`);

    // Learning (or a new strategy on probation) may size a desk's trade down on the account, never up.
    const news = this.fund.env.news?.blackout(pos.symbol);
    if (news) return this.#skip(agent, pos, key, `news blackout (${news.event.title})`);
    // The account brain: only proven desks' A-grade trades, sized by where the account stands.
    const verdict = this.brain.allow(agent, pos, plan);
    if (!verdict.ok) return this.#skip(agent, pos, key, verdict.reason);
    // The boss's own alerts go at the account plan's risk; a desk's own trades may be sized
    // down further by its committee grade and what it has learned (never up).
    const deskMult = verdict.boss ? 1 : Math.min(1, plan.riskMult ?? plan.learnMult ?? 1);
    const riskMoney = acc.balance * (p.riskPerTradePct / 100) * (agent.profile.riskScale ?? 1) * deskMult * verdict.riskMult;
    let lots = lotsForRisk(riskMoney, plan.risk, spec);
    if (!lots) {
      // Below the broker's minimum lot: trade the minimum if that still risks no more than
      // the base risk per trade you set; otherwise skip.
      const perLot = (plan.risk / (spec.tickSize || spec.point)) * (spec.tickValueLoss || spec.tickValue);
      const minRisk = perLot * (spec.volMin || 0.01);
      if (Number.isFinite(minRisk) && minRisk > 0 && minRisk <= acc.balance * (p.riskPerTradePct / 100)) lots = spec.volMin || 0.01;
      else return this.#skip(agent, pos, key, `even the ${spec.volMin} lot minimum would risk ${fmtUsd(minRisk)}, more than your ${p.riskPerTradePct}% per trade`);
    }
    const actualRisk = (plan.risk / (spec.tickSize || spec.point)) * (spec.tickValueLoss || spec.tickValue) * lots;
    // Orders MT5 hasn't filled yet count too: several desks can send trades in the same second.
    const inFlight = [...this.links.values()].filter((l) => l.state === 'pending' && !l.previousSession && !l.ticket).reduce((sum, l) => sum + (l.risk || 0), 0);
    const openRisk = this.openRisk() + inFlight;
    const m = this.#metricsWith(openRisk);
    if (actualRisk > m.dailyRoom) return this.#skip(agent, pos, key, `not enough room under the daily loss guard (${fmtUsd(Math.max(0, m.dailyRoom))} left)`);
    if (actualRisk > m.maxRoom) return this.#skip(agent, pos, key, `not enough room under the max loss guard (${fmtUsd(Math.max(0, m.maxRoom))} left)`);
    // Training on FTMO leaves out the open-risk budget: the loss-guard room above already
    // makes sure every open stop together can't breach FTMO's limits.
    if (!training && openRisk + actualRisk > acc.balance * (p.maxOpenRiskPct / 100)) {
      return this.#skip(agent, pos, key, `open-risk budget of ${p.maxOpenRiskPct}% is full`);
    }

    const side = pos.qty > 0 ? 'BUY' : 'SELL';
    const comment = `MF-${agent.id}-${Date.now().toString(36).slice(-5)}`;
    const tpDistance = plan.target != null ? Math.abs(plan.target - plan.entry) : 0;
    const link = {
      key, agentId: agent.id, floorSymbol: pos.symbol, brokerSymbol, side, state: 'pending', login: this.login,
      comment, magic: this.magicFor(agent.id), paperEntry: plan.entry, paperQty0: Math.abs(pos.qty),
      stopDistance: plan.risk, volume0: lots, volumeNow: lots, liveEntry: side === 'BUY' ? spec.ask : spec.bid,
      risk: actualRisk, createdAt: Date.now(), reason: plan.reason, openedDay: this.bridge.serverDay,
      thesis: plan.thesis ?? null, grade: plan.grade ?? null, riskMult: verdict.riskMult, costR: cost?.totalR ?? null,
    };
    this.links.set(key, link);
    link.cmdId = this.bridge.open({
      symbol: brokerSymbol, side, volume: lots, slDistance: plan.risk, tpDistance, magic: link.magic, comment,
    }, { linkKey: key });
    this.#note(`${agent.profile.name.split(' ')[0]} sending ${side} ${lots} ${brokerSymbol} to MT5, stop ${plan.risk.toPrecision(5)} away (risk ${fmtUsd(actualRisk)})`, 'live', agent.id);
    this.save();
  }

  // Desk took partial profits → take the same fraction off the live position.
  #followScaleOut(link, pos) {
    const paperFrac = Math.abs(pos.qty) / link.paperQty0;
    const liveFrac = link.volumeNow / link.volume0;
    if (liveFrac - paperFrac < 0.2 || link.scaledOut) return;
    const fraction = 1 - paperFrac / liveFrac;
    this.bridge.close(link.ticket, Number(fraction.toFixed(4)), { linkKey: link.key, partial: true });
    link.scaledOut = true; // one attempt; if the lot size can't be split we keep the full runner
    this.#note(`${this.#who(link)} scaling out ${Math.round(fraction * 100)}% of ${link.brokerSymbol}`, 'live', link.agentId);
  }

  // Desk moved its stop (breakeven / trailing) → tighten the live stop by the same amount.
  #followStop(link, plan) {
    if (!plan || !Number.isFinite(plan.stop) || !link.sl) return;
    const desired = plan.stop + (link.liveEntry - link.paperEntry);
    const spec = this.bridge.quotes[link.brokerSymbol];
    if (!spec) return;
    const minMove = Math.max(link.stopDistance * 0.1, (spec.point || 0) * 5);
    const long = link.side === 'BUY';
    const tighter = long ? desired > link.sl + minMove : desired < link.sl - minMove;
    if (!tighter || (link.modifyFailures || 0) >= 3) return;
    if (this.bridge.actionsToday() >= ACTION_LIMITS.stopMoves) return; // the stop already on MT5 stays
    const price = long ? spec.bid : spec.ask;
    if (long ? desired >= price : desired <= price) return; // the desk's own exit logic will close it
    const digits = spec.digits ?? 5;
    this.bridge.modify(link.ticket, desired.toFixed(digits), 'keep', { linkKey: link.key });
  }

  async shutdown() {
    this.#snapshot(true);
    this.reports.flush();
    this.armed = false;
    if (!this.bridge.connected || !this.bridge.positions.some((x) => this.#ours(x))) return null;
    this.bridge.closeAll({ kind: 'shutdown' });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && this.bridge.hasPending((c) => c.kind === 'closeall')) {
      await new Promise((r) => setTimeout(r, 200));
    }
    // true = MT5 confirmed the close; false = no answer (positions keep their stop-loss).
    return !this.bridge.hasPending((c) => c.kind === 'closeall');
  }

  // ---- presentation -----------------------------------------------------------------------------
  describeFor(agentId) {
    const p = this.profile;
    const agent = this.fund.byId.get(agentId);
    if (!agent || !p?.desks?.[agentId] || !this.eligible(agentId)) return null;
    const open = [...this.links.values()].find((l) => l.agentId === agentId && l.state === 'open' && !l.previousSession);
    if (open) {
      const pnl = open.profit ?? 0;
      return `I'm live on your FTMO account: ${open.side === 'BUY' ? 'long' : 'short'} ${open.volumeNow} lots of ${open.brokerSymbol}, ${pnl >= 0 ? 'up' : 'down'} ${fmtUsd(Math.abs(pnl))}.`;
    }
    const pending = [...this.links.values()].find((l) => l.agentId === agentId && (l.state === 'pending' || l.state === 'closing') && !l.previousSession);
    if (pending) return pending.state === 'pending'
      ? `I've just sent a ${pending.side === 'BUY' ? 'buy' : 'sell'} order for ${pending.volume0} lots of ${pending.brokerSymbol} to your FTMO account and I'm waiting for MT5 to fill it.`
      : `I'm closing my ${pending.brokerSymbol} position on your FTMO account now.`;
    if (this.halt) return `Your FTMO account is on hold: ${this.halt.reason}.`;
    const st = this.brain.deskStatus(agent);
    // A paper trade that is running right now but isn't on the account: say so, and why.
    const paper = [...agent.book.positions.values()].map((pos) => {
      const link = this.links.get(this.#paperKey(agent, pos));
      return { pos, link };
    }).find(({ link }) => !link || link.state === 'skipped' || link.state === 'failed');
    const why = paper?.link?.reason;
    const paperLine = paper ? ` My ${paper.pos.symbol} trade is on paper only${why ? `: it wasn't sent to FTMO because ${why}` : ''}.` : '';
    if (st.state === 'proving') {
      const alerts = agent.profile.tvDesk ? ' Your own TradingView alerts through me still go to the account.' : '';
      const need = st.text.replace(/^Paper only for now: /, '').replace(/ Your TradingView.*$/, '').replace(/^it needs/, 'I need').replace(/^its /, 'my ').replace(/^no validated/, 'I have no validated');
      return `I'm switched on for your FTMO account, but I haven't earned real money yet: ${need} Until then my own trades stay on paper.${alerts}${paperLine}`;
    }
    if (st.state === 'stopped') return `The account plan has stopped trading for today: ${st.text}.${paperLine}`;
    if (st.state === 'probation') return `I'm trading your FTMO account at half risk while I prove myself, because you switched off "Proven desks only". I'm flat there right now.${paperLine}`;
    if (!this.armed) return `I'm cleared for your FTMO account, waiting for you to arm live trading.${paperLine}`;
    return `I'm cleared to trade your FTMO account and flat there right now.${paperLine}`;
  }

  // Floor trades on this account for the dashboard: blotter rows and simple stats.
  #tradesView(links) {
    const mine = links.filter((l) => l.login === this.login && !l.previousSession && ['open', 'closing', 'closed'].includes(l.state));
    const isToday = (l) => (l.closedDay ? l.closedDay === this.bridge.serverDay : l.closedAt >= Date.now() - 86_400_000);
    const closed = mine.filter((l) => l.state === 'closed');
    const today = closed.filter(isToday);
    const floating = this.bridge.positions.filter((x) => this.#ours(x)).reduce((sum, x) => sum + (x.profit || 0), 0);
    return {
      stats: {
        closedToday: today.length,
        winsToday: today.filter((l) => l.pnl > 0).length,
        realizedToday: today.reduce((sum, l) => sum + (l.pnl || 0), 0),
        closedTotal: closed.length,
        winsTotal: closed.filter((l) => l.pnl > 0).length,
        realizedTotal: closed.reduce((sum, l) => sum + (l.pnl || 0), 0),
        floating,
      },
      trades: mine
        .sort((a, b) => (b.closedAt || b.createdAt) - (a.closedAt || a.createdAt))
        .slice(0, 40)
        .map((l) => ({
          agentId: l.agentId, symbol: l.brokerSymbol, side: l.side, volume: l.volume0, state: l.state,
          pnl: l.state === 'closed' ? l.pnl : l.profit ?? 0, entry: l.liveEntry, openedAt: l.createdAt, closedAt: l.closedAt || null, reason: l.reason || '',
          thesis: l.thesis || null, grade: l.grade || null, chart: l.chart || null,
        })),
    };
  }

  // Is the EA in MT5 the version this floor ships? (Updated this session → say so once.)
  #eaView() {
    const version = this.bridge.version;
    const connected = !!this.account && this.bridge.connected;
    const outdated = connected && (eaOutdated(version) || !this.bridge.caps);
    if (outdated) this.eaWasOutdated = version || '?';
    else if (connected && this.eaWasOutdated && !this.eaUpdatedAt) {
      this.eaUpdatedAt = Date.now();
      this.#note(`MeridianBridge EA updated to ${version}: MT5 syncs only as often as the floor needs and enforces the safety caps itself`, 'risk');
    }
    return {
      version, latest: LATEST_EA, outdated, caps: this.bridge.caps,
      updated: !outdated && !!this.eaUpdatedAt && Date.now() - this.eaUpdatedAt < 5 * 60_000 ? { from: this.eaWasOutdated, at: this.eaUpdatedAt } : null,
    };
  }

  view() {
    const acc = this.account;
    const p = this.profile;
    const brokerSymbols = this.bridge.symbols;
    const links = [...this.links.values()];
    const warnings = [];
    if (this.mode !== 'live') warnings.push('You are in demo mode (simulated prices). Live FTMO trading needs npm start.');
    const isFtmo = !!acc && /ftmo/i.test(`${acc.server} ${acc.company}`);
    if (acc && !isFtmo) warnings.push(`MT5 is logged into ${acc.server} (${acc.company || 'another broker'}), which doesn't look like an FTMO account. In MT5 use File → Login to Trade Account with the login, password and server from your FTMO Client Area.`);
    if (acc && acc.connected === false) warnings.push('MT5 is not connected to its trade server (bottom-right of MT5 shows "No connection" or 0 / 0 Kb). Log in again via File → Login to Trade Account and check the password and server.');
    else if (acc && !acc.tradeAllowed) warnings.push('This account does not allow trading right now: logged in with the investor (read-only) password, or the account is disabled or expired.');
    if (acc && acc.connected !== false && !acc.expertAllowed) warnings.push('The broker has disabled Expert Advisor trading on this account.');
    if (acc && !acc.algoAllowed) warnings.push('Algo Trading is off in MT5 — turn on the "Algo Trading" toolbar button, and tick "Allow Algo Trading" in the EA settings (click the chart, press F7).');
    if (acc && acc.marginMode === 0) warnings.push('This is a netting account: desks trading the same symbol will net against each other.');
    // MT5 is knocking but being turned away (wrong token, …): say exactly why.
    const issue = this.bridgeIssue && Date.now() - this.bridgeIssue.at < 2 * 60_000 ? this.bridgeIssue : null;
    if (issue) warnings.unshift(issue.text);
    // MT5 hands over no more history than "Max bars in chart" allows.
    if (acc && this.bridge.maxBars && this.bridge.maxBars < MAX_BROKER_BARS) {
      warnings.push(`MT5 keeps only ${this.bridge.maxBars.toLocaleString('en-US')} bars per chart, so the research lab and the nightly review get days of your broker's prices instead of months. In MT5: Tools → Options → Charts → Max bars in chart → 100000, then restart MT5.`);
    }
    const caps = this.bridge.caps;
    if (caps && p) {
      if (caps.maxRiskPct > 0 && p.riskPerTradePct > caps.maxRiskPct) warnings.push(`The EA refuses orders risking more than ${caps.maxRiskPct}% but the account is set to ${p.riskPerTradePct}% per trade. Lower the risk in Edit setup, or raise "Max risk per order" in the EA's inputs.`);
      if (caps.maxPositions > 0 && p.maxPositions > caps.maxPositions) warnings.push(`The EA allows at most ${caps.maxPositions} floor positions, fewer than the ${p.maxPositions} set here, so extra trades will be refused by MT5.`);
    }
    const waiting = SYMBOL_IDS.filter((id) => this.md.get(id)?.status === 'WAITING');
    if (this.mode === 'live' && waiting.length) {
      const unmapped = waiting.filter((id) => !p?.symbolMap?.[id]);
      const how = !p
        ? ' Set up the account below and MT5 prices every market your broker lists.'
        : unmapped.length
          ? ` ${unmapped.join(', ')} ${unmapped.length === 1 ? 'isn\'t' : 'aren\'t'} mapped to a symbol on your broker: pick one in Edit setup and MT5 prices it at once.`
          : ' MT5 is sending your broker\'s prices for them now.';
      warnings.push(`No real prices for ${waiting.join(', ')} right now: the live feed isn't answering. Nothing is simulated, so desks on ${waiting.length === 1 ? 'that market' : 'those markets'} stand aside until real prices arrive.${how}`);
    }
    const plan = this.brain.state();
    const orphans = this.bridge.positions.filter((x) => this.#ours(x) && !links.some((l) => l.ticket === x.ticket && !l.previousSession && ['open', 'closing'].includes(l.state)));
    if (orphans.length) warnings.push(`${orphans.length} floor position(s) on MT5 are from a previous session. They keep their stop-loss; close them below if you like.`);
    return {
      mode: this.mode,
      connected: this.bridge.connected,
      lastSync: this.bridge.lastSync || null,
      eaVersion: this.bridge.version,
      eaCaps: this.bridge.caps,
      ea: this.#eaView(),
      bridgeIssue: issue ? { kind: issue.kind, text: issue.text, at: issue.at, count: issue.count } : null,
      token: this.token,
      account: acc,
      isFtmo,
      serverDay: this.bridge.serverDay,
      profile: p,
      armed: this.armed,
      armedAt: this.armedAt,
      rememberedArmed: !!this.state.armed?.[this.login],
      halt: this.halt,
      metrics: this.metrics(),
      openRisk: this.openRisk(),
      plan,
      review: this.review?.view?.() ?? null,
      baseline: this.baseline?.view?.() ?? null,
      types: ACCOUNT_TYPES,
      programs: PROGRAMS,
      defaults: DEFAULTS,
      brokerSymbolCount: brokerSymbols.length,
      suggestedMap: autoMap(brokerSymbols),
      candidates: Object.fromEntries(SYMBOL_IDS.map((id) => [id, candidatesFor(id, brokerSymbols).slice(0, 12)])),
      desks: this.fund.agents.map((a) => {
        const b = this.deskBook(a.id);
        const skip = links.filter((l) => l.agentId === a.id && !l.previousSession && (l.state === 'skipped' || l.state === 'failed')).at(-1);
        return {
          id: a.id, name: a.profile.name, desk: a.profile.desk, symbols: a.symbols,
          eligible: this.eligible(a.id), reason: INELIGIBLE[a.id] || null,
          enabled: !!p?.desks?.[a.id],
          brokerSymbol: p?.symbolMap?.[a.symbol] ?? null,
          live: b.open,
          pnlToday: b.day,
          pnlTotal: b.total,
          tradesToday: b.trades,
          status: p ? this.brain.deskStatus(a, plan) : null,
          lastSkip: skip ? { reason: skip.reason, symbol: skip.floorSymbol, at: skip.createdAt, state: skip.state } : null,
        };
      }),
      today: this.#todayView(links),
      equityHistory: this.equityHistory.slice(-240),
      ...this.#tradesView(links),
      positions: this.bridge.positions.map((x) => ({ ...x, agentId: this.#ours(x) ? this.agentForMagic(x.magic) : null, floor: this.#ours(x), chart: links.find((l) => l.ticket === x.ticket && !l.previousSession)?.chart || null })),
      links: links.filter((l) => !l.previousSession).slice(-25).reverse(),
      events: this.events.slice(-40).reverse(),
      warnings,
    };
  }
}

// Why a desk took a trade, in a few short lines: its setup, the evidence, its checklist, what
// the committee said and the floor's memory of trades like it.
export function entryReasons(plan, committee, nameOf = (id) => id) {
  if (!plan) return [];
  const out = [];
  if (plan.reason) out.push(`Why: ${plan.reason}`);
  const evidence = plan.thesis?.split(/\. Why: /)[1]?.replace(/\.$/, '');
  if (evidence) out.push(`The case: ${evidence}`);
  if (plan.checklist?.length) out.push(`Checklist: ${plan.checklist.map((c) => `✓ ${c}`).join(' ')}`);
  const d = plan.debate ? committee?.debates?.find((x) => x.id === plan.debate) : null;
  if (d) {
    const said = { agree: 'agrees', disagree: 'disagrees', cautious: 'is cautious' };
    const reviews = d.messages.filter((m) => m.role === 'reviews').map((m) => `${nameOf(m.from)} ${said[m.stance] || m.stance}`);
    const chair = d.messages.find((m) => m.role === 'decides');
    const chairSays = chair?.text?.split(/(?<=\.)\s/)[0];
    if (reviews.length || chairSays) out.push(`Committee: ${[...reviews, chairSays ? `${nameOf(chair.from)}: ${chairSays.replace(/\.$/, '')}` : null].filter(Boolean).join(' · ')}`);
    if (d.factors?.memory?.text) out.push(`Memory: ${d.factors.memory.text.replace(/^the floor's memory: /, '')}`);
  }
  return out;
}

// The market brain's nearest support and resistance, for the entry chart.
export function brainLevels(read) {
  if (!read) return [];
  return [...(read.resistance || []).slice(0, 2), ...(read.support || []).slice(0, 2)].filter((l) => Number.isFinite(l?.price)).map((l) => ({ label: l.label, price: l.price }));
}

// "Today on FTMO": every closed trade with its P&L, like MT5's history, and the total.
export function tradesListText(list, { accountToday = null, title = 'Today on FTMO', max = 15 } = {}) {
  if (!list.length) return `${title}: no closed trades yet.`;
  const total = Math.round(list.reduce((s, t) => s + t.pnl, 0) * 100) / 100;
  const wins = list.filter((t) => t.pnl > 0).length;
  const shown = list.slice(-max);
  const lines = [`${title} · ${list.length} closed trade${list.length === 1 ? '' : 's'}, ${wins} won:`];
  if (list.length > shown.length) lines.push(`… ${list.length - shown.length} earlier`);
  for (const t of shown) lines.push(`${t.pnl >= 0 ? '🟢' : '🔴'} ${t.name} ${t.symbol} ${fmtUsd(t.pnl, { sign: true, cents: true })}${t.r != null ? ` (${t.r >= 0 ? '+' : '−'}${Math.abs(t.r).toFixed(1)}R)` : ''}`);
  lines.push(`Closed trades: ${fmtUsd(total, { sign: true, cents: true })}${accountToday != null ? ` · account today ${fmtUsd(accountToday, { sign: true, cents: true })} (with open trades)` : ''}`);
  return lines.join('\n');
}

// The end-of-day message on the boss's phone.
export function dailyAlertText(s) {
  const pnl = fmtUsd(s.dayPnl ?? 0, { sign: true });
  const lines = [`📊 Daily report ${s.day}: ${pnl} on the account`];
  if (s.trades) lines.push(`${s.trades} trade${s.trades === 1 ? '' : 's'}, ${s.wins} win${s.wins === 1 ? '' : 's'}${s.avgR != null ? `, average ${s.avgR >= 0 ? '+' : '−'}${Math.abs(s.avgR).toFixed(2)}R` : ''}.`);
  else lines.push('No trades reached the account.');
  if (s.best) lines.push(`Best: ${s.best.name.split(' ')[0]} ${fmtUsd(s.best.pnl, { sign: true })}.${s.worst ? ` Worst: ${s.worst.name.split(' ')[0]} ${fmtUsd(s.worst.pnl, { sign: true })}.` : ''}`);
  if (s.skipped) lines.push(`Held back on paper: ${s.skipped} (${s.topReasons.map(([k, n]) => `${k.toLowerCase()} ${n}`).join(', ')}).`);
  if (s.halted) lines.push('The risk guard stopped trading during the day.');
  if (s.list?.length) lines.push('', tradesListText(s.list, { title: 'Trades', max: 25 }));
  lines.push('Full report on the floor\'s Dashboard.');
  return lines.join('\n');
}
